import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { chapterAuthorsFraming, mountTourPlayer, type Tour, type TourStep } from '../src/tour-player.js';
import { molecularLessonToTour } from '../src/molecular-lesson-tour.js';
// @ts-ignore Production player DOM boundary.
import { tourEndHarness } from '../../lab/browser-roundtrip/fixtures/tour-end-harness.mjs';
// @ts-ignore Production ownership and playback clocks.
import { createPlacementHold } from '../../lab/browser-roundtrip/wearer-placement.mjs';
// @ts-ignore Production playback clock.
import { createPlaybackClock } from '../../packages/motion/src/keyframes.mjs';

const animation = { version: 1 as const, durationSeconds: 20, playback: { autoplay: true, loop: true }, tracks: [] };
const tour: Tour = { id: 'closeup', title: 'Close-up', summary: '', presentation: { captionCard: 'shown', end: 'hold' }, steps: [
  { id: 'overview', title: 'Overview', view: 'fit', placement: { scale: 1 } },
  { id: 'ordinary', title: 'Ordinary', view: 'fit', placement: { scale: 1 } },
  { id: 'site', title: 'Site', view: 'focus', placement: { scale: 2.2 } },
  { id: 'continue', title: 'Continue', view: 'focus', placement: { scale: 2.2 } },
].map(step => ({ ...step, durationMs: 3000, animation } as TourStep)) };
function harness(xr: boolean, lesson = tour) {
  const h = tourEndHarness({ xr }), hold = createPlacementHold();
  let pose = { scale: 1, camera: 'start' }, clock: any, releases = 0, frames = 0;
  const animationFrames: any[] = [];
  const snapshot = h.workspace.snapshot;
  h.workspace.snapshot = () => ({ ...snapshot(), interactionActive: hold.holdsPlacement() });
  h.workspace.capture = () => structuredClone(pose);
  h.workspace.rows = () => [...'ABCDEFGHIJKL'].map(labelChain => ({ key: labelChain, entityType: 'polymer',
    identity: { labelChain, authorChain: labelChain, copyId: '1', modelNumber: 1, componentId: 'ALA' } }));
  const frame = async (camera: string) => { pose.camera = camera; frames++; };
  h.workspace.viewer.focus = () => frame('focus');
  h.workspace.viewer.focusSelection = () => frame('front');
  Object.assign(h.workspace.viewer.inspection, {
    supportsConcurrentPlayback: true, holdsWearerPlacement: hold.holdsPlacement,
    setVisibility: async () => {},
    visibilityChains: () => [...'ABCDEFGHIJKL'].map(labelChain => ({ labelChain, copyId: '1' })),
    beginChapterFraming: () => { releases++; hold.release('authored-chapter'); },
    place: async (patch: any) => { pose.scale = patch.scale; },
    fit: () => frame('fit'),
    setLessonFigure: async (figure: any, options: any) => { if (figure && options.frame) await frame(JSON.stringify(figure.focus ?? 'whole')); },
    restore: async (saved: any, options: any) => {
      if (!options.preservePlacement) pose.scale = saved.scale;
      if (!options.preserveCamera) pose.camera = saved.camera;
    },
    animationFramingContext: () => ({ previousScale: pose.scale }),
    setMolecularAnimation: async (value: any, _chapter: any, framing: any) => { if (value) animationFrames.push(framing); clock = value ? createPlaybackClock(value.durationSeconds, value.playback) : undefined; },
    controlMolecularAnimation: (patch: any) => clock?.patch(patch, Date.now()),
  });
  const player = mountTourPlayer({ ...h, tours: [lesson] });
  return { ...h, player, hold, animationFrames, pose: () => structuredClone(pose), releases: () => releases, frames: () => frames,
    move: () => { hold.takeover('pointer'); pose = { scale: 3, camera: 'manual' }; },
    tick: () => clock?.sample(Date.now()), clock: () => clock?.snapshot(),
    // A peer saves a playing animated chapter together with its clock.
    peer: (chapterId: string, intent: { entry?: 'start' } = {}) => player.restorePlayback({ sourceSha256: 'same', inspection: { animation: { playback: { chapterId } }, lessonPlayback: {
      tourId: lesson.id, chapterId, stopped: false, ...intent, startingScene: { sourceSha256: 'same', inspection: {} },
    } } }, { frame: true }),
  };
}

