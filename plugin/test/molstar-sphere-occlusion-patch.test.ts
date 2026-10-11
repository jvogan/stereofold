import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import { describe, it, expect } from 'vitest';
import {
  canUseSphereOcclusionRenderable,
  patchSphereOcclusionCommonFragSource,
  patchSphereOcclusionFragmentSource,
  patchSphereOcclusionRenderItemSource,
  patchSphereOcclusionRendererSource,
} from '../src/molstar-sphere-occlusion-patch.js';
import { patchMolstarOpaqueRendererSource, patchMolstarOpaqueRenderItemSource } from '../src/molstar-opaque-depth-patch.js';
import { patchMolstarDepthPrepassRendererSource, patchMolstarDepthPrepassRenderItemSource } from '../src/molstar-depth-prepass-patch.js';
import { patchMolstarBlendedTransparentSource } from '../src/molstar-transparent-mesh-patch.js';

const read = (path: string) => readFileSync(new URL('../node_modules/molstar/lib/' + path, import.meta.url), 'utf8');
const renderer = read('mol-gl/renderer.js');
const renderItem = read('mol-gl/webgl/render-item.js');
const spheres = read('mol-gl/shader/spheres.frag.js');
const common = read('mol-gl/shader/chunks/common-frag-params.glsl.js');
const quest = { userAgent: 'Mozilla/5.0 OculusBrowser/42.0', xr: {} };
const cell = (value: any) => ({ ref: { value, version: 0 } });
const between = (s: string, a: string, b: string) => s.slice(s.indexOf(a), s.indexOf(b, s.indexOf(a)));

function moduleValue(module: string, exportedName: string, navigator?: unknown): string {
  const context = vm.createContext(navigator === undefined ? {} : { navigator });
  const local = module.replace(`export const ${exportedName}`, `const ${exportedName}`);
  return vm.runInContext(local + `\n${exportedName};`, context);
}

function resolveSphereCullBlocks(source: string, enabled: boolean): string {
  const lines = source.replaceAll('\r\n', '\n').split('\n');
  const output: string[] = [];
  let inside = false;
  for (const line of lines) {
    if (line.trim() === '#if __VERSION__ >= 300 && defined(dStereofoldSphereCull) && defined(dRenderVariant_colorBlended)') {
      inside = true;
      continue;
    }
    if (inside && line.trim() === '#endif') {
      inside = false;
      continue;
    }
    if (!inside || enabled) output.push(line);
  }
  if (inside) throw Error('Unclosed sphere-occlusion GLSL gate.');
  return output.filter(line => line.trim()).join('\n');
}

function renderable(overrides: Record<string, any> = {}) {
  const values: any = {
    alpha: cell(1), uAlpha: cell(1), transparencyAverage: cell(0), dTransparency: cell(false), dGeometryType: cell('spheres'),
    dApproximate: cell(false), dClipObjectCount: cell(0), dClipping: cell(false), dClipPrimitive: cell(false),
    dXrayShaded: cell('off'), dWiggle: cell(false), uWiggleAmplitude: cell(0), uTumbleAmplitude: cell(0), uLod: cell([0, 0, 0, 0]), lodLevels: cell([]),
    ...Object.fromEntries(Object.entries(overrides).map(([key, value]) => [key, cell(value)])),
  };
  return { state: { alphaFactor: 1 }, values, getProgram: (_name: string) => undefined as any };
}

