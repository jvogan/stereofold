import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { harness, viewerSource } from './render-dedupe-harness.mjs';
import { withFigureRepresentation } from './lesson-figure-appearance.mjs';
import { cameraSnapshot } from './camera-snapshot.mjs';
import { requireSceneGeometryBudget } from './representation-budget.mjs';

const authored = { layers: [
  { id: 'custom-protein', target: { chain: 'local-chain' }, representation: 'cartoon', opacity: 1, color: '#25859b' },
  { id: 'custom-envelope', target: { chain: 'local-chain' }, representation: 'gaussian-surface', opacity: .14, color: '#60b4c1' },
], labels: [{ id: 'custom-name', target: { chain: 'local-chain' }, text: 'My structure', color: '#25859b' }], distances: [] };
const camera = { mode: 'perspective', fov: Math.PI / 4, position: [0, 0, 80], target: [0, 0, 0], up: [0, 1, 0],
  radius: 20, radiusMax: 20, fog: 0, clipFar: true, minNear: 1, minFar: 0 };
const plain = value => JSON.parse(JSON.stringify(value));
const section = (start, end) => viewerSource.slice(viewerSource.indexOf(start), viewerSource.indexOf(end, viewerSource.indexOf(start)));
function fixture() {
  const h = harness(), c = h.context, installs = [];
  let figure = structuredClone(authored);
  Object.assign(c, { withFigureRepresentation, cameraSnapshot, desktopPreviewCamera: undefined,
    savedStyles: () => c.stylesState.length ? { styles: c.stylesState } : {}, savedVisibility: () => ({}),
    ligandOverlay: undefined,
    INSPECTION_REPRESENTATIONS: new Set(['cartoon', 'ball-and-stick', 'spacefill', 'molecular-surface']),
    INSPECTION_COLORS: new Set(['chain-id', 'uniform']),
    currentMolstarSelectionKeys: () => undefined,
    styleLayerDefinitions: (styles, appearance) => ({ styles, appearance }),
    sceneGeometry: (plans, record, representation, nextFigure) => {
      if (c.refuseFigureBudget) throw Error('geometry_budget_exceeded');
      assert.equal(representation, nextFigure.representationOverride);
      assert.equal(plans.appearance.representation, representation);
      assert.deepEqual(plain(figure), authored, 'actual next figure budget is admitted before any figure mutation');
    },
    lessonFigure: { definition: () => figure ? structuredClone(figure) : undefined,
      async install(value) { figure = value ? structuredClone(value) : undefined; installs.push(plain(value ?? null)); } },
  });
  c.canvas.camera.getSnapshot = () => camera; c.canvas.camera.setState = () => {};
  c.representation.cell = h.cells.get(c.representation.ref);
  vm.runInContext(section('  function inspectionPayload()', '\n  let inspectionMutationSettlement')
    + section('  function restoreInspectionPayload()', '\n  function markerCounts()')
    + section('  async function undoInspection()', '\n  async function saveInspectionView(')
    + section('  async function synchronizeRepresentationFromPlugin(', '\n  function geometryFor(')
    + '\nglobalThis.figureHistory = { undoInspection, redoInspection, synchronizeRepresentationFromPlugin };', c);
  c.inspectionLayersIntact = () => true; // This scheduling fixture does not build scoped meshes.
  c.inspectionState.configure({ opacity: .02, representation: 'spacefill' });
  c.inspectionState.place({ translation: [2, -1, .4], rotation: [10, 35, -20], scale: 3 });
  c.stylesState = [{ selectionKeys: [h.rows[0].key], representation: 'ball-and-stick', color: 'uniform', uniformColor: '#ff8800' }];
  h.state.selectionKeys = [h.rows[1].key];
  c.syncInspectionPayload();
  return { ...h, installs, figure: () => plain(figure), undo: c.figureHistory.undoInspection, redo: c.figureHistory.redoInspection, syncStock: c.figureHistory.synchronizeRepresentationFromPlugin };
}

test('a global style changes the visible figure even when the faint base already has that representation', async () => {
  const h = fixture(), before = h.snapshot(), history = before.inspection.history.undoCount;
  await h.configureInspection({ representation: 'spacefill' }, { sceneRepresentation: true, preservePlacement: true });
  assert.equal(h.figure().representationOverride, 'spacefill');
  assert.deepEqual(h.figure().layers, authored.layers);
  assert.deepEqual(h.figure().labels, authored.labels);
  assert.equal(h.snapshot().inspection.appearance.opacity, .02, 'the authored faint base is not made into a second opaque mesh');
  assert.deepEqual(h.snapshot().inspection.placement, before.inspection.placement);
  assert.deepEqual(h.state.selectionKeys, before.selectionKeys);
  assert.deepEqual(h.context.stylesState[0], { selectionKeys: [h.rows[0].key], representation: 'ball-and-stick', color: 'uniform', uniformColor: '#ff8800' });
  assert.equal(h.snapshot().inspection.history.undoCount, history + 1);
  await h.configureInspection({ representation: 'spacefill' }, { sceneRepresentation: true, preservePlacement: true });
  assert.equal(h.snapshot().inspection.history.undoCount, history + 1, 'same whole-scene choice is a no-op');
});

