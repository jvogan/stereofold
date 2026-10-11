import assert from 'node:assert/strict';
import test from 'node:test';
import { applyTargetFrameRate, readSessionFrameRates, watchSessionFrameRates } from './xr-render-budget.mjs';

function fakeSession(overrides = {}) {
  const listeners = new Map();
  return {
    inputSources: [],
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) { if (listeners.get(type) === listener) listeners.delete(type); },
    dispatch(type) { listeners.get(type)?.(); },
    listeners,
    ...overrides,
  };
}

function diagnosticScope() {
  const entries = [];
  return { entries, scope: { __stereofoldDiagnostics: { record: (kind, detail) => entries.push({ kind, detail }) } } };
}

test('copies the granted session frame-rate API into plain snapshot values', () => {
  const rates = new Float32Array([60, 72, 90]);
  const state = readSessionFrameRates(fakeSession({ supportedFrameRates: rates, frameRate: 72 }));
  assert.deepEqual(state, { supportedFrameRates: [60, 72, 90], reportedFrameRate: 72 });
  assert.ok(Array.isArray(state.supportedFrameRates));
  assert.notStrictEqual(state.supportedFrameRates, rates);
});

test('treats absent and throwing frame-rate properties as unsupported', () => {
  assert.deepEqual(readSessionFrameRates(fakeSession()), { supportedFrameRates: [], reportedFrameRate: null });
  const hostile = fakeSession();
  Object.defineProperties(hostile, {
    supportedFrameRates: { get() { throw new Error('ended'); } },
    frameRate: { get() { throw new Error('ended'); } },
  });
  assert.deepEqual(readSessionFrameRates(hostile), { supportedFrameRates: [], reportedFrameRate: null });
});

test('refreshes the snapshot and diagnostics on frameratechange', () => {
  const { entries, scope } = diagnosticScope();
  const session = fakeSession({ supportedFrameRates: [60, 72, 80, 90, 120], frameRate: 72 });
  const watch = watchSessionFrameRates({ session, requestedFrameRate: 72, scope });
  assert.deepEqual(watch.state(), { supportedFrameRates: [60, 72, 80, 90, 120], reportedFrameRate: 72 });
  assert.deepEqual(entries[0], { kind: 'session-frame-rate', detail: { event: 'granted',
    supportedFrameRates: [60, 72, 80, 90, 120], reportedFrameRate: 72, requestedFrameRate: 72 } });
  session.frameRate = 80;
  session.dispatch('frameratechange');
  assert.equal(watch.state().reportedFrameRate, 80);
  assert.deepEqual(entries[1], { kind: 'session-frame-rate', detail: { event: 'frameratechange',
    supportedFrameRates: [60, 72, 80, 90, 120], reportedFrameRate: 80,
    requestedFrameRate: 72, mismatch: true } });
  watch.stop();
  assert.equal(session.listeners.has('frameratechange'), false);
});

test('records a rejected target request with the rate still in effect', async () => {
  const { entries, scope } = diagnosticScope();
  const session = fakeSession({ supportedFrameRates: [60, 72, 90], frameRate: 60,
    updateTargetFrameRate: () => Promise.reject(new Error('refused')) });
  assert.deepEqual(applyTargetFrameRate(session, 72, scope), { requested: 72, sent: 72, reason: 'sent' });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(entries.at(-1), { kind: 'session-frame-rate', detail: { event: 'request-rejected',
    supportedFrameRates: [60, 72, 90], reportedFrameRate: 60, targetFrameRate: 72,
    requestedFrameRate: 72, mismatch: true } });
});

test('records a granted rate that differs from the requested rate', async () => {
  const { entries, scope } = diagnosticScope();
  const session = fakeSession({ supportedFrameRates: [72, 80], frameRate: 80,
    updateTargetFrameRate: () => Promise.resolve() });
  applyTargetFrameRate(session, 72, scope);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(entries.at(-1), { kind: 'session-frame-rate', detail: { event: 'request-mismatch',
    supportedFrameRates: [72, 80], reportedFrameRate: 80, targetFrameRate: 72,
    requestedFrameRate: 72, mismatch: true } });
});
