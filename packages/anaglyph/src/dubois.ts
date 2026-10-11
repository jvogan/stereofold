import {
  anaglyphPair,
  mulMat3,
  type GlassesKind,
  type Variant,
} from './matrices';
import {
  clampRgb,
  linearToSrgb,
  rec709Weights,
  srgbToLinear,
  type RGB,
  type RGBM,
} from './srgb';

export interface CompositeOptions {
  glasses?: GlassesKind;
  swapEyes?: boolean;
  /** Default `'balanced'`. Pass `'dubois'` for the least-squares colour variant. */
  variant?: Variant;
}

export interface EyeChannelLuma {
  left: number;
  right: number;
  residualPercent: number;
}

/** Forced dark ground (`#020506`), chosen so neither filter group lifts off black. */
export const ANAGLYPH_GROUND_HEX = '#020506';
export const ANAGLYPH_GROUND_SRGB: RGB = [0x02 / 255, 0x05 / 255, 0x06 / 255];

export function compositeLinear(
  leftLinear: RGB,
  rightLinear: RGB,
  options: CompositeOptions = {},
): RGBM {
  const glasses = options.glasses ?? 'red-cyan';
  const variant = options.variant ?? 'balanced';
  const swap = options.swapEyes === true;
  const pair = anaglyphPair(glasses, variant);
  const left = swap ? rightLinear : leftLinear;
  const right = swap ? leftLinear : rightLinear;
  const l = mulMat3(pair.left, left);
  const r = mulMat3(pair.right, right);
  return clampRgb([l[0] + r[0], l[1] + r[1], l[2] + r[2]]);
}

export function compositeSrgb(
  leftSrgb: RGB,
  rightSrgb: RGB,
  options: CompositeOptions = {},
): RGBM {
  const linear = compositeLinear(srgbToLinear(leftSrgb), srgbToLinear(rightSrgb), options);
  return linearToSrgb(linear);
}

/** Literal workshop metric: unnormalised linear Rec.709 luma of two emitted channels. */
export function filterChannelLuma(leftFilter: RGB, rightFilter: RGB): EyeChannelLuma {
  const left = rec709Weights()[0] * leftFilter[0]
    + rec709Weights()[1] * leftFilter[1]
    + rec709Weights()[2] * leftFilter[2];
  const right = rec709Weights()[0] * rightFilter[0]
    + rec709Weights()[1] * rightFilter[1]
    + rec709Weights()[2] * rightFilter[2];
  const mean = (left + right) / 2;
  const residualPercent = mean < 1e-12 ? 0 : (Math.abs(left - right) / mean) * 100;
  return { left, right, residualPercent };
}

/**
 * Rec.709 luma of the emitted filter-channel contributions in a composited
 * pixel. No white normalisation is applied. For red-cyan, for example, the
 * red contribution is `[R, 0, 0]` and the cyan contribution is `[0, G, B]`.
 *
 * Balanced L = R fields match to numerical noise. Dubois matrix cross-talk
 * leaves a residual near 115 %; that is reported, not hidden by normalisation.
 */
export function eyeChannelLuma(
  compositeLinearRgb: RGB,
  glasses: GlassesKind = 'red-cyan',
): EyeChannelLuma {
  const [r, g, b] = compositeLinearRgb;
  switch (glasses) {
    case 'red-cyan': {
      return filterChannelLuma([r, 0, 0], [0, g, b]);
    }
    case 'green-magenta': {
      return filterChannelLuma([0, g, 0], [r, 0, b]);
    }
    case 'amber-blue': {
      return filterChannelLuma([r, g, 0], [0, 0, b]);
    }
  }
}

export type RgbaArray = Float32Array | Uint8Array | Uint8ClampedArray;

function pixelCount(data: RgbaArray): number {
  if (data.length % 4 !== 0) {
    throw new Error(`RGBA buffer length ${data.length} is not a multiple of 4`);
  }
  return data.length / 4;
}

function readSrgb(data: RgbaArray, i: number): RGBM {
  if (data instanceof Float32Array) {
    return [data[i], data[i + 1], data[i + 2]];
  }
  return [data[i] / 255, data[i + 1] / 255, data[i + 2] / 255];
}

function writeSrgb(data: RgbaArray, i: number, rgb: RGB, alpha: number): void {
  if (data instanceof Float32Array) {
    data[i] = rgb[0];
    data[i + 1] = rgb[1];
    data[i + 2] = rgb[2];
    data[i + 3] = alpha;
    return;
  }
  data[i] = Math.round(rgb[0] * 255);
  data[i + 1] = Math.round(rgb[1] * 255);
  data[i + 2] = Math.round(rgb[2] * 255);
  data[i + 3] = Math.round(alpha * 255);
}

/**
 * Composite two packed RGBA buffers (row-major, 4 samples per pixel).
 * Uint8 values are sRGB 0–255. Float32 values are sRGB 0–1.
 * Output alpha is 1.
 */
export function compositeRgba(
  left: RgbaArray,
  right: RgbaArray,
  out: RgbaArray,
  options: CompositeOptions = {},
): void {
  const n = pixelCount(left);
  if (pixelCount(right) !== n) {
    throw new Error(`left (${left.length}) and right (${right.length}) lengths differ`);
  }
  if (pixelCount(out) !== n) {
    throw new Error(`out length ${out.length} does not match inputs`);
  }
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    const encoded = compositeSrgb(readSrgb(left, i), readSrgb(right, i), options);
    writeSrgb(out, i, encoded, 1);
  }
}

export function fillRgba(data: RgbaArray, rgb: RGB, alpha = 1): void {
  const n = pixelCount(data);
  for (let p = 0; p < n; p++) {
    writeSrgb(data, p * 4, rgb, alpha);
  }
}
