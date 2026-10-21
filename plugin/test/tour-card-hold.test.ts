import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { mountTourPlayer } from '../src/tour-player.js';
import { molecularLessonToTour } from '../src/molecular-lesson-tour.js';
// @ts-ignore Source page closures and browser diagnostics, with only I/O adapted.
import { tourEndHarness } from '../../lab/browser-roundtrip/fixtures/tour-end-harness.mjs';

const manifest = JSON.parse(readFileSync(new URL('../demos/telomerase-haca.json', import.meta.url), 'utf8'));
const lesson = molecularLessonToTour(manifest);

// The headset card turns its own pages every seven seconds. Autoplay left a
// chapter on its dwell alone, so a card with more pages than the dwell held
// was cut off before the wearer reached its last page.
it('in the headset, autoplay holds a chapter until its card has shown its last page for seven seconds', async () => {
  vi.useFakeTimers();
  const h = tourEndHarness({ xr: true });
  let cardHoldMs = 0;
  h.workspace.viewer.xr = { toolbarReadout: () => ({ cardPageCount: 3, cardPageIndex: 0, cardHoldMs }) };
  const player = mountTourPlayer({ ...h, tours: [lesson] });
  try {
    await h.install(lesson);
    await player.select(lesson.id); await player.start(true);
    expect(player.getState().step).toBe(0);
    cardHoldMs = 12_000;
    await vi.advanceTimersByTimeAsync(lesson.steps[0].durationMs!);
    expect(player.getState().step).toBe(0);
    await vi.advanceTimersByTimeAsync(11_000);
    expect(player.getState().step, 'still reading the card').toBe(0);
    cardHoldMs = 0;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(player.getState().step).toBe(1);
  } finally { player.pause(); vi.useRealTimers(); }
});

it('on the desktop, the headset card holds nothing', async () => {
  vi.useFakeTimers();
  const h = tourEndHarness({ xr: false });
  h.workspace.viewer.xr = { toolbarReadout: () => ({ cardPageCount: 3, cardPageIndex: 0, cardHoldMs: 60_000 }) };
  const player = mountTourPlayer({ ...h, tours: [lesson] });
  try {
    await h.install(lesson);
    await player.select(lesson.id); await player.start(true);
    await vi.advanceTimersByTimeAsync(lesson.steps[0].durationMs!);
    expect(player.getState().step).toBe(1);
  } finally { player.pause(); vi.useRealTimers(); }
});
