import { assistantStatus } from './assistant-status.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { toolbarFrameRuntime, toolbarFrameHarness, identity } from './fixtures/toolbar-frame-runtime.mjs';
import { attachGripPushToTalk } from './push-to-talk-grip.mjs';
import { syntheticViews } from './fixtures/component-label-diagnostics.mjs';

const eyesAtHead = () => syntheticViews().map(view => {
  const matrix = [...view.transform.matrix], inverse = [...view.transform.inverse.matrix];
  matrix[13] += 1.6; inverse[13] -= 1.6;
  return { ...view, transform: { matrix, inverse: { matrix: inverse } } };
});

const replies = ['Both dyskerin copies.',
  'Say show, tour, smaller, bigger, or open Mol*.',
  'Filament tier has no atoms. Switch to an atomic tier.'];
const chapter = { selectedId: 'lesson', active: true, title: 'The working part',
  progress: 'Scene 4/5', bodyPage: 'The RNA guides assembly.', autoplay: true };
const compact = text => text.replace(/\s/g, '');

test('held microphone and pending transcription keep persistent talking feedback', async () => {
  const runtime = await toolbarFrameRuntime();
  const live = new Set(), outcomes = [];
  const presentation = { add: repr => live.add(repr), remove: repr => live.delete(repr) };
  const h = toolbarFrameHarness(runtime, { presentation });
  let now = 0, frames = [], finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const card = runtime.createTalkCaption({ plugin: { runTask: task => task.run() }, presentation,
    head: () => ({ position: { x: 0, y: 1.6, z: 0 }, matrix: identity }), now: () => now,
    clearance: () => ({ views: eyesAtHead(), renderFromRoom: identity }) });
  runtime.setTalkOutcomeSink(text => { outcomes.push(text); card.set({ outcome: text }); });
  // Optional registration lets this regression execute against e506b87.
  runtime.setTalkProgressSink?.(state => card.set(state));
  assistantStatus.notePresence({ activeAssistant: 'Codex', voiceDelivery: { mode: 'polling', assistant: 'Codex' } });
  const talk = attachGripPushToTalk({ session: h.session, audio: null,
    interaction: { start: async () => {}, stop: () => pending },
    status: (text, progress) => h.toolbar.setStatus(text, undefined, progress) });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const advance = async ms => {
    now += ms;
    const due = frames; frames = [];
    due.forEach(callback => callback(now, h.frame));
    card.frame(); await flush();
  };
  const captions = () => [...live].filter(repr => repr.shape?.name === 'Stereofold caption');
  try {
    h.toolbar.syncPose(h.frame); await h.toolbar.update();
    h.session.requestAnimationFrame = callback => { frames.push(callback); return 1; };
    await h.toolbar.setStatus('Previous reply.'); await advance(0);
    card.set({ talking: true, sending: false, outcome: '' });
    await talk.start(); await flush(); await advance(0);
    await advance(runtime.CAPTION_OUTCOME_MS + 1000);
    assert.equal(talk.listening(), true, 'microphone remains held past three seconds');
    assert.equal(card.text(), 'Listening…', 'listening feedback remains visible');
    assert.equal(captions().length, 1);
    card.set({ progress: '' }); await flush();
    assert.equal(card.text(), 'Listening…', 'talking state remains set without progress text');
    await talk.stop(); await flush(); await advance(0);
    await advance(runtime.CAPTION_OUTCOME_MS + 1000);
    assert.equal(talk.listening(), false);
    assert.equal(card.text(), 'Transcribing…', 'pending transcription does not expire');
    card.set({ progress: '' }); await flush();
    assert.equal(card.text(), 'Sending…', 'sending state remains set');
    assert.deepEqual(outcomes, ['Previous reply.'], 'progress never enters the outcome sink');
    finish({ message: 'View reset.' }); await flush(); await advance(0);
    assert.equal(card.text(), 'View reset.');
    assert.equal(captions().length, 1, 'completed reply appears once');
    await advance(runtime.CAPTION_OUTCOME_MS);
    assert.equal(card.text(), '');
    assert.equal(captions().length, 0, 'completed reply expires');
  } finally {
    finish({ message: '' }); await flush();
    await talk.dispose();
    assistantStatus.resetPresence();
    runtime.setTalkProgressSink?.(undefined);
    runtime.setTalkOutcomeSink(undefined);
    await card.dispose(); await h.toolbar.dispose();
  }
});

