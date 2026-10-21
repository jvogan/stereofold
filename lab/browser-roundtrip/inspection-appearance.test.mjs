import test, { before } from 'node:test';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { MarkerAction } = require('molstar/lib/commonjs/mol-util/marker-action.js');
import assert from 'node:assert/strict';
import { CHAIN_COLOR_PARAMS, xrBallAndStickParams, colorOnlyAppearanceChange } from './inspection-appearance.mjs';
import { normalizeAppearance } from './inspection-state.mjs';
import { xrColorParams } from './xr-render-budget.mjs';
import { GEOMETRY_LEVELS, requireGeometryBudget, geometryBudgetReceipt, estimateRepresentation } from './representation-budget.mjs';
import { loadAppearanceStructure, themePlugin, themes, createStructureRepresentationParams,
  StructureElement, StructureProperties, Bond, appearanceRenderHarness } from './appearance-render-harness.mjs';
import { viewerSource } from './render-dedupe-harness.mjs';
import { emptyLessonFigureBinding } from './fixtures/empty-lesson-figure.mjs';
import { residueRunPlate } from './residue-label-plates.mjs';

let structure;
before(async () => { structure = await loadAppearanceStructure(); });

function chainColors(data, params) {
  const theme = themes.colorThemeRegistry.create('chain-id', { structure: data }, params);
  const result = new Map();
  for (const unit of data.units) {
    const location = StructureElement.Location.create(data, unit, unit.elements[0]);
    const chain = StructureProperties.chain.auth_asym_id(location);
    const color = theme.color(location);
    if (result.has(chain)) assert.equal(result.get(chain), color, 'one author chain retains its colour through ligand/water units');
    result.set(chain, color);
    const bond = Bond.Location(data, unit, 0, data, unit, Math.min(1, unit.elements.length - 1));
    assert.equal(theme.color(bond), color, 'bond endpoint and atom use the same chain table');
  }
  return result;
}

test('4HHB chain atom and bond colours are identical across all four representations and XR edges', () => {
  const expected = new Map([['A', 0xd95f02], ['B', 0xe7298a], ['C', 0x1b9e77], ['D', 0x7570b3]]);
  for (const representation of ['cartoon', 'ball-and-stick', 'molecular-surface', 'spacefill']) {
    for (const presenting of [false, true]) {
      for (const search of ['', '?xrRenderBudget=off', '?xrRenderBudget=palette:off']) {
        const colorParams = xrColorParams({ representation, presenting, color: 'chain-id', scope: { location: { search } } });
        const params = createStructureRepresentationParams(themePlugin, structure, { type: representation, color: 'chain-id', colorParams });
        assert.deepEqual(chainColors(structure, params.colorTheme.params), expected);
        // A selected component starts at chain D: its palette must still start
        // from the source root, not recolour D as the first chain, orange.
        const unit = structure.units.find(u => StructureProperties.chain.auth_asym_id(
          StructureElement.Location.create(structure, u, u.elements[0])) === 'D');
        const component = { root: structure, models: structure.models, units: [unit] };
        assert.deepEqual(chainColors(component, params.colorTheme.params), new Map([['D', expected.get('D')]]));
      }
    }
  }
  assert.equal(CHAIN_COLOR_PARAMS.palette.params.list.kind, 'set', 'never interpolate chain hues by subset size');
});

