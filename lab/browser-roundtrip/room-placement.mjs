import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { PLACEMENT_MAX_TRANSLATION, clampPlacementScale } from './placement-limits.mjs';
import { overheadRoomPoint } from './overhead-seat.mjs';

/** One session-local placement in the tracked room; never a head-following pose. */
export function roomPlacement({ headInRoom, renderFromRoom, cameraScale, center, radius, target }) {
  if (!['overhead', 'front'].includes(target) || headInRoom?.length !== 16 || renderFromRoom?.length !== 16
    || center?.length !== 3 || ![...headInRoom, ...renderFromRoom, ...center, cameraScale, radius].every(Number.isFinite)
    || cameraScale <= 0 || radius <= 0) throw Error('A current tracked room pose is required.');
  const point = Vec3.create(headInRoom[12], headInRoom[13], headInRoom[14]);
  if (target === 'overhead') {
    let forward = Vec3.create(-headInRoom[8], 0, -headInRoom[10]);
    if (Vec3.magnitude(forward) < .01) forward = Vec3.create(-headInRoom[4], 0, -headInRoom[6]);
    if (Vec3.magnitude(forward) < .01) forward = Vec3.create(0, 0, -1);
    Vec3.normalize(forward, forward);
    Vec3.copy(point, overheadRoomPoint(point, forward, point[1] + 3).point);
  }
  else {
    const forward = Vec3.create(-headInRoom[8], 0, -headInRoom[10]);
    if (Vec3.magnitude(forward) < .01) throw Error('Look ahead before bringing the structure in front of you.');
    Vec3.normalize(forward, forward);
    Vec3.scaleAndAdd(point, point, forward, 2);
  }
  Vec3.transformMat4(point, point, renderFromRoom);
  Vec3.scale(point, point, 1 / cameraScale);
  Vec3.sub(point, point, center);
  Vec3.scale(point, point, 1 / radius);
  if (Array.from(point).some(value => !Number.isFinite(value) || Math.abs(value) > PLACEMENT_MAX_TRANSLATION)) throw Error('That room position exceeds the renderer’s numerical range.');
  return { translation: Array.from(point), scale: clampPlacementScale((target === 'overhead' ? 4 : 1.6) / (2 * radius * cameraScale)) };
}
