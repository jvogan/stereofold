import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { molecularLessonToTour } from '../src/molecular-lesson-tour.js';
import { mountTourPlayer, presentedChapterMotion, TOUR_SETTLE_GRIP_WAIT_MS, type Tour } from '../src/tour-player.js';
// @ts-ignore Real player DOM boundary, no browser or device needed.
import { tourEndHarness } from '../../lab/browser-roundtrip/fixtures/tour-end-harness.mjs';
// @ts-ignore The viewer's own camera arithmetic for a lesson move.
import { lessonCameraMove, lessonMoveFrame, lessonMoveFromFrame } from '../../lab/browser-roundtrip/lesson-motion.mjs';

// In a headset the camera is the room frame every chapter, Done's starting view
// and the next structure are seated in, and a chapter's orbit, timed turntable
// or dolly moves that camera. A lesson's later chapters are authored to see the
// turns its earlier chapters made. Haemoglobin's turns do not add up to whole
// circles (195 degrees about up, then 25 about the side), so a play-through left
// the camera turned and tilted for Done and for whatever opened next.
const lesson = (name: string) => molecularLessonToTour(JSON.parse(readFileSync(new URL(`../demos/${name}.json`, import.meta.url), 'utf8')));
const hemoglobin = lesson('hemoglobin');
const wall = lesson('microtubule-growth/wall');
const telomerase = lesson('telomerase-haca');
const spike = lesson('spike');

type Matrix = readonly number[];
const identity: Matrix = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const AXES = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] } as const;
/** A turn of `degrees` about a render-space axis, as `lessonCameraMove` makes it. */
function rotation(axis: 'x' | 'y' | 'z' | readonly number[], degrees: number): Matrix {
  const raw = typeof axis === 'string' ? AXES[axis] : axis;
  const length = Math.hypot(raw[0], raw[1], raw[2]);
  const [x, y, z] = [raw[0] / length, raw[1] / length, raw[2] / length];
  const r = degrees * Math.PI / 180, c = Math.cos(r), s = Math.sin(r), t = 1 - c;
  return [t * x * x + c, t * x * y - s * z, t * x * z + s * y,
    t * x * y + s * z, t * y * y + c, t * y * z - s * x,
    t * x * z - s * y, t * y * z + s * x, t * z * z + c];
}
function times(a: Matrix, b: Matrix): Matrix {
  const out: number[] = [];
  for (let row = 0; row < 3; row++) for (let column = 0; column < 3; column++)
    out.push(a[row * 3] * b[column] + a[row * 3 + 1] * b[3 + column] + a[row * 3 + 2] * b[6 + column]);
  return out;
}
const transpose = (m: Matrix): Matrix => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
/** How far, in degrees, one camera orientation is turned from another. */
function apart(a: Matrix, b: Matrix = identity): number {
  const m = times(a, transpose(b));
  const sine = Math.hypot(m[7] - m[5], m[2] - m[6], m[3] - m[1]) / 2;
  return Math.atan2(sine, (m[0] + m[4] + m[8] - 1) / 2) * 180 / Math.PI;
}
/** The camera turn a chapter's own motion makes when it plays whole. */
function chapterTurn(tour: Tour, index: number): { turn: Matrix; push: number } {
  const motion = presentedChapterMotion(tour.steps[index], true);
  if (motion?.kind === 'orbit') return { turn: rotation(motion.axis, motion.degrees), push: 1 };
  if (motion?.kind === 'turntable' && !motion.continuous) return { turn: rotation('y', motion.degrees), push: 1 };
  if (motion?.kind === 'dolly') return { turn: identity, push: Math.max(0.1, 1 - motion.metres * 0.2) };
  return { turn: identity, push: 1 };
}

afterEach(() => { vi.useRealTimers(); });

/**
 * A presenting headset page whose camera turns and pushes in as the viewer's
 * lesson moves do. Every move is about a fixed render axis, so the camera's
 * orientation is the product of the moves in order.
 */
function headset(tours: readonly Tour[], { xr = true } = {}) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  const h = tourEndHarness({ xr });
  let camera: Matrix = identity, distance = 1, source = 'same', cursor: any;
  const moves: unknown[] = [];
  const snapshot = h.workspace.snapshot;
  h.workspace.snapshot = () => ({ ...snapshot(), sourceSha256: source });
  const capture = h.workspace.capture;
  h.workspace.capture = () => ({ ...capture(), sourceSha256: source, modelNumber: 1, assemblyId: '', inspection: {} });
  const inspection = h.workspace.viewer.inspection;
  inspection.applyLessonMotion = vi.fn(async (move: any) => {
    moves.push(move);
    if (move.kind === 'orbit') camera = times(rotation(move.axis, move.degrees), camera);
    else distance *= move.factor;
    return { lessonMotionApplied: true };
  });
  inspection.bakeLessonMotion = vi.fn();
  inspection.setLessonFigure = vi.fn(async () => {});
  inspection.setLessonPlayback = (value: any) => { cursor = value; };
  const player = mountTourPlayer({ ...h, tours });
  return { ...h, player, moves, camera: () => camera, distance: () => distance, cursor: () => cursor,
    /** The agent or the wearer turns the view, outside the lesson. */
    turn: (axis: 'x' | 'y' | 'z', degrees: number) => { camera = times(rotation(axis, degrees), camera); },
    source: (value: string) => { source = value; }, done: () => { player.pause(); h.cleanup(); } };
}
type Headset = ReturnType<typeof headset>;

/**
 * Play `tour` from its first chapter to `last`, letting each chapter's motion
 * finish before Next, and check that every chapter is seated in the turns the
 * chapters before it made. Returns the camera turn the chapters played.
 */
