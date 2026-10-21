import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { lessonEntryCameraScene } from '../src/lesson-entry-camera.js';

// Execute the companion's real fresh-hydration decision, including its guards.
const source = readFileSync(new URL('../src/inspector.ts', import.meta.url), 'utf8');
const from = source.indexOf('    let restoredScene=data.scene ?? sceneImport?.resolvedScene;');
const to = source.indexOf('    const loadSettings=', from);
const body = ts.transpileModule(`${source.slice(from,to)}; result=restoredScene;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function hydrate(scene: any) {
  const context: any = { data: { scene, customTour: { steps: [{ id: 'reveal' }] } }, sceneImport: undefined,
    isCompanion: true, initialOpen: true, options: {}, lessonEntryCameraScene };
  vm.runInNewContext(body, context);
  return context.result;
}

const original = { position: [0, 0, 100], target: [0, 0, 0], up: [0, 1, 0], radius: 40, radiusMax: 40 };
const scene = (yaw = 0) => ({ sourceSha256: 'same', camera: { ...original, radius: 100, radiusMax: 100,
  position: [500 * Math.sin(yaw), 0, 500 * Math.cos(yaw)] }, inspection: { placement: { scale: 2.6 },
  lessonPlayback: { chapterId: 'reveal', entry: 'start', stopped: false, cameraFrame: 'desktop', startingScene: { camera: original } } } });
for (const yaw of [0, 25 * Math.PI / 180]) it(`seats a fresh active desktop chapter in its source camera frame, retaining turn ${yaw}`, () => {
  const saved = scene(yaw), result = hydrate(saved);
  expect(Math.hypot(...result.camera.position)).toBeCloseTo(100);
  expect(Math.atan2(result.camera.position[0], result.camera.position[2])).toBeCloseTo(yaw);
  expect(result.camera.radius).toBe(40);
  expect(result.inspection).toEqual(saved.inspection);
  expect(saved.camera.radius).toBe(100);
});
it('keeps saved XR views, legacy views, later chapters and ended lessons in their existing frame', () => {
  for (const patch of [{ cameraFrame: 'xr' }, { cameraFrame: undefined }, { chapterId: 'site' }, { stopped: true }, { entry: undefined }]) {
    const saved = scene(); Object.assign(saved.inspection.lessonPlayback, patch);
    expect(hydrate(saved)).toBe(saved);
  }
});
