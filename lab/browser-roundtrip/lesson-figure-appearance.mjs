/** A wearer-wide style is separate from the lesson's authored per-part styles.
 * Keeping the original graph makes undo, handoff and resuming a chapter lossless. */
export const FIGURE_REPRESENTATIONS = Object.freeze(['cartoon', 'ball-and-stick', 'spacefill', 'molecular-surface']);

export function withFigureRepresentation(figure, representation) {
  if (!FIGURE_REPRESENTATIONS.includes(representation)) throw Error('Unsupported molecular figure representation.');
  return figure ? { ...structuredClone(figure), representationOverride: representation } : undefined;
}

const targetKey = target => JSON.stringify([target.chain, target.residues?.from, target.residues?.to,
  target.componentId, target.atomName]);

export function figureRepresentationLayers(figure) {
  if (!figure.representationOverride) return figure.layers;
  if (!FIGURE_REPRESENTATIONS.includes(figure.representationOverride)) throw Error('Unsupported molecular figure representation.');
  // An authored cartoon plus translucent envelope of exactly the same atoms
  // becomes one part in a global style. The substantive, most opaque layer
  // owns its part colour and local colour overrides; duplicate spheres/surfaces
  // would hide that colour and spend the device budget twice.
  const parts = new Map();
  for (const layer of figure.layers) {
    const key = targetKey(layer.target), previous = parts.get(key);
    if (!previous || (previous.context && !layer.context)
      || Boolean(previous.context) === Boolean(layer.context) && layer.opacity > previous.opacity) parts.set(key, layer);
  }
  return [...parts.values()].map(layer => {
    const { sizeFactor, ...part } = layer;
    return { ...part, representation: figure.representationOverride,
      // A stick-specific radius must not shrink a spacefill atom or a surface.
      ...(layer.representation === figure.representationOverride && sizeFactor != null ? { sizeFactor } : {}) };
  });
}

export function figureLayerRepresentation(layer, structure) {
  // Ribbons have no geometry on a ligand or a non-polymer local selection.
  // Keep that scientifically relevant part visible as atoms alongside ribbons.
  return layer.representation === 'cartoon' && (!structure.polymerResidueCount || layer.target.atomName)
    ? 'ball-and-stick' : layer.representation;
}
