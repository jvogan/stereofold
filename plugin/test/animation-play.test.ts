import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, it, vi } from 'vitest';
import { createPlaybackClock } from '../../packages/motion/src/keyframes.mjs';
import { mountTourPlayer, type Tour } from '../src/tour-player.js';
// @ts-ignore Browser DOM and renderer boundaries only.
import { tourEndHarness } from '../../lab/browser-roundtrip/fixtures/tour-end-harness.mjs';

const source = readFileSync(new URL('../../lab/browser-roundtrip/viewer.mjs', import.meta.url), 'utf8');
const start = source.indexOf("        if (action.kind === 'tour-play')");
const end = source.indexOf("        // A spoken", start);
const tour: Tour = { id: 'walk', title: 'Walk', summary: '', presentation: { captionCard: 'shown', end: 'hold' },
  steps: [{ id: 'two-steps', title: 'Two steps', durationMs: 30_000 },
    { id: 'still', title: 'Still', durationMs: 30_000 }] };

for (const route of ['spoken', 'page', 'menu'] as const) {
  for (const [time, loop] of [[7, false], [3, false], [3, true]] as const) {
    it(`${route} Play at ${time}s (loop=${loop}) restarts only an ended clip`, async () => {
      vi.useFakeTimers();
      const h = tourEndHarness();
      const clock = createPlaybackClock(7, { loop });
      const sample = () => ({ id: 'clip', chapterId: 'two-steps', durationSeconds: 7, ...clock.snapshot() });
      const snapshot = h.workspace.snapshot;
      h.workspace.snapshot = () => ({ ...snapshot(), animation: sample() });
      h.workspace.viewer.inspection.controlMolecularAnimation = (patch: any) => clock.patch(patch, 0);
      let click: () => void = () => { throw Error('Play button not wired'); };
      h.after.querySelector('[data-tour-play]').addEventListener = (_event: string, fn: () => void) => { click = fn; };
      const player = mountTourPlayer({ ...h, tours: [tour] });
      try {
        await player.select(tour.id); await player.start(true, 0);
        clock.patch({ seekSeconds: time, state: 'pause' }, 0);
        player.pause();
        clock.sample(1000);
        expect(clock.snapshot().timeSeconds).toBe(time);
        if (route === 'page') click();
        else await vm.runInNewContext(`(async () => { ${source.slice(start, end)} })()`, {
          action: { kind: 'tour-play', ...(route === 'spoken' ? { playing: true } : {}) }, spatialTour: player,
          recordManipulation() {}, talkCaption: undefined,
        });
        expect(clock.snapshot()).toMatchObject({ state: 'playing', timeSeconds: time === 7 ? 0 : time, loop });
        expect(player.getState()).toMatchObject({ autoplay: true, step: 0 });
        clock.sample(1500);
        expect(clock.snapshot().timeSeconds).toBe((time === 7 ? 0 : time) + .5);
        // Finishing the clip still holds its last frame without restarting or
        // advancing the tour; the authored chapter dwell still owns Next.
        if (!loop) {
          clock.sample(9000);
          expect(clock.snapshot()).toMatchObject({ state: 'paused', timeSeconds: 7 });
          expect(player.getState()).toMatchObject({ autoplay: true, step: 0 });
        }
      } finally { player.pause(); h.cleanup(); vi.useRealTimers(); }
    });
  }
}
