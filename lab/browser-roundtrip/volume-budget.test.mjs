/**
 * The page's rule for a DENSITY tier.
 *
 * Mol*-free on purpose. Everything here is arithmetic over a triangle count,
 * and the one thing that can silently break the `filament` tier — the surface
 * demotion swallowing `isosurface` and drawing a cartoon of a structure that is
 * not loaded — is a pure function call away.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  HEAVY_SCENE_ATOM_SITES, HEAVY_SCENE_TRIANGLES, MEDIUM_SCENE_TRIANGLES,
  QUEST2_SCALE_HEAVY, QUEST2_SCALE_LIGHT, QUEST2_SCALE_MEDIUM,
  QUEST2_STATIC_TRIANGLE_CEILING, SURFACE_FALLBACK_REPRESENTATION,
  VOLUME_REPRESENTATIONS,
  framebufferScaleFor, isDenseRepresentation, isSurfaceRepresentation, isVolumeRepresentation,
  isosurfaceForBudget, quest2TriangleFramebufferScale, renderBudget, representationForBudget,
} from './xr-render-budget.mjs';

/**
 * EMD-6347 mean-downsampled 4x, meshed at contour 3.3. Measured, not estimated.
 *
 * Read out of the demo index rather than retyped. The count was 177,604 —
 * Mol*'s CPU marching cubes over the float32 grid — until it was measured
 * against what a headset actually draws, which is 178,236 off the GPU
 * isosurface path's uint8 copy of the same grid. This file held the old number
 * after the index moved, so the page's own rules were being tested against a
 * mesh the product no longer ships.
 */
const FILAMENT_TRIANGLES = filamentTriangles();
const FILAMENT_INDEX_TRIANGLES = 178_236;

function filamentTriangles() {
  const index = JSON.parse(readFileSync(new URL('../../plugin/demos/index.json', import.meta.url), 'utf8'));
  const growth = index.demos.find(demo => demo.name === 'microtubule-growth');
  const stage = growth.stages.find(entry => entry.id === 'filament');
  return stage.coordinates.volume.triangles;
}
const FILAMENT_GRID = Object.freeze([128, 128, 128]);
/** A mesh deliberately over the ceiling, for the refusal. */
const OVERSIZE_TRIANGLES = 600_000;

test('the page and the Mac hold the same static-mesh ceiling', () => {
  // A Mac that offers a tier the page then refuses is worse than either rule
  // alone, so the number is read out of the TypeScript rather than retyped.
  const source = readFileSync(new URL('../../plugin/src/molecular-growth.ts', import.meta.url), 'utf8');
  const found = /export const QUEST2_TRIANGLE_CEILING = ([\d_]+);/.exec(source);
  assert.ok(found, 'plugin/src/molecular-growth.ts must export QUEST2_TRIANGLE_CEILING');
  assert.equal(Number(found[1].replaceAll('_', '')), QUEST2_STATIC_TRIANGLE_CEILING);
  assert.equal(QUEST2_STATIC_TRIANGLE_CEILING, 500_000);
});

test('the demo index still ships the mesh this page was measured against', () => {
  // One number that three files and the driver key on. If the downsample, the
  // crop or the contour ever moves, this fails here rather than in a headset,
  // and every comment that quotes it has to be re-measured.
  assert.equal(FILAMENT_TRIANGLES, FILAMENT_INDEX_TRIANGLES);
  // The earlier Quest 2 hold was lifted on the measured size; nothing in the
  // page's own budget may quietly put it back.
  assert.equal(isosurfaceForBudget({ deviceClass: 'quest2', triangles: FILAMENT_TRIANGLES, grid: FILAMENT_GRID }), 'allow');
  assert.ok(FILAMENT_TRIANGLES < QUEST2_STATIC_TRIANGLE_CEILING);
});

test('a Quest 2 draws the filament mesh and refuses one three times its size', () => {
  assert.equal(isosurfaceForBudget({ deviceClass: 'quest2', triangles: FILAMENT_TRIANGLES, grid: FILAMENT_GRID }), 'allow');
  assert.equal(isosurfaceForBudget({ deviceClass: 'quest2', triangles: QUEST2_STATIC_TRIANGLE_CEILING }), 'allow');
  assert.equal(isosurfaceForBudget({ deviceClass: 'quest2', triangles: OVERSIZE_TRIANGLES }), 'refuse');
  for (const device of ['quest3', 'quest-pro', 'vision-pro', 'unknown']) {
    assert.equal(isosurfaceForBudget({ deviceClass: device, triangles: OVERSIZE_TRIANGLES }), 'allow');
  }
});

