import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { toolbarFrameRuntime } from './fixtures/toolbar-frame-runtime.mjs';
import { lessonSeatSession, SEAT_LESSONS } from './fixtures/lesson-seat-session.mjs';
import { pageFunction } from './fixtures/label-action-harness.mjs';
import { headViewBasis, placementFromRoom } from './room-anchor.mjs';
import { measurePlateSeat } from './plate-seat.mjs';
import { resetViewPlacement } from './reset-view-placement.mjs';
import { LABEL_CHARACTER_DEGREES } from './label-facing.mjs';
import { WEARER_SCALE_RANGE } from './placement-limits.mjs';

/**
 * A lesson chapter is on show and an assistant loads another structure under
 * it. The new structure's entry seat is solved before its first frame, against
 * the glass drawn at that instant: the outgoing chapter's card and controls.
 * With that glass at eye level on the wearer's right, every seat step failed
 * and the fitter shrank the size until a sliver cleared it: the nucleosome was
 * seated 7 mm across, its appearance could not be measured in either eye, and
 * the load failed.
 *
 * The swapped-source seat now keeps at least the smallest size the wearer can
 * reach by hand, one `WEARER_SCALE_RANGE`th of its entry size, and takes the
 * menu move or hide the solver names for it. Every other menu seat gives the
 * seat it gave before.
 *
 * The shipped `seatSwappedSource`, `roomAnchorPlacement` and
 * `applySeatMenuRecovery` run over the real toolbar, its relocation seats and
 * the seat solver; the lesson session draws the chapter card.
 */
const runtime = await toolbarFrameRuntime();
const viewerSource = readFileSync(process.env.OVERPRINT_VIEWER_BASELINE ?? new URL('./viewer.mjs', import.meta.url), 'utf8');
const SCENE_SCALE = .02348;
for (const [name, spec] of Object.entries({ '4HHB': { file: 'hemoglobin.json', composite: '4HHB.cif', plain: true },
  nucleosome: { file: 'nucleosome.json', composite: '1KX5.cif' },
  'telomerase-haca': { file: 'telomerase-haca.json', composite: '8OUE.cif' } })) SEAT_LESSONS[name] = { ...spec, cameraScale: SCENE_SCALE };
// What the tour client holds while a grow or an assistant's open replaces the source.
const HELD = { active: true, navigating: true, menuOpen: false, sourceTransition: true };
const r = value => Math.round(value * 1000) / 1000;
// The lesson session reads its demos from the local demo cache.
const needsCache = process.env.STEREOFOLD_DEMO_CACHE ? {} : { skip: 'set STEREOFOLD_DEMO_CACHE to the demo cache folder' };

async function session() {
  const s = await lessonSeatSession(runtime);
  const h = s.h;
  h.canvas.xr = { isPresenting: { value: true } };
  h.canvas.webgl = { ...(h.canvas.webgl ?? {}), xr: { session: {} } };
  s.outcomes = []; s.anchorRecords = [];
  Object.assign(h, { headViewBasis, placementFromRoom, measurePlateSeat, resetViewPlacement, LABEL_CHARACTER_DEGREES,
    xrLabelSizing: () => ({ characterUnits: 1 }), componentLabelTextWidth: () => 0, componentLabelsWanted: () => false,
    plugin: {}, sessionDeviceClass: () => 'quest2', structureAtomSites: () => 20000,
    latestSeatStandoffMeters: null, latestPlateSeat: null, roomEntry: {}, retainedPoseHidden: false, roomAnchor: null,
    recordManipulation: (kind, detail) => { s.outcomes.push({ kind, ...detail }); } });
  h.immersiveSession = { ...h.immersiveSession, toolbarPlacementPoints: options => s.t.toolbar.placementPoints(options),
    toolbarRelocationCandidates: pose => s.t.toolbar.prepareRelocation(pose),
    relocateToolbar: candidate => s.t.toolbar.commitRelocation(candidate), platePoints: () => s.t.toolbar.platePoints?.() ?? [] };
  vm.runInContext('var pendingRoomSeat = false;', h);
  for (const name of ['componentLabelViewBasis', 'roomAnchorPlacement', 'applySeatMenuRecovery', 'seatSwappedSource'])
    vm.runInContext(pageFunction(viewerSource, name), h);
  const diagnostics = h.__stereofoldDiagnostics;
  h.__stereofoldDiagnostics = { ...diagnostics, record: (kind, detail) => {
    if (kind === 'source-anchor') s.anchorRecords.push(detail);
    return diagnostics?.record?.(kind, detail);
  } };
  const setState = s.t.setState;
  s.t.setState = value => setState(s.held ? { ...value, tour: s.held } : value);
  return s;
}

