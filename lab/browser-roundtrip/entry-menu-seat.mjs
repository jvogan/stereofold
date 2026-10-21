/**
 * Where the menu column sits before the wearer has asked for anything.
 *
 * The default view used to put the menu over the structure and hide it. At the
 * shipped seat the menu's own lens rectangle runs from -0.79 to -0.46 of the
 * lens half width, and the entry framing gives the structure up to
 * `SUBJECT_WHOLE_LENS_CEILING` (0.55) of that same half width centred on the
 * eye. The inboard column of buttons is therefore drawn over the middle of the
 * molecule, which is what the wearer arrives looking at.
 *
 * The fix is to seat the entry menu further outboard, by the least amount that
 * puts its inboard edge past the subject band with `PLATE_CLEARANCE_LENS` to
 * spare, and to keep every other seat exactly as it is. A chapter's own framing
 * pass (`focus-placement.mjs` -> `menuAvoidance`) already moves the SUBJECT out
 * from behind the menu once a lesson is running; nothing does that at entry,
 * because there is no chapter to frame.
 *
 * Only `rightMeters` moves. `createToolbarPanel` brings the bearing back in
 * until the panel's outboard edge is inside the lens. When no rung clears,
 * the answer is the readable rung with the widest measured gap, reported
 * honestly as `clear: false`.
 *
 * Production clearance uses committed lit vertices and actual stereo views
 * through measureEntryStandoff. The nominal band remains an analytical fallback
 * for callers without render geometry; it cannot certify a production seat.
 * This module is import-free of Mol*, so the lab suite runs it in Node.
 */
import { prepareEntryStandoff } from './entry-standoff.mjs';
import { HALF_IPD_METERS, createToolbarPanel, toolbarCaptionPoints, toolbarDrawnMenuPoints, toolbarLayoutForOutboard, toolbarSeatBasis } from './spatial-toolbar-geometry.mjs';
import { menuSeatWithinView, menuSeatWithinGlance } from './menu-view-band.mjs';
import { PLATE_CLEARANCE_LENS, SUBJECT_WHOLE_LENS_CEILING, lensRect, lensRectFromPoints, lensRectsOverlap } from './plate-standoff.mjs';

/**
 * The share of the lens half width the entry structure is allowed to cover.
 *
 * The band the framing solver works in is 0.40 (`SUBJECT_LENS_FLOOR`) to 0.55
 * (`SUBJECT_WHOLE_LENS_CEILING`); the top of it is the rectangle the menu has
 * to clear, because a menu that only clears the floor is over the structure
 * again the moment the fit lands at the ceiling.
 */
export const ENTRY_SUBJECT_LENS = SUBJECT_WHOLE_LENS_CEILING;

/**
 * The outboard multipliers tried, in order, on the seat's `rightMeters`.
 *
 * One is the shipped seat: a build whose menu already clears the band pays
 * nothing and moves nothing. The rest are a coarse ladder rather than a solve,
 * because each rung costs one `createToolbarPanel` and the answer is only ever
 * needed once, when the seat latches.
 */
// Expanded controls may need more outboard travel than compact entry;
// keep measuring each rung before accepting it.
export const ENTRY_MENU_OUTBOARD_FACTORS = Object.freeze([1, 1.3, 1.6, 2, 2.5, 3, 3.5]);

/**
 * Does a measured clearance leave the standing margin in BOTH eyes?
 *
 * `measureEntryStandoff` reports a signed horizontal gap in each eye's own
 * tangent units; `clearance` is a share of the lens half width. The two are
 * compared in the eye's units, which is what `projectionMatrix[0]` converts.
 * A missing measurement, or a view carrying no projection, is not a clear
 * seat: a frame nobody can read certifies nothing.
 *
 * Shared, because the entry ladder below and the tour re-solve in
 * `spatial-toolbar.mjs` must not disagree about what "clear" means.
 */
export function menuSeatClears(measured, geometry, clearance = PLATE_CLEARANCE_LENS) {
  if (!Number.isFinite(measured?.clearanceLeft) || !Number.isFinite(measured?.clearanceRight)) return false;
  const margin = eye => {
    const scale = geometry?.views?.find(view => view.eye === eye)?.projectionMatrix?.[0];
    return Number.isFinite(scale) && Math.abs(scale) > 0 ? clearance / Math.abs(scale) : NaN;
  };
  const left = margin('left'), right = margin('right');
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  return measured.clearanceLeft > left && measured.clearanceRight > right;
}

