/**
 * Name plates hold their size in the eye, and stay inside the lens.
 *
 * A plate is sized once, for the seat, in the molecule's own units, so it
 * grows exactly as fast as the wearer approaches. Close to telomerase,
 * "GAR1 1", "NOP10 1" and "Dyskerin 1" drew several times their seated size
 * and ran off the edge of the lens. So every headset frame reads each drawn
 * plate's distance from each eye and:
 *
 * - holds its character box at `PLATE_CHARACTER_CEILING_DEGREES` at most, by
 *   shrinking the glyphs about the plate's own centre (lines keep their
 *   spacing in proportion);
 * - separates site plates within their authored offset cap, and moves colour
 *   legends inboard using the committed backing quads in both eyes;
 * - takes a plate the lens edge would cut out of that view, and puts it back
 *   once it fits.
 *
 * These are uniform writes on the plate's live render objects: no geometry and
 * no state-tree update. The size the layout built is remembered per object
 * and restored as the wearer moves back, and a fresh value from Mol* (a
 * relayout or a rebuild) becomes the new built size. The desktop never calls
 * this.
 */

import { ValueCell } from 'molstar/lib/mol-util/value-cell.js';
import { getMaxSize } from 'molstar/lib/mol-geo/geometry/size-data.js';

/** The largest character box, in degrees, a name plate draws in either eye. */
export const PLATE_CHARACTER_CEILING_DEGREES = 2;
/** How far inside the frame edge, in normalised device units, a plate must end. */
export const PLATE_LENS_MARGIN = 0.02;

const DEGREES = Math.PI / 180;
// One em of Mol* text, in size units (`text-builder.js` bHeight).
const EM_PER_SIZE = 0.8;
export const PLATE_MIN_EYE_DEPTH = 0.05;
const value = (object, name) => object?.values?.[name]?.ref?.value;

function setUniform(object, name, next) {
  const cell = object?.values?.[name];
  if (cell && Math.abs(cell.ref.value - next) >= 1e-9) ValueCell.update(cell, next);
}

function vertexSize(object) {
  // Selection labels store their constant size in a groupInstance texture.
  // Read that theme too; uSize is zero for these real figure primitives.
  return object?.values?.dSizeType ? getMaxSize(object.values) : 1;
}

/** The plate's anchor in the view's eye space, pushed toward the eye as text.vert does. */
function eyeAnchor(object, view, cameraScale, out, backing = false) {
  const p = value(object, 'aPosition'), m = value(object, 'aTransform'), v = view.transform.inverse.matrix;
  if (!(p?.length >= 3) || !(m?.length >= 16)) return undefined;
  const wx = (m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]) * cameraScale;
  const wy = (m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]) * cameraScale;
  const wz = (m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]) * cameraScale;
  const x = v[0] * wx + v[4] * wy + v[8] * wz + v[12];
  const y = v[1] * wx + v[5] * wy + v[9] * wz + v[13];
  const z = v[2] * wx + v[6] * wy + v[10] * wz + v[14];
  const distance = Math.hypot(x, y, z);
  if (!(distance > 1e-9)) return undefined;
  // Match text.vert: the push is not clamped when a transformed anchor
  // approaches or passes the eye. Such plates must be suppressed.
  let push = ((value(object, 'uOffsetZ') ?? 0) + (value(object, 'aDepth')?.[0] ?? 0) * .95) * cameraScale;
  if (backing) {
    // text.vert biases the glass behind its glyphs before applying the push.
    // At close oblique views this also moves the projected box sideways.
    const P = view.projectionMatrix, eye = view.transform.matrix;
    const cx = P[0]*x+P[4]*y+P[8]*z+P[12], cy = P[1]*x+P[5]*y+P[9]*z+P[13], cz = P[2]*x+P[6]*y+P[10]*z+P[14];
    push -= .001 * Math.hypot(eye[12]-cx, eye[13]-cy, eye[14]-cz);
  }
  const keep = 1 - push / distance;
  out[0] = x * keep; out[1] = y * keep; out[2] = z * keep;
  return out;
}

const anchor = [0, 0, 0];

