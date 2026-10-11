import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { PluginContext } from 'molstar/lib/mol-plugin/context.js';
import { DefaultPluginSpec } from 'molstar/lib/mol-plugin/spec.js';
import { StateTransforms } from 'molstar/lib/mol-plugin-state/transforms.js';
import { BoundaryHelper } from 'molstar/lib/mol-math/geometry/boundary-helper.js';
import { Camera as MolstarCamera } from 'molstar/lib/mol-canvas3d/camera.js';
import { ModelSymmetry } from 'molstar/lib/mol-model-formats/structure/property/symmetry.js';
import { Task } from 'molstar/lib/mol-task/task.js';
import { MolScriptBuilder } from 'molstar/lib/mol-script/language/builder.js';
import { createStructureRepresentationParams } from 'molstar/lib/mol-plugin-state/helpers/structure-representation-params.js';
import { createInspectionState } from '../inspection-state.mjs';
import { createGesturePivot } from '../gesture-pivot.mjs';
import { pageFunction } from './label-action-harness.mjs';
import { createSelectionAdapter } from '../selection.mjs';
import { experienceVisibilityExpression } from '../experience-visibility.mjs';
import { preserveSourceTransitionAnchor } from '../source-transition-anchor.mjs';
import { runTransitionTask, prepareRepresentationUploads } from '../scene-transition.mjs';
import { beginSceneTransition } from '../xr-render-budget.mjs';
import { cameraSnapshot } from '../camera-snapshot.mjs';
import { checkDrawnRecord, drawnRecordIsVisible } from '../drawn-record.mjs';
import { requireGeometryBudget, structureGeometryCounts, geometryBudgetReceipt } from '../representation-budget.mjs';

