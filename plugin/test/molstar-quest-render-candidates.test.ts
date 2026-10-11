import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { patchMolstarOpaqueDrawSource, patchMolstarOpaqueRendererSource, patchMolstarOpaqueRenderItemSource,
  patchMolstarOpaqueMeshSource } from '../src/molstar-opaque-depth-patch.js';
import { patchMolstarBlendedTransparentSource } from '../src/molstar-transparent-mesh-patch.js';
import { patchMolstarXrSinglePassDrawSource } from '../src/molstar-xr-single-pass-patch.js';
import { patchMolstarConservativeDepthSphereSource, patchMolstarShaderModuleSource, stereofoldShaderSource } from '../src/molstar-conservative-depth-patch.js';
import { patchMolstarImpostorScaleSource } from '../src/molstar-impostor-scale-patch.js';
import { patchMolstarSphereNormalsMeshFragSource, patchMolstarSpherePrimitiveSource, patchMolstarElementSphereSource,
  patchMolstarMeshRenderableSource } from '../src/molstar-sphere-normals-patch.js';
import { patchMolstarDepthPrepassRendererSource, patchMolstarDepthPrepassRenderItemSource, patchMolstarDepthPrepassMeshVertSource,
  patchMolstarDepthPrepassMeshFragSource } from '../src/molstar-depth-prepass-patch.js';
import { patchMolstarImpostorSplitSource } from '../src/molstar-impostor-split-patch.js';

const read = (path: string) => readFileSync(new URL('../node_modules/molstar/lib/' + path, import.meta.url), 'utf8');
const lf = (text: string) => text.replaceAll('\r\n', '\n');
const quest = { userAgent: 'Mozilla/5.0 (X11; Linux x86_64; Quest 2) OculusBrowser/40.0 Chrome/134.0', xr: {} };
const others = [undefined, { userAgent: 'Version/26 Safari/605.1.15', xr: {} }, { userAgent: 'Chrome/134.0', xr: {} }, { userAgent: 'OculusBrowser/40' }];
const cell = (value: any) => ({ ref: { value, version: 0 } });
const between = (s: string, a: string, b: string) => s.slice(s.indexOf(a), s.indexOf(b, s.indexOf(a)));

