import { describe, expect, it } from 'vitest';
import {
  FILL_AGREEMENT_TOLERANCE,
  STAGE_FILL_FRACTION,
  disparityRangeCssPx,
  judgeEyeFit,
  judgeFillAgreement,
  judgeMonoFit,
  litBoundingBox,
  modalBackground,
  silhouetteRatio,
  type EyeBoxReport,
} from './eye-box.js';
import type { DecodedPng } from './png.js';

const BACKGROUND: [number, number, number] = [7, 16, 21];
const INK: [number, number, number] = [22, 119, 90];

/** A synthetic canvas with a filled rectangle in each half. */
function frame(options: {
  width: number;
  height: number;
  left?: { x: number; y: number; w: number; h: number };
  right?: { x: number; y: number; w: number; h: number };
}): DecodedPng {
  const { width, height } = options;
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    pixels[i * 4] = BACKGROUND[0];
    pixels[i * 4 + 1] = BACKGROUND[1];
    pixels[i * 4 + 2] = BACKGROUND[2];
    pixels[i * 4 + 3] = 255;
  }
  const paint = (box: { x: number; y: number; w: number; h: number }): void => {
    for (let y = box.y; y < box.y + box.h; y += 1) {
      for (let x = box.x; x < box.x + box.w; x += 1) {
        const index = (y * width + x) * 4;
        pixels[index] = INK[0];
        pixels[index + 1] = INK[1];
        pixels[index + 2] = INK[2];
      }
    }
  };
  if (options.left != null) paint(options.left);
  if (options.right != null) paint(options.right);
  return { width, height, pixels };
}

describe('modalBackground and litBoundingBox', () => {
  it('finds the stage ground and the box drawn on it', () => {
    const png = frame({ width: 40, height: 20, left: { x: 4, y: 6, w: 8, h: 5 } });
    expect(modalBackground(png)).toEqual({ r: 7, g: 16, b: 21 });
    const box = litBoundingBox(png, { x0: 0, x1: 20 }, modalBackground(png));
    expect(box).toEqual({ minX: 4, minY: 6, maxX: 11, maxY: 10, widthPx: 8, heightPx: 5 });
  });

  it('returns null for an eye window with nothing drawn in it', () => {
    const png = frame({ width: 40, height: 20, left: { x: 4, y: 6, w: 8, h: 5 } });
    expect(litBoundingBox(png, { x0: 20, x1: 40 }, modalBackground(png))).toBeNull();
  });
});

