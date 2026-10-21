import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { cameraSnapshot } from './camera-snapshot.mjs';
import { createLessonMotionHold, lessonCameraMove, lessonMotionApplies, normalizeLessonMotion } from './lesson-motion.mjs';
import { pageFunction } from './fixtures/label-action-harness.mjs';

const require = createRequire(import.meta.url);
const { Camera } = require('molstar/lib/commonjs/mol-canvas3d/camera.js');
const { Mat4, Vec3 } = require('molstar/lib/commonjs/mol-math/linear-algebra.js');
const source = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
const distance = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
const close = (a, b, message) => assert.ok(Math.abs(a - b) < 1e-10, `${message}: ${a} != ${b}`);
const closeVector = (a, b, message) => a.forEach((v, i) => close(v, b[i], `${message}[${i}]`));

// The actual wall Rejoin camera, whose eye-target distance stayed unchanged
// while motionPlaying/progress advanced true/0 -> false/1 on Quest 2.
const observed = {
  position: [17.606103020888444, 9.69579378495034, 58.390594948859025],
  target: [15.055418922309073, 9.69579378495034, 7.106107017465149], up: [0, 1, 0],
  radius: 17.78176619235635, radiusMax: 17.78176619235635,
};

function fixture({ xr = true, held = false, interaction = false, contextLost = false } = {}) {
  const camera = new Camera(structuredClone(observed));
  // Stock XRManager uses this 0.4 m floor. Deliberately start exactly on it:
  // a stand-in camera without Camera.update() cannot reproduce the defect.
  camera.scale = xr ? .4 / distance(observed.position, observed.target) : 1;
  camera.minTargetDistance = xr ? .4 : 0;
  camera.update();
  const start = camera.getSnapshot(), beforeView = Array.from(camera.view);
  const forward = observed.target.map((v, i) => (v - observed.position[i]) / distance(observed.position, observed.target));
  const pivot = observed.target.map((v, i) => v + 120 * forward[i] + [12, 6, 0][i]);
  // Nonidentity molecular presentation: the production pivot must transform
  // the drawn subset centre, rather than use the model or camera target.
  const centre = Object.freeze([1, 2, 3]);
  const transform = Object.freeze([0, 0, -2, 0, 0, 2, 0, 0, 2, 0, 0, 0,
    pivot[0] - 6, pivot[1] - 4, pivot[2] + 2, 1]);
  const scientific = Object.freeze({ sourceSha256: 'source-a', modelNumber: 1, assemblyId: '1' });
  let identity = scientific, mutations = 0, draws = 0;
  const hold = createLessonMotionHold();
  const h = vm.createContext({
    Mat4, Vec3, cameraSnapshot, lessonCameraMove, lessonMotionApplies, normalizeLessonMotion,
    assertReady() {}, failure: (code, message) => Object.assign(Error(message), { code }),
    wearerPlacement: { holdsPlacement: () => held }, interactionActive: () => interaction,
    lessonMotionHold: hold, liveScene: () => ({ ...identity, camera: camera.getSnapshot() }),
    drawnCenter: () => centre, presentationTransform: () => transform,
    canvas: { camera, xr: { isPresenting: { value: xr } }, webgl: { isContextLost: contextLost }, requestDraw() { draws++; } },
    snapshot: () => ({}), syncInspectionPayload() {}, inspectionPayload: () => ({}),
    inspectionState: { recordPayload() {}, setPayload() {} },
    async inspectionMutation(apply) { mutations++; return apply(); },
  });
  for (const name of ['applyLessonMotion', 'headsetTurnPivot', 'dolly']) vm.runInContext(pageFunction(source, name), h);
  return { camera, start, beforeView, pivot, hold, scientific, centre, transform,
    mutations: () => mutations, draws: () => draws,
    capture: () => cameraSnapshot(hold.presented(camera.getSnapshot(), identity)),
    changeSource() { identity = { ...scientific, sourceSha256: 'source-b' }; },
    async tick(factor) { const result = await h.applyLessonMotion({ kind: 'dolly', factor }); camera.update(); return result; },
    async manual(factor) { await h.dolly(factor); camera.update(); },
  };
}

