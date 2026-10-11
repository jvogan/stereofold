import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { holdOutcomeLine } from './outcome-line.mjs';
import { STATUS_HOLD_MS, STATUS_MAX_HOLD_MS } from './spatial-toolbar.mjs';
import { attachVoiceCommandRunner } from './voice-command-runner.mjs';
import { createPushToTalkAudioEvents } from './push-to-talk-audio.mjs';

function statusCard() {
  const source = readFileSync(new URL('./spatial-toolbar.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('  function setStatus(');
  const fn = source.slice(start, source.indexOf('\n  }', start) + 4);
  let frames = [];
  const card = new Function('holdOutcomeLine', 'schedule', 'STATUS_HOLD_MS', 'STATUS_MAX_HOLD_MS', `
    'use strict';
    const PALETTE = { text: 0 }, session = { requestAnimationFrame: schedule };
    let closed = false, notice, cancelStatusHold = () => {};
    const update = async () => {};
    const showTalkOutcome = () => true;
    const showTalkProgress = () => {};
    ${fn}
    return { setStatus, text: () => notice?.text ?? '' };
  `)(holdOutcomeLine, callback => frames.push(callback), STATUS_HOLD_MS, STATUS_MAX_HOLD_MS);
  return { ...card, frame(time) { const due = frames; frames = []; due.forEach(callback => callback(time)); } };
}

test('a reply expires on XR frames at three seconds and an old expiry cannot clear a new turn', async () => {
  const card = statusCard();
  await card.setStatus('Tour started.');
  card.frame(0); card.frame(2999);
  assert.equal(card.text(), 'Tour started.');
  card.frame(3000);
  assert.equal(card.text(), '');
  await card.setStatus('Tour started.'); card.frame(4000);
  await card.setStatus('Listening…', undefined, 'listening'); card.frame(5000); card.frame(7000);
  assert.equal(card.text(), 'Listening…');
  card.frame(8000);
  assert.equal(card.text(), 'Listening…');
  await card.setStatus('Tour started.'); card.frame(9000); card.frame(12000);
  assert.equal(card.text(), '');
});

test('the tour start receipt is cleared at emphasis and never rewritten after dispatch', async () => {
  const card = statusCard(), spoken = [], written = [];
  const events = createPushToTalkAudioEvents();
  const runner = attachVoiceCommandRunner({ events,
    caption: text => { written.push(text); return card.setStatus(text); },
    speak: text => spoken.push(text),
    dispatch: async action => {
      assert.equal(action.kind, 'tour-play');
      assert.equal(card.text(), 'Tour started.');
      await card.setStatus(''); // viewer.emphasize, before the paint lands
      assert.equal(card.text(), '');
    },
  });
  events.emit({ state: 'heard', text: 'play the tour', utteranceId: 'tour' });
  await runner.settled();
  assert.equal(card.text(), '');
  assert.deepEqual(written, ['Tour started.', '']);
  assert.deepEqual(spoken, ['Tour started.']);
  runner.dispose();
});

test('an older command completion cannot replace the next turn reply', async () => {
  const card = statusCard(), events = createPushToTalkAudioEvents();
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const runner = attachVoiceCommandRunner({ events, caption: card.setStatus,
    dispatch: async () => pending });
  events.emit({ state: 'heard', text: 'play the tour', utteranceId: 'old' });
  await Promise.resolve();
  events.emit({ state: 'heard', text: 'help', utteranceId: 'new' });
  const latest = card.text();
  release(); await runner.settled();
  assert.ok(latest.length > 0);
  assert.equal(card.text(), latest);
  runner.dispose();
});
