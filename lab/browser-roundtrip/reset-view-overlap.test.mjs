import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { ENTRY_STANDOFF_RANGE, headViewBasis, placementFromRoom } from './room-anchor.mjs';
import { measurePlateSeat } from './plate-seat.mjs';
import { normalizePlacement } from './inspection-state.mjs';
import { menuResetActions, spatialToolbarRows } from './spatial-toolbar-content.mjs';
import { SPATIAL_TOOLBAR_LAYOUT, HALF_IPD_METERS, createToolbarPanel, toolbarBackingOutline, toolbarDrawnMenuPoints, toolbarPlatePoints, toolbarSeatBasis } from './spatial-toolbar-geometry.mjs';
import { applyMatrix4 } from './room-lock.mjs';
import { resetViewPlacement } from './reset-view-placement.mjs';
import { journeySeatDetail } from './journey-seat-record.mjs';
import { createRoomSeatMemory, initialRoomCameraScale } from './room-seat-memory.mjs';
import { tourFocusHarness } from './fixtures/tour-focus-harness.mjs';
import { pageFunction } from './fixtures/label-action-harness.mjs';
import { toolbarFrameHarness, toolbarFrameRuntime } from './fixtures/toolbar-frame-runtime.mjs';
import { Frustum3D } from 'molstar/lib/mol-math/geometry/primitives/frustum3d.js';
import { Plane3D } from 'molstar/lib/mol-math/geometry/primitives/plane3d.js';
import { syntheticViews } from './fixtures/component-label-diagnostics.mjs';
import { entryGeometry } from './fixtures/entry-standoff.mjs';
import { resetEntryGeometry, fitEntryGeometry, resetEntryLateralBreakdown } from './reset-entry-geometry.mjs';
import { relativeHeadContext } from './inspection-spatial-context.mjs';

const viewer = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
const runtime = await toolbarFrameRuntime(new URL('./', import.meta.url));
const flush = () => new Promise(resolve => setImmediate(resolve));
const dot = (a, b) => a.reduce((sum, value, axis) => sum + value * b[axis], 0);

test('a host placement waits once for two eye views and releases the wait on the next measured frame', async () => {
  const session = {};
  const h = vm.createContext({ setTimeout, clearTimeout, latestRoomPlacementPose: null, placementViewWaiters: new Set(),
    canvas: { xr: { isPresenting: { value: true } }, webgl: { xr: { session } } }, performance: { now: () => 0 }, Error });
  vm.runInContext(pageFunction(viewer, 'awaitPlacementViews'), h);
  const waiting = h.awaitPlacementViews();
  assert.equal(h.placementViewWaiters.size, 1);
  h.latestRoomPlacementPose = { labelViews: syntheticViews().slice(0, 1) };
  for (const check of h.placementViewWaiters) check();
  assert.equal(h.placementViewWaiters.size, 1);
  h.latestRoomPlacementPose = { labelViews: syntheticViews() };
  for (const check of h.placementViewWaiters) check();
  await waiting;
  assert.equal(h.placementViewWaiters.size, 0);
});

test('a host placement gives up after its bounded eye-view wait', async () => {
  let clock = 0;
  const h = vm.createContext({ setTimeout, clearTimeout, latestRoomPlacementPose: null, placementViewWaiters: new Set(),
    canvas: { xr: { isPresenting: { value: true } }, webgl: { xr: { session: {} } } },
    performance: { now: () => clock }, Error });
  vm.runInContext(pageFunction(viewer, 'awaitPlacementViews'), h);
  const waiting = h.awaitPlacementViews();
  clock = 2001;
  for (const check of h.placementViewWaiters) check();
  await assert.rejects(waiting, /both eye views are measurable/);
  assert.equal(h.placementViewWaiters.size, 0);
});

test('a host placement accepts one monoscopic primary view without waiting for a fictitious eye', async () => {
  const h = vm.createContext({ setTimeout, clearTimeout, placementViewWaiters: new Set(),
    latestRoomPlacementPose: { labelViews: [{ ...syntheticViews()[0], eye: 'none' }] },
    canvas: { xr: { isPresenting: { value: true } }, webgl: { xr: { session: {} } } },
    performance: { now: () => 0 }, Error });
  vm.runInContext(pageFunction(viewer, 'awaitPlacementViews'), h);
  await h.awaitPlacementViews();
  assert.equal(h.placementViewWaiters.size, 0);
});

test('a host placement needs no eye views when no menu glass is visible', () => {
  const captions = [];
  const h = vm.createContext({ now: () => performance.now(), canvas: { xr: { isPresenting: { value: true } }, webgl: { xr: { session: {} } } },
    state: { status: 'ready', generation: 1 }, sourceRecord: {},
    latestRoomPlacementPose: null, immersiveSession: { platePoints: () => [] }, placementViewWaiters: new Set(),
    talkCaption: { set: caption => captions.push(caption) } });
  vm.runInContext(pageFunction(viewer, 'clearHeldPlatePlacement'), h);
  const requested = { translation: [0, 0, 0], scale: 1 };
  assert.equal(h.clearHeldPlatePlacement(requested), requested);
  assert.deepEqual(captions.map(caption => ({ ...caption })), [{ progress: 'Checking the structure against the menu…' }, { progress: '' }], 'the completed no-menu path retires its progress caption');
});

test('hidden replacement geometry is measured before a host fit and cannot move a wearer seat', async () => {
  const source = entryGeometry();
  source.objects[0].type = 'mesh';
  const hidden = { renderObjects: source.objects };
  source.objects[0].state.visible = false;
  const seat = { translation: [0, 0, -2], rotation: [0, 0, 0], scale: 2 };
  let wearer = false;
  const h = vm.createContext({ now: () => performance.now(), latestRoomPlacementPose: { labelViews: source.views,
    renderFromRoom: Array.from(Mat4.identity()), headInRoom: Array.from(Mat4.identity()) },
  state: { status: 'ready', generation: 1 }, sourceRecord: {},
  canvas: { webgl: { xr: { session: {} } }, xr: { isPresenting: { value: true } }, camera: { scale: 1 } },
  placementViewWaiters: new Set(), inspectionSnapshot: () => ({ placement: seat }), wearerPlacement: { holdsPlacement: () => wearer },
  immersiveSession: { platePoints: () => [[-.4, -.2, -1], [-.2, .2, -1]] },
  loadedSphere: () => ({ center: [0, 0, 0], radius: 1 }),
  scientificRepresentations: () => [hidden], presentationTransform: () => Array.from(Mat4.identity()),
  placementTransform: () => Array.from(Mat4.identity()), resetEntryGeometry, normalizePlacement,
  fitAppearanceInWorker: async options => {
    assert.equal(options.restoreSaved, wearer);
    const renderedGeometry = resetEntryGeometry({ ...options.geometry, cameraScale: options.cameraScale, renderFromRoom: options.renderFromRoom });
    assert.ok(renderedGeometry.subject.length, 'pre-extracted hidden geometry reaches the fitter');
    return { ...seat, scale: 1 };
  } });
  vm.runInContext(pageFunction(viewer, 'clearHeldPlatePlacement'), h);
  assert.equal((await h.clearHeldPlatePlacement(seat, { hidden })).scale, 1);
  wearer = true;
  await assert.rejects(h.clearHeldPlatePlacement(seat, { hidden, keepWearer: true }), /cover the menu at your placement/);
  assert.equal(seat.scale, 2, 'the wearer pose was not changed');
});

for (const centered of [false, true]) test(`a large ${centered ? 'centred Reset shrinks and rises' : 'automatic entry retains size'} into clear glass in both eyes`, () => {
  const source = entryGeometry();
  source.objects[0].type = 'mesh';
  const points = [-.4, .4].flatMap(x => [-.15, .15].map(y => [x, y, -1]));
  const seat = { translation: [0, 0, -2], scale: 2 };
  const geometry = { objects: source.objects, fromPlacement: Array.from(Mat4.identity()),
    toPlacement: Array.from(Mat4.identity()), views: source.views };
  const fitted = resetViewPlacement({ seat, fit: true, centered, points, geometry,
    headInRoom: Array.from(Mat4.identity()), renderFromRoom: Array.from(Mat4.identity()),
    cameraScale: 1, center: [0, 0, 0], radius: 1 });
  if (centered) {
    assert.ok(fitted.scale < seat.scale);
    assert.ok(fitted.verticalTravelMeters > 0);
  } else assert.equal(fitted.scale, seat.scale);
  const drawn = resetEntryGeometry({ ...geometry, cameraScale: 1, renderFromRoom: Array.from(Mat4.identity()) });
  const final = fitEntryGeometry(drawn, { anchor: [0, 0, -2], moved: fitted.translation,
    ratio: fitted.scale / seat.scale });
  assert.ok(resetEntryLateralBreakdown({ geometry: final, points, clearance: 0 }).eyes.every(eye => eye.separated));
});

