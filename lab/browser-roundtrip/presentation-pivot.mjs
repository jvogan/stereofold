import { clampPlacementTranslation } from './placement-limits.mjs';
// Where a turn pivots, and the placement that keeps it there.
//
// `viewer.mjs placementTransform` pivots every placement on the full
// structure's bounding-sphere centre, and stores the placement's travel in
// radii measured from that same centre. That centre is the right origin for a
// stored placement, because it does not move when an experience stage hides
// part of the assembly, so a view stays reusable across sources.
//
// It is the wrong thing to turn about. An experience stage draws a filtered
// subset (`experience-visibility.mjs`), and the subset's own centre can sit a
// radius away from the whole assembly's. Turning about the assembly centre
// then swings the only thing the wearer can see around a point that is not
// drawn, which reads as an offset, invisible centre of mass. The same gap is
// already modelled on the other side of a source swap, in
// `source-transition-anchor.mjs`, which is where `rotateZYX` below comes from.
//
// So the live transform turns about the drawn subset's centre, and a bake has
// to put the difference back into the stored travel, which is still measured
// from the assembly centre. `pivotPreservingTranslation` is that arithmetic.

const finiteVector = (value, name) => {
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) throw Error(`${name} must be three finite numbers.`);
  const copy = Array.from(value, Number);
  if (copy.length !== 3 || !copy.every(Number.isFinite)) throw Error(`${name} must be three finite numbers.`);
  return copy;
};
const finiteScale = (value, name) => {
  if (!Number.isFinite(value) || value <= 0) throw Error(`${name} must be a positive number.`);
  return value;
};

/** Matches viewer.mjs `placementTransform`: z * y * x rotation on a uniform scale. */
function rotateZYX(vector, degrees) {
  const [xDegrees, yDegrees, zDegrees] = degrees.map(value => value * Math.PI / 180);
  const cx = Math.cos(xDegrees), sx = Math.sin(xDegrees);
  const cy = Math.cos(yDegrees), sy = Math.sin(yDegrees);
  const cz = Math.cos(zDegrees), sz = Math.sin(zDegrees);
  const x1 = vector[0], y1 = cx * vector[1] - sx * vector[2], z1 = sx * vector[1] + cx * vector[2];
  const x2 = cy * x1 + sy * z1, y2 = y1, z2 = -sy * x1 + cy * z1;
  return [cz * x2 - sz * y2, sz * x2 + cz * y2, z2];
}

/**
 * The rendered offset from a placement's own pivot to the drawn centre.
 *
 * `placementTransform` puts the assembly centre at `center + translation *
 * radius` and maps every other model point through the same rotation and
 * uniform scale, so the drawn subset's centre lands exactly this far from it.
 * With no visible subset, or one centred on the assembly, this is zero and
 * every caller below reduces to what the viewer did before this module.
 *
 * @param {object} bounds `baseCenter` and `visibleCenter` in model Angstroms
 * @param {number[]} rotation the placement's ZYX degrees
 * @param {number} scale the placement's uniform scale
 * @returns {number[]} the offset in rendered units
 */
export function drawnCenterOffset({ baseCenter, visibleCenter }, rotation, scale) {
  const base = finiteVector(baseCenter, 'Base centre');
  const drawn = visibleCenter === undefined || visibleCenter === null ? base : finiteVector(visibleCenter, 'Visible centre');
  const factor = finiteScale(scale, 'Placement scale');
  const degrees = finiteVector(rotation, 'Placement rotation');
  return rotateZYX(drawn.map((value, axis) => (value - base[axis]) * factor), degrees);
}

/**
 * Where the drawn centre sits in the renderer's own frame.
 *
 * The whole point of the module: this must not change when only the rotation
 * changes. It is the same expression `source-transition-anchor.mjs` uses for
 * `oldVisibleRoomCenter`, so both sides of a source swap and both sides of a
 * bake are reading one model of the placement.
 */
export function drawnCenterInScene({ baseCenter, visibleCenter, radius, placement }) {
  const base = finiteVector(baseCenter, 'Base centre');
  const span = finiteScale(radius, 'Molecular radius');
  const travel = finiteVector(placement?.translation, 'Placement translation');
  const offset = drawnCenterOffset({ baseCenter, visibleCenter }, placement?.rotation, placement?.scale);
  return base.map((value, axis) => value + travel[axis] * span + offset[axis]);
}

/**
 * The travel, in radii, that leaves the drawn centre where the wearer sees it.
 *
 * A grip or a stick turns and resizes about the drawn centre and then travels
 * by `sceneTravel`, so the drawn centre only ever moves by that travel. The
 * saved placement measures travel from the assembly centre instead, and its
 * pivot offset changes with the rotation and the scale, so the bake carries
 * the difference between the offset the wearer was looking at and the one the
 * new placement will have. When there is no visible subset both offsets are
 * zero and this is the plain addition the viewer did before.
 *
 * @param {object} bounds `baseCenter`, `visibleCenter` and `radius`
 * @param {object} prior the placement the turn started from
 * @param {object} next the `rotation` and `scale` the bake is about to store
 * @param {number[]} [sceneTravel] the transient travel in rendered units
 * @returns {number[]} the next translation, in radii, bounded by the shared numerical range
 */
export function pivotPreservingTranslation({ baseCenter, visibleCenter, radius }, prior, next, sceneTravel) {
  const span = finiteScale(radius, 'Molecular radius');
  const travel = finiteVector(prior?.translation, 'Prior translation');
  const moved = sceneTravel === undefined || sceneTravel === null ? [0, 0, 0] : finiteVector(sceneTravel, 'Scene travel');
  const before = drawnCenterOffset({ baseCenter, visibleCenter }, prior?.rotation, prior?.scale);
  const after = drawnCenterOffset({ baseCenter, visibleCenter }, next?.rotation, next?.scale);
  return travel.map((value, axis) =>
    clampPlacementTranslation(value + (moved[axis] + before[axis] - after[axis]) / span));
}
