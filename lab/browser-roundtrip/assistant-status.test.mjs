import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAssistantStatus, AGENT_PRESENCE_TTL_MS, NOBODY_LISTENING_LINE } from './assistant-status.mjs';

function fixture() {
  let time = 1_000, expire;
  const status = createAssistantStatus({ now: () => time, setTimer: fn => { expire = fn; }, clearTimer() {} });
  return { status, advance(ms) { time += ms; expire?.(); } };
}

test('line 1 and captions share delivery for the active assistant, never attachment alone', () => {
  const { status, advance } = fixture();
  assert.deepEqual(status.lines(), ['No assistant connected', 'Hold A or X to talk', 'No action applied yet']);
  for (const assistant of ['Claude', 'Codex', 'My assistant']) {
    for (const mode of ['channel', 'polling']) {
      status.notePresence({ activeAssistant: assistant, agentAttached: false, voiceDelivery: { mode, assistant } });
      assert.equal(status.lines()[0], `${assistant} is listening`);
      assert.equal(status.listeningLine(), status.lines()[0]);
      assert.equal(status.releaseLine(), '');
    }
    for (const voiceDelivery of [undefined, { mode: 'none', assistant }, { mode: 'channel', assistant: 'Somebody else' }]) {
      status.notePresence({ activeAssistant: assistant, agentAttached: true, voiceDelivery });
      assert.equal(status.lines()[0], `${assistant} is connected, not listening to voice`);
      assert.equal(status.listeningLine(), 'Listening…');
      assert.equal(status.releaseLine(), NOBODY_LISTENING_LINE);
    }
  }
  status.notePresence({ activeAssistant: 'Codex', agentAttached: false, voiceDelivery: { mode: 'none' } });
  assert.equal(status.lines()[0], 'Codex is connected, not listening to voice');
  status.notePresence({ activeAssistant: null, agentAttached: true, voiceDelivery: { mode: 'channel', assistant: 'Claude' } });
  assert.equal(status.lines()[0], 'No assistant connected');
  status.notePresence({ activeAssistant: 'Codex', voiceDelivery: { mode: 'polling', assistant: 'Codex' } });
  advance(AGENT_PRESENCE_TTL_MS + 1);
  assert.equal(status.lines()[0], 'No assistant connected');
  assert.equal(status.releaseLine(), NOBODY_LISTENING_LINE);
});

test('line 2 shows each microphone state and then the transcript', () => {
  const { status } = fixture();
  for (const [states, line] of [
    [['idle'], 'Hold A or X to talk'],
    [['starting', 'requesting-microphone'], 'Starting microphone...'],
    [['recording', 'listening'], 'Listening...'],
    [['sending', 'transcribing', 'uploading'], 'Transcribing...'],
    [['error'], 'Microphone unavailable'],
  ]) for (const microphone of states) { status.update({ microphone }); assert.equal(status.lines()[1], line); }
  status.update({ heard: 'pause animation' });
  assert.equal(status.lines()[1], 'Heard: pause animation');
  status.update({ microphone: 'idle' });
  assert.equal(status.lines()[1], 'Heard: pause animation');
  status.update({ microphone: 'requesting-microphone' });
  status.update({ microphone: 'idle' });
  assert.equal(status.lines()[1], 'Hold A or X to talk');
  status.update({ heard: 'long transcript '.repeat(30) });
  assert.ok(status.lines()[1].length <= 47);
});

test('line 3 accepts assistant rendered receipts and local actions, with immutable attribution', () => {
  const { status } = fixture();
  const receipt = { commandId: 'command-1', assistantName: 'Claude', action: 'paused animation' };
  for (const state of ['queued', 'rendering', 'saved', 'rejected', 'expired', 'cancelled']) {
    status.renderedCommand({ ...receipt, status: state });
    assert.equal(status.lines()[2], 'No action applied yet');
  }
  status.renderedCommand({ ...receipt, status: 'rendered' });
  assert.equal(status.lines()[2], 'Claude: paused animation');
  status.notePresence({ activeAssistant: 'Codex', agentAttached: true });
  assert.equal(status.lines()[2], 'Claude: paused animation');
  status.update({ action: { status: 'rendered', source: 'Headset', text: 'stopped spinning' } });
  assert.equal(status.lines()[2], 'Headset: stopped spinning');
  status.renderedCommand({ ...receipt, status: 'rendered' });
  status.renderedCommand({ status: 'rendered' });
  assert.equal(status.lines()[2], 'Headset: stopped spinning');
  status.renderedCommand({ ...receipt, commandId: 'command-2', assistantName: 'Codex', status: 'rendered' });
  assert.equal(status.lines()[2], 'Codex: paused animation');
});

test('unchanged heartbeat, mode, transcript and receipt text cause no extra redraws; expiry draws once', () => {
  const { status, advance } = fixture(); let updates = 0;
  const off = status.subscribe(() => updates++);
  for (let i = 0; i < 100; i++) status.notePresence({ activeAssistant: 'Claude', voiceDelivery: { mode: i % 2 ? 'channel' : 'polling', assistant: 'Claude' } });
  assert.equal(updates, 1);
  for (let i = 0; i < 100; i++) status.update({ heard: 'pause animation' });
  assert.equal(updates, 2);
  for (let i = 0; i < 100; i++) status.renderedCommand({ commandId: `command-${i}`, status: 'rendered', assistantName: 'Claude', action: 'paused animation' });
  assert.equal(updates, 3);
  advance(AGENT_PRESENCE_TTL_MS + 1);
  assert.equal(updates, 4);
  advance(AGENT_PRESENCE_TTL_MS);
  assert.equal(updates, 4);
  off(); status.update({ microphone: 'listening' });
  assert.equal(updates, 4);
});

test('inspector routes confirmed assistant commands and both heartbeat paths into the shared status', () => {
  const source = readFileSync(new URL('../../plugin/src/inspector.ts', import.meta.url), 'utf8');
  assert.match(source, /assistantStatus\.renderedCommand\(data\)/);
  assert.match(source, /showOutcome\(\{\.\.\.next\.command,fields\}\)/);
  assert.equal(source.match(/assistantStatus\.notePresence\(privateState\)/g)?.length, 2);
});