test('each reply has one visible surface and leaves the tour caption unchanged', async () => {
  const runtime = await toolbarFrameRuntime();
  for (const tour of [{ ...chapter, active: false, captionCard: 'hidden' }, chapter, {}]) {
    const live = new Set();
    const presentation = { add: repr => live.add(repr), remove: repr => live.delete(repr) };
    const h = toolbarFrameHarness(runtime, { state: { tour }, presentation });
    let now = 0;
    const card = runtime.createTalkCaption({ plugin: { runTask: task => task.run() }, presentation,
      head: () => ({ position: { x: 0, y: 1.6, z: 0 }, matrix: identity }), now: () => now,
      clearance: () => ({ views: eyesAtHead(), renderFromRoom: identity }) });
    runtime.setTalkOutcomeSink(text => card.set({ outcome: text }));
    const rendered = () => [...live].filter(repr => repr.shape?.geometry?.lines?.length)
      .map(repr => ({ name: repr.shape.name, text: repr.shape.geometry.lines.join('') }));
    try {
      h.toolbar.syncPose(h.frame);
      await h.toolbar.update();
      h.session.requestAnimationFrame = () => 1; // Expiry is advanced explicitly below.
      const before = rendered().filter(row => row.name === 'Stereofold toolbar readout');
      assert.equal(before.length, tour.active ? 1 : 0);
      for (const reply of replies) {
        // Production local voice writes both; host replies write setStatus alone.
        for (const localVoice of [true, false]) {
          card.set({ sending: true });
          if (localVoice) runtime.showTalkOutcome(reply);
          await h.toolbar.setStatus(reply);
          await new Promise(resolve => setImmediate(resolve));
          const surfaces = rendered().filter(row => compact(row.text).includes(compact(reply).slice(0, 12)));
          assert.equal(surfaces.length, 1, `${reply}: one visible reply surface`);
          assert.equal(surfaces[0].name, 'Stereofold caption');
          assert.deepEqual(rendered().filter(row => row.name === 'Stereofold toolbar readout'), before);
          now += runtime.CAPTION_OUTCOME_MS - 1;
          card.frame();
          await new Promise(resolve => setImmediate(resolve));
          assert.equal(card.text(), reply, 'completed reply remains until its deadline');
          now += 1;
          card.frame();
          await new Promise(resolve => setImmediate(resolve));
          assert.deepEqual(rendered().filter(row => row.name === 'Stereofold caption'), []);
        }
      }
    } finally {
      runtime.setTalkOutcomeSink(undefined);
      await card.dispose();
      await h.toolbar.dispose();
    }
  }
});

test('growth replies cannot replace chapters or revive resting caption chrome', async () => {
  const { tourReadout } = await toolbarFrameRuntime();
  for (const spoken of ['Grown to a dimer.', 'Too big for this headset. Staying here.']) {
    const growth = { spoken, refused: true, atMs: 1000 };
    assert.deepEqual(tourReadout({ ...chapter, growth }, false, 1100), tourReadout(chapter, false, 1100));
    assert.deepEqual(tourReadout({ ...chapter, captionCard: 'hidden', growth }, false, 1100), []);
    assert.deepEqual(tourReadout({ ...chapter, active: false, growth }, false, 1100), []);
  }
  assert.deepEqual(tourReadout(undefined, true), []);
});

test('local growth and host growth notices deliver their reply to the talk card', async () => {
  const source = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
  const { createGrowthOverlay, growthOverlayFromNotice } = await import('./growth-caption.mjs');
  const start = source.indexOf('  function armGrowthCaption(');
  const end = source.indexOf('  try { globalThis.addEventListener?.(GROWTH_CAPTION_EVENT', start);
  assert.ok(start > 0 && end > start);
  const replies = [];
  const h = new Function('createGrowthOverlay', 'growthOverlayFromNotice', 'showTalkOutcome', `
    'use strict';
    let growthOverlay;
    const performance = { now: () => 1000 }, immersiveSession = undefined;
    const scheduleGrowthCaptionExpiry = () => {};
    ${source.slice(start, end)}
    return { armGrowthCaption, onHostGrowthCaption };
  `)(createGrowthOverlay, growthOverlayFromNotice, text => replies.push(text));
  h.armGrowthCaption('Grown to a dimer.');
  h.onHostGrowthCaption({ detail: { spoken: 'Too big for this headset. Staying here.', refused: true } });
  assert.deepEqual(replies, ['Grown to a dimer.', 'Too big for this headset. Staying here.']);
});
