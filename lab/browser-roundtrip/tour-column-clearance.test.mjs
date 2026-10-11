/**
 * The expanded menu must not grow over the structure when a tour
 * chapter adds a column.
 *
 * The wearer opens Menu from the compact entry controls, seating the expanded
 * grid: 29 rows, two columns of fifteen. A chapter adds Play, Done, Back, Next
 * and a caption page row, the grid folds into three columns, and
 * `createToolbarPanel` gives the wider panel a bearing nearer the forward axis
 * so its outboard corner stays inside the lens. Nothing re-solves, so the third
 * column is drawn wherever it lands.
 *
 * On a headset pass a wearer capture holds
 * 4HHB, "Beta subunits · Scene 3 / 20", and in both eyes the third column
 * (`Opaque +`, `Move`) and the panel's right edge over the haemoglobin cartoon.
 *
 * The scene below is that capture's own placement. The recorded state carries
 * translation [0.5628, 0.4568, -1.8301] and scale 1.0234; `entrySeat` in
 * `room-anchor.mjs` seats a structure at the line where it subtends
 * `ENTRY_VIEW_DEGREES` (50), so the 1.9684 m line that translation sits on is
 * 1.836 m across. The lit cartoon is smaller than that bounding sphere: in the
 * capture's left eye the coloured silhouette spans 398 px of a 916 px eye half
 * width, which at the recorded 44.5 degree half field is 0.427 tangent, or
 * 0.84 m at 1.9684 m. That is the radius used here.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { toolbarFrameRuntime, toolbarFrameHarness } from './fixtures/toolbar-frame-runtime.mjs';
import { identity, syntheticViews } from './fixtures/component-label-diagnostics.mjs';
import { resetEntryGeometry, resetEntryLateralBreakdown, subjectVisibleInEyes } from './reset-entry-geometry.mjs';
import { PLATE_CLEARANCE_LENS } from './plate-standoff.mjs';
import { SPATIAL_TOOLBAR_LAYOUT } from './spatial-toolbar-geometry.mjs';

const EYE_Y = 1.6;
const D106_PLACEMENT = Object.freeze({ translation: [0.5628393011122276, 0.45677582070953615, -1.8301411647060366],
  rotation: [0, 0, 0], scale: 1.0233660332450671 });
/** The lit cartoon's room radius at that placement, in metres. */
const D106_CARTOON_RADIUS = 0.84;

const cell = value => ({ ref: { value } });
/** The placement as Mol* holds it, lifted to the harness head's eye height. */
const placementMatrix = placement => {
  const matrix = identity();
  matrix[0] = matrix[5] = matrix[10] = placement.scale;
  matrix.splice(12, 3, placement.translation[0], placement.translation[1] + EYE_Y, placement.translation[2]);
  return matrix;
};

/**
 * A sphere of mesh vertices, so the projected silhouette is a structure's and
 * not a box's. Eight bands is enough that the widest bearing of the hull is
 * within a tenth of a degree of the sphere's own.
 */
function shellPoints(radius, bands = 8) {
  const points = [];
  for (let band = 0; band <= bands; band += 1) {
    const theta = Math.PI * band / bands;
    for (let step = 0; step < 2 * bands; step += 1) {
      const phi = Math.PI * step / bands;
      points.push([radius * Math.sin(theta) * Math.cos(phi),
        radius * Math.sin(theta) * Math.sin(phi), radius * Math.cos(theta)]);
    }
  }
  return points;
}

/** The committed render objects, eye views and room transform the toolbar reads. */
function d106Scene({ radius = D106_CARTOON_RADIUS, placement = D106_PLACEMENT } = {}) {
  const local = shellPoints(radius / placement.scale);
  const matrix = placementMatrix(placement);
  const object = { type: 'mesh', state: { visible: true }, values: {
    drawCount: cell(local.length), instanceCount: cell(1),
    aPosition: cell(local.flat()), aTransform: cell(matrix) } };
  const views = syntheticViews().map(view => {
    const eye = [...view.transform.matrix], inverse = [...view.transform.inverse.matrix];
    eye[13] = EYE_Y; inverse[13] = -EYE_Y;
    return { ...view, transform: { matrix: eye, inverse: { matrix: inverse } } };
  });
  return { objects: [object], cameraScale: 1, views, renderFromRoom: identity(),
    fromPlacement: matrix, toPlacement: matrix };
}

