import { describe, expect, it } from 'vitest';
import { isEmptyStereoState, pickStereoState } from '../src/stereo-state.js';

describe('pickStereoState', () => {
  it('takes the four fields a fit depends on out of a get_structure payload', () => {
    expect(pickStereoState({
      kind: 'structure',
      empty: false,
      structureText: 'ATOM …',
      format: 'pdb',
      color: 'chain-id',
      style: 'polymer-and-ligand',
      mode: 'parallel',
      depthBudgetArcmin: 20,
      swapEyes: false,
      variant: 'balanced',
    })).toEqual({
      mode: 'parallel',
      depthBudgetArcmin: 20,
      swapEyes: false,
      variant: 'balanced',
    });
  });

  it('leaves the coordinates, the look and everything else behind', () => {
    const patch = pickStereoState({ mode: 'cross', structureText: 'ATOM …', color: 'element-symbol' });
    expect(patch).toEqual({ mode: 'cross' });
    expect(Object.keys(patch)).toEqual(['mode']);
  });

  /*
   * An older server sends colour and style but no view state. The panel must
   * still adopt what it did send rather than treating the whole payload as
   * unusable, so each field is validated on its own.
   */
  it('accepts a payload that carries only some of the fields', () => {
    expect(pickStereoState({ mode: 'anaglyph' })).toEqual({ mode: 'anaglyph' });
    expect(pickStereoState({ swapEyes: true })).toEqual({ swapEyes: true });
    expect(pickStereoState({ color: 'chain-id', style: 'molecular-surface' })).toEqual({});
  });

  it('drops a field it cannot use without dropping the ones beside it', () => {
    expect(pickStereoState({ mode: 'sideways', depthBudgetArcmin: 20 })).toEqual({ depthBudgetArcmin: 20 });
    expect(pickStereoState({ mode: 'parallel', variant: 'anaglyphic' })).toEqual({ mode: 'parallel' });
    expect(pickStereoState({ mode: 'parallel', swapEyes: 'yes' })).toEqual({ mode: 'parallel' });
  });

  it('holds the depth budget to the same 0 to 60 arcminutes as the tool schema', () => {
    expect(pickStereoState({ depthBudgetArcmin: 0 })).toEqual({ depthBudgetArcmin: 0 });
    expect(pickStereoState({ depthBudgetArcmin: 60 })).toEqual({ depthBudgetArcmin: 60 });
    expect(pickStereoState({ depthBudgetArcmin: -1 })).toEqual({});
    expect(pickStereoState({ depthBudgetArcmin: 61 })).toEqual({});
    expect(pickStereoState({ depthBudgetArcmin: Number.NaN })).toEqual({});
    expect(pickStereoState({ depthBudgetArcmin: Number.POSITIVE_INFINITY })).toEqual({});
  });

  it('survives a payload that is not an object', () => {
    for (const payload of [undefined, null, 'parallel', 42, []]) {
      expect(pickStereoState(payload)).toEqual({});
    }
  });

  it('accepts every mode and variant the tool schema does', () => {
    for (const mode of ['off', 'parallel', 'cross', 'anaglyph'] as const) {
      expect(pickStereoState({ mode }).mode).toBe(mode);
    }
    for (const variant of ['balanced', 'dubois'] as const) {
      expect(pickStereoState({ variant }).variant).toBe(variant);
    }
  });
});

describe('isEmptyStereoState', () => {
  it('is true only when the payload carried none of the four fields', () => {
    expect(isEmptyStereoState({})).toBe(true);
    expect(isEmptyStereoState(pickStereoState({ color: 'chain-id' }))).toBe(true);
    expect(isEmptyStereoState({ mode: 'off' })).toBe(false);
    expect(isEmptyStereoState({ swapEyes: false })).toBe(false);
    expect(isEmptyStereoState({ depthBudgetArcmin: 0 })).toBe(false);
  });
});
