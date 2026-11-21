import { Mat3, Mat4, Quat, Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { focusRotation, growthTurnDurationMs, placementDegrees } from './focus-placement.mjs';
import { viewBasis } from './plate-standoff.mjs';
import { planeOf } from './site-plane.mjs';

/**
 * How far out of a site's plane its close-up is seen from, in degrees.
 *
 * Edge-on (0) hides the ring and puts an in-plane atom behind the ring's near
 * edge; face-on (90) hides any shift out of the plane. At 30 degrees the ring
 * reads as a tilted disc, a shift along its normal still shows at
 * cos 30 = 0.87 of its length, and so does a bond along the normal.
 */
export const SITE_VIEW_ELEVATION_DEGREES = 30;
/** Azimuths tried around the plane's normal. */
const AZIMUTH_STEPS = 360;
/** Views within this much of the best shortest dash are equally good. */
const SCORE_TOLERANCE = .01;
/** Of those, views that set the two closest labelled atoms at least this share of the widest apart. */
const SPREAD_SHARE = .9;
const finite3 = value => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = v => { const m = Math.hypot(v[0], v[1], v[2]); return m > 1e-9 ? [v[0] / m, v[1] / m, v[2] / m] : undefined; };

/**
 * The directions a site close-up may be seen from, in the structure's frame.
 *
 * The site's plane (`planePoints`, the atoms a lesson names in `viewPlane`) is
 * seen from `elevationDegrees` out of the plane, on the side of the figure's
 * distances (`distances`, pairs of atom positions; the side `towardEye`
 * already faces when there are none or they lie in the plane). Of the
 * directions round the normal it keeps those that draw the figure's shortest
 * dash within `SCORE_TOLERANCE` of the longest it can be, and of those the
 * ones that set the two closest labelled atoms (`labelPoints`, one point per
 * label) at least `SPREAD_SHARE` as far apart on screen as any, so two
 * labelled atoms side by side are not drawn one behind the other. Each comes twice,
 * with the plane's normal pointing up the screen one way or the other, so the
 * plane always reads as a level disc and a shift out of it reads as up or
 * down; `nearestView` picks the one the structure turns least to reach.
 *
 * Returns undefined when the atoms span no plane or `towardEye` is unknown.
 */
export function siteView({ planePoints, distances = [], labelPoints = [], towardEye, elevationDegrees = SITE_VIEW_ELEVATION_DEGREES } = {}) {
  const plane = planeOf(planePoints);
  const eye = finite3(towardEye) ? unit(towardEye) : undefined;
  if (!plane || !eye) return undefined;
  const pairs = (Array.isArray(distances) ? distances : [])
    .filter(pair => Array.isArray(pair) && finite3(pair[0]) && finite3(pair[1]))
    .map(([a, b]) => ({ direction: unit([b[0] - a[0], b[1] - a[1], b[2] - a[2]]), middle: [0, 1, 2].map(k => (a[k] + b[k]) / 2) }))
    .filter(pair => pair.direction);
  const side = pairs.reduce((sum, pair) => sum + dot([0, 1, 2].map(k => pair.middle[k] - plane.centre[k]), plane.normal), 0);
  const sign = Math.abs(side) > .1 ? Math.sign(side) : (dot(eye, plane.normal) < 0 ? -1 : 1);
  const normal = plane.normal.map(value => value * sign);
  const across = unit(cross(normal, Math.abs(normal[0]) < .9 ? [1, 0, 0] : [0, 1, 0]));
  const across2 = cross(normal, across);
  const elevation = Math.min(89, Math.max(1, Number.isFinite(elevationDegrees) ? elevationDegrees : SITE_VIEW_ELEVATION_DEGREES)) * Math.PI / 180;
  const shown = view => pairs.map(pair => Math.sqrt(Math.max(0, 1 - dot(pair.direction, view) ** 2)));
  const labels = (Array.isArray(labelPoints) ? labelPoints : []).filter(finite3);
  const spread = view => {
    let least = Infinity;
    for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
      const d = [0, 1, 2].map(k => labels[j][k] - labels[i][k]), along = dot(d, view);
      least = Math.min(least, Math.sqrt(Math.max(0, dot(d, d) - along * along)));
    }
    return Number.isFinite(least) ? least : 0;
  };
  const candidates = [];
  for (let step = 0; step < AZIMUTH_STEPS; step++) {
    const azimuth = 2 * Math.PI * step / AZIMUTH_STEPS;
    const toEye = [0, 1, 2].map(k => Math.cos(elevation) * (Math.cos(azimuth) * across[k] + Math.sin(azimuth) * across2[k])
      + Math.sin(elevation) * normal[k]);
    const fractions = shown(toEye);
    candidates.push({ toEye, fractions, score: fractions.length ? Math.min(...fractions) : 1 });
  }
  const best = Math.max(...candidates.map(candidate => candidate.score));
  const readable = candidates.filter(candidate => candidate.score >= best - SCORE_TOLERANCE)
    .map(candidate => ({ ...candidate, spread: spread(candidate.toEye) }));
  const widest = Math.max(...readable.map(candidate => candidate.spread));
  const views = readable.filter(candidate => candidate.spread >= widest * SPREAD_SHARE).flatMap(({ toEye, fractions }) => {
    const up = unit(normal.map((value, k) => value - Math.sin(elevation) * toEye[k]));
    return [{ toEye, up, dashFractions: fractions }, { toEye, up: up.map(value => -value), dashFractions: fractions }];
  });
  return { views, normal, centre: plane.centre, elevationDegrees: elevation * 180 / Math.PI };
}

