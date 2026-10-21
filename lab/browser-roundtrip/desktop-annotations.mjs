import { tetherCaption, placeTetherCaption } from './tether-caption.mjs';
import { motionRenderObjects } from './motion-transform.mjs';
import { annotationRadius, annotationOffsetCap, annotationDesktopSize } from './immersive-annotations.mjs';
import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { getMaxSize } from 'molstar/lib/mol-geo/geometry/size-data.js';
import { ValueCell } from 'molstar/lib/mol-util/value-cell.js';

// Mol* text billboards use molecular units, including their offsets. Keep this
// presentation-only policy out of saved scenes and out of the XR-enabled page.
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const em = .8; // Mol* TextBuilder's character box (1 / 1.25).
export const desktopLabelPixels = (size, desktopSizePx) => desktopSizePx === undefined
  ? clamp(16 * size, 14, 18) : clamp(desktopSizePx, 14, 48);

function projected(out, canvas, values, point, offsetZ = 0, start = 0) {
  const camera = canvas.camera, scale = camera.scale ?? 1;
  const center = out.center;
  Vec3.set(center, point[start], point[start + 1], point[start + 2]);
  Vec3.transformMat4(center, center, values.aTransform.ref.value);
  const world = Vec3.scale(out.world, center, scale);
  const eye = Vec3.transformMat4(out.eye, world, camera.view);
  if (camera.state.mode === 'orthographic') eye[2] += offsetZ * scale;
  else Vec3.scaleAndAdd(eye, eye, Vec3.normalize(out.direction, eye), -offsetZ * scale);
  const depth = camera.state.mode === 'orthographic' ? 1 : -eye[2];
  if (depth <= 0) return;
  const ndc = Vec3.transformMat4(out.ndc, eye, camera.projection);
  const ratio = canvas.webgl?.pixelRatio ?? 1, { width, height } = camera.viewport;
  out.x = (ndc[0] + 1) * width / (2 * ratio); out.y = (ndc[1] + 1) * height / (2 * ratio);
  out.pixelsPerUnit = camera.projection[5] * height * scale / (2 * depth * ratio);
  return out;
}

const overlaps = (a, b) => a.left < b.right + 3 && a.right > b.left - 3
  && a.bottom < b.top + 3 && a.top > b.bottom - 3;

// Work in CSS pixels, in the same bottom-up coordinates as the text shader.
// Search the nearest free rectangle, rather than pushing successive labels
// indefinitely above/below the canvas. Geometry and atom targets stay intact.
const intervalOrder = (a, b) => a.low - b.low;
function placeLabel(box, at, bounds, unit, preferredX, preferredY, width, height, topInset, bottomInset, occupied, count, intervals, intervalPool) {
  const minX = 4 - at.x - bounds.left * unit, maxX = width - 4 - at.x - bounds.right * unit;
  const minY = 4 + bottomInset - at.y - bounds.bottom * unit, maxY = height - 4 - topInset - at.y - bounds.top * unit;
  const x0 = minX <= maxX ? clamp(preferredX, minX, maxX) : (minX + maxX) / 2;
  const y0 = minY <= maxY ? clamp(preferredY, minY, maxY) : (minY + maxY) / 2;
  let bestX = x0, bestY = y0, bestScore = Infinity;
  box.left = at.x + x0 + bounds.left * unit; box.right = at.x + x0 + bounds.right * unit;
  box.bottom = at.y + y0 + bounds.bottom * unit; box.top = at.y + y0 + bounds.top * unit;
  let collision = false;
  for (let i = 0; i < count; i++) if (overlaps(box, occupied[i])) { collision = true; break; }
  if (collision && minY <= maxY) {
    // A free rectangle begins at an existing plate/viewport edge. At each
    // candidate x, merge blocked vertical intervals instead of testing every
    // x/y pair against every plate. Scratch is reused even for dense figures.
    for (let column = -3; column < count * 2; column++) {
      const other = column < 0 ? null : occupied[column >> 1];
      const requested = column === -3 ? x0 : column === -2 ? minX : column === -1 ? maxX : column % 2
        ? other.right + 3 - at.x - bounds.left * unit : other.left - 3 - at.x - bounds.right * unit;
      const x = minX <= maxX ? clamp(requested, minX, maxX) : x0, horizontalScore = (x - x0) ** 2;
      if (horizontalScore >= bestScore) continue;
      const left = at.x + x + bounds.left * unit, right = at.x + x + bounds.right * unit;
      let blocked = 0;
      for (let i = 0; i < count; i++) {
        const other = occupied[i];
        if (left >= other.right + 3 || right <= other.left - 3) continue;
        const interval = intervalPool[blocked] ?? (intervalPool[blocked] = {});
        interval.low = other.bottom - 3 - at.y - bounds.top * unit;
        interval.high = other.top + 3 - at.y - bounds.bottom * unit;
        intervals[blocked++] = interval;
      }
      intervals.length = blocked; intervals.sort(intervalOrder);
      let low = minY;
      for (let i = 0; i <= blocked; i++) {
        const interval = intervals[i], high = Math.min(maxY, interval?.low ?? maxY);
        if (low <= high) {
          const y = clamp(y0, low, high), score = horizontalScore + (y - y0) ** 2;
          if (score < bestScore) { bestX = x; bestY = y; bestScore = score; }
        }
        if (!interval) break;
        low = Math.max(low, interval.high);
        if (low > maxY) break;
      }
    }
  }
  box.left = at.x + bestX + bounds.left * unit; box.right = at.x + bestX + bounds.right * unit;
  box.bottom = at.y + bestY + bounds.bottom * unit; box.top = at.y + bestY + bounds.top * unit;
  box.x = bestX; box.y = bestY;
}

