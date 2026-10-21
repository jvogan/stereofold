import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, it } from 'vitest';
import { lessonSourceInitialization } from '../src/lesson-source-initialization.js';
import type { Tour } from '../src/tour-player.js';

const opening = { background: '#ffffff', representation: 'cartoon', opacity: 0, componentLabels: false } as const;
const visibility = { op: 'only', chains: ['A', 'B'], classes: ['polymer'] } as const;
const tour: Tour = { id: 'private', title: 'Private', summary: '', steps: [
  { id: 'first', title: 'First', appearance: opening, visibility: visibility as any },
  { id: 'later', title: 'Later', appearance: { background: '#eeeeee', opacity: .3 } },
] };

it('seeds only source appearance and visibility, preserving the first chapter definition', () => {
  const before = structuredClone(tour);
  expect(lessonSourceInitialization(tour)).toEqual({
    appearance: { background: '#ffffff', representation: 'cartoon', opacity: 0 }, visibilityPatch: visibility,
  });
  expect(tour).toEqual(before);
  expect(lessonSourceInitialization(tour, { chapterId: 'later' })).toEqual({ appearance: { background: '#eeeeee', opacity: .3 } });
});

it('leaves normal loads and both density/map reference routes unchanged', () => {
  expect(lessonSourceInitialization(undefined)).toBeUndefined();
  expect(lessonSourceInitialization(tour, { density: true })).toBeUndefined();
  expect(lessonSourceInitialization({ ...tour, steps: [{ id: 'plain', title: 'Plain' }] })).toBeUndefined();
});

it('carries an explicitly shared source frame through fresh and saved-scene source loads',async()=>{
  const framed={...tour,presentation:{captionCard:'hidden' as const,coordinateFrame:'gallery-v1'}};
  const initial=lessonSourceInitialization(framed);
  expect(initial?.coordinateFrame).toBe('gallery-v1');
  expect((await loadOptions(undefined,initial)).initialInspection.coordinateFrame).toBe('gallery-v1');
  const scene={sourceSha256:'new-source',modelNumber:1,assemblyId:'asymmetric_unit',inspection:{appearance:opening}};
  expect((await loadOptions(scene,initial)).initialInspection.coordinateFrame).toBe('gallery-v1');
});

it('fits a hidden-base interchangeable figure once and carries its recovery frame policy', async () => {
  const composite: Tour = { ...tour, steps: [{ ...tour.steps[0], figure: { layers: [], labels: [], distances: [] } }] };
  const seed = lessonSourceInitialization(composite);
  expect(seed).toMatchObject({ frameVisibleFigureOnce: true });
  const scene = { sourceSha256: 'new-source', modelNumber: 1, assemblyId: 'asymmetric_unit', inspection: {
    appearance: { background: '#aabbcc', opacity: 0 }, visibility: { hiddenChains: [], hiddenClasses: [], showOnlySelection: false },
  } };
  expect((await loadOptions(scene, seed)).initialInspection).toEqual({ ...scene.inspection,
    frameVisibleFigureOnce: true, preserveFigureFrame: true });
  for (const patch of [{ view: 'fit' as const }, { placement: { scale: 2 } }, { figure: { layers: [], labels: [], distances: [], focus: [{ chain: 'A' }] } }])
    expect(lessonSourceInitialization({ ...composite, steps: [{ ...composite.steps[0], ...patch }] })).not.toHaveProperty('frameVisibleFigureOnce');
});

// Execute the production load adapter through the viewer-load boundary. The
// remaining function is DOM headings and saved-view restoration; neither may
// supply the appearance after a candidate has already reached the screen.
async function loadOptions(scene?: any, initialInspection?: any, nextPatch: any = {}) {
  const source = readFileSync(new URL('../../lab/inspection/workspace.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('async function loadSource('), end = source.indexOf('    fixture = next;', start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  let loaded: any;
  const context = vm.createContext({
    run: async (_status: string, action: () => Promise<unknown>) => action(),
    viewer: { snapshot: () => ({ ready: true, xrPresenting: true }), load: async (_next: any, options: any) => { loaded = options; } },
  });
  vm.runInContext(`${source.slice(start, end)}return result; }); }`, context);
  const next = { id: 'session', sha256: 'new-source', catalog: { modelNumbers: [1], assemblyId: 'asymmetric_unit' }, ...nextPatch };
  await context.loadSource(next, { scene, initialInspection, preserveCamera: true });
  return loaded;
}

it('hands lesson intent to the first viewer load for a fresh or replacement source', async () => {
  const seed = lessonSourceInitialization(tour);
  expect((await loadOptions(undefined, seed)).initialInspection).toEqual(seed);
});

it('gives compatible recovery state priority and rejects stale source/model/assembly seeds', async () => {
  const seed = lessonSourceInitialization(tour);
  const scene = { sourceSha256: 'new-source', modelNumber: 1, assemblyId: 'asymmetric_unit', inspection: {
    appearance: { background: '#aabbcc', opacity: .6 }, visibility: { hiddenChains: [], hiddenClasses: ['water'], showOnlySelection: false },
  } };
  expect((await loadOptions(scene, seed)).initialInspection).toEqual(scene.inspection);
  for (const patch of [{ sourceSha256: 'old-source' }, { modelNumber: 2 }, { assemblyId: 'other' }])
    expect((await loadOptions({ ...scene, ...patch }, seed)).initialInspection).toEqual(seed);
});

it('does not change unsaved nonlesson loads or send atomic initialization to a density renderer', async () => {
  expect(await loadOptions()).not.toHaveProperty('initialInspection');
  expect(await loadOptions(undefined, lessonSourceInitialization(tour), { map: new Uint8Array([1]) })).not.toHaveProperty('initialInspection');
});
