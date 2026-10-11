import { describe, expect, it } from 'vitest';
import { Camera } from 'molstar/lib/mol-canvas3d/camera.js';
import { StereoCamera } from 'molstar/lib/mol-canvas3d/camera/stereo.js';
import { cameraProject, Viewport } from 'molstar/lib/mol-canvas3d/camera/util.js';
import { Mat4, Vec3, Vec4 } from 'molstar/lib/mol-math/linear-algebra.js';
import {
    angularDisparityToCssPx,
    crossEyedWarningThresholdMm,
    deriveStereoParams,
    parallelHalfWidthCapPx,
    projectStereoPoint,
    StereoMode,
    type CameraSnapshot,
} from '../src/index.js';

const FOCUS = 65;
const BASELINE = 1.907876;
const WIDTH = 800;
const HEIGHT = 800;
const FOV = 45 * Math.PI / 180;

const cam: CameraSnapshot = {
    fovRad: FOV,
    near: 1,
    distanceToTarget: FOCUS,
    boundingRadius: 20,
    viewportHeightPx: HEIGHT,
    viewportWidthPx: WIDTH,
};

const settings = {
    mode: StereoMode.Parallel,
    swapEyes: false,
    depthBudgetArcmin: 20,
    viewingDistanceMm: 500,
    cssPxPerInch: 110,
    devicePixelRatio: 1,
} as const;

const params = deriveStereoParams(cam, settings);
type MolstarEye = StereoCamera['left'];

function makeMolstarCamera(): Camera {
    return new Camera({
        position: Vec3.create(0, 0, FOCUS),
        target: Vec3.create(0, 0, 0),
        up: Vec3.create(0, 1, 0),
        radius: 20,
        radiusMax: 20,
        minNear: 1,
        fov: FOV,
        mode: 'perspective',
    }, Viewport.create(0, 0, WIDTH, HEIGHT));
}

function projectWorld(eye: MolstarEye, depth: number, x = 0, y = 0): { x: number; y: number } {
    const out = Vec4();
    cameraProject(out, Vec3.create(x, y, FOCUS - depth), eye.viewport, eye.projectionView);
    return { x: out[0] - eye.viewport.x, y: out[1] - eye.viewport.y };
}

function stockOracle(): StereoCamera {
    const camera = makeMolstarCamera();
    const stereo = new StereoCamera(camera, { eyeSeparation: BASELINE, focus: FOCUS });
    stereo.update();
    return stereo;
}

/** Apply the same build-local correction that the plugin injects into Mol*. */
function applyConvergentOverride(stereo: StereoCamera): void {
    const parent = stereo.parent;
    const halfBaseline = BASELINE / 2;
    const localTranslation = Mat4.identity();

    Mat4.copy(stereo.left.view, parent.view);
    localTranslation[12] = halfBaseline;
    Mat4.mul(stereo.left.view, stereo.left.view, localTranslation);
    Mat4.mul(stereo.left.projectionView, stereo.left.projection, stereo.left.view);
    Mat4.invert(stereo.left.inverseProjectionView, stereo.left.projectionView);

    Mat4.copy(stereo.right.view, parent.view);
    localTranslation[12] = -halfBaseline;
    Mat4.mul(stereo.right.view, stereo.right.view, localTranslation);
    Mat4.mul(stereo.right.projectionView, stereo.right.projection, stereo.right.view);
    Mat4.invert(stereo.right.inverseProjectionView, stereo.right.projectionView);
}

function oracleDisparity(stereo: StereoCamera, depth: number, x = 0, y = 0): number {
    return projectWorld(stereo.left, depth, x, y).x - projectWorld(stereo.right, depth, x, y).x;
}

function rasterEye(eye: MolstarEye, depths: readonly number[], width: number, height: number): Uint8Array {
    const output = new Uint8Array(width * height * 4);
    for (const depth of depths) {
        const p = projectWorld(eye, depth);
        const x = Math.floor(p.x);
        const y = Math.floor(p.y);
        if (x < 0 || x >= width || y < 0 || y >= height) continue;
        const i = (y * width + x) * 4;
        output[i] = Math.round(depth);
        output[i + 1] = 255 - Math.round(depth);
        output[i + 2] = 127;
        output[i + 3] = 255;
    }
    return output;
}

function sideBySide(left: Uint8Array, right: Uint8Array, width: number, height: number): Uint8Array {
    const output = new Uint8Array(width * 2 * height * 4);
    for (let y = 0; y < height; y++) {
        const row = y * width * 4;
        output.set(left.subarray(row, row + width * 4), y * width * 2 * 4);
        output.set(right.subarray(row, row + width * 4), y * width * 2 * 4 + width * 4);
    }
    return output;
}

