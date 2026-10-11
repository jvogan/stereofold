/**
 * The density tier's lens band, held without a headset.
 *
 * In the headset the map seated at ~18 % of the lens because the framing was
 * solved from the grid cell's 585 A sphere. The fix measures the density
 * (307 A sphere, iso-box corners) and solves from that, under a whole-map
 * ceiling of 0.55. These drive the same `focusPlacement` the headset solves,
 * with the measured aspect of EMD-6347 (301 x 301 x 443 A), and assert the
 * band: measured, centred, inside 0.55, and never smaller than the 0.40 floor.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { focusPlacement } from './focus-placement.mjs';
import { PLATE_CLEARANCE_LENS, SUBJECT_CENTRE_LENS, SUBJECT_WHOLE_LENS_CEILING, VOLUME_WHOLE_LENS_CEILING,
  lensRectFromPoints, lensRectsOverlap, viewBasis, volumeMenuAvoidance } from './plate-standoff.mjs';
import { createToolbarPanel, toolbarCaptionPoints, toolbarDrawnMenuPoints,
  toolbarPlatePoints } from './spatial-toolbar-geometry.mjs';

/** The measured EMD-6347 aspect as an axis-aligned iso box: half extents. */
const HALF = [150.5, 150.5, 221.8];
const boxCorners = [];
for (const x of [-HALF[0], HALF[0]])
  for (const y of [-HALF[1], HALF[1]])
    for (const z of [-HALF[2], HALF[2]]) boxCorners.push([x, y, z]);

const headInRoom = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1.6, 0, 1];
const renderFromRoom = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const placement = { rotation: [0, 0, 0], translation: [0, 0, 0], scale: 1 };
const scene = { headInRoom, renderFromRoom, cameraScale: 0.9 / 307.4, placement,
  center: [0, 0, 0], radius: 307.4, targetCenter: [0, 0, 0], targetRadius: 307.4,
  framing: 'fill', wholeStructure: true, minExtentFraction: 0.68 };

test('a measured whole-map chapter lands inside the 0.55 ceiling, centred', () => {
  assert.equal(VOLUME_WHOLE_LENS_CEILING, 0.55);
  const plan = focusPlacement({ ...scene,
    subjectPoints: boxCorners, assemblyPoints: boxCorners,
    wholeSubjectCeiling: VOLUME_WHOLE_LENS_CEILING });
  assert.equal(plan.standoff.measured, true);
  assert.equal(plan.standoff.limited, 'lens-ceiling');
  const wide = plan.standoff.assembly.subjectFraction;
  assert.ok(wide <= VOLUME_WHOLE_LENS_CEILING + 1e-9, `whole map spans ${wide} of the lens`);
  assert.ok(wide >= 0.4, `whole map spans only ${wide} of the lens`);
  assert.equal(plan.standoff.frame.centred, true);
  assert.equal(plan.standoff.frame.overlap, false);
  // The frame shares a volume chapter records are the same rectangles an
  // atomic chapter records: the ring reads them, not the tier.
  assert.ok(plan.standoff.frame.subject && plan.standoff.frame.subject.right > plan.standoff.frame.subject.left);
});

test('without the volume ceiling the call is still bounded by the atomic whole', () => {
  // The override is what NAMES the 0.55 line for a volume caller: the
  // identical call under the default whole-structure ceiling is bounded by
  // the atomic whole instead. That was written against an atomic whole of
  // 0.70; the same constant has since been retuned to 0.55 (the drawn wall
  // lands about there), so the two ceilings
  // coincide today. Both named constants stay — a volume caller passes its
  // own ceiling, and the atomic whole still bounds the default call.
  // And the ceiling now bounds the DRAWN width, so this is the
  // number to read it off. `subjectFraction` is the on-axis grant, and for this
  // box — 443 A deep behind a 301 A face — the two are 1.73 apart: a grant of
  // 0.315 is what draws 0.55. Asserting the band on the grant would now be
  // asserting that the wearer sees 0.95 of the lens.
  const plan = focusPlacement({ ...scene, subjectPoints: boxCorners, assemblyPoints: boxCorners });
  const granted = plan.standoff.assembly.subjectFraction;
  const wide = plan.standoff.frame.drawn.whole;
  assert.ok(granted <= SUBJECT_WHOLE_LENS_CEILING + 1e-9,
    `default grants ${granted}, past the atomic whole ${SUBJECT_WHOLE_LENS_CEILING}`);
  assert.ok(wide <= SUBJECT_WHOLE_LENS_CEILING + 1e-9,
    `default draws ${wide}, past the atomic whole ${SUBJECT_WHOLE_LENS_CEILING}`);
  assert.ok(wide >= 0.4, `default draws only ${wide}`);
});

