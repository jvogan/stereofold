import assert from 'node:assert/strict';
import test from 'node:test';
import {
  componentLabelHardwareGain,
  componentLabelMinimumSizeScale,
  labelCharacterDegrees,
  labelCharacterUnits,
  labelSizeFactor,
  COMPONENT_LABEL_GAIN,
  LABEL_CHARACTER_DEGREES,
  MOLSTAR_TEXT_EM_PER_SIZE,
} from './label-facing.mjs';
import {
  MOLSTAR_BACKGROUND_MARGIN,
  PLATE_BOUND_HEIGHTS,
  PLATE_BOUND_RADII,
  PLATE_MARGIN_EM,
  PLATE_GAP_EM,
  PLATE_MAX_WIDTH_EM,
  PLATE_FIELD,
  countObstacleOverlaps,
  countPlateOverlaps,
  exactPlateSearch,
  drawnPlateRects,
  layoutComponentPlates,
  menuGlassObstacles,
  MENU_PLATE_AIR,
  plateDrawDepth,
  partsSilhouette,
  plateHalfExtents,
  plateLeader,
  platesOverlap,
  plateBandSlots,
  plateSideSpread,
  meanPlateLeaderEm,
  plateViewBasis,
  screenRectFromPoints,
  wrapPlateText,
} from './label-layout.mjs';
import { capPlateSeat, measurePlateSeat, plateSeatLimits } from './plate-seat.mjs';
import { componentPlateName } from './component-labels.mjs';

test('halving the candidate grid step finds a reachable slot the default misses', () => {
  const field = { halfWidth: 1.3, halfHeight: 1 };
  const plate = { id: 'plate', rect: { x: 0, y: 0, halfWidth: 1, halfHeight: .7 },
    maxTravel: .32, exclusion: { x: 0, y: 0, radius: .301 } };
  // Default centers use {-0.3, 0, 0.3} on both axes. Axis points are inside
  // the exclusion disk; corners exceed the tether. A half-step adds 0.05,
  // admitting (0.05, 0.3), whose radius is sqrt(0.0925), between both bounds.
  // This isolates the exact candidate search; the packer's continuous greedy
  // prepass can find a slot for this one plate independently of the grid.
  const coarse = exactPlateSearch([plate], [], field);
  assert.equal(coarse.resolution, .7, 'default is the smallest plate half-height');
  assert.equal(coarse.complete, true, 'candidate exhaustion is not continuous impossibility');
  assert.equal(coarse.placed, null);
  const fine = exactPlateSearch([plate], [], field, { resolution: coarse.resolution / 2 });
  assert.equal(fine.complete, true);
  assert.ok(fine.slots > coarse.slots, 'finer sampling enlarges the search domain');
  const at = fine.placed.get('plate');
  assert.ok(Math.abs(at.x) + at.halfWidth <= field.halfWidth + 1e-9);
  assert.ok(Math.abs(at.y) + at.halfHeight <= field.halfHeight + 1e-9);
  assert.ok(Math.hypot(at.x, at.y) >= plate.exclusion.radius);
  assert.ok(Math.hypot(at.x, at.y) <= plate.maxTravel);
});

/**
 * The telomerase H/ACA lobe of PDB 8OUE, as ten part centroids in Angstroms.
 *
 * The lab has no copy of 8OUE, so this is the deposited assembly's shape
 * rather than its coordinates: the pseudo-symmetric pair of heterotetramers
 * (dyskerin, NOP10, NHP2, GAR1 on each side) around the hTR H/ACA hairpin they
 * both bind, with TCAB1 out at the CR7 loop. What it has to reproduce is the
 * defect, and it does: at the gain the hardware run drew at, five
 * plates — both dyskerins, both NOP10s and the RNA — come out stacked on one
 * another in the middle of the cluster, which is exactly what the left-eye
 * crops of that run show, with one name completely buried.
 *
 * Names are the shipped lesson's own (`plugin/demos/telomerase-haca.json`),
 * because a plate is as wide as the name on it and "Telomerase RNA H/ACA
 * domain" is most of what makes this hard.
 */
const TELOMERASE_PARTS = Object.freeze([
  { id: 'dyskerin-c', text: 'Dyskerin (DKC1), first copy', anchor: [-36, -6, 8], radius: 26 },
  { id: 'dyskerin-g', text: 'Dyskerin (DKC1), second copy', anchor: [32, -9, -6], radius: 25 },
  { id: 'nop10-f', text: 'NOP10, first copy', anchor: [-18, -2, 18], radius: 12 },
  { id: 'nop10-j', text: 'NOP10, second copy', anchor: [16, -4, -16], radius: 12 },
  { id: 'nhp2-e', text: 'NHP2, first copy', anchor: [-26, 22, 2], radius: 14 },
  { id: 'nhp2-i', text: 'NHP2, second copy', anchor: [24, 19, -8], radius: 14 },
  { id: 'gar1-d', text: 'GAR1, first copy', anchor: [-58, -22, -6], radius: 15 },
  { id: 'gar1-h', text: 'GAR1, second copy', anchor: [54, 26, 14], radius: 15 },
  { id: 'tcab1-k', text: 'TCAB1', anchor: [10, 46, -28], radius: 22 },
  { id: 'htr-b', text: 'Telomerase RNA H/ACA domain', anchor: [0, 2, 0], radius: 38 },
]);

/**
 * The seat the resting capture was taken from: the wearer level
 * with the structure, looking at its centre.
 */
const SEAT = Object.freeze({ eye: [0, 0, 139], target: [0, 0, 0], up: [0, 1, 0] });

/**
 * Mol*'s scene-to-room scale in that session, recovered from the run's own
 * `component-labels` diagnostic — `sizeFactor 5.91` at gain 1.3, seat 1.5 m,
 * 1.5 degrees per character — so every number below is anchored to what the
 * headset actually drew rather than to a guess.
 */
const CAMERA_SCALE = (2 * 1.5 * Math.tan((LABEL_CHARACTER_DEGREES.comfortable / 2) * Math.PI / 180))
  / ((1 / 1.25) * (5.91 / 1.3));
const SEAT_METERS = 1.5;

test('a raised small subject leaves free lower glass for all ten plates', () => {
  // Acceptance 3 #548/#574: this is the recorded silhouette after smaller.
  // Anchors at its upper edge start outside the readable field. There is
  // ample room below it; pulling failed escapes onto the edge is not a solve.
  const plates = TELOMERASE_PARTS.map((part, i) => ({ ...part,
    text: componentPlateName(part.text), focused: i < 2,
    anchor: [(i - 4.5) * .04, .695 + (i % 3 - 1) * .1, -1], radius: .06 }));
  const result = layoutComponentPlates({ plates,
    eye: [0, 0, 0], target: [0, 0, -1], characterUnits: .05, minSizeScale: 1,
    obstacles: [{ x: -.46, y: -.185, halfWidth: .3, halfHeight: .504 }],
    subject: { x: .006, y: .695, halfWidth: .366, halfHeight: .297 }, field: PLATE_FIELD });
  assert.equal(result.subjectOverlaps, 0);
  assert.equal(result.overlaps, 0);
  assert.equal(result.offGlass, 0);
  assert.equal(result.menuOverlaps, 0);
});

/** The size a chapter at this placement scale draws at, end to end. */
function chapterSizing(placementScale) {
  // The XR manager derives `camera.scale` once, from the scene radius at
  // session start, so a chapter's placement scale spreads the parts apart
  // without changing the scale the glyphs are sized against.
  const gain = componentLabelHardwareGain(placementScale);
  const sizeFactor = labelSizeFactor({ distanceMeters: SEAT_METERS, cameraScale: CAMERA_SCALE,
    sizeThemeValue: 1, characterDegrees: LABEL_CHARACTER_DEGREES.comfortable }) * gain;
  return {
    gain, sizeFactor,
    characterUnits: labelCharacterUnits({ sizeFactor }),
    minSizeScale: componentLabelMinimumSizeScale(gain),
    character: labelCharacterDegrees({ sizeFactor, cameraScale: CAMERA_SCALE,
      distanceMeters: SEAT_METERS }).character,
  };
}

const chapter = (placementScale, { focus } = {}) => TELOMERASE_PARTS.map(part => ({
  ...part,
  anchor: part.anchor.map(value => value * placementScale),
  radius: part.radius * placementScale,
  focused: part.id === focus,
}));

const solve = (placementScale, options = {}) => {
  const sizing = chapterSizing(placementScale);
  return {
    sizing,
    result: layoutComponentPlates({ plates: chapter(placementScale, options), ...SEAT,
      characterUnits: sizing.characterUnits, minSizeScale: sizing.minSizeScale, ...options }),
  };
};

