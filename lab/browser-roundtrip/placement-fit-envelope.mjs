// Shared physical limits for the page fitter and host receipt consistency check.
// Keep this module pure and independent of the renderer and plugin runtime.
export const ENTRY_STANDOFF_RANGE = Object.freeze({ min: 1, max: 4 });
export const HALF_IPD_METERS = .032;
export const EYE_HALF_FIELD_DEGREES = 42;
export const SUBJECT_CENTRE_LENS = .15;
export const SUBJECT_CENTRE_TANGENT = Math.floor(
  SUBJECT_CENTRE_LENS * Math.tan(EYE_HALF_FIELD_DEGREES * Math.PI / 180) * 10000) / 10000;

/**
 * Page evidence is an attestation. This bounds consistency on an honest page;
 * it does not independently measure the scene, prove menu clearance, or defend
 * against a lying page that forges the unit, centre or tracked basis. The page's
 * stereo solver proves clearance; the host checks the attested repair envelope.
 */
export function placementFitWithinEnvelope(requested, actual, evidence) {
  if (!evidence) return false;
  const { metersPerRadius: unit, centerMeters: center, headFromScene: m } = evidence;
  if (!(unit > 0) || !Number.isFinite(unit) || center?.length !== 3 || !center.every(Number.isFinite)
    || m?.length !== 16 || !m.every(Number.isFinite)) return false;
  const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
  const axes = [m.slice(0, 3), m.slice(4, 7), m.slice(8, 11)];
  const epsilon = 1e-5;
  if (axes.some(axis => Math.abs(dot(axis, axis) - 1) > epsilon)
    || Math.abs(dot(axes[0], axes[1])) > epsilon || Math.abs(dot(axes[0], axes[2])) > epsilon
    || Math.abs(dot(axes[1], axes[2])) > epsilon
    // Inverting/multiplying rigid tracked matrices does not preserve the
    // homogeneous row bit-for-bit (e.g. w = 1.0000000000000002). Use the
    // same rigidity tolerance as the axes, without changing any travel bound.
    || Math.abs(m[3]) > epsilon || Math.abs(m[7]) > epsilon
    || Math.abs(m[11]) > epsilon || Math.abs(m[15] - 1) > epsilon) return false;
  const head = placement => {
    const v = placement.translation.map((x, i) => center[i] + x * unit);
    return [0, 1, 2].map(i => m[i] * v[0] + m[i + 4] * v[1] + m[i + 8] * v[2] + m[i + 12]);
  };
  const from = head(requested), to = head(actual), depth = -to[2];
  const radius = unit * actual.scale, reach = ENTRY_STANDOFF_RANGE.max;
  // The rendered subset can be asymmetric about the loaded sphere's centre.
  // Allow its full radius, the centre band, and the per-eye offset.
  return depth > 0 && depth <= reach + epsilon
    && (Math.abs(to[2] - from[2]) <= epsilon || Math.abs(depth - reach) <= epsilon)
    && Math.abs(to[1] - from[1]) <= reach + epsilon
    && Math.abs(to[0]) <= SUBJECT_CENTRE_TANGENT * depth
      + (1 + SUBJECT_CENTRE_TANGENT) * radius + HALF_IPD_METERS + epsilon;
}
