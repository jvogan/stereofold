import test from 'node:test';
import assert from 'node:assert/strict';
import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { Camera } from 'molstar/lib/mol-canvas3d/camera.js';
import { PointerHelper } from 'molstar/lib/mol-canvas3d/helper/pointer-helper.js';
import { XRManager } from 'molstar/lib/mol-canvas3d/helper/xr-manager.js';
import { attachXrPointerHelper, installXrPointer, XR_POINTER_RADIUS_METERS } from './xr-pointer.mjs';

function harness() {
  const objects = new Set(), stock = {}, updates = [];
  objects.add(stock);
  let stockUpdates = 0;
  const helper = { renderObject: stock, props: { enabled: 'on', color: 0xffffff, hitColor: 0xff88bb },
    scene: { add: object => objects.add(object), remove: object => objects.delete(object), commit() {},
      update: values => updates.push(values), syncVisibility() {} },
    update() { stockUpdates++; } };
  const canvas = { webgl: {}, camera: { view: Mat4.identity(), scale: .01 } };
  return { canvas, helper, objects, stock, updates, get stockUpdates() { return stockUpdates; } };
}
const rays = [{ origin: [0, 0, 0], direction: [0, 0, -1] }, { origin: [.2, 0, 0], direction: [0, 0, -1] }];

test('moving and enlarging the molecule reuses pointer geometry with a fixed room radius', () => {
  const h = harness(), original = h.helper.update;
  const adapter = attachXrPointerHelper(h);
  assert.equal(adapter.applied, true);
  const objects = [...h.objects];
  assert.equal(objects.length, 3, 'ray, ordinary dots and hit dot use three instanced draws');
  const buffers = objects.map(o => [o.values.aPosition.ref.value, o.values.aPosition.ref.version, o.values.aNormal.ref.version, o.values.elements.ref.version]);
  for (let frame = 0; frame < 144; frame++) {
    h.canvas.camera.scale = .01 * (1 + frame / 12); // > 12×, no molecular cap.
    h.helper.update(rays, [[0, 0, -(1 + frame / 10)]], [0, 0, -1]);
  }
  for (const [i, object] of objects.entries()) {
    assert.equal(object.values.aPosition.ref.value, buffers[i][0]);
    assert.equal(object.values.aPosition.ref.version, buffers[i][1]);
    assert.equal(object.values.aNormal.ref.version, buffers[i][2]);
    assert.equal(object.values.elements.ref.version, buffers[i][3]);
    assert.ok(object.values.boundingSphere.ref.value.radius > 0);
  }
  const dots = objects[1];
  assert.equal(dots.values.instanceCount.ref.value, 3);
  const vertices = dots.values.aPosition.ref.value;
  const radius = Math.max(...Array.from({ length: vertices.length / 3 }, (_, i) => Math.hypot(...vertices.subarray(i * 3, i * 3 + 3))));
  assert.ok(Math.abs(radius - XR_POINTER_RADIUS_METERS) < 1e-8);
  assert.equal(dots.values.aTransform.ref.value[0], 1, 'no molecular scale is applied to controller dots');
  h.helper.update([], [], undefined);
  assert.ok(objects.every(object => object.state.visible === false));
  adapter.restore(); adapter.restore();
  assert.equal(h.helper.update, original);
  assert.deepEqual([...h.objects], [h.stock]);
  assert.equal(h.stockUpdates, 1);
});

test('menu aiming takes precedence over a molecular hit and follows camera-relative room conversion', () => {
  const h = harness();
  Mat4.setTranslation(h.canvas.camera.view, [1, 0, 0]);
  const adapter = attachXrPointerHelper({ ...h, menuPoint: () => [0, 0, -1] });
  h.helper.update([{ origin: [-1, 0, 0], direction: [0, 0, -1] }], [[5, 0, -2]], [5, 0, -2]);
  const hit = [...h.objects][2];
  assert.equal(hit.values.aTransform.ref.value[12], -1);
  assert.equal(hit.values.aTransform.ref.value[14], -1, 'toolbar owns the glass offset; the first controller must not shift the aiming hand cursor');
  adapter.restore();
});

test('the discovery hook targets one canvas and restores before its first manager draw', () => {
  const h = harness(), original = XRManager.prototype.update;
  const seen = [];
  XRManager.prototype.update = function () { seen.push(this); return true; };
  const baseline = XRManager.prototype.update;
  const adapter = installXrPointer(h);
  const other = { webgl: {} }, target = { webgl: h.canvas.webgl, pointerHelper: h.helper };
  try {
    XRManager.prototype.update.call(other);
    assert.equal(adapter.applied, false);
    XRManager.prototype.update.call(target);
    assert.equal(adapter.applied, true);
    assert.equal(XRManager.prototype.update, baseline);
    assert.deepEqual(seen, [other, target]);
    adapter.restore();
    assert.deepEqual([...h.objects], [h.stock]);
  } finally { adapter.restore(); XRManager.prototype.update = original; }
});

test('an ended session removes its pending discovery hook and unsupported helpers are untouched', () => {
  const h = harness(), original = XRManager.prototype.update;
  const adapter = installXrPointer(h);
  adapter.restore();
  assert.equal(XRManager.prototype.update, original);
  assert.equal(attachXrPointerHelper({ canvas: h.canvas, helper: {} }).applied, false);
});


