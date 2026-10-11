import { SUBJECT_CENTRE_TANGENT } from './placement-fit-envelope.mjs';
import { applyMatrix4, invertMatrix4 } from './room-lock.mjs';
import { SUBJECT_SHIFT_LIMIT, lensTangent } from './plate-standoff.mjs';
import { labelObjectVisible, renderedSubjectPoints, renderedSubjectSpheres, renderedMeshVertexCount } from './component-label-measurement.mjs';

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vector = (v, m) => [0, 1, 2].map(i => m[i] * v[0] + m[i + 4] * v[1] + m[i + 8] * v[2]);
const scaleOf = m => Math.max(...[0, 4, 8].map(i => Math.hypot(m[i], m[i + 1], m[i + 2])));
const finite3 = p => p?.length === 3 && Array.from(p).every(Number.isFinite);
const clip = (ranges, a, b) => ranges.flatMap(([low, high]) => {
  if (Math.abs(b) < 1e-12) return a >= -1e-10 ? [[low, high]] : [];
  if (b > 0) low = Math.max(low, -a / b); else high = Math.min(high, -a / b);
  return low <= high + 1e-10 ? [[low, Math.max(low, high)]] : [];
});
const merge = ranges => {
  const result = [];
  for (const range of ranges.sort((a, b) => a[0] - b[0])) {
    const last = result.at(-1);
    if (last && range[0] <= last[1] + 1e-10) last[1] = Math.max(last[1], range[1]);
    else result.push([...range]);
  }
  return result;
};

// A freshly extracted subject belongs to one solve. Done and centered Reset
// ask several questions of the same two eyes; carry each vertex into an eye
// once for those questions. Hand-built subjects keep their live-read semantics.
const extractedSubjects = new WeakSet();
const carriedEyes = new WeakMap();
const privateEyeSubjects = new WeakSet();
function eyeSubject(geometry, matrix) {
  const subject = geometry.subject;
  if (!extractedSubjects.has(subject))
    return subject.map(s => ({ center: applyMatrix4(s.center, matrix), radius: s.radius }));
  // The extracted array is returned to callers. Check its complete contents
  // before reusing a carried eye, including edits to a sphere or its centre.
  let cache = carriedEyes.get(subject);
  let current = cache?.values.length === subject.length * 4;
  if (current) for (let i = 0; i < subject.length; i++) {
    const sphere = subject[i], point = sphere.center, at = i * 4;
    if (!Array.isArray(point) || point.length !== 3
      || !Object.is(point[0], cache.values[at]) || !Object.is(point[1], cache.values[at + 1])
      || !Object.is(point[2], cache.values[at + 2]) || !Object.is(sphere.radius, cache.values[at + 3])) {
      current = false; break;
    }
  }
  if (!current) {
    const values = new Float64Array(subject.length * 4);
    for (let i = 0; i < subject.length; i++) {
      const sphere = subject[i], point = sphere.center, at = i * 4;
      values[at] = point?.[0]; values[at + 1] = point?.[1];
      values[at + 2] = point?.[2]; values[at + 3] = sphere.radius;
    }
    cache = { values, eyes: new Map() };
    carriedEyes.set(subject, cache);
  }
  const eyes = cache.eyes;
  const key = matrix.join(',');
  let carried = eyes.get(key);
  if (!carried) {
    const affine = matrix[3] === 0 && matrix[7] === 0 && matrix[11] === 0 && matrix[15] === 1;
    carried = subject.map(s => {
      const p = s.center;
      // applyMatrix4 rejects invalid coordinates before multiplying. An
      // extracted subject can be changed by its caller after extraction.
      return { center: affine && Array.isArray(p) && p.length === 3 && p.every(Number.isFinite) ? [
        matrix[0] * p[0] + matrix[4] * p[1] + matrix[8] * p[2] + matrix[12],
        matrix[1] * p[0] + matrix[5] * p[1] + matrix[9] * p[2] + matrix[13],
        matrix[2] * p[0] + matrix[6] * p[1] + matrix[10] * p[2] + matrix[14],
      ] : applyMatrix4(p, matrix), radius: s.radius };
    });
    eyes.set(key, carried);
    privateEyeSubjects.add(carried);
  }
  return carried;
}

/** Restore the mesh that entry drew, using its instance transforms exactly once.
 * Mesh vertices enclose every triangle; impostors retain their instance spheres.
 * Read all vertices on this explicit action, never a diagnostic sample or a frame.
 * An unreadable object leaves the caller's conservative sphere refusal in force.
 */
