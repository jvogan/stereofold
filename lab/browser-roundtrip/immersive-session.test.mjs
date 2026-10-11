import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { trackXrFrames } from './xr-frame-lifetime.mjs';
import { virtualClock } from './fixtures/virtual-clock.mjs';

const source = readFileSync(new URL('./immersive-session.mjs', import.meta.url), 'utf8');
function functionSource(name, indent = '') {
  const prefix = source.includes(`\n${indent}async function ${name}(`) ? 'async ' : '';
  const start = source.indexOf(`\n${indent}${prefix}function ${name}(`);
  assert.ok(start >= 0, `missing ${name}`);
  return source.slice(start, source.indexOf(`\n${indent}}`, start) + indent.length + 2);
}

for (const hung of ['capture', 'voice', 'reply', 'all']) {
  test(`restore bounds a never-settling ${hung} finalizer and releases the preview/session`, async () => {
    const clock = virtualClock();
    const calls = [], diagnostics = [];
    const release = resource => () => {
      calls.push(resource);
      return hung === resource || hung === 'all' ? new Promise(() => {}) : Promise.resolve();
    };
    const session = { requestAnimationFrame() {}, removeEventListener() {} };
    const record = { session, space: {}, sessionClosed: true, ending: true,
      loopStopped: true, frames: trackXrFrames(session),
      pushToTalk: { dispose: release('capture') }, presentedRebuild: Promise.resolve() };
    const context = vm.createContext({
      ...clock, record,
      sessionVisibility: 'visible', toolbarRepresentationCount: 0, outcomeRepresentationCount: 0,
      outcomeLineText: '', cancelOutcomeHold() {}, reportPresentationRepresentationCount() {},
      releasePushToTalkMicrophone() { calls.push('microphone'); },
      getVoiceInteraction: () => ({ release: release('voice') }),
      __stereofoldReplyAudio: { release: release('reply') },
      __stereofoldDiagnostics: { record: (kind, data) => diagnostics.push({ kind, ...data }) },
      canvas: { pause() {}, requestResize() {}, requestDraw() {},
        webgl: { xr: {} }, xr: { isPresenting: { value: false } } },
      plugin: { animationLoop: { start() { calls.push('desktop'); } } },
      removeOutcome: async () => {}, onLeavingPresentation: async () => { calls.push('preview'); },
      entering: false, disposed: false, canResumeDesktop: () => true, reloadRequired: false,
    });
    // Strict VM: execute the complete production restore closure and its real
    // timeout helper, with every external binding explicit (no proxy fallback).
    // Accelerate the appearance deadline for deliberately hung fault injection.
    const constants = source.match(/^const \w+_TIMEOUT_MS = [\d_]+;/gm).join('\n').replace(/const APPEARANCE_TIMEOUT_MS = [\d_]+;/, 'const APPEARANCE_TIMEOUT_MS = 300;');
    vm.runInContext(`'use strict';\n${constants}\n${functionSource('xrTimeout')}\n${functionSource('withTimeout')}\n${functionSource('restore', '  ')}`, context);
    let settled = false;
    const restoring = vm.runInContext('restore(record)', context).then(() => { settled = true; });
    const budget = hung === 'all' ? 600 : 300;
    await clock.advance(budget - 1);
    assert.equal(settled, false, 'the hung finalizer must remain pending before its deadline');
    await clock.advance(1);
    assert.equal(settled, true, 'exit must settle within the 600 ms combined finalizer budget');
    await restoring;
    assert.equal(clock.pending(), 0);
    assert.deepEqual(calls, ['capture', 'microphone', 'voice', 'reply', 'desktop', 'preview']);
    assert.equal(record.session, undefined);
    assert.equal(record.space, undefined);
    assert.deepEqual(record.frames.snapshot(), { pendingFrames: 0, sessionHeld: false });
    const cleanup = diagnostics.find(row => row.kind === 'xr-session-cleanup');
    assert.equal(cleanup.recordSessionHeld, false);
    assert.deepEqual(Array.from(cleanup.cleanupNotes, row => row.resource),
      hung === 'all' ? ['capture', 'voice', 'reply'] : [hung]);
    assert.ok(cleanup.cleanupNotes.every(row => row.code === 'xr_finalizer_timeout'));
    assert.equal(cleanup.audioReleaseFailures, hung === 'all' ? 2 : hung === 'capture' ? 0 : 1);
  });
}

