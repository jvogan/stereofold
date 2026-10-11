import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  ASSEMBLY_LENS_FRACTION, PLATE_CLEARANCE_LENS, SUBJECT_LENS_CEILING, SUBJECT_LENS_FLOOR,
  SUBJECT_RISE_CEILING, SUBJECT_WHOLE_LENS_CEILING, lensRectFromPoints, lensRectsOverlap, lensFraction,
  lensRect, plateAvoidance, projectedExtent, standoffFraming, viewBasis,
} from './plate-standoff.mjs';
import { EYE_TAN_HALF_HORIZONTAL, EYE_TAN_HALF_VERTICAL } from './spatial-toolbar-geometry.mjs';

/**
 * The Quest 2 framing defect, in synthetic geometry.
 *
 * The solver recorded the dimer's lit subject at `subjectLens: 0.4` while the
 * wearer's own view measured 32 per cent of the lens; the protofilament
 * recorded the same 0.4 and measured 18.9. Both are the same arithmetic: a
 * bounding sphere around a subject whose
 * long axis runs INTO the screen has the radius of its length, so the solver
 * sized a ball where the wearer saw a blob. Nothing below needs Mol*.
 */
const FILL = Math.tan(60 * Math.PI / 360);
const AHEAD = viewBasis([0, 0, -1]);

/** The eight corners of a box with these half extents, centred on the origin. */
const boxPoints = ([x, y, z]) => [-1, 1].flatMap(sx => [-1, 1].flatMap(sy =>
  [-1, 1].map(sz => [sx * x, sy * y, sz * z])));

test('an eye basis is right-handed and level with the room', () => {
  const axis = v => v.map(value => value + 0).map(value => (Object.is(value, -0) ? 0 : value));
  assert.deepEqual(axis(AHEAD.right), [1, 0, 0]);
  assert.deepEqual(axis(AHEAD.up), [0, 1, 0]);
  assert.deepEqual(axis(AHEAD.forward), [0, 0, -1]);
  // A head tipped straight down still has axes, rather than none at all.
  assert.ok(viewBasis([0, -1, 0]));
  assert.equal(viewBasis([0, 0, 0]), undefined);
});

test('a subject pointing into the screen is measured at its width, not its length', () => {
  // The dimer: 200 units of length running away from the wearer,
  // 50 across. Its bounding sphere has a radius of 103.
  const extent = projectedExtent({ points: boxPoints([25, 25, 100]), centre: [0, 0, 0], basis: AHEAD });
  assert.equal(extent.halfWidth, 25);
  assert.equal(extent.halfHeight, 25);
  assert.equal(extent.halfDepth, 100);
  const sphereRadius = Math.hypot(25, 25, 100);
  assert.ok(sphereRadius / extent.halfWidth > 4,
    'the sphere the old rule used is four times the width the wearer sees');
  // Turn the same rod across the lens and the two swap, which is the whole
  // point: the extent is of the view, not of the molecule.
  const across = projectedExtent({ points: boxPoints([100, 25, 25]), centre: [0, 0, 0], basis: AHEAD });
  assert.equal(across.halfWidth, 100);
  assert.equal(across.halfDepth, 25);
  assert.equal(projectedExtent({ points: [], centre: [0, 0, 0], basis: AHEAD }), undefined);
});

test('a dimer-like subject lands in the 40 to 60 per cent band, where hardware put it at 32', () => {
  // Subject 25 wide, the tier around it 50 wide and 150 deep: the ghost is
  // twice the subject across and six times its width in depth.
  const fit = standoffFraming({ tanHalfSubject: FILL, reachRatio: 150 / 25,
    riseRatio: 1, assemblyWidthRatio: 2, assemblyRiseRatio: 1.6,
    subjectCeiling: SUBJECT_LENS_CEILING, plateNearMetres: 0.95 });
  assert.ok(fit.subjectFraction >= SUBJECT_LENS_FLOOR - 1e-9
    && fit.subjectFraction <= SUBJECT_LENS_CEILING + 1e-9,
  `the lit subject spans ${(fit.subjectFraction * 100).toFixed(1)} per cent of the lens`);
  assert.ok(fit.subjectFraction > 0.32, 'bigger than the hardware capture measured');
  // A tier this deep has no distance at which the wearer is outside it, and the
  // rule says so rather than flinging it at the far wall — but it no longer
  // hands the framing back past the lens to do it.
  assert.equal(fit.limited, 'inside-out');
  assert.ok(fit.subjectFraction <= SUBJECT_LENS_CEILING + 1e-9);
});

