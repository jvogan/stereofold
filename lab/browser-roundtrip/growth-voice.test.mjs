/**
 * "Grow it", said inside the headset, has to grow the molecule.
 *
 * `grow_structure` can swap a staged lesson's tier under a live immersive
 * session, and the Mac's own grammar (`plugin/src/inspection-voice.ts`) says
 * "grow it" to it.
 * The grammar the headset page itself reads — this one — had no growth phrase
 * at all, so the wearer's microphone was the one route to growth that did not
 * work: "grow it" came back "Sent to Claude" and the molecule stayed put.
 *
 * These run the real resolver over the real tables. Three properties are worth
 * keeping, and each has a test below:
 *
 * - The four command names are the Mac's four. One sentence cannot mean two
 *   different tiers depending on which side transcribed it.
 * - A grow is the one spoken command whose answer the page cannot compose. The
 *   host names the tier, and its sentence — a landing or a refusal — is what
 *   the wearer hears.
 * - A refusal is an answer, not a failure. The structure the wearer is looking
 *   at does not change and the refusal is read out in under twelve words.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spatialVoiceAction, spokenConfirmation, spokenGrowthLine, SPATIAL_VOICE_ACTIONS,
  SPOKEN_REPLY_MAX_WORDS, GROW_NOT_YET_SPOKEN, GROW_STILL_BUSY_SPOKEN } from './voice-command-runner.mjs';
import { VOICE_COMMANDS, voiceCommandFromTranscript } from './voice-command.mjs';

/** The refusal a Quest 2 gets for the tube, and for the tip above the ceiling. */
const CEILING_REFUSAL = 'Too big for this headset. Staying here.';

test('the growth commands are in the shared grammar', () => {
  for (const command of ['grow-structure', 'shrink-structure', 'grow-wall', 'grow-tip']) {
    assert.ok(VOICE_COMMANDS.includes(command), command);
    assert.ok(SPATIAL_VOICE_ACTIONS[command], `${command} has no immersive action`);
  }
});

test('each spoken phrase asks for the tier it names', () => {
  const stages = [
    ['grow it', 'next'], ['grow', 'next'], ['keep growing', 'next'], ['make it grow', 'next'],
    ['add tubulin', 'next'], ['add another tubulin', 'next'], ['grow the microtubule', 'next'],
    ['shrink it', 'back'], ['shrink', 'back'], ['take one away', 'back'], ['go back a tier', 'back'],
    ['build the wall', 'wall'], ['show the wall', 'wall'], ['make the wall', 'wall'],
    ['cap it', 'tip'], ['cap the end', 'tip'], ['show the tip', 'tip'], ['add the cap', 'tip'],
  ];
  for (const [phrase, stage] of stages) {
    const heard = spatialVoiceAction(phrase);
    assert.equal(heard?.action?.kind, 'grow-structure', phrase);
    assert.equal(heard.action.stage, stage, phrase);
  }
});

test('a trailing “it” is dropped before the lookup, so the bare stems have to be there', () => {
  // `trimFillers` strips a trailing `it`, so "grow it" reaches the tables as
  // `grow` and "cap it" as `cap`. A table holding only the long spelling would
  // match nothing at all for the two phrases a wearer actually says.
  for (const [spoken, bare] of [['grow it', 'grow'], ['shrink it', 'shrink'], ['cap it', 'cap']]) {
    assert.equal(voiceCommandFromTranscript(bare)?.command, voiceCommandFromTranscript(spoken)?.command, bare);
  }
});

test('filler in front and behind does not lose the tier', () => {
  for (const phrase of ['ok grow it', 'can you grow it please', 'so lets grow it now', 'hey stereofold grow it']) {
    assert.equal(spatialVoiceAction(phrase)?.action?.stage, 'next', phrase);
  }
  assert.equal(spatialVoiceAction('okay build the wall please')?.action?.stage, 'wall');
});

test('a negation is never stripped into a grow', () => {
  // The leading-filler walk stops at the first word that carries meaning, so
  // `don` ends the search before `grow` can be reached.
  for (const phrase of ['dont grow it', 'do not grow it', 'stop growing it', 'never grow it']) {
    assert.notEqual(spatialVoiceAction(phrase)?.action?.kind, 'grow-structure', phrase);
  }
});

