import { assistantStatus } from './assistant-status.mjs';
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { createConnectionWatchdog, connectionStatus, setConnectionStatus, markTalkLinkLost, LINK_LOST, TALK_LINK_LOST, PAIR_AGAIN } from './connection-liveness.mjs';
import { spatialToolbarRows } from './spatial-toolbar-content.mjs';
afterEach(() => setConnectionStatus());
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from '../../plugin/node_modules/typescript/lib/typescript.js';
import { createVoiceInteraction } from './voice-interaction.mjs';
import { setHeadsetCaptionSink } from './xr-manipulate.mjs';
import { attachGripPushToTalk, pushToTalkBinding } from './push-to-talk-grip.mjs';
import { createXrButtons, FACE_LOWER, TALK_MIN_HOLD_MS } from './xr-buttons.mjs';
import { captionText } from './talk-caption.mjs';

const root = new URL('../../', import.meta.url);
const source = path => readFileSync(new URL(path, root), 'utf8');
const compile = text => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS, alwaysStrict: true } }).outputText;
function functions(path, names) {
  const ast = ts.createSourceFile(path, source(path), ts.ScriptTarget.Latest, true);
  return names.map(name => {
    let node;
    const visit = child => { if (ts.isFunctionDeclaration(child) && child.name?.text === name) node = child;
      else ts.forEachChild(child, visit); };
    visit(ast);
    assert.ok(node, `Missing function ${name}`);
    return node.getText(ast);
  }).join('\n');
}

// Execute the real toolbar action queue. No GPU or XR socket is needed.
function menu(onAction) {
  const h = vm.createContext({ onAction, acceptsInput: () => true, actionEpoch: 0,
    actionChain: Promise.resolve(), nextXrTick: async () => true, session: {},
    onActionError: error => { throw error; }, unlatchSeat() {}, update: async () => {},
    wokenAt: 0, standingBack: false, engaged: false, setDimmed() {},
    notice: undefined, inputLocked: false, recordMenuMotion() {}, requestSeatSolve() {}, syncPlacementSeat() {} });
  vm.runInContext(functions('lab/browser-roundtrip/spatial-toolbar.mjs', ['run']), h);
  return { async press(action) { h.run(action); await h.actionChain; } };
}

function microphone(t, failure) {
  const originals = Object.getOwnPropertyDescriptors(globalThis);
  const set = (name, value) => Object.defineProperty(globalThis, name, { configurable: true, value });
  t.after(() => {
    for (const name of ['navigator', 'isSecureContext', 'AudioContext', 'SpeechRecognition', 'webkitSpeechRecognition']) {
      if (originals[name]) Object.defineProperty(globalThis, name, originals[name]);
      else Reflect.deleteProperty(globalThis, name);
    }
    setHeadsetCaptionSink(undefined);
  });
  let stopped = 0;
  const node = () => ({ connect() {}, disconnect() {} });
  set('SpeechRecognition', undefined); set('webkitSpeechRecognition', undefined);
  set('isSecureContext', true);
  set('AudioContext', class {
    sampleRate = 24000;
    createMediaStreamSource() { return node(); }
    createScriptProcessor() { return node(); }
    createGain() { return { ...node(), gain: { value: 0 } }; }
    async resume() {}
    async close() {}
  });
  set('navigator', { mediaDevices: failure === 'missing microphone' ? {} : {
    getUserMedia: async () => {
      if (failure) throw Object.assign(Error('Permission denied'), { name: 'NotAllowedError' });
      return { getTracks: () => [{ stop: () => stopped++ }] };
    },
  } });
  return { stopped: () => stopped };
}

for (const failure of ['missing microphone', 'denied microphone']) {
  test(`${failure} leaves Talk idle, gives a menu alternative, and permits reset`, async t => {
    microphone(t, failure);
    const captions = [], states = [];
    setHeadsetCaptionSink(text => captions.push(text));
    const interaction = createVoiceInteraction({ playback: { unlock() {}, play() {} },
      begin: () => assert.fail('Unavailable microphone must not contact the host'),
      onState: (phase, message) => states.push({ phase, message }) });
    t.after(() => interaction.dispose());
    let reset = 0;
    const controls = menu(action => action.kind === 'voice-toggle' ? interaction.toggle() : ++reset);
    await controls.press({ kind: 'voice-toggle' });
    assert.equal(interaction.state(), 'idle');
    assert.match(interaction.message(), /[Uu]se the menu/);
    assert.equal(captions.at(-1), interaction.message());
    assert.ok(interaction.message().split(/\s+/).length <= 12);
    assert.equal(states.at(-1).phase, 'idle');
    await controls.press({ kind: 'recenter-structure' });
    assert.equal(reset, 1, 'The next real menu action still runs');
  });
}

