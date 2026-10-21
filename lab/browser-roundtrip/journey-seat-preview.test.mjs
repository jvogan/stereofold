/**
 * The panel Done's clearance solver measures is the panel Done draws.
 *
 * `restoreJourneySeat` clears the restored view against `placementPoints({
 * restoreTourSeat: true })`, which seats the panel on the held pre-tour head
 * and its held layout — but builds its rows and its readout from `getState()`,
 * which at that moment still carries the tour the wearer has just finished.
 * The solver therefore clears a chapter panel, and what gets drawn a moment
 * later is the shorter completed menu. On one device session that is a 0.354 tangent
 * cleared against a 0.251 tangent drawn, and the restored view is halved to
 * make room for glass nobody ever sees.
 *
 * This asserts the correct behaviour: one panel, one measurement.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { toolbarFrameRuntime, toolbarFrameHarness } from './fixtures/toolbar-frame-runtime.mjs';
import { identity, syntheticViews } from './fixtures/component-label-diagnostics.mjs';
import { tangentRectsForPoints } from './journey-seat-record.mjs';
import { resetViewPlacement } from './reset-view-placement.mjs';
import { resetEntryGeometry } from './reset-entry-geometry.mjs';
import { applyMatrix4, invertMatrix4 } from './room-lock.mjs';
import { measureGlassClearance } from './fixtures/glass-clearance.mjs';

const subject = { title: 'Human deoxyhaemoglobin', pdbId: '4HHB', chains: 4,
  representation: 'cartoon', color: 'chain-id' };

/** A chapter on screen: a title, a scene line and a sentence being read out. */
const narratedChapter = { active: true, selectedId: 'haem-pocket', selectedTitle: 'Oxygen binding',
  step: 1, total: 20, title: 'The haem pocket', progress: 'Scene 2 / 20',
  bodyPage: 'Each subunit wraps one haem group, and the iron at its centre is where oxygen binds.' };

const views = syntheticViews().map(view => {
  view.transform.matrix[13] = 1.6; view.transform.inverse.matrix[13] = -1.6; return view;
});
const headInRoom = (() => { const m = identity(); m[13] = 1.6; return m; })();

const rects = points => tangentRectsForPoints({ views, renderFromRoom: identity(), points });
/** Widest half-tangent the glass fills at either eye, the unit the ring records. */
const halfWidth = points => Math.max(...rects(points).map(rect => (rect.points ? (rect.right - rect.left) / 2 : 0)));
/** Highest the glass reaches at either eye: the edge a restored view is pushed off. */
const top = points => Math.max(...rects(points).map(rect => (rect.points ? rect.top : 0)));

test('the Done preview measures the completed menu, not the tour it is leaving', async () => {
  const runtime = await toolbarFrameRuntime();
  const h = toolbarFrameHarness(runtime, { state: { subject } });
  try {
    // The pre-tour menu, which is the seat and layout Done restores.
    await h.toolbar.update();
    // A chapter: more rows, a title, a scene line and a narrated caption.
    h.setState({ subject, tour: { active: true, selectedId: 'haem-pocket', selectedTitle: 'Oxygen binding',
      step: 1, total: 20, title: 'The haem pocket', progress: 'Scene 2 / 20',
      bodyPage: 'Each subunit wraps one haem group, and the iron at its centre is where oxygen binds.' } });
    await h.toolbar.update();

    // Exactly the call `restoreJourneySeat` makes, at exactly that moment: the
    // player has not yet switched the experience to its completed state.
    const preview = h.toolbar.placementPreview({ headInRoom, restoreTourSeat: true });

    // Done completes, and the toolbar redraws on the held seat.
    h.setState({ subject, tour: { active: false, step: -1 } });
    await h.toolbar.update({ restoreTourSeat: true });

    assert.deepEqual(preview.rows.map(row => row.id), h.toolbar.rows().map(row => row.id),
      'the solver measured the rows that were drawn');
    assert.deepEqual(preview.readout, h.toolbar.readoutText(),
      'the solver measured the readout that was drawn');
    assert.equal(halfWidth(preview.menuPoints()).toFixed(4), halfWidth(h.toolbar.drawnMenuPoints()).toFixed(4),
      'the solver cleared the width that was drawn');
    // The caption block is what grows with a chapter, so this is the edge that
    // pushes a restored view down and makes it shrink.
    assert.equal(top(preview.points).toFixed(4), top(h.toolbar.platePoints()).toFixed(4),
      'the solver cleared the ceiling that was drawn');
  } finally { await h.toolbar.dispose(); }
});