describe('one render pass per immersive Quest frame', () => {
  const stock = patchMolstarOpaqueDrawSource(read('mol-canvas3d/passes/draw.js'));
  const patched = patchMolstarXrSinglePassDrawSource(stock);
  function frame(source: string, navigator: any, { session = {} as any, transparentBackground = true, postprocessing = false, leftDisabled = false, rightDisabled = false,
    leftViewport = { x: 0, y: 0, width: 100, height: 100 }, rightViewport = { x: 100, y: 0, width: 100, height: 100 },
    failDrawAt = 0, inspectState = (_self: any) => {} } = {}) {
    const log: string[] = [];
    let draws = 0;
    const off = { isEnabled: () => false, isTransparentDepthRequired: () => false };
    const context: any = vm.createContext({ navigator, isTimingMode: false, isDebugMode: false,
      StereoCamera: { is: (c: any) => !!c.left }, PostprocessingPass: { ...off, isEnabled: () => postprocessing },
      AntialiasingPass: off, MarkingPass: off, DofPass: off, BloomPass: off, ValueCell: {}, Vec2: {}, WboitPass: class {}, DpoitPass: class {},
      createCopyRenderable: () => ({}) });
    vm.runInContext(source.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '') + '\nglobalThis.DrawPass = DrawPass;', context);
    const target = (name: string) => ({ bind: () => log.push(`bind ${name}`), framebuffer: null });
    const self: any = Object.create(context.DrawPass.prototype);
    Object.assign(self, { webgl: { xr: { session }, gl: { flush: () => log.push('flush'), DEPTH_TEST: 1 }, state: { disable() {} }, pixelRatio: 1 },
      transparencyMode: 'blended', wboit: { supported: false }, dpoit: { supported: false }, packedDepth: true,
      drawTarget: target('draw'), transparentColorTarget: target('transparent'), colorTarget: { ...target('color'), getWidth: () => 200, getHeight: () => 100 },
      postprocessing: { setTransparentBackground() {}, background: { isEnabled: () => false }, target: target('post'), render: () => log.push('post') },
      depthTextureOpaque: { attachFramebuffer() {}, detachFramebuffer() {} }, copyFboPostprocessing: { render() {} }, copyFboTarget: { render() {} } });
    const renderer = { props: { backgroundColor: 0 }, setTransparentBackground() {}, setDrawingBufferSize() {}, setPixelRatio() {}, update() {},
      setViewport: (x: number, y: number, w: number, h: number) => log.push(`viewport ${x},${y},${w},${h}`),
      clear: (bg: boolean) => log.push(`clear ${bg}`), renderOpaque: () => { if (++draws === failDrawAt) throw Error('injected eye draw failure'); log.push('opaque'); }, renderBlendedTransparent: () => log.push('transparent') };
    const scene = { volumes: { renderables: [] }, hasOpaque: true, opacityAverage: 0.5, markerAverage: 0, emissiveAverage: 0, primitives: {} };
    const helper = { debug: { isEnabled: false }, pointer: { isEnabled: false }, handle: { isEnabled: false }, camera: { isEnabled: false } };
    try {
      self.render({ renderer, camera: { left: { viewport: leftViewport, disabled: leftDisabled }, right: { viewport: rightViewport, disabled: rightDisabled } }, scene, helper },
        { postprocessing: {}, marking: {}, transparentBackground, dpoitIterations: 2 }, true);
    } finally { inspectState(self); }
    return log;
  }

  const twoPass = ['viewport 0,0,100,100', 'bind draw', 'clear false', 'bind draw', 'clear true', 'opaque', 'transparent', 'bind draw', 'bind draw', 'flush',
    'viewport 100,0,100,100', 'bind draw', 'clear false', 'bind draw', 'clear true', 'opaque', 'transparent', 'bind draw', 'bind draw', 'flush'];
  it('clears the union of both eyes once and flushes once on Quest', () => {
    expect(frame(stock, quest)).toEqual(twoPass);
    expect(frame(patched, quest)).toEqual(['viewport 0,0,200,100', 'bind draw', 'clear true',
      'viewport 0,0,100,100', 'bind draw', 'bind draw', 'opaque', 'transparent', 'bind draw', 'bind draw',
      'viewport 100,0,100,100', 'bind draw', 'bind draw', 'opaque', 'transparent', 'bind draw', 'bind draw', 'flush']);
  });
  it('keeps the stock two-pass frame off Quest, outside a session, and on offscreen paths', () => {
    for (const navigator of others) expect(frame(patched, navigator)).toEqual(twoPass);
    expect(frame(patched, quest, { session: null })).toEqual(twoPass);
    expect(frame(patched, quest, { postprocessing: true })).toEqual(frame(stock, quest, { postprocessing: true }));
  });
  it('retains stock clears and the remaining eye flush when either XR eye is disabled', () => {
    for (const disabled of [{ leftDisabled: true }, { rightDisabled: true }, { leftDisabled: true, rightDisabled: true }]) {
      const actual = frame(patched, quest, disabled);
      expect(actual).toEqual(frame(stock, quest, disabled));
      expect(actual.filter(entry => entry === 'flush')).toHaveLength(disabled.leftDisabled && disabled.rightDisabled ? 0 : 1);
    }
  });
  it('falls back for overlapping or invalid viewports, including fractional pixel boundaries', () => {
    for (const rightViewport of [
      { x: 99, y: 0, width: 100, height: 100 }, { x: 0, y: 0, width: 100, height: 100 },
      { x: 100, y: 0, width: 0, height: 100 }, { x: 100, y: 0, width: -1, height: 100 },
      { x: NaN, y: 0, width: 100, height: 100 }, { x: 100, y: Infinity, width: 100, height: 100 },
      { x: -100, y: 0, width: 100, height: 100 }, { x: 99.5, y: 0, width: 100, height: 100 },
      { x: Number.MAX_SAFE_INTEGER, y: 0, width: 100, height: 100 },
    ]) {
      expect(frame(patched, quest, { rightViewport })).toEqual(frame(stock, quest, { rightViewport }));
      const leftCase = { leftViewport: rightViewport, rightViewport: { x: 0, y: 0, width: 100, height: 100 } };
      expect(frame(patched, quest, leftCase)).toEqual(frame(stock, quest, leftCase));
    }
  });
  it('supports disjoint vertically packed eyes and restores the guard after an eye throws', () => {
    const log = frame(patched, quest, { rightViewport: { x: 0, y: 100, width: 100, height: 100 } });
    expect(log[0]).toBe('viewport 0,0,100,200');
    expect(log.filter(entry => entry.startsWith('clear'))).toEqual(['clear true']);
    expect(log.filter(entry => entry === 'flush')).toHaveLength(1);
    for (const failDrawAt of [1, 2]) {
      let after: any;
      expect(() => frame(patched, quest, { failDrawAt, inspectState: self => { after = self; } })).toThrow('injected eye draw failure');
      expect(after.stereofoldSinglePassEye).toBe(0);
    }
  });
  it('clears to the background colour once when the background is opaque', () => {
    expect(frame(patched, quest, { transparentBackground: false }).filter(entry => entry.startsWith('clear'))).toEqual(['clear true']);
    expect(frame(stock, quest, { transparentBackground: false }).filter(entry => entry.startsWith('clear'))).toEqual(['clear true', 'clear true']);
  });
});

