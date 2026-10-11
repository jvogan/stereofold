import test from 'node:test';
import { applyTourStep } from '../../plugin/src/tour-player.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createInspectionState, normalizeAppearance, normalizePlacement, sameAppearance } from './inspection-state.mjs';
import { createAgentPlacementHistory } from './agent-placement-history.mjs';
import { createPlacementHold } from './wearer-placement.mjs';
import { solveAppearanceFit } from './appearance-fit-worker.mjs';
import { identity, syntheticViews } from './fixtures/component-label-diagnostics.mjs';

const source = readFileSync(process.env.PLACEMENT_INTENT_BASELINE ?? new URL('./viewer.mjs', import.meta.url), 'utf8');
function closure(name, next) {
  const start = source.indexOf(`  ${name}`), end = source.indexOf(`\n  ${next}`, start);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}
const place = closure('async function placeInspection(', 'async function fitInspection(');
const clear = closure('function clearHeldPlatePlacement(', 'async function placeInspection(');
const configure = closure('async function configureInspection(', 'async function applyCompoundInspection(');
const undo = closure('async function undoInspection(', 'async function redoInspection(');
const redo = closure('async function redoInspection(', 'async function saveInspectionView(');
const intent = source.includes('  function placementIntentCheckpoint(') ? closure('function placementIntentCheckpoint(', '/**') : '';
const compound = closure('async function applyCompoundInspection(', '// Constant-size fit evidence');
// Execute the production final-silhouette admission after a representation
// build. Renderer construction is outside this CPU fixture; its live mesh,
// placement transforms, stereo geometry and clearance solver are real inputs.
const admissionStart = source.indexOf('      if (!recoverWithoutFit && !preservePlacement && typeof immersiveSession');
const admissionEnd = source.indexOf('\n      check?.();', admissionStart);
assert.ok(admissionStart >= 0 && admissionEnd > admissionStart);
const admission = source.slice(admissionStart, admissionEnd);
const cell = value => ({ ref: { value } });
const pose = scale => ({ translation: scale > 1 ? [16, 0, -12] : [1, 0, -2], rotation: [0, 0, 0], scale });

