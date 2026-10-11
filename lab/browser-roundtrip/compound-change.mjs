/**
 * One request's edits, applied as one operation.
 *
 * The host sends a compound change when the person asked for several things in
 * one breath — "make this RNA orange, fade the rest and enlarge it". The panel
 * has to treat that as one thing: the ops run in the order they were written,
 * inside one undo group so there is one thing to take back, and the scene is
 * captured once at the end so the wearer sees one picture rather than each
 * intermediate step being saved and confirmed.
 *
 * A failure part way through puts the panel back where the request found it.
 * Half of a compound is a picture nobody asked for and nothing can describe.
 *
 * This lives beside the state rather than inside the workspace so it can be
 * driven without a browser: the ordering, the single group and the rollback
 * are the parts that have to be right.
 */

/**
 * Six kinds, including visibility and the companion structure.
 *
 * The list is the panel's half of `compoundOpSchema` in the host's contract and
 * the two are pinned equal by a test: a kind the host can send and the panel
 * cannot run is a compound that fails half way through.
 */
export const COMPOUND_OP_KINDS = Object.freeze(['appearance', 'placement', 'selection', 'emphasis', 'visibility', 'styles', 'companion-structure']);

/** The ops of a compound change, checked for the shape the panel can run. */
export function compoundOps(change) {
  const ops = change?.patch?.ops;
  if (!Array.isArray(ops) || ops.length < 2) throw Error('A compound change carries at least two edits.');
  const kinds = new Set();
  for (const op of ops) {
    if (!op || !COMPOUND_OP_KINDS.includes(op.kind)) throw Error('This panel cannot run that kind of edit inside one change.');
    if (kinds.has(op.kind)) throw Error('A compound change carries each kind of edit at most once.');
    kinds.add(op.kind);
  }
  return ops;
}

/**
 * Run one compound change.
 *
 * @param change the compound change as it arrived.
 * @param handlers one function per op kind, each applying that single edit
 *   exactly as the panel applies it when it arrives on its own.
 * @param transaction `begin` opens the single undo group and `end` closes it;
 *   `rollback` puts the panel back if an op fails. A panel too old to group
 *   its undo entries may pass none, and then the change still renders once.
 */
export async function applyCompoundChange(change, handlers, transaction = {}) {
  const ops = compoundOps(change);
  for (const op of ops) {
    if (typeof handlers[op.kind] !== 'function') throw Error('This panel cannot run that kind of edit inside one change.');
  }
  const restore = transaction.begin ? transaction.begin() : undefined;
  const applied = [];
  try {
    for (const op of ops) { await handlers[op.kind](op.patch); applied.push(op.kind); }
  } catch (error) {
    if (transaction.rollback) await transaction.rollback(restore);
    throw error;
  } finally {
    if (transaction.end) transaction.end();
  }
  return applied;
}
