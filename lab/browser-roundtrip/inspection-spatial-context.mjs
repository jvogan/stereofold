import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';

// Convert the actual XR head pose from Mol*'s scaled render space into the
// unplaced molecule's local axes, centered and measured in molecular radii.
// No room-origin pose or scientific camera snapshot is retained.
export function relativeHeadContext({ mode, headMatrix, cameraScale, moleculeTransform, center, radius }) {
  if (!['immersive-vr', 'immersive-ar'].includes(mode)
    || !Number.isFinite(cameraScale) || cameraScale <= 0 || !Number.isFinite(radius) || radius <= 0
    || headMatrix?.length !== 16 || moleculeTransform?.length !== 16 || center?.length !== 3
    || ![...headMatrix, ...moleculeTransform, ...center].every(Number.isFinite)
    || Math.abs(Mat4.determinant(moleculeTransform)) < 1e-12) return null;
  const inverse = Mat4.invert(Mat4(), moleculeTransform);
  const head = Vec3.scale(Vec3(), Mat4.getTranslation(Vec3(), headMatrix), 1 / cameraScale);
  Vec3.transformMat4(head, head, inverse);
  Vec3.sub(head, head, center);
  Vec3.scale(head, head, 1 / radius);
  const direction = Vec3.create(-headMatrix[8], -headMatrix[9], -headMatrix[10]);
  Vec3.transformDirection(direction, direction, inverse);
  const length = Vec3.magnitude(direction), distance = Vec3.magnitude(head);
  if (!Number.isFinite(distance) || distance > 100 || !Number.isFinite(length) || length < 1e-8) return null;
  Vec3.scale(direction, direction, 1 / length);
  const round = value => Math.round(value * 100000) / 100000 || 0;
  return { mode, headPosition: Array.from(head, round), viewDirection: Array.from(direction, round), distance: round(distance) };
}
