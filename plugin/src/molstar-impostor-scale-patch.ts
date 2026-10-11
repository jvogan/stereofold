import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Plugin } from 'esbuild';

export type Shader = 'spheres.vert' | 'spheres.frag' | 'cylinders.vert';
const VERSION = '5.11.0';

/** Similarity transforms preserve exact spheres/circular cylinders. Source
 * assembly rotations and positive uniform placement/companion scales compose
 * this way. Rounding an orthogonal matrix to four decimals (entry error <=
 * 5e-5) bounds its relative squared-column length and dot-product residuals
 * below about 3.5e-4; 1e-3 leaves margin for Float32 composition. This is a
 * bounded approximation, not a proof of exact similarity: genuinely tiny
 * anisotropy/shear within that Gram-matrix bound is treated as uniform. Larger
 * nonuniform, sheared or degenerate transforms retain upstream's radius
 * behavior. Representing their exact ellipsoids is outside this patch.
 */
export const IMPOSTOR_SCALE_GLSL = `float stereofoldImpostorScale(const in mat4 transform) {
    vec3 x = transform[0].xyz;
    vec3 y = transform[1].xyz;
    vec3 z = transform[2].xyz;
    float xx = dot(x, x);
    float tolerance = xx * 0.001;
    if (xx > 0.0 && abs(dot(y, y) - xx) <= tolerance && abs(dot(z, z) - xx) <= tolerance
        && abs(dot(x, y)) <= tolerance && abs(dot(x, z)) <= tolerance && abs(dot(y, z)) <= tolerance) {
        return sqrt(xx);
    }
    return 1.0;
}`;

/** Apply to installed JS shader modules, preserving their newline convention.
 * The fragment scale cancels only the authored alphaThickness normalization;
 * actual hit geometry, depth, normals, caps and proxy dimensions use the new
 * world radius. LOD modifies radius after scaling, and stays in the local
 * radius passed through the asymmetric quadratic projection.
 */
export function patchMolstarImpostorScaleSource(source: string, shader: Shader, version: string): string {
  if (version !== VERSION) throw Error('Mol* impostor scale patch requires the reviewed 5.11.0 source.');
  const nl = source.includes('\r\n') ? '\r\n' : '\n';
  const normalize = (s: string) => s.replaceAll('\n', nl);
  let next = source;
  const replace = (anchor: string, replacement: string) => {
    anchor = normalize(anchor); replacement = normalize(replacement);
    if (next.split(anchor).length !== 2) throw Error(`Mol* ${shader} scale anchor changed; patch was not applied.`);
    next = next.replace(anchor, replacement);
  };
  if (source.includes('stereofoldImpostorScale') || source.includes('vStereofoldImpostorScale'))
    throw Error('Mol* impostor scale patch was already applied.');
  if (shader === 'spheres.vert') {
    replace('varying float vRadius;', 'varying float vRadius;\nvarying float vStereofoldImpostorScale;');
    replace('void main(void){', `${IMPOSTOR_SCALE_GLSL}\n\nvoid main(void){`);
    replace('    vRadius = size * uModelScale;', '    vStereofoldImpostorScale = stereofoldImpostorScale(transform);\n    vRadius = size * uModelScale * vStereofoldImpostorScale;');
    replace('            quadraticProjection(position, vRadius / uModelScale, mapping, transform);',
      '            quadraticProjection(position, vRadius / (uModelScale * vStereofoldImpostorScale), mapping, transform);');
  } else if (shader === 'spheres.frag') {
    replace('varying float vRadius;', 'varying float vRadius;\nvarying float vStereofoldImpostorScale;');
    replace('            material.a *= min(1.0, vRadius / (uAlphaThickness * uModelScale));',
      '            material.a *= min(1.0, vRadius / (uAlphaThickness * uModelScale * vStereofoldImpostorScale));');
  } else if (shader === 'cylinders.vert') {
    replace('void main() {', `${IMPOSTOR_SCALE_GLSL}\n\nvoid main() {`);
    replace('    vSize = size * aScale * uModelScale;',
      '    vSize = size * aScale * uModelScale * stereofoldImpostorScale(transform);');
  } else throw Error('Unknown Mol* impostor scale shader.');
  return next;
}

/** `extra` composes a later transform of the same shader module. */
export function impostorScalePatch(extra?: (source: string, shader: Shader, version: string) => string, scaleEnabled = true): Plugin {
  return {
    name: 'stereofold-molstar-impostor-scale',
    setup(api) {
      const counts = new Map<Shader, number>();
      api.onStart(() => { counts.clear(); });
      api.onLoad({ filter: /molstar[/\\]lib[/\\]mol-gl[/\\]shader[/\\](?:spheres\.(?:vert|frag)|cylinders\.vert)\.js$/ }, async ({ path }) => {
        const shader = path.split(/[/\\]/).pop()!.slice(0, -3) as Shader;
        const { version } = JSON.parse(await readFile(resolve(dirname(path), '../../../package.json'), 'utf8'));
        const source = await readFile(path, 'utf8');
        const scaled = scaleEnabled ? patchMolstarImpostorScaleSource(source, shader, version) : source;
        const contents = extra ? extra(scaled, shader, version) : scaled;
        counts.set(shader, (counts.get(shader) ?? 0) + 1);
        return { contents, loader: 'js' };
      });
      api.onEnd(result => {
        if (result.errors.length) return;
        if ((['spheres.vert', 'spheres.frag', 'cylinders.vert'] as const).some(shader => counts.get(shader) !== 1))
          return { errors: [{ text: `Expected exactly one of each pinned Mol* impostor scale shader; counts: ${JSON.stringify(Object.fromEntries(counts))}.` }] };
      });
    },
  };
}

/** Enabled by default. Zero selects the stock Mol* impostor radius for scratch
 * comparisons; one names the default unambiguously. */
export function impostorScaleBuildPlugins(value: string | undefined, extra?: (source: string, shader: Shader, version: string) => string): Plugin[] {
  if (value === '0') return extra ? [impostorScalePatch(extra, false)] : [];
  if (value === undefined || value === '1') return [impostorScalePatch(extra)];
  throw Error('STEREOFOLD_IMPOSTOR_SCALE_PATCH must be 0 or 1.');
}
