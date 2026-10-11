import type {
  CameraSnapshot,
  StereoMode,
  StereoParams,
  StereoSettings,
} from '@stereo/geometry';
import { deriveStereoParams } from '@stereo/geometry';

export interface GeometryAdapter {
  deriveStereoParams(camera: CameraSnapshot, settings: StereoSettings): StereoParams;
}

export interface StereoCameraAdapter {
  /** Apply live world-unit stereo parameters to Mol*'s StereoCamera. */
  setStereo(input: {
    mode: StereoMode;
    enabled: boolean;
    eyeSeparation: number;
    focus: number;
    swapViewportX: boolean;
  }): void;
}

export interface StereoControllerOptions {
  readCamera(): CameraSnapshot;
  camera: StereoCameraAdapter;
  geometry?: GeometryAdapter;
  onParams?(params: StereoParams, settings: StereoSettings): void;
  onDiagnostic?(message: string): void;
  /** Runs before each derived-stereo update, using the rAF timestamp. */
  onFrame?(nowMs: number): void;
}

/**
 * Keeps the Mol* baseline focused on the live orbit target rather than shipped
 * fixed constants. The requestAnimationFrame loop is intentionally the only
 * writer to the camera while it is active.
 */
export class StereoController {
  private readonly geometry: GeometryAdapter;
  private animationFrame: number | undefined;
  private settings: StereoSettings = {
    mode: 'off',
    swapEyes: false,
    depthBudgetArcmin: 20,
    viewingDistanceMm: 500,
    cssPxPerInch: 96,
    devicePixelRatio: 1,
  };
  private lastParams: StereoParams | undefined;
  private lastDiagnostic: string | undefined;

  constructor(private readonly options: StereoControllerOptions) {
    this.geometry = options.geometry ?? { deriveStereoParams };
  }

  start(): void {
    if (this.animationFrame !== undefined) return;
    const step = (nowMs: number) => {
      try {
        this.options.onFrame?.(nowMs);
        this.update();
        this.lastDiagnostic = undefined;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.lastDiagnostic = message;
        this.options.onDiagnostic?.(`Stereo controller paused stereo update: ${message}`);
        // Keep RAF alive and leave the renderer in a safe monoscopic state.
        this.options.camera.setStereo({
          mode: 'off',
          enabled: false,
          eyeSeparation: 0,
          focus: this.lastParams?.focus ?? 1,
          swapViewportX: false,
        });
      } finally {
        this.animationFrame = requestAnimationFrame(step);
      }
    };
    step(performance.now());
  }

  stop(): void {
    if (this.animationFrame !== undefined) cancelAnimationFrame(this.animationFrame);
    this.animationFrame = undefined;
  }

  setSettings(next: Partial<StereoSettings>): void {
    this.settings = { ...this.settings, ...next };
    this.update();
  }

  getSettings(): StereoSettings {
    return { ...this.settings };
  }

  getParams(): StereoParams | undefined {
    return this.lastParams == null ? undefined : { ...this.lastParams };
  }

  getDiagnostic(): string | undefined {
    return this.lastDiagnostic;
  }

  update(): StereoParams {
    const params = this.geometry.deriveStereoParams(this.options.readCamera(), this.settings);
    const stereoEnabled = this.settings.mode === 'parallel'
      || this.settings.mode === 'cross'
      || this.settings.mode === 'anaglyph';
    // Cross is exactly a viewport-X swap of the parallel eye order. swapEyes
    // independently negates that mapping for either side-by-side mode.
    const swapViewportX = this.settings.mode === 'cross'
      ? !this.settings.swapEyes
      : this.settings.mode === 'parallel'
        ? this.settings.swapEyes
        : false;
    this.options.camera.setStereo({
      mode: this.settings.mode,
      enabled: stereoEnabled,
      eyeSeparation: params.eyeSeparation,
      focus: params.focus,
      swapViewportX,
    });
    this.lastParams = params;
    this.options.onParams?.(params, this.settings);
    return params;
  }
}
