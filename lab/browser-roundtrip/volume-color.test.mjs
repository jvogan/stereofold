/**
 * The radial colour key and the measured tube axis, held without a browser.
 *
 * `measureIsoExtent` is the build-time scan `buildVolumeCandidate` runs over
 * the thresholded voxels; the theme in the same module colours the mesh the
 * scan describes. Both are pure here so the cutoff, the buckets and the axis
 * are test values rather than headset lore.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  VOLUME_CROWN_COLOR, VOLUME_CROWN_CUTOFF_ANGSTROM, VOLUME_RADIAL_COLOR_THEME, VOLUME_WALL_COLOR,
  VolumeRadialColorTheme, VolumeRadialColorThemeProvider,
  crownBucket, measureIsoExtent, pointParams, radiusFromAxis, registerVolumeRadialColorTheme,
  volumeColorFallbackReason, volumeColorSelection, volumeIsoExtentOf,
  volumeRadialThemeRegistered, volumeThemePaint,
} from './volume-color.mjs';

/** A synthetic tube along z: wall ring at radius 100, crown knobs at 150. */
function tubeCells() {
  const dimensions = [21, 21, 41];
  const [xn, yn] = dimensions;
  const data = new Float32Array(dimensions[0] * dimensions[1] * dimensions[2]);
  const getCoords = (index, out) => {
    out[0] = index % xn;
    out[1] = Math.floor(index / xn) % yn;
    out[2] = Math.floor(index / (xn * yn));
    return out;
  };
  for (let index = 0; index < data.length; index += 1) {
    const point = getCoords(index, [0, 0, 0]);
    const radius = Math.hypot(point[0] - 10, point[1] - 10);
    const crown = point[2] % 10 === 0 && radius >= 140 / 10 && radius <= 160 / 10;
    data[index] = Math.abs(radius - 10) < 1.5 || crown ? 5 : 0;
  }
  return { data, space: { dimensions, getCoords } };
}

test('the theme is named, applicable to a volume, and registers once', () => {
  assert.equal(VOLUME_RADIAL_COLOR_THEME, 'volume-radial');
  assert.equal(VolumeRadialColorThemeProvider.name, VOLUME_RADIAL_COLOR_THEME);
  assert.equal(VolumeRadialColorThemeProvider.isApplicable({ volume: {} }), true);
  assert.equal(VolumeRadialColorThemeProvider.isApplicable({}), false);
  const registry = fakeRegistry();
  assert.equal(registerVolumeRadialColorTheme(pluginWith(registry)), true);
  assert.deepEqual(registry.added, [VolumeRadialColorThemeProvider]);
  assert.equal(registerVolumeRadialColorTheme(undefined), false);
  // A second viewer over the same plugin reads as success, not a throw, and
  // does not write the provider a second time.
  assert.equal(registerVolumeRadialColorTheme(pluginWith(registry)), true);
  assert.deepEqual(registry.added, [VolumeRadialColorThemeProvider]);
});

/**
 * The registry that drew the cream map.
 *
 * Mol*'s `ThemeRegistry.get` ends `return this._map.get(name) || this.emptyProvider`
 * (mol-theme/theme.js), so an unknown name answers with a TRUTHY provider whose
 * name is '' and whose factory is `ColorTheme.Empty` — uniform 0xCCCCCC. The
 * old registration test mocked `get: () => undefined`, which no real registry
 * ever does, so `if (registry.get(name)) return true` passed the test and never
 * registered the theme in the headset.
 */
function fakeRegistry() {
  const emptyProvider = { name: '', label: '', factory: () => ({ granularity: 'uniform', color: () => 0xcccccc }) };
  const map = new Map();
  return {
    added: [],
    add(provider) {
      if (map.has(provider.name)) throw Error(`${provider.name} already registered.`);
      map.set(provider.name, provider);
      this.added.push(provider);
    },
    has(provider) { return map.has(provider.name); },
    get(name) { return map.get(name) || emptyProvider; },
  };
}

function pluginWith(registry) {
  return { representation: { volume: { themes: { colorThemeRegistry: registry } } } };
}

test('a registry whose get never misses does not read as already registered', () => {
  const registry = fakeRegistry();
  // The exact shape of the defect: `get` is truthy before anything was added.
  assert.ok(registry.get(VOLUME_RADIAL_COLOR_THEME));
  assert.equal(registry.get(VOLUME_RADIAL_COLOR_THEME).name, '');
  assert.equal(volumeRadialThemeRegistered(registry), false);
  assert.equal(registerVolumeRadialColorTheme(pluginWith(registry)), true);
  assert.equal(volumeRadialThemeRegistered(registry), true);
  assert.deepEqual(registry.added, [VolumeRadialColorThemeProvider]);
  assert.equal(volumeRadialThemeRegistered(undefined), false);
});

test('a registry with no `has` falls back to comparing the provider name', () => {
  const map = new Map();
  const empty = { name: '' };
  const registry = { add: (provider) => map.set(provider.name, provider), get: (name) => map.get(name) || empty };
  assert.equal(volumeRadialThemeRegistered(registry), false);
  assert.equal(registerVolumeRadialColorTheme(pluginWith(registry)), true);
  assert.equal(volumeRadialThemeRegistered(registry), true);
});

