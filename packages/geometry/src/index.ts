/**
 * Pure, renderer-independent stereo geometry for Mol* scenes.
 *
 * Coordinates accepted by the projection helpers are camera-frame coordinates
 * with +z pointing from the central camera into the scene, +x to the right,
 * and +y up. This positive-depth convention keeps the public geometry formula
 * readable. The plugin's build-local Mol* patch uses the native asymmetric
 * frustum signs but corrects the native eye-translation signs so the eyes
 * converge at `focus`.
 */

export const StereoMode = Object.freeze({
    Off: 'off',
    Parallel: 'parallel',
    Cross: 'cross',
    Anaglyph: 'anaglyph',
} as const);

export type StereoMode = (typeof StereoMode)[keyof typeof StereoMode];

export interface StereoSettings {
    mode: StereoMode;
    swapEyes: boolean;
    depthBudgetArcmin: number;
    viewingDistanceMm: number;
    cssPxPerInch: number;
    devicePixelRatio: number;
}

export interface CameraSnapshot {
    fovRad: number;
    near: number;
    distanceToTarget: number;
    boundingRadius: number;
    viewportHeightPx: number;
    viewportWidthPx: number;
    /** Optional camera-axis bounds of the visible sphere, in positive depth. */
    boundingDepthNear?: number;
    boundingDepthFar?: number;
}

export interface StereoParams {
    eyeSeparation: number;
    focus: number;
    halfWidthCapPx: number | null;
    frontDisparityPx: number;
    rearDisparityPx: number;
}

export interface StereoPoint {
    x: number;
    y: number;
    z: number;
}

export type StereoEye = 'left' | 'right';

export interface ProjectedPoint {
    /** Position in the eye's own viewport, in CSS pixels. */
    xPx: number;
    yPx: number;
    /** Positive camera-frame depth used for the projection. */
    z: number;
    eye: StereoEye;
}

export interface StereoProjection {
    left: ProjectedPoint;
    right: ProjectedPoint;
    /** left.xPx - right.xPx, after the optional display eye swap. */
    disparityPx: number;
}

export interface PredictedDisparityRow {
    z: number;
    leftPx: number;
    rightPx: number;
    disparityPx: number;
}

export const DEFAULT_STEREO_SETTINGS: StereoSettings = Object.freeze({
    mode: StereoMode.Parallel,
    swapEyes: false,
    depthBudgetArcmin: 20,
    viewingDistanceMm: 500,
    cssPxPerInch: 110,
    devicePixelRatio: 1,
});

const MM_PER_INCH = 25.4;
const INTEROCULAR_CAP_MM = 63;

function assertFinite(name: string, value: number): void {
    if (!Number.isFinite(value)) {
        throw new RangeError(`${name} must be finite`);
    }
}

function assertPositive(name: string, value: number): void {
    assertFinite(name, value);
    if (value <= 0) {
        throw new RangeError(`${name} must be greater than zero`);
    }
}

function assertCamera(cam: CameraSnapshot): void {
    assertFinite('fovRad', cam.fovRad);
    if (cam.fovRad <= 0 || cam.fovRad >= Math.PI) {
        throw new RangeError('fovRad must be between 0 and π');
    }
    assertPositive('near', cam.near);
    assertPositive('distanceToTarget', cam.distanceToTarget);
    assertFinite('boundingRadius', cam.boundingRadius);
    if (cam.boundingRadius < 0) throw new RangeError('boundingRadius must not be negative');
    if (cam.boundingDepthNear !== undefined) assertFinite('boundingDepthNear', cam.boundingDepthNear);
    if (cam.boundingDepthFar !== undefined) assertFinite('boundingDepthFar', cam.boundingDepthFar);
    if (cam.boundingDepthNear !== undefined && cam.boundingDepthFar !== undefined
        && cam.boundingDepthFar < cam.boundingDepthNear) {
        throw new RangeError('boundingDepthFar must be greater than or equal to boundingDepthNear');
    }
    assertPositive('viewportHeightPx', cam.viewportHeightPx);
    assertPositive('viewportWidthPx', cam.viewportWidthPx);
}

function assertStereoInputs(eyeSeparation: number, focus: number): void {
    assertFinite('eyeSeparation', eyeSeparation);
    if (eyeSeparation < 0) {
        throw new RangeError('eyeSeparation must not be negative');
    }
    assertPositive('focus', focus);
}

/** Convert an angular disparity budget to CSS pixels at the viewing distance. */
export function angularDisparityToCssPx(
    depthBudgetArcmin: number,
    viewingDistanceMm: number,
    cssPxPerInch: number,
): number {
    assertFinite('depthBudgetArcmin', depthBudgetArcmin);
    if (depthBudgetArcmin < 0) {
        throw new RangeError('depthBudgetArcmin must not be negative');
    }
    assertPositive('viewingDistanceMm', viewingDistanceMm);
    assertPositive('cssPxPerInch', cssPxPerInch);

    // An angular separation θ subtends D·tan(θ) millimetres on the screen.
    // Convert that physical distance to CSS pixels using the measured CSS ppi.
    const thetaRad = (depthBudgetArcmin / 60) * (Math.PI / 180);
    return Math.tan(thetaRad) * viewingDistanceMm * cssPxPerInch / MM_PER_INCH;
}

