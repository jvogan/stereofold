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
  return {
    checkpoint(pose) { return { context: readContext(), pose: poseKey(pose), owner: hold.ownership() }; },
    accept(before, pose, take) {
      const ctx = readContext(), after = poseKey(pose);
      if (!ctx?.session || !sameContext(before?.context, ctx) || before.pose === after
        || before.owner.token !== hold.ownership().token) return false;
      // A fresh edit after undo discards the redo branch. Retain the owner
      // ancestry, so abandoned redo entries cannot evict still-live undo.
      const ancestors = new Set([before.owner.token]);
      let cursor = before.owner.token;
      for (let i = records.length - 1; i >= 0; i--) {
        if (records[i].next.token === cursor) { cursor = records[i].previous.token; ancestors.add(cursor); }
      }
      records = records.filter(entry => ancestors.has(entry.next.token));
      take();
      records.push({ context: ctx, before: before.pose, after, previous: before.owner, next: hold.ownership() });
      // Same capacity as both local and host undo. Intervening appearance edits
      // may make old records unnecessary, but never evict a still-undoable pose.
      if (records.length > capacity) records.shift();
      return true;
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
