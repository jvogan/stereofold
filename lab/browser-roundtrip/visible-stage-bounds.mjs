function measureVisibleBounds(catalog, visible) {
  const entities = visible.entityIds ? new Set(visible.entityIds) : undefined;
  const chains = visible.labelChains ? new Set(visible.labelChains) : undefined;
  const operators = visible.operatorIds ? new Set(visible.operatorIds) : undefined;
  const minimum = [Infinity, Infinity, Infinity], maximum = [-Infinity, -Infinity, -Infinity];
  for (const row of catalog.rows) {
    const identity = row?.identity;
    if (!identity || (entities && !entities.has(String(identity.entityId))) || (chains && !chains.has(String(identity.labelChain)))) continue;
    const ids = Array.isArray(identity.operatorIds) ? identity.operatorIds.map(String) : [];
    if (operators && !ids.some(id => operators.has(id))) continue;
    for (const atom of row.atomSites ?? []) {
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
    const key = JSON.stringify([visible.entityIds || null, visible.labelChains || null, visible.operatorIds || null]);
    let entry = cache.get(catalog);
    if (!entry || entry.rows !== catalog.rows || entry.key !== key) {
      entry = { rows: catalog.rows, key, bounds: measureVisibleBounds(catalog, visible) };
      cache.set(catalog, entry);
    }
    const bounds = entry.bounds;
    // Keep the caller's previous ownership contract: camera/placement code can
    // edit its result without changing the next frame's molecular pivot.
    return bounds ? { center: [...bounds.center], radius: bounds.radius, extent: [...bounds.extent] } : undefined;
  };
}
