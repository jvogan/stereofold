import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { applyTourStep, type Workspace } from '../src/tour-player.js';
import { molecularLessonToTour } from '../src/molecular-lesson-tour.js';

it('acceptance 6 #208: a labelled authored close-up requests bounded XR framing', async () => {
  const demo = JSON.parse(readFileSync(new URL('../demos/telomerase-haca.json', import.meta.url), 'utf8'));
  const capture = JSON.parse(readFileSync(new URL('../../lab/browser-roundtrip/fixtures/acceptance-6-tour.json', import.meta.url), 'utf8'));
  const recorded = capture.actions.flatMap((a: any) => a.entries).find((e: any) => e.seq === 208).detail;
  expect(recorded.offGlass).toBe(9);
  expect(recorded.anchors.every((a: any) => !a.focused)).toBe(true);
  const tour = molecularLessonToTour(demo);
  const chapter = tour.steps[3]!;
  // Physical acceptance 7: a near cutaway clipped six label quads,
  // including the second focus, even though the solver placed all ten.
  expect(demo.chapters[3].immersive.appearance.clipping).toBe(0);
  let painted: any;
  const noop = async () => {};
  const workspace = { snapshot: () => ({ atomCount: 1 }), rows: () => [],
    viewer: { select: noop, inspection: { place: noop, configure: noop, setMotion: noop,
      emphasize: async (value: any) => { painted = value; } } } } as unknown as Workspace;
  await applyTourStep(workspace, chapter, () => true, false);
  expect(painted.framing).toBe('context');
  expect(painted.focus).toEqual(['dyskerin-c', 'dyskerin-g']);
});
