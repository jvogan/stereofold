import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { attachVoiceCommandRunner, spatialVoiceAction } from './voice-command-runner.mjs';
import { createPushToTalkAudioEvents } from './push-to-talk-audio.mjs';
import { createLessonKeyMemory, normalizeEmphasisState, planLessonEmphasis,
  resolveEmphasisPartId, resolveEmphasisPartIds } from './lesson-emphasis.mjs';

const lesson = JSON.parse(readFileSync(new URL('../../plugin/demos/telomerase-haca.json', import.meta.url), 'utf8'));
const parts = lesson.chapters[0].immersive.emphasis.parts;
const short = line => assert.ok(line.trim().split(/\s+/).length <= 12, line);

// Each invocation is the first utterance in a freshly attached session, with
// the resting lesson key installed but no tour or prior emphasis command.
async function firstUtterance(text, attached = false, options = {}) {
  const events = createPushToTalkAudioEvents();
  const actions = [], spoken = [], captions = [], records = [], forwarded = [];
  // The Mac's transcript stream is a broadcast; local answers must not eat it.
  const unsubscribe = events.on(event => { if (attached && event.state === 'heard') forwarded.push(event.text); });
  const runner = attachVoiceCommandRunner({ events,
    dispatch: async action => actions.push(action),
    speak: line => { short(line); spoken.push(line); }, caption: line => captions.push(line),
    record: (kind, detail) => records.push({ kind, ...detail }),
    agentAttached: () => attached, lessonParts: () => parts, lesson: () => lesson, ...options });
  try {
    events.emit({ state: 'heard', utteranceId: 'first', text });
    await runner.settled();
    return { actions, spoken, captions, records, forwarded };
  } finally { runner.dispose(); unsubscribe(); }
}

for (const phrase of ['Show me the RNA', 'show the RNA', 'highlight the RNA']) {
  test(`telomerase first utterance: ${phrase}`, async () => {
    const result = await firstUtterance(phrase);
    assert.deepEqual(result.actions, [{ kind: 'emphasize-part', part: 'htr-b', framing: 'context' }]);
    assert.deepEqual(result.spoken, ['Telomerase RNA H/ACA domain.']);
  });
}

for (const phrase of ['Show me dyskerin', 'show dyskerin']) {
  test(`telomerase first utterance: ${phrase}`, async () => {
    const result = await firstUtterance(phrase);
    assert.deepEqual(result.actions, [{ kind: 'emphasize-part', parts: ['dyskerin-c', 'dyskerin-g'], framing: 'context' }]);
    assert.deepEqual(result.spoken, ['Both dyskerin copies.']);
    const focus = result.actions[0].parts.map(id => resolveEmphasisPartId(parts, id));
    const plan = planLessonEmphasis({ parts, focus }, ({ chain }) => [chain], parts.map(part => part.chain));
    assert.deepEqual(plan.lit, ['C', 'G']);
    assert.deepEqual(plan.explained.map(part => part.id), ['dyskerin-c', 'dyskerin-g']);
    assert.ok(!plan.faded.includes('C') && !plan.faded.includes('G'));
  });
}

for (const [phrase, part] of [
  ['show me the first dyskerin', 'dyskerin-c'], ['dyskerin one', 'dyskerin-c'],
  ['show me the second dyskerin', 'dyskerin-g'], ['dyskerin two', 'dyskerin-g'],
]) {
  test(`telomerase first utterance: ${phrase}`, async () => {
    const result = await firstUtterance(phrase);
    assert.deepEqual(result.actions, [{ kind: 'emphasize-part', part, framing: 'context' }]);
    assert.deepEqual(result.spoken, [`${parts.find(value => value.id === part).label}.`]);
  });
}

test('all telomerase chapters supply aliases and precise copy names after normalization and memory', () => {
  for (const chapter of lesson.chapters) {
    const memory = createLessonKeyMemory();
    memory.remember(normalizeEmphasisState(chapter.immersive.emphasis));
    const key = memory.parts({ parts: [] });
    for (const [name, ids] of [
      ['the RNA', ['htr-b']], ['THE DKC1', ['dyskerin-c', 'dyskerin-g']],
      ['dyskerin', ['dyskerin-c', 'dyskerin-g']], ['NOP10', ['nop10-f', 'nop10-j']],
      ['NHP2', ['nhp2-e', 'nhp2-i']], ['GAR1', ['gar1-d', 'gar1-h']], ['TCAB1', ['tcab1-k']],
      ['first DKC1', ['dyskerin-c']], ['DKC1 2', ['dyskerin-g']],
    ]) assert.deepEqual(resolveEmphasisPartIds(key, name), ids, `${chapter.id}: ${name}`);
    for (const part of key) {
      assert.equal(resolveEmphasisPartId(key, part.id), part.id);
      assert.equal(resolveEmphasisPartId(key, part.label), part.id);
    }
    assert.equal(resolveEmphasisPartId(key, 'dyskerin'), undefined, 'singular callers cannot choose an arbitrary copy');
    for (const name of ['dys', 'unknown RNA', 'third dyskerin', 'dyskerin three', 'not dyskerin'])
      assert.deepEqual(resolveEmphasisPartIds(key, name), []);
  }
  assert.deepEqual(resolveEmphasisPartIds([{ id: 'cas9', label: 'Cas9 protein' }], 'the PROTEIN'), ['cas9']);
});