async function playThrough(s: Headset, tour: Tour, last = tour.steps.length - 1) {
  await s.player.select(tour.id);
  await s.player.start(false, 0, { narration: false });
  let expected = identity, push = 1;
  for (let step = 0; step <= last; step++) {
    expect(s.player.getState().step).toBe(step);
    // The chapter opens in the frame the chapters before it left.
    expect(apart(s.camera(), expected)).toBeCloseTo(0, 6);
    await vi.advanceTimersByTimeAsync(12_000);
    const played = chapterTurn(tour, step);
    expected = times(played.turn, expected); push *= played.push;
    expect(apart(s.camera(), expected)).toBeCloseTo(0, 6);
    expect(s.distance()).toBeCloseTo(push, 9);
    if (step < last) await s.player.next();
  }
  return { expected, push };
}

it('haemoglobin: each chapter keeps the turns before it, and Done leaves the frame the lesson found', async () => {
  const s = headset([hemoglobin, spike]);
  try {
    const { expected } = await playThrough(s, hemoglobin);
    // The play-through really does end turned and tilted.
    expect(apart(expected)).toBeGreaterThan(150);
    await s.player.finish();
    expect(s.player.getState()).toMatchObject({ active: false });
    expect(apart(s.camera())).toBeCloseTo(0, 6);
    // What a page does before it draws the next structure moves nothing more.
    s.player.stop('Tour stopped while the inspection is restored.', { restoreResting: false });
    const count = s.moves.length;
    await s.player.settleTurn!();
    expect(s.moves.length).toBe(count);
    expect(apart(s.camera())).toBeCloseTo(0, 6);
  } finally { s.done(); }
});

it('haemoglobin left on a later chapter: another lesson from the menu starts in the frame haemoglobin found', async () => {
  const s = headset([hemoglobin, spike]);
  try {
    await playThrough(s, hemoglobin, 3);
    await s.player.openMenu();
    await s.player.select(spike.id);
    await s.player.start(false, 0, { narration: false });
    expect(s.player.getState()).toMatchObject({ selectedId: spike.id, step: 0 });
    expect(apart(s.camera())).toBeCloseTo(0, 6);
  } finally { s.done(); }
});

it('haemoglobin started again from a later chapter opens its first chapter unturned', async () => {
  const s = headset([hemoglobin]);
  try {
    await playThrough(s, hemoglobin, 2);
    await s.player.start(false, 0, { narration: false });
    expect(s.player.getState().step).toBe(0);
    expect(apart(s.camera())).toBeCloseTo(0, 6);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(apart(s.camera(), chapterTurn(hemoglobin, 0).turn)).toBeCloseTo(0, 6);
  } finally { s.done(); }
});

it('haemoglobin left mid-turn for another structure: the structure is drawn in the frame the lesson found', async () => {
  const s = headset([hemoglobin]);
  try {
    await playThrough(s, hemoglobin, 3);
    await s.player.next();
    // Two seconds into the pocket's tilt.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(s.player.getState()).toMatchObject({ step: 4, motionRunning: true });
    s.player.stop('Tour stopped while the inspection is restored.', { restoreResting: false });
    await s.player.settleTurn!();
    expect(apart(s.camera())).toBeCloseTo(0, 6);
  } finally { s.done(); }
});

// The page checks a restored placement against the room as the camera then
// maps it, and moves the molecule if it finds it out of view or under the
// glass. Restored inside the lesson's turns, haemoglobin's starting view was
// checked in a camera turned about 165 degrees from the one it was saved in,
// and Done from the heme close-up handed back the starting size at another
// place, away from the menu column or low at the edge of the view.
for (const [name, last] of [['the heme close-up', 4], ['its last chapter', hemoglobin.steps.length - 1]] as const) {
  it(`haemoglobin ended early from ${name}: Done restores the starting view in the frame the lesson found`, async () => {
    const s = headset([hemoglobin]);
    try {
      const { expected } = await playThrough(s, hemoglobin, last);
      expect(apart(expected)).toBeGreaterThan(150);
      const inspection = s.workspace.viewer.inspection;
      const restore = inspection.restore, restoredIn: number[] = [];
      inspection.restore = async (...args: Parameters<typeof restore>) => { restoredIn.push(apart(s.camera())); return restore(...args); };
      await s.player.finish();
      expect(restoredIn).toHaveLength(1);
      expect(restoredIn[0]).toBeCloseTo(0, 6);
      expect(apart(s.camera())).toBeCloseTo(0, 6);
    } finally { s.done(); }
  });
}

/** One failure, once, in what Done does after the lesson's turns came back. */
const once = <T extends (...args: any[]) => Promise<unknown>>(real: T, fail: (...args: Parameters<T>) => Promise<unknown>) => {
  let failed = false;
  return (async (...args: Parameters<T>) => { if (failed) return real(...args); failed = true; return fail(...args); }) as T;
};
const failingDone: ReadonlyArray<readonly [string, (s: { workspace: any; player: { pause(): void } }) => void]> = [
  ['the starting view is refused', s => {
    s.workspace.viewer.inspection.restore = once(s.workspace.viewer.inspection.restore, async () => { throw Error('The starting view was refused.'); });
  }],
  ['the colour key cannot be cleared', s => {
    s.workspace.viewer.inspection.clearLessonEmphasis = once(s.workspace.viewer.inspection.clearLessonEmphasis, async () => { throw Error('The colour key was refused.'); });
  }],
  ['the lesson is paused once the starting view is drawn', s => {
    const restore = s.workspace.viewer.inspection.restore;
    s.workspace.viewer.inspection.restore = once(restore, async (...args: any[]) => { await restore(...args); s.player.pause(); });
  }],
];
/** Camera moves in plain words, past arithmetic noise: `orbit y -30`, `dolly 1.25`. */
const said = (moves: readonly any[]) => moves.map(move => move.kind === 'orbit'
  ? `orbit ${typeof move.axis === 'string' ? move.axis : JSON.stringify(move.axis)} ${+move.degrees.toFixed(6)}`
  : `dolly ${+move.factor.toFixed(6)}`);
