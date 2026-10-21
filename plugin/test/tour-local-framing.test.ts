import { expect, it } from 'vitest';
import { applyTourStep, mountTourPlayer, type Tour } from '../src/tour-player.js';
import { readFileSync } from 'node:fs';
import { molecularLessonToTour } from '../src/molecular-lesson-tour.js';
// @ts-ignore Shared DOM boundary for the production player.
import { tourEndHarness } from '../../lab/browser-roundtrip/fixtures/tour-end-harness.mjs';

const demoTour = (path: string) => molecularLessonToTour(JSON.parse(readFileSync(new URL(`../demos/${path}`, import.meta.url), 'utf8')));
for (const xr of [true, false]) for (const restored of [false, true]) {
  it(`CRISPR nuclease figures retain the authored close-up (XR=${xr}, cached=${restored})`, async () => {
    const h = tourEndHarness({ xr });
    const calls: string[] = [];
    let installed: unknown = {};
    Object.assign(h.workspace.viewer.inspection, {
      emphasize: async (value: any) => {
        if (value.framing) {
          expect(installed, 'the old figure must not expand the focus bounds').toBeUndefined();
          calls.push(`emphasis:${value.framing}:${value.focus.join(',')}`);
        }
      },
      setLessonFigure: async (value: any, options: any) => { installed = value; if (value && options.frame) calls.push('figure'); },
    });
    try {
      for (const step of demoTour('crispr-cas9.json').steps.filter(s => ['nucleases', 'recap-nucleases'].includes(s.id))) {
        calls.length = 0;
        // The close-up names the active site; the recap keeps its spheres but
        // no plate, which at its reading distance would be too small to read.
        expect(step.figure?.labels.map(label => label.text)).toEqual(step.id === 'nucleases' ? ['HNH active site, around H840A'] : []);
        await applyTourStep(h.workspace, step, () => true, !xr, 1000, undefined, undefined, false, restored);
        // The emphasis frames at the size each chapter authors: the closing
        // recap lights its whole key, so it frames at context size.
        expect(calls).toEqual([`emphasis:${step.id === 'nucleases' ? 'fill' : 'context'}:${(step.emphasis!.focus as string[]).join(',')}`]);
        expect(installed).toEqual(step.figure);
      }
    } finally { h.cleanup(); }
  });
}

it('comparison figures use explicit molecular focus while kinesin retains figure framing', async () => {
  const h = tourEndHarness({ xr: true });
  const calls: string[] = [];
  const focus: Record<string, string[]> = {
    'hemoglobin-switch/figure.json': ['alpha1-t', 'beta1-t', 'alpha2-t', 'beta2-t', 'alpha1-r', 'beta1-r', 'alpha2-r', 'beta2-r'],
    'atp-synthase-rotor/figure.json': ['beta-d1', 'beta-e1', 'beta-f1', 'gamma1', 'epsilon1', 'beta-d2', 'beta-e2', 'beta-f2', 'gamma2', 'epsilon2', 'beta-d3', 'beta-e3', 'beta-f3', 'gamma3', 'epsilon3'],
  };
  Object.assign(h.workspace.viewer.inspection, {
    emphasize: async (value: any) => { if (value.framing) calls.push(`emphasis:${value.framing}:${value.focus.join(',')}`); },
    setLessonFigure: async (value: any, options: any) => { if (value && options.frame) calls.push('figure'); },
    setVisibility: async () => {}, visibilityChains: () => [],
  });
  try {
    for (const path of ['hemoglobin-switch/figure.json', 'atp-synthase-rotor/figure.json', 'kinesin-walk/flipbook.json', 'kinesin-walk/cycle.json']) {
      for (const step of demoTour(path).steps.filter(s => s.figure)) {
        if (focus[path]) {
          expect(step.emphasis?.focus).toEqual(focus[path]);
          expect(step.emphasis?.framing).toBe('fill');
        } else expect(step.emphasis?.framing).toBeUndefined();
        // Visibility resolution is covered separately; this test isolates the framing owner.
        const entry = { ...step, visibility: undefined };
        for (const restored of [false, true]) {
          calls.length = 0;
          await applyTourStep(h.workspace, entry, () => true, false, 1000, undefined, undefined, false, restored);
          expect(calls, `${path}/${step.id}, cached=${restored}`).toEqual(focus[path]
            ? [`emphasis:fill:${focus[path].join(',')}`] : ['figure']);
        }
      }
    }
  } finally { h.cleanup(); }
});