export function resetEntryGeometry({ objects = [], fromPlacement, toPlacement, views,
  cameraScale, renderFromRoom }) {
  // WebXR permits one monoscopic primary view (eye: none), including the
  // visionOS simulator. A lone stereo eye is still incomplete evidence.
  if (!(views?.length === 1 && views[0].eye === 'none')
    && (!views?.some(v => v.eye === 'left') || !views.some(v => v.eye === 'right'))) return undefined;
  const inverse = fromPlacement?.length === 16 && invertMatrix4(fromPlacement);
  if (!inverse || toPlacement?.length !== 16 || !(cameraScale > 0)) return undefined;
  const subject = [];
  const ratio = scaleOf(toPlacement) / scaleOf(fromPlacement);
  const affine = [inverse, toPlacement].every(m => m[3] === 0 && m[7] === 0 && m[11] === 0 && m[15] === 1);
  for (const object of objects.filter(labelObjectVisible)) {
    // The common mesh path reads the same aTransform vertices as
    // renderedSubjectPoints, but does not allocate a point array and an
    // intermediate sphere for every vertex. Keep the three matrix operations
    // separate: composing them changes floating-point answers at the edge.
    const positions = object.type === 'mesh' && object.values?.aPosition?.ref?.value;
    const matrices = object.values?.aTransform?.ref?.value;
    const instances = Math.max(1, object.values?.instanceCount?.ref?.value ?? 1);
    if (positions?.length >= 3 && matrices?.length >= instances * 16) {
      const count = renderedMeshVertexCount(object, positions);
      const start = subject.length;
      // instanceMatrices uses Array.from({ length: instances }) after the
      // same buffer-length guard. Array.from truncates fractional lengths.
      for (let instance = 0; instance < Math.floor(instances); instance++) {
        const m = matrices.slice(instance * 16, instance * 16 + 16);
        for (let i = 0; i < count; i++) {
          const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
          if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
          const a = m[0] * x + m[4] * y + m[8] * z + m[12];
          const b = m[1] * x + m[5] * y + m[9] * z + m[13];
          const c = m[2] * x + m[6] * y + m[10] * z + m[14];
          let center;
          if (affine) {
            const u = inverse[0] * a + inverse[4] * b + inverse[8] * c + inverse[12];
            const v = inverse[1] * a + inverse[5] * b + inverse[9] * c + inverse[13];
            const w = inverse[2] * a + inverse[6] * b + inverse[10] * c + inverse[14];
            center = [
              (toPlacement[0] * u + toPlacement[4] * v + toPlacement[8] * w + toPlacement[12]) * cameraScale,
              (toPlacement[1] * u + toPlacement[5] * v + toPlacement[9] * w + toPlacement[13]) * cameraScale,
              (toPlacement[2] * u + toPlacement[6] * v + toPlacement[10] * w + toPlacement[14]) * cameraScale,
            ];
          } else {
            center = applyMatrix4(applyMatrix4([a, b, c], inverse), toPlacement).map(v => v * cameraScale);
          }
          if (!finite3(center)) return undefined;
          subject.push({ center, radius: 0 });
        }
      }
      if (subject.length > start) continue;
    }
    const vertices = object.type === 'mesh' ? renderedSubjectPoints(object, 1, Infinity) : [];
    const elements = vertices.length ? vertices.map(center => ({ center, radius: 0 })) : renderedSubjectSpheres(object, 1);
    if (!elements.length) return undefined;
    for (const element of elements) {
      const center = applyMatrix4(applyMatrix4(element.center, inverse), toPlacement).map(v => v * cameraScale);
      const radius = element.radius * ratio * cameraScale;
      if (!finite3(center) || !Number.isFinite(radius)) return undefined;
      subject.push({ center, radius });
    }
  }
  if (!subject.length) return undefined;
  extractedSubjects.add(subject);
  return { subject, views, renderFromRoom };
}

/** Reuse the extracted vertices during a fit; change placement about its
 * molecular anchor, not about the origin of the rendered coordinate system.
 *
 * A fit asks about twenty candidates inside one XR frame, and a Quest 2
 * cartoon has hundreds of thousands of vertices. So the candidate's subject is
 * built only when something reads it, and the candidate also carries its base
 * and its scale-and-move (`fit`, not enumerable, so a copy with another
 * subject cannot inherit it). `resetEntryLateralTravel` answers a candidate
 * from the base's extremes without reading a vertex. */
export function fitEntryGeometry(geometry, { anchor, moved, ratio }) {
  let subject;
  const fitted = { ...geometry };
  Object.defineProperty(fitted, 'subject', { enumerable: true, configurable: true,
    get: () => subject ??= geometry.subject.map(s => ({
      center: s.center.map((v, i) => moved[i] + ratio * (v - anchor[i])),
      radius: s.radius * ratio,
    })) });
  Object.defineProperty(fitted, 'fit', { value: { base: geometry, anchor, moved, ratio } });
  return fitted;
}