test('a shallower ghost is fitted, floored, and pushed behind the plates', () => {
  const fit = standoffFraming({ tanHalfSubject: FILL, reachRatio: 1.8,
    riseRatio: 1, assemblyWidthRatio: 2, assemblyRiseRatio: 1.6,
    subjectCeiling: SUBJECT_LENS_CEILING, plateNearMetres: 0.95 });
  assert.equal(fit.limited, 'subject-floor');
  assert.ok(Math.abs(fit.subjectFraction - SUBJECT_LENS_FLOOR) < 1e-9);
  const nearest = fit.minDistanceMetres * (1 - fit.tanHalfAssembly);
  assert.ok(Math.abs(nearest - fit.floorMetres) < 1e-6, `the ghost comes to ${nearest} m of the eye`);
  assert.equal(fit.reachLimited, false);
  assert.ok(Math.abs(fit.grantedStandoffMetres - 0.25) < 1e-6,
    'the plates keep the whole quarter metre when the reach cap does not bite');
});

test('a wall-like whole-structure chapter takes up to the ghost-included cap', () => {
  // The subject IS the assembly: one ratio each, and the ghost-included
  // ceiling. A whole-structure chapter asks for LESSON_MAX_ENCLOSURE, .85 of
  // the distance, and the projected whole width is what is capped.
  const fit = standoffFraming({ tanHalfSubject: 0.85, reachRatio: 1.2,
    riseRatio: 0.8, assemblyWidthRatio: 1, assemblyRiseRatio: 0.8,
    subjectCeiling: SUBJECT_WHOLE_LENS_CEILING, plateNearMetres: 0.95 });
  assert.ok(Math.abs(fit.subjectFraction - SUBJECT_WHOLE_LENS_CEILING) < 1e-9,
    `the wall spans ${(fit.subjectFraction * 100).toFixed(1)} per cent of the lens`);
  assert.equal(fit.limited, 'lens-ceiling');
  assert.ok(fit.subjectRise < fit.subjectFraction, 'a wall is wider than it is tall');
  // And the same subject in a part chapter stops at the lit ceiling.
  const part = standoffFraming({ tanHalfSubject: 0.85, reachRatio: 1.2, riseRatio: 0.8,
    assemblyWidthRatio: 1, assemblyRiseRatio: 0.8, subjectCeiling: SUBJECT_LENS_CEILING });
  assert.ok(Math.abs(part.subjectFraction - SUBJECT_LENS_CEILING) < 1e-9);
});

test('a standing subject is sized by the lens height, and says so', () => {
  // Three times as tall as it is wide: sixty per cent of the lens WIDTH would
  // put its ends off the top and the bottom of the frame.
  const fit = standoffFraming({ tanHalfSubject: FILL, reachRatio: 1.1, riseRatio: 3,
    assemblyWidthRatio: 1, assemblyRiseRatio: 3, subjectCeiling: SUBJECT_LENS_CEILING });
  assert.equal(fit.limited, 'subject-rise');
  assert.ok(Math.abs(fit.subjectRise - SUBJECT_RISE_CEILING) < 1e-9,
    `the subject spans ${(fit.subjectRise * 100).toFixed(1)} per cent of the lens height`);
  assert.ok(fit.subjectFraction < SUBJECT_LENS_FLOOR,
    'and it is narrower than the width floor, because the floor is not worth its ends');
});

test('a sphere-measured caller is still held to the assembly cap and the floor', () => {
  // No rise or extent ratios and no subject ceiling: the ghost-included cap
  // still applies, because the projected whole width is what the wearer sees.
  const legacy = standoffFraming({ tanHalfSubject: FILL, reachRatio: 1, plateNearMetres: 0.95 });
  assert.equal(legacy.limited, 'assembly');
  assert.ok(Math.abs(legacy.subjectFraction - ASSEMBLY_LENS_FRACTION) < 1e-9);
  const capped = standoffFraming({ tanHalfSubject: FILL, reachRatio: 2.2, plateNearMetres: 0.95 });
  assert.equal(capped.limited, 'subject-floor');
  assert.ok(Math.abs(capped.subjectFraction - SUBJECT_LENS_FLOOR) < 1e-9);
});

