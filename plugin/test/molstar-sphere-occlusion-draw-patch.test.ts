import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { patchMolstarOpaqueDrawSource } from '../src/molstar-opaque-depth-patch.js';
import { patchMolstarXrSinglePassDrawSource } from '../src/molstar-xr-single-pass-patch.js';
import { patchSphereOcclusionDrawSource } from '../src/molstar-sphere-occlusion-draw-patch.js';

const source = readFileSync(new URL('../node_modules/molstar/lib/mol-canvas3d/passes/draw.js', import.meta.url), 'utf8');
const single = patchMolstarXrSinglePassDrawSource(patchMolstarOpaqueDrawSource(source));
const patched = patchSphereOcclusionDrawSource(single, '/test/sphere-occlusion-pass.ts');

function frame({ quest = true, enabled = true, failDraw = false } = {}) {
  const log: string[] = [], texture = {}, off = { isEnabled: () => false, isTransparentDepthRequired: () => false };
  const runtime = { prepare: () => { log.push('proxy'); return texture; }, deactivate: () => log.push('deactivate'), reset() {} };
  const context: any = vm.createContext({ navigator: { userAgent: quest ? 'OculusBrowser/40.0' : 'Safari/605', xr: {} },
    isTimingMode: false, StereoCamera: { is: (c: any) => !!c.left }, PostprocessingPass: { ...off, isEnabled: () => !enabled },
    AntialiasingPass: off, MarkingPass: off, DofPass: off, BloomPass: off, createSphereOcclusionPass: () => runtime });
  vm.runInContext(patched.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '') + '\nglobalThis.DrawPass=DrawPass;', context);
  const target = { bind: () => log.push('native-bind') };
  const self: any = Object.create(context.DrawPass.prototype);
  Object.assign(self, { webgl: { xr: { session: { renderState: { baseLayer: {} } } }, gl: { flush() {}, getParameter() { return 4; }, DEPTH_TEST: 1 }, state: { disable() {} }, pixelRatio: 1 },
    transparencyMode: 'blended', wboit: { supported: false }, dpoit: { supported: false }, packedDepth: true, drawTarget: target,
    colorTarget: { ...target, getWidth: () => 200, getHeight: () => 100 },
    postprocessing: { setTransparentBackground() {}, background: { isEnabled: () => false } } });
  // Exercise the actual transformed stereo dispatch. Stand in only for an eye's
  // existing draw implementation so this test isolates pass ordering and scope.
  self._render = () => { log.push(self.stereofoldSphereCullDepth === texture ? 'candidate-eye' : 'stock-eye'); if (failDraw) throw Error('draw failed'); };
  const renderer = { setTransparentBackground() {}, setDrawingBufferSize() {}, setPixelRatio() {}, setViewport() {}, clear: () => log.push('native-clear') };
  const scene = { volumes: { renderables: [] }, markerAverage: 0, emissiveAverage: 0 };
  const eye = (x: number) => ({ viewport: { x, y: 0, width: 100, height: 100 } });
  let error: unknown;
  try { self.render({ renderer, camera: { left: eye(0), right: eye(100) }, scene, helper: {} }, { postprocessing: {}, marking: {}, transparentBackground: false }, true); }
  catch (e) { error = e; }
  return { log, self, error };
}

describe('sphere proxy DrawPass integration', () => {
  it('finishes proxy work before the first native bind/clear and shares it across both eyes', () => {
    const result = frame();
    expect(result.error).toBeUndefined();
    expect(result.log).toEqual(['native-bind', 'proxy', 'native-bind', 'native-clear', 'candidate-eye', 'candidate-eye']);
    expect(result.self.stereofoldSphereCullDepth).toBeNull();
  });
  it('never creates or runs a proxy on non-Quest or excluded passes', () => {
    for (const settings of [{ quest: false }, { enabled: false }]) {
      const result = frame(settings);
      expect(result.error).toBeUndefined();
      expect(result.log).toEqual(['stock-eye', 'stock-eye']);
      expect(result.self.stereofoldSphereOcclusion).toBeUndefined();
    }
  });
  it('clears the per-frame candidate texture even if an eye draw throws', () => {
    const result = frame({ failDraw: true });
    expect(String(result.error)).toContain('draw failed');
    expect(result.self.stereofoldSphereCullDepth).toBeNull();
    expect(result.self.stereofoldSinglePassEye).toBe(0);
  });
  it('refuses a changed or double-applied vendor source', () => {
    expect(() => patchSphereOcclusionDrawSource(source, '/runtime')).toThrow(/anchor changed/);
    expect(() => patchSphereOcclusionDrawSource(patched, '/runtime')).toThrow(/anchor changed/);
  });
});
