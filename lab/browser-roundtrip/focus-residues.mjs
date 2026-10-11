/** Keep sequence gaps selected, but frame only residues with modelled atoms. */
export function focusResidues(rows, keys) {
  const modelled = new Set(rows.filter(row => row.coordinateState === 'resolved' && row.atomSites.length)
    .map(row => row.key));
  const modelledKeys = keys.filter(key => modelled.has(key));
  return { modelledKeys, missingCoordinateCount: keys.length - modelledKeys.length };
}
