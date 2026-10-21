import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { StructureElement } from 'molstar/lib/mol-model/structure.js';
import { Color } from 'molstar/lib/mol-util/color/index.js';
import { liveEmphasisTargets } from './representation-refs.mjs';
import { representationLayerRef } from './scene-transition.mjs';
import { composeOverpaintLayers, selectionOverpaintLayer } from './selection-paint.mjs';
import { mergeEmphasisColourLayers } from './lesson-emphasis.mjs';
import { Camera } from 'molstar/lib/mol-canvas3d/camera.js';
import { TrackballControls } from 'molstar/lib/mol-canvas3d/controls/trackball.js';
import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import extraction from '../identity/extract.cjs';
import { applyMatrix4 } from './room-lock.mjs';
import { createRoomAnchor } from './room-anchor.mjs';
import { createLessonFigure } from './lesson-figure.mjs';
import { createLessonKeyMemory, normalizeEmphasisState } from './lesson-emphasis.mjs';
import { createLessonResting } from './lesson-resting.mjs';
import { sourceLoadHarness } from './fixtures/source-load-harness.mjs';
import { geometryBudgetReceipt, requireGeometryBudget } from './representation-budget.mjs';
import { pageFunction } from './fixtures/label-action-harness.mjs';

const viewer = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
const cif = readFileSync(new URL('../../fixtures/identity-edge.cif', import.meta.url), 'utf8');
const fixture = async assemblyId => {
  const catalog = await extraction.extractBytes(Buffer.from(cif), { assemblyId });
  return { id: 'identity-edge', cif, catalog, sha256: catalog.source.sha256 };
};
const assembly = await fixture('1'), asymmetric = await fixture('asymmetric_unit');
const initial = { modelNumber: 1, assemblyId: '1',
  camera: { mode: 'perspective', fov: Math.PI / 4, position: [0, 0, 100], target: [0, 0, 0], up: [0, 1, 0],
    radius: 20, radiusMax: 20, fog: 0, clipFar: true, minNear: 0, minFar: 0 },
  inspection: { placement: { translation: [0, 1, -4], rotation: [0, 0, 0], scale: 2 } } };
const plain = value => JSON.parse(JSON.stringify(value));

