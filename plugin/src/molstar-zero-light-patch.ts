import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Plugin } from 'esbuild';

type Chunk = 'light-frag-params' | 'apply-light-color';
const VERSION = '5.11.0';

export function assertMolstarEffectiveMetalnessSource(source: string, version: string): void {
  if (version !== VERSION) throw Error('Mol* zero-light candidate requires the reviewed 5.11.0 source.');
  for (const anchor of ['    float metalness = uMetalness;', '        metalness = mix(metalness, vSubstance.r, sf);']) {
    if (source.split(anchor).length !== 2) throw Error('Mol* effective substance material changed; zero-light candidate was not applied.');
  }
}

/** Build adaptation: avoid calculations multiplied by exactly zero.
 * Preserve all contributing lights, effective substance materials, alpha and
 * depth. Native Quest GPU/pixel acceptance verifies this pinned adaptation;
 * the explicit stock build remains available for performance comparisons.
 */
export function patchMolstarZeroLightSource(source: string, chunk: Chunk, version: string): string {
  if (version !== VERSION) throw Error('Mol* zero-light candidate requires the reviewed 5.11.0 source.');
  const nl = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = (...rows: string[]) => rows.join(nl);
  let anchor: string, replacement: string;
  if (chunk === 'light-frag-params') {
    anchor = lines(
      'void RE_Direct_Physical(const in IncidentLight directLight, const in GeometricContext geometry, const in PhysicalMaterial material, inout ReflectedLight reflectedLight) {',
      '    float dotNL = saturate(dot(geometry.normal, directLight.direction));',
      '    vec3 irradiance = dotNL * directLight.color;',
      '    reflectedLight.directSpecular += irradiance * BRDF_GGX(directLight.direction, geometry.viewDir, geometry.normal, material.specularColor, material.specularF90, material.roughness);',
      '    reflectedLight.directDiffuse += irradiance * BRDF_Lambert(material.diffuseColor);',
      '}');
    replacement = anchor.replace(`    vec3 irradiance`, lines(
      '    // Stereofold candidate: no direct contribution from an unlit hemisphere.',
      '    if (dotNL <= 0.0) return;',
      '    vec3 irradiance'));
  } else if (chunk === 'apply-light-color') {
    // The guard uses metalness after dSubstance mixing, never uMetalness alone.
    for (const material of ['    physicalMaterial.diffuseColor = color.rgb * (1.0 - metalness);',
      '    physicalMaterial.specularColor = mix(vec3(0.04), color.rgb, metalness);']) {
      if (source.split(material).length !== 2) throw Error('Mol* effective lighting material changed; zero-light candidate was not applied.');
    }
    anchor = lines(
      '        // indirect specular only metals',
      '        vec3 radiance = uAmbientColor * metalness;',
      '        vec3 iblIrradiance = uAmbientColor * metalness;',
      '        vec3 clearcoatRadiance = vec3(0.0);',
      '        RE_IndirectSpecular_Physical(radiance, iblIrradiance, clearcoatRadiance, geometry, physicalMaterial, reflectedLight);');
    replacement = anchor.replace('        RE_IndirectSpecular_Physical', lines(
      '        // Stereofold candidate: both indirect inputs are zero for a nonmetal.',
      '        if (metalness != 0.0) RE_IndirectSpecular_Physical'));
  } else throw Error('Unknown Mol* zero-light shader chunk.');
  if (source.split(anchor).length !== 2) throw Error(`Mol* ${chunk} shader anchor changed; zero-light candidate was not applied.`);
  return source.replace(anchor, replacement);
}

export function zeroContributionLightingPatch(): Plugin {
  return {
    name: 'stereofold-molstar-zero-light-candidate',
    setup(api) {
      const counts = new Map<Chunk, number>();
      api.onStart(() => { counts.clear(); });
      api.onLoad({ filter: /molstar[/\\]lib[/\\]mol-gl[/\\]shader[/\\]chunks[/\\](?:light-frag-params|apply-light-color)\.glsl\.js$/ }, async ({ path }) => {
        const chunk: Chunk = path.endsWith('apply-light-color.glsl.js') ? 'apply-light-color' : 'light-frag-params';
        const { version } = JSON.parse(await readFile(resolve(dirname(path), '../../../../package.json'), 'utf8'));
        if (chunk === 'apply-light-color') assertMolstarEffectiveMetalnessSource(
          await readFile(resolve(dirname(path), 'assign-material-color.glsl.js'), 'utf8'), version);
        const contents = patchMolstarZeroLightSource(await readFile(path, 'utf8'), chunk, version);
        counts.set(chunk, (counts.get(chunk) ?? 0) + 1);
        return { contents, loader: 'js' };
      });
      api.onEnd(result => {
        if (result.errors.length) return;
        const missing = (['light-frag-params', 'apply-light-color'] as const).filter(chunk => counts.get(chunk) !== 1);
        if (missing.length) return { errors: [{ text: `Expected exactly one of each pinned Mol* zero-light chunk; counts: ${JSON.stringify(Object.fromEntries(counts))}.` }] };
      });
    },
  };
}

/** Enabled by default, with no runtime/quality setting. Zero selects the
 * explicit stock diagnostic build; one names the default unambiguously. */
export function zeroContributionLightingBuildPlugins(value: string | undefined): Plugin[] {
  if (value === '0') return [];
  if (value === undefined || value === '1') return [zeroContributionLightingPatch()];
  throw Error('STEREOFOLD_ZERO_LIGHT_PATCH must be 0 or 1.');
}
