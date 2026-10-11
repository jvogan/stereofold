/**
 * Measure immersive frame time on every headset, and adapt resolution only
 * when the wearer or operator opts in.
 *
 * `xr-render-budget.mjs` prices a frame once, on entry, from a device table,
 * and only a Quest 2 has numbers in that table. A Quest 3, a Quest Pro, a
 * Vision Pro or a headset nobody has named gets a native-scale layer and no
 * protection when a giant spacefill scene misses frames. A table cannot fix
 * that without measurements nobody has made, so this module measures by
 * default: it watches the XR frame clock and records when frames are missed.
 * With `governor:on`, it lowers resolution only while misses persist, then
 * gives it back once frames are on time again.
 *
 * SIGNAL. The `time` each XR animation frame receives is the runtime's
 * display clock, so the gap between two frames is a whole number of display
 * intervals: one when the frame made its slot, two or more when it did not.
 * The interval comes from `session.frameRate` where the runtime reports one,
 * and otherwise from the fastest tenth of the measured gaps (capped at 90 Hz
 * on Safari, whose rate is not reported but is known). A gap longer than
 * `stallMs` is a geometry rebuild, a garbage collection or a system overlay,
 * not fill rate, and is dropped together with the window it fell in. Frames
 * are not counted while a scene transition runs, while the session is not
 * visible, for `warmupMs` after entry, or for `settleMs` after each change.
 *
 * Callback CPU time from `watchFrameCost` is deliberately not an input. A
 * GPU-bound frame blocks inside GL calls once the driver queue is full, so a
 * long callback is not evidence of CPU work, and gating on it would stop the
 * governor exactly where it helps. Instead every step down is tested: if the
 * misses do not fall by `minImprovement` within `checkWindows`, the step is
 * undone and further steps wait out a doubling block. Resolution therefore
 * never drops on a frame that resolution cannot fix.
 *
 * KNOBS, cheapest first. Nothing here rebuilds geometry, re-creates the
 * XRWebGLLayer or changes what is drawn; every step is a pixel-count change
 * the wearer sees as softness, applied in the next frame and undone the same
 * way.
 *
 *   1. Dynamic viewport scaling (`XRView.requestViewportScale`). The layer
 *      keeps its size and each eye renders into a smaller rectangle of it,
 *      so fragments fall with the square of the scale. Feature-detected per
 *      view; a runtime that accepts the request but returns an unchanged
 *      viewport is detected and the knob is dropped for the session.
 *   2. Fixed foveation, raised to 1, where the layer exposes it and the
 *      device class does not already run at 1 (a Quest 2 does). It comes after
 *      the first, mildest viewport step and before the larger ones.
 *
 * The rungs never go below `floor` in effective linear scale (layer scale
 * times viewport scale), so a Quest 2 heavy scene, already at 0.5, has one
 * step and a light scene at 0.8 has four. A Quest 2 therefore starts from its
 * measured static settings and can only go lower or back up to them.
 * Heavier steps such as sphere detail or representation quality rebuild
 * geometry and stall a Quest for seconds, which is the hitch this module
 * exists to prevent; they are not here. A governor at its floor that still
 * misses frames records `floor` once so a device run can see it.
 *
 * HYSTERESIS. A one-second window is bad at `badRatio` missed display slots
 * and good at `goodRatio` or fewer; between the two nothing moves. Three bad
 * windows in a row step down; five good windows in a row step up. A step up
 * is a probe: one bad window inside `probeMs` sends it straight back, and the
 * next probe of that rung waits twice as long, up to five minutes. A probe
 * that survives clears the rung's record, and so does a scene change, because
 * the scene that defeated it is gone. That bounds oscillation on a scene that
 * sits on a rung boundary to a probe every few minutes.
 *
 * SWITCH. `?xrRenderBudget=governor:on|observe|off` and
 * `STEREOFOLD_XR_RENDER_BUDGET`. `observe` runs the same measurement and
 * records `would-step` without touching the session, so both halves of an
 * A/B carry the same numbers. Every device class defaults to `observe` because
 * dynamic resolution behavior and its quality trade-off have not been
 * qualified across devices. Use `governor:on` explicitly for a device run.
 * `governorFloor:<0..1>` moves the floor for a device run.
 *
 * Every start, step and floor, and a summary every thirty seconds and at exit,
 * goes to the headset diagnostics ring as a `frame-governor` entry, so
 * `read_headset_log` shows what the governor saw and did.
 */