/**
 * Width of one parallel-fusion eye viewport for a 63 mm corresponding-point
 * separation. The full side-by-side canvas cap is twice this value.
 */
export function parallelHalfWidthCapPx(cssPxPerInch: number, devicePixelRatio = 1): number {
    assertPositive('cssPxPerInch', cssPxPerInch);
    assertPositive('devicePixelRatio', devicePixelRatio);
    // The contract is calibrated CSS px per inch and viewport dimensions are
    // CSS px. DPR describes the backing store and does not enter this
    // physical conversion.
    return (INTEROCULAR_CAP_MM / MM_PER_INCH) * cssPxPerInch;
}

/** Cross-eyed warning threshold from the workshop/review geometry. */
export function crossEyedWarningThresholdMm(viewingDistanceMm: number): number {
    assertPositive('viewingDistanceMm', viewingDistanceMm);
    return INTEROCULAR_CAP_MM * (viewingDistanceMm / 250 - 1);
}

/** The Mol* stereo update's depth term, exposed for UI diagnostics and tests. */
export function disparityDepthTerm(z: number, focus: number): number {
    assertPositive('z', z);
    assertPositive('focus', focus);
    return 1 / z - 1 / focus;
}

/**
 * Predict horizontal disparity using the same sign as the plugin-patched
 * Mol* left-minus-right projection. Stock Mol* 5.11.0 translates the left
 * view by -B/2 and the right view by +B/2, while retaining the native
 * +B·near/(2F) and -B·near/(2F) frustum shifts. That stock combination is
 * measured in the geometry oracle test and does not converge at focus. The
 * plugin patch changes the view translations to +B/2 and -B/2, retaining the
 * native projection skew. Therefore a point nearer than focus has a positive
 * left-minus-right disparity:
 *
 *   Δx = (B / tan(fov/2)) · (1/z - 1/F) · (H/2)
 *
 * The near plane cancels from the final pixel disparity, but is retained in
 * projectPointThroughEye so the construction mirrors Mol*'s near-plane math.
 */
export function disparityPx(
    z: number,
    cam: CameraSnapshot,
    eyeSeparation: number,
    focus: number,
): number {
    assertCamera(cam);
    assertPositive('z', z);
    assertStereoInputs(eyeSeparation, focus);
    return (eyeSeparation / Math.tan(cam.fovRad / 2))
        * disparityDepthTerm(z, focus)
        * (cam.viewportHeightPx / 2);
}

/** Absolute disparity slope with respect to positive camera-frame depth. */
export function disparityGradientPxPerWorldUnit(
    z: number,
    cam: CameraSnapshot,
    eyeSeparation: number,
): number {
    assertCamera(cam);
    assertPositive('z', z);
    assertFinite('eyeSeparation', eyeSeparation);
    if (eyeSeparation < 0) {
        throw new RangeError('eyeSeparation must not be negative');
    }
    return Math.abs(eyeSeparation / Math.tan(cam.fovRad / 2)
        * (cam.viewportHeightPx / 2) / (z * z));
}

/** Negate a measured disparity when the display eye order is swapped. */
export function swapEyesDisparity(disparity: number, swapEyes: boolean): number {
    assertFinite('disparity', disparity);
    return swapEyes ? -disparity : disparity;
}

/**
 * Project one camera-frame point through one Mol*-style stereo eye.
 *
 * For an even viewport width this is an exact pixel form of the plugin's
 * patched Mol* 5.11.0 update: the left eye view has x translation +B/2 and
 * the native positive frustum center shift; the right eye has the opposite
 * pair. For odd widths Mol*
 * itself uses floor(W/2) for the projection aspect and leaves the extra pixel
 * in the right viewport; this helper preserves that detail.
 */