describe('conservative depth for Quest sphere impostors', () => {
  const version = '5.11.0';
  const patchedVert = patchMolstarConservativeDepthSphereSource(patchMolstarImpostorScaleSource(read('mol-gl/shader/spheres.vert.js'), 'spheres.vert', version), 'spheres.vert');
  const frag = patchMolstarConservativeDepthSphereSource(patchMolstarImpostorScaleSource(read('mol-gl/shader/spheres.frag.js'), 'spheres.frag', version), 'spheres.frag');
  const glWith = (extension: boolean) => ({ getExtension: (name: string) => extension && name === 'EXT_conservative_depth' ? {} : null }) as any;
  function source(navigator: any, gl: any, type: string, text: string) {
    const context: any = vm.createContext({ navigator });
    vm.runInContext(`globalThis.f = ${stereofoldShaderSource.toString()};`, context);
    return context.f(gl, type, text);
  }
  const assembled = '#version 300 es\nlayout(location = 0) out highp vec4 out_FragData0;\n#define stereofoldConservativeDepthRequest\nvoid main() {}\n';

  it('enables the extension only for requesting shaders on Quest with the extension', () => {
    expect(source(quest, glWith(true), 'frag', assembled)).toBe(`#version 300 es\n#extension GL_EXT_conservative_depth : enable\n#define stereofoldConservativeDepth\n${assembled.slice(16)}`);
    expect(source(quest, glWith(true), 'vert', assembled)).toBe(`#version 300 es\n#define stereofoldConservativeDepth\n${assembled.slice(16)}`);
    expect(source(quest, glWith(false), 'frag', assembled)).toBe(assembled);
    expect(source(quest, glWith(true), 'frag', assembled.replace('#define stereofoldConservativeDepthRequest\n', ''))).toBe(assembled.replace('#define stereofoldConservativeDepthRequest\n', ''));
    for (const navigator of others) expect(source(navigator, glWith(true), 'frag', assembled)).toBe(assembled);
  });
  it('declares depth_greater and moves only the rasterized quad depth, after the ray varyings', () => {
    expect(lf(frag)).toMatch(/#ifdef stereofoldConservativeDepth\n\s+layout \(depth_greater\) out highp float gl_FragDepth;\n#endif/);
    const vert = lf(patchedVert);
    const moved = vert.indexOf('gl_Position.z = stereofoldFrontZ * gl_Position.w;');
    expect(moved).toBeGreaterThan(vert.indexOf('vPoint = vPoint4.xyz / vPoint4.w;'));
    expect(moved).toBeGreaterThan(vert.indexOf('mvPosition.z -= 2.0 * vRadius; // avoid clipping'));
    expect(moved).toBeLessThan(vert.indexOf('gl_Position.z = 2.0 * gl_Position.w;'));
    expect(vert.slice(vert.indexOf('vec4 stereofoldFront'), moved)).toContain('#if defined(stereofoldConservativeDepth) && !defined(dApproximate)');
    expect(patchMolstarShaderModuleSource(read('mol-gl/webgl/shader.js'))).toContain('gl.shaderSource(shader, stereofoldShaderSource(gl, type, source));');
  });
  it('keeps the nearest depth plane conservative for every visible sphere point', () => {
    // Window depth of view z under a perspective projection, as calcDepth computes it.
    const near = 0.1, far = 100, depth = (z: number) => { const a = -(far + near) / (far - near), b = -2 * far * near / (far - near);
      return 0.5 + 0.5 * (a * z + b) / -z; };
    for (const [cz, r] of [[-5, 1], [-50, 3], [-0.6, 0.5], [-99, 0.9]]) {
      const front = depth(cz + r * 1.0001);
      for (let i = 0; i <= 64; i++) {
        const theta = (i / 64) * Math.PI / 2, z = cz + r * Math.cos(theta);
        if (z < -near) expect(depth(z)).toBeGreaterThanOrEqual(front);
      }
    }
  });
});

describe('smooth normals for Quest sphere meshes', () => {
  // The fragment reconstruction in JavaScript: p = c + r * n across a triangle.
  const sub = (a: number[], b: number[]) => a.map((v, i) => v - b[i]!), add = (a: number[], b: number[]) => a.map((v, i) => v + b[i]!);
  const mul = (a: number[], s: number) => a.map(v => v * s), dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * b[i]!, 0);
  const norm = (a: number[]) => mul(a, 1 / Math.sqrt(dot(a, a)));
  const lerp = (w: number[], v: number[][]) => [0, 1, 2].map(k => w.reduce((s, wi, i) => s + wi * v[i]![k]!, 0));
  function reconstruct(p: number[], n: number[], dp: number[], dn: number[]) {
    const r = Math.sqrt(dot(dp, dp) / dot(dn, dn)), c = sub(p, mul(n, r)), d = norm(p);
    const b = dot(d, c), disc = b * b - dot(c, c) + r * r;
    return norm(sub(mul(d, b - Math.sqrt(disc)), c));
  }
  it('recovers the exact ray-cast sphere normal from interpolated position and radial normal', () => {
    const c = [0.3, -0.2, -4], r = 0.7;
    const dirs = [norm([0.2, 0.9, 0.4]), norm([-0.7, 0.3, 0.6]), norm([0.4, -0.5, 0.75])];
    const verts = dirs.map(d => add(c, mul(d, r)));
    for (const w of [[1 / 3, 1 / 3, 1 / 3], [0.7, 0.2, 0.1], [0.05, 0.05, 0.9]]) {
      const w2 = [w[0]! + 1e-3, w[1]! - 1e-3, w[2]!];
      const p = lerp(w, verts), n = lerp(w, dirs);
      const got = reconstruct(p, n, sub(lerp(w2, verts), p), sub(lerp(w2, dirs), n));
      const d = norm(p), b = dot(d, c), t = b - Math.sqrt(b * b - dot(c, c) + r * r);
      const expected = norm(sub(mul(d, t), c));
      for (let k = 0; k < 3; k++) expect(got[k]).toBeCloseTo(expected[k]!, 9);
      expect(Math.abs(dot(norm(n), expected))).toBeLessThan(1);
    }
  });
  it('marks element-sphere meshes, sets radial normals and defines only on Quest', () => {
    const element = patchMolstarElementSphereSource(read('mol-repr/structure/visual/util/element.js'));
    const create = element.indexOf('export function createElementSphereMesh');
    expect(element.indexOf('m.meta.stereofoldSphere = true;')).toBeGreaterThan(create);
    expect(element.split('m.meta.stereofoldSphere = true;')).toHaveLength(2);
    expect(patchMolstarSpherePrimitiveSource(read('mol-geo/primitive/sphere.js'))).toContain('sphere.normals.set(sphere.vertices);');
    const renderable = patchMolstarMeshRenderableSource(read('mol-gl/renderable/mesh.js'));
    const define = lf(renderable).match(/dStereofoldSphereNormals: ValueCell\.create\(([\s\S]*?)\),\n    \};/)![1]!;
    for (const [navigator, meta, expected] of [[quest, { stereofoldSphere: true }, true], [quest, {}, false], ...others.map(n => [n, { stereofoldSphere: true }, false])] as const) {
      const context: any = vm.createContext({ navigator, values: { meta: cell(meta) } });
      expect(vm.runInContext(define, context)).toBe(expected);
    }
    const frag = patchMolstarSphereNormalsMeshFragSource(read('mol-gl/shader/mesh.frag.js'));
    expect(frag).toContain('vec3 normal = -stereofoldSphereNormal(vViewPosition, vNormal);');
    expect(patchMolstarOpaqueMeshSource(frag)).toContain('stereofoldFastOpaqueMesh');
  });
});

