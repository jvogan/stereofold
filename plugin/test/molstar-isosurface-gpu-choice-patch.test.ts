import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';
import { isosurfaceGpuChoicePatch, patchMolstarIsosurfaceGpuChoiceSource } from '../src/molstar-isosurface-gpu-choice-patch.js';

const cjsPath = fileURLToPath(new URL('../node_modules/molstar/lib/commonjs/mol-repr/volume/isosurface.js', import.meta.url));
const esmPath = fileURLToPath(new URL('../node_modules/molstar/lib/mol-repr/volume/isosurface.js', import.meta.url));
const require = createRequire(cjsPath);
const cjs = await readFile(cjsPath, 'utf8'), esm = await readFile(esmPath, 'utf8');
const { Volume } = require('../../mol-model/volume.js');
const { Tensor, Mat4 } = require('../../mol-math/linear-algebra.js');
const { ParamDefinition: PD } = require('../../mol-util/param-definition.js');
const { VolumeRepresentation } = require('./representation.js');

function evaluate(source: string) {
  const module = { exports: {} as any };
  // Real installed dependencies and factories, with only this module patched.
  new Function('require', 'module', 'exports', source)(require, module, module.exports);
  return module.exports;
}
const original = evaluate(cjs);
const patched = evaluate(patchMolstarIsosurfaceGpuChoiceSource(cjs, '5.11.0'));
const patchedEsm = evaluate(transformSync(patchMolstarIsosurfaceGpuChoiceSource(esm, '5.11.0'), { format: 'cjs' }).code);
function sphere(size = 10) {
  const space = Tensor.Space([size, size, size], [0, 1, 2], Float32Array), data = space.create();
  for (let x = 0; x < size; x++) for (let y = 0; y < size; y++) for (let z = 0; z < size; z++)
    space.set(data, x, y, z, 5 - Math.hypot(x - (size - 1) / 2, y - (size - 1) / 2, z - (size - 1) / 2));
  return { ...Volume.One, grid: { cells: Tensor.create(space, data), transform: { kind: 'matrix', matrix: Mat4.identity() },
    stats: { min: -4, max: 5, mean: 0, sigma: 1 } }, instances: [{ transform: Mat4.identity() }], _propertyData: {}, _localPropertyData: {} };
}
function context() {
  return { maxTextureSize: 4096, isWebGL2: true, extensions: { colorBufferFloat: {}, textureFloat: {}, drawBuffers: {} } };
}
const volume = sphere();
const props = { ...PD.getDefaultValues(original.IsosurfaceMeshParams), isoValue: Volume.IsoValue.absolute(1), wrap: 'off' };
const cases: [string, any, any, any, boolean][] = [
  ['all GPU capabilities', volume, props, context(), true],
  ...['colorBufferFloat', 'textureFloat', 'drawBuffers'].map(name => {
    const webgl: any = context(); webgl.extensions[name] = null;
    return [`missing ${name}`, volume, props, webgl, false] as [string, any, any, any, boolean];
  }),
  ['no WebGL', volume, props, undefined, false],
  ['GPU disabled', volume, { ...props, tryUseGpu: false }, context(), false],
  ['inside floodfill', volume, { ...props, floodfill: 'inside' }, context(), false],
  ['outside floodfill', volume, { ...props, floodfill: 'outside' }, context(), false],
  ['small map', sphere(9), props, context(), false],
  ['texture capacity exceeded', volume, props, { ...context(), maxTextureSize: 16 }, false],
];

