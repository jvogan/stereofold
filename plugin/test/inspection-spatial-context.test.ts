import { describe, expect, it } from 'vitest';
import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
// @ts-ignore Shared browser math is tested without a headset runtime.
import { relativeHeadContext } from '../../lab/browser-roundtrip/inspection-spatial-context.mjs';

describe('scene-relative headset context', () => {
  it('reports radius units and head direction rather than room coordinates', () => {
    const headMatrix = Mat4.fromTranslation(Mat4(), Vec3.create(0, 0, .5));
    expect(relativeHeadContext({ mode: 'immersive-vr', headMatrix, cameraScale: .01,
      moleculeTransform: Mat4.identity(), center: [0, 0, 0], radius: 10 })).toEqual({
      mode: 'immersive-vr', headPosition: [0, 0, 5], viewDirection: [0, 0, -1], distance: 5,
    });
  });

  it('undoes object placement, rotation and scale around an offset molecular center', () => {
    // A source center [10,20,30], translated +20 X, scaled 2 and turned
    // +90° around Y, maps source point [10,20,60] to world [90,20,30].
    const moleculeTransform = Mat4.ofRows([[0,0,2,-30],[0,2,0,-20],[-2,0,0,50],[0,0,0,1]]);
    const headMatrix = Mat4.ofRows([[0,0,1,.9],[0,1,0,.2],[-1,0,0,.3],[0,0,0,1]]);
    const input = { mode: 'immersive-ar', headMatrix, cameraScale: .01, moleculeTransform, center: [10,20,30], radius: 10 };
    const before = structuredClone(input);
    expect(relativeHeadContext(input)).toEqual({ mode: 'immersive-ar', headPosition: [0,0,3], viewDirection: [0,0,-1], distance: 3 });
    expect(input).toEqual(before);
  });

  it('refuses invalid, singular and excessively distant samples', () => {
    const input = { mode: 'immersive-vr', headMatrix: Mat4.identity(), cameraScale: .01,
      moleculeTransform: Mat4.identity(), center: [0,0,0], radius: 10 };
    expect(relativeHeadContext({ ...input, radius: 0 })).toBeNull();
    expect(relativeHeadContext({ ...input, cameraScale: NaN })).toBeNull();
    expect(relativeHeadContext({ ...input, headMatrix: [] })).toBeNull();
    expect(relativeHeadContext({ ...input, moleculeTransform: Mat4.zero() })).toBeNull();
    expect(relativeHeadContext({ ...input, headMatrix: Mat4.fromTranslation(Mat4(), Vec3.create(20,0,0)) })).toBeNull();
  });
});
