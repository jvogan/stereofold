import assert from 'node:assert/strict';
import test from 'node:test';

import { ENTRY_MENU_OUTBOARD_FACTORS, ENTRY_SUBJECT_LENS, entryMenuSeat, menuSeatClears } from './entry-menu-seat.mjs';
import { SPATIAL_TOOLBAR_LAYOUT, createToolbarPanel, toolbarDrawnMenuPoints, toolbarSeatBasis } from './spatial-toolbar-geometry.mjs';
import { PLATE_CLEARANCE_LENS, lensRectFromPoints, lensRectsOverlap } from './plate-standoff.mjs';
import { spatialToolbarRows } from './spatial-toolbar-content.mjs';

const HEAD = { position: { x: 0, y: 1.6, z: 0 }, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] };
const menuRows = count => Array.from({ length: count }, (_, index) => ({ label: `Control ${index}`, action: { index } }));
const COMPACT = menuRows(5);

/** Where a seat's menu column actually lands on the lens. */
function menuRect(constants, rows = COMPACT) {
  const basis = toolbarSeatBasis(HEAD);
  const panel = createToolbarPanel({ rows, head: HEAD, constants, readout: [], status: '' });
  return lensRectFromPoints({ points: toolbarDrawnMenuPoints(panel), origin: basis.origin, basis });
}

test('compact default seats actual glass left of the molecular framing band', () => {
  const rect = menuRect(SPATIAL_TOOLBAR_LAYOUT);
  assert.ok(rect.left > -1 && rect.right < 0, 'the complete column stays inside the left lens');
  const panel = createToolbarPanel({ rows: COMPACT, head: HEAD });
  assert.ok(Math.abs(Math.atan2(-panel.anchor[0], -panel.anchor[2]) * 180 / Math.PI - 26.915314027471144) < 1e-6);
});

test('entry seating preserves reading range and physical glyph size', () => {
  const seat = entryMenuSeat({ rows: COMPACT, head: HEAD, constants: SPATIAL_TOOLBAR_LAYOUT });
  const range = constants => Math.hypot(constants.forwardMeters, constants.rightMeters);
  assert.ok(Math.abs(range(seat.constants) - range(SPATIAL_TOOLBAR_LAYOUT)) < 1e-9);
  assert.equal(seat.constants.fontMeters, SPATIAL_TOOLBAR_LAYOUT.fontMeters);
  assert.equal(seat.factor, 1, 'the peripheral default needs no extra outboard rung');
});

test('inboard menu honestly reports overlap with a full entry band', () => {
  const seat = entryMenuSeat({ rows: COMPACT, head: HEAD, constants: SPATIAL_TOOLBAR_LAYOUT });
  assert.equal(seat.clear, false);
  assert.equal(lensRectsOverlap(seat.rect, seat.subject, PLATE_CLEARANCE_LENS), true);
});

test('entry menu keeps the wearer’s left side at every row count', () => {
  for (const rows of [COMPACT, menuRows(9), menuRows(15)]) {
    const seat = entryMenuSeat({ rows, head: HEAD, constants: SPATIAL_TOOLBAR_LAYOUT });
    assert.ok(seat.rect.right < 0);
    assert.ok(Math.sign(seat.constants.rightMeters) === Math.sign(SPATIAL_TOOLBAR_LAYOUT.rightMeters));
  }
});

