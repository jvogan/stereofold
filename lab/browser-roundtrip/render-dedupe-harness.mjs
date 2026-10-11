/** Production-function Node harness. Mol* work and frame delivery are mocked;
 * counts establish scheduling, timings are CPU harness costs, never device FPS. */
import vm from 'node:vm';
import { createGesturePivot } from './gesture-pivot.mjs';
import { pageFunction } from './fixtures/label-action-harness.mjs';
import { pathToFileURL } from 'node:url';
import { colorOnlyAppearanceChange } from './inspection-appearance.mjs';
import { representationLayerRef } from './scene-transition.mjs';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createInspectionState, normalizeAppearance, normalizePlacement, sameAppearance } from './inspection-state.mjs';
import { normalizeEmphasisState } from './lesson-emphasis.mjs';
import { normalizeStyles } from './inspection-styles.mjs';
import { normalizeVisibility, emptyVisibility } from './inspection-visibility.mjs';
import { foldCompanion } from './companion-structure.mjs';
import { compoundOps, applyCompoundChange } from './compound-change.mjs';

export const viewerSource = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
function section(source, start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  if (a < 0 || b < a) throw Error(`Missing production function: ${start}`);
  return source.slice(a, b);
}
export function harness(source = viewerSource, { rowCount = 128 } = {}) {
  const counts = { marks: 0, residueLabels: 0, componentLabels: 0, appearance: 0, emphasis: 0, commits: 0, frames: 0, publications: 0, restores: 0 };
  const state = { status: 'ready', generation: 1, revision: 0, selectionKeys: [], mutationCounts: { inspection: 0, selection: 0, representation: 0, pick: 0 } };
  const inspectionState = createInspectionState();
  const rows = Array.from({ length: rowCount }, (_, i) => ({ key: `source:model:assembly:A:${i}`, coordinateState: 'resolved', atomSites: [{}] }));
  const valid = new Set(rows.map(row => row.key));
  const cells = new Map();
  const marker = { values: { tMarker: { ref: { version: 0 } }, markerStatus: { ref: { version: 0 } } } };
  /** One stable overpaint object, so repainting does not itself invalidate the layer stamp. */
  const emphasisOverpaint = {};
  const representation = { ref: 'structure-repr', obj: { data: {} } };
  cells.set(representation.ref, { obj: representation.obj, status: 'ok', state: {}, transform: {}, params: { values: { type: { name: 'cartoon', params: { alpha: 1 } }, colorTheme: { name: 'chain-id' } } } });
  const diagnostics = [];
  let labelObjects = [], failFrame = false, frameGate, labelIntent = true;
  const snapshot = () => ({ ...structuredClone(state), inspection: inspectionState.snapshot(), emphasis: structuredClone(context.emphasisState), labels: labelObjects });
  const context = vm.createContext({
    sourceRecord: {}, visibleStage: undefined, focusPivotRequest: undefined, gesturePivot: createGesturePivot(), xrPlacementFollowup: undefined,
    // The selection is drawn as the last layer of the lesson key's own
    // overpaint, so drawing it costs one emphasis pass. This harness is the one
    // that counts passes, so its stub pays that cost rather than hiding it.
    currentSelectionPlan: () => (state.selectionKeys.length ? { keys: [...state.selectionKeys], color: '#ff2dd4' } : undefined),
    async paintSelectionOverlay() { await context.paintEmphasisLayers(context.currentEmphasisPlan()); }, representationLayerRef, companionRecord:undefined, retiredComparisons:new Set(),
    async paintVisibilityLayers() {},
    restoreCompanion:async value=>{ if(value!==undefined) throw Error('This primary-only fixture does not carry a comparison.'); },
    paintCompanion:async()=>{},
    performance, now: () => performance.now(), structuredClone, console,
    geometryFor: () => ({ typeParams: {} }), geometryBudgetReceipt: () => undefined, geometryBudgetConfirmation: () => undefined,
    appliedGeometryBudget: undefined, stylesState: [], styleLayers: [],
    normalizeStyles, normalizeVisibility, foldCompanion, visibilityState: emptyVisibility(),
    restoreInspectionPayload() {},
    colorOnlyAppearanceChange, normalizeAppearance, normalizePlacement, sameAppearance, normalizeEmphasisState, compoundOps,
    state, inspectionState, representation, structure: { obj: { data: {} } }, volume: undefined,
    busy: false, inspectionLabel: undefined, emphasisOrigin: 'command', emphasisState: { parts: [], focus: [], contextOpacity: 0.18 },
    EMPHASIS_LAYER_REF: 'emphasis', SCENE_VISIBILITY_LAYER_REF: 'visibility',
    hiddenSceneKeys: () => [], builtRepresentation: 'cartoon', motionMutationPaused: false, motionToolPaused: false,
    selection: { rows, toLoci(keys) { if (keys.some(key => !valid.has(key))) throw Error('invalid_selection'); } },
    snapshot, inspectionSnapshot: () => inspectionState.snapshot(),
    inspectionPayload: () => ({ selectionKeys: [...state.selectionKeys], camera: { baseline: true } }),
    syncInspectionPayload() { inspectionState.setPayload(context.inspectionPayload()); },
    assertReady() { if (context.busy || state.status !== 'ready') throw Error('viewer_busy'); },
    assertContext() { if (context.canvas.webgl.isContextLost) throw Error('context_lost'); },
    failure: (code, message) => Object.assign(Error(message), { code }),
    interactionActive: () => false, syncPresentationMotion() {}, retainCurrent: () => ({}), beginWork: () => ({ finish() {} }),
    canvas: { webgl: { isContextLost: false }, reprCount: { value: 1 }, xr: { isPresenting: { value: false } },
      getRenderObjects: () => [marker], commit() { counts.commits++; }, setProps() {}, camera: { forceFull: false } },
    async waitForFrame() { counts.frames++; if (frameGate) await frameGate; if (failFrame) { failFrame = false; throw Error('frame_failed'); } },
    emit(callback, value) { callback(value); }, onMutation() { counts.publications++; },
    recordRenderCost: (...args) => diagnostics.push(args),
    plugin: { state: { data: { cells } }, representation: { structure: { registry: { get: () => ({ isApplicable: () => true }) } } } },
    findCurrentStructureRepresentation: () => representation, asViewerRepresentation: value => value,
    inspectionRepresentationName: value => { if (!['cartoon', 'ball-and-stick', 'molecular-surface'].includes(value)) throw Error('unsupported_representation'); return value; },
    representationName: value => value,
    lessonResting: { labelsEnabled: () => labelIntent, setLabelsEnabled: value => { labelIntent = value; } },
    lessonKey: { remember() {} }, currentEmphasisPlan: () => ({ colours: [], faded: [] }),
    componentLabelPlateParts: () => [], componentLabelsWanted: () => false,
    componentLabels: { refs: () => [], active: () => false },
    colorNumber: value => Number.parseInt(value.slice(1), 16),
    markSelection(keys) { counts.marks++; marker.values.tMarker.ref.version++; state.selectionKeys = [...keys]; },
    async rebuildInspectionLabels() {
      counts.residueLabels++;
      labelObjects = inspectionState.snapshot().appearance.labels ? state.selectionKeys.slice(0, 32).map(key => ({ key, text: `${key}:residue`, offsets: [1, 2, 3] })) : [];
      if (labelObjects.length) { context.inspectionLabel = { representation: { ref: 'label-repr' } }; cells.set('label-repr', { status: 'ok', obj: labelObjects, state: {}, transform: {} }); }
      else { context.inspectionLabel = undefined; cells.delete('label-repr'); }
    },
    async rebuildComponentLabels() { counts.componentLabels++; },
    async applyInspectionColorTheme() {
      const appearance = inspectionState.snapshot().appearance;
      cells.get(representation.ref).params.values.colorTheme = { name: appearance.color,
        params: { value: context.colorNumber(appearance.uniformColor) } };
    },
    async applyInspectionAppearance(options = {}) {
      counts.appearance++;
      const appearance = inspectionState.snapshot().appearance;
      const params = cells.get(representation.ref).params.values;
      params.type = { name: appearance.representation, params: { alpha: appearance.opacity } };
      params.colorTheme = { name: appearance.color, params: { value: context.colorNumber(appearance.uniformColor) } };
      context.builtRepresentation = appearance.representation;
      if (options.emphasis !== false) await context.paintEmphasisLayers();
      context.markSelection(state.selectionKeys);
      if (options.labels !== false) await context.rebuildInspectionLabels();
      if (options.componentLabels !== false) await context.rebuildComponentLabels();
    },
    applyInspectionTransform() {}, planLessonEmphasis: value => value, paintedContextOpacity: value => value,
    spokenSelectionKeys: () => [], recordEmphasisResolution() {},
    // The pass leaves its overpaint cell behind, because that cell is
    // what `inspectionLayersIntact` reads to decide the key and the selection
    // are still on the molecule. A stub that counted and built nothing made
    // every intact scene look torn once a selection existed.
    async paintEmphasisLayers() {
      counts.emphasis++;
      const ref = `${representationLayerRef(representation, 'emphasis')}-colour`;
      if (!cells.get(ref)) cells.set(ref, { obj: emphasisOverpaint, status: 'ok', state: {}, transform: {} });
    },
    completeInspectionCapture: snapshot,
    async restoreInspection(before) { counts.restores++; inspectionState.replace(before.inspection); state.selectionKeys = before.selectionKeys; context.emphasisState = before.emphasis; await context.rebuildInspectionLabels(); },
    applyImmersiveDepth() {}, lastDepthMinFar: 0,
  });
  const selected = source.includes('  let settledSelectionLayers;')
    ? section(source, '  let settledSelectionLayers;', '\n  async function focus(')
    : section(source, '  async function select(keys)', '\n  async function focus(');
  const code = [
    section(source, '  async function inspectionMutation(', '\n  function restoreInspectionPayload('),
    section(source, '  async function mutate(', '\n  function selectedKeys('),
    section(source, '  function selectedKeys(', '\n  function markSelection('),
  ];
  // A baseline has no dedupe comment; delimit the setter by its closing function.
  const setter = source.slice(source.indexOf('  async function setRepresentation('), source.indexOf('\n  }', source.indexOf('  async function setRepresentation(')) + 4);
  code.splice(3, 1, setter, selected);
  code.push(...['cancelXrPlacementFollowup', 'invalidateGesturePivot'].filter(name => source.includes(`function ${name}(`)).map(name => pageFunction(source, name)));
  code.push(section(source, '  async function configureInspection(', source.includes('  async function applyCompoundInspection(') ? '\n  async function applyCompoundInspection(' : '\n  async function placeInspection('));
  if (source.includes('  async function applyCompoundInspection(')) code.push(section(source, '  async function applyCompoundInspection(', '\n  async function placeInspection('));
  vm.runInContext(code.join('\n') + '\nglobalThis.api = { select, setRepresentation, configureInspection, mutate' + (source.includes('  async function applyCompoundInspection(') ? ', compound: applyCompoundInspection' : '') + ' };', context);
  if (!context.api.compound) context.api.compound = change => applyCompoundChange(change, {
    appearance: context.api.configureInspection,
    selection: patch => context.api.select(patch.selectionKeys),
    placement: patch => context.api.mutate('inspection', () => { context.syncInspectionPayload(); inspectionState.place(patch, 'place'); }),
    emphasis: async patch => { await context.api.mutate('representation', () => context.paintEmphasisLayers()); context.emphasisState = normalizeEmphasisState(patch); await context.rebuildComponentLabels(); },
  }, { begin: () => { const checkpoint = inspectionState.checkpoint(); inspectionState.beginGroup('agent-compound'); return checkpoint; }, end: () => inspectionState.endGroup(), rollback: checkpoint => inspectionState.restoreCheckpoint(checkpoint) });
  return { ...context.api, counts, state, context, rows, cells, marker, diagnostics, snapshot,
    labels: () => labelObjects, failFrame: () => { failFrame = true; },
    gateFrame(promise) { frameGate = promise; }, resetCounts() { for (const key of Object.keys(counts)) counts[key] = 0; } };
}

