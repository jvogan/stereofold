/**
 * The density tier must reach the wearer's eye COLOURED, and the only witness
 * that can say so is Mol*'s own colour data.
 *
 * A 178,236-triangle filament isosurface on a Quest 2 at ~55 % of the lens
 * drew WHITE. The teal-and-amber radial theme had shipped, the build record
 * said `themed:true`, and the map was still cream, because `themed` was what
 * the page ASKED Mol* for rather than what Mol* did.
 *
 * The defect is one line of presence-testing. `ThemeRegistry.get` in
 * `mol-theme/theme.js` ends
 *
 *     return this._map.get(name) || this.emptyProvider;
 *
 * so it cannot miss: an unregistered name answers with `ColorTheme.EmptyProvider`,
 * a truthy object whose `name` is `''` and whose factory is `ColorTheme.Empty` —
 * uniform `Color(0xCCCCCC)`, a cream. A guard written `if (registry.get(name))
 * return true` therefore reports the theme as already registered on a registry
 * that has never heard of it, skips the `add`, and every later lookup of
 * `'volume-radial'` — including the one inside `createVolumeRepresentationParams`
 * — falls through to that same empty provider. The representation is built with
 * `colorTheme.name === ''` and paints 0xCCCCCC over the whole map.
 *
 * None of that is visible from the theme factory, which is why the first
 * headless proof of the colour passed while the headset drew cream: it called
 * `VolumeRadialColorTheme(...)` directly. These tests never do. They go through
 * the registry and the representation params, build a real isosurface, and
 * count the colour texture Mol* filled.
 *
 * The map here is the few-kilobyte synthetic one, not the cached 8.39 MB
 * filament map, for the same reason `volume-triangle-count.test.ts` uses it.
 */
import { describe, expect, it } from 'vitest';
import { ColorTheme } from 'molstar/lib/mol-theme/color.js';
import { SizeTheme } from 'molstar/lib/mol-theme/size.js';
import { Theme } from 'molstar/lib/mol-theme/theme.js';
import { VolumeRepresentationRegistry } from 'molstar/lib/mol-repr/volume/registry.js';
import { createVolumeRepresentationParams } from 'molstar/lib/mol-plugin-state/helpers/volume-representation-params.js';
import { parse } from 'molstar/lib/mol-io/reader/ccp4/parser.js';
import { volumeFromCcp4 } from 'molstar/lib/mol-model-formats/volume/ccp4.js';
import { syntheticMap } from './synthetic-map.js';
// @ts-ignore Shared JavaScript density module: the page's own colour theme.
import { VOLUME_CROWN_COLOR, VOLUME_RADIAL_COLOR_THEME, VOLUME_WALL_COLOR, VolumeRadialColorThemeProvider, measureIsoExtent, registerVolumeRadialColorTheme, volumeColorSelection, volumeIsoExtentOf, volumeRadialThemeRegistered, volumeThemePaint } from '../../lab/browser-roundtrip/volume-color.mjs';
// @ts-ignore Shared JavaScript density module: the page's own isosurface params.
import { VOLUME_REPRESENTATION, volumeIsosurfaceParams } from '../../lab/browser-roundtrip/volume-source.mjs';

/** Mol*'s own empty colour, and the colour the headset drew. */
const MOLSTAR_EMPTY_COLOR = 0xcccccc;

/** A plugin-shaped object carrying only what the volume build path touches. */
function pluginLike() {
  return {
    representation: {
      volume: {
        registry: new VolumeRepresentationRegistry(),
        themes: { colorThemeRegistry: ColorTheme.createRegistry(), sizeThemeRegistry: SizeTheme.createRegistry() },
      },
    },
  } as any;
}

/** The guard as it shipped, restored verbatim, so the trap can be demonstrated. */
function registerByGetTruthiness(plugin: any): boolean {
  const registry = plugin?.representation?.volume?.themes?.colorThemeRegistry;
  if (!registry || typeof registry.add !== 'function') return false;
  try { if (typeof registry.get === 'function' && registry.get(VOLUME_RADIAL_COLOR_THEME)) return true; } catch { /* */ }
  try { registry.add(VolumeRadialColorThemeProvider); return true; } catch { return false; }
}