/** The character box this plate draws in this eye, in degrees, at its current size. */
export function plateCharacterDegrees(object, view, cameraScale) {
  const at = eyeAnchor(object, view, cameraScale, anchor);
  if (!at) return 0;
  const em = EM_PER_SIZE * vertexSize(object) * value(object, 'uSizeFactor') * cameraScale;
  return 2 * Math.atan(em / (2 * Math.hypot(at[0], at[1], at[2]))) / DEGREES;
}

/** The actual backing in NDC, including asymmetric left/right projections. */
function eyeRect(object, view, cameraScale) {
  const tex = value(object, 'aTexCoord'), mapping = value(object, 'aMapping');
  const at = eyeAnchor(object, view, cameraScale, anchor);
  if (!tex || !mapping || !at || -at[2] < PLATE_MIN_EYE_DEPTH) return undefined;
  const glyphDepth = at[2];
  eyeAnchor(object, view, cameraScale, anchor, true);
  const compensation = value(object, 'uPlateBillboard') > .5 ? at[2] / glyphDepth : 1;
  const size = vertexSize(object) * value(object, 'uSizeFactor') * cameraScale * compensation;
  const offsetX = (value(object, 'uOffsetX') ?? 0) * cameraScale * compensation;
  const offsetY = (value(object, 'uOffsetY') ?? 0) * cameraScale * compensation;
  const P = view.projectionMatrix;
  let left = Infinity, right = -Infinity, bottom = Infinity, top = -Infinity;
  let gainX, gainY;
  // A name has one backing per primitive (first four vertices). Glyphs are
  // inside it. The colour key and wrapped lines each contribute their backing.
  for (let i = 0; i < 8 && i * 2 < tex.length; i++) {
    if (tex[i * 2] !== 10) continue;
    const x = at[0] + mapping[i * 2] * size + offsetX;
    const y = at[1] + mapping[i * 2 + 1] * size + offsetY, z = at[2];
    const w = P[3] * x + P[7] * y + P[11] * z + P[15];
    if (!(w > 0)) return undefined;
    const nx = (P[0] * x + P[4] * y + P[8] * z + P[12]) / w;
    const ny = (P[1] * x + P[5] * y + P[9] * z + P[13]) / w;
    left = Math.min(left, nx); right = Math.max(right, nx);
    bottom = Math.min(bottom, ny); top = Math.max(top, ny);
    gainX = P[0] * cameraScale * compensation / w; gainY = P[5] * cameraScale * compensation / w;
  }
  return Number.isFinite(left) ? { left, right, bottom, top, gainX, gainY } : undefined;
}
/** Project existing glass or a molecular silhouette without changing its seat.
 * Point sets are in the same scaled render coordinates as the XR views.
 */
export function plateObstaclesInEyes(pointSets, views, { silhouette = false } = {}) {
  const obstacles = [];
  for (const points of pointSets ?? []) {
    const rects = [];
    for (const view of views) {
      const v = view.transform.inverse.matrix, p = view.projectionMatrix;
      let left = Infinity, right = -Infinity, bottom = Infinity, top = -Infinity;
      // A bounded lens-space occupancy grid preserves holes and disconnected
      // parts. Glass keeps its solid quad. The union below is broad phase only.
      const cells = silhouette ? new Map() : undefined, step = .1;
      for (const point of points) {
        const x = v[0]*point[0]+v[4]*point[1]+v[8]*point[2]+v[12];
        const y = v[1]*point[0]+v[5]*point[1]+v[9]*point[2]+v[13];
        const z = v[2]*point[0]+v[6]*point[1]+v[10]*point[2]+v[14];
        const w = p[3]*x+p[7]*y+p[11]*z+p[15];
        if (!(w > 0)) continue;
        const nx = (p[0]*x+p[4]*y+p[8]*z+p[12])/w, ny = (p[1]*x+p[5]*y+p[9]*z+p[13])/w;
        if (cells) {
          // Samples outside the lens cannot obstruct an in-lens plate. Keep
          // one boundary cell to conservatively cover edge samples.
          if (Math.abs(nx) > 1.1 || Math.abs(ny) > 1.1) continue;
          const ix = Math.floor(nx / step), iy = Math.floor(ny / step), key = `${ix},${iy}`;
          if (!cells.has(key)) cells.set(key, { left: ix * step, right: (ix + 1) * step,
            bottom: iy * step, top: (iy + 1) * step });
          left = Math.min(left, ix * step); right = Math.max(right, (ix + 1) * step);
          bottom = Math.min(bottom, iy * step); top = Math.max(top, (iy + 1) * step);
        } else {
          left = Math.min(left, nx); right = Math.max(right, nx);
          bottom = Math.min(bottom, ny); top = Math.max(top, ny);
        }
      }
      rects.push(Number.isFinite(left) ? [{ left, right, bottom, top,
        ...(cells ? { cells: [...cells.values()] } : {}) }] : []);
    }
    obstacles.push(rects);
  }
  return obstacles;
}
const overlaps = (a, b) => a.left < b.right + .004 && b.left < a.right + .004
  && a.bottom < b.top + .004 && b.bottom < a.top + .004;
