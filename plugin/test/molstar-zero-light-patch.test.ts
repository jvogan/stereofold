import { describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { assertMolstarEffectiveMetalnessSource, patchMolstarZeroLightSource, zeroContributionLightingBuildPlugins, zeroContributionLightingPatch } from '../src/molstar-zero-light-patch.js';

const root = new URL('..', import.meta.url).pathname;
const chunks = new URL('../node_modules/molstar/lib/mol-gl/shader/chunks/', import.meta.url);
const directSource = await readFile(new URL('light-frag-params.glsl.js', chunks), 'utf8');
const indirectSource = await readFile(new URL('apply-light-color.glsl.js', chunks), 'utf8');
const materialSource = await readFile(new URL('assign-material-color.glsl.js', chunks), 'utf8');
const moduleShader = async (source: string, field: string): Promise<string> =>
  (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`))[field];
const direct = await moduleShader(directSource, 'light_frag_params');
const indirect = await moduleShader(indirectSource, 'apply_light_color');
const patchedDirect = await moduleShader(patchMolstarZeroLightSource(directSource, 'light-frag-params', '5.11.0'), 'light_frag_params');
const patchedIndirect = await moduleShader(patchMolstarZeroLightSource(indirectSource, 'apply-light-color', '5.11.0'), 'apply_light_color');

type Vec = number[];
const mul = (a: number | Vec, b: Vec): Vec => b.map((v, i) => v * (typeof a === 'number' ? a : a[i]!));
const add = (a: Vec, b: Vec): Vec => a.map((v, i) => v + b[i]!);

/** Execute the installed GLSL's direct-light control/accumulation, adapting
 * vector arithmetic only. Finite BRDF outputs remain probes: their algorithms
 * are untouched, and equivalence here concerns whether they contribute at all.
 */
function directFunction(shader: string) {
  const start = shader.indexOf('void RE_Direct_Physical('), end = shader.indexOf('\n}', start);
  let body = shader.slice(shader.indexOf('{', start) + 1, end);
  body = body.replace('float dotNL =', 'const dotNL =')
    .replace('vec3 irradiance = dotNL * directLight.color;', 'const irradiance = mul(dotNL, directLight.color);')
    .replace('reflectedLight.directSpecular += irradiance * BRDF_GGX(', 'reflectedLight.directSpecular = add(reflectedLight.directSpecular, mul(irradiance, BRDF_GGX(')
    .replace('material.roughness);', 'material.roughness)));')
    .replace('reflectedLight.directDiffuse += irradiance * BRDF_Lambert(material.diffuseColor);',
      'reflectedLight.directDiffuse = add(reflectedLight.directDiffuse, mul(irradiance, BRDF_Lambert(material.diffuseColor)));');
  const execute = new Function('directLight', 'geometry', 'material', 'reflectedLight', 'BRDF_GGX', 'BRDF_Lambert', 'mul', 'add', 'saturate', 'dot', body);
  return (dotNL: number) => {
    const calls = { specular: 0, diffuse: 0 };
    const reflected = { directSpecular: [.1, .2, .3], directDiffuse: [.4, .5, .6] };
    execute({ direction: [0, 0, 1], color: [.2, .7, 1.5] }, { normal: [0, 0, dotNL], viewDir: [0, 0, 1] },
      { specularColor: [.04, .06, .1], specularF90: 1, roughness: .28, diffuseColor: [.2, .4, .8] }, reflected,
      () => { calls.specular++; return [.23, .47, .91]; },
      (color: Vec) => { calls.diffuse++; return mul(1 / Math.PI, color); }, mul, add,
      (v: number) => Math.min(1, Math.max(0, v)), (a: Vec, b: Vec) => a.reduce((v, x, i) => v + x * b[i]!, 0));
    return { reflected, calls };
  };
}

/** Execute the installed call site using effective, already mixed metalness.
 * The probe retains both zero-input accumulations performed by upstream.
 */
function indirectFunction(shader: string) {
  const start = shader.indexOf('        // indirect specular only metals');
  const end = shader.indexOf('        outgoingLight =', start);
  const body = shader.slice(start, end)
    .replace('vec3 radiance = uAmbientColor * metalness;', 'const radiance = mul(metalness, uAmbientColor);')
    .replace('vec3 iblIrradiance = uAmbientColor * metalness;', 'const iblIrradiance = mul(metalness, uAmbientColor);')
    .replace('vec3 clearcoatRadiance = vec3(0.0);', 'const clearcoatRadiance = [0, 0, 0];');
  const execute = new Function('metalness', 'uAmbientColor', 'geometry', 'physicalMaterial', 'reflectedLight', 'RE_IndirectSpecular_Physical', 'mul', body);
  return (metalness: number) => {
    let calls = 0;
    const reflected = { indirectSpecular: [.1, .2, .3], indirectDiffuse: [.4, .5, .6] };
    execute(metalness, [.1, .15, .25], {}, {}, reflected,
      (radiance: Vec, irradiance: Vec) => {
        calls++;
        reflected.indirectSpecular = add(reflected.indirectSpecular, mul([.23, .47, .91], radiance));
        reflected.indirectSpecular = add(reflected.indirectSpecular, mul([.03, .04, .05], irradiance));
        reflected.indirectDiffuse = add(reflected.indirectDiffuse, mul([.2, .4, .6], irradiance));
      }, mul);
    return { reflected, calls };
  };
}

describe('pinned Mol* zero-contribution lighting patch', () => {
  it.each(['light-frag-params', 'apply-light-color'] as const)('fails closed for %s version, drift, duplicate and repeated patching', chunk => {
    const source = chunk === 'light-frag-params' ? directSource : indirectSource;
    expect(() => patchMolstarZeroLightSource(source, chunk, '5.11.1')).toThrow('5.11.0');
    expect(() => patchMolstarZeroLightSource('', chunk, '5.11.0')).toThrow();
    expect(() => patchMolstarZeroLightSource(source + source, chunk, '5.11.0')).toThrow();
    const drift = source.replace(chunk === 'light-frag-params' ? 'vec3 irradiance = dotNL' : 'vec3 radiance = uAmbientColor', 'changed');
    expect(() => patchMolstarZeroLightSource(drift, chunk, '5.11.0')).toThrow();
    expect(() => patchMolstarZeroLightSource(patchMolstarZeroLightSource(source, chunk, '5.11.0'), chunk, '5.11.0')).toThrow();
  });
  it('requires the reviewed effective substance material before guarding the indirect call', () => {
    expect(() => assertMolstarEffectiveMetalnessSource(materialSource, '5.11.0')).not.toThrow();
    expect(() => assertMolstarEffectiveMetalnessSource(materialSource, '5.12.0')).toThrow('5.11.0');
    expect(() => assertMolstarEffectiveMetalnessSource(materialSource.replace('metalness = mix(metalness, vSubstance.r, sf);', 'metalness = uMetalness;'), '5.11.0')).toThrow('substance');
    expect(() => patchMolstarZeroLightSource(indirectSource.replace('physicalMaterial.diffuseColor = color.rgb * (1.0 - metalness);', 'physicalMaterial.diffuseColor = color.rgb;'), 'apply-light-color', '5.11.0')).toThrow('material');
    expect(patchedIndirect).not.toContain('if (uMetalness');
  });
  it('leaves all other shader bytes, lights, alpha and depth unchanged', () => {
    expect(patchedDirect.replace('    // Stereofold candidate: no direct contribution from an unlit hemisphere.\n    if (dotNL <= 0.0) return;\n', '')).toBe(direct);
    expect(patchedIndirect.replace('        // Stereofold candidate: both indirect inputs are zero for a nonmetal.\n        if (metalness != 0.0) ', '        ')).toBe(indirect);
  });
  it('supports normalized newline fixtures without silently normalizing source bytes', () => {
    const source = directSource.replaceAll('\r\n', '\n');
    expect(patchMolstarZeroLightSource(source, 'light-frag-params', '5.11.0')).not.toContain('\r');
  });
  it('preserves direct accumulation at negative, zero, tiny positive and full light incidence', () => {
    const stock = directFunction(direct), patched = directFunction(patchedDirect);
    for (const incidence of [-1, -.25, -Number.EPSILON, -0, 0, Number.EPSILON, .01, .25, 1]) {
      const before = stock(incidence), after = patched(incidence);
      expect(after.reflected).toEqual(before.reflected);
      expect(after.calls).toEqual(incidence <= 0 ? { specular: 0, diffuse: 0 } : before.calls);
    }
  });
  it('preserves accumulated ambient light and honors metallic substance on a nonmetal base', () => {
    const stock = indirectFunction(indirect), patched = indirectFunction(patchedIndirect);
    for (const [base, substance, fraction] of [[0, 0, 0], [0, 0, .99], [0, .8, .5], [.7, 0, .5], [1, 1, .99], [0, 1, Number.EPSILON]]) {
      const effective = base! * (1 - fraction!) + substance! * fraction!;
      const before = stock(effective), after = patched(effective);
      expect(after.reflected).toEqual(before.reflected);
      expect(after.calls).toBe(effective === 0 ? 0 : 1);
    }
  });
  it('defaults to the verified patch, retains the stock diagnostic switch and rejects ambiguous settings', () => {
    expect(zeroContributionLightingBuildPlugins(undefined)).toHaveLength(1);
    expect(zeroContributionLightingBuildPlugins('0')).toEqual([]);
    expect(zeroContributionLightingBuildPlugins('1')).toHaveLength(1);
    expect(() => zeroContributionLightingBuildPlugins('true')).toThrow('0 or 1');
  });
  it('patches both actual bundled shader chunks and rejects incomplete bundles', async () => {
    const contents = `export { light_frag_params } from 'molstar/lib/mol-gl/shader/chunks/light-frag-params.glsl.js';
      export { apply_light_color } from 'molstar/lib/mol-gl/shader/chunks/apply-light-color.glsl.js';`;
    const result = await build({ stdin: { contents, resolveDir: root }, bundle: true, format: 'esm', platform: 'node', write: false,
      plugins: zeroContributionLightingBuildPlugins(undefined) });
    const bundled = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0]!.text).toString('base64')}`);
    expect(bundled.light_frag_params).toBe(patchedDirect);
    expect(bundled.apply_light_color).toBe(patchedIndirect);
    const stock = await build({ stdin: { contents, resolveDir: root }, bundle: true, format: 'esm', platform: 'node', write: false,
      plugins: zeroContributionLightingBuildPlugins('0') });
    const unpatched = await import(`data:text/javascript;base64,${Buffer.from(stock.outputFiles[0]!.text).toString('base64')}`);
    expect(unpatched.light_frag_params).toBe(direct);
    expect(unpatched.apply_light_color).toBe(indirect);
    await expect(build({ stdin: { contents: 'export const missing = true;', resolveDir: root }, bundle: true, write: false,
      logLevel: 'silent', plugins: [zeroContributionLightingPatch()] })).rejects.toThrow('Expected exactly one');
  });
});