/**
 * A fitted candidate read in one view, without its vertices.
 *
 * In view space a candidate's vertex is `origin + ratio * w`, where `w` is the
 * base vertex through the view's linear part. The smallest reading of
 * `dot(vertex, n) - radius * |n|` is then `dot(origin, n) + ratio * m(n)`, with
 * `m(n)` the base's own smallest reading, which is cached per base, view and
 * direction. Every direction the lateral solver asks about is fixed by the
 * view and the glass, so after the first candidate each answer is arithmetic.
 * Undefined unless the view is affine and the fit is a real enlargement.
 * The cache is keyed by the base's subject array, so that array must not change
 * once extracted; `resetEntryGeometry` builds a new one for every solve.
 */
const fittedBases = new WeakMap();
function fittedView(geometry, matrix) {
  const fit = geometry.fit;
  if (!fit || !(fit.ratio > 0) || !Number.isFinite(fit.ratio) || !finite3(fit.anchor) || !finite3(fit.moved)) return undefined;
  if (matrix[3] !== 0 || matrix[7] !== 0 || matrix[11] !== 0 || matrix[15] !== 1) return undefined;
  const subject = fit.base.subject;
  if (!Array.isArray(subject) || !subject.length) return undefined;
  let views = fittedBases.get(subject);
  if (!views) fittedBases.set(subject, views = new Map());
  const key = matrix.join(',');
  let base = views.get(key);
  if (!base) {
    const count = subject.length;
    base = { x: new Float64Array(count), y: new Float64Array(count), z: new Float64Array(count),
      radius: new Float64Array(count), minima: new Map() };
    subject.forEach(({ center: [a, b, c], radius }, i) => {
      base.x[i] = matrix[0] * a + matrix[4] * b + matrix[8] * c;
      base.y[i] = matrix[1] * a + matrix[5] * b + matrix[9] * c;
      base.z[i] = matrix[2] * a + matrix[6] * b + matrix[10] * c;
      base.radius[i] = radius;
    });
    base.centerBoxes = () => {
      const extrema = [Infinity, -Infinity, Infinity, -Infinity];
      for (let i = 0; i < count; i++) {
        extrema[0] = Math.min(extrema[0], base.x[i]); extrema[1] = Math.max(extrema[1], base.x[i]);
        extrema[2] = Math.min(extrema[2], base.z[i]); extrema[3] = Math.max(extrema[3], base.z[i]);
      }
      const cells = new Map();
      for (let i = 0; i < count; i++) {
        const xb = extrema[1] > extrema[0] ? Math.min(15, Math.floor(16 * (base.x[i] - extrema[0]) / (extrema[1] - extrema[0]))) : 0;
        const zb = extrema[3] > extrema[2] ? Math.min(15, Math.floor(16 * (base.z[i] - extrema[2]) / (extrema[3] - extrema[2]))) : 0;
        const key = xb * 16 + zb;
        let box = cells.get(key);
        if (!box) cells.set(key, box = { xLow: Infinity, xHigh: -Infinity, zLow: Infinity, zHigh: -Infinity, radius: 0, members: [] });
        box.xLow = Math.min(box.xLow, base.x[i]); box.xHigh = Math.max(box.xHigh, base.x[i]);
        box.zLow = Math.min(box.zLow, base.z[i]); box.zHigh = Math.max(box.zHigh, base.z[i]);
        box.radius = Math.max(box.radius, base.radius[i]); box.members.push(i);
      }
      return base.centerBoxes = [...cells.values()];
    };
    views.set(key, base);
  }
  const ratio = fit.ratio;
  const origin = applyMatrix4(fit.moved.map((v, i) => v - ratio * fit.anchor[i]), matrix);
  const smallest = normal => {
    const key = `${normal[0]},${normal[1]},${normal[2]}`;
    let value = base.minima.get(key);
    if (value === undefined) {
      const norm = Math.hypot(normal[0], normal[1], normal[2]);
      value = Infinity;
      for (let i = 0; i < base.x.length; i++) value = Math.min(value,
        normal[0] * base.x[i] + normal[1] * base.y[i] + normal[2] * base.z[i] - base.radius[i] * norm);
      base.minima.set(key, value);
    }
    return value;
  };
  return {
    /** `subjectMargin` of the candidate in this view. */
    margin: normal => dot(origin, normal) + ratio * smallest(normal),
    low: axis => origin[axis] + ratio * smallest([0, 1, 2].map(a => a === axis ? 1 : 0)),
    high: axis => origin[axis] - ratio * smallest([0, 1, 2].map(a => a === axis ? -1 : 0)),
    /** Each vertex moved by `distance * delta`, as x, depth and radius. */
    each(distance, delta, visit) {
      const x0 = origin[0] + distance * delta[0], z0 = origin[2] + distance * delta[2];
      for (let i = 0; i < base.x.length; i++)
        if (visit(x0 + ratio * base.x[i], -(z0 + ratio * base.z[i]), ratio * base.radius[i]) === false) return false;
      return true;
    },
    centred(distance, delta, limit) {
      const x0 = origin[0] + distance * delta[0], z0 = origin[2] + distance * delta[2];
      let low = Infinity, high = -Infinity;
      const boxes = typeof base.centerBoxes === 'function' ? base.centerBoxes() : base.centerBoxes;
      for (const box of boxes) {
        const xLow = x0 + ratio * box.xLow, xHigh = x0 + ratio * box.xHigh;
        const zLow = -(z0 + ratio * box.zHigh), zHigh = -(z0 + ratio * box.zLow);
        const radius = ratio * box.radius;
        let read = !(zLow > radius);
        if (!read) {
          const a = xLow - radius, b = xHigh + radius;
          const lower = (a < 0 ? a / (zLow - radius) : a / (zHigh + radius));
          const upper = (b > 0 ? b / (zLow - radius) : b / (zHigh + radius));
          const slack = 64 * Number.EPSILON * (1 + Math.abs(lower) + Math.abs(upper));
          read = lower - slack < low || upper + slack > high;
        }
        if (!read) continue;
        for (const i of box.members) {
          const x = x0 + ratio * base.x[i], z = -(z0 + ratio * base.z[i]), r = ratio * base.radius[i];
          if (!(z > r)) return false;
          const spread = r * Math.sqrt(x * x + z * z - r * r), denominator = z * z - r * r;
          low = Math.min(low, (x * z - spread) / denominator);
          high = Math.max(high, (x * z + spread) / denominator);
        }
      }
      return Math.abs((low + high) / 2) <= limit + 1e-9;
    },
  };
}

