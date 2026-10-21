import { Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { focusPlacement, focusRotation } from './focus-placement.mjs';
import { PLACEMENT_MAX_TRANSLATION } from './placement-limits.mjs';

/** Ordinary animated entries may shrink by 20% or grow by 25%. */
export const MOTION_SCALE_CAP = 1.25;

/**
 * Fit only the subject, then express the seat in the unchanged source basis.
 * `previousScale` caps the change; with `growToFit` (a lesson install's frame)
 * it is only a floor, so the fit can grow in one step but never shrinks more.
 */
export function motionFocusPlacement(options) {
  const { center, radius, targetCenter, targetRadius, placement, previousScale, growToFit = false } = options;
  const plan = focusPlacement({ ...options, center: targetCenter, assemblyRadius: targetRadius,
    subjectPoints: undefined, assemblyPoints: undefined, minExtentFraction: 0, wholeStructure: true });
  const rotation = focusRotation(placement.rotation);
  const offset = Vec3.sub(Vec3(), targetCenter, center);
  const rotated = Vec3.transformMat4(Vec3(), offset, rotation);
  const scale = previousScale > 0
    ? Math.max(previousScale / MOTION_SCALE_CAP, growToFit ? plan.scale : Math.min(previousScale * MOTION_SCALE_CAP, plan.scale))
    : plan.scale;
  // Growing the physical subject moves its seat away by the same ratio. Its
  // entire angular envelope is preserved, so a scale floor cannot crop travel
  // or put moving geometry behind the wearer. Shrinking keeps the solved seat.
  const travel = Math.max(1, scale / plan.scale);
  const roomEye = options.headInRoom.slice(12, 15);
  const targetRoom = plan.targetRoom.map((v, i) => roomEye[i] + (v - roomEye[i]) * travel);
  const targetRender = Vec3.scale(Vec3(),
    Vec3.transformMat4(Vec3(), targetRoom, options.renderFromRoom), 1 / plan.cameraScale);
  const translation = center.map((v, i) => (targetRender[i] - v - rotated[i] * scale) / radius);
  if (translation.some(value => !Number.isFinite(value) || Math.abs(value) > PLACEMENT_MAX_TRANSLATION))
    throw Error('That motion is outside the current placement range. Bring the structure closer first.');
  const ratio = scale / plan.scale;
  const assembly = plan.standoff.assembly;
  const distance = plan.distance * travel;
  const radiusMetres = assembly.radiusMetres * ratio, depthMetres = assembly.depthMetres * ratio;
  return { ...plan, scale, translation, targetRoom, distance,
    angleDegrees: 2 * Math.atan(Math.tan(plan.angleDegrees * Math.PI / 360) * ratio / travel) * 180 / Math.PI,
    standoff: { ...plan.standoff, clears: distance - depthMetres >= plan.standoff.floorMetres - 1e-6,
      assembly: { ...assembly, centre: targetRoom, distanceMetres: distance, radiusMetres, depthMetres,
        nearestMetres: distance - depthMetres, farthestMetres: distance + depthMetres,
        subjectFraction: assembly.subjectFraction * ratio / travel, subjectRise: assembly.subjectRise * ratio / travel,
        assemblyFraction: assembly.assemblyFraction * ratio / travel,
        assemblyWide: assembly.assemblyWide * ratio / travel, assemblyTall: assembly.assemblyTall * ratio / travel } },
    motionScale: { previous: previousScale, fitted: plan.scale, cap: MOTION_SCALE_CAP } };
}
