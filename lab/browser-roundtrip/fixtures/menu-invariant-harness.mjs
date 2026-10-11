import { Worker } from 'node:worker_threads';
import { fitAppearanceInWorker } from '../appearance-fit.mjs';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { resetViewPlacement } from '../reset-view-placement.mjs';
import { captionText } from '../talk-caption.mjs';
import { Mat4 } from 'molstar/lib/mol-math/linear-algebra.js';
import { placementFitWithinEnvelope } from '../placement-fit-envelope.mjs';
import { resetEntryGeometry } from '../reset-entry-geometry.mjs';
import { normalizePlacement } from '../inspection-state.mjs';
import { createGesturePivot } from '../gesture-pivot.mjs';
import { checkDrawnRecord, drawnRecordIsVisible } from '../drawn-record.mjs';
import { identity, syntheticViews } from './component-label-diagnostics.mjs';

const source = readFileSync(new URL('../viewer.mjs', import.meta.url), 'utf8');
export function viewerFunction(name) {
  const start = source.search(new RegExp(`  (?:async )?function ${name}\\(`));
  if (start < 0) throw Error(`Missing viewer function ${name}`);
  const firstLine = source.slice(start, source.indexOf('\n', start));
  if (firstLine.trimEnd().endsWith('}')) return firstLine;
  return source.slice(start, source.indexOf('\n  }', start) + 4);
}
const cell = value => ({ ref: { value } });
const transform = p => {
  const m = identity(); m[0] = m[5] = m[10] = p.scale;
  m.splice(12, 3, ...p.translation); return m;
};
const positions = half => [-half, half].flatMap(x => [-.2, .2].flatMap(y => [-.1, .1].flatMap(z => [x, y, z])));

/** Production appearance, entry, transaction and draw gates. Only the Mol* GPU
 * and state-tree adapters are synthetic; fitter and stereo extraction are real. */
export function realAppearanceWorker() {
  const worker = new Worker(`const { parentPort } = require('node:worker_threads');
    import(${JSON.stringify(new URL('../appearance-fit-worker.mjs', import.meta.url).href)}).then(({solveAppearanceFit}) =>
      parentPort.on('message', data => { try { parentPort.postMessage({fitted: solveAppearanceFit(data)}); }
      catch (error) { parentPort.postMessage({error: error.message}); } }));`, { eval: true });
  const adapter = { terminate: () => worker.terminate(), postMessage: (data, transfers) => worker.postMessage(data, transfers) };
  worker.on('message', data => adapter.onmessage({ data })); worker.on('error', error => adapter.onerror(error));
  return adapter;
}