/** Updates uniforms/culling bounds only; zoom and motion never rebuild geometry. */
export function createDesktopAnnotationSizing({ enabled = true, topInset = 0, bottomInset = 0 } = {}) {
  const extents = new WeakMap(), seen = new WeakMap(), occupied = [], intervals = [], intervalPool = [], layouts = [];
  const projection = () => ({center:Vec3(), world:Vec3(), eye:Vec3(), direction:Vec3(), ndc:Vec3()});
  const first = projection(), second = projection();
  let changed = false, pass = 0;
  const set = (cell, value) => {
    if (!Number.isFinite(value) || Math.abs(cell.ref.value - value) < 1e-5) return;
    ValueCell.update(cell, value); changed = true;
  };
  return (canvas, representations, components = representations, tethers = representations) => {
    if (!enabled || canvas.xr?.isPresenting?.value) return false;
    changed = false; pass++;
    let occupiedCount = 0, layoutDirty = false;
    // Arrays are borrowed from their owners; no frame-local collection or Set.
    for (let group = 0; group < 3; group++) {
      const list = group === 0 ? representations : group === 1 ? components : tethers;
      for (let index = 0; index < list.length; index++) {
        const repr = list[index];
        if (seen.get(repr) === pass) continue;
        seen.set(repr, pass);
        if (!repr.state.visible) continue;
        for (const object of motionRenderObjects(repr)) {
          const v = object.values;
          if (object.type === 'cylinders') {
            // A two-CSS-pixel diameter even at the far end of a tilted tether.
            const start = v.aStart.ref.value, end = v.aEnd.ref.value;
            const a = projected(first, canvas, v, start);
            const b = projected(second, canvas, v, end, 0, end.length - 3);
            if (a && b && v.uSize) set(v.uSizeFactor, Math.max(repr.props.sizeFactor ?? 1,
              1 / (getMaxSize(v) * Math.min(a.pixelsPerUnit, b.pixelsPerUnit))));
            continue;
          }
          if (object.type !== 'text' || !v.uSize) continue;
          // Native component plates are not figure annotations, so they did
          // not opt into the existing depth-aware label pass when built. Their
          // rectangles can be disjoint while molecular geometry erases the
          // ink. Enroll only the desktop component path; XR keeps its plate
          // policy, and the pass preserves depth with translucent hidden ink.
          if (group === 1 && !object.state.stereofoldLessonLabel) {
            object.state.stereofoldLessonLabel = true; changed = true;
          }
          const p = repr.props, authoredSize = p.sizeFactor ?? 1;
          const offsetZ = annotationRadius(repr) * Mat4.getMaxScaleOnAxis(v.matrix.ref.value) + (p.offsetZ ?? 0);
          set(v.uOffsetZ, offsetZ);
          const at = projected(first, canvas, v, v.aPosition.ref.value,
            offsetZ + (v.aDepth.ref.value[0] ?? 0) * .95);
          if (!at) continue;
          const desktopSizePx = annotationDesktopSize(repr);
          const pixels = desktopLabelPixels(authoredSize, desktopSizePx), unit = pixels / em;
          const size = unit / (getMaxSize(v) * at.pixelsPerUnit);
          // Ordinary labels retain their two-box cap. Explicit desktop sizing
          // opts into the authored cap; viewport/collision layout still applies.
          const cap = desktopSizePx === undefined ? 2 : annotationOffsetCap(repr);
          let x = clamp((p.offsetX ?? 0) / authoredSize, -cap, cap) * pixels;
          let y = clamp((p.offsetY ?? 0) / authoredSize, -cap, cap) * pixels;
          let bounds = extents.get(object);
          if (!bounds || bounds.mapping !== v.aMapping.ref.value || bounds.version !== v.aMapping.ref.version) {
            const mapping = v.aMapping.ref.value;
            bounds = { mapping, version: v.aMapping.ref.version, left: Infinity, right: -Infinity, bottom: Infinity, top: -Infinity };
            for (let i = 0; i < mapping.length; i += 2) {
              bounds.left = Math.min(bounds.left, mapping[i]); bounds.right = Math.max(bounds.right, mapping[i]);
              bounds.bottom = Math.min(bounds.bottom, mapping[i + 1]); bounds.top = Math.max(bounds.top, mapping[i + 1]);
            }
            extents.set(object, bounds);
          }
          const caption = tetherCaption(repr);
          if (caption?.automatic) {
            placeTetherCaption(caption, canvas.camera, unit); x = caption.x; y = caption.y;
          }
          let box = occupied[occupiedCount];
          if (!box) occupied[occupiedCount] = box = {};
          const height = (bounds.top - bounds.bottom) * unit + 4;
          // Automatic tether captions retain their leader-normal policy. Fixed
          // atom labels may reflow in two axes to clear neighbours and edges.
          for (let lane = 0; caption?.automatic && lane <= 64; lane++) {
            box.left = at.x + x + bounds.left * unit; box.right = at.x + x + bounds.right * unit;
            box.bottom = at.y + y + bounds.bottom * unit; box.top = at.y + y + bounds.top * unit;
            let collision = false;
            for (let i = 0; i < occupiedCount; i++) if (overlaps(box, occupied[i])) { collision = true; break; }
            if (!collision || lane === 64) break;
            const next = lane + 1;
            x = caption.x + caption.nx * next * height;
            y = caption.y + caption.ny * next * height;
          }
          if (!caption?.automatic) {
            const ratio = canvas.webgl?.pixelRatio ?? 1;
            const width = canvas.camera.viewport.width / ratio, height = canvas.camera.viewport.height / ratio;
            const previous = layouts[occupiedCount] ?? (layouts[occupiedCount] = {});
            layoutDirty ||= previous.pass !== pass - 1 || previous.object !== object || previous.bounds !== bounds || previous.atX !== at.x || previous.atY !== at.y
              || previous.unit !== unit || previous.x !== x || previous.y !== y || previous.width !== width || previous.height !== height;
            if (layoutDirty) {
              Object.assign(previous, {object, bounds, atX:at.x, atY:at.y, unit, x, y, width, height});
              placeLabel(box, at, bounds, unit, x, y, width, height, topInset, bottomInset, occupied, occupiedCount, intervals, intervalPool);
            }
            // A hidden/unprojected trailing slot may have missed changes to
            // earlier blockers, even when its own inputs are unchanged.
            previous.pass = pass;
            x = box.x; y = box.y;
          } else { layouts[occupiedCount] = undefined; layoutDirty = true; }
          occupiedCount++;
          set(v.uSizeFactor, size); set(v.uOffsetX, x / at.pixelsPerUnit); set(v.uOffsetY, y / at.pixelsPerUnit);
          // The original molecular-unit text bounds no longer enclose the bigger
          // billboard. Keep the render object's culling sphere conservative, while
          // leaving source/placement bounds and saved figure parameters untouched.
          const radius = Math.hypot(Math.max(Math.abs(x + bounds.left * unit), Math.abs(x + bounds.right * unit)),
            Math.max(Math.abs(y + bounds.bottom * unit), Math.abs(y + bounds.top * unit))) / at.pixelsPerUnit
            + Math.abs(offsetZ) + (v.aDepth.ref.value[0] ?? 0);
          const sphere = v.boundingSphere.ref.value;
          if (Math.abs(sphere.radius - radius) > 1e-5 || Vec3.distance(sphere.center, at.center) > 1e-5) {
            Vec3.copy(sphere.center, at.center); sphere.radius = radius;
            ValueCell.update(v.boundingSphere, sphere);
          }
        }
      }
    }
    return changed;
  };
}
