import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { CIF } from 'molstar/lib/mol-io/reader/cif.js';
import { trajectoryFromMmCIF } from 'molstar/lib/mol-model-formats/structure/mmcif.js';
import { Structure, StructureSymmetry } from 'molstar/lib/mol-model/structure.js';
import { CartoonRepresentation, CartoonRepresentationProvider, getCartoonParams } from 'molstar/lib/mol-repr/structure/representation/cartoon.js';
import { AssetManager } from 'molstar/lib/mol-util/assets.js';
import { RuntimeContext } from 'molstar/lib/mol-task/execution/runtime-context.js';
import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { Sphere3D } from 'molstar/lib/mol-math/geometry/primitives/sphere3d.js';
import { SymmetryOperator } from 'molstar/lib/mol-math/geometry/symmetry-operator.js';
import { Frustum3D } from 'molstar/lib/mol-math/geometry/primitives/frustum3d.js';
import { ValueCell } from 'molstar/lib/mol-util/value-cell.js';
import { createTransform } from 'molstar/lib/mol-geo/geometry/transform-data.js';
import { Visual } from 'molstar/lib/mol-repr/visual.js';
import { calculateTransformBoundingSphere } from 'molstar/lib/mol-gl/renderable/util.js';
import { updatePlacementBounds } from './placement-bounds.mjs';
import { companionTransform } from './companion-structure.mjs';
import { roomPlacement } from './room-placement.mjs';
import { menuResetActions } from './spatial-toolbar-content.mjs';
import { tourFocusHarness } from './fixtures/tour-focus-harness.mjs';
import { placementSentence } from './placement-report.mjs';
import { pageFunction } from './fixtures/label-action-harness.mjs';
import { syntheticViews } from './fixtures/component-label-diagnostics.mjs';

const viewer = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
let structure, context;
before(async () => {
  const parsed = await CIF.parse(readFileSync(new URL('../../fixtures/4HHB.cif', import.meta.url), 'utf8')).run();
  assert.equal(parsed.isError, false);
  const trajectory = await trajectoryFromMmCIF(parsed.result.blocks[0]).run();
  structure = await StructureSymmetry.buildAssembly(Structure.ofModel(trajectory.representative), '1').run();
  context = { assetManager: new AssetManager(), runtime: RuntimeContext.Synchronous };
  await CartoonRepresentationProvider.ensureCustomProperties.attach(context, structure);
});

async function cartoon(t, source = structure, count = 1) {
  const repr = CartoonRepresentation(context, getCartoonParams);
  t.after(() => repr.destroy());
  await CartoonRepresentationProvider.ensureCustomProperties.attach(context, source);
  await repr.createOrUpdate({ visuals: ['polymer-trace'] }, source).run();
  assert.equal(repr.renderObjects.length, 4, 'the pinned 4HHB assembly builds four real cartoon chain meshes');
  assert.ok(repr.renderObjects.every(o => o.values.instanceCount.ref.value === count && o.values.drawCount.ref.value > 0));
  return repr;
}

// Synthetic assembly fixture made only from pinned public coordinates, using
// the same Mol* builder/operator path as buildAssembly. It is not a biological
// claim about 4HHB: each chain mesh is shared by fifteen distinct rigid copies.
function assemblyFixture(count = 15) {
  const assembler = Structure.Builder({ label: '4HHB synthetic culling assembly' });
  for (let i = 0; i < count; i++) {
    const rotation = Mat4.fromRotation(Mat4(), i * 2 * Math.PI / count, Vec3.create(0, 1, 0));
    Mat4.setTranslation(rotation, Vec3.create((i % 5 - 2) * 12, (Math.floor(i / 5) - 1) * 12, 0));
    const operator = SymmetryOperator.create(`copy-${i}`, rotation,
      { assembly: { id: 'culling-fixture', operId: i + 1, operList: [`${i + 1}`] } });
    for (const unit of structure.units) assembler.addWithOperator(unit, operator);
  }
  return assembler.getStructure();
}
const cullSpheres = repr => repr.renderObjects.map(o => Sphere3D.clone(o.values.boundingSphere.ref.value));
function closeSphere(actual, expected) {
  assert.ok(Vec3.distance(actual.center, expected.center) < 1e-4,
    `centre ${actual.center} should match ${expected.center}`);
  assert.ok(Math.abs(actual.radius - expected.radius) < 1e-4,
    `radius ${actual.radius} should match ${expected.radius}`);
}