/** Seat the open structure as a fresh load does, and draw the menu against it. */
async function seat(s) {
  const placed = s.h.roomAnchorPlacement({ mode: 'auto', floorY: null, sphere: s.h.loadedSphere() });
  s.h.inspectionState.place({ translation: placed.translation, scale: placed.scale }, 'entry-seat');
  s.publish(); await s.t.toolbar.update(); await s.settle();
  return placed;
}

/** Telomerase's opening chapter on show, then the nucleosome loads under it. */
async function nucleosomeUnderChapter(s) {
  await s.open('4HHB'); await seat(s);
  await s.open('telomerase-haca'); await seat(s);
  await s.start(0);
  const pose = s.h.latestRoomPlacementPose;
  const seats = s.t.toolbar.prepareRelocation(pose).filter(candidate => !candidate.hide).map(candidate => candidate.id);
  s.held = { ...s.tour(), ...HELD };
  vm.runInContext('paintingChapter = undefined; paintingTurn = undefined; spinningChapter = null; spins = false; lastSpinProof = null;', s.h);
  await s.open('nucleosome');
  return { pose, seats };
}

/** The size the open structure takes at entry with no glass in the way. */
function entrySize(s) {
  const points = s.h.immersiveSession.toolbarPlacementPoints;
  s.h.immersiveSession.toolbarPlacementPoints = () => [];
  try { return s.h.roomAnchorPlacement({ mode: 'auto', floorY: null, sphere: s.h.loadedSphere() }).metersAcross; }
  finally { s.h.immersiveSession.toolbarPlacementPoints = points; }
}

/** Put the outgoing menu at one of its lesson seats, as a chapter card seat would. */
async function menuAt(s, pose, id) {
  const candidate = s.t.toolbar.prepareRelocation(pose).find(c => c.id === id);
  if (!candidate) return false;
  await s.t.toolbar.commitRelocation(candidate);
  await s.settle();
  return true;
}

/** The swapped source's seat, through the load's own call. */
function swapSeat(s) {
  s.h.latestHeadSample = s.h.performance.now();
  const anchor = { usedCameraScale: false, placement: s.h.inspectionSnapshot().placement };
  return s.h.seatSwappedSource(anchor, { deferAnchor: true });
}

test('a structure loaded under a chapter card at eye level on the right keeps a usable size', needsCache, async t => {
  const s = await session();
  try {
    const { pose } = await nucleosomeUnderChapter(s);
    const open = entrySize(s);
    assert.ok(await menuAt(s, pose, 'lesson-top-1-0.2'), 'the lesson offers the eye-level seat on the right');
    const menuBefore = s.seat().map(r);
    const placed = swapSeat(s);
    await placed?.menuMove; await s.settle();
    assert.ok(placed, 'the seat is solved before the first frame');
    t.diagnostic(`entry ${r(open)} m; seat ${r(placed.metersAcross)} m; menu ${placed.menuRelocation ?? 'kept'}`);
    assert.equal(s.h.pendingRoomSeat, false);
    // The bound: the smallest size the wearer can shrink an entry to by hand.
    // A seat below it is one the wearer could never have chosen.
    const floor = open / WEARER_SCALE_RANGE;
    assert.ok(placed.metersAcross >= floor,
      `the nucleosome is ${r(placed.metersAcross)} m across, at least ${r(floor)} m (entry ${r(open)} m)`);
    assert.equal(s.h.inspectionSnapshot().placement.scale, placed.scale, 'the structure stands at that seat');
    // The record names the path: the fitter's step, the entry size before the
    // fit, the seat the outgoing glass stood at and the menu move made.
    t.diagnostic(`record ${JSON.stringify(s.anchorRecords)}`);
    assert.deepEqual(s.anchorRecords.map(({ anchor, step, menuSeat, menuMove }) => ({ anchor, step, menuSeat, menuMove })),
      [{ anchor: 'entry-seat', step: placed.menuRelocation === 'hidden' ? 'menu-hidden' : 'menu-moved',
        menuSeat: 'lesson-top-1-0.2', menuMove: placed.menuRelocation }]);
    assert.ok(s.anchorRecords[0].entryScale > placed.scale, 'the entry size before the fit is recorded');
    // The wearer keeps a menu clear of it, or is told how to bring it back.
    assert.ok(placed.menuRelocation !== undefined, 'the seat names the menu move that clears it');
    if (placed.menuRelocation === 'hidden') {
      assert.deepEqual(s.outcomes.at(-1), { kind: 'outcome', status: 'adjusted', action: 'fit',
        reason: 'Controls hidden to show the structure. B/Y brings them back.' });
    } else {
      assert.notDeepEqual(s.seat().map(r), menuBefore, `the menu moved to ${placed.menuRelocation}`);
      // Against the glass now drawn, the seat needs no further shrinking.
      const again = s.h.roomAnchorPlacement({ mode: 'auto', floorY: null, sphere: s.h.loadedSphere() });
      assert.ok(again.metersAcross >= placed.metersAcross - 1e-6,
        `the moved menu clears the seat (${r(again.metersAcross)} m against ${r(placed.metersAcross)} m)`);
    }
  } finally { await s.dispose(); }
});

