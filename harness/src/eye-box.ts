/**
 * Where the structure actually landed inside each eye's window.
 *
 * The plugin's contract is that a side-by-side pair is framed inside the
 * capped eye window at `STAGE_FILL_FRACTION`, so a correct render leaves black
 * margin on all four sides of both eye images. A Codex side panel on an
 * earlier build broke that: the molecule was cut by hard vertical edges at the far
 * left, the far right, and both sides of the centre seam. Nothing in the
 * harness measured it, because the panel screenshot was only checked for
 * document overflow and clipped controls.
 *
 * This module is the measurement, kept pure so the thresholds can be tested
 * without a browser. It works on the drawing-buffer pixels of the Mol* canvas
 * and reports in CSS px, because every number in the plugin's fit is CSS px.
 */

import type { DecodedPng } from './png.js';

export type Box = {
  /** Inclusive pixel bounds inside the eye window, in image px. */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  widthPx: number;
  heightPx: number;
};

export type EyeWindow = {
  /** Image-px column range of this eye, `[x0, x1)`. */
  x0: number;
  x1: number;
};

/**
 * Modal RGB of the frame, which for a Mol* stage is the renderer background.
 *
 * Taken over the whole canvas rather than per eye: both eyes draw on the same
 * ground, and a per-eye mode would drift if one eye happened to be more than
 * half covered.
 *
 * It assumes the ground is the plurality colour of the frame, which holds
 * while the fit bounds the sphere at `STAGE_FILL_FRACTION` of the shorter side
 * and the silhouette is smaller than the sphere. A frame with no ground left
 * reports the ink as the ground, and the box comes back null rather than
 * wrong; `judgeEyeFit` fails such a frame.
 */
export function modalBackground(png: DecodedPng): { r: number; g: number; b: number } {
  const histogram = new Map<number, number>();
  const { pixels } = png;
  for (let i = 0; i < pixels.length; i += 4) {
    const key = (pixels[i]! << 16) | (pixels[i + 1]! << 8) | pixels[i + 2]!;
    histogram.set(key, (histogram.get(key) ?? 0) + 1);
  }
  let background = 0;
  let best = -1;
  for (const [key, count] of histogram) {
    if (count > best) {
      best = count;
      background = key;
    }
  }
  return { r: (background >> 16) & 0xff, g: (background >> 8) & 0xff, b: background & 0xff };
}

/**
 * Bounding box of the lit pixels inside one eye window.
 *
 * "Lit" is a Manhattan distance from the modal background, the same test
 * `canvasStats` uses for `inkFraction`, so the two agree about what counts as
 * ink. The threshold is deliberately above Mol*'s background gradient and its
 * antialiasing fringe: a threshold of 1 would trace the fringe of the
 * background itself and report the whole window.
 */
export function litBoundingBox(
  png: DecodedPng,
  window: EyeWindow,
  background: { r: number; g: number; b: number },
  threshold = 24,
): Box | null {
  const { width, height, pixels } = png;
  const x0 = Math.max(0, Math.min(width, window.x0));
  const x1 = Math.max(x0, Math.min(width, window.x1));
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = x0; x < x1; x += 1) {
      const index = (row + x) * 4;
      const distance = Math.abs(pixels[index]! - background.r)
        + Math.abs(pixels[index + 1]! - background.g)
        + Math.abs(pixels[index + 2]! - background.b);
      if (distance <= threshold) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { minX, minY, maxX, maxY, widthPx: maxX - minX + 1, heightPx: maxY - minY + 1 };
}

/** One eye's box expressed against its own window, in CSS px. */
export type EyeBoxReport = {
  /** Null when the eye window contains no lit pixel at all. */
  box: Box | null;
  /** CSS px from each window edge to the nearest lit pixel. */
  marginLeftCssPx: number;
  marginRightCssPx: number;
  marginTopCssPx: number;
  marginBottomCssPx: number;
  /** CSS px from the window centre to the box centre; sign follows the axis. */
  offsetXCssPx: number;
  offsetYCssPx: number;
  widthCssPx: number;
  heightCssPx: number;
};

