import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, it, vi } from 'vitest';
import { mountTourPlayer, type Tour } from '../src/tour-player.js';
// @ts-ignore Production rows and DOM/drawing boundary for the real player.
import { spatialToolbarRows } from '../../lab/browser-roundtrip/spatial-toolbar-content.mjs';
// @ts-ignore Production player; only DOM and molecular drawing are adapted.
import { tourEndHarness } from '../../lab/browser-roundtrip/fixtures/tour-end-harness.mjs';

const source = readFileSync(new URL('../../lab/browser-roundtrip/viewer.mjs', import.meta.url), 'utf8');
const begin = source.indexOf("        if (action.kind === 'tour-play')");
const end = source.indexOf("        // A spoken", begin);

it('the pointed Play row resumes a silent gallery, paints Pause, returns its receipt and advances', async () => {
  vi.useFakeTimers();
  const h = tourEndHarness({ xr: true });
  const tour: Tour = { id: 'menu-gallery', title: 'Gallery', summary: '',
    presentation: { captionCard: 'hidden', end: 'hold' },
    steps: [0, 1, 2].map(index => ({ id: `pair-${index}`, title: `Pair ${index}`, body: '',
      durationMs: 5000, motion: 'hold', appearance: { opacity: 0 } })) };
  const player = mountTourPlayer({ ...h, tours: [tour] });
  const captions: any[] = [], receipts: any[] = [];
  const dispatch = (action: any) => vm.runInNewContext(`(async () => { ${source.slice(begin, end)} })()`, {
    action, spatialTour: player, talkCaption: { set: (value: any) => captions.push(value) },
    recordManipulation: (_kind: string, detail: any) => receipts.push(detail),
  });
  const row = () => spatialToolbarRows({ collapsed: true, tour: player.getState() })
    .find((entry: any) => entry.action.kind === 'tour-play');
  try {
    await player.installLesson(tour, { chapterId: 'pair-0', autoplay: false, narration: false });
    await vi.advanceTimersByTimeAsync(60000);
    expect(player.getState()).toMatchObject({ step: 0, autoplay: false });
    expect(row().label).toBe('Play');
    const receipt = await dispatch(row().action);
    expect(receipt).toMatchObject({ step: 0, autoplay: true, active: true });
    expect(row().label).toBe('Pause');
    expect(captions.at(-1).outcome).toBe('Playing. Scene 1 / 3.');
    expect(receipts.at(-1)).toMatchObject({ action: 'tour-play', outcome: 'playing', step: 0, total: 3 });
    await vi.advanceTimersByTimeAsync(4999);
    expect(player.getState().step).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(player.getState()).toMatchObject({ step: 1, autoplay: true });
    await dispatch(row().action);
    expect(row().label).toBe('Play');
    await vi.advanceTimersByTimeAsync(60000);
    expect(player.getState()).toMatchObject({ step: 1, autoplay: false });
    expect(captions.at(-1).outcome).toBe('Autoplay paused.');
  } finally { player.pause(); h.cleanup(); vi.useRealTimers(); }
});
