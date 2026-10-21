/**
 * What the device recording says refused the saved seat.
 *
 * Both Done routes started from the same entry seat (P0, scale 0.9336) and
 * both shrank it — model Done to 0.4224, menu Done to 0.4675 — and a menu
 * Reset four seconds later returned 0.9241 from the same solver, the same
 * molecule and the same room. The numbers below are read off that recording.
 *
 * Two readings, not one, separate Reset's 0.9241 from Done's 0.4224:
 *
 * 1. The glass. The panel Done's solver measured carried the chapter's `Done`
 *    and `Pg` rows, which take the expanded grid into a third column. The menu
 *    the wearer is left with has two, and its right edge is 0.2007 tangent
 *    further left — off the molecule. Reset measured the two-column menu.
 * 2. The band. `focus-placement.mjs` seats the subject against
 *    `SUBJECT_CENTRE_LENS` read head-centred; `resetEntryLateralTravel` re-read
 *    the same constant per eye, where a 32 mm eye offset moves a 3.6 m subject
 *    about 0.009 tangent. The entry seat sat at 0.1322 tangent head-centred,
 *    inside the 0.1350 band, and 0.1411 in the left eye, outside it.
 *
 * The recording does not show a projection error: at the one moment both
 * measurements exist, `measureEntryStandoff` and the solver's own rects
 * describe the same panel to 0.0005 tangent. The first test pins that. The
 * remaining tests read the new held anchor; the recording predates that rule.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { toolbarFrameRuntime, toolbarFrameHarness } from './fixtures/toolbar-frame-runtime.mjs';
import { identity, syntheticViews } from './fixtures/component-label-diagnostics.mjs';
import { applyMatrix4, invertMatrix4 } from './room-lock.mjs';
import { tangentRectsForPoints, journeySeatDetail } from './journey-seat-record.mjs';
import { measureEntryStandoff } from './entry-standoff.mjs';
import { measureGlassClearance } from './fixtures/glass-clearance.mjs';
import { resetViewPlacement } from './reset-view-placement.mjs';
import { resetEntryGeometry, resetEntryLateralTravel } from './reset-entry-geometry.mjs';

/** The entry seat both routes started from, and the solve's own scalars. */
const P0 = { translation: [0.5570736303043923, 0.4572858597174322, -1.8299245299547606],
  rotation: [0, 0, 0], scale: 0.9336008197641015 };
const CAMERA_SCALE = 0.0235, RADIUS = 38.6683;

/** Read off the recording, left eye, tangent. */
const RECORDED = {
  // `plate-standoff`, phase `tour-end`: the panel the restoring draw put up.
  tourEndStandoff: { menuX: -0.3555, menuHalfWidth: 0.3756 },
  // `journey-seat` `menuRects`, the same panel through the solver's own rects.
  tourEndMenuRect: { left: -0.7306, right: 0.0205, points: 527 },
  // `plate-standoff`, phase `entry`, four seconds later: the menu that stays.
  restingStandoff: { menuX: -0.4541, menuHalfWidth: 0.2735 },
  // `journey-seat` `previewRects` and `plateRects`: the solver's glass and the
  // plate the same draw committed, both carrying the chapter's third column.
  previewPlateRight: 0.0381, committedPlateRight: 0.041,
  // The subject's bounding sphere at P0, and its per-eye silhouette centres.
  subjectLeft: -0.0782, subjectRight: 0.3604,
  subjectCentreLeftEye: 0.1411, subjectCentreRightEye: 0.12325,
};

const subject = { title: 'Human deoxyhaemoglobin', pdbId: '4HHB', chains: 4, assembly: 'asymmetric unit',
  representation: 'cartoon', color: 'chain-id' };
/** The tour state the 31 recorded `previewRows` are the row set of: the last
 * chapter, mid-restore, so `canBack` and `canNext` are both off and the
 * chooser seat holds `Done`. */
