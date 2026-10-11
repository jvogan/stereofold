import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { measureComponentLabels, renderedSubjectPoints } from './component-label-measurement.mjs';
import { measureEntryStandoff, prepareEntryStandoff } from './entry-standoff.mjs';
import { entryMenuSeat } from './entry-menu-seat.mjs';
import { SPATIAL_TOOLBAR_LAYOUT } from './spatial-toolbar-geometry.mjs';
import { createSelectionBoundsCache } from './selection-bounds.mjs';
import { screenRectFromPoints } from './label-layout.mjs';
import { tangentRectsForPoints } from './journey-seat-record.mjs';
import { identity, syntheticViews } from './fixtures/component-label-diagnostics.mjs';
const require = createRequire(new URL('../../plugin/package.json', import.meta.url));
const { Loci } = require('molstar/lib/commonjs/mol-model/structure/structure/element/loci.js');
const views = syntheticViews();
const cell = value => ({ ref: { value } });
const points = Array.from({ length: 150000 }, (_, i) => [i % 2 ? .2 : -.2, i % 3 ? .3 : -.3, -1]);
const mesh = points => ({ type: 'mesh', state: { visible: true }, values: {
  aPosition: cell(Float32Array.from(points.flat())), aTransform: cell(identity()),
  drawCount: cell(points.length), instanceCount: cell(1),
} });

test('150000 subject points measure exactly like their repeated finite support', () => {
  assert.deepEqual(measureComponentLabels({ views, subject: { points } }),
    measureComponentLabels({ views, subject: { points: points.slice(0, 6) } }));
});

test('20 x 7500 vertices all survive production sampling and measure', () => {
  const objects = Array.from({ length: 20 }, (_, i) => mesh(points.slice(i * 7500, (i + 1) * 7500)));
  const sample = objects.flatMap(object => renderedSubjectPoints(object, 1));
  assert.equal(sample.length, 150000);
  assert.deepEqual(measureComponentLabels({ views, subject: { points: sample } }),
    measureComponentLabels({ views, subject: { points: sample.slice(0, 6) } }));
});

test('150000 points produce the same screen rect as their finite support', () => {
  const options = { eye: [0, 0, 0], target: [0, 0, -1] };
  assert.deepEqual(screenRectFromPoints({ ...options, points }),
    screenRectFromPoints({ ...options, points: points.slice(0, 6) }));
});

test('150000 points produce the same tangent rects as their finite support', () => {
  const actual = tangentRectsForPoints({ views, renderFromRoom: identity(), points });
  const reference = tangentRectsForPoints({ views, renderFromRoom: identity(), points: points.slice(0, 6) });
  assert.deepEqual(actual.map(({ points: count, ...rect }) => rect),
    reference.map(({ points: count, ...rect }) => rect));
  assert.deepEqual(actual.map(rect => rect.points), [150000, 150000]);
});

test('entry standoff returns undefined without stereo geometry', () => {
  assert.equal(measureEntryStandoff(), undefined);
  assert.equal(measureEntryStandoff({}), undefined);
  assert.equal(measureEntryStandoff({ menuPoints: [[0, 0, -1]] }), undefined);
});

