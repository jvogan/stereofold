/**
 * The microtubule wall tier's framing, held on the DRAWN frame.
 *
 * A vision review of the Quest 2 wall captures (build 8a5a11c, the
 * same framing code as this file's base) left two residuals, and both are one
 * defect: every lens rule was granted on the PRE-ROTATION rectangle — the eye's
 * axis-aligned extent about the subject's centre, divided by one seat depth —
 * while the wearer sees the perspective projection of the rotated, placed
 * points, whose near corners divide by a shorter depth than the far ones.
 *
 *  1. The whole-wall chapters overflowed the lens ceiling. The solver planned
 *     the 0.55 `SUBJECT_WHOLE_LENS_CEILING` share exactly and the drawn
 *     projection measured 0.575 to 0.696 across the tier's twist — chapter
 *     wall-01 at 0.596, pushing about 96 px into the menu column's backing.
 *  2. The highlight chapters under-lit and collided. The lit selections drew
 *     20.8 and 26.4 per cent of the lens against a 0.40 floor the record
 *     claimed they were at (`share.lit` 0.408 in both), and the ghost around
 *     the wall-04 selection drew 0.900 — past `SUBJECT_GHOST_LENS_LIMIT`,
 *     0.75 — with a Menu button under both rectangles.
 *
 * The geometry below is the stand-in the probe measured those numbers
 * with: an axis-aligned box for the three-protofilament wall, a column of it
 * for a highlight chapter's lit selection, the shipped panel for the plates,
 * and `obliqueGrowthTurn` for the pose a landed wall tier actually takes. It
 * reproduced the capture numbers with the former placement range. The shared
 * numerical bounds now let some uncorrected seats grow past that old cap;
 * the final drawn projection must still obey the same physical limits.
 *
 * `PINNED` is how the framing this replaced is still measured: the drawn
 * round is frozen at gain 1 with its pass budget spent, so `frame.drawn.granted`
 * is what the current grant alone would draw, before perspective correction.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { DRAWN_GAIN_PASSES, focusPlacement, obliqueGrowthTurn, GROWTH_TILT_DEGREES,
  GROWTH_ROLL_DEGREES, GROWTH_WALL_AZIMUTH_DEGREES } from './focus-placement.mjs';
import { SUBJECT_GHOST_LENS_LIMIT, SUBJECT_LENS_FLOOR, SUBJECT_RISE_CEILING,
  SUBJECT_WHOLE_LENS_CEILING, lensRect, lensRectFromPoints, lensRectsOverlap,
  viewBasis } from './plate-standoff.mjs';
import { SPATIAL_TOOLBAR_LAYOUT, createToolbarPanel, toolbarCaptionPoints, toolbarMenuPoints, toolbarMenuRowPoints,
  toolbarPlatePoints } from './spatial-toolbar-geometry.mjs';

/** The drawn round, frozen: gain 1 and no pass left to solve again with. */
const PINNED = { lit: 1, ghost: 1, rise: 1, pass: DRAWN_GAIN_PASSES };

const head = { transform: { matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1.6, 0, 1],
  position: { x: 0, y: 1.6, z: 0 } } };
const headInRoom = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1.6, 0, 1];
const renderFromRoom = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const EYE = [0, 1.6, 0];
const BASIS = viewBasis([0, 0, -1]);

// Retain the historical forward-seat overlap that these drawn-gain regressions exercise.
const panel = createToolbarPanel({ head, constants: { ...SPATIAL_TOOLBAR_LAYOUT, peripheralSeat: false },
  rows: [{ label: 'Talk' }, { label: 'Play' }, { label: 'Next' }, { label: 'Back' }, { label: 'Menu' },
    { label: 'Open in Mol*' }],
  readout: [{ text: 'Three wide' }, { text: 'Scene 1 / 5' }, { text: 'Six copies of the same dimer.' }],
  status: 'Listening…' });
const PLATES = toolbarPlatePoints(panel), CAPTIONS = toolbarCaptionPoints(panel);
const MENU = toolbarMenuPoints(panel), ROWS = toolbarMenuRowPoints(panel);
const BUTTONS = ROWS.map(row => lensRectFromPoints({ points: row, origin: EYE, basis: BASIS }))
  .filter(Boolean);

const corners = ([hx, hy, hz], centre = [0, 0, 0]) => [-1, 1].flatMap(sx => [-1, 1].flatMap(sy =>
  [-1, 1].map(sz => [centre[0] + sx * hx, centre[1] + sy * hy, centre[2] + sz * hz])));
/** The wall: three protofilaments wide, two dimers deep, in Angstroms. */
const WALL_HALF = [81, 71.4, 12.5];
const WALL = corners(WALL_HALF);
/** One protofilament of it: the lit selection of a highlight chapter. */
const column = (halfX, centreX) => ({ half: [halfX, WALL_HALF[1], 12.5],
  centre: [centreX, 0, 0], points: corners([halfX, WALL_HALF[1], 12.5], [centreX, 0, 0]) });

