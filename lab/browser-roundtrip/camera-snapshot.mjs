const CAMERA_FIELDS = ['mode', 'fov', 'position', 'up', 'target', 'radius', 'radiusMax', 'fog', 'clipFar', 'minNear', 'minFar'];
const detached = value => structuredClone(value);
const failure = (code, message) => Object.assign(new Error(message), { code });
export function cameraSnapshot(value) {
  const copy = detached(value);
  if (!copy || typeof copy !== 'object' || Array.isArray(copy)
      || Object.keys(copy).length !== CAMERA_FIELDS.length
      || CAMERA_FIELDS.some(key => !Object.hasOwn(copy, key))) {
    throw failure('invalid_camera', 'A complete Mol* camera snapshot is required.');
  }
  for (const key of ['position', 'up', 'target']) {
    if (!Array.isArray(copy[key]) || copy[key].length !== 3 || !Array.from(copy[key]).every(Number.isFinite)) {
      throw failure('invalid_camera', `Camera ${key} must contain three finite numbers.`);
    }
  }
  if (!['perspective', 'orthographic'].includes(copy.mode) || typeof copy.clipFar !== 'boolean'
      || !['fov', 'radius', 'radiusMax', 'fog', 'minNear', 'minFar'].every(key => Number.isFinite(copy[key]))
      || copy.fov <= 0 || copy.fov >= Math.PI || copy.radius <= 0 || copy.radiusMax <= 0
      || copy.fog < 0 || copy.fog > 100 || copy.minNear < 0 || copy.minFar < 0) {
    throw failure('invalid_camera', 'The camera snapshot contains unsupported values.');
  }
  const direction = copy.position.map((value, i) => value - copy.target[i]);
  const cross = [
    direction[1] * copy.up[2] - direction[2] * copy.up[1],
    direction[2] * copy.up[0] - direction[0] * copy.up[2],
    direction[0] * copy.up[1] - direction[1] * copy.up[0],
  ];
  if (!direction.every(Number.isFinite) || !cross.every(Number.isFinite)
      || Math.hypot(...direction) === 0 || Math.hypot(...copy.up) === 0 || Math.hypot(...cross) === 0) {
    throw failure('invalid_camera', 'Camera position, target and up must define a viewing direction.');
  }
  return copy;
}
