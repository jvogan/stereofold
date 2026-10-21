import { tetherCaption, placeTetherCaption } from './tether-caption.mjs';
import { getMaxSize } from 'molstar/lib/mol-geo/geometry/size-data.js';
import { motionRenderObjects } from './motion-transform.mjs';
import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { ValueCell } from 'molstar/lib/mol-util/value-cell.js';
import { updatePlacementBounds } from './placement-bounds.mjs';

// Calibrated to the readable hemoglobin motion capture, camera.scale=.02421.
// Glyph expansion ignores aTransform; offsets and cylinder radii do not have
// the same scaling semantics. Keep these presentation values out of the scene.
export const FIGURE_REFERENCE_SCALE = .02421;
// Mol* TextBuilder's character box (1 / 1.25 mapping units per size unit).
const EM = .8;
// An authored offset keeps its drawn length, capped at two character boxes
// by default. A lesson label may raise its headset cap to five boxes.
export const MAX_PLATE_OFFSET_EM = 2;
// A plate clears its anchor residue, not its whole selection. A selection-wide
// push magnified the offset with distance and slid plates across their parts.
export const PLATE_STANDOFF_ANGSTROM = 3;
// Selections wider than this anchor on the surface that faces the wearer.
export const SURFACE_ANCHOR_RADIUS = 6;
// Re-pick the facing anchor only after the view turns this far around it.
const ANCHOR_HYSTERESIS = Math.cos(20 * Math.PI / 180);
export const immersivePlateOffset = (authored, gain, em, maxOffsetEm = MAX_PLATE_OFFSET_EM) =>
  Math.max(-maxOffsetEm * em, Math.min(maxOffsetEm * em, (authored ?? 0) * gain));
export const immersivePlateStandoff = (radius, placement, gain) =>
  Math.min(radius, PLATE_STANDOFF_ANGSTROM) * placement + 3 * gain;

/**
 * Candidate anchors for a selection wider than one residue: the atom furthest
 * along each of 26 directions from the selection centre, so one of them faces
 * any eye. The bounding-sphere centre of a chain-wide selection is often empty
 * space between helices, and a plate there floats off its part.
 */
export function surfaceAnchorCandidates(positions, center, radius) {
  if (!(radius > SURFACE_ANCHOR_RADIUS) || positions.length < 6) return undefined;
  const directions = [];
  for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++)
    if (x || y || z) { const n = Math.hypot(x, y, z); directions.push([x / n, y / n, z / n]); }
  const chosen = new Set();
  for (const [dx, dy, dz] of directions) {
    let best = -1, score = -Infinity;
    for (let i = 0; i < positions.length; i += 3) {
      const s = (positions[i] - center[0]) * dx + (positions[i + 1] - center[1]) * dy + (positions[i + 2] - center[2]) * dz;
      if (s > score) { score = s; best = i; }
    }
    chosen.add(best);
  }
  const points = new Float32Array(chosen.size * 3);
  let reach = 0, k = 0;
  for (const i of chosen) {
    points[k++] = positions[i]; points[k++] = positions[i + 1]; points[k++] = positions[i + 2];
    reach = Math.max(reach, Math.hypot(positions[i] - center[0], positions[i + 1] - center[1], positions[i + 2] - center[2]));
  }
  return { center: Vec3.clone(center), points, reach };
}

/** Index of the candidate furthest toward `direction` (unit, source frame). */
export function facingAnchorIndex(anchors, direction) {
  const { points, center } = anchors;
  let best = 0, score = -Infinity;
  for (let i = 0; i < points.length; i += 3) {
    const s = (points[i] - center[0]) * direction[0] + (points[i + 1] - center[1]) * direction[1] + (points[i + 2] - center[2]) * direction[2];
    if (s > score) { score = s; best = i / 3; }
  }
  return best;
}

const annotations = new WeakMap();
export function registerImmersiveAnnotation(repr, { size = 1, radius = 0, stroke = false, minDiameter = .004, length = 0, anchors, maxOffsetEm = MAX_PLATE_OFFSET_EM, desktopSizePx, placement, anchorKey } = {}) {
  // Opt in only lesson plates (including distance and moving tether text).
  // Renderable state is shared with Mol*'s renderer; molecular strokes and UI
  // keep their ordinary depth handling. Reapply after a geometry replacement.
  if (!annotations.has(repr) && !stroke) {
    const mark = () => {
      for (const object of motionRenderObjects(repr))
        if (object.type === 'text') object.state.stereofoldLessonLabel = true;
    };
    mark();
    repr.updated.subscribe(mark);
  }
  annotations.set(repr, { size, radius, stroke, minDiameter, length, anchors, maxOffsetEm, desktopSizePx, placement, anchorKey, anchorIndex: -1, anchorDirection: Vec3(),
    anchorInverse: Mat4(), anchorMatrixVersion: -1, cameraScale: NaN, matrixVersion: -1 });
  return repr;
}
export const annotationOutsideFigure = repr => annotations.get(repr)?.placement === 'outside-figure';
export const annotationAnchorKey = repr => annotations.get(repr)?.anchorKey;
export const annotationOffsetCap = repr => annotations.get(repr)?.maxOffsetEm ?? MAX_PLATE_OFFSET_EM;
export const annotationDesktopSize = repr => annotations.get(repr)?.desktopSizePx;
export const annotationRadius = repr => annotations.get(repr)?.radius ?? 0;

