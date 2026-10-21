import { geometryBudgetChanged } from './geometry-advisory.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createInspectionState } from './inspection-state.mjs';
import { MOLECULAR_REPRESENTATIONS, nextMolecularRepresentation } from './spatial-toolbar-content.mjs';

const source = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
const actionStart = source.indexOf('      onSpatialAction: async action => {');
const actionSource = '({' + source.slice(actionStart, source.indexOf('      onInputVisibility:', actionStart)) + '}).onSpatialAction';
const plain = value => JSON.parse(JSON.stringify(value));
function harness() {
  const state = createInspectionState(), paints = [];
  state.place({ translation: [2, -1, .4], rotation: [10, 35, -20], scale: 3 });
  const context = vm.createContext({
    geometryBudgetChanged, appliedGeometryBudget: undefined, onSceneHistoryAction: undefined, assertReady() {}, nextMolecularRepresentation, MOLECULAR_REPRESENTATIONS,
    inspectionSnapshot: () => state.snapshot(), snapshot: () => state.snapshot(),
    spatialRepresentations: () => MOLECULAR_REPRESENTATIONS,
    configureInspection: async (patch, options) => { paints.push({ patch: plain(patch), options: plain(options) }); state.configure(plain(patch)); return state.snapshot(); },
    undoInspection: () => state.undo(), redoInspection: () => state.redo(),
    runSpatialAction: (_action, apply) => apply(),
  });
  return { state, paints, context, action: vm.runInContext(actionSource, context) };
}

test('menu cycles actual scene state, keeps placement, and restores styles through history', async () => {
  const h = harness(), placement = h.state.snapshot().placement;
  for (const expected of ['spacefill', 'molecular-surface', 'ball-and-stick', 'cartoon']) {
    await h.action({ kind: 'appearance-cycle' });
    assert.equal(h.state.snapshot().appearance.representation, expected);
    assert.deepEqual(h.state.snapshot().placement, placement);
  }
  assert.ok(h.paints.every(paint => paint.options.preservePlacement === true));
  await h.action({ kind: 'undo' });
  assert.equal(h.state.snapshot().appearance.representation, 'ball-and-stick');
  await h.action({ kind: 'redo' });
  assert.equal(h.state.snapshot().appearance.representation, 'cartoon');
  await h.action({ kind: 'undo' });
  await h.action({ kind: 'appearance-cycle' });
  assert.equal(h.state.snapshot().history.redoCount, 0, 'a fresh edit retires redo');
});

test('queued clicks resolve each next style on admission, not from the old drawn row', async () => {
  const h = harness(), pending = [];
  h.context.runSpatialAction = (_action, apply) => new Promise(resolve => pending.push(async () => resolve(await apply())));
  const first = h.action({ kind: 'appearance-cycle' }), second = h.action({ kind: 'appearance-cycle' });
  await pending.shift()(); await pending.shift()(); await Promise.all([first, second]);
  assert.equal(h.state.snapshot().appearance.representation, 'molecular-surface');
});

test('source capabilities are checked at click time and density cannot become fake atoms', async () => {
  const h = harness();
  h.context.spatialRepresentations = () => ['cartoon', 'molecular-surface'];
  await h.action({ kind: 'appearance-cycle' });
  assert.equal(h.state.snapshot().appearance.representation, 'molecular-surface');
  h.state.configure({ representation: 'isosurface' });
  h.context.spatialRepresentations = () => [];
  const before = h.state.snapshot(); await h.action({ kind: 'appearance-cycle' });
  assert.deepEqual(h.state.snapshot(), before);
});

test('shared history runs outside the workspace queue so command polling can draw it', async () => {
  const h = harness(), calls = [];
  h.context.runSpatialAction = () => { throw Error('would deadlock polling'); };
  h.context.onSceneHistoryAction = async kind => { calls.push(kind); return { drawn: true }; };
  assert.deepEqual(await h.action({ kind: 'undo' }), { drawn: true });
  assert.deepEqual(await h.action({ kind: 'redo' }), { drawn: true });
  assert.deepEqual(calls, ['undo', 'redo']);
});