import { foveationLevelFor, isAppleSafariXr } from './xr-session-request.mjs';
import { lastLayerScale, renderBudgetOverrides, sceneTransitionActive, sessionDeviceClass } from './xr-render-budget.mjs';

/** Thresholds and windows, in milliseconds of XR frame time. */
export const FRAME_GOVERNOR_DEFAULTS = Object.freeze({
  windowMs: 1_000,
  minWindowFrames: 10,
  warmupMs: 2_000,
  settleMs: 500,
  stallMs: 250,
  // A gap this many display intervals long missed at least one slot.
  lateFactor: 1.5,
  badRatio: 0.1,
  goodRatio: 0.02,
  downWindows: 3,
  upWindows: 5,
  maxHoldWindows: 300,
  probeMs: 10_000,
  checkWindows: 2,
  minImprovement: 0.2,
  blockMs: 30_000,
  maxBlockMs: 300_000,
  summaryMs: 30_000,
});

/** Viewport scales the ladder may use, mildest first. */
export const GOVERNOR_VIEWPORT_SCALES = Object.freeze([1, 0.85, 0.7, 0.6, 0.5]);

/** The lowest effective linear scale, layer scale times viewport scale. */
export const GOVERNOR_FLOOR = 0.4;

/** Safari reports no frame rate; Vision Pro presents at 90 Hz or faster. */
export const SAFARI_NOMINAL_MS = 1_000 / 90;

/** The diagnostics kind every governor entry is recorded under. */
export const FRAME_GOVERNOR_DIAGNOSTIC = 'frame-governor';

const MIN_NOMINAL_MS = 1_000 / 240;
const FOVEATION_EPSILON = 1e-3;
const GAP_CAPACITY = 1_024;

/**
 * Which way the governor runs for a device class and a parsed knob list.
 *
 * @param {string} device class from `deviceClass`
 * @param {{enabled?:boolean, governor?:boolean|'observe'}} [overrides] from `parseRenderBudgetOverrides`
 * @returns {'on'|'observe'|'off'}
 */
export function frameGovernorMode(device, overrides = {}) {
  if (overrides?.enabled === false) return 'off';
  if (overrides?.governor === true) return 'on';
  if (overrides?.governor === false) return 'off';
  if (overrides?.governor === 'observe') return 'observe';
  return 'observe';
}

/**
 * The rungs one session may step through, best first. Rung 0 is the session's
 * starting settings: viewport scale 1 and the foveation level it already has.
 *
 * @param {{layerScale?:number, viewportScaling?:boolean, foveation?:number|null, floor?:number}} [input]
 *   `foveation` is the base level, or `null` when the layer has no
 *   `fixedFoveation` to raise
 * @returns {ReadonlyArray<{viewportScale:number, foveation:number|null}>}
 */
export function governorLadder({ layerScale = 1, viewportScaling = false, foveation = null, floor = GOVERNOR_FLOOR } = {}) {
  const layer = Number.isFinite(layerScale) && layerScale > 0 ? Math.min(1, layerScale) : 1;
  const lowest = Number.isFinite(floor) && floor > 0 ? floor : GOVERNOR_FLOOR;
  const base = Number.isFinite(foveation) ? Math.min(1, Math.max(0, foveation)) : null;
  const scales = viewportScaling
    ? GOVERNOR_VIEWPORT_SCALES.filter(scale => scale === 1 || layer * scale >= lowest - 1e-9) : [1];
  // Foveation goes after the first viewport step: 0.85 costs the whole field a
  // little, full foveation costs the periphery a lot, and only then do the
  // larger viewport steps follow.
  const foveateAfter = scales.length > 1 ? 1 : 0;
  const rungs = [];
  let level = base;
  scales.forEach((viewportScale, index) => {
    rungs.push(Object.freeze({ viewportScale, foveation: level }));
    if (index === foveateAfter && base !== null && base < 1 - FOVEATION_EPSILON) {
      level = 1;
      rungs.push(Object.freeze({ viewportScale, foveation: level }));
    }
  });
  return Object.freeze(rungs);
}

