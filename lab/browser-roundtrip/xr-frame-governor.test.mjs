import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FRAME_GOVERNOR_DEFAULTS, GOVERNOR_FLOOR, SAFARI_NOMINAL_MS,
  createFrameGovernor, frameGovernorMode, governorLadder, installFrameGovernor,
} from './xr-frame-governor.mjs';
import { parseRenderBudgetOverrides } from './xr-render-budget.mjs';

const T72 = 1_000 / 72;
const T90 = 1_000 / 90;
const QUEST2_AGENT = 'Mozilla/5.0 (X11; Linux x86_64; Quest 2) OculusBrowser/150.1.0.24.52.1046134268';
const QUEST3_AGENT = 'Mozilla/5.0 (X11; Linux x86_64; Quest 3) OculusBrowser/150.1.0.24.52.1046134268';
const HEADLESS_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 HeadlessChrome/141.0.0.0 Safari/537.36';

/** Two rungs below the start, as a Quest 2 light scene without foveation headroom has. */
const THREE_RUNGS = governorLadder({ layerScale: 0.8, viewportScaling: true, foveation: 1 }).slice(0, 3);

/**
 * Feed a governor frames at a display interval. `late(time, level, index)`
 * says how many extra display slots a frame took; `paused(time)` pauses.
 * `nominal: null` is a runtime that reports no frame rate.
 */
function drive(governor, { seconds, interval = T72, nominal = interval, late = () => 0, paused = () => false, start = 0 }) {
  const decisions = [];
  let time = start, index = 0;
  while (time < start + seconds * 1_000) {
    time += interval * (1 + late(time, governor.state().level, index++));
    const decision = governor.frame(time, { nominalMs: nominal ?? undefined, paused: paused(time) });
    if (decision) decisions.push({ ...decision, time });
  }
  return { decisions, end: time };
}

/** A fill-bound frame: one in three misses its slot at full resolution only. */
const fillBound = (time, level, index) => (level === 0 && index % 3 === 0 ? 1 : 0);

test('the ladder starts from the session settings and stops at the floor', () => {
  // Quest 2 tiers: foveation is already 1, so only viewport rungs, and fewer
  // of them the smaller the layer already is.
  assert.deepEqual(governorLadder({ layerScale: 0.8, viewportScaling: true, foveation: 1 }).map(rung => rung.viewportScale),
    [1, 0.85, 0.7, 0.6, 0.5]);
  assert.deepEqual(governorLadder({ layerScale: 0.6, viewportScaling: true, foveation: 1 }).map(rung => rung.viewportScale),
    [1, 0.85, 0.7]);
  assert.deepEqual(governorLadder({ layerScale: 0.5, viewportScaling: true, foveation: 1 }).map(rung => rung.viewportScale),
    [1, 0.85]);
  for (const layerScale of [0.5, 0.6, 0.8, 1]) {
    for (const rung of governorLadder({ layerScale, viewportScaling: true, foveation: 1 })) {
      assert.ok(rung.viewportScale === 1 || layerScale * rung.viewportScale >= GOVERNOR_FLOOR - 1e-9);
      assert.equal(rung.foveation, 1, 'a Quest 2 keeps its measured foveation on every rung');
    }
  }
  // Quest 3: full foveation after the first, mildest viewport step.
  assert.deepEqual(governorLadder({ layerScale: 1, viewportScaling: true, foveation: 0.5 }), [
    { viewportScale: 1, foveation: 0.5 }, { viewportScale: 0.85, foveation: 0.5 }, { viewportScale: 0.85, foveation: 1 },
    { viewportScale: 0.7, foveation: 1 }, { viewportScale: 0.6, foveation: 1 }, { viewportScale: 0.5, foveation: 1 }]);
  // A layer without fixedFoveation, and a runtime without viewport scaling.
  assert.deepEqual(governorLadder({ viewportScaling: true }).map(rung => rung.foveation), [null, null, null, null, null]);
  assert.deepEqual(governorLadder({ foveation: 0.5 }), [{ viewportScale: 1, foveation: 0.5 }, { viewportScale: 1, foveation: 1 }]);
  assert.deepEqual(governorLadder(), [{ viewportScale: 1, foveation: null }]);
  assert.deepEqual(governorLadder({ viewportScaling: true, floor: 0.75 }).map(rung => rung.viewportScale), [1, 0.85]);
});

