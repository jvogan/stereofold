import { PLACEMENT_MIN_SCALE, PLACEMENT_MAX_SCALE, PLACEMENT_MAX_TRANSLATION } from './placement-limits.mjs';
const finiteVector = (value, name) => {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(Number.isFinite)) throw Error(`${name} must be three finite numbers.`);
  return value;
};
const finiteSphere = (value, name) => {
  if (!value || typeof value !== 'object') throw Error(`${name} is required.`);
  const center = finiteVector(value.center, `${name} center`);
  if (!Number.isFinite(value.radius) || value.radius <= 0) throw Error(`${name} radius must be positive.`);
  return { center, radius: value.radius };
};
const finitePlacement = value => {
  if (!value || typeof value !== 'object') throw Error('Prior placement is required.');
  const translation = finiteVector(value.translation, 'Prior translation');
  if (translation.some(v => Math.abs(v) > PLACEMENT_MAX_TRANSLATION)) throw Error('Prior translation is outside the supported placement range.');
  const rotation = finiteVector(value.rotation, 'Prior rotation');
  if (!Number.isFinite(value.scale) || value.scale < PLACEMENT_MIN_SCALE || value.scale > PLACEMENT_MAX_SCALE) throw Error('Prior scale is outside the supported placement range.');
  return { translation, rotation, scale: value.scale };
};
const add = (a, b) => a.map((value, index) => value + b[index]);
const subtract = (a, b) => a.map((value, index) => value - b[index]);
const scale = (value, factor) => value.map(item => item * factor);

// Matches viewer.mjs placementTransform: z * y * x rotation on a uniform scale.
function rotateZYX(vector, degrees) {
  const [xDegrees, yDegrees, zDegrees] = degrees.map(value => value * Math.PI / 180);
  const cx = Math.cos(xDegrees), sx = Math.sin(xDegrees);
  const cy = Math.cos(yDegrees), sy = Math.sin(yDegrees);
  const cz = Math.cos(zDegrees), sz = Math.sin(zDegrees);
  const x1 = vector[0], y1 = cx * vector[1] - sx * vector[2], z1 = sx * vector[1] + cx * vector[2];
  const x2 = cy * x1 + sy * z1, y2 = y1, z2 = -sy * x1 + cy * z1;
  return [cz * x2 - sz * y2, sz * x2 + cz * y2, z2];
}

/**
 * Re-expresses an inspection placement after a source replacement.
 *
 * The viewer's transform pivots on each source's full molecular bounds while
 * experience stages may render a filtered subset. This preserves the rendered
 * subset's center and diameter in the renderer's room frame; it never reads or
 * writes a tracked headset pose. When a size ratio exceeds the inspection
 * placement limits, Mol*'s supported XR scene scale carries the remainder; a
 * source origin that would exceed the translation range is expressed by a
 * matching offset of Mol*'s render reference frame. The tracked pose stays local.
 */
export function preserveSourceTransitionAnchor({ priorBase, priorVisible, priorPlacement, priorCameraScale, nextBase, nextVisible,
  priorCoordinateFrame, nextCoordinateFrame }) {
  // A staged gallery declares one common absolute Å frame. Anchor its unit
  // sphere at the shared origin instead of normalizing different batch bounds;
  // this retains the exact transform of every common target atom.
  const sharedFrame = typeof priorCoordinateFrame === 'string' && priorCoordinateFrame.length > 0
    && priorCoordinateFrame === nextCoordinateFrame;
  if (sharedFrame) priorVisible = nextVisible = { center: [0, 0, 0], radius: 1 };
  const oldBase = finiteSphere(priorBase, 'Prior source bounds');
  const oldVisible = finiteSphere(priorVisible ?? priorBase, 'Prior visible bounds');
  const placement = finitePlacement(priorPlacement);
  const newBase = finiteSphere(nextBase, 'Next source bounds');
  const newVisible = finiteSphere(nextVisible ?? nextBase, 'Next visible bounds');
  if (!Number.isFinite(priorCameraScale) || priorCameraScale <= 0) throw Error('Prior camera scale must be positive.');
  const unconstrainedPlacementScale = oldVisible.radius * placement.scale / newVisible.radius;
  // Inspection placement has finite numerical guardrails. When the new source is
  // much larger or smaller, retain the room diameter with Mol*'s XR scene scale
  // and use the nearest legal inspection scale; head rotation is independent.
  const nextScale = Math.min(PLACEMENT_MAX_SCALE, Math.max(PLACEMENT_MIN_SCALE, unconstrainedPlacementScale));
  const nextCameraScale = priorCameraScale * unconstrainedPlacementScale / nextScale;
  if (!Number.isFinite(nextCameraScale) || nextCameraScale <= 0) throw Error('The next source has no safe XR scene scale.');
  const oldPivot = add(oldBase.center, scale(placement.translation, oldBase.radius));
  const oldVisibleRoomCenter = add(oldPivot, rotateZYX(scale(subtract(oldVisible.center, oldBase.center), placement.scale), placement.rotation));
  // Camera.scale maps render coordinates into the XR room. Keep the rendered
  // center fixed by expressing the old center in the new render scale.
  const nextRoomCenter = scale(oldVisibleRoomCenter, priorCameraScale / nextCameraScale);
  const newVisibleOffset = rotateZYX(scale(subtract(newVisible.center, newBase.center), nextScale), placement.rotation);
  let translation = scale(subtract(subtract(nextRoomCenter, newBase.center), newVisibleOffset), 1 / newBase.radius);
  let cameraOffset;
  if (translation.some(value => Math.abs(value) > PLACEMENT_MAX_TRANSLATION)) {
    // Translation is in molecular radii, so a smaller source can exceed the
    // numerical range at the very same room position. Rebase the render origin instead
    // of refusing a valid room anchor or moving the molecule toward the wearer.
    // Moving position and target by this same offset preserves view direction.
    cameraOffset = subtract(add(newBase.center, newVisibleOffset), nextRoomCenter);
    translation = [0, 0, 0];
  }
  if (!translation.every(Number.isFinite) || (cameraOffset && !cameraOffset.every(Number.isFinite))) {
    throw Error('The next source cannot preserve the current room position within the supported placement range.');
  }
  return { placement: { translation, rotation: [...placement.rotation], scale: nextScale }, cameraScale: nextCameraScale,
    usedCameraScale: nextScale !== unconstrainedPlacementScale, ...(cameraOffset ? { cameraOffset } : {}),
    ...(sharedFrame ? { preservesCoordinateFrame: true } : {}) };
}

export function transformedVisibleCenter({ base, visible, placement }) {
  const source = finiteSphere(base, 'Source bounds');
  const shown = finiteSphere(visible ?? base, 'Visible bounds');
  const transform = finitePlacement(placement);
  return add(add(source.center, scale(transform.translation, source.radius)),
    rotateZYX(scale(subtract(shown.center, source.center), transform.scale), transform.rotation));
}
