import { PLATE_FIELD, PLATE_GAP_EM, plateHalfExtents, plateViewBasis,
  partsSilhouette, projectedSphereRect } from './label-layout.mjs';
import { PLACEMENT_MIN_SCALE } from './placement-limits.mjs';

/** Measure the same projected part discs and full-size plates as the solver. */
export function measurePlateSeat({ plates = [], subject, eye, target, up,
  characterUnits, measureText, field = PLATE_FIELD }) {
  const basis = plateViewBasis({ eye, target, up });
  const dot = (a, b) => a.reduce((sum, value, axis) => sum + value * b[axis], 0);
  const live = [];
  const band = { x: 0, y: 0 };
  for (const plate of plates) {
    const relative = plate.anchor.map((value, axis) => value - eye[axis]);
    const depth = dot(relative, basis.forward);
    if (!(depth > 0)) throw Error('A resting part must be in front of the eye.');
    const half = plateHalfExtents({ text: plate.text, characterUnits, measureText });
    const gap = PLATE_GAP_EM * characterUnits / depth;
    const reserve = 2 * half.halfHeight / depth + gap;
    band.x = Math.max(band.x, reserve);
    band.y = Math.max(band.y, reserve);
    live.push({ x: dot(relative, basis.right) / depth,
      y: dot(relative, basis.up) / depth, radius: plate.radius / depth });
  }
  const silhouette = partsSilhouette(live)
    ?? projectedSphereRect({ ...subject, eye, target, up });
  return plateSeatLimits({ silhouette, band, field });
}

/** Reserve one plate height plus air on BOTH sides, including the seat's rise. */
export function plateSeatLimits({ silhouette, band, field = PLATE_FIELD }) {
  const halfWidth = Math.max(0, field.halfWidth - band.x - Math.abs(silhouette.x));
  const halfHeight = Math.max(0, field.halfHeight - band.y - Math.abs(silhouette.y));
  const factor = Math.min(1, halfWidth / silhouette.halfWidth, halfHeight / silhouette.halfHeight);
  return { silhouette, band, halfWidth, halfHeight, factor,
    viewDegrees: 2 * Math.atan(silhouette.halfWidth) * 180 / Math.PI };
}

/** Largest legal scale at the existing seat; never enlarge a small subject.
 * Re-measure at each candidate: perspective depth and label gain change too.
 */
export function capPlateSeat(placement, measure) {
  const at = scale => measure({ ...placement, scale });
  let measured = at(placement.scale);
  if (measured.factor >= 1) return { ...placement, plateSeat: measured };
  let low = PLACEMENT_MIN_SCALE, high = placement.scale;
  if (at(low).factor < 1) throw Error('The resting plate field cannot fit at the minimum placement scale.');
  for (let step = 0; step < 40; step++) {
    const middle = (low + high) / 2;
    if (at(middle).factor >= 1) low = middle;
    else high = middle;
  }
  measured = at(low);
  return { ...placement, scale: low,
    metersAcross: placement.metersAcross * low / placement.scale, plateSeat: measured };
}