// Uses stock transform data and Visual.setTransform, without a WebGL context.
function visualRepresentation(sphere, transforms = Mat4.identity(), count = 1, cellSize = 0) {
  const object = { state: { visible: true, pickable: true, alphaFactor: 1 }, values: {
    ...createTransform(new Float32Array(transforms), count, sphere, cellSize, cellSize * 4),
    invariantBoundingSphere: ValueCell.create(Sphere3D.clone(sphere)),
    boundingSphere: ValueCell.create(Sphere3D.clone(sphere)), drawCount: ValueCell.create(3),
  } };
  return { renderObjects: [object], setState: ({ transform }) => Visual.setTransform(object, transform) };
}

function containsSphere(outer, inner, detail = '') {
  const required = Vec3.distance(outer.center, inner.center) + inner.radius;
  assert.ok(required <= outer.radius + 1e-4, `${detail}: radius ${outer.radius} must enclose ${required}`);
}

function instanceSpheres(values) {
  return Array.from({ length: values.instanceCount.ref.value }, (_, i) => Sphere3D.transform(Sphere3D(),
    values.invariantBoundingSphere.ref.value, Mat4.fromArray(Mat4(), values.aTransform.ref.value, i * 16)));
}

function wireViewer(h, repr, { labels = [], companion = null, onUpdate = () => {} } = {}) {
  Object.assign(h, {
    representation: { obj: { data: { repr } } }, scientificRepresentations: () => [repr],
    componentLabelRepresentations: () => labels, componentLabels: { refs: () => [], active: () => false },
    companionRecord: companion, companionTransform, updatePlacementBounds,
    pivotCenter: () => h.loadedSphere().center, grabTransform: () => undefined, motionAngle: 0,
  });
  h.canvas.update = onUpdate;
  for (const name of ['presentationTransform', 'applyInspectionTransform']) vm.runInContext(pageFunction(viewer, name), h);
}

for (const count of [1, 2, 15]) {
  test(`2x placement scales the invariant radius for ${count} instances`, t => {
    const invariant = Sphere3D.create(Vec3.create(1, 2, 3), 4);
    const instances = new Float32Array(Array.from({ length: count }, () => [...Mat4.identity()]).flat());
    const repr = visualRepresentation(invariant, instances, count);
    const placement = Mat4.fromScaling(Mat4(), Vec3.create(2, 2, 2));
    Mat4.setTranslation(placement, Vec3.create(10, 20, -100));
    repr.setState({ transform: placement });
    const { values } = repr.renderObjects[0];
    const stock = calculateTransformBoundingSphere(invariant, values.aTransform.ref.value, count, 0);
    closeSphere(stock, { center: [12, 24, -94], radius: count === 1 ? 8 : 4 });
    updatePlacementBounds(repr);
    t.diagnostic(`instances=${count}: stock radius=${stock.radius}, repaired radius=${values.boundingSphere.ref.value.radius}`);
    closeSphere(values.boundingSphere.ref.value, { center: [12, 24, -94], radius: 8 });
  });
}

