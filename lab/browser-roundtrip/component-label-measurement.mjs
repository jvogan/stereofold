// Render evidence, independent of the label solver. Matrices are WebXR's
// column-major matrices; world points are metres in the pose's reference space.
const EPS = 1e-9;
const cell = (object, name) => object?.values?.[name]?.ref?.value;
const transform = (m, p, w = 1) => [0, 1, 2, 3].map(i =>
  m[i] * p[0] + m[i + 4] * p[1] + m[i + 8] * p[2] + m[i + 12] * w);
const xyz = p => p.slice(0, 3);
export const labelObjectVisible = object => {
  const alpha = cell(object, 'alpha');
  const factor = object?.state?.alphaFactor ?? 1;
  const opacity = alpha === undefined || alpha === null ? 1 : Number.isFinite(alpha) ? alpha : 0;
  return Boolean(object && object.state?.visible !== false && !object.state?.disposed
    && cell(object, 'drawCount') > 0 && opacity * (Number.isFinite(factor) ? factor : 0) > 0);
};

// A committed Mol* object can be visible before its GPU buffers have been
// populated. Do not spend the one-shot evidence generation on that state.
export const labelObjectRenderable = object => Boolean(labelObjectVisible(object)
  && cell(object, 'aPosition')?.length >= 3
  && cell(object, 'aMapping')?.length >= 2
  && cell(object, 'aTransform')?.length >= 16
  && cell(object, 'elements')?.length > 0);

function sizeAt(object, vertex, instance) {
  const type = cell(object, 'dSizeType');
  if (type === 'uniform') return cell(object, 'uSize');
  if (type === 'attribute') return cell(object, 'aSize')?.[vertex];
  const group = cell(object, 'aGroup')?.[vertex] ?? 0;
  const index = { instance, group, groupInstance: instance * cell(object, 'uGroupCount') + group,
    vertex, vertexInstance: instance * cell(object, 'uVertexCount') + vertex }[type];
  const bytes = cell(object, 'tSize')?.array, offset = index * 3;
  return bytes ? (bytes[offset] * 65536 + bytes[offset + 1] * 256 + bytes[offset + 2] - 1) / 100 : NaN;
}

/**
 * Read the backing quad Mol* committed, not text widths or solver offsets.
 * aTransform includes repr.setState({transform}) after applyInspectionTransform.
 * aMapping already includes the actual atlas width, attachment and paint margin.
 * In XR the held-zero headRotation selects text.vert's eye-facing expansion.
 * text.vert applies offsetZ, depth and the backing bias whenever uHasEyeCamera
 * is false, and it is false in the headset: Mol*'s stereo EyeCamera never has
 * its viewEye written (only the ray helper's private camera does), so every
 * eye pass pushes the centre toward the eye before projecting it. The push
 * keeps the anchor where it is on the glass but shrinks the depth the corner
 * offsets are divided by, which is what a per-eye rectangle has to carry.
 */
