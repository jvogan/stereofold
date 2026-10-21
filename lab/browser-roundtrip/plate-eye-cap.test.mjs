/**
 * Close to telomerase, "GAR1 1", "NOP10 1" and "Dyskerin 1" drew giant and
 * ran off the lens edge. A name plate is sized for the seat; leaning in made
 * it as large as the wearer's own approach. These check the per-frame cap: no
 * more than about 2 degrees of character height in either eye, and a plate the
 * lens would cut is taken out of that view and put back when it fits.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { capPlateInEyes, plateCharacterDegrees, PLATE_CHARACTER_CEILING_DEGREES } from './plate-eye-cap.mjs';

const uniform = value => ({ ref: { value } });
const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** One plate primitive: a backing quad (texcoord 10) then one glyph quad, anchored at `at` (scene units). */
function plate(at, { sizeFactor = 1, offsetX = 0, offsetY = 0, offsetZ = 0, halfWidth = 3 } = {}) {
  const transform = identity(); transform.splice(12, 3, ...at);
  return { type: 'text', state: { visible: true, alphaFactor: 1 }, values: {
    aPosition: uniform(new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])),
    aMapping: uniform(new Float32Array([-halfWidth, -.5, halfWidth, -.5, halfWidth, .5, -halfWidth, .5, -1, -.4, 1, -.4, 1, .4, -1, .4])),
    aTexCoord: uniform(new Float32Array([10, 10, 10, 10, 10, 10, 10, 10, 0, 0, 1, 0, 1, 1, 0, 1])),
    aDepth: uniform(new Float32Array(8)), aTransform: uniform(new Float32Array(transform)),
    elements: uniform(new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7])), drawCount: uniform(12), instanceCount: uniform(1),
    dSizeType: uniform('uniform'), uSize: uniform(1), alpha: uniform(1),
    uSizeFactor: uniform(sizeFactor), uOffsetX: uniform(offsetX), uOffsetY: uniform(offsetY), uOffsetZ: uniform(offsetZ),
  } };
}

/** One eye at `eye` (metres) looking down -z, with a 90 degree square frustum. */
function view(eye = [0, 0, 0]) {
  const matrix = identity(); matrix.splice(12, 3, ...eye);
  const inverse = identity(); inverse.splice(12, 3, ...eye.map(value => -value));
  const near = .05, far = 100;
  return { transform: { matrix, inverse: { matrix: inverse } },
    projectionMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -(far + near) / (far - near), -1, 0, 0, -2 * far * near / (far - near), 0] };
}

// Scene units are 0.01 m, so a plate at -50 sits half a metre in front of the eye.
const cameraScale = .01;

test('a plate that would draw over 2 degrees is held at 2, and given back its size further away', () => {
  const memory = new WeakMap();
  // Sized for the seat: 1.5 degrees at 3 m is about 0.08 m of character box.
  const object = plate([0, 0, -300], { sizeFactor: 9.8 });
  capPlateInEyes({ objects: [object], views: [view()], cameraScale, memory });
  assert.ok(Math.abs(plateCharacterDegrees(object, view(), cameraScale) - 1.5) < .1);
  assert.equal(object.values.uSizeFactor.ref.value, 9.8);
  // The wearer leans in to half a metre: unchecked, that box is nine degrees.
  const close = view([0, 0, -2.5]);
  capPlateInEyes({ objects: [object], views: [close], cameraScale, memory });
  assert.ok(Math.abs(plateCharacterDegrees(object, close, cameraScale) - PLATE_CHARACTER_CEILING_DEGREES) < .05);
  // Back at the seat the plate is as it was built.
  capPlateInEyes({ objects: [object], views: [view()], cameraScale, memory });
  assert.equal(object.values.uSizeFactor.ref.value, 9.8);
});

test('a capped two-line plate keeps its lines together', () => {
  const memory = new WeakMap();
  const lines = [plate([0, 0, -50], { sizeFactor: 4, offsetY: 10 }), plate([0, 0, -50], { sizeFactor: 4, offsetY: 6 })];
  capPlateInEyes({ objects: lines, views: [view()], cameraScale, memory });
  const k = lines[0].values.uSizeFactor.ref.value / 4;
  assert.ok(k < 1);
  assert.equal(lines[1].values.uSizeFactor.ref.value, lines[0].values.uSizeFactor.ref.value);
  // The pair stays centred where the layout put it, with its gap scaled.
  const [a, b] = lines.map(line => line.values.uOffsetY.ref.value);
  assert.ok(Math.abs((a + b) / 2 - 8) < 1e-9);
  assert.ok(Math.abs((a - b) - 4 * k) < 1e-9);
});

test('a plate the lens edge would cut is out of that view, and back when it fits', () => {
  const memory = new WeakMap();
  const leader = { type: 'mesh', state: { visible: true }, values: {} };
  // Fanned out to the right of an anchor near the frame's right edge.
  const object = plate([40, 0, -50], { sizeFactor: 1, offsetX: 8 });
  const result = capPlateInEyes({ objects: [object], leaders: [leader], views: [view()], cameraScale, memory });
  assert.equal(result.clipped, true);
  assert.equal(object.state.visible, false);
  assert.equal(leader.state.visible, false);
  // The wearer turns toward it (moves the eye right): it fits and comes back.
  capPlateInEyes({ objects: [object], leaders: [leader], views: [view([.4, 0, 0])], cameraScale, memory });
  assert.equal(object.state.visible, true);
  assert.equal(leader.state.visible, true);
  // A plate something else hid stays hidden.
  const hidden = plate([0, 0, -300]); hidden.state.visible = false;
  capPlateInEyes({ objects: [hidden], views: [view()], cameraScale, memory });
  assert.equal(hidden.state.visible, false);
});

test('the headset caps name plates after motion sizing in the pre-draw hook', () => {
  const viewer = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
  const input = viewer.slice(viewer.indexOf('      onInputFrame:'), viewer.indexOf('      onHeadFrame:'));
  assert.ok(input.indexOf('capDrawnPlates(pose?.views)') > input.indexOf('sizeImmersiveAnnotation(repr, canvas, plateEye)'));
  assert.equal((viewer.match(/capDrawnPlates\(pose\?\.views\)/g) ?? []).length, 1);
  const cap = viewer.slice(viewer.indexOf('  function capDrawnPlates('), viewer.indexOf('  async function removeComponentLabels('));
  assert.match(cap, /componentLabels\.refs\(\)/);
  assert.match(cap, /inspectionLabel\?\.representation/);
});