for (const count of [2, 14, 15]) {
  for (const withExtrema of [false, true]) {
    test(`bounds enclose ${count} differently transformed instances with extrema=${withExtrema}`, () => {
      const invariant = Sphere3D.create(Vec3.create(1, 2, 3), 4);
      if (withExtrema) Sphere3D.setExtrema(invariant, [Vec3.create(-3, 2, 3), Vec3.create(5, 2, 3)]);
      const transforms = new Float32Array(Array.from({ length: count }, (_, i) => {
        const rotation = Mat4.fromRotation(Mat4(), i * .37, Vec3.create(0, 1, 0));
        Mat4.setTranslation(rotation, Vec3.create(i * 10, (i % 3) * 5, -i * 2));
        return [...rotation];
      }).flat());
      const repr = visualRepresentation(invariant, transforms, count), { values } = repr.renderObjects[0];
      const extra = new Float32Array(Array.from({ length: count }, (_, i) => {
        const matrix = Mat4.fromScaling(Mat4(), Vec3.create(i % 2 ? -2 : .5, 1 + i / 5, .75));
        Mat4.setTranslation(matrix, Vec3.create(0, i * 2, 0));
        return [...matrix];
      }).flat());
      for (const scale of [2, .25, 1]) {
        const placement = Mat4.fromScaling(Mat4(), Vec3.create(scale, scale, scale));
        Mat4.setTranslation(placement, Vec3.create(20, 110, -100));
        Visual.setTransform(repr.renderObjects[0], placement, extra);
        updatePlacementBounds(repr);
        instanceSpheres(values).forEach((sphere, i) => containsSphere(values.boundingSphere.ref.value, sphere, `instance ${i}`));
        // Nonuniform extra scaling composed with rotated instances can shear:
        // check actual transformed surface points, beyond the max-axis sphere.
        for (let i = 0; i < count; i++) {
          const matrix = Mat4.fromArray(Mat4(), values.aTransform.ref.value, i * 16);
          for (let angle = 0; angle < 2 * Math.PI; angle += .1) {
            const point = Vec3.scaleAndAdd(Vec3(), invariant.center,
              Vec3.create(Math.cos(angle), 0, Math.sin(angle)), invariant.radius);
            Vec3.transformMat4(point, point, matrix);
            containsSphere(values.boundingSphere.ref.value, { center: point, radius: 0 }, `surface of instance ${i}`);
          }
        }
      }
      assert.deepEqual(values.invariantBoundingSphere.ref.value, invariant);
    });
  }
}

for (const withExtrema of [false, true]) {
  test(`single-instance bounds enclose nonuniform extra scaling of a rotated source with extrema=${withExtrema}`, () => {
    const invariant = Sphere3D.create(Vec3.create(1, 2, 3), 4);
    if (withExtrema) Sphere3D.setExtrema(invariant, [Vec3.create(-3, 2, 3), Vec3.create(5, 2, 3)]);
    const instance = Mat4.fromRotation(Mat4(), Math.PI / 4, Vec3.create(0, 0, 1));
    const repr = visualRepresentation(invariant, instance), { values } = repr.renderObjects[0];
    const extra = Mat4.fromScaling(Mat4(), Vec3.create(3, 1, 1));
    Visual.setTransform(repr.renderObjects[0], Mat4.identity(), new Float32Array(extra));
    const matrix = Mat4.fromArray(Mat4(), values.aTransform.ref.value, 0);
    const extreme = Vec3.scaleAndAdd(Vec3(), invariant.center,
      Vec3.create(Math.SQRT1_2, -Math.SQRT1_2, 0), invariant.radius);
    Vec3.transformMat4(extreme, extreme, matrix);
    const stock = calculateTransformBoundingSphere(invariant, values.aTransform.ref.value, 1, 0);
    assert.ok(Vec3.distance(stock.center, extreme) > stock.radius,
      'the installed max-axis calculation misses a rendered sphere point');
    updatePlacementBounds(repr);
    containsSphere(values.boundingSphere.ref.value, { center: extreme, radius: 0 });
    for (let angle = 0; angle < 2 * Math.PI; angle += .1) {
      const point = Vec3.scaleAndAdd(Vec3(), invariant.center,
        Vec3.create(Math.cos(angle), Math.sin(angle), 0), invariant.radius);
      Vec3.transformMat4(point, point, matrix);
      containsSphere(values.boundingSphere.ref.value, { center: point, radius: 0 });
    }
    assert.deepEqual(values.invariantBoundingSphere.ref.value, invariant);
    const repaired = structuredClone(values.boundingSphere.ref.value);
    updatePlacementBounds(repr);
    assert.deepEqual(values.boundingSphere.ref.value, repaired, 'the correction never accumulates padding');
  });
}

