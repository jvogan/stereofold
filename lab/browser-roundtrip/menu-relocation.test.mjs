import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { toolbarFrameRuntime, toolbarFrameHarness, identity } from './fixtures/toolbar-frame-runtime.mjs';
import { syntheticViews } from './fixtures/component-label-diagnostics.mjs';
import { solveAppearanceFit } from './appearance-fit-worker.mjs';
import { resetEntryGeometry, resetEntryLateralBreakdown } from './reset-entry-geometry.mjs';
import { createToolbarPanel } from './spatial-toolbar-geometry.mjs';
import { menuSeatWithinView, menuSeatInEyeViews } from './menu-view-band.mjs';
import { glassPlatesOverlap } from './glass-overlap.mjs';
import { pageFunction } from './fixtures/label-action-harness.mjs';
import { menuDragOffset } from './menu-relocation.mjs';

const runtime = await toolbarFrameRuntime(new URL('./', import.meta.url));
const viewer = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
const cell = value => ({ ref: { value } });
const head = [...identity]; head[13] = 1.6;
const views = () => syntheticViews().map(view => {
  view.transform.matrix[13] = 1.6; view.transform.inverse.matrix[13] = -1.6; return view;
});
const subject = center => ({ type: 'mesh', state: { visible: true }, values: {
  drawCount: cell(24), instanceCount: cell(1), aTransform: cell(identity),
  aPosition: cell([-.1, .1].flatMap(x => [-.1, .1].flatMap(y => [-.1, .1].flatMap(z =>
    [center[0] + x, center[1] + y, center[2] + z])))),
} });
const fitInput = (points, center, candidates) => ({ fit: true, allowOffscreen: true,
  seat: { scale: 1, translation: [0, 0, 0], rotation: [12, 24, 6] },
  headInRoom: head, renderFromRoom: identity, cameraScale: 1, center: [0, 0, 0], radius: 1,
  points, menuCandidates: candidates.map(({ id, points, views }) => ({ id, points, ...(views ? { views } : {}) })),
  geometry: { objects: [subject(center)], fromPlacement: identity, toPlacement: identity, views: views() },
});

async function menu(options = {}) {
  const t = toolbarFrameHarness(runtime, options);
  await t.toolbar.update();
  return t;
}

test('compact default leaves the molecule a wider central view and uses grip movement without a jump row', async () => {
  const t = await menu({ state: { voice: { state: 'idle' } } });
  try {
    assert.equal(t.toolbar.isCollapsed(), true);
    assert.equal(t.toolbar.rows().some(row => row.action.kind === 'recenter-menu'), false);
    assert.ok(t.toolbar.rows().some(row => row.label === 'Menu'));
    const compact = Math.abs(t.toolbar.seatAnchor()[0]);
    t.toolbar.runAction({ kind: 'collapse', value: false });
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(compact > Math.abs(t.toolbar.seatAnchor()[0]), 'narrow compact glass sits farther to the side');
  } finally { await t.toolbar.dispose(); }
});

test('menu candidates are read-only, include all caption glass, and stay visible in both eyes', async () => {
  const t = await menu({ state: { tour: { active: true, canNext: true, title: 'Contact', body: 'See the contact.' } } });
  try {
    const before = t.toolbar.platePoints();
    const candidates = t.toolbar.prepareRelocation({ headInRoom: head });
    assert.ok(candidates.length > 1);
    assert.deepEqual(t.toolbar.platePoints(), before);
    for (const candidate of candidates.filter(value => !value.hide)) assert.ok(menuSeatWithinView(candidate.points, candidate.head));
  } finally { await t.toolbar.dispose(); }
});