for (const attached of [false, true]) {
  for (const phrase of ['What am I looking at?', 'what is this?']) {
    test(`telomerase first utterance: ${phrase}, agent ${attached}`, async () => {
      const result = await firstUtterance(phrase, attached);
      assert.deepEqual(result.actions, []);
      assert.deepEqual(result.spoken, [lesson.title]);
      assert.deepEqual(result.captions, [lesson.title]);
      assert.equal(result.records.at(-1).outcome, attached ? 'forwarded' : 'answered');
      assert.deepEqual(result.forwarded, attached ? [phrase] : []);
    });
  }
  for (const phrase of ['Help', 'what can I say?']) {
    test(`telomerase first utterance: ${phrase}, agent ${attached}`, async () => {
      const result = await firstUtterance(phrase, attached);
      assert.deepEqual(result.actions, []);
      assert.deepEqual(result.spoken, ['Say show, tour, smaller, bigger, or open Mol*.']);
      assert.equal(result.records.at(-1).outcome, 'answered');
    });
  }
  for (const phrase of ['Return', 'go back']) {
    test(`telomerase first utterance: ${phrase}, agent ${attached}`, async () => {
      const result = await firstUtterance(phrase, attached);
      assert.deepEqual(result.actions, []);
      assert.deepEqual(result.spoken, ['Nothing to return from. You are already here.']);
      assert.equal(result.records.at(-1).outcome, 'answered');
    });
  }
}

test('offline fallback offers a next attempt; attached fallback still acknowledges the agent', async () => {
  assert.deepEqual((await firstUtterance('unfamiliar request')).spoken, ['Not a command. Try show, tour, or smaller.']);
  assert.deepEqual((await firstUtterance('unfamiliar request', true)).spoken, ['Asking Claude.']);
});

test('identity reads the current lesson and handles absent, throwing, and long metadata', async () => {
  const other = { title: 'Another loaded lesson' };
  assert.deepEqual((await firstUtterance('what is this?', false, { lesson: () => other })).spoken, [other.title]);
  const long = { title: 'word '.repeat(15), summary: 'A short lesson summary.' };
  assert.equal(spatialVoiceAction('what is this?', { lesson: long }).say, long.summary);
  short(spatialVoiceAction('what is this?', { lesson: { title: long.title } }).say);
  for (const probe of [undefined, () => { throw Error('unavailable'); }]) {
    assert.deepEqual((await firstUtterance('what is this?', false, { lesson: probe })).spoken,
      ['No lesson is loaded. Try show, tour, or smaller.']);
  }
  short(spatialVoiceAction('show me protein', { lessonParts: [{ id: 'p', label: `protein ${'word '.repeat(15)}`, aliases: ['protein'] }] }).say);
});

for (const [phrase, action, spinning] of [
  ['make it smaller', { kind: 'scale', direction: -1 }, false],
  ['back', { kind: 'tour-back' }, false],
  ['play the tour', { kind: 'tour-play', playing: true }, false],
  ['stop', { kind: 'tour-play', playing: false }, false],
  ['stop', { kind: 'toggle-motion', paused: true }, true],
  ['open it on the Mac', { kind: 'open-workbench', target: 'mac' }, false],
]) {
  test(`telomerase preserves device behavior: ${phrase}, spinning ${spinning}`, async () => {
    assert.deepEqual((await firstUtterance(phrase, false, { spinning: () => spinning })).actions, [action]);
  });
}

test('production session supplies the selected lesson title and viewer paints grouped ids together', () => {
  const session = readFileSync(new URL('./immersive-session.mjs', import.meta.url), 'utf8');
  assert.match(session, /lesson: \(\) => \(\{ title: getSpatialTour\(\)\?\.getState\?\.\(\)\?\.selectedTitle \}\)/);
  const viewer = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
  assert.match(viewer, /action\.parts\.map\(name => resolveEmphasisPartId\(key, name\)\)/);
  assert.match(viewer, /return emphasize\(\{ parts: key, focus: ids,/);
});