const shiftRect = (r, x, y) => ({ left: r.left + x * r.gainX, right: r.right + x * r.gainX,
  bottom: r.bottom + y * r.gainY, top: r.top + y * r.gainY });

/** Local uniform-only repair. Legends may move inboard; a site plate stays
 * within its own authored offset cap. Rectangles from BOTH eyes constrain
 * every candidate, so a left-eye clearance cannot cover a right-eye plate.
 * `placed` lives for one frame, in stable source order. No font measurement,
 * scene-tree commit or geometry rebuild occurs here.
 */
function placeInEyes(texts, views, cameraScale, memory, { legend, maxOffsetEm, placed, obstacles }) {
  const blocked = obstacles?.length ? [...(placed ?? []), ...obstacles] : placed ?? [];
  const rects = views.map(view => texts.map(object => eyeRect(object, view, cameraScale)));
  if (rects.some(rs => rs.some(r => !r))) return null;
  const edge = 1 - PLATE_LENS_MARGIN;
  let lowX = -Infinity, highX = Infinity, lowY = -Infinity, highY = Infinity;
  for (const rs of rects) for (const r of rs) {
    lowX = Math.max(lowX, (-edge - r.left) / r.gainX);
    highX = Math.min(highX, (edge - r.right) / r.gainX);
    lowY = Math.max(lowY, (-edge - r.bottom) / r.gainY);
    highY = Math.min(highY, (edge - r.top) / r.gainY);
  }
  const first = texts[0], em = EM_PER_SIZE * vertexSize(first) * value(first, 'uSizeFactor');
  const baseX = value(first, 'uOffsetX') ?? 0, baseY = value(first, 'uOffsetY') ?? 0;
  const local = Number.isFinite(maxOffsetEm) && !legend;
  if (local) {
    const cap = maxOffsetEm * em;
    lowX = Math.max(lowX, -cap - baseX); highX = Math.min(highX, cap - baseX);
    lowY = Math.max(lowY, -cap - baseY); highY = Math.min(highY, cap - baseY);
  }
  // Ordinary component/residue names keep their layout; only site plates and
  // detached colour legends opt into movement. Every plate still clips safely.
  if (!local && !legend) lowX = highX = lowY = highY = 0;
  if (lowX > highX || lowY > highY) return null;
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const candidates = [[clamp(0, lowX, highX), clamp(0, lowY, highY)]];
  // Keep a local plate beside its anchor, rather than across its named site.
  const beside = (x, y) => !local || Math.abs(baseY + y) >= .9 * em
    || Math.abs(baseX + x) >= ((rects[0][0].right - rects[0][0].left) / (2 * rects[0][0].gainX) + .2 * em);
  if (local) for (const y of [-em, em, -2 * em, 2 * em])
    candidates.push([clamp(0, lowX, highX), clamp(y - baseY, lowY, highY)]);
  const blockers = views.map((_, eye) => blocked.flatMap(other => other[eye] ?? []));
  const shifted = { left: 0, right: 0, bottom: 0, top: 0 };
  const clear = (x, y) => {
    if (!beside(x, y)) return false;
    for (let eye = 0; eye < rects.length; eye++) for (const r of rects[eye]) {
      shifted.left = r.left + x * r.gainX; shifted.right = r.right + x * r.gainX;
      shifted.bottom = r.bottom + y * r.gainY; shifted.top = r.top + y * r.gainY;
      if (shifted.left < -edge - 1e-8 || shifted.right > edge + 1e-8
        || shifted.bottom < -edge - 1e-8 || shifted.top > edge + 1e-8) return false;
      for (const b of blockers[eye]) {
        if (!overlaps(shifted, b)) continue;
        if (!b.cells) return false;
        for (const cell of b.cells) if (overlaps(shifted, cell)) return false;
      }
    }
    return true;
  };
  let best, distance = Infinity;
  for (const [x, y] of candidates) if (x*x+y*y < distance && clear(x, y)) { best = [x, y]; distance = x*x+y*y; }
  // A settled clear plate needs no search. Sort the separations by distance
  // so a local repair bounds the remaining Cartesian search immediately.
  const minimumDistance = candidates[0][0] ** 2 + candidates[0][1] ** 2;
  if (distance > minimumDistance) {
    // A collision contributes four exact separating offsets. Their Cartesian
    // combinations allow a row to move inboard and clear its neighbour vertically.
    const xs = new Set(candidates.map(c => c[0])), ys = new Set(candidates.map(c => c[1]));
    for (const other of blocked) for (let eye = 0; eye < rects.length; eye++)
      for (const r of rects[eye]) for (const bounds of other[eye] ?? []) for (const b of bounds.cells ?? [bounds]) {
        xs.add(clamp((b.left - .005 - r.right) / r.gainX, lowX, highX));
        xs.add(clamp((b.right + .005 - r.left) / r.gainX, lowX, highX));
        ys.add(clamp((b.bottom - .005 - r.top) / r.gainY, lowY, highY));
        ys.add(clamp((b.top + .005 - r.bottom) / r.gainY, lowY, highY));
      }
    const sortedX = [...xs].sort((a, b) => a*a - b*b), sortedY = [...ys].sort((a, b) => a*a - b*b);
    for (const x of sortedX) {
      if (x*x >= distance) break;
      for (const y of sortedY) {
        const d = x*x + y*y;
        if (d >= distance) break;
        if (clear(x, y)) { best = [x, y]; distance = d; }
      }
    }
  }
  if (!best) return null;
  for (const object of texts) {
    const seen = memory.get(object);
    seen.wroteX = (value(object, 'uOffsetX') ?? 0) + best[0];
    seen.wroteY = (value(object, 'uOffsetY') ?? 0) + best[1];
    setUniform(object, 'uOffsetX', seen.wroteX); setUniform(object, 'uOffsetY', seen.wroteY);
  }
  const drawn = rects.map(rs => rs.map(r => shiftRect(r, ...best)));
  placed?.push(drawn);
  return drawn;
}