/** The rotation from the structure's frame to an eye frame (x right, y up, z toward the eye) that sees `view`. */
export function eyeFrame({ toEye, up }) {
  const v = unit(toEye), w = unit(up.map((value, k) => value - dot(up, v) * v[k])), r = cross(w, v);
  const frame = Mat4.identity();
  for (let j = 0; j < 3; j++) { frame[j * 4] = r[j]; frame[j * 4 + 1] = w[j]; frame[j * 4 + 2] = v[j]; }
  return frame;
}

/** The view a structure standing at `structureToEye` (Mat4, structure frame to eye frame) turns least to reach. */
export function nearestView(views, structureToEye) {
  let best;
  for (const view of views ?? []) {
    const turn = turnBetween(structureToEye, eyeFrame(view));
    if (!best || turn.angleRadians < best.angle) best = { view, angle: turn.angleRadians };
  }
  return best?.view;
}

/**
 * Below this a site turn is not travelled. Much finer than the growth turn's
 * `GROWTH_SNAP_DEGREES`, so the view a lesson promises is the view drawn.
 */
export const SITE_SNAP_DEGREES = 1;

/** One rotation, `current` to `wanted` (both Mat4), as the shortest axis and angle the travel can ease. */
function turnBetween(current, wanted) {
  const delta = Mat4.mul(Mat4(), wanted, Mat4.transpose(Mat4(), current));
  const q = Quat.fromMat3(Quat(), Mat3.fromMat4(Mat3(), delta));
  Quat.normalize(q, q);
  const axis = Vec3();
  let angle = Quat.getAxisAngle(axis, q);
  if (angle > Math.PI) { angle = 2 * Math.PI - angle; Vec3.negate(axis, axis); }
  if (!(Vec3.magnitude(axis) > 1e-9) || !Number.isFinite(angle)) { angle = 0; Vec3.set(axis, 0, 1, 0); }
  const deltaDegrees = angle * 180 / Math.PI;
  return { rotation: placementDegrees(wanted), axis: Array.from(Vec3.normalize(axis, axis)), angleRadians: angle, deltaDegrees,
    turned: deltaDegrees >= SITE_SNAP_DEGREES, durationMs: growthTurnDurationMs(deltaDegrees) };
}

