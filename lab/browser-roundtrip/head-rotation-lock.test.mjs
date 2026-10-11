import assert from 'node:assert/strict';
import test from 'node:test';
import { holdHeadRotationZero } from './head-rotation-lock.mjs';
import { createToolbarPanel, toolbarSeatBasis } from './spatial-toolbar-geometry.mjs';

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const camera = () => ({ headRotation: [...IDENTITY] });
/** What `Mat4.fromQuat(camera.headRotation, q)` does: write in place. */
const writeRotation = (target, values) => { for (let i = 0; i < 16; i++) target[i] = values[i]; return target; };
const isZero = matrix => Array.from(matrix).every(value => value === 0);

test('a held camera reads zero however often Mol* rewrites the head rotation', () => {
  const subject = camera();
  const release = holdHeadRotationZero(subject);
  // One immersive frame: XRManager writes the viewer-pose rotation, then the
  // stereo camera copies it out, then the renderer tests it.
  writeRotation(subject.headRotation, [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1]);
  const eye = writeRotation([...IDENTITY], subject.headRotation);
  assert.ok(isZero(eye), 'A stereo eye camera must copy a zero head rotation.');
  assert.ok(isZero(subject.headRotation), 'The renderer must read a zero head rotation.');
  // A second frame must not leak the first frame's write either.
  writeRotation(subject.headRotation, IDENTITY);
  assert.ok(isZero(subject.headRotation));
  assert.equal(release(), true);
  assert.ok(isZero(subject.headRotation), 'Release hands back the array Mol* owns, cleared.');
  writeRotation(subject.headRotation, IDENTITY);
  assert.deepEqual(subject.headRotation, IDENTITY, 'A released camera stores what Mol* writes.');
});

test('holding is refused for anything that is not a plain 16-number matrix', () => {
  assert.equal(holdHeadRotationZero(undefined)(), false);
  assert.equal(holdHeadRotationZero({})(), false);
  assert.equal(holdHeadRotationZero({ headRotation: [0, 0, 0] })(), false);
  const twice = { headRotation: [...IDENTITY] };
  holdHeadRotationZero(twice);
  assert.equal(holdHeadRotationZero(twice)(), false, 'A second hold must not capture the accessor.');
});

/**
 * The seat this menu is built on, at a spread of head poses. A wearer standing
 * anywhere, facing anywhere, must get the panel forward and to their left, laid
 * out along their own right.
 */
const headAt = (yawDegrees, position) => {
  const radians = yawDegrees * Math.PI / 180, c = Math.cos(radians), s = Math.sin(radians);
  return { transform: { position, matrix: [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, position.x, position.y, position.z, 1] } };
};
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

for (const [name, yawDegrees, position] of [
  ['identity', 0, { x: 0, y: 1.6, z: 0 }],
  ['quarter turn', 90, { x: 0, y: 1.6, z: 0 }],
  ['half turn away from the origin', 180, { x: 1.5, y: 1.6, z: -2 }],
  ['three quarter turn', -90, { x: -0.8, y: 1.5, z: 3.2 }],
]) {
  test(`the seat is forward-left of a head at ${name}`, () => {
    const head = headAt(yawDegrees, position);
    const basis = toolbarSeatBasis(head);
    const panel = createToolbarPanel({ rows: [{ label: 'Talk' }, { label: 'Start tour' }, { label: 'Move menu' }], head });
    const toAnchor = [0, 1, 2].map(axis => panel.anchor[axis] - basis.origin[axis]);
    assert.ok(dot(toAnchor, basis.forward) > 0.2, 'The panel must be in front of the wearer.');
    assert.ok(dot(toAnchor, basis.right) < -0.1, 'The panel must be to the wearer left.');
    assert.ok(dot(panel.right, basis.right) > 0.5, 'Labels must run along the wearer own right.');
    assert.ok(dot(panel.normal, basis.forward) > 0.5, 'The panel face must be turned back toward the wearer.');
    // Rows stack down the room's up axis, never along it sideways.
    assert.deepEqual(panel.up.map(value => Math.round(value)), [0, 1, 0]);
  });
}