/**
 * Cap one plate for this frame's eyes.
 *
 * @param objects the plate's text render objects, every line and layer
 * @param leaders render objects drawn with the plate (its leader), hidden with it
 * @param views this frame's XR views, in the coordinates the plates are drawn in
 * @param memory a WeakMap the caller keeps across frames
 * @param placed shared drawn rectangles for this frame, including existing UI glass
 * @param legend detached colour legends may move inboard
 * @param maxOffsetEm local site plates stay inside this authored cap
 * @param obstacles extra rectangles (e.g. a legend's molecular silhouette)
 * @returns {{ scale: number, clipped: boolean }}
 */
export function capPlateInEyes({ objects = [], leaders = [], views = [], cameraScale, memory, legend = false, maxOffsetEm, placed, obstacles = [], fixedAnchor = false }) {
  const texts = objects.filter(object => object?.type === 'text' && value(object, 'uSizeFactor') !== undefined
    && (value(object, 'alpha') ?? 1) > 0 && (object.state?.alphaFactor ?? 1) > 0
    && (object.state?.visible !== false || memory.get(object)?.hidden));
  if (!texts.length || !views.length || !(cameraScale > 0)) return { scale: 1, clipped: false };
  // Take back what this cap wrote; a value Mol* wrote since is the new build.
  for (const object of texts) {
    setUniform(object, 'uPlateBillboard', 1);
    const size = value(object, 'uSizeFactor'), offsetY = value(object, 'uOffsetY') ?? 0, offsetX = value(object, 'uOffsetX') ?? 0;
    const seen = memory.get(object);
    if (!seen) { memory.set(object, { size, offsetX, offsetY, wroteSize: size, wroteX: offsetX, wroteY: offsetY, hidden: false }); continue; }
    if (Math.abs(size - seen.wroteSize) > 1e-9) seen.size = size;
    if (Math.abs(offsetY - seen.wroteY) > 1e-9) seen.offsetY = offsetY;
    if (Math.abs(offsetX - seen.wroteX) > 1e-9) seen.offsetX = offsetX;
    setUniform(object, 'uSizeFactor', seen.size); setUniform(object, 'uOffsetY', seen.offsetY); setUniform(object, 'uOffsetX', seen.offsetX);
  }
  let degrees = 0;
  for (const view of views) for (const object of texts) degrees = Math.max(degrees, plateCharacterDegrees(object, view, cameraScale));
  const scale = degrees > PLATE_CHARACTER_CEILING_DEGREES
    ? // Small numerical headroom under the public two-degree ceiling.
    Math.tan(PLATE_CHARACTER_CEILING_DEGREES * .99 * DEGREES / 2) / Math.tan(degrees * DEGREES / 2) : 1;
  const ys = texts.map(object => memory.get(object).offsetY);
  const centreY = (Math.min(...ys) + Math.max(...ys)) / 2;
  for (const object of texts) {
    const seen = memory.get(object);
    seen.wroteSize = seen.size * scale; seen.wroteY = centreY + (seen.offsetY - centreY) * scale;
    setUniform(object, 'uSizeFactor', seen.wroteSize); setUniform(object, 'uOffsetY', seen.wroteY);
  }
  // A molecule-anchored figure label leaves the gaze naturally. Keep angular
  // sizing, but never move or hide its anchor merely to chase the current lens.
  let clipped = false;
  if (fixedAnchor) {
    const drawn = views.map(view => texts.map(object => eyeRect(object, view, cameraScale)).filter(Boolean));
    if (drawn.every(rects => rects.length)) placed?.push(drawn);
  } else clipped = !placeInEyes(texts, views, cameraScale, memory, { legend, maxOffsetEm, placed, obstacles });
  for (const object of [...texts, ...leaders]) {
    if (!object?.state) continue;
    const seen = memory.get(object) ?? (memory.set(object, { hidden: false }), memory.get(object));
    if (clipped && object.state.visible !== false) { object.state.visible = false; seen.hidden = true; }
    else if (!clipped && seen.hidden) { object.state.visible = true; seen.hidden = false; }
  }
  return { scale, clipped };
}

/** Restore retained figure plates on XR exit; fresh desktop primitives default
 * to the stock shader. Respect any intervening Mol* writes and visibility gate.
 */
export function releasePlateInEyes(object, memory, visible = true) {
  const seen = memory.get(object);
  const anchor = seen?.figureAnchor, positions = object?.values?.aPosition;
  if(anchor && positions?.ref.value===anchor.positions && positions.ref.version===anchor.version) {
    for(let i=0;i<anchor.original.length;i++)anchor.positions[i]=anchor.original[i];
    ValueCell.update(positions,anchor.positions);
    anchor.notify?.();
  }
  if (seen?.size !== undefined) for (const [name, built, wrote] of [
    ['uSizeFactor', seen.size, seen.wroteSize], ['uOffsetX', seen.offsetX, seen.wroteX], ['uOffsetY', seen.offsetY, seen.wroteY],
  ]) if (Math.abs(value(object, name) - wrote) < 1e-9) setUniform(object, name, built);
  if (seen?.hidden && visible && object.state) object.state.visible = true;
  setUniform(object, 'uPlateBillboard', 0);
  memory.delete(object);
}
