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
 * Holds that last only for the chapter they were taken in. An agent's move
 * shows the wearer something in this chapter; the next chapter, a start and
 * Done open at their own views. The wearer's own moves are not listed: they
 * carry across ordinary chapters.
 */
export const CHAPTER_PLACEMENT_REASONS = Object.freeze(['agent-placement']);

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
  // Changes at every chapter end: a chapter hold from an earlier one has expired.
  let era = newOwner();
  let owner = newOwner();
  return {
    // Opaque, page-local history metadata. Never included in a scientific capture.
    ownership() {
      const value = Object.freeze({ token: owner, held, chapter, heldChapter, reason, era });
      checkpoints.add(value); return value;
    },
    // `renew` brings that ownership back under a new owner token, for a
    // placement that returns to an earlier owner's pose without undoing to it.
    restoreOwnership(value, { renew = false } = {}) {
      if (!checkpoints.has(value)) throw new TypeError('Unknown placement owner.');
      // A hold taken for a chapter that has since ended stays ended: history
      // brings back its pose and owner, never its hold.
      const expired = value.held && CHAPTER_PLACEMENT_REASONS.includes(value.reason) && value.era !== era;
      held = value.held && !expired; reason = expired ? 'chapter-ended' : value.reason;
      heldChapter = held && value.heldChapter === value.chapter ? chapter : -1;
      at = now(); owner = renew ? newOwner() : value.token;
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
    /**
     * The chapter ended (Next, Back, a start, Done). A hold taken for that
     * chapter alone ends with it; the wearer's own hold stays. Returns the
     * release, or undefined when nothing was released.
     */
    endChapter(value = 'chapter-ended') {
      era = newOwner();
      if (held && !CHAPTER_PLACEMENT_REASONS.includes(reason)) return undefined;
      // Nothing held: the owner still changes, so an undo or redo of an
      // agent move from the chapter that ended cannot bring its hold back.
      if (!held) { owner = newOwner(); return undefined; }
      held = false; heldChapter = -1; reason = value; at = now(); owner = newOwner();
      return { held, chapter, reason };
    },
    /**
     * A chapter change failed and put back the pose it found: the owner it
     * found comes back with that pose. `found` and `ended` are `ownership()`
     * read just before and just after `endChapter`; anything that has taken
     * the placement since (a hand, a spoken move, Reset) stands instead.
     */
    resumeChapter(found, ended) {
      if (!checkpoints.has(found) || !checkpoints.has(ended) || ended.token !== owner) return false;
      held = found.held; reason = found.reason;
      heldChapter = held && found.heldChapter === found.chapter ? chapter : -1;
      at = now(); owner = found.token; era = found.era;
      return true;
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
