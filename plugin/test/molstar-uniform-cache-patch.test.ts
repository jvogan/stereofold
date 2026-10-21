import { expect, it } from 'vitest';
import { UniformSpec, TextureSpec } from 'molstar/lib/mol-gl/renderable/schema.js';
import { patchMolstarUniformCacheSource, uniformCacheBuildPlugins } from '../src/molstar-uniform-cache-patch.js';
import { countingGlHarness as harness } from './helpers/molstar-counting-gl.js';
const cell = (value: any) => ({ ref: { value, version: 0 } });

it('measures two-eye render-item/program submissions with motion, pick, label variants and draw reordering', () => {
  function run(patched: boolean) {
    const h = harness(patched);
    const schema: any = { uView: UniformSpec('m4'), uProjection: UniformSpec('m4'),
      uColor: UniformSpec('v3', 'material'), uAlpha: UniformSpec('f', 'material'), uRoughness: UniformSpec('f', 'material'),
      uClip: UniformSpec('v4'), uTexDim: UniformSpec('v2'), uTransform: UniformSpec('m4'), uObjectId: UniformSpec('i'),
      tColor: TextureSpec('texture', 'rgba', 'ubyte', 'nearest') };
    const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const objects = Array.from({ length: 40 }, (_, i) => {
      const values: any = Object.fromEntries(Object.entries({ drawCount: 3, instanceCount: 1,
        uColor: [i % 7 ? 1 : .2, .5, .2], uAlpha: 1, uRoughness: .5, uClip: [0, 0, 0, 0], uTexDim: [32, 32],
        uTransform: identity(), uObjectId: i, tColor: h.texture }).map(([k, v]) => [k, cell(v)]));
      return { values, label: i >= 32, item: h.item({ ...schema }, values, i < 32 ? 'mesh' : 'text') };
    });
    const globals: any = [['uView', cell(identity())], ['uProjection', cell(identity())]];
    const perFrame = [];
    for (let frame = 0; frame < 5; frame++) {
      const before = h.calls(); objects[0].values.uTransform.ref.value[12] = frame;
      const order = frame % 2 ? [...objects].reverse() : objects;
      for (let eye = 0; eye < 2; eye++) {
        globals[0][1].ref.value[12] = eye ? .032 : -.032;
        globals[1][1].ref.value[8] = eye ? .02 : -.02;
        for (const variant of ['color', 'pick', 'colorLabelOccluded', 'colorLabelExposed']) for (const o of order) {
          if ((variant === 'color' && o.label) || ((variant === 'colorLabelOccluded' || variant === 'colorLabelExposed') && !o.label)) continue;
          const p = o.item.getProgram(variant); p.use(); p.setUniforms(globals);
          h.state.currentMaterialId = h.state.currentRenderItemId = -1;
          o.item.render(variant, 0);
        }
      }
      perFrame.push(h.calls() - before);
    }
    return { ...h, perFrame };
  }
  const before = run(false), after = run(true);
  expect(after.draws).toEqual(before.draws);
  expect(after.binds()).toBe(before.binds());
  for (const key of ['uView', 'uProjection']) expect(after.uploads.filter(u => u.key === key)).toEqual(before.uploads.filter(u => u.key === key));
  expect(after.perFrame.every((n, i) => n < before.perFrame[i] * .6)).toBe(true);
  console.log('two-eye uniform calls/frame', JSON.stringify({ before: before.perFrame, after: after.perFrame,
    drawsPerFrame: after.draws.length / 5, textureBinds: after.binds() }));
});

