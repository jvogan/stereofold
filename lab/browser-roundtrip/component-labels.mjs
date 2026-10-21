/**
 * The per-part name plates, as ONE serialized rebuild.
 *
 * The plates are root-level Mol* cells named deterministically
 * (`stereofold-component-labels-N`), so two rebuilds that overlap address the
 * same cells and destroy each other. That is exactly what a session edge used
 * to cause, and it is the defect `0cf026b` tried to fix and did not:
 *
 * - the old rebuild emptied its ref list synchronously and then awaited the
 *   deletes, so the list was empty for the whole of an in-flight rebuild;
 * - the `isPresenting` subscriber gated on that list being non-empty, so a
 *   session edge landing mid-rebuild was declined and nothing re-fired, and
 *   the plates finished at the desktop size the wearer cannot read;
 * - the same edge separately ran `applyInspectionAppearance`, which rebuilds
 *   plates too, so run A's deletes removed run B's freshly built cells, the
 *   surviving ref list named dead cells, the plates vanished, and the frame
 *   wait that counts live plates timed out.
 *
 * So this owns the whole lifecycle instead. Callers ask for a rebuild; they
 * never learn whether one was already running. Every pass re-reads the world
 * AFTER its awaits — whether plates are wanted at all, and whether the wearer
 * is still in the session whose size the plates were built for — and runs
 * again when either answer moved under it. Requests that arrive while a pass
 * is running coalesce into exactly one follow-up pass rather than a queue of
 * redundant ones. A source swap is the one thing a pass cannot re-read its way
 * out of — the structure its plates were built against is gone by the time the
 * build resolves — so the swap bumps a generation and the pass discards and
 * removes anything it built for the previous one.
 *
 * Nothing here knows what a plate IS. `buildPlates` and `deletePlates` carry
 * every Mol* detail, which is what lets this be exercised without a WebGL
 * context or a headset.
 */

import { normalizeEmphasisState, planLessonEmphasis } from './lesson-emphasis.mjs';
import { MOLSTAR_BACKGROUND_MARGIN } from './label-layout.mjs';

/** A dimmed plate retains enough opacity for its ink and white backing. */
export const COMPONENT_LABEL_BACKING_ALPHA_FLOOR = 0.6;

/** One white-backed Mol* label per line, matching an authored figure plate.
 * A second glyph layer at a different eye depth creates two copies of the
 * same word. Let one primitive own both its ink and backing instead.
 */
export const COMPONENT_LABEL_GLASS = 0xffffff;
export const COMPONENT_LABEL_INK = 0x15212b;
export const COMPONENT_LABEL_GLASS_OPACITY = 0.9;
export const COMPONENT_LABEL_BORDER_WIDTH = 0;

/** The `backgroundMargin` a desktop plate is drawn with; a headset plate
 * takes `MOLSTAR_BACKGROUND_MARGIN`, which the layout sizes it by. */
export const DESKTOP_COMPONENT_LABEL_MARGIN = 0.25;

/**
 * A plate placed away from its part is a legend entry, and a legend needs its
 * key. Ten white plates in a column beside telomerase named ten chains, and a
 * wearer could not tell which plate named which. So a detached plate is drawn
 * over a second primitive in its part's own colour: the same name, the same
 * offsets and size, filling the plate's whole footprint, just behind it. The
 * white glass in front shrinks its margin by this share, and what is left of
 * the key shows as a coloured edge round the name.
 *
 * The footprint the layout reserved is the key's, so no plate grows into its
 * neighbour, the menu or the molecule. The key's own copy of the name is
 * painted white: text.frag pulls every glyph forward in depth, by more than
 * the key sits behind, so a coloured copy showed through the white as a
 * shadow of the name. A white one lands on white and the dark ink in front
 * still wins, so no second word shows at another depth. A plate beside its part draws exactly what it always
 * drew, one primitive. A key is built for a plate placed away from its part; a
 * plate that comes back hides its key at alpha zero, which Mol* never draws,
 * and a plate that leaves its part in a relayout gains one.
 */
export const COMPONENT_LABEL_KEY_SHARE = 0.7;
/** How far behind its plate the key sits, as a share of the plate's stand-off:
 * enough that no depth buffer calls the two glasses equal. A plate's offsets
 * are divided by the depth it is drawn at, so a deeper key also draws a
 * little nearer its anchor; at two percent a legend plate's edge was two
 * pixels thicker on one side than the other. */