/**
 * The other two previews are unchanged.
 *
 * Only Done restores a held seat and a completed panel. Entry and Reset build
 * the panel they are about to draw at a new seat, from the state the wearer is
 * in, and that state may perfectly well be a chapter: pressing Reset during a
 * lesson must clear the caption the lesson is showing. This pins their content
 * and their glass against what they measured before that defect was fixed, so a
 * later change to the Done derivation cannot quietly reach them.
 */
test('Entry and Reset previews still measure the panel the live state draws', async () => {
  const runtime = await toolbarFrameRuntime();
  const h = toolbarFrameHarness(runtime, { state: { subject } });
  try {
    await h.toolbar.update();
    h.toolbar.runAction({ kind: 'collapse', value: false });
    await new Promise(resolve => setImmediate(resolve));
    h.setState({ subject, tour: narratedChapter });
    await h.toolbar.update();

    // The chapter card is the chapter alone: the structure's own lines belong
    // to the menu readout.
    const chapterReadout = ['The haem pocket · 2/20', 'Each subunit wraps one haem group, and the',
      'iron at its centre is where oxygen binds.'];
    for (const [name, preview] of [['entry', h.toolbar.placementPreview({ headInRoom })],
      ['reset', h.toolbar.placementPreview({ headInRoom, resetMenu: true })]]) {
      assert.deepEqual(preview.rows.map(row => row.id), h.toolbar.rows().map(row => row.id),
        `the ${name} preview reads the drawn rows`);
      assert.equal(preview.rows.length, 27, `the ${name} preview keeps its 27 rows; the caption fits one card page`);
      assert.deepEqual(preview.readout, chapterReadout, `the ${name} preview keeps the chapter caption`);
      assert.equal(preview.collapsed, false, `the ${name} preview keeps its drawn form`);
      // The 1.35 m design preserves angular dimensions; fixed eye spacing
      // changes their binocular projection slightly from the old .95 m seat.
      // The chapter card keeps a margin around its caption and one size while
      // it pages, which raised its ceiling from 0.8140 and widened it from 0.7572.
      assert.equal(top(preview.points).toFixed(4), '0.8856', `the ${name} preview keeps its ceiling`);
      assert.equal(halfWidth(preview.points).toFixed(4), '0.7693', `the ${name} preview keeps its width`);
      assert.equal(halfWidth(preview.menuPoints()).toFixed(4), '0.2578', `the ${name} preview keeps its column`);
      assert.equal(top(preview.points).toFixed(4), top(h.toolbar.platePoints()).toFixed(4), `the ${name} preview measures the drawn ceiling`);
      assert.equal(halfWidth(preview.points).toFixed(4), halfWidth(h.toolbar.platePoints()).toFixed(4), `the ${name} preview measures the drawn width`);
      assert.equal(halfWidth(preview.menuPoints()).toFixed(4), halfWidth(h.toolbar.drawnMenuPoints()).toFixed(4), `the ${name} preview measures the drawn column`);
    }
  } finally { await h.toolbar.dispose(); }
});

/**
 * Done retains a saved view between the chapter card and the completed card.
 * Both cards now face forward. A shallow box at their lower edge overlaps the
 * taller chapter card but clears the shorter information card. The independent
 * eye projection below proves both premises before exercising the viewer.
 */