export function projectedHull(points, spheres = false) {
  // Project into numeric storage first. Dense meshes retain only their exact
  // hull candidates as pair objects; the interior needs no JS point objects.
  const px = new Float64Array(points.length), py = new Float64Array(points.length);
  let count = 0;
  for (const entry of points) {
    const p = spheres ? entry.center : entry;
    if (p?.length !== 3 || !Number.isFinite(p[0]) || !Number.isFinite(p[1])
      || !Number.isFinite(p[2]) || !(p[2] < -1e-9)) continue;
    px[count] = p[0] / -p[2]; py[count] = p[1] / -p[2]; count++;
  }
  let projected;
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const half = values => {
    const result = [];
    for (const p of values) {
      while (result.length >= 2 && cross(result.at(-2), result.at(-1), p) <= 0) result.pop();
      result.push(p);
    }
    return result.slice(0, -1);
  };
  const hullOf = values => {
    const sorted = values.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    return [...half(sorted), ...half([...sorted].reverse())];
  };
  if (count >= 4096) {
    // Extremal input points form an inscribed hull. A point strictly inside it
    // cannot be on the final hull; retaining its boundary and every exterior
    // point makes this a sort reduction, never a geometric approximation.
    const directions = Array.from({ length: 8 }, (_, i) =>
      [Math.cos(i * Math.PI / 4), Math.sin(i * Math.PI / 4)]);
    const scores = new Float64Array(directions.length).fill(-Infinity);
    const extreme = new Array(directions.length);
    let finite = true;
    for (let j = 0; j < count; j++) {
      const x = px[j], y = py[j];
      if (!Number.isFinite(x) || !Number.isFinite(y)
        || Math.abs(x) > 1e100 || Math.abs(y) > 1e100) { finite = false; break; }
      for (let i = 0; i < directions.length; i++) {
        const score = x * directions[i][0] + y * directions[i][1];
        if (!Number.isFinite(score)) { finite = false; break; }
        if (score > scores[i]) { scores[i] = score; extreme[i] = j; }
      }
      if (!finite) break;
    }
    const inner = finite ? hullOf([...new Set(extreme)].map(i => [px[i], py[i]])) : [];
    if (inner.length >= 3) {
      const edges = inner.map((a, i) => {
        const b = inner[(i + 1) % inner.length];
        return [a[0], a[1], b[0] - a[0], b[1] - a[1]];
      });
      const boundary = [];
      for (let j = 0; j < count; j++) {
        let retain = false;
        for (const [ax, ay, dx, dy] of edges) {
          const u = dx * (py[j] - ay), v = dy * (px[j] - ax);
          if (u - v <= 32 * Number.EPSILON * (Math.abs(u) + Math.abs(v))) {
            retain = true; break;
          }
        }
        if (retain) boundary.push([px[j], py[j]]);
      }
      projected = boundary;
    }
  }
  if (!projected) {
    projected = new Array(count);
    for (let i = 0; i < count; i++) projected[i] = [px[i], py[i]];
  }
  return hullOf(projected);
}

