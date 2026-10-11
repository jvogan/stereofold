/** Companion placement is centered on its own boundary, then travels with the
 * primary transform. Translation uses primary molecular radii. */
export function companionTransform(Mat4, Vec3, primaryTransform, primarySphere, companionSphere, placement) {
  const rotations = [[1,0,0],[0,1,0],[0,0,1]].map((axis,i) =>
    Mat4.fromRotation(Mat4(), placement.rotation[i] * Math.PI / 180, Vec3.create(...axis)));
  const rotation = Mat4.mul(Mat4(), rotations[2], Mat4.mul(Mat4(), rotations[1], rotations[0]));
  const scaled = Mat4.mul(Mat4(), rotation, Mat4.fromScaling(Mat4(), Vec3.create(placement.scale,placement.scale,placement.scale)));
  const center = primarySphere.center.map((v,i) => v + placement.translation[i] * primarySphere.radius);
  const local = Mat4.mul3(Mat4(), Mat4.fromTranslation(Mat4(), Vec3.create(...center)), scaled,
    Mat4.fromTranslation(Mat4(), Vec3.negate(Vec3(), companionSphere.center)));
  return Mat4.mul(Mat4(), primaryTransform, local);
}

export function foldCompanion(prior, patch) {
  if (patch.remove) return undefined;
  if (patch.source) return structuredClone(patch);
  if (!prior) throw Error('Add a comparison source before editing it.');
  return { ...structuredClone(prior), placement: { ...prior.placement, ...patch.placement },
    appearance: { ...prior.appearance, ...patch.appearance } };
}
