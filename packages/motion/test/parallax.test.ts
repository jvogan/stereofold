import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EYE_DISTANCE_SCREEN_WIDTHS,
  DEFAULT_MAX_DISPLACEMENT_SCREEN_WIDTHS,
  parallaxFrustum,
  perspectiveMatrix,
  pointerToPose,
  projectToNdc,
  symmetricFrustum,
  type ParallaxCameraOptions,
} from '../src/parallax.js';

const CAM: ParallaxCameraOptions = {
  fovRad: (45 * Math.PI) / 180,
  aspect: 1.5,
  near: 0.1,
};
const FAR = 100;

describe('zero input → identity projection', () => {
  it('zero pose reproduces the symmetric perspective frustum exactly', () => {
    const f = symmetricFrustum(CAM);
    const hh = 0.1 * Math.tan(Math.PI / 8);
    const hw = hh * 1.5;
    expect(f.halfHeightAtNear).toBeCloseTo(hh, 15);
    expect(f.halfWidthAtNear).toBeCloseTo(hw, 15);
    expect(f.left).toBeCloseTo(-hw, 15);
    expect(f.right).toBeCloseTo(hw, 15);
    expect(f.top).toBeCloseTo(hh, 15);
    expect(f.bottom).toBeCloseTo(-hh, 15);
    expect(f.offsetX).toBe(0);
    expect(f.offsetY).toBe(0);
    expect(f.skewX).toBe(0);
    expect(f.skewY).toBe(0);
    expect(f.clampedX).toBe(false);
    expect(f.clampedY).toBe(false);
  });

  it('zero-pose matrix equals the textbook OpenGL perspective matrix', () => {
    const f = symmetricFrustum(CAM);
    const m = perspectiveMatrix(f, FAR);
    const { left: l, right: r, top: t, bottom: b, near: n } = f;
    const expected = [
      (2 * n) / (r - l), 0, 0, 0,
      0, (2 * n) / (t - b), 0, 0,
      0, 0, -(FAR + n) / (FAR - n), -1,
      0, 0, -(2 * FAR * n) / (FAR - n), 0,
    ];
    expect(m).toEqual(expected);
  });

  it('projects the view axis to the exact screen centre at zero pose', () => {
    const m = perspectiveMatrix(symmetricFrustum(CAM), FAR);
    const { ndcX, ndcY } = projectToNdc(m, 0, 0, -10);
    expect(ndcX).toBeCloseTo(0, 12);
    expect(ndcY).toBeCloseTo(0, 12);
  });
});

describe('parallax sign convention (module-header diagram)', () => {
  it('head LEFT (eyeX < 0) shifts the frustum bounds toward +x: dx > 0, skewX > 0, m02 > 0', () => {
    const f = parallaxFrustum({ eyeXScreenWidths: -0.2 }, CAM);
    expect(f.offsetX).toBeGreaterThan(0);
    expect(f.skewX).toBeGreaterThan(0);
    const m = perspectiveMatrix(f, FAR);
    expect(m[8]).toBeCloseTo(f.skewX, 15); // m02 === skewX
  });

  it('the virtual eye (frustum apex) sits on the same side as the head: ex ≈ -skewX·tan(fov/2)·aspect·D', () => {
    const D = 2.0;
    const f = parallaxFrustum({ eyeXScreenWidths: -0.2, eyeYScreenWidths: 0.1 }, {
      ...CAM,
      eyeDistanceScreenWidths: D,
    });
    // skewX = dx/hw with hw = n·tan(fov/2)·aspect and dx = -(ex/D)·n, so the
    // horizontal head displacement recovers as -skewX·tan(fov/2)·aspect·D.
    // Vertically there is no aspect term: skewY = dy/hh, hh = n·tan(fov/2).
    const recoveredX = -f.skewX * Math.tan(CAM.fovRad / 2) * CAM.aspect * D;
    const recoveredY = -f.skewY * Math.tan(CAM.fovRad / 2) * D;
    expect(recoveredX).toBeCloseTo(-0.2, 12);
    expect(recoveredY).toBeCloseTo(0.1, 12);
  });

  it('head left moves scene content LEFT on screen (window metaphor), revealing the object’s left side', () => {
    // A point on the view axis at depth 10 world units.
    const centre = projectToNdc(perspectiveMatrix(symmetricFrustum(CAM), FAR), 0, 0, -10);
    const left_ = projectToNdc(
      perspectiveMatrix(parallaxFrustum({ eyeXScreenWidths: -0.2 }, CAM), FAR),
      0, 0, -10,
    );
    const right_ = projectToNdc(
      perspectiveMatrix(parallaxFrustum({ eyeXScreenWidths: +0.2 }, CAM), FAR),
      0, 0, -10,
    );
    expect(left_.ndcX).toBeLessThan(centre.ndcX); // head left → content left
    expect(right_.ndcX).toBeGreaterThan(centre.ndcX); // head right → content right
    // Vertical: head up moves content up.
    const up = projectToNdc(
      perspectiveMatrix(parallaxFrustum({ eyeXScreenWidths: 0, eyeYScreenWidths: 0.2 }, CAM), FAR),
      0, 0, -10,
    );
    expect(up.ndcY).toBeGreaterThan(centre.ndcY);
  });

  it('content shift magnitude grows linearly with head displacement near the centre', () => {
    const shift = (ex: number): number => {
      const m = perspectiveMatrix(parallaxFrustum({ eyeXScreenWidths: ex }, CAM), FAR);
      return projectToNdc(m, 0, 0, -10).ndcX;
    };
    const small = shift(0.1) - shift(0);
    const large = shift(0.2) - shift(0);
    expect(large).toBeCloseTo(2 * small, 9);
    expect(small).toBeGreaterThan(0); // head right (ex > 0) → content right
  });
});

