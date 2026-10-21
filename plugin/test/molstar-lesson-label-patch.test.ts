import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import ts from 'typescript';
import vm from 'node:vm';
import { labelCell } from './helpers/molstar-label-runtime.js';
import { countingGlHarness } from './helpers/molstar-counting-gl.js';
import { labelPassBaseline } from './helpers/molstar-label-pass-baseline.js';
import { GlobalUniformSchema, GlobalTextureSchema, UniformSpec, TextureSpec } from 'molstar/lib/mol-gl/renderable/schema.js';
import { patchLessonLabelRenderer, patchLessonLabelDraw, patchLessonLabelRenderItem, patchLessonLabelFragment } from '../src/molstar-lesson-label-patch.js';
import { patchMolstarOpaqueRendererSource, patchMolstarOpaqueRenderItemSource, patchMolstarOpaqueDrawSource } from '../src/molstar-opaque-depth-patch.js';
import { patchMolstarXrSinglePassDrawSource } from '../src/molstar-xr-single-pass-patch.js';

const read = (path: string) => readFileSync(new URL(`../node_modules/molstar/lib/${path}`, import.meta.url), 'utf8');
const source = read('mol-gl/renderer.js');
let api: any, baselineApi: any;
beforeAll(async () => {
  for (const baseline of [false, true]) {
    const built = await build({ stdin: { resolveDir: new URL('..', import.meta.url).pathname, contents: `
      export { Renderer } from 'molstar/lib/mol-gl/renderer.js';
      export { createRenderable } from 'molstar/lib/mol-gl/renderable.js';
      export { Camera } from 'molstar/lib/mol-canvas3d/camera.js';
      export { Mat4 } from 'molstar/lib/mol-math/linear-algebra.js';
      export { ValueCell } from 'molstar/lib/mol-util/value-cell.js';
      export { LabelRepresentation, LabelParams } from 'molstar/lib/mol-repr/shape/loci/label.js';
      export { DataLoci } from 'molstar/lib/mol-model/loci.js';
      export { setCanvasModule } from 'molstar/lib/mol-geo/geometry/text/font-atlas.js';
      export { registerImmersiveAnnotation } from '../lab/browser-roundtrip/immersive-annotations.mjs';
    ` }, bundle: true, platform: 'node', format: 'esm', write: false, plugins: [{ name: 'actual-renderer', setup(b) {
      b.onLoad({ filter: /mol-gl[/\\]renderer\.js$/ }, () => {
        let contents = patchLessonLabelRenderer(source);
        if (baseline) contents = contents.slice(0, contents.indexOf('        const renderLessonLabels ='))
          + labelPassBaseline + contents.slice(contents.indexOf('        const checkOpaque ='));
        return { contents, loader: 'js' };
      });
    } }] });
    const builtApi = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0]!.text).toString('base64'));
    if (baseline) baselineApi = builtApi; else api = builtApi;
  }
  api.setCanvasModule({ createCanvas: () => ({ getContext: () => ({ measureText: () => ({ width: 4 }), clearRect() {}, fillText() {},
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4).fill(255) }),
  }) }) });
});

