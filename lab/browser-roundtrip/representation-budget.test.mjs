import { emptyLessonFigureBinding } from './fixtures/empty-lesson-figure.mjs';
import test from 'node:test';
import { xrBallAndStickParams, colorOnlyAppearanceChange } from './inspection-appearance.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { normalizeAppearance, sameAppearance } from './inspection-state.mjs';
import { estimateRepresentation, geometryBudgetDecision, geometryBudgetReceipt, geometryBudgetConfirmation,
  requireGeometryBudget, requireSceneGeometryBudget, effectiveGeometryLevel, structureGeometryCounts, GEOMETRY_LEVELS,
  GEOMETRY_DETAIL, REPRESENTATION_BUDGETS, geometryDebugOptions, withGeometryDebug } from './representation-budget.mjs';
import { spokenConfirmation } from './voice-command-runner.mjs';
const require = createRequire(new URL('../../plugin/package.json', import.meta.url));
const { Sphere } = require('molstar/lib/commonjs/mol-geo/primitive/sphere.js');
const { Cylinder } = require('molstar/lib/commonjs/mol-geo/primitive/cylinder.js');
const { Prism } = require('molstar/lib/commonjs/mol-geo/primitive/prism.js');
const { polygon } = require('molstar/lib/commonjs/mol-geo/primitive/polygon.js');
const small = { atoms: 327, residues: 46 };
const ordinary = { atoms: 4400, residues: 801 };
const ask = (changes = {}) => ({ ...ordinary, representation: 'ball-and-stick', deviceClass: 'quest2',
  presenting: true, quality: 'low', standalone: true, ...changes });

