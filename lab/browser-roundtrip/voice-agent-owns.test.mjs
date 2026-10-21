// The recording page resolves its own grammar, then obtains permission to act.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_FORWARD_REPLY, attachVoiceCommandRunner } from './voice-command-runner.mjs';
import { createPushToTalkAudioEvents } from './push-to-talk-audio.mjs';

function page(listening, grant = true) {
  const events = createPushToTalkAudioEvents(), dispatched = [], said = [], decisions = [];
  const runner = attachVoiceCommandRunner({ events, agentAttached: () => listening,
    dispatch: async action => { dispatched.push(action.kind); return {}; },
    caption: () => {}, speak: text => { said.push(text); }, record: () => {} });
  let n = 0;
  const hear = async text => {
    const utteranceId = `u-${++n}`;
    const event = { state: 'heard', utteranceId, text, transcript: { utteranceId, text, pageDecision: 'offer' },
      decide: async handled => { decisions.push(handled); return grant && handled; } };
    events.emit(event);
    await runner.settled();
    events.emit(event);
    await runner.settled();
  };
  return { runner, hear, dispatched, said, decisions };
}

for (const listening of [true, false]) test(`page grammar owns only actions (Claude listening: ${listening})`, async () => {
  const t = page(listening);
  try {
    for (const text of ['Play.', 'Make it bigger.', 'Go back.', 'Highlight the ATP.']) await t.hear(text);
    assert.deepEqual(t.dispatched, ['tour-play', 'scale']);
    assert.deepEqual(t.decisions, [true, true, false, false]);
    if (listening) assert.equal(t.said[2], AGENT_FORWARD_REPLY);
    else assert.match(t.said[2], /Nothing to return from/);
    if (listening) assert.equal(t.said.at(-1), AGENT_FORWARD_REPLY);
  } finally { t.runner.dispose(); }
});

test('a late local claim cannot act after the host released the sentence', async () => {
  const t = page(true, false);
  try {
    await t.hear('Make it bigger.');
    assert.deepEqual(t.dispatched, []);
    assert.deepEqual(t.decisions, [true]);
    assert.deepEqual(t.said, [AGENT_FORWARD_REPLY]);
  } finally { t.runner.dispose(); }
});