test('controller loss and reacquisition preserve transform capacity and finite bounds', () => {
  const h = harness(), adapter = attachXrPointerHelper(h);
  const objects = [...h.objects];
  const buffers = objects.map(object => [object.values.aTransform.ref.value, object.values.aInstance.ref.value]);
  try {
    for (const count of [1, 2, 0, 8, 1, 8, 0, 2]) {
      const pointers = Array.from({ length: count }, (_, i) => ({ origin: [i / 10, .3, -.5], direction: [0, 0, -1] }));
      h.helper.update(pointers, pointers.map(p => [p.origin[0], .3, -1]), [0, .3, -1]);
      for (const [i, object] of objects.entries()) {
        assert.equal(object.values.aTransform.ref.value, buffers[i][0]);
        assert.equal(object.values.aInstance.ref.value, buffers[i][1]);
        assert.ok(Number.isFinite(object.values.boundingSphere.ref.value.radius));
      }
      assert.equal(objects[0].values.instanceCount.ref.value, count);
      assert.equal(objects[1].values.instanceCount.ref.value, count * 2);
      for (let i = 0; i < count; i++) assert.ok(Math.abs(objects[0].values.aTransform.ref.value[i * 16 + 12] - i / 10) < 1e-6);
    }
  } finally { adapter.restore(); }
});

test('rotated and translated camera preserves a menu point and a three millimetre room radius at every model scale', () => {
  const h = harness();
  Mat4.fromRotation(h.canvas.camera.view, .8, [0, 1, 0]);
  Mat4.setTranslation(h.canvas.camera.view, [1.2, -.4, .3]);
  const roomPoint = [.1, 1.1, -1.35];
  const adapter = attachXrPointerHelper({ ...h, menuPoint: () => roomPoint });
  const hit = [...h.objects][2];
  const helperCamera = { camera: new Camera() };
  const eye = new Camera();
  // The XR eye view includes the desktop camera's reference-space offset.
  Mat4.copy(eye.view, h.canvas.camera.view);
  try {
    for (const scale of [.001, .1, 1, 3.0149, 12]) {
      eye.scale = h.canvas.camera.scale = scale;
      PointerHelper.prototype.setCamera.call(helperCamera, eye);
      h.helper.update(rays, [], [10, 20, 30]);
      assert.equal(helperCamera.camera.scale, 1);
      const world = Mat4.fromArray(Mat4(), hit.values.aTransform.ref.value, 0);
      const eyePoint = Vec3.transformMat4(Vec3(), Vec3.transformMat4(Vec3(), [0, 0, 0], world), helperCamera.camera.view);
      eyePoint.forEach((v, i) => assert.ok(Math.abs(v - roomPoint[i]) < 1e-6));
      const radiusPoint = Vec3.transformMat4(Vec3(), Vec3.transformMat4(Vec3(), [XR_POINTER_RADIUS_METERS, 0, 0], world), helperCamera.camera.view);
      assert.ok(Math.abs(Vec3.distance(eyePoint, radiusPoint) - XR_POINTER_RADIUS_METERS) < 1e-6);
    }
  } finally { adapter.restore(); }
});

test('concurrent canvases discover once and teardown cannot resurrect an expired hook', () => {
  const a = harness(), b = harness(), original = XRManager.prototype.update;
  let calls = 0;
  XRManager.prototype.update = () => { calls++; };
  const baseline = XRManager.prototype.update;
  const first = installXrPointer(a), second = installXrPointer(b);
  const managerA = { webgl: a.canvas.webgl, pointerHelper: a.helper };
  const managerB = { webgl: b.canvas.webgl, pointerHelper: b.helper };
  try {
    XRManager.prototype.update.call(managerA);
    const attachedUpdate = a.helper.update;
    assert.equal(first.applied, true);
    first.restore();
    XRManager.prototype.update.call(managerB);
    assert.equal(second.applied, true);
    assert.equal(XRManager.prototype.update, baseline);
    XRManager.prototype.update.call(managerA);
    assert.notEqual(a.helper.update, attachedUpdate);
    assert.deepEqual([...a.objects], [a.stock]);
    assert.equal(calls, 3);
  } finally { first.restore(); second.restore(); XRManager.prototype.update = original; }
});

test('failed attachment restores the stock object and discovery delegates normally', () => {
  const h = harness(), original = XRManager.prototype.update, stockUpdate = h.helper.update;
  let commits = 0, calls = 0;
  h.helper.scene.commit = () => { if (++commits === 1) throw Error('context changed'); };
  XRManager.prototype.update = () => { calls++; };
  const baseline = XRManager.prototype.update, adapter = installXrPointer(h);
  try {
    XRManager.prototype.update.call({ webgl: h.canvas.webgl, pointerHelper: h.helper });
    assert.equal(adapter.applied, false);
    assert.equal(XRManager.prototype.update, baseline);
    assert.equal(h.helper.update, stockUpdate);
    assert.deepEqual([...h.objects], [h.stock]);
    assert.equal(calls, 1);
  } finally { adapter.restore(); XRManager.prototype.update = original; }
});