/**
 * The decision half of the governor: XR frame times in, rung changes out.
 *
 * Pure apart from its own state, so it runs under Node against synthetic
 * frame sequences. `frame` returns `null` almost always, and a frozen decision
 * on the frame that closes a window and moves the rung. The caller applies the
 * rung; this never touches a session.
 *
 * @param {{rungs?:Array<{viewportScale:number, foveation:number|null}>, dryRun?:boolean,
 *   maxNominalMs?:number} & Partial<typeof FRAME_GOVERNOR_DEFAULTS>} [options]
 */
export function createFrameGovernor({ rungs = [{ viewportScale: 1, foveation: null }], dryRun = false, maxNominalMs, ...tuning } = {}) {
  const o = { ...FRAME_GOVERNOR_DEFAULTS };
  for (const [key, value] of Object.entries(tuning)) if (key in o && Number.isFinite(value)) o[key] = value;
  let ladder = Object.freeze([...rungs]);
  let level = 0;
  let firstTime, lastTime, windowStart, settledAt = -Infinity;
  const gaps = new Float64Array(GAP_CAPACITY);
  let count = 0;
  let estimate = null, lastNominal = null;
  let badStreak = 0, goodStreak = 0, streakRatios = [];
  let check = null, probe = null, blockedUntil = -Infinity, blockMs = o.blockMs, floorReported = false;
  const failures = new Map();
  let secondsAt = ladder.map(() => 0);
  const totals = { windows: 0, bad: 0, neutral: 0, good: 0, presented: 0, missed: 0, stalls: 0,
    steps: 0, wouldSteps: 0, ineffective: 0, probeFailures: 0 };

  const seconds = time => Math.round((time - (firstTime ?? time)) / 100) / 10;
  const mean = values => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  const resetWindow = () => { windowStart = undefined; count = 0; };
  const resetStreaks = () => { badStreak = 0; goodStreak = 0; streakRatios = []; };
  const holdWindows = target => Math.min(o.maxHoldWindows, o.upWindows * 2 ** (failures.get(target) ?? 0));

  function nominalFor(provided, presented) {
    if (Number.isFinite(provided) && provided > 0) return (lastNominal = provided);
    const sorted = Array.from(gaps.subarray(0, presented)).sort((a, b) => a - b);
    // The fastest tenth is the display interval unless nine frames in ten
    // missed; the minimum over windows keeps a fully missed one from
    // redefining the display, and the Safari cap covers a session that missed
    // from its very first window.
    estimate = Math.max(MIN_NOMINAL_MS, Math.min(estimate ?? Infinity, sorted[Math.floor(presented * 0.1)]));
    return (lastNominal = Number.isFinite(maxNominalMs) && maxNominalMs > 0 ? Math.min(estimate, maxNominalMs) : estimate);
  }

  function change(time, to, reason, extra) {
    const from = level;
    level = Math.max(0, Math.min(ladder.length - 1, to));
    resetStreaks();
    resetWindow();
    settledAt = time + o.settleMs;
    totals.steps++;
    floorReported = false;
    return Object.freeze({ action: level > from ? 'down' : 'up', reason, from, to: level, rung: ladder[level],
      ...extra, at: seconds(time) });
  }

  function decide(time, ratio, nominal) {
    const verdict = ratio >= o.badRatio ? 'bad' : ratio <= o.goodRatio ? 'good' : 'neutral';
    totals[verdict]++;
    const stats = { missRatio: round3(ratio), nominalMs: round2(nominal) };
    // A probe that lasted its whole window proved the rung.
    if (probe && time >= probe.until) { failures.delete(probe.level); probe = null; }
    if (check) {
      check.ratios.push(ratio);
      if (check.ratios.length >= o.checkWindows) {
        const after = mean(check.ratios), { before, from } = check;
        check = null;
        if (after >= o.badRatio && after > (1 - o.minImprovement) * before) {
          // Lower resolution bought nothing: this frame is not fill-bound.
          totals.ineffective++;
          blockedUntil = time + blockMs;
          blockMs = Math.min(blockMs * 2, o.maxBlockMs);
          return change(time, from, 'ineffective', { missRatio: round3(after), beforeRatio: round3(before),
            nominalMs: round2(nominal), blockedForMs: blockedUntil - time });
        }
      }
    }
    if (verdict === 'bad') { badStreak++; goodStreak = 0; streakRatios.push(ratio); }
    else if (verdict === 'good') { goodStreak++; badStreak = 0; streakRatios = []; }
    else goodStreak = 0;
    const probeFailed = probe !== null && verdict === 'bad';
    if (probeFailed && level < ladder.length - 1) {
      // The rung this probe left was holding; go straight back to it.
      failures.set(probe.level, (failures.get(probe.level) ?? 0) + 1);
      totals.probeFailures++;
      probe = null;
      return change(time, level + 1, 'probe-failed', { ...stats, nextHoldWindows: holdWindows(level) });
    }
    if (badStreak >= o.downWindows && time >= blockedUntil) {
      const before = mean(streakRatios);
      if (dryRun) {
        totals.wouldSteps++;
        resetStreaks();
        // One report per block, so an observed giant scene does not fill
        // the diagnostics ring with the same sentence.
        blockedUntil = time + o.blockMs;
        return Object.freeze({ action: 'down', dryRun: true, reason: 'sustained-misses', from: level,
          to: Math.min(level + 1, ladder.length - 1), rung: ladder[Math.min(level + 1, ladder.length - 1)],
          missRatio: round3(before), nominalMs: stats.nominalMs, at: seconds(time) });
      }
      if (level < ladder.length - 1) {
        const from = level;
        const decision = change(time, level + 1, 'sustained-misses', { missRatio: round3(before), nominalMs: stats.nominalMs });
        check = { from, before, ratios: [] };
        return decision;
      }
      if (!floorReported) {
        floorReported = true;
        badStreak = 0;
        return Object.freeze({ action: 'hold', reason: 'floor', from: level, to: level, rung: ladder[level],
          missRatio: round3(before), nominalMs: stats.nominalMs, at: seconds(time) });
      }
    }
    if (verdict === 'good' && level > 0 && goodStreak >= holdWindows(level - 1)) {
      const decision = change(time, level - 1, 'recovered', stats);
      probe = { level, until: time + o.probeMs };
      return decision;
    }
    return null;
  }

  function closeWindow(time, provided) {
    const presented = Math.min(count, GAP_CAPACITY);
    windowStart = time;
    count = 0;
    if (presented < o.minWindowFrames) return null;
    const nominal = nominalFor(provided, presented);
    let missed = 0;
    for (let index = 0; index < presented; index++) {
      const slots = gaps[index] / nominal;
      if (slots > o.lateFactor) missed += Math.round(slots) - 1;
    }
    totals.windows++;
    totals.presented += presented;
    totals.missed += missed;
    return decide(time, missed / (presented + missed), nominal);
  }

  return {
    /**
     * One XR frame. `nominalMs` is the reported display interval, if any;
     * `paused` drops the frame and breaks the gap chain.
     */
    frame(time, { nominalMs, paused = false } = {}) {
      if (!Number.isFinite(time)) return null;
      if (paused) { lastTime = undefined; resetWindow(); return null; }
      firstTime ??= time;
      const previous = lastTime;
      lastTime = time;
      if (previous === undefined || !(time > previous)) return null;
      const gap = time - previous;
      if (gap > o.stallMs) { totals.stalls++; resetWindow(); return null; }
      secondsAt[level] += gap / 1_000;
      if (time - firstTime < o.warmupMs || time < settledAt) return null;
      if (windowStart === undefined) { windowStart = previous; count = 0; }
      if (count < GAP_CAPACITY) gaps[count] = gap;
      count++;
      return time - windowStart >= o.windowMs ? closeWindow(time, nominalMs) : null;
    },
    /** The scene changed: evidence about the old one no longer applies. */
    sceneChanged() {
      failures.clear();
      probe = null;
      check = null;
      blockedUntil = -Infinity;
      blockMs = o.blockMs;
      resetStreaks();
    },
    /** Replace the ladder, keep counting, and optionally settle from `time`. */
    setRungs(next, at = 0, time) {
      ladder = Object.freeze([...next]);
      level = Math.max(0, Math.min(ladder.length - 1, at));
      secondsAt = ladder.map(() => 0);
      failures.clear();
      probe = null;
      check = null;
      floorReported = false;
      resetStreaks();
      if (Number.isFinite(time)) { settledAt = time + o.settleMs; resetWindow(); }
    },
    state() {
      return { level, rung: ladder[level], rungs: ladder.length, nominalMs: round2(lastNominal),
        estimatedNominalMs: round2(estimate), ...totals,
        missRatio: totals.presented > 0 ? round3(totals.missed / (totals.presented + totals.missed)) : null,
        secondsAtRung: secondsAt.map(value => Math.round(value * 10) / 10) };
    },
  };
}

