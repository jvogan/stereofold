type Point = { x: number; y: number; z: number };
type Quaternion = Point & { w: number };

/** Map a published room-space target through a measured viewer pose. */
export function xrToolbarControllerPose(target: Point, viewerFromRoom: number[],
  deviceViewer: { position: Point; quaternion: Quaternion }, distance = .3) {
  const { position, quaternion: q } = deviceViewer;
  if (viewerFromRoom.length !== 16 || ![...viewerFromRoom, ...Object.values(target),
    ...Object.values(position), ...Object.values(q), distance].every(Number.isFinite) || distance <= 0)
    throw Error('Toolbar controller placement needs finite measured transforms.');
  const rotate = (point: Point) => {
    const tx = 2 * (q.y * point.z - q.z * point.y), ty = 2 * (q.z * point.x - q.x * point.z), tz = 2 * (q.x * point.y - q.y * point.x);
    return { x: point.x + q.w * tx + q.y * tz - q.z * ty,
      y: point.y + q.w * ty + q.z * tx - q.x * tz,
      z: point.z + q.w * tz + q.x * ty - q.y * tx };
  };
  const m = viewerFromRoom;
  const local = { x: m[0] * target.x + m[4] * target.y + m[8] * target.z + m[12],
    y: m[1] * target.x + m[5] * target.y + m[9] * target.z + m[13],
    z: m[2] * target.x + m[6] * target.y + m[10] * target.z + m[14] };
  const rotated = rotate(local), direction = rotate({ x: 0, y: 0, z: -1 });
  const deviceTarget = { x: position.x + rotated.x, y: position.y + rotated.y, z: position.z + rotated.z };
  return { deviceTarget, direction, quaternion: { ...q },
    position: { x: deviceTarget.x - direction.x * distance, y: deviceTarget.y - direction.y * distance,
      z: deviceTarget.z - direction.z * distance } };
}