test('an unmeasured mesh is refused on the one device with a ceiling', () => {
  // The triangle count is measured by meshing the prepared map; a tier that
  // arrives without one is a promise nobody checked.
  assert.equal(isosurfaceForBudget({ deviceClass: 'quest2' }), 'refuse');
  assert.equal(isosurfaceForBudget({ deviceClass: 'quest2', triangles: 0 }), 'refuse');
  assert.equal(isosurfaceForBudget({ deviceClass: 'quest2', triangles: FILAMENT_TRIANGLES, grid: [128, 0, 128] }), 'refuse');
});

test('both volume and molecular surfaces preserve their requested representation', () => {
  // THE trap this file exists for. `isosurface` is a marching-cubes surface, so
  // sooner or later somebody adds it to SURFACE_REPRESENTATIONS; the demotion
  // would then replace the tier's only geometry with a cartoon of a structure
  // that was never loaded, i.e. an empty room with a caption in it.
  assert.equal(representationForBudget('isosurface',
    { deviceClass: 'quest2', atomSites: 0, presenting: true }), 'isosurface');
  assert.equal(representationForBudget('isosurface',
    { deviceClass: 'quest2', atomSites: HEAVY_SCENE_ATOM_SITES * 4, presenting: true }), 'isosurface');
  // Structure surfaces also retain the requested scientific representation.
  assert.equal(representationForBudget('molecular-surface',
    { deviceClass: 'quest2', atomSites: HEAVY_SCENE_ATOM_SITES * 2, presenting: true }),
  'molecular-surface');
});

test('a volume representation is not dense and not a structure surface', () => {
  assert.deepEqual([...VOLUME_REPRESENTATIONS], ['isosurface']);
  assert.ok(isVolumeRepresentation('isosurface') && isVolumeRepresentation(' ISOSURFACE '));
  assert.ok(!isVolumeRepresentation('molecular-surface'));
  // Deliberate: "dense" in this module means "has a cheaper representation of
  // the same data". A density map has none.
  assert.equal(isDenseRepresentation('isosurface'), false);
  assert.equal(isSurfaceRepresentation('isosurface'), false);
});

test('the framebuffer tier reads triangles when the scene has no atoms', () => {
  // Without the mesh ladder a volume scene reports zero atom sites and takes
  // the LIGHTEST framebuffer tier, which is backwards for the largest static
  // mesh this product ships.
  assert.equal(quest2TriangleFramebufferScale(0), null);
  assert.equal(quest2TriangleFramebufferScale(MEDIUM_SCENE_TRIANGLES - 1), QUEST2_SCALE_LIGHT);
  assert.equal(quest2TriangleFramebufferScale(HEAVY_SCENE_TRIANGLES), QUEST2_SCALE_MEDIUM);
  assert.equal(quest2TriangleFramebufferScale(FILAMENT_TRIANGLES), QUEST2_SCALE_HEAVY);
  assert.equal(framebufferScaleFor('quest2', 0, FILAMENT_TRIANGLES), QUEST2_SCALE_HEAVY);
  assert.equal(framebufferScaleFor('quest2', 0), QUEST2_SCALE_LIGHT);
  // Every other class keeps native scale whatever the mesh is.
  assert.equal(framebufferScaleFor('quest3', 0, FILAMENT_TRIANGLES), 1);
});

test('the budget reports a mesh scene as heavy and never mixes the units', () => {
  const budget = renderBudget({ device: 'quest2', atomSites: 0, triangles: FILAMENT_TRIANGLES });
  assert.equal(budget.atomSites, 0);
  assert.equal(budget.triangles, FILAMENT_TRIANGLES);
  assert.equal(budget.heavyScene, true);
  assert.equal(budget.framebufferScale, QUEST2_SCALE_HEAVY);
  // An atomic scene is unchanged by the new field.
  const atomic = renderBudget({ device: 'quest2', atomSites: 13_121 });
  assert.equal(atomic.triangles, undefined, 'an atomic scene carries no triangle field');
  assert.equal(atomic.heavyScene, false);
  assert.equal(atomic.framebufferScale, QUEST2_SCALE_MEDIUM);
});