function harness({ presenting = true } = {}) {
  const inspection = createInspectionState(), hold = createPlacementHold({ now: () => 100 });
  const context = { session: presenting ? {} : undefined, source: 'same-sha:1:assembly-1' };
  const history = createAgentPlacementHistory({ hold, context: () => ({ ...context }) });
  const matrix = placement => {
    const result = identity(); result[0] = result[5] = result[10] = placement.scale;
    result.splice(12, 3, ...placement.translation); return result;
  };
  const vertices = new Float32Array([-.4, -.4, -.4, .4, -.4, -.4, -.4, .4, -.4, .4, .4, -.4,
    -.4, -.4, .4, .4, -.4, .4, -.4, .4, .4, .4, .4, .4]);
  const object = { type: 'mesh', state: { visible: true }, values: { drawCount: cell(36), instanceCount: cell(1),
    aTransform: cell(matrix(inspection.snapshot().placement)), aPosition: cell(vertices), uVertexCount: cell(8) } };
  const points = [-.8, -.3].flatMap(x => [-.8, .8].map(y => [x, y, -1.25]));
  let failRender = false, solves = 0;
  const c = vm.createContext({ now: () => performance.now(), normalizePlacement, normalizeAppearance, sameAppearance,
    state: { generation: 1, status: 'ready', selectionKeys: [] }, sourceRecord: {},
    inspectionState: inspection, inspectionSnapshot: () => inspection.snapshot(),
    agentPlacementHistory: history, wearerPlacement: hold, takeWearerPlacement: reason => hold.takeover(reason),
    canvas: { xr: { isPresenting: { value: presenting } }, webgl: { xr: { session: {} } }, camera: { scale: 1 } },
    latestRoomPlacementPose: { labelViews: syntheticViews(), headInRoom: identity(), renderFromRoom: identity() },
    immersiveSession: { platePoints: () => points, toolbarRelocationCandidates: () => [] },
    loadedSphere: () => ({ center: [0, 0, 0], radius: 1 }), lessonFigure: { snapshot: () => null },
    scientificRepresentations: () => [{ renderObjects: [object] }],
    placementTransform: matrix, presentationTransform: () => matrix(inspection.snapshot().placement),
    placementViewWaiters: new Set(), talkCaption: { set() {} }, recordManipulation() {},
    fitAppearanceInWorker: async options => { solves++; return solveAppearanceFit(options); },
    assertReady() {}, assertContext() {}, cancelXrPlacementFollowup() {}, invalidateGesturePivot() {},
    awaitPlacementViews: async () => {}, syncInspectionPayload() {}, restoreInspectionPayload() {}, restoreCompanion: async () => {}, showRetainedPose() {},
    applyInspectionTransform: () => { object.values.aTransform.ref.value = matrix(inspection.snapshot().placement); },
    componentLabels: { active: () => false }, volume: {}, findCurrentStructureRepresentation: () => undefined,
    lessonResting: { labelsEnabled: () => false, setLabelsEnabled() {} }, snapshot: () => inspection.snapshot(),
    colorOnlyAppearanceChange: () => false, inspectionLayersIntact: () => true,
    inspectionMutation: async (operation, options) => {
      const checkpoint = inspection.checkpoint();
      try { await operation(); if (failRender) throw Error('render_failed'); return inspection.snapshot(); }
      catch (error) { inspection.restoreCheckpoint(checkpoint); c.applyInspectionTransform(); await options?.rollback?.(); throw error; }
    },
    // Compound admission uses the real transaction/state and final fit above.
    compoundOps: value => value, selectedKeys: value => value, selectionLayersUnchanged: () => true,
    emphasisState: {}, emphasisOrigin: null, stylesState: [], visibilityState: {},
    completeInspectionCapture: () => inspection.snapshot(), selectionLayerStamp: () => 'settled',
    rebuildInspectionLabels: async () => {}, rebuildComponentLabels: async () => {}, inspectionPayload: () => null,
  });
  vm.runInContext(`${intent}\n${clear}\n${place}\n${configure}\n${compound}\n${undo}\n${redo}
    async function applyInspectionAppearance({explicitPlacement = false, preservePlacement = false, signal} = {}) {
      const recoverWithoutFit = false, hiddenCells = [], check = () => {};
      applyInspectionTransform();
      ${admission}
    }
    globalThis.api = {placeInspection, configureInspection, applyCompoundInspection, undoInspection, redoInspection};`, c);
  return { ...c.api, c, inspection, hold, object, points, context, setFailRender: value => { failRender = value; }, solves: () => solves };
}

for (const scale of [.5, 20]) test(`explicit ${scale}x agent pose survives rendered appearance rebuilds exactly`, async () => {
  const h = harness(), requested = pose(scale), vertices = h.object.values.aPosition.ref.value;
  await h.placeInspection(requested);
  assert.deepEqual(h.inspection.snapshot().placement, requested);
  assert.equal(h.hold.state().reason, 'agent-placement');
  await h.configureInspection({ representation: 'spacefill' });
  await h.configureInspection({ representation: 'molecular-surface' });
  assert.deepEqual(h.inspection.snapshot().placement, requested);
  assert.equal(h.solves(), 3, 'every changed silhouette still passes real stereo menu clearance');
  assert.equal(h.object.values.aPosition.ref.value, vertices, 'renderer retains the same geometry buffer');
  assert.equal(h.object.values.drawCount.ref.value, 36, 'no geometry reduction');
});

test('20x explicit pose bypasses gaze framing but not the actual menu collision', async () => {
  const h = harness(), before = h.inspection.checkpoint();
  await assert.rejects(h.placeInspection({ ...pose(20), translation: [0, 0, -12] }), /would cover the menu/);
  assert.deepEqual(h.inspection.checkpoint(), before);
  assert.equal(h.hold.holdsPlacement(), false, 'a refused pose does not acquire room intent');
});

test('a later colliding silhouette refuses and retains the accepted pose and appearance', async () => {
  const h = harness(); await h.placeInspection(pose(20));
  const before = h.inspection.checkpoint();
  // The rebuilt representation extends far enough left to intersect the glass.
  h.object.values.aPosition.ref.value = new Float32Array([-1.5, -.4, -.4, .4, .4, .4]);
  h.object.values.uVertexCount.ref.value = 2;
  await assert.rejects(h.configureInspection({ representation: 'spacefill' }), /would cover the menu/);
  assert.deepEqual(h.inspection.checkpoint(), before);
  assert.equal(h.hold.holdsPlacement(), true);
});