it('installing a CRISPR close-up frames before its plate and cached desktop Back keeps the saved camera', async () => {
  const h = tourEndHarness({ xr: false }), lesson = demoTour('crispr-cas9.json');
  let installed: unknown;
  const frames: string[] = [];
  Object.assign(h.workspace.viewer.inspection, {
    emphasize: async (value: any) => {
      if (value.framing) { expect(installed).toBeUndefined(); frames.push('focus'); }
    },
    setLessonFigure: async (value: any, options: any) => { installed = value; if (value && options.frame) frames.push('figure'); },
  });
  const player = mountTourPlayer({ ...h, tours: [lesson] });
  try {
    await player.installLesson(lesson, { chapterId: 'nucleases', autoplay: false, narration: false }, undefined, true);
    expect(frames).toEqual(['focus']); expect(installed).toEqual(lesson.steps[4].figure);
    await player.next(); frames.length = 0;
    await player.back();
    expect(frames).toEqual([]); expect(installed).toEqual(lesson.steps[4].figure);
  } finally { player.pause(); h.cleanup(); }
});

const tour: Tour = { id: 'local-frame', title: 'Local frame', summary: '', steps: [
  { id: 'overview', title: 'Overview', placement: { scale: 1 } },
  { id: 'heme', title: 'Heme', placement: { scale: 2.2 }, emphasis: { parts: [], framing: 'fill' } },
] };
function harness(xr = true) {
  const h = tourEndHarness({ xr });
  let held = false, scale = 1;
  const frames: unknown[] = [];
  Object.assign(h.workspace.viewer.inspection, {
    supportsConcurrentPlayback: true, holdsWearerPlacement: () => held,
    beginChapterFraming: () => { held = false; },
    place: async (patch: any) => { scale = patch.scale; },
    emphasize: async (patch: any) => { if (patch.framing) frames.push(patch.framing); },
    restore: async (saved: any, options: any) => { if (!options.preservePlacement) scale = saved.scale; },
  });
  h.workspace.capture = () => ({ scale });
  const player = mountTourPlayer({ ...h, tours: [tour] });
  return { ...h, player, frames, scale: () => scale, hold: () => { held = true; scale = 3; }, release: () => { held = false; } };
}
for (const xr of [true, false]) it(`peer chapters replace manipulation with changed authored framing (XR=${xr})`, async () => {
  const h = harness(xr);
  const scene = (chapterId: string) => ({ sourceSha256: 'same', inspection: { lessonPlayback: {
    tourId: tour.id, chapterId, stopped: false, startingScene: { sourceSha256: 'same', inspection: {} },
  } } });
  try {
    await h.player.select(tour.id); await h.player.start(false, 0);
    await (h.player.restorePlayback as any)(scene('heme'), { frame: true });
    expect(h.scale()).toBe(2.2);
    expect(h.frames).toContain('fill');
    h.hold(); h.frames.length = 0;
    await (h.player.restorePlayback as any)(scene('overview'), { frame: true });
    // Widening is no close-up in the headset, so the wearer's hold stays there.
    expect(h.scale()).toBe(xr ? 3 : 1); expect(h.frames).toEqual([]);
  } finally { h.player.pause(); h.cleanup(); }
});
it('cached Back restores authored scale and focus; Back to the wider overview keeps a hold', async () => {
  const h = harness();
  try {
    await h.player.select(tour.id); await h.player.start(false, 0);
    await h.player.next(); expect(h.scale()).toBe(2.2);
    await h.player.back(); expect(h.scale()).toBe(1);
    h.frames.length = 0;
    await h.player.next(); expect(h.scale()).toBe(2.2); expect(h.frames).toContain('fill');
    // Widening is no close-up in the headset, so the wearer's hold stays.
    h.hold(); await h.player.back(); expect(h.scale()).toBe(3);
  } finally { h.player.pause(); h.cleanup(); }
});
it('desktop close-up replaces a hold and still frames after reset', async () => {
  const h = harness(false);
  try {
    await h.player.select(tour.id); await h.player.start(false, 0);
    h.hold(); await h.player.next(); expect(h.scale()).toBe(2.2);
    h.release(); await h.player.back(); await h.player.next();
    expect(h.scale()).toBe(2.2);
  } finally { h.player.pause(); h.cleanup(); }
});