function representation(api: any, webgl: any) {
  const created: any[] = [];
  const rep = VolumeRepresentation('real CPU fallback regression', { webgl }, () => api.IsosurfaceMeshParams, (...args: any[]) => {
    const visual = api.IsosurfaceVisual(...args); created.push(visual); return visual;
  }, () => ({ kind: 'empty-loci' }));
  return { rep, created };
}
function meshData(object: any) {
  const values = object.values;
  const vertexCount = values.uVertexCount.ref.value, drawCount = values.drawCount.ref.value;
  // Reusing a mesh intentionally retains spare buffer capacity. Compare every
  // active scientific vertex/normal/group/index, not unused allocation tails.
  return {
    aPosition: values.aPosition.ref.value.slice(0, vertexCount * 3),
    aNormal: values.aNormal.ref.value.slice(0, vertexCount * 3),
    aGroup: values.aGroup.ref.value.slice(0, vertexCount),
    elements: values.elements.ref.value.slice(0, drawCount),
    drawCount, vertexCount, boundingSphere: structuredClone(values.boundingSphere.ref.value),
  };
}

describe('pinned Mol* isosurface GPU choice backport', () => {
  it('fails closed for changed version, anchors, duplicate/repeated patches and preserves CRLF', () => {
    for (const source of [cjs, esm]) {
      expect(() => patchMolstarIsosurfaceGpuChoiceSource(source, '5.12.0')).toThrow('5.11.0');
      for (const anchor of ['function IsosurfaceVisual(', 'return props.tryUseGpu && !!webgl', "return props.floodfill !== 'off'", 'return webgl.extensions.colorBufferFloat', "if (props.floodfill === 'off'"])
        expect(() => patchMolstarIsosurfaceGpuChoiceSource(source.replace(anchor, 'changed'), '5.11.0')).toThrow('anchor');
      expect(() => patchMolstarIsosurfaceGpuChoiceSource(source + source, '5.11.0')).toThrow('anchor');
      const result = patchMolstarIsosurfaceGpuChoiceSource(source, '5.11.0');
      expect(() => patchMolstarIsosurfaceGpuChoiceSource(result, '5.11.0')).toThrow('already');
      expect(patchMolstarIsosurfaceGpuChoiceSource(source.replaceAll('\n', '\r\n'), '5.11.0').replaceAll('\r\n', '\n')).toBe(result);
      // All geometry constructors, contour transforms and data/texture handling
      // remain the exact installed implementation, including wireframe.
      const restored = result.replace(/function stereofoldIsosurfaceUseGpu\([\s\S]*?\n}\n/, '')
        .replace('if (stereofoldIsosurfaceUseGpu(volume, props, webgl))', "if (props.floodfill === 'off' && props.tryUseGpu && webgl && gpuSupport(webgl) && suitableForGpu(volume, webgl))")
        .replace('return stereofoldIsosurfaceUseGpu(volumekey.volume, props, webgl);', 'return props.tryUseGpu && !!webgl && suitableForGpu(volumekey.volume, webgl);')
        .replace('return !stereofoldIsosurfaceUseGpu(volumeKey.volume, props, webgl);', "return props.floodfill !== 'off' || !props.tryUseGpu || !webgl || !suitableForGpu(volumeKey.volume, webgl);");
      expect(restored).toBe(source);
    }
  });

  it('loads both installed ESM/CJS paths through the version-checked esbuild hook', async () => {
    let filter: RegExp | undefined, loader: any;
    isosurfaceGpuChoicePatch().setup({ onLoad(options: any, callback: any) { filter = options.filter; loader = callback; } } as any);
    for (const [path, source] of [[esmPath, esm], [cjsPath, cjs]]) {
      expect(filter!.test(path!)).toBe(true);
      expect(await loader({ path })).toEqual({ contents: patchMolstarIsosurfaceGpuChoiceSource(source!, '5.11.0'), loader: 'js' });
    }
    expect(filter!.test(esmPath.replace('isosurface.js', 'other.js'))).toBe(false);
  });

  it.each(cases)('keeps dispatcher and both real visual factories consistent: %s', (_name, map, options, webgl, useGpu) => {
    for (const api of [patched, patchedEsm]) {
      const key = { volume: map, key: 0 };
      expect(api.IsosurfaceMeshVisual(1).mustRecreate(key, options, webgl)).toBe(useGpu);
      expect(api.IsosurfaceTextureMeshVisual(1).mustRecreate(key, options, webgl)).toBe(!useGpu);
      const selected = api.IsosurfaceVisual(1, map, 0, options, webgl);
      expect(selected.mustRecreate(key, options, webgl)).toBe(false);
      // A fully supported input must still select GPU; disabled GPU selects CPU.
      expect(selected.mustRecreate({ volume, key: 0 }, props, context())).toBe(!useGpu);
      expect(selected.mustRecreate(key, { ...options, tryUseGpu: false }, webgl)).toBe(useGpu);
    }
  });

  it.each(['colorBufferFloat', 'textureFloat', 'drawBuffers', 'floodfill'])('reuses actual CPU geometry for style updates with %s unavailable', async reason => {
    const webgl: any = context(), options = { ...props };
    if (reason === 'floodfill') options.floodfill = 'inside'; else webgl.extensions[reason] = null;
    const map = sphere(), input = map.grid.cells.data.slice();
    const before = representation(original, webgl), after = representation(patched, webgl);
    try {
      for (const { rep } of [before, after]) await rep.createOrUpdate(options, map).run();
      const first = after.rep.renderObjects[0], initialGeometry = after.created[0].geometryVersion;
      const geometry = meshData(first);
      expect(first.type).toBe('mesh'); expect(geometry.drawCount).toBeGreaterThan(0);
      expect(geometry).toEqual(meshData(before.rep.renderObjects[0]));
      for (const { rep } of [before, after]) await rep.createOrUpdate({ alpha: 0.7, doubleSided: false }, map).run();
      expect(before.created).toHaveLength(2); // This is the original reachable defect.
      expect(after.created).toHaveLength(1);
      expect(after.rep.renderObjects[0]).toBe(first);
      expect(after.created[0].geometryVersion).toBe(initialGeometry);
      expect(meshData(after.rep.renderObjects[0])).toEqual(geometry);
      expect(meshData(after.rep.renderObjects[0])).toEqual(meshData(before.rep.renderObjects[0]));
      expect(after.rep.props.alpha).toBe(0.7);
      // Genuine scientific changes still rebuild the contour with exact old output.
      for (const { rep } of [before, after]) await rep.createOrUpdate({ isoValue: Volume.IsoValue.absolute(2) }, map).run();
      expect(after.created[0].geometryVersion).toBe(initialGeometry + 1);
      expect(meshData(after.rep.renderObjects[0])).not.toEqual(geometry);
      expect(meshData(after.rep.renderObjects[0])).toEqual(meshData(before.rep.renderObjects[0]));
      expect(map.grid.cells.data).toEqual(input);
      expect(options.isoValue).toEqual(Volume.IsoValue.absolute(1));
    } finally { before.rep.destroy(); after.rep.destroy(); }
  });

  it('rebuilds CPU geometry for map replacement, wrap and floodfill changes without discarding the visual', async () => {
    const webgl: any = context(); webgl.extensions.colorBufferFloat = null;
    const { rep, created } = representation(patched, webgl);
    try {
      await rep.createOrUpdate(props, sphere()).run();
      const first = rep.renderObjects[0];
      await rep.createOrUpdate({}, sphere(11)).run();
      expect(rep.renderObjects[0]).not.toBe(first); expect(created).toHaveLength(1);
      expect(created[0].geometryVersion).toBe(1);
      await rep.createOrUpdate({ wrap: 'on' }).run(); expect(created[0].geometryVersion).toBe(2);
      await rep.createOrUpdate({ floodfill: 'outside' }).run(); expect(created[0].geometryVersion).toBe(3);
      await rep.createOrUpdate({ floodfill: 'off' }).run(); expect(created[0].geometryVersion).toBe(4);
      expect(created).toHaveLength(1);
    } finally { rep.destroy(); }
  });
});
