/**
 * 1€ filter (one-euro filter) for noisy 2-D input, used to smooth webcam
 * head position before it drives the off-axis parallax frustum.
 *
 * Reference: Casiez, Roussel & Vogel, "1€ Filter: A Simple Speed-based
 * Low-pass Filter for Noisy Input in Interactive Systems", CHI 2012
 * The filter constants below are engineering heuristics and have not been
 * benchmarked.
 *
 * Algorithm (per axis):
 *   dx̂k     = α(dCutoff, Δt) · dxk + (1 − α) · dx̂(k−1)      speed estimate
 *   cutoff  = minCutoff + β · |dx̂k|                           speed-dependent cutoff
 *   x̂k      = α(cutoff, Δt) · xk + (1 − α) · x̂(k−1)           position estimate
 *
 *   α(c, Δt) = 1 / (1 + τc/Δt),   τc = 1 / (2π·c)
 *
 * Low speed → the cutoff drops toward minCutoff → heavy smoothing (jitter
 * gone while the head rests). High speed → β raises the cutoff → the filter
 * opens up and lag stays imperceptible during head saccades.
 *
 * Defaults for 30 Hz webcam head tracking, tuned for desktop viewing. Treat
 * them as a starting point for tuning, not a validated constant:
 *   minCutoffHz = 1.0   — kills resting webcam jitter
 *   beta        = 0.007 — keeps lag low during fast head motion
 *   dCutoffHz   = 1.0   — smooths the speed estimate itself
 *
 * Determinism: the filter is a pure function of the sample sequence. No
 * clocks, no randomness. Two filters fed identical samples produce
 * bit-identical outputs.
 */

export interface OneEuroOptions {
  /** Minimum cutoff frequency in Hz; the smoothing floor. Default 1.0. */
  minCutoffHz?: number;
  /** Speed coefficient; raises the cutoff when the signal moves fast. Default 0.007. */
  beta?: number;
  /** Cutoff for the low-pass filter applied to the speed estimate. Default 1.0. */
  dCutoffHz?: number;
}

export interface ResolvedOneEuroOptions {
  minCutoffHz: number;
  beta: number;
  dCutoffHz: number;
}

export const DEFAULT_ONE_EURO_OPTIONS: Readonly<ResolvedOneEuroOptions> = Object.freeze({
  minCutoffHz: 1.0,
  beta: 0.007,
  dCutoffHz: 1.0,
});

export function resolveOneEuroOptions(options?: OneEuroOptions): ResolvedOneEuroOptions {
  const o = options ?? {};
  const minCutoffHz = o.minCutoffHz ?? DEFAULT_ONE_EURO_OPTIONS.minCutoffHz;
  const beta = o.beta ?? DEFAULT_ONE_EURO_OPTIONS.beta;
  const dCutoffHz = o.dCutoffHz ?? DEFAULT_ONE_EURO_OPTIONS.dCutoffHz;
  if (!(minCutoffHz > 0)) throw new RangeError('minCutoffHz must be > 0');
  if (!(dCutoffHz > 0)) throw new RangeError('dCutoffHz must be > 0');
  if (beta < 0) throw new RangeError('beta must be >= 0');
  return { minCutoffHz, beta, dCutoffHz };
}

/**
 * Smoothing factor for a low-pass filter with cutoff `cutoffHz` sampled
 * every `tauSeconds`: α = 1 / (1 + τc/τ) with τc = 1/(2π·cutoffHz).
 */
export function alphaFor(cutoffHz: number, tauSeconds: number): number {
  if (!(cutoffHz > 0)) throw new RangeError('cutoffHz must be > 0');
  if (!(tauSeconds > 0)) throw new RangeError('tauSeconds must be > 0');
  const tauCutoff = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tauCutoff / tauSeconds);
}

export class OneEuroFilter {
  private readonly opts: ResolvedOneEuroOptions;
  private prevValue = 0;
  private prevFiltered = 0;
  private prevDeriv = 0;
  private prevTime: number | null = null;
  private value = 0;

  constructor(options?: OneEuroOptions) {
    this.opts = resolveOneEuroOptions(options);
  }

  get options(): ResolvedOneEuroOptions {
    return { ...this.opts };
  }

  get hasPrevious(): boolean {
    return this.prevTime !== null;
  }

  get lastFiltered(): number {
    return this.value;
  }

  /** Forget all history; the next sample becomes the new initial value. */
  reset(): void {
    this.prevTime = null;
    this.prevDeriv = 0;
    this.prevFiltered = 0;
    this.value = 0;
  }

  /**
   * Feed one sample. `timestampMs` must be monotone; Δt is derived from the
   * difference, so irregular frame intervals (dropped webcam frames) are
   * handled. A non-increasing timestamp returns the previous output.
   */
  filter(value: number, timestampMs: number): number {
    if (this.prevTime === null || timestampMs <= this.prevTime) {
      if (this.prevTime === null) {
        this.prevValue = value;
        this.prevFiltered = value;
        this.value = value;
        this.prevTime = timestampMs;
        this.prevDeriv = 0;
        return value;
      }
      return this.value;
    }
    const dt = (timestampMs - this.prevTime) / 1000;
    const dx = (value - this.prevValue) / dt;

    const aD = alphaFor(this.opts.dCutoffHz, dt);
    const deriv = aD * dx + (1 - aD) * this.prevDeriv;

    const cutoff = this.opts.minCutoffHz + this.opts.beta * Math.abs(deriv);
    const a = alphaFor(cutoff, dt);
    // EWMA against the previous FILTERED output (not the previous raw input).
    const filtered = a * value + (1 - a) * this.prevFiltered;

    this.prevValue = value;
    this.prevFiltered = filtered;
    this.prevDeriv = deriv;
    this.prevTime = timestampMs;
    this.value = filtered;
    return filtered;
  }
}

export interface Vec2 {
  x: number;
  y: number;
}

/**
 * Independent 1€ filtering of a 2-D signal (head x/y). Each axis runs its
 * own OneEuroFilter with the same options; axes do not cross-contaminate.
 */
export class OneEuroFilter2 {
  private readonly fx: OneEuroFilter;
  private readonly fy: OneEuroFilter;

  constructor(options?: OneEuroOptions) {
    this.fx = new OneEuroFilter(options);
    this.fy = new OneEuroFilter(options);
  }

  get options(): ResolvedOneEuroOptions {
    return this.fx.options;
  }

  reset(): void {
    this.fx.reset();
    this.fy.reset();
  }

  filter(x: number, y: number, timestampMs: number): Vec2 {
    return { x: this.fx.filter(x, timestampMs), y: this.fy.filter(y, timestampMs) };
  }
}
