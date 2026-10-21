import test from 'node:test';
import assert from 'node:assert/strict';
import { attachGripPushToTalk } from './push-to-talk-grip.mjs';
import { assistantStatus, NOBODY_LISTENING_LINE } from './assistant-status.mjs';
import { pushToTalkAudioEvents } from './push-to-talk-audio.mjs';

for (const mode of ['none', 'channel', 'polling']) test(`release caption is immediate with ${mode} delivery and does not wait for transcription`, async () => {
  const shown = [], edges = [];
  let finish, stops = 0;
  const pending = new Promise(resolve => { finish = resolve; });
  assistantStatus.notePresence({ activeAssistant: 'Codex', agentAttached: true, voiceDelivery: { mode, assistant: 'Codex' } });
  const talk = attachGripPushToTalk({ session: new EventTarget(),
    send: state => { edges.push(state); }, status: text => shown.push(text),
    audio: { start() {}, stop() { stops++; return pending; }, dispose() {} } });
  try {
    await talk.start();
    const stopped = talk.stop();
    assert.equal(shown.at(-1), mode === 'none' ? NOBODY_LISTENING_LINE : 'Transcribing…');
    assert.equal(stops, 1);
    pushToTalkAudioEvents().emit({ state: 'transcribing' });
    assert.equal(shown.at(-1), mode === 'none' ? NOBODY_LISTENING_LINE : 'Transcribing…');
    finish(); await stopped;
    pushToTalkAudioEvents().emit({ state: 'idle' });
    if (mode === 'none') assert.equal(shown.at(-1), NOBODY_LISTENING_LINE);
  } finally { finish(); await talk.dispose(); assistantStatus.resetPresence(); }
  assert.deepEqual(edges, ['down', 'up']);
});

test('release rereads the listener after handoff and also warns without an audio route', async () => {
  const shown = [];
  assistantStatus.notePresence({ activeAssistant: 'Claude', voiceDelivery: { mode: 'channel', assistant: 'Claude' } });
  const talk = attachGripPushToTalk({ session: new EventTarget(), audio: null, send() {}, status: text => shown.push(text) });
  try {
    await talk.start();
    assistantStatus.notePresence({ activeAssistant: 'Codex', agentAttached: true, voiceDelivery: { mode: 'none', assistant: 'Codex' } });
    await talk.stop();
    assert.equal(shown.at(-1), NOBODY_LISTENING_LINE);
  } finally { await talk.dispose(); assistantStatus.resetPresence(); }
});
