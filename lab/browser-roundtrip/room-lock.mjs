// Import-free room-lock maths. Keep this module runnable in Node so the
// transform that holds the headset UI still can be checked without loading
// the Mol* renderer.
//
// Why this exists
// ---------------
// The menu and the talk orb are authored in XR metres, in the tracked room.
// Mol* draws them, and its scene is the molecule's own coordinate system, so
// one has to be converted into the other.
//
// That conversion used to run per vertex, at rebuild time: every point went
// through `mapXrPointToScene` and the result was baked into the geometry. A
// baked point is only correct for the camera that baked it. `canvas.camera`
// is the model placement in Mol* XR, and a tour spin, a Fit, a Scale row or
// the wearer dragging the structure rewrites `camera.view` or `camera.scale`
// every frame, so between rebuilds the panel was fixed to the molecule and
// moved with it. Rebuilds could not keep pace, and the toolbar discarded any
// rebuild whose camera moved mid-build, which under continuous motion was
// every rebuild.
//
// The conversion belongs in a matrix instead. Geometry stays in room metres,
// and one matrix, recomputed inside the draw, converts it to scene units.
// Mol* applies that matrix through `aTransform`, so the room lock costs
// sixteen floats a frame and cannot be a frame out of date.
export const ROOM_LOCK_EPSILON = 1e-6;

/**
 * General 4x4 inverse, column-major, in the layout Mol* `Mat4` uses.
 *
 * A camera view matrix is rigid, so a transpose-and-negate would do. The
 * general form is here because it also holds for whatever a future camera
 * hands us, and because it is what `Mat4.invert` computes: the two agree to
 * floating-point noise, which `plugin/test/room-lock.test.ts` asserts against
 * the real Mol* implementation.
 *
 * @param {ArrayLike<number>} matrix 16 numbers, column-major
 * @returns {number[]|undefined} the inverse, or `undefined` if singular
 */
export function invertMatrix4(matrix) {
  if (!matrix || matrix.length !== 16) return undefined;
  const m = Array.from(matrix, Number);
  if (!m.every(Number.isFinite)) return undefined;
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  const determinant = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!Number.isFinite(determinant) || Math.abs(determinant) <= ROOM_LOCK_EPSILON) return undefined;
  const d = 1 / determinant;
  return [
    (a11 * b11 - a12 * b10 + a13 * b09) * d, (a02 * b10 - a01 * b11 - a03 * b09) * d,
    (a31 * b05 - a32 * b04 + a33 * b03) * d, (a22 * b04 - a21 * b05 - a23 * b03) * d,
    (a12 * b08 - a10 * b11 - a13 * b07) * d, (a00 * b11 - a02 * b08 + a03 * b07) * d,
    (a32 * b02 - a30 * b05 - a33 * b01) * d, (a20 * b05 - a22 * b02 + a23 * b01) * d,
    (a10 * b10 - a11 * b08 + a13 * b06) * d, (a01 * b08 - a00 * b10 - a03 * b06) * d,
    (a30 * b04 - a31 * b02 + a33 * b00) * d, (a21 * b02 - a20 * b04 - a23 * b00) * d,
    (a11 * b07 - a10 * b09 - a12 * b06) * d, (a00 * b09 - a01 * b07 + a02 * b06) * d,
    (a31 * b01 - a30 * b03 - a32 * b00) * d, (a20 * b03 - a21 * b01 + a22 * b00) * d,
  ];
}

/**
 * The matrix that carries a point in XR room metres into Mol* scene units:
 * `scale(1 / cameraScale) · invert(cameraView)`, column-major.
 *
 * It is the exact matrix form of `mapXrPointToScene`, which mapped one point
 * at a time. Mol* then draws a scene point through `uModel · aTransform`,
 * where `uModel` is the eye view times `camera.scale`. Give `aTransform` this
 * matrix and the two scales cancel and the view cancels its own inverse, so
 * what reaches the eye is the point's position in the room, whatever the
 * camera is doing. That is the room lock, and it is exact rather than
 * approximate: no rebuild, no lag, no drift with orbit or scale.
 *
 * @param {ArrayLike<number>} cameraView `canvas.camera.view`
 * @param {number} cameraScale `canvas.camera.scale`
 * @returns {number[]|undefined} 16 numbers, column-major
 */
