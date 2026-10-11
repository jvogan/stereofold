import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { QUEST_EXIT_BANNER_KEY, noteQuestExitBanner } from './quest-exit-banner.mjs';

const source = path => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

const storage = () => {
  const held = new Map();
  return { held, getItem: key => (held.has(key) ? held.get(key) : null),
    setItem: (key, value) => { held.set(key, String(value)); } };
};

test('the note the handing-off tab leaves carries a timestamp and nothing else', () => {
  const store = storage();
  assert.equal(noteQuestExitBanner(store, () => 1_700_000_000_000), true);
  assert.deepEqual(JSON.parse(store.getItem(QUEST_EXIT_BANNER_KEY)), { at: 1_700_000_000_000 });
  // No capability, no address, no key: the page reads a moment, not a grant.
  assert.deepEqual(Object.keys(JSON.parse(store.getItem(QUEST_EXIT_BANNER_KEY))), ['at']);
});

test('a tab with no storage still hands off', () => {
  assert.equal(noteQuestExitBanner(undefined), false);
  assert.equal(noteQuestExitBanner(null), false);
  assert.equal(noteQuestExitBanner({ setItem: () => { throw Error('storage is off'); } }), false);
});

/**
 * The lab and the plugin do not share a module, so the two ends of this note
 * are pinned to each other here rather than trusted to stay in step.
 */
test('the lab writes the key the served page reads', () => {
  const plugin = source('../../plugin/src/quest-exit-banner.ts');
  assert.match(plugin, new RegExp(`QUEST_EXIT_BANNER_KEY = '${QUEST_EXIT_BANNER_KEY}'`));
});

test('the handoff writes the note before it navigates, and only then', () => {
  const viewer = source('./viewer.mjs');
  const handoff = viewer.slice(viewer.indexOf('navigate: () => {'), viewer.indexOf('navigate: () => {') + 240);
  assert.match(handoff, /noteQuestExitBanner\(/u);
  assert.ok(handoff.indexOf('noteQuestExitBanner(') < handoff.indexOf('location.assign('),
    'the note is left before the tab leaves');
  // Exactly one place writes it: the immersive handoff. A desktop workbench
  // press opens a side drawer and must never claim a banner is up.
  assert.equal(viewer.split('noteQuestExitBanner(').length - 1, 1, 'exactly one call site');
});
