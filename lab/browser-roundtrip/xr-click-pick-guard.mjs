import { XR_TRIGGER_BUTTON } from './xr-manipulate.mjs';

const guards = new WeakMap();

/** Skip only consumed controller release clicks, before Canvas3D identifies
 * their ray. The viewer supplies its existing hand/modifier consumption rule.
 * Other clicks, hover and direct ray identification keep Mol*'s own path. */
export function attachXrConsumedTriggerClickGuard({ manager, isPresenting = () => false,
  consumesClick = () => false } = {}) {
  const helper = manager?.interactionHelper;
  if (typeof helper?.handleClick !== 'function') return { applied: false, restore() {} };
  let entry = guards.get(helper);
  if (!entry) {
    const original = helper.handleClick, owners = new Set();
    function handleClick(...args) {
      if (this === helper && this.button === XR_TRIGGER_BUTTON && this.ray) {
        for (const owner of owners) {
          try { if (owner.isPresenting() && owner.consumesClick()) return; }
          catch { /* An unavailable guard keeps the original picking path. */ }
        }
      }
      return original.apply(this, args);
    }
    entry = { original, owners, handleClick };
    helper.handleClick = handleClick;
    guards.set(helper, entry);
  }
  const owner = { isPresenting, consumesClick };
  entry.owners.add(owner);
  let restored = false;
  return {
    applied: true,
    restore() {
      if (restored) return;
      restored = true;
      entry.owners.delete(owner);
      if (entry.owners.size) return;
      // Do not overwrite a newer wrapper. If it retained ours, the empty
      // owner set makes that retained wrapper delegate without suppressing.
      if (helper.handleClick === entry.handleClick) helper.handleClick = entry.original;
      guards.delete(helper);
    },
  };
}