/** The pose the wall lands in at this point of the tier's free twist. */
function landed(phaseDegrees) {
  const turn = obliqueGrowthTurn({ headInRoom, renderFromRoom,
    placement: { rotation: [0, phaseDegrees, 0], translation: [0, 0, 0], scale: 1 },
    points: WALL, centre: [0, 0, 0], tiltDegrees: GROWTH_TILT_DEGREES,
    rollDegrees: GROWTH_ROLL_DEGREES, azimuthDegrees: GROWTH_WALL_AZIMUTH_DEGREES });
  return turn ? turn.rotation : [0, phaseDegrees, 0];
}

/** One chapter of the wall tier, solved against the shipped panel. */
function chapter({ phase, lit, pinned = false }) {
  const whole = !lit;
  return focusPlacement({ headInRoom, renderFromRoom, cameraScale: 0.00713,
    center: [0, 0, 0], radius: Math.hypot(...WALL_HALF),
    placement: { rotation: landed(phase), translation: [0, 0, 0], scale: 2.2 },
    targetCenter: whole ? [0, 0, 0] : lit.centre,
    targetRadius: Math.hypot(...(whole ? WALL_HALF : lit.half)),
    framing: 'fill', subjectPoints: whole ? WALL : lit.points, assemblyPoints: WALL,
    platePoints: PLATES, captionPoints: CAPTIONS, menuPoints: MENU, menuRows: ROWS,
    wholeStructure: whole, minExtentFraction: whole ? 0 : 0.68,
    ...(whole ? { enclosure: 0.85 } : {}),
    ...(pinned ? { drawnGains: PINNED } : {}) });
}

/** Every point of the tier's twist a turntable chapter passes through. */
const TWIST = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];
/** The two highlight chapters of the shipped lesson, at their own rotations. */
const WALL_03 = { phase: 220, lit: column(30.5, -27) };
const WALL_04 = { phase: 235, lit: column(36, -27) };
const near = (value, want) => Math.abs(value - want) < 5e-4;
const rectOf = ([x, y], halfWidth, halfHeight) => lensRect({ x, y, halfWidth, halfHeight });
const onAButton = rect => BUTTONS.some(row => lensRectsOverlap(rect, row, 0));

test('the uncorrected wall grant overflows the lens while the final solver remains bounded', () => {
  // The historical capture had ten overflowing seats in the 0.575–0.696
  // range. Without the old source-relative scale cap, all twelve can now
  // overflow before the drawn round; the next test checks the final cap.
  const drawn = TWIST.map(phase => chapter({ phase, pinned: true }).standoff.frame.drawn);
  assert.ok(drawn.every(d => d.granted.whole > SUBJECT_WHOLE_LENS_CEILING),
    'the uncorrected perspective projection exceeds its granted share');
  // These two capture phases did not hit the former placement cap.
  const at = phase => chapter({ phase, pinned: true }).standoff.frame;
  assert.ok(near(at(0).share.whole, 0.55) && near(at(0).drawn.granted.whole, 0.5955),
    'wall-01 planned 0.550 and drew 0.596');
  assert.ok(near(at(30).drawn.granted.whole, 0.5753), 'the 30-degree seat drew 0.575');
});

test('the drawn round holds the whole wall inside the ceiling at every twist', () => {
  for (const phase of TWIST) {
    const plan = chapter({ phase });
    const drawn = plan.standoff.frame.drawn;
    assert.ok(drawn.whole <= SUBJECT_WHOLE_LENS_CEILING + 1e-9,
      `the ${phase}-degree seat draws ${drawn.whole.toFixed(3)}, past the 0.55 ceiling`);
    assert.ok(drawn.wholeRise <= SUBJECT_RISE_CEILING + 1e-9,
      `the ${phase}-degree seat draws ${drawn.wholeRise.toFixed(3)} tall, past the 0.80 ceiling`);
    // Never at the cost of the plate rule, which outranks every share here.
    assert.equal(plan.standoff.clears, true, `the ${phase}-degree seat left the plates behind it`);
  }
  // It spends only what it has to: where the ceiling binds the wall still takes
  // it, and the seat is granted less than 0.55 precisely because 0.55 is what
  // it will be drawn at.
  const front = chapter({ phase: 0 }).standoff.frame;
  assert.ok(near(front.drawn.whole, 0.5498), `the reveal chapter draws ${front.drawn.whole.toFixed(4)}`);
  assert.ok(front.share.whole < SUBJECT_WHOLE_LENS_CEILING,
    'the grant is under the ceiling, because the spread spends the difference');
  assert.ok(front.drawn.gain.lit > 1, 'and the record names the spread that did it');
});

