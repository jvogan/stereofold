import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { pageFunction } from './fixtures/label-action-harness.mjs';
import { toolbarFrameRuntime, toolbarFrameHarness } from './fixtures/toolbar-frame-runtime.mjs';
import { resetViewPlacement } from './reset-view-placement.mjs';
import { resetEntryLateralTravel } from './reset-entry-geometry.mjs';
import { journeySeatDetail } from './journey-seat-record.mjs';
import { measureEntryStandoff } from './entry-standoff.mjs';
import { menuSeatClears } from './entry-menu-seat.mjs';
import { identity, syntheticViews } from './fixtures/component-label-diagnostics.mjs';
import { applyMatrix4, invertMatrix4 } from './room-lock.mjs';
import { SUBJECT_SHIFT_LIMIT, lensTangent } from './plate-standoff.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/device-standoff.json', import.meta.url)));
const cell = value => ({ ref: { value } });
const matrixFor = seat => {
  const m = identity(); m[0] = m[5] = m[10] = seat.scale;
  m.splice(12, 3, ...seat.translation); return m;
};

// Automatic entry uses the available field before shrinking. Saved-seat
// recovery still uses the narrower .135 centre band checked below.
function assertAutomaticSeat(measured, geometry, requireClear = true) {
  if (requireClear) assert.equal(measured.frame.menu.clear, true);
  for (const eye of measured.eyes) {
    assert.ok(eye.clearance > 0);
    assert.ok(Math.abs(eye.subjectX) + eye.subjectHalfWidth <= lensTangent(SUBJECT_SHIFT_LIMIT) + .0001,
      'the whole subject remains inside the horizontal lens bound');
  }
  if (!geometry) return;
  // Project every synthetic box vertex independently of the fit solver.
  for (const object of geometry.objects) {
    const positions = object.values.aPosition.ref.value;
    const transform = object.values.aTransform.ref.value;
    for (let index = 0; index < positions.length; index += 3) {
      const rendered = applyMatrix4(positions.slice(index, index + 3), transform).map(value => value * geometry.cameraScale);
      for (const view of geometry.views) {
        const eye = applyMatrix4(rendered, view.transform.inverse.matrix);
        assert.ok(eye[2] < 0, 'every vertex remains in front of both eyes');
        const projected = applyMatrix4(eye, view.projectionMatrix);
        assert.ok(Math.abs(projected[0]) <= SUBJECT_SHIFT_LIMIT + 1e-9);
        assert.ok(Math.abs(projected[1]) <= 1 + 1e-9);
        assert.ok(Math.abs(projected[2]) <= 1 + 1e-9, 'every vertex remains within near/far clipping');
      }
    }
  }
}

// Reconstruct each extremal edge from the recorded eye tangents. This is a
// synthetic box, not a recovered hemoglobin mesh or historical eye transform.
function stereoBox(eyes, prefix) {
  const [left, right] = eyes;
  return [-1, 1].flatMap(sign => {
    const l = left[`${prefix}X`] + sign * left[`${prefix}HalfWidth`];
    const r = right[`${prefix}X`] + sign * right[`${prefix}HalfWidth`];
    const z = .064 / (l - r), x = l * z - .032;
    return [-1, 1].map(y => [x, z * (left[`${prefix}Y`] + y * left[`${prefix}HalfHeight`]), -z]);
  });
}

