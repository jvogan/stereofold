// Controls held while system UI owns input must return to rest before the
// application can interpret another gesture. This also drains release picks.
export function createXrInputReleaseGate({ now = () => performance.now() } = {}) {
  const waiting = new Set(), releasedUntil = new Map();
  return {
    suspend(sources = []) {
      for (const source of sources) if (['left', 'right'].includes(source.handedness)) waiting.add(source.handedness);
    },
    filter(pointers = [], sources) {
      // A missing sample is not a release. Only a confirmed source removal
      // or a neutral reading may clear the gate.
      if (sources) {
        const connected = new Set(Array.from(sources, source => source.handedness));
        for (const hand of waiting) if (!connected.has(hand)) waiting.delete(hand);
      }
      return pointers.filter(pointer => {
        const hand = pointer.handedness;
        if (!waiting.has(hand)) return true;
        const analogHeld = Array.from(pointer.source?.gamepad?.buttons ?? []).some(button => button.pressed || button.value > .35);
        if (pointer.buttons || analogHeld || Math.hypot(pointer.axes?.[2] || 0, pointer.axes?.[3] || 0) > .15) return false;
        waiting.delete(hand); releasedUntil.set(hand, now() + 250);
        return true;
      });
    },
    blocksPick(hand) {
      const blocked = name => waiting.has(name) || now() <= (releasedUntil.get(name) ?? -Infinity);
      return hand ? blocked(hand) : ['left', 'right'].some(blocked);
    },
    reset() { waiting.clear(); releasedUntil.clear(); },
  };
}

// A placement saved across system UI retains a bounded visible-frame budget.
// Session end cancels its continuations without undoing the visible placement.
export function createXrPlacementLifecycle() {
  let blind = false, ended = false;
  const abort = new AbortController();
  const listeners = new Set();
  const notify = () => { for (const listener of [...listeners]) listener(); };
  return {
    get blind() { return blind; },
    get ended() { return ended; },
    signal: abort.signal,
    setBlind(value) { blind = value; notify(); },
    end() { ended = true; abort.abort(); notify(); listeners.clear(); },
    check() {
      if (ended) throw Object.assign(new Error('The input session ended before placement confirmation.'), { code: 'xr_input_ended' });
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}
