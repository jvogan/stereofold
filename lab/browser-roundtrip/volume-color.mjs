/**
 * The density tier's two-colour key.
 *
 * The `filament` tier drew as one flat grey mesh (`VOLUME_UNIFORM_COLOR` in
 * `volume-source.mjs`) because an isosurface at one absolute contour is one
 * mesh with no chains in it. Grey is honest but it teaches nothing: the wall
 * and the EB3 crowns sitting in its grooves are the same wash, and on a
 * passthrough room a grey wash is a shadow.
 *
 * The key is radial distance from the tube's own axis, measured headless on
 * the prepared map: the wall's density peaks at 95-120 A from the axis and
 * EB3's shoulder runs past it to 182 A, so everything at or under
 * VOLUME_CROWN_CUTOFF_ANGSTROM is lattice wall teal and everything outside it
 * is EB3 crown amber. 85.1 / 14.9 per cent of the meshed vertices at the
 * shipped cutoff — a minority that reads, not a tint. The alternative,
 * colouring by nearest fitted-model
 * chain from 3JAK, costs a 43,066-atom nearest-neighbour solve per vertex
 * (84,578 of them) on the Quest 2's main thread at build time; the radial
 * solve is one subtraction and a dot product per vertex, and it needs no
 * coordinates the map tier does not already carry.
 *
 * The axis is MEASURED, not authored: `measureIsoExtent` runs one scan over
 * the thresholded voxels at build time (20,252 of 2,097,152 at contour 3.3),
 * and the theme is handed that scan's centroid and principal axis in
 * Cartesian Angstroms. A re-downsampled map moves the axis and the colours
 * follow it. The cutoff is the one number that is authored, and it is quoted
 * in Angstroms for the same reason.
 *
 * The Mol* half is a plain volume colour-theme provider
 * (`VolumeRadialColorThemeProvider`), registered once per viewer and chosen
 * by name in `buildVolumeCandidate`. Granularity is `vertex`: `color-data.js`
 * evaluates a vertex theme against the position iterator, so this colours the
 * real surface points on the CPU marching-cubes path AND on the GPU
 * texture-mesh path the headset takes — not the 2M grid cells. The triangle
 * count is untouched by construction: a theme writes colours, never geometry.
 */

import { Color } from 'molstar/lib/mol-util/color/index.js';
import { ParamDefinition as PD } from 'molstar/lib/mol-util/param-definition.js';
import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { Grid } from 'molstar/lib/mol-model/volume.js';
import { isPositionLocation } from 'molstar/lib/mol-geo/util/location-iterator.js';
import { ColorThemeCategory } from 'molstar/lib/mol-theme/color/categories.js';

/** The theme name `buildVolumeCandidate` asks `createVolumeRepresentationParams` for. */
export const VOLUME_RADIAL_COLOR_THEME = 'volume-radial';

/** Lattice wall teal: mid-chroma, mid-luminance, distinct from amber on a room. */
export const VOLUME_WALL_COLOR = '#3fa7c4';
/** EB3 crown amber: the minority key that names chapter 3's subject. */
export const VOLUME_CROWN_COLOR = '#e8a13c';

/**
 * Radial cutoff in Angstroms: at or under is wall, outside is crown.
 *
 * Read off the headless radial histogram of the shipped mesh (contour 3.3):
 * the wall band peaks at 95-120 A and the crown shoulder falls past 130 A,
 * so 135 A keeps 85.1 per cent teal and 14.9 per cent amber. Not zero and not
 * decoration: at 120 A a third of the wall would read as crown; at 150 A the
 * crowns would be under five per cent and unreadable at wearer resolution.
 */
export const VOLUME_CROWN_CUTOFF_ANGSTROM = 135;

/** A theme that colours an isosurface by radius about the filament axis. */
const DESCRIPTION = 'Colors a density isosurface by radial distance from the filament axis: lattice wall inside, crowns outside.';

export const VolumeRadialColorThemeParams = {
  axisPoint: PD.Group({
    x: PD.Numeric(0),
    y: PD.Numeric(0),
    z: PD.Numeric(0),
  }, { description: 'A point on the filament axis, in Cartesian Angstroms.' }),
  axisDirection: PD.Group({
    x: PD.Numeric(0),
    y: PD.Numeric(0),
    z: PD.Numeric(1),
  }, { description: 'The filament axis direction. Normalised by the theme.' }),
  cutoff: PD.Numeric(VOLUME_CROWN_CUTOFF_ANGSTROM, { min: 0, max: 500, step: 1 },
    { description: 'Radius in Angstroms past which a vertex reads as crown.' }),
  wallColor: PD.Color(Color.fromHexStyle(VOLUME_WALL_COLOR)),
  crownColor: PD.Color(Color.fromHexStyle(VOLUME_CROWN_COLOR)),
  defaultColor: PD.Color(Color(0xcccccc)),
};