test('a registry that refuses the add reports failure rather than success', () => {
  const registry = { add: () => { throw Error('refused'); }, has: () => false, get: () => ({ name: '' }) };
  assert.equal(registerVolumeRadialColorTheme(pluginWith(registry)), false);
});

test('the colour selection names the theme, or says why it could not', () => {
  const isoExtent = { axisPoint: [1, 2, 3], axisDirection: [0, 0, 1] };
  const picked = volumeColorSelection({ isoExtent, registered: true });
  assert.equal(picked.color, VOLUME_RADIAL_COLOR_THEME);
  assert.deepEqual(picked.colorParams.axisPoint, { x: 1, y: 2, z: 3 });
  assert.deepEqual(picked.colorParams.axisDirection, { x: 0, y: 0, z: 1 });
  assert.equal(picked.colorParams.cutoff, VOLUME_CROWN_CUTOFF_ANGSTROM);
  assert.equal(volumeColorFallbackReason({ isoExtent, registered: true }), null);

  const unregistered = volumeColorSelection({ isoExtent, registered: false, fallbackColor: 0x808080 });
  assert.equal(unregistered.color, 'uniform');
  assert.deepEqual(unregistered.colorParams, { value: 0x808080 });
  assert.equal(volumeColorFallbackReason({ isoExtent, registered: false }), 'theme_not_registered');
  assert.equal(volumeColorSelection({ isoExtent: null, registered: true }).color, 'uniform');
  assert.equal(volumeColorFallbackReason({ isoExtent: null, registered: true }), 'no_measured_extent');
});

/** A render object carrying a `vertex` colour texture of the given hex list. */
function texturedObject(hexes, { pad = 0 } = {}) {
  const array = new Uint8Array((hexes.length + pad) * 3);
  hexes.forEach((hex, index) => {
    const value = Number.parseInt(hex.slice(1), 16);
    array[index * 3] = (value >> 16) & 0xff;
    array[index * 3 + 1] = (value >> 8) & 0xff;
    array[index * 3 + 2] = value & 0xff;
  });
  return { values: { dColorType: { ref: { value: 'vertex' } }, tColor: { ref: { value: { array } } },
    uVertexCount: { ref: { value: hexes.length } } } };
}

test('the paint read-back buckets the live colour data, not the asked-for params', () => {
  const hexes = [VOLUME_WALL_COLOR, VOLUME_WALL_COLOR, VOLUME_CROWN_COLOR, '#123456'];
  // The padding texels past `uVertexCount` are texture slack, never vertices.
  const object = texturedObject(hexes, { pad: 12 });
  const repr = { theme: { color: { factory: VolumeRadialColorTheme } }, renderObjects: [object] };
  const paint = volumeThemePaint({ obj: { data: { repr } } });
  assert.equal(paint.themed, true);
  assert.equal(paint.colorType, 'vertex');
  assert.equal(paint.vertices, 4);
  assert.equal(paint.wall, 2);
  assert.equal(paint.crown, 1);
  assert.equal(paint.other, 1);
  assert.equal(paint.uniform, null);
});

test('the paint read-back names the cream map the headset actually drew', () => {
  // What run 7 had: Mol* fell back to `ColorTheme.Empty`, uniform 0xCCCCCC.
  const repr = { theme: { color: { factory: () => ({}) } },
    renderObjects: [{ values: { dColorType: { ref: { value: 'uniform' } },
      uColor: { ref: { value: [0.8, 0.8, 0.8] } } } }] };
  const paint = volumeThemePaint({ data: { repr } });
  assert.equal(paint.themed, false);
  assert.equal(paint.colorType, 'uniform');
  assert.equal(paint.uniform, '#cccccc');
  assert.equal(paint.vertices, 0);
  // Nothing to read is not a claim that the map is painted.
  assert.equal(volumeThemePaint(undefined).themed, false);
  assert.equal(volumeThemePaint({}).colorType, null);
});

test('the scan finds the tube, its long axis, and nothing when empty', () => {
  const found = measureIsoExtent(tubeCells(), 3.3);
  assert.ok(found);
  assert.ok(found.count > 0);
  // Long axis is z: the index bbox is longest there.
  assert.ok(found.max[2] - found.min[2] > found.max[0] - found.min[0]);
  assert.ok(Math.abs(found.axis[2]) > 0.9, `axis ${found.axis}`);
  assert.deepEqual(found.centroid.map(value => Math.round(value)), [10, 10, 20]);
  assert.equal(measureIsoExtent(tubeCells(), 99), null);
  assert.equal(measureIsoExtent(undefined, 3.3), null);
  assert.equal(measureIsoExtent(tubeCells(), Number.NaN), null);
});