for (const count of [1, 2, 15]) {
  test(`placement repairs ${count}-instance grid cells and batches without changing membership`, () => {
    const invariant = Sphere3D.create(Vec3.create(1, 2, 3), 4);
    const transforms = new Float32Array(Array.from({ length: count }, (_, i) =>
      [...Mat4.fromTranslation(Mat4(), Vec3.create((count - i) * 20, i % 2, 0))]).flat());
    const repr = visualRepresentation(invariant, transforms, count, 8), { values } = repr.renderObjects[0];
    // This controls marker/paint granularity, not the renderer's culling choice.
    values.instanceGranularity = ValueCell.create(true);
    for (const scale of [2, .5, 2]) {
      const placement = Mat4.fromScaling(Mat4(), Vec3.create(scale, scale, scale));
      Mat4.setTranslation(placement, Vec3.create(11.123456789, 110, -100));
      repr.setState({ transform: placement });
      const grid = values.instanceGrid.ref.value, instances = instanceSpheres(values);
      const version = values.instanceGrid.ref.version;
      if (scale === 2) assert.ok(instances.some((sphere, i) =>
        sphere.radius > grid.cellSpheres[i * 4 + 3]), 'stock grid radii omit placement scale');
      updatePlacementBounds(repr);
      const repaired = values.instanceGrid.ref.value;
      assert.equal(values.instanceGrid.ref.version, version + 1);
      for (const key of ['cellOffsets', 'cellInstance', 'cellTransform', 'batchOffsets', 'batchCell']) {
        assert.equal(repaired[key], grid[key], `${key} ordering/membership stays unchanged`);
      }
      assert.equal(values.aTransform.ref.value, repaired.cellTransform);
      assert.equal(values.instanceGranularity.ref.value, true);
      for (let i = 0; i < repaired.cellCount; i++) {
        const cell = Sphere3D.fromArray(Sphere3D(), repaired.cellSpheres, i * 4);
        for (let j = repaired.cellOffsets[i]; j < repaired.cellOffsets[i + 1]; j++) containsSphere(cell, instances[j], `cell ${i}`);
      }
      for (let i = 0; i < repaired.batchCount; i++) {
        const batch = Sphere3D.fromArray(Sphere3D(), repaired.batchSpheres, i * 4);
        for (let j = repaired.batchOffsets[i]; j < repaired.batchOffsets[i + 1]; j++) {
          containsSphere(batch, Sphere3D.fromArray(Sphere3D(), repaired.cellSpheres, repaired.batchCell[j] * 4), `batch ${i}`);
        }
      }
      const beforeRepeat = structuredClone(repaired);
      updatePlacementBounds(repr);
      assert.deepEqual(values.instanceGrid.ref.value, beforeRepeat, 'recomputation is idempotent, with no repeated padding');
    }
  });
}

test('translated 2x placement moves every real 4HHB chain cull sphere with aTransform', async t => {
  const repr = await cartoon(t), before = cullSpheres(repr);
  const transform = Mat4.fromScaling(Mat4(), Vec3.create(2, 2, 2));
  Mat4.setTranslation(transform, Vec3.create(120, 110, -180));
  repr.setState({ transform });
  // This is the installed 5.11 defect, not a fake that already has good bounds.
  assert.deepEqual(cullSpheres(repr), before, 'stock Visual.setTransform leaves the unplaced spheres behind');
  const versions = repr.renderObjects.map(o => o.values.boundingSphere.ref.version);
  updatePlacementBounds(repr);
  repr.renderObjects.forEach((object, index) => {
    const { values } = object;
    closeSphere(values.boundingSphere.ref.value, Sphere3D.transform(Sphere3D(), before[index], transform));
    assert.deepEqual(values.boundingSphere.ref.value,
      calculateTransformBoundingSphere(values.invariantBoundingSphere.ref.value, values.aTransform.ref.value, 1, 0));
    assert.equal(values.boundingSphere.ref.version, versions[index] + 1, 'publish the corrected cell before canvas.update');
  });
});