function report(box: Box | null, window: EyeWindow, height: number, scale: number): EyeBoxReport {
  if (box == null) {
    return {
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
  }
  const windowCentreX = (window.x0 + window.x1 - 1) / 2;
  const windowCentreY = (height - 1) / 2;
  return {
    box,
    marginLeftCssPx: (box.minX - window.x0) / scale,
    marginRightCssPx: (window.x1 - 1 - box.maxX) / scale,
    marginTopCssPx: box.minY / scale,
    marginBottomCssPx: (height - 1 - box.maxY) / scale,
    offsetXCssPx: ((box.minX + box.maxX) / 2 - windowCentreX) / scale,
    offsetYCssPx: ((box.minY + box.maxY) / 2 - windowCentreY) / scale,
    widthCssPx: box.widthPx / scale,
    heightCssPx: box.heightPx / scale,
  };
}

export type EyeFitThresholds = {
  /** CSS px of black that must survive on every edge of every eye image. */
  edgeMarginCssPx: number;
  /** CSS px the two eye images may differ in width or height. */
  sizeAgreementCssPx: number;
  /** CSS px the two eye images' offsets inside their own windows may differ. */
  pairOffsetCssPx: number;
};

export const DEFAULT_EYE_FIT_THRESHOLDS: EyeFitThresholds = {
  edgeMarginCssPx: 2,
  sizeAgreementCssPx: 2,
  pairOffsetCssPx: 4,
};

/**
 * Read the predicted disparity range out of the viewer's own camera readout.
 *
 * The drawer prints `B … Å · F … Å · front +10.99 px / +20.0′ · rear -8.90 px
 * / -16.2′`. The front and rear numbers are how far a point at the near and
 * far edge of the visible sphere moves between the eyes, so their span is the
 * most the two eye images' *bounding boxes* can legitimately differ in width:
 * a point that bounds the box in one eye is displaced by up to that much in
 * the other. Parallax is horizontal only, so nothing here loosens the height.
 */
export function disparityRangeCssPx(cameraStatus: string): number | undefined {
  const front = /front\s*([+-]?[0-9]+(?:\.[0-9]+)?)\s*px/u.exec(cameraStatus);
  const rear = /rear\s*([+-]?[0-9]+(?:\.[0-9]+)?)\s*px/u.exec(cameraStatus);
  if (front == null || rear == null) return undefined;
  const frontPx = Number(front[1]);
  const rearPx = Number(rear[1]);
  if (!Number.isFinite(frontPx) || !Number.isFinite(rearPx)) return undefined;
  return Math.abs(frontPx - rearPx);
}

export type EyeFitVerdict = {
  left: EyeBoxReport;
  right: EyeBoxReport;
  /** CSS px of disagreement between the eyes, reported whether it fails or not. */
  sizeDeltaCssPx: { width: number; height: number };
  pairOffsetDeltaCssPx: { x: number; y: number };
  pass: boolean;
  failures: string[];
};

/**
 * Judge one side-by-side frame against the plugin's framing contract.
 *
 * Three separate claims, because they fail for different reasons:
 *
 * 1. **Margin.** Every edge of both eye images is at least
 *    `edgeMarginCssPx` inside its own window. This is the one the Codex side
 *    panel broke, and it is what "the fit ran in the wrong geometry" looks
 *    like in pixels.
 * 2. **Size agreement.** The two eyes are the same object at the same
 *    distance, so their silhouettes are the same size. The heights are held
 *    to two pixels, because parallax is horizontal and a vertical mismatch is
 *    the signature of a world-frame eye translation. The widths are held to
 *    the predicted front-to-rear disparity instead, because a point that
 *    bounds the box in one eye really is displaced by that much in the other;
 *    on 1CRN at the shipped 20 arcminutes that is 20 CSS px of allowance
 *    against a measured 2.5. A gross disagreement still means one eye is being
 *    scaled or cropped differently, which is the odd-width rasterisation bug
 *    `eye-window.ts` guards.
 * 3. **Pair offset.** Each eye's image sits at the same place inside its own
 *    window. This is the outward displacement stated as a box rather than a
 *    centroid: a pair that drifts apart fails here before it clips.
 *
 * The absolute offset from the window centre is reported but not asserted.
 * The fit centres the *bounding sphere*, and a molecule is not centred inside
 * its own bounding sphere, so that number is a property of the structure, not
 * of the fit. Asserting it would make the gate depend on which PDB was loaded.
 */
export function judgeEyeFit(input: {
  png: DecodedPng;
  /** Image px per CSS px, i.e. the device pixel ratio of the canvas. */
  scale: number;
  thresholds?: EyeFitThresholds;
  /**
   * Predicted front-to-rear disparity for the settings in force, if it is
   * known. It widens the *width* agreement bound and nothing else.
   */
  disparityRangeCssPx?: number;
}): EyeFitVerdict {
  const { png, scale } = input;
  const thresholds = input.thresholds ?? DEFAULT_EYE_FIT_THRESHOLDS;
  const widthAgreementCssPx = Math.max(
    thresholds.sizeAgreementCssPx,
    input.disparityRangeCssPx ?? 0,
  );
  const background = modalBackground(png);
  // Mol* splits a stereo viewport with `Math.floor(width / 2)` and gives the
  // leftover column to the right eye (mol-canvas3d/camera/stereo.js:103-107),
  // so the seam is at the floor, not at the midpoint.
  const seam = Math.floor(png.width / 2);
  const leftWindow: EyeWindow = { x0: 0, x1: seam };
  const rightWindow: EyeWindow = { x0: seam, x1: png.width };
  const left = report(litBoundingBox(png, leftWindow, background), leftWindow, png.height, scale);
  const right = report(litBoundingBox(png, rightWindow, background), rightWindow, png.height, scale);

  const failures: string[] = [];
  if (left.box == null) failures.push('left eye window contains no lit pixel');
  if (right.box == null) failures.push('right eye window contains no lit pixel');

  const edges: Array<[string, 'left' | 'right', number]> = [
    ['left eye, left edge', 'left', left.marginLeftCssPx],
    ['left eye, right edge', 'left', left.marginRightCssPx],
    ['left eye, top edge', 'left', left.marginTopCssPx],
    ['left eye, bottom edge', 'left', left.marginBottomCssPx],
    ['right eye, left edge', 'right', right.marginLeftCssPx],
    ['right eye, right edge', 'right', right.marginRightCssPx],
    ['right eye, top edge', 'right', right.marginTopCssPx],
    ['right eye, bottom edge', 'right', right.marginBottomCssPx],
  ];
  for (const [label, eye, margin] of edges) {
    const box = eye === 'left' ? left.box : right.box;
    if (box == null) continue;
    if (margin < thresholds.edgeMarginCssPx) {
      failures.push(`${label}: ${margin.toFixed(2)} CSS px of margin, needs ${thresholds.edgeMarginCssPx}`);
    }
  }

  const sizeDeltaCssPx = {
    width: Math.abs(left.widthCssPx - right.widthCssPx),
    height: Math.abs(left.heightCssPx - right.heightCssPx),
  };
  const pairOffsetDeltaCssPx = {
    x: Math.abs(left.offsetXCssPx - right.offsetXCssPx),
    y: Math.abs(left.offsetYCssPx - right.offsetYCssPx),
  };
  if (left.box != null && right.box != null) {
    if (sizeDeltaCssPx.width > widthAgreementCssPx) {
      failures.push(`eye image widths differ by ${sizeDeltaCssPx.width.toFixed(2)} CSS px, limit ${widthAgreementCssPx.toFixed(2)}`);
    }
    if (sizeDeltaCssPx.height > thresholds.sizeAgreementCssPx) {
      failures.push(`eye image heights differ by ${sizeDeltaCssPx.height.toFixed(2)} CSS px, limit ${thresholds.sizeAgreementCssPx}`);
    }
    if (pairOffsetDeltaCssPx.x > thresholds.pairOffsetCssPx) {
      failures.push(`eye images sit ${pairOffsetDeltaCssPx.x.toFixed(2)} CSS px apart horizontally inside their windows, limit ${thresholds.pairOffsetCssPx}`);
    }
    if (pairOffsetDeltaCssPx.y > thresholds.pairOffsetCssPx) {
      failures.push(`eye images sit ${pairOffsetDeltaCssPx.y.toFixed(2)} CSS px apart vertically inside their windows, limit ${thresholds.pairOffsetCssPx}`);
    }
  }

  return { left, right, sizeDeltaCssPx, pairOffsetDeltaCssPx, pass: failures.length === 0, failures };
}

/**
 * The same three claims for a mono frame, where the whole canvas is one eye.
 *
 * Only the margin claim applies: there is no second eye to agree with. It is
 * kept here so a scenario that ends in mono is measured by the same code.
 */
export function judgeMonoFit(input: {
  png: DecodedPng;
  scale: number;
  thresholds?: EyeFitThresholds;
}): EyeFitVerdict {
  const { png, scale } = input;
  const thresholds = input.thresholds ?? DEFAULT_EYE_FIT_THRESHOLDS;
  const background = modalBackground(png);
  const window: EyeWindow = { x0: 0, x1: png.width };
  const only = report(litBoundingBox(png, window, background), window, png.height, scale);
  const failures: string[] = [];
  if (only.box == null) {
    failures.push('the stage contains no lit pixel');
  } else {
    const edges: Array<[string, number]> = [
      ['left edge', only.marginLeftCssPx],
      ['right edge', only.marginRightCssPx],
      ['top edge', only.marginTopCssPx],
      ['bottom edge', only.marginBottomCssPx],
    ];
    for (const [label, margin] of edges) {
      if (margin < thresholds.edgeMarginCssPx) {
        failures.push(`mono ${label}: ${margin.toFixed(2)} CSS px of margin, needs ${thresholds.edgeMarginCssPx}`);
      }
    }
  }
  return {
    left: only,
    right: only,
    sizeDeltaCssPx: { width: 0, height: 0 },
    pairOffsetDeltaCssPx: { x: 0, y: 0 },
    pass: failures.length === 0,
    failures,
  };
}

/* ------------------------------------------- the panel's own fill, checked */

/**
 * The fill the viewer's camera fit solves for. Mirrors `STAGE_FILL_FRACTION`
 * in `plugin/src/viewer.ts`, restated here because the harness must be able to
 * disagree with the plugin rather than import its opinion.
 */
export const STAGE_FILL_FRACTION = 0.86;

/** How far the reported fill and the measured silhouette may diverge. */
export const FILL_AGREEMENT_TOLERANCE = 0.05;

/**
 * How much of the eye window's shorter side the lit silhouette takes up.
 *
 * The measurement counterpart of `diagnostics.camera.fill`, which is the
 * *sphere* the fit framed. The silhouette is inside its bounding sphere, so
 * this is always the smaller of the two: a structure never fills its own
 * bounding sphere in every direction at once, and 1CRN's box measures 0.50 of
 * its sphere diameter in the harness's default pose.
 *
 * Both eyes are measured and the larger is returned, because the check that
 * follows is a bound: it must hold for whichever eye reaches furthest.
 */
export function silhouetteRatio(
  left: EyeBoxReport,
  right: EyeBoxReport,
  eyeWindow: { width: number; height: number },
): number | null {
  const shorter = Math.min(eyeWindow.width, eyeWindow.height);
  if (!(shorter > 0)) return null;
  const extents = [left, right]
    .filter((report) => report.box != null)
    .map((report) => Math.max(report.widthCssPx, report.heightCssPx));
  if (extents.length === 0) return null;
  return Math.max(...extents) / shorter;
}

/**
 * Whether the number the panel reported agrees with the pixels on screen.
 *
 * This is the check that makes `diagnostics.camera.fill` usable as evidence
 * from a host nobody can measure. Two bounds, and they are one-sided for
 * different reasons:
 *
 * - `fill` must be at least the silhouette ratio, exactly, with no allowance
 *   below it. The silhouette is drawn inside the sphere the fill describes, so
 *   the inequality is a geometric fact rather than a measurement that needs
 *   slack. A reported fill *below* what is visibly on screen means the panel
 *   is describing a different camera, a different eye window or a different
 *   structure from the one it drew, and every conclusion drawn from it in a
 *   live host would be wrong. An earlier 5% tolerance here let a reported
 *   0.86 pass against a measured 0.90.
 * - `fill` must be at most `STAGE_FILL_FRACTION` plus the tolerance, because
 *   that is what a correct fit solves for. Above it, the structure is being
 *   drawn larger than the window the fit was told about, which is the defect
 *   photographed twice in a Codex side panel.
 *
 * A frame that reported no fill at all fails too: the channel out of a live
 * webview not working is the one failure this harness cannot tolerate.
 */
export function judgeFillAgreement(input: {
  fill: number | undefined;
  silhouetteRatio: number | null;
  tolerance?: number;
  target?: number;
  /** Which reading this is, for the failure text: `fill` or `fillFromDrawPass`. */
  label?: string;
}): string[] {
  const tolerance = input.tolerance ?? FILL_AGREEMENT_TOLERANCE;
  const target = input.target ?? STAGE_FILL_FRACTION;
  const label = input.label ?? 'fill';
  const failures: string[] = [];
  if (input.fill === undefined) {
    failures.push(`the panel reported no diagnostics.camera.${label} for this frame`);
    return failures;
  }
  const upper = target * (1 + tolerance);
  if (input.fill > upper) {
    failures.push(`reported ${label} ${input.fill.toFixed(4)} exceeds ${target} + ${(tolerance * 100).toFixed(0)}% (${upper.toFixed(4)})`);
  }
  if (input.silhouetteRatio != null && input.fill < input.silhouetteRatio) {
    failures.push(`reported ${label} ${input.fill.toFixed(4)} is below the measured silhouette ratio ${input.silhouetteRatio.toFixed(4)}; the panel is describing a frame it did not draw`);
  }
  return failures;
}
