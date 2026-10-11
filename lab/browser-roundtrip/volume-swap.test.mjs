/**
 * A density candidate through the swap, with no structure to reach for.
 *
 * The failure this file exists for was recorded on the diagnostics ring for
 * `microtubule-growth --stage filament`:
 *
 *   grow  parsed  atMs 1118  phaseMs 1091
 *   volume-build  bytes 8389632  triangles 0
 *   grow  built   atMs 1322  failed "Cannot read properties of undefined (reading 'checkValid')"
 *
 * The map was fetched and parsed in 1.1 s and the isosurface built in 0.2 s.
 * What threw was the frame wait inside `showCandidate`, which asked the
 * candidate for `record.structure.checkValid()` — and a density candidate has a
 * `volume` there and no `structure` at all.
 *
 * Every record in this file therefore carries a `structure` that is a getter
 * which throws on read. A fix that reaches for a structure fails here, and so
 * does the tempting fix of handing the volume path a fake structure: these
 * tests say the field must not be touched, not that it must merely be shaped
 * right.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { checkDrawnRecord, drawnRecordIsVisible } from './drawn-record.mjs';
import { representationTriangles, isosurfaceForBudget, quest2FramebufferScale } from './xr-render-budget.mjs';
import { MAP_DRAW_FAILED_SPOKEN, volumeSceneIdentity,
  VOLUME_ASSEMBLY_ID, VOLUME_MODEL_NUMBER } from './volume-source.mjs';
import { readFile } from 'node:fs/promises';

const failure = (code, message) => Object.assign(new Error(message), { code });

/** A Mol* cell selector that is live. */
const liveCell = () => ({ checkValid: () => true });
/** One render object, as Mol* values it: `drawCount` is three per triangle. */
const meshObject = (triangles, { type = 'mesh', instances = 1 } = {}) => ({
  type,
  values: {
    drawCount: { ref: { value: triangles * 3 } },
    instanceCount: { ref: { value: instances } },
  },
});
/** A built representation with `count` objects of `triangles` each. */
const representationOf = (objects, { visible = true } = {}) => ({
  checkValid: () => true,
  obj: { data: { repr: { state: { visible }, renderObjects: objects } } },
});

/**
 * A density candidate exactly as `buildVolumeCandidate` leaves one, with a
 * `structure` that reports any read of it.
 */
function volumeCandidate({ triangles = 177_604, visible = true } = {}) {
  const touched = [];
  const objects = [meshObject(triangles)];
  const record = {
    rootRef: 'candidate-ref',
    source: { id: 'session', sha256: 'f'.repeat(64), contour: 3.3 },
    volume: liveCell(),
    representation: representationOf(objects, { visible }),
    selectionKeys: [],
    triangles,
  };
  Object.defineProperty(record, 'structure', {
    enumerable: true,
    get() { touched.push(new Error('structure was read').stack); throw new TypeError('a density candidate has no structure'); },
  });
  return { record, objects, touched };
}

/** An atomic candidate, for the half of the contract that must not change. */
const structureCandidate = (triangles = 24_000) => {
  const objects = [meshObject(triangles)];
  return { rootRef: 'atomic-ref', structure: liveCell(), representation: representationOf(objects), objects };
};

test('the frame waiter validates a density candidate without reaching for a structure', () => {
  const { record, touched } = volumeCandidate();
  assert.equal(checkDrawnRecord(record, failure), 'volume');
  assert.deepEqual(touched, [], 'the volume path read `structure`');
});

test('an atomic candidate is still validated through its structure', () => {
  assert.equal(checkDrawnRecord(structureCandidate(), failure), 'structure');
});

test('a dead volume cell fails the frame wait the way a dead structure does', () => {
  const { record } = volumeCandidate();
  record.volume = { checkValid() { throw Error('The object is Null.'); } };
  assert.throws(() => checkDrawnRecord(record, failure), /The object is Null/);
});

test('a record with neither a structure nor a map is named, not dereferenced', () => {
  assert.throws(() => checkDrawnRecord({ representation: representationOf([]) }, failure),
    error => error.code === 'record_missing' && !(error instanceof TypeError));
  assert.throws(() => checkDrawnRecord(null, failure), error => error.code === 'record_missing');
});

test('a density candidate that is committed, visible and drawn settles the frame wait', () => {
  const { record, objects, touched } = volumeCandidate();
  assert.equal(drawnRecordIsVisible(record, {
    renderObjects: objects, reprCount: 1, expectedRepresentations: 1, commitQueueSize: 0,
  }), true);
  assert.deepEqual(touched, [], 'the readiness check read `structure`');
});

test('one isosurface and nothing else is the whole representation count of a density tier', () => {
  // A density lesson has no residue labels and no ligand overlay — both are
  // built from a structure — so `scientificRepresentationCount()` answers 1.
  // A canvas carrying a spatial toolbar row on top of it is not yet this frame.
  const { record, objects } = volumeCandidate();
  const canvas = { renderObjects: objects, reprCount: 1, expectedRepresentations: 2, commitQueueSize: 0 };
  assert.equal(drawnRecordIsVisible(record, canvas), false);
  assert.equal(drawnRecordIsVisible(record, { ...canvas, reprCount: 2, expectedRepresentations: 2 }), true);
});

