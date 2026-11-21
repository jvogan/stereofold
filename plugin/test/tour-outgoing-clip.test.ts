import { expect, it } from 'vitest';
import { mountTourPlayer, type Tour } from '../src/tour-player.js';
// @ts-ignore Production player with a DOM boundary; molecular rendering is adapted below.
import { tourEndHarness } from '../../lab/browser-roundtrip/fixtures/tour-end-harness.mjs';

// A chapter that ends with its clip on screen hands over to the next chapter
// from the pose the wearer last saw. The scene the next chapter is painted
// over is the previous chapter's saved one, and that was saved as its clip
// began: restoring its clock as saved drew the clip's first pose under the
// next chapter until that chapter had painted (the start-pose flash).

const clip = (durationSeconds: number) => ({ version: 1, durationSeconds, playback: { autoplay: true, loop: false, speed: 1 }, tracks: [] }) as any;
const figure = (id: string) => ({ layers: [{ id, target: { chain: 'A' }, representation: 'cartoon', color: '#808080', opacity: 1, context: false }], labels: [], distances: [] }) as any;
const lesson = (second: 'still' | 'clip'): Tour => ({ id: `outgoing-${second}`, title: 'Outgoing clip', summary: '', steps: [
  { id: 'assemble', title: 'Assemble', durationMs: 10_000, figure: figure('first'), animation: clip(9) },
  second === 'clip'
    ? { id: 'arrive', title: 'Arrive', durationMs: 10_000, figure: figure('second'), animation: clip(2) }
    : { id: 'contacts', title: 'Contacts', durationMs: 10_000, figure: figure('second') },
] });
// Three clip chapters in a row, as a lesson that builds a structure part by part.
const build: Tour = { id: 'build', title: 'Build', summary: '', steps: ['dimer', 'extend', 'neighbor'].map(id =>
  ({ id, title: id, durationMs: 10_000, figure: figure(id), animation: clip(4) })) };

function setup(tour: Tour) {
  const h = tourEndHarness({ xr: true });
  // The clip's own clock: where the wearer last saw it.
  let liveSeconds = 0;
  let holding = false;
  // The clip the figure masks its state copies by, as the viewer keeps it: a
  // figure installed under a running clip takes that clip, one installed with
  // none takes none, and taking the clip off leaves the figure's as it was. A
  // capture with no clock carries it as `lessonFigureAnimation`.
  let figureClip: unknown;
  let scene: any = { sourceSha256: 'same', modelNumber: 1, assemblyId: '', selectionKeys: [],
    camera: { position: [0, 0, 40], target: [0, 0, 0], up: [0, 1, 0] },
    inspection: { placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 }, appearance: {},
      visibility: { hiddenChains: [], hiddenClasses: [], showOnlySelection: false } } };
  /** Each clip pose a scene restore puts on screen: the clip's chapter and the time it is drawn at. */
  const drawn: { chapterId: string; timeSeconds: number }[] = [];
  /** The clip each restored scene's figure masks its copies by, when that scene has no clock. */
  const masks: unknown[] = [];
  const clock = () => scene.inspection.animation?.playback;
  h.workspace.capture = () => {
    const captured = structuredClone(scene);
    if (figureClip && !captured.inspection.animation) captured.inspection.lessonFigureAnimation = structuredClone(figureClip);
    return captured;
  };
  h.workspace.snapshot = () => ({ ready: true, sourceSha256: 'same', xrPresenting: true, modelNumber: 1,
    selectionKeys: [], inspection: scene.inspection });
  Object.assign(h.workspace.viewer.inspection, {
    supportsConcurrentPlayback: true, holdsWearerPlacement: () => holding,
    configure: async (patch: any) => { Object.assign(scene.inspection.appearance, patch); },
    place: async (patch: any) => { Object.assign(scene.inspection.placement, patch); },
    emphasize: async (value: any) => { scene.inspection.emphasis = structuredClone(value); },
    setLessonFigure: async (value: any) => {
      scene.inspection.lessonFigure = structuredClone(value);
      figureClip = scene.inspection.animation?.definition;
    },
    visibility: () => structuredClone(scene.inspection.visibility),
    setVisibility: async (value: any) => { scene.inspection.visibility = structuredClone(value); },
    setMolecularAnimation: async (value: any, chapterId: string) => {
      if (value) { liveSeconds = 0; figureClip = value; scene.inspection.animation = { definition: structuredClone(value),
        playback: { id: `clip-${chapterId}`, chapterId, state: 'playing', timeSeconds: 0 } }; }
      else delete scene.inspection.animation;
    },
    // A pause publishes the clock where it stands, as the viewer's does.
    controlMolecularAnimation: (patch: any) => {
      const playback = clock();
      if (!playback) return null;
      Object.assign(playback, { state: patch.state === 'pause' ? 'paused' : 'playing', timeSeconds: liveSeconds });
      return structuredClone(playback);
    },
    restore: async (saved: any) => {
      scene = structuredClone(saved);
      figureClip = saved.inspection?.lessonFigureAnimation ?? saved.inspection?.animation?.definition;
      delete scene.inspection.lessonFigureAnimation;
      if (!saved.inspection?.animation) masks.push(saved.inspection?.lessonFigureAnimation);
      const playback = clock();
      if (playback) { drawn.push({ chapterId: playback.chapterId, timeSeconds: playback.timeSeconds }); liveSeconds = playback.timeSeconds; }
    },
  });
  h.workspace.viewer.inspection.setAnimatedChapter = async (value: any, chapterId: string, value2: any) => {
    await h.workspace.viewer.inspection.setLessonFigure(value2);
    await h.workspace.viewer.inspection.setMolecularAnimation(value, chapterId);
  };
  const player = mountTourPlayer({ ...h, tours: [tour] });
  return { ...h, player, drawn, masks, clock, run: (seconds: number) => { liveSeconds = seconds; },
    hold: (value: boolean) => { holding = value; },
    cleanup: () => { player.pause(); h.cleanup(); } };
}

