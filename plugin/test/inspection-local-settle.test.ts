import { expect, it } from 'vitest';
import { compatibleLocalSave } from '../src/inspection-local-settle.js';
import type { InspectionChange, InspectionScene } from '../src/inspection-contract.js';
import { movedBy } from './helpers/shared-panel-session.js';
import { InspectionCommands } from '../src/inspection-commands.js';

const base = {
  sourceSha256: 'a'.repeat(64), modelNumber: 1, assemblyId: '1', selectionKeys: ['one'],
  camera: { mode: 'perspective', fov: 1, position: [0, 0, 8], target: [0, 0, 0], up: [0, 1, 0],
    radius: 1, radiusMax: 1, fog: 0, clipFar: true, minNear: 0, minFar: 0 },
  inspection: { appearance: { opacity: 1 }, placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } },
} as InspectionScene;

const actions = ['start', 'done', 'restore-start', 'pause'] as const;
function playing(base: InspectionScene): InspectionScene {
  const scene = structuredClone(base);
  scene.inspection.lessonPlayback = { tourId: 'walk', chapterId: 'one', stopped: false, startingScene: structuredClone(base) };
  scene.inspection.animation = {
    definition: { version: 1, durationSeconds: 4, playback: { autoplay: true, loop: true }, tracks: [] },
    playback: { id: 'clip', chapterId: 'one', state: 'playing', timeSeconds: .2, durationSeconds: 4, loop: true, speed: 1 },
  } as any;
  return scene;
}

it.each(actions)('queued %s follows placement while the same playing clip advances', action => {
  const before = playing(base);
  const after = movedBy(before); after.inspection.animation!.playback.timeSeconds = .8;
  const change = { kind: 'tour', patch: { action, tourId: 'walk' } } as InspectionChange;
  expect(compatibleLocalSave(before, after, change)).toBe(true);
  expect(before.inspection.animation!.playback.timeSeconds).toBe(.2);
  // Loop wrap is elapsed time too.
  after.inspection.animation!.playback.timeSeconds = .1;
  expect(compatibleLocalSave(before, after, change)).toBe(true);
});

it.each(actions)('%s still refuses changed clip definitions or playback controls', action => {
  const before = playing(base);
  for (const patch of [{ id: 'different' }, { chapterId: 'two' }, { state: 'paused' }, { speed: 2 }, { loop: false }]) {
    const after = movedBy(before);
    Object.assign(after.inspection.animation!.playback, { timeSeconds: .8 }, patch);
    expect(compatibleLocalSave(before, after, { kind: 'tour', patch: { action } } as InspectionChange)).toBe(false);
  }
  const changed = movedBy(before); changed.inspection.animation!.definition.playback!.loop = false;
  expect(compatibleLocalSave(before, changed, { kind: 'tour', patch: { action } } as InspectionChange)).toBe(false);
  const paused = structuredClone(before); paused.inspection.animation!.playback.state = 'paused';
  const seek = movedBy(paused); seek.inspection.animation!.playback.timeSeconds = .8;
  expect(compatibleLocalSave(paused, seek, { kind: 'tour', patch: { action } } as InspectionChange)).toBe(false);
});

it.each(['start', 'done', 'restore-start'] as const)('%s still refuses same-chapter scientific edits and taken-over scenes as the clock advances', action => {
  const before = playing(base);
  const edits = [
    (s: InspectionScene) => { s.inspection.appearance.opacity = .3; },
    (s: InspectionScene) => { s.selectionKeys = []; },
    (s: InspectionScene) => { s.inspection.lessonPlayback!.stopped = true; },
    (s: InspectionScene) => { s.inspection.lessonPlayback!.chapterId = 'two'; s.inspection.lessonPlayback!.stopped = true; },
  ];
  for (const edit of edits) {
    const after = movedBy(before); after.inspection.animation!.playback.timeSeconds = .8; edit(after);
    expect(compatibleLocalSave(before, after, { kind: 'tour', patch: { action } } as InspectionChange)).toBe(false);
  }
});