/**
 * The placement turn that shows a site close-up from one of its `siteView`
 * views, for this wearer, in the shape the focus travel eases
 * (`obliqueGrowthTurn`'s), plus the `view` it chose.
 *
 * The structure is turned so the view's `toEye` points back along the level
 * head's forward axis and its `up` stands up in the room, both carried into
 * the renderer's frame by `renderFromRoom`, the frame the placement rotation
 * composes in. Of the views it takes the one reached by the smallest turn.
 * Returns undefined without a level head direction.
 */
export function siteViewTurn({ headInRoom, renderFromRoom, placement, views } = {}) {
  if (headInRoom?.length !== 16 || renderFromRoom?.length !== 16 || !views?.length
    || placement?.rotation?.length !== 3 || !placement.rotation.every(Number.isFinite)) return undefined;
  const ahead = [-headInRoom[8], 0, -headInRoom[10]];
  if (Math.hypot(ahead[0], ahead[2]) < .01) return undefined;
  const basis = viewBasis(ahead);
  const intoRender = axis => unit(Array.from(Vec3.transformDirection(Vec3(), Vec3.create(...axis), renderFromRoom)));
  const right = intoRender(basis.right), upward = intoRender(basis.up), back = intoRender(basis.forward.map(v => -v));
  if (!right || !upward || !back) return undefined;
  // The eye frame's axes in the renderer's frame, as the columns of one rotation.
  const eyeToRender = Mat4.identity();
  for (let i = 0; i < 3; i++) { eyeToRender[i] = right[i]; eyeToRender[4 + i] = upward[i]; eyeToRender[8 + i] = back[i]; }
  const current = focusRotation(placement.rotation);
  const view = nearestView(views, Mat4.mul(Mat4(), Mat4.transpose(Mat4(), eyeToRender), current));
  if (!view) return undefined;
  return { ...turnBetween(current, Mat4.mul(Mat4(), eyeToRender, eyeFrame(view))), view };
}

/** The turn from the placement rotation the structure stands in back to `rotation` (ZYX degrees). */
export function rotationTurn({ placement, rotation } = {}) {
  if (placement?.rotation?.length !== 3 || !placement.rotation.every(Number.isFinite)
    || rotation?.length !== 3 || !rotation.every(Number.isFinite)) return undefined;
  return turnBetween(focusRotation(placement.rotation), focusRotation(rotation));
}

/** Whether two placement rotations (ZYX degrees) are the same turn. */
export function sameRotation(a, b) {
  if (a?.length !== 3 || b?.length !== 3) return false;
  const turn = rotationTurn({ placement: { rotation: a }, rotation: b });
  return Boolean(turn) && turn.deltaDegrees < .05;
}

/**
 * The figure atoms a site view is solved from, in assembly coordinates: the
 * `viewPlane` atoms, the two ends of each distance and each label's anchor. `matchesRow` is the
 * figure's own residue match; an `atomName` keeps only that atom.
 */
export function siteViewAtoms({ rows, figure, matchesRow }) {
  const points = target => (rows ?? []).filter(row => matchesRow(target, row))
    .flatMap(row => (row.atomSites ?? []).filter(site => !target.atomName || site.identity?.atomName === target.atomName))
    .map(site => site.assemblyCoordinatesAngstrom).filter(finite3);
  const planePoints = (figure?.viewPlane ?? []).flatMap(points);
  const distances = (figure?.distances ?? []).map(distance => [points(distance.a)[0], points(distance.b)[0]])
    .filter(pair => pair[0] && pair[1]);
  const labelPoints = (figure?.labels ?? []).map(label => points(label.target)).filter(list => list.length)
    .map(list => [0, 1, 2].map(k => list.reduce((sum, point) => sum + point[k], 0) / list.length));
  return { planePoints, distances, labelPoints };
}