for (const failure of ['presented-rebuild', 'leaving-presentation', 'leaving-throws']) {
  test(`restore completes appearance cleanup when ${failure} fails`, async () => {
    const clock = virtualClock();
    const calls = [], diagnostics = [];
    const session = { requestAnimationFrame() {}, removeEventListener() {} };
    const record = { session, space: {}, sessionClosed: true, ending: true,
      loopStopped: true, frames: trackXrFrames(session),
      presentedRebuild: failure === 'presented-rebuild' ? new Promise(() => {}) : Promise.resolve() };
    const context = vm.createContext({
      ...clock, record,
      sessionVisibility: 'visible', toolbarRepresentationCount: 0, outcomeRepresentationCount: 0,
      outcomeLineText: '', cancelOutcomeHold() {}, reportPresentationRepresentationCount() {},
      releasePushToTalkMicrophone() {}, getVoiceInteraction: () => undefined,
      __stereofoldDiagnostics: { record: (kind, data) => diagnostics.push({ kind, ...data }) },
      canvas: { pause() { calls.push('pause'); }, requestResize() {}, requestDraw() {},
        webgl: { xr: {} }, xr: { isPresenting: { value: false } } },
      plugin: { animationLoop: { start() { calls.push('desktop'); } } },
      removeOutcome: async () => {},
      onLeavingPresentation() {
        calls.push('preview');
        if (failure === 'leaving-throws') throw Error('appearance restore failed');
        if (failure === 'leaving-presentation') return new Promise(() => {});
        return Promise.resolve();
      },
      entering: false, disposed: false, canResumeDesktop: () => true, reloadRequired: false,
    });
    // Accelerate the appearance deadline for deliberately hung fault injection.
    const constants = source.match(/^const \w+_TIMEOUT_MS = [\d_]+;/gm).join('\n').replace(/const APPEARANCE_TIMEOUT_MS = [\d_]+;/, 'const APPEARANCE_TIMEOUT_MS = 300;');
    vm.runInContext(`'use strict';\n${constants}\n${functionSource('xrTimeout')}\n${functionSource('withTimeout')}\n${functionSource('restore', '  ')}`, context);
    let settled = false;
    const restoring = vm.runInContext('restore(record)', context).then(() => { settled = true; });
    await clock.advance(300);
    assert.equal(settled, true, 'one failed appearance finalizer gets 300 ms of virtual time');
    await restoring;
    assert.equal(clock.pending(), 0);
    assert.deepEqual(calls, ['pause', 'desktop', 'preview'], 'preview restoration must be attempted within the bound');
    assert.equal(record.session, undefined, 'cleanup must release the native session within the bound');
    assert.equal(record.space, undefined);
    assert.deepEqual(record.frames.snapshot(), { pendingFrames: 0, sessionHeld: false });
    const cleanup = diagnostics.find(row => row.kind === 'xr-session-cleanup');
    assert.ok(cleanup, 'cleanup diagnostics must be recorded within the bound');
    assert.equal(cleanup.recordSessionHeld, false);
    assert.deepEqual(Array.from(cleanup.cleanupNotes ?? [], row => ({ ...row })), [{
      resource: failure === 'presented-rebuild' ? failure : 'leaving-presentation',
      code: failure === 'leaving-throws' ? 'xr_finalizer_error' : 'xr_finalizer_timeout',
      error: failure === 'leaving-throws' ? 'appearance restore failed' : `Timed out releasing ${failure}.`,
    }]);
  });
}

