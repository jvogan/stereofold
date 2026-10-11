import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentPlacementHistory } from './agent-placement-history.mjs';
import { createPlacementHold } from './wearer-placement.mjs';
import { INSPECTION_HISTORY_CAPACITY } from './inspection-state.mjs';
import { readFileSync } from 'node:fs';

const pose = n => ({ scale: 1 + n / 100, translation: [n / 100, 0, -2], rotation: [0, 0, 0] });
function harness() {
  const hold = createPlacementHold(), ctx = { session: {}, source: 'source' };
  const history = createAgentPlacementHistory({ hold, context: () => ({ ...ctx }) });
  let current = pose(0);
  return { hold, ctx, history,
    place(next) { const before = history.checkpoint(current); current = next; return history.accept(before, current, () => hold.takeover('agent-placement')); },
    replay(next) { const before = history.checkpoint(current); current = next; return history.replay(before, current); },
  };
}

test('ownership retention covers the entire actual host/local history capacity in both directions', () => {
  const host = readFileSync(new URL('../../plugin/src/inspection-operation.ts', import.meta.url), 'utf8');
  assert.equal(Number(host.match(/export const MAX_SCENE_HISTORY = (\d+)/)[1]), INSPECTION_HISTORY_CAPACITY);
  const h = harness();
  for (let n = 1; n <= INSPECTION_HISTORY_CAPACITY; n++) assert.equal(h.place(pose(n)), true);
  for (let n = INSPECTION_HISTORY_CAPACITY - 1; n >= 0; n--) assert.equal(h.replay(pose(n)), true);
  assert.equal(h.hold.holdsPlacement(), false);
  for (let n = 1; n <= INSPECTION_HISTORY_CAPACITY; n++) assert.equal(h.replay(pose(n)), true);
  assert.equal(h.hold.state().moves, INSPECTION_HISTORY_CAPACITY);
});

test('a newer physical owner at exactly the recorded pose cannot be undone by agent history', () => {
  const h = harness(); h.place(pose(1)); h.hold.takeover('grab');
  assert.equal(h.replay(pose(0)), false);
  assert.equal(h.hold.state().reason, 'grab');
});

test('new source and session contexts discard records but preserve owner state', () => {
  for (const field of ['source', 'session']) {
    const h = harness(); h.place(pose(1)); const before = h.hold.state();
    h.ctx[field] = field === 'source' ? 'changed-model' : {};
    assert.equal(h.replay(pose(0)), false); assert.deepEqual(h.hold.state(), before);
  }
});

test('chapter framing between undo and redo preserves the identity of the agent edit', () => {
  const h = harness(); h.place(pose(1)); h.replay(pose(0)); h.hold.chapterStart();
  // An automatic chapter may frame a different pose without taking ownership.
  const before = h.history.checkpoint(pose(8));
  assert.equal(h.history.replay(before, pose(1)), true);
  assert.equal(h.hold.state().reason, 'agent-placement');
});

test('unknown ownership metadata is refused rather than granting a synthetic physical hold', () => {
  assert.throws(() => createPlacementHold().restoreOwnership({ held: true }), /Unknown placement owner/);
});


test('a fresh edit after undo drops abandoned redo records before capacity eviction', () => {
  const h = harness();
  for (let n = 1; n <= INSPECTION_HISTORY_CAPACITY; n++) h.place(pose(n));
  h.replay(pose(INSPECTION_HISTORY_CAPACITY - 1));
  h.place(pose(99));
  assert.equal(h.replay(pose(INSPECTION_HISTORY_CAPACITY - 1)), true);
  for (let n = INSPECTION_HISTORY_CAPACITY - 2; n >= 0; n--) assert.equal(h.replay(pose(n)), true, `undo ${n}`);
  assert.equal(h.hold.holdsPlacement(), false);
});


test('undo preserves an older physical hold without renewing its expired chapter framing', () => {
  const h = harness(); h.hold.takeover('grab'); h.hold.chapterStart();
  assert.equal(h.hold.allowsChapterFraming(), true);
  h.place(pose(1)); assert.equal(h.hold.allowsChapterFraming(), false);
  h.replay(pose(0));
  assert.equal(h.hold.holdsPlacement(), true); assert.equal(h.hold.allowsChapterFraming(), true);
});
