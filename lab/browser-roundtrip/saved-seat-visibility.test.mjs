/**
 * A saved seat kept by the head-centred reading must
 * still be a seat the wearer can see.
 *
 * `reset-view-placement.mjs` keeps a saved seat when either of two readings
 * passes. The first, `resetEntryLateralTravel(... clearance: 0) === 0`, clips
 * against both eyes' actual frusta before it answers. The second, added by an earlier run
 * for that defect, asks only whether the subject is off one side of the drawn
 * glass in both eyes and whether its head-centred silhouette is inside the
 * seating band. Neither of those questions is about visibility, and both are
 * equally true of a subject nobody can see.
 *
 * The three seats below are separated and inside the band, and each sits
 * wholly outside one plane of the frustum: nearer than the near plane, beyond
 * the far plane, above the field. Before the fix each was handed back
 * untouched. The fourth is cropped by the same top plane but mostly visible;
 * the first reading refuses it too, and the second reading must go on keeping
 * it, because cropping a molecule the wearer seated is their choice.
 *
 * The seats are built with the same helpers, the same synthetic eyes and the
 * same device-session scalars as `journey-seat-device-record.test.mjs`, so the
 * device record's own seat can be measured here beside them. The current menu
 * has a farther seat, so the edge-relative box below is now clear of the
 * completed glass and can stay where the wearer left it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { toolbarFrameRuntime, toolbarFrameHarness } from './fixtures/toolbar-frame-runtime.mjs';
import { identity, syntheticViews } from './fixtures/component-label-diagnostics.mjs';
import { applyMatrix4, invertMatrix4 } from './room-lock.mjs';
import { tangentRectsForPoints } from './journey-seat-record.mjs';
import { resetViewPlacement } from './reset-view-placement.mjs';
import { resetEntryGeometry, resetEntryLateralTravel, resetEntryLateralBreakdown,
  subjectVisibleInEyes } from './reset-entry-geometry.mjs';

/** The recorded entry seat and its scalars, as the device record test reads them. */
const P0 = { translation: [0.5570736303043923, 0.4572858597174322, -1.8299245299547606],
  rotation: [0, 0, 0], scale: 0.9336008197641015 };
const CAMERA_SCALE = 0.0235, RADIUS = 38.6683;
/** The band `focus-placement.mjs` seats against, rounded as the solver rounds it. */
const BAND = 0.135;
/** `syntheticViews`: 42 degrees horizontal, 45 vertical, near 0.01 m, far 100 m. */
const NEAR = 0.01, FAR = 100, VERTICAL_TANGENT = 1;

const subject = { title: 'Human deoxyhaemoglobin', pdbId: '4HHB', chains: 4, assembly: 'asymmetric unit',
  representation: 'cartoon', color: 'chain-id' };
const restingState = { subject, voice: { state: 'idle' }, passthrough: true, passthroughSupported: true,
  renderQuality: 'balanced', sequence: { open: false, available: true, binding: 'b', version: 1 } };
/** The last chapter mid-restore: the panel whose third column started the defect. */
const restoringChapter = { active: true, navigating: true, autoplay: false, canBack: false, canNext: false,
  menuOpen: false, selectedId: 'haemoglobin', selectedTitle: 'Haemoglobin', step: 4, total: 5,
  title: 'The haem pocket', progress: 'Scene 5 / 5', bodyPageIndex: 1, bodyPageCount: 3,
  bodyPage: 'The iron at the centre of each haem group is where oxygen binds.',
  feedback: 'Restoring your view…' };

const views = syntheticViews().map(view => {
  view.transform.matrix[13] = 1.6; view.transform.inverse.matrix[13] = -1.6; return view;
});
const headInRoom = (() => { const m = identity(); m[13] = 1.6; return m; })();
const cell = value => ({ ref: { value } });
const matrixFor = seat => { const m = identity(); m[0] = m[5] = m[10] = seat.scale;
  m.splice(12, 3, ...seat.translation); return m; };

/**
 * A box in room metres whose LEFT-eye silhouette spans [x0,x1] by [y0,y1] in
 * tangent, at `depth` metres. `halfDepth` is the box's own depth: the device
 * record test's 0.02 m, or less where the whole box has to fit between the eye
 * and a 0.01 m near plane.
 */
const worldBox = (x0, x1, y0, y1, depth, halfDepth = 0.02) =>
  [0, 1].flatMap(i => [0, 1].flatMap(j => [-halfDepth, halfDepth].map(dz => {
    const z = depth + dz;
    return [(i ? x1 : x0) * z - 0.032, (j ? y1 : y0) * z + 1.6, -z];
  })));
