/** Conservative, read-only proof for full rendered instance bounds in eye metres. */
export function rightFrustumSphereSeparation(
  spheres: Array<{ center: number[]; radius: number }>, projection: ArrayLike<number>,
) {
  if (!spheres.length || projection.length !== 16 || !Array.from(projection).every(Number.isFinite))
    throw Error('Frustum separation requires nonempty spheres and a finite projection.');
  // WebXR matrices are column-major. Positive clip x - clip w is outside
  // the right plane; subtracting the support radius covers every triangle
  // and impostor inside the instance sphere, including frustum crossings.
  const plane = [projection[0] - projection[3], projection[4] - projection[7],
    projection[8] - projection[11], projection[12] - projection[15]];
  const norm = Math.hypot(...plane.slice(0, 3));
  if (!(norm > 0) || !Number.isFinite(norm)) throw Error('Invalid right frustum plane.');
  let minimumRightPlaneMargin = Infinity, nearestDepthMeters = Infinity;
  for (const { center, radius } of spheres) {
    if (center.length !== 3 || !center.every(Number.isFinite) || !(radius > 0) || !Number.isFinite(radius))
      throw Error('Frustum separation requires finite nonzero rendered sphere bounds.');
    minimumRightPlaneMargin = Math.min(minimumRightPlaneMargin,
      plane[0] * center[0] + plane[1] * center[1] + plane[2] * center[2] + plane[3] - radius * norm);
    nearestDepthMeters = Math.min(nearestDepthMeters, -center[2] - radius);
  }
  if (![minimumRightPlaneMargin, nearestDepthMeters].every(Number.isFinite)) throw Error('Nonfinite frustum separation.');
  return { sphereCount: spheres.length, minimumRightPlaneMargin, nearestDepthMeters };
}