for (const failure of ['none', 'presented-rebuild', 'leaving-presentation', 'leaving-throws']) {
  test(`failed mode switch restores the preview (appearance failure: ${failure})`, async () => {
    const clock = virtualClock();
    const calls = [], diagnostics = [];
    const session = { requestAnimationFrame() {}, removeEventListener() {} };
    const record = { mode: 'immersive-ar', session, space: {}, sessionClosed: true, ending: true,
      loopStopped: true, frames: trackXrFrames(session),
      presentedRebuild: failure === 'presented-rebuild' ? new Promise(() => {}) : Promise.resolve() };
    const context = vm.createContext({
      ...clock, record, active: record, pendingEntry: null,
      MODES: new Map([['immersive-vr', 'immersive-vr']]),
      activationState: () => false, liveBlendMode: () => 'alpha-blend', entryRefusalReason: () => 'activation',
      async end() {
        calls.push('end');
        context.active = undefined;
        await vm.runInContext('restore(record)', context);
      },
      async enter() { calls.push('replacement'); throw Error('User activation required'); },
      sessionVisibility: 'visible', toolbarRepresentationCount: 0, outcomeRepresentationCount: 0,
      outcomeLineText: '', cancelOutcomeHold() {}, reportPresentationRepresentationCount() {},
      releasePushToTalkMicrophone() {}, getVoiceInteraction: () => undefined,
      __stereofoldDiagnostics: { record: (kind, data) => diagnostics.push({ kind, ...data }) },
      canvas: { pause() { calls.push('pause'); }, requestResize() {}, requestDraw() {},
        webgl: { xr: {} }, xr: { isPresenting: { value: false } } },
      plugin: { animationLoop: { start() { calls.push('desktop'); } } },
      removeOutcome: async () => {},
      onLeavingPresentation() {
        calls.push('preview');
        if (failure === 'leaving-throws') throw Error('appearance restore failed');
        if (failure === 'leaving-presentation') return new Promise(() => {});
        return Promise.resolve();
      },
      entering: false, disposed: false, canResumeDesktop: () => true, reloadRequired: false,
    });
    // Accelerate the appearance deadline for deliberately hung fault injection.
    const constants = source.match(/^const \w+_TIMEOUT_MS = [\d_]+;/gm).join('\n').replace(/const APPEARANCE_TIMEOUT_MS = [\d_]+;/, 'const APPEARANCE_TIMEOUT_MS = 300;');
    vm.runInContext(`'use strict';\n${constants}\n${functionSource('xrTimeout')}\n${functionSource('withTimeout')}\n${functionSource('restore', '  ')}\n${functionSource('switchMode', '  ')}`, context);
    let result;
    const switching = vm.runInContext("switchMode('immersive-vr')", context).then(value => { result = value; });
    await clock.advance(300);
    assert.equal(result?.entered, false, 'failed replacement must settle within the finalizer budget');
    await switching;
    assert.equal(clock.pending(), 0);
    assert.deepEqual(calls, ['end', 'pause', 'desktop', 'replacement', 'preview']);
    assert.equal(record.switching, false);
    assert.equal(record.session, undefined);
    assert.equal(record.space, undefined);
    assert.deepEqual(record.frames.snapshot(), { pendingFrames: 0, sessionHeld: false });
    assert.equal(context.pendingEntry.reason, 'activation');
    const cleanup = diagnostics.at(-1);
    assert.equal(cleanup?.kind, 'xr-session-cleanup');
    assert.equal(cleanup.recordSessionHeld, false);
    assert.deepEqual(Array.from(cleanup.cleanupNotes ?? [], row => ({ ...row })), failure === 'none' ? [] : [{
      resource: failure === 'presented-rebuild' ? failure : 'leaving-presentation',
      code: failure === 'leaving-throws' ? 'xr_finalizer_error' : 'xr_finalizer_timeout',
      error: failure === 'leaving-throws' ? 'appearance restore failed' : `Timed out releasing ${failure}.`,
    }]);
  });
}

test('throwing auxiliary frames are contained, reported once, and remaining handles cancel', () => {
  const pending = new Map(), cancelled = [], reports = [];
  let next = 0;
  const context = vm.createContext({
    __stereofoldDiagnostics: { record: (...args) => { reports.push(args); throw Error('diagnostic failed'); } },
  });
  vm.runInContext(`'use strict';\n${readFileSync(new URL('./xr-frame-lifetime.mjs', import.meta.url), 'utf8').replace('export function', 'function')}`, context);
  const session = {
    requestAnimationFrame(callback) { pending.set(++next, callback); return next; },
    cancelAnimationFrame(handle) {
      cancelled.push(handle); pending.delete(handle);
      if (handle === 3) throw Error('native cancellation failed');
    },
  };
  context.session = session;
  const frames = vm.runInContext('trackXrFrames(session)', context);
  session.requestAnimationFrame(() => { throw Error('auxiliary failed'); });
  session.requestAnimationFrame(() => { throw Error('auxiliary failed again'); });
  session.requestAnimationFrame(() => assert.fail('stale callback delivered'));
  session.requestAnimationFrame(() => assert.fail('stale callback delivered'));
  for (const handle of [1, 2]) {
    const callback = pending.get(handle); pending.delete(handle);
    assert.doesNotThrow(() => callback(0, {}));
  }
  assert.equal(reports.length, 1);
  assert.equal(reports[0][0], 'xr-frame-error');
  assert.equal(reports[0][1].phase, 'auxiliary');
  const stale = [...pending.values()];
  assert.doesNotThrow(() => frames.restore());
  assert.deepEqual(cancelled, [3, 4]);
  assert.equal(pending.size, 0);
  assert.equal(frames.snapshot().sessionHeld, false);
  for (const callback of stale) assert.doesNotThrow(() => callback(0, {}));
});