function recordedSeat(row, phase) {
  const record = row.records[phase].detail, seat = row.donePlacement;
  const cameraScale = row.metersAcross / (2 * seat.scale);
  const points = stereoBox(record.eyes, 'menu'), subject = stereoBox(record.eyes, 'subject');
  // Use the saved translation in scene coordinates and map its anchor to the
  // reconstructed silhouette centre. The state exports no room transform.
  const anchor = [0, 1, 2].map(i => subject.reduce((sum, p) => sum + p[i], 0) / subject.length);
  const renderFromRoom = identity();
  renderFromRoom.splice(12, 3, ...anchor.map((v, i) => seat.translation[i] * cameraScale - v));
  const local = subject.map(p => applyMatrix4(applyMatrix4(p, renderFromRoom).map(v => v / cameraScale), invertMatrix4(matrixFor(seat))));
  const views = syntheticViews().map(view => {
    const m = [...view.transform.matrix];
    for (let i = 0; i < 3; i++) m[12 + i] += renderFromRoom[12 + i];
    return { ...view, transform: { matrix: m, inverse: { matrix: invertMatrix4(m) } } };
  });
  const objects = placement => [{ type: 'mesh', state: { visible: true }, values: {
    drawCount: cell(6), instanceCount: cell(1), aPosition: cell(local.flat()), aTransform: cell(matrixFor(placement)),
  } }];
  const geometry = { objects: objects(seat), fromPlacement: matrixFor(seat), toPlacement: matrixFor(seat), views };
  const options = { seat, points, geometry, cameraScale, center: [0, 0, 0], radius: 1,
    headInRoom: identity(), renderFromRoom, bounded: true, fit: true };
  const measure = placement => measureEntryStandoff({ objects: objects(placement), cameraScale, views,
    menuPoints: points, renderFromRoom });
  return { options, measure, record, row, objects };
}

const viewer = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');

test('preserving a saved gap still rejects contact, an off-centre subject and clipped geometry', () => {
  const subject = [-.05, .05].flatMap(x => [-.1, .1].map(y => ({ center: [x, y, -1], radius: 0 })));
  const geometry = { subject, views: syntheticViews(), renderFromRoom: identity() };
  const check = (gap, geometryOverride = geometry) => resetEntryLateralTravel({ geometry: geometryOverride,
    points: [-.4, -.05 - gap].flatMap(x => [-.3, .3].map(y => [x, y, -1])), right: [1, 0, 0], clearance: 0 });
  assert.equal(check(.005), 0, 'an existing positive gap needs no extra margin');
  assert.equal(check(0), Infinity, 'contact must use the clearance adjustment');
  assert.notEqual(check(.005, { ...geometry, subject: subject.map(s => ({ ...s, center: [s.center[0] + .2, ...s.center.slice(1)] })) }), 0);
  assert.equal(check(.005, { ...geometry, subject: subject.map(s => ({ ...s, center: [s.center[0], s.center[1], -101] })) }), Infinity);
});

