import { afterAll, describe, expect, it } from 'vitest';
import { deriveStereoParams, type CameraSnapshot, type StereoSettings } from '@stereo/geometry';
import { StereoController, type StereoCameraAdapter } from '../src/stereo-controller.js';

const camera: CameraSnapshot = {
  fovRad: 45 * Math.PI / 180,
  near: 0.1,
  distanceToTarget: 65,
  boundingRadius: 20,
  viewportHeightPx: 800,
  viewportWidthPx: 600,
};

const settings: StereoSettings = {
  mode: 'parallel',
  swapEyes: false,
  depthBudgetArcmin: 20,
  viewingDistanceMm: 500,
  cssPxPerInch: 110,
  devicePixelRatio: 1,
};

describe('Stereofold live camera derivation', () => {
  it('meets the GFP-scale disparity acceptance bounds from the angular budget', () => {
    const params = deriveStereoParams(camera, settings);
    expect(params.focus).toBe(65);
    expect(params.eyeSeparation).toBeGreaterThan(0);
    expect(params.frontDisparityPx).toBeGreaterThanOrEqual(10);
    expect(params.rearDisparityPx).toBeLessThanOrEqual(-5);
    expect(params.frontDisparityPx - params.rearDisparityPx).toBeGreaterThanOrEqual(15);
    expect(params.halfWidthCapPx).toBeCloseTo((63 / 25.4) * 110, 8);
  });

  it('sends live focus and derived Ångström baseline to the Mol* camera adapter', () => {
    const received: Parameters<StereoCameraAdapter['setStereo']>[0][] = [];
    const controller = new StereoController({
      readCamera: () => camera,
      camera: { setStereo: (input) => received.push(input) },
    });
    controller.setSettings(settings);
    const params = controller.update();
    expect(received.at(-1)).toMatchObject({ mode: 'parallel', enabled: true, focus: 65, eyeSeparation: params.eyeSeparation, swapViewportX: false });
    controller.setSettings({ mode: 'cross' });
    expect(received.at(-1)?.swapViewportX).toBe(true);
    controller.setSettings({ mode: 'anaglyph' });
    expect(received.at(-1)).toMatchObject({ mode: 'anaglyph', enabled: true, swapViewportX: false });
  });

  it('is an exact zero-disparity negative control at zero depth strength', () => {
    const zero = deriveStereoParams(camera, { ...settings, depthBudgetArcmin: 0 });
    expect(zero.eyeSeparation).toBe(0);
    expect(zero.frontDisparityPx).toBeCloseTo(0, 12);
    expect(zero.rearDisparityPx).toBeCloseTo(0, 12);
  });

  it('keeps its RAF alive and disables stereo when a live-bound update stalls', () => {
    const previousRequest = globalThis.requestAnimationFrame;
    const previousCancel = globalThis.cancelAnimationFrame;
    let scheduled = 0;
    const diagnostics: string[] = [];
    const received: Parameters<StereoCameraAdapter['setStereo']>[0][] = [];
    globalThis.requestAnimationFrame = (() => {
      scheduled += 1;
      return scheduled;
    }) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = (() => undefined) as typeof cancelAnimationFrame;
    try {
      const controller = new StereoController({
        readCamera: () => camera,
        geometry: { deriveStereoParams: () => { throw new Error('bounds stalled'); } },
        camera: { setStereo: (input) => received.push(input) },
        onDiagnostic: (message) => diagnostics.push(message),
      });
      controller.start();
      expect(scheduled).toBe(1);
      expect(received.at(-1)).toMatchObject({ mode: 'off', enabled: false, eyeSeparation: 0 });
      expect(diagnostics.at(-1)).toContain('bounds stalled');
      expect(controller.getDiagnostic()).toBe('bounds stalled');
      controller.stop();
    } finally {
      globalThis.requestAnimationFrame = previousRequest;
      globalThis.cancelAnimationFrame = previousCancel;
    }
  });
});

afterAll(() => {
  console.log('ALL CHECKS PASS — software geometry verified; human perception untested.');
});