export function hullNormals(points, spheres = false) {
  const hull = projectedHull(points, spheres);
  return hull.flatMap((p, i) => {
    const q = hull[(i + 1) % hull.length], n = [q[1] - p[1], p[0] - q[0]], length = Math.hypot(...n);
    return length > 1e-12 ? [[n[0] / length, n[1] / length]] : [];
  });
}

// A subject centre strictly inside the projected glass proves overlap: that
// centre belongs to the subject silhouette, so no separating plane exists.
// The scan stops at the first witness and never substitutes a sample for the
// complete subject when there is no witness.
function certainOverlap(menu, subject) {
  const hull = projectedHull(menu);
  if (hull.length < 3) return false;
  for (const s of subject) {
    const p = s.center, depth = -p[2];
    if (!(depth > 1e-9)) continue;
    const x = p[0] / depth, y = p[1] / depth;
    if (hull.every((a, i) => {
      const b = hull[(i + 1) % hull.length];
      return (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]) > 1e-12;
    })) return true;
  }
  return false;
}

const projectedEdge = (menu, x, y) => {
  let edge = -Infinity;
  for (const p of menu) edge = Math.max(edge, (x * p[0] + y * p[1]) / -p[2]);
  return edge;
};
// All spheres remain in the solve. A box only skips its members when its
// conservative lower bound cannot beat the smallest reading already found.
// Build once per carried eye subject, never once per separating direction.
const marginBoxes = new WeakMap();
export function subjectMargin(subject, normal) {
  const norm = Math.hypot(...normal);
  const read = s => dot(s.center, normal) - s.radius * norm;
  if (subject.length < 1024 || !privateEyeSubjects.has(subject)) {
    let value = Infinity;
    for (const s of subject) value = Math.min(value, read(s));
    return value;
  }
  let boxes = marginBoxes.get(subject);
  if (!boxes) {
    const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
    for (const s of subject) for (let a = 0; a < 3; a++) {
      low[a] = Math.min(low[a], s.center[a]);
      high[a] = Math.max(high[a], s.center[a]);
    }
    const cells = new Map();
    for (const s of subject) {
      let key = 0;
      for (let a = 0; a < 3; a++) {
        const width = high[a] - low[a];
        const bin = width > 0 ? Math.min(7, Math.floor(8 * (s.center[a] - low[a]) / width)) : 0;
        key = key * 8 + bin;
      }
      let box = cells.get(key);
      if (!box) cells.set(key, box = { low: [...s.center], high: [...s.center], radius: s.radius, members: [] });
      for (let a = 0; a < 3; a++) {
        box.low[a] = Math.min(box.low[a], s.center[a]);
        box.high[a] = Math.max(box.high[a], s.center[a]);
      }
      box.radius = Math.max(box.radius, s.radius);
      box.members.push(s);
    }
    boxes = [...cells.values()];
    marginBoxes.set(subject, boxes);
  }
  const ranked = boxes.map(box => {
    const terms = normal.map((n, a) => n * (n < 0 ? box.high[a] : box.low[a]));
    const radius = box.radius * norm;
    const bound = terms[0] + terms[1] + terms[2] - radius;
    // Round outward; close comparisons still read the actual spheres.
    const error = 16 * Number.EPSILON * (terms.reduce((s, v) => s + Math.abs(v), 0) + Math.abs(radius));
    return { box, bound: bound - error };
  }).sort((a, b) => a.bound - b.bound);
  let value = Infinity;
  for (const { box, bound } of ranked) {
    if (bound > value) continue;
    for (const s of box.members) value = Math.min(value, read(s));
  }
  return value;
}

/** The six half-spaces of one WebXR projection, read in that eye's view space:
 * both sides, above and below, near and far. Both travel solvers below and the
 * visibility predicate read the same planes out of the same matrix, so none of
 * them can drift into its own idea of what the eye can see. */
const frustumPlanes = projection => [0, 1, 2].flatMap(axis => [-1, 1].map(sign =>
  [0, 1, 2, 3].map(i => projection[i * 4 + 3] + sign * projection[i * 4 + axis])));
/** How deep inside one plane the whole subject sits; negative if any of it is
 * outside. */
