import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

/**
 * On a Quest 2 the entry seat is settled from the XR
 * frame loop, and a seat the solver refused used to be logged and solved
 * again on the very next frame. With the full menu open and a microtubule
 * loaded that put the page at 1.3 fps with the refusal in the console every
 * 0.3 s, the menu re-laid on each attempt, and the molecule left where the
 * reload had restored it. These tests run the viewer's own `settleInRoom`
 * against a solver stub the way the frame loop does: once a frame, for as
 * long as the anchor still wants a settle.
 */
const viewer = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
const closure = name => {
  const start = viewer.indexOf(`  function ${name}(`);
  assert.ok(start >= 0, name);
  return viewer.slice(start, viewer.indexOf('\n  }', start) + 4);
};
const REFUSAL = 'Could not reset: the entry size cannot fit inside both eyes and clear the menu within 4 m. Press Fit, or move the menu.';
const SEAT = { translation: [0, .4, -2.5], scale: .8, roomPoint: [0, 1.2, -2.5] };
const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
// Values born inside the vm realm carry that realm's prototypes; compare them as plain data.
const plain = value => JSON.parse(JSON.stringify(value));

function harness(solve) {
  const calls = [], placed = [], captions = [], outcomes = [], records = [], errors = [];
  let placement = { translation: [1, 0, -1], rotation: [0, 0, 0], scale: 1.8 }, applied = false;
  const context = vm.createContext({
    retainedPoseHidden: false, retainedEntryCheckPending: false, checkRetainedEntryPose: () => true,
    structuredClone, console: { error: error => errors.push(String(error?.message ?? error)) },
    roomAnchor: { floorY: () => 0, applied: async () => { applied = true; return null; } },
    roomEntry: {}, adoptionGeneration: 1, settlingRoomAnchor: null, busy: false, state: { status: 'ready' },
    interactionActive: () => false, loadedSphere: () => ({ center: [0, 0, 0], radius: 1 }), inspectionState: {},
    latestRoomPlacementPose: { headInRoom: [], labelViews: [{ eye: 'left' }, { eye: 'right' }] }, pendingRoomSeat: true, entryRoomPoint: null,
    roomAnchorPlacement: options => { calls.push(options); return solve(options, calls.length); },
    setInspectionMotion: async () => {},
    placeInspection: async patch => { placed.push(patch); placement = { ...placement, ...patch }; },
    inspectionSnapshot: () => ({ placement }), rebuildComponentLabels: async () => {},
    recordManipulation: (kind, detail) => outcomes.push({ kind, ...detail }),
    talkCaption: { set: value => captions.push(value.outcome) },
    __stereofoldDiagnostics: { record: (kind, detail) => records.push({ kind, ...detail }) },
  });
  vm.runInContext(closure('settleInRoom'), context);
  // The frame loop's own gate: a pending seat, or an anchor that still wants one.
  const frames = async count => {
    for (let i = 0; i < count; i++) { if (context.pendingRoomSeat || !applied) context.settleInRoom({}, {}); await flush(); }
  };
  return { context, calls, placed: () => plain(placed), captions, outcomes: () => plain(outcomes), records: () => plain(records),
    errors, frames, placement: () => plain(placement), seat: () => plain(context.roomEntry.seat ?? null) };
}

test('a seat the solver accepts is placed once and never solved again', async () => {
  const h = harness(() => SEAT);
  await h.frames(6);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.placed(), [{ translation: SEAT.translation, scale: SEAT.scale }]);
  assert.equal(h.context.pendingRoomSeat, false);
  assert.deepEqual(h.seat(), h.placement());
  assert.deepEqual([h.captions, h.outcomes(), h.errors], [[], [], []]);
});

test('plain entry rechecks its controls once after the final seat and initial draw', async () => {
  for (const selectedId of [null, 'authored-lesson']) {
    const h = harness(() => SEAT), checks = [];
    let ready = false;
    h.context.spatialTour = { getState: () => ({ selectedId }) };
    h.context.immersiveSession = { whenReady: async () => { ready = true; }, refreshToolbar: async options => {
      assert.equal(ready, true);
      assert.deepEqual(h.seat(), h.placement());
      checks.push(plain(options));
    } };
    await h.frames(6);
    assert.deepEqual(h.errors, []);
    assert.deepEqual(checks, selectedId ? [] : [{ recheckClearance: true }]);
  }
});

