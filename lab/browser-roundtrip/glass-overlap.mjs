import { HALF_IPD_METERS } from './placement-fit-envelope.mjs';
import { applyMatrix4, invertMatrix4 } from './room-lock.mjs';

// Plates closer than this in an eye, in view tangent, count as touching.
const PLATE_GAP_TANGENT = .004;

const turn = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** The convex outline of points on the view plane, counter-clockwise. */
function hull(points) {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const half = list => list.reduce((chain, point) => {
    while (chain.length >= 2 && turn(chain.at(-2), chain.at(-1), point) <= 0) chain.pop();
    chain.push(point);
    return chain;
  }, []);
  const lower = half(sorted), upper = half([...sorted].reverse());
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

// Separating axes: each outline edge's normal, and the two view axes, which
// also cover an outline that is only a segment or a point.
function apart(a, b) {
  const axes = [[1, 0], [0, 1]];
  for (const outline of [a, b]) outline.forEach((point, index) => {
    const next = outline[(index + 1) % outline.length];
    const edge = [next[0] - point[0], next[1] - point[1]], length = Math.hypot(...edge);
    if (length > 1e-9) axes.push([-edge[1] / length, edge[0] / length]);
  });
  return axes.some(axis => {
    const spans = [a, b].map(outline => outline.map(point => point[0] * axis[0] + point[1] * axis[1]));
    return Math.min(...spans[1]) - Math.max(...spans[0]) > PLATE_GAP_TANGENT
      || Math.min(...spans[0]) - Math.max(...spans[1]) > PLATE_GAP_TANGENT;
  });
}

/**
 * Whether any two glass plates cover each other in any eye: each plate's
 * points (in the frame the views look from) projected through each eye and
 * compared by their convex outlines. A plate reaching the eye plane cannot be
 * measured and counts as covering.
 */
export function glassPlatesOverlap(plates, views) {
  const drawn = (plates ?? []).filter(points => points?.length);
  if (drawn.length < 2 || !views?.length) return false;
  return views.some(view => {
    const m = view.transform.inverse.matrix;
    const outlines = drawn.map(points => points.map(point => {
      const [x, y, z] = applyMatrix4(point, m);
      return z < -1e-5 ? [x / -z, y / -z] : undefined;
    }));
    if (outlines.some(outline => outline.some(point => !point))) return true;
    const shapes = outlines.map(hull);
    return shapes.some((shape, i) => shapes.slice(i + 1).some(other => !apart(shape, other)));
  });
}

/** The two eyes of a seat's head pose, as views `glassPlatesOverlap` reads. */
export function seatEyeViews(head) {
  const matrix = head?.transform?.matrix ?? head?.matrix;
  if (!matrix) return [];
  const position = head?.transform?.position ?? head?.position;
  const origin = position ? [position.x, position.y, position.z] : matrix.slice(12, 15);
  return ['left', 'right'].map((eye, index) => {
    const side = index ? HALF_IPD_METERS : -HALF_IPD_METERS, pose = [...matrix];
    for (let axis = 0; axis < 3; axis++) pose[12 + axis] = origin[axis] + side * matrix[axis];
    return { eye, transform: { inverse: { matrix: invertMatrix4(pose) } } };
  });
}

/** `glassPlatesOverlap` for glass in room metres seen through render-space views. */
export function glassPlatesOverlapInViews({ plates, views, renderFromRoom }) {
  return glassPlatesOverlap((plates ?? []).map(points => points.map(point => applyMatrix4(point, renderFromRoom))), views);
}
