import { describe, expect, it, vi } from 'vitest';
import { mountTourPlayer, savedLessonPlayback, tourAnimationInstallTimeoutMs, tourOperationTimeoutMs, tourSceneTimeoutMs,
  type Tour } from '../src/tour-player.js';
// @ts-ignore Real player DOM boundary and diagnostics; no browser or device.
import { tourEndHarness } from '../../lab/browser-roundtrip/fixtures/tour-end-harness.mjs';

// A chapter is drawn whole or not at all: the figure, the colours and the
// running animation land together, or the scene the chapter found comes back.

const animation = { version: 1, durationSeconds: 4, playback: { autoplay: true, loop: true }, tracks: [] } as any;
const figure = { layers: [], labels: [], distances: [] } as any;
const lesson: Tour = { id: 'atomic-start', title: 'Atomic start', summary: '', steps: [
  { id: 'walk', title: 'Walk', durationMs: 60_000, appearance: { background: '#101010' }, figure, animation },
  { id: 'stroke', title: 'Stroke', durationMs: 60_000, appearance: { background: '#202020' }, figure, animation },
  { id: 'still', title: 'Still', durationMs: 60_000, appearance: { background: '#303030' } },
] };
/** How the failing chapter's clock install goes. `gated` waits for `release()`. */
type Install = 'ok' | 'throws' | 'slow' | 'hung' | 'gated';
type Clock = { chapterId: string; state: 'playing' | 'paused' };

/**
 * A viewer whose capture holds what a wearer sees of a lesson chapter.
 *
 * Like the real one it is not ready while a clock builds, and it refuses a
 * restore with `viewer_busy` until the build lets go. An atomic chapter draws
 * its figure first and its clock after, so a failure between them leaves the
 * figure standing still unless the player puts the found scene back.
 *
 * `held` is a follow-up, such as a menu clearance, that takes the viewer for
 * `ms` just as the chapter with that background asks for its appearance.
 * While it holds, every chapter operation is refused before it changes anything.
 *
 * `clearance` is the move the chapter's own menu draw asks for as its clock
 * lands: it takes the viewer for `ms` the moment that chapter's install
 * returns, and the viewer's capture refuses while it holds, as the real one does.
 */
