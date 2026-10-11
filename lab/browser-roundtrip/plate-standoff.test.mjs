import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  ASSEMBLY_LENS_FRACTION, PLATE_NEAR_FALLBACK_METRES, PLATE_STANDOFF_METRES,
  SUBJECT_LENS_CEILING, SUBJECT_LENS_FLOOR,
  ghostButtonAvoidance, lensBounds, lensFraction, lensTangent, occludedPlateShare, pointRange,
  standoffFraming,
} from './plate-standoff.mjs';
import { EYE_TAN_HALF_HORIZONTAL, TOOLBAR_READING_RANGE_METERS, createToolbarPanel, toolbarLayoutForDepthRange,
  toolbarLayoutForStandoff, toolbarPlatePoints } from './spatial-toolbar-geometry.mjs';
import { panelDepthBand } from './xr-depth-band.mjs'; // the near plane the panel is told about.

const FILL = Math.tan(60 * Math.PI / 360); // the framing a lesson chapter asks for
const CONTEXT = Math.tan(30 * Math.PI / 360);

test('a lens share and a half-angle tangent are the same number twice', () => {
  assert.equal(lensFraction(EYE_TAN_HALF_HORIZONTAL), 1);
  assert.ok(Math.abs(lensTangent(lensFraction(FILL)) - FILL) < 1e-12);
  assert.equal(lensFraction(0), 0);
  assert.equal(lensFraction(Number.NaN), 0);
});

test('a subject that is the whole structure is held to the ghost-included cap', () => {
  const fit = standoffFraming({ tanHalfSubject: FILL, reachRatio: 1, plateNearMetres: 0.95 });
  assert.equal(fit.limited, 'assembly');
  assert.ok(Math.abs(fit.subjectFraction - ASSEMBLY_LENS_FRACTION) < 1e-9);
  assert.ok(fit.subjectFraction > SUBJECT_LENS_FLOOR);
});

test('the whole assembly, not the lit part, is what is fitted to the lens', () => {
  // Chapter 2 of the wall tier as measured on the lens: a lit protofilament
  // across 55.7 per cent of it with a ghost across 82.
  const reachRatio = 0.82 / 0.557;
  const fit = standoffFraming({ tanHalfSubject: FILL, reachRatio, plateNearMetres: 0.95 });
  assert.equal(fit.limited, 'assembly');
  assert.ok(fit.assemblyFraction <= ASSEMBLY_LENS_FRACTION + 1e-9,
    `the ghost still spans ${fit.assemblyFraction} of the lens`);
  // And the subject it leaves is still the subject: inside the product's band.
  assert.ok(fit.subjectFraction >= SUBJECT_LENS_FLOOR && fit.subjectFraction <= SUBJECT_LENS_CEILING,
    `the lit part landed at ${fit.subjectFraction} of the lens`);
});

test('the subject is never shrunk under the floor to make the ghost fit', () => {
  const fit = standoffFraming({ tanHalfSubject: FILL, reachRatio: 2.2, plateNearMetres: 0.95 });
  assert.equal(fit.limited, 'subject-floor');
  assert.ok(Math.abs(fit.subjectFraction - SUBJECT_LENS_FLOOR) < 1e-9);
  assert.ok(fit.assemblyFraction > ASSEMBLY_LENS_FRACTION, 'the ghost is the thing that gave way');
});

test('the stand-off distance puts the whole assembly behind the plates', () => {
  const plateNear = 0.95;
  const fit = standoffFraming({ tanHalfSubject: FILL, reachRatio: 1.5, plateNearMetres: plateNear });
  const nearest = fit.minDistanceMetres * (1 - fit.tanHalfAssembly);
  assert.ok(Math.abs(nearest - (plateNear + PLATE_STANDOFF_METRES)) < 1e-9,
    `the structure would come to ${nearest} m of the eye`);
  assert.ok(fit.minDistanceMetres > plateNear, 'the structure has to be pushed past the glass');
});

test('a nearer plate is what the rule measures against, and a hidden one falls back', () => {
  const near = standoffFraming({ tanHalfSubject: CONTEXT, reachRatio: 1.2, plateNearMetres: 0.6 });
  const far = standoffFraming({ tanHalfSubject: CONTEXT, reachRatio: 1.2, plateNearMetres: 1.1 });
  assert.ok(near.minDistanceMetres < far.minDistanceMetres);
  const hidden = standoffFraming({ tanHalfSubject: CONTEXT, reachRatio: 1.2 });
  assert.equal(hidden.plateNearMetres, PLATE_NEAR_FALLBACK_METRES);
  assert.equal(hidden.floorMetres, PLATE_NEAR_FALLBACK_METRES + PLATE_STANDOFF_METRES);
});

