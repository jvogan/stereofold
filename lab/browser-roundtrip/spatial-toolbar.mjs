import { MeshBuilder } from 'molstar/lib/mol-geo/geometry/mesh/mesh-builder.js';
import { Mesh } from 'molstar/lib/mol-geo/geometry/mesh/mesh.js';
import { TextBuilder } from 'molstar/lib/mol-geo/geometry/text/text-builder.js';
import { Text } from 'molstar/lib/mol-geo/geometry/text/text.js';
import { Shape } from 'molstar/lib/mol-model/shape.js';
import { ShapeRepresentation } from 'molstar/lib/mol-repr/shape/representation.js';
import { Color } from 'molstar/lib/mol-util/color/index.js';
import { hitToolbarFootprint, hitToolbarGlass, toolbarPressDecision } from './spatial-toolbar-wake.mjs';
import { toolbarAimRay, toolbarMissTarget } from './spatial-aim-hook.mjs';
import { MENU_IDLE_ALPHA, MENU_PLAY_ALPHA, menuAlpha, STATE_PLATE_STYLE, toolbarDoneTextProps, toolbarPlateProps, toolbarTextProps } from './spatial-toolbar-contrast.mjs';
import { EPSILON, MENU_SEAT_DRIFT_DEGREES, MENU_SEAT_DRIFT_MS, SPATIAL_TOOLBAR_LAYOUT, createToolbarPanel, hitToolbarPanel, seatYawDriftDegrees, toolbarBackingOutline, toolbarLayoutForDepthRange, toolbarLayoutForOutboard, toolbarLayoutForStandoff, toolbarCaptionPoints, toolbarDrawnMenuPoints, toolbarMenuPoints, toolbarMenuRowPoints, toolbarPlateOutline, toolbarPlatePoints, toolbarSeatBasis, toolbarStandoffMeters } from './spatial-toolbar-geometry.mjs';
import { createSpatialToolbarGestureTracker, createToolbarPointerTracker } from './spatial-toolbar-gesture.mjs';
import { shouldShowRoomWelcome, spatialToolbarRows } from './spatial-toolbar-content.mjs';
import { growthPageRow, growthTierFromLessonId, tierCaptionName } from './growth-caption.mjs';
import { captionExpanded, latchedStandoff } from './wearer-placement.mjs';
import { ENTRY_MENU_OUTBOARD_FACTORS, entryMenuSeat, menuSeatClears } from './entry-menu-seat.mjs';
import { menuSeatReceipt } from './menu-seat-receipt.mjs';
import { measureEntryStandoff, prepareEntryStandoff } from './entry-standoff.mjs';
import { getFontAtlas } from 'molstar/lib/mol-geo/geometry/text/font-atlas.js';
import { nextViewerPose } from './xr-viewer-pose.mjs';
import { menuSeatWithinView } from './menu-view-band.mjs';
import { applyMatrix4, invertMatrix4 } from './room-lock.mjs';
import { blindVisibility } from './xr-visibility.mjs';
import { holdOutcomeLine } from './outcome-line.mjs';
import { showTalkOutcome, showTalkProgress } from './talk-caption.mjs';
import { structureDescriptionPages, structureReadout } from './structure-subject.mjs';
import { placementPlateLines } from './placement-report.mjs';
import { clampMenuDragOffset, menuDragStep, menuGripDragStep, menuRelocationCandidates } from './menu-relocation.mjs';
import { GRIP_RELEASE, GRIP_TRACKING_GRACE_MS, TRIGGER_TRACKING_GRACE_MS } from './xr-manipulate.mjs';
import { TOOLBAR_MIN_HEAD_CLEARANCE_METERS, toolbarHeadClearance } from './spatial-toolbar-geometry.mjs';

/**
 * The two rules this file holds the wearer to.
 *
 * 1. The menu's stand-off is LATCHED (`latchedStandoff`). It is measured once,
 *    when the menu is seated — a fresh entry, the Move menu row, Reset view —
 *    and then held, whatever the structure does. Every chapter reframes the
 *    structure and every grab moves it, and re-measuring on both moved the menu
 *    out from under the wearer mid-lesson.
 *
 * 2. The caption plate shows its full narration text for `CAPTION_FULL_MS`
 *    (4000 ms, in `wearer-placement.mjs`) after a chapter starts, and whenever
 *    Talk is held or the lesson is playing itself. Outside that window it keeps
 *    the title and the page row — `CAPTION_SHORT_LINES` of payload — so the
 *    captions do not fill the view. Four seconds is the read time of a dozen
 *    words and the window `growth-caption.mjs` already gives a growth sentence,
 *    so the two agree.
 *
 * Both constants are re-exported here so a caller reading the toolbar does not
 * have to know which module owns the number.
 */
export { CAPTION_FULL_MS, CAPTION_SHORT_LINES } from './wearer-placement.mjs';

const PALETTE = { text: 0xf2fdfc, panel: 0x050c11, border: 0x58dcc9 };
/**
 * One entry per plate style: the lit face and the chamfer around it.
 *
 * A text-only menu does not read as pressable in a headset. These are the
 * colours that answer that: glass dark enough to sit over a bright molecule,
 * a face clearly lighter than the glass it sits on, and an edge light enough
 * to show where a button ends. `accent` marks the primary action of a state,
 * `state` a row that only reports and cannot be pressed.
 */
const PLATE_STYLES = Object.freeze({
  backing: { face: 0x081218, edge: 0x33606b },
  action: { face: 0x2a4d5a, edge: 0x77bcc7 },
  accent: { face: 0x1f8189, edge: 0xa6f2e6 },
  // The recessed chip's fill lives in `spatial-toolbar-contrast.mjs`
  // (`STATE_PLATE_STYLE`), raised with its label so Done reads on a
  // passthrough wall. Still flat and dark, never a button.
  state: { ...STATE_PLATE_STYLE },
  hover: { face: 0x3fa0ab, edge: 0xcafaf0 },
  press: { face: 0x7ee6d6, edge: 0xffffff },
});
const STYLE_ORDER = Object.freeze(['backing', 'action', 'accent', 'state']);
/** Controller feedback for a claimed press; passive hover stays silent. */
const SELECT_PULSE = { intensity: 0.65, durationMs: 45 };
/** How long a pressed plate stays sunk and bright after the trigger closes. */
export const TOOLBAR_PRESS_MS = 150;
/**
 * How long a status line holds the reply card, in milliseconds.
 *
 * The floor is control feedback: `Applied · style +1` is read at a glance and
 * a longer hold is a stale plate. The ceiling is the longest a single
 * `say_to_headset` segment can legitimately sound, so no caller can pin the
 * card in front of the wearer indefinitely.
 */
export const STATUS_HOLD_MS = 3000;
export const STATUS_MAX_HOLD_MS = 20_000;
/** Rows per `phase: 'rows'` diagnostic record. Matches `MAX_DETAIL_ITEMS` in
 * `headset-diagnostics.mjs`, which truncates any array past eight entries. */
const DIAGNOSTIC_ROW_CHUNK = 8;

export { SPATIAL_TOOLBAR_LAYOUT, createToolbarPanel, hitToolbarPanel, mapXrPointToScene, toolbarLayoutForDepthRange } from './spatial-toolbar-geometry.mjs';

const subtract = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scaleVector = (a, n) => [a[0] * n, a[1] * n, a[2] * n];
const crossProduct = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/**
 * How far in front of the plate plane a label is written. See `roomPanel`.
 * Half the widest glyph at the largest panel yaw, rounded up: 4.8 cm of type
 * is a 1.3 cm half-width, and sin 47 degrees of that is 0.95 cm.
 */
const TEXT_LIFT_METERS = 0.012;

/**
 * The stand-off band. `MARGIN` is the clearance kept outside the structure's
 * bounding sphere: the panel's own half-width plus a hand's breadth, so the
 * structure stops short of the glass rather than touching it. `STEP` rounds
 * every stand-off up, because the layout signature drives rebuilds and a
 * continuously varying seat would rebuild every frame. `RELEASE` is the slack
 * the structure has to give back before the panel comes in again, so a tour
 * spin or a scale ramp cannot make the menu breathe.
 */
const STANDOFF_MARGIN_METERS = 0.28, STANDOFF_STEP_METERS = 0.05, STANDOFF_RELEASE_METERS = 0.25;

/** Text properties shared by the panel's two text layers and its metrics. */
const TEXT_PROPS = Object.freeze({ attachment: 'middle-center', background: false, fontFamily: 'sans-serif', fontQuality: 2 });

/**
 * Write one string as one text entry per glyph, along a given direction.
 *
 * Mol* lays a string out in the glyph quad's own clip-space offsets, from a
 * single anchor point, and expands those offsets in a plane fixed to the
 * room's axes rather than to the surface the string is written on. A whole
 * label therefore leans out of its panel by half the label's width, and on
 * hardware the far half of every row ran behind its own plate: the wearer saw
 * `Tour menu` as `our menu` and `Move menu` as `ove menu`.
 *
 * One entry per glyph cuts that lean from half a label to half a letter, and
 * puts every letter where the panel says it should be rather than where the
 * room's axes put it. The advances come from the same font atlas Mol* lays
 * out with, so the spacing is the spacing it would have produced.
 *
 * @param builder Mol* `TextBuilder`
 * @param {string} text the string to write
 * @param {{origin: number[], right: number[], size: number, group: number}} where
 */
export function toolbarTextWidth(text) {
  const atlas = getFontAtlas(TEXT_PROPS);
  const outline = atlas.buffer / atlas.lineHeight;
  return Array.from(text).reduce((width, character) => width + atlas.get(character).nw - 2 * outline, 0);
}

function addGlyphs(builder, text, { origin, right, size, group }) {
  const atlas = getFontAtlas(TEXT_PROPS);
  // Mol*'s own width calculation, glyph for glyph: `text-builder.js` sums
  // `nw - 2 * outline` over the string and centres the result.
  const outline = atlas.buffer / atlas.lineHeight;
  const advances = Array.from(text, character => atlas.get(character).nw - 2 * outline);
  const width = advances.reduce((total, advance) => total + advance, 0);
  let cursor = -width / 2;
  for (let index = 0; index < text.length; index++) {
    const centre = (cursor + advances[index] / 2) * size;
    cursor += advances[index];
    if (text[index] === ' ') continue;
    builder.add(text[index], origin[0] + right[0] * centre, origin[1] + right[1] * centre,
      origin[2] + right[2] * centre, 0, size, group);
  }
}
function unit(vector, fallback = [0, 0, 1]) {
  const length = Math.hypot(...vector);
  return Number.isFinite(length) && length > EPSILON ? vector.map(value => value / length) : [...fallback];
}

/**
 * The direction "toward the wearer".
 *
 * Plate normals decide whether scene lighting shades the panel or leaves it a
 * flat silhouette. The panel normal points away from the wearer, into the
 * panel, so the outward face normal is its opposite. In room metres that is
 * the whole calculation; it used to take two mapped points a centimetre apart
 * because the geometry was baked into the molecule's coordinates first.
 */
function roomOutward(panel) {
  return unit(panel.normal.map(value => -value));
}

/**
 * One plate as a chamfered slab: a flat face, and a bevel running from the
 * face down and outward to the seated edge. Both outlines carry the same
 * point count, so they pair off around the perimeter. The face takes the
 * panel normal, and each bevel quad takes its own, which is what gives the
 * panel visible depth under scene lighting instead of a uniform wash.
 *
 * Every point here is XR room metres and stays that way. The presentation
 * layer carries the whole panel into scene units with one matrix each frame.
 */
function platePolygon(panel, target, { inset = 0, depth = 0, bevel = 0, lift = 0, segments = 4, backing = false } = {}) {
  const outline = options => (backing ? toolbarBackingOutline(panel, { ...options, plate: target }) : toolbarPlateOutline(panel, target, options));
  const face = outline({ inset: inset + bevel, depth: depth - lift, segments });
  const edge = outline({ inset, depth, segments });
  const centre = target.point.map((value, axis) => value - panel.normal[axis] * (lift - depth));
  if (!face.length || face.length !== edge.length) return undefined;
  return { face, edge, centre };
}

function roomPlates(panel) {
  const inset = panel.plateInsetMeters ?? 0;
  const depth = panel.plateDepthMeters ?? 0;
  const bevel = panel.bevelMeters ?? 0;
  const lift = panel.faceLiftMeters ?? 0;
  return panel.buttons.flatMap((button, index) => {
    // A state-only row is a recessed chip: no lift, no chamfer, so it cannot
    // read as something to press even from the corner of an eye.
    const flat = button.style === 'state';
    const polygon = platePolygon(panel, button,
      { inset, depth, bevel: flat ? bevel * 0.4 : bevel, lift: flat ? 0 : lift, segments: 3 });
    return polygon ? [{ index, label: button.label, style: button.style ?? 'action', ...polygon }] : [];
  });
}

/** The control glass and, above it, the caption glass. Both display-only. */
function roomBacking(panel) {
  return [[panel.backing, 'Spatial menu'], [panel.captionBacking, 'Spatial menu caption'], [panel.statusBacking, 'Reply status']].flatMap(([plate, label]) => {
    if (!plate) return [];
    const polygon = platePolygon(panel, plate, {
      inset: 0, depth: panel.backingDepthMeters ?? 0, bevel: panel.backingBorderMeters ?? 0,
      lift: (panel.backingBorderMeters ?? 0) * 0.5, segments: 5, backing: true,
    });
    return polygon ? [{ index: -1, label, style: 'backing', ...polygon }] : [];
  });
}

/**
 * The drawable panel, in XR room metres.
 *
 * Nothing here reads the camera. The panel is rebuilt only when its content or
 * its physical layout changes, and the presentation layer's per-frame matrix
 * converts it for the renderer. Text sizes are physical metres too, because
 * that layer gives the glyph shader the reciprocal camera scale.
 */
function roomPanel(panel) {
  if (!panel) return undefined;
  const outward = roomOutward(panel);
  // Text sits a few millimetres in front of the plane the plates are measured
  // from. A glyph quad is expanded about its own centre in a plane fixed to
  // the room's axes, not the panel's, so a glyph on a panel turned to face
  // the wearer leans out of the panel by up to half its own width. The lift
  // is that much clearance, so no letter can be eaten by the plate it is
  // written on.
  const lift = scaleVector(panel.normal, -TEXT_LIFT_METERS);
  const lifted = point => point.map((value, axis) => value + lift[axis]);
  return { ...panel, fontScene: panel.fontMeters, outward,
    plates: [...roomBacking(panel), ...roomPlates(panel)],
    buttons: panel.buttons.map(button => ({ ...button, scenePoint: lifted(button.point) })),
    statusScenePoint: lifted(panel.statusPoint),
    statusScenePoints: (panel.statusPoints ?? []).map(line => ({ ...line, scenePoint: lifted(line.point) })),
    readoutScenePoints: (panel.readoutPoints ?? []).map(line => ({ ...line,
      scenePoint: lifted(line.point), fontScene: panel.readoutFontMeters })) };
}

// The readout is wrapped once, by `createToolbarPanel`, at the width its glass
// has in the eye. This module used to hold a second wrapper at a fixed 22
// characters; both ran, and the caption came out in fragments.

/**
 * `placement` is the sentence the last placement receipt
 * produced (`placement-report.mjs`), and it rides directly above the structure
 * readout, in the same slot the journey feedback uses.
 *
 * It is never drawn on a plate that is already hidden: `captionCard: 'hidden'`
 * is the chapter saying the glass belongs to the molecule this step, and a
 * placement sentence is exactly the kind of line that rule exists to keep out.
 * Everything else about its lifetime belongs to the caller — the viewer clears
 * the note, this only draws whatever note is standing.
 */
/**
 * What the plate says when the journey chooser shuts.
 *
 * One sentence for both players. `tour-player.ts` and `experience-player.ts`
 * each write it from their own `closeMenu`, the way both already write
 * "Back to your view", and `caption-card.test.mjs` pins the three copies to
 * each other so a reworded one cannot go quiet on the headset instead.
 */
export const CHOOSER_CLOSED_LINE = 'Tour chooser closed';
/** How long that sentence stands before the resting caption comes back. */
export const CHOOSER_CLOSED_WINDOW_MS = 6_000;

/**
 * Whether a chooser-closed stamp is inside its reading window.
 *
 * The stamp and `nowMs` are both `performance.now()` — milliseconds since the
 * page loaded. A build that stamps a wall clock, or none at all, lands outside
 * the window rather than pinning the sentence to the plate forever: a missing
 * sentence is a smaller lie than one that never leaves.
 */
function chooserCloseIsFresh(closedAt, nowMs) {
  if (!Number.isFinite(closedAt) || !Number.isFinite(nowMs)) return false;
  const since = nowMs - closedAt;
  return since >= 0 && since < CHOOSER_CLOSED_WINDOW_MS;
}

/**
 * How long any status sentence may hold the title line.
 *
 * Every sentence in that slot is a reading window, not a state. The refusal
 * branch below had no window at all, and the chooser's window was read once,
 * inside `update()`, which nothing calls on a clock. On the Quest 2 on
 * `Tour chooser closed` was still the title 42 s after a 5861 ms
 * hold, and `This action belongs to a different structure.` held the plate
 * through a link loss and a recovery until a rendered colour change wrote a
 * different sentence over it. A sentence was retired only by another sentence.
 *
 * Six seconds is `CHOOSER_CLOSED_WINDOW_MS`, kept as one number: the wearer
 * reads these lines in the same slot at the same distance, and a refusal is not
 * owed longer than a notice.
 */
export const STATUS_LINE_WINDOW_MS = CHOOSER_CLOSED_WINDOW_MS;

/** Keep rollback diagnostics in the host receipt; the wearer needs its outcome. */
export function toolbarTourFeedback(tour) {
  const text = typeof tour?.feedback === 'string' ? tour.feedback : '';
  return tour?.feedbackError && /^Journey could not render: [\s\S]+ Previous view restored\.$/.test(text)
    ? 'Tour paused. Previous view restored.' : text;
}

/**
 * The transient sentence this readout would put in the title line, if any.
 *
 * It mirrors the branch order below exactly, so whoever times the sentence and
 * the code that draws it can never disagree about which one is standing.
 * `Restoring your view…` is deliberately absent: it is a live state that ends
 * when the navigation does, not a window.
 */
export function plateStatusSentence(tour) {
  if (!tour || typeof tour.feedback !== 'string' || !tour.feedback) return '';
  if (tour.feedbackError) return toolbarTourFeedback(tour);
  if (tour.navigating && tour.feedback === 'Restoring your view…') return '';
  if (tour.feedback === CHOOSER_CLOSED_LINE && tour.menuOpen !== true && tour.active !== true) return tour.feedback;
  if (tour.active === false && tour.feedback === 'Back to your view') return tour.feedback;
  return '';
}