for (const xr of [false, true]) {
  it(`held ordinary → close-up → new hold → cached Back, autoplay and motion (XR=${xr})`, async () => {
    vi.useFakeTimers(); const h = harness(xr);
    try {
      await h.player.select(tour.id); await h.player.start(true, 0);
      h.move(); const manual = h.pose();
      h.tick(); await vi.advanceTimersByTimeAsync(1000); h.tick();
      expect(h.clock()).toMatchObject({ state: 'playing', timeSeconds: 1 });
      await vi.advanceTimersByTimeAsync(2001);
      expect(h.player.getState()).toMatchObject({ step: 1, autoplay: true });
      expect(h.pose()).toEqual(manual); expect(h.releases()).toBe(0);
      await vi.advanceTimersByTimeAsync(3001);
      expect(h.player.getState()).toMatchObject({ step: 2, autoplay: true, stopped: false });
      expect(h.pose()).toEqual({ scale: 2.2, camera: xr ? 'front' : 'focus' });
      expect(h.releases()).toBe(1); expect(h.hold.holdsPlacement()).toBe(false);
      h.move(); await h.player.next(); expect(h.pose()).toEqual(manual);
      await h.player.back(); expect(h.releases()).toBe(2);
      expect(h.pose()).toEqual({ scale: 2.2, camera: xr ? 'front' : 'focus' });
      h.tick(); await vi.advanceTimersByTimeAsync(100); h.tick();
      expect(h.clock().timeSeconds).toBeGreaterThan(0);
      expect(h.player.getState().autoplay).toBe(true);
    } finally { h.player.pause(); h.cleanup(); vi.useRealTimers(); }
  });
  it(`peer entry takes over once, repeated peer receipt preserves new input (XR=${xr})`, async () => {
    const h = harness(xr);
    try {
      await h.player.select(tour.id); await h.player.start(false, 0); h.move();
      await h.peer('ordinary'); expect(h.pose().camera).toBe('manual');
      await h.peer('site'); expect(h.pose().scale).toBe(2.2); expect(h.releases()).toBe(1);
      h.move(); const frames = h.frames(); await h.peer('site');
      expect(h.pose().camera).toBe('manual'); expect(h.frames()).toBe(frames);
      await h.peer('continue'); expect(h.pose().camera).toBe('manual');
      await h.peer('site'); expect(h.releases()).toBe(2); expect(h.pose().scale).toBe(2.2);
    } finally { h.player.pause(); h.cleanup(); }
  });
  it(`hemoglobin small orbit survives through compare, then heme reframes (XR=${xr})`, async () => {
    const lesson = molecularLessonToTour(JSON.parse(readFileSync(new URL('../demos/hemoglobin-switch/flipbook.json', import.meta.url), 'utf8')));
    expect(lesson.steps.filter((_, i) => chapterAuthorsFraming(lesson, i, { xr })).map(s => s.id)).toEqual(xr ? ['heme'] : ['t-state', 'heme']);
    const h = harness(xr, lesson);
    try {
      await h.player.select(lesson.id); await h.player.start(false, 0); h.move();
      for (let i = 1; i < 4; i++) { await h.player.next(); expect(h.pose().camera).toBe('manual'); }
      await h.player.next();
      expect(h.releases()).toBe(1); expect(h.pose().camera).toBe(JSON.stringify(lesson.steps[4].figure!.focus));
      h.move(); await h.player.back(); expect(h.pose().camera).toBe('manual');
      await h.player.next(); expect(h.releases()).toBe(2);
    } finally { h.player.pause(); h.cleanup(); }
  });
}