test('sphere and capped half-link vertex counts match installed Mol* at every quality', () => {
  for (const level of GEOMETRY_LEVELS) {
    const p = GEOMETRY_DETAIL[level], estimate = estimateRepresentation({ ...small, representation: 'ball-and-stick', level });
    assert.equal(estimate.sphereVertices, Sphere(p.detail).vertices.length / 3);
    const cylinder = p.radialSegments <= 4 ? Prism(polygon(Math.max(3, p.radialSegments), true), { topCap: true, bottomCap: true })
      : Cylinder({ radialSegments: p.radialSegments, topCap: true, bottomCap: true });
    assert.equal(estimate.cylinderVertices, cylinder.vertices.length / 3);
  }
});
test('historical probes produce an advisory without lowering requested detail', () => {
  assert.equal(estimateRepresentation({ ...small, representation: 'ball-and-stick' }).vertices, 22788);
  assert.equal(estimateRepresentation({ ...ordinary, representation: 'ball-and-stick' }).vertices, 306240);
  assert.equal(geometryBudgetDecision(ask(small)).status, 'unchanged');
  const decision = geometryBudgetDecision(ask());
  assert.equal(decision.status, 'advisory'); assert.equal(decision.level, 'lower');
  assert.equal(decision.estimatedVertices, 306240); assert.deepEqual(decision.typeParams, {});
  assert.match(decision.message, /may run slowly/);
});
test('each representation estimate decreases monotonically along the Mol* detail ladder', () => {
  for (const representation of ['ball-and-stick', 'spacefill', 'molecular-surface', 'cartoon']) {
    const costs = GEOMETRY_LEVELS.map(level => estimateRepresentation({ ...ordinary, representation, level }).vertices);
    assert.ok(costs.every((cost, i) => i === 0 || cost >= costs[i - 1]));
  }
});
test('million-atom asks preserve every quality and style; only Quest 2 receives the historical advisory', () => {
  for (const deviceClass of ['quest2', 'quest3', 'quest-pro', 'vision-pro', 'hand-only', 'unknown', 'desktop'])
    for (const representation of ['ball-and-stick', 'spacefill', 'molecular-surface', 'cartoon'])
      for (const quality of GEOMETRY_LEVELS) {
        const decision = requireGeometryBudget(ask({ deviceClass, representation, quality, standalone: false,
          atoms: 1_000_001, residues: 200_000 }));
        assert.equal(decision.representation, representation);
        assert.equal(decision.level, quality); assert.equal(decision.requestedLevel, quality);
        assert.deepEqual(decision.typeParams, {});
        assert.equal(decision.status, deviceClass === 'quest2' ? 'advisory' : 'unchanged');
        if (deviceClass === 'quest2') assert.match(decision.message, /may run slowly/);
        else assert.equal(geometryBudgetReceipt(decision), undefined);
      }
  assert.equal(geometryBudgetDecision(ask({ presenting: false, atoms: 1_000_001 })).status, 'unchanged');
});
test('a combined scene on an unbounded headset is left alone and yields no receipt', () => {
  // A base representation plus a style layer, presenting. On a Vision Pro this
  // used to come back `reduced` against an Infinity budget with NaN vertices;
  // JSON sent both as null and the host refused the completion with a 409.
  const scene = [{ ...ordinary, representation: 'cartoon' }, { ...small, representation: 'ball-and-stick' },
    { ...small, representation: 'spacefill' }];
  const options = { presenting: true, quality: 'high', standalone: false };
  for (const deviceClass of ['quest3', 'quest-pro', 'vision-pro', 'hand-only', 'unknown', 'unnamed-class']) {
    const decisions = requireSceneGeometryBudget(scene, { ...options, deviceClass });
    assert.equal(decisions.length, scene.length);
    for (const decision of decisions) {
      assert.equal(decision.status, 'unchanged'); assert.deepEqual(decision.typeParams, {});
      assert.equal(decision.message, undefined); assert.equal(geometryBudgetReceipt(decision), undefined);
    }
  }
  // Quest 2 combines the historical estimates but preserves each requested level.
  const quest2 = requireSceneGeometryBudget(scene, { ...options, deviceClass: 'quest2' });
  for (const decision of quest2) {
    assert.equal(decision.status, 'advisory'); assert.deepEqual(decision.typeParams, {});
    assert.equal(decision.level, 'high'); assert.ok(decision.estimatedVertices > decision.budget);
    const receipt = geometryBudgetReceipt(decision);
    assert.deepEqual(JSON.parse(JSON.stringify(receipt)), receipt, 'every receipt number survives JSON');
  }
});
test('a class with bounded and unbounded representations shares its allowance among the bounded ones only', () => {
  // No class mixes ceilings today, so this runs the production function
  // against a table that does: Quest 2 ceilings with an unbounded surface.
  const text = readFileSync(new URL('./representation-budget.mjs', import.meta.url), 'utf8');
  const start = text.indexOf('export function requireSceneGeometryBudget(');
  const body = text.slice(start, text.indexOf('\n}', start) + 2).replace('export ', '');
  const mixed = { ...REPRESENTATION_BUDGETS.quest2, 'molecular-surface': Infinity };
  const context = vm.createContext({ ...emptyLessonFigureBinding(), REPRESENTATION_BUDGETS: { mixed, unknown: REPRESENTATION_BUDGETS.unknown },
    requireGeometryBudget, estimateRepresentation, effectiveGeometryLevel, GEOMETRY_LEVELS, GEOMETRY_DETAIL,
    geometryDebugOptions: () => ({}), withGeometryDebug: decision => decision });
  vm.runInContext(`${body}\nglobalThis.sceneBudget = requireSceneGeometryBudget;`, context);
  // Unset quality lets atom count pick the level: `higher` for 1CRN sticks,
  // `lowest` for a two-million-atom surface.
  const [sticks, surface] = context.sceneBudget([{ ...small, representation: 'ball-and-stick' },
    { atoms: 2_000_000, residues: 250_000, representation: 'molecular-surface' }],
  { presenting: true, deviceClass: 'mixed', standalone: false });
  assert.equal(sticks.status, 'advisory'); assert.equal(sticks.requestedLevel, 'higher'); assert.equal(sticks.level, 'higher');
  assert.deepEqual(JSON.parse(JSON.stringify(sticks.typeParams)), {});
  const receipt = geometryBudgetReceipt(sticks);
  assert.deepEqual(JSON.parse(JSON.stringify(receipt)), receipt);
  assert.equal(surface.status, 'unchanged'); assert.deepEqual(surface.typeParams, {});
  assert.equal(geometryBudgetReceipt(surface), undefined);
});
test('combined scenes preserve different explicit entry qualities', () => {
  const entries = [{ ...ordinary, representation: 'spacefill', quality: 'highest' },
    { atoms: 1_000_001, residues: 200_000, representation: 'cartoon', quality: 'high' }];
  const decisions = requireSceneGeometryBudget(entries, { presenting: true, deviceClass: 'quest2', quality: 'low' });
  assert.deepEqual(decisions.map(d => d.level), ['highest', 'high']);
  assert.ok(decisions.every(d => d.status === 'advisory' && Object.keys(d.typeParams).length === 0));
});
test('a receipt is never built from a non-finite budget, vertex count or atom count', () => {
  const reduced = geometryBudgetDecision(ask());
  assert.ok(geometryBudgetReceipt(reduced));
  for (const broken of [{ budget: Infinity }, { estimatedVertices: NaN }, { atoms: Infinity }])
    assert.equal(geometryBudgetReceipt({ ...reduced, ...broken }), undefined);
});
test('surface advisories preserve resolution and counts include assembly copies and bonds', () => {
  const decision = geometryBudgetDecision(ask({ representation: 'molecular-surface', quality: 'high' }));
  assert.equal(decision.status, 'advisory'); assert.deepEqual(decision.typeParams, {});
  assert.deepEqual(structureGeometryCounts({ elementCount: 8800, bondCount: 9000, atomicResidueCount: 1602 }),
    { atoms: 8800, bonds: 9000, residues: 1602 });
  assert.equal(effectiveGeometryLevel('low', 4400, true), 'lower');
  assert.equal(effectiveGeometryLevel('auto', 4400, true), 'medium');
  assert.throws(() => geometryBudgetDecision(ask({ atoms: NaN })), /invalid atom count/);
});
test('receipt and caption warn about cost without claiming a downgrade or performance guarantee', () => {
  const decision = geometryBudgetDecision(ask()), receipt = geometryBudgetReceipt(decision);
  assert.match(receipt.message, /requested detail; it may run slowly/);
  assert.equal(receipt.level, receipt.requestedLevel);
  assert.equal(geometryBudgetConfirmation({ geometryBudget: receipt }, 'Done.'), receipt.message);
  assert.equal(spokenConfirmation({ action: { kind: 'appearance' }, say: 'Sticks.' }, { applied: { geometryBudget: receipt } }), receipt.message);
  assert.equal(geometryBudgetConfirmation({}, 'Done.'), 'Done.');
  assert.equal(geometryBudgetConfirmation({ geometryBudget: receipt, scaleAppliesOnNextEntry: true }, 'Max quality.'),
    receipt.message + ' Resolution changes after re-entry.');
  assert.doesNotThrow(() => requireGeometryBudget(ask({ atoms: 10_000_000 })));
});

