import { expect, it, vi } from 'vitest';
import { mountTourPlayer, type Tour } from '../src/tour-player.js';
// @ts-ignore Production DOM adapter.
import { tourEndHarness } from '../../lab/browser-roundtrip/fixtures/tour-end-harness.mjs';

const tour: Tour = { id: 'growth', title: 'Growth', summary: '', steps: [
  { id: 'reveal', title: 'Reveal', motion: { kind: 'turntable', degrees: 25, seconds: 8 } },
  { id: 'orbit', title: 'Orbit', motion: { kind: 'orbit', axis: 'y', degrees: 20, seconds: 8 } },
] };

for (const fraction of [0, .4, 1]) it(`continues the saved reveal turn once from ${fraction} across entry and Next`, async () => {
  vi.useFakeTimers();
  const h = tourEndHarness({ xr: true });
  let yaw = 25 * fraction, cursor: any;
  const capture = h.workspace.capture;
  h.workspace.capture = () => ({ ...capture(), sourceSha256: 'same', modelNumber: 1, assemblyId: '', camera: { yaw }, inspection: {} });
  Object.assign(h.workspace.viewer.inspection, {
    applyLessonMotion: async (move: any) => { yaw += move.degrees; },
    setLessonPlayback: (value: any) => { cursor = value; },
  });
  const player = mountTourPlayer({ ...h, tours: [tour] });
  try {
    const scene: any = h.workspace.capture();
    scene.inspection = { lessonPlayback: { tourId: tour.id, chapterId: 'reveal', stopped: false,
      entry: 'start', motionPlaying: true, motionProgress: fraction, startingScene: h.workspace.capture() } };
    await player.restorePlayback(scene);
    player.notifyMutation(h.workspace.snapshot(), { origin: 'xr-entry' });
    await vi.advanceTimersByTimeAsync(8500);
    expect(yaw).toBeCloseTo(25, 8);
    expect(cursor.motionProgress).toBe(1);
    scene.camera = { yaw }; scene.inspection.lessonPlayback = cursor;
    await player.restorePlayback(scene);
    await vi.advanceTimersByTimeAsync(8500);
    expect(yaw).toBeCloseTo(25, 8);
    await player.next(); await vi.advanceTimersByTimeAsync(8500);
    expect(yaw).toBeCloseTo(45, 8);
    expect(player.getState()).toMatchObject({ active: true, step: 1 });
  } finally { player.pause(); h.cleanup(); vi.useRealTimers(); }
});

it('publishes a fresh turn as unfinished, and keeps a paused saved move paused', async () => {
  vi.useFakeTimers();
  const h = tourEndHarness({ xr: true });
  let cursor: any, yaw = 0;
  const capture = h.workspace.capture;
  h.workspace.capture = () => ({ ...capture(), sourceSha256: 'same', modelNumber: 1, assemblyId: '', camera: { yaw }, inspection: {} });
  Object.assign(h.workspace.viewer.inspection, {
    applyLessonMotion: async (move: any) => { yaw += move.degrees; },
    setLessonPlayback: (value: any) => { cursor = value; },
  });
  const player = mountTourPlayer({ ...h, tours: [tour] });
  try {
    await player.select(tour.id); await player.start(false);
    expect(cursor).toMatchObject({ motionProgress: 0, motionPlaying: true });
    await vi.advanceTimersByTimeAsync(4000); player.pause();
    expect(cursor.motionProgress).toBeCloseTo(.5, 8);
    expect(cursor.motionPlaying).toBe(false);
    const paused = yaw, scene: any = h.workspace.capture();
    scene.inspection.lessonPlayback = cursor;
    await player.restorePlayback(scene); await vi.advanceTimersByTimeAsync(8500);
    expect(yaw).toBe(paused);
  } finally { player.pause(); h.cleanup(); vi.useRealTimers(); }
});

it('keeps the local turn progress when a peer receipt preserves the headset camera', async () => {
  vi.useFakeTimers();
  const h = tourEndHarness({ xr: true });
  let yaw = 0, cursor: any;
  const capture = h.workspace.capture;
  h.workspace.capture = () => ({ ...capture(), sourceSha256: 'same', modelNumber: 1, assemblyId: '', camera: { yaw }, inspection: {} });
  Object.assign(h.workspace.viewer.inspection, {
    applyLessonMotion: async (move: any) => { yaw += move.degrees; }, setLessonPlayback: (value: any) => { cursor = value; },
  });
  const player = mountTourPlayer({ ...h, tours: [tour] });
  try {
    await player.select(tour.id); await player.start(false); await vi.advanceTimersByTimeAsync(4000);
    const peer: any = h.workspace.capture();
    peer.camera = { yaw: 25 };
    peer.inspection.lessonPlayback = { ...cursor, motionProgress: 1, motionPlaying: false };
    await player.restorePlayback(peer, { frame: true }); await vi.advanceTimersByTimeAsync(8500);
    expect(yaw).toBeCloseTo(25, 8);
    expect(cursor.motionProgress).toBe(1);
  } finally { player.pause(); h.cleanup(); vi.useRealTimers(); }
});