test('representation applicability is cached without precomputing advisory geometry', () => {
  const start = source.indexOf('  function spatialRepresentations() {');
  const end = source.indexOf('\n  }', start) + 4;
  let calls = 0, inapplicable;
  const h = vm.createContext({ MOLECULAR_REPRESENTATIONS, volume: false, lessonFigure: {},
    structure: { obj: { data: {} } }, spatialRepresentationInputs: [], spatialRepresentationOptions: [],
    currentXrSession: () => 'same-session', sessionDeviceClass: () => 'quest2', activeRenderQuality: () => 'balanced',
    canvas: { xr: { isPresenting: { value: true } } }, companionRecord: null, stylesState: [],
    plugin: { representation: { structure: { registry: { get: name => ({ isApplicable: () => { calls++; return name !== inapplicable; } }) } } } },
    geometryFor: () => assert.fail('listing controls must not infer unused bond graphs or budget advisory styles'),
  });
  vm.runInContext(source.slice(start, end), h);
  assert.deepEqual(plain(h.spatialRepresentations()), [...MOLECULAR_REPRESENTATIONS], 'advisory geometry cost never hides a style');
  h.spatialRepresentations(); assert.equal(calls, 4, 'steady frames reuse applicability');
  inapplicable = 'spacefill'; h.stylesState = [];
  assert.deepEqual(plain(h.spatialRepresentations()), ['ball-and-stick', 'cartoon', 'molecular-surface']);
  assert.equal(calls, 8, 'changed geometry inputs refresh real applicability');
  h.volume = true; assert.deepEqual(plain(h.spatialRepresentations()), []);
});

test('representation applicability refreshes on device classification changes within one XR session', () => {
  const start = source.indexOf('  function spatialRepresentations() {');
  const end = source.indexOf('\n  }', start) + 4;
  const session = { inputSources: [] };
  let device = 'unknown', calls = 0;
  const h = vm.createContext({ MOLECULAR_REPRESENTATIONS, volume: false, lessonFigure: {},
    structure: { obj: { data: {} } }, spatialRepresentationInputs: [], spatialRepresentationOptions: [],
    currentXrSession: () => session, sessionDeviceClass: () => device, activeRenderQuality: () => 'balanced',
    canvas: { xr: { isPresenting: { value: true } } }, companionRecord: null, stylesState: [],
    plugin: { representation: { structure: { registry: { get: () => ({ isApplicable: () => { calls++; return true; } }) } } } },
    geometryFor: () => assert.fail('device budget is an action advisory, not an availability restriction'),
  });
  vm.runInContext(source.slice(start, end), h);
  assert.deepEqual(plain(h.spatialRepresentations()), [...MOLECULAR_REPRESENTATIONS]);
  device = 'quest2';
  assert.deepEqual(plain(h.spatialRepresentations()), [...MOLECULAR_REPRESENTATIONS]);
  assert.equal(calls, 8, 'a changed device refreshes applicability without losing styles');
  h.spatialRepresentations(); assert.equal(calls, 8, 'an unchanged device keeps the cached choices');
  device = 'unknown';
  assert.deepEqual(plain(h.spatialRepresentations()), [...MOLECULAR_REPRESENTATIONS]);
  assert.equal(calls, 12);
});

test('actual menu appearance announces a changed advisory once and retains the receipt on unchanged edits', async () => {
  const h = harness(), captions = [], spoken = [];
  const budget = { representation: 'spacefill', atoms: 200000, budget: 260000, estimatedVertices: 10000000,
    deviceClass: 'quest3', requestedLevel: 'high', level: 'high', message: 'Showing atoms at requested detail; it may run slowly.' };
  h.context.showHeadsetCaption = message => captions.push(message);
  h.context.speakOutcome = message => spoken.push(message);
  h.context.configureInspection = async () => { h.context.appliedGeometryBudget = { ...budget }; return { applied: { geometryBudget: { ...budget } } }; };
  const first = await h.action({ kind: 'appearance', preset: 'spacefill' });
  assert.equal(first.announced, true); assert.deepEqual(captions, [budget.message]);
  const second = await h.action({ kind: 'appearance', preset: 'spacefill' });
  assert.equal(second.announced, undefined); assert.deepEqual(second.applied.geometryBudget, budget);
  assert.deepEqual(spoken, [budget.message]);
});