/** The moves that give back what `taken` took back: oldest first, each the opposite. */
const givenBack = (taken: readonly any[]) => [...taken].reverse().map(move => move.kind === 'orbit'
  ? { ...move, degrees: -move.degrees } : { ...move, factor: 1 / move.factor });

// Done takes the turns back before it draws the starting view. A Done that
// fails after that puts the chapter back, and the chapter is seen, and its
// placement checked, in the turns its chapters made. Put back in the frame
// the lesson found, the heme close-up was shown from the wrong side, and the
// next Done had no turns left to take back.
for (const [name, fail] of failingDone) {
  it(`haemoglobin's Done from the heme close-up fails once its turns are back (${name}): the chapter comes back in its turns, and the next Done takes them back once`, async () => {
    const s = headset([hemoglobin]);
    try {
      const { expected } = await playThrough(s, hemoglobin, 4);
      expect(apart(expected)).toBeGreaterThan(150);
      const inspection = s.workspace.viewer.inspection;
      const restore = inspection.restore, restoredIn: Matrix[] = [];
      inspection.restore = async (...args: Parameters<typeof restore>) => { restoredIn.push(s.camera()); return restore(...args); };
      const before = s.moves.length;
      fail(s);
      await expect(s.player.finish()).rejects.toThrow();
      expect(s.player.getState()).toMatchObject({ active: true, step: 4 });
      // The chapter was put back, and is seen, in the turns its chapters made.
      expect(apart(restoredIn.at(-1)!, expected)).toBeCloseTo(0, 6);
      expect(apart(s.camera(), expected)).toBeCloseTo(0, 6);
      const failed = s.moves.slice(before);
      await s.player.finish();
      expect(s.player.getState()).toMatchObject({ active: false });
      expect(apart(restoredIn.at(-1)!)).toBeCloseTo(0, 6);
      expect(apart(s.camera())).toBeCloseTo(0, 6);
      // The second Done takes back exactly what the first took back, each
      // once and in the same order, and the first gave each back once between.
      const ended = s.moves.slice(before + failed.length);
      expect(ended.length).toBeGreaterThan(0);
      expect(failed).toHaveLength(2 * ended.length);
      expect(failed.slice(0, ended.length)).toEqual(ended);
      expect(said(failed.slice(ended.length))).toEqual(said(givenBack(ended)));
    } finally { s.done(); }
  });
}

it('a growth tier: its turns and its push-in both come back at Done', async () => {
  const s = headset([wall]);
  try {
    const { expected, push } = await playThrough(s, wall);
    expect(apart(expected)).toBeGreaterThan(30);
    expect(push).toBeLessThan(1);
    await s.player.finish();
    expect(apart(s.camera())).toBeCloseTo(0, 6);
    expect(s.distance()).toBeCloseTo(1, 9);
  } finally { s.done(); }
});

it('a turn the agent or the wearer gave the view during the lesson is kept at Done', async () => {
  const s = headset([hemoglobin]);
  try {
    await playThrough(s, hemoglobin, 2);
    s.player.pause();
    s.turn('y', 30);
    await s.player.finish();
    // Every turn so far is about up, so the outside one comes back exactly.
    expect(apart(s.camera(), rotation('y', 30))).toBeCloseTo(0, 6);
  } finally { s.done(); }
});

it('a whole turn allowed to finish leaves nothing to take back: Done moves the camera no further', async () => {
  const s = headset([telomerase]);
  try {
    await s.player.select(telomerase.id);
    await s.player.start(false, 1, { narration: false });
    await vi.advanceTimersByTimeAsync(13_000);
    expect(s.player.getState().motionRunning).toBe(false);
    const count = s.moves.length;
    await s.player.next();
    await s.player.finish();
    expect(s.moves.length).toBe(count);
    expect(apart(s.camera())).toBeCloseTo(0, 6);
  } finally { s.done(); }
});

it('the flat page plays and ends haemoglobin exactly as before', async () => {
  const s = headset([hemoglobin], { xr: false });
  try {
    await s.player.select(hemoglobin.id);
    await s.player.start(false, 0, { narration: false });
    for (let step = 0; step < hemoglobin.steps.length; step++) {
      await vi.advanceTimersByTimeAsync(12_000);
      if (step < hemoglobin.steps.length - 1) await s.player.next();
    }
    const count = s.moves.length;
    expect(count).toBeGreaterThan(0);
    await s.player.finish();
    // The flat page restores its own saved camera; the player adds no move.
    expect(s.moves.length).toBe(count);
    expect(s.restores.at(-1)).toMatchObject({ preserveCamera: false });
  } finally { s.done(); }
});

// A turn that is not a whole revolution, between two still chapters: 100
// degrees in 2 s, eased, so 500 ms in it has played 6.25 degrees.
const partial: Tour = { id: 'partial', title: 'Partial', summary: '', steps: [
  { id: 'before', title: 'Before', durationMs: 20_000, appearance: { fog: 11 } },
  { id: 'orbit', title: 'Orbit', durationMs: 20_000, motion: { kind: 'orbit', axis: 'y', degrees: 100, seconds: 2 } },
  { id: 'after', title: 'After', durationMs: 20_000, appearance: { fog: 12 } },
] };
const yaw = (s: Headset) => { const m = s.camera(); return Math.atan2(m[2], m[0]) * 180 / Math.PI; };

