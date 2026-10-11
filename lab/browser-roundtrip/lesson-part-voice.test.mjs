import test from 'node:test';
import assert from 'node:assert/strict';
import { lessonPartVoiceCommand, voiceCommandFromTranscript } from './voice-command.mjs';
import { spatialVoiceAction } from './voice-command-runner.mjs';

/** The CRISPR lesson's own colour key, in the words the wearer reads. */
const PARTS = [
  { id: 'protein', label: 'Cas9 protein' },
  { id: 'guide-rna', label: 'guide RNA' },
  { id: 'pam', label: 'PAM' },
];

test('the wearer asks for a part the way a person asks for one', () => {
  for (const said of [
    'show me the guide RNA',
    'Show me the guide RNA again',
    'show the guide rna',
    'show guide RNA again',
    'where is the guide RNA',
    'highlight the guide rna',
  ]) {
    assert.equal(lessonPartVoiceCommand(said, PARTS)?.partId, 'guide-rna', said);
  }
});

test('the reply is the part’s own name, in under four words', () => {
  const heard = lessonPartVoiceCommand('show me the guide RNA', PARTS);
  assert.equal(heard.say, 'guide RNA.');
  assert.ok(heard.say.split(' ').length < 4);
  assert.deepEqual(heard.action, { kind: 'emphasize-part', part: 'guide-rna', framing: 'context' });
});

test('only the loaded lesson’s own parts can be asked for', () => {
  // The same sentence means nothing when the lesson does not name that part,
  // and means nothing at all when no lesson is loaded.
  assert.equal(lessonPartVoiceCommand('show me the ribosome', PARTS), undefined);
  assert.equal(lessonPartVoiceCommand('show me the guide RNA', []), undefined);
  assert.equal(lessonPartVoiceCommand('', PARTS), undefined);
});

test('a fixed command keeps its meaning, whatever a lesson calls its parts', () => {
  // "show me around" is the tour, and it must stay the tour even in a lesson
  // that happens to name a part "around".
  const trap = [{ id: 'around', label: 'around' }, { id: 'whole thing', label: 'whole thing' }];
  assert.equal(voiceCommandFromTranscript('show me around').command, 'tour-play');
  assert.equal(lessonPartVoiceCommand('show me around', trap), undefined);
  assert.equal(lessonPartVoiceCommand('show me the whole thing', trap), undefined);
});

test('an id spelled differently from its label still resolves', () => {
  assert.equal(lessonPartVoiceCommand('show me the guide rna', PARTS)?.partId, 'guide-rna');
  assert.equal(lessonPartVoiceCommand('show me the pam', PARTS)?.partId, 'pam');
});

// The grammar above was once exported, tested and
// called by nothing. "Show me the guide RNA" reached the runner, matched no
// table and no parser, and the wearer was told "Not a command" about a part the
// chapter in front of them had just named. These run the real runner entry
// point the push-to-talk stream calls.

test('the immersive runner resolves a lesson part into an emphasize action', () => {
  const resolved = spatialVoiceAction('show me the guide RNA', { lessonParts: PARTS });
  assert.equal(resolved.action.kind, 'emphasize-part');
  assert.equal(resolved.action.part, 'guide-rna');
  assert.equal(resolved.say, 'guide RNA.');
  // The runner adds its own reading of the utterance to whatever matched it.
  assert.equal(resolved.phrase, 'show me the guide rna');
  assert.equal(resolved.transcript, 'show me the guide rna');
});

test('the same sentence is not a command when no lesson names that part', () => {
  assert.equal(spatialVoiceAction('show me the guide RNA'), undefined);
  assert.equal(spatialVoiceAction('show me the guide RNA', { lessonParts: [] }), undefined);
  assert.equal(spatialVoiceAction('show me the ribosome', { lessonParts: PARTS }), undefined);
});

test('a lesson’s nouns never take a fixed phrase or a chain letter away', () => {
  // The exact tables run first, so a lesson that names a part "around" cannot
  // turn "show me around" into an emphasis.
  const trap = [{ id: 'around', label: 'around' }];
  assert.equal(spatialVoiceAction('show me around', { lessonParts: trap }).action.kind, 'tour-play');
  // And the value-carrying parsers run after, so a part named in the colour key
  // wins over the chain letter reading of the same sentence.
  assert.equal(spatialVoiceAction('show me chain b', { lessonParts: PARTS }).action.kind, 'focus-selection');
  assert.equal(spatialVoiceAction('show me chain b',
    { lessonParts: [{ id: 'chain-b', label: 'chain B' }] }).action.kind, 'emphasize-part');
});

test('a spinning structure still claims “stop” ahead of any lesson noun', () => {
  const parts = [{ id: 'stop', label: 'stop' }];
  assert.equal(spatialVoiceAction('stop', { spinning: true, lessonParts: parts }).action.kind, 'toggle-motion');
});