test('a view that clears the completed menu keeps its seat through Done', async () => {
  const { deviceDoneClearance, devicePlacement } = await import('./fixtures/device-done-clearance.mjs');
  const seat = { rotation: [0, 0, 0], scale: 1,
    translation: [devicePlacement.translation[0] - .2, devicePlacement.translation[1] + 1.95,
      devicePlacement.translation[2]] };
  let placement = structuredClone(seat);
  const records = [];
  let h;
  h = await deviceDoneClearance({ runtime: await toolbarFrameRuntime(), placement: devicePlacement, halfHeight: .1,
    subject: { title: 'Hemoglobin', pdbId: '4HHB', chains: 4 },
    getPlacement: () => placement, setPlacement: next => { placement = next; },
    // The player's completed state, published where the headset publishes it:
    // after the solve, before the panel that stays is drawn.
    beforeMenuDraw: async () => { await h.setTour({ active: false, step: -1 }); } });
  h.context.__stereofoldDiagnostics = { record: (kind, detail) => records.push({ kind, detail }) };
  try {
    await h.setTour(narratedChapter);
    const { latestRoomPlacementPose: pose, immersiveSession: menu } = h.context;
    const sphere = h.context.loadedSphere();
    const geometry = { views: pose.labelViews, fromPlacement: h.context.presentationTransform(),
      toPlacement: h.context.placementTransform(seat),
      objects: h.context.scientificRepresentations().flatMap(repr => repr.renderObjects)
        .filter(object => object.type !== 'text') };
    const clear = points => resetViewPlacement({ seat, bounded: true, fit: true, restoreSaved: true,
      geometry, points, ...pose, cameraScale: 1, center: sphere.center, radius: sphere.radius });

    // The panel Done will draw: the saved seat is already clear of it.
    const preview = menu.toolbarPlacementPreview({ ...pose, restoreTourSeat: true });
    const witness = points => measureGlassClearance({ objects: geometry.objects, views: pose.labelViews,
      cameraScale: 1, renderFromRoom: pose.renderFromRoom, menuPoints: points }).eyes;
    assert.ok(witness(preview.points).every(eye => eye.clearance > 0),
      'the saved mesh clears each completed plate in both eyes');
    assert.ok(witness(menu.platePoints()).every(eye => eye.clearance < 0),
      'the saved mesh overlaps the chapter card in both eyes');
    assert.equal(clear(preview.points), seat, 'the completed menu leaves the saved seat alone');
    // The panel Done is leaving: the same seat overlaps its caption block, so a
    // solve against that glass cannot return the seat.
    assert.notEqual(clear(menu.platePoints()), seat,
      'the chapter caption does cover the saved seat');

    await h.restore({ camera: {}, inspection: { placement } });
    const seatRecord = records.filter(entry => entry.kind === 'journey-seat')[0].detail;
    assert.deepEqual(seatRecord.previewReadout, seatRecord.committedReadout,
      'the solver measured the readout that was drawn');
    assert.deepEqual(seatRecord.previewRows, seatRecord.committedRows,
      'the solver measured the rows that were drawn');
    assert.equal(seatRecord.lateralTravel, 0, 'a clear saved view spends no sideways travel');
    assert.equal(seatRecord.path, 'cleared');
    assert.deepEqual(seatRecord.after, seatRecord.before, 'Done restored the saved view unchanged');
    assert.deepEqual(h.moves, [], 'nothing was moved to make room for glass nobody draws');
    assert.deepEqual(placement, seat);
  } finally { await h.dispose(); }
});

/**
 * The record itself, over the shipped `restoreJourneySeat` closure and the real
 * toolbar: one entry per Done, carrying the solver's inputs and the panel that
 * was drawn after it. A field this misses is a field the device run cannot
 * read, so the shape is asserted here rather than on the headset.
 */
test('one Done emits one journey-seat record of what the solver measured', async () => {
  const { deviceDoneClearance, devicePlacement } = await import('./fixtures/device-done-clearance.mjs');
  let placement = structuredClone(devicePlacement);
  const records = [];
  const h = await deviceDoneClearance({ runtime: await toolbarFrameRuntime(),
    getPlacement: () => placement, setPlacement: next => { placement = next; } });
  // The page closure runs in its own context, so this is its `globalThis`.
  h.context.__stereofoldDiagnostics = { record: (kind, detail) => records.push({ kind, detail }) };
  try {
    await h.chapter(1);
    await h.setTour({ active: false, step: -1 });
    await h.restore({ camera: {}, inspection: { placement } });
    const seats = records.filter(entry => entry.kind === 'journey-seat');
    assert.equal(seats.length, 1, 'exactly one record per Done');
    const seat = seats[0].detail;
    assert.equal(seat.immersive, true);
    assert.equal(seat.pose, true);
    assert.equal(seat.path, 'cleared');
    assert.equal(seat.before.scale, Number(devicePlacement.scale.toFixed(4)));
    for (const key of ['previewRects', 'previewMenuRects', 'subjectRects', 'menuRects', 'plateRects']) {
      assert.equal(seat[key].length, 2, `${key} reports both eyes`);
      for (const rect of seat[key]) assert.ok(rect.points > 0, `${key} has glass at ${rect.eye}`);
    }
    assert.equal(seat.lateralEyes.length, 2);
    for (const eye of seat.lateralEyes) {
      assert.equal(typeof eye.alreadyClear, 'boolean');
      assert.equal(typeof eye.separated, 'boolean');
      assert.equal(eye.clearMinus || eye.clearPlus, eye.alreadyClear);
    }
    assert.ok(seat.previewRows.length > 0 && seat.committedRows.length > 0);
    assert.ok(seat.previewLayout.forwardMeters > 0 && seat.committedLayout.forwardMeters > 0);
    assert.equal(seat.previewHead.length, 6);
    // Same held seat, either side of the draw: the head is not what moved.
    assert.deepEqual(seat.previewHead, seat.committedHead);
  } finally { await h.dispose(); }
});

