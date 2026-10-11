/** The explicit "Above us" action leaves the centre visible with a comfortable upward glance. */
export const OVERHEAD_ELEVATION_DEGREES = 65;

export function overheadRoomPoint(head, forward, height) {
  const distance = Math.max(0, height - head[1]) / Math.tan(OVERHEAD_ELEVATION_DEGREES * Math.PI / 180);
  return { point: [head[0] + forward[0] * distance, height, head[2] + forward[2] * distance], distance };
}