/**
 * The menu column exactly as the Quest 2 run drew it, in XR room
 * metres, from that run's own `toolbar {phase:"rows"}` record: eight rows at
 * x -0.4435 and z -0.8474, 0.075 m apart down the wearer's left.
 *
 * `halfWidth` is the column's own pitch times `minColumnHalfWidthFactor` and
 * `halfHeight` is the row step times `rowHalfHeightFactor`, both from
 * `SPATIAL_TOOLBAR_LAYOUT`, so the rectangle is the drawn buttons rather than
 * a guess around their centres.
 */
const MENU_ROWS = Object.freeze({
  x: -0.4435030371466558,
  z: -0.8474432247267154,
  y: Object.freeze([0.09797296762466431, 0.022972967624664303, -0.05202703237533571,
    -0.1270270323753357, -0.2020270323753357, -0.27702703237533566,
    -0.3520270323753357, -0.4270270323753357]),
  halfWidth: 0.30 * 0.36,
  halfHeight: 0.52 * 0.075,
});

/**
 * One XR room point, in metres, as a scene point at this seat.
 *
 * This is the space question the menu defect turned on, written
 * out: the room's -z is the seat's forward, its x the seat's right, its y the
 * seat's up, and one room metre is `1 / cameraScale` scene units. It is what
 * `roomToSceneMatrix` computes from the camera on the page; here it is spelled
 * out so the test states which space the toolbar rectangle arrives in.
 */
const roomToScene = ([x, y, z]) => [
  SEAT.eye[0] + x / CAMERA_SCALE,
  SEAT.eye[1] + y / CAMERA_SCALE,
  SEAT.eye[2] + z / CAMERA_SCALE,
];

/**
 * That column as the screen rectangle the solver is handed.
 *
 * `x` and `rows` are how the wearer moves it. The Move row
 * re-seats the column on the pose they have now, which can put it down the
 * other side of the lens; the Menu row folds the eight rows to the compact
 * four and opens them again. Both leave the plates solved against a rectangle
 * that is no longer there.
 */
function menuRectAtSeat({ x = MENU_ROWS.x, rows = MENU_ROWS.y.length } = {}) {
  const points = MENU_ROWS.y.slice(0, rows).flatMap(y => [
    [x - MENU_ROWS.halfWidth, y - MENU_ROWS.halfHeight, MENU_ROWS.z],
    [x + MENU_ROWS.halfWidth, y + MENU_ROWS.halfHeight, MENU_ROWS.z],
  ]).map(roomToScene);
  return screenRectFromPoints({ points, ...SEAT });
}

/**
 * The plate rectangles Mol* will draw, transcribed from
 * `mol-geo/geometry/text/text-builder.js` rather than asked of the module
 * under test.
 *
 * `bWidth` is the glyph run in mapping units, `margin` is
 * `(1 / 2.5) * backgroundMargin`, the background quad runs from
 * `-bWidth/2 - margin - 0.1` to `+bWidth/2 + margin + 0.1` and from
 * `-bHeight/2 - margin` to `+bHeight/2 + margin`, and the viewer stacks a
 * wrapped name as separate labels one character box apart. Everything is then
 * multiplied by the size factor and divided by the plate's own depth, which is
 * how `text.vert` puts it on the glass.
 */
function bruteForceDrawnRects(parts, placements, { characterUnits, measureText }) {
  const sizeFactor = characterUnits / MOLSTAR_TEXT_EM_PER_SIZE;
  const bHeight = 1 / 1.25;
  const margin = (1 / 2.5) * MOLSTAR_BACKGROUND_MARGIN;
  return placements.map(place => {
    const part = parts.find(entry => entry.id === place.id);
    if (!part || !place.rect) return { id: place.id, rect: null };
    const lines = place.lines?.length ? place.lines : [part.text];
    const bWidth = Math.max(...lines.map(line => measureText(line) * MOLSTAR_TEXT_EM_PER_SIZE));
    const scale = place.sizeScale * sizeFactor;
    const depth = SEAT.eye[2] - part.anchor[2];
    return { id: place.id, rect: {
      x: (part.anchor[0] - SEAT.eye[0] + place.offsetX) / depth,
      y: (part.anchor[1] - SEAT.eye[1] + place.offsetY) / depth,
      halfWidth: (scale * (bWidth + 2 * margin + 0.2) / 2) / depth,
      halfHeight: (scale * ((lines.length - 1) * bHeight + bHeight + 2 * margin) / 2) / depth,
    } };
  });
}

const hits = (a, b) => Boolean(a && b)
  && Math.abs(a.x - b.x) < a.halfWidth + b.halfWidth
  && Math.abs(a.y - b.y) < a.halfHeight + b.halfHeight;

/** How many pairs of those rectangles land on one another. */
function bruteForceOverlaps(rects) {
  let pairs = 0;
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) if (hits(rects[i].rect, rects[j].rect)) pairs += 1;
  }
  return pairs;
}

/** Which plates are drawn over another plate, by name. */
function stackedPlates(placements) {
  const names = new Set();
  for (let i = 0; i < placements.length; i++) {
    for (let j = i + 1; j < placements.length; j++) {
      const a = placements[i], b = placements[j];
      if (!a.rect || !b.rect) continue;
      if (Math.abs(a.rect.x - b.rect.x) < a.rect.halfWidth + b.rect.halfWidth
        && Math.abs(a.rect.y - b.rect.y) < a.rect.halfHeight + b.rect.halfHeight) {
        names.add(a.id); names.add(b.id);
      }
    }
  }
  return names;
}

// The premise. Without this the rest of the file proves nothing: a solver that
// separates plates which were never going to collide is not a fix.
test('the resting geometry stacks five plates at the gain the hardware drew at', () => {
  const sizeFactor = labelSizeFactor({ distanceMeters: SEAT_METERS, cameraScale: CAMERA_SCALE,
    characterDegrees: LABEL_CHARACTER_DEGREES.comfortable }) * COMPONENT_LABEL_GAIN.min;
  // The run's own diagnostic, reproduced: component-labels {sizeFactor: 5.91,
  // characterDegrees: 1.95, seatMeters: 1.5}.
  assert.equal(Math.round(sizeFactor * 100) / 100, 5.91);
  assert.equal(Math.round(labelCharacterDegrees({ sizeFactor, cameraScale: CAMERA_SCALE,
    distanceMeters: SEAT_METERS }).character * 100) / 100, 1.95);

  // Laid out with no room to move and no shrinking allowed, which is what the
  // page did before this change: every plate at its own part's centroid.
  const asDrawn = layoutComponentPlates({ plates: chapter(1), ...SEAT,
    characterUnits: labelCharacterUnits({ sizeFactor }),
    minSizeScale: 1, boundHeights: 0, boundRadii: 0 });
  assert.deepEqual([...stackedPlates(asDrawn.placements)].sort(),
    ['dyskerin-c', 'dyskerin-g', 'htr-b', 'nop10-f', 'nop10-j']);
  // Eight pairs, counted on the rectangles Mol* draws rather than on the
  // half-em-margin paraphrase this module used to model a plate with.
  assert.equal(asDrawn.overlaps, 8);
  assert.equal(asDrawn.overlaps,
    bruteForceOverlaps(bruteForceDrawnRects(chapter(1), asDrawn.placements,
      { characterUnits: labelCharacterUnits({ sizeFactor }), measureText: text => text.length * 0.55 })));
});

test('ten plates come apart in the wide resting view', () => {
  const { sizing, result } = solve(1);
  assert.equal(result.placements.length, 10);
  assert.equal(result.overlaps, 0);
  assert.equal(countPlateOverlaps(result.placements), 0);
  // Only the crowded middle moves. The plates a wearer could already read stay
  // where they were, which is what keeps a rebuild from looking like a shuffle.
  assert.equal(result.fanned, 5);
  assert.deepEqual(result.placements.filter(entry => !entry.moved).map(entry => entry.id).sort(),
    ['dyskerin-c', 'gar1-d', 'gar1-h', 'nhp2-e', 'tcab1-k']);
  // Every plate inside its bound: one part radius plus three plate heights.
  for (const entry of result.placements) {
    const part = TELOMERASE_PARTS.find(candidate => candidate.id === entry.id);
    const { halfHeight } = plateHalfExtents({ text: part.text, characterUnits: sizing.characterUnits });
    const bound = PLATE_BOUND_RADII * part.radius + PLATE_BOUND_HEIGHTS * 2 * halfHeight;
    assert.ok(entry.displacement <= bound + 1e-6,
      `${entry.id} travelled ${entry.displacement.toFixed(1)}A past a bound of ${bound.toFixed(1)}A`);
  }
  // The widest travel is the RNA hairpin's, and it is about its own radius.
  // Three Angstroms of that are `PLATE_RADIAL_BIAS` and `PLATE_GAP_EM`: the
  // hairpin's own outward spoke is a hair longer than the shortest escape and
  // is taken anyway so the plates spread around the subject rather than off
  // its nearest edge, and the air each plate keeps has to survive the lens.
  const furthest = result.placements.reduce((a, b) => (a.displacement > b.displacement ? a : b));
  assert.equal(furthest.id, 'htr-b');
  assert.equal(Math.round(furthest.displacement), 50);
});