it('shares cache across raw setters, ValueCells and samplers; copies mutable arrays and resets on relink', () => {
  const h = harness(true);
  const p = h.makeProgram({ uColor: UniformSpec('v3'), uId: UniformSpec('i'), uUnused: UniformSpec('f'),
    tColor: TextureSpec('texture', 'rgba', 'ubyte', 'nearest') }); p.use();
  const c = cell(new Float32Array([1, 2, 3]));
  p.setUniforms([['uColor', c]]); p.setUniforms([['uColor', cell([1, 2, 3])]]); expect(h.calls()).toBe(1);
  c.ref.value[1] = 9; p.setUniforms([['uColor', c]]); expect(h.calls()).toBe(2);
  p.uniform('uColor', [4, 5, 6]); p.setUniforms([['uColor', c]]); expect(h.calls()).toBe(4);
  p.uniform('uId', 0); p.setUniforms([['uId', cell(1)]]); p.uniform('uId', 0); expect(h.calls()).toBe(7);
  p.bindTextures([['tColor', h.texture]], 0); p.bindTextures([['tColor', h.texture]], 0);
  expect(h.calls()).toBe(8); expect(h.binds()).toBe(2);
  p.uniform('tColor', 3); p.bindTextures([['tColor', h.texture]], 0); expect(h.calls()).toBe(10);
  p.setUniforms([['uUnused', cell(5)]]); expect(h.calls()).toBe(10);
  p.reset(); p.use(); p.setUniforms([['uColor', c]]); expect(h.calls()).toBe(11);
});

it('isolates programs even with identical cell versions and validates build anchors', () => {
  const h = harness(true), schema = { uAlpha: UniformSpec('f') };
  const a = h.makeProgram(schema), b = h.makeProgram(schema, 'pick');
  a.use(); a.uniform('uAlpha', .5); b.use(); b.uniform('uAlpha', .5); b.uniform('uAlpha', 1);
  a.use(); a.uniform('uAlpha', .5); expect(h.calls()).toBe(3);
  a.setUniforms([['uAlpha', cell(1)]]); expect(h.calls()).toBe(4);
  expect(() => patchMolstarUniformCacheSource('changed')).toThrow('anchor changed');
  expect(uniformCacheBuildPlugins(false)).toEqual([]); expect(uniformCacheBuildPlugins(true)).toHaveLength(1);
});

it('handles all uniform kinds, array resizing, signed zero and setter failures', () => {
  const h = harness(true);
  for (const [kind, value] of Object.entries({ f: 1, i: 1, b: true, v2: [1, 2], v3: [1, 2, 3],
    v4: [1, 2, 3, 4], q: [0, 0, 0, 1], iv2: [1, 2], iv3: [1, 2, 3], iv4: [1, 2, 3, 4],
    m3: new Float32Array(9), m4: new Float32Array(16), 'f[]': [1, 2], 'i[]': [1, 2], 'b[]': [1, 0],
    'v2[]': [1, 2, 3, 4], 'v3[]': [1, 2, 3], 'v4[]': [1, 2, 3, 4], 'q[]': [0, 0, 0, 1],
    'iv2[]': [1, 2], 'iv3[]': [1, 2, 3], 'iv4[]': [1, 2, 3, 4], 'm3[]': new Float32Array(9), 'm4[]': new Float32Array(16) })) {
    const p = h.makeProgram({ uTest: UniformSpec(kind as any) }); p.use();
    const before = h.calls(); p.uniform('uTest', value); p.uniform('uTest', value);
    expect(h.calls() - before).toBe(1);
  }
  const p = h.makeProgram({ uArray: UniformSpec('f[]'), uScalar: UniformSpec('f') }); p.use();
  const before = h.calls();
  p.uniform('uArray', [1, 2]); p.uniform('uArray', [1]); p.uniform('uArray', [1, 2]);
  p.uniform('uScalar', 0); p.uniform('uScalar', -0);
  expect(h.calls() - before).toBe(5);
  // A failed upload must not become the cached value.
  const other = h.makeProgram({ uScalar: UniformSpec('f') }); other.use();
  expect(() => p.uniform('uScalar', 3)).toThrow();
  p.use(); p.uniform('uScalar', 3); expect(h.calls() - before).toBe(6);
});
