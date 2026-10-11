/**
 * The spoken route into the residue browser, and the word it lost.
 *
 * On the Quest 2 "go to residue 141" came back from the Mac as
 * `Go to resident 141` and matched none of the browser's four shapes, and "go
 * to 141" transcribed exactly and the browser still did not move
 * The Mac already corrects the noun
 * against this scene's own residue numbers and records the correction as a
 * rule; what is pinned here is that the correction reaches the page, that the
 * raw reading is still tried first, and that a shut browser keeps the sentence
 * pointed at the molecule.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { attachVoiceCommandRunner, spatialVoiceAction } from './voice-command-runner.mjs';
import { createPushToTalkAudioEvents, transcriptFromResult } from './push-to-talk-audio.mjs';

function runner({ sequenceOpen = true } = {}) {
  const events = createPushToTalkAudioEvents(), dispatched = [], captions = [], recorded = [];
  const handle = attachVoiceCommandRunner({ events, sequenceOpen: () => sequenceOpen,
    dispatch: async action => { dispatched.push(action); },
    caption: text => captions.push(text),
    record: (kind, detail) => recorded.push({ kind, detail }),
  });
  return { events, dispatched, captions, recorded, ...handle };
}

test('the Mac’s corrected reading reaches the residue browser when the raw one resolved to nothing', async () => {
  const page = runner();
  try {
    page.events.emit({ state: 'heard', utteranceId: 'press-1', text: 'Go to resident 141',
      normalizedText: 'Go to residue 141' });
    await page.settled();
    assert.deepEqual(page.dispatched, [{ kind: 'sequence', op: 'goto', residue: 141, numbering: 'author' }]);
    assert.ok(page.captions.includes('Going to residue 141.'));
    const note = page.recorded.find(entry => entry.kind === 'voice-normalized');
    assert.deepEqual(note.detail, { heard: 'Go to resident 141', read: 'Go to residue 141' });
  } finally { page.dispose(); }
});

test('the raw reading is tried first and a correction never overrides one that resolved', async () => {
  const page = runner();
  try {
    page.events.emit({ state: 'heard', utteranceId: 'press-1', text: 'Go to residue 141',
      normalizedText: 'Go to residue 5' });
    await page.settled();
    assert.deepEqual(page.dispatched, [{ kind: 'sequence', op: 'goto', residue: 141, numbering: 'author' }]);
    assert.equal(page.recorded.some(entry => entry.kind === 'voice-normalized'), false);
  } finally { page.dispose(); }
});

test('an uncorrected misheard noun still reaches nobody, and says so once', async () => {
  const page = runner();
  try {
    page.events.emit({ state: 'heard', utteranceId: 'press-1', text: 'Go to resident 141' });
    await page.settled();
    assert.deepEqual(page.dispatched, []);
    const outcome = page.recorded.find(entry => entry.kind === 'voice-command');
    assert.equal(outcome.detail.outcome, 'unrecognized');
  } finally { page.dispose(); }
});

test('a shut browser keeps the same sentence pointed at the molecule', async () => {
  const page = runner({ sequenceOpen: false });
  try {
    page.events.emit({ state: 'heard', utteranceId: 'press-1', text: 'Go to resident 141',
      normalizedText: 'Go to residue 141' });
    await page.settled();
    assert.deepEqual(page.dispatched, [{ kind: 'focus-selection', framing: 'fill', residues: [141, 141] }]);
  } finally { page.dispose(); }
});

test('the transcript carries the Mac’s proposal beside the raw text, and only when it differs', () => {
  const withProposal = transcriptFromResult({ structuredContent: { transcript: { text: 'Go to resident 141',
    utteranceId: 'press-1', model: 'apple', durationMs: 900,
    normalizedText: 'Go to residue 141', normalizationRules: [{ rule: 'heard-resident' }] } } });
  assert.equal(withProposal.text, 'Go to resident 141');
  assert.equal(withProposal.normalizedText, 'Go to residue 141');
  assert.deepEqual(withProposal.normalizationRules, [{ rule: 'heard-resident' }]);

  const unchanged = transcriptFromResult({ structuredContent: { transcript: { text: 'Go to residue 141',
    utteranceId: 'press-2', normalizedText: 'Go to residue 141', normalizationRules: [] } } });
  assert.equal('normalizedText' in unchanged, false);
});

test('both readings resolve the browser jump through the same closed grammar', () => {
  const open = { sequenceOpen: true };
  assert.equal(spatialVoiceAction('go to residue 141', open).action.op, 'goto');
  assert.equal(spatialVoiceAction('go to 141', open).action.residue, 141);
  // The page's grammar is not widened to accept the misheard noun: the Mac's
  // scene-checked rule is the only thing that corrects it.
  assert.equal(spatialVoiceAction('go to resident 141', open), undefined);
});
