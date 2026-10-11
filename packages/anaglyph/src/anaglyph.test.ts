import { describe, expect, it } from 'vitest';
import {
  ANAGLYPH_GROUND_SRGB,
  BALANCED_GAMUT_SCALE_GREEN_MAGENTA,
  BALANCED_K_AMBER_BLUE,
  BALANCED_K_GREEN_MAGENTA,
  BALANCED_K_RED_CYAN,
  BALANCED_MATRICES,
  CPK_SRGB,
  DUBOIS_MATRICES,
  PUBLISHED_3DP,
  compositeLinear,
  compositeRgba,
  compositeSrgb,
  eyeChannelLuma,
  filterChannelLuma,
  fillRgba,
  luminancePalette,
  rec709Luma,
  rec709Weights,
  roundMat3,
  srgbToLinear,
  type GlassesKind,
  type RGB,
  type Variant,
} from './index';

const GLASSES: GlassesKind[] = ['red-cyan', 'green-magenta', 'amber-blue'];
const VERDICT = 'ALL CHECKS PASS — software geometry verified; human perception untested';
const failures: string[] = [];
const DUBOIS: Variant = 'dubois';
const BALANCED: Variant = 'balanced';
const LUMA_LIMIT = 0.25;

function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures.push(detail ? `${name}: ${detail}` : name);
  expect(ok, detail ? `${name} (${detail})` : name).toBe(true);
}