it('waits through entry rendering instead of spending camera motion on rejected ticks', async () => {
  vi.useFakeTimers();
  const h = tourEndHarness({ xr: true });
  let ready = true, yaw = 0;
  const snapshot = h.workspace.snapshot;
  h.workspace.snapshot = () => ({ ...snapshot(), ready });
  h.workspace.viewer.inspection.applyLessonMotion = async (move: any) => {
    if (!ready) throw Error('Renderer is seating the entry');
    yaw += move.degrees;
  };
  const player = mountTourPlayer({ ...h, tours: [tour] });
  try {
    await player.select(tour.id); await player.start(false);
    ready = false; await vi.advanceTimersByTimeAsync(4000);
    ready = true; await vi.advanceTimersByTimeAsync(8500);
    expect(yaw).toBeCloseTo(25, 8);
  } finally { player.pause(); h.cleanup(); vi.useRealTimers(); }
});

it('retains turns a tracked viewer declines during entry even when its ready sample was true', async () => {
  vi.useFakeTimers();
  const h = tourEndHarness({ xr: true });
  let admitted = false, yaw = 0;
  h.workspace.viewer.inspection.applyLessonMotion = async (move: any) => {
    if (!admitted) return { lessonMotionApplied: false };
    yaw += move.degrees; return { lessonMotionApplied: true };
  };
  const player = mountTourPlayer({ ...h, tours: [tour] });
  try {
    await player.select(tour.id); await player.start(false);
    await vi.advanceTimersByTimeAsync(4000); admitted = true;
    await vi.advanceTimersByTimeAsync(8500);
    expect(yaw).toBeCloseTo(25, 8);
  } finally { player.pause(); h.cleanup(); vi.useRealTimers(); }
});

it('starts the companion opening turn only after its XR seat commits', async () => {
  vi.useFakeTimers();
  const h = tourEndHarness({ xr: false });
  let xr = false, yaw = 0;
  const snapshot = h.workspace.snapshot, capture = h.workspace.capture;
  h.workspace.snapshot = () => ({ ...snapshot(), xrPresenting: xr });
  h.workspace.capture = () => ({ ...capture(), sourceSha256: 'same', modelNumber: 1, assemblyId: '', camera: { yaw }, inspection: {} });
  h.workspace.viewer.inspection.applyLessonMotion = async (move: any) => { yaw += move.degrees; };
  const player = mountTourPlayer({ ...h, tours: [tour] });
  try {
    const scene: any = h.workspace.capture();
    scene.inspection.lessonPlayback = { tourId: tour.id, chapterId: 'reveal', stopped: false, entry: 'start',
      motionProgress: 0, motionPlaying: true, cameraFrame: 'desktop', startingScene: h.workspace.capture() };
    await player.restorePlayback(scene, { waitForXrEntry: true });
    await vi.advanceTimersByTimeAsync(4000); expect(yaw).toBe(0);
    xr = true; await vi.advanceTimersByTimeAsync(2000); expect(yaw).toBe(0);
    player.notifyMutation(h.workspace.snapshot(), { origin: 'xr-entry' });
    await vi.advanceTimersByTimeAsync(8500); expect(yaw).toBeCloseTo(25, 8);
  } finally { player.pause(); h.cleanup(); vi.useRealTimers(); }
});

it('keeps the committed XR camera frame when the page returns to its flat preview', async () => {
  const h = tourEndHarness({ xr: true });
  let xr = true, cursor: any;
  const snapshot = h.workspace.snapshot;
  h.workspace.snapshot = () => ({ ...snapshot(), xrPresenting: xr });
  h.workspace.viewer.inspection.setLessonPlayback = (value: any) => { cursor = value; };
  const player = mountTourPlayer({ ...h, tours: [tour] });
  try {
    await player.select(tour.id); await player.start(false);
    player.notifyMutation(h.workspace.snapshot(), { origin: 'xr-entry' });
    xr = false; player.notifyMutation(h.workspace.snapshot(), { agent: true });
    expect(cursor.cameraFrame).toBe('xr');
  } finally { player.pause(); h.cleanup(); }
});

