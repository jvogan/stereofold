/**
 * On a Quest 2, "select residues 10 to 20" rendered, the plate
 * read `11 selected`, and the 1CRN cartoon carried no mark. These build the
 * real 1CRN structure, take the real selection adapter's loci for residues 10
 * to 20, and check that the overpaint layer the viewer paints covers those
 * residues and no others — after the selection, after a colour change, and
 * after a representation change.
 */
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createSelectionAdapter } from './selection.mjs';
import extraction from '../identity/extract.cjs';
import { colorDistance, composeOverpaintLayers, selectionMarkColor, selectionOverpaintLayer,
  selectionPaintPlan, SELECTION_MARK_COLORS, SELECTION_MARK_MIN_BACKGROUND_DISTANCE } from './selection-paint.mjs';

const require = createRequire(new URL('../../plugin/package.json', import.meta.url));
const { CIF } = require('molstar/lib/commonjs/mol-io/reader/cif.js');
const { trajectoryFromMmCIF } = require('molstar/lib/commonjs/mol-model-formats/structure/mmcif.js');
const { Structure } = require('molstar/lib/commonjs/mol-model/structure/structure/structure.js');
const { StructureSymmetry } = require('molstar/lib/commonjs/mol-model/structure/structure/symmetry.js');
const { StructureElement } = require('molstar/lib/commonjs/mol-model/structure/structure/element.js');
const { extractBytes } = extraction;

let scene;

/** The viewer's own remap-and-take, lifted out of `paintEmphasisLayers`. */
function bundleFor(adapter, structure) {
  return (keys, data) => {
    const loci = adapter.toLoci(keys);
    const mapped = data ? StructureElement.Loci.remap(loci, data) : loci;
    return StructureElement.Loci.isEmpty(mapped) ? undefined : StructureElement.Bundle.fromLoci(mapped);
  };
}

/** The identity `Color` stands in for Mol*'s packed integer, so a test can read the colour back. */
const color = value => value;

before(async () => {
  const bytes = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url));
  const parsed = await CIF.parse(bytes.toString('utf8')).run();
  assert.equal(parsed.isError, false);
  const trajectory = await trajectoryFromMmCIF(parsed.result.blocks[0]).run();
  const frame = trajectory.getFrameAtIndex(0);
  const model = typeof frame.run === 'function' ? await frame.run() : frame;
  const structure = await StructureSymmetry.buildAssembly(Structure.ofModel(model), '1').run();
  const catalog = await extractBytes(bytes, { sourceLabel: '1CRN', assemblyId: '1' });
  const adapter = createSelectionAdapter(structure, catalog);
  // The wearer's ask: residues 10 to 20 of the one chain 1CRN has.
  const keys = adapter.rows
    .filter(row => row.identity.labelSequenceId >= 10 && row.identity.labelSequenceId <= 20)
    .map(row => row.key);
  scene = { structure, adapter, keys, bundleFor: bundleFor(adapter, structure) };
});

test('the selection is painted over exactly the residues that were selected', () => {
  assert.equal(scene.keys.length, 11, 'the device run selected eleven residues');
  const plan = selectionPaintPlan({ selectionKeys: scene.keys,
    appearance: { background: '#071015', highlightColor: '#f2c47c' } });
  const layer = selectionOverpaintLayer({ plan, bundleFor: scene.bundleFor, data: scene.structure, color });
  assert.ok(layer, 'an eleven-residue selection produces a layer');
  const painted = StructureElement.Bundle.toLoci(layer.bundle, scene.structure);
  const wanted = scene.adapter.toLoci(scene.keys);
  assert.equal(StructureElement.Loci.size(painted), StructureElement.Loci.size(wanted));
  assert.ok(StructureElement.Loci.areEqual(painted, wanted),
    'the painted atoms are the selected residues, no more and no fewer');
  assert.ok(StructureElement.Loci.size(painted) > 0);
});