function itemHarness(navigator: any, name = 'spheres', geometry = name, withDepthPrepass = false) {
  const programs: any[] = [], vaos: any[] = [], draws: any[] = [];
  const state: any = {};
  const ctx: any = {
    state, stats: { drawCount: 0, instanceCount: 0, instancedDrawCount: 0 }, gl: { TRIANGLES: 4 },
    extensions: { drawBuffers: {}, vertexArrayObject: {}, instancedArrays: { drawArraysInstanced: (...a: any[]) => draws.push(a) } },
    resources: {
      program: (defines: any) => {
        const p: any = {
          id: programs.length + 1, variant: defines.dRenderVariant.ref.value,
          sphereCull: !!defines.dStereofoldSphereCull?.ref.value, destroyed: 0,
          use() { state.currentProgramId = p.id; }, setUniforms() {}, bindTextures() {}, bindAttributes() {}, destroy() { p.destroyed++; },
        };
        programs.push(p); return p;
      },
      vertexArray: () => { const v = { destroyed: 0, bind() {}, destroy() { v.destroyed++; } }; vaos.push(v); return v; },
    },
  };
  const values: any = { dGeometryType: cell(geometry), drawCount: cell(3), instanceCount: cell(1), dProbe: cell(false) };
  const context: any = vm.createContext({
    navigator, isDebugMode: false, isTimingMode: false,
    idFactory: () => { let id = 0; return () => id++; }, ValueCell: { create: cell, update: (c: any, v: any) => { c.ref.value = v; c.ref.version++; } },
    DefineSpec: () => ({ type: 'define' }), createAttributeBuffers: () => [], createTextures: () => [], cloneUniformValues: () => ({}),
    getValueVersions: (v: any) => Object.fromEntries(Object.entries(v).map(([k, c]: any) => [k, c.ref.version])),
    splitValues: (_s: any, v: any) => ({ attributeValues: {}, defineValues: { dProbe: v.dProbe }, textureValues: {}, materialTextureValues: {}, uniformValues: {}, materialUniformValues: {}, bufferedUniformValues: {} }),
  });
  let transformed = patchMolstarOpaqueRenderItemSource(renderItem);
  if (withDepthPrepass) transformed = patchMolstarDepthPrepassRenderItemSource(transformed);
  transformed = patchSphereOcclusionRenderItemSource(transformed)
    .replace(/^import .*;\r?\n/gm, '').replace(/export /g, '');
  vm.runInContext(transformed + '\nglobalThis.create=createGraphicsRenderItem;', context);
  const item = context.create(ctx, 'triangles', { name }, {}, values, 1, 'blended');
  return { item, programs, vaos, draws, values };
}

function rendererHarness(navigator: any, withDepthPrepass = false) {
  const submissions: Array<{ variant: string; renderable: any }> = [];
  const textureUpdates: any[] = [];
  let base = patchMolstarOpaqueRendererSource(patchMolstarBlendedTransparentSource(renderer));
  if (withDepthPrepass) base = patchMolstarDepthPrepassRendererSource(base);
  const patched = patchSphereOcclusionRendererSource(base);
  const context: any = vm.createContext({
    navigator, isTimingMode: false, clamp: (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x)),
    state: { disable() {}, enable() {}, depthMask() {}, colorMask() {}, depthFunc() {} }, updateInternal: (...args: any[]) => textureUpdates.push(args[2]),
    gl: { LEQUAL: 1, LESS: 2 }, Mask: { Opaque: 0 }, Flag: { None: 0 },
    renderObject: (r: any, variant: string) => submissions.push({ variant, renderable: r }),
  });
  const block = between(renderer, '        const checkOpaque = function', '        const checkTransparent = function');
  const pass = between(patched, '        const stereofoldQuestOpaque', '        const renderBlendedTransparent =');
  vm.runInContext(block + pass + '\nglobalThis.draw=renderOpaque;', context);
  return {
    submissions, textureUpdates,
    draw: (r: any, primary = true, texture: any = null) => context.draw({ renderables: [r] }, {}, primary, texture),
  };
}