export function renderedLabelQuads(object, view, cameraScale) {
  if (!labelObjectVisible(object) || !(cameraScale > 0)) return [];
  const positions = cell(object, 'aPosition'), mappings = cell(object, 'aMapping');
  const tex = cell(object, 'aTexCoord'), matrices = cell(object, 'aTransform');
  const elements = cell(object, 'elements'), depths = cell(object, 'aDepth');
  if (!positions || !mappings || !matrices || !elements) return [];
  const vertices = [...new Set(Array.from(elements.slice(0, cell(object, 'drawCount'))))];
  // A backing starts with four vertices tagged (10,10). Glyphs are only used
  // if a text-only layer is all that remains visible.
  const backing = vertices.filter(i => tex?.[i * 2] === 10);
  const selected = backing.length ? backing : vertices;
  if (!selected.length) return [];
  const quads = [];
  for (let instance = 0; instance < (cell(object, 'instanceCount') ?? 1); instance++) {
    const matrix = matrices.slice(instance * 16, instance * 16 + 16);
    if (matrix.length !== 16) continue;
    const first = selected[0];
    const anchor = xyz(transform(matrix, positions.slice(first * 3, first * 3 + 3))).map(v => v * cameraScale);
    const center = xyz(transform(view.transform.inverse.matrix, anchor));
    const glyphPush = ((cell(object, 'uOffsetZ') ?? 0) + (depths?.[first] ?? 0) * 0.95) * cameraScale;
    let push = ((cell(object, 'uOffsetZ') ?? 0) + (depths?.[first] ?? 0) * 0.95) * cameraScale;
    if (backing.length) {
      const clip = transform(view.projectionMatrix, center);
      const eye = view.transform.matrix.slice(12, 15);
      push -= 0.001 * Math.hypot(...eye.map((v, i) => v - clip[i]));
    }
    const distance = Math.hypot(...center);
    if (!(distance > EPS)) continue;
    const pushed = center.map(v => v * (1 - push / distance));
    const glyphDepth = center[2] * (1 - glyphPush / distance);
    const compensation = backing.length && cell(object, 'uPlateBillboard') > .5 && glyphDepth < -1e-5
      ? pushed[2] / glyphDepth : 1;
    let left = Infinity, right = -Infinity, bottom = Infinity, top = -Infinity;
    for (const i of selected) {
      const size = sizeAt(object, i, instance) * cell(object, 'uSizeFactor') * cameraScale;
      const x = (mappings[i * 2] * size + (cell(object, 'uOffsetX') ?? 0) * cameraScale) * compensation;
      const y = (mappings[i * 2 + 1] * size + (cell(object, 'uOffsetY') ?? 0) * cameraScale) * compensation;
      left = Math.min(left, x); right = Math.max(right, x);
      bottom = Math.min(bottom, y); top = Math.max(top, y);
    }
    if (![left, right, bottom, top].every(Number.isFinite)) continue;
    quads.push({ corners: [[left, bottom], [right, bottom], [right, top], [left, top]]
      .map(([x, y]) => xyz(transform(view.transform.matrix, [pushed[0] + x, pushed[1] + y, pushed[2]]))),
      anchor, em: 0.8 * sizeAt(object, first, instance) * cell(object, 'uSizeFactor') * cameraScale });
  }
  return quads;
}

/**
 * Each drawn name plate as a sphere, in room metres, that the near plane must
 * stay in front of. text.vert pushes a plate's anchor toward the eye by
 * `uOffsetZ` and draws the plate square to the eye at that depth, fanned
 * across the view from there, so none of it is nearer than its anchor less the
 * push. That is one anchor and one transform per plate, cheap enough to read
 * from the live transforms on every frame. `out` is reused when given.
 */
export function drawnPlateDepthSpheres(objects = [], cameraScale = 1, out = []) {
  out.length = 0;
  if (!(cameraScale > 0)) return out;
  for (const object of objects) {
    if (object?.type !== 'text' || !labelObjectVisible(object)) continue;
    const positions = cell(object, 'aPosition'), matrices = cell(object, 'aTransform');
    if (!(positions?.length >= 3) || !(matrices?.length >= 16)) continue;
    const push = Math.abs(cell(object, 'uOffsetZ') ?? 0) * cameraScale;
    const instances = Math.min(cell(object, 'instanceCount') ?? 1, Math.floor(matrices.length / 16));
    for (let instance = 0; instance < instances; instance++) {
      const m = matrices.subarray ? matrices.subarray(instance * 16, instance * 16 + 16)
        : matrices.slice(instance * 16, instance * 16 + 16);
      const center = xyz(transform(m, positions)).map(value => value * cameraScale);
      if (center.every(Number.isFinite) && Number.isFinite(push)) out.push({ center, radius: push });
    }
  }
  return out;
}

/** Mol* boundingSphere contains local instance transforms, but not values.matrix. */
export function renderedSubjectSphere(object, cameraScale) {
  if (!labelObjectVisible(object) || !(cameraScale > 0)) return null;
  const sphere = cell(object, 'boundingSphere'), matrix = cell(object, 'matrix');
  if (!(sphere?.radius > 0) || matrix?.length !== 16) return null;
  const scale = Math.max(...[0, 4, 8].map(i => Math.hypot(matrix[i], matrix[i + 1], matrix[i + 2])));
  return { center: xyz(transform(matrix, sphere.center)).map(value => value * cameraScale),
    radius: sphere.radius * scale * cameraScale };
}