test('three Mol* return + enter cycles keep the saved placement; Fit clears the menu at entry size or less', async () => {
  const items = new Map(), tab = { getItem: key => items.get(key), setItem: (key, value) => items.set(key, value), removeItem: key => items.delete(key) };
  let saved, fittedScale;
  for (let cycle = 0; cycle < 4; cycle++) {
    const view = await resetHarness({ collapsed: false, active: false, fresh: true });
    const { h } = view;
    try {
      const pose = h.latestRoomPlacementPose;
      Object.assign(h, { roomSeatMemory: createRoomSeatMemory(tab), initialRoomCameraScale, roomCameraInitialized: false,
        desktopPreviewCamera: undefined, desktopPreviewMaxDistance: undefined,
        latestHeadContext: null, pendingRoomLabels: false, pendingRoomLabelBasis: null, menuResolveReason: null,
        roomAnchorEnabled: () => false, wearerPlacedInRoom: false,
        liveScene: () => ({ sourceSha256: 'a'.repeat(64), modelNumber: 1, assemblyId: '1' }),
        molecularBounds: () => ({ radius: 100 * view.snapshot().placement.scale }),
      });
      for (const name of ['beginRoomEntry', 'releaseDesktopPreviewLimit', 'restoreImmersiveCamera']) vm.runInContext(pageFunction(viewer, name), h);
      if (saved) h.inspectionState.place(saved, 'hydrated saved scene');
      // A new Mol* XrManager has prevScale=0 and measures the placed sphere.
      h.canvas.camera.scale = .9 / h.molecularBounds().radius;
      h.restoreImmersiveCamera(); h.beginRoomEntry(true); h.latestRoomPlacementPose = pose;
      if (!saved) {
        await h.settleInRoom({}, {});
        fittedScale = view.snapshot().placement.scale;
        assert.ok(fittedScale > .25 && fittedScale < 4);
      } else {
        assert.equal(h.pendingRoomSeat, false, 'return does not schedule an automatic placement over the saved scene');
        assert.deepEqual(view.snapshot().placement, saved);
        assert.equal(h.canvas.camera.scale, .9 / 100, 'return restores scene units rather than measuring placed bounds twice');
        // The first post-render frame records the retained entry, as onHeadFrame does.
        h.roomEntry.seat = structuredClone(saved);
      }
      h.inspectionState.place({ scale: 4, rotation: [11, -24, 7] }, 'scale ceiling');
      await h.onSpatialAction({ kind: 'fit' });
      assert.ok(view.snapshot().placement.scale <= fittedScale, 'Fit escapes the 4.0 ceiling without growing past the entry');
      saved = structuredClone(view.snapshot().placement);
      h.roomEntry.cameraScale = h.canvas.camera.scale;
      h.canvas.xr.isPresenting.value = false;
      h.canvas.camera.scale = 1; // Mol* restores desktop units before publishing the session edge.
      h.beginRoomEntry(false);
    } finally { await view.menu.toolbar.dispose(); }
  }
});

test('Fit captions the rendered receipt, stays silent while drawing, and preserves the prior note on render failure', async () => {
  const view = await resetHarness({ collapsed: false, active: false, reachable: true });
  const { h } = view;
  try {
    let finish;
    const rendered = new Promise(resolve => { finish = resolve; });
    h.mutate = async (_kind, operation) => { operation(); await rendered; };
    const fitted = h.onSpatialAction({ kind: 'fit' });
    await flush();
    assert.equal(h.placementNote, null, 'no sentence before the render receipt');
    finish(); await fitted;
    // The plain card now spans the gaze above the structure. Fit returns this
    // fixture to its entry point, not to the right of all the drawn glass.
    assert.equal(h.placementNote.text, 'Back at the start');
    assert.equal(h.placementNote.reading.atStart, true, 'the fitted entry is also measured as the start');
    assert.equal(h.placementNote.reading.clearsMenuRight, false, 'the overhead card is not beside the structure');
    assert.deepEqual(Array.from(h.placementNote.reading.roomPoint), Array.from(h.entryRoomPoint));
    view.assertClear({ anySide: true });
    const note = h.placementNote, before = view.snapshot().placement;
    h.mutate = async () => { throw Error('fixture render failed'); };
    await assert.rejects(h.onSpatialAction({ kind: 'fit' }), /fixture render failed/u);
    assert.equal(h.placementNote, note);
    assert.deepEqual(view.snapshot().placement, before);
  } finally { await view.menu.toolbar.dispose(); }
});

// An earlier run recorded the placement, but did not export raw head/eye matrices or
// molecular buffers. Use those exact placement numbers in a synthetic room
// mapping, the lab's measured Quest 2 42°/45° frusta, and the production menu.
test('Reset refits recorded scale 1.9824482982278422 and [1.6853, 0.4579, -1.6493] from a perturbed pose', async () => {
  const view = await resetHarness({ collapsed: false, active: false, fresh: true });
  const { h } = view;
  try {
    const entry = { scale: 1.9824482982278422, translation: [1.6853, .4579, -1.6493], rotation: [0, 0, 0] };
    const sphere = { center: [0, 0, 0], radius: 1 }, cameraScale = .9;
    h.loadedSphere = () => sphere; h.canvas.camera.scale = cameraScale;
    const roomPoint = [entry.translation[0] * cameraScale, 1.999, -3.8];
    const renderFromRoom = Array.from(Mat4.identity());
    for (let i = 0; i < 3; i++) renderFromRoom[12 + i] = entry.translation[i] * cameraScale - roomPoint[i];
    h.latestRoomPlacementPose.renderFromRoom = renderFromRoom;
    const views = syntheticViews().map(eye => {
      const roomEye = [...eye.transform.matrix]; roomEye[13] = 1.6;
      const matrix = Mat4.mul(Mat4(), renderFromRoom, roomEye);
      return { ...eye, transform: { matrix, inverse: { matrix: Mat4.invert(Mat4(), matrix) } } };
    });
    h.latestRoomPlacementPose.labelViews = views;
    const positions = [-.6, .6].flatMap(x => [-.6, .6].flatMap(y => [-.1, .1].map(z => [x, y, z]))).flat();
    const cell = value => ({ ref: { value } });
    h.presentationTransform = () => h.placementTransform(view.snapshot().placement);
    h.scientificRepresentations = () => [{ renderObjects: [{ type: 'mesh', state: { visible: true }, values: {
      drawCount: cell(36), aPosition: cell(positions), instanceCount: cell(1), aTransform: cell(h.presentationTransform()),
    } }] }];
    h.inspectionState.place(entry, 'drawn entry'); h.applyInspectionTransform();
    await view.menu.toolbar.update();
    h.roomEntry.seat = structuredClone(entry); h.entryRoomPoint = roomPoint; h.pendingRoomSeat = false;
    const points = view.menu.toolbar.placementPoints({ ...h.latestRoomPlacementPose, resetMenu: true });
    assert.throws(() => resetViewPlacement({ seat: entry, centered: true, points,
      ...h.latestRoomPlacementPose, cameraScale, ...sphere }), /within 4 m/u,
    'the old padded-sphere admission rejects the entry that was already drawn');
    for (const eye of views) {
      const frustum = Frustum3D.fromProjectionMatrix(Frustum3D(), Mat4.mul(Mat4(), eye.projectionMatrix, eye.transform.inverse.matrix));
      for (let i = 0; i < positions.length; i += 3) {
        const point = applyMatrix4(positions.slice(i, i + 3), h.placementTransform(entry)).map(v => v * cameraScale);
        for (const plane of frustum) assert.ok(Plane3D.distanceToPoint(plane, point) >= 0, 'every restored vertex fits the actual eye');
      }
    }
    for (const route of ['menu', 'controller']) {
      h.inspectionState.place({ scale: 1.499016, translation: [1.9199, .6539, -1.6444], rotation: [12, 32, -9] }, 'perturbed');
      h.applyInspectionTransform();
      if (route === 'menu') await view.pressReset();
      else { await h.runFaceAction('recenter-structure'); await flush(); }
      assert.ok(view.snapshot().placement.scale <= entry.scale, route);
      assert.deepEqual(view.snapshot().placement.rotation, entry.rotation, route);
      // This is the session's accepted entry seat. Reset preserves its clear
      // position using the same free-field policy as seatStructureForEntry.
      const result = resetViewPlacement({ seat: entry, centered: true, fit: true, retainFreeFieldSeat: true,
        points: view.menu.toolbar.placementPoints({ ...h.latestRoomPlacementPose, resetMenu: true }),
        geometry: { objects: h.scientificRepresentations()[0].renderObjects, fromPlacement: h.presentationTransform(),
          toPlacement: h.placementTransform(entry), views }, ...h.latestRoomPlacementPose, cameraScale, ...sphere });
      assert.ok(view.snapshot().placement.translation.every((v, i) => Math.abs(v - result.translation[i]) < 1e-9), route);
      assert.deepEqual(view.errors, []);
      assert.equal(view.cameraWrites.length, 0);
    }
  } finally { await view.menu.toolbar.dispose(); }
});