test('the expanded entry grid stays whole on the lens with the real page controls', () => {
  // Two columns of real rows is the widest thing the entry seat is ever asked
  // to place. It cannot clear the framing band either, and the property that
  // matters is the one that survives: the grid is drawn whole, on the wearer's
  // own side, at the size it would have had at rest.
  for (const state of [{}, { voice: { state: 'idle' }, quality: 'balanced',
    passthrough: true, passthroughSupported: true }]) {
    const rows = spatialToolbarRows({ ...state, collapsed: false });
    assert.ok(rows.length > SPATIAL_TOOLBAR_LAYOUT.maxRows, 'exercise both columns');
    const seat = entryMenuSeat({ rows, head: HEAD, constants: SPATIAL_TOOLBAR_LAYOUT });
    const rect = menuRect(seat.constants, rows);
    const rest = menuRect(SPATIAL_TOOLBAR_LAYOUT, rows);
    assert.ok(rect.left > -1, 'the grid stays on the lens');
    assert.ok(rect.right < 0, 'the grid keeps the wearer’s own side');
    assert.ok(Math.abs((rect.right - rect.left) - (rest.right - rest.left)) < 1e-6,
      'the entry seat never shrinks the grid to fit');
  }
});

test('a seat that already clears the band pays nothing', () => {
  // A band the shipped seat is already outboard of: no rung is tried, no
  // bearing is spent, and the constants come back untouched.
  const seat = entryMenuSeat({ rows: COMPACT, head: HEAD,
    constants: SPATIAL_TOOLBAR_LAYOUT, subjectLens: 0.1 });
  assert.equal(seat.factor, 1);
  assert.equal(seat.clear, true);
  assert.equal(seat.constants, SPATIAL_TOOLBAR_LAYOUT);
});

test('a band nothing can clear is reported as uncleared, not as clear', () => {
  // A subject asking for the whole lens leaves no outboard room at all. The
  // honest answer is the furthest seat tried and `clear: false`, because a
  // record that claimed otherwise would send the next investigation looking at
  // the wrong thing.
  const seat = entryMenuSeat({ rows: COMPACT, head: HEAD, constants: SPATIAL_TOOLBAR_LAYOUT, subjectLens: 1 });
  assert.equal(seat.clear, false);
  assert.ok(seat.rect, 'a measured rectangle rides with the verdict');
});

test('a seat with no head, no rows or no constants is no answer', () => {
  assert.equal(entryMenuSeat({ rows: COMPACT, head: undefined, constants: SPATIAL_TOOLBAR_LAYOUT }), undefined);
  assert.equal(entryMenuSeat({ rows: [], head: HEAD, constants: SPATIAL_TOOLBAR_LAYOUT }), undefined);
  assert.equal(entryMenuSeat({ rows: COMPACT, head: HEAD, constants: undefined }), undefined);
  assert.equal(entryMenuSeat(), undefined);
});

test('missing stereo measurements keep the last readable rung', () => {
  const seat = entryMenuSeat({ rows: COMPACT, head: HEAD,
    constants: SPATIAL_TOOLBAR_LAYOUT, geometry: { views: [] } });
  assert.equal(seat.clear, false);
  assert.equal(seat.factor, ENTRY_MENU_OUTBOARD_FACTORS.at(-1));
  assert.equal(seat.measured, undefined);
});

// The full toolbar calls its production geometry provider and the shared
// plate-standoff measurement. The fixture supplies render vertices, never
// precomputed eye silhouettes or a scalar subject ceiling.
import { toolbarFrameRuntime, toolbarFrameHarness } from './fixtures/toolbar-frame-runtime.mjs';
import { entryGeometry } from './fixtures/entry-standoff.mjs';
import { measureEntryStandoff } from './entry-standoff.mjs';