export async function benchmark(source) {
  const result = {};
  for (const scenario of ['same-selection', 'same-representation', 'compound-final-look']) {
    const h = harness(source, { rowCount: 4096 });
    h.context.inspectionState.configure({ labels: true });
    const keys = h.rows.slice(0, 32).map(row => row.key);
    await h.select(keys);
    h.resetCounts();
    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      if (scenario === 'same-selection') await h.select([...keys].reverse());
      if (scenario === 'same-representation') await h.setRepresentation('cartoon');
      if (scenario === 'compound-final-look') await h.compound({ patch: { ops: [
        { kind: 'appearance', patch: { opacity: i % 2 ? 0.5 : 0.6 } },
        { kind: 'placement', patch: { scale: i % 2 ? 1 : 2 } },
        { kind: 'selection', patch: { selectionKeys: keys } },
        { kind: 'emphasis', patch: { parts: [{ id: 'rna', label: 'RNA', chain: 'A', color: '#ffaa33' }], focus: ['rna'], contextOpacity: 0.18 } },
      ] } });
    }
    result[scenario] = { requests: 100, rows: 4096, selected: 32, totalMs: Number((performance.now() - start).toFixed(3)), ...h.counts };
  }
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv.includes('--benchmark')) {
  const baselineIndex = process.argv.indexOf('--baseline');
  const baseline = baselineIndex < 0 ? undefined : readFileSync(process.argv[baselineIndex + 1], 'utf8');
  console.log(JSON.stringify({ note: 'Node VM production-function harness; Mol* geometry, labels and frame delivery mocked. Timings are harness CPU costs, not device latency.', ...(baseline ? { before: await benchmark(baseline) } : {}), after: await benchmark(viewerSource) }, null, 2));
}