test('a 3.4 m plate reading is outside the room band and uses the fallback seat', () => {
  // Insurance against a scene-unit leak read as metres. A 3.4 m reading is
  // also what an ungated near plane produces for a menu it has already exiled;
  // either way the solver must not chase it.
  const fit = standoffFraming({ tanHalfSubject: FILL, reachRatio: 1, plateNearMetres: 3.4 });
  assert.equal(fit.plateNearMetres, PLATE_NEAR_FALLBACK_METRES);
  assert.equal(fit.floorMetres, PLATE_NEAR_FALLBACK_METRES + PLATE_STANDOFF_METRES);
});

test('a framing the wearer stands inside asks for no distance at all', () => {
  // A tiny part inside a huge complex: no distance puts the eye outside it, so
  // the rule says so rather than flinging the structure to the far wall.
  const fit = standoffFraming({ tanHalfSubject: FILL, reachRatio: 12, plateNearMetres: 0.95 });
  assert.equal(fit.limited, 'inside-out');
  assert.equal(fit.minDistanceMetres, 0);
});

test('a pierce is counted where the structure is between the eye and the glass', () => {
  const eye = [0, 0, 0];
  const points = [[0, 0, -1], [0.5, 0, -1], [-0.5, 0, -1]];
  const through = occludedPlateShare({ points, origin: eye, sphere: { centre: [0, 0, -0.5], radius: 0.15 } });
  assert.equal(through.occluded, 1);
  assert.ok(Math.abs(through.share - 1 / 3) < 1e-9);
  const behind = occludedPlateShare({ points, origin: eye, sphere: { centre: [0, 0, -3], radius: 0.5 } });
  assert.equal(behind.occluded, 0, 'a structure behind the plates pierces nothing');
  const touching = occludedPlateShare({ points, origin: eye, sphere: { centre: [0, 0, -1.2], radius: 0.25 } });
  assert.equal(touching.occluded, 0, 'a sphere that only reaches the plate plane is not in front of it');
  const engulfed = occludedPlateShare({ points, origin: eye, sphere: { centre: [0, 0, -0.5], radius: 0.6 } });
  assert.equal(engulfed.occluded, 3, 'a structure the wearer is inside covers the whole panel');
  assert.equal(occludedPlateShare({ points: [], origin: eye, sphere: { centre: [0, 0, -0.5], radius: 1 } }).occluded, 0);
  assert.equal(occludedPlateShare({}).share, 0);
});

test('the range of a point set is measured from the eye, and an empty panel has none', () => {
  assert.equal(pointRange([], [0, 0, 0]), undefined);
  assert.equal(pointRange([[0, 0, -1]], undefined), undefined);
  const range = pointRange([[0, 0, -1], [0, 0, -2], [3, 4, 0]], [0, 0, 0]);
  assert.equal(range.near, 1);
  assert.equal(range.far, 5);
});

test('the shipped menu seats its nearest glass at the 1.35 metre reading range', () => {
  // The measurement the constants are picked from, taken from the real panel
  // rather than from its layout numbers: the seat solver may swing the panel
  // inboard and the caption block rides above the anchor.
  const head = { transform: { matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1.6, 0, 1],
    position: { x: 0, y: 1.6, z: 0 } } };
  const panel = createToolbarPanel({ head,
    rows: [{ label: 'Talk' }, { label: 'Play' }, { label: 'Next' }, { label: 'Back' }, { label: 'Menu' }],
    readout: [{ text: 'Three wide' }, { text: 'Scene 1 / 5' }, { text: 'Six copies of the same dimer' }] });
  const points = toolbarPlatePoints(panel);
  assert.ok(points.length > 40, `the panel offered ${points.length} points to measure`);
  const range = pointRange(points, [0, 1.6, 0]);
  assert.ok(Math.abs(range.near - TOOLBAR_READING_RANGE_METERS) < .02,
    `the nearest plate sits at ${range.near.toFixed(3)} m`);
  assert.ok(range.far <= 1.35 * TOOLBAR_READING_RANGE_METERS / .95,
    `the furthest plate sits at ${range.far.toFixed(3)} m`);
  // And the rule built from that range clears every one of those points.
  const fit = standoffFraming({ tanHalfSubject: FILL, reachRatio: 1.4, plateNearMetres: range.near });
  const nearest = fit.minDistanceMetres * (1 - fit.tanHalfAssembly);
  const sphere = { centre: [0, 1.6, -fit.minDistanceMetres],
    radius: fit.minDistanceMetres * fit.tanHalfAssembly };
  assert.ok(nearest >= range.near + PLATE_STANDOFF_METRES - 1e-9);
  assert.equal(occludedPlateShare({ points, origin: [0, 1.6, 0], sphere }).occluded, 0,
    'a structure at the stand-off distance still covered part of the panel');
});

