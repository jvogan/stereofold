import test from 'node:test';
import assert from 'node:assert/strict';
import { OUTCOME_HOLD_MS, holdOutcomeLine, isLessonOutcome, outcomeLineDecision, shouldClearOutcomeRow } from './outcome-line.mjs';
import { outcomeCopy } from './outcome-copy.mjs';

/**
 * The three status-row rules, held against the module rather than against a
 * description of it.
 *
 * The microtubule lesson used to keep the same teal `Applied · tour · r8`
 * beside the chapter, for the whole chapter, dimmed menu and all. The sentences
 * below are exactly what `inspector.ts showOutcome` writes for those commands,
 * run through `outcome-copy.mjs` the way the headset does, so a change to
 * either module fails here.
 */

/** A frame clock a test owns: callbacks queue, and time only moves on demand. */
function fakeFrames() {
  const queue = [];
  let time = 0;
  return {
    scheduleFrame: callback => { queue.push(callback); return queue.length; },
    pending: () => queue.length,
    /** Deliver one frame `stepMs` later, as a presented session would. */
    frame(stepMs = 16) {
      time += stepMs;
      const callback = queue.shift();
      assert.ok(callback, 'a frame was requested');
      callback(time);
    },
    /** Frames until nothing is scheduled or the budget runs out. */
    run(stepMs = 16, limit = 2000) {
      for (let count = 0; queue.length && count < limit; count++) this.frame(stepMs);
    },
  };
}

test('every lesson step is silent on the wearer\'s status row', () => {
  // `control_tour` carries start, next, back, play, pause and stop as one
  // `tour` change whose patch is an `action` -- and a start also a `tourId`.
  // Those wire names are what `inspector.ts showOutcome` writes, which is why
  // the plate reads `Applied · tour · r8` only after its own translation.
  // Both forms are here: a rule written against the plate's
  // wording alone would have matched none of the sentences it is given.
  for (const sentence of ['Applied · action · revision 8', 'Applied · action, tour id · revision 12',
    'Waiting · action', 'Could not apply · action · The panel is busy.',
    'Applied · tour · revision 8', 'Waiting · tour id']) {
    const state = sentence.startsWith('Applied') ? 'applied' : sentence.startsWith('Waiting') ? 'waiting' : 'error';
    const plate = outcomeCopy(sentence, state);
    assert.ok(/tour/.test(plate.text), `${sentence} reaches the plate as a tour line`);
    const decision = outcomeLineDecision({ text: sentence, status: state });
    assert.equal(decision.draw, false, sentence);
    assert.equal(decision.reason, 'lesson');
    // A suppressed receipt also takes down whatever receipt preceded it, so a
    // chapter cannot leave the previous command's sentence stranded on the row.
    assert.equal(decision.clear, true);
  }
});

test('a grow is spoken, never written as a receipt', () => {
  // `grow_structure` replaces the source instead of enqueueing a change, so it
  // mints no receipt today; the rule is stated by kind so that it stays true if
  // one ever rides the same beat, and so the refusal path is unmistakably a
  // different one.
  for (const kind of ['tour', 'grow', 'grow_structure', 'grow-structure', 'experience']) {
    assert.equal(isLessonOutcome({ kind }), true, kind);
    assert.equal(outcomeLineDecision({ text: 'Applied · scene · revision 9', kind }).draw, false, kind);
  }
  // The spoken refusal is not a receipt and never reaches this decision at all.
  assert.equal(isLessonOutcome({ text: 'Too big for this headset. Staying here.' }), false);
  assert.equal(isLessonOutcome({ text: 'One moment.' }), false);
});

test('a sentence that is not a receipt is never read as one', () => {
  // The same row carries `Listening…`, a voice error and the agent's spoken
  // reply. A reply that happens to say the word tour must not be classified.
  assert.equal(isLessonOutcome({ text: 'The tour has six chapters.' }), false);
  assert.equal(isLessonOutcome({ text: 'Listening…' }), false);
  assert.equal(isLessonOutcome({ text: '' }), false);
  assert.equal(isLessonOutcome({}), false);
});

test('quality, representation and colour still get their one glance', () => {
  for (const [sentence, state, expected] of [
    ['Applied · render quality · revision 26', 'applied', 'Applied · quality · r26'],
    ['Applied · representation · revision 31', 'applied', 'Applied · style · r31'],
    ['Applied · uniform color · revision 7', 'applied', 'Applied · color · r7'],
    ['Could not apply · level · too many atoms', 'error', 'Could not apply · quality'],
  ]) {
    const decision = outcomeLineDecision({ text: sentence, status: state });
    assert.equal(decision.draw, true, sentence);
    assert.equal(decision.holdMs, OUTCOME_HOLD_MS);
    assert.equal(outcomeCopy(sentence, state).text, expected);
  }
});

