import { describe, expect, it } from 'vitest';
import { Camera } from 'molstar/lib/mol-canvas3d/camera.js';
import { StereoCamera } from 'molstar/lib/mol-canvas3d/camera/stereo.js';
import { cameraProject, Viewport } from 'molstar/lib/mol-canvas3d/camera/util.js';
import { Mat4, Vec3, Vec4 } from 'molstar/lib/mol-math/linear-algebra.js';
import { disparityPx, type CameraSnapshot } from '@stereo/geometry';

/**
 * The stereo baseline has to live in the camera's frame, at every camera pose.
 *
 * `vitest.config.ts` applies `patchMolstarStereoSource` to this import, so the
 * `StereoCamera` below is the one the browser bundle ships. Every test in this
 * file therefore measures the shipped projection rather than a re-derivation
 * of it.
 *
 * The defect these tests exist for: Mol* 5.11.0 post-multiplies the *view*
 * matrix with the ±B/2 eye translation, which applies the baseline along world
 * x rather than along the camera's own x. The frustum skew that is supposed to
 * cancel it is always applied along the eye's x axis, so the two only cancel
 * when the camera's right vector is world +x. Every earlier acceptance measurement in
 * this repo pinned exactly that pose, so the defect was invisible to
 * all of them while being fusion-breaking in a real host.
 */

const FOV = 45 * Math.PI / 180;
const FOCUS = 65;
const RADIUS = 20;
/** One capped eye viewport pair and the real Codex card stage height. */
const WIDTH = 476;
const HEIGHT = 437;
const BASELINE = 1.907876;

const snapshot: CameraSnapshot = {
  fovRad: FOV,
  near: 1,
  distanceToTarget: FOCUS,
  boundingRadius: RADIUS,
  viewportHeightPx: HEIGHT,
  viewportWidthPx: WIDTH,
};

type Pose = { name: string; yawDeg: number; pitchDeg: number; rollDeg: number };

const POSES: Pose[] = [
  { name: 'axis aligned', yawDeg: 0, pitchDeg: 0, rollDeg: 0 },
  { name: 'yaw 15', yawDeg: 15, pitchDeg: 0, rollDeg: 0 },
  { name: 'yaw 45', yawDeg: 45, pitchDeg: 0, rollDeg: 0 },
  { name: 'yaw 90', yawDeg: 90, pitchDeg: 0, rollDeg: 0 },
  { name: 'yaw 180', yawDeg: 180, pitchDeg: 0, rollDeg: 0 },
  { name: 'yaw -63', yawDeg: -63, pitchDeg: 0, rollDeg: 0 },
  { name: 'pitch 30', yawDeg: 0, pitchDeg: 30, rollDeg: 0 },
  { name: 'yaw 80 pitch 15', yawDeg: 80, pitchDeg: 15, rollDeg: 0 },
  { name: 'yaw 37 pitch -52', yawDeg: 37, pitchDeg: -52, rollDeg: 0 },
  { name: 'roll 20', yawDeg: 0, pitchDeg: 0, rollDeg: 20 },
  { name: 'yaw 25 pitch 10 roll 40', yawDeg: 25, pitchDeg: 10, rollDeg: 40 },
];

function radians(degrees: number): number {
  return degrees * Math.PI / 180;
}

/** Camera on a sphere of radius `distance` about the origin, with a rolled up vector. */
function cameraForPose(pose: Pose, distance = FOCUS): Camera {
  const yaw = radians(pose.yawDeg);
  const pitch = radians(pose.pitchDeg);
  const position = Vec3.create(
    distance * Math.cos(pitch) * Math.sin(yaw),
    distance * Math.sin(pitch),
    distance * Math.cos(pitch) * Math.cos(yaw),
  );
  const forward = Vec3.normalize(Vec3(), Vec3.negate(Vec3(), position));
  const worldUp = Vec3.create(0, 1, 0);
  const right = Vec3.normalize(Vec3(), Vec3.cross(Vec3(), forward, worldUp));
  const up = Vec3.normalize(Vec3(), Vec3.cross(Vec3(), right, forward));
  const roll = radians(pose.rollDeg);
  // Roll rotates the up vector about the view axis, which is the one rotation
  // that changes the camera's right vector without moving the camera.
  const rolled = Vec3.add(
    Vec3(),
    Vec3.scale(Vec3(), up, Math.cos(roll)),
    Vec3.scale(Vec3(), right, Math.sin(roll)),
  );
  return new Camera({
    position,
    target: Vec3.create(0, 0, 0),
    up: rolled,
    radius: RADIUS,
    radiusMax: RADIUS,
    minNear: 1,
    fov: FOV,
    mode: 'perspective',
  }, Viewport.create(0, 0, WIDTH, HEIGHT));
}

