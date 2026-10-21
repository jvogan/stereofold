import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { createDrawnSubsetCache } from './visible-stage-bounds.mjs';
import { createInspectionState } from './inspection-state.mjs';
import { pageFunction } from './fixtures/label-action-harness.mjs';
import { composeOverpaintLayers, selectionOverpaintLayer } from './selection-paint.mjs';
import { mergeEmphasisColourLayers, normalizeEmphasisState, planLessonEmphasis } from './lesson-emphasis.mjs';
import { availableChains, describeVisibility, emptyVisibility, hiddenRowKeys, normalizeVisibility,
  resolveVisibility, sameVisibility, visibilityIsEmpty } from './inspection-visibility.mjs';

const viewer = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
/** Values that crossed out of the vm realm, as plain ones this realm can compare. */
const plain = value => JSON.parse(JSON.stringify(value));

/**
 * The viewer's own visibility functions, over a state tree that records what was
 * applied and deleted instead of drawing it.
 *
 * The point of running the real ones is the four consequences of a hide, which
 * no pure module can prove: the transparency layer lands on every representation
 * of the molecule, the selection highlight stops covering hidden atoms, the
 * residue labels are rebuilt without them, and showing again deletes exactly the
 * cells the hide created and nothing else.
 */
function harness() {
  const cells = new Map(), applied = [], deleted = [], marks = [], rebuilds = [], drawn = new Map();
  const row = (labelChain, copyId, componentId, entityType, index) => ({
    key: `${labelChain}:${copyId}:${index}`, entityType, coordinateState: 'resolved', atomSites: [{}],
    identity: { modelNumber: 1, assemblyId: '1', copyId, labelChain, componentId },
  });
  const rows = [row('A', 'one', 'ALA', 'polymer', 1), row('A', 'two', 'ALA', 'polymer', 2),
    row('B', 'one', 'ALA', 'polymer', 3), row('L', 'one', 'HEM', 'non-polymer', 4),
    row('W', 'one', 'HOH', 'water', 5)];
  const builder = () => {
    const pending = [];
    const api = {
      to(ref) { api.target = ref; return api; },
      apply(type, params, { ref }) { pending.push({ type, params, ref, parent: api.target }); return api; },
      delete(ref) { pending.push({ type: 'delete', ref }); return api; },
      async commit() {
        for (const op of pending) {
          if (op.type === 'delete') {
            const old = cells.get(op.ref);
            if (old?.type === 'transparency') drawn.delete(old.parent);
            cells.delete(op.ref); deleted.push(op.ref);
          }
          // Cloned out of the vm realm so the assertions compare plain values.
          else {
            cells.set(op.ref, op); applied.push({ ref: op.ref, parent: op.parent, layers: plain(op.params.layers) });
            if (op.type === 'transparency') drawn.set(op.parent, plain(op.params.layers));
          }
        }
      },
    };
    return api;
  };
  const context = vm.createContext({
    currentSelectionPlan: () => undefined,
    composeOverpaintLayers, selectionOverpaintLayer, mergeEmphasisColourLayers,
    normalizeEmphasisState, planLessonEmphasis, DEFAULT_CONTEXT_OPACITY: 0.35,
    now: () => 0, recordCost() {}, Color: value => value,
    recordEmphasisResolution() {}, recordManipulation() {}, paintedContextOpacity: value => value,
    spokenSelectionKeys: ({ chain }) => rows.filter(row => row.identity.labelChain === chain).map(row => row.key),
    emphasisState: normalizeEmphasisState({}), emphasisOrigin: 'command',
    lessonKey: { remember() {} }, componentLabels: {},
    // The shared module, exactly as the page imports it.
    availableChains, describeVisibility, emptyVisibility, hiddenRowKeys, normalizeVisibility,
    resolveVisibility, sameVisibility, visibilityIsEmpty,
    SCENE_VISIBILITY_LAYER_REF: 'stereofold-scene-visibility',
    EMPHASIS_LAYER_REF: 'stereofold-emphasis',
    visibilityState: emptyVisibility(), stylesState: [], styleLayers: [],
    styleLayerTargets: () => [], currentEmphasisPlan: () => context.currentPlan ?? null,
    volume: null, assertReady() {}, assertContext() {}, dropDeadOverlayRefs() {},
    plugin: { state: { data: { cells } }, build: builder },
    structure: { ref: 'structure', obj: { data: 'structure-data' } },
    representation: { ref: 'representation' },
    // The ligands can be drawn in a second representation, and
    // a hide has to reach that one too or a hidden ligand stays on screen.
    ligandOverlay: { representation: { ref: 'overlay' }, component: { obj: { data: 'overlay-data' } } },
    liveEmphasisTargets: targets => ({ targets, missing: [] }),
    StructureElement: {
      Loci: { remap: (loci, data) => ({ ...loci, data }), isEmpty: loci => loci.keys.length === 0 },
      Bundle: { fromLoci: loci => ({ keys: loci.keys, data: loci.data }) },
    },
    StateTransforms: { Representation: {
      TransparencyStructureRepresentation3DFromBundle: 'transparency',
      OverpaintStructureRepresentation3DFromBundle: 'overpaint',
    } },
    selection: { rows, toLoci: keys => ({ keys: [...keys] }) },
    state: { selectionKeys: [rows[0].key, rows[2].key, rows[4].key] },
    markRecord: (_record, keys) => marks.push(plain([...keys])),
    retainCurrent: () => ({}),
    inspectionState: createInspectionState(), syncInspectionPayload() {},
    inspectionMutation: async operation => context.mutate('inspection', operation),
    mutate: async (_kind, operation) => { await operation(); return { ready: true }; },
    rebuildInspectionLabels: async () => rebuilds.push('labels'),
    rebuildComponentLabels: async () => rebuilds.push('plates'),
    snapshot: () => ({ ready: true }),
  });
  for (const name of ['hiddenSceneKeys', 'hiddenSceneKeySet', 'paintVisibilityLayers', 'paintEmphasisLayers',
    'paintSelectionOverlay', 'emphasize', 'markSelection', 'visibilityChains', 'setSceneVisibility',
    'describeSceneVisibility', 'savedVisibility']) {
    vm.runInContext(pageFunction(viewer, name), context);
  }
  return { context, cells, applied, deleted, marks, rebuilds, rows, drawn };
}

