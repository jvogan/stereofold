import { assistantStatus } from './assistant-status.mjs';
import { connectionStatus, TALK_LINK_LOST } from './connection-liveness.mjs';
// Temporary talk and action feedback. A headset supplies the committed
// menu column: the caption uses a flat, column-width seat beneath its glass
// (sized to its words beneath the compact Menu control), or stays off when
// either eye, the molecule or another plate blocks it. Standalone callers
// retain the head-relative caption seat below. Replies keep the ordinary reply
// glass, their reading window and delivery diagnostics; one the column cannot
// hold takes the head-relative seat.

import { menuSeatWithinView } from './menu-view-band.mjs';
import { measureReplyCard, measureReplyCardClearance, replyCardOffsetAsync } from './reply-card-layout.mjs';
import { MeshBuilder } from 'molstar/lib/mol-geo/geometry/mesh/mesh-builder.js';
import { Mesh } from 'molstar/lib/mol-geo/geometry/mesh/mesh.js';
import { TextBuilder } from 'molstar/lib/mol-geo/geometry/text/text-builder.js';
import { Text } from 'molstar/lib/mol-geo/geometry/text/text.js';
import { getFontAtlas } from 'molstar/lib/mol-geo/geometry/text/font-atlas.js';
import { Shape } from 'molstar/lib/mol-model/shape.js';
import { ShapeRepresentation } from 'molstar/lib/mol-repr/shape/representation.js';
import { Color } from 'molstar/lib/mol-util/color/index.js';
import { GLYPH_CAP_FRACTION, META_MIN_CAP_METERS, toolbarSeatBasis } from './spatial-toolbar-geometry.mjs';

/** How far in front of the eyes the caption sits, in metres. */
export const CAPTION_FORWARD_METERS = 0.9;
/** How far below the gaze, in degrees. Comfortably inside a downward glance. */
export const CAPTION_BELOW_DEGREES = 25;
/**
 * Mol* text `size`, in metres, chosen so the cap height clears Meta's own
 * legibility floor.
 *
 * This was 0.026, a 0.0151 m cap at `GLYPH_CAP_FRACTION` — about half the
 * 0.028 m the menu module enforces on every glyph it draws. The caption is the
 * one surface a wearer always faces, so it was the smallest type in the build
 * sitting where it mattered most. The floor is imported rather than retyped so
 * the two can never drift, and rounded up to the millimetre so no floating
 * point remainder can put it back under.
 */
export const CAPTION_FONT_METERS = Math.ceil(META_MIN_CAP_METERS / GLYPH_CAP_FRACTION * 1000) / 1000;

/** How far off its plate, toward the wearer, the caption text is written; see `draw`. */
export const CAPTION_TEXT_LIFT_METERS = 0.025;
/**
 * The caption's own glass, in characters and lines.
 *
 * Bigger type at a fixed seat distance is a wider plate, and a plate wider
 * than the comfortable centre of a Quest 2 field of view is worse than small
 * type: the wearer has to sweep their head to read one line. So the line
 * budget shrinks as the type grows. Fifteen characters is the same width the
 * menu's readout pages to (`READOUT_PAGE_LINE_WIDTH`), and at this size two
 * of them span about 25 degrees by 8 degrees at the seat.
 */
export const CAPTION_LINE_CHARS = 15;
export const CAPTION_MAX_LINES = 2;
/**
 * The wider glass, for a sentence the narrow one cannot hold whole.
 *
 * Three caption kinds drew two lines and an ellipsis. The reply
 * plate cut `This reply is a reading window…` out of a 26-word answer, the
 * lost-link card cut `reconnecting` out of `Link to the Mac lost ·
 * reconnecting…`, and the Fit placement line lost the word `menu`. In each one
 * the word that carried the instruction is the word that went.
 *
 * So the narrow glass is now a preference, not a limit. A line that fits it is
 * drawn exactly as it always was; a line that does not is drawn here instead,
 * and a line too long for even this is paged rather than cut. Thirty-two
 * characters across three lines spans about 50 degrees by 12 at the caption
 * seat, which is a glance rather than a head sweep, and it holds every fixed
 * connection line this build can show without turning a page.
 */
export const CAPTION_WIDE_LINE_CHARS = 32;
export const CAPTION_WIDE_MAX_LINES = 3;
/** Baseline pitch, as a multiple of the type size. */
export const CAPTION_LINE_PITCH = 1.6;
/** Padding around the text on the backing plate, in metres. */
export const CAPTION_PADDING_METERS = 0.02;
/** How long an outcome line stays up before the caption clears. */
export const CAPTION_OUTCOME_MS = 3000;
/** A lost link is persistent menu state, with one brief caption per edge. */
export const CONNECTION_CAPTION_MS = 6000;
/**
 * The longest a caller may hold the caption, in milliseconds.
 *
 * Three seconds is right for control feedback -- `Applied · style +1` is six
 * words the wearer already expected. It is wrong for an answer. On
 * the Mac delivered a 117-character reply with `holdSeconds: 6` and played it
 * for 7.05 s; the plate came down at 3.08 s, so six of the seven captures
 * taken across that reply were after it had gone. A caller that knows how long
 * its line needs says so, bounded here rather than trusted: `say_to_headset`
 * accepts 2-15 seconds, and nothing may pin the one plate a wearer always
 * faces for longer than a reply can legitimately sound.
 */
export const CAPTION_MAX_HOLD_MS = 20_000;
/**
 * How far the wearer's yaw may drift before the caption is re-seated.
 *
 * A caption rebuilt every frame is a Mol* text mesh, a plate mesh and a scene
 * repartition at 72 Hz, which is the cost the menu's own rebuild throttle
 * exists to avoid. Twelve degrees is inside the field of view at this seat
 * distance, so the caption never leaves the wearer's sight before it moves.
 */
export const CAPTION_DRIFT_DEGREES = 12;
/** The shortest gap between two re-seats, so a turning head cannot thrash it. */
export const CAPTION_RESEAT_MS = 200;

const TEXT_PROPS = Object.freeze({ attachment: 'middle-center', background: false, fontFamily: 'sans-serif', fontWeight: 'bold', fontQuality: 2 });
const PALETTE = Object.freeze({ text: 0xf2fdfc, plate: 0x081218, edge: 0x58dcc9 });

/**
 * The caption's own seat, in XR room metres.
 *
 * Built from the same levelled basis the menu is seated from, so a wearer who
 * enters looking down at the structure gets a caption at their level gaze
 * rather than one pitched into the floor with them. The drop is applied about
 * the wearer's own right axis, which is a rotation of the forward vector
 * toward the room's down direction.
 *
 * @param {object} head a WebXR viewer pose, or `{position, matrix}`
 * @returns {{origin:number[], right:number[], up:number[], normal:number[], forward:number[]}|undefined}
 */
