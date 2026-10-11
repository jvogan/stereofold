import { compositeLinear, eyeChannelLuma } from './dubois';
import type { GlassesKind, Variant } from './matrices';
import {
  clamp01,
  linearToSrgb,
  rec709Luma,
  srgbToLinear,
  type RGB,
  type RGBM,
} from './srgb';

export interface PaletteOptions {
  glasses?: GlassesKind;
  variant?: Variant;
  /** Default 0.20 for the palette's internal white-normalised heuristic. */
  maxResidualPercent?: number;
}

const EPS = 1e-12;

function isoluminantDirection(linear: RGB, grayY: number): RGBM {
  const dir: RGBM = [linear[0] - grayY, linear[1] - grayY, linear[2] - grayY];
  const dirY = rec709Luma(dir);
  dir[0] -= dirY;
  dir[1] -= dirY;
  dir[2] -= dirY;
  return dir;
}

function residualAt(
  linear: RGB,
  glasses: GlassesKind,
  variant: Variant,
): number {
  const composite = compositeLinear(linear, linear, { glasses, variant });
  const raw = eyeChannelLuma(composite, glasses);
  const white = eyeChannelLuma([1, 1, 1], glasses);
  const left = raw.left / white.left;
  const right = raw.right / white.right;
  const mean = (left + right) / 2;
  return mean < EPS ? 0 : (Math.abs(left - right) / mean) * 100;
}

function inGamut(linear: RGB): boolean {
  return linear[0] >= -1e-9 && linear[0] <= 1 + 1e-9
    && linear[1] >= -1e-9 && linear[1] <= 1 + 1e-9
    && linear[2] >= -1e-9 && linear[2] <= 1 + 1e-9;
}

/**
 * Map a CPK / chain colour to a luminance-led anaglyph colour.
 *
 * The balanced projector encodes only Rec.709 luma, so isoluminant tint does
 * not survive the composite: this function keeps luma and, for balanced, the
 * largest in-gamut isoluminant tint (a near no-op on the emitted stereo pair).
 *
 * Dubois cannot keep saturated CPK primaries. Identity travels as Rec.709 luma
 * plus the largest isoluminant tint that keeps an internal white-normalised
 * residual ≤ `maxResidualPercent` on L = R. That search is a palette heuristic,
 * not the workshop metric (`eyeChannelLuma`).
 */
export function luminancePalette(
  elementColorRGB: RGB,
  options: PaletteOptions = {},
): RGBM {
  const glasses = options.glasses ?? 'red-cyan';
  const variant = options.variant ?? 'balanced';
  const maxResidual = options.maxResidualPercent ?? 0.2;
  const linear = srgbToLinear(elementColorRGB);
  const y = rec709Luma(linear);
  const gray: RGBM = [y, y, y];

  if (y < EPS) {
    return linearToSrgb(gray);
  }

  const dir = isoluminantDirection(linear, y);
  const norm = Math.hypot(dir[0], dir[1], dir[2]);
  if (norm < EPS) {
    return linearToSrgb(gray);
  }
  dir[0] /= norm;
  dir[1] /= norm;
  dir[2] /= norm;

  let tHi = Infinity;
  for (let c = 0; c < 3; c++) {
    if (Math.abs(dir[c]) < EPS) continue;
    const to0 = -gray[c] / dir[c];
    const to1 = (1 - gray[c]) / dir[c];
    const along = dir[c] > 0 ? to1 : to0;
    if (along > 0) tHi = Math.min(tHi, along);
  }
  if (!Number.isFinite(tHi) || tHi <= 0) {
    return linearToSrgb(gray);
  }

  const sample = (t: number): RGBM => [
    clamp01(gray[0] + t * dir[0]),
    clamp01(gray[1] + t * dir[1]),
    clamp01(gray[2] + t * dir[2]),
  ];

  if (variant === 'balanced') {
    return linearToSrgb(sample(tHi));
  }

  if (residualAt(sample(tHi), glasses, variant) <= maxResidual && inGamut(sample(tHi))) {
    return linearToSrgb(sample(tHi));
  }

  let lo = 0;
  let hi = tHi;
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2;
    if (residualAt(sample(mid), glasses, variant) <= maxResidual) lo = mid;
    else hi = mid;
  }
  return linearToSrgb(sample(lo));
}

/** Common CPK sRGB triples (Jmol / Mol* element colours), 0–1. */
export const CPK_SRGB: Record<string, RGB> = {
  H: [1, 1, 1],
  C: [0.565, 0.565, 0.565],
  N: [0.188, 0.314, 0.973],
  O: [1, 0.051, 0.051],
  S: [0.898, 0.776, 0.235],
  P: [1, 0.502, 0],
  Fe: [0.878, 0.4, 0.2],
};