for (const xr of [false, true]) {
  it(`the wearer moves, then starts: an authored opening placement does not take over (XR=${xr})`, async () => {
    const h = harness(xr);
    try {
      await h.player.select(tour.id); h.move(); const manual = h.pose();
      await h.player.start(false, 0);
      expect(h.player.getState()).toMatchObject({ step: 0, active: true });
      expect(h.releases()).toBe(0); expect(h.hold.holdsPlacement()).toBe(true);
      expect(h.pose()).toEqual(manual);
      // Restart keeps it too; only the later authored close-up takes over.
      await h.player.next(); await h.player.start(false, 0);
      expect(h.releases()).toBe(0); expect(h.pose()).toEqual(manual);
      await h.player.next(); await h.player.next();
      expect(h.releases()).toBe(1); expect(h.pose().scale).toBe(2.2);
    } finally { h.player.pause(); h.cleanup(); }
  });
  it(`a peer's lesson start keeps this panel's held placement (XR=${xr})`, async () => {
    const h = harness(xr);
    try {
      h.move(); const manual = h.pose();
      await h.peer('site');
      expect(h.releases()).toBe(0); expect(h.pose()).toEqual(manual);
    } finally { h.player.pause(); h.cleanup(); }
  });
}

// A lesson that opens on a close-up, then widens.
const opensClose: Tour = { ...tour, id: 'opens-close', steps: [
  { id: 'site', title: 'Site', view: 'focus', placement: { scale: 2.2 } },
  { id: 'wide', title: 'Wide', view: 'fit', placement: { scale: 1 } },
  { id: 'wider', title: 'Wider', view: 'fit', placement: { scale: 1 } },
].map(step => ({ ...step, durationMs: 3000, animation } as TourStep)) };
it('a peer restart at an opening close-up keeps a placement held on a later chapter', async () => {
  const h = harness(true, opensClose), published: any[] = [];
  h.workspace.viewer.inspection.setLessonPlayback = (playback: any) => published.push(playback && structuredClone(playback));
  try {
    // This panel publishes its own start, and drops the intent at Next.
    await h.player.select(opensClose.id); await h.player.start(false, 0);
    expect(published.at(-1)).toMatchObject({ chapterId: 'site', entry: 'start' });
    await h.player.next(); h.move(); const manual = h.pose();
    expect(published.at(-1).chapterId).toBe('wide'); expect(published.at(-1).entry).toBeUndefined();
    await h.peer('site', { entry: 'start' });
    expect(h.releases()).toBe(0); expect(h.hold.holdsPlacement()).toBe(true); expect(h.pose()).toEqual(manual);
    expect(published.at(-1)).toMatchObject({ chapterId: 'site', entry: 'start' });
    // A peer's step back into the same close-up still takes over.
    await h.peer('wide'); await h.peer('site');
    expect(h.releases()).toBe(1); expect(h.pose().scale).toBe(2.2);
  } finally { h.player.pause(); h.cleanup(); }
});

it('the desktop keeps its close-up rule: a turn or small resize still applies', async () => {
  const lesson: Tour = { ...tour, id: 'orbit', steps: [
    { id: 'reveal', title: 'Reveal', placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } },
    { id: 'orbit', title: 'Orbit', placement: { translation: [0, 0, 0], rotation: [0, 140, 0], scale: 1.1 } },
  ].map(step => ({ ...step, durationMs: 3000, animation } as TourStep)) };
  expect(lesson.steps.map((_, i) => chapterAuthorsFraming(lesson, i, { xr: false }))).toEqual([true, true]);
  for (const xr of [false, true]) {
    const h = harness(xr, lesson);
    try {
      await h.player.select(lesson.id); await h.player.start(false, 0); h.move(); const manual = h.pose();
      await h.player.next();
      if (xr) { expect(h.releases()).toBe(0); expect(h.pose()).toEqual(manual); }
      else { expect(h.releases()).toBe(1); expect(h.pose().scale).toBe(1.1); }
    } finally { h.player.pause(); h.cleanup(); }
  }
});

it('an exact 1.5x enlargement is a close-up despite floating point', () => {
  const steps: TourStep[] = [
    { id: 'reveal', title: 'Reveal', placement: { scale: 1.1 } },
    { id: 'near', title: 'Near', placement: { scale: 1.65 } },
    { id: 'short', title: 'Short', placement: { scale: 2.47 } },
  ];
  expect(1.5 * 1.1).toBeGreaterThan(1.65);
  expect(steps.map((_, i) => chapterAuthorsFraming({ ...tour, steps }, i))).toEqual([false, true, false]);
});

