import test from 'node:test';
import assert from 'node:assert/strict';
import { wearerAxesFrom, TRACKED_AXIS_MINIMUM } from './wearer-axes.mjs';

/** Column-major, so the columns read across in fours. */
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
/** A head yawed by `degrees` about room up, at eye height. */
const yawed = degrees => {
  const angle = degrees * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle);
  return [cos, 0, -sin, 0, 0, 1, 0, 0, sin, 0, cos, 0, 0, 1.6, 0, 1];
};
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-6,
  `${message}: expected ${expected}, got ${actual}`);
const product = (a, b) => Array.from({ length: 16 }, (_, i) =>
  [0, 1, 2, 3].reduce((sum, k) => sum + a[k * 4 + i % 4] * b[Math.floor(i / 4) * 4 + k], 0));

for (const yaw of [45, 90, 180]) for (const pitch of [-90, -89.95, 89.95, 90]) {
  test(`yaw ${yaw}, pitch ${pitch} retains distinct wearer-relative depth and sideways travel`, () => {
    const angle = pitch * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
    const headInRoom = product(yawed(yaw), [1,0,0,0, 0,c,s,0, 0,-s,c,0, 0,0,0,1]);
    const axes = wearerAxesFrom({ headInRoom });
    const expected = wearerAxesFrom({ headInRoom: yawed(yaw) });
    for (const name of ['right', 'up', 'forward']) {
      axes[name].forEach((value, i) => close(value, expected[name][i], `${name} retains head yaw`));
    }
    close(dot(axes.forward, axes.right), 0, 'depth and sideways stay perpendicular');
  });
}

for (const yaw of [45, 90, 180]) for (const roll of [-90, 90]) {
  test(`yaw ${yaw}, roll ${roll} derives sideways travel from the surviving forward axis`, () => {
    const angle = roll * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
    const headInRoom = product(yawed(yaw), [c,s,0,0, -s,c,0,0, 0,0,1,0, 0,0,0,1]);
    const roomToRender = product(yawed(35), [2,0,0,0, 0,2,0,0, 0,0,2,0, 0,0,0,1]);
    const axes = wearerAxesFrom({ headInRoom, roomToRender });
    const expected = wearerAxesFrom({ headInRoom: yawed(yaw), roomToRender });
    for (const name of ['right', 'up', 'forward']) {
      axes[name].forEach((value, i) => close(value, expected[name][i], `${name} retains yaw in render space`));
    }
    close(dot(axes.forward, axes.right), 0, 'depth and sideways stay perpendicular');
  });
}

test('a head yawed 180 pushes the structure away from the wearer, not toward', () => {
  // The regression this test exists for: `head-rotation-lock.mjs` holds
  // `camera.headRotation` at zero, so the old reader saw an untracked head on
  // every frame and the left stick pushed along the room's -Z whichever way
  // the wearer had turned. A wearer facing +Z pushing forward watched the
  // structure fly at their face.
  const zeroedHeadRotation = new Array(16).fill(0);
  const broken = wearerAxesFrom({ roomToRender: IDENTITY, headInRoom: zeroedHeadRotation });
  assert.equal(broken.tracked, false, 'A zeroed matrix is not a tracked head.');
  close(broken.forward[2], -1, 'Without a head the room axes stand in');

  const axes = wearerAxesFrom({ roomToRender: IDENTITY, headInRoom: yawed(180) });
  assert.equal(axes.tracked, true);
  // Turned about-face, the wearer's forward is room +Z, so a forward push
  // moves the structure away from them.
  close(axes.forward[2], 1, 'A head yawed 180 faces room +Z');
  close(axes.right[0], -1, 'and its right is room -X');
  const towardTheWearer = [0, 0, -1];
  assert.ok(dot(axes.forward, towardTheWearer) < 0, 'The push must not come toward the wearer.');
});

test('follows the head through a quarter turn', () => {
  const axes = wearerAxesFrom({ roomToRender: IDENTITY, headInRoom: yawed(90) });
  close(axes.forward[0], -1, 'A head yawed 90 faces room -X');
  close(axes.right[2], -1, 'and its right is room -Z');
  close(dot(axes.forward, axes.right), 0, 'The axes stay square');
  close(Math.hypot(...axes.forward), 1, 'and unit length');
});

test('levels a pitched head so travel never dives into the floor', () => {
  // Pitched 45 degrees down about the head's own right axis, looking at the
  // desk. Forward must still be horizontal; up stays the room's up.
  const angle = Math.PI / 4, cos = Math.cos(angle), sin = Math.sin(angle);
  const pitched = [1, 0, 0, 0, 0, cos, sin, 0, 0, -sin, cos, 0, 0, 1.6, 0, 1];
  const axes = wearerAxesFrom({ roomToRender: IDENTITY, headInRoom: pitched });
  close(axes.forward[1], 0, 'A pitched head still travels level');
  close(axes.forward[2], -1, 'and keeps the yaw it was facing');
  close(axes.up[1], 1, 'Up is the room’s up, not the head’s');
});

test('a head looking straight down still carries its yaw', () => {
  // Nothing is left of forward after levelling; the surviving right axis
  // still carries the head's heading.
  const down = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1.6, 0, 1];
  const axes = wearerAxesFrom({ roomToRender: IDENTITY, headInRoom: down });
  close(Math.hypot(...axes.forward), 1, 'A levelled-out forward is still a unit axis');
  close(Math.hypot(...axes.right), 1, 'and so is right');
});

test('maps the wearer’s axes through the render transform', () => {
  // `roomToRender` is `inverse(camera.view)`. A scene scaled and turned under
  // the wearer must not change which way the stick moves it in their sight.
  const quarter = [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1];
  const axes = wearerAxesFrom({ roomToRender: quarter, headInRoom: yawed(0) });
  close(axes.forward[0], -1, 'Room -Z maps to render -X under this transform');
  close(axes.up[1], 1, 'Room up is unchanged by a yaw');
});

test('survives a missing or broken pose', () => {
  for (const headInRoom of [undefined, null, [], new Array(16).fill(Number.NaN), [1, 2, 3]]) {
    const axes = wearerAxesFrom({ roomToRender: IDENTITY, headInRoom });
    assert.equal(axes.tracked, false);
    close(axes.forward[2], -1, 'The room axes stand in for an unreadable head');
  }
  const noView = wearerAxesFrom({});
  close(noView.up[1], 1, 'An unreadable view falls back to the identity');
  assert.ok(TRACKED_AXIS_MINIMUM > 0 && TRACKED_AXIS_MINIMUM < 1);
});