/** Conservative billboard reach for chapter/menu fitting, also before reveal.
 * Text quads ignore molecular scale and face either eye. Bound their radial
 * reach from the anchor using the same size/offset rules as the frame hook.
 * This runs at a layout edge, never inside the animation's pose update.
 */
export function annotationFieldBounds(repr, object, cameraScale, placementScale) {
  const v = object.values, meta = annotations.get(repr), mapping = v.aMapping?.ref.value;
  if (object.type !== 'text' || !mapping?.length) return { radius: 0, offset: [0, 0, 0] };
  const gain = FIGURE_REFERENCE_SCALE / cameraScale;
  const font = meta ? 6 * meta.size * gain : v.uSizeFactor?.ref.value ?? 1;
  let reach = 0;
  for (let i = 0; i < mapping.length; i += 2) reach = Math.max(reach, Math.hypot(mapping[i], mapping[i + 1]));
  const em = EM * getMaxSize(v) * font;
  const x = meta ? immersivePlateOffset(repr.props.offsetX, gain, em, meta.maxOffsetEm) : v.uOffsetX?.ref.value ?? 0;
  const y = meta ? immersivePlateOffset(repr.props.offsetY, gain, em, meta.maxOffsetEm) : v.uOffsetY?.ref.value ?? 0;
  const z = meta ? immersivePlateStandoff(meta.radius, placementScale, gain) : v.uOffsetZ?.ref.value ?? 0;
  // `radius` covers the plate wherever its stand-off pushes it, and a facing
  // anchor can sit anywhere on the selection's surface (`anchorReach` from
  // its centre). `half` is the drawn plate itself, its half width and height
  // facing the eye about a centre Mol* pushes `push` along the ray toward
  // the eye.
  const travel = (meta?.anchors?.reach ?? 0) * placementScale;
  const size = getMaxSize(v) * font;
  let wide = 0, tall = 0;
  for (let i = 0; i < mapping.length; i += 2) { wide = Math.max(wide, Math.abs(mapping[i])); tall = Math.max(tall, Math.abs(mapping[i + 1])); }
  return { radius: reach * size + Math.abs(z) + travel + 2, offset: [x, y, 0], half: [wide * size + 2, tall * size + 2], push: Math.abs(z),
    anchorReach: travel };
}

export function copyImmersiveAnnotation(from, to) {
  const meta = annotations.get(from);
  if (meta) registerImmersiveAnnotation(to, meta);
}

const eyeLocal = Vec3();
/**
 * Move a wide selection's anchor to the candidate facing `eye` (source
 * coordinates, before placement). Rewrites the plate's few anchor vertices,
 * which is a buffer upload, not a geometry rebuild, and only when the view
 * has turned past the hysteresis angle.
 */
