import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { litVertex } from './entry-standoff.mjs';
import { renderedMeshVertexCount } from './component-label-measurement.mjs';
import { focusRotation } from './focus-placement.mjs';
import { applyMatrix4, invertMatrix4, ROOM_LOCK_EPSILON } from './room-lock.mjs';
import { PLACEMENT_MAX_TRANSLATION, XR_ROOM_MAX_METRES } from './placement-limits.mjs';

/** A menu-clearance move may seat the chapter at most this many entry stand-offs away. */
export const CLEARANCE_STANDOFF_FACTOR = 1.5;

const cell = value => ({ ref: { value } });
// The eight corners of a cube `size` out from a point on every axis.
const boxCorners = size => [-1, 1].flatMap(x => [-1, 1].flatMap(y => [-1, 1].map(z => [x * size, y * size, z * size])));

/**
 * A circumscribed box proves clearance for every point of a motion sphere. A
 * plate (`quad`, its half axes in render units) is its four corners, each
 * widened to a box by its `sweep` along a moving path.
 */
export function framingEnvelopeObject(bounds, transform) {
  const inverse = invertMatrix4(transform);
  const source = vector => applyMatrix4(vector, inverse).map((v, i) => v - inverse[12 + i]);
  const positions = (bounds.spheres ?? [bounds]).flatMap(sphere => {
    const offset = sphere.renderOffset ? source(sphere.renderOffset) : [0, 0, 0];
    if (sphere.quad) {
      const [right, up] = sphere.quad.map(source);
      return [-1, 1].flatMap(x => [-1, 1].flatMap(y => (sphere.sweep > 0 ? boxCorners(sphere.sweep) : [[0, 0, 0]]).flatMap(widen =>
        sphere.center.map((v, i) => v + offset[i] + x * right[i] + y * up[i] + widen[i]))));
    }
    return [-1, 1].flatMap(x => [-1, 1].flatMap(y => [-1, 1].flatMap(z =>
      sphere.center.map((v, i) => v + offset[i] + [x, y, z][i] * sphere.radius))));
  });
  return { type: 'mesh', state: { visible: true }, values: {
    drawCount: cell(positions.length), instanceCount: cell(1), uVertexCount: cell(positions.length / 3),
    aPosition: cell(positions), aTransform: cell(Array.from(transform)),
  } };
}

// Cache invariant drawn-group bounds across page and status updates. Moving
// instance transforms are applied below; no mesh is rebuilt for clearance.
const drawnGroupCaches = [new WeakMap(), new WeakMap()];
const drawnAtomCaches = [new WeakMap(), new WeakMap()];
const visibleGroup = (v, vertex, instance, group, includeFaint) => {
  if (!v.dTransparency?.ref.value) return true;
  const type = v.dTransparencyType?.ref.value, instanceId = v.aInstance?.ref.value?.[instance] ?? instance;
  const index = type === 'instance' ? instanceId : type === 'vertexInstance'
    ? instanceId * v.uVertexCount?.ref.value + vertex : ['groupInstance', 'volumeInstance'].includes(type)
      ? instanceId * v.uGroupCount?.ref.value + group : NaN;
  const byte = v.tTransparency?.ref.value?.array?.[index];
  return Number.isFinite(byte) ? byte / 255 * (v.uTransparencyStrength?.ref.value ?? 1) < (includeFaint ? 1 : .09) : includeFaint;
};
// Sphere impostors have no mesh positions. Read the same live centre/group
// texture and packed size bytes as spheres.vert, rather than reserving the
// empty corners of the whole assembly's bounding sphere (GLUT1 spacefill).
function drawnAtoms(object, includeFaint) {
  const cache = drawnAtomCaches[Number(includeFaint)];
  const v = object.values, positions = v?.tPositionGroup?.ref.value?.array;
  const count = Math.min(Math.floor((v?.drawCount?.ref.value ?? 0) / 6), Math.floor((positions?.length ?? 0) / 4));
  const type = v?.dSizeType?.ref.value;
  if (object.type !== 'spheres' || !positions || !count || !v?.aTransform?.ref.value
    || !['uniform', 'attribute', 'instance', 'group', 'groupInstance', 'vertex', 'vertexInstance'].includes(type)) return undefined;
  const signature = ['tPositionGroup', 'drawCount', 'dSizeType', 'uSize', 'aSize', 'tSize', 'uSizeFactor', 'uVertexCount',
    'tTransparency', 'dTransparency', 'dTransparencyType', 'uTransparencyStrength', 'instanceCount', 'aInstance', 'uGroupCount']
    .flatMap(key => [v[key]?.ref.value, v[key]?.ref.version]).concat(includeFaint);
  const cached = cache.get(object);
  if (cached && signature.every((value, i) => value === cached.signature[i])) return cached.instances;
  const instances = Array.from({ length: v.instanceCount?.ref.value ?? 1 }, (_, instance) => {
    const balls = [], instanceId = v.aInstance?.ref.value?.[instance] ?? instance;
    for (let vertex = 0; vertex < count; vertex++) {
      const group = positions[vertex * 4 + 3], groupCount = v.uGroupCount?.ref.value;
      if (!visibleGroup(v, vertex, instance, group, includeFaint)) continue;
      const index = { instance: instanceId, group, groupInstance: instanceId * groupCount + group,
        vertex, vertexInstance: instanceId * v.uVertexCount?.ref.value + vertex }[type];
      const bytes = v.tSize?.ref.value?.array, offset = index * 3;
      const size = type === 'uniform' ? v.uSize?.ref.value : type === 'attribute' ? v.aSize?.ref.value?.[vertex]
        : bytes ? (bytes[offset] * 65536 + bytes[offset + 1] * 256 + bytes[offset + 2] - 1) / 100 : NaN;
      const radius = size * (v.uSizeFactor?.ref.value ?? 1);
      const center = Array.from(positions.slice(vertex * 4, vertex * 4 + 3));
      // Unknown size data must retain the conservative assembly fallback.
      if (!Number.isFinite(radius) || !center.every(Number.isFinite)) return undefined;
      if (radius > 0) balls.push({ center, radius });
    }
    return balls;
  });
  if (instances.some(balls => !balls)) return undefined;
  cache.set(object, { signature, instances });
  return instances;
}
function drawnGroups(object, includeFaint) {
  const cache = drawnGroupCaches[Number(includeFaint)];
  const v = object.values, positions = v?.aPosition?.ref.value, groups = v?.aGroup?.ref.value;
  const elements = v?.elements?.ref.value;
  if (object.type !== 'mesh' || !positions || !groups || !elements || !v?.aTransform?.ref.value) return undefined;
  const signature = ['aPosition', 'aGroup', 'elements', 'drawCount', 'uVertexCount', 'tTransparency',
    'dTransparency', 'dTransparencyType', 'uTransparencyStrength', 'instanceCount', 'aInstance', 'uGroupCount']
    .flatMap(key => [v[key]?.ref.value, v[key]?.ref.version]).concat(includeFaint);
  const cached = cache.get(object);
  if (cached && signature.every((value, i) => value === cached.signature[i])) return cached.instances;
  const count = renderedMeshVertexCount(object, positions), drawn = Math.min(elements.length, v.drawCount?.ref.value ?? elements.length);
  const instances = Array.from({ length: v.instanceCount?.ref.value ?? 1 }, (_, instance) => {
    const bounds = new Map();
    for (let i = 0; i + 2 < drawn; i += 3) {
      const triangle = [elements[i], elements[i + 1], elements[i + 2]];
      if (triangle.some(index => index >= count)) continue;
      if (!triangle.some(index => includeFaint ? visibleGroup(v, index, instance, groups[index], true)
        : litVertex(object, index, instance))) continue;
      const group = groups[triangle[0]];
      let bound = bounds.get(group);
      if (!bound) bounds.set(group, bound = { low: [Infinity, Infinity, Infinity], high: [-Infinity, -Infinity, -Infinity] });
      // Include all corners even across a group boundary: each complete
      // triangle is enclosed by at least one ball, never just its vertices.
      for (const index of triangle) for (let axis = 0; axis < 3; axis++) {
        const value = positions[index * 3 + axis];
        bound.low[axis] = Math.min(bound.low[axis], value);
        bound.high[axis] = Math.max(bound.high[axis], value);
      }
    }
    return [...bounds.values()].map(({ low, high }) => ({
      center: low.map((value, axis) => (value + high[axis]) / 2),
      radius: Math.hypot(...low.map((value, axis) => high[axis] - value)) / 2,
    }));
  });
  cache.set(object, { signature, instances });
  return instances;
}

