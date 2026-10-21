import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { grownTierIntent, mountTourPlayer, type Tour } from '../src/tour-player.js';
import { molecularLessonToTour } from '../src/molecular-lesson-tour.js';
// @ts-ignore The atomic viewer's actual geometry admission policy.
import { requireGeometryBudget } from '../../lab/browser-roundtrip/representation-budget.mjs';
// @ts-ignore Production player DOM adapter.
import { tourEndHarness } from '../../lab/browser-roundtrip/fixtures/tour-end-harness.mjs';

/** Execute the production source-to-panel lesson choice before its startup block. */
function panelLessonSelection(source: string) {
  const start = source.indexOf('    densityReferencePreview=');
  const declaration = source.indexOf('    const panelCustomTour=', start);
  const end = source.indexOf(';', declaration) + 1;
  expect(start).toBeGreaterThan(0); expect(declaration).toBeGreaterThan(start); expect(end).toBeGreaterThan(declaration);
  return `let densityReferencePreview=false, densityReferenceOnly=false;\n${source.slice(start, end)}`;
}

const lesson: Tour = { id: 'lesson-kinesin-entry', title: 'Walking motor', summary: '',
  presentation: { captionCard: 'shown', end: 'hold' },
  steps: [{ id: 'walking', title: 'Walking', durationMs: 28000, animation: { version: 1, durationSeconds: 7,
    playback: { autoplay: true, loop: true }, tracks: [] } }, { id: 'rest', title: 'Rest', durationMs: 12000 }] };

for (const path of ['microtubule-arrival/density', 'microtubule-growth/filament', 'kinesin-walk/motion', 'microtubule-growth/monomer']) {
  const map = /density|filament/.test(path);
  for (const entry of map ? ['fresh', 'explicit', 'direct', 'held', 'later', 'stopped'] : ['fresh']) {
    it(`${path} ${entry} entry frames only a fresh unheld map opening after room entry`, async () => {
      const tour = molecularLessonToTour(JSON.parse(readFileSync(new URL(`../demos/${path}.json`, import.meta.url), 'utf8')));
      const h = tourEndHarness({ xr: false });
      const snapshot = h.workspace.snapshot;
      let xr = false, held = false;
      h.workspace.snapshot = () => ({ ...snapshot(), xrPresenting: xr, atomCount: map ? 0 : 1000, triangleCount: map ? 178236 : 0 });
      const frames: any[] = [];
      const seatResets: any[] = [];
      Object.assign(h.workspace.viewer.inspection, {
        setMolecularAnimation: async () => {}, setLessonFigure: async () => {}, setVisibility: async () => {},
        visibilityChains: () => [...new Set(tour.steps.flatMap(step => step.visibility?.chains ?? []))]
          .map(labelChain => ({ labelChain, copyId: '1' })),
        holdsWearerPlacement: () => held,
        restoreTourSeat: async (options: any) => { if (xr) seatResets.push(options); },
        emphasize: async (value: any) => { if (xr && value.framing) frames.push(value); },
      });
      const player = mountTourPlayer({ ...h, tours: [tour] });
      try {
        await player.select(tour.id);
        if (entry === 'explicit') await player.installLesson(tour, { autoplay: false, narration: false }, undefined, 'auto');
        else await player.start(false, 0, { narration: false, waitForXrEntry: entry !== 'direct' });
        // The opening chapter must not change the source's model-to-room
        // scale before entry tracking is available.
        if (map && entry !== 'direct') expect(h.capture().placement.scale).toBe(1);
        if (entry === 'direct') expect(player.getState()).toMatchObject({ active: true, step: 0 });
        if (entry === 'later') {
          xr = true;
          player.notifyMutation(h.workspace.snapshot(), { origin: 'xr-entry' });
          await player.frameXrEntry?.();
          await player.next(); frames.length = 0; seatResets.length = 0; xr = false;
        }
        if (entry === 'stopped') player.stop();
        held = entry === 'held';
        xr = true;
        player.notifyMutation(h.workspace.snapshot(), { origin: 'xr-entry' });
        expect(frames).toHaveLength(0);
        await player.frameXrEntry?.();
        await player.nextReadoutPage();
        expect(frames.some(value => value.framing === 'fill')).toBe(map && ['fresh', 'explicit'].includes(entry));
        expect(seatResets).toEqual(map && ['fresh', 'explicit'].includes(entry) ? [{ restart: true }] : []);
        expect(player.getState()).toMatchObject({ active: entry !== 'stopped', step: entry === 'later' ? 1 : entry === 'stopped' ? -1 : 0, autoplay: false, narration: false });
        const count = frames.length;
        player.notifyMutation(h.workspace.snapshot(), { origin: 'xr-entry' });
        await player.frameXrEntry?.();
        await player.nextReadoutPage();
        expect(frames).toHaveLength(count);
      } finally { player.pause(); h.cleanup(); }
    });
  }
}

