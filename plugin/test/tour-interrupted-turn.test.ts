import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { molecularLessonToTour } from '../src/molecular-lesson-tour.js';
import { mountTourPlayer, type Tour } from '../src/tour-player.js';
// @ts-ignore Real player DOM boundary, no browser or device needed.
import { tourEndHarness } from '../../lab/browser-roundtrip/fixtures/tour-end-harness.mjs';

// In a headset a chapter's slow orbit turns the camera, and the camera is the
// room frame every later chapter is seated in. Next pressed 3 s into an 11 s
// orbit used to leave that chapter's 98 degrees in the camera, so every later
// chapter, Done's starting view and the next lesson arrived turned that far
// off the rotation their author set.
const lesson = (name: string) => molecularLessonToTour(JSON.parse(readFileSync(new URL(`../demos/${name}.json`, import.meta.url), 'utf8')));
const telomerase = lesson('telomerase-haca');
/** Signed degrees from the authored camera, in (-180, 180]. */
const off = (degrees: number) => { const d = ((degrees % 360) + 540) % 360 - 180; return Math.abs(d) < 1e-9 ? 0 : d; };

afterEach(() => { vi.useRealTimers(); });

/** A presenting headset page whose camera turns as the viewer's lesson ticks do. */
function headset(tours: readonly Tour[]) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  const h = tourEndHarness({ xr: true });
  let turned = 0, source = 'same';
  const moves: number[] = [];
  const snapshot = h.workspace.snapshot;
  h.workspace.snapshot = () => ({ ...snapshot(), sourceSha256: source });
  const inspection = h.workspace.viewer.inspection;
  // Every orbit here is about render up, signed by its own axis.
  inspection.applyLessonMotion = vi.fn(async (move: any) => {
    if (move.kind !== 'orbit') return { lessonMotionApplied: true };
    const sign = move.axis === 'y' ? 1 : Math.sign(move.axis[1]);
    turned += sign * move.degrees; moves.push(sign * move.degrees);
    return { lessonMotionApplied: true };
  });
  inspection.bakeLessonMotion = vi.fn();
  // Telomerase names its parts with a figure; its drawing is not under test.
  inspection.setLessonFigure = vi.fn(async () => {});
  const player = mountTourPlayer({ ...h, tours });
  return { ...h, player, moves, turned: () => turned, turn: (degrees: number) => { turned += degrees; },
    source: (value: string) => { source = value; }, done: () => { player.pause(); h.cleanup(); } };
}

/** Open telomerase at its slow orbit and let it spin for `ms`. */
async function intoOrbit(s: ReturnType<typeof headset>, ms = 3_000) {
  await s.player.select(telomerase.id);
  await s.player.start(false, 1, { narration: false });
  expect(s.player.getState()).toMatchObject({ step: 1, motionRunning: true });
  await vi.advanceTimersByTimeAsync(ms);
  // The spin is well under way, and nowhere near a whole turn.
  if (ms < 11_000) expect(Math.abs(off(s.turned()))).toBeGreaterThan(30);
}

for (const name of ['telomerase-haca', 'spike', 'nucleosome']) it(`${name}: Next 3 s into the orbit leaves every later chapter at its authored turn`, async () => {
  const tour = name === telomerase.id ? telomerase : lesson(name);
  expect(tour.steps[1].cameraSpin).toBeDefined();
  const s = headset([tour]);
  try {
    await s.player.select(tour.id);
    await s.player.start(false, 1, { narration: false });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(Math.abs(off(s.turned()))).toBeGreaterThan(30);
    for (let step = 2; step < tour.steps.length; step++) {
      await s.player.next();
      expect(s.player.getState().step).toBe(step);
      expect(off(s.turned())).toBe(0);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(off(s.turned())).toBe(0);
    }
  } finally { s.done(); }
});

it('Back during the orbit returns the earlier chapter at its authored turn', async () => {
  const s = headset([telomerase]);
  try {
    await intoOrbit(s);
    await s.player.back();
    expect(s.player.getState().step).toBe(0);
    expect(off(s.turned())).toBe(0);
  } finally { s.done(); }
});

it('Done during the orbit restores the starting view unturned', async () => {
  const s = headset([telomerase]);
  try {
    await intoOrbit(s);
    await s.player.finish();
    expect(s.player.getState()).toMatchObject({ active: false, motionRunning: false });
    expect(off(s.turned())).toBe(0);
  } finally { s.done(); }
});

it('a paused orbit left by Next still lands the next chapter at its authored turn', async () => {
  const s = headset([telomerase]);
  try {
    await intoOrbit(s);
    s.player.pause();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(Math.abs(off(s.turned()))).toBeGreaterThan(30);
    await s.player.next();
    expect(off(s.turned())).toBe(0);
  } finally { s.done(); }
});

it('Rejoin plays the interrupted orbit whole from the chapter start', async () => {
  const s = headset([telomerase]);
  try {
    await intoOrbit(s);
    s.player.stop('Tour stopped.');
    await s.player.rejoin();
    expect(s.player.getState()).toMatchObject({ step: 1, motionRunning: true });
    expect(off(s.turned())).toBe(0);
    await vi.advanceTimersByTimeAsync(13_000);
    expect(s.player.getState().motionRunning).toBe(false);
    expect(off(s.turned())).toBe(0);
  } finally { s.done(); }
});