/**
 * The whole chain, replayed on a recorded Quest 2 wall-chapter framing.
 *
 * The plate depths were never in the wrong frame or the wrong units. They were
 * metres from the eye, and they really said 3.4 m, because the menu had been
 * moved there. `render-budget` logged `cameraScale` 0.00713 and
 * `depthNearMeters` 1.677 for the same chapter: Mol*'s own automatic near
 * plane, over a scene bounding sphere seven thousand units across, with no
 * cutaway asked for by anyone. The old adapter reported that plane to the
 * panel, `toolbarLayoutForDepthRange` relocated the seat past it and scaled
 * every length by 2.67 to hold the angular size, and the structure stand-off
 * pushed the same seat out again by its 1.5x cap.
 *
 * These two tests are the before and the after of `panelDepthBand`: the same
 * framing, solved against the plates each near plane produces.
 */
const WALL_NEAR_METRES = 1.677;
/** The wall chapter's own framing, read off the record's `before` face. */
const WALL_SUBJECT = 0.641 * EYE_TAN_HALF_HORIZONTAL, WALL_REACH_RATIO = 1.174 / 0.641;
const WALL_EYE = [0, 1.6, 0];
const WALL_HEAD = { transform: { matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1.6, 0, 1],
  position: { x: 0, y: 1.6, z: 0 } } };

/** The wall tour's menu, seated on the layout a given near plane produces. */
function wallPlates(panelNearMetres, { fleeing = true } = {}) {
  // What `spatial-toolbar.mjs` `layout()` does, in the order it does it: the
  // reported near plane first, then the structure stand-off on top. `fleeing`
  // is the wall case, where the previous chapter left the wearer INSIDE the
  // assembly (the record's `before.nearest` is -0.069 m) so every seat bearing
  // intersects it and the stand-off runs to its cap.
  const clamped = toolbarLayoutForDepthRange(panelNearMetres, Infinity);
  const constants = fleeing ? toolbarLayoutForStandoff(Number.MAX_SAFE_INTEGER, clamped) : clamped;
  const panel = createToolbarPanel({ head: WALL_HEAD, constants,
    rows: [{ label: 'Talk' }, { label: 'Play' }, { label: 'Next' }, { label: 'Back' }, { label: 'Menu' },
      { label: 'Open in Mol*' }],
    readout: [{ text: 'Same cargo' }, { text: 'Scene 3 / 5' }, { text: 'Six copies of the same dimer' }] });
  return toolbarPlatePoints(panel);
}

/** The framing the record carries, solved against one plate range. */
function wallFraming(points) {
  const range = pointRange(points, WALL_EYE);
  const fit = standoffFraming({ tanHalfSubject: WALL_SUBJECT, reachRatio: WALL_REACH_RATIO,
    plateNearMetres: range.near });
  const distance = fit.minDistanceMetres, radius = distance * fit.tanHalfAssembly;
  const sphere = { centre: [WALL_EYE[0], WALL_EYE[1], WALL_EYE[2] - distance], radius };
  return { range, fit, distance, radius, nearest: distance - radius,
    pierced: occludedPlateShare({ points, origin: WALL_EYE, sphere }) };
}

test('the wall pass: an automatic near plane exiled the menu to 3.4 m', () => {
  // The layout defect, kept so it cannot come back unnoticed. This is the OLD
  // behaviour: the near plane reported to the panel whether or not the wearer
  // asked for a cutaway, and the menu moved to 3.4 m. The solver no longer
  // chases that reading: 3.4 m is outside the room band.
  const wall = wallFraming(wallPlates(WALL_NEAR_METRES));
  assert.ok(wall.range.near > 3.3 && wall.range.near < 4,
    `the menu was pushed to ${wall.range.near.toFixed(3)} m; the record logged plateNear 3.401`);
  assert.equal(wall.fit.plateNearMetres, PLATE_NEAR_FALLBACK_METRES);
});

