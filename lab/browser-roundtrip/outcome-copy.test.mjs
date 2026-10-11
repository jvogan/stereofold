import test from 'node:test';
import assert from 'node:assert/strict';
import { OUTCOME_APPLIED_COLOR, OUTCOME_FAILED_COLOR, OUTCOME_FIELD_WORDS, OUTCOME_WAITING_COLOR,
  outcomeCopy, outcomeFields } from './outcome-copy.mjs';

/**
 * The plate's line budget. `spatial-toolbar-geometry.mjs` wraps the status to
 * `maxStatusLines` (2) of about `READOUT_PAGE_LINE_WIDTH` (15) characters and
 * ellipsises anything past that, so a copy longer than 30 loses its end.
 */
const PLATE_BUDGET = 30;

test('the field names an agent command actually carries reach the plate as words', () => {
  // `update_inspection {kind:'motion'}`; the receipt names the field `motion`.
  assert.equal(outcomeFields('Applied · motion · revision 24'), 'motion');
  // `render-quality` patches `level`; the polled receipt names `renderQuality`.
  assert.equal(outcomeFields('Applied · level · revision 26'), 'quality');
  assert.equal(outcomeFields('Applied · render quality · revision 26'), 'quality');
  // `control_tour` is confirmed as `tour` and polled back as `action`.
  assert.equal(outcomeFields('Waiting · tour'), 'tour');
  assert.equal(outcomeFields('Waiting · action'), 'tour');
  assert.equal(outcomeFields('Waiting · action, tour id'), 'tour');
});

/**
 * A `replace_inspection_source` load used to draw no
 * outcome at all; `inspector.ts` now sends one whose field is `structure`. The
 * word is deliberately the generic one: the readout's title line above this
 * row already carries the structure's own name.
 */
test('a source load reads as structure, in both states, inside the plate budget', () => {
  assert.equal(outcomeFields('Waiting · structure'), 'structure');
  const waiting = outcomeCopy('Waiting · structure', 'waiting');
  assert.deepEqual(waiting, { text: 'Waiting · structure', color: OUTCOME_WAITING_COLOR });
  const applied = outcomeCopy('Applied · structure · revision 26', 'applied');
  assert.equal(applied.text, 'Applied · structure · r26');
  assert.equal(applied.color, OUTCOME_APPLIED_COLOR);
  assert.ok(applied.text.length <= PLATE_BUDGET, applied.text);
  assert.deepEqual(outcomeCopy('Could not apply · structure · Timed out.', 'error'),
    { text: 'Could not apply · structure', color: OUTCOME_FAILED_COLOR });
});

test('an unnamed field still degrades to change rather than to raw protocol text', () => {
  assert.equal(outcomeFields('Applied · someFutureField · revision 3'), 'change');
  assert.equal(outcomeFields('a sentence that is not an outcome'), 'change');
  assert.equal(outcomeFields(undefined), 'change');
});

test('fields that share one wearer word are counted once', () => {
  assert.equal(outcomeFields('Applied · color, uniform color · revision 9'), 'color');
  assert.equal(outcomeFields('Applied · color, opacity, background · revision 9'), 'color +2');
  assert.equal(outcomeFields('Applied · color, opacity, background, labels · revision 9'), 'color +2');
});

test('a rendered receipt reads Applied with its field and revision, in the applied colour', () => {
  const applied = outcomeCopy('Applied · motion · revision 24', 'applied');
  assert.equal(applied.text, 'Applied · motion · r24');
  assert.equal(applied.color, OUTCOME_APPLIED_COLOR);
  assert.ok(applied.text.length <= PLATE_BUDGET, applied.text);
  const quality = outcomeCopy('Applied · level · revision 26', 'applied');
  assert.equal(quality.text, 'Applied · quality · r26');
  assert.ok(quality.text.length <= PLATE_BUDGET, quality.text);
});

test('waiting and failed keep their own words and colours', () => {
  assert.deepEqual(outcomeCopy('Waiting · motion', 'waiting'),
    { text: 'Waiting · motion', color: OUTCOME_WAITING_COLOR });
  assert.deepEqual(outcomeCopy('Could not apply · tour · render_failed', 'error'),
    { text: 'Could not apply · tour', color: OUTCOME_FAILED_COLOR });
});

test('every plate line a shipped command can produce fits the two-line budget', () => {
  for (const field of [...OUTCOME_FIELD_WORDS.keys()]) {
    for (const [sentence, state] of [[`Applied · ${field} · revision 999999`, 'applied'],
      [`Waiting · ${field}`, 'waiting'], [`Could not apply · ${field}`, 'error']]) {
      const copy = outcomeCopy(sentence, state);
      assert.ok(copy.text.length <= PLATE_BUDGET, `${copy.text} is ${copy.text.length} characters`);
    }
  }
});

/**
 * The regression itself. A voice line used to be handed to this copy with a
 * hard-coded `waiting`, which is how an `Applied` plate became an orange
 * `Waiting · change` a second after every agent command. The copy cannot
 * defend itself against that -- there is nothing in "Sent to Claude" to say it
 * is not an outcome -- so `inspector.ts` no longer sends it. This pins what
 * such a call would still produce, and shows why the caller is the fix.
 */
test('a voice sentence is not an outcome and cannot be read as one', () => {
  assert.equal(outcomeCopy('Sent to Claude', 'waiting').text, 'Waiting · change');
});

test('a dropped dispatch hold keeps its reason on the wearer plate', () => {
  for (const text of [
    'The change was not sent because the panel stayed busy. Try again when the view is ready.',
    'The change was not sent because the previous cancelled change was still being restored. Try again when the view is ready.',
    'The previous change could not be restored. Load the saved view before trying again.',
    'The earlier request was dropped for your correction.',
  ]) assert.deepEqual(outcomeCopy(text,'error'),{text,color:OUTCOME_FAILED_COLOR});
});
