/**
 * Mouse / head parallax as an asymmetric (off-axis) frustum.
 *
 * Generalised off-axis perspective after Kooima, "Generalized Perspective
 * Projection" (2008, LSU CCT technical report).
 *
 * Model
 * -----
 * The viewport is treated as a fixed window on the display. The viewer's eye
 * sits D screen-widths in front of the screen, displaced (ex, ey) from the
 * window centre, where ex, ey are measured in screen-widths. The projection
 * frustum is the pyramid whose apex is the eye and whose edges graze the four
 * window corners; evaluated at the near plane (distance `near` in front of
 * the eye) its bounds are (Kooima §2):
 *
 *     l = -hw + dx    r = +hw + dx        dx = -(ex / D) · near
 *     b = -hh + dy    t = +hh + dy        dy = -(ey / D) · near
 *
 * where hh = near·tan(fov/2) is the symmetric half-height and
 * hw = hh·aspect the symmetric half-width. Note the offsets scale with
 * `near`, so the raw bounds feed Mol*'s `Mat4.perspective(out, l, r, t, b,
 * near, far)` directly (Mol* computes asymmetric frustums exactly this way;
 * `uIsAsymmetricProjection` then propagates to the shaders).
 *
 * SIGN CONVENTION — read this before wiring anything up
 * -----------------------------------------------------
 *
 *      top view (screen seen edge-on)          x → viewer's right
 *                                              z → into the screen
 *
 *                    window (fixed to display, half-width hw_world)
 *                 ┌───────────────────────────────────────────┐
 *                 │                ▼ centre (x = 0)           │   z = 0
 *                 └───────────────────────────────────────────┘
 *                       ▲ the object's LEFT flank is revealed here
 *      eye ●───────────────────────────────────────────────────►  axis
 *    (eyeX < 0)                    frustum apex = the eye
 *
 *  · eyeXScreenWidths < 0  ⇒  head is LEFT of the window centre.
 *  · The frustum apex (the virtual eye) sits LEFT of the window centre, so
 *    the rendered perspective is the view from the left: the object's LEFT
 *    side becomes visible.
 *  · Scene content slides LEFT on screen by the same stroke: the image of a
 *    point at world x_p on the screen plane is x_img = xe·zp/(D·w + zp) —
 *    same sign as the head displacement (window metaphor: sidestep right and
 *    the scene outside the frame slides right with you).
 *  · In code: ex < 0 ⇒ dx = -(ex/D)·near > 0 ⇒ the bounds [l, r] shift
 *    toward +x, skewX = dx/hw > 0, and the matrix term m02 > 0.
 *  · eyeYScreenWidths > 0 means the head is ABOVE the centre (y-up, like
 *    three.js world space, NOT like screen pixel coordinates).
 *
 * Exposed parameters
 * ------------------
 * Both integration routes Mol* / three.js support are exposed:
 *  1. Raw bounds `left/right/top/bottom` → `Mat4.perspective` (Mol*), or
 *     `perspectiveMatrix()` here for a ready column-major 4×4.
 *  2. `viewOffset` → three.js `PerspectiveCamera.setViewOffset(...)`. The
 *     algebra is taken from three.js PerspectiveCamera.updateProjectionMatrix
 *     (matches the three.js implementation):
 *
 *         left += view.offsetX * width / fullWidth;
 *         top  -= view.offsetY * height / fullHeight;
 *         width *= view.width / fullWidth;   // = 1 in our parameters
 *
 *     With fullWidth = width = 2·hw and fullHeight = height = 2·hh (near-plane
 *     units) this reproduces our bounds exactly when offsetX = dx and
 *     offsetY = -dy. Note setViewOffset also sets camera.aspect =
 *     fullWidth/fullHeight = hw/hh, which equals the caller's aspect, so the
 *     camera stays consistent. (three.js runtime behaviour itself is not
 *     exercised in tests — only the algebra is — see the round-trip test.)
 *
 * Displacement is capped at `maxDisplacementScreenWidths` (default 0.25,
 * i.e. a quarter of the panel width off-centre) so an extreme pointer or a
 * tracking glitch cannot push the frustum past the window edges; the clamped
 * booleans in the result let the UI flag it.
 */