test('real worker keeps the requested molecule and clears the relocated full menu in both eyes', async () => {
  const t = await menu();
  try {
    const candidates = t.toolbar.prepareRelocation({ headInRoom: head });
    const options = fitInput(t.toolbar.platePoints(), t.toolbar.seatAnchor(), candidates);
    const saved = structuredClone(options.seat);
    const fitted = solveAppearanceFit(options);
    assert.notEqual(fitted.menuRelocation, undefined);
    const candidate = candidates.find(value => value.id === fitted.menuRelocation);
    await t.toolbar.commitRelocation(candidate);
    assert.deepEqual(t.toolbar.platePoints(), candidate.points, 'drawn full glass equals worker proof');
    const geometry = resetEntryGeometry({ ...options.geometry, cameraScale: 1, renderFromRoom: identity });
    assert.ok(resetEntryLateralBreakdown({ geometry, points: t.toolbar.platePoints(), clearance: 0 }).eyes.every(eye => eye.separated));
    const { menuRelocation, ...pose } = fitted;
    assert.deepEqual(pose, saved);
    assert.deepEqual(options.seat, saved);
  } finally { await t.toolbar.dispose(); }
});

test('a stale menu candidate never moves the glass', async () => {
  const t = await menu();
  try {
    const candidate = t.toolbar.prepareRelocation({ headInRoom: head }).find(value => value.anchor?.[0] > 0);
    t.toolbar.runAction({ kind: 'collapse', value: false });
    await new Promise(resolve => setImmediate(resolve));
    const before = t.toolbar.platePoints();
    await assert.rejects(t.toolbar.commitRelocation(candidate), error => error.code === 'FIT_STALE');
    assert.deepEqual(t.toolbar.platePoints(), before);
  } finally { await t.toolbar.dispose(); }
});

test('failed relocation draw restores the previous menu and leaves the molecule untouched', async () => {
  let fail = false;
  const t = await menu({ presentation: { add() { if (fail) { fail = false; throw Error('draw failed'); } } } });
  try {
    const before = t.toolbar.platePoints();
    const candidate = t.toolbar.prepareRelocation({ headInRoom: head }).find(value => value.anchor[0] > 0);
    fail = true;
    await assert.rejects(t.toolbar.commitRelocation(candidate), /draw failed/);
    assert.deepEqual(t.toolbar.platePoints(), before);
  } finally { await t.toolbar.dispose(); }
});

test('viewer applies the checked menu seat without replacing the wearer pose or camera', async () => {
  const t = await menu();
  t.toolbar.runAction({ kind: 'collapse', value: false });
  await new Promise(resolve => setImmediate(resolve));
  try {
    const options = fitInput(t.toolbar.platePoints(), t.toolbar.seatAnchor(), []);
    const placement = options.seat, scene = { placement };
    const canvas = { xr: { isPresenting: { value: true } }, webgl: { xr: { session: t.session } }, camera: { scale: 1 } };
    const h = vm.createContext({ now: () => performance.now(), canvas, placementViewWaiters: new Set(), state: { generation: 1, status: 'ready' }, sourceRecord: { sha256: 'fixture' },
      latestRoomPlacementPose: { headInRoom: head, renderFromRoom: identity, labelViews: views() },
      inspectionSnapshot: () => scene, wearerPlacement: { holdsPlacement: () => true },
      loadedSphere: () => ({ center: [0, 0, 0], radius: 1 }),
      scientificRepresentations: () => [{ renderObjects: options.geometry.objects }],
      presentationTransform: () => identity, placementTransform: () => identity,
      fitAppearanceInWorker: async input => solveAppearanceFit(input),
      immersiveSession: { platePoints: () => t.toolbar.platePoints(),
        toolbarRelocationCandidates: pose => t.toolbar.prepareRelocation(pose),
        relocateToolbar: candidate => t.toolbar.commitRelocation(candidate) },
    });
    vm.runInContext(pageFunction(viewer, 'clearHeldPlatePlacement'), h);
    const before = structuredClone(placement), camera = structuredClone(canvas.camera);
    const result = await h.clearHeldPlatePlacement(placement, { keepWearer: true });
    assert.equal(result, placement);
    assert.deepEqual(placement, before);
    assert.deepEqual(canvas.camera, camera);
    assert.ok(t.toolbar.seatAnchor()[0] > 0, 'the menu yielded to the intentional molecule pose');
  } finally { await t.toolbar.dispose(); }
});

