import { describe, expect, it } from 'vitest';
import { parallelHalfWidthCapPx } from '@stereo/geometry';
import {
  eyeViewportFromStage,
  fitDistanceForEyeViewport,
  sideBySideCanvasWidthPx,
} from '../src/eye-window.js';

/** A live Codex card: a 720 CSS px stage, 437 CSS px tall, at 96 px/in. */
const STAGE_WIDTH = 720;
const STAGE_HEIGHT = 437;
const FOV = 45 * Math.PI / 180;
const FILL = 0.86;
const RADIUS = 17.79;

describe('side-by-side canvas width', () => {
  it('caps a wide card at 63 mm per eye', () => {
    const cap = parallelHalfWidthCapPx(96);
    expect(cap).toBeCloseTo(238.11, 2);
    expect(sideBySideCanvasWidthPx(cap, STAGE_WIDTH)).toBe(476);
  });

  it('lets a denser screen use more pixels for the same 63 mm', () => {
    // A 13-inch MacBook Pro is about 113 CSS px/in, so the same physical
    // 63 mm is 280 CSS px rather than 238 and the pair may be wider.
    expect(sideBySideCanvasWidthPx(parallelHalfWidthCapPx(113), STAGE_WIDTH)).toBe(560);
    expect(sideBySideCanvasWidthPx(parallelHalfWidthCapPx(96), STAGE_WIDTH)).toBe(476);
  });

  it('gives way to a letterbox narrower than the cap', () => {
    expect(sideBySideCanvasWidthPx(parallelHalfWidthCapPx(96), 404)).toBe(404);
  });

  it('always returns an even width, because Mol* floors the viewport split', () => {
    for (const available of [401, 403, 475, 721]) {
      expect(sideBySideCanvasWidthPx(parallelHalfWidthCapPx(96), available) % 2).toBe(0);
    }
    expect(sideBySideCanvasWidthPx(null, 721)).toBe(721);
  });

  it('never returns a zero or negative width', () => {
    expect(sideBySideCanvasWidthPx(parallelHalfWidthCapPx(96), 0)).toBe(2);
    expect(sideBySideCanvasWidthPx(parallelHalfWidthCapPx(96), -50)).toBe(2);
  });
});

describe('eye viewport', () => {
  it('halves the capped canvas, not the uncapped stage', () => {
    const eye = eyeViewportFromStage({
      stageWidthPx: 476,
      stageHeightPx: STAGE_HEIGHT,
      availableWidthPx: STAGE_WIDTH,
      sideBySide: true,
      halfCapPx: parallelHalfWidthCapPx(96),
    });
    expect(eye).toEqual({ width: 238, height: STAGE_HEIGHT });
  });

  it('uses the capped width on a frame where the stage style has not landed yet', () => {
    // The cap is written to `stage.style.maxWidth` from the readout pass, so
    // the first frame after a mode switch, a host resize or a dock can still
    // measure the uncapped stage. Fitting against 360 instead of 238 frames
    // the structure half again too large for the window it renders into.
    const eye = eyeViewportFromStage({
      stageWidthPx: STAGE_WIDTH,
      stageHeightPx: STAGE_HEIGHT,
      availableWidthPx: STAGE_WIDTH,
      sideBySide: true,
      halfCapPx: parallelHalfWidthCapPx(96),
    });
    expect(eye.width).toBe(238);
    expect(eye.width).not.toBe(STAGE_WIDTH / 2);
  });

  it('keeps the whole stage in mono and anaglyph, which are not side by side', () => {
    const eye = eyeViewportFromStage({
      stageWidthPx: STAGE_WIDTH,
      stageHeightPx: STAGE_HEIGHT,
      availableWidthPx: STAGE_WIDTH,
      sideBySide: false,
      halfCapPx: null,
    });
    expect(eye).toEqual({ width: STAGE_WIDTH, height: STAGE_HEIGHT });
  });

  it('follows the letterbox down when the host panel is narrower than the cap', () => {
    const eye = eyeViewportFromStage({
      stageWidthPx: 404,
      stageHeightPx: 639,
      availableWidthPx: 404,
      sideBySide: true,
      halfCapPx: parallelHalfWidthCapPx(96),
    });
    expect(eye).toEqual({ width: 202, height: 639 });
  });
});

describe('fit distance', () => {
  const fit = (eyeWidthPx: number): number => {
    const distance = fitDistanceForEyeViewport({
      radius: RADIUS,
      eyeWidthPx,
      eyeHeightPx: STAGE_HEIGHT,
      fovRad: FOV,
      fillFraction: FILL,
    });
    if (distance === undefined) throw new Error('no fit');
    return distance;
  };

  it('stands the camera further back for the capped eye window than for half the stage', () => {
    const capped = fit(238);
    const uncapped = fit(STAGE_WIDTH / 2);
    expect(capped).toBeCloseTo(93.41, 2);
    expect(uncapped).toBeCloseTo(63.18, 2);
    // Fitting against the uncapped stage would render the structure 48 % wider
    // than the eye window it lands in, which is the clipping failure mode.
    expect(capped / uncapped).toBeGreaterThan(1.45);
  });

  it('is limited by the shorter side of the eye viewport', () => {
    // A tall narrow eye window is limited by its width; a wide short one by
    // its height. Both go through the same shorter-side term.
    expect(fitDistanceForEyeViewport({ radius: RADIUS, eyeWidthPx: 200, eyeHeightPx: 600, fovRad: FOV, fillFraction: FILL }))
      .toBeCloseTo(fitDistanceForEyeViewport({ radius: RADIUS, eyeWidthPx: 200, eyeHeightPx: 600, fovRad: FOV, fillFraction: FILL }) ?? 0, 10);
    const wide = fitDistanceForEyeViewport({ radius: RADIUS, eyeWidthPx: 900, eyeHeightPx: 300, fovRad: FOV, fillFraction: FILL });
    const square = fitDistanceForEyeViewport({ radius: RADIUS, eyeWidthPx: 300, eyeHeightPx: 300, fovRad: FOV, fillFraction: FILL });
    expect(wide).toBeCloseTo(square ?? 0, 10);
  });

  it('scales with the structure radius and nothing else', () => {
    const a = fit(238);
    const b = fitDistanceForEyeViewport({ radius: RADIUS * 3, eyeWidthPx: 238, eyeHeightPx: STAGE_HEIGHT, fovRad: FOV, fillFraction: FILL });
    expect(b).toBeCloseTo(a * 3, 6);
  });

  it('declines to frame anything it cannot frame', () => {
    const base = { radius: RADIUS, eyeWidthPx: 238, eyeHeightPx: STAGE_HEIGHT, fovRad: FOV, fillFraction: FILL };
    expect(fitDistanceForEyeViewport({ ...base, radius: 0 })).toBeUndefined();
    expect(fitDistanceForEyeViewport({ ...base, radius: Number.NaN })).toBeUndefined();
    expect(fitDistanceForEyeViewport({ ...base, eyeWidthPx: 0 })).toBeUndefined();
    expect(fitDistanceForEyeViewport({ ...base, eyeHeightPx: 0 })).toBeUndefined();
    expect(fitDistanceForEyeViewport({ ...base, fovRad: 0 })).toBeUndefined();
    expect(fitDistanceForEyeViewport({ ...base, fillFraction: 0 })).toBeUndefined();
  });
});
