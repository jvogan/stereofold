import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { focusRotation } from './focus-placement.mjs';

/**
 * The direction from a framed subject toward the wearer, in the structure's
 * own frame: the reverse of the head's level forward axis, carried out of the
 * room and the saved placement rotation the way the focus solver measures its
 * lens. Undefined when the wearer looks straight up or down.
 */
export function towardWearer({ headInRoom, renderFromRoom, rotation } = {}) {
  if (!Array.isArray(headInRoom) || !Array.isArray(renderFromRoom)) return undefined;
  const forward = Vec3.create(-headInRoom[8], 0, -headInRoom[10]);
  if (!(Vec3.magnitude(forward) >= .01)) return undefined;
  Vec3.normalize(forward, forward);
  Vec3.transformDirection(forward, forward, renderFromRoom);
  Vec3.transformDirection(forward, forward, Mat4.transpose(Mat4(), focusRotation(rotation ?? [0, 0, 0])));
  Vec3.normalize(forward, forward);
  return [-forward[0], -forward[1], -forward[2]];
}

/**
 * The shown residues a headset close-up draws around its focus.
 *
 * A site close-up is framed large, so the chains around the site would reach
 * past the wearer and cover the site itself. It keeps the shown residues with
 * an atom within `radius` angstroms of a focus atom, less any residue with an
 * atom nearer the wearer than the focus's own nearest atom; the rest of the
 * shown chains is left out of the chapter. A residue the figure itself names
 * (`namedKeys`: a layer, label or distance target) always stays, so no layer
 * or plate outlives its residue. Atom coordinates are the catalog's assembly
 * coordinates, the frame the structure is drawn in.
 *
 * @returns {{ kept: string[], hidden: string[] } | undefined} undefined when no
 * focus atom is modelled or the wearer's direction is unknown.
 */
export function closeUpContext({ rows, shownKeys, focusKeys, namedKeys = [], radius, towardEye }) {
  if (!(radius > 0) || !Array.isArray(towardEye) || !towardEye.every(Number.isFinite)) return undefined;
  const byKey = new Map((rows ?? []).map(row => [row.key, row]));
  const points = key => (byKey.get(key)?.atomSites ?? []).map(site => site.assemblyCoordinatesAngstrom)
    .filter(point => Array.isArray(point) && point.length === 3 && point.every(Number.isFinite));
  const focus = [...new Set(focusKeys ?? [])].flatMap(points);
  if (!focus.length) return undefined;
  const depth = point => point[0] * towardEye[0] + point[1] * towardEye[1] + point[2] * towardEye[2];
  let front = -Infinity;
  for (const point of focus) front = Math.max(front, depth(point));
  // Bucket the focus atoms by cells one radius wide, so a residue asks only
  // the neighbouring cells rather than every focus atom.
  const cell = point => point.map(v => Math.floor(v / radius));
  const grid = new Map();
  for (const point of focus) {
    const id = cell(point).join(',');
    if (!grid.has(id)) grid.set(id, []);
    grid.get(id).push(point);
  }
  const radiusSquared = radius * radius;
  const near = point => {
    const [x, y, z] = cell(point);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) {
      for (const other of grid.get(`${x + i},${y + j},${z + k}`) ?? []) {
        const dx = point[0] - other[0], dy = point[1] - other[1], dz = point[2] - other[2];
        if (dx * dx + dy * dy + dz * dz <= radiusSquared) return true;
      }
    }
    return false;
  };
  const kept = [], hidden = [], named = new Set(namedKeys);
  for (const key of new Set(shownKeys ?? [])) {
    const atoms = points(key);
    const keep = named.has(key) || atoms.length > 0 && atoms.some(near) && atoms.every(point => depth(point) <= front + 1e-6);
    (keep ? kept : hidden).push(key);
  }
  return { kept, hidden };
}
