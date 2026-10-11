import { fields, requireValue, snapshotInput } from './contracts.mjs';

const CAMERA_LIMIT = 1_000_000;
export const CAMERA_TOLERANCE = 1e-6;
export const CAMERA_FIELDS = Object.freeze(['mode', 'fov', 'position', 'up', 'target', 'radius', 'radiusMax',
  'fog', 'clipFar', 'minNear', 'minFar']);

function vector(value) {
  return Array.isArray(value) && value.length === 3
    && Array.from(value).every(item => Number.isFinite(item) && Math.abs(item) <= CAMERA_LIMIT);
}

// Complete Mol* 5.11.0 Camera.Snapshot in source coordinates. Viewport, eye projection,
// room placement, and head tracking have no fields in this draft.
export function validateCamera(input) {
  const camera = snapshotInput(input);
  fields(camera, CAMERA_FIELDS, 'invalid_camera_fields');
  requireValue(['perspective', 'orthographic'].includes(camera.mode), 'invalid_camera_mode');
  requireValue(Number.isFinite(camera.fov) && camera.fov >= 1e-4 && camera.fov <= Math.PI - 1e-4,
    'invalid_camera_fov');
  requireValue(['position', 'up', 'target'].every(key => vector(camera[key])), 'invalid_camera_vector');
  for (const key of ['radius', 'radiusMax', 'minNear', 'minFar']) {
    requireValue(Number.isFinite(camera[key]) && camera[key] >= 0 && camera[key] <= CAMERA_LIMIT,
      'invalid_camera_distance');
  }
  requireValue(camera.radius > 0 && camera.radiusMax > 0, 'invalid_camera_distance');
  requireValue(Number.isFinite(camera.fog) && camera.fog >= 0 && camera.fog <= 100
    && typeof camera.clipFar === 'boolean', 'invalid_camera_clipping');
  const forward = camera.target.map((value, index) => value - camera.position[index]);
  const upLength = Math.hypot(...camera.up);
  const forwardLength = Math.hypot(...forward);
  const cross = [forward[1] * camera.up[2] - forward[2] * camera.up[1],
    forward[2] * camera.up[0] - forward[0] * camera.up[2],
    forward[0] * camera.up[1] - forward[1] * camera.up[0]];
  requireValue(upLength > 1e-9 && forwardLength > 1e-9
    && Math.hypot(...cross) / (upLength * forwardLength) > 1e-8, 'degenerate_camera');
  return camera;
}

export function camerasEqual(a, b) {
  return CAMERA_FIELDS.every(key => {
    if (Array.isArray(a[key])) return a[key].every((value, index) => Math.abs(value - b[key][index]) <= CAMERA_TOLERANCE);
    return typeof a[key] === 'number' ? Math.abs(a[key] - b[key]) <= CAMERA_TOLERANCE : a[key] === b[key];
  });
}
