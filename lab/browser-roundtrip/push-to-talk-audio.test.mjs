import test from 'node:test';
import assert from 'node:assert/strict';
import { transcriptFromResult, createPushToTalkAudioEvents } from './push-to-talk-audio.mjs';
import { attachVoiceCommandRunner, AGENT_FORWARD_REPLY } from './voice-command-runner.mjs';

test('the page decision offer survives every recorder result envelope', () => {
  for (const wrap of [t => ({ transcript: t }), t => ({ structuredContent: { transcript: t } }),
    t => ({ structuredContent: t }), t => t]) {
    const transcript = transcriptFromResult(wrap({ text: 'Make it bigger.', pageDecision: 'offer' }));
    assert.equal(transcript.pageDecision, 'offer');
    assert.equal(transcriptFromResult(wrap({ text: 'Explain this.' })).pageDecision, undefined);
  }
});

for (const open of [true, false]) test(`the page decides using actual sequence context (browser open: ${open})`, async () => {
  const events = createPushToTalkAudioEvents(), actions = [], said = [], outcomes = [];
  const runner = attachVoiceCommandRunner({ events, agentAttached: () => true, sequenceOpen: () => open,
    dispatch: async action => { actions.push(action); return {}; }, caption: () => {}, speak: text => said.push(text),
    record: (kind, detail) => { if (kind === 'voice-command') outcomes.push(detail.outcome); } });
  try {
    const transcript = transcriptFromResult({ structuredContent: { transcript: {
      utteranceId: 'sequence-1', text: open ? 'Jump to 141.' : 'Find residue 141.', pageDecision: 'offer',
    } } });
    const decisions = [];
    const event = { decide: async handled => { decisions.push(handled); return handled; }, state: 'heard', utteranceId: transcript.utteranceId, text: transcript.text, transcript };
    events.emit(event);
    await runner.settled();
    assert.deepEqual(actions, open ? [{ kind: 'sequence', op: 'goto', residue: 141, numbering: 'author' }] : []);
    assert.deepEqual(decisions, [open]);
    assert.equal(outcomes.includes('forwarded'), !open);
    assert.equal(said.includes(AGENT_FORWARD_REPLY), !open);
    const replies = said.length;
    assert.ok(replies > 0);
    events.emit(event);
    await runner.settled();
    assert.equal(said.length, replies);
    assert.equal(actions.length, open ? 1 : 0);
  } finally { runner.dispose(); }
});