// Before this change, the seat at every lesson menu seat beside the one above.
const UNCHANGED = {
  'lesson-top-1-0': [1.308, undefined], 'lesson-top-1--0.2': [1.308, undefined],
  'lesson-top-1-0.4': [.503, 'lesson-top-1-0'], 'lesson-top-1-0.6': [.503, 'lesson-top-1-0'],
  'lesson-top--1-0': [1.308, undefined], 'lesson-top--1-0.2': [1.308, undefined], 'lesson-top--1--0.2': [1.308, undefined],
  'lesson-top--1-0.4': [1.308, undefined], 'lesson-top--1-0.6': [1.308, undefined],
  'lesson-bottom-1-0.4': [.503, 'lesson-top-1-0'], 'lesson-bottom-1-0.6': [.503, 'lesson-top-1-0'],
  'lesson-bottom-1-0.8': [.666, undefined],
  'lesson-bottom--1-0.2': [1.308, undefined], 'lesson-bottom--1-0.4': [1.308, undefined],
  'lesson-bottom--1-0.6': [1.308, undefined], 'lesson-bottom--1-0.8': [1.308, undefined],
};

test('at every other lesson menu seat the swapped structure takes the seat it took before', needsCache, async t => {
  const s = await session();
  try {
    const { pose, seats } = await nucleosomeUnderChapter(s);
    const floor = entrySize(s) / WEARER_SCALE_RANGE, seen = {};
    for (const id of seats) {
      if (!await menuAt(s, pose, id)) continue;
      const placed = s.h.roomAnchorPlacement({ mode: 'auto', floorY: null, sphere: s.h.loadedSphere(), entryFloor: true });
      seen[id] = [r(placed.metersAcross), placed.menuRelocation];
      // The eye-level seats on the right are the case above.
      if (!(id in UNCHANGED)) assert.ok(placed.metersAcross >= floor, `${id}: ${r(placed.metersAcross)} m`);
    }
    t.diagnostic(JSON.stringify(seen));
    for (const [id, expected] of Object.entries(UNCHANGED)) if (id in seen) assert.deepEqual(seen[id], expected, id);
    assert.ok(Object.keys(seen).length >= 10, `measured ${Object.keys(seen).join(' ')}`);
  } finally { await s.dispose(); }
});

test('a menu move the toolbar refuses is recorded as a failed attempt, never as a move', needsCache, async () => {
  const s = await session();
  try {
    const { pose } = await nucleosomeUnderChapter(s);
    assert.ok(await menuAt(s, pose, 'lesson-top-1-0.2'), 'the lesson offers the eye-level seat on the right');
    // The menu changes seat between the solve and the move, as when the
    // wearer takes it: the toolbar refuses the move the seat named.
    s.h.immersiveSession.relocateToolbar = async candidate => {
      await menuAt(s, pose, 'lesson-top--1-0');
      return s.t.toolbar.commitRelocation(candidate);
    };
    const placed = swapSeat(s);
    await placed?.menuMove; await s.settle();
    assert.ok(placed?.menuRelocation, 'the seat names a menu move');
    assert.equal(s.anchorRecords.length, 1, JSON.stringify(s.anchorRecords));
    const [written] = s.anchorRecords;
    assert.equal(written.step, 'menu-failed');
    assert.equal(written.menuAttempt, placed.menuRelocation);
    assert.match(written.menuError, /menu changed/);
    assert.equal('menuMove' in written, false, 'no move the wearer did not get');
  } finally { await s.dispose(); }
});