const SUBJECT = Object.freeze({ title: 'Human deoxyhaemoglobin', pdbId: '4HHB', chains: 4,
  representation: 'cartoon', color: 'element-symbol' });
/** The wearer's state at entry: a microphone, a sequence and a render-budget lever. */
const RESTING = Object.freeze({ subject: SUBJECT, voice: { state: 'idle' }, renderQuality: 'balanced',
  motion: { paused: true }, sequence: { available: true, binding: 'b', version: 1 } });
/** Scene 3 / 20 of the capture's lesson, with a page row and both chapter arrows. */
const CHAPTER = Object.freeze({ active: true, selectedId: 'hemoglobin-quaternary-structure',
  selectedTitle: 'Hemoglobin tetramer', step: 2, total: 20, title: 'Beta subunits',
  progress: 'Scene 3 / 20', canBack: true, canNext: true, bodyPageIndex: 0, bodyPageCount: 2,
  bodyPage: 'The two beta subunits sit across the central cavity from the alpha pair.' });

/** The lens-share margin the entry seat stands on, in each eye's tangent units. */
const tangentMargin = scene => PLATE_CLEARANCE_LENS / Math.abs(scene.views[0].projectionMatrix[0]);
/**
 * The rows and columns actually on the glass.
 *
 * `menuRows` gives one point set per drawn button and `layout().maxRows` is the
 * cap the fold put on a column, so the two together are the drawn grid. The
 * `toolbar` ring's `phase: 'rows'` chunks carry the drawn labels, which is the
 * reading a device pass has.
 */
const drawnRowCount = toolbar => toolbar.menuRows().length;
const drawnColumns = toolbar => Math.ceil(drawnRowCount(toolbar) / toolbar.layout().maxRows);
function drawnLabels(records) {
  const chunks = records.filter(r => r.kind === 'toolbar' && r.detail.phase === 'rows');
  const latest = chunks.filter(r => r.detail.draw === chunks.at(-1)?.detail.draw);
  return latest.sort((a, b) => a.detail.from - b.detail.from).flatMap(r => r.detail.labels);
}

/**
 * Does every drawn panel point clear the subject by the margin in both eyes?
 *
 * `resetEntryLateralBreakdown` is the production reading of exactly that: it
 * inflates the drawn glass by the margin and asks, per eye, whether the whole
 * subject is off one lateral side of it.
 */
function clearance(scene, geometry, points) {
  return resetEntryLateralBreakdown({ geometry, points, clearance: tangentMargin(scene) });
}