for (const second of ['still', 'clip'] as const)
for (const seconds of [9, 4])
it(`hands over from the clip's ${seconds === 9 ? 'last' : 'mid-clip'} pose, never its first, to a ${second} chapter after a headset edit`, async () => {
  const h = setup(lesson(second));
  try {
    await h.player.select(`outgoing-${second}`); await h.player.start(false, 0);
    expect(h.player.getState()).toMatchObject({ step: 0, active: true });
    expect(h.clock()).toMatchObject({ chapterId: 'assemble', timeSeconds: 0 });
    // The clip plays out, or the wearer leaves partway through it; then the
    // menu moves, which no longer matches the saved chapter, so the next
    // chapter is painted over the saved one.
    h.run(seconds);
    h.player.notifyMutation(h.workspace.snapshot(), { agent: true });
    h.drawn.length = 0; h.masks.length = 0;
    await h.player.next();
    expect(h.player.getState()).toMatchObject({ step: 1, active: true });
    // A chapter painted after the clip came off keeps the clip's t=0 copy mask
    // on its figure, as the structure had it when the clip came off.
    expect(h.masks).toEqual(second === 'still' ? [lesson('still').steps[0].animation] : []);
    expect(h.drawn.filter((pose: { chapterId: string; timeSeconds: number }) => pose.chapterId === 'assemble' && pose.timeSeconds !== seconds)).toEqual([]);
    if (second === 'clip') expect(h.clock()).toMatchObject({ chapterId: 'arrive', timeSeconds: 0 });
    else expect(h.clock()).toBeUndefined();
    // Only the ground keeps that mask: the next chapter's own figure drops it,
    // so neither the chapter shown nor its saved scene hides the old copies.
    expect(h.workspace.capture().inspection.lessonFigureAnimation).toBeUndefined();
  } finally { h.cleanup(); }
});

it('goes back over a chapter whose clip is no longer live without drawing that clip', async () => {
  const h = setup(build);
  try {
    await h.player.select('build'); await h.player.start(false, 0);
    expect(h.clock()).toMatchObject({ chapterId: 'dimer', timeSeconds: 0 });
    h.run(4);
    // The wearer holds the molecule through the next two chapters, so their
    // saved scenes keep the content but not an authored pose.
    h.hold(true);
    await h.player.next(); h.run(4);
    await h.player.next(); h.run(2);
    expect(h.player.getState()).toMatchObject({ step: 2, active: true });
    expect(h.clock()).toMatchObject({ chapterId: 'neighbor' });
    // Let go, then Back: the held scene of the target is refused, so it is
    // painted over the chapter before it, whose clip is no longer live.
    h.hold(false);
    h.drawn.length = 0; h.masks.length = 0;
    await h.player.back();
    expect(h.player.getState()).toMatchObject({ step: 1, active: true });
    expect(h.masks).toEqual([build.steps[0].animation]);
    expect(h.drawn).toEqual([]);
    expect(h.clock()).toMatchObject({ chapterId: 'extend', timeSeconds: 0 });
    expect(h.workspace.capture().inspection.lessonFigureAnimation).toBeUndefined();
  } finally { h.cleanup(); }
});

it('still replays the clip from its start when the wearer goes back to its chapter', async () => {
  const h = setup(lesson('still'));
  try {
    await h.player.select('outgoing-still'); await h.player.start(false, 0);
    h.run(9);
    await h.player.next();
    h.player.notifyMutation(h.workspace.snapshot(), { agent: true });
    h.drawn.length = 0;
    await h.player.back();
    expect(h.player.getState()).toMatchObject({ step: 0, active: true });
    expect(h.clock()).toMatchObject({ chapterId: 'assemble', timeSeconds: 0 });
  } finally { h.cleanup(); }
});
