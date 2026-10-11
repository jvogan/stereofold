/**
 * Deterministic rock / spin oscillator for the stereoscopic viewer.
 *
 * The default is a slow rock: sinusoidal, ±4° at 0.3 Hz. These parameters are
 * engineering heuristics; they are defaults, not perceptual claims.
 * A continuous spin mode is provided as the alternative kinetic cue.
 *
 * Determinism contract
 * --------------------
 * Every angle is a pure function of the elapsed phase in milliseconds and the
 * command timeline (start/pause/resume/hold/release/stop). There is no
 * Math.random, no Date.now, no rAF: the caller supplies the clock by calling
 * `tick(nowMs)` once per frame with a monotone timestamp. Replaying the same
 * command timeline against two controllers yields bit-identical angle
 * sequences (tested in test/rock.test.ts).
 *
 * State machine
 * -------------
 *
 *   running ──pause()──► paused ──resume()──► running
 *      │  ▲                 │  ▲                  │
 *      │  └────release()────┼──┘                  │
 *      │                    │                     │
 *      └──hold()──► held ◄──┘   held ──release()──┘ (returns to pre-hold state)
 *      │                    │
 *      └──stop()──► easing ─┴──stop()──► easing ──(easeBackMs)──► stopped
 *
 * Any state ──start()──► running (phase re-anchored so the rock starts at 0°)
 * hold() freezes the current angle (drag holds); release() resumes what was
 * interrupted. stop() eases the angle back to centre over `easeBackMs` and
 * then rests at exactly 0.
 *
 * Integration: call hold() on pointerdown and release() on pointerup so the
 * rock does not fight the user's orbit drag (in mono, the drag is the depth
 * control).
 */

export type RockMode = 'rock' | 'spin';

export type RockState = 'stopped' | 'running' | 'paused' | 'held' | 'easing';

export interface RockOptions {
  /** 'rock' = sinusoidal oscillation about 0°, 'spin' = continuous rotation. Default 'rock'. */
  mode?: RockMode;
  /** Peak deflection in degrees for rock mode. Default 4, a heuristic. */
  amplitudeDeg?: number;
  /** Oscillation frequency in Hz for rock mode. Default 0.3. */
  frequencyHz?: number;
  /** Constant angular speed in degrees/second for spin mode. Default 6 (≈1 rev/min). */
  spinSpeedDegPerSec?: number;
  /** Duration of the ease-back-to-centre after stop(), in ms. Default 600. */
  easeBackMs?: number;
}

export interface ResolvedRockOptions {
  mode: RockMode;
  amplitudeDeg: number;
  frequencyHz: number;
  spinSpeedDegPerSec: number;
  easeBackMs: number;
}

export const DEFAULT_ROCK_OPTIONS: Readonly<ResolvedRockOptions> = Object.freeze({
  mode: 'rock',
  amplitudeDeg: 4,
  frequencyHz: 0.3,
  spinSpeedDegPerSec: 6,
  easeBackMs: 600,
});

export function resolveRockOptions(options?: RockOptions): ResolvedRockOptions {
  const o = options ?? {};
  const amplitudeDeg = o.amplitudeDeg ?? DEFAULT_ROCK_OPTIONS.amplitudeDeg;
  const frequencyHz = o.frequencyHz ?? DEFAULT_ROCK_OPTIONS.frequencyHz;
  const spinSpeedDegPerSec =
    o.spinSpeedDegPerSec ?? DEFAULT_ROCK_OPTIONS.spinSpeedDegPerSec;
  const easeBackMs = o.easeBackMs ?? DEFAULT_ROCK_OPTIONS.easeBackMs;
  if (amplitudeDeg < 0) throw new RangeError('amplitudeDeg must be >= 0');
  if (frequencyHz <= 0) throw new RangeError('frequencyHz must be > 0');
  if (easeBackMs < 0) throw new RangeError('easeBackMs must be >= 0');
  return {
    mode: o.mode ?? DEFAULT_ROCK_OPTIONS.mode,
    amplitudeDeg,
    frequencyHz,
    spinSpeedDegPerSec,
    easeBackMs,
  };
}

/**
 * Pure rock oscillator: sinusoidal, zero phase at phaseMs = 0 (so a fresh
 * rock starts at centre with zero angular velocity, which avoids a jump when
 * the mode is enabled mid-session).
 */