test('the close chapter needs less fanning, because its parts are further apart', () => {
  // Placement scale 2.4 is the lesson's `site` chapter. Mol*'s camera scale
  // does not follow it, so the plates stay the size they were and the parts
  // move apart — which is why the close view was never the one that stacked.
  const { result } = solve(2.4);
  assert.equal(result.overlaps, 0);
  assert.equal(result.fanned, 3);
  assert.equal(result.shrunk, 0);
  assert.equal(result.dimmed, 0);
  // And nothing comes off the part it names.
  assert.equal(result.detached, 0);
});

test('both chapters read: above the gain that worked wide, no larger than the one that worked close', () => {
  const wide = chapterSizing(1);
  const close = chapterSizing(2.4);
  const degreesAt = gain => labelCharacterDegrees({
    sizeFactor: labelSizeFactor({ distanceMeters: SEAT_METERS, cameraScale: CAMERA_SCALE,
      characterDegrees: LABEL_CHARACTER_DEGREES.comfortable }) * gain,
    cameraScale: CAMERA_SCALE, distanceMeters: SEAT_METERS }).character;
  const floor = degreesAt(COMPONENT_LABEL_GAIN.min);   // run 14: read wide, small close
  const ceiling = degreesAt(COMPONENT_LABEL_GAIN.gain); // run 13: ideal close, stacked wide

  assert.equal(Math.round(floor * 100) / 100, 1.95);
  assert.equal(Math.round(ceiling * 100) / 100, 4.05);
  assert.equal(Math.round(wide.character * 100) / 100, 2.61);
  assert.equal(Math.round(close.character * 100) / 100, 4.05);
  assert.equal(Math.round(wide.sizeFactor * 100) / 100, 7.92);
  assert.equal(Math.round(close.sizeFactor * 100) / 100, 12.27);
  for (const sizing of [wide, close]) {
    assert.ok(sizing.character >= floor - 1e-9, 'no smaller than the gain that already read wide');
    assert.ok(sizing.character <= ceiling + 1e-9, 'no larger than the gain that already read close');
  }
  // Even a plate that has shrunk all the way is still at the wide-view gain.
  assert.equal(Math.round(wide.character * wide.minSizeScale * 100) / 100, 1.95);
  assert.equal(Math.round(close.character * close.minSizeScale * 100) / 100, 1.95);
});

