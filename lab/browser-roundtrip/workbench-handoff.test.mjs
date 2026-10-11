import assert from 'node:assert/strict';
import test from 'node:test';
import { announceWorkbenchTransfer, beginWorkbenchHandoff, classifyDetailedViewProbe,
  createDetailedViewAvailability, workbenchHoldRemaining, DETAILED_VIEW_UNREACHABLE_CAPTION,
  WORKBENCH_HANDOFF_HOLD_MS, WORKBENCH_HANDOFF_STAYED_CAPTION, WORKBENCH_TRANSFER_CAPTION,
  WORKBENCH_TRANSFER_SPOKEN } from './workbench-handoff.mjs';
import { densityTierCaption, workbenchFailureCaption, TIER_NAME_PLATE_LIMIT } from './xr-manipulate.mjs';

/** A controllable clock and timer pair, so no test waits on real time. */
function fakeTimers(start = 1000) {
  let clock = start;
  const scheduled = new Map();
  let next = 1;
  return {
    now: () => clock,
    advance(ms) {
      clock += ms;
      for (const [handle, entry] of [...scheduled]) {
        if (entry.at <= clock) { scheduled.delete(handle); entry.fn(); }
      }
    },
    setTimer(fn, ms) { const handle = next++; scheduled.set(handle, { fn, at: clock + ms }); return handle; },
    clearTimer(handle) { scheduled.delete(handle); },
    pending: () => scheduled.size,
    delayOf: handle => scheduled.get(handle)?.at - start,
  };
}

test('the press announces the transfer in both channels before the host is asked', () => {
  const captions = [], spoken = [];
  const announced = announceWorkbenchTransfer({
    showCaption: caption => captions.push(caption),
    speak: text => { spoken.push(text); return Promise.resolve(); },
    now: () => 4242,
  });
  assert.deepEqual(captions, [WORKBENCH_TRANSFER_CAPTION]);
  assert.deepEqual(spoken, [WORKBENCH_TRANSFER_SPOKEN]);
  // The line names the way home as well as the way
  // out, because the wearer reads it once and then the scene is gone.
  assert.equal(WORKBENCH_TRANSFER_CAPTION, 'Opening the full viewer. Say return when done.');
  assert.equal(WORKBENCH_TRANSFER_SPOKEN, 'Opening the full viewer. Say return when done.');
  assert.equal(announced.at, 4242);
  assert.equal(announced.captioned, true);
  assert.equal(announced.said, true);
});

