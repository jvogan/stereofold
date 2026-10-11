// A deliberate index-trigger stick gesture owns motion independently of the
// incidental wrist/hand movement needed to operate that stick. This module
// classifies intent only: raw poses and lifecycle guards stay in xr-manipulate.
export const TRIGGER_STICK_RECENTRE = .15;
export const TRIGGER_STICK_DOMINANCE = 2;

/** Lock the first deliberate direction until recentering. A balanced initial
 * diagonal remains a combined yaw/depth gesture; a small off-axis component
 * never turns a horizontal gesture into a gradual pull toward the wearer. */
export function createTriggerStickIntent({ isBlocked = () => false, gripHeld = () => false } = {}) {
  const hands = new Map();
  return {
    update(pointers = []) {
      const seen = new Set();
      for (const pointer of pointers) {
        const hand = pointer?.handedness;
        if (hand !== 'left' && hand !== 'right') continue;
        seen.add(hand);
        const grip = (pointer.buttons & 2) !== 0 || gripHeld(hand, pointer)
          || Number(pointer.source?.gamepad?.buttons?.[1]?.value) >= .7;
        if (!(pointer.buttons & 1) || grip || isBlocked(hand, pointer)) { hands.delete(hand); continue; }
        let state = hands.get(hand);
        if (!state || state.source !== pointer.source) state = { source: pointer.source, lane: undefined, settling: false };
        state.settling = false;
        const x = Number.isFinite(pointer.axes?.[2]) ? Math.abs(pointer.axes[2]) : 0;
        const y = Number.isFinite(pointer.axes?.[3]) ? Math.abs(pointer.axes[3]) : 0;
        if (Math.max(x, y) <= TRIGGER_STICK_RECENTRE) {
          // Consume the return-to-neutral frame as a raw-pose rebase. The next
          // neutral frame can carry only new measured hand/ray travel.
          state.settling = Boolean(state.lane);
          state.lane = undefined;
        } else if (!state.lane) {
          state.lane = x >= y * TRIGGER_STICK_DOMINANCE || y <= TRIGGER_STICK_RECENTRE ? 'yaw'
            : y >= x * TRIGGER_STICK_DOMINANCE || x <= TRIGGER_STICK_RECENTRE ? 'depth' : 'diagonal';
        }
        hands.set(hand, state);
      }
      for (const hand of hands.keys()) if (!seen.has(hand)) hands.delete(hand);
    },
    lane: hand => hands.get(hand)?.lane,
    suppressRayMotion: hand => Boolean(hands.get(hand)?.lane || hands.get(hand)?.settling),
    filter(hand, deflection) {
      const lane = hands.get(hand)?.lane;
      return lane === 'yaw' ? { ...deflection, y: 0 }
        : lane === 'depth' ? { ...deflection, x: 0 } : deflection;
    },
    reset() { hands.clear(); },
  };
}
