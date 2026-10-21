import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { Euler } from 'molstar/lib/mol-math/linear-algebra/3d/euler.js';
import { Sphere3D } from 'molstar/lib/mol-math/geometry/primitives/sphere3d.js';
import { ValueCell } from 'molstar/lib/mol-util/value-cell.js';
import { createTransform } from 'molstar/lib/mol-geo/geometry/transform-data.js';
import { Visual } from 'molstar/lib/mol-repr/visual.js';
import { createXrManipulation, moleculeGrabDistance, oneHandScaleFactor, GRAB_REJECTED, MANIPULATION_FRAME_GAP_MS, TRIGGER_HOLD_MS } from './xr-manipulate.mjs';
import { createXrGrabFeedback } from './xr-grab-feedback.mjs';
import { createXrThumbstick, STICK_METRES_PER_SECOND, STICK_DEGREES_PER_SECOND } from './xr-buttons.mjs';
import { STICK_MODE } from './xr-locomotion.mjs';
import { createInspectionState, normalizePlacement } from './inspection-state.mjs';
import { pivotPreservingTranslation } from './presentation-pivot.mjs';
import { createGesturePivot } from './gesture-pivot.mjs';
import { createTriggerStickIntent } from './trigger-stick-intent.mjs';
import { wearerAxesFrom } from './wearer-axes.mjs';
import { clampPlacementScale, PLACEMENT_MAX_SCALE, PLACEMENT_MAX_TRANSLATION } from './placement-limits.mjs';
import { companionTransform } from './companion-structure.mjs';
import { updatePlacementBounds } from './placement-bounds.mjs';
import { sizeImmersiveAnnotation } from './immersive-annotations.mjs';