function molstarReadableMap(side: number): Buffer {
  return syntheticMap(side, bytes => {
    bytes.writeInt32LE(side, 28); bytes.writeInt32LE(side, 32); bytes.writeInt32LE(side, 36);
    bytes.writeFloatLE(side, 40); bytes.writeFloatLE(side, 44); bytes.writeFloatLE(side, 48);
    bytes.writeFloatLE(90, 52); bytes.writeFloatLE(90, 56); bytes.writeFloatLE(90, 60);
    bytes.writeInt32LE(1, 64); bytes.writeInt32LE(2, 68); bytes.writeInt32LE(3, 72);
  });
}

async function syntheticVolume(side = 16) {
  const parsed = await parse(new Uint8Array(molstarReadableMap(side)), 'synthetic').run();
  if (parsed.isError) throw Error(parsed.message);
  return volumeFromCcp4(parsed.result, { entryId: 'synthetic' }).run();
}

/**
 * Build the isosurface the way `VolumeRepresentation3D.apply` does — the same
 * provider, the same `Theme.create`, the same params object the viewer hands
 * the transform — and read back what Mol* painted.
 *
 * No WebGL here, so this is the CPU marching-cubes geometry. The theme is
 * chosen on the representation's `colorTheme` params, and both geometries
 * resolve it through the same two lines: `mesh.js:601` and
 * `texture-mesh.js:162` each build a position iterator and hand it to
 * `createColors`, which dispatches `'vertex'` to `createVertexColor`
 * (`color-data.js:38`). A theme named on the params cannot reach one geometry
 * and miss the other.
 */
async function buildAndRead(register: (plugin: any) => boolean, cutoffAngstrom?: number) {
  const plugin = pluginLike();
  const registered = register(plugin);
  const volume = await syntheticVolume();
  const contour = (volume.grid.stats.min + volume.grid.stats.max) / 2;
  const scan = measureIsoExtent(volume.grid.cells, contour);
  expect(scan).toBeTruthy();
  const isoExtent = volumeIsoExtentOf(volume.grid, scan, contour);
  const selection = volumeColorSelection({ isoExtent, registered, fallbackColor: 0x9e9e9e });
  if (cutoffAngstrom !== undefined && selection.colorParams) {
    (selection.colorParams as Record<string, unknown>).cutoff = cutoffAngstrom;
  }
  const params = createVolumeRepresentationParams(plugin, volume, {
    type: VOLUME_REPRESENTATION,
    typeParams: volumeIsosurfaceParams({ contour }),
    ...selection,
  } as any);
  const themes = plugin.representation.volume.themes;
  const provider = plugin.representation.volume.registry.get(params.type.name);
  const repr = provider.factory({ webgl: undefined, ...themes }, provider.getParams);
  repr.setTheme(Theme.create(themes, { volume, locationKinds: provider.locationKinds } as any, params));
  await repr.createOrUpdate(params.type.params, volume).run();
  return { registered, askedFor: params.colorTheme.name, paint: volumeThemePaint(repr) };
}