// Actual Mol* renderer, camera, representation, geometry and renderable. The
// final GL draw is a depth-test adapter, not a GPU or pixel qualification.
async function fixture() {
  const cell = await labelCell(api, undefined, { background: true, backgroundOpacity: .9 });
  const repr = cell.b.data.repr;
  api.registerImmersiveAnnotation(repr);
  const object = repr.renderObjects[0];
  let depth = 'LEQUAL', mask = true, submissions = 0, passed = 0;
  let failAt = 0, materialResets = 0, uniformList: any;
  const gl = { drawingBufferWidth: 200, drawingBufferHeight: 200, DEPTH_TEST: 1, BLEND: 2, SCISSOR_TEST: 3,
    GREATER: 'GREATER', LEQUAL: 'LEQUAL', SRC_ALPHA: 4, ONE_MINUS_SRC_ALPHA: 5, ONE: 6 };
  const state: any = { currentProgramId: -1, currentMaterialId: -1, currentRenderItemId: -1, enable() {}, disable() {},
    depthMask(v: boolean) { mask = v; }, depthFunc(v: string) { depth = v; }, blendFunc() {}, blendFuncSeparate() {},
    colorMask() {}, viewport() {}, scissor() {}, frontFace() {}, cullFace() {} };
  const ctx = { gl, state, stats: {}, resources: { texture: () => ({ define() {}, load() {}, destroy() {} }) } };
  const renderer = api.Renderer.create(ctx);
  const camera = new api.Camera();
  camera.viewport.width = 200; camera.viewport.height = 200;
  camera.setState({ position: [0, 0, 50], target: [0, 0, 0], radius: 10, radiusMax: 100 }); camera.update();
  const programs: any = {};
  for (const [i, variant] of ['color', 'depth', 'colorLabelExposed', 'colorLabelOccluded'].entries()) programs[variant] = {
    id: i, use() { state.currentProgramId = i; }, bindTextures() {}, setUniforms(list: any) { uniformList = list; },
  };
  const item = { id: 1, materialId: 1, getProgram: (v: string) => programs[v], render(variant: string) {
    if (failAt === submissions + 1) throw Error('draw failed');
    submissions++;
    if (state.currentMaterialId === -1) materialResets++;
    // A plate behind opaque geometry: only its GREATER submission survives.
    if (depth === 'GREATER') { expect(variant).toBe('colorLabelOccluded'); passed++; }
    state.currentMaterialId = 1;
  } };
  const renderable = api.createRenderable(item, object.values, object.state);
  const group = { view: api.Mat4.identity(), renderables: [renderable] };
  renderer.setViewport(0, 0, 200, 200); renderer.update(camera, { markerAverage: 0 });
  return { repr, object, renderer, camera, group, state, renderable,
    reset() { submissions = passed = materialResets = failAt = 0; }, fail(at = 1) { failAt = at; },
    get uniforms() { return uniformList; }, get depth() { return depth; }, get mask() { return mask; },
    get submissions() { return submissions; }, get passed() { return passed; }, get materialResets() { return materialResets; } };
}