/** Substantive drawn geometry, converted back to the fixed source basis. */
export function visibleChapterSpheres(objects, transform, { minimumAlpha = .2 } = {}) {
  const inverse = invertMatrix4(transform);
  const scale = Mat4.getMaxScaleOnAxis(transform);
  if (!inverse || !(scale > 0)) return [];
  return objects.flatMap(object => {
    const values = object.values, sphere = values?.boundingSphere?.ref.value;
    if (object.type === 'text' || object.state?.visible === false
      || (object.state?.alphaFactor ?? 1) * (values?.uAlpha?.ref.value ?? 1) <= minimumAlpha
      || !sphere || !(sphere.radius > 0)) return [];
    const groups = drawnAtoms(object, minimumAlpha === 0) ?? drawnGroups(object, minimumAlpha === 0);
    if (groups) return groups.flatMap((balls, instance) => {
      const matrix = Array.from(values.aTransform.ref.value.slice(instance * 16, instance * 16 + 16));
      const gain = Mat4.getMaxScaleOnAxis(matrix) / scale;
      return balls.map(ball => ({ center: applyMatrix4(applyMatrix4(ball.center, matrix), inverse), radius: ball.radius * gain }));
    });
    return [{ center: applyMatrix4(sphere.center, inverse), radius: sphere.radius / scale }];
  });
}