test('every class observes by default, and the switch explicitly opts in or out', () => {
  for (const device of ['quest2', 'quest3', 'quest-pro', 'vision-pro', 'hand-only', 'unknown'])
    assert.equal(frameGovernorMode(device), 'observe', `${device} preserves its current resolution by default`);
  assert.equal(frameGovernorMode('quest2', parseRenderBudgetOverrides('governor:on')), 'on');
  assert.equal(frameGovernorMode('vision-pro', parseRenderBudgetOverrides('governor:on')), 'on');
  assert.equal(frameGovernorMode('unknown', parseRenderBudgetOverrides('governor:on')), 'on');
  assert.equal(frameGovernorMode('vision-pro', parseRenderBudgetOverrides('governor:off')), 'off');
  assert.equal(frameGovernorMode('unknown', parseRenderBudgetOverrides('governor:observe')), 'observe');
  assert.equal(frameGovernorMode('quest3', parseRenderBudgetOverrides('off')), 'off', 'the whole budget off takes the governor with it');
  assert.equal(parseRenderBudgetOverrides('governor:on,governorFloor:0.5').governorFloor, 0.5);
  assert.equal(parseRenderBudgetOverrides('governorFloor:1.5').governorFloor, undefined);
});

test('a sustained miss steps down once, after three bad windows and not before', () => {
  const governor = createFrameGovernor({ rungs: THREE_RUNGS });
  const { decisions } = drive(governor, { seconds: 8, late: fillBound });
  assert.equal(decisions.length, 1);
  const [step] = decisions;
  assert.equal(step.action, 'down');
  assert.equal(step.reason, 'sustained-misses');
  assert.deepEqual([step.from, step.to], [0, 1]);
  assert.ok(step.time >= FRAME_GOVERNOR_DEFAULTS.warmupMs + 3 * FRAME_GOVERNOR_DEFAULTS.windowMs, `stepped at ${step.time}`);
  assert.ok(step.time < FRAME_GOVERNOR_DEFAULTS.warmupMs + 3 * FRAME_GOVERNOR_DEFAULTS.windowMs + 100);
  assert.ok(Math.abs(step.missRatio - 0.25) < 0.01, 'one late frame in three is one missed slot in four');
  assert.equal(governor.state().level, 1);
});

test('a single spike, a stall, or a short burst never moves the rung', () => {
  const governor = createFrameGovernor({ rungs: THREE_RUNGS });
  const spikes = new Set([700, 1_400, 2_100]);
  const { decisions } = drive(governor, { seconds: 60, late: (time, level, index) => (spikes.has(index) ? [1, 30, 2][[...spikes].indexOf(index)] : 0) });
  assert.deepEqual(decisions, []);
  assert.equal(governor.state().stalls, 1, 'the 30-slot gap is a stall, not fill');

  const burst = createFrameGovernor({ rungs: THREE_RUNGS });
  const twoBad = (time, level, index) => (time > 10_000 && time < 12_000 && index % 3 === 0 ? 1 : 0);
  assert.deepEqual(drive(burst, { seconds: 60, late: twoBad }).decisions, []);
});

test('recovers to the starting rung when the load lifts, and stays', () => {
  const governor = createFrameGovernor({ rungs: THREE_RUNGS });
  const heavyThen = (time, level, index) => (time < 20_000 ? fillBound(time, level, index) : 0);
  const { decisions } = drive(governor, { seconds: 90, late: heavyThen });
  assert.equal(decisions[0].reason, 'sustained-misses');
  const last = decisions.at(-1);
  assert.equal(last.action, 'up');
  assert.equal(last.reason, 'recovered');
  assert.ok(last.time > 20_000 && last.time < 35_000, `recovered at ${last.time}`);
  assert.equal(governor.state().level, 0);
  assert.ok(decisions.length <= 4, 'one step down, at most one failed probe, one recovery');
});