/** A headset page that restores a desktop lesson before its wearer enters VR. */
function flatHeadsetPage(saved: { motionProgress: number; motionPlaying: boolean }) {
  const h = tourEndHarness({ xr: false });
  const room = { xr: false, entryPending: undefined as boolean | undefined, yaw: 0 };
  const snapshot = h.workspace.snapshot, capture = h.workspace.capture;
  h.workspace.snapshot = () => ({ ...snapshot(), xrPresenting: room.xr,
    ...(room.entryPending === undefined ? {} : { xrEntryPending: room.entryPending }) });
  h.workspace.capture = () => ({ ...capture(), sourceSha256: 'same', modelNumber: 1, assemblyId: '', camera: { yaw: room.yaw }, inspection: {} });
  h.workspace.viewer.inspection.applyLessonMotion = async (move: any) => { room.yaw += move.degrees; };
  const player = mountTourPlayer({ ...h, tours: [tour] });
  const scene = (): any => {
    const restored: any = h.workspace.capture();
    restored.inspection.lessonPlayback = { tourId: tour.id, chapterId: 'reveal', stopped: false, entry: 'start',
      ...saved, cameraFrame: 'desktop', startingScene: h.workspace.capture() };
    return restored;
  };
  return { h, room, player, scene };
}

for (const saved of [{ motionProgress: 1, motionPlaying: false }, { motionProgress: 0, motionPlaying: true }])
  it(`plays the next chapter's turn on a headset page still flat, opening turn ${saved.motionPlaying ? 'waiting' : 'finished'}`, async () => {
    vi.useFakeTimers();
    const { h, room, player, scene } = flatHeadsetPage(saved);
    try {
      await player.restorePlayback(scene(), { waitForXrEntry: true });
      await vi.advanceTimersByTimeAsync(4000);
      expect(room.yaw).toBe(0);
      await player.next(); await vi.advanceTimersByTimeAsync(8500);
      expect(room.yaw).toBeCloseTo(20, 8);
      expect(player.getState()).toMatchObject({ step: 1, motionRunning: false });
    } finally { player.pause(); h.cleanup(); vi.useRealTimers(); }
  });

it('releases the restored opening turn when the headset session has no entry seat left to give', async () => {
  vi.useFakeTimers();
  const { h, room, player, scene } = flatHeadsetPage({ motionProgress: 0, motionPlaying: true });
  try {
    await player.restorePlayback(scene(), { waitForXrEntry: true });
    room.xr = true; room.entryPending = true;
    await vi.advanceTimersByTimeAsync(2000);
    expect(room.yaw).toBe(0);
    // The seat is refused: no entry-seat placement is ever published.
    room.entryPending = false;
    await vi.advanceTimersByTimeAsync(8500);
    expect(room.yaw).toBeCloseTo(25, 8);
    await player.next(); await vi.advanceTimersByTimeAsync(8500);
    expect(room.yaw).toBeCloseTo(45, 8);
  } finally { player.pause(); h.cleanup(); vi.useRealTimers(); }
});

it('does not carry an entry wait into a scene restored while already in the headset', async () => {
  vi.useFakeTimers();
  const { h, room, player, scene } = flatHeadsetPage({ motionProgress: 0, motionPlaying: true });
  try {
    await player.restorePlayback(scene(), { waitForXrEntry: true });
    // The seat lands while the page reloads its scene, so its notice is not delivered.
    room.xr = true;
    await player.restorePlayback(scene(), { waitForXrEntry: true });
    await vi.advanceTimersByTimeAsync(8500);
    expect(room.yaw).toBeCloseTo(25, 8);
  } finally { player.pause(); h.cleanup(); vi.useRealTimers(); }
});

it('ends a move the viewer keeps declining after the move\'s own time, and never plays it late', async () => {
  vi.useFakeTimers();
  const h = tourEndHarness({ xr: true });
  let held = true, asked = 0, moved = 0, cursor: any;
  const capture = h.workspace.capture;
  h.workspace.capture = () => ({ ...capture(), sourceSha256: 'same', modelNumber: 1, assemblyId: '', camera: {}, inspection: {} });
  Object.assign(h.workspace.viewer.inspection, {
    // The headset viewer yields a dolly for as long as the wearer holds the placement.
    applyLessonMotion: async () => { asked++; if (held) return { lessonMotionApplied: false }; moved++; return { lessonMotionApplied: true }; },
    setLessonPlayback: (value: any) => { cursor = value; },
  });
  const dolly: Tour = { id: 'approach', title: 'Approach', summary: '', steps: [
    { id: 'close', title: 'Close', motion: { kind: 'dolly', metres: 0.15, seconds: 8 } }] };
  const player = mountTourPlayer({ ...h, tours: [dolly] });
  try {
    await player.select(dolly.id); await player.start(false);
    await vi.advanceTimersByTimeAsync(4000);
    expect(player.getState().motionRunning).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(player.getState()).toMatchObject({ active: true, step: 0, motionRunning: false });
    expect(cursor).toMatchObject({ motionPlaying: false, motionProgress: 0 });
    const askedInItsTime = asked;
    // Minutes later the wearer lets the placement go. The chapter's time is over.
    await vi.advanceTimersByTimeAsync(120_000); held = false;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(asked).toBe(askedInItsTime);
    expect(moved).toBe(0);
  } finally { player.pause(); h.cleanup(); vi.useRealTimers(); }
});
