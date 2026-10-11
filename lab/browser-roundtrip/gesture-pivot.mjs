// Focus owns a gesture pivot only while the exact placement it framed remains
// current. A selection is deliberately absent from this policy: selecting a
// different residue does not move the point around which an existing view turns.
const vector = value => (Array.isArray(value) || ArrayBuffer.isView(value))
  && value.length === 3 && Array.from(value).every(Number.isFinite) ? Array.from(value) : undefined;
const pose = value => {
  const rotation = vector(value?.rotation), translation = vector(value?.translation);
  return rotation && translation && Number.isFinite(value?.scale) && value.scale > 0
    ? { rotation, translation, scale: value.scale } : undefined;
};
const samePose = (a, b) => Boolean(a && b && a.scale === b.scale
  && a.rotation.every((v, i) => v === b.rotation?.[i])
  && a.translation.every((v, i) => v === b.translation?.[i]));
const sameScope = (a, b) => a?.source === b?.source && a?.subject === b?.subject;

/** A source/visible-subject token is identity, not a label or selection string.
 * begin/read take { source, subject, placement, fallbackCenter }.
 * Only a successful framing calls rememberFocus with targetCenter. Only the
 * owning gesture's successful bake calls commit with its new placement.
 * Explicit source/restore/reset/framing cancellation calls invalidate. */
export function createGesturePivot() {
  let focus, active;
  function validate(context) {
    if (focus && (!sameScope(focus, context) || !samePose(focus.placement, context.placement))) focus = undefined;
    if (active && (!sameScope(active, context) || !samePose(active.placement, context.placement))) active = undefined;
  }
  return {
    rememberFocus({ source, subject, placement, targetCenter }) {
      active = undefined;
      const owned = pose(placement), center = vector(targetCenter);
      focus = source != null && owned && center ? { source, subject, placement: owned, center } : undefined;
      return Boolean(focus);
    },
    begin(context) {
      validate(context);
      if (!active) {
        const center = focus?.center ?? vector(context.fallbackCenter), owned = pose(context.placement);
        if (center && owned) active = { token: Symbol('gesture-pivot'), source: context.source, subject: context.subject,
          placement: owned, center: Array.from(center), focus };
      }
      return Array.from(active?.center ?? vector(context.fallbackCenter) ?? [0, 0, 0]);
    },
    read(context) {
      validate(context);
      return Array.from(active?.center ?? vector(context.fallbackCenter) ?? [0, 0, 0]);
    },
    ownership: () => active?.token,
    isCurrent(token, context) {
      validate(context);
      return token !== undefined && token === active?.token;
    },
    /** Call before clearing the transient and drawing the committed placement.
     * This is the sole allowed placement change that can retain focus ownership. */
    commit({ token, source, subject, previousPlacement, placement }) {
      // A late completion from an earlier gesture must not erase or promote a
      // newer focus, including a retarget at an identical saved placement.
      if (!active || token !== active.token) return false;
      const owned = pose(placement);
      const keepsFocus = Boolean(active?.focus && active.focus === focus && owned
        && sameScope(active, { source, subject }) && samePose(active.placement, previousPlacement));
      focus = keepsFocus ? { ...focus, placement: owned } : undefined;
      active = undefined;
      return keepsFocus;
    },
    release(token = active?.token) { if (token === active?.token) active = undefined; },
    invalidate() { active = undefined; focus = undefined; },
  };
}