test('absent SpeechRecognition does not disable host-transcribed microphone capture', async t => {
  const mic = microphone(t);
  assert.equal(typeof globalThis.SpeechRecognition, 'undefined');
  const interaction = createVoiceInteraction({ playback: { unlock() {}, play() {} } });
  t.after(() => interaction.dispose());
  await interaction.start();
  assert.equal(interaction.state(), 'listening');
  await interaction.cancel();
  assert.equal(interaction.state(), 'idle');
  assert.equal(mic.stopped(), 1, 'The actual PCM capture releases the stream');
});

for (const route of ['shared', 'capture', 'stream']) {
  test(`denied ${route} push-to-talk retains its alternative after release and permits retry`, async t => {
    microphone(t, 'denied microphone');
    const captions = [], edges = [];
    let attempts = 0, stops = 0;
    const denied = async () => { attempts++; throw Object.assign(Error('Permission denied'), { name: 'NotAllowedError' }); };
    const capture = { start: denied, stop: async () => { stops++; } };
    const interaction = createVoiceInteraction({ capture, playback: { unlock() {}, play() {} } });
    const binding = attachGripPushToTalk({ session: new EventTarget(),
      send: async edge => { edges.push(edge); }, status: text => captions.push(text),
      ...(route === 'shared' ? { interaction } : route === 'capture' ? { capture } : { audio: capture }) });
    t.after(async () => { await binding.dispose(); await interaction.dispose(); });
    for (let press = 1; press <= 2; press++) {
      await Promise.resolve(binding.start()).catch(() => {});
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(binding.listening(), false, 'A denied microphone cannot retain the hold');
      assert.equal(attempts, press);
      if (route === 'capture') assert.equal(stops, press, 'Failed capture startup releases resources');
      await binding.stop();
      await new Promise(resolve => setImmediate(resolve));
      assert.match(captions.at(-1), /[Uu]se the menu/);
      assert.ok(captions.at(-1).split(/\s+/).length <= 12);
    }
    assert.deepEqual(edges, ['down', 'up', 'down', 'up']);
  });
}

