import { describe, expect, it } from 'vitest';
import { Mat4, Quat, Vec3 } from 'molstar/lib/mol-math/linear-algebra';
import { xrToolbarControllerPose } from '../scripts/xr-toolbar-controller-pose.js';

const matrix = (position: number[], yaw: number) => Mat4.compose(Mat4(), Vec3.create(...position as [number, number, number]),
  Quat.setAxisAngle(Quat(), Vec3.create(0, 1, 0), yaw * Math.PI / 180), Vec3.create(1, 1, 1));
const object = (p: ArrayLike<number>) => ({ x: p[0], y: p[1], z: p[2] });
describe('measured toolbar controller mapping', () => {
  it.each([
    { name: 'default entry', head: [0, 1.6, 0], yaw: 0, reference: [0, 1.6, 0], referenceYaw: 0 },
    { name: 'off-axis entry retaining room yaw and translation', head: [1.2, .1, -.8], yaw: 35, reference: [0, 1.6, 0], referenceYaw: 0 },
    { name: 'local space rebased to the entry head', head: [1.2, .1, -.8], yaw: 35, reference: [1.2, .1, -.8], referenceYaw: 35 },
    { name: 'head moved after entry', head: [-.4, 1.5, .8], yaw: -60, reference: [1.2, .1, -.8], referenceYaw: 35 },
  ])('$name aims through the published room point', ({ head, yaw, reference, referenceYaw }) => {
    const deviceFromViewer = matrix(head, yaw), deviceFromRoom = matrix(reference, referenceYaw);
    const viewerFromRoom = Mat4.mul(Mat4(), Mat4.invert(Mat4(), deviceFromViewer), deviceFromRoom);
    const rotation = Quat.setAxisAngle(Quat(), Vec3.create(0, 1, 0), yaw * Math.PI / 180);
    const target = { x: .00037780590259395286, y: -1.460921052631579, z: -1.4191982653293471 };
    const result = xrToolbarControllerPose(target, Array.from(viewerFromRoom), {
      position: object(head), quaternion: { ...object(rotation), w: rotation[3] },
    });
    const expectedTarget = Vec3.transformMat4(Vec3(), Vec3.create(target.x, target.y, target.z), deviceFromRoom);
    for (const axis of ['x', 'y', 'z'] as const) expect(result.deviceTarget[axis]).toBeCloseTo(object(expectedTarget)[axis], 10);
    // Independently transform the injected device ray back into the actual
    // reference frame and prove that it intersects the original point.
    const roomFromDevice = Mat4.invert(Mat4(), deviceFromRoom);
    const tip = Vec3.create(result.position.x + result.direction.x * .3,
      result.position.y + result.direction.y * .3, result.position.z + result.direction.z * .3);
    const observed = Vec3.transformMat4(Vec3(), tip, roomFromDevice);
    for (const axis of ['x', 'y', 'z'] as const) expect(object(observed)[axis]).toBeCloseTo(target[axis], 10);
  });
});