export function menuInvariantHarness({ held = false, half = .1, vertices, workerOptions = {}, productionRecovery = false } = {}) {
  let placement = { translation: [0, 0, -1], scale: 1, rotation: [0, 0, 0] };
  let geometryReads = 0, fits = 0, id = 0;
  const captionState = {};
  const events = [], live = new Set(), cells = new Map(), draws = new Set();
  const make = (name, width, hidden = false) => {
    const object = { type: 'mesh', state: { visible: !hidden }, values: {
      aPosition: cell(vertices ?? positions(width)), aTransform: cell(transform(placement)),
      drawCount: cell(36), instanceCount: cell(1),
    } };
    const repr = { state: { visible: !hidden }, renderObjects: [object] };
    const result = { ref: name, checkValid() {}, obj: { data: { repr } },
      cell: { transform: { parent: 'structure' }, params: { values: { type: { name: 'cartoon', params: { alpha: 1 } } } } },
      update(params) { this.cell.params.values = params; return { commit: async () => {} }; } };
    cells.set(name, result); live.add(repr); return result;
  };
  const base = make('base', half);
  const structure = { checkValid() {}, obj: { data: { elementCount: 8 } } };
  const h = vm.createContext({ structuredClone, setTimeout, clearTimeout, performance, console,
    fitAppearanceInWorker: async (options, policy) => { geometryReads++; fits++; events.push('extract', 'fit');
      return fitAppearanceInWorker(options, { ...policy, makeWorker: realAppearanceWorker, ...workerOptions }); },
    resetEntryGeometry: options => { geometryReads++; events.push('extract'); return resetEntryGeometry(options); },
    resetViewPlacement: options => { fits++; events.push('fit'); return resetViewPlacement(options); },
    Mat4, placementFitWithinEnvelope, lastPlacementFitEvidence: undefined, normalizePlacement, checkDrawnRecord, drawnRecordIsVisible,
    representation: base, structure, volume: null, styleLayers: [], ligandOverlay: undefined, companionRecord: undefined,
    lessonFigure: { snapshot: () => null, placement: () => [], refresh: async () => {}, forget: async () => {}, drawn: () => true,
      molecular: () => [], annotations: () => [], count: () => 0 },
    companionRecoveryActive: false, companionRecoveryPendingXr: false,
    inspectionLabel: undefined, retainedRepresentationCount: 0, xrPresentationRepresentationCount: 0,
    retainedPoseHidden: false, retainedEntryCheckPending: false, retainedEntryCheck: undefined, activeWork: undefined, placementViewWaiters: new Set(),
    builtRepresentation: 'cartoon', appliedGeometryBudget: null,
    state: { status: 'ready', generation: 1, drawCount: 0, revision: 0, mutationCounts: { inspection: 0 }, selectionKeys: [] },
    xrPlacementFollowup: undefined, focusPivotRequest: undefined, gesturePivot: createGesturePivot(),
    grabRotation: undefined, grabScale: 1, grabOffset: undefined,
    xrManipulation: undefined, xrThumbstick: undefined, xrPushStick: undefined, xrDeferredGrab: undefined, xrDeferredBake: undefined,
    latestRoomPlacementPose: { headInRoom: identity(), renderFromRoom: identity(), labelViews: syntheticViews() },
    latestHeadSample: performance.now(), loadedSphere: () => ({ center: [0, 0, 0], radius: 1 }),
    inspectionSnapshot: () => ({ placement: structuredClone(placement), appearance: { representation: 'cartoon', color: 'chain-id', opacity: 1, clipping: 0 } }),
    inspectionState: { checkpoint: () => productionRecovery ? { current: {}, placement: structuredClone(placement) } : structuredClone(placement),
      restoreCheckpoint: p => { placement = p.placement ?? p; }, payload: () => null,
      place(p) { placement = { ...placement, ...p }; events.push('place'); } },
    placementTransform: transform, presentationTransform: () => transform(placement),
    wearerPlacement: { holdsPlacement: () => held }, wearerPlacedInRoom: held,
    immersiveSession: { dispose() {}, platePoints: () => [-.8, -.3].flatMap(x => [-.8, .8].map(y => [x, y, -1])), syncBounds() {} },
    recordManipulation: (kind, detail) => events.push({ kind, ...detail }), talkCaption: { set(detail) { events.push(detail); Object.assign(captionState, detail); } },
    assertReady() {}, assertContext() {}, syncInspectionPayload() {}, restoreInspectionPayload() {}, setInspectionMotion: async () => {},
    notePlacement() {}, releaseWearerPlacement() {}, componentLabels: { active: () => false },
    pendingRoomSeat: true, roomAnchor: null, roomEntry: {}, settlingRoomAnchor: null, adoptionGeneration: 0,
    appearanceWork: undefined, busy: false, interactionActive: () => false, rebuildComponentLabels: async () => {},
    motionMutationPaused: false, motionToolPaused: false, syncPresentationMotion() {},
    now: () => performance.now(), beginWork: () => ({ finish() {} }), recordRenderCost() {}, snapshot: () => ({ placement }), emit() {}, onMutation() {},
    retainCurrent: () => ({ structure, representation: h.representation }), frameWaiters: new Set(),
    XR_FRAME_TIMEOUT_MS: 100, FRAME_TIMEOUT_MS: 100,
    failure: (code, message) => Object.assign(Error(message), { code }),
    inspectionRepresentationName() {}, INSPECTION_COLORS: new Set(['chain-id']),
    representationForBudget: name => name, sessionDeviceClass: () => 'quest2', currentXrSession: () => ({}), structureAtomSites: () => 8,
    xrRepresentationQuality: () => null, xrRepresentationMaterial: () => null, xrColorParams: () => null, xrBallAndStickParams: () => ({}),
    geometryFor: () => ({ typeParams: {} }), geometryBudgetReceipt: () => null,
    createStructureRepresentationParams: (_plugin, _structure, params) => ({ type: { name: params.type, params: params.typeParams } }),
    Color: x => x, colorNumber: () => 0, VISIBILITY_LAYER_REF: {},
    paintCompanion: async () => {}, rebuildLigandOverlay: async () => {}, ligandOverlayForBudget: () => null, ligandAtomSites: () => 0,
    currentEmphasisPlan: () => null, currentSelectionPlan: () => null, paintVisibilityLayers: async () => {},
    markSelection() {}, rebuildInspectionLabels: async () => {}, recordCost() {},
    commitRepresentationUpdate: builder => builder.commit(),
    styleLayerPlans: () => [{ keys: ['A'], loci: { structure: {} }, look: { representation: 'surface', color: 'chain-id', opacity: 1 }, geometry: { typeParams: {} }, data: { elementCount: 8 } }],
    StructureSelection: { Singletons() {} }, StructureElement: { Loci: { toStructure() {} } },
  });
  const canvas = h.canvas = {
    xr: { isPresenting: { value: true } }, webgl: { xr: { session: {} }, isContextLost: false },
    camera: { scale: 1, getSnapshot: () => ({}), setState() {} },
    reprCount: { get value() { return live.size; } }, commitQueueSize: { value: 0 },
    add(repr) { events.push('reveal'); live.add(repr); }, remove(repr) { events.push('hide'); live.delete(repr); },
    commit() {}, setProps() {}, getRenderObjects: () => [...live].flatMap(repr => repr.renderObjects),
    didDraw: { subscribe(fn) { draws.add(fn); return { unsubscribe: () => draws.delete(fn) }; } },
    requestDraw() { queueMicrotask(() => { h.state.drawCount++; events.push('draw'); for (const fn of [...draws]) fn(); }); },
  };
  h.plugin = { state: { data: { cells,
    updateCellState(ref, state) {
      const repr = cells.get(ref).obj.data.repr;
      repr.state.visible = !state.isHidden;
      for (const object of repr.renderObjects) object.state.visible = !state.isHidden;
      events.push(state.isHidden ? 'hide-cell' : 'reveal-cell');
    } } },
    build: () => ({ delete(ref) { return { commit: async () => {
      for (const [key, value] of cells) if (key === ref || key.startsWith(ref + '-')) { live.delete(value.obj.data.repr); cells.delete(key); }
    } }; } }),
    builders: { structure: { tryCreateComponentFromSelection: async () => {
      const component = { ref: `component-${++id}`, obj: { data: {} } };
      cells.set(component.ref, component); return component;
    },
      representation: { addRepresentation: async (component, props, options) => {
        if (h.canvas.xr.isPresenting.value && !options?.initialState?.isHidden) throw Error('Scoped geometry was created visible');
        const hidden = Boolean(options?.initialState?.isHidden);
        events.push(hidden ? 'build-hidden' : 'build-visible'); return make(component.ref + '-repr', .7, hidden);
      } } } },
  };
  h.applyInspectionTransform = () => {
    for (const repr of h.scientificRepresentations(true)) for (const object of repr.renderObjects) object.values.aTransform.ref.value = transform(placement);
    events.push('transform');
  };
  h.scientificRepresentationCount = () => h.scientificRepresentations(true).length;
  for (const name of ['cancelXrPlacementFollowup', 'invalidateGesturePivot', 'capturePlacementFitEvidence', 'scientificRepresentations', 'clearHeldPlatePlacement', 'hideRetainedPose', 'supersedePlacementFit', 'showRetainedPose', 'checkRetainedEntryPose',
    'awaitPlacementViews', 'rejectPlacementViews', 'dispose', 'beginRoomEntry', 'waitForFrame', 'mutate', 'seatStructureForEntry', 'placeInspection', 'settleInRoom',
    'restoreCompanion', 'rebuildStyleLayers', 'applyInspectionAppearance']) vm.runInContext(viewerFunction(name), h);
  if (source.includes('function retainedFitObjects(')) vm.runInContext(viewerFunction('retainedFitObjects'), h);
  // Exercise the complete production disposal function; only platform owners
  // are inert. A missing rejectPlacementViews in dispose leaves real waits live.
  Object.assign(h, { disposePromise: undefined, recoveryPromise: undefined, disposedSnapshot: undefined,
    workbenchHandoff: undefined, activeLoad: undefined, xrPreview: undefined,
    detachSpatialTour: undefined, spatialTour: undefined, detachVoiceInteraction: undefined, voiceInteraction: undefined,
    detachSpatialMenuHook: undefined, detachSpatialAimHook: undefined, reducedMotionQuery: undefined,
    sourceRecord: { sha256: 'fixture' }, dataRoot: undefined, selection: undefined, visibleStage: undefined, recoveryRecord: undefined,
    stopPresentationMotion() {}, removeFrameCover() {}, removeInspectionLabels() {}, removeLigandOverlay() {}, removeComponentLabels() {},
    drawSubscription: { unsubscribe() {} }, pickSubscription: { unsubscribe() {} }, restoredSubscription: { unsubscribe() {} },
    interactionSubscriptions: [], document: { removeEventListener() {} }, element: { removeEventListener() {} }, window: { removeEventListener() {} },
    visibilityChange() {}, mouseDown() {}, touchChange() {}, wheelInput() {}, keyInput() {}, mouseUp() {}, endInteraction() {}, contextLost() {},
    GROWTH_CAPTION_EVENT: 'unused', onHostGrowthCaption() {},
  });
  Object.assign(h.plugin, { animationLoop: { stop() {} }, clear() {}, dispose() {} });
  h.comparisonSources = new Map([['synthetic:1', {}]]);
  h.checkedFixture = async () => ({ source: {}, settings: {} });
  h.candidateRecords = new Set(); h.retiredComparisons = new Set();
  h.detached = structuredClone; h.comparisonGeometry = () => [];
  h.buildCandidate = async () => {
    const candidate = { representation: make('companion', .7, true), structure };
    h.candidateRecords.add(candidate); return candidate;
  };
  h.deleteRecord = async record => canvas.remove(record.representation.obj.data.repr);
  if (productionRecovery) {
    base.cell.status = 'ok'; base.cell.obj = base.obj;
    cells.set(base.ref, base.cell);
    for (const name of ['assertContext', 'assertReady', 'recoverStaleAppearanceFit', 'inspectionMutation', 'restoreJourneySeat'])
      vm.runInContext(viewerFunction(name), h);
    h.inspectionMutationSettlement = undefined;
    h.cameraSnapshot = camera => camera;
    h.restoreTourSeat = async () => {};
    h.recordJourneySeat = () => {};
  } else h.inspectionMutation = operation => h.mutate('inspection', operation);
  h.roomAnchorPlacement = () => {
    // The actual entry fitter consumes the same synthetic geometry/eyes.
    return resetViewPlacement({ seat: placement, fit: true, points: h.immersiveSession.platePoints(),
      ...h.latestRoomPlacementPose, cameraScale: 1, center: [0, 0, 0], radius: 1,
      geometry: { objects: productionRecovery && h.retainedPoseHidden && h.retainedFitObjects ? h.retainedFitObjects()
        : h.scientificRepresentations().flatMap(r => r.renderObjects), fromPlacement: transform(placement),
        toPlacement: transform(placement), views: syntheticViews() } });
  };
  return { h, events, live, base, caption: () => captionText(captionState), placement: () => structuredClone(placement),
    reads: () => geometryReads, fits: () => fits,
    appearance: () => h.mutate('inspection', () => h.applyInspectionAppearance()),
    hide() { for (const repr of h.scientificRepresentations()) canvas.remove(repr); h.retainedPoseHidden = true; },
  };
}
