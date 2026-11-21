import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { toolbarFrameRuntime, toolbarFrameHarness } from './fixtures/toolbar-frame-runtime.mjs';
import { lessonSeatSession, SEAT_LESSONS } from './fixtures/lesson-seat-session.mjs';
import { pageFunction } from './fixtures/label-action-harness.mjs';
import { headViewBasis, placementFromRoom } from './room-anchor.mjs';
import { measurePlateSeat } from './plate-seat.mjs';
import { resetViewPlacement } from './reset-view-placement.mjs';
import { LABEL_CHARACTER_DEGREES } from './label-facing.mjs';

// A demo opened by name loads while the panel holds the presentation it had
// (`beginSourceTransition` in the plugin's tour client). The new source's room
// seat, its lesson's tour placement, the first draw of its controls and, for
// a plain opening chapter, its opening seat are all solved before that hold
// ends, against whatever glass the hold draws. Over a lesson on screen the
// hold was that lesson's chapter, at the seat its clearance chose, and the
// nucleosome opened 1.3 m across after CRISPR-Cas9's second chapter and
// 3.5 m when opened first. A different lesson now holds the loading state a
// first opening holds and says it is an opening (`tour.opening`), and the
// menu starts again from the wearer's seat when the new source draws.

const runtime = await toolbarFrameRuntime();
const cache = process.env.STEREOFOLD_DEMO_CACHE;
const viewerSource = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
// One scene scale for every structure, the one the headset entered 4HHB at.
const SCENE_SCALE = .02348;
for (const [name, spec] of Object.entries({ '4HHB': { file: 'hemoglobin.json', composite: '4HHB.cif', plain: true },
  nucleosome: { file: 'nucleosome.json', composite: '1KX5.cif' }, 'crispr-cas9': { file: 'crispr-cas9.json', composite: '9KJ6.cif' },
  'telomerase-haca': { file: 'telomerase-haca.json', composite: '8OUE.cif' } })) SEAT_LESSONS[name] = { ...spec, cameraScale: SCENE_SCALE };
const mm = points => JSON.stringify(points, (k, v) => typeof v === 'number' ? Math.round(v * 1000) : v);
const LOADING = { title: 'Loading structure', bodyPage: 'The next structure is being prepared.', step: 0, total: 1 };
const FORCED = { active: true, navigating: true, menuOpen: false, sourceTransition: true };

/** A headset session whose structures take the page's own room seat (`roomAnchorPlacement`). */
async function session() {
  const s = await lessonSeatSession(runtime);
  const h = s.h;
  h.canvas.xr = { isPresenting: { value: true } };
  h.canvas.webgl = { ...(h.canvas.webgl ?? {}), xr: { session: {} } };
  Object.assign(h, { headViewBasis, placementFromRoom, measurePlateSeat, resetViewPlacement, LABEL_CHARACTER_DEGREES,
    xrLabelSizing: () => ({ characterUnits: 1 }), componentLabelTextWidth: () => 0, componentLabelsWanted: () => false,
    plugin: {}, sessionDeviceClass: () => 'quest2', structureAtomSites: () => 20000,
    latestSeatStandoffMeters: null, latestPlateSeat: null, roomEntry: {}, retainedPoseHidden: false });
  h.immersiveSession = { ...h.immersiveSession, toolbarPlacementPoints: options => s.t.toolbar.placementPoints(options),
    toolbarRelocationCandidates: pose => s.t.toolbar.prepareRelocation(pose) };
  for (const name of ['componentLabelViewBasis', 'roomAnchorPlacement']) vm.runInContext(pageFunction(viewerSource, name), h);
  // While the hold stands, every state the toolbar is handed carries the held
  // tour, as `getPresentationState` gives it.
  const setState = s.t.setState;
  s.t.setState = value => setState(s.held ? { ...value, tour: s.held } : value);
  return s;
}
const solve = s => s.h.roomAnchorPlacement({ mode: 'auto', floorY: null, sphere: s.h.loadedSphere() });
async function seat(s) {
  const placed = solve(s);
  s.h.inspectionState.place({ translation: placed.translation, scale: placed.scale }, 'entry-seat');
  s.publish(); await s.t.toolbar.update(); await s.settle();
}
/** The held tour `beginSourceTransition` gives: the chapter on screen, a loading card, or an opening. */
function hold(s, { opening = false } = {}) {
  const shown = s.tour();
  const { selectedId, selectedTitle, captionCard, chapterStartedAt, chapterPreview, motionKind, ...rest } = shown ?? {};
  const resting = { ...rest, bodyPageIndex: 0, bodyPageCount: 1, feedback: '', progress: 'Tours', stopped: false, autoplay: false,
    canBack: false, canNext: false, canPlay: false, motionRunning: false, opening: true };
  s.held = { ...(shown?.active && !opening ? shown : opening ? { ...resting, ...LOADING } : { ...(shown ?? {}), ...LOADING }), ...FORCED };
}
/**
 * A demo opened by name, up to its opening seat: the room seat its source
 * takes, the tour placement (authored scale 1, fitted clear of the drawn glass
 * as `clearHeldPlatePlacement` fits it), the chapter controls' draw. Returns
 * the menu's seat and every glass point the opening seat measures.
 */