function mirrorSceneRaster(stereo: StereoCamera, scene: readonly { x: number; y: number; depth: number }[]): Uint8Array {
    const left = new Uint8Array(WIDTH / 2 * HEIGHT * 4);
    const right = new Uint8Array(WIDTH / 2 * HEIGHT * 4);
    for (const point of scene) {
        const mirroredX = -point.x;
        const lp = projectWorld(stereo.left, point.depth, mirroredX, point.y);
        const rp = projectWorld(stereo.right, point.depth, mirroredX, point.y);
        // Mirror each eye image horizontally, then exchange eye order. The
        // right-eye mirror therefore occupies the displayed left half.
        const mirroredRightX = WIDTH / 2 - 1 - Math.floor(rp.x);
        const mirroredLeftX = WIDTH / 2 - 1 - Math.floor(lp.x);
        const lx = mirroredRightX;
        const rx = mirroredLeftX;
        const ly = Math.floor(rp.y);
        const ry = Math.floor(lp.y);
        if (lx >= 0 && lx < WIDTH / 2 && ly >= 0 && ly < HEIGHT) {
            const i = (ly * (WIDTH / 2) + lx) * 4;
            left[i] = Math.round(point.depth); left[i + 1] = 255 - left[i]; left[i + 2] = 127; left[i + 3] = 255;
        }
        if (rx >= 0 && rx < WIDTH / 2 && ry >= 0 && ry < HEIGHT) {
            const i = (ry * (WIDTH / 2) + rx) * 4;
            right[i] = Math.round(point.depth); right[i + 1] = 255 - right[i]; right[i + 2] = 127; right[i + 3] = 255;
        }
    }
    return sideBySide(left, right, WIDTH / 2, HEIGHT);
}

function normalSceneRaster(stereo: StereoCamera, scene: readonly { x: number; y: number; depth: number }[]): Uint8Array {
    const left = new Uint8Array(WIDTH / 2 * HEIGHT * 4);
    const right = new Uint8Array(WIDTH / 2 * HEIGHT * 4);
    for (const point of scene) {
        for (const [eye, output] of [[stereo.left, left], [stereo.right, right]] as const) {
            const p = projectWorld(eye, point.depth, point.x, point.y);
            const x = Math.floor(p.x);
            const y = Math.floor(p.y);
            if (x < 0 || x >= WIDTH / 2 || y < 0 || y >= HEIGHT) continue;
            const i = (y * (WIDTH / 2) + x) * 4;
            output[i] = Math.round(point.depth); output[i + 1] = 255 - output[i]; output[i + 2] = 127; output[i + 3] = 255;
        }
    }
    return sideBySide(left, right, WIDTH / 2, HEIGHT);
}