/**
 * The entry seat's outboard factor, and what it bought.
 *
 * @param {object} options
 * @param {Array} options.rows the menu rows as `createToolbarPanel` takes them
 * @param {object} options.head the entry head pose
 * @param {object} options.constants the seat this session would otherwise use
 * @param {Array} [options.readout] the caption lines, which set the plate height
 * @param {string} [options.status] the status row text
 * @param {object} [options.geometry] committed render objects, stereo views and room transform
 * @param {number} [options.subjectLens] the subject's half width, as a lens share
 * @param {number} [options.clearance] the gap the menu must leave, as a lens share
 * @param {readonly number[]} [options.factors] the ladder to try
 * @returns {{factor:number, clear:boolean, constants:object, rect:object|null, subject:object}|undefined}
 */
export function entryMenuSeat({ rows, head, constants, readout = [], status = '', assistantLines = [],
  subjectLens = ENTRY_SUBJECT_LENS, clearance = PLATE_CLEARANCE_LENS,
  factors = ENTRY_MENU_OUTBOARD_FACTORS, geometry, measureText, seatAnchor, measureStandoff } = {}) {
  const basis = toolbarSeatBasis(head);
  if (!basis || !constants || !Array.isArray(rows) || !rows.length) return undefined;
  const subject = lensRect({ x: 0, y: 0, halfWidth: Math.max(0, subjectLens), halfHeight: Math.max(0, subjectLens) });
  const ladder = (Array.isArray(factors) ? factors : ENTRY_MENU_OUTBOARD_FACTORS)
    .filter(factor => Number.isFinite(factor) && factor >= 1);
  const measure = geometry ? measureStandoff ?? prepareEntryStandoff(geometry) : undefined;
  let best, bestGap = -Infinity, fallback, fallbackGap = -Infinity, last;
  for (const factor of ladder.length ? ladder : [1]) {
    // The rung is a bearing, not a range. `toolbarLayoutForOutboard` holds the
    // seat's range while it swings, so a rung is measured at the size it will
    // actually be drawn at rather than at the shrunken size a bare multiply on
    // `rightMeters` used to give it.
    const seat = toolbarLayoutForOutboard(factor, constants);
    let rect, eyes, measured, points, panel;
    try {
      panel = createToolbarPanel({ rows, head, constants: seat, readout, status, assistantLines, measureText, seatAnchor });
      points = [...toolbarDrawnMenuPoints(panel), ...toolbarCaptionPoints(panel)];
      if (geometry) measured = measure(points);
      rect = lensRectFromPoints({ points, origin: basis.origin, basis });
      // The near menu has more parallax than the seated structure. A centre
      // view touching the band's margin does not prove either eye clears it.
      eyes = [-1, 1].map(side => lensRectFromPoints({ points, basis,
        origin: basis.origin.map((value, axis) => value + side * HALF_IPD_METERS * basis.right[axis]) }));
    } catch { rect = undefined; }
    // A panel that cannot be projected is no evidence for a seat.
    if (!rect) continue;
    const nominalClear = eyes?.every(eye => eye && !lensRectsOverlap(eye, subject, clearance)) === true;
    // Production always supplies geometry. Unreadable stereo geometry cannot
    // claim that the nominal centre band is a measured silhouette.
    const withinView = menuSeatWithinView(points, head);
    const clear = withinView && (geometry ? menuSeatClears(measured, geometry, clearance) : nominalClear);
    const candidate = { factor, clear, constants: seat, rect, subject: geometry ? null : subject, measured };
    last = candidate;
    if (clear) return candidate;
    // A lens-capped rung may swing back in. Keep the measured rung with the
    // greatest gap rather than assuming the last bearing overlaps least.
    const gap = geometry ? Math.min(measured?.clearanceLeft ?? -Infinity, measured?.clearanceRight ?? -Infinity)
      : Math.min(...(eyes ?? []).map(eye => eye ? Math.max(subject.left - eye.right, eye.left - subject.right) : -Infinity));
    if (withinView && (!best || gap > bestGap + 1e-8)) { best = candidate; bestGap = gap; }
    if (!fallback || gap > fallbackGap + 1e-8) { fallback = candidate; fallbackGap = gap; }
  }
  // With no stereo score, the ladder gives no basis to prefer an earlier rung.
  return Number.isFinite(bestGap) || Number.isFinite(fallbackGap) ? best ?? fallback : last;
}
