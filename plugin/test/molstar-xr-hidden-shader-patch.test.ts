import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { hiddenSceneProgramIds, patchXrHiddenShaderCanvas, patchXrHiddenShaderResources } from '../src/molstar-xr-hidden-shader-patch.js';
import { patchMolstarMotionCanvasSource } from '../src/molstar-motion-patch.js';
import { patchMolstarPropsSource } from '../src/molstar-props-patch.js';

const canvasSource = readFileSync(new URL('../node_modules/molstar/lib/mol-canvas3d/canvas3d.js', import.meta.url), 'utf8');
const resourceSource = readFileSync(new URL('../node_modules/molstar/lib/mol-gl/webgl/resources.js', import.meta.url), 'utf8');
const patched = patchXrHiddenShaderCanvas(patchMolstarPropsSource(patchMolstarMotionCanvasSource(canvasSource)));
function program(id: number, ready = false, variant = 'color') { return { id, variant, ready, isReady() { return this.ready; }, finalize() { return this.ready; } }; }
function object(p: ReturnType<typeof program>, visible: boolean) {
  return { state: { visible, disposed: false }, getProgram: () => p };
}
function harness(source = patched) {
  const pendingPrograms = new Set<any>();
  const resource = patchXrHiddenShaderResources(resourceSource);
  const methods = resource.slice(resource.indexOf('        programsReadyExcept:'), resource.indexOf('        reset:'));
  const resources = vm.runInNewContext(`({${methods}})`, { pendingPrograms, now: () => 0, isTimingMode: false });
  const scene = { renderables: [] as any[] }, helper: any = {};
  const frames: number[] = [], notices: number[] = [];
  let currentPose = 0, finalizations = 0;
  const context: any = { scene, helper, webgl: { resources }, shaderManager: {
    required: ['color'], finalizeRequired(sync: boolean) { finalizations++; return resources.finalizePrograms(['color'], sync); },
  }, render: (_force: boolean, frame: any) => { frames.push(frame?.pose ?? currentPose); return true; },
  didDraw: { next: (value: number) => notices.push(value) }, now: () => 1, startTime: 0 };
  const body = source.slice(source.indexOf('        function draw(options)'), source.indexOf('        function requestDraw()'));
  vm.runInNewContext(`let drawPaused = false, isContextLost = false, forceNextRender = false, notifyDidDraw = true;
    ${body}; globalThis.draw = draw;`, context);
  return { scene, helper, pendingPrograms, frames, notices, draw: context.draw,
    get finalizations() { return finalizations; } };
}

describe('XR frames during hidden shader compilation', () => {
  it('reproduces frozen head frames upstream and keeps every new pose with the patch', () => {
    for (const [source, expected] of [[canvasSource, []], [patched, [1, 2, 3]]] as const) {
      const h = harness(source), retained = program(1, true), staged = program(2);
      h.scene.renderables.push(object(retained, true), object(staged, false)); h.pendingPrograms.add(staged);
      for (const pose of [1, 2, 3]) h.draw({ xrFrame: { pose } });
      expect(h.frames).toEqual(expected); expect(h.finalizations).toBe(3);
      staged.ready = true; h.scene.renderables[1].state.visible = true;
      h.draw({ xrFrame: { pose: 4 } }); expect(h.frames.at(-1)).toBe(4);
      expect(h.notices).toHaveLength(expected.length + 1);
    }
  });
  it('keeps visible, shared, unknown and required pass programs gated', () => {
    for (const kind of ['visible', 'shared', 'unknown', 'pass']) {
      const h = harness(), pending = program(1); h.pendingPrograms.add(pending);
      if (kind !== 'unknown' && kind !== 'pass') h.scene.renderables.push(object(pending, kind === 'visible'));
      if (kind === 'shared') h.scene.renderables.push(object(pending, true));
      h.draw({ xrFrame: { pose: 1 } }); expect(h.frames, kind).toEqual([]);
      pending.ready = true; h.draw({ xrFrame: { pose: 2 } }); expect(h.frames).toEqual([2]);
    }
  });
  it('does not exempt programs shared with camera, pointer, handle or debug helpers', () => {
    for (const kind of ['camera', 'pointer', 'handle', 'debug']) {
      const h = harness(), pending = program(1); h.pendingPrograms.add(pending);
      h.scene.renderables.push(object(pending, false));
      const scene = { renderables: [object(pending, false)] }; // Can become visible during draw.
      h.helper[kind] = kind === 'debug' ? { scenes: [scene] } : { scene };
      h.draw({ xrFrame: { pose: 1 } }); expect(h.frames, kind).toEqual([]);
    }
  });
  it('preserves desktop gating and reevaluates hidden-to-visible state each frame', () => {
    const h = harness(), pending = program(1), staged = object(pending, false);
    h.pendingPrograms.add(pending); h.scene.renderables.push(staged);
    h.draw({}); expect(h.frames).toEqual([]);
    h.draw({ xrFrame: { pose: 1 } });
    staged.state.visible = true; h.draw({ xrFrame: { pose: 2 } });
    staged.state.visible = false; h.draw({ xrFrame: { pose: 3 } });
    expect(h.frames).toEqual([1, 3]);
  });
  it('ignores unrelated variants but never masks a required pending program', () => {
    const h = harness(), hidden = program(1), pick = program(2, false, 'pick');
    h.scene.renderables.push(object(hidden, false)); h.pendingPrograms.add(hidden); h.pendingPrograms.add(pick);
    h.draw({ xrFrame: { pose: 1 } }); expect(h.frames).toEqual([1]);
  });
  it('fails closed when vendor anchors change', () => {
    expect(() => patchXrHiddenShaderCanvas('unknown')).toThrow();
    expect(() => patchXrHiddenShaderResources('unknown')).toThrow();
    expect(hiddenSceneProgramIds({ renderables: [] }, {}, ['color']).size).toBe(0);
  });
});
