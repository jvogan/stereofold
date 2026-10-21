import { afterEach, expect, it, vi } from 'vitest';
import { mountTourPlayer, type Tour } from '../src/tour-player.js';
// @ts-ignore Real player DOM boundary and diagnostics; no browser or device.
import { tourEndHarness } from '../../lab/browser-roundtrip/fixtures/tour-end-harness.mjs';

const animation = { version: 1, durationSeconds: 4, playback: { autoplay: true, loop: true }, tracks: [] } as any;
const openingFigure = { layers: [], labels: [{ id: 'opening' }], distances: [] } as any;
const movingFigure = { layers: [], labels: [{ id: 'moving' }], distances: [] } as any;
const lesson: Tour = { id: 'custom-installed', title: 'Installed custom lesson', summary: '', steps: [
  { id: 'opening', title: 'Opening', appearance: { representation: 'cartoon', uniformColor: '#123456', opacity: .8 }, figure: openingFigure },
  // This chapter deliberately inherits representation and colour from the installed scene.
  { id: 'moving', title: 'Moving', appearance: { opacity: .4 }, animation, figure: movingFigure },
] };

afterEach(() => vi.useRealTimers());

function stage(xr = true) {
  vi.useFakeTimers();
  const h = tourEndHarness({ xr });
  const inspection = h.workspace.viewer.inspection;
  const paints: unknown[] = [], figures: unknown[] = [];
  const originalCapture = h.capture, originalRestore = inspection.restore, originalConfigure = inspection.configure;
  let figure: unknown, held = false, sourceSha256 = 'same';
  h.workspace.capture = () => ({ ...originalCapture(), figure: structuredClone(figure) });
  const snapshot = h.workspace.snapshot;
  h.workspace.snapshot = () => ({ ...snapshot(), sourceSha256 });
  Object.assign(inspection, {
    configure: async (patch: any) => { paints.push(structuredClone(patch)); await originalConfigure(patch); },
    setLessonFigure: async (value: unknown) => { figures.push(value); figure = structuredClone(value); },
    setMolecularAnimation: async () => {},
    setAnimatedChapter: async (_animation: unknown, _chapter: string, value: unknown) => {
      figures.push(value); figure = structuredClone(value);
    },
    holdsWearerPlacement: () => held,
    restore: async (scene: any, options: any) => {
      await originalRestore(scene, options); figure = structuredClone(scene.figure);
    },
  });
  const player = mountTourPlayer({ ...h, tours: [lesson] });
  return { h, player, paints, figures, inspection, capture: h.workspace.capture,
    hold: (value: boolean) => { held = value; }, source: (value: string) => { sourceSha256 = value; },
    close: () => { player.pause(); h.cleanup(); } };
}

it.each([false, true])('first Next after installation paints only the next chapter and retains inherited authored state (XR=%s)', async xr => {
  const s = stage(xr);
  try {
    await s.player.installLesson(lesson, { chapterId: 'opening', autoplay: false, narration: false });
    const installed = s.capture();
    s.paints.length = 0; s.figures.length = 0; s.h.restores.length = 0;
    await s.player.next();
    expect(s.player.getState()).toMatchObject({ step: 1, active: true });
    expect(s.h.restores).toEqual([]);
    expect(s.paints).toEqual([{ opacity: .4 }]);
    expect(s.figures).toEqual([movingFigure]);
    expect(s.capture()).toMatchObject({ appearance: { representation: 'cartoon', uniformColor: '#123456', opacity: .4 }, figure: movingFigure });
    await s.player.back();
    expect(s.capture().appearance).toEqual(installed.appearance);
    expect(s.capture().figure).toEqual(openingFigure);
  } finally { s.close(); }
});

it('an intervening scene edit invalidates the installed chapter live proof', async () => {
  const s = stage();
  try {
    await s.player.installLesson(lesson, { autoplay: false, narration: false });
    await s.inspection.configure({ uniformColor: '#abcdef' });
    s.player.notifyMutation(s.h.workspace.snapshot(), { agent: true });
    s.h.restores.length = 0;
    await s.player.next();
    expect(s.h.restores).toHaveLength(1);
    expect(s.capture().appearance).toMatchObject({ uniformColor: '#123456', opacity: .4 });
    expect(s.player.getState()).toMatchObject({ step: 1, active: true });
  } finally { s.close(); }
});