const instanceMatrices = (object) => {
  const matrices = cell(object, 'aTransform'), count = Math.max(1, cell(object, 'instanceCount') ?? 1);
  if (!matrices || matrices.length < count * 16) return [];
  return Array.from({ length: count }, (_, i) => Array.from(matrices.slice(i * 16, i * 16 + 16)));
};

/**
 * One world sphere per committed instance: the invariant sphere carried by
 * that instance's aTransform, which is the matrix every shader draws with.
 * Mol* writes values.boundingSphere from `transform` alone in
 * Visual.setTransform but from aTransform (matrix folded in) in a geometry
 * update, so that cell's frame depends on which path ran last; aTransform
 * does not. Falls back to the boundingSphere-plus-matrix reading.
 */
export function renderedSubjectSpheres(object, cameraScale) {
  if (!labelObjectVisible(object) || !(cameraScale > 0)) return [];
  const sphere = cell(object, 'invariantBoundingSphere'), matrices = instanceMatrices(object);
  if (!(sphere?.radius > 0) || !matrices.length) {
    const single = renderedSubjectSphere(object, cameraScale);
    return single ? [single] : [];
  }
  return matrices.map(matrix => ({
    center: xyz(transform(matrix, sphere.center)).map(value => value * cameraScale),
    radius: sphere.radius * cameraScale
      * Math.max(...[0, 4, 8].map(i => Math.hypot(matrix[i], matrix[i + 1], matrix[i + 2]))) }));
}

// Mol* mesh buffers can retain spare capacity after a build. Those positions
// are not rendered; counting their zero/stale values invents molecular bounds.
// Older or synthetic objects without a valid live count keep conservative bounds.
export function renderedMeshVertexCount(object, positions = cell(object, 'aPosition')) {
  const capacity = Math.floor((positions?.length ?? 0) / 3);
  const live = cell(object, 'uVertexCount');
  return Number.isInteger(live) && live >= 0 && live <= capacity ? live : capacity;
}

/**
 * A bounded, evenly strided sample of the committed vertices in world metres.
 * A bounding sphere is a poor silhouette for an elongated structure: on the
 * telomerase entry it spans a 1.0 by 0.8 tangent box around a drawn 0.7 by
 * 0.4 one, and the solver parks plates just outside its own inflated sphere,
 * so the sphere test counted plates the picture shows in empty passthrough.
 */