async function openHeld(s, name) {
  // The page forgets a spinning chapter with its source (`forgetChapterSpin`).
  vm.runInContext('paintingChapter = undefined; paintingTurn = undefined; spinningChapter = null; spins = false; lastSpinProof = null;', s.h);
  await s.open(name);
  await seat(s);
  const h = s.h, sphere = h.loadedSphere(), pose = h.latestRoomPlacementPose;
  let placed = { translation: [...h.inspectionSnapshot().placement.translation], scale: 1 };
  const fitted = h.fitChapterField({ placement: placed, bounds: h.chapterFieldBounds(1), center: sphere.center, radius: sphere.radius,
    cameraScale: h.canvas.camera.scale, ...pose, views: pose.labelViews, menuPoints: s.t.toolbar.platePoints(),
    standoff: h.latestSeatStandoffMeters ?? undefined });
  if (fitted.field) placed = { translation: fitted.translation, scale: fitted.scale };
  h.inspectionState.place(placed, 'tour-placement');
  s.publish(); await s.t.toolbar.update(); await s.settle();
  s.publish(); await s.t.toolbar.update(); await s.settle();
  return { seat: mm(s.seat()), points: mm(s.t.toolbar.placementPoints({ headInRoom: pose.headInRoom })), scale: solve(s).scale };
}
async function opened(before, name = 'nucleosome') {
  const s = await session();
  try {
    await s.open('4HHB'); await seat(s);
    if (before) { hold(s); await s.open(before); await seat(s); s.held = undefined; await s.start(0); await s.chapter(1); }
    const left = mm(s.t.toolbar.glassPlates());
    hold(s, { opening: Boolean(before) });
    return { left, ...await openHeld(s, name) };
  } finally { await s.dispose(); }
}

// The seat rule alone, as `opening-menu-seat.test.mjs` checks it: the
// clearance proof is a stub that moves the glass where a test says.
const near = (a, b) => Boolean(a && b) && a.every((v, i) => Math.abs(v - b[i]) < 1e-6);
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
function seatSession() {
  let moveTo, state = {};
  const f = toolbarFrameHarness(runtime, { state, presentation: { setRoomOffset() {} }, beforeMenuDraw: async () => moveTo
    ? { menuRelocation: { head: { matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1.6, 0, 1], position: { x: 0, y: 1.6, z: 0 } },
      anchor: moveTo, constants: runtime.SPATIAL_TOOLBAR_LAYOUT } } : undefined });
  const draw = async (next, options) => {
    state = { voice: { state: 'idle' }, placementMoves: 0, placementHeld: false, ...next }; f.setState(state);
    await f.toolbar.update(options); await settle();
  };
  const tour = (lesson, step, extra) => ({ selectedId: lesson, active: true, step, total: 3, title: 'One', bodyPage: 'One.', ...extra });
  return { f, relocateTo: anchor => { moveTo = anchor; },
    show: (source, lesson) => draw({ subject: { sourceSha256: source, title: source }, tour: lesson && { selectedId: lesson, active: false, step: -1, total: 3 } }),
    async start(source, lesson) {
      await draw({ subject: { sourceSha256: source, title: source }, tour: tour(lesson, 0, { navigating: true }) }, { restoreTourSeat: true, restartTourSeat: true });
      await draw({ subject: { sourceSha256: source, title: source }, tour: tour(lesson, 0) });
    },
    chapter: (source, lesson, step) => draw({ subject: { sourceSha256: source, title: source }, tour: tour(lesson, step) }),
    // The held presentation while the next source loads, as the tour client gives it.
    loading: (source, held) => draw({ subject: { sourceSha256: source, title: source }, tour: { ...held, ...LOADING, ...FORCED } }) };
}

test('a different lesson opened over a chapter on screen draws from the session seat while it loads', async () => {
  // Opened first: the loading card drawn from the entry seat.
  const fresh = seatSession();
  let entry;
  try {
    await fresh.show('4HHB');
    await fresh.loading('4HHB', {});
    await fresh.loading('1KX5', {});
    entry = fresh.f.toolbar.seatAnchor();
  } finally { await fresh.f.toolbar.dispose(); }
  const s = seatSession();
  try {
    await s.show('4HHB');
    await s.show('8OUE', 'lesson-a');
    s.relocateTo([.55, 1.1, -1.2]);
    await s.start('8OUE', 'lesson-a');
    s.relocateTo(undefined);
    await s.chapter('8OUE', 'lesson-a', 1);
    assert.ok(near(s.f.toolbar.seatAnchor(), [.55, 1.1, -1.2]), 'the chapter\'s clearance seat');
    // Held while it loads: the outgoing structure first, then the new one.
    await s.loading('8OUE', { opening: true });
    await s.loading('1KX5', { opening: true });
    assert.ok(near(s.f.toolbar.seatAnchor(), entry), JSON.stringify({ opened: s.f.toolbar.seatAnchor(), first: entry }));
  } finally { await s.f.toolbar.dispose(); }
});