// Execute the shipped page reset, room-seat solver, action queue and toolbar.
// The existing fixtures replace only rendering and the XR frame clock.
async function resetHarness({ collapsed, active, fresh = false, reachable = false }) {
  const view = tourFocusHarness(), { h } = view;
  const errors = [], cameraWrites = [], talkLines = [];
  h.talkCaption.set = next => talkLines.push(next);
  let head = Array.from(Mat4.identity());
  head[13] = 1.6;
  h.latestRoomPlacementPose.headInRoom = head;
  const eyeViews = () => syntheticViews().map(view => {
    const matrix = Mat4.mul(Mat4(), head, view.transform.matrix);
    return { ...view, transform: { matrix, inverse: { matrix: Mat4.invert(Mat4(), matrix) } } };
  });
  h.latestRoomPlacementPose.labelViews = eyeViews();
  Object.assign(h, {
    structuredClone, placementFromRoom, resetViewPlacement, measurePlateSeat, menuResetActions,
    showHeadsetCaption: text => talkLines.push({ outcome: text }),
    roomAnchor: null, xrManipulation: null, latestPlateSeat: null, latestSeatStandoffMeters: null,
    roomEntry: {}, settlingRoomAnchor: null, adoptionGeneration: 0, pendingRoomSeat: true,
    interactionActive: () => false,
    componentLabelsWanted: () => false,
    componentLabelViewBasis: () => headViewBasis({ ...h.latestRoomPlacementPose, cameraScale: h.canvas.camera.scale }),
    LABEL_CHARACTER_DEGREES: { comfortable: 1 }, xrLabelSizing: () => ({ characterUnits: .1 }),
    componentLabelTextWidth: text => text.length,
    plugin: {}, structureAtomSites: () => 100, sessionDeviceClass: () => 'quest2',
    scientificRepresentations: () => [],
    presentationTransform: () => h.placementTransform(view.snapshot().placement),
    runSpatialAction: async (_action, run) => run(),
    // The extracted callback object also registers session visibility; these
    // reset/placement cases dispatch spatial actions only.
    handleXrInputVisibility() {},
    orientationReference: null, cameraSnapshot: value => value, inspectionPayload: () => ({}),
  });
  Object.assign(h.canvas.camera, {
    getSnapshot: () => ({ position: [0, 0, 100], target: [0, 0, 0], up: [0, 1, 0] }),
    setState: value => cameraWrites.push(value),
  });
  Object.assign(h.inspectionState, { recordPayload() {}, setPayload() {} });
  const place = h.inspectionState.place;
  h.inspectionState.place = (patch, action) => place(normalizePlacement(patch, view.snapshot().placement), action);
  for (const name of ['applySeatMenuRecovery', 'roomAnchorPlacement', 'seatStructureForEntry', 'settleInRoom', 'runFaceAction',
    'releaseWearerPlacement', 'resetOrientation', 'notePlacement', 'sampleHeadFrame']) vm.runInContext(pageFunction(viewer, name), h);
  const begin = viewer.indexOf('      onSpatialAction: async action => {');
  const end = viewer.indexOf('      onHeadFrame:', begin);
  h.onSpatialAction = vm.runInContext('"use strict";\n({' + viewer.slice(begin, end) + '}).onSpatialAction', h);
  const menu = toolbarFrameHarness({ ...runtime, createSpatialToolbar: options => runtime.createSpatialToolbar({
    ...options, onAction: action => h.onSpatialAction(action), onActionError: error => errors.push(error),
  }) }, { state: { passthrough: true, passthroughSupported: true,
    subject: { title: 'Hemoglobin tetramer', pdbId: '4HHB', chains: 4, assembly: 'asymmetric_unit', selectionCount: 0, representation: 'cartoon', color: 'chain-id' },
    tour: { selectedId: 'journey', menuOpen: false, autoplay: false,
      ...(active ? { active: true, step: 0, total: 3, title: 'Molecular structure', progress: 'Scene 1 / 3' }
        : { active: false, step: -1, title: '', progress: '' }) } } });
  menu.frame.getViewerPose = () => ({ transform: {
    matrix: head, position: { x: head[12], y: head[13], z: head[14] },
  }, views: [] });
  Object.assign(h.immersiveSession, {
    refreshToolbar: options => menu.toolbar.update(options),
    toolbarRows: options => menu.toolbar.rows(options), toolbarAction: action => menu.toolbar.runAction(action),
    toolbarPlacementPoints: options => menu.toolbar.placementPoints(options),
    toolbarRelocationCandidates: options => menu.toolbar.prepareRelocation(options),
    relocateToolbar: candidate => menu.toolbar.commitRelocation(candidate),
    platePoints: () => menu.toolbar.platePoints(),
    isMenuHidden: () => menu.toolbar.isHidden(), isMenuCollapsed: () => menu.toolbar.isCollapsed(),
    setMenuHidden: value => menu.toolbar.setHidden(value),
  });
  h.applyInspectionTransform = () => {
    const sphere = h.loadedSphere(), placement = view.snapshot().placement;
    const center = Vec3.transformMat4(Vec3(), sphere.center, h.placementTransform(placement));
    const roomCenter = Vec3.transformMat4(Vec3(), Vec3.scale(Vec3(), center, h.canvas.camera.scale),
      Mat4.invert(Mat4(), h.latestRoomPlacementPose.renderFromRoom));
    menu.setBounds({ center: Array.from(roomCenter),
      radius: sphere.radius * placement.scale * h.canvas.camera.scale });
  };
  if (reachable) h.placementFromRoom = () => ({ scale: .35, translation: [.6, 1.6, -2.5],
    roomPoint: [.6, 1.6, -2.5], standoffMeters: 2.5, metersAcross: .7, mode: 'above' });
  if (!fresh) {
    h.inspectionState.place({ translation: [0, 1.9, -3.8], scale: 1.7 }, 'fixture');
    h.applyInspectionTransform();
    await menu.toolbar.update();
    menu.toolbar.runAction({ kind: 'collapse', value: collapsed });
    await flush();
    await h.settleInRoom({}, {});
    await menu.toolbar.update();
  }
  return { ...view, menu, errors, cameraWrites, talkLines,
    measureGrabGeometry() {
      // Manual release proves the drawn pose and moves/hides the menu instead
      // of fitting the molecule. Supply the sphere this fixture actually draws.
      h.scientificRepresentations = () => [{ renderObjects: [{ type: 'spheres', state: { visible: true },
        values: Object.fromEntries(Object.entries({ drawCount: 6, instanceCount: 1,
          invariantBoundingSphere: h.loadedSphere(), aTransform: h.placementTransform(view.snapshot().placement),
        }).map(([key, value]) => [key, { ref: { value } }])) }] }];
    },
    turn(yaw, pitch = 0) {
      head = Array.from(Mat4.mul(Mat4(), Mat4.fromRotation(Mat4(), yaw, Vec3.create(0, 1, 0)),
        Mat4.fromRotation(Mat4(), pitch, Vec3.create(1, 0, 0))));
      head[12] = .2; head[13] = 1.6;
      h.latestRoomPlacementPose.headInRoom = head;
      h.latestRoomPlacementPose.labelViews = eyeViews();
    },
    async pressReset({ refit = false } = {}) {
      // Lessons retain their quiet controls until the wearer explicitly opens Menu.
      if (!menu.toolbar.rows().some(row => row.label === 'Reset')) {
        const open = menu.toolbar.rows().find(row => row.id === 'menu');
        assert.ok(open, 'the lesson exposes Menu to reach Reset');
        menu.toolbar.runAction(open.action);
        await flush();
      }
      const row = menu.toolbar.rows().find(row => row.label === 'Reset');
      assert.ok(row, 'exercise the shipped Reset row');
      const before = structuredClone(view.snapshot().placement);
      const recordStart = view.records.length;
      menu.toolbar.runAction(row.action);
      // Reset enqueues the menu re-seat on the same chain. Drain that action
      // as well; runAction intentionally does not return the chain to callers.
      await flush();
      assert.deepEqual(errors, []);
      assert.ok(view.snapshot().placement.scale <= h.roomEntry.seat.scale, 'Reset restores entry size or reduces it to fit');
      assert.ok(view.records.slice(recordStart).some(r => r.kind === 'xr-button' && r.action === 'recenter-structure'),
        'every successful Reset has the driver post-render diagnostic');
      if (refit) {
        assert.notDeepEqual(view.snapshot().placement, before, 'the previous fixed-size refusal now changes placement');
        this.assertClear();
      }
      assert.deepEqual(view.snapshot().placement.rotation, h.roomEntry.seat.rotation, 'reset restores the recorded entry rotation');
    },
    assertClear({ centered = false, anySide = false } = {}) {
      const basis = toolbarSeatBasis({ matrix: head,
        position: { x: head[12], y: head[13], z: head[14] } });
      const sphere = h.loadedSphere(), placement = view.snapshot().placement;
      const renderCenter = Array.from(Vec3.transformMat4(Vec3(), sphere.center, h.placementTransform(placement)),
        value => value * h.canvas.camera.scale);
      const center = Vec3.transformMat4(Vec3(), renderCenter, Mat4.invert(Mat4(), h.latestRoomPlacementPose.renderFromRoom));
      const radius = sphere.radius * placement.scale * h.canvas.camera.scale;
      const points = menu.toolbar.platePoints();
      assert.ok(points.length, 'placement leaves the menu visible');
      assert.ok(menu.toolbar.captionPoints().length, 'exercise the caption glass from the device capture');
      if (!anySide) assert.deepEqual(Array.from(menu.toolbar.head().matrix), head, 'menu takes the current head pose');
      for (const side of [-1, 1]) {
        const eye = basis.origin.map((value, axis) => value + side * HALF_IPD_METERS * basis.right[axis]);
        const relative = point => point.map((value, axis) => value - eye[axis]);
        const v = relative(center), x = dot(v, basis.right), z = dot(v, basis.forward);
        assert.ok(z > radius, 'the seated sphere is wholly in front of the wearer');
        // Exact horizontal tangent of a perspective sphere, independent of
        // the reset helper's separating-plane construction. This covers the
        // entire projected disc, including space between sampled menu points.
        const left = (x * z - radius * Math.sqrt(x * x + z * z - radius * radius)) / (z * z - radius * radius);
        const right = Math.max(...points.map(point => {
          const p = relative(point);
          return dot(p, basis.right) / dot(p, basis.forward);
        }));
        if (centered) {
        const centre = x * z / (z * z - radius * radius);
        assert.ok(Math.abs(centre) <= .1351, `eye ${side}: centred silhouette ${centre}`);
      }
      for (const plate of points.plates ?? [points]) {
          // Independent exact hull-edge witness: two corner rays define a
          // plane bounding the entire glass cone. Its distance to the sphere
          // must exceed the radius. No direction sampling or production solver.
          const rays = plate.map(relative);
          let separate = false;
          for (let i = 0; i < rays.length && !separate; i++) for (let j = i + 1; j < rays.length && !separate; j++) {
            const normal = Vec3.normalize(Vec3(), Vec3.cross(Vec3(), rays[i], rays[j]));
            for (const sign of [-1, 1]) {
              if (sign * dot(v, normal) > radius && rays.every(ray => sign * dot(ray, normal) <= 1e-10)) separate = true;
            }
          }
          assert.ok(separate, `eye ${side}: the sphere must clear each entire projected glass cone`);
        }
      }
      assert.equal(cameraWrites.length, 0, 'an immersive reset must not rotate the room camera');
    },
  };
}

