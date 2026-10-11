import { describe, expect, it } from 'vitest';
import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra';
import { Euler } from 'molstar/lib/mol-math/linear-algebra/3d/euler';
// @ts-ignore Import-free placement maths, shared with the browser XR layer.
import { drawnCenterInScene, drawnCenterOffset, pivotPreservingTranslation } from '../../lab/browser-roundtrip/presentation-pivot.mjs';

/**
 * A turn must leave the drawn centre where the wearer sees it.
 *
 * Holding the trigger and rotating used to swing the structure around an
 * offset, invisible centre of mass rather than the structure's own, so it
 * looped across the room for as long as the trigger was held.
 *
 * The held trigger itself was Mol*'s stock `dragRotate` on the camera, which
 * `xr-locomotion.mjs XR_CLEARED_CAMERA_DRAGS` now takes away. This file holds
 * the second half: the page's own turn — the stick yaw, the grip and the agent
 * spin — pivoted on the full assembly's bounding-sphere centre, which is not
 * the centre of what an experience stage draws.
 *
 * Every matrix below is the composition `viewer.mjs` builds, line for line, so
 * that a change to `placementTransform` or `presentationTransform` that breaks
 * the invariant breaks this too.
 */

/** 9KJ6's order of size: an X-ray Cas9 complex. */
const RADIUS = 61;
const BASE_CENTER = [35.2, 18.7, -12.4];
/** An experience stage that draws one lobe: 17.9 Angstrom off the assembly centre. */
const VISIBLE_CENTER = [49.2, 9.7, -6.4];
/** A recorded placement, in radii. */
const PLACEMENT = { translation: [0.9985341921618729, -0.19949548500639933, 0.918420377553755],
  rotation: [0, 0, 0], scale: 2.4 };
/**
 * Rendered units to room metres.
 *
 * A `recenter-structure` on the placement above reported `metersAcross 3.6` at
 * `scale 2.0052166212268667`, so one rendered unit is that width over the
 * placed diameter.
 */
const METRES_PER_UNIT = 3.6 / (2 * RADIUS * 2.0052166212268667);
/** The tolerance, in rendered units: one centimetre in the room. */
const ONE_CENTIMETRE = 0.01 / METRES_PER_UNIT;
const YAW_DEGREES = 30;

/** viewer.mjs `placementTransform`. */
function placementTransform(placement: any) {
  const radians = placement.rotation.map((value: number) => value * Math.PI / 180);
  const x = Mat4.fromRotation(Mat4(), radians[0], Vec3.create(1, 0, 0));
  const y = Mat4.fromRotation(Mat4(), radians[1], Vec3.create(0, 1, 0));
  const z = Mat4.fromRotation(Mat4(), radians[2], Vec3.create(0, 0, 1));
  const scale = Mat4.fromScaling(Mat4(), Vec3.create(placement.scale, placement.scale, placement.scale));
  const rotation = Mat4.mul(Mat4(), z, Mat4.mul(Mat4(), y, x));
  const local = Mat4.mul(Mat4(), rotation, scale);
  const offset = Vec3.create(...placement.translation.map((value: number) => value * RADIUS) as [number, number, number]);
  const toCenter = Mat4.fromTranslation(Mat4(), Vec3.add(Vec3(), Vec3.create(...BASE_CENTER as [number, number, number]), offset));
  const fromCenter = Mat4.fromTranslation(Mat4(), Vec3.negate(Vec3(), Vec3.create(...BASE_CENTER as [number, number, number])));
  return Mat4.mul3(Mat4(), toCenter, local, fromCenter);
}