/** The partial lesson, 500 ms into its turn. */
async function partway(tours: readonly Tour[] = [partial, spike]) {
  const s = headset(tours);
  await s.player.select(partial.id);
  await s.player.start(false, 1, { narration: false });
  await vi.advanceTimersByTimeAsync(500);
  expect(yaw(s)).toBeCloseTo(6.25, 9);
  return s;
}
/** A saved scene of the same structure with its lesson at `chapterId`. */
function savedAt(s: Headset, tourId: string, chapterId: string, motionProgress = 1, stopped = false) {
  const scene: any = s.workspace.capture();
  scene.inspection = { lessonPlayback: { tourId, chapterId, stopped, entry: 'start', cameraFrame: 'xr',
    motionPlaying: false, motionProgress, startingScene: s.workspace.capture() } };
  return scene;
}
/** What the page does for a restore of the same structure. */
async function hydrateSame(s: Headset, scene: any, tours: readonly Tour[] = [partial, spike]) {
  s.player.stop('Tour stopped while the inspection is restored.', { restoreResting: false });
  await s.player.replaceTours(tours, { preservePlayback: true });
  await s.player.restorePlayback(scene);
}
/** What the page does for a shared update from another panel. */
async function follow(s: Headset, scene: any) {
  s.player.pause('A shared inspection update paused your tour.', { preserveMolecularPlayback: true });
  await s.player.restorePlayback(scene, { frame: true });
}

for (const [route, restore] of [['a restore of the same structure', hydrateSame], ['a shared update from another panel', follow]] as const) {
  it(`${route} onto a later chapter lands it where a straight play puts it`, async () => {
    const s = await partway();
    try {
      await restore(s, savedAt(s, partial.id, 'after'));
      expect(s.player.getState()).toMatchObject({ selectedId: partial.id, step: 2 });
      expect(yaw(s)).toBeCloseTo(100, 9);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(yaw(s)).toBeCloseTo(100, 9);
      await s.player.back();
      expect(yaw(s)).toBeCloseTo(100, 9);
    } finally { s.done(); }
  });

  it(`${route} onto an earlier chapter takes the turn back`, async () => {
    const s = await partway();
    try {
      await restore(s, savedAt(s, partial.id, 'before'));
      expect(s.player.getState()).toMatchObject({ selectedId: partial.id, step: 0 });
      expect(yaw(s)).toBeCloseTo(0, 9);
      // The orbit chapter then plays its turn once.
      await s.player.next();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(yaw(s)).toBeCloseTo(100, 9);
    } finally { s.done(); }
  });
}

it('a restore of the same structure onto another lesson leaves the frame the first lesson found', async () => {
  const s = await partway();
  try {
    await hydrateSame(s, savedAt(s, spike.id, spike.steps[2].id));
    expect(s.player.getState()).toMatchObject({ selectedId: spike.id, step: 2 });
    expect(yaw(s)).toBeCloseTo(0, 9);
  } finally { s.done(); }
});

it('a shared update from another panel onto another lesson leaves the frame the first lesson found', async () => {
  const s = await partway();
  try {
    s.player.pause('A shared inspection update paused your tour.', { preserveMolecularPlayback: true });
    // The page swaps in the new catalog first, then restores the cursor without framing it.
    await s.player.replaceTours([spike], { preservePlayback: true });
    await s.player.restorePlayback(savedAt(s, spike.id, spike.steps[2].id), { frame: false });
    expect(yaw(s)).toBeCloseTo(0, 9);
  } finally { s.done(); }
});

it('a restore of the same chapter from an older save keeps the camera and the cursor together', async () => {
  const s = await partway();
  try {
    // The last save was taken as the chapter began; this page had turned since.
    await hydrateSame(s, savedAt(s, partial.id, 'orbit', 0, true));
    expect(s.player.getState()).toMatchObject({ step: 1, stopped: true });
    expect(yaw(s)).toBeCloseTo(0, 9);
    expect(s.cursor()?.motionProgress).toBe(0);
    // Next still finds the chapter's whole turn to play out.
    await s.player.next();
    expect(yaw(s)).toBeCloseTo(100, 9);
  } finally { s.done(); }
});

it('a shared update of the same chapter keeps this headset\'s own turn', async () => {
  const s = await partway();
  try {
    await follow(s, savedAt(s, partial.id, 'orbit', 1));
    expect(s.player.getState().step).toBe(1);
    expect(yaw(s)).toBeCloseTo(6.25, 9);
    await s.player.next();
    expect(yaw(s)).toBeCloseTo(100, 9);
  } finally { s.done(); }
});

it('a turn already running when the entry seat is announced is still taken back at Done', async () => {
  const s = await partway([partial]);
  try {
    // The seat committed and the turn ticked before the page heard about it.
    s.player.notifyMutation(s.workspace.snapshot(), { origin: 'xr-entry' });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(yaw(s)).toBeCloseTo(100, 9);
    await s.player.finish();
    expect(yaw(s)).toBeCloseTo(0, 9);
  } finally { s.done(); }
});

it('a shared update with no lesson in it, while the menu is open, leaves the frame the lesson found', async () => {
  const s = await partway([partial]);
  try {
    await vi.advanceTimersByTimeAsync(3_000);
    expect(yaw(s)).toBeCloseTo(100, 9);
    await s.player.openMenu();
    const resting: any = s.workspace.capture();
    await s.player.restorePlayback(resting, { frame: true });
    expect(yaw(s)).toBeCloseTo(0, 9);
  } finally { s.done(); }
});

it('a restore of the same structure with no lesson in it leaves the frame the lesson found', async () => {
  const s = await partway([partial]);
  try {
    await vi.advanceTimersByTimeAsync(3_000);
    // What the page does: stop, replace the catalog without the cursor, then settle.
    s.player.stop('Tour stopped while the inspection is restored.', { restoreResting: false });
    await s.player.replaceTours([partial]);
    await s.player.settleTurn!();
    expect(yaw(s)).toBeCloseTo(0, 9);
  } finally { s.done(); }
  const page = readFileSync(new URL('../src/inspector.ts', import.meta.url), 'utf8');
  const hydrate = page.slice(page.indexOf('async function hydrate('));
  const restored = hydrate.indexOf('await tourPlayer?.restorePlayback(data.scene,{waitForXrEntry:isCompanion});');
  const settle = hydrate.indexOf('else if(!restoredLessonPlayback) await tourPlayer?.settleTurn?.();');
  expect(settle).toBeGreaterThan(restored);
  expect(settle).toBeLessThan(hydrate.indexOf('binding={sessionId:id'));
});