export function VolumeRadialColorTheme(ctx, props) {
  const point = Vec3.create(props.axisPoint.x, props.axisPoint.y, props.axisPoint.z);
  const direction = Vec3.create(props.axisDirection.x, props.axisDirection.y, props.axisDirection.z);
  if (Vec3.magnitude(direction) > 1e-9) Vec3.normalize(direction, direction);
  else Vec3.set(direction, 0, 0, 1);
  const cutoff = Number.isFinite(props.cutoff) && props.cutoff > 0 ? props.cutoff : VOLUME_CROWN_CUTOFF_ANGSTROM;
  const wall = props.wallColor ?? Color.fromHexStyle(VOLUME_WALL_COLOR);
  const crown = props.crownColor ?? Color.fromHexStyle(VOLUME_CROWN_COLOR);
  const fallback = props.defaultColor ?? Color(0xcccccc);
  const offset = Vec3();
  const color = (location) => {
    if (!isPositionLocation(location)) return fallback;
    Vec3.sub(offset, location.position, point);
    const along = Vec3.dot(offset, direction);
    const radius = Math.hypot(offset[0] - along * direction[0],
      offset[1] - along * direction[1], offset[2] - along * direction[2]);
    return radius <= cutoff ? wall : crown;
  };
  return {
    factory: VolumeRadialColorTheme,
    granularity: 'vertex',
    preferSmoothing: true,
    color,
    props,
    description: DESCRIPTION,
  };
}

export const VolumeRadialColorThemeProvider = {
  name: VOLUME_RADIAL_COLOR_THEME,
  label: 'Filament Radial',
  category: ColorThemeCategory.Misc,
  factory: VolumeRadialColorTheme,
  getParams: () => VolumeRadialColorThemeParams,
  defaultValues: PD.getDefaultValues(VolumeRadialColorThemeParams),
  isApplicable: (ctx) => !!ctx.volume,
};

/**
 * Is the radial theme actually in this colour-theme registry?
 *
 * This is the whole reason the map drew cream in the headset.
 * Mol*'s `ThemeRegistry.get` is NOT a lookup that can miss — `theme.js` ends
 * it with `return this._map.get(name) || this.emptyProvider`, so an absent
 * name answers with `ColorTheme.EmptyProvider`, a truthy object whose `name`
 * is the empty string and whose factory is `ColorTheme.Empty`: uniform
 * `Color(0xCCCCCC)`. A presence test written as `if (registry.get(name))`
 * therefore always says yes, on a registry that has never heard of the theme.
 * `has(provider)` is the real membership test; the `name` comparison is the
 * fallback for a registry stub that has no `has`.
 */
export function volumeRadialThemeRegistered(registry) {
  if (!registry) return false;
  try {
    if (typeof registry.has === 'function') return !!registry.has(VolumeRadialColorThemeProvider);
  } catch { /* Fall through to the name comparison. */ }
  try {
    const found = typeof registry.get === 'function' ? registry.get(VOLUME_RADIAL_COLOR_THEME) : undefined;
    return !!found && found.name === VOLUME_RADIAL_COLOR_THEME;
  } catch { return false; }
}

/**
 * Register the radial theme on a viewer plugin, once, and answer with what
 * the registry holds afterwards rather than with what `add` did not throw on.
 *
 * `add` throws on a second registration of the same name, so a viewer built
 * over an already-seeded plugin reads as success without a second write — but
 * only because the membership test ran first and said so.
 */
export function registerVolumeRadialColorTheme(plugin) {
  const registry = plugin?.representation?.volume?.themes?.colorThemeRegistry;
  if (!registry || typeof registry.add !== 'function') return false;
  if (volumeRadialThemeRegistered(registry)) return true;
  try {
    registry.add(VolumeRadialColorThemeProvider);
  } catch { /* Raced, or refused: the membership test below is the verdict. */ }
  return volumeRadialThemeRegistered(registry);
}

/**
 * The `color` / `colorParams` half of the isosurface representation params.
 *
 * One function, so the build, the appearance rebuild and the headless proof
 * ask Mol* for the same theme with the same numbers. Path-independent by
 * construction: this only names a theme on the representation's
 * `colorTheme` params, and Mol* evaluates that theme through the geometry's
 * own position iterator in `createValues` — `mesh.js:601` on the CPU
 * marching-cubes path and `texture-mesh.js:162` on the GPU quantized path —
 * so neither path can be coloured while the other is not.
 *
 * @param isoExtent the measured extent (`volumeIsoExtentOf`), or null.
 * @param registered what `registerVolumeRadialColorTheme` answered.
 * @param fallbackColor the Mol* `Color` the uniform fallback paints.
 */
