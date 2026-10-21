import assert from 'node:assert/strict';
import test from 'node:test';
import { toolbarFrameRuntime, toolbarFrameHarness, identity } from './fixtures/toolbar-frame-runtime.mjs';
import { createToolbarPanel, hitToolbarPanel, toolbarHeadClearance, TOOLBAR_MIN_HEAD_CLEARANCE_METERS } from './spatial-toolbar-geometry.mjs';
import { GRIP_DEPTH_GAIN, GRIP_TRACKING_GRACE_MS, TRIGGER_TRACKING_GRACE_MS } from './xr-manipulate.mjs';
import { hitToolbarGlass } from './spatial-toolbar-wake.mjs';

const runtime = await toolbarFrameRuntime(new URL('./', import.meta.url));
const tick = () => new Promise(resolve => setImmediate(resolve));
const panel = (t, options = {}) => createToolbarPanel({ ...options, rows: t.toolbar.rows(), head: t.toolbar.head(), constants: t.toolbar.layout(),
  seatAnchor: t.toolbar.seatAnchor(), measureText: runtime.toolbarTextWidth });
const pointer = (point, handedness) => {
  const matrix = [...identity];
  for (let axis = 0; axis < 3; axis++) matrix[8 + axis] = -(point[axis] - [0, 1.6, 0][axis]);
  return { handedness, targetRaySpace: { pose: { emulatedPosition: false,
    transform: { matrix, position: { x: 0, y: 1.6, z: 0 } } } } };
};
const ray = source => ({ origin: Object.values(source.targetRaySpace.pose.transform.position),
  direction: source.targetRaySpace.pose.transform.matrix.slice(8, 11).map(v => -v) });
const dispatch = (t, type, source) => t.session.dispatchEvent(Object.assign(new Event(type, { cancelable: true }),
  { inputSource: source, frame: t.frame }));
async function menu(options = {}) {
  const ownership = [], actions = [], offsets = [];
  const t = toolbarFrameHarness(runtime, { state: { voice: { state: 'idle' } },
    onConsumeSelect: event => ownership.push(event), onAction: action => actions.push(action),
    presentation: { setRoomOffset(_target, offset) { offsets.push([...offset]); } }, ...options });
  await t.toolbar.update();
  return { ...t, ownership, actions, offsets };
}
function press(t, source, earlySelect = false) {
  if (earlySelect) dispatch(t, 'select', source);
  dispatch(t, 'selectstart', source);
}
function release(t, source, earlySelect = false) {
  if (!earlySelect) dispatch(t, 'select', source);
  dispatch(t, 'selectend', source);
}
function gapPoint(t, options) {
  const p = panel(t, options);
  for (const x of [-.98, .98, 0]) for (const y of [0, -.95, .95]) {
    const point = p.backing.point.map((v, i) => v + x * p.backing.halfWidth * p.right[i] + y * p.backing.halfHeight * p.up[i]);
    const r = ray(pointer(point, 'left'));
    if (!hitToolbarPanel(p, r) && hitToolbarGlass(p, r)) return point;
  }
  assert.fail('fixture needs a visible backing point outside all buttons');
}

for (const hand of ['left', 'right']) for (const earlySelect of [false, true]) {
  test(`${hand} ${earlySelect ? 'early select' : 'normal select'} button drag suppresses action, then a fresh click works`, async () => {
    const t = await menu();
    try {
      const before = t.toolbar.seatAnchor();
      const source = pointer(panel(t).buttons.find(b => b.action.kind === 'collapse').point, hand);
      t.session.inputSources = [source];
      press(t, source, earlySelect);
      // No dwell timer: a deliberate movement in the next frame starts dragging.
      source.targetRaySpace.pose.transform.position.x = -.08;
      t.toolbar.syncInput(t.frame);
      assert.ok(t.offsets.some(offset => Math.abs(offset[0] + .08) < 1e-9));
      assert.equal(t.toolbar.isHandOnPanel(hand), true);
      release(t, source, earlySelect); await tick();
      assert.equal(t.toolbar.isCollapsed(), true, 'dragging Menu must not open it');
      assert.ok(Math.abs(t.toolbar.seatAnchor()[0] - before[0] + .08) < 1e-9);
      assert.deepEqual(t.ownership.map(e => e.phase), ['start', 'cancel']);
      assert.deepEqual(t.actions, []);
      source.targetRaySpace = pointer(panel(t).buttons.find(b => b.action.kind === 'collapse').point, hand).targetRaySpace;
      press(t, source, earlySelect); release(t, source, earlySelect); await tick();
      assert.equal(t.toolbar.isCollapsed(), false, 'next click opens the menu once');
    } finally { await t.toolbar.dispose(); }
  });
}

for (const hand of ['left', 'right']) for (const target of ['backing', 'caption', 'disabled']) {
  test(`${hand} ${target} glass accepts a drag and a tap runs no button`, async () => {
    const t = await menu({ state: { voice: { state: 'idle' },
      subject: { title: 'Crambin', pdbId: '1CRN', chains: 1, assembly: '1' },
      ...(target === 'disabled' ? { tour: { navigating: true } } : {}) } });
    try {
      let point;
      if (target === 'backing') point = gapPoint(t);
      else if (target === 'caption') {
        const points = t.toolbar.captionPoints();
        assert.ok(points.length > 0);
        point = [0, 1, 2].map(axis => points.reduce((sum, p) => sum + p[axis], 0) / points.length);
      } else {
        const button = panel(t).buttons.find(b => b.targetable === false);
        assert.ok(button, 'fixture has a disabled row'); point = button.point;
      }
      const source = pointer(point, hand); t.session.inputSources = [source];
      assert.equal(t.toolbar.isRayOnPanel(ray(source)), true);
      const before = t.toolbar.seatAnchor();
      press(t, source); release(t, source); await tick();
      assert.deepEqual(t.actions, []); assert.deepEqual(t.toolbar.seatAnchor(), before);
      press(t, source);
      source.targetRaySpace.pose.transform.position.x = -.08;
      t.toolbar.syncInput(t.frame); release(t, source); await tick();
      assert.ok(Math.abs(t.toolbar.seatAnchor()[0] - before[0] + .08) < 1e-9);
      assert.deepEqual(t.actions, []);
    } finally { await t.toolbar.dispose(); }
  });
}

test('visible-glass hit testing excludes the space between cards and rounded corners', () => {
  const p = { anchor: [0, 0, -2], normal: [0, 0, 1], right: [1, 0, 0], up: [0, 1, 0],
    backing: { point: [0, 0, -2], halfWidth: .5, halfHeight: .5 },
    captionBacking: { point: [2, 0, -2], halfWidth: .5, halfHeight: .5 },
    statusBacking: { point: [0, 2, -2], halfWidth: .5, halfHeight: .5 }, backingCornerMeters: .1 };
  const aim = (x, y) => ({ origin: [x, y, 0], direction: [0, 0, -1] });
  for (const point of [[0, 0], [2, 0], [0, 2]]) assert.equal(hitToolbarGlass(p, aim(...point)), true);
  for (const point of [[1, 0], [0, 1], [.49, .49], [5, 5]]) assert.equal(hitToolbarGlass(p, aim(...point)), false);
  assert.equal(hitToolbarGlass(p, { origin: [0, 0, 0], direction: [0, 0, 1] }), false);
  assert.equal(hitToolbarGlass(p, { origin: [NaN, 0, 0], direction: [0, 0, -1] }), false);
});

