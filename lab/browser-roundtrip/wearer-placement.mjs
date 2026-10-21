/**
 * The rules that keep the wearer's own hands in charge.
 *
 * In the headset the structure could not be moved during a demo, its position
 * kept changing underneath, and the menu moved while the wearer worked. All
 * three are the same defect seen from three places — the page kept re-deciding
 * where things go while the wearer was deciding it themselves — and the
 * answers are here, as pure functions a Node test can run without a WebXR
 * runtime.
 *
 *  1. `createPlacementHold` — who owns the structure's place right now.
 *  2. `latchedStandoff` — the menu's seat, which may only move when the wearer
 *     asks for it.
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
 * `holdsPlacement()` retains manual placement across ordinary chapters and
 * scene restores. The player releases it once when entering a changed authored
 * frame; rendering that chapter cannot release a subsequent manual takeover.
 * `allowsChapterFraming()` tracks per-chapter input for presentation helpers.
 * Reset, Fit, Recenter, Done and source changes also release ownership.
 * Placement history can restore its prior owner; newer physical input wins.
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