describe('mirror symmetry', () => {
  it('mirrored pose yields exactly mirrored bounds and negated skew', () => {
    const a = parallaxFrustum({ eyeXScreenWidths: 0.2, eyeYScreenWidths: 0.1 }, CAM);
    const b = parallaxFrustum({ eyeXScreenWidths: -0.2, eyeYScreenWidths: -0.1 }, CAM);
    expect(b.left).toBeCloseTo(-a.right, 12);
    expect(b.right).toBeCloseTo(-a.left, 12);
    expect(b.top).toBeCloseTo(-a.bottom, 12);
    expect(b.bottom).toBeCloseTo(-a.top, 12);
    expect(b.offsetX).toBeCloseTo(-a.offsetX, 12);
    expect(b.offsetY).toBeCloseTo(-a.offsetY, 12);
    expect(b.skewX).toBeCloseTo(-a.skewX, 12);
    expect(b.skewY).toBeCloseTo(-a.skewY, 12);
    const ma = perspectiveMatrix(a, FAR);
    const mb = perspectiveMatrix(b, FAR);
    expect(mb[8]).toBeCloseTo(-ma[8], 12); // m02 mirrors
    expect(mb[9]).toBeCloseTo(-ma[9], 12); // m12 mirrors
    // The symmetric terms (m00, m05, depth row) are untouched.
    expect(mb[0]).toBeCloseTo(ma[0], 12);
    expect(mb[5]).toBeCloseTo(ma[5], 12);
    expect(mb[10]).toBeCloseTo(ma[10], 12);
  });

  it('mirror test: zero-disparity plane stays at the window centre for mirrored inputs', () => {
    // The window-corner rays are the frustum edges by construction; mirroring
    // the pose must keep each corner ray's |slope| identical.
    const a = parallaxFrustum({ eyeXScreenWidths: 0.25, eyeYScreenWidths: 0.25 }, CAM);
    const b = parallaxFrustum({ eyeXScreenWidths: -0.25, eyeYScreenWidths: -0.25 }, CAM);
    expect(a.right - a.left).toBeCloseTo(b.right - b.left, 12);
    expect(a.top - a.bottom).toBeCloseTo(b.top - b.bottom, 12);
  });
});

describe('displacement cap', () => {
  it('caps the pose at maxDisplacementScreenWidths (default 0.25) and flags it', () => {
    const capped = parallaxFrustum({ eyeXScreenWidths: 10, eyeYScreenWidths: -7 }, CAM);
    expect(capped.pose.eyeXScreenWidths).toBe(DEFAULT_MAX_DISPLACEMENT_SCREEN_WIDTHS);
    expect(capped.pose.eyeYScreenWidths).toBe(-DEFAULT_MAX_DISPLACEMENT_SCREEN_WIDTHS);
    expect(capped.clampedX).toBe(true);
    expect(capped.clampedY).toBe(true);
    const atCap = parallaxFrustum(
      { eyeXScreenWidths: DEFAULT_MAX_DISPLACEMENT_SCREEN_WIDTHS },
      CAM,
    );
    expect(capped.left).toBe(atCap.left);
    expect(capped.skewX).toBe(atCap.skewX);
  });

  it('cap can be configured, and poses inside it are never flagged', () => {
    const f = parallaxFrustum({ eyeXScreenWidths: 0.5 }, { ...CAM, maxDisplacementScreenWidths: 0.5 });
    expect(f.clampedX).toBe(false);
    expect(f.pose.eyeXScreenWidths).toBeCloseTo(0.5, 15);
  });
});