export const COMPONENT_LABEL_KEY_LAG = 0.005;
/** The key's glyphs never show, so it takes the smallest Mol* atlas. */
export const COMPONENT_LABEL_KEY_FONT_QUALITY = 0;

/** XR plates are either readable or absent: Mol* fades ink and glass
 * together, so a partial primitive alpha creates a blank grey rectangle.
 * Desktop keeps its existing fade. Chapter emphasis chooses XR context.
 * With a part `color`, `key` is that plate's key layer, at alpha zero unless `detached`.
 */
export function componentLabelPaint({ placeAlpha = 1, contextAlpha = 1, offsetZ = 0, presenting = false,
  color, detached = false } = {}) {
  const { backingAlpha } = componentLabelAlpha({ placeAlpha, contextAlpha });
  const alpha = presenting ? (placeAlpha > 0 && contextAlpha >= 1 ? 1 : 0) : backingAlpha;
  const stand = Number.isFinite(offsetZ) ? offsetZ : 0;
  const margin = presenting ? MOLSTAR_BACKGROUND_MARGIN : DESKTOP_COMPONENT_LABEL_MARGIN;
  const keyed = detached === true && Number.isFinite(color);
  const coloured = Number.isFinite(color);
  const backing = {
    textColor: COMPONENT_LABEL_INK, alpha,
    background: true, backgroundColor: COMPONENT_LABEL_GLASS,
    backgroundOpacity: keyed ? 1 : COMPONENT_LABEL_GLASS_OPACITY,
    backgroundMargin: keyed ? margin * (1 - COMPONENT_LABEL_KEY_SHARE) : margin,
    borderWidth: COMPONENT_LABEL_BORDER_WIDTH, borderColor: COMPONENT_LABEL_GLASS,
    offsetZ: stand,
    tether: false,
  };
  if (!coloured) return { backing };
  return { backing, key: {
    textColor: COMPONENT_LABEL_GLASS, alpha: keyed ? alpha : 0,
    background: true, backgroundColor: color, backgroundOpacity: 1, backgroundMargin: margin,
    borderWidth: 0, borderColor: color,
    offsetZ: stand * (1 - COMPONENT_LABEL_KEY_LAG),
    tether: false, fontQuality: COMPONENT_LABEL_KEY_FONT_QUALITY,
  } };
}

/**
 * Mol* 5.11.0 gives each text representation its own GPU atlas: quality 3
 * is 43 MB, quality 1 is 10.8 MB and quality 0 is 2.7 MB. Headset glyphs use
 * quality 1; the zero-width leader needs no glyph detail. Desktop keeps the
 * default. These are atlas allocations, not a measurement of GPU residency.
 *
 * Text.updateValues changes offsets, size and opacity as uniforms. However,
 * our StructureSelectionsLabel3D transformer supplies fresh data on EVERY
 * update (mol-plugin-state/transforms/representation.js:1305-1310), calling
 * ShapeRepresentation.getShape (mol-repr/shape/representation.js:82-88) and
 * label.buildText (mol-repr/shape/loci/label.js:54-56). That rebuild bumps the
 * fontTexture version in Text.update, then render-item reloads it. The selective
 * geometry rules in structure/complex-visual.js:376-397 apply to a different
 * representation. Skipping a plate state update avoids this whole shape path.
 */
export const COMPONENT_LABEL_FONT_QUALITY = 1;
export const COMPONENT_LABEL_LEADER_FONT_QUALITY = 0;

/** Largest per-eye projection gain: pixels per tangent unit (per radian at
 * the optical axis). Sample the retained XR views once when sizing a layout,
 * never solve or measure glyphs in the frame loop. Missing projection means
 * exact comparison rather than guessing a headset resolution.
 */
export function componentLabelProjectionGain(views, viewportFor) {
  let gain = 0;
  for (const view of views ?? []) {
    const viewport = viewportFor?.(view), p = view.projectionMatrix;
    for (const value of [Math.abs(p?.[0]) * viewport?.width / 2,
      Math.abs(p?.[5]) * viewport?.height / 2]) {
      if (Number.isFinite(value) && value > gain) gain = value;
    }
  }
  return gain;
}