test('bounds use composed instance and extra transforms and keep separate sphere ownership', () => {
  const sphere = Sphere3D.create(Vec3.create(1, 2, 3), 4);
  const instance = Mat4.fromTranslation(Mat4(), Vec3.create(10, 0, 0));
  const repr = visualRepresentation(sphere, instance), object = repr.renderObjects[0];
  const placement = Mat4.fromScaling(Mat4(), Vec3.create(2, 2, 2));
  Mat4.setTranslation(placement, Vec3.create(0, 110, -100));
  const extra = Mat4.fromTranslation(Mat4(), Vec3.create(0, 8, 0));
  Visual.setTransform(object, placement, new Float32Array(extra));
  updatePlacementBounds(repr);
  closeSphere(object.values.boundingSphere.ref.value, { center: [22, 130, -94], radius: 8 });
  assert.deepEqual(object.values.invariantBoundingSphere.ref.value, sphere, 'model bounds remain immutable');

  const instances = new Float32Array([...Mat4.identity(), ...instance]);
  const copies = visualRepresentation(sphere, instances, 2);
  copies.setState({ transform: placement });
  updatePlacementBounds(copies);
  const result = copies.renderObjects[0].values.boundingSphere.ref.value;
  const saved = Sphere3D.clone(result);
  const other = visualRepresentation(sphere, new Float32Array([...instance, ...instance]), 2);
  other.setState({ transform: Mat4.fromTranslation(Mat4(), Vec3.create(900, 0, 0)) });
  updatePlacementBounds(other);
  assert.deepEqual(result, saved, 'a later multi-instance helper calculation must not overwrite the first object');
});

test('viewer repairs primary, label and companion bounds before each canvas update and on later placements', async t => {
  const repr = await cartoon(t), sphere = structure.boundary.sphere;
  const label = visualRepresentation(Sphere3D.create(Vec3.create(0, 4, 8), 2));
  // Hidden geometry must acquire correct bounds too, for its later reveal.
  label.renderObjects[0].state.visible = false;
  const comparison = visualRepresentation(Sphere3D.create(Vec3.create(7, 8, 9), 3));
  const companion = { representation: { obj: { data: { repr: comparison } } },
    structure: { obj: { data: { boundary: { sphere: { center: [7, 8, 9], radius: 3 } } } } },
    companionState: { placement: { translation: [2, 0, 0], rotation: [0, 35, 0], scale: .6 } } };
  const { h } = tourFocusHarness();
  h.loadedSphere = () => sphere;
  const updates = [];
  wireViewer(h, repr, { labels: [label], companion, onUpdate(current, keepSphere) {
    assert.equal(keepSphere, false, 'canvas must invalidate the aggregate scene bounds');
    for (const { values } of current.renderObjects) {
      assert.deepEqual(values.boundingSphere.ref.value, calculateTransformBoundingSphere(
        values.invariantBoundingSphere.ref.value, values.aTransform.ref.value, values.instanceCount.ref.value, 0));
    }
    updates.push(current);
  } });
  h.clearHeldPlatePlacement = placement => placement;
  for (const placement of [
    { translation: [0, 3, -4], rotation: [0, 0, 0], scale: 2 },
    { translation: [1, 2, -3], rotation: [0, 45, 0], scale: .75 },
    { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 },
  ]) {
    await h.placeInspection(placement);
    const primary = h.presentationTransform();
    const expected = companionTransform(Mat4, Vec3, primary, sphere,
      companion.structure.obj.data.boundary.sphere, companion.companionState.placement);
    closeSphere(comparison.renderObjects[0].values.boundingSphere.ref.value,
      Sphere3D.transform(Sphere3D(), comparison.renderObjects[0].values.invariantBoundingSphere.ref.value, expected));
  }
  assert.deepEqual(updates, [repr, label, comparison, repr, label, comparison, repr, label, comparison]);
  assert.equal(label.renderObjects[0].state.visible, false, 'bounds do not override deliberate hiding');
});