export function renderedSubjectPoints(object, cameraScale, budget = 8192, includeVertex) {
  if (!labelObjectVisible(object) || !(cameraScale > 0) || !(budget > 0)) return [];
  const positions = cell(object, 'aPosition'), matrices = instanceMatrices(object);
  const count = object.type === 'mesh' ? renderedMeshVertexCount(object, positions)
    : positions ? Math.floor(positions.length / 3) : 0;
  if (!count || !matrices.length) return [];
  const stride = Math.max(1, Math.ceil(count * matrices.length / budget));
  const points = [];
  for (const [instance, matrix] of matrices.entries()) {
    for (let i = 0; i < count; i += stride) {
      if (includeVertex && !includeVertex(object, i, instance)) continue;
      const local = [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
      if (!local.every(Number.isFinite)) continue;
      points.push(xyz(transform(matrix, local)).map(value => value * cameraScale));
    }
  }
  return points;
}

/** A committed tether's tip-to-base-centre length in painted character em. */
export function renderedLeaderEm(object) {
  if (!labelObjectVisible(object)) return null;
  const mapping = cell(object, 'aMapping'), tex = cell(object, 'aTexCoord');
  // componentLabelPaint disables background on the dedicated leader object.
  // TextBuilder emits its tether first: tip, base A, base B, base centre.
  if (!mapping || !tex || tex[0] !== 10 || tex[6] !== 10) return null;
  const length = Math.hypot(mapping[6] - mapping[0], mapping[7] - mapping[1]);
  // Both length and em get the same live uSize * uSizeFactor * camera.scale.
  // Their ratio is invariant under per-eye billboard projection.
  return Number.isFinite(length) ? length / 0.8 : null;
}

export function viewTangentBounds(view) {
  const p = view.projectionMatrix;
  return [(-1 + p[8]) / p[0], (1 + p[8]) / p[0], (1 + p[9]) / p[5], (-1 + p[9]) / p[5]];
}

function clipPolygon(points) {
  // Homogeneous clipping handles near/far and quads crossing behind the eye,
  // before division by w. Clamping just the projected corners misses these.
  for (const plane of [p => p[3] + p[0], p => p[3] - p[0], p => p[3] + p[1],
    p => p[3] - p[1], p => p[3] + p[2], p => p[3] - p[2]]) {
    const next = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length], da = plane(a), db = plane(b);
      if (da >= 0) next.push(a);
      if ((da >= 0) !== (db >= 0)) next.push(a.map((v, j) => v + (b[j] - v) * da / (da - db)));
    }
    points = next;
  }
  return points;
}
const area = points => Math.abs(points.reduce((sum, p, i) => {
  const q = points[(i + 1) % points.length]; return sum + p[0] * q[1] - q[0] * p[1];
}, 0)) / 2;
function rectOf(points) {
  if (!points.length) return null;
  let l = Infinity, r = -Infinity, b = Infinity, t = -Infinity;
  for (const point of points) {
    l = Math.min(l, point[0]); r = Math.max(r, point[0]);
    b = Math.min(b, point[1]); t = Math.max(t, point[1]);
  }
  return { x: (l + r) / 2, y: (b + t) / 2, hw: (r - l) / 2, hh: (t - b) / 2 };
}
const intersects = (a, b) => a && b && Math.abs(a.x - b.x) < a.hw + b.hw - EPS
  && Math.abs(a.y - b.y) < a.hh + b.hh - EPS;
const clipToTangent = (v, p) => [(v[0] / v[3] + p[8]) / p[0], (v[1] / v[3] + p[9]) / p[5]];

export function projectPlateQuad(corners, view) {
  const p = view.projectionMatrix;
  const clips = corners.map(point => transform(p, transform(view.transform.inverse.matrix, point)));
  const tangent = v => clipToTangent(v, p);
  const inside = clipPolygon(clips).filter(v => v[3] > EPS).map(tangent);
  const original = clips.every(v => v[3] > EPS) ? clips.map(tangent) : [];
  const fullArea = area(original), insideArea = area(inside);
  return { rect: insideArea > EPS ? rectOf(inside) : null,
    insideArea, fullArea,
    inside: fullArea > EPS ? Math.min(1, insideArea / fullArea) : 0 };
}

/** The structure's world bounding-sphere silhouette, projected in this eye. */
function subjectRect(subject, view) {
  if (subject?.spheres) {
    const rects = subject.spheres.map(sphere => subjectRect(sphere, view)).filter(Boolean);
    return rectOf(rects.flatMap(r => [[r.x - r.hw, r.y - r.hh], [r.x + r.hw, r.y + r.hh]]));
  }
  if (!subject || !(subject.radius > 0)) return null;
  const [x, y, z] = transform(view.transform.inverse.matrix, subject.center), d = -z, r = subject.radius;
  const [l, right, t, b] = viewTangentBounds(view);
  const p = view.projectionMatrix, near = p[14] / (p[10] - 1), far = p[14] / (p[10] + 1);
  if (d + r <= near || d - r >= far) return null;
  if (d <= r) return rectOf([[l, b], [right, t]]);
  const span = v => {
    const reach = r * Math.sqrt(v * v + d * d - r * r), divisor = d * d - r * r;
    return [(v * d - reach) / divisor, (v * d + reach) / divisor];
  };
  const xx = span(x), yy = span(y);
  const left = Math.max(l, xx[0]), rr = Math.min(right, xx[1]), bottom = Math.max(b, yy[0]), top = Math.min(t, yy[1]);
  return rr > left && top > bottom ? rectOf([[left, bottom], [rr, top]]) : null;
}