test('XR stick radius atom-count and admitted-detail boundaries preserve mesh counts', () => {
  const cases = [[0,.28],[2000,.28],[2001,.24],[8000,.24],[8001,.20],[25000,.20],[25001,.18]];
  for (const [atoms, factor] of cases) for (const level of GEOMETRY_LEVELS) {
    const p = xrBallAndStickParams({ representation: 'ball-and-stick', presenting: true, atoms, level });
    assert.equal(p.sizeFactor, Math.min(factor, level === 'lowest' ? .24 : level === 'lower' ? .26 : .28));
    assert.equal(p.sizeAspectRatio, .75);
    assert.deepEqual(Object.keys(p).sort(), ['sizeAspectRatio', 'sizeFactor']);
    const input = { representation: 'ball-and-stick', atoms, level };
    assert.deepEqual(estimateRepresentation({ ...input, ...p }), estimateRepresentation(input));
  }
  for (const representation of ['cartoon', 'spacefill', 'molecular-surface'])
    assert.deepEqual(xrBallAndStickParams({ representation, presenting: true, atoms: 4400 }), {});
  assert.deepEqual(xrBallAndStickParams({ representation: 'ball-and-stick', atoms: 4400 }), {});
  for (const atoms of [-1, NaN, Infinity, 1.1])
    assert.throws(() => xrBallAndStickParams({ representation: 'ball-and-stick', presenting: true, atoms }), /invalid atom count/);
});

test('explicit budget:draw keeps the historical 4HHB lowest-detail measurement settings', () => {
  const input = { representation: 'ball-and-stick', atoms: 4400, residues: 801, presenting: true, deviceClass: 'quest2', quality: 'low', standalone: true, overBudget: 'draw' };
  const geometry = requireGeometryBudget(input), receipt = geometryBudgetReceipt(geometry);
  const params = { ...geometry.typeParams, ...xrBallAndStickParams({ ...input, level: geometry.level }) };
  assert.equal(geometry.level, 'lowest'); assert.equal(geometry.estimatedVertices, 242880);
  assert.equal(params.detail, 0); assert.equal(params.radialSegments, 2); assert.equal(params.tryUseImpostor, false);
  assert.equal(params.sizeFactor, .24); assert.equal(params.sizeAspectRatio, .75);
  assert.equal(receipt.message, 'Showing sticks at reduced detail under the current geometry policy.');
  const large = requireGeometryBudget({ ...input, atoms: 40908 });
  assert.equal(large.level, 'lowest'); assert.equal(large.typeParams.tryUseImpostor, false);
  assert.ok(large.estimatedVertices > large.budget);
});

test('theme-only admission excludes every other appearance field', () => {
  const base = normalizeAppearance({});
  assert.equal(colorOnlyAppearanceChange(base, normalizeAppearance({ color: 'element-symbol' }, base)), true);
  assert.equal(colorOnlyAppearanceChange(base, base), false);
  for (const patch of [{ opacity:.5 }, { labels:true }, { fog:10 }, { clipping:20 }, { representation:'spacefill' },
    { background:'#ffffff' }, { highlightColor:'#123456' }])
    assert.equal(colorOnlyAppearanceChange(base, normalizeAppearance({ color:'element-symbol', ...patch }, base)), false);
});

