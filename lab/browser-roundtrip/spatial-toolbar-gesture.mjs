/**
 * Source-scoped WebXR select tracker. A control action needs a target-ray hit
 * at start, then select and release. Pinned IWER emits select immediately
 * before selectstart in one dispatch turn; an unclaimed select is therefore
 * retained only through that turn, never into a later controller press.
 *
 * The dispatch turn is the whole bound: the microtask expiry below drops an
 * unclaimed select before any later turn can see it. Runtimes hand the two
 * events of one press different `XRFrame` objects, so frame identity would
 * discard a legitimate reversed-order press without narrowing that bound.
 */
export function createSpatialToolbarGestureTracker({ onCapture = () => {}, onComplete = () => {} } = {}) {
  const gestures = new Map();

  function capture(source, phase, action) {
    try { onCapture({ inputSource: source, phase, action }); } catch { /* Input cleanup must continue. */ }
  }
  function expireOrphan(source, gesture) {
    queueMicrotask(() => {
      if (gestures.get(source) === gesture && !gesture.action) gestures.delete(source);
    });
  }
  function start(source, action) {
    if (!source || !action) return false;
    const gesture = gestures.get(source) ?? {};
    if (gesture.action) return false;
    gesture.action = action;
    gestures.set(source, gesture);
    capture(source, 'start', action);
    return true;
  }
  function select(source) {
    if (!source) return undefined;
    const gesture = gestures.get(source) ?? {};
    gesture.selected = true;
    gestures.set(source, gesture);
    if (!gesture.action) expireOrphan(source, gesture);
    return gesture.action;
  }
  function end(source) {
    const gesture = gestures.get(source);
    if (!gesture) return undefined;
    // Release always closes this physical press. Do not retain it for a late
    // select: selectend alone also represents a cancelled transient action.
    gestures.delete(source);
    if (!gesture.action) return undefined;
    capture(source, 'end', gesture.action);
    if (gesture.selected) {
      try { onComplete(gesture.action, source); } catch { /* Action errors stay outside input tracking. */ }
    }
    return gesture.action;
  }
  function cancel(source) {
    const gesture = gestures.get(source);
    gestures.delete(source);
    if (gesture?.action) capture(source, 'cancel', gesture.action);
  }
  function dispose() { for (const source of [...gestures.keys()]) cancel(source); }
  return Object.freeze({ start, select, end, cancel, dispose });
}

/**
 * Which controller the wearer is actually aiming with.
 *
 * A Quest 2 reports two controllers and both rays cross the panel, so taking
 * the first hit lets a resting hand pin the highlight to a row nobody is
 * pointing at. Rank rises with movement: the hand that moved most recently
 * outranks one held still, and a caller can raise a pressing source above
 * every other. Ranks are ordinal only; their absolute values mean nothing.
 */
export function createToolbarPointerTracker({ epsilon = 1e-4 } = {}) {
  const pointers = new Map();
  let clock = 0;

  function moved(previous, ray) {
    if (!previous) return true;
    for (let axis = 0; axis < 3; axis++) {
      if (Math.abs(previous.origin[axis] - ray.origin[axis]) > epsilon) return true;
      if (Math.abs(previous.direction[axis] - ray.direction[axis]) > epsilon) return true;
    }
    return false;
  }
  /** Record this frame's target ray for one source and return its rank. */
  function rank(source, ray) {
    if (!source || !Array.isArray(ray?.origin) || !Array.isArray(ray?.direction)) return 0;
    const pointer = pointers.get(source);
    if (moved(pointer?.ray, ray)) {
      pointers.set(source, { ray: { origin: [...ray.origin], direction: [...ray.direction] }, movedAt: ++clock });
      return clock;
    }
    return pointer.movedAt;
  }
  /** Drop every source the session no longer reports. */
  function retain(sources) {
    const live = new Set(sources ?? []);
    for (const source of [...pointers.keys()]) if (!live.has(source)) pointers.delete(source);
  }
  function forget(source) { pointers.delete(source); }
  function size() { return pointers.size; }
  return Object.freeze({ rank, retain, forget, size });
}
