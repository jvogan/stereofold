import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { createInspectionState, normalizePlacement } from './inspection-state.mjs';
import { clampPlacementScale, PLACEMENT_MAX_SCALE } from './placement-limits.mjs';
import { pivotPreservingTranslation, drawnCenterInScene } from './presentation-pivot.mjs';
import { createPlacementHold } from './wearer-placement.mjs';
import { createGesturePivot } from './gesture-pivot.mjs';
import { solveAppearanceFit } from './appearance-fit-worker.mjs';
import { resetEntryGeometry, resetEntryLateralBreakdown } from './reset-entry-geometry.mjs';
import { syntheticViews } from './fixtures/component-label-diagnostics.mjs';
import { viewerCallback } from './fixtures/viewer-callback.mjs';

const source = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const cell = value => ({ ref: { value } });
const identity = Array.from(Mat4.identity());
const glass = (left, right) => [left, right].flatMap(x => [1.3, 1.9].map(y => [x, y, -1]));
function harness({ filtered = false, solver = solveAppearanceFit } = {}) {
  const state = createInspectionState(), hold = createPlacementHold(), records = [], fits = [], relocations = [], labels = [];
  state.place({ translation: [.730134459, 1.6, -2], rotation: [10, 35, -20], scale: 1 });
  state.setPayload({ sourceSha256: 'custom-source', selectionKeys: ['A:42'], styles: [{ selectionKeys: ['A:42'], color: '#ff8800' }] });
  const bounds = { baseCenter: [0, 0, 0], visibleCenter: filtered ? [.4, .2, -.1] : [0, 0, 0], radius: 1 };
  const views = syntheticViews().map(view => {
    view.transform.matrix[13] = 1.6; view.transform.inverse.matrix[13] = -1.6; return view;
  });
  const head = [...identity]; head[13] = 1.6;
  let points = glass(.25, .65);
  const candidate = { id: 'left', points: glass(-.8, -.4) };
  const h = vm.createContext({ roomEntry: undefined, now: () => performance.now(), Mat4, Vec3, normalizePlacement, clampPlacementScale, pivotPreservingTranslation,
    sourceRecord: {}, visibleStage: filtered ? {} : undefined, state: { status: 'ready', generation: 1 },
    gesturePivot: createGesturePivot(), focusPivotRequest: undefined, xrPlacementFollowup: undefined,
    inspectionState: state, inspectionSnapshot: () => state.snapshot(), snapshot: () => state.snapshot(),
    assertReady() {}, syncInspectionPayload() {}, applyInspectionTransform() {},
    inspectionMutation: async work => { await work(); return state.snapshot(); },
    runSpatialAction: (_action, work) => work(), onSceneHistoryAction: undefined,
    loadedSphere: () => ({ center: bounds.baseCenter, radius: bounds.radius }), pivotBounds: () => bounds,
    wearerPlacement: hold, recordManipulation: (kind, detail) => records.push({ kind, ...plain(detail) }),
    componentLabels: { active: () => true, relayout: async reason => labels.push(reason) },
    canvas: { xr: { isPresenting: { value: true } }, camera: { scale: 1 }, webgl: { xr: { session: {} } } },
    latestRoomPlacementPose: { headInRoom: head, renderFromRoom: identity, labelViews: views },
    placementViewWaiters: new Set(), talkCaption: { set() {} },
    immersiveSession: { platePoints: () => points, toolbarRelocationCandidates: () => [candidate],
      relocateToolbar: async value => { relocations.push(value.id); points = value.points; } },
    fitAppearanceInWorker: async input => { fits.push(input); return solver(input); },
  });
  for (const name of ['cancelXrPlacementFollowup', 'invalidateGesturePivot', 'placementTransform', 'clearHeldPlatePlacement', 'placeInspection', 'takeWearerPlacement']) {
    const start = source.search(new RegExp(`  (?:async )?function ${name}\\(`));
    assert.ok(start >= 0, name);
    const lineEnd = source.indexOf('\n', start);
    const end = source.slice(start, lineEnd).trimEnd().endsWith('}') ? lineEnd : source.indexOf('\n  }', start) + 4;
    vm.runInContext(source.slice(start, end), h);
  }
  h.presentationTransform = () => h.placementTransform(state.snapshot().placement);
  h.scientificRepresentations = () => [{ renderObjects: [{ type: 'mesh', state: { visible: true }, values: {
    drawCount: cell(24), instanceCount: cell(1), aTransform: cell(h.presentationTransform()),
    aPosition: cell([-.2, .2].flatMap(x => [-.2, .2].flatMap(y => [-.2, .2].flatMap(z =>
      [bounds.visibleCenter[0] + x, bounds.visibleCenter[1] + y, bounds.visibleCenter[2] + z])))),
  } }] }];
  return { h, state, hold, bounds, fits, relocations, records, labels,
    action: vm.runInContext(viewerCallback(source, 'onSpatialAction'), h) };
}