for (const xr of [false, true]) it(`restarting interchangeable hidden-base figures retains their established view (XR=${xr})`, async () => {
  const s = stage(xr);
  const composite: Tour = { ...lesson, steps: lesson.steps.map(({ animation: _animation, ...entry }) => ({
    ...entry, appearance: { opacity: 0 }, motion: 'hold',
  })) };
  const capture = s.h.workspace.capture, restore = s.inspection.restore;
  let camera = { position: [0, 0, 40], target: [0, 0, 0], up: [0, 1, 0] };
  s.h.workspace.capture = () => {
    const scene = capture();
    return { ...scene, camera: structuredClone(camera), inspection: { placement: structuredClone(scene.placement) } };
  };
  s.inspection.preservesFigureFrame = () => true;
  s.inspection.restore = async (saved: any, options: any) => {
    await restore({ ...saved, placement: saved.inspection.placement }, options);
    if (!options?.preserveCamera) camera = structuredClone(saved.camera);
  };
  try {
    await s.player.installLesson(composite, { autoplay: false, narration: false });
    // The first figure frames after the pre-figure source baseline was taken.
    await s.inspection.place({ scale: 2.1, translation: [.3, .2, -2.7], rotation: [0, 20, 0] });
    camera = { ...camera, position: [2, 1, 38] };
    const shown = s.h.workspace.capture();
    await s.player.start(false, 0, { narration: false });
    expect(s.h.workspace.capture()).toMatchObject({ camera: shown.camera, placement: shown.placement,
      inspection: { placement: shown.inspection.placement }, figure: composite.steps[0].figure });
    await s.player.next();
    await s.player.start(false, 0, { narration: false });
    expect(s.h.workspace.capture()).toMatchObject({ camera: shown.camera, placement: shown.placement });
    expect(s.player.getState()).toMatchObject({ active: true, step: 0, navigating: false });
  } finally { s.close(); }
});

it('a held installation keeps live placement through Next without caching it for a later authored return', async () => {
  const s = stage();
  const placed: Tour = { ...lesson, steps: lesson.steps.map((step, index) => ({ ...step, placement: { scale: index ? 4 : 2 } })) };
  try {
    s.hold(true);
    await s.inspection.place({ scale: 3 });
    await s.player.installLesson(placed, { autoplay: false, narration: false }, undefined, 'entry');
    expect(s.capture().placement.scale).toBe(3);
    await s.player.next();
    expect(s.capture().placement.scale).toBe(3);
    s.hold(false); // Reset releases the wearer hold; the authored frame must apply again.
    await s.player.back();
    expect(s.player.getState().step).toBe(0);
    expect(s.capture().placement.scale).toBe(2);
  } finally { s.close(); }
});

it.each(['failure', 'interrupted'] as const)('a replacement lesson installation %s restores the prior scene without leaving a new cache', async outcome => {
  const s = stage();
  const replacement: Tour = { ...lesson, id: 'replacement', steps: lesson.steps.map(step => ({ ...step,
    appearance: { uniformColor: '#ff0000' }, figure: { layers: [], labels: [{ id: 'replacement' }] } as any })) };
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const setFigure = s.inspection.setLessonFigure;
  try {
    await s.player.installLesson(lesson, { autoplay: false, narration: false });
    const before = s.capture();
    s.inspection.setLessonFigure = async (value: unknown) => {
      await setFigure(value); entered();
      if (outcome === 'failure') throw Error('The figure could not be drawn.');
      await gate;
    };
    const rejected = s.player.installLesson(replacement, { autoplay: false, narration: false }).then(
      () => { throw Error('The interrupted installation unexpectedly succeeded.'); }, error => error);
    await started;
    if (outcome === 'interrupted') s.player.pause();
    release();
    expect((await rejected).message).toBe(outcome === 'failure' ? 'The figure could not be drawn.' : 'The lesson installation was interrupted.');
    expect(s.capture()).toMatchObject({ appearance: before.appearance, placement: before.placement, figure: before.figure });
    expect(s.player.getState()).toMatchObject({ selectedId: lesson.id, step: 0, active: true });
    s.inspection.setLessonFigure = setFigure;
    await s.player.next();
    expect(s.capture().appearance).toMatchObject({ uniformColor: '#123456', opacity: .4 });
    expect(s.capture().figure).toEqual(movingFigure);
    expect(s.player.getState()).toMatchObject({ selectedId: lesson.id, step: 1, active: true });
  } finally { release(); s.close(); }
});

it('the installed scene cache never bypasses source identity', async () => {
  const s = stage();
  try {
    await s.player.installLesson(lesson, { autoplay: false, narration: false });
    s.paints.length = 0; s.figures.length = 0; s.h.restores.length = 0;
    s.source('another-source');
    await expect(s.player.next()).rejects.toThrow('The structure changed.');
    expect(s.paints).toEqual([]);
    expect(s.figures).toEqual([]);
    expect(s.h.restores).toEqual([]);
  } finally { s.close(); }
});
