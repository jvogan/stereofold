import { readFile } from 'node:fs/promises';
import type { Plugin } from 'esbuild';

/** Shared with the read-only acceptance probe. Keep this function self-contained:
 * its JavaScript body is embedded in the installed renderer at build time. */
export function canSkipFullyTransparentMesh(v: Record<string, { ref: { value: any } }>, sceneMarkerAverage: number): boolean {
  return v.dGeometryType?.ref.value === 'mesh' && v.dTransparency?.ref.value === true
    && v.transparencyAverage?.ref.value === 1 && v.uTransparencyStrength?.ref.value === 1
    && (v.dTransparencyType?.ref.value === 'instance' || v.dTransparencyType?.ref.value === 'groupInstance')
    && (v.dTransparentBackfaces?.ref.value === 'off' || v.dTransparentBackfaces?.ref.value === 'on')
    && v.markerAverage?.ref.value === 0 && (v.uMarker?.ref.value === 0 || v.uMarker?.ref.value === -1)
    && sceneMarkerAverage === 0;
}

/** Skip only a proven zero-alpha mesh in the ordinary blended color pass.
 * Mol* still retains its geometry, identity, picking, depth and marking passes.
 * Do not move this condition into checkTransparent: transparent depth and DPOIT
 * can write depth even when color alpha is zero. Marker colors can also raise
 * zero alpha, including global dimming when another object is marked.
 */
export function patchMolstarBlendedTransparentSource(source: string): string {
  const start = '        const renderBlendedTransparent = (group, camera) => {';
  const end = '        const renderVolume = (group, camera, depthTexture) => {';
  const draw = '                if (checkTransparent(r)) {';
  if (source.split(start).length !== 2 || source.split(end).length !== 2)
    throw Error('Mol* blended color pass changed; transparent mesh patch was not applied.');
  const from = source.indexOf(start), to = source.indexOf(end, from);
  if (to <= from) throw Error('Mol* blended color pass boundary changed.');
  const pass = source.slice(from, to);
  if (pass.split(draw).length !== 2)
    throw Error('Mol* blended color submission changed; transparent mesh patch was not applied.');
  const patched = pass.replace(start, `${start}
            // Stereofold: zero-alpha meshes cannot contribute to this blended color pass.
            const canSkipFullyTransparentMesh = ${canSkipFullyTransparentMesh.toString()};`)
    .replace(draw, `                if (canSkipFullyTransparentMesh(r.values, globalUniforms.uMarkerAverage.ref.value)) continue;\n${draw}`);
  return source.slice(0, from) + patched + source.slice(to);
}

export const transparentMeshColorPatch: Plugin = {
  name: 'stereofold-transparent-mesh-blended-color',
  setup(api) {
    api.onLoad({ filter: /mol-gl[/\\]renderer\.js$/ }, async ({ path }) => ({
      contents: patchMolstarBlendedTransparentSource(await readFile(path, 'utf8')),
      loader: 'js',
    }));
  },
};