const source = readFileSync(new URL('../viewer.mjs', import.meta.url), 'utf8');
const clone = value => structuredClone(value);
const noop = () => {};
function install(context, name) {
  const start = source.search(new RegExp(`  (?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  vm.runInContext(source.slice(start, source.indexOf('\n  }', start) + 4), context);
}

/** Production source staging, Mol* parsing/geometry and frame validation.
 * The source-fit path uses Mol*'s real BoundaryHelper and Camera math. Canvas
 * submission/reset application and the XR scheduler are adapters; no GPU/device
 * draw is claimed.
 * The spatial toolbar uses its own presentation scene, as in immersive-ar.
 */
export async function sourceLoadHarness(initialSource, initialScene, record = noop) {
  const document = globalThis.document;
  globalThis.document = { addEventListener: noop, removeEventListener: noop,
    createElement: () => ({ setAttribute: noop }), head: { appendChild: noop, removeChild: noop } };
  const plugin = new PluginContext(DefaultPluginSpec());
  try { await plugin.init(); } finally { globalThis.document = document; }
  const representations = new Set(), subscribers = new Set(), frames = [], writes = [];
  const session = { environmentBlendMode: 'alpha-blend', frameRate: 72 };
  const inspectionState = createInspectionState();
  const cameraState = clone(initialScene.camera);
  const focusCamera = new MolstarCamera(cameraState);
  let framePending = false, disposed = false, holdDraw = false;
  const canvas = {
    xr: { isPresenting: { value: false } }, webgl: { isContextLost: false, xr: { session } },
    camera: { scale: 1, getSnapshot: () => clone(cameraState),
      setState(value, durationMs) {
        writes.push(clone(value)); Object.assign(cameraState, clone(value)); focusCamera.setState(value, durationMs ?? 0);
      },
      getFocus: (...args) => focusCamera.getFocus(...args),
      getInvariantFocus: (...args) => focusCamera.getInvariantFocus(...args),
    },
    add: repr => { representations.add(repr); }, remove: repr => { representations.delete(repr); },
    update: noop, syncVisibility: noop, mark: noop, commit: noop, requestCameraReset: noop,
    getRenderObjects: () => [...new Set([...representations].flatMap(repr => repr.renderObjects))],
    reprCount: { get value() { return representations.size; } }, commitQueueSize: { value: 0 },
    didDraw: { subscribe(callback) { subscribers.add(callback); return { unsubscribe: () => subscribers.delete(callback) }; } },
    requestDraw() {
      if (framePending || disposed || holdDraw) return;
      framePending = true;
      setImmediate(() => {
        framePending = false;
        if (disposed || holdDraw) return;
        c.state.drawCount++;
        frames.push([...representations].filter(repr => repr.state.visible));
        for (const callback of [...subscribers]) callback();
      });
    },
  };
  plugin.canvas3d = canvas;
  const c = vm.createContext({
    console, crypto, Error, setTimeout, clearTimeout, performance, structuredClone,
    plugin, canvas, Task, StateTransforms, BoundaryHelper, ModelSymmetry, MolScriptBuilder, createSelectionAdapter,
    experienceVisibilityExpression, preserveSourceTransitionAnchor, runTransitionTask, prepareRepresentationUploads,
    createStructureRepresentationParams, cameraSnapshot, checkDrawnRecord, drawnRecordIsVisible, geometryBudgetReceipt,
    __stereofoldDiagnostics: { record },
    beginSceneTransition: options => beginSceneTransition({ ...options, record }),
    now: () => performance.now(), detached: clone,
    failure: (code, message) => Object.assign(Error(message), { code }),
    state: { status: 'empty', generation: 0, revision: 0, drawCount: 0, contextLossCount: 0, loadCount: 0, mutationCounts: { load: 0 }, selectionKeys: [] },
    appearanceWork: undefined, busy: false, activeLoad: undefined, activeWork: undefined, pendingContextLoss: undefined, nextTest: {}, frameWaiters: new Set(),
    gesturePivot: createGesturePivot(), focusPivotRequest: undefined, xrPlacementFollowup: undefined,
    inspectionState, motionMutationPaused: false, motionToolPaused: false, motionAngle: 0,
    desktopPreviewCamera: undefined, orientationReference: undefined, pendingGrowthTurn: false,
    candidateRecords: new Set(), retainedRepresentationCount: 0, styleLayers: [], companionRecord: undefined,
    lessonFigure: { drawn: () => true }, // This fixture has no lesson annotations.
    volume: undefined, volumeIsoExtent: undefined, representation: undefined, structure: undefined, sourceRecord: undefined,
    inspectionLabel: undefined, ligandOverlay: undefined, xrPresentationRepresentationCount: 0,
    XR_FRAME_TIMEOUT_MS: 15000, FRAME_TIMEOUT_MS: 15000,
    currentXrSession: () => canvas.xr.isPresenting.value ? session : undefined,
    checkedFixture: async (source, settings) => ({ source, settings }),
    interactionActive: () => false, syncPresentationMotion: noop,
    coverCurrentFrame: noop, removeFrameCover: noop, removeInspectionLabels: noop, removeLigandOverlay: noop, removeComponentLabels: noop,
    assertContext: noop, assertLoad(operation) { if (operation.cancelled) throw operation.cancelled; },
    checkpoint: async (_operation, phase) => { if (c.failAt === phase) throw Error(`Injected ${phase} failure`); },
    markRecord: noop, catalogVisibleBounds: () => undefined,
    selectedKeys: keys => [...keys],
    geometryFor: (representation, data) => requireGeometryBudget({ representation, ...structureGeometryCounts(data), presenting: canvas.xr.isPresenting.value, deviceClass: 'quest2', quality: 'low' }),
    xrRepresentationQuality: () => 'low', xrRepresentationMaterial: () => undefined, xrColorParams: () => undefined, xrBallAndStickParams: () => ({}),
    scientificRepresentationCount: () => 1 + c.retainedRepresentationCount,
    immersiveSession: { syncBounds: noop },
    inspectionSnapshot: () => inspectionState.snapshot(),
    adopt(value) {
      c.current = value; c.structure = value?.structure; c.representation = value?.representation; c.sourceRecord = value?.source;
      c.state.sourceSha256 = value?.source.sha256; c.state.selectionKeys = [...(value?.selectionKeys ?? [])];
    },
    retainCurrent: () => c.current ? { ...c.current, inspection: c.liveScene(), styles: [], visibility: {},
      styleLayers: [], selectionKeys: [...c.state.selectionKeys] } : undefined,
    async deleteRecord(value) { if (value?.rootRef && plugin.state.data.cells.has(value.rootRef)) await plugin.state.data.build().delete(value.rootRef).commit(); },
    applyInspectionAppearance: async () => { c.current?.representation?.obj?.data?.repr.setState({ visible: true }); },
    normalizeStyles: value => value, normalizeVisibility: value => value,
    recordRenderCost: noop, onMutation: noop, emit: noop,
    snapshot: () => ({ ...c.liveScene(), ready: c.state.status === 'ready', xrPresenting: canvas.xr.isPresenting.value,
      drawCount: c.state.drawCount, inspection: inspectionState.snapshot() }),
  });
  for (const name of ['cancelXrPlacementFollowup', 'invalidateGesturePivot']) vm.runInContext(pageFunction(source, name), c);
  for (const name of ['asViewerRepresentation', 'liveScene', 'beginWork', 'transitionGuard', 'commitRepresentationUpdate',
    'buildTransitionCell', 'buildCandidate', 'yieldUploadFrame', 'prepareUploads', 'recordBoundingSphere', 'transitionBounds',
    'transitionRoomAnchor', 'setXrCameraScale', 'waitForFrame', 'showCandidate', 'restoreRecord', 'rollbackLoad', 'load']) install(c, name);
  try {
    await c.load(initialSource, { modelNumber: initialScene.modelNumber, assemblyId: initialScene.assemblyId });
    inspectionState.place(initialScene.inspection.placement, 'fixture');
    canvas.xr.isPresenting.value = true; canvas.camera.scale = .02;
  } catch (error) { plugin.canvas3d = undefined; plugin.dispose(); throw error; }
  return {
    context: c, canvas, session, frames, writes,
    load: (next, options = {}) => c.load(next, { modelNumber: next.catalog.modelNumbers[0], assemblyId: next.catalog.assemblyId,
      preserveRoomPlacement: true, ...options }),
    snapshot: c.snapshot,
    holdFrames(value) { holdDraw = value; if (!value) canvas.requestDraw(); },
    dispose() { disposed = true; plugin.canvas3d = undefined; plugin.dispose(); },
  };
}
