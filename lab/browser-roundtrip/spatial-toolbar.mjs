import { surfaceText } from './surface-text.mjs';
import { assistantStatus } from './assistant-status.mjs';
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
import { EPSILON, MENU_SEAT_DRIFT_DEGREES, MENU_SEAT_DRIFT_MS, SPATIAL_TOOLBAR_LAYOUT, createToolbarPanel, hitToolbarPanel, seatYawDriftDegrees, toolbarBackingOutline, toolbarLayoutForDepthRange, toolbarLayoutForOutboard, toolbarLayoutForStandoff, toolbarCaptionPoints, toolbarDrawnMenuPoints, toolbarMenuPoints, toolbarMenuRowPoints, toolbarPlateOutline, toolbarPlatePoints, toolbarGlassPlates, toolbarStatusGlass, toolbarSeatBasis, toolbarStandoffMeters, toolbarTextPoint } from './spatial-toolbar-geometry.mjs';
import { createSpatialToolbarGestureTracker, createToolbarPointerTracker } from './spatial-toolbar-gesture.mjs';
import { shouldShowRoomWelcome, spatialToolbarRows } from './spatial-toolbar-content.mjs';
import { growthPageRow, growthTierFromLessonId, tierCaptionName } from './growth-caption.mjs';
import { latchedStandoff } from './wearer-placement.mjs';
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
 * 2. The chapter card keeps the chapter's title and its whole caption for as
 *    long as the chapter is showing (`tourReadout`). The card is seated beside
 *    the molecule, outside its central cone, so the caption can stay without
 *    covering what the wearer came to look at.
 */

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
const crossProduct = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Small room-space separation between surface-baked type and its glass. */
const TEXT_LIFT_METERS = 0.003;

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
const TEXT_PROPS = Object.freeze({ attachment: 'middle-center', background: false, fontFamily: 'sans-serif', fontWeight: 'bold', fontQuality: 2 });

/** Atlas advances are shared by physical layout and the SDF glyph writer.
 * Corners are subsequently baked onto the menu/card plane by surfaceText.
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
  panel = { ...panel, right: target.right ?? panel.right, up: target.up ?? panel.up, normal: target.normal ?? panel.normal };
  const outline = options => (backing ? toolbarBackingOutline(panel, { ...options, plate: target }) : toolbarPlateOutline(panel, target, options));
  const face = outline({ inset: inset + bevel, depth: depth - lift, segments });
  const edge = outline({ inset, depth, segments });
  const centre = target.point.map((value, axis) => value - panel.normal[axis] * (lift - depth));
  if (!face.length || face.length !== edge.length) return undefined;
  return { face, edge, centre, outward: roomOutward(panel) };
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
  // Glyph corners are baked onto this surface, so only a small physical
  // lift is needed to clear the face; no camera-facing half-glyph overhang.
  const clearance = TEXT_LIFT_METERS;
  // Readout and status text is read against the backing glass, a button label
  // against its own plate; the sight line aims at that face.
  const glassBehind = (panel.backingDepthMeters ?? 0) - (panel.backingBorderMeters ?? 0) * 0.5;
  // Assistant type sits directly above its actual backing face.
  const statusClearance = clearance - glassBehind;
  const plateBehind = (panel.plateDepthMeters ?? 0) - (panel.faceLiftMeters ?? 0);
  const lifted = (point, behind = glassBehind) => toolbarTextPoint(panel, point, clearance, behind);
  return { ...panel, fontScene: panel.fontMeters, outward,
    plates: [...roomBacking(panel), ...roomPlates(panel)],
    buttons: panel.buttons.map(button => ({ ...button, scenePoint: lifted(button.point, plateBehind) })),
    statusScenePoint: lifted(panel.statusPoint),
    statusScenePoints: (panel.statusPoints ?? []).map(line => ({ ...line, right: panel.statusBacking?.right ?? panel.right, up: panel.statusBacking?.up ?? panel.up,
      scenePoint: toolbarTextPoint({ ...panel, normal: panel.statusBacking?.normal ?? panel.normal }, line.point, statusClearance, glassBehind),
      fontScene: line.fontMeters ?? panel.assistantFontMeters ?? panel.fontMeters })),
    // The chapter card has its own seat and faces the wearer, so its lines
    // run along the card's right axis, not the turned menu column's.
    readoutScenePoints: [...(panel.readoutPoints ?? []), ...(panel.readoutPageCue ? [panel.readoutPageCue] : [])].map(line => ({ ...line, right: panel.captionBacking?.right ?? panel.right, up: panel.captionBacking?.up ?? panel.up,
      scenePoint: toolbarTextPoint({ ...panel, normal: panel.captionBacking?.normal ?? panel.normal }, line.point, clearance, glassBehind), fontScene: line.fontMeters ?? panel.readoutFontMeters })) };
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

/**
 * How long a card page stands during a lesson before the next one turns.
 *
 * The page row is on the expanded menu only, so a wearer at the compact
 * controls had no way to the next page without two presses, and a held
 * chapter (not playing) never turned at all. Pages now turn on their own and
 * loop for as long as the chapter holds.
 */
export const CARD_PAGE_TURN_MS = 7_000;

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

/** A lesson is showing a chapter, or loading its first one. */
export const lessonUnderway = tour => tour?.active === true || tour?.navigating === true;

