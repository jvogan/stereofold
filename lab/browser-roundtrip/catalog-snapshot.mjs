import { yieldBrowserTask } from './browser-task-yield.mjs';
// Only snapshots owned by this module can bypass a defensive copy. Being
// shallow-frozen (or carrying a property with a familiar name) is not enough.
const snapshots = new WeakSet();

function* freezeSteps(value) {
  const pending = [value], visited = new WeakSet();
  let checked = 0;
  while (pending.length) {
    const object = pending.pop();
    if (!object || typeof object !== 'object' || visited.has(object)) continue;
    visited.add(object);
    for (const child of Object.values(object)) pending.push(child);
    Object.freeze(object);
    if (++checked % 128 === 0) yield;
  }
}

/** For freshly decoded, verified JSON with no external mutable owner only. */
export function freezeOwnedSelectionCatalog(catalog) {
  if (snapshots.has(catalog)) return catalog;
  for (const _ of freezeSteps(catalog)) { /* finish before publishing */ }
  if (catalog && typeof catalog === 'object') snapshots.add(catalog);
  return catalog;
}

/** Keep rendering while sealing a large privately decoded wire catalog. */
export async function freezeOwnedSelectionCatalogAsync(catalog, {
  check = () => {}, now = () => performance.now(), budgetMs = 4,
  yieldTask = yieldBrowserTask,
} = {}) {
  check();
  if (snapshots.has(catalog)) return catalog;
  let started = now();
  for (const _ of freezeSteps(catalog)) {
    if (now() - started < budgetMs) continue;
    await yieldTask();
    check();
    started = now();
  }
  check();
  if (catalog && typeof catalog === 'object') snapshots.add(catalog);
  return catalog;
}

export function snapshotSelectionCatalog(input) {
  if (snapshots.has(input)) return input;
  let catalog;
  try { catalog = structuredClone(input); }
  catch { throw new Error('The identity catalog cannot be copied as structured data.'); }
  return freezeOwnedSelectionCatalog(catalog);
}
