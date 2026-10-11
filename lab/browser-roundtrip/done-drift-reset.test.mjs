import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { toolbarFrameRuntime, toolbarFrameHarness, identity } from './fixtures/toolbar-frame-runtime.mjs';
import { menuSeatWithinView, menuSeatWithinGlance } from './menu-view-band.mjs';
import { resetViewPlacement } from './reset-view-placement.mjs';
import { menuResetActions } from './spatial-toolbar-content.mjs';

const runtime = await toolbarFrameRuntime();
const viewer = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
const closure = name => {
  const start = viewer.indexOf(`  async function ${name}(`);
  assert.ok(start >= 0);
  return viewer.slice(start, viewer.indexOf('\n  }', start) + 4);
};
const head = (i = 0) => {
  const angle = i * .025, x = i * .018, y = 1.6 - i * .012;
  return { position: { x, y, z: 0 }, matrix: [Math.cos(angle), 0, -Math.sin(angle), 0, 0, 1, 0, 0,
    Math.sin(angle), 0, Math.cos(angle), 0, x, y, 0, 1] };
};
const sequence = ['load 1CRN', 'sticks', 'element', 'select 10-20', 'hide chain A', 'show everything',
  'focus selection', 'load 4HHB', 'select four residues', 'hide chain B', 'show everything', 'focus selection',
  'refuse insecure URL', 'read refusal page 2', 'read refusal page 3', 'Fit'];
const flush = async () => { for (let i = 0; i < 200; i++) await Promise.resolve(); };

function resetHarness(toolbar) {
  const events = [], original = { scale: 1, rotation: [0, 30, 0], translation: [0, 0, -2] };
  let placement = { ...original, scale: 1.8, translation: [1, 0, -1] }, refusal;
  const context = vm.createContext({
    immersiveSession: { refreshToolbar: options => toolbar.update(options), toolbarAction: action => toolbar.runAction(action),
      isMenuCollapsed: () => toolbar.isCollapsed(), isMenuHidden: () => toolbar.isHidden(), setMenuHidden: value => toolbar.setHidden(value) },
    canvas: { xr: { isPresenting: { value: true } } }, assertReady() {},
    inspectionSnapshot: () => ({ placement }), runSpatialAction: async (_action, apply) => apply(),
    // The extracted callback object also registers session visibility; these
    // reset cases dispatch spatial actions only.
    handleXrInputVisibility() {},
    xrManipulation: { phase: () => 'idle' }, menuResetActions,
    talkCaption: { set: value => { if (value.outcome) events.push(value.outcome); } },
    showHeadsetCaption: text => events.push(text), recordManipulation: (_kind, detail) => events.push(detail),
    seatStructureForEntry: async options => {
      assert.equal(options.resetMenu, true);
      if (refusal) throw Error(refusal);
      // The existing solver, including its size/rotation and 4 m refusal, owns Reset.
      const result = resetViewPlacement({ seat: original, centered: true, points: [], headInRoom: identity,
        renderFromRoom: identity, cameraScale: 1, center: [0, 0, 0], radius: .1 });
      await Promise.resolve(); events.push('rendered'); placement = result; return result;
    },
  });
  vm.runInContext(closure('runFaceAction'), context);
  vm.runInContext(closure('resetOrientation'), context);
  const start = viewer.indexOf('      onSpatialAction: async action => {');
  const dispatch = vm.runInContext('({' + viewer.slice(start, viewer.indexOf('      onHeadFrame:', start)) + '}).onSpatialAction', context);
  return { dispatch, run: () => context.runFaceAction('recenter-structure'), events,
    placement: () => placement, original, refuse: text => { refusal = text; } };
}