function rect(points, view) {
  const p = view.projectionMatrix, m = view.transform.inverse.matrix;
  const projected = points.map(point => {
    const [x, y, z] = applyMatrix4(point, m);
    return z < -1e-5 ? [(p[0] * x + p[8] * z + p[12]) / -z,
      (p[5] * y + p[9] * z + p[13]) / -z] : [Infinity, Infinity];
  });
  return { left: Math.min(...projected.map(p => p[0])), right: Math.max(...projected.map(p => p[0])),
    bottom: Math.min(...projected.map(p => p[1])), top: Math.max(...projected.map(p => p[1])) };
}
// A sphere's exact screen rectangle: the tangent planes through the eye, in
// each axis. It encloses the silhouette in any eye, also off-axis, where box
// corners overstate it. Infinity when the sphere reaches the eye plane. The
// centre is in the eye's space.
function eyeBallRect([x, y, z], radius, p) {
  const depth = -z, d2 = depth * depth - radius * radius;
  if (!(depth > radius * (1 + 1e-6)) || !(d2 > 0)) return { left: -Infinity, right: Infinity, bottom: -Infinity, top: Infinity };
  const bounds = c => { const spread = radius * Math.sqrt(c * c + d2); return [(c * depth - spread) / d2, (c * depth + spread) / d2]; };
  const [l, r] = bounds(x), [b, t] = bounds(y);
  return { left: p[0] * l - p[8], right: p[0] * r - p[8], bottom: p[5] * b - p[9], top: p[5] * t - p[9] };
}
// Whether any sight line through the glass rectangle, widened by `gap`,
// meets the ball. The ball's own rectangle is the box round its silhouette,
// so a glass corner set diagonally off the ball fails that box while every
// ray through it misses the ball by a wide margin. Exact per eye: the closest
// direction to the centre over the rectangle lies at the centre's own
// direction or on an edge, where it has a closed form.
function eyeBallMeetsGlass([x, y, z], radius, menu, p, gap) {
  const depth = -z, limit = x * x + y * y + z * z - radius * radius;
  if (!(depth > radius * (1 + 1e-6)) || !(limit > 0)) return true;
  const left = (menu.left - gap + p[8]) / p[0], right = (menu.right + gap + p[8]) / p[0];
  const bottom = (menu.bottom - gap + p[9]) / p[5], top = (menu.top + gap + p[9]) / p[5];
  if (![left, right, bottom, top].every(Number.isFinite)) return true;
  const meets = (tx, ty) => { const along = x * tx + y * ty + depth; return along > 0 && along * along > limit * (tx * tx + ty * ty + 1); };
  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
  if (meets(clamp(x / depth, left, right), clamp(y / depth, bottom, top))) return true;
  for (const tx of [left, right]) {
    const along = x * tx + depth;
    if (meets(tx, bottom) || meets(tx, top) || (along > 0 && meets(tx, clamp(y * (tx * tx + 1) / along, bottom, top)))) return true;
  }
  for (const ty of [bottom, top]) {
    const along = y * ty + depth;
    if (along > 0 && meets(clamp(x * (ty * ty + 1) / along, left, right), ty)) return true;
  }
  return false;
}
const separated = (a, b, gap) => a.right + gap < b.left || b.right + gap < a.left
  || a.top + gap < b.bottom || b.top + gap < a.bottom;

// Project the origin onto a convex intersection of half spaces. In 3D the
// closest point lies on at most three independent planes. Enumerating those
// active sets avoids distance steps and their visible overshoot.
function closestDelta(planes) {
  const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
  let best;
  const consider = active => {
    const matrix = active.map(a => [...active.map(b => dot(a.normal, b.normal)), a.limit]);
    for (let i = 0; i < active.length; i++) {
      let pivot = i;
      for (let j = i + 1; j < active.length; j++) if (Math.abs(matrix[j][i]) > Math.abs(matrix[pivot][i])) pivot = j;
      if (Math.abs(matrix[pivot][i]) < 1e-10) return;
      [matrix[i], matrix[pivot]] = [matrix[pivot], matrix[i]];
      const divisor = matrix[i][i]; matrix[i] = matrix[i].map(v => v / divisor);
      for (let j = 0; j < active.length; j++) if (j !== i) {
        const factor = matrix[j][i]; matrix[j] = matrix[j].map((v, k) => v - factor * matrix[i][k]);
      }
    }
    const delta = [0, 1, 2].map(axis => active.reduce((sum, a, i) => sum + a.normal[axis] * matrix[i][active.length], 0));
    if (planes.some(p => dot(p.normal, delta) > p.limit + 1e-8)) return;
    if (!best || Math.hypot(...delta) < Math.hypot(...best)) best = delta;
  };
  consider([]);
  for (let a = 0; a < planes.length; a++) {
    consider([planes[a]]);
    for (let b = a + 1; b < planes.length; b++) {
      consider([planes[a], planes[b]]);
      for (let c = b + 1; c < planes.length; c++) consider([planes[a], planes[b], planes[c]]);
    }
  }
  return best;
}

// Math.min and Math.max over a list too long to spread as arguments: a
// drawn chapter holds a ball per atom, which overflows the call stack.
const least = values => values.reduce((low, value) => Math.min(low, value), Infinity);
const most = values => values.reduce((high, value) => Math.max(high, value), -Infinity);

// Screen separation is linear in a rigid translation after multiplying by
// positive eye depth. Solve all four sides of each glass plate in each eye and
// take the nearest feasible point, rather than moving backward until a coarse
// search clears. `glass` holds each eye's plate rectangles. Each plate keeps
// one side in both eyes, which stand 64 mm apart; a lone plate may still take
// a different side in each eye.
function nearestMenuPoint(initial, points, views, glass, renderFromRoom) {
  const count = glass[0]?.length ?? 0;
  if (!count || glass.some(plates => plates?.length !== count
    || plates.some(menu => !Object.values(menu).every(Number.isFinite)))) return undefined;
  const perView = views.map((view, index) => {
    const eyePoint = point => applyMatrix4(applyMatrix4(point, renderFromRoom), view.transform.inverse.matrix);
    const corners = points.map(point => applyMatrix4(point, view.transform.inverse.matrix));
    const origin = eyePoint(initial);
    const axes = [0, 1, 2].map(axis => eyePoint(initial.map((v, i) => v + (axis === i ? 1 : 0))).map((v,i) => v-origin[i]));
    const plane = evaluate => {
      const base = evaluate([0,0,0]);
      const normal = axes.map(axis => evaluate(axis)-base);
      return { normal, limit: -most(corners.map(evaluate)) - 1e-7 };
    };
    const p = view.projectionMatrix;
    const sides = glass[index].map(menu => [[0, menu.left-.04, 1], [0, menu.right+.04, -1],
      [1, menu.bottom-.04, 1], [1, menu.top+.04, -1]].map(([axis, edge, sign]) =>
      plane(point => sign*(p[axis === 0 ? 0 : 5]*point[axis]+(p[axis === 0 ? 8 : 9]+edge)*point[2]+p[axis === 0 ? 12 : 13]))));
    return { near: plane(point => point[2]+1e-5), sides };
  });
  const slots = count === 1 ? views.map((_, index) => [[index, 0]])
    : Array.from({ length: count }, (_, plate) => views.map((_, index) => [index, plate]));
  let choices = [perView.map(view => view.near)];
  for (const slot of slots) choices = choices.flatMap(planes => [0, 1, 2, 3].map(side =>
    [...planes, ...slot.map(([index, plate]) => perView[index].sides[plate][side])]));
  let best;
  for (const planes of choices) {
    const delta = closestDelta(planes);
    if (delta && (!best || Math.hypot(...delta) < Math.hypot(...best))) best = delta;
  }
  return best && initial.map((v,i) => v+best[i]);
}