for (const failure of ['denied microphone', 'missing microphone', 'missing binding']) {
  test(`XR release after ${failure} clears sending and shows menu recovery`, async t => {
    microphone(t, failure);
    const state = { talking: false, sending: false, outcome: '' }, edges = [], dispatches = [];
    const talkCaption = { set: next => Object.assign(state, next) };
    const interaction = createVoiceInteraction({ playback: { unlock() {}, play() {} } });
    const binding = failure === 'missing binding' ? undefined : attachGripPushToTalk({
      session: new EventTarget(), interaction,
      send: async edge => { edges.push(edge); },
      status: outcome => talkCaption.set({ talking: false, sending: false, outcome }),
    });
    t.after(async () => { await binding?.dispose(); await interaction.dispose(); });
    let now = 0;
    const h = vm.createContext({ pushToTalkBinding, talkCaption, xrButtons: undefined,
      createXrButtons: options => createXrButtons({ ...options, now: () => now }),
      pulseController() {}, xrInputSourceFor() {}, onLocalEdit() {},
      recordManipulation: (_kind, detail) => dispatches.push(detail),
    });
    const viewer = source('lab/browser-roundtrip/viewer.mjs');
    const start = viewer.indexOf('xrButtons = createXrButtons({');
    assert.ok(start >= 0, 'The viewer installs the XR face-button binding');
    vm.runInContext(functions('lab/browser-roundtrip/viewer.mjs', ['runFaceAction'])
      + '\n' + viewer.slice(start, viewer.indexOf('\n    });', start) + '\n    });'.length), h);
    h.xrButtons.update([{ handedness: 'right', buttons: FACE_LOWER }]);
    now = TALK_MIN_HOLD_MS;
    h.xrButtons.update([{ handedness: 'right', buttons: FACE_LOWER }]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(binding?.listening() ?? false, false, 'Unavailable capture has released its hold before XR release');
    h.xrButtons.update([{ handedness: 'right', buttons: 0 }]);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(dispatches.some(entry => entry.action === 'push-to-talk' && entry.phase === 'up'),
      'The real XR binding dispatches release');
    assert.equal(state.sending, false, 'XR release after unavailable capture must clear sending');
    assert.equal(state.talking, false);
    assert.equal(captionText(state), 'Voice unavailable. Use the menu controls instead.',
      'XR release must show menu recovery instead of Sending…');
    assert.ok(captionText(state).split(/\s+/).length <= 12);
    assert.deepEqual(edges, binding ? ['down', 'up'] : []);
  });
}

function page(responses, { dirty = false } = {}) {
  const captions = [], timers = [], mutations = [], cancelledTimers = new Set();
  const realNow = Date.now, clock = {};
  const scene = { molecule: 'fixture', selection: [1], camera: [0, 0, 5] };
  const binding = { sessionId: 'session', sourceToken: 'source', serverEpoch: 'epoch', stateRevision: 1, inspectionRevision: 1 };
  const blank = () => ({ hidden: true, textContent: '' });
  const h = vm.createContext({ failedSourceLoad:undefined, experiencePreparing:false, pollInFlight:false, beatInFlight:false, beatCompletion:undefined, desktopReceiptInFlight:false, desktopReceiptBeat:undefined, repairNeeded:false, nextRepairAt:0, connectionWatchdog:undefined, clearTimeout(id) { cancelledTimers.add(id); },
    connectionStatus, setConnectionStatus, LINK_LOST, PAIR_AGAIN, recoverCompanionConnection:async()=>false, registerComparisonSources:async sources=>{assert.equal(sources,undefined);}, exports: {}, Error, AbortSignal, AbortController, Response,
    readPageKey: () => ({ key: 'a'.repeat(64) }),
    fetch: async () => { const next = responses.shift(); if (next instanceof Error) throw next;
      return next ?? Response.json({ structuredContent: { ...binding, attached: true } }); },
    setTimeout: fn => { timers.push(fn); return timers.length; },
    closed: false, generation: 1, blocked: false, dirty, pendingReceipt: undefined, saveAttempts: 0,
    problemRetryKind: 'save', PRIVATE_KEY: 'stereo_structure/inspection',
    loading: false, remote: false, isCompanion: true, panelId: 'panel', binding,
    // The caption plate holds a delivered reply until a drop
    // outlives the heartbeat deadline, so these functions read a clock. `clock`
    // is the seam; unset means real time.
    clock, Date: { now: () => clock.value ?? realNow() },
    connectionNotice: false, connectionRecoveryLine: '', connectionTroubleSince: 0, LINK_LOSS_CAPTION_MS: 8_000,
    notice: blank(), message: blank(),
    details: blank(), detailsText: blank(), retry: blank(), reload: blank(), pairAgain: blank(),
    retryHydrationId: undefined, loadErrorDetails: '', requestedId: 'session',
    workspace: { snapshot: () => ({ ready: true, interactionActive: false, xrPresenting: true }),
      capture: () => scene, serializeCapture() { return JSON.stringify(this.capture()); }, viewer: { xr: {} },
      restoreShared: () => mutations.push('restore'), setStatus: () => mutations.push('status') },
    savedScene: scene, document: { body: { dataset: {} } },
    expected: () => binding, syncHandoff() {}, liveAvailability: () => 'ready', tourHeartbeat: () => ({}),
    tourPlayer: undefined, panelTour: undefined, experiencePlayer: undefined, xrStartupReport: () => ({}), showOutcome() {}, retireStaleHud() {},
    isRendererHeartbeatFailure: () => false, noteRendererHeartbeat() {}, noteAgentPresence() {}, assistantStatus,
    voiceBindingKey: () => '', voiceReadyBinding: '', replyOnThisBeat: false, experienceView: undefined,
    receiveSpokenReply() {}, handoffSpokenRequest() {}, followsSourceTransition: () => false,
    save: async () => {}, scheduleSave: () => mutations.push('save'),
    attach: () => mutations.push('attach'), hydrate: () => mutations.push('hydrate'),
    showHeadsetCaption: text => { captions.push(text); return true; }, pollTimer: undefined,
  });
  vm.runInContext(compile(source('plugin/src/inspection-poll-backoff.ts')), h);
  h.pollBackoff = h.exports.createPollBackoff(() => h.Date.now(), () => 0.5);
  vm.runInContext(compile(source('plugin/src/inspection-save-retry.ts')), h);
  h.saveRetryAdmission = h.exports.createSaveRetryAdmission(() => clock.value ?? realNow());
  const client = source('plugin/src/inspection-companion-client.ts').replace(/^import .*;\n/gm, '');
  vm.runInContext(compile(client), h);
  vm.runInContext(compile(source('plugin/src/companion-startup.ts')), h);
  vm.runInContext(compile(functions('plugin/src/tool-result.ts', ['thrownErrorMessage'])), h);
  vm.runInContext(compile(functions('plugin/src/inspection-page-key.ts', ['keepPageKey'])), h);
  h.recoverCompanionConnection = h.exports.recoverCompanionConnection;
  h.call = h.exports.createCompanionClient();
  vm.runInContext(compile(functions('plugin/src/inspector.ts',
    // `poll` arms its own next tick and hands a beat it cannot
    // serve to `busyBeat`, so both travel with it.
    ['showProblem', 'showConnectionProblem', 'clearConnectionProblem', 'beatSuspended', 'registerPollState', 'receivePollDelivery', 'busyBeat', 'armPoll', 'problemMessage', 'poll'])), h);
  return { h, captions, timers, cancelledTimers, mutations, scene, clock };
}

test('inspector slice rejects undeclared module state in strict mode', () => {
  const p = page([]);
  Reflect.deleteProperty(p.h, 'problemRetryKind');
  assert.throws(() => p.h.showProblem('Retry poll.', 'poll'), /problemRetryKind is not defined/);
});

for (const status of [401, 410, 409]) {
  test(`expired share (${status}) keeps the scene editable and tells both displays to reopen sharing`, async () => {
    const body = { error: 'request_failed', message: 'Stereofold session was not found or has expired.' };
    const p = page([Response.json(body, { status })]);
    const before = structuredClone(p.scene);
    await p.h.poll();
    assert.equal(p.h.blocked, false, 'Expired capability must not block local controls');
    assert.match(p.h.message.textContent, status === 409 ? /Reopen the structure.*share again/ : /Reopen sharing/);
    assert.equal(p.captions.length, 0, 'Link state must not overwrite a pending scientific answer');
    assert.equal(captionText(), status===409?PAIR_AGAIN:LINK_LOST, 'The caption renderer can read the persistent recovery state');
    assert.deepEqual(p.scene, before);
    assert.deepEqual(p.mutations, [], 'No reload, scene restore, or save occurs');
    p.scene.selection = [2];
    assert.deepEqual(p.h.workspace.capture().selection, [2]);
    assert.equal(p.timers.length, 1, 'Heartbeat remains scheduled');
  });
}

test('disconnect preserves unsaved work and pending captions, and resumes polling', async () => {
  const p = page([new TypeError('Network unavailable'), new TypeError('Network unavailable')], { dirty: true });
  const before = structuredClone(p.scene);
  // The plate is where a delivered reply sits, and one failed
  // beat is not a lost link. Connection state is rendered as a brief warning
  // by the caption card, never pushed as a replacement scientific answer.
  p.clock.value = 1_000_000;
  await p.h.poll();
  assert.equal(p.captions.length, 0, 'A drop shorter than the heartbeat deadline keeps the wearer’s answer');
  p.clock.value = 1_008_000;
  await p.h.poll();
  assert.equal(p.h.blocked, false);
  assert.equal(p.h.dirty, true);
  assert.equal(p.captions.length, 0, 'Repeated retries must not replace the pending answer');
  assert.equal(connectionStatus().line, LINK_LOST);
  assert.doesNotMatch(LINK_LOST, /reconnecting/i);
  assert.equal(p.h.pairAgain.hidden, false, 'Disconnected companions offer explicit re-pairing');
  for (const line of [p.h.message.textContent, ...p.captions]) {
    assert.ok(line.trim().split(/\s+/).length <= 12, `Disconnect line exceeds twelve words: ${line}`);
  }
  p.clock.value += p.h.pollBackoff.remaining();
  await p.h.poll();
  assert.equal(p.h.notice.hidden, true);
  assert.equal(p.h.pairAgain.hidden, true, 'Successful polling retires the recovery action');
  assert.deepEqual(p.scene, before);
  assert.deepEqual(p.mutations, []);
  assert.equal(p.timers.length, 5, 'Each failed beat replaces its initial timer with the bounded backoff');
  assert.equal(p.cancelledTimers.size, 4, 'Only the latest polling timer remains active');
});

test('host restart changes a dropped socket into an actionable rejected old share', async () => {
  const p = page([new TypeError('Network unavailable'), new Response('', { status: 401 })]);
  p.clock.value = 1_000_000;
  await p.h.poll();
  const statuses = [p.h.message.textContent];
  p.clock.value += p.h.pollBackoff.remaining();
  await p.h.poll();
  statuses.push(p.h.message.textContent);
  assert.equal(p.h.blocked, false);
  // This used to put "Reconnecting" on the plate first and
  // the real answer second. The dropped socket lasted one beat, so it never
  // earns the plate; the share that has actually gone is terminal and takes it
  // straight away. The 2D notice still carries both lines in order.
  assert.deepEqual(statuses.map(line => /use Pair again/.test(line)), [true, false]);
  assert.ok(statuses.every(line => !/reconnecting/i.test(line)));
  assert.equal(p.captions.length, 0, 'The card reads persistent recovery state without replacing an answer');
  assert.equal(captionText(), LINK_LOST);
  for (const line of [...statuses, ...p.captions]) {
    assert.ok(line.trim().split(/\s+/).length <= 12, `Restart line exceeds twelve words: ${line}`);
  }
  assert.deepEqual(p.mutations, []);
  assert.equal(p.timers.length, 3, 'The dropped beat rearms once with backoff');
  assert.equal(p.cancelledTimers.size, 2, 'Only the latest polling timer remains active');
});

test('a restarted host leaves the existing desktop scene locally editable', async () => {
  const p = page([]);
  p.h.isCompanion = false;
  p.h.app = { getHostCapabilities: () => ({}) };
  p.h.call = async () => { throw Error('Stereofold session was not found or has expired.'); };
  await p.h.poll();
  assert.equal(p.h.blocked, false);
  assert.match(p.h.message.textContent, /Reopen the structure.*share again/);
  for (const line of [p.h.message.textContent, ...p.captions]) {
    assert.ok(line.trim().split(/\s+/).length <= 12, `Desktop restart line exceeds twelve words: ${line}`);
  }
  assert.deepEqual(p.mutations, []);
  let resets = 0;
  const controls = menu(() => { p.scene.camera = [0, 0, 10]; resets++; });
  await controls.press({ kind: 'recenter-structure' });
  assert.equal(resets, 1);
  assert.deepEqual(p.h.workspace.capture().camera, [0, 0, 10]);
});

test('late failures and unrelated refusals cannot replace the current recovery notice', () => {
  const p = page([]);
  assert.equal(p.h.showConnectionProblem({ code: 'companion_expired' }, 0), true);
  assert.deepEqual(p.captions, []);
  assert.equal(p.h.showConnectionProblem({ code: 'companion_request', status: 409,
    message: 'The panel is busy.' }, 1), false);
  assert.deepEqual(p.captions, []);
});

// Parent baseline: 25f6744's test fails on 25f6744~1 at its line 290
// exact-status assertion: parent inspector.ts:1599 emits the old thirteen-word
// "Tool control is paused; your visible view is preserved" guidance.
// The replacement behavior itself is also covered by mutation testing.
test('poll replaces an expired-share notice with a subsequent busy refusal', async () => {
  const p = page([new Response('', { status: 401 }),
    Response.json({ error: 'request_failed', message: 'The panel is busy.' }, { status: 409 })]);
  const before = structuredClone(p.scene);
  await p.h.poll();
  assert.equal(p.h.connectionNotice, true);
  assert.equal(p.h.blocked, false);
  assert.match(p.h.message.textContent, /Reopen sharing.*new link/);
  assert.equal(p.captions.length, 0, 'Recovery guidance stays in link state and the flat notice');
  const statuses = [p.h.message.textContent];
  await p.h.poll();
  assert.equal(p.h.message.textContent,
    'Your view is preserved; choose Retry.',
    'A busy poll must replace the expired-share notice with refusal guidance');
  statuses.push(p.h.message.textContent);
  // These recovery polls emit status and caption lines, with no spoken output.
  for (const line of [...statuses, ...p.captions]) {
    assert.ok(line.trim().split(/\s+/).length <= 12, `Recovery line exceeds twelve words: ${line}`);
  }
  assert.equal(p.h.connectionNotice, false);
  assert.equal(p.h.blocked, true);
  assert.equal(p.h.notice.hidden, false);
  assert.equal(p.h.retry.hidden, false);
  assert.equal(p.h.retry.textContent, 'Retry');
  assert.equal(p.h.reload.hidden, false);
  assert.deepEqual(p.scene, before);
  assert.deepEqual(p.mutations, []);
  assert.equal(p.timers.length, 2, 'Both real polls schedule the next heartbeat');
});

/**
 * A stalled request no longer silences the page.
 *
 * This test used to assert that one stalled `poll_inspection` suppressed every
 * frame tick behind it. That is what it did on hardware: on the second wearer
 * run the Mac watched `spatialContext.ageMs` climb from ten seconds to
 * forty-three while the headset held seventy frames a second, and every first
 * command after an utterance expired at its fifteen second deadline without the
 * page ever being offered it. The contract is now that the beat carries on —
 * bounded, never piled up: one full poll and at most one keep-alive beat.
 */
test('XR frames keep beats running while window timers are frozen, without piling up', async () => {
  const p = page([]);
  let at = Date.now(), calls = 0, outstanding = 0, peak = 0, aborted = 0;
  p.h.Date = class extends Date { static now() { return at; } };
  p.h.fetch = (_url, { signal }) => {
    calls++;outstanding++;peak = Math.max(peak, outstanding);
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
      outstanding--;aborted++;
      reject(Object.assign(Error('Request timed out'), { name: 'AbortError' }));
    }, { once: true }));
  };
  const watcher = createConnectionWatchdog({ now: () => at, poll: () => p.h.poll(),
    deadlines: () => p.h.exports.companionConnectionFrame(at),
    onMissed: () => p.h.showConnectionProblem({ code: 'companion_connection' }, 1) });
  p.h.connectionWatchdog = watcher;
  watcher.frame();
  for (let i = 0; i < 14; i++) { at += 1000;watcher.frame();await new Promise(resolve => setImmediate(resolve)); }
  assert.ok(calls > 1, 'A stalled request must not take the page off the air');
  assert.equal(peak, 2, 'One full poll and one keep-alive beat at most, never a pile-up');
  const before = calls;
  at += 1000;watcher.frame();
  assert.equal(captionText({ talking: true, progress: 'Listening…' }), LINK_LOST);
  await new Promise(resolve => setImmediate(resolve));
  // No window timer has run: `page()` collects them and never fires them. Every
  // request here was started and every stalled one retired by the XR clock.
  assert.ok(aborted >= 1, 'The XR clock retires a stalled request without a window timer');
  assert.equal(p.h.blocked, false);
  p.h.fetch = async () => { calls++;return Response.json({ structuredContent: { ...p.h.binding, attached: true } }); };
  // The two requests still outstanding hold their guards until the XR clock
  // reaches their own deadlines; the beat resumes as soon as it does.
  for (let i = 0; i < 10; i++) { at += 1000;watcher.frame();await new Promise(resolve => setImmediate(resolve)); }
  assert.ok(calls > before, 'The beat resumes once the stalled requests retire');
  assert.equal(connectionStatus().line, '', 'Only the successful beat clears the warning');
  assert.deepEqual(p.mutations, []);
  const settled = calls;
  watcher.dispose();at += 1000;watcher.frame();assert.equal(calls, settled);
});