for (const hand of ['left', 'right']) test(`${hand} voice remains synchronous on click and never starts from a drag`, async () => {
  const seen = []; let inRelease = false;
  const t = await menu({ onAction: action => seen.push({ kind: action.kind, inRelease }) });
  try {
    const aim = () => pointer(panel(t).buttons.find(b => b.action.kind === 'voice-toggle').point, hand);
    const source = aim(); t.session.inputSources = [source];
    press(t, source); source.targetRaySpace.pose.transform.position.x = -.08;
    t.toolbar.syncInput(t.frame); release(t, source); await tick();
    assert.deepEqual(seen, []);
    source.targetRaySpace = aim().targetRaySpace;
    press(t, source); dispatch(t, 'select', source);
    assert.deepEqual(seen, []);
    inRelease = true; dispatch(t, 'selectend', source); inRelease = false;
    assert.deepEqual(seen, [{ kind: 'voice-toggle', inRelease: true }]);
  } finally { await t.toolbar.dispose(); }
});

for (const interruption of ['selectcancel', 'hide', 'blur', 'removal', 'dispose']) test(`background drag releases ownership on ${interruption}`, async () => {
  const t = await menu(); let disposed = false;
  try {
    const before = t.toolbar.seatAnchor();
    const source = pointer(gapPoint(t), 'left'); t.session.inputSources = [source];
    press(t, source);
    source.targetRaySpace.pose.transform.position.x = -.08; t.toolbar.syncInput(t.frame);
    source.targetRaySpace = {}; t.toolbar.syncInput(t.frame);
    assert.equal(t.toolbar.isHandOnPanel('left'), true, 'missing ray cannot hand the held menu press to the molecule');
    if (interruption === 'selectcancel') dispatch(t, 'selectcancel', source);
    if (interruption === 'hide') t.toolbar.setHidden(true);
    if (interruption === 'blur') t.toolbar.blur();
    if (interruption === 'removal') t.session.dispatchEvent(Object.assign(new Event('inputsourceschange'), { removed: [source] }));
    if (interruption === 'dispose') { await t.toolbar.dispose(); disposed = true; }
    assert.equal(t.toolbar.isHandOnPanel('left'), false);
    assert.deepEqual(t.ownership.map(e => e.phase), ['start', 'cancel']);
    assert.deepEqual(t.offsets.at(-1), [0, 0, 0]);
    t.toolbar.setHidden(false); release(t, source); await tick();
    assert.deepEqual(t.actions, []);
    if (!disposed) assert.deepEqual(t.toolbar.seatAnchor(), before);
  } finally { if (!disposed) await t.toolbar.dispose(); }
});

test('drag promotion cancels another controller’s already-selected button', async () => {
  const t = await menu();
  try {
    const left = pointer(gapPoint(t), 'left');
    const right = pointer(panel(t).buttons.find(b => b.action.kind === 'voice-toggle').point, 'right');
    t.session.inputSources = [left, right];
    press(t, left); press(t, right, true);
    left.targetRaySpace.pose.transform.position.x = -.08; t.toolbar.syncInput(t.frame);
    release(t, right, true); release(t, left); await tick();
    assert.deepEqual(t.actions, []);
    assert.equal(t.ownership.filter(e => e.phase === 'start').length, 2);
    assert.equal(t.ownership.filter(e => e.phase === 'cancel').length, 2);
  } finally { await t.toolbar.dispose(); }
});

test('a drag toward the head cannot turn into a button click when clearance refuses the move', async () => {
  const t = await menu();
  try {
    const source = pointer(panel(t).buttons.find(b => b.action.kind === 'voice-toggle').point, 'left');
    t.session.inputSources = [source]; press(t, source);
    source.targetRaySpace.pose.transform.position.x = .3;
    source.targetRaySpace.pose.transform.position.z = .3;
    t.toolbar.syncInput(t.frame); release(t, source); await tick();
    assert.deepEqual(t.actions, []);
  } finally { await t.toolbar.dispose(); }
});

for (const hand of ['left', 'right']) test(`${hand} release-frame movement consumes Reset without an animation frame`, async () => {
  const t = await menu();
  try {
    const source = pointer(panel(t).buttons.find(b => b.action.kind === 'recenter-structure').point, hand);
    t.session.inputSources = [source]; press(t, source);
    source.targetRaySpace.pose.transform.position.x = -.1;
    release(t, source); await tick();
    assert.deepEqual(t.actions, []);
    assert.ok(t.offsets.some(offset => Math.abs(offset[0] + .1) < 1e-9));
  } finally { await t.toolbar.dispose(); }
});

test('a second controller cannot activate Reset while the first holds the menu', async () => {
  const t = await menu();
  try {
    const left = pointer(panel(t).buttons.find(b => b.action.kind === 'collapse').point, 'left');
    const right = pointer(panel(t).buttons.find(b => b.action.kind === 'recenter-structure').point, 'right');
    t.session.inputSources = [left, right]; press(t, left); press(t, right);
    right.targetRaySpace.pose.transform.position.x = -.1; t.toolbar.syncInput(t.frame);
    release(t, right); dispatch(t, 'selectcancel', left); await tick();
    assert.deepEqual(t.actions, []);
  } finally { await t.toolbar.dispose(); }
});

for (const alreadyMoving of [false, true]) test(`restricted input-event frame ${alreadyMoving ? 'commits held' : 'starts quick'} drag without reading viewer pose`, async () => {
  const t = await menu();
  try {
    const before = t.toolbar.seatAnchor();
    const source = pointer(panel(t).buttons.find(b => b.action.kind === 'recenter-structure').point, 'left');
    t.session.inputSources = [source]; press(t, source);
    source.targetRaySpace.pose.transform.position.x = -.1;
    if (alreadyMoving) t.toolbar.syncInput(t.frame);
    let viewerReads = 0;
    const eventFrame = { getPose: t.frame.getPose, getViewerPose() { viewerReads++; throw new DOMException('Input frame', 'InvalidStateError'); } };
    dispatch(t, 'select', source);
    t.session.dispatchEvent(Object.assign(new Event('selectend', { cancelable: true }), { inputSource: source, frame: eventFrame }));
    await tick();
    assert.equal(viewerReads, 0);
    assert.deepEqual(t.actions, []);
    assert.ok(Math.abs(t.toolbar.seatAnchor()[0] - before[0] + .1) < 1e-9);
  } finally { await t.toolbar.dispose(); }
});

test('a lesson background tap keeps its controls; Menu opens the full controls without firing a scene action', async () => {
  const records = [], previous = globalThis.__stereofoldDiagnostics;
  globalThis.__stereofoldDiagnostics = { record: (kind, detail) => records.push({ kind, detail }) };
  const t = await menu({ state: { voice: { state: 'idle' }, tour: {
    selectedId: 'guided', active: true, step: 1, canBack: true, canNext: true, chapterStartedAt: 0 } } });
  try {
    const latestLabels = () => {
      const rows = records.filter(r => r.kind === 'toolbar' && r.detail.phase === 'rows');
      return rows.filter(r => r.detail.draw === rows.at(-1).detail.draw).flatMap(r => r.detail.labels);
    };
    const lessonLabels = latestLabels();
    assert.ok(!lessonLabels.includes('Back'));
    assert.ok(lessonLabels.includes('Next') && lessonLabels.includes('Menu'));
    const background = gapPoint(t, { stableLesson: true });
    const source = pointer(background, 'left'); t.session.inputSources = [source];
    assert.equal(t.toolbar.isRayOnPanel(ray(source)), true, 'tap the actual lesson backing outside its controls');
    press(t, source); release(t, source); await tick();
    assert.deepEqual(latestLabels(), lessonLabels, 'a background tap retains the lesson controls');
    assert.deepEqual(t.actions, []);
    // Aim at the committed 2x2 row, not a reconstructed legacy column.
    const menuIndex = t.toolbar.rows().findIndex(row => row.id === 'menu');
    const corners = t.toolbar.menuRows()[menuIndex];
    const menuPoint = [0, 1, 2].map(axis => corners.reduce((sum, point) => sum + point[axis], 0) / corners.length);
    source.targetRaySpace = pointer(menuPoint, 'left').targetRaySpace;
    press(t, source); release(t, source); await tick();
    assert.ok(latestLabels().includes('Back'), 'Menu exposes Back on the rendered panel');
    assert.ok(latestLabels().includes('Reset'), 'Menu exposes Reset on the rendered panel');
    assert.deepEqual(t.actions, []);
  } finally { await t.toolbar.dispose(); globalThis.__stereofoldDiagnostics = previous; }
});