const pointer = (point, handedness = 'left', emulatedPosition = false) => {
  const matrix = [...identity];
  for (let axis = 0; axis < 3; axis++) matrix[8 + axis] = -(point[axis] - [0, 1.6, 0][axis]);
  return { handedness, targetRaySpace: { pose: { emulatedPosition, transform: { matrix, position: { x: 0, y: 1.6, z: 0 } } } } };
};
const dispatch = (t, type, source) => {
  const event = Object.assign(new Event(type, { cancelable: true }), { inputSource: source, frame: t.frame });
  t.session.dispatchEvent(event);
};
const ray = source => ({ origin: [0, 1.6, 0], direction: source.targetRaySpace.pose.transform.matrix.slice(8, 11).map(v => -v) });
const builtPanel = (t, rows = t.toolbar.rows(), stableLesson = false) => createToolbarPanel({ stableLesson, rows, head: t.toolbar.head(), constants: t.toolbar.layout(), seatAnchor: t.toolbar.seatAnchor(), measureText: runtime.toolbarTextWidth });

for (const hand of ['left', 'right']) test(`${hand} menu drag works with the controller ten centimetres from the row`, async () => {
  let clock = 0; const offsets = [];
  const t = await menu({ now: () => clock,
    presentation: { setRoomOffset(_target, offset) { offsets.push([...offset]); } } });
  try {
    const before = [...t.toolbar.seatAnchor()];
    const button = builtPanel(t).buttons.find(button => button.action.kind === 'collapse');
    const source = pointer(button.point, hand); t.session.inputSources = [source];
    const pose = source.targetRaySpace.pose.transform;
    pose.position = { x: button.point[0], y: button.point[1], z: button.point[2] + .1 };
    pose.matrix[8] = 0; pose.matrix[9] = 0; pose.matrix[10] = 1;
    dispatch(t, 'selectstart', source);
    clock = 250; pose.position.x -= .05;
    t.toolbar.syncInput(t.frame);
    assert.ok(offsets.length > 0, 'a close controller still starts the menu drag');
    assert.ok(Math.abs(offsets.at(-1)[0] + .05) < 1e-9);
    dispatch(t, 'select', source); dispatch(t, 'selectend', source);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(Math.abs(t.toolbar.seatAnchor()[0] - before[0] + .05) < 1e-9, 'release saves the close drag');
  } finally { await t.toolbar.dispose(); }
});

test('a deliberately distant menu remains movable and can move farther away', () => {
  const ray = { origin: [0, 1.6, 0], direction: [0, 0, -1], emulatedPosition: false };
  assert.deepEqual(menuDragOffset([0, 1.6, -5], ray, { ...ray, origin: [.1, 1.6, -.1] }, [0, 1.6, 0]), [.1, 0, -.1]);
});

for (const hand of ['left', 'right']) test(`${hand} menu can be dragged beyond four metres, released and dragged again`, async () => {
  let clock = 0; const offsets = [];
  const t = await menu({ now: () => clock,
    presentation: { setRoomOffset(_target, offset) { offsets.push([...offset]); } } });
  try {
    const before = [...t.toolbar.seatAnchor()];
    const source = pointer(builtPanel(t).buttons.find(button => button.action.kind === 'collapse').point, hand);
    t.session.inputSources = [source];
    dispatch(t, 'selectstart', source);
    for (let step = 1; step <= 20; step++) {
      clock += step === 1 ? 250 : 14;
      source.targetRaySpace.pose.transform.position.z = -.2 * step;
      t.toolbar.syncInput(t.frame);
    }
    assert.ok(Math.abs(offsets.at(-1)[2] + 4) < 1e-9, 'continued measured travel has no four-metre wall');
    dispatch(t, 'select', source); dispatch(t, 'selectend', source);
    await new Promise(resolve => setImmediate(resolve));
    const distant = [...t.toolbar.seatAnchor()];
    assert.ok(Math.abs(distant[2] - before[2] + 4) < 1e-9);
    source.targetRaySpace = pointer(builtPanel(t).buttons.find(button => button.action.kind === 'collapse').point, hand).targetRaySpace;
    dispatch(t, 'selectstart', source);
    clock += 250; source.targetRaySpace.pose.transform.position.x = -.05;
    t.toolbar.syncInput(t.frame);
    dispatch(t, 'select', source); dispatch(t, 'selectend', source);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(Math.abs(t.toolbar.seatAnchor()[0] - distant[0] + .05) < 1e-9, 'a fresh press moves the distant menu');
  } finally { await t.toolbar.dispose(); }
});