test('oscillation bait: a scene on a rung boundary probes ever more rarely', () => {
  const governor = createFrameGovernor({ rungs: THREE_RUNGS });
  const { decisions } = drive(governor, { seconds: 15 * 60, late: fillBound });
  const probes = decisions.filter(decision => decision.reason === 'recovered');
  const failures = decisions.filter(decision => decision.reason === 'probe-failed');
  assert.equal(probes.length, failures.length);
  assert.ok(probes.length <= 8, `${probes.length} probes in fifteen minutes`);
  for (const [index, probe] of probes.entries()) {
    // Each probe is caught by its first bad window, not three.
    const failure = failures[index];
    assert.ok(failure.time > probe.time && failure.time - probe.time < 2_500, `probe ${index} lasted ${failure.time - probe.time} ms`);
  }
  const spacing = probes.slice(1).map((probe, index) => probe.time - probes[index].time);
  for (let index = 1; index < spacing.length; index++) assert.ok(spacing[index] >= spacing[index - 1] - 100, 'probes back off');
  const atStart = governor.state().secondsAtRung[0];
  assert.ok(atStart < 0.05 * 15 * 60, `${atStart} s at the missing rung`);

  // A load that is bad one window in three is not sustained, whatever its phase.
  for (const phase of [0, 250, 500, 750]) {
    const pulse = createFrameGovernor({ rungs: THREE_RUNGS });
    const oneInThree = (time, level, index) => (Math.floor((time + phase) / 1_000) % 3 === 0 && index % 3 === 0 ? 1 : 0);
    assert.deepEqual(drive(pulse, { seconds: 120, late: oneInThree }).decisions, [], `phase ${phase}`);
  }
});

test('undoes a step that does not reduce misses, and waits longer each time', () => {
  const governor = createFrameGovernor({ rungs: THREE_RUNGS });
  const cpuBound = (time, level, index) => (index % 3 === 0 ? 1 : 0);
  const { decisions } = drive(governor, { seconds: 180, late: cpuBound });
  const downs = decisions.filter(decision => decision.action === 'down');
  const undone = decisions.filter(decision => decision.reason === 'ineffective');
  assert.ok(downs.length >= 2 && downs.length <= 3, `${downs.length} attempts in three minutes`);
  assert.equal(undone.length, downs.length);
  assert.deepEqual(undone.map(decision => decision.blockedForMs), [30_000, 60_000, 120_000].slice(0, undone.length));
  for (const [index, down] of downs.entries()) assert.ok(undone[index].time - down.time < 3_000);
  assert.equal(governor.state().level, 0, 'resolution is back where it started');
});

test('a governor with no knobs reports its floor once', () => {
  const governor = createFrameGovernor();
  const { decisions } = drive(governor, { seconds: 60, late: (time, level, index) => (index % 3 === 0 ? 1 : 0) });
  assert.deepEqual(decisions.map(decision => [decision.action, decision.reason]), [['hold', 'floor']]);
});

test('observe mode reports what it would do without moving, once per block', () => {
  const governor = createFrameGovernor({ rungs: THREE_RUNGS, dryRun: true });
  const { decisions } = drive(governor, { seconds: 70, late: fillBound });
  assert.ok(decisions.length >= 2 && decisions.length <= 3, `${decisions.length} reports`);
  assert.ok(decisions.every(decision => decision.dryRun === true && decision.from === 0 && decision.to === 1));
  for (let index = 1; index < decisions.length; index++) {
    assert.ok(decisions[index].time - decisions[index - 1].time >= FRAME_GOVERNOR_DEFAULTS.blockMs);
  }
  assert.equal(governor.state().level, 0);
  assert.equal(governor.state().wouldSteps, decisions.length);
});

test('measures the display interval when the runtime reports none', () => {
  const measured = createFrameGovernor({ rungs: THREE_RUNGS });
  const { decisions } = drive(measured, { seconds: 8, interval: T90, nominal: null, late: fillBound });
  assert.equal(decisions[0]?.reason, 'sustained-misses');
  assert.ok(Math.abs(measured.state().nominalMs - T90) < 0.05);

  // A session at half rate from its first frame looks steady to a measurement
  // alone; Safari's 90 Hz cap is what exposes it.
  const halfRate = () => 1;
  assert.deepEqual(drive(createFrameGovernor({ rungs: THREE_RUNGS }), { seconds: 8, interval: T90, nominal: null, late: halfRate }).decisions, []);
  const capped = createFrameGovernor({ rungs: THREE_RUNGS, maxNominalMs: SAFARI_NOMINAL_MS });
  assert.equal(drive(capped, { seconds: 8, interval: T90, nominal: null, late: halfRate }).decisions[0]?.reason, 'sustained-misses');
});