describe('depth pre-pass for Quest opaque meshes', () => {
  const renderer = read('mol-gl/renderer.js');
  const patched = patchMolstarDepthPrepassRendererSource(patchMolstarOpaqueRendererSource(patchMolstarBlendedTransparentSource(renderer)));
  const fields = { alpha: 1, transparencyAverage: 0, dTransparency: false, dGeometryType: 'mesh', dXrayShaded: 'off',
    dClipObjectCount: 0, uDoubleSided: false, hasReflection: false, dFlipSided: false, dTransparentBackfaces: 'off', uLod: [0, 0, 0, 0] };
  function object(overrides: Record<string, any> = {}, ready = true) {
    const depth = { ready, isReady: () => depth.ready, finalize: () => depth.ready };
    return { state: { alphaFactor: 1 }, values: Object.fromEntries(Object.entries({ ...fields, ...overrides }).map(([k, v]) => [k, cell(v)])),
      getProgram: (name: string) => name === 'depthOpaqueNoDiscard' ? depth : {}, depth };
  }
  function pass(navigator: any) {
    const log: string[] = [];
    const context: any = vm.createContext({ navigator, isTimingMode: false,
      clamp: (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x)), gl: { LEQUAL: 515, LESS: 513 },
      state: { disable() {}, enable() {}, depthMask() {}, colorMask: (...m: boolean[]) => log.push(`mask ${m.map(Number).join('')}`),
        depthFunc: (f: number) => log.push(f === 515 ? 'LEQUAL' : 'LESS') },
      updateInternal() {}, Mask: { Opaque: 0 }, Flag: { None: 0 }, renderObject: (_r: any, variant: string) => log.push(variant) });
    vm.runInContext(between(renderer, '        const checkOpaque = function', '        const checkTransparent = function')
      + between(patched, '        const stereofoldQuestOpaque', '        const renderBlendedTransparent =') + '\nglobalThis.draw=renderOpaque;', context);
    return { log, draw: (renderables: any[], primary = true) => context.draw({ renderables }, {}, primary) };
  }
  it('lays eligible mesh depth first, then shades colour with LEQUAL and restores LESS', () => {
    const h = pass(quest);
    h.draw([object(), object({ alpha: 0.5 }), object({ dGeometryType: 'spheres' })]);
    expect(h.log).toEqual(['mask 0000', 'depthOpaqueNoDiscard', 'mask 1111', 'LEQUAL', 'colorOpaqueNoDiscard', 'color', 'LESS']);
  });
  it('skips the pre-pass for a depth program that is not linked yet, off the primary scene and off Quest', () => {
    const h = pass(quest); h.draw([object({}, false)]);
    expect(h.log).toEqual(['mask 0000', 'mask 1111', 'colorOpaqueNoDiscard']);
    const helper = pass(quest); helper.draw([object()], false); expect(helper.log).toEqual(['color']);
    for (const navigator of others) { const other = pass(navigator); other.draw([object()]); expect(other.log).toEqual(['color']); }
  });
  it('builds the depth-only variant beside the no-discard colour variant with invariant positions', () => {
    const item = patchMolstarDepthPrepassRenderItemSource(patchMolstarOpaqueRenderItemSource(read('mol-gl/webgl/render-item.js')));
    expect(item).toContain("[...GraphicsRenderVariants, 'colorOpaqueNoDiscard', 'depthOpaqueNoDiscard']");
    expect(lf(item)).toMatch(/if \(variant === 'depthOpaqueNoDiscard'\) \{\n\s+variant = 'depth';\n\s+defineValues = \{ \.\.\.defineValues, dStereofoldOpaqueNoDiscard/);
    expect(lf(patchMolstarDepthPrepassMeshVertSource(read('mol-gl/shader/mesh.vert.js')))).toMatch(/#ifdef dStereofoldOpaqueNoDiscard\n\s+invariant gl_Position;\n#endif/);
    const frag = lf(patchMolstarOpaqueMeshSource(patchMolstarDepthPrepassMeshFragSource(read('mol-gl/shader/mesh.frag.js'))));
    expect(frag).toMatch(/#if defined\(dStereofoldOpaqueNoDiscard\) && defined\(dRenderVariant_depth\)\n\s+gl_FragColor = vec4\(0\.0\);\n\s+return;/);
  });
});

describe('measurement-only impostor split', () => {
  const frag = patchMolstarImpostorScaleSource(read('mol-gl/shader/spheres.frag.js'), 'spheres.frag', '5.11.0');
  // The ray-cast branch; the approximate-sphere branch above it is not compiled for impostors.
  const body = (text: string) => lf(text).slice(lf(text).indexOf('bool hit = SphereImpostor('));
  it('keeps exactly one of discard and the depth write', () => {
    const discard = body(patchMolstarImpostorSplitSource(frag, 'discard'));
    expect(discard).toContain('if (!hit) discard;'); expect(discard).not.toContain('gl_FragDepthEXT = fragmentDepth;');
    const depth = body(patchMolstarImpostorSplitSource(frag, 'depth'));
    expect(depth).not.toMatch(/\bdiscard\b|#include (fade_lod|check_transparency)/); expect(depth).toContain('gl_FragDepthEXT = fragmentDepth;');
    expect(depth).toContain('if (!hit || fragmentDepth < 0.0 || fragmentDepth > 1.0) fragmentDepth = 1.0;');
    const neither = body(patchMolstarImpostorSplitSource(frag, 'neither'));
    expect(neither).not.toMatch(/\bdiscard\b|gl_FragDepthEXT = fragmentDepth;/);
  });
});
