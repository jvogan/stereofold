import { recordTalkReplySeat } from './talk-reply-diagnostics.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { installReplyAudio, REPLY_AUDIO_EVENT } from './reply-audio.mjs';
import { replyCaptionHoldMs, replySegmentsOf, REPLY_SEGMENT_EVENT } from './reply-segments.mjs';

// The probe uses the production player with synthetic audio. These
// tests also run the page's caption listeners so late segments cannot silently
// overwrite the newer text, even when the newer reply never starts any audio.
const source = readFileSync(new URL('./immersive-session.mjs', import.meta.url), 'utf8');
const listenerStart = source.indexOf('          const onReply = event => {');
const listenerEnd = source.indexOf('          globalThis.addEventListener?.(REPLY_CAPTION_EVENT', listenerStart);
assert.ok(listenerStart > 0 && listenerEnd > listenerStart);
const buildCaptionListeners = new Function('record', 'replySegmentsOf', 'replyCaptionHoldMs', 'recordTalkReplySeat',
  `${source.slice(listenerStart, listenerEnd)}\nreturn { onReply, onSegment };`);

const captionListeners = (...args) => buildCaptionListeners(...args, recordTalkReplySeat);

const clip = { base64: Buffer.from('synthetic ogg').toString('base64'), bytes: 13, mimeType: 'audio/ogg' };
const oldReply = { id: 'old', text: 'Old first. Old second.', speak: true,
  segments: [{ text: 'Old first.', audio: clip }, { text: 'Old second.', audio: clip }] };
const replacements = [
  { id: 'silent', text: 'Cancelled.', speak: false },
  { id: 'missing-audio', text: 'Correction.', speak: true },
  { id: 'silent-segments', text: 'Correction. Continue.', speak: true,
    segments: [{ text: 'Correction.', seconds: 0.001 }, { text: 'Continue.', seconds: 0.001 }] },
  { id: 'audible', text: 'New first. New second.', speak: true,
    segments: [{ text: 'New first.', audio: clip }, { text: 'New second.', audio: clip }] },
];
const flush = () => new Promise(resolve => setImmediate(resolve));

function harness({ deferDecode = false, elementFallback = false } = {}) {
  const handlers = new Map(), started = [], entries = [], captions = [], pending = [];
  const events = {
    addEventListener(type, handler) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type).add(handler);
    },
    removeEventListener(type, handler) { handlers.get(type)?.delete(handler); },
    dispatchEvent(event) { for (const handler of [...(handlers.get(event.type) ?? [])]) handler(event); },
  };
  const context = {
    state: 'running', destination: {}, resume: async () => {}, close: async () => {},
    decodeAudioData: () => deferDecode
      ? new Promise(resolve => pending.push(resolve)) : Promise.resolve({ duration: 10 }),
    createBufferSource() {
      const ends = new Set();
      const source = {
        stopped: false, connect() {},
        addEventListener(type, handler) { if (type === 'ended') ends.add(handler); },
        start() { started.push(source); },
        stop() { source.stopped = true; },
        end() { for (const handler of ends) handler(); },
      };
      return source;
    },
  };
  class Audio {
    stopped = false;
    play() { started.push(this); return new Promise(resolve => pending.push(resolve)); }
    pause() { this.stopped = true; }
  }
  const player = installReplyAudio({
    scope: { atob: globalThis.atob, Blob, URL: { createObjectURL: () => 'blob:synthetic', revokeObjectURL() {} },
      __stereofoldDiagnostics: { record: (kind, detail) => entries.push({ kind, detail }) } },
    target: events, Audio,
    contextFactory: () => { if (elementFallback) throw Error('Synthetic element fallback'); return context; },
    synth: { speak() {}, cancel() {} }, gestureTargets: [],
  });
  const listeners = captionListeners({ toolbar: { setStatus: text => captions.push(text) } }, replySegmentsOf, replyCaptionHoldMs);
  events.addEventListener(REPLY_AUDIO_EVENT, listeners.onReply);
  events.addEventListener(REPLY_SEGMENT_EVENT, listeners.onSegment);
  return { player, started, entries, captions, pending,
    reply: detail => events.dispatchEvent({ type: REPLY_AUDIO_EVENT, detail }) };
}