// The field's spheres in room metres at the placement's scale and rotation,
// kept per bounds object: every seat a chapter tries is tested against one
// field, and a field holds thousands of drawn balls.
const fieldPartCache = new WeakMap();
function fieldParts({ placement, bounds, cameraScale, renderFromRoom }) {
  const key = JSON.stringify([placement.rotation, placement.scale, cameraScale, Array.from(renderFromRoom)]);
  const cached = fieldPartCache.get(bounds);
  if (cached?.key === key && cached.source === bounds.spheres) return cached;
  const rotation = focusRotation(placement.rotation);
  const roomFromRender = invertMatrix4(renderFromRoom);
  const room = vector => applyMatrix4(vector, roomFromRender).map((v, i) => v - roomFromRender[12 + i]);
  const spheres = (bounds.spheres ?? [bounds]).map(sphere => {
    const delta = Vec3.transformMat4(Vec3(), sphere.center.map((v, i) => v - bounds.center[i]), rotation)
      .map(v => v * placement.scale * cameraScale);
    if (sphere.renderOffset) for (let i = 0; i < 3; i++) delta[i] += sphere.renderOffset[i] * cameraScale;
    return { kind: sphere.kind, offset: room(delta), radius: sphere.radius * placement.scale * cameraScale,
      ...(sphere.quad ? { quad: sphere.quad.map(axis => room(axis.map(v => v * cameraScale))),
        sweep: (sphere.sweep ?? 0) * placement.scale * cameraScale,
        ...(sphere.push > 0 && sphere.toward ? { push: sphere.push * cameraScale, toward: room(sphere.toward) } : {}) } : {}) };
  });
  const entry = { key, source: bounds.spheres, rotation, roomFromRender, spheres, ...groupDrawnBalls(spheres) };
  fieldPartCache.set(bounds, entry);
  return entry;
}

// The drawn balls in a coarse grid, about twice the square root of their
// count in cells, each cell enclosed by one ball. Where a cell's ball clears
// the glass, every ball inside it does too, so its members need no test and
// the answer is the same as testing each one.
function groupDrawnBalls(spheres) {
  const drawn = [], loose = [];
  spheres.forEach((sphere, index) => (!sphere.quad && sphere.kind === 'drawn' ? drawn : loose).push(index));
  if (drawn.length < 32) return { loose: spheres.map((_, index) => index), groups: [] };
  const low = [0, 1, 2].map(i => least(drawn.map(index => spheres[index].offset[i])));
  const high = [0, 1, 2].map(i => most(drawn.map(index => spheres[index].offset[i])));
  const extent = high.map((v, i) => Math.max(v - low[i], 1e-9)), cells = 2 * Math.sqrt(drawn.length);
  const size = Math.max(Math.cbrt(extent[0] * extent[1] * extent[2] / cells), Math.max(...extent) / cells);
  const byCell = new Map();
  for (const index of drawn) {
    const key = spheres[index].offset.map((v, i) => Math.floor((v - low[i]) / size)).join();
    let members = byCell.get(key);
    if (!members) byCell.set(key, members = []);
    members.push(index);
  }
  const groups = [...byCell.values()].map(members => {
    const reach = (i, sign) => members.map(index => spheres[index].offset[i] + sign * spheres[index].radius);
    const offset = [0, 1, 2].map(i => (least(reach(i, -1)) + most(reach(i, 1))) / 2);
    const radius = most(members.map(index => Vec3.distance(offset, spheres[index].offset) + spheres[index].radius));
    return { offset, radius: radius * (1 + 1e-9), members };
  });
  return { loose, groups };
}

