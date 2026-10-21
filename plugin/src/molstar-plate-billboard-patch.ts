/** XR name-plate glass keeps the glyph footprint while retaining Mol*'s depth bias.
 * Stock text.vert pushes the backing behind the glyphs, then divides BOTH
 * billboard offsets by their respective depths. At large legend offsets a
 * close view therefore draws ink outside its white plate. Compensate only
 * the backing's screen expansion, through an opt-in uniform; source anchors,
 * binocular depth, geometry and ordinary desktop text remain unchanged.
 */
function replaceOnce(source: string, anchor: string, replacement: string): string {
  if (source.split(anchor).length !== 2) throw Error('Mol* plate billboard anchor changed.');
  return source.replace(anchor, replacement);
}
export function patchPlateTextRenderable(source: string): string {
  source = replaceOnce(source, '    uOffsetZ: UniformSpec(\'f\', \'material\'),',
    '    uOffsetZ: UniformSpec(\'f\', \'material\'),\n    uPlateBillboard: UniformSpec(\'f\', \'material\'),');
  return replaceOnce(source, 'export function TextRenderable(ctx, id, values, state, materialId, transparency, globals) {',
    'export function TextRenderable(ctx, id, values, state, materialId, transparency, globals) {\n    values.uPlateBillboard = ValueCell.create(0);');
}
export function patchPlateTextVertex(source: string): string {
  if (source.includes('uniform float uPlateBillboard;')) throw Error('Mol* plate billboard patch already applied.');
  const glsl = (value: string) => value.replaceAll('\n', '\\r\\n');
  source = replaceOnce(source, 'uniform float uOffsetZ;', 'uniform float uOffsetZ;\\r\\nuniform float uPlateBillboard;');
  source = replaceOnce(source, '    vec4 mvCenter = vec4(mvPosition.xyz, 1.0);',
    '    vec4 mvCenter = vec4(mvPosition.xyz, 1.0);\\r\\n    float glyphOffsetZ = offsetZ;');
  return replaceOnce(source, '    cornerOffset.y += offsetY;', glsl(`    cornerOffset.y += offsetY;
    if (uPlateBillboard > 0.5 && vTexCoord.x == 10.0 && !uHasEyeCamera && uIsOrtho == 0.0) {
        float glyphDepth = mvPosition.z * (1.0 - glyphOffsetZ / length(mvPosition.xyz));
        if (glyphDepth < -0.00001 && mvCenter.z < -0.00001) cornerOffset *= mvCenter.z / glyphDepth;
    }`));
}