// A device run recorded scale 1.0180534 and x=-0.7552 before the tour,
// then scale .4543570 after Done; row 3 ended at .4172. The report contains
// no mesh/eye matrices. These synthetic vertices test the restoration rule,
// with the recorded scale/x and explicitly synthetic y/z and room mapping.
for (const endingScale of [.4543570, .4172]) {
  for (const overlap of [false, true]) test(`Done restores scale ${endingScale}, menu overlap ${overlap}`, async () => {
    const saved = { translation: [-.7552, 0, overlap ? -3.8 : -4], rotation: [0, 0, 0], scale: 1.0180534 };
    let placement = { ...saved, translation: [-.7108, -.1237, -.8942], scale: endingScale };
    const halfWidth = overlap ? .45 : .8;
    const local = [-halfWidth, halfWidth].flatMap(x => [-.1, .1].flatMap(y => [-.02, .02].map(z => [x, y, z])));
    const renderFromRoom = identity(); renderFromRoom[12] = saved.translation[0] - (overlap ? .32 : .46);
    const views = syntheticViews().map(view => {
      const m = [...view.transform.matrix]; m[12] += renderFromRoom[12];
      return { ...view, transform: { matrix: m, inverse: { matrix: invertMatrix4(m) } } };
    });
    // The saved view has a positive gap in both eyes, less than the fit's
    // additional one-degree margin. That margin must not shrink a restoration.
    // The overlap control needs a small sideways correction at the same size.
    const points = (overlap ? [-.4, -.05] : [-1.8, -.345]).flatMap(x => [-.3, .3].map(y => [x, y, overlap ? -1 : -3.8]));
    const objects = () => [{ type: 'mesh', state: { visible: true }, values: {
      drawCount: cell(36), instanceCount: cell(1), aPosition: cell(local.flat()), aTransform: cell(matrixFor(placement)),
    } }];
    const measure = () => measureEntryStandoff({ objects: objects(), views, cameraScale: 1,
      menuPoints: points, renderFromRoom });
    const moves = [], roomEntry = {};
    const h = vm.createContext({ structuredClone, Mat4, applyMatrix4, resetViewPlacement, cameraSnapshot: v => v,
      roomEntry, entryRoomPoint: null, canvas: { xr: { isPresenting: { value: true } }, camera: { scale: 1 } },
      latestRoomPlacementPose: { headInRoom: identity(), renderFromRoom, labelViews: views },
      loadedSphere: () => ({ center: [0, 0, 0], radius: 1 }), inspectionSnapshot: () => ({ placement }),
      presentationTransform: () => matrixFor(placement), placementTransform: matrixFor,
      scientificRepresentations: () => [{ renderObjects: objects() }],
      immersiveSession: { platePoints: () => points, toolbarPlacementPoints: () => points },
      placeInspection: async patch => { placement = { ...placement, ...patch }; moves.push(patch); },
      restoreTourSeat: async () => { assert.equal(measure().frame.menu.clear, true); },
      seatStructureForEntry: async () => assert.fail('the saved view must be restored'),
    });
    h.journeySeatDetail = journeySeatDetail;
    for (const name of ['restoreJourneySeat', 'recordJourneySeat']) vm.runInContext(pageFunction(viewer, name), h);
    // The host/player restore the saved scene before the viewer checks clearance.
    placement = structuredClone(saved);
    const result = await h.restoreJourneySeat({ scene: { camera: {}, inspection: { placement: saved } } });
    assert.ok(Math.abs(placement.scale - saved.scale) < .001, 'Done must retain the pre-tour size');
    assert.deepEqual(placement.rotation, saved.rotation);
    assert.deepEqual(roomEntry.seat, saved, 'Reset retains the original saved target');
    assert.equal(measure().frame.menu.clear, true);
    if (!overlap) {
      assert.deepEqual(placement, saved, 'a clear saved placement is restored exactly');
      assert.equal(moves.length, 0);
      assert.equal(result.placementRestored, true);
    } else {
      assert.equal(moves.length, 1);
      assert.ok(Math.abs(placement.translation[0] - saved.translation[0]) < .15, 'only a small lateral adjustment is needed');
      assert.deepEqual(placement.translation.slice(1), saved.translation.slice(1));
      assert.ok(measure().eyes.every(eye => eye.clearance > 0 && Math.abs(eye.subjectX) <= .135));
      assert.equal(result.placementRestored, false);
    }
  });
}

