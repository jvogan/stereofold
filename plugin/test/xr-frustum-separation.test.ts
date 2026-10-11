import { describe, expect, it } from 'vitest';
import { rightFrustumSphereSeparation } from '../scripts/xr-frustum-separation.js';

const projection = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1.02, -1, 0, 0, -.202, 0];
describe('full-instance right-frustum separation', () => {
  it('requires the whole sphere to cross the boundary, not just its center', () => {
    const at = (x: number) => rightFrustumSphereSeparation([{ center: [x, 0, -2], radius: .5 }], projection);
    expect(at(2.1).minimumRightPlaneMargin).toBeLessThan(0);
    expect(at(2 + Math.SQRT1_2).minimumRightPlaneMargin).toBeCloseTo(0, 12);
    expect(at(3).minimumRightPlaneMargin).toBeGreaterThan(0);
    expect(at(3).nearestDepthMeters).toBe(1.5);
  });
  it('rejects a crossing triangle even when all three vertices lie outside the frustum', () => {
    // (-2,0,-1), (2,0,-1), (0,2,-1) are individually outside, yet their
    // triangle covers the image center. Its enclosing sphere cannot pass.
    const evidence = rightFrustumSphereSeparation([{ center: [0, .5, -1], radius: 2.1 }], projection);
    expect(evidence.minimumRightPlaneMargin).toBeLessThan(0);
  });
  it('requires every instance and handles an asymmetric eye projection', () => {
    const shifted = [...projection]; shifted[8] = .3;
    const far = { center: [4, 0, -2], radius: .2 };
    expect(rightFrustumSphereSeparation([far], shifted).minimumRightPlaneMargin).toBeGreaterThan(0);
    expect(rightFrustumSphereSeparation([far, { center: [0, 0, -2], radius: .2 }], shifted)
      .minimumRightPlaneMargin).toBeLessThan(0);
  });
  it('fails closed for empty, missing, or nonfinite bounds', () => {
    expect(() => rightFrustumSphereSeparation([], projection)).toThrow();
    expect(() => rightFrustumSphereSeparation([{ center: [4, 0, -2], radius: NaN }], projection)).toThrow();
    expect(() => rightFrustumSphereSeparation([{ center: [Infinity, 0, -2], radius: 1 }], projection)).toThrow();
    expect(() => rightFrustumSphereSeparation([{ center: [4, 0, -2], radius: 1 }], [])).toThrow();
  });
});
