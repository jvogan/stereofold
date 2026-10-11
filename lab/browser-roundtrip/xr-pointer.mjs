import { XRManager } from 'molstar/lib/mol-canvas3d/helper/xr-manager.js';
import { MeshBuilder } from 'molstar/lib/mol-geo/geometry/mesh/mesh-builder.js';
import { Mesh } from 'molstar/lib/mol-geo/geometry/mesh/mesh.js';
import { addSphere } from 'molstar/lib/mol-geo/geometry/mesh/builder/sphere.js';
import { addCylinderFromRay3D } from 'molstar/lib/mol-geo/geometry/mesh/builder/cylinder.js';
import { Shape } from 'molstar/lib/mol-model/shape.js';
import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { ValueCell } from 'molstar/lib/mol-util/index.js';
import { ParamDefinition as PD } from 'molstar/lib/mol-util/param-definition.js';
import { updateTransformData } from 'molstar/lib/mol-geo/geometry/transform-data.js';

// These lengths belong to the controller in room metres, never the molecule.
export const XR_POINTER_RADIUS_METERS = 0.003;
export const XR_POINTER_RAY_METERS = 0.2;
const CAPACITY = 8;
const finitePoint = point => point?.length === 3 && Number.isFinite(point[0]) && Number.isFinite(point[1]) && Number.isFinite(point[2]);

function mesh(kind) {
  const builder = MeshBuilder.createState(128, 64);
  builder.currentGroup = 0;
  if (kind === 'ray') addCylinderFromRay3D(builder, { origin: [0, 0, 0], direction: [0, 0, -1] },
    XR_POINTER_RAY_METERS, { radiusTop: 0.0005, radiusBottom: 0.0005, radialSegments: 8 });
  else addSphere(builder, [0, 0, 0], XR_POINTER_RADIUS_METERS, 1);
  return MeshBuilder.getMesh(builder);
}

function instanced(geometry, color, capacity) {
  const shape = Shape.create('stereofold-xr-pointer', {}, geometry, () => color, () => 1, () => '',
    Array.from({ length: capacity }, () => Mat4.identity()));
  const object = Shape.createRenderObject(shape, { ...PD.getDefaultValues(Mesh.Params),
    ignoreLight: true, doubleSided: false, cellSize: 0, batchSize: 0 });
  object.state.pickable = false;
  object.state.visible = false;
  return { object, geometry, transforms: object.values.transform.ref.value, count: 0 };
}

function upload(batch) {
  const values = batch.object.values;
  batch.object.state.visible = batch.count > 0;
  ValueCell.updateIfChanged(values.instanceCount, batch.count);
  ValueCell.updateIfChanged(values.uInstanceCount, batch.count);
  if (!batch.count) return;
  ValueCell.update(values.transform, batch.transforms);
  // A pointer has at most sixteen instances and no spatial culling grid. Passing
  // a sphere here rebuilds that grid and shrinks aTransform/aInstance to the
  // current count. The next controller addition would then write out of bounds.
  // Omit the sphere to retain the original capacity and upload transforms only.
  updateTransformData(values, undefined, 0, 0);
  Mesh.Utils.updateBoundingSphere(values, batch.geometry);
}

/**
 * Replace the pinned Mol* helper's per-frame mesh rebuild with three reusable
 * instanced meshes. PointerHelper draws in the camera-scaled world with its own
 * camera.scale=1. Its incoming rays/points already use that coordinate system;
 * a three-millimetre mesh therefore keeps its room size at every molecular scale.
 * The old helper sizes dots using camera.state.position * modelScale instead of
 * the actual XR eye position, which makes molecular scaling change their size.
 *
 * This is scoped to one pinned XRManager's helper instance, not its prototype.
 * On an incompatible runtime it leaves the stock pointer available. No source,
 * scientific representation, pick result or saved scene is changed.
 */
