import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROCK_OPTIONS,
  RockController,
  rockAngleDeg,
  spinAngleDeg,
  type RockOptions,
} from '../src/rock.js';

const DEFAULTS: RockOptions = {}; // amplitude 4°, 0.3 Hz
const PERIOD_MS = 1000 / 0.3; // 3333.33…
const STEP_MS = 5;

function runCommands(
  commands: Array<[timeMs: number, action: (c: RockController) => void]>,
  options?: RockOptions,
  totalMs = 6000,
  stepMs = 2,
): number[] {
  const c = new RockController(options);
  const trace: number[] = [];
  for (let t = 0; t <= totalMs; t += stepMs) {
    c.tick(t);
    for (const [ct, action] of commands) if (ct === t) action(c);
    trace.push(c.tick(t));
  }
  return trace;
}

describe('rock oscillator — defaults and waveform', () => {
  it('uses ±4° at 0.3 Hz by default', () => {
    expect(DEFAULT_ROCK_OPTIONS.amplitudeDeg).toBe(4);
    expect(DEFAULT_ROCK_OPTIONS.frequencyHz).toBe(0.3);
    const c = new RockController();
    let max = -Infinity;
    let min = Infinity;
    for (let t = 0; t <= 10000; t += 10) {
      const a = c.tick(t);
      max = Math.max(max, a);
      min = Math.min(min, a);
    }
    expect(max).toBeCloseTo(4, 9);
    expect(min).toBeCloseTo(-4, 9);
  });

  it('is sinusoidal: zero at phase 0, peak at a quarter period, periodic with 1/f', () => {
    const c = new RockController(DEFAULTS);
    expect(c.tick(0)).toBeCloseTo(0, 12);
    expect(c.tick(PERIOD_MS / 4)).toBeCloseTo(4, 12);
    expect(c.tick(PERIOD_MS / 2)).toBeCloseTo(0, 9);
    expect(c.tick((3 * PERIOD_MS) / 4)).toBeCloseTo(-4, 12);
    expect(c.tick(PERIOD_MS)).toBeCloseTo(0, 9);
    expect(c.tick(PERIOD_MS + PERIOD_MS / 4)).toBeCloseTo(4, 12);
  });

  it('respects a custom amplitude and frequency', () => {
    const c = new RockController({ amplitudeDeg: 2.5, frequencyHz: 0.5 });
    c.tick(0); // anchor phase 0 (first tick anchors wherever it is called)
    expect(c.tick(500)).toBeCloseTo(2.5, 12); // quarter period of 0.5 Hz = 500 ms
  });
});

describe('rock — pause / resume', () => {
  it('freezes the angle while paused; after resume the waveform is phase-shifted by exactly the pause duration', () => {
    const pauseAt = 1000;
    const resumeAt = 3000;
    const c = new RockController(DEFAULTS);
    let frozen: number | null = null;
    for (let t = 0; t <= 6000; t += STEP_MS) {
      c.tick(t);
      if (t === pauseAt) c.pause(pauseAt);
      if (t === resumeAt) c.resume(resumeAt);
      const got = c.tick(t);
      if (t === pauseAt) frozen = got;
      if (t > pauseAt && t < resumeAt) {
        expect(got).toBe(frozen);
      } else if (t >= resumeAt) {
        // origin becomes resumeAt - phaseAtFreeze = 3000 - 1000, so the
        // displayed angle equals the uninterrupted rock delayed by 2000 ms.
        expect(got).toBeCloseTo(rockAngleDeg(t - (resumeAt - pauseAt), DEFAULTS), 9);
      } else {
        expect(got).toBeCloseTo(rockAngleDeg(t, DEFAULTS), 9);
      }
    }
  });

  it('is continuous at the pause and resume instants (no angle jump)', () => {
    const c = new RockController(DEFAULTS);
    let before = 0;
    for (let t = 0; t <= 6000; t += 1) {
      c.tick(t);
      if (t === 1000) {
        before = c.tick(t);
        c.pause(t);
      }
      if (t === 3000) c.resume(t);
      const got = c.tick(t);
      if (t === 1000 || t === 3000) expect(Math.abs(got - before)).toBeLessThan(1e-9);
      before = got;
    }
  });

  it('ticks during a pause cost nothing (deterministic freeze)', () => {
    const c = new RockController(DEFAULTS);
    c.tick(1000);
    c.pause();
    const frozen = c.tick(1000);
    for (let t = 1000; t <= 2900; t += 100) {
      expect(c.tick(t)).toBe(frozen);
    }
  });
});

