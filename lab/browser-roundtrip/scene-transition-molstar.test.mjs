import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { StructureElement } from 'molstar/lib/mol-model/structure.js';
import { PluginContext } from 'molstar/lib/mol-plugin/context.js';
import { DefaultPluginSpec } from 'molstar/lib/mol-plugin/spec.js';
import { StateTransforms } from 'molstar/lib/mol-plugin-state/transforms.js';
import { createStructureRepresentationParams } from 'molstar/lib/mol-plugin-state/helpers/structure-representation-params.js';
import { runTransitionTask, representationLayerRef } from './scene-transition.mjs';
import { watchFrameCost } from './xr-render-budget.mjs';
import { requireGeometryBudget, structureGeometryCounts } from './representation-budget.mjs';
import { composeOverpaintLayers, selectionOverpaintLayer } from './selection-paint.mjs';
import { emptyVisibility, hiddenRowKeys } from './inspection-visibility.mjs';
import { pageFunction } from './fixtures/label-action-harness.mjs';
import { OrderedSet } from 'molstar/lib/mol-data/int.js';

// Actual Mol* parsing and CPU geometry, with only the unused DOM layout stubbed.
// The timer stands in for an XR scheduler. No GPU, eye draw or device pass is
// established by its interval measurements. Timing has no synthetic pass bar.
async function pluginForTest() {
  const document = globalThis.document;
  globalThis.document = { addEventListener() {}, removeEventListener() {}, createElement() { return { setAttribute() {} }; },
    head: { appendChild() {}, removeChild() {} } };
  const plugin = new PluginContext(DefaultPluginSpec());
  await plugin.init();
  return { plugin, dispose() { plugin.dispose(); if (document === undefined) delete globalThis.document; else globalThis.document = document; } };
}
async function cell(plugin, builder, yielding) {
  const selector = builder.selector;
  if (yielding) await runTransitionTask(plugin.state.data.updateTree(builder, { revertOnError: true }));
  else await builder.commit({ revertOnError: true });
  selector.checkValid(); return selector;
}
async function source(plugin, id, yielding, assemblyId = 'asymmetric_unit') {
  const data = await plugin.builders.data.rawData({ data: readFileSync(new URL(`../../fixtures/${id}.cif`, import.meta.url), 'utf8') });
  const trajectory = await cell(plugin, plugin.state.data.build().to(data).apply(StateTransforms.Data.ParseCif)
    .apply(StateTransforms.Model.TrajectoryFromMmCif), yielding);
  const model = await cell(plugin, plugin.state.data.build().to(trajectory).apply(StateTransforms.Model.ModelFromTrajectory, { modelIndex: 0 }), yielding);
  return cell(plugin, plugin.state.data.build().to(model).apply(StateTransforms.Model.StructureFromModel,
    { type: assemblyId === 'asymmetric_unit' ? { name: 'model', params: {} } : { name: 'assembly', params: { id: assemblyId } } }), yielding);
}
function params(plugin, structure, type) {
  const geometry = requireGeometryBudget({ ...structureGeometryCounts(structure.obj.data), representation: type,
    presenting: true, deviceClass: 'quest2', quality: 'low' });
  return createStructureRepresentationParams(plugin, structure.obj.data, { type, color: 'chain-id', typeParams: { quality: 'low', ...geometry.typeParams } });
}
const counts = repr => repr.obj.data.repr.renderObjects.map(object => ({ type: object.type,
  drawCount: object.values.drawCount.ref.value, instanceCount: object.values.instanceCount.ref.value }));
async function measured(operation) {
  const entries = []; let stopped = false, handle;
  const session = { frameRate: 72, requestAnimationFrame(callback) { return setTimeout(() => callback(performance.now()), 1000 / 72); } };
  const sample = watchFrameCost({ session, intervalMs: 0, record: (kind, detail) => entries.push({ kind, detail }), scope: {} });
  const tick = () => { if (!stopped) handle = session.requestAnimationFrame(tick); };
  tick();
  try {
    await new Promise(resolve => setTimeout(resolve, 30));
    entries.length = 0;
    const started = performance.now(), value = await operation();
    const elapsedMs = performance.now() - started;
    await new Promise(resolve => setTimeout(resolve, 30));
    return { value, elapsedMs: Math.round(elapsedMs * 100) / 100,
      maxTimerGapMs: Math.max(...entries.map(entry => entry.detail.maxFrameGapMs ?? 0)) };
  } finally { stopped = true; clearTimeout(handle); sample.stop(); }
}