it('an orbit allowed to finish moves the camera exactly as before', async () => {
  const s = headset([telomerase]);
  try {
    await intoOrbit(s, 13_000);
    expect(s.player.getState().motionRunning).toBe(false);
    const total = s.moves.reduce((sum: number, value: number) => sum + value, 0);
    expect(Math.abs(total)).toBeCloseTo(360, 6);
    const count = s.moves.length;
    await s.player.next(); await s.player.next();
    // Nothing is settled when nothing was left: no extra camera move at all.
    expect(s.moves.length).toBe(count);
    expect(off(s.turned())).toBeCloseTo(0, 6);
  } finally { s.done(); }
});

it('a turn of the camera made outside the lesson is kept', async () => {
  const s = headset([telomerase]);
  try {
    await intoOrbit(s);
    s.player.pause();
    // The agent or the wearer turns the view 30 degrees on top.
    s.turn(30);
    await s.player.next();
    expect(off(s.turned())).toBeCloseTo(30, 9);
  } finally { s.done(); }
});

it('a lesson chosen from the menu after an interrupted orbit starts unturned', async () => {
  const spike = lesson('spike');
  const s = headset([telomerase, spike]);
  try {
    await intoOrbit(s);
    await s.player.openMenu();
    await s.player.select(spike.id);
    await s.player.start(false, 0, { narration: false });
    expect(s.player.getState()).toMatchObject({ selectedId: spike.id, step: 0 });
    expect(off(s.turned())).toBe(0);
  } finally { s.done(); }
});

it('a source opened after an interrupted orbit is drawn in the unturned frame', async () => {
  const s = headset([telomerase]);
  try {
    await intoOrbit(s);
    // What a page does before drawing another structure.
    s.player.stop('Tour stopped while the inspection is restored.', { restoreResting: false });
    await s.player.settleTurn();
    expect(off(s.turned())).toBe(0);
    s.source('other');
    await s.player.settleTurn();
    expect(off(s.turned())).toBe(0);
  } finally { s.done(); }
});

it('a page settles the turn after stopping the lesson and before drawing a different structure', () => {
  const page = readFileSync(new URL('../src/inspector.ts', import.meta.url), 'utf8');
  const hydrate = page.slice(page.indexOf('async function hydrate('));
  const settle = hydrate.indexOf('if(swappedSource) await tourPlayer?.settleTurn?.();');
  expect(settle).toBeGreaterThan(hydrate.indexOf("tourPlayer?.stop('Tour stopped while the inspection is restored.'"));
  expect(settle).toBeLessThan(hydrate.indexOf('await workspace.loadSource('));
});

// A turn that is not a whole revolution: 100 degrees in 2 s, eased, so 500 ms
// in it has played 6.25 degrees, and a straight play ends at 100.
const partial: Tour = { id: 'partial', title: 'Partial', summary: '', steps: [
  { id: 'orbit', title: 'Orbit', durationMs: 20_000, motion: { kind: 'orbit', axis: 'y', degrees: 100, seconds: 2 } },
  { id: 'after', title: 'After', durationMs: 20_000, appearance: { fog: 12 } },
] };

/** The partial lesson, 500 ms into its turn, with a viewer that can refuse a move or fail a chapter. */
async function partway() {
  const s = headset([partial]);
  const inspection = s.workspace.viewer.inspection;
  const control = { refuse: false, failChapter: false, cursor: undefined as any };
  const move = inspection.applyLessonMotion;
  inspection.applyLessonMotion = async (value: any) => control.refuse ? { lessonMotionApplied: false } : move(value);
  const configure = inspection.configure;
  inspection.configure = async (patch: any) => {
    if (control.failChapter && patch.fog === 12) throw Error('The chapter could not be drawn.');
    return configure(patch);
  };
  inspection.setLessonPlayback = (value: any) => { control.cursor = value; };
  await s.player.select(partial.id);
  await s.player.start(false, 0, { narration: false });
  await vi.advanceTimersByTimeAsync(500);
  s.player.pause();
  expect(s.turned()).toBeCloseTo(6.25, 9);
  return { ...s, control };
}

it('a partial turn left by Next lands where a straight play puts the next chapter', async () => {
  const s = await partway();
  try {
    await s.player.next();
    expect(s.player.getState().step).toBe(1);
    expect(s.turned()).toBeCloseTo(100, 9);
  } finally { s.done(); }
});

it('Rejoin after the lesson is installed again takes the turn back and plays it once', async () => {
  const s = await partway();
  try {
    // The same lesson with the same chapter ids, as an installed edit arrives.
    await s.player.installLesson(structuredClone(partial));
    await s.player.rejoin();
    expect(s.turned()).toBeCloseTo(0, 9);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(s.turned()).toBeCloseTo(100, 9);
  } finally { s.done(); }
});

it('a Next that fails keeps the turn it finished, so Rejoin plays it once', async () => {
  const s = await partway();
  try {
    s.control.failChapter = true;
    await expect(s.player.next()).rejects.toThrow();
    expect(s.player.getState().step).toBe(0);
    expect(s.turned()).toBeCloseTo(100, 9);
    expect(s.control.cursor?.motionProgress).toBe(1);
    s.control.failChapter = false;
    await s.player.rejoin();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(s.turned()).toBeCloseTo(100, 9);
  } finally { s.done(); }
});

it('a settle the viewer refuses leaves the turn and the saved cursor where they were', async () => {
  const s = await partway();
  try {
    s.control.refuse = true; s.control.failChapter = true;
    await expect(s.player.next()).rejects.toThrow();
    expect(s.turned()).toBeCloseTo(6.25, 9);
    expect(s.control.cursor?.motionProgress).toBeCloseTo(0.0625, 9);
  } finally { s.done(); }
});
