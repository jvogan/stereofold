import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { PluginContext } from 'molstar/lib/mol-plugin/context.js';
import { DefaultPluginSpec } from 'molstar/lib/mol-plugin/spec.js';
import { StateTransforms } from 'molstar/lib/mol-plugin-state/transforms.js';
import { createStructureRepresentationParams } from 'molstar/lib/mol-plugin-state/helpers/structure-representation-params.js';
import { StructureElement } from 'molstar/lib/mol-model/structure.js';
import { OrderedSet } from 'molstar/lib/mol-data/int.js';
import { Overpaint } from 'molstar/lib/mol-theme/overpaint.js';
import { composeOverpaintLayers, selectionOverpaintLayer } from './selection-paint.mjs';
import { representationLayerRef } from './scene-transition.mjs';
import { mergeEmphasisColourLayers } from './lesson-emphasis.mjs';
import { pageFunction } from './fixtures/label-action-harness.mjs';

// Real Mol* cartoon geometry, decorator transforms and state synchronization.
// Only DOM layout is stubbed. These tests make no GPU or headset claim.
async function fixture(t) {
  const document = globalThis.document;
  globalThis.document = { addEventListener() {}, removeEventListener() {}, createElement() { return { setAttribute() {} }; },
    head: { appendChild() {}, removeChild() {} } };
  const plugin = new PluginContext(DefaultPluginSpec());
  await plugin.init();
  t.after(() => { plugin.dispose(); if (document === undefined) delete globalThis.document; else globalThis.document = document; });
  const data = await plugin.builders.data.rawData({ data: readFileSync(new URL('../../fixtures/4HHB.cif', import.meta.url), 'utf8') });
  const trajectory = await plugin.build().to(data).apply(StateTransforms.Data.ParseCif).apply(StateTransforms.Model.TrajectoryFromMmCif).commit();
  const model = await plugin.build().to(trajectory).apply(StateTransforms.Model.ModelFromTrajectory, { modelIndex: 0 }).commit();
  const structure = await plugin.build().to(model).apply(StateTransforms.Model.StructureFromModel, { type: { name: 'model', params: {} } }).commit();
  const params = type => createStructureRepresentationParams(plugin, structure.obj.data, { type, color: 'uniform', typeParams: { quality: 'low' } });
  const representation = await plugin.build().to(structure).apply(StateTransforms.Representation.StructureRepresentation3D, params('cartoon')).commit();
  const units = structure.obj.data.units;
  const toLoci = keys => StructureElement.Loci(structure.obj.data, units.flatMap((unit, i) => keys.includes(String(i))
    ? [{ unit, indices: OrderedSet.ofBounds(0, unit.elements.length) }] : []));
  const context = vm.createContext({ plugin, representation, structure, StateTransforms, StructureElement,
    selection: { toLoci }, currentSelectionPlan: () => undefined, composeOverpaintLayers, selectionOverpaintLayer,
    representationLayerRef, mergeEmphasisColourLayers, dropDeadOverlayRefs() {}, styleLayerTargets: () => [],
    liveEmphasisTargets: targets => ({ targets, missing: [] }), ligandOverlay: undefined,
    now: () => performance.now(), recordCost() {}, assertContext() {}, Color: value => value, EMPHASIS_LAYER_REF: 'emphasis' });
  const viewer = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
  vm.runInContext(pageFunction(viewer, 'paintEmphasisLayers'), context);
  const plan = { colours: [{ keys: ['0'], color: '#4a90e2' }, { keys: ['1'], color: '#f5a623' }], lit: ['0', '1'], faded: [], transparency: 0 };
  const paint = value => context.paintEmphasisLayers(value ?? plan, { transparency: false });
  const repr = representation.obj.data.repr, writes = [], setState = repr.setState;
  repr.setState = state => { if (state.overpaint) writes.push(state.overpaint); return setState(state); };
  return { plugin, structure, representation, repr, context, plan, paint, writes, params,
    colour: () => plugin.state.data.cells.get(`${representationLayerRef(context.representation, 'emphasis')}-colour`) };
}

const buffers = repr => repr.renderObjects.map(object => ({ id: object.id,
  colour: [...object.values.tOverpaint.ref.value.array], count: object.values.drawCount.ref.value,
  transparency: [...object.values.tTransparency.ref.value.array] }));

test('an unchanged chapter keeps actual Mol* overpaint buffers and decorator without clear/repaint', async t => {
  const h = await fixture(t);
  await h.paint();
  const cell = h.colour(), state = h.repr.state.overpaint, before = buffers(h.repr);
  h.writes.length = 0;
  await h.paint(structuredClone(h.plan));
  assert.equal(h.colour(), cell);
  assert.equal(h.repr.state.overpaint, state);
  assert.deepEqual(h.writes, []);
  assert.deepEqual(buffers(h.repr), before);
});

test('selection and changed colours still update, while empty intent removes the decorator', async t => {
  const h = await fixture(t);
  await h.paint(); h.writes.length = 0;
  h.context.currentSelectionPlan = () => ({ keys: ['0'], color: '#ff2dd4' });
  await h.paint();
  assert.equal(h.writes.length, 1);
  assert.equal(h.repr.state.overpaint.layers.at(-1).color, 0xff2dd4);
  h.context.currentSelectionPlan = () => undefined;
  await h.paint({ ...h.plan, colours: [{ keys: ['0'], color: '#00ff00' }] });
  assert.equal(h.writes.length, 2);
  assert.equal(h.repr.state.overpaint.layers.length, 1);
  assert.equal(h.repr.state.overpaint.layers[0].color, 0x00ff00);
  await h.paint({ colours: [], lit: [], faded: [], transparency: 0 });
  assert.equal(h.colour(), undefined);
  assert.equal(h.repr.state.overpaint.layers.length, 0);
});

test('externally cleared paint and lost decorators are restored even with identical authored colours', async t => {
  const h = await fixture(t);
  await h.paint();
  const initial = buffers(h.repr);
  h.repr.setState({ overpaint: Overpaint.Empty }); h.writes.length = 0;
  await h.paint();
  assert.ok(h.writes.length > 0);
  assert.deepEqual(buffers(h.repr), initial);
  await h.plugin.build().delete('emphasis-colour').commit(); h.writes.length = 0;
  await h.paint();
  assert.equal(h.writes.length, 1);
  assert.deepEqual(buffers(h.repr), initial);
});

test('geometry rebuilds and replacement representations receive current paint', async t => {
  const h = await fixture(t);
  await h.paint();
  await h.representation.update(h.params('ball-and-stick')).commit();
  // An appearance rebuild may retain an equal decorator while replacing its
  // buffers; the production guard must still leave the new geometry painted.
  await h.paint();
  assert.equal(h.representation.obj.data.repr.state.overpaint.layers.length, 2);
  const replacement = await h.plugin.build().to(h.structure).apply(StateTransforms.Representation.StructureRepresentation3D,
    h.params('cartoon'), { ref: 'stereofold-transition-replacement' }).commit();
  h.context.representation = replacement;
  await h.paint();
  assert.equal(replacement.obj.data.repr.state.overpaint.layers.length, 2);
  assert.ok(h.colour());
  assert.equal(h.representation.obj.data.repr.state.overpaint.layers.length, 2, 'retained geometry keeps its old key');
});
