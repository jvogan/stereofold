import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { pageFunction } from './fixtures/label-action-harness.mjs';
import { createPlacementHold } from './wearer-placement.mjs';
const source = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');

for (const action of ['fitInspection', 'resetOrientation']) test(`${action} releases desktop framing ownership`, async () => {
  const hold = createPlacementHold(); hold.takeover('pointer');
  const camera = { position: [7, 0, 7], target: [0, 0, 0], up: [0, 1, 0] };
  const c = vm.createContext({ Vec3, wearerPlacement: hold, recordManipulation() {}, assertReady() {},
    canvas: { xr: { isPresenting: { value: false } }, requestCameraReset() {}, camera: { getSnapshot: () => camera, setState() {} } },
    molecularAnimation: { envelope: () => undefined }, volume: undefined, molecularBounds: () => undefined, orientationReference: camera,
    inspectionMutation: async action => action(), syncInspectionPayload() {},
    inspectionState: { recordPayload() {}, setPayload() {} }, inspectionPayload: () => ({}), snapshot: () => ({}),
    cancelXrPlacementFollowup() {}, invalidateGesturePivot() {},
  });
  for (const name of ['releaseWearerPlacement', action]) vm.runInContext(pageFunction(source, name), c);
  await c[action](); hold.chapterStart();
  assert.equal(hold.holdsPlacement(), false);
});

test('a successful new source releases ownership; a failed load keeps it', async () => {
  for (const fail of [false, true]) {
    const hold = createPlacementHold(); hold.takeover('pointer');
    let animationSettled = 0;
    const c = vm.createContext({ wearerPlacement: hold, recordManipulation() {}, now: () => 0,
      assertContext() {}, busy: false, appearanceWork: undefined, state: { generation: 1, revision: 1, contextLossCount: 0, mutationCounts: { load: 0 } },
      checkedFixture: async () => ({ source: {}, settings: {} }), interactionActive: () => false,
      cancelXrPlacementFollowup() {}, invalidateGesturePivot() {}, retainCurrent: () => null,
      beginWork: () => ({ done: Promise.resolve(), finish() {} }), inspectionState: null,
      canvas: { camera: { scale: 1 }, xr: { isPresenting: { value: false } }, webgl: { isContextLost: false } },
      currentXrSession() {}, beginSceneTransition: () => ({ finish() {} }), nextTest: {}, activeLoad: undefined,
      coverCurrentFrame() {}, buildCandidate: async () => { if (fail) throw Error('load failed'); return {}; },
      transitionRoomAnchor() {}, companionRecord: undefined, showCandidate: async () => {}, assertLoad() {},
      desktopPreviewCamera: undefined, adopt() {}, deleteRecord: async () => {}, recordRenderCost() {},
      molecularAnimation: { settled: async () => { animationSettled++; } },
      removeFrameCover() {}, snapshot: () => ({}), emit() {}, onMutation() {}, rollbackLoad: async () => {},
    });
    for (const name of ['releaseWearerPlacement', 'load']) vm.runInContext(pageFunction(source, name), c);
    if (fail) await assert.rejects(c.load({}), /load failed/); else await c.load({});
    assert.equal(animationSettled, fail ? 0 : 1, 'only an adopted source reaches its animation cleanup boundary');
    assert.equal(hold.holdsPlacement(), fail);
  }
});

test('volume appearance commit retains an orbit begun while it awaits geometry', async () => {
  const hold = createPlacementHold();
  let live = { position: [0, 0, 10], target: [0, 0, 0], up: [0, 1, 0], radius: 10 };
  const chosen = { position: [7, 0, 7], target: [1, 2, 3], up: [0, 0, 1], radius: 7 };
  let commit;
  const c = vm.createContext({ wearerPlacement: hold,
    inspectionSnapshot: () => ({ appearance: {} }),
    canvas: { xr: { isPresenting: { value: false } }, camera: { state: live, getSnapshot: () => structuredClone(live),
      setState: value => { live = structuredClone(value); } }, setProps() {} },
    representation: { update: () => ({ commit: () => new Promise(resolve => { commit = resolve; }) }) },
    xrRepresentationMaterial() {}, createVolumeRepresentationParams() {}, volumeIsosurfaceParams() {}, volumeColorSelection() {},
    registerVolumeRadialColorTheme() {}, volumeThemeRegistered: false, volumeIsoExtent: {}, volume: { obj: { data: {} } },
    sourceRecord: {}, plugin: {}, VOLUME_REPRESENTATION: 'isosurface', VOLUME_UNIFORM_COLOR: 0,
    Color: value => value, colorNumber: value => value, builtRepresentation: undefined, appliedGeometryBudget: undefined,
    volumePaint: undefined, volumeThemePaint: () => ({ themed: true }), applyInspectionTransform() {}, recordCost() {},
  });
  vm.runInContext(pageFunction(source, 'applyVolumeAppearance'), c);
  const pending = c.applyVolumeAppearance();
  hold.takeover('pointer'); c.canvas.camera.state = chosen; commit();
  await pending;
  assert.deepEqual(live, chosen);
});