test('radius and bucket agree with the theme on wall and crown', () => {
  const axisPoint = [0, 0, 0], axisDirection = [0, 0, 2];
  assert.equal(radiusFromAxis([100, 0, 37], axisPoint, axisDirection), 100);
  assert.equal(radiusFromAxis([0, 0, 37], axisPoint, axisDirection), 0);
  assert.equal(crownBucket(100), 'wall');
  assert.equal(crownBucket(VOLUME_CROWN_CUTOFF_ANGSTROM), 'wall');
  assert.equal(crownBucket(VOLUME_CROWN_CUTOFF_ANGSTROM + 0.5), 'crown');
  const theme = VolumeRadialColorTheme({}, {
    axisPoint: { x: 0, y: 0, z: 0 },
    axisDirection: { x: 0, y: 0, z: 1 },
    cutoff: VOLUME_CROWN_CUTOFF_ANGSTROM,
    wallColor: 0x123456, crownColor: 0xabcdef, defaultColor: 0x999999,
  });
  assert.equal(theme.granularity, 'vertex');
  const at = (position) => theme.color({ kind: 'position-location', position, normal: [0, 0, 1] });
  assert.equal(at([100, 0, 0]), 0x123456);
  assert.equal(at([200, 0, 0]), 0xabcdef);
  assert.equal(theme.color({ cell: 7 }), 0x999999);
});

test('the scan becomes a Cartesian extent with corners, or nothing', async () => {
  const { Mat4 } = await import('molstar/lib/mol-math/linear-algebra.js');
  const { Grid } = await import('molstar/lib/mol-model/volume.js');
  const cells = tubeCells();
  const grid = { cells, transform: { kind: 'matrix', matrix: Mat4.identity() } };
  const scan = measureIsoExtent(cells, 3.3);
  const extent = volumeIsoExtentOf(grid, scan, 3.3);
  assert.ok(extent);
  assert.equal(extent.corners.length, 8);
  assert.equal(extent.voxels, scan.count);
  assert.ok(extent.radius > 0);
  assert.deepEqual(extent.center, Array.from(Grid.getIsosurfaceBoundingSphere(grid, 3.3).center));
  assert.equal(extent.radius, Grid.getIsosurfaceBoundingSphere(grid, 3.3).radius);
  assert.ok(Math.abs(Math.hypot(...extent.axisDirection) - 1) < 1e-9);
  assert.deepEqual(pointParams([1, 2, 3]), { x: 1, y: 2, z: 3 });
  // An undefined contour meshes nothing: refusing it here is what keeps a
  // misbuilt candidate from framing a garbage sphere as the density.
  assert.equal(volumeIsoExtentOf(grid, scan, undefined), null);
  assert.equal(volumeIsoExtentOf(grid, null, 3.3), null);
});

test('the shipped key is two hex colours with a 135 A cutoff', () => {
  assert.match(VOLUME_WALL_COLOR, /^#[0-9a-f]{6}$/);
  assert.match(VOLUME_CROWN_COLOR, /^#[0-9a-f]{6}$/);
  assert.notEqual(VOLUME_WALL_COLOR, VOLUME_CROWN_COLOR);
  assert.equal(VOLUME_CROWN_CUTOFF_ANGSTROM, 135);
});

test('the viewer asks for the theme through one selection and measures what it got', async () => {
  // The source rather than a live viewer, for `volume-swap.test.mjs`'s reason:
  // this needs Mol* and a WebGL context, and what has to hold is the wiring.
  // Two call sites used to spell the colour params out by hand, and editing
  // one of them could paint a chapter differently from the build.
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('./viewer.mjs', import.meta.url), 'utf8');
  const build = source.slice(source.indexOf('async function buildVolumeCandidate('));
  assert.match(build.slice(0, build.indexOf('\n  async function')), /\.\.\.volumeColorSelection\(\{ isoExtent: candidate\.isoExtent/);
  const appearance = source.slice(source.indexOf('async function applyVolumeAppearance('));
  assert.match(appearance.slice(0, appearance.indexOf('\n  async function')), /\.\.\.volumeColorSelection\(\{ isoExtent: volumeIsoExtent/);
  // Neither site may spell a theme name or a key colour out for itself again.
  assert.equal(/colorParams: \{ axisPoint:/.test(source), false);
  // The ring's `themed` must be the MEASURED paint, never the asked-for flag:
  // one device run recorded `themed:true` on a cream map because it recorded the ask.
  assert.match(source, /themed: candidate\.paint\.themed, asked: themed/);
  assert.match(source, /candidate\.paint = volumeThemePaint\(candidate\.representation\)/);
  assert.match(source, /volumePaint = volumeThemePaint\(representation\)/);
  // And the outcome must reach the snapshot, which is where `inspector.ts`
  // copies it onto the `grow` phases that outlive the ring's rollover.
  assert.match(source, /volumeTheme: volumePaint,/);
});

test('the swap trace carries the theme outcome onto the grow phases', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../../plugin/src/inspector.ts', import.meta.url), 'utf8');
  assert.match(source, /sourceSwapContext\.theme=\{/);
  assert.match(source, /workspace\.snapshot\(\)\?\.volumeTheme/);
});
