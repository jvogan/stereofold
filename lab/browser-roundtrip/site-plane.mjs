/**
 * The plane a lesson names for a site close-up (`viewPlane`), from its atoms.
 * No imports: the lesson validator and the viewer share it.
 */

/** Root-mean-square spread a plane's atoms need in each of two directions. */
export const MIN_PLANE_SPREAD_ANGSTROM = .5;

const finite3 = value => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);

/** Eigenvalues (ascending) and unit eigenvectors of a symmetric 3x3 matrix, by Jacobi rotations. */
function symmetricEigen(input) {
  const a = input.map(row => [...row]), v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    if (off < 1e-12) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(a[p][q]) < 1e-15) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k][p], akq = a[k][q];
        a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p][k], aqk = a[q][k];
        a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p], vkq = v[k][q];
        v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq;
      }
    }
  }
  return [0, 1, 2].map(i => ({ value: a[i][i], vector: [v[0][i], v[1][i], v[2][i]] }))
    .sort((x, y) => x.value - y.value);
}

/**
 * The least-squares plane of some atoms: its centre and unit normal, or
 * undefined when they do not span a plane (fewer than three, or all close to
 * one line).
 */
export function planeOf(points) {
  const list = (Array.isArray(points) ? points : []).filter(finite3);
  if (list.length < 3) return undefined;
  const centre = [0, 1, 2].map(k => list.reduce((sum, point) => sum + point[k], 0) / list.length);
  const covariance = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const point of list) {
    const d = [point[0] - centre[0], point[1] - centre[1], point[2] - centre[2]];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) covariance[i][j] += d[i] * d[j];
  }
  const [least, middle] = symmetricEigen(covariance);
  if (!(Math.sqrt(Math.max(0, middle.value) / list.length) >= MIN_PLANE_SPREAD_ANGSTROM)) return undefined;
  const m = Math.hypot(...least.vector);
  return m > 1e-9 ? { centre, normal: least.vector.map(value => value / m) } : undefined;
}