const insidePlane = (subject, plane) => {
  const norm = Math.hypot(...plane.slice(0, 3));
  let margin = Infinity;
  for (const s of subject) margin = Math.min(margin, dot(s.center, plane) + plane[3] - s.radius * norm);
  return margin;
};
/** How far the subject reaches inside one plane; negative only if ALL of it is
 * outside. */
const reachesPlane = (subject, plane) => {
  const norm = Math.hypot(...plane.slice(0, 3));
  let reach = -Infinity;
  for (const s of subject) reach = Math.max(reach, dot(s.center, plane) + plane[3] + s.radius * norm);
  return reach;
};

/** Candidate separating directions in one eye's projected plane: both
 * silhouette hulls plus a five-degree sweep, so no real separation is missed
 * for want of a normal. */
function separationDirections(menu, subject) {
  // Iteration may stop at a menu edge. Only a caller that needs the subject's
  // directions pays for its hull; repeated iteration reuses that same hull.
  let subjectNormals;
  return { *[Symbol.iterator]() {
    if (!menu.length) return;
    yield* hullNormals(menu);
    yield* (subjectNormals ??= hullNormals(subject, true));
    for (let degrees = 0; degrees < 360; degrees += 5)
      yield [Math.cos(degrees * Math.PI / 180), Math.sin(degrees * Math.PI / 180)];
  } };
}

function subjectBeyond(subject, normal) {
  const norm = Math.hypot(...normal);
  return subject.every(s => dot(s.center, normal) - s.radius * norm > 1e-10);
}

/** Already clear in this eye: the whole subject lies beyond the whole menu
 * along some direction of the projected plane. Above and below separate a
 * view exactly as left and right do. A clear entry needs no extra margin;
 * the one-degree gap is reserved for an actual adjustment. Both the forward
 * travel and the saved-placement test ask this one question here, so neither
 * can drift into a narrower notion of clear.
 */
function eyeAlreadyClear(menu, subject, directions = separationDirections(menu, subject)) {
  if (!menu.length) return true;
  if (certainOverlap(menu, subject)) return false;
  for (const [x, y] of directions)
    if (subjectBeyond(subject, [x, y, projectedEdge(menu, x, y)])) return true;
  return false;
}

/** Return zero for an already clear entry. Entry did not promise that its entire
 * padded bounding sphere fits a second, narrower field after the sideways slide.
 * Only a real menu overlap spends forward travel, bounded by the actual stereo
 * frusta and the existing 4 m ceiling. No point is frustum-culled before testing.
 */
export function resetEntryTravel({ geometry, points, forward, maximum }) {
  const renderedMenu = points.map(p => applyMatrix4(p, geometry.renderFromRoom));
  const travel = vector(forward, geometry.renderFromRoom);
  let clear = [[0, maximum]], visible = [[0, maximum]];
  const eyes = [];
  for (const view of geometry.views) {
    const matrix = view.transform?.inverse?.matrix, projection = view.projectionMatrix;
    if (matrix?.length !== 16 || projection?.length !== 16) return undefined;
    const subject = eyeSubject(geometry, matrix);
    const menu = renderedMenu.map(p => applyMatrix4(p, matrix)).filter(p => p[2] < -1e-9);
    const delta = vector(travel, matrix);
    eyes.push({ subject, menu, delta, projection, normals: separationDirections(menu, subject) });
  }
  // Zero travel deliberately ignores whole-subject frustum containment today.
  // Answer that same question before calculating any adjustment intervals.
  if (eyes.every(({ menu, subject, normals }) => eyeAlreadyClear(menu, subject, normals))) return 0;
  for (const { subject, menu, delta, projection, normals } of eyes) {
    const ranges = [];
    if (!menu.length) ranges.push(...clear);
    else for (const [x, y] of normals) {
      const normal = [x, y, projectedEdge(menu, x, y) + Math.tan(Math.PI / 180)];
      ranges.push(...clip(clear, subjectMargin(subject, normal), dot(delta, normal)));
    }
    clear = merge(ranges);
    // Actual WebXR projection, including eye asymmetry and near/far planes.
    for (const plane of frustumPlanes(projection))
      visible = clip(visible, insidePlane(subject, plane), dot(delta, plane));
  }
  const intersections = clear.flatMap(([low, high]) => visible.map(([a, b]) => [Math.max(low, a), Math.min(high, b)]))
    .filter(([low, high]) => low <= high + 1e-10);
  return intersections.length ? Math.max(0, Math.min(...intersections.map(([low]) => low))) : Infinity;
}