type Rig = { stereo: StereoCamera; camera: Camera };

function stereoFor(pose: Pose, eyeSeparation = BASELINE, distance = FOCUS): Rig {
  const camera = cameraForPose(pose, distance);
  const stereo = new StereoCamera(camera, { eyeSeparation, focus: distance });
  stereo.update();
  return { stereo, camera };
}

type Eye = StereoCamera['left'];

/** Position of a world point inside one eye's own viewport, in pixels. */
function project(eye: Eye, point: Vec3): { x: number; y: number } {
  const out = Vec4();
  cameraProject(out, point, eye.viewport, eye.projectionView);
  return { x: out[0] - eye.viewport.x, y: out[1] - eye.viewport.y };
}

/** Signed offset of the focus point from the centre of each eye's viewport. */
function centreOffsets({ stereo }: Rig): { left: number; right: number; vertical: number } {
  const origin = Vec3.create(0, 0, 0);
  const left = project(stereo.left, origin);
  const right = project(stereo.right, origin);
  return {
    left: left.x - stereo.left.viewport.width / 2,
    right: right.x - stereo.right.viewport.width / 2,
    vertical: left.y - right.y,
  };
}

/**
 * The earlier build: the ±B/2 translation post-multiplied onto the view matrix.
 * Kept so the tests below can show they discriminate rather than merely pass.
 */
function applyWorldFrameBaseline({ stereo, camera }: Rig, eyeSeparation = BASELINE): void {
  const translation = Mat4.identity();
  Mat4.copy(stereo.left.view, camera.view);
  translation[12] = eyeSeparation / 2;
  Mat4.mul(stereo.left.view, stereo.left.view, translation);
  Mat4.mul(stereo.left.projectionView, stereo.left.projection, stereo.left.view);
  Mat4.copy(stereo.right.view, camera.view);
  translation[12] = -eyeSeparation / 2;
  Mat4.mul(stereo.right.view, stereo.right.view, translation);
  Mat4.mul(stereo.right.projectionView, stereo.right.projection, stereo.right.view);
}