// Exercise the production adapter closure with a counted 150k-position index.
// Identity/source validation is covered by selection.test with parsed mmCIF.
function indexedSelection(n = 150000, shift = 0) {
  let reads = 0, coordinateReads = 0;
  const unit = { id: 1, elements: Int32Array.from({ length: n * 2 }, (_, i) => i), conformation: {
    position(i, out) { coordinateReads++; out[0] = Math.sin(i) + shift; out[1] = Math.cos(i); out[2] = i % 19; return out; }, r: () => 0,
  } };
  const structure = { units: [unit], elementCount: n * 2 };
  const positions = new Map(['a', 'b'].map((key, j) => [key, Array.from({ length: n }, (_, i) => ({
    unit, get localIndex() { reads++; return ((i * 7919) % n) * 2 + j; },
  }))]));
  const source = readFileSync(new URL('./selection.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('  const lociCache ='), end = source.indexOf('\n  function fromLoci', start);
  const toLoci = new Function('selectionKeys', 'byKey', 'positions', 'structure',
    source.slice(start, end) + '; return toLoci;')(keys => [...new Set(keys)], new Map(), positions, structure);
  return { toLoci, structure, reads: () => reads, coordinateReads: () => coordinateReads };
}

test('cached snapshot loci match fresh indices and never reread selected positions', () => {
  const selection = indexedSelection(), keys = ['a'];
  const first = selection.toLoci(keys), reads = selection.reads();
  const snapshot = () => ({ selectionLociElementCount: Loci.size(selection.toLoci(keys)) });
  for (let i = 0; i < 20; i++) assert.deepEqual(snapshot(), { selectionLociElementCount: 150000 });
  assert.equal(selection.reads(), reads);
  assert.deepEqual([...first.elements[0].indices], [...indexedSelection().toLoci(['a']).elements[0].indices]);
  keys[0] = 'b';
  const changed = selection.toLoci(keys);
  assert.notEqual(first, changed);
  assert.equal(selection.reads(), reads * 2);
  assert.deepEqual([...changed.elements[0].indices], [...indexedSelection().toLoci(['b']).elements[0].indices]);
  const other = indexedSelection();
  assert.notEqual(other.toLoci(keys).structure, changed.structure);
});

test('the 33rd loci key set evicts the least recently used and hits promote', () => {
  const selection = indexedSelection(1);
  const first = selection.toLoci(['a']);
  const second = selection.toLoci(['b']);
  for (let i = 0; i < 30; i++) selection.toLoci([`part-${i}`]);
  assert.equal(selection.toLoci(['a']), first, 'a hit promotes the oldest entry');
  selection.toLoci(['part-30']);
  assert.equal(selection.toLoci(['a']), first);
  assert.notEqual(selection.toLoci(['b']), second, 'the other old entry was evicted');
});

test('bounds equal fresh Mol* bounds and reread atoms only for changed selection or structure', () => {
  const selection = indexedSelection(3000), bounds = createSelectionBoundsCache(Loci.getBoundingSphere);
  const first = selection.toLoci(['a']), expected = Loci.getBoundingSphere(first);
  assert.deepEqual(bounds(first), expected);
  const reads = selection.coordinateReads();
  for (let i = 0; i < 10; i++) assert.deepEqual(bounds(selection.toLoci(['a'])), expected);
  assert.equal(selection.coordinateReads(), reads, 'placement/menu commits must not rescan atoms');
  const changed = selection.toLoci(['b']);
  const next = bounds(changed);
  assert.ok(selection.coordinateReads() > reads);
  assert.deepEqual(next, Loci.getBoundingSphere(changed));
  const other = indexedSelection(3000, 100), otherLoci = other.toLoci(['a']);
  const replaced = bounds(otherLoci);
  assert.ok(other.coordinateReads() > 0);
  assert.deepEqual(replaced, Loci.getBoundingSphere(otherLoci));
  assert.notDeepEqual(replaced, expected);
});

test('seven rungs and folded grids reuse one extraction and projection, matching fresh measurements', () => {
  let reads = 0, projections = 0;
  const object = mesh(points.slice(0, 7500));
  const positions = object.values.aPosition.ref.value;
  Object.defineProperty(object.values.aPosition.ref, 'value', { get() { reads++; return positions; } });
  const measuredViews = views.map(view => ({ ...view, transform: { ...view.transform, inverse: {
    get matrix() { projections++; return view.transform.inverse.matrix; },
  } } }));
  const geometry = { objects: [object], views: measuredViews, cameraScale: 1, renderFromRoom: identity() };
  const rows = Array.from({ length: 15 }, (_, i) => ({ label: `Control ${i}`, action: { index: i } }));
  const input = { rows, head: { position: { x: 0, y: 0, z: 0 }, matrix: identity() },
    constants: SPATIAL_TOOLBAR_LAYOUT, geometry, clearance: 10 };
  const fresh = entryMenuSeat({ ...input, measureStandoff: menuPoints => measureEntryStandoff({ ...geometry, menuPoints }) });
  reads = 0; projections = 0;
  assert.deepEqual(entryMenuSeat(input), fresh);
  assert.equal(reads, 1, 'one extraction for seven rungs');
  // One subject projection and seven menu projections, in each of two eyes.
  assert.equal(projections, 16);
  const measureStandoff = prepareEntryStandoff(geometry);
  reads = 0;
  for (const maxRows of [5, 8, 15]) {
    const options = { ...input, constants: { ...SPATIAL_TOOLBAR_LAYOUT, maxRows } };
    const actual = entryMenuSeat({ ...options, measureStandoff });
    const retainedReads = reads;
    assert.deepEqual(actual, entryMenuSeat({ ...options, measureStandoff: menuPoints => measureEntryStandoff({ ...geometry, menuPoints }) }));
    reads = retainedReads;
  }
  assert.equal(reads, 1, 'fold candidates share the same solve-local sample');
  object.values.aTransform.ref.value[12] = .1;
  const updated = entryMenuSeat(input);
  assert.notDeepEqual(updated.measured, fresh.measured, 'a new solve reads current transforms');
});