function maxAbs(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

function inUnitInterval(value: number): boolean {
  return value >= -1e-12 && value <= 1 + 1e-12;
}

const GRAYS: RGB[] = [0, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1].map((g) => [g, g, g]);
const SATURATED: RGB[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
  [1, 1, 0],
  [0, 1, 1],
  [1, 0, 1],
  [1, 1, 1],
  [0.8, 0.2, 0.1],
  [0.1, 0.7, 0.2],
  [0.05, 0.1, 0.9],
  [0.4, 0.55, 0.7],
];
const SWEEP: RGB[] = [...GRAYS, ...SATURATED, ...Object.values(CPK_SRGB).map((c) => srgbToLinear(c))];

describe('Dubois matrices match published coefficients to 3 decimals', () => {
  for (const glasses of GLASSES) {
    it(`${glasses} left and right round to the published 3-decimal table`, () => {
      const got = DUBOIS_MATRICES[glasses];
      const pub = PUBLISHED_3DP[glasses];
      const left = roundMat3(got.left, 3);
      const right = roundMat3(got.right, 3);
      check(
        `${glasses} left 3dp`,
        JSON.stringify(left) === JSON.stringify(roundMat3(pub.left, 3)),
        `got ${JSON.stringify(left)}`,
      );
      check(
        `${glasses} right 3dp`,
        JSON.stringify(right) === JSON.stringify(roundMat3(pub.right, 3)),
        `got ${JSON.stringify(right)}`,
      );
    });
  }
});

describe('balanced k ratios and matrix structure', () => {
  it('red-cyan k equals wR/(wG+wB) = 0.27000254', () => {
    const w = rec709Weights();
    const expected = w[0] / (w[1] + w[2]);
    check('k_rc formula', Math.abs(BALANCED_K_RED_CYAN - expected) < 1e-15);
    check('k_rc 8dp', Math.abs(BALANCED_K_RED_CYAN - 0.27000254) < 5e-9,
      `k=${BALANCED_K_RED_CYAN}`);
  });

  it('green-magenta and amber-blue k match the same channel-weight rule', () => {
    const w = rec709Weights();
    check('k_gm', Math.abs(BALANCED_K_GREEN_MAGENTA - w[1] / (w[0] + w[2])) < 1e-15);
    check('k_ab', Math.abs(BALANCED_K_AMBER_BLUE - w[2] / (w[0] + w[1])) < 1e-15);
    check('gm k > 1', BALANCED_K_GREEN_MAGENTA > 1, `k=${BALANCED_K_GREEN_MAGENTA}`);
    check('gm gamut scale = 1/k', Math.abs(BALANCED_GAMUT_SCALE_GREEN_MAGENTA * BALANCED_K_GREEN_MAGENTA - 1) < 1e-12);
  });

  it('red-cyan balanced pair is the specified luma projector', () => {
    const w = rec709Weights();
    const pair = BALANCED_MATRICES['red-cyan'];
    check('left is luma in R only',
      maxAbs(pair.left[0], w) < 1e-15
      && maxAbs(pair.left[1], [0, 0, 0]) < 1e-15
      && maxAbs(pair.left[2], [0, 0, 0]) < 1e-15);
    const kw: RGB = [BALANCED_K_RED_CYAN * w[0], BALANCED_K_RED_CYAN * w[1], BALANCED_K_RED_CYAN * w[2]];
    check('right is k*luma in G and B',
      maxAbs(pair.right[0], [0, 0, 0]) < 1e-15
      && maxAbs(pair.right[1], kw) < 1e-15
      && maxAbs(pair.right[2], kw) < 1e-15);
  });
});

describe('literal workshop luma criterion', () => {
  it('matches the cited red/cyan filter contributions without white normalisation', () => {
    const red = srgbToLinear([1, 0, 0]);
    const cyan = srgbToLinear([0, 142 / 255, 142 / 255]);
    const result = filterChannelLuma(red, cyan);
    check('workshop red/cyan residual ≤ 0.25%', result.residualPercent <= LUMA_LIMIT,
      `red=${result.left.toFixed(6)} cyan=${result.right.toFixed(6)} residual=${result.residualPercent.toFixed(6)}%`);
  });

  it('reports Dubois matrix cross-talk instead of hiding it by white normalisation', () => {
    const composite = compositeLinear([0.4, 0.4, 0.4], [0.4, 0.4, 0.4], { variant: DUBOIS });
    const result = eyeChannelLuma(composite, 'red-cyan');
    check('gray Dubois residual is measured literally', result.residualPercent > 100,
      `red=${result.left.toFixed(6)} cyan=${result.right.toFixed(6)} residual=${result.residualPercent.toFixed(6)}%`);
    check('gray Dubois residual is the measured reference', Math.abs(result.residualPercent - 114.9600246) < 1e-5,
      `residual=${result.residualPercent.toFixed(7)}%`);
  });

  it('default variant is balanced: identical gray residual ≤ 0.25%', () => {
    const composite = compositeLinear([0.4, 0.4, 0.4], [0.4, 0.4, 0.4]);
    const result = eyeChannelLuma(composite, 'red-cyan');
    check('default gray residual', result.residualPercent <= LUMA_LIMIT,
      `residual=${result.residualPercent.toFixed(8)}%`);
  });

  it('keeps the forced dark ground dark and records Dubois output residual', () => {
    for (const glasses of GLASSES) {
      const mapped = luminancePalette(ANAGLYPH_GROUND_SRGB, { glasses, variant: DUBOIS });
      const lin = srgbToLinear(mapped);
      const composite = compositeLinear(lin, lin, { glasses, variant: DUBOIS });
      const { residualPercent } = eyeChannelLuma(composite, glasses);
      check(
        `ground ${glasses} dubois`,
        Number.isFinite(residualPercent) && residualPercent > LUMA_LIMIT,
        `residual=${residualPercent.toFixed(6)}% rgb=${mapped.map((c) => c.toFixed(4)).join(',')}`,
      );
      check(
        `ground ${glasses} stays dark`,
        rec709Luma(lin) < 0.002,
        `Y=${rec709Luma(lin)}`,
      );
    }
  });

  it('balanced ground residual ≤ 0.25% and stays dark', () => {
    for (const glasses of GLASSES) {
      const mapped = luminancePalette(ANAGLYPH_GROUND_SRGB, { glasses, variant: BALANCED });
      const lin = srgbToLinear(mapped);
      const composite = compositeLinear(lin, lin, { glasses, variant: BALANCED });
      const { residualPercent } = eyeChannelLuma(composite, glasses);
      check(
        `ground ${glasses} balanced`,
        residualPercent <= LUMA_LIMIT,
        `residual=${residualPercent.toFixed(8)}%`,
      );
      check(
        `ground ${glasses} balanced stays dark`,
        rec709Luma(lin) < 0.002,
        `Y=${rec709Luma(lin)}`,
      );
    }
  });

  it('luminancePalette CPK colours remain finite under the literal metric', () => {
    for (const variant of [BALANCED, DUBOIS] as const) {
      for (const glasses of GLASSES) {
        for (const [element, rgb] of Object.entries(CPK_SRGB)) {
          const mapped = luminancePalette(rgb, { glasses, variant });
          const lin = srgbToLinear(mapped);
          const composite = compositeLinear(lin, lin, { glasses, variant });
          const { residualPercent } = eyeChannelLuma(composite, glasses);
          check(
            `CPK ${element} ${glasses} ${variant}`,
            Number.isFinite(residualPercent),
            `residual=${residualPercent.toFixed(6)}%`,
          );
        }
      }
    }
  });

  it('palette keeps Rec.709 luma order of CPK C, N, O, S, H', () => {
    const y = (el: keyof typeof CPK_SRGB) =>
      rec709Luma(srgbToLinear(luminancePalette(CPK_SRGB[el])));
    check('H brighter than S', y('H') > y('S'));
    check('S brighter than C', y('S') > y('C'));
    check('C brighter than O', y('C') > y('O'));
    check('O brighter than N', y('O') > y('N'));
  });
});

describe('balanced L=R residual ≤ 0.25% on grays and saturated colours', () => {
  for (const glasses of GLASSES) {
    it(`${glasses} sweep`, () => {
      let worst = 0;
      let worstColor = '';
      for (const color of SWEEP) {
        const composite = compositeLinear(color, color, { glasses, variant: BALANCED });
        const { residualPercent } = eyeChannelLuma(composite, glasses);
        if (residualPercent > worst) {
          worst = residualPercent;
          worstColor = color.map((c) => c.toFixed(4)).join(',');
        }
        check(
          `${glasses} [${color.map((c) => c.toFixed(3)).join(',')}]`,
          residualPercent <= LUMA_LIMIT,
          `residual=${residualPercent.toFixed(8)}%`,
        );
      }
      check(`${glasses} worst residual recorded`, worst <= LUMA_LIMIT,
        `worst=${worst.toFixed(8)}% at ${worstColor}`);
    });
  }
});

describe('balanced output stays in [0,1] for in-gamut input', () => {
  it('L=R and L≠R samples never leave the unit cube (no clamp required)', () => {
    const samples: RGB[] = [...SWEEP, [0, 0, 0], [1, 1, 1]];
    for (const glasses of GLASSES) {
      for (const left of samples) {
        for (const right of samples) {
          const out = compositeLinear(left, right, { glasses, variant: BALANCED });
          const ok = inUnitInterval(out[0]) && inUnitInterval(out[1]) && inUnitInterval(out[2]);
          if (!ok) {
            check(
              `${glasses} gamut`,
              false,
              `L=${left.join(',')} R=${right.join(',')} out=${out.join(',')}`,
            );
            return;
          }
        }
      }
    }
    check('all in-gamut pairs stay in [0,1]', true);
  });

  it('balanced matrix entries are non-negative, so in-gamut RGB cannot go below 0', () => {
    for (const glasses of GLASSES) {
      const pair = BALANCED_MATRICES[glasses];
      for (const eye of [pair.left, pair.right]) {
        for (const row of eye) {
          check(`${glasses} row ≥ 0`, row[0] >= 0 && row[1] >= 0 && row[2] >= 0, row.join(','));
        }
      }
    }
  });
});

describe('zero-disparity negative control', () => {
  it('identical inputs: swapEyes is a no-op (pixel difference 0)', () => {
    const left = new Float32Array(16);
    const right = new Float32Array(16);
    const outA = new Float32Array(16);
    const outB = new Float32Array(16);
    const pattern: RGB = [0.4, 0.55, 0.7];
    fillRgba(left, pattern);
    fillRgba(right, pattern);
    compositeRgba(left, right, outA, { swapEyes: false });
    compositeRgba(left, right, outB, { swapEyes: true });
    check('swap of identical pair is identity', maxAbs(outA, outB) === 0, `maxAbs=${maxAbs(outA, outB)}`);
  });

  it('identical linear gray reports the same literal Dubois residual deterministically', () => {
    const g = 0.4;
    const composite = compositeLinear([g, g, g], [g, g, g], { variant: DUBOIS });
    const { left, right, residualPercent } = eyeChannelLuma(composite, 'red-cyan');
    check(
      'literal channel residual',
      Math.abs(residualPercent - 114.9600246) < 1e-5,
      `left=${left} right=${right} residual=${residualPercent}`,
    );
  });
});

describe('glasses-swap check', () => {
  it('swapping distinct inputs changes the composite', () => {
    const a: RGB = [0.8, 0.1, 0.05];
    const b: RGB = [0.05, 0.2, 0.9];
    const n = compositeSrgb(a, b);
    const s = compositeSrgb(a, b, { swapEyes: true });
    const swappedArgs = compositeSrgb(b, a);
    check('swapEyes equals argument swap', maxAbs(s, swappedArgs) === 0);
    check('swap changes the composite', maxAbs(n, s) > 0.01, `maxAbs=${maxAbs(n, s)}`);
    const twice = compositeSrgb(a, b, { swapEyes: false });
    check('swap is an involution on the unswapped path', maxAbs(n, twice) === 0);
  });

  it('red-cyan: a left-only signal lands in R; swap moves it to G/B', () => {
    const signal: RGB = [1, 1, 1];
    const black: RGB = [0, 0, 0];
    const leftOnly = compositeLinear(srgbToLinear(signal), srgbToLinear(black), { variant: DUBOIS });
    const rightOnly = compositeLinear(srgbToLinear(black), srgbToLinear(signal), { variant: DUBOIS });
    check('left-only red exceeds green', leftOnly[0] > leftOnly[1] + 0.2, leftOnly.join(','));
    check('left-only red exceeds blue', leftOnly[0] > leftOnly[2] + 0.2, leftOnly.join(','));
    check('right-only green exceeds red', rightOnly[1] > rightOnly[0] + 0.2, rightOnly.join(','));
    check('right-only blue exceeds red', rightOnly[2] > rightOnly[0] + 0.2, rightOnly.join(','));
    const leftEnergyGB = leftOnly[1] + leftOnly[2];
    const rightEnergyR = rightOnly[0];
    check(
      'swap moves energy out of the left-driven channel',
      leftOnly[0] > 0.3 && rightEnergyR < 0.15,
      `leftR=${leftOnly[0]} rightR=${rightEnergyR} leftGB=${leftEnergyGB}`,
    );
  });

  it('balanced red-cyan: left-only lands in R; right-only in G/B', () => {
    const leftOnly = compositeLinear([1, 1, 1], [0, 0, 0], { variant: BALANCED });
    const rightOnly = compositeLinear([0, 0, 0], [1, 1, 1], { variant: BALANCED });
    check('balanced left-only is red', leftOnly[0] > 0.9 && leftOnly[1] < 1e-12 && leftOnly[2] < 1e-12, leftOnly.join(','));
    check('balanced right-only has no red', rightOnly[0] < 1e-12, rightOnly.join(','));
    check('balanced right-only G equals B', Math.abs(rightOnly[1] - rightOnly[2]) < 1e-12, rightOnly.join(','));
  });

  it('green-magenta: a left-only signal lands in G', () => {
    const leftOnly = compositeLinear([1, 1, 1], [0, 0, 0], { glasses: 'green-magenta', variant: DUBOIS });
    check('left-only green is the peak channel', leftOnly[1] > leftOnly[0] && leftOnly[1] > leftOnly[2], leftOnly.join(','));
  });

  it('amber-blue: a right-only signal lands in B', () => {
    const rightOnly = compositeLinear([0, 0, 0], [1, 1, 1], { glasses: 'amber-blue', variant: DUBOIS });
    check('right-only blue is the peak channel', rightOnly[2] > rightOnly[0] && rightOnly[2] > rightOnly[1], rightOnly.join(','));
  });
});

describe('acceptance verdict', () => {
  it(VERDICT, () => {
    expect(failures, failures.join('; ')).toEqual([]);
    console.log(VERDICT);
  });
});