for (const row of fixture.rows) test(`row ${row.row} viewer fits entry and Done from the saved pre-tour placement`, async () => {
  const { options, measure, objects } = recordedSeat(row, 'tour-end');
  let placement = structuredClone(row.preTourPlacement);
  const roomEntry = {}, renders = [];
  const h = vm.createContext({
    structuredClone, Mat4, Vec3, applyMatrix4, resetViewPlacement, cameraSnapshot: v => v,
    roomEntry, canvas: { xr: { isPresenting: { value: true } }, webgl: {}, camera: { scale: options.cameraScale } },
    latestRoomPlacementPose: { headInRoom: options.headInRoom, renderFromRoom: options.renderFromRoom, labelViews: options.geometry.views },
    loadedSphere: () => ({ center: options.center, radius: options.radius }),
    inspectionSnapshot: () => ({ placement }),
    presentationTransform: () => matrixFor(placement), placementTransform: matrixFor,
    scientificRepresentations: () => [{ renderObjects: objects(placement) }],
    immersiveSession: { platePoints: () => [], toolbarPlacementPoints: () => options.points },
    placeInspection: async patch => { placement = { ...placement, ...patch }; renders.push(structuredClone(placement)); },
    restoreTourSeat: async () => {
      assert.equal(measure(placement).frame.menu.clear, true, 'the upcoming resting glass clears before its render');
      assert.equal(roomEntry.seat, undefined, 'no Reset target until that render returns');
    },
    seatStructureForEntry: async () => assert.fail('a saved pose must use the shared size fit'),
    emphasisState: { parts: [] }, componentLabelsWanted: () => false,
    componentLabelViewBasis: () => ({}),
    placementFromRoom: () => ({ ...row.preTourPlacement, rotation: undefined }),
    structureAtomSites: () => 0, sessionDeviceClass: () => 'quest2', plugin: {},
    latestSeatStandoffMeters: null, latestPlateSeat: null, entryRoomPoint: null,
  });
  vm.runInContext(pageFunction(viewer, 'roomAnchorPlacement'), h);
  const entry = h.roomAnchorPlacement({ mode: 'auto', sphere: h.loadedSphere() });
  assertAutomaticSeat(measure(entry), { objects: objects(entry), views: options.geometry.views, cameraScale: options.cameraScale });
  assert.equal(entry.scale, row.preTourPlacement.scale, 'automatic entry keeps the requested size when free field fits');
  h.journeySeatDetail = journeySeatDetail;
  for (const name of ['restoreJourneySeat', 'recordJourneySeat']) vm.runInContext(pageFunction(viewer, name), h);
  await h.restoreJourneySeat({ scene: { camera: {} } });
  assert.ok(renders.length > 0);
  assert.ok(measure(placement).eyes.every(eye => eye.clearance > 0 && Math.abs(eye.subjectX) <= .135));
  assert.deepEqual(roomEntry.seat, row.preTourPlacement);
});

test('the toolbar preview clears the restored caption and emits clear entry and tour-end records', async () => {
  const runtime = await toolbarFrameRuntime(), records = [];
  let placement = { translation: [0, 1.8, -3], scale: 1.98, rotation: [0, 0, 0] };
  const local = [-.6, .6].flatMap(x => [-.5, .5].flatMap(y => [-.1, .1].map(z => [x, y, z])));
  const objects = () => [{ type: 'mesh', state: { visible: true }, values: {
    drawCount: cell(36), aPosition: cell(local.flat()), aTransform: cell(matrixFor(placement)), instanceCount: cell(1),
  } }];
  const views = syntheticViews().map(v => {
    v.transform.matrix[13] = 1.6; v.transform.inverse.matrix[13] = -1.6; return v;
  });
  const headInRoom = identity(); headInRoom[13] = 1.6;
  const geometry = () => ({ objects: objects(), views, cameraScale: 1, renderFromRoom: identity() });
  const h = toolbarFrameHarness(runtime, { getEntryGeometry: geometry,
    state: { subject: { title: 'Hemoglobin tetramer', pdbId: '4HHB', chains: 4, representation: 'cartoon', color: 'chain-id' } } });
  const prior = globalThis.__stereofoldDiagnostics;
  globalThis.__stereofoldDiagnostics = { record: (kind, detail) => records.push({ kind, detail }) };
  const fit = restoreTourSeat => {
    const points = h.toolbar.placementPoints({ headInRoom, restoreTourSeat });
    const fitted = resetViewPlacement({ seat: placement, fit: true, bounded: true, restoreSaved: restoreTourSeat, points,
      headInRoom, renderFromRoom: identity(), center: [0, 0, 0], radius: 1, cameraScale: 1,
      geometry: { ...geometry(), fromPlacement: matrixFor(placement), toPlacement: matrixFor(placement) } });
    placement = fitted;
  };
  try {
    fit(false); await h.toolbar.update();
    assert.equal(placement.scale, 1.98, 'automatic entry uses free field before shrinking');
    assertAutomaticSeat(measureEntryStandoff({ ...geometry(), menuPoints: [...h.toolbar.drawnMenuPoints(), ...h.toolbar.captionPoints()] }), geometry());
    h.setState({ tour: { active: true, step: 1, title: 'A chapter', progress: 'Scene 2 / 20' } });
    await h.toolbar.update();
    h.setState({ subject: { title: 'Human deoxyhaemoglobin', pdbId: '4HHB', chains: 4, representation: 'cartoon', color: 'element-symbol' },
      tour: { active: false, step: -1, feedback: 'Back at the start' } });
    placement = { translation: [0, 1.8, -3], scale: 1.98, rotation: [0, 0, 0] };
    fit(true); await h.toolbar.update({ restoreTourSeat: true });
    for (const points of [h.toolbar.drawnMenuPoints(), h.toolbar.captionPoints()]) {
      const measured = measureEntryStandoff({ ...geometry(), menuPoints: points });
      assert.ok(measured.eyes.every(eye => eye.clearance > 0 && Math.abs(eye.subjectX) <= .135));
    }
    const standoffs = records.filter(r => r.kind === 'plate-standoff');
    for (const phase of ['entry', 'tour-end']) assert.ok(standoffs.some(r => r.detail.phase === phase));
    for (const { detail } of standoffs) {
      if (detail.frame?.menu) assert.equal(detail.frame.menu.clear, menuSeatClears(detail, geometry()),
        `${detail.phase} reports whether the measured margin clears`);
      // The diagnostic's clear flag requires the configured extra margin;
      // positive separation and whole-subject visibility remain required.
      if (detail.phase === 'entry') assertAutomaticSeat(detail, undefined, false);
      if (detail.phase === 'tour-end')
        assert.ok(detail.eyes.every(eye => eye.clearance > 0 && Math.abs(eye.subjectX) <= .135));
    }
    const count = standoffs.length;
    await h.frames(72);
    assert.equal(records.filter(r => r.kind === 'plate-standoff').length, count, 'steady frames do not re-seat');
  } finally { await h.toolbar.dispose(); globalThis.__stereofoldDiagnostics = prior; }
});