for (const id of ['1CRN', '4HHB']) for (const type of ['cartoon', 'ball-and-stick', 'molecular-surface']) {
  test(`actual ${id} ${type} geometry stays identical across in-place and staged construction`, async t => {
    const h = await pluginForTest(), p = h.plugin;
    try {
      const structure = await source(p, id, false);
      // Start from another type so the baseline rebuilds rather than no-ops.
      const initial = type === 'cartoon' ? 'ball-and-stick' : 'cartoon';
      const previous = await cell(p, p.state.data.build().to(structure)
        .apply(StateTransforms.Representation.StructureRepresentation3D, params(p, structure, initial)), false);
      const appearance = params(p, structure, type);
      const before = await measured(() => cell(p, previous.update(appearance).to(previous.ref), false));
      const oldObjects = [...previous.obj.data.repr.renderObjects];
      const after = await measured(() => cell(p, p.state.data.build().to(structure)
        .apply(StateTransforms.Representation.StructureRepresentation3D, appearance, { state: { isHidden: true } }), true));
      assert.deepEqual(counts(after.value), counts(previous));
      assert.deepEqual(previous.obj.data.repr.renderObjects, oldObjects);
      assert.equal(previous.cell.status, 'ok'); assert.equal(after.value.cell.state.isHidden, true);
      assert.ok(counts(after.value).some(object => object.drawCount > 0));
      t.diagnostic(`transition-cpu ${JSON.stringify({ id, type, beforeMs: before.elapsedMs, afterMs: after.elapsedMs,
        beforeMaxTimerGapMs: before.maxTimerGapMs, afterMaxTimerGapMs: after.maxTimerGapMs, geometry: counts(after.value) })}`);
    } finally { h.dispose(); }
  });
}

test('actual 1CRN to 4HHB source staging preserves the original model and assembly until retirement', async t => {
  const h = await pluginForTest(), p = h.plugin;
  try {
    const previous = await source(p, '1CRN', false), oldData = previous.obj.data;
    const load = async yielding => {
      const structure = await source(p, '4HHB', yielding, '1');
      const repr = await cell(p, p.state.data.build().to(structure).apply(StateTransforms.Representation.StructureRepresentation3D,
        params(p, structure, 'cartoon'), { state: { isHidden: true } }), yielding);
      return { structure, repr };
    };
    const before = await measured(() => load(false)), after = await measured(() => load(true));
    assert.equal(previous.obj.data, oldData); assert.equal(previous.cell.status, 'ok');
    assert.deepEqual(counts(before.value.repr), counts(after.value.repr));
    assert.equal(after.value.structure.obj.data.models[0].modelNum, 1);
    assert.deepEqual([...new Set(after.value.structure.obj.data.units.map(unit => unit.conformation.operator.assembly?.id))], ['1']);
    assert.ok(previous.obj.data.units.every(unit => !unit.conformation.operator.assembly));
    assert.ok(after.value.structure.obj.data.elementCount > previous.obj.data.elementCount);
    assert.equal(after.value.repr.cell.state.isHidden, true);
    t.diagnostic(`transition-cpu ${JSON.stringify({ id: '1CRN→4HHB', type: 'source-cartoon', beforeMs: before.elapsedMs, afterMs: after.elapsedMs,
      beforeMaxTimerGapMs: before.maxTimerGapMs, afterMaxTimerGapMs: after.maxTimerGapMs })}`);
  } finally { h.dispose(); }
});

test('actual staged geometry copies legacy masks and repaints emphasis without changing retained Mol* modifiers', async () => {
  const h = await pluginForTest(), p = h.plugin;
  try {
    const structure = await source(p, '1CRN', false);
    const previous = await cell(p, p.state.data.build().to(structure)
      .apply(StateTransforms.Representation.StructureRepresentation3D, params(p, structure, 'cartoon')), false);
    const loci = StructureElement.Loci.all(structure.obj.data), bundle = StructureElement.Bundle.fromLoci(loci);
    const mask = await cell(p, p.state.data.build().to(previous)
      .apply(StateTransforms.Representation.TransparencyStructureRepresentation3DFromBundle,
        { layers: [{ bundle, value: 1 }] }, { ref: 'hidden-water' }), false);
    const originalMask = mask.obj;
    const viewer = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
    const begin = viewer.indexOf('        const builder = plugin.state.data.build();', viewer.indexOf('const staging ='));
    const end = viewer.indexOf('        representation = staged;', begin);
    assert.ok(begin >= 0 && end > begin);
    const c = vm.createContext({
    // This fixture does not paint, so drawing the selection costs it
    // nothing. `render-dedupe-harness.mjs` is the one that counts paints, and
    // its stub runs the real emphasis pass.
    currentSelectionPlan: () => undefined,
    async paintSelectionOverlay() {},
    composeOverpaintLayers, selectionOverpaintLayer, plugin: p, previousRepresentation: previous, representation: previous, structure,
      params: params(p, structure, 'ball-and-stick'), StateTransforms, crypto, VISIBILITY_LAYER_REF: { water: 'hidden-water' }, representationLayerRef,
      commitRepresentationUpdate: builder => runTransitionTask(p.state.data.updateTree(builder, { revertOnError: true })), prepareUploads: async () => {},
      now: () => performance.now(), recordCost() {}, assertContext() {}, check() {}, mergeEmphasisColourLayers: parts => parts,
      dropDeadOverlayRefs() {}, ligandOverlay: undefined, styleLayerTargets: () => [],
      liveEmphasisTargets: targets => ({ targets, missing: [] }), selection: { toLoci: () => loci }, StructureElement,
      Color: value => value, EMPHASIS_LAYER_REF: 'emphasis',
    });
    const staged = await vm.runInContext(`(async () => { let staged; ${viewer.slice(begin, end)} return staged; })()`, c);
    assert.equal(mask.obj, originalMask);
    assert.ok(p.state.data.cells.get(representationLayerRef(staged, 'hidden-water'))?.obj);
    assert.equal(staged.obj.data.repr.state.transparency.layers.length, 1);
    const paintStart = viewer.indexOf('  async function paintEmphasisLayers(');
    vm.runInContext(viewer.slice(paintStart, viewer.indexOf('\n  }', paintStart) + 4), c);
    const plan = color => ({ colours: [{ keys: ['all'], color }], faded: [], lit: ['all'] });
    await c.paintEmphasisLayers(plan('#ff0000'));
    const oldPaint = previous.obj.data.repr.state.overpaint;
    c.representation = staged;
    await c.paintEmphasisLayers(plan('#0000ff'));
    assert.equal(previous.obj.data.repr.state.overpaint, oldPaint);
    assert.equal(oldPaint.layers[0].color, 0xff0000);
    assert.equal(staged.obj.data.repr.state.overpaint.layers[0].color, 0x0000ff);
    await c.paintEmphasisLayers({ colours: [], faded: [], lit: [] });
    assert.equal(previous.obj.data.repr.state.overpaint, oldPaint);
    assert.ok(p.state.data.cells.get('emphasis-colour')?.obj);
  } finally { h.dispose(); }
});