const restoringChapter = { active: true, navigating: true, autoplay: false, canBack: false, canNext: false,
  menuOpen: false, selectedId: 'haemoglobin', selectedTitle: 'Haemoglobin', step: 4, total: 5,
  title: 'The haem pocket', progress: 'Scene 5 / 5', bodyPageIndex: 1, bodyPageCount: 3,
  bodyPage: 'The iron at the centre of each haem group is where oxygen binds.',
  feedback: 'Restoring your view…' };
const restingState = { subject, voice: { state: 'idle' }, passthrough: true, passthroughSupported: true,
  renderQuality: 'balanced', sequence: { open: false, available: true, binding: 'b', version: 1 } };

const views = syntheticViews().map(view => {
  view.transform.matrix[13] = 1.6; view.transform.inverse.matrix[13] = -1.6; return view;
});
const headInRoom = (() => { const m = identity(); m[13] = 1.6; return m; })();
const leftRect = points => tangentRectsForPoints({ views, renderFromRoom: identity(), points })[0];

const cell = value => ({ ref: { value } });

test('Done diagnostic reuses decision evidence and preserves its complete record', () => {
  const placement = identity(); placement[14] = -1;
  const raw = { objects: [{ type: 'mesh', state: { visible: true }, values: {
    drawCount: cell(12), instanceCount: cell(1),
    aPosition: cell([-.05, -.1, 0, .05, .1, 0]), aTransform: cell(placement),
  } }, ...[.01, .02].map((radius, i) => ({ type: 'spheres', state: { visible: true }, values: {
    drawCount: cell(1), instanceCount: cell(1), aTransform: cell(placement),
    invariantBoundingSphere: cell({ center: [i ? .1 : -.1, 0, 0], radius }),
  } }))], fromPlacement: placement, toPlacement: placement, views: syntheticViews() };
  const seat = { scale: 1, rotation: [0, 0, 0], translation: [0, 0, -1] };
  const menus = [
    [], // empty
    [-.8, .8].flatMap(x => [.7, .95].map(y => [x, y, -1])), // retained
    [-.3, -.04].flatMap(x => [-.5, .5].map(y => [x, y, -1])), // adjusted
    [-5, 5].flatMap(x => [-5, 5].map(y => [x, y, -1])), // refused
  ];
  for (const points of menus) {
    const savedReading = {};
    const options = { seat, geometry: raw, points, headInRoom: identity(),
      renderFromRoom: identity(), cameraScale: 1, center: [0, 0, 0], radius: 1,
      fit: true, restoreSaved: true, bounded: true };
    let cleared;
    try { cleared = resetViewPlacement({ ...options, savedReading }); }
    catch { /* A refused placement still has the decision's geometry and readings. */ }
    assert.deepEqual(savedReading.geometry.subject.filter(item => item.radius > 0).map(item => item.radius), [.01, .02]);
    const args = { pose: true, immersive: true, before: seat, cleared,
      cameraScale: 1, sphere: { center: [0, 0, 0], radius: 1 }, geometry: raw,
      roomPose: { labelViews: raw.views, renderFromRoom: identity(), headInRoom: identity() },
      preview: { points } };
    const expected = journeySeatDetail(args);
    const inaccessible = { get objects() { throw Error('live mesh was reread'); } };
    assert.deepEqual(journeySeatDetail({ ...args, geometry: inaccessible, savedReading }), expected);
    const changedPreview = { ...args, preview: { points: [] } };
    assert.deepEqual(journeySeatDetail({ ...changedPreview, geometry: inaccessible, savedReading }),
      journeySeatDetail(changedPreview), 'a later preview with different points computes its own readings');
  }
});
const matrixFor = seat => { const m = identity(); m[0] = m[5] = m[10] = seat.scale;
  m.splice(12, 3, ...seat.translation); return m; };