test('pauses drop frames and the gap across them, and a scene change clears probe history', () => {
  const governor = createFrameGovernor({ rungs: THREE_RUNGS });
  const paused = time => time > 3_000 && time < 30_000;
  const { decisions } = drive(governor, { seconds: 30, late: fillBound, paused });
  assert.deepEqual(decisions, [], 'nothing paused is counted');

  const history = createFrameGovernor({ rungs: THREE_RUNGS });
  const first = drive(history, { seconds: 15, late: fillBound });
  assert.ok(first.decisions.some(decision => decision.reason === 'probe-failed'));
  history.sceneChanged();
  const after = drive(history, { seconds: 10, late: () => 0, start: first.end });
  const probe = after.decisions.find(decision => decision.reason === 'recovered');
  assert.ok(probe && probe.time - first.end < 7_000, 'the new scene is probed after the base hold');
});

/**
 * A presenting session whose layer behaves like Chromium's: each frame's
 * views start at scale 1 and `getViewport` honours the requested scale. With
 * `honoursScale: false` it behaves like the emulator, which stores the
 * request and returns the full viewport anyway.
 */
function fakeXr({ honoursScale = true, viewScaling = true, foveation = 0.5, frameRate = 72, agent = QUEST3_AGENT, search = '',
  transitionActive = () => false } = {}) {
  const entries = [];
  const layer = {
    fixedFoveation: foveation,
    getViewport(view) {
      const scale = honoursScale ? (view.requested ?? 1) : 1;
      return { x: 0, y: 0, width: Math.round(1_000 * scale), height: Math.round(1_100 * scale) };
    },
  };
  const original = layer.getViewport;
  const session = { renderState: { baseLayer: layer }, frameRate, visibilityState: 'visible', inputSources: [] };
  const views = () => [0, 1].map(() => (viewScaling
    ? { requested: undefined, recommendedViewportScale: null, requestViewportScale(scale) { this.requested = scale; } }
    : {}));
  const governor = installFrameGovernor({ session, navigator: { userAgent: agent }, scope: { location: { search } },
    record: (kind, detail) => entries.push({ kind, detail }), transitionActive });
  let width = 1_000;
  /** One frame: the governor's hook, then Mol* asking for both eye viewports. */
  const frame = time => {
    governor.frame(time);
    for (const view of views()) width = session.renderState.baseLayer.getViewport(view).width;
  };
  /** Fill-bound at more than 90 percent of full width. */
  const run = (seconds, start = 0, late = (index, rendered) => (rendered > 0.9 && index % 3 === 0 ? 1 : 0)) => {
    let time = start, index = 0;
    while (time < start + seconds * 1_000) {
      time += T72 * (1 + late(index++, width / 1_000));
      frame(time);
    }
    return time;
  };
  return { entries, layer, original, session, governor, run, width: () => width };
}

test('scales each eye viewport once an opted-in step lands, and only then', () => {
  const xr = fakeXr({ search: '?xrRenderBudget=governor:on' });
  assert.equal(xr.governor.mode, 'on');
  xr.run(4);
  assert.equal(xr.width(), 1_000, 'nothing is requested before the first step');
  xr.run(6, 4_000);
  assert.equal(xr.width(), 850);
  const governed = xr.entries.filter(entry => entry.kind === 'frame-governor');
  assert.deepEqual(governed.map(entry => entry.detail.event), ['start', 'step']);
  assert.deepEqual(governed[0].detail.rungs.slice(0, 3), [
    { viewportScale: 1, foveation: 0.5 }, { viewportScale: 0.85, foveation: 0.5 }, { viewportScale: 0.85, foveation: 1 }]);
  assert.equal(governed[0].detail.device, 'quest3');
  assert.equal(governed[0].detail.nominalSource, 'session-frame-rate');
  assert.equal(governed[1].detail.viewportScale, 0.85);
  assert.equal(xr.layer.fixedFoveation, 0.5, 'the first rung leaves foveation alone');
  xr.governor.stop();
  assert.equal(xr.layer.getViewport, xr.original, 'stop removes the wrapper');
  assert.deepEqual(xr.entries.at(-1).detail.event, 'summary');
  assert.equal(xr.entries.at(-1).detail.final, true);
});