// Actual production load/adopt/rollback/restore closures and actual parsed Mol*
// models, assembly operators and geometry. Canvas/XR draws are adapters.
async function withViewer(action) {
  const previousDocument = globalThis.document;
  globalThis.document = { addEventListener() {}, removeEventListener() {},
    createElement: () => ({ setAttribute() {} }), head: { appendChild() {}, removeChild() {} } };
  let h;
  try {
    h = await sourceLoadHarness(assembly, initial);
    const c = h.context;
    Object.assign(c, { adoptionGeneration: 0, NO_EMPHASIS: {},
      dataRoot: c.current.rootRef, appliedGeometryBudget: undefined, volumeTriangles: 0, volumePaint: null,
      selection: c.current.selection, visibleStage: undefined, emphasisState: {}, visibilityState: {}, stylesState: [],
      pendingRoomLabels: false, pendingRoomLabelBasis: null, lastLessonChapterKey: undefined,
      lessonPlayback: undefined, emphasisOrigin: 'command',
      lessonKey: { forget() { c.forgotten++; } }, forgotten: 0,
      lessonResting: { setLabelsEnabled() {}, forget() {} },
      componentLabels: { adopt: () => [] }, lessonFigure: { drawn: () => true, forget: async () => {} },
      roomEntry: { seat: structuredClone(initial.inspection.placement) },
      entryRoomPoint: [0, 1, -4], placementNote: { text: 'original entry' },
      pendingRoomSeat: false, latestSeatStandoffMeters: 4, latestPlateSeat: { mode: 'auto' },
      Mat4, applyMatrix4, latestRoomPlacementPose: { renderFromRoom: Array.from(Mat4.identity()) },
    });
    vm.runInContext(pageFunction(viewer, 'adopt'), c);
    const adopt = c.adopt;
    c.adopt = record => { adopt(record); c.current = record; };
    // The initial source was loaded by the base harness's adoption adapter.
    // Match real adoption before exercising context recovery's candidate cleanup.
    c.candidateRecords.delete(c.current);
    vm.runInContext(pageFunction(viewer, 'loadedSphere'), c);
    // Execute the first tracked-frame entry capture from the production callback.
    const start = viewer.indexOf('          if (latestRoomPlacementPose && roomEntry && !roomEntry.seat');
    assert.ok(start >= 0);
    c.captureEntry = () => vm.runInContext(viewer.slice(start, viewer.indexOf('\n          }', start) + 12), c);
    // The wearer has explored away from the original Reset target.
    c.inspectionState.place({ translation: [1, 2, -7], rotation: [12, 25, 0], scale: 7.83 }, 'grab');
    await action(h, c);
  } finally {
    h?.dispose();
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
}

test('a same-source reload settles retired animation geometry before rebuilding its retained figure', async () => {
  await withViewer(async (h, c) => {
    h.canvas.webgl.extensions = {};
    c.lessonFigure = createLessonFigure({ plugin: c.plugin, getStructure: () => c.structure, getTransform: () => Mat4.identity() });
    const figure = { layers: [
      { id: 'x', target: { chain: 'X' }, representation: 'spacefill', color: '#25859b', opacity: 1 },
    ], labels: [], distances: [] };
    await c.lessonFigure.install(figure);
    c.scientificRepresentationCount = () => 1 + c.retainedRepresentationCount + c.lessonFigure.count();
    const appearance = c.applyInspectionAppearance;
    c.applyInspectionAppearance = async () => { await appearance(); await c.lessonFigure.refresh(); };

    // A same-digest adoption retains the figure definition but queues old
    // animation removal. Model a Canvas3D object retired at an awaited build,
    // as the production animation queue can do while figure cells are staged.
    const retiredBody = {}, renderObjects = h.canvas.getRenderObjects;
    let retired = false, cleanup, release;
    h.canvas.getRenderObjects = () => [...renderObjects(), ...(!retired ? [retiredBody] : [])];
    c.molecularAnimation = { ...c.molecularAnimation,
      forget() {
        cleanup = new Promise(resolve => { release = resolve; }).then(() => { retired = true; });
        return cleanup;
      },
      async settled() { release?.(); await cleanup; h.canvas.commit(true); },
    };
    const build = c.plugin.builders.structure.tryCreateComponentFromExpression.bind(c.plugin.builders.structure);
    let cleanupLandedDuringFigure = false;
    c.plugin.builders.structure.tryCreateComponentFromExpression = async (...args) => {
      const component = await build(...args);
      if (cleanup && !retired) {
        cleanupLandedDuringFigure = true;
        release(); await cleanup;
      }
      return component;
    };
    await h.load(assembly, { modelNumber: 1, assemblyId: '1' });
    assert.equal(cleanupLandedDuringFigure, false, 'source-owned cleanup must settle before a figure samples external geometry');
    assert.equal(c.state.status, 'ready');
    assert.deepEqual(c.lessonFigure.definition(), figure);
    assert.equal(c.lessonFigure.count(), 1);
    assert.equal(c.forgotten, 0, 'same-source scientific identity and lesson names are retained');
    await c.lessonFigure.forget();
  });
});

for (const [name, source, options, identity] of [
  ['model', assembly, { modelNumber: 2, assemblyId: '1' }, { modelNumber: 2, assemblyId: '1' }],
  ['assembly', asymmetric, { modelNumber: 1, assemblyId: 'asymmetric_unit' }, { modelNumber: 1, assemblyId: 'asymmetric_unit' }],
]) test(`a same-file ${name} swap retires the old target and captures the new source's drawn seat`, async () => {
  await withViewer(async (h, c) => {
    assert.equal(source.sha256, c.liveScene().sourceSha256);
    await h.load(source, options);
    assert.equal(c.state.status, 'ready');
    assert.equal(c.liveScene().modelNumber, identity.modelNumber);
    assert.equal(c.liveScene().assemblyId, identity.assemblyId);
    assert.equal(c.roomEntry.seat, undefined);
    assert.equal(c.entryRoomPoint, null); assert.equal(c.placementNote, null);
    assert.equal(c.forgotten, 1);
    const placed = plain(c.inspectionSnapshot().placement);
    assert.notDeepEqual(placed, initial.inspection.placement);
    c.captureEntry();
    assert.deepEqual(plain(c.roomEntry.seat), placed);
    const sphere = c.loadedSphere();
    assert.deepEqual(plain(c.entryRoomPoint), sphere.center.map((v, i) =>
      (v + placed.translation[i] * sphere.radius) * h.canvas.camera.scale));
  });
});

test('repainting and context restoration of the exact source tuple preserve its original Reset target', async () => {
  await withViewer(async (h, c) => {
    const target = plain(c.roomEntry.seat), point = plain(c.entryRoomPoint), note = c.placementNote;
    await h.load(assembly, { modelNumber: 1, assemblyId: '1' });
    await c.restoreRecord(c.retainCurrent(), { recovering: true });
    assert.deepEqual(plain(c.roomEntry.seat), target);
    assert.deepEqual(plain(c.entryRoomPoint), point); assert.equal(c.placementNote, note);
    assert.equal(c.forgotten, 0);
    c.captureEntry();
    assert.deepEqual(plain(c.roomEntry.seat), target);
  });
});

for (const [name, source, options] of [
  ['model', assembly, { modelNumber: 2, assemblyId: '1' }],
  ['assembly', asymmetric, { modelNumber: 1, assemblyId: 'asymmetric_unit' }],
]) test(`a failed post-adoption ${name} swap restores the entry target and explored pose independently`, async () => {
  await withViewer(async (h, c) => {
    const target = plain(c.roomEntry.seat), point = plain(c.entryRoomPoint), note = c.placementNote;
    const placement = plain(c.inspectionSnapshot().placement), plateSeat = c.latestPlateSeat;
    c.checkpoint = async (_operation, phase) => {
      if (phase === 'after_room_anchor') {
        assert.equal(c.roomEntry.seat, undefined, 'the new source was already adopted');
        c.captureEntry();
        assert.equal(c.roomEntry.seat, undefined, 'a head frame cannot capture the staging placement while busy');
        c.pendingRoomSeat = true; c.latestSeatStandoffMeters = 9; c.latestPlateSeat = null;
        throw Error('Injected after_room_anchor failure');
      }
    };
    await assert.rejects(h.load(source, options), /Injected after_room_anchor failure/);
    assert.equal(c.state.status, 'ready'); assert.equal(c.state.lastLoadFailure.recovered, true);
    assert.equal(c.liveScene().modelNumber, 1); assert.equal(c.liveScene().assemblyId, '1');
    assert.deepEqual(plain(c.inspectionSnapshot().placement), placement);
    assert.deepEqual(plain(c.roomEntry.seat), target); assert.deepEqual(plain(c.entryRoomPoint), point);
    assert.equal(c.placementNote, note); assert.equal(c.pendingRoomSeat, false);
    assert.equal(c.latestSeatStandoffMeters, 4); assert.equal(c.latestPlateSeat, plateSeat);
    c.captureEntry();
    assert.deepEqual(plain(c.roomEntry.seat), target, 'the next head frame does not recapture the explored pose');
  });
});

test('rollback does not give a replacement XR session the previous session\'s Reset target', async () => {
  await withViewer(async (h, c) => {
    const oldEntry = c.roomEntry;
    c.checkpoint = async (_operation, phase) => {
      if (phase === 'after_room_anchor') {
        c.roomEntry = {};
        throw Error('Injected new-session failure');
      }
    };
    await assert.rejects(h.load(assembly, { modelNumber: 2, assemblyId: '1' }), /Injected new-session failure/);
    assert.notEqual(c.roomEntry, oldEntry);
    assert.equal(c.roomEntry.seat, undefined); assert.equal(c.entryRoomPoint, null); assert.equal(c.placementNote, null);
    c.captureEntry();
    assert.deepEqual(plain(c.roomEntry.seat), plain(c.inspectionSnapshot().placement));
    assert.notDeepEqual(plain(c.roomEntry.seat), initial.inspection.placement);
  });
});

for (const outcome of ['committed', 'failed', 'new-session']) {
  test(`a ${outcome} source replacement publishes its room anchor only after commit in its original session`, async () => {
    await withViewer(async (h, c) => {
      let released = 0, measured = 0;
      const nativeAnchor = { anchorSpace: {}, delete() { released++; } };
      const anchor = createRoomAnchor();
      await anchor.applied({ frame: { createAnchor: async () => nativeAnchor }, space: {}, roomPoint: [0, 1, -4] });
      c.roomAnchor = anchor;
      c.latestHeadSample = performance.now();
      c.applyInspectionTransform = () => {};
      // The real entry-placement solver is covered by source-swap-seat. This
      // adapter supplies its successful result so the production load and
      // seatSwappedSource exercise the real native-anchor lifetime.
      c.roomAnchorPlacement = () => {
        measured++;
        return { translation: [.4, 1, -3], scale: .7, roomPoint: [.1, 1, -3], metersAcross: 1.4 };
      };
      vm.runInContext(pageFunction(viewer, 'seatSwappedSource'), c);
      c.checkpoint = async (_operation, phase) => {
        if (phase !== 'after_room_anchor') return;
        assert.equal(measured, 1, 'candidate reached the production entry-seat path');
        assert.equal(released, 0, 'staging cannot release the retained native anchor');
        assert.equal(anchor.status().placements, 1, 'staging cannot spend another automatic placement');
        assert.equal(anchor.status().anchored, true);
        if (outcome === 'failed') throw Error('Injected seated-candidate failure');
        if (outcome === 'new-session') c.roomEntry = {};
      };
      const load = h.load(assembly, { modelNumber: 2, assemblyId: '1', seatForEntry: true });
      if (outcome === 'failed') await assert.rejects(load, /Injected seated-candidate failure/);
      else await load;
      await Promise.resolve();
      assert.equal(measured, 1);
      assert.equal(released, outcome === 'committed' ? 1 : 0);
      assert.equal(anchor.status().placements, outcome === 'committed' ? 2 : 1);
      assert.equal(anchor.status().anchored, outcome !== 'committed');
      anchor.release();
    });
  });
}

for (const sessionEnded of [false, true]) {
  test(`post-adoption context loss restores the complete inspection before recovery, session ended=${sessionEnded}`, async () => {
    await withViewer(async (h, c) => {
      c.inspectionState.configure({ color: 'uniform', uniformColor: '#123456', opacity: .4 }, 'prior-color');
      c.inspectionState.setPayload({ marker: 'retained scientific payload' });
      c.inspectionState.save('prior view');
      const inspection = plain(c.inspectionState.checkpoint());
      const entry = c.roomEntry, target = plain(entry.seat);
      Object.assign(c, { spatialInputOwners: new Set(), spatialOwnedHands: new Set(),
        manualXrInputHeld: false, spatialReleaseUntil: 0, latestHeadContext: null,
        pendingPresentationPick: undefined, motionContextPaused: false,
        recoveryRecord: undefined, recoveryPromise: undefined });
      c.state.contextRestorationCount = 0;
      c.immersiveSession.end = async () => { if (sessionEnded) c.roomEntry = null; h.canvas.xr.isPresenting.value = false; h.canvas.webgl.xr.session = undefined; };
      c.plugin.animationLoop = { isAnimating: true, stop() {} }; h.canvas.requestResize = () => {};
      for (const name of ['contextLost', 'contextRestored']) vm.runInContext(pageFunction(viewer, name), c);
      c.checkpoint = async (_operation, phase) => {
        if (phase !== 'after_room_anchor') return;
        assert.equal(c.liveScene().modelNumber, 2, 'loss happens after adoption and inspection reset');
        h.canvas.webgl.isContextLost = true;
        c.contextLost();
        throw c.activeLoad.cancelled;
      };
      await assert.rejects(h.load(assembly, { modelNumber: 2, assemblyId: '1' }), /context was lost/);
      assert.equal(c.state.status, 'context_lost');
      assert.deepEqual(plain(c.inspectionState.checkpoint()), inspection, 'CPU inspection is restored while GPU drawing is unavailable');
      h.canvas.webgl.isContextLost = false;
      c.contextRestored(); await c.recoveryPromise;
      assert.equal(c.state.status, 'ready'); assert.equal(c.liveScene().modelNumber, 1);
      assert.equal(c.state.lastLoadFailure.recovered, true); assert.equal(c.state.lastLoadFailure.recoveryPending, false);
      assert.deepEqual(plain(c.inspectionState.checkpoint()), inspection, 'appearance, pose, payload, undo/redo and saved views survive recovery');
      if (sessionEnded) assert.equal(c.roomEntry, null, 'recovery cannot resurrect an ended session');
      else { assert.equal(c.roomEntry, entry); assert.deepEqual(plain(c.roomEntry.seat), target); }
    });
  });
}

for (const route of ['model', 'assembly', 'new-session', 'context-loss', 'queued-assembly', 'queued-context-loss', 'painted-context-loss']) {
  test(`failed ${route} adoption restores authored Mol* figure and the complete lesson state`, async () => {
    await withViewer(async (h, c) => {
      h.canvas.webgl.extensions = {};
      let queuedRemovals, candidateObjects, candidateDrainedDuringFigure = false;
      if (route.startsWith('queued-')) {
        h.canvas.xr.isPresenting.value = false;
        // Canvas3D.remove queues scene removals: getRenderObjects keeps their
        // objects until scene.commit, even after their Mol* cells are deleted.
        queuedRemovals = new Set();
        const remove = h.canvas.remove, objects = h.canvas.getRenderObjects;
        h.canvas.remove = repr => {
          for (const object of repr.renderObjects) queuedRemovals.add(object);
          remove(repr);
        };
        h.canvas.getRenderObjects = () => [...new Set([...objects(), ...queuedRemovals])];
        h.canvas.commit = () => queuedRemovals.clear();
        const build = c.plugin.builders.structure.tryCreateComponentFromExpression.bind(c.plugin.builders.structure);
        c.plugin.builders.structure.tryCreateComponentFromExpression = async (...args) => {
          // A real animation commit can happen at any awaited figure build.
          if (candidateObjects) {
            candidateDrainedDuringFigure ||= candidateObjects.some(object => queuedRemovals.has(object));
            h.canvas.commit(true);
          }
          return build(...args);
        };
      }
      c.lessonFigure = createLessonFigure({ plugin: c.plugin, getStructure: () => c.structure, getTransform: () => Mat4.identity() });
      c.lessonKey = createLessonKeyMemory();
      let paints = 0, transforms = 0;
      c.lessonResting = createLessonResting({
        emphasize: async request => { assert.equal(c.busy, false, 'rollback must not start an admitted lesson paint');
          paints++; c.emphasisState = normalizeEmphasisState(request); c.emphasisOrigin = request.origin; },
        snapshot: () => c.snapshot(), rebuildLabels: async () => {},
        getEmphasis: () => c.emphasisState, getOrigin: () => c.emphasisOrigin,
      });
      c.scientificRepresentationCount = () => 1 + c.retainedRepresentationCount + c.lessonFigure.count();
      c.applyInspectionTransform = () => { transforms++; };
      const appearance = c.applyInspectionAppearance;
      c.applyInspectionAppearance = async () => { await appearance(); await c.lessonFigure.refresh(); };
      for (const name of ['retainCurrent', 'restoreRetainedLessonState']) vm.runInContext(pageFunction(viewer, name), c);
      const parts = [{ id: 'x', label: 'Authored X', aliases: ['first chain'], chain: 'X', color: '#25859b' }];
      await c.lessonResting.install({ emphasis: { parts }, componentLabels: true });
      c.lessonKey.remember({ parts: [...parts, { id: 'y', label: 'Remembered Y', chain: 'Y', color: '#60b4c1' }], contextOpacity: .17 });
      c.emphasisState = normalizeEmphasisState({ parts, focus: ['x'], contextOpacity: .23 });
      c.emphasisOrigin = 'lesson'; c.lastLessonChapterKey = 'authored-chapter-2';
      c.lessonPlayback = { lessonId: 'private-lesson', chapterId: 'chapter-2', paused: true };
      const figure = { layers: [
        { id: 'x', target: { chain: 'X' }, representation: 'spacefill', color: '#25859b', opacity: 1 },
        { id: 'y', target: { chain: 'Y' }, representation: 'spacefill', color: '#60b4c1', opacity: .14 },
      ], labels: [], distances: [] };
      await c.lessonFigure.install(figure);
      if (route === 'painted-context-loss') {
        h.canvas.xr.isPresenting.value = false;
        h.canvas.setProps = () => {};
        const geometry = c.geometryFor;
        c.geometryFor = (name, data = c.structure.obj.data) => geometry(name, data);
        Object.assign(c, { StructureElement, Color, liveEmphasisTargets, representationLayerRef,
          composeOverpaintLayers, selectionOverpaintLayer, mergeEmphasisColourLayers,
          EMPHASIS_LAYER_REF: 'stereofold-lesson-emphasis', SCENE_VISIBILITY_LAYER_REF: 'stereofold-scene-visibility',
          inspectionRepresentationName: value => value, INSPECTION_COLORS: new Set(['chain-id', 'uniform']),
          representationForBudget: value => value, sessionDeviceClass: () => 'quest2',
          structureAtomSites: () => c.structure.obj.data.elementCount, builtRepresentation: 'cartoon',
          colorNumber: value => Number.parseInt(value.slice(1), 16), recordCost: () => {},
          paintCompanion: async () => {}, rebuildLigandOverlay: async () => {}, ligandOverlayForBudget: () => undefined,
          ligandAtomSites: () => 0, rebuildStyleLayers: async () => {}, markSelection: () => {},
          rebuildInspectionLabels: async () => {}, rebuildComponentLabels: async () => {},
          dropDeadOverlayRefs: () => {}, styleLayerTargets: () => [], currentSelectionPlan: () => undefined,
          hiddenSceneKeys: () => [],
        });
        c.currentEmphasisPlan = () => {
          const keys = c.selection.rows.filter(row => row.identity.authorChain === 'X').map(row => row.key);
          const faded = c.selection.rows.filter(row => row.identity.authorChain === 'Y').map(row => row.key);
          return { colours: [{ color: '#25859b', keys }], lit: keys, faded, transparency: .77 };
        };
        for (const name of ['assertContext', 'paintEmphasisLayers', 'paintVisibilityLayers', 'applyInspectionAppearance'])
          vm.runInContext(pageFunction(viewer, name), c);
      }
      const before = { figure: c.lessonFigure.definition(), playback: plain(c.lessonPlayback), chapter: c.lastLessonChapterKey,
        emphasis: plain(c.emphasisState), origin: c.emphasisOrigin, learned: c.lessonKey.parts(), contextOpacity: c.lessonKey.contextOpacity(),
        resting: plain(c.lessonResting.state()), labels: c.lessonResting.labelsEnabled(), paints };
      assert.equal(c.lessonFigure.count(), 2);
      if (route.endsWith('context-loss')) {
        Object.assign(c, { spatialInputOwners: new Set(), spatialOwnedHands: new Set(), manualXrInputHeld: false,
          spatialReleaseUntil: 0, latestHeadContext: null, pendingPresentationPick: undefined,
          motionContextPaused: false, recoveryRecord: undefined, recoveryPromise: undefined, pendingContextLoss: undefined });
        c.immersiveSession.end = async () => { c.roomEntry = null; h.canvas.xr.isPresenting.value = false; h.canvas.webgl.xr.session = undefined; };
        c.plugin.animationLoop = { isAnimating: true, stop() {} }; h.canvas.requestResize = () => {};
        for (const name of ['contextLost', 'contextRestored']) vm.runInContext(pageFunction(viewer, name), c);
      }
      c.checkpoint = async (_operation, phase) => {
        if (phase !== 'after_room_anchor') return;
        assert.equal(c.lessonFigure.definition(), undefined, 'staged source cannot retain the old source figure');
        if (queuedRemovals) candidateObjects = [...c.representation.obj.data.repr.renderObjects];
        if (route.endsWith('context-loss')) { h.canvas.webgl.isContextLost = true; c.contextLost(); throw c.activeLoad.cancelled; }
        if (route === 'new-session') c.roomEntry = {};
        throw Error('Injected authored-source failure');
      };
      try {
        await assert.rejects(h.load(route.endsWith('assembly') ? asymmetric : assembly,
          { modelNumber: route.endsWith('assembly') ? 1 : 2, assemblyId: route.endsWith('assembly') ? 'asymmetric_unit' : '1' }),
        route.endsWith('context-loss') ? /context was lost/ : /authored-source failure/);
        if (route.endsWith('context-loss')) { h.canvas.webgl.isContextLost = false; c.contextRestored(); await c.recoveryPromise; }
        assert.equal(c.state.status, 'ready', c.state.error);
        if (queuedRemovals) {
          assert.ok(candidateObjects.length > 0, 'the retired candidate had actual Mol* render objects');
          assert.equal(candidateDrainedDuringFigure, false, 'candidate removals must be committed before figure staging');
          assert.ok(candidateObjects.every(object => !h.canvas.getRenderObjects().includes(object)));
        }
        assert.deepEqual(c.lessonFigure.definition(), before.figure);
        assert.deepEqual(c.lessonPlayback, before.playback); assert.equal(c.lastLessonChapterKey, before.chapter);
        assert.deepEqual(c.emphasisState, before.emphasis); assert.equal(c.emphasisOrigin, before.origin);
        assert.deepEqual(c.lessonKey.parts(), before.learned); assert.equal(c.lessonKey.contextOpacity(), before.contextOpacity);
        assert.deepEqual(c.lessonResting.state(), before.resting); assert.equal(c.lessonResting.labelsEnabled(), before.labels);
        assert.equal(paints, before.paints, 'metadata restoration cannot invoke a new lesson paint');
        assert.equal(c.lessonFigure.count(), 2);
        assert.equal(c.lessonFigure.molecular()[1].props.alpha, .14);
        assert.ok(c.lessonFigure.drawn(new Set(h.canvas.getRenderObjects())), 'restored real figure layers have rendered');
        assert.ok(transforms > 0, 'restored figure receives the retained placement');
        if (route === 'painted-context-loss') {
          const rendered = c.representation.obj.data.repr.state;
          assert.ok(rendered.overpaint.layers.some(layer => layer.color === 0x25859b), 'retained authored colour reached the actual Mol* representation');
          assert.ok(rendered.transparency.layers.some(layer => layer.value === .77), 'retained context fade reached the actual Mol* representation');
          c.state.status = 'recovering';
          await assert.rejects(c.paintEmphasisLayers(c.currentEmphasisPlan()), { code: 'context_recovering' });
          await assert.rejects(c.paintVisibilityLayers(), { code: 'context_recovering' });
          await c.paintEmphasisLayers(c.currentEmphasisPlan(), { recovering: true });
          await c.paintVisibilityLayers(undefined, { recovering: true });
          h.canvas.webgl.isContextLost = true;
          assert.throws(() => c.assertContext({ recovering: true }), { code: 'context_lost' });
          h.canvas.webgl.isContextLost = false;
          c.state.status = 'disposed';
          assert.throws(() => c.assertContext({ recovering: true }), { code: 'viewer_disposed' });
          c.state.status = 'ready';
        }
      } finally { await c.lessonFigure.forget(); }
    });
  });
}

for (const route of ['failure', 'context-loss', 'new-session', 'new-controls', 'named-restore-context-loss', 'shared-refit-context-loss', 'shared-refit-delayed-event-context-loss', 'shared-refit-new-controls-context-loss']) {
  test(`fitted preview ${route} keeps scientific camera ownership and respects retained control ownership`, async () => {
    await withViewer(async (h, c) => {
      h.canvas.xr.isPresenting.value = false;
      const camera = new Camera(undefined, { x: 0, y: 0, width: 1280, height: 493 });
      camera.setState(initial.camera, 0); h.canvas.camera = camera;
      const scienceCamera = camera.getSnapshot();
      const sphere = { center: [20, 10, -40], radius: 350 }, originalMax = 565.6422404345791;
      const input = Object.fromEntries(['drag', 'interactionEnd', 'wheel', 'pinch', 'keyDown', 'keyUp', 'move', 'lock', 'leave']
        .map(name => [name, { subscribe: () => ({ unsubscribe() {} }) }]));
      const controls = TrackballControls.create(input, camera, { boundingSphereVisible: sphere }, {
        maxDistance: originalMax, staticMoving: true,
        autoAdjustMinMaxDistance: { name: 'on', params: { minDistanceFactor: 0, minDistancePadding: 5, maxDistanceFactor: 10, maxDistanceMin: 20 } },
      });
      Object.defineProperty(h.canvas, 'props', { get: () => ({ trackball: { ...controls.props } }) });
      h.canvas.setProps = value => { if (value.trackball) controls.setProps(value.trackball); };
      Object.assign(c, { Vec3, enableXr: true, desktopPreviewCamera: undefined, desktopPreviewMaxDistance: undefined,
        molecularBounds: () => sphere, savedStyles: () => ({}), savedVisibility: () => ({}), savedEmphasis: () => ({}),
        lessonMotionHold: { presented: value => value }, assertReady: () => {}, applyInspectionTransform: () => {},
        roomSeatMemory: { take: () => undefined }, roomCameraInitialized: true,
      });
      Object.assign(c.lessonFigure, { definition: () => undefined });
      Object.assign(c.lessonKey, { checkpoint: () => undefined, restoreCheckpoint() {} });
      Object.assign(c.lessonResting, { checkpoint: () => undefined, restoreCheckpoint() {} });
      for (const name of ['retainCurrent', 'restoreRetainedLessonState', 'restoreRetainedDesktopPreview',
        'fitDesktopPreview', 'releaseDesktopPreviewLimit', 'restoreImmersiveCamera', 'completeInspectionCapture'])
        vm.runInContext(pageFunction(viewer, name), c);
      c.fitDesktopPreview(); controls.update(1); camera.update();
      const fitted = camera.getSnapshot(), fittedMax = controls.props.maxDistance;
      const captureBefore = plain(c.completeInspectionCapture());
      assert.deepEqual(captureBefore.camera, scienceCamera);
      assert.ok(fittedMax > originalMax);
      const originalEntry = c.roomEntry;
      if (route.endsWith('context-loss')) {
        Object.assign(c, { spatialInputOwners: new Set(), spatialOwnedHands: new Set(), manualXrInputHeld: false,
          spatialReleaseUntil: 0, latestHeadContext: null, pendingPresentationPick: undefined,
          motionContextPaused: false, recoveryRecord: undefined, recoveryPromise: undefined, pendingContextLoss: undefined });
        c.immersiveSession.end = async () => { h.canvas.xr.isPresenting.value = false; h.canvas.webgl.xr.session = undefined; };
        c.plugin.animationLoop = { isAnimating: true, stop() {} }; h.canvas.requestResize = () => {};
        for (const name of ['contextLost', 'contextRestored']) vm.runInContext(pageFunction(viewer, name), c);
      }
      c.checkpoint = async (_operation, phase) => {
        if (phase !== 'after_room_anchor') return;
        assert.equal(c.desktopPreviewCamera, undefined);
        assert.equal(controls.props.maxDistance, originalMax, 'candidate adoption released its old preview limit');
        if (route === 'new-session') { c.roomEntry = {}; controls.setProps({ maxDistance: 1500 }); }
        if (route === 'new-controls') controls.setProps({ maxDistance: 1500 });
        if (route.endsWith('context-loss')) { h.canvas.webgl.isContextLost = true; c.contextLost(); throw c.activeLoad.cancelled; }
        throw Error('Injected fitted-preview failure');
      };
      if (route === 'named-restore-context-loss' || route.startsWith('shared-refit-')) {
        Object.assign(c, {
          validInspectionCapture: value => value, wearerPlacement: { holdsPlacement: () => false },
          recordManipulation() {}, restoreCompanion: async () => {}, markSelection() {},
          syncInspectionPayload: () => c.inspectionState.setPayload(c.inspectionPayload()),
          inspectionMutationSettlement: undefined, retiredComparisons: new Set(),
        });
        c.lessonMotionHold.release = () => {};
        c.lessonFigure.install = async () => {};
        for (const name of ['assertContext', 'assertReady', 'mutate', 'inspectionMutation', 'inspectionPayload', 'restoreInspection'])
          vm.runInContext(pageFunction(viewer, name), c);
        c.applyInspectionAppearance = async () => {
          assert.equal(c.desktopPreviewCamera, undefined, 'named camera has replaced the temporary preview');
          assert.equal(controls.props.maxDistance, originalMax);
          if (route.startsWith('shared-refit-')) { sphere.radius = 250; return; }
          h.canvas.webgl.isContextLost = true; c.contextLost(); c.assertContext();
        };
        if (route === 'shared-refit-delayed-event-context-loss') {
          const setState = camera.setState.bind(camera);
          camera.setState = (...args) => {
            const result = setState(...args);
            if (c.state.status === 'mutating' && args[0]?.radius === 280) h.canvas.webgl.isContextLost = true;
            return result;
          };
        }
        if (route.startsWith('shared-refit-')) {
          const waitForFrame = c.waitForFrame;
          c.waitForFrame = async (...args) => {
            if (c.state.status === 'mutating') {
              assert.ok(controls.props.maxDistance > originalMax && controls.props.maxDistance < fittedMax,
                'failed shared restore owns its own smaller refit limit');
              if (route === 'shared-refit-new-controls-context-loss') controls.setProps({ maxDistance: 1500 });
              h.canvas.webgl.isContextLost = true;
              if (route !== 'shared-refit-delayed-event-context-loss') c.contextLost();
              c.assertContext();
            }
            return waitForFrame(...args);
          };
        }
      }
      try {
        if (route === 'named-restore-context-loss' || route.startsWith('shared-refit-')) {
          const incoming = { camera: { ...scienceCamera, position: [0, 0, 250] }, keys: [], inspection: c.inspectionState.snapshot() };
          await assert.rejects(c.restoreInspection(incoming, { preservePreviewCamera: route === 'named-restore-context-loss' }), /WebGL context was lost/);
          c.applyInspectionAppearance = async () => {};
        } else await assert.rejects(h.load(assembly, { modelNumber: 2, assemblyId: '1' }),
          route.endsWith('context-loss') ? /context was lost/ : /fitted-preview failure/);
        if (route === 'shared-refit-delayed-event-context-loss') {
          assert.equal(c.activeWork, undefined, 'mutation settled before the browser dispatches contextlost');
          assert.equal(c.pendingContextLoss.epoch, c.state.contextLossCount);
          c.contextLost();
          assert.equal(c.pendingContextLoss, undefined, 'the loss event consumes the pending checkpoint once');
        }
        if (route.endsWith('context-loss')) { h.canvas.webgl.isContextLost = false; c.contextRestored(); await c.recoveryPromise; }
        assert.equal(c.state.status, 'ready', c.state.error);
        controls.update(2); camera.update();
        assert.deepEqual(camera.getSnapshot(), fitted, 'restored fitted camera survives the real controls tick');
        if (route === 'new-session') {
          assert.notEqual(c.roomEntry, originalEntry);
          assert.equal(c.desktopPreviewCamera, undefined, 'old preview ownership cannot cross into a new room session');
        } else assert.deepEqual(plain(c.completeInspectionCapture()), captureBefore, 'scientific capture keeps its authoritative camera and placement');
        if (route === 'failure' || (route.endsWith('context-loss') && route !== 'shared-refit-new-controls-context-loss')) {
          assert.equal(controls.props.maxDistance, fittedMax);
          h.canvas.xr.isPresenting.value = true; c.restoreImmersiveCamera();
          assert.equal(controls.props.maxDistance, originalMax, 'XR entry releases the recovered temporary limit');
          assert.deepEqual(camera.getSnapshot(), scienceCamera);
        } else {
          assert.equal(controls.props.maxDistance, 1500, 'newer controls preferences survive rollback');
          c.releaseDesktopPreviewLimit();
          assert.equal(controls.props.maxDistance, 1500);
        }
        if (route === 'shared-refit-delayed-event-context-loss') {
          camera.setState({ position: [5, 6, 107] }, 0);
          const idleCamera = camera.getSnapshot();
          // Even an obsolete epoch must not resurrect a failed operation on
          // an independent later loss after the first recovery has finished.
          c.pendingContextLoss = { previous: c.recoveryRecord, epoch: c.state.contextLossCount - 1 };
          h.canvas.webgl.isContextLost = true; c.contextLost();
          assert.deepEqual(plain(c.recoveryRecord.inspection.camera), idleCamera);
          assert.equal(c.pendingContextLoss, undefined);
        }
      } finally { controls.dispose(); }
    });
  });
}


test('successful source adoption replaces or clears the previous geometry advisory', async () => {
  await withViewer(async (h, c) => {
    const advisory = geometryBudgetReceipt(requireGeometryBudget({ representation: 'cartoon',
      atoms: 1_000_001, residues: 200_000, quality: 'highest', deviceClass: 'quest2', presenting: true }));
    assert.match(advisory.message, /may run slowly/);
    c.adopt({ ...c.current, geometryBudget: advisory });
    assert.deepEqual(plain(c.appliedGeometryBudget), advisory);
    await h.load(asymmetric, { modelNumber: 1, assemblyId: 'asymmetric_unit' });
    assert.equal(c.state.status, 'ready');
    assert.equal(c.appliedGeometryBudget, undefined, 'the newly loaded fixture has no historical-cost warning');
    assert.equal(c.liveScene().assemblyId, 'asymmetric_unit');
  });
});

for (const code of ['render_timeout', 'transition_cancelled']) test(`an admitted over-threshold source ${code} retains the prior scene and advisory`, async () => {
  await withViewer(async (h, c) => {
    const previous = c.current, pose = plain(c.inspectionSnapshot().placement);
    const previousReceipt = c.appliedGeometryBudget;
    // Inflate only the admission estimate; actual parsing, geometry construction
    // and rollback still execute against the small real Mol* fixture.
    c.geometryFor = representation => requireGeometryBudget({ representation, atoms: 1_000_001,
      bonds: 1_200_000, residues: 200_000, quality: 'highest', deviceClass: 'quest2', presenting: true });
    let reachedUpload = false, candidateRoot;
    c.prepareUploads = async representation => {
      reachedUpload = true;
      const candidate = [...c.candidateRecords].find(record => record.representation === representation);
      candidateRoot = candidate.rootRef;
      assert.match(candidate.geometryBudget.message, /may run slowly/);
      assert.equal(candidate.geometryBudget.level, 'highest');
      assert.equal(previous.representation.obj.data.repr.state.visible, true);
      throw Object.assign(Error('Injected real build-boundary failure'), { code });
    };
    await assert.rejects(h.load(asymmetric, { modelNumber: 1, assemblyId: 'asymmetric_unit' }), { code });
    assert.equal(reachedUpload, true, 'the estimate must not refuse before geometry/upload');
    assert.equal(c.current.source.sha256, previous.source.sha256);
    assert.equal(c.liveScene().assemblyId, '1');
    assert.equal(c.state.status, 'ready'); assert.equal(c.state.lastLoadFailure.recovered, true);
    assert.deepEqual(plain(c.inspectionSnapshot().placement), pose);
    assert.equal(c.appliedGeometryBudget, previousReceipt, 'a failed source never publishes its candidate advisory');
    assert.equal(c.representation.obj.data.repr.state.visible, true);
    assert.equal(c.plugin.state.data.cells.has(candidateRoot), false, 'failed candidate state tree was removed');
  });
});
