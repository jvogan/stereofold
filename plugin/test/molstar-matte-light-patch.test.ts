import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { build } from 'esbuild';
import { MATTE_LIGHT_ANCHOR, MATTE_LIGHT_REPLACEMENT, assertMolstarMatteLightSources,
  patchMolstarMatteLightShader, patchMolstarMatteShaderCode, matteLightingBuildPlugins } from '../src/molstar-matte-light-patch.js';
import { patchMolstarZeroLightSource, zeroContributionLightingBuildPlugins } from '../src/molstar-zero-light-patch.js';

const root = new URL('..', import.meta.url).pathname;
const dir = new URL('../node_modules/molstar/lib/mol-gl/', import.meta.url);
const [lightSource, materialSource, applySource, shaderCodeSource] = await Promise.all([
  readFile(new URL('shader/chunks/light-frag-params.glsl.js', dir), 'utf8'),
  readFile(new URL('shader/chunks/assign-material-color.glsl.js', dir), 'utf8'),
  readFile(new URL('shader/chunks/apply-light-color.glsl.js', dir), 'utf8'),
  readFile(new URL('shader-code.js', dir), 'utf8'),
]);
const decoded = (source: string) => new Function(source.replace('export const light_frag_params', 'const light_frag_params') + '\nreturn light_frag_params;')() as string;
const stock = decoded(patchMolstarZeroLightSource(lightSource, 'light-frag-params', '5.11.0'));
const candidate = patchMolstarMatteLightShader(stock, '5.11.0');

// Execute the installed and candidate GLSL BRDF formulas. Only GLSL type
// syntax and vector operators are adapted; scalar functions come from the
// actual source as well. Hardware float32/RGBA8 equivalence remains a separate
// device gate, since JavaScript arithmetic is double precision.
function body(shader: string, name: string): string {
  const start = shader.indexOf(`${name}(`), open = shader.indexOf('{', start);
  if (start < 0 || open < 0) throw Error(`Missing ${name}`);
  let depth = 1, end = open + 1;
  for (; depth && end < shader.length; end++) {
    if (shader[end] === '{') depth++;
    if (shader[end] === '}') depth--;
  }
  return shader.slice(open + 1, end - 1).replace(/\b(?:float|vec3)\s+/g, 'let ');
}
const dot = (a: number[], b: number[]) => a.reduce((v, x, i) => v + x * b[i]!, 0);
const norm = (a: number[]) => a.map(x => x / Math.hypot(...a));
function brdf(shader: string) {
  const common = ['pow2', 'saturate', 'sqrt', 'max', 'exp2', 'EPSILON', 'RECIPROCAL_PI'];
  const values = [(v: number) => v * v, (v: number) => Math.max(0, Math.min(1, v)), Math.sqrt, Math.max, (v: number) => 2 ** v, 1e-6, 0.31830988618];
  const scalar = (name: string, params: string[], adapt = (s: string) => s) =>
    new Function(...common, ...params, adapt(body(shader, name))).bind(null, ...values);
  const schlick = scalar('F_Schlick', ['f0', 'f90', 'dotVH'], s => s.replace('return f0 * (1.0 - fresnel) + (f90 * fresnel);', 'return f0.map(x => x * (1.0 - fresnel) + (f90 * fresnel));'));
  const visibility = scalar('V_GGX_SmithCorrelated', ['alpha', 'dotNL', 'dotNV']);
  const distribution = scalar('D_GGX', ['alpha', 'dotNH']);
  const adapted = body(shader, 'BRDF_GGX')
    .replace('normalize( lightDir + viewDir)', 'normalize(lightDir.map((v,i) => v + viewDir[i]))')
    .replaceAll('return F * (V * D);', 'return F.map(x => x * (V * D));')
    .replaceAll('return F * (V * RECIPROCAL_PI);', 'return F.map(x => x * (V * RECIPROCAL_PI));');
  const execute = new Function(...common, 'dot', 'normalize', 'F_Schlick', 'V_GGX_SmithCorrelated', 'D_GGX',
    'lightDir', 'viewDir', 'normal', 'f0', 'f90', 'roughness', adapted);
  return (light: number[], view: number[], normal: number[], color: number[], roughness: number) => {
    let expensive = 0;
    const result = execute(...values, dot, norm, schlick,
      (...args: number[]) => { expensive++; return visibility(...args); },
      (...args: number[]) => { expensive++; return distribution(...args); }, light, view, normal, color, 1, roughness) as number[];
    return { result, expensive };
  };
}

const entry = "export { MeshShaderCode, SpheresShaderCode, CylindersShaderCode } from 'molstar/lib/mol-gl/shader-code.js';";
async function bundle(enabled: boolean) {
  const result = await build({ stdin: { contents: entry, resolveDir: root }, bundle: true, format: 'cjs', platform: 'browser', write: false,
    plugins: [...zeroContributionLightingBuildPlugins(undefined), ...matteLightingBuildPlugins(enabled ? '1' : '0')] });
  return result.outputFiles[0]!.text;
}
const [stockBundle, candidateBundle] = await Promise.all([bundle(false), bundle(true)]);
function runBundle(source: string, navigator?: unknown) {
  const context = vm.createContext({ module: { exports: {} }, exports: {}, console, ...(navigator === undefined ? {} : { navigator }) });
  vm.runInContext(source, context);
  return context.module.exports as Record<string, { frag: string; vert: string }>;
}