function faceAnchor(meta, v, eye) {
  const anchors = meta.anchors;
  if (!anchors || !eye) return false;
  // A rebuilt plate starts at its selection centre again.
  if (meta.anchorIndex >= 0 && (v.aPosition.ref.value !== meta.anchorArray || v.aPosition.ref.version !== meta.anchorVersion))
    meta.anchorIndex = -1;
  if (meta.anchorMatrixVersion !== v.matrix.ref.version) {
    Mat4.invert(meta.anchorInverse, v.matrix.ref.value); meta.anchorMatrixVersion = v.matrix.ref.version;
  }
  Vec3.transformMat4(eyeLocal, eye, meta.anchorInverse);
  Vec3.sub(eyeLocal, eyeLocal, anchors.center);
  const length = Vec3.magnitude(eyeLocal);
  if (!(length > 1e-6)) return false;
  Vec3.scale(eyeLocal, eyeLocal, 1 / length);
  if (meta.anchorIndex >= 0 && Vec3.dot(eyeLocal, meta.anchorDirection) > ANCHOR_HYSTERESIS) return false;
  Vec3.copy(meta.anchorDirection, eyeLocal);
  const index = facingAnchorIndex(anchors, eyeLocal);
  if (index === meta.anchorIndex) return false;
  meta.anchorIndex = index;
  const positions = v.aPosition.ref.value, p = anchors.points, i = index * 3;
  for (let j = 0; j < positions.length; j += 3) { positions[j] = p[i]; positions[j + 1] = p[i + 1]; positions[j + 2] = p[i + 2]; }
  ValueCell.update(v.aPosition, positions);
  meta.anchorArray = positions; meta.anchorVersion = v.aPosition.ref.version;
  return true;
}
// Module scope: this runs for every moving label each XR frame, so it must not
// allocate a closure per call.
function setUniform(cell, value) {
  if (Math.abs(cell.ref.value - value) < 1e-6) return false;
  ValueCell.update(cell, value);
  return true;
}
/** `eye` is the wearer's eye in source coordinates; omit it to keep anchors. */
export function sizeImmersiveAnnotation(repr, canvas, eye) {
  const meta = annotations.get(repr), scale = canvas?.camera?.scale;
  if (!meta || !repr.state.visible || !canvas.xr?.isPresenting?.value || !(scale > 0)) return false;
  let changed = false, anchored = false;
  const objects = motionRenderObjects(repr);
  const caption = tetherCaption(repr);
  for (const object of objects) {
    const v = object.values;
    const gain = FIGURE_REFERENCE_SCALE / scale;
    if (object.type === 'text' && meta.placement !== 'outside-figure' && faceAnchor(meta, v, eye)) anchored = changed = true;
    // A paused connector still responds to camera turns. Reuse the settled
    // uniforms and bounds when its projected normal has not changed.
    if (caption?.automatic) placeTetherCaption(caption, canvas.camera, getMaxSize(v) * 6 * meta.size * gain);
    if (meta.cameraScale === scale && meta.matrixVersion === v.matrix.ref.version
      && (!caption?.automatic || (Math.abs(v.uOffsetX.ref.value - caption.x) < 1e-6
        && Math.abs(v.uOffsetY.ref.value - caption.y) < 1e-6))) continue;
    const placement = Mat4.getMaxScaleOnAxis(v.matrix.ref.value);
    if (meta.stroke) {
      // Match the shipped impostor shader: uniform similarities scale radius;
      // a longitudinally stretched tether keeps the upstream radius behavior.
      const radiusScale = cylinderRadiusScale(v.matrix.ref.value);
      const strokeRadius = getMaxSize(v);
      if (setUniform(v.uSizeFactor, Math.max(repr.props.sizeFactor ?? 1, meta.length / (300 * strokeRadius), meta.minDiameter / (2 * strokeRadius * scale * radiusScale)))) changed = true;
      updatePlacementBounds(repr, objects);
      const sphere = v.boundingSphere.ref.value;
      sphere.radius += strokeRadius * v.uSizeFactor.ref.value * radiusScale;
      ValueCell.update(v.boundingSphere, sphere);
    } else {
      if (setUniform(v.uSizeFactor, 6 * meta.size * gain)) changed = true;
      // scaleByRadius:false puts aDepth at zero. Restore surface clearance
      // independently of glyph size; otherwise the opaque fold slices plates.
      if (setUniform(v.uOffsetZ, immersivePlateStandoff(meta.radius, placement, gain))) changed = true;
      const em = EM * getMaxSize(v) * v.uSizeFactor.ref.value;
      if (setUniform(v.uOffsetX, caption?.automatic ? caption.x : immersivePlateOffset(repr.props.offsetX, gain, em, meta.maxOffsetEm))) changed = true;
      if (setUniform(v.uOffsetY, caption?.automatic ? caption.y : immersivePlateOffset(repr.props.offsetY, gain, em, meta.maxOffsetEm))) changed = true;
      // Bounds must include the enlarged eye-facing plate at its stand-off.
      // The glyph quad ignores aTransform rotation and scale. Expand the
      // repaired anchor bounds conservatively without touching source bounds.
      updatePlacementBounds(repr, objects);
      const mapping = v.aMapping.ref.value;
      if (meta.mapping !== mapping) {
        meta.mapping = mapping; meta.extent = 0;
        for (let i = 0; i < mapping.length; i += 2)
          meta.extent = Math.max(meta.extent, Math.hypot(mapping[i], mapping[i + 1]));
      }
      const reach = meta.extent * v.uSizeFactor.ref.value + Math.hypot(v.uOffsetX.ref.value, v.uOffsetY.ref.value);
      const sphere = v.boundingSphere.ref.value;
      sphere.radius += reach + Math.abs(v.uOffsetZ.ref.value) + (meta.anchors?.reach ?? 0) * placement + 2;
      ValueCell.update(v.boundingSphere, sphere);
    }
    meta.cameraScale = scale; meta.matrixVersion = v.matrix.ref.version;
  }
  // Upload the moved anchor vertices; uniforms need no scene update.
  if (anchored) canvas.update?.(repr, true);
  return changed;
}

// CPU counterpart of stereofoldImpostorScale in the pinned cylinder shader.
export function cylinderRadiusScale(m) {
  const xx = m[0] ** 2 + m[1] ** 2 + m[2] ** 2, tolerance = xx * .001;
  const yy = m[4] ** 2 + m[5] ** 2 + m[6] ** 2, zz = m[8] ** 2 + m[9] ** 2 + m[10] ** 2;
  return xx > 0 && Math.abs(yy - xx) <= tolerance && Math.abs(zz - xx) <= tolerance
    && Math.abs(m[0]*m[4]+m[1]*m[5]+m[2]*m[6]) <= tolerance
    && Math.abs(m[0]*m[8]+m[1]*m[9]+m[2]*m[10]) <= tolerance
    && Math.abs(m[4]*m[8]+m[5]*m[9]+m[6]*m[10]) <= tolerance ? Math.sqrt(xx) : 1;
}