export function rockAngleDeg(phaseMs: number, options?: RockOptions): number {
  const o = resolveRockOptions(options);
  const phaseSeconds = phaseMs / 1000;
  return o.amplitudeDeg * Math.sin(2 * Math.PI * o.frequencyHz * phaseSeconds);
}

/**
 * Pure spin oscillator: linear angle wrapped to [0, 360).
 */
export function spinAngleDeg(phaseMs: number, options?: RockOptions): number {
  const o = resolveRockOptions(options);
  const angle = o.spinSpeedDegPerSec * (phaseMs / 1000);
  return angle - 360 * Math.floor(angle / 360);
}

/** Smooth 0→1 ease (smoothstep). */
function smoothstep01(p: number): number {
  const t = p < 0 ? 0 : p > 1 ? 1 : p;
  return t * t * (3 - 2 * t);
}

export class RockController {
  private readonly opts: ResolvedRockOptions;
  private state_: RockState = 'running';
  /** Timestamp of the most recent tick(); null until the first tick. */
  private lastNow: number | null = null;
  /** Clock time at which the oscillator phase is 0. */
  private origin = 0;
  /** Oscillator phase (ms) captured when the controller froze (pause/hold). */
  private phaseAtFreeze = 0;
  /** State to return to when the hold is released. */
  private heldFrom: 'running' | 'paused' | 'easing' = 'running';
  /** Ease time already elapsed when a hold froze an in-flight ease (ms). */
  private easeElapsedAtFreeze = 0;
  /** Displayed angle captured when a hold froze an in-flight ease. */
  private frozenEasedAngle: number | null = null;
  /** Displayed angle when stop() was called. */
  private angleAtStop = 0;
  /** Nearest-at-rest target for the ease (0 for rock, nearest full turn for spin). */
  private easeTarget = 0;
  /** Clock time at which the ease began. */
  private stopStart = 0;
  private lastAngle = 0;

  constructor(options?: RockOptions) {
    this.opts = resolveRockOptions(options);
  }

  get state(): RockState {
    return this.state_;
  }

  get options(): ResolvedRockOptions {
    return { ...this.opts };
  }

  /** Most recently computed angle in degrees (0 before the first tick). */
  get angleDeg(): number {
    return this.lastAngle;
  }

  /**
   * Advance to `nowMs` (monotone, ms) and return the displayed angle in
   * degrees. The first call anchors the oscillator phase at zero.
   */
  tick(nowMs: number): number {
    if (this.lastNow === null) {
      this.lastNow = nowMs;
      this.origin = nowMs;
    }
    const now = nowMs;
    let angle: number;
    switch (this.state_) {
      case 'running': {
        angle = this.angleAtPhase(now - this.origin);
        break;
      }
      case 'paused':
      case 'held': {
        // A hold that froze an in-flight ease displays the captured eased
        // angle, not the oscillator phase (which is stale during an ease).
        angle =
          this.state_ === 'held' && this.heldFrom === 'easing' && this.frozenEasedAngle !== null
            ? this.frozenEasedAngle
            : this.angleAtPhase(this.phaseAtFreeze);
        break;
      }
      case 'easing': {
        const p = this.opts.easeBackMs === 0
          ? 1
          : (now - this.stopStart) / this.opts.easeBackMs;
        if (p >= 1) {
          this.state_ = 'stopped';
          angle = 0;
        } else {
          // Ease from angleAtStop (p = 0) toward easeTarget (p = 1) with a
          // smoothstep shape: fast initial decay, gentle settle on centre.
          angle = this.angleAtStop + (this.easeTarget - this.angleAtStop) * smoothstep01(p);
        }
        break;
      }
      case 'stopped':
      default: {
        angle = 0;
        break;
      }
    }
    this.lastNow = now;
    this.lastAngle = angle;
    return angle;
  }

  /** Restart from stopped, or resume from paused. Phase re-anchors at 0 on a fresh start. */
  start(nowMs?: number): void {
    const now = this.nowOrLast(nowMs);
    if (this.state_ === 'running') return;
    if (this.state_ === 'paused') {
      this.origin = now - this.phaseAtFreeze;
      this.state_ = 'running';
      return;
    }
    // stopped / held / easing: begin a fresh oscillation at phase 0.
    this.origin = now;
    this.phaseAtFreeze = 0;
    this.state_ = 'running';
  }

