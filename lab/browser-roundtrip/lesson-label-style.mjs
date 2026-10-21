// White plates isolate small glyphs from molecular detail and passthrough.
// Retain the authored hue, but cap bright ink channels for readable contrast.
// This runs at representation creation/update, never in the XR frame loop.
export const LESSON_LABEL_BACKGROUND_OPACITY = 1;
export function lessonLabelInk(color) {
  const rgb = [color >>> 16 & 255, color >>> 8 & 255, color & 255];
  const gain = Math.min(1, 112 / Math.max(1, ...rgb));
  return (Math.round(rgb[0] * gain) << 16) | (Math.round(rgb[1] * gain) << 8) | Math.round(rgb[2] * gain);
}