test('the gain follows the placement through the calibration point', () => {
  assert.equal(componentLabelHardwareGain(COMPONENT_LABEL_GAIN.scale), COMPONENT_LABEL_GAIN.gain);
  assert.equal(Math.round(componentLabelHardwareGain(1) * 100) / 100, 1.74);
  assert.ok(componentLabelHardwareGain(1.1) > componentLabelHardwareGain(1));
  // Clamped at both ends: a tiny chapter never drops under the gain that was
  // already read wide, and a huge one never passes Meta's comfortable ceiling.
  assert.equal(componentLabelHardwareGain(0.1), COMPONENT_LABEL_GAIN.min);
  assert.equal(componentLabelHardwareGain(12), COMPONENT_LABEL_GAIN.max);
  for (const scale of [undefined, null, 0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(componentLabelHardwareGain(scale), componentLabelHardwareGain(1));
  }
  assert.equal(componentLabelMinimumSizeScale(COMPONENT_LABEL_GAIN.min), 1);
  assert.equal(componentLabelMinimumSizeScale(0), 1);
});

test('the part being explained keeps its plate, at full size, where it belongs', () => {
  // The RNA hairpin sits at the middle of the cluster, so when it is the
  // subject it is the plate four others would otherwise have buried.
  const { result } = solve(1, { focus: 'htr-b' });
  const subject = result.placements.find(entry => entry.focused);
  assert.equal(subject.id, 'htr-b');
  assert.equal(subject.offsetX, 0);
  assert.equal(subject.offsetY, 0);
  assert.equal(subject.sizeScale, 1);
  assert.equal(subject.alpha, 1);
  assert.equal(subject.moved, false);
  // Nothing is allowed to draw over it, and the four that stacked on it in the
  // unfocused layout have all moved out of its way.
  assert.equal(result.focusOverlaps, 0);
  assert.equal(result.overlaps, 0);
  for (const id of ['dyskerin-c', 'dyskerin-g', 'nop10-f', 'nop10-j']) {
    assert.ok(result.placements.find(entry => entry.id === id).moved, `${id} yielded to the subject`);
  }
});

test('a subject in a pile wins even when the yielding plates run out of room', () => {
  // Four plates on top of one another at the same centroid, with the subject
  // among them: nothing can be fanned into free space because there is none.
  // The subject still comes out unmoved, full size and unobscured; the rest
  // shrink and dim rather than crowd it.
  const pile = ['a', 'b', 'c', 'd', 'e'].map((id, index) => ({
    id, text: `Component number ${id}`, anchor: [0, index * 0.4, 0], radius: 3,
    focused: id === 'c',
  }));
  // Bounded to a single plate height, so there is genuinely nowhere to go:
  // these parts are three Angstroms across and their names are twenty
  // characters long.
  const result = layoutComponentPlates({ plates: pile, ...SEAT, characterUnits: 6.34,
    minSizeScale: 0.746, boundHeights: 1, boundRadii: 0 });
  const subject = result.placements.find(entry => entry.focused);
  assert.equal(subject.id, 'c');
  assert.equal(subject.offsetX, 0);
  assert.equal(subject.offsetY, 0);
  assert.equal(subject.sizeScale, 1);
  assert.equal(subject.alpha, 1);
  assert.equal(result.focusOverlaps, 0);
  assert.ok(result.dimmed > 0, 'a plate with nowhere to go says so by dimming');
  for (const entry of result.placements) {
    assert.ok(entry.sizeScale >= 0.746 - 1e-9, 'no plate shrinks past the wide-view minimum');
  }
});

test('a plate is measured from its own name, and a seat from its own eye', () => {
  const short = plateHalfExtents({ text: 'TCAB1', characterUnits: 6 });
  const long = plateHalfExtents({ text: 'Telomerase RNA H/ACA domain', characterUnits: 6 });
  assert.ok(long.halfWidth > short.halfWidth * 3, 'a long name makes a wide plate');
  assert.equal(long.halfHeight, short.halfHeight);
  assert.throws(() => plateHalfExtents({ text: 'x', characterUnits: 0 }), /character size/);

  const basis = plateViewBasis({ eye: [0, 0, 10], target: [0, 0, 0], up: [0, 1, 0] });
  assert.deepEqual(basis.forward, [0, 0, -1]);
  assert.deepEqual(basis.right, [1, 0, 0]);
  assert.deepEqual(basis.up, [0, 1, 0]);
  // A wearer looking straight down leaves `up` parallel to the gaze; the frame
  // is substituted rather than left full of NaN.
  const overhead = plateViewBasis({ eye: [0, 10, 0], target: [0, 0, 0], up: [0, 1, 0] });
  assert.ok(overhead.right.every(Number.isFinite) && overhead.up.every(Number.isFinite));
  assert.throws(() => plateViewBasis({ eye: [0, 0, 0], target: [0, 0, 0] }), /differ/);
  assert.throws(() => layoutComponentPlates({ plates: [], eye: [0, 0, 1], target: [0, 0, 0], characterUnits: 0 }),
    /character size/);
});

test('the ten shipped names use drawn-scale metrics and keep the RNA name on one line', () => {
  const measureText = text => text.length * 0.68;
  const characterUnits = 3.4;
  for (const part of TELOMERASE_PARTS) {
    const extents = plateHalfExtents({ text: part.text, characterUnits, measureText });
    const measuredContent = measureText(part.text) * characterUnits;
    // The padding is Mol*'s own, not half an em: `(1/2.5) * backgroundMargin`
    // plus a fixed tenth of a mapping unit on each side.
    assert.equal(Math.round(PLATE_MARGIN_EM * 1000) / 1000, 0.375);
    assert.ok(extents.halfWidth * 2 >= measuredContent + 2 * characterUnits * PLATE_MARGIN_EM - 1e-9,
      `${part.id} plate is narrower than its measured glyphs`);
    assert.equal(extents.lines.length, 1, `${part.id} should fit on one line`);
  }
  const longest = plateHalfExtents({ text: TELOMERASE_PARTS.at(-1).text, characterUnits, measureText });
  assert.ok(longest.halfWidth > plateHalfExtents({ text: 'TCAB1', characterUnits, measureText }).halfWidth);
});

test('an over-wide name wraps to two measured lines instead of clipping', () => {
  const measureText = text => text.length * 0.8;
  const long = 'Deliberately over-wide ribonucleoprotein component name';
  const lines = wrapPlateText(long, { measureText, maxWidthEm: 24 });
  assert.equal(lines.length, 2);
  assert.ok(lines.every(line => measureText(line) <= 24), 'each wrapped line fits the allowed width');
  const result = layoutComponentPlates({ plates: [{ id: 'long', text: long, anchor: [0, 0, 0], radius: 10 }],
    ...SEAT, characterUnits: 2, measureText, maxWidthEm: 24 });
  const placement = result.placements[0];
  assert.deepEqual(placement.lines, lines);
  assert.ok(placement.rect.halfWidth * 2 <= (24 + 2 * 0.5) * 2 + 1e-9,
    'the solver uses the widest allowed line, not the unwrapped name');
});

test('a toolbar rectangle is an obstacle and is not counted as a plate overlap', () => {
  const toolbar = screenRectFromPoints({ points: [[-1, -1, 8], [1, 1, 8]], ...SEAT });
  assert.deepEqual(toolbar, { x: 0, y: 0, halfWidth: 1 / 131, halfHeight: 1 / 131 });
  const result = layoutComponentPlates({
    plates: [{ id: 'under-menu', text: 'GAR1, first copy', anchor: [0, 0, 0], radius: 20 }],
    ...SEAT, characterUnits: 1, obstacles: [toolbar],
  });
  const moved = result.placements[0];
  assert.equal(result.overlaps, 0);
  assert.ok(moved.moved, 'a plate beneath the menu must be fanned clear');
  assert.ok(!(Math.abs(moved.rect.x - toolbar.x) < moved.rect.halfWidth + toolbar.halfWidth
    && Math.abs(moved.rect.y - toolbar.y) < moved.rect.halfHeight + toolbar.halfHeight),
  'the moved plate is clear of the toolbar rectangle');
});

// The defect, in the numbers that run recorded. `component-labels`
// reported `sizeFactor 7.92` and `seatMeters 1.5` while `toolbar {phase:rows}`
// put eight rows down the wearer's left, and the left-eye crop shows "GAR1,
// first copy" under the Pg 1/8 row on both entries.
test('the ten names clear the menu column the run actually drew, at the size it drew them', () => {
  const menu = menuRectAtSeat();
  // The rectangle the solver is handed, in the space it is handed it in: a
  // screen rectangle in tangent units, 0.52 of a radian's tangent off to the
  // wearer's left and a third of the lens tall.
  assert.equal(Math.round(menu.x * 1000) / 1000, -0.523);
  assert.equal(Math.round(menu.halfWidth * 1000) / 1000, 0.127);
  assert.equal(Math.round(menu.halfHeight * 1000) / 1000, 0.356);

  const { sizing, result } = solve(1, { obstacles: [menu] });
  assert.equal(Math.round(sizing.sizeFactor * 100) / 100, 7.92);
  assert.equal(result.placements.length, 10);
  assert.equal(result.overlaps, 0);
  assert.equal(result.menuOverlaps, 0);
  assert.equal(result.focusOverlaps, 0);

  // And again from Mol*'s own plate arithmetic rather than from the solver's,
  // so "no plate on the menu" is a statement about the glass.
  const drawn = bruteForceDrawnRects(chapter(1), result.placements,
    { characterUnits: sizing.characterUnits, measureText: text => text.length * 0.55 });
  assert.equal(bruteForceOverlaps(drawn), 0);
  const onMenu = drawn.filter(entry => hits(entry.rect, menu)).map(entry => entry.id);
  assert.deepEqual(onMenu, [], `plates drawn under the menu column: ${onMenu.join(', ')}`);

  // The module's own drawn-rectangle helper — the one the record is counted
  // from — agrees with the transcription above, rectangle for rectangle.
  const viaHelper = drawnPlateRects({ plates: chapter(1), placements: result.placements, ...SEAT,
    characterUnits: sizing.characterUnits, measureText: text => text.length * 0.55 });
  assert.equal(countObstacleOverlaps(viaHelper, [menu]), 0);
  for (const entry of viaHelper) {
    const expected = drawn.find(candidate => candidate.id === entry.id).rect;
    for (const key of ['x', 'y', 'halfWidth', 'halfHeight']) {
      assert.ok(Math.abs(entry.rect[key] - expected[key]) < 1e-9, `${entry.id}.${key}`);
    }
  }
});

// The menu admits a chapter only with 0.04 of view between its glass and
// every drawn plate in each eye. A plate the solver laid flush against the
// card failed that, and the menu left the forward view for a turned-head seat.
test('the names keep the admission air off the menu glass, not just off its edge', () => {
  const menu = menuRectAtSeat();
  const air = (rect, glass) => Math.max(Math.abs(rect.x - glass.x) - rect.halfWidth - glass.halfWidth,
    Math.abs(rect.y - glass.y) - rect.halfHeight - glass.halfHeight);
  const drawnAir = obstacles => {
    const { sizing, result } = solve(1, { obstacles });
    const drawn = drawnPlateRects({ plates: chapter(1), placements: result.placements, ...SEAT,
      characterUnits: sizing.characterUnits, measureText: text => text.length * 0.55 });
    return Math.min(...drawn.map(entry => air(entry.rect, menu)));
  };
  assert.ok(MENU_PLATE_AIR >= 0.04 + 0.015 + 0.005, 'the gap, the quad pad and the parallax');
  assert.ok(drawnAir([menu]) < MENU_PLATE_AIR, 'with the bare glass a name sits closer than the air');
  assert.ok(drawnAir(menuGlassObstacles([menu, null])) >= MENU_PLATE_AIR - 1e-9);
});

test('without the menu rectangle the plates the crop shows land on the menu column', () => {
  // The premise for the test above, and the shape of the hardware defect: the
  // toolbar obstacle is the only thing that moves these, so a runtime path
  // that hands the solver an empty obstacle list gets this arrangement and
  // reports a clean `overlaps: 0` about it.
  const menu = menuRectAtSeat();
  const { sizing, result } = solve(1);
  assert.equal(result.overlaps, 0);
  const drawn = bruteForceDrawnRects(chapter(1), result.placements,
    { characterUnits: sizing.characterUnits, measureText: text => text.length * 0.55 });
  const onMenu = drawn.filter(entry => hits(entry.rect, menu)).map(entry => entry.id).sort();
  assert.ok(onMenu.includes('gar1-d'), '"GAR1, first copy" is the plate the crop shows under Pg 1/8');
  assert.ok(onMenu.length >= 3, `${onMenu.length} plates on the menu with no obstacle passed`);
  // The solver's own count agrees once it is told about the rectangle it was
  // never given: the obstacle is what moves them, not the size model.
  assert.equal(countObstacleOverlaps(result.placements, [menu]), onMenu.length);
  assert.equal(solve(1, { obstacles: [menu] }).result.menuOverlaps, 0);
});

test('the recorded overlap count is a brute-force check of the drawn rectangles', () => {
  const menu = menuRectAtSeat();
  const measureText = text => text.length * 0.55;
  // A sweep from the shipped geometry down to a cluster a quarter of its
  // width, where ten plates of the same size have to share a lens corner.
  // Every spread is checked twice: the count the record carries, and the same
  // count rebuilt from `text-builder.js` by hand.
  for (const spread of [1, 0.75, 0.6, 0.5, 0.4, 0.25]) {
    for (const obstacles of [[], [menu]]) {
      const sizing = chapterSizing(1);
      const plates = chapter(1).map(part => ({ ...part,
        anchor: part.anchor.map(value => value * spread), radius: part.radius * spread }));
      const result = layoutComponentPlates({ plates, ...SEAT, characterUnits: sizing.characterUnits,
        minSizeScale: sizing.minSizeScale, measureText, obstacles });
      const drawn = bruteForceDrawnRects(plates, result.placements,
        { characterUnits: sizing.characterUnits, measureText });
      assert.equal(result.overlaps, bruteForceOverlaps(drawn),
        `spread ${spread} with ${obstacles.length} obstacle(s): the record disagrees with the drawn rectangles`);
      assert.equal(result.menuOverlaps, drawn.filter(entry => hits(entry.rect, menu)).length * obstacles.length,
        `spread ${spread}: the menu count disagrees with the drawn rectangles`);
      // Each plate's own rectangle is the drawn one, not the solver's scratch.
      for (const entry of drawn) {
        const placement = result.placements.find(candidate => candidate.id === entry.id);
        if (!entry.rect) { assert.equal(placement.rect, null); continue; }
        for (const key of ['x', 'y', 'halfWidth', 'halfHeight']) {
          assert.ok(Math.abs(placement.rect[key] - entry.rect[key]) < 1e-9,
            `${entry.id}.${key} ${placement.rect[key]} vs drawn ${entry.rect[key]}`);
        }
      }
      // Ten plates of this size in a cluster this tight is genuinely hard, and
      // the solver still separates them; when it cannot it must say so through
      // `yielded` rather than through a count that cannot see it.
      assert.equal(result.overlaps, 0, `spread ${spread}: plates still on one another`);
      if (result.yielded) assert.ok(result.yielded <= plates.length);
    }
  }
});

test('a plate that runs out of room says so even when it can neither shrink nor dim', () => {
  // `shrunk` is zero whenever the chapter's gain leaves `minSizeScale` at one,
  // and `dimmed` is zero whenever nothing is faded, so on the resting lesson
  // both signals were blind and a plate dropped back on the pile left no
  // trace at all. `yielded` is the one that cannot be silenced.
  const pile = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, index) => ({
    id, text: `Component number ${id}`, anchor: [0, index * 0.2, 0], radius: 2,
  }));
  const result = layoutComponentPlates({ plates: pile, ...SEAT, characterUnits: 6.34,
    minSizeScale: 1, contextAlpha: 1, boundHeights: 1, boundRadii: 0 });
  assert.equal(result.shrunk, 0);
  assert.equal(result.dimmed, 0);
  assert.ok(result.yielded > 0, 'a plate with nowhere to go inside its bound says so');
  // Whatever it could not solve, it reports: the count is the drawn
  // rectangles, so a pile this tight comes back as a number rather than as a
  // clean sheet. Six plates all at one centroid is fifteen pairs; the lifted
  // bound leaves at most one.
  const drawn = bruteForceDrawnRects(pile, result.placements,
    { characterUnits: 6.34, measureText: text => text.length * 0.55 });
  assert.equal(result.overlaps, bruteForceOverlaps(drawn));
  assert.ok(result.overlaps <= 1, `${result.overlaps} pairs left of a possible fifteen`);
});