for (const route of ['menu', 'aim']) test(`command sequence holds its room seat and ${route} Reset remains usable`, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  let reset;
  const h = toolbarFrameHarness(runtime, { onAction: action => reset?.dispatch(action) }); let pose = head();
  h.frame.getViewerPose = () => ({ transform: pose, views: [] });
  try {
    await h.toolbar.update();
    const initialSeat = h.toolbar.head();
    for (const [i, command] of sequence.entries()) {
      pose = head(-(i + 1));
      t.mock.timers.tick(300);
      h.toolbar.syncInput(h.frame);
      h.setBounds({ center: [i % 2, 0, -2], radius: .1 + i * .04 });
      h.setState({ subject: { pdbId: i < 7 ? '1CRN' : '4HHB', title: command,
        representation: i ? 'ball-and-stick' : 'cartoon', color: 'element-symbol', selectionCount: i % 12 } });
      await h.toolbar.update({ origin: 'host' });
      assert.equal(h.toolbar.head(), initialSeat, `${command} keeps the room seat`);
    }
    reset = resetHarness(h.toolbar);
    if (route === 'menu') h.toolbar.runAction(h.toolbar.rows().find(row => row.id === 'reset').action);
    else assert.equal((await h.toolbar.aimSynthetic({ id: 'reset' })).fired, true);
    await flush();
    assert.deepEqual(reset.placement().translation, reset.original.translation);
    assert.equal(reset.placement().scale, reset.original.scale);
    assert.deepEqual(reset.placement().rotation, reset.original.rotation);
    assert.ok(reset.events.indexOf('rendered') < reset.events.indexOf('View reset.'));
    assert.ok(menuSeatWithinGlance([...h.toolbar.drawnMenuPoints(), ...h.toolbar.captionPoints()], pose, h.toolbar.seatAnchor()));
  } finally { await h.toolbar.dispose(); }
});

test('host, tour and status redraws keep the seat after head drift', async () => {
  const h = toolbarFrameHarness(runtime); let pose = head();
  h.frame.getViewerPose = () => ({ transform: pose, views: [] });
  try {
    await h.toolbar.update();
    const seated = h.toolbar.head();
    const anchor = h.toolbar.seatAnchor();
    pose = head(-40);
    h.toolbar.syncInput(h.frame);
    assert.equal(menuSeatWithinView(h.toolbar.drawnMenuPoints(), pose), false);
    assert.equal(h.toolbar.menuWithinView(h.frame), false);
    h.setBounds({ center: [1, 0, -2], radius: .8 });
    h.setState({ subject: { title: 'Host edit' } });
    await h.toolbar.update({ origin: 'host' });
    assert.equal(h.toolbar.head(), seated);
    assert.deepEqual(h.toolbar.seatAnchor(), anchor);
    h.setState({ tour: { selectedId: 'demo', active: true, step: 0, title: 'Chapter' } });
    await h.toolbar.update({ origin: 'host' });
    assert.equal(h.toolbar.head(), seated);
    assert.deepEqual(h.toolbar.seatAnchor(), anchor);
    await h.toolbar.setStatus('Updated');
    assert.equal(h.toolbar.head(), seated);
    assert.deepEqual(h.toolbar.seatAnchor(), anchor);
    h.toolbar.runAction({ kind: 'recenter-menu' }); await flush();
    assert.ok(menuSeatWithinGlance([...h.toolbar.drawnMenuPoints(), ...h.toolbar.captionPoints()], pose, h.toolbar.seatAnchor()));
    assert.equal(h.toolbar.menuWithinView(h.frame), false, 'peripheral recovery still requires a deliberate glance');
    const recoveredAnchor = h.toolbar.seatAnchor(), x = pose.position.x, y = pose.position.y;
    const angle = Math.atan2(x - recoveredAnchor[0], -recoveredAnchor[2]);
    pose = { position: { x, y, z: 0 }, matrix: [Math.cos(angle), 0, -Math.sin(angle), 0, 0, 1, 0, 0,
      Math.sin(angle), 0, Math.cos(angle), 0, x, y, 0, 1] };
    assert.equal(h.toolbar.menuWithinView(h.frame), true, 'complete glass is visible after turning toward its held room anchor');
  } finally { await h.toolbar.dispose(); }
});

