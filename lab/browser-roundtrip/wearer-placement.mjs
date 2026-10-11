/**
 * The rules that keep the wearer's own hands in charge.
 *
 * In the headset the structure could not be moved during a demo, its position
 * kept changing underneath, and the menu moved while the wearer worked. All
 * three are the same defect seen from three places — the page kept re-deciding
 * where things go while the wearer was deciding it themselves — and all three
 * answers are here, as pure functions a Node test can run without a WebXR
 * runtime.
 *
 *  1. `createPlacementHold` — who owns the structure's place right now.
 *  2. `latchedStandoff` — the menu's seat, which may only move when the wearer
 *     asks for it.
 *  3. `captionExpanded` — how much text the caption plate is allowed.
 *
 * Nothing here reads the renderer, the session or the clock on its own: every
 * decision is a function of values a caller passes in, so the same rule can be
 * proven in Node and read in the headset.
 */

/** Why the wearer's placement took over, for the diagnostic ring. */
export const PLACEMENT_TAKEOVER_REASONS = Object.freeze(['grab', 'voice-move', 'voice-turn', 'voice-scale', 'menu']);

/**
 * The wearer's placement hold.
 *
 * Two different questions, deliberately kept apart:
 *
 * - `allowsChapterFraming()` is per CHAPTER. A wearer who moves the structure
 *   mid-chapter has said where they want it, so nothing automatic may move it
 *   again until the lesson turns the page. The next chapter frames normally:
 *   the lesson still shows things, it just never fights the wearer.
 * - `holdsPlacement()` is per SESSION. Once the wearer has placed the structure
 *   themselves, an AUTHORED placement (a lesson chapter's stored
 *   `placement`, a cached scene's stored placement) may never overwrite it.
 *   That is the changing-position half: those values
 *   were recorded from a different head, in a different room, and replaying
 *   them teleports the molecule out of the wearer's hands.
 *
 * Both are released together, and only by the wearer asking for the seat back:
 * Reset view, Fit, or a spoken "recenter". Agent placement history restores
 * its prior owner when undone; a newer physical takeover always stays held.
 */
export function createPlacementHold({ now = () => Date.now() } = {}) {
  let chapter = 0, heldChapter = -1, held = false, reason, at = 0, moves = 0;
  const checkpoints = new WeakSet();
  const newOwner = () => Object.freeze({});
  let owner = newOwner();
  return {
    // Opaque, page-local history metadata. Never included in a scientific capture.
    ownership() {
      const value = Object.freeze({ token: owner, held, chapter, heldChapter, reason });
      checkpoints.add(value); return value;
    },
    restoreOwnership(value) {
      if (!checkpoints.has(value)) throw new TypeError('Unknown placement owner.');
      held = value.held; reason = value.reason;
      heldChapter = held && value.heldChapter === value.chapter ? chapter : -1;
      at = now(); owner = value.token;
    },
    /**
     * The wearer moved the structure. `reason` is one of
     * `PLACEMENT_TAKEOVER_REASONS`; an unknown one is still a takeover,
     * because a hand on the molecule is a hand on the molecule.
     */
    takeover(value = 'grab') {
      held = true; heldChapter = chapter; reason = value; at = now(); moves += 1; owner = newOwner();
      return { held, chapter, reason, moves };
    },
    /** A lesson chapter began. Clears the per-chapter hold, never the session one. */
    chapterStart() { chapter += 1; return chapter; },
    /** The wearer asked for the authored seat back. */
    release(value = 'reset') {
      held = false; heldChapter = -1; reason = value; at = now(); owner = newOwner();
      return { held, chapter, reason };
    },
    /** Whether a lesson chapter may frame the structure automatically. */
    allowsChapterFraming() { return !(held && heldChapter === chapter); },
    /** Whether an authored placement must yield to the wearer's own. */
    holdsPlacement() { return held; },
    /** The whole state, for the record ring. */
    state() { return { held, chapter, heldChapter, reason: reason ?? null, at, moves }; },
  };
}

/**
 * The menu's stand-off, latched.
 *
 * `spatial-toolbar.mjs` measures how far out the panel has to sit for the
 * structure to clear its glass, and re-seats the menu whenever that number
 * changes. Every chapter reframes the structure and every grab moves it, so
 * that measurement changed constantly and the menu walked around the wearer
 * while they were working.
 *
 * The seat is therefore latched. It is measured when the menu is seated — a
 * fresh entry, the Move menu row, Reset view — and then held at that value no
 * matter what the structure does, until the wearer asks for the menu again.
 *
 * @param {number} current the stand-off in force, in metres
 * @param {number} required what this frame's geometry would ask for
 * @param {boolean} latched false only while the menu is being seated
 * @returns {number} the stand-off to draw at
 */
export function latchedStandoff({ current = 0, required = 0, latched = true, step = 0.05, release = 0.25 } = {}) {
  if (!Number.isFinite(required) || required < 0) return current;
  if (latched) return current;
  if (required > current + step / 2 || required < current - release) {
    return Math.ceil(Math.max(0, required) / step) * step;
  }
  return current;
}

/**
 * How long a chapter's full caption stays on the plate, in milliseconds.
 *
 * A full caption fills the space in front of the wearer. A lesson
 * chapter's spoken line is up to a dozen words and the plate wraps rather than
 * clips, so a chapter caption was three or four lines of glass hanging in front
 * of a molecule the wearer came to look at.
 *
 * Four seconds is the read time of that dozen words and the same window
 * `growth-caption.mjs` already gives a growth sentence, so the two overlays
 * behave alike. After it the plate keeps the chapter's title and one short line
 * — enough to know where the lesson is — and the full text comes back whenever
 * the wearer holds Talk or presses Play, which is exactly when they are asking
 * to be read to.
 */
export const CAPTION_FULL_MS = 4000;

/** The most lines the capped caption may take. One short line, by contract. */
export const CAPTION_SHORT_LINES = 1;

/**
 * Whether the caption plate may show its full text this frame.
 *
 * @param {boolean} talking the wearer is holding Talk (A/X)
 * @param {boolean} playing the tour is running itself
 * @param {number} chapterStartedAt when the live chapter arrived, in the same clock as `nowMs`
 */
export function captionExpanded({ talking = false, playing = false, chapterStartedAt, nowMs = 0, durationMs = CAPTION_FULL_MS } = {}) {
  if (talking === true || playing === true) return true;
  if (!Number.isFinite(chapterStartedAt) || !Number.isFinite(nowMs)) return false;
  return nowMs >= chapterStartedAt && nowMs - chapterStartedAt < durationMs;
}
