import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { createInspectionState } from './inspection-state.mjs';
import { createGesturePivot } from './gesture-pivot.mjs';
import { pageFunction } from './fixtures/label-action-harness.mjs';

const source = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
function harness() {
  const state = createInspectionState(), calls = { snapshot: 0, styles: 0, placement: 0 };
  const h = vm.createContext({ Mat4, Vec3,
    inspectionState: { snapshot() { calls.snapshot++; return state.snapshot(); },
      placement() { calls.placement++; return state.placement(); } },
    savedStyles() { calls.styles++; return {}; },
    loadedSphere: () => ({ center: [7, -3, 2], radius: 12 }),
    pivotCenter: () => [9, 1, -4], motionAngle: 0, grabRotation: undefined, grabScale: 1, grabOffset: undefined,
    sourceRecord: {}, visibleStage: undefined, gesturePivot: createGesturePivot(), focusPivotRequest: undefined,
    failure: (code, message) => Object.assign(Error(message), { code }),
  });
  for (const name of ['gesturePivotContext', 'gesturePivotCenter', 'inspectionSnapshot', 'placementTransform', 'grabTransform', 'presentationTransform'])
    vm.runInContext(pageFunction(source, name), h);
  // The pre-change reader through the same complete production transform math.
  vm.runInContext(pageFunction(source, 'presentationTransform')
    .replace('function presentationTransform(', 'function snapshotTransform(')
    .replace('inspectionState.placement()', 'inspectionSnapshot().placement'), h);
  return { h, state, calls };
}

test('placement-only values stay detached through history, replacement, saved views and checkpoint restore', () => {
  const state = createInspectionState();
  const original = state.checkpoint();
  state.place({ translation: [1, -2, 3], rotation: [21, -43, 67], scale: 2.22 });
  const checkpoint = state.checkpoint(), saved = state.save('held pose').savedView.id;
  const check = () => assert.deepEqual(state.placement(), state.snapshot().placement);
  const external = state.placement(); external.translation[0] = 999; external.rotation[1] = 999; external.scale = 999;
  check();
  assert.deepEqual(state.placement(), checkpoint.current.placement);
  for (const change of [
    () => state.place({ scale: 3.1 }), () => state.undo(), () => state.redo(),
    () => state.restoreSaved(saved), () => state.restoreCheckpoint(checkpoint),
    () => state.replace({ ...state.snapshot(), placement: { translation: [-2, 4, 0], rotation: [5, 7, 11], scale: .7 } }),
    () => state.reset(), () => state.restoreCheckpoint(original),
  ]) { change(); check(); }
});

test('production transform exactly matches snapshot reading through rotated placement, history, spin and transient grabs', () => {
  const { h, state } = harness();
  state.place({ translation: [1, -2, .75], rotation: [21, -43, 67], scale: 2.22 });
  const checkpoint = state.checkpoint();
  const compare = () => {
    const before = state.checkpoint();
    for (const transient of [
      { motionAngle: 0, grabRotation: undefined, grabScale: 1, grabOffset: undefined },
      { motionAngle: 37, grabRotation: undefined, grabScale: 1, grabOffset: undefined },
      { motionAngle: 0, grabRotation: Mat4.fromRotation(Mat4(), .41, Vec3.create(0, 1, 0)), grabScale: 1.3, grabOffset: [.3, -.4, .8] },
      { motionAngle: -71, grabRotation: Mat4.fromRotation(Mat4(), -.23, Vec3.create(1, 0, 0)), grabScale: .7, grabOffset: [-.6, .1, .2] },
    ]) {
      Object.assign(h, transient);
      assert.deepEqual(Array.from(h.presentationTransform()), Array.from(h.snapshotTransform()));
    }
    assert.deepEqual(state.checkpoint(), before, 'frame reads cannot mutate current state or undo history');
  };
  compare();
  for (const change of [() => state.place({ rotation: [-17, 35, 92], scale: .82 }),
    () => state.undo(), () => state.redo(), () => state.restoreCheckpoint(checkpoint)]) { change(); compare(); }
});

test('72 production frame reads eliminate all full snapshots and style normalization', t => {
  const { h, state, calls } = harness();
  for (let i = 0; i < 8; i++) state.save(`Saved view ${i}`);
  for (let i = 0; i < 72; i++) h.snapshotTransform();
  assert.deepEqual(calls, { snapshot: 72, styles: 72, placement: 0 });
  calls.snapshot = calls.styles = 0;
  for (let i = 0; i < 72; i++) h.presentationTransform();
  assert.deepEqual(calls, { snapshot: 0, styles: 0, placement: 72 });
  // Timing is evidence on this host, not a flaky speed assertion or device FPS.
  const measure = name => {
    const begin = performance.now();
    for (let i = 0; i < 7200; i++) h[name]();
    return (performance.now() - begin) / 7200;
  };
  measure('snapshotTransform'); measure('presentationTransform');
  const before = measure('snapshotTransform'), after = measure('presentationTransform');
  t.diagnostic(`Host-only mean ms/read, 7200 calls: full snapshot=${before.toFixed(5)}, placement-only=${after.toFixed(5)}`);
});