for (const row of fixture.rows) for (const phase of ['entry', 'tour-end']) {
  test(`row ${row.row} ${phase} clears both eyes within the applicable lens bounds`, () => {
    const { options, measure, record, objects } = recordedSeat(row, phase);
    const before = measure(options.seat);
    for (const key of ['clearanceLeft', 'clearanceRight']) assert.ok(Math.abs(before[key] - record[key]) <= .0001);
    for (let i = 0; i < 2; i++) assert.equal(before.eyes[i].subjectX, record.eyes[i].subjectX);
    const result = resetViewPlacement({ ...options, restoreSaved: phase === 'tour-end' });
    assert.ok(result, 'an overlapping in-band pose must shrink or move deeper, never be retained');
    const after = measure(result);
    assert.equal(after.frame.menu.clear, true);
    assert.ok(after.clearanceLeft > 0 && after.clearanceRight > 0);
    if (phase === 'tour-end') assert.ok(after.eyes.every(eye => Math.abs(eye.subjectX) <= .135));
    else {
      assertAutomaticSeat(after, { objects: objects(result), views: options.geometry.views, cameraScale: options.cameraScale });
      assert.equal(result.scale, options.seat.scale, 'automatic entry keeps size when the free field fits');
    }
    assert.ok(result.standoffMeters <= 4);
    assert.deepEqual(result.rotation, options.seat.rotation);
    assert.ok(result.scale < options.seat.scale || result.standoffMeters > 3);
    console.log('standoff fixture', JSON.stringify({ row: row.row, phase, before, after, placement: result }));
  });
  test(`row ${row.row} ${phase} Reset after Done can shrink the restored size`, () => {
    const { options, measure } = recordedSeat(row, phase);
    const result = resetViewPlacement({ ...options, centered: true });
    assert.ok(measure(result).eyes.every(eye => eye.clearance > 0 && Math.abs(eye.subjectX) <= .135));
    assert.notDeepEqual(result.translation, options.seat.translation);
  });
}