test('the wall pass, with the near plane gated on a cutaway: the plates read and clear', () => {
  // `panelDepthBand` reports 0 when nothing was clipped on purpose, so the
  // menu keeps its own seat and the stand-off is the only thing that may move
  // it. The same framing, solved against those plates.
  const panelNear = panelDepthBand({ clipped: false, depthNear: WALL_NEAR_METRES, depthFar: 52.35 }).near;
  assert.equal(panelNear, 0);
  const fixed = wallFraming(wallPlates(panelNear));
  assert.ok(Math.abs(fixed.range.near - TOOLBAR_READING_RANGE_METERS * 1.5) < .02,
    `the menu stayed at ${fixed.range.near.toFixed(3)} m rather than 3.4 m`);
  assert.equal(fixed.pierced.occluded, 0,
    `the wall drew over ${fixed.pierced.occluded} of ${fixed.pierced.points} plate points`);
  // And the subject is no worse off for it: the rule still holds the floor.
  assert.ok(fixed.fit.subjectFraction >= SUBJECT_LENS_FLOOR - 1e-9,
    `the subject spans ${(fixed.fit.subjectFraction * 100).toFixed(0)} per cent of the lens`);
  // A menu that is NOT running from the structure sits at its shipped seat,
  // and the same framing then asks for a shorter push.
  const seated = wallFraming(wallPlates(panelNear, { fleeing: false }));
  assert.ok(Math.abs(seated.range.near - TOOLBAR_READING_RANGE_METERS) < .02,
    `the shipped seat is ${seated.range.near.toFixed(3)} m`);
  assert.equal(seated.pierced.occluded, 0);
  assert.ok(seated.fit.wantedDistanceMetres < fixed.fit.wantedDistanceMetres,
    'a menu that stays put costs the structure less of its reach');
});

test('a lens rectangle can be read off points that are already on the lens', () => {
  // `lensRectFromPoints` projects a fixed room object from the
  // eye; a placed, rotated structure is projected by `projectPlacedToLens`
  // instead, and this is the same rectangle for what that returns.
  const bounds = lensBounds([{ x: -0.4, y: 0.1 }, { x: 0.2, y: -0.3 }, { x: 0, y: 0.5 }]);
  assert.ok(Math.abs(bounds.left + 0.4) < 1e-12 && Math.abs(bounds.right - 0.2) < 1e-12);
  assert.ok(Math.abs(bounds.bottom + 0.3) < 1e-12 && Math.abs(bounds.top - 0.5) < 1e-12);
  assert.ok(Math.abs(bounds.halfWidth - 0.3) < 1e-12 && Math.abs(bounds.halfHeight - 0.4) < 1e-12);
  assert.ok(Math.abs(bounds.x + 0.1) < 1e-12 && Math.abs(bounds.y - 0.1) < 1e-12);
  // Nothing drawable is not a rectangle, and a stray point is dropped.
  assert.equal(lensBounds([]), undefined);
  assert.equal(lensBounds(undefined), undefined);
  assert.equal(lensBounds([{ x: Number.NaN, y: 0 }]), undefined);
});

test('the button pass sees the rectangles and the lit part, not eight corners alone', () => {
  // The wall chapters reported `cleared: true` while a
  // Menu button sat under the ghost's own rectangle — every assembly corner
  // missed the row and the face between them did not.
  const row = { left: -0.6, right: -0.2, bottom: -0.1, top: 0.1,
    x: -0.4, y: 0, halfWidth: 0.2, halfHeight: 0.1 };
  const straddling = ghostButtonAvoidance({ ghost: { x: 0, y: 0, halfWidth: 0.7, halfHeight: 0.5 },
    // Corners only, every one of them outside the row.
    ghostPoints: [{ x: -0.7, y: -0.5 }, { x: 0.7, y: -0.5 }, { x: -0.7, y: 0.5 }, { x: 0.7, y: 0.5 }],
    buttons: [row] });
  assert.equal(straddling.cleared, true, 'no corner lies over the button');
  assert.equal(straddling.covered, true, 'and the rectangle covers it anyway');
  // A lit selection interior to those corners is checked too: it is not in
  // `ghostPoints`, and it is not faded. Handing it in is what makes the pass
  // move at all — the same seat without it is left standing.
  const seat = { ghost: { x: 0, y: 0.4, halfWidth: 0.2, halfHeight: 0.1 },
    ghostPoints: [{ x: -0.2, y: 0.3 }, { x: 0.2, y: 0.5 }], buttons: [row] };
  assert.equal(ghostButtonAvoidance(seat).move, 'none');
  const lit = ghostButtonAvoidance({ ...seat, litPoints: [{ x: -0.4, y: 0 }] });
  assert.notEqual(lit.move, 'none', 'a lit point over a button is a point over a button');
  assert.equal(lit.cleared, true, 'and the pass moves until nothing is over one');
  // And a seat with nothing near the buttons is still left exactly alone.
  const clear = ghostButtonAvoidance({ ghost: { x: 0.5, y: 0.6, halfWidth: 0.1, halfHeight: 0.1 },
    ghostPoints: [{ x: 0.5, y: 0.6 }], buttons: [row] });
  assert.equal(clear.move, 'none');
  assert.equal(clear.cleared, true);
  assert.equal(clear.covered, false);
});