describe('lesson label visibility with installed Mol*', () => {
  it('counts 11 moving plates in two eyes before/after, with uniform caching on and off', async () => {
    const cell = await labelCell(api, undefined, { background: true, backgroundOpacity: .9 });
    const repr = cell.b.data.repr;
    api.registerImmersiveAnnotation(repr);
    const object = repr.renderObjects[0];
    function run(runtime: any, cached: boolean, plateCount = 11) {
      const h = countingGlHarness(cached);
      const schema = { ...GlobalUniformSchema, ...GlobalTextureSchema,
        uColor: UniformSpec('v3', 'material'), uAlpha: UniformSpec('f', 'material'), uRoughness: UniformSpec('f', 'material'),
        uClip: UniformSpec('v4'), uTexDim: UniformSpec('v2'), uTransform: UniformSpec('m4'), uObjectId: UniformSpec('i'),
        tColor: TextureSpec('texture', 'rgba', 'ubyte', 'nearest') };
      const renderables = Array.from({ length: plateCount }, (_, i) => {
        const values = { ...object.values };
        for (const [k, v] of Object.entries({ drawCount: 3, instanceCount: 1, uColor: [.2, .5, .7], uAlpha: 1,
          uRoughness: .5, uClip: [0, 0, 0, 0], uTexDim: [32, 32], uTransform: runtime.Mat4.identity(),
          uObjectId: i, tColor: h.texture })) values[k] = runtime.ValueCell.create(v);
        // Real plates have distinct material IDs even when styles match.
        const itemValues = Object.fromEntries(Object.entries(values).filter(([k]) => k in schema || k === 'drawCount' || k === 'instanceCount'));
        return runtime.createRenderable(h.item(schema, itemValues, 'text', i), values, { ...object.state });
      });
      const group = { view: runtime.Mat4.identity(), renderables };
      const camera = new runtime.Camera();
      camera.viewport.width = camera.viewport.height = 200;
      camera.setState({ position: [0, 0, 50], target: [0, 0, 0], radius: 10, radiusMax: 100 }); camera.update();
      const renderer = runtime.Renderer.create(h.ctx);
      renderer.setViewport(0, 0, 200, 200);
      const perFrame: any[] = [], frames: any[][] = [], picks: any[][] = [];
      for (let frame = 0; frame < 3; frame++) {
        // Exercise in-place motion and changed authored material values.
        renderables[0].values.uTransform.ref.value[12] = frame;
        renderables[Math.min(4, plateCount - 1)].values.uColor.ref.value[0] = frame * .1;
        if (frame === 1) group.renderables = [...renderables].reverse();
        const start = { switches: h.switches(), uniforms: h.calls(), draws: h.draws.length, ...h.resets };
        const frameDraws: any[] = [];
        for (let eye = 0; eye < 2; eye++) {
          runtime.Mat4.setIdentity(camera.viewEye); camera.viewEye[12] = eye ? .032 : -.032;
          renderer.update(camera, { markerAverage: 0 });
          const first = h.submissions.length;
          renderer.renderLessonLabels(group, camera);
          frameDraws.push(...h.submissions.slice(first).map(s => ({ ...s, eye })));
        }
        perFrame.push({ programs: h.switches() - start.switches, uniforms: h.calls() - start.uniforms,
          draws: h.draws.length - start.draws, materialResets: h.resets.material - start.material,
          itemResets: h.resets.item - start.item });
        frames.push(frameDraws);
        // Picking stays ordinary; also leave a different program active before
        // the next frame to exercise entry after another renderer pass.
        const first = h.submissions.length;
        renderer.renderPick(group, camera, 'pick');
        picks.push(h.submissions.slice(first));
      }
      return { perFrame, frames, picks };
    }
    try {
      let uncachedFrames: any;
      for (const cached of [false, true]) {
        const before = run(baselineApi, cached), after = run(api, cached);
        const normalize = (frame: any[]) => [...frame].sort((a, b) => a.eye - b.eye
          || a.depth.localeCompare(b.depth) || a.values.uObjectId - b.values.uObjectId);
        expect(after.frames.map(normalize)).toEqual(before.frames.map(normalize));
        if (cached) expect(after.frames).toEqual(uncachedFrames);
        else uncachedFrames = after.frames;
        expect(after.picks).toEqual(before.picks);
        for (const frame of after.frames) {
          for (let eye = 0; eye < 2; eye++) {
            const draws = frame.filter(s => s.eye === eye);
            expect(draws.map(s => s.depth)).toEqual([...Array(11).fill('GREATER'), ...Array(11).fill('LEQUAL')]);
            expect(draws.slice(0, 11).map(s => s.values.uObjectId)).toEqual(draws.slice(11).map(s => s.values.uObjectId));
            expect(draws.every(s => !s.depthMask)).toBe(true);
          }
        }
        expect(before.perFrame.map(f => f.programs)).toEqual([44, 44, 44]);
        expect(after.perFrame.map(f => f.programs)).toEqual([4, 4, 4]);
        expect(after.perFrame.map(f => f.draws)).toEqual([44, 44, 44]);
        expect(before.perFrame.map(f => [f.materialResets, f.itemResets])).toEqual([[46, 48], [46, 48], [46, 48]]);
        expect(after.perFrame.map(f => [f.materialResets, f.itemResets])).toEqual([[4, 2], [4, 2], [4, 2]]);
        expect(after.perFrame.every((f, i) => f.uniforms < before.perFrame[i].uniforms)).toBe(true);
        console.log('11 plates, two eyes; label-only calls/frame', JSON.stringify({ cached, before: before.perFrame, after: after.perFrame }));
        // The same render item immediately changes variant for one plate;
        // there is no intervening object to invalidate its VAO/uniform state.
        expect(run(api, cached, 1).frames).toEqual(run(baselineApi, cached, 1).frames);
      }
    } finally { repr.destroy(); }
  });

  it('draws a buried plate despite object occlusion, without moving it or writing depth', async () => {
    const h = await fixture();
    try {
      const positions = h.object.values.aPosition.ref.value.slice(), transform = h.object.values.aTransform.ref.value.slice();
      expect(h.object.values.aTexCoord.ref.value.some((v: number) => v === 10)).toBe(true); // real background quad
      // An exposed plate must also bypass ordinary color submissions. Mol*
      // passes 'color' here; the render item chooses its blended shader later.
      h.renderer.setOcclusionTest(null);
      h.renderer.renderOpaque(h.group, h.camera);
      h.renderer.renderBlendedTransparent(h.group, h.camera);
      expect(h.submissions).toBe(0);
      h.renderer.setOcclusionTest(() => true);
      h.renderer.renderOpaque(h.group, h.camera);
      h.renderer.renderBlendedTransparent(h.group, h.camera);
      h.renderer.renderDepthOpaque(h.group, h.camera);
      expect(h.submissions).toBe(0);
      h.renderer.renderLessonLabels(h.group, h.camera);
      expect(h.submissions).toBe(2); expect(h.passed).toBe(1); expect(h.materialResets).toBe(2);
      expect(h.mask).toBe(false); expect(h.depth).toBe('LEQUAL');
      expect(h.object.values.aPosition.ref.value).toEqual(positions);
      expect(h.object.values.aTransform.ref.value).toEqual(transform);
      h.object.state.visible = false; h.reset(); h.renderer.renderLessonLabels(h.group, h.camera); expect(h.submissions).toBe(0);
      h.object.state.visible = true; h.object.state.stereofoldLessonLabel = false;
      h.renderer.renderLessonLabels(h.group, h.camera); expect(h.submissions).toBe(0);
      h.renderer.setOcclusionTest(null); h.renderer.renderOpaque(h.group, h.camera); expect(h.submissions).toBeGreaterThan(0);
    } finally { h.repr.destroy(); }
  });

  it('reuses all uniform cells/boxes and collection storage for 1,000 frames and both eye matrices', async () => {
    const h = await fixture();
    try {
      h.renderer.renderLessonLabels(h.group, h.camera); h.reset();
      const list = h.uniforms, boxes = list.map((entry: any) => entry[1].ref);
      const update = api.ValueCell.update, create = api.ValueCell.create;
      const forbidden = () => { throw Error('frame-local ValueCell allocation'); };
      api.ValueCell.update = api.ValueCell.create = forbidden;
      try {
        for (let i = 0; i < 1000; i++) {
          api.Mat4.setIdentity(h.camera.viewEye); h.camera.viewEye[12] = i % 2 ? .032 : -.032;
          h.renderer.renderLessonLabels(h.group, h.camera);
        }
      } finally { api.ValueCell.update = update; api.ValueCell.create = create; }
      expect(h.submissions).toBe(2000); expect(h.passed).toBe(1000);
      expect(h.uniforms).toBe(list);
      list.forEach((entry: any, i: number) => expect(entry[1].ref).toBe(boxes[i]));
      expect(list.find((entry: any) => entry[0] === 'uHasEyeCamera')[1].ref.value).toBe(true);
    } finally { h.repr.destroy(); }
  });

  it.each([1, 2])('restores depth and invalidates partial GL state when submission %i fails', async at => {
    const h = await fixture();
    try { h.fail(at); expect(() => h.renderer.renderLessonLabels(h.group, h.camera)).toThrow('draw failed');
      expect(h.depth).toBe('LEQUAL'); expect(h.state.currentMaterialId).toBe(-1);
      expect(h.state.currentRenderItemId).toBe(-1); expect(h.state.currentProgramId).toBe(-1);
      h.reset(); h.renderer.renderLessonLabels(h.group, h.camera); expect(h.submissions).toBe(2);
    } finally { h.repr.destroy(); }
  });

  it('retains the opt-in across a real label geometry rebuild without changing authored plate style', async () => {
    const h = await fixture();
    try {
      const before = h.repr.props, version = h.repr.geometryVersion;
      await h.repr.createOrUpdate({ customText: 'Updated pocket label', backgroundMargin: .5 }).run();
      expect(h.repr.geometryVersion).toBeGreaterThan(version);
      expect(h.repr.renderObjects.every((o: any) => o.state.stereofoldLessonLabel)).toBe(true);
      expect(h.repr.props.backgroundOpacity).toBe(before.backgroundOpacity);
      expect(h.repr.props.sizeFactor).toBe(before.sizeFactor);
      expect(h.repr.props.offsetZ).toBe(before.offsetZ);
    } finally { h.repr.destroy(); }
  });

  it('has no allocation expressions or collection building in the added frame path', () => {
    const patched = patchLessonLabelRenderer(source);
    const path = patched.slice(patched.indexOf('const updateLessonLabelCell'), patched.indexOf('        const checkOpaque'));
    const ast = ts.createSourceFile('frame.js', path, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const allocations: string[] = [];
    function visit(n: ts.Node) {
      if (ts.isNewExpression(n) || ts.isArrayLiteralExpression(n) || ts.isObjectLiteralExpression(n)
        || ts.isCallExpression(n) && /\.(map|filter|slice|concat|from|create|updateIfChanged|update)$/.test(n.expression.getText(ast))) allocations.push(n.getText(ast));
      ts.forEachChild(n, visit);
    }
    visit(ast); expect(allocations).toEqual([]);
  });

  it('composes with Quest patches, draws before UI depth reset and has explicit blended shaders for OIT', () => {
    expect(() => patchLessonLabelRenderer(patchMolstarOpaqueRendererSource(source))).not.toThrow();
    const draw = patchMolstarXrSinglePassDrawSource(patchMolstarOpaqueDrawSource(patchLessonLabelDraw(read('mol-canvas3d/passes/draw.js'))), true);
    expect(draw.indexOf('renderer.renderLessonLabels')).toBeLessThan(draw.indexOf('helper.debug.syncVisibility'));
    expect(draw).toContain("if (oitEnabled) this.depthTextureOpaque.attachFramebuffer(lessonTarget.framebuffer, 'depth')");
    const item = patchLessonLabelRenderItem(patchMolstarOpaqueRenderItemSource(read('mol-gl/webgl/render-item.js')));
    expect(item).toContain("variant = 'colorBlended'");
    const fragment = patchLessonLabelFragment(read('mol-gl/shader/text.frag.js'));
    expect(fragment).toContain('material.a *= 0.65');
    for (const patch of [patchLessonLabelRenderer, patchLessonLabelDraw, patchLessonLabelRenderItem, patchLessonLabelFragment]) expect(() => patch('')).toThrow();
  });

  it('scopes the SDF define to both lesson variants without leaking into ordinary text or picking', () => {
    const item = patchLessonLabelRenderItem(read('mol-gl/webgl/render-item.js'));
    const start = item.indexOf('function createProgramVariant(');
    const end = item.indexOf('\n//', start);
    const captured: any[] = [];
    const ctx = { resources: { program: (defines: any, _code: any, schema: any) => captured.push({ defines, schema }) } };
    const runtime: any = vm.createContext({ ValueCell: { create: (value: any) => ({ ref: { value } }) }, DefineSpec: (type: string) => ({ type }) });
    vm.runInContext(item.slice(start, end) + '\nglobalThis.create = createProgramVariant;', runtime);
    const defines = {}, schema = {};
    for (const variant of ['colorLabelExposed', 'colorLabelOccluded', 'colorBlended', 'pick', 'depth'])
      runtime.create(ctx, variant, defines, {}, schema);
    for (const [i, result] of captured.entries()) {
      expect(result.defines.dStereofoldLabelSdf?.ref.value).toBe(i < 2 ? true : undefined);
      expect(result.defines.dStereofoldOccludedLabel?.ref.value).toBe(i < 2 ? i === 1 : undefined);
      expect(result.defines.dRenderVariant.ref.value).toBe(['colorBlended', 'colorBlended', 'colorBlended', 'pick', 'depth'][i]);
      expect(result.schema.dStereofoldLabelSdf?.type).toBe(i < 2 ? 'boolean' : undefined);
    }
    expect(defines).toEqual({});
  });

  it('takes derivatives before divergent control flow and rejects changed SDF anchors', () => {
    const source = read('mol-gl/shader/text.frag.js');
    const patched = patchLessonLabelFragment(source);
    const runtime: any = vm.createContext({});
    vm.runInContext(patched.replace('export const text_frag', 'globalThis.fragment'), runtime);
    const fragment = runtime.fragment as string;
    expect(fragment.indexOf('fwidth(labelSdf)')).toBeLessThan(fragment.indexOf('#include fade_lod'));
    expect(fragment).toContain('0.5 * fwidth(labelSdf)');
    expect(fragment).toContain('1.0 / 255.0');
    expect(fragment).toContain('material.a *= labelCoverage');
    expect(fragment).toContain('#if defined(dStereofoldUiSdf) && defined(dRenderVariant_colorBlended)');
    expect(fragment).toContain('mix(uBorderColor, material.xyz, inkCoverage)');
    for (const anchor of ['void main(){', '        if (sdf < 0.5) discard;', '                material.xyz = uBorderColor;'])
      expect(() => patchLessonLabelFragment(source.replace(anchor, 'changed'))).toThrow();
  });

  it('admits the UI coverage define only for opted-in text render items', () => {
    const item = patchLessonLabelRenderItem(read('mol-gl/webgl/render-item.js'));
    const guard = item.match(/if \(shaderCode.name === 'text' && values.dStereofoldUiSdf\) schema = [^;]+;/)![0];
    for (const name of ['text', 'mesh']) for (const optIn of [false, true]) {
      const runtime: any = vm.createContext({ shaderCode: { name }, values: optIn ? { dStereofoldUiSdf: {} } : {},
        schema: {}, DefineSpec: (type: string) => ({ type }) });
      vm.runInContext(guard, runtime);
      expect(runtime.schema.dStereofoldUiSdf?.type).toBe(name === 'text' && optIn ? 'boolean' : undefined);
    }
  });

  it('executes the real draw pass: labels land on the composited target before helpers, once per eye', () => {
    const patched = patchLessonLabelDraw(read('mol-canvas3d/passes/draw.js'));
    for (const oit of [false, true]) for (const aa of [false, true]) for (const postfx of [false, true]) {
      const log: string[] = [];
      let bound = '';
      const off = { isEnabled: () => false };
      const context = vm.createContext({ isTimingMode: false, PostprocessingPass: { isEnabled: () => postfx },
        AntialiasingPass: { isEnabled: () => aa }, MarkingPass: off, DofPass: off });
      vm.runInContext(patched.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '') + '\nglobalThis.DrawPass=DrawPass;', context);
      const self: any = Object.create((context as any).DrawPass.prototype);
      const target = (name: string) => ({ framebuffer: name, bind() { bound = name; } });
      Object.assign(self, { transparencyMode: oit ? 'wboit' : 'blended', wboit: { supported: true }, packedDepth: false,
        _renderBlended() { log.push('molecule'); }, _renderWboit() { log.push('molecule'); },
        drawTarget: target('draw'), colorTarget: target('color'), postprocessing: { target: target('post') },
        depthTextureOpaque: { attachFramebuffer(t: string) { bound = t; }, detachFramebuffer() {} },
        antialiasing: { render() { log.push('aa'); } }, copyFboTarget: { render() {} }, copyFboPostprocessing: { render() {} },
        webgl: { gl: { flush() {} }, state: { disable() {} } } });
      const renderer = { setViewport() {}, update() {}, renderLessonLabels() { log.push(`labels:${bound}`); }, renderBlended() { log.push('menu'); } };
      const helper = { debug: { isEnabled: true, scenes: [{}], syncVisibility() { log.push('menu-depth-clear'); } },
        pointer: { isEnabled: false }, handle: { isEnabled: false }, camera: { isEnabled: false } };
      const scene = { volumes: { renderables: [] }, primitives: {}, markerAverage: 0 };
      for (let eye = 0; eye < 2; eye++) self._render(renderer, { viewport: { x: eye * 100, y: 0, width: 100, height: 100 } },
        scene, helper, true, false, { postprocessing: {}, marking: {} });
      const wanted = postfx ? 'post' : aa || oit ? 'color' : 'draw';
      expect(log.filter(x => x.startsWith('labels:'))).toEqual([`labels:${wanted}`, `labels:${wanted}`]);
      expect(log.filter(x => x === 'molecule')).toHaveLength(2);
      expect(log.indexOf(`labels:${wanted}`)).toBeLessThan(log.indexOf('menu-depth-clear'));
    }
  });
});