for (const appearance of [false, true]) test(`compound explicit placement ${appearance ? 'with' : 'without'} appearance preserves 20x`, async () => {
  const h = harness(), ops = [{ kind: 'placement', patch: pose(20) }];
  if (appearance) ops.push({ kind: 'appearance', patch: { representation: 'spacefill' } });
  await h.applyCompoundInspection(ops);
  assert.deepEqual(h.inspection.snapshot().placement, pose(20));
  assert.equal(h.hold.state().reason, 'agent-placement');
  await h.configureInspection({ representation: 'molecular-surface' });
  assert.equal(h.inspection.snapshot().placement.scale, 20);
});

test('failed rendered admission acquires no hold, including compound edits', async () => {
  for (const compound of [false, true]) {
    const h = harness(), before = h.inspection.checkpoint(); h.setFailRender(true);
    await assert.rejects(compound ? h.applyCompoundInspection([{ kind: 'placement', patch: pose(20) },
      { kind: 'appearance', patch: { representation: 'spacefill' } }]) : h.placeInspection(pose(20)), /render_failed/);
    assert.deepEqual(h.inspection.checkpoint(), before);
    assert.equal(h.hold.holdsPlacement(), false);
  }
});

test('a colliding compound refuses the complete placement and appearance transaction', async () => {
  const h = harness(), before = h.inspection.checkpoint();
  await assert.rejects(h.applyCompoundInspection([
    { kind: 'placement', patch: { ...pose(20), translation: [0, 0, -12] } },
    { kind: 'appearance', patch: { representation: 'spacefill' } },
  ]), /would cover the menu/);
  assert.deepEqual(h.inspection.checkpoint(), before);
  assert.equal(h.hold.holdsPlacement(), false);
});

test('history replay of a previously clear explicit pose preserves its full transform', async () => {
  const h = harness();
  await h.placeInspection(pose(20));
  const before = h.inspection.snapshot().placement;
  await h.placeInspection(pose(.5));
  await h.placeInspection(before);
  assert.deepEqual(h.inspection.snapshot().placement, before);
  assert.equal(h.hold.holdsPlacement(), true);
});

test('an explicit pose can move only the menu to a separately checked clear seat', async () => {
  const h = harness(), requested = { ...pose(20), translation: [0, 0, -12] };
  const relocated = [-6, -5].flatMap(x => [-.8, .8].map(y => [x, y, -1.25]));
  h.c.immersiveSession.toolbarRelocationCandidates = () => [{ id: 'clear-side', points: relocated }];
  let moves = 0;
  h.c.immersiveSession.relocateToolbar = async candidate => {
    assert.equal(candidate.id, 'clear-side'); moves++;
    h.points.splice(0, h.points.length, ...candidate.points);
  };
  await h.placeInspection(requested);
  assert.deepEqual(h.inspection.snapshot().placement, requested);
  assert.equal(moves, 1);
  assert.deepEqual(h.points, relocated);
  await h.configureInspection({ representation: 'spacefill' });
  assert.deepEqual(h.inspection.snapshot().placement, requested);
});

test('automatic placement still uses the framing solver and does not acquire an explicit hold', async () => {
  const h = harness(); await h.placeInspection(pose(20), 'journey-end');
  assert.ok(h.inspection.snapshot().placement.scale < 20, 'automatic fit retains its gaze framing policy');
  assert.equal(h.hold.holdsPlacement(), false);
});

test('desktop explicit placement needs neither XR clearance nor session hold', async () => {
  const h = harness({ presenting: false }); await h.placeInspection(pose(20));
  assert.deepEqual(h.inspection.snapshot().placement, pose(20));
  assert.equal(h.hold.holdsPlacement(), false);
  assert.equal(h.solves(), 0);
});