function stage({ atomic, install = 'ok', failing = 'walk', held, clearance, replayMs = 0, tour = lesson }: { atomic: boolean; install?: Install; failing?: string;
  tour?: Tour; replayMs?: number; held?: { background: string; ms: number }; clearance?: { chapterId: string; ms: number } }) {
  const h = tourEndHarness({ xr: false });
  let busy = false, failRestore = false, release = () => {}, entered = () => {};
  let hold = held, following = false, refusals = 0, clearing = clearance;
  const refuse = () => {
    if (!following) return;
    refusals++;
    throw Object.assign(Error('A molecular change is still rendering.'), { code: 'viewer_busy' });
  };
  let appearance: Record<string, unknown> = { background: '#000000' }, emphasis: unknown, lessonFigure: unknown;
  let clock: Clock | undefined, lessonPlayback: any;
  const installing = new Promise<void>(resolve => { entered = resolve; });
  const installs: string[] = [], cursors: any[] = [];
  const capture = () => structuredClone({ sourceSha256: 'same', modelNumber: 1, assemblyId: '', camera: {}, inspection: {
    appearance, ...(emphasis ? { emphasis } : {}), ...(lessonFigure ? { lessonFigure } : {}),
    ...(clock ? { animation: { playback: clock } } : {}), ...(lessonPlayback ? { lessonPlayback } : {}) } }) as any;
  const build = async (chapterId: string) => {
    installs.push(chapterId);
    if (clearing?.chapterId === chapterId) {
      const { ms } = clearing; clearing = undefined;
      following = true; setTimeout(() => { following = false; }, ms);
    }
    if (chapterId !== failing || install === 'ok') { clock = { chapterId, state: 'playing' }; return; }
    busy = true; entered();
    try {
      if (install === 'throws') throw Error('The animation bodies could not be built.');
      if (install === 'hung') await new Promise(() => {});
      if (install === 'slow') await new Promise(resolve => setTimeout(resolve, 30_000));
      if (install === 'gated') await new Promise<void>(resolve => { release = resolve; });
      clock = { chapterId, state: 'playing' };
    } finally { busy = false; }
  };
  const workspace = { ...h.workspace,
    capture: () => {
      if (clearance && following) throw Object.assign(Error('A molecular change is still rendering.'), { code: 'viewer_busy' });
      return capture();
    },
    snapshot: () => ({ ready: !busy && !following, status: 'ready', sourceSha256: 'same', xrPresenting: false, interactionActive: false, inspection: { appearance } }),
    runTour: (() => {
      let queue: Promise<unknown> = Promise.resolve();
      return (action: () => Promise<unknown>) => { const work = queue.then(action); queue = work.catch(() => {}); return work; };
    })(),
    viewer: { ...h.workspace.viewer, inspection: { ...h.workspace.viewer.inspection,
      configure: async (patch: Record<string, unknown>) => {
        if (hold && patch.background === hold.background) {
          following = true; setTimeout(() => { following = false; }, hold.ms); hold = undefined;
        }
        refuse();
        if (replayMs) await new Promise(resolve => setTimeout(resolve, replayMs));
        appearance = { ...appearance, ...patch };
      },
      emphasize: async (value: unknown) => { refuse(); emphasis = structuredClone(value); },
      clearLessonEmphasis: async () => { refuse(); emphasis = undefined; },
      setLessonFigure: async (value: unknown) => { refuse(); lessonFigure = value ? structuredClone(value) : undefined; },
      setMolecularAnimation: async (value: unknown, chapterId: string) => { refuse(); clock = undefined; if (value) await build(chapterId); },
      ...(atomic ? { setAnimatedChapter: async (_value: unknown, chapterId: string, value: unknown) => {
        refuse(); clock = undefined; lessonFigure = value ? structuredClone(value) : undefined; await build(chapterId);
      } } : {}),
      controlMolecularAnimation: ({ state }: { state?: 'play' | 'pause' }) => { if (clock && state) clock.state = state === 'play' ? 'playing' : 'paused'; },
      setLessonPlayback: (value: unknown) => { lessonPlayback = value ? structuredClone(value) : undefined; cursors.push(lessonPlayback); },
      restore: async (scene: any) => {
        if (busy) throw Object.assign(Error('A molecular change is still rendering.'), { code: 'viewer_busy' });
        refuse();
        if (failRestore) { failRestore = false; throw Error('The starting view could not be drawn.'); }
        ({ appearance, emphasis, lessonFigure, lessonPlayback } = structuredClone(scene.inspection));
        clock = scene.inspection.animation ? structuredClone(scene.inspection.animation.playback) : undefined;
      },
    } } };
  const player = mountTourPlayer({ workspace: workspace as any, tours: [tour], after: h.after, aside: () => {} });
  return { player, capture, installs, cursors, installing, release: () => release(), failNextRestore: () => { failRestore = true; },
    queue: (action: () => Promise<unknown>) => workspace.runTour(action),
    outcomes: () => h.records.all().map((record: any) => record.detail?.outcome).filter(Boolean),
    records: (kind: string): any[] => h.records.all().filter((record: any) => record.kind === kind).map((record: any) => record.detail),
    refusals: () => refusals,
    close: () => { player.pause(); h.cleanup(); vi.useRealTimers(); } };
}
/** The rejection itself, or a failure if the promise resolved. */
const rejection = (pending: Promise<unknown>) => pending.then(() => { throw Error('The chapter resolved.'); }, (error: any) => error);
/** The scene with its clock's play state set aside: a paused clock is the same chapter. */
const settled = (scene: any) => ({ ...scene.inspection, animation: scene.inspection.animation && { playback: { ...scene.inspection.animation.playback, state: 'any' } } });