/** A box in room metres whose LEFT-eye silhouette spans [x0,x1] by [y0,y1]. */
const worldBox = (x0, x1, y0, y1, depth) => [0, 1].flatMap(i => [0, 1].flatMap(j => [-0.02, 0.02].map(dz => {
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
    // The sphere the placement is written against, chosen so P0's own anchor
    // lands on this box. The recording carries no `loadedSphere` centre.
    center: centre.map((v, axis) => v / CAMERA_SCALE - P0.translation[axis] * RADIUS) };
}
const keepsSeat = (saved, points) => {
  try {
    return resetViewPlacement({ seat: P0, bounded: true, fit: true, restoreSaved: true,
      geometry: saved.geometry, points, headInRoom, renderFromRoom: identity(),
      cameraScale: CAMERA_SCALE, center: saved.center, radius: RADIUS }) === P0;
  } catch { return false; }
};
/** Per-eye silhouette centres, the reading the band is tested against. */
const eyeCentres = world => views.map(view => {
  const xs = world.map(point => { const p = applyMatrix4(point, view.transform.inverse.matrix); return p[0] / -p[2]; });
  return (Math.min(...xs) + Math.max(...xs)) / 2;
});

/** The restoring draw, and the completed panel Done measures on its held seat. */
async function panels() {
  const h = toolbarFrameHarness(await toolbarFrameRuntime(), { state: restingState });
  await h.toolbar.update();
  h.toolbar.runAction({ kind: 'collapse', value: false });
  await new Promise(resolve => setImmediate(resolve));
  const entryAnchor = h.toolbar.seatAnchor();
  h.setState({ ...restingState, tour: restoringChapter });
  await h.toolbar.update();
  return { h, entryAnchor, drawnRows: h.toolbar.rows(), drawnMenu: h.toolbar.drawnMenuPoints(),
    drawnPlate: h.toolbar.platePoints(),
    preview: h.toolbar.placementPreview({ headInRoom, restoreTourSeat: true }) };
}

test('one panel measured twice gives one right edge, in the recording and in the lab', async () => {
  // The recording, at the one moment both measurements describe the same draw.
  const recordedStandoffRight = RECORDED.tourEndStandoff.menuX + RECORDED.tourEndStandoff.menuHalfWidth;
  assert.ok(Math.abs(recordedStandoffRight - RECORDED.tourEndMenuRect.right) < 0.01,
    `the device recorded ${recordedStandoffRight.toFixed(4)} and ${RECORDED.tourEndMenuRect.right} for one panel`);

  const { h, drawnRows, drawnMenu } = await panels();
  try {
    assert.equal(drawnRows.filter(row => row.id !== 'motion').length, 31, 'the historical restoring controls retain their 31 rows');
    assert.equal(drawnRows.filter(row => row.id === 'motion').length, 1, 'the current menu also exposes its motion control');
    assert.equal(drawnRows.length, 32);
    assert.equal(drawnMenu.length, RECORDED.tourEndMenuRect.points + 17, 'the added motion row contributes its 17 drawn outline points');
    // Feed the recorded P0, radius and camera scale, so the subject the
    // standoff measures against is the saved one rather than an invented one.
    const saved = savedSubject(worldBox(0.05, 0.3, 0.02, 0.18, 3.585));
    const standoff = measureEntryStandoff({ objects: saved.objects, cameraScale: CAMERA_SCALE, views,
      menuPoints: drawnMenu, renderFromRoom: identity() });
    const eye = standoff.eyes.find(value => value.eye === 'left');
    const solverRight = leftRect(drawnMenu).right;
    assert.ok(Math.abs((eye.menuX + eye.menuHalfWidth) - solverRight) < 0.01,
      `standoff read ${(eye.menuX + eye.menuHalfWidth).toFixed(4)} and the solver ${solverRight}`);
  } finally { await h.toolbar.dispose(); }
});

test('the completed rows narrow the chapter menu on its held anchor', async () => {
  const { h, entryAnchor, preview, drawnMenu } = await panels();
  try {
    assert.deepEqual(preview.rows.map(row => row.id).filter(id => ['done', 'page'].includes(id)), [],
      'the completed menu draws neither the chapter Done nor its page row');
    const drawnRight = leftRect(drawnMenu).right, restingRight = leftRect(preview.menuPoints()).right;
    // The recording: +0.0205 while restoring, -0.1806 four seconds later.
    const recorded = (RECORDED.tourEndStandoff.menuX + RECORDED.tourEndStandoff.menuHalfWidth)
      - (RECORDED.restingStandoff.menuX + RECORDED.restingStandoff.menuHalfWidth);
    assert.ok(Math.abs(recorded - 0.2007) < 0.0005, 'the recorded narrowing is 0.2007 tangent');
    assert.deepEqual(h.toolbar.seatAnchor(), entryAnchor, 'the host chapter does not move the room anchor');
    assert.ok(drawnRight - restingRight > 0.09,
      `the completed rows narrow the held menu by ${(drawnRight - restingRight).toFixed(4)}`);
    assert.ok(drawnRight - restingRight < recorded,
      'the device narrowing included the implicit re-seat that Done no longer makes');
    // The completed information card now faces forward above the molecule.
    // The union of it and the column need not narrow or lower its ceiling:
    // the gap between those separate plates is not glass. Done must measure
    // exactly the plates it draws at the held anchor.
    await h.toolbar.update({ restoreTourSeat: true });
    assert.deepEqual(h.toolbar.platePoints().plates, preview.points.plates,
      'Done draws every plate the solver measured, including the forward card');
  } finally { await h.toolbar.dispose(); }
});

test('Done refits a saved seat that overlaps completed glass at the held anchor', async () => {
  const { h, preview, drawnPlate } = await panels();
  try {
    // Overlap the completed column's actual inboard edge. The old fixture
    // followed the wider restoring column, which retreats on completion and
    // now leaves that saved box clear.
    const column = leftRect(preview.points.plates[1]);
    const left = column.right - .0395;
    const saved = savedSubject(worldBox(left, left + .291, column.bottom + .01, column.top - .01, 3.585));
    for (const points of [preview.points, drawnPlate]) {
      const witness = measureGlassClearance({ objects: saved.objects, views,
        cameraScale: CAMERA_SCALE, renderFromRoom: identity(), menuPoints: points });
      assert.ok(witness.eyes.every(eye => eye.clearance < 0),
        'the saved mesh actually overlaps glass in both eyes before Done');
    }
    assert.equal(keepsSeat(saved, preview.points), false, 'the held completed panel still overlaps this saved seat');
    assert.equal(keepsSeat(saved, drawnPlate), false, 'the restoring panel refits it');
  } finally { await h.toolbar.dispose(); }
});

test('the centre band is read from the head beside held completed glass', async () => {
  const { h, preview } = await panels();
  try {
    // A forward subject below the overhead card, beside the peripheral menu.
    // The complete glass union's right edge belongs to that overhead card;
    // putting a subject beside it would move the subject outside the band.
    const base = -.05;
    const baselineEyes = eyeCentres(worldBox(base, base + 0.291, 0.0153, 0.1781, 3.585));
    const baselineCentre = (baselineEyes[0] + baselineEyes[1]) / 2;
    const cases = [
      { nudge: 0, band: 'inside in both eyes', keep: true },
      // A held-seat shape: inside head-centred, outside in the left eye.
      { nudge: 0.132 - baselineCentre, band: 'inside from the head only', keep: true, straddles: true },
      // Genuinely off to one side, which Done still re-centres.
      { nudge: 0.15 - baselineCentre, band: 'outside from the head', keep: false },
    ];
    for (const { nudge, band, keep, straddles } of cases) {
      const world = worldBox(base + nudge, base + nudge + 0.291, 0.0153, 0.1781, 3.585);
      const saved = savedSubject(world);
      const [leftEye, rightEye] = eyeCentres(world);
      const mono = (leftEye + rightEye) / 2;
      const rendered = resetEntryGeometry({ ...saved.geometry, cameraScale: CAMERA_SCALE, renderFromRoom: identity() });
      const travel = resetEntryLateralTravel({ geometry: rendered, points: preview.points,
        right: [1, 0, 0], clearance: 0 });
      assert.equal(keepsSeat(saved, preview.points), keep,
        `${band}: head ${mono.toFixed(4)}, left eye ${leftEye.toFixed(4)}`);
      if (straddles) {
        assert.ok(leftEye > 0.135 && mono < 0.135, 'the held-seat shape straddles the band');
        assert.notEqual(travel, 0, 'and the per-eye reading alone refuses it');
      }
    }
  } finally { await h.toolbar.dispose(); }
});
