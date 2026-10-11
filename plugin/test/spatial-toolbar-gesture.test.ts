import { describe, expect, it } from 'vitest';
// @ts-ignore Pure XR event tracker has no Mol* runtime dependency.
import { createSpatialToolbarGestureTracker, createToolbarPointerTracker } from '../../lab/browser-roundtrip/spatial-toolbar-gesture.mjs';

function tracker() {
  const phases: string[] = [], completed: string[] = [];
  const source = {};
  const value = createSpatialToolbarGestureTracker({
    onCapture: ({ phase }: { phase: string }) => phases.push(phase),
    onComplete: (action: { id: string }) => completed.push(action.id),
  });
  return { ...value, source, action: { id: 'fit' }, phases, completed };
}

describe('spatial toolbar XR gesture tracker', () => {
  for (const order of [['select', 'start', 'end'], ['start', 'select', 'end']]) {
    it(`admits one action for ${order.join(' → ')}`, () => {
      const t = tracker();
      for (const step of order) step === 'start' ? t.start(t.source, t.action) : step === 'select' ? t.select(t.source) : t.end(t.source);
      expect(t.completed).toEqual(['fit']);
      expect(t.phases).toEqual(['start', 'end']);
    });
  }
  it('does not let an orphan select or bare release bleed into a later press', async () => {
    const t = tracker();
    t.select(t.source); t.end(t.source);
    await Promise.resolve(); // orphan early select cannot survive a dispatch turn
    t.start(t.source, t.action); t.end(t.source); // cancelled transient action
    t.start(t.source, { id: 'next' }); t.select(t.source); t.end(t.source);
    expect(t.completed).toEqual(['next']);
  });
  it('reports cancellation and expires a duplicate post-completion select', async () => {
    const t = tracker();
    t.select(t.source); t.end(t.source);
    t.start(t.source, t.action); t.cancel(t.source);
    t.start(t.source, t.action); t.select(t.source); t.end(t.source); t.select(t.source);
    await Promise.resolve();
    t.start(t.source, { id: 'again' }); t.select(t.source); t.end(t.source);
    expect(t.completed).toEqual(['fit', 'again']);
    expect(t.phases).toEqual(['start', 'cancel', 'start', 'end', 'start', 'end']);
  });
  it('bounds an early select by the dispatch turn, not by XR frame identity', async () => {
    const t = tracker();
    // A runtime may report the two events of one press from different frames.
    // The reversed pair still belongs to one press and must fire the control.
    t.select(t.source); t.start(t.source, t.action); t.end(t.source);
    expect(t.completed).toEqual(['fit']);
    // An unclaimed select still cannot arm a press in a later dispatch turn.
    t.select(t.source);
    await Promise.resolve();
    t.start(t.source, { id: 'next' }); t.end(t.source);
    expect(t.completed).toEqual(['fit']);
    // A normal held press completes across frames.
    t.start(t.source, t.action); t.select(t.source); t.end(t.source);
    expect(t.completed).toEqual(['fit', 'fit']);
  });
});

describe('controller aim arbitration', () => {
  // A Quest 2 reports two controllers and both rays cross the panel. The
  // first physical session lost its hover to the resting hand, so the
  // highlight sat on a row the wearer was not pointing at.
  const ray = (x: number) => ({ origin: [x, 1.6, 0], direction: [0, 0, -1] });

  it('ranks the hand that moved most recently above one held still', () => {
    const pointers = createToolbarPointerTracker();
    const left = { handedness: 'left' }, right = { handedness: 'right' };
    pointers.rank(left, ray(-0.4));
    pointers.rank(right, ray(0.4));
    expect(pointers.rank(right, ray(0.4))).toBeLessThan(pointers.rank(left, ray(-0.41)));
    // Holding the newly aimed hand still keeps its lead; it does not decay.
    expect(pointers.rank(right, ray(0.4))).toBeLessThan(pointers.rank(left, ray(-0.41)));
  });

  it('treats a ray that has not moved as unmoved, within a tracking epsilon', () => {
    const pointers = createToolbarPointerTracker();
    const source = { handedness: 'right' };
    const first = pointers.rank(source, ray(0.4));
    expect(pointers.rank(source, { origin: [0.4 + 1e-6, 1.6, 0], direction: [0, 0, -1] })).toBe(first);
    expect(pointers.rank(source, ray(0.5))).toBeGreaterThan(first);
  });

  it('forgets a source the session no longer reports', () => {
    const pointers = createToolbarPointerTracker();
    const left = { handedness: 'left' }, right = { handedness: 'right' };
    pointers.rank(left, ray(-0.4)); pointers.rank(right, ray(0.4));
    expect(pointers.size()).toBe(2);
    pointers.retain([right]);
    expect(pointers.size()).toBe(1);
    pointers.forget(right);
    expect(pointers.size()).toBe(0);
  });

  it('ignores a source with no usable target ray', () => {
    const pointers = createToolbarPointerTracker();
    expect(pointers.rank(undefined, ray(0))).toBe(0);
    expect(pointers.rank({ handedness: 'right' }, undefined)).toBe(0);
    expect(pointers.size()).toBe(0);
  });
});