describe('Quest sphere fragment occlusion candidate', () => {
  it('keeps the common chunk unchanged off Quest and qualifies only tDepth in the candidate', () => {
    const patched = patchSphereOcclusionCommonFragSource(common);
    expect(moduleValue(patched, 'common_frag_params')).toBe(moduleValue(common, 'common_frag_params'));
    expect(moduleValue(patched, 'common_frag_params', { userAgent: 'Safari Vision Pro', xr: {} })).toBe(moduleValue(common, 'common_frag_params'));
    const questChunk = moduleValue(patched, 'common_frag_params', quest);
    expect(questChunk).toMatch(/#if __VERSION__ >= 300 && defined\(dStereofoldSphereCull\)\r?\nuniform highp sampler2D tDepth;\r?\n#else\r?\nuniform sampler2D tDepth;\r?\n#endif/);
    expect(questChunk.match(/uniform (?:highp )?sampler2D tDepth;/g)).toHaveLength(2);
    expect(questChunk).not.toContain('precision highp sampler2D');
  });

  it('keeps the fragment stock off Quest and confines depth reads/discards to exact blended sphere variant', () => {
    const patched = patchSphereOcclusionFragmentSource(spheres, '5.11.0');
    const stock = moduleValue(patched, 'spheres_frag');
    const unchanged = moduleValue(spheres, 'spheres_frag');
    expect(stock).toBe(unchanged);
    expect(moduleValue(patched, 'spheres_frag', { userAgent: 'OculusBrowser/42' })).toBe(unchanged);
    const candidate = moduleValue(patched, 'spheres_frag', quest);
    expect(candidate).toContain('stereofoldSphereCullFront = -vPointViewPosition.z + vRadius');
    expect(candidate).toContain('texelFetch(tDepth, ivec2(gl_FragCoord.xy), 0).r');
    expect(candidate).toContain('if (stereofoldSphereCullEligible && fragmentDepth > stereofoldSphereCullProxyDepth + 0.00002) discard;');
    expect(candidate.indexOf('stereofoldSphereCullFrontDepth')).toBeLessThan(candidate.indexOf('bool hit = SphereImpostor'));
    expect(candidate.indexOf('fragmentDepth > stereofoldSphereCullProxyDepth')).toBeGreaterThan(candidate.indexOf('if (fragmentDepth > 1.0) discard;'));
    expect(candidate).toContain('#if __VERSION__ >= 300 && defined(dStereofoldSphereCull) && defined(dRenderVariant_colorBlended)');
    expect(candidate).not.toContain('uPrivate');
    expect(resolveSphereCullBlocks(candidate, false)).toBe(resolveSphereCullBlocks(unchanged, false));
    expect(resolveSphereCullBlocks(candidate, true)).toContain('texelFetch(tDepth, ivec2(gl_FragCoord.xy), 0).r');
    expect(resolveSphereCullBlocks(candidate, true)).toContain('stereofoldSphereCullEligible && fragmentDepth > stereofoldSphereCullProxyDepth');
  });

  it('registers and runs the candidate through Mol* lifecycle only on Quest spheres', () => {
    const questItem = itemHarness(quest);
    expect(questItem.programs).toHaveLength(7);
    expect(questItem.vaos).toHaveLength(7);
    const candidate = questItem.item.getProgram('colorSphereCull');
    expect(candidate.variant).toBe('colorBlended');
    expect(candidate.sphereCull).toBe(true);
    questItem.item.render('colorSphereCull', 0);
    expect(questItem.draws).toHaveLength(1);

    questItem.item.setTransparency('wboit');
    expect(questItem.item.getProgram('colorSphereCull').variant).toBe('colorWboit');
    expect(questItem.item.getProgram('colorSphereCull').sphereCull).toBe(false);
    questItem.item.setTransparency('blended');
    expect(questItem.item.getProgram('colorSphereCull').variant).toBe('colorBlended');
    expect(questItem.item.getProgram('colorSphereCull').sphereCull).toBe(true);
    questItem.values.dProbe.ref.value = true;
    questItem.values.dProbe.ref.version++;
    questItem.item.update();
    expect(questItem.programs.slice(0, 7).every(p => p.destroyed === 1)).toBe(true);
    expect(questItem.vaos.slice(0, 7).every(v => v.destroyed === 1)).toBe(true);
    questItem.item.destroy();
    expect(questItem.programs.every(p => p.destroyed === 1)).toBe(true);
    expect(questItem.vaos.every(v => v.destroyed === 1)).toBe(true);

    expect(itemHarness({ userAgent: 'Safari', xr: {} }).programs).toHaveLength(6);
    expect(itemHarness(quest, 'mesh').programs).toHaveLength(7); // existing mesh candidate only
    expect(itemHarness(quest, 'spheres', 'mesh').programs).toHaveLength(6);
    const depthPrepassMesh = itemHarness(quest, 'mesh', 'mesh', true);
    expect(depthPrepassMesh.programs).toHaveLength(8);
    expect(depthPrepassMesh.item.getProgram('depthOpaqueNoDiscard')).toBeTruthy();
    expect(depthPrepassMesh.item.getProgram('colorOpaqueNoDiscard')).toBeTruthy();
  });

  it('selects culling only for a ready Quest primary candidate with a supplied depth texture', () => {
    const h = rendererHarness(quest);
    const r = renderable();
    const texture = { id: 'primary-depth' };
    h.draw(r, true, texture);
    expect(h.submissions.at(-1)?.variant).toBe('color'); // candidate program is not present
    expect(h.textureUpdates.at(-1)).toBe(texture);

    r.getProgram = (name: string) => name === 'colorSphereCull' ? { isReady: () => true } : undefined;
    h.draw(r, true, texture);
    expect(h.submissions.at(-1)?.variant).toBe('colorSphereCull');
    expect(h.textureUpdates.at(-1)).toBe(texture);
    h.draw(r, true, null);
    expect(h.submissions.at(-1)?.variant).toBe('color');
    expect(h.textureUpdates.at(-1)).toBeNull();
    h.draw(r, false, texture);
    expect(h.submissions.at(-1)?.variant).toBe('color');
    expect(h.textureUpdates.at(-1)).toBeNull();

    const composed = rendererHarness(quest, true);
    composed.draw(r, true, texture);
    expect(composed.submissions.at(-1)?.variant).toBe('colorSphereCull');
    expect(composed.textureUpdates.at(-1)).toBe(texture);

    for (const [key, value] of Object.entries({ alpha: 0.5, uAlpha: 0.5, dApproximate: true, dClipObjectCount: 1,
      dTransparency: true, transparencyAverage: 0.1, dXrayShaded: 'on', dClipping: true, dWiggle: true, uLod: [1, 0, 0, 0], lodLevels: [[1]] })) {
      r.values[key] = cell(value);
      h.draw(r, true, texture);
      expect(h.submissions.at(-1)?.variant, key).toBe('color');
      r.values[key] = cell(key === 'uLod' ? [0, 0, 0, 0] : key === 'lodLevels' ? [] : key === 'dXrayShaded' ? 'off' : key === 'dTransparency' || key === 'dApproximate' || key === 'dClipping' || key === 'dWiggle' ? false : key === 'dClipObjectCount' || key === 'transparencyAverage' ? 0 : 1);
    }
    r.getProgram = (name: string) => name === 'colorSphereCull' ? { isReady: () => false, finalize: () => false } : undefined;
    h.draw(r, true, texture);
    expect(h.submissions.at(-1)?.variant).toBe('color');
  });

  it('fails closed on source drift and keeps generated functions self-contained for esbuild serialization', () => {
    const opaqueItem = patchMolstarOpaqueRenderItemSource(renderItem);
    const opaqueRenderer = patchMolstarOpaqueRendererSource(patchMolstarBlendedTransparentSource(renderer));
    expect(() => patchSphereOcclusionFragmentSource(spheres, '5.11.1')).toThrow('5.11.0');
    for (const fn of [
      () => patchSphereOcclusionCommonFragSource(common + common),
      () => patchSphereOcclusionFragmentSource(spheres + spheres, '5.11.0'),
      () => patchSphereOcclusionRenderItemSource(renderItem),
      () => patchSphereOcclusionRendererSource(renderer),
      () => patchSphereOcclusionRenderItemSource(patchSphereOcclusionRenderItemSource(opaqueItem)),
      () => patchSphereOcclusionRendererSource(patchSphereOcclusionRendererSource(opaqueRenderer)),
    ]) expect(fn).toThrow();
    expect(canUseSphereOcclusionRenderable(renderable())).toBe(true);
    const invalid = renderable({ uLod: [1, 0, 0, 0] });
    expect(canUseSphereOcclusionRenderable(invalid)).toBe(false);
    const typedLod = renderable({ uLod: new Float32Array([0, 0, 0, 0]) });
    expect(canUseSphereOcclusionRenderable(typedLod)).toBe(true);
    const probe = execFileSync(process.execPath, ['--import', 'tsx', '-e', `
      const fs=require('node:fs'),p=require('./src/molstar-sphere-occlusion-patch.ts'),o=require('./src/molstar-opaque-depth-patch.ts'),t=require('./src/molstar-transparent-mesh-patch.ts');
      const root='./node_modules/molstar/lib/mol-gl/';
      const files=[['patchSphereOcclusionRenderItemSource',o.patchMolstarOpaqueRenderItemSource(fs.readFileSync(root+'webgl/render-item.js','utf8'))],['patchSphereOcclusionRendererSource',o.patchMolstarOpaqueRendererSource(t.patchMolstarBlendedTransparentSource(fs.readFileSync(root+'renderer.js','utf8')))],['patchSphereOcclusionFragmentSource',fs.readFileSync(root+'shader/spheres.frag.js','utf8')],['patchSphereOcclusionCommonFragSource',fs.readFileSync(root+'shader/chunks/common-frag-params.glsl.js','utf8')]];
      for(const [name,source] of files){const result=name.includes('RenderItem')||name.includes('Renderer')||name.includes('Fragment')||name.includes('CommonFrag')?p[name](source,...(name.includes('Fragment')?['5.11.0']:[])):source;if(result.includes('__name'))throw Error(name+' emitted __name');}
    `], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
    expect(probe).toBe('');
  });
});