test('measurement knobs are read only from the page query and change nothing when absent', () => {
  const page = search => ({ location: { search } });
  assert.deepEqual(geometryDebugOptions(page('')), {});
  assert.deepEqual(geometryDebugOptions(page('?xrRenderBudget=scale:0.5')), {});
  assert.deepEqual(geometryDebugOptions(page('?xrRenderBudget=budget:draw,h:off,sphere:1')),
    { overBudget: 'draw', ignoreHydrogens: true, sphereDetail: 1 });
  assert.deepEqual(geometryDebugOptions(page('?xrRenderBudget=sphere:impostor;hydrogens=no')),
    { ignoreHydrogens: true, sphereDetail: 'impostor' });
  assert.deepEqual(geometryDebugOptions(page('?xrRenderBudget=sphere:4,budget:refuse')), {});
  assert.deepEqual(geometryDebugOptions({}), {});
  assert.equal(geometryDebugOptions().overBudget, undefined);
});

test('explicit budget:draw retains the legacy reduction and lowest-detail capture', () => {
  const over = ask({ atoms: 100000, representation: 'spacefill' });
  assert.equal(requireGeometryBudget(over).status, 'advisory');
  const legacySmall = requireGeometryBudget({ ...ask(), overBudget: 'draw' });
  assert.equal(legacySmall.level, 'lowest'); assert.equal(legacySmall.estimatedVertices, 242880);
  const drawn = requireGeometryBudget({ ...over, overBudget: 'draw' });
  assert.equal(drawn.status, 'reduced');
  assert.equal(drawn.level, 'lowest');
  assert.equal(drawn.estimatedVertices, 12 * 100000);
  assert.deepEqual(drawn.typeParams, { quality: 'custom', ...GEOMETRY_DETAIL.lowest, tryUseImpostor: false });
  assert.match(drawn.message, /past the 120000-vertex geometry policy/);
  const scene = requireSceneGeometryBudget([{ ...ordinary, representation: 'spacefill', atoms: 100000 }],
    { presenting: true, deviceClass: 'quest2', quality: 'low', standalone: true, overBudget: 'draw' });
  assert.equal(scene[0].level, 'lowest');
  assert.equal(scene[0].status, 'reduced');
});

