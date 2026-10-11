import {
  DEFAULT_ROCK_OPTIONS,
  RockController,
  parallaxFrustum,
  pointerToPose,
  type ViewOffsetParams,
} from '@stereo/motion';

export type MotionMode = 'none' | 'rock' | 'spin' | 'parallax';
export type MotionAxis = 'y' | 'x';

/** The public tool payload. Tuning fields deliberately remain optional. */
export interface MotionSettings {
  mode: MotionMode;
  amplitudeDeg?: number;
  periodS?: number;
  axis?: MotionAxis;
}

export const DEFAULT_MOTION_SETTINGS: Readonly<MotionSettings> = Object.freeze({
  mode: 'none',
  axis: 'y',
});

export interface NormalizedHeadOffset {
  /** Centre-relative screen coordinate in [-1, 1]; positive x is right. */
  x: number;
  /** Centre-relative screen coordinate in [-1, 1]; positive y is up. */
  y: number;
}

/**
 * Source boundary for viewer-coupled parallax. It accepts a normalised head
 * offset rather than a DOM event, so a future head tracker can provide this
 * same shape without changing camera code. This build supplies mouse only.
 */
export interface ParallaxSource {
  read(): NormalizedHeadOffset | undefined;
}

/** Mouse-only, permission-free implementation of ParallaxSource. */
export class MouseParallaxSource implements ParallaxSource {
  private offset: NormalizedHeadOffset | undefined;

  setClientPosition(clientX: number, clientY: number, bounds: DOMRectReadOnly): void {
    if (!(bounds.width > 0 && bounds.height > 0)) {
      this.offset = undefined;
      return;
    }
    this.offset = {
      x: clamp(((clientX - bounds.left) / bounds.width) * 2 - 1, -1, 1),
      // DOM client Y grows down; @stereo/motion's projection convention is up.
      y: clamp(1 - ((clientY - bounds.top) / bounds.height) * 2, -1, 1),
    };
  }

  clear(): void {
    this.offset = undefined;
  }

  read(): NormalizedHeadOffset | undefined {
    return this.offset == null ? undefined : { ...this.offset };
  }
}

export interface MotionCameraSnapshot {
  position: ArrayLike<number>;
  target: ArrayLike<number>;
  up: ArrayLike<number>;
  fovRad: number;
  near: number;
  aspect: number;
}

export interface MotionCameraAdapter {
  readCamera(): MotionCameraSnapshot;
  /** Updates only the parent Mol* camera pose. It has no StereoCamera fields. */
  setPosition(position: readonly [number, number, number]): void;
  /** Applies or clears the parent camera's off-axis projection. */
  setViewOffset(offset: ViewOffsetParams | undefined): void;
}

type Baseline = {
  position: [number, number, number];
  target: [number, number, number];
};

/**
 * Relative tolerance for "the camera is where this controller left it".
 *
 * A false positive is harmless: re-adopting a pose this controller itself
 * wrote un-rotates by the same angle it was rotated by and reconstructs the
 * identical baseline. A false negative silently reverts a user's zoom, so the
 * tolerance is as small as float round-tripping through Mol* allows.
 */
const POSE_EPSILON = 1e-6;

/**
 * Camera-only motion adapter. StereoController owns rAF and invokes tick()
 * immediately before it re-derives eye separation/focus, so motion composes
 * with stereo without ever writing StereoCamera parameters.
 */
export class MotionController {
  private settings: MotionSettings = { ...DEFAULT_MOTION_SETTINGS };
  private baseline: Baseline | undefined;
  private oscillator: RockController | undefined;
  private hidden = false;
  private parallaxApplied = false;
  /** The pose this controller wrote last frame, or undefined after a capture. */
  private lastWritten: Baseline | undefined;
  /** The oscillator angle (rad) that produced `lastWritten`. */
  private lastAngleRad = 0;

  constructor(
    private readonly camera: MotionCameraAdapter,
    private readonly parallaxSource: ParallaxSource,
  ) {}

  getSettings(): MotionSettings {
    return { ...this.settings };
  }

  /**
   * True when the next tick would write the camera.
   *
   * Read only by the fit diagnostics. One explanation for a clipped side
   * panel is that the rock restores a baseline captured before a fit and
   * quietly undoes it, so "is it running" and "what pose is it holding" have
   * to be reportable from outside.
   */
  isRunning(): boolean {
    if (this.hidden || this.settings.mode === 'none') return false;
    return this.settings.mode === 'parallax' || this.oscillator != null;
  }

