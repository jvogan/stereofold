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

test('agent moves that put the molecule back where they began give the next chapter its framing back', () => {
  // Shift left, shift right of the start, shift up, then put the start
  // translation and scale back: the pose the first move began from.
  const h = harness();
  const start = { scale: 0.615, translation: [-1.84, -1.54, -1.64], rotation: [-180, -70, -180] };
  h.place(start); h.hold.release('authored-chapter'); h.hold.chapterStart();
  const shifted = (dx, dy) => ({ ...start, translation: [start.translation[0] + dx, start.translation[1] + dy, start.translation[2]] });
  for (const pose of [shifted(-0.3, 0), shifted(0.3, 0), shifted(0, 0.15)]) assert.equal(h.place(pose), true);
  assert.equal(h.hold.holdsPlacement(), true);
  assert.equal(h.place({ ...start, translation: [...start.translation] }), 'returned');
  assert.equal(h.hold.holdsPlacement(), false, 'the molecule is back on the chapter seat, so no placement is held');
  assert.equal(h.hold.allowsChapterFraming(), true);
  // Undo of the put-back is the agent's placement again; redo gives it back.
  assert.equal(h.replay(shifted(0, 0.15)), true);
  assert.equal(h.hold.holdsPlacement(), true); assert.equal(h.hold.state().reason, 'agent-placement');
  assert.equal(h.replay(start), true);
  assert.equal(h.hold.holdsPlacement(), false);
  // A later move is a new agent placement as before.
  assert.equal(h.place(shifted(0.5, 0)), true);
  assert.equal(h.hold.holdsPlacement(), true); assert.equal(h.hold.state().reason, 'agent-placement');
});

test('an agent move from a chapter that ended cannot come back by undo or redo', () => {
  // Move, undo, Next, redo: the redo is the earlier chapter's edit.
  const h = harness();
  h.place(pose(5));
  assert.equal(h.replay(pose(0)), true);
  assert.equal(h.hold.holdsPlacement(), false);
  h.hold.endChapter(); h.hold.chapterStart();
  assert.equal(h.replay(pose(5)), false, 'the redo draws the pose, not the ended chapter\'s hold');
  assert.equal(h.hold.holdsPlacement(), false);
  const before = h.history.checkpoint(pose(5));
  assert.equal(h.history.returnsToChapterSeat(before, pose(0)), false, 'nor is that chapter\'s seat this chapter\'s');
  // Still held when the chapter ends: released, and undo cannot restore it either.
  const held = harness(); held.place(pose(5)); held.hold.endChapter();
  assert.equal(held.replay(pose(0)), false);
  assert.equal(held.replay(pose(5)), false);
  assert.equal(held.hold.holdsPlacement(), false);
});

test('a put-back is known to be the chapter\'s seat before it is made, and asking changes nothing', () => {
  const h = harness();
  const start = pose(0);
  for (const next of [pose(3), pose(7)]) h.place(next);
  const before = h.history.checkpoint(pose(7));
  assert.equal(h.history.returnsToChapterSeat(before, start), true);
  assert.equal(h.history.returnsToChapterSeat(before, pose(3)), false, 'part of the way back is still the agent\'s pose');
  assert.equal(h.history.returnsToChapterSeat(before, { ...start, translation: [0.001, 0, -2] }), false, 'near is not the seat');
  assert.equal(h.hold.holdsPlacement(), true, 'asking does not hand anything back');
  // Asking while the source reads differently answers no and forgets nothing.
  h.ctx.source = 'other';
  assert.equal(h.history.returnsToChapterSeat(before, start), false);
  h.ctx.source = 'source';
  assert.equal(h.history.returnsToChapterSeat(before, start), true, 'asking kept the records');
  assert.equal(h.place(start), 'returned');
  // Back to where a hand left the molecule is the hand's seat, not the chapter's.
  const grabbed = harness(); grabbed.hold.takeover('grab'); grabbed.place(pose(1));
  assert.equal(grabbed.history.returnsToChapterSeat(grabbed.history.checkpoint(pose(1)), pose(0)), false);
});

test('putting the molecule back keeps a hand placement and a pose that is only near the start', () => {
  const grabbed = harness(); grabbed.place(pose(1)); grabbed.hold.takeover('grab');
  assert.equal(grabbed.place(pose(0)), true);
  assert.equal(grabbed.hold.holdsPlacement(), true, 'a grab after the move is the wearer\'s own');
  assert.equal(grabbed.hold.state().reason, 'agent-placement');
  const beforeGrab = harness(); beforeGrab.hold.takeover('grab'); beforeGrab.place(pose(1));
  assert.equal(beforeGrab.place(pose(0)), 'returned');
  assert.equal(beforeGrab.hold.holdsPlacement(), true, 'back to where the hand left it is the hand\'s placement');
  assert.equal(beforeGrab.hold.state().reason, 'grab');
  const near = harness(); near.place(pose(1));
  assert.equal(near.place({ ...pose(0), translation: [0.001, 0, -2] }), true);
  assert.equal(near.hold.holdsPlacement(), true);
});

test('a chapter framing between the put-back and a later move breaks the run, so the move is the agent\'s', () => {
  const h = harness();
  h.place(pose(1)); assert.equal(h.place(pose(0)), 'returned');
  // An authored chapter frames another pose without taking ownership.
  const before = h.history.checkpoint(pose(5));
  assert.equal(h.history.accept(before, pose(0), () => h.hold.takeover('agent-placement')), true);
  assert.equal(h.hold.holdsPlacement(), true, 'placing it where it once began is a deliberate move now');
});

test('an undone put-back is pruned by later edits and never evicts a live undo record', () => {
  const h = harness();
  h.place(pose(1)); h.place(pose(2)); assert.equal(h.place(pose(0)), 'returned');
  assert.equal(h.replay(pose(2)), true, 'undo the put-back');
  assert.equal(h.hold.holdsPlacement(), true);
  // Thirty fresh moves fill the live history exactly: the two moves before
  // the put-back and these. The abandoned put-back must not take a slot.
  for (let n = 3; n <= INSPECTION_HISTORY_CAPACITY; n++) assert.equal(h.place(pose(n)), true);
  for (let n = INSPECTION_HISTORY_CAPACITY - 1; n >= 0; n--) assert.equal(h.replay(pose(n)), true, `undo to ${n}`);
  assert.equal(h.hold.holdsPlacement(), false, 'undoing every move gives the chapter its placement back');
});

test('a wearer\'s hold in between does not carry an ended chapter\'s agent move across by redo', () => {
  // Grab, agent move, undo, ordinary Next, redo.
  const h = harness();
  h.hold.takeover('grab');
  h.place(pose(5));
  assert.equal(h.replay(pose(0)), true);
  assert.equal(h.hold.state().reason, 'grab');
  h.hold.endChapter(); h.hold.chapterStart();
  assert.equal(h.hold.holdsPlacement(), true, 'the wearer\'s hold carries across');
  assert.equal(h.replay(pose(5)), true, 'the redo still draws its pose');
  assert.equal(h.hold.holdsPlacement(), false, 'but not the ended chapter\'s agent hold');
  assert.equal(h.replay(pose(0)), true, 'undo again gives the wearer\'s hold back');
  assert.equal(h.hold.holdsPlacement(), true); assert.equal(h.hold.state().reason, 'grab');
});