it.each(['kinesin-walk', 'hemoglobin-switch', 'atp-synthase-rotor'])('%s motion has no close-up, so a start after the wearer moves releases nothing', async demo => {
  const text = readFileSync(new URL(`../demos/${demo}/motion.json`, import.meta.url), 'utf8');
  const lesson = molecularLessonToTour(JSON.parse(text));
  expect(lesson.steps.filter((_, i) => chapterAuthorsFraming(lesson, i))).toEqual([]);
  const h = harness(true, lesson);
  // The lesson's own chains, so its visibility resolves as on the real source.
  const named = [...text.matchAll(/"chain"\s*:\s*"([^"]+)"/g)].map(match => match[1]);
  const listed = JSON.parse(text).chapters.flatMap((chapter: any) => chapter.immersive?.visibility?.chains ?? []);
  // Visibility entries may name an exact copy; preserve that identity instead
  // of passing the whole object as a labelChain to the production resolver.
  const chains = [...new Map([...'ABCDEFGHIJKL', ...named, ...listed].map(value => {
    const chain = typeof value === 'string' ? { labelChain: value, copyId: '1' } : value;
    return [chain.labelChain, chain];
  })).values()];
  h.workspace.rows = () => chains.map(chain => ({ key: chain.labelChain, entityType: 'polymer',
    identity: { ...chain, authorChain: chain.labelChain, modelNumber: 1, componentId: 'ALA' } }));
  h.workspace.viewer.inspection.visibilityChains = () => chains;
  try {
    await h.player.select(lesson.id); h.move(); const manual = h.pose();
    await h.player.start(false, 0, { narration: false });
    for (let i = 1; i < lesson.steps.length; i++) await h.player.next();
    expect(h.releases()).toBe(0); expect(h.hold.holdsPlacement()).toBe(true);
    expect(h.pose()).toEqual(manual);
  } finally { h.player.pause(); h.cleanup(); }
});

it('only an authored placement, focus view, figure focus or targeted framing is a close-up', () => {
  const part = { id: 'site', label: 'Site', color: '#ffffff', chain: 'A', residues: { from: 2, to: 4 } };
  const steps: TourStep[] = [
    { id: 'whole-figure', title: 'Whole figure', figure: { layers: [] } as any },
    { id: 'fit', title: 'Fit', view: 'fit' },
    { id: 'whole-framing', title: 'Whole framing', emphasis: { parts: [part], framing: 'fill' } },
    { id: 'figure-focus', title: 'Figure focus', figure: { layers: [], focus: [{ chain: 'A' }] } as any },
    { id: 'targeted', title: 'Targeted', emphasis: { parts: [part], focus: 'site', framing: 'fill' } },
    { id: 'focus', title: 'Focus', view: 'focus', selection: { chain: 'A' } },
    { id: 'fit-again', title: 'Fit again', view: 'fit' },
  ];
  expect(steps.map((_, i) => chapterAuthorsFraming({ ...tour, steps }, i)))
    .toEqual([false, false, false, true, true, true, false]);
});

it('a turn or a small resize is no close-up; a new seat or a marked enlargement is', () => {
  const steps: TourStep[] = [
    { id: 'reveal', title: 'Reveal', placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } },
    { id: 'orbit', title: 'Orbit', placement: { translation: [0, 0, 0], rotation: [0, 140, 0], scale: 1.1 } },
    { id: 'site', title: 'Site', placement: { translation: [0, 0, 0], rotation: [0, 250, 0], scale: 2.4 } },
    { id: 'wide', title: 'Wide', placement: { translation: [0, 0, 0], rotation: [0, 360, 0], scale: 1 } },
    { id: 'aside', title: 'Aside', placement: { translation: [1, 0, 0] } },
  ];
  expect(steps.map((_, i) => chapterAuthorsFraming({ ...tour, steps }, i))).toEqual([false, false, true, false, true]);
});