/** viewer.mjs `presentationTransform`, with the pivot this file is about. */
function presentationTransform(placement: any, pivotModel: number[],
  { grabRotation, grabScale = 1, grabOffset, motionAngle = 0 }: any = {}) {
  const base = placementTransform(placement);
  const grabbed = grabRotation || grabScale !== 1
    ? (grabScale === 1 ? grabRotation
      : Mat4.mul(Mat4(), grabRotation ?? Mat4.identity(), Mat4.fromScaling(Mat4(), Vec3.create(grabScale, grabScale, grabScale))))
    : undefined;
  if (!motionAngle && !grabbed && !grabOffset) return base;
  const positioned = Vec3.transformMat4(Vec3(), Vec3.create(...pivotModel as [number, number, number]), base);
  const toCenter = Mat4.fromTranslation(Mat4(), positioned);
  const fromCenter = Mat4.fromTranslation(Mat4(), Vec3.negate(Vec3(), positioned));
  const spin = motionAngle ? Mat4.fromRotation(Mat4(), motionAngle * Math.PI / 180, Vec3.create(0, 1, 0)) : Mat4.identity();
  const local = grabbed ? Mat4.mul(Mat4(), grabbed, spin) : spin;
  const posed = Mat4.mul3(Mat4(), toCenter, local, Mat4.mul(Mat4(), fromCenter, base));
  if (!grabOffset) return posed;
  return Mat4.mul(Mat4(), Mat4.fromTranslation(Mat4(), Vec3.create(...grabOffset as [number, number, number])), posed);
}

/** viewer.mjs `rotationFromPlacement` and `rotationDegreesZYX`. */
function rotationFromPlacement(placement: any) {
  const radians = placement.rotation.map((value: number) => value * Math.PI / 180);
  const x = Mat4.fromRotation(Mat4(), radians[0], Vec3.create(1, 0, 0));
  const y = Mat4.fromRotation(Mat4(), radians[1], Vec3.create(0, 1, 0));
  const z = Mat4.fromRotation(Mat4(), radians[2], Vec3.create(0, 0, 1));
  return Mat4.mul(Mat4(), z, Mat4.mul(Mat4(), y, x));
}
const rotationDegreesZYX = (matrix: any) =>
  Array.from(Euler.fromMat4(Euler(), matrix, 'ZYX'), value => value * 180 / Math.PI);

const yaw = (degrees: number) => Mat4.fromRotation(Mat4(), degrees * Math.PI / 180, Vec3.create(0, 1, 0));
const drawnAt = (transform: any) =>
  Array.from(Vec3.transformMat4(Vec3(), Vec3.create(...VISIBLE_CENTER as [number, number, number]), transform));
const metresApart = (a: number[], b: number[]) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) * METRES_PER_UNIT;