// The field's room geometry at the placement's scale and rotation.
function fieldGeometry({ placement, bounds, center, radius, cameraScale, renderFromRoom, exact = false, projectionCache, fixedViews }) {
  const { rotation, roomFromRender, spheres, loose, groups } = fieldParts({ placement, bounds, cameraScale, renderFromRoom });
  const local = bounds.center.map((v, i) => v - center[i]);
  const offset = Vec3.transformMat4(Vec3(), local, rotation).map(v => v * placement.scale);
  // One part per sphere or plate: a plate's four quad corners, each widened
  // to a box by its `sweep` along a moving path; a sphere's eight box
  // corners, or, measured where it stands (`exact`), the sphere itself, seen
  // by its exact silhouette.
  const isBall = sphere => !sphere.quad && (exact || sphere.kind === 'drawn');
  // Only the position and eye-facing push vary during one synchronous fit.
  // Retain each corner's terms separately to preserve the original addition
  // order, including the widened quad's sweep. Never retain this plan across
  // requests: new bounds and current placement get a new field geometry.
  const cornerPlans = new Map();
  const cornerPlan = (sphere, meter, retain = true) => {
    let plan = cornerPlans.get(sphere);
    if (!plan) {
      if (meter) meter.cornerPlans = (meter.cornerPlans ?? 0) + 1;
      plan = sphere.quad
        ? [-1, 1].flatMap(x => [-1, 1].flatMap(y => (sphere.sweep > 0 ? boxCorners(sphere.sweep) : [[0, 0, 0]]).map(widen =>
          [sphere.quad[0].map(v => x * v), sphere.quad[1].map(v => y * v), widen])))
        : boxCorners(sphere.radius);
      if (retain) cornerPlans.set(sphere, plan);
    }
    return plan;
  };
  const cornersAt = (sphere, point, meter, retain = true) => cornerPlan(sphere, meter, retain).map(corner =>
    applyMatrix4(point.map((v, i) => sphere.quad
      ? v + sphere.offset[i] + corner[0][i] + corner[1][i] + corner[2][i]
      : v + sphere.offset[i] + corner[i]), renderFromRoom));
  const finiteMatrix = matrix => {
    if (!matrix || matrix.length !== 16) return false;
    for (let i = 0; i < 16; i++) if (!Number.isFinite(matrix[i])) return false;
    return true;
  };
  const directRoom = finiteMatrix(renderFromRoom);
  // Project each prepared corner directly into its rectangle. Keep the two
  // transforms separate, with the same arithmetic and homogeneous divisions
  // as applyMatrix4; combining matrices changes rounding and eye-plane tests.
  // Malformed or overflowing inputs retain the generic path's validation.
  const genericCornerRect = (sphere, point, view, meter) => rect(cornersAt(sphere, point, meter), view);
  const cornerRectAt = (sphere, point, view, context, meter) => {
    const m = renderFromRoom, e = view.transform.inverse.matrix, p = view.projectionMatrix;
    context.directEye ??= finiteMatrix(e);
    if (!directRoom || !context.directEye || !Array.isArray(point) || point.length !== 3) return genericCornerRect(sphere, point, view, meter);
    let left = Infinity, right = -Infinity, bottom = Infinity, top = -Infinity;
    for (const corner of cornerPlan(sphere, meter)) {
      let x = point[0] + sphere.offset[0], y = point[1] + sphere.offset[1], z = point[2] + sphere.offset[2];
      if (sphere.quad) {
        x = x + corner[0][0] + corner[1][0] + corner[2][0];
        y = y + corner[0][1] + corner[1][1] + corner[2][1];
        z = z + corner[0][2] + corner[1][2] + corner[2][2];
      } else { x += corner[0]; y += corner[1]; z += corner[2]; }
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return genericCornerRect(sphere, point, view, meter);
      let w = m[3] * x + m[7] * y + m[11] * z + m[15];
      let divisor = Number.isFinite(w) && Math.abs(w) > ROOM_LOCK_EPSILON ? w : 1;
      const rx = (m[0] * x + m[4] * y + m[8] * z + m[12]) / divisor;
      const ry = (m[1] * x + m[5] * y + m[9] * z + m[13]) / divisor;
      const rz = (m[2] * x + m[6] * y + m[10] * z + m[14]) / divisor;
      if (!Number.isFinite(rx) || !Number.isFinite(ry) || !Number.isFinite(rz)) return genericCornerRect(sphere, point, view, meter);
      w = e[3] * rx + e[7] * ry + e[11] * rz + e[15];
      divisor = Number.isFinite(w) && Math.abs(w) > ROOM_LOCK_EPSILON ? w : 1;
      x = (e[0] * rx + e[4] * ry + e[8] * rz + e[12]) / divisor;
      y = (e[1] * rx + e[5] * ry + e[9] * rz + e[13]) / divisor;
      z = (e[2] * rx + e[6] * ry + e[10] * rz + e[14]) / divisor;
      const sx = z < -1e-5 ? (p[0] * x + p[8] * z + p[12]) / -z : Infinity;
      const sy = z < -1e-5 ? (p[5] * y + p[9] * z + p[13]) / -z : Infinity;
      left = Math.min(left, sx); right = Math.max(right, sx);
      bottom = Math.min(bottom, sy); top = Math.max(top, sy);
    }
    return { left, right, bottom, top };
  };
  // The nearest-move envelope visits every atom once. Do not retain thousands
  // of one-use box plans; only scan's revisited parts need preparation.
  const subjectAt = point => spheres.flatMap(sphere => cornersAt(sphere, point, undefined, false));
  // fitChapterField is synchronous and owns these current eye inputs for its
  // entire search. Other callers (including a scorer with mutable XR views)
  // keep resolving each scan's view; no eye state is cached across a draw.
  const fitEyes = fixedViews && new Map(fixedViews.map(view => [view, {}]));
  // Each part of the field at `point` in one eye, with its screen rectangle
  // (`rect`) and, for a ball, its centre in that eye (`eye`). A group of
  // drawn balls is first seen as its one enclosing ball; where `prune`
  // passes that ball, its members are not visited. `visit` returning false
  // ends the scan, which then returns false. `meter.tests` counts each
  // rectangle measured.
  const scan = (point, view, { prune, visit, meter }) => {
    const context = fitEyes?.get(view) ?? {};
    if (!context.toEye) {
      context.toEye = Mat4.mul(Mat4(), view.transform.inverse.matrix, renderFromRoom);
      if (meter) meter.eyeTransforms = (meter.eyeTransforms ?? 0) + 1;
    }
    const toEye = context.toEye, p = view.projectionMatrix;
    // A scorer owns one fixed field for one synchronous menu solve. Many
    // candidate seats see it through the same eyes; only their glass changes.
    // Check values as well as identity because XR adapters can reuse matrices.
    const key = projectionCache && JSON.stringify([point, Array.from(toEye), Array.from(p)]);
    let projected = projectionCache?.get(view);
    if (projectionCache && projected?.key !== key) {
      projected = { key, parts: new Map(), groups: new Map() };
      projectionCache.set(view, projected);
    }
    const eyeAt = sphereOffset => {
      const x = point[0] + sphereOffset[0], y = point[1] + sphereOffset[1], z = point[2] + sphereOffset[2];
      return [toEye[0] * x + toEye[4] * y + toEye[8] * z + toEye[12], toEye[1] * x + toEye[5] * y + toEye[9] * z + toEye[13],
        toEye[2] * x + toEye[6] * y + toEye[10] * z + toEye[14]];
    };
    const ballPart = sphere => { const eye = eyeAt(sphere.offset); return { eye, radius: sphere.radius, rect: eyeBallRect(eye, sphere.radius, p) }; };
    // Mol* pushes a plate toward each eye's own camera. The push measured
    // with the field follows the field: from where the plate stands now,
    // toward this eye.
    const pushed = sphere => {
      if (!sphere.push) return point;
      if (!context.eyeRoom) {
        context.eyeRoom = applyMatrix4(invertMatrix4(view.transform.inverse.matrix).slice(12, 15), roomFromRender);
        if (meter) meter.eyeInverses = (meter.eyeInverses ?? 0) + 1;
      }
      // `offset` already contains the previously measured push. Recover
      // the anchor before taking this eye's ray, or a second room solve
      // subtly changes the quad and moves a chapter that already cleared.
      const at = point.map((v, i) => v + sphere.offset[i] - sphere.push * sphere.toward[i]);
      const to = context.eyeRoom.map((v, i) => v - at[i]), length = Math.hypot(...to);
      return length > 0 ? point.map((v, i) => v + sphere.push * (to[i] / length - sphere.toward[i])) : point;
    };
    const part = sphere => isBall(sphere) ? ballPart(sphere) : { rect: cornerRectAt(sphere, pushed(sphere), view, context, meter) };
    const measured = (cache, index, sphere, ball = false) => {
      if (cache?.has(index)) return cache.get(index);
      if (meter) meter.projections = (meter.projections ?? 0) + 1;
      const entry = ball ? ballPart(sphere) : part(sphere);
      cache?.set(index, entry);
      return entry;
    };
    let tests = 0;
    try {
      for (const index of loose) { tests++; if (visit(index, measured(projected?.parts, index, spheres[index])) === false) return false; }
      for (const group of groups) {
        tests++;
        if (prune(measured(projected?.groups, group, group, true))) continue;
        for (const index of group.members) { tests++; if (visit(index, measured(projected?.parts, index, spheres[index], true)) === false) return false; }
      }
      return true;
    } finally { if (meter) meter.tests = (meter.tests ?? 0) + tests; }
  };
  const initial = applyMatrix4(center.map((v, i) =>
    (v + placement.translation[i] * radius + offset[i]) * cameraScale), roomFromRender);
  return { offset, spheres, subjectAt, scan, initial, bodyRadius: most(spheres.map(s => s.radius)) };
}

