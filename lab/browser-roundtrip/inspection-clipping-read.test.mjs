import test from 'node:test';
import assert from 'node:assert/strict';
import { createInspectionState } from './inspection-state.mjs';

test('clipping reads stay current through edits, undo, redo and restores', () => {
  const state = createInspectionState();
  assert.equal(state.clipping(), 0);
  state.configure({ clipping: 17 });
  const checkpoint = state.checkpoint(), saved = state.save('clipped').savedView.id;
  const scene = state.snapshot();
  state.configure({ clipping: 42 }); assert.equal(state.clipping(), 42);
  state.undo(); assert.equal(state.clipping(), 17);
  state.redo(); assert.equal(state.clipping(), 42);
  state.replace(scene); assert.equal(state.clipping(), 17);
  state.configure({ clipping: 80 }); assert.equal(state.clipping(), 80);
  state.restoreSaved(saved); assert.equal(state.clipping(), 17);
  state.configure({ clipping: 31 });
  state.restoreCheckpoint(checkpoint); assert.equal(state.clipping(), 17);
  state.reset({ clipping: 9 }); assert.equal(state.clipping(), 9);
  state.reset(); assert.equal(state.clipping(), 0);
});

test('the clipping scalar exposes no mutable appearance or checkpoint state', () => {
  const state = createInspectionState();
  state.configure({ clipping: 23 });
  const value = state.clipping(), snapshot = state.snapshot(), checkpoint = state.checkpoint();
  snapshot.appearance.clipping = 66;
  assert.equal(state.clipping(), 23);
  state.restoreCheckpoint(checkpoint);
  checkpoint.current.appearance.clipping = 77;
  assert.equal(state.clipping(), 23);
  state.configure({ clipping: 34 });
  assert.equal(value, 23, 'an earlier scalar read remains detached from later edits');
  assert.equal(state.clipping(), 34);
});

test('frame-time clipping reads never clone the full inspection snapshot', () => {
  const state = createInspectionState();
  state.configure({ clipping: 12 });
  state.setCompanion({ layers: Array.from({ length: 100 }, (_, index) => ({ index })) });
  const original = globalThis.structuredClone;
  globalThis.structuredClone = () => { throw Error('scene clone in frame-time read'); };
  try {
    for (let frame = 0; frame < 1000; frame++) assert.equal(state.clipping(), 12);
    assert.throws(() => state.snapshot(), /scene clone in frame-time read/,
      'the clone trap covers the previous full-snapshot path');
  } finally { globalThis.structuredClone = original; }
});