test('a sphere-measured caller is unmeasured and uncapped, as before', () => {
  const plan = focusPlacement({ ...scene, wholeSubjectCeiling: VOLUME_WHOLE_LENS_CEILING });
  assert.equal(plan.standoff.measured, false);
});

/**
 * The earlier framing seated every volume chapter clear of the caption and
 * INTO the menu: 6,260 map pixels over Talk and Play.
 * The caption dodge lowers a tall subject under the caption glass,
 * which is where the menu column stands — and nothing ever dodged the menu.
 * A volume chapter now seats clear of both plates: the caption first, then
 * the menu sidestep, and the ring records both (`frame.share`, `frame.menu`).
 *
 * The panel below is the shipped lesson layout — Talk/Play/Next/Menu under a
 * three-line caption — read off its real geometry, not typed in. The chapters
 * are driven exactly as the headset drives them: the measured iso-box corners
 * of EMD-6347, the volume ceiling, the authored placement rotation.
 */
const MAP_HEAD = { transform: { matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1.6, 0, 1],
  position: { x: 0, y: 1.6, z: 0 } } };
const MAP_EYE = [0, 1.6, 0];
const MAP_BASIS = viewBasis([0, 0, -1]);
function mapPanel() {
  return createToolbarPanel({ head: MAP_HEAD,
    rows: [{ label: 'Talk' }, { label: 'Play' }, { label: 'Next' }, { label: 'Menu' }],
    readout: [{ text: 'Hollow tube' }, { text: 'Scene 4 / 5' }, { text: 'Look down its length' }],
    status: 'Listening…' });
}
/** What the headset's own focusSelection hands the solver for a volume chapter. */
function driveVolumeChapter({ rotation, corners = boxCorners, withMenu = true }) {
  const panel = mapPanel();
  const plates = toolbarPlatePoints(panel);
  const captions = toolbarCaptionPoints(panel);
  const menus = toolbarDrawnMenuPoints(panel);
  assert.ok(plates.length > 40 && captions.length > 0 && menus.length > 0,
    'the panel offered plate, caption and menu points to seat against');
  const plan = focusPlacement({ headInRoom, renderFromRoom, cameraScale: 0.9 / 307.4,
    placement: { rotation, translation: [0, 0, 0], scale: 1 },
    center: [0, 0, 0], radius: 307.4, targetCenter: [0, 0, 0], targetRadius: 307.4,
    framing: 'fill', wholeStructure: true, minExtentFraction: 0.68,
    subjectPoints: corners, assemblyPoints: corners,
    platePoints: plates, captionPoints: captions,
    ...(withMenu ? { menuPoints: menus, avoidMenu: true } : {}),
    wholeSubjectCeiling: VOLUME_WHOLE_LENS_CEILING });
  return { plan, plates, captions, menus };
}
/** The chapter-4 view: a steep-oblique look down the tube axis. */
const SITE_ROTATION = [-20, 10, 0];
/**
 * What clipping 75 leaves drawable, modelled in the molecular frame: the
 * camera slab keeps the central ~154 A (25 % of the 307 A scene radius either
 * side of the target) and removes the near and far walls past it. The solver
 * still measures the full iso box — clipping is appearance, not bounds — so
 * the full-box seat must already band; this proves the drawn remainder bands
 * with it rather than against it.
 */
const slabCorners = [];
for (const x of [-HALF[0], HALF[0]])
  for (const y of [-HALF[1], HALF[1]])
    for (const z of [-77, 77]) slabCorners.push([x, y, z]);

function assertVolumeSeat({ plan, captions, menus }, label) {
  const frame = plan.standoff.frame;
  assert.equal(plan.standoff.measured, true, `${label} solved from the measured extent`);
  // The diagnostics ring records these numbers so they can be read back.
  assert.ok(frame.share && frame.menu, `${label} recorded frame.share and frame.menu`);
  assert.ok(frame.share.wide <= VOLUME_WHOLE_LENS_CEILING + 1e-9,
    `${label} draws ${frame.share.wide.toFixed(3)} of the lens, past the 0.55 ceiling`);
  assert.ok(frame.share.wide >= 0.4 - 1e-9,
    `${label} draws only ${frame.share.wide.toFixed(3)} of the lens`);
  assert.equal(frame.centred, true, `${label} seated at ${frame.subject.x.toFixed(3)} of the lens`);
  assert.ok(Math.abs(frame.subject.x) <= SUBJECT_CENTRE_LENS + 1e-9);
  assert.equal(frame.overlap, false, `${label} still touches the caption (move ${frame.move})`);
  assert.equal(frame.menu.overlap, false, `${label} still touches the menu (move ${frame.menu.move})`);
  // And the rectangles agree with the record, read off the real panel geometry.
  const menuRect = lensRectFromPoints({ points: menus, origin: MAP_EYE, basis: MAP_BASIS });
  const captionRect = lensRectFromPoints({ points: captions, origin: MAP_EYE, basis: MAP_BASIS });
  assert.equal(lensRectsOverlap(frame.subject, menuRect, PLATE_CLEARANCE_LENS - 1e-9), false,
    `${label} subject rect crosses the menu rect`);
  assert.equal(lensRectsOverlap(frame.subject, captionRect, PLATE_CLEARANCE_LENS - 1e-9), false,
    `${label} subject rect crosses the caption rect`);
}