const source = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
function harness({ legacy = false, limited = false } = {}) {
  const counts = { transforms: 0, bounds: 0, updates: 0 }, summaries = [], events = [], sources = new Map();
  let clock = 0;
  const placement = { translation: limited ? [PLACEMENT_MAX_TRANSLATION - .01, 0, 0] : [.7, -.2, -.9],
    rotation: [12, 24, 6], scale: limited ? PLACEMENT_MAX_SCALE - .01 : 12 };
  const sphere = { center: [0, 0, 0], radius: 2 };
  function representation() {
    const invariant = Sphere3D.create(Vec3.create(.2, 0, 0), 1);
    const object = { state: { visible: true }, values: {
      ...createTransform(new Float32Array([...Mat4.identity(), ...Mat4.identity()]), 2, invariant, 0, 0),
      invariantBoundingSphere: ValueCell.create(invariant), boundingSphere: ValueCell.create(Sphere3D.clone(invariant)),
      drawCount: ValueCell.create(3),
    } };
    return { renderObjects: [object], setState: ({ transform }) => { counts.transforms++; Visual.setTransform(object, transform); } };
  }
  const representations = Array.from({ length: 8 }, representation);
  const h = vm.createContext({ roomEntry: undefined, appearanceWork: undefined, AbortController, focusPivotRequest: undefined, gesturePivot: createGesturePivot(), xrPlacementFollowup: undefined, now: () => clock, Mat4, Vec3, GRAB_REJECTED, PLACEMENT_MAX_TRANSLATION, clampPlacementScale,
    companionTransform, moleculeGrabDistance,
    inspectionState: { placement: () => structuredClone(placement) }, inspectionSnapshot: () => ({ placement }),
    loadedSphere: () => sphere, pivotCenter: () => [.5, .25, -.1], // off-center visible stage
    canvas: { camera: { scale: .5 }, update: (_repr, keepSphere) => { assert.equal(keepSphere, false); counts.updates++; } },
    canManipulateNow: () => true, grabRotation: undefined, grabOffset: undefined, grabScale: 1,
    xrTransformBatchDepth: 0, xrTransformPending: false,
    pendingGrowthTurn: true, motionAngle: 0,
    representation: { obj: {} }, scientificRepresentations: () => representations.slice(0, 4),
    componentLabelRepresentations: () => representations.slice(4, 6), componentLabels: { refs: () => [] },
    lessonFigure: { annotations: () => [representations[6]] },
    companionRecord: { representation: { obj: { data: { repr: representations[7] } } },
      structure: { obj: { data: { boundary: { sphere } } } },
      companionState: { placement: { translation: [2, 0, 0], rotation: [0, 15, 0], scale: .7 } } },
    updatePlacementBounds: repr => { counts.bounds++; updatePlacementBounds(repr); },
    recordManipulation: (kind, detail) => events.push({ kind, ...plain(detail) }),
    spatialOwnedHands: new Set(), immersiveSession: {}, visibleStage: false, sourceRecord: {}, triggerStickIntent: undefined,
    latestRoomPlacementPose: null, xrInputHeadInRoom: undefined, latestHeadSample: 0, performance: { now: () => clock },
    talkCaption: { set() {} }, signalManualInteraction() {}, pausePresentationForInput: async () => {},
    createXrGrabFeedback, state: { status: 'ready' }, speakOutcome() {}, xrDeferredGrab: undefined,
    flushXrDeferredGrab: () => summaries.push(plain(h.xrDeferredGrab)),
    createXrManipulation: options => {
      if (legacy) {
        delete options.onDelta;
        options.onRotate = rotation => h.applyGrabDelta({ rotation });
        options.onTranslate = translation => h.applyGrabDelta({ translation });
        options.onScale = scale => h.applyGrabDelta({ scale });
      }
      return createXrManipulation({ ...options, now: () => clock, pulse() {}, record: h.recordManipulation });
    },
  });
  for (const name of ['cancelXrPlacementFollowup', 'invalidateGesturePivot', 'gesturePivotContext', 'beginGesturePivot', 'gesturePivotCenter', 'grabPivotBounds', 'startXrPlacementFollowup', 'placementTransform', 'grabTransform', 'presentationTransform', 'applyInspectionTransform', 'applyGrabDelta', 'gripTargetDepthAxis']) {
    const start = source.search(new RegExp(`  (?:async )?function ${name}\\(`));
    assert.ok(start >= 0, name);
    vm.runInContext(source.slice(start, source.indexOf('\n  }', start) + 4), h);
  }
  // Execute the production viewer hookup, so accidentally retaining the three
  // per-component callbacks would fail the operation-count assertion.
  const start = source.indexOf('    const grabFeedback = createXrGrabFeedback({');
  const end = source.indexOf('\n    xrButtons =', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(source.slice(start, end), h);
  function pointer(hand, x, { held = true, angle = 0, quality } = {}) {
    if (!sources.has(hand)) sources.set(hand, { handedness: hand, targetRayMode: 'tracked-pointer' });
    return { handedness: hand, source: sources.get(hand), buttons: held ? 2 : 0,
      ...(quality ? { positionQuality: quality } : {}),
      ray: { origin: [x, 1.4, 0], direction: [Math.sin(angle), 0, -Math.cos(angle)] } };
  }
  return { h, counts, summaries, events, placement, representations, pointer,
    now: () => clock,
    frame: (pointers, elapsed = 14) => { clock += elapsed; (h.updateXrManipulation ?? h.xrManipulation.update)(pointers); },
    transform: () => Array.from(h.presentationTransform()),
  };
}
function runGesture(t, kind) {
  const { pointer: p, frame } = t;
  frame([p('right', .2)]);
  if (kind === 'scale') frame([p('right', .2), p('left', -.2)]);
  for (let i = 1; i <= 20; i++) {
    const midpoint = .01 * i;
    if (kind === 'scale') {
      const span = .4 * 1.01 ** i;
      frame([p('right', midpoint + span / 2), p('left', midpoint - span / 2)]);
    } else frame([p('right', .2 + midpoint, { angle: i * .01 })]);
  }
  frame([p('right', .4, { held: false }), p('left', -.2, { held: false })]);
}

for (const kind of ['grab', 'scale']) for (const limited of [false, true]) {
  test(`${kind} with limits=${limited}: one transform pass per measured step, identical rendered pose and release`, () => {
    const batched = harness({ limited }), legacy = harness({ legacy: true, limited });
    runGesture(batched, kind); runGesture(legacy, kind);
    assert.deepEqual(batched.transform(), legacy.transform());
    assert.deepEqual(batched.summaries, legacy.summaries);
    assert.deepEqual(batched.events, legacy.events);
    assert.equal(batched.summaries.length, 1);
    assert.deepEqual(batched.counts, { transforms: 160, bounds: 160, updates: 160 });
    assert.deepEqual(legacy.counts, { transforms: 320, bounds: 320, updates: 320 });
    for (let i = 0; i < batched.representations.length; i++) {
      const actual = batched.representations[i].renderObjects[0].values;
      const previous = legacy.representations[i].renderObjects[0].values;
      assert.deepEqual(actual.aTransform.ref.value, previous.aTransform.ref.value);
      assert.deepEqual(actual.boundingSphere.ref.value, previous.boundingSphere.ref.value);
    }
  });
}

test('menu capture, tracking gaps, release recovery and stationary frames keep their existing behavior', () => {
  const batched = harness(), legacy = harness({ legacy: true });
  for (const t of [batched, legacy]) {
    const { frame, pointer: p, h } = t;
    h.spatialOwnedHands.add('right'); frame([p('right', .2)]);
    frame([p('right', .3, { angle: .1 })]);
    assert.equal(t.counts.transforms, 0, 'claimed menu hand never transforms');
    h.spatialOwnedHands.clear();
    frame([p('right', .3, { held: false })]); frame([p('right', .3)]);
    frame([p('right', .3)]); assert.equal(t.counts.transforms, 0, 'still hand produces no flush');
    frame([p('right', .32, { angle: .1 })]);
    const count = t.counts.transforms;
    frame([p('right', .7, { angle: .6 })], MANIPULATION_FRAME_GAP_MS + 1);
    frame([p('right', .8, { angle: .7 })]);
    assert.equal(t.counts.transforms, count, 'suspended input requires a physical release');
    frame([p('right', .8, { held: false })]); frame([p('right', .8)]);
    frame([p('right', .82, { angle: .1 })]); frame([p('right', .82, { held: false })]);
  }
  assert.deepEqual(batched.transform(), legacy.transform());
  assert.deepEqual(batched.events, legacy.events);
  assert.deepEqual(batched.summaries, legacy.summaries);
  assert.equal(batched.counts.transforms * 2, legacy.counts.transforms);
});

function combinedHarness({ batched, limited }) {
  const t = harness({ limited }), h = t.h;
  const inspection = createInspectionState(); inspection.place(t.placement);
  Object.assign(h, {
    inspectionState: inspection, inspectionSnapshot: () => inspection.snapshot(),
    STICK_MODE, STICK_METRES_PER_SECOND, STICK_DEGREES_PER_SECOND, oneHandScaleFactor, normalizePlacement, pivotPreservingTranslation, Euler,
    xrInputBlind: false, xrDeferredBake: undefined, naturalInput: undefined,
    POINTER_TRIGGER: 1, lastTriggerHand: undefined, lastTriggerAt: 0, performance: { now: t.now },
    xrButtons: { update() {} }, stickModifiers: { mode: () => STICK_MODE.depthYaw, update() {}, engaged: () => true },
    wearerAxes: () => ({ right: Vec3.create(1, 0, 0), up: Vec3.create(0, 1, 0), forward: Vec3.create(0, 0, -1) }),
    busy: false, state: { status: 'ready' }, syncInspectionPayload() {}, takeWearerPlacement() {},
    mutate: async (_kind, callback) => { callback(); return true; },
  });
  h.canvas.webgl = { isContextLost: false }; h.canvas.xr = { isPresenting: { value: false } };
  h.componentLabels.active = () => false; h.talkCaption.frame = () => {};
  for (const name of ['batchXrTransforms', 'updateXrManipulation', 'updateXrManipulationNow',
    'applyStickAxis', 'applyStickPush', 'applyStickForHand', 'rotationFromPlacement', 'rotationDegreesZYX', 'pivotBounds', 'bakeGrab']) {
    const start = source.search(new RegExp(`  (?:async )?function ${name}\\(`));
    assert.ok(start >= 0, name);
    vm.runInContext(source.slice(start, source.indexOf('\n  }', start) + 4), h);
  }
  if (!batched) h.batchXrTransforms = callback => callback();
  h.xrThumbstick = createXrThumbstick({ hand: 'right', now: t.now,
    onMove: deflection => h.applyStickForHand('right', deflection) });
  h.xrPushStick = createXrThumbstick({ hand: 'left', now: t.now,
    onMove: deflection => h.applyStickForHand('left', deflection) });
  return { ...t, inspection };
}

for (const limited of [false, true]) test(`ray plus depth plus yaw flush once with identical clamped pose, buffers and committed placement; limits=${limited}`, async () => {
  const actual = combinedHarness({ batched: true, limited }), baseline = combinedHarness({ batched: false, limited });
  for (const t of [actual, baseline]) {
    const pointer = (step, axes = [0, 0, 0, 0]) => ({ ...t.pointer('right', .2 + step * .012), buttons: 1, axes });
    t.frame([pointer(0)]); t.frame([pointer(0)], TRIGGER_HOLD_MS);
    const before = t.counts.updates;
    for (let step = 1; step <= 20; step++) t.frame([pointer(step, [0, 0, .8, -.7])]);
    t.movingUpdates = t.counts.updates - before;
  }
  assert.equal(actual.movingUpdates, 20 * 8, 'one final upload per representation per input frame');
  assert.equal(baseline.movingUpdates, 3 * actual.movingUpdates, 'ray, depth, yaw each uploaded in the previous sequence');
  assert.deepEqual(actual.transform(), baseline.transform());
  for (let i = 0; i < actual.representations.length; i++) {
    const a = actual.representations[i].renderObjects[0].values, b = baseline.representations[i].renderObjects[0].values;
    assert.deepEqual(a.aTransform.ref.value, b.aTransform.ref.value);
    assert.deepEqual(a.boundingSphere.ref.value, b.boundingSphere.ref.value);
  }
  await actual.h.bakeGrab({ phase: 'grab' }); await baseline.h.bakeGrab({ phase: 'grab' });
  assert.deepEqual(actual.inspection.placement(), baseline.inspection.placement());
  assert.deepEqual(actual.transform(), baseline.transform());
  assert.equal(actual.h.grabOffset, undefined, 'committing clears the transient once');
});

test('throwing input still flushes its accepted transient and leaves no batching state behind', () => {
  const t = combinedHarness({ batched: true });
  assert.throws(() => t.h.batchXrTransforms(() => {
    t.h.applyGrabDelta({ translation: [.02, 0, 0] }); throw Error('next input failed');
  }), /next input failed/);
  assert.equal(t.counts.updates, 8);
  assert.equal(t.h.xrTransformBatchDepth, 0);
  assert.equal(t.h.xrTransformPending, false);
  t.h.applyGrabDelta({ translation: [.02, 0, 0] });
  assert.equal(t.counts.updates, 16);
});

test('production transform timing brackets one flushed pass and closes even if a representation throws', () => {
  const t = combinedHarness({ batched: true });
  let starts = 0, finishes = 0;
  t.h.immersiveSession = {
    beginTransform() { starts++; return 42; },
    endTransform(value) { assert.equal(value, 42); finishes++; },
  };
  t.h.batchXrTransforms(() => {
    t.h.applyGrabDelta({ translation: [.01, 0, 0] });
    t.h.applyGrabDelta({ translation: [0, .02, 0] });
  });
  assert.equal(starts, 1); assert.equal(finishes, 1);
  t.representations[0].setState = () => { throw Error('renderer unavailable'); };
  assert.throws(() => t.h.applyInspectionTransform(), /renderer unavailable/);
  assert.equal(starts, 2); assert.equal(finishes, 2);
});

test('production viewer intent wiring keeps the rotation pivot and size fixed through incidental wrist/pull plus horizontal stick', () => {
  const t = combinedHarness({ batched: true }), h = t.h;
  h.createTriggerStickIntent = createTriggerStickIntent;
  const start = source.indexOf('    triggerStickIntent = createTriggerStickIntent({');
  vm.runInContext(source.slice(start, source.indexOf('    const grabFeedback = createXrGrabFeedback({', start)), h);
  const pointer = (step, axes) => ({ ...t.pointer('right', .2 + step * .001, { angle: step * Math.PI / 180 }),
    buttons: 1, axes, ray: { origin: [.2, 1.4, step * .001], direction: [Math.sin(step * Math.PI / 180), 0, -Math.cos(step * Math.PI / 180)] } });
  t.frame([pointer(0, [0, 0, 0, 0])]); t.frame([pointer(0, [0, 0, 0, 0])], TRIGGER_HOLD_MS);
  const pivot = Vec3.transformMat4(Vec3(), [.5, .25, -.1], h.presentationTransform());
  const before = t.counts.updates;
  h.inspectionSnapshot = () => assert.fail('held movement must not clone the whole inspection');
  for (let step = 1; step <= 10; step++) t.frame([pointer(step, [0, 0, .8, .2])]);
  assert.equal(h.triggerStickIntent.lane('right'), 'yaw');
  assert.equal(t.counts.updates - before, 10 * 8, 'one actual transform per representation per frame');
  assert.equal(h.grabOffset, undefined, 'wrist ray transport and incidental vertical stick do not translate');
  assert.equal(h.grabScale, 1);
  assert.ok(h.grabRotation, 'the intended yaw still turns the molecule');
  const after = Vec3.transformMat4(Vec3(), [.5, .25, -.1], h.presentationTransform());
  assert.ok(Vec3.distance(pivot, after) < 1e-9, 'the off-center visible-stage pivot stays fixed');
  for (const repr of t.representations.slice(0, 7))
    assert.deepEqual(Array.from(repr.renderObjects[0].values.matrix.ref.value), Array.from(h.presentationTransform()));
  t.frame([pointer(11, [0, 0, 0, 0])]);
  assert.equal(h.grabOffset, undefined, 'recentering rebases without a delayed ray jump');
  t.frame([pointer(12, [0, 0, 0, 0])]);
  assert.ok(h.grabOffset, 'new neutral-stick ray travel resumes normally');
});

test('the actual input callback uses fresh head axes, leaves drawn evidence untouched, and releases its borrowed pose', () => {
  const t = combinedHarness({ batched: true }), h = t.h;
  const previousHead = Mat4.identity(), freshHead = Mat4.fromRotation(Mat4(), Math.PI / 2, Vec3.create(0, 1, 0));
  freshHead[12] = 2; freshHead[13] = 3; freshHead[14] = 4;
  h.latestRoomPlacementPose = { headInRoom: previousHead, labelViews: ['drawn eye evidence'] };
  h.canvas.camera.view = Mat4.fromTranslation(Mat4(), [1, 1, 1]); h.wearerAxesFrom = wearerAxesFrom;
  const plateStart = source.indexOf('  const plateEyeInverse =');
  const plateEnd = source.indexOf('\n  }', plateStart) + 4;
  vm.runInContext(source.slice(plateStart, plateEnd), h);
  const start = source.indexOf('  function wearerAxes(');
  vm.runInContext(source.slice(start, source.indexOf('\n  }', start) + 4), h);
  let reads = 0, plateUpdates = 0;
  Object.assign(h, { latestXrSpace: undefined, naturalInput: undefined, XRRigidTransform: class {}, capDrawnPlates() {},
    sizeImmersiveAnnotation(repr, canvas, eye) {
      plateUpdates++;
      assert.equal(h.xrInputHeadInRoom, undefined, 'frame-owned head pose is released before plate sizing');
      assert.deepEqual(Array.from(eye), [2, 4, 6], 'fresh head position is transformed from room to scene units');
      return sizeImmersiveAnnotation(repr, canvas, eye);
    },
    molecularAnimation: { tick() {}, tetherRepresentations: () => [] }, flushXrDeferredGrab() {},
    xrControllerInput: { read() { reads++; return []; } },
    processXrPointers() {
      assert.equal(h.xrInputHeadInRoom, freshHead);
      const { right, up, forward } = wearerAxesFrom({ roomToRender: Mat4.identity(), headInRoom: freshHead });
      assert.deepEqual(plain(h.wearerAxes()), plain({ right, up, forward }));
      assert.equal(h.latestRoomPlacementPose.headInRoom, previousHead);
      assert.deepEqual(h.latestRoomPlacementPose.labelViews, ['drawn eye evidence']);
    },
  });
  const from = source.indexOf('      onInputFrame:');
  const callback = vm.runInContext('({' + source.slice(from, source.indexOf('      onHeadFrame:', from)) + '}).onInputFrame', h);
  callback({ frame: { getViewerPose: () => ({ transform: { matrix: freshHead } }) }, space: { getOffsetReferenceSpace: () => ({}) } });
  assert.equal(reads, 1);
  assert.equal(plateUpdates, 1);
  assert.equal(h.xrInputHeadInRoom, undefined);
  h.processXrPointers = () => { throw Error('input failed'); };
  assert.throws(() => callback({ frame: { getViewerPose: () => ({ transform: { matrix: freshHead } }) }, space: { getOffsetReferenceSpace: () => ({}) } }), /input failed/);
  assert.equal(h.xrInputHeadInRoom, undefined, 'a failure cannot leak a frame-owned matrix');
  assert.equal(plateUpdates, 2, 'plates still receive the fresh eye when input throws');
});

test('missing second-hand pose cannot dispatch a partial scale delta', () => {
  const t = harness(), p = t.pointer;
  t.frame([p('right', .2)]); t.frame([p('right', .2), p('left', -.2)]);
  t.frame([p('right', .3), { ...p('left', -.3), ray: undefined }]);
  assert.equal(t.counts.transforms, 0);
  t.frame([p('right', .4), p('left', -.4)]);
  assert.equal(t.counts.transforms, 0, 'first fully tracked frame rebases');
  t.frame([p('right', .5), p('left', -.3)]);
  assert.equal(t.counts.transforms, 8, 'recovered pure translation flushes once');
});

test('legacy callbacks keep rotation-before-translation order when the combined callback is omitted', () => {
  const calls = [], source = { handedness: 'right' };
  const input = createXrManipulation({ now: () => 0, pulse() {}, record() {},
    onRotate: () => calls.push('rotate'), onTranslate: () => calls.push('translate'), onScale: () => calls.push('scale') });
  const pointer = (x, direction) => ({ handedness: 'right', source, buttons: 2, ray: { origin: [x, 0, 0], direction } });
  input.update([pointer(0, [0, 0, -1])]); input.update([pointer(.1, [.1, 0, -1])]);
  assert.deepEqual(calls, ['rotate', 'translate']);
});

test('carrying an assistant-sized close-up does not resize it on release', async () => {
  const t = combinedHarness({ batched: true, limited: false });
  t.h.roomEntry = { seat: { scale: 1 } };
  const before = t.inspection.placement();
  assert.equal(before.scale, 12, 'an intentional assistant close-up may exceed the wearer resize range');
  t.h.applyGrabDelta({ translation: [.02, 0, 0] });
  await t.h.bakeGrab({ phase: 'grab' });
  assert.equal(t.inspection.placement().scale, before.scale);
  assert.notDeepEqual(t.inspection.placement().translation, before.translation);
});

for (const input of ['grip', 'stick']) for (const authored of [12, .05, 2.6]) for (const direction of [-1, 1]) {
  test(`${input} resize ${direction} from authored scale ${authored} is gradual, directional and stable on release`, async () => {
    const t = combinedHarness({ batched: true, limited: false }), h = t.h;
    h.roomEntry = { seat: { scale: 1 } };
    t.inspection.place({ scale: authored });
    h.stickModifiers.mode = () => STICK_MODE.scale;
    const p = t.pointer;
    for (let gesture = 0; gesture < 3; gesture++) {
      let span = .4;
      const pointers = () => input === 'grip' ? [p('right', span / 2), p('left', -span / 2)]
        : [{ ...p('right', .2), axes: [0, 0, 0, -direction * .5] }];
      if (input === 'grip') t.frame([p('right', span / 2)]);
      t.frame(pointers());
      for (let step = 0; step < 10; step++) {
        const before = t.inspection.placement().scale * h.grabScale;
        const pivot = Vec3.transformMat4(Vec3(), [.5, .25, -.1], h.presentationTransform());
        span *= 1.01 ** direction;
        t.frame(pointers());
        const after = t.inspection.placement().scale * h.grabScale;
        assert.ok(direction * (after - before) >= -1e-12, `${before} -> ${after} reversed gesture`);
        assert.ok(Math.abs(Math.log(after / before)) < .03, `${before} -> ${after} jumped`);
        if ((before > 5 && direction > 0) || (before < .2 && direction < 0)) assert.equal(after, before);
        else assert.ok(direction * (after - before) > 0, 'movement toward/in the band responds');
        assert.ok(Vec3.distance(pivot, Vec3.transformMat4(Vec3(), [.5, .25, -.1], h.presentationTransform())) < 1e-9);
      }
      const drawn = t.inspection.placement().scale * h.grabScale;
      t.frame([p('right', .2, { held: false }), p('left', -.2, { held: false })]);
      await h.bakeGrab({ phase: input });
      assert.equal(t.inspection.placement().scale, drawn, 'release preserves the drawn scale');
      assert.equal(h.roomEntry.seat.scale, 1, 'authored placement and releases do not rebase the entry');
    }
  });
}