const hide = async (h, patch) => vm.runInContext('setSceneVisibility(resolveVisibility(visibilityState, patch, visibilityChains()))',
  Object.assign(h.context, { patch }));
/** What the panel would save right now. */
const saved = h => plain(vm.runInContext('savedVisibility()', h.context));

test('staged primary masks never delete or alter the retained representation mask', async () => {
  const h = harness();
  await hide(h, { op: 'hide', chains: [{ labelChain: 'B', copyId: 'one' }] });
  const old = h.cells.get('stereofold-scene-visibility');
  h.context.representation = { ref: 'stereofold-transition-next' };
  await h.context.paintVisibilityLayers();
  const currentRef = 'stereofold-scene-visibility-stereofold-transition-next';
  assert.equal(h.cells.get('stereofold-scene-visibility'), old);
  assert.deepEqual(plain(h.cells.get(currentRef).params.layers), plain(old.params.layers));
  h.context.visibilityState = emptyVisibility();
  await h.context.paintVisibilityLayers();
  assert.equal(h.cells.has(currentRef), false);
  assert.equal(h.cells.get('stereofold-scene-visibility'), old, 'rollback still owns its exact original mask');
});

test('hiding a chain paints one full-transparency layer per representation and touches nothing else', async () => {
  const h = harness();
  await hide(h, { op: 'hide', chains: [{ labelChain: 'B', copyId: 'one' }] });
  // Both representations of the molecule, and full transparency rather than a fade.
  assert.deepEqual(h.applied.map(entry => [entry.ref, entry.parent]), [
    ['stereofold-scene-visibility', 'representation'],
    ['stereofold-scene-visibility-ligand', 'overlay'],
  ]);
  for (const entry of h.applied) {
    assert.equal(entry.layers.length, 1);
    assert.equal(entry.layers[0].value, 1);
    assert.deepEqual(entry.layers[0].bundle.keys, ['B:one:3']);
  }
  // The representation itself is never deleted or rebuilt, only layered.
  assert.deepEqual(h.deleted, []);
  assert.equal(h.cells.has('representation'), false);
  // The saved selection keeps every key the wearer picked; the marker pass does not.
  assert.deepEqual(plain(h.context.state.selectionKeys), ['A:one:1', 'B:one:3', 'W:one:5']);
  assert.deepEqual(h.marks.at(-1), ['A:one:1', 'W:one:5']);
  // The residue labels and the name plates are rebuilt inside the same change.
  assert.deepEqual(h.rebuilds, ['labels', 'plates']);
  assert.equal(vm.runInContext('describeSceneVisibility()', h.context), 'Hidden chain B.');
});