/** The same box as a mesh the solver reads, in the scene units P0 is written in. */
function savedSubject(world) {
  const local = world.map(point => applyMatrix4(point.map(v => v / CAMERA_SCALE), invertMatrix4(matrixFor(P0))));
  const objects = [{ type: 'mesh', state: { visible: true }, values: {
    drawCount: cell(6), instanceCount: cell(1), aPosition: cell(local.flat()), aTransform: cell(matrixFor(P0)) } }];
  const centre = [0, 1, 2].map(axis => world.reduce((sum, point) => sum + point[axis], 0) / world.length);
  return { objects, geometry: { objects, fromPlacement: matrixFor(P0), toPlacement: matrixFor(P0), views },
    center: centre.map((v, axis) => v / CAMERA_SCALE - P0.translation[axis] * RADIUS) };
}
/** What Done did with the seat: kept it, moved it, or refused to seat it at all. */
function savedSeatOutcome(saved, points) {
  try {
    const placement = resetViewPlacement({ seat: P0, bounded: true, fit: true, restoreSaved: true,
      geometry: saved.geometry, points, headInRoom, renderFromRoom: identity(),
      cameraScale: CAMERA_SCALE, center: saved.center, radius: RADIUS });
    return { kept: placement === P0, placement };
  } catch (error) { return { kept: false, refusal: error.message }; }
}

test('explicit overhead placement keeps a menu-clear subject outside the current gaze', () => {
  const saved = savedSubject(worldBox(-.1, .1, 1.2, 1.4, 3));
  const options = { seat: P0, fit: true, allowOffscreen: true, geometry: saved.geometry,
    points: [[-.2, 1.4, -1], [.2, 1.8, -1]], headInRoom, renderFromRoom: identity(),
    cameraScale: CAMERA_SCALE, center: saved.center, radius: RADIUS };
  assert.equal(readings(saved, options.points).visible, false);
  assert.equal(resetViewPlacement(options), P0);
});

test('explicit room placement still refuses geometry that covers the menu', () => {
  const saved = savedSubject(worldBox(-.5, .5, -.5, .5, 3));
  assert.throws(() => resetViewPlacement({ seat: P0, fit: true, allowOffscreen: true,
    geometry: saved.geometry, points: [[-.2, 1.4, -1], [.2, 1.8, -1]], headInRoom,
    renderFromRoom: identity(), cameraScale: CAMERA_SCALE, center: saved.center, radius: RADIUS }), /cover the menu/);
});
/** The two readings that decide it, plus the head-centred band the second uses. */
function readings(saved, points) {
  const rendered = resetEntryGeometry({ ...saved.geometry, cameraScale: CAMERA_SCALE, renderFromRoom: identity() });
  return { rendered,
    travel: resetEntryLateralTravel({ geometry: rendered, points, right: [1, 0, 0], clearance: 0 }),
    separated: resetEntryLateralBreakdown({ geometry: rendered, points, clearance: 0 })?.separated,
    visible: subjectVisibleInEyes(rendered) };
}
/** Per-eye silhouette centres, and the head reading that is their mean. */
const headTangent = world => {
  const centres = views.map(view => {
    const xs = world.map(point => { const p = applyMatrix4(point, view.transform.inverse.matrix); return p[0] / -p[2]; });
    return (Math.min(...xs) + Math.max(...xs)) / 2;
  });
  return (centres[0] + centres[1]) / 2;
};

/** The completed menu the wearer is left with, and the restoring chapter plate. */
async function panels() {
  const h = toolbarFrameHarness(await toolbarFrameRuntime(), { state: restingState });
  await h.toolbar.update();
  h.setState({ ...restingState, tour: restoringChapter });
  await h.toolbar.update();
  const completed = h.toolbar.placementPreview({ headInRoom, restoreTourSeat: true });
  const plate = h.toolbar.platePoints();
  return { h, points: completed.points, plate,
    plateRight: tangentRectsForPoints({ views, renderFromRoom: identity(), points: plate })[0].right };
}

/**
 * Three seats the wearer cannot see. Each is off one side of the glass in both
 * eyes and inside the band, so an earlier run’s reading accepted all three, and each lies
 * wholly outside one plane of the frustum.
 *
 * The near-plane seat straddles the head 6 mm out, closer than the 0.01 m near
 * plane. Each eye sees it hard over on its own side, which is why the mean of
 * the two lands back inside the band: the head reading cannot tell a subject
 * centred in front of the wearer from one pressed against the bridge of the
 * nose.
 */