for (const path of ['microtubule-arrival/density', 'microtubule-growth/filament']) {
  for (const drawsMap of [false, true]) {
    for (const explicitStart of [false, true]) {
      it(`${path} starts on its map panel and leaves its atomic reference panel saveable (map=${drawsMap}, explicit start=${explicitStart})`, async () => {
        const manifest = JSON.parse(readFileSync(new URL(`../demos/${path}.json`, import.meta.url), 'utf8'));
        const tour = molecularLessonToTour(manifest);
        const h = tourEndHarness({ xr: false });
        const configured: any[] = [];
        h.workspace.viewer.inspection.configure = async (patch: any) => {
          if (!drawsMap && patch.representation) requireGeometryBudget({ representation: patch.representation, atoms: 327, residues: 46 });
          configured.push(patch);
        };
        const player = mountTourPlayer({ ...h, tours: [] });
        const source = readFileSync(new URL('../src/inspector.ts', import.meta.url), 'utf8');
        const start = source.indexOf('      const hasSavedPlayback=Boolean(data.scene?.inspection?.lessonPlayback);');
        const end = source.indexOf('\n      installedLesson=panelCustomTour;', start);
        expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
        const script = ts.transpileModule(`(async()=>{${panelLessonSelection(source)}\n${source.slice(start, end)}})()`,
          { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
        try {
          await vm.runInNewContext(script, { swappedSource: false, priorLessonOnScreen: false, priorAutoplay: false, data: { customTour: tour, density: { sha256: manifest.coordinates.sha256 },
            ...(explicitStart ? { lessonStart: { autoplay: false, narration: false } } : {}) },
            density: drawsMap ? { sha256: manifest.coordinates.sha256 } : undefined,
            isCompanion: drawsMap, options: {}, initialOpen: true,
            TOURS: [], tourPlayer: player, experience: undefined, closed: false, generation: 1, ownGeneration: 1 });
          expect(player.getState()).toMatchObject({ active: drawsMap, step: drawsMap ? 0 : -1 });
          expect(player.getState().selectedId).toBe(drawsMap ? tour.id : undefined);
          expect(player.getState().tours.some(item => item.id === tour.id)).toBe(drawsMap);
          expect(configured.some(patch => patch.representation === 'isosurface')).toBe(drawsMap);
        } finally { player.pause(); h.cleanup(); }
      });
    }
  }
}

it('a freshly inspected lesson renders its opening chapter before the first attachment save', async () => {
  const h = tourEndHarness({ xr: false });
  h.workspace.viewer.inspection.setMolecularAnimation = async () => {};
  const player = mountTourPlayer({ ...h, tours: [] });
  const source = readFileSync(new URL('../src/inspector.ts', import.meta.url), 'utf8');
  const start = source.indexOf('      const hasSavedPlayback=Boolean(data.scene?.inspection?.lessonPlayback);');
  const end = source.indexOf('\n      installedLesson=panelCustomTour;', start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const script = ts.transpileModule(`(async()=>{${panelLessonSelection(source)}\n${source.slice(start, end)}})()`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  try {
    await vm.runInNewContext(script, { swappedSource: false, priorLessonOnScreen: false, priorAutoplay: false, data: { customTour: lesson }, TOURS: [], tourPlayer: player,
      density: undefined, isCompanion: false, options: {}, initialOpen: true,
      experience: undefined, closed: false, generation: 1, ownGeneration: 1 });
    expect(player.getState()).toMatchObject({ selectedId: lesson.id, step: 0, active: true, autoplay: false, narration: false });
  } finally { player.pause(); h.cleanup(); }
});

it('entry seating and same-source XR edits keep an active lesson, while Done and source changes stop it', async () => {
  const h = tourEndHarness({ xr: true });
  h.workspace.viewer.inspection.setMolecularAnimation = async () => {};
  const player = mountTourPlayer({ ...h, tours: [lesson] });
  try {
    await player.select(lesson.id); await player.start(false, 0, { narration: false });
    player.notifyMutation(h.workspace.snapshot());
    expect(player.getState()).toMatchObject({ step: 0, active: true, stopped: false });
    await player.next(); expect(player.getState()).toMatchObject({ step: 1, active: true });
    player.stop('Ended by the wearer.'); expect(player.getState().active).toBe(false);
    await player.start(false, 0, { narration: false });
    player.notifyMutation({ ...h.workspace.snapshot(), sourceSha256: 'another-source' });
    expect(player.getState().active).toBe(false);
  } finally { player.pause(); h.cleanup(); }
});

it('a lesson opened on desktop adopts the XR entry frame for later restart and Done', async () => {
  const h = tourEndHarness({ xr: false });
  let xr = false, cursor: any;
  let camera = { position: [0, 0, 500], target: [0, 0, 0] };
  let placement = { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 };
  const capture = h.workspace.capture, snapshot = h.workspace.snapshot;
  h.workspace.capture = () => ({ ...capture(), camera: structuredClone(camera), inspection: { placement: structuredClone(placement) } });
  h.workspace.snapshot = () => ({ ...snapshot(), xrPresenting: xr });
  Object.assign(h.workspace.viewer.inspection, { setMolecularAnimation: async () => {},
    setLessonPlayback: (value: any) => { cursor = structuredClone(value); } });
  const player = mountTourPlayer({ ...h, tours: [lesson] });
  try {
    await player.select(lesson.id); await player.start(false, 0, { narration: false });
    xr = true; camera = { position: [5, 20, 400], target: [0, 0, 0] };
    placement = { translation: [.2, .5, -1.8], rotation: [0, 0, 0], scale: 1.58 };
    player.notifyMutation(h.workspace.snapshot(), { origin: 'xr-entry' });
    expect(cursor.startingScene.camera).toEqual(camera);
    expect(cursor.startingScene.inspection.placement).toEqual(placement);
    expect(player.getState()).toMatchObject({ active: true, step: 0 });
  } finally { player.pause(); h.cleanup(); }
});


// Execute both startup sites from hydration, separated by save/attach.
async function hydrateLesson(player: ReturnType<typeof mountTourPlayer>, h: any, tour: Tour,
  route: 'fresh' | 'named' | 'grow', saved: () => void, priorAutoplay = false) {
  const source = readFileSync(new URL('../src/inspector.ts', import.meta.url), 'utf8');
  const start = source.indexOf('      const hasSavedPlayback=Boolean(data.scene?.inspection?.lessonPlayback);');
  const end = source.indexOf('\n      installedLesson=panelCustomTour;', start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const grownStart = source.indexOf('async function openGrownTier(');
  const grownEnd = source.indexOf('\nasync function navigateExperience', grownStart);
  const lateStart = source.indexOf('  if(!completion) {', end);
  const lateEnd = source.indexOf('\n  return completionReceipt;', lateStart);
  const script = ts.transpileModule(`(async()=>{
    let restoredLessonPlayback=false;
    ${panelLessonSelection(source)}
    ${source.slice(grownStart, grownEnd)}
    ${source.slice(start, end)}
    saved();
    ${source.slice(lateStart, lateEnd)}
  })()`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  await vm.runInNewContext(script, {
    data: { customTour: tour, ...(route === 'named' ? { lessonStart: { autoplay: false, narration: false } } : {}) },
    TOURS: [], tourPlayer: player, workspace: h.workspace, grownTierIntent, saved, options: {},
    density: undefined, isCompanion: h.workspace.snapshot().xrPresenting === true,
    experience: undefined, completion: undefined, closed: false, generation: 1, ownGeneration: 1,
    swappedSource: true, grownLesson: tour, initialOpen: route === 'fresh',
    priorLessonOnScreen: route === 'grow', priorAutoplay,
    recordHeadsetEvent: () => {},
  });
}

for (const xr of [false, true]) for (const route of ['fresh', 'named', 'grow'] as const) {
  const stage = route === 'grow' ? 'dimer' : 'monomer';
  it(`${route} opens the authored ${stage} chapter once before saving (XR=${xr})`, async () => {
    vi.useFakeTimers();
    const h = tourEndHarness({ xr });
    const manifest = JSON.parse(readFileSync(new URL(`../demos/microtubule-growth/${stage}.json`, import.meta.url), 'utf8'));
    const tour = molecularLessonToTour(manifest);
    const places: any[] = [], motions: any[] = [];
    let fits = 0, draws = 0;
    const place = h.workspace.viewer.inspection.place;
    h.workspace.viewer.inspection.place = async (patch: any) => { places.push(patch); await place(patch); };
    h.workspace.viewer.inspection.fit = async () => { fits++; };
    h.workspace.viewer.inspection.emphasize = async () => { draws++; };
    h.workspace.viewer.inspection.applyLessonMotion = async (move: any) => { motions.push(move); };
    const player = mountTourPlayer({ ...h, tours: [] });
    try {
      let drawsAtSave = 0;
      await hydrateLesson(player, h, tour, route, () => { drawsAtSave = draws; });
      expect(places).toEqual([tour.steps[0].placement]);
      expect(drawsAtSave).toBe(1);
      expect(draws).toBe(drawsAtSave);
      expect(fits).toBe(xr ? 0 : 1);
      // Only a headset grow under the lesson on screen continues it aloud.
      expect(player.getState()).toMatchObject({ selectedId: tour.id, step: 0, active: true, autoplay: false,
        narration: route === 'grow' && xr });
      await vi.advanceTimersByTimeAsync(8000);
      expect(motions.length).toBeGreaterThan(0);
      expect(motions.every(move => move.kind === 'orbit' && move.axis === 'y')).toBe(true);
      expect(motions.reduce((sum, move) => sum + move.degrees, 0)).toBeCloseTo(25);
    } finally { player.pause(); h.cleanup(); vi.useRealTimers(); }
  });
}

it('a headset grow under a playing lesson opens its chapter once and keeps playing', async () => {
  const h = tourEndHarness({ xr: true });
  const tour = molecularLessonToTour(JSON.parse(readFileSync(new URL('../demos/microtubule-growth/dimer.json', import.meta.url), 'utf8')));
  let draws = 0;
  h.workspace.viewer.inspection.emphasize = async () => { draws++; };
  const player = mountTourPlayer({ ...h, tours: [] });
  try {
    await hydrateLesson(player, h, tour, 'grow', () => { expect(draws).toBe(1); }, true);
    expect(draws).toBe(1);
    expect(player.getState()).toMatchObject({ step: 0, active: true, autoplay: true, narration: true });
  } finally { player.pause(); h.cleanup(); }
});

it('installs and draws a source replacement animated opening only once with its real motion', async () => {
  const h = tourEndHarness({ xr: true });
  const manifest = JSON.parse(readFileSync(new URL('../demos/kinesin-walk/motion.json', import.meta.url), 'utf8'));
  const tour = molecularLessonToTour(manifest);
  let builds = 0;
  const turns: any[] = [];
  h.workspace.viewer.inspection.setMolecularAnimation = async (animation: any) => { if (animation) builds++; };
  h.workspace.viewer.inspection.setMotion = async (patch: any) => { turns.push(patch); };
  h.workspace.viewer.inspection.setLessonFigure = async () => {};
  h.workspace.viewer.inspection.setVisibility = async () => {};
  h.workspace.viewer.inspection.visibilityChains = () => manifest.chapters[0].immersive.visibility.chains.map((labelChain: string) => ({ labelChain, copyId: '1' }));
  const player = mountTourPlayer({ ...h, tours: [] });
  try {
    await hydrateLesson(player, h, tour, 'named', () => { expect(builds).toBe(1); });
    expect(builds).toBe(1);
    // The opening chapter's authored hold stops the presentation turn.
    expect(turns).toEqual([{ paused: true }]);
    expect(player.getState()).toMatchObject({ selectedId: tour.id, step: 0, active: true, autoplay: false, narration: false });
  } finally { player.pause(); h.cleanup(); }
});

for (const xr of [false, true]) it(`a named spike applies its authored fit before saving (XR=${xr})`, async () => {
  const h = tourEndHarness({ xr });
  const tour = molecularLessonToTour(JSON.parse(readFileSync(new URL('../demos/spike.json', import.meta.url), 'utf8')));
  const frames: string[] = [];
  h.workspace.viewer.inspection.fit = async () => { frames.push('desktop-fit'); };
  // A fresh XR entry solves its seat against the chapter's compact controls.
  h.workspace.viewer.inspection.seatForEntry = async () => {
    expect(player.getState()).toMatchObject({ step: 0, active: true, navigating: false });
    frames.push('xr-entry');
  };
  const player = mountTourPlayer({ ...h, tours: [] });
  try {
    await hydrateLesson(player, h, tour, 'named', () => {
      expect(frames).toEqual([xr ? 'xr-entry' : 'desktop-fit']);
      expect(h.capture().placement).toMatchObject(tour.steps[0].placement!);
      expect(player.getState()).toMatchObject({ step: 0, active: true });
    });
    expect(frames).toHaveLength(1);
  } finally { player.pause(); h.cleanup(); }
});

it('a named spike keeps its opening chapter when the headset seat is refused', async () => {
  const h = tourEndHarness({ xr: true });
  const tour = molecularLessonToTour(JSON.parse(readFileSync(new URL('../demos/spike.json', import.meta.url), 'utf8')));
  h.workspace.viewer.inspection.seatForEntry = async () => { throw Error('Enter VR and wait for tracking before recentring the structure.'); };
  const player = mountTourPlayer({ ...h, tours: [] });
  try {
    await hydrateLesson(player, h, tour, 'named', () => {});
    expect(h.capture().placement).toMatchObject(tour.steps[0].placement!);
    expect(player.getState()).toMatchObject({ selectedId: tour.id, step: 0, active: true });
  } finally { player.pause(); h.cleanup(); }
});
