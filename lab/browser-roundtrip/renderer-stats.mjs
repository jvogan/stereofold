const GEOMETRY_TYPES = new Set(['mesh', 'texture-mesh', 'spheres', 'cylinders', 'points', 'lines', 'text', 'image', 'direct-volume']);
const REPRESENTATIONS = new Set(['cartoon', 'backbone', 'ball-and-stick', 'spacefill', 'molecular-surface', 'gaussian-surface',
  'label', 'line', 'point', 'putty', 'orientation', 'carbohydrate', 'isosurface']);
const QUALITIES = new Set(['auto', 'custom', 'lowest', 'lower', 'low', 'medium', 'high', 'higher', 'highest']);
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const value = (object, key) => object.values?.[key]?.ref?.value;
const named = (allowed, name) => allowed.has(name) ? name : 'other';

function roleForCell(cell, cells) {
  // Mol*'s representation builder keeps auxiliary tags on its component.
  // A decorator can share the same representation, so inspect ancestry too.
  for (let depth = 0; cell && depth < 16; depth++) {
    const tags = cell.transform?.tags;
    const has = tag => Array.isArray(tags) ? tags.includes(tag) : tags === tag;
    if (has('stereofold-molecular-animation')) return 'animation';
    if (has('stereofold-lesson-figure')) return 'figure';
    if (has('stereofold-scoped-style')) return 'style';
    cell = cells?.get?.(cell.transform?.parent);
  }
  return 'other';
}

/** On-demand inventory, never a frame-loop operation. Only allowlisted scalar
 * renderer facts leave the viewer: no labels, atom data, transforms or URLs.
 * Visibility is eligibility, not evidence that culling submitted a GPU draw. */
export function captureRendererStats(plugin) {
  const canvas = plugin?.canvas3d;
  if (!canvas?.getRenderObjects) return { available: false };
  const objects = canvas.getRenderObjects(), owners = new Map(), representations = new Map();
  const cells = plugin.state?.data?.cells;
  const maxCells = 4096, maxObjects = 2048, maxRows = 256;
  let cellsRead = 0;
  for (const cell of cells?.values?.() ?? []) {
    if (++cellsRead > maxCells) break;
    const repr = cell.obj?.data?.repr;
    if (!repr) continue;
    const type = cell.params?.values?.type;
    const typed = typeof type?.name === 'string', previous = representations.get(repr);
    // Paint/decorator cells reuse their parent's repr. Keep the geometry cell's
    // type and quality instead of replacing them with a modifier's parameters.
    if (previous && (previous.typed || !typed)) continue;
    const owner = { index: previous?.owner.index ?? representations.size, role: roleForCell(cell, cells),
      type: named(REPRESENTATIONS, type?.name), quality: named(QUALITIES, type?.params?.quality),
      visible: repr.state?.visible === true, hidden: cell.state?.isHidden === true,
      geometryVersion: number(repr.geometryVersion) };
    representations.set(repr, { owner, typed });
  }
  for (const [repr, { owner }] of representations) {
    for (const object of (repr.renderObjects ?? []).slice(0, maxObjects)) owners.set(object, owner);
  }
  const rows = [], byType = {}, byRole = {};
  let visibleObjects = 0, transparentObjects = 0, fullyMaskedObjects = 0, drawElements = 0;
  for (const [index, object] of objects.slice(0, maxObjects).entries()) {
    const type = named(GEOMETRY_TYPES, object.type), owner = owners.get(object);
    const visible = object.state?.visible === true && object.state?.disposed !== true;
    const drawCount = number(value(object, 'drawCount')), instances = number(value(object, 'instanceCount'));
    const alpha = number(value(object, 'alpha')), alphaFactor = number(object.state?.alphaFactor);
    const transparencyAverage = number(value(object, 'transparencyAverage'));
    const fullyMasked = alpha === 0 || alphaFactor === 0
      || (value(object, 'dTransparency') === true && transparencyAverage === 1 && value(object, 'uTransparencyStrength') === 1);
    byType[type] = (byType[type] ?? 0) + 1;
    const role = owner?.role ?? 'unowned'; byRole[role] = (byRole[role] ?? 0) + 1;
    if (visible) {
      visibleObjects++;
      if (value(object, 'dTransparency') === true || (alpha !== null && alpha < 1) || (alphaFactor !== null && alphaFactor < 1)) transparentObjects++;
      if (fullyMasked) fullyMaskedObjects++;
      drawElements += Math.max(0, drawCount ?? 0) * Math.max(0, instances ?? 0);
    }
    if (index < maxRows) rows.push({ index, type, visible, disposed: object.state?.disposed === true,
      drawCount, instances, vertexCount: number(value(object, 'uVertexCount')),
      alpha, alphaFactor, transparency: value(object, 'dTransparency') === true, transparencyAverage,
      transparencyType: ['instance', 'groupInstance'].includes(value(object, 'dTransparencyType')) ? value(object, 'dTransparencyType') : 'other',
      markerAverage: number(value(object, 'markerAverage')), fullyMasked,
      ...(owner ? { owner } : {}) });
  }
  return { available: true, scope: 'renderer inventory; visibility is not a measured GPU submission',
    objectCount: objects.length, representationCount: number(canvas.reprCount?.value),
    inspectedObjects: Math.min(objects.length, maxObjects), inspectedRepresentations: representations.size,
    truncated: objects.length > maxRows || cellsRead > maxCells,
    visibleObjects, transparentObjects, fullyMaskedObjects, drawElements, byType, byRole, objects: rows };
}