test('the lesson receives tracked entry only after the seat, labels and controls finish', async () => {
  const h = harness(() => SEAT);
  const framed = [];
  let finishLabels, finishControls;
  h.context.rebuildComponentLabels = () => new Promise(resolve => { finishLabels = resolve; });
  h.context.immersiveSession = { whenReady: () => new Promise(resolve => { finishControls = resolve; }) };
  h.context.spatialTour = { current: () => ({ frameXrEntry: async () => {
    framed.push(h.seat());
    assert.equal(h.context.pendingRoomSeat, false);
  } }) };
  const settled = h.context.settleInRoom({}, {});
  await flush();
  assert.equal(framed.length, 0, 'a committed placement alone is too early');
  finishLabels(); await flush();
  assert.equal(framed.length, 0, 'the initial control draw must also finish');
  assert.equal(typeof finishControls, 'function', 'entry must join the initial control draw');
  finishControls(); await settled;
  assert.deepEqual(framed, [h.placement()]);
  await h.frames(6);
  assert.equal(framed.length, 1, 'frame tracking does not repeat chapter framing');
});

test('entry waits for both eye views before solving', async () => {
  const h = harness(() => SEAT);
  h.context.latestRoomPlacementPose.labelViews = [{ eye: 'left' }];
  await h.frames(3);
  assert.equal(h.calls.length, 0);
  assert.equal(h.context.pendingRoomSeat, true);
  h.context.latestRoomPlacementPose.labelViews = [{ eye: 'left' }, { eye: 'right' }];
  await h.frames(1);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.placed(), [{ translation: SEAT.translation, scale: SEAT.scale }]);
});

test('a monoscopic XR primary view can settle the room entry', async () => {
  const h = harness(() => SEAT);
  h.context.latestRoomPlacementPose.labelViews = [{ eye: 'none' }];
  await h.frames(3);
  assert.equal(h.calls.length, 1);
  assert.equal(h.context.pendingRoomSeat, false);
  assert.deepEqual(h.placed(), [{ translation: SEAT.translation, scale: SEAT.scale }]);
});

test('a seat without a safe stereo fit keeps the previous placement', async () => {
  const h = harness(options => { if (options.clearMenu === false) return SEAT; throw Error(REFUSAL); });
  await h.frames(8);
  assert.equal(h.calls.length, 1, 'a menu-free seat must never be committed');
  assert.equal(h.calls[0].clearMenu, undefined);
  assert.deepEqual(h.placed(), []);
  assert.deepEqual(h.placement(), { translation: [1, 0, -1], rotation: [0, 0, 0], scale: 1.8 });
  assert.deepEqual(h.captions, ['Kept your view: the entry size cannot fit inside both eyes and clear the menu within 4 m. Press Fit, or move the menu.']);
  assert.deepEqual(h.outcomes(), [{ kind: 'outcome', status: 'refused', action: 'entry-seat', reason: REFUSAL }]);
  assert.deepEqual(h.records(), [{ kind: 'room-seat', status: 'refused', reason: REFUSAL }]);
  assert.deepEqual(h.errors, [], 'a refusal is an outcome, not a console error');
  assert.equal(h.context.pendingRoomSeat, false);
  assert.equal(h.context.roomEntry.seatRefusal, REFUSAL);
});

test('a seat refused even without the menu keeps the restored placement and is not solved again this entry', async () => {
  const before = { translation: [1, 0, -1], rotation: [0, 0, 0], scale: 1.8 };
  const h = harness(() => { throw Error(REFUSAL); });
  await h.frames(8);
  assert.equal(h.calls.length, 1, 'the first refusal is final for this entry');
  assert.deepEqual(h.placed(), []);
  assert.deepEqual(h.placement(), before);
  assert.equal(h.context.pendingRoomSeat, false, 'the frame loop may now adopt the restored placement as the seat');
  assert.equal(h.context.roomEntry.seatRefusal, REFUSAL);
  assert.deepEqual(h.captions, ['Kept your view: the entry size cannot fit inside both eyes and clear the menu within 4 m. Press Fit, or move the menu.']);
  assert.deepEqual(h.outcomes(), [{ kind: 'outcome', status: 'refused', action: 'entry-seat', reason: REFUSAL }]);
  assert.deepEqual(h.records(), [{ kind: 'room-seat', status: 'refused', reason: REFUSAL }]);
  assert.deepEqual(h.errors, []);
  // The next XR entry is a new seat, and gets its own solve.
  h.context.roomEntry = {}; h.context.pendingRoomSeat = true;
  await h.frames(1);
  assert.equal(h.calls.length, 2);
});

test('an error that is not a refusal keeps its old path: logged, and tried again next frame', async () => {
  const h = harness(() => { throw Error('label views not ready'); });
  await h.frames(3);
  assert.equal(h.calls.length, 3);
  assert.deepEqual(h.errors, ['label views not ready', 'label views not ready', 'label views not ready']);
  assert.deepEqual([h.captions, h.outcomes(), h.placed()], [[], [], []]);
  assert.equal(h.context.pendingRoomSeat, true);
});
