import test from 'node:test';
import assert from 'node:assert/strict';
import { watchFrameCost } from './xr-render-budget.mjs';

test('transform CPU counts actual passes, handles throws, and resets at the existing sample boundary', () => {
  let clock = 0;
  const queued = [], records = [];
  const session = { requestAnimationFrame: callback => queued.push(callback) };
  const cost = watchFrameCost({ session, now: () => clock, intervalMs: 100, scope: {}, record: (_, value) => records.push(value) });
  const pass = (ms, fail = false) => {
    const started = cost.beginTransform();
    try { clock += ms; if (fail) throw Error('transform failed'); }
    finally { cost.endTransform(started); }
  };
  session.requestAnimationFrame(() => {
    cost.measure(() => { pass(3); assert.throws(() => pass(5, true), /transform failed/); });
  });
  queued.shift()(0, {});
  assert.equal(records.length, 0, 'no per-frame diagnostic write');
  clock = 100;
  session.requestAnimationFrame(() => {}); queued.shift()(100, {});
  assert.equal(records[0].transformPassCount, 2);
  assert.equal(records[0].transformCpuMs, 8);
  assert.equal(records[0].maxTransformMs, 5);
  assert.equal(records[0].overlayCpuMs, 8);
  assert.equal(records[0].gpuMeasured, false);
  clock = 200;
  session.requestAnimationFrame(() => {}); queued.shift()(200, {});
  assert.equal(records[1].transformPassCount, 0);
  assert.equal(records[1].transformCpuMs, 0);
  cost.stop();
  assert.equal(cost.beginTransform(), undefined);
});

test('disabled transform sampling never reads the clock or writes diagnostics', () => {
  const cost = watchFrameCost({ sampling: 'off', scope: {},
    now: () => assert.fail('disabled timer read'), record: () => assert.fail('disabled diagnostic write') });
  assert.equal(cost.beginTransform(), undefined);
  cost.endTransform(undefined);
});

test('unique XR timestamps distinguish extra subscribers, long tasks and callback CPU', () => {
  let clock = 0, deliverLongTasks, disconnected = false;
  const queued = [], entries = [];
  const session = { frameRate: 72, requestAnimationFrame: cb => queued.push(cb) };
  class PerformanceObserver {
    static supportedEntryTypes = ['longtask'];
    constructor(callback) { deliverLongTasks = durations => callback({ getEntries: () => durations.map(duration => ({ duration })) }); }
    observe(options) { assert.deepEqual(options, { type: 'longtask', buffered: false }); }
    disconnect() { disconnected = true; }
  }
  const cost = watchFrameCost({ session, now: () => clock, intervalMs: 100,
    record: (kind, detail) => entries.push(detail), scope: { PerformanceObserver } });
  const run = (time, work) => { session.requestAnimationFrame(work); queued.shift()(time, {}); };
  run(10, () => { clock += 2; cost.measure(() => { clock += 3; }); });
  run(10, () => { clock += 1; }); // Another subscriber, same native frame.
  clock += 80; // Work outside the animation callback is visible as a long task.
  deliverLongTasks([80]);
  clock = 100;
  run(110, () => { clock += 2; });
  assert.equal(entries.length, 1);
  const detail = entries[0];
  assert.equal(detail.callbackCount, 3);
  assert.equal(detail.uniqueFrameCount, 2);
  assert.equal(detail.maxXrFrameGapMs, 100);
  assert.equal(detail.callbackCpuMs, 8);
  assert.equal(detail.overlayCpuMs, 3);
  assert.equal(detail.longTaskCount, 1);
  assert.equal(detail.longTaskTotalMs, 80);
  assert.equal(detail.maxLongTaskMs, 80);
  assert.equal(detail.gpuMeasured, false);
  cost.stop();
  assert.equal(disconnected, true);
});

test('missing long-task support remains explicit and does not prevent sampling', () => {
  let callback, clock = 0;
  const entries = [], session = { requestAnimationFrame: cb => { callback = cb; } };
  const cost = watchFrameCost({ session, intervalMs: 0, now: () => clock, scope: {}, record: (_, detail) => entries.push(detail) });
  session.requestAnimationFrame(() => { clock += 1; });
  callback(0, {});
  assert.equal(entries[0].longTaskSupported, false);
  assert.equal(entries[0].uniqueFrameCount, 1);
  assert.equal('longTaskCount' in entries[0], false);
  cost.stop();
});


test('diagnostics failure cannot abort the callback or leak a partially started observer', () => {
  let callback, disconnected = 0, ran = 0;
  const session = { requestAnimationFrame: cb => { callback = cb; } };
  class PerformanceObserver {
    static supportedEntryTypes = ['longtask'];
    observe() { throw Error('unsupported at runtime'); }
    disconnect() { disconnected++; }
  }
  const cost = watchFrameCost({ session, intervalMs: 0, scope: { PerformanceObserver },
    record() { throw Error('diagnostics unavailable'); } });
  session.requestAnimationFrame(() => { ran++; return 'rendered'; });
  assert.equal(callback(1, {}), 'rendered');
  assert.equal(ran, 1);
  assert.equal(disconnected, 1);
  cost.stop();
});

test('stopping a sampler preserves a later wrapper and its pending callbacks', () => {
  let callback, ran = 0;
  const session = { requestAnimationFrame: cb => { callback = cb; } };
  const cost = watchFrameCost({ session, record() {} });
  const sampling = session.requestAnimationFrame;
  function later(callback) { return sampling.call(this, callback); }
  session.requestAnimationFrame = later;
  cost.stop();
  assert.equal(session.requestAnimationFrame, later);
  session.requestAnimationFrame(() => { ran++; });
  callback(1, {});
  assert.equal(ran, 1);
});