const exitRecording = JSON.parse(readFileSync(new URL('./fixtures/exit-acceptance-6.json', import.meta.url)));
for (const [index, path] of ['menu Exit', 'Mol* navigation', 'page hide', 'driver exit'].entries()) {
  test(`acceptance 6 ${path}: a resolved native end precedes its event without a second end call`, async () => {
    const probe = Object.values(exitRecording.exits)[index].sessions.at(-1);
    assert.equal(probe.endCalls, 2); assert.equal(probe.endError, 'InvalidStateError');
    let endCalls = 0;
    const session = { async end() {
      if (++endCalls > 1) throw Object.assign(Error('already ended'), { name: probe.endError });
      // The probe timestamps share a millisecond; the existing fixtures only
      // exercised the opposite ordering (end event before promise resolution).
    } };
    const record = { session, sessionClosed: false };
    const xr = { session, async end() { await session.end(); this.session = undefined; } };
    const context = vm.createContext({ record, active: record, reloadRequired: false,
      canvas: { pause() {}, webgl: { xr } }, restore: async () => {}, waitForPresentation: async () => {},
      setTimeout, clearTimeout });
    const constants = source.match(/^const \w+_TIMEOUT_MS = [\d_]+;/gm).join('\n');
    vm.runInContext(`'use strict';${constants}\n${functionSource('xrTimeout')}\n${functionSource('withTimeout')}\n${functionSource('closeNativeSession')}\n${functionSource('endRecord', '  ')}`, context);
    await vm.runInContext('endRecord(record)', context);
    assert.equal(endCalls, 1);
    assert.equal(record.sessionClosed, true);
  });
}

for (const recordingPath of ['seq2-reentry/ring-entryB-a.json', 'seq5-voice/08-open-molstar-drain-1.json']) {
test(`acceptance 6 cold desktop rebuild settles on both exits of one page (${recordingPath})`, async () => {
  const clock = virtualClock();
  const cold = exitRecording.rebuilds[recordingPath];
  assert.equal(cold[1].detail.cleanupNotes[0].resource, 'leaving-presentation');
  assert.ok(cold[2].at > cold[1].at, 'the real rebuild completed after the timeout');
  const diagnostics = [];
  let visits = 0;
  const context = vm.createContext({ ...clock,
    sessionVisibility: 'visible', toolbarRepresentationCount: 0, outcomeRepresentationCount: 0,
    outcomeLineText: '', cancelOutcomeHold() {}, reportPresentationRepresentationCount() {},
    releasePushToTalkMicrophone() {}, getVoiceInteraction: () => undefined,
    __stereofoldDiagnostics: { record: (kind, detail) => diagnostics.push({ kind, detail }) },
    canvas: { pause() {}, requestResize() {}, requestDraw() {}, webgl: { xr: {} }, xr: { isPresenting: { value: false } } },
    plugin: { animationLoop: { start() {} } }, removeOutcome: async () => {},
    onLeavingPresentation: () => new Promise(resolve => clock.setTimeout(resolve, visits++ === 0 ? cold[2].detail.totalMs : 1)),
    entering: false, disposed: false, canResumeDesktop: () => true, reloadRequired: false,
  });
  const constants = source.match(/^const \w+_TIMEOUT_MS = [\d_]+;/gm).join('\n');
  vm.runInContext(`'use strict';${constants}\n${functionSource('xrTimeout')}\n${functionSource('withTimeout')}\n${functionSource('restore', '  ')}`, context);
  for (let entry = 0; entry < 2; entry++) {
    const session = { requestAnimationFrame() {}, removeEventListener() {} };
    context.record = { session, sessionClosed: true, ending: true, loopStopped: true,
      frames: trackXrFrames(session), presentedRebuild: Promise.resolve() };
    let settled = false;
    const restoring = vm.runInContext('restore(record)', context).then(() => { settled = true; });
    await clock.advance(entry === 0 ? cold[2].detail.totalMs : 1);
    assert.equal(settled, true, 'the recorded rebuild duration must fit the production appearance deadline');
    await restoring;
    assert.equal(clock.pending(), 0);
    assert.deepEqual(Array.from(diagnostics.at(-1).detail.cleanupNotes ?? []), [], `exit ${entry + 1}`);
  }
});
}