test('figure styles and annotations survive one-step undo, redo, capture and serialized handoff payload', async () => {
  const h = fixture(), placement = h.snapshot().inspection.placement;
  await h.configureInspection({ representation: 'ball-and-stick' }, { sceneRepresentation: true, preservePlacement: true });
  const serialized = plain(h.context.inspectionState.payload());
  assert.equal(serialized.lessonFigure.representationOverride, 'ball-and-stick');
  assert.deepEqual(serialized.lessonFigure.labels, authored.labels);
  await h.undo();
  assert.deepEqual(h.figure(), authored);
  assert.equal(h.snapshot().inspection.appearance.representation, 'spacefill');
  await h.redo();
  assert.equal(h.figure().representationOverride, 'ball-and-stick');
  assert.equal(h.snapshot().inspection.appearance.representation, 'ball-and-stick');
  assert.deepEqual(h.snapshot().inspection.placement, placement);
});

test('authored and scoped edits do not silently become global figure choices', async () => {
  const h = fixture();
  await h.configureInspection({ representation: 'cartoon' });
  assert.deepEqual(h.figure(), authored);
  await h.compound({ kind: 'compound', patch: { ops: [
    { kind: 'styles', patch: { styles: [{ selectionKeys: [h.rows[0].key], representation: 'spacefill' }] } },
    { kind: 'selection', patch: { selectionKeys: [h.rows[2].key] } },
  ] } }, { sceneRepresentation: true, preservePlacement: true });
  assert.deepEqual(h.figure(), authored);
});

test('a global representation in a compound shares its one undo entry with selection and placement', async () => {
  const h = fixture(), before = h.snapshot(), history = before.inspection.history.undoCount;
  await h.compound({ kind: 'compound', patch: { ops: [
    { kind: 'appearance', patch: { representation: 'molecular-surface' } },
    { kind: 'selection', patch: { selectionKeys: [h.rows[2].key] } },
    { kind: 'placement', patch: { scale: 4 } },
  ] } }, { sceneRepresentation: true, preservePlacement: true });
  assert.equal(h.figure().representationOverride, 'molecular-surface');
  assert.equal(h.snapshot().inspection.history.undoCount, history + 1);
  await h.undo();
  assert.deepEqual(h.figure(), authored);
  assert.deepEqual(h.state.selectionKeys, before.selectionKeys);
  assert.deepEqual(h.snapshot().inspection.placement, before.inspection.placement);
});

test('a failed global draw restores authored geometry intent and history before admitting another edit', async () => {
  const h = fixture(), before = h.context.inspectionState.checkpoint();
  h.failFrame();
  await assert.rejects(h.configureInspection({ representation: 'ball-and-stick' }, { sceneRepresentation: true, preservePlacement: true }), /frame_failed/);
  assert.deepEqual(h.figure(), authored);
  assert.deepEqual(plain(h.context.inspectionState.checkpoint()), plain(before));
  assert.equal(h.state.status, 'ready');
  await h.configureInspection({ representation: 'cartoon' }, { sceneRepresentation: true, preservePlacement: true });
  assert.equal(h.figure().representationOverride, 'cartoon');
});


const stockRepresentation = (h, representation) => { h.context.representation.cell.params.values.type.name = representation; };

test('a stock global representation paints the authored figure in one history and frame transaction', async () => {
  const h = fixture(), before = h.snapshot();
  stockRepresentation(h, 'ball-and-stick');
  h.resetCounts();
  await h.syncStock();
  assert.equal(h.figure().representationOverride, 'ball-and-stick');
  assert.deepEqual(h.figure().layers, authored.layers);
  assert.deepEqual(h.figure().labels, authored.labels);
  assert.deepEqual(h.snapshot().inspection.placement, before.inspection.placement);
  assert.deepEqual(h.state.selectionKeys, before.selectionKeys);
  assert.equal(h.snapshot().inspection.history.undoCount, before.inspection.history.undoCount + 1);
  assert.equal(h.counts.frames, 1);
  assert.equal(h.counts.publications, 1);
  assert.equal(h.snapshot().generation, before.generation, 'stock styling does not reload or replace the source');
  assert.equal(h.context.inspectionState.payload().lessonFigure.representationOverride, 'ball-and-stick');
  await h.undo();
  assert.deepEqual(h.figure(), authored);
  assert.deepEqual(h.state.selectionKeys, before.selectionKeys);
  await h.redo();
  assert.equal(h.figure().representationOverride, 'ball-and-stick');
});

test('stock selection and appearance together share one undo entry and retain the prior selection for undo', async () => {
  const h = fixture(), before = h.snapshot();
  stockRepresentation(h, 'cartoon');
  h.context.currentMolstarSelectionKeys = () => [h.rows[2].key];
  await h.syncStock({ selectionChanged: true });
  assert.equal(h.figure().representationOverride, 'cartoon');
  assert.deepEqual(h.state.selectionKeys, [h.rows[2].key]);
  assert.equal(h.snapshot().inspection.history.undoCount, before.inspection.history.undoCount + 1);
  await h.undo();
  assert.deepEqual(h.state.selectionKeys, before.selectionKeys);
  assert.deepEqual(h.figure(), authored);
});