export function tourReadout(tour, welcome, nowMs = (globalThis.performance?.now?.() ?? Date.now()),
  { placement, descriptionPage = 0, statusRetired = false } = {}) {
  const subject = welcome && typeof welcome === 'object' && typeof welcome.title === 'string' ? welcome : undefined;
  const placed = placementPlateLines(placement);
  // Whoever draws this plate holds the title sentence for its window on
  // the frame clock and says here when the window is spent. It is a latch and
  // not a second duration on purpose: the only clock that may measure a
  // wearer's reading time is the one that delivers the frames they read it in.
  const retired = statusRetired === true;
  if (tour?.feedbackError && tour.feedback && !retired) return [{ text: toolbarTourFeedback(tour), ...(subject ? { maxLines: 2 } : {}) }, ...placed, ...structureReadout(subject, { descriptionPage })];
  if (tour?.navigating && tour.feedback === 'Restoring your view…') return [{ text: tour.feedback, ...(subject ? { maxLines: 2 } : {}) }, ...placed, ...structureReadout(subject, { descriptionPage })];
  // The chooser used to shut in silence.
  //
  // Pressing Menu with the chooser open closes it — `menuOpen` false,
  // `selectedId` null — and on the Quest 2 the plate went
  // straight from the chooser's two lines back to the resting caption with no
  // sentence about it, read at 20 fps across the whole transition and again 13 s
  // later. The wearer was told
  // what opened and never what shut.
  //
  // It is a reading window, not a state: the sentence stands for
  // `CHOOSER_CLOSED_WINDOW_MS` from the stamp the player writes when it closes,
  // then the resting caption comes back on its own. A running lesson keeps its
  // chapter instead — closing the chooser hands that caption back, which is
  // itself the answer — so this only speaks where the plate was otherwise
  // silent.
  //
  // `chooserCloseIsFresh` reads the player's stamp; `retired` reads the
  // plate's own. Both must agree the sentence is still owed, because either
  // clock alone has been wrong on the device — the player's is a companion
  // timestamp, and the plate's window was never re-read once the sentence was
  // drawn.
  if (tour?.feedback === CHOOSER_CLOSED_LINE && tour.menuOpen !== true && tour.active !== true
    && chooserCloseIsFresh(tour.chapterStartedAt, nowMs) && !retired)
    return [{ text: tour.feedback }, ...placed, ...structureReadout(subject, { descriptionPage })];
  if (tour?.active === false && tour.feedback === 'Back to your view' && !retired) return [{ text: tour.feedback }, ...placed, ...structureReadout(subject, { descriptionPage })];
  if (tour?.chapterPreview) return [
    { text: `Preparing ${tour.chapterPreview.progress}`, maxLines: 2 },
    { text: tour.chapterPreview.title, maxLines: 3 },
    { text: tour.chapterPreview.bodyPage },
    ...placed,
  ];
  if (tour?.menuOpen) return [
    { text: tour.selectedTitle || 'Choose a journey', maxLines: 2 },
    { text: tour.budgetNotice || 'Next one chooses. Tour starts.', maxLines: 3, optional: true },
    ...placed,
    ...structureReadout(subject, { descriptionPage }),
  ];
  if (!tour?.selectedId || tour.active === false) return [...placed, ...structureReadout(subject, { descriptionPage })];
  if (tour.captionCard === 'hidden') return structureReadout(subject, { descriptionPage });
  const tourTitle = typeof tour.selectedTitle === 'string' ? tour.selectedTitle : 'Choose a lesson';
  const sceneTitle = typeof tour.title === 'string' ? tour.title : '';
  // The tier rides with the scene, persistently.
  //
  // Every growth tier is its own lesson, so each one opens at scene 1 and a
  // plain `Scene 1 / 5` row reads identically after every step, so the row
  // looks stuck. The tier name tells the steps apart
  // (`Protofilament 1/5` follows `Dimer 1/5`). The full name is always kept:
  // the caption glass wraps a long row instead of clipping it, so the menu
  // label budget never trims this row. A tier whose tour has not started yet
  // reads as its name alone. A lesson outside the growth run keeps its
  // `Scene n/m` row.
  let chapterProgress = typeof tour.progress === 'string' ? tour.progress : 'Lessons';
  const tier = growthTierFromLessonId(tour.selectedId);
  if (tier) {
    chapterProgress = (Number.isInteger(tour.step) && tour.step >= 0 && Number.isInteger(tour.total) && tour.total > 0)
      ? growthPageRow({ tier, scene: tour.step + 1, total: tour.total })
      : tierCaptionName(tier);
  }
  // Every entry goes to the geometry unwrapped. Wrapping here at a guessed 22
  // characters and letting `createToolbarPanel` wrap the result again at the
  // glass width produces ragged fragments (`Entry 9KJ6, an`, `SpCas9`). One
  // wrap, at the width the eye actually leaves the glass, is the fix.
  //
  // The middle line is the progress alone. With a ` · TEXT 1/2` tail it read
  // `Scene 3 / 5 · TEXT 1/2`, and at one bound line that tail was exactly what
  // the eye cut, leaving `Scene 3 / 5 · TEX…`. The page count is already on
  // the `Page 1/2` row for the texts that still page (a catalog lesson's
  // prose), so the token said nothing the row below did not, and cost the tail
  // of the line that did.
  //
  // Chapter title and narration own the reading window. Structure details and
  // progress yield first; dropping a prose page would lose words permanently
  // when autoplay advances to the next one. Use the same whole-text protection
  // as placement replies, inside the existing font and glass limits.
  const paged = Number.isSafeInteger(tour.bodyPageCount) ? tour.bodyPageCount > 1 : false;
  const bodyText = tour.bodyPage;
  // A prose page may fit the glass while ending mid-sentence: the rest was
  // already removed by tour-player's pagination, so the geometry cannot
  // discover that overflow. Mark continuation before its single wrap pass.
  const bodyContinues = paged
    && (tour.bodyPageIndex ?? 0) < tour.bodyPageCount - 1;
  const captionText = bodyContinues && bodyText ? `${bodyText.trimEnd()}…` : bodyText;
  const title = sceneTitle || tourTitle;
  const progress = chapterProgress;
  // Whether the plate may draw the whole spoken line this frame.
  //
  // `chapterStartedAt` is stamped by `tour-player.ts` on the SAME clock this
  // default reads — `performance.now()`, not `Date.now()`. A wall-clock stamp
  // compared against a since-page-load one is always in the future, which would
  // collapse every chapter caption the instant it arrived.
  const expanded = captionExpanded({
    talking: tour?.talking === true,
    playing: tour?.autoplay === true || tour?.playing === true,
    chapterStartedAt: tour?.chapterStartedAt,
    nowMs,
  });
  return [
    { text: title, whole: true },
    { text: progress, maxLines: 2, optional: true, dropRank: 4 },
    // A narrated scene sends its whole spoken line (`wearerPages` in
    // `tour-player.ts` pages only the fallback prose that still needs the
    // `Page n/m` row). Do not ellipsize here: the geometry wraps once, at the
    // width the eye leaves, and only its own bound may end the last line.
    // Outside the reading window the payload line is not shortened, it is
    // gone. A wrapped half-sentence is worse glass than the
    // title and the page row alone, and those two are what the wearer needs to
    // know where the lesson is. Replies never replace that chapter.
    ...(expanded && captionText ? [{ text: captionText, whole: true, optional: false }] : []),
    ...placed,
    ...structureReadout(subject, { descriptionPage }).map(line => ({ ...line, optional: true })),
  ];
}

/** One chamfered plate: a lit face, then the bevel quads around its edge. */
function addChamferedPlate(state, plate, outward, faceGroup, edgeGroup) {
  const { face, edge, centre } = plate;
  state.currentGroup = faceGroup;
  for (let index = 0; index < face.length; index++) {
    MeshBuilder.addTriangleWithNormal(state, centre, face[index], face[(index + 1) % face.length], outward);
  }
  state.currentGroup = edgeGroup;
  for (let index = 0; index < face.length; index++) {
    const next = (index + 1) % face.length;
    // The chamfer normal tilts outward and toward the wearer. Take it from
    // the quad itself and orient it forward, so a bevel is never lit as if
    // it faced into the panel.
    let normal = unit(crossProduct(subtract(face[next], face[index]), subtract(edge[index], face[index])), outward);
    if (normal.reduce((sum, value, axis) => sum + value * outward[axis], 0) < 0) normal = normal.map(value => -value);
    MeshBuilder.addTriangleWithNormal(state, face[index], face[next], edge[next], normal);
    MeshBuilder.addTriangleWithNormal(state, face[index], edge[next], edge[index], normal);
  }
}

/**
 * Every plate of the panel as one lit mesh: the backing glass, then one
 * chamfered slab per row. Groups run two per style, face then edge, in
 * `STYLE_ORDER`, so a single colour callback shades all of them.
 *
 * `previous` is the mesh a caller wants rebuilt in place. Mol* keys a
 * representation's GPU buffers off the mesh's own value cells, so writing into
 * the mesh it already holds is what lets `createOrUpdate` reuse one render
 * object instead of allocating another.
 */
function plateMesh(plates, outward, styles = STYLE_ORDER, previous) {
  const state = MeshBuilder.createState(plates.length * 192, plates.length * 96, previous);
  for (const plate of plates) {
    const slot = Math.max(0, styles.indexOf(plate.style));
    addChamferedPlate(state, plate, outward, slot * 2, slot * 2 + 1);
  }
  return MeshBuilder.getMesh(state);
}

/**
 * Group index to colour, for whichever style list built the mesh.
 *
 * Mol* hands a shape's colour, size and label callbacks a numeric group id,
 * not a location object. Reading `.group` off it yields undefined, every
 * comparison fails and the whole shape takes one colour, which is how the
 * rim and the fill used to render identically.
 */
function plateColor(groupId, styles) {
  const style = PLATE_STYLES[styles[Math.floor(groupId / 2)]] ?? PLATE_STYLES.action;
  return Color(groupId % 2 === 0 ? style.face : style.edge);
}

/** Draw properties for the hover plate. Constant, so they never force a rebuild. */
const HIGHLIGHT_PROPS = Object.freeze({ alpha: 0.97, doubleSided: true, ignoreLight: false });

/**
 * How solid the menu is while a lesson is playing itself.
 *
 * Taking the glass to a quarter lets the molecule outshine `Play`, but at a
 * quarter the type renders as a hollow SDF stroke on a white passthrough wall.
 * The numbers live in `spatial-toolbar-contrast.mjs`; the asleep state still
 * drops below idle, it just keeps a 70% dark card under filled white type.
 */
export { MENU_IDLE_ALPHA, MENU_PLAY_ALPHA, menuAlpha };

/**
 * How long a press keeps the whole menu up.
 *
 * A wearer who has just pressed something is using the menu, and taking it back
 * down under their hand is the one way this feature can be worse than no
 * feature. Twelve seconds is long enough to read the rows and press a second
 * one, and short enough that the menu is quiet again before the chapter is.
 */
export const MENU_QUIET_GRACE_MS = 12_000;

/**
 * Whether the menu should stand back for the lesson right now.
 *
 * This is deliberately not `tour.autoplay`. Walking the chapters with
 * `control_tour next` rather than letting them play leaves autoplay false
 * throughout, and the menu stays full-bright over every chapter. What the
 * wearer sees is a chapter, however it got there, so `active` is the state.
 *
 * Two things override it, both because the wearer is looking AT the menu:
 * the lesson chooser being open, and a press inside the grace window.
 */
export function menuStandsBack({ tour, now = 0, wokenAt = 0, graceMs = MENU_QUIET_GRACE_MS } = {}) {
  if (tour?.active !== true || tour?.menuOpen === true) return false;
  return !(wokenAt > 0 && now - wokenAt < graceMs);
}

/**
 * The hover plate, rebuilt into the geometry its representation already owns.
 *
 * Mol* passes the previous shape to this builder. Writing the new plate into
 * that shape's mesh is the whole reason the representation can be reused: the
 * render object's vertex, normal, group and index buffers are those same value
 * cells, so an update re-uploads them and no new object is allocated. Build a
 * fresh mesh instead and the render object keeps pointing at the old buffers.
 */
async function highlightShape(_runtime, { plate, style, outward, label }, _props, previous) {
  const styles = [style];
  return Shape.create('Stereofold toolbar highlight', {},
    plateMesh([{ ...plate, style }], outward, styles, previous?.geometry),
    groupId => plateColor(groupId, styles), () => 1, () => label);
}

function nextXrTick(session) {
  return new Promise(resolve => {
    let settled = false;
    const settle = value => { if (!settled) { settled = true; clearTimeout(timer); session.removeEventListener('end', end); resolve(value); } };
    const end = () => settle(false);
    const timer = setTimeout(() => settle(false), 250);
    session.addEventListener('end', end, { once: true });
    try { session.requestAnimationFrame(() => settle(true)); } catch { settle(false); }
  });
}

