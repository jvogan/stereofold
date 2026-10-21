import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { Euler } from 'molstar/lib/mol-math/linear-algebra/3d/euler.js';
import { createInspectionState } from './inspection-state.mjs';
import { pointerManipulates } from './presentation-motion.mjs';
import { pivotPreservingTranslation } from './presentation-pivot.mjs';

const source = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
function harness() {
  const inspectionState = createInspectionState();
  inspectionState.place({ rotation: [0, 7.37, 0], translation: [.9, .45, -1.7], scale: 1.1 });
  inspectionState.configure({ labels: true });
  const payload = { selectionKeys: ['source-residue-1'], camera: { position: [0, 0, 100], target: [0, 0, 0] },
    lessonFigure: { id: 'custom-figure', labels: [{ text: 'Active site' }] } };
  inspectionState.setPayload(payload);
  const saved = [], transforms = [], interactions = [], nativeFrames = new Map();
  let nextFrame = 0, drawn;
  const session = { requestAnimationFrame(callback) { const id = ++nextFrame; nativeFrames.set(id, callback); return id; },
    cancelAnimationFrame(id) { nativeFrames.delete(id); } };
  const state = { sourceSha256: 'custom-source-digest', generation: 4, revision: 21, status: 'ready', mutationCounts: { inspection: 0 } };
  const h = vm.createContext({ Mat4, Vec3, Euler, inspectionState, pointerManipulates, pivotPreservingTranslation,
    hostLoadDepth: 0, state, representation: { obj: {} }, canvas: { webgl: { xr: { session }, isContextLost: false }, xr: { isPresenting: { value: true } }, commit() {} },
    motionAngle: 23, motionFrame: undefined, motionFrameScheduler: undefined, motionLastFrame: undefined,
    motionUserPaused: false, motionToolPaused: false, motionMutationPaused: false, motionContextPaused: false,
    motionDocumentPaused: false, motionXrExplicit: true, reducedMotionQuery: undefined, lastMotionNotification: undefined,
    presentationFreeze: undefined, busy: false, motionDegreesPerSecond: () => 12,
    xrInputBlind: false, xrDeferredBake: undefined, xrInputRelease: { filter: pointers => pointers },
    POINTER_TRIGGER: 1, POINTER_GRIP: 2, xrAimUnavailable: false, xrInputHeld: false, manualXrInputHeld: false,
    spatialOwnedHands: new Set(), spatialReleaseUntil: 0, performance: { now: () => 1000 }, queueMicrotask,
    updateXrManipulation() {}, applyImmersiveDepth() {}, talkCaption: undefined,
    signalManualInteraction: kind => interactions.push(kind),
    interactionActive: () => h.xrInputHeld, now: () => 1000,
    inspectionSnapshot: () => inspectionState.snapshot(), inspectionPayload: () => clone(payload),
    pivotBounds: () => ({ baseCenter: [0, 0, 0], radius: 20 }),
    applyInspectionTransform: () => transforms.push({ angle: h.motionAngle, placement: inspectionState.snapshot().placement }),
    assertReady() { assert.equal(state.status, 'ready'); }, assertContext() {},
    failure: (code, message) => Object.assign(Error(message), { code }),
    beginWork: () => ({ finish() {} }), retainCurrent: () => ({}), retainedPoseHidden: false,
    waitForFrame: () => new Promise(resolve => { drawn = resolve; }), recordRenderCost() {},
    snapshot: () => ({ ...state, inspection: inspectionState.snapshot(), payload: clone(payload) }),
    onMutation: snapshot => saved.push(clone(snapshot)), onSelection() {}, onMotionChange() {}, refreshStructureSubject() {},
    detached: clone, console, flushPendingPresentationPick() {},
    // A native immersive session can stop all application window frames.
    requestAnimationFrame() { throw Error('Window animation frames must not be used'); },
    cancelAnimationFrame() { throw Error('Window animation frames must not be used'); },
  });
  for (const name of ['motionReason', 'inspectionMotionSnapshot', 'stopPresentationMotion', 'rotationFromPlacement',
    'rotationDegreesZYX', 'freezePresentationPose', 'pausePresentationForInput', 'processXrPointers',
    'schedulePresentationFrame', 'startPresentationMotion', 'syncPresentationMotion', 'setInspectionMotion', 'emit', 'mutate']) {
    const start = source.search(new RegExp(`  (?:async )?function ${name}\\(`));
    assert.ok(start >= 0, name);
    vm.runInContext(source.slice(start, source.indexOf('\n  }', start) + 4), h);
  }
  return { h, state, inspectionState, payload, saved, transforms, interactions, nativeFrames,
    draw: async () => { await Promise.resolve(); assert.ok(drawn, 'A molecular draw must gate publication'); drawn(); },
    pointer: buttons => [{ handedness: 'right', buttons, axes: [0, 0, 0, 0] }],
  };
}