test('placed 4HHB chains intersect both eye frustums through a fixed-seat head yaw of ±60 degrees', async t => {
  const repr = await cartoon(t), sphere = structure.boundary.sphere;
  const { h } = tourFocusHarness(), head = h.latestRoomPlacementPose.headInRoom;
  // Same molecular-radius placement and 1.1 m head matrix as tour-focus-harness,
  // with Mol* XR's fitted 0.9 m radius. The wearer doubles it 1 m ahead.
  const cameraScale = .9 / sphere.radius;
  h.canvas.camera.scale = cameraScale;
  h.loadedSphere = () => sphere;
  const stale = cullSpheres(repr);
  wireViewer(h, repr);
  h.clearHeldPlatePlacement = placement => placement;
  const seat = [0, head[13], -1];
  // Seed the completed placement directly: the menu-clearance policy exercised
  // by placeInspection is independent of chain culling and can move this seat.
  h.inspectionState.place({ scale: 2 });
  await h.placeInspection({ scale: 2, rotation: [0, 0, 0],
    translation: seat.map((v, i) => (v / cameraScale - sphere.center[i]) / sphere.radius) });
  const corrected = cullSpheres(repr), versions = repr.renderObjects.map(o => o.values.boundingSphere.ref.version);
  let staleMisses = 0, checks = 0;
  // Match emulation.mjs's 15-degree yaw steps. Eye offsets turn with the head.
  for (let degrees = -60; degrees <= 60; degrees += 15) {
    Mat4.fromRotation(head, degrees * Math.PI / 180, Vec3.create(0, 1, 0));
    Mat4.setTranslation(head, Vec3.create(0, 1.1, 0));
    for (const view of syntheticViews()) {
      const eyeInRoom = Mat4.mul(Mat4(), head, view.transform.matrix);
      const eyeView = Mat4.invert(Mat4(), eyeInRoom);
      const frustum = Frustum3D.fromProjectionMatrix(Frustum3D(), Mat4.mul(Mat4(), view.projectionMatrix, eyeView));
      corrected.forEach((bounds, chain) => {
        assert.ok(Frustum3D.intersectsSphere3D(frustum, Sphere3D.scaleNX(Sphere3D(), bounds, cameraScale)),
          `chain ${chain}, ${view.eye} eye, yaw ${degrees}`);
        if (!Frustum3D.intersectsSphere3D(frustum, Sphere3D.scaleNX(Sphere3D(), stale[chain], cameraScale))) staleMisses++;
        checks++;
      });
    }
  }
  assert.ok(staleMisses > 0, 'the old spheres fail this same camera/placement scene');
  assert.equal(checks, 72);
  assert.deepEqual(repr.renderObjects.map(o => o.values.boundingSphere.ref.version), versions,
    'head rotation alone requires no sphere recomputation');
  t.diagnostic(`${checks} chain/eye/yaw intersections; ${staleMisses} misses with the old spheres`);
});

test('translated 2x fifteen-copy assembly intersects both eye frustums through head yaw of ±60 degrees', async t => {
  const assembly = assemblyFixture(), repr = await cartoon(t, assembly, 15), sphere = assembly.boundary.sphere;
  const { h } = tourFocusHarness(), head = h.latestRoomPlacementPose.headInRoom;
  const cameraScale = .9 / sphere.radius;
  h.canvas.camera.scale = cameraScale;
  h.loadedSphere = () => sphere;
  wireViewer(h, repr);
  h.clearHeldPlatePlacement = placement => placement;
  h.inspectionState.place({ scale: 2 });
  await h.placeInspection({ scale: 2, rotation: [0, 25, 0],
    translation: [0, head[13], -1].map((v, i) => (v / cameraScale - sphere.center[i]) / sphere.radius) });
  let oldUnderBounds = 0;
  for (const { values } of repr.renderObjects) {
    const old = calculateTransformBoundingSphere(values.invariantBoundingSphere.ref.value,
      values.aTransform.ref.value, 15, 0);
    for (const instance of instanceSpheres(values)) {
      containsSphere(values.boundingSphere.ref.value, instance, 'placed assembly instance');
      if (Vec3.distance(old.center, instance.center) + instance.radius > old.radius + 1e-4) oldUnderBounds++;
    }
  }
  assert.ok(oldUnderBounds > 0, 'c9 bounds fail full-instance enclosure for this real instanced representation');
  const versions = repr.renderObjects.map(o => [o.values.boundingSphere.ref.version, o.values.instanceGrid.ref.version]);
  let checks = 0;
  for (let degrees = -60; degrees <= 60; degrees += 15) {
    Mat4.fromRotation(head, degrees * Math.PI / 180, Vec3.create(0, 1, 0));
    Mat4.setTranslation(head, Vec3.create(0, 1.1, 0));
    for (const view of syntheticViews()) {
      const eyeInRoom = Mat4.mul(Mat4(), head, view.transform.matrix);
      const frustum = Frustum3D.fromProjectionMatrix(Frustum3D(), Mat4.mul(Mat4(),
        view.projectionMatrix, Mat4.invert(Mat4(), eyeInRoom)));
      repr.renderObjects.forEach(({ values }, object) => {
        assert.ok(Frustum3D.intersectsSphere3D(frustum,
          Sphere3D.scaleNX(Sphere3D(), values.boundingSphere.ref.value, cameraScale)),
        `assembly render object ${object}, ${view.eye} eye, yaw ${degrees}`);
        checks++;
      });
    }
  }
  assert.equal(checks, 72);
  assert.deepEqual(repr.renderObjects.map(o => [o.values.boundingSphere.ref.version, o.values.instanceGrid.ref.version]), versions,
    'head yaw does not recompute aggregate or grid spheres');
  t.diagnostic(`${checks} assembly/eye/yaw intersections; ${oldUnderBounds}/60 instance spheres under-bounded by c9`);
});