for (const hand of ['left', 'right']) test(`${hand} held menu rebases a measured position jump and accepts the next deliberate movement`, async () => {
  let clock = 0; const offsets = [];
  const t = await menu({ now: () => clock,
    presentation: { setRoomOffset(_target, offset) { offsets.push([...offset]); } } });
  try {
    const before = [...t.toolbar.seatAnchor()];
    const button = builtPanel(t).buttons.find(button => button.action.kind === 'collapse');
    const source = pointer(button.point, hand); t.session.inputSources = [source];
    dispatch(t, 'selectstart', source);
    clock = 250; source.targetRaySpace.pose.transform.position.x = -.03;
    t.toolbar.syncInput(t.frame);
    const held = [...offsets.at(-1)];
    clock += 14; source.targetRaySpace.pose.transform.position.x -= .6;
    source.targetRaySpace.pose.transform.matrix[8] -= .2;
    t.toolbar.syncInput(t.frame);
    assert.deepEqual(offsets.at(-1), held, 'a tracking jump keeps the last drawn menu');
    clock += 14; source.targetRaySpace.pose.transform.position.x -= .02;
    t.toolbar.syncInput(t.frame);
    const continued = [...offsets.at(-1)];
    assert.ok(Math.abs(continued[0] - held[0] + .02) < 1e-9, 'the next deliberate movement continues from the held menu');
    dispatch(t, 'select', source); dispatch(t, 'selectend', source);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(Math.abs(t.toolbar.seatAnchor()[0] - before[0] - continued[0]) < 1e-9);
  } finally { await t.toolbar.dispose(); }
});

for (const hand of ['left', 'right']) test(`${hand} trigger drags the menu without rebuilding glyphs or changing molecular controls`, async () => {
  let clock = 0; const ownership = [], offsets = [], actions = [];
  const t = await menu({ now: () => clock, onConsumeSelect: event => ownership.push(event), onAction: action => actions.push(action),
    presentation: { setRoomOffset(target, offset) { offsets.push([...offset]); return true; } } });
  try {
    const before = [...t.toolbar.seatAnchor()];
    const button = builtPanel(t).buttons.find(button => button.action.kind === 'collapse');
    const source = pointer(button.point, hand); t.session.inputSources = [source];
    dispatch(t, 'selectstart', source); await new Promise(resolve => setImmediate(resolve));
    const builds = runtime.counts.ShapeRepresentation;
    clock = 250; source.targetRaySpace = pointer([1.5, 1.6, -.4], hand).targetRaySpace;
    t.toolbar.syncInput(t.frame);
    assert.ok(offsets.some(offset => Math.hypot(...offset) > .1));
    assert.equal(runtime.counts.ShapeRepresentation, builds + 1, 'drag builds one held rim, retaining every existing glyph and plate');
    assert.equal(ownership.filter(event => event.phase === 'start').length, 1);
    assert.equal(ownership.filter(event => ['end', 'cancel'].includes(event.phase)).length, 0, 'menu retains the whole held press');
    dispatch(t, 'select', source); dispatch(t, 'selectend', source);
    await new Promise(resolve => setImmediate(resolve));
    assert.notDeepEqual(t.toolbar.seatAnchor(), before);
    assert.equal(actions.length, 0, 'menu drag dispatches no molecular action');
    // A quick Menu tap changes its form while preserving the held seat.
    const moved = t.toolbar.seatAnchor();
    source.targetRaySpace = pointer(builtPanel(t).buttons.find(button => button.action.kind === 'collapse').point, hand).targetRaySpace;
    dispatch(t, 'selectstart', source); dispatch(t, 'select', source); dispatch(t, 'selectend', source);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(t.toolbar.seatAnchor(), moved, 'Menu expansion preserves the dragged position');
  } finally { await t.toolbar.dispose(); }
});

