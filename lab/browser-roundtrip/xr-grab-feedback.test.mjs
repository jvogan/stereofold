import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createXrGrabFeedback } from './xr-grab-feedback.mjs';
import { createXrManipulation } from './xr-manipulate.mjs';

const viewer = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');

function harness(hand, synthetic = false) {
  let at = 0, state = { status: 'error', error: 'Not created at all. Did you await/then the corresponding state update?', contextLost: false };
  const spoken = [], records = [], deltas = [], starts = [], ends = [];
  const source = synthetic ? { hand: {}, targetRayMode: 'tracked-pointer' }
    : { targetRayMode: 'tracked-pointer', gamepad: { buttons: [{ value: 0 }, { value: 0 }] } };
  // Run the viewer's actual admission and callback wiring. Accessory scene,
  // caption and save operations are observed at their boundary here.
  const h = vm.createContext({ appearanceWork: undefined, state, inspectionState: {}, GRABBABLE_STATUS: new Set(['ready', 'mutating']),
    canvas: { webgl: { get isContextLost() { return state.contextLost; } } },
    createXrGrabFeedback, speakOutcome: text => spoken.push(text),
    recordManipulation: (kind, detail) => records.push({ kind, detail }),
    createXrManipulation: options => createXrManipulation({ ...options, now: () => at, record() {}, pulse() {} }),
    spatialOwnedHands: new Set(), triggerStickIntent: undefined, immersiveSession: undefined,
    gripTargetDepthAxis: () => [0, 0, -1],
    cancelXrPlacementFollowup() {}, beginGesturePivot: () => starts.push(true), talkCaption: undefined,
    signalManualInteraction() {}, pausePresentationForInput: async () => {},
    applyGrabDelta: delta => deltas.push(delta),
    xrDeferredGrab: undefined, flushXrDeferredGrab: () => ends.push(h.xrDeferredGrab), console });
  const canStart = viewer.indexOf('  function canManipulateNow() {');
  assert.ok(canStart > 0);
  vm.runInContext(viewer.slice(canStart, viewer.indexOf('\n  }', canStart) + 4), h);
  const hookup = viewer.indexOf('    const grabFeedback = createXrGrabFeedback({');
  const hookupEnd = viewer.indexOf('\n    xrButtons =', hookup);
  assert.ok(hookup > 0 && hookupEnd > hookup, 'actual viewer installs the fault feedback');
  vm.runInContext(viewer.slice(hookup, hookupEnd), h);
  const manipulation = h.xrManipulation, feedback = vm.runInContext('grabFeedback', h);
  function frame({ z = 0, value = 1, quality = 'tracked-position' } = {}) {
    at += 14;
    if (!synthetic) source.gamepad.buttons[1].value = value;
    const pose = { origin: [0, 1.4, z], direction: [0, 0, -1], orientation: [0, 0, 0, 1],
      emulatedPosition: quality !== 'tracked-position' };
    manipulation.update([{ handedness: hand, source, buttons: value >= .7 ? 2 : 0,
      hasGripSpace: true, poseQualitySource: 'webxr', tracking: 'tracked-position', gripTracking: quality,
      ray: { ...pose, emulatedPosition: false }, gripPose: pose }]);
  }
  return { frame, spoken, records, deltas, starts, ends, feedback,
    setAppearance: active => { h.appearanceWork = active ? {} : undefined; },
    setState: value => { state = value; h.state = value; } };
}

for (const hand of ['left', 'right']) for (const synthetic of [false, true]) {
  test(`${hand} ${synthetic ? 'synthetic hand' : 'analog controller'} terminal failure is bounded and recovery rebases a held grip`, () => {
    const h = harness(hand, synthetic);
    for (let i = 0; i < 180; i++) h.frame({ z: i * .001 });
    assert.equal(h.spoken.length, 1, 'holding across multiple refusal throttle periods never repeats speech');
    assert.match(h.spoken[0], /view failed.*agent to recover/i);
    assert.doesNotMatch(h.spoken[0], /One moment|loading|wait/i);
    assert.equal(h.records[0].detail.status, 'error');
    assert.match(h.records[0].detail.error, /Not created/);
    assert.equal(h.starts.length, 0); assert.equal(h.deltas.length, 0);
    h.frame({ value: 0 });
    for (let i = 0; i < 80; i++) h.frame();
    assert.equal(h.spoken.length, 1, 'release and another squeeze do not restart the same terminal warning');
    h.setState({ status: 'ready', contextLost: false });
    h.frame({ z: .3 });
    assert.equal(h.starts.length, 1);
    assert.equal(h.deltas.length, 0, 'first admitted position rebases instead of replaying refused movement');
    h.frame({ z: .32 });
    assert.ok(Math.abs(h.deltas.at(-1).translation[2] - .05) < 1e-10, 'physical 2cm depth retains 2.5x gain');
    h.frame({ value: 0, z: .32 });
    assert.equal(h.ends.length, 1);
    h.setState({ status: 'error', error: 'Not created at all. Did you await/then the corresponding state update?', contextLost: false });
    for (let i = 0; i < 80; i++) h.frame();
    assert.equal(h.spoken.length, 2, 'a fault after successful recovery can be reported again');
  });
}