function assertRigidDolly(t, factor) {
  const after = t.camera.getSnapshot();
  const expectedPosition = t.start.position.map((v, i) => t.pivot[i] + (v - t.pivot[i]) * factor);
  closeVector(after.position, expectedPosition, 'camera reaches requested pivot-relative distance after native update');
  closeVector(after.target, t.start.target.map((v, i) => v + expectedPosition[i] - t.start.position[i]), 'target translates rigidly');
  closeVector(after.up, t.start.up, 'up unchanged');
  close(distance(after.position, after.target), distance(t.start.position, t.start.target), 'eye-target separation unchanged');
  close(distance(after.position, t.pivot) / distance(t.start.position, t.pivot), factor, 'authored cumulative factor');
  close(t.camera.minTargetDistance, .4, 'native floor retained');
  assert.ok(Math.max(...Array.from(t.camera.view, (v, i) => Math.abs(v - t.beforeView[i]))) > .001, 'actual rendered room transform moves');
  // The rotational part of lookAt stays fixed. Menus use this live view for
  // room locking, so the fix does not turn the room or re-pose the molecule.
  for (const i of [0, 1, 2, 4, 5, 6, 8, 9, 10]) close(t.camera.view[i], t.beforeView[i], `view orientation ${i}`);
}

for (const factor of [.97, 1.03]) test(`XR authored dolly ${factor} survives the real camera floor`, async () => {
  const t = fixture();
  assert.equal((await t.tick(factor)).lessonMotionApplied, true);
  assertRigidDolly(t, factor);
  assert.deepEqual(t.capture(), t.start, 'transient camera remains pinned until bake');
  assert.equal(t.mutations(), 0, 'chapter tick creates no inspection history/mutation');
  assert.equal(t.draws(), 1);
  t.hold.bake();
  assert.deepEqual(t.capture(), t.camera.getSnapshot(), 'final live pose becomes the saved pose');
});

test('160 eased ticks with pause/bake/re-pin preserve the full XR dolly exactly', async () => {
  const t = fixture(); let last = 0;
  for (let i = 1; i <= 160; i++) {
    const u = i / 160, fraction = u < .5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
    await t.tick(Math.pow(.97, fraction - last)); last = fraction;
    if (i === 48 || i === 96) {
      t.hold.bake(); const paused = t.capture();
      t.camera.update(); assert.deepEqual(t.capture(), paused, 'a paused native frame adds no motion');
    }
  }
  assertRigidDolly(t, .97);
  assert.equal(t.mutations(), 0);
});

test('XR agent dolly uses the same presented pivot and still creates one explicit edit', async () => {
  const t = fixture(); await t.manual(.97); assertRigidDolly(t, .97); assert.equal(t.mutations(), 1);
});

test('desktop authored and agent dolly retain the exact fixed-target behavior', async () => {
  for (const method of ['tick', 'manual']) {
    const t = fixture({ xr: false }); await t[method](.97);
    const after = t.camera.getSnapshot();
    closeVector(after.position, t.start.target.map((v, i) => v + (t.start.position[i] - v) * .97), 'desktop position');
    assert.deepEqual(after.target, t.start.target); assert.deepEqual(after.up, t.start.up);
    close(distance(after.position, after.target) / distance(t.start.position, t.start.target), .97, 'desktop zoom');
  }
});

for (const blocked of ['held', 'interaction', 'contextLost']) test(`${blocked} still refuses an XR chapter dolly without spending a camera move`, async () => {
  const t = fixture({ [blocked]: true });
  assert.equal((await t.tick(.97)).lessonMotionApplied, false);
  assert.deepEqual(t.camera.getSnapshot(), t.start); assert.equal(t.hold.holding(), false); assert.equal(t.draws(), 0);
});

test('a different source never captures the earlier source’s pinned camera', async () => {
  const t = fixture(); await t.tick(.97); assert.deepEqual(t.capture(), t.start);
  t.changeSource(); assert.deepEqual(t.capture(), t.camera.getSnapshot());
  const nextStart = t.camera.getSnapshot(); await t.tick(.99);
  assert.deepEqual(t.capture(), nextStart, 'new source pins only its own incoming pose');
});

test('invalid and inside-target factors retain the existing rejection bounds', async () => {
  for (const factor of [0, -1, Infinity, NaN, .000001]) {
    const t = fixture(); await assert.rejects(() => t.tick(factor));
    assert.deepEqual(t.camera.getSnapshot(), t.start);
  }
});

test('an invalid or coincident immersive subject refuses rather than spending a no-op move', () => {
  for (const dollyPivot of [null, [], [0, 1], [0, 1, Infinity], [0, 1, NaN], observed.position]) {
    assert.throws(() => lessonCameraMove(observed, { kind: 'dolly', factor: .97 }, { dollyPivot }));
  }
  assert.throws(() => lessonCameraMove(observed, { kind: 'dolly', factor: .97 },
    { dollyPivot: observed.position.map((v, i) => v + (i === 0 ? .0001 : 0)) }));
  assert.deepEqual(lessonCameraMove(observed, { kind: 'dolly', factor: .97 }, { pivot: [5, 6, 7] }),
    lessonCameraMove(observed, { kind: 'dolly', factor: .97 }), 'orbit pivot alone keeps the established desktop contract');
});