// A turn, a push-in and another turn, each a second long.
const pushed: Tour = { id: 'pushed', title: 'Pushed', summary: '', steps: [
  { id: 'left', title: 'Left', durationMs: 20_000, motion: { kind: 'orbit', axis: 'y', degrees: 30, seconds: 1 } },
  { id: 'in', title: 'In', durationMs: 20_000, motion: { kind: 'dolly', metres: 1, seconds: 1 } },
  { id: 'right', title: 'Right', durationMs: 20_000, motion: { kind: 'orbit', axis: 'y', degrees: 20, seconds: 1 } },
] };
/** The pushed lesson played through, with a viewer that can refuse a push-in or run out of turns. */
async function pushedThrough() {
  const s = headset([pushed, spike]);
  const control = { held: false, orbits: Infinity };
  const move = s.workspace.viewer.inspection.applyLessonMotion;
  s.workspace.viewer.inspection.applyLessonMotion = async (value: any) => {
    if (value.kind === 'dolly' && control.held) return { lessonMotionApplied: false };
    if (value.kind === 'orbit' && control.orbits-- <= 0) return { lessonMotionApplied: false };
    return move(value);
  };
  await playThrough(s, pushed);
  expect(yaw(s)).toBeCloseTo(50, 9);
  expect(s.distance()).toBeCloseTo(0.8, 9);
  return { ...s, control };
}

it('a push-in the wearer\'s held placement refuses to take back still lets the turns come back', async () => {
  const s = await pushedThrough();
  try {
    s.control.held = true;
    await s.player.finish();
    expect(yaw(s)).toBeCloseTo(0, 9);
    expect(s.distance()).toBeCloseTo(0.8, 9);
  } finally { s.done(); }
});

it('a turn refused while leaving keeps the rest for the next leaving, and what came back is saved', async () => {
  const s = await pushedThrough();
  try {
    const bakes = (s.workspace.viewer.inspection.bakeLessonMotion as any).mock.calls.length;
    s.control.orbits = 1;
    await s.player.finish();
    // The last turn and the push-in came back; the first turn was refused.
    expect(yaw(s)).toBeCloseTo(30, 9);
    expect(s.distance()).toBeCloseTo(1, 9);
    expect((s.workspace.viewer.inspection.bakeLessonMotion as any).mock.calls.length).toBeGreaterThan(bakes);
    s.control.orbits = Infinity;
    await s.player.select(spike.id);
    await s.player.start(false, 0, { narration: false });
    expect(yaw(s)).toBeCloseTo(0, 9);
  } finally { s.done(); }
});

// The pushed lesson with a still chapter after it, so Next has somewhere to go.
const pushedOn: Tour = { ...pushed, id: 'pushed-on', title: 'Pushed on', steps: [...pushed.steps,
  { id: 'after', title: 'After', durationMs: 20_000, appearance: { fog: 11 } }] };

// Done from the right turn takes back the right turn, the push-in and the left
// turn, then its starting view is refused, and the turns go out again oldest
// first. The left turn goes out; the viewer refuses the push-in, or throws on
// it, and the right turn is not tried. The camera keeps the left turn alone,
// that turn is all there is to take back, and the next Done, straight away or
// after Next, takes it back once.
for (const [how, push] of [
  ['refuses', async () => ({ lessonMotionApplied: false })],
  ['throws on', async () => { throw Error('The view could not move in.'); }],
] as const) {
  for (const then of ['Done', 'Next and then Done'] as const) {
    it(`the viewer ${how} the push-in a failed Done gives back: ${then} takes back the left turn once`, async () => {
      const s = headset([pushedOn]);
      try {
        await playThrough(s, pushedOn, 2);
        expect(yaw(s)).toBeCloseTo(50, 9);
        expect(s.distance()).toBeCloseTo(0.8, 9);
        // Every move asked for from here, applied or not.
        const inspection = s.workspace.viewer.inspection, apply = inspection.applyLessonMotion, asked: any[] = [];
        let pushes = 0;
        inspection.applyLessonMotion = async (move: any) => {
          asked.push(move);
          // The first push-in asked for takes it back; the second gives it back.
          if (move.kind === 'dolly' && ++pushes === 2) return push();
          return apply(move);
        };
        failingDone[0][1](s);
        await expect(s.player.finish()).rejects.toThrow();
        expect(s.player.getState()).toMatchObject({ active: true, step: 2 });
        expect(said(asked)).toEqual(['orbit y -20', 'dolly 1.25', 'orbit y -30', 'orbit y 30', 'dolly 0.8']);
        // The left turn came back; the push-in and the right turn did not.
        expect(yaw(s)).toBeCloseTo(30, 9);
        expect(s.distance()).toBeCloseTo(1, 9);
        const count = asked.length;
        if (then !== 'Done') {
          await s.player.next();
          expect(s.player.getState()).toMatchObject({ active: true, step: 3 });
          // The right turn is not the chapter's again: Next moves the camera no further.
          expect(asked).toHaveLength(count);
          expect(yaw(s)).toBeCloseTo(30, 9);
          expect(s.distance()).toBeCloseTo(1, 9);
        }
        await s.player.finish();
        expect(s.player.getState()).toMatchObject({ active: false });
        // The left turn was all that was left to take back, and it comes back once.
        expect(said(asked.slice(count))).toEqual(['orbit y -30']);
        expect(yaw(s)).toBeCloseTo(0, 9);
        expect(s.distance()).toBeCloseTo(1, 9);
      } finally { s.done(); }
    });
  }
}

