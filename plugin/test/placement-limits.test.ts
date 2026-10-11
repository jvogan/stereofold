// @ts-nocheck
import { expect, it } from 'vitest';
import { createInspectionState, normalizePlacement } from '../../lab/browser-roundtrip/inspection-state.mjs';
import { PLACEMENT_MIN_SCALE, PLACEMENT_MAX_SCALE, PLACEMENT_MAX_TRANSLATION } from '../../lab/browser-roundtrip/placement-limits.mjs';

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