export interface ParallaxPose {
  /** Head/pointer displacement from the screen centre; +x = viewer's right, in screen-widths. */
  eyeXScreenWidths: number;
  /** Displacement above the screen centre; +y = up (three.js convention), in screen-widths. Default 0. */
  eyeYScreenWidths?: number;
}

export interface ParallaxCameraOptions {
  /** Vertical field of view in radians (matches CameraSnapshot.fovRad in the @stereo/geometry contract). */
  fovRad: number;
  /** Viewport aspect ratio (width / height) of the single (mono) viewport. */
  aspect: number;
  /** Near-plane distance, world units. */
  near: number;
  /**
   * Viewer distance from the screen in screen-widths. Default 2.0
   * (≈ 60 cm viewing distance on a ≈ 30 cm wide laptop panel). Heuristic:
   * CSS-px density and viewing geometry are unmeasured, so pass a calibrated
   * value when one exists.
   */
  eyeDistanceScreenWidths?: number;
  /** Cap on |eye displacement| in screen-widths. Default 0.25. */
  maxDisplacementScreenWidths?: number;
}

/** three.js PerspectiveCamera.setViewOffset parameters reproducing the same frustum. */
export interface ViewOffsetParams {
  fullWidth: number;
  fullHeight: number;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
}

export interface ParallaxFrustum {
  near: number;
  /** Symmetric half-extents at the near plane (zero-pose frustum). */
  halfHeightAtNear: number;
  halfWidthAtNear: number;
  /** Off-axis bounds at the near plane; feed to Mol* Mat4.perspective. */
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** Raw frustum offsets at the near plane: offsetX = (left+right)/2, offsetY = (top+bottom)/2. */
  offsetX: number;
  offsetY: number;
  /** Projection-matrix skew terms: skewX = m02 = (l+r)/(r-l), skewY = m12 = (t+b)/(t-b). */
  skewX: number;
  skewY: number;
  /** three.js setViewOffset parameters reproducing the same frustum. */
  viewOffset: ViewOffsetParams;
  /** The pose actually used, after capping. */
  pose: { eyeXScreenWidths: number; eyeYScreenWidths: number };
  /** True when the requested displacement exceeded the cap on that axis. */
  clampedX: boolean;
  clampedY: boolean;
}

export const DEFAULT_EYE_DISTANCE_SCREEN_WIDTHS = 2.0;
export const DEFAULT_MAX_DISPLACEMENT_SCREEN_WIDTHS = 0.25;

/** Column-major 4×4 projection matrix (three.js / OpenGL convention). */
export type Mat4 = number[];

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Normalise IEEE −0 to +0 so zero-pose frustums compare equal under Object.is. */
function nnz(v: number): number {
  return v === 0 ? 0 : v;
}

function resolveOptions(options: ParallaxCameraOptions): {
  fovRad: number;
  aspect: number;
  near: number;
  distance: number;
  maxDisp: number;
} {
  const { fovRad, aspect, near } = options;
  if (!(fovRad > 0 && fovRad < Math.PI)) throw new RangeError('fovRad must be in (0, π)');
  if (!(aspect > 0)) throw new RangeError('aspect must be > 0');
  if (!(near > 0)) throw new RangeError('near must be > 0');
  return {
    fovRad,
    aspect,
    near,
    distance: options.eyeDistanceScreenWidths ?? DEFAULT_EYE_DISTANCE_SCREEN_WIDTHS,
    maxDisp: options.maxDisplacementScreenWidths ?? DEFAULT_MAX_DISPLACEMENT_SCREEN_WIDTHS,
  };
}

/**
 * The zero-pose (identity) frustum: a symmetric perspective frustum. This is
 * exactly what the camera should carry when parallax is disabled, so
 * swapping between parallax on/off does not change fov or aspect.
 */
export function symmetricFrustum(options: ParallaxCameraOptions): ParallaxFrustum {
  return parallaxFrustum({ eyeXScreenWidths: 0, eyeYScreenWidths: 0 }, options);
}

/**
 * Compute the off-axis frustum for the given eye pose.
 *
 * Returns the raw near-plane bounds (for Mol* Mat4.perspective), the skew
 * terms (projection-matrix m02 / m12), the setViewOffset-style parameters,
 * and the clamped pose actually used.
 */