test('a plate behind the wearer is left alone, and one plate never moves', () => {
  const plates = [
    { id: 'front', text: 'In front of the wearer', anchor: [0, 0, 0], radius: 10 },
    { id: 'behind', text: 'Behind the wearer', anchor: [0, 0, 300], radius: 10 },
  ];
  const result = layoutComponentPlates({ plates, ...SEAT, characterUnits: 6 });
  assert.equal(result.placements.find(entry => entry.id === 'behind').offsetX, 0);
  assert.equal(result.placements.find(entry => entry.id === 'behind').depth, null);
  // Nothing to collide with, so nothing moves.
  const alone = layoutComponentPlates({ plates: [plates[0]], ...SEAT, characterUnits: 6 });
  assert.equal(alone.fanned, 0);
  assert.equal(alone.overlaps, 0);
});

/**
 * The structure's own bounding sphere for the parts above: the centre of the
 * cluster and the radius that reaches its furthest subunit, which is what
 * `loadedSphere()` hands the solver on the page.
 */
const subjectAt = placementScale => {
  const parts = chapter(placementScale);
  const centre = [0, 1, 2].map(axis =>
    parts.reduce((sum, part) => sum + part.anchor[axis] / parts.length, 0));
  return { anchor: centre, radius: Math.max(...parts.map(part =>
    Math.hypot(...part.anchor.map((value, axis) => value - centre[axis])) + part.radius)) };
};

/**
 * The same ten parts under the names a PLATE shows, which is what the painter
 * draws and therefore what the arrangement has to hold for. The authored names
 * above are still what the lesson carries and what a wearer can say.
 */
const platedChapter = (placementScale, options) => chapter(placementScale, options)
  .map(part => ({ ...part, text: componentPlateName(part.text) }));

/** The resting solve as the page runs it: menu column and silhouette both in. */
const restingSolve = (placementScale, options = {}) => {
  const sizing = chapterSizing(placementScale);
  return {
    sizing,
    result: layoutComponentPlates({ plates: platedChapter(placementScale, options), ...SEAT,
      characterUnits: sizing.characterUnits, minSizeScale: sizing.minSizeScale,
      measureText: text => text.length * 0.55,
      obstacles: [menuRectAtSeat()], subject: subjectAt(placementScale), ...options }),
  };
};

test('the resting plates come to rest around the subject, never on it', () => {
  const { result } = restingSolve(1);
  assert.equal(result.placements.length, 10);
  // The three placement rules the crop is judged by, each read off the
  // rectangles the renderer will draw rather than off the solver's scratch.
  assert.equal(result.subjectOverlaps, 0, 'no plate is drawn over the structure');
  assert.equal(result.overlaps, 0, 'no two plates are drawn over one another');
  assert.equal(result.menuOverlaps, 0, 'no plate is drawn under the menu column');
  assert.equal(countPlateOverlaps(result.placements), 0);
  assert.equal(countObstacleOverlaps(result.placements, [menuRectAtSeat()]), 0);
  assert.equal(countObstacleOverlaps(result.placements, [result.subject]), 0);
  // Every plate has left the part it names, so every plate carries a leader
  // back to it. Without one, a plate outside the silhouette names nothing.
  assert.equal(result.led, 10);
  for (const entry of result.placements) {
    assert.ok(entry.leader, `${entry.id} has no leader`);
    assert.ok(entry.leader.tetherLength > 0, `${entry.id} has a leader of no length`);
  }
  // And they are spread around it rather than stacked off one edge.
  //
  // The count of distinct leader attachments used to stand
  // for that, and it is the wrong proxy now that the plates rest on bands
  // above and below rather than on eight radial spokes — a band is reached by
  // two attachments however far it is spread along. The spread itself is what
  // the assertion was ever about, so it is measured directly: both bands
  // carry plates, neither takes more than six of the ten, and the ones below
  // are strung along the silhouette rather than piled at one point of it.
  const spokes = new Set(result.placements.map(entry => entry.leader.attachment));
  assert.ok(spokes.size >= 3, `plates took only ${spokes.size} of eight spokes`);
  const spread = plateSideSpread(result.placements, result.subject);
  assert.equal(spread.over, 0);
  for (const side of ['above', 'below']) {
    assert.ok(spread[side] >= 3, `only ${spread[side]} plates took the band ${side}`);
    assert.ok(spread[side] <= 6, `${spread[side]} plates queued ${side} the structure`);
  }
  const below = result.placements.filter(entry => entry.rect.y < result.subject.y);
  const span = Math.max(...below.map(entry => entry.rect.x)) - Math.min(...below.map(entry => entry.rect.x));
  assert.ok(span > result.subject.halfWidth,
    `the lower band spans only ${span.toFixed(2)} of a ${result.subject.halfWidth.toFixed(2)} half width`);
});

test('the silhouette is what a plate must clear, not its own part', () => {
  // Without a subject the solver keeps every plate against the part it names,
  // which is the arrangement the crop shows: ten names over the
  // structure. The subject is the only thing that changes that.
  const loose = solve(1).result;
  assert.equal(loose.subjectOverlaps, null, 'no silhouette reached the solver');
  const { result } = restingSolve(1);
  // Held against the same silhouette afterwards, nine of those ten plates are
  // drawn over the structure. That is the crop in question.
  assert.equal(countObstacleOverlaps(loose.placements, [result.subject]), 9);
  assert.equal(result.detached, 10, 'every plate has come off its part');
  // A plate that clears the silhouette has travelled at least as far as the
  // silhouette's own edge, which the old per-part bound could never allow.
  const subject = result.subject;
  for (const entry of result.placements) {
    const clear = Math.abs(entry.rect.x - subject.x) >= subject.halfWidth + entry.rect.halfWidth
      || Math.abs(entry.rect.y - subject.y) >= subject.halfHeight + entry.rect.halfHeight;
    assert.ok(clear, `${entry.id} is still inside the silhouette`);
  }
});

test('two emphasised parts at one centroid are pushed apart, not stacked', () => {
  // Reproduction: the focused branch escaped the obstacle list
  // alone, so two focused plates whose parts project to the same point both
  // came to rest at travel zero and were drawn over one another. It reported
  // the damage honestly -- overlaps 1, focusOverlaps 2 -- and did nothing
  // about it.
  const twins = [
    { id: 'left', text: 'Dyskerin 1', anchor: [0, 0, 0], radius: 20, focused: true },
    { id: 'right', text: 'Dyskerin 2', anchor: [0, 0, 0], radius: 20, focused: true },
    { id: 'other', text: 'TCAB1', anchor: [40, 30, 0], radius: 14 },
  ];
  const result = layoutComponentPlates({ plates: twins, ...SEAT, characterUnits: 6.34,
    measureText: text => text.length * 0.55 });
  assert.equal(result.focusOverlaps, 0, 'the two focused plates still overlap');
  assert.equal(result.overlaps, 0);
  // Neither was shrunk or dimmed to get there: a focused plate yields to
  // nothing, so the one that moved moved at full size and full strength.
  for (const entry of result.placements.filter(place => place.focused)) {
    assert.equal(entry.sizeScale, 1);
    assert.equal(entry.alpha, 1);
  }
  const moved = result.placements.filter(entry => entry.focused && entry.moved);
  assert.equal(moved.length, 1, 'exactly one of the pair needed to move');
});