test('temporary loading and graphics loss are distinct from terminal failure and do not loop', () => {
  const h = harness('right');
  for (const state of [{ status: 'loading' }, { status: 'ready', contextLost: true }, { status: 'error', error: 'failed' }]) {
    h.setState(state); h.feedback.refuse(); h.feedback.refuse();
  }
  assert.equal(h.spoken.length, 3);
  assert.match(h.spoken[0], /loading/);
  assert.match(h.spoken[1], /lost graphics/);
  assert.match(h.spoken[2], /view failed/);
});

for (const hand of ['left', 'right']) {
  test(`${hand} appearance ownership gives bounded updating feedback and safely admits the held grip after drawing`, () => {
    const h = harness(hand);
    h.setState({ status: 'ready', contextLost: false }); h.setAppearance(true);
    for (let i = 0; i < 180; i++) h.frame({ z: i * .001 });
    assert.deepEqual(h.spoken, ['The molecular view is updating. Try again when it finishes.']);
    assert.equal(h.starts.length, 0); assert.equal(h.deltas.length, 0);
    h.setAppearance(false); h.frame({ z: .2 });
    assert.equal(h.starts.length, 1); assert.equal(h.deltas.length, 0, 'draw completion rebases the held hand');
    h.frame({ z: .22 });
    assert.ok(Math.abs(h.deltas.at(-1).translation[2] - .05) < 1e-10);
    h.frame({ value: 0 }); assert.equal(h.ends.length, 1);
    h.setAppearance(true); h.setState({ status: 'error', error: 'render failed' });
    h.feedback.refuse(); assert.match(h.spoken.at(-1), /view failed/);
    h.setState({ status: 'recovering' }); h.feedback.refuse();
    assert.match(h.spoken.at(-1), /lost graphics/);
    h.setState({ status: 'ready', contextLost: true }); h.feedback.refuse();
    assert.match(h.spoken.at(-1), /lost graphics/);
  });
}

test('analog thresholds and emulated-position translation guards still apply after recovery', () => {
  const h = harness('left');
  h.frame({ value: .69 }); assert.equal(h.spoken.length, 0);
  h.frame({ value: .7 }); assert.equal(h.spoken.length, 1);
  h.setState({ status: 'mutating', contextLost: false });
  h.frame({ value: .4, quality: 'emulated-position' });
  h.frame({ value: .4, quality: 'emulated-position', z: .05 });
  assert.equal(h.starts.length, 1, 'busy mutation admits a still-held analog grip');
  assert.equal(h.deltas.length, 0, 'emulated position never supplies depth travel');
  h.frame({ value: .4, z: .06 }); h.frame({ value: .4, z: .08 });
  assert.ok(Math.abs(h.deltas.at(-1).translation[2] - .05) < 1e-10);
  h.frame({ value: .34, z: .08 }); assert.equal(h.ends.length, 1);
});

test('unavailable speech does not throw or retry the same fault', async () => {
  for (const speak of [() => { throw Error('offline'); }, () => Promise.reject(Error('offline'))]) {
    const feedback = createXrGrabFeedback({ readState: () => ({ status: 'error' }), speak });
    assert.equal(feedback.refuse(), true); assert.equal(feedback.refuse(), false);
  }
  await Promise.resolve();
});

test('fault diagnostics redact credential-bearing runtime URLs before bounding the message', () => {
  const records = [];
  const state = { status: 'error', error: 'Load https://host/viewer?token=secret#pair=private failed (wss://host/ws?secret=value) ' + 'x'.repeat(600) };
  const feedback = createXrGrabFeedback({ readState: () => state, speak() {}, record: (kind, detail) => records.push({ kind, detail }) });
  feedback.refuse();
  assert.equal(records[0].detail.error.length, 500);
  assert.match(records[0].detail.error, /^Load <runtime> failed \(<runtime>\)/);
  assert.doesNotMatch(JSON.stringify(records), /secret|private|https:|wss:|host/);
  state.error = state.error.replace('secret#pair=private', 'different#pair=new');
  assert.equal(feedback.refuse(), false, 'changing only runtime credentials does not repeat the same failure');
});
