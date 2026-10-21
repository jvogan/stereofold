import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { pageFunction } from './fixtures/label-action-harness.mjs';
import { tourFocusHarness } from './fixtures/tour-focus-harness.mjs';

const source = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
const failure = (code, message) => Object.assign(Error(message), { code });
const install = h => {
  for (const name of ['awaitFreshFocusTracking', 'sampleHeadFrame', 'beginGesturePivot', 'invalidateGesturePivot'])
    vm.runInContext(pageFunction(source, name), h);
};
function fixture() {
  let time = 3000, serial = 0;
  const timers = new Map(), listeners = new Set(), records = [];
  const session = { visibilityState: 'visible', addEventListener: (_kind, fn) => listeners.add(fn),
    removeEventListener: (_kind, fn) => listeners.delete(fn) };
  const owner = {};
  const h = vm.createContext({
    performance: { now: () => time }, failure,
    setTimeout: fn => { timers.set(++serial, fn); return serial; }, clearTimeout: id => timers.delete(id),
    canvas: { xr: { isPresenting: { value: true } }, webgl: { xr: { session }, isContextLost: false }, requestDraw() {} },
    state: { status: 'ready', generation: 1, drawCount: 8 }, sourceRecord: {}, visibleStage: {},
    latestRoomPlacementPose: {}, latestHeadSample: 1000, latestHeadContext: null,
    placementViewWaiters: new Set(), frameWaiters: new Set(), focusPivotRequest: owner,
    recordCost: (kind, detail) => records.push({ kind, ...detail }),
    gesturePivot: { begin() {}, invalidate() {} }, gesturePivotContext: () => ({}),
    interactionActive: () => false,
  });
  h.currentXrSession = () => h.canvas.webgl.xr.session;
  h.assertContext = () => {
    if (h.canvas.webgl.isContextLost) throw failure('context_lost', 'Context lost.');
    if (h.state.status === 'disposed') throw failure('viewer_disposed', 'Disposed.');
  };
  install(h);
  const clean = () => {
    assert.equal(timers.size, 0); assert.equal(listeners.size, 0);
    assert.equal(h.placementViewWaiters.size, 0); assert.equal(h.frameWaiters.size, 0);
    assert.equal(owner.trackingChanged, undefined);
  };
  return { h, owner, records, timers, listeners, clean, time: value => { time = value; },
    sample: (tracked = true) => {
      h.state.drawCount++;
      h.latestRoomPlacementPose = tracked ? {} : null;
      h.sampleHeadFrame({ pose: null, roomPose: tracked ? {} : null });
    },
    wait: () => h.awaitFreshFocusTracking(owner),
  };
}

test('focus waits for a newly observed room pose, not a callback, draw count, or cached eye views', async () => {
  const t = fixture(); let settled = false;
  const waiting = t.wait().then(() => { settled = true; });
  t.h.state.drawCount++;
  t.owner.trackingChanged();
  await Promise.resolve(); assert.equal(settled, false);
  t.time(3100); t.sample(false);
  await Promise.resolve(); assert.equal(settled, false);
  assert.equal(t.h.latestHeadSample, 1000, 'No tracking timestamp is fabricated for missing room poses.');
  t.time(3200); t.sample(); await waiting;
  assert.equal(t.h.latestHeadSample, 3200);
  assert.deepEqual(t.records.map(r => r.outcome), ['waiting', 'fresh']);
  assert.equal(t.records[0].sampleAgeMs, 2000);
  assert.equal(t.records[1].sampleAgeMs, 0); assert.equal(t.records[1].waitedMs, 200);
  t.clean();
});

test('true tracking loss times out without admitting the stale pose', async () => {
  const t = fixture(); const rejected = assert.rejects(t.wait(), { code: 'tracking_timeout' });
  t.time(5000); for (const timer of [...t.timers.values()]) timer();
  await rejected; assert.equal(t.h.latestHeadSample, 1000);
  assert.equal(t.records.at(-1).outcome, 'refused'); t.clean();
});

test('a fresh sample after the deadline is refused even when the timer was starved', async () => {
  const t = fixture(); const rejected = assert.rejects(t.wait(), { code: 'tracking_timeout' });
  t.time(5100); t.sample(); await rejected;
  assert.equal(t.records.at(-1).sampleAgeMs, 0);
  assert.equal(t.records.at(-1).waitedMs, 2100); t.clean();
});

for (const [name, change, code] of [
  ['source', h => { h.sourceRecord = {}; }, 'stale_transition'],
  ['source generation', h => { h.state.generation++; }, 'stale_transition'],
  ['visible subject', h => { h.visibleStage = {}; }, 'stale_transition'],
  ['session', h => { h.canvas.webgl.xr.session = {}; }, 'stale_transition'],
  ['presentation end', h => { h.canvas.xr.isPresenting.value = false; }, 'stale_transition'],
  ['context loss', h => { h.canvas.webgl.isContextLost = true; }, 'context_lost'],
  ['interaction', h => { h.interactionActive = () => true; }, 'interaction_active'],
]) test(`focus refuses ${name} changes while waiting without accepting a new pose`, async () => {
  const t = fixture(); const rejected = assert.rejects(t.wait(), { code });
  change(t.h); t.owner.trackingChanged();
  await rejected; t.clean();
});

for (const action of ['beginGesturePivot', 'invalidateGesturePivot']) test(`${action} immediately releases a pending focus wait`, async () => {
  const t = fixture(); const rejected = assert.rejects(t.wait(), { code: 'stale_transition' });
  t.h[action](); await rejected; t.clean();
});

test('the session end event releases focus without another frame', async () => {
  const t = fixture(); const rejected = assert.rejects(t.wait(), { code: 'stale_transition' });
  for (const end of [...t.listeners]) end(); await rejected; t.clean();
});

test('the shared context/dispose frame-wait rejection cleans up the focus waiter', async () => {
  const t = fixture(); const rejected = assert.rejects(t.wait(), { code: 'viewer_disposed' });
  for (const finish of [...t.h.frameWaiters]) finish(failure('viewer_disposed', 'Disposed.'));
  await rejected; t.clean();
});

test('a draw request failure does not retain timers or lifecycle listeners', async () => {
  const t = fixture(); t.h.canvas.requestDraw = () => { throw Error('Draw unavailable.'); };
  await assert.rejects(t.wait(), /Draw unavailable/); t.clean();
});

test('production chapter focus resumes after an actual head sample and keeps the original freshness guard', async () => {
  const view = tourFocusHarness(), h = view.h;
  h.frameWaiters = new Set(); h.latestHeadContext = null; h.latestHeadSample = -2000;
  h.currentXrSession = () => h.canvas.webgl.xr.session;
  h.canvas.requestDraw = () => {}; h.assertContext = () => {}; h.interactionActive = () => false;
  install(h);
  const focus = h.focusSelection({ wholeStructure: true, liftEmphasis: false, durationMs: 0 });
  assert.equal(h.placementViewWaiters.size, 1);
  assert.equal(view.writes.length, 0);
  h.sampleHeadFrame({ pose: null, roomPose: {} });
  await focus;
  assert.equal(h.placementViewWaiters.size, 0);
  assert.ok(view.records.some(r => r.kind === 'xr-focus'));
  assert.ok(view.records.some(r => r.kind === 'focus-tracking' && r.outcome === 'fresh'));
});