export function roomToSceneMatrix(cameraView, cameraScale) {
  if (!Number.isFinite(cameraScale) || Math.abs(cameraScale) <= ROOM_LOCK_EPSILON) return undefined;
  const inverse = invertMatrix4(cameraView);
  if (!inverse) return undefined;
  const factor = 1 / cameraScale;
  // The view inverse is affine, so its last row is (0, 0, 0, 1). Scaling the
  // upper three rows scales the rotation and the translation together, which
  // is what `mapXrPointToScene` did by scaling the transformed point.
  const scaled = inverse.slice();
  for (let column = 0; column < 4; column++) {
    scaled[column * 4] *= factor;
    scaled[column * 4 + 1] *= factor;
    scaled[column * 4 + 2] *= factor;
  }
  return scaled;
}

/**
 * Carry one point through a column-major 4x4. The room-space hit tests never
 * need this; it exists so a test can compare the matrix against the per-point
 * mapping it replaces, and so a diagnostic can report where a room point
 * lands in the scene.
 */
export function applyMatrix4(point, matrix) {
  if (!Array.isArray(point) || point.length !== 3 || !point.every(Number.isFinite)) return undefined;
  if (!matrix || matrix.length !== 16) return undefined;
  const [x, y, z] = point;
  const w = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
  const divisor = Number.isFinite(w) && Math.abs(w) > ROOM_LOCK_EPSILON ? w : 1;
  return [
    (matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]) / divisor,
    (matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]) / divisor,
    (matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]) / divisor,
  ];
}

/**
 * The wearer's head position and orientation in the room.
 *
 * A seat is computed once, from the pose at that moment, and then retained.
 * This returns the basis a seat is built on: the head's position, its forward
 * direction, its right and its up. Every caller that places something in the
 * room reads the basis from here, so the menu and the orb cannot disagree
 * about which direction was right at entry.
 *
 * @param {{transform?: {matrix?: ArrayLike<number>, position?: {x:number,y:number,z:number}},
 *          matrix?: ArrayLike<number>, position?: {x:number,y:number,z:number}}} head viewer pose
 * @returns {{origin: number[], forward: number[], right: number[], up: number[]}|undefined}
 */
export function headBasis(head) {
  const matrix = head?.transform?.matrix ?? head?.matrix;
  const position = head?.transform?.position ?? head?.position;
  if (!matrix || matrix.length !== 16 || !position) return undefined;
  const origin = [position.x, position.y, position.z];
  if (!origin.every(Number.isFinite) || !Array.from(matrix, Number).every(Number.isFinite)) return undefined;
  const normalize = (vector, fallback) => {
    const length = Math.hypot(...vector);
    return Number.isFinite(length) && length > ROOM_LOCK_EPSILON ? vector.map(value => value / length) : [...fallback];
  };
  const forward = normalize([-matrix[8], -matrix[9], -matrix[10]], [0, 0, -1]);
  const right = normalize([matrix[0], matrix[1], matrix[2]], [1, 0, 0]);
  const rawUp = [matrix[4], matrix[5], matrix[6]];
  let up = normalize([
    right[1] * forward[2] - right[2] * forward[1],
    right[2] * forward[0] - right[0] * forward[2],
    right[0] * forward[1] - right[1] * forward[0],
  ], [0, 1, 0]);
  if (up[0] * rawUp[0] + up[1] * rawUp[1] + up[2] * rawUp[2] < 0) up = up.map(value => -value);
  return { origin, forward, right, up };
}
