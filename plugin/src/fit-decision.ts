/**
 * When the camera has to be reframed, and when a framing is someone's to keep.
 *
 * The viewer refits on a change of geometry and on nothing else: a mode switch
 * halves the eye viewport, a host resize or a dock changes the panel, a style
 * change moves the visible sphere. A person's own orbit or wheel zoom changes
 * none of those, so their framing survives.
 *
 * The subtlety this module exists for is *what the decision is compared
 * against*. The obvious answer, the geometry the previous frame saw, is wrong,
 * and it is the defect observed in a real Codex side panel: the
 * viewer tracked "the geometry I last looked at" rather than "the geometry the
 * camera is actually framed for", and had three branches that recorded the
 * former without doing the fit. A load ended by forgetting the record
 * entirely, so a mode that arrived in the one animation frame between a load's
 * final fit and the next readout was adopted as though it had been fitted. The
 * structure stayed framed for a 878 CSS px mono stage while it rendered into a
 * 238 CSS px eye, 3.7x too close, clipped at every eye-window edge, and no
 * later frame ever refit because the record already said parallel.
 *
 * So the comparison here is against the geometry a *successful fit* used, and
 * only `fitCameraToStage` may record it. A frame that declines to fit records
 * nothing, which is what makes the decision self-correcting: whatever the
 * ordering of loads, modes, resizes and docks, the next frame still sees that
 * the camera is framed for a geometry that is not the current one.
 */

/** The three numbers a fit is a function of. */
export interface FitGeometry {
  /** CSS px of one eye's viewport. Half the capped stage in a pair. */
  eyeWidthPx: number;
  eyeHeightPx: number;
  /** World-unit radius of the visible bounding sphere. */
  radius: number;
}

/**
 * Whether two geometries are the same fit.
 *
 * The viewport is compared to the whole CSS pixel and the radius to a
 * thousandth of an angstrom, because both jitter below that: a fractional
 * layout box and Mol*'s own sphere recomputation would otherwise refit on
 * every frame and the camera would never come to rest.
 */
export function sameFitGeometry(a: FitGeometry | undefined, b: FitGeometry | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  return Math.round(a.eyeWidthPx) === Math.round(b.eyeWidthPx)
    && Math.round(a.eyeHeightPx) === Math.round(b.eyeHeightPx)
    && a.radius.toFixed(3) === b.radius.toFixed(3);
}

/** Human-readable form, for diagnostics and test failure messages. */
export function fitGeometryLabel(geometry: FitGeometry | undefined): string {
  if (geometry === undefined) return 'unfitted';
  return `${Math.round(geometry.eyeWidthPx)}x${Math.round(geometry.eyeHeightPx)}|${geometry.radius.toFixed(3)}`;
}

export interface RefitInput {
  /** The eye viewport and scene radius this frame is looking at. */
  current: FitGeometry;
  /** What the last successful fit framed for, or undefined if none has run. */
  fitted: FitGeometry | undefined;
  /** True while a load or an explicit reset owns the camera. */
  suspended: boolean;
  /** True while the depth fixture's pinned pose must be preserved. */
  pinned: boolean;
  /** True while Mol* is interpolating a camera transition. */
  inTransition: boolean;
}

export type RefitDecision =
  /** Reframe now. */
  | 'refit'
  /** The camera is already framed for this geometry. */
  | 'keep'
  /** Something else owns the camera this frame; ask again next frame. */
  | 'wait';

/**
 * The whole refit rule.
 *
 * `wait` never records anything. That is the property that makes the sequence
 * safe: a frame that waits leaves the decision to the next one, so a change
 * that lands while a load is in flight cannot be lost, and a load that fits
 * the geometry itself simply makes the next frame return `keep`.
 */
export function decideRefit(input: RefitInput): RefitDecision {
  // The fixture's pose is the stimulus the human-evaluation protocol quotes
  // its marker depths from. It is re-pinned by its own path, never reframed.
  if (input.pinned) return 'wait';
  if (sameFitGeometry(input.fitted, input.current)) return 'keep';
  if (input.suspended) return 'wait';
  if (input.inTransition) return 'wait';
  return 'refit';
}