test('Scale + keeps exact wearer translation and rotation, relocating overlapping glass with stereo clearance', async () => {
  const t = harness(), before = t.state.snapshot(), payload = t.state.payload(), camera = plain(t.h.canvas.camera);
  await t.action({ kind: 'scale', direction: 1 });
  const after = t.state.snapshot();
  assert.equal(after.placement.scale, 1.15);
  assert.deepEqual(after.placement.translation, before.placement.translation);
  assert.deepEqual(after.placement.rotation, before.placement.rotation);
  assert.deepEqual(after.appearance, before.appearance);
  assert.deepEqual(t.state.payload(), payload, 'source, selection and style payload survives');
  assert.deepEqual(plain(t.h.canvas.camera), camera, 'tracked camera is untouched');
  assert.deepEqual(t.relocations, ['left'], 'glass yields to the molecule');
  const input = t.fits[0];
  const geometry = resetEntryGeometry({ ...input.geometry, cameraScale: 1, renderFromRoom: identity });
  const proof = resetEntryLateralBreakdown({ geometry, points: t.h.immersiveSession.platePoints(), clearance: 0 });
  assert.ok(proof.eyes.every(eye => eye.separated), 'relocated glass clears the scaled molecule in both eyes');
  assert.equal(t.hold.holdsPlacement(), true);
  assert.deepEqual(t.labels, ['placement']);
  assert.equal(after.history.undoCount, before.history.undoCount + 1);
  t.state.undo(); assert.deepEqual(t.state.snapshot().placement, before.placement);
  t.state.redo(); assert.deepEqual(t.state.snapshot().placement, after.placement);
});

test('a filtered-stage scale uses the grip pivot and leaves the drawn center stationary', async () => {
  const t = harness({ filtered: true }), before = t.state.snapshot().placement;
  const center = drawnCenterInScene({ ...t.bounds, placement: before });
  await t.action({ kind: 'scale', direction: 1 });
  const after = t.state.snapshot().placement;
  assert.notDeepEqual(after.translation, before.translation, 'assembly-origin storage compensates only for the visible pivot');
  assert.deepEqual(after.rotation, before.rotation);
  const nextCenter = drawnCenterInScene({ ...t.bounds, placement: after });
  nextCenter.forEach((value, axis) => assert.ok(Math.abs(value - center[axis]) < 1e-12));
  assert.deepEqual(after.translation, pivotPreservingTranslation(t.bounds, before, after));
});

test('a solver that can only move the molecule refuses scale without losing the scene or adding history', async () => {
  const t = harness({ solver: input => ({ ...input.seat, translation: [.860021005, ...input.seat.translation.slice(1)] }) });
  const before = t.state.snapshot(), payload = t.state.payload();
  await assert.rejects(t.action({ kind: 'scale', direction: 1 }), /cover the menu at your placement/);
  assert.deepEqual(t.state.snapshot(), before);
  assert.deepEqual(t.state.payload(), payload);
  assert.deepEqual(t.relocations, []);
  assert.equal(t.hold.holdsPlacement(), false);
});

test('authored tour placement retains its automatic clearance adjustment', async () => {
  const t = harness({ solver: input => ({ ...input.seat, translation: [.860021005, ...input.seat.translation.slice(1)] }) });
  await t.h.placeInspection({ scale: 1.15 }, 'tour-placement');
  assert.equal(t.state.snapshot().placement.translation[0], .860021005);
  assert.equal(t.fits[0].restoreSaved, false);
  assert.ok(t.records.some(record => record.status === 'adjusted'));
});

test('spoken size steps and clamped scale preserve the chosen whole-structure placement', async () => {
  const t = harness({ solver: input => input.seat });
  const before = t.state.snapshot().placement;
  await t.action({ kind: 'scale', direction: -1, steps: 3 });
  assert.equal(t.state.snapshot().placement.scale, 1.15 ** -3);
  assert.deepEqual(t.state.snapshot().placement.translation, before.translation);
  t.state.place({ scale: PLACEMENT_MAX_SCALE });
  await t.action({ kind: 'scale', direction: 1, steps: 99 });
  assert.equal(t.state.snapshot().placement.scale, PLACEMENT_MAX_SCALE);
  assert.deepEqual(t.state.snapshot().placement.translation, before.translation);
});

for (const authored of [12, .05, 2.6]) for (const direction of [-1, 1]) {
  test(`menu/voice resize ${direction} from authored scale ${authored} respects intent`, async () => {
    const t = harness({ filtered: true, solver: input => input.seat });
    t.h.roomEntry = { seat: { scale: 1 } };
    t.state.place({ scale: authored });
    const before = t.state.placement();
    const pivot = drawnCenterInScene({ ...t.bounds, placement: before });
    await t.action({ kind: 'scale', direction });
    const after = t.state.placement();
    const expected = (authored > 5 && direction > 0) || (authored < .2 && direction < 0)
      ? authored : authored * 1.15 ** direction;
    assert.equal(after.scale, expected);
    const nextPivot = drawnCenterInScene({ ...t.bounds, placement: after });
    nextPivot.forEach((v, axis) => assert.ok(Math.abs(v - pivot[axis]) < 1e-12));
  });
}

test('typed voice scale hook uses the current authored placement and fixed entry band', () => {
  const t = harness();
  t.h.roomEntry = { seat: { scale: 1 } };
  const start = source.indexOf('    clampWearerScale:');
  const end = source.indexOf('\n    configure:', start);
  const clamp = vm.runInContext('({' + source.slice(start, end) + '}).clampWearerScale', t.h);
  for (const authored of [12, .05, 2.6]) {
    t.state.place({ scale: authored });
    assert.equal(clamp(authored * 1.2), authored > 5 ? authored : authored * 1.2);
    assert.equal(clamp(authored / 1.2), authored < .2 ? authored : authored / 1.2);
  }
});
