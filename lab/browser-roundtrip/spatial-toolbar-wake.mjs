// The pure press rules of the spatial menu, kept free of Mol* so node --test
// can load them from the lab without the viewer bundle.
import { EPSILON } from './spatial-toolbar-geometry.mjs';

function unit(vector, fallback = [0, 0, 1]) {
  const length = Math.hypot(...vector);
  return Number.isFinite(length) && length > EPSILON ? vector.map(value => value / length) : [...fallback];
}

/**
 * Whether a ray lands on the menu plate's glass.
 *
 * The quiet draw keeps four rows where the full draw holds nine, so a press
 * aimed at a full-draw seat can arrive after the swap into a seat that is now
 * empty. The row hit test then finds nothing and the press dies silently,
 * which reads as the menu ignoring the wearer. The rule is that a press anywhere
 * on the full-draw footprint wakes the full draw instead, so this tests the
 * ray against the control backing glass (which spans every row seat and the
 * status line plus its margin) rather than against the currently drawn rows.
 * Pure: the panel is a `createToolbarPanel` result, the ray XR local metres.
 */
export function hitToolbarFootprint(panel, ray) {
  if (!panel?.backing || !Array.isArray(panel?.anchor) || !Array.isArray(panel?.normal)
    || !Array.isArray(panel?.right) || !Array.isArray(panel?.up)
    || !Array.isArray(ray?.origin) || !Array.isArray(ray?.direction)) return false;
  const direction = unit(ray.direction, [0, 0, 0]);
  if (direction.length !== 3 || Math.hypot(...direction) <= EPSILON) return false;
  const divisor = direction.reduce((sum, value, axis) => sum + value * panel.normal[axis], 0);
  if (!Number.isFinite(divisor) || Math.abs(divisor) <= EPSILON) return false;
  const distance = panel.anchor.reduce((sum, value, axis) => sum + (value - ray.origin[axis]) * panel.normal[axis], 0) / divisor;
  if (!Number.isFinite(distance) || distance < 0) return false;
  const point = ray.origin.map((value, axis) => value + direction[axis] * distance);
  const backing = panel.backing;
  if (!Array.isArray(backing?.point) || !Number.isFinite(backing?.halfWidth) || !Number.isFinite(backing?.halfHeight)) return false;
  const along = backing.point.reduce((sum, value, axis) => sum + (point[axis] - value) * panel.right[axis], 0);
  const up = backing.point.reduce((sum, value, axis) => sum + (point[axis] - value) * panel.up[axis], 0);
  return Math.abs(along) <= backing.halfWidth && Math.abs(up) <= backing.halfHeight;
}

/** The visible glass can be dragged. Keep gaps and rounded-off corners clear. */
export function hitToolbarGlass(panel, ray) {
  if (!panel || ![panel.anchor, panel.normal, panel.right, panel.up, ray?.origin, ray?.direction]
    .every(vector => Array.isArray(vector) && vector.length === 3 && vector.every(Number.isFinite))) return false;
  const direction = unit(ray.direction, [0, 0, 0]);
  const dot = (a, b) => a.reduce((sum, value, axis) => sum + value * b[axis], 0);
  const depth = panel.backingDepthMeters ?? 0;
  return [panel.backing, panel.captionBacking, panel.statusBacking].some(plate => {
    if (!plate || !Number.isFinite(plate.halfWidth) || !Number.isFinite(plate.halfHeight)) return false;
    const normal = plate.normal ?? panel.normal, right = plate.right ?? panel.right, up = plate.up ?? panel.up;
    const divisor = dot(direction, normal);
    if (Math.abs(divisor) <= EPSILON) return false;
    const distance = (dot(plate.point.map((value, axis) => value - ray.origin[axis]), normal) + depth) / divisor;
    if (!Number.isFinite(distance) || distance < 0) return false;
    const point = ray.origin.map((value, axis) => value + direction[axis] * distance);
    const delta = point.map((value, axis) => value - plate.point[axis]);
    const x = Math.abs(dot(delta, right)), y = Math.abs(dot(delta, up));
    if (x > plate.halfWidth || y > plate.halfHeight) return false;
    const corner = Math.max(0, Math.min(panel.backingCornerMeters ?? 0, plate.halfWidth, plate.halfHeight));
    return Math.hypot(Math.max(0, x - plate.halfWidth + corner), Math.max(0, y - plate.halfHeight + corner)) <= corner;
  });
}

/**
 * What one select press does. A row hit always presses that
 * row, quiet draw or not. A miss on the full-draw footprint while quiet wakes
 * the full draw and consumes the press — it must not also trigger a row, so
 * `wake` carries no row action. Anything else is ignored exactly as before.
 */
export function toolbarPressDecision({ rowHit = false, quiet = false, footprintHit = false } = {}) {
  if (rowHit) return 'row';
  if (quiet && footprintHit) return 'wake';
  return 'miss';
}