test('remembered redemption replaces the bearer without reloading or changing the local scene', async () => {
  const token = 'b'.repeat(64), requests = [], stored = [];
  const p = page([new Response('', { status: 401 }), Response.json({ token })], { dirty: true });
  p.h.localStorage = { getItem: () => JSON.stringify({ deviceId: 'd'.repeat(32), deviceKey: 'e'.repeat(64) }) };
  p.h.sessionStorage = { setItem: (...args) => stored.push(args) };
  const fetch = p.h.fetch;
  p.h.fetch = (url, init) => { requests.push({ url, ...init });return fetch(url, init); };
  const before = structuredClone(p.scene);
  await p.h.poll();
  assert.equal(connectionStatus().line, LINK_LOST);
  await p.h.poll();
  assert.deepEqual(requests.map(r => r.url), ['/tool', '/pair', '/tool']);
  assert.equal(requests[0].headers.authorization, `Bearer ${'a'.repeat(64)}`);
  assert.equal(requests[2].headers.authorization, `Bearer ${token}`);
  assert.deepEqual(stored, [['stereo_structure/page-key', token]]);
  assert.equal(connectionStatus().line, '');
  assert.equal(p.h.dirty, true);
  assert.deepEqual(p.scene, before);
  assert.deepEqual(p.mutations, []);
});