test('placement undo releases only agent intent; redo restores exact giant pose and authored hold', async () => {
  const h = harness(), original = h.inspection.snapshot().placement;
  await h.placeInspection(pose(20));
  await h.undoInspection();
  assert.deepEqual(h.inspection.snapshot().placement, original);
  assert.equal(h.hold.holdsPlacement(), false);
  h.hold.chapterStart();
  assert.equal(h.hold.allowsChapterFraming(), true);
  const workspace = { snapshot: () => ({ atomCount: 8 }), viewer: { inspection: { place: h.placeInspection, holdsWearerPlacement: () => h.hold.holdsPlacement() } } };
  await applyTourStep(workspace, { id: 'authored', title: 'Authored chapter', placement: { ...pose(.5), translation: [.6, 1.1, -3] } }, () => true, false, 1000);
  assert.equal(h.inspection.snapshot().placement.scale, .5, 'real authored chapter is no longer suppressed');
  assert.notDeepEqual(h.inspection.snapshot().placement, original, 'automatic chapter framing is still allowed');
  // Host redo restores the placement edit, even after that automatic chapter.
  await h.placeInspection(pose(20), 'place', { preservePlacement: true });
  assert.deepEqual(h.inspection.snapshot().placement, pose(20));
  assert.equal(h.hold.holdsPlacement(), true);
  assert.equal(h.hold.state().moves, 1, 'redo restores ownership instead of taking over again');
});

test('remote compound history follows multiple exact pose transitions in both directions', async () => {
  const h = harness(), original = h.inspection.snapshot().placement;
  await h.placeInspection(pose(20)); await h.placeInspection(pose(.5));
  const replay = placement => h.applyCompoundInspection([{ kind: 'placement', patch: placement }], { preservePlacement: true });
  await replay(pose(20)); assert.equal(h.hold.state().reason, 'agent-placement');
  await replay(original); assert.equal(h.hold.holdsPlacement(), false);
  await replay(pose(20)); assert.equal(h.hold.holdsPlacement(), true);
  await replay(pose(.5)); assert.equal(h.hold.state().moves, 2);
});

test('undo restores a prior physical hold and never releases a newer physical owner', async () => {
  const h = harness(); h.hold.takeover('grab');
  await h.placeInspection(pose(20)); await h.undoInspection();
  assert.equal(h.hold.state().reason, 'grab'); assert.equal(h.hold.holdsPlacement(), true);
  await h.redoInspection(); h.hold.takeover('menu'); await h.undoInspection();
  assert.equal(h.hold.state().reason, 'menu'); assert.equal(h.hold.holdsPlacement(), true);
});

test('source/model/assembly and XR-session changes invalidate agent history without dropping physical intent', async () => {
  for (const field of ['source', 'session']) {
    const h = harness(); await h.placeInspection(pose(20));
    h.context[field] = field === 'source' ? 'same-sha:2:assembly-2' : {};
    await h.undoInspection();
    assert.equal(h.hold.holdsPlacement(), true, field);
  }
});

test('same-pose agent and compound requests do not take placement ownership', async () => {
  const h = harness(), original = h.inspection.snapshot().placement;
  await h.placeInspection(original, 'place', { preservePlacement: true });
  // Use a clear original pose, placed by an automatic/entry path.
  await h.placeInspection(pose(.5), 'entry-seat');
  await h.placeInspection(pose(.5));
  await h.applyCompoundInspection([{ kind: 'placement', patch: pose(.5) }, { kind: 'appearance', patch: { background: '#000000' } }]);
  assert.equal(h.hold.holdsPlacement(), false); assert.equal(h.hold.state().moves, 0);
});

test('failed history draw leaves the accepted agent owner intact', async () => {
  const h = harness(); await h.placeInspection(pose(20)); h.setFailRender(true);
  await assert.rejects(h.undoInspection(), /render_failed/);
  assert.deepEqual(h.inspection.snapshot().placement, pose(20));
  assert.equal(h.hold.state().reason, 'agent-placement');
});

test('menu nudge takes one physical takeover instead of agent plus physical ownership', async () => {
  const start = source.indexOf("          if (action.kind === 'nudge') {"), end = source.indexOf("\n          }", start) + 12;
  assert.ok(start >= 0 && end > start);
  const h = harness(); await h.placeInspection(pose(.5), 'entry-seat');
  const nudge = vm.runInContext(`(async action => { const current = inspectionSnapshot(); ${source.slice(start, end)} })`, h.c);
  h.c.clampPlacementTranslation = value => value;
  await nudge({ kind: 'nudge', mode: 'move', axis: 'x', direction: 1 });
  assert.equal(h.hold.state().reason, 'menu'); assert.equal(h.hold.state().moves, 1);
});