test('actual Mol* selection and appearance repaint compose hidden chains after the context fade', async () => {
  const h = await pluginForTest(), p = h.plugin;
  try {
    const structure = await source(p, '4HHB', false);
    const repr = await cell(p, p.state.data.build().to(structure)
      .apply(StateTransforms.Representation.StructureRepresentation3D, params(p, structure, 'cartoon')), false);
    const units = structure.obj.data.units.slice(0, 2);
    assert.equal(units.length, 2);
    const rows = units.map((unit, index) => ({ key: `copy-${index}`, entityType: 'polymer',
      identity: { labelChain: `chain-${index}`, copyId: 'one' } }));
    const toLoci = keys => StructureElement.Loci(structure.obj.data, units.flatMap((unit, index) =>
      keys.includes(rows[index].key) ? [{ unit, indices: OrderedSet.ofBounds(0, unit.elements.length) }] : []));
    const plan = { colours: [], faded: rows.map(row => row.key), lit: [], transparency: 0.65 };
    const c = vm.createContext({ plugin: p, representation: repr, structure, StateTransforms, StructureElement,
      selection: { rows, toLoci }, state: { selectionKeys: [] }, stylesState: [],
      visibilityState: { ...emptyVisibility(), hiddenChains: [rows[0].identity] }, hiddenRowKeys,
      currentEmphasisPlan: () => plan, currentSelectionPlan: () => undefined,
      now: () => performance.now(), recordCost() {}, assertContext() {}, dropDeadOverlayRefs() {},
      ligandOverlay: undefined, styleLayerTargets: () => [], liveEmphasisTargets: targets => ({ targets, missing: [] }),
      mergeEmphasisColourLayers: parts => parts, composeOverpaintLayers, selectionOverpaintLayer, Color: value => value,
      EMPHASIS_LAYER_REF: 'emphasis', SCENE_VISIBILITY_LAYER_REF: 'visibility',
    });
    const viewer = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
    for (const name of ['hiddenSceneKeys', 'paintVisibilityLayers', 'paintEmphasisLayers', 'paintSelectionOverlay'])
      vm.runInContext(pageFunction(viewer, name), c);
    const verify = () => {
      const layers = repr.obj.data.repr.state.transparency.layers;
      assert.equal(layers.length, 2);
      assert.equal(layers[0].value, 0.65);
      assert.equal(layers[1].value, 1);
      assert.equal(layers[1].loci.elements.length, 1);
      assert.equal(layers[1].loci.elements[0].unit.id, units[0].id);
    };
    await c.paintSelectionOverlay();
    verify();
    await cell(p, repr.update(params(p, structure, 'ball-and-stick')).to(repr.ref), false);
    const start = viewer.indexOf('      const keptEmphasis = currentEmphasisPlan();');
    const end = viewer.indexOf('      if (canvas.xr.isPresenting.value)', start);
    c.emphasis = true; c.recovering = false;
    await vm.runInContext(`(async () => { ${viewer.slice(start, end)} })()`, c);
    verify();
    // Removing focus must retain the hide while removing only the context fade.
    plan.faded = [];
    await c.paintSelectionOverlay();
    assert.equal(repr.obj.data.repr.state.transparency.layers.length, 1);
    assert.equal(repr.obj.data.repr.state.transparency.layers[0].value, 1);
  } finally { h.dispose(); }
});