describe('the point a turn pivots about', () => {
  it('leaves the drawn centre still while the wearer yaws', () => {
    const resting = drawnAt(placementTransform(PLACEMENT));
    const turning = drawnAt(presentationTransform(PLACEMENT, VISIBLE_CENTER, { grabRotation: yaw(YAW_DEGREES) }));
    expect(metresApart(resting, turning)).toBeLessThan(0.01);
  });

  it('swung it a quarter of a metre when it pivoted on the whole assembly', () => {
    // The assembly centre is 17.9 Angstrom from the drawn lobe's, and at
    // placement scale 2.4 a 30-degree yaw about it carries the only thing on
    // screen 0.28 m. A held stick keeps yawing, so the drawn centre runs a
    // circle a metre across.
    const resting = drawnAt(placementTransform(PLACEMENT));
    const turning = drawnAt(presentationTransform(PLACEMENT, BASE_CENTER, { grabRotation: yaw(YAW_DEGREES) }));
    expect(metresApart(resting, turning)).toBeGreaterThan(0.25);
    const halfway = drawnAt(presentationTransform(PLACEMENT, BASE_CENTER, { grabRotation: yaw(180) }));
    expect(metresApart(resting, halfway)).toBeGreaterThan(1);
  });

  it('holds through the bake, so nothing jumps when the wearer lets go', () => {
    const grabRotation = yaw(YAW_DEGREES), grabScale = 1.35;
    const grabOffset = [12, -4, 7];
    const live = drawnAt(presentationTransform(PLACEMENT, VISIBLE_CENTER, { grabRotation, grabScale, grabOffset }));
    const next = { rotation: rotationDegreesZYX(Mat4.mul(Mat4(), grabRotation, rotationFromPlacement(PLACEMENT))),
      scale: PLACEMENT.scale * grabScale };
    const baked = { ...next, translation: pivotPreservingTranslation(
      { baseCenter: BASE_CENTER, visibleCenter: VISIBLE_CENTER, radius: RADIUS }, PLACEMENT, next, grabOffset) };
    expect(metresApart(live, drawnAt(placementTransform(baked)))).toBeLessThan(0.01);
    // The travel the wearer actually made, and nothing else.
    expect(metresApart(drawnAt(placementTransform(PLACEMENT)),
      drawnAt(placementTransform(baked)))).toBeCloseTo(Math.hypot(12, 4, 7) * METRES_PER_UNIT, 6);
  });

  it('jumps at release if the bake only adds the travel', () => {
    // viewer.mjs bakeGrab used to be: translation + grabOffset / radius.
    // Correct while the pivot was the assembly centre, wrong once the turn is
    // about the drawn centre, because the stored travel is still measured from
    // the assembly centre and its own pivot offset turned with the rotation.
    const grabRotation = yaw(YAW_DEGREES), grabOffset = [12, -4, 7];
    const live = drawnAt(presentationTransform(PLACEMENT, VISIBLE_CENTER, { grabRotation, grabOffset }));
    const naive = { rotation: rotationDegreesZYX(Mat4.mul(Mat4(), grabRotation, rotationFromPlacement(PLACEMENT))),
      scale: PLACEMENT.scale,
      translation: PLACEMENT.translation.map((value, axis) => value + grabOffset[axis] / RADIUS) };
    expect(metresApart(live, drawnAt(placementTransform(naive)))).toBeGreaterThan(0.01);
  });

  it('gives the agent spin the centre the wearer\'s hands use', () => {
    const motionAngle = 47;
    const resting = drawnAt(placementTransform(PLACEMENT));
    const spinning = drawnAt(presentationTransform(PLACEMENT, VISIBLE_CENTER, { motionAngle }));
    expect(metresApart(resting, spinning)).toBeLessThan(0.01);
    // freezePresentationPose bakes the displayed angle; it must not shift either.
    const next = { rotation: rotationDegreesZYX(Mat4.mul(Mat4(), yaw(motionAngle), rotationFromPlacement(PLACEMENT))),
      scale: PLACEMENT.scale };
    const frozen = { ...next, translation: pivotPreservingTranslation(
      { baseCenter: BASE_CENTER, visibleCenter: VISIBLE_CENTER, radius: RADIUS }, PLACEMENT, next) };
    expect(metresApart(spinning, drawnAt(placementTransform(frozen)))).toBeLessThan(0.01);
  });

  it('reduces to the old arithmetic when the whole assembly is drawn', () => {
    const grabOffset = [12, -4, 7];
    const next = { rotation: [11, -23, 5], scale: 3.1 };
    expect(drawnCenterOffset({ baseCenter: BASE_CENTER, visibleCenter: undefined }, next.rotation, next.scale))
      .toEqual([0, 0, 0]);
    expect(pivotPreservingTranslation({ baseCenter: BASE_CENTER, visibleCenter: BASE_CENTER, radius: RADIUS },
      PLACEMENT, next, grabOffset))
      .toEqual(PLACEMENT.translation.map((value, axis) => value + grabOffset[axis] / RADIUS));
  });

  it('agrees with the matrices about where the drawn centre is', () => {
    const placement = { translation: PLACEMENT.translation, rotation: [14, -31, 8], scale: 1.7 };
    const predicted = drawnCenterInScene({ baseCenter: BASE_CENTER, visibleCenter: VISIBLE_CENTER,
      radius: RADIUS, placement });
    expect(metresApart(predicted, drawnAt(placementTransform(placement)))).toBeLessThan(0.0001);
  });
});

it('bakes an enlarged visible subset beyond ten radii without a release jump', () => {
  const prior={translation:[12,-20,30],rotation:[14,-31,8],scale:8};
  const next={rotation:[40,50,-20],scale:16}, moved=[12,-4,7];
  const bounds={baseCenter:BASE_CENTER,visibleCenter:VISIBLE_CENTER,radius:RADIUS};
  const before=drawnCenterInScene({...bounds,placement:prior});
  const baked={...next,translation:pivotPreservingTranslation(bounds,prior,next,moved)};
  const after=drawnCenterInScene({...bounds,placement:baked});
  after.forEach((v:number,i:number)=>expect(v).toBeCloseTo(before[i]+moved[i],10));
  expect(baked.translation.some((v:number)=>Math.abs(v)>10)).toBe(true);
});