for (const hand of ['left', 'right']) for (const quality of [false, true, undefined]) {
  test(`${hand} menu drag uses orientation with ${String(quality)} emulatedPosition and only measured hand travel`, async () => {
    let clock = 0; const offsets = [];
    const t = await menu({ now: () => clock,
      presentation: { setRoomOffset(_target, offset) { offsets.push([...offset]); } } });
    try {
      const button = builtPanel(t).buttons.find(button => button.action.kind === 'collapse');
      const source = pointer(button.point, hand); source.targetRaySpace.pose.emulatedPosition = quality;
      t.session.inputSources = [source];
      dispatch(t, 'selectstart', source);
      clock = 250;
      source.targetRaySpace.pose.transform.position.x = .1;
      t.toolbar.syncInput(t.frame);
      if (quality === false) assert.ok(Math.abs(offsets.at(-1)[0] - .1) < 1e-9);
      else assert.equal(offsets.length, 0, 'inferred or unknown origin drift cannot start a menu move');
      const builds = runtime.counts.ShapeRepresentation;
      source.targetRaySpace = pointer([1.5, 1.6, -.4], hand).targetRaySpace;
      source.targetRaySpace.pose.emulatedPosition = quality;
      clock += 14; t.toolbar.syncInput(t.frame);
      assert.ok(offsets.some(offset => Math.hypot(...offset) > .1), 'orientation still moves the menu');
      assert.equal(runtime.counts.ShapeRepresentation, builds + (quality === false ? 0 : 1), 'one held rim per drag, never per frame');
    } finally { await t.toolbar.dispose(); }
  });
}

for (const hand of ['left', 'right']) for (const interruption of ['tracked-to-emulated', 'emulated-to-tracked', 'ray', 'head']) {
  test(`${hand} held menu rebases after ${interruption} without losing its placed offset`, async () => {
    let clock = 0; const offsets = [];
    const t = await menu({ now: () => clock,
      presentation: { setRoomOffset(_target, offset) { offsets.push([...offset]); } } });
    try {
      const before = [...t.toolbar.seatAnchor()];
      const button = builtPanel(t).buttons.find(button => button.action.kind === 'collapse');
      const initialQuality = interruption === 'emulated-to-tracked';
      const source = pointer(button.point, hand, initialQuality); t.session.inputSources = [source];
      dispatch(t, 'selectstart', source);
      clock = 250; source.targetRaySpace = pointer([1.5, 1.6, -.4], hand, initialQuality).targetRaySpace;
      t.toolbar.syncInput(t.frame);
      const held = [...offsets.at(-1)];
      assert.ok(Math.hypot(...held) > .1);
      const getViewerPose = t.frame.getViewerPose;
      if (interruption === 'ray') source.targetRaySpace = {};
      if (interruption === 'head') t.frame.getViewerPose = () => null;
      if (['ray', 'head'].includes(interruption)) { clock += 14; t.toolbar.syncInput(t.frame); }
      t.frame.getViewerPose = getViewerPose;
      source.targetRaySpace = pointer([1.2, 1.6, -.7], hand,
        interruption.includes('-to-') ? !initialQuality : initialQuality).targetRaySpace;
      source.targetRaySpace.pose.transform.position.x = .3;
      clock += 14; t.toolbar.syncInput(t.frame);
      assert.deepEqual(offsets.at(-1), held, 'the recovery frame keeps the last drawn menu');
      source.targetRaySpace.pose.transform.matrix[8] -= .05;
      clock += 14; t.toolbar.syncInput(t.frame);
      const continued = [...offsets.at(-1)];
      assert.notDeepEqual(continued, held, 'the next orientation change continues dragging');
      dispatch(t, 'select', source); dispatch(t, 'selectend', source);
      await new Promise(resolve => setImmediate(resolve));
      const saved = t.toolbar.seatAnchor();
      for (let axis = 0; axis < 3; axis++) assert.ok(Math.abs(saved[axis] - before[axis] - continued[axis]) < 1e-9,
        'release saves the last drawn menu location');
    } finally { await t.toolbar.dispose(); }
  });
}

