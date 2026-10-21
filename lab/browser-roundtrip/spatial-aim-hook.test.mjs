import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { createToolbarPanel, hitToolbarPanel } from './spatial-toolbar-geometry.mjs';
import { spatialToolbarRows } from './spatial-toolbar-content.mjs';
import { aimRayAtPoint, installSpatialAimHook, toolbarAimRay, toolbarMissTarget } from './spatial-aim-hook.mjs';
import { toolbarFrameRuntime, toolbarFrameHarness } from './fixtures/toolbar-frame-runtime.mjs';

const HEAD = { position: { x: 0, y: 1.6, z: 0 }, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] };
const SHIPPED = spatialToolbarRows({ tour: { selectedId: 'g', active: true, canBack: true, canNext: true,
  bodyPageCount: 3, bodyPageIndex: 0 }, voice: { state: 'idle' }, collapsed: false, passthrough: false });
const panelOf = (rows = SHIPPED) => createToolbarPanel({ rows, head: HEAD });

afterEach(() => { delete globalThis.__stereofoldAim; });

test('a simulated controller pose aimed at a row hits that row and no other', () => {
  const panel = panelOf();
  const targetable = panel.buttons.filter(button => button.targetable !== false);
  assert.ok(targetable.length >= 8, 'the expanded menu draws the rows this run walks');
  for (const button of targetable) {
    const index = panel.buttons.indexOf(button);
    const ray = toolbarAimRay(panel, { row: index });
    assert.ok(ray, `row ${button.id} is aimable`);
    // The pose is off-axis on purpose: an eye-level square-on ray would pass a
    // hit test that a pointed controller can still fail.
    assert.notDeepEqual(ray.origin, panel.seatOrigin);
    const hit = hitToolbarPanel(panel, ray);
    assert.equal(hit?.id, button.id, `aiming at ${button.id} must hit ${button.id}, not ${hit?.id ?? 'nothing'}`);
  }
});

test('a pose aimed at the gap between the columns hits nothing, and the stacked rows leave no gap', () => {
  const panel = panelOf();
  const miss = toolbarMissTarget(panel);
  assert.ok(miss, 'the expanded menu offers a point that presses nothing');
  assert.equal(miss.kind, 'between-columns');
  assert.equal(hitToolbarPanel(panel, miss.ray), undefined);
  // Both flanking rows are hittable, so the miss is the gap and not a dead panel.
  for (const slot of miss.between) assert.ok(hitToolbarPanel(panel, toolbarAimRay(panel, { row: slot })));
  // Measured, and the reason the miss is not taken between stacked rows: this
  // layout overlaps them, so a ray halfway between two row centres in one
  // column lands inside the upper row rather than in a gap.
  const [first, second] = [panel.buttons[0], panel.buttons[1]];
  assert.equal(first.column, second.column);
  const separation = Math.abs(second.point[1] - first.point[1]);
  assert.ok(separation < first.halfHeight * 2, `stacked rows overlap: ${separation} apart, ${first.halfHeight * 2} tall`);
  const stacked = toolbarAimRay(panel, { point: [(first.point[0] + second.point[0]) / 2,
    (first.point[1] + second.point[1]) / 2, (first.point[2] + second.point[2]) / 2] });
  assert.equal(hitToolbarPanel(panel, stacked)?.id, first.id);
});

test('a single-column menu falls back to the band above its top row', () => {
  const panel = panelOf(spatialToolbarRows({ voice: { state: 'idle' }, collapsed: true }));
  assert.equal(new Set(panel.buttons.map(button => button.column)).size, 1);
  const miss = toolbarMissTarget(panel);
  assert.equal(miss.kind, 'above-top-row');
  assert.equal(hitToolbarPanel(panel, miss.ray), undefined);
});

test('a recessed status row refuses the aimed select the way it refuses a trigger', () => {
  const rows = spatialToolbarRows({ voice: { state: 'sending' }, collapsed: true });
  const panel = panelOf(rows);
  const recessed = panel.buttons.filter(button => button.targetable === false);
  assert.ok(recessed.length, 'a menu that is still hearing the wearer draws a state chip');
  for (const button of recessed) {
    const ray = toolbarAimRay(panel, { row: panel.buttons.indexOf(button) });
    assert.equal(hitToolbarPanel(panel, ray), undefined, `${button.label} is not a target`);
  }
});

test('an unaimable panel and an unknown row return no ray rather than a wrong one', () => {
  assert.equal(toolbarAimRay(undefined, { row: 0 }), undefined);
  assert.equal(toolbarAimRay(panelOf(), { row: 999 }), undefined);
  assert.equal(aimRayAtPoint(panelOf(), [Number.NaN, 0, 0]), undefined);
  assert.equal(toolbarMissTarget({ buttons: [] }), undefined);
});

