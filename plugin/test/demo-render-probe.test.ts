import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { instrumentDemoRenderObjects } from '../scripts/demo-render-probe.js';

const initialization = 'let p=m.canvas3d;if(!p)throw m.dispose(),new Error("Mol* did not create Canvas3D.");';

describe('isolated demo render-object probe', () => {
  it('reads counts and render flags without changing objects or exposing coordinates', () => {
    const cell = (value: unknown) => ({ ref: { value } });
    const object = { id: 7, type: 'mesh', state: { visible: true, alphaFactor: 1 }, values: {
      drawCount: cell(300), instanceCount: cell(6), alpha: cell(1), transparencyAverage: cell(0.5),
      markerAverage: cell(0),
      uDoubleSided: cell(false), dTransparentBackfaces: cell('off'), aPosition: cell([99, 88, 77]),
    } };
    const before = JSON.stringify(object);
    const context = vm.createContext({ m: { canvas3d: { reprCount: { value: 1 }, getRenderObjects: () => [object] } } });
    vm.runInContext(instrumentDemoRenderObjects(initialization), context);
    const result = JSON.parse(JSON.stringify(context.__stereofoldDemoRenderObjects()));
    expect(result).toMatchObject({ representationCount: 1, derivedSceneMarkerAverage: 0, blendedColorSkipEligible: 0, objects: [{ id: 7, type: 'mesh', visible: true,
      drawCount: 300, instances: 6, alpha: 1, alphaFactor: 1, transparencyAverage: 0.5,
      markerAverage: 0, doubleSided: false, backfaces: 'off', blendedColorSkipEligible: false }] });
    expect(result.objects[0]).not.toHaveProperty('aPosition');
    expect(JSON.stringify(object)).toBe(before);
  });

  it('uses the renderer guard and the visible primitive marker mean for skip eligibility', () => {
    const cell = (value: unknown) => ({ ref: { value } });
    const mesh = { id: 1, type: 'mesh', state: { visible: true, alphaFactor: 1 }, values: {
      dGeometryType: cell('mesh'), dTransparency: cell(true), transparencyAverage: cell(1),
      uTransparencyStrength: cell(1), dTransparencyType: cell('groupInstance'), dTransparentBackfaces: cell('off'),
      markerAverage: cell(0), uMarker: cell(0),
    } };
    const marked = structuredClone(mesh); marked.id = 2; marked.values.markerAverage.ref.value = 1;
    const objects = [mesh, marked]; marked.state.visible = false;
    const context = vm.createContext({ m: { canvas3d: { reprCount: { value: 1 }, getRenderObjects: () => objects } } });
    vm.runInContext(instrumentDemoRenderObjects(initialization), context);
    expect(context.__stereofoldDemoRenderObjects()).toMatchObject({ derivedSceneMarkerAverage: 0, blendedColorSkipEligible: 1 });
    marked.state.visible = true;
    expect(context.__stereofoldDemoRenderObjects()).toMatchObject({ derivedSceneMarkerAverage: 0.5, blendedColorSkipEligible: 0 });
    marked.type = 'direct-volume';
    expect(context.__stereofoldDemoRenderObjects()).toMatchObject({ derivedSceneMarkerAverage: 0, blendedColorSkipEligible: 1 });
  });

  it('refuses missing or ambiguous initialization instead of guessing a runtime variable', () => {
    expect(() => instrumentDemoRenderObjects('<script>unknown()</script>')).toThrow(/Expected one/);
    expect(() => instrumentDemoRenderObjects(initialization + initialization)).toThrow(/Expected one/);
  });
});
