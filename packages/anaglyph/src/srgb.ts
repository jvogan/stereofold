/** IEC 61966-2-1 sRGB transfer and Rec.709 luma on linear sRGB primaries. */

export type RGB = readonly [number, number, number];
export type RGBM = [number, number, number];

const SRGB_TO_LINEAR_CUT = 0.04045;
const LINEAR_TO_SRGB_CUT = 0.0031308;
const REC709: RGB = [0.2126, 0.7152, 0.0722];

export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function srgbChannelToLinear(channel: number): number {
  const c = clamp01(channel);
  return c <= SRGB_TO_LINEAR_CUT ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function linearChannelToSrgb(channel: number): number {
  const c = clamp01(channel);
  return c <= LINEAR_TO_SRGB_CUT ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
}

export function srgbToLinear(rgb: RGB): RGBM {
  return [
    srgbChannelToLinear(rgb[0]),
    srgbChannelToLinear(rgb[1]),
    srgbChannelToLinear(rgb[2]),
  ];
}

export function linearToSrgb(rgb: RGB): RGBM {
  return [
    linearChannelToSrgb(rgb[0]),
    linearChannelToSrgb(rgb[1]),
    linearChannelToSrgb(rgb[2]),
  ];
}

export function rec709Luma(linearRgb: RGB): number {
  return REC709[0] * linearRgb[0] + REC709[1] * linearRgb[1] + REC709[2] * linearRgb[2];
}

export function rec709Weights(): RGB {
  return REC709;
}

export function clampRgb(rgb: RGB): RGBM {
  return [clamp01(rgb[0]), clamp01(rgb[1]), clamp01(rgb[2])];
}