test('Done checks the held menu geometry and preserves the recorded clear placement twice', async () => {
  const { deviceDoneClearance, devicePlacement } = await import('./fixtures/device-done-clearance.mjs');
  let placement = structuredClone(devicePlacement);
  const h = await deviceDoneClearance({ runtime: await toolbarFrameRuntime(),
    getPlacement: () => placement, setPlacement: value => { placement = value; } });
  try {
    // Seat the larger current menu left of the synthetic subject; the old
    // 20 cm offset no longer provides this test's clear starting gap.
    await h.moveChapterMenu(-.4);
    assert.ok(h.measure().eyes.every(eye => eye.clearance > .1), 'both eyes have a large measured gap before the tour');
    for (let pass = 0; pass < 2; pass++) {
      await h.chapter(2); await h.chapter(3); await h.chapter(4);
      const outcome = await h.restore({ camera: {}, inspection: { placement: devicePlacement } });
      assert.deepEqual(placement, devicePlacement, 'Done must not fit against an undrawn nominal menu');
      assert.equal(outcome.placementRestored, true);
      assert.deepEqual(h.roomEntry.seat, devicePlacement);
      assert.ok(h.measure().eyes.every(eye => eye.clearance > .1));
    }
    assert.equal(h.moves.length, 0);
  } finally { await h.dispose(); }
});

// Keep this measured overlap fixture at its historical forward menu seat.
test('the current peripheral menu preserves a saved clear view through Done', async () => {
  const { deviceDoneClearance, devicePlacement } = await import('./fixtures/device-done-clearance.mjs');
  let placement = structuredClone(devicePlacement);
  const h = await deviceDoneClearance({ runtime: await toolbarFrameRuntime(),
    getPlacement: () => placement, setPlacement: value => { placement = value; } });
  try {
    const anchor = h.seatAnchor();
    await h.chapter(4);
    await h.restore({ camera: {}, inspection: { placement: devicePlacement } });
    assert.ok(h.measure().eyes.every(eye => eye.clearance > 0),
      'the current menu and restored subject clear in both eyes');
    assert.deepEqual(h.seatAnchor(), anchor, 'the world seat remains fixed');
    assert.deepEqual(placement, devicePlacement, 'a clear saved view is not moved');
    assert.deepEqual(h.moves, []);
  } finally { await h.dispose(); }
});

test('Done clears completed glass at the held chapter anchor', async () => {
  const { deviceDoneClearance, devicePlacement } = await import('./fixtures/device-done-clearance.mjs');
  let placement = structuredClone(devicePlacement);
  const h = await deviceDoneClearance({ runtime: await toolbarFrameRuntime(undefined, { peripheralSeat: false }),
    getPlacement: () => placement, setPlacement: value => { placement = value; } });
  try {
    // Seat the larger current menu left of the synthetic subject; the old
    // 20 cm offset no longer provides this test's clear starting gap.
    await h.moveChapterMenu(-.4);
    assert.ok(h.measure().eyes.every(eye => eye.clearance > .1));
    for (let pass = 0; pass < 2; pass++) {
      placement = structuredClone(devicePlacement);
      await h.chapter(4); await h.moveChapterMenu(.13);
      assert.ok(h.measure().eyes.some(eye => eye.clearance < 0), 'the outgoing chapter glass crosses the saved view');
      const heldAnchor = h.seatAnchor();
      const result = await h.restore({ camera: {}, inspection: { placement: devicePlacement } });
      assert.deepEqual(h.seatAnchor(), heldAnchor, 'Done keeps the wearer-moved room anchor');
      assert.equal(result.placementRestored, false, 'the saved view needed clearance at the held anchor');
      assert.ok(h.measure().eyes.every(eye => eye.clearance > 0),
        'the completed glass and subject do not overlap in either eye');
      assert.deepEqual(h.roomEntry.seat, devicePlacement, 'Reset keeps the saved view as its target');
    }
    assert.ok(h.moves.length > 0, 'the molecule clears the held anchor');
  } finally { await h.dispose(); }
});