// A part seen in one eye clears a glass plate with the gap: by its
// silhouette when it is a ball (`eye`), by its rectangle otherwise.
const eyePartClears = (part, menu, p, gap) => separated(part.rect, menu, gap)
  || (part.eye !== undefined && !eyeBallMeetsGlass(part.eye, part.radius, menu, p, gap));
const finiteRect = box => Number.isFinite(box.left) && Number.isFinite(box.right) && Number.isFinite(box.bottom) && Number.isFinite(box.top);

// The glass as drawn: one point set per plate (`menuGlass`), each with its own
// screen rectangle, so the empty corner between the caption card and the menu
// column covers nothing. Without plates the menu points are one plate.
const glassPlates = (menuPoints, menuGlass) => (menuGlass?.length ? menuGlass : menuPoints.plates ?? [menuPoints])
  .filter(points => points?.length);

// The largest screen area one part of the field shares with one glass plate
// in any eye, with the clearance gap, and which pair that is. A part reaching
// behind the eye covers the whole view; a plate no eye can measure is
// Infinity.
function cover(geometry, point, plates, views, meter) {
  let worst = { area: 0 };
  for (const [index, view] of views.entries()) {
    const glass = plates.map(points => rect(points, view)), p = view.projectionMatrix;
    if (glass.some(menu => !Object.values(menu).every(Number.isFinite))) return { area: Infinity };
    geometry.scan(point, view, { meter,
      // A group whose ball clears every plate covers nothing.
      prune: whole => finiteRect(whole.rect) && glass.every(menu => eyePartClears(whole, menu, p, .04)),
      visit: (part, entry) => {
        const box = finiteRect(entry.rect) ? entry.rect : { left: -1e3, right: 1e3, bottom: -1e3, top: 1e3 };
        glass.forEach((menu, plate) => {
          const wide = Math.min(box.right, menu.right + .04) - Math.max(box.left, menu.left - .04);
          const tall = Math.min(box.top, menu.top + .04) - Math.max(box.bottom, menu.bottom - .04);
          const area = wide > 0 && tall > 0 && !eyePartClears({ ...entry, rect: box }, menu, p, .04) ? wide * tall : 0;
          // Ties go to the first eye, then the first part and plate.
          if (area > worst.area || (area > 0 && area === worst.area && index === worst.view
            && (part < worst.part || (part === worst.part && plate < worst.plate))))
            worst = { area, part, plate, view: index, eye: view.eye ?? null,
              box: [box.left, box.right, box.bottom, box.top], menu: [menu.left, menu.right, menu.bottom, menu.top] };
        });
      } });
  }
  const { view, ...found } = worst;
  return found;
}

/**
 * Where menu glass covers the chapter as it stands now: the largest screen
 * area one part of the field (a sphere's box, a still plate's quad) shares
 * with one glass plate in any eye, with the clearance gap, and that pair
 * (`part` indexes `bounds.spheres`). A part that reaches behind the eye covers
 * the whole view. An area of Infinity means the glass itself cannot be
 * measured in some eye; zero means it clears.
 */