it('bounds an install by the per-operation rule and gives the scene room to put back what it found', () => {
  // Quest 2 installs took at most 2.4 s; 32,916-site kinesin gets 40 s.
  expect(tourAnimationInstallTimeoutMs(32_916)).toBe(40_000);
  expect(tourAnimationInstallTimeoutMs(0)).toBe(tourOperationTimeoutMs(0));
  // The failed operation, the wait for its abandoned work, and the restore.
  expect(tourSceneTimeoutMs(32_916)).toBe(120_000);
  for (const atoms of [0, 13_000, 32_916, 34_413, 100_000])
    expect(tourSceneTimeoutMs(atoms)).toBeGreaterThanOrEqual(3 * tourOperationTimeoutMs(atoms));
});

for (const atomic of [true, false]) describe(atomic ? 'a chapter that installs figure and clock together' : 'a chapter that draws its figure before its clock', () => {
  it('a healthy start resolves with the chapter, its figure and its running animation drawn', async () => {
    const s = stage({ atomic });
    try {
      await s.player.select(lesson.id);
      await s.player.start(false, 0, { narration: false });
      const scene = s.capture();
      expect(scene.inspection).toMatchObject({ appearance: { background: '#101010' }, lessonFigure: figure,
        animation: { playback: { chapterId: 'walk', state: 'playing' } },
        lessonPlayback: { tourId: lesson.id, chapterId: 'walk', stopped: false } });
      expect(savedLessonPlayback(scene, [lesson])).toMatchObject({ chapterId: 'walk', stopped: false });
      expect(s.player.getState()).toMatchObject({ active: true, stopped: false, step: 0, navigating: false });
      expect(s.installs).toEqual(['walk']);
      expect(s.outcomes()).not.toContain('rolled-back');
      // What the chapter left, for a page that has to tell a wearer's later edit from it.
      expect(s.player.drawnScene?.()).toMatchObject({ serial: 1,
        scene: { inspection: { appearance: { background: '#101010' }, lessonFigure: figure } } });
    } finally { s.close(); }
  });

  it.each(['throws', 'gated', 'slow'] as const)('a start whose animation install fails (%s) puts back the scene it found and ends stopped', async install => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const s = stage({ atomic, install });
    try {
      await s.player.select(lesson.id);
      const found = s.capture();
      const failed = rejection(s.player.start(false, 0, { narration: false }));
      await s.installing;
      // Drawing began: the figure is up, the clock is not, and no cursor claims it.
      expect(s.capture().inspection.lessonFigure).toEqual(figure);
      expect(s.capture().inspection.animation).toBeUndefined();
      // Pause withdraws the start while its clock builds; the build then lands.
      if (install === 'gated') { s.player.pause(); s.release(); }
      await vi.advanceTimersByTimeAsync(31_000);
      const error = await failed;
      expect(error.message).toBe({
        throws: 'The animation bodies could not be built.',
        gated: 'The tour scene was interrupted while installing molecular animation.',
        slow: "This lesson scene's molecular animation did not finish within 20 seconds.",
      }[install]);
      expect(error.rollback).toBe('restored');
      expect(s.capture()).toEqual(found);
      expect(s.player.getState()).toMatchObject({ active: false, stopped: true, step: -1, navigating: false, autoplay: false });
      expect(s.player.getState().feedback).toBe(`Tour could not start: ${error.message}`);
      expect(s.cursors.every(cursor => cursor === undefined)).toBe(true);
      expect(s.outcomes()).toContain('rolled-back');
      // A late clock cannot paint the chapter back over the found scene.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(s.capture()).toEqual(found);
    } finally { s.close(); }
  });

  it('a hung install still answers stopped, naming the molecular animation, while it keeps the workspace', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const s = stage({ atomic, install: 'hung' });
    try {
      await s.player.select(lesson.id);
      const failed = rejection(s.player.start(false, 0, { narration: false }));
      await s.installing;
      // The install bound, then one more for the abandoned work to settle.
      await vi.advanceTimersByTimeAsync(41_000);
      const error = await failed;
      expect(error.message).toBe("This lesson scene's molecular animation did not finish within 20 seconds.");
      expect(error.rollback).toBe('pending');
      expect(s.player.getState()).toMatchObject({ active: false, stopped: true, step: -1, navigating: false, autoplay: false });
      expect(s.capture().inspection.lessonPlayback).toBeUndefined();
      expect(s.outcomes()).toContain('rollback-pending');
    } finally { s.close(); }
  });

  it('a start whose install lands after the rollback bound gives its caller the failure, then puts the found scene back before anything else draws', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const s = stage({ atomic, install: 'gated' });
    try {
      await s.player.select(lesson.id);
      const found = s.capture();
      const failed = rejection(s.player.start(false, 0, { narration: false }));
      await s.installing;
      await vi.advanceTimersByTimeAsync(41_000);
      const error = await failed;
      expect(error.message).toBe("This lesson scene's molecular animation did not finish within 20 seconds.");
      expect(error.rollback).toBe('pending');
      expect(s.player.getState()).toMatchObject({ active: false, stopped: true, step: -1, navigating: false });
      // Work queued behind the failed start waits for the held workspace.
      let queuedSaw: any;
      const queued = s.queue(async () => { queuedSaw = s.capture(); });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(queuedSaw).toBeUndefined();
      // The late clock lands, and the found scene comes back over it first.
      s.release();
      await vi.advanceTimersByTimeAsync(1_000); await queued;
      expect(s.records('tour')).toContainEqual(expect.objectContaining({ action: 'scene', outcome: 'rolled-back', late: true }));
      expect(queuedSaw).toEqual(found);
      expect(s.capture()).toEqual(found);
      expect(s.player.getState()).toMatchObject({ active: false, stopped: true, step: -1 });
    } finally { s.close(); }
  });

  it('a lesson install whose clock lands after the rollback bound keeps its failure and puts the found scene back', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const s = stage({ atomic, install: 'gated' });
    try {
      const found = s.capture();
      const failed = rejection(s.player.installLesson(lesson, { chapterId: 'walk', narration: false }));
      await s.installing;
      await vi.advanceTimersByTimeAsync(41_000);
      const error = await failed;
      // Not the busy viewer's refusal of a restore it was sent too early.
      expect(error.message).toBe("This lesson scene's molecular animation did not finish within 20 seconds.");
      expect(error.rollback).toBe('pending');
      expect(s.player.getState()).toMatchObject({ active: false, navigating: false });
      s.release();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(error.rollback).toBe('restored');
      expect(s.capture()).toEqual(found);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(s.capture()).toEqual(found);
    } finally { s.close(); }
  });

  it('a Next whose install fails stays on the previous chapter, whole and paused', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const s = stage({ atomic, install: 'throws', failing: 'stroke' });
    try {
      await s.player.select(lesson.id);
      await s.player.start(true, 0, { narration: false });
      const whole = s.capture();
      const failed = rejection(s.player.next());
      await vi.advanceTimersByTimeAsync(1_000);
      const error = await failed;
      expect(error.message).toBe('The animation bodies could not be built.');
      expect(error.rollback).toBe('restored');
      expect(s.player.getState()).toMatchObject({ active: true, stopped: false, step: 0, autoplay: false, navigating: false });
      const scene = s.capture();
      expect(scene.inspection.animation.playback).toEqual({ chapterId: 'walk', state: 'paused' });
      expect(settled(scene)).toEqual(settled(whole));
      expect(savedLessonPlayback(scene, [lesson])).toMatchObject({ chapterId: 'walk', stopped: false });
      // Every cursor published while Stroke drew said stopped; the last plays Walk again.
      const hold = s.cursors.findIndex(cursor => cursor?.chapterId === 'walk' && cursor.stopped);
      expect(hold).toBeGreaterThanOrEqual(0);
      const drawing = s.cursors.slice(hold);
      expect(drawing.slice(0, -1).every(cursor => cursor?.chapterId === 'walk' && cursor.stopped)).toBe(true);
      expect(drawing.at(-1)).toMatchObject({ chapterId: 'walk', stopped: false });
      expect(s.player.getState().canNext).toBe(true);
    } finally { s.close(); }
  });

  it('an autoplay advance the viewer refuses busy once runs the refused operation again and shows the chapter', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    // A menu clearance holds the viewer for 300 ms just as Stroke asks for its appearance.
    const s = stage({ atomic, held: { background: '#202020', ms: 300 } });
    try {
      await s.player.select(lesson.id);
      await s.player.start(true, 0, { narration: false });
      // Walk's 60 s dwell, then the advance and the wait for the viewer.
      await vi.advanceTimersByTimeAsync(61_000);
      expect(s.refusals()).toBe(1);
      expect(s.records('tour-retry')).toEqual([expect.objectContaining({ phase: 'appearance', reason: 'viewer_busy' })]);
      expect(s.player.getState()).toMatchObject({ active: true, stopped: false, step: 1, autoplay: true, navigating: false });
      expect(s.capture().inspection).toMatchObject({ appearance: { background: '#202020' }, lessonFigure: figure,
        animation: { playback: { chapterId: 'stroke', state: 'playing' } },
        lessonPlayback: { tourId: lesson.id, chapterId: 'stroke', stopped: false } });
      expect(s.outcomes()).not.toContain('rolled-back');
      expect(s.records('tour').filter(detail => detail.outcome === 'error')).toEqual([]);
    } finally { s.close(); }
  });

  it('an autoplay advance the viewer refuses past its bound fails, puts Walk back whole and pauses', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    // Held 25 s against the 20 s operation bound; the rollback waits out the rest.
    const s = stage({ atomic, held: { background: '#202020', ms: 25_000 } });
    try {
      await s.player.select(lesson.id);
      await s.player.start(true, 0, { narration: false });
      const whole = s.capture();
      await vi.advanceTimersByTimeAsync(60_000 + 30_000);
      expect(s.refusals()).toBe(1);
      expect(s.records('tour-retry')).toEqual([]);
      expect(s.records('tour').filter(detail => detail.outcome === 'error')).toEqual([expect.objectContaining({
        action: 'scene', target: 1, error: 'A molecular change is still rendering.', rollback: 'restored' })]);
      expect(s.outcomes()).toContain('rolled-back');
      expect(s.player.getState()).toMatchObject({ active: true, stopped: false, step: 0, autoplay: false, navigating: false });
      const scene = s.capture();
      expect(scene.inspection.animation.playback).toEqual({ chapterId: 'walk', state: 'paused' });
      expect(settled(scene)).toEqual(settled(whole));
      expect(savedLessonPlayback(scene, [lesson])).toMatchObject({ chapterId: 'walk', stopped: false });
    } finally { s.close(); }
  });

  it('a start whose own menu clearance still holds the viewer as its clock lands shows the chapter, running', async () => {
    const s = stage({ atomic, clearance: { chapterId: 'walk', ms: 300 } });
    try {
      await s.player.select(lesson.id);
      await s.player.start(false, 0, { narration: false });
      expect(s.outcomes()).not.toContain('rolled-back');
      expect(s.records('tour').filter(detail => detail.outcome === 'error')).toEqual([]);
      expect(s.player.getState()).toMatchObject({ active: true, stopped: false, step: 0, navigating: false });
      expect(s.capture().inspection).toMatchObject({ appearance: { background: '#101010' }, lessonFigure: figure,
        animation: { playback: { chapterId: 'walk', state: 'playing' } },
        lessonPlayback: { tourId: lesson.id, chapterId: 'walk', stopped: false } });
      expect(s.installs).toEqual(['walk']);
    } finally { s.close(); }
  });

  it('gives final clearance its wait after slow uncached chapter replay', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const tour = { ...lesson, steps: [...lesson.steps.slice(0, 2), { ...lesson.steps[2], animation }] };
    const s = stage({ atomic, tour, replayMs: 11_000, clearance: { chapterId: 'still', ms: 300 } });
    try {
      await s.player.select(lesson.id);
      let error: unknown;
      const started = s.player.start(false, 2, { narration: false }).catch(reason => { error = reason; });
      await vi.advanceTimersByTimeAsync(34_000);
      await started;
      expect(error).toBeUndefined();
      expect(s.outcomes()).not.toContain('rolled-back');
      expect(s.player.getState()).toMatchObject({ active: true, stopped: false, step: 2 });
      expect(s.capture().inspection.animation.playback).toMatchObject({ chapterId: 'still', state: 'playing' });
    } finally { s.close(); }
  });

  it('a Next whose own menu clearance holds the viewer as its clock lands moves on, running', async () => {
    const s = stage({ atomic, clearance: { chapterId: 'stroke', ms: 300 } });
    try {
      await s.player.select(lesson.id);
      await s.player.start(false, 0, { narration: false });
      await s.player.next();
      expect(s.outcomes()).not.toContain('rolled-back');
      expect(s.player.getState()).toMatchObject({ active: true, stopped: false, step: 1, navigating: false });
      expect(s.capture().inspection).toMatchObject({ appearance: { background: '#202020' },
        animation: { playback: { chapterId: 'stroke', state: 'playing' } } });
    } finally { s.close(); }
  });

  it('a start held past its bound by a clearance that never lets go still puts back the scene it found', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const s = stage({ atomic, clearance: { chapterId: 'walk', ms: 25_000 } });
    try {
      await s.player.select(lesson.id);
      const found = s.capture();
      const failed = rejection(s.player.start(false, 0, { narration: false }));
      await vi.advanceTimersByTimeAsync(90_000);
      await failed;
      expect(s.outcomes()).toContain('rolled-back');
      expect(s.player.getState()).toMatchObject({ active: false, stopped: true, step: -1, navigating: false });
      expect(settled(s.capture())).toEqual(settled(found));
    } finally { s.close(); }
  });

  it('a capture taken while the next chapter draws is accepted stopped and refused playing', async () => {
    const s = stage({ atomic, install: 'gated', failing: 'stroke' });
    try {
      await s.player.select(lesson.id);
      await s.player.start(false, 0, { narration: false });
      const next = s.player.next();
      await s.installing;
      const mid = s.capture();
      expect(mid.inspection.lessonPlayback).toMatchObject({ chapterId: 'walk', stopped: true });
      expect(mid.inspection.animation).toBeUndefined();
      expect(savedLessonPlayback(mid, [lesson])).toMatchObject({ chapterId: 'walk', stopped: true });
      mid.inspection.lessonPlayback.stopped = false;
      expect(() => savedLessonPlayback(mid, [lesson])).toThrow('The saved lesson is playing "Walk" without its animation.');
      s.release(); await next;
      expect(s.capture().inspection).toMatchObject({ animation: { playback: { chapterId: 'stroke', state: 'playing' } },
        lessonPlayback: { chapterId: 'stroke', stopped: false } });
    } finally { s.close(); }
  });

  it('a Done whose restore fails puts the chapter back whole, still running and paused', async () => {
    const s = stage({ atomic });
    try {
      await s.player.select(lesson.id);
      await s.player.start(false, 0, { narration: false });
      const whole = s.capture();
      s.failNextRestore();
      const error = await rejection(s.player.finish());
      expect(error.message).toBe('The starting view could not be drawn.');
      expect(error.rollback).toBe('restored');
      expect(s.player.getState()).toMatchObject({ active: true, stopped: false, step: 0, navigating: false });
      expect(settled(s.capture())).toEqual(settled(whole));
      expect(savedLessonPlayback(s.capture(), [lesson])).toMatchObject({ chapterId: 'walk', stopped: false });
      // Done can be tried again.
      await s.player.finish();
      expect(s.capture().inspection.lessonPlayback).toBeUndefined();
      expect(s.capture().inspection.animation).toBeUndefined();
    } finally { s.close(); }
  });
});

it('a chapter without animation starts whole and is saved playing without a clock', async () => {
  const s = stage({ atomic: true });
  try {
    await s.player.select(lesson.id);
    await s.player.start(false, 2, { narration: false });
    const scene = s.capture();
    expect(scene.inspection.animation).toBeUndefined();
    expect(savedLessonPlayback(scene, [lesson])).toMatchObject({ chapterId: 'still', stopped: false });
  } finally { s.close(); }
});