export function parallaxFrustum(
  pose: ParallaxPose,
  options: ParallaxCameraOptions,
): ParallaxFrustum {
  const { fovRad, aspect, near, distance, maxDisp } = resolveOptions(options);

  const rawX = pose.eyeXScreenWidths;
  const rawY = pose.eyeYScreenWidths ?? 0;
  const ex = clamp(rawX, -maxDisp, maxDisp);
  const ey = clamp(rawY, -maxDisp, maxDisp);

  const halfHeightAtNear = near * Math.tan(fovRad / 2);
  const halfWidthAtNear = halfHeightAtNear * aspect;

  // Kooima offsets. Sign: head left (ex < 0) ⇒ dx > 0 ⇒ apex left of the
  // window centre ⇒ the object's left side is revealed (see module header).
  const dx = nnz(-(ex / distance) * near);
  const dy = nnz(-(ey / distance) * near);

  const left = -halfWidthAtNear + dx;
  const right = halfWidthAtNear + dx;
  const top = halfHeightAtNear + dy;
  const bottom = -halfHeightAtNear + dy;

  const skewX = dx / halfWidthAtNear;
  const skewY = dy / halfHeightAtNear;

  return {
    near,
    halfHeightAtNear,
    halfWidthAtNear,
    left,
    right,
    top,
    bottom,
    offsetX: dx,
    offsetY: dy,
    skewX,
    skewY,
    viewOffset: {
      fullWidth: 2 * halfWidthAtNear,
      fullHeight: 2 * halfHeightAtNear,
      offsetX: dx,
      offsetY: -dy,
      width: 2 * halfWidthAtNear,
      height: 2 * halfHeightAtNear,
    },
    pose: { eyeXScreenWidths: ex, eyeYScreenWidths: ey },
    clampedX: rawX !== ex,
    clampedY: rawY !== ey,
  };
}

/**
 * Column-major 4×4 perspective projection matrix (three.js Matrix4 /
 * OpenGL glFrustum convention) for the given frustum bounds. Column-major
 * element order matches three.js Matrix4.elements, so m02 lives at index 8
 * and m12 at index 9 — these are exactly `skewX` and `skewY`.
 */
export function perspectiveMatrix(
  f: Pick<ParallaxFrustum, 'left' | 'right' | 'top' | 'bottom' | 'near'>,
  far: number,
): Mat4 {
  if (!(far > f.near)) throw new RangeError('far must be > near');
  const { left: l, right: r, top: t, bottom: b, near: n } = f;
  // prettier-ignore
  return [
    2 * n / (r - l), 0, 0, 0,
    0, 2 * n / (t - b), 0, 0,
    (r + l) / (r - l), (t + b) / (t - b), -(far + n) / (far - n), -1,
    0, 0, -(2 * far * n) / (far - n), 0,
  ];
}

/**
 * Project a camera-space point (x, y, z; camera looks down −z) through the
 * matrix and return NDC coordinates. Test helper with production value: the
 * sign checks in test/parallax.test.ts ride on this.
 */
export function projectToNdc(m: Mat4, x: number, y: number, z: number): {
  ndcX: number;
  ndcY: number;
} {
  // Column-major: m00 = m[0], m02 (skewX) = m[8]; m11 = m[5], m12 (skewY) = m[9];
  // clip.w = m[11]·z = −z, positive for visible points (camera looks down −z).
  const cx = m[0] * x + m[8] * z;
  const cy = m[5] * y + m[9] * z;
  const cw = m[11] * z;
  return { ndcX: cx / cw, ndcY: cy / cw };
}

export interface PointerParallaxOptions {
  /**
   * Pointer displacement at the screen edge, in screen-widths. Default 0.5:
   * the cursor at the viewport edge is treated as an eye at the panel edge.
   */
  edgeScreenWidths?: number;
}

/**
 * Map a pointer position in NDC ([−1, 1] × [−1, 1], y-up, e.g. from a
 * pointermove event normalised against the viewport) to a ParallaxPose in
 * screen-widths. This is the zero-permission fallback driver: the frustum
 * follows the pointer exactly as it would follow a tracked head.
 */
export function pointerToPose(
  pointerNdcX: number,
  pointerNdcY: number,
  options?: PointerParallaxOptions,
): ParallaxPose {
  const edge = options?.edgeScreenWidths ?? 0.5;
  return {
    eyeXScreenWidths: pointerNdcX * edge,
    eyeYScreenWidths: pointerNdcY * edge,
  };
}
