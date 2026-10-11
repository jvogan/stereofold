import { toolbarSeatBasis, HALF_IPD_METERS, EYE_HALF_FIELD_DEGREES,
  EYE_HALF_FIELD_VERTICAL_DEGREES, PANEL_FRAME_MARGIN_DEGREES } from './spatial-toolbar-geometry.mjs';

/** Test the committed glass against both eyes in the menu's upright design frame.
 * A wearer summon checks this before drawing a new seat. Host redraws leave
 * the room seat alone even after walking, crouching or turning.
 */
export function menuSeatWithinView(points, head) {
  const basis = toolbarSeatBasis(head);
  if (!basis || !points?.length) return false;
  const horizontal = Math.tan((EYE_HALF_FIELD_DEGREES - PANEL_FRAME_MARGIN_DEGREES) * Math.PI / 180);
  const vertical = Math.tan((EYE_HALF_FIELD_VERTICAL_DEGREES - PANEL_FRAME_MARGIN_DEGREES) * Math.PI / 180);
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  for (const side of [-1, 1]) for (const point of points) {
    const relative = point.map((value, axis) => value - basis.origin[axis] - side * HALF_IPD_METERS * basis.right[axis]);
    const depth = dot(relative, basis.forward);
    if (!(depth > 0) || Math.abs(dot(relative, basis.right)) > depth * horizontal + 1e-6
      || Math.abs(dot(relative, basis.up)) > depth * vertical + 1e-6) return false;
  }
  return true;
}

/** A peripheral panel is read after turning toward it, at the same eye position. */
export function menuSeatWithinGlance(points, head, anchor) {
  const basis = toolbarSeatBasis(head);
  if (!basis || !anchor?.every(Number.isFinite)) return false;
  const dx = anchor[0] - basis.origin[0], dz = anchor[2] - basis.origin[2];
  const length = Math.hypot(dx, dz);
  if (!(length > 1e-6)) return false;
  const fx = dx / length, fz = dz / length;
  return menuSeatWithinView(points, { position: { x: basis.origin[0], y: basis.origin[1], z: basis.origin[2] },
    matrix: [-fz, 0, fx, 0, 0, 1, 0, 0, -fx, 0, -fz, 0, ...basis.origin, 1] });
}
