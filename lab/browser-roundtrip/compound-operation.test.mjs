import test from 'node:test';
import assert from 'node:assert/strict';
import { createInspectionState, normalizeAppearance, sameAppearance } from './inspection-state.mjs';

test('normalized appearance equality distinguishes a real render change from a repeated tour look', () => {
  const base = normalizeAppearance({ representation: 'cartoon', color: 'chain-id', opacity: 1, fog: 30 });
  // A chapter is allowed to repeat a complete look or a sparse patch; after
  // normalization both mean the same renderer inputs and must not rebuild.
  assert.equal(sameAppearance(base, normalizeAppearance({ fog: 30 }, base)), true);
  assert.equal(sameAppearance(base, normalizeAppearance({ fog: 10 }, base)), false);
});
import { applyCompoundChange, compoundOps, COMPOUND_OP_KINDS } from './compound-change.mjs';

/** The change the host sends for "make it orange, fade the rest and enlarge it". */
const CHANGE = { kind: 'compound', patch: { ops: [
  { kind: 'emphasis', patch: { parts: [{ id: 'rna', label: 'guide RNA', color: '#ffaa33', chain: 'B' }], focus: ['rna'], contextOpacity: 0.18 } },
  { kind: 'appearance', patch: { opacity: 0.5 } },
  { kind: 'placement', patch: { scale: 2 } },
] } };

test('one request leaves one thing to undo, whatever it changed', () => {
  const state = createInspectionState();
  state.configure({ background: '#101010' }, 'setup');
  const before = state.snapshot();
  assert.equal(before.history.undoCount, 1);

  state.beginGroup('agent-compound');
  state.configure({ opacity: 0.5 }, 'configure');
  state.place({ scale: 2 }, 'place');
  state.recordPayload({ selectionKeys: ['A:1'] }, 'selection');
  state.endGroup();

  const after = state.snapshot();
  assert.equal(after.appearance.opacity, 0.5);
  assert.equal(after.placement.scale, 2);
  // Three edits, one entry. Before this the wearer pressed undo three times
  // and watched the picture step back through states nobody asked for.
  assert.equal(after.history.undoCount, 2);
  assert.equal(after.history.lastAction, 'agent-compound');

  const undone = state.undo();
  assert.equal(undone.appearance.opacity, 1);
  assert.equal(undone.placement.scale, 1);
  assert.equal(undone.appearance.background, '#101010');
  assert.equal(undone.history.undoCount, 1);
});

test('a group that is never opened records every edit as before', () => {
  const state = createInspectionState();
  state.configure({ opacity: 0.5 }, 'configure');
  state.place({ scale: 2 }, 'place');
  assert.equal(state.snapshot().history.undoCount, 2);
});

test('rendered corrections retain their live state and undo to the original request baseline', () => {
  const state = createInspectionState();
  state.configure({ background: '#101010' });
  state.setPayload({ selectionKeys: ['A:1'] });
  const saved = state.save('Before the request');
  const before = state.checkpoint();
  state.configure({ representation: 'molecular-surface' });
  state.configure({ representation: 'spacefill', opacity: 0.5 });
  state.setPayload({ selectionKeys: ['A:1'], rendered: true });
  const drawn = state.checkpoint().current;
  state.rebaseHistory(before);
  assert.deepEqual(state.checkpoint().current, drawn, 'history changes cannot change the submitted frame');
  assert.equal(state.snapshot().history.undoCount, before.undo.length + 1);
  assert.deepEqual(state.saved(saved.savedView.id).state, before.current);

  // A second correction of the same in-flight request still has one undo.
  state.configure({ representation: 'cartoon' });
  const corrected = state.checkpoint().current;
  state.rebaseHistory(before);
  assert.equal(state.snapshot().history.undoCount, before.undo.length + 1);
  state.undo();
  assert.deepEqual(state.checkpoint().current, before.current);
  state.redo();
  assert.deepEqual(state.checkpoint().current, corrected);
});

test('a corrected request preserves older undo entries at the existing history capacity', () => {
  const state = createInspectionState();
  for (let index = 0; index < 32; index++) state.configure({ fog: index });
  const before = state.checkpoint();
  state.configure({ representation: 'molecular-surface' });
  state.configure({ representation: 'cartoon' });
  state.rebaseHistory(before);
  assert.equal(state.snapshot().history.undoCount, 32);
  state.undo();
  assert.deepEqual(state.checkpoint().current, before.current);
  state.undo();
  assert.deepEqual(state.checkpoint().current, before.undo.at(-1));
});

test('an open group is refused a second time and ends cleanly', () => {
  const state = createInspectionState();
  state.beginGroup('one');
  assert.equal(state.groupOpen(), true);
  assert.throws(() => state.beginGroup('two'), /group is already open/);
  state.endGroup();
  assert.equal(state.groupOpen(), false);
  // Ending a group nobody opened is safe, so a `finally` can always run it.
  state.endGroup();
});

test('the ops run in the order the request wrote them, inside one group', async () => {
  const order = [];
  const events = [];
  const applied = await applyCompoundChange(CHANGE, {
    emphasis: patch => { order.push(`emphasis:${patch.focus[0]}`); },
    appearance: patch => { order.push(`appearance:${patch.opacity}`); },
    placement: patch => { order.push(`placement:${patch.scale}`); },
  }, { begin: () => { events.push('begin'); return 'checkpoint'; }, end: () => events.push('end') });

  assert.deepEqual(order, ['emphasis:rna', 'appearance:0.5', 'placement:2']);
  assert.deepEqual(applied, ['emphasis', 'appearance', 'placement']);
  assert.deepEqual(events, ['begin', 'end']);
});

test('a failure part way through puts the panel back rather than leaving half a picture', async () => {
  const order = [];
  let restored;
  await assert.rejects(applyCompoundChange(CHANGE, {
    emphasis: () => { order.push('emphasis'); },
    appearance: () => { throw Error('This panel could not repaint.'); },
    placement: () => { order.push('placement'); },
  }, { begin: () => 'checkpoint', end: () => {}, rollback: checkpoint => { restored = checkpoint; } }),
    /could not repaint/);

  assert.deepEqual(order, ['emphasis']);
  assert.equal(restored, 'checkpoint');
});

test('it refuses a kind the panel cannot run, a repeat, and a compound of one', () => {
  assert.throws(() => compoundOps({ patch: { ops: [{ kind: 'placement', patch: {} }] } }), /at least two edits/);
  assert.throws(() => compoundOps({ patch: { ops: [
    { kind: 'appearance', patch: {} }, { kind: 'appearance', patch: {} }] } }), /at most once/);
  assert.throws(() => compoundOps({ patch: { ops: [
    { kind: 'tour', patch: {} }, { kind: 'appearance', patch: {} }] } }), /cannot run that kind/);
  assert.deepEqual([...COMPOUND_OP_KINDS], ['appearance', 'placement', 'selection', 'emphasis', 'visibility', 'styles', 'companion-structure']);
});

test('a handler the panel does not have refuses before anything is applied', async () => {
  const order = [];
  await assert.rejects(applyCompoundChange(CHANGE, {
    emphasis: () => { order.push('emphasis'); },
    appearance: () => { order.push('appearance'); },
  }), /cannot run that kind/);
  assert.deepEqual(order, []);
});
