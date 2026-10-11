import { describe, expect, it } from 'vitest';
import type { StereoCameraAdapter } from '../src/stereo-controller.js';
import { StereoController } from '../src/stereo-controller.js';
import {
  MotionController,
  type MotionCameraAdapter,
  type NormalizedHeadOffset,
  type ParallaxSource,
} from '../src/motion-controller.js';

class FakeParallaxSource implements ParallaxSource {
  value: NormalizedHeadOffset | undefined;

  read(): NormalizedHeadOffset | undefined {
    return this.value == null ? undefined : { ...this.value };
  }
}

function createCamera(): {
  adapter: MotionCameraAdapter;
  positions: Array<readonly [number, number, number]>;
  offsets: Parameters<MotionCameraAdapter['setViewOffset']>[0][];
} {
  const positions: Array<readonly [number, number, number]> = [];
  const offsets: Parameters<MotionCameraAdapter['setViewOffset']>[0][] = [];
  return {
    positions,
    offsets,
    adapter: {
      readCamera: () => ({
        position: [0, 0, 10],
        target: [0, 0, 0],
        up: [0, 1, 0],
        fovRad: Math.PI / 4,
        near: 0.1,
        aspect: 1.5,
      }),
      setPosition: (position) => positions.push(position),
      setViewOffset: (offset) => offsets.push(offset),
    },
  };
}

/**
 * A camera whose pose is real state: `setPosition` moves it, so a test can
 * move the camera between ticks the way a wheel zoom or a Mol* focus does.
 */
function createLiveCamera(
  position: [number, number, number] = [0, 0, 100],
  target: [number, number, number] = [0, 0, 0],
): {
  adapter: MotionCameraAdapter;
  pose: { position: [number, number, number]; target: [number, number, number] };
} {
  const pose = { position, target };
  return {
    pose,
    adapter: {
      readCamera: () => ({
        position: [...pose.position],
        target: [...pose.target],
        up: [0, 1, 0],
        fovRad: Math.PI / 4,
        near: 0.1,
        aspect: 1.5,
      }),
      setPosition: (next) => { pose.position = [next[0], next[1], next[2]]; },
      setViewOffset: () => undefined,
    },
  };
}

