import assert from 'node:assert/strict';
import test from 'node:test';
import { toolbarFrameRuntime, toolbarFrameHarness, identity } from './fixtures/toolbar-frame-runtime.mjs';
import { createToolbarPanel } from './spatial-toolbar-geometry.mjs';

const runtime = await toolbarFrameRuntime(new URL('./', import.meta.url));
const tick = () => new Promise(resolve => setImmediate(resolve));

// A visionOS-style source exists only during a pinch. Full hand tracking,
// handedness and gamepads are deliberately absent. This is a CPU simulation
// of the WebXR event contract, not evidence from an Apple device.
function sourceAt(point) {
  const matrix = [...identity];
  for (let axis = 0; axis < 3; axis++) matrix[8 + axis] = -(point[axis] - [0, 1.6, 0][axis]);
  return { targetRayMode: 'transient-pointer', handedness: 'none',
    targetRaySpace: { pose: { emulatedPosition: false,
      transform: { matrix, position: { x: 0, y: 1.6, z: 0 } } } } };
}

async function harness() {
  const ownership = [], actions = [];
  const t = toolbarFrameHarness(runtime, { state: { voice: { state: 'idle' } },
    onConsumeSelect: event => ownership.push(event), onAction: action => actions.push(action),
    presentation: { setRoomOffset() {} } });
  await t.toolbar.update();
  let viewerReads = 0;
  const eventFrame = { getPose: t.frame.getPose,
    getViewerPose() { viewerReads++; throw new DOMException('Input event frame', 'InvalidStateError'); } };
  const emit = (type, source) => t.session.dispatchEvent(Object.assign(new Event(type, { cancelable: true }),
    { inputSource: source, frame: eventFrame }));
  const change = (added, removed) => {
    t.session.inputSources = [...t.session.inputSources.filter(s => !removed.includes(s)), ...added];
    t.session.dispatchEvent(Object.assign(new Event('inputsourceschange'), { added, removed }));
  };
  const panel = () => createToolbarPanel({ rows: t.toolbar.rows(), head: t.toolbar.head(), constants: t.toolbar.layout(),
    seatAnchor: t.toolbar.seatAnchor(), measureText: runtime.toolbarTextWidth });
  const aim = kind => sourceAt(panel().buttons.find(b => b.action.kind === kind).point);
  return { ...t, ownership, actions, aim, emit, change, viewerReads: () => viewerReads,
    start(source) { change([source], []); emit('selectstart', source); },
    end(source) { emit('select', source); emit('selectend', source); change([], [source]); } };
}

test('fresh unhanded pinch sources can drag and then click the menu', async () => {
  const t = await harness();
  try {
    const before = t.toolbar.seatAnchor();
    const first = t.aim('collapse'); t.start(first);
    first.targetRaySpace.pose.transform.position.x -= .1;
    t.toolbar.syncInput(t.frame);
    t.end(first); await tick();
    assert.equal(t.toolbar.isCollapsed(), true, 'drag must not activate its starting button');
    assert.ok(Math.abs(t.toolbar.seatAnchor()[0] - before[0] + .1) < 1e-9);
    assert.equal(t.toolbar.isHandOnPanel('none'), false, 'removal clears the first source');
    const second = t.aim('collapse'); t.start(second); t.end(second); await tick();
    assert.notEqual(first, second);
    assert.equal(t.toolbar.isCollapsed(), false);
    assert.deepEqual(t.actions, []);
    assert.equal(t.viewerReads(), 0, 'input events cannot read the viewer pose');
    assert.deepEqual(t.session.inputSources, []);
  } finally { await t.toolbar.dispose(); }
});

test('a fast unhanded pinch drag is committed before immediate source removal', async () => {
  const t = await harness();
  try {
    const before = t.toolbar.seatAnchor();
    const source = t.aim('recenter-structure'); t.start(source);
    source.targetRaySpace.pose.transform.position.x -= .1;
    // No render frame between press and release: sample the final event pose.
    t.end(source); await tick();
    assert.ok(Math.abs(t.toolbar.seatAnchor()[0] - before[0] + .1) < 1e-9);
    assert.deepEqual(t.actions, []);
    assert.equal(t.viewerReads(), 0);
  } finally { await t.toolbar.dispose(); }
});

test('two simultaneous unhanded pinches keep menu ownership by source identity', async () => {
  const t = await harness();
  try {
    const first = t.aim('collapse'), second = t.aim('recenter-structure');
    t.start(first); t.start(second);
    first.targetRaySpace.pose.transform.position.x -= .1;
    t.toolbar.syncInput(t.frame);
    t.end(second); t.end(first); await tick();
    assert.deepEqual(t.actions, [], 'second pinch cannot activate Reset while the first moves the menu');
    assert.equal(t.toolbar.isCollapsed(), true);
    assert.equal(t.toolbar.isHandOnPanel('none'), false);
    const third = t.aim('collapse'); t.start(third); t.end(third); await tick();
    assert.equal(t.toolbar.isCollapsed(), false, 'new source works after both old sources disappear');
  } finally { await t.toolbar.dispose(); }
});

for (const reason of ['cancel', 'removal']) test(`interrupted transient menu drag rolls back on ${reason}`, async () => {
  const t = await harness();
  try {
    const before = t.toolbar.seatAnchor();
    const source = t.aim('collapse'); t.start(source);
    source.targetRaySpace.pose.transform.position.x -= .1;
    t.toolbar.syncInput(t.frame);
    if (reason === 'cancel') t.emit('selectcancel', source);
    t.change([], [source]); await tick();
    assert.deepEqual(t.toolbar.seatAnchor(), before);
    assert.equal(t.toolbar.isHandOnPanel('none'), false);
    assert.deepEqual(t.actions, []);
    const next = t.aim('collapse'); t.start(next); t.end(next); await tick();
    assert.equal(t.toolbar.isCollapsed(), false);
  } finally { await t.toolbar.dispose(); }
});
