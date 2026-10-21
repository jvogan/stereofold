import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { SPATIAL_TOOLBAR_LAYOUT, createToolbarPanel, hitToolbarPanel } from './spatial-toolbar-geometry.mjs';
import { spatialToolbarRows } from './spatial-toolbar-content.mjs';
import { hitToolbarFootprint, toolbarPressDecision } from './spatial-toolbar-wake.mjs';

// The identity head the emulated acceptance harness lays its targets out from.
const HEAD = { position: { x: 0, y: 1.6, z: 0 }, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] };

// A chapter on screen: the full draw holds Back, the quiet draw does not.
const tour = () => ({ active: true, selectedId: 'guided', canBack: true, canNext: true, bodyPageCount: 1, bodyPageIndex: 0 });
const fullRows = () => spatialToolbarRows({ collapsed: true, mode: 'move', paused: true, voice: { state: 'idle' }, tour: tour() });
const quietRows = () => spatialToolbarRows({ collapsed: true, mode: 'move', paused: true, voice: { state: 'idle' }, tour: tour(), quiet: true });
const fullPanel = () => createToolbarPanel({ rows: fullRows(), head: HEAD, constants: SPATIAL_TOOLBAR_LAYOUT });
const quietPanel = () => createToolbarPanel({ rows: quietRows(), head: HEAD, constants: SPATIAL_TOOLBAR_LAYOUT });
// A controller ray aimed at a seat: from the seat along the panel normal, the
// way a wearer pointing at that seat holds the ray.
const aimedRay = (panel, point) => ({ origin: point.map((value, axis) => value + panel.normal[axis] * 0.55),
  direction: panel.normal.map(value => -value) });
const seatOf = (panel, label) => panel.buttons.find(button => button.label === label).point;

test('the full draw holds eight rows and the quiet draw holds Talk, Play, Next, Menu', () => {
  assert.deepEqual(quietRows().map(row => row.label), ['Talk', 'Play', 'Next', 'Menu']);
  assert.equal(fullRows().length, 8);
  assert.ok(fullRows().some(row => row.label === 'Back'), 'This test needs a full-draw row the quiet draw vacates.');
});

test('a press aimed at a full-draw seat cannot reach its row once the quiet draw shows', () => {
  // The row hit test only knows the drawn rows. The quiet swap moves the
  // panel, so a stale seat resolves to the wrong row or to nothing at all — a
  // press aimed at Back reaches nothing, which reads as the menu ignoring the
  // wearer.
  const full = fullPanel(), quiet = quietPanel();
  assert.equal(hitToolbarPanel(full, aimedRay(full, seatOf(full, 'Back')))?.label, 'Back');
  assert.notEqual(hitToolbarPanel(quiet, aimedRay(full, seatOf(full, 'Back')))?.label, 'Back');
  assert.equal(hitToolbarPanel(quiet, aimedRay(full, seatOf(full, 'Menu'))), undefined);
});

test('those same presses are on the full-draw footprint, so they wake the menu', () => {
  const full = fullPanel();
  assert.equal(hitToolbarFootprint(full, aimedRay(full, seatOf(full, 'Back'))), true);
  assert.equal(hitToolbarFootprint(full, aimedRay(full, seatOf(full, 'Menu'))), true);
  // Every full-draw seat is plate, not just the vacated ones.
  for (const button of full.buttons) {
    assert.equal(hitToolbarFootprint(full, aimedRay(full, button.point)), true, `${button.label} is off its own plate.`);
  }
});

test('a press on a quiet-draw row still resolves to that row', () => {
  const panel = quietPanel();
  for (const label of ['Talk', 'Play', 'Next', 'Menu']) {
    assert.equal(hitToolbarPanel(panel, aimedRay(panel, seatOf(panel, label)))?.label, label);
  }
});

test('a press nowhere near the plate wakes nothing', () => {
  const panel = fullPanel();
  const far = { origin: [5, 5, -0.3], direction: [0, 0, -1] };
  assert.equal(hitToolbarFootprint(panel, far), false);
  assert.equal(hitToolbarFootprint(panel, { origin: [0, 0, -0.3], direction: [1, 0, 0] }), false);
  assert.equal(hitToolbarFootprint(undefined, aimedRay(panel, seatOf(panel, 'Back'))), false);
  assert.equal(hitToolbarFootprint(panel, undefined), false);
});

test('the press decision wakes on the footprint, presses rows, and ignores the rest', () => {
  // A quiet-row press acts, even while quiet.
  assert.equal(toolbarPressDecision({ rowHit: true, quiet: true, footprintHit: false }), 'row');
  assert.equal(toolbarPressDecision({ rowHit: true, quiet: false, footprintHit: false }), 'row');
  // The vacated-seat press wakes the full draw instead of dying silently.
  assert.equal(toolbarPressDecision({ rowHit: false, quiet: true, footprintHit: true }), 'wake');
  // The press that wakes claims no row: `wake` starts no gesture, so no row
  // action can fire from it.
  assert.notEqual(toolbarPressDecision({ rowHit: false, quiet: true, footprintHit: true }), 'row');
  // Off the plate while quiet, and anything unclaimed while the full draw is
  // already showing, stays a miss exactly as today.
  assert.equal(toolbarPressDecision({ rowHit: false, quiet: true, footprintHit: false }), 'miss');
  assert.equal(toolbarPressDecision({ rowHit: false, quiet: false, footprintHit: true }), 'miss');
  assert.equal(toolbarPressDecision(), 'miss');
});

test('a footprint wake disposes live gestures before the rebuild', () => {
  const source = readFileSync(new URL('./spatial-toolbar.mjs', import.meta.url), 'utf8');
  const wake = source.slice(source.indexOf("if (decision === 'wake'"), source.indexOf('function select(event)'));
  const disposeAt = wake.indexOf('gestures.dispose()');
  const updateAt = wake.indexOf('update()');
  assert.ok(disposeAt >= 0, 'the wake branch never calls gestures.dispose()');
  assert.ok(updateAt >= 0, 'the wake branch never calls update()');
  assert.ok(disposeAt < updateAt, 'update() ran before gestures.dispose() on the wake path');
});

test('the independent chapter glass is targeted in its own forward-facing plane', async () => {
  const { hitToolbarGlass } = await import('./spatial-toolbar-wake.mjs');
  const panel = createToolbarPanel({ head:HEAD, rows:spatialToolbarRows({collapsed:true}),
    readout:[{text:'The chapter above the molecule',forwardView:true}],readoutPage:0 });
  const plate = panel.captionBacking;
  const ray = dx => ({ origin:[0,1.6,0], direction:plate.point.map((v,i)=>v-[0,1.6,0][i]+dx*plate.right[i]) });
  assert.equal(hitToolbarGlass(panel,ray(0)),true);
  assert.equal(hitToolbarGlass(panel,ray(plate.halfWidth+.1)),false);
});
