import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mountTourPlayer, resolveTourSelection, type Tour } from '../src/tour-player.js';
import { applyTourCommand } from '../src/inspection-tour-client.js';
import { molecularLessonToTour } from '../src/molecular-lesson-tour.js';
// @ts-ignore Real player DOM boundary and resting-key owner; no browser or device.
import { tourEndHarness } from '../../lab/browser-roundtrip/fixtures/tour-end-harness.mjs';

// A chapter wears its own colours and nothing the previous chapter selected.
// CRISPR's DNA chapter selects the PAM bases, and the REC chapter after it
// kept that magenta mark on the DNA because a chapter without a selection
// never cleared one.

const lesson = (name: string) => molecularLessonToTour(JSON.parse(readFileSync(new URL(`../demos/${name}.json`, import.meta.url), 'utf8')));
const rows = ['A', 'B', 'C', 'D'].flatMap(chain => Array.from({ length: 1400 }, (_, i) => ({ key: `${chain}${i + 1}`, entityType: 'polymer',
  identity: { authorChain: chain, labelChain: chain, authorResidue: i + 1, copyId: '1', modelNumber: 1, componentId: 'ALA' } })));

function stage(tour: Tour) {
  const h = tourEndHarness({ xr: true });
  let selected: string[] = [];
  let lessonSelection: string | undefined;
  const capture = h.workspace.capture;
  h.workspace.capture = () => ({ ...capture(), selectionKeys: [...selected], inspection: { lessonSelection } });
  const snapshot = h.workspace.snapshot;
  h.workspace.snapshot = () => ({ ...snapshot(), selectionKeys: [...selected] });
  h.workspace.rows = () => rows;
  h.workspace.viewer.select = async (keys: string[], _kind?: string, options?: { lesson?: boolean }) => {
    selected = [...keys]; lessonSelection = options?.lesson ? [...keys].sort().join('\n') : undefined;
  };
  h.workspace.viewer.inspection.setLessonFigure = async () => {};
  const player = mountTourPlayer({ ...h, tours: [tour] });
  const authored = (step: number) => {
    const selection = tour.steps[step]!.selection;
    return selection ? resolveTourSelection(rows, selection) : [];
  };
  const colours = () => (h.capture().painted.parts ?? []).map((part: { id: string; color: string }) => [part.id, part.color]);
  const ownColours = (step: number) => (tour.steps[step]!.emphasis?.parts ?? []).map(part => [part.id, part.color]);
  return { h, player, selected: () => selected, select: (keys: string[]) => h.workspace.viewer.select(keys), authored, colours, ownColours };
}

describe('chapter selection', () => {
  for (const name of ['telomerase-haca', 'crispr-cas9']) it(`${name} shows each chapter's own selection and colours, forward and back`, async () => {
    const tour = lesson(name);
    const { h, player, selected, authored, colours, ownColours } = stage(tour);
    try {
      await h.install(tour);
      await applyTourCommand(player, { action: 'start', tourId: tour.id, autoplay: false, narration: false });
      const seen = (step: number, via: string) => {
        expect(player.getState().step, via).toBe(step);
        expect(selected(), `${tour.steps[step]!.id} ${via}`).toEqual(authored(step));
        expect(colours(), `${tour.steps[step]!.id} ${via}`).toEqual(ownColours(step));
      };
      seen(0, 'start');
      for (let step = 1; step < tour.steps.length; step++) {
        await applyTourCommand(player, { action: 'next' });
        seen(step, `after ${tour.steps[step - 1]!.id}`);
      }
      for (let step = tour.steps.length - 2; step >= 0; step--) {
        await applyTourCommand(player, { action: 'back' });
        seen(step, `back from ${tour.steps[step + 1]!.id}`);
      }
      await applyTourCommand(player, { action: 'start', tourId: tour.id, autoplay: false, narration: false });
      seen(0, 'restart');
    } finally { player.pause(); h.cleanup(); }
  });

  for (const sameKeys of [false, true]) it(`a chapter preserves the wearer's ${sameKeys ? 'same' : 'different'} selection keys`, async () => {
    const tour = lesson('crispr-cas9');
    const target = tour.steps.findIndex(step => step.selection);
    const { h, player, selected, select, authored } = stage(tour);
    try {
      await h.install(tour);
      await applyTourCommand(player, { action: 'start', tourId: tour.id, autoplay: false, narration: false });
      while (player.getState().step < target) await applyTourCommand(player, { action: 'next' });
      expect(selected()).toEqual(authored(target));
      const keys = sameKeys ? authored(target) : ['B7', 'B8'];
      await select(keys);
      await applyTourCommand(player, { action: 'next' });
      expect(tour.steps[target + 1]!.selection).toBeUndefined();
      expect(selected()).toEqual(keys);
    } finally { player.pause(); h.cleanup(); }
  });
});

it('a new player clears a restored lesson selection, while preserving a restored wearer selection', async () => {
  const tour = lesson('crispr-cas9'); // Opening chapter has no authored selection.
  for (const owned of [true, false]) {
    const { h, player, selected, select } = stage(tour);
    try {
      await h.install(tour);
      select(['B7', 'B8']);
      const capture = h.workspace.capture;
      h.workspace.capture = () => {
        const scene = capture();
        return { ...scene, selectionKeys: [...selected()], inspection: { ...scene.inspection,
          ...(owned ? { lessonSelection: 'B7\nB8' } : {}) } };
      };
      await applyTourCommand(player, { action: 'start', tourId: tour.id, autoplay: false, narration: false });
      expect(selected()).toEqual(owned ? [] : ['B7', 'B8']);
    } finally { player.pause(); h.cleanup(); }
  }
});