  /**
   * Distance from the baseline camera position to the baseline target.
   *
   * Undefined before the first capture. A baseline distance that differs from
   * the camera's current distance to target is the signature of hypothesis 3:
   * the fit moved the camera and this controller is about to move it back.
   */
  getBaselineDistance(): number | undefined {
    const baseline = this.baseline;
    if (baseline == null) return undefined;
    const dx = baseline.position[0] - baseline.target[0];
    const dy = baseline.position[1] - baseline.target[1];
    const dz = baseline.position[2] - baseline.target[2];
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /** Capture the pose after load, reset, or a completed orbit drag. */
  captureBaseline(): void {
    const camera = this.camera.readCamera();
    this.baseline = {
      position: tuple(camera.position),
      target: tuple(camera.target),
    };
    // An explicit capture is authoritative: forget the last written pose so
    // the next tick uses this baseline as given rather than re-deriving one.
    this.lastWritten = undefined;
  }

  setSettings(next: MotionSettings, nowMs: number): void {
    const previous = this.settings.mode;
    this.restoreBaseline();
    this.camera.setViewOffset(undefined);
    this.parallaxApplied = false;
    this.settings = { ...DEFAULT_MOTION_SETTINGS, ...next, axis: next.axis ?? 'y' };
    this.oscillator = this.settings.mode === 'rock' || this.settings.mode === 'spin'
      ? new RockController(rockOptions(this.settings))
      : undefined;
    if (this.oscillator != null) this.oscillator.tick(nowMs);
    if (previous !== this.settings.mode) this.captureBaseline();
  }

  /** Keep the motion clock from advancing while an iframe tab is hidden. */
  setHidden(hidden: boolean, nowMs: number): void {
    if (this.hidden === hidden) return;
    this.hidden = hidden;
    if (hidden) this.oscillator?.pause(nowMs);
    else this.oscillator?.resume(nowMs);
  }

  /** Hold a rock/spin during orbit input so it cannot fight the drag. */
  hold(nowMs: number): void {
    this.oscillator?.hold(nowMs);
  }

  release(nowMs: number): void {
    this.oscillator?.release(nowMs);
    this.captureBaseline();
  }

  /** Restore the mono projection and dispose of all camera-side motion. */
  stop(): void {
    this.restoreBaseline();
    this.camera.setViewOffset(undefined);
    this.parallaxApplied = false;
    this.oscillator = undefined;
    this.settings = { ...DEFAULT_MOTION_SETTINGS };
  }

  /**
   * Called from StereoController's requestAnimationFrame. It returns true only
   * when this frame touched the parent camera. `none` performs no writes,
   * which is the node-testable guarantee that it stops motion frames.
   */
  tick(nowMs: number): boolean {
    if (this.hidden || this.settings.mode === 'none') return false;
    if (this.settings.mode === 'parallax') return this.applyParallax();
    if (this.oscillator == null) return false;
    if (this.baseline == null) this.captureBaseline();
    this.adoptExternalPose();
    const baseline = this.baseline;
    if (baseline == null) return false;
    const axis = this.settings.axis ?? 'y';
    const angleRad = this.oscillator.tick(nowMs) * Math.PI / 180;
    const position = rotate(baseline.position, baseline.target, axis, angleRad);
    this.camera.setPosition(position);
    this.lastWritten = { position, target: [...baseline.target] };
    this.lastAngleRad = angleRad;
    return true;
  }

  /**
   * Re-baseline when anything other than this controller moved the camera.
   *
   * `tick` writes the whole camera position every frame from a stored
   * baseline, so any other camera write — a wheel zoom, a pinch, a keyboard
   * move, a Mol* focus change, an orbit drag — lives for exactly one frame and
   * is then overwritten from the stale baseline. Comparing the camera against
   * the pose this controller wrote last frame is the generic detector: if it
   * differs, the new pose is the user's, and the baseline that reproduces it
   * is the current pose un-rotated by the angle currently being applied.
   * Rotation preserves the distance to the target, so a zoom survives.
   */
  private adoptExternalPose(): void {
    const written = this.lastWritten;
    if (written == null) return;
    const camera = this.camera.readCamera();
    const position = tuple(camera.position);
    const target = tuple(camera.target);
    if (samePoint(position, written.position) && samePoint(target, written.target)) return;
    this.baseline = {
      position: rotate(position, target, this.settings.axis ?? 'y', -this.lastAngleRad),
      target,
    };
  }

  private applyParallax(): boolean {
    const source = this.parallaxSource.read();
    if (source == null) {
      if (this.parallaxApplied) this.camera.setViewOffset(undefined);
      this.parallaxApplied = false;
      return false;
    }
    const camera = this.camera.readCamera();
    const frustum = parallaxFrustum(pointerToPose(source.x, source.y), {
      fovRad: camera.fovRad,
      aspect: camera.aspect,
      near: camera.near,
    });
    this.camera.setViewOffset(frustum.viewOffset);
    this.parallaxApplied = true;
    return true;
  }

  private restoreBaseline(): void {
    this.lastWritten = undefined;
    this.lastAngleRad = 0;
    if (this.baseline != null) this.camera.setPosition(this.baseline.position);
  }
}

function samePoint(a: readonly [number, number, number], b: readonly [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    const scale = Math.max(1, Math.abs(a[i]), Math.abs(b[i]));
    if (Math.abs(a[i] - b[i]) > POSE_EPSILON * scale) return false;
  }
  return true;
}

function rockOptions(settings: MotionSettings) {
  if (settings.mode === 'rock') {
    return {
      mode: 'rock' as const,
      amplitudeDeg: settings.amplitudeDeg ?? DEFAULT_ROCK_OPTIONS.amplitudeDeg,
      frequencyHz: settings.periodS == null ? DEFAULT_ROCK_OPTIONS.frequencyHz : 1 / settings.periodS,
      easeBackMs: DEFAULT_ROCK_OPTIONS.easeBackMs,
    };
  }
  return {
    mode: 'spin' as const,
    spinSpeedDegPerSec: settings.periodS == null
      ? DEFAULT_ROCK_OPTIONS.spinSpeedDegPerSec
      : 360 / settings.periodS,
    easeBackMs: DEFAULT_ROCK_OPTIONS.easeBackMs,
  };
}

function tuple(value: ArrayLike<number>): [number, number, number] {
  return [value[0] ?? 0, value[1] ?? 0, value[2] ?? 0];
}

function rotate(
  position: readonly [number, number, number],
  target: readonly [number, number, number],
  axis: MotionAxis,
  angle: number,
): [number, number, number] {
  const x = position[0] - target[0];
  const y = position[1] - target[1];
  const z = position[2] - target[2];
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  if (axis === 'x') return [target[0] + x, target[1] + y * cos - z * sin, target[2] + y * sin + z * cos];
  return [target[0] + x * cos - z * sin, target[1] + y, target[2] + x * sin + z * cos];
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}