test('production entry seating and its record use the same per-eye lit geometry', async () => {
  const runtime = await toolbarFrameRuntime();
  const records = [], geometry = entryGeometry();
  // Put the lit subject in the toolbar harness head's view, with enough
  // lateral extent to distinguish the measured geometry from the old ceiling.
  geometry.objects[0].values.aTransform.ref.value[13] = 1.6;
  for (const view of geometry.views) view.transform.inverse.matrix[13] = -1.6;
  const previous = globalThis.__stereofoldDiagnostics;
  globalThis.__stereofoldDiagnostics = { record: (kind, detail) => records.push({ kind, detail }) };
  const reads = [];
  const h = toolbarFrameHarness(runtime, { getEntryGeometry: options => { reads.push(options?.keyOnly === true); return geometry; } });
  try {
    await h.toolbar.update();
    assert.deepEqual(reads, [false, true], 'seat measurement gets full geometry; redraw signature requests only the proof key');
    const entries = records.filter(r => r.kind === 'plate-standoff' && r.detail.phase === 'entry');
    assert.equal(entries.length, 1, 'the clearance-key read does not seat or measure again');
    const entry = entries[0].detail;
    const measured = measureEntryStandoff({ ...geometry, menuPoints: h.toolbar.drawnMenuPoints() });
    assert.equal(entry.clearanceLeft, measured.clearanceLeft);
    assert.equal(entry.clearanceRight, measured.clearanceRight);
    assert.equal(entry.lit, true);
    assert.equal(entry.units, 'tangent');
    // Compact entry can clear the measured silhouette while the conservative
    // nominal band still cannot. Its receipt must describe the real glass.
    const nominal = entryMenuSeat({ rows: h.toolbar.rows(), head: h.toolbar.head(),
      constants: SPATIAL_TOOLBAR_LAYOUT });
    assert.equal(entry.frame.menu.clear, menuSeatClears(measured, geometry));
    assert.equal(entry.frame.menu.clear, true);
    assert.equal(nominal.clear, false);
    assert.ok(ENTRY_MENU_OUTBOARD_FACTORS.includes(entry.frame.menu.outboard));
    geometry.objects[0].values.dTransparency.ref.value = false;
    const whole = measureEntryStandoff({ ...geometry, menuPoints: h.toolbar.drawnMenuPoints() });
    assert.ok(whole.clearanceLeft < entry.clearanceLeft);
    assert.ok(whole.clearanceRight < entry.clearanceRight);
    await h.frames(72);
    assert.deepEqual(reads, [false, true], 'frame tracking does not recompute clearance');
  } finally {
    await h.toolbar.dispose();
    globalThis.__stereofoldDiagnostics = previous;
  }
});

test('production entry cannot certify a nominal band when stereo geometry is missing', () => {
  const seat = entryMenuSeat({ rows: COMPACT, head: HEAD, constants: SPATIAL_TOOLBAR_LAYOUT,
    geometry: { ...entryGeometry(), views: [] } });
  assert.equal(seat.clear, false);
  assert.equal(seat.measured, undefined);
});

test('a summoned menu seats all its glass clear of the committed subject in both eyes', async () => {
  const runtime = await toolbarFrameRuntime();
  const geometry = entryGeometry();
  geometry.objects[0].values.aTransform.ref.value[12] = .5;
  geometry.objects[0].values.aTransform.ref.value[13] = 1.6;
  for (const view of geometry.views) view.transform.inverse.matrix[13] = -1.6;
  const h = toolbarFrameHarness(runtime, { getEntryGeometry: () => geometry });
  try {
    await h.toolbar.update();
    h.toolbar.runAction({ kind: 'recenter-menu' });
    for (let i = 0; i < 200; i++) await Promise.resolve();
    const points = [...h.toolbar.drawnMenuPoints(), ...h.toolbar.captionPoints()];
    const measured = measureEntryStandoff({ ...geometry, menuPoints: points });
    assert.ok(measured.clearanceLeft > 0 && measured.clearanceRight > 0);
    const seat = entryMenuSeat({ rows: h.toolbar.rows(), head: h.toolbar.head(),
      constants: SPATIAL_TOOLBAR_LAYOUT, geometry });
    assert.equal(seat.clear, true);
    assert.equal(seat.factor, ENTRY_MENU_OUTBOARD_FACTORS[0]);
  } finally { await h.toolbar.dispose(); }
});

// The page's own producers, executed from their sources: viewer.mjs hands the
// immersive session `getEntryGeometry` (the committed render objects, camera
// scale and the placement pose's eye views and room transform), and the
// toolbar's `seatEntryMenu` measures through it when the entry seat latches.
// Nothing below re-implements either; a producer that moves, stops passing
// the geometry or stops recording the shared measurement fails here first.
import { entryProducerHarness } from './fixtures/entry-standoff.mjs';

