/** Model-space bounds of immutable Mol* loci. A selection adapter is tied to
 * one represented structure and returns stable loci for unchanged keys.
 * Replacing either produces a new cache key; placement transforms never do.
 * Weak keys let retired structures and selections be collected. */
export function createSelectionBoundsCache(measure) {
  const bounds = new WeakMap();
  return loci => {
    if (!bounds.has(loci)) bounds.set(loci, measure(loci));
    return bounds.get(loci);
  };
}