test('a missing remembered device offers consent-based Pair again in XR and explains re-entry', async () => {
  const p = page([new Response('', { status: 401 }), new Response('', { status: 401 })]);
  await p.h.poll();await p.h.poll();
  assert.equal(captionText(), PAIR_AGAIN);
  const rows = spatialToolbarRows({ voice: { state: 'listening' }, connection: connectionStatus() });
  assert.ok(rows.some(row => row.label === 'No link' && row.state));
  assert.ok(rows.some(row => row.label === 'Re-pair' && row.action.kind === 'reconnect' && !row.state));
  assert.deepEqual(p.mutations, [], 'No automatic navigation discards the offline scene');
});

for (const edge of ['down', 'up']) {
  test(`failed PTT ${edge} stays on the plate and Talk row until a successful beat`, async t => {
    const p = page([]), captions = [], edges = [];
    const interaction = { start: async () => {}, stop: async () => {}, cancel: async () => {} };
    const binding = attachGripPushToTalk({ session: new EventTarget(), interaction,
      send: async state => { edges.push(state);if (state === edge) throw Error('Disconnected'); },
      status: text => captions.push(text) });
    t.after(() => binding.dispose());
    await binding.start();await new Promise(resolve => setImmediate(resolve));
    await binding.stop();await new Promise(resolve => setImmediate(resolve));
    assert.equal(binding.listening(), false);
    assert.equal(captions.at(-1), TALK_LINK_LOST);
    assert.match(captionText({ talking: true, sending: true, notice: 'other notice' }), /No link · not listening/);
    const row = spatialToolbarRows({ voice: { state: 'listening' }, connection: connectionStatus() })[0];
    assert.equal(row.label, 'No link');assert.equal(row.state, true);
    await binding.start();await new Promise(resolve => setImmediate(resolve));
    assert.equal(edges.filter(value => value === 'down').length, 1, 'Offline presses cannot reopen capture');
    await p.h.poll();
    assert.equal(connectionStatus().line, '');
    assert.equal(spatialToolbarRows({ voice: { state: 'idle' }, connection: connectionStatus() })[0].label, 'Talk');
  });
}