test('production key-only provider preserves exact proof metadata without expanding unused envelope vertices', () => {
  const bounds = { center: [1, 2, 3], radius: 4, spheres: [
    { center: [1, 2, 3], radius: 2 },
    { center: [2, 3, 4], quad: [[1, 0, 0], [0, 1, 0]], sweep: .1, renderOffset: [0, 0, 1] },
  ] };
  const transform = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const h = entryProducerHarness({ chapterFieldBounds: () => bounds, presentationTransform: () => transform });
  const expand = h.page.framingEnvelopeObject; let expansions = 0;
  h.page.framingEnvelopeObject = (...args) => { expansions++; return expand(...args); };
  const before = h.getEntryGeometry();
  assert.equal(before.objects.length, 1); assert.ok(before.objects[0].values.aPosition.ref.value.length > 0);
  const key = h.getEntryGeometry({ keyOnly: true });
  assert.equal(key.clearanceKey, before.clearanceKey);
  assert.equal(key.cameraScale, before.cameraScale); assert.equal(key.views, before.views); assert.equal(key.renderFromRoom, before.renderFromRoom);
  assert.equal(key.objects.length, 0); assert.equal(expansions, 1);
  transform[12] = 2; bounds.spheres[0].radius = 3;
  const changedKey = h.getEntryGeometry({ keyOnly: true });
  assert.notEqual(changedKey.clearanceKey, key.clearanceKey);
  assert.equal(expansions, 1, 'metadata invalidation does not construct geometry');
  const after = h.getEntryGeometry();
  assert.equal(after.clearanceKey, changedKey.clearanceKey); assert.equal(expansions, 2);
  assert.equal(before.objects[0].values.aTransform.ref.value[12], 0, 'normal geometry remains an eager transform snapshot');
  assert.equal(after.objects[0].values.aTransform.ref.value[12], 2);
});
import { measureComponentLabels } from './component-label-measurement.mjs';
import { applyMatrix4 } from './room-lock.mjs';