export function volumeColorSelection({ isoExtent, registered, fallbackColor } = {}) {
  if (registered && isoExtent) {
    return {
      color: VOLUME_RADIAL_COLOR_THEME,
      colorParams: {
        axisPoint: pointParams(isoExtent.axisPoint),
        axisDirection: pointParams(isoExtent.axisDirection),
        cutoff: VOLUME_CROWN_CUTOFF_ANGSTROM,
        wallColor: Color.fromHexStyle(VOLUME_WALL_COLOR),
        crownColor: Color.fromHexStyle(VOLUME_CROWN_COLOR),
      },
    };
  }
  return {
    color: 'uniform',
    colorParams: { value: fallbackColor ?? Color.fromHexStyle(VOLUME_WALL_COLOR) },
  };
}

/** Why the radial theme was not asked for, or null when it was. */
export function volumeColorFallbackReason({ isoExtent, registered } = {}) {
  if (!registered) return 'theme_not_registered';
  if (!isoExtent) return 'no_measured_extent';
  return null;
}

/** `#rrggbb` to three 0-255 channels. */
function hexChannels(hex) {
  const value = Number.parseInt(String(hex).slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/**
 * What the live representation is ACTUALLY painted with, read out of Mol*'s
 * own colour data rather than out of the params we asked for.
 *
 * `repr.theme.color.factory` says which theme object Mol* built (a refused
 * name silently becomes `ColorTheme.Empty`), and `values.tColor` is the
 * colour texture `createColors` filled — the same array on both geometry
 * paths, because `createVertexColor` writes one RGB triple per vertex
 * whether the vertices came from CPU marching cubes or from a GPU texture
 * readback. Counting it is the only test that cannot be fooled by a theme
 * that was named and then dropped.
 *
 * Cheap enough to run on the Quest: one pass over `uVertexCount` texels.
 */
export function volumeThemePaint(representation) {
  const repr = representation?.obj?.data?.repr ?? representation?.data?.repr
    ?? representation?.repr ?? representation;
  const themeColor = repr?.theme?.color;
  const themed = typeof themeColor?.factory === 'function' && themeColor.factory === VolumeRadialColorTheme;
  const summary = { themed, colorType: null, vertices: 0, wall: 0, crown: 0, other: 0, uniform: null };
  const objects = Array.isArray(repr?.renderObjects) ? repr.renderObjects : [];
  const wall = hexChannels(VOLUME_WALL_COLOR);
  const crown = hexChannels(VOLUME_CROWN_COLOR);
  for (const object of objects) {
    const values = object?.values;
    const colorType = values?.dColorType?.ref?.value;
    if (typeof colorType !== 'string') continue;
    if (!summary.colorType) summary.colorType = colorType;
    if (colorType === 'uniform') {
      const rgb = values?.uColor?.ref?.value;
      if (rgb && summary.uniform === null) {
        // `uColor` is normalised; Mol*'s empty theme lands here as #cccccc.
        summary.uniform = '#' + [0, 1, 2].map(index =>
          Math.round((rgb[index] ?? 0) * 255).toString(16).padStart(2, '0')).join('');
      }
      continue;
    }
    const array = values?.tColor?.ref?.value?.array;
    if (!array) continue;
    const declared = values?.uVertexCount?.ref?.value;
    const texels = Number.isFinite(declared) && declared > 0
      ? Math.min(declared, Math.floor(array.length / 3)) : Math.floor(array.length / 3);
    for (let index = 0; index < texels; index += 1) {
      const offset = index * 3;
      const r = array[offset], g = array[offset + 1], b = array[offset + 2];
      summary.vertices += 1;
      if (r === wall[0] && g === wall[1] && b === wall[2]) summary.wall += 1;
      else if (r === crown[0] && g === crown[1] && b === crown[2]) summary.crown += 1;
      else summary.other += 1;
    }
  }
  return summary;
}

/**
 * The index-space extent of the voxels at or above an absolute contour.
 *
 * Mol*-free: `cells` is `{ data, space: { dimensions, getCoords } }`, the
 * shape `grid.cells` already has, so `node --test` holds this without a
 * browser. One scan; the caller transforms the answer into Cartesian and
 * hands the axis to the theme above.
 *
 * @returns null when no voxel reaches the contour — a contour above the
 *   map's own maximum, which the caller refuses rather than frames.
 */
export function measureIsoExtent(cells, isoValue) {
  if (!cells || !cells.data || !Number.isFinite(cells.data.length)
    || !cells.space || !Array.isArray(cells.space.dimensions) || typeof cells.space.getCoords !== 'function'
    || !Number.isFinite(isoValue)) return null;
  const data = cells.data;
  const getCoords = cells.space.getCoords;
  const point = [0, 0, 0];
  let count = 0;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const sum = [0, 0, 0];
  for (let index = 0; index < data.length; index += 1) {
    if (!(data[index] >= isoValue)) continue;
    getCoords(index, point);
    count += 1;
    for (let axis = 0; axis < 3; axis += 1) {
      sum[axis] += point[axis];
      if (point[axis] < min[axis]) min[axis] = point[axis];
      if (point[axis] > max[axis]) max[axis] = point[axis];
    }
  }
  if (count === 0) return null;
  const centroid = sum.map(value => value / count);
  // Second moments about the centroid; the principal axis is the tube.
  let cxx = 0, cyy = 0, czz = 0, cxy = 0, cxz = 0, cyz = 0;
  for (let index = 0; index < data.length; index += 1) {
    if (!(data[index] >= isoValue)) continue;
    getCoords(index, point);
    const dx = point[0] - centroid[0], dy = point[1] - centroid[1], dz = point[2] - centroid[2];
    cxx += dx * dx; cyy += dy * dy; czz += dz * dz;
    cxy += dx * dy; cxz += dx * dz; cyz += dy * dz;
  }
  let axis = [0, 0, 1];
  for (let round = 0; round < 200; round += 1) {
    const next = [
      cxx * axis[0] + cxy * axis[1] + cxz * axis[2],
      cxy * axis[0] + cyy * axis[1] + cyz * axis[2],
      cxz * axis[0] + cyz * axis[1] + czz * axis[2],
    ];
    const length = Math.hypot(next[0], next[1], next[2]);
    if (!(length > 1e-9)) break;
    axis = [next[0] / length, next[1] / length, next[2] / length];
  }
  return { count, min: [...min], max: [...max], centroid, axis };
}

/** Cartesian point params for the radial theme's axis groups. */
export function pointParams(point) { return { x: point[0], y: point[1], z: point[2] }; }

/**
 * An index-space iso scan in Cartesian clothes.
 *
 * `measureIsoExtent` counts and boxes the thresholded voxels without knowing
 * what an Angstrom is; this carries that answer into the frame the room
 * placements are solved in. `center`/`radius` are Mol*'s own padded-box
 * isosurface sphere of the same contour (`Grid.getIsosurfaceBoundingSphere`,
 * the call the wireframe visual already trusts), so the radius the framing
 * uses and the corners it seats agree on what "the density" is. `corners`
 * are the padded box corners for the measured screen-space fit, and the axis
 * pair paints the radial key. `isoValue` is required — an undefined contour
 * meshes nothing, and this refuses to dress that as an extent.
 */
export function volumeIsoExtentOf(grid, scan, isoValue) {
  if (!grid || !scan || !Number.isFinite(isoValue)) return null;
  const toCartesian = Grid.getGridToCartesianTransform(grid);
  const cart = point => Array.from(Vec3.transformMat4(Vec3(),
    Vec3.create(point[0], point[1], point[2]), toCartesian));
  const corners = [];
  for (const ix of [scan.min[0] - 1, scan.max[0] + 1])
    for (const iy of [scan.min[1] - 1, scan.max[1] + 1])
      for (const iz of [scan.min[2] - 1, scan.max[2] + 1]) corners.push(cart([ix, iy, iz]));
  const axisPoint = cart(scan.centroid);
  const tip = cart(scan.centroid.map((value, axis) => value + scan.axis[axis]));
  const direction = tip.map((value, axis) => value - axisPoint[axis]);
  const length = Math.hypot(direction[0], direction[1], direction[2]);
  const sphere = Grid.getIsosurfaceBoundingSphere(grid, isoValue);
  return {
    center: Array.from(sphere.center), radius: sphere.radius, corners,
    axisPoint, axisDirection: length > 1e-9 ? direction.map(value => value / length) : [0, 0, 1],
    voxels: scan.count,
  };
}

/** Radius of a point about an axis, in whatever units all three share. */
export function radiusFromAxis(point, axisPoint, axisDirection) {
  const dx = point[0] - axisPoint[0], dy = point[1] - axisPoint[1], dz = point[2] - axisPoint[2];
  const length = Math.hypot(axisDirection[0], axisDirection[1], axisDirection[2]);
  if (!(length > 1e-9)) return Math.hypot(dx, dy, dz);
  const ux = axisDirection[0] / length, uy = axisDirection[1] / length, uz = axisDirection[2] / length;
  const along = dx * ux + dy * uy + dz * uz;
  return Math.hypot(dx - along * ux, dy - along * uy, dz - along * uz);
}

/**
 * Which side of the cutoff a radius falls on: `'wall'` at or under it,
 * `'crown'` outside it. The theme and this agree by construction — both
 * compare `radius <= cutoff` — so the buckets the proof reports are the
 * buckets the headset draws.
 */
export function crownBucket(radius, cutoff = VOLUME_CROWN_CUTOFF_ANGSTROM) {
  return radius <= cutoff ? 'wall' : 'crown';
}