test('a failed PTT down cancels a late microphone start even after heartbeat recovery', async t => {
  const p = page([]);
  let finish, starts = 0, cancelled = 0;
  const interaction = { start: () => { starts++;return new Promise(resolve => { finish=resolve; }); },
    stop: async () => {}, cancel: async () => { cancelled++; } };
  const binding = attachGripPushToTalk({ session:new EventTarget(), interaction,
    send:async()=>{throw Error('No connection');} });
  t.after(()=>binding.dispose());
  await binding.start();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(binding.listening(),false);
  await p.h.poll();
  assert.equal(connectionStatus().line,'');
  await binding.start();
  assert.equal(starts,1,'A still-opening cancelled microphone cannot overlap another capture');
  finish();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(cancelled,2,'Stop immediately and again when the delayed stream actually opens');
  assert.equal(binding.listening(),false);
});

test('persistent connection changes notify the menu once per edge and detach cleanly', async () => {
  const { subscribeConnectionStatus } = await import('./connection-liveness.mjs');
  const drawn = [];
  const stop = subscribeConnectionStatus(() => drawn.push(spatialToolbarRows({ voice: { state: 'idle' }, connection: connectionStatus() })[0].label));
  setConnectionStatus(LINK_LOST);setConnectionStatus(LINK_LOST);
  markTalkLinkLost();markTalkLinkLost();
  setConnectionStatus();setConnectionStatus();
  assert.deepEqual(drawn, ['No link', 'No link', 'Talk']);
  stop();setConnectionStatus(LINK_LOST);
  assert.equal(drawn.length,3);
});