for (const collapsed of [true, false]) for (const yaw of [0, .6]) for (const pitch of [0, .2]) {
  test(`2x then Reset refits entry size and keeps the whole sphere inside both eye frustums: ${collapsed ? 'compact' : 'expanded'}, yaw ${yaw}, pitch ${pitch}`, async () => {
    const view = await resetHarness({ collapsed, active: false, reachable: true });
    try {
      // Neither an off-origin molecule nor a rotated room/render mapping may
      // turn an absolute reset seat into a scale-dependent translation.
      view.h.loadedSphere = () => ({ center: [12, -7, 20], radius: 100 });
      const renderFromRoom = Array.from(Mat4.fromRotation(Mat4(), -.4, Vec3.create(0, 1, 0)));
      renderFromRoom[12] = .4; renderFromRoom[13] = -.5; renderFromRoom[14] = .2;
      view.h.latestRoomPlacementPose.renderFromRoom = renderFromRoom;
      view.h.placementFromRoom = () => {
        const roomPoint = [.6, 1.6, -2.5];
        return { scale: .35, roomPoint, standoffMeters: 2.5, metersAcross: .7, mode: 'above',
          translation: applyMatrix4(roomPoint, renderFromRoom).map((value, axis) =>
            (value / view.h.canvas.camera.scale - view.h.loadedSphere().center[axis]) / view.h.loadedSphere().radius) };
      };
      delete view.h.roomEntry.seat;
      await view.h.settleInRoom({}, {});
      await view.h.onSpatialAction({ kind: 'fit' });
      await view.h.placeInspection({ scale: view.snapshot().placement.scale * 2 }, 'journey-end');
      view.turn(yaw, pitch);
      const head = view.h.latestRoomPlacementPose.headInRoom;
      const entry = structuredClone(view.h.roomEntry.seat);
      const entryCenter = Vec3.transformMat4(Vec3(), Vec3.scale(Vec3(),
        Vec3.transformMat4(Vec3(), view.h.loadedSphere().center, view.h.placementTransform(entry)), view.h.canvas.camera.scale),
        Mat4.invert(Mat4(), renderFromRoom));
      const entryHeadCenter = Vec3.transformMat4(Vec3(), entryCenter, Mat4.invert(Mat4(), head));
      await view.pressReset();
      const sphere = view.h.loadedSphere(), placement = view.snapshot().placement;
      const renderCenter = Array.from(Vec3.transformMat4(Vec3(), sphere.center, view.h.placementTransform(placement)),
        value => value * view.h.canvas.camera.scale);
      const roomCenter = Vec3.transformMat4(Vec3(), renderCenter, Mat4.invert(Mat4(), renderFromRoom));
      const headCenter = Vec3.transformMat4(Vec3(), roomCenter, Mat4.invert(Mat4(), head));
      assert.ok(Math.abs(headCenter[0] / headCenter[2]) < .1351, 'Reset recentres an out-of-band entry');
      assert.ok(Math.abs(headCenter[1] - entryHeadCenter[1]) < 1e-10, 'Reset retains entry height');
      assert.ok(headCenter[2] <= entryHeadCenter[2] + 1e-10 && -headCenter[2] <= ENTRY_STANDOFF_RANGE.max + 1e-10, 'depth stays within the existing distance ceiling');
      assert.ok(placement.scale <= entry.scale);
      const radius = sphere.radius * placement.scale * view.h.canvas.camera.scale;
      for (const eye of syntheticViews()) {
        const eyeView = Mat4.invert(Mat4(), Mat4.mul(Mat4(), head, eye.transform.matrix));
        const frustum = Frustum3D.fromProjectionMatrix(Frustum3D(), Mat4.mul(Mat4(), eye.projectionMatrix, eyeView));
        for (const [plane, boundary] of frustum.entries()) {
          assert.ok(Plane3D.distanceToPoint(boundary, roomCenter) >= radius,
            `${eye.eye} plane ${plane}: the WHOLE sphere must fit, not merely intersect`);
        }
      }
      assert.equal(view.cameraWrites.length, 0);
      view.assertClear({ centered: true });
      const reset = structuredClone(placement);
      await view.pressReset();
      assert.deepEqual(view.snapshot().placement, reset, 'repeated Reset does not accumulate travel');
    } finally { await view.menu.toolbar.dispose(); }
  });
}

test('explicit host placement refuses unmeasured glass clearance without adjusting the request', async () => {
  const view = tourFocusHarness();
  view.h.latestRoomPlacementPose.labelViews = syntheticViews();
  view.h.scientificRepresentations = () => [];
  view.h.presentationTransform = () => view.h.placementTransform(view.snapshot().placement);
  const before = structuredClone(view.snapshot().placement);
  const placed = { scale: 2, rotation: [0, 30, 0], translation: [-.2, 1.6, -3] };
  await assert.rejects(view.h.placeInspection(placed), /would cover the menu/);
  assert.deepEqual(view.snapshot().placement, before, 'missing measurable geometry cannot authorize an intentional pose');
  assert.ok(!view.records.some(record => record.kind === 'outcome' && record.status === 'adjusted' && record.action === 'place'));
});

test('host translation waits for both eye views and held menu points', async () => {
  const view = tourFocusHarness();
  view.h.latestRoomPlacementPose.labelViews = [];
  const before = view.snapshot().placement;
  await assert.rejects(view.h.placeInspection({ translation: [.5, 0, -2] }), /both eye views and the held menu/);
  assert.deepEqual(view.snapshot().placement, before);
  view.h.latestRoomPlacementPose.labelViews = syntheticViews().slice(0, 1);
  await assert.rejects(view.h.placeInspection({ translation: [.5, 0, -2] }), /both eye views and the held menu/);
  assert.deepEqual(view.snapshot().placement, before);
});

test('an explicit host translation refuses without measurable subject geometry', async () => {
  const view = await resetHarness({ collapsed: false, active: false, reachable: true });
  try {
    const { h } = view;
    h.latestRoomPlacementPose.labelViews = syntheticViews();
    h.scientificRepresentations = () => [];
    h.presentationTransform = () => h.placementTransform(view.snapshot().placement);
    const menu = view.menu.toolbar.platePoints();
    const before = structuredClone(view.snapshot().placement);
    await assert.rejects(h.placeInspection({ translation: [-.4, 1.6, -1], scale: 1.2 }), /would cover the menu/);
    assert.deepEqual(view.menu.toolbar.platePoints(), menu, 'a refused command holds the menu seat');
    assert.deepEqual(view.snapshot().placement, before);
  } finally { await view.menu.toolbar.dispose(); }
});

