import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as measurement from './component-label-measurement.mjs';

const cellValues = entries => Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, { ref: { value } }]));
/** One drawn name plate: its anchor, its live transform and its stand-off. */
const plateObject = ({ anchor = [0, 0, 0], translation = [0, 0, 0], offsetZ = 50, alpha = 1, visible = true, type = 'text' } = {}) => {
  const aTransform = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, ...translation, 1];
  return { type, state: { visible, alphaFactor: 1 }, values: cellValues({
    aPosition: new Float32Array([...anchor, ...anchor, ...anchor, ...anchor]), aTransform, instanceCount: 1, drawCount: 6,
    uOffsetZ: offsetZ, alpha }) };
};

test('each drawn name plate is a sphere at its live anchor, as wide as the stand-off that pushes it toward the eye', () => {
  assert.equal(typeof measurement.drawnPlateDepthSpheres, 'function');
  const scale = 0.01;
  const spheres = measurement.drawnPlateDepthSpheres([
    plateObject({ anchor: [10, 0, -100], translation: [0, 5, -20], offsetZ: 50 }),
    // Hidden, faded out, or not a plate: nothing the wearer sees.
    plateObject({ alpha: 0 }), plateObject({ visible: false }), plateObject({ type: 'mesh' }),
  ], scale);
  assert.equal(spheres.length, 1);
  spheres[0].center.forEach((value, i) => assert.ok(Math.abs(value - [0.1, 0.05, -1.2][i]) < 1e-9, `${value}`));
  assert.ok(Math.abs(spheres[0].radius - 0.5) < 1e-9);
});

test('the near plane stays in front of every drawn name plate, by the glass margin', () => {
  const source = readFileSync(new URL('./immersive-session.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('  function presentationDepthRange(');
  const end = source.indexOf('\n  async function removeOutcome(', start);
  assert.ok(start >= 0 && end > start);
  const depthRange = (points, spheres) => new Function('glassPoints', 'glassSpheres', 'canvas',
    `let outcomeRepresentation, outcomeOwner;\n${source.slice(start, end)}\nreturn presentationDepthRange;`)(
    () => points, () => spheres, {})({ toolbar: { depthRange: () => ({ near: 1.1, far: 1.3 }) }, space: {} }, {
    // One eye at the origin looking down -z.
    getViewerPose: () => ({ views: [{ transform: { inverse: { matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] } } }] }),
  });
  // A plate anchored 1.4 m out and pushed 0.5 m toward the eye is drawn at
  // 0.9 m, nearer than the menu: the near plane goes in front of it.
  const range = depthRange([], [{ center: [0.3, 0, -1.4], radius: 0.5 }]);
  assert.ok(Math.abs(range.near - 0.85) < 1e-9, `near ${range.near}`);
  assert.ok(range.far >= 1.3);
  // A plate behind the eye holds nothing back.
  assert.deepEqual(depthRange([], [{ center: [0, 0, 0.6], radius: 0.5 }]), { near: 1.1, far: 1.3 });
});

test('the viewer hands the session its drawn name plates as glass', () => {
  const viewer = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
  assert.match(viewer, /glassSpheres: \(\) => componentLabelDepthSpheres\(\)/);
  assert.match(viewer, /function componentLabelDepthSpheres\(\) \{[\s\S]{0,700}drawnPlateDepthSpheres\(/);
});