test('selection-only and unchanged-type ref replacement do not override authored figure styles', async () => {
  const h = fixture();
  stockRepresentation(h, 'spacefill');
  h.context.currentMolstarSelectionKeys = () => [h.rows[2].key];
  await h.syncStock({ selectionChanged: true });
  assert.deepEqual(h.figure(), authored);
  assert.equal(h.installs.length, 0);
  const old = h.context.representation;
  const next = { ...old, ref: 'source-rebound-representation' };
  h.cells.set(next.ref, next.cell);
  h.context.findCurrentStructureRepresentation = () => next;
  await h.syncStock();
  assert.deepEqual(h.figure(), authored);
  assert.equal(h.installs.length, 0);
});

for (const reason of ['budget', 'draw']) test(`a refused stock ${reason} restores observed base mutation, figure, selection and history`, async () => {
  const h = fixture(), before = plain(h.context.inspectionState.checkpoint()), keys = [...h.state.selectionKeys];
  stockRepresentation(h, 'molecular-surface');
  if (reason === 'budget') h.context.refuseFigureBudget = true;
  else h.failFrame();
  await assert.rejects(h.syncStock(), reason === 'budget' ? /geometry_budget_exceeded/ : /frame_failed/);
  assert.deepEqual(h.figure(), authored);
  assert.deepEqual(h.state.selectionKeys, keys);
  assert.deepEqual(plain(h.context.inspectionState.checkpoint()), before);
  assert.equal(h.context.representation.cell.params.values.type.name, 'spacefill');
  assert.equal(h.state.status, 'ready');
  assert.equal(h.counts.publications, 0);
  assert.equal(h.context.inspectionState.groupOpen(), false);
  if (reason === 'budget') assert.equal(h.installs.length, 0, 'budget refusal does not mutate figure geometry');
});


test('stock reconciliation budgets the actual next figure together with the already changed base before installing it', async () => {
  const h = fixture(), c = h.context, counts = { atoms: 7000, bonds: 0, residues: 7000 };
  const options = { presenting: true, deviceClass: 'quest2', quality: 'lowest' };
  assert.doesNotThrow(() => requireSceneGeometryBudget([{ representation: 'cartoon', ...counts }], options));
  Object.assign(c, { requireSceneGeometryBudget, sessionDeviceClass: () => 'quest2', currentXrSession: () => ({}),
    xrRepresentationQuality: () => 'lowest', isStandaloneHmdAgent: () => false,
    sceneGeometryEntries: (plans, record, representation) => [{ representation, ...counts }],
  });
  c.lessonFigure.geometryEntries = nextFigure => nextFigure?.representationOverride
    ? [{ representation: nextFigure.representationOverride, ...counts }] : [];
  c.canvas.xr.isPresenting.value = true;
  vm.runInContext(section('  function sceneGeometry(plans', '\n  async function paintCompanion('), c);
  stockRepresentation(h, 'cartoon');
  await h.syncStock();
  assert.equal(h.installs.length, 1);
  assert.equal(h.figure().representationOverride, 'cartoon');
  assert.equal(c.representation.cell.params.values.type.name, 'cartoon');
  assert.equal(h.state.status, 'ready');
});

test('a busy stock reconciliation does not mutate figure or another admitted transaction', async () => {
  const h = fixture(), before = plain(h.context.inspectionState.checkpoint());
  stockRepresentation(h, 'cartoon');
  h.context.busy = true;
  await assert.rejects(h.syncStock(), /viewer_busy/);
  assert.deepEqual(h.figure(), authored);
  assert.deepEqual(plain(h.context.inspectionState.checkpoint()), before);
  assert.equal(h.installs.length, 0);
});

test('global configure preflights the prospective figure before renderer admission or history changes', async () => {
  const h = fixture(), before = plain(h.context.inspectionState.checkpoint());
  let checked = 0;
  h.context.geometryFor = (representation, data, nextFigure) => {
    checked++;
    assert.equal(representation, 'ball-and-stick');
    assert.equal(nextFigure.representationOverride, representation);
    assert.deepEqual(h.figure(), authored);
    throw Object.assign(Error('Complete next scene exceeds budget'), { code: 'representation_budget_exceeded' });
  };
  await assert.rejects(h.configureInspection({ representation: 'ball-and-stick' }, { sceneRepresentation: true }),
    { code: 'representation_budget_exceeded' });
  assert.equal(checked, 1);
  assert.equal(h.installs.length, 0);
  assert.equal(h.counts.appearance, 0);
  assert.equal(h.counts.publications, 0);
  assert.deepEqual(plain(h.context.inspectionState.checkpoint()), before);
  assert.deepEqual(h.figure(), authored);
});