test('Reset brings a budgeted overhead scene forward without violating minimum scale or entry distance limits', async () => {
  const view = await resetHarness({ collapsed: false, active: false, reachable: true });
  try {
    view.h.structureAtomSites = () => 200000;
    view.h.inspectionState.place({ scale: 4, translation: [0, 5, 0] });
    await view.pressReset();
    const placement = view.snapshot().placement, sphere = view.h.loadedSphere();
    const center = Vec3.scale(Vec3(), Vec3.transformMat4(Vec3(), sphere.center,
      view.h.placementTransform(placement)), view.h.canvas.camera.scale);
    const relative = Vec3.transformMat4(Vec3(), center, Mat4.invert(Mat4(), view.h.latestRoomPlacementPose.headInRoom));
    assert.ok(-relative[2] <= ENTRY_STANDOFF_RANGE.max, 'Reset stays within the existing distance ceiling');
    assert.equal(placement.scale, view.h.roomEntry.seat.scale, 'the saved entry size survives an overhead edit');
    assert.ok(placement.scale >= .25 && placement.scale <= 4);
    view.assertClear({ centered: true });
  } finally { await view.menu.toolbar.dispose(); }
});

for (const collapsed of [true, false]) {
  test(`caption clearance is the minimum rightward translation at unchanged scale/depth: ${collapsed ? 'compact' : 'expanded'}`, () => {
    for (const card of ['above', 'column']) {
      const headInRoom = Array.from(Mat4.fromRotation(Mat4(), .6, Vec3.create(0, 1, 0)));
      headInRoom[12] = .3; headInRoom[13] = 1.6; headInRoom[14] = .7;
      const head = { matrix: headInRoom, position: { x: .3, y: 1.6, z: .7 } };
      const basis = toolbarSeatBasis(head);
      const tour = { selectedId: 'journey', menuOpen: false, active: false,
        title: '', progress: '' };
      // Exercise today's overhead plain card and retain the old column-card
      // overlap as an explicit geometry fixture. Column cards still exist in
      // the chooser; a change to the resting readout must not erase that guard.
      const readout = runtime.tourReadout(tour, { title: 'Hemoglobin tetramer', pdbId: '4HHB', chains: 4, assembly: 'asymmetric_unit', selectionCount: 0, representation: 'cartoon', color: 'chain-id' });
      const panel = createToolbarPanel({ head, constants: { ...SPATIAL_TOOLBAR_LAYOUT, peripheralSeat: false }, rows: spatialToolbarRows({ tour, collapsed }),
        readout: card === 'above' ? readout : readout.map(line => ({ ...line, forwardViewCap: false })) });
      // A nonidentity room/render transform and a nonzero molecular centre
      // exercise the scale path's conversion from saved translation to metres.
      const renderFromRoom = Array.from(Mat4.fromRotation(Mat4(), -.4, Vec3.create(0, 1, 0)));
      renderFromRoom[12] = .4; renderFromRoom[13] = -.5; renderFromRoom[14] = .2;
      const center = [12, -7, 20], radius = 100, cameraScale = .01;
      const roomPoint = basis.origin.map((value, axis) => value + 3.8 * basis.forward[axis]);
      const seat = { scale: 1.7, translation: applyMatrix4(roomPoint, renderFromRoom)
        .map((value, axis) => (value / cameraScale - center[axis]) / radius) };
      const input = { seat, headInRoom, renderFromRoom, center, radius, cameraScale };
      const column = resetViewPlacement({ ...input, points: [...toolbarDrawnMenuPoints(panel),
        ...toolbarBackingOutline(panel), ...toolbarBackingOutline(panel, { depth: panel.backingDepthMeters })] });
      const points = toolbarPlatePoints(panel), placed = resetViewPlacement({ ...input, points });
      const delta = placed.roomPoint.map((value, axis) => value - roomPoint[axis]);
      assert.equal(placed.scale, seat.scale);
      assert.ok(Math.abs(dot(delta, basis.forward)) < 1e-12, 'retain depth');
      assert.ok(Math.abs(dot(delta, basis.up)) < 1e-12, 'retain height');
      if (card === 'column') assert.ok(dot(placed.roomPoint.map((value, axis) => value - column.roomPoint[axis]), basis.right) > .01,
        'the column-only solve leaves a column caption overlapping');
      else assert.deepEqual(placed, column, 'an overhead card needs no extra lateral travel beyond the controls');
      const gapsFor = point => [-1, 1].flatMap(side => {
        const eye = basis.origin.map((value, axis) => value + side * HALF_IPD_METERS * basis.right[axis]);
        const relative = point => point.map((value, axis) => value - eye[axis]);
        const v = relative(point), x = dot(v, basis.right), z = dot(v, basis.forward);
        const r = radius * cameraScale * placed.scale;
        const left = (x * z - r * Math.sqrt(x * x + z * z - r * r)) / (z * z - r * r);
        const y = dot(v, basis.up);
        const top = (y * z + r * Math.sqrt(y * y + z * z - r * r)) / (z * z - r * r);
        return points.plates.filter(plate => plate.length).map(plate => {
          const right = Math.max(...plate.map(point => dot(relative(point), basis.right) / dot(relative(point), basis.forward)));
          const bottom = Math.min(...plate.map(point => dot(relative(point), basis.up) / dot(relative(point), basis.forward)));
          // Independent exact sphere tangents prove the whole plate is either
          // left of or above the disc, rather than treating all glass as one box.
          return Math.max(left - right, bottom - top);
        });
      });
      if (card === 'column') assert.ok(gapsFor(column.roomPoint).some(gap => gap < 0), 'column-only clearance reproduces caption overlap');
      const gaps = gapsFor(placed.roomPoint);
      assert.ok(gaps.every(gap => gap > 0), 'both projected discs clear the full glass');
      assert.ok(Math.abs(Math.min(...gaps) - Math.tan(Math.PI / 180)) < 1e-12,
        'the limiting eye uses exactly the existing air margin, with no extra nudge');
      const clearSeat = { ...placed, roomPoint: placed.roomPoint.map((value, axis) => value + .1 * basis.right[axis]) };
      assert.equal(resetViewPlacement({ ...input, seat: clearSeat, points }), clearSeat, 'a clear seat does not move');
    }
  });

  test(`fresh entry clears caption and controls in both eyes: ${collapsed ? 'compact' : 'expanded'}`, async () => {
    const h = await resetHarness({ collapsed, active: false, fresh: true });
    try {
      // Expanded entry is the very first toolbar draw. Compact entry has
      // chosen its form, but has not yet seated the structure in the room.
      if (collapsed) {
        h.menu.toolbar.runAction({ kind: 'collapse', value: true });
        await flush();
      }
      await h.h.settleInRoom({}, {});
      await h.menu.toolbar.update();
      assert.equal(h.h.pendingRoomSeat, false, 'the production entry settle committed');
      h.assertClear();
    } finally { await h.menu.toolbar.dispose(); }
  });

  for (const route of ['placement', 'grip release']) {
    test(`explicit 2x refuses collision or grip release clears controls before Reset: ${route}, ${collapsed ? 'compact' : 'expanded'}`, async () => {
      const h = await resetHarness({ collapsed, active: false, reachable: true });
      try {
        // Fit shares the entry seat without resetting the latched menu.
        await h.h.onSpatialAction({ kind: 'fit' });
        h.assertClear();
        const before = h.snapshot().placement;
        const menuPoints = h.menu.toolbar.platePoints();
        if (route === 'placement') await assert.rejects(h.h.placeInspection({ scale: before.scale * 2 }), /would cover the menu/);
        else {
          h.measureGrabGeometry();
          h.h.grabScale = 2;
          await h.h.bakeGrab({ gesture: 'two-hand-scale' });
        }
        if (route === 'placement') assert.deepEqual(h.snapshot().placement, before, 'a colliding explicit pose refuses whole');
        else assert.equal(h.snapshot().placement.scale, before.scale * 2, 'retain the requested grip scale');
        if (route === 'placement') {
          assert.deepEqual(h.menu.toolbar.platePoints(), menuPoints, 'refused host placement keeps the held menu');
          h.assertClear();
        } else {
          assert.deepEqual(h.snapshot().placement.translation, before.translation, 'release keeps the wearer’s position');
          assert.ok(!h.records.some(record => record.event === 'menu-clearance-deferred'), 'release proved menu clearance');
          if (h.menu.toolbar.isHidden()) assert.equal(h.menu.toolbar.platePoints().length, 0);
          else h.assertClear({ anySide: true });
        }
        await h.pressReset();
        h.assertClear({ centered: true });
      } finally { await h.menu.toolbar.dispose(); }
    });
  }
}

test('controller reset restores a hidden expanded menu after a head turn', async () => {
  const h = await resetHarness({ collapsed: false, active: true, reachable: true });
  try {
    h.menu.toolbar.setHidden(true);
    h.turn(.6);
    h.h.inspectionState.place({ scale: 4 }, 'fixture-scale');
    h.h.applyInspectionTransform();
    await h.h.runFaceAction('recenter-structure');
    await flush();
    assert.deepEqual(h.errors, []);
    assert.equal(h.menu.toolbar.isHidden(), false);
    assert.equal(h.menu.toolbar.isCollapsed(), true, 'a hidden menu returns compact');
    h.assertClear({ centered: true });
  } finally { await h.menu.toolbar.dispose(); }
});

