import { expect, it, vi } from 'vitest';
import { mountTourPlayer, type Tour, XR_AUTOPLAY_MAXIMUM_HOLD_MS } from '../src/tour-player.js';
// @ts-ignore Real player and diagnostics; only DOM and molecular drawing adapted.
import { tourEndHarness } from '../../lab/browser-roundtrip/fixtures/tour-end-harness.mjs';

function stage({ captionCard = 'hidden', narration = false, motion = 'hold', durationMs = 5000 }:
  { captionCard?: 'hidden' | 'shown'; narration?: boolean; motion?: 'hold' | 'spin'; durationMs?: number | null } = {}) {
  vi.useFakeTimers();
  const h = tourEndHarness({ xr: true });
  const tour: Tour = { id: 'timed-gallery', title: 'Timed gallery', summary: '',
    presentation: { captionCard, end: 'hold' }, steps: [0, 1, 2].map(i => ({
      id: `pair-${i}`, title: `Pair ${i}`, body: 'Source details remain available.',
      ...(durationMs === null ? {} : { durationMs }), motion,
      appearance: { opacity: 0 },
    })) };
  const began = Date.now();
  // The real toolbar can paginate source details even with the chapter card
  // hidden. Reproduce its 14 s reading hold independently of authored dwell.
  const readout = vi.fn(() => ({ cardHoldMs: Math.max(0, 14_000 - (Date.now() - began)) }));
  h.workspace.viewer.xr = { toolbarReadout: readout };
  const player = mountTourPlayer({ ...h, tours: [tour] });
  return { h, player, tour, readout,
    start: () => player.installLesson(tour, { chapterId: 'pair-0', autoplay: true, narration }),
    close() { player.pause(); h.cleanup(); vi.useRealTimers(); } };
}

it('a silent hidden-caption hold advances every authored five seconds despite a paged source readout', async () => {
  const s = stage();
  try {
    await s.start();
    for (let index = 0; index < 3; index++) {
      expect(s.player.getState()).toMatchObject({ step: index, autoplay: true, narration: false });
      await vi.advanceTimersByTimeAsync(4999);
      expect(s.player.getState().step).toBe(index);
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(s.player.getState()).toMatchObject({ step: 2, autoplay: false, active: true });
    expect(s.readout).not.toHaveBeenCalled();
  } finally { s.close(); }
});

it.each([
  { captionCard: 'shown' as const },
  { narration: true },
  { motion: 'spin' as const },
  { durationMs: null },
])('keeps the toolbar reading window for other lessons: %j', async options => {
  const s = stage(options);
  try {
    await s.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.player.getState().step).toBe(0);
    expect(s.readout).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(9000);
    expect(s.player.getState().step).toBe(1);
  } finally { s.close(); }
});

it('retains the bounded XR frame-rate safety hold for a silent hidden-caption slideshow', async () => {
  const s = stage();
  try {
    // Fresh low-FPS measurements remain fresh during every retry.
    s.h.records.entries = () => [{ kind: 'frame-rate', at: Date.now(), detail: { fps: 10, reportedFrameRate: 72 } }];
    await s.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.player.getState().step).toBe(0);
    await vi.advanceTimersByTimeAsync(XR_AUTOPLAY_MAXIMUM_HOLD_MS - 1);
    expect(s.player.getState().step).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.player.getState().step).toBe(1);
    expect(s.readout).not.toHaveBeenCalled();
  } finally { s.close(); }
});