for (const hand of ['left', 'right']) test(`${hand} grip holds visible menu, pulls it closer, and never activates its row`, async () => {
  const t = await menu();
  try {
    const before = t.toolbar.seatAnchor();
    const source = pointer(panel(t).buttons.find(b => b.action.kind === 'voice-toggle').point, hand);
    source.gripSpace = { pose: { emulatedPosition: false, transform: { position: { x: 0, y: 1.6, z: 0 } } } };
    t.session.inputSources = [source];
    dispatch(t, 'squeezestart', source);
    assert.equal(t.toolbar.isHandOnPanel(hand), true);
    source.gripSpace.pose.transform.position.z = .1;
    t.toolbar.syncInput(t.frame);
    assert.equal(t.toolbar.isHidden(), false);
    assert.ok(t.offsets.at(-1)[2] > .1, 'pull gets useful depth travel');
    // A same-hand index press must not end the held grip or fire Talk.
    press(t, source); release(t, source);
    assert.equal(t.toolbar.isHandOnPanel(hand), true);
    dispatch(t, 'squeezeend', source); await tick();
    assert.deepEqual(t.actions, []);
    assert.ok(t.toolbar.seatAnchor()[2] > before[2]);
    assert.equal(t.toolbar.isHidden(), false);
  } finally { await t.toolbar.dispose(); }
});

for (const quality of [true, undefined, 'missing']) test(`menu grip cannot translate from ${quality} grip pose`, async () => {
  const t = await menu();
  try {
    const before = t.toolbar.seatAnchor();
    const source = pointer(gapPoint(t), 'right');
    source.gripSpace = { pose: quality === 'missing' ? undefined : { emulatedPosition: quality,
      transform: { position: { x: 0, y: 1.6, z: 0 } } } };
    t.session.inputSources = [source]; dispatch(t, 'squeezestart', source);
    source.targetRaySpace.pose.transform.position.x = -.2;
    if (source.gripSpace.pose) source.gripSpace.pose.transform.position.x = -.2;
    t.toolbar.syncInput(t.frame); dispatch(t, 'squeezeend', source); await tick();
    assert.deepEqual(t.toolbar.seatAnchor(), before);
    assert.deepEqual(t.actions, []);
  } finally { await t.toolbar.dispose(); }
});

test('menu aim point tracks the actual glass in room metres and clears on miss', async () => {
  const t = await menu();
  try {
    const point = panel(t).buttons[0].point;
    const source = pointer(point, 'left'); t.session.inputSources = [source];
    t.toolbar.syncInput(t.frame);
    assert.ok(Math.hypot(...t.toolbar.aimPoint().map((v, i) => v - point[i])) < .03);
    source.targetRaySpace = pointer([0, 1.6, -2], 'left').targetRaySpace;
    t.toolbar.syncInput(t.frame); assert.equal(t.toolbar.aimPoint(), undefined);
  } finally { await t.toolbar.dispose(); }
});

for (const interruption of ['lost', 'emulated', 'jump']) test(`held grip menu rebases ${interruption} pose and continues without a jump`, async () => {
  const t = await menu();
  try {
    const source = pointer(gapPoint(t), 'left');
    const pose = { emulatedPosition: false, transform: { position: { x: 0, y: 1.6, z: 0 } } };
    source.gripSpace = { pose }; t.session.inputSources = [source];
    dispatch(t, 'squeezestart', source);
    pose.transform.position.x = -.08; t.toolbar.syncInput(t.frame);
    const held = [...t.offsets.at(-1)];
    if (interruption === 'lost') source.gripSpace.pose = undefined;
    else if (interruption === 'emulated') pose.emulatedPosition = true;
    else pose.transform.position.x = -1.2;
    t.toolbar.syncInput(t.frame);
    assert.deepEqual(t.offsets.at(-1), held);
    source.gripSpace.pose = pose; pose.emulatedPosition = false;
    // First returning sample establishes a fresh measured baseline.
    t.toolbar.syncInput(t.frame); assert.deepEqual(t.offsets.at(-1), held);
    pose.transform.position.x -= .04; t.toolbar.syncInput(t.frame);
    assert.ok(t.offsets.at(-1)[0] < held[0]);
    dispatch(t, 'squeezeend', source); await tick();
    assert.deepEqual(t.actions, []);
  } finally { await t.toolbar.dispose(); }
});


for (const hand of ['left', 'right']) for (const sign of [-1, 1]) test(`${hand} measured grip ${sign < 0 ? 'pull' : 'push'} changes apparent menu size with useful reach`, async () => {
  const t = await menu();
  try {
    const beforePanel = panel(t), before = t.toolbar.seatAnchor();
    const origin = [0, 1.6, 0];
    const unit = before.map((v, i) => v - origin[i]);
    const distance = Math.hypot(...unit); unit.forEach((v, i) => { unit[i] = v / distance; });
    const source = pointer(beforePanel.buttons.find(b => b.action.kind === 'voice-toggle').point, hand);
    const position = { x: 0, y: 1.6, z: 0 };
    source.gripSpace = { pose: { emulatedPosition: false, transform: { position } } };
    t.session.inputSources = [source]; dispatch(t, 'squeezestart', source);
    for (const [i, axis] of ['x', 'y', 'z'].entries()) position[axis] += unit[i] * sign * .12;
    t.toolbar.syncInput(t.frame); dispatch(t, 'squeezeend', source); await tick();
    const after = t.toolbar.seatAnchor(), afterPanel = panel(t);
    const newDistance = Math.hypot(...after.map((v, i) => v - origin[i]));
    const apparentRatio = (afterPanel.fontMeters / newDistance) / (beforePanel.fontMeters / distance);
    assert.equal(afterPanel.fontMeters, beforePanel.fontMeters, 'distance changes angular size without resizing authored type');
    assert.ok(sign < 0 ? apparentRatio > 1.2 : apparentRatio < .85, `angular type ratio ${apparentRatio}`);
    assert.ok(Math.abs(newDistance - distance) > .25, 'twelve centimetres of hand travel gives useful depth reach');
    assert.equal(t.toolbar.isHidden(), false); assert.deepEqual(t.actions, []);
  } finally { await t.toolbar.dispose(); }
});

const radialGrip = (t, hand = 'right') => {
  const p = panel(t), origin = [0, 1.6, 0];
  const vector = p.anchor.map((v, i) => v - origin[i]);
  const length = Math.hypot(...vector), axis = vector.map(v => v / length);
  const source = pointer(p.buttons.at(-1).point, hand);
  source.targetRayMode = 'tracked-pointer';
  const position = { x: 0, y: 1.6, z: 0 };
  source.gripSpace = { pose: { emulatedPosition: false, transform: { position } } };
  t.session.inputSources = [source];
  const travel = distance => {
    ['x', 'y', 'z'].forEach((key, i) => { position[key] = origin[i] + axis[i] * distance; });
    t.toolbar.syncInput(t.frame);
  };
  return { source, travel, axis, origin, position, before: [...p.anchor] };
};

