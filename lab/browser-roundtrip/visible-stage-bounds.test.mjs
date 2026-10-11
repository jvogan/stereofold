import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { pageFunction } from './fixtures/label-action-harness.mjs';
import { createVisibleStageBoundsCache } from './visible-stage-bounds.mjs';

const viewer = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');

function catalogFixture() {
  let coordinateReads = 0;
  const rows = Array.from({ length: 400 }, (_, residue) => ({
    identity: { entityId: '1', labelChain: residue < 200 ? 'A' : 'B', operatorIds: ['1'] },
    atomSites: Array.from({ length: 10 }, (_, atom) => ({
      get assemblyCoordinatesAngstrom() { coordinateReads++; return [residue, atom, residue % 5]; },
    })),
  }));
  return { catalog: { rows }, reads: () => coordinateReads };
}

test('360 moving frames measure a staged source once while preserving every transform', t => {
  const fixture = catalogFixture();
  const context = vm.createContext({
    Mat4, Vec3, sourceRecord: { catalog: fixture.catalog }, visibleStage: { labelChains: ['A'] },
    loadedSphere: () => ({ center: [200, 5, 2], radius: 210 }),
    inspectionSnapshot: () => ({ placement: { scale: 1, rotation: [0, 0, 0], translation: [0, 0, 0] } }),
    inspectionState: { placement: () => ({ scale: 1, rotation: [0, 0, 0], translation: [0, 0, 0] }) },
    motionAngle: 0, grabOffset: null, grabTransform: () => undefined,
    cachedVisibleStageBounds: createVisibleStageBoundsCache(),
  });
  for (const name of ['catalogVisibleBounds', 'pivotCenter', 'placementTransform', 'presentationTransform']) {
    vm.runInContext(pageFunction(viewer, name), context);
  }
  for (let frame = 1; frame <= 360; frame++) {
    context.motionAngle = frame;
    const actual = context.presentationTransform();
    const center = Vec3.create(99.5, 4.5, 2);
    const expected = Mat4.mul3(Mat4(), Mat4.fromTranslation(Mat4(), center),
      Mat4.fromRotation(Mat4(), frame * Math.PI / 180, Vec3.create(0, 1, 0)),
      Mat4.fromTranslation(Mat4(), Vec3.negate(Vec3(), center)));
    assert.deepEqual(Array.from(actual), Array.from(expected));
  }
  t.diagnostic(JSON.stringify({ frames: 360, selectedAtoms: 2000, coordinateReads: fixture.reads() }));
  assert.equal(fixture.reads(), 2000, 'unchanged staged source must not rescan atom coordinates every moving frame');
});

test('stage filters, cloned settings, replaced rows and source identity retain the correct bounds', () => {
  const fixture = catalogFixture(), bounds = createVisibleStageBoundsCache();
  const stage = { entityIds: ['1'], labelChains: ['A'], operatorIds: ['1'] };
  assert.deepEqual(bounds(fixture.catalog, stage).center, [99.5, 4.5, 2]);
  assert.deepEqual(bounds(fixture.catalog, structuredClone(stage)).center, [99.5, 4.5, 2]);
  assert.equal(fixture.reads(), 2000);
  stage.labelChains[0] = 'B';
  assert.deepEqual(bounds(fixture.catalog, stage).center, [299.5, 4.5, 2]);
  assert.equal(fixture.reads(), 4000);
  fixture.catalog.rows = fixture.catalog.rows.slice(300);
  assert.deepEqual(bounds(fixture.catalog, stage).center, [349.5, 4.5, 2]);
  assert.equal(fixture.reads(), 5000);
  const replacement = catalogFixture();
  assert.deepEqual(bounds(replacement.catalog, stage).center, [299.5, 4.5, 2]);
  assert.equal(replacement.reads(), 2000, 'a different source cannot reuse the old center');
  stage.entityIds[0] = '2';
  assert.equal(bounds(replacement.catalog, stage), undefined);
  stage.entityIds[0] = '1'; stage.operatorIds[0] = '2';
  assert.equal(bounds(replacement.catalog, stage), undefined);
});