/** Minimum signed lateral travel of the committed geometry, inside both actual
 * eye frusta and the existing standoff centre/edge bands. Infinity asks the
 * caller to use the entry seat. Zero clearance tests whether a saved placement
 * is already wholly separate from the glass in projection, in any direction;
 * adjustments solve sideways with the default one-degree margin.
 * This runs once per Done, with every vertex.
 */
export function resetEntryLateralTravel({ geometry, points, right, clearance = Math.tan(Math.PI / 180),
  centreLimit = SUBJECT_CENTRE_TANGENT }) {
  // Diagnostics round tangents to four decimals. Keep the admitted centre
  // inside the existing band after that rounding too.
  const menu = points.map(p => applyMatrix4(p, geometry.renderFromRoom));
  const travel = vector(right, geometry.renderFromRoom);
  let allowed = [[-Infinity, Infinity]];
  const eyes = [];
  for (const view of geometry.views) {
    const matrix = view.transform?.inverse?.matrix, projection = view.projectionMatrix;
    if (matrix?.length !== 16 || projection?.length !== 16) return undefined;
    // A fit candidate is read from its base's cached extremes (`fittedView`);
    // anything else from its own vertices, carried into this view once.
    const fitted = fittedView(geometry, matrix);
    let carried;
    const subject = () => carried ??= eyeSubject(geometry, matrix);
    const margin = fitted ? fitted.margin : normal => subjectMargin(subject(), normal);
    const inside = fitted ? plane => fitted.margin(plane.slice(0, 3)) + plane[3] : plane => insidePlane(subject(), plane);
    const glass = menu.map(p => applyMatrix4(p, matrix)).filter(p => p[2] < -1e-9);
    const delta = vector(travel, matrix);
    // A centre within the glass proves the zero-clearance answer is Infinity.
    // No later frustum or centre-band clip can turn overlap into separation.
    if (clearance === 0 && glass.length && certainOverlap(glass, subject())) return Infinity;
    eyes.push(fitted ? { fitted, delta } : (distance, visit) => {
      for (const s of subject())
        if (visit(s.center[0] + distance * delta[0], -(s.center[2] + distance * delta[2]), s.radius) === false) return false;
      return true;
    });
    // Every vertex travels by the same `delta`, so all of them share one slope
    // against a plane, and their half-lines intersect in the half-line of the
    // smallest intercept. One clip per plane, never one per vertex: on a
    // Quest 2 the per-vertex form held the first XR frame for 15 s on 4HHB.
    // Actual stereo frusta, including asymmetric horizontal and depth planes.
    for (const plane of frustumPlanes(projection))
      allowed = clip(allowed, inside(plane), dot(delta, plane));
    // Keep the whole silhouette inside the existing sideways edge limit.
    for (const sign of [-1, 1]) {
      const normal = [sign, 0, -lensTangent(SUBJECT_SHIFT_LIMIT)];
      allowed = clip(allowed, margin(normal), dot(delta, normal));
    }
    // Constrain the centre of its 3D bounds; check the projected silhouette
    // centre below too, since perspective can move it away from this anchor.
    let low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
    if (fitted) { low = low.map((_, axis) => fitted.low(axis)); high = high.map((_, axis) => fitted.high(axis)); }
    else for (const s of subject()) for (let axis = 0; axis < 3; axis++) {
      low[axis] = Math.min(low[axis], s.center[axis] - s.radius);
      high[axis] = Math.max(high[axis], s.center[axis] + s.radius);
    }
    const anchor = low.map((v, axis) => (v + high[axis]) / 2);
    for (const sign of [-1, 1]) {
      const normal = [sign, 0, -centreLimit];
      allowed = clip(allowed, dot(anchor, normal), dot(delta, normal));
    }
    if (!glass.length) continue;
    // Zero clearance asks one question only: does the saved placement already
    // clear the drawn glass? That is full separation in this eye's projection,
    // read exactly as the forward check reads it. A molecule wholly above or
    // below the menu is separate, so it spends no sideways travel here.
    if (clearance === 0) {
      if (!eyeAlreadyClear(glass, subject())) return Infinity;
      continue;
    }
    const clear = [];
    for (const sign of [-1, 1]) {
      const edge = Math.max(...glass.map(p => sign * p[0] / -p[2])) + clearance;
      const normal = [sign, 0, edge];
      clear.push(...clip(allowed, margin(normal), dot(delta, normal)));
    }
    allowed = merge(clear);
  }
  const candidates = allowed.map(([lo, hi]) => Math.max(lo, Math.min(0, hi))).sort((a, b) => Math.abs(a) - Math.abs(b));
  for (const distance of candidates) {
    if (!Number.isFinite(distance)) continue;
    const centred = eyes.every(each => {
      if (each.fitted) return each.fitted.centred(distance, each.delta, centreLimit);
      let low = Infinity, high = -Infinity;
      const front = each(distance, (x, z, r) => {
        if (!(z > r)) return false;
        const spread = r * Math.sqrt(x * x + z * z - r * r), denominator = z * z - r * r;
        low = Math.min(low, (x * z - spread) / denominator);
        high = Math.max(high, (x * z + spread) / denominator);
      });
      return front && Math.abs((low + high) / 2) <= centreLimit + 1e-9;
    });
    if (centred) return distance;
  }
  return Infinity;
}