export function captionSeat(head, { forwardMeters = CAPTION_FORWARD_METERS, belowDegrees = CAPTION_BELOW_DEGREES } = {}) {
  const basis = toolbarSeatBasis(head);
  if (!basis) return undefined;
  const angle = belowDegrees * Math.PI / 180;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  // Forward tilted down by `belowDegrees` in the vertical plane the wearer faces.
  const bearing = basis.forward.map((value, axis) => value * cos - basis.up[axis] * sin);
  const origin = basis.origin.map((value, axis) => value + bearing[axis] * forwardMeters);
  // The plate faces the wearer, so its up is the bearing's own perpendicular.
  const up = basis.up.map((value, axis) => value * cos + basis.forward[axis] * sin);
  return { origin, right: basis.right, up, forward: basis.forward, normal: bearing.map(value => -value) };
}

/**
 * Where the caption text is written: `CAPTION_TEXT_LIFT_METERS` off the plate,
 * toward the wearer. A seat's `normal` already points back at the eyes, so the
 * lift is along it. The toolbar's panel normal points the other way, which is
 * why its lift carries a minus sign and this one does not.
 */
export function captionTextOrigin(seat, liftMeters = CAPTION_TEXT_LIFT_METERS) {
  return seat.origin.map((value, axis) => value + seat.normal[axis] * liftMeters);
}

/** One string's width in cap-height multiples, from the font atlas Mol* lays out with. */
function glyphAdvances(text) {
  const atlas = getFontAtlas(TEXT_PROPS);
  const outline = atlas.buffer / atlas.lineHeight;
  return Array.from(text, character => atlas.get(character).nw - 2 * outline);
}

/**
 * Write one string as one text entry per glyph, along a given direction.
 *
 * This duplicates `spatial-toolbar.mjs`'s own `addGlyphs`, which is not
 * exported. Mol* lays a whole string out from a single anchor and expands the
 * glyph quads in a plane fixed to the room's axes, so a label written on a
 * turned surface leans out of it by half its own width — enough to render
 * `Tour menu` as `our menu`. One entry per glyph cuts that lean to half a
 * letter.
 */
