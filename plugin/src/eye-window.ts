/**
 * The eye window: how wide one eye's view is, and how far the camera has to be
 * to frame the structure inside it.
 *
 * These three functions are the whole geometric content of the viewer's
 * side-by-side letterbox and its automatic fit. They live outside `viewer.ts`
 * because the fit has to agree with the cap in every host geometry, and the
 * only way to state that as a test is to have the arithmetic separated from
 * the DOM it reads.
 */

/**
 * Even CSS width of the side-by-side canvas once the interocular cap applies.
 *
 * Two constraints, in order. The interocular cap (`halfCapPx`, 63 mm of one
 * eye) is what makes the pair free-fusable at all, so the canvas is never
 * wider than twice it. The letterbox is a hard container, so the canvas is
 * never wider than that either. The result is forced even because Mol* splits
 * a stereo viewport with `Math.floor(width / 2)` and hands the leftover column
 * to the right eye, which would otherwise rasterise the two eyes at different
 * horizontal scales.
 */
export function sideBySideCanvasWidthPx(halfCapPx: number | null, availablePx: number): number {
  const available = Math.max(0, Math.floor(availablePx));
  if (halfCapPx == null) return available;
  return Math.max(2, Math.min(Math.floor(halfCapPx) * 2, available) & ~1);
}

export interface EyeViewportInput {
  /** Current measured stage box, which may not yet carry the cap. */
  stageWidthPx: number;
  stageHeightPx: number;
  /** Letterbox width the cap is applied inside. */
  availableWidthPx: number;
  sideBySide: boolean;
  halfCapPx: number | null;
}

/**
 * CSS size of one eye's viewport.
 *
 * It takes the *narrower* of the measured stage and the width the cap will
 * force, rather than trusting the measured box. The cap is written to
 * `stage.style.maxWidth` by the readout pass, so on the first frame after a
 * mode switch, a host resize, or a dock the measured stage can still be the
 * uncapped width — 720 CSS px where the cap allows 476. A fit computed from
 * that box frames the structure for a 360 px eye and then renders it into a
 * 238 px one, which clips it. Taking the minimum makes the fit independent of
 * whether the style has landed yet.
 */
export function eyeViewportFromStage(input: EyeViewportInput): { width: number; height: number } {
  const capped = input.sideBySide
    ? Math.min(input.stageWidthPx, sideBySideCanvasWidthPx(input.halfCapPx, input.availableWidthPx))
    : input.stageWidthPx;
  return {
    width: Math.max(1, input.sideBySide ? capped / 2 : capped),
    height: Math.max(1, input.stageHeightPx),
  };
}

export interface FitInput {
  radius: number;
  eyeWidthPx: number;
  eyeHeightPx: number;
  fovRad: number;
  fillFraction: number;
}

/**
 * Camera distance that frames a sphere of `radius` inside one eye viewport.
 *
 * Solves for the distance at which the sphere's angular radius
 * `asin(radius / distance)` projects to `fillFraction / 2` of the eye
 * viewport's shorter side, measured against the same vertical field of view
 * the projection uses. Returns `undefined` for any input that has no framing,
 * so the caller leaves the camera alone rather than writing a NaN pose.
 */
export function fitDistanceForEyeViewport(input: FitInput): number | undefined {
  if (!(input.radius > 0) || !(input.eyeWidthPx > 0) || !(input.eyeHeightPx > 0)) return undefined;
  if (!(input.fovRad > 0) || !(input.fovRad < Math.PI)) return undefined;
  const shorterPx = Math.min(input.eyeWidthPx, input.eyeHeightPx);
  const wantedAngle = Math.atan(
    (Math.tan(input.fovRad / 2) * input.fillFraction * shorterPx) / input.eyeHeightPx,
  );
  if (!(wantedAngle > 0)) return undefined;
  const distance = input.radius / Math.sin(wantedAngle);
  return Number.isFinite(distance) && distance > 0 ? distance : undefined;
}