describe('@stereo/geometry against Mol* 5.11.0', () => {
    it('records stock StereoCamera measurements and proves its skew does not converge at focus', () => {
        const stock = stockOracle();
        const measured = [45, 65, 85].map(depth => oracleDisparity(stock, depth));
        console.log(`Mol* 5.11.0 stock local left-minus-right: Z=45 ${measured[0].toFixed(4)} px; Z=65 ${measured[1].toFixed(4)} px; Z=85 ${measured[2].toFixed(4)} px`);
        console.log(`Mol* stock view[12]: left ${stock.left.view[12].toFixed(6)}; right ${stock.right.view[12].toFixed(6)}; projection[8]: left ${stock.left.projection[8].toFixed(8)}; right ${stock.right.projection[8].toFixed(8)}`);
        expect(measured[0]).toBeCloseTo(-69.2871402, 4);
        expect(measured[1]).toBeCloseTo(-56.6894783, 4);
        expect(measured[2]).toBeCloseTo(-50.0201279, 4);
        expect(Math.abs(measured[1])).toBeGreaterThan(50);
    });

    it('matches geometry predictions through corrected real Mol* matrices', () => {
        const stereo = stockOracle();
        applyConvergentOverride(stereo);
        const measured = [45, 65, 85].map(depth => oracleDisparity(stereo, depth));
        console.log(`Mol* corrected local left-minus-right: Z=45 ${measured[0].toFixed(4)} px; Z=65 ${measured[1].toFixed(4)} px; Z=85 ${measured[2].toFixed(4)} px`);
        expect(measured[0]).toBeCloseTo(12.597663, 4);
        expect(measured[1]).toBeCloseTo(0, 8);
        expect(measured[2]).toBeCloseTo(-6.669351, 4);
        for (const [depth, expected] of [[45, params.frontDisparityPx], [65, 0], [85, params.rearDisparityPx]] as const) {
            expect(oracleDisparity(stereo, depth)).toBeCloseTo(expected, 4);
        }
        const nonAxial = projectStereoPoint({ x: 7, y: 9, z: 55 }, cam, BASELINE, FOCUS);
        expect(Math.abs(nonAxial.left.yPx - nonAxial.right.yPx)).toBeLessThan(1e-10);
    });

    it('uses a deterministic raster zero-baseline comparison through real Mol* projections', () => {
        const camera = makeMolstarCamera();
        const stereo = new StereoCamera(camera, { eyeSeparation: 0, focus: FOCUS });
        stereo.update();
        const depths = [45, 55, 65, 75, 85];
        const left = rasterEye(stereo.left, depths, WIDTH / 2, HEIGHT);
        const right = rasterEye(stereo.right, depths, WIDTH / 2, HEIGHT);
        const rendered = sideBySide(left, right, WIDTH / 2, HEIGHT);
        for (let y = 0; y < HEIGHT; y++) {
            for (let x = 0; x < WIDTH / 2; x++) {
                const leftI = (y * WIDTH + x) * 4;
                const rightI = (y * WIDTH + x + WIDTH / 2) * 4;
                expect(rendered.subarray(leftI, leftI + 4)).toEqual(rendered.subarray(rightI, rightI + 4));
            }
        }
        expect(oracleDisparity(stereo, 45)).toBe(0);
        expect(oracleDisparity(stereo, 65)).toBe(0);
    });

    it('passes a true mirrored-scene plus eye-order comparison', () => {
        const stereo = stockOracle();
        applyConvergentOverride(stereo);
        const scene = [
            { x: -18, y: -12, depth: 45 },
            { x: 11, y: -4, depth: 55 },
            { x: -6, y: 9, depth: 65 },
            { x: 16, y: 12, depth: 75 },
            { x: -12, y: 3, depth: 85 },
        ];
        const normal = normalSceneRaster(stereo, scene);
        const mirroredAndEyeSwapped = mirrorSceneRaster(stereo, scene);
        let mismatchCount = 0;
        const mismatchPixels: string[] = [];
        for (let i = 0; i < normal.length; i += 4) {
            if (normal[i] === mirroredAndEyeSwapped[i]
                && normal[i + 1] === mirroredAndEyeSwapped[i + 1]
                && normal[i + 2] === mirroredAndEyeSwapped[i + 2]
                && normal[i + 3] === mirroredAndEyeSwapped[i + 3]) continue;
            mismatchCount += 1;
            if (mismatchPixels.length < 8) mismatchPixels.push(`${Math.floor((i / 4) % WIDTH)},${Math.floor(i / 4 / WIDTH)}`);
        }
        console.log(`mirrored raster differing pixels: ${mismatchCount} (${mismatchPixels.join(' ')})`);
        expect(mirroredAndEyeSwapped).toEqual(normal);
    });

    it('computes the disparity gradient in screen space and rejects the B/B tautology', () => {
        const stereo = stockOracle();
        applyConvergentOverride(stereo);
        const samples = Array.from({ length: 41 }, (_, i) => {
            const t = i / 40;
            const depth = 45 + 40 * t;
            const x = -18 + 36 * t;
            const left = projectWorld(stereo.left, depth, x);
            const right = projectWorld(stereo.right, depth, x);
            return { midpoint: (left.x + right.x) / 2, disparity: left.x - right.x };
        });
        let maxGradient = 0;
        for (let i = 1; i < samples.length; i += 1) {
            const screenDelta = Math.abs(samples[i].midpoint - samples[i - 1].midpoint);
            const disparityDelta = Math.abs(samples[i].disparity - samples[i - 1].disparity);
            maxGradient = Math.max(maxGradient, disparityDelta / screenDelta);
        }
        const separationRatio = Math.max(Math.abs(oracleDisparity(stereo, 45)), Math.abs(oracleDisparity(stereo, 85)))
            / Math.min(Math.abs(oracleDisparity(stereo, 45)), Math.abs(oracleDisparity(stereo, 85)));
        console.log(`Mol* screen-space gradient ${maxGradient.toFixed(6)} px/px; front/rear separation ratio ${separationRatio.toFixed(6)}`);
        expect(maxGradient).toBeLessThanOrEqual(1);
        expect(separationRatio).toBeLessThan(2);
        expect(separationRatio).not.toBe(1);
    });
});

describe('@stereo/geometry contract checks', () => {
    it('converts the angular budget and keeps DPR out of CSS physical conversions', () => {
        expect(angularDisparityToCssPx(20, 500, 110)).toBeCloseTo(12.597663, 4);
        expect(parallelHalfWidthCapPx(110, 1)).toBeCloseTo(272.8346456692913, 12);
        expect(parallelHalfWidthCapPx(110, 2)).toBeCloseTo(272.8346456692913, 12);
        expect(params.halfWidthCapPx).toBeCloseTo(272.8346456692913, 12);
        expect(crossEyedWarningThresholdMm(600)).toBeCloseTo(88.2, 12);
    });

    it('guards a stalled or panned bounding sphere with positive depth bounds', () => {
        const stalled = deriveStereoParams({ ...cam, boundingRadius: 100 }, settings);
        expect(Number.isFinite(stalled.eyeSeparation)).toBe(true);
        expect(Number.isFinite(stalled.frontDisparityPx)).toBe(true);
        const panned = deriveStereoParams({
            ...cam,
            boundingRadius: 20,
            boundingDepthNear: 90,
            boundingDepthFar: 130,
        }, settings);
        expect(Number.isFinite(panned.eyeSeparation)).toBe(true);
        expect(Number.isFinite(panned.rearDisparityPx)).toBe(true);
    });
});