/** Drawn subject vertices in this eye's tangent space, frustum-culled. */
function projectSubjectPoints(points, view) {
  const inverse = view.transform.inverse.matrix, [l, r, t, b] = viewTangentBounds(view);
  const p = view.projectionMatrix, near = p[14] / (p[10] - 1), far = p[14] / (p[10] + 1);
  const projected = [];
  for (const point of points) {
    const eye = transform(inverse, point), d = -eye[2];
    if (!(d > EPS) || d < near || d > far) continue;
    const [tx, ty] = clipToTangent(transform(p, eye), p);
    if (tx < l || tx > r || ty < b || ty > t) continue;
    projected.push([tx, ty]);
  }
  return projected;
}
const covers = (rect, points) => points.some(([x, y]) => Math.abs(x - rect.x) < rect.hw - EPS
  && Math.abs(y - rect.y) < rect.hh - EPS);

/**
 * One flat transport record per eye. A plate can supply known world quads for
 * tests, or live render objects for the viewer. Hidden/absent/zero-alpha objects
 * cannot contribute visible plates or overlaps. Rectangles are frustum-clipped.
 * `silhouette` is [x, y, hw, hh] in the same tangent space as the rects.
 */
export function measureComponentLabels({ plates = [], views = [], cameraScale = 1, subject = null } = {}) {
  return Array.from(views, view => {
    const rects = [], sampled = subject?.points?.length > 0;
    const drawn = sampled ? projectSubjectPoints(subject.points, view) : [];
    // Keep the reported silhouette based on the supplied sample, even when
    // none of it is in this eye's frustum. Coverage also includes spheres from
    // objects without readable points; sampled objects never use that fallback.
    const silhouette = sampled ? rectOf(drawn) : subjectRect(subject, view);
    const fallbackSpheres = subject?.fallbackSpheres ?? (sampled ? [] : subject?.spheres ?? [subject]);
    const fallbackRects = fallbackSpheres.map(sphere => subjectRect(sphere, view)).filter(Boolean);
    let offGlass = 0, subjectOverlaps = 0, leaderTotal = 0, leaders = 0;
    for (const plate of plates) {
      if (plate.hidden || plate.alpha <= 0 || plate.exists === false) continue;
      const quads = plate.quads ?? (plate.objects ?? []).flatMap(object => renderedLabelQuads(object, view, cameraScale));
      if (!quads.length) continue;
      const projected = quads.map(quad => projectPlateQuad(quad.corners, view));
      const fullArea = projected.reduce((sum, result) => sum + result.fullArea, 0);
      const insideArea = projected.reduce((sum, result) => sum + result.insideArea, 0);
      if (fullArea <= EPS || insideArea / fullArea < 0.9 - EPS) offGlass++;
      const points = projected.flatMap(({ rect }) => rect ? [[rect.x - rect.hw, rect.y - rect.hh], [rect.x + rect.hw, rect.y + rect.hh]] : []);
      const rect = rectOf(points);
      if (!rect) continue;
      rects.push({ id: plate.id, ...rect });
      if (covers(rect, drawn) || fallbackRects.some(sphere => intersects(rect, sphere))) subjectOverlaps++;
      for (const object of plate.leaders ?? []) {
        const em = renderedLeaderEm(object);
        if (em !== null) { leaderTotal += em; leaders++; }
      }
    }
    let overlaps = 0;
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) if (intersects(rects[i], rects[j])) overlaps++;
    return { eye: view.eye, plates: plates.length, visible: rects.length, overlaps, offGlass,
      subject: subject ? subjectOverlaps : null,
      silhouette: silhouette ? [silhouette.x, silhouette.y, silhouette.hw, silhouette.hh] : null,
      leaderEm: leaders ? leaderTotal / leaders : 0,
      rects, fov: viewTangentBounds(view) };
  });
}

/** Coalesce layout/menu invalidations; tracking loss never consumes evidence. */
export function createLabelMeasurementGate(intervalMs = 1000) {
  let pending = false, lastAt = -Infinity;
  return {
    invalidate() { pending = true; },
    due(now, presenting, views) { return pending && presenting && views?.length > 0 && now - lastAt >= intervalMs; },
    /** Defer a not-yet-drawable commit without inspecting it on every frame. */
    retry(now) { lastAt = now; },
    measured(now) { pending = false; lastAt = now; },
  };
}
