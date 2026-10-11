import { createAgentPlacementHistory } from '../agent-placement-history.mjs';
import { focusResidues } from '../focus-residues.mjs';
import { realAppearanceWorker } from './menu-invariant-harness.mjs';
import { placementFitWithinEnvelope } from '../placement-fit-envelope.mjs';
import { fitAppearanceInWorker } from '../appearance-fit.mjs';
import { createSelectionBoundsCache } from '../selection-bounds.mjs';
import { normalizeStyles } from '../inspection-styles.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { Euler } from 'molstar/lib/mol-math/linear-algebra/3d/euler.js';
import * as emphasis from '../lesson-emphasis.mjs';
import { focusPlacement, focusTravel } from '../focus-placement.mjs';
import { pointRange } from '../plate-standoff.mjs';
import { EYE_TAN_HALF_HORIZONTAL, EYE_TAN_HALF_VERTICAL } from '../spatial-toolbar-geometry.mjs';
import { normalizePlacement } from '../inspection-state.mjs';
import { clampPlacementScale, clampPlacementTranslation } from '../placement-limits.mjs';
import { pivotPreservingTranslation } from '../presentation-pivot.mjs';
import { createGesturePivot } from '../gesture-pivot.mjs';
import { labelHarness, pageFunction } from './label-action-harness.mjs';
import { applyMatrix4 } from '../room-lock.mjs';
import { resetEntryGeometry } from '../reset-entry-geometry.mjs';
import { resetViewPlacement } from '../reset-view-placement.mjs';
import { createPlacementHold } from '../wearer-placement.mjs';
// The real hidden-set reader, so a plate the harness keeps is a
// plate the production rule would have kept. Nothing is hidden in these fixtures.
import { emptyVisibility, hiddenRowKeys, normalizeVisibility } from '../inspection-visibility.mjs';
import { placementNoteFor } from '../placement-report.mjs';
import { syntheticViews } from './component-label-diagnostics.mjs';
import { viewerCallback } from './viewer-callback.mjs';