for (const hand of ['left', 'right']) test(`${hand} lesson press keeps ownership through redraw until trigger release`, async () => {
  const ownership = [];
  const state = { voice: { state: 'idle' }, tour: { selectedId: 'g', active: true, step: 1, canBack: true, canNext: true, chapterStartedAt: 0 } };
  const t = await menu({ state, onConsumeSelect: event => ownership.push(event) });
  try {
    // Lessons retain the same 2×2 controls when woken. Aim at the actual
    // stable grid, not a removed row of the old full-column footprint.
    const quiet = builtPanel(t, t.toolbar.rows(), true);
    const button = quiet.buttons.find(button => button.action.kind === 'tour-play');
    const before = t.toolbar.drawnMenuPoints();
    assert.ok(button, 'the lesson keeps its Play control');
    const source = pointer(button.point, hand); t.session.inputSources = [source];
    dispatch(t, 'selectstart', source); await new Promise(resolve => setImmediate(resolve));
    await t.toolbar.update();
    assert.deepEqual(t.toolbar.drawnMenuPoints(), before, 'a wake retains the complete lesson grid');
    source.targetRaySpace = pointer([0, 1.6, -3], hand).targetRaySpace;
    t.toolbar.syncInput(t.frame);
    assert.ok(t.toolbar.isHandOnPanel(hand), 'moving off the control cannot turn the press into a molecule grab');
    assert.deepEqual(ownership.map(event => event.phase), ['start']);
    dispatch(t, 'select', source); dispatch(t, 'selectend', source);
    assert.deepEqual(ownership.map(event => event.phase), ['start', 'end']);
    assert.equal(ownership[0].action.kind, 'tour-play');
  } finally { await t.toolbar.dispose(); }
});

for (const hand of ['left', 'right']) for (const revealFirst of [false, true]) {
  test(`${hand} molecule grab cancels a held menu drag before ${revealFirst ? 'reveal and release' : 'hidden release'}`, async () => {
    let clock = 0; const offsets = [], ownership = [], actions = [];
    const t = await menu({ now: () => clock, onConsumeSelect: event => ownership.push(event), onAction: action => actions.push(action),
      presentation: { setRoomOffset(_target, offset) { offsets.push([...offset]); } } });
    try {
      const before = [...t.toolbar.seatAnchor()];
      const source = pointer(builtPanel(t).buttons.find(button => button.action.kind === 'collapse').point, hand);
      t.session.inputSources = [source];
      dispatch(t, 'selectstart', source);
      clock = 250; source.targetRaySpace.pose.transform.position.x = -.1;
      t.toolbar.syncInput(t.frame);
      assert.ok(offsets.some(offset => Math.abs(offset[0] + .1) < 1e-9));
      // Production onGrabStart hides the toolbar when the other hand grabs.
      t.toolbar.setHidden(true);
      assert.deepEqual(offsets.at(-1), [0, 0, 0], 'hiding discards the uncommitted menu translation');
      assert.equal(t.toolbar.isHandOnPanel(hand), false);
      if (revealFirst) t.toolbar.setHidden(false);
      dispatch(t, 'select', source); dispatch(t, 'selectend', source);
      await new Promise(resolve => setImmediate(resolve));
      t.toolbar.setHidden(false);
      assert.deepEqual(t.toolbar.seatAnchor(), before, 'a cancelled drag cannot commit on a late release');
      assert.deepEqual(ownership.map(event => event.phase), ['start', 'cancel']);
      assert.deepEqual(actions, []);
    } finally { await t.toolbar.dispose(); }
  });
}

