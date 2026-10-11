import assert from 'node:assert/strict';
import test from 'node:test';
import { createToolbarPanel, GLYPH_CAP_FRACTION, HALF_IPD_METERS, SPATIAL_TOOLBAR_LAYOUT,
  TOOLBAR_MIN_HEAD_CLEARANCE_METERS, TOOLBAR_READING_RANGE_METERS,
  toolbarHeadClearance, toolbarPlatePoints } from './spatial-toolbar-geometry.mjs';
import { spatialToolbarRows } from './spatial-toolbar-content.mjs';
import { menuSeatWithinView, menuSeatWithinGlance } from './menu-view-band.mjs';
import { toolbarFrameRuntime, toolbarFrameHarness, identity } from './fixtures/toolbar-frame-runtime.mjs';

const head = { position: { x: 0, y: 1.6, z: 0 }, matrix: identity };
const readout = [{ text: 'Contact change' }, { text: 'Watch the contact change as the molecule opens.' }];
const runtime = await toolbarFrameRuntime();
const flush = () => new Promise(resolve => setImmediate(resolve));
const panelFor = t => createToolbarPanel({ head: t.toolbar.head(), rows: t.toolbar.rows(),
  constants: t.toolbar.layout(), seatAnchor: t.toolbar.seatAnchor(), measureText: runtime.toolbarTextWidth });

for (const collapsed of [true, false]) test(`${collapsed ? 'compact' : 'expanded'} default keeps readable glass at its intended glance angle`, () => {
  const panel = createToolbarPanel({ head, rows: spatialToolbarRows({ collapsed, voice: { state: 'idle' } }), readout });
  assert.equal(TOOLBAR_READING_RANGE_METERS, 1.35);
  assert.ok(Math.abs(Math.hypot(panel.anchor[0], panel.anchor[2]) - 1.35) < 1e-9);
  assert.ok(panel.captionBacking, 'exercise caption glass as well as controls');
  const bearing = Math.atan2(-panel.anchor[0], -panel.anchor[2]);
  if (collapsed) assert.ok(Math.abs(bearing * 180 / Math.PI - 47) < 1e-6, 'actual compact bearing stays left of the subject');
  const readingHead = collapsed ? { ...head, matrix: [Math.cos(bearing), 0, -Math.sin(bearing), 0,
    0, 1, 0, 0, Math.sin(bearing), 0, Math.cos(bearing), 0, 0, 0, 0, 1] } : head;
  assert.ok(menuSeatWithinView(toolbarPlatePoints(panel), readingHead), 'the whole panel fits after turning toward it');
  assert.ok(toolbarHeadClearance(panel, head) > 1.25, 'the whole glass sits beyond close reach');
  assert.ok(Math.abs(SPATIAL_TOOLBAR_LAYOUT.fontMeters / 1.35 - .05 / .95) < 1e-12,
    'greater depth preserves the authored angular type size');
  assert.ok(Math.abs(panel.readoutFontMeters * GLYPH_CAP_FRACTION / 1.35 -
    .05 * panel.density * GLYPH_CAP_FRACTION / .95) < 1e-12,
  'caption cap height keeps its angular size at each menu density');
});

test('head clearance measures glass interiors and the nearer eye, not only corners or anchor', () => {
  const panel = { right: [1, 0, 0], up: [0, 1, 0], normal: [0, 0, -1], buttons: [],
    backing: { point: [0, 1.6, -.2], halfWidth: 2, halfHeight: 2 } };
  assert.equal(toolbarHeadClearance(panel, head), .2);
  panel.backing = { point: [1, 1.6, 0], halfWidth: .1, halfHeight: .1 };
  assert.ok(Math.abs(toolbarHeadClearance(panel, head) - (1 - .1 - HALF_IPD_METERS)) < 1e-12);
  panel.captionBacking = { point: [0, 1.6, -.1], halfWidth: .2, halfHeight: .2 };
  assert.equal(toolbarHeadClearance(panel, head), .1, 'a closer caption also limits the drag');
});