const roomRuntime = await toolbarFrameRuntime(new URL('./', import.meta.url), { roomScene: true });
async function roomMenu({ runTask, rejectOnce = false } = {}) {
  roomRuntime.reset();
  const entries = new Map(), cards = new Set(), offsets = new Map();
  const camera = { view: [...identity], scale: 1 }, canvas = { camera, webgl: {}, requestDraw() {},
    debugRegistry: { register: (name, entry) => entries.set(name, entry), unregister: name => entries.delete(name) } };
  const layer = roomRuntime.createPresentationScene(canvas);
  const presentation = { ...layer,
    add(target, options) { cards.add(target); return layer.add(target, options); },
    remove(target) { cards.delete(target); offsets.delete(target); return layer.remove(target); },
    setRoomOffset(target, value) {
      roomRuntime.count('roomOffsetWrites');
      if (rejectOnce) { rejectOnce = false; return false; }
      offsets.set(target, [...value]);
      const accepted = layer.setRoomOffset(target, value);
      value.fill(999); // The caller must own its comparison, even if an adapter consumes its argument.
      return accepted;
    } };
  const t = toolbarFrameHarness(roomRuntime, { state: { subject: { title: 'A local structure' } }, presentation, runTask });
  await t.toolbar.update();
  const draw = () => entries.get('stereofold-presentation').syncVisibility();
  const assertTransforms = () => {
    const base = layer.roomMatrix();
    for (const card of cards) {
      const offset = offsets.get(card) ?? [0, 0, 0], expected = [...base];
      for (let axis = 0; axis < 3; axis++) expected[12 + axis] +=
        base[axis] * offset[0] + base[4 + axis] * offset[1] + base[8 + axis] * offset[2];
      for (const object of card.renderObjects) for (let i = 0; i < 16; i++)
        assert.ok(Math.abs(object.values.aTransform.ref.value[i] - expected[i]) < 1e-9, `drawn transform element ${i}`);
    }
  };
  draw();
  return { ...t, layer, cards, offsets, camera, draw, assertTransforms };
}

for (const hand of ['left', 'right']) test(`${hand} stationary held menu avoids room-offset writes and actual room-transform refreshes`, async () => {
  const t = await roomMenu();
  try {
    const g = radialGrip(t, hand); dispatch(t, 'squeezestart', g.source); g.travel(-.06); await tick(); t.draw();
    t.assertTransforms();
    const writes = roomRuntime.counts.roomOffsetWrites, updates = roomRuntime.counts.roomSceneUpdates,
      matrices = roomRuntime.counts.roomMatrixWrites, held = t.toolbar.seatAnchor();
    assert.ok(writes > 0);
    for (let i = 0; i < 72; i++) { t.toolbar.syncInput(t.frame); t.draw(); }
    assert.equal(roomRuntime.counts.roomOffsetWrites, writes, 'unchanged grip produces no offset submissions');
    assert.equal(roomRuntime.counts.roomSceneUpdates, updates, 'presentation applied key stays valid');
    assert.equal(roomRuntime.counts.roomMatrixWrites, matrices, 'effective draw matrices are not rewritten');
    assert.deepEqual(t.toolbar.seatAnchor(), held); t.assertTransforms();
    // Head/camera motion still refreshes the layer from its own draw clock.
    t.camera.view[12] = .1; t.camera.scale = .5; t.draw(); t.assertTransforms();
    assert.ok(roomRuntime.counts.roomMatrixWrites > matrices);
    assert.equal(roomRuntime.counts.roomOffsetWrites, writes);
    // A representation rebuild/update must invalidate placement independently.
    const beforeDim = roomRuntime.counts.roomMatrixWrites;
    await t.toolbar.setDimmed(true); t.draw(); t.assertTransforms();
    const afterRebuild = roomRuntime.counts.roomMatrixWrites;
    assert.ok(afterRebuild > beforeDim, 'same-card geometry update receives a fresh room transform');
    t.toolbar.syncInput(t.frame); t.draw();
    assert.equal(roomRuntime.counts.roomOffsetWrites, writes);
    assert.equal(roomRuntime.counts.roomMatrixWrites, afterRebuild);
    g.travel(-.07); t.draw(); t.assertTransforms();
    assert.ok(roomRuntime.counts.roomOffsetWrites > writes, 'real movement still reaches all live cards');
    dispatch(t, 'selectcancel', g.source); t.draw(); t.assertTransforms();
    assert.ok([...t.offsets.values()].every(offset => offset.every(v => v === 0)), 'cancel restores every drawn card');
  } finally { await t.toolbar.dispose(); t.layer.dispose(); }
});

test('offset suppression retries a refused write and initializes freshly redrawn cards after a gated release', async () => {
  let gate, unlock;
  const t = await roomMenu({ rejectOnce: true, runTask: async task => { if (gate) await gate; return task.run(); } });
  try {
    const g = radialGrip(t); dispatch(t, 'squeezestart', g.source); g.travel(-.06); t.draw();
    const firstWrites = roomRuntime.counts.roomOffsetWrites;
    t.toolbar.syncInput(t.frame); t.draw(); t.assertTransforms();
    assert.equal(roomRuntime.counts.roomOffsetWrites, firstWrites + 1, 'only rejected card needs the unchanged offset again');
    assert.equal(t.offsets.size, t.cards.size);
    const oldCards = [...t.cards], held = t.toolbar.seatAnchor();
    gate = new Promise(resolve => { unlock = resolve; });
    dispatch(t, 'squeezeend', g.source); await tick(); t.draw(); t.assertTransforms();
    const pendingWrites = roomRuntime.counts.roomOffsetWrites, pendingMatrices = roomRuntime.counts.roomMatrixWrites;
    for (let i = 0; i < 72; i++) { t.toolbar.syncInput(t.frame); t.draw(); }
    assert.equal(roomRuntime.counts.roomOffsetWrites, pendingWrites, 'deferred release also leaves unchanged offsets alone');
    assert.equal(roomRuntime.counts.roomMatrixWrites, pendingMatrices);
    assert.deepEqual(t.toolbar.seatAnchor(), held, 'deferred commit keeps the translated old glass');
    unlock(); gate = undefined; await tick(); t.draw(); t.assertTransforms();
    assert.ok([...t.cards].every(card => !oldCards.includes(card)), 'release installs fresh geometry at the committed seat');
    const fresh = radialGrip(t); dispatch(t, 'squeezestart', fresh.source); fresh.travel(-.06); t.draw(); t.assertTransforms();
    assert.equal(t.offsets.size, t.cards.size, 'each new card receives an offset despite matching earlier travel');
  } finally { unlock?.(); await t.toolbar.dispose(); t.layer.dispose(); }
});

for (const hand of ['left', 'right']) test(`${hand} grip depth follows the fixed menu radial axis, independent of aimed row`, async () => {
  const t = await menu();
  try {
    const g = radialGrip(t, hand);
    dispatch(t, 'squeezestart', g.source);
    // Wrist aim changes do not change push/pull policy after capture.
    g.source.targetRaySpace.pose.transform.matrix[8] = 1;
    g.source.targetRaySpace.pose.transform.matrix[10] = 0;
    g.travel(-.08);
    const offset = t.offsets.at(-1);
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(offset[i] + g.axis[i] * .08 * GRIP_DEPTH_GAIN) < 1e-9);
    const held = [...offset];
    g.source.gripSpace.pose.emulatedPosition = true;
    g.travel(-.15); assert.deepEqual(t.offsets.at(-1), held);
    g.source.gripSpace.pose.emulatedPosition = false;
    g.travel(-.15); assert.deepEqual(t.offsets.at(-1), held);
    g.travel(-.17);
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(t.offsets.at(-1)[i] - held[i] + g.axis[i] * .02 * GRIP_DEPTH_GAIN) < 1e-9);
  } finally { await t.toolbar.dispose(); }
});

for (const hand of ['left', 'right']) test(`${hand} menu clamps at eye clearance and the first reversed hand sample moves it outward`, async () => {
  const t = await menu();
  try {
    const g = radialGrip(t, hand), p = panel(t);
    dispatch(t, 'squeezestart', g.source);
    g.travel(-.3);
    const contact = [...t.offsets.at(-1)];
    const clearance = toolbarHeadClearance(p, t.frame.getViewerPose(), contact);
    assert.ok(clearance >= TOOLBAR_MIN_HEAD_CLEARANCE_METERS);
    assert.ok(clearance < TOOLBAR_MIN_HEAD_CLEARANCE_METERS + 1e-5);
    g.travel(-.28);
    const outward = [...t.offsets.at(-1)];
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(outward[i] - contact[i] - g.axis[i] * .02 * GRIP_DEPTH_GAIN) < 1e-8);
    dispatch(t, 'squeezeend', g.source); await tick();
    const committed = t.toolbar.seatAnchor().map((v, i) => v - g.before[i]);
    assert.ok(Math.hypot(...committed.map((v, i) => v - outward[i])) < .08, 'release stays at the held seat rather than snapping home');
    assert.ok(toolbarHeadClearance(panel(t), t.frame.getViewerPose()) >= TOOLBAR_MIN_HEAD_CLEARANCE_METERS);
  } finally { await t.toolbar.dispose(); }
});