describe('Quest-only exact matte GGX candidate', () => {
  it('fails closed on vendor version, drift, duplicate anchors and repeat application', () => {
    assertMolstarMatteLightSources(lightSource, materialSource, applySource, '5.11.0');
    expect(() => patchMolstarMatteLightShader(stock, '5.11.1')).toThrow('5.11.0');
    expect(() => patchMolstarMatteLightShader(stock.replace('float alpha = pow2(roughness)', 'float alpha = roughness'), '5.11.0')).toThrow('anchor');
    expect(() => patchMolstarMatteLightShader(stock + stock, '5.11.0')).toThrow('anchor');
    expect(() => patchMolstarMatteLightShader(candidate, '5.11.0')).toThrow('anchor');
    expect(() => patchMolstarMatteShaderCode(shaderCodeSource + shaderCodeSource, '5.11.0')).toThrow('import');
    expect(() => assertMolstarMatteLightSources(lightSource, materialSource.replace('roughness = mix(roughness, vSubstance.g, sf);', 'roughness = 1.0;'), applySource, '5.11.0')).toThrow('effective roughness');
    expect(() => assertMolstarMatteLightSources(lightSource, materialSource, applySource.replace('roughness, 0.0525) + geometryRoughness', 'roughness, 0.0525)'), '5.11.0')).toThrow('physical roughness');
  });
  it('only replaces GGX and preserves the existing zero-light guard, alpha/depth and all other chunk bytes', () => {
    const nl = stock.includes('\r\n') ? '\r\n' : '\n';
    expect(candidate.replace(MATTE_LIGHT_REPLACEMENT.replaceAll('\n', nl), MATTE_LIGHT_ANCHOR.replaceAll('\n', nl))).toBe(stock);
    expect(candidate).toContain('if (dotNL <= 0.0) return;');
    expect(patchMolstarMatteLightShader(stock.replaceAll('\r\n', '\n'), '5.11.0')).not.toContain('\r');
  });
  it('retains the exact EPSILON grazing denominator and specular at fully matte roughness', () => {
    const before = brdf(stock), after = brdf(candidate);
    for (const nl of [0, 1e-12, 1e-7, 1e-6, .01, .5, 1]) for (const nv of [0, 1e-12, 1e-7, 1e-6, .01, .5, 1]) {
      const args: [number[], number[], number[], number[], number] = [[Math.sqrt(1-nl*nl), 0, nl], [0, Math.sqrt(1-nv*nv), nv], [0,0,1], [.04,.5,1], 1];
      const a = before(...args), b = after(...args);
      expect(b.result).toEqual(a.result);
      expect(b.result.every(Number.isFinite)).toBe(true);
      expect(a.expensive).toBe(2); expect(b.expensive).toBe(0);
    }
  });
  it('preserves random light/view/material inputs, near-matte fallbacks and substance/derivative-clamped effective roughness', () => {
    const before = brdf(stock), after = brdf(candidate);
    let seed = 5711;
    const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2**32; };
    const vector = () => norm([rnd()*2-1, rnd()*2-1, rnd()*2-1]);
    for (let i=0; i<5000; i++) {
      const base = [1, .99999994, .28, .0525][i%4]!;
      const effective = i%5 === 0 ? Math.min(1, Math.max(.0525, base*(1-.7)+.2*.7)+.8) : base;
      const args: [number[], number[], number[], number[], number] = [vector(),vector(),vector(),[rnd(),rnd(),rnd()],effective];
      const a = before(...args), b = after(...args);
      expect(b.result).toEqual(a.result);
      expect(b.expensive).toBe(effective===1 ? 0 : 2);
    }
  });
  it.each([
    undefined,
    { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/26 Safari/605.1.15', xr: {} },
    { userAgent: 'Mozilla/5.0 (iPad; CPU OS 26) AppleWebKit/605.1.15 Version/26 Safari/605.1.15', xr: {} },
    { userAgent: 'PicoBrowser/1.0', xr: {} },
    { userAgent: 'OculusBrowser/40.0' },
    { userAgent: 'Chrome/140.0', xr: {} },
    Object.defineProperty({ xr: {} }, 'userAgent', { get() { throw Error('unavailable UA'); } }),
  ])('keeps Apple/non-Quest/worker assembled shader bytes unchanged for %j', navigator => {
    const before = runBundle(stockBundle, navigator), after = runBundle(candidateBundle, navigator);
    for (const key of Object.keys(before)) {
      expect(after[key]!.frag).toBe(before[key]!.frag);
      expect(after[key]!.vert).toBe(before[key]!.vert);
    }
  });
  it('composes both patches in actual Quest mesh, sphere and cylinder assembled shaders', () => {
    const navigator = { userAgent: 'Mozilla/5.0 (Linux; Android 10; Quest 2) OculusBrowser/40.0.0.0.0', xr: {} };
    const result = runBundle(candidateBundle, navigator);
    for (const value of Object.values(result)) {
      expect(value.frag).toContain('if (roughness == 1.0)');
      expect(value.frag).toContain('if (dotNL <= 0.0) return;');
      expect(value.frag).toContain('if (metalness != 0.0)');
    }
  });
  it('defaults to the Quest-gated patch and rejects incomplete builds and ambiguous switches', async () => {
    expect(matteLightingBuildPlugins(undefined)).toHaveLength(1);
    expect(matteLightingBuildPlugins('0')).toEqual([]);
    expect(matteLightingBuildPlugins('1')).toHaveLength(1);
    expect(() => matteLightingBuildPlugins('true')).toThrow('0 or 1');
    await expect(build({ stdin: { contents: 'export const missing = true', resolveDir: root }, write: false, bundle: true,
      logLevel: 'silent', plugins: matteLightingBuildPlugins('1') })).rejects.toThrow('Expected exactly one');
  });
});
