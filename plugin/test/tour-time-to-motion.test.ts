import { expect, it, vi } from 'vitest';
import { mountTourPlayer, tourStepDwellMs, type Tour } from '../src/tour-player.js';
// @ts-ignore Real player DOM fixture; only rendering/I/O are adapted.
import { tourEndHarness } from '../../lab/browser-roundtrip/fixtures/tour-end-harness.mjs';
it('silent authored duration wins; narration and unauthored captions keep reading time', () => {
  const step = { id: 'opening', title: 'Opening', narration: 'Both heads attached to the track', durationMs: 4000 };
  expect(tourStepDwellMs(step)).toBe(4500);
  expect(tourStepDwellMs(step, 0, false)).toBe(4000);
  expect(tourStepDwellMs({ ...step, durationMs: undefined }, 0, false)).toBe(4500);
});
it('warm start, caption dwell, lookahead and boundary install have separate fake-clock timings', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  const h = tourEndHarness();
  const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
  const figure = { layers: [], labels: [], distances: [] };
  const animation = { version: 1 as const, durationSeconds: 15, tracks: [], playback: { autoplay: true, loop: true } };
  const lesson: Tour = { id: 'latency', title: 'Latency', summary: '', steps: [
    { id: 'opening', title: 'Opening', motion: { kind: 'hold' }, narration: 'Both heads attached to the track', durationMs: 4000, figure, emphasis: { parts: [], framing: 'context' } },
    { id: 'motion', title: 'Motion', durationMs: 30000, figure, animation },
  ] };
  let prepared = false, movingAt = -1;
  const phase: Record<string, number> = {};
  Object.assign(h.workspace.viewer.inspection, {
    emphasize: async (value: any) => { await sleep(value.framing ? 1000 : 16); },
    setLessonFigure: async (_: any, options: any) => { await sleep(100 + (options.frame ? 1000 : 0)); },
    prepareMolecularAnimation: async () => { const at = performance.now(); await sleep(700); prepared = true; phase.prepare = performance.now() - at; },
    setMolecularAnimation: async (value: any) => { if (value) { expect(prepared).toBe(true); await sleep(120); movingAt = performance.now(); } },
  });
  const player = mountTourPlayer({ ...h, tours: [lesson] });
  try {
    await player.select(lesson.id);
    const started = performance.now();
    const start = player.start(true, 0, { narration: false });
    await vi.advanceTimersByTimeAsync(1200); await start;
    const first = h.records.all().find((r: any) => r.kind === 'tour' && r.detail.outcome === 'shown');
    expect(first.detail.boundaryToShownMs).toBe(1116);
    expect(first.detail.boundaryToShownMs).toBeLessThan(2000);
    await vi.advanceTimersByTimeAsync(3915);
    expect(player.getState().step).toBe(0);
    await vi.advanceTimersByTimeAsync(237);
    expect(player.getState().step).toBe(1);
    expect(movingAt - started).toBe(5352);
    expect(phase.prepare).toBe(700);
    expect(movingAt - (started + 1116 + 4000)).toBe(236);
    const timings = h.records.all().filter((r: any) => r.kind === 'tour' && r.detail.action === 'timing').map((r: any) => r.detail);
    expect(timings).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: 'queue', elapsedMs: 0 }),
      expect.objectContaining({ phase: 'chapter-paint', target: 1, elapsedMs: 116 }),
      expect.objectContaining({ phase: 'animation-install-frame', target: 1, elapsedMs: 120 }),
    ]));
  } finally { player.pause(); h.cleanup(); vi.useRealTimers(); }
});

it('long silent captions share the authored dwell instead of adding three seconds per page', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  const h = tourEndHarness();
  const lesson: Tour = { id: 'pages', title: 'Pages', summary: '', steps: [
    { id: 'opening', title: 'Opening', body: 'This long caption has several pages. '.repeat(15), durationMs: 4000, motion: { kind: 'hold' } },
    { id: 'next', title: 'Next', durationMs: 30000 },
  ] };
  const player = mountTourPlayer({ ...h, tours: [lesson] });
  try {
    await player.select(lesson.id); await player.start(true, 0, { narration: false });
    // The caption goes whole; the card pages it at its own width.
    expect(player.getState().bodyPageCount).toBe(1);
    await vi.advanceTimersByTimeAsync(3999); expect(player.getState().step).toBe(0);
    await vi.advanceTimersByTimeAsync(20); expect(player.getState().step).toBe(1);
  } finally { player.pause(); h.cleanup(); vi.useRealTimers(); }
});