/**
 * Run the governor on one presenting session.
 *
 * The caller hands it every XR frame through `frame(time)` before the frame
 * draws, which in `immersive-session.mjs` is the head observer's input hook:
 * it already runs once per unique XR timestamp and only while the session is
 * visible, so the governor needs no animation-frame subscription of its own.
 *
 * The viewport knob is a wrapper on the base layer's own `getViewport`. Mol*
 * asks the layer for each eye's viewport inside its frame update
 * (`mol-canvas3d/camera/stereo.js:148`) and the WebXR viewport of a view is
 * fixed by the first `getViewport` call of a frame, so requesting the scale
 * there reaches Mol* and every later reader in the same frame. The wrapper is
 * an own property on the layer, removed in `stop()`, and re-installed if the
 * session's layer is ever replaced.
 *
 * Never throws.
 *
 * @param {{session:object, scope?:object, navigator?:object, record?:Function,
 *   transitionActive?:()=>boolean, tuning?:object}} options
 * @returns {{mode:string, frame:(time:number)=>void, stop:()=>void, state:()=>object}}
 */
export function installFrameGovernor({ session, scope = globalThis, navigator: navigatorLike, record,
  transitionActive, tuning = {} } = {}) {
  const emit = typeof record === 'function' ? record : diagnosticsRecorder(scope);
  const publish = detail => { try { emit?.(FRAME_GOVERNOR_DIAGNOSTIC, detail); } catch { /* Advisory only. */ } };
  let navigatorRead;
  try { navigatorRead = navigatorLike ?? scope?.navigator; } catch { navigatorRead = undefined; }
  const device = sessionDeviceClass(session, navigatorRead);
  let overrides;
  try { overrides = renderBudgetOverrides(scope, { deviceClass: device }); } catch { overrides = { enabled: true }; }
  const mode = frameGovernorMode(device, overrides);
  if (mode === 'off' || !session) {
    publish({ event: 'start', mode: 'off', device });
    return { mode: 'off', frame() {}, stop() {}, state: () => ({ mode: 'off', device }) };
  }
  const floor = Number.isFinite(overrides?.governorFloor) ? overrides.governorFloor : GOVERNOR_FLOOR;
  const safari = isAppleSafariXr(navigatorRead);
  const inTransition = typeof transitionActive === 'function' ? transitionActive : () => sceneTransitionActive(session);
  const core = createFrameGovernor({ dryRun: mode === 'observe', maxNominalMs: safari ? SAFARI_NOMINAL_MS : undefined,
    ...tuning });
  const timing = { ...FRAME_GOVERNOR_DEFAULTS };
  for (const [key, value] of Object.entries(tuning)) if (key in timing && Number.isFinite(value)) timing[key] = value;

  let stopped = false, failed = false, firstTime, lastSummary, transitioning = false;
  let ladder = null, layerScale = 1, viewportScaling = false, baseFoveation = null, baseReadBack = null;
  let layer = null, originalGetViewport = null, governedGetViewport = null, ownGetViewport = false;
  // Viewport state the wrapper reads and writes on every call.
  let requestedScale = 1, scaleTouched = false, viewSupportsScale = null;
  let viewportCalls = 0, lastWidth = 0, fullWidth = 0, recommendedMin = null, recommendedMax = null;
  let scaleCheck = null;
  let foveationWritten = null, foveationReadBack = null;

  function readLayer() {
    try { return session.renderState?.baseLayer ?? null; } catch { return null; }
  }

  function unwrap() {
    if (!layer || !governedGetViewport) return;
    try {
      // A platform layer's method lives on its prototype, so deleting the own
      // wrapper restores it; anything else gets the method it had put back.
      if (layer.getViewport === governedGetViewport) {
        if (ownGetViewport) layer.getViewport = originalGetViewport;
        else delete layer.getViewport;
      }
    } catch { /* A layer that refuses the delete is being discarded with its session. */ }
    governedGetViewport = null;
    originalGetViewport = null;
  }

  function wrap(target) {
    const original = target?.getViewport;
    if (typeof original !== 'function') return;
    const governed = function (view) {
      viewportCalls++;
      if (viewSupportsScale === null) viewSupportsScale = typeof view?.requestViewportScale === 'function';
      if (scaleTouched) { try { view?.requestViewportScale?.(requestedScale); } catch { /* The runtime keeps its scale. */ } }
      let recommended;
      try { recommended = view?.recommendedViewportScale; } catch { recommended = undefined; }
      if (Number.isFinite(recommended)) {
        recommendedMin = recommendedMin === null ? recommended : Math.min(recommendedMin, recommended);
        recommendedMax = recommendedMax === null ? recommended : Math.max(recommendedMax, recommended);
      }
      const viewport = original.call(this, view);
      const width = viewport?.width;
      if (Number.isFinite(width) && width > 0) {
        lastWidth = width;
        if (requestedScale === 1) fullWidth = Math.max(fullWidth, width);
      }
      return viewport;
    };
    const own = Object.prototype.hasOwnProperty.call(target, 'getViewport');
    try { target.getViewport = governed; } catch { return; }
    if (target.getViewport !== governed) return;
    ownGetViewport = own;
    originalGetViewport = original;
    governedGetViewport = governed;
  }

  function readFoveation() {
    try { return Number.isFinite(layer?.fixedFoveation) ? layer.fixedFoveation : null; } catch { return null; }
  }

  function writeFoveation(value) {
    if (!layer || !Number.isFinite(value)) return;
    try { layer.fixedFoveation = value; } catch { /* Reported through the read-back below. */ }
    foveationWritten = value;
    foveationReadBack = readFoveation();
  }

  function syncLayer() {
    const current = readLayer();
    if (current === layer) {
      // trackFoveation writes its class level when a layer appears; restate
      // this rung's level if anything wrote over it since.
      if (foveationWritten !== null && layer && readFoveation() !== foveationReadBack) writeFoveation(foveationWritten);
      return;
    }
    unwrap();
    layer = current;
    lastWidth = 0;
    fullWidth = 0;
    if (!layer || mode !== 'on') return;
    wrap(layer);
    if (foveationWritten !== null) writeFoveation(foveationWritten);
  }

  function scalingAvailable() {
    if (viewSupportsScale !== null) return viewSupportsScale;
    try { return typeof scope?.XRView?.prototype?.requestViewportScale === 'function'; } catch { return false; }
  }

  function describeLadder(rungs) {
    return rungs.map(rung => ({ viewportScale: rung.viewportScale, foveation: rung.foveation }));
  }

  function buildLadder(time) {
    const scale = lastLayerScale();
    layerScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
    viewportScaling = scalingAvailable();
    let hasFoveation = false;
    try { hasFoveation = Boolean(layer) && 'fixedFoveation' in layer; } catch { hasFoveation = false; }
    baseReadBack = hasFoveation ? readFoveation() : null;
    baseFoveation = hasFoveation ? (foveationLevelFor(device) ?? baseReadBack) : null;
    ladder = governorLadder({ layerScale, viewportScaling, foveation: baseFoveation, floor });
    core.setRungs(ladder, 0);
    publish({ event: 'start', mode, device, layerScale, floor, viewportScaling, foveation: baseFoveation,
      foveationReadBack: baseReadBack, reportedFrameRate: reportedFrameRate(), nominalSource: nominalSource(),
      rungs: describeLadder(ladder), at: 0, settledAfterMs: Math.round(time - firstTime) });
  }

  function reportedFrameRate() {
    try { return Number.isFinite(session.frameRate) && session.frameRate > 0 ? session.frameRate : null; }
    catch { return null; }
  }

  function nominalSource() {
    return reportedFrameRate() !== null ? 'session-frame-rate' : safari ? 'measured-capped-90hz' : 'measured';
  }

  function applyRung(rung, time) {
    if (mode !== 'on' || !rung) return;
    if (rung.viewportScale !== requestedScale) {
      requestedScale = rung.viewportScale;
      scaleTouched = true;
      scaleCheck = requestedScale < 1 ? { scale: requestedScale, calls: viewportCalls, at: time } : null;
    }
    if (rung.foveation !== null && (foveationWritten !== null || rung.foveation !== baseFoveation)) {
      writeFoveation(rung.foveation);
      if (rung.foveation !== baseFoveation && baseReadBack !== null && foveationReadBack !== null
        && Math.abs(foveationReadBack - baseReadBack) < FOVEATION_EPSILON) dropKnob('foveation', time);
    }
  }

  /** A knob the runtime accepted but did not act on: rebuild without it. */
  function dropKnob(knob, time) {
    const was = core.state().rung;
    if (knob === 'viewport') { viewportScaling = false; requestedScale = 1; scaleCheck = null; }
    if (knob === 'foveation') { baseFoveation = null; writeFoveation(baseReadBack); foveationWritten = null; }
    ladder = governorLadder({ layerScale, viewportScaling, foveation: baseFoveation, floor });
    const to = Math.max(0, ladder.findIndex(rung => knob === 'viewport'
      ? rung.foveation === was?.foveation : rung.viewportScale === was?.viewportScale));
    core.setRungs(ladder, to, time);
    publish({ event: 'step', action: 'up', reason: `${knob}-inert`, from: null, to, viewportScale: ladder[to]?.viewportScale,
      foveation: ladder[to]?.foveation, viewportWidth: lastWidth || null, fullViewportWidth: fullWidth || null,
      foveationReadBack, rungs: describeLadder(ladder), at: seconds(time) });
    applyRung(ladder[to], time);
  }

  function checkViewport(time) {
    if (!scaleCheck || viewportCalls < scaleCheck.calls + 4
      || time < scaleCheck.at + timing.settleMs) return;
    const { scale } = scaleCheck;
    scaleCheck = null;
    if (!(fullWidth > 0) || !(lastWidth > 0)) return;
    if (lastWidth > fullWidth * (scale + 0.05)) dropKnob('viewport', time);
  }

  function seconds(time) {
    return Number.isFinite(firstTime) ? Math.round((time - firstTime) / 100) / 10 : 0;
  }

  function summary(time, final = false) {
    const state = core.state();
    publish({ event: 'summary', mode, final, device: sessionDeviceClass(session, navigatorRead), level: state.level,
      viewportScale: state.rung?.viewportScale ?? 1, foveation: state.rung?.foveation ?? null,
      windows: state.windows, bad: state.bad, neutral: state.neutral, good: state.good,
      presented: state.presented, missed: state.missed, missRatio: state.missRatio, stalls: state.stalls,
      steps: state.steps, wouldSteps: state.wouldSteps, ineffective: state.ineffective,
      probeFailures: state.probeFailures, secondsAtRung: state.secondsAtRung, nominalMs: state.nominalMs,
      viewportWidth: lastWidth || null, fullViewportWidth: fullWidth || null,
      recommendedViewportScale: recommendedMin === null ? null : { min: recommendedMin, max: recommendedMax },
      at: Number.isFinite(time) ? seconds(time) : null });
  }

  return {
    mode,
    frame(time) {
      if (stopped || failed || !Number.isFinite(time)) return;
      try {
        firstTime ??= time;
        lastSummary ??= time;
        syncLayer();
        const nowTransitioning = Boolean(inTransition());
        if (transitioning && !nowTransitioning) core.sceneChanged();
        transitioning = nowTransitioning;
        if (ladder === null && layer && time - firstTime >= timing.warmupMs / 2) buildLadder(time);
        checkViewport(time);
        let visibility;
        try { visibility = session.visibilityState; } catch { visibility = undefined; }
        const rate = reportedFrameRate();
        const decision = core.frame(time, { nominalMs: rate === null ? undefined : 1_000 / rate,
          paused: transitioning || (typeof visibility === 'string' && visibility !== 'visible') });
        if (decision) {
          if (decision.dryRun) {
            publish({ event: 'would-step', reason: decision.reason, from: decision.from, to: decision.to,
              viewportScale: decision.rung?.viewportScale, foveation: decision.rung?.foveation,
              missRatio: decision.missRatio, nominalMs: decision.nominalMs, at: decision.at });
          } else {
            applyRung(decision.rung, time);
            publish({ event: decision.reason === 'floor' ? 'floor' : 'step', action: decision.action, reason: decision.reason,
              from: decision.from, to: decision.to, viewportScale: decision.rung?.viewportScale,
              foveation: decision.rung?.foveation, missRatio: decision.missRatio, beforeRatio: decision.beforeRatio,
              nominalMs: decision.nominalMs, blockedForMs: decision.blockedForMs, nextHoldWindows: decision.nextHoldWindows,
              foveationReadBack: decision.rung?.foveation === null ? undefined : foveationReadBack,
              at: decision.at });
          }
        }
        if (time - lastSummary >= timing.summaryMs) { lastSummary = time; summary(time); }
      } catch (error) {
        // One failure returns the session to its starting settings and stops
        // deciding, rather than letting a broken step repeat on every frame.
        // The wrapper stays: Chromium keeps a view's requested scale across
        // frames, so it has to keep asking for 1.
        failed = true;
        requestedScale = 1;
        scaleCheck = null;
        try { if (foveationWritten !== null && baseFoveation !== null) writeFoveation(baseFoveation); } catch { /* Best effort. */ }
        publish({ event: 'failed', error: String(error?.message ?? error) });
      }
    },
    stop() {
      if (stopped) return;
      stopped = true;
      try { summary(undefined, true); } catch { /* Advisory only. */ }
      unwrap();
    },
    state() {
      return { mode, device, ladder: ladder ? describeLadder(ladder) : null, viewportScaling,
        requestedScale, foveation: foveationWritten ?? baseFoveation, ...core.state() };
    },
  };
}

function diagnosticsRecorder(scope) {
  let recorder;
  try { recorder = (scope ?? globalThis)?.__stereofoldDiagnostics?.record; }
  catch { return null; }
  return typeof recorder === 'function' ? recorder : null;
}

function round2(value) { return Number.isFinite(value) ? Math.round(value * 100) / 100 : null; }
function round3(value) { return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null; }
