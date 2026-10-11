import { expect, it, vi } from 'vitest';
import { mountTourPlayer, reportedFrameRate, XR_FRAME_COST_FRESH_MS, type Tour } from '../src/tour-player.js';
import { applyTourCommand } from '../src/inspection-tour-client.js';
// @ts-ignore Browser DOM adapter; production player and diagnostics buffer.
import { tourEndHarness } from '../../lab/browser-roundtrip/fixtures/tour-end-harness.mjs';

it('uses measured fps under the reported session ceiling, never the ceiling as a measurement', () => {
  const sample = (fps: number, ceiling: number | null) => [{ kind: 'frame-rate', at: 100, detail: { fps, reportedFrameRate: ceiling } }];
  expect(reportedFrameRate(sample(90, 72), 200)).toBe(72);
  expect(reportedFrameRate(sample(18, 72), 200)).toBe(18);
  expect(reportedFrameRate(sample(0, 72), 200)).toBe(0);
  expect(reportedFrameRate(sample(35, null), 200)).toBe(35);
  expect(reportedFrameRate(sample(18, 72), 101 + XR_FRAME_COST_FRESH_MS)).toBeUndefined();
  expect(reportedFrameRate([{ kind: 'session-frame-rate', at: 100, detail: { reportedFrameRate: 72 } }], 200)).toBeUndefined();
});

it('ignores callback throughput including legacy mislabeled fps records', () => {
  expect(reportedFrameRate([{ kind: 'frame-cost', at: 100, detail: { fps: 144 } }], 200)).toBeUndefined();
  expect(reportedFrameRate([
    { kind: 'frame-rate', at: 100, detail: { fps: 18 } },
    { kind: 'frame-cost', at: 150, detail: { fps: 144 } },
  ], 200)).toBe(18);
});

it('rejects invalid, future, ended-session and previous-session measurements', () => {
  for (const fps of [-1, NaN, Infinity]) expect(reportedFrameRate([{ kind: 'frame-rate', at: 100, detail: { fps } }], 200)).toBeUndefined();
  for (const at of [NaN, Infinity, 201]) expect(reportedFrameRate([{ kind: 'frame-rate', at, detail: { fps: 12 } }], 200)).toBeUndefined();
  for (const kind of ['session-end', 'session-start']) expect(reportedFrameRate([
    { kind: 'frame-rate', at: 100, detail: { fps: 12 } }, { kind, at: 101 },
  ], 200)).toBeUndefined();
});

const tour: Tour = { id: 'pacing', title: 'Pacing', summary: '', presentation: { captionCard: 'hidden', end: 'hold' },
  steps: (['cartoon', 'ball-and-stick', 'molecular-surface'] as const).map((representation, index) => ({
    id: `chapter-${index + 1}`, title: `Chapter ${index + 1}`, caption: 'Read this chapter.', durationMs: 3000,
    appearance: { representation },
  })) };

it('holds a named lesson for spoken guidance until explicit Next or Play', async () => {
  vi.useFakeTimers();
  const h = tourEndHarness({ xr: true });
  const player = mountTourPlayer({ ...h, tours: [tour] });
  try {
    await h.install(tour);
    await applyTourCommand(player, { action: 'start', tourId: tour.id, autoplay: false });
    expect(player.getState()).toMatchObject({ selectedId: tour.id, active: true, step: 0, autoplay: false });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(player.getState().step).toBe(0);
    await applyTourCommand(player, { action: 'next' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(player.getState()).toMatchObject({ step: 1, autoplay: false });
    await applyTourCommand(player, { action: 'play' });
    await vi.advanceTimersByTimeAsync(3000);
    expect(player.getState().step).toBe(2);
  } finally { player.pause(); h.cleanup(); vi.useRealTimers(); }
});

for (const mode of ['dip', 'stale', 'bounded-hold'] as const) it(`${mode}: autoplay preserves every rendered chapter and its full dwell`, async () => {
  vi.useFakeTimers(); vi.setSystemTime(1_000_000);
  const h = tourEndHarness({ xr: true });
  (globalThis as any).__stereofoldDiagnostics = { ...h.records, entries: () => h.records.all() };
  const player = mountTourPlayer({ ...h, tours: [tour] });
  const sample = () => h.records.record('frame-rate', { fps: 12, reportedFrameRate: 72 });
  try {
    if (mode === 'stale') { sample(); await vi.advanceTimersByTimeAsync(XR_FRAME_COST_FRESH_MS + 1); }
    await h.install(tour); await player.select(tour.id); await player.start(true, 0);
    if (mode !== 'stale') sample();
    await vi.advanceTimersByTimeAsync(2999);
    expect(player.getState().step).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    if (mode === 'stale') expect(player.getState().step).toBe(1);
    else {
      expect(player.getState().step).toBe(0);
      if (mode === 'dip') {
        // A newer healthy measurement releases the hold at the next retry.
        (globalThis as any).__stereofoldDiagnostics.entries = () => [{ kind: 'frame-rate', at: Date.now(), detail: { fps: 72, reportedFrameRate: 72 } }];
        await vi.advanceTimersByTimeAsync(1000);
      } else {
        // Keep the sample fresh to prove the five-second hold cap itself.
        (globalThis as any).__stereofoldDiagnostics.entries = () => [{ kind: 'frame-rate', at: Date.now(), detail: { fps: 12, reportedFrameRate: 72 } }];
        await vi.advanceTimersByTimeAsync(4999);
        expect(player.getState().step).toBe(0);
        await vi.advanceTimersByTimeAsync(1);
        (globalThis as any).__stereofoldDiagnostics.entries = () => [];
      }
      expect(player.getState().step).toBe(1);
    }
    await vi.advanceTimersByTimeAsync(2999);
    expect(player.getState().step).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(player.getState().step).toBe(2);
    await vi.advanceTimersByTimeAsync(2999);
    expect(player.getState().autoplay).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(player.getState()).toMatchObject({ step: 2, autoplay: false });
    expect(h.records.all().filter((entry: any) => entry.kind === 'tour' && entry.detail.action === 'scene' && entry.detail.outcome === 'shown')
      .map((entry: any) => entry.detail.step)).toEqual([0, 1, 2]);
  } finally { player.pause(); h.cleanup(); vi.useRealTimers(); }
});