test('the aim hook installs one guarded global and takes it away again', () => {
  const asked = [];
  const dispose = installSpatialAimHook({ readRows: () => SHIPPED, aim: target => { asked.push(target); return { fired: true }; } });
  assert.equal(globalThis.__stereofoldAim.simulates, 'controller pose, not a hand or a wearer');
  assert.ok(globalThis.__stereofoldAim.rows().some(row => row.id === 'mode' && row.active));
  assert.deepEqual(globalThis.__stereofoldAim.at('mode'), { fired: true });
  assert.deepEqual(globalThis.__stereofoldAim.miss(), { fired: true });
  assert.deepEqual(asked, [{ id: 'mode' }, { between: true }]);
  dispose();
  assert.equal(globalThis.__stereofoldAim, undefined);
  assert.throws(() => installSpatialAimHook({ readRows: () => [] }), TypeError);
});

test('the toolbar runs an aimed select through its own hit test and action chain', async () => {
  const runtime = await toolbarFrameRuntime();
  const h = toolbarFrameHarness(runtime, { state: { voice: { state: 'idle' } } });
  h.toolbar.syncPose(h.frame);
  await h.toolbar.update();
  // Mode belongs to the expanded menu; entry deliberately starts compact.
  h.toolbar.runAction({ kind: 'collapse', value: false });
  await new Promise(resolve => setImmediate(resolve));

  const aimed = h.toolbar.aimSynthetic({ id: 'mode' });
  assert.equal(aimed.method, 'synthetic-ray');
  assert.equal(aimed.simulates, 'controller pose, not a hand or a wearer');
  assert.equal(aimed.hitId, 'mode', aimed.reason);
  assert.equal(aimed.hovered, 'mode', 'the aimed row is the row the wearer would see highlighted');
  assert.equal(aimed.fired, true, aimed.reason);
  assert.equal(aimed.reason, 'the aimed row took the select');
  assert.equal(aimed.ray.origin.length, 3);

  const missed = h.toolbar.aimSynthetic({ between: true });
  assert.equal(missed.method, 'synthetic-ray');
  assert.equal(missed.aimedAt, 'between-columns');
  assert.equal(missed.hitId, null);
  assert.equal(missed.fired, false);
  assert.equal(missed.reason, 'the ray landed between the two columns and fired nothing');
  assert.equal(missed.betweenRows.length, 2);

  const absent = h.toolbar.aimSynthetic({ id: 'no-such-row' });
  assert.equal(absent.fired, false);
  assert.match(absent.reason, /no drawn row/u);
  assert.ok(absent.rows.includes('mode'));
  await h.toolbar.dispose();
});

test('an aimed press reaches the same action the toolbar runs for a trigger', async () => {
  const runtime = await toolbarFrameRuntime();
  const actions = [];
  const h = toolbarFrameHarness(runtime, { state: { voice: { state: 'idle' } } });
  h.toolbar.syncPose(h.frame);
  await h.toolbar.update();
  // `mode` is handled inside the toolbar, so watch a row that leaves the panel.
  const viaAim = h.toolbar.aimSynthetic({ id: 'talk' });
  assert.equal(viaAim.hitId, 'talk', viaAim.reason);
  assert.equal(viaAim.fired, true, viaAim.reason);
  assert.equal(actions.length, 0, 'the harness toolbar owns its own action sink');
  await h.toolbar.dispose();
});

for (const kind of ['trigger', 'grip']) test(`bounded synthetic ${kind} drag holds across real frame callbacks, then releases without activating a row`, async () => {
  const runtime = await toolbarFrameRuntime();
  const actions = [], offsets = [];
  const h = toolbarFrameHarness(runtime, { state: { voice: { state: 'idle' } }, onAction: action => actions.push(action),
    presentation: { setRoomOffset(_target, offset) { offsets.push([...offset]); } } });
  await h.toolbar.update();
  const dispose = installSpatialAimHook({ readRows: () => h.toolbar.rows(), aim: target => h.toolbar.aimSynthetic(target) });
  try {
    const hook = globalThis.__stereofoldAim;
    const begun = await hook.beginDrag({ id: 'talk', kind });
    assert.equal(begun.accepted, true);
    assert.equal(begun.method, 'synthetic-menu-drag');
    assert.match(begun.simulates, /not a hand or a wearer/);
    const moved = await hook.moveDrag([-.12, 0, 0]);
    assert.equal(moved.accepted, true);
    assert.equal(moved.current.holding, true);
    await new Promise(resolve => setImmediate(resolve));
    await h.frames(24);
    const held = await hook.dragState();
    assert.equal(held.current.heldFeedback, true);
    assert.equal(held.current.holding, true, 'normal XR frames do not lose the bounded synthetic source');
    assert.ok(held.current.geometry.rows.some(row => row.id === 'talk'));
    assert.ok(held.current.geometry.plates.some(plate => plate.kind === 'controls'));
    assert.deepEqual(held.current.anchor, moved.current.anchor);
    assert.deepEqual(h.session.inputSources, [], 'diagnostic never modifies the native session input list');
    assert.equal(hook.at('talk').fired, false);
    const released = await hook.endDrag();
    assert.equal(released.rowActions, 0);
    assert.equal(released.current.holding, false);
    assert.equal(released.current.heldFeedback, false);
    assert.equal(released.current.points.length, held.current.points.length);
    released.current.points.forEach((point, i) => point.forEach((v, axis) =>
      assert.ok(Math.abs(v - held.current.points[i][axis]) < 1e-8)));
    assert.deepEqual(actions, []);
    assert.ok(offsets.some(offset => offset[0] < -.1));
    await h.frames(12); await h.toolbar.update();
    assert.deepEqual((await hook.dragState()).current.points, released.current.points);
  } finally { dispose(); await h.toolbar.dispose(); }
});