test('a hidden, uncommitted or undrawn isosurface is not a finished frame', () => {
  const { objects } = volumeCandidate();
  const canvas = { renderObjects: objects, reprCount: 1, expectedRepresentations: 1, commitQueueSize: 0 };
  assert.equal(drawnRecordIsVisible(volumeCandidate({ visible: false }).record, canvas), false);
  assert.equal(drawnRecordIsVisible(volumeCandidate().record, { ...canvas, commitQueueSize: 1 }), false);
  // The mesh is in the scene but nothing of it has been uploaded yet.
  const empty = { record: undefined };
  empty.record = { volume: liveCell(), representation: representationOf([meshObject(0)]) };
  assert.equal(drawnRecordIsVisible(empty.record, { ...canvas, renderObjects: empty.record.representation.obj.data.repr.renderObjects }), false);
  // And a mesh the canvas has not been given is not on screen either.
  assert.equal(drawnRecordIsVisible(volumeCandidate().record, { ...canvas, renderObjects: [] }), false);
});

test('the volume build reports the triangles it actually built, not zero', () => {
  // The number the demo index promises for the `filament` tier, measured off
  // Mol*'s own `drawCount` — three indices per triangle, per `mesh.js`.
  const { record } = volumeCandidate({ triangles: 177_604 });
  assert.equal(representationTriangles(record.representation), 177_604);
  // Which is the count the budget then keys on. `triangles: 0` — what the
  // failing build reported — is refused outright on a Quest 2, and leaves the
  // framebuffer ladder to an atom count that is zero for every density tier.
  assert.equal(isosurfaceForBudget({ deviceClass: 'quest2', triangles: 177_604, grid: [128, 128, 128] }), 'allow');
  assert.equal(isosurfaceForBudget({ deviceClass: 'quest2', triangles: 0, grid: [128, 128, 128] }), 'refuse');
  assert.ok(quest2FramebufferScale(0, 177_604) < quest2FramebufferScale(0, 0));
});

test('a texture-mesh isosurface and instanced geometry are counted in the same unit', () => {
  const repr = representationOf([meshObject(1_000, { type: 'texture-mesh' }), meshObject(500, { instances: 3 })]);
  assert.equal(representationTriangles(repr), 1_000 + 1_500);
});

test('what is not a mesh is not counted, and what cannot be measured reads zero', () => {
  assert.equal(representationTriangles(representationOf([meshObject(900, { type: 'spheres' })])), 0);
  for (const absent of [undefined, null, {}, { obj: {} }, representationOf([])]) {
    assert.equal(representationTriangles(absent), 0);
  }
});

test('the line a wearer gets when the map will not draw is one short sentence', () => {
  assert.equal(MAP_DRAW_FAILED_SPOKEN, 'Could not draw the map.');
  assert.ok(MAP_DRAW_FAILED_SPOKEN.split(/\s+/).length <= 6);
  assert.ok(MAP_DRAW_FAILED_SPOKEN.endsWith('.'));
});

/**
 * The identity half.
 *
 * With the swap fixed the map drew, and the page still could not say what it
 * was. `liveScene` read a model number and an assembly off a structure that is
 * not there, answered null for both, and the two checks that read them refused
 * in turn — the restore inside `loadSource`, then `capture()` on the line after
 * it, which is what blocked the panel and stopped `attach()` from pairing it.
 */
test('a map identifies itself by its bytes, one model and the assembly named map', () => {
  const sha256 = '76040029d895758c3cad44226720685774b026fbcd706730ea5ccedb5fda152f';
  assert.deepEqual(volumeSceneIdentity({ sha256 }),
    { sourceSha256: sha256, modelNumber: VOLUME_MODEL_NUMBER, assemblyId: VOLUME_ASSEMBLY_ID });
  // These are the two fields `completeInspectionCapture` refuses when they are
  // null and `validInspectionCapture` compares. Neither may be null for a map
  // that has a digest, and the model number has to satisfy the scene schema's
  // positive integer.
  assert.equal(VOLUME_ASSEMBLY_ID, 'map');
  assert.ok(Number.isSafeInteger(VOLUME_MODEL_NUMBER) && VOLUME_MODEL_NUMBER > 0);
});

test('a wrong map is a different identity, and a map with no digest has none', () => {
  const one = volumeSceneIdentity({ sha256: 'a'.repeat(64) });
  const other = volumeSceneIdentity({ sha256: 'b'.repeat(64) });
  assert.notEqual(one.sourceSha256, other.sourceSha256);
  // Same model and same assembly: the bytes are the whole of what distinguishes
  // two maps, which is why the digest is checked before a parse and again here.
  assert.equal(one.modelNumber, other.modelNumber);
  assert.equal(one.assemblyId, other.assemblyId);
  const none = { sourceSha256: null, modelNumber: null, assemblyId: null };
  for (const source of [undefined, null, {}, { sha256: '' }, { sha256: 'ZZ' }, { sha256: 'A'.repeat(64) }]) {
    assert.deepEqual(volumeSceneIdentity(source), none, 'an unprovenanced map claimed an identity');
  }
});

test('the viewer reads a density scene identity off the map and never off a structure', async () => {
  // The source rather than a live viewer: `viewer.mjs` needs Mol* and a WebGL
  // context, and the defect was a branch that was never taken rather than a
  // value that came out wrong. What is held here is that the branch exists and
  // that the volume is asked about before anything reaches for `structure`.
  const source = await readFile(new URL('./viewer.mjs', import.meta.url), 'utf8');
  const scene = source.slice(source.indexOf('function liveScene('));
  const body = scene.slice(0, scene.indexOf('\n  }\n'));
  assert.match(body, /const loadedVolume = record\?\.volume \?\? volume;/);
  assert.match(body, /loadedVolume\s*\n?\s*\?\s*volumeSceneIdentity\(/);
  // And the structure is not dereferenced at all when a map is loaded, so the
  // model and assembly scan below it runs over nothing rather than over a
  // structure the density tier does not have.
  assert.match(body, /const data = loadedVolume \? undefined :/);
});