describe('the radial colour theme reaches the isosurface', () => {
  it('cannot be presence-tested with `get`, because Mol* never misses', () => {
    const registry = ColorTheme.createRegistry();
    // The trap, stated as a value: truthy, and not the theme.
    const before = registry.get(VOLUME_RADIAL_COLOR_THEME);
    expect(before).toBeTruthy();
    expect(before.name).toBe('');
    const empty = before.factory({} as any, {} as any) as { color(location: unknown, isSecondary: boolean): number };
    expect(empty.color(null, false)).toBe(MOLSTAR_EMPTY_COLOR);
    // So the membership test has to be `has`, and it says no.
    expect(volumeRadialThemeRegistered(registry)).toBe(false);
    expect(registry.has(VolumeRadialColorThemeProvider)).toBe(false);
  });

  it('registers once and then reports itself registered', () => {
    const plugin = pluginLike();
    const registry = plugin.representation.volume.themes.colorThemeRegistry;
    expect(registerVolumeRadialColorTheme(plugin)).toBe(true);
    expect(registry.has(VolumeRadialColorThemeProvider)).toBe(true);
    // A second viewer over the same plugin: `add` would throw, and does not run.
    expect(registerVolumeRadialColorTheme(plugin)).toBe(true);
    expect(registry.get(VOLUME_RADIAL_COLOR_THEME).name).toBe(VOLUME_RADIAL_COLOR_THEME);
  });

  it('resolves to a nameless empty theme when the registration was skipped', () => {
    const plugin = pluginLike();
    expect(registerByGetTruthiness(plugin)).toBe(true); // The lie.
    expect(plugin.representation.volume.themes.colorThemeRegistry
      .has(VolumeRadialColorThemeProvider)).toBe(false);
    const params = createVolumeRepresentationParams(plugin, undefined, {
      type: VOLUME_REPRESENTATION, color: VOLUME_RADIAL_COLOR_THEME, colorParams: { cutoff: 135 },
    } as any);
    // This is the cream map: an empty name, which resolves to ColorTheme.Empty.
    expect(params.colorTheme.name).toBe('');
  });

  it('resolves to the radial theme once it is actually registered', () => {
    const plugin = pluginLike();
    expect(registerVolumeRadialColorTheme(plugin)).toBe(true);
    const params = createVolumeRepresentationParams(plugin, undefined, {
      type: VOLUME_REPRESENTATION, color: VOLUME_RADIAL_COLOR_THEME, colorParams: { cutoff: 135 },
    } as any);
    expect(params.colorTheme.name).toBe(VOLUME_RADIAL_COLOR_THEME);
    expect(params.colorTheme.params.cutoff).toBe(135);
  });

  it('paints the built isosurface with vertex colours, both keys, nothing unkeyed', async () => {
    // A cutoff inside the synthetic blob's radius, so both buckets are real.
    const { registered, askedFor, paint } = await buildAndRead(registerVolumeRadialColorTheme, 3);
    expect(registered).toBe(true);
    expect(askedFor).toBe(VOLUME_RADIAL_COLOR_THEME);
    expect(paint.themed).toBe(true);
    // Per-vertex, not per-group and not uniform: the granularity that survives
    // the GPU path, where the geometry has no groups to colour by.
    expect(paint.colorType).toBe('vertex');
    expect(paint.vertices).toBeGreaterThan(0);
    expect(paint.wall).toBeGreaterThan(0);
    expect(paint.crown).toBeGreaterThan(0);
    // Every texel is one of the two keys. An unkeyed vertex would mean the
    // theme fell back per vertex rather than as a whole.
    expect(paint.other).toBe(0);
    expect(paint.wall + paint.crown).toBe(paint.vertices);
    expect(paint.uniform).toBeNull();
  });

  it('paints the same isosurface cream when the registration was skipped', async () => {
    const { registered, askedFor, paint } = await buildAndRead(registerByGetTruthiness, 3);
    expect(registered).toBe(true); // The old guard's answer, and it is wrong.
    expect(askedFor).toBe('');
    expect(paint.themed).toBe(false);
    expect(paint.colorType).toBe('uniform');
    // The exact cream the headset drew.
    expect(paint.uniform).toBe('#cccccc');
    expect(paint.wall + paint.crown).toBe(0);
  });

  it('keeps the two keys distinct so the crown can be seen against the wall', () => {
    expect(VOLUME_WALL_COLOR).not.toBe(VOLUME_CROWN_COLOR);
    expect(VOLUME_WALL_COLOR.toLowerCase()).not.toBe('#cccccc');
    expect(VOLUME_CROWN_COLOR.toLowerCase()).not.toBe('#cccccc');
  });
});