it('templated scenes keep the wearer\'s placement through their turns', () => {
  for (const [name, closeUps] of [['telomerase-haca', ['site']], ['hemoglobin', ['site', 'pocket']], ['spike', ['site']],
    ['nucleosome', ['site']], ['daraxonrasib', ['interface']]] as const) {
    const lesson = molecularLessonToTour(JSON.parse(readFileSync(new URL(`../demos/${name}.json`, import.meta.url), 'utf8')));
    expect(lesson.steps.filter((_, i) => chapterAuthorsFraming(lesson, i)).map(step => step.id), name).toEqual(closeUps);
  }
});

it('framing identity ignores decoration and inherited placement, but resolves changed targets', () => {
  const part = { id: 'site', label: 'Site', color: '#ffffff', chain: 'A', residues: { from: 2, to: 4 } };
  const entry: TourStep = { id: 'a', title: 'A', placement: { rotation: [0, 0, 0], scale: 2 }, emphasis: { parts: [part], focus: 'site', framing: 'fill' } };
  const repeated = { ...entry, id: 'b', placement: { scale: 2 }, emphasis: { ...entry.emphasis!, parts: [{ ...part, label: 'Changed', color: '#000000' }] } };
  const steps = [entry, repeated, { ...repeated, id: 'c', emphasis: { ...repeated.emphasis, parts: [{ ...part, residues: { from: 5, to: 9 } }] } },
    { id: 'd', title: 'D', selection: { chain: 'A' }, emphasis: { parts: [part], focus: 'site' } }];
  expect(steps.map((_, i) => chapterAuthorsFraming({ ...tour, steps }, i))).toEqual([true, false, true, false]);
});

it('new input during close-up construction wins over the remaining framing', async () => {
  const h = harness(false);
  try {
    await h.player.select(tour.id); await h.player.start(false, 0); h.move();
    await h.player.next();
    h.workspace.viewer.inspection.place = async () => { h.move(); };
    await h.player.next();
    expect(h.releases()).toBe(1); expect(h.hold.holdsPlacement()).toBe(true);
    expect(h.pose()).toEqual({ scale: 3, camera: 'manual' });
    await h.player.next(); expect(h.releases()).toBe(1);
    expect(h.pose()).toEqual({ scale: 3, camera: 'manual' });
  } finally { h.player.pause(); h.cleanup(); }
});

it('untouched desktop still applies repeated authored views on every chapter', async () => {
  const h = harness(false);
  try {
    await h.player.select(tour.id); await h.player.start(false, 0);
    for (let i = 1; i < tour.steps.length; i++) await h.player.next();
    expect(h.frames()).toBe(4); expect(h.releases()).toBe(0);
    expect(h.pose()).toEqual({ scale: 2.2, camera: 'focus' });
  } finally { h.player.pause(); h.cleanup(); }
});

it('animation gets the outgoing scale before chapter paint and preserves explicit framing', async () => {
  const h = harness(true);
  try {
    await h.player.select(tour.id); await h.player.start(false, 0);
    expect(h.animationFrames.at(-1)).toMatchObject({ context: { previousScale: 1 }, frame: false, framing: undefined });
    h.move(); await h.player.next();
    expect(h.animationFrames.at(-1)).toMatchObject({ context: { previousScale: 3 }, frame: false, framing: undefined });
    await h.player.next();
    expect(h.animationFrames.at(-1)).toMatchObject({ context: { previousScale: 3 }, frame: false, framing: undefined });
    expect(h.pose().scale).toBe(2.2);
  } finally { h.player.pause(); h.cleanup(); }
});

it('hemoglobin starts its first animated chapter with the existing visible-scene scale', async () => {
  const lesson = molecularLessonToTour(JSON.parse(readFileSync(new URL('../demos/hemoglobin-switch/motion.json', import.meta.url), 'utf8')));
  const h = harness(true, lesson);
  try {
    await h.workspace.viewer.inspection.place({ scale: 2.022824 });
    await h.player.select(lesson.id); await h.player.start(false, 0, { narration: false });
    expect(h.animationFrames.at(-1)).toMatchObject({ context: { previousScale: 2.022824 }, frame: true, framing: undefined });
  } finally { h.player.pause(); h.cleanup(); }
});
