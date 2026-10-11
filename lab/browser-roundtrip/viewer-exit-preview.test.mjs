import { emptyLessonFigureBinding } from './fixtures/empty-lesson-figure.mjs';
import { cameraSnapshot } from './camera-snapshot.mjs';
import { normalizeStyles } from './inspection-styles.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { createRoomSeatMemory, initialRoomCameraScale } from './room-seat-memory.mjs';
import { emptyVisibility, normalizeVisibility } from './inspection-visibility.mjs';
import { createGesturePivot } from './gesture-pivot.mjs';
const require = createRequire(new URL('../../plugin/package.json', import.meta.url));
const { Camera } = require('molstar/lib/commonjs/mol-canvas3d/camera.js');
const { TrackballControls } = require('molstar/lib/commonjs/mol-canvas3d/controls/trackball.js');
const { Vec3 } = require('molstar/lib/commonjs/mol-math/linear-algebra.js');
const { BoundaryHelper } = require('molstar/lib/commonjs/mol-math/geometry/boundary-helper.js');
const recording = JSON.parse(readFileSync(new URL('./fixtures/exit-acceptance-6.json', import.meta.url)));
const source = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
const fn = name => {
  const start = source.indexOf(`  ${source.includes(`async function ${name}(`) ? 'async ' : ''}function ${name}(`);
  assert.ok(start >= 0, `missing ${name}`);
  const lineEnd = source.indexOf('\n', start);
  return source.slice(start, source.slice(start, lineEnd).trimEnd().endsWith('}') ? lineEnd : source.indexOf('\n  }', start) + 4);
};

for (const immersive of [false, true]) {
  test(`deliberate named restore restores placement while ${immersive ? 'XR keeps its tracked camera' : 'desktop keeps the named camera'}`, async () => {
    const livePlacement = { scale: 2 }, savedPlacement = { scale: 1 };
    const liveCamera = { position: [0, 0, 12] }, savedCamera = { position: [5, 0, 7] };
    let placement = livePlacement, camera = liveCamera, fitted = 0;
    const context = vm.createContext({ ...emptyLessonFigureBinding(), companionRecord:undefined, retiredComparisons:new Set(),
      gesturePivot: createGesturePivot(), focusPivotRequest: undefined,
    restoreCompanion:async value=>{ if(value!==undefined) throw Error('This primary-only fixture does not carry a comparison.'); },
    paintCompanion:async()=>{},
      assertReady() {}, validInspectionCapture: value => value,
      // A restore believes the saved hidden set before the
      // appearance rebuild; the real reader answers "nothing hidden" here.
      normalizeVisibility, visibilityState: emptyVisibility(), normalizeStyles, stylesState: [], styleLayers: [], savedStyles: () => ({}), savedVisibility: () => ({}),
      wearerPlacement: { holdsPlacement: () => true, state: () => ({}) },
      recordManipulation() {}, inspectionSnapshot: () => ({ placement }),
      lessonMotionHold: { release() {} }, inspectionMutation: async operation => operation(),
      syncInspectionPayload() {}, markSelection() {},
      inspectionState: { replace: value => { placement = value.placement; }, setPayload() {} },
      applyInspectionAppearance: async () => {}, applyInspectionTransform() {},
      fitDesktopPreview: () => { fitted++; }, inspectionPayload: () => ({ camera, selectionKeys: [] }),
      canvas: { camera: { setState: value => { camera = value; } } }, desktopPreviewCamera: undefined,
      state: { selectionKeys: [] }, scene: { inspection: { placement: savedPlacement }, camera: savedCamera, keys: [] },
      immersive,
    });
    vm.runInContext(fn('invalidateGesturePivot') + '\n' + fn('restoreInspection'), context);
    await vm.runInContext('restoreInspection(scene, {preserveCamera: immersive})', context);
    assert.equal(placement, livePlacement, 'passive restore still respects held placement');
    assert.equal(fitted, 1, 'passive restore retains automatic preview policy');
    camera = liveCamera;
    await vm.runInContext('restoreInspection(scene, {preserveCamera: immersive, restorePlacement: true, preservePreviewCamera: true})', context);
    assert.equal(placement, savedPlacement, 'explicit named restore restores its requested placement');
    assert.equal(camera, immersive ? liveCamera : savedCamera);
    assert.equal(fitted, 1, 'named restore does not refit its intentional camera');
  });
}

test('flat preview fits committed scientific render bounds and excludes UI and invisible objects', () => {
  const object = (center, radius, visible = true, count = 12) => ({
    state: { visible }, values: { boundingSphere: { ref: { value: { center, radius } } },
      drawCount: { ref: { value: count } } },
  });
  const primary = object([20, 10, -40], 30), ligand = object([-40, 0, -20], 8);
  const selector = renderObjects => ({ obj: { data: { repr: { renderObjects } } } });
  const camera = new Camera(undefined, { x: 0, y: 0, width: 900, height: 600 });
  let commits = 0;
  const context = vm.createContext({ ...emptyLessonFigureBinding(), companionRecord:undefined, retiredComparisons:new Set(),
    restoreCompanion:async value=>{ if(value!==undefined) throw Error('This primary-only fixture does not carry a comparison.'); },
    paintCompanion:async()=>{}, styleLayers: [], enableXr: true, BoundaryHelper,
    representation: selector([primary, object([10000, 0, 0], 1000, false), object([0, 10000, 0], 1000, true, 0)]),
    ligandOverlay: { representation: selector([ligand]) }, inspectionLabel: undefined,
    componentLabels: [selector([object([0, 0, 10000], 1000)])],
    inspectionState: {}, state: { status: 'ready' }, desktopPreviewCamera: undefined, desktopPreviewMaxDistance: undefined, Vec3,
    cameraSnapshot: value => structuredClone(value),
    canvas: { camera, xr: { isPresenting: { value: false } }, handleResize() {},
      commit() { commits++; }, requestDraw() {} },
  });
  vm.runInContext(`${fn('scientificRepresentations')}\n${fn('molecularBounds')}\n${fn('fitDesktopPreview')}\nfitDesktopPreview()`, context);
  const sphere = vm.runInContext('molecularBounds()', context), fitted = camera.getSnapshot();
  assert.equal(commits, 1);
  assert.deepEqual(Array.from(fitted.target), Array.from(sphere.center));
  for (const renderObject of [primary, ligand]) {
    const part = renderObject.values.boundingSphere.ref.value;
    assert.ok(Math.hypot(...part.center.map((v, i) => v - fitted.target[i])) + part.radius <= fitted.radius);
  }
  assert.ok(fitted.radius < 100, 'hidden, empty and UI render objects cannot inflate the fit');
  // Simulate a committed geometry change: the next fit must read fresh values.
  primary.values.boundingSphere.ref.value = { center: [200, 0, -100], radius: 60 };
  vm.runInContext('fitDesktopPreview()', context);
  assert.notDeepEqual(camera.getSnapshot().target, fitted.target);
  assert.equal(commits, 2);

  // A live comparison can be far outside the primary subject's bounds after
  // the wearer places it beside that subject. Preview both without changing
  // the primary-only bounds used by room entry and manipulation.
  const primaryBounds = vm.runInContext('molecularBounds()', context);
  const comparison = object([500, 0, -100], 40);
  const hiddenComparison = object([10000, 0, 0], 1000, false);
  const emptyComparison = object([0, 10000, 0], 1000, true, 0);
  context.companionRecord = { representation: selector([comparison, hiddenComparison, emptyComparison]) };
  vm.runInContext('fitDesktopPreview()', context);
  const compared = camera.getSnapshot();
  assert.deepEqual(vm.runInContext('molecularBounds()', context), primaryBounds,
    'the primary subject frame must remain independent of the comparison');
  for (const renderObject of [primary, ligand, comparison]) {
    const part = renderObject.values.boundingSphere.ref.value;
    assert.ok(Math.hypot(...part.center.map((v, i) => v - compared.target[i])) + part.radius <= compared.radius,
      'the preview must contain every visible scientific structure');
  }
  assert.ok(compared.radius < 1000, 'hidden and empty comparison objects cannot inflate the fit');
  assert.equal(commits, 3);
});

for (const automatic of [true, false]) {
  test(`flat preview ${automatic ? 'temporarily raises automatic' : 'preserves explicit'} real trackball limits`, () => {
    const camera = new Camera(undefined, { x: 0, y: 0, width: 1280, height: 493 });
    camera.setState({ radius: 56.56422404345791, radiusMax: 56.56422404345791 }, 0);
    const roomCamera = camera.getSnapshot(), placement = { scale: 7.8298772600213935, translation: [1, 2, -4] };
    const savedPlacement = structuredClone(placement), originalMax = 565.6422404345791;
    const input = Object.fromEntries(['drag', 'interactionEnd', 'wheel', 'pinch', 'keyDown', 'keyUp', 'move', 'lock', 'leave']
      .map(name => [name, { subscribe: () => ({ unsubscribe() {} }) }]));
    let sphere = { center: [20, 10, -40], radius: 350 };
    const controls = TrackballControls.create(input, camera, { get boundingSphereVisible() { return sphere; } }, {
      maxDistance: originalMax, staticMoving: true,
      autoAdjustMinMaxDistance: automatic ? { name: 'on', params: { minDistanceFactor: 0, minDistancePadding: 5,
        maxDistanceFactor: 10, maxDistanceMin: 20 } } : { name: 'off', params: {} },
    });
    const writes = [];
    const canvas = { camera, xr: { isPresenting: { value: false } }, handleResize() {}, commit() {}, requestDraw() {},
      get props() { return { trackball: { ...controls.props } }; },
      // Canvas3D.setProps forwards this field to its actual TrackballControls.
      setProps(props) { writes.push(props); controls.setProps(props.trackball); },
    };
    const c = vm.createContext({ ...emptyLessonFigureBinding(), enableXr: true, canvas, Vec3, representation: { obj: {} },
      inspectionState: {}, desktopPreviewCamera: undefined, desktopPreviewMaxDistance: undefined,
      cameraSnapshot: value => structuredClone(value), molecularBounds: () => sphere,
      state: { selectionKeys: [] }, savedStyles: () => ({}), savedVisibility: () => ({}),
      roomSeatMemory: { take: () => undefined }, liveScene: () => ({}), inspectionSnapshot: () => ({ placement }),
      roomCameraInitialized: true, wearerPlacedInRoom: false });
    vm.runInContext([fn('fitDesktopPreview'), fn('releaseDesktopPreviewLimit'), fn('restoreImmersiveCamera'), fn('inspectionPayload')].join('\n'), c);
    for (const [index, radius] of (automatic ? [350, 800, 1050, 14] : [350]).entries()) {
      sphere = { center: [20, 10, -40], radius };
      c.fitDesktopPreview();
      const focus = camera.getSnapshot();
      controls.update(index + 1); camera.update();
      const distance = Vec3.distance(camera.position, camera.target);
      assert.equal(distance * Math.sin(camera.state.fov / 2) >= radius, automatic,
        'the actual controls tick must retain the complete fit only when limits are automatic');
      if (automatic) assert.deepEqual(camera.getSnapshot(), focus, 'the fitted camera must survive the actual trackball clamp');
      assert.deepEqual(c.inspectionPayload().camera, roomCamera, 'scientific captures retain the original room camera');
      assert.deepEqual(placement, savedPlacement);
    }
    if (automatic) {
      assert.equal(c.desktopPreviewMaxDistance.original, originalMax, 'repeated fits retain the first control limit');
      assert.ok(writes.length >= 2);
    } else {
      assert.equal(controls.props.maxDistance, originalMax); assert.equal(writes.length, 0);
    }
    canvas.xr.isPresenting.value = true; c.restoreImmersiveCamera();
    assert.equal(controls.props.maxDistance, originalMax, 'XR entry restores the original controls');
    assert.deepEqual(camera.getSnapshot(), roomCamera);
    assert.equal(c.desktopPreviewMaxDistance, undefined);
    assert.deepEqual(placement, savedPlacement);
    if (automatic) {
      canvas.xr.isPresenting.value = false; sphere.radius = 350; c.fitDesktopPreview();
      controls.setProps({ maxDistance: 1500 }); // A newer source's automatic policy owns this value.
      c.releaseDesktopPreviewLimit();
      assert.equal(controls.props.maxDistance, 1500, 'releasing a stale preview cannot overwrite newer source limits');
    }
    controls.dispose();
  });
}

for (const path of ['exit', 'saved scene restore']) {
  test(`acceptance 6 ${path} fits the measured molecular envelope and retains the next XR camera`, async () => {
    // The recorded anchors are centres/radii in the measured eye basis. Undo
    // tangent projection to retain every component sphere, without inventing
    // replacement layout inputs or including plate extents in the molecule.
    const layout = recording.bigger.find(e => e.kind === 'component-label-layout').detail;
    const spheres = layout.anchors.map(a => ({ center: [a.x * a.z, a.y * a.z, -a.z], radius: a.r }));
    const bounds = new BoundaryHelper('98'); bounds.reset();
    for (const sphere of spheres) bounds.includeSphere(sphere);
    bounds.finishedIncludeStep(); for (const sphere of spheres) bounds.radiusSphere(sphere);
    const camera = new Camera(undefined, { x: 0, y: 0, width: recording.viewport[0], height: recording.viewport[1] });
    camera.setState({ radius: 10 }, 0);
    const roomCamera = camera.getSnapshot();
    const placement = { scale: recording.bigger.find(e => e.kind === 'wearer-placement').detail.scale };
    const saved = JSON.stringify(placement);
    const canvas = { camera, xr: { isPresenting: { value: false } }, commit() {}, requestDraw() {} };
    let restoredPlacement = placement, payload;
    const inspectionState = { replace(value) { restoredPlacement = value.placement; }, setPayload(value) { payload = value; } };
    const context = vm.createContext({ ...emptyLessonFigureBinding(), companionRecord:undefined, retiredComparisons:new Set(),
      gesturePivot: createGesturePivot(), focusPivotRequest: undefined,
    restoreCompanion:async value=>{ if(value!==undefined) throw Error('This primary-only fixture does not carry a comparison.'); },
    paintCompanion:async()=>{}, styleLayers: [], enableXr: true, canvas, inspectionState, representation: { obj: {} },
      state: { selectionKeys: [] }, assertReady() {}, validInspectionCapture: value => value,
      wearerPlacement: { holdsPlacement: () => false }, lessonMotionHold: { release() {} },
      inspectionMutation: async operation => operation(), syncInspectionPayload() {}, markSelection() {},
      applyInspectionTransform() {},
      // A restore believes the saved hidden set before the
      // appearance rebuild, so the real reader is supplied rather than a stub.
      normalizeVisibility, visibilityState: emptyVisibility(), normalizeStyles, stylesState: [], styleLayers: [], savedStyles: () => ({}), savedVisibility: () => ({}),
      desktopPreviewCamera: undefined, desktopPreviewMaxDistance: undefined, Vec3,
      cameraSnapshot: value => structuredClone(value),
      molecularBounds: () => bounds.getSphere() });
    Object.assign(context, { roomSeatMemory: createRoomSeatMemory(), initialRoomCameraScale,
      roomCameraInitialized: true, liveScene: () => ({}), inspectionSnapshot: () => ({ placement }) });
    // Exercise the production exit callback, not just camera arithmetic.
    context.canRebuildForXr = () => false;
    context.applyInspectionAppearance = async () => {};
    vm.runInContext(`'use strict';${source.includes('function fitDesktopPreview(') ? fn('fitDesktopPreview') : ''}
      ${fn('releaseDesktopPreviewLimit')}
      ${source.includes('function restoreImmersiveCamera(') ? fn('restoreImmersiveCamera') : ''}`, context);
    if (path === 'exit') {
      const hook = source.match(/onLeavingPresentation: (async \(\) => \{[^\n]+\})/)[1];
      await vm.runInContext(`(${hook})()`, context);
    } else {
      // Execute the real restore closure with an explicit strict-VM workspace.
      vm.runInContext(`${fn('invalidateGesturePivot')}\n${fn('inspectionPayload')}\n${fn('restoreInspection')}`, context);
      context.savedScene = { camera: roomCamera, keys: [], inspection: { placement } };
      await vm.runInContext('restoreInspection(savedScene)', context);
      assert.deepEqual(payload.camera, roomCamera, 'restore publishes the room camera, not its preview');
      assert.equal(JSON.stringify(restoredPlacement), saved);

    }
    const fitted = camera.getSnapshot();
    assert.deepEqual(Array.from(fitted.target), Array.from(bounds.getSphere().center));
    assert.ok(fitted.radius >= bounds.getSphere().radius);
    const distance = Math.hypot(...fitted.position.map((v, i) => v - fitted.target[i]));
    assert.ok(distance * Math.sin(fitted.fov / 2) >= bounds.getSphere().radius, 'full sphere fits the vertical viewport');
    assert.equal(JSON.stringify(placement), saved);
    canvas.xr.isPresenting.value = true;
    context.presenting = true;
    context.beginRoomEntry = () => assert.deepEqual(camera.getSnapshot(), roomCamera);
    const entry = source.slice(source.indexOf('canvas.xr.isPresenting.subscribe(presenting => {') + 'canvas.xr.isPresenting.subscribe(presenting => {'.length);
    vm.runInContext(entry.slice(0, entry.indexOf('beginRoomEntry(presenting);') + 'beginRoomEntry(presenting);'.length), context);
    assert.deepEqual(camera.getSnapshot(), roomCamera, 'the room reference frame survives the flat fit');
    assert.equal(JSON.stringify(placement), saved, 'next entry retains the recorded scale');
  });
}

for (const condition of ['lost', 'recovering', 'zero-width', 'zero-height', 'nonfinite-width', 'invalid-focus']) {
  test(`desktop preview preserves camera ownership and limits for ${condition}`, () => {
    const camera = new Camera(undefined, { x: 0, y: 0, width: 900, height: 600 });
    const before = camera.getSnapshot(), priorOwner = structuredClone(before);
    let resizes = 0, writes = 0;
    const canvas = { camera, webgl: { isContextLost: condition === 'lost' }, xr: { isPresenting: { value: false } },
      handleResize() { resizes++; if (condition === 'zero-width') camera.viewport.width = 0;
        if (condition === 'zero-height') camera.viewport.height = 0;
        if (condition === 'nonfinite-width') camera.viewport.width = NaN; },
      props: { trackball: { autoAdjustMinMaxDistance: { name: 'on' }, maxDistance: 10 } },
      commit() {}, requestDraw() { writes++; }, setProps() { writes++; } };
    if (condition === 'invalid-focus') camera.getFocus = () => ({ ...before, position: [NaN, NaN, NaN] });
    const c = vm.createContext({ canvas, enableXr: true, inspectionState: {}, representation: { obj: {} },
      state: { status: condition === 'recovering' ? 'recovering' : 'ready' }, Vec3, cameraSnapshot,
      molecularBounds: () => ({ center: [3, 4, 5], radius: 90 }),
      desktopPreviewCamera: priorOwner, desktopPreviewMaxDistance: { original: 5, applied: 10 } });
    vm.runInContext(fn('fitDesktopPreview'), c);
    if (condition === 'invalid-focus') assert.throws(() => c.fitDesktopPreview(), /three finite numbers/);
    else c.fitDesktopPreview();
    assert.deepEqual(camera.getSnapshot(), before);
    assert.equal(c.desktopPreviewCamera, priorOwner);
    assert.deepEqual(c.desktopPreviewMaxDistance, { original: 5, applied: 10 });
    assert.equal(writes, 0);
    // Invalid fits must not acquire ownership either.
    c.desktopPreviewCamera = undefined; c.desktopPreviewMaxDistance = undefined;
    if (condition === 'invalid-focus') assert.throws(() => c.fitDesktopPreview(), /three finite numbers/);
    else c.fitDesktopPreview();
    assert.equal(c.desktopPreviewCamera, undefined);
    assert.equal(c.desktopPreviewMaxDistance, undefined);
    assert.deepEqual(camera.getSnapshot(), before);
    assert.equal(writes, 0);
    if (condition === 'lost' || condition === 'recovering') assert.equal(resizes, 0);
  });
}