test('a host edit during a summon redraws after the new seat commits', async () => {
  let state = { subject: { title: 'Before summon' } }, pose = head();
  let releaseBuild, enteredBuild;
  const building = new Promise(resolve => { enteredBuild = resolve; });
  const frame = { getViewerPose: () => ({ transform: pose, views: [] }) };
  const session = Object.assign(new EventTarget(), { inputSources: [],
    requestAnimationFrame(callback) { queueMicrotask(() => callback(0, frame)); return 1; },
    cancelAnimationFrame() {} });
  let holdBuild = false;
  const toolbar = runtime.createSpatialToolbar({
    plugin: { runTask: async task => {
      if (holdBuild) {
        holdBuild = false;
        enteredBuild();
        await new Promise(resolve => { releaseBuild = resolve; });
      }
      return task.run();
    } },
    canvas: {}, session, space: {}, Mat4: {},
    presentation: { add() {}, remove() {}, update() {}, setVisible() {}, roomMatrix: () => identity },
    getEntryGeometry: () => ({}), getMolecularBounds: () => ({ center: [0, 0, -1], radius: .1 }),
    getDepthRange: () => ({}), getState: () => state, onRepresentationChange() {}, onAction() {},
  });
  try {
    await toolbar.update();
    toolbar.runAction({ kind: 'collapse', value: false });
    await new Promise(resolve => setImmediate(resolve));
    pose = head(10);
    holdBuild = true;
    const summon = toolbar.update({ recenter: true, origin: 'wearer' });
    await building;
    state = { subject: { title: 'Host edit during summon' } };
    await toolbar.update({ origin: 'host' });
    releaseBuild();
    await summon;
    const anchor = toolbar.seatAnchor();
    await flush();
    assert.ok(toolbar.readoutText().some(line => line.includes('Host edit during summon')));
    assert.deepEqual(toolbar.seatAnchor(), anchor, 'the follow-up redraw holds the summoned anchor');
  } finally {
    releaseBuild?.();
    await toolbar.dispose();
  }
});

for (const kind of ['collapse', 'recenter-menu']) test(`${kind} recovers the menu and caption after walking and turning`, async () => {
  const h = toolbarFrameHarness(runtime); let pose = head();
  h.frame.getViewerPose = () => ({ transform: pose, views: [] });
  try {
    await h.toolbar.update(); pose = head(-40);
    assert.equal(menuSeatWithinView(h.toolbar.drawnMenuPoints(), pose), false);
    h.toolbar.runAction({ kind, value: true }); await flush();
    assert.ok(menuSeatWithinGlance([...h.toolbar.drawnMenuPoints(), ...h.toolbar.captionPoints()], pose, h.toolbar.seatAnchor()));
  } finally { await h.toolbar.dispose(); }
});

for (const refusal of ['Enter VR and wait for tracking before recentring the structure.',
  'Could not reset: the entry seat has not rendered yet. Wait for the structure to appear.',
  'Could not reset: the entry size cannot fit inside both eyes and clear the menu within 4 m. Press Fit, or move the menu.',
  'The viewer is busy.', 'Reset draw failed']) test(`Reset speaks and keeps placement on refusal: ${refusal}`, async () => {
  const h = toolbarFrameHarness(runtime); let pose = head();
  h.frame.getViewerPose = () => ({ transform: pose, views: [] });
  try {
    await h.toolbar.update(); pose = head(-40);
    const reset = resetHarness(h.toolbar), before = structuredClone(reset.placement()); reset.refuse(refusal);
    await assert.rejects(reset.run(), { message: refusal });
    assert.deepEqual(reset.placement(), before);
    assert.ok(reset.events.includes(refusal));
    assert.ok(!reset.events.includes('View reset.') && !reset.events.includes('rendered'));
    assert.ok(menuSeatWithinGlance([...h.toolbar.drawnMenuPoints(), ...h.toolbar.captionPoints()], pose, h.toolbar.seatAnchor()));
  } finally { await h.toolbar.dispose(); }
});

for (const radius of [0, NaN]) test(`Menu and Move recover even when molecular bounds are unavailable (${radius})`, async () => {
  const h = toolbarFrameHarness(runtime); let pose = head();
  h.frame.getViewerPose = () => ({ transform: pose, views: [] });
  try {
    await h.toolbar.update();
    h.setBounds({ center: [0, 0, 0], radius });
    pose = head(-40);
    h.toolbar.runAction({ kind: 'collapse', value: true }); await flush();
    assert.ok(menuSeatWithinGlance([...h.toolbar.drawnMenuPoints(), ...h.toolbar.captionPoints()], pose, h.toolbar.seatAnchor()));
    pose = head(40);
    h.toolbar.runAction({ kind: 'recenter-menu' }); await flush();
    assert.ok(menuSeatWithinGlance([...h.toolbar.drawnMenuPoints(), ...h.toolbar.captionPoints()], pose, h.toolbar.seatAnchor()));
  } finally { await h.toolbar.dispose(); }
});
