/**
 * The loaded lesson's visual baseline, and who owns the key.
 *
 * A lesson's first chapter is the structure's RESTING look: the colour key and
 * the optional name plates a wearer arrives to before any tour starts and comes
 * back to when one stops. Three separate callers move that baseline around —
 * the hydrate that installs it, the takeover that releases a chapter back to
 * it, and the restore that replays a saved scene over it — and each of them
 * used to decide on its own whether the molecule was theirs to repaint.
 *
 * They disagreed, which is the defect this holds:
 *
 * - `setLessonRestingState` painted chapter one unconditionally, so a scene the
 *   wearer had just restored, or a key they had asked for by name, was
 *   overwritten by the next hydrate;
 * - the takeover repainted even when nothing was painted and there was nothing
 *   to put back, and putting a tour away repainted the baseline twice — once
 *   from the restore and once from the clear that followed it;
 * - the plate flag was moved before the paint was awaited, so a rejected paint
 *   left the viewer believing in plates that were never drawn.
 *
 * The rule in one place: a key belongs to whoever asked for it. A lesson's own
 * key ('lesson'), and the baseline this installs ('resting'), are the lesson's
 * to repaint. A key an agent or the wearer asked for by name is not — nobody
 * asked for a lesson when they asked for that.
 *
 * A key a saved scene names is whichever of those it was when it was saved, and
 * the saved scene says so. That matters because a RELOAD asks the question in
 * the wrong order: the scene is restored in the hydrate's `built` phase and the
 * baseline is installed later, in `placed`, so the restore has no baseline to
 * compare against. Before the capture carried its origin, the lesson's own
 * starting key came back from every reload recorded as 'command', the baseline
 * paint stood down, and the shipped telomerase lesson lost all ten name plates.
 *
 * Mol* never appears here. The paint, the snapshot and the plate rebuild all
 * arrive as functions, which is what lets the sequences be exercised without a
 * WebGL context or a headset.
 */

import { normalizeEmphasisState } from './lesson-emphasis.mjs';

/** An installed lesson keeps its names through chapter and command paints. */
export function platesWanted(installed, liveFlag, origin) {
  return liveFlag === true || ((origin === 'command' || origin === 'lesson') && installed?.componentLabels === true);
}

/**
 * Whether two colour keys are the same key.
 *
 * Used to tell a restored SAVED scene apart from a restored STARTING view: the
 * starting view carries the lesson's own resting key, so a clear that follows
 * it would repaint exactly what is already on the molecule.
 *
 * @param {object|undefined} a
 * @param {object|undefined} b
 * @returns {boolean}
 */
export function sameEmphasisKey(a, b) {
  if (!a || !b) return false;
  return JSON.stringify(normalizeEmphasisState(a)) === JSON.stringify(normalizeEmphasisState(b));
}

/**
 * @typedef {object} LessonRestingOptions
 * @property {(request: object) => Promise<unknown>} emphasize paints a key and records its origin
 * @property {() => unknown} snapshot the viewer snapshot returned when nothing is painted
 * @property {() => Promise<unknown>} rebuildLabels rebuilds the name plates alone
 * @property {() => {parts?: unknown[]}} getEmphasis the key the molecule is wearing
 * @property {() => string} getOrigin who asked for that key: 'lesson', 'resting' or 'command'
 */

/**
 * The lesson baseline, its plate flag, and the three decisions about them.
 *
 * @param {LessonRestingOptions} options
 */
