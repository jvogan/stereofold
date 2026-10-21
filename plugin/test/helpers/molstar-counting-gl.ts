import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect } from 'vitest';
import { UniformSpec, DefineSpec, splitValues, getValueVersions } from 'molstar/lib/mol-gl/renderable/schema.js';
import { getUniformSetters, isArrayUniform } from 'molstar/lib/mol-gl/webgl/uniform.js';
import { patchMolstarUniformCacheSource } from '../../src/molstar-uniform-cache-patch.js';
import { patchLessonLabelRenderItem } from '../../src/molstar-lesson-label-patch.js';
const read = (n: string) => readFileSync(new URL('../../node_modules/molstar/lib/mol-gl/webgl/' + n + '.js', import.meta.url), 'utf8');
const cell = (value: any) => ({ ref: { value, version: 0 } });
export function countingGlHarness(patched: boolean) {
  let current: any, next = 0, calls = 0, binds = 0, switches = 0;
  let depth = 'LEQUAL', depthMask = true;
  const uploads: any[] = [], draws: any[] = [];
  const submissions: any[] = [], depthChanges: string[] = [];
  const state: any = { currentProgramId: -1, currentMaterialId: -1, currentRenderItemId: -1,
    enable() {}, disable() {}, colorMask() {}, viewport() {}, scissor() {}, frontFace() {}, cullFace() {},
    blendFunc() {}, blendFuncSeparate() {}, depthMask(v: boolean) { depthMask = v; },
    depthFunc(v: string) { depth = v; depthChanges.push(v); },
    clearVertexAttribsState() {}, disableUnusedVertexAttribs() {} };
  const resets = { material: 0, item: 0 };
  for (const [key, counter] of [['currentMaterialId', 'material'], ['currentRenderItemId', 'item']] as const) {
    let value = -1;
    Object.defineProperty(state, key, { get: () => value, set(v: number) {
      if (v === -1) resets[counter]++;
      value = v;
    } });
  }
  const gl: any = { TRIANGLES: 4, drawingBufferWidth: 200, drawingBufferHeight: 200,
    GREATER: 'GREATER', LEQUAL: 'LEQUAL',
    createProgram: () => ({ id: next++, values: {} }), linkProgram() {}, deleteProgram() {},
    useProgram: (p: any) => { if (current !== p) switches++; current = p; },
    getUniformLocation: (p: any, key: string) => key === 'uUnused' ? null : { p, key } };
  for (const name of ['uniform1f', 'uniform1i', 'uniform1fv', 'uniform1iv', 'uniform2fv', 'uniform3fv', 'uniform4fv',
    'uniform2iv', 'uniform3iv', 'uniform4iv', 'uniformMatrix3fv', 'uniformMatrix4fv']) {
    gl[name] = (location: any, ...args: any[]) => {
      expect(location.p).toBe(current);
      const v = args.at(-1), value = typeof v === 'object' ? Array.from(v) : v;
      current.values[location.key] = value; calls++; uploads.push({ api: name, key: location.key, value });
    };
  }
  const context: any = vm.createContext({ idFactory: () => { let i = 0; return () => i++; }, isDebugMode: false, isTimingMode: false,
    getUniformSetters, isArrayUniform, addShaderDefines: (_g: any, _e: any, _p: any, _d: any, s: any) => s,
    ValueCell: { create: cell }, UniformSpec, DefineSpec, splitValues, getValueVersions,
    cloneUniformValues: () => ({}), createAttributeBuffers: () => [],
    createTextures: (_ctx: any, _schema: any, values: any) => Object.entries(values).map(([k, c]: any) => [k, c.ref.value]) });
  const source = patched ? patchMolstarUniformCacheSource(read('program')) : read('program');
  const strip = (s: string) => s.replace(/^import .*;\r?\n/gm, '').replace(/export /g, '');
  vm.runInContext(strip(source) + '\nglobalThis.makeProgram=createProgram;', context);
  vm.runInContext(strip(patchLessonLabelRenderItem(read('render-item'))) + '\nglobalThis.makeItem=createGraphicsRenderItem;', context);
  const programs = new Map<string, any>();
  function makeProgram(schema: any, variant = 'colorBlended') {
    const p = context.makeProgram(gl, state, {}, {}, () => ({ attach() {}, destroy() {} }),
      { schema, shaderCode: { vert: '', frag: '' }, defineValues: { dRenderVariant: cell(variant) } });
    p.finalize(); return p;
  }
  const ctx: any = { gl, state, stats: { drawCount: 0, instanceCount: 0, instancedDrawCount: 0 },
    extensions: { instancedArrays: { drawArraysInstanced() {
      const values = structuredClone(current.values);
      draws.push(values); submissions.push({ program: current.id, depth, depthMask, values });
    } } },
    resources: { texture: () => ({ define() {}, load() {}, destroy() {}, bind() { binds++; } }),
      program(defines: any, code: any, schema: any) {
      const key = code.name + ':' + defines.dRenderVariant.ref.value + ':' + !!defines.dStereofoldOccludedLabel?.ref.value + ':' + !!defines.dStereofoldLabelSdf?.ref.value;
      if (!programs.has(key)) programs.set(key, makeProgram(schema, defines.dRenderVariant.ref.value));
      return programs.get(key);
    } } };
  const texture = { bind() { binds++; } };
  return { ctx, state, resets, draws, submissions, depthChanges, uploads, programs, makeProgram, texture,
    calls: () => calls, binds: () => binds, switches: () => switches,
    item: (schema: any, values: any, name = 'mesh', materialId = -1) =>
      context.makeItem(ctx, 'triangles', { name }, schema, values, materialId, 'blended') };
}