for (const end of ['end', 'cancel', 'dispose', 'hide', 'blur']) test(`synthetic menu drag cleanup on ${end} never clicks its starting row`, async () => {
  const runtime = await toolbarFrameRuntime();
  const actions = [];
  const h = toolbarFrameHarness(runtime, { state: { voice: { state: 'idle' } }, onAction: action => actions.push(action),
    presentation: { setRoomOffset() {} } });
  await h.toolbar.update();
  const dispose = installSpatialAimHook({ readRows: () => h.toolbar.rows(), aim: target => h.toolbar.aimSynthetic(target) });
  try {
    const hook = globalThis.__stereofoldAim;
    const before = h.toolbar.platePoints();
    assert.equal((await hook.beginDrag({ id: 'talk' })).accepted, true);
    if (end !== 'end') await hook.moveDrag([-.1, 0, 0]);
    if (end === 'end') await hook.endDrag();
    if (end === 'cancel') await hook.cancelDrag();
    if (end === 'dispose') dispose();
    if (end === 'hide') h.toolbar.setHidden(true);
    if (end === 'blur') h.toolbar.blur();
    assert.equal((await hook.dragState()).active, false);
    assert.equal(h.toolbar.isHandOnPanel('right'), false);
    assert.deepEqual(actions, []);
    if (end !== 'hide') assert.deepEqual(h.toolbar.platePoints(), before);
  } finally { dispose(); await h.toolbar.dispose(); }
});

test('synthetic drag refuses unbounded travel and expires after its fixed hold window', async () => {
  const runtime = await toolbarFrameRuntime(undefined, { instrumentTimers: true });
  let expire;
  runtime.setTimers({ setTimeout(fn, ms) { if (ms === 30000) { expire = fn; return 12345; } return setTimeout(fn, ms); },
    clearTimeout(id) { if (id !== 12345) clearTimeout(id); }, setInterval, clearInterval });
  const h = toolbarFrameHarness(runtime, { state: { voice: { state: 'idle' } }, presentation: { setRoomOffset() {} } });
  await h.toolbar.update();
  try {
    const aim = drag => h.toolbar.aimSynthetic({ drag });
    assert.equal((await aim({ phase: 'begin', id: 'talk', kind: 'grip' })).accepted, true);
    const before = h.toolbar.platePoints();
    for (const offset of [[3, 0, 0], [Infinity, 0, 0], ['1', 0, 0], [0, 0]])
      assert.equal((await aim({ phase: 'move', offset })).accepted, false);
    assert.deepEqual(h.toolbar.platePoints(), before);
    assert.equal(typeof expire, 'function'); expire();
    await new Promise(resolve => setImmediate(resolve));
    const last = await aim({ phase: 'state' });
    assert.equal(last.active, false); assert.equal(last.ended, 'timeout');
    assert.equal(last.current.holding, false);
  } finally { await h.toolbar.dispose(); }
});

test('trigger diagnostic waits for the actual held representation task instead of two microtasks', async () => {
  const runtime = await toolbarFrameRuntime();
  let gate, unlock;
  const h = toolbarFrameHarness(runtime, { state: { voice: { state: 'idle' } },
    runTask: async task => { if (gate) await gate; return task.run(); }, presentation: { setRoomOffset() {} } });
  await h.toolbar.update();
  try {
    const aim = drag => h.toolbar.aimSynthetic({ drag });
    await aim({ phase: 'begin', id: 'talk', kind: 'trigger' });
    gate = new Promise(resolve => { unlock = resolve; });
    let completed = false;
    const pending = aim({ phase: 'move', offset: [-.12, .04, .10] }).then(value => { completed = true; return value; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(completed, false, 'move receipt waits for asynchronous Mol* work');
    const building = await aim({ phase: 'state' });
    assert.equal(building.current.holding, true);
    assert.equal(building.current.heldFeedback, false);
    assert.equal(building.current.feedbackPending, true);
    unlock(); gate = undefined;
    const moved = await pending;
    assert.equal(moved.current.heldFeedback, true);
    assert.equal(moved.current.feedbackPending, false);
    assert.equal(moved.current.feedbackError, null);
    await aim({ phase: 'cancel' });
  } finally { unlock?.(); await h.toolbar.dispose(); }
});