async function seatedHarness(scene) {
  const runtime = await toolbarFrameRuntime();
  const records = [];
  const previous = globalThis.__stereofoldDiagnostics;
  globalThis.__stereofoldDiagnostics = { record: (kind, detail) => records.push({ kind, detail }) };
  const harness = toolbarFrameHarness(runtime, { state: { ...RESTING }, getEntryGeometry: () => scene });
  // Entry is compact. Exercise the actual Menu action before measuring the
  // expanded grid whose extra chapter column this regression protects.
  await harness.toolbar.update();
  assert.equal(harness.toolbar.isCollapsed(), true, 'entry starts with compact controls');
  harness.toolbar.runAction({ kind: 'collapse', value: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.toolbar.isCollapsed(), false, 'Menu opens the expanded controls');
  return { ...harness, records,
    standoffs: phase => records.filter(r => r.kind === 'plate-standoff' && r.detail.phase === phase).map(r => r.detail),
    restore: async () => { await harness.toolbar.dispose(); globalThis.__stereofoldDiagnostics = previous; } };
}

test('an active chapter never draws its extra column over the structure', async () => {
  const scene = d106Scene();
  const geometry = resetEntryGeometry(scene);
  assert.ok(subjectVisibleInEyes(geometry), 'the wearer is looking at the structure in both eyes');
  const h = await seatedHarness(scene);
  try {
    // The menu column clears at entry. The full caption footprint cannot
    // claim that clearance in this fixture.
    await h.toolbar.update();
    assert.equal(drawnColumns(h.toolbar), 2, 'entry draws the two-column grid');
    assert.equal(h.standoffs('entry').at(-1).frame.menu.clear, false,
      'entry reports the whole menu and caption glass');
    assert.equal(clearance(scene, geometry, h.toolbar.drawnMenuPoints()).alreadyClear, true);

    // Scene 3 / 20 of the capture: Play, Done, Back, Next and a page row.
    h.setState({ ...RESTING, tour: CHAPTER });
    await h.toolbar.update();

    const measured = clearance(scene, geometry, h.toolbar.drawnMenuPoints());
    assert.equal(measured.alreadyClear, true,
      `the drawn panel covers the structure: ${JSON.stringify(measured.eyes)}`);

    const solved = h.standoffs('tour-chapter');
    assert.equal(solved.length, 1, 'the drawn column count changing re-solves the seat, once');
    assert.equal(solved[0].units, 'tangent');
    assert.equal(solved[0].lit, true);
    assert.equal(solved[0].frame.menu.columns, drawnColumns(h.toolbar),
      'the record reports the column count that was drawn');
    assert.equal(solved[0].frame.menu.asked, 3, 'and the count the chapter grid asked for');
    assert.equal(solved[0].frame.menu.clear, false,
      'the record does not call the menu and caption clear when only the menu clears');
  } finally { await h.restore(); }
});

test('a chapter the bearing cannot clear folds its third column away', async () => {
  // The bearing is spent before the ladder starts: `toolbarSeatDegrees` brings
  // a wide panel in until its outboard corner is inside the lens, so a
  // three-column grid covers the same lens rectangle whatever `rightMeters`
  // asks for. The column count is the only lever left, and capping rows per
  // column spends it without dropping a row or shrinking the type.
  const scene = d106Scene();
  const geometry = resetEntryGeometry(scene);
  const h = await seatedHarness(scene);
  try {
    await h.toolbar.update();
    h.setState({ ...RESTING, tour: CHAPTER });
    await h.toolbar.update();

    const record = h.standoffs('tour-chapter').at(-1);
    assert.equal(record.frame.menu.asked, 3, 'the chapter grid asked for three columns');
    assert.equal(record.frame.menu.folded, true, 'the grid folded rather than overlap');
    assert.equal(record.frame.menu.columns, 2, 'the third column folded into the other two');
    assert.equal(record.frame.menu.maxRows, 16, 'sixteen rows a column, from thirty-two rows in two');
    assert.equal(record.frame.menu.outboard, 1, 'the bearing bought nothing and none was spent');
    assert.equal(h.toolbar.layout().maxRows, 16, 'the fold is in the layout the panel was built from');

    // Every row survives the fold, at the size it was drawn at before it.
    assert.equal(drawnRowCount(h.toolbar), h.toolbar.rowCount());
    assert.equal(drawnColumns(h.toolbar), 2);
    const labels = drawnLabels(h.records);
    for (const label of ['Back', 'Next', 'Pg 1/2', 'Opaque +', 'Re-seat']) {
      assert.ok(labels.includes(label), `${label} survives the fold`);
    }
    assert.equal(clearance(scene, geometry, h.toolbar.drawnMenuPoints()).alreadyClear, true);
  } finally { await h.restore(); }
});

test('the fold is dropped when the lesson ends', async () => {
  const scene = d106Scene();
  const h = await seatedHarness(scene);
  try {
    await h.toolbar.update();
    const resting = h.toolbar.layout().maxRows;
    h.setState({ ...RESTING, tour: CHAPTER });
    await h.toolbar.update();
    assert.equal(h.toolbar.layout().maxRows, 16, 'a chapter folds the grid');
    h.setState({ ...RESTING, tour: { active: false, step: -1 } });
    await h.toolbar.update();
    assert.equal(h.toolbar.layout().maxRows, resting,
      'the resting menu keeps the shipped column height');
    assert.equal(h.standoffs('tour-chapter').length, 1, 'a finished lesson solves nothing');
  } finally { await h.restore(); }
});

test('a recovery caption keeps the narrow grid clear and stable', async () => {
  const scene = d106Scene();
  const geometry = resetEntryGeometry(scene);
  const h = await seatedHarness(scene);
  try {
    await h.toolbar.update();
    h.setState({ ...RESTING, tour: CHAPTER });
    await h.toolbar.update();
    await h.frames(2);
    assert.equal(drawnColumns(h.toolbar), 2);
    h.setState({ ...RESTING, tour: { ...CHAPTER, autoplay: false, feedbackError: true,
      feedback: 'Journey could not render: Growing the structure stalled: its placed step did not finish within 45 seconds in the headset.. Previous view restored.' } });
    await h.toolbar.update();
    assert.equal(h.toolbar.layout().maxRows, 16);
    const plates = h.records.filter(r => r.kind === 'toolbar' && r.detail.phase === 'plates').at(-1);
    assert.equal(plates.detail.styles.filter(style => style === 'backing').length, 2,
      'only menu and caption glass are drawn; no unused blank status backing');
    assert.match(h.toolbar.readoutText().join(' '), /Tour paused\. Previous view restored\./);
    const commits = h.records.filter(r => r.kind === 'toolbar' && r.detail.phase === 'rows').length;
    await h.frames(72);
    await h.toolbar.update();
    assert.equal(h.records.filter(r => r.kind === 'toolbar' && r.detail.phase === 'rows').length, commits,
      'the recovery caption does not repeatedly reseat/rebuild the toolbar');
    assert.equal(drawnColumns(h.toolbar), 2, 'a failed re-solve must not unfold a third column over the molecule');
    assert.equal(drawnRowCount(h.toolbar), h.toolbar.rowCount(), 'every control remains drawn');
    assert.equal(clearance(scene, geometry, h.toolbar.drawnMenuPoints()).alreadyClear, true);
  } finally { await h.restore(); }
});

test('only a confirmed rollback gets the short wearer outcome', async () => {
  const runtime = await toolbarFrameRuntime();
  const feedback = 'Journey could not render: placed exceeded 45 seconds. Previous view restored.';
  const tour = { feedbackError: true, feedback };
  assert.equal(runtime.toolbarTourFeedback(tour), 'Tour paused. Previous view restored.');
  assert.equal(runtime.plateStatusSentence(tour), runtime.toolbarTourFeedback(tour));
  assert.equal(runtime.tourReadout(tour, SUBJECT)[0].text, runtime.toolbarTourFeedback(tour));
  assert.equal(tour.feedback, feedback, 'the detailed host receipt is unchanged');
  for (const text of ['Journey could not render: placed exceeded 45 seconds. Recovery failed.',
    'Structure load failed. Use Retry loading on the page.', 'Previous view restored.']) {
    assert.equal(runtime.toolbarTourFeedback({ feedbackError: true, feedback: text }), text);
  }
});

test('the seat is solved on the column edge, not on every redraw', async () => {
  const scene = d106Scene();
  const h = await seatedHarness(scene);
  try {
    await h.toolbar.update();
    h.setState({ ...RESTING, tour: CHAPTER });
    await h.toolbar.update();
    assert.equal(h.standoffs('tour-chapter').length, 1);
    // A new chapter with the same rows: the caption changes, the grid does not.
    h.setState({ ...RESTING, tour: { ...CHAPTER, step: 3, progress: 'Scene 4 / 20',
      title: 'The central cavity', bodyPage: 'Between the four subunits a water-filled cavity runs the length of the tetramer.' } });
    await h.toolbar.update();
    await h.frames(72);
    assert.equal(h.standoffs('tour-chapter').length, 1,
      'an unchanged column count re-solves nothing, and a frame never solves');
  } finally { await h.restore(); }
});