const BLIND = [
  { name: 'wholly nearer than the near plane', plane: `${NEAR} m near plane`,
    world: worldBox(5.283, 5.383, -0.05, 0.05, 0.006, 1e-5) },
  { name: 'wholly beyond the far plane', plane: `${FAR} m far plane`,
    world: worldBox(0.05, 0.2, -0.05, 0.05, 200, 1) },
  { name: 'wholly above the vertical field', plane: `${VERTICAL_TANGENT} tangent top plane`,
    world: worldBox(0.05, 0.2, 1.2, 1.4, 3.585) },
];

test('a saved seat is separated, in the band, and still outside one eye plane', async () => {
  const { h, points } = await panels();
  try {
    for (const { name, world } of BLIND) {
      const saved = savedSubject(world);
      const { separated, travel, visible } = readings(saved, points);
      assert.equal(separated, true, `${name}: off one side of the glass in both eyes`);
      assert.ok(Math.abs(headTangent(world)) <= BAND,
        `${name}: head-centred at ${headTangent(world).toFixed(4)}, inside the ${BAND} band`);
      assert.notEqual(travel, 0, `${name}: the first reading's frusta clips already refuse it`);
      assert.equal(visible, false, `${name}: and no part of it is inside both eyes' frusta`);
    }
  } finally { await h.toolbar.dispose(); }
});

test('Done refits a saved seat the wearer cannot see, never hands it back', async () => {
  const { h, points } = await panels();
  try {
    for (const { name, plane, world } of BLIND) {
      const saved = savedSubject(world);
      const outcome = savedSeatOutcome(saved, points);
      assert.equal(outcome.kept, false,
        `${name}: a seat wholly outside the ${plane} must not survive as the saved seat`);
      assert.ok(outcome.refusal || outcome.placement,
        `${name}: it falls through to a new placement or to the existing refusal`);
      if (outcome.refusal) assert.match(outcome.refusal, /^Could not reset: /,
        `${name}: and the refusal is the existing one, naming its limit`);
    }
  } finally { await h.toolbar.dispose(); }
});

test('a seat cropped by the field is still the wearer’s seat', async () => {
  const { h, points } = await panels();
  try {
    // A quarter of its height over the 45-degree edge at 1.0 tangent, the
    // other three quarters in plain sight.
    const world = worldBox(0.05, 0.2, 0.85, 1.05, 3.585);
    const saved = savedSubject(world);
    const { separated, travel, visible } = readings(saved, points);
    assert.equal(separated, true, 'off one side of the glass in both eyes');
    assert.ok(Math.abs(headTangent(world)) <= BAND, 'and inside the band');
    // The first reading clips the whole subject against the frusta, so a seat
    // running over the edge spends travel it cannot spend sideways: it reads
    // Infinity here, today and after the fix. Only the second reading keeps
    // this seat, and the visibility question must not take it away.
    assert.equal(travel, Infinity, 'the first reading refuses an edge it cannot solve sideways');
    assert.equal(visible, true, 'but the wearer is looking at it');
    assert.equal(savedSeatOutcome(saved, points).kept, true, 'so Done leaves the seat alone');
  } finally { await h.toolbar.dispose(); }
});

test('a visible saved seat beside the farther completed menu stays unchanged', async () => {
  const { h, points, plate } = await panels();
  try {
    // Keep the recorded box dimensions in the forward molecular view, beside
    // the current peripheral menu. An edge-relative construction would move
    // the subject out of the forward eye as the menu moves farther left.
    const base = -0.1;
    const saved = savedSubject(worldBox(base, base + 0.291, -0.35, -0.1872, 3.585));
    const { travel, separated, visible } = readings(saved, points);
    assert.equal(travel, 0, 'the per-eye reading needs no lateral repair');
    assert.equal(separated, true, 'the farther held completed glass clears this seat in both eyes');
    assert.equal(visible, true, 'and the wearer can see all of it');
    const completed = savedSeatOutcome(saved, points);
    assert.equal(completed.kept, true, 'so Done preserves the saved seat');
    assert.deepEqual(completed.placement, P0, 'scale, position and rotation stay unchanged');
    assert.equal(savedSeatOutcome(saved, plate).kept, true,
      'the chapter plate also clears this visible seat');
  } finally { await h.toolbar.dispose(); }
});
