// @ts-nocheck
import { describe, expect, it } from 'vitest';
import { preserveSourceTransitionAnchor, transformedVisibleCenter } from '../../lab/browser-roundtrip/source-transition-anchor.mjs';

describe('source transition room anchor', () => {
  it('keeps a visible stage center and diameter fixed across different source origins and radii', () => {
    const priorBase = { center: [120, -40, 8], radius: 80 };
    const priorVisible = { center: [160, -30, 12], radius: 24 };
    const priorPlacement = { translation: [.6, -1.2, .15], rotation: [15, -35, 20], scale: 1.4 };
    const nextBase = { center: [-250, 90, -32], radius: 54 };
    const nextVisible = { center: [-230, 76, -20], radius: 42 };
    const next = preserveSourceTransitionAnchor({ priorBase, priorVisible, priorPlacement, priorCameraScale: .0125, nextBase, nextVisible });
    const oldCenter = transformedVisibleCenter({ base: priorBase, visible: priorVisible, placement: priorPlacement }).map(value => value * .0125);
    const newCenter = transformedVisibleCenter({ base: nextBase, visible: nextVisible, placement: next.placement }).map(value => value * next.cameraScale);
    newCenter.forEach((value, index) => expect(value).toBeCloseTo(oldCenter[index], 12));
    expect(next.placement.rotation).toEqual(priorPlacement.rotation);
    expect(nextVisible.radius * next.placement.scale * next.cameraScale).toBeCloseTo(priorVisible.radius * priorPlacement.scale * .0125, 10);
  });

  it('maps the audited 1CRN to 5SYF asymmetric unit, 5SYF lattice, then 3JAK without moving the room anchor', () => {
    const sources = [
      { base: { center: [10.5935, 10.2105, 6.079], radius: 22.017370267586454 } },
      { base: { center: [326.6425, 448.0835, 343.543], radius: 64.62849668296485 } },
      { base: { center: [336.7598438165, 337.7725804945, 384.293], radius: 246.1708586118985 } },
      { base: { center: [321.466, 440.333, 339.229], radius: 137.5156626461146 } },
    ];
    let placement = { translation: [.35, -.2, .1], rotation: [10, 20, -15], scale: 1.2 }, cameraScale = .04;
    const first = transformedVisibleCenter({ base: sources[0].base, placement }).map(value => value * cameraScale);
    const firstRadius = sources[0].base.radius * placement.scale * cameraScale;
    for (const source of sources.slice(1)) {
      const next = preserveSourceTransitionAnchor({ priorBase: sources[sources.indexOf(source) - 1].base,
        priorPlacement: placement, priorCameraScale: cameraScale, nextBase: source.base });
      placement = next.placement; cameraScale = next.cameraScale;
      const center = transformedVisibleCenter({ base: source.base, placement }).map(value => value * cameraScale);
      center.forEach((value, index) => expect(value).toBeCloseTo(first[index], 10));
      expect(source.base.radius * placement.scale * cameraScale).toBeCloseTo(firstRadius, 10);
    }
  });

  it('uses XR scene scale, rebases a finite distant center and rejects non-finite placement arithmetic', () => {
    expect(preserveSourceTransitionAnchor({
      priorBase: { center: [0, 0, 0], radius: 1 }, priorVisible: { center: [0, 0, 0], radius: 1 },
      priorPlacement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 4 }, priorCameraScale: .1,
      nextBase: { center: [0, 0, 0], radius: 1 }, nextVisible: { center: [0, 0, 0], radius: 10000000 },
    })).toMatchObject({ placement: { scale: 1e-6 }, usedCameraScale: true });
    const rebased = preserveSourceTransitionAnchor({
      priorBase: { center: [0, 0, 0], radius: 1 }, priorVisible: { center: [0, 0, 0], radius: 1 },
      priorPlacement: { translation: [9, 0, 0], rotation: [0, 0, 0], scale: 1 }, priorCameraScale: 1,
      nextBase: { center: [-2000000, 0, 0], radius: 1 }, nextVisible: { center: [-2000000, 0, 0], radius: 1 },
    });
    expect(rebased.placement.translation).toEqual([0, 0, 0]);
    expect(rebased.cameraOffset).toEqual([-2000009, 0, 0]);
    const center = transformedVisibleCenter({ base: { center: [-2000000, 0, 0], radius: 1 }, placement: rebased.placement });
    expect(center.map((value, axis) => value - rebased.cameraOffset[axis])).toEqual([9, 0, 0]);
    expect(() => preserveSourceTransitionAnchor({
      priorBase: { center: [0, 0, 0], radius: Number.MAX_VALUE },
      priorPlacement: { translation: [9, 0, 0], rotation: [0, 0, 0], scale: 1 }, priorCameraScale: 1,
      nextBase: { center: [-2000000, 0, 0], radius: 1 },
    })).toThrow(/position/);
  });
});

// 0.1.22 saved scenes permit scales down to 1e-6, including 0.005.
it.each([1e-6, .005, .01, 8, 100])('preserves explored scale %s and distant translation through a source swap', scale => {
  const base={center:[10,0,0],radius:40}, nextBase={center:[-100,20,0],radius:80};
  const placement={translation:[12,-20,30],rotation:[12,24,-36],scale};
  const next=preserveSourceTransitionAnchor({priorBase:base,priorPlacement:placement,priorCameraScale:.01,nextBase});
  expect(next.cameraOffset).toBeUndefined();
  expect(next.placement.scale).toBeGreaterThanOrEqual(1e-6);
  expect(next.placement.scale).toBe(Math.max(1e-6, scale / 2));
  expect(next.placement.scale * next.cameraScale).toBeCloseTo(scale / 2 * .01, 12);
  const moved = transformedVisibleCenter({base:nextBase,placement:next.placement}).map(v=>v*next.cameraScale);
  const original = transformedVisibleCenter({base,placement}).map(v=>v*.01);
  moved.forEach((v,i)=>expect(v).toBeCloseTo(original[i], 12));
});
