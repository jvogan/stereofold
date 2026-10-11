import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { patchMolstarOpaqueDrawSource } from '../src/molstar-opaque-depth-patch.js';
import { isQuest2FinalFlushBrowser, patchMolstarXrSinglePassDrawSource, xrSkipFinalFlushEnabled } from '../src/molstar-xr-single-pass-patch.js';
const read = (path: string) => readFileSync(new URL('../node_modules/molstar/lib/' + path, import.meta.url), 'utf8');
const quest = { userAgent: 'Mozilla/5.0 (Quest 2) OculusBrowser/40.0', xr: {} };
const others = [undefined, { userAgent: 'Version/26 Safari/605.1.15', xr: {} }, { userAgent: 'Chrome/134.0', xr: {} }, { userAgent: 'OculusBrowser/40' }];
describe('qualified Quest2 final XR flush skip', () => {
  const stock = patchMolstarOpaqueDrawSource(read('mol-canvas3d/passes/draw.js'));
  const patched = patchMolstarXrSinglePassDrawSource(stock, true);
  function frame(source: string, navigator: any, { session = {} as any, transparentBackground = true, postprocessing = false, leftDisabled = false, rightDisabled = false,
    leftViewport = { x: 0, y: 0, width: 100, height: 100 }, rightViewport = { x: 100, y: 0, width: 100, height: 100 },
    mono = false, failDrawAt = 0, inspectState = (_self: any) => {} } = {}) {
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
      self.render({ renderer, camera: mono ? { viewport: leftViewport } : { left: { viewport: leftViewport, disabled: leftDisabled }, right: { viewport: rightViewport, disabled: rightDisabled } }, scene, helper },
        { postprocessing: {}, marking: {}, transparentBackground, dpoitIterations: 2 }, true);
    } finally { inspectState(self); }
    return log;
  }

  const twoPass = ['viewport 0,0,100,100', 'bind draw', 'clear false', 'bind draw', 'clear true', 'opaque', 'transparent', 'bind draw', 'bind draw', 'flush',
    'viewport 100,0,100,100', 'bind draw', 'clear false', 'bind draw', 'clear true', 'opaque', 'transparent', 'bind draw', 'bind draw', 'flush'];
  it('removes exactly the final qualified flush, preserving every other vendor call', () => {
    const normal = frame(patchMolstarXrSinglePassDrawSource(stock), quest);
    expect(normal.filter(x => x === 'flush')).toHaveLength(1);
    expect(frame(patched, quest)).toEqual(normal.filter(x => x !== 'flush'));
    expect(patchMolstarXrSinglePassDrawSource(stock, false)).toBe(patchMolstarXrSinglePassDrawSource(stock));
  });
  it('enables the qualified build by default with an explicit stock control', () => {
    expect(xrSkipFinalFlushEnabled(undefined)).toBe(true);
    expect(xrSkipFinalFlushEnabled('0')).toBe(false);
    expect(xrSkipFinalFlushEnabled('1')).toBe(true);
    expect(() => xrSkipFinalFlushEnabled('true')).toThrow('must be 0 or 1');
  });
  it('preserves the existing final single-pass flush on Quest3 and unknown Oculus devices',()=>{
    for(const userAgent of ['Mozilla/5.0 (Quest 3) OculusBrowser/40.0','Mozilla/5.0 (Quest Pro) OculusBrowser/40.0','OculusBrowser/40.0']) {
      const nav={userAgent,xr:{}};const normal=frame(patchMolstarXrSinglePassDrawSource(stock),nav);
      expect(normal.filter(x=>x==='flush')).toHaveLength(1);expect(frame(patched,nav)).toEqual(normal);
    }
  });
  it('embeds a closure-free browser predicate and fails open on inaccessible identity',()=>{
    const predicate='('+isQuest2FinalFlushBrowser.toString()+')()';
    expect(predicate).not.toContain('__name');expect(vm.runInNewContext(predicate,{navigator:quest})).toBe(true);
    expect(vm.runInNewContext(predicate,{})).toBe(false);
    expect(vm.runInNewContext(predicate,{navigator:{xr:{},get userAgent(){throw Error('unavailable');}}})).toBe(false);
    expect(patched).not.toContain('__name');
  });
  it('preserves a mono desktop flush even on a Quest browser', () => {
    expect(frame(patched, quest, { mono: true, session: null })).toEqual(frame(stock, quest, { mono: true, session: null }));
    expect(frame(patched, quest, { mono: true, session: null }).filter(x => x === 'flush')).toHaveLength(1);
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
    expect(log.filter(entry => entry === 'flush')).toHaveLength(0);
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
