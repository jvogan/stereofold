import type { CameraSnapshot } from '@stereo/geometry';

export interface MolstarCameraLike {
  state: {
    fov: number;
    position: ArrayLike<number>;
    target: ArrayLike<number>;
  };
  near: number;
}

export interface BoundingSphereLike {
  center: ArrayLike<number>;
  radius: number;
}

export interface CssDensityReading {
  cssPxPerInch: number;
  estimated: boolean;
}

function distance(a: ArrayLike<number>, b: ArrayLike<number>): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/**
 * Convert Mol* camera state plus CSS layout dimensions to the geometry
 * contract. The optional depth bounds are measured along the camera-to-target
 * axis, so a panned visible sphere is budgeted at its actual near/far depths.
 */
export function snapshotFromMolstar(
  camera: MolstarCameraLike,
  visibleSphere: BoundingSphereLike,
  viewportWidthPx: number,
  viewportHeightPx: number,
): CameraSnapshot {
  const axis = [
    camera.state.target[0] - camera.state.position[0],
    camera.state.target[1] - camera.state.position[1],
    camera.state.target[2] - camera.state.position[2],
  ];
  const focus = Math.hypot(axis[0], axis[1], axis[2]);
  if (!(focus > 0)) throw new RangeError('Mol* camera position and target must differ.');
  const direction = [axis[0] / focus, axis[1] / focus, axis[2] / focus];
  const centerFromCamera = [
    visibleSphere.center[0] - camera.state.position[0],
    visibleSphere.center[1] - camera.state.position[1],
    visibleSphere.center[2] - camera.state.position[2],
  ];
  const centerDepth = dot(centerFromCamera, direction);
  return {
    fovRad: camera.state.fov,
    near: camera.near,
    distanceToTarget: focus,
    boundingRadius: Math.max(0, visibleSphere.radius),
    viewportHeightPx: Math.max(1, viewportHeightPx),
    viewportWidthPx: Math.max(1, viewportWidthPx),
    boundingDepthNear: centerDepth - Math.max(0, visibleSphere.radius),
    boundingDepthFar: centerDepth + Math.max(0, visibleSphere.radius),
  };
}

/**
 * Read the CSS-pixel inch, which in every browser is 96 and cannot be measured.
 *
 * CSS defines `1in` as exactly `96px`, so this probe is a unit conversion that
 * happens to run in the DOM, not a measurement of the screen. It is kept
 * because it is the only reading available without asking, and because a user
 * agent that ever redefined the CSS inch would show up here; `estimated` is
 * therefore true in practice always, and the drawer says "assumed" rather than
 * "estimated" so nobody reads the 63 mm cap as a physical guarantee.
 *
 * The consequence in pixels: at the assumed 96 px/in a 63 mm eye window is 238
 * CSS px, so a side-by-side pair is letterboxed to 476 CSS px however wide the
 * card is. On a screen that is really about 113 CSS px/in (a 13-inch MacBook
 * Pro at its default scaling) the same 63 mm is 280 CSS px and the pair could
 * be 560 CSS px wide. Assuming 96 on that screen makes the rendered pair
 * physically 53 mm per eye rather than 63 mm, which is inside the interocular
 * distance and so still fusable, only smaller than it needs to be. The error
 * runs the safe way; entering the real value buys back the pixels.
 */
export function measureCssDensity(documentLike: {
  createElement(tagName: string): {
    style: { cssText: string };
    getBoundingClientRect(): { width: number };
    remove(): void;
  };
  body: { append(element: unknown): void };
}): CssDensityReading {
  const probe = documentLike.createElement('div');
  probe.style.cssText = 'position:absolute;visibility:hidden;width:1in;height:1px;';
  documentLike.body.append(probe);
  const cssPxPerInch = probe.getBoundingClientRect().width || 96;
  probe.remove();
  return { cssPxPerInch, estimated: cssPxPerInch === 96 };
}

export function cssPxToMillimetres(cssPx: number, cssPxPerInch: number): number {
  if (!Number.isFinite(cssPx) || cssPx < 0) throw new RangeError('cssPx must be non-negative and finite.');
  if (!Number.isFinite(cssPxPerInch) || cssPxPerInch <= 0) throw new RangeError('cssPxPerInch must be positive and finite.');
  return cssPx * 25.4 / cssPxPerInch;
}