function distance(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

describe('MotionController camera boundary', () => {
  it('rocks the parent camera position while preserving stereo baseline and focus', () => {
    const fake = createCamera();
    const source = new FakeParallaxSource();
    const motion = new MotionController(fake.adapter, source);
    const stereoWrites: Parameters<StereoCameraAdapter['setStereo']>[0][] = [];
    let scheduled: FrameRequestCallback | undefined;
    const previousRequest = globalThis.requestAnimationFrame;
    const previousCancel = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      scheduled = callback;
      return 1;
    }) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = (() => undefined) as typeof cancelAnimationFrame;
    try {
      motion.captureBaseline();
      motion.setSettings({ mode: 'rock', amplitudeDeg: 4, periodS: 1, axis: 'y' }, 0);
      const stereo = new StereoController({
        readCamera: () => ({
          fovRad: Math.PI / 4,
          near: 0.1,
          distanceToTarget: 65,
          boundingRadius: 20,
          viewportHeightPx: 800,
          viewportWidthPx: 600,
        }),
        camera: { setStereo: (input) => stereoWrites.push(input) },
        onFrame: (nowMs) => { motion.tick(nowMs); },
      });
      stereo.setSettings({ mode: 'parallel', cssPxPerInch: 110 });
      const before = stereoWrites.at(-1);
      stereo.start();
      scheduled?.(250); // quarter period = +4°
      const after = stereoWrites.at(-1);

      expect(fake.positions.at(-1)).not.toEqual([0, 0, 10]);
      // Motion's adapter exposes no eyeSeparation/focus setter. The existing
      // controller keeps the derived stereo pair exactly stable across a rock.
      expect(after?.eyeSeparation).toBe(before?.eyeSeparation);
      expect(after?.focus).toBe(before?.focus);
      expect(after?.enabled).toBe(true);
      stereo.stop();
    } finally {
      globalThis.requestAnimationFrame = previousRequest;
      globalThis.cancelAnimationFrame = previousCancel;
    }
  });

  it('none stops all motion frames and clears any off-axis projection', () => {
    const fake = createCamera();
    const source = new FakeParallaxSource();
    const motion = new MotionController(fake.adapter, source);
    motion.captureBaseline();
    motion.setSettings({ mode: 'none' }, 0);
    const positionWrites = fake.positions.length;
    const offsetWrites = fake.offsets.length;

    expect(motion.tick(1)).toBe(false);
    expect(motion.tick(2)).toBe(false);
    expect(fake.positions).toHaveLength(positionWrites);
    expect(fake.offsets).toHaveLength(offsetWrites);
  });

  it('uses a source-agnostic normalized offset for parallax without moving the parent pose', () => {
    const fake = createCamera();
    const source = new FakeParallaxSource();
    source.value = { x: -0.5, y: 0.25 };
    const motion = new MotionController(fake.adapter, source);
    motion.setSettings({ mode: 'parallax' }, 0);
    const positionWrites = fake.positions.length;

    expect(motion.tick(16)).toBe(true);
    expect(fake.positions).toHaveLength(positionWrites);
    expect(fake.offsets.at(-1)).toMatchObject({ offsetX: expect.any(Number), offsetY: expect.any(Number) });
    expect(fake.offsets.at(-1)?.offsetX).toBeGreaterThan(0);
  });

  it('freezes oscillator updates while hidden and resumes without changing stereo state', () => {
    const fake = createCamera();
    const motion = new MotionController(fake.adapter, new FakeParallaxSource());
    motion.captureBaseline();
    motion.setSettings({ mode: 'spin', periodS: 60 }, 0);
    motion.tick(1_000);
    const writesBeforeHidden = fake.positions.length;
    motion.setHidden(true, 1_000);
    expect(motion.tick(2_000)).toBe(false);
    expect(fake.positions).toHaveLength(writesBeforeHidden);
    motion.setHidden(false, 2_000);
    expect(motion.tick(3_000)).toBe(true);
  });

  // Defect A: tick() used to rewrite the camera from a baseline
  // captured only on pointerdown/pointerup, so any other camera write — a
  // wheel zoom, a pinch, a keyboard move, a Mol* focus change — lived for one
  // frame and was then reverted.
  it('adopts a zoom made between two rock frames instead of reverting it', () => {
    const fake = createLiveCamera();
    const motion = new MotionController(fake.adapter, new FakeParallaxSource());
    motion.captureBaseline();
    motion.setSettings({ mode: 'rock', amplitudeDeg: 4, periodS: 1, axis: 'y' }, 0);

    expect(motion.tick(250)).toBe(true);
    expect(distance(fake.pose.position, fake.pose.target)).toBeCloseTo(100, 6);

    // The wheel zooms in: same direction, 40 % of the distance.
    const zoomed: [number, number, number] = [
      fake.pose.target[0] + (fake.pose.position[0] - fake.pose.target[0]) * 0.4,
      fake.pose.target[1] + (fake.pose.position[1] - fake.pose.target[1]) * 0.4,
      fake.pose.target[2] + (fake.pose.position[2] - fake.pose.target[2]) * 0.4,
    ];
    fake.pose.position = zoomed;
    expect(distance(zoomed, fake.pose.target)).toBeCloseTo(40, 6);

    expect(motion.tick(500)).toBe(true);
    expect(distance(fake.pose.position, fake.pose.target)).toBeCloseTo(40, 6);
    // The rock keeps running: the pose is not frozen at the zoomed one.
    expect(fake.pose.position).not.toEqual(zoomed);
  });

  it('adopts a target change made between two rock frames', () => {
    const fake = createLiveCamera();
    const motion = new MotionController(fake.adapter, new FakeParallaxSource());
    motion.captureBaseline();
    motion.setSettings({ mode: 'rock', amplitudeDeg: 4, periodS: 1, axis: 'y' }, 0);
    motion.tick(250);

    // Mol* focuses a ligand: the target moves and the camera follows it.
    fake.pose.target = [12, -3, 5];
    fake.pose.position = [
      fake.pose.position[0] + 12,
      fake.pose.position[1] - 3,
      fake.pose.position[2] + 5,
    ];
    const radius = distance(fake.pose.position, fake.pose.target);

    motion.tick(500);
    expect(distance(fake.pose.position, fake.pose.target)).toBeCloseTo(radius, 6);
    // The rock now orbits the new target, not the origin it was captured at.
    expect(distance(fake.pose.position, [0, 0, 0])).not.toBeCloseTo(radius, 3);
  });

  it('leaves the camera untouched in none even after an external move', () => {
    const fake = createLiveCamera();
    const motion = new MotionController(fake.adapter, new FakeParallaxSource());
    motion.captureBaseline();
    motion.setSettings({ mode: 'none' }, 0);
    fake.pose.position = [0, 0, 40];

    expect(motion.tick(250)).toBe(false);
    expect(motion.tick(500)).toBe(false);
    expect(fake.pose.position).toEqual([0, 0, 40]);
  });

  it('re-baselines a spin from an external zoom without changing the spin rate', () => {
    const fake = createLiveCamera();
    const motion = new MotionController(fake.adapter, new FakeParallaxSource());
    motion.captureBaseline();
    motion.setSettings({ mode: 'spin', periodS: 60, axis: 'y' }, 0);
    motion.tick(1_000);
    fake.pose.position = [
      fake.pose.position[0] * 0.25,
      fake.pose.position[1] * 0.25,
      fake.pose.position[2] * 0.25,
    ];
    const zoomedDistance = distance(fake.pose.position, fake.pose.target);
    const before = [...fake.pose.position] as [number, number, number];

    motion.tick(2_000);
    expect(distance(fake.pose.position, fake.pose.target)).toBeCloseTo(zoomedDistance, 6);
    // 6 deg/s for a 60 s period: one second of spin is a 6 deg arc.
    const chord = distance(fake.pose.position, before);
    expect(chord).toBeCloseTo(2 * zoomedDistance * Math.sin((6 * Math.PI / 180) / 2), 4);
  });
});
