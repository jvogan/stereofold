import { describe, expect, it } from 'vitest';
import { mountTourPlayer, type Tour } from '../src/tour-player.js';
import { applyTourCommand } from '../src/inspection-tour-client.js';
// @ts-ignore Real player DOM boundary and resting-key owner; no browser or device.
import { tourEndHarness } from '../../lab/browser-roundtrip/fixtures/tour-end-harness.mjs';

// A spin chapter the viewer framed as a close-up the wearer stands inside
// holds still: its spin would carry the framed part out of view and the rest
// of the structure through the wearer. Every other spin chapter turns again
// once its scene is shown.

const part = { id: 'site', label: 'Site', color: '#ff8a1f', chain: 'A' };
const lesson: Tour = { id: 'spin', title: 'Spin', summary: '', steps: [
  { id: 'wide', title: 'Wide', durationMs: 60_000, motion: 'spin', emphasis: { parts: [part], framing: 'fill' } },
  { id: 'close', title: 'Close', durationMs: 60_000, motion: 'spin', emphasis: { parts: [part], focus: 'site', framing: 'fill' } },
] };
const settle = async () => { for (let turn = 0; turn < 8; turn++) await Promise.resolve(); };

describe('a spin chapter framed as a close-up', () => {
  it('is not turned again once shown, while a wide spin chapter is', async () => {
    const h = tourEndHarness({ xr: true });
    const plays: string[] = [];
    let chapter = '';
    h.workspace.viewer.inspection.chapterPainting = (id: string | undefined) => { if (id) chapter = id; };
    h.workspace.viewer.inspection.holdsTurnStill = (id: string) => id === 'close';
    h.workspace.viewer.inspection.setMotion = async ({ paused }: { paused: boolean }) => { if (!paused) plays.push(chapter); };
    const player = mountTourPlayer({ ...h, tours: [lesson] });
    try {
      await h.install(lesson);
      await applyTourCommand(player, { action: 'start', tourId: lesson.id, autoplay: false, narration: false });
      await settle();
      const wide = plays.filter(id => id === 'wide').length;
      await applyTourCommand(player, { action: 'next' });
      await settle();
      expect(player.getState().step).toBe(1);
      // The turn phase starts the spin before the framing; only the wide
      // chapter is turned again after its scene.
      expect(wide).toBe(2);
      expect(plays.filter(id => id === 'close').length).toBe(1);
    } finally { player.pause(); h.cleanup(); }
  });
});
