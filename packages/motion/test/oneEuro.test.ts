import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ONE_EURO_OPTIONS,
  OneEuroFilter,
  OneEuroFilter2,
  alphaFor,
  type OneEuroOptions,
} from '../src/oneEuro.js';

/** Deterministic LCG noise generator (mulberry32-style), no Math.random. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296; // [0, 1)
  };
}

const DT_MS = 1000 / 30; // 30 Hz webcam
const DEFAULTS: OneEuroOptions = {}; // minCutoff 1.0, beta 0.007, dCutoff 1.0

describe('1€ filter — constants and defaults', () => {
  it('documents 30 Hz webcam defaults: minCutoff 1.0 Hz, beta 0.007, dCutoff 1.0 Hz', () => {
    expect(DEFAULT_ONE_EURO_OPTIONS).toEqual({ minCutoffHz: 1.0, beta: 0.007, dCutoffHz: 1.0 });
  });

  it('alpha follows the closed form α = 1/(1 + τc/τ), τc = 1/(2π·fc)', () => {
    const tau = 1 / 30;
    expect(alphaFor(1, tau)).toBeCloseTo(1 / (1 + (1 / (2 * Math.PI * 1)) / tau), 15);
    expect(alphaFor(10, tau)).toBeCloseTo(1 / (1 + (1 / (2 * Math.PI * 10)) / tau), 15);
    // Higher cutoff ⇒ larger alpha (less smoothing).
    expect(alphaFor(10, tau)).toBeGreaterThan(alphaFor(1, tau));
    // Alpha approaches 1 as the cutoff grows.
    expect(alphaFor(1e6, tau)).toBeCloseTo(1, 3);
  });

  it('rejects invalid options', () => {
    expect(() => new OneEuroFilter({ minCutoffHz: 0 })).toThrow(RangeError);
    expect(() => new OneEuroFilter({ beta: -1 })).toThrow(RangeError);
    expect(() => alphaFor(0, 1)).toThrow(RangeError);
  });
});

describe('1€ filter — basic behaviour', () => {
  it('zero input yields zero output and the first sample passes through unchanged', () => {
    const f = new OneEuroFilter(DEFAULTS);
    expect(f.filter(0, 0)).toBe(0);
    for (let k = 1; k <= 60; k++) {
      expect(f.filter(0, k * DT_MS)).toBe(0);
    }
  });

  it('first sample initializes without a transient spike', () => {
    const f = new OneEuroFilter(DEFAULTS);
    expect(f.filter(0.42, 0)).toBe(0.42);
  });

  it('is deterministic: identical sample sequences produce identical outputs', () => {
    const run = (): number[] => {
      const noise = lcg(42); // fresh generator per run
      const f = new OneEuroFilter(DEFAULTS);
      const out: number[] = [];
      for (let k = 0; k < 300; k++) {
        const t = k * 0.1; // ramp
        out.push(f.filter(t + (noise() - 0.5) * 0.02, k * DT_MS));
      }
      return out;
    };
    expect(run()).toEqual(run());
  });

  it('handles irregular timestamps without NaN', () => {
    const f = new OneEuroFilter(DEFAULTS);
    let t = 0;
    for (let k = 0; k < 100; k++) {
      t += DT_MS * (k % 5 === 0 ? 2.5 : 1); // dropped frames
      const v = f.filter(Math.sin(k / 10), t);
      expect(Number.isFinite(v)).toBe(true);
    }
  });

  it('a non-increasing timestamp returns the previous output', () => {
    const f = new OneEuroFilter(DEFAULTS);
    f.filter(1, 0);
    f.filter(2, 33);
    const prev = f.lastFiltered;
    expect(f.filter(99, 33)).toBe(prev);
    expect(f.filter(99, 10)).toBe(prev);
  });
});

describe('1€ filter — noise reduction on a jittered ramp (30 Hz)', () => {
  // Ground truth: x(t) = 0.1·t (a slow head sweep over 10 s), webcam jitter
  // uniform in ±0.01 screen-widths. The filter's steady-state lag shifts the
  // output line slightly, so jitter is measured as the RMS residual after a
  // least-squares line fit — that residual is the high-frequency noise the
  // 1€ filter exists to remove.
  function detrendedRms(samples: number[], dtMs: number): { rms: number; slope: number } {
    const n = samples.length;
    let st = 0;
    let sx = 0;
    let stt = 0;
    let stx = 0;
    for (let k = 0; k < n; k++) {
      const t = (k * dtMs) / 1000;
      st += t;
      sx += samples[k];
      stt += t * t;
      stx += t * samples[k];
    }
    const slope = (n * stx - st * sx) / (n * stt - st * st);
    const intercept = (sx - slope * st) / n;
    let sq = 0;
    for (let k = 0; k < n; k++) {
      const t = (k * dtMs) / 1000;
      sq += (samples[k] - (slope * t + intercept)) ** 2;
    }
    return { rms: Math.sqrt(sq / n), slope };
  }

  it('reduces jitter (detrended residual RMS) to well under half of the raw jitter', () => {
    const noise = lcg(20260901);
    const f = new OneEuroFilter(DEFAULTS);
    const raw: number[] = [];
    const filtered: number[] = [];
    const n = 300; // 10 s
    for (let k = 0; k < n; k++) {
      const truth = 0.1 * (k * DT_MS) / 1000;
      const sample = truth + (noise() - 0.5) * 0.02;
      raw.push(sample);
      filtered.push(f.filter(sample, k * DT_MS));
    }
    const rawRms = detrendedRms(raw.slice(60), DT_MS).rms;
    const filt = detrendedRms(filtered.slice(60), DT_MS);
    const filtRms = filt.rms;
    expect(filtRms).toBeLessThan(0.5 * rawRms);
    expect(filtRms).toBeGreaterThan(0); // sanity: not a constant
    // The fitted slope recovers the true sweep rate within 2%.
    expect(filt.slope).toBeCloseTo(0.1, 2);
  });

  it('keeps bounded lag: at the end of the ramp the filtered value trails truth by < 3% of the range', () => {
    const noise = lcg(7);
    const f = new OneEuroFilter(DEFAULTS);
    let filt = 0;
    const n = 300;
    for (let k = 0; k < n; k++) {
      const truth = 0.1 * (k * DT_MS) / 1000;
      filt = f.filter(truth + (noise() - 0.5) * 0.02, k * DT_MS);
    }
    const truthEnd = 0.1 * ((n - 1) * DT_MS) / 1000;
    expect(truthEnd - filt).toBeLessThan(0.03);
    expect(truthEnd - filt).toBeGreaterThanOrEqual(0); // trails, never leads a ramp
  });
});

describe('1€ filter — speed-adaptive cutoff (β term)', () => {
  function timeTo90(beta: number): number {
    const f = new OneEuroFilter({ minCutoffHz: 1.0, beta, dCutoffHz: 1.0 });
    for (let k = 0; k < 30; k++) f.filter(0, k * DT_MS); // settle at rest
    for (let k = 30; k < 3000; k++) {
      const v = f.filter(1.0, k * DT_MS);
      if (v >= 0.9) return (k - 30) * DT_MS;
    }
    return Infinity;
  }

  it('a fast-moving signal (high β) reaches the step target much sooner than β = 0', () => {
    const fast = timeTo90(1.0);
    const plain = timeTo90(0);
    expect(fast).toBeLessThan(plain);
    expect(fast).toBeLessThan(200); // β opens the cutoff during the saccade
  });

  it('with the documented defaults, a step settles within ~0.5 s (no perceptible sluggishness)', () => {
    const t90 = timeTo90(DEFAULT_ONE_EURO_OPTIONS.beta);
    expect(t90).toBeLessThan(500);
  });
});

describe('2-D filter', () => {
  it('filters each axis independently with the same options', () => {
    const f = new OneEuroFilter2(DEFAULTS);
    expect(f.filter(0, 0, 0)).toEqual({ x: 0, y: 0 });
    const a = f.filter(1, 0, DT_MS);
    const solo = new OneEuroFilter(DEFAULTS);
    solo.filter(0, 0);
    const b = solo.filter(1, DT_MS);
    expect(a.x).toBe(b);
    expect(a.y).toBe(0); // untouched axis stays at zero
  });

  it('reset clears history', () => {
    const f = new OneEuroFilter2(DEFAULTS);
    f.filter(0.5, 0.5, 0);
    f.filter(0.5, 0.5, DT_MS);
    f.reset();
    expect(f.filter(0.9, 0.9, 2 * DT_MS)).toEqual({ x: 0.9, y: 0.9 }); // fresh init
  });
});