test('a leader runs from the part to the plate that names it', () => {
  const characterUnits = 6.34;
  const mappingPerScene = MOLSTAR_TEXT_EM_PER_SIZE / characterUnits;
  // An edge attachment shifts the plate by the whole tether length, so the
  // tether is the displacement itself. `middle-left` puts the anchor at the
  // plate's left edge, which is where a plate displaced to the RIGHT wants it.
  const right = plateLeader({ offsetX: 12, offsetY: 0, characterUnits });
  assert.equal(right.attachment, 'middle-left');
  assert.ok(Math.abs(right.tetherLength - 12 * mappingPerScene) < 1e-9);
  const down = plateLeader({ offsetX: 0, offsetY: -9, characterUnits });
  assert.equal(down.attachment, 'top-center');
  assert.ok(Math.abs(down.tetherLength - 9 * mappingPerScene) < 1e-9);
  // A corner attachment splits the shift across both axes, so the same travel
  // needs a tether root-two times longer to reach the same place.
  const corner = plateLeader({ offsetX: 10, offsetY: 10, characterUnits });
  assert.equal(corner.attachment, 'bottom-left');
  assert.ok(Math.abs(corner.tetherLength - Math.hypot(10, 10) * mappingPerScene * Math.SQRT2) < 1e-9);
  // A plate that never left its part has nothing to point at.
  assert.equal(plateLeader({ offsetX: 0, offsetY: 0, characterUnits }), null);
});

test('a full readable field uses clear outward bands within tether reach', () => {
  // An early device run, as numbers: the entry seat put the
  // silhouette 0.93 tangent units across — eighty-six degrees — centred a
  // quarter of the way up the view. Every plate cleared it and every plate
  // left the display.
  // Stated as a rectangle rather than a sphere, because a solver handed ten
  // parts measures the silhouette from them; this is the seat that run took.
  const huge = { x: -0.028, y: 0.471, halfWidth: 0.93, halfHeight: 0.93 };
  const sizing = chapterSizing(1);
  const solveWith = extra => layoutComponentPlates({ plates: chapter(1), ...SEAT,
    characterUnits: sizing.characterUnits, minSizeScale: sizing.minSizeScale,
    measureText: text => text.length * 0.55, subject: huge, ...extra });

  const unbounded = solveWith({});
  assert.equal(unbounded.offGlass, null, 'no field reached the solver');
  const escaped = unbounded.placements.filter(entry => entry.rect
    && (Math.abs(entry.rect.x) + entry.rect.halfWidth > PLATE_FIELD.halfWidth
      || Math.abs(entry.rect.y) + entry.rect.halfHeight > PLATE_FIELD.halfHeight));
  assert.ok(escaped.length > 0, 'the unbounded solve should leave the field');

  const bounded = solveWith({ field: PLATE_FIELD });
  assert.ok(bounded.offGlass > 0, 'the full field uses outward free bands');
  assert.equal(bounded.overlaps, 0);
  assert.equal(bounded.subjectOverlaps, 0);
  assert.equal(bounded.placements.length, chapter(1).length);

});

test('all four rules hold at once at the seat the wearer gets', () => {
  // The standard, as four numbers: on the glass, off the subject, out from
  // under the menu, and clear of one another. Nothing yielded to get there.
  const { result } = restingSolve(1, { field: PLATE_FIELD });
  assert.equal(result.offGlass, 0);
  assert.equal(result.subjectOverlaps, 0);
  assert.equal(result.menuOverlaps, 0);
  // And every plate names its part with a leader, because every plate has
  // left it.
  assert.equal(result.led, 10);
  assert.equal(result.detached, 10);
  // With no menu column in the way the band holds all ten with room to spare.
  const clear = restingSolve(1, { field: PLATE_FIELD, obstacles: [] }).result;
  assert.equal(clear.overlaps, 0);
  assert.equal(clear.yielded, 0);
  assert.equal(countPlateOverlaps(clear.placements), 0);
  // The menu eats a third of the left-hand band, and the plate it squeezes out
  // says so rather than being quietly dropped on its neighbour.
  assert.ok(result.overlaps <= 1, `${result.overlaps} pairs left of a possible forty-five`);
  const yielded = new Set(result.placements.filter(entry => entry.yielded).map(entry => entry.id));
  for (let i = 0; i < result.placements.length; i++) {
    for (let j = i + 1; j < result.placements.length; j++) {
      const [a, b] = [result.placements[i], result.placements[j]];
      if (!platesOverlap(a, b)) continue;
      assert.ok(yielded.has(a.id) || yielded.has(b.id),
        `${a.id} and ${b.id} overlap without either saying it ran out of room`);
    }
  }
});

test('a blocked plate slides along the band rather than further out of it', () => {
  // Holding every plate to its own spoke queues them: the third device run put
  // six of ten names in a column under the structure, each further out than
  // the last. The tangents of the spoke are what turn that queue into a ring.
  const { result } = restingSolve(1, { field: PLATE_FIELD, obstacles: [] });
  const subject = result.subject;
  const side = entry => {
    const dx = entry.rect.x - subject.x, dy = entry.rect.y - subject.y;
    return Math.abs(dy) > Math.abs(dx) ? (dy < 0 ? 'below' : 'above') : (dx < 0 ? 'left' : 'right');
  };
  const sides = new Set(result.placements.map(side));
  assert.ok(sides.size >= 3, `the plates took only ${sides.size} sides of the subject`);
  assert.ok(result.placements.filter(entry => side(entry) === 'below').length <= 5,
    'more than half the plates queued under the structure');
  // And none of them travels far to get there: a band one plate deep, not a
  // column reaching the bottom of the view. Measured on the glass, in the same
  // tangent units as the silhouette it is stepping outside of.
  const worst = Math.max(...result.placements.map(entry => entry.displacement / entry.depth));
  assert.ok(worst < Math.hypot(subject.halfWidth, subject.halfHeight),
    `the furthest plate travelled ${worst.toFixed(2)} against a subject half-diagonal of `
      + Math.hypot(subject.halfWidth, subject.halfHeight).toFixed(2));
});

// The fifth device run's heap, as a number.
//
// That run reported `overlaps 0, offGlass 0, subject 0` and the capture showed
// seven of ten names stacked under the structure on leaders running the height
// of the view, because a shortest straight escape is the same direction — down
// — for every part in the middle of a silhouette that is wider than it is
// tall, and a plate that finds the bottom taken is pushed further down. These
// are the two things no count in that record was measuring.
test('the plates spread around the silhouette instead of queueing under it', () => {
  const { result, sizing } = restingSolve(1, { field: PLATE_FIELD });
  const spread = plateSideSpread(result.placements, result.subject);

  // Nothing is left drawn over the structure, which is the premise of the rest.
  assert.equal(spread.over, 0, 'a plate came to rest over the subject');
  // The telomerase lobe at this seat is 0.53 of a tangent unit wide against a
  // readable field of 0.60, so the left and right bands cannot hold a plate at
  // all: a plate centred there would be off the glass, and the field is the one
  // constraint nothing yields to. The sides that ARE reachable have to share.
  const reachable = ['above', 'below'];
  for (const side of reachable) {
    assert.ok(spread[side] >= 3,
      `only ${spread[side]} of ten plates took the band ${side} the structure`);
  }
  assert.ok(Math.max(...reachable.map(side => spread[side])) <= 6,
    `the plates queued on one side: ${JSON.stringify(spread)}`);

  // And they stay near the parts they name. Nine ems is about six characters
  // short of the widest plate on the glass; the fifth device run's heap put
  // seven plates well past twice that.
  const mean = meanPlateLeaderEm(result.placements, sizing.characterUnits);
  assert.ok(mean < 9, `the mean leader ran ${mean.toFixed(2)} ems`);
  assert.equal(result.overlaps, 0);
  assert.equal(result.offGlass, 0);
  assert.equal(result.menuOverlaps, 0);
});

test('a band slot is outside the silhouette by the plate\'s own size and gap', () => {
  const subject = { x: 0, y: 0, halfWidth: 2, halfHeight: 1 };
  const slots = plateBandSlots({ subject, halfWidth: 0.5, halfHeight: 0.25, gap: 0.1, perSide: 3, rings: 1 });
  // Three per side, four sides, one ring.
  assert.equal(slots.length, 12);
  const above = slots.filter(slot => slot.side === 'above');
  assert.deepEqual(above.map(slot => slot.y), [1.35, 1.35, 1.35]);
  assert.deepEqual(above.map(slot => Math.round(slot.x * 100) / 100), [-2.6, 0, 2.6]);
  // Every slot clears the silhouette by construction, which is what lets the
  // solver treat "free" as a question about the OTHER plates alone.
  for (const slot of slots) {
    assert.ok(Math.abs(slot.x) >= subject.halfWidth + 0.5 + 0.1 - 1e-9
      || Math.abs(slot.y) >= subject.halfHeight + 0.25 + 0.1 - 1e-9,
      `a slot at ${slot.x},${slot.y} sits on the subject`);
  }
  // A further ring is one whole plate further out on each axis.
  const two = plateBandSlots({ subject, halfWidth: 0.5, halfHeight: 0.25, gap: 0.1, perSide: 3, rings: 2 });
  assert.deepEqual([...new Set(two.filter(slot => slot.side === 'above')
    .map(slot => Math.round(slot.y * 100) / 100))], [1.35, 1.95]);
  assert.equal(plateBandSlots({ subject: null, halfWidth: 1, halfHeight: 1 }).length, 0);
});