test('sphere and hydrogen knobs lay over a decision without changing its estimate', () => {
  const unchanged = geometryBudgetDecision(ask({ representation: 'spacefill', atoms: 3000 }));
  assert.deepEqual(withGeometryDebug(unchanged, {}), unchanged);
  const mesh = withGeometryDebug(unchanged, { sphereDetail: 1, ignoreHydrogens: true });
  assert.deepEqual(mesh.typeParams, { quality: 'custom', detail: 1, tryUseImpostor: false, ignoreHydrogens: true });
  assert.equal(mesh.estimatedVertices, unchanged.estimatedVertices);
  assert.deepEqual(withGeometryDebug(unchanged, { sphereDetail: 'impostor' }).typeParams, { tryUseImpostor: true });
  const cartoon = geometryBudgetDecision(ask({ representation: 'cartoon' }));
  assert.deepEqual(withGeometryDebug(cartoon, { sphereDetail: 1, ignoreHydrogens: true }), cartoon);
});

const source = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
const start = source.indexOf('  async function configureInspection(');
const end = source.indexOf('\n  async function placeInspection(', start);
function viewerHarness(counts) {
  let appearance = normalizeAppearance({ representation: 'cartoon' }), mutations = 0;
  let applied;
  const context = vm.createContext({ ...emptyLessonFigureBinding(),
    // This fixture does not paint, so drawing the selection costs it
    // nothing. `render-dedupe-harness.mjs` is the one that counts paints, and
    // its stub runs the real emphasis pass.
    currentSelectionPlan: () => undefined, assertContext() {},
    async paintSelectionOverlay() {}, xrBallAndStickParams, colorOnlyAppearanceChange, companionRecord:undefined, retiredComparisons:new Set(),
    restoreCompanion:async value=>{ if(value!==undefined) throw Error('This primary-only fixture does not carry a comparison.'); },
    paintCompanion:async()=>{}, normalizeAppearance, sameAppearance, assertReady() {},
    findCurrentStructureRepresentation: () => undefined, volume: undefined,
    structure: { obj: { data: { elementCount: counts.atoms } } }, plugin: { representation: { structure: { registry: { get: () => ({ isApplicable: () => true }) } } } },
    inspectionSnapshot: () => ({ appearance }), geometryFor: representation => requireGeometryBudget(ask({ ...counts, representation })),
    lessonResting: { labelsEnabled: () => true }, syncInspectionPayload() {},
    inspectionState: { configure: patch => { appearance = normalizeAppearance(patch, appearance); } },
    applyInspectionAppearance: async () => { applied = geometryBudgetReceipt(requireGeometryBudget(ask({ ...counts, representation: appearance.representation }))); },
    inspectionMutation: async op => { mutations++; await op(); return { rendered: true, applied }; },
    snapshot: () => ({ appearance }),
  });
  vm.runInContext(`${source.slice(start, end)}\nglobalThis.configure = configureInspection`, context);
  return { configure: context.configure, appearance: () => appearance, mutations: () => mutations };
}
test('production appearance admission accepts huge styles and preserves exact scientific appearance', async () => {
  for (const counts of [small, ordinary, { atoms: 1_000_001, residues: 200_000 }]) {
    const viewer = viewerHarness(counts), expected = normalizeAppearance({ representation: 'ball-and-stick', color: 'element-symbol' });
    const result = await viewer.configure({ representation: 'ball-and-stick', color: 'element-symbol' });
    assert.deepEqual(viewer.appearance(), expected); assert.equal(result.rendered, true);
    assert.equal(viewer.mutations(), 1); assert.equal(Boolean(result.applied), counts !== small);
  }
});