/**
 * A Mac that stops answering, rather than refusing.
 *
 * The Quest 2 pass suspended the host for fifty-three seconds. The
 * Talk row read `Talk` throughout, the caption never changed, and the wearer
 * had no indication that the Mac was gone. An expired share already says so;
 * a host that answers nothing at all is the case this covers, and it is the
 * one a wearer cannot diagnose from inside the headset.
 *
 * Two rules ride with it. A stall is not an expired capability, so it must
 * never redeem the remembered device — An earlier run’s 401/410 rule in the other
 * direction. And the line is one edge, not a cycle: an earlier defect was a Talk
 * row that flapped on a fixed timer.
 */
test('a suspended host turns the Talk row and the caption to lost link, and one beat reverts both', async () => {
  const p = page([]);
  let at = Date.now(), pairs = 0, missed = 0;
  p.h.Date = class extends Date { static now() { return at; } };
  const stall = (url, { signal }) => {
    if (String(url).includes('/pair')) pairs++;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
      reject(Object.assign(Error('Request timed out'), { name: 'AbortError' }));
    }, { once: true }));
  };
  p.h.fetch = stall;
  const ring = [];
  const watcher = createConnectionWatchdog({ now: () => at, poll: () => p.h.poll(),
    deadlines: () => p.h.exports.companionConnectionFrame(at),
    record: (kind, detail) => ring.push({ kind, detail }),
    onMissed: () => { missed++;p.h.showConnectionProblem({ code: 'companion_connection' }, 1); } });
  p.h.connectionWatchdog = watcher;
  const row = () => spatialToolbarRows({ voice: { state: 'idle' }, connection: connectionStatus() })[0].label;
  watcher.frame();
  assert.equal(row(), 'Talk', 'a live link says nothing about itself');
  for (let i = 0; i < 53; i++) { at += 1000;watcher.frame();await new Promise(resolve => setImmediate(resolve)); }
  assert.equal(connectionStatus().line, LINK_LOST);
  assert.equal(row(), 'No link', 'the Talk row carries the lost link');
  assert.equal(captionText({}), LINK_LOST, 'the caption carries the lost-link text');
  assert.equal(captionText({ talking: true, progress: 'Listening…' }), LINK_LOST,
    'link loss keeps priority over microphone progress');
  assert.equal(pairs, 0, 'a silent host is not an expired share, so nothing re-pairs');
  assert.equal(p.h.repairNeeded, false);
  const edges = missed;
  p.h.fetch = async () => Response.json({ structuredContent: { ...p.h.binding, attached: true } });
  for (let i = 0; i < 20; i++) { at += 1000;watcher.frame();await new Promise(resolve => setImmediate(resolve)); }
  assert.equal(connectionStatus().line, '', 'the first successful beat clears it');
  assert.equal(row(), 'Talk');
  assert.equal(captionText({}), '');
  assert.equal(pairs, 0);
  assert.equal(missed, edges, 'recovery raises no further missed-beat edge');
  // An earlier run could not tell a watchdog that never fired from one that fired and was
  // ignored, because nothing in the ring said either way. One entry per edge.
  assert.deepEqual(ring.map(entry => `${entry.kind}:${entry.detail.phase}`),
    ['connection:missed', 'connection:recovered']);
  watcher.dispose();
});