test('both-eye clipping follows drawn translation through an asynchronous release rebuild', async () => {
  let gate, unlock;
  const t = await menu({ runTask: async task => { if (gate) await gate; return task.run(); } });
  try {
    const originalPose = t.frame.getViewerPose;
    t.frame.getViewerPose = () => ({ ...originalPose(), views: [-.032, .032].map(x => {
      const matrix = [...identity]; matrix[12] = -x; matrix[13] = -1.6;
      return { transform: { inverse: { matrix } } };
    }) });
    const g = radialGrip(t);
    const before = t.toolbar.depthRange(t.frame);
    const cachedDepth = () => {
      const outlines = runtime.counts.toolbarPlateOutline, backings = runtime.counts.toolbarBackingOutline;
      const range = t.toolbar.depthRange(t.frame);
      assert.equal(runtime.counts.toolbarPlateOutline, outlines, 'drag depth projects cached button edges');
      assert.equal(runtime.counts.toolbarBackingOutline, backings, 'drag depth projects cached backing edges');
      return range;
    };
    const advertised = ['platePoints', 'captionPoints', 'drawnMenuPoints', 'menuPoints'];
    const originalPoints = Object.fromEntries(advertised.map(key => [key, t.toolbar[key]()]));
    const originalRows = t.toolbar.menuRows();
    dispatch(t, 'squeezestart', g.source); g.travel(-.08);
    const offset = [...t.offsets.at(-1)];
    const held = cachedDepth();
    const shifted = points => points.map(point => point.map((v, i) => v + offset[i]));
    const samePoints = (actual, expected, label) => {
      assert.equal(actual.length, expected.length, label);
      for (let p = 0; p < actual.length; p++) for (let i = 0; i < 3; i++)
        assert.ok(Math.abs(actual[p][i] - expected[p][i]) < 1e-9, label);
    };
    const checkAdvertisedGeometry = () => {
      for (const key of advertised) samePoints(t.toolbar[key](), shifted(originalPoints[key]), `${key} describes currently drawn glass`);
      t.toolbar.menuRows().forEach((row, i) => samePoints(row, shifted(originalRows[i]), 'row obstacle follows drawn translation'));
      samePoints([t.toolbar.seatAnchor()], [g.before.map((v, i) => v + offset[i])], 'drawn seat retains translation');
    };
    checkAdvertisedGeometry();
    assert.ok(Math.abs(held.near - (before.near - offset[2])) < 1e-9);
    assert.ok(Math.abs(held.far - (before.far - offset[2])) < 1e-9);
    gate = new Promise(resolve => { unlock = resolve; });
    dispatch(t, 'squeezeend', g.source); await tick();
    await t.toolbar.setStatus('Sending', undefined, 'sending');
    checkAdvertisedGeometry();
    assert.deepEqual(cachedDepth(), held, 'release retains clipping for the currently visible offset while glyphs build');
    unlock(); gate = undefined; await tick();
    assert.ok(t.toolbar.depthRange(t.frame).near < before.near);
    assert.ok(Math.hypot(...t.toolbar.seatAnchor().map((v, i) => v - g.before[i])) > .15);
  } finally { unlock?.(); await t.toolbar.dispose(); }
});

test('menu grip recovers a missing squeezeend from the actual analog release without any new pose', async () => {
  const t = await menu();
  try {
    const g = radialGrip(t);
    g.source.gamepad = { buttons: [{ value: 0 }, { value: .9 }] };
    dispatch(t, 'squeezestart', g.source); g.travel(-.08);
    const held = [...t.offsets.at(-1)];
    g.source.gripSpace.pose = undefined;
    g.source.gamepad.buttons[1].value = 0;
    t.toolbar.syncInput(t.frame); await tick();
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(t.toolbar.seatAnchor()[i] - g.before[i] - held[i]) < 1e-9);
    assert.equal(t.ownership.filter(e => e.phase === 'cancel').length, 1);
    const builds = runtime.counts.ShapeRepresentation;
    await t.toolbar.setStatus('Recovered');
    assert.equal(runtime.counts.ShapeRepresentation, builds);
  } finally { await t.toolbar.dispose(); }
});

test('prolonged missing grip unlocks the held menu and requires physical release before a new grab', async () => {
  let clock = 0;
  const t = await menu({ now: () => clock });
  try {
    const g = radialGrip(t);
    g.source.gamepad = { buttons: [{ value: 0 }, { value: .9 }] };
    dispatch(t, 'squeezestart', g.source); g.travel(-.08);
    g.source.gripSpace.pose = undefined;
    clock = 10; t.toolbar.syncInput(t.frame);
    clock += GRIP_TRACKING_GRACE_MS + 1; t.toolbar.syncInput(t.frame); await tick();
    assert.equal(t.ownership.filter(e => e.phase === 'cancel').length, 1);
    g.source.targetRaySpace = pointer(panel(t).buttons[0].point, 'right').targetRaySpace;
    g.source.gripSpace.pose = { emulatedPosition: false, transform: { position: g.position } };
    dispatch(t, 'squeezestart', g.source);
    assert.equal(t.ownership.filter(e => e.phase === 'start').length, 1, 'continued physical hold cannot silently re-arm');
    g.source.gamepad.buttons[1].value = 0; t.toolbar.syncInput(t.frame);
    g.source.gamepad.buttons[1].value = .9; dispatch(t, 'squeezestart', g.source);
    assert.equal(t.ownership.filter(e => e.phase === 'start').length, 2);
  } finally { await t.toolbar.dispose(); }
});

test('status-only message, color, progress and retirement update the talk card without rebuilding menu glass', async () => {
  let adds = 0, removes = 0;
  const outcomes = [], progressStates = [];
  runtime.setTalkOutcomeSink(text => outcomes.push(text));
  runtime.setTalkProgressSink(state => progressStates.push(state));
  const t = await menu({ state: { voice: { state: 'ready' } }, presentation: { add() { adds++; }, remove() { removes++; } } });
  try {
    const builds = runtime.counts.ShapeRepresentation, startAdds = adds, startRemoves = removes;
    for (const [text, color, progress] of [['Listening', 0xff0000, 'listening'], ['Sending', 0x00ff00, 'sending'], ['Applied', 0xffffff], ['Applied', 0x0000ff], ['']]) {
      await t.toolbar.setStatus(text, color, progress);
      assert.equal(t.toolbar.statusText(), text);
    }
    assert.equal(runtime.counts.ShapeRepresentation, builds);
    assert.equal(adds, startAdds); assert.equal(removes, startRemoves);
    assert.deepEqual(outcomes, ['Applied', 'Applied', '']);
    assert.deepEqual(progressStates.map(state => state.progress), ['Listening', 'Sending']);
  } finally { runtime.setTalkOutcomeSink(); runtime.setTalkProgressSink(); await t.toolbar.dispose(); }
});

test('a late actual squeezeend clears a tracking-timeout guard even without gamepad data', async () => {
  let clock = 0;
  const t = await menu({ now: () => clock });
  try {
    const g = radialGrip(t);
    dispatch(t, 'squeezestart', g.source); g.travel(-.08);
    const pose = g.source.gripSpace.pose;
    g.source.gripSpace.pose = undefined;
    t.toolbar.syncInput(t.frame);
    clock = TRIGGER_TRACKING_GRACE_MS + 1; t.toolbar.syncInput(t.frame); await tick();
    g.source.gripSpace.pose = pose;
    g.source.targetRaySpace = pointer(panel(t).buttons[0].point, 'right').targetRaySpace;
    dispatch(t, 'squeezeend', g.source);
    dispatch(t, 'squeezestart', g.source);
    assert.equal(t.ownership.filter(e => e.phase === 'start').length, 2);
  } finally { await t.toolbar.dispose(); }
});