/**
 * A presenting page whose camera moves as the viewer's lesson moves do: an
 * orbit turns position, target and up rigidly about the drawn molecule's
 * centre and a push-in slides them toward it (`lessonCameraMove`). Each
 * chapter's placement seats the molecule somewhere else in render space, and
 * Done's restore seats it at the starting view's place, so that centre moves
 * from chapter to chapter, as it does on the headset. The viewer reports the
 * centre it used and turns about a centre handed back with a move.
 */
function seatedHeadset(tours: readonly Tour[]) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  const h = tourEndHarness({ xr: true });
  const start = { position: [0, 0, 5], target: [0, 0, 0], up: [0, 1, 0] };
  let camera = structuredClone(start);
  // Where a seat puts the molecule's centre: a placement's turn and size move it.
  const centre = (placement: any): number[] => {
    const yaw = (placement?.rotation?.[1] ?? 0) * Math.PI / 180, size = placement?.scale ?? 1;
    return [2 * size * Math.cos(yaw), 0.5 * size, 2 * size * Math.sin(yaw) - 1];
  };
  const inspection = h.workspace.viewer.inspection;
  // The viewer's own contract (`applyLessonMotion`): a move handed back with
  // its frame turns about that centre and axis as the camera now carries them.
  inspection.applyLessonMotion = vi.fn(async (move: any) => {
    const given = move.frame ? lessonMoveFromFrame(camera, move.frame, 1) : undefined;
    const pivot = given?.pivot ?? centre(h.workspace.snapshot().inspection.placement);
    const turn = move.kind === 'orbit' && given?.axis ? { ...move, axis: given.axis } : move;
    camera = { ...camera, ...lessonCameraMove(camera, turn, { pivot, ...(move.kind === 'dolly' ? { dollyPivot: pivot } : {}) }) };
    return { lessonMotionApplied: true, pivot, pivotScale: 1,
      frame: lessonMoveFrame(camera, pivot, turn.kind === 'orbit' ? turn.axis : undefined, 1) };
  });
  inspection.bakeLessonMotion = vi.fn();
  inspection.setLessonFigure = vi.fn(async () => {});
  const player = mountTourPlayer({ ...h, tours });
  return { ...h, player, start, camera: () => camera, centre,
    /** The agent turns the view about the molecule's centre now, outside the lesson. */
    turn: (axis: 'x' | 'y' | 'z', degrees: number) => {
      const pivot = centre(h.workspace.snapshot().inspection.placement);
      camera = { ...camera, ...lessonCameraMove(camera, { kind: 'orbit', axis, degrees }, { pivot }) };
    },
    done: () => { player.pause(); h.cleanup(); } };
}
const near = (a: readonly number[], b: readonly number[]) => Math.max(...a.map((value, axis) => Math.abs(value - b[axis])));

it('haemoglobin seated anew in every chapter: Done gives each turn back about the centre it was made about', async () => {
  const s = seatedHeadset([hemoglobin]);
  try {
    await s.player.select(hemoglobin.id);
    await s.player.start(false, 0, { narration: false });
    for (let step = 0; step < hemoglobin.steps.length; step++) {
      await vi.advanceTimersByTimeAsync(12_000);
      if (step < hemoglobin.steps.length - 1) await s.player.next();
    }
    // The lesson really moved the camera, about several centres.
    expect(near(s.camera().position, s.start.position)).toBeGreaterThan(1);
    await s.player.finish();
    expect(s.player.getState()).toMatchObject({ active: false });
    // Done's starting view is seated where the lesson found it, in the same camera.
    expect(near(s.camera().position, s.start.position)).toBeLessThan(1e-9);
    expect(near(s.camera().target, s.start.target)).toBeLessThan(1e-9);
    expect(near(s.camera().up, s.start.up)).toBeLessThan(1e-9);
  } finally { s.done(); }
});

it('a turn and a push-in made about different centres both come back at Done', async () => {
  const s = seatedHeadset([pushed]);
  try {
    await s.player.select(pushed.id);
    await s.player.start(false, 0, { narration: false });
    for (let step = 0; step < pushed.steps.length; step++) {
      // Each chapter is seated elsewhere, as a chapter's framing seats it.
      await s.workspace.viewer.inspection.place({ rotation: [0, 40 * step, 0], scale: 1 + step / 4 });
      await vi.advanceTimersByTimeAsync(3_000);
      if (step < pushed.steps.length - 1) await s.player.next();
    }
    expect(near(s.camera().position, s.start.position)).toBeGreaterThan(0.5);
    await s.player.finish();
    expect(near(s.camera().position, s.start.position)).toBeLessThan(1e-9);
    expect(near(s.camera().target, s.start.target)).toBeLessThan(1e-9);
  } finally { s.done(); }
});

// The starting view may already be drawn, seated elsewhere, when Done fails:
// the turns and the push-in come back about the centres they were taken back about.
for (const [name, fail] of failingDone) {
  it(`a turn and a push-in made about different centres come back exactly when Done fails once they are back (${name})`, async () => {
    const s = seatedHeadset([pushed]);
    try {
      await s.player.select(pushed.id);
      await s.player.start(false, 0, { narration: false });
      for (let step = 0; step < pushed.steps.length; step++) {
        await s.workspace.viewer.inspection.place({ rotation: [0, 40 * step, 0], scale: 1 + step / 4 });
        await vi.advanceTimersByTimeAsync(3_000);
        if (step < pushed.steps.length - 1) await s.player.next();
      }
      const turned = s.camera();
      expect(near(turned.position, s.start.position)).toBeGreaterThan(0.5);
      const moves = () => (s.workspace.viewer.inspection.applyLessonMotion as any).mock.calls.map(([move]: [any]) => move);
      const before = moves().length;
      fail(s);
      await expect(s.player.finish()).rejects.toThrow();
      expect(s.player.getState()).toMatchObject({ active: true, step: pushed.steps.length - 1 });
      for (const key of ['position', 'target', 'up'] as const) expect(near(s.camera()[key], turned[key])).toBeLessThan(1e-9);
      // The right turn, the push-in and the left turn came back, newest
      // first, then went out again, oldest first.
      const failed = moves().slice(before);
      expect(said(failed)).toEqual(['orbit y -20', 'dolly 1.25', 'orbit y -30', 'orbit y 30', 'dolly 0.8', 'orbit y 20']);
      await s.player.finish();
      expect(s.player.getState()).toMatchObject({ active: false });
      for (const key of ['position', 'target', 'up'] as const) expect(near(s.camera()[key], s.start[key])).toBeLessThan(1e-9);
      // The second Done takes each back once, as the first did, about the same centres.
      expect(moves().slice(before + failed.length)).toEqual(failed.slice(0, 3));
    } finally { s.done(); }
  });
}