test('summon and automatic clearance retain the comfortable menu range without a molecular action', async () => {
  const actions = [];
  const t = toolbarFrameHarness(runtime, { onAction: action => actions.push(action),
    state: { voice: { state: 'idle' }, tour: { active: true, title: 'Contact', body: 'See the contact.' } } });
  await t.toolbar.update();
  try {
    for (const collapsed of [true, false]) {
      t.toolbar.runAction({ kind: 'collapse', value: collapsed }); await flush();
      t.moveHead(.4);
      t.toolbar.runAction({ kind: 'recenter-menu' }); await flush();
      assert.ok(Math.abs(Math.hypot(t.toolbar.seatAnchor()[0] - .4, t.toolbar.seatAnchor()[2]) - 1.35) < 1e-9);
      const matrix = [...identity]; matrix[12] = .4; matrix[13] = 1.6;
      const candidates = t.toolbar.prepareRelocation({ headInRoom: matrix }).filter(candidate => !candidate.hide);
      assert.ok(candidates.length > 0);
      for (const candidate of candidates) {
        assert.ok(menuSeatWithinView(candidate.points, candidate.head), 'complete relocation glass fits both eyes');
        assert.ok(Math.abs(Math.hypot(candidate.anchor[0] - .4, candidate.anchor[2]) - 1.35) < 1e-9);
      }
      await t.toolbar.commitRelocation(candidates[0]);
      assert.deepEqual(t.toolbar.platePoints(), candidates[0].points);
      assert.ok(toolbarHeadClearance(panelFor(t), t.frame.getViewerPose()) > 1.25);
    }
    assert.deepEqual(actions, []);
  } finally { await t.toolbar.dispose(); }
});

test('drag checks the current head, clamps at clearance, and still allows free outward placement', async () => {
  let clock = 0;
  const offsets = [], actions = [];
  const t = toolbarFrameHarness(runtime, { now: () => clock, onAction: action => actions.push(action),
    presentation: { setRoomOffset(_target, offset) { offsets.push([...offset]); } } });
  await t.toolbar.update();
  try {
    const panel = panelFor(t), anchor = [...panel.anchor];
    const button = panel.buttons.find(value => value.action.kind === 'collapse');
    const matrix = [...identity];
    for (let axis = 0; axis < 3; axis++) matrix[8 + axis] = -(button.point[axis] - [0, 1.6, 0][axis]);
    const position = { x: 0, y: 1.6, z: 0 };
    const source = { handedness: 'right', targetRaySpace: { pose: { emulatedPosition: false, transform: { matrix, position } } } };
    t.session.inputSources = [source];
    const dispatch = type => t.session.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), { inputSource: source, frame: t.frame }));
    dispatch('selectstart'); await flush();
    const builds = runtime.counts.ShapeRepresentation;
    clock = 250;
    const currentHead = { position: { x: anchor[0] * .6, y: 1.6, z: anchor[2] * .6 }, matrix: identity };
    t.frame.getViewerPose = () => ({ transform: currentHead });
    position.x = .1;
    t.toolbar.syncInput(t.frame);
    assert.equal(offsets.length, 0, 'old entry-origin distance cannot admit glass beside the current head');
    // Travel in measured frames; a single >0.5 m sample is a tracking jump.
    for (let step = 1; step <= 12; step++) {
      position.x = .1 + (anchor[0] * .6 - .1) * step / 12;
      position.z = anchor[2] * .6 * step / 12;
      clock += 14; t.toolbar.syncInput(t.frame);
    }
    assert.ok(offsets.length > 0, 'the wearer can move the menu outward');
    const safe = [...offsets.at(-1)];
    assert.ok(toolbarHeadClearance(panel, currentHead, safe) >= TOOLBAR_MIN_HEAD_CLEARANCE_METERS);
    let refused = 0;
    for (let step = 1; step <= 12; step++) {
      position.x = anchor[0] * .6 + (.1 - anchor[0] * .6) * step / 12;
      position.z = anchor[2] * .6 * (1 - step / 12);
      const unsafe = toolbarHeadClearance(panel, currentHead, [position.x, 0, position.z]) < TOOLBAR_MIN_HEAD_CLEARANCE_METERS;
      clock += 14; t.toolbar.syncInput(t.frame);
      if (unsafe) {
        refused++;
        assert.ok(toolbarHeadClearance(panel, currentHead, offsets.at(-1)) >= TOOLBAR_MIN_HEAD_CLEARANCE_METERS,
          'near-head input remains outside the current eyes');
      }
    }
    assert.ok(refused > 0, 'the return trajectory exercises the head-clearance guard');
    assert.ok(toolbarHeadClearance(panel, currentHead, offsets.at(-1)) >= TOOLBAR_MIN_HEAD_CLEARANCE_METERS);
    assert.equal(runtime.counts.ShapeRepresentation, builds, 'held drag only updates room offsets');
    dispatch('select'); dispatch('selectend'); await flush();
    assert.ok(toolbarHeadClearance(panelFor(t), currentHead) >= TOOLBAR_MIN_HEAD_CLEARANCE_METERS);
    assert.deepEqual(actions, [], 'drag does not dispatch molecular controls');
  } finally { await t.toolbar.dispose(); }
});

