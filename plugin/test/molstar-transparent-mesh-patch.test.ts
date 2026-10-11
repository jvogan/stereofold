import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { patchMolstarBlendedTransparentSource } from '../src/molstar-transparent-mesh-patch.js';

const installed = readFileSync(new URL('../node_modules/molstar/lib/mol-gl/renderer.js', import.meta.url), 'utf8');
const commonjs = readFileSync(new URL('../node_modules/molstar/lib/commonjs/mol-gl/renderer.js', import.meta.url), 'utf8');
const start = '        const renderBlendedTransparent =', end = '        const renderVolume =';
const chunk = (source: string, from: string, to: string) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
const cell = (value: unknown) => ({ ref: { value } });
function object(overrides: Record<string, unknown> = {}) {
  return { state: { alphaFactor: 1 }, values: Object.fromEntries(Object.entries({
    alpha: 1, transparencyAverage: 1, dGeometryType: 'mesh', dTransparency: true, uTransparencyStrength: 1,
    dTransparencyType: 'groupInstance', dTransparentBackfaces: 'off', markerAverage: 0, uMarker: 0,
    uDoubleSided: true, ...overrides,
  }).map(([key, value]) => [key, cell(value)])) };
}
/** Execute the installed pass; adapt GL state calls and final submission only. */
function loop(patched: boolean, sceneMarkers = 0) {
  const submissions: unknown[] = [], depthMasks: boolean[] = [];
  const context: any = vm.createContext({ isTimingMode: false,
    clamp: (n: number, low: number, high: number) => Math.min(high, Math.max(low, n)),
    transparentBackground: false, gl: {}, state: { blendFunc() {}, blendFuncSeparate() {}, enable() {}, depthMask: (value: boolean) => depthMasks.push(value) },
    globalUniforms: { uMarkerAverage: cell(sceneMarkers) }, updateInternal() {}, Mask: { Transparent: 1 },
    Flag: { BlendedBack: 'back', BlendedFront: 'front', None: 'none' },
    renderObject: (r: unknown, variant: string, flag: string) => submissions.push({ r, variant, flag }),
  });
  const source = patched ? patchMolstarBlendedTransparentSource(installed) : installed;
  vm.runInContext(chunk(source, '        const checkTransparent = function', '        const checkEmissive')
    + chunk(source, start, end) + '\nglobalThis.draw=renderBlendedTransparent;', context);
  return { context, submissions, depthMasks, draw: (...renderables: unknown[]) => context.draw({ renderables }, {}) };
}

describe('Mol* fully transparent mesh blended-color submission', () => {
  it('omits the two zero-alpha color submissions while retaining the complete object', () => {
    const hidden = object(), before = structuredClone(hidden), upstream = loop(false), patched = loop(true);
    upstream.draw(hidden); patched.draw(hidden);
    expect(upstream.submissions).toHaveLength(2); expect(patched.submissions).toHaveLength(0);
    expect(hidden).toEqual(before); expect(patched.depthMasks).toEqual([false]);
  });
  it('reads current cells every frame, restoring submission when the chapter reveals a mesh', () => {
    const hidden = object(), renderer = loop(true);
    renderer.draw(hidden); expect(renderer.submissions).toHaveLength(0);
    hidden.values.transparencyAverage.ref.value = 0.4;
    renderer.draw(hidden); expect(renderer.submissions).toHaveLength(2);
    hidden.values.transparencyAverage.ref.value = 1;
    renderer.draw(hidden); expect(renderer.submissions).toHaveLength(2);
  });
  for (const [name, fields] of Object.entries({
    partial: { transparencyAverage: 254 / 255 }, reducedStrength: { uTransparencyStrength: 0.5 },
    disabledTransparency: { dTransparency: false }, volumeSampling: { dTransparencyType: 'volumeInstance' },
    vertexSampling: { dTransparencyType: 'vertexInstance' }, opaqueBackfaces: { dTransparentBackfaces: 'opaque' },
    selected: { markerAverage: 1, uMarker: 2 }, highlighted: { markerAverage: 0.01, uMarker: -1 },
    markerUniform: { markerAverage: 0, uMarker: 1 }, text: { dGeometryType: 'text' },
    volume: { dGeometryType: 'directVolume' }, image: { dGeometryType: 'image' },
    unknownStrength: { uTransparencyStrength: undefined }, unknownBackfaces: { dTransparentBackfaces: undefined },
  })) it(`preserves upstream color submissions for ${name}`, () => {
    const mesh = object(fields), upstream = loop(false), patched = loop(true);
    upstream.draw(mesh); patched.draw(mesh);
    expect(patched.submissions).toEqual(upstream.submissions);
    expect(upstream.submissions.length).toBeGreaterThan(0);
  });
  it('preserves global marker dimming even if this object has no local markers', () => {
    const mesh = object(), upstream = loop(false, 0.1), patched = loop(true, 0.1);
    upstream.draw(mesh); patched.draw(mesh); expect(patched.submissions).toEqual(upstream.submissions);
  });
  it.each(['instance', 'groupInstance'])('admits exact unsmoothed %s transparency with a texture marker', type => {
    const renderer = loop(true); renderer.draw(object({ dTransparencyType: type, uMarker: -1 }));
    expect(renderer.submissions).toHaveLength(0);
  });
  it.each([installed, commonjs])('leaves every other renderer pass byte-identical', source => {
    const patched = patchMolstarBlendedTransparentSource(source);
    expect(patched.slice(0, patched.indexOf(start))).toBe(source.slice(0, source.indexOf(start)));
    expect(patched.slice(patched.indexOf(end))).toBe(source.slice(source.indexOf(end)));
  });
  it('fails closed when upstream pass boundaries or submission count change', () => {
    expect(() => patchMolstarBlendedTransparentSource('')).toThrow();
    expect(() => patchMolstarBlendedTransparentSource(installed.replace(start, 'const renamed ='))).toThrow();
    const pass = chunk(installed, start, end);
    expect(() => patchMolstarBlendedTransparentSource(installed.replace(pass,
      pass.replace('if (checkTransparent(r))', 'if (false)')))).toThrow();
  });
});