describe('rock — hold while dragging', () => {
  it('freezes on hold(), resumes on release(), phase-shifted by exactly the hold duration', () => {
    const holdAt = 1500;
    const releaseAt = 4000;
    const c = new RockController(DEFAULTS);
    let frozen: number | null = null;
    for (let t = 0; t <= 6000; t += STEP_MS) {
      c.tick(t);
      if (t === holdAt) c.hold(holdAt);
      if (t === releaseAt) c.release(releaseAt);
      const got = c.tick(t);
      if (t === holdAt) frozen = got;
      if (t > holdAt && t < releaseAt) {
        expect(got).toBe(frozen);
      } else if (t >= releaseAt) {
        expect(got).toBeCloseTo(rockAngleDeg(t - (releaseAt - holdAt), DEFAULTS), 9);
      } else {
        expect(got).toBeCloseTo(rockAngleDeg(t, DEFAULTS), 9);
      }
    }
  });

  it('hold during pause returns to paused on release', () => {
    const c = new RockController(DEFAULTS);
    c.tick(500);
    c.pause();
    c.hold();
    expect(c.state).toBe('held');
    c.release();
    expect(c.state).toBe('paused');
  });

  it('hold during an in-flight ease freezes it; release resumes the ease with elapsed time kept', () => {
    const c = new RockController({ easeBackMs: 600 });
    c.tick(1000); // rock angle at 1 s
    c.stop(1000);
    const at300 = c.tick(1300); // half-way through the ease
    c.hold(1300);
    expect(c.tick(2000)).toBeCloseTo(at300, 12); // frozen despite ticks
    c.release(2000);
    expect(c.tick(2900)).toBeCloseTo(0, 6); // remaining 300 ms of ease completes
    expect(c.state).toBe('stopped');
  });
});

describe('rock — ease back to centre on stop', () => {
  it('eases from the current angle to exactly 0 over easeBackMs, monotonically in magnitude', () => {
    const c = new RockController({ easeBackMs: 600 });
    c.tick(0); // anchor phase 0
    const peakT = PERIOD_MS / 4;
    const stopAngle = c.tick(peakT); // peak, +4°
    expect(stopAngle).toBeCloseTo(4, 12);
    c.stop(peakT);
    expect(c.state).toBe('easing');
    let prevMagnitude = Infinity;
    for (let t = peakT; t <= peakT + 600; t += 10) {
      const a = c.tick(t);
      expect(Math.abs(a)).toBeLessThanOrEqual(prevMagnitude + 1e-12);
      prevMagnitude = Math.abs(a);
      expect(a).toBeLessThanOrEqual(4 + 1e-12); // never overshoots past the peak
    }
    expect(c.tick(peakT + 600)).toBeCloseTo(0, 9);
    expect(c.state).toBe('stopped');
    expect(c.tick(peakT + 10000)).toBe(0); // rests at zero forever
  });

  it('spin mode eases to the nearest full turn (shortest path)', () => {
    const c = new RockController({ mode: 'spin', spinSpeedDegPerSec: 1000 }); // 1°/ms
    c.tick(0); // anchor phase 0
    const angle = c.tick(700); // 700° wrapped → 340°
    expect(angle).toBeCloseTo(340, 9);
    c.stop(700);
    const trace: number[] = [];
    for (let t = 700; t <= 1300; t += 10) trace.push(c.tick(t));
    const last = trace[trace.length - 1];
    expect(last).toBeCloseTo(0, 9); // target 720° ≡ 0 (mod 360)
    // The unwrapped ease must approach 720° without reversing.
    let wrappedPrev = trace[0];
    for (const a of trace.slice(1)) {
      const delta = ((a - wrappedPrev + 540) % 360) - 180; // shortest signed step
      expect(delta).toBeGreaterThanOrEqual(-1e-9);
      wrappedPrev = a;
    }
  });
});

describe('rock — continuous spin mode', () => {
  it('advances linearly and wraps at 360°', () => {
    expect(spinAngleDeg(0, { mode: 'spin', spinSpeedDegPerSec: 6 })).toBeCloseTo(0, 12);
    expect(spinAngleDeg(1000, { mode: 'spin', spinSpeedDegPerSec: 6 })).toBeCloseTo(6, 12);
    expect(spinAngleDeg(60000, { mode: 'spin', spinSpeedDegPerSec: 6 })).toBeCloseTo(0, 9);
    expect(spinAngleDeg(61000, { mode: 'spin', spinSpeedDegPerSec: 6 })).toBeCloseTo(6, 12);
    const c = new RockController({ mode: 'spin' });
    c.tick(0); // anchor phase 0
    expect(c.tick(500)).toBeCloseTo(3, 9);
  });
});

describe('rock — determinism', () => {
  it('replaying the same command timeline yields identical traces', () => {
    const commands: Array<[number, (c: RockController) => void]> = [
      [800, (c) => c.pause(800)],
      [1600, (c) => c.resume(1600)],
      [2000, (c) => c.hold(2000)],
      [2600, (c) => c.release(2600)],
      [3000, (c) => c.stop(3000)],
    ];
    const a = runCommands(commands);
    const b = runCommands(commands);
    expect(a).toEqual(b);
  });

  it('the controller in running state matches the pure oscillator exactly', () => {
    const c = new RockController({ amplitudeDeg: 3, frequencyHz: 0.4 });
    for (let t = 0; t <= 2000; t += 7) {
      expect(c.tick(t)).toBeCloseTo(rockAngleDeg(t, { amplitudeDeg: 3, frequencyHz: 0.4 }), 12);
    }
  });
});