export function attachXrPointerHelper({ canvas, helper, menuPoint = () => undefined } = {}) {
  if (!helper?.props || !helper?.renderObject || typeof helper.update !== 'function'
    || !['add', 'remove', 'commit', 'update', 'syncVisibility'].every(method => typeof helper.scene?.[method] === 'function')) return { applied: false, restore() {} };
  const original = helper.update, stock = helper.renderObject;
  const sphere = mesh('dot');
  const rays = instanced(mesh('ray'), helper.props.color, CAPACITY);
  const dots = instanced(sphere, helper.props.color, CAPACITY * 2);
  const hitDot = instanced(sphere, helper.props.hitColor, 1);
  const batches = [rays, dots, hitDot], objects = batches.map(batch => batch.object);
  const matrix = Mat4.identity(), inverseView = Mat4.identity(), direction = Vec3(), menu = Vec3();
  let restored = false;
  function put(batch, point, ray) {
    if (!finitePoint(point)) return;
    if (ray && finitePoint(ray) && Vec3.magnitude(ray) > 1e-6) {
      Vec3.normalize(direction, ray);
      Vec3.makeRotation(matrix, Vec3.negUnitZ, direction);
    } else Mat4.setIdentity(matrix);
    Mat4.setTranslation(matrix, point);
    Mat4.toArray(matrix, batch.transforms, batch.count++ * 16);
  }
  // Remove the stock object so the helper's visibility sync cannot resurrect it.
  try {
    helper.scene.remove(stock);
    for (const object of objects) helper.scene.add(object);
    helper.scene.commit();
  } catch (error) {
    for (const object of objects) { try { helper.scene.remove(object); } catch {} }
    try { helper.scene.add(stock); helper.scene.commit(); } catch {}
    throw error;
  }
  helper.update = function (pointers = [], points = [], hit) {
    this.pointers = pointers; this.points = points; this.hit = hit;
    for (const batch of batches) batch.count = 0;
    if (this.props.enabled === 'on') {
      for (const pointer of pointers.slice(0, CAPACITY)) {
        if (!finitePoint(pointer?.origin) || !finitePoint(pointer?.direction)) continue;
        put(rays, pointer.origin, pointer.direction);
        put(dots, pointer.origin);
      }
      for (const point of points.slice(0, CAPACITY)) put(dots, point);
      // The toolbar supplies a point six millimetres in front of its glass,
      // in reference-space metres. Mol* draws this helper AFTER the debug
      // presentation scene (DrawPass._render), so it tests against menu depth.
      // Convert with inverse(camera.view), exactly as XRManager does for rays.
      // Do not bias toward the first controller: it may not be the aiming hand.
      let aimed;
      try { aimed = menuPoint(); } catch { /* Keep molecular feedback. */ }
      if (finitePoint(aimed) && canvas?.camera?.view && Mat4.tryInvert(inverseView, canvas.camera.view)) {
        Vec3.transformMat4(menu, aimed, inverseView);
        put(hitDot, menu);
      } else if (finitePoint(hit)) put(hitDot, hit);
    }
    for (const batch of batches) upload(batch);
    this.scene.update(objects, false);
    this.scene.syncVisibility();
  };
  return {
    applied: true,
    restore() {
      if (restored) return;
      restored = true;
      helper.update = original;
      for (const object of objects) helper.scene.remove(object);
      helper.scene.add(stock);
      helper.scene.commit();
      original.call(helper, helper.pointers, helper.points, helper.hit);
    },
  };
}

// One discovery hook can serve concurrent canvases. A wrapper per session can
// otherwise restore another session's expired wrapper and attach on every frame.
const pendingDiscovery = new Set();
let discoveryHook;
function releaseDiscoveryHook() {
  if (pendingDiscovery.size || !discoveryHook) return;
  if (XRManager.prototype.update === discoveryHook.update) XRManager.prototype.update = discoveryHook.original;
  discoveryHook = undefined;
}

/** Canvas3D's public facade omits its helper. Discover only this canvas's
 * pinned XRManager on its first update, then remove the discovery hook. */
export function installXrPointer({ canvas, menuPoint, onManager } = {}) {
  if (!canvas?.webgl || typeof XRManager.prototype.update !== 'function') return { applied: false, restore() {} };
  let adapter, managerAdapter, restored = false;
  const pending = { webgl: canvas.webgl, attach(manager) {
    // Share discovery with instance-scoped input adapters, before this
    // manager's first update can dispatch a synchronous release pick.
    try { managerAdapter = onManager?.(manager); } catch (error) {
      try { globalThis.__stereofoldDiagnostics?.record?.('xr-manager-adapter', { applied: false, error: error?.message }); } catch {}
    }
    try {
      adapter = attachXrPointerHelper({ canvas, helper: manager.pointerHelper, menuPoint });
      try { globalThis.__stereofoldDiagnostics?.record?.('xr-pointer', { applied: adapter.applied, geometry: 'instanced', radiusMeters: XR_POINTER_RADIUS_METERS }); } catch {}
    } catch (error) {
      try { globalThis.__stereofoldDiagnostics?.record?.('xr-pointer', { applied: false, error: error?.message }); } catch {}
    }
  } };
  pendingDiscovery.add(pending);
  if (!discoveryHook) {
    const original = XRManager.prototype.update;
    function update(frame) {
      for (const entry of pendingDiscovery) {
        if (entry.webgl !== this.webgl) continue;
        pendingDiscovery.delete(entry);
        entry.attach(this);
      }
      releaseDiscoveryHook();
      return original.call(this, frame);
    }
    discoveryHook = { original, update };
    XRManager.prototype.update = update;
  }
  return {
    get applied() { return adapter?.applied === true; },
    restore() {
      if (restored) return;
      restored = true;
      pendingDiscovery.delete(pending);
      releaseDiscoveryHook();
      try { managerAdapter?.restore?.(); } finally { adapter?.restore(); }
    },
  };
}
