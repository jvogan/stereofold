import { calculateTransformBoundingSphere } from 'molstar/lib/mol-gl/renderable/util.js';
import { Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { Sphere3D } from 'molstar/lib/mol-math/geometry/primitives/sphere3d.js';
import { ValueCell } from 'molstar/lib/mol-util/value-cell.js';

// Upper bound on the largest singular value of the linear transform: the
// largest absolute row sum of A^T A bounds its largest eigenvalue. This is the
// usual maximum axis scale for orthogonal axes, and also encloses sheared
// spheres when an extra nonuniform scale is composed with an instance rotation.
function radiusScale(a, i) {
  const xx = a[i] ** 2 + a[i + 1] ** 2 + a[i + 2] ** 2;
  const yy = a[i + 4] ** 2 + a[i + 5] ** 2 + a[i + 6] ** 2;
  const zz = a[i + 8] ** 2 + a[i + 9] ** 2 + a[i + 10] ** 2;
  const xy = Math.abs(a[i] * a[i + 4] + a[i + 1] * a[i + 5] + a[i + 2] * a[i + 6]);
  const xz = Math.abs(a[i] * a[i + 8] + a[i + 1] * a[i + 9] + a[i + 2] * a[i + 10]);
  const yz = Math.abs(a[i + 4] * a[i + 8] + a[i + 5] * a[i + 9] + a[i + 6] * a[i + 10]);
  return Math.sqrt(Math.max(xx + xy + xz, yy + xy + yz, zz + xz + yz));
}

// Pick the centre of the spheres' axis-aligned bounds, then measure the farthest
// centre distance + radius. Extrema of the original mesh are deliberately not
// used: they do not necessarily enclose the full invariant sphere or its padding.
function encloseSpheres(spheres, start, end, indices) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let j = start; j < end; j++) {
    const i = (indices ? indices[j] : j) * 4, r = spheres[i + 3];
    minX = Math.min(minX, spheres[i] - r); maxX = Math.max(maxX, spheres[i] + r);
    minY = Math.min(minY, spheres[i + 1] - r); maxY = Math.max(maxY, spheres[i + 1] + r);
    minZ = Math.min(minZ, spheres[i + 2] - r); maxZ = Math.max(maxZ, spheres[i + 2] + r);
  }
  const center = Vec3.create((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
  let radius = 0;
  for (let j = start; j < end; j++) {
    const i = (indices ? indices[j] : j) * 4;
    radius = Math.max(radius, Math.hypot(spheres[i] - center[0], spheres[i + 1] - center[1],
      spheres[i + 2] - center[2]) + spheres[i + 3]);
  }
  return Sphere3D.create(center, radius);
}

function writeGridSphere(array, index, sphere) {
  const i = index * 4;
  Sphere3D.toArray(sphere, array, i);
  // Grid bounds are Float32: cover centre rounding and round the radius up.
  const radius = sphere.radius + Math.hypot(array[i] - sphere.center[0],
    array[i + 1] - sphere.center[1], array[i + 2] - sphere.center[2]);
  array[i + 3] = radius;
  if (array[i + 3] < radius) array[i + 3] = radius + Math.max(2 ** -149, radius * 2 ** -23);
}

/**
 * Repair Mol* 5.11's Visual.setTransform bounds after a representation moves.
 * That path uses raw instance transforms, omitting the placement matrix and
 * extra transforms already composed into aTransform. The renderer culls each
 * render object (including individual cartoon chains) against this sphere.
 *
 * Run after setState({ transform }) and before canvas.update(repr, false).
 * The renderer reads the cell directly; the canvas update also invalidates
 * aggregate scene bounds and uploads the changed transform attributes. This
 * belongs to placement/rebuild work, never to an idle head-frame callback.
 */
export function updatePlacementBounds(repr) {
  for (const { values } of repr.renderObjects) {
    const { boundingSphere, invariantBoundingSphere, aTransform, instanceCount } = values;
    const invariant = invariantBoundingSphere.ref.value, transforms = aTransform.ref.value;
    const count = instanceCount.ref.value, grid = values.instanceGrid?.ref.value;
    let spheres;
    if (count > 1 || (count > 0 && grid?.cellSize > 0)) {
      spheres = new Float64Array(count * 4);
      for (let i = 0; i < count; i++) {
        Vec3.transformMat4Offset(spheres, invariant.center, transforms, i * 4, 0, i * 16);
        spheres[i * 4 + 3] = invariant.radius * radiusScale(transforms, i * 16);
      }
    }
    // Retain the stock single-instance result, including its extrema. Its
    // max-axis radius is sufficient for the rigid source operators and uniform
    // placement scale, but an extra nonuniform transform can shear those axes.
    // Mol*'s multi-instance radius branch assumes rigid transforms; placement
    // scaling violates that assumption even when aTransform has the right data.
    const sphere = count > 1 ? encloseSpheres(spheres, 0, count)
      : calculateTransformBoundingSphere(invariant, transforms, count, 0);
    if (count === 1 && values.hasExtraTransform?.ref.value) {
      sphere.radius = Math.max(sphere.radius, invariant.radius * radiusScale(transforms, 0));
    }
    ValueCell.update(boundingSphere, sphere);

    // Renderer.cull uses these at camera.scale === 1 (including desktop); XR
    // normally uses a molecular-to-room scale and bypasses the grid. Reuse its
    // existing instance ordering and membership, repairing only culling bounds.
    if (count > 0 && grid?.cellSize > 0) {
      const cellSpheres = grid.cellSpheres.slice(), batchSpheres = grid.batchSpheres.slice();
      for (let i = 0; i < grid.cellCount; i++) {
        writeGridSphere(cellSpheres, i, encloseSpheres(spheres, grid.cellOffsets[i], grid.cellOffsets[i + 1]));
      }
      for (let i = 0; i < grid.batchCount; i++) {
        writeGridSphere(batchSpheres, i, encloseSpheres(cellSpheres,
          grid.batchOffsets[i], grid.batchOffsets[i + 1], grid.batchCell));
      }
      ValueCell.update(values.instanceGrid, { ...grid, cellSpheres, batchSpheres });
    }
  }
}