// Two turns about up, each a second long, for a view turned between them.
const twoTurns: Tour = { id: 'two-turns', title: 'Two turns', summary: '', steps: [
  { id: 'one', title: 'One', durationMs: 20_000, motion: { kind: 'orbit', axis: 'y', degrees: 210, seconds: 1 } },
  { id: 'two', title: 'Two', durationMs: 20_000, motion: { kind: 'orbit', axis: 'y', degrees: -60, seconds: 1 } },
] };

it('a turn the agent gave the view between lesson turns about other centres is kept as it was made', async () => {
  const s = seatedHeadset([twoTurns]);
  try {
    await s.player.select(twoTurns.id);
    await s.player.start(false, 0, { narration: false });
    await vi.advanceTimersByTimeAsync(3_000);
    await s.player.next();
    // The second chapter is seated elsewhere and the agent turns the view about it.
    const seat = { rotation: [0, 90, 0], scale: 1.5 };
    await s.workspace.viewer.inspection.place(seat);
    s.turn('y', 30);
    await vi.advanceTimersByTimeAsync(3_000);
    await s.player.finish();
    // Only the agent's turn is left, about the centre it was made about.
    const kept = lessonCameraMove(s.start, { kind: 'orbit', axis: 'y', degrees: 30 }, { pivot: s.centre(seat) });
    expect(near(s.camera().position, kept.position)).toBeLessThan(1e-9);
    expect(near(s.camera().target, kept.target)).toBeLessThan(1e-9);
    expect(near(s.camera().up, kept.up)).toBeLessThan(1e-9);
  } finally { s.done(); }
});

// Telomerase's slow orbit: one whole turn about up in 11 s, between still chapters.
const wholeTurn: Tour = { id: 'whole-turn', title: 'Whole turn', summary: '', steps: [
  { id: 'still', title: 'Still', durationMs: 20_000, appearance: { fog: 11 } },
  { id: 'orbit', title: 'Orbit', durationMs: 20_000, motion: { kind: 'orbit', axis: 'y', degrees: 360, seconds: 11 } },
  { id: 'after', title: 'After', durationMs: 20_000, appearance: { fog: 12 } },
] };
/**
 * A hand on the molecule, as the headset viewer has it: the page reports the
 * hold, the viewer refuses every lesson move while it lasts (a held grip
 * outranks automatic motion) and the lesson plays on beside it. The grab
 * takes the wearer's placement, which stays held after the hand lets go; the
 * page reports the release, and the viewer can still be busy saving the grab
 * for the next few lesson moves.
 */
function hand(s: ReturnType<typeof seatedHeadset>) {
  const state = { closed: false, held: false, saving: 0 };
  const inspection = s.workspace.viewer.inspection, move = inspection.applyLessonMotion, snapshot = s.workspace.snapshot;
  inspection.supportsConcurrentPlayback = true;
  inspection.applyLessonMotion = async (value: any) => {
    if (state.closed) return { lessonMotionApplied: false };
    if (state.saving > 0) { state.saving--; throw Object.assign(Error('A molecular change is still rendering.'), { code: 'viewer_busy' }); }
    return move(value);
  };
  inspection.holdsWearerPlacement = () => state.held;
  s.workspace.snapshot = () => ({ ...snapshot(), interactionActive: state.closed });
  return {
    close: () => { state.closed = state.held = true; s.player.notifyMutation(undefined, { interaction: true }); },
    open: (saving = 0) => { state.closed = false; state.saving = saving; s.player.notifyMutation(s.workspace.snapshot(), {}); },
  };
}
/**
 * The orbit 1.5 s in, then a grip: the hand holds the molecule for half a
 * second and lets go with it moved and turned, which the wearer's placement
 * then holds. The turn goes on about the molecule where the hand left it,
 * and Next comes 3 s into the orbit.
 */
async function grabbedMidTurn(s: ReturnType<typeof seatedHeadset>) {
  const grip = hand(s);
  await s.player.select(wholeTurn.id);
  await s.player.start(false, 1, { narration: false });
  await vi.advanceTimersByTimeAsync(1_500);
  grip.close();
  await vi.advanceTimersByTimeAsync(500);
  await s.workspace.viewer.inspection.place({ rotation: [0, 70, 0], scale: 1.4 });
  grip.open();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(s.player.getState()).toMatchObject({ step: 1, motionRunning: true });
  await s.player.next();
  expect(s.player.getState().step).toBe(2);
}