test('the reach cap spends the plate stand-off rather than the subject', () => {
  const fit = standoffFraming({ tanHalfSubject: FILL, reachRatio: 2.6, riseRatio: 1,
    assemblyWidthRatio: 2, assemblyRiseRatio: 2, subjectCeiling: SUBJECT_LENS_CEILING,
    plateNearMetres: 1.425 });
  assert.equal(fit.reachLimited, true, 'the framing wanted more room than a stereo viewer has');
  assert.ok(fit.subjectFraction >= SUBJECT_LENS_FLOOR - 1e-9,
    'and the subject was not shrunk under the floor to buy it');
  assert.ok(fit.grantedStandoffMetres < 0.25,
    `the plates were granted ${fit.grantedStandoffMetres.toFixed(3)} m of the quarter metre`);
});

test('a plate rectangle is read off the real plate points in lens fractions', () => {
  // A caption plate up and to the left of a wearer looking down -z.
  const plate = lensRectFromPoints({ points: [[-0.5, 0.4, -1], [-0.15, 0.15, -1]],
    origin: [0, 0, 0], basis: AHEAD });
  assert.ok(Math.abs(plate.left - (-0.5 / EYE_TAN_HALF_HORIZONTAL)) < 1e-9);
  assert.ok(Math.abs(plate.top - (0.4 / EYE_TAN_HALF_VERTICAL)) < 1e-9);
  assert.ok(plate.right < 0 && plate.bottom > 0, 'the caption is in the top-left quadrant');
  // Points behind the eye are dropped rather than folded onto the front.
  assert.equal(lensRectFromPoints({ points: [[0, 0, 1]], origin: [0, 0, 0], basis: AHEAD }), undefined);
});

test('a subject in the caption corner is moved out of it, down or to the right', () => {
  const plate = { left: -0.95, right: -0.2, bottom: 0.15, top: 0.95 };
  const subject = { x: 0, y: 0.14, halfWidth: 0.35, halfHeight: 0.3 };
  assert.ok(lensRectsOverlap(lensRect(subject), plate, PLATE_CLEARANCE_LENS),
    'the case only exists because the two rectangles share the lens');
  const moved = plateAvoidance({ subject, plate, shrinkFloor: SUBJECT_LENS_FLOOR / subject.halfWidth });
  assert.equal(moved.shrink, 1, 'there was room beside the glass, so the subject kept its size');
  assert.equal(moved.overlap, false);
  assert.ok(moved.x >= subject.x && moved.y <= subject.y, 'it moved right and/or down, never up or left');
  assert.ok(lensRectsOverlap(moved.rect, plate, PLATE_CLEARANCE_LENS) === false);
  assert.ok(moved.rect.right <= 1 && moved.rect.bottom >= -1, 'and it stayed inside the lens');
});

test('a subject too big to sit beside the glass shrinks, but never under the floor', () => {
  // A plate across most of the lens and a subject at the whole-structure
  // ceiling: no seat inside the frame separates them at full size.
  const plate = { left: -1, right: 0.35, bottom: -0.3, top: 1 };
  const subject = { x: 0, y: 0, halfWidth: SUBJECT_WHOLE_LENS_CEILING, halfHeight: 0.55 };
  const moved = plateAvoidance({ subject, plate,
    shrinkFloor: SUBJECT_LENS_FLOOR / subject.halfWidth });
  assert.ok(moved.shrink < 1, 'it had to give up some size');
  assert.ok(moved.rect.halfWidth >= SUBJECT_LENS_FLOOR - 1e-9,
    `the subject was shrunk to ${moved.rect.halfWidth.toFixed(3)} of the lens`);
  assert.ok(moved.axis === 'down' || moved.axis === 'right');
  // No plate at all, or a subject that never touched one, is left alone.
  const clear = plateAvoidance({ subject, plate: undefined });
  assert.equal(clear.axis, 'none');
  assert.equal(clear.shrink, 1);
  assert.equal(clear.x, subject.x);
});

test('the record carries both rectangles, so a ring proves the overlap is gone', () => {
  const plate = { left: -0.9, right: -0.25, bottom: 0.2, top: 0.9 };
  const moved = plateAvoidance({ subject: { x: -0.1, y: 0.3, halfWidth: 0.3, halfHeight: 0.3 }, plate });
  for (const key of ['left', 'right', 'bottom', 'top', 'halfWidth', 'halfHeight', 'x', 'y'])
    assert.ok(Number.isFinite(moved.rect[key]), `the recorded subject rectangle is missing ${key}`);
  assert.equal(typeof moved.overlap, 'boolean');
  assert.equal(typeof moved.axis, 'string');
  assert.ok(Math.abs(lensFraction(EYE_TAN_HALF_HORIZONTAL) - 1) < 1e-12,
    'a half-width of one is the whole lens, which is what the rectangle is quoted in');
});
