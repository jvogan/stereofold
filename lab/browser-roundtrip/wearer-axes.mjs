// The axes the sticks move the structure along.
//
// This was inline in `viewer.mjs` and read `camera.headRotation`, which Mol*'s
// `xr-manager.js:95` writes each frame from the viewer pose.
// `head-rotation-lock.mjs` holds that matrix at zero for the whole
// session, because a non-zero head rotation is what mirrored the menu. The
// reader's own "before the first XR frame the matrix is all zeros" guard then
// matched every frame, so the sticks silently fell back to room axes: pushing
// the stick forward moved the structure along a fixed compass direction rather
// than away from the wearer, whichever way they had turned.
//
// The head matrix is still available, untouched by the lock: `viewer.mjs`
// samples `frame.getViewerPose(space).transform.matrix` every frame into
// `latestRoomPlacementPose.headInRoom`, in the same room space `headRotation`
// was written from. This module takes that matrix instead, so the lock and
// head-relative travel can both be true at once.
//
// It is plain arrays on purpose: the lab test runner cannot resolve Mol*.

/** How short a levelled vector may be before it carries no yaw at all. */
export const LEVEL_EPSILON = 1e-3;
/**
 * How much of a unit axis must survive to count as a tracked head.
 *
 * A real rotation matrix has unit columns. An untracked pose is all zeros
 * (`camera.js:213` and a lost `getViewerPose`), so any threshold between the
 * two works; a half keeps the reading obviously non-zero.
 */
export const TRACKED_AXIS_MINIMUM = 0.5;

const finiteMatrix = value => {
  if (!value || value.length !== 16) return false;
  for (let index = 0; index < 16; index++) if (!Number.isFinite(value[index])) return false;
  return true;
};

const normalize = vector => {
  const magnitude = Math.hypot(vector[0], vector[1], vector[2]);
  return magnitude > 1e-9 ? [vector[0] / magnitude, vector[1] / magnitude, vector[2] / magnitude] : undefined;
};
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/**
 * The room's up and the wearer's own levelled right and forward, in the space
 * the pointer rays and `applyGrabDelta` use.
 *
 * `roomToRender` is `inverse(camera.view)`: `xr-manager.js:27-36` builds every
 * pointer ray in the room and then transforms it by that inverse, so its
 * columns are the room's axes in render space. The room's own X is a fixed
 * compass direction, which is why the head matrix is needed at all.
 *
 * `headInRoom` is a WebXR viewer-pose matrix: its first column is the head's
 * right and its third the head's back. Both are flattened against room up, so
 * a tipped head strafes level and a forward push never dives into the floor.
 * Without a tracked head the room axes stand in, exactly as before.
 *
 * @param {{roomToRender?: ArrayLike<number>, headInRoom?: ArrayLike<number>}} input
 * @returns {{right:number[], up:number[], forward:number[], tracked:boolean}}
 */
export function wearerAxesFrom({ roomToRender, headInRoom } = {}) {
  const matrix = finiteMatrix(roomToRender) ? roomToRender : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const direction = (x, y, z) => {
    const mapped = [matrix[0] * x + matrix[4] * y + matrix[8] * z,
      matrix[1] * x + matrix[5] * y + matrix[9] * z,
      matrix[2] * x + matrix[6] * y + matrix[10] * z];
    return normalize(mapped) ?? mapped;
  };
  const up = direction(0, 1, 0);
  const level = vector => {
    if (!vector) return undefined;
    const dot = vector[0] * up[0] + vector[1] * up[1] + vector[2] * up[2];
    const flat = [vector[0] - up[0] * dot, vector[1] - up[1] * dot, vector[2] - up[2] * dot];
    // A head looking straight up or straight down has no yaw left in the axis
    // being levelled; the caller's next fallback carries it.
    return Math.hypot(flat[0], flat[1], flat[2]) > LEVEL_EPSILON ? normalize(flat) : undefined;
  };
  const tracked = finiteMatrix(headInRoom)
    && Math.hypot(headInRoom[0], headInRoom[1], headInRoom[2]) > TRACKED_AXIS_MINIMUM;
  const trackedRight = tracked ? level(direction(headInRoom[0], headInRoom[1], headInRoom[2])) : undefined;
  const trackedForward = tracked ? level(direction(-headInRoom[8], -headInRoom[9], -headInRoom[10])) : undefined;
  // At vertical pitch or roll one projected axis vanishes. The other still
  // carries the wearer's heading; a fixed room fallback can turn depth and
  // sideways into the same direction after the wearer has turned their head.
  const right = trackedRight ?? (trackedForward ? normalize(cross(trackedForward, up)) : undefined)
    ?? level(direction(1, 0, 0)) ?? direction(1, 0, 0);
  const forward = trackedForward ?? (trackedRight ? normalize(cross(up, trackedRight)) : undefined)
    ?? level(direction(0, 0, -1)) ?? direction(0, 0, -1);
  return { right, up, forward, tracked };
}