test('empty filters, absent filters, invalid coordinates and caller mutation retain existing semantics', () => {
  let reads = 0;
  const catalog = { rows: [{ identity: { entityId: 1, labelChain: 'A', operatorIds: [1] }, atomSites: [
    { get assemblyCoordinatesAngstrom() { reads++; return [NaN, 0, 0]; } },
    { assemblyCoordinatesAngstrom: [-4, 2, 8] }, { assemblyCoordinatesAngstrom: [2, 6, 10] },
    { assemblyCoordinatesAngstrom: [1, 2] }, {},
  ] }, {}] };
  const bounds = createVisibleStageBoundsCache();
  assert.equal(bounds(catalog, undefined), undefined);
  assert.equal(bounds(catalog, { labelChains: [] }), undefined);
  const measured = bounds(catalog, {});
  assert.deepEqual(measured, { center: [-1, 4, 9], radius: Math.sqrt(14), extent: [6, 4, 2] });
  measured.center[0] = 123; measured.extent[0] = 123; measured.radius = 123;
  assert.deepEqual(bounds(catalog, {}), { center: [-1, 4, 9], radius: Math.sqrt(14), extent: [6, 4, 2] });
  assert.equal(reads, 1);
  assert.equal(bounds({ rows: null }, {}), undefined);
});

test('an empty finite-coordinate result is cached, then replaced by a new catalog', () => {
  let reads = 0;
  const catalog = { rows: [{ identity: { labelChain: 'A' }, atomSites: [
    { get assemblyCoordinatesAngstrom() { reads++; return [Infinity, 0, 0]; } },
  ] }] };
  const bounds = createVisibleStageBoundsCache();
  assert.equal(bounds(catalog, {}), undefined);
  assert.equal(bounds(catalog, {}), undefined);
  assert.equal(reads, 1);
  const replacement = { rows: [{ identity: { labelChain: 'A' }, atomSites: [{ assemblyCoordinatesAngstrom: [1, 2, 3] }] }] };
  assert.deepEqual(bounds(replacement, {}), { center: [1, 2, 3], radius: 0, extent: [0, 0, 0] });
});

test('the production pivot follows adopted stages and falls back to the current assembly or density', () => {
  const fixture = catalogFixture();
  const context = vm.createContext({
    Vec3, cachedVisibleStageBounds: createVisibleStageBoundsCache(),
    sourceRecord: { catalog: fixture.catalog }, visibleStage: { labelChains: ['A'] },
    loadedSphere: () => ({ center: [200, 5, 2], radius: 210 }),
  });
  for (const name of ['catalogVisibleBounds', 'pivotCenter']) vm.runInContext(pageFunction(viewer, name), context);
  assert.deepEqual(Array.from(context.pivotCenter()), [99.5, 4.5, 2]);
  context.visibleStage = { labelChains: ['B'] };
  assert.deepEqual(Array.from(context.pivotCenter()), [299.5, 4.5, 2]);
  context.visibleStage = { labelChains: ['absent'] };
  assert.deepEqual(Array.from(context.pivotCenter()), [200, 5, 2]);
  context.visibleStage = undefined;
  assert.deepEqual(Array.from(context.pivotCenter()), [200, 5, 2]);
  context.sourceRecord = { catalog: { rows: [{ identity: { labelChain: 'A' }, atomSites: [
    { assemblyCoordinatesAngstrom: [8, 9, 10] },
  ] }] } };
  context.visibleStage = { labelChains: ['A'] };
  assert.deepEqual(Array.from(context.pivotCenter()), [8, 9, 10]);
  context.sourceRecord = {};
  context.loadedSphere = () => ({ center: [-20, 6, 4], radius: 90 });
  assert.deepEqual(Array.from(context.pivotCenter()), [-20, 6, 4]);
});
