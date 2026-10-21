import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { mountTourPlayer, type Tour } from '../src/tour-player.js';
// @ts-ignore Production closures with renderer and DOM adapters.
import { tourEndHarness } from '../../lab/browser-roundtrip/fixtures/tour-end-harness.mjs';
// @ts-ignore Production viewer closure adapter.
import { tourFocusHarness } from '../../lab/browser-roundtrip/fixtures/tour-focus-harness.mjs';
// @ts-ignore Production closure extraction.
import { pageFunction } from '../../lab/browser-roundtrip/fixtures/label-action-harness.mjs';
// @ts-ignore Production geometry.
import { fitChapterField } from '../../lab/browser-roundtrip/chapter-field.mjs';
// @ts-ignore Production clock.
import { createPlaybackClock } from '../../packages/motion/src/keyframes.mjs';
// @ts-ignore Production publication gate.
import { createNamedPublication } from '../../lab/inspection/named-publication.mjs';

it('opening expanded glass publishes automatic clearance after drawing without stopping a walk or dropping emphasis', async () => {
  vi.useFakeTimers();
  const env = tourEndHarness(), { h } = tourFocusHarness();
  const viewer = readFileSync(new URL('../../lab/browser-roundtrip/viewer.mjs', import.meta.url), 'utf8');
  const inspector = readFileSync(new URL('../src/inspector.ts', import.meta.url), 'utf8');
  const lesson: Tour = { id: 'clearance-walk', title: 'Walk', summary: '', steps: [{ id: 'walk', title: 'Walk', durationMs: 30000,
    emphasis: { parts: [{ id: 'head', label: 'Head', chain: 'A', color: '#25859b' }] },
    animation: { version: 1, durationSeconds: 20, playback: { autoplay: true, loop: true }, tracks: [] } }] };
  let clock: any, draws = 0, saves = 0;
  Object.assign(env.workspace.viewer.inspection, {
    supportsConcurrentPlayback: true,
    setMolecularAnimation: async (value: any) => { clock = value ? createPlaybackClock(value.durationSeconds, value.playback) : undefined; },
    controlMolecularAnimation: (patch: any) => clock?.patch(patch, Date.now()),
  });
  const player = mountTourPlayer({ ...env, tours: [lesson] });
  try {
    await player.select(lesson.id); await player.start(true, 0, { narration: false });
    const emphasis = env.capture().painted;
    const marker = '    onMutation:(snapshot:any)=>{';
    const start = inspector.indexOf(marker) + marker.length;
    const end = inspector.indexOf('experiencePlayer?.notifyMutation();', start) + 'experiencePlayer?.notifyMutation();'.length;
    const publication = vm.runInNewContext(ts.transpileModule(`(snapshot:any)=>{${inspector.slice(start,end)}}`,
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText,
      { loading: false, remote: false, tourPlayer: player, experiencePlayer: undefined,
        scheduleSave: () => { expect(draws).toBeGreaterThan(0); saves++; } });
    const namedPublication = createNamedPublication(publication);
    Object.assign(h, {
      fitChapterField, chapterFieldBounds: () => ({ center: [0,0,0], radius: 10 }),
      interactionActive: () => false, assertContext() {}, retainCurrent: () => null,
      beginWork: () => ({ finish() {} }), motionMutationPaused: false, motionToolPaused: false,
      syncPresentationMotion() {}, recordRenderCost() {}, retainedPoseHidden: false,
      waitForFrame: async () => { draws++; }, snapshot: env.workspace.snapshot,
      emit: (callback: any, value: any) => callback(value), onMutation: (snapshot: any) => namedPublication.mutation(snapshot),
    });
    h.canvas.commit = () => {};
    h.state.revision = 0; h.state.mutationCounts = { inspection: 0 };
    for (const name of ['mutate', 'clearChapterMenu']) vm.runInContext(pageFunction(viewer, name), h);
    h.inspectionMutation = (operation: any, options: any) => h.mutate('inspection', operation, options);
    const before = h.inspectionSnapshot().placement;
    await h.clearChapterMenu({ points: h.immersiveSession.platePoints(), isCurrent: () => true });
    expect(h.inspectionSnapshot().placement).not.toEqual(before);
    expect(saves).toBe(1); expect(draws).toBe(1); expect(h.motionToolPaused).toBe(false);
    expect(player.getState()).toMatchObject({ autoplay: true, stopped: false });
    expect(env.capture().painted).toEqual(emphasis);
    clock.sample(Date.now()); await vi.advanceTimersByTimeAsync(1000); clock.sample(Date.now());
    expect(clock.snapshot()).toMatchObject({ state: 'playing' });
    expect(clock.snapshot().timeSeconds).toBeGreaterThan(.9);
    expect(env.capture().painted).toEqual(emphasis);
    // Automatic origin must never mask an actual source change.
    player.notifyMutation({ sourceSha256: 'replacement' }, { origin: 'automatic-clearance' });
    expect(player.getState().stopped).toBe(true);
  } finally { player.pause(); env.cleanup(); vi.useRealTimers(); }
});

it('a start while the wearer holds placement moves the menu, not the molecule', async () => {
  const env = tourEndHarness(), { h, hold, records } = tourFocusHarness();
  const viewer = readFileSync(new URL('../../lab/browser-roundtrip/viewer.mjs', import.meta.url), 'utf8');
  // The opening chapter authors a placement: a close-up that must still yield at start.
  const lesson: Tour = { id: 'held-walk', title: 'Walk', summary: '', steps: [{ id: 'walk', title: 'Walk', durationMs: 30000,
    placement: { scale: 2.4 }, emphasis: { parts: [{ id: 'head', label: 'Head', chain: 'A', color: '#25859b' }] },
    animation: { version: 1, durationSeconds: 20, playback: { autoplay: true, loop: true }, tracks: [] } }] };
  let releases = 0;
  Object.assign(env.workspace.viewer.inspection, {
    supportsConcurrentPlayback: true, setMolecularAnimation: async () => {},
    holdsWearerPlacement: () => hold.holdsPlacement(),
    beginChapterFraming: () => { releases++; hold.release('authored-chapter'); },
  });
  const player = mountTourPlayer({ ...env, tours: [lesson] });
  try {
    for (const view of h.latestRoomPlacementPose.labelViews) {
      view.transform.matrix[13] = h.latestRoomPlacementPose.headInRoom[13];
      view.transform.inverse.matrix[13] = -h.latestRoomPlacementPose.headInRoom[13];
    }
    // Two metres ahead at eye height (radius 100, camera scale 0.01).
    h.inspectionState.place({ translation: [0, h.latestRoomPlacementPose.headInRoom[13], -2], rotation: [0, 0, 0], scale: 1 });
    hold.takeover('grab');
    const placed = h.inspectionSnapshot().placement;
    await player.select(lesson.id); await player.start(true, 0, { narration: false });
    expect(releases).toBe(0); expect(hold.holdsPlacement()).toBe(true);
    Object.assign(h, { fitChapterField, chapterFieldBounds: () => ({ center: [0, 0, 0], radius: 10 }),
      interactionActive: () => false });
    vm.runInContext(pageFunction(viewer, 'clearChapterMenu'), h);
    // Glass over the molecule, an alternate seat that only partly clears it,
    // and one that clears it.
    const points = [-.5, .5].flatMap(x => [-.5, .5].map(y => [x, h.latestRoomPlacementPose.headInRoom[13] + y, -1]));
    const partial = { id: 3, points: points.map(p => [p[0] + .53, p[1], p[2]]) };
    const clear = { id: 4, points: points.map(p => [p[0] * .15 + .65, p[1], p[2]]) };
    const moved = await h.clearChapterMenu({ points, isCurrent: () => true, relocationCandidates: () => [partial, clear] });
    expect(moved?.menuRelocation).toBe(clear);
    expect(h.inspectionSnapshot().placement).toEqual(placed);
    // With only the partial seat, no glass is admitted over the molecule.
    const refused = await h.clearChapterMenu({ points, isCurrent: () => true, relocationCandidates: () => [partial] });
    expect(refused?.obstructed).toBe(true); expect(refused?.menuRelocation).toBeUndefined();
    expect(h.inspectionSnapshot().placement).toEqual(placed);
    const field = records.filter((r: any) => r.kind === 'chapter-field');
    expect(field.map((r: any) => r.reason)).toEqual(['menu-relocated', 'menu-obstructed']);
    expect(field[0]).toMatchObject({ seat: 4, parked: false });
    expect(field[1]).toMatchObject({ held: true });
  } finally { player.pause(); env.cleanup(); }
});