for (const active of [false, true]) for (const collapsed of [true, false]) {
  for (const scenario of ['structure in front', 'scaled-up structure', 'wearer turned toward menu']) {
    test(`reset clears both eyes: ${scenario}, ${collapsed ? 'compact' : 'expanded'}, ${active ? 'tour' : 'resting'}`, async () => {
      const h = await resetHarness({ collapsed, active, reachable: true });
      try {
        if (scenario === 'scaled-up structure') {
          h.h.inspectionState.place({ scale: 4 }, 'fixture-scale');
          h.h.applyInspectionTransform();
          h.h.takeWearerPlacement('fixture-scale');
        }
        if (scenario === 'wearer turned toward menu') h.turn(.6);
        await h.pressReset();
        h.assertClear({ centered: true });
        assert.equal(h.menu.toolbar.isCollapsed(), collapsed && !active,
          'preserve the chosen menu form, including Menu opened to reach Reset during a lesson');
        assert.equal(h.h.wearerPlacement.holdsPlacement(), false, 'reset returns the authored seat');
      } finally { await h.menu.toolbar.dispose(); }
    });
  }
}

// The sentence the caption plate says after a placement
// row, read off the pose the shipped Fit and Reset actually produced in this
// same harness — the real menu glass, the real seat solver, the real mutation.
test('Reset after Fit refits the committed entry and reports its rendered position', async () => {
  const view = await resetHarness({ collapsed: false, active: false, fresh: true, reachable: true });
  const { h } = view;
  assert.equal(h.placementNote, null, 'nothing is said before a placement renders');
  // The production entry settle, which is where the room point the session
  // started at is recorded. Nothing about it is a placement row.
  h.inspectionState.place({ rotation: [11, -24, 7] }, 'entry orientation');
  await h.settleInRoom({}, {});
  await view.menu.toolbar.update();
  assert.equal(h.pendingRoomSeat, false, 'the production entry settle committed');
  const entry = structuredClone(view.snapshot().placement);
  assert.ok(Array.isArray(h.entryRoomPoint) && h.entryRoomPoint.every(Number.isFinite),
    'the entry seat records the room point the session started at');
  h.placementFromRoom = placementFromRoom;
  await h.onSpatialAction({ kind: 'fit' });
  const fitted = h.placementNote;
  assert.equal(typeof fitted?.text, 'string', 'Fit says where it put the structure');
  // The overhead plain card leaves room for a larger Fit with a small lateral
  // offset. Measure that offset from the committed pose, not the action name.
  view.assertClear({ anySide: true });
  const sphere = h.loadedSphere();
  const renderedPoint = applyMatrix4(sphere.center.map((value, axis) =>
    (value + view.snapshot().placement.translation[axis] * sphere.radius) * h.canvas.camera.scale),
  Mat4.invert(Mat4(), h.latestRoomPlacementPose.renderFromRoom));
  assert.deepEqual(Array.from(fitted.reading.roomPoint), renderedPoint, 'the receipt describes the drawn pose');
  const relative = renderedPoint.map((value, axis) => value - h.latestRoomPlacementPose.headInRoom[12 + axis]);
  assert.ok(Math.abs(fitted.reading.bearingDegrees - Math.atan2(relative[0], -relative[2]) * 180 / Math.PI) < 1e-10);
  assert.ok(Math.abs(fitted.reading.bearingDegrees) <= 8, 'Fit keeps the plain structure in the central view');
  assert.equal(fitted.text, 'In front of you, a step away');
  assert.notEqual(view.snapshot().placement.scale, entry.scale, 'exercise Reset after a Fit that actually changed the size');
  assert.deepEqual(h.roomEntry.seat, entry, 'Fit must not replace the committed entry');
  await h.placeInspection({ rotation: [12, 32, -9], translation: [-.5, 1, -3], scale: .7 }, 'journey-end');
  await view.pressReset();
  const reset = h.placementNote;
  assert.equal(typeof reset?.text, 'string', 'Reset says where it put the structure');
  // Reset owns size and position and returns to the committed entry, which
  // still clears the overhead card and controls after this Fit.
  assert.ok(Math.abs(reset.reading.bearingDegrees) < 30, `bearing ${reset.reading.bearingDegrees}`);
  assert.ok(reset.text.length > 0);
  assert.ok(view.snapshot().placement.scale <= entry.scale);
  assert.deepEqual(view.snapshot().placement.rotation, entry.rotation);
  assert.deepEqual(view.snapshot().placement, entry, 'the still-clear committed entry is restored exactly');
  assert.equal(reset.text, 'Back at the start');
  assert.equal(reset.reading.atStart, true);
  assert.deepEqual(Array.from(reset.reading.roomPoint), Array.from(h.entryRoomPoint));
  view.assertClear({ centered: true });
  await view.menu.toolbar.dispose();
});

for (const collapsed of [true, false]) {
  test(`an original large entry refits after 2x: ${collapsed ? 'compact' : 'expanded'}`, async () => {
    const view = await resetHarness({ collapsed, active: false });
    try {
      await view.h.placeInspection({ scale: view.snapshot().placement.scale * 2 }, 'journey-end');
      view.assertClear();
      await view.pressReset({ refit: true });
    } finally { await view.menu.toolbar.dispose(); }
  });
}

// Retain the original large-sphere inputs alongside the reachable cases.
// Reset may now shrink these entries; retain every original input and prove clearance.
for (const collapsed of [true, false]) for (const yaw of [0, .6]) for (const pitch of [0, .2]) {
  test(`original large entry after 2x refits with stereo clearance: ${collapsed}, yaw ${yaw}, pitch ${pitch}`, async () => {
    const view = await resetHarness({ collapsed, active: false });
    try {
      view.h.loadedSphere = () => ({ center: [12, -7, 20], radius: 100 });
      const transform = Array.from(Mat4.fromRotation(Mat4(), -.4, Vec3.create(0, 1, 0)));
      transform[12] = .4; transform[13] = -.5; transform[14] = .2;
      view.h.latestRoomPlacementPose.renderFromRoom = transform;
      delete view.h.roomEntry.seat;
      await view.h.settleInRoom({}, {});
      const entry = structuredClone(view.h.roomEntry.seat);
      await view.h.onSpatialAction({ kind: 'fit' });
      await view.h.placeInspection({ scale: view.snapshot().placement.scale * 2 }, 'journey-end');
      view.turn(yaw, pitch);
      await view.pressReset({ refit: true });
      assert.deepEqual(view.h.roomEntry.seat, entry, 'a refit never changes the recorded entry target');
    } finally { await view.menu.toolbar.dispose(); }
  });
}

test('forward-only clearance keeps entry scale, rotation and both lateral coordinates', () => {
  const headInRoom = Array.from(Mat4.identity()), renderFromRoom = Array.from(Mat4.identity());
  const seat = { scale: .5, translation: [1, 0, -1], rotation: [12, 24, -36] };
  const reset = resetViewPlacement({ seat, centered: true, headInRoom, renderFromRoom,
    center: [0, 0, 0], radius: 1, cameraScale: 1 });
  assert.equal(reset.scale, seat.scale);
  assert.deepEqual(reset.rotation, seat.rotation);
  assert.deepEqual(reset.translation.slice(0, 2), seat.translation.slice(0, 2));
  assert.ok(reset.translation[2] < seat.translation[2]);
  for (const eye of syntheticViews()) {
    const frustum = Frustum3D.fromProjectionMatrix(Frustum3D(),
      Mat4.mul(Mat4(), eye.projectionMatrix, eye.transform.inverse.matrix));
    for (const plane of frustum) assert.ok(Plane3D.distanceToPoint(plane, reset.translation) >= seat.scale);
  }
});

test('a moved menu that covers every forward reset position refuses at the entry scale', () => {
  const headInRoom = Array.from(Mat4.identity()), renderFromRoom = Array.from(Mat4.identity());
  const seat = { scale: .35, translation: [.6, 0, -2.5], rotation: [11, -24, 7] };
  const before = structuredClone(seat);
  const points = [-5, 5].flatMap(x => [-5, 5].map(y => [x, y, -1]));
  assert.throws(() => resetViewPlacement({ seat, centered: true, points, headInRoom, renderFromRoom,
    center: [0, 0, 0], radius: 1, cameraScale: 1 }), /entry size cannot fit inside both eyes and clear the menu within 4 m/u);
  assert.deepEqual(seat, before);
});