it('a grip during a chapter turn: the next lesson starts in the frame the first one found', async () => {
  const s = seatedHeadset([wholeTurn, spike]);
  try {
    await grabbedMidTurn(s);
    // The whole turn was made about two centres, so it is no longer nothing.
    expect(near(s.camera().position, s.start.position)).toBeGreaterThan(0.1);
    await s.player.openMenu();
    await s.player.select(spike.id);
    await s.player.start(false, 0, { narration: false });
    expect(s.player.getState()).toMatchObject({ selectedId: spike.id, step: 0 });
    expect(near(s.camera().position, s.start.position)).toBeLessThan(1e-9);
    expect(near(s.camera().target, s.start.target)).toBeLessThan(1e-9);
    expect(near(s.camera().up, s.start.up)).toBeLessThan(1e-9);
  } finally { s.done(); }
});

it('a grip during a chapter turn: Done hands the camera back as the lesson found it', async () => {
  const s = seatedHeadset([wholeTurn]);
  try {
    await grabbedMidTurn(s);
    await s.player.finish();
    expect(near(s.camera().position, s.start.position)).toBeLessThan(1e-9);
    expect(near(s.camera().target, s.start.target)).toBeLessThan(1e-9);
  } finally { s.done(); }
});

/** The whole turn 3 s in, about a quarter of the way round; a hand closes on the molecule and Next is pressed. */
async function nextWithGripClosed(s: ReturnType<typeof seatedHeadset>) {
  const grip = hand(s);
  await s.player.select(wholeTurn.id);
  await s.player.start(false, 1, { narration: false });
  await vi.advanceTimersByTimeAsync(3_000);
  expect(near(s.camera().position, s.start.position)).toBeGreaterThan(1);
  grip.close();
  await vi.advanceTimersByTimeAsync(500);
  return { grip, next: s.player.next() };
}

it('a grip still closed when Next is pressed mid-turn: the turn lands once the hand lets go', async () => {
  const s = seatedHeadset([wholeTurn]);
  try {
    const { grip, next } = await nextWithGripClosed(s);
    await vi.advanceTimersByTimeAsync(1_500);
    const whileHeld = s.player.getState().step;
    // The first try after letting go meets the grab still being saved.
    grip.open(1);
    await vi.advanceTimersByTimeAsync(300);
    await next;
    expect(s.player.getState().step).toBe(2);
    // The chapter after the orbit sits in the frame the whole turn ends in,
    // not a quarter of the way round it.
    expect(near(s.camera().position, s.start.position)).toBeLessThan(1e-9);
    expect(near(s.camera().up, s.start.up)).toBeLessThan(1e-9);
    // The next chapter waited for the hand rather than drawing over the part-turn.
    expect(whileHeld).toBe(1);
    await s.player.finish();
    expect(near(s.camera().position, s.start.position)).toBeLessThan(1e-9);
  } finally { s.done(); }
});

it('a grip still closed when Done is pressed mid-turn: the camera comes back once the hand lets go', async () => {
  const s = seatedHeadset([wholeTurn]);
  try {
    const grip = hand(s);
    await s.player.select(wholeTurn.id);
    await s.player.start(false, 1, { narration: false });
    await vi.advanceTimersByTimeAsync(3_000);
    grip.close();
    await vi.advanceTimersByTimeAsync(500);
    const done = s.player.finish();
    await vi.advanceTimersByTimeAsync(1_500);
    grip.open(1);
    await vi.advanceTimersByTimeAsync(300);
    await done;
    expect(s.player.getState()).toMatchObject({ active: false });
    expect(near(s.camera().position, s.start.position)).toBeLessThan(1e-9);
    expect(near(s.camera().up, s.start.up)).toBeLessThan(1e-9);
  } finally { s.done(); }
});

for (const cancel of ['pause', 'stop'] as const) it(`a grip still closed when Next is pressed, then ${cancel}: the turn stays where the hand stopped it`, async () => {
  const s = seatedHeadset([wholeTurn]);
  try {
    const { grip, next } = await nextWithGripClosed(s);
    let ended = false;
    void next.then(() => { ended = true; }, () => { ended = true; });
    await vi.advanceTimersByTimeAsync(1_000);
    const stoppedAt = structuredClone(s.camera());
    if (cancel === 'pause') s.player.pause(); else s.player.stop();
    await vi.advanceTimersByTimeAsync(200);
    const endedWhileHeld = ended;
    grip.open();
    await vi.advanceTimersByTimeAsync(1_000);
    // Letting go after the lesson was paused or stopped moves nothing.
    expect(near(s.camera().position, stoppedAt.position)).toBeLessThan(1e-9);
    expect(near(s.camera().up, stoppedAt.up)).toBeLessThan(1e-9);
    // And the wait ended with the pause or stop, not with the hand.
    expect(endedWhileHeld).toBe(true);
  } finally { s.done(); }
});

it('a grip that stays closed: Next goes on after the wait, and Done still hands the camera back', async () => {
  const s = seatedHeadset([wholeTurn]);
  try {
    const { grip, next } = await nextWithGripClosed(s);
    // The hand moves the molecule as it holds it.
    await s.workspace.viewer.inspection.place({ rotation: [0, 70, 0], scale: 1.4 });
    await vi.advanceTimersByTimeAsync(TOUR_SETTLE_GRIP_WAIT_MS + 500);
    await next;
    expect(s.player.getState().step).toBe(2);
    // The turn stays where the hand stopped it, and the molecule where the hand put it.
    expect(near(s.camera().position, s.start.position)).toBeGreaterThan(1);
    expect(s.workspace.snapshot().inspection.placement).toMatchObject({ rotation: [0, 70, 0], scale: 1.4 });
    grip.open();
    await s.player.finish();
    expect(near(s.camera().position, s.start.position)).toBeLessThan(1e-9);
  } finally { s.done(); }
});

it('a page waits for a restored lesson cursor before it saves and attaches', () => {
  const page = readFileSync(new URL('../src/inspector.ts', import.meta.url), 'utf8');
  const hydrate = page.slice(page.indexOf('async function hydrate('));
  expect(hydrate).toContain('await tourPlayer?.restorePlayback(data.scene,{waitForXrEntry:isCompanion});');
});