export function menuObstruction({ bounds, views, menuPoints = [], menuGlass, renderFromRoom, exact = bounds?.still === true, meter, ...options }) {
  const plates = glassPlates(menuPoints, menuGlass);
  if (!bounds || !views?.length || !plates.length) return { area: 0 };
  const geometry = fieldGeometry({ ...options, bounds, renderFromRoom, exact });
  return cover(geometry, geometry.initial, plates.map(points => points.map(p => applyMatrix4(p, renderFromRoom))), views, meter);
}

/**
 * Score many glass seats against one fixed field within a synchronous solve.
 * Make a new scorer when bounds, placement or room mapping changes; never
 * retain it across a draw or await. Eye projections are lazy and reused only
 * while their matrices match. The ordinary obstruction/tie-breaking rule is
 * unchanged, including grouping and exact sphere silhouettes.
 */
export function createMenuObstructionScorer({ bounds, views: defaultViews, renderFromRoom,
  exact = bounds?.still === true, ...options }) {
  const geometry = bounds && fieldGeometry({ ...options, bounds, renderFromRoom, exact, projectionCache: new WeakMap() });
  return ({ views = defaultViews, menuPoints = [], menuGlass, meter } = {}) => {
    const plates = glassPlates(menuPoints, menuGlass);
    if (!geometry || !views?.length || !plates.length) return { area: 0 };
    return cover(geometry, geometry.initial, plates.map(points => points.map(p => applyMatrix4(p, renderFromRoom))), views, meter);
  };
}

/**
 * Whether the wearer sees any of this glass now: some plate lies in front of
 * an eye and reaches into its frame. Glass parked off to the side, or behind
 * the wearer, is not in view.
 */
export function menuGlassInView({ views, menuPoints = [], menuGlass, renderFromRoom, fully = false }) {
  const plates = glassPlates(menuPoints, menuGlass).map(points => points.map(p => applyMatrix4(p, renderFromRoom)));
  if (fully) return !!views?.length && plates.length > 0 && plates.every(points => views.every(view => {
    const { left, right, bottom, top } = rect(points, view);
    return [left, right, bottom, top].every(Number.isFinite) && left >= -1 && right <= 1 && bottom >= -1 && top <= 1;
  }));
  return !!views?.length && plates.some(points => views.some(view => {
    const { left, right, bottom, top } = rect(points, view);
    return [left, right, bottom, top].every(Number.isFinite) && right > -1 && left < 1 && top > -1 && bottom < 1;
  }));
}

/** The field centre's distance from the eye in room metres, as `fitChapterField` measures a move. */
export function chapterFieldDistance({ headInRoom, ...options }) {
  return Vec3.distance(fieldGeometry(options).initial, headInRoom.slice(12, 15));
}

/** How much menu glass covers the chapter: the area of `menuObstruction`. */
export const menuOverlap = options => menuObstruction(options).area;

// A lesson's one clearance move keeps the chapter level in the view band. It
// slides the field sideways along the levelled head, away from the glass, or
// sets it back along its own sight line, or both: never up or down, never
// toward the glass, never nearer. A metre sideways costs `LEVEL_SIDEWAYS_COST`
// metres back, because a chapter pushed aside reads as shoved while one set
// back stays centred where it was framed. The cheapest such move that clears,
// within the reach (`within`) and cheaper than `limit`, as `{ point, cost }`.
export const LEVEL_SIDEWAYS_COST = 3;
export const LEVEL_MAX_TURN_DEGREES = 10;
function levelMenuPoint({ initial, eye, headInRoom, menuPoints, accepts, within, limit = Infinity }) {
  const unit = v => { const length = Math.hypot(...v); return length > 1e-9 ? v.map(x => x / length) : undefined; };
  const ray = unit(initial.map((v, i) => v - eye[i])), right = unit([headInRoom[0], 0, headInRoom[2]]);
  if (!ray || !right) return undefined;
  const glassCentre = [0, 1, 2].map(i => menuPoints.reduce((sum, p) => sum + p[i], 0) / Math.max(1, menuPoints.length));
  const side = menuPoints.length ? Math.sign(glassCentre.reduce((sum, v, i) => sum + (v - initial[i]) * right[i], 0)) : 0;
  // Each direction is walked in fortieths of the distance, and the first
  // clear step is halved eight times: to a quarter millimetre at 2.5 m.
  const step = Math.max(.01, Vec3.distance(initial, eye) / 40);
  let best;
  // From straight back (90°) to straight sideways (0°), in 5° steps.
  for (let k = 18; k >= (side ? 0 : 18); k--) {
    const angle = k * Math.PI / 36, back = Math.sin(angle), sideways = Math.cos(angle);
    const direction = ray.map((v, i) => back * v - side * sideways * right[i]);
    const at = t => initial.map((v, i) => v + direction[i] * t);
    // `t` is metres back plus metres sideways, so its cost per unit is:
    const rate = back + LEVEL_SIDEWAYS_COST * sideways;
    const cap = Math.min(limit, best?.cost ?? Infinity) / rate;
    for (let t = step; t < cap + step; t += step) {
      if (!within(at(t))) break;
      if (!accepts(at(t))) continue;
      let low = t - step, high = t;
      for (let i = 0; i < 8; i++) { const mid = (low + high) / 2; if (accepts(at(mid))) high = mid; else low = mid; }
      if (high * rate < Math.min(limit, best?.cost ?? Infinity)) best = { cost: high * rate, point: at(high) };
      break;
    }
  }
  return best;
}

/** Keep the requested scale; spend distance and lateral space, never the top rim.
 * The bound includes the complete motion and plates. Eight box corners enclose
 * it in each actual eye, including asymmetric projections and head rotation.
 * Called at menu/chapter/placement edges, never on the animation frame clock.
 * Every move, the walk-out and a clearance move alike, stays within
 * `CLEARANCE_STANDOFF_FACTOR` entry stand-offs (`standoff`), or the field's
 * present distance when that is farther, and never beyond
 * `XR_ROOM_MAX_METRES`. Past that it refuses with `FIELD_OUT_OF_REACH`, and
 * the caller keeps the seat and moves, folds or hides the glass instead.
 * A `level` clearance move (a lesson's) only slides the field sideways away
 * from the glass or sets it back, and refuses past the reach or past a
 * `maxMove` cost (`field.moveCost`, see `LEVEL_SIDEWAYS_COST`), or farther
 * from the eye than `maxDistance`, the bound that keeps the chapter's size.
 */