/**
 * Can the wearer see the subject at all, in both eyes?
 *
 * The travel solvers above clip against these same six planes of the same
 * projection. They ask the stricter question — is the WHOLE subject inside —
 * because they are choosing a seat to move to. This asks the weakest question
 * that still means "the wearer is looking at it": no plane of either eye has
 * the entire subject on its outside. A molecule the wearer deliberately seated
 * so its edges run off the field is still seen, so that seat is still theirs;
 * one wholly nearer than the near plane, wholly beyond the far plane, or
 * wholly above the field is seen by nobody.
 *
 * Read-only, and it decides nothing on its own. Unreadable geometry answers
 * false: a seat no one can measure is not a seat anyone has looked at.
 */
export function subjectVisibleInEyes(geometry) {
  if (!geometry?.views?.length || !geometry.subject?.length) return false;
  for (const view of geometry.views) {
    const matrix = view.transform?.inverse?.matrix, projection = view.projectionMatrix;
    if (matrix?.length !== 16 || projection?.length !== 16) return false;
    const subject = eyeSubject(geometry, matrix);
    for (const plane of frustumPlanes(projection)) if (!(reachesPlane(subject, plane) > 1e-10)) return false;
  }
  return true;
}

/**
 * Why the zero-clearance lateral test answered as it did, per eye.
 *
 * `resetEntryLateralTravel` with `clearance: 0` is the gate that decides
 * whether Done keeps the wearer's saved seat. It reads Infinity — "no saved
 * seat, fit instead" — as soon as one eye finds the subject overlapping BOTH
 * lateral edges of the glass, and a molecule seated wholly above or below the
 * menu overlaps both. This repeats that edge test and, beside it, the full
 * separation test `resetEntryTravel` uses, which searches every hull direction
 * and so sees a vertical gap the lateral test cannot. A device record can then
 * say whether a saved seat was refused on lateral edges alone.
 *
 * Pure and read-only. It builds nothing the caller does not already have and
 * changes no decision; `resetEntryLateralTravel` is untouched.
 */
export function resetEntryLateralBreakdown({ geometry, points = [], clearance = 0 }) {
  if (!geometry?.views?.length || !Array.isArray(geometry.subject)) return undefined;
  const menu = points.map(p => applyMatrix4(p, geometry.renderFromRoom));
  const eyes = [];
  for (const view of geometry.views) {
    const matrix = view.transform?.inverse?.matrix;
    if (matrix?.length !== 16) return undefined;
    const subject = eyeSubject(geometry, matrix);
    const glass = menu.map(p => applyMatrix4(p, matrix)).filter(p => p[2] < -1e-9);
    const lateral = [-1, 1].map(sign => {
      if (!glass.length) return { edge: null, clear: true };
      const edge = Math.max(...glass.map(p => sign * p[0] / -p[2])) + clearance;
      const normal = [sign, 0, edge], norm = Math.hypot(...normal);
      return { edge, clear: subject.every(s => dot(s.center, normal) - s.radius * norm > 1e-10) };
    });
    // The separation `resetEntryTravel` looks for: any direction, vertical
    // included, that puts the whole subject off one side of the glass.
    let separated = !glass.length, separationX = null, separationY = null;
    if (glass.length && subject.length && !certainOverlap(glass, subject)) {
      const normals = separationDirections(glass, subject);
      for (const [x, y] of normals) {
        let edge = -Infinity;
        for (const p of glass) edge = Math.max(edge, (x * p[0] + y * p[1]) / -p[2]);
        if (subjectBeyond(subject, [x, y, edge])) { separated = true; separationX = x; separationY = y; break; }
      }
    }
    eyes.push({ eye: view.eye ?? null, menuPoints: glass.length, spheres: subject.length,
      edgeMinus: lateral[0].edge, edgePlus: lateral[1].edge,
      clearMinus: lateral[0].clear, clearPlus: lateral[1].clear,
      alreadyClear: lateral[0].clear || lateral[1].clear, separated, separationX, separationY });
  }
  return { eyes, alreadyClear: eyes.every(eye => eye.alreadyClear), separated: eyes.every(eye => eye.separated) };
}