for (const hand of ['left', 'right']) test(`${hand} a hidden lesson press releases ownership immediately`, async () => {
  const ownership = [], actions = [];
  const state = { voice: { state: 'idle' }, tour: { selectedId: 'g', active: true, step: 1, canBack: true, canNext: true, chapterStartedAt: 0 } };
  const t = await menu({ state, onConsumeSelect: event => ownership.push(event), onAction: action => actions.push(action) });
  try {
    // Lessons retain the same 2×2 controls when woken. Aim at the actual
    // stable grid, not a removed row of the old full-column footprint.
    const quiet = builtPanel(t, t.toolbar.rows(), true);
    const button = quiet.buttons.find(button => button.action.kind === 'tour-play');
    const before = t.toolbar.drawnMenuPoints();
    const source = pointer(button.point, hand); t.session.inputSources = [source];
    dispatch(t, 'selectstart', source); await new Promise(resolve => setImmediate(resolve));
    assert.equal(t.toolbar.isHandOnPanel(hand), true);
    assert.deepEqual(t.toolbar.drawnMenuPoints(), before, 'a press keeps the lesson grid');
    t.toolbar.setHidden(true); t.toolbar.setHidden(true);
    assert.equal(t.toolbar.isHandOnPanel(hand), false, 'hidden controls cannot reserve a hand');
    assert.equal(t.toolbar.isRayOnPanel(ray(source)), false);
    assert.deepEqual(ownership.map(event => event.phase), ['start', 'cancel']);
    t.toolbar.setHidden(false);
    dispatch(t, 'select', source); dispatch(t, 'selectend', source);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(ownership.map(event => event.phase), ['start', 'cancel']);
    assert.deepEqual(actions, []);
  } finally { await t.toolbar.dispose(); }
});


test('a surrounding subject uses the hidden fallback with diagnostics and a working summon', async () => {
  const records = [], previous = globalThis.__stereofoldDiagnostics;
  globalThis.__stereofoldDiagnostics = { record: (kind, detail) => records.push({ kind, detail }) };
  const t = await menu();
  try {
    const candidates = t.toolbar.prepareRelocation({ headInRoom: head, labelViews: views(), renderFromRoom: identity });
    assert.ok(candidates.filter(value => !value.hide).every(value => !value.parked), 'an occupied forward view cannot admit glass beyond it');
    const input = fitInput(t.toolbar.platePoints(), [0, 1.6, 0], candidates);
    input.geometry.objects[0].values.aPosition = cell([ -10, 10 ].flatMap(x => [ -10, 10 ].flatMap(y => [ -10, 10 ].flatMap(z => [x, y + 1.6, z]))));
    const result = solveAppearanceFit(input);
    assert.equal(result.menuRelocation, 'hidden');
    assert.deepEqual(result.translation, input.seat.translation);
    await t.toolbar.commitRelocation(candidates.find(value => value.hide));
    assert.deepEqual(t.toolbar.platePoints(), []);
    assert.ok(records.some(({ detail }) => detail.hidden && detail.hint?.includes('B/Y')));
    t.toolbar.runAction({ kind: 'recenter-menu' });
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(t.toolbar.platePoints().length, 'the normal summon reveals parked controls');
    input.geometry.objects[0].values.aPosition = cell([NaN, NaN, NaN]);
    await assert.rejects(async () => solveAppearanceFit(input), /measurable/);
  } finally { await t.toolbar.dispose(); globalThis.__stereofoldDiagnostics = previous; }
});


