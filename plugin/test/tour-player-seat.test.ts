import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { mountTourPlayer } from '../src/tour-player.js';
import { molecularLessonToTour } from '../src/molecular-lesson-tour.js';
import { diagnosticEntrySchema, salvageDiagnosticEntries } from '../src/headset-diagnostics.js';
// @ts-ignore Page production closures; only rendering I/O is adapted.
import { recordedEndings, recordedTourSeat } from '../../lab/browser-roundtrip/fixtures/recorded-tour-seat.mjs';
const tour = molecularLessonToTour(JSON.parse(readFileSync(new URL('../demos/telomerase-haca.json', import.meta.url), 'utf8')));

it('recorded Done and completion restore identical seats and send accepted clearance evidence', async () => {
  const restored = [];
  for (const reason of ['done', 'completed']) {
    const h = await recordedTourSeat(mountTourPlayer, tour);
    vi.useFakeTimers();
    try {
      await h.player.start(true);
      const entries = recordedEndings[reason].entries;
      const scenes = entries.filter((e: any) => e.kind === 'tour' && e.detail.action === 'scene');
      for (const scene of scenes) {
        await h.scene({ ...scene, reason });
        if (scene !== scenes.at(-1)) await vi.advanceTimersByTimeAsync(scene.detail.dwellMs);
      }
      if (reason === 'done') {
        const action = entries.find((e: any) => e.kind === 'toolbar-action' && e.detail.kind === 'tour-done');
        await vi.advanceTimersByTimeAsync(action.at - scenes.at(-1).at);
        (globalThis as any).__stereofoldMenu.press('done');
        await vi.advanceTimersByTimeAsync(0);
      } else await vi.advanceTimersByTimeAsync(scenes.at(-1).detail.dwellMs);
      await h.toolbar.update();
      expect(h.captureSeat()).toEqual(h.baseline);
      restored.push(h.captureSeat());
      const evidence = h.records.all().filter((e: any) => e.kind === 'plate-standoff' && e.detail.phase === 'tour-end');
      expect(evidence).toHaveLength(1);
      expect(evidence[0].detail).toMatchObject({ lit: true, units: 'tangent', frame: { menu: { clear: true } } });
      expect(diagnosticEntrySchema.parse(evidence[0])).toEqual(evidence[0]);
      expect(salvageDiagnosticEntries(evidence)).toEqual(evidence);
      const end = h.records.all().find((e: any) => e.kind === 'tour' && e.detail.action === 'end');
      expect(end.detail).toMatchObject({ reason, outcome: 'restored', active: false });
      expect(evidence[0].seq).toBeLessThan(end.seq);
    } finally { await h.cleanup(); vi.useRealTimers(); }
  }
  expect(restored[0]).toEqual(restored[1]);
});