export function projectPointThroughEye(
    point: StereoPoint,
    cam: CameraSnapshot,
    eyeSeparation: number,
    focus: number,
    eye: StereoEye,
): ProjectedPoint {
    assertCamera(cam);
    assertStereoInputs(eyeSeparation, focus);
    assertFinite('point.x', point.x);
    assertFinite('point.y', point.y);
    assertPositive('point.z', point.z);

    const halfSeparation = eyeSeparation / 2;
    const leftViewportWidthPx = Math.floor(cam.viewportWidthPx / 2);
    const eyeViewportWidthPx = eye === 'left'
        ? leftViewportWidthPx
        : cam.viewportWidthPx - leftViewportWidthPx;
    const aspect = leftViewportWidthPx / cam.viewportHeightPx;
    const tanHalfFov = Math.tan(cam.fovRad / 2);
    const nearHalfHeight = cam.near * tanHalfFov;
    const nearHalfWidth = nearHalfHeight * aspect;
    const eyeX = eye === 'left'
        ? point.x + halfSeparation // patched view[12] = +B/2
        : point.x - halfSeparation; // patched view[12] = -B/2
    const frustumCenterAtNear = eye === 'left'
        ? halfSeparation * cam.near / focus
        : -halfSeparation * cam.near / focus;

    // The asymmetric perspective projection maps the frustum center to NDC
    // zero. In positive-depth coordinates this is (eyeX/z - center/near)
    // divided by the horizontal near-plane half-width.
    const xNdc = (eyeX / point.z - frustumCenterAtNear / cam.near)
        / (nearHalfWidth / cam.near);
    const yNdc = (point.y / point.z) / tanHalfFov;

    return {
        xPx: (xNdc + 1) * eyeViewportWidthPx / 2,
        yPx: (1 - yNdc) * cam.viewportHeightPx / 2,
        z: point.z,
        eye,
    };
}

/** Project a point through both eyes and optionally swap their display order. */
export function projectStereoPoint(
    point: StereoPoint,
    cam: CameraSnapshot,
    eyeSeparation: number,
    focus: number,
    swapEyes = false,
): StereoProjection {
    const left = projectPointThroughEye(point, cam, eyeSeparation, focus, 'left');
    const right = projectPointThroughEye(point, cam, eyeSeparation, focus, 'right');
    if (swapEyes) {
        return { left: right, right: left, disparityPx: right.xPx - left.xPx };
    }
    return { left, right, disparityPx: left.xPx - right.xPx };
}

/** Predict the display coordinates and disparity of a set of axial samples. */
export function predictedDisparityTable(
    cam: CameraSnapshot,
    params: StereoParams,
    samplesZ: readonly number[],
    swapEyes = false,
): PredictedDisparityRow[] {
    assertStereoInputs(params.eyeSeparation, params.focus);
    return samplesZ.map(z => {
        const projection = projectStereoPoint(
            { x: 0, y: 0, z },
            cam,
            params.eyeSeparation,
            params.focus,
            swapEyes,
        );
        return {
            z,
            leftPx: projection.left.xPx,
            rightPx: projection.right.xPx,
            disparityPx: projection.disparityPx,
        };
    });
}

/**
 * Derive Mol* world-unit eye separation from a screen-space angular budget.
 *
 * First convert θ arcmin at viewing distance D to targetCssPx:
 *   targetCssPx = tan(θ) · D_mm · cssPxPerInch / 25.4.
 *
 * Let F = distanceToTarget and Zfront = F - boundingRadius. Solving the
 * accepted disparity equation at the front of the visible structure gives:
 *   B = targetCssPx · 2·tan(fov/2)
 *       / (viewportHeightPx · |1/Zfront - 1/F|).
 *
 * The result is in Mol* world units (Å for the protein scene). It is not a
 * metre-scale interocular distance. The rear prediction is then evaluated at
 * the far depth of the visible sphere. This source follows the plugin's
 * build-local Mol* 5.11.0 StereoCamera override and the native update in
 * `lib/mol-canvas3d/camera/stereo.js:98-135`.
 */
export function deriveStereoParams(cam: CameraSnapshot, s: StereoSettings): StereoParams {
    assertCamera(cam);
    const targetCssPx = angularDisparityToCssPx(
        s.depthBudgetArcmin,
        s.viewingDistanceMm,
        s.cssPxPerInch,
    );
    assertPositive('devicePixelRatio', s.devicePixelRatio);
    const focus = cam.distanceToTarget;
    const requestedFrontZ = cam.boundingDepthNear ?? (focus - cam.boundingRadius);
    const requestedRearZ = cam.boundingDepthFar ?? (focus + cam.boundingRadius);
    // A panned scene can intersect or surround the camera. Clamp the near
    // sampled depth to the renderer's positive clip range instead of throwing
    // from a RAF callback or feeding a non-positive depth into 1/z.
    const frontZ = Math.max(cam.near, requestedFrontZ, Number.EPSILON);
    const rearZ = Math.max(frontZ, requestedRearZ, Number.EPSILON);
    const depthTerm = Math.max(
        Math.abs(disparityDepthTerm(frontZ, focus)),
        Math.abs(disparityDepthTerm(rearZ, focus)),
    );
    const eyeSeparation = s.mode === StereoMode.Off || targetCssPx === 0 || depthTerm === 0
        ? 0
        : targetCssPx * 2 * Math.tan(cam.fovRad / 2)
            / (cam.viewportHeightPx * depthTerm);

    return {
        eyeSeparation,
        focus,
        halfWidthCapPx: s.mode === StereoMode.Parallel
            ? parallelHalfWidthCapPx(s.cssPxPerInch, s.devicePixelRatio)
            : null,
        frontDisparityPx: disparityPx(frontZ, cam, eyeSeparation, focus),
        rearDisparityPx: disparityPx(rearZ, cam, eyeSeparation, focus),
    };
}