for (const replacement of replacements) {
  test(`${replacement.id} replacement immediately stops the old clip and drops its tail`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const h = harness();
    try {
      h.reply(oldReply);
      await flush();
      assert.equal(h.started.length, 1);
      assert.equal(h.captions.at(-1), 'Old first.');

      h.reply(replacement);
      assert.equal(h.started[0].stopped, true, 'old audio stops during replacement dispatch');
      assert.equal(h.captions.at(-1), replacement.segments?.[0].text ?? replacement.text);
      assert.deepEqual(h.entries.filter(e => e.kind === 'reply-segments-dropped'), [{
        kind: 'reply-segments-dropped',
        detail: { captionId: 'old', stoppedAt: 0, dropped: 1, total: 2, reason: 'replaced' },
      }]);
      const captionCount = h.captions.length;
      h.started[0].end(); // A stopped clip can still report its end late.
      await flush();
      assert.equal(h.started.length, replacement.id === 'audible' ? 2 : 1);
      assert.ok(h.captions.slice(captionCount).every(text => !text.startsWith('Old')));
      assert.equal(h.entries.filter(e => e.kind === 'reply-audio-play' && e.detail.captionId === 'old').length, 1);

      if (replacement.id === 'audible') {
        assert.equal(h.started[1].stopped, false);
        h.started[1].end();
        await flush();
        assert.equal(h.started.length, 3, 'the new second clip waits for the new first to end');
        assert.equal(h.captions.at(-1), 'New second.');
        h.started[2].end();
        await flush();
      } else if (replacement.id === 'silent-segments') {
        t.mock.timers.tick(1);
        await flush();
        assert.equal(h.captions.at(-1), 'Continue.', 'silent segments still advance in order');
      }
    } finally { await h.player.stop(); }
  });

  test(`${replacement.id} replacement invalidates an older pending decode`, async () => {
    const h = harness({ deferDecode: true });
    try {
      h.reply(oldReply);
      assert.equal(h.pending.length, 1);
      h.reply(replacement);
      h.pending[0]({ duration: 10 });
      await flush();
      assert.equal(h.started.length, 0, 'the old decode cannot start a clip after replacement');
      assert.ok(!h.captions.includes('Old second.'));
      if (replacement.id === 'audible') {
        h.pending[1]({ duration: 10 });
        await flush();
        assert.equal(h.started.length, 1);
        assert.equal(h.entries.find(e => e.kind === 'reply-audio-play').detail.captionId, 'audible');
      }
    } finally { await h.player.stop(); }
  });
}

test('repeated heartbeat IDs do not interrupt playback or revive an old reply', async () => {
  const h = harness();
  try {
    h.reply(replacements[0]);
    h.reply(oldReply);
    await flush();
    h.reply(oldReply);
    h.reply(replacements[0]);
    await flush();
    assert.equal(h.started.length, 1);
    assert.equal(h.started[0].stopped, false);
    assert.equal(h.entries.filter(e => e.kind === 'reply-segments-dropped').length, 0);
    h.started[0].end();
    await flush();
    assert.equal(h.started.length, 2, 'a repeated ID leaves the active queue intact');
  } finally { await h.player.stop(); }
});

test('a silent replacement pauses a pending media fallback and ignores its late completion', async () => {
  const h = harness({ elementFallback: true });
  try {
    h.reply(oldReply);
    assert.equal(h.started.length, 1);
    h.reply(replacements[0]);
    assert.equal(h.started[0].stopped, true);
    h.pending[0]();
    await flush();
    assert.equal(h.started.length, 1);
    assert.equal(h.captions.at(-1), 'Cancelled.');
    assert.equal(h.entries.filter(e => e.kind === 'reply-audio-play').length, 0);
    assert.equal(h.entries.find(e => e.kind === 'reply-segments-dropped').detail.dropped, 1);
  } finally { await h.player.stop(); }
});