test('showing again deletes exactly the layers the hide created, and restores the highlight', async () => {
  const h = harness();
  await hide(h, { op: 'hide', chains: [{ labelChain: 'B', copyId: 'one' }] });
  h.applied.length = 0; h.deleted.length = 0;
  await hide(h, { op: 'show', chains: [{ labelChain: 'B', copyId: 'one' }] });
  assert.deepEqual(plain(h.deleted), ['stereofold-scene-visibility', 'stereofold-scene-visibility-ligand']);
  assert.deepEqual(h.applied, []);
  assert.equal(h.cells.size, 0);
  // Exactly what was there before the hide, including the hidden row's highlight.
  assert.deepEqual(h.marks.at(-1), ['A:one:1', 'B:one:3', 'W:one:5']);
  assert.deepEqual(saved(h), {});
});

test('a class hide, a show-only and a reset are the same one state', async () => {
  const h = harness();
  await hide(h, { op: 'hide', classes: ['water'] });
  assert.deepEqual(h.applied.at(-1).layers[0].bundle.keys, ['W:one:5']);
  assert.deepEqual(saved(h), { visibility: { hiddenChains: [], hiddenClasses: ['water'], showOnlySelection: false } });

  await hide(h, { op: 'only', classes: ['ligand'] });
  // Everything but the ligand, which is the water AND both polymer chains.
  assert.deepEqual(h.applied.at(-1).layers[0].bundle.keys, ['A:one:1', 'A:two:2', 'B:one:3', 'W:one:5']);
  assert.equal(vm.runInContext('describeSceneVisibility()', h.context),
    'Hidden the water, the ions and the polymer.');

  await hide(h, { op: 'reset' });
  assert.equal(h.cells.size, 0);
  assert.deepEqual(saved(h), {});
  assert.deepEqual(h.marks.at(-1), ['A:one:1', 'B:one:3', 'W:one:5']);
});

test('showing only the selection hides every row the wearer did not pick', async () => {
  const h = harness();
  await hide(h, { op: 'only', selection: true });
  assert.deepEqual(h.applied.at(-1).layers[0].bundle.keys, ['A:two:2', 'L:one:4']);
  assert.deepEqual(h.marks.at(-1), ['A:one:1', 'B:one:3', 'W:one:5']);
  await hide(h, { op: 'show', selection: true });
  assert.equal(h.cells.size, 0);
});

test('a chain this structure does not have is refused, and nothing is painted', async () => {
  const h = harness();
  await assert.rejects(() => hide(h, { op: 'hide', chains: [{ labelChain: 'B', copyId: 'nine' }] }),
    /no chain B with copy id nine/);
  assert.deepEqual(h.applied, []);
  assert.deepEqual(saved(h), {});
});

test('a paint that fails leaves the panel describing the picture on screen', async () => {
  const h = harness();
  h.context.mutate = async () => { throw Error('context lost'); };
  await assert.rejects(() => hide(h, { op: 'hide', classes: ['water'] }), /context lost/);
  assert.deepEqual(saved(h), {});
  assert.equal(vm.runInContext('describeSceneVisibility()', h.context), 'Everything is showing.');
});

test('a density panel refuses to hide part of a mesh that has no parts', async () => {
  const h = harness();
  h.context.volume = { ref: 'volume' };
  await assert.rejects(() => hide(h, { op: 'hide', classes: ['water'] }),
    /density map[\s\S]*no chains or components/);
});