function addGlyphs(builder, text, { origin, right, size, group }) {
  const advances = glyphAdvances(text);
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

/** The four corners of the backing plate, in room metres. */
function plateCorners(seat, halfWidth, halfHeight) {
  const corner = (x, y) => seat.origin.map((value, axis) => value + seat.right[axis] * x + seat.up[axis] * y);
  return [corner(-halfWidth, -halfHeight), corner(halfWidth, -halfHeight), corner(halfWidth, halfHeight), corner(-halfWidth, halfHeight)];
}

/**
 * What the caption should read, given what the controllers are doing.
 *
 * Ordered by urgency, not by recency: a wearer holding the structure while a
 * talk outcome is still up wants to know what their hand is doing. Every
 * progress line is control feedback, never the wearer's sentence.
 *
 * @param {object} state
 * @param {boolean} [state.talking] a lower face button is held
 * @param {boolean} [state.sending] the button came up and the Mac has the audio
 * @param {string}  [state.outcome] a short confirmation, or `Not a command`
 * @param {boolean} [state.holding] a grip has the structure
 * @param {boolean} [state.modifier] a trigger modifier is engaged
 * @param {string}  [state.notice] a caption another control asked for
 * @param {string}  [state.progress] ongoing microphone or fitting feedback
 */
export function captionText(state = {}, link = connectionStatus(), { automaticHints = true } = {}) {
  if (link.line) return link.voiceLost ? `${TALK_LINK_LOST}. ${link.line}` : link.line;
  if (state.talking) return state.progress || 'Listening…';
  if (state.sending) return state.progress || 'Sending…';
  if (state.notice) return state.notice;
  if (automaticHints && state.holding) return 'Move hand to move · grip + stick: size';
  if (automaticHints && state.modifier) return 'Trigger + stick: turn / depth';
  return state.progress || state.outcome || '';
}

/** A quiet authored lesson keeps unsolicited control tutorials off its glass. */
export const automaticCaptionHintsAllowed = tour => !(tour?.captionCard === 'hidden' && (tour.active === true || tour.navigating === true));

/**
 * One caption line broken at the glass's preferred width.
 *
 * The line the caption draws is mostly one of the fixed strings above, but the
 * voice runner's own confirmations and the agent's notices also arrive here,
 * and those are written elsewhere. Wrapping on words keeps a two-word
 * confirmation whole. Numbers and hyphenated tokens stay intact; other long
 * words wrap at the preferred width. Anything past the last line ends
 * in an ellipsis so the wearer can see that it was cut.
 *
 * @param {string} text
 * A separator stays on the preceding line, including when its space and dot
 * extend past the preferred character width. The draw measures those glyphs
 * too when sizing the backing plate.
 *
 * @returns {string[]} at most `maxLines` lines
 */
export function captionLines(text, { lineChars = CAPTION_LINE_CHARS, maxLines = CAPTION_MAX_LINES, maxWidth } = {}) {
  const source = typeof text === 'string' ? text.trim().replace(/\s+/gu, ' ') : '';
  if (!source) return [];
  const lines = [];
  if (Number.isFinite(maxWidth)) {
    let rest = source;
    while (rest) {
      const glyphs = Array.from(rest), advances = glyphAdvances(rest);
      let width = 0, take = 0;
      while (take < glyphs.length && width + advances[take] <= maxWidth + 1e-9) width += advances[take++];
      // A single glyph is the irreducible width; draw can use the ordinary
      // reply seat when even that cannot fit the column at readable type.
      take = Math.max(1, take);
      if (take < glyphs.length) {
        const space = glyphs.slice(0, take + 1).lastIndexOf(' ');
        if (space > 0) take = space;
      }
      lines.push(glyphs.slice(0, take).join('').trimEnd());
      rest = glyphs.slice(take).join('').trimStart();
    }
    return lines.slice(0, maxLines);
  }
  let rest = source;
  while (rest && lines.length < maxLines) {
    if (rest.length <= lineChars) { lines.push(rest); rest = ''; break; }
    const window = rest.slice(0, lineChars + 1);
    const breakAt = window.lastIndexOf(' ');
    // Numeric values and hyphenated names must not acquire an internal break.
    // Measure those glyphs as for a trailing separator; keep ordinary words'
    // existing hard wrap so they cannot set the plate's width.
    const token = rest.split(' ', 1)[0];
    let take = breakAt > 0 ? breakAt : /[\d\-\u2010\u2011]/u.test(token) ? token.length : lineChars;
    // Break after the separator, never before it. For example, the narrow
    // outcome card reads "Applied · scene ·" followed immediately by "r3".
    const separator = rest.slice(take).match(/^ ·(?= |$)/u);
    if (separator) take += separator[0].length;
    lines.push(rest.slice(0, take).trimEnd());
    rest = rest.slice(take).trimStart();
  }
  if (rest) {
    const last = lines[lines.length - 1];
    lines[lines.length - 1] = `${last.slice(0, Math.max(0, lineChars - 1)).trimEnd()}…`;
  }
  return lines;
}

const NARROW_GLASS = Object.freeze({ lineChars: CAPTION_LINE_CHARS, maxLines: CAPTION_MAX_LINES });
const WIDE_GLASS = Object.freeze({ lineChars: CAPTION_WIDE_LINE_CHARS, maxLines: CAPTION_WIDE_MAX_LINES });

/** Whether a sentence fits a glass whole, with nothing cut. */
export function captionFits(text, glass = WIDE_GLASS) {
  return captionLines(text, { ...glass, maxLines: Infinity }).length <= glass.maxLines;
}

/**
 * The glass one line is drawn in: the narrow one when it fits, the wide one
 * otherwise. Nothing that fits the narrow glass changes shape.
 */
export function captionGlass(text) {
  return captionFits(text, NARROW_GLASS) ? NARROW_GLASS : WIDE_GLASS;
}

/**
 * Pack complete sentences or clauses when they fit. A shorter page is better
 * than leaving half a clause for the next reading window. Only a clause that
 * cannot fit a page falls back to word boundaries. Numbers and hyphenated
 * tokens remain intact; ordinary words longer than a page keep their wrap.
 *
 * @param {string} text
 * @returns {string[]} complete text, in reading order
 */
export function captionPages(text, glass = WIDE_GLASS) {
  const source = typeof text === 'string' ? text.trim().replace(/\s+/gu, ' ') : '';
  const words = source ? source.split(' ').flatMap(word => {
    if (captionFits(word, glass)) return [word];
    const lines = captionLines(word, { ...glass, maxLines: Infinity });
    const pieces = [];
    for (let index = 0; index < lines.length; index += glass.maxLines)
      pieces.push(lines.slice(index, index + glass.maxLines).join(''));
    return pieces;
  }) : [];
  const pages = [];
  for (let start = 0; start < words.length;) {
    let end = start, boundary = start;
    while (end < words.length) {
      // A dot separator belongs to its preceding phrase, even at a page edge.
      const next = words[end + 1] === '·' ? end + 2 : end + 1;
      if (end > start && !captionFits(words.slice(start, next).join(' '), glass)) break;
      end = next;
      if (/[.!?;,:]["'\u201d\u2019)\]]*$/u.test(words[end - 1])) boundary = end;
    }
    if (end < words.length && boundary > start) end = boundary;
    pages.push(words.slice(start, end).join(' '));
    start = end;
  }
  return pages;
}

/**
 * The live caption, for code that cannot reach the viewer's own reference.
 *
 * The voice runner is attached by the immersive session, one layer away from
 * the viewer that owns the caption, and its outcome line is the one a wearer
 * most needs to see. This is the same one-sink pattern `xr-manipulate.mjs` uses
 * for the menu's status row, for the same reason.
 */
let outcomeSink;
/** @param {Function|undefined} sink Receives text, hold, paging flag and an optional seat callback. */
export function setTalkOutcomeSink(sink) { outcomeSink = typeof sink === 'function' ? sink : undefined; }
/**
 * Put one short outcome line on the caption. Never the wearer's own sentence.
 * @param {string} text the line to draw
 * @param {number} [holdMs] how long it must stay readable; control feedback
 *   omits it and gets `CAPTION_OUTCOME_MS`, a delivered reply passes its own
 *   reading window
 * @param {Function} [onSeat] Completion after the draw, or an explicit failure.
 * @returns {boolean} whether a caption accepted it; this is not a draw receipt
 */
export function showTalkOutcome(text, holdMs, complete = false, onSeat) {
  if (typeof text !== 'string' || !outcomeSink) { onSeat?.({ outcome: 'unavailable' }); return false; }
  try { outcomeSink(text, holdMs, complete, onSeat); return true; }
  catch { onSeat?.({ outcome: 'failed' }); return false; }
}

/** Microphone progress uses persistent state, never the outcome timer. */
let progressSink;
export function setTalkProgressSink(sink) { progressSink = typeof sink === 'function' ? sink : undefined; }
export function showTalkProgress(state) {
  try { progressSink?.(state); } catch { /* The caption may have left with XR. */ }
}

/**
 * A head-seated caption plate in the presentation layer.
 *
 * `presentation` is the same layer the menu is drawn in, and the plate is added
 * `roomLocked` for the same reason: it is authored in room metres and carried
 * into scene units by the layer's own per-frame matrix, so it does not shrink
 * or grow when the wearer rescales the structure.
 *
 * `set` is the whole input. Call it with what the controllers are doing; it
 * rebuilds only when the drawn line changes or the head has turned past
 * `CAPTION_DRIFT_DEGREES`. `outcome` clears itself after `CAPTION_OUTCOME_MS`.
 *
 * @param {object} options
 * @param {object} options.plugin the Mol* plugin, for `runTask`
 * @param {object} options.presentation the presentation scene from `presentation-scene.mjs`
 * @param {()=>object|undefined} options.head the latest viewer pose
 */
export function createTalkCaption({ plugin, presentation, head = () => undefined, menuPoints = () => [], menuPlates, clearance, captionColumn,
  viewsAvailable, getTourState = () => undefined,
  now = () => (globalThis.performance?.now?.() ?? Date.now()),
  record = () => {} } = {}) {
  if (!plugin?.runTask) throw new TypeError('A talk caption needs the Mol* plugin.');
  if (!presentation?.add) throw new TypeError('A talk caption needs the presentation layer.');
  const captionLine = (state, link) => captionText(state, link, { automaticHints: automaticCaptionHintsAllowed(getTourState()) });
  // The headset supplies clearance. A standalone caption has no molecular
  // scene to cover and keeps its existing design seat.

  let text, plate, label, seat, pending, drawn = '', reported = '', outcomeUntil = 0, sequence = 0, closed = false, suspended = false;
  let lastVerifiedAt = -Infinity;
  let building = Promise.resolve();
  let outcomeReporter, outcomeHoldAfterDraw = false, outcomeNeedsHold = false, seatPoints = [], seatReceipt, seatAim;
  /** Answer the caller who is waiting on this caption, once.
   *
   * A seat the eyes do not fully contain is not the end of the story. It
   * is reported, so the log carries `drawn: false` while the card is off the
   * glass, and the reporter is kept so the re-seat that follows can report the
   * truth under the same caption id.
   */
  function reportOutcome(detail, { retain = false } = {}) {
    const callback = outcomeReporter; if (!retain) outcomeReporter = undefined;
    try { callback?.(detail); } catch { /* Diagnostics cannot prevent a caption. */ }
  }
  let outcomePages = [], outcomePage = 0, outcomeHold = CAPTION_OUTCOME_MS, outcomeWidth, outcomeGlass;
  function currentColumn() {
    try { return captionColumn?.(); } catch { return undefined; }
  }
  // The menu a card must clear, with its drawn plates when the caller has
  // them, so a reply may sit beside a compact control rather than only below
  // the whole reserved menu rectangle.
  function menuObstacle() {
    const points = menuPoints() ?? [];
    let plates;
    try { plates = menuPlates?.(); } catch { /* The menu may have left with XR. */ }
    return plates?.length ? Object.assign([...points], { plates }) : points;
  }
  // A full menu's column sets the width of its temporary status. A compact
  // column is one Menu control no line fits, so its status keeps the ordinary
  // caption glass, sized to its words and centred beneath the control.
  function columnGlass(column = currentColumn()) {
    return column && !column.compact ? { maxWidth: Math.max(0, (2 * column.halfWidth - 2 * CAPTION_PADDING_METERS) / CAPTION_FONT_METERS),
      maxLines: CAPTION_MAX_LINES } : undefined;
  }
  // A reply is read, not glanced at. It keeps the ordinary reply glass unless
  // the menu column holds more of it on a page, and then it takes the column.
  // Never the narrow glass, which would split a long word of a short reply.
  // A standalone caption has no column and keeps the narrow glass for short
  // lines.
  function replyGlass(text, glass = columnGlass()) {
    return glass && captionPages(text, glass).length < captionPages(text, WIDE_GLASS).length ? glass
      : captionColumn ? WIDE_GLASS : undefined;
  }
  let statePages = [], statePage = 0, statePageOf = '', statePageUntil = 0;
  let connectionLine = '', connectionUntil;
  /**
   * A notice's own reading window, and when the line the
   * wearer is reading went up.
   *
   * `holdMs` reached only the outcome path. A caller that asked for a notice
   * and named a hold got a sentence with no timer at all, retired by nothing
   * but the next sentence — which is the shape of the plate the
   * captures found still carrying a six-second line 42 s later. An earlier run’s rule for
   * `holdMs: 0` is unchanged: zero is a default window, not a pinned notice.
   */
  let noticeUntil = 0, noticeHold = CAPTION_OUTCOME_MS, drawnAt;
  /**
   * Say in the ring that a sentence left the glass, and how long it was on it.
   *
   * `talk-caption-seat` records the hold a caption was promised at the draw.
   * Nothing recorded whether that promise was kept, so a ring could not tell a
   * line that retired on time from one that never retired at all.
   */
  function recordRetired(text, holdMs) {
    const shownMs = Number.isFinite(drawnAt) ? Math.max(0, Math.round(now() - drawnAt)) : undefined;
    record('caption-retired', { surface: 'caption', text, holdMs: Math.round(holdMs),
      ...(shownMs === undefined ? {} : { shownMs }) });
  }
  let compact = '', compactUntil = 0, compactPending = false;
  let previousConnection = assistantStatus.connectionLine();
  const offAssistant = assistantStatus.subscribe(() => {
    const connection = assistantStatus.connectionLine();
    if (connection === previousConnection) return;
    previousConnection = connection;
    compact = assistantStatus.compactLine(); compactPending = true; compactUntil = 0;
    refresh();
  });
  const state = { talking: false, sending: false, outcome: '', holding: false, modifier: false, notice: '', progress: '' };

  function remove() {
    for (const representation of [plate, label]) {
      if (!representation) continue;
      try { presentation.remove(representation); } catch { /* The layer can be disposed first. */ }
      try { representation.destroy(); } catch { /* A partly built representation still frees. */ }
    }
    plate = undefined; label = undefined; drawn = ''; seat = undefined; seatPoints = []; seatReceipt = undefined; seatAim = undefined;
  }

  async function draw(line, pose) {
    const own = sequence;
    // A later page may replace a successfully drawn page long after the
    // original attempt deadline. It gets its own bounded search.
    const solveDeadline = (!drawn || (line === state.outcome && outcomeReporter)) ? attemptDeadline : now() + 3000;
    const poseTransform = pose?.transform ?? pose;
    const posePosition = poseTransform?.position;
    pose = { matrix: poseTransform?.matrix && Array.from(poseTransform.matrix),
      position: posePosition && { x: posePosition.x, y: posePosition.y, z: posePosition.z } };
    let nextSeat = captionSeat(pose);
    if (!nextSeat) return;
    let queuedClearance;
    try { queuedClearance = clearance?.(); } catch { /* Wait for measurable geometry. */ }
    if (clearance && queuedClearance?.views?.length !== 2) {
      remove(); blockedLine = line; seatAim = headAim(pose);
      const receipt = { outcome: 'unmeasured', measured: false, reason: 'no-eye-views' };
      record('talk-caption-seat', receipt);
      if (line === state.outcome) reportOutcome(receipt, { retain: true });
      return;
    }
    let column = currentColumn();
    const size = CAPTION_FONT_METERS;
    const glass = line === state.outcome ? outcomeGlass : columnGlass(column);
    const lines = glass ? captionLines(line, glass)
      : line === compact || line === assistantStatus.releaseLine() ? [line] : captionLines(line, captionGlass(line));
    if (!lines.length) return;
    const pitch = size * CAPTION_LINE_PITCH;
    const widest = Math.max(...lines.map(text => glyphAdvances(text).reduce((total, advance) => total + advance, 0)));
    const halfWidth = widest * size / 2 + CAPTION_PADDING_METERS;
    const halfHeight = (size + (lines.length - 1) * pitch) / 2 + CAPTION_PADDING_METERS;
    const basis = toolbarSeatBasis(pose);
    if (column && halfWidth > column.halfWidth + 1e-9 && line === state.outcome) column = undefined;
    if (captionColumn && !(line === state.outcome && !column)) {
      if (!column || (halfWidth > column.halfWidth + 1e-9 && !column.compact)) {
        remove(); blockedLine = line; seatAim = headAim(pose);
        const receipt = { outcome: 'blocked', measured: true, reason: 'no-column-space' };
        record('talk-caption-seat', receipt);
        if (line === state.outcome) reportOutcome(receipt, { retain: true });
        return;
      }
      nextSeat = { ...column, columnBound: true, origin: column.top.map((v, i) => v - column.up[i] * halfHeight) };
    }
    let fallback, seatVerdict;
    // Share the upright, binocular view band, and let the layout weigh it
    // against what the eyes report. The seat that comes back is measured
    // in both eye projections -- the wearer's actual pitch and roll, not the
    // levelled design frame -- so nothing downstream can call an offscreen
    // card shown.
    const solve = () => replyCardOffsetAsync({ points: plateCorners(nextSeat, halfWidth, halfHeight),
      menuPoints: menuObstacle(), ...(column ? { belowMenu: column.up } : {}), eye: basis.origin,
      target: basis.origin.map((value, i) => value + basis.forward[i]), up: basis.up, clearance: queuedClearance,
      withinView: corners => menuSeatWithinView(corners, pose),
      onFallback: reason => { fallback = reason; }, onSeat: verdict => { seatVerdict = verdict; } },
      { isCurrent: () => !closed && own === sequence && now() < solveDeadline });
    let offset = await solve();
    if (closed || own !== sequence || !offset || now() >= solveDeadline) return;
    // A reply the column cannot hold in view still owes the wearer its words:
    // it takes the ordinary reply seat instead of waiting for the scene.
    if (clearance && seatVerdict?.outcome !== 'shown' && column && line === state.outcome) {
      column = undefined; nextSeat = captionSeat(pose); fallback = undefined; seatVerdict = undefined;
      offset = await solve();
      if (closed || own !== sequence || !offset || now() >= solveDeadline) return;
    }
    if (fallback) record('talk-caption-seat', { outcome: 'fallback', fallback });
    if (clearance && seatVerdict?.outcome !== 'shown') {
      // A full glass has no readable card seat. Keep the reply pending for a
      // scene change instead of drawing its plate over the molecule.
      remove(); blockedLine = line; seatAim = headAim(pose);
      const receipt = { outcome: 'blocked', fallback, inside: seatVerdict?.inside,
        measured: true, reason: 'no-clear-seat' };
      record('talk-caption-seat', receipt);
      if (line === state.outcome) reportOutcome(receipt, { retain: true });
      return;
    }
    nextSeat.origin = nextSeat.origin.map((value, i) => value + offset[i]);
    const corners = plateCorners(nextSeat, halfWidth, halfHeight);
    const meshState = MeshBuilder.createState(8, 4);
    MeshBuilder.addTriangleWithNormal(meshState, corners[0], corners[1], corners[2], nextSeat.normal.map(value => -value));
    MeshBuilder.addTriangleWithNormal(meshState, corners[0], corners[2], corners[3], nextSeat.normal.map(value => -value));
    const plateShape = Shape.create('Stereofold caption plate', {}, MeshBuilder.getMesh(meshState),
      () => Color(PALETTE.plate), () => 1, () => 'Caption');
    const nextPlate = ShapeRepresentation(async () => plateShape, Mesh.Utils, { modifyState: value => ({ ...value, pickable: false }) });
    // The text sits between the plate and the wearer for the same reason the
    // menu's does: a glyph quad expands about its own centre in the room's
    // axes, so a letter on a turned plate can otherwise be eaten by it. Half
    // the 4.9 cm type is 2.45 cm, which reaches 2.1 cm behind the glyph centre
    // at 60 degrees, so the lift is 2.5 cm (`CAPTION_TEXT_LIFT_METERS`).
    //
    // The earlier lift ran away from the wearer, so
    // every caption line was written behind its 86%-opaque plate. At 4 mm an
    // oblique view split each line bright on top and dim below; at 2.5 cm the
    // whole line read grey through the plate in the visionOS simulator.
    const origin = captionTextOrigin(nextSeat);
    const characters = lines.reduce((total, text) => total + text.length, 0);
    const textBuilder = TextBuilder.create(TEXT_PROPS, Math.max(1, characters), Math.max(1, characters));
    // Lines are stacked about the plate's centre along its own up axis, so a
    // one-line caption sits exactly where it always did.
    lines.forEach((text, index) => {
      const offset = ((lines.length - 1) / 2 - index) * pitch;
      addGlyphs(textBuilder, text, { origin: origin.map((value, axis) => value + nextSeat.up[axis] * offset),
        right: nextSeat.right, size, group: 0 });
    });
    const textShape = Shape.create('Stereofold caption', {}, textBuilder.getText(),
      () => Color(PALETTE.text), () => 1, () => line);
    const nextLabel = ShapeRepresentation(async () => textShape, Text.Utils, { modifyState: value => ({ ...value, pickable: false }) });
    try {
      await plugin.runTask(nextPlate.createOrUpdate({ alpha: 0.86, doubleSided: true, ignoreLight: true }, {}));
      await plugin.runTask(nextLabel.createOrUpdate({ sizeFactor: 1, background: false, attachment: 'middle-center', offsetZ: 0, borderWidth: 0, fontFamily: 'sans-serif', fontWeight: 'bold', fontQuality: 2 }, {}));
    } catch (error) {
      try { nextPlate.destroy(); } catch {}
      try { nextLabel.destroy(); } catch {}
      throw error;
    }
    if (closed || own !== sequence || now() >= solveDeadline || (line === state.outcome && !outcomeNeedsHold && now() >= outcomeUntil)) {
      try { nextPlate.destroy(); } catch {}
      try { nextLabel.destroy(); } catch {}
      return;
    }
    const changed = reported !== line;
    // A mesh build is asynchronous. If the wearer moved, recheck structure,
    // menu and frusta at the commit pose before mounting the old mesh.
    const committedPose = head() ?? pose;
    const movedWhileBuilding = poseMoved(pose, committedPose);
    let verdict = seatVerdict;
    let commitClearance;
    try { commitClearance = clearance?.(); } catch { /* Keep the reply pending. */ }
    if (clearance) {
      // The initial search can span frames. Always re-read current geometry,
      // menu and eyes; an unchanged head does not imply an unchanged molecule.
      verdict = measureReplyCardClearance(corners, menuObstacle(), commitClearance);
      if (column && JSON.stringify(column) !== JSON.stringify(currentColumn())) verdict = { outcome: 'blocked', measured: true };
      if (verdict?.outcome !== 'shown') {
        nextPlate.destroy(); nextLabel.destroy(); remove();
        blockedLine = line; seatAim = headAim(committedPose); reseatNow = true;
        const receipt = { outcome: verdict?.measured === false ? 'unmeasured' : 'blocked',
          measured: verdict?.measured === false ? false : true,
          reason: verdict?.measured === false ? 'no-eye-views' : 'moved-during-build' };
        record('talk-caption-seat', receipt);
        if (line === state.outcome) reportOutcome(receipt, { retain: true });
        return;
      }
    }
    if (closed || own !== sequence || now() >= solveDeadline) {
      nextPlate.destroy(); nextLabel.destroy(); return;
    }
    remove();
    blockedLine = '';
    plate = nextPlate; label = nextLabel; seat = nextSeat; seatPoints = corners; drawn = line;
    lastVerifiedAt = now();
    // When this sentence went up, so a retirement can say how long the
    // wearer had it. A re-seat of the same words keeps the original moment.
    if (changed || !Number.isFinite(drawnAt)) drawnAt = now();
    seatAim = headAim(committedPose);
    presentation.add(nextPlate, { roomLocked: true });
    presentation.add(nextLabel, { roomLocked: true });
    if (line === state.outcome && outcomeNeedsHold) {
      outcomeUntil = now() + outcomeHold; outcomeNeedsHold = false;
    }
    if (changed) { reported = line; record('talk-caption', { text: line }); }
    // `outcome: shown` was the whole record, and it could not answer
    // either question the captures raised. `seat` is where the plate
    // went, in room metres, so a run can check it against the wearer's own pose
    // rather than against a screenshot; `holdMs` is how long it will stay, which
    // is what told the capture schedule apart from the plate. The toolbar's own
    // `plates` counter never included this card, so it is no evidence about it.
    //
    // A headset card reaches this receipt only after both eyes clear it.
    // Earlier blocked attempts keep their reporter for a later seat.
    const seatOutcome = clearance ? verdict?.outcome ?? 'unmeasured' : 'shown';
    const receipt = { outcome: seatOutcome, ...(fallback ? { fallback } : {}),
      ...(seatOutcome === 'shown' || !Number.isFinite(verdict?.inside) ? {} : { inside: verdict.inside }),
      ...(verdict?.measured === false ? { measured: false } : {}),
      replyOffset: offset,
      seat: nextSeat.origin.map(value => Math.round(value * 1e4) / 1e4),
      lines: lines.length, ...(line === state.outcome
        ? { holdMs: Math.max(1, Math.round(outcomeUntil - now())) } : { stateDriven: true }) };
    seatReceipt = receipt;
    record('talk-caption-seat', receipt);
    if (line === state.outcome) reportOutcome(receipt, { retain: seatOutcome !== 'shown' });
    // A card the committed pose cannot hold whole is owed its own seat, and the
    // retained reporter above lets that seat answer under the same caption id.
    // Only a head that moved during the build asks for it, so the re-seat
    // cannot chase itself: the second build's queued pose is the committed one.
    if (movedWhileBuilding && seatOutcome !== 'shown') reseatNow = true;
  }

  /** Where the head was and where it was actually looking, pitch and roll
   * included, at the moment a seat was committed. `driftDegrees` levels both
   * away, and that is the right economy for a card the wearer can see. */
  function headAim(pose) {
    const matrix = pose?.transform?.matrix ?? pose?.matrix;
    const position = pose?.transform?.position ?? pose?.position;
    if (!matrix || !position) return undefined;
    return [position.x, position.y, position.z, -matrix[8], -matrix[9], -matrix[10]];
  }
  /** Has the head left the pose the last seat was solved for? */
  function aimMoved(pose) {
    const aim = headAim(pose);
    if (!aim || !seatAim) return true;
    return aim.some((value, i) => Math.abs(value - seatAim[i]) > 1e-3);
  }
  /** Did the head move between two poses, on the same 1 mm and 0.001
   * direction-cosine terms `aimMoved` uses? A pose that cannot be read is not
   * evidence of movement. */
  function poseMoved(from, to) {
    const before = headAim(from), after = headAim(to);
    if (!before || !after) return false;
    return before.some((value, i) => Math.abs(value - after[i]) > 1e-3);
  }
  /** What both eyes hold of a committed card right now. `undefined` when
   * the page can supply no eye transforms; a caller must then not claim a
   * measurement it does not have. Reading the clearance can fail with the
   * scene, and a diagnostic may never cost the wearer the caption. */
  function measureSeatNow(points = seatPoints) {
    let view;
    try { view = clearance?.(); } catch { return undefined; }
    return measureReplyCard(points, view);
  }

  /** How far the head has turned from the yaw the caption was seated at. */
  function driftDegrees(pose) {
    const basis = toolbarSeatBasis(pose);
    if (!basis || !seat) return Infinity;
    const seated = [seat.forward[0], 0, seat.forward[2]];
    const length = Math.hypot(seated[0], seated[2]);
    if (!(length > 1e-6)) return Infinity;
    const cosine = Math.min(1, Math.max(-1, (basis.forward[0] * seated[0] + basis.forward[2] * seated[2]) / length));
    return Math.acos(cosine) * 180 / Math.PI;
  }

  function refresh() {
    if (closed || suspended) return;
    // A notice given a hold retires on it. A notice without one is an
    // ongoing input state -- a held grip, a reset the wearer has not finished
    // -- and still ends on its own event, never on a clock.
    if (state.notice && noticeUntil && now() >= noticeUntil) {
      const retired = state.notice;
      state.notice = ''; noticeUntil = 0;
      if (drawn === retired) recordRetired(retired, noticeHold);
    }
    if (state.outcome && !outcomeNeedsHold && now() >= outcomeUntil) {
      if (outcomePage + 1 < outcomePages.length) {
        state.outcome = outcomePages[++outcomePage];
        outcomeNeedsHold = outcomeHoldAfterDraw && drawn !== state.outcome;
        outcomeUntil = now() + outcomeHold;
      } else {
        const retired = state.outcome;
        state.outcome = ''; outcomePages = []; reportOutcome({ outcome: 'expired' });
        if (drawn === retired) recordRetired(retired, outcomeHold);
      }
    }
    const link = connectionStatus();
    const lostLine = link.line ? (link.voiceLost ? `${TALK_LINK_LOST}. ${link.line}` : link.line) : '';
    if (lostLine !== connectionLine) { connectionLine = lostLine; connectionUntil = undefined; }
    // A delivered answer keeps its promised reading window. Once it retires,
    // show this connection edge once; repeated missed beats cannot renew it.
    const replyHeld = Boolean(state.outcome && (outcomeNeedsHold || now() < outcomeUntil));
    if (lostLine && !replyHeld && connectionUntil === undefined)
      connectionUntil = now() + Math.max(CONNECTION_CAPTION_MS, captionPages(lostLine).length * CAPTION_OUTCOME_MS);
    const showLink = Boolean(lostLine && !replyHeld && now() < connectionUntil);
    // Retiring the warning never implies that capture resumed. Offline input
    // cannot leave a stale Listening/Sending line on the caption plate.
    const readable = lostLine ? { ...state, talking: false, sending: false,
      progress: state.talking || state.sending ? '' : state.progress } : state;
    const primary = captionLine(readable, showLink ? link : { ...link, line: '' }).trim();
    if(!automaticCaptionHintsAllowed(getTourState())) { compact='';compactPending=false;compactUntil=0; }
    // Start the three-second window once the reply/microphone releases the glass.
    // A heartbeat or transcript change cannot renew it.
    if (!primary && compactPending) {
      compactPending = false; compactUntil = now() + CAPTION_OUTCOME_MS;
    }
    const line = primary || (now() < compactUntil ? compact : '');
    const pose = head();
    const glass = columnGlass();
    if (state.outcome && outcomeWidth !== glass?.maxWidth) {
      const unread = outcomePages.length ? outcomePages.slice(outcomePage).join(' ') : state.outcome;
      outcomeGlass = replyGlass(unread, glass);
      outcomePages = captionPages(unread, outcomeGlass ?? WIDE_GLASS); outcomePage = 0;
      state.outcome = outcomePages[0]; outcomeWidth = glass?.maxWidth;
      // Re-enter with the new page while preserving its remaining window.
      return refresh();
    }
    if (!line) { reportOutcome({ outcome: 'cleared' }); reported = ''; sequence++; pending = undefined; statePages = []; statePageOf = ''; remove(); return; }
    // One deadline belongs to the attempt, including time without tracking.
    // Head/menu drift can ask for another seat, never another deadline.
    if (attemptLine !== line) { attemptLine = line; attemptDeadline = now() + 3000; attemptStopped = false; }
    if ((!drawn || (line === state.outcome && outcomeReporter)) && now() >= attemptDeadline) {
      if (!attemptStopped) {
        attemptStopped = true; sequence++; pending = undefined; remove();
        const receipt = { outcome: 'not-shown', reason: 'no-clear-seat' };
        record('talk-caption-seat', receipt);
        if (line === state.outcome) { outcomeNeedsHold = false; reportOutcome(receipt); }
      }
      return;
    }
    if (!pose) { if (clearance && drawn) remove(); return; }
    // Every caption kind pages rather than elides. An outcome was cut into
    // pages by `set` and carries its own reading window; a state line the
    // wearer never asked for -- the lost link, the re-pair instruction, a
    // control notice -- is paged here and turns at the control-feedback beat.
    // It keeps turning for as long as the state lasts, because the wearer may
    // look down at any point in the cycle and the last page has to come round.
    let shown = line;
    if (line !== state.outcome && !captionFits(line, glass ?? WIDE_GLASS)) {
      const pageKey = JSON.stringify([line, glass?.maxWidth]);
      if (statePageOf !== pageKey) {
        statePages = captionPages(line, glass ?? WIDE_GLASS); statePage = 0; statePageOf = pageKey; statePageUntil = now() + CAPTION_OUTCOME_MS;
      } else if (now() >= statePageUntil) {
        statePage = (statePage + 1) % statePages.length; statePageUntil = now() + CAPTION_OUTCOME_MS;
      }
      shown = statePages[statePage] ?? line;
    } else if (statePageOf) { statePages = []; statePage = 0; statePageOf = ''; }
    if (clearance && drawn && now() - lastVerifiedAt >= CAPTION_RESEAT_MS) {
      lastVerifiedAt = now();
      let measurable = false;
      try { measurable = viewsAvailable ? viewsAvailable() : clearance()?.views?.length === 2; }
      catch { /* The drawing is unmeasurable. */ }
      if (measurable && seat?.columnBound && measureSeatNow()?.outcome !== 'shown') {
        remove(); blockedLine = shown; seatAim = headAim(pose);
      }
      if (!measurable) {
        remove(); blockedLine = shown; seatAim = headAim(pose);
        const receipt = { outcome: 'unmeasured', measured: false, reason: 'no-eye-views' };
        record('talk-caption-seat', receipt);
        if (shown === state.outcome) reportOutcome(receipt, { retain: true });
      }
    }
    const menu = menuObstacle();
    const nextMenu = JSON.stringify([menu, menu.plates, currentColumn()]);
    if (pending?.line === shown && pending?.menu === nextMenu) return;
    if ((shown === drawn || blockedLine === shown) && nextMenu === lastMenu) {
      if (blockedLine === shown) {
        if (now() - lastDrawAt < Math.min(1600, CAPTION_RESEAT_MS * 2 ** Math.min(Math.max(0, blockedAttempts - 1), 3))) return;
        blockedLine = ''; reseatNow = true;
      }
      // Same words: this is only a re-seat, and a re-seat is a mesh build. Rate
      // limit it, or a wearer turning their head rebuilds the plate at 72 Hz.
      // Both of those tests are levelled, so neither sees a head tipped
      // back. A card the eyes could not hold keeps its right to another seat
      // for as long as the wearer keeps moving, and costs nothing when they
      // are still.
      //
      // A repeated sentence whose standing seat the eyes no longer hold
      // sets `reseatNow`, and both tests above are blind to the pitch that put
      // it there. One re-seat is owed before either may refuse this call; the
      // caller is waiting on an answer the rate limit would otherwise defer.
      if (!reseatNow) {
        if (seatReceipt?.outcome === 'shown') {
          if ((seat?.columnBound || driftDegrees(pose) < CAPTION_DRIFT_DEGREES) && menuSeatWithinView(seatPoints, pose)) return;
        } else if (!aimMoved(pose)) return;
        if (now() - lastDrawAt < CAPTION_RESEAT_MS) return;
      }
    }
    lastMenu = nextMenu;
    if (nextMenu !== blockedMenu || shown !== blockedText) {
      blockedAttempts = 0;
    }
    blockedMenu = nextMenu; blockedText = shown;
    if (blockedLine === shown || !drawn) blockedAttempts++;
    lastDrawAt = now(); reseatNow = false;
    const requested = ++sequence;
    pending = { line: shown, menu: nextMenu };
    building = building.then(() => (closed || requested !== sequence ? undefined : draw(shown, pose)))
      .catch(error => {
        if (closed || requested !== sequence) return;
        blockedLine = shown; remove(); seatAim = headAim(pose);
        record('talk-caption-seat', { outcome: 'failed', error: error?.message });
        record('talk-caption', { outcome: 'failed', error: error?.message });
        if (shown === state.outcome) { outcomeNeedsHold = false; reportOutcome({ outcome: 'failed' }); }
      })
      .finally(() => { if (requested === sequence) pending = undefined; });
  }

  let lastDrawAt = 0, lastMenu = '', blockedLine = '', reseatNow = false;
  let blockedAttempts = 0, blockedMenu = '', blockedText = '';
  let attemptLine = '', attemptDeadline = 0, attemptStopped = false;

  /** Is the committed seat still the one this pose can read? The same two
   * tests `refresh` re-seats on, asked before a repeated sentence is allowed to
   * inherit the seat receipt the previous one earned.
   *
   * Both of those tests are levelled -- `driftDegrees` compares yaw alone
   * and `menuSeatWithinView` works in the upright design frame -- so a head
   * that pitched rather than turned passes both while the card has left one or
   * both eyes. The standing seat is therefore re-measured in the eye views the
   * wearer has now, and only a card both eyes still hold whole may hand its
   * receipt to the repeat. Where the page can supply no eye views there is
   * nothing to re-measure, and the receipt already says `unmeasured`.
   */
  function seatHolds() {
    const pose = head();
    if (!pose || !seatPoints.length || !seatReceipt) return false;
    if (!((seat?.columnBound || driftDegrees(pose) < CAPTION_DRIFT_DEGREES) && menuSeatWithinView(seatPoints, pose))) return false;
    const measured = measureSeatNow();
    return clearance ? measured?.outcome === 'shown' : true;
  }

  return {
    /** The line the wearer is reading, for diagnostics and tests. */
    text: () => drawn,
    /** The drawn plate's corners in room metres, none while it is hidden. */
    platePoints: () => (drawn ? seatPoints : []),
    /**
     * Update what the caption says.
     *
     * @param {object} next any subset of `talking`, `sending`, `outcome`,
     *   `holding`, `modifier`, `notice`, `progress`, and `holdMs` -- how long
     *   an `outcome` or a `notice` must stay readable, clamped to
     *   `CAPTION_OUTCOME_MS` below and `CAPTION_MAX_HOLD_MS` above
     */
    set(next = {}) {
      // Zero is a default reading window, never a persistent notice/progress
      // sentinel. Ongoing input states omit holdMs and retire on their event.
      if (next.holdMs === 0 && (next.notice || next.progress))
        next = { ...next, outcome: next.outcome || next.notice || next.progress, notice: '', progress: '' };
      // A notice that names a hold is a reading window like any other. One
      // that names none is an ongoing input state and keeps its old lifetime:
      // the caller clears it when the grip or the hold-to-reset ends.
      if (typeof next.notice === 'string') {
        if (next.notice && Number.isFinite(next.holdMs) && next.holdMs > 0) {
          noticeHold = Math.min(CAPTION_MAX_HOLD_MS, Math.max(CAPTION_OUTCOME_MS, next.holdMs));
          noticeUntil = now() + noticeHold;
          // A window that restarts on a sentence already on the glass starts
          // its measured hold here, not at the draw that first put it up.
          if (next.notice === drawn) drawnAt = now();
        } else { noticeUntil = 0; noticeHold = CAPTION_OUTCOME_MS; }
      }
      let repeatReceipt;
      if (typeof next.outcome === 'string' && next.outcome) {
        reportOutcome({ outcome: 'superseded' });
        attemptLine = '';
        outcomeReporter = typeof next.onSeat === 'function' ? next.onSeat : undefined;
        outcomeHoldAfterDraw = Boolean(outcomeReporter);
      }
      // Any outcome too long for the glass is paged, and every page gets the
      // reply window the caller asked for. A new outcome replaces the pages.
      //
      // An earlier run paged only what the host marked `complete`, which was the source
      // refusals; a spoken answer was not marked and so was cut instead. On
      // a 26-word reply drew `This reply is a reading window…` and
      // the rest of the sentence was never shown. `complete`
      // is still accepted, and no longer decides anything: no caption kind may
      // end in an ellipsis, so the length of the sentence decides.
      if (typeof next.outcome === 'string' && next.outcome) {
        outcomeWidth = columnGlass()?.maxWidth;
        const glass = outcomeGlass = replyGlass(next.outcome);
        const pages = glass ? captionPages(next.outcome, glass)
          : captionFits(next.outcome, NARROW_GLASS) ? [] : captionPages(next.outcome);
        outcomePages = pages.length > 1 ? pages : [];
        outcomePage = 0;
        if (pages.length) next = { ...next, outcome: pages[0] };
      }
      if (typeof next.talking === 'boolean' || typeof next.sending === 'boolean') state.progress = '';
      for (const key of ['talking', 'sending', 'holding', 'modifier']) {
        if (typeof next[key] === 'boolean') state[key] = next[key];
      }
      for (const key of ['outcome', 'notice', 'progress']) {
        // A chapter refresh or an older toolbar timer can request a clear
        // while a newer spoken reply still owns its three-second window.
        // New replies replace it; a brief link warning preserves its window.
        if (key === 'outcome' && next[key] === '' && state.outcome
          && (outcomeNeedsHold || (outcomePages.length && (now() < outcomeUntil || outcomePage + 1 < outcomePages.length))
            || (reported === state.outcome && now() < outcomeUntil))) continue;
        if (typeof next[key] === 'string') state[key] = next[key];
      }
      // An outcome is what became of the sentence, so it ends the press it
      // answers. Without this the caption would still read "Sending…" over a
      // command that had already run.
      if (typeof next.outcome === 'string' && next.outcome) {
        state.talking = false; state.sending = false; state.progress = '';
        const asked = Number.isFinite(next.holdMs) && next.holdMs > 0 ? next.holdMs : CAPTION_OUTCOME_MS;
        outcomeHold = Math.min(CAPTION_MAX_HOLD_MS, Math.max(CAPTION_OUTCOME_MS, asked));
        outcomeUntil = now() + outcomeHold;
        // Same rule as a notice. A repeated sentence gets a fresh window,
        // so its measured hold is counted from the window, not from the draw.
        if (state.outcome === drawn) drawnAt = now();
        outcomeNeedsHold = outcomeHoldAfterDraw && captionLine(state, { ...connectionStatus(), line: '' }).trim() === state.outcome && drawn !== state.outcome;
        // The same sentence arriving again used to answer its caller from
        // the standing receipt right here, before `refresh` had decided whether
        // the head had moved past `CAPTION_DRIFT_DEGREES` and the card had to
        // be re-seated. A positioning failure could then never retract that
        // `drawn: true`. Hold the receipt until `refresh` has spoken.
        if (drawn === state.outcome && !suspended && seatReceipt) {
          if (seatHolds()) repeatReceipt = seatReceipt;
          else reseatNow = true;
        }
      }
      refresh();
      // The seat survived `refresh` untouched: it is still the card on the
      // glass, so the receipt it earned is this caption's answer too. A
      // re-seat, a teardown or a queued build reports its own outcome instead.
      if (repeatReceipt && !closed && !suspended && !pending
        && seatReceipt === repeatReceipt && drawn === state.outcome) reportOutcome(repeatReceipt);
    },
    /**
     * One immersive frame. Re-seats the caption when the head has turned past
     * `CAPTION_DRIFT_DEGREES` and expires an outcome line. `refresh` costs a
     * string compare and one dot product unless something actually changed.
     */
    frame() { refresh(); },
    /** Hide stale glass while component geometry is changing; retain the reply. */
    suspend() { suspended = true; sequence++; pending = undefined; remove(); },
    /** A committed scene change invalidates the seat once, outside the frame loop. */
    invalidate() { if (attemptStopped) attemptLine = ''; suspended = false; seat = undefined; blockedLine = ''; lastMenu = ''; blockedMenu = '';
      blockedAttempts = 0; pending = undefined; sequence++; refresh(); },
    /** Take the caption down and forget every state it was showing. */
    clear() {
      reportOutcome({ outcome: 'cleared' }); outcomeNeedsHold = false; noticeUntil = 0;
      state.talking = false; state.sending = false; state.holding = false;
      compact = ''; compactPending = false; compactUntil = 0;
      state.modifier = false; state.outcome = ''; state.notice = ''; state.progress = ''; reported = '';
      sequence++; pending = undefined; remove();
    },
    dispose() { offAssistant(); closed = true; sequence++; reportOutcome({ outcome: 'unavailable' }); remove(); return building.catch(() => {}); },
  };
}
