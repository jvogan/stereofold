import { INSPECTION_HISTORY_CAPACITY } from './inspection-state.mjs';

/** Page-local placement ownership follows rendered history, never saved science.
 * A later hand takeover has a different owner token even at the same pose.
 * Source/session changes invalidate these records without releasing that hand.
 */
export function createAgentPlacementHistory({ hold, context, capacity = INSPECTION_HISTORY_CAPACITY }) {
  let records = [], currentContext;
  const poseKey = pose => JSON.stringify([pose.scale, pose.translation, pose.rotation]);
  const sameContext = (a, b) => a?.session === b?.session && a?.source === b?.source;
  const readContext = () => {
    const value = context();
    if (!sameContext(value, currentContext)) records = [];
    currentContext = value; return value;
  };
  // A fresh edit after undo discards the redo branch. Retain the owner
  // ancestry, so abandoned redo entries cannot evict still-live undo.
  // An edit that lands exactly where an unbroken run of its own ancestor
  // edits started puts the molecule back, and gives ownership back with
  // it, as an undo to that pose would: "move it, then put it back" leaves
  // the structure the next chapter's to frame. A hand in between starts an
  // owner with no ancestors here, and anything else that moved the
  // molecule in between (a chapter framing it) breaks the run, so neither
  // is ever handed back this way.
  const lineage = (before, after) => {
    const ancestors = new Set([before.owner.token]);
    let cursor = before.owner.token, at = before.pose, returned;
    for (let i = records.length - 1; i >= 0; i--) {
      const entry = records[i];
      if (entry.next.token !== cursor) continue;
      if (at !== undefined && entry.after === at) {
        at = entry.before;
        if (!returned && at === after) returned = entry;
      } else at = undefined;
      cursor = entry.previous.token; ancestors.add(cursor);
    }
    return { ancestors, returned };
  };
  const admissible = (before, ctx, after) => ctx?.session && sameContext(before?.context, ctx) && before.pose !== after
    && before.owner.token === hold.ownership().token;
  return {
    checkpoint(pose) { return { context: readContext(), pose: poseKey(pose), owner: hold.ownership() }; },
    /**
     * Whether an agent edit to `pose` would put the molecule back where the
     * chapter left it: the end of an unbroken run of agent moves, handing the
     * placement back to nobody. Changes nothing: a changed source or session
     * answers false here and leaves the records for the next edit to drop.
     */
    returnsToChapterSeat(before, pose) {
      const ctx = context(), after = poseKey(pose);
      if (!sameContext(ctx, currentContext) || !admissible(before, ctx, after)) return false;
      const { returned } = lineage(before, after);
      return Boolean(returned) && returned.previous.held === false;
    },
    accept(before, pose, take) {
      const ctx = readContext(), after = poseKey(pose);
      if (!admissible(before, ctx, after)) return false;
      const { ancestors, returned } = lineage(before, after);
      records = records.filter(entry => ancestors.has(entry.next.token));
      // That pose's owner comes back under a new token, so the finished
      // excursion never becomes an ancestor of itself.
      if (returned) hold.restoreOwnership(returned.previous, { renew: true });
      else take();
      records.push({ context: ctx, before: before.pose, after, previous: before.owner, next: hold.ownership() });
      // Same capacity as both local and host undo. Intervening appearance edits
      // may make old records unnecessary, but never evict a still-undoable pose.
      if (records.length > capacity) records.shift();
      return returned ? 'returned' : true;
    },
    replay(before, pose) {
      const ctx = readContext(), after = poseKey(pose), owner = hold.ownership();
      if (!ctx?.session || !sameContext(before?.context, ctx) || before.owner.token !== owner.token || before.pose === after) return false;
      // An authored chapter may frame between undo and redo without taking
      // ownership. The exact replay target and owner still identify that edit.
      for (let i = records.length - 1; i >= 0; i--) {
        const entry = records[i];
        if (!sameContext(entry.context, ctx)) continue;
        if (after === entry.before && owner.token === entry.next.token) {
          hold.restoreOwnership(entry.previous); return true;
        }
        if (after === entry.after && owner.token === entry.previous.token) {
          hold.restoreOwnership(entry.next); return true;
        }
      }
      return false;
    },
  };
}