  /** Freeze the oscillator at its current angle. */
  pause(nowMs?: number): void {
    const now = this.nowOrLast(nowMs);
    if (this.state_ === 'running') {
      this.phaseAtFreeze = now - this.origin;
      this.state_ = 'paused';
    } else if (this.state_ === 'held' && this.heldFrom === 'easing') {
      // Freeze the ease as well: capture the current eased angle as a pause point.
      this.angleAtStop = this.lastAngle;
      this.easeTarget = 0;
      this.stopStart = now;
      this.heldFrom = 'paused';
      this.state_ = 'paused';
    }
    // pausing an already-paused/paused-after-hold controller is a no-op.
  }

  resume(nowMs?: number): void {
    const now = this.nowOrLast(nowMs);
    if (this.state_ === 'paused') {
      this.origin = now - this.phaseAtFreeze;
      this.state_ = 'running';
    }
  }

  /**
   * Hold-while-dragging input: freeze the current angle without changing the
   * underlying pause state. release() returns to whatever was interrupted.
   */
  hold(nowMs?: number): void {
    const now = this.nowOrLast(nowMs);
    if (this.state_ === 'held') return;
    if (this.state_ === 'running') {
      this.phaseAtFreeze = now - this.origin;
      this.heldFrom = 'running';
      this.frozenEasedAngle = null;
    } else if (this.state_ === 'paused') {
      this.heldFrom = 'paused';
      this.frozenEasedAngle = null;
    } else if (this.state_ === 'easing') {
      // Freeze the ease mid-flight; release() restarts it from here with the
      // already-elapsed ease time preserved.
      this.angleAtStop = this.lastAngle;
      this.easeElapsedAtFreeze = Math.max(0, now - this.stopStart);
      this.stopStart = now;
      this.frozenEasedAngle = this.lastAngle;
      this.heldFrom = 'easing';
    } else {
      return; // stopped: nothing to hold
    }
    this.state_ = 'held';
  }

  release(nowMs?: number): void {
    if (this.state_ !== 'held') return;
    const now = this.nowOrLast(nowMs);
    if (this.heldFrom === 'running') {
      this.origin = now - this.phaseAtFreeze;
      this.state_ = 'running';
    } else if (this.heldFrom === 'paused') {
      this.state_ = 'paused';
    } else {
      // Resume the ease from the angle captured at hold time, with the
      // ease clock rewound so progress made before the hold is kept.
      this.stopStart = now - this.easeElapsedAtFreeze;
      this.state_ = 'easing';
    }
  }

  /**
   * Stop the motion and ease the angle back to centre over `easeBackMs`.
   * For spin mode the ease targets the nearest full turn (shortest path to a
   * multiple of 360°) so the object does not whip backwards.
   */
  stop(nowMs?: number): void {
    const now = this.nowOrLast(nowMs);
    if (this.state_ === 'stopped') return;
    if (this.state_ === 'held') {
      // Cancel the hold and ease from the angle actually on screen.
      this.beginEase(this.lastAngle, now);
      return;
    }
    if (this.state_ === 'easing') {
      // Re-target the ease from wherever the previous ease has reached.
      this.beginEase(this.lastAngle, now);
      return;
    }
    this.beginEase(this.angleAtPhase(this.state_ === 'running' ? now - this.origin : this.phaseAtFreeze), now);
  }

  private beginEase(angle: number, now: number): void {
    this.angleAtStop = angle;
    this.easeTarget = this.opts.mode === 'spin' ? 360 * Math.round(angle / 360) : 0;
    this.stopStart = now;
    this.state_ = 'easing';
  }

  private angleAtPhase(phaseMs: number): number {
    return this.opts.mode === 'rock'
      ? rockAngleDeg(phaseMs, this.opts)
      : spinAngleDeg(phaseMs, this.opts);
  }

  private nowOrLast(nowMs?: number): number {
    if (nowMs !== undefined) return nowMs;
    if (this.lastNow !== null) return this.lastNow;
    // Mutations before the first tick act at t=0.
    this.lastNow = 0;
    this.origin = 0;
    return 0;
  }
}
