/**
 * Anaglyph matrices: luminance-balanced (default) and Dubois least-squares.
 *
 * Pipeline: sRGB → linear RGB, 3×3 × left + 3×3 × right, clamp to [0, 1],
 * linear → sRGB. Each matrix is row-major: row 0 is the red output channel.
 *
 * Balanced pairs emit Rec.709 luma into each filter's channels and scale the
 * two-channel eye so both eyes receive equal Rec.709 luma (workshop residual
 * ≤ 0.25 % on L = R). Dubois is an optional colour variant; it fails that
 * residual by design (~115 %).
 */

import { rec709Weights, type RGB } from './srgb';

export type Mat3 = readonly [RGB, RGB, RGB];

export type GlassesKind = 'red-cyan' | 'green-magenta' | 'amber-blue';

/** Default `'balanced'` satisfies the workshop luma criterion. `'dubois'` does not. */
export type Variant = 'balanced' | 'dubois';

export interface DuboisPair {
  readonly left: Mat3;
  readonly right: Mat3;
}

const ZERO: RGB = [0, 0, 0];

function scaleRgb(rgb: RGB, k: number): RGB {
  return [rgb[0] * k, rgb[1] * k, rgb[2] * k];
}

function lumaWeights(): RGB {
  const w = rec709Weights();
  return [w[0], w[1], w[2]];
}

/**
 * Two-channel / single-channel Rec.709 weight ratios.
 *
 * red-cyan:    k = wR / (wG + wB) = 0.2126 / 0.7874 = 0.27000254
 * green-magenta: k = wG / (wR + wB) = 0.7152 / 0.2848 = 2.51123596
 * amber-blue:  k = wB / (wR + wG) = 0.0722 / 0.9278 = 0.07781850
 *
 * Green-magenta has k > 1, so the literal "single-channel weight 1" pair
 * writes up to 2.511 into R and B. Both matrices are multiplied by 1/k so
 * every in-gamut input stays in [0, 1] and the luma ratio is unchanged.
 */
function balancedK(): { rc: number; gm: number; ab: number } {
  const w = rec709Weights();
  return {
    rc: w[0] / (w[1] + w[2]),
    gm: w[1] / (w[0] + w[2]),
    ab: w[2] / (w[0] + w[1]),
  };
}

const K = balancedK();

export const BALANCED_K_RED_CYAN = K.rc;
export const BALANCED_K_GREEN_MAGENTA = K.gm;
export const BALANCED_K_AMBER_BLUE = K.ab;
/** 1/k for green-magenta; 1 for the other pairs. */
export const BALANCED_GAMUT_SCALE_GREEN_MAGENTA = Math.min(1, 1 / K.gm);

function makeBalancedMatrices(): Record<GlassesKind, DuboisPair> {
  const w = lumaWeights();
  const k = balancedK();
  const gmScale = Math.min(1, 1 / k.gm);
  return {
    'red-cyan': {
      left: [w, ZERO, ZERO],
      right: [ZERO, scaleRgb(w, k.rc), scaleRgb(w, k.rc)],
    },
    'green-magenta': {
      left: [ZERO, scaleRgb(w, gmScale), ZERO],
      right: [scaleRgb(w, gmScale * k.gm), ZERO, scaleRgb(w, gmScale * k.gm)],
    },
    'amber-blue': {
      left: [scaleRgb(w, k.ab), scaleRgb(w, k.ab), ZERO],
      right: [ZERO, ZERO, w],
    },
  };
}

export const BALANCED_MATRICES: Record<GlassesKind, DuboisPair> = makeBalancedMatrices();

/**
 * Red-cyan, CRT / plasma, six-decimal least-squares projection.
 *
 * Sanders and McAllister reconstruct the 3×6 projector of Dubois 2001 from
 * the paper's filter and Sony Trinitron phosphor spectra. Rounded to three
 * decimals this is the "Dubois Anaglyph" example in Dubois's own StereoPhoto
 * Maker screenshots (Flickr SPM_GM_matrix / SPM_YB_matrix, 2010).
 */
export const RED_CYAN_LEFT: Mat3 = [
  [0.456100, 0.500484, 0.176381],
  [-0.040082, -0.037825, -0.015759],
  [-0.015216, -0.020597, -0.005469],
];

export const RED_CYAN_RIGHT: Mat3 = [
  [-0.043471, -0.087939, -0.001555],
  [0.378476, 0.733640, -0.018450],
  [-0.072153, -0.112961, 1.226400],
];

/**
 * Red-cyan, three-decimal CRT/plasma matrices printed in Dubois, March 2009,
 * "Conversion of a Stereo Pair to Anaglyph with the Least-Squares Projection
 * Method" (Photoshop note). That note also says to clip each eye's term to
 * [0, 1] before adding. The compositor uses the six-decimal pair above and
 * clamps the sum, matching the 2001 projection.
 */