test('the silhouette is the parts the wearer sees, not a square around them', () => {
  // A square around the bounding SPHERE is round where this complex is flat:
  // on the first device run it claimed the whole upper field and threw every
  // plate off the display. The box around the projected part discs is what is
  // drawn, and for the telomerase lobe it is half as tall as it is wide.
  const { result } = restingSolve(1, { field: PLATE_FIELD });
  const box = result.subject;
  assert.ok(box.halfHeight < box.halfWidth * 0.8,
    `the silhouette came back square (${box.halfWidth.toFixed(2)} by ${box.halfHeight.toFixed(2)})`);
  // Three parts is the fewest it will measure from; below that a sphere is
  // the safer over-estimate.
  assert.equal(partsSilhouette([{ x: 0, y: 0, radius: 1 }, { x: 1, y: 0, radius: 1 }]), null);
  assert.deepEqual(partsSilhouette([
    { x: -2, y: 0, radius: 1 }, { x: 2, y: 0, radius: 1 }, { x: 0, y: 1, radius: 1 },
  ]), { x: 0, y: 0.5, halfWidth: 3, halfHeight: 1.5 });
});
// The column does not stay where the entry pass found it.
//
// The Move row re-seats it on the pose the wearer has now, the Menu row folds
// the grid to the compact column and opens it again, and a reset view does
// both. The obstacle that finally reached the solver describes
// where the column WAS; these are the two halves of what that costs.

/** Both layouts, and the rectangles Mol* would draw for each. */
function beforeAndAfter(before, after) {
  const measureText = text => text.length * 0.55;
  const stale = solve(1, { obstacles: [before] });
  const fresh = solve(1, { obstacles: [after] });
  const drawn = run => bruteForceDrawnRects(chapter(1), run.result.placements,
    { characterUnits: run.sizing.characterUnits, measureText });
  return { stale, fresh, staleDrawn: drawn(stale), freshDrawn: drawn(fresh) };
}

test('a re-seated column puts a plate under itself until the plates are solved again', () => {
  // The wearer presses Move with the column down their left and the pose they
  // have now puts it down their right. Nothing about the plates has changed,
  // so nothing rebuilds them, and the layout that was correct a second ago is
  // now a layout around a rectangle on the other side of the lens.
  const before = menuRectAtSeat();
  const after = menuRectAtSeat({ x: -MENU_ROWS.x });
  assert.equal(Math.round(before.x * 1000) / 1000, -0.523);
  assert.equal(Math.round(after.x * 1000) / 1000, 0.523);

  const { stale, fresh, staleDrawn, freshDrawn } = beforeAndAfter(before, after);
  const stranded = staleDrawn.filter(entry => hits(entry.rect, after)).map(entry => entry.id);
  assert.deepEqual(stranded, ['dyskerin-g'],
    '"Dyskerin (DKC1), second copy" is the plate the re-seated column lands on');
  assert.equal(countObstacleOverlaps(stale.result.placements, [after]), 1);

  // Solved again against where the column actually is, it clears it — on the
  // solver's own count and on the rectangles transcribed from `text-builder.js`.
  assert.equal(fresh.result.menuOverlaps, 0);
  assert.equal(fresh.result.overlaps, 0);
  assert.equal(fresh.result.focusOverlaps, 0);
  assert.deepEqual(freshDrawn.filter(entry => hits(entry.rect, after)).map(entry => entry.id), []);
});

test('the column the wearer moved away from stops holding plates out of the space it left', () => {
  // The other half, and the one no overlap count can see: four plates were
  // pushed off their own parts to clear a rectangle that is no longer there.
  // "GAR1, first copy" is the plate the crop showed under the menu;
  // once the column moves it goes back onto the part it names.
  const before = menuRectAtSeat();
  const after = menuRectAtSeat({ x: -MENU_ROWS.x });
  const { stale, fresh, freshDrawn } = beforeAndAfter(before, after);

  const returned = freshDrawn.filter(entry => hits(entry.rect, before)).map(entry => entry.id);
  assert.deepEqual(returned.sort(), ['dyskerin-c', 'gar1-d', 'nhp2-e', 'nop10-f']);
  const held = stale.result.placements.find(entry => entry.id === 'gar1-d');
  const freed = fresh.result.placements.find(entry => entry.id === 'gar1-d');
  assert.ok(Math.abs(held.offsetX) > 30, `held off its part by ${held.offsetX}`);
  assert.equal(freed.offsetX, 0);
  assert.equal(freed.offsetY, 0);
  assert.equal(freed.moved, false);
});

test('folding the grid gives the plates back the rows it took down', () => {
  // The Menu row's compact column is half the height of the grid. A fold takes
  // no plate under the menu — the compact rectangle is inside the one the
  // plates already cleared — so nothing here is an overlap count. It is the
  // same stale-obstacle cost as the re-seat, read the only way it can be read.
  const grid = menuRectAtSeat();
  const compact = menuRectAtSeat({ rows: 4 });
  assert.ok(compact.halfHeight < grid.halfHeight / 1.9, 'the compact column is half the grid');
  assert.equal(countObstacleOverlaps(solve(1, { obstacles: [grid] }).result.placements, [compact]), 0);

  const { fresh, freshDrawn } = beforeAndAfter(grid, compact);
  assert.equal(fresh.result.menuOverlaps, 0);
  assert.equal(fresh.result.overlaps, 0);
  // The lower four rows, which the fold took down.
  const vacated = { x: grid.x, y: grid.y - grid.halfHeight / 2,
    halfWidth: grid.halfWidth, halfHeight: grid.halfHeight / 2 };
  assert.deepEqual(freshDrawn.filter(entry => hits(entry.rect, vacated)).map(entry => entry.id).sort(),
    ['gar1-d', 'nop10-f']);
  assert.equal(fresh.result.placements.find(entry => entry.id === 'gar1-d').offsetX, 0);
});

test('the same column solved twice is the same layout, to the offset', () => {
  // The no-jitter rule the re-solve is debounced for. A redraw that leaves the
  // rectangle where it was must not move a single plate, or the names would
  // swim every time the status line changed.
  const menu = menuRectAtSeat();
  const first = solve(1, { obstacles: [menu] }).result.placements;
  const again = solve(1, { obstacles: [menuRectAtSeat()] }).result.placements;
  assert.equal(first.length, again.length);
  for (let index = 0; index < first.length; index++) {
    assert.equal(again[index].id, first[index].id);
    assert.equal(again[index].offsetX, first[index].offsetX);
    assert.equal(again[index].offsetY, first[index].offsetY);
    assert.equal(again[index].sizeScale, first[index].sizeScale);
    assert.equal(again[index].alpha, first[index].alpha);
  }
});


