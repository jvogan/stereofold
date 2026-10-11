import assert from 'node:assert/strict';
import test from 'node:test';
import { blindVisibility, createTourResumeIntent, normalizeSessionVisibility, resumeAttempt,
  sessionVisibilityTransition, watchSessionVisibility, XR_VISIBILITY_DIAGNOSTIC } from './xr-visibility.mjs';

/** An XRSession stand-in with a settable visibility and the one event. */
function fakeSession(visibilityState = 'visible') {
  const listeners = new Map();
  return {
    visibilityState,
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) { listeners.get(type)?.delete(handler); },
    /** What the runtime does: set the state, then fire the event. */
    become(state) { this.visibilityState = state; for (const handler of [...(listeners.get('visibilitychange') ?? [])]) handler({}); },
    count(type) { return listeners.get(type)?.size ?? 0; },
  };
}

test('an unrecognized visibility reads as visible rather than blind', () => {
  assert.equal(normalizeSessionVisibility(undefined), 'visible');
  assert.equal(normalizeSessionVisibility('nonsense'), 'visible');
  assert.equal(normalizeSessionVisibility('hidden'), 'hidden');
  assert.equal(blindVisibility(undefined), false);
  assert.equal(blindVisibility('visible-blurred'), true);
  assert.equal(blindVisibility('hidden'), true);
});

test('going hidden cancels an open press and pauses a running tour', () => {
  const transition = sessionVisibilityTransition({ from: 'visible', to: 'hidden',
    talking: true, autoplay: true, tourActive: true });
  assert.equal(transition.blind, true);
  assert.equal(transition.changed, true);
  assert.equal(transition.cancelTalk, true);
  assert.equal(transition.tourAction, 'pause');
  assert.equal(transition.resumeOnVisible, true);
  assert.equal(transition.diagnostic.kind, XR_VISIBILITY_DIAGNOSTIC);
  assert.deepEqual(transition.diagnostic.detail,
    { from: 'visible', to: 'hidden', blind: true, cancelTalk: true, tour: 'pause' });
});

test('the system menu blurring a session counts as blind', () => {
  const transition = sessionVisibilityTransition({ from: 'visible', to: 'visible-blurred', talking: true, autoplay: true, tourActive: true });
  assert.equal(transition.blind, true);
  assert.equal(transition.cancelTalk, true);
  assert.equal(transition.tourAction, 'pause');
});

test('a second blind edge still cancels a press the first one did not see', () => {
  // A press opened while the session was already blurred, then the wearer
  // took the headset off. `hidden` follows `visible-blurred` with the hold
  // still open, and that edge is the one that must close the microphone.
  const transition = sessionVisibilityTransition({ from: 'visible-blurred', to: 'hidden', talking: true });
  assert.equal(transition.cancelTalk, true);
  assert.equal(transition.tourAction, 'none', 'Nothing was autoplaying, so nothing is paused.');
});

test('a blind session with nothing running costs nothing', () => {
  const transition = sessionVisibilityTransition({ from: 'visible', to: 'hidden' });
  assert.equal(transition.cancelTalk, false);
  assert.equal(transition.tourAction, 'none');
  assert.equal(transition.resumeOnVisible, false);
});

test('coming back resumes only the autoplay this module paused', () => {
  const paused = sessionVisibilityTransition({ from: 'visible', to: 'hidden', autoplay: true, tourActive: true });
  const resumed = sessionVisibilityTransition({ from: 'hidden', to: 'visible',
    tourActive: true, autoplay: false, resumeOnVisible: paused.resumeOnVisible });
  assert.equal(resumed.tourAction, 'resume');
  assert.equal(resumed.resumeOnVisible, false, 'The intent is spent once it is acted on.');

  const never = sessionVisibilityTransition({ from: 'hidden', to: 'visible', tourActive: true, resumeOnVisible: false });
  assert.equal(never.tourAction, 'none', 'A tour the wearer paused themselves stays paused.');
});

test('a stale resume intent is dropped rather than restarting scene work', () => {
  const gone = sessionVisibilityTransition({ from: 'hidden', to: 'visible', tourActive: false, resumeOnVisible: true });
  assert.equal(gone.tourAction, 'none');
  assert.equal(gone.resumeOnVisible, false);

  const already = sessionVisibilityTransition({ from: 'hidden', to: 'visible', tourActive: true, autoplay: true, resumeOnVisible: true });
  assert.equal(already.tourAction, 'none', 'Autoplay is already running; toggling it would stop it.');
  assert.equal(already.resumeOnVisible, false);
});