test('colour-only update retains real Mol* mesh objects, size, markers, labels and layers, and awaits a frame', async () => {
  const h = await appearanceRenderHarness(undefined, { data: structure });
  try {
    const params = h.cells.get(h.context.representation.ref).params.values;
    const objects = [...h.repr.renderObjects], geometry = h.repr.geometryVersion, labels = h.labels();
    const loci = StructureElement.Loci.all(structure);
    h.repr.mark(loci, MarkerAction.Select);
    h.repr.setState({ overpaint: { kind:'element-loci', layers:[{ loci, color:0xabc123, clear:false }] },
      transparency: { kind:'element-loci', layers:[{ loci, value:.6 }] } });
    const painted = objects.map(o => ({ overpaint:Array.from(o.values.tOverpaint.ref.value.array),
      transparency:Array.from(o.values.tTransparency.ref.value.array) }));
    assert.ok(painted.some(p => p.transparency.some(value => value > 0)));
    const oldColors = objects.map(o => o.values.tColor?.ref.version);
    const markers = objects.map(o => o.values.tMarker?.ref.value);
    const savedLayer = { obj: {}, status: 'ok', params: { values: { sentinel: 'hidden and overpainted' } } };
    h.cells.set('saved-transparency', savedLayer);
    const undo = h.snapshot().inspection.history.undoCount;
    let release;
    h.gateFrame(new Promise(resolve => { release = resolve; }));
    const pending = h.configureInspection({ color: 'element-symbol' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.counts.publications, 0);
    assert.equal(h.context.busy, true);
    release(); await pending;
    const after = h.cells.get(h.context.representation.ref).params.values;
    assert.equal(after.type, params.type); assert.equal(after.sizeTheme, params.sizeTheme);
    assert.equal(after.colorTheme.name, 'element-symbol');
    assert.deepEqual(h.repr.renderObjects, objects); assert.equal(h.repr.geometryVersion, geometry);
    assert.ok(objects.some((o, i) => o.values.tColor?.ref.version > oldColors[i]), 'actual Mol* colour buffer changed');
    objects.forEach((o, i) => assert.equal(o.values.tMarker?.ref.value, markers[i]));
    assert.deepEqual(objects.map(o => ({ overpaint:Array.from(o.values.tOverpaint.ref.value.array),
      transparency:Array.from(o.values.tTransparency.ref.value.array) })), painted);
    assert.equal(h.labels(), labels); assert.equal(h.cells.get('saved-transparency'), savedLayer);
    assert.deepEqual(h.work, { themeUpdates:1, fullAppearance:0, representationUpdates:1, companionPaints:0,
      styleRebuilds:0, ligandRebuilds:0, visibilityPaints:0, cameraWrites:0 });
    assert.equal(h.counts.marks, 0); assert.equal(h.counts.residueLabels, 0); assert.equal(h.counts.componentLabels, 0);
    assert.equal(h.counts.frames, 1); assert.equal(h.counts.publications, 1);
    assert.equal(h.snapshot().inspection.history.undoCount, undo + 1);
    assert.equal(h.context.inspectionState.undo().appearance.color, 'chain-id');
  } finally { h.dispose(); }
});

test('uniform colour uses a theme update; lost layers and label/depth edits retain full repair', async () => {
  const h = await appearanceRenderHarness(undefined, { data: structure });
  try {
    await h.configureInspection({ color:'uniform', uniformColor:'#123456' });
    assert.equal(h.cells.get(h.context.representation.ref).params.values.colorTheme.params.value, 0x123456);
    h.cells.delete('label-repr');
    await h.configureInspection({ color:'element-symbol' });
    assert.equal(h.work.fullAppearance, 1);
    await h.configureInspection({ color:'chain-id', fog:10 });
    await h.configureInspection({ color:'uniform', componentLabels:false });
    assert.equal(h.work.fullAppearance, 3); assert.equal(h.work.themeUpdates, 1);
  } finally { h.dispose(); }
});

test('colour failure never publishes or commits history; busy and drag refusals remain in admission', async () => {
  const h = await appearanceRenderHarness(undefined, { data: structure });
  try {
    const before = h.snapshot().inspection;
    h.context.busy = true;
    await assert.rejects(h.configureInspection({ color:'element-symbol' }), /viewer_busy/);
    h.context.busy = false; h.context.interactionActive = () => true;
    await assert.rejects(h.configureInspection({ color:'element-symbol' }), /Release the molecular drag/);
    h.context.interactionActive = () => false; h.failFrame();
    await assert.rejects(h.configureInspection({ color:'element-symbol' }), /frame_failed/);
    assert.equal(h.counts.publications, 0);
    assert.deepEqual(h.snapshot().inspection, before);
    // The checkpoint drew again, so the next command is admitted.
    assert.equal(h.state.status, 'ready'); assert.equal(h.state.error, null);
  } finally { h.dispose(); }
});

test('inherited scoped and ligand colours update while explicit scoped colours and companion state survive', async () => {
  const h = await appearanceRenderHarness(undefined, { data: structure });
  try {
    const c = h.context, base = h.cells.get(c.representation.ref).params.values;
    const layer = ref => {
      h.cells.set(ref, { obj:{}, status:'ok', params:{ values:{ ...base } } });
      return { representation:{ref}, component:{obj:{data:structure}} };
    };
    c.ligandOverlay = layer('ligands');
    c.styleLayers = [layer('inherited'), layer('explicit')]; c.stylesState = [{}, {}];
    // Production scoped styles also mask their base geometry through the
    // composed transparency cell. Without that cell this fixture describes a
    // torn scene, which correctly takes full repair instead of a theme update.
    const mask = { obj: {}, status: 'ok', state: {}, transform: {} };
    h.cells.set(c.SCENE_VISIBILITY_LAYER_REF, mask);
    c.styleLayerDefinitions = () => [{ look:c.inspectionSnapshot().appearance },
      { look:normalizeAppearance({ color:'uniform', uniformColor:'#abcdef' }, c.inspectionSnapshot().appearance) }];
    await h.configureInspection({ color:'element-symbol' });
    for (const ref of ['inherited','ligands']) assert.equal(h.cells.get(ref).params.values.colorTheme.name, 'element-symbol');
    assert.equal(h.cells.get('explicit').params.values.colorTheme.params.value, 0xabcdef);
    assert.equal(h.work.themeUpdates, 1); assert.equal(h.work.fullAppearance, 0);
    assert.equal(h.cells.get(c.SCENE_VISIBILITY_LAYER_REF), mask, 'theme changes retain the composed style mask');
    assert.equal(h.work.companionPaints, 0); assert.equal(h.work.styleRebuilds, 0);
  } finally { h.dispose(); }
});

test('failed theme transaction retains the appearance checkpoint and emits no acknowledgement', async () => {
  const h = await appearanceRenderHarness(undefined, { data: structure });
  try {
    const before = h.snapshot().inspection;
    h.context.plugin.state.data.build = () => ({ to: () => ({ update() {} }),
      async commit(options) { assert.equal(options.revertOnError, true); throw Error('theme_commit_failed'); } });
    await assert.rejects(h.configureInspection({ color:'element-symbol' }), /theme_commit_failed/);
    // The one frame is the recovery draw of the checkpoint, not a receipt.
    assert.equal(h.counts.publications, 0); assert.equal(h.counts.frames, 1);
    assert.deepEqual(h.snapshot().inspection, before);
    assert.equal(h.state.status, 'ready');
  } finally { h.dispose(); }
});

const labelFailure = () => Object.assign(Error('The object is in an invalid state.'), { name: 'InvalidStateError' });
// Residue labels fail while the command asks for them, as WebKit's
// getViewport did, and build normally once the checkpoint turns them off.
async function labelsOffHarness() {
  const h = await appearanceRenderHarness(undefined, { data: structure });
  await h.configureInspection({ labels: false });
  const rebuild = h.context.rebuildInspectionLabels;
  h.context.rebuildInspectionLabels = async () => {
    if (h.context.inspectionState.snapshot().appearance.labels) throw labelFailure();
    return rebuild();
  };
  h.resetCounts();
  return h;
}

test('a failed label change rejects, draws the checkpoint again and admits the next command', async () => {
  const h = await labelsOffHarness();
  try {
    const before = h.snapshot().inspection, full = h.work.fullAppearance;
    await assert.rejects(h.configureInspection({ labels: true }), error => error.name === 'InvalidStateError');
    assert.equal(h.state.status, 'ready'); assert.equal(h.state.error, null); assert.equal(h.context.busy, false);
    assert.deepEqual(h.snapshot().inspection, before);
    assert.deepEqual(h.labels(), []);
    // The failed build and the checkpoint redraw; one frame, for the redraw.
    assert.equal(h.work.fullAppearance, full + 2); assert.equal(h.counts.frames, 1);
    assert.equal(h.counts.publications, 0);
    await h.configureInspection({ color: 'element-symbol' });
    assert.equal(h.counts.publications, 1);
  } finally { h.dispose(); }
});

test('a failed recovery draw keeps the error and still rejects with the original failure', async () => {
  const h = await labelsOffHarness();
  try {
    const wait = h.context.waitForFrame;
    h.context.waitForFrame = async () => { h.failFrame(); return wait(); };
    await assert.rejects(h.configureInspection({ labels: true }), error => error.name === 'InvalidStateError');
    assert.equal(h.state.status, 'error'); assert.equal(h.context.busy, false);
    // The harness runs the viewer in its own realm, so the message may carry the error name.
    assert.match(h.state.error, /invalid state\.; restoring the previous scene failed: (Error: )?frame_failed$/);
    // A viewer still in error refuses at admission and never redraws for it.
    const full = h.work.fullAppearance;
    await assert.rejects(h.configureInspection({ color: 'element-symbol' }), /viewer_busy/);
    assert.equal(h.work.fullAppearance, full); assert.equal(h.state.status, 'error');
  } finally { h.dispose(); }
});

test('an admission refusal never redraws or changes the viewer status', async () => {
  const h = await labelsOffHarness();
  try {
    const full = h.work.fullAppearance;
    h.context.interactionActive = () => true;
    await assert.rejects(h.configureInspection({ labels: true }), /Release the molecular drag/);
    assert.equal(h.state.status, 'ready'); assert.equal(h.work.fullAppearance, full); assert.equal(h.counts.frames, 0);
  } finally { h.dispose(); }
});

test('a failed compound keeps its own captured-scene restore', async () => {
  const h = await appearanceRenderHarness(undefined, { data: structure });
  try {
    h.resetCounts(); h.failFrame();
    await assert.rejects(h.compound({ patch: { ops: [{ kind: 'appearance', patch: { color: 'element-symbol' } },
      { kind: 'placement', patch: { scale: 2 } }] } }), /frame_failed/);
    assert.equal(h.counts.restores, 1);
    assert.equal(h.state.status, 'ready');
  } finally { h.dispose(); }
});

test('a failed compound in a companion scene still runs its own restore, not the companion redraw', async () => {
  const h = await appearanceRenderHarness(undefined, { data: structure });
  try {
    const companions = [];
    Object.assign(h.context, { companionRecord: {}, restoreCompanion: async value => { companions.push(value); } });
    h.resetCounts(); h.failFrame();
    await assert.rejects(h.compound({ patch: { ops: [{ kind: 'appearance', patch: { color: 'element-symbol' } },
      { kind: 'placement', patch: { scale: 2 } }] } }), /frame_failed/);
    // The companion redraw would have set ready first and skipped the captured-scene restore.
    assert.deepEqual(companions, []);
    assert.equal(h.counts.restores, 1);
    assert.equal(h.state.status, 'ready');
  } finally { h.dispose(); }
});

test('a residue label that fails to build takes its component off the state tree, or keeps it for a retry', async () => {
  for (const deleteFails of [false, true]) {
    const cells = new Map(), deleted = [];
    let failingDeletes = deleteFails ? 2 : 0;
    const c = vm.createContext({
      console: { error() {} }, inspectionState: { snapshot: () => ({ appearance: { labels: true, highlightColor: '#ffcc00' } }) },
      inspectionSnapshot: () => ({ placement: { scale: 1 } }), strandedLabelRefs: new Set(),
      selection: { rows: [{ key: 'k', coordinateState: 'resolved', atomSites: [{}] }], toLoci: () => ({}) },
      structure: {}, state: { selectionKeys: ['k'] }, hiddenSceneKeySet: () => new Set(), canvas: { xr: { isPresenting: { value: true } } },
      LABEL_CHARACTER_DEGREES: { comfortable: 1 }, xrLabelSizing: () => { throw labelFailure(); },
      inspectionLabel: undefined, applyInspectionTransform() {}, residueRunPlate,
      plugin: {
        builders: { structure: { tryCreateComponentFromSelection: async () => { cells.set('labels', {}); return { ref: 'labels' }; } } },
        state: { data: { cells, build: () => ({ delete: ref => ({ async commit() {
          if (failingDeletes > 0) { failingDeletes -= 1; throw Error('delete_failed'); }
          cells.delete(ref); deleted.push(ref);
        } }) }) } },
      },
    });
    vm.runInContext(`${pageSource('removeInspectionLabels')}\n${pageSource('rebuildInspectionLabels')}`, c);
    // The label's own failure reaches the caller even when the delete fails.
    await assert.rejects(c.rebuildInspectionLabels(), error => error.name === 'InvalidStateError');
    assert.equal(c.inspectionLabel, undefined);
    assert.deepEqual(deleted, deleteFails ? [] : ['labels']);
    assert.deepEqual([...c.strandedLabelRefs], deleteFails ? ['labels'] : []);
    if (!deleteFails) continue;
    // The recovery redraw's label removal retries it. A second failure throws,
    // so the recovery keeps its error; a later removal that works clears it.
    await assert.rejects(c.removeInspectionLabels(), /delete_failed/);
    assert.equal(cells.has('labels'), true);
    await c.removeInspectionLabels();
    assert.equal(cells.has('labels'), false); assert.equal(c.strandedLabelRefs.size, 0);
  }
});

const pageSource = name => {
  const start = viewerSource.indexOf(`  async function ${name}(`);
  assert.ok(start >= 0, `missing ${name}`);
  return viewerSource.slice(start, viewerSource.indexOf('\n  }', start) + 4);
};

test('a failed companion edit keeps admissions closed until the prior scene has drawn', async () => {
  for (const failDraw of [false, true]) {
    let release;
    const frame = new Promise((resolve, reject) => { release = () => failDraw ? reject(Error('redraw_failed')) : resolve(); });
    const seen = [], retired = { id: 'replaced comparison' }, deleted = [];
    const c = vm.createContext({
      Error, state: { status: 'ready', error: null }, busy: false,
      assertReady() {}, foldCompanion: (current, patch) => patch, inspectionSnapshot: () => ({ companionStructure: undefined }),
      // As mutate does: the operation runs, then its failure leaves `error`.
      inspectionMutation: async operation => {
        c.state.status = 'mutating'; c.busy = true;
        await operation();
        c.busy = false; c.state.status = 'error'; c.state.error = 'companion_failed';
        throw Error('companion_failed');
      },
      inspectionState: { setCompanion() {} }, retiredComparisons: new Set([retired]),
      deleteRecord: async record => { deleted.push(record); }, console,
      restoreCompanion: async () => {}, applyInspectionTransform() {}, assertContext() {},
      applyInspectionAppearance: async () => { seen.push({ status: c.state.status, busy: c.busy }); },
      canvas: { webgl: { isContextLost: false }, commit() {} }, waitForFrame: () => frame,
    });
    vm.runInContext(pageSource('setCompanion'), c);
    const rejected = assert.rejects(c.setCompanion({}), /companion_failed/);
    await new Promise(resolve => setImmediate(resolve));
    // The first draw is the failed change; the second is the recovery.
    assert.deepEqual(seen, [{ status: 'mutating', busy: true }, { status: 'mutating', busy: true }]);
    assert.equal(c.state.status, 'mutating'); assert.equal(c.busy, true);
    release(); await rejected;
    assert.equal(c.state.status, failDraw ? 'error' : 'ready'); assert.equal(c.busy, false);
    assert.equal(c.state.error, failDraw ? 'companion_failed; restoring the previous scene failed: redraw_failed' : null);
    // The replaced comparison goes once the prior scene has drawn, and stays if it did not.
    assert.deepEqual(deleted, failDraw ? [] : [retired]);
    assert.equal(c.retiredComparisons.size, failDraw ? 1 : 0);
  }
  // A lost context keeps its own recovery: no redraw, and never ready.
  const redraws = [];
  const lost = vm.createContext({
    Error, state: { status: 'context_lost', error: 'lost' }, busy: false,
    assertReady() {}, foldCompanion: (current, patch) => patch, inspectionSnapshot: () => ({ companionStructure: undefined }),
    inspectionMutation: async () => { throw Error('context_lost'); },
    restoreCompanion: async () => { redraws.push('companion'); }, applyInspectionAppearance: async () => { redraws.push('appearance'); },
    canvas: { webgl: { isContextLost: true } },
  });
  vm.runInContext(pageSource('setCompanion'), lost);
  await assert.rejects(lost.setCompanion({}), /context_lost/);
  assert.deepEqual(redraws, []); assert.equal(lost.state.status, 'context_lost');
  // A refusal before the operation, such as an active drag, changed nothing: no redraw, still ready.
  const refused = vm.createContext({
    Error, state: { status: 'ready', error: null }, busy: false,
    assertReady() {}, foldCompanion: (current, patch) => patch, inspectionSnapshot: () => ({ companionStructure: undefined }),
    inspectionMutation: async () => { throw Error('Release the molecular drag before applying a change.'); },
    restoreCompanion: async () => { redraws.push('companion'); }, applyInspectionAppearance: async () => { redraws.push('appearance'); },
    canvas: { webgl: { isContextLost: false } },
  });
  vm.runInContext(pageSource('setCompanion'), refused);
  await assert.rejects(refused.setCompanion({}), /Release the molecular drag/);
  assert.deepEqual(redraws, []); assert.equal(refused.state.status, 'ready');
});

test('a refused change in a companion scene never takes the companion redraw', async () => {
  for (const enters of [false, true]) {
    const redraws = [];
    const c = vm.createContext({
      state: { status: 'ready', error: null }, busy: false, companionRecord: {}, retiredComparisons: new Set(),
      companionRecoveryActive: false, companionRecoveryPendingXr: false, assertContext() {},
      inspectionState: { checkpoint: () => ({ current: { companionStructure: {} } }), restoreCheckpoint() {}, payload: () => undefined },
      // An active drag refuses before the operation; an entered change fails inside it.
      mutate: async (kind, operation) => {
        if (!enters) throw Error('Release the molecular drag before applying a change.');
        await operation(); c.state.status = 'error'; c.state.error = 'frame_failed'; throw Error('frame_failed');
      },
      representation: undefined, plugin: { state: { data: { cells: new Map() } } },
      canvas: { webgl: { isContextLost: false }, xr: { isPresenting: { value: false } }, commit() {} },
      restoreInspectionPayload: () => redraws.push('payload'), inspectionSnapshot: () => ({ companionStructure: {} }),
      restoreCompanion: async () => redraws.push('companion'), applyInspectionAppearance: async () => redraws.push('appearance'),
      applyInspectionTransform() {}, waitForFrame: async () => redraws.push('frame'),
    });
    vm.runInContext(pageSource('inspectionMutation'), c);
    await assert.rejects(c.inspectionMutation(() => {}), enters ? /frame_failed/ : /Release the molecular drag/);
    assert.deepEqual(redraws, enters ? ['payload', 'companion', 'appearance', 'frame'] : []);
    // A drawn recovery clears the failure message along with the status.
    assert.equal(c.state.status, 'ready'); assert.equal(c.state.error, null);
  }
});

test('a label removal retries stranded label cells first and throws if they still cannot go', async () => {
  for (const deleteFails of [false, true]) {
    const cells = new Map([['labels-0', {}], ['labels-1', {}]]);
    const c = vm.createContext({
      strandedLabelRefs: new Set(['labels-0', 'labels-1', 'labels-2']), inspectionLabel: undefined,
      plugin: { state: { data: { cells, build: () => ({ delete: ref => ({ async commit() {
        if (deleteFails) throw Error('delete_failed');
        cells.delete(ref);
      } }) }) } } },
    });
    vm.runInContext(pageSource('removeInspectionLabels'), c);
    if (deleteFails) {
      // A recovery redraw that reaches this throws, so it keeps its error.
      await assert.rejects(c.removeInspectionLabels(), /delete_failed/);
      assert.deepEqual([...c.strandedLabelRefs], ['labels-0', 'labels-1', 'labels-2']);
    } else {
      await c.removeInspectionLabels();
      assert.deepEqual([...cells.keys()], []); assert.equal(c.strandedLabelRefs.size, 0);
    }
  }
});

test('a failed restore puts back its emphasis, plate flag and lesson key before the recovery redraw', async () => {
  for (const fails of [true, false]) {
    let labels = false, seen;
    const remembered = [], previous = { parts: [], focus: [], contextOpacity: 0.18 };
    const c = vm.createContext({
      ...emptyLessonFigureBinding(),
      detached: value => structuredClone(value),
      assertReady() {}, validInspectionCapture: value => value, recordManipulation() {},
      wearerPlacement: { holdsPlacement: () => false }, inspectionSnapshot: () => ({ placement: {} }),
      normalizeVisibility: value => value ?? {}, normalizeStyles: value => value ?? [], normalizeEmphasisState: value => ({ ...value }),
      emphasisState: previous, emphasisOrigin: 'command', lessonMotionHold: { release() {} },
      lessonKey: { remember: key => remembered.push(key) },
      // A restored starting view turns the baseline's plates on.
      lessonResting: { labelsEnabled: () => labels, setLabelsEnabled: value => { labels = value; },
        noteRestoredKey: () => { labels = true; return 'resting'; } },
      // The real inspectionMutation runs the rollback before its recovery redraw.
      inspectionMutation: async (operation, options) => {
        if (!fails) return 'restored';
        await options.rollback();
        seen = { emphasis: c.emphasisState, origin: c.emphasisOrigin, labels, remembered: remembered.length };
        throw Error('restore_failed');
      },
    });
    vm.runInContext(pageSource('restoreInspection'), c);
    const scene = { inspection: { emphasis: { parts: [{ id: 'rna' }], origin: 'resting' } }, keys: [], camera: {} };
    if (fails) {
      await assert.rejects(c.restoreInspection(scene), /restore_failed/);
      assert.deepEqual(seen, { emphasis: previous, origin: 'command', labels: false, remembered: 0 });
      assert.deepEqual(remembered, []);
    } else {
      assert.equal(await c.restoreInspection(scene), 'restored');
      assert.deepEqual(remembered.map(key => key.parts[0].id), ['rna']);
      assert.equal(labels, true); assert.equal(c.emphasisOrigin, 'resting');
    }
  }
});

test('a residue label whose removal fails is retried by the next removal', async () => {
  const cells = new Map([['labels', {}]]);
  let failingDeletes = 1;
  const c = vm.createContext({
    strandedLabelRefs: new Set(), inspectionLabel: { component: { ref: 'labels' }, representation: { ref: 'labels-repr' } },
    plugin: { state: { data: { cells, build: () => ({ delete: ref => ({ async commit() {
      if (failingDeletes > 0) { failingDeletes -= 1; throw Error('delete_failed'); }
      cells.delete(ref);
    } }) }) } } },
  });
  vm.runInContext(pageSource('removeInspectionLabels'), c);
  await assert.rejects(c.removeInspectionLabels(), /delete_failed/);
  // Nothing tracks it as the live label any more; the retry list does.
  assert.equal(c.inspectionLabel, undefined);
  assert.deepEqual([...c.strandedLabelRefs], ['labels']);
  assert.equal(cells.has('labels'), true);
  await c.removeInspectionLabels();
  assert.equal(cells.has('labels'), false); assert.equal(c.strandedLabelRefs.size, 0);
});
