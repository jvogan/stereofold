import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { PLACEMENT_MIN_SCALE } from './placement-limits.mjs';
import { preserveSourceTransitionAnchor } from './source-transition-anchor.mjs';

const source = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
const fn = name => {
  const start = source.indexOf(`  function ${name}(`);
  assert.ok(start >= 0);
  return source.slice(start, source.indexOf('\n  }', start) + 4);
};
function fixture() {
  let identity = { sourceSha256: 'a', modelNumber: 1, assemblyId: '1' };
  let camera = { position: [1, 2, 30], target: [1, 2, 0], up: [0, 1, 0], radius: 10 };
  const session = {}, headTracking = { position: [0.4, 1.7, -0.2], rotation: [0, 0.3, 0, 0.95] };
  const canvas = { xr: { session, isPresenting: { value: true } },
    camera: { scale: 1, getSnapshot: () => structuredClone(camera),
      setState: value => { camera = { ...camera, ...structuredClone(value) }; } } };
  const context = vm.createContext({ canvas, xrRecoveryFrames: new WeakMap(), state: { contextLossCount: 0 },
    cameraSnapshot: value => structuredClone(value), liveScene: () => identity, assertReady() {}, assertContext() {},
    failure: (code, message) => Object.assign(Error(message), { code }), lastDepthMinFar: 50, applyImmersiveDepth() {} });
  for (const name of ['captureXrRecoveryFrame', 'restoreXrRecoveryFrame', 'setXrCameraScale']) vm.runInContext(fn(name), context);
  return { context, canvas, session, headTracking, identity: value => { identity = value; }, camera: () => camera };
}
const bounds = radius => ({ center: [0, 0, 0], radius });
test('opaque local XR rollback restores world scale after an extreme source round trip without rewinding tracking', () => {
  const t = fixture(), savedCamera = structuredClone(t.camera()), savedHead = structuredClone(t.headTracking);
  const token = t.context.captureXrRecoveryFrame();
  assert.equal(JSON.stringify(token), '{}');
  const placement = { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 };
  const larger = preserveSourceTransitionAnchor({ priorBase: bounds(10), priorVisible: bounds(10), priorPlacement: placement,
    priorCameraScale: 1, nextBase: bounds(1e9), nextVisible: bounds(1e9) });
  assert.equal(larger.placement.scale, PLACEMENT_MIN_SCALE);
  assert.equal(larger.usedCameraScale, true);
  assert.equal(1e9 * larger.placement.scale * larger.cameraScale, 10);
  t.context.setXrCameraScale(larger);
  const returned = preserveSourceTransitionAnchor({ priorBase: bounds(1e9), priorVisible: bounds(1e9), priorPlacement: larger.placement,
    priorCameraScale: larger.cameraScale, nextBase: bounds(10), nextVisible: bounds(10) });
  assert.equal(returned.usedCameraScale, false, 'the return fits within the restored numerical scale range');
  assert.equal(10 * returned.placement.scale * returned.cameraScale, 10);
  t.context.setXrCameraScale(returned);
  // An extreme source ratio crosses the numerical guard and changes world
  // scale. Restoring only the serialized placement would leave a tiny subject.
  assert.ok(Math.abs(10 * placement.scale * t.canvas.camera.scale - 10 / returned.placement.scale) < 1e-15);
  assert.equal(t.context.restoreXrRecoveryFrame(token), true);
  assert.equal(10 * placement.scale * t.canvas.camera.scale, 10);
  assert.deepEqual(t.camera(), savedCamera);
  assert.deepEqual(t.headTracking, savedHead);
  assert.equal(t.context.lastDepthMinFar, 0);
});
for (const change of ['ended', 'replaced']) test(`an ${change} XR session cannot consume a prior session frame`, () => {
  const t = fixture(), token = t.context.captureXrRecoveryFrame();
  t.canvas.camera.scale = 0.25;
  if (change === 'ended') t.canvas.xr.isPresenting.value = false;
  else t.canvas.xr.session = {};
  assert.equal(t.context.restoreXrRecoveryFrame(token), false);
  assert.equal(t.canvas.camera.scale, 0.25);
});
for (const change of ['source', 'model', 'assembly', 'context', 'foreign']) test(`XR rollback rejects a ${change} mismatch`, () => {
  const t = fixture(), token = t.context.captureXrRecoveryFrame();
  if (change === 'source') t.identity({ sourceSha256: 'b', modelNumber: 1, assemblyId: '1' });
  if (change === 'model') t.identity({ sourceSha256: 'a', modelNumber: 2, assemblyId: '1' });
  if (change === 'assembly') t.identity({ sourceSha256: 'a', modelNumber: 1, assemblyId: '2' });
  if (change === 'context') t.context.state.contextLossCount++;
  t.canvas.camera.scale = 0.25;
  assert.throws(() => t.context.restoreXrRecoveryFrame(change === 'foreign' ? {} : token), { code: 'invalid_xr_recovery_frame' });
  assert.equal(t.canvas.camera.scale, 0.25);
});