test('the watcher reports each runtime transition with live context', () => {
  const session = fakeSession();
  const seen = [];
  let talking = true, autoplay = true;
  const watch = watchSessionVisibility(session, transition => seen.push(transition),
    { context: () => ({ talking, autoplay, tourActive: true, resumeOnVisible: seen.at(-1)?.resumeOnVisible === true }) });

  assert.equal(watch.state(), 'visible');
  assert.equal(watch.blind(), false);
  assert.equal(seen.length, 0, 'A session that starts visible reports nothing.');

  session.become('hidden');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].cancelTalk, true);
  assert.equal(seen[0].tourAction, 'pause');
  assert.equal(watch.state(), 'hidden');
  assert.equal(watch.blind(), true);

  talking = false; autoplay = false;
  session.become('visible');
  assert.equal(seen.at(-1).tourAction, 'resume');
  assert.equal(watch.blind(), false);

  watch.stop();
  session.become('hidden');
  assert.equal(seen.length, 2, 'A stopped watch reports nothing more.');
  assert.equal(session.count('visibilitychange'), 0);
});

test('a session granted while already hidden reports its first reading', () => {
  const session = fakeSession('hidden');
  const seen = [];
  const watch = watchSessionVisibility(session, transition => seen.push(transition), { context: () => ({ talking: true }) });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].from, 'hidden');
  assert.equal(seen[0].to, 'hidden');
  assert.equal(seen[0].changed, false);
  assert.equal(seen[0].cancelTalk, true, 'A press open at entry is still a press that must not record.');
  assert.equal(watch.blind(), true);
});

test('a handler that throws never breaks the session', () => {
  const session = fakeSession();
  const watch = watchSessionVisibility(session, () => { throw new Error('handler'); }, { context: () => { throw new Error('context'); } });
  assert.doesNotThrow(() => session.become('hidden'));
  assert.equal(watch.state(), 'hidden');
});

test('a visibility watch needs a real session', () => {
  assert.throws(() => watchSessionVisibility(undefined, () => {}), TypeError);
  assert.throws(() => watchSessionVisibility({}, () => {}), TypeError);
});

// ---------------------------------------------------------------------------
// An owed autoplay resume that lands mid-scene is not lost.
// ---------------------------------------------------------------------------

/**
 * A tour player stand-in with the three fields the decision reads and the two
 * calls it makes. `sync()` is what the real player does after every decision:
 * notify every subscriber.
 */