for (const hand of ['left', 'right']) test(`${hand} live analog bottom grip recovers a 600 ms occlusion while retaining the held menu`, async () => {
  let clock = 0;
  const t = await menu({ now: () => clock });
  try {
    const g = radialGrip(t, hand);
    g.source.gamepad = { buttons: [{ value: 0 }, { value: .9 }] };
    dispatch(t, 'squeezestart', g.source); g.travel(-.08);
    const held = [...t.offsets.at(-1)], pose = g.source.gripSpace.pose;
    g.source.gripSpace.pose = undefined;
    clock = 10; t.toolbar.syncInput(t.frame);
    clock = 610; t.toolbar.syncInput(t.frame);
    assert.deepEqual(t.offsets.at(-1), held);
    assert.equal(t.ownership.filter(e => e.phase === 'cancel').length, 0);
    g.source.gripSpace.pose = pose;
    g.travel(-.2); assert.deepEqual(t.offsets.at(-1), held, 'recovered measured pose only rebases');
    g.travel(-.22);
    assert.ok(Math.abs(Math.hypot(...t.offsets.at(-1).map((v, i) => v - held[i])) - .05) < 1e-8);
    g.source.gamepad.buttons[1].value = 0; t.toolbar.syncInput(t.frame); await tick();
    assert.equal(t.ownership.filter(e => e.phase === 'cancel').length, 1);
  } finally { await t.toolbar.dispose(); }
});

test('a missing input source retains the shorter cancellation bound despite its prior analog grip', async () => {
  let clock = 0;
  const t = await menu({ now: () => clock });
  try {
    const g = radialGrip(t);
    g.source.gamepad = { buttons: [{ value: 0 }, { value: .9 }] };
    dispatch(t, 'squeezestart', g.source); g.travel(-.08);
    const held = [...t.offsets.at(-1)];
    t.session.inputSources = [];
    g.position.z += .1;
    clock = 10; t.toolbar.syncInput(t.frame);
    assert.deepEqual(t.offsets.at(-1), held, 'removed source space cannot supply new travel');
    clock += TRIGGER_TRACKING_GRACE_MS + 1; t.toolbar.syncInput(t.frame); await tick();
    assert.equal(t.ownership.filter(e => e.phase === 'cancel').length, 1);
  } finally { await t.toolbar.dispose(); }
});

for (const hand of ['left', 'right']) test(`${hand} released menu owns its seat through clearance, tour updates and Menu expansion`, async () => {
  let automaticRelocation = false, clearanceCalls = 0;
  const t = await menu({ beforeMenuDraw: async ({ relocationCandidates }) => {
    clearanceCalls++;
    if (automaticRelocation) return { menuRelocation: relocationCandidates({})[0] };
  } });
  try {
    const g = radialGrip(t, hand);
    dispatch(t, 'squeezestart', g.source);
    g.position.x -= .12; t.toolbar.syncInput(t.frame);
    const held = [...t.toolbar.seatAnchor()];
    automaticRelocation = true;
    const callsBeforeRelease = clearanceCalls;
    dispatch(t, 'squeezeend', g.source); await tick();
    assert.deepEqual(t.toolbar.seatAnchor(), held, 'release must not rerun automatic relocation over the wearer seat');
    assert.deepEqual(t.toolbar.prepareRelocation({ headInRoom: identity }), [],
      'appearance workers cannot propose automatic relocation of a wearer-owned menu');
    for (let step = 0; step < 3; step++) {
      t.setState({ voice: { state: 'idle' }, tour: { selectedId: 'test', active: true, step,
        title: `Chapter ${step}`, canNext: true, canBack: step > 0 } });
      await t.toolbar.update(); await t.frames(6);
      assert.deepEqual(t.toolbar.seatAnchor(), held, 'chapter and frame updates retain wearer placement');
    }
    await t.toolbar.update({ restoreTourSeat: true, restartTourSeat: true });
    assert.deepEqual(t.toolbar.seatAnchor(), held, 'restarting a tour retains the wearer menu seat');
    t.toolbar.runAction({ kind: 'collapse', value: false }); await tick();
    assert.deepEqual(t.toolbar.seatAnchor(), held, 'opening Menu is not a recenter request');
    assert.equal(clearanceCalls, callsBeforeRelease, 'automatic clearance cannot take back a manually placed menu');
  } finally { await t.toolbar.dispose(); }
});

for (const hand of ['left', 'right']) test(`${hand} grip moves sideways as readily as depth without cross-axis drift`, async () => {
  const t = await menu();
  try {
    const g = radialGrip(t, hand);
    dispatch(t, 'squeezestart', g.source);
    g.position.x -= .08; t.toolbar.syncInput(t.frame);
    const offset = t.offsets.at(-1);
    assert.ok(Math.abs(offset[0] + .08 * GRIP_DEPTH_GAIN) < 1e-9);
    assert.ok(Math.abs(offset[1]) < 1e-9 && Math.abs(offset[2]) < 1e-9,
      'horizontal travel stays horizontal even for a peripheral menu');
    const held = [...t.toolbar.seatAnchor()];
    dispatch(t, 'squeezeend', g.source); await tick();
    assert.deepEqual(t.toolbar.seatAnchor(), held);
  } finally { await t.toolbar.dispose(); }
});

for (const hand of ['left', 'right']) for (const end of ['release', 'cancel', 'hide'])
  test(`${hand} trigger drag shows a translated held rim and clears it on ${end}`, async () => {
    const drawn = new Set(), roomOffsets = new Map(), additions = [];
    const t = await menu({ presentation: {
      add(target, options) { drawn.add(target); additions.push({ target, options }); },
      remove(target) { drawn.delete(target); roomOffsets.delete(target); },
      setRoomOffset(target, offset) { roomOffsets.set(target, [...offset]); },
    } });
    try {
      const source = pointer(panel(t).buttons[0].point, hand);
      t.session.inputSources = [source]; press(t, source);
      source.targetRaySpace.pose.transform.position.x -= .08;
      t.toolbar.syncInput(t.frame); await tick();
      const held = [...drawn].find(target => target.shape?.name === 'Stereofold held menu rim');
      assert.ok(held, 'visible held-state geometry is added for the whole dragged menu');
      assert.ok(held.shape.geometry.triangles.length > 0);
      assert.equal(additions.find(entry => entry.target === held).options.roomLocked, true);
      assert.deepEqual(roomOffsets.get(held), [-.08, 0, 0], 'rim shares the glass room transform');
      const builds = additions.length;
      for (let frame = 0; frame < 12; frame++) t.toolbar.syncInput(t.frame);
      await tick();
      assert.equal(additions.length, builds, 'held feedback does not rebuild per frame');
      if (end === 'release') release(t, source);
      else if (end === 'cancel') dispatch(t, 'selectcancel', source);
      else t.toolbar.setHidden(true);
      await tick();
      assert.equal(drawn.has(held), false, 'no held glow remains after the gesture ends');
    } finally { await t.toolbar.dispose(); }
  });

for (const hand of ['left', 'right']) test(`${hand} refused structure Reset retains a dragged menu`, async () => {
  const t = await menu({ onAction: async action => {
    if (action.kind === 'reset') throw Error('Let go first');
  } });
  try {
    const g = radialGrip(t, hand);
    dispatch(t, 'squeezestart', g.source); g.position.x -= .1; t.toolbar.syncInput(t.frame);
    dispatch(t, 'squeezeend', g.source); await tick();
    const held = [...t.toolbar.seatAnchor()];
    t.moveHead(.3);
    await t.toolbar.runAction({ kind: 'reset' }); await tick();
    assert.deepEqual(t.toolbar.seatAnchor(), held, 'failure does not reset the menu by itself');
    t.toolbar.runAction({ kind: 'collapse', value: false }); await tick();
    assert.deepEqual(t.toolbar.seatAnchor(), held, 'failure preserves wearer ownership for later controls');
  } finally { await t.toolbar.dispose(); }
});