describe('shipped Mol* StereoCamera: the baseline is in the camera frame', () => {
  it('puts the focus point at the centre of both eye viewports at every camera pose', () => {
    for (const pose of POSES) {
      const offsets = centreOffsets(stereoFor(pose));
      expect(Math.abs(offsets.left), `${pose.name} left`).toBeLessThan(1e-6);
      expect(Math.abs(offsets.right), `${pose.name} right`).toBeLessThan(1e-6);
    }
  });

  it('leaves no vertical disparity at any camera pose', () => {
    for (const pose of POSES) {
      expect(Math.abs(centreOffsets(stereoFor(pose)).vertical), pose.name).toBeLessThan(1e-6);
    }
  });

  it('keeps front and rear disparity at the values @stereo/geometry predicts, at every pose', () => {
    const front = disparityPx(FOCUS - RADIUS, snapshot, BASELINE, FOCUS);
    const rear = disparityPx(FOCUS + RADIUS, snapshot, BASELINE, FOCUS);
    for (const pose of POSES) {
      const rig = stereoFor(pose);
      // Sample along the view axis so the depths are the same at every pose.
      const origin = rig.camera.state.position;
      const axis = Vec3.normalize(Vec3(), Vec3.negate(Vec3(), origin));
      for (const [label, depth, predicted] of [['front', FOCUS - RADIUS, front], ['rear', FOCUS + RADIUS, rear]] as const) {
        const point = Vec3.scaleAndAdd(Vec3(), origin, axis, depth);
        const measured = project(rig.stereo.left, point).x - project(rig.stereo.right, point).x;
        expect(measured, `${pose.name} ${label}`).toBeCloseTo(predicted, 6);
      }
    }
  });

  it('reproduces the earlier outward displacement when the baseline is put back in world space', () => {
    // Yaw is the rotation that breaks it; a pure pitch keeps world x on the
    // camera's right axis, which is why a pitched pose looks correct.
    const yawed = stereoFor({ name: 'yaw 90', yawDeg: 90, pitchDeg: 0, rollDeg: 0 });
    applyWorldFrameBaseline(yawed);
    const broken = centreOffsets(yawed);
    // (B · H) / (4 · F · tan(fov/2)) · (u·x̂ − 1), with u·x̂ = 0 at yaw 90.
    const predicted = -(BASELINE * HEIGHT) / (4 * FOCUS * Math.tan(FOV / 2));
    expect(broken.left).toBeCloseTo(predicted, 6);
    expect(broken.right).toBeCloseTo(-predicted, 6);
    // Both eyes move outward, so the pair separates by twice the per-eye shift.
    expect(broken.left).toBeLessThan(-7);
    expect(broken.right).toBeGreaterThan(7);

    const pitched = stereoFor({ name: 'pitch 30', yawDeg: 0, pitchDeg: 30, rollDeg: 0 });
    applyWorldFrameBaseline(pitched);
    expect(Math.abs(centreOffsets(pitched).left)).toBeLessThan(1e-6);
  });

  it('scales the outward displacement with the eye separation, so a bigger depth budget clips sooner', () => {
    const pose: Pose = { name: 'yaw 90', yawDeg: 90, pitchDeg: 0, rollDeg: 0 };
    const small = stereoFor(pose, BASELINE);
    applyWorldFrameBaseline(small, BASELINE);
    const large = stereoFor(pose, BASELINE * 2);
    applyWorldFrameBaseline(large, BASELINE * 2);
    expect(centreOffsets(large).left / centreOffsets(small).left).toBeCloseTo(2, 6);
  });

  it('still splits the viewport into two even halves and honours the eye-order swap', () => {
    const { stereo } = stereoFor({ name: 'axis aligned', yawDeg: 0, pitchDeg: 0, rollDeg: 0 });
    expect(stereo.left.viewport.x).toBe(0);
    expect(stereo.left.viewport.width).toBe(WIDTH / 2);
    expect(stereo.right.viewport.x).toBe(WIDTH / 2);
    expect(stereo.right.viewport.width).toBe(WIDTH / 2);
    try {
      globalThis.__stereoStructureViewportXSwap = true;
      const swapped = stereoFor({ name: 'axis aligned', yawDeg: 0, pitchDeg: 0, rollDeg: 0 }).stereo;
      expect(swapped.left.viewport.x).toBe(WIDTH / 2);
      expect(swapped.right.viewport.x).toBe(0);
    } finally {
      globalThis.__stereoStructureViewportXSwap = undefined;
    }
  });

  it('collapses to a single mono image when the depth budget is zero', () => {
    for (const pose of POSES) {
      const rig = stereoFor(pose, 0);
      const offsets = centreOffsets(rig);
      expect(Math.abs(offsets.left), pose.name).toBeLessThan(1e-9);
      expect(Math.abs(offsets.right), pose.name).toBeLessThan(1e-9);
      const origin = rig.camera.state.position;
      const axis = Vec3.normalize(Vec3(), Vec3.negate(Vec3(), origin));
      for (const depth of [FOCUS - RADIUS, FOCUS, FOCUS + RADIUS]) {
        const point = Vec3.scaleAndAdd(Vec3(), origin, axis, depth);
        expect(project(rig.stereo.left, point).x - project(rig.stereo.right, point).x).toBeCloseTo(0, 9);
      }
    }
  });
});