describe('judgeEyeFit', () => {
  /*
   * The shape of a correct pair: the same silhouette in each half, well inside
   * both windows, at the same offset inside each.
   */
  const good = frame({
    width: 200,
    height: 120,
    left: { x: 30, y: 40, w: 40, h: 30 },
    right: { x: 130, y: 40, w: 40, h: 30 },
  });

  it('passes a pair framed inside both eye windows', () => {
    const verdict = judgeEyeFit({ png: good, scale: 1 });
    expect(verdict.failures).toEqual([]);
    expect(verdict.pass).toBe(true);
    expect(verdict.left.widthCssPx).toBe(40);
    expect(verdict.right.widthCssPx).toBe(40);
  });

  /*
   * The clipped Codex side panel, reduced to its geometry: the structure is framed for a
   * viewport several times the eye window, so it runs off every edge of both
   * halves. Every margin check has to fire, not just one.
   */
  it('fails a pair that runs off both sides and the top of both eye windows', () => {
    const clipped = frame({
      width: 200,
      height: 120,
      left: { x: 0, y: 0, w: 100, h: 50 },
      right: { x: 100, y: 0, w: 100, h: 50 },
    });
    const verdict = judgeEyeFit({ png: clipped, scale: 1 });
    expect(verdict.pass).toBe(false);
    // Three edges per eye; the bottom band of background is the one that
    // survives, exactly as it does in the screenshot.
    expect(verdict.failures).toHaveLength(6);
    expect(verdict.failures.join(' ')).toContain('left eye, left edge');
    expect(verdict.failures.join(' ')).toContain('right eye, right edge');
    expect(verdict.failures.join(' ')).toContain('left eye, top edge');
    expect(verdict.failures.join(' ')).not.toContain('bottom edge');
  });

  /*
   * The measurement takes the stage ground to be the plurality colour of the
   * frame, which holds while the fit fills 0.86 of the shorter side and the
   * silhouette is smaller than the sphere. A frame with no ground left at all
   * is outside what the measurement can read, and the result is no lit pixel
   * rather than a wrong box.
   */
  it('reports no lit pixel rather than a wrong box when nothing is background', () => {
    const solid = frame({
      width: 200,
      height: 120,
      left: { x: 0, y: 0, w: 100, h: 120 },
      right: { x: 100, y: 0, w: 100, h: 120 },
    });
    const verdict = judgeEyeFit({ png: solid, scale: 1 });
    expect(verdict.pass).toBe(false);
    expect(verdict.failures).toEqual([
      'left eye window contains no lit pixel',
      'right eye window contains no lit pixel',
    ]);
  });

  it('fails an eye window that drew nothing at all', () => {
    const verdict = judgeEyeFit({
      png: frame({ width: 200, height: 120, left: { x: 30, y: 40, w: 40, h: 30 } }),
      scale: 1,
    });
    expect(verdict.pass).toBe(false);
    expect(verdict.failures).toContain('right eye window contains no lit pixel');
  });

  /*
   * The world-frame eye translation as a box: both eyes are inside their windows, but each has
   * moved outward, so the pair is wider than the interocular cap allows even
   * though nothing is clipped yet.
   */
  it('fails a pair whose two images have drifted apart inside their windows', () => {
    const drifted = frame({
      width: 200,
      height: 120,
      left: { x: 10, y: 40, w: 40, h: 30 },
      right: { x: 150, y: 40, w: 40, h: 30 },
    });
    const verdict = judgeEyeFit({ png: drifted, scale: 1 });
    expect(verdict.pass).toBe(false);
    expect(verdict.pairOffsetDeltaCssPx.x).toBe(40);
    expect(verdict.failures.join(' ')).toContain('apart horizontally');
  });

  it('fails a vertical offset between the eyes, which parallax cannot produce', () => {
    const skewed = frame({
      width: 200,
      height: 120,
      left: { x: 30, y: 30, w: 40, h: 30 },
      right: { x: 130, y: 50, w: 40, h: 30 },
    });
    const verdict = judgeEyeFit({ png: skewed, scale: 1 });
    expect(verdict.pass).toBe(false);
    expect(verdict.failures.join(' ')).toContain('apart vertically');
  });

  it('reports CSS px, not image px, at a device pixel ratio of two', () => {
    const verdict = judgeEyeFit({ png: good, scale: 2 });
    expect(verdict.left.widthCssPx).toBe(20);
    expect(verdict.left.heightCssPx).toBe(15);
    expect(verdict.left.marginLeftCssPx).toBe(15);
  });

  /*
   * The two eyes see different silhouettes of the same object, so their boxes
   * legitimately differ in width by up to the predicted disparity. The height
   * bound stays at two pixels either way.
   */
  it('allows a width difference the predicted disparity accounts for', () => {
    const disparate = frame({
      width: 200,
      height: 120,
      left: { x: 30, y: 40, w: 46, h: 30 },
      right: { x: 130, y: 40, w: 40, h: 30 },
    });
    expect(judgeEyeFit({ png: disparate, scale: 1 }).pass).toBe(false);
    const verdict = judgeEyeFit({ png: disparate, scale: 1, disparityRangeCssPx: 19.9 });
    expect(verdict.sizeDeltaCssPx.width).toBe(6);
    expect(verdict.failures.join(' ')).not.toContain('widths differ');
  });

  it('still fails a width difference larger than the disparity can explain', () => {
    const scaled = frame({
      width: 200,
      height: 120,
      left: { x: 20, y: 40, w: 60, h: 30 },
      right: { x: 130, y: 40, w: 30, h: 30 },
    });
    const verdict = judgeEyeFit({ png: scaled, scale: 1, disparityRangeCssPx: 19.9 });
    expect(verdict.failures.join(' ')).toContain('widths differ');
  });
});

describe('judgeMonoFit', () => {
  it('passes a mono frame with margin on every side', () => {
    const png = frame({ width: 200, height: 120, left: { x: 30, y: 20, w: 100, h: 60 } });
    expect(judgeMonoFit({ png, scale: 1 }).pass).toBe(true);
  });

  it('fails a mono frame that touches an edge', () => {
    const png = frame({ width: 200, height: 120, left: { x: 0, y: 20, w: 100, h: 60 } });
    const verdict = judgeMonoFit({ png, scale: 1 });
    expect(verdict.pass).toBe(false);
    expect(verdict.failures.join(' ')).toContain('mono left edge');
  });
});

describe('disparityRangeCssPx', () => {
  it('reads the front and rear predictions out of the drawer readout', () => {
    expect(disparityRangeCssPx('B 16.285 Å · F 168.52 Å · front +10.99 px / +20.0′ · rear -8.90 px / -16.2′'))
      .toBeCloseTo(19.89, 6);
  });

  it('is zero at depth zero, where the eyes are geometrically identical', () => {
    expect(disparityRangeCssPx('B 0.000 Å · F 52.99 Å · front +0.00 px / +0.0′ · rear +0.00 px / +0.0′')).toBe(0);
  });

  it('gives up rather than guessing on a readout it cannot parse', () => {
    expect(disparityRangeCssPx('')).toBeUndefined();
    expect(disparityRangeCssPx('Stereo controller paused stereo update: boom')).toBeUndefined();
  });
});

/* ------------------------------------- the panel's own fill, checked */