test('a load that fails after the menu moved brings the previous structure back with the menu where it stood', needsCache, async () => {
  const s = await session();
  try {
    const { pose } = await nucleosomeUnderChapter(s);
    assert.ok(await menuAt(s, pose, 'lesson-top-1-0.2'), 'the lesson offers the eye-level seat on the right');
    const menuBefore = s.seat().map(r);
    const placed = swapSeat(s);
    const receipt = await placed?.menuMove; await s.settle();
    assert.ok(receipt?.rollback, 'the toolbar moved the menu and returned its receipt');
    assert.notDeepEqual(s.seat().map(r), menuBefore, 'the menu moved for the new structure');
    // The load keeps that receipt on itself, so its rollback can undo the move.
    const seatAt = viewerSource.indexOf('committedRoomSeat = seatSwappedSource(');
    const load = viewerSource.slice(seatAt, viewerSource.indexOf("'after_room_anchor'", seatAt));
    assert.match(load, /const menuReceipt = await committedRoomSeat\?\.menuMove;\s*if \(operation\) operation\.menuRollback = menuReceipt\?\.rollback;/);
    // The load then fails at the room anchor: the shipped rollback restores the
    // previous structure, whose appearance is checked against the menu.
    const order = [];
    let menuAtAppearance;
    const c = vm.createContext({ state: { contextLossCount: 0, status: 'loading' }, representation: {},
      retainedRepresentationCount: 0, stylesState: [], visibilityState: {}, recoveryRecord: undefined,
      canvas: { camera: {}, webgl: { isContextLost: false }, commit() {} },
      deleteRecord: async () => {}, adopt() {}, removeFrameCover() {}, waitForFrame: async () => {},
      normalizeStyles: value => value, normalizeVisibility: value => value, restoreRetainedLessonState() {},
      inspectionState: { restoreCheckpoint() { order.push('placement'); } },
      restoreRecord: async () => { order.push('structure'); },
      applyInspectionAppearance: async () => { await s.settle(); order.push('appearance'); menuAtAppearance = s.seat().map(r); } });
    vm.runInContext(pageFunction(viewerSource, 'rollbackLoad'), c);
    await c.rollbackLoad({ previous: { styles: [], visibility: {} }, contextLossCount: 0, inspectionCheckpoint: {},
      menuRollback: receipt.rollback, failedPhase: 'after_room_anchor' }, Error('Injected after_room_anchor failure'));
    assert.deepEqual(order, ['placement', 'structure', 'appearance']);
    assert.equal(c.state.lastLoadFailure.recovered, true);
    assert.deepEqual(menuAtAppearance, menuBefore, 'the previous structure is checked against the menu seat it had');
  } finally { await s.dispose(); }
});

test('a sideways fit at the entry size and depth is recorded as lateral, not as the entry seat kept', needsCache, async () => {
  const s = await session();
  try {
    await nucleosomeUnderChapter(s);
    // With no glass in the way the fitter keeps the entry seat itself.
    const points = s.h.immersiveSession.toolbarPlacementPoints;
    s.h.immersiveSession.toolbarPlacementPoints = () => [];
    const real = s.h.roomAnchorPlacement;
    const steps = [];
    try {
      for (const sideways of [0, .25]) {
        // The fitter's answer when a sideways shift alone clears the menu:
        // the entry size and depth, the translation moved along the wearer's right.
        s.h.roomAnchorPlacement = options => {
          const seat = real(options);
          return { ...seat, translation: seat.translation.map((value, axis) => axis === 0 ? value + sideways : value) };
        };
        s.anchorRecords.length = 0;
        const placed = swapSeat(s);
        assert.ok(placed, 'the seat is solved before the first frame');
        assert.equal(placed.scale, placed.entryScale);
        assert.ok(!placed.resetTravelMeters && !placed.verticalTravelMeters && placed.menuRelocation === undefined);
        steps.push(s.anchorRecords[0]?.step);
      }
    } finally { s.h.roomAnchorPlacement = real; s.h.immersiveSession.toolbarPlacementPoints = points; }
    assert.deepEqual(steps, ['entry', 'lateral']);
  } finally { await s.dispose(); }
});