/** Ephemeral stock-Mol* XR toolbar; it delegates every molecular action. */
// `Mat4` stays in the signature because `immersive-session.mjs` and the tests
// pass it, and because a future control may need it again. The panel itself no
// longer inverts anything: it is built and held in XR room metres, and
// `presentation-scene.mjs` owns the one matrix that reaches the screen.
export function createSpatialToolbar({ plugin, canvas, presentation, session, space, Mat4, onAction = async () => {}, onActionIntent = () => {}, onActionError = () => {},
  getState = () => ({}), getEntryGeometry = () => ({}), getMolecularBounds = () => canvas.boundingSphereVisible, getDepthRange = () => ({}), onRepresentationChange = () => {}, onConsumeSelect = () => {},
  // The clock the title line's reading window is counted on. The page
  // owns it in production; a test that has to watch a six-second window close
  // supplies its own rather than waiting six seconds for it.
  now = () => (globalThis.performance?.now?.() ?? Date.now()) }) {
  // Compact controls leave the molecule the central view. Menu opens the rest.
  let representation, readoutRepresentation, plateRepresentation, stateRepresentation, hoverRepresentation, collapsed = true, mode = 'move', notice, panel, entryHead, actionChain = Promise.resolve(), sequence = 0, closed = false, inputLocked = false, renderedLayout, renderedContent, poseSync, seatedStandoff = 0, hidden = false;
  let relocationSeat, drawnPanelOptions;
  let menuDrag;
  // This is the translation actually on the render objects, including while a
  // released drag's replacement glyphs are still being built.
  let renderedOffset = [0, 0, 0];
  const appliedRoomOffsets = new WeakMap();
  function applyMenuRoomOffset(offset) {
    if (typeof presentation.setRoomOffset !== 'function') return;
    for (const target of [representation, readoutRepresentation, stateRepresentation, plateRepresentation]) {
      if (!target) continue;
      const previous = appliedRoomOffsets.get(target);
      if (previous && offset.every((value, axis) => value === previous[axis])) continue;
      // A fresh card always receives its offset. Keep our comparison separate
      // from both the drag's mutable array and the presentation's ownership.
      if (presentation.setRoomOffset(target, [...offset]) !== false) appliedRoomOffsets.set(target, [...offset]);
    }
  }
  let redrawAfterDrag;
  const gripReleaseRequired = new Set();
  let clearanceHidden = false;
  let actionEpoch = 0;
  // How many actions this toolbar has accepted onto its
  // chain. Read only by `aimSynthetic`, to tell a simulated press that fired
  // from one the hit test or a guard refused.
  let actionsAccepted = 0;
  const acceptsInput = () => !closed && !blindVisibility(session.visibilityState);
  // The menu's seat is latched for the session.
  //
  // `menuLatched` is false only while the seat is being taken; `seatReason`
  // names what asked for it (`entry`, `menu`, `reset`) and rides the ring with
  // the latch so a record can be read without guessing. `entryOutboard` is the
  // multiplier `entry-menu-seat.mjs` chose for `rightMeters` so the entry menu
  // clears the subject band; it is a LATCHED fact, not a live reading of the
  // tour, because recomputing it per frame would swing the menu inboard the
  // moment a chapter started — the very thing the latch exists to stop.
  let menuLatched = false, seatReason = 'entry', entryOutboard = 1;
  // The column count the seat in force was solved against, and the
  // row-per-column cap that solve settled on.
  //
  // `solvedColumns` is the count the solve was ASKED about, not the count it
  // chose, so a chapter whose rows have not changed asks nothing again. It is 0
  // at the entry seat and after every re-seat, so the first chapter of a lesson
  // always measures: the entry seat is taken against the resting row set and
  // knows nothing about the grid a chapter will draw. `menuFoldMaxRows` is the
  // fold `layout()` carries: capping rows per column puts the same rows in
  // fewer, taller columns, so the grid narrows without losing a row or changing
  // its type size.
  let solvedColumns = 0, menuFoldMaxRows;
  // A chapter's last depth sample can outlive its snapshot restore. Keep the
  // complete resting column, including its physical scale and fold, until the
  // player explicitly finishes. A later depth sample cannot revive that seat.
  let restingMenuSeat, restoredMenuLayout, tourSeatHeld = false, tourSeatRestorePending = false;
  // Whether Done's restore is still waiting for the
  // experience player to publish its completed reading, and how many rows the
  // preview that served the clearance solve measured on its way in.
  //
  // `tourSeatRestorePending` above is cleared by the commit that draws the
  // restored panel, because it is about seating that one draw. This latch is
  // about the whole window around it: `restoreJourneySeat` runs inside
  // `hydrate` and the player publishes only once `hydrate` has returned, so
  // every draw from the restore until that publication is a draw the finished
  // chapter is still on the state for. `restorePreviewRows` is remembered for
  // the transition record alone and never takes part in a draw.
  let donePresentationPending = false, donePresentationOf, restorePreviewRows;
  // Why the drawn panel last changed, for the plate solver.
  //
  // The name plates are solved against the menu column's rectangle, so every
  // committed redraw that moves or reshapes that rectangle owes them another
  // pass. `update` compares what it is about to draw against what is drawn and
  // names the difference here; `immersive-session.mjs` reads it and carries the
  // name into the `component-label-layout` ring record, so a hardware log says
  // which press moved the plates rather than only that something did.
  //
  // `renderedSeat` is the seat signature of the drawn panel and `renderedGrid`
  // is whether it was drawn folded. Both are undefined until the first draw,
  // which is the one that reports `seat`.
  let renderedSeat, renderedGrid, lastMenuMotion = [], menuReseatRequested = false, redrawAfterReseat;
  let hiddenMenuMotion = [];
  let seatedMenuPoints = [], hiddenMenuPoints = [], seatedViewPoints = [], latestViewerHead;
  // The chapter clock, on the same `performance.now()` base the
  // readout reads. Only a fallback: `tour-player.ts` stamps its own.
  let lastTourId, lastTourStep = -1, chapterStartedAt;
  const readoutNow = now;
  // The sentence standing in the title line, whether its
  // reading window is spent, and the hold that will spend it. The plate times
  // its own title because `update()` runs on notifications rather than on a
  // clock: a window written into `tourReadout` alone is evaluated at the draw
  // that put the sentence up and never again, which is how a six-second notice
  // was still the title line 42 s later.
  let plateStatus = '', plateStatusRetired = false, statusTiming = '', statusFirstFrame;
  globalThis.__stereofoldDiagnostics?.record?.('toolbar', { event: 'seat', latched: false, reason: 'entry' });

  /**
   * Age the standing title sentence by one presented frame, and retire it when
   * its reading window is spent.
   *
   * `syncPose` is the toolbar's per-frame hook, so this is measured in the
   * frames the wearer was actually shown: a session the system UI has taken
   * over delivers none of them, and a sentence that arrived during that is owed
   * six seconds the wearer can read rather than six seconds of a blank display.
   *
   * It costs one comparison while nothing is standing, and one clock read while
   * something is. The retirement itself only re-runs `update()`; `tourReadout`
   * is what decides the line is gone, so the drawn plate and the readout can
   * never disagree about it.
   */
  function ageStatusLine() {
    if (closed || !statusTiming || plateStatusRetired) return;
    const at = readoutNow();
    if (!Number.isFinite(statusFirstFrame)) { statusFirstFrame = at; return; }
    if (!(at - statusFirstFrame >= STATUS_LINE_WINDOW_MS)) return;
    plateStatusRetired = true;
    // The one ring entry that says a sentence left the glass, and how long the
    // wearer actually had it: `talk-caption-seat` records the hold a caption
    // was promised, and nothing recorded whether that promise was kept.
    globalThis.__stereofoldDiagnostics?.record?.('caption-retired', { surface: 'plate', text: statusTiming,
      holdMs: STATUS_LINE_WINDOW_MS, shownMs: Math.round(at - statusFirstFrame) });
    void update({ origin: 'status' }).catch(() => {});
  }

  /** Before any lesson has been chosen or started: the seat the wearer arrives at. */
  function isEntrySeat() {
    const tour = getState()?.tour;
    if (!tour) return true;
    // A preselected demo is still the resting entry (#34/#41, acceptance 5).
    // Only an active or displayed chapter has had its own framing pass.
    return tour.active !== true && !(Number.isSafeInteger(tour.step) && tour.step >= 0);
  }

  /**
   * Let the next frame take the seat again, and say why.
   *
   * `entryHead` is cleared only for the menu's own re-seat: that is the wearer
   * asking for the menu in front of them. A reset frees the STAND-OFF to be
   * measured again without teleporting the panel; `viewer.mjs` sends the menu
   * its own `recenter-menu` right after, which is what moves it.
   */
  function unlatchSeat(reason = 'reset', { reseat = reason !== 'reset' } = {}) {
    cancelMenuDrag();
    relocationSeat = undefined;
    restoredMenuLayout = undefined;
    menuLatched = false;
    seatReason = reason;
    entryOutboard = 1;
    solvedColumns = 0;
    menuFoldMaxRows = undefined;
    if (reseat) { entryHead = undefined; menuReseatRequested = true; }
    globalThis.__stereofoldDiagnostics?.record?.('toolbar', { event: 'seat', latched: false, reason });
  }

  /**
   * The tour state the caption rule needs, which the tour player does not
   * carry.
   *
   * `talking` is the wearer holding A/X or pressing Talk — any voice state that
   * has left `idle` — and `playing` is the lesson reading itself out. Both open
   * the caption plate to its full text, because both are the wearer asking to
   * be read to. `chapterStartedAt` prefers the tour player's own stamp and falls
   * back to when this toolbar first saw the chapter change, on the same clock.
   */
  function captionTour(state) {
    const tour = state?.tour;
    if (!tour) return tour;
    return { ...tour,
      chapterStartedAt: Number.isFinite(tour.chapterStartedAt) ? tour.chapterStartedAt : chapterStartedAt,
      talking: tour.talking === true || (typeof state?.voice?.state === 'string' && state.voice.state !== 'idle'),
      playing: tour.autoplay === true || tour.playing === true };
  }

  /**
   * The tour state the completed menu will draw against,
   * derived from the live one.
   *
   * Done's clearance solve runs inside `hydrate`, and the experience player
   * publishes its completed state only once `hydrate` has returned — the phase
   * order in `plugin/src/inspector.ts` is load-bearing and stays as it is. So
   * on a Done the state this toolbar reads still carries the chapter the
   * wearer has just finished, and a panel built from it has the chapter title,
   * the scene line and the wrapped narration on it: six readout lines the
   * completed menu never draws, and a plate ceiling 0.32 tangent higher than
   * the one that appears. `restoreJourneySeat` clears the saved view against
   * that ceiling, so a molecule that was never in the way is pushed down and
   * shrunk.
   *
   * Rather than wait for the player, apply the player's own ending here.
   * `finish()` drops the current chapter, shuts the chooser, stops autoplay
   * and resets the prose page, which leaves exactly the completed reading the
   * heartbeat publishes — `{step:-1,total:0,active:false,autoplay:false,
   * navigating:false}` (`tourHeartbeat`, `plugin/src/inspection-tour-client.ts`)
   * — with no chapter caption pending.
   *
   * The receipt sentence Done writes afterwards is deliberately not
   * synthesized. It is a timed status line rather than panel content: it
   * stands for `STATUS_LINE_WINDOW_MS` and then retires, and any other notice
   * can take the same slot long after this solve. What the preview owes the
   * solver is the panel that remains.
   */
  const COMPLETED_TOUR_READING = Object.freeze({ step: -1, total: 0, active: false, autoplay: false, navigating: false });
  function completedTourState(state) {
    const tour = state?.tour;
    if (!tour) return state;
    return { ...state, tour: { ...tour, ...COMPLETED_TOUR_READING,
      // What `finish()` clears: no lesson, no scene, no prose page, chooser shut.
      selectedId: undefined, selectedTitle: undefined, menuOpen: false, playing: false,
      title: '', progress: '', body: '', bodyPage: undefined, bodyPageIndex: 0, bodyPageCount: 0,
      canBack: false, canNext: false, chapterPreview: undefined, chapterStartedAt: undefined,
      // The sentence standing now is `Restoring your view…`, which the very
      // call this preview serves replaces the moment it returns.
      feedback: '', feedbackError: false } };
  }

  /**
   * Whether the published reading still belongs to a
   * chapter the experience player owns.
   *
   * The same four fields `update` already uses to decide that a tour is
   * running and the resting seat must be held, read in one place so the latch
   * that releases the completed presentation and the latch that holds the seat
   * cannot drift apart.
   */
  function tourStillRunning(tour) {
    return Boolean(tour && (tour.active || tour.autoplay || tour.navigating || tour.step >= 0));
  }

  /**
   * Which reading of the tour the player has published.
   *
   * The completed presentation is held against one published reading and no
   * longer. Any change to these five fields means the player has spoken — it
   * has finished, or it has moved on to another chapter — and either way the
   * state on the wire is now the one to draw. Without this a host that died
   * between Done and its heartbeat would leave the toolbar presenting a
   * completed menu over whatever came next.
   */
  function tourReadingSignature(tour) {
    return JSON.stringify([tour?.selectedId ?? null, tour?.step ?? null,
      tour?.active === true, tour?.autoplay === true, tour?.navigating === true]);
  }

  /**
   * The state every draw presents while Done's restore
   * is pending — the same derivation `placementPreview` measured.
   *
   * An earlier run gave the Done preview the completed menu, so the clearance solver
   * stopped clearing a chapter panel. It did not give it to the draw. Between
   * `restoreJourneySeat` and the player's completed reading the toolbar still
   * built its rows from the finished chapter, so the wearer's restored view
   * was cleared against 26 rows and had 27 drawn over it, with the chapter's
   * title, scene line and narration above them: an extra row, a taller plate,
   * and on the device's fuller menu a third column of glass standing on a
   * molecule the solver had just proved was clear.
   *
   * One presentation state, then, for the measurement and for every draw in
   * that window. The pending chapter caption is retired rather than redrawn,
   * because `completedTourState` carries no sentence: the caption the wearer
   * has finished reading does not come back to cover the view they asked for.
   *
   * Presentation only. Seat holding, the chapter clock and the resting-seat
   * capture all keep reading the published state, so what this changes is what
   * is drawn and never where it is drawn.
   */
  function presentationState(state = getState()) {
    return donePresentationPending ? completedTourState(state) : state;
  }

  // `placementNote` is the sentence the viewer minted
  // from the last placement receipt (`placement-report.mjs`). It is read
  // straight off the shipped spatial state at every readout call site, rather
  // than through a closure, so a build that publishes no note draws no line and
  // the four cut-and-run harnesses keep working on the same source.
  // Whether the menu is currently standing back for a playing
  // lesson, and the redraw that is settling that change. One promise, so a
  // burst of tour notifications cannot start three alpha passes at once.
  let dimmed = false, dimPass = Promise.resolve();
  // Whether the menu is standing back for a chapter on screen, and when the
  // wearer last pressed a row. `rows()` reads the first; `update()`
  // recomputes both before it decides what to draw.
  let standingBack = false, wokenAt = 0;
  let sequencePreviousCollapsed = false;
  // Which page of the resting structure description is drawn, and
  // the description it belongs to.
  //
  // The counter is toolbar-local, like `mode` and `collapsed`, because nothing
  // outside the plate has an opinion about which page of a sentence the wearer
  // is on. It is reset when the description changes, so loading a new
  // structure always opens its readout at the first page rather than at
  // whatever page the last one had been left on.
  let descriptionPage = 0, descriptionPageOf;
  function descriptionPaging(subject) {
    const pages = structureDescriptionPages(subject);
    const text = pages.join('\u0000');
    if (text !== descriptionPageOf) { descriptionPageOf = text; descriptionPage = 0; }
    const count = pages.length;
    return { descriptionPageCount: count,
      descriptionPageIndex: count > 1 ? ((descriptionPage % count) + count) % count : 0 };
  }
  const descriptionPageIndex = () => descriptionPaging(getState()?.subject).descriptionPageIndex;
  // The row the wearer's ray is currently on, and the draw pass that follows
  // it. Both are rebuilt only when the row changes, not every frame.
  let hoverIndex = -1, hoverStyle = 'hover', hoverDraw = Promise.resolve(), pressIndex = -1, pressedAt = 0, pressTimer, engaged = false;
  // Which hands have a ray on the panel this frame, read by `isHandOnPanel`
  // below. The highlight keeps one winning row for both hands;
  // the trigger modifier has to know about each hand on its own.
  let hoverHands = new Set(), hoverSources = new Set();
  // The hover plate is one representation for the life of a layout, not one
  // per hover. Constructing a `ShapeRepresentation` allocates a render object
  // and a set of GPU buffers, and the old code did that every time the ray
  // crossed a plate or a trigger closed, then threw the previous one away: on
  // a Quest 2 that is an allocation and a collection per transition. It is now
  // built once, updated in place, and hidden rather than destroyed.
  // `hoverBuilds` and `hoverUpdates` are reported in the highlight
  // diagnostics, so a headset log gives the build count for a session.
  let hoverAdded = false, hoverVisible = false, hoverBuilds = 0, hoverUpdates = 0;
  // Which input source the wearer is actually aiming with. Per-source, and
  // never outliving the source itself.
  const pointers = createToolbarPointerTracker();
  const wakeSources = new Set();
  const capturedSources = new Set();
  let pressSource, aimPoint;
  const gestures = createSpatialToolbarGestureTracker({
    onCapture: ({ inputSource, phase, action }) => {
      if (phase === 'start') capturedSources.add(inputSource);
      else capturedSources.delete(inputSource);
      report(inputSource, phase, action);
    },
    // `actionsAccepted` counts completed gestures, and only
    // here, so `run` stays the standalone function the page tests extract.
    onComplete: action => {
      if (action.kind === 'drag-menu') {
        // A background tap can wake quiet controls. A second held press must
        // not redraw or cancel the first controller's pending menu gesture.
        if (!menuDrag) void update().catch(() => {});
      } else { actionsAccepted++; run(action); }
    },
  });

  // The default state is the presentation state, so the rows the hit
  // test aims at and the rows the `journey-seat` record calls committed are the
  // rows on the glass, including through Done's pending window.
  function rows({ quiet = standingBack, collapsed: form = collapsed, state = presentationState() } = {}) {
    // `passthrough` is what turns the row from a feature name into
    // a reading of the session the wearer is actually in.
    // A level only reaches here from a viewer that has the
    // render-budget lever, and only then does the quality row exist.
    // `quiet` defaults to the drawn state, and the footprint
    // wake below asks for the full set explicitly.
    return spatialToolbarRows({ connection: state?.connection, tour: state?.tour, voice: state?.voice, collapsed: form, mode, paused: Boolean(state?.motion?.paused),
      quiet, sequence: state?.sequence, readout: descriptionPaging(state?.subject),
      appearance: state?.appearance, lessonFigure: state?.lessonFigure, representations: state?.representations, history: state?.history,
      ...(typeof state?.passthrough === 'boolean' ? { passthrough: state.passthrough } : {}),
      ...(typeof state?.passthroughSupported === 'boolean' || state?.passthroughSupported === null
        ? { passthroughSupported: state.passthroughSupported } : {}),
      ...(typeof state?.renderQuality === 'string' ? { quality: state.renderQuality } : {}) });
  }

  /**
   * The plate the quiet menu would wake to, laid out now.
   *
   * The footprint a press is tested against is the FULL draw's, not the drawn
   * rows', because the drawn rows are exactly what a quiet-swap press misses.
   * Same head, same constants, same tour state as the live panel — only the
   * row set is the full one — so a seat the full draw holds is inside this
   * backing glass. Layout math only, no GPU work; built lazily, on a row miss
   * while quiet, never on the press path itself.
   */
  function fullDrawPanel() {
    try {
      if (!entryHead) return undefined;
      const fullRows = rows({ quiet: false });
      if (!fullRows?.length) return undefined;
      // The same presentation state the full row set above was built
      // from, so the wake footprint keeps describing one panel.
      const state = presentationState();
      const tour = state?.tour;
      const welcome = shouldShowRoomWelcome({ engaged, voice: state?.voice, tour });
      return createToolbarPanel({ measureText: toolbarTextWidth, rows: fullRows, head: entryHead, constants: layout(),
        readout: tourReadout(captionTour(state), state?.subject ?? welcome, undefined, { placement: state?.placementNote, descriptionPage: descriptionPageIndex() }),
        status: '', seatAnchor: relocationSeat?.anchor ?? panel?.anchor });
    } catch {
      return undefined;
    }
  }

  function rayFor(frame, source) {
    let pose;
    try { pose = frame?.getPose(source?.targetRaySpace, space); } catch { return undefined; }
    const matrix = pose?.transform?.matrix, origin = pose?.transform?.position;
    return matrix && origin ? { origin: [origin.x, origin.y, origin.z], direction: [-matrix[8], -matrix[9], -matrix[10]],
      emulatedPosition: pose.emulatedPosition } : undefined;
  }
  function gripFor(frame, source) {
    if (!source?.gripSpace) return rayFor(frame, source);
    let pose;
    try { pose = frame?.getPose(source.gripSpace, space); } catch { return undefined; }
    const p = pose?.transform?.position;
    return p && [p.x, p.y, p.z].every(Number.isFinite)
      ? { origin: [p.x, p.y, p.z], emulatedPosition: pose.emulatedPosition } : undefined;
  }
  function targetRay(event) { return rayFor(event.frame, event.inputSource); }
  /**
   * A short controller buzz. Quest Touch controllers expose one actuator; a
   * hand, a gaze pointer or an emulator exposes none, and each of those is a
   * silent no-op rather than an error.
   */
  function pulse(source, { intensity, durationMs }) {
    try {
      const actuator = source?.gamepad?.hapticActuators?.[0];
      if (typeof actuator?.pulse !== 'function') return false;
      const result = actuator.pulse(intensity, durationMs);
      if (typeof result?.catch === 'function') result.catch(() => {});
      return true;
    } catch { return false; }
  }
  /**
   * The structure's bounding sphere in XR room metres.
   *
   * `getMolecularBounds` reports it in Mol* scene units, which the wearer
   * rescales. The presentation layer already holds the matrix between the
   * two, so inverting it converts the sphere without asking the session for
   * anything new. That matrix is a rigid transform times one uniform scale,
   * so a single column's length is the scale the radius needs.
   */
  function structureRoomSphere() {
    const sphere = getMolecularBounds();
    if (!Number.isFinite(sphere?.radius) || sphere.radius <= 0 || !sphere.center) return undefined;
    const sceneFromRoom = presentation.roomMatrix?.();
    const roomFromScene = sceneFromRoom && invertMatrix4(sceneFromRoom);
    if (!roomFromScene) return undefined;
    const centre = applyMatrix4(Array.from(sphere.center, Number), roomFromScene);
    const factor = Math.hypot(roomFromScene[0], roomFromScene[1], roomFromScene[2]);
    if (!centre || !Number.isFinite(factor) || factor <= 0) return undefined;
    return { centre, radius: sphere.radius * factor };
  }

  /**
   * How far out the seat has to sit for the structure to clear it, held
   * steady between changes.
   *
   * The stand-off grows the moment the structure reaches the panel and gives
   * ground only when there is a quarter-metre of slack, so a tour spin or a
   * scale ramp cannot make the menu breathe in and out. Each value is rounded
   * up to a 5 cm step as well, because the layout signature drives rebuilds
   * and a continuously varying seat would rebuild every frame.
   */
  function standoff() {
    if (menuLatched) return seatedStandoff;
    // The levelled seat basis, not the raw head one: this bearing has to be
    // the bearing `createToolbarPanel` actually seats the panel along, or the
    // stand-off pushes the panel out of the structure's way in one direction
    // while the panel sits in another.
    const sphere = structureRoomSphere(), basis = toolbarSeatBasis(entryHead);
    if (!sphere || !basis) return seatedStandoff;
    const seat = SPATIAL_TOOLBAR_LAYOUT;
    // The constants carry the panel's FURTHEST bearing, not its seat.
    // `createToolbarPanel` brings that bearing in until the panel's own
    // outboard edge is inside the lens, so a wide row set sits well inboard of
    // the constants and a stand-off measured along the constants' bearing would
    // clear the structure in a direction the panel is not in. The built panel
    // knows where it went -- `anchor` minus `seatOrigin` is the seated bearing,
    // lowering included -- so that is what is measured when there is one.
    const bearing = panel && Array.isArray(panel.anchor) && Array.isArray(panel.seatOrigin)
      ? [0, 1, 2].map(axis => panel.anchor[axis] - panel.seatOrigin[axis])
      : [0, 1, 2].map(axis => basis.forward[axis] * seat.forwardMeters
        + basis.right[axis] * seat.rightMeters - basis.up[axis] * seat.lowerMeters);
    // The clearance covers the panel's own half-width plus a hand's breadth,
    // so the structure stops short of the glass rather than touching it.
    const required = toolbarStandoffMeters(sphere, basis.origin, bearing, STANDOFF_MARGIN_METERS);
    // This is the whole latch. Once the seat is taken, all of the
    // structure/pose work above is skipped until an explicit re-seat clears it.
    seatedStandoff = latchedStandoff({ current: seatedStandoff, required, latched: false,
      step: STANDOFF_STEP_METERS, release: STANDOFF_RELEASE_METERS });
    menuLatched = true;
    entryOutboard = isEntrySeat() ? seatEntryMenu() : 1;
    globalThis.__stereofoldDiagnostics?.record?.('toolbar', { event: 'seat', latched: true,
      reason: seatReason, meters: Number(seatedStandoff.toFixed(3)), outboard: entryOutboard });
    globalThis.__stereofoldDiagnostics?.record?.('toolbar', { phase: 'standoff',
      meters: Number(seatedStandoff.toFixed(3)), required: Number(required.toFixed(3)),
      structureRadius: Number(sphere.radius.toFixed(3)) });
    return seatedStandoff;
  }

  /**
   * How far outboard the ENTRY menu has to sit to be off the structure,
   * measured once, when the seat latches.
   *
   * The answer goes on the `plate-standoff` ring as `frame.menu.clear` beside
   * the two rectangles that decided it, so the seat can be read back from the
   * numbers rather than guessed at. `clear: false` is a real answer too: it
   * means the lens ran out before the subject band did, and the panel builder
   * has the menu as far out as it can go.
   */
  function seatEntryMenu() {
    try {
      const { near, far } = committedDepthRange;
      const constants = toolbarLayoutForStandoff(seatedStandoff, toolbarLayoutForDepthRange(near, far));
      const seat = entryMenuSeat({ measureText: toolbarTextWidth, rows: rows(), head: entryHead, constants, geometry: getEntryGeometry(),
        // The entry seat measures page one, and only page one. A
        // description is reset to its first page whenever it changes, and the
        // entry menu is seated on arrival, so that is the page being drawn
        // here. Every page carries the same two lines, so a later page cannot
        // change the height this seat was solved for.
        readout: tourReadout(getState()?.tour, getState()?.subject, undefined, { placement: getState()?.placementNote }),
        status: '' });
      if (!seat) return 1;
      globalThis.__stereofoldDiagnostics?.record?.('plate-standoff', { ...seat.measured, phase: 'entry',
        frame: { menu: { clear: seat.clear, outboard: seat.factor, rect: seat.rect, subject: seat.subject } } });
      return seat.factor;
    } catch { return 1; }
  }

  /** How many columns a row set folds into at a given layout. */
  function menuColumns(rowCount, constants = SPATIAL_TOOLBAR_LAYOUT) {
    const maxRows = Math.max(1, constants?.maxRows ?? SPATIAL_TOOLBAR_LAYOUT.maxRows);
    return Math.max(1, Math.ceil(Math.max(1, rowCount) / maxRows));
  }

  /**
   * Solve the menu's seat again for the column count a tour chapter
   * is about to draw, and fold the grid when no seat clears.
   *
   * `entryOutboard` and `seatedStandoff` were measured against the two-column
   * grid the wearer arrives at. A chapter adds Play, Done, Back, Next and a
   * caption page row; the grid folds into three columns; and
   * `createToolbarPanel` gives a wider panel a bearing nearer the forward axis,
   * because `toolbarSeatDegrees` brings the seat in until the panel's OUTBOARD
   * corner is inside the lens. The extra column therefore grows towards the
   * structure from a seat solved for fewer columns, and nothing re-solves. A
   * device session capture shows the third column (`Opaque +`, `Move`) and the
   * panel's right edge over 4HHB in both eyes.
   *
   * Two levers, tried in that order:
   *
   * 1. The bearing, on `ENTRY_MENU_OUTBOARD_FACTORS` from the factor already in
   *    force, so a re-solve can only move the panel further from the structure.
   *    It is usually spent: at the lens cap a three-column grid covers the same
   *    lens rectangle whatever `rightMeters` asks for.
   * 2. The column count, by capping rows per column. Three columns of fifteen
   *    become two of sixteen: every row is still drawn, at the same type size --
   *    `toolbarDensity` reads the row count, which has not changed -- and the
   *    grid is one column narrower. On the geometry that is what clears it.
   *
   * A candidate whose glass falls outside `menuSeatWithinView` is refused
   * whatever it clears, because the next committed draw would re-seat against
   * that band and solve again. Where nothing both clears and fits, the least
   * overlapping candidate is drawn and the record says `clear: false`: the lens
   * ran out, which is an answer the device pass can read.
   *
   * The latch is what keeps the panel from swinging every frame (see the note
   * on `menuLatched`), so this runs on the edge alone -- the drawn column count
   * changing -- and never from `syncPose`.
   *
   * @param {object} options
   * @param {Array} options.panelRows the rows this draw will draw
   * @param {Array} options.readout the caption lines, which set the plate height
   * @param {string} options.status the status row text
   * @returns {boolean} whether the caller must rebuild its layout
   */
  function reseatForTourColumns({ panelRows, readout = [], status = '', seatAnchor }) {
    const tour = getState()?.tour;
    const active = tour?.active === true || tour?.autoplay === true
      || (Number.isSafeInteger(tour?.step) && tour.step >= 0);
    // A finished lesson gives the entry seat its own row set back. Drop both
    // the fold and the answer, so the next chapter is solved afresh rather than
    // against the last one's grid.
    if (!active) {
      const folded = menuFoldMaxRows !== undefined;
      solvedColumns = 0;
      menuFoldMaxRows = undefined;
      return folded;
    }
    // Done draws the held pre-tour seat, which is not this solver's to move:
    // `layout()` returns that seat whole, so a solve here could only record a
    // measurement of a panel the draw is not using.
    if (restoredMenuLayout) return false;
    if (!entryHead || !Array.isArray(panelRows) || !panelRows.length) return false;
    const { near, far } = committedDepthRange;
    const base = toolbarLayoutForStandoff(seatedStandoff, toolbarLayoutForDepthRange(near, far));
    const columns = menuColumns(panelRows.length, base);
    // Already answered for this grid, and `layout()` still carries the answer.
    // Ahead of the geometry read, because every chapter redraw reaches here and
    // almost all of them are this case.
    if (columns === solvedColumns) return false;
    // The preconditions `measureEntryStandoff` holds. Unreadable stereo geometry
    // certifies nothing, and a ladder walked for an answer that can only be
    // `undefined` costs one panel build a rung for nothing.
    const geometry = getEntryGeometry();
    if (!geometry?.objects?.length || geometry.renderFromRoom?.length !== 16
      || !geometry.views?.some(view => view.eye === 'left')
      || !geometry.views.some(view => view.eye === 'right')) return false;
    const ladder = ENTRY_MENU_OUTBOARD_FACTORS.filter(factor => factor >= entryOutboard);
    const factors = seatAnchor ? [entryOutboard] : ladder.length ? ladder : [entryOutboard];
    const measureStandoff = prepareEntryStandoff(geometry);
    let answer, best, bestGap = -Infinity;
    for (let wanted = columns; wanted >= 1; wanted -= 1) {
      const perColumn = Math.ceil(panelRows.length / wanted);
      const fold = wanted === columns ? undefined : perColumn;
      const constants = fold === undefined ? base : { ...base, maxRows: fold };
      const seat = entryMenuSeat({ measureText: toolbarTextWidth, rows: panelRows, head: entryHead,
        constants, geometry, readout, status, factors, seatAnchor, measureStandoff });
      // A frame that cannot be measured at one candidate cannot be measured at
      // the next either. Leave the draw alone rather than fold on no evidence.
      if (!seat?.measured) return false;
      const built = createToolbarPanel({ measureText: toolbarTextWidth, rows: panelRows, head: entryHead,
        constants: seat.constants, readout, status, seatAnchor });
      if (!built || !menuSeatWithinView([...toolbarDrawnMenuPoints(built), ...toolbarCaptionPoints(built)], entryHead)) continue;
      const candidate = { seat, columns: menuColumns(panelRows.length, seat.constants), fold };
      // The widest grid that clears wins, which is why the loop counts down.
      if (seat.clear) { answer = candidate; break; }
      // Where none of them will, the least overlap wins instead. Keeping the
      // widest would draw the worst of the failing grids: on a structure framed
      // to fill the entry view, three columns cross the silhouette by 0.18
      // tangent where two are 0.009 short of the margin.
      const gap = Math.min(seat.measured.clearanceLeft, seat.measured.clearanceRight);
      if (gap > bestGap) { bestGap = gap; best = candidate; }
    }
    answer ??= best;
    if (!answer) return false;
    const moved = entryOutboard !== answer.seat.factor || menuFoldMaxRows !== answer.fold;
    entryOutboard = answer.seat.factor;
    menuFoldMaxRows = answer.fold;
    solvedColumns = columns;
    // The device pass reads this beside the `entry` record the same solver
    // wrote: same units, same per-eye lit silhouettes, plus the column count
    // asked for, the one drawn, and the bearing and fold that decided it.
    globalThis.__stereofoldDiagnostics?.record?.('plate-standoff', { ...answer.seat.measured, phase: 'tour-chapter',
      frame: { menu: { clear: answer.seat.clear, outboard: answer.seat.factor, asked: columns,
        columns: answer.columns, folded: answer.columns < columns, maxRows: answer.fold ?? null } } });
    return moved;
  }

  // The depth band is a frame-local clipping input, but it is not a reason to
  // re-solve or redraw the room-locked menu. Capture it when an explicit
  // update is committed; reading it from syncPose made a moving head turn the
  // menu layout into a per-frame job and could keep the label solver alive.
  let committedDepthRange = {};
  function layout() {
    if (restoredMenuLayout) return restoredMenuLayout;
    const { near, far } = committedDepthRange;
    const seated = toolbarLayoutForStandoff(standoff(), toolbarLayoutForDepthRange(near, far));
    // The entry seat's outboard bias, latched with the seat so
    // the menu does not swing back over the structure when the first chapter
    // starts. It swings the bearing on a fixed range: multiplying the lateral
    // leg on its own used to lengthen the seat instead, which is what put the
    // menu at 2.8 m and a third of its angular size.
    const swung = toolbarLayoutForOutboard(entryOutboard, seated);
    // The chapter fold, which is a cap on rows per column and
    // nothing else. It rides in the layout because `layoutSignature` reads
    // `maxRows`, so a fold is a physical layout change and rebuilds the panel.
    return menuFoldMaxRows ? { ...swung, maxRows: menuFoldMaxRows } : swung;
  }
  function layoutSignature(current = layout()) {
    return `${current.forwardMeters}|${current.rightMeters}|${current.lowerMeters}|${current.fontMeters}|${current.rowStepMeters}|${current.columnStepMeters}|${current.maxRows}|${current.maxReadoutLines ?? 8}`;
  }
  /**
   * The same comparison as `layoutSignature`, without building the string.
   *
   * `syncPose` asks this on every immersive frame and the answer is almost
   * always "unchanged", so the string it used to build was allocated 72 times a
   * second to be thrown away. The signature string still exists for `update`,
   * which runs on a rebuild rather than in the frame.
   */
  function sameLayout(current, previous) {
    if (!current || !previous) return false;
    return current.forwardMeters === previous.forwardMeters
      && current.rightMeters === previous.rightMeters
      && current.lowerMeters === previous.lowerMeters
      && current.fontMeters === previous.fontMeters
      && current.rowStepMeters === previous.rowStepMeters
      && current.columnStepMeters === previous.columnStepMeters
      && current.maxRows === previous.maxRows
      && (current.maxReadoutLines ?? 8) === (previous.maxReadoutLines ?? 8);
  }
  function syncBounds() {
    if (!representation || closed) return;
    presentation.update(representation);
  }
  /**
   * Rebuild only when the panel's own physical layout has changed.
   *
   * This used to rebuild whenever the Mol* camera moved, because the panel's
   * geometry was baked into the molecule's coordinates and a camera change
   * left it stale. It is held in the room now, so a tour spin, a Fit, a Scale
   * row or the wearer dragging the structure asks nothing of it: the
   * presentation layer's matrix absorbs all of that inside the draw. What is
   * left is the deliberate cutaway, which can move the panel to a legal depth
   * and genuinely needs new geometry.
   */
  function syncPose() {
    // The menu is room-locked. Camera/head motion is absorbed by its
    // presentation matrix; only a caller's committed state/seat change may
    // invoke update(). The one thing this hook now does is age the
    // title sentence, because a reading window has to be counted in the frames
    // the wearer was shown and this is the only per-frame call the toolbar has.
    if (closed) return undefined;
    ageStatusLine();
    return poseSync;
  }
  function drop(current) {
    if (!current) return undefined;
    appliedRoomOffsets.delete(current);
    try { presentation.remove(current); } catch {}
    try { current.destroy(); } catch {}
    return undefined;
  }
  /** Forget the row and any press held on it. Touches no GPU resource. */
  function resetHover() { clearTimeout(pressTimer); pressTimer = undefined; pressIndex = -1; pressSource = undefined; hoverIndex = -1; hoverStyle = 'hover'; hoverHands = new Set(); }
  /**
   * Take the plate off the panel without giving up its geometry.
   *
   * `setState({ visible: false })` clears the renderable's visible flag, and
   * the presentation layer's `syncVisibility` repartitions on the next draw,
   * so the plate stops rendering this frame and the next hover costs an update
   * rather than a build.
   */
  function hideHighlight() {
    resetHover();
    if (!hoverRepresentation || !hoverVisible) return;
    hoverVisible = false;
    try { hoverRepresentation.setState({ visible: false }); } catch {}
    globalThis.__stereofoldDiagnostics?.record('toolbar', { phase: 'highlight', row: null, style: null, hidden: true, builds: hoverBuilds, updates: hoverUpdates });
    // `presentation.update` repartitions the scene and asks for a draw. It
    // re-uploads nothing: no value cell changed, so every buffer is clean.
    if (hoverAdded) presentation.update(hoverRepresentation);
  }
  /** Give the plate's geometry back. Only a rebuilt layout needs this. */
  function disposeHighlight() {
    resetHover();
    hoverVisible = false;
    if (hoverRepresentation) {
      if (hoverAdded) hoverRepresentation = drop(hoverRepresentation);
      else { try { hoverRepresentation.destroy(); } catch {} }
    }
    hoverRepresentation = undefined; hoverAdded = false;
  }
  async function remove() {
    disposeHighlight();
    // Nothing is drawn any more, so the next update has nothing to match
    // against and must rebuild whatever it is asked for.
    renderedContent = undefined;
    plateRepresentation = drop(plateRepresentation);
    readoutRepresentation = drop(readoutRepresentation);
    stateRepresentation = drop(stateRepresentation);
    if (representation) { appliedRoomOffsets.delete(representation); presentation.remove(representation); representation.destroy(); representation = undefined; onRepresentationChange(0); }
  }

  /**
   * The backing glass and the plate under every row. They are the reason a
   * row reads as a button at all; a text-only menu reads as loose words that
   * cannot be pressed. The mesh is lit, so the chamfer around each plate
   * carries a real highlight and the panel has depth rather than a uniform
   * fill.
   */
  async function buildPlates(mapped) {
    if (!mapped?.plates?.length) return undefined;
    const mesh = plateMesh(mapped.plates, mapped.outward);
    const shape = Shape.create('Stereofold toolbar plates', {}, mesh,
      groupId => plateColor(groupId, STYLE_ORDER), () => 1,
      () => 'Spatial control');
    const next = ShapeRepresentation(async () => shape, Mesh.Utils, { modifyState: state => ({ ...state, pickable: false }) });
    globalThis.__stereofoldDiagnostics?.record('toolbar', { phase: 'plates', plates: mapped.plates.length,
      triangles: mesh.triangleCount, styles: mapped.plates.map(plate => plate.style) });
    try {
      await plugin.runTask(next.createOrUpdate(toolbarPlateProps(menuAlpha(dimmed).plates), {}));
    } catch (error) {
      try { next.destroy(); } catch {}
      throw error;
    }
    return next;
  }

  /**
   * One brighter plate over the row the ray is on, or the row being pressed.
   *
   * Rebuilt only when the row or its state changes, so a held aim costs
   * nothing per frame. A press sinks the plate along the panel normal and
   * lights it, which is the confirmation a controller ray cannot otherwise
   * give: the wearer sees the button move under the trigger.
   *
   * One representation serves every row and both states. The first call after
   * a layout rebuild constructs it and adds it to the presentation layer,
   * room-locked like the panel it belongs to; every call after that is a
   * `createOrUpdate` into the geometry it already holds, so the ray crossing a
   * plate costs a buffer re-upload and nothing else.
   */
  async function drawHighlight(index, style) {
    if (closed || !panel) return;
    const button = panel.buttons[index];
    if (!button || button.targetable === false) { hideHighlight(); return; }
    // A newer request arrived while this one waited in the queue. That request
    // runs immediately after this call and draws the row the ray is now on, so
    // build nothing here.
    if (hoverIndex !== index || hoverStyle !== style) {
      globalThis.__stereofoldDiagnostics?.record('toolbar', { phase: 'highlight', row: button.label, style, stale: true, built: false, builds: hoverBuilds, updates: hoverUpdates });
      return;
    }
    // A pressed plate gives back part of its forward bias and narrows, so it
    // is seen to travel into its socket while still winning every pixel it
    // shares with the merged plate underneath.
    const sink = style === 'press' ? panel.pressSinkMeters ?? 0 : 0;
    const bias = panel.highlightBiasMeters ?? 0;
    const outward = roomOutward(panel);
    const plate = outward && platePolygon(panel, button, {
      inset: (panel.plateInsetMeters ?? 0) + sink, depth: panel.plateDepthMeters ?? 0,
      bevel: panel.bevelMeters ?? 0, lift: (panel.faceLiftMeters ?? 0) + bias - sink, segments: 3,
    });
    if (!plate) return;
    const built = !hoverRepresentation;
    if (built) {
      hoverBuilds += 1;
      hoverAdded = false; hoverVisible = false;
      hoverRepresentation = ShapeRepresentation(highlightShape, Mesh.Utils, { modifyState: state => ({ ...state, pickable: false }) });
    }
    const target = hoverRepresentation;
    try {
      await plugin.runTask(target.createOrUpdate(HIGHLIGHT_PROPS, { plate, style, outward, label: button.label }));
    } catch (error) {
      // Release a representation this call constructed and never added. One
      // already in the presentation layer stays there for the next update.
      if (hoverRepresentation === target && !hoverAdded) { try { target.destroy(); } catch {} hoverRepresentation = undefined; }
      return;
    }
    hoverUpdates += 1;
    const stale = closed || hoverIndex !== index || hoverStyle !== style;
    globalThis.__stereofoldDiagnostics?.record('toolbar', { phase: 'highlight', row: button.label, style, stale, built, builds: hoverBuilds, updates: hoverUpdates });
    // Teardown ran during the update and already released this object.
    if (hoverRepresentation !== target) { try { target.destroy(); } catch {} return; }
    if (closed) return;
    if (!hoverAdded) { hoverAdded = true; hoverVisible = true; presentation.add(target, { roomLocked: true }); return; }
    if (!hoverVisible) { hoverVisible = true; try { target.setState({ visible: true }); } catch {} }
    // The plate's vertex buffers changed on a render object the scene already
    // has; this re-uploads them and re-applies the room-lock matrix.
    presentation.update(target);
  }

  /** Queue one highlight redraw; consecutive requests never overlap. */
  function requestHighlight(index, style) {
    if (hoverIndex === index && hoverStyle === style) return;
    hoverIndex = index; hoverStyle = style;
    if (index < 0) { hoverDraw = hoverDraw.then(() => hideHighlight()).catch(() => {}); return; }
    hoverDraw = hoverDraw.then(() => drawHighlight(index, style)).catch(() => {});
  }

  /**
   * Sink the plate the wearer claimed, and raise it again after release.
   *
   * The plate stays down for as long as the trigger is held and for at least
   * `TOOLBAR_PRESS_MS` after it, so a flick is still seen even when building
   * the sunk plate costs a frame or two on a Quest 2.
   */
  function beginPress(index, source) {
    clearTimeout(pressTimer); pressTimer = undefined;
    pressIndex = index; pressedAt = Date.now(); pressSource = source;
    requestHighlight(index, 'press');
  }
  function endPress() {
    pressSource = undefined;
    if (pressIndex < 0 || pressTimer) return;
    const index = pressIndex;
    pressTimer = setTimeout(() => {
      pressTimer = undefined; pressIndex = -1;
      if (!closed && hoverIndex === index && hoverStyle === 'press') requestHighlight(index, 'hover');
    }, Math.max(0, TOOLBAR_PRESS_MS - (Date.now() - pressedAt)));
  }

  /**
   * Observe a seat the wearer has turned away from without rebuilding a frame.
   *
   * A menu that followed the head would be in front of whatever the wearer
   * turned to look at, which is the complaint this panel started with, and
   * every press of the menu button already re-seats it on the current gaze.
   * Keep this pose for the next UI commit, and record excursions: a session where the menu is
   * not there then carries the evidence, at four samples a second rather than
   * one per frame, once per excursion.
   */
  let driftSince = 0, driftRecorded = false, driftChecked = 0;
  function trackSeatDrift(frame) {
    const now = Date.now();
    if (now - driftChecked < 250) return;
    driftChecked = now;
    let pose;
    try { pose = frame.getViewerPose?.(space); } catch { pose = undefined; }
    const transform = pose?.transform;
    if (transform?.matrix && transform?.position) {
      const { x, y, z } = transform.position;
      if ([x, y, z, ...transform.matrix].every(Number.isFinite))
        latestViewerHead = { position: { x, y, z }, matrix: Array.from(transform.matrix) };
    }
    const drift = pose ? seatYawDriftDegrees(panel, pose) : undefined;
    if (!Number.isFinite(drift) || drift < MENU_SEAT_DRIFT_DEGREES) { driftSince = 0; driftRecorded = false; return; }
    if (!driftSince) { driftSince = now; return; }
    if (driftRecorded || now - driftSince < MENU_SEAT_DRIFT_MS) return;
    driftRecorded = true;
    globalThis.__stereofoldDiagnostics?.record?.('toolbar',
      { phase: 'seat-drift', degrees: Math.round(drift), moved: false });
  }

  function syncMenuDrag(frame, { release = false } = {}) {
    if (menuDrag.suspended) { menuDrag.rebase = true; return; }
    let head;
    if (release) {
      // Input-event frames expose getPose, but getViewerPose is rAF-only. Use
      // the last sampled head; a genuine lost-head frame must stay lost.
      head = menuDrag.headSampled ? menuDrag.head : latestViewerHead ?? entryHead;
    } else {
      try { head = frame.getViewerPose?.(space); } catch { /* Tracking unavailable. */ }
      menuDrag.headSampled = true;
    }
    const origin = toolbarSeatBasis(head)?.origin;
    menuDrag.head = origin ? head : undefined;
    if (origin) menuDrag.lastHead = head;
    const ray = rayFor(frame, menuDrag.source);
    // A tracking gap can hide the motion that distinguishes a click from a
    // drag. Keep ownership until release, but never turn that uncertain press
    // into its original button action. An active drag still rebases normally.
    if ((!ray && menuDrag.kind !== 'grip') || !origin) menuDrag.interrupted = true;
    const offset = menuDrag.kind === 'grip'
      ? menuGripDragStep(menuDrag, gripFor(frame, menuDrag.source), origin)
      : menuDragStep(menuDrag, ray, origin);
    if (offset && (menuDrag.active || Math.hypot(...offset) >= .025)) {
      if (!menuDrag.active) {
        // A drag consumes the original button press even if its first move
        // meets the head-clearance boundary. Never fire that button on release.
        for (const source of [...capturedSources]) if (source !== menuDrag.source) gestures.cancel(source);
        menuDrag.active = true;
      }
      inputLocked = true;
      hideHighlight();
      const safe = clampMenuDragOffset(menuDrag.offset, offset,
        value => toolbarHeadClearance(panel, head, value), TOOLBAR_MIN_HEAD_CLEARANCE_METERS);
      if (safe) {
        menuDrag.offset = safe;
        renderedOffset = [...safe];
        applyMenuRoomOffset(safe);
      }
      // The physical hand may continue into the boundary. Rebase there so its
      // first outward movement moves the glass immediately instead of undoing
      // all the rejected hand travel first.
      if (safe && safe.some((v, i) => Math.abs(v - offset[i]) > 1e-8)) {
        menuDrag.baseOffset = [...menuDrag.offset];
        if (menuDrag.kind === 'grip') menuDrag.grip = menuDrag.lastGrip;
        else menuDrag.ray = menuDrag.lastRay;
        menuDrag.rebase = false;
      }
    }
  }

  /**
   * Per-frame ray tracking. It gives the wearer the cue a plain panel lacks:
   * which row the controller is actually on, before the trigger is pulled.
   * Hover is visual only: resting controllers can exchange pointer priority
   * through tracking jitter without any press.
   *
   * A Quest 2 reports two controllers, and both rays cross the panel. Taking
   * the first hit lets a resting hand pin the highlight to a row the wearer
   * is not aiming at, which is how the aiming hand's own hover disappears.
   * The pointer holding a press wins; otherwise the one that moved most
   * recently does, which is the hand the wearer is pointing with.
   */
  function syncInput(frame, extraSources) {
    aimPoint = undefined;
    if (!acceptsInput()) { hideHighlight(); return; }
    if (closed || hidden || !panel || !frame) { if (hoverHands.size) hoverHands = new Set(); return; }
    for (const source of [...gripReleaseRequired]) {
      const value = source.gamepad?.buttons?.[1]?.value;
      if (Number.isFinite(value) && value < GRIP_RELEASE) gripReleaseRequired.delete(source);
    }
    if (menuDrag?.kind === 'grip') {
      const drag = menuDrag, value = drag.source.gamepad?.buttons?.[1]?.value;
      const at = readoutNow();
      const grip = gripFor(frame, drag.source);
      const live = Array.from(session.inputSources ?? []).includes(drag.source) || extraSources?.includes(drag.source);
      drag.suspended = !live;
      let head;
      try { head = frame.getViewerPose?.(space); } catch {}
      if (live && grip && toolbarSeatBasis(head)) drag.missingSince = undefined;
      else if (!Number.isFinite(drag.missingSince)) drag.missingSince = at;
      const independentGrip = live && drag.source.targetRayMode === 'tracked-pointer' && Number.isFinite(value);
      const grace = independentGrip ? GRIP_TRACKING_GRACE_MS : TRIGGER_TRACKING_GRACE_MS;
      const lost = Number.isFinite(drag.missingSince) && at - drag.missingSince > grace;
      if ((Number.isFinite(value) && value < GRIP_RELEASE) || lost) {
        if (lost) gripReleaseRequired.add(drag.source);
        selectEnd({ type: 'squeezeend', inputSource: drag.source, frame });
      }
    }
    if (menuDrag) syncMenuDrag(frame);
    if (inputLocked && !menuDrag) { hideHighlight(); return; }
    trackSeatDrift(frame);
    const onPanel = new Set(), onPanelSources = new Set();
    let sources = [];
    try { sources = [...(session.inputSources ?? [])]; } catch { sources = []; }
    // A simulated controller is not in `session.inputSources`
    // and must never be added to it. It is appended for this one call so the
    // hover ranking, the pointer tracker and the hit test run unchanged, and it
    // is forgotten again by the caller.
    if (Array.isArray(extraSources) && extraSources.length) sources = [...sources, ...extraSources];
    pointers.retain(sources);
    let found, aimRank = -Infinity;
    for (const source of sources) {
      const ray = rayFor(frame, source);
      if (!ray) continue;
      const rank = pointers.rank(source, ray) + (source === pressSource || source === menuDrag?.source ? Number.MAX_SAFE_INTEGER : 0);
      // Translate the query back into the drawn panel's original frame.
      const offset = renderedOffset;
      const localRay = { ...ray, origin: ray.origin.map((v, i) => v - offset[i]) };
      const button = hitToolbarPanel(panel, localRay);
      if ((button || hitToolbarGlass(panel, localRay)) && rank > aimRank) {
        const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
        const divisor = dot(ray.direction, panel.normal);
        const depth = dot(panel.anchor.map((v, i) => v - localRay.origin[i]), panel.normal) / divisor;
        if (Number.isFinite(depth) && depth >= 0) {
          // A small offset toward the wearer keeps the dot over the glass.
          aimPoint = ray.origin.map((v, i) => v + ray.direction[i] * depth - panel.normal[i] * .006);
          aimRank = rank;
        }
      }
      if ((button || hitToolbarGlass(panel, localRay)) && source?.handedness) { onPanel.add(source.handedness); onPanelSources.add(source); }
      if (!button) continue;
      if (!found || rank > found.rank) found = { source, rank, index: panel.buttons.indexOf(button) };
    }
    hoverHands = onPanel; hoverSources = onPanelSources;
    if (menuDrag?.active) return;
    const index = found?.index ?? -1;
    if (index === hoverIndex) return;
    globalThis.__stereofoldDiagnostics?.record('toolbar', { phase: 'hover', row: panel.buttons[index]?.label ?? null });
    // A press already showing on this row outranks the hover it came from,
    // but moving off the row ends both at once.
    requestHighlight(index, 'hover');
  }

  /**
   * Take the menu down while a lesson plays, and bring it back.
   *
   * Alpha is a draw property, not geometry: `createOrUpdate` with the same
   * shape re-uploads one uniform and reuses every buffer, so this costs far
   * less than the rebuild `update` does and never disturbs the row layout the
   * wearer is aiming at. Nothing about hit testing changes — a dimmed menu is
   * still pressable, and the press is what brings it back, through the tour
   * state this reads rather than through any handler of its own.
   */
  function setDimmed(value) {
    const next = Boolean(value);
    if (next === dimmed || closed) return dimPass;
    dimmed = next;
    const alpha = menuAlpha(dimmed);
    const targets = [[plateRepresentation, toolbarPlateProps(alpha.plates)],
      [representation, toolbarTextProps(alpha.labels)],
      [readoutRepresentation, toolbarTextProps(alpha.readout)]];
    globalThis.__stereofoldDiagnostics?.record?.('toolbar', { phase: 'dim', dimmed, plates: alpha.plates, readout: alpha.readout });
    dimPass = dimPass.then(async () => {
      for (const [target, props] of targets) {
        if (!target || closed) continue;
        // A redraw during the pass replaced this representation, and built it
        // at the alpha now in force. Leave that one alone.
        if (target !== plateRepresentation && target !== representation && target !== readoutRepresentation) continue;
        try {
          await plugin.runTask(target.createOrUpdate(props));
          presentation.update?.(target);
        } catch { /* A menu that will not fade is still a menu; never fail a frame for it. */ }
      }
    }).catch(() => {});
    return dimPass;
  }

  async function update({ restoreTourSeat = false, recenter = false, origin = 'host' } = {}) {
    if (menuDrag?.active) return;
    if (origin !== 'menu-drag' && inputLocked && renderedOffset.some(v => v !== 0)) {
      redrawAfterDrag = { restoreTourSeat: redrawAfterDrag?.restoreTourSeat || restoreTourSeat,
        recenter: redrawAfterDrag?.recenter || recenter, origin };
      return;
    }
    // A host notice can arrive while a Menu or Reset press is waiting for its
    // next XR pose. Let the press finish the seat before drawing that notice.
    if (origin !== 'wearer' && (menuReseatRequested || (!menuLatched && entryHead && seatReason !== 'entry'))) {
      redrawAfterReseat = { restoreTourSeat: redrawAfterReseat?.restoreTourSeat || restoreTourSeat, origin: 'host' };
      return;
    }
    const own = ++sequence;
    const currentTour = getState()?.tour;
    if (restoreTourSeat && restingMenuSeat) {
      // Done restores the completed reading on the held anchor. Only a
      // wearer request can restore the old head pose as a new room seat.
      if (origin === 'wearer') entryHead = restingMenuSeat.head;
      collapsed = restingMenuSeat.collapsed;
      seatedStandoff = restingMenuSeat.standoff;
      entryOutboard = restingMenuSeat.outboard;
      restoredMenuLayout = restingMenuSeat.layout;
      menuLatched = true;
      tourSeatRestorePending = true;
      // From here the panel presents the completed menu
      // the preview measured, however long the player takes to say so.
      donePresentationPending = true;
      donePresentationOf = tourReadingSignature(currentTour);
      if (origin === 'wearer') menuReseatRequested = true;
      standingBack = false;
    } else if (currentTour?.active || currentTour?.autoplay || currentTour?.step >= 0) {
      tourSeatHeld = true;
      restoredMenuLayout = undefined;
    }
    // The player has spoken, so the published reading is the one to
    // draw again. Either it has published its ending — the live state IS the
    // completed menu, and it carries the Done receipt sentence, which is the
    // wearer's answer and has to reach the plate — or it has moved on to
    // another chapter, whose caption a held derivation would swallow.
    if (donePresentationPending && (!tourStillRunning(currentTour)
      || tourReadingSignature(currentTour) !== donePresentationOf)) donePresentationPending = false;
    try { committedDepthRange = { ...(getDepthRange() ?? {}) }; }
    catch { committedDepthRange = {}; }
    // Hidden/empty molecular bounds cannot disable Menu or its refusal plate.
    // Standoff already falls back to the held/default depth without a sphere.
    // A notification may redraw the glass, but the pose observed beside it
    // cannot move a room seat. Only a wearer summon may use that pose.
    if (recenter && origin === 'wearer') unlatchSeat('reset', { reseat: true });
    // On Done these points still describe the outgoing chapter panel. Judge
    // the upcoming restored panel in the check below, before committing it.
    else if (origin === 'wearer' && menuReseatRequested && !restoreTourSeat && entryHead && latestViewerHead && seatedViewPoints.length
      && !menuSeatWithinView(seatedViewPoints, latestViewerHead)) {
      unlatchSeat('view-band', { reseat: true });
      entryHead = latestViewerHead;
    }
    if (!entryHead) {
      const head = await nextViewerPose(session, space);
      if (own !== sequence || closed) return;
      entryHead = head; latestViewerHead = head;
    }
    if (own !== sequence || closed) return;
    // The stand-off latches against this pose, including after Close/Menu
    // clears entryHead. Capturing layout before reacquiring it leaves the old
    // stand-off in the mesh; validation then latches the new one and discards
    // the fold. The next press only reseats the still-expanded drawn grid.
    let physicalLayout = layout(), physicalLayoutSignature = layoutSignature(physicalLayout);
    // Where this rebuild would seat the panel, to the millimetre and the
    // tenth of a degree. It joins the content signature below because a
    // re-seat usually changes nothing else: pressing the menu button twice
    // from two places drew the same rows, the signature matched, `update`
    // returned early, and the panel stayed where the wearer could not see it
    // while the seat it was supposed to move to was already stored.
    const seatBasis = toolbarSeatBasis(entryHead);
    const seatSignature = seatBasis
      ? [...seatBasis.origin.map(value => Math.round(value * 1000)),
        Math.round(Math.atan2(seatBasis.forward[0], -seatBasis.forward[2]) * 1800 / Math.PI)].join(',')
      : null;
    // Rebuild labels after an action, but always retain this entry-pose anchor
    // in physical XR local space. The panel is built in those same metres and
    // stays in them. The presentation layer converts to scene units once a
    // frame, with one matrix.
    const state = getState();
    const tour = state?.tour;
    // What this draw presents. It differs from the
    // published state only while Done's restore is pending, and there it is
    // exactly what the clearance solver measured. Seat holding, the chapter
    // clock and the resting-seat capture below keep reading `state` and
    // `tour`, so this changes what is drawn and never where it is drawn.
    const presented = presentationState(state);
    const presentedTour = presented?.tour;
    // When this chapter arrived, for the caption's reading
    // window. `tour-player.ts` stamps its own on the same clock; this covers a
    // host too old to carry the field, and it is taken on the edge rather than
    // read per frame so an unchanged chapter keeps its original start.
    if (tour?.selectedId !== lastTourId || tour?.step !== lastTourStep) {
      lastTourId = tour?.selectedId;
      lastTourStep = tour?.step;
      chapterStartedAt = Number.isFinite(tour?.chapterStartedAt) ? tour.chapterStartedAt : readoutNow();
    }
    // Before the early return below, because a playing lesson
    // whose rows have not changed is exactly the case that must still dim. Any
    // press, a pause, or the end of the lesson clears `autoplay` and the menu
    // comes straight back at the next notification.
    // A chapter on screen, not autoplay. The nine hardware
    // captures were taken while the driver stepped the lesson with `next`, and
    // the menu never dimmed once because nothing was "playing".
    // An expanded menu is the wearer's choice. Chapter rebuilds and expired
    // wake windows must keep Back, Done and the page row in the drawn grid.
    standingBack = collapsed && !presented?.sequence?.open && menuStandsBack({ tour: presentedTour, now: Date.now(), wokenAt });
    setDimmed(standingBack);
    // One press of anything ends the first-run hint for the rest of the
    // session. A voice state that has left idle is a held A or X, or the Talk row.
    if (typeof state?.voice?.state === 'string' && state.voice.state !== 'idle') engaged = true;
    const welcome = shouldShowRoomWelcome({ engaged, voice: presented?.voice, tour: presentedTour });
    // Hold the title sentence for its window, and leave it
    // retired afterwards. The latch is cleared only when the sentence itself
    // changes, so a sentence that has had its six seconds cannot come back on
    // the next unrelated redraw — the wearer pressing a row half a minute later
    // must not be answered by a refusal they were shown and have finished
    // reading.
    const readoutTour = captionTour(presented);
    const sentence = plateStatusSentence(readoutTour);
    if (sentence !== plateStatus) { plateStatus = sentence; plateStatusRetired = false; }
    const panelRows = rows();
    const panelReadout = tourReadout(readoutTour, presented?.subject ?? welcome, undefined,
      { placement: presented?.placementNote, descriptionPage: descriptionPageIndex(), statusRetired: plateStatusRetired });
    // A chapter may fold the grid before it is drawn. Host changes measure
    // candidates at the held anchor; only a summon may choose a new anchor.
    const heldAnchor = relocationSeat?.anchor ?? (menuReseatRequested ? undefined : panel?.anchor);
    if (reseatForTourColumns({ panelRows, readout: panelReadout,
      status: '', seatAnchor: heldAnchor })) {
      physicalLayout = layout();
      physicalLayoutSignature = layoutSignature(physicalLayout);
    }
    // Only a sentence the readout has actually put in the title slot is timed:
    // the chooser's own stamp can refuse one before it is ever drawn, and a
    // sentence that never reached the glass has no reading time to retire.
    const standing = sentence && panelReadout[0]?.text === sentence ? sentence : '';
    if (standing !== statusTiming) { statusTiming = standing; statusFirstFrame = undefined; }
    // Rebuild only when what is drawn would differ.
    //
    // `refreshToolbar` fires on every tour and voice notification, and those
    // arrive whether or not anything the panel shows has changed. Without this
    // test the panel logged a couple of hundred records over a lesson — a full
    // plate rebuild and dispose every one to two seconds, with the wearer
    // doing nothing. Each
    // one is a Mol* mesh and text build and a scene repartition, and the
    // flicker it causes is in the corner of the eye the wearer is trying to
    // ignore. This is every input the drawn panel has: its rows, its caption,
    // its status line and its physical layout.
    const contentSignature = JSON.stringify([physicalLayoutSignature, seatSignature, relocationSeat?.anchor,
      panelRows.map(row => [row.label, row.state === true, row.accent === true]),
      panelReadout.map(line => line.text)]);
    if (representation && !menuReseatRequested && contentSignature === renderedContent) return;
    const panelOptions = { measureText: toolbarTextWidth, rows: panelRows, head: entryHead, constants: physicalLayout, readout: panelReadout, status: '', seatAnchor: heldAnchor };
    const nextPanel = createToolbarPanel(panelOptions);
    // A summoned panel may need the newer observed pose before its draw.
    if (origin === 'wearer' && menuReseatRequested && latestViewerHead && entryHead !== latestViewerHead
      && !menuSeatWithinView([...toolbarDrawnMenuPoints(nextPanel), ...toolbarCaptionPoints(nextPanel)], latestViewerHead)) {
      unlatchSeat('view-band', { reseat: true });
      entryHead = latestViewerHead;
      return update({ origin });
    }
    const mapped = roomPanel(nextPanel);
    if (!mapped || own !== sequence || closed) return;
    const readout = mapped.readoutScenePoints.filter(line => line.scenePoint);
    // Two text layers, because they need opposite treatment. A row label sits
    // on its own lit plate and wants no backing at all; the old per-glyph
    // boxes were most of what made the menu look like loose words. Status and
    // caption lines float over the scene and keep theirs.
    //
    // Recessed state rows (the last chapter's Done) are a third layer.
    // They read in the same button-white as every other row,
    // at a reduced alpha (`toolbarDoneTextProps`, 0.6) on the flat recessed
    // backing, instead of the near-black they had. One representation cannot
    // carry two alphas, so the state glyphs get their own. The hit test
    // still refuses them and the press path still no-ops them: only paint
    // changed.
    const mainButtons = mapped.buttons
      .map((button, index) => ({ button, index }))
      .filter(({ button }) => button.style !== 'state');
    const stateButtons = mapped.buttons
      .map((button, index) => ({ button, index }))
      .filter(({ button }) => button.style === 'state');
    const labelGlyphs = mainButtons.reduce((total, { button }) => total + (button.label?.length ?? 0), 0);
    const labelBuilder = TextBuilder.create(TEXT_PROPS, Math.max(1, labelGlyphs), Math.max(1, labelGlyphs));
    mainButtons.forEach(({ button, index }) => {
      if (!button.scenePoint) return;
      const lines = button.labelLines ?? [button.label];
      lines.forEach((line, lineIndex) => addGlyphs(labelBuilder, line, {
        origin: button.scenePoint.map((value, axis) => value
          + mapped.up[axis] * ((lines.length - 1) / 2 - lineIndex) * mapped.fontScene * .7),
        right: mapped.right, size: mapped.fontScene, group: index }));
    });
    const labelShape = Shape.create('Stereofold spatial toolbar', {}, labelBuilder.getText(),
      () => Color(PALETTE.text), () => 1,
      groupId => nextPanel.buttons[groupId]?.label ?? 'Spatial control');
    const next = ShapeRepresentation(async () => labelShape, Text.Utils, { modifyState: state => ({ ...state, pickable: false }) });
    const stateGlyphs = stateButtons.reduce((total, { button }) => total + (button.label?.length ?? 0), 0);
    let nextState;
    if (stateButtons.length > 0) {
      const stateBuilder = TextBuilder.create(TEXT_PROPS, Math.max(1, stateGlyphs), Math.max(1, stateGlyphs));
      stateButtons.forEach(({ button, index }) => { if (button.scenePoint) addGlyphs(stateBuilder, button.label, { origin: button.scenePoint, right: mapped.right, size: mapped.fontScene, group: index }); });
      const stateShape = Shape.create('Stereofold spatial toolbar state', {}, stateBuilder.getText(),
        () => Color(PALETTE.text), () => 1,
        groupId => nextPanel.buttons[groupId]?.label ?? 'Spatial control');
      nextState = ShapeRepresentation(async () => stateShape, Text.Utils, { modifyState: state => ({ ...state, pickable: false }) });
    }

    const floatingLines = readout.map(line => ({ text: line.text, scenePoint: line.scenePoint, fontScene: line.fontScene, color: PALETTE.text, name: line.text }));
    const readoutGlyphs = floatingLines.reduce((total, line) => total + line.text.length, 0);
    const readoutBuilder = TextBuilder.create(TEXT_PROPS, Math.max(1, readoutGlyphs), Math.max(1, readoutGlyphs));
    floatingLines.forEach((line, index) => addGlyphs(readoutBuilder, line.text, { origin: line.scenePoint, right: mapped.right, size: line.fontScene, group: index }));
    const readoutShape = Shape.create('Stereofold toolbar readout', {}, readoutBuilder.getText(),
      groupId => Color(floatingLines[groupId]?.color ?? PALETTE.text), () => 1,
      groupId => floatingLines[groupId]?.name ?? 'Tour readout');
    const nextReadout = floatingLines.length
      ? ShapeRepresentation(async () => readoutShape, Text.Utils, { modifyState: state => ({ ...state, pickable: false }) })
      : undefined;
    let nextPlates;
    try {
      // `offsetZ` pulls text toward the eye by that many scene units times
      // the camera scale, which is a physical distance that changes when the
      // wearer rescales the structure. Room-locked text cannot carry it. It is
      // not needed either: every plate face is seated at least a centimetre
      // behind its label in room metres, and the plates are drawn first.
      await plugin.runTask(next.createOrUpdate(toolbarTextProps(menuAlpha(dimmed).labels), {}));
      // Recessed state rows keep their own reduced alpha in both menu states:
      // they are already dim at 0.6, so standing back leaves them alone.
      if (nextState) await plugin.runTask(nextState.createOrUpdate(toolbarDoneTextProps(), {}));
      // Caption and status text sit on the caption glass, so they drop the
      // per-glyph background the panel plate now provides. The glyphs are
      // filled (`borderWidth: 0`) rather than stroked.
      if (nextReadout) await plugin.runTask(nextReadout.createOrUpdate(toolbarTextProps(menuAlpha(dimmed).readout), {}));
      nextPlates = await buildPlates(mapped);
    } catch (error) {
      // A failed redraw never becomes the live representation, but its
      // partially-created Mol* resources still need releasing.
      try { next.destroy(); } catch {}
      try { nextState?.destroy(); } catch {}
      try { nextReadout?.destroy(); } catch {}
      try { nextPlates?.destroy(); } catch {}
      throw error;
    }
    // The cutaway band can move the panel while Mol* builds the text mesh.
    // Do not commit geometry that no longer matches the layout in force; the
    // next XR frame will request a fresh update. The camera is deliberately
    // not part of this test any more: it used to discard a rebuild whenever
    // the head or the structure moved during one, which under a tour spin is
    // every rebuild, so the panel never caught up at all.
    if (own !== sequence || closed || menuDrag?.active || physicalLayoutSignature !== layoutSignature()) {
      next.destroy(); try { nextState?.destroy(); } catch {} try { nextReadout?.destroy(); } catch {} try { nextPlates?.destroy(); } catch {} return;
    }
    // Keep the hit panel paired with the representation that is visible. Any
    // press captured against the outgoing panel is cancelled before the swap,
    // so it cannot fire a target whose label disappeared during a redraw.
    if (menuDrag) cancelMenuDrag();
    const swapLock = inputLocked;
    inputLocked = true;
    try {
      if (panel) { globalThis.__stereofoldDiagnostics?.record('toolbar', { phase: 'redraw-dispose' }); gestures.dispose(); }
      panel = undefined;
      await remove();
      // Name this move before the drawn state is overwritten.
      //
      // The Menu/Close rows fold and re-seat in one draw, naming both causes.
      // Separate actions in a burst are still coalesced by the session.
      // The seat signature moves only when `entryHead` has been cleared, which
      // is exactly what `unlatchSeat` does for a re-seat; a panel that moved
      // with its seat unchanged followed the scene rather than the wearer's
      // press, and anything left is the drawn content growing inside a glass
      // that has not moved.
      //
      // `renderedContent` is not the first-draw test here: `remove()` above
      // has already cleared it. `renderedSeat` is written only on a commit and
      // never cleared, so it is the one field that says whether anything has
      // ever been drawn.
      const firstDraw = renderedSeat === undefined;
      lastMenuMotion = [];
      if (renderedGrid !== undefined && collapsed !== renderedGrid) lastMenuMotion.push(collapsed ? 'collapse' : 'expand');
      if (!firstDraw && (menuReseatRequested || seatSignature !== renderedSeat)) lastMenuMotion.push('reseat');
      else if (renderedLayout && !sameLayout(physicalLayout, renderedLayout)) lastMenuMotion.push('follow');
      if (!lastMenuMotion.length) lastMenuMotion.push(firstDraw ? 'seat' : 'grow');
      if (tourSeatRestorePending) lastMenuMotion = ['seat'];
      // The reasons this commit is about, kept before the hidden
      // branch below empties the list. The receipt is written from these, so a
      // re-seat that lands while the panel is hidden behind a grab still says
      // so rather than going unrecorded.
      const committedMotion = [...lastMenuMotion];
      if (hidden) {
        // The label obstacle remains at its old seat during a grab. Preserve
        // motion reasons until reveal, so an explicit reseat cannot solve once
        // against that old obstacle and again against the newly visible one.
        for (const reason of lastMenuMotion) {
          if (!hiddenMenuMotion.includes(reason)) hiddenMenuMotion.push(reason);
        }
        lastMenuMotion = [];
      }
      renderedSeat = seatSignature; renderedGrid = collapsed;
      menuReseatRequested = false;
      // The Move row's receipt. A re-seat on an unmoved wearer draws
      // the column exactly where it already was, so neither the drawn state nor
      // a capture can prove the row worked. This is written by the commit that
      // seated it, and it does not depend on component name plates being drawn
      const seatCommit = menuSeatReceipt({ motion: committedMotion, reason: seatReason, seat: seatSignature, hidden });
      if (seatCommit) globalThis.__stereofoldDiagnostics?.record?.('toolbar', seatCommit);
      seatedMenuPoints = toolbarMenuPoints(nextPanel);
      seatedViewPoints = [...toolbarDrawnMenuPoints(nextPanel), ...toolbarCaptionPoints(nextPanel)];
      representation = next; stateRepresentation = nextState; panel = nextPanel; renderedLayout = physicalLayout; renderedContent = contentSignature;
      drawnPanelOptions = panelOptions;
      if (redrawAfterReseat) {
        const pending = redrawAfterReseat;
        redrawAfterReseat = undefined;
        // The summon may have built labels before a host edit arrived. Apply
        // that edit once its seat is committed, without moving the anchor.
        queueMicrotask(() => { void update(pending).catch(() => {}); });
      }
      if (tourSeatRestorePending) {
        tourSeatRestorePending = false;
        tourSeatHeld = false;
        // The Done draw beside the panel its preview
        // measured. `rowsPreviewed` and `rowsDrawn` are the same number only
        // when the transitional panel is the measured one; `columns` is the
        // grid the drawn rows folded into, which is where the defect showed on
        // the device as a third column of glass over a cleared molecule.
        //
        // The count is consumed, not read: a Done that took the no-preview
        // branch of `restoreJourneySeat` must report no measurement rather
        // than the previous Done's.
        const rowsPreviewed = restorePreviewRows;
        restorePreviewRows = undefined;
        globalThis.__stereofoldDiagnostics?.record?.('transition', { phase: 'done-restore',
          rowsPreviewed: rowsPreviewed ?? null, rowsDrawn: panelRows.length,
          columns: panelColumns(nextPanel), pending: donePresentationPending });
        // Measure the committed column, not a proposed seat. Diagnostics must
        // never interrupt the draw, including when stereo geometry is absent.
        try {
          const measured = measureEntryStandoff({ ...getEntryGeometry(), menuPoints: toolbarDrawnMenuPoints(nextPanel) });
          if (measured) globalThis.__stereofoldDiagnostics?.record?.('plate-standoff', { ...measured, phase: 'tour-end' });
        } catch { /* Unreadable geometry cannot certify clearance. */ }
      }
      if (!tourSeatHeld && !tour?.navigating && !tour?.active && !tour?.autoplay && !(tour?.step >= 0)) {
        restingMenuSeat = { head: entryHead, collapsed, standoff: seatedStandoff,
          outboard: entryOutboard, layout: physicalLayout };
      }
      // The rows the wearer can now press, in XR-local metres, published for
      // an external harness. Such a harness would otherwise rebuild this
      // layout from its own copy of the tour state, and every row that moves
      // after a press -- `Start tour` becoming `Pause`, a caption row arriving
      // -- would leave it aiming at a seat that no longer exists, so the press
      // lands on the neighbour or on nothing. Read-only: this reports the
      // panel, never changes it.
      //
      // Eight rows a record, in parallel arrays of primitives, because the
      // diagnostics buffer keeps at most eight items per array and drops
      // anything nested two deep. `draw` is this redraw's sequence number, so a
      // reader can take the newest complete set and ignore the one before it.
      //
      // Wrapped: this runs after `remove()` has disposed the old geometry and
      // before the new geometry is added, so a fault here would leave the panel
      // hit-testable and invisible. Reporting never blocks the draw.
      try {
        for (let from = 0; from < nextPanel.buttons.length; from += DIAGNOSTIC_ROW_CHUNK) {
          const chunk = nextPanel.buttons.slice(from, from + DIAGNOSTIC_ROW_CHUNK);
          globalThis.__stereofoldDiagnostics?.record?.('toolbar', { phase: 'rows', draw: own, from,
            total: nextPanel.buttons.length, fontMeters: nextPanel.fontMeters,
            anchor: [...nextPanel.anchor], hidden,
            labels: chunk.map(button => button.label),
            actions: chunk.map(button => JSON.stringify(button.action ?? null)),
            targetable: chunk.map(button => button.targetable === true),
            x: chunk.map(button => button.point[0]),
            y: chunk.map(button => button.point[1]),
            z: chunk.map(button => button.point[2]) });
        }
      } catch {}
      // Plates first: they sit behind the labels and must not overdraw them.
      if (nextPlates) { plateRepresentation = nextPlates; presentation.add(nextPlates, { roomLocked: true }); }
      presentation.add(next, { roomLocked: true });
      if (nextState) { presentation.add(nextState, { roomLocked: true }); }
      if (nextReadout) { readoutRepresentation = nextReadout; presentation.add(nextReadout, { roomLocked: true }); }
      renderedOffset = [0, 0, 0];
      // A rebuild adds fresh render objects, which are visible by default.
      if (hidden) for (const target of [next, nextState, nextReadout, nextPlates]) { if (target) presentation.setVisible?.(target, false); }
      onRepresentationChange(1);
      if (redrawAfterDrag) {
        const pending = redrawAfterDrag; redrawAfterDrag = undefined;
        queueMicrotask(() => { void update(pending).catch(() => {}); });
      }
    } finally {
      inputLocked = swapLock;
    }
  }

  function report(source, phase, action) { try { onConsumeSelect({ inputSource: source, phase, action }); } catch {} }
  function squeezeStart(event) {
    const source = event.inputSource, ray = targetRay(event);
    if (!acceptsInput() || closed || hidden || inputLocked || menuDrag || !source || gripReleaseRequired.has(source)
      || !panel || !(hitToolbarPanel(panel, ray) || hitToolbarGlass(panel, ray))
      || typeof presentation.setRoomOffset !== 'function') return;
    if (!gestures.start(source, { kind: 'drag-menu' })) return;
    const grip = gripFor(event.frame, source);
    const head = latestViewerHead ?? entryHead, origin = toolbarSeatBasis(head)?.origin;
    menuDrag = { source, kind: 'grip', ray, grip, anchor: [...panel.anchor], offset: [0, 0, 0], active: true,
      depthAxis: origin ? panel.anchor.map((v, i) => v - origin[i]) : undefined, lastHead: head };
    engaged = true; wokenAt = Date.now(); standingBack = false; setDimmed(false);
    pulse(source, SELECT_PULSE);
    event.preventDefault?.(); event.stopImmediatePropagation?.();
  }
  function squeezeEnd(event) {
    gripReleaseRequired.delete(event.inputSource);
    if (menuDrag?.kind === 'grip' && menuDrag.source === event.inputSource) selectEnd(event);
  }
  function selectStart(event) {
    if (!acceptsInput()) return;
    if (menuDrag?.kind === 'grip' && menuDrag.source === event.inputSource) {
      event.preventDefault?.(); event.stopImmediatePropagation?.(); return;
    }
    const ray = targetRay(event);
    const button = panel ? hitToolbarPanel(panel, ray) : undefined;
    const glass = !button && hitToolbarGlass(panel, ray);
    const source = event.inputSource;
    // A press into a seat the quiet draw vacated misses every drawn row.
    // Dropping it silently reads to the wearer as the menu ignoring them.
    // When the ray is on the full-draw footprint, wake
    // the full draw instead and consume the press: no gesture starts, so no
    // row can fire from the press that woke the menu. A press on a drawn quiet
    // row still takes the row path below, exactly as today.
    const decision = toolbarPressDecision({ rowHit: Boolean(button || glass), quiet: standingBack,
      footprintHit: !button && panel && standingBack ? hitToolbarFootprint(fullDrawPanel(), ray) : false });
    if (decision === 'wake' && source && !closed && !hidden && !inputLocked) {
      globalThis.__stereofoldDiagnostics?.record('toolbar', { phase: 'selectstart', hit: null, hasPanel: true, closed, inputLocked, woke: true, ray });
      engaged = true;
      wokenAt = Date.now(); standingBack = false; setDimmed(false);
      event.preventDefault?.(); event.stopImmediatePropagation?.();
      // A moved panel invalidates the captured ray target for an in-progress
      // press on the other hand, so it cannot fire a control the wearer did
      // not release on. Same dispose `syncPose` does on a layout move.
      if (panel) gestures.dispose();
      wakeSources.add(source);
      report(source, 'start', { kind: 'wake-menu' });
      // The rows come back with this rebuild; the alpha came back above, so
      // the menu is already lighting up under the wearer's ray.
      update().catch(() => {});
      return;
    }
    globalThis.__stereofoldDiagnostics?.record('toolbar', { phase: 'selectstart', hit: button?.label ?? null, hasPanel: Boolean(panel), closed, inputLocked, ray: targetRay(event) });
    // The first held press owns this panel. A second press is consumed until
    // release, so moving that controller cannot accidentally activate a row
    // while the first controller is still deciding between click and drag.
    const action = button || glass
      ? (menuDrag && menuDrag.source !== source ? { kind: 'drag-menu' } : button?.action ?? { kind: 'drag-menu' })
      : undefined;
    if (!action || !source || closed || hidden || inputLocked || !gestures.start(source, action)) return;
    pulse(source, SELECT_PULSE);
    engaged = true;
    // Any press wakes the menu, immediately and before the action runs.
    // The rows come back with the rebuild the action triggers;
    // the alpha comes back now, so the row under the wearer's ray lights up
    // rather than staying at a quarter while they press it.
    wokenAt = Date.now(); standingBack = false; setDimmed(false);
    if (button) beginPress(panel.buttons.indexOf(button), source);
    if (!menuDrag && typeof presentation.setRoomOffset === 'function') {
      menuDrag = { source, ray, anchor: [...panel.anchor], offset: [0, 0, 0], active: false };
    }
    event.preventDefault?.(); event.stopImmediatePropagation?.();
  }
  function select(event) {
    if (wakeSources.has(event.inputSource)) { event.preventDefault?.(); event.stopImmediatePropagation?.(); return; }
    if (menuDrag?.active && menuDrag.source === event.inputSource) { event.preventDefault?.(); event.stopImmediatePropagation?.(); return; }
    globalThis.__stereofoldDiagnostics?.record('toolbar', { phase: 'select', closed, inputLocked });
    if (!acceptsInput() || hidden || inputLocked) return;
    const action = gestures.select(event.inputSource);
    if (action) { event.preventDefault?.(); event.stopImmediatePropagation?.(); }
  }
  function run(action) {
    if (!acceptsInput()) return;
    // Cancellation is admitted at the press, before joining an older fit's
    // action chain. The next action still waits for its rollback and draw.
    if (typeof onActionIntent === 'function') onActionIntent(action);
    const epoch = actionEpoch;
    // The page hook joins this same action chain without selectStart. Wake
    // here too so its Menu press can actually expose the early Done row.
    wokenAt = Date.now(); standingBack = false; engaged = true; setDimmed(false);
    globalThis.__stereofoldDiagnostics?.record?.('toolbar-action', { kind: action?.kind, locked: inputLocked });
    // A microphone/playback unlock must begin inside the trusted XR select
    // event. Do not defer this one controller action to the next XR frame;
    // `voiceInteraction.toggle()` performs its gesture-bound unlock before
    // awaiting permission or the authenticated request. It is still joined to
    // the action chain so teardown waits for it.
    if (action.kind === 'voice-toggle') {
      let immediate;
      try { immediate = onAction(action); }
      catch (error) { try { onActionError(error); } catch {} void setStatus('Could not start voice. Try again.', 0xf07d7d); return; }
      actionChain = actionChain.then(() => immediate, () => immediate).catch(() => {});
      return;
    }
    actionChain = actionChain.then(async () => {
      // A completed press may be waiting behind another action or for an XR
      // frame when system UI takes focus. A later visible frame cannot revive it.
      if (epoch !== actionEpoch || !acceptsInput()) return;
      if (!await nextXrTick(session) || epoch !== actionEpoch || !acceptsInput()) return;
      let relocating = false;
      let actionFailed = false;
      try {
        if (action.kind === 'sequence') {
          const result = await onAction(action);
          if (action.op === 'open') { sequencePreviousCollapsed = collapsed; collapsed = true; }
          if (result?.open === false) collapsed = sequencePreviousCollapsed;
          if (action.op === 'open' || result?.open === false) {
            gestures.dispose();
            inputLocked = relocating = true;
            // Opening a sequence changes content, not the menu's room seat.
          }
        } else if (action.kind === 'collapse') {
          if (clearanceHidden) { clearanceHidden = false; setHidden(false); }
          if (getState()?.tour?.menuOpen) {
            await onAction(action);
            // The page's Menu hook closes the chooser here. Publish the answer
            // through the reply plate even if the inactive player is replaced.
            showTalkOutcome(CHOOSER_CLOSED_LINE, CHOOSER_CLOSED_WINDOW_MS);
          }
          collapsed = action.value;
          gestures.dispose();
          inputLocked = relocating = true;
          unlatchSeat('menu');
        } else if (action.kind === 'recenter-menu') {
          if (clearanceHidden) { clearanceHidden = false; setHidden(false); }
          gestures.dispose();
          inputLocked = relocating = true;
          // `reset` alone frees the standoff and retains the old head. This
          // explicit menu re-seat must acquire the wearer's current pose too.
          unlatchSeat(action.reason ?? 'menu', { reseat: true });
        } else if (action.kind === 'recenter-structure' || action.kind === 'reset') {
          // A reset view is one of the three things allowed to move the
          // latched seat. The panel itself is left where it is —
          // `viewer.mjs` sends the menu its own `recenter-menu` right after,
          // and that is what re-seats it — so this only frees the stand-off to
          // be measured against the structure the reset is about to restore.
          unlatchSeat('reset');
          await onAction(action);
        } else if (action.kind === 'readout-page') {
          // Paging the source description is a plate-local read, like
          // the mode row above. It changes no scene, takes no receipt and
          // reaches no host, so it never leaves this closure.
          descriptionPage++;
        } else if (action.kind === 'mode') mode = mode === 'move' ? 'rotate' : 'move';
        else if (action.kind !== 'notice') await onAction(action);
        notice = undefined;
      } catch (error) {
        actionFailed = true;
        notice = { text: action.kind === 'recenter-menu' ? 'Could not move the menu. Try again.' : 'Could not apply that change. Try again.', color: 0xf07d7d };
        try { onActionError(error); } catch {}
      }
      try {
        // The workbench opener schedules XR teardown after this action chain
        // settles; it owns the next presentation state and needs no redraw.
        if (action.kind !== 'open-workbench') await update({ origin: 'wearer' });
      } catch (error) {
        // A failed summon leaves the last drawn panel in place. Release its
        // pending seat so later host redraws can use that held anchor.
        if (menuReseatRequested) { menuReseatRequested = false; menuLatched = true; }
        if (!actionFailed) {
          notice = { text: action.kind === 'recenter-menu' ? 'Could not move the menu. Try again.' : 'Could not redraw the menu. Try again.', color: 0xf07d7d };
          try { onActionError(error); } catch {}
        }
      } finally {
        if (relocating) inputLocked = false;
      }
    }).catch(() => {});
  }
  function selectEnd(event) {
    if (menuDrag?.kind === 'grip' && menuDrag.source === event.inputSource && event.type === 'selectend') return;
    if (wakeSources.delete(event.inputSource)) {
      report(event.inputSource, 'end', { kind: 'wake-menu' });
      event.preventDefault?.(); event.stopImmediatePropagation?.(); return;
    }
    if (!acceptsInput() || closed || hidden) {
      cancelMenuDrag(event.inputSource); gestures.cancel(event.inputSource); endPress(); return;
    }
    // A quick drag may move between the last animation frame and release.
    // Judge that final event pose before allowing its original button click.
    if (menuDrag?.source === event.inputSource) syncMenuDrag(event.frame, { release: true });
    if (menuDrag?.source === event.inputSource) {
      const drag = menuDrag; menuDrag = undefined;
      if (drag.active) {
        gestures.cancel(event.inputSource); endPress(); inputLocked = true;
        event.preventDefault?.(); event.stopImmediatePropagation?.();
        const previous = relocationSeat ?? { anchor: drag.anchor };
        const seat = { anchor: drag.anchor.map((value, axis) => value + drag.offset[axis]) };
        // Release redraws the glass facing its seat origin again. Check that
        // final geometry too: its rotated near edge can differ from the held
        // translation, especially after the wearer has walked to the side.
        // Retain the last actual head sample through a short tracking gap; no
        // emulated controller position or invented head pose supplies travel.
        const head = drag.head ?? drag.lastHead;
        const clear = anchor => toolbarHeadClearance(createToolbarPanel({ ...drawnPanelOptions, seatAnchor: anchor }), head);
        if (!(clear(seat.anchor) >= TOOLBAR_MIN_HEAD_CLEARANCE_METERS)) {
          const origin = toolbarSeatBasis(head)?.origin;
          if (!origin) { inputLocked = false; return; }
          let radial = seat.anchor.map((v, i) => v - origin[i]);
          const length = Math.hypot(...radial);
          radial = length > 1e-8 ? radial.map(v => v / length) : [...panel.normal];
          const held = [...seat.anchor];
          let distance = .01;
          while (distance < 8 && !(clear(seat.anchor) >= TOOLBAR_MIN_HEAD_CLEARANCE_METERS)) {
            seat.anchor = held.map((v, i) => v + radial[i] * distance);
            distance *= 2;
          }
          if (!(clear(seat.anchor) >= TOOLBAR_MIN_HEAD_CLEARANCE_METERS)) { inputLocked = false; return; }
          // Seat rotation on release must not pull a near edge inside the
          // guard. Move out only as far as needed, instead of snapping home.
          let low = 0, high = distance / 2;
          for (let i = 0; i < 12; i++) {
            const middle = (low + high) / 2;
            if (clear(held.map((v, axis) => v + radial[axis] * middle)) >= TOOLBAR_MIN_HEAD_CLEARANCE_METERS) high = middle;
            else low = middle;
          }
          seat.anchor = held.map((v, i) => v + radial[i] * high);
        }
        renderedOffset = seat.anchor.map((v, i) => v - drag.anchor[i]);
        applyMenuRoomOffset(renderedOffset);
        relocationSeat = seat; seatReason = 'menu-drag';
        void update({ origin: 'menu-drag' }).catch(async () => {
          if (relocationSeat !== seat) return;
          relocationSeat = previous;
          renderedOffset = [0, 0, 0];
          applyMenuRoomOffset(renderedOffset);
          await update({ origin: 'menu-drag' });
        }).catch(() => {}).finally(() => { inputLocked = false; });
        return;
      }
      if (drag.interrupted) {
        gestures.cancel(event.inputSource); endPress();
        event.preventDefault?.(); event.stopImmediatePropagation?.();
        return;
      }
    }
    if (!acceptsInput()) { gestures.cancel(event.inputSource); endPress(); return; }
    const ended = gestures.end(event.inputSource);
    endPress(); globalThis.__stereofoldDiagnostics?.record('toolbar', { phase: 'selectend', action: ended?.kind ?? null, closed });
  }
  function cancelMenuDrag(source) {
    if (!menuDrag || (source && menuDrag.source !== source)) return;
    menuDrag = undefined; inputLocked = false;
    renderedOffset = [0, 0, 0];
    applyMenuRoomOffset(renderedOffset);
  }
  function forgetHover(source) {
    hoverSources.delete(source);
    if (![...hoverSources].some(other => other.handedness === source?.handedness)) hoverHands.delete(source?.handedness);
  }
  function sourceChange(event) { for (const source of event.removed ?? []) { gripReleaseRequired.delete(source); forgetHover(source); cancelMenuDrag(source); cancelWake(source); gestures.cancel(source); pointers.forget(source); } endPress(); }
  function cancelWake(source) { if (wakeSources.delete(source)) report(source, 'cancel', { kind: 'wake-menu' }); }
  function selectCancel(event) { forgetHover(event.inputSource); cancelMenuDrag(event.inputSource); cancelWake(event.inputSource); gestures.cancel(event.inputSource); endPress(); }

  /**
   * One press driven the way a wearer presses, minus the wearer.
   *
   * THIS SIMULATES A CONTROLLER POSE. There is no hand, no tracking, and no
   * person: a synthetic `XRInputSource` is given a target ray aimed at the
   * drawn row and pushed through the same `selectStart`/`select`/`selectEnd`
   * this session's own listeners call. Everything between the pose and the
   * action is therefore real — the plane intersection, the row rectangle, the
   * recessed-row refusal, the hover ranking against any hand that is actually
   * present, the press debounce, and the quiet menu's wake rule — and nothing
   * about reach, comfort or legibility is tested at all.
   *
   * `{ between: true }` aims into the gap between two adjacent rows and must
   * fire nothing. That is the case worth running: a build whose rectangles
   * have drifted off the plates passes every row aim and fails this one.
   */
  function aimSynthetic(target = {}) {
    const base = { method: 'synthetic-ray', simulates: 'controller pose, not a hand or a wearer' };
    if (closed || hidden || !panel) {
      return { ...base, fired: false, reason: closed ? 'the menu is closed' : hidden ? 'the menu is hidden' : 'no menu is drawn' };
    }
    const buttons = panel.buttons ?? [];
    const between = target.between === true;
    let index = -1, miss;
    if (between) {
      miss = toolbarMissTarget(panel);
      if (!miss) return { ...base, fired: false, reason: 'this drawn menu offers no point that presses nothing' };
    } else {
      const wanted = String(target.id ?? '');
      index = buttons.findIndex(button => String(button?.id ?? '') === wanted);
      if (index < 0) {
        return { ...base, fired: false, aimedAt: wanted, reason: `no drawn row ${JSON.stringify(wanted)}`,
          rows: buttons.map(button => String(button?.id ?? '')) };
      }
    }
    const ray = between ? miss.ray : toolbarAimRay(panel, { row: index });
    if (!ray) return { ...base, fired: false, reason: 'the drawn panel gave no aimable point' };
    const source = { handedness: 'right', targetRayMode: 'tracked-pointer', targetRaySpace: { synthetic: true }, profiles: ['stereofold-synthetic-pointer'] };
    const matrix = new Array(16).fill(0);
    matrix[0] = 1; matrix[5] = 1; matrix[15] = 1;
    matrix[8] = -ray.direction[0]; matrix[9] = -ray.direction[1]; matrix[10] = -ray.direction[2];
    matrix[12] = ray.origin[0]; matrix[13] = ray.origin[1]; matrix[14] = ray.origin[2];
    const pose = { transform: { matrix, position: { x: ray.origin[0], y: ray.origin[1], z: ray.origin[2] } } };
    const frame = { getPose: (raySpace, base2) => (raySpace === source.targetRaySpace && base2 === space ? pose : undefined) };
    const event = { frame, inputSource: source, preventDefault() {}, stopImmediatePropagation() {} };
    const quietBefore = standingBack;
    const before = actionsAccepted;
    // Hover first, exactly as a frame would: the highlight a wearer uses to
    // know which row they are on is part of what this is here to exercise.
    syncInput(frame, [source]);
    const hovered = hoverIndex;
    const hit = hitToolbarPanel(panel, ray);
    try {
      selectStart(event);
      select(event);
      selectEnd(event);
    } finally {
      pointers.forget(source);
    }
    const fired = actionsAccepted > before;
    const woke = !fired && quietBefore && !standingBack;
    return { ...base, fired, woke,
      aimedAt: between ? miss.kind : String(target.id ?? ''),
      ...(between ? { betweenRows: miss.between.map(slot => String(buttons[slot]?.id ?? '')) } : { rowIndex: index, label: String(buttons[index]?.label ?? '') }),
      targetable: between ? false : buttons[index]?.targetable !== false,
      hitId: hit ? String(hit.id ?? '') : null, hitLabel: hit ? String(hit.label ?? '') : null,
      hovered: hovered >= 0 ? String(buttons[hovered]?.id ?? '') : null,
      ray: { origin: [...ray.origin], direction: [...ray.direction] },
      reason: fired ? 'the aimed row took the select'
        : woke ? 'the quiet menu woke on this press and fired no row'
        : between ? `the ray landed ${miss.kind === 'between-columns' ? 'between the two columns' : 'above the top row'} and fired nothing`
        : hit ? 'the row was hit but refused the select'
        : 'the ray hit no row' };
  }

  let depthPanel, depthPoints;
  function depthRange(frame) {
    if (!panel || closed) return undefined;
    // The band has to hold the whole slab. The label plane at zero depth is
    // its front, since every plate face sits behind it; the backing glass and
    // the seated plate edges set the back.
    const pose = frame.getViewerPose(space);
    // A committed panel's local geometry is immutable. Tracking and held
    // translation change only its projection, not these rounded slab edges.
    if (depthPanel !== panel) {
      depthPoints = [...panel.buttons.map(button => button.point),
        ...panel.buttons.flatMap(button => toolbarPlateOutline(panel, button, { depth: panel.plateDepthMeters ?? 0, segments: 1 })),
        ...toolbarBackingOutline(panel, { depth: panel.backingDepthMeters ?? 0, segments: 1 }),
        ...toolbarBackingOutline(panel, { depth: panel.backingDepthMeters ?? 0, segments: 1, plate: panel.captionBacking }),
        ...(panel.statusBacking ? toolbarBackingOutline(panel, { depth: panel.backingDepthMeters ?? 0, segments: 1, plate: panel.statusBacking }) : []),
        ...(panel.readoutPoints ?? []).map(line => line.point)];
      depthPanel = panel;
    }
    const points = depthPoints;
    if (!pose?.views?.length || !points.length) return undefined;
    let near = Infinity, far = -Infinity;
    for (const view of pose.views) {
      const matrix = view.transform.inverse.matrix;
      for (const point of points) {
        const depth = -(matrix[2] * (point[0] + renderedOffset[0]) + matrix[6] * (point[1] + renderedOffset[1])
          + matrix[10] * (point[2] + renderedOffset[2]) + matrix[14]);
        if (Number.isFinite(depth) && depth > 0) { near = Math.min(near, depth); far = Math.max(far, depth); }
      }
    }
    // Text backgrounds, glyph depth, and controller-scale imprecision need a
    // small physical margin, independent of molecular clipping parameters.
    return Number.isFinite(near) && Number.isFinite(far) ? { near: Math.max(0.01, near - 0.05), far: far + 0.05 } : undefined;
  }

  session.addEventListener('squeezestart', squeezeStart); session.addEventListener('squeezeend', squeezeEnd); session.addEventListener('squeezecancel', selectCancel);
  session.addEventListener('selectstart', selectStart); session.addEventListener('select', select); session.addEventListener('selectend', selectEnd); session.addEventListener('selectcancel', selectCancel); session.addEventListener('inputsourceschange', sourceChange);
  /**
   * Keep status ownership and expiry for receipt arbitration and diagnostics.
   * The talk card draws the line; toolbar geometry carries tour chapters only.
   * Microphone progress stays in persistent talking/sending state until finished.
   *
   * D14 read the menu's `plates: 31` before and
   * after a delivered reply and concluded the reply's plate was never added to
   * the drawn set. That counter has never included the talk card. The menu's
   * legacy reply glass (`statusBacking`) is unused: no toolbar text layer draws
   * statusScenePoints. Passing feedback to that geometry creates blank glass
   * over the molecule. Tour outcomes use the caption readout, and transient
   * replies use the talk card; neither needs an extra status backing. What
   * was actually wrong is `holdMs` below.
   */
  let cancelStatusHold = () => {};
  function setStatus(text, color = PALETTE.text, progress, holdMs, complete = false, onSeat) {
    const ongoing = progress === 'listening' || progress === 'sending';
    if (ongoing) showTalkProgress({ talking: progress === 'listening', sending: progress === 'sending', progress: text, outcome: '' });
    else showTalkOutcome(text, holdMs, complete, onSeat);
    cancelStatusHold();
    notice = typeof text === 'string' && text ? { text, color } : undefined;
    const ownNotice = notice;
    // Three seconds is a control confirmation, not an answer.
    // A delivered reply carries the window the Mac asked for (`holdSeconds`,
    // 2-15 s) and the length its own clip runs, whichever is longer; anything
    // shorter than the default is ignored so a caller cannot flash a line past
    // the wearer.
    const hold = Number.isFinite(holdMs) && holdMs > STATUS_HOLD_MS ? Math.min(STATUS_MAX_HOLD_MS, holdMs) : STATUS_HOLD_MS;
    cancelStatusHold = notice && !ongoing ? holdOutcomeLine({
      scheduleFrame: callback => session.requestAnimationFrame(callback), holdMs: hold,
      onExpire: () => { if (!closed && notice === ownNotice) void setStatus('').catch(() => {}); },
    }) : () => {};
    // The only record of what the wearer's status row was asked
    // to say. A stale plate is indistinguishable from a plate nobody wrote to
    // without this, and a device test left an orange `Waiting`
    // up through a tour, a spin, a stop and two quality commands.
    globalThis.__stereofoldDiagnostics?.record?.('toolbar', { phase: 'status', text: notice?.text ?? null });
    return update({ origin: 'status' });
  }

  /**
   * The session stopped being the wearer's primary focus.
   *
   * WebXR delivers no input to a blurred session, so a trigger held when the
   * system dialog appears never gets its release here: the row stays lit and
   * its captured action stays armed for whatever `select` arrives once the
   * dialog closes. Drop both, exactly as a moved panel does in `syncPose`.
   * Geometry is kept: the wearer comes back to the same menu.
   */
  function blur() {
    if (closed) return;
    actionEpoch++;
    cancelMenuDrag();
    gestures.dispose();
    for (const source of [...wakeSources]) cancelWake(source);
    pointers.retain([]);
    hideHighlight();
    globalThis.__stereofoldDiagnostics?.record?.('toolbar', { phase: 'blur' });
  }

  /**
   * Take the panel out of the frame while the wearer is holding the structure.
   *
   * A grab is the one action where the menu is certainly not what the wearer
   * is looking at, and it is drawn as glass in front of whatever they are
   * moving. Hidden, not removed: a rebuild on release would cost a mesh and a
   * text build at the moment they look back at it. The ray targets go with
   * it, so a hidden panel cannot take a press either.
   */
  function setHidden(value) {
    const next = Boolean(value);
    if (next === hidden || closed) return;
    if (next) {
      hiddenMenuPoints = drawnRoomPoints(seatedMenuPoints);
      hiddenMenuMotion = [];
      lastMenuMotion = [];
    }
    hidden = next;
    if (hidden) {
      // Another hand can grab the molecule while this hand is dragging or
      // waking the menu. Cancel every menu owner before the glass disappears;
      // a later release must not commit that abandoned drag or block a hand.
      cancelMenuDrag();
      gestures.dispose();
      for (const source of [...wakeSources]) cancelWake(source);
      disposeHighlight();
    }
    for (const target of [representation, readoutRepresentation, stateRepresentation, plateRepresentation]) {
      if (target) presentation.setVisible?.(target, !hidden);
    }
    // A hidden redraw may have seated different rows. Publish that footprint
    // on reveal even when the next update has no content left to redraw.
    if (!hidden && panel) {
      lastMenuMotion = hiddenMenuMotion;
      hiddenMenuMotion = [];
      onRepresentationChange(1);
    }
    globalThis.__stereofoldDiagnostics?.record?.('toolbar', { phase: 'hidden', hidden });
  }

  /**
   * Every drawn point of the panel, in XR room metres, or an empty list when
   * there is no panel the wearer can read.
   *
   * A framing asks for this to keep the structure off the glass. A hidden or
   * closed panel contributes nothing, because the wearer cannot lose a glyph
   * that is not drawn -- and the caption's own seat is the floor the framing
   * falls back to, so a hidden menu still cannot invite the structure forward.
   */
  function platePoints() {
    return panel && !closed && !hidden ? drawnRoomPoints(toolbarPlatePoints(panel)) : [];
  }
  function drawnRoomPoints(points) {
    return points.map(point => point.map((v, i) => v + renderedOffset[i]));
  }

  // The worker measures these exact full panels; preparation never moves glass.
  function prepareRelocation({ headInRoom, labelViews, renderFromRoom }) {
    if (!panel || !drawnPanelOptions || closed || hidden || inputLocked || menuReseatRequested) return [];
    const head = { matrix: headInRoom, position: { x: headInRoom[12], y: headInRoom[13], z: headInRoom[14] } };
    const baseline = JSON.stringify(platePoints());
    return [...menuRelocationCandidates(drawnPanelOptions, head, { labelViews, renderFromRoom }),
      { id: 'hidden', points: [], hide: true }].map(candidate => ({ ...candidate, baseline }));
  }

  async function commitRelocation(candidate) {
    const stale = () => Object.assign(Error('The menu changed while checking its new seat. Kept the previous placement.'), { code: 'FIT_STALE' });
    if (closed || hidden || inputLocked || menuReseatRequested || candidate.baseline !== JSON.stringify(platePoints())) throw stale();
    const before = { relocationSeat: relocationSeat ?? { anchor: [...panel.anchor] }, entryHead, seatReason };
    if (candidate.hide) {
      clearanceHidden = true;
      setHidden(true);
      globalThis.__stereofoldDiagnostics?.record?.('toolbar', { phase: 'seat-commit', reason: 'clearance', hidden: true,
        hint: 'Controls hidden to clear the structure. B/Y brings them back.' });
      return { rollback: async () => { if (!closed && hidden && clearanceHidden) { clearanceHidden = false; setHidden(false); } } };
    }
    const ownedSeat = { anchor: candidate.anchor };
    relocationSeat = ownedSeat;
    entryHead = candidate.head;
    seatReason = 'clearance';
    const rollback = async () => {
      // A newer explicit summon owns the menu; recovery must not undo it.
      if (relocationSeat !== ownedSeat) return;
      relocationSeat = before.relocationSeat; entryHead = before.entryHead; seatReason = before.seatReason;
      if (!closed) await update({ origin: 'clearance' });
    };
    try {
      await update({ origin: 'clearance' });
      // A concurrent content/layout change must never inherit a proof for
      // different glass. The old menu is restored before the caller refuses.
      if (closed || hidden || JSON.stringify(platePoints()) !== JSON.stringify(candidate.points)) throw stale();
      globalThis.__stereofoldDiagnostics?.record?.('toolbar', { phase: 'seat-commit', reason: 'clearance', parked: candidate.parked === true,
        hint: candidate.parked ? 'Menu moved to the side. B/Y brings it back.' : 'Menu moved clear of the structure.' });
      return { rollback };
    } catch (error) {
      await rollback();
      throw error;
    }
  }

  /**
   * Full glass at an upcoming entry/reset seat, using the draw's live content,
   * together with the content that glass was built from.
   *
   * The placement solver measures `points`, and the `journey-seat`
   * diagnostics record reports the rest. Both come from this one build of the
   * panel, so the record can never describe a different panel from the one the
   * solver cleared — which is the whole reason a device recording is worth more
   * than another fixture. `menuPoints` is a thunk because the record wants the
   * menu column alone and a placement solve does not: asking costs a second
   * pass over the panel, and only a caller that needs it should pay for it.
   *
   * Read-only. Nothing here draws, seats or re-solves.
   */
  function placementPreview({ headInRoom, resetMenu = false, restoreTourSeat = false }) {
    const head = { matrix: headInRoom,
      position: { x: headInRoom[12], y: headInRoom[13], z: headInRoom[14] } };
    // A Done preview is a reading of the COMPLETED menu. Entry and
    // Reset previews keep reading the live state, which is already theirs.
    const state = restoreTourSeat ? completedTourState(getState()) : getState();
    const welcome = shouldShowRoomWelcome({ engaged, voice: state?.voice, tour: state?.tour });
    const form = restoreTourSeat && restingMenuSeat ? restingMenuSeat.collapsed : resetMenu && hidden ? true : collapsed;
    const panelRows = rows({ quiet: false, collapsed: form, state });
    // What the clearance solver was handed, kept for the `transition`
    // record the Done draw writes. Remembering a count is not measuring one:
    // nothing below reads it, and no draw depends on it.
    if (restoreTourSeat) restorePreviewRows = panelRows.length;
    const options = { measureText: toolbarTextWidth, head, rows: panelRows,
      readout: tourReadout(captionTour(state), state?.subject ?? welcome, undefined, { placement: state?.placementNote, descriptionPage: descriptionPageIndex() }),
      status: '' };
    // Done draws its completed rows at the currently held anchor. Measure
    // that same glass so a chapter menu moved by the wearer cannot make the
    // saved view solve against the older resting anchor.
    const seated = restoreTourSeat && restingMenuSeat;
    const preview = createToolbarPanel(seated
      ? { ...options, head: entryHead ?? restingMenuSeat.head, constants: restingMenuSeat.layout,
        seatAnchor: panel?.anchor && drawnRoomPoints([panel.anchor])[0] } : options);
    const points = toolbarPlatePoints(preview);
    if (!resetMenu && !restoreTourSeat) points.push(...platePoints());
    return { points, rows: panelRows, collapsed: form,
      readout: (preview?.readoutPoints ?? []).map(line => line.text),
      menuPoints: () => (preview ? toolbarDrawnMenuPoints(preview) : []),
      head: seated ? entryHead ?? restingMenuSeat.head : head,
      layout: seated ? restingMenuSeat.layout : SPATIAL_TOOLBAR_LAYOUT };
  }

  /** Full glass at an upcoming entry/reset seat, using the draw's live content. */
  function placementPoints(options) { return placementPreview(options).points; }

  /**
   * The caption card alone, in XR room metres.
   *
   * The framing seats the subject clear of THIS rectangle rather than of the
   * whole panel: the menu is dimmed during a lesson and the caption is the
   * thing that has to read. Same gate as `platePoints` — a hidden or closed
   * panel draws nothing and so owns no corner of the lens.
   */
  function captionPoints() {
    return panel && !closed && !hidden ? drawnRoomPoints(toolbarCaptionPoints(panel)) : [];
  }

  /**
   * How many columns a built grid folded its rows into.
   *
   * Read off the built buttons rather than recomputed from a row count and a
   * layout constant, so the record reports the fold that was drawn.
   */
  function panelColumns(built) {
    const buttons = built?.buttons ?? [];
    return buttons.length ? Math.max(...buttons.map(button => (button.column ?? 0) + 1)) : 0;
  }

  /** Actual menu glass for framing, absent while hidden. */
  function drawnMenuPoints() {
    return panel && !closed && !hidden ? drawnRoomPoints(toolbarDrawnMenuPoints(panel)) : [];
  }

  /** Reserved label obstacle, retained through grabs and asynchronous redraws. */
  function menuPoints() {
    return closed ? [] : hidden ? hiddenMenuPoints.map(point => [...point]) : drawnRoomPoints(seatedMenuPoints);
  }

  /**
   * One drawn-point set per button row, in XR room metres.
   *
   * The ghost-button pass checks ghost points against one rectangle per
   * button. Hidden controls contribute no ray targets.
   */
  function menuRows() {
    return panel && !closed && !hidden ? toolbarMenuRowPoints(panel).map(drawnRoomPoints) : [];
  }

  /**
   * Why the panel drawn right now differs from the one before it.
   *
   * Read once per committed redraw by `immersive-session.mjs`, which turns it
   * into the reason on the plate re-solve. One of `seat`, `reseat`, `collapse`,
   * `expand`, `follow` or `grow`, and occasionally a fold and a re-seat in the
   * same draw. Hidden redraws return no motion until reveal publishes their
   * accumulated reasons. Read-only: asking never changes what is drawn.
   */
  function menuMotion() { return [...lastMenuMotion]; }

  return Object.freeze({ update, syncBounds, syncPose, syncInput, depthRange, aimSynthetic, platePoints, placementPoints, placementPreview, prepareRelocation, commitRelocation, captionPoints, drawnMenuPoints, menuPoints, menuRows, menuMotion, setStatus,
    // What the status row is saying right now, read-only. A
    // command receipt expires after a few seconds of frames and must clear the
    // row only while the row still holds that receipt — a voice line or the
    // agent's reply written since then has to survive it.
    statusText: () => notice?.text ?? '',
    // The readout lines actually on the glass, top line first,
    // read-only. A device run checking that a status sentence retired had
    // nothing to read but a screenshot, and `tourReadout` recomputed in the
    // driver is a second opinion rather than the drawn plate.
    readoutText: () => (panel && !closed ? (panel.readoutPoints ?? []).map(line => line.text) : []),
    aimPoint: () => !closed && !hidden && aimPoint ? [...aimPoint] : undefined,
    layout, seatAnchor: () => panel?.anchor ? drawnRoomPoints([panel.anchor])[0] : undefined,
    setHidden, setDimmed, isDimmed: () => dimmed,
    blur, // A blind session drops its hover and its held press.
    isHidden: () => hidden,
    runAction: run, // Face buttons and voice need the toolbar's own action chain.
    unlatchSeat,
    isLatched: () => menuLatched,
    // Read-only, for the trigger modifier in xr-locomotion.mjs.
    isHandOnPanel: hand => !closed && !hidden && (hoverHands.has(hand)
      || [...capturedSources, ...wakeSources].some(source => source.handedness === hand)),
    // Read-only, for the natural-input adapter. A Vision Pro pinch
    // is one gesture for the whole headset, so the adapter has to know at
    // `selectstart` whether that ray started on this menu. `isHandOnPanel`
    // cannot answer it: ownership is decided from the pressing ray, and a
    // transient source has no stable hand to have been hovering with. The
    // reading is exactly `selectStart`'s own: visible glass or a drawn row,
    // plus the footprint the quiet menu would wake to.
    isRayOnPanel: ray => {
      if (closed || hidden || !panel || !ray) return false;
      const local = { ...ray, origin: ray.origin.map((v, i) => v - renderedOffset[i]) };
      if (hitToolbarPanel(panel, local) || hitToolbarGlass(panel, local)) return true;
      return standingBack ? hitToolbarFootprint(fullDrawPanel(), local) === true : false;
    },
    menuWithinView: frame => {
      let pose;
      try { pose = frame?.getViewerPose?.(space)?.transform; } catch { return false; }
      return !closed && !hidden && menuSeatWithinView(drawnRoomPoints(seatedViewPoints), pose);
    },
    /**
     * Which page of the source description the plate is showing.
     *
     * The counter is toolbar-local, so it never reached `getSpatialState` and
     * the driver had nothing to check a `description-page` press against: on
     * the Quest 2 all six presses turned the page on the display
     * and reported `[hook-press UNVERIFIED]`
     * This is exactly the call
     * `rows()` makes for the `Pg n/m` label, so the published index and the
     * drawn label cannot disagree, and it is read-only: asking never presses,
     * never redraws and never re-seats.
     */
    readout: () => descriptionPaging(getState()?.subject),
    head: () => entryHead, rows: () => rows(), rowCount: () => rows().length, isCollapsed: () => collapsed, dispose: async () => { cancelMenuDrag(); closed = true; cancelStatusHold(); sequence++; clearTimeout(pressTimer); pressTimer = undefined; pressIndex = -1; gestures.dispose(); for (const source of [...wakeSources]) cancelWake(source); await hoverDraw.catch(() => {}); session.removeEventListener('squeezestart', squeezeStart); session.removeEventListener('squeezeend', squeezeEnd); session.removeEventListener('squeezecancel', selectCancel); session.removeEventListener('selectstart', selectStart); session.removeEventListener('select', select); session.removeEventListener('selectend', selectEnd); session.removeEventListener('selectcancel', selectCancel); session.removeEventListener('inputsourceschange', sourceChange); await actionChain.catch(() => {}); await remove(); } });
}