test('what the wearer hears at the press is short enough to finish', () => {
  for (const command of ['grow-structure', 'shrink-structure', 'grow-wall', 'grow-tip']) {
    const say = SPATIAL_VOICE_ACTIONS[command].say;
    assert.ok(say.trim().split(/\s+/).length <= SPOKEN_REPLY_MAX_WORDS, `${command}: "${say}"`);
  }
});

test('the host names the tier, not the grammar', () => {
  const resolved = spatialVoiceAction('grow it');
  assert.equal(resolved.say, 'Growing.');
  // What `growthConfirmation` in plugin/src/molecular-growth.ts writes when the
  // dimer lands. The page has no way to know that sentence before it asks.
  assert.equal(spokenConfirmation(resolved, { spoken: 'Grown to one tubulin dimer.' }), 'Grown to one tubulin dimer.');
  assert.equal(spokenConfirmation(resolved, { spoken: 'Back to one tubulin monomer.' }), 'Back to one tubulin monomer.');
});

test('a refused tier is spoken, in the host’s own words', () => {
  // `grow_structure` returns a refusal through the same result as a landing,
  // because from the wearer's side both answer the question they asked. The
  // runner must not replace it with the optimistic "Capping the tip."
  const resolved = spatialVoiceAction('cap it');
  assert.equal(spokenConfirmation(resolved, { spoken: CEILING_REFUSAL }), CEILING_REFUSAL);
  assert.ok(CEILING_REFUSAL.split(/\s+/).length <= SPOKEN_REPLY_MAX_WORDS);
  for (const refusal of ['That is the last one. Nothing bigger here.', 'That is the smallest one already.',
    'You are looking at that one already.', 'I do not know that one. Try grow it.']) {
    assert.equal(spokenConfirmation(resolved, { spoken: refusal }), refusal, refusal);
    assert.ok(refusal.split(/\s+/).length <= SPOKEN_REPLY_MAX_WORDS, refusal);
  }
});

test('a busy panel wait line is short, and does not replace the host landing line', () => {
  const resolved = spatialVoiceAction('grow it');
  assert.ok(GROW_NOT_YET_SPOKEN.split(/\s+/).length <= SPOKEN_REPLY_MAX_WORDS);
  assert.ok(GROW_STILL_BUSY_SPOKEN.split(/\s+/).length <= SPOKEN_REPLY_MAX_WORDS);
  assert.equal(GROW_NOT_YET_SPOKEN, 'One moment.');
  assert.equal(GROW_STILL_BUSY_SPOKEN, 'Still busy. Try again.');
  // The wait is spoken during the retry, not as the confirmation. Once the
  // host answers, that sentence is what the wearer hears.
  assert.equal(spokenConfirmation(resolved, { spoken: 'Grown to one tubulin dimer.', retrying: true }),
    'Grown to one tubulin dimer.');
});

test('a host that answers nothing, or answers at length, leaves the short line standing', () => {
  const resolved = spatialVoiceAction('grow it');
  // A host too old to say anything, or one whose sentence would talk over the
  // wearer, falls back to the three syllables said at the press. Truncating a
  // long sentence would hide a Mac-side bug behind half a sentence read out in
  // the headset; the whole line is still recorded by the viewer's grow branch.
  for (const outcome of [undefined, {}, { spoken: '' }, { spoken: '   ' }, { spoken: 42 }]) {
    assert.equal(spokenConfirmation(resolved, outcome), 'Growing.', JSON.stringify(outcome));
  }
  const tooLong = Array.from({ length: SPOKEN_REPLY_MAX_WORDS + 1 }, (_, index) => `word${index}`).join(' ');
  assert.equal(spokenGrowthLine('Growing.', { spoken: tooLong }), 'Growing.');
  assert.equal(spokenGrowthLine('Growing.', { spoken: `${tooLong.split(' ').slice(1).join(' ')}` }),
    tooLong.split(' ').slice(1).join(' '));
});

test('growth phrases do not steal a phrase the grammar already had', () => {
  // Every one of these meant something before growth phrases existed, and has to keep
  // meaning it: a wearer's "next" is the next chapter, not the next tier.
  const unchanged = [['next', 'tour-next'], ['back', 'tour-back'], ['bigger', 'scale-larger'],
    ['smaller', 'scale-smaller'], ['show the whole thing', 'show-whole'], ['show microtubule', 'assemble-microtubule'],
    ['show tubulin', 'show-tubulin'], ['assemble filament', 'assemble-filament']];
  for (const [phrase, command] of unchanged) {
    assert.equal(voiceCommandFromTranscript(phrase)?.command, command, phrase);
  }
});
