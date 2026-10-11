import { createToolbarPanel, toolbarPlatePoints, HALF_IPD_METERS } from './spatial-toolbar-geometry.mjs';
import { menuSeatWithinView } from './menu-view-band.mjs';
import { invertMatrix4 } from './room-lock.mjs';
import { MAX_FRAME_TRANSLATION, gripDepthTranslation } from './xr-manipulate.mjs';

const multiply = (a, b) => Array.from({ length: 16 }, (_, index) => {
  const row = index % 4, column = Math.floor(index / 4);
  return [0, 1, 2, 3].reduce((sum, k) => sum + a[k * 4 + row] * b[column * 4 + k], 0);
});

/** Complete, readable alternate glass. This proposes menu seats only. */
export function menuRelocationCandidates(options, head, { labelViews, renderFromRoom } = {}) {
  const candidates = [];
  for (const side of [-1, 1]) for (const lift of [0, .15, -.15, .3, -.3]) {
    const constants = { ...options.constants, peripheralSeat: false,
      rightMeters: side * Math.abs(options.constants.rightMeters),
      lowerMeters: options.constants.lowerMeters - lift };
    const panel = createToolbarPanel({ ...options, head, constants, seatAnchor: undefined });
    const points = toolbarPlatePoints(panel);
    if (!menuSeatWithinView(points, head)) continue;
    candidates.push({ id: candidates.length, points, anchor: panel.anchor, head, constants });
  }
  // If the current gaze is full of molecule, park to a side. The hypothetical
  // turned head is only a measurement frame; tracked head/camera never change.
  const roomFromRender = invertMatrix4(renderFromRoom);
  if (roomFromRender && labelViews?.length) for (const side of [-1, 1]) {
    const angle = side * 55 * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
    const matrix = [...head.matrix];
    for (const column of [0, 4, 8]) {
      matrix[column] = c * head.matrix[column] + s * head.matrix[column + 2];
      matrix[column + 2] = -s * head.matrix[column] + c * head.matrix[column + 2];
    }
    const turned = { ...head, matrix };
    const constants = { ...options.constants, peripheralSeat: false, rightMeters: -side * Math.abs(options.constants.rightMeters) };
    const panel = createToolbarPanel({ ...options, head: turned, constants, seatAnchor: undefined });
    const points = toolbarPlatePoints(panel);
    if (!menuSeatWithinView(points, turned)) continue;
    const views = labelViews.map(view => {
      const eye = [...matrix], offset = view.eye === 'left' ? -HALF_IPD_METERS : view.eye === 'right' ? HALF_IPD_METERS : 0;
      for (let axis = 0; axis < 3; axis++) eye[12 + axis] += matrix[axis] * offset;
      return { eye: view.eye, projectionMatrix: Array.from(view.projectionMatrix),
        transform: { inverse: { matrix: multiply(invertMatrix4(eye), roomFromRender) } } };
    });
    candidates.push({ id: candidates.length, points, anchor: panel.anchor, head: turned, constants, views, parked: true });
  }
  return candidates;
}

/** Ray-depth translation; parking outside the current gaze is intentional. */
export function menuDragOffset(anchor, startRay, ray, origin) {
  const unit = value => {
    const length = Math.hypot(...value);
    return length > 1e-8 && value.every(Number.isFinite) ? value.map(v => v / length) : undefined;
  };
  const initial = unit(startRay?.direction ?? []), direction = unit(ray?.direction ?? []);
  if (!initial || !direction || ![anchor, origin, startRay.origin, ray.origin].every(p => p?.length === 3 && p.every(Number.isFinite))) return undefined;
  const depth = anchor.reduce((sum, value, axis) => sum + (value - startRay.origin[axis]) * initial[axis], 0);
  // A controller may be close to a row or point at a deliberately distant
  // menu. The caller checks the glass's full clearance from the wearer's head;
  // controller-to-anchor distance must not make an otherwise valid drag inert.
  if (!(depth > 0)) return undefined;
  // An arm-model origin can move with a wrist turn. Only measured positions
  // supply hand travel; orientation remains useful with tracking disabled.
  const measured = startRay.emulatedPosition === false && ray.emulatedPosition === false;
  const offset = ray.origin.map((value, axis) => (measured ? value - startRay.origin[axis] : 0)
    + depth * (direction[axis] - initial[axis]));
  return offset.every(Number.isFinite) ? offset : undefined;
}

/** Continue a held menu from its last drawn offset after a pose discontinuity. */
export function menuDragStep(drag, ray, origin) {
  if (!ray || !origin) { drag.rebase = true; return undefined; }
  const previous = drag.lastRay ?? drag.ray;
  const snapshot = { ...ray, origin: [...ray.origin], direction: [...ray.direction] };
  drag.lastRay = snapshot;
  const jumped = previous.emulatedPosition === false && ray.emulatedPosition === false
    && Math.hypot(...ray.origin.map((value, axis) => value - previous.origin[axis])) > MAX_FRAME_TRANSLATION;
  if (drag.rebase || drag.ray.emulatedPosition !== ray.emulatedPosition || jumped) {
    drag.ray = snapshot;
    drag.baseOffset = [...drag.offset];
    drag.rebase = false;
    return [...drag.offset];
  }
  const base = drag.baseOffset ?? [0, 0, 0];
  const anchor = drag.anchor.map((value, axis) => value + base[axis]);
  const offset = menuDragOffset(anchor, drag.ray, ray, origin);
  return offset?.map((value, axis) => value + base[axis]);
}

/** Measured grip travel moves the menu directly, with a useful depth reach.
 * Pulling toward the wearer changes apparent size by changing distance; it
 * does not silently resize text or turn arm-model motion into translation.
 */
export function menuGripDragStep(drag, grip, headOrigin) {
  if (!grip || !headOrigin || grip.emulatedPosition !== false) { drag.rebase = true; return undefined; }
  const snapshot = { origin: [...grip.origin], emulatedPosition: grip.emulatedPosition };
  const previous = drag.lastGrip ?? drag.grip;
  drag.lastGrip = snapshot;
  if (!previous || previous.emulatedPosition !== false || drag.rebase
      || Math.hypot(...grip.origin.map((v, i) => v - previous.origin[i])) > MAX_FRAME_TRANSLATION) {
    drag.grip = snapshot; drag.baseOffset = [...drag.offset]; drag.rebase = false;
    return [...drag.offset];
  }
  const base = drag.baseOffset ?? [0, 0, 0];
  const delta = grip.origin.map((v, i) => v - drag.grip.origin[i]);
  const translated = gripDepthTranslation(delta, drag.depthAxis);
  return translated.map((v, i) => base[i] + v);
}

/** Clamp a proposed translation to the first clearance contact along its travel. */
export function clampMenuDragOffset(previous, proposed, clearance, minimum) {
  if (clearance(proposed) >= minimum) return proposed;
  if (!(clearance(previous) >= minimum)) return undefined;
  let low = 0, high = 1;
  const at = fraction => previous.map((v, i) => v + (proposed[i] - v) * fraction);
  for (let i = 0; i < 24; i++) {
    const mid = (low + high) / 2;
    if (clearance(at(mid)) >= minimum) low = mid; else high = mid;
  }
  return at(low);
}
