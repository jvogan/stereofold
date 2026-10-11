import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { mountTourPlayer, type Tour } from '../src/tour-player.js';
import { molecularLessonToTour } from '../src/molecular-lesson-tour.js';
import { diagnosticEntrySchema, salvageDiagnosticEntries } from '../src/headset-diagnostics.js';
// @ts-ignore Source page closures and browser diagnostics, with only I/O adapted.
import { tourEndHarness } from '../../lab/browser-roundtrip/fixtures/tour-end-harness.mjs';

const manifest = JSON.parse(readFileSync(new URL('../demos/telomerase-haca.json', import.meta.url), 'utf8'));
const lesson = molecularLessonToTour(manifest);

for (const xr of [true, false]) it(`ends telomerase after the final dwell and preserves its receipt (XR=${xr})`, async () => {
  vi.useFakeTimers();
  const h = tourEndHarness({ xr });
  const player = mountTourPlayer({ ...h, tours: [lesson] });
  try {
    await h.install(lesson); const baseline = h.capture();
    await player.select(lesson.id); await player.start(true);
    for (const step of lesson.steps.slice(0, -1)) await vi.advanceTimersByTimeAsync(step.durationMs!);
    expect(player.getState().step).toBe(4);
    await vi.advanceTimersByTimeAsync(8999);
    expect(player.getState().active).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(player.getState()).toMatchObject({ active: false, autoplay: false, step: -1, menuOpen: false, stopped: false });
    expect(h.capture()).toEqual(baseline);
    expect(h.restores.at(-1)).toEqual({ preserveCamera: xr });
    expect(h.spoken).toEqual(['Tour complete. Explore freely.']);
    expect(h.spoken[0].split(/\s+/)).toHaveLength(4);
    expect(player.narratingLine()).toBeUndefined();
    const ends = h.records.all().filter((e: any) => e.kind === 'tour' && e.detail.action === 'end');
    expect(ends).toHaveLength(1);
    expect(ends[0].detail).toMatchObject({ reason: 'completed', outcome: 'restored', step: 4, total: 5, active: false, autoplay: false, xr });
    // Use the real producer output, not a handcrafted receipt. New end action
    // and existing fields pass both strict intake and mixed-heartbeat salvage.
    expect(diagnosticEntrySchema.parse(ends[0])).toEqual(ends[0]);
    expect(salvageDiagnosticEntries(ends)).toEqual(ends);
  } finally { player.pause(); vi.useRealTimers(); h.cleanup(); }
});

it('Done during an earlier scene restores once and cancels its scheduled dwell', async () => {
  vi.useFakeTimers(); const h = tourEndHarness();
  const player = mountTourPlayer({ ...h, tours: [lesson] });
  try {
    await h.install(lesson); const baseline = h.capture();
    await player.select(lesson.id); await player.start(true);
    await Promise.all([h.dispatchDone(player), h.dispatchDone(player)]);
    await vi.advanceTimersByTimeAsync(60000);
    expect(player.getState().active).toBe(false);
    expect(h.capture()).toEqual(baseline);
    expect(h.restores).toHaveLength(1);
    expect(h.spoken).toEqual(['Tour complete. Explore freely.']);
    expect(h.records.all().filter((e: any) => e.detail.action === 'end')).toHaveLength(1);
  } finally { player.pause(); vi.useRealTimers(); h.cleanup(); }
});

it('an authored ending hold survives its dwell until Done', async () => {
  const held = molecularLessonToTour({ ...manifest, presentation: { ...manifest.presentation, end: 'hold' } });
  vi.useFakeTimers(); const h = tourEndHarness();
  const player = mountTourPlayer({ ...h, tours: [held] });
  try {
    await h.install(held); await player.select(held.id); await player.start(true, 'last');
    await vi.advanceTimersByTimeAsync(60000);
    expect(player.getState()).toMatchObject({ active: true, autoplay: false, step: 4 });
    expect(h.spoken).toEqual([]);
    await h.dispatchDone(player);
    expect(player.getState().active).toBe(false);
    expect(h.spoken).toHaveLength(1);
  } finally { player.pause(); vi.useRealTimers(); h.cleanup(); }
});

it('a single scene can finish, and pausing its final dwell prevents completion', async () => {
  const single: Tour = { ...lesson, steps: [lesson.steps[0]!] };
  vi.useFakeTimers(); const h = tourEndHarness();
  const player = mountTourPlayer({ ...h, tours: [single] });
  try {
    await h.install(single); await player.select(single.id); await player.start(true);
    player.pause(); await vi.advanceTimersByTimeAsync(20000);
    expect(player.getState().active).toBe(true);
    expect(h.spoken).toEqual([]);
    await player.togglePlay(); await vi.advanceTimersByTimeAsync(10000);
    expect(player.getState().active).toBe(false);
    expect(h.spoken).toHaveLength(1);
  } finally { player.pause(); vi.useRealTimers(); h.cleanup(); }
});

it('a failed restore reports no successful end and permits Done to retry', async () => {
  vi.useFakeTimers(); const h = tourEndHarness();
  const restore = h.workspace.viewer.inspection.restore;
  h.workspace.viewer.inspection.restore = vi.fn().mockRejectedValueOnce(Error('Restore failed.')).mockImplementation(restore);
  const player = mountTourPlayer({ ...h, tours: [lesson] });
  try {
    await h.install(lesson); await player.select(lesson.id); await player.start(true);
    await expect(h.dispatchDone(player)).rejects.toThrow('Restore failed.');
    expect(h.spoken).toEqual([]);
    expect(h.records.all().some((e: any) => e.detail.action === 'end')).toBe(false);
    await h.dispatchDone(player);
    expect(player.getState().active).toBe(false);
    expect(h.spoken).toHaveLength(1);
  } finally { player.pause(); vi.useRealTimers(); h.cleanup(); }
});