function fakeTour({ navigating = false, autoplay = false, active = true } = {}) {
  const listeners = new Set();
  return {
    state: { navigating, autoplay, active },
    toggles: 0,
    getState() { return { ...this.state }; },
    togglePlay() { this.toggles += 1; this.state.autoplay = !this.state.autoplay; this.sync(); return Promise.resolve(); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    subscribers() { return listeners.size; },
    sync() { for (const listener of [...listeners]) listener(); },
    /** The player finishing a scene visit: navigating clears, then it syncs. */
    settle() { this.state.navigating = false; this.sync(); },
  };
}

test('a resume owed to a tour that is rendering a scene is kept, not spent', () => {
  const decision = resumeAttempt({ wantsResume: true, visible: true, navigating: true, active: true });
  assert.deepEqual(decision, { call: false, keepIntent: true, reason: 'navigating' });
});

test('a resume owed to an idle, active tour is spent immediately', () => {
  assert.deepEqual(resumeAttempt({ wantsResume: true, visible: true, navigating: false, active: true }),
    { call: true, keepIntent: false, reason: 'resume' });
});

test('a resume is never spent on a tour that is no longer on a scene', () => {
  assert.deepEqual(resumeAttempt({ wantsResume: true, visible: true, active: false }),
    { call: false, keepIntent: false, reason: 'inactive' });
});

test('a resume is dropped once autoplay is running again', () => {
  assert.deepEqual(resumeAttempt({ wantsResume: true, visible: true, autoplay: true, active: true }),
    { call: false, keepIntent: false, reason: 'already-playing' });
});

test('a session that is still blind keeps the intent for the next visible edge', () => {
  assert.deepEqual(resumeAttempt({ wantsResume: true, visible: false, active: true }),
    { call: false, keepIntent: true, reason: 'blind' });
});

test('nothing owed is nothing done', () => {
  assert.deepEqual(resumeAttempt({ wantsResume: false, visible: true, active: true }),
    { call: false, keepIntent: false, reason: 'none-owed' });
  assert.deepEqual(resumeAttempt(), { call: false, keepIntent: false, reason: 'none-owed' });
});

test('the menu opening mid-scene does not cost the wearer the rest of the lesson', () => {
  // The reachable Quest case: the universal menu opens and closes inside a few
  // hundred milliseconds while a scene visit is still settling.
  const tour = fakeTour({ navigating: true, autoplay: false, active: true });
  const logged = [];
  let visible = false;
  const intent = createTourResumeIntent({ getTour: () => tour, isVisible: () => visible,
    onDiagnostic: detail => logged.push(detail) });

  intent.set(true);                       // autoplay paused by the blind edge
  visible = true;
  assert.equal(intent.attempt('visible-edge').reason, 'navigating');
  assert.equal(tour.toggles, 0, 'A resume the player would discard is not made.');
  assert.equal(intent.owed(), true);
  assert.equal(tour.subscribers(), 1, 'The late retry rides the player own state channel.');

  tour.settle();                          // the visit lands and the player syncs
  assert.equal(tour.toggles, 1, 'The owed resume is spent the moment the scene settles.');
  assert.equal(tour.state.autoplay, true);
  assert.equal(intent.owed(), false);
  assert.deepEqual(logged.map(entry => entry.outcome), ['navigating', 'resume']);
  assert.equal(logged[1].source, 'tour-state');

  tour.settle();
  assert.equal(tour.toggles, 1, 'A spent intent is never replayed into a pause.');
});

test('a second visible edge does not resume twice', () => {
  const tour = fakeTour({ navigating: false, autoplay: false, active: true });
  const intent = createTourResumeIntent({ getTour: () => tour });
  intent.set(true);
  assert.equal(intent.attempt().reason, 'resume');
  assert.equal(tour.toggles, 1);
  assert.equal(intent.attempt().reason, 'none-owed');
  assert.equal(tour.toggles, 1);
});

test('a tour the wearer resumed themselves keeps its autoplay', () => {
  const tour = fakeTour({ navigating: true, autoplay: false, active: true });
  const intent = createTourResumeIntent({ getTour: () => tour });
  intent.set(true);
  intent.attempt();
  tour.state.autoplay = true;             // the wearer pressed Play on the menu
  tour.settle();
  assert.equal(tour.toggles, 0, 'Resuming an already playing tour would pause it.');
  assert.equal(intent.owed(), false);
});

test('a session that ended spends nothing and holds nothing', () => {
  const tour = fakeTour({ navigating: false, active: true });
  let current = true;
  const intent = createTourResumeIntent({ getTour: () => tour, isCurrent: () => current });
  intent.set(true);
  current = false;
  assert.equal(intent.attempt().reason, 'session-gone');
  assert.equal(tour.toggles, 0);
  intent.dispose();
  assert.equal(intent.owed(), false);
  assert.equal(tour.subscribers(), 0, 'The subscription dies with the session.');
});

test('a resume intent survives a tour controller that is not there yet', () => {
  let tour;
  const intent = createTourResumeIntent({ getTour: () => tour });
  intent.set(true);
  assert.equal(intent.attempt().reason, 'inactive', 'No controller is no scene to resume.');
  tour = fakeTour({ active: true });
  assert.equal(intent.navigating(), false);
});

test('a controller that throws never breaks the resume path', () => {
  const intent = createTourResumeIntent({ getTour: () => { throw new Error('mid-teardown'); },
    onDiagnostic: () => { throw new Error('no diagnostics hook'); } });
  intent.set(true);
  assert.doesNotThrow(() => intent.attempt());
  assert.doesNotThrow(() => intent.dispose());
});

test('the existing XR head-frame callback drives liveness before any pose-dependent work', async () => {
  const { readFile } = await import('node:fs/promises');
  const vm = await import('node:vm');
  const { connectionFrame, setConnectionFrameHandler } = await import('./connection-liveness.mjs');
  const source = await readFile(new URL('./viewer.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('onHeadFrame: ({ frame, space, mode, drawn }) => {');
  const body = source.slice(start, source.indexOf('latestXrSpace = space;', start));
  assert.ok(body.includes('connectionFrame();'));
  let beats = 0;
  let flushes = 0;
  setConnectionFrameHandler(() => beats++);
  try {
    // Execute the real callback prefix with no viewer pose and no window clock.
    const callback = vm.runInNewContext(`(${body.replace('onHeadFrame: ', '')}})`, {
      connectionFrame,
      flushXrDeferredGrab() {
        assert.equal(beats, 1, 'Liveness runs before deferred placement saving');
        flushes++;
      },
    });
    callback({ frame: {}, space: undefined });
    assert.equal(beats, 1);
    setConnectionFrameHandler(undefined);
    callback({ frame: {}, space: undefined });
    assert.equal(beats, 1, 'Page teardown detaches the callback');
    assert.equal(flushes, 2);
  } finally { setConnectionFrameHandler(undefined); }
});