/**
 * The frame clock is the only clock an immersive page has: window timers are
 * frozen while a session presents, so a request that stalls is retired by
 * `connectionFrame` or not at all. A page that loses that wiring loses every
 * connection error with it, silently, which is the shape of that earlier defect.
 */
test('an XR frame with no watchdog wired to it is recorded once, not once a frame', async () => {
  const liveness = await import('./connection-liveness.mjs');
  const ring = [], previous = globalThis.__stereofoldDiagnostics;
  globalThis.__stereofoldDiagnostics = { record: (kind, detail) => ring.push({ kind, detail }) };
  try {
    liveness.setConnectionFrameHandler(undefined);
    for (let index = 0; index < 72; index++) liveness.connectionFrame();
    assert.deepEqual(ring, [{ kind: 'connection', detail: { phase: 'unwired' } }]);
    let frames = 0;
    liveness.setConnectionFrameHandler(() => { frames++; });
    liveness.connectionFrame();
    assert.equal(frames, 1);
    assert.equal(ring.length, 1, 'a wired handler writes nothing to the ring');
  } finally {
    liveness.setConnectionFrameHandler(undefined);
    globalThis.__stereofoldDiagnostics = previous;
  }
});

/**
 * `pagehide` also fires for a back/forward cache freeze, and on a
 * headset for a flat page that stops being the foreground document. The
 * teardown ran on any of those, once, and never came back -- taking the XR
 * frame clock with it. Only a page that is really going away tears it down.
 */
test('the companion keeps its connection watchdog through a cached page freeze', () => {
  const boot = source('plugin/src/inspector.ts');
  const start = boot.indexOf("window.addEventListener('pagehide',event=>{");
  assert.ok(start > 0, 'the connection teardown reads the pagehide event');
  const teardown = boot.slice(start, boot.indexOf('});', start) + 3);
  assert.match(teardown, /persisted\)return;/, 'a cached freeze leaves the frame clock wired');
  assert.match(teardown, /connectionWatchdog\?\.dispose\(\)/);
  assert.ok(!teardown.includes('{once:true}'),
    'the listener stays registered so a real unload still tears the watchdog down');
  let torn = 0, persisted;
  const run = new Function('unwatchConnection', 'connectionWatchdog', 'setConnectionFrameHandler',
    'setConnectionRecovery', 'window', compile(teardown));
  const listeners = [];
  const windowStub = { addEventListener: (type, handler) => listeners.push({ type, handler }) };
  run(() => {}, { dispose: () => { torn++; } }, () => {}, () => {}, windowStub);
  assert.deepEqual(listeners.map(entry => entry.type), ['pagehide']);
  persisted = listeners[0].handler;
  persisted({ persisted: true });
  assert.equal(torn, 0, 'a frozen page keeps its watchdog');
  persisted({ persisted: false });
  assert.equal(torn, 1, 'a page that is really unloading gives it up');
});

/**
 * The Talk row is the wearer's only reading of the link, and the only thing
 * that repainted it on a connection edge was the companion's
 * `showHeadsetCaption('')`, which writes nothing until push-to-talk has
 * registered its caption sink. A session whose microphone never attached
 * therefore read `Talk` through a dead Mac, as the wearer did. The
 * menu is redrawn from the edge itself now, and the subscription is the
 * session's, not the page's.
 */
test('the immersive session redraws the menu on every connection edge and lets go with the session', () => {
  const viewer = source('lab/browser-roundtrip/viewer.mjs');
  assert.match(viewer, /import \{[^}]*subscribeConnectionStatus[^}]*\} from '\.\/connection-liveness\.mjs'/,
    'the viewer subscribes to connection state itself');
  const start = viewer.indexOf('      detachConnectionMenu = subscribeConnectionStatus(');
  assert.ok(start > 0, 'the subscription is made where the talk caption is');
  const block = viewer.slice(start, viewer.indexOf('\n      });', start));
  assert.match(block, /immersiveSession\?\.refreshToolbar\?\.\(\)/, 'an edge redraws the menu');
  assert.match(viewer, /try \{ detachConnectionMenu\?\.\(\); \} catch/,
    'the session gives the subscription back when it ends');
  assert.equal(viewer.split('detachConnectionMenu = undefined;').length - 1, 1);
});