test('Reset brings back a molecule more than 100 radii away while the room pose is tracked', async () => {
  const view = await resetHarness({ collapsed: false, active: false });
  const { h } = view;
  try {
    Object.assign(h, { relativeHeadContext, latestHeadContext: null });
    // An agent placement 500 radii out: past the molecule-relative reading.
    h.inspectionState.place({ translation: [300, 1.9, -400], scale: 1.7 }, 'far agent placement');
    h.applyInspectionTransform();
    const head = h.latestRoomPlacementPose.headInRoom, frame = { pose: { transform: { matrix: head } },
      roomPose: { transform: { matrix: head } }, mode: 'immersive-ar', sphere: h.loadedSphere() };
    // Lost tracking is never stamped, so Reset still waits for it.
    h.latestHeadSample = -1e6;
    h.sampleHeadFrame({ ...frame, pose: null, roomPose: null });
    await assert.rejects(h.seatStructureForEntry({ resetMenu: true }), /wait for tracking/u);
    h.sampleHeadFrame(frame);
    assert.equal(h.latestHeadContext, null, 'no molecule-relative reading this far out');
    assert.equal(h.latestHeadSample, h.performance.now(), 'the tracked room pose is fresh');
    await view.pressReset();
    const placement = view.snapshot().placement;
    assert.ok(Math.hypot(...placement.translation) < 10, `Reset seats it in the room (${placement.translation})`);
    h.sampleHeadFrame(frame);
    assert.ok(h.latestHeadContext?.distance < 100, 'the molecule-relative reading returns');
  } finally { await view.menu.toolbar.dispose(); }
});

test('Reset seats a visible structure and hides glass when the full menu leaves no fit', async () => {
  const view = await resetHarness({ collapsed: false, active: false });
  try {
    view.h.immersiveSession.toolbarPlacementPoints = () => [-5, 5].flatMap(x => [-5, 5].map(y => [x, y, -1]));
    view.h.immersiveSession.toolbarRelocationCandidates = () => [];
    let receipt;
    const run = view.h.runFaceAction;
    view.h.runFaceAction = async (...args) => receipt = await run(...args);
    await view.pressReset();
    assert.equal(receipt.structureReset, true);
    assert.equal(receipt.menuReseated, false);
    assert.equal(view.menu.toolbar.isHidden(), true);
    assert.ok(view.snapshot().placement.translation[2] < 0);
    assert.equal(view.cameraWrites.length, 0);
    assert.ok(view.records.some(record => record.kind === 'outcome' && record.status === 'adjusted'));
  } finally { await view.menu.toolbar.dispose(); }
});

test('a shrinking Reset publishes its recenter diagnostic only after rendering and preserves the checkpoint on failure', async () => {
  const view = await resetHarness({ collapsed: false, active: false });
  const { h } = view;
  try {
    h.roomEntry.seat = { translation: [0, 1.9, -3.8], scale: 1.98, rotation: [0, 0, 0] };
    let finish;
    const rendered = new Promise(resolve => { finish = resolve; });
    h.mutate = async (_kind, operation) => { await operation(); await rendered; };
    const start = view.records.length;
    const reset = h.seatStructureForEntry({ resetMenu: true });
    await flush();
    assert.ok(view.snapshot().placement.scale < 1.98);
    assert.equal(view.records.slice(start).some(r => r.kind === 'xr-button'), false);
    finish(); await reset;
    assert.ok(view.records.slice(start).some(r => r.kind === 'xr-button' && r.action === 'recenter-structure'));
    const before = structuredClone(view.snapshot().placement), offset = view.records.length;
    h.mutate = async (_kind, operation) => { await operation(); throw Error('shrinking Reset render failed'); };
    await assert.rejects(h.seatStructureForEntry({ resetMenu: true }), /shrinking Reset render failed/u);
    assert.deepEqual(view.snapshot().placement, before);
    assert.equal(view.records.slice(offset).some(r => r.kind === 'xr-button'), false);
  } finally { await view.menu.toolbar.dispose(); }
});

for (const failure of ['motion', 'new grip']) test(`Reset rolls back its checked menu recovery on pre-placement refusal: ${failure}`, async () => {
  const view = await resetHarness({ collapsed: false, active: false });
  const { h } = view;
  try {
    let recovered = false, rolledBack = false, holding = false, placed = false;
    h.applySeatMenuRecovery = async () => { recovered = true; return { rollback: async () => { rolledBack = true; } }; };
    h.xrManipulation = { phase: () => holding ? 'grabbing' : 'idle' };
    h.setInspectionMotion = async () => {
      if (failure === 'motion') throw Error('Motion pause failed');
      holding = true;
    };
    h.mutate = async () => { placed = true; };
    const before = structuredClone(view.snapshot().placement);
    await assert.rejects(h.seatStructureForEntry({ resetMenu: true }),
      failure === 'motion' ? /Motion pause failed/ : /Let go of it first/);
    assert.equal(recovered, true, 'exercise a menu proposal already applied');
    assert.equal(rolledBack, true, 'the menu cannot remain at a proposed Reset seat');
    assert.equal(placed, false);
    assert.deepEqual(view.snapshot().placement, before);
  } finally { await view.menu.toolbar.dispose(); }
});

test('Reset retaining a plain entry pose measures finite geometry and publishes only after its draw', async () => {
  const view = await resetHarness({ collapsed: false, active: false, fresh: true });
  const { h } = view;
  try {
    const entry = { translation: [.6, 1.6, -2.5], scale: .35, rotation: [0, 0, 0] };
    h.inspectionState.place(entry, 'drawn retained entry'); h.applyInspectionTransform();
    h.roomEntry.seat = structuredClone(entry); h.pendingRoomSeat = false;
    view.measureGrabGeometry();
    h.immersiveSession.toolbarPlacementPoints = () => [-1, -.7].flatMap(x => [1.4, 1.8].map(y => [x, y, -1]));
    let retained = false;
    h.resetViewPlacement = options => {
      const result = resetViewPlacement(options);
      retained = options.retainFreeFieldSeat && result === options.seat;
      return result;
    };
    let finish;
    const drawn = new Promise(resolve => { finish = resolve; });
    h.mutate = async (_kind, operation) => { await operation(); await drawn; };
    const offset = view.records.length, reset = h.seatStructureForEntry({ resetMenu: true });
    await flush();
    assert.equal(retained, true, 'exercise the real zero-motion retained-seat early return');
    assert.deepEqual(view.snapshot().placement, entry);
    assert.equal(view.records.slice(offset).some(record => record.kind === 'xr-button'), false);
    finish(); const seat = await reset;
    assert.deepEqual(h.roomEntry.seat, entry, 'normalization cannot edit the recorded Reset target');
    assert.deepEqual(view.snapshot().placement, entry, 'normalization cannot change placement policy');
    assert.deepEqual(Array.from(seat.roomPoint), [.6, 1.6, -2.5]);
    assert.equal(seat.metersAcross, .7); assert.equal(seat.standoffMeters, 2.5); assert.equal(seat.mode, 'auto');
    assert.equal(h.latestSeatStandoffMeters, 2.5);
    const receipt = view.records.slice(offset).find(record => record.kind === 'xr-button');
    assert.equal(receipt.metersAcross, .7); assert.equal(receipt.mode, 'auto');
    assert.equal(view.cameraWrites.length, 0);
    h.mutate = async (_kind, operation) => { await operation(); throw Error('retained Reset draw failed'); };
    const failedOffset = view.records.length;
    await assert.rejects(h.seatStructureForEntry({ resetMenu: true }), /retained Reset draw failed/u);
    assert.equal(view.records.slice(failedOffset).some(record => record.kind === 'xr-button'), false);
    assert.deepEqual(view.snapshot().placement, entry);
  } finally { await view.menu.toolbar.dispose(); }
});

for (const active of [false, true]) for (const collapsed of [true, false]) {
  for (const scenario of ['structure in front', 'scaled-up structure', 'wearer turned toward menu']) {
    test(`original large-entry Reset clears the glass and records a render: ${scenario}, ${collapsed}, tour ${active}`, async () => {
      const view = await resetHarness({ collapsed, active });
      try {
        if (scenario === 'scaled-up structure') {
          view.h.inspectionState.place({ scale: 4 }, 'fixture-scale');
          view.h.applyInspectionTransform();
          view.h.takeWearerPlacement('fixture-scale');
        }
        if (scenario === 'wearer turned toward menu') view.turn(.6);
        await view.pressReset({ refit: scenario !== 'structure in front' });
        view.assertClear({ centered: true });
      } finally { await view.menu.toolbar.dispose(); }
    });
  }
}