export function createLessonResting({ emphasize, snapshot, rebuildLabels, getEmphasis, getOrigin } = {}) {
  for (const [name, fn] of Object.entries({ emphasize, snapshot, rebuildLabels, getEmphasis, getOrigin })) {
    if (typeof fn !== 'function') throw new TypeError(`A lesson resting state needs a ${name} function.`);
  }
  /** @type {{emphasis: object, componentLabels: boolean}|undefined} */
  let resting;
  /** Whether the live look asks for per-part name plates. */
  let labels = false;

  /**
   * Whether the painted key is the lesson's to repaint.
   *
   * The ordinary hydrate lands here with nothing painted at all, which is the
   * case that must still paint; a lesson or resting key is the lesson's by
   * definition. Anything else was asked for by name and is left alone.
   *
   * `incoming` is the baseline about to be installed, and it is the reload's
   * answer. A reload restores its saved scene in the hydrate's `built` phase,
   * before this baseline exists, so a capture saved by a page too old to name
   * its origin comes back as 'command' even when the key it names is the
   * lesson's own opening one. A key identical to the baseline is the baseline,
   * whoever the record says painted it: nobody chose it over the lesson, and
   * standing down here is what left the shipped telomerase lesson with zero
   * name plates after every reload.
   *
   * @param {object|undefined} incoming the baseline this install is about to
   *   paint, or undefined when the caller has none to compare against
   */
  function ownsPaintedKey(incoming) {
    const origin = getOrigin();
    if (origin === 'lesson' || origin === 'resting') return true;
    const painted = getEmphasis();
    if (!(painted?.parts?.length)) return true;
    return Boolean(incoming) && sameEmphasisKey(painted, incoming);
  }

  /**
   * Paint a key and move the plate flag with it, atomically.
   *
   * The flag says what is DRAWN, so it may only move once the paint that draws
   * it has resolved. A caller that swallows the rejection — the tour player's
   * `dropLessonEmphasis` does — would otherwise leave the viewer counting
   * plates that were never built, and the frame wait counts live plates.
   */
  async function paint(request, wantsLabels) {
    const previous = labels;
    labels = wantsLabels === true;
    try { return await emphasize(request); }
    catch (error) { labels = previous; throw error; }
  }

  return {
    /** CPU-only source rollback. Restoring a baseline must not start a paint. */
    checkpoint: () => structuredClone({ resting, labels }),
    restoreCheckpoint(value) { ({ resting, labels } = structuredClone(value)); },
    /** The installed baseline, or undefined on a viewer with no lesson. */
    state: () => resting,
    /** A new source is a new lesson: the previous baseline means nothing on it. */
    forget() { resting = undefined; labels = false; },
    /** Whether the live look asks for per-part name plates. */
    labelsEnabled: () => labels,
    /** The chapter's own `componentLabels`, read out of its appearance. */
    setLabelsEnabled(value) { labels = value === true; },

    /**
     * Release the active chapter back to the baseline, if it is ours to release.
     *
     * A lesson chapter fades everything but the part it is teaching. When a
     * takeover or a source change stops that lesson, nothing is left to own the
     * fade, and the wearer is handed a structure at twelve per cent opacity
     * with the last chapter's colours on it and no lesson to explain them.
     */
    async clear() {
      if (getOrigin() !== 'lesson') return snapshot();
      // Nothing painted and no baseline to put back: a takeover has nothing to
      // undo here, and repainting a plain structure plain is a wasted rebuild
      // on every grab. This short-circuit is why a takeover is free.
      if (!getEmphasis()?.parts?.length && !resting) return snapshot();
      return paint(resting ? { ...resting.emphasis, origin: 'resting' } : { parts: [], origin: 'resting' },
        resting?.componentLabels === true);
    },

    /**
     * Install or remove the baseline of the loaded lesson.
     *
     * The caller supplies only the first chapter. `componentLabels` is opt-in:
     * absent is false, so lessons that never authored plates keep drawing
     * exactly as they did. Framing and placement remain tour actions.
     */
    async install(value, { preserveEmphasis = false } = {}) {
      if (!value) {
        // The clear must be complete: no baseline, no plate flag, no plates,
        // and the resting paint taken back off if this viewer applied it.
        const had = resting;
        const hadLabels = labels;
        resting = undefined;
        labels = false;
        const origin = getOrigin();
        if (origin === 'lesson' || origin === 'resting') {
          try { return await emphasize({ parts: [], origin: 'resting' }); }
          catch (error) { resting = had; labels = hadLabels; throw error; }
        }
        // A key somebody asked for by name survives; only its plates go.
        await rebuildLabels();
        return snapshot();
      }
      const emphasis = normalizeEmphasisState(value.emphasis ?? { parts: [] });
      const had = resting;
      resting = { emphasis, componentLabels: value.componentLabels === true };
      // A restored scene, or a key the wearer asked for by name, is not the
      // lesson's to overwrite. The baseline is still recorded, so the next
      // takeover returns to it rather than to a plain structure.
      if (preserveEmphasis || !ownsPaintedKey(emphasis)) return snapshot();
      try { return await paint({ ...emphasis, origin: 'resting' }, resting.componentLabels); }
      catch (error) { resting = had; throw error; }
    },

    /**
     * The provenance a restored key should carry, and the plates that come with it.
     *
     * A restored STARTING view is the lesson's own baseline, so it is recorded
     * as 'resting' and the clear that follows it finds nothing left to do —
     * one repaint instead of two. Any other saved scene named its key itself
     * and is recorded as 'command', which is what protects it from the next
     * hydrate's baseline paint.
     *
     * `savedOrigin` is the second reading of the same question, and on a RELOAD
     * it is the only one available: the restore runs in the hydrate's `built`
     * phase and the baseline is installed later, in `placed`, so `resting` is
     * still undefined here and the comparison above cannot match anything. A
     * key this viewer painted as a lesson's — its baseline or one of its
     * chapters — is the lesson's to repaint whichever phase asks; nobody chose
     * it over the lesson. Both are recorded as 'resting' rather than 'lesson'
     * because a restored key is nobody's live chapter: no tour is running to
     * own the fade, and the next hydrate repaints the baseline over it.
     *
     * A capture that names no origin is a capture from a page that had no word
     * for one, and is read as 'command' exactly as it always was.
     *
     * @param {object|undefined} restored the key the capture names, if any
     * @param {string|undefined} savedOrigin the origin the capture names, if any
     * @returns {'resting'|'command'|undefined} undefined leaves the origin alone
     */
    noteRestoredKey(restored, savedOrigin) {
      if (!restored) return undefined;
      if (resting && sameEmphasisKey(restored, resting.emphasis)) {
        // The baseline is back, so the plates it asks for are back with it,
        // even if the chapter that just ended had turned them off.
        labels = resting.componentLabels;
        return 'resting';
      }
      if (savedOrigin === 'resting' || savedOrigin === 'lesson') return 'resting';
      return 'command';
    },
  };
}
