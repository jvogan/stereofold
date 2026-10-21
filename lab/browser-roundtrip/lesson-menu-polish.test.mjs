import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { tourFocusHarness } from './fixtures/tour-focus-harness.mjs';
import { pageFunction } from './fixtures/label-action-harness.mjs';
import { visibleChapterSpheres } from './chapter-field.mjs';
import { readFileSync } from 'node:fs';
import { menuRelocationCandidates } from './menu-relocation.mjs';
import { createToolbarPanel, SPATIAL_TOOLBAR_LAYOUT } from './spatial-toolbar-geometry.mjs';
import { spatialToolbarRows } from './spatial-toolbar-content.mjs';
import { toolbarFrameRuntime, toolbarFrameHarness } from './fixtures/toolbar-frame-runtime.mjs';
import { identity } from './fixtures/component-label-diagnostics.mjs';

const runtime = await toolbarFrameRuntime(undefined, { glyphAdvances: JSON.parse(readFileSync(new URL('./fixtures/toolbar-bold-font-metrics.json', import.meta.url))).advances });
const head = { position: { x: 0, y: 1.6, z: 0 }, matrix: identity() }; head.matrix[13] = 1.6;
const tour = { active: true, selectedId: 'custom', step: 0, total: 3, canNext: true, title: 'A custom molecule', bodyPage: 'Its own chapter.' };
const options = extra => ({ head, stableLesson: true, constants: SPATIAL_TOOLBAR_LAYOUT,
  rows: spatialToolbarRows({ collapsed: true, quiet: true, voice: { state: 'idle' }, tour }),
  readout: runtime.tourReadout(tour), measureText: runtime.toolbarTextWidth,
  assistantLines: ['No assistant connected', 'Hold A or X to talk', 'No action applied yet'],
  assistantGlance: ['No assistant · A/X to talk'], ...extra });

test('loading a first chapter keeps the quiet lesson controls', () => {
  assert.equal(runtime.menuStandsBack({ tour: { ...tour, active: false, navigating: true } }), true);
});

test('a source load cannot inherit the full menu of a pending Done restore', async () => {
  const voice = { state: 'idle' };
  const h = toolbarFrameHarness(runtime, { state: { voice, subject: { title: 'Local structure' } } });
  try {
    await h.toolbar.update();
    h.setState({ voice, tour: { ...tour, navigating: true } });
    await h.toolbar.update();
    await h.toolbar.update({ restoreTourSeat: true });
    h.setState({ voice, tour: { ...tour, navigating: true, sourceTransition: true } });
    await h.toolbar.update();
    assert.equal(h.toolbar.menuRows().length, 4, 'the drawn panel retains the lesson controls');
    assert.equal(h.toolbar.rows().length, 4, 'the hit targets match those controls');
  } finally { await h.toolbar.dispose(); }
});

test('every lesson clearance candidate retains one upright menu and one status card', () => {
  const seats = menuRelocationCandidates(options(), head, { cardOnly: true }); assert.ok(seats.length);
  for (const seat of seats) {
    assert.equal(seat.panel.buttons.length, 4, seat.id);
    assert.equal(seat.panel.statusPoints.length, 1, seat.id);
    assert.ok(seat.panel.statusBacking, seat.id);
    assert.equal(seat.statusless, undefined, seat.id);
    assert.ok(seat.panel.buttons.every(button => Math.sign(button.point[0]) === seat.constants.lessonSide), seat.id);
    assert.ok(seat.panel.right.every((v, i) => Math.abs(v - [1, 0, 0][i]) < 1e-9), seat.id);
  }
});

test('loading, playing, pausing and Done keep the same lesson menu and status dimensions', () => {
  const dimensions = [];
  for (const state of [tour, { ...tour, navigating: true, canNext: false }, { ...tour, autoplay: true }, { ...tour, canNext: false }]) {
    const panel = createToolbarPanel(options({ rows: spatialToolbarRows({ collapsed: true, quiet: true, voice: { state: 'idle' }, tour: state }) }));
    dimensions.push([panel.buttons.length, panel.backing.halfWidth, panel.backing.halfHeight,
      panel.statusBacking.halfWidth, panel.statusBacking.halfHeight]);
  }
  for (const shape of dimensions) assert.deepEqual(shape, dimensions[0]);
});

// Faded context remains visible and must reserve room beside the controls.
test('menu clearance measures faint context as well as the highlighted subject', () => {
  const { h } = tourFocusHarness();
  const cell = value => ({ ref: { value } });
  h.visibleChapterSpheres = visibleChapterSpheres;
  h.scientificRepresentations = () => [{ renderObjects: [{ type: 'mesh', state: { visible: true }, values: {
    boundingSphere: cell({ center: [4, 0, 0], radius: 2 }), uAlpha: cell(.1),
  } }] }];
  h.presentationTransform = () => identity();
  h.lessonFigure = { annotations: () => [] };
  h.molecularAnimation = { fieldEnvelope: () => undefined, representations: () => [] };
  vm.runInContext(pageFunction(readFileSync(process.env.MENU_BASELINE_VIEWER ?? new URL('./viewer.mjs', import.meta.url), 'utf8'), 'chapterFieldBounds'), h);
  const bounds = h.chapterFieldBounds(undefined, { drawn: true });
  assert.ok(bounds, 'the visible context participates in clearance');
  assert.deepEqual(Array.from(bounds.spheres[0].center), [4, 0, 0]);
  assert.equal(bounds.spheres[0].radius, 2);
});
