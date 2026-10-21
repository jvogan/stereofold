import { hiddenRowKeys } from './inspection-visibility.mjs';

function stageAdmits(visible) {
  const entities = visible?.entityIds ? new Set(visible.entityIds) : undefined;
  const chains = visible?.labelChains ? new Set(visible.labelChains) : undefined;
  const operators = visible?.operatorIds ? new Set(visible.operatorIds) : undefined;
  return row => {
    const identity = row?.identity;
    if (!identity || (entities && !entities.has(String(identity.entityId))) || (chains && !chains.has(String(identity.labelChain)))) return false;
    const ids = Array.isArray(identity.operatorIds) ? identity.operatorIds.map(String) : [];
    return !operators || ids.some(id => operators.has(id));
  };
}

function measureRows(rows, admits = () => true) {
  const minimum = [Infinity, Infinity, Infinity], maximum = [-Infinity, -Infinity, -Infinity];
  for (const row of rows) {
    if (!admits(row)) continue;
    for (const atom of row?.atomSites ?? []) {
      const point = atom?.assemblyCoordinatesAngstrom;
      if (!Array.isArray(point) || point.length !== 3 || !point.every(Number.isFinite)) continue;
      for (let axis = 0; axis < 3; axis++) { minimum[axis] = Math.min(minimum[axis], point[axis]); maximum[axis] = Math.max(maximum[axis], point[axis]); }
    }
  }
  if (!minimum.every(Number.isFinite) || !maximum.every(Number.isFinite)) return undefined;
  const center = minimum.map((value, axis) => (value + maximum[axis]) / 2);
  let radius = 0;
  for (let axis = 0; axis < 3; axis++) radius += (maximum[axis] - center[axis]) ** 2;
  return { center, radius: Math.sqrt(radius), extent: maximum.map((value, axis) => value - minimum[axis]) };
}

const stageKey = visible => JSON.stringify([visible.entityIds || null, visible.labelChains || null, visible.operatorIds || null]);

/** Bounds in assembly coordinates, independent of placement, selection and
 * paint. Parsed source coordinates stay immutable for the life of a catalog;
 * source replacement supplies a new catalog. Keep only its most recent stage
 * and use weak keys so retired source coordinates are not retained. */
export function createVisibleStageBoundsCache() {
  const cache = new WeakMap();
  return (catalog, visible) => {
    if (!visible || !Array.isArray(catalog?.rows)) return undefined;
    // Compare filter values, including in-place edits and newly cloned scene
    // settings. Missing filters and empty filters deliberately differ.
    const key = stageKey(visible);
    let entry = cache.get(catalog);
    if (!entry || entry.rows !== catalog.rows || entry.key !== key) {
      entry = { rows: catalog.rows, key, bounds: measureRows(catalog.rows, stageAdmits(visible)) };
      cache.set(catalog, entry);
    }
    const bounds = entry.bounds;
    // Keep the caller's previous ownership contract: camera/placement code can
    // edit its result without changing the next frame's molecular pivot.
    return bounds ? { center: [...bounds.center], radius: bounds.radius, extent: [...bounds.extent] } : undefined;
  };
}

/**
 * What is drawn now, as rows and their box in assembly Angstroms: the stage's
 * subset less the rows the saved hidden set takes off the screen, so "hide
 * chain B" and "show only the selection" both count. A headset turn holds this
 * box's centre still. Turning about the whole stage instead swings the chain
 * that is left around an empty point where the hidden chain used to be.
 *
 * Rows are scanned once per change of rows, stage, hidden set, styles, opacity
 * or the static animation mask; under show-only-selection, selection too.
 * Every steady tick reads the same entry. Changes replace `styles`,
 * `visibility`, `hiddenKeys` and `selectionKeys`, so identity is the key; a stage may be edited in place, so it
 * is compared by value as above. Undefined when nothing has a coordinate.
 */
export function createDrawnSubsetCache() {
  let entry;
  return ({ rows, visible, visibility, selectionKeys = [], styles, opacity = 1, hiddenKeys }) => {
    if (!Array.isArray(rows)) return undefined;
    const only = visibility?.showOnlySelection ? selectionKeys : undefined;
    const stage = visible ? stageKey(visible) : null;
    if (!entry || entry.rows !== rows || entry.visibility !== visibility || entry.only !== only || entry.stage !== stage || entry.styles !== styles || entry.opacity !== opacity || entry.hiddenKeys !== hiddenKeys) {
      const hidden = new Set(hiddenRowKeys(rows, visibility, selectionKeys));
      for (const key of hiddenKeys ?? []) hidden.add(key);
      const admits = visible ? stageAdmits(visible) : () => true;
      const styled = new Map();
      for (const style of styles ?? []) for (const key of style.selectionKeys)
        styled.set(key, (styled.get(key) ?? false) || (style.opacity ?? opacity) > 0);
      const drawn = rows.filter(row => admits(row) && !hidden.has(row.key) && (styled.get(row.key) ?? (opacity > 0)));
      entry = { rows, visibility, only, stage, styles, opacity, hiddenKeys, keys: Object.freeze(drawn.map(row => row.key)), bounds: measureRows(drawn) };
    }
    return entry.bounds && { keys: entry.keys, center: [...entry.bounds.center], radius: entry.bounds.radius };
  };
}