test('a page with no speaker and no caption layer still transfers', async () => {
  const timers = fakeTimers();
  const announced = announceWorkbenchTransfer({
    showCaption: () => { throw Error('the presentation layer left with the session'); },
    speak: () => { throw Error('no narration slot on this page'); },
    now: timers.now,
  });
  assert.equal(announced.captioned, false);
  assert.equal(announced.said, false);
  let navigated = false;
  const handoff = beginWorkbenchHandoff({ announcedAt: announced.at, navigate: () => { navigated = true; },
    now: timers.now, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  timers.advance(WORKBENCH_HANDOFF_HOLD_MS);
  assert.equal(await handoff.settled, 'navigated');
  assert.equal(navigated, true);
});

test('a rejected narration promise never reaches the page', async () => {
  const announced = announceWorkbenchTransfer({ speak: () => Promise.reject(Error('the Mac has no voice')) });
  assert.equal(announced.said, true);
  // An unhandled rejection would fail the run on the next turn of the loop.
  await new Promise(resolve => setImmediate(resolve));
});

test('the wearer keeps the scene for the hold, and leaves in one order', async () => {
  const timers = fakeTimers();
  const order = [];
  const handoff = beginWorkbenchHandoff({
    announcedAt: timers.now(),
    showCaption: caption => order.push(`caption:${caption}`),
    endSession: () => { order.push('end'); return Promise.resolve(); },
    navigate: () => order.push('navigate'),
    now: timers.now, setTimer: timers.setTimer, clearTimer: timers.clearTimer,
  });
  assert.equal(handoff.holdMs, WORKBENCH_HANDOFF_HOLD_MS);
  assert.deepEqual(order, [`caption:${WORKBENCH_TRANSFER_CAPTION}`]);

  timers.advance(WORKBENCH_HANDOFF_HOLD_MS - 1);
  assert.deepEqual(order, [`caption:${WORKBENCH_TRANSFER_CAPTION}`], 'nothing ends before the hold is up');
  assert.equal(handoff.state(), 'holding');

  timers.advance(1);
  assert.equal(await handoff.settled, 'navigated');
  assert.deepEqual(order, [`caption:${WORKBENCH_TRANSFER_CAPTION}`, 'end', 'navigate']);
  assert.equal(handoff.state(), 'navigated');
});

test('the hold is a deadline from the announcement, not a second wait', () => {
  const full = WORKBENCH_HANDOFF_HOLD_MS;
  assert.equal(workbenchHoldRemaining(1000, 1000), full);
  assert.equal(workbenchHoldRemaining(1000, 1400), full - 400);
  // A host round trip longer than the hold adds no further wait at all.
  assert.equal(workbenchHoldRemaining(1000, 9000), 0);
  // A clock that jumps backwards, or an announcement that never happened,
  // both fall back to the whole hold rather than to an unbounded one.
  assert.equal(workbenchHoldRemaining(9000, 1000), full);
  assert.equal(workbenchHoldRemaining(undefined, 1000), full);
  const timers = fakeTimers(1000);
  timers.advance(400);
  const handoff = beginWorkbenchHandoff({ announcedAt: 1000, navigate: () => {},
    now: timers.now, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  assert.equal(handoff.holdMs, full - 400);
});

test('cancelling during the hold leaves the session alone and never navigates', async () => {
  const timers = fakeTimers();
  let ended = false, navigated = false;
  const handoff = beginWorkbenchHandoff({
    announcedAt: timers.now(),
    endSession: () => { ended = true; },
    navigate: () => { navigated = true; },
    now: timers.now, setTimer: timers.setTimer, clearTimer: timers.clearTimer,
  });
  assert.equal(handoff.cancel(), true);
  assert.equal(handoff.state(), 'cancelled');
  assert.equal(timers.pending(), 0, 'the timer is cleared rather than left to fire');
  timers.advance(WORKBENCH_HANDOFF_HOLD_MS * 4);
  assert.equal(await handoff.settled, 'cancelled');
  assert.equal(ended, false);
  assert.equal(navigated, false);
  // Cancelling twice, or after the transfer left, answers false and does nothing.
  assert.equal(handoff.cancel(), false);
});

test('a session that has already gone still delivers the wearer to Mol*', async () => {
  const timers = fakeTimers();
  let navigated = false;
  // `immersive-session.mjs` returns quietly from `end()` when nothing is
  // active, and its native close reads InvalidStateError as already-ended, so
  // this is what an already-gone session looks like from here.
  const handoff = beginWorkbenchHandoff({
    announcedAt: timers.now(),
    endSession: () => Promise.resolve(),
    confirmEnded: () => true,
    navigate: () => { navigated = true; },
    now: timers.now, setTimer: timers.setTimer, clearTimer: timers.clearTimer,
  });
  timers.advance(WORKBENCH_HANDOFF_HOLD_MS);
  assert.equal(await handoff.settled, 'navigated');
  assert.equal(navigated, true);
});

/**
 * Never navigate away while the immersive session is up.
 *
 * Quest Browser draws a 2D page over a live immersive session as a flat panel
 * behind "The immersive web experience is still running in the background",
 * with Resume, Quit and the home tiles beside it, which looks like a crash. The only way to never show it is to never navigate while the
 * session is up, whether the teardown said so by throwing or the renderer is
 * simply still presenting.
 */
test('a teardown that failed keeps the wearer in the scene rather than behind the banner', async () => {
  const timers = fakeTimers();
  const captions = [], said = [];
  let navigated = false;
  const handoff = beginWorkbenchHandoff({
    announcedAt: timers.now(),
    showCaption: caption => captions.push(caption),
    onStayed: (caption, why) => said.push([caption, why]),
    endSession: () => Promise.reject(Error('Timed out closing the headset session.')),
    navigate: () => { navigated = true; },
    now: timers.now, setTimer: timers.setTimer, clearTimer: timers.clearTimer,
  });
  timers.advance(WORKBENCH_HANDOFF_HOLD_MS);
  assert.equal(await handoff.settled, 'stayed');
  assert.equal(handoff.state(), 'stayed');
  assert.equal(navigated, false, 'a live session is never navigated over');
  assert.equal(handoff.reason(), 'Timed out closing the headset session.');
  assert.deepEqual(captions, [WORKBENCH_TRANSFER_CAPTION, WORKBENCH_HANDOFF_STAYED_CAPTION]);
  assert.deepEqual(said, [[WORKBENCH_HANDOFF_STAYED_CAPTION, 'Timed out closing the headset session.']]);
  assert.equal(WORKBENCH_HANDOFF_STAYED_CAPTION, 'The headset view would not close. Staying here.');
});

test('a teardown that resolved while the headset is still presenting also stays', async () => {
  const timers = fakeTimers();
  let navigated = false, presenting = true;
  const handoff = beginWorkbenchHandoff({
    announcedAt: timers.now(),
    endSession: () => Promise.resolve(),
    confirmEnded: () => presenting !== true,
    navigate: () => { navigated = true; },
    now: timers.now, setTimer: timers.setTimer, clearTimer: timers.clearTimer,
  });
  timers.advance(WORKBENCH_HANDOFF_HOLD_MS);
  assert.equal(await handoff.settled, 'stayed');
  assert.equal(navigated, false);
  assert.equal(handoff.reason(), undefined, 'nothing threw, so there is nothing to quote');
});

test('a probe that cannot answer is not taken as a live session', async () => {
  const timers = fakeTimers();
  let navigated = false;
  // `canvas.xr.isPresenting.value` is `undefined` on a viewer built without XR.
  // Only a definite "still presenting" strands the wearer; a silent probe must
  // not turn every handoff into a refusal.
  const handoff = beginWorkbenchHandoff({
    announcedAt: timers.now(),
    endSession: () => Promise.resolve(),
    confirmEnded: () => undefined,
    navigate: () => { navigated = true; },
    now: timers.now, setTimer: timers.setTimer, clearTimer: timers.clearTimer,
  });
  timers.advance(WORKBENCH_HANDOFF_HOLD_MS);
  assert.equal(await handoff.settled, 'navigated');
  assert.equal(navigated, true);
});

test('a probe that throws is read as a session still up', async () => {
  const timers = fakeTimers();
  let navigated = false;
  const handoff = beginWorkbenchHandoff({
    announcedAt: timers.now(),
    endSession: () => Promise.resolve(),
    confirmEnded: () => { throw Error('the renderer went away mid-teardown'); },
    navigate: () => { navigated = true; },
    now: timers.now, setTimer: timers.setTimer, clearTimer: timers.clearTimer,
  });
  timers.advance(WORKBENCH_HANDOFF_HOLD_MS);
  assert.equal(await handoff.settled, 'stayed');
  assert.equal(navigated, false);
  assert.equal(handoff.reason(), 'the renderer went away mid-teardown');
});

test('a page with no caption layer still reports a refused teardown', async () => {
  const timers = fakeTimers();
  const said = [];
  const handoff = beginWorkbenchHandoff({
    announcedAt: timers.now(),
    showCaption: () => { throw Error('the presentation layer left with the session'); },
    onStayed: caption => said.push(caption),
    endSession: () => Promise.resolve(),
    confirmEnded: () => false,
    navigate: () => { throw Error('this transfer must not navigate'); },
    now: timers.now, setTimer: timers.setTimer, clearTimer: timers.clearTimer,
  });
  timers.advance(WORKBENCH_HANDOFF_HOLD_MS);
  assert.equal(await handoff.settled, 'stayed');
  assert.deepEqual(said, [WORKBENCH_HANDOFF_STAYED_CAPTION]);
});

test('cancelling after the teardown has begun does not stop the navigation', async () => {
  const timers = fakeTimers();
  let navigated = false;
  const handoff = beginWorkbenchHandoff({
    announcedAt: timers.now(),
    endSession: () => Promise.resolve(),
    navigate: () => { navigated = true; },
    now: timers.now, setTimer: timers.setTimer, clearTimer: timers.clearTimer,
  });
  timers.advance(WORKBENCH_HANDOFF_HOLD_MS);
  assert.equal(handoff.state(), 'leaving');
  assert.equal(handoff.cancel(), false, 'a transfer already ending the session is past calling off');
  assert.equal(await handoff.settled, 'navigated');
  assert.equal(navigated, true);
});

test('a handoff with nowhere to go is refused rather than half-run', () => {
  assert.throws(() => beginWorkbenchHandoff({ endSession: () => {} }), /somewhere to navigate/u);
});

/**
 * Which side of the link opens Mol*.
 *
 * The press used to decide that with one live `fetch('/detailed')` per press,
 * and read every failure as "this host cannot serve it here", which opened the
 * viewer on a Mac monitor the wearer cannot see. These pin the three answers
 * apart: served here, genuinely absent, and could not be reached.
 */

/** A probe whose answers are scripted and whose calls are counted. */
function fakeProbe(...answers) {
  const calls = [];
  const probe = async () => {
    calls.push(calls.length);
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (typeof answer === 'function') return answer();
    return answer;
  };
  probe.count = () => calls.length;
  return probe;
}

const htmlPage = { ok: true, status: 200, contentType: 'text/html; charset=utf-8' };

test('a probe that could not be reached is never read as "open it on the Mac"', async () => {
  const probe = fakeProbe({ failed: true });
  const availability = createDetailedViewAvailability({ probe });
  assert.equal(await availability.resolve(), 'unreachable');
  assert.equal(probe.count(), 1);
  assert.equal(DETAILED_VIEW_UNREACHABLE_CAPTION, 'Mol* page unreachable. Trying again.');
});

test('a failed probe is not remembered, so the next press tries again and lands here', async () => {
  const probe = fakeProbe({ failed: true }, htmlPage);
  const availability = createDetailedViewAvailability({ probe });
  assert.equal(await availability.resolve(), 'unreachable');
  assert.equal(await availability.resolve(), 'here');
  assert.equal(probe.count(), 2);
});

test('a host that advertises the detailed view skips the fetch entirely', async () => {
  const probe = fakeProbe(htmlPage);
  const availability = createDetailedViewAvailability({ probe });
  availability.note({ kind: 'inspection', detailedViewAvailable: true });
  assert.equal(await availability.resolve(), 'here');
  assert.equal(probe.count(), 0, 'the advertised field is the answer');
});

test('a host that advertises no detailed view opens on the Mac without probing', async () => {
  const probe = fakeProbe(htmlPage);
  const availability = createDetailedViewAvailability({ probe });
  availability.note({ detailedViewAvailable: false });
  assert.equal(await availability.resolve(), 'mac');
  assert.equal(probe.count(), 0);
});

test('state from a host too old to carry the field leaves the probe in charge', async () => {
  const probe = fakeProbe(htmlPage);
  const availability = createDetailedViewAvailability({ probe });
  availability.note({ kind: 'inspection', sessionId: 's' });
  availability.note(undefined);
  assert.equal(await availability.resolve(), 'here');
  assert.equal(probe.count(), 1);
});

test('one success is cached for the session, so a second press costs no round trip', async () => {
  const probe = fakeProbe(htmlPage, { failed: true });
  const availability = createDetailedViewAvailability({ probe });
  assert.equal(await availability.resolve(), 'here');
  assert.equal(await availability.resolve(), 'here');
  assert.equal(probe.count(), 1);
});

test('concurrent presses share one probe', async () => {
  const probe = fakeProbe(htmlPage);
  const availability = createDetailedViewAvailability({ probe });
  const [first, second] = await Promise.all([availability.resolve(), availability.resolve()]);
  assert.equal(first, 'here');
  assert.equal(second, 'here');
  assert.equal(probe.count(), 1);
});

test('"open it on the Mac" is the one phrase that asks for a monitor, and never probes', async () => {
  const probe = fakeProbe(htmlPage);
  const availability = createDetailedViewAvailability({ probe });
  assert.equal(await availability.resolve({ target: 'mac' }), 'mac');
  assert.equal(probe.count(), 0);
  // The explicit press does not teach the page anything about this origin.
  assert.equal(await availability.resolve(), 'here');
});

test('a probe answer is classified as served, absent or unreachable', () => {
  assert.equal(classifyDetailedViewProbe(htmlPage), 'here');
  assert.equal(classifyDetailedViewProbe({ ok: true, status: 200, contentType: 'application/json' }), 'absent');
  assert.equal(classifyDetailedViewProbe({ ok: false, status: 404, contentType: 'application/json' }), 'absent');
  assert.equal(classifyDetailedViewProbe({ ok: false, status: 409, contentType: 'application/json' }), 'unreachable');
  assert.equal(classifyDetailedViewProbe({ ok: false, status: 502, contentType: 'text/html' }), 'unreachable');
  assert.equal(classifyDetailedViewProbe({ failed: true }), 'unreachable');
  assert.equal(classifyDetailedViewProbe(undefined), 'unreachable');
});

test('a probe that throws is unreachable rather than a Mac fallback', async () => {
  const availability = createDetailedViewAvailability({ probe: () => { throw Error('the listener went away'); } });
  assert.equal(await availability.resolve(), 'unreachable');
});

test('the unreachable line reaches the wearer as itself, not as a Mac failure', () => {
  assert.equal(workbenchFailureCaption(DETAILED_VIEW_UNREACHABLE_CAPTION), DETAILED_VIEW_UNREACHABLE_CAPTION);
  // The Mac-side failures keep the wording they already had.
  assert.equal(workbenchFailureCaption('could not open'), 'The Mac browser did not open');
  assert.equal(workbenchFailureCaption('the share expired'), 'Share expired. Ask Claude to re-open it.');
});


// ---------------------------------------------------------------------------
// The density-tier refusal, short enough for the wearer's plate.

test('the density-tier refusal names the tier and the way out in one short line', () => {
  const full = 'The filament-density tier has no atom coordinates. Switch to an atomic tier, then open Mol* again.';
  const caption = workbenchFailureCaption(full);
  assert.equal(caption, 'Filament-density tier has no atoms. Switch to an atomic tier.');
  // The plate holds one short line; the settled spoken length is twelve words.
  assert.equal(caption.split(' ').length <= 12, true);
  assert.match(caption, /filament-density/iu);
  assert.match(caption, /atomic tier/u);
  // A tier whose name would not fit is called what it is rather than cut off.
  const long = 'The A map beside its model tier has no atom coordinates. Switch to an atomic tier, then open Mol* again.';
  assert.equal(densityTierCaption(long), 'This density tier has no atoms. Switch to an atomic tier.');
  assert.equal(densityTierCaption(long).split(' ').length <= 12, true);
  assert.equal('A map beside its model'.length > TIER_NAME_PLATE_LIMIT, true);
  // The host's default wording, with no tier name at all.
  assert.equal(densityTierCaption('The density tier has no atom coordinates. Switch to an atomic tier, then open Mol* again.'),
    'Density tier has no atoms. Switch to an atomic tier.');
  assert.equal(densityTierCaption(undefined), 'This density tier has no atoms. Switch to an atomic tier.');
  // Every other refusal keeps the wording it had.
  assert.equal(workbenchFailureCaption('could not open'), 'The Mac browser did not open');
});