/** Half a projected pixel, in shader offset units at this plate's depth.
 * label-layout reports scene depth; camera.scale cancels between depth and
 * billboard offsets. Always compare to committed values so skipped jitter
 * never accumulates unnoticed.
 */
export function componentLabelStillUnits(depth, pixelsPerRadian) {
  return Number.isFinite(depth) && depth > 0 && Number.isFinite(pixelsPerRadian) && pixelsPerRadian > 0
    ? 0.5 * depth / pixelsPerRadian : 0;
}

/** Parameters compared with a tolerance; everything else must match exactly. */
const LAYER_TOLERANCE = Object.freeze({
  offsetX: 'pixel', offsetY: 'pixel', tetherLength: 'mapping',
  alpha: 0.005, backgroundOpacity: 0.005,
  sizeFactor: 'relative', offsetZ: 'relative',
});

/** Unknown committed params count as changed. `still` is a projected half
 * pixel in scene units, derived once per plate per relayout. */
export function componentLabelLayerChanged(committed, wanted, still = 0) {
  if (!committed || typeof committed !== 'object') return true;
  for (const [key, next] of Object.entries(wanted ?? {})) {
    const current = committed[key];
    const rule = LAYER_TOLERANCE[key];
    if (rule !== undefined && Number.isFinite(next) && Number.isFinite(current)) {
      const mappingSize = Math.max(Math.abs(wanted.sizeFactor ?? 0), Math.abs(committed.sizeFactor ?? 0));
      const tolerance = rule === 'pixel' ? still : rule === 'mapping' ? (mappingSize > 0 ? still / mappingSize : 0)
        : rule === 'relative' ? Math.abs(current) * 0.005 : rule;
      if (Math.abs(next - current) > tolerance) return true;
      continue;
    }
    if (next !== current) return true;
  }
  return false;
}

/** Stage only changed layers; the caller commits nothing when all were kept.
 * `geometry` describes the StructureSelectionsLabel3D path above, not GPU
 * upload completion. Even an opacity-only state commit rebuilds this shape.
 */
export function stageComponentLabelLayers({ committed, updates,
  now = () => { try { return performance.now(); } catch { return Date.now(); } } } = {}) {
  const began = now();
  let changed = 0, kept = 0;
  return {
    stage(cell, params, still = 0) {
      if (!componentLabelLayerChanged(committed(cell), params, still)) { kept += 1; return; }
      changed += 1;
      updates.to(cell).update(old => ({ ...old, ...params }));
    },
    /** A plate that leaves its part in a relayout gains its key, under the
     * plate's own cell, in the same commit. Always a change. */
    add(parent, transformer, params, ref) {
      changed += 1;
      updates.to(parent).apply(transformer, params, { ref });
    },
    changed: () => changed,
    detail(path, reason) {
      return { path, ...(typeof reason === 'string' && reason ? { reason } : {}),
        layers: changed + kept, changed, geometry: changed > 0, ms: Math.round(now() - began) };
    },
  };
}

/** The label Mol* is given for a leader: one character, with no ink in it. */
export const COMPONENT_LABEL_LEADER_TEXT = '​';
/** How wide the leader's wedge is where it meets the plate, in mapping units. */
export const COMPONENT_LABEL_LEADER_WIDTH = 0.18;

/** Copy ordinals a lesson writes out, and the digit a plate shows instead. */
const PLATE_ORDINALS = Object.freeze({ first: '1', second: '2', third: '3', fourth: '4',
  fifth: '5', sixth: '6', seventh: '7', eighth: '8', ninth: '9', tenth: '10' });
/** Nouns a lesson adds for the reader that a plate does not need to repeat. */
const PLATE_TRAILING_NOUNS = /\s+(domain|subunit|complex)$/iu;

/**
 * The name a plate SHOWS, from the name the lesson authored.
 *
 * "Dyskerin (DKC1), first copy" is twenty-seven characters. At the angular size
 * a plate has to be drawn at to be read across a room, that is a rectangle
 * wider than the structure it is naming, and ten of them cannot be arranged
 * around a subject they each overlap on their own. The wearer does not need
 * the gene symbol and the word "copy" to tell two dyskerins apart; they need
 * "Dyskerin 1".
 *
 * Only the plate is shortened. The authored label stays on the part, which is
 * what `lesson-emphasis.mjs` matches "show me dyskerin" and "GAR1" against and
 * what the diagnostics record, so every name and identifier a wearer might say
 * still resolves.
 *
 * @param {string} label the name the lesson authored
 * @returns {string} the name to draw on the plate
 */
