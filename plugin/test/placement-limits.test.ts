// @ts-nocheck
import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { sceneSchema } from '../src/inspection-contract.js';
import { initialRoomCameraScale, createRoomSeatMemory } from '../../lab/browser-roundtrip/room-seat-memory.mjs';
import { placementFromRoom } from '../../lab/browser-roundtrip/room-anchor.mjs';
import { createInspectionState, normalizePlacement } from '../../lab/browser-roundtrip/inspection-state.mjs';
import { PLACEMENT_MIN_SCALE, PLACEMENT_MAX_SCALE, PLACEMENT_MAX_TRANSLATION } from '../../lab/browser-roundtrip/placement-limits.mjs';

// The plain 0.1.22 scene shape, before optional lesson/animation fields.
const legacyScene = JSON.parse(readFileSync(new URL('./fixtures/small-placement-0.1.22.json', import.meta.url), 'utf8'));
it.each([.005, 1e-4, 1.7e-6, 1e-6])('validates a 0.1.22 saved scene at scale %s unchanged', scale => {
  const saved = structuredClone(legacyScene);
  saved.inspection.placement.scale = scale;
  expect(sceneSchema.parse(saved)).toEqual(saved);
});
it('restores the 0.1.22 scene and retains its small placement through history and XR return', () => {
  const view = createInspectionState();
  view.replace(legacyScene.inspection);
  expect(view.snapshot().placement).toEqual(legacyScene.inspection.placement);
  view.place({ scale: .025 });
  view.undo();
  expect(view.snapshot().placement).toEqual(legacyScene.inspection.placement);
  view.redo();
  expect(view.snapshot().placement.scale).toBe(.025);
  const memory = createRoomSeatMemory();
  expect(memory.remember({ scene: legacyScene, placement: legacyScene.inspection.placement,
    cameraScale: .001, camera: legacyScene.camera })).toBe(true);
  expect(memory.take({ scene: legacyScene, placement: legacyScene.inspection.placement })?.placement)
    .toEqual(legacyScene.inspection.placement);
});
it('seats a large structure with retained camera units below .01 and restores that placement', () => {
  const identity = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
  // A larger source in a camera frame established on a small source.
  const cameraScale = initialRoomCameraScale({ radius: 10, placementScale: 1 });
  const seat = placementFromRoom({ headInRoom: identity, renderFromRoom: identity,
    cameraScale, center: [0,0,0], radius: 3000, mode: 'floor' });
  expect(seat.scale).toBeCloseTo(2.4 / (2 * 3000 * cameraScale), 12);
  expect(seat.scale).toBeLessThan(.01);
  expect(seat.metersAcross).toBeCloseTo(2.4, 12);
  const saved = structuredClone(legacyScene);
  saved.inspection.placement = { scale: seat.scale, translation: seat.translation, rotation: [0,0,0] };
  const view = createInspectionState();
  view.replace(sceneSchema.parse(saved).inspection);
  expect(view.placement()).toEqual(saved.inspection.placement);
});
it.each([0, -1, NaN, Infinity, -Infinity, 1e-7, 1e7])('refuses invalid saved scale %s in host and renderer', scale => {
  const saved = structuredClone(legacyScene);
  saved.inspection.placement.scale = scale;
  expect(() => sceneSchema.parse(saved)).toThrow();
  expect(() => createInspectionState().replace(saved.inspection)).toThrow();
});

it.each([PLACEMENT_MIN_SCALE, .01, 8, 100, PLACEMENT_MAX_SCALE])('saves and restores explored scale %s without clamping', scale => {
  const view=createInspectionState();
  const placement={scale,translation:[12,-20,30],rotation:[12,24,-36]};
  view.place(placement);
  const saved=view.snapshot(), fresh=createInspectionState();
  fresh.replace({appearance:saved.appearance,placement:saved.placement});
  expect(fresh.snapshot().placement).toEqual(placement);
  view.undo(); expect(view.snapshot().placement.scale).toBe(1);
  view.redo(); expect(view.snapshot().placement).toEqual(placement);
});
it('accepts the numerical envelope and rejects non-finite, zero or out-of-range values', () => {
  expect(normalizePlacement({translation:[PLACEMENT_MAX_TRANSLATION,-PLACEMENT_MAX_TRANSLATION,0]}).translation)
    .toEqual([PLACEMENT_MAX_TRANSLATION,-PLACEMENT_MAX_TRANSLATION,0]);
  for(const scale of [0,-1,NaN,Infinity,PLACEMENT_MIN_SCALE/2,PLACEMENT_MAX_SCALE*2])
    expect(()=>normalizePlacement({scale})).toThrow();
  for(const n of [NaN,Infinity,PLACEMENT_MAX_TRANSLATION+1,-PLACEMENT_MAX_TRANSLATION-1])
    expect(()=>normalizePlacement({translation:[n,0,0]})).toThrow();
});