export function fitChapterField({ placement, bounds, center, radius, cameraScale, headInRoom,
  renderFromRoom, views, menuPoints = [], menuGlass, force = false, keepPlacement = false, allowOffscreen = false, clearanceOnly = false, standoff,
  exact = bounds?.still === true, level = false, maxMove = Infinity, maxDistance = Infinity, meter }) {
  if (!bounds || !views?.length) return placement;
  // `exact` measures each sphere by its silhouette, for a field that may not
  // move: a still chapter, or one the wearer holds. A field that may walk
  // keeps the circumscribed boxes its nearest-move solve is exact for.
  const { offset, scan, subjectAt, initial, bodyRadius } = fieldGeometry({ placement, bounds, center, radius, cameraScale, renderFromRoom, exact,
    fixedViews: views });
  const eye = headInRoom.slice(12, 15);
  const plates = glassPlates(menuPoints, menuGlass).map(points => points.map(p => applyMatrix4(p, renderFromRoom)));
  const glass = views.map(view => plates.map(points => rect(points, view)));
  // Every part of the field clears every glass plate in each eye, and lies
  // in front of it; and, unless it may leave the frame, inside the frame.
  // `meter.positions` counts the seats tested.
  const accepts = point => {
    if (meter) meter.positions = (meter.positions ?? 0) + 1;
    return views.every((view, i) => {
      const p = view.projectionMatrix;
      const clears = part => finiteRect(part.rect)
        && (allowOffscreen || (part.rect.left > -.88 && part.rect.right < .88 && part.rect.bottom > -.80 && part.rect.top < .80))
        && glass[i].every(menu => eyePartClears(part, menu, p, .04));
      return glass[i].every(menu => Object.values(menu).every(Number.isFinite))
        && scan(point, view, { prune: clears, visit: (_, part) => clears(part), meter });
    });
  };
  if (!force && accepts(initial)) return placement;
  if (keepPlacement) return undefined;
  const present = Vec3.distance(initial, eye);
  const reach = Math.min(XR_ROOM_MAX_METRES,
    Math.max(CLEARANCE_STANDOFF_FACTOR * (standoff > 0 ? standoff : present), present));
  // `maxDistance` keeps the chapter's size: a move that makes room for glass
  // never sets the field back past it (unless it already stands farther).
  // A level move also keeps the chapter in front of the wearer: it never
  // turns its centre more than `LEVEL_MAX_TURN_DEGREES` off where it stood.
  const ray = initial.map((v, i) => v - eye[i]);
  const turned = point => { const to = point.map((v, i) => v - eye[i]);
    return Math.acos(Math.min(1, to.reduce((sum, v, i) => sum + v * ray[i], 0) / (Math.hypot(...to) * Math.hypot(...ray) || 1))) * 180 / Math.PI; };
  const within = point => Vec3.distance(point, eye) <= Math.min(reach, Math.max(maxDistance, present)) + 1e-6
    && (!level || turned(point) <= LEVEL_MAX_TURN_DEGREES + 1e-6);
  const outOfReach = () => Object.assign(Error('No nearby seat clears this menu. Move the menu and try again.'),
    { code: 'FIELD_OUT_OF_REACH' });
  if (clearanceOnly) {
    const levelled = level ? levelMenuPoint({ initial, eye, headInRoom, menuPoints: glassPlates(menuPoints, menuGlass).flat(),
      accepts, within, limit: maxMove }) : undefined;
    const point = level ? levelled?.point : nearestMenuPoint(initial, subjectAt(initial), views, glass, renderFromRoom);
    if (!point && level) throw outOfReach();
    if (!point || !accepts(point)) throw Error('The chapter cannot clear this menu. Move the menu and try again.');
    if (!within(point)) throw outOfReach();
    const render = applyMatrix4(point, renderFromRoom).map(v => v / cameraScale);
    const translation = center.map((v, i) => (render[i] - v - offset[i]) / radius);
    if (translation.some(v => !Number.isFinite(v) || Math.abs(v) > PLACEMENT_MAX_TRANSLATION))
      throw Error('The menu clearance is outside the placement range. Move the menu and try again.');
    return { ...placement, translation, field: { distance: Vec3.distance(point, eye), center: point,
      radius: bodyRadius, eye, moveMetres: Vec3.distance(initial, point), ...(levelled ? { moveCost: levelled.cost } : {}) } };
  }
  // Explore the middle field at increasing distance, up to the reach. A large
  // wearer scale therefore remains large in world units while its entire
  // motion stays seen, or the glass yields.
  for (let distance = Math.max(1.2, bodyRadius * 2.2); distance <= reach + 1e-6; distance *= 1.16) {
    for (const x of [0, .15, -.15, .3, -.3, .45, -.45, .6, -.6]) {
      const point = applyMatrix4([x * distance, 0, -distance], headInRoom);
      if (!within(point) || !accepts(point)) continue;
      const render = applyMatrix4(point, renderFromRoom).map(v => v / cameraScale);
      const translation = center.map((v, i) => (render[i] - v - offset[i]) / radius);
      if (translation.some(v => !Number.isFinite(v) || Math.abs(v) > PLACEMENT_MAX_TRANSLATION)) continue;
      return { ...placement, translation, field: { distance, center: point, radius: bodyRadius, eye } };
    }
  }
  throw outOfReach();
}