test('a wide front wall uses the off fallback instead of parking controls beyond the lens', async () => {
  const t = await menu();
  try {
    const candidates = t.toolbar.prepareRelocation({ headInRoom: head, labelViews: views(), renderFromRoom: identity });
    const input = fitInput(t.toolbar.platePoints(), [0, 1.6, -1], candidates);
    input.geometry.objects[0].values.aPosition = cell([-2, 2].flatMap(x => [.1, 3].flatMap(y => [-1.1, -.9].flatMap(z => [x, y, z]))));
    const result = solveAppearanceFit(input);
    const candidate = candidates.find(value => value.id === result.menuRelocation);
    assert.equal(candidate?.hide, true);
    assert.deepEqual(result.translation, input.seat.translation);
    await t.toolbar.commitRelocation(candidate);
    assert.deepEqual(t.toolbar.platePoints(), []);
  } finally { await t.toolbar.dispose(); }
});


test('wearer menu intent is synchronous; programmatic Reset menu seating emits no local edit',async()=>{
  const intents=[];
  const t=toolbarFrameHarness(runtime,{onActionIntent:(action,{origin})=>{if(origin==='wearer')intents.push(action.kind);}});
  try {
    await t.toolbar.update();
    t.toolbar.runAction({kind:'recenter-menu'},{origin:'programmatic'});
    assert.deepEqual(intents,[]);
    t.toolbar.runAction({kind:'recenter-menu'});
    assert.deepEqual(intents,['recenter-menu'],'intent precedes the toolbar action queue');
  } finally {await t.toolbar.dispose();}
});


test('worker-approved reduced-status candidate outside a lesson commits and rolls back its exact glass', async () => {
  const metrics = JSON.parse(readFileSync(new URL('./fixtures/toolbar-bold-font-metrics.json', import.meta.url)));
  const measuredRuntime = await toolbarFrameRuntime(undefined, { glyphAdvances: metrics.advances });
  measuredRuntime.assistantStatus.update({ microphone: 'idle' });
  const t = toolbarFrameHarness(measuredRuntime, { state: { subject: { title: 'Contact', description: 'See the contact.' } } });
  await t.toolbar.update();
  try {
    const before = t.toolbar.platePoints();
    // The plain card is now above the gaze. The old 1.4x vertical projection
    // clips that card even with status removed, so no visible seat is legal.
    const clippedViews = views().map(view => { view.projectionMatrix[5] *= 1.4; return view; });
    assert.ok(t.toolbar.prepareRelocation({ headInRoom: head, labelViews: clippedViews, renderFromRoom: identity })
      .every(value => value.hide), 'never admit a card outside either lens');
    const labelViews = views();
    const candidates = t.toolbar.prepareRelocation({ headInRoom: head, labelViews, renderFromRoom: identity });
    const candidate = candidates.find(value => !value.hide && value.statusAside && value.anchor[0] > 0);
    assert.ok(candidate, 'binocular admission supplies a zero-status candidate');
    assert.ok(candidate.panel.captionBacking, 'keep the overhead information card');
    assert.equal(candidate.panel.statusBacking, undefined, 'exercise the reduced-status draw');
    assert.ok(menuSeatInEyeViews(candidate.points, labelViews, identity), 'all retained glass is visible in both eyes');
    assert.equal(glassPlatesOverlap(candidate.glass, labelViews), false, 'the retained plates do not cover each other');
    const input = fitInput(before, t.toolbar.seatAnchor(), [candidate]);
    input.geometry.views = labelViews;
    const fitted = solveAppearanceFit(input);
    assert.equal(fitted.menuRelocation, candidate.id);
    const receipt = await t.toolbar.commitRelocation(candidate);
    assert.deepEqual(t.toolbar.platePoints(), candidate.points);
    const geometry = resetEntryGeometry({ ...input.geometry, cameraScale: 1, renderFromRoom: identity });
    assert.ok(resetEntryLateralBreakdown({ geometry, points: t.toolbar.platePoints(), clearance: 0 }).eyes
      .every(eye => eye.separated), 'the committed glass clears the structure in both eyes');
    await receipt.rollback();
    assert.deepEqual(t.toolbar.platePoints(), before);
  } finally { await t.toolbar.dispose(); }
});