const closePoints = (actual, expected, message) => {
  assert.equal(actual.length, expected.length, message);
  actual.forEach((point, i) => point.forEach((value, axis) =>
    assert.ok(Math.abs(value - expected[i][axis]) < 1e-8, `${message}: point ${i}, axis ${axis}`)));
};
for (const hand of ['left', 'right']) test(`${hand} whole lesson glass retains its translated geometry after release and head movement`, async () => {
  const state = { voice: { state: 'idle' }, tour: { selectedId: 'test', active: true, step: 0,
    title: 'Contact', body: 'Read this chapter.', canNext: true } };
  const t = await menu({ state });
  try {
    const row = t.toolbar.menuRows()[0], point = row.reduce((sum, p) => sum.map((v, i) => v + p[i] / row.length), [0, 0, 0]);
    const source = pointer(point, hand); t.session.inputSources = [source];
    press(t, source);
    // Cross the original side to catch anchor rejection in compact lesson layout.
    for (let step = 1; step <= 8; step++) {
      source.targetRaySpace.pose.transform.position.x = -step * .25;
      t.toolbar.syncInput(t.frame);
    }
    const held = t.toolbar.platePoints();
    release(t, source); await tick();
    closePoints(t.toolbar.platePoints(), held, 'release retains controls AND chapter card');
    t.moveHead(.6); await t.frames(18); await t.toolbar.update();
    closePoints(t.toolbar.platePoints(), held, 'head/status redraw cannot move full glass');
    const anchor = [...t.toolbar.seatAnchor()];
    const normal = points => {
      const a = points[1].map((v, i) => v - points[0][i]);
      const b = points[2].map((v, i) => v - points[0][i]);
      const v = [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
      const length = Math.hypot(...v); return v.map(x => x / length);
    };
    const plane = normal(t.toolbar.menuRows()[0]);
    for (const collapsed of [false, true, false, true]) {
      await t.toolbar.runAction({ kind: 'collapse', value: collapsed }); await tick();
      closePoints([t.toolbar.seatAnchor()], [anchor], 'form changes preserve anchor');
      closePoints([normal(t.toolbar.menuRows()[0])], [plane], 'form changes preserve room plane');
    }
    for (const nextState of [
      { ...state, tour: { ...state.tour, step: 1, title: 'New chapter', body: 'A longer new chapter description.' } },
      { ...state, sequence: { open: true, rows: [] } },
      { voice: { state: 'idle' }, subject: { title: 'Local structure with no lesson' } },
    ]) {
      t.setState(nextState); await t.toolbar.update(); await t.frames(12);
      closePoints([t.toolbar.seatAnchor()], [anchor], 'chapter/empty table/source content preserves anchor');
      closePoints([normal(t.toolbar.menuRows()[0])], [plane], 'chapter/empty table/source content preserves plane');
    }
    await t.toolbar.runAction({ kind: 'recenter-menu', reason: 'placement' }); await tick();
    closePoints([t.toolbar.seatAnchor()], [anchor], 'molecular placement cannot implicitly re-seat a dragged menu');
    // An explicit menu reset is still a deliberate release of ownership.
    await t.toolbar.runAction({ kind: 'recenter-menu' }); await tick();
    assert.notDeepEqual(t.toolbar.seatAnchor(), anchor);
  } finally { await t.toolbar.dispose(); }
});

for (const priorMoves of [0, 7]) test(`untouched lesson menu stays placed through molecular grab, scale and tour updates (${priorMoves ? 'XR reentry' : 'fresh entry'})`, async () => {
  const state = { placementMoves: priorMoves, voice: { state: 'idle' }, tour: { selectedId: 'test', active: true,
    step: 0, title: 'Contact', body: 'Read this chapter.', canNext: true } };
  let geometryVersion = 0, clearanceCalls = 0, mayRelocate = true;
  const t = await menu({ state, getEntryGeometry: () => ({ clearanceKey: String(geometryVersion) }),
    beforeMenuDraw: options => {
      clearanceCalls++;
      // Begin at an automatically selected bottom caption seat, not merely
      // the default panel. The next molecular pose would select another seat.
      const seats = options.chapterCardCandidates({});
      const candidate = seats.find(seat => seat.band === (mayRelocate ? 'bottom' : 'top'));
      return candidate ? { chapterCardSeat: candidate } : undefined;
    } });
  try {
    await tick(); await t.toolbar.update();
    const before = t.toolbar.glassPlates().map(plate => plate.map(point => [...point]));
    const anchor = [...t.toolbar.seatAnchor()];
    const calls = clearanceCalls;
    const candidate = t.toolbar.prepareRelocation({ headInRoom: identity }).at(-1);
    assert.ok(candidate, 'automatic placement could propose a menu seat before the grab');
    t.setState({ ...state, placementMoves: priorMoves + 1 });
    assert.deepEqual(t.toolbar.prepareRelocation({ headInRoom: identity }), [], 'grab ownership reaches placement proposals before a toolbar redraw');
    await assert.rejects(t.toolbar.commitRelocation(candidate), { code: 'FIT_STALE' });
    mayRelocate = false;
    for (const phase of ['grab-start', 'translate', 'rotate', 'scale', 'release', 'status']) {
      geometryVersion++;
      // The real viewer increments moves on onGrabStart, before any delta,
      // and again after a committed release. Reentry may already have moves.
      t.setState({ ...state, placementMoves: priorMoves + (phase === 'release' || phase === 'status' ? 2 : 1) });
      t.moveHead(.18); await t.frames(3); await t.toolbar.update();
      closePoints(t.toolbar.glassPlates().flat(), before.flat(), `${phase} preserves every plate of the untouched menu`);
      closePoints([t.toolbar.seatAnchor()], [anchor], `${phase} preserves the anchor`);
    }
    assert.equal(clearanceCalls, calls, 'molecular geometry changes cannot propose another menu seat');
    t.setState({ ...state, placementMoves: priorMoves + 2, tour: { ...state.tour, step: 1, title: 'Next chapter' } });
    await t.toolbar.update();
    closePoints([t.toolbar.seatAnchor()], [anchor], 'next chapter retains the chosen molecular/menu relation');
    assert.equal(clearanceCalls, calls);
    await t.toolbar.runAction({ kind: 'recenter-menu', reason: 'placement' });
    closePoints([t.toolbar.seatAnchor()], [anchor], 'agent placement cannot silently summon the menu');
    await t.toolbar.runAction({ kind: 'recenter-menu', reason: 'menu' });
    assert.ok(clearanceCalls > calls, 'explicit menu summon still permits a fresh seat');
  } finally { await t.toolbar.dispose(); }
});

test('a molecular grab invalidates an already pending menu-clearance decision', async () => {
  const state = { placementMoves: 0, voice: { state: 'idle' }, tour: { selectedId: 'test', active: true,
    step: 0, title: 'Contact', body: 'Read this chapter.', canNext: true } };
  let waitForClearance = false, complete, began;
  const started = new Promise(resolve => { began = resolve; });
  const t = await menu({ state, beforeMenuDraw: async options => {
    if (!waitForClearance) return;
    const candidate = options.chapterCardCandidates({}).find(seat => seat.band === 'bottom');
    began();
    await new Promise(resolve => { complete = resolve; });
    return { chapterCardSeat: candidate };
  } });
  try {
    await tick(); await t.toolbar.update();
    const before = t.toolbar.glassPlates().flat().map(point => [...point]);
    waitForClearance = true;
    const pending = t.toolbar.update({ recheckClearance: true });
    await started;
    t.setState({ ...state, placementMoves: 1 });
    complete(); await pending;
    closePoints(t.toolbar.glassPlates().flat(), before, 'clearance begun before the grab cannot move the menu afterwards');
  } finally { await t.toolbar.dispose(); }
});


// Full measured grip poses: a natural lateral sweep couples hand travel with
// wrist yaw/pitch/roll. A position-only test cannot detect an inert wrist grab.
function gripPoseRotation(yaw,pitch=0,roll=0) {
  const cy=Math.cos(yaw),sy=Math.sin(yaw),cx=Math.cos(pitch),sx=Math.sin(pitch),cz=Math.cos(roll),sz=Math.sin(roll);
  const rotate=([x,y,z])=>{const a=[x,cx*y-sx*z,sx*y+cx*z],b=[cy*a[0]+sy*a[2],a[1],-sy*a[0]+cy*a[2]];
    return [cz*b[0]-sz*b[1],sz*b[0]+cz*b[1],b[2]];};
  return [[1,0,0],[0,1,0],[0,0,1]].flatMap(rotate);
}
function setGripRotation(g,rotation) {
  const matrix=[...identity];for(let c=0;c<3;c++)for(let r=0;r<3;r++)matrix[c*4+r]=rotation[c*3+r];
  matrix[12]=g.position.x;matrix[13]=g.position.y;matrix[14]=g.position.z;
  g.source.gripSpace.pose.transform.matrix=matrix;
}
for(const hand of ['left','right']) test(`${hand} bottom grip follows full wrist and hand sweeps with held feedback and a persistent fixed plane`,async()=>{
  const drawn=new Set(),offsets=new Map();const t=await menu({presentation:{
    add(target){drawn.add(target);},remove(target){drawn.delete(target);offsets.delete(target);},
    setRoomOffset(target,value){offsets.set(target,[...value]);},
  }});
  try{
    const g=radialGrip(t,hand),p=panel(t);setGripRotation(g,gripPoseRotation(0));
    dispatch(t,'squeezestart',g.source);await tick();
    const rim=[...drawn].find(target=>target.shape?.name==='Stereofold held menu rim');assert.ok(rim,'bottom grip highlights the held glass');
    const lever=p.anchor.map((v,i)=>v-g.origin[i]);
    for(const phase of [.25,.5,1,.5,0,-.5,-1,-.5,0]){
      const rotation=gripPoseRotation(phase*.16,phase*.025,phase*.035);
      g.position.x=-phase*.06;g.position.y=g.origin[1]+phase*.01;g.position.z=phase*.015;
      setGripRotation(g,rotation);t.toolbar.syncInput(t.frame);await tick();
      const rotated=lever.map((_,r)=>rotation[r]*lever[0]+rotation[3+r]*lever[1]+rotation[6+r]*lever[2]);
      const expected=rotated.map((v,i)=>v-lever[i]+([g.position.x,g.position.y,g.position.z][i]-g.origin[i])*GRIP_DEPTH_GAIN);
      assert.ok(toolbarHeadClearance(p,t.frame.getViewerPose(),expected)>TOOLBAR_MIN_HEAD_CLEARANCE_METERS,'fixture sweep has full clearance');
      const actual=offsets.get(rim);assert.ok(actual,'held rim moves with glass');
      actual.forEach((v,i)=>assert.ok(Math.abs(v-expected[i])<1e-8,`full-pose axis ${i}: ${v} vs ${expected[i]}`));
    }
    // A wrist-only sideways turn must remain responsive when the hand's
    // measured position has hardly moved at all.
    setGripRotation(g,gripPoseRotation(.12));t.toolbar.syncInput(t.frame);await tick();
    assert.ok(Math.abs(offsets.get(rim)[0])>.1,'wrist yaw carries the remote menu sideways');
    const held=t.toolbar.glassPlates().flat().map(point=>[...point]),anchor=[...t.toolbar.seatAnchor()];
    dispatch(t,'squeezeend',g.source);await tick();assert.equal(drawn.has(rim),false);
    closePoints(t.toolbar.glassPlates().flat(),held,'release keeps all grip-held glass in its fixed room plane');
    t.moveHead(.25);await t.toolbar.update();await t.frames(8);
    closePoints([t.toolbar.seatAnchor()],[anchor],'head/status updates keep the released grip seat');
    assert.deepEqual(t.actions,[],'gripping never activates a menu row');
  }finally{await t.toolbar.dispose();}
});

for(const hand of ['left','right']) test(`${hand} bottom grip captures a turned wrist at hand height and rebases full pose after tracking loss`,async()=>{
  const t=await menu();
  try{
    const g=radialGrip(t,hand);g.position.x=hand==='left'?-.24:.24;g.position.y=1.25;g.position.z=-.42;
    setGripRotation(g,gripPoseRotation(.4));
    const origin=[g.position.x,g.position.y,g.position.z],lever=g.before.map((v,i)=>v-origin[i]);
    dispatch(t,'squeezestart',g.source);setGripRotation(g,gripPoseRotation(.5));t.toolbar.syncInput(t.frame);
    const rotated=[Math.cos(.1)*lever[0]+Math.sin(.1)*lever[2],lever[1],-Math.sin(.1)*lever[0]+Math.cos(.1)*lever[2]];
    const expected=rotated.map((v,i)=>v-lever[i]);
    expected.forEach((v,i)=>assert.ok(Math.abs(t.offsets.at(-1)[i]-v)<1e-8,'capture is relative to the wrist at grip start'));
    const held=[...t.offsets.at(-1)],pose=g.source.gripSpace.pose;
    g.source.gripSpace.pose=undefined;t.toolbar.syncInput(t.frame);
    g.source.gripSpace.pose=pose;g.position.x+=.2;setGripRotation(g,gripPoseRotation(.8));t.toolbar.syncInput(t.frame);
    assert.deepEqual(t.offsets.at(-1),held,'returning position AND orientation establish a new baseline');
    setGripRotation(g,gripPoseRotation(.82));t.toolbar.syncInput(t.frame);
    assert.ok(Math.hypot(...t.offsets.at(-1).map((v,i)=>v-held[i]))>.01,'the next wrist sample immediately resumes movement');
    dispatch(t,'squeezeend',g.source);await tick();assert.deepEqual(t.actions,[]);
  }finally{await t.toolbar.dispose();}
});

for(const hand of ['left','right']) test(`${hand} bottom grip wrist motion remains responsive after reaching eye clearance`,async()=>{
  const t=await menu();
  try{
    const g=radialGrip(t,hand),p=panel(t);setGripRotation(g,gripPoseRotation(0));dispatch(t,'squeezestart',g.source);
    g.travel(-.3);const contact=[...t.offsets.at(-1)];
    assert.ok(toolbarHeadClearance(p,t.frame.getViewerPose(),contact)<TOOLBAR_MIN_HEAD_CLEARANCE_METERS+1e-5);
    g.travel(-.28);const reversed=[...t.offsets.at(-1)];
    reversed.forEach((v,i)=>assert.ok(Math.abs(v-contact[i]-g.axis[i]*.02*GRIP_DEPTH_GAIN)<1e-8,'first reversed hand sample moves without rejected travel debt'));
    const angle=Math.sign(p.anchor[0])*.04;
    setGripRotation(g,gripPoseRotation(angle));t.toolbar.syncInput(t.frame);
    assert.ok(Math.hypot(...t.offsets.at(-1).map((v,i)=>v-reversed[i]))>.01,'wrist travel resumes after leaving the clearance boundary');
    assert.ok(toolbarHeadClearance(p,t.frame.getViewerPose(),t.offsets.at(-1))>=TOOLBAR_MIN_HEAD_CLEARANCE_METERS);
    const held=t.toolbar.glassPlates().flat().map(point=>[...point]);dispatch(t,'squeezeend',g.source);await tick();
    closePoints(t.toolbar.glassPlates().flat(),held,'clamped wrist release retains the drawn pose');
  }finally{await t.toolbar.dispose();}
});