export const RED_CYAN_PHOTOSHOP_2009_LEFT: Mat3 = [
  [0.437, 0.449, 0.164],
  [-0.062, -0.062, -0.024],
  [-0.048, -0.050, -0.017],
];

export const RED_CYAN_PHOTOSHOP_2009_RIGHT: Mat3 = [
  [-0.011, -0.032, -0.007],
  [0.377, 0.761, 0.009],
  [-0.026, -0.093, 1.234],
];

/**
 * Green-magenta (TrioScopics), LCD, from Dubois's StereoPhoto Maker screenshot
 * https://www.flickr.com/photos/e_dubois/5132528166/ (SPM_GM_matrix, 2010).
 * Left filter is green; right is magenta. Integer thousandths / 1000.
 */
export const GREEN_MAGENTA_LEFT: Mat3 = [
  [-0.062, -0.158, -0.039],
  [0.284, 0.668, 0.143],
  [-0.015, -0.027, 0.021],
];

export const GREEN_MAGENTA_RIGHT: Mat3 = [
  [0.529, 0.705, 0.024],
  [-0.016, -0.015, -0.065],
  [0.009, 0.075, 0.937],
];

/**
 * Amber-blue (ColorCode 3-D), LCD, from Dubois's StereoPhoto Maker screenshot
 * https://www.flickr.com/photos/e_dubois/5230654930/ (SPM_YB_matrix, 2010).
 * Left filter is amber; right is blue. Integer thousandths / 1000.
 *
 * Dolphin's `dubois-LCD-Amber-Blue.glsl` flips the sign of two right-matrix
 * entries and writes 0.991 for 0.911. This table follows the Flickr screenshot.
 */
export const AMBER_BLUE_LEFT: Mat3 = [
  [1.062, -0.205, 0.299],
  [-0.026, 0.908, 0.068],
  [-0.038, -0.173, 0.022],
];

export const AMBER_BLUE_RIGHT: Mat3 = [
  [-0.016, -0.123, -0.017],
  [0.006, 0.062, -0.017],
  [0.094, 0.185, 0.911],
];

export const DUBOIS_MATRICES: Record<GlassesKind, DuboisPair> = {
  'red-cyan': { left: RED_CYAN_LEFT, right: RED_CYAN_RIGHT },
  'green-magenta': { left: GREEN_MAGENTA_LEFT, right: GREEN_MAGENTA_RIGHT },
  'amber-blue': { left: AMBER_BLUE_LEFT, right: AMBER_BLUE_RIGHT },
};

export function anaglyphPair(glasses: GlassesKind, variant: Variant = 'balanced'): DuboisPair {
  return variant === 'dubois' ? DUBOIS_MATRICES[glasses] : BALANCED_MATRICES[glasses];
}

/** Three-decimal published tables used by the coefficient test. */
export const PUBLISHED_3DP: Record<GlassesKind, DuboisPair> = {
  'red-cyan': {
    left: [
      [0.456, 0.5, 0.176],
      [-0.04, -0.038, -0.016],
      [-0.015, -0.021, -0.005],
    ],
    right: [
      [-0.043, -0.088, -0.002],
      [0.378, 0.734, -0.018],
      [-0.072, -0.113, 1.226],
    ],
  },
  'green-magenta': {
    left: GREEN_MAGENTA_LEFT,
    right: GREEN_MAGENTA_RIGHT,
  },
  'amber-blue': {
    left: AMBER_BLUE_LEFT,
    right: AMBER_BLUE_RIGHT,
  },
};

export function mulMat3(matrix: Mat3, rgb: RGB): [number, number, number] {
  return [
    matrix[0][0] * rgb[0] + matrix[0][1] * rgb[1] + matrix[0][2] * rgb[2],
    matrix[1][0] * rgb[0] + matrix[1][1] * rgb[1] + matrix[1][2] * rgb[2],
    matrix[2][0] * rgb[0] + matrix[2][1] * rgb[1] + matrix[2][2] * rgb[2],
  ];
}

/** Column-major 9-vector for `uniformMatrix3fv(..., false, ...)` and GLSL `mat3`. */
export function mat3ColumnMajor(matrix: Mat3): Float32Array {
  return new Float32Array([
    matrix[0][0], matrix[1][0], matrix[2][0],
    matrix[0][1], matrix[1][1], matrix[2][1],
    matrix[0][2], matrix[1][2], matrix[2][2],
  ]);
}

export function roundMat3(matrix: Mat3, decimals: number): Mat3 {
  const f = 10 ** decimals;
  const r = (n: number) => Math.round(n * f) / f;
  return [
    [r(matrix[0][0]), r(matrix[0][1]), r(matrix[0][2])],
    [r(matrix[1][0]), r(matrix[1][1]), r(matrix[1][2])],
    [r(matrix[2][0]), r(matrix[2][1]), r(matrix[2][2])],
  ];
}