test('spatial scale, nudges, fit, reset, room placement and clearance repair assembly bounds before canvas update', async t => {
  const assembly = assemblyFixture(), repr = await cartoon(t, assembly, 15), sphere = assembly.boundary.sphere;
  const { h, writes } = tourFocusHarness();
  h.loadedSphere = () => sphere;
  let updates = 0;
  wireViewer(h, repr, { onUpdate(current, keepSphere) {
    assert.equal(keepSphere, false);
    for (const { values } of current.renderObjects) {
      for (const instance of instanceSpheres(values)) containsSphere(values.boundingSphere.ref.value, instance);
    }
    updates++;
  } });
  h.clearHeldPlatePlacement = placement => placement.scale > 1
    ? { ...placement, translation: [placement.translation[0] + .5, placement.translation[1], placement.translation[2]] }
    : placement;
  Object.assign(h, {
    roomPlacement, roomAnchor: null, wearerPlacedInRoom: false, xrManipulation: null, menuResetActions,
    runSpatialAction: async (_action, operation) => operation(),
    // The extracted callback object also registers session visibility; this
    // bounds case dispatches spatial actions only.
    handleXrInputVisibility() {},
    // Seat policy has its own fixture tests. Keep a deterministic seat here to
    // test the real fit/reset dispatch, mutation and representation transform.
    roomAnchorPlacement: () => ({ translation: [0, 1, -2], rotation: [0, 0, 0], scale: 1, mode: 'auto', metersAcross: 1.8 }),
  });
  for (const name of ['seatStructureForEntry', 'placeRoomTarget', 'resetOrientation', 'runFaceAction',
    'releaseWearerPlacement', 'notePlacement']) {
    vm.runInContext(pageFunction(viewer, name), h);
  }
  const begin = viewer.indexOf('      onSpatialAction: async action => {');
  h.onSpatialAction = vm.runInContext('({' + viewer.slice(begin, viewer.indexOf('      onHeadFrame:', begin)) + '}).onSpatialAction', h);
  // A scale or a nudge is not a placement row and mints
  // no sentence; the three that seat the structure each mint one, and only
  // after their own mutation resolved.
  for (const action of [
    { kind: 'scale', direction: 1 }, { kind: 'scale', direction: -1 },
    { kind: 'nudge', mode: 'move', axis: 'x', direction: 1 },
    { kind: 'nudge', mode: 'turn', axis: 'y', direction: -1 },
  ]) {
    const before = updates;
    await h.onSpatialAction(action);
    assert.ok(updates > before, `${JSON.stringify(action)} must repair and publish bounds`);
    assert.equal(h.placementNote, null, `${JSON.stringify(action)} is not a placement`);
  }
  for (const action of [{ kind: 'fit' }, { kind: 'reset' }, { kind: 'room-placement', target: 'front' }]) {
    const before = updates;
    h.placementNote = null;
    await h.onSpatialAction(action);
    assert.ok(updates > before, `${JSON.stringify(action)} must repair and publish bounds`);
    assert.equal(typeof h.placementNote?.text, 'string', `${JSON.stringify(action)} must say where it put the structure`);
    assert.equal(h.placementNote.text, placementSentence(h.placementNote.reading));
  }
  await h.placeInspection({ scale: 1, translation: [0, 1, -1] });
  const before = h.inspectionSnapshot().placement;
  await h.placeInspection({ scale: 2 });
  assert.notDeepEqual(Array.from(h.inspectionSnapshot().placement.translation), Array.from(before.translation),
    'a clearance adjustment still updates the placed representation bounds');
  assert.equal(writes.at(-1).patch.scale, 2);
});