test('the device silhouette leaves a one-plate-high band at the resting seat', () => {
  const device = { x: 0.02, y: 0.092, halfWidth: 0.549, halfHeight: 0.42 };
  // The old 3.6 m / 50 degree seat, six degrees above the eye. Sizing is
  // exactly xrLabelSizing: distance capped at 3 m, measured-seat gain 1.3.
  const distance = 3.6 / (2 * Math.tan(25 * Math.PI / 180)) * Math.cos(6 * Math.PI / 180);
  const characterUnits = labelCharacterUnits({ sizeFactor: labelSizeFactor({
    distanceMeters: 3, cameraScale: 1, characterDegrees: LABEL_CHARACTER_DEGREES.comfortable,
  }) * componentLabelHardwareGain(1.8, { measuredMeters: distance }) });
  const names = platedChapter(1);
  const measured = measurePlateSeat({
    plates: names.map(part => ({ ...part, anchor: [0, 0, -distance] })),
    subject: { anchor: [0, 0, -distance], radius: 1 },
    eye: [0, 0, 0], target: [0, 0, -1], characterUnits,
  });
  const band = measured.band;
  // One plate HEIGHT plus the solver gap, on every side including the left and
  // right. Reserving the widest NAME at the sides cost a third of the field.
  const tallest = Math.max(...names.map(part => plateHalfExtents({ text: part.text, characterUnits }).halfHeight));
  const reserve = (2 * tallest + PLATE_GAP_EM * characterUnits) / distance;
  assert.ok(Math.abs(band.x - reserve) < 1e-12);
  assert.ok(Math.abs(band.y - reserve) < 1e-12);
  const fit = capPlateSeat({ scale: 1, metersAcross: 3.6 }, ({ scale }) =>
    plateSeatLimits({ silhouette: { ...device, halfWidth: device.halfWidth * scale,
      halfHeight: device.halfHeight * scale }, band }));
  const subject = fit.plateSeat.silhouette;
  assert.ok(Math.abs(subject.x) + subject.halfWidth + band.x <= PLATE_FIELD.halfWidth);
  assert.ok(Math.abs(subject.y) + subject.halfHeight + band.y <= PLATE_FIELD.halfHeight);
  assert.ok(Math.abs(subject.x) + subject.halfWidth + band.x > PLATE_FIELD.halfWidth - 1e-9,
    'the seat keeps all the width the band permits');
  // Retain the shipped ten-part shape and names, calibrated to the recorded
  // rectangle. The measured device blocker is deliberately taller than the
  // approximate lab geometry; do not substitute the easier lab silhouette.
  const projected = names.map(part => ({ ...part,
    x: part.anchor[0] / (SEAT.eye[2] - part.anchor[2]),
    y: part.anchor[1] / (SEAT.eye[2] - part.anchor[2]),
    radius: part.radius / (SEAT.eye[2] - part.anchor[2]) }));
  const original = partsSilhouette(projected);
  const plates = projected.map(part => ({ ...part,
    anchor: [(device.x + (part.x - original.x) * device.halfWidth / original.halfWidth * fit.scale) * distance,
      (device.y + (part.y - original.y) * device.halfHeight / original.halfHeight * fit.scale) * distance, -distance],
    radius: part.radius * fit.scale * distance,
  }));
  const result = layoutComponentPlates({ plates, subject,
    eye: [0, 0, 0], target: [0, 0, -1], characterUnits,
    minSizeScale: 1, field: PLATE_FIELD,
    obstacles: [menuRectAtSeat()],
  });
  assert.equal(result.overlaps, 0);
  assert.equal(result.subjectOverlaps, 0);
  assert.equal(result.offGlass, 0);
  assert.equal(result.menuOverlaps, 0);
  // The band is one plate high, so a name far wider than it is tall no longer
  // fits beside a seat this wide and the plates take the slots above and below.
  // What this guards is that they are still SPREAD: the heap a device run
  // found was ten on one side with leaders the height of the view.
  const occupied = ['left', 'right', 'above', 'below'].filter(side => result.sides[side] > 0);
  assert.ok(occupied.length >= 2, JSON.stringify(result.sides));
  assert.ok(Math.max(...occupied.map(side => result.sides[side])) <= plates.length - 3,
    JSON.stringify(result.sides));
  // 11.95 em here against 6.85 with the full-width band: a seat this much
  // wider pushes each plate further from its part before it finds a free slot.
  // That is the price of the size that was asked for, not a solver fault, and
  // the bound still catches a plate running the height of the view.
  assert.ok(result.leaderEm < 13, `mean leader ${result.leaderEm}`);
  console.log('plate-aware device seat', JSON.stringify({ band, degrees: fit.plateSeat.viewDegrees,
    scale: fit.scale, silhouette: subject, sides: result.sides, leaderEm: result.leaderEm }));
});

test('the plate seat preserves small subjects and remeasures perspective at the scale cap', () => {
  const measure = ({ scale }) => plateSeatLimits({
    silhouette: { x: 0, y: 0.105, halfWidth: 0.4 * scale, halfHeight: 0.3 * scale },
    band: { x: 0.3 + 0.01 * scale, y: 0.05 },
  });
  const small = { scale: 0.4, metersAcross: 0.5 };
  assert.equal(capPlateSeat(small, measure).scale, small.scale);
  const large = capPlateSeat({ scale: 4, metersAcross: 5 }, measure);
  assert.ok(measure(large).factor >= 1);
  assert.ok(measure({ scale: large.scale + 1e-8 }).factor < 1);
});

test('the plate seat fits a large coordinate source below the former quarter-scale floor', () => {
  const measure = ({ scale }) => plateSeatLimits({
    silhouette: { x: 0, y: 0, halfWidth: 20 * scale, halfHeight: 10 * scale },
    band: { x: 0.05, y: 0.05 },
  });
  const fitted = capPlateSeat({ scale: 0.2, metersAcross: 8 }, measure);
  assert.ok(fitted.scale > 0 && fitted.scale < 0.25);
  assert.ok(measure(fitted).factor >= 1);
  assert.ok(measure({ scale: fitted.scale + 1e-8 }).factor < 1);
});


test('seat measurement uses the solver part discs and plate depths unchanged', () => {
  const plates = platedChapter(1);
  const sizing = chapterSizing(1);
  const measured = measurePlateSeat({ plates, subject: subjectAt(1), ...SEAT,
    characterUnits: sizing.characterUnits });
  const solved = restingSolve(1).result;
  assert.deepEqual(measured.silhouette, solved.subject);
  for (const plate of plates) {
    const depth = SEAT.eye[2] - plate.anchor[2];
    const half = plateHalfExtents({ text: plate.text, characterUnits: sizing.characterUnits });
    const gap = PLATE_GAP_EM * sizing.characterUnits / depth;
    assert.ok(measured.band.x >= 2 * half.halfHeight / depth + gap);
    assert.ok(measured.band.y >= 2 * half.halfHeight / depth + gap);
  }
});

test('a stand-off puts the plate on the pushed depth: offsets, extents and rects follow text.vert', () => {
  // The eye at the origin looks down -z; anchors 343 scene
  // units out, pushed 94.9 toward the eye like the telomerase entry plates.
  const eye = [0, 0, 0], target = [0, 0, -1], characterUnits = 9.456, standoff = 94.9;
  const measureText = text => text.length * 0.55;
  const plates = [
    { id: 'gar1-d', text: 'GAR1 1', anchor: [10, 20, -343], radius: 30 },
    { id: 'dyskerin-c', text: 'dyskerin 1', anchor: [16, 24, -343], radius: 30 },
  ];
  assert.equal(plateDrawDepth([0, 0, -343], 343, 0), 343);
  assert.equal(plateDrawDepth([0, 0, -343], 343, 94.9), 343 - 94.9);
  const ahead = plateDrawDepth([10, 20, -343], 343, standoff);
  assert.ok(Math.abs(ahead - 343 * (1 - standoff / Math.hypot(10, 20, 343))) < 1e-9);
  const pushed = layoutComponentPlates({ plates, eye, target, characterUnits, measureText, standoff });
  const flat = layoutComponentPlates({ plates, eye, target, characterUnits, measureText });
  assert.equal(pushed.overlaps, 0);
  for (const plate of plates) {
    const depth = 343, drawDepth = plateDrawDepth(plate.anchor, depth, standoff);
    const place = pushed.placements.find(entry => entry.id === plate.id);
    // The record carries both depths, so an in-place update can convert its
    // half-pixel tolerance at the depth the offsets are divided by.
    assert.equal(place.depth, depth);
    assert.ok(Math.abs(place.drawDepth - drawDepth) < 1e-9);
    // The shader lands `offset / drawDepth` from the anchor, and the solver's
    // reported rectangle is that landing, not `offset / depth`.
    assert.ok(Math.abs(place.rect.x - (plate.anchor[0] / depth + place.offsetX / drawDepth)) < 1e-9);
    assert.ok(Math.abs(place.rect.y - (plate.anchor[1] / depth + place.offsetY / drawDepth)) < 1e-9);
    const flatPlace = flat.placements.find(entry => entry.id === plate.id);
    // Pushed plates are drawn bigger by depth / drawDepth, and the solver knows it.
    assert.ok(Math.abs(place.rect.halfWidth / flatPlace.rect.halfWidth - depth / drawDepth) < 1e-9);
    assert.ok(Math.abs(place.rect.halfHeight / flatPlace.rect.halfHeight - depth / drawDepth) < 1e-9);
  }
  // Read on the anchor depth, as the record used to, the same emitted offsets
  // land only drawDepth / depth of the way to where the shader draws them:
  // the inverse of the 1.38 the telomerase captures showed.
  const rects = drawnPlateRects({ plates, placements: pushed.placements, eye, target, characterUnits, measureText });
  const index = pushed.placements.findIndex(entry => entry.moved);
  assert.ok(index >= 0, 'one plate fanned');
  const place = pushed.placements[index], anchor = plates[index].anchor;
  const travel = Math.hypot(place.rect.x - anchor[0] / 343, place.rect.y - anchor[1] / 343);
  const misread = Math.hypot(rects[index].rect.x - anchor[0] / 343, rects[index].rect.y - anchor[1] / 343);
  assert.ok(Math.abs(misread / travel - plateDrawDepth(anchor, 343, standoff) / 343) < 1e-9, `${misread / travel}`);
});
