/**
 * Put SDF glyph corners on their physical surface before Mol* draws them.
 * Stock Text expands `mappingBuffer` in the camera plane; moving glyph
 * centres alone cannot keep those quads on a turned menu. Baking the offsets
 * into positions lets the same room transform carry both glass and type.
 * Texture coordinates, groups and triangle indices remain Mol*'s own.
 */
export function surfaceText(text, planes) {
  const positions = text.centerBuffer.ref.value;
  const mappings = text.mappingBuffer.ref.value;
  const groups = text.groupBuffer.ref.value;
  const minimum = [Infinity, Infinity, Infinity], maximum = [-Infinity, -Infinity, -Infinity];
  for (let vertex = 0; vertex < text.charCount * 4; vertex++) {
    const plane = Array.isArray(planes) ? planes[groups[vertex]] : planes;
    if (!plane?.right || !plane?.up) throw Error('Text surface basis is missing.');
    const dx = mappings[vertex * 2], dy = mappings[vertex * 2 + 1];
    for (let axis = 0; axis < 3; axis++) {
      positions[vertex * 3 + axis] += plane.right[axis] * dx + plane.up[axis] * dy;
      minimum[axis] = Math.min(minimum[axis], positions[vertex * 3 + axis]);
      maximum[axis] = Math.max(maximum[axis], positions[vertex * 3 + axis]);
    }
    mappings[vertex * 2] = 0;
    mappings[vertex * 2 + 1] = 0;
  }
  // Text's stock bounds sample one shared centre per quad. After baking,
  // every corner is distinct and must participate or edge glyphs can be culled.
  if (text.charCount > 0 && text.setBoundingSphere) {
    const center = minimum.map((value, axis) => (value + maximum[axis]) / 2);
    let radius = 0;
    for (let vertex = 0; vertex < text.charCount * 4; vertex++) {
      radius = Math.max(radius, Math.hypot(...center.map((value, axis) => positions[vertex * 3 + axis] - value)));
    }
    text.setBoundingSphere({ center, radius });
  }
  return text;
}