test('a volume chapter with clipping bands inside 0.55, centred, clear of caption and menu', () => {
  // The solver seats the full measured box: clipping never reaches it.
  assertVolumeSeat(driveVolumeChapter({ rotation: SITE_ROTATION }), 'the full-box seat');
  // The drawn remainder — the central slab the clip leaves — bands with it.
  assertVolumeSeat(driveVolumeChapter({ rotation: SITE_ROTATION, corners: slabCorners }), 'the clipped seat');
});

test('an end-on volume chapter holds the ceiling without touching the menu', () => {
  assertVolumeSeat(driveVolumeChapter({ rotation: [0, 0, 0] }), 'the end-on seat');
});

test('a side-on volume chapter holds the ceiling without touching the menu', () => {
  assertVolumeSeat(driveVolumeChapter({ rotation: [0, 250, 0] }), 'the side-on seat');
});

test('without the menu half a volume chapter keeps the caption-only seat', () => {
  // The menu dodge is opt-in per caller: an atomic-shaped call is untouched,
  // and the record says no menu was seated against.
  const { plan } = driveVolumeChapter({ rotation: SITE_ROTATION, withMenu: false });
  // `frame.menu` is always present; "no menu was seated against" is its
  // rectangle and its volume round both being null, which is what this call
  // must leave behind.
  assert.equal(plan.standoff.frame.menu.rect, null);
  assert.equal(plan.standoff.frame.menu.volume, null);
  assert.ok(plan.standoff.frame.share.wide <= VOLUME_WHOLE_LENS_CEILING + 1e-9);
});

test('volumeMenuAvoidance sidesteps a lowered map beside the menu at full size', () => {
  const menu = { left: -0.85, right: -0.5, bottom: -0.44, top: 0.11 };
  const moved = volumeMenuAvoidance({ subject: { x: 0, y: -0.276, halfWidth: 0.5, halfHeight: 0.45 }, menu });
  assert.equal(moved.move, 'sidestep');
  assert.equal(moved.shrink, 1);
  assert.equal(moved.centred, true);
  assert.equal(moved.overlap, false);
  assert.ok(moved.x > 0 && moved.x <= SUBJECT_CENTRE_LENS + 1e-9);
  assert.equal(moved.y, -0.276, 'the sidestep never spends height');
});

test('volumeMenuAvoidance spends size before centre when the menu is wide', () => {
  // The shipped menu leaves no full-size centred seat beside it for a 0.57
  // subject: the sidestep buys the seat with size and stays on the centre line.
  const menu = { left: -0.85, right: -0.4155, bottom: -0.44, top: 0.11 };
  const moved = volumeMenuAvoidance({ subject: { x: 0, y: -0.276, halfWidth: 0.571, halfHeight: 0.514 },
    menu, shrinkFloor: 0.7 });
  assert.equal(moved.move, 'sidestep+shrink');
  assert.ok(moved.shrink < 1 && moved.shrink >= 0.7);
  assert.equal(moved.centred, true);
  assert.equal(moved.overlap, false);
});

test('volumeMenuAvoidance leaves a clear subject alone and passes an empty menu through', () => {
  const menu = { left: -0.85, right: -0.5, bottom: -0.44, top: 0.11 };
  const still = volumeMenuAvoidance({ subject: { x: 0.3, y: -0.5, halfWidth: 0.2, halfHeight: 0.2 }, menu });
  assert.equal(still.move, 'none');
  assert.equal(still.shrink, 1);
  const empty = volumeMenuAvoidance({ subject: { x: 0, y: 0, halfWidth: 0.5, halfHeight: 0.5 }, menu: null });
  assert.equal(empty.move, 'none');
  assert.equal(empty.overlap, false);
});
