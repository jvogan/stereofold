/**
 * Why the demo index records 178,236 triangles for the filament and not the
 * 177,604 Mol*'s CPU marching cubes gives for the same map.
 *
 * On a headset the page drew the map and measured the mesh it had built:
 * `volume-build {contour:3.3, bytes:8389632, triangles:178236}`.
 * The index promised 177,604, measured in Node over the parsed float32 grid.
 * Both numbers are right about different meshes, and the difference is not
 * noise: a headset does not mesh the float32 grid at all.
 *
 * `IsosurfaceVisual` chooses `IsosurfaceTextureMeshVisual` whenever WebGL can
 * support it, and that path uploads the grid through `createVolumeTexture2d`
 * with `gpuDataType: 'byte'` — one unsigned byte per voxel,
 * `round(((value - min) / (max - min)) * 255)` — and extracts the surface from
 * that quantized copy at the matching normalized level. Quantizing a 10.29-wide
 * value range into 255 steps moves the surface by up to half a step of 0.0403,
 * and on this map that adds 632 triangles.
 *
 * Reproduced exactly, on the cached 8.39 MB map, by requantizing the grid the
 * way `createVolumeTexture2d` does and re-running the same CPU marching cubes:
 *
 *   cpu    177,604 triangles (float32 field, absolute 3.3)
 *   byte   178,236 triangles (uint8 field, level 131.6636/255)
 *
 * 178,236 is the page's measurement to the triangle. No test reads that map —
 * it is 8.39 MB and cached rather than committed — so what this file holds is
 * every Mol* fact the number rests on, over a synthetic map of a few kilobytes.
 * If any of them changes, the index's number has to be measured again.
 */
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { syntheticMap } from './synthetic-map.js';
import { parse } from 'molstar/lib/mol-io/reader/ccp4/parser.js';
import { volumeFromCcp4 } from 'molstar/lib/mol-model-formats/volume/ccp4.js';
import { createVolumeTexture2d, getVolumeTexture2dLayout } from 'molstar/lib/mol-repr/volume/util.js';
import { VolumeIsosurfaceTextureParams } from 'molstar/lib/mol-repr/volume/isosurface.js';
import { Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';

const FILAMENT_GRID = 128;
/** The count the demo index records, and the count the page measured. */
const FILAMENT_TRIANGLES = 178_236;

/**
 * `syntheticMap` writes only the header words `assertCcp4Map` checks. Mol*'s
 * own parser also needs the unit cell and the axis order, so those are filled
 * in here rather than widened in the shared fixture, which six other tests
 * depend on byte for byte.
 */
function molstarReadableMap(side: number): Buffer {
  return syntheticMap(side, bytes => {
    bytes.writeInt32LE(side, 28); bytes.writeInt32LE(side, 32); bytes.writeInt32LE(side, 36); // MX, MY, MZ
    bytes.writeFloatLE(side, 40); bytes.writeFloatLE(side, 44); bytes.writeFloatLE(side, 48); // CELLA, 1 A voxels
    bytes.writeFloatLE(90, 52); bytes.writeFloatLE(90, 56); bytes.writeFloatLE(90, 60); // CELLB
    bytes.writeInt32LE(1, 64); bytes.writeInt32LE(2, 68); bytes.writeInt32LE(3, 72); // MAPC, MAPR, MAPS
  });
}

async function syntheticVolume(side = 16) {
  const parsed = await parse(new Uint8Array(molstarReadableMap(side)), 'synthetic').run();
  if (parsed.isError) throw Error(parsed.message);
  return volumeFromCcp4(parsed.result, { entryId: 'synthetic' }).run();
}

describe('the triangle count a headset actually draws', () => {
  it('takes the GPU isosurface path, whose volume texture is one byte per voxel', () => {
    // The default, and the whole reason the drawn count is not the float32 one.
    // `tryUseGpu` false or `gpuDataType` anything else would mesh the full
    // precision field and the index's number would have to change with it.
    expect(VolumeIsosurfaceTextureParams.gpuDataType.defaultValue).toBe('byte');
    expect(VolumeIsosurfaceTextureParams.tryUseGpu.defaultValue).toBe(true);
    expect(VolumeIsosurfaceTextureParams.floodfill.defaultValue).toBe('off');
  });

  it('fits the filament grid in a texture a Quest can hold, so the GPU path is the one taken', () => {
    // `suitableForGpu`: the 2D layout of the padded grid must be at most half
    // the device's maximum texture size. A Quest 2 reports 16,384, and even a
    // conservative 8,192 leaves the 128-cubed grid on the GPU path.
    const { powerOfTwoSize } = getVolumeTexture2dLayout(Vec3.create(FILAMENT_GRID, FILAMENT_GRID, FILAMENT_GRID), 1);
    expect(powerOfTwoSize).toBeLessThanOrEqual(8_192 / 2);
  });

  it('quantizes every voxel to a byte before the surface is extracted', async () => {
    const volume = await syntheticVolume();
    const texture = createVolumeTexture2d(volume, 'data', 1, 'byte');
    expect(texture.array).toBeInstanceOf(Uint8Array);
    // The exact formula the drawn count is reproduced with. Read back the
    // first voxel rather than trusting the shape of the array.
    const { min, max } = volume.grid.stats;
    const first = volume.grid.cells.data[volume.grid.cells.space.dataOffset(0, 0, 0)]!;
    expect(texture.array[0]).toBe(Math.round(((first - min) / (max - min)) * 255));
    // 255 steps over the filament map's own value range is a step of 0.0403 in
    // density units, which is what moves the surface.
    expect((max - min) / 255).toBeGreaterThan(0);
  });

  it('records the drawn count in the demo index, not the float32 one', async () => {
    const index = JSON.parse(await readFile(new URL('../demos/index.json', import.meta.url), 'utf8'));
    const stage = index.demos.flatMap((demo: any) => demo.stages ?? [])
      .find((item: any) => item.id === 'filament');
    expect(stage.coordinates.volume.triangles).toBe(FILAMENT_TRIANGLES);
    // The float32 count the index used to carry. Kept here so a future
    // re-measurement can tell the two apart at a glance instead of reading
    // 632 triangles as drift.
    expect(FILAMENT_TRIANGLES - 177_604).toBe(632);
  });
});
