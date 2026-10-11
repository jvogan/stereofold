import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Plugin } from 'esbuild';

const VERSION = '5.11.0';
export const MATTE_LIGHT_ANCHOR = `vec3 BRDF_GGX(const in vec3 lightDir, const in vec3 viewDir, const in vec3 normal, const in vec3 f0, const in float f90, const in float roughness) {
    float alpha = pow2(roughness); // UE4's roughness
    vec3 halfDir = normalize( lightDir + viewDir);
    float dotNL = saturate(dot(normal, lightDir));
    float dotNV = saturate(dot(normal, viewDir));
    float dotNH = saturate(dot(normal, halfDir));
    float dotVH = saturate(dot(viewDir, halfDir));
    vec3 F = F_Schlick(f0, f90, dotVH);
    float V = V_GGX_SmithCorrelated(alpha, dotNL, dotNV);
    float D = D_GGX(alpha, dotNH);
    return F * (V * D);
}`;
export const MATTE_LIGHT_REPLACEMENT = MATTE_LIGHT_ANCHOR
  .replace('    float dotNH = saturate(dot(normal, halfDir));\n', '')
  .replace('    float V = V_GGX_SmithCorrelated(alpha, dotNL, dotNV);', `    // Stereofold: exact GGX specialization for the effective matte material.
    // alpha=a2=1: both square roots are one and the distribution is 1/pi.
    // Retain the grazing-angle EPSILON floor and the original product order.
    if (roughness == 1.0) {
        float V = 0.5 / max(dotNL + dotNV, EPSILON);
        return F * (V * RECIPROCAL_PI);
    }
    float dotNH = saturate(dot(normal, halfDir));
    float V = V_GGX_SmithCorrelated(alpha, dotNL, dotNV);`);

function versionCheck(version: string): void {
  if (version !== VERSION) throw Error('Mol* matte-light candidate requires the reviewed 5.11.0 source.');
}

/** Pure GLSL adaptation for diagnostic pixel probes. Select on the effective
 * BRDF argument, not uRoughness: substance mixing and mesh derivative roughness
 * have already been applied. All non-matte values keep the original formula.
 */
export function patchMolstarMatteLightShader(shader: string, version: string): string {
  versionCheck(version);
  const nl = shader.includes('\r\n') ? '\r\n' : '\n';
  const anchor = MATTE_LIGHT_ANCHOR.replaceAll('\n', nl);
  if (shader.split(anchor).length !== 2) throw Error('Mol* GGX matte-light shader anchor changed; candidate was not applied.');
  return shader.replace(anchor, MATTE_LIGHT_REPLACEMENT.replaceAll('\n', nl));
}

/** The build checks installed source without evaluating imported vendor code. */
export function assertMolstarMatteLightSources(lightSource: string, materialSource: string, applySource: string, version: string): void {
  versionCheck(version);
  const nl = lightSource.includes('\r\n') ? '\r\n' : lightSource.includes('\\r\\n') ? '\\r\\n' : '\n';
  if (lightSource.split(MATTE_LIGHT_ANCHOR.replaceAll('\n', nl)).length !== 2)
    throw Error('Mol* GGX matte-light source anchor changed; candidate was not applied.');
  for (const anchor of ['    float roughness = uRoughness;', '        roughness = mix(roughness, vSubstance.g, sf);']) {
    if (materialSource.split(anchor).length !== 2) throw Error('Mol* effective roughness changed; candidate was not applied.');
  }
  for (const anchor of ['physicalMaterial.roughness = min(max(roughness, 0.0525), 1.0);',
    'physicalMaterial.roughness = min(max(roughness, 0.0525) + geometryRoughness, 1.0);',
    'RE_Direct_Physical(directLight, geometry, physicalMaterial, reflectedLight);']) {
    if (applySource.split(anchor).length !== 2) throw Error('Mol* physical roughness call site changed; candidate was not applied.');
  }
}

/** Keep every non-Oculus browser's assembled GLSL byte-identical, including
 * Vision Pro Safari, desktop Safari, and workers without a navigator/XR API.
 * This import-site adaptation composes with the existing zero-light onLoad
 * plugin instead of competing for ownership of the same shader chunk.
 */
export function patchMolstarMatteShaderCode(source: string, version: string): string {
  versionCheck(version);
  const anchor = "import { light_frag_params } from './shader/chunks/light-frag-params.glsl.js';";
  if (source.split(anchor).length !== 2) throw Error('Mol* light chunk import changed; candidate was not applied.');
  const replacement = `import { light_frag_params as stereofoldStockLight } from './shader/chunks/light-frag-params.glsl.js';
const light_frag_params = (() => {
    try {
        if (typeof navigator === 'undefined' || !('xr' in navigator) || !/\\bOculusBrowser\\//.test(navigator.userAgent || '')) return stereofoldStockLight;
    } catch { return stereofoldStockLight; }
    const nl = stereofoldStockLight.includes('\\r\\n') ? '\\r\\n' : '\\n';
    const anchor = ${JSON.stringify(MATTE_LIGHT_ANCHOR)}.replaceAll('\\n', nl);
    const replacement = ${JSON.stringify(MATTE_LIGHT_REPLACEMENT)}.replaceAll('\\n', nl);
    if (stereofoldStockLight.split(anchor).length !== 2) throw Error('Mol* runtime matte-light anchor changed.');
    return stereofoldStockLight.replace(anchor, replacement);
})();`;
  return source.replace(anchor, replacement);
}

export function matteLightingPatch(): Plugin {
  return {
    name: 'stereofold-molstar-quest-matte-light-candidate',
    setup(api) {
      let count = 0;
      api.onStart(() => { count = 0; });
      api.onLoad({ filter: /molstar[/\\]lib[/\\]mol-gl[/\\]shader-code\.js$/ }, async ({ path }) => {
        const { version } = JSON.parse(await readFile(resolve(dirname(path), '../../package.json'), 'utf8'));
        const chunk = (name: string) => readFile(resolve(dirname(path), `shader/chunks/${name}.glsl.js`), 'utf8');
        const [light, material, apply, source] = await Promise.all([
          chunk('light-frag-params'), chunk('assign-material-color'), chunk('apply-light-color'), readFile(path, 'utf8')]);
        assertMolstarMatteLightSources(light, material, apply, version);
        const contents = patchMolstarMatteShaderCode(source, version);
        count++;
        return { contents, loader: 'js' };
      });
      api.onEnd(result => {
        if (!result.errors.length && count !== 1)
          return { errors: [{ text: `Expected exactly one pinned Mol* matte-light import; count: ${count}.` }] };
      });
    },
  };
}

/** Enabled for the verified Quest route by default; non-Quest GLSL is unchanged.
 * The build entry point restricts the off switch to isolated diagnostic output. */
export function matteLightingBuildPlugins(value: string | undefined): Plugin[] {
  if (value === '0') return [];
  if (value === undefined || value === '1') return [matteLightingPatch()];
  throw Error('STEREOFOLD_MATTE_LIGHT_PATCH must be 0 or 1.');
}
