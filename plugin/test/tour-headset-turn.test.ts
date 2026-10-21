import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { molecularLessonToTour } from '../src/molecular-lesson-tour.js';
import { chapterTurnSweep, mountTourPlayer, type Tour } from '../src/tour-player.js';
// @ts-ignore Real player DOM and diagnostics; GPU/I/O costs are adapted.
import { tourEndHarness } from '../../lab/browser-roundtrip/fixtures/tour-end-harness.mjs';
// @ts-ignore The viewer's own tick validation and camera arithmetic.
import { lessonCameraMove, normalizeLessonMotion } from '../../lab/browser-roundtrip/lesson-motion.mjs';

// A "Slow orbit" chapter that authors only the desktop movie's `camera_spin`
// stood still in the headset: the immersive adapter dropped `changes`, so the
// chapter's one authored move never reached the player, and the wearer saw
// the authored placement land at its new angle and hold.
const demo = (name: string) => JSON.parse(readFileSync(new URL(`../demos/${name}`, import.meta.url), 'utf8'));
const settle = async () => { for (let turn = 0; turn < 8; turn++) await Promise.resolve(); };

type Tick = { at: number; move: { kind: string; axis: unknown; degrees: number } };
const mount = (tour: Tour, xr: boolean) => {
  const h = tourEndHarness({ xr });
  const ticks: Tick[] = [];
  h.workspace.viewer.inspection.applyLessonMotion = async (move: Tick['move']) => { ticks.push({ at: Date.now(), move }); };
  h.workspace.viewer.inspection.bakeLessonMotion = () => true;
  return { h, ticks, player: mountTourPlayer({ ...h, tours: [tour] }) };
};
const turned = (ticks: Tick[], until: number) => ticks.filter(tick => tick.at <= until)
  .reduce((sum, tick) => sum + tick.move.degrees, 0);

it('carries a chapter camera spin to the headset only where no immersive motion is authored', () => {
  const orbit = molecularLessonToTour(demo('atp-synthase.json')).steps.find(step => step.id === 'orbit')!;
  // The desktop step is unchanged: no motion of its own.
  expect(orbit.motion).toBeUndefined();
  expect(orbit.cameraSpin).toEqual({ axis: [0, -1, 0], degrees: 360, seconds: 11, delaySeconds: 1, easing: 'linear' });
  // An authored immersive move is the headset's intent and wins.
  const grown = molecularLessonToTour(demo('microtubule-growth/monomer.json')).steps.find(step => step.id === 'orbit')!;
  expect(grown.motion).toEqual({ kind: 'orbit', degrees: 20, seconds: 8, axis: 'y' });
  expect(grown.cameraSpin).toBeUndefined();
});

it.each([true, false])('turns the ATP synthase orbit chapter at its authored pace in the headset (xr=%s)', async xr => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  const tour = molecularLessonToTour(demo('atp-synthase.json'));
  const { h, ticks, player } = mount(tour, xr);
  try {
    await player.select(tour.id);
    await player.start(false, 1, { narration: false });
    const shown = Date.now();
    expect(player.getState().step).toBe(1);
    await vi.advanceTimersByTimeAsync(12_500); await settle();
    if (!xr) { expect(ticks).toEqual([]); return; }
    // The scene change runs first; the spin starts at 1 s and runs 11 s, linear.
    expect(turned(ticks, shown + 950)).toBe(0);
    expect(turned(ticks, shown + 1_000 + 5_500)).toBeCloseTo(180, -0.5);
    expect(turned(ticks, shown + 1_000 + 2_750)).toBeCloseTo(90, -0.5);
    expect(turned(ticks, Infinity)).toBeCloseTo(360, 6);
    expect(new Set(ticks.map(tick => JSON.stringify([tick.move.kind, tick.move.axis])))).toEqual(new Set(['["orbit",[0,-1,0]]']));
    // The viewer accepts each tick as the same in-place orbit it already plays.
    expect(normalizeLessonMotion(ticks[0].move)).toEqual({ kind: 'orbit', axis: [0, -1, 0], degrees: ticks[0].move.degrees });
  } finally { player.pause(); h.cleanup(); vi.useRealTimers(); }
});