export function componentPlateName(label) {
  const raw = String(label ?? '').trim().replace(/\s+/gu, ' ');
  if (!raw) return '';
  // The identifier in brackets is the same subunit said twice.
  let name = raw.replace(/\s*\([^()]*\)/gu, '').replace(/\s+/gu, ' ').trim();
  // "X, first copy" and "X copy 2" are both a name and which one of them it is.
  name = name.replace(/,?\s+(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+copy$/iu,
    (_match, word) => ` ${PLATE_ORDINALS[word.toLowerCase()]}`);
  name = name.replace(/,?\s+copy\s+(\d+)$/iu, ' $1');
  name = name.replace(PLATE_TRAILING_NOUNS, '');
  name = name.replace(/\s+/gu, ' ').replace(/^[,\s]+|[,\s]+$/gu, '');
  // Shortening a name to nothing would leave a wearer with an empty plate,
  // which is worse than the long name it came from.
  return name || raw;
}

/**
 * Keep the authored fade and the readable plate alpha separately. The single
 * backed primitive uses backingAlpha for both ink and glass; textAlpha remains
 * useful to callers reasoning about the original emphasis strength.
 */
export function componentLabelAlpha({ placeAlpha = 1, contextAlpha = 1 } = {}) {
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const place = finite(placeAlpha) ? Math.min(1, Math.max(0, placeAlpha)) : 1;
  const context = finite(contextAlpha) ? Math.min(1, Math.max(0, contextAlpha)) : 1;
  const textAlpha = Math.min(place, context);
  return { textAlpha, backingAlpha: Math.max(COMPONENT_LABEL_BACKING_ALPHA_FLOOR, textAlpha) };
}

/** All resolved names remain visible, with the same focus and context strength as the key. */
export function planComponentLabels(emphasis, resolveKeys) {
  const state = normalizeEmphasisState(emphasis);
  const plan = planLessonEmphasis({ ...state, focus: [] }, resolveKeys);
  // If the focus cannot resolve, the molecular key lights the whole tier too.
  const focused = new Set(plan.colours.filter(part => state.focus.includes(part.id)).map(part => part.id));
  // A part lit beside the focus is painted at full strength, so is its plate.
  const lit = new Set(state.alsoLit ?? []);
  return { ...plan, colours: plan.colours.map(part => ({ ...part,
    opacity: !focused.size || focused.has(part.id) || lit.has(part.id) ? 1 : state.contextOpacity,
  })) };
}

/**
 * @typedef {object} ComponentLabelSessionOptions
 * @property {() => boolean} isPresenting whether an immersive session is live
 * @property {() => boolean} wantsLabels whether the live plan asks for plates
 * @property {(context: {presenting: boolean, reason?: string, seatBasis?: object,
 *   strand: (refs: string[]) => void}) => Promise<string[]>} buildPlates
 *   builds a fresh set of plates and resolves with the refs it created. A build
 *   that fails and cannot delete what it committed passes those refs to `strand`
 * @property {(refs: string[]) => Promise<void>} deletePlates removes plates by ref
 * @property {(refs: string[], reason?:string) => Promise<boolean|void>} [updatePlates] updates a menu layout in place
 */

/**
 * One serialized owner of the component name plates.
 *
 * @param {ComponentLabelSessionOptions} options
 * @returns {{refs: () => string[], rebuild: (reason?: string, seatBasis?: object) => Promise<void>,
 *   remove: () => Promise<void>, adopt: () => string[], busy: () => boolean,
 *   active: () => boolean, passes: () => number}}
 */
export function createComponentLabelSession({ isPresenting, wantsLabels, buildPlates, deletePlates, updatePlates } = {}) {
  for (const [name, fn] of Object.entries({ isPresenting, wantsLabels, buildPlates, deletePlates })) {
    if (typeof fn !== 'function') {
      throw new TypeError(`A component-label session needs a ${name} function.`);
    }
  }
  /** The refs of the plates that are actually on the state tree right now. */
  let refs = [];
  /** The in-flight drain, or null. Every caller awaits this same promise. */
  let running = null;
  let transactionDepth = 0;
  /** The one coalesced follow-up, if anything was asked for mid-pass. */
  let queued = null;
  /** The dequeued job still owns the entry basis while its pass is running. */
  let activeJob = null;
  /** How many build passes have run, which is what the tests count. */
  let passes = 0;
  /**
   * Plates a failed build left on the state tree and could not delete. Their
   * refs are the ones the next build reuses, so every pass deletes them first,
   * inside this serialized queue, and no live plate can share a ref with one.
   */
  let stranded = [];
  /**
   * Which structure the plates belong to. Bumped by `adopt`.
   *
   * A source swap adopts synchronously and cannot await, so it takes the live
   * refs and deletes them itself. Mid-rebuild there are none to take — the list
   * is empty from the delete until the build resolves, by design — so the swap
   * took nothing, and the pass then finished a build whose plates hang off the
   * loci of a structure that is gone and claimed them as live. Nothing ever
   * deleted those: the refs are root-level cells no subtree delete reaches, and
   * the next rebuild's delete addressed them against the new state tree. The
   * counter is what lets a pass notice the ground moved under its own build.
   */
  let generation = 0;

  const presenting = () => Boolean(isPresenting());
  // A captured basis uses its source's scene units. Check again after awaits,
  // since adoption can invalidate an active job as well as a queued one.
  const basisFor = job => job?.generation === generation ? job.seatBasis : undefined;

  /**
   * One pass: take the live plates down, then build the wanted ones back.
   *
   * Every read that decides what gets built happens AFTER the delete's await,
   * because the wearer can enter or leave a session inside it and the size the
   * plates are built at comes from that flag.
   *
   * @param {{removeOnly: boolean, reason?: string, relayout?: boolean,
   *   seatBasis?: object, generation: number}} job the requested intent and entry basis
   * @returns {Promise<boolean>} whether the world moved under this pass
   */
  async function pass(job) {
    const { removeOnly, reason, relayout } = job;
    if (job.isCurrent?.() === false) return false;
    // Stranded-cell repair is mandatory once begun, like the fallback below.
    if (stranded.length && job.isCurrent) job = { ...job, isCurrent: undefined };
    // A delete that fails again rejects this pass and keeps the list.
    if (stranded.length) { await deletePlates([...stranded]); stranded = []; }
    if (job.isCurrent?.() === false) return false;
    if (relayout && !removeOnly && refs.length && wantsLabels() && typeof updatePlates === 'function') {
      // Keep every live cell through a menu solve. A placement must not open
      // a delete/build gap in which only part of the label set is rendered.
      const generationBefore = generation;
      const updated = await updatePlates([...refs], reason, { isCurrent: job.isCurrent });
      if (job.isCurrent?.() === false) return false;
      if (generation !== generationBefore) return true;
      if (updated === false) throw new Error('Plate update rejected; committed cells retained.');
      return false;
    }
    // A destructive fallback is mandatory label repair, not optional pose
    // work. Once started, it follows current source/session intent even if the
    // initiating release is superseded; cancellation must not leave a gap.
    if (job.isCurrent) job = { ...job, isCurrent: undefined };
    const previous = refs;
    // Cleared before the await so nothing can read a ref whose cell is going
    // away. Callers ask this object whether plates are live (`active`), never
    // the ref list, precisely because the list is empty for this stretch.
    refs = [];
    if (previous.length) await deletePlates(previous);
    if (job.isCurrent?.() === false || removeOnly || !wantsLabels()) return false;
    const builtPresenting = presenting();
    // Read immediately before the build, not at the top of the pass: a swap
    // that landed during the delete above is already reflected in what
    // `buildPlates` will read, so those plates are the new structure's and
    // keeping them is right. Only a swap INSIDE the build invalidates it.
    const builtFor = generation;
    const created = await buildPlates({ presenting: builtPresenting, reason, seatBasis: basisFor(job),
      isCurrent: job.isCurrent, strand: left => { stranded = [...new Set([...stranded, ...left])]; } });
    const built = Array.isArray(created) ? [...created] : [];
    if (generation !== builtFor || job.isCurrent?.() === false) {
      // These name loci on a structure that is no longer loaded. Take them
      // down here rather than claim them: the swap has already given up its
      // chance to sweep them, and every later rebuild would address them
      // against a state tree they do not belong to.
      if (built.length) await deletePlates(built);
      // The world moved under this pass in the largest way it can, so the
      // caller gets the same follow-up a session edge gets. It costs nothing
      // when the swap left no plates wanted.
      return job.isCurrent?.() !== false;
    }
    refs = built;
    passes += 1;
    // A session edge that landed inside the build left these plates carrying
    // the wrong size. Nothing else will re-fire, so say so and run again.
    return refs.length > 0 && presenting() !== builtPresenting;
  }

  async function drain() {
    let failure;
    try {
      while (queued && !transactionDepth) {
        // A pending relayout has not sampled geometry yet. Let requests in
        // this turn merge their reasons and latest world state into that job.
        if (queued.relayout) await Promise.resolve();
        if (transactionDepth) break;
        const job = queued;
        queued = null;
        activeJob = job;
        try {
          const moved = await pass(job);
          if (moved && !queued) queued = { removeOnly: false, seatBasis: basisFor(job), generation };
        } catch (error) {
          // A rejected menu commit must not strand a queued molecular change.
          // Drain the pending intent before rejecting the shared promise.
          failure ??= { error };
        }
        finally { activeJob = null; }
      }
      if (failure) throw failure.error;
    }
    finally { running = null; }
  }

  function request(removeOnly, reason, relayout = false, seatBasis, isCurrent) {
    // The newest request is the current statement of intent: a remove asked
    // for after a rebuild means the caller no longer wants the plates.
    // A queued full rebuild owns molecular changes; a menu solve cannot downgrade it.
    // A queued molecular change may need a full build and inherits the active
    // pass's basis too. A newer captured basis always takes precedence.
    const reasons = [...new Set([queued?.reason, reason].filter(Boolean).flatMap(value => value.split('+')))];
    reasons.sort((a, b) => a === 'emphasis' ? -1 : b === 'emphasis' ? 1 : 0);
    const guard = queued ? (queued.isCurrent && isCurrent ? isCurrent : undefined) : isCurrent;
    queued = { isCurrent: guard, removeOnly, reason: reasons.join('+') || undefined,
      relayout: relayout && (!queued || queued.relayout === true),
      seatBasis: removeOnly ? undefined : seatBasis ?? basisFor(queued) ?? basisFor(activeJob), generation };
    if (transactionDepth) return Promise.resolve();
    if (!running) running = drain();
    return running;
  }

  return {
    /** Hold requests until appearance and placement have both committed. Requests
     * during the transaction merge in the pending job, before it can solve. */
    batching: () => transactionDepth > 0,
    async transaction(operation) {
      transactionDepth++;
      try { return await operation(); }
      finally {
        transactionDepth--;
        if (!transactionDepth && queued) {
          if (running) await running;
          if (queued) { running = drain(); await running; }
        }
      }
    },
    /** The live plate refs. Empty while a rebuild is between delete and build. */
    refs: (out = []) => { out.length = 0; for (const ref of refs) out.push(ref); return out; },
    /** Build the wanted plates, serialized behind any rebuild already running. */
    rebuild: (reason, seatBasis) => request(false, reason, false, seatBasis),
    /** Re-solve the existing plates after a menu move, on the same serial queue. */
    relayout: (reason, { isCurrent } = {}) => request(false, reason, true, undefined, isCurrent),
    /** Take every plate down and build nothing back. */
    remove: () => request(true),
    /**
     * Hand the live refs to a caller that will delete them itself.
     *
     * The source swap adopts a new record synchronously and cannot await; the
     * plates it is orphaning hang off the OLD structure's loci at the state
     * root, where no subtree delete will reach them.
     *
     * Mid-rebuild there is nothing to hand over, which is why this also bumps
     * the generation: a build already in flight is building on the structure
     * this call is replacing, and its plates must be discarded and removed by
     * the pass that made them rather than assigned as live.
     * The same generation invalidates captured bases on queued and active jobs.
     */
    adopt() { const previous = refs; refs = []; generation += 1; return previous; },
    /** Whether a rebuild is in flight. */
    busy: () => running !== null,
    /**
     * Whether plates are drawn or on their way. This is the question a session
     * edge must ask; the ref count alone answers it wrongly mid-rebuild.
     * Stranded plates count: they are still drawn, and a rebuild deletes them.
     */
    active: () => refs.length > 0 || running !== null || stranded.length > 0,
    /** How many build passes have run. Diagnostics and tests only. */
    passes: () => passes,
  };
}
