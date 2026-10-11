/**
 * When the name plates have to be solved against the menu again.
 *
 * An earlier pass gave `label-layout.mjs` the menu column's rectangle, and
 * a later one made sure that rectangle actually reaches it — the panel
 * is not drawn yet when `canvas.xr.isPresenting` flips, so the solver has to be
 * asked a second time once it is. Both passes happen at entry and neither one
 * survives the wearer touching the menu.
 *
 * The column moves after that. The Move row re-seats it on the pose the wearer
 * has now, the Menu row folds the grid down to the compact column and opens it
 * again, a reset view does both, and a cutaway can push the whole panel to a
 * new depth without the wearer asking for anything. Every one of those changes
 * the rectangle the plates were solved against, so a plate can come to rest
 * under the column, or the column's old footprint can go on holding plates away
 * from a space it has left.
 *
 * The answer is not to solve per frame. The plate offsets are static uniforms,
 * so re-solving while the panel is still moving makes the names swim — which is
 * the defect the layout comment in `viewer.mjs` warns about — and a re-seat is
 * several redraws, not one. This module takes the redraws and gives back one
 * re-solve per settled motion, named with every reason that went into it.
 *
 * Two rules make it safe to call on every redraw:
 *
 * 1. An incidental redraw whose footprint is unchanged is not a motion. A
 *    status line rewritten inside the same glass writes no layout record. An
 *    explicit reseat always solves, even when the wearer held the same pose.
 * 2. A burst coalesces on its trailing edge, so the one re-solve is solved
 *    against where the column came to rest rather than against somewhere it
 *    passed through. `MENU_MAX_WAIT_MS` bounds that wait, because a motion that
 *    never settles would otherwise starve the plates of a re-solve forever.
 *
 * This module is import-free of Mol* and of the DOM, so the lab suite runs it
 * in Node with an injected clock.
 */

/**
 * How long the footprint has to hold still before the plates are re-solved.
 *
 * Long enough to swallow the two redraws one Menu press makes — the fold and
 * the re-seat that follows it go through the toolbar's action chain an XR tick
 * apart — and short enough that the plates have moved before the wearer has
 * finished looking at what they just pressed.
 */
export const MENU_SETTLE_MS = 220;

/**
 * The longest a burst may put the re-solve off.
 *
 * A trailing debounce alone can be starved: a footprint that changes every
 * frame reschedules forever and the plates are never solved against any of it.
 * After this much of a continuously moving column the plates are solved against
 * wherever it is at that moment, and the next settle solves them again.
 */
export const MENU_MAX_WAIT_MS = 1000;

/** Metres, rounded, so a recomputed-but-identical panel is not a motion. */
const FOOTPRINT_PRECISION = 1000;

/**
 * The drawn menu column as one comparable string, in millimetres.
 *
 * `menuPoints()` answers in XR room metres and rebuilds its points from the
 * panel every time it is asked, so two identical panels can differ in the last
 * bits of a float. Rounding to the millimetre — the same step the toolbar's own
 * seat signature uses — keeps that from reading as a move.
 *
 * @param {Array<ArrayLike<number>>} [points] drawn points, in XR room metres
 * @returns {string}
 */
export function menuFootprintSignature(points = []) {
  if (!Array.isArray(points)) return '';
  return points
    .map(point => [0, 1, 2]
      .map(axis => Math.round((Number(point?.[axis]) || 0) * FOOTPRINT_PRECISION))
      .join(','))
    .join(';');
}

/** The reasons of one burst, in the order they happened, without repeats. */
function mergeReasons(into, reason) {
  for (const name of Array.isArray(reason) ? reason : [reason]) {
    if (typeof name === 'string' && name && !into.includes(name)) into.push(name);
  }
  return into;
}

/**
 * One re-solve per settled menu motion.
 *
 * @param {object} options
 * @param {(reason:string) => void} options.solve run one plate re-solve; the
 *   reason is every cause of the burst, in order, comma separated
 * @param {number} [options.settleMs]
 * @param {number} [options.maxWaitMs]
 * @param {() => number} [options.now] injected for the lab suite
 * @param {(fn:Function, ms:number) => any} [options.schedule]
 * @param {(handle:any) => void} [options.cancel]
 */
export function createMenuResolve({ solve, settleMs = MENU_SETTLE_MS, maxWaitMs = MENU_MAX_WAIT_MS,
  now = () => Date.now(), schedule = (fn, ms) => setTimeout(fn, ms), cancel = handle => clearTimeout(handle) } = {}) {
  let footprint;
  let reasons = [];
  let timer;
  let burstStartedAt = 0;

  /** Take the footprint as it is without asking for a re-solve of it. */
  function seed(points) { footprint = menuFootprintSignature(points); }

  function fire() {
    timer = undefined;
    if (!reasons.length) return;
    const named = reasons.join(',');
    reasons = [];
    // A failed re-solve leaves the wearer the plates they already have, which
    // is the same contract the entry pass keeps. It must not take the timer
    // down with it.
    try { solve(named); } catch { /* The plates keep the layout they have. */ }
  }

  /**
   * The panel has been redrawn. Returns whether that was a motion at all.
   *
   * @param {{points?: Array<ArrayLike<number>>, reason?: string|string[]}} [move]
   */
  function moved({ points, reason = 'follow' } = {}) {
    const next = menuFootprintSignature(points);
    // Explicit Move is a requested solve even when the wearer held still.
    const explicitReseat = (Array.isArray(reason) ? reason : [reason]).includes('reseat');
    if (next === footprint && !explicitReseat) return false;
    footprint = next;
    if (!reasons.length) burstStartedAt = now();
    mergeReasons(reasons, reason);
    // A motion the caller could not name is still a motion. Leaving the list
    // empty would swallow the re-solve at `fire`, which is the one failure the
    // plates cannot recover from on their own.
    if (!reasons.length) reasons.push('follow');
    if (timer !== undefined) cancel(timer);
    timer = undefined;
    // Bounded: a column that has been moving for a second gets its re-solve
    // now, against where it is, rather than one more deferral.
    if (now() - burstStartedAt >= maxWaitMs) { fire(); return true; }
    timer = schedule(fire, settleMs);
    return true;
  }

  /** Drop a pending re-solve. The session is going away; the plates go with it. */
  function dispose() {
    if (timer !== undefined) cancel(timer);
    timer = undefined;
    reasons = [];
  }

  return Object.freeze({ seed, moved, dispose, pending: () => timer !== undefined });
}
