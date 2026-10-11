import assert from 'node:assert/strict';
import { test } from 'node:test';
import { roomPlacement } from './room-placement.mjs';
import { placementFromRoom } from './room-anchor.mjs';

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const frame = { renderFromRoom: identity, cameraScale: 1, center: [0, 0, 0], radius: 1 };
const head = (yaw, height = 1.6) => {
  const a = yaw * Math.PI / 180;
  return [Math.cos(a), 0, -Math.sin(a), 0, 0, 1, 0, 0, Math.sin(a), 0, Math.cos(a), 0, 2, height, 3, 1];
};
const elevation = (point, pose) => Math.atan2(point[1] - pose[13], Math.hypot(point[0] - pose[12], point[2] - pose[14])) * 180 / Math.PI;

test('Above us is forward at 65 degrees for either facing, preserving height and size', () => {
  for (const yaw of [0, 90, -90, 180]) {
    const pose = head(yaw);
    const placed = roomPlacement({ ...frame, headInRoom: pose, target: 'overhead' });
    assert.ok(Math.abs(elevation(placed.translation, pose) - 65) < 1e-9);
    assert.equal(placed.translation[1], 4.6);
    assert.equal(placed.scale, 2);
    const delta = [placed.translation[0] - pose[12], placed.translation[2] - pose[14]];
    assert.ok(delta[0] * -pose[8] + delta[1] * -pose[10] > 0);
  }
});

test('floor-anchored Above us preserves its floor height and size for seated or standing users', () => {
  for (const height of [1.0, 1.6, 2.0]) {
    const pose = head(37, height);
    const placed = placementFromRoom({ ...frame, headInRoom: pose, mode: 'overhead', floorY: 0 });
    assert.equal(placed.floorLocked, true);
    assert.equal(placed.roomPoint[1], 4.2);
    assert.equal(placed.metersAcross, 4);
    assert.equal(placed.scale, 2);
    assert.ok(Math.abs(elevation(placed.roomPoint, pose) - 65) < 1e-9);
  }
});

test('floorless anchored Above us and its direct route agree on the room point', () => {
  const pose = head(-32);
  const direct = roomPlacement({ ...frame, headInRoom: pose, target: 'overhead' });
  const anchored = placementFromRoom({ ...frame, headInRoom: pose, mode: 'overhead' });
  assert.deepEqual(anchored.translation, direct.translation);
  assert.equal(anchored.scale, direct.scale);
  assert.equal(anchored.floorLocked, false);
});