test('Done records fallback toolbar points when a placement preview is unavailable', async () => {
  const { deviceDoneClearance, devicePlacement } = await import('./fixtures/device-done-clearance.mjs');
  let placement = structuredClone(devicePlacement);
  const records = [];
  const h = await deviceDoneClearance({ runtime: await toolbarFrameRuntime(),
    getPlacement: () => placement, setPlacement: next => { placement = next; } });
  h.context.__stereofoldDiagnostics = { record: (kind, detail) => records.push({ kind, detail }) };
  const context = h.context, pose = context.latestRoomPlacementPose;
  const geometry = { objects: context.scientificRepresentations().flatMap(repr => repr.renderObjects),
    fromPlacement: context.presentationTransform(), toPlacement: context.placementTransform(placement),
    views: pose.labelViews };
  const rendered = resetEntryGeometry({ ...geometry, cameraScale: 1, renderFromRoom: pose.renderFromRoom });
  const centre = applyMatrix4(rendered.subject[0].center, invertMatrix4(pose.renderFromRoom));
  const points = [-1, 1].flatMap(x => [-1, 1].map(y =>
    [centre[0] + x * .05, centre[1] + y * .05, centre[2]]));
  h.context.immersiveSession.toolbarPlacementPreview = () => undefined;
  h.context.immersiveSession.toolbarPlacementPoints = () => points;
  try {
    await h.chapter(1);
    await h.restore({ camera: {}, inspection: { placement } });
    const seats = records.filter(entry => entry.kind === 'journey-seat');
    assert.equal(seats.length, 1);
    assert.equal(seats[0].detail.previewRects[0].points, points.length);
    assert.equal(seats[0].detail.lateralTravel, 'infinite');
    assert.equal(seats[0].detail.lateralSeparated, false);
  } finally { await h.dispose(); }
});

test('a thrown Done solve records its reason and preserves the thrown refusal', async () => {
  const { deviceDoneClearance, devicePlacement } = await import('./fixtures/device-done-clearance.mjs');
  let placement = structuredClone(devicePlacement);
  const records = [];
  const h = await deviceDoneClearance({ runtime: await toolbarFrameRuntime(),
    getPlacement: () => placement, setPlacement: next => { placement = next; } });
  h.context.__stereofoldDiagnostics = { record: (kind, detail) => records.push({ kind, detail }) };
  h.context.immersiveSession.toolbarPlacementPreview = () => undefined;
  h.context.immersiveSession.toolbarPlacementPoints = () =>
    [-100, 100].flatMap(x => [-100, 100].map(y => [x, y, -1]));
  try {
    await h.chapter(1);
    let reason;
    await assert.rejects(h.restore({ camera: {}, inspection: { placement } }), error => {
      reason = error.message;
      return /within 4 m/u.test(reason);
    });
    const seats = records.filter(entry => entry.kind === 'journey-seat');
    assert.equal(seats.length, 1);
    assert.equal(seats[0].detail.failureReason, reason);
    assert.equal(seats[0].detail.path, 'none');
    assert.equal(seats[0].detail.lateralTravel, 'infinite');
    assert.deepEqual(placement, devicePlacement);
  } finally { await h.dispose(); }
});

/**
 * The production order, where the player has not spoken yet.
 *
 * The test above completes the tour state between the preview and the draw,
 * which is not the order the headset runs. `restoreJourneySeat` is called from
 * inside `hydrate` (`plugin/src/inspector.ts`, the `completion?.status ===
 * 'pending'` branch), and the experience player publishes its completed
 * reading only after `hydrate` has returned. So the preview measures the
 * completed menu — An earlier run made it do that — and every draw between the solve and
 * the player's publication still builds its rows, its caption and its columns
 * from the chapter the wearer has just left. The solver clears a saved view
 * against the short panel and the tall one is drawn over it.
 *
 * The draw in that window is exactly this one: `restoreTourSeat` in
 * `viewer.mjs` awaits `immersiveSession.refreshToolbar({ restoreTourSeat:
 * true })`, which awaits `toolbar.update({ restoreTourSeat: true })`. The tour
 * is still on the state at both calls here, as it is on the device.
 */
