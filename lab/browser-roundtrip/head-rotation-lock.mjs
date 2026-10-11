// Import-free. Keep this runnable in Node so the reason the headset menu is
// readable can be checked without loading the Mol* renderer.
//
// Why this exists
// ---------------
// Mol* 5.11.0 expands every text glyph as a screen-facing quad. `text.vert`
// has two paths for that expansion:
//
//     if (uHasHeadRotation) {
//         vec3 rotatedOffset = (uInvHeadRotation * vec4(cornerOffset, 0, 0)).xyz;
//         clip += uProjection * vec4(rotatedOffset, 0.0);
//     } else {
//         clip.xy += vec2(uProjection[0][0], uProjection[1][1]) * cornerOffset;
//     }
//
// `cornerOffset` is a vector in the eye's screen plane. `uInvHeadRotation` is
// the inverse of `camera.headRotation`, which `mol-canvas3d/helper/xr-manager`
// sets from `xrFrame.getViewerPose(xrRefSpace).transform.orientation`: the
// wearer's head orientation in the XR reference space, not in the eye's frame.
// The two agree only while the wearer's head sits at the reference-space
// identity yaw, which is where a desktop emulator starts and where every
// capture of this menu had been taken.
//
// Turn the wearer 180 degrees and `uInvHeadRotation` becomes a rotation of pi
// about Y, so `rotatedOffset` is `(-x, y, 0)`: every glyph quad is drawn
// mirrored about its own centre, in the correct order, at the correct place.
// That is what a wearer sees on the Quest 2: every letter mirrored and
// unreadable. The emulator reproduces it at `--head-yaw 90` and
// `--head-yaw 180`. At 90 degrees the offset lands on the eye's Z axis
// instead, which perturbs `clip.w` by opposite amounts at the two horizontal
// corners and mirrors the glyph the same way, with shear.
//
// The room-locked layer needs no head rotation at all. Its glyphs are already
// carried into the eye by the eye view matrix, so the plain clip-space branch
// draws them upright and the right way round at every head pose. Holding
// `camera.headRotation` at zero selects that branch: `mol-gl/renderer` tests
// `Mat4.isZero(camera.headRotation)` and falls back to `Mat4.id` and the
// untransformed light direction.
//
// What this gives up: an immersive-vr skybox drawn by
// `mol-canvas3d/passes/background` stops counter-rotating with the head, and
// the scene light stops being head-relative. Neither is drawn in the
// passthrough immersive-ar session this menu ships in.
const MATRIX_LENGTH = 16;

/**
 * Hold one Mol* camera's `headRotation` at zero for as long as the returned
 * restore function is uncalled.
 *
 * The property is replaced by an accessor rather than the array being cleared
 * once, because `XRManager.update` rewrites `camera.headRotation` from the
 * viewer pose on every immersive frame. The getter clears the array Mol*
 * already allocated and hands the same array back, so `Mat4.fromQuat` writing
 * into it, `Mat4.copy` reading it into a stereo eye camera, and
 * `Mat4.isZero` testing it all see zero without a further allocation.
 *
 * @param {{headRotation?: ArrayLike<number>}} camera a Mol* `Camera`
 * @returns {() => boolean} restores the original property; true when it did
 */
export function holdHeadRotationZero(camera) {
  if (!camera || typeof camera !== 'object') return () => false;
  const descriptor = Object.getOwnPropertyDescriptor(camera, 'headRotation');
  const matrix = descriptor?.value;
  // Only a plain own data property holding a 16-number matrix is ours to
  // replace. An accessor is either another copy of this hook or a Mol* version
  // that no longer stores the matrix here, and either way guessing is worse
  // than leaving the camera alone.
  if (!descriptor?.writable || !descriptor.configurable || !matrix || matrix.length !== MATRIX_LENGTH) return () => false;
  Object.defineProperty(camera, 'headRotation', {
    configurable: true,
    enumerable: descriptor.enumerable,
    get() {
      for (let index = 0; index < MATRIX_LENGTH; index++) matrix[index] = 0;
      return matrix;
    },
    // `camera.headRotation = m` is not a call Mol* makes, but a silent
    // no-op keeps the property from throwing in strict mode if it ever does.
    set() {},
  });
  return () => {
    const current = Object.getOwnPropertyDescriptor(camera, 'headRotation');
    if (!current?.get) return false;
    Object.defineProperty(camera, 'headRotation', descriptor);
    return true;
  };
}