test('the page entry producer records per-eye lit clearance that matches the drawn menu column', async () => {
  const runtime = await toolbarFrameRuntime();
  const geometry = entryGeometry();
  geometry.objects[0].values.aTransform.ref.value[13] = 1.6;
  for (const view of geometry.views) view.transform.inverse.matrix[13] = -1.6;
  // The production provider reads the committed representation and the
  // latest placement pose: the page's own objects, views and transform.
  const provider = entryProducerHarness({ geometry, head: HEAD }).getEntryGeometry;
  const provided = provider();
  assert.equal(provided.objects.length, 1);
  assert.equal(provided.objects[0], geometry.objects[0]);
  assert.equal(provided.views, geometry.views);
  assert.equal(provided.renderFromRoom, geometry.renderFromRoom);
  assert.equal(provided.cameraScale, 1);
  const records = [], previous = globalThis.__stereofoldDiagnostics;
  globalThis.__stereofoldDiagnostics = { record: (kind, detail) => records.push({ kind, detail }) };
  const h = toolbarFrameHarness(runtime, { getEntryGeometry: provider });
  try {
    // The full production toolbar seats its entry menu through that provider.
    await h.toolbar.update();
    const production = records.filter(r => r.kind === 'plate-standoff' && r.detail.phase === 'entry');
    assert.equal(production.length, 1, 'one entry measurement per seat');
    const entry = production[0].detail;
    // The strict producer, cut from spatial-toolbar.mjs and given the seat the
    // toolbar latched, writes the identical record.
    const seated = records.find(r => r.kind === 'toolbar' && r.detail.phase === 'standoff').detail.meters;
    const strict = entryProducerHarness({ geometry, head: h.toolbar.head(), rows: h.toolbar.rows(),
      tourReadout: runtime.tourReadout, getState: () => ({}), seatedStandoff: seated });
    const factor = strict.seat();
    assert.equal(strict.records.length, 1);
    // Ring records travel as JSON; the strict record was minted in a VM realm.
    assert.deepEqual(JSON.parse(JSON.stringify(strict.records[0])),
      JSON.parse(JSON.stringify({ kind: 'plate-standoff', detail: entry })));
    assert.equal(factor, entry.frame.menu.outboard);
    // Per eye, the record's silhouettes are the lit rectangle and the drawn
    // column measured independently here, and its clearance is their gap.
    const values = geometry.objects[0].values;
    const vertices = groups => values.aGroup.ref.value.flatMap((group, index) => (groups.includes(group)
      ? [applyMatrix4(values.aPosition.ref.value.slice(index * 3, index * 3 + 3), values.aTransform.ref.value)] : []));
    const menuPoints = h.toolbar.drawnMenuPoints().map(point => applyMatrix4(point, geometry.renderFromRoom));
    const eyesOf = points => measureComponentLabels({ views: geometry.views, subject: { points } });
    const lit = eyesOf(vertices([0])), column = eyesOf(menuPoints), whole = eyesOf(vertices([0, 1]));
    assert.ok(Array.isArray(entry.eyes), 'the entry record carries per-eye silhouettes');
    assert.equal(entry.eyes.length, 2);
    for (const eye of ['left', 'right']) {
      const recorded = entry.eyes.find(e => e.eye === eye);
      const subject = lit.find(e => e.eye === eye).silhouette, menu = column.find(e => e.eye === eye).silhouette;
      assert.equal(recorded.lit, true);
      for (const [key, value] of [['subjectX', subject[0]], ['subjectY', subject[1]],
        ['subjectHalfWidth', subject[2]], ['subjectHalfHeight', subject[3]], ['menuX', menu[0]],
        ['menuY', menu[1]], ['menuHalfWidth', menu[2]], ['menuHalfHeight', menu[3]]]) {
        assert.ok(Math.abs(recorded[key] - value) <= 5e-5, `${eye} ${key}: ${recorded[key]} vs ${value}`);
      }
      assert.ok(recorded.subjectHalfWidth > 0 && recorded.menuHalfWidth > 0);
      const gap = Math.abs(subject[0] - menu[0]) - subject[2] - menu[2];
      assert.ok(Math.abs(recorded.clearance - gap) <= 1e-4, `${eye} clearance ${recorded.clearance} vs ${gap}`);
      const fromRecord = Math.abs(recorded.subjectX - recorded.menuX) - recorded.subjectHalfWidth - recorded.menuHalfWidth;
      assert.ok(Math.abs(recorded.clearance - fromRecord) <= 3e-4, `${eye}: the record is consistent with itself`);
      const faded = whole.find(e => e.eye === eye).silhouette;
      assert.ok(Math.abs(faded[0] - menu[0]) - faded[2] - menu[2] < gap - 1e-3,
        `${eye}: the faded fringe would have cut the clearance, so the lit filter was applied`);
    }
    assert.equal(entry.clearanceLeft, entry.eyes[0].clearance);
    assert.equal(entry.clearanceRight, entry.eyes[1].clearance);
    assert.equal(entry.lit, true);
    assert.equal(entry.units, 'tangent');
    // `clear` is not "is there any gap", it is "is the gap the plate margin".
    // Since the entry rung stopped buying its clearance by pushing the column
    // three metres away (`toolbarLayoutForOutboard`), a full-size column can
    // end up with a real but insufficient gap, and the record says so.
    const margin = eye => PLATE_CLEARANCE_LENS
      / Math.abs(geometry.views.find(view => view.eye === eye).projectionMatrix[0]);
    assert.equal(entry.frame.menu.clear,
      entry.clearanceLeft > margin('left') && entry.clearanceRight > margin('right'));
  } finally {
    await h.toolbar.dispose();
    globalThis.__stereofoldDiagnostics = previous;
  }
});
