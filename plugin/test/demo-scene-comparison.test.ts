import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Execute the actual harness helper without starting its browser/server entrypoint.
const source = readFileSync(new URL('../scripts/demo-browser.ts', import.meta.url), 'utf8');
const start = source.indexOf('function sameBackScene(');
const end = source.indexOf('function assertFigureCamera(', start);
if (start < 0 || end < start) throw Error('The demo harness scene comparison helper was not found.');
const compiled = ts.transpileModule(source.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const sameBackScene: (actual: any, expected: any) => boolean =
  new Function('isDeepStrictEqual', `${compiled}; return sameBackScene;`)(isDeepStrictEqual);

const scene = (): any => ({
  sourceSha256: 'verified-local-source', modelNumber: 1, assemblyId: '1', selectionKeys: ['ligand-1'],
  camera: { mode: 'perspective', fov: Math.PI / 4,
    position: [869.8990727457725, 42.5, 1284.6365767752427], target: [1, 42.5, -2], up: [0, 1, 0],
    radius: 128, radiusMax: 256, fog: 30, clipFar: true },
  inspection: {
    placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 2.2 },
    appearance: { representation: 'molecular-surface', opacity: 1 },
    visibility: { hiddenChains: ['B'] }, figure: { layers: [{ id: 'ligand', opacity: 1 }] },
    lessonPlayback: { chapterId: 'highlight', startingScene: { sourceSha256: 'verified-local-source',
      camera: { position: [10, 20, 30] } } },
  },
});
const freeze = (value: any): any => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};

describe('demo Back camera round-trip comparison', () => {
  it('accepts the observed tube roundoff without changing either captured scene', () => {
    const expected = scene(), actual = scene();
    actual.camera.position[0] = 869.8990727457729;
    actual.camera.position[2] = 1284.636576775243;
    expect(isDeepStrictEqual(actual, expected)).toBe(false); // Former exact comparison timed out.
    const beforeActual = structuredClone(actual), beforeExpected = structuredClone(expected);
    freeze(actual); freeze(expected);
    expect(sameBackScene(actual, expected)).toBe(true);
    expect(actual).toEqual(beforeActual); expect(expected).toEqual(beforeExpected);
  });

  it.each(['position', 'target', 'up'])('allows only small numerical noise in camera %s', key => {
    const expected = scene(), actual = scene();
    const value = actual.camera[key][0], magnitude = Math.max(1, Math.abs(value));
    actual.camera[key][0] += 2 * Number.EPSILON * magnitude;
    expect(sameBackScene(actual, expected)).toBe(true);
    actual.camera[key][0] = value + 16 * Number.EPSILON * magnitude;
    expect(sameBackScene(actual, expected)).toBe(false);
  });

  it.each([
    ['actual camera movement', (v: any) => { v.camera.position[0] += 1e-6; }],
    ['camera radius', (v: any) => { v.camera.radius += Number.EPSILON * v.camera.radius; }],
    ['camera field of view', (v: any) => { v.camera.fov += Number.EPSILON; }],
    ['camera mode', (v: any) => { v.camera.mode = 'orthographic'; }],
    ['source identity', (v: any) => { v.sourceSha256 = 'another-source'; }],
    ['assembly', (v: any) => { v.assemblyId = '2'; }],
    ['selection', (v: any) => { v.selectionKeys.push('ligand-2'); }],
    ['appearance', (v: any) => { v.inspection.appearance.opacity -= Number.EPSILON; }],
    ['placement', (v: any) => { v.inspection.placement.translation[0] = Number.EPSILON; }],
    ['visibility', (v: any) => { v.inspection.visibility.hiddenChains = []; }],
    ['figure', (v: any) => { v.inspection.figure.layers[0].opacity = 0.5; }],
    ['lesson cursor', (v: any) => { v.inspection.lessonPlayback.chapterId = 'wide'; }],
    ['nested lesson camera', (v: any) => { v.inspection.lessonPlayback.startingScene.camera.position[0] += 2 * Number.EPSILON * 10; }],
  ])('keeps %s exact', (_name, change) => {
    const expected = scene(), actual = scene();
    (change as (value: any) => void)(actual);
    expect(sameBackScene(actual, expected)).toBe(false);
  });

  it.each([
    ['short vector', (v: any) => { v.camera.position = [1, 2]; }],
    ['sparse vector', (v: any) => { v.camera.position = new Array(3); }],
    ['deleted vector slot', (v: any) => { delete v.camera.target[1]; }],
    ['nonfinite vector', (v: any) => { v.camera.target[0] = Infinity; }],
    ['NaN vector', (v: any) => { v.camera.up[1] = NaN; }],
    ['missing vector', (v: any) => { delete v.camera.target; }],
    ['missing camera', (v: any) => { delete v.camera; }],
  ])('rejects %s', (_name, change) => {
    const expected = scene(), actual = scene();
    (change as (value: any) => void)(actual);
    expect(sameBackScene(actual, expected)).toBe(false);
    expect(sameBackScene(expected, actual)).toBe(false);
  });

  it('preserves exact comparison after the existing figure contract removes both cameras', () => {
    const expected = scene(), actual = scene(); delete actual.camera; delete expected.camera;
    expect(sameBackScene(actual, expected)).toBe(true);
    actual.inspection.placement.scale += Number.EPSILON * 2.2;
    expect(sameBackScene(actual, expected)).toBe(false);
  });
});