test('a failure inside the governor returns the session to full resolution', () => {
  let broken = false;
  const xr = fakeXr({ search: '?xrRenderBudget=governor:on', transitionActive: () => { if (broken) throw Error('transition read failed'); return false; } });
  const end = xr.run(8);
  assert.equal(xr.width(), 850);
  broken = true;
  xr.run(0.1, end);
  assert.equal(xr.width(), 1_000);
  assert.deepEqual(xr.entries.at(-1).detail, { event: 'failed', error: 'transition read failed' });
});

test('drops a viewport knob the runtime accepts but ignores', () => {
  const xr = fakeXr({ honoursScale: false, search: '?xrRenderBudget=governor:on' });
  xr.run(8);
  const inert = xr.entries.find(entry => entry.detail.reason === 'viewport-inert');
  assert.ok(inert, 'the unchanged viewport is detected');
  assert.deepEqual(inert.detail.rungs, [{ viewportScale: 1, foveation: 0.5 }, { viewportScale: 1, foveation: 1 }]);
  assert.equal(xr.governor.state().viewportScaling, false);
  assert.equal(xr.governor.state().requestedScale, 1);
});

test('raises foveation where viewport scaling is missing, and restates it over a later write', () => {
  const xr = fakeXr({ viewScaling: false, search: '?xrRenderBudget=governor:on' });
  const end = xr.run(6);
  assert.equal(xr.layer.fixedFoveation, 1);
  xr.layer.fixedFoveation = 0.5;
  // Once raised, nothing at full resolution misses in this fake, so hold the
  // load off and watch the next frame restate the level.
  xr.run(0.05, end, () => 0);
  assert.equal(xr.layer.fixedFoveation, 1);
});

test('governor:on opts in to live changes; default mode observes without changing the layer', () => {
  const observed = fakeXr({ agent: QUEST2_AGENT, foveation: 1 });
  assert.equal(observed.governor.mode, 'observe');
  observed.run(8);
  assert.equal(observed.layer.getViewport, observed.original, 'observing never wraps the layer');
  assert.equal(observed.width(), 1_000);
  assert.deepEqual(observed.entries.map(entry => entry.detail.event), ['start', 'would-step']);

  const on = fakeXr({ agent: QUEST2_AGENT, foveation: 1, search: '?xrRenderBudget=governor:on' });
  assert.equal(on.governor.mode, 'on');
  on.run(8);
  assert.equal(on.width(), 850);

  const off = fakeXr({ search: '?xrRenderBudget=governor:off' });
  off.run(8);
  assert.equal(off.layer.getViewport, off.original);
  assert.deepEqual(off.entries.map(entry => [entry.detail.event, entry.detail.mode]), [['start', 'off']]);
});

test('an unnamed headset with no frame rate is measured, and a hostile session never throws', () => {
  const xr = fakeXr({ agent: HEADLESS_AGENT, frameRate: null, foveation: null });
  xr.run(8);
  const start = xr.entries.find(entry => entry.detail.event === 'start').detail;
  assert.equal(start.device, 'unknown');
  assert.equal(start.nominalSource, 'measured');
  assert.equal(xr.governor.mode, 'observe');
  assert.equal(xr.layer.getViewport, xr.original, 'unknown devices keep the original viewport unless opted in');
  assert.equal(xr.width(), 1_000);
  assert.deepEqual(xr.entries.map(entry => entry.detail.event), ['start', 'would-step']);

  const optedIn = fakeXr({ agent: HEADLESS_AGENT, frameRate: null, foveation: null, search: '?xrRenderBudget=governor:on' });
  optedIn.run(8);
  assert.equal(optedIn.governor.mode, 'on');
  assert.equal(optedIn.width(), 850);

  const session = {};
  Object.defineProperties(session, {
    renderState: { get() { throw Error('ended'); } },
    frameRate: { get() { throw Error('ended'); } },
    visibilityState: { get() { throw Error('ended'); } },
  });
  const governor = installFrameGovernor({ session, navigator: { userAgent: QUEST3_AGENT }, scope: {}, record() { throw Error('sink'); } });
  for (let time = 0; time < 5_000; time += T72) governor.frame(time);
  governor.stop();
});