describe('three.js setViewOffset round-trip (algebra verified against three.js source)', () => {
  it('viewOffset parameters reproduce the off-axis bounds via the three.js updateProjectionMatrix algebra', () => {
    const f = parallaxFrustum({ eyeXScreenWidths: -0.15, eyeYScreenWidths: 0.2 }, CAM);
    const v = f.viewOffset;
    // three.js PerspectiveCamera.updateProjectionMatrix with zoom = 1:
    //   top = near·tan(fov/2); height = 2·top; width = aspect·height;
    //   left = −0.5·width;
    //   left += view.offsetX * width / fullWidth;
    //   top  −= view.offsetY * height / fullHeight;
    //   width *= view.width / fullWidth;  height *= view.height / fullHeight;
    //   makePerspective(left, left+width, top, top−height, near, far)
    let top = f.near * Math.tan(CAM.fovRad / 2);
    let height = 2 * top;
    let width = CAM.aspect * height;
    let left = -0.5 * width;
    left += (v.offsetX * width) / v.fullWidth;
    top -= (v.offsetY * height) / v.fullHeight;
    width *= v.width / v.fullWidth;
    height *= v.height / v.fullHeight;
    expect(left).toBeCloseTo(f.left, 12);
    expect(left + width).toBeCloseTo(f.right, 12);
    expect(top).toBeCloseTo(f.top, 12);
    expect(top - height).toBeCloseTo(f.bottom, 12);
    // aspect is preserved: fullWidth/fullHeight === caller aspect
    expect(v.fullWidth / v.fullHeight).toBeCloseTo(CAM.aspect, 12);
  });
});

describe('geometry invariants', () => {
  it('offsets scale linearly with near (bounds are near-plane units)', () => {
    const a = parallaxFrustum({ eyeXScreenWidths: 0.2 }, { ...CAM, near: 0.1 });
    const b = parallaxFrustum({ eyeXScreenWidths: 0.2 }, { ...CAM, near: 0.2 });
    expect(b.offsetX).toBeCloseTo(2 * a.offsetX, 12);
    expect(b.offsetY).toBeCloseTo(2 * a.offsetY, 12);
    // Skew terms are near-independent.
    expect(b.skewX).toBeCloseTo(a.skewX, 12);
    expect(b.skewY).toBeCloseTo(a.skewY, 12);
  });

  it('offset magnitude is (|pose|/D)·near — doubling viewer distance halves the parallax', () => {
    const near = parallaxFrustum({ eyeXScreenWidths: 0.2 }, { ...CAM, eyeDistanceScreenWidths: 2 });
    const far = parallaxFrustum({ eyeXScreenWidths: 0.2 }, { ...CAM, eyeDistanceScreenWidths: 4 });
    expect(far.offsetX).toBeCloseTo(near.offsetX / 2, 12);
    // dx = -(ex/D)·near: negative for a head-right pose.
    expect(far.offsetX).toBeCloseTo(-(0.2 / 4) * CAM.near, 12);
  });

  it('defaults are documented values', () => {
    expect(DEFAULT_EYE_DISTANCE_SCREEN_WIDTHS).toBe(2.0);
    expect(DEFAULT_MAX_DISPLACEMENT_SCREEN_WIDTHS).toBe(0.25);
  });

  it('rejects out-of-range camera options', () => {
    expect(() => parallaxFrustum({ eyeXScreenWidths: 0 }, { ...CAM, near: 0 })).toThrow(RangeError);
    expect(() => parallaxFrustum({ eyeXScreenWidths: 0 }, { ...CAM, aspect: 0 })).toThrow(RangeError);
    expect(() => parallaxFrustum({ eyeXScreenWidths: 0 }, { ...CAM, fovRad: 4 })).toThrow(RangeError);
  });
});

describe('pointer mapping (mouse-parallax fallback driver)', () => {
  it('maps NDC pointer coordinates to poses: edge of viewport = half a screen-width', () => {
    expect(pointerToPose(1, -1)).toEqual({ eyeXScreenWidths: 0.5, eyeYScreenWidths: -0.5 });
    expect(pointerToPose(0, 0)).toEqual({ eyeXScreenWidths: 0, eyeYScreenWidths: 0 });
  });

  it('pointer at the right edge produces the head-right frustum (content right)', () => {
    const pose = pointerToPose(1, 0);
    const f = parallaxFrustum(pose, CAM);
    const m = perspectiveMatrix(f, FAR);
    expect(projectToNdc(m, 0, 0, -10).ndcX).toBeGreaterThan(0);
  });
});
