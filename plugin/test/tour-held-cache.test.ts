import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { molecularLessonToTour } from '../src/molecular-lesson-tour.js';
import { mountTourPlayer } from '../src/tour-player.js';
// @ts-ignore Production player with a DOM boundary; molecular rendering is adapted below.
import { tourEndHarness } from '../../lab/browser-roundtrip/fixtures/tour-end-harness.mjs';

const tour = molecularLessonToTour(JSON.parse(readFileSync(new URL('../demos/atp-synthase-rotor/motion.json', import.meta.url), 'utf8')));
const copyId = '["copy","asymmetric_unit",null,[]]';
function setup(xr = true, atomic = true) {
  const h = tourEndHarness({ xr });
  const chains = new Set<string>();
  for (const step of tour.steps) for (const chain of step.visibility?.chains ?? [])
    chains.add(typeof chain === 'string' ? chain : chain.labelChain);
  const rows = [...chains].map(labelChain => ({ key: labelChain, entityType: 'polymer',
    identity: { labelChain, authorChain: labelChain, copyId, modelNumber: 1 } }));
  let held = false, source = 'atp-source';
  let scene: any = { sourceSha256: source, modelNumber: 1, assemblyId: 'asymmetric_unit', selectionKeys: [],
    camera: { position: [0, 0, 40], target: [0, 0, 0], up: [0, 1, 0] },
    inspection: { placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 },
      appearance: {}, visibility: { hiddenChains: [], hiddenClasses: [], showOnlySelection: false } } };
  const figures: any[] = [], restores: any[] = [];
  h.workspace.rows = () => rows;
  h.workspace.capture = () => structuredClone(scene);
  h.workspace.snapshot = () => ({ ready: true, sourceSha256: source, xrPresenting: xr, modelNumber: 1,
    selectionKeys: scene.selectionKeys, inspection: scene.inspection });
  Object.assign(h.workspace.viewer.inspection, {
    supportsConcurrentPlayback: true, holdsWearerPlacement: () => held,
    beginChapterFraming: () => { held = false; },
    configure: async (patch: any) => { Object.assign(scene.inspection.appearance, patch); },
    place: async (patch: any) => { Object.assign(scene.inspection.placement, patch); },
    emphasize: async (value: any) => { scene.inspection.emphasis = structuredClone(value); },
    setLessonFigure: async (value: any) => { figures.push(structuredClone(value)); scene.inspection.figure = structuredClone(value); },
    visibility: () => structuredClone(scene.inspection.visibility),
    setVisibility: async (value: any) => { scene.inspection.visibility = structuredClone(value); },
    setMolecularAnimation: async (value: any, chapterId: string) => {
      scene.inspection.animation = value ? { definition: structuredClone(value), playback: { chapterId, state: 'playing' } } : undefined;
    },
    restore: async (saved: any, options: any) => {
      expect(saved.sourceSha256).toBe(source);
      const { camera, inspection: { placement } } = scene;
      scene = structuredClone(saved);
      if (options?.preserveCamera) scene.camera = camera;
      if (options?.preservePlacement) scene.inspection.placement = placement;
      restores.push(structuredClone(options));
    },
  });
  if (atomic) h.workspace.viewer.inspection.setAnimatedChapter = async (value: any, chapterId: string, figure: any) => {
    await h.workspace.viewer.inspection.setLessonFigure(figure);
    await h.workspace.viewer.inspection.setMolecularAnimation(value, chapterId);
  };
  const player = mountTourPlayer({ ...h, tours: [tour] });
  const move = (value: number) => {
    held = true;
    scene.inspection.placement = { translation: [value, 2, 3], rotation: [10, 20, 30], scale: 1.7 };
    scene.camera.position = [value, 1, 40];
  };
  const walk = async () => {
    await player.select(tour.id); await player.start(false, 0);
    await player.next(); move(1);
    for (let index = 2; index <= 5; index++) await player.next();
    const distance = h.workspace.capture();
    await player.next(); move(2);
    figures.length = 0; restores.length = 0;
    return distance;
  };
  return { ...h, player, figures, restores, move, walk, held: () => held,
    release: () => { held = false; }, replaceSource: () => { source = scene.sourceSha256 = 'replacement-source'; },
    cleanup: () => { player.pause(); h.cleanup(); } };
}

for (const xr of [true, false]) for (const atomic of [true, false])
it(`Back after moving ATP reuses only the target content and keeps the latest pose (XR=${xr}, atomic=${atomic})`, async () => {
  const h = setup(xr, atomic);
  try {
    const distance: any = await h.walk(), latest: any = h.workspace.capture();
    await h.player.back();
    expect(h.player.getState()).toMatchObject({ step: 5, active: true });
    expect(h.figures).toEqual([tour.steps[5].figure]);
    const shown: any = h.workspace.capture();
    expect(shown).toEqual({ ...distance, camera: latest.camera,
      inspection: { ...distance.inspection, placement: latest.inspection.placement } });
    expect(h.restores).toEqual([{ preserveCamera: true, preservePlacement: true }]);
    expect(h.held()).toBe(true);
    h.figures.length = 0;
    await h.player.next(); await h.player.back();
    expect(h.figures).toEqual([tour.steps[6].figure, tour.steps[5].figure]);
    expect((h.workspace.capture() as any).inspection.placement).toEqual(latest.inspection.placement);
  } finally { h.cleanup(); }
});

it('a held atomic chapter keeps its complete animation available for Rejoin', async () => {
  const h = setup();
  try {
    await h.walk(); const before: any = h.workspace.capture();
    await h.player.rejoin();
    expect(h.figures).toEqual([tour.steps[6].figure]);
    expect(h.workspace.capture()).toEqual(before);
    expect(before.inspection.animation).toMatchObject({ definition: tour.steps[6].animation,
      playback: { chapterId: 'turn', state: 'playing' } });
    expect(h.restores).toEqual([{ preserveCamera: true, preservePlacement: true }]);
  } finally { h.cleanup(); }
});

it('a released placement cannot reuse a held chapter as its authored pose', async () => {
  const h = setup();
  try {
    await h.walk(); h.release();
    await h.player.back();
    expect(h.figures).toEqual(tour.steps.slice(0, 6).map(step => step.figure));
    expect(h.player.getState()).toMatchObject({ step: 5, active: true });
    expect(h.held()).toBe(false);
  } finally { h.cleanup(); }
});

it('held chapter content never crosses a source replacement', async () => {
  const h = setup();
  try {
    await h.walk(); h.replaceSource();
    await expect(h.player.back()).rejects.toThrow('structure changed');
    expect(h.figures).toEqual([]); expect(h.restores).toEqual([]);
  } finally { h.cleanup(); }
});
