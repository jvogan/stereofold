import { describe, expect, it } from 'vitest';
import { Camera } from 'molstar/lib/mol-canvas3d/camera.js';
import { Viewport } from 'molstar/lib/mol-canvas3d/camera/util.js';
import { Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { deriveStereoParams } from '@stereo/geometry';
import { cssPxToMillimetres, measureCssDensity, snapshotFromMolstar } from '../src/viewer-adapter.js';

describe('viewer adapter CSS density contract', () => {
  it('does not multiply a CSS-inch probe by DPR', () => {
    const probe = {
      style: { cssText: '' },
      getBoundingClientRect: () => ({ width: 96 }),
      remove: () => undefined,
    };
    const reading = measureCssDensity({
      createElement: () => probe,
      body: { append: () => undefined },
    });
    expect(reading).toEqual({ cssPxPerInch: 96, estimated: true });
  });

  it('keeps derived baseline, cap, and millimetres invariant at DPR 1 and 2', () => {
    const camera = new Camera({
      position: Vec3.create(0, 0, 65),
      target: Vec3.create(0, 0, 0),
      up: Vec3.create(0, 1, 0),
      radius: 20,
      radiusMax: 20,
      minNear: 1,
      fov: Math.PI / 4,
      mode: 'perspective',
    }, Viewport.create(0, 0, 800, 800));
    camera.update();
    const snapshot = snapshotFromMolstar(camera, { center: [0, 0, 0], radius: 20 }, 800, 800);
    const common = {
      mode: 'parallel' as const,
      swapEyes: false,
      depthBudgetArcmin: 20,
      viewingDistanceMm: 500,
      cssPxPerInch: 110,
    };
    const dpr1 = deriveStereoParams(snapshot, { ...common, devicePixelRatio: 1 });
    const dpr2 = deriveStereoParams(snapshot, { ...common, devicePixelRatio: 2 });
    expect(dpr2.eyeSeparation).toBe(dpr1.eyeSeparation);
    expect(dpr2.halfWidthCapPx).toBe(dpr1.halfWidthCapPx);
    expect(cssPxToMillimetres(dpr2.halfWidthCapPx ?? 0, 110)).toBeCloseTo(63, 12);
    expect(snapshot.boundingDepthNear).toBe(45);
    expect(snapshot.boundingDepthFar).toBe(85);
  });
});