it('an arbitrary spin axis turns the camera rigidly about the pivot', () => {
  const camera = { position: [0, 0, 10], target: [0, 0, 0], up: [0, 1, 0] };
  const down = lessonCameraMove(camera, { kind: 'orbit', axis: [0, -2, 0], degrees: 90 }, { pivot: [1, 0, 0] });
  const named = lessonCameraMove(camera, { kind: 'orbit', axis: 'y', degrees: -90 }, { pivot: [1, 0, 0] });
  for (const key of ['position', 'target', 'up'] as const)
    down[key].forEach((value: number, i: number) => expect(value).toBeCloseTo(named[key][i], 9));
  expect(normalizeLessonMotion({ kind: 'orbit', axis: [0, 0, 0], degrees: 1 })).toBeUndefined();
  expect(normalizeLessonMotion({ kind: 'orbit', axis: [0, Number.NaN, 1], degrees: 1 })).toBeUndefined();
});

it('keeps a continuous spin chapter turning in the headset after its own scene work lands', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  const tour = molecularLessonToTour(demo('microtubule-growth/filament.json'));
  const h = tourEndHarness({ xr: true });
  // The viewer stops its presentation turn for every scene mutation and for
  // an XR framing travel; only an explicit unpause starts it again.
  let turning = false;
  const inspection = h.workspace.viewer.inspection;
  const { configure, place, emphasize } = inspection;
  Object.assign(inspection, {
    setMotion: async ({ paused }: { paused: boolean }) => { turning = !paused; },
    configure: async (patch: unknown) => { turning = false; await configure(patch); },
    place: async (patch: unknown) => { turning = false; await place(patch); },
    emphasize: async (value: unknown) => { turning = false; await emphasize(value); },
  });
  const player = mountTourPlayer({ ...h, tours: [tour] });
  try {
    await player.select(tour.id);
    await player.start(false, 0, { narration: false });
    await vi.advanceTimersByTimeAsync(200); await settle();
    // The opening ring holds end-on; the orbit chapter after it spins.
    expect(tour.steps[0].motion).toBe('hold');
    expect(turning).toBe(false);
    await player.next(); await vi.advanceTimersByTimeAsync(200); await settle();
    expect(tour.steps[1].motion).toBe('spin');
    expect(turning).toBe(true);
    // A hold chapter stays still.
    await player.next(); await vi.advanceTimersByTimeAsync(200); await settle();
    expect(tour.steps[2].motion).toBe('hold');
    expect(turning).toBe(false);
  } finally { player.pause(); h.cleanup(); vi.useRealTimers(); }
});

// The filament's spin chapters were seated for their t=0 pose, so the map
// swung behind the menu and past the wearer as it turned. The headset tells
// the viewer each chapter's turn while it paints, so its seat is solved for
// everything the turn sweeps.
it('tells the headset viewer the turn each chapter will sweep while it paints', async () => {
  const tour = molecularLessonToTour(demo('microtubule-growth/filament.json'));
  const spin = { axis: [0, 1, 0], degrees: 360, continuous: true };
  expect(chapterTurnSweep(tour.steps.find(step => step.id === 'orbit'), true)).toEqual(spin);
  expect(chapterTurnSweep(tour.steps.find(step => step.id === 'orbit'), false)).toBeUndefined();
  expect(chapterTurnSweep(tour.steps.find(step => step.id === 'reveal'), true)).toBeUndefined();
  expect(chapterTurnSweep(tour.steps.find(step => step.id === 'highlight'), true)).toBeUndefined();
  // A camera orbit turns the molecule the other way about the same axis.
  const atp = molecularLessonToTour(demo('atp-synthase.json')).steps.find(step => step.id === 'orbit');
  expect(chapterTurnSweep(atp, true)).toEqual({ axis: [0, -1, 0], degrees: -360, continuous: false });
  const grown = molecularLessonToTour(demo('microtubule-growth/monomer.json')).steps.find(step => step.id === 'orbit');
  expect(chapterTurnSweep(grown, true)).toEqual({ axis: [0, 1, 0], degrees: -20, continuous: false });

  const { h, player } = mount(tour, true);
  const painted: unknown[] = [];
  h.workspace.viewer.inspection.chapterPainting = (chapterId: string | undefined, options?: { turn?: unknown }) => {
    painted.push(chapterId === undefined ? undefined : [chapterId, options?.turn]);
  };
  try {
    await player.select(tour.id);
    await player.start(false, 0, { narration: false });
    await player.next(); await player.next();
    expect(painted).toEqual([['reveal', undefined], undefined, ['orbit', spin], undefined, ['highlight', undefined], undefined]);
  } finally { player.pause(); h.cleanup(); }
});