for (const collapsed of [true, false]) for (const route of ['placement', 'grip release']) {
  test(`original large explicit 2x refuses or grip clears before automatic fitting and Reset: ${route}, ${collapsed}`, async () => {
    const view = await resetHarness({ collapsed, active: false });
    try {
      await view.h.onSpatialAction({ kind: 'fit' });
      view.assertClear();
      const before = structuredClone(view.snapshot().placement), menu = view.menu.toolbar.platePoints();
      if (route === 'placement') await assert.rejects(view.h.placeInspection({ scale: before.scale * 2 }), /would cover the menu/);
      else {
        view.measureGrabGeometry();
        view.h.grabScale = 2;
        await view.h.bakeGrab({ gesture: 'two-hand-scale' });
      }
      if (route === 'placement') assert.deepEqual(view.snapshot().placement, before, 'refusal never shrinks or moves the requested pose');
      else assert.equal(view.snapshot().placement.scale, before.scale * 2);
      if (route === 'placement') {
        assert.deepEqual(view.menu.toolbar.platePoints(), menu);
        view.assertClear();
      } else {
        assert.deepEqual(view.snapshot().placement.translation, before.translation);
        assert.ok(!view.records.some(record => record.event === 'menu-clearance-deferred'), 'release proved menu clearance');
        if (view.menu.toolbar.isHidden()) assert.equal(view.menu.toolbar.platePoints().length, 0);
        else view.assertClear({ anySide: true });
      }
      // Retain the original automatic-fit/Reset regression too. Explicit
      // placement above refuses whole; an authored seat may still refit.
      if (route === 'placement') await view.h.placeInspection({ scale: before.scale * 2 }, 'tour-placement');
      await view.pressReset({ refit: true });
    } finally { await view.menu.toolbar.dispose(); }
  });
}

for (const route of ['menu', 'aim']) test(`Done restores the Reset target after adoption; ${route} Reset records a rendered placement`, async () => {
  const view = await resetHarness({ collapsed: false, active: false, reachable: true });
  const { h } = view;
  try {
    h.pendingRoomSeat = false;
    h.applyMatrix4 = applyMatrix4;
    const original = structuredClone(view.snapshot().placement);
    delete h.roomEntry.seat; // adopt(source) invalidates the outgoing structure's entry.
    h.scientificRepresentations = () => [];
    h.presentationTransform = () => h.placementTransform(view.snapshot().placement);
    h.restoreTourSeat = async () => {};
    h.fitInspection = async () => { throw Error('XR camera must not reset'); };
    h.journeySeatDetail = journeySeatDetail;
    for (const name of ['restoreJourneySeat', 'recordJourneySeat']) vm.runInContext(pageFunction(viewer, name), h);
    await h.restoreJourneySeat({ scene: { camera: h.canvas.camera.getSnapshot() } });
    assert.ok(h.roomEntry.seat, 'Done must commit a Reset target before a later XR frame can capture its dodge');
    const entry = structuredClone(h.roomEntry.seat);
    h.inspectionState.place({ translation: [2, 1.6, -2], rotation: [12, 31, 4] }, 'wearer edit');
    h.applyInspectionTransform();
    const before = structuredClone(view.snapshot().placement), offset = view.records.length;
    if (route === 'menu') await view.pressReset();
    else { assert.equal((await view.menu.toolbar.aimSynthetic({ id: 'reset' })).fired, true); await flush(); }
    assert.deepEqual(view.errors, []);
    assert.notDeepEqual(view.snapshot().placement.translation, before.translation);
    assert.deepEqual(view.snapshot().placement.rotation, entry.rotation);
    assert.equal(view.snapshot().placement.scale, original.scale);
    assert.ok(view.records.slice(offset).some(record => record.kind === 'xr-button'
      && record.action === 'recenter-structure'), 'the driver reads this post-render diagnostic');
    assert.equal(view.cameraWrites.length, 0);
  } finally { await view.menu.toolbar.dispose(); }
});

test('Reset immediately after a bounded Done dodge restores its pre-dodge seat and emits the driver receipt', async () => {
  const view = await resetHarness({ collapsed: false, active: false, reachable: true });
  const { h } = view;
  try {
    Object.assign(h, { applyMatrix4, pendingRoomSeat: false });
    const entry = { translation: [0, 1.6, -2.5], scale: .35, rotation: [0, 0, 0] };
    h.inspectionState.place(entry, 'restored source'); h.applyInspectionTransform();
    const views = syntheticViews().map(eye => {
      const matrix = [...eye.transform.matrix]; matrix[13] = 1.6;
      return { ...eye, transform: { matrix, inverse: { matrix: Mat4.invert(Mat4(), matrix) } } };
    });
    h.latestRoomPlacementPose.labelViews = views;
    const cell = value => ({ ref: { value } });
    h.presentationTransform = () => h.placementTransform(view.snapshot().placement);
    h.scientificRepresentations = () => [{ renderObjects: [{ type: 'mesh', state: { visible: true }, values: {
      drawCount: cell(6), instanceCount: cell(1), aTransform: cell(h.presentationTransform()),
      aPosition: cell([-.05, .05].flatMap(x => [-.1, .1].map(y => [x * 100, y * 100, 0])).flat()),
    } }] }];
    // A narrow caption envelope overlaps the restored mesh. The actual menu
    // dispatcher, Reset geometry, and rendered receipt still run below.
    h.immersiveSession.platePoints = () => [-.3, -.01].flatMap(x => [1.4, 1.8].map(y => [x, y, -1]));
    // The obstruction persists in the restored menu, so Done must clear it.
    const preview = h.immersiveSession.toolbarPlacementPoints;
    h.immersiveSession.toolbarPlacementPoints = options => options.restoreTourSeat
      ? h.immersiveSession.platePoints() : preview(options);
    h.restoreTourSeat = async () => {};
    h.fitInspection = async () => { throw Error('must preserve the XR camera'); };
    delete h.roomEntry.seat;
    h.journeySeatDetail = journeySeatDetail;
    for (const name of ['restoreJourneySeat', 'recordJourneySeat']) vm.runInContext(pageFunction(viewer, name), h);
    await h.restoreJourneySeat({ scene: { camera: h.canvas.camera.getSnapshot() } });
    const afterDone = structuredClone(view.snapshot().placement);
    assert.notDeepEqual(afterDone.translation, entry.translation, 'Done rendered a lateral dodge');
    assert.equal(afterDone.scale, entry.scale);
    assert.deepEqual(h.roomEntry.seat, entry);
    const start = view.records.length;
    await view.pressReset();
    assert.deepEqual(view.snapshot().placement, entry, 'Reset reverses the Done dodge without an intervening edit');
    assert.ok(view.records.slice(start).some(record => record.kind === 'xr-button' && record.action === 'recenter-structure'));
    assert.equal(view.cameraWrites.length, 0);
  } finally { await view.menu.toolbar.dispose(); }
});


for (const entry of ['fit', 'reset']) {
  for (const motion of ['grip', 'slide-stick', 'push-stick', 'released-bake', 'transient']) {
    test(`${entry} refuses ${motion} before changing the saved seat or accumulated movement`, async () => {
      const v = await resetHarness({ collapsed: true, active: false }), h = v.h;
      if (motion === 'transient') { h.grabScale = 1.2; h.grabOffset = [.2, 0, -.1]; }
      const heldScale = h.grabScale, heldOffset = h.grabOffset;
      if (motion === 'grip') h.xrManipulation = { phase: () => 'grabbing' };
      if (motion === 'slide-stick') h.xrThumbstick = { moving: () => true };
      if (motion === 'push-stick') h.xrPushStick = { moving: () => true };
      if (motion === 'released-bake') h.xrDeferredBake = Promise.resolve();
      const before = JSON.stringify(v.snapshot()), writes = v.writes.length;
      await assert.rejects(entry === 'reset' ? h.runFaceAction('recenter-structure') : h.onSpatialAction({ kind: 'fit' }), /Let go of it first/);
      assert.equal(JSON.stringify(v.snapshot()), before);
      assert.equal(v.writes.length, writes);
      assert.equal(h.grabScale, heldScale); assert.deepEqual(h.grabOffset, heldOffset);
      if (entry === 'reset') assert.ok(v.records.some(record => record.kind === 'xr-button' && record.outcome === 'held'));
    });
  }
}

test('fit rechecks movement started while pausing presentation before saving the seat', async () => {
  const v = await resetHarness({ collapsed: true, active: false }), h = v.h;
  const before = JSON.stringify(v.snapshot()), writes = v.writes.length;
  h.setInspectionMotion = async () => { h.grabScale = 1.3; };
  await assert.rejects(h.onSpatialAction({ kind: 'fit' }), /Let go of it first/);
  assert.equal(JSON.stringify(v.snapshot()), before);
  assert.equal(v.writes.length, writes); assert.equal(h.grabScale, 1.3);
});

test('Reset clears a cutaway beyond the room before fitting a visible structure', async () => {
  const view = await resetHarness({ collapsed: true, active: true });
  const { h } = view;
  try {
    view.measureGrabGeometry();
    let clipping = 25;
    const snapshot = h.inspectionSnapshot;
    h.inspectionSnapshot = () => ({ ...snapshot(), appearance: { clipping } });
    const open = structuredClone(h.latestRoomPlacementPose.labelViews);
    for (const v of h.latestRoomPlacementPose.labelViews) {
      const n = 5, f = 50;
      v.projectionMatrix[10] = -(f+n)/(f-n); v.projectionMatrix[14] = -2*f*n/(f-n);
    }
    h.configureInspection = async patch => { clipping = patch.clipping; h.latestRoomPlacementPose.labelViews = open; };
    await view.pressReset();
    assert.equal(clipping, 0);
    assert.ok(view.snapshot().placement.scale >= .01);
    assert.equal(view.cameraWrites.length, 0);
  } finally { await view.menu.toolbar.dispose(); }
});