it('host keeps an unbound Done queued after a same-clip clock and placement save', () => {
  const host = new InspectionCommands(() => 0);
  const binding = { serverEpoch: 'epoch', sourceToken: 'source', stateRevision: 1, inspectionRevision: 1 };
  const expected = { serverEpoch: 'epoch', sourceToken: 'source', baseStateRevision: 1, baseInspectionRevision: 1 };
  const panelId = host.attach({ ...expected, surface: 'companion' }, binding);
  host.poll({ ...expected, panelId, availability: 'ready' }, binding);
  const before = playing(base);
  host.enqueue({ ...expected, panelId, commandId: 'clock-done', deferLocalSave: true,
    change: { kind: 'tour', patch: { action: 'done' } } }, binding, before);
  const after = movedBy(before); after.inspection.animation!.playback.timeSeconds = .8;
  const saved = { ...binding, inspectionRevision: 2 };
  expect(host.canSettleLocalSave(panelId, binding)).toBe(true);
  host.settleLocalSave(panelId, binding, saved, after, before);
  expect(host.summary(saved, 'clock-done').command?.status).toBe('queued');
  expect(host.poll({ ...expected, baseInspectionRevision: 2, panelId, availability: 'ready' }, saved).delivery)
    .toMatchObject({ commandId: 'clock-done' });
});

it.each([false, true])('next survives a chapter turn settling before delivery (bound: %s)', bound => {
  const host = new InspectionCommands(() => 0);
  const binding = { serverEpoch: 'epoch', sourceToken: 'source', stateRevision: 1, inspectionRevision: 1 };
  const expected = { serverEpoch: 'epoch', sourceToken: 'source', baseStateRevision: 1, baseInspectionRevision: 1 };
  const panelId = host.attach({ ...expected, surface: 'companion' }, binding);
  host.poll({ ...expected, panelId, availability: 'ready' }, binding);
  const before = playing(base); delete before.inspection.animation;
  Object.assign(before.inspection.lessonPlayback!, { motionProgress: 0, motionPlaying: true });
  host.enqueue({ ...expected, panelId, commandId: 'turn-next', deferLocalSave: !bound,
    change: { kind: 'tour', patch: { action: 'next' } } }, binding, before);
  const after = movedBy(before);
  Object.assign(after.inspection.lessonPlayback!, { motionProgress: 1, motionPlaying: false });
  const saved = { ...binding, inspectionRevision: 2 };
  host.settleLocalSave(panelId, binding, saved, after, before);
  expect(host.summary(saved, 'turn-next').command?.status).toBe('queued');
  expect(host.poll({ ...expected, baseInspectionRevision: 2, panelId, availability: 'ready' }, saved).delivery)
    .toMatchObject({ commandId: 'turn-next' });
});

it('next still conflicts with a changed chapter, source, selection or scientific edit as a turn settles', () => {
  const before = playing(base); delete before.inspection.animation;
  Object.assign(before.inspection.lessonPlayback!, { motionProgress: 0, motionPlaying: true });
  for (const edit of [
    (s: InspectionScene) => { s.inspection.lessonPlayback!.chapterId = 'two'; },
    (s: InspectionScene) => { s.inspection.lessonPlayback!.stopped = true; },
    (s: InspectionScene) => { s.sourceSha256 = 'b'.repeat(64); },
    (s: InspectionScene) => { s.selectionKeys = []; },
    (s: InspectionScene) => { s.inspection.appearance.opacity = .3; },
  ]) {
    const after = movedBy(before);
    Object.assign(after.inspection.lessonPlayback!, { motionProgress: 1, motionPlaying: false });
    edit(after);
    expect(compatibleLocalSave(before, after, { kind: 'tour', patch: { action: 'next' } })).toBe(false);
  }
});
