// Ink only: atlas padding is not cap height. Arial Bold H is 138 / 304
// atlas texels at quality 2; 0.44 leaves room for rasterizer differences.
export const MENU_INK_CAP_FRACTION = 0.44;
export const QUEST_MENU_MIN_CAP_DEGREES = 0.6;
export function menuCapDegrees(fontMeters, distanceMeters, riseMeters = 0) {
  // The upright panel's cap endpoints, rather than its padded quad or its
  // anchor distance alone. A line below eye level is foreshortened.
  const halfCap = fontMeters * MENU_INK_CAP_FRACTION / 2;
  const levelRange = Math.sqrt(Math.max(0, distanceMeters ** 2 - riseMeters ** 2));
  return (Math.atan2(riseMeters + halfCap, levelRange)
    - Math.atan2(riseMeters - halfCap, levelRange)) * 180 / Math.PI;
}