function boxReport(width: number, height: number): EyeBoxReport {
  return {
    box: { minX: 0, minY: 0, maxX: width - 1, maxY: height - 1, widthPx: width, heightPx: height },
    marginLeftCssPx: 40,
    marginRightCssPx: 40,
    marginTopCssPx: 40,
    marginBottomCssPx: 40,
    offsetXCssPx: 0,
    offsetYCssPx: 0,
    widthCssPx: width,
    heightCssPx: height,
  };
}

const EMPTY_REPORT: EyeBoxReport = {
  box: null,
  marginLeftCssPx: 0,
  marginRightCssPx: 0,
  marginTopCssPx: 0,
  marginBottomCssPx: 0,
  offsetXCssPx: 0,
  offsetYCssPx: 0,
  widthCssPx: 0,
  heightCssPx: 0,
};

describe('silhouetteRatio', () => {
  it('measures the larger eye against the eye window shorter side', () => {
    // A 130 x 104 CSS px lit box in a 238 x 799 window: the shorter side is
    // 238, which is the number the viewer's fill is measured against too.
    expect(silhouetteRatio(boxReport(129.5, 104), boxReport(130.5, 104), { width: 238, height: 799 }))
      .toBeCloseTo(130.5 / 238, 10);
    expect(silhouetteRatio(boxReport(100, 300), boxReport(100, 290), { width: 238, height: 799 }))
      .toBeCloseTo(300 / 238, 10);
  });

  it('is null when no eye contains a lit pixel, or the window has no area', () => {
    expect(silhouetteRatio(EMPTY_REPORT, EMPTY_REPORT, { width: 238, height: 799 })).toBeNull();
    expect(silhouetteRatio(boxReport(10, 10), EMPTY_REPORT, { width: 0, height: 799 })).toBeNull();
    // One empty eye still measures the other: a half-drawn pair is a defect
    // the margin claims catch, not a reason to stop measuring the fill.
    expect(silhouetteRatio(boxReport(120, 100), EMPTY_REPORT, { width: 238, height: 799 }))
      .toBeCloseTo(120 / 238, 10);
  });
});

describe('judgeFillAgreement', () => {
  it('accepts a correct fit: 0.86 reported, half of it visible as silhouette', () => {
    // 1CRN's box measures about 0.50 of its bounding-sphere diameter, so a
    // correctly fitted frame reports 0.86 and measures about 0.43.
    expect(judgeFillAgreement({ fill: STAGE_FILL_FRACTION, silhouetteRatio: 0.4345 })).toEqual([]);
    expect(judgeFillAgreement({ fill: 0.8593, silhouetteRatio: 0.5483 })).toEqual([]);
  });

  it('rejects the clipping photographed in the Codex side panel', () => {
    // Fitted for the mono stage, rendered into one capped eye: 0.86 x 799/238.
    const failures = judgeFillAgreement({ fill: 2.887, silhouetteRatio: 1.44 });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/exceeds 0\.86/u);
  });

  it('rejects a panel describing a frame it did not draw', () => {
    // More silhouette on screen than the sphere the panel says it framed.
    const failures = judgeFillAgreement({ fill: 0.4, silhouetteRatio: 1.2 });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/below the measured silhouette ratio/u);
  });

  it('rejects a frame with no reported fill at all', () => {
    expect(judgeFillAgreement({ fill: undefined, silhouetteRatio: 0.43 }))
      .toEqual(['the panel reported no diagnostics.camera.fill for this frame']);
  });

  it('allows the stated tolerance above the target and nothing at all below the silhouette', () => {
    const upper = STAGE_FILL_FRACTION * (1 + FILL_AGREEMENT_TOLERANCE);
    expect(judgeFillAgreement({ fill: upper, silhouetteRatio: 0.43 })).toEqual([]);
    expect(judgeFillAgreement({ fill: upper * 1.0001, silhouetteRatio: 0.43 })).toHaveLength(1);
    // The lower bound is the geometric fact, so it is exact: an earlier
    // 5% tolerance let a reported 0.86 pass against a measured 0.90, which is the false
    // clean this check exists to refuse.
    const silhouette = 0.9;
    expect(judgeFillAgreement({ fill: silhouette, silhouetteRatio: silhouette })).toEqual([]);
    expect(judgeFillAgreement({ fill: 0.86, silhouetteRatio: silhouette })).toHaveLength(1);
    expect(judgeFillAgreement({ fill: silhouette * (1 - FILL_AGREEMENT_TOLERANCE), silhouetteRatio: silhouette })).toHaveLength(1);
  });

  it('still checks the upper bound when nothing was lit to measure against', () => {
    expect(judgeFillAgreement({ fill: 0.86, silhouetteRatio: null })).toEqual([]);
    expect(judgeFillAgreement({ fill: 3.1, silhouetteRatio: null })).toHaveLength(1);
  });
});