// Like menu-device-regression: execute complete viewer closures, adapting only
// rendering, selection bounds and the frame clock. The emphasis policy, focus
// solver, travel, placement bake and final molecular transform are real.
export function tourFocusHarness({ labels = false } = {}) {
  const source = readFileSync(process.env.OVERPRINT_VIEWER_BASELINE ?? new URL('../viewer.mjs', import.meta.url), 'utf8');
  const sphere = { center: [0, 0, 0], radius: 100 };
  const target = { center: [12, 0, 0], radius: 69.282 };
  const head = Array.from(Mat4.identity());
  head[13] = 1.1;
  // Acceptance 3 #365's expanded menu, expressed in the tracked head's lens.
  const menu = [[-.872, -.689], [-.162, -.689], [-.872, .319], [-.162, .319]]
    .map(([x, y]) => [x * EYE_TAN_HALF_HORIZONTAL, head[13] + y * EYE_TAN_HALF_VERTICAL, -1]);
  let placement = { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 }, now = 0;
  const records = [], writes = [], paints = [];
  const hold = createPlacementHold({ now: () => now });
  const snapshot = () => ({ ready: true, xrPresenting: true, atomCount: 100,
    selectionKeys: [], appearance: { highlightColor: '#ffffff' }, placement: structuredClone(placement) });
  const forbidden = () => assert.fail('XR tour must not request a desktop camera operation');
  const labelView = labels ? labelHarness() : null;
  const h = labelView?.h ?? vm.createContext({});
  Object.assign(h, { focusResidues, clampPlacementScale, clampPlacementTranslation, placementFitWithinEnvelope, fitAppearanceInWorker: (options, policy) => fitAppearanceInWorker(options, { ...policy, makeWorker: realAppearanceWorker }), placementViewWaiters: new Set(), lastPlacementFitEvidence: undefined, resetEntryGeometry, ...emphasis, Mat4, Vec3, Euler, normalizePlacement,
    AbortController, setTimeout, clearTimeout,
    sourceRecord: h.sourceRecord ?? {}, visibleStage: undefined, gesturePivot: createGesturePivot(), focusPivotRequest: undefined,
    xrPlacementFollowup: undefined,
    pivotPreservingTranslation, focusPlacement, pointRange, resetViewPlacement,
    focusTravel: options => focusTravel({ ...options, now: () => now, defer() {} }),
    scheduleViewFrame: callback => { now += 500; callback(); },
    performance: { now: () => now },
    now: () => now,
    LESSON_FRAMING_TRAVEL_MS: 1000,
    latestHeadSample: 0, latestRoomPlacementPose: { headInRoom: head,
      renderFromRoom: Array.from(Mat4.identity()), labelViews: syntheticViews() },
    // The real sentence minter and the two page
    // variables it writes, so a cut `notePlacement`, `seatStructureForEntry` or
    // `placeRoomTarget` runs the shipped code rather than a stub.
    placementNoteFor, placementNote: null, entryRoomPoint: null,
    pendingGrowthTurn: false, enableXr: true, volume: null, structure: {},
    canvas: { camera: { scale: .01 }, xr: { isPresenting: { value: true } }, webgl: { isContextLost: false, xr: { session: {} } } },
    loadedSphere: () => sphere, recordBoundingSphere: () => sphere,
    scientificRepresentations: () => [], presentationTransform: () => Array.from(Mat4.identity()),
    lessonFigure: { snapshot: () => null, annotations: () => [] }, // No layered illustration in this fixture.
    selection: { rows: ['B', 'C'].map(key => ({ key, coordinateState: 'resolved', atomSites: [{}] })), toLoci: () => target },
    componentLabelBounds: createSelectionBoundsCache(loci => loci),
    StructureElement: { Loci: { isEmpty: () => false, getBoundingSphere: loci => loci }, Bundle: { fromLoci: loci => loci } },
    selectedKeys: keys => keys, spokenSelectionKeys: ({ chain }) => [chain],
    select: async () => {}, focus: forbidden, fitInspection: forbidden,
    setInspectionMotion: async () => {},
    inspectionSnapshot: snapshot, snapshot,
    inspectionState: {
      placement: () => structuredClone(placement),
      place(patch, action) { writes.push({ action, patch: structuredClone(patch) }); placement = { ...placement, ...patch }; },
      checkpoint: () => structuredClone(placement), restoreCheckpoint: value => { placement = value; },
    },
    inspectionMutation: async operation => { await operation(); return snapshot(); },
    mutate: async (_kind, operation) => operation(), syncInspectionPayload() {}, assertReady() {},
    applyInspectionTransform() {}, busy: false, state: { status: 'ready', generation: 1, selectionKeys: [] },
    grabRotation: null, grabOffset: null, grabScale: 1,
    xrManipulation: undefined, xrThumbstick: undefined, xrPushStick: undefined, xrDeferredGrab: undefined, xrDeferredBake: undefined,
    pivotBounds: () => ({ baseCenter: sphere.center, visibleCenter: sphere.center, radius: sphere.radius }),
    pivotCenter: () => sphere.center,
    wearerPlacement: hold, agentPlacementHistory: createAgentPlacementHistory({ hold, context: () => ({ session: h.canvas.xr.isPresenting.value ? h.canvas.webgl.xr.session : undefined, source: 'fixture' }) }), lastLessonChapterKey: null,
    emphasisState: { parts: [], focus: [] }, emphasisOrigin: 'resting',
    paintedContextOpacity: value => value, paintEmphasisLayers: plan => paints.push(plan),
    paintVisibilityLayers: async () => {},
    visibilityState: emptyVisibility(), normalizeStyles, stylesState: [], styleLayers: [], emptyVisibility, normalizeVisibility,
    hiddenSceneKeySet: () => new Set(hiddenRowKeys([{ key: 'B' }, { key: 'C' }], h.visibilityState, [])),
    recordEmphasisResolution() {}, rebuildComponentLabels: async () => {},
    componentLabels: { active: () => false }, lessonKey: { remember() {} }, talkCaption: { set() {} },
    immersiveSession: { clearStatus: async () => {}, platePoints: () => menu,
      captionPoints: () => [], drawnMenuPoints: () => menu, menuRows: () => [menu] },
    recordManipulation: (kind, detail) => records.push({ kind, ...detail }),
    recordCost: (kind, detail) => records.push({ kind, ...detail }),
    recordStandoff: detail => records.push({ kind: 'standoff', ...detail }),
  });
  for (const name of ['gesturePivotContext', 'beginGesturePivot', 'invalidateGesturePivot', 'gesturePivotCenter', 'grabPivotBounds',
    'cancelXrPlacementFollowup', 'startXrPlacementFollowup', 'emphasize', 'modelledFocusKeys', 'focusSelection', 'bakeGrab', 'placementIntentCheckpoint', 'settlePlacementIntent', 'takeWearerPlacement',
    'rotationFromPlacement', 'rotationDegreesZYX', 'placementTransform', 'placementFitEvidence', 'capturePlacementFitEvidence', 'clearHeldPlatePlacement', 'placeInspection']) {
    const start = source.search(new RegExp(`  (?:async )?function ${name}\\(`));
    const lineEnd = source.indexOf('\n', start);
    const end = source.slice(start, lineEnd).trimEnd().endsWith('}') ? lineEnd : source.indexOf('\n  }', start) + 4;
    assert.ok(start >= 0 && end > start, `viewer function: ${name}`);
    vm.runInContext(source.slice(start, end), h);
  }
  if (labelView) {
    const parts = h.componentLabelPlateParts();
    parts.splice(2);
    Object.assign(parts[1], { id: 'dyskerin', label: 'Dyskerin', chain: 'B', center: target.center });
    Object.assign(parts[0], { id: 'gar1', label: 'GAR1', chain: 'C', center: [-30, 0, 0] });
    h.emphasisState = { parts, focus: [] };
    h.componentLabels = labelView.session;
    vm.runInContext(pageFunction(source, 'rebuildComponentLabels'), h);
    h.componentLabelViewBasis = () => ({ eye: [0, 110, 0], target: [0, 110, -1], up: [0, 1, 0], basis: 'head' });
    h.applyMatrix4 = applyMatrix4;
    h.immersiveSession.presentation = () => ({ roomMatrix: () => Mat4.identity() });
    h.presentationTransform = () => h.placementTransform(placement);
    h.componentLabelKeyPlan = () => ({ colours: parts.map(p => ({ id: p.id,
      opacity: !h.emphasisState.focus.length || h.emphasisState.focus.includes(p.id) ? 1 : .35 })) });
    h.lessonKey = { remember() {}, parts: () => parts, contextOpacity: () => .35 };
    h.selection.toLoci = keys => parts.find(p => p.chain === keys[0] || p.keys[0] === keys[0]) ?? target;
    h.runSpatialAction = async (_action, run) => run();
    vm.runInContext(pageFunction(source, 'componentLabelLayout'), h);
    h.onSpatialAction = vm.runInContext(viewerCallback(source, 'onSpatialAction'), h);
    h.recordCost = (kind, detail) => records.push({ kind, ...detail });
    for (const name of ['currentEmphasisPlan', 'componentLabelKeyPlan', 'componentLabelPlateParts'])
      vm.runInContext(pageFunction(source, name), h);
  }
  const workspace = { snapshot, rows: () => [], viewer: {
    select: h.select, focus: forbidden,
    inspection: { ...(labelView && source.includes('batchComponentLabels:') ? { batchComponentLabels: operation => h.componentLabels.transaction(operation) } : {}),
      emphasize: h.emphasize, place: h.placeInspection,
      holdsWearerPlacement: () => hold.holdsPlacement(), configure: async () => {},
      setMotion: h.setInspectionMotion, fit: forbidden, resetOrientation: forbidden,
      orbit: forbidden, dolly: forbidden },
  } };
  return { workspace, hold, records, writes, paints, snapshot, h, labels: labelView,
    async wearerMove() {
      // A real committed voice-scale takeover, at the held top-edge seat.
      placement = { translation: [0, 2.494, -2], rotation: [0, 0, 0], scale: 1 };
      h.beginGesturePivot();
      h.grabScale = .5;
      await h.bakeGrab({ gesture: 'voice-scale' });
      h.latestHeadSample = now;
    },
    targetLens() {
      const render = Vec3.transformMat4(Vec3(), Vec3.create(...target.center), h.placementTransform(placement));
      const room = Vec3.scale(Vec3(), render, h.canvas.camera.scale);
      const depth = head[14] - room[2];
      assert.ok(depth > 0, 'the committed target is in front of the tracked head');
      return [(room[0] - head[12]) / depth / EYE_TAN_HALF_HORIZONTAL,
        (room[1] - head[13]) / depth / EYE_TAN_HALF_VERTICAL];
    },
  };
}

export const framedTourScene = {
  id: 'guide', title: 'Guide RNA', placement: { scale: 1.6 }, view: 'fit',
  emphasis: { parts: [{ id: 'guide', label: 'Guide RNA', color: '#ff8a1f', chain: 'B' }],
    focus: 'guide', framing: 'context' },
};