test('toolbar trigger retains the transient XR pose until Pause bakes and publishes one drawn mutation', async () => {
  const t = harness(), { h, inspectionState, saved } = t;
  const before = inspectionState.checkpoint();
  h.spatialOwnedHands.add('right');
  h.processXrPointers(t.pointer(1));
  await Promise.resolve(); // Toolbar ownership suppresses manual auto-pause.
  assert.equal(h.motionAngle, 23, 'Pressing Pause must not snap back before its action runs');
  assert.deepEqual(inspectionState.checkpoint(), before);
  assert.equal(saved.length, 0);
  h.spatialOwnedHands.clear(); h.spatialReleaseUntil = 1250;
  h.processXrPointers(t.pointer(0));
  const pause = h.setInspectionMotion({ paused: true });
  await Promise.resolve();
  assert.equal(saved.length, 0, 'An undrawn bake is not published');
  await t.draw(); await pause;
  assert.equal(saved.length, 1);
  assert.equal(t.state.revision, 22);
  const after = inspectionState.checkpoint();
  assert.ok(Math.abs(after.current.placement.rotation[1] - 30.37) < 1e-9);
  assert.deepEqual(after.current.placement.translation, before.current.placement.translation);
  assert.equal(after.current.placement.scale, before.current.placement.scale);
  assert.deepEqual(after.current.appearance, before.current.appearance);
  assert.deepEqual(after.current.payload, before.current.payload);
  assert.equal(after.undo.length, before.undo.length + 1);
  assert.equal(saved[0].sourceSha256, 'custom-source-digest');
  assert.equal(h.motionAngle, 0);
  assert.equal(t.nativeFrames.size, 0);
  await h.setInspectionMotion({ paused: true });
  assert.equal(saved.length, 1, 'Repeating Pause must not create another bake');
  inspectionState.undo();
  assert.deepEqual(inspectionState.checkpoint().current, before.current);
});

test('manual controller input retains its angle until the queued automatic pause owns the bake', async () => {
  const t = harness(), { h, saved } = t;
  h.processXrPointers(t.pointer(1));
  assert.equal(h.motionAngle, 23, 'Synchronous pointer processing must retain the angle for its queued pause');
  await Promise.resolve();
  assert.deepEqual(t.interactions, ['xr-controller'], 'Manual interaction is signaled separately from scene publication');
  const freeze = h.presentationFreeze;
  assert.ok(freeze);
  await t.draw(); await freeze;
  assert.equal(saved.length, 1);
  assert.ok(Math.abs(t.inspectionState.snapshot().placement.rotation[1] - 30.37) < 1e-9);
});

test('a toolbar interaction that does not pause resumes from the held transient pose without a save', async () => {
  const t = harness(), { h } = t;
  h.spatialOwnedHands.add('right'); h.processXrPointers(t.pointer(1));
  await Promise.resolve();
  assert.equal(h.motionAngle, 23);
  h.spatialOwnedHands.clear(); h.processXrPointers(t.pointer(0));
  assert.equal(h.motionAngle, 23);
  assert.equal(t.nativeFrames.size, 1);
  const tick = timestamp => {
    const [id, callback] = t.nativeFrames.entries().next().value;
    t.nativeFrames.delete(id); callback(timestamp);
  };
  tick(1000); tick(1050);
  assert.ok(Math.abs(h.motionAngle - 23.6) < 1e-9, 'Native XR frames resume the retained turn');
  assert.equal(t.saved.length, 0);
});

test('mutation, tool, and context stops still reset transient rotation even while input is held', () => {
  for (const flag of ['motionMutationPaused', 'motionToolPaused', 'motionContextPaused']) {
    const t = harness();
    t.h.xrInputHeld = true; t.h[flag] = true;
    t.h.syncPresentationMotion();
    assert.equal(t.h.motionAngle, 0, flag);
    assert.equal(t.saved.length, 0, 'Resetting a transient pose does not publish a scene edit');
  }
});