export function tourReadout(tour, welcome, nowMs = (globalThis.performance?.now?.() ?? Date.now()),
  { placement, descriptionPage = 0, statusRetired = false } = {}) {
  const subject = welcome && typeof welcome === 'object' && typeof welcome.title === 'string' ? welcome : undefined;
  const placed = placementPlateLines(placement);
  // Whoever draws this plate holds the title sentence for its window on
  // the frame clock and says here when the window is spent. It is a latch and
  // not a second duration on purpose: the only clock that may measure a
  // wearer's reading time is the one that delivers the frames they read it in.
  const retired = statusRetired === true;
  // Outside a lesson the structure's own card takes the chapter card's
  // forward seat, centred above the subject. Drawn above the menu column it
  // grew inboard to five degrees from the gaze, and the entry seat shrank a
  // plain structure to fifteen degrees to fit under its corner. The chooser
  // keeps its column card, and a lesson keeps its chapter card.
  const resting = lines => (tour?.selectedId && lessonUnderway(tour)) || tour?.menuOpen
    ? lines : lines.map(line => ({ ...line, forwardViewCap: true }));
  if (tour?.feedbackError && tour.feedback && !retired) return resting([{ text: toolbarTourFeedback(tour), ...(subject ? { maxLines: 2 } : {}) }, ...placed, ...structureReadout(subject, { descriptionPage })]);
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
    return resting([{ text: tour.feedback }, ...placed, ...structureReadout(subject, { descriptionPage })]);
  if (tour?.active === false && tour.feedback === 'Back to your view' && !retired) return resting([{ text: tour.feedback }, ...placed, ...structureReadout(subject, { descriptionPage })]);
  // A labelled figure can explicitly own its explanation. Hiding its card
  // must not substitute the source card or flash a preparation card whenever
  // the slide changes. Explicit Menu and failures above remain available.
  if (tour?.captionCard === 'hidden' && !tour.menuOpen && lessonUnderway(tour)) return [];
  if (tour?.chapterPreview) return [
    { text: `Preparing ${tour.chapterPreview.progress}`, whole: true },
    { text: tour.chapterPreview.title, whole: true },
    { text: tour.chapterPreview.bodyPage, whole: true },
    ...placed,
  ].map(line => ({ ...line, forwardViewCap: true }));
  if (tour?.menuOpen) return [
    { text: tour.selectedTitle || 'Choose a journey', maxLines: 2 },
    { text: tour.budgetNotice || 'Next one chooses. Tour starts.', maxLines: 3, optional: true },
    ...placed,
    ...structureReadout(subject, { descriptionPage }),
  ];
  if (!tour?.selectedId || tour.active === false) return resting([...placed, ...structureReadout(subject, { descriptionPage })]);
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
  // Chapter title and narration own the card. Dropping a prose page would
  // lose words permanently when autoplay advances to the next one. Use the
  // same whole-text protection as placement replies, inside the existing font
  // and glass limits.
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
  // The chapter card is the chapter: its title, where the lesson is, and the
  // whole caption, for as long as the chapter is showing.
  //
  // It used to keep the caption for a four-second reading window and then
  // fill the glass with the structure's own lines instead: the CRISPR card
  // showed its sentence once and then settled on `SpCas9 ternary` over
  // `complex,…`, the deposited title clipped, in place of the line the lesson
  // was written to say. The structure's description and identity belong to
  // the menu readout (the chooser, and every plate outside a lesson), never to
  // the chapter card, so they are not offered here at all.
  //
  // A narrated scene sends its whole spoken line (`wearerPages` in
  // `tour-player.ts` pages only the fallback prose that still needs the
  // `Page n/m` row). Do not ellipsize here: the geometry wraps once, at the
  // width the eye leaves, and only its own bound may end the last line.
  // Replies never replace that chapter.
  // The title and the counter share the card's first line
  // (`Wide reveal · 1/5`), which leaves its three other lines to the caption.
  // A title too long to share keeps the line to itself.
  const counter = tier ? progress : Number.isInteger(tour.step) && tour.step >= 0 && Number.isInteger(tour.total) && tour.total > 0
    ? `${tour.step + 1}/${tour.total}` : '';
  return [
    { text: counter ? `${title} · ${counter}` : title, ...(counter ? { compactText: title } : {}),
      whole: true, forwardView: tour?.active === true || tour?.step >= 0 },
    ...(captionText ? [{ text: captionText, whole: true, optional: false }] : []),
    ...placed,
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
    addChamferedPlate(state, plate, plate.outward ?? outward, slot * 2, slot * 2 + 1);
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
  if (!lessonUnderway(tour) || tour?.menuOpen === true) return false;
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
  getState = () => ({}), beforeMenuDraw = async () => {}, getEntryGeometry = () => ({}), getMolecularBounds = () => canvas.boundingSphereVisible, getDepthRange = () => ({}), onRepresentationChange = () => {}, onConsumeSelect = () => {},
  // The clock the title line's reading window is counted on. The page
  // owns it in production; a test that has to watch a six-second window close
  // supplies its own rather than waiting six seconds for it.
  now = () => (globalThis.performance?.now?.() ?? Date.now()) }) {
  // Compact controls leave the molecule the central view. Menu opens the rest.
  let representation, readoutRepresentation, plateRepresentation, stateRepresentation, hoverRepresentation, collapsed = true, mode = 'move', notice, panel, lastPanelOptions, lastLessonCard = false, entryHead, actionChain = Promise.resolve(), sequence = 0, closed = false, inputLocked = false, renderedLayout, renderedContent, poseSync, seatedStandoff = 0, hidden = false;
  // Menu is an explicit request for controls. A clearance proposal cannot
  // immediately fold that grid again, or the accepted press appears inert.
  // Retain that request through later status/chapter paints until Close.
  let expandedByWearer = false;
  let relocationSeat, drawnPanelOptions, solvedGeometry;
  // A seat the menu moved to for clearance is a forward seat: it was measured,
  // and admitted by the view band, as one. Every later draw there keeps that
  // glass, or the card would grow back past the band on the next redraw.
  const seatLayout = base => relocationSeat ? { ...base,
    ...(relocationSeat.plane ? { heldMenuPlane: relocationSeat.plane } : {}),
    ...(relocationSeat.lessonSide !== undefined ? { lessonSide: relocationSeat.lessonSide } : {}),
    ...(relocationSeat.forward ? { peripheralSeat: false } : {}),
    ...(relocationSeat.chapterCardBelow !== undefined ? { chapterCardBelow: relocationSeat.chapterCardBelow } : {}) } : base;
  let menuDrag, heldRepresentation, syntheticDrag, syntheticDragLast;
  // This is the translation actually on the render objects, including while a
  // released drag's replacement glyphs are still being built.
  let renderedOffset = [0, 0, 0];
  const appliedRoomOffsets = new WeakMap();
  function applyMenuRoomOffset(offset) {
    if (typeof presentation.setRoomOffset !== 'function') return;
    for (const target of [representation, readoutRepresentation, stateRepresentation, plateRepresentation, heldRepresentation]) {
      if (!target) continue;
      const previous = appliedRoomOffsets.get(target);
      if (previous && offset.every((value, axis) => value === previous[axis])) continue;
      // A fresh card always receives its offset. Keep our comparison separate
      // from both the drag's mutable array and the presentation's ownership.
      if (presentation.setRoomOffset(target, [...offset]) !== false) appliedRoomOffsets.set(target, [...offset]);
    }
  }
  // A bright room-space rim communicates that the whole menu is held. It
  // shares the glass translation and perspective, and is built once per grab.
  function clearHeldFeedback() {
    if (!heldRepresentation) return;
    heldRepresentation = drop(heldRepresentation);
    globalThis.__stereofoldDiagnostics?.record?.('toolbar', { phase: 'menu-held', held: false });
  }
  function showHeldFeedback(drag) {
    if (!panel || !drag?.active) return;
    if (drag.feedbackTask) return drag.feedbackTask;
    drag.feedbackPending = true;
    drag.feedbackTask = buildHeldFeedback(drag).catch(error => {
      drag.feedbackError = String(error?.message ?? error).slice(0, 160);
      globalThis.__stereofoldDiagnostics?.record?.('toolbar', { phase: 'menu-held-error', error: drag.feedbackError });
    }).finally(() => { drag.feedbackPending = false; });
    return drag.feedbackTask;
  }
  async function buildHeldFeedback(drag) {
    const plates = [...roomBacking(panel), ...roomPlates(panel)];
    const mesh = MeshBuilder.createState(plates.length * 96, plates.length * 48);
    mesh.currentGroup = 0;
    for (const plate of plates) {
      const inner = plate.face.map(point => point.map((v, i) => v + plate.outward[i] * .004));
      const outer = inner.map(point => {
        const radial = unit(point.map((v, i) => v - plate.centre[i] - plate.outward[i] * .004));
        return point.map((v, i) => v + radial[i] * .008);
      });
      for (let i = 0; i < inner.length; i++) {
        const j = (i + 1) % inner.length;
        MeshBuilder.addTriangleWithNormal(mesh, inner[i], outer[i], outer[j], plate.outward);
        MeshBuilder.addTriangleWithNormal(mesh, inner[i], outer[j], inner[j], plate.outward);
      }
    }
    const shape = Shape.create('Stereofold held menu rim', {}, MeshBuilder.getMesh(mesh),
      () => Color(0x55e5ff), () => 1, () => 'Moving menu');
    const target = ShapeRepresentation(async () => shape, Mesh.Utils,
      { modifyState: state => ({ ...state, pickable: false }) });
    try {
      await plugin.runTask(target.createOrUpdate({ alpha: 1, doubleSided: true, ignoreLight: true, emissive: .5 }, {}));
      if (menuDrag !== drag || !drag.active || hidden || closed) { target.destroy(); return; }
      clearHeldFeedback(); heldRepresentation = target;
      presentation.add(target, { roomLocked: true });
      applyMenuRoomOffset(renderedOffset);
      globalThis.__stereofoldDiagnostics?.record?.('toolbar', { phase: 'menu-held', held: true, kind: drag.kind ?? 'trigger' });
    } catch (error) {
      if (heldRepresentation === target) heldRepresentation = drop(heldRepresentation);
      else try { target.destroy(); } catch {}
      throw error;
    }
  }
  let redrawAfterDrag;
  const gripReleaseRequired = new Set();
  // Why clearance hid the menu: `true` for a checked appearance seat,
  // 'chapter' for menu admission, which shows it again once its glass clears.
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
  const wearerOwnsSeat = () => seatReason === 'menu-drag' || seatReason === 'molecule-placement';
  let observedPlacementMoves = getState()?.placementMoves ?? 0;
  function syncPlacementSeat() {
    const placementMoves = getState()?.placementMoves ?? observedPlacementMoves;
    if (placementMoves !== observedPlacementMoves) {
      observedPlacementMoves = placementMoves;
      // Moving the molecule chooses its position relative to the already
      // drawn menu. A changed molecular silhouette must not chase that move
      // with a new menu seat, even if the menu itself has never been dragged.
      if (panel && !wearerOwnsSeat() && !menuReseatRequested) {
        const constants = chapterCardSeat?.constants ?? drawnPanelOptions?.constants ?? renderedLayout;
        relocationSeat = { ...relocationSeat, anchor: [...panel.anchor], layout: { ...constants },
          plane: { right: [...panel.right], normal: [...panel.normal] },
          lessonSide: constants.lessonSide, forward: constants.peripheralSeat === false,
          chapterCardBelow: constants.chapterCardBelow };
        entryHead = chapterCardSeat?.head ?? entryHead;
        chapterCardSeat = undefined;
        seatReason = 'molecule-placement';
      }
    }
  }
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
  let chapterCardSeat;
  let renderedPanelSignature;
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
    observedPlacementMoves = getState()?.placementMoves ?? observedPlacementMoves;
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
   * The tour state the readout's timed sentences need, which an older tour
   * player does not carry: `chapterStartedAt` prefers the tour player's own
   * stamp and falls back to when this toolbar first saw the chapter change, on
   * the same clock.
   */
  function captionTour(state) {
    const tour = state?.tour;
    if (!tour) return tour;
    return { ...tour,
      chapterStartedAt: Number.isFinite(tour.chapterStartedAt) ? tour.chapterStartedAt : chapterStartedAt };
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
    if (state?.tour?.sourceTransition) return state;
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
  // The card's own pages. The glass is never taller than the view band beside
  // the structure, so a readout it cannot hold whole at any font is drawn in
  // pages of the glass (`readoutPage` in `createToolbarPanel`). `cardPage` is
  // the page asked for and `cardPageCount` what the drawn card had, for the
  // readout it drew. A new readout opens at its first page. The Pg row turns
  // a page by hand, and during a lesson `turnCardPage` turns them in the
  // frames the wearer was shown, every `CARD_PAGE_TURN_MS`.
  let cardPage = 0, cardPageOf, cardPageCount = 1, cardPagedOf, cardPageShownAt, cardRowsCorrectedFor, cardReadOf, cardVisitOf;
  const readoutSignature = readout => (readout ?? []).map(line => line?.text ?? '').join('\u0000');
  const cardReadingSignature = text => JSON.stringify([cardVisitOf, text]);
  function cardPageFor(readout) {
    const text = readoutSignature(readout);
    if (text !== cardPageOf) { cardPageOf = text; cardPage = 0; cardPageShownAt = undefined; cardReadOf = undefined; }
    return cardPage;
  }
  // The same page, read only: a measurement must not turn or reset it.
  const cardPageAt = readout => readoutSignature(readout) === cardPageOf ? cardPage : 0;
  // The readout `update()` draws for this state.
  function drawnReadout(state) {
    const welcome = shouldShowRoomWelcome({ engaged, voice: state?.voice, tour: state?.tour });
    return tourReadout(captionTour(state), state?.subject ?? welcome, undefined,
      { placement: state?.placementNote, descriptionPage: descriptionPageIndex(), statusRetired: plateStatusRetired });
  }
  // What the Pg row counts: the card's own pages while the drawn card is
  // this state's readout in pages, and the source description's otherwise.
  function readoutPaging(state) {
    const count = cardPageCount > 1 && cardPagedOf === readoutSignature(drawnReadout(state)) ? cardPageCount : 1;
    return { ...descriptionPaging(state?.subject), cardPageCount: count, cardPageIndex: count > 1 ? cardPage % count : 0 };
  }
  function turnCardPage() {
    if (closed || cardPagedOf !== cardPageOf || getState()?.tour?.active !== true) { cardPageShownAt = undefined; return; }
    const at = readoutNow();
    if (!Number.isFinite(cardPageShownAt)) { cardPageShownAt = at; return; }
    if (!(at - cardPageShownAt >= CARD_PAGE_TURN_MS)) return;
    // The last page has stood its full time, so the chapter may move on.
    if (cardPage % cardPageCount === cardPageCount - 1) cardReadOf = cardReadingSignature(cardPageOf);
    if (cardPageCount <= 1) return;
    cardPage = (cardPage + 1) % cardPageCount; cardPageShownAt = undefined;
    void update({ origin: 'status' }).catch(() => {});
  }
  // How long the drawn card still needs before its last page has stood
  // `CARD_PAGE_TURN_MS`, counted in frames the wearer was shown. Autoplay
  // holds the chapter for it. A card nobody can see owes nothing.
  function cardHoldMs(state) {
    const text = readoutSignature(drawnReadout(state));
    if (closed || hidden || !panel?.captionBacking || cardPagedOf !== text || cardReadOf === cardReadingSignature(text)
      || state?.tour?.active !== true) return 0;
    const shown = Number.isFinite(cardPageShownAt) ? readoutNow() - cardPageShownAt : 0;
    const left = cardPageCount - 1 - cardPage % cardPageCount;
    return left * CARD_PAGE_TURN_MS + Math.max(0, CARD_PAGE_TURN_MS - shown);
  }
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
    if (state?.tour?.sourceTransition) form = true;
    // A wake changes emphasis, not the lesson's shape. Menu explicitly opens
    // the grid; transport and source notifications retain the quiet controls.
    if (form && lessonUnderway(state?.tour) && !state?.tour?.menuOpen) quiet = true;
    // `passthrough` is what turns the row from a feature name into
    // a reading of the session the wearer is actually in.
    // A level only reaches here from a viewer that has the
    // render-budget lever, and only then does the quality row exist.
    // `quiet` defaults to the drawn state, and the footprint
    // wake below asks for the full set explicitly.
    return spatialToolbarRows({ connection: state?.connection, tour: state?.tour, voice: state?.voice, collapsed: form, mode, paused: Boolean(state?.motion?.paused),
      quiet, sequence: state?.sequence, readout: readoutPaging(state),
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
      return createToolbarPanel({ stableLesson: collapsed && lessonUnderway(tour) && !tour?.menuOpen && !state?.sequence?.open,
        measureText: toolbarTextWidth, rows: fullRows, head: entryHead, constants: seatLayout(layout()),
        readout: tourReadout(captionTour(state), state?.subject ?? welcome, undefined, { placement: state?.placementNote, descriptionPage: descriptionPageIndex() }),
        status: '', assistantLines: assistantStatus.panelLines(), assistantGlance: assistantStatus.panelGlance(), seatAnchor: relocationSeat?.anchor ?? chapterCardSeat?.columnAnchor ?? panel?.anchor, readoutPage: cardPage });
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
    const p = pose?.transform?.position, matrix = pose?.transform?.matrix;
    return p && [p.x, p.y, p.z].every(Number.isFinite)
      ? { origin: [p.x, p.y, p.z], emulatedPosition: pose.emulatedPosition,
        ...(matrix?.length === 16 && Array.from(matrix).every(Number.isFinite)
          ? { rotation: [matrix[0], matrix[1], matrix[2], matrix[4], matrix[5], matrix[6], matrix[8], matrix[9], matrix[10]] } : {}) } : undefined;
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
        status: '', assistantLines: assistantStatus.panelLines() });
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
   * whatever it clears. If no menu candidate clears, the best proposal is
   * handed to beforeMenuDraw, which moves the chapter into the remaining field
   * before the new glass can draw. A failed proof keeps the previous panel.
   *
   * The latch is what keeps the panel from swinging every frame (see the note
   * on `menuLatched`), so this runs on the edge alone -- the drawn column count
   * or framing envelope/placement changing -- and never from `syncPose`.
   *
   * @param {object} options
   * @param {Array} options.panelRows the rows this draw will draw
   * @param {Array} options.readout the caption lines, which set the plate height
   * @param {string} options.status the status row text
   * @returns {boolean} whether the caller must rebuild its layout
   */
  function reseatForTourColumns({ panelRows, readout = [], status = '', assistantLines = [], seatAnchor }) {
    if (wearerOwnsSeat()) return false;
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
    // Reuse the answer only while both the grid and its framing envelope stay
    // unchanged. A resize can consume the old gap without adding any columns.
    const geometry = getEntryGeometry();
    const geometryKey = geometry?.clearanceKey;
    if (columns === solvedColumns && geometryKey === solvedGeometry) return false;
    // The preconditions `measureEntryStandoff` holds. Unreadable stereo geometry
    // certifies nothing, and a ladder walked for an answer that can only be
    // `undefined` costs one panel build a rung for nothing.
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
        constants, geometry, readout, status, assistantLines, factors, seatAnchor, measureStandoff });
      // A frame that cannot be measured at one candidate cannot be measured at
      // the next either. Leave the draw alone rather than fold on no evidence.
      if (!seat?.measured) return false;
      const built = createToolbarPanel({ measureText: toolbarTextWidth, rows: panelRows, head: entryHead,
        constants: seat.constants, readout, status, seatAnchor, readoutPage: cardPageFor(readout),
        // Reserve the status footprint even before the first host heartbeat.
        // Otherwise a tall fold can fit now and clip on listener attachment.
        assistantLines: assistantLines.length || base.peripheralSeat === true ? assistantLines : ['', '', ''] });
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
    solvedGeometry = geometryKey;
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
    if (wearerOwnsSeat() && relocationSeat?.layout) return seatLayout(relocationSeat.layout);
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
    turnCardPage();
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
    clearHeldFeedback();
    disposeHighlight();
    // Nothing is drawn any more, so the next update has nothing to match
    // against and must rebuild whatever it is asked for.
    renderedContent = undefined;
    renderedPanelSignature = undefined;
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
      void showHeldFeedback(menuDrag);
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
    // Diagnostic input is explicit, bounded, and never added to XRSession.
    // Real per-frame head tracking still drives all clearance checks.
    if (syntheticDrag) {
      frame = syntheticDragFrame(frame);
      extraSources = [...(extraSources ?? []).filter(source => source !== syntheticDrag.source), syntheticDrag.source];
    }
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

  async function update({ restoreTourSeat = false, restartTourSeat = false, recenter = false, resetMenu = false, recheckClearance = false, origin = 'host' } = {}) {
    // Reset must finish this draw before its caller captures the molecule.
    // Keep the visible menu's form; recover a hidden menu in compact form.
    if (resetMenu) {
      if (hidden) collapsed = true;
      clearanceHidden = false; setHidden(false);
    }
    if (menuDrag?.active) return;
    if (origin !== 'menu-drag' && inputLocked && renderedOffset.some(v => v !== 0)) {
      redrawAfterDrag = { restoreTourSeat: redrawAfterDrag?.restoreTourSeat || restoreTourSeat,
        restartTourSeat: redrawAfterDrag?.restartTourSeat || restartTourSeat,
        recenter: redrawAfterDrag?.recenter || recenter, origin };
      return;
    }
    // A host notice can arrive while a Menu or Reset press is waiting for its
    // next XR pose. Let the press finish the seat before drawing that notice.
    if (origin !== 'wearer' && (menuReseatRequested || (!menuLatched && entryHead && seatReason !== 'entry'))) {
      redrawAfterReseat = { restoreTourSeat: redrawAfterReseat?.restoreTourSeat || restoreTourSeat,
        restartTourSeat: redrawAfterReseat?.restartTourSeat || restartTourSeat, origin: 'host' };
      return;
    }
    const own = ++sequence;
    const spatialState = getState();
    const currentTour = spatialState?.tour;
    syncPlacementSeat();
    if (restoreTourSeat && restingMenuSeat) {
      if (!restartTourSeat && ['entry', 'clearance'].includes(seatReason) && restingMenuSeat.anchor) {
        // Automatic lesson clearance does not become a wearer menu move.
        // Done restores its prior room anchor; an actual menu drag keeps it.
        entryHead = restingMenuSeat.head;
        relocationSeat = restingMenuSeat.relocationSeat ?? { anchor: restingMenuSeat.anchor };
        chapterCardSeat = undefined;
        seatReason = 'entry';
      }
      // Opening chapter framing must measure the entry glass, before any
      // later chapter's clearance move. Done still keeps the wearer's seat.
      if (restartTourSeat && !wearerOwnsSeat()) {
        entryHead = restingMenuSeat.head;
        relocationSeat = restingMenuSeat.relocationSeat;
        chapterCardSeat = undefined;
        menuReseatRequested = true;
        seatReason = 'entry'; solvedColumns = 0; menuFoldMaxRows = undefined;
        renderedContent = undefined;
      }
      // Done restores the completed reading on the held anchor. Only a
      // wearer request can restore the old head pose as a new room seat.
      if (origin === 'wearer' && !wearerOwnsSeat()) entryHead = restingMenuSeat.head;
      collapsed = restingMenuSeat.collapsed;
      seatedStandoff = restingMenuSeat.standoff;
      entryOutboard = restingMenuSeat.outboard;
      restoredMenuLayout = restingMenuSeat.layout;
      menuLatched = true;
      tourSeatRestorePending = !restartTourSeat;
      // From here the panel presents the completed menu
      // the preview measured, however long the player takes to say so.
      donePresentationPending = !restartTourSeat;
      donePresentationOf = tourReadingSignature(currentTour);
      if (origin === 'wearer' && !wearerOwnsSeat()) menuReseatRequested = true;
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
    const visit = JSON.stringify([tour?.selectedId, tour?.step, tour?.chapterStartedAt]);
    if (visit !== cardVisitOf) {
      cardVisitOf = visit;
      cardPage = 0; cardPageOf = undefined; cardPageShownAt = undefined;
      cardReadOf = undefined; cardRowsCorrectedFor = undefined;
    }
    // What this draw presents. It differs from the
    // published state only while Done's restore is pending, and there it is
    // exactly what the clearance solver measured. Seat holding, the chapter
    // clock and the resting-seat capture below keep reading `state` and
    // `tour`, so this changes what is drawn and never where it is drawn.
    const presented = presentationState(state);
    const presentedTour = presented?.tour;
    // Later chapter framing must still measure its original preview field.
    const fitCaption = presented?.densityMap === true && presentedTour?.active === true && presentedTour?.step === 0
      && presentedTour?.navigating !== true && !presentedTour?.chapterPreview;
    if (presentedTour?.sourceTransition) collapsed = true;
    // When this chapter arrived, for the readout's timed
    // sentences. `tour-player.ts` stamps its own on the same clock; this covers a
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
    const heldAnchor = relocationSeat?.anchor ?? (menuReseatRequested ? undefined : chapterCardSeat ? chapterCardSeat.columnAnchor : panel?.anchor);
    if (reseatForTourColumns({ panelRows, readout: panelReadout,
      status: '', assistantLines: assistantStatus.panelLines(), seatAnchor: heldAnchor })) {
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
    const stableLesson = collapsed && lessonUnderway(presentedTour) && !presentedTour?.menuOpen && !presented?.sequence?.open;
    const contentSignature = JSON.stringify([physicalLayoutSignature, seatSignature, relocationSeat, fitCaption, stableLesson, wearerOwnsSeat() ? null : getEntryGeometry({ keyOnly: true })?.clearanceKey,
      panelRows, panelReadout, cardPageFor(panelReadout), assistantStatus.panelLines()]);
    if (representation && !menuReseatRequested && !recheckClearance && contentSignature === renderedContent) return;
    const panelOptions = { stableLesson,
      measureText: toolbarTextWidth, rows: panelRows, head: entryHead, constants: { ...seatLayout(physicalLayout), fitChapterCaption: fitCaption }, readout: panelReadout, status: '', assistantLines: assistantStatus.panelLines(), assistantGlance: assistantStatus.panelGlance(), seatAnchor: heldAnchor, readoutPage: cardPageFor(panelReadout) };
    if (relocationSeat?.glance) panelOptions.assistantLines = panelOptions.assistantGlance;
    lastPanelOptions = panelOptions;
    let nextPanel = createToolbarPanel(panelOptions), nextChapterCardSeat;
    if (relocationSeat?.statusAside) nextPanel = { ...nextPanel, statusBacking: undefined, statusPoints: [], statusPoint: nextPanel.buttons[0].point };
    // A least-overlapping grid is only a proposal. The viewer must clear its
    // complete glass against the all-pose envelope before any new mesh draws.
    // A worker relocation already proved the pending molecular placement;
    // checking the outgoing placement here would invalidate its transaction.
    // A lesson under way, or loading its first chapter: its card and menu
    // never hide themselves to clear a chapter.
    const lesson = lessonUnderway(presentedTour);
    lastLessonCard = lesson;
    // A released menu belongs to the wearer. Clearance is an automatic
    // placement proposal, not permission to undo a drag on release or on the
    // next chapter/status redraw. Head clearance is enforced during the drag.
    if (origin !== 'clearance' && !wearerOwnsSeat()) {
      const clearance = await beforeMenuDraw({ points: toolbarPlatePoints(nextPanel), glass: toolbarGlassPlates(nextPanel), statusGlass: toolbarStatusGlass(nextPanel),
        ...(chapterCardSeat && !hidden ? { currentPoints: toolbarPlatePoints(panel), currentGlass: toolbarGlassPlates(panel) } : {}),
        isCurrent: () => own === sequence && !closed, lesson,
        relocationCandidates: pose => menuRelocationCandidates(panelOptions, entryHead, pose),
        chapterCardCandidates: pose => presentedTour?.active && collapsed
          ? menuRelocationCandidates(panelOptions, entryHead, { ...pose, cardOnly: true }) : [] });
      if (own !== sequence || closed) return;
      if ((getState()?.placementMoves ?? observedPlacementMoves) !== observedPlacementMoves) return update({ origin });
      if (clearance?.chapterCardSeat) {
        nextChapterCardSeat = { ...clearance.chapterCardSeat, columnAnchor: nextPanel.anchor };
        nextPanel = nextChapterCardSeat.panel;
      }
      if (clearance?.menuRelocation) {
        const seat = clearance.menuRelocation;
        relocationSeat = { anchor: seat.anchor, lessonSide: seat.constants?.lessonSide, forward: seat.constants?.peripheralSeat === false, chapterCardBelow: seat.constants?.chapterCardBelow, glance: seat.glance, statusAside: seat.statusAside }; entryHead = seat.head; seatReason = 'clearance';
        Object.assign(panelOptions, { head: entryHead, constants: seat.constants, seatAnchor: seat.anchor });
        nextPanel = seat.panel ?? createToolbarPanel(panelOptions);
      }
      if (clearance?.obstructed) {
        // No seat of this glass clears the chapter. An automatic expanded
        // grid folds and is checked again. A grid explicitly opened by Menu
        // stays available until Close, including through chapter redraws.
        // Folded glass may hide outside a lesson; B/Y or Menu brings it back.
        if (!collapsed && !expandedByWearer) {
          collapsed = true;
          globalThis.__stereofoldDiagnostics?.record?.('toolbar', { phase: 'fold', reason: 'clearance' });
          return update({ origin });
        }
        if (!hidden && !lesson && !expandedByWearer) {
          clearanceHidden = 'chapter';
          setHidden(true);
          globalThis.__stereofoldDiagnostics?.record?.('toolbar', { phase: 'seat-commit', reason: 'clearance', hidden: true,
            hint: 'Controls hidden to clear the structure. B/Y brings them back.' });
        } else if (lesson && hidden && clearanceHidden && clearanceHidden !== 'recovery') {
          // Glass a clearance hid before the lesson comes back for it.
          clearanceHidden = false;
          setHidden(false);
        }
      } else if ((clearanceHidden === 'chapter' || (lesson && clearanceHidden)) && !clearance?.unmeasured) {
        // The next chapter's glass clears again, or a lesson keeps it. Glass
        // no eye can measure proves nothing, so hidden glass stays hidden.
        clearanceHidden = false;
        setHidden(false);
      }
    }
    if (own !== sequence || closed) return;
    // A summoned panel may need the newer observed pose before its draw.
    if (!nextChapterCardSeat && origin === 'wearer' && menuReseatRequested && latestViewerHead && entryHead !== latestViewerHead
      && !menuSeatWithinView([...toolbarDrawnMenuPoints(nextPanel), ...toolbarCaptionPoints(nextPanel)], latestViewerHead)) {
      unlatchSeat('view-band', { reseat: true });
      entryHead = latestViewerHead;
      return update({ origin });
    }
    // A changed molecular clearance key owes a fresh clearance proof, but
    // need not re-upload unchanged menu text and glass. Compare the complete
    // resolved physical panel, including every style and text metric; actions
    // are refreshed below independently of their identical drawn geometry.
    const panelSignature = JSON.stringify({ ...nextPanel,
      buttons: nextPanel.buttons.map(({ action, ...button }) => button) });
    if (representation && !menuReseatRequested && !restoreTourSeat && !resetMenu && !tourSeatRestorePending
      && origin !== 'menu-drag' && origin !== 'clearance' && renderedOffset.every(v => v === 0)
      && panelSignature === renderedPanelSignature) {
      if (JSON.stringify(panel?.buttons.map(button => button.action)) !== JSON.stringify(nextPanel.buttons.map(button => button.action))) {
        if (menuDrag) cancelMenuDrag();
        gestures.dispose();
      }
      panel = nextPanel; drawnPanelOptions = panelOptions; chapterCardSeat = nextChapterCardSeat;
      renderedContent = contentSignature; renderedLayout = physicalLayout; lastMenuMotion = [];
      cardPageCount = nextPanel.readoutPageCount ?? 1; cardPagedOf = readoutSignature(panelReadout);
      return;
    }
    const mapped = roomPanel(nextPanel);
    if (!mapped || own !== sequence || closed) return;
    const readout = [...mapped.readoutScenePoints, ...mapped.statusScenePoints].filter(line => line.scenePoint);
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
    const labelShape = Shape.create('Stereofold spatial toolbar', {}, surfaceText(labelBuilder.getText(), mapped),
      () => Color(PALETTE.text), () => 1,
      groupId => nextPanel.buttons[groupId]?.label ?? 'Spatial control');
    const next = ShapeRepresentation(async () => labelShape, Text.Utils, { modifyState: state => ({ ...state, pickable: false }) });
    const stateGlyphs = stateButtons.reduce((total, { button }) => total + (button.label?.length ?? 0), 0);
    let nextState;
    if (stateButtons.length > 0) {
      const stateBuilder = TextBuilder.create(TEXT_PROPS, Math.max(1, stateGlyphs), Math.max(1, stateGlyphs));
      stateButtons.forEach(({ button, index }) => { if (button.scenePoint) addGlyphs(stateBuilder, button.label, { origin: button.scenePoint, right: mapped.right, size: mapped.fontScene, group: index }); });
      const stateShape = Shape.create('Stereofold spatial toolbar state', {}, surfaceText(stateBuilder.getText(), mapped),
        () => Color(PALETTE.text), () => 1,
        groupId => nextPanel.buttons[groupId]?.label ?? 'Spatial control');
      nextState = ShapeRepresentation(async () => stateShape, Text.Utils, { modifyState: state => ({ ...state, pickable: false }) });
    }

    const floatingLines = readout.map(line => ({ text: line.text, scenePoint: line.scenePoint, fontScene: line.fontScene, right: line.right ?? mapped.right, up: line.up ?? mapped.up, color: PALETTE.text, name: line.text }));
    const readoutGlyphs = floatingLines.reduce((total, line) => total + line.text.length, 0);
    const readoutBuilder = TextBuilder.create(TEXT_PROPS, Math.max(1, readoutGlyphs), Math.max(1, readoutGlyphs));
    floatingLines.forEach((line, index) => addGlyphs(readoutBuilder, line.text, { origin: line.scenePoint, right: line.right, size: line.fontScene, group: index }));
    const readoutShape = Shape.create('Stereofold toolbar readout', {}, surfaceText(readoutBuilder.getText(), floatingLines),
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
      renderedPanelSignature = panelSignature;
      chapterCardSeat = nextChapterCardSeat;
      drawnPanelOptions = panelOptions;
      cardPageCount = nextPanel.readoutPageCount ?? 1; cardPagedOf = readoutSignature(panelReadout);
      // The rows were laid out before this card was, from the last card's
      // pages. When that adds or drops the Pg row, lay them out once more.
      const pageRow = list => list.some(row => row.action?.kind === 'readout-page');
      if (cardPagedOf !== cardRowsCorrectedFor && pageRow(rows()) !== pageRow(panelRows)) {
        cardRowsCorrectedFor = cardPagedOf;
        queueMicrotask(() => { void update({ origin: 'status' }).catch(() => {}); });
      }
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
        restingMenuSeat = { head: entryHead, anchor: [...nextPanel.anchor], collapsed, standoff: seatedStandoff,
          relocationSeat,
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
        if (panelOptions.stableLesson) globalThis.__stereofoldDiagnostics?.record?.('toolbar', {
          phase: 'lesson-layout', rows: nextPanel.buttons.length, statusLines: nextPanel.statusPoints.length, hidden, fontMeters: nextPanel.fontMeters,
          assistantFontMeters: nextPanel.assistantFontMeters ?? null,
          statusDrawFontMeters: mapped.statusScenePoints[0]?.fontScene ?? null,
          right: [...nextPanel.right], menuSize: [nextPanel.backing.halfWidth, nextPanel.backing.halfHeight],
          statusSize: nextPanel.statusBacking ? [nextPanel.statusBacking.halfWidth, nextPanel.statusBacking.halfHeight] : [],
        });
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
    void showHeldFeedback(menuDrag);
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
  function run(action, { origin = 'wearer' } = {}) {
    if (!acceptsInput()) return;
    // Cancellation is admitted at the press, before joining an older fit's
    // action chain. The next action still waits for its rollback and draw.
    if (typeof onActionIntent === 'function') onActionIntent(action, { origin });
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
      syncPlacementSeat();
      // Molecular placement updates sometimes request an automatic menu
      // recovery. They cannot revoke an explicit wearer menu placement.
      if (action.kind === 'recenter-menu' && action.reason === 'placement' && wearerOwnsSeat()) return;
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
          expandedByWearer = action.value === false;
          gestures.dispose();
          inputLocked = relocating = true;
          // Opening/closing controls changes their contents, not the room
          // position the wearer deliberately chose. Re-seat is explicit.
          if (!wearerOwnsSeat()) unlatchSeat('menu');
        } else if (action.kind === 'recenter-menu') {
          if (clearanceHidden) { clearanceHidden = false; setHidden(false); }
          gestures.dispose();
          inputLocked = relocating = true;
          // `reset` alone frees the standoff and retains the old head. This
          // explicit menu re-seat must acquire the wearer's current pose too.
          unlatchSeat(action.reason ?? 'menu', { reseat: true });
        } else if (action.kind === 'recenter-structure' || action.kind === 'reset') {
          // The viewer re-seats the menu after a successful structure reset.
          // Do not discard a wearer seat before that reset can succeed.
          await onAction(action);
        } else if (action.kind === 'readout-page') {
          // Paging the source description is a plate-local read, like
          // the mode row above. It changes no scene, takes no receipt and
          // reaches no host, so it never leaves this closure.
          // A card drawn in pages turns its own page first, and moves to the
          // description's next page once its last card page has been read.
          if (readoutPaging(presentationState()).cardPageCount > 1) {
            cardPage = (cardPage + 1) % cardPageCount; cardPageShownAt = undefined;
            if (cardPage === 0) descriptionPage++;
          } else descriptionPage++;
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
    return actionChain;
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
      clearHeldFeedback();
      if (drag.active) {
        gestures.cancel(event.inputSource); endPress(); inputLocked = true;
        event.preventDefault?.(); event.stopImmediatePropagation?.();
        const previous = relocationSeat ?? { anchor: drag.anchor }, previousHead = entryHead, previousReason = seatReason;
        const plane = { right: [...panel.right], normal: [...panel.normal] };
        const seat = { ...relocationSeat, plane, layout: renderedLayout,
          anchor: drag.anchor.map((value, axis) => value + drag.offset[axis]) };
        // entryHead is the panel's saved room frame, not the live tracked head.
        // Translate it with the control anchor so independent chapter/status
        // cards keep the exact translation that was visible during the drag.
        const seatHead = anchor => {
          const offset = anchor.map((v, i) => v - drag.anchor[i]);
          const transform = previousHead.transform ?? previousHead;
          const position = { x: transform.position.x + offset[0], y: transform.position.y + offset[1], z: transform.position.z + offset[2] };
          const matrix = Array.from(transform.matrix);
          matrix[12] = position.x; matrix[13] = position.y; matrix[14] = position.z;
          return { position, matrix };
        };
        // Check the final rigid geometry against the latest actual head,
        // including a wearer who walked into the held glass before release.
        // Retain the last actual head sample through a short tracking gap; no
        // emulated controller position or invented head pose supplies travel.
        const head = drag.head ?? drag.lastHead;
        const clear = anchor => toolbarHeadClearance(createToolbarPanel({ ...drawnPanelOptions,
          head: seatHead(anchor), constants: { ...drawnPanelOptions.constants, heldMenuPlane: plane }, seatAnchor: anchor }), head);
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
          // Move out only as far as the actual head clearance needs,
          // preserving the held pose instead of snapping home.
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
        relocationSeat = seat; entryHead = seatHead(seat.anchor); seatReason = 'menu-drag';
        void update({ origin: 'menu-drag' }).catch(async () => {
          if (relocationSeat !== seat) return;
          relocationSeat = previous; entryHead = previousHead; seatReason = previousReason;
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
    if (syntheticDrag?.source === menuDrag.source) {
      clearTimeout(syntheticDrag.timer);
      syntheticDragLast = { ...syntheticDragLast, held: dragSnapshot(), ended: 'cancelled' };
      syntheticDrag = undefined;
    }
    menuDrag = undefined; inputLocked = false;
    clearHeldFeedback();
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
  // Diagnostic snapshots contain menu geometry only, never molecular data.
  function dragSnapshot() {
    const points = platePoints().slice(0, 2048).filter(point => point.every(Number.isFinite));
    // Separate physical plate geometry from readout line counts. Live content
    // can change during a held drag; an extra caption line is not menu motion.
    const plane = plate => ({ right: [...(plate.right ?? panel.right)], up: [...(plate.up ?? panel.up)], normal: [...(plate.normal ?? panel.normal)] });
    const geometry = panel ? {
      rows: panel.buttons.map(button => ({ id: String(button.id ?? ''), point: drawnRoomPoints([button.point])[0],
        halfWidth: button.halfWidth, halfHeight: button.halfHeight })),
      plates: [['controls', panel.backing], ['caption', panel.captionBacking], ['status', panel.statusBacking]]
        .filter(([, plate]) => plate).map(([kind, plate]) => ({ kind, point: drawnRoomPoints([plate.point])[0],
          halfWidth: plate.halfWidth, halfHeight: plate.halfHeight, ...plane(plate) })),
    } : { rows: [], plates: [] };
    return { geometry, anchor: panel?.anchor ? drawnRoomPoints([panel.anchor])[0] : null,
      plane: panel ? { right: [...panel.right], up: [...panel.up], normal: [...panel.normal] } : null,
      points, holding: Boolean(menuDrag?.active), heldFeedback: Boolean(heldRepresentation),
      feedbackPending: Boolean(menuDrag?.feedbackPending), feedbackError: menuDrag?.feedbackError ?? null,
      pending: inputLocked && !menuDrag, hidden };
  }
  function syntheticDragFrame(frame) {
    const drag = syntheticDrag;
    return {
      getPose(target, base) {
        if (drag && base === space) {
          if (target === drag.source.targetRaySpace) return drag.pose;
          if (target === drag.source.gripSpace) return drag.gripPose;
        }
        return frame?.getPose?.(target, base);
      },
      getViewerPose(base) {
        return frame?.getViewerPose ? frame.getViewerPose(base)
          : { transform: latestViewerHead?.transform ?? latestViewerHead ?? entryHead?.transform ?? entryHead };
      },
    };
  }
  async function waitForSyntheticFeedback(drag) {
    if (!drag?.feedbackTask) return;
    let timer;
    try {
      // Mol*'s task runner can yield beyond a pair of microtasks on hardware.
      // Report the installed rim, or an explicit bounded pending state.
      await Promise.race([drag.feedbackTask, new Promise(resolve => { timer = setTimeout(resolve, 1500); })]);
    } finally { clearTimeout(timer); }
  }
  async function dragSynthetic(request = {}) {
    const base = { method: 'synthetic-menu-drag', simulates: 'controller pose, not a hand or a wearer' };
    const reply = extra => ({ ...base, ...syntheticDragLast, current: dragSnapshot(), ...extra });
    if (request.phase === 'state') return reply({ active: Boolean(syntheticDrag) });
    if (request.phase === 'begin') {
      if (closed || hidden || !panel || inputLocked || menuDrag || capturedSources.size || syntheticDrag || !acceptsInput())
        return reply({ accepted: false, reason: 'menu unavailable or an input already owns it' });
      if (!['trigger', 'grip'].includes(request.kind)) return reply({ accepted: false, reason: 'kind must be trigger or grip' });
      const index = panel.buttons.findIndex(button => String(button.id ?? '') === request.id);
      const ray = index >= 0 ? toolbarAimRay(panel, { row: index }) : undefined;
      if (!ray) return reply({ accepted: false, reason: 'no aimable drawn row with that id' });
      const source = { handedness: 'right', targetRayMode: 'tracked-pointer',
        targetRaySpace: { synthetic: true }, gripSpace: { synthetic: true },
        profiles: ['stereofold-synthetic-menu-drag'] };
      const matrix = [1, 0, 0, 0, 0, 1, 0, 0, -ray.direction[0], -ray.direction[1], -ray.direction[2], 0, ...ray.origin, 1];
      const position = { x: ray.origin[0], y: ray.origin[1], z: ray.origin[2] };
      syntheticDrag = { source, kind: request.kind, start: [...ray.origin], offset: [0, 0, 0],
        pose: { emulatedPosition: false, transform: { matrix, position } },
        gripPose: { emulatedPosition: false, transform: { position } } };
      syntheticDragLast = { before: dragSnapshot(), kind: request.kind, aimedAt: request.id, actionsBefore: actionsAccepted };
      const event = { type: request.kind === 'grip' ? 'squeezestart' : 'selectstart', inputSource: source,
        frame: syntheticDragFrame(), preventDefault() {}, stopImmediatePropagation() {} };
      if (request.kind === 'grip') squeezeStart(event); else selectStart(event);
      if (menuDrag?.source !== source) {
        selectCancel(event); syntheticDrag = undefined;
        return reply({ accepted: false, reason: 'the normal input handler did not capture this menu' });
      }
      syntheticDrag.timer = setTimeout(() => { void dragSynthetic({ phase: 'cancel', reason: 'timeout' }); }, 30000);
      syntheticDrag.timer?.unref?.();
      await waitForSyntheticFeedback(menuDrag);
      return reply({ accepted: true, active: true, timeoutMs: 30000 });
    }
    if (!syntheticDrag) return reply({ accepted: false, active: false, reason: 'no synthetic drag is active' });
    const drag = syntheticDrag;
    if (request.phase === 'move') {
      if (!Array.isArray(request.offset) || request.offset.length !== 3 || !request.offset.every(Number.isFinite)
        || Math.hypot(...request.offset) > 2)
        return reply({ accepted: false, reason: 'offset must be three finite room metres within two metres of start' });
      // Feed measured controller samples below the production tracking-jump
      // threshold. The absolute target makes retried diagnostics idempotent.
      const from = [...drag.offset], delta = request.offset.map((v, i) => v - from[i]);
      const steps = Math.max(1, Math.ceil(Math.hypot(...delta) / .05));
      for (let step = 1; step <= steps; step++) {
        drag.offset = from.map((v, i) => v + delta[i] * step / steps);
        ['x', 'y', 'z'].forEach((key, axis) => {
          drag.pose.transform.position[key] = drag.start[axis] + drag.offset[axis];
          drag.pose.transform.matrix[12 + axis] = drag.pose.transform.position[key];
        });
        syncInput(syntheticDragFrame(), [drag.source]);
      }
      await waitForSyntheticFeedback(menuDrag);
      syntheticDragLast.held = dragSnapshot();
      return reply({ accepted: true, active: true, offset: [...drag.offset], rowActions: actionsAccepted - syntheticDragLast.actionsBefore });
    }
    if (!['end', 'cancel'].includes(request.phase)) return reply({ accepted: false, reason: 'unknown drag phase' });
    const frame = syntheticDragFrame();
    syntheticDragLast.held = dragSnapshot();
    clearTimeout(drag.timer); syntheticDrag = undefined;
    const event = { type: drag.kind === 'grip' ? 'squeezeend' : 'selectend', inputSource: drag.source, frame,
      preventDefault() {}, stopImmediatePropagation() {} };
    // No synthetic select event is sent: even a zero-motion release cannot
    // activate the row it began on. Actual drag completion is unchanged.
    if (request.phase === 'cancel' || !menuDrag?.active) selectCancel(event);
    else if (drag.kind === 'grip') squeezeEnd(event); else selectEnd(event);
    pointers.forget(drag.source); forgetHover(drag.source);
    for (let tick = 0; tick < 8 && inputLocked && !closed; tick++) await nextXrTick(session);
    syntheticDragLast.released = dragSnapshot();
    syntheticDragLast.ended = request.reason ?? request.phase;
    return reply({ accepted: true, active: false, rowActions: actionsAccepted - syntheticDragLast.actionsBefore });
  }

  function aimSynthetic(target = {}) {
    if (target.drag) return dragSynthetic(target.drag);
    const base = { method: 'synthetic-ray', simulates: 'controller pose, not a hand or a wearer' };
    if (syntheticDrag) return { ...base, fired: false, reason: 'a synthetic drag is active; finish or cancel it first' };
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

  const offAssistantStatus = assistantStatus.subscribe(() => { void update({ origin: 'status' }).catch(() => {}); });
  session.addEventListener('squeezestart', squeezeStart); session.addEventListener('squeezeend', squeezeEnd); session.addEventListener('squeezecancel', selectCancel);
  session.addEventListener('selectstart', selectStart); session.addEventListener('select', select); session.addEventListener('selectend', selectEnd); session.addEventListener('selectcancel', selectCancel); session.addEventListener('inputsourceschange', sourceChange);
  /**
   * Keep transient reply ownership and expiry for receipt diagnostics.
   * The talk card draws replies; tour outcomes use the caption readout.
   * Persistent assistant status owns the fixed glass below the controls and
   * is updated independently, so a transient reply cannot erase ownership,
   * microphone state or the last applied action.
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
  /**
   * The same drawn points, one set per plate. A reply seat asks every frame;
   * a committed panel never changes in place, so its outlines are built once
   * per draw and only the drag offset is applied on each call.
   */
  let glassPanel, glassOutlines = [];
  function glassPlates() {
    if (!panel || closed || hidden) return [];
    if (glassPanel !== panel) { glassPanel = panel; glassOutlines = toolbarGlassPlates(panel); }
    return glassOutlines.map(drawnRoomPoints);
  }
  function drawnRoomPoints(points) {
    const moved = points.map(point => point.map((v, i) => v + renderedOffset[i]));
    if (points.plates) moved.plates = points.plates.map(drawnRoomPoints);
    return moved;
  }

  // The worker measures these exact full panels; preparation never moves glass.
  function prepareRelocation({ headInRoom, labelViews, renderFromRoom }) {
    syncPlacementSeat();
    if (!panel || !drawnPanelOptions || closed || hidden || inputLocked || menuReseatRequested || wearerOwnsSeat()) return [];
    const head = { matrix: headInRoom, position: { x: headInRoom[12], y: headInRoom[13], z: headInRoom[14] } };
    const baseline = JSON.stringify(platePoints());
    return [...menuRelocationCandidates(drawnPanelOptions, head, { labelViews, renderFromRoom }),
      { id: 'hidden', points: [], hide: true }].map(candidate => ({ ...candidate, baseline }));
  }

  async function commitRelocation(candidate) {
    syncPlacementSeat();
    const stale = () => Object.assign(Error('The menu changed while checking its new seat. Kept the previous placement.'), { code: 'FIT_STALE' });
    if (closed || hidden || inputLocked || menuReseatRequested || wearerOwnsSeat() || candidate.baseline !== JSON.stringify(platePoints())) throw stale();
    const before = { relocationSeat: relocationSeat ?? { anchor: [...panel.anchor] }, entryHead, seatReason };
    if (candidate.hide && !candidate.recovery && lessonUnderway(getState()?.tour)) {
      // A lesson's glass stays drawn, even over the structure.
      globalThis.__stereofoldDiagnostics?.record?.('toolbar', { phase: 'seat-commit', reason: 'clearance', hidden: false, kept: true });
      return { rollback: async () => {}, kept: true };
    }
    if (candidate.hide) {
      clearanceHidden = candidate.recovery ? 'recovery' : true;
      setHidden(true);
      globalThis.__stereofoldDiagnostics?.record?.('toolbar', { phase: 'seat-commit', reason: 'clearance', hidden: true,
        hint: 'Controls hidden to clear the structure. B/Y brings them back.' });
      return { rollback: async () => { if (!closed && hidden && clearanceHidden) { clearanceHidden = false; setHidden(false); } } };
    }
    const ownedSeat = { anchor: candidate.anchor, lessonSide: candidate.constants?.lessonSide, forward: candidate.constants?.peripheralSeat === false, chapterCardBelow: candidate.constants?.chapterCardBelow, glance: candidate.glance, statusAside: candidate.statusAside };
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
    syncPlacementSeat();
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
    const options = { stableLesson: form && lessonUnderway(state?.tour) && !state?.tour?.menuOpen && !state?.sequence?.open,
      measureText: toolbarTextWidth, head, rows: panelRows,
      readout: tourReadout(captionTour(state), state?.subject ?? welcome, undefined, { placement: state?.placementNote, descriptionPage: descriptionPageIndex() }),
      status: '', assistantLines: assistantStatus.panelLines(), assistantGlance: assistantStatus.panelGlance() };
    options.readoutPage = cardPageAt(options.readout);
    // Done draws its completed rows at the currently held anchor. Measure
    // that same glass so a chapter menu moved by the wearer cannot make the
    // saved view solve against the older resting anchor.
    const seated = restoreTourSeat && restingMenuSeat;
    const restoreAutomaticAnchor = seated && ['entry', 'clearance'].includes(seatReason) && restingMenuSeat.anchor;
    const preview = createToolbarPanel(seated
      ? { ...options, head: restoreAutomaticAnchor ? restingMenuSeat.head : entryHead ?? restingMenuSeat.head, constants: wearerOwnsSeat() ? layout() : restingMenuSeat.layout,
        seatAnchor: restoreAutomaticAnchor || (panel?.anchor && drawnRoomPoints([panel.anchor])[0]) } : options);
    const points = toolbarPlatePoints(preview);
    if (!resetMenu && !restoreTourSeat) {
      points.push(...platePoints());
      points.plates.push(...glassPlates());
    }
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
   * A lesson card's centred seats, top and bottom, each with the full menu
   * column and with the compact Menu control, as `beforeMenuDraw` will offer
   * them from the head the menu is seated from. A chapter's framing leaves
   * room for one of them, so its card never has to cover the chapter. The
   * card's size does not depend on its words, so the chapter being entered
   * can be framed before its own card is drawn. Read-only.
   */
  function chapterCardSeats(pose) {
    syncPlacementSeat();
    if (!lastLessonCard || !lastPanelOptions || !entryHead || closed || !pose || wearerOwnsSeat()) return [];
    const readout = lastPanelOptions.readout?.some(line => line.forwardView === true) ? lastPanelOptions.readout
      : [{ text: 'Chapter', whole: true, forwardView: true }];
    try {
      return menuRelocationCandidates({ ...lastPanelOptions, readout, head: entryHead, seatAnchor: undefined }, entryHead,
        { ...pose, cardOnly: true }).filter(seat => !seat.beside);
    } catch { return []; }
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
   * A temporary status shares the column's width and upright frame. The
   * compact Menu control is a column no line fits: it is marked `compact`, and
   * its width is the control or its status plate, whichever is wider.
   */
  function captionColumn() {
    if (!panel || closed || hidden) return null;
    const bottom = panel.backing ?? panel.buttons.reduce((a, b) =>
      b.point[1] - b.halfHeight < a.point[1] - a.halfHeight ? b : a);
    const low = panel.statusBacking ?? bottom;
    const compact = panel.buttons.length === 1;
    // The caption solver derives its tangent clearance from both eye views.
    const top = low.point.map((v, i) => v - panel.up[i] * low.halfHeight);
    const frame = panel.captionBacking ?? panel;
    const points = drawnRoomPoints([top, ...[frame.right, frame.up, frame.normal].map(axis => top.map((v, i) => v + axis[i]))]);
    const axis = index => points[index].map((v, i) => v - points[0][i]);
    return { top: points[0], halfWidth: compact ? Math.max(bottom.halfWidth, panel.statusBacking?.halfWidth ?? 0) : bottom.halfWidth,
      right: axis(1), up: axis(2), forward: axis(3), normal: axis(3).map(v => -v), ...(compact ? { compact: true } : {}) };
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

  return Object.freeze({ update, syncBounds, syncPose, syncInput, depthRange, aimSynthetic, platePoints, glassPlates, placementPoints, placementPreview, prepareRelocation, commitRelocation, captionPoints, drawnMenuPoints, chapterCardSeats, menuPoints, captionColumn, menuRows, menuMotion, setStatus,
    // What the status row is saying right now, read-only. A
    // command receipt expires after a few seconds of frames and must clear the
    // row only while the row still holds that receipt — a voice line or the
    // agent's reply written since then has to survive it.
    statusText: () => notice?.text ?? '',
    // The readout lines actually on the glass, top line first,
    // read-only. A device run checking that a status sentence retired had
    // nothing to read but a screenshot, and `tourReadout` recomputed in the
    // driver is a second opinion rather than the drawn plate.
    readoutText: () => (panel && !closed ? [...(panel.readoutPoints ?? []),...(panel.statusPoints ?? [])].map(line => line.text) : []),
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
    readout: () => { const state = presentationState(); return { ...readoutPaging(state), cardHoldMs: cardHoldMs(state) }; },
    head: () => entryHead, rows: () => rows(), rowCount: () => rows().length, isCollapsed: () => collapsed, dispose: async () => { offAssistantStatus(); cancelMenuDrag(); closed = true; cancelStatusHold(); sequence++; clearTimeout(pressTimer); pressTimer = undefined; pressIndex = -1; gestures.dispose(); for (const source of [...wakeSources]) cancelWake(source); await hoverDraw.catch(() => {}); session.removeEventListener('squeezestart', squeezeStart); session.removeEventListener('squeezeend', squeezeEnd); session.removeEventListener('squeezecancel', selectCancel); session.removeEventListener('selectstart', selectStart); session.removeEventListener('select', select); session.removeEventListener('selectend', selectEnd); session.removeEventListener('selectcancel', selectCancel); session.removeEventListener('inputsourceschange', sourceChange); await actionChain.catch(() => {}); await remove(); } });
}