test('an unselected reveal preserves colour cells while updating masks, fades and labels', async () => {
  const h = harness();
  h.context.state.selectionKeys = [];
  h.context.currentPlan = { colours: [{ color: '#112233', keys: ['A:one:1'] }],
    faded: ['A:two:2', 'B:one:3'], lit: ['A:one:1'], transparency: 0.65 };
  await h.context.paintSelectionOverlay();
  const colour = h.cells.get('stereofold-emphasis-colour');
  const ligandColour = h.cells.get('stereofold-emphasis-ligand-colour');
  assert.ok(colour && ligandColour);
  h.applied.length = 0; h.deleted.length = 0;

  await hide(h, { op: 'hide', chains: [{ labelChain: 'B', copyId: 'one' }] });
  for (const target of ['representation', 'overlay']) {
    const layers = h.drawn.get(target);
    assert.equal(layers[0].value, 0.65, 'context keeps its authored fade');
    assert.deepEqual(layers.at(-1).bundle.keys, ['B:one:3']);
    assert.equal(layers.at(-1).value, 1);
  }
  await hide(h, { op: 'reset' });
  assert.equal(h.cells.get('stereofold-emphasis-colour'), colour);
  assert.equal(h.cells.get('stereofold-emphasis-ligand-colour'), ligandColour);
  assert.ok(h.deleted.every(ref => !ref.includes('emphasis')));
  assert.ok(h.applied.every(entry => entry.ref.includes('visibility')));
  assert.deepEqual(h.rebuilds, ['labels', 'plates', 'labels', 'plates']);
  assert.deepEqual(h.marks, [[], []]);
  assert.deepEqual(saved(h), {});
  assert.equal(h.drawn.get('representation').length, 1, 'reset removes the hidden mask but keeps the fade');
});

test('a visibility change still repaints selected residues and restores them on show', async () => {
  const h = harness();
  h.context.state.selectionKeys = ['B:one:3'];
  h.context.currentSelectionPlan = () => ({ keys: h.context.state.selectionKeys.filter(key =>
    !h.context.hiddenSceneKeySet().has(key)), color: '#ff2dd4' });
  await h.context.paintSelectionOverlay();
  assert.ok(h.cells.get('stereofold-emphasis-colour'));
  h.deleted.length = 0;
  await hide(h, { op: 'hide', chains: [{ labelChain: 'B', copyId: 'one' }] });
  assert.ok(h.deleted.includes('stereofold-emphasis-colour'));
  assert.equal(h.cells.has('stereofold-emphasis-colour'), false, 'hidden selection loses its colour overlay');
  await hide(h, { op: 'reset' });
  assert.deepEqual(h.cells.get('stereofold-emphasis-colour').params.layers[0].bundle.keys, ['B:one:3']);
});

test('a failed unselected mask update restores saved visibility without repainting colour', async () => {
  const h = harness();
  h.context.state.selectionKeys = [];
  let colourPaints = 0;
  h.context.paintSelectionOverlay = async () => { colourPaints++; };
  h.context.paintVisibilityLayers = async () => { throw Error('mask failed'); };
  await assert.rejects(() => hide(h, { op: 'hide', classes: ['water'] }), /mask failed/);
  assert.equal(colourPaints, 0);
  assert.deepEqual(saved(h), {});
  assert.deepEqual(h.rebuilds, []);
});

test('an appearance rebuild repaints the hidden set rather than bringing it back', () => {
  // The rebuild drops every layer hanging off the representation, so the hidden
  // set has to be repainted there exactly as the emphasis is, and after it.
  //
  // The selection is repainted in the same window, between the two,
  // because it rides inside the emphasis overpaint and a rebuild drops it too.
  assert.match(viewer, /if \(emphasis && keptEmphasis\) await paintEmphasisLayers\(keptEmphasis, \{ transparency: false, recovering \}\);[\s\S]{0,900}await paintVisibilityLayers\(undefined, \{ recovering \}\);/);
  const rebuild = viewer.slice(viewer.indexOf('if (emphasis && keptEmphasis) await paintEmphasisLayers(keptEmphasis,'));
  const selectionPaint = rebuild.indexOf('await paintEmphasisLayers({ colours: [], faded: [], lit: [], transparency: 0 }, { transparency: false, recovering })');
  const visibilityPaint = rebuild.indexOf('await paintVisibilityLayers(undefined, { recovering });');
  assert.ok(selectionPaint >= 0 && visibilityPaint >= 0, 'both paints retain the recovery context');
  assert.ok(selectionPaint < visibilityPaint, 'the selection is repainted before the hidden set');
});