test('production appearance rebuild preserves selected high quality, style, appearance and camera', async () => {
  const start = source.indexOf('  async function applyInspectionAppearance(');
  const end = source.indexOf('\n  /**', start);
  for (const counts of [{ atoms: 1, bonds: 0, residues: 1 }, small, ordinary, { atoms: 1_000_001, residues: 200_000 }]) {
    const appearance = normalizeAppearance({ representation: 'ball-and-stick', color: 'uniform', uniformColor: '#abcdef', opacity: 0.7 });
    const before = structuredClone(appearance), camera = { position: [1, 2, 3] };
    let builtParams, restoredCamera;
    const context = vm.createContext({ appearanceWork: undefined, busy: true, retainedPoseHidden: false, frameWaiters: new Set(), ...emptyLessonFigureBinding(),
      styleLayers: [], ligandOverlay: undefined,
    // This fixture does not paint, so drawing the selection costs it
    // nothing. `render-dedupe-harness.mjs` is the one that counts paints, and
    // its stub runs the real emphasis pass.
    currentSelectionPlan: () => undefined, assertContext() {},
    async paintSelectionOverlay() {}, xrBallAndStickParams, colorOnlyAppearanceChange, companionRecord:undefined, retiredComparisons:new Set(),
    restoreCompanion:async value=>{ if(value!==undefined) throw Error('This primary-only fixture does not carry a comparison.'); },
    paintCompanion:async()=>{}, volume: undefined, inspectionSnapshot: () => ({ appearance }), paintVisibilityLayers: async () => {},
      inspectionRepresentationName() {}, INSPECTION_COLORS: new Set(['uniform']),
      canvas: { xr: { isPresenting: { value: true } }, camera: { getSnapshot: () => camera, setState: c => { restoredCamera = c; } }, setProps() {} },
      representationForBudget: name => name, sessionDeviceClass: () => 'quest2', currentXrSession: () => ({}),
      structureAtomSites: () => counts.atoms, plugin: {}, structure: { obj: { data: { elementCount: counts.atoms } } },
      xrRepresentationQuality: () => 'highest', xrRepresentationMaterial: () => null, xrColorParams: () => null,
      geometryFor: representation => requireGeometryBudget(ask({ ...counts, representation, quality: 'highest', standalone: false })), geometryBudgetReceipt,
      createStructureRepresentationParams: (_plugin, _data, params) => params,
      Color: n => n, colorNumber: s => Number.parseInt(s.slice(1), 16), now: () => 0,
      builtRepresentation: 'ball-and-stick', appliedGeometryBudget: { message: 'Stale prior scene warning' },
      commitRepresentationUpdate: builder => builder.commit({ revertOnError: true }),
      representation: { cell: { params: { values: { type: 'ball-and-stick' } } }, update: params => ({ commit: async () => { builtParams = params; } }) },
      rebuildLigandOverlay: async () => {}, rebuildStyleLayers: async () => {}, ligandOverlayForBudget: () => undefined, ligandAtomSites: () => 0,
      currentEmphasisPlan: () => undefined, markSelection() {}, state: { selectionKeys: [] },
      applyInspectionTransform() {}, recordCost() {},
    });
    vm.runInContext(`${source.slice(start, end)}\nglobalThis.applyAppearance = applyInspectionAppearance`, context);
    await context.applyAppearance({ labels: false, componentLabels: false });
    assert.deepEqual(appearance, before); assert.equal(restoredCamera, camera);
    assert.equal(builtParams.type, 'ball-and-stick'); assert.equal(builtParams.typeParams.alpha, 0.7);
    assert.equal(builtParams.colorParams.value, 0xabcdef);
    assert.equal(builtParams.typeParams.quality, 'highest');
    assert.equal(builtParams.typeParams.tryUseImpostor, undefined);
    assert.equal(Boolean(context.appliedGeometryBudget), counts.atoms > 1);
    if (context.appliedGeometryBudget) assert.match(context.appliedGeometryBudget.message, /may run slowly/);
  }
});