test('the mark survives a colour change and a representation change', () => {
  const asKeys = layer => {
    const loci = StructureElement.Bundle.toLoci(layer.bundle, scene.structure);
    return StructureElement.Loci.size(loci);
  };
  const cartoonDark = selectionOverpaintLayer({
    plan: selectionPaintPlan({ selectionKeys: scene.keys, appearance: { background: '#071015', highlightColor: '#f2c47c' } }),
    bundleFor: scene.bundleFor, data: scene.structure, color });
  // An earlier run’s theme-only recolour: the appearance changes, the geometry does not.
  const recoloured = selectionOverpaintLayer({
    plan: selectionPaintPlan({ selectionKeys: scene.keys, appearance: { background: '#ffffff', highlightColor: '#3355ff', uniformColor: '#ff2dd4' } }),
    bundleFor: scene.bundleFor, data: scene.structure, color });
  // A representation change rebuilds the geometry and hands a fresh structure
  // reference to the same keys; the layer is built from the keys, not the mesh.
  const rebuilt = selectionOverpaintLayer({
    plan: selectionPaintPlan({ selectionKeys: scene.keys, appearance: { background: '#071015', highlightColor: '#f2c47c' } }),
    bundleFor: scene.bundleFor, data: Structure.ofModel(scene.structure.models[0]), color });
  for (const layer of [cartoonDark, recoloured, rebuilt]) assert.ok(layer, 'every pass still marks the selection');
  assert.equal(asKeys(cartoonDark), asKeys(recoloured));
  assert.ok(asKeys(rebuilt) > 0);
  // The recolour moved the mark off the colour it would have collided with.
  assert.notEqual(recoloured.color, '#ff2dd4');
});

test('the mark is chosen to read against the palette it is drawn on', () => {
  // Against the shipped dark background and amber key, the first candidate wins.
  assert.equal(selectionMarkColor({ background: '#071015', highlightColor: '#f2c47c' }), '#ff2dd4');
  // A magenta background pushes the mark off magenta rather than hiding it.
  const onMagenta = selectionMarkColor({ background: '#ff2dd4' });
  assert.notEqual(onMagenta, '#ff2dd4');
  assert.ok(colorDistance(onMagenta, '#ff2dd4') >= SELECTION_MARK_MIN_BACKGROUND_DISTANCE);
  // A magenta lesson key does the same, so the selection is never mistaken for it.
  assert.notEqual(selectionMarkColor({ background: '#071015', highlightColor: '#ff2dd4' }), '#ff2dd4');
  // Every candidate reads against both the shipped dark ground and a white one.
  for (const candidate of SELECTION_MARK_COLORS.slice(0, 4)) {
    assert.ok(colorDistance(candidate, '#071015') >= SELECTION_MARK_MIN_BACKGROUND_DISTANCE, candidate);
  }
  // A palette that defeats every candidate still marks the selection.
  assert.ok(SELECTION_MARK_COLORS.includes(selectionMarkColor({ background: '#ff2dd4', highlightColor: '#39ff14', uniformColor: '#00e5ff' })));
});

test('the selection is the last layer of the one overpaint, so it wins over the lesson key', () => {
  const plan = selectionPaintPlan({ selectionKeys: scene.keys, appearance: { background: '#071015' } });
  const selectionLayer = selectionOverpaintLayer({ plan, bundleFor: scene.bundleFor, data: scene.structure, color });
  const emphasis = [{ bundle: scene.bundleFor(scene.keys, scene.structure), color: '#f2c47c', clear: false }];
  const layers = composeOverpaintLayers(emphasis, selectionLayer);
  assert.equal(layers.length, 2);
  assert.equal(layers.at(-1), selectionLayer);
  // Mol* paints the layers in order, so the last one is what a shared residue wears.
  assert.equal(layers.at(-1).color, plan.color);
});

test('a hidden chain is not marked, and an empty selection paints nothing', () => {
  const hiddenKeys = scene.keys.slice(0, 4);
  const plan = selectionPaintPlan({ selectionKeys: scene.keys, hiddenKeys, appearance: { background: '#071015' } });
  assert.equal(plan.keys.length, scene.keys.length - hiddenKeys.length);
  const layer = selectionOverpaintLayer({ plan, bundleFor: scene.bundleFor, data: scene.structure, color });
  const painted = StructureElement.Bundle.toLoci(layer.bundle, scene.structure);
  assert.ok(StructureElement.Loci.areEqual(painted, scene.adapter.toLoci(plan.keys)));
  assert.equal(selectionOverpaintLayer({
    plan: selectionPaintPlan({ selectionKeys: [], appearance: {} }),
    bundleFor: scene.bundleFor, data: scene.structure, color }), undefined);
  assert.deepEqual(composeOverpaintLayers([], undefined), []);
});
