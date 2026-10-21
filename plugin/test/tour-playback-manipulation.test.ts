import { expect, it, vi } from 'vitest';
import { mountTourPlayer, type Tour } from '../src/tour-player.js';
// @ts-ignore Shared production playback clock.
import { createPlaybackClock } from '../../packages/motion/src/keyframes.mjs';
// @ts-ignore DOM boundary for the production player.
import { tourEndHarness } from '../../lab/browser-roundtrip/fixtures/tour-end-harness.mjs';

for (const xr of [true, false]) it(`${xr ? 'grip' : 'desktop orbit/zoom'} preserves the view through autoplay, Next and cached Back`, async () => {
  vi.useFakeTimers();
  const h = tourEndHarness({ xr });
  let interacting = false, held = false, clock: any;
  let placement = { translation: [.032178, .438761, -1.603064], rotation: [15, 35, 0], scale: 1.937124 };
  let camera = { position: [0, 0, 10], target: [0, 0, 0] };
  const capture = () => structuredClone({ placement, camera });
  const snapshot = h.workspace.snapshot;
  h.workspace.snapshot = () => ({ ...snapshot(), interactionActive: interacting });
  h.workspace.capture = capture;
  Object.assign(h.workspace.viewer.inspection, {
    supportsConcurrentPlayback: true, holdsWearerPlacement: () => held,
    place: async (patch: any) => { placement = { ...placement, ...patch }; },
    restore: async (saved: any, options: any) => {
      if (!options.preservePlacement) placement = structuredClone(saved.placement);
      if (!options.preserveCamera) camera = structuredClone(saved.camera);
    },
    fit: async () => { camera = { position: [0, 0, 20], target: [0, 0, 0] }; },
    setMolecularAnimation: async (value: any) => { clock = value ? createPlaybackClock(value.durationSeconds, value.playback) : undefined; },
    controlMolecularAnimation: (patch: any) => clock?.patch(patch, Date.now()),
  });
  const animation = { version: 1 as const, durationSeconds: 20, playback: { autoplay: true, loop: true }, tracks: [] };
  const tour: Tour = { id: 'playback', title: 'Playback', summary: '', presentation: { captionCard: 'shown', end: 'hold' }, steps: [0, 1, 2].map(i => ({
    id: `chapter-${i}`, title: `Chapter ${i}`, durationMs: 3000, animation, view: 'fit', placement: { scale: .5648, translation: [0, 0, .1630] },
  })) };
  const player = mountTourPlayer({ ...h, tours: [tour] });
  try {
    await player.select(tour.id); await player.start(true, 0);
    held = interacting = true;
    placement = { translation: [.4, .8, -2.5], rotation: [25, 50, 10], scale: 2.3 };
    camera = { position: [6, 2, 7], target: [1, 0, 0] };
    const chosen = capture();
    player.notifyMutation(h.workspace.snapshot(), { interaction: true });
    clock.sample(Date.now());
    await vi.advanceTimersByTimeAsync(1000); clock.sample(Date.now());
    expect(clock.snapshot().timeSeconds).toBeGreaterThan(.9);
    expect(clock.snapshot().state).toBe('playing');
    // Hold continuously across a full dwell: release is never the advance trigger.
    await vi.advanceTimersByTimeAsync(2001);
    expect(player.getState()).toMatchObject({ step: 1, autoplay: true, stopped: false });
    expect(capture()).toEqual(chosen); // Exact equality; tighter than 1e-6 placement tolerance.
    await player.next(); expect(player.getState().step).toBe(2);
    expect(capture()).toEqual(chosen);
    interacting = false;
    player.notifyMutation(h.workspace.snapshot());
    await player.back(); expect(player.getState().step).toBe(1);
    expect(capture()).toEqual(chosen);
    clock.sample(Date.now()); await vi.advanceTimersByTimeAsync(100); clock.sample(Date.now());
    expect(clock.snapshot().timeSeconds).toBeGreaterThan(0);
    expect(player.getState().autoplay).toBe(true);
  } finally { player.pause(); h.cleanup(); vi.useRealTimers(); }
});