test('a trigger press on the menu that crosses the drag threshold while another lesson starts loading carries the menu', async () => {
  const s = seatSession();
  try {
    await s.show('4HHB');
    await s.show('8OUE', 'lesson-a');
    await s.start('8OUE', 'lesson-a');
    const before = s.f.toolbar.seatAnchor();
    // The trigger goes down on the chapter's Play row, under the drag threshold.
    const pressed = await s.f.toolbar.aimSynthetic({ drag: { phase: 'begin', id: 'tour', kind: 'trigger' } });
    assert.equal(pressed.accepted, true, pressed.reason);
    // A different demo starts loading, and the hand moves before its redraw lands.
    const loading = s.loading('1KX5', { opening: true });
    const moved = await s.f.toolbar.aimSynthetic({ drag: { phase: 'move', offset: [-.12, -.05, 0] } });
    await loading;
    assert.equal(moved.accepted, true, moved.reason);
    assert.equal((await s.f.toolbar.aimSynthetic({ drag: { phase: 'end' } })).accepted, true);
    await settle(); await s.f.frames(12); await settle();
    const after = s.f.toolbar.seatAnchor();
    assert.ok(Math.hypot(...after.map((v, i) => v - before[i])) > .1, `the menu followed the hand: ${JSON.stringify({ before, after })}`);
  } finally { await s.f.toolbar.dispose(); }
});

test('a source loading under the lesson on screen, not an opening, keeps the chapter\'s seat while it loads', async () => {
  const s = seatSession();
  try {
    await s.show('4HHB');
    await s.show('8OUE', 'lesson-a');
    s.relocateTo([.55, 1.1, -1.2]);
    await s.start('8OUE', 'lesson-a');
    s.relocateTo(undefined);
    await s.loading('8OUE-stage-2', { selectedId: 'lesson-a', step: 0, total: 3 });
    assert.ok(near(s.f.toolbar.seatAnchor(), [.55, 1.1, -1.2]));
  } finally { await s.f.toolbar.dispose(); }
});

test('the nucleosome opened over another lesson\'s second chapter measures the glass it measures when opened first', { skip: !cache }, async t => {
  const first = await opened();
  for (const before of ['crispr-cas9', 'telomerase-haca']) {
    const after = await opened(before);
    t.diagnostic(`after ${before} chapter 2: menu ${after.seat}, scale ${after.scale}; opened first: menu ${first.seat}, scale ${first.scale}`);
    assert.notEqual(after.left, first.left, `${before} chapter 2 left its glass elsewhere than the entry glass`);
    assert.equal(after.seat, first.seat, `after ${before}: the menu is back at the wearer's seat before the opening seat is solved`);
    assert.equal(after.points, first.points, `after ${before}: the opening seat measures the glass a first opening measures`);
    assert.equal(after.scale, first.scale, `after ${before}: the opening seat`);
  }
});

test('a source the lesson on screen loads itself, with no opening, keeps that lesson\'s menu seat while it loads', { skip: !cache }, async () => {
  const s = await session();
  try {
    await s.open('4HHB'); await seat(s);
    await s.open('crispr-cas9'); await seat(s); await s.start(0); await s.chapter(1);
    const left = mm(s.seat());
    hold(s);
    await s.open('nucleosome'); s.publish(); await s.t.toolbar.update(); await s.settle();
    assert.equal(mm(s.seat()), left);
  } finally { await s.dispose(); }
});

test('a menu the wearer dragged stays where they put it when another lesson opens by name', { skip: !cache }, async () => {
  const s = await session();
  try {
    await s.open('4HHB'); await seat(s);
    await s.open('crispr-cas9'); await seat(s); await s.start(0);
    assert.equal((await s.t.toolbar.aimSynthetic({ drag: { phase: 'begin', id: 'tour', kind: 'grip' } })).accepted, true);
    assert.equal((await s.t.toolbar.aimSynthetic({ drag: { phase: 'move', offset: [-.12, -.05, 0] } })).accepted, true);
    assert.equal((await s.t.toolbar.aimSynthetic({ drag: { phase: 'end' } })).accepted, true);
    await s.settle(); await s.t.frames(12); await s.settle();
    const dragged = mm(s.seat());
    hold(s, { opening: true });
    await s.open('nucleosome'); s.publish(); await s.t.toolbar.update(); await s.settle();
    assert.equal(mm(s.seat()), dragged);
  } finally { await s.dispose(); }
});