test('release moves outward to safe clearance when the wearer walks into the held menu', async () => {
  const offsets = [];
  const t = toolbarFrameHarness(runtime, { state: { voice: { state: 'idle' } },
    presentation: { setRoomOffset(_target, offset) { offsets.push([...offset]); } } });
  await t.toolbar.update();
  try {
    const panel = panelFor(t), anchor = [...panel.anchor];
    const button = panel.buttons.find(value => value.action.kind === 'collapse');
    const matrix = [...identity], position = { x: 0, y: 1.6, z: 0 };
    for (let axis = 0; axis < 3; axis++) matrix[8 + axis] = -(button.point[axis] - [0, 1.6, 0][axis]);
    const source = { handedness: 'right', targetRaySpace: { pose: { emulatedPosition: false, transform: { matrix, position } } } };
    const dispatch = type => t.session.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), { inputSource: source, frame: t.frame }));
    dispatch('selectstart'); position.x = -.08; t.toolbar.syncInput(t.frame);
    assert.ok(offsets.length > 0);
    const currentHead = { transform: { position: { x: anchor[0] - .08, y: anchor[1], z: anchor[2] }, matrix: identity } };
    t.frame.getViewerPose = () => currentHead;
    t.toolbar.syncInput(t.frame);
    dispatch('select'); dispatch('selectend'); await flush();
    assert.notDeepEqual(t.toolbar.seatAnchor(), anchor, 'release cannot snap to an original seat beside the current head');
    assert.ok(toolbarHeadClearance(panelFor(t), currentHead) >= TOOLBAR_MIN_HEAD_CLEARANCE_METERS);
  } finally { await t.toolbar.dispose(); }
});


test('compact full scientific caption clears the central sixty-degree cone and fits both eyes after a glance', () => {
  const title = 'Human deoxyhaemoglobin';
  const body = 'Four chains carry oxygen in blood.';
  const panel = createToolbarPanel({ head, rows: spatialToolbarRows({ collapsed: true, voice: { state: 'idle' } }),
    readout: [{ text: title, whole: true }, { text: body, whole: true }], measureText: runtime.toolbarTextWidth });
  const text = panel.readoutPoints.map(row => row.text).join(' ');
  assert.ok(text.includes(title)); assert.ok(text.includes(body));
  const points = toolbarPlatePoints(panel);
  assert.ok(menuSeatWithinGlance(points, head, panel.anchor));
  assert.ok(points.every(point => Math.atan2(Math.hypot(point[0], point[1] - 1.6), -point[2]) >= Math.PI / 6),
    'caption, status and controls all remain outside the central sixty-degree cone');
  assert.ok(panel.readoutFontMeters * GLYPH_CAP_FRACTION >= .028);
  assert.ok(toolbarHeadClearance(panel, head) >= 1.25);
});
