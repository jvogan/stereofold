/** Detached residue metadata for selection/visibility; atom coordinates are
 * deliberately not copied. The canonical catalog remains owned by the viewer. */
export function residueIdentityRows(rows) {
  return rows.map(({ key, identity, coordinateState, entityType }) => ({
    key, identity: structuredClone(identity), coordinateState,
    ...(entityType === undefined ? {} : { entityType }),
  }));
}