test('the highlight chapters lit 20.8 and 26.4 per cent while the record granted 0.408', () => {
  // Residual 2, as the captures measured it. `share.lit` is the framed region's
  // width — floored at `minExtentFraction` of the assembly — so a lit selection
  // a third of that region wide is recorded at the floor and drawn at half of
  // it, and the 0.40 floor never sees the number it is supposed to protect.
  for (const [name, spec, want] of [['wall-03', WALL_03, 0.2083], ['wall-04', WALL_04, 0.2641]]) {
    const frame = chapter({ ...spec, pinned: true }).standoff.frame;
    assert.ok(near(frame.share.lit, 0.408), `${name} recorded ${frame.share.lit.toFixed(4)}`);
    assert.ok(frame.share.lit >= SUBJECT_LENS_FLOOR, `${name} claimed to be at the floor`);
    assert.ok(near(frame.drawn.granted.lit, want),
      `${name} drew ${frame.drawn.granted.lit.toFixed(4)}, not ${want}`);
    assert.ok(frame.drawn.granted.lit < SUBJECT_LENS_FLOOR / 1.5,
      `${name} drew far under the floor the record claimed`);
  }
  // And the wall-04 ghost ran past the limit that outranks that floor.
  const ghost = chapter({ ...WALL_04, pinned: true }).standoff.frame.drawn.granted.whole;
  assert.ok(near(ghost, 0.9003) && ghost > SUBJECT_GHOST_LENS_LIMIT,
    `the wall-04 ghost drew ${ghost.toFixed(4)}, past the 0.75 limit`);
});

test('the drawn round lights the selection as far as the ghost limit allows', () => {
  for (const [name, spec, before, after, ghost] of [
    ['wall-03', WALL_03, 0.2083, 0.2351, 0.75], ['wall-04', WALL_04, 0.2641, 0.2410, 0.7473]]) {
    const frame = chapter({ ...spec }).standoff.frame;
    assert.ok(near(frame.drawn.lit, after),
      `${name} draws ${frame.drawn.lit.toFixed(4)}, not ${after}`);
    // The ghost limit is the bound, and it holds on the drawn projection now:
    // wall-03's ghost is lifted to it and wall-04's is cut back to it.
    assert.ok(frame.drawn.whole <= SUBJECT_GHOST_LENS_LIMIT + 1e-9,
      `${name} draws a ${frame.drawn.whole.toFixed(4)} ghost, past the 0.75 limit`);
    // The final shrink may land slightly under the limit because perspective
    // projection is nonlinear; it must preserve the lit width above.
    assert.ok(near(frame.drawn.whole, ghost), `${name} retains the expected ghost width`);
    // A selection this narrow inside a wall this wide cannot reach the 0.40
    // floor under that limit — 0.40 of lit is 1.17 of ghost — and the module's
    // precedence says the limit wins. What the round owes is the largest lit
    // part the limit allows, and the record now says which number that is.
    assert.ok(frame.drawn.lit < SUBJECT_LENS_FLOOR, `${name} is still under the floor, by the limit`);
    assert.ok(frame.drawn.lit >= before - 1e-9 || frame.drawn.granted.whole > SUBJECT_GHOST_LENS_LIMIT,
      `${name} gave up lit width to something other than the ghost limit`);
  }
  // wall-03 had room under the limit and takes it: more lit part than before.
  const lifted = chapter({ ...WALL_03 }).standoff.frame.drawn.lit;
  assert.ok(lifted > 0.2083, `wall-03 lights ${lifted.toFixed(4)}, no more than it did`);
});

test('the lit selection comes off the Menu button, and the record says what has not', () => {
  for (const [name, spec] of [['wall-03', WALL_03], ['wall-04', WALL_04]]) {
    const before = chapter({ ...spec, pinned: true }).standoff.frame;
    const after = chapter({ ...spec }).standoff.frame;
    const litRect = frame => rectOf(frame.drawn.litAt, frame.drawn.lit, frame.drawn.litRise);
    assert.equal(onAButton(litRect(after)), false,
      `${name} still draws its lit selection over a button row`);
    // The record no longer reads clear while a button is under a ribbon: eight
    // assembly corners all missed the rows in both chapters, and `covered` is
    // the verdict that did not.
    assert.equal(before.menu.ghost.cleared, true, `${name} reported cleared on its corners alone`);
    assert.equal(after.menu.ghost.covered, true,
      `${name} says a button row is under the ghost, which is the tolerated crossing`);
    assert.equal(after.menu.ghost.crossed, true, `${name} crosses the dimmed column, as the rule allows`);
  }
  // The wall-04 lit rectangle is the one that was ON a button before the round:
  // measured on the grant, which is the seat the capture was taken at.
  const granted = chapter({ ...WALL_04, pinned: true }).standoff.frame.drawn.granted;
  assert.equal(onAButton(rectOf(granted.litAt, granted.lit, granted.litRise)), true,
    'wall-04 drew its lit selection over a button row before the round');
});