test('the panel drawn while Done\'s restore is pending is the panel the preview measured', async () => {
  const runtime = await toolbarFrameRuntime();
  const h = toolbarFrameHarness(runtime, { state: { subject } });
  const records = [], previous = globalThis.__stereofoldDiagnostics;
  globalThis.__stereofoldDiagnostics = { record: (kind, detail) => records.push({ kind, detail }) };
  try {
    // The pre-tour menu, which is the seat and the layout Done restores.
    await h.toolbar.update();
    h.setState({ subject, tour: narratedChapter });
    await h.toolbar.update();

    // Production order: the chapter is still the published state at both calls.
    const preview = h.toolbar.placementPreview({ headInRoom, restoreTourSeat: true });
    await h.toolbar.update({ restoreTourSeat: true });

    assert.deepEqual(h.toolbar.rows().map(row => row.id), preview.rows.map(row => row.id),
      'the panel drawn in the pending window has the rows the solver cleared');
    assert.deepEqual(h.toolbar.readoutText(), preview.readout,
      'the chapter caption is retired rather than drawn over the restored view');
    assert.equal(halfWidth(h.toolbar.drawnMenuPoints()).toFixed(4), halfWidth(preview.menuPoints()).toFixed(4),
      'the column drawn in the pending window is the column the solver cleared');
    assert.equal(top(h.toolbar.platePoints()).toFixed(4), top(preview.points).toFixed(4),
      'the ceiling drawn in the pending window is the ceiling the solver cleared');

    // The Done draw's own reading, so a device run can prove the two agreed.
    const transitions = records.filter(entry => entry.kind === 'transition');
    assert.equal(transitions.length, 1, 'one transition record per Done');
    const transition = transitions[0].detail;
    assert.equal(transition.phase, 'done-restore');
    assert.equal(transition.rowsPreviewed, preview.rows.length);
    assert.equal(transition.rowsDrawn, preview.rows.length, 'the draw kept the measured row count');
    assert.equal(transition.columns, Math.ceil(preview.rows.length / 15),
      'the drawn grid folded into the columns the measured rows need');

    // The player publishes its completed reading. Nothing on the glass moves.
    const settledRows = h.toolbar.rows().map(row => row.id);
    const settledMenu = halfWidth(h.toolbar.drawnMenuPoints()).toFixed(4);
    const settledCeiling = top(h.toolbar.platePoints()).toFixed(4);
    h.setState({ subject, tour: { active: false, step: -1 } });
    await h.toolbar.update();
    assert.deepEqual(h.toolbar.rows().map(row => row.id), settledRows,
      'the player catching up changes no row');
    assert.equal(halfWidth(h.toolbar.drawnMenuPoints()).toFixed(4), settledMenu,
      'the player catching up moves no column');
    assert.equal(top(h.toolbar.platePoints()).toFixed(4), settledCeiling,
      'the player catching up moves no ceiling');
  } finally {
    globalThis.__stereofoldDiagnostics = previous;
    await h.toolbar.dispose();
  }
});

/**
 * The completed presentation is held against one published reading.
 *
 * The window exists because the experience player has not spoken yet. The
 * moment it does, whatever it says is what the wearer is owed — including a
 * chapter. A host that finished a tour, missed its own completion heartbeat
 * and then started another lesson must not find the menu still presenting the
 * completed panel over it, so the latch is released by any change to the
 * published reading and not only by the ending it was expecting.
 */
test('a chapter published after Done ends the completed presentation', async () => {
  const runtime = await toolbarFrameRuntime();
  const h = toolbarFrameHarness(runtime, { state: { subject } });
  try {
    await h.toolbar.update();
    h.setState({ subject, tour: narratedChapter });
    await h.toolbar.update();
    await h.toolbar.update({ restoreTourSeat: true });
    const restored = h.toolbar.rows().map(row => row.id);

    // The player skips its completion and publishes the next lesson instead.
    h.setState({ subject, tour: { ...narratedChapter, selectedId: 'allostery',
      selectedTitle: 'Allosteric change', step: 2, title: 'The T to R shift',
      progress: 'Scene 3 / 20', bodyPage: 'Oxygen binding at one subunit loosens the salt bridges that hold the others shut.' } });
    await h.toolbar.update();

    assert.notDeepEqual(h.toolbar.rows().map(row => row.id), restored,
      'the new chapter draws its own rows');
    assert.ok(h.toolbar.readoutText().join(' ').includes('The T to R shift'),
      'the new chapter draws its own caption');
  } finally { await h.toolbar.dispose(); }
});