test('hide and later selection or emphasis repaint keep hidden copies fully transparent', async () => {
  const h = harness();
  h.context.currentPlan = { colours: [], faded: ['A:two:2', 'B:one:3'], lit: ['A:one:1'], transparency: 0.65 };
  const hiddenAtDraw = () => {
    for (const target of ['representation', 'overlay']) {
      const layers = h.drawn.get(target);
      assert.equal(layers.at(-1).value, 1);
      assert.deepEqual(layers.at(-1).bundle.keys, ['B:one:3']);
      assert.equal(layers[0].value, 0.65, 'visible context retains its authored fade');
    }
  };
  await hide(h, { op: 'hide', chains: [{ labelChain: 'B', copyId: 'one' }] });
  hiddenAtDraw();
  assert.equal(h.applied.filter(entry => entry.ref.startsWith('stereofold-scene-visibility')).length, 2,
    'the hide paints one composed transparency state per target');
  h.context.state.selectionKeys = ['A:two:2'];
  await h.context.paintSelectionOverlay();
  hiddenAtDraw();
  await h.context.emphasize({ parts: [{ id: 'alpha', label: 'Alpha', chain: 'A', color: '#112233' }],
    focus: 'alpha', contextOpacity: 0.35 });
  hiddenAtDraw();
  h.context.representation = { ref: 'stereofold-transition-next' };
  await h.context.paintSelectionOverlay();
  assert.equal(h.drawn.get('stereofold-transition-next').at(-1).value, 1,
    'new geometry receives the same final hidden mask');
});

function pivotHarness() {
  const h = harness(), c = h.context;
  h.rows.forEach((row, i) => { row.atomSites = [{ assemblyCoordinatesAngstrom: [i * 10, 0, 0] }]; });
  Object.assign(c, { Vec3, cachedDrawnSubset: createDrawnSubsetCache(), visibleStage: undefined,
    staticMaskKeys: () => [], molecularAnimation: { snapshot: () => null }, pivotCenter: () => [20, 0, 0],
    VISIBILITY_LAYER_REF: { water: 'stereofold-hidden-water', ligand: 'stereofold-hidden-ligand' },
    removeLigandOverlay: async () => {},
  });
  c.representation.obj = { data: { repr: { props: { alpha: 1 } } } };
  for (const name of ['setGroupVisible', 'visibilityGroupOf', 'drawnCenter'])
    vm.runInContext(pageFunction(viewer, name), c);
  return h;
}

test('voice group hiding updates saved visibility and the lesson pivot', async () => {
  const h = pivotHarness(), c = h.context;
  assert.deepEqual(plain(c.drawnCenter()), [20, 0, 0]);
  await c.setGroupVisible('water', false);
  assert.deepEqual(plain(c.drawnCenter()), [15, 0, 0]);
  assert.deepEqual(saved(h).visibility.hiddenClasses, ['water']);
  await c.setGroupVisible('ligand', false);
  assert.deepEqual(plain(c.drawnCenter()), [10, 0, 0]);
  await assert.rejects(c.setGroupVisible('ligand', false), /already hidden/);
  await c.setGroupVisible('water', true);
  assert.deepEqual(plain(c.drawnCenter()), [20, 0, 0]);
  await c.setGroupVisible('ligand', true);
  assert.deepEqual(saved(h), {});
});

test('zero opacity styles and base opacity invalidate the pivot without rebuilding during ticks', () => {
  const h = pivotHarness(), c = h.context;
  let reads = 0;
  h.rows.forEach((row, i) => { row.atomSites = [{ get assemblyCoordinatesAngstrom() { reads++; return [i * 10, 0, 0]; } }]; });
  const keys = h.rows.slice(3).map(row => row.key);
  c.stylesState = [{ selectionKeys: keys, opacity: 0 }];
  assert.deepEqual(plain(c.drawnCenter()), [10, 0, 0]);
  const measured = reads;
  for (let tick = 0; tick < 360; tick++) c.drawnCenter();
  assert.equal(reads, measured, 'steady turns reuse measured coordinates');
  assert.equal(h.applied.length, 0, 'turning never rebuilds geometry or paints layers');
  c.stylesState = [{ selectionKeys: keys, opacity: .2 }];
  assert.deepEqual(plain(c.drawnCenter()), [20, 0, 0]);
  c.representation.obj.data.repr.props.alpha = 0;
  assert.deepEqual(plain(c.drawnCenter()), [35, 0, 0], 'explicit style opacity survives a transparent base');
  c.stylesState = [{ selectionKeys: keys, color: 'chain-id' }];
  assert.deepEqual(plain(c.drawnCenter()), [20, 0, 0], 'fully invisible scenes use the finite fallback');
  c.stylesState = [{ selectionKeys: keys, opacity: 0 }, { selectionKeys: [keys[1]], opacity: .5 }];
  assert.deepEqual(plain(c.drawnCenter()), [40, 0, 0], 'any visible overlapping layer counts');
  c.stylesState = [];
  c.representation.obj.data.repr.props.alpha = 1;
  assert.deepEqual(plain(c.drawnCenter()), [20, 0, 0]);
});