test('a drawn receipt is retired after four seconds of presented frames', () => {
  const frames = fakeFrames();
  const expired = [];
  holdOutcomeLine({ scheduleFrame: frames.scheduleFrame, onExpire: reason => expired.push(reason) });
  // Just short of the hold: still up, still asking for frames.
  for (let elapsed = 0; elapsed < OUTCOME_HOLD_MS - 32; elapsed += 16) frames.frame(16);
  assert.deepEqual(expired, []);
  assert.equal(frames.pending(), 1);
  frames.run(16);
  assert.deepEqual(expired, ['expired']);
  // And it stops asking for frames the moment it is done.
  assert.equal(frames.pending(), 0);
});

test('the hold never touches the window frame clock', () => {
  // Quest Browser stops servicing `window.requestAnimationFrame` for the whole
  // immersive session, so a hold that reached for it would never expire.
  const original = globalThis.requestAnimationFrame;
  let windowFrames = 0;
  globalThis.requestAnimationFrame = callback => { windowFrames++; return original ? original(callback) : 0; };
  try {
    const frames = fakeFrames();
    holdOutcomeLine({ scheduleFrame: frames.scheduleFrame, onExpire: () => {} });
    frames.run(500);
    assert.equal(windowFrames, 0);
  } finally {
    if (original) globalThis.requestAnimationFrame = original; else delete globalThis.requestAnimationFrame;
  }
});

test('a menu standing back for a lesson is given no receipt at all', () => {
  const decision = outcomeLineDecision({ text: 'Applied · render quality · revision 26', status: 'applied', asleep: true });
  assert.equal(decision.draw, false);
  assert.equal(decision.reason, 'asleep');
  assert.equal(decision.clear, true);
  assert.equal(decision.holdMs, 0);
});

test('a receipt already up when the lesson takes the room goes with it', () => {
  const frames = fakeFrames();
  const expired = [];
  let asleep = false;
  holdOutcomeLine({ scheduleFrame: frames.scheduleFrame, asleep: () => asleep, onExpire: reason => expired.push(reason) });
  frames.frame(16);
  assert.deepEqual(expired, []);
  // The next chapter starts: `menuStandsBack` turns true and the menu dims.
  asleep = true;
  frames.frame(16);
  assert.deepEqual(expired, ['asleep']);
  assert.equal(frames.pending(), 0);
});

test('an empty sentence retires the row and a cancelled hold retires nothing', () => {
  const retire = outcomeLineDecision({ text: '  ', status: '' });
  assert.deepEqual([retire.draw, retire.clear, retire.reason], [false, true, 'retired']);

  const frames = fakeFrames();
  const expired = [];
  const cancel = holdOutcomeLine({ scheduleFrame: frames.scheduleFrame, onExpire: reason => expired.push(reason) });
  frames.frame(16);
  cancel();
  frames.run(OUTCOME_HOLD_MS);
  assert.deepEqual(expired, []);
});

test('a session with no frame clock is never left holding a receipt', () => {
  const expired = [];
  holdOutcomeLine({ scheduleFrame: undefined, onExpire: reason => expired.push(reason) });
  assert.deepEqual(expired, ['no-frames']);
  expired.length = 0;
  // A session that ends mid-hold throws from its scheduler rather than calling
  // back, and that must retire the receipt instead of hanging on it.
  holdOutcomeLine({ scheduleFrame: () => { throw Error('The session has ended.'); },
    onExpire: reason => expired.push(reason) });
  assert.deepEqual(expired, ['no-frames']);
});

test('an expiring receipt never clears a row somebody else has written', () => {
  const receipt = 'Applied · quality · r26';
  assert.equal(shouldClearOutcomeRow({ drawn: receipt, current: receipt }), true);
  // The four writers of that row, as `immersive-session.mjs` attaches them:
  // push-to-talk state, a voice error, and the agent's spoken reply.
  for (const current of ['Listening…', 'Hearing you…', 'Voice is not ready',
    'Six tubulin dimers make one turn.', '', undefined]) {
    assert.equal(shouldClearOutcomeRow({ drawn: receipt, current }), false, String(current));
  }
  // And a module that put nothing up clears nothing.
  assert.equal(shouldClearOutcomeRow({ drawn: '', current: '' }), false);
  assert.equal(shouldClearOutcomeRow({}), false);
});

test('one receipt never expires twice', () => {
  const frames = fakeFrames();
  const expired = [];
  const cancel = holdOutcomeLine({ scheduleFrame: frames.scheduleFrame, onExpire: reason => expired.push(reason) });
  frames.run(OUTCOME_HOLD_MS);
  cancel();
  frames.run(OUTCOME_HOLD_MS);
  assert.deepEqual(expired, ['expired']);
});
