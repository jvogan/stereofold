// Import-free direct-manipulation maths and gesture state for the headset.
// Keep this module runnable in Node so the gesture rules can be checked
// without loading Mol* or a WebXR runtime.
//
// Trigger taps select residues. Holding a pointed molecule carries it with
// the ray; either grip gives precise translation and rotation. Both grips
// scale by measured hand separation. Trigger + stick changes depth/yaw;
// grip + stick resizes, including when controller positions are emulated.
// A grab updates transient placement each frame and saves once on release.
// Menu ownership wins at press start; molecule movement leaves room UI fixed.

/** `ButtonsType.Flag.Trigger` in `mol-util/input/input-observer.js`. */
export const XR_TRIGGER_BUTTON = 32;
/** `ButtonsType.Flag.Primary`, which a tracked pointer sets for the trigger. */
export const POINTER_TRIGGER = 1;
/** `ButtonsType.Flag.Secondary`, which a tracked pointer sets for the grip. */
export const POINTER_GRIP = 2;

/** Separate engage/release thresholds keep a relaxed grip held without chatter. */
export const GRIP_ENGAGE = 0.7, GRIP_RELEASE = 0.35;

/** Maximum logarithmic size rate under either one-controller grab. */
export const ONE_HAND_SCALE_PER_SECOND = 2;
/** Low stick deflection stays gentle; full deflection changes size by 7.4x/s. */
export const ONE_HAND_SCALE_FINE_RATE = 0.45;
export const TRIGGER_HOLD_MS = 220;
/** Drag intent is measured at the controller, before target-distance gains. */
export const TRIGGER_MOVE_METRES = 0.015;
export const TRIGGER_AIM_RADIANS = Math.PI / 180;
export const TRIGGER_TRANSLATION_GAIN = 2.5;
/** Half a metre of axial hand travel covers the initial target distance. */
export const TRIGGER_PULL_DISTANCE_METRES = 0.5;
export const TRIGGER_TRACKING_GRACE_MS = 250;
/** A live controller may briefly leave the cameras while its grip stays held. */
export const GRIP_TRACKING_GRACE_MS = 1500;
/** One hand reaches through depth while lateral placement remains precise. */
export const GRIP_DEPTH_GAIN = 2.5;
export const TRIGGER_PICK_GUARD_MS = 250;
/** A suspended frame loop must not integrate pre-dialog poses on return. */
export const MANIPULATION_FRAME_GAP_MS = 500;

/**
 * One frame of one-hand scale as a multiplier.
 *
 * @param {number} y stick deflection, positive when pushed forward
 * @param {number} seconds this frame's elapsed time
 */
export function oneHandScaleFactor(y, seconds, rate = ONE_HAND_SCALE_PER_SECOND) {
  if (!Number.isFinite(y) || !Number.isFinite(seconds) || seconds <= 0 || y === 0) return 1;
  const push = Math.min(1, Math.abs(y));
  const speed = ONE_HAND_SCALE_FINE_RATE + (rate - ONE_HAND_SCALE_FINE_RATE) * push * push;
  return Math.exp(Math.sign(y) * push * speed * seconds);
}

/** Ray target depth through the molecule's bounding envelope, in ray units. */
export function moleculeGrabDistance(ray, sphere) {
  const origin = finiteTriple(ray?.origin), direction = normalize(ray?.direction);
  const center = finiteTriple(sphere?.center), radius = sphere?.radius;
  if (!origin || !direction || !center || !Number.isFinite(radius) || radius <= 0) return undefined;
  const offset = center.map((value, axis) => value - origin[axis]);
  const depth = offset.reduce((sum, value, axis) => sum + value * direction[axis], 0);
  const perpendicularSq = Math.max(0, offset.reduce((sum, value) => sum + value * value, 0) - depth * depth);
  if (perpendicularSq > radius * radius) return undefined;
  const exit = depth + Math.sqrt(radius * radius - perpendicularSq);
  if (exit <= 0) return undefined;
  // A controller inside an enlarged molecule can still grab its forward
  // envelope, even when the molecule's centre is behind the controller.
  return depth > 0 ? depth : exit;
}

/**
 * A trigger press keeps its initial target until release. A quick tap stays a
 * pick; a held trigger or deliberate hand/aim movement becomes a ray drag.
 * Coordinates are room metres; target reach does not change tap sensitivity.
 */
export function createTriggerDrag({ targetDistance = () => undefined, isClaimed = () => false, isRayOnMenu = () => false,
  suppressMotion = () => false,
  now = () => (globalThis.performance?.now?.() ?? Date.now()) } = {}) {
  const presses = new Map(), released = new Map();
  return {
    read(hand, pointer, grip = false) {
      const at = now(), down = ((pointer?.buttons | 0) & POINTER_TRIGGER) !== 0;
      let press = presses.get(hand);
      let created = false;
      if (!down) {
        if (press?.phase === 'drag' || press?.consumed) released.set(hand, at);
        presses.delete(hand);
        return undefined;
      }
      const origin = finiteTriple(pointer?.ray?.origin), direction = normalize(pointer?.ray?.direction);
      if (!press) {
        released.delete(hand); // A new tap has its own selection intent.
        const depth = !grip && !isClaimed(hand) && !isRayOnMenu(hand) ? targetDistance(pointer) : undefined;
        const anchor = Number.isFinite(depth) && depth > 0 && origin && direction
          ? origin.map((value, axis) => value + direction[axis] * depth) : undefined;
        const quality = positionQuality(pointer);
        press = { phase: anchor ? 'pending' : 'blocked', at, depth, anchor, intentOrigin: origin, intentDirection: direction,
          origin, direction, positionQuality: quality, pullGain: Math.max(TRIGGER_TRANSLATION_GAIN, depth / TRIGGER_PULL_DISTANCE_METRES) };
        presses.set(hand, press);
        created = true;
      }
      // The toolbar's selectstart can claim a row after tracked pointers ran
      // in the same frame. Resolve that ownership before a pending tap drags.
      if (press.phase === 'pending' && isClaimed(hand)) press.phase = 'blocked';
      if (press.phase === 'blocked') return undefined;
      if (!origin || !direction) {
        press.origin = undefined; press.direction = undefined;
        return { phase: press.phase, anchor: undefined };
      }
      if (created) return { phase: press.phase, anchor: press.anchor };
      let rebased;
      const quality = positionQuality(pointer);
      const trackedPosition = canUsePosition(quality);
      if (press.positionQuality !== quality) rebased = 'tracking-mode';
      else if (press.origin && press.direction) {
        // Arm-model positions move when the wrist turns; they are not hand travel.
        const delta = trackedPosition ? origin.map((value, axis) => value - press.origin[axis]) : [0, 0, 0];
        // Test the measured hand travel, not the amplified target travel. A
        // normal fast pull or distant wrist sweep can move a target metres.
        if (Math.hypot(...delta) > MAX_FRAME_TRANSLATION) rebased = 'tracking-jump';
        else if (!suppressMotion(hand, pointer)) {
          const axial = delta.reduce((sum, value, axis) => sum + value * press.direction[axis], 0);
          const depth = press.depth + (press.pullGain - 1) * axial;
          press.anchor = press.anchor.map((value, axis) => value + delta[axis]
            + (delta[axis] - axial * press.direction[axis]) * (TRIGGER_TRANSLATION_GAIN - 1)
            + direction[axis] * depth - press.direction[axis] * press.depth);
          // No near wall: the wearer may pull through the controller's plane.
          // A shorter ray also makes wrist movement precise after pulling in.
          press.depth = depth;
        }
      }
      // A tracking discontinuity is not deliberate movement. Start measuring
      // intent again at the recovered pose, just as the ray anchor is rebased.
      if (rebased || !press.origin || !press.direction) {
        press.intentOrigin = origin; press.intentDirection = direction;
      }
      // Stick-owned motion still observes every genuine pose. Its eventual
      // return to ray dragging starts here, never at the pre-stick wrist pose.
      press.origin = origin; press.direction = direction; press.positionQuality = quality;
      const anchor = press.anchor;
      const stick = pointer?.axes;
      const deliberateStick = Math.hypot(stick?.[2] || 0, stick?.[3] || 0) > 0.2;
      // Measure intent before the ray's translation/pull gain. Otherwise a
      // sub-millimetre hand tremor can turn a tap into a grab of a distant target.
      const moved = (trackedPosition && press.intentOrigin
        && spanBetween(press.intentOrigin, origin) >= TRIGGER_MOVE_METRES)
        || (press.intentDirection && press.intentDirection.reduce((sum, value, axis) => sum + value * direction[axis], 0)
          <= Math.cos(TRIGGER_AIM_RADIANS));
      if (press.phase === 'pending' && (at - press.at >= TRIGGER_HOLD_MS || moved || deliberateStick)) press.phase = 'drag';
      if (press.phase === 'drag') released.set(hand, at);
      return { phase: press.phase, anchor, ...(rebased ? { rebased } : {}) };
    },
    offset(hand, translation) {
      const press = presses.get(hand), delta = finiteTriple(translation);
      if (press?.phase !== 'drag' || !delta || !press.anchor || !press.direction) return false;
      press.anchor = press.anchor.map((value, axis) => value + delta[axis]);
      press.depth += delta.reduce((sum, value, axis) => sum + value * press.direction[axis], 0);
      return true;
    },
    phase: hand => presses.get(hand)?.phase,
    owns: hand => ['pending', 'drag'].includes(presses.get(hand)?.phase),
    consumesPick: hand => hand ? presses.get(hand)?.phase === 'drag' || presses.get(hand)?.consumed === true || now() - (released.get(hand) ?? -Infinity) <= TRIGGER_PICK_GUARD_MS
      : [...presses.values()].some(press => press.phase === 'drag' || press.consumed) || [...released.values()].some(at => now() - at <= TRIGGER_PICK_GUARD_MS),
    cancel(hand) {
      if (presses.has(hand)) { presses.set(hand, { phase: 'blocked', consumed: true }); released.set(hand, now()); }
    },
    // Replacement is a different physical press. Same-source cancellation
    // keeps its release guard; retired-source intent cannot own the new one.
    forget(hand) { presses.delete(hand); released.delete(hand); },
    reset() { presses.clear(); released.clear(); },
  };
}

/**
 * The grip's own Schmitt trigger, one latch per hand.
 *
 * WebXR publishes the squeeze as an analog value on the gamepad's second
 * button. Mol*'s pointer bitmask has already thresholded it and thrown the
 * value away, so the latch reads the gamepad directly and keeps the bitmask as
 * the fallback for an input source that reports no gamepad — hand tracking, and
 * the IWER emulator's synthetic pointers.
 */
export function createGripLatch({ engage = GRIP_ENGAGE, release = GRIP_RELEASE } = {}) {
  const held = new Map();
  return {
    /**
     * @param {string} hand `'left'` or `'right'`
     * @param {object} pointer this frame's pointer, carrying `buttons` and `source`
     */
    read(hand, pointer) {
      const value = pointer?.source?.gamepad?.buttons?.[1]?.value;
      const was = held.get(hand) === true;
      const next = Number.isFinite(value)
        ? (was ? value >= release : value >= engage)
        : ((pointer?.buttons | 0) & POINTER_GRIP) !== 0;
      held.set(hand, next);
      return next;
    },
    /** Whether the latch currently holds this hand, without reading a pointer. */
    holds: hand => held.get(hand) === true,
    reset() { held.clear(); },
  };
}
/** Either controller grabs. The existing owner wins; simultaneous grips prefer right. */
export const MANIPULATION_HANDS = Object.freeze(['right', 'left']);

/**
 * What a one-hand grab turns about.
 *
 * `centroid` turns the structure about its own centre and moves that centre
 * with the hand. `hand` is the rigid attach used for handheld objects, which
 * turns the structure about the controller. That is written for an object held
 * in the hand; a structure filling eighty degrees of view two metres away is
 * not, and about the hand a half-degree wrist roll swings it through tens of
 * centimetres. Travel already gives the wearer direct manipulation, so the
 * pivot stays on the centre.
 */
export const GRAB_PIVOT = 'centroid';

/** Haptics, matching the toolbar's own short confirmation buzz. */
export const PICK_PULSE = Object.freeze({ intensity: 0.7, durationMs: 40 });
export const GRAB_PULSE = Object.freeze({ intensity: 0.25, durationMs: 20 });
/** The release buzz: longer and softer, so letting go is felt as an end. */
export const RELEASE_PULSE = Object.freeze({ intensity: 0.35, durationMs: 60 });

/** Degrees below which a frame's delta is tracking noise, not a turn. */
export const ROTATION_EPSILON = 1e-4;
/** Numerical floor for a direction vector and for two aims being the same. */
export const VECTOR_EPSILON = 1e-9;
/** Below this the hands did not really move apart or together. */
export const SCALE_EPSILON = 1e-3;
/** Below this a hand did not really travel; ray space is headset metres. */
export const TRANSLATION_EPSILON = 1e-4;
/** Bound a two-grip size delta to 25% in either direction per frame. */
export const MAX_FRAME_SCALE = 1.25;
/**
 * Maximum accepted translation in one frame, in room metres. Larger deltas
 * rebase the next frame so tracking recovery cannot teleport the molecule.
 */
export const MAX_FRAME_TRANSLATION = 0.5;

/** Why a held grip did not become a grab, for the headset log. */
export const GRAB_REJECTED = Object.freeze({
  claimed: 'hand-claimed',
  noRay: 'no-ray',
  notReady: 'viewer-not-ready',
  noSession: 'no-session',
  xrDisabled: 'xr-disabled',
});

const IDENTITY_4 = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** Whether a Mol* click event came from a mouse press or an XR trigger. */
export function isPickButton(button) {
  return button === POINTER_TRIGGER || button === XR_TRIGGER_BUTTON;
}

function finiteTriple(value) {
  return Array.isArray(value) && value.length >= 3 && value.slice(0, 3).every(Number.isFinite)
    ? [value[0], value[1], value[2]] : undefined;
}

// Native adapter snapshots distinguish unknown pose quality from older and
// natural-input pointer shapes that never published a quality field. Keep the
// latter compatible; an unknown native pose may aim and rotate, but cannot
// provide measured hand travel or spacing.
function positionQuality(pointer, grip = false) {
  const emulated = grip ? pointer?.gripPose?.emulatedPosition : pointer?.emulatedPosition;
  if (pointer?.poseQualitySource === 'webxr') {
    const reported = grip ? pointer.gripTracking : pointer.tracking;
    if (reported === 'tracked-position' || reported === 'emulated-position' || reported === 'unknown') return reported;
    return emulated === true ? 'emulated-position' : emulated === false ? 'tracked-position' : 'unknown';
  }
  return emulated === true ? 'emulated-position' : emulated === false ? 'tracked-position' : 'legacy-unknown';
}

function canUsePosition(quality) {
  return quality === 'tracked-position' || quality === 'legacy-unknown';
}

function savedPositionQuality(hand) {
  return hand?.positionQuality ?? (hand?.positionTracked === false ? 'emulated-position' : 'tracked-position');
}

function normalize(vector) {
  const triple = finiteTriple(vector);
  if (!triple) return undefined;
  const length = Math.hypot(triple[0], triple[1], triple[2]);
  if (!(length > VECTOR_EPSILON)) return undefined;
  return [triple[0] / length, triple[1] / length, triple[2] / length];
}

function normalizeQuaternion(value) {
  if (!Array.isArray(value) || value.length < 4 || !value.slice(0, 4).every(Number.isFinite)) return undefined;
  const length = Math.hypot(value[0], value[1], value[2], value[3]);
  if (!(length > VECTOR_EPSILON)) return undefined;
  return [value[0] / length, value[1] / length, value[2] / length, value[3] / length];
}

function multiplyQuaternion(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

/** The world-space turn from one full grip orientation to another. */
function rotationBetweenOrientations(from, to) {
  const previous = normalizeQuaternion(from), current = normalizeQuaternion(to);
  if (!previous || !current) return undefined;
  const delta = normalizeQuaternion(multiplyQuaternion(current, [-previous[0], -previous[1], -previous[2], previous[3]]));
  if (!delta) return undefined;
  const [x, y, z, w] = delta;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, yx = y * x2, yy = y * y2;
  const zx = z * x2, zy = z * y2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    1 - yy - zz, yx + wz, zx - wy, 0,
    yx - wz, 1 - xx - zz, zy + wx, 0,
    zx + wy, zy - wx, 1 - xx - yy, 0,
    0, 0, 0, 1,
  ];
}

/** The point halfway between two hands, or `undefined` when either is unusable. */
export function midpointBetween(a, b) {
  const first = finiteTriple(a), second = finiteTriple(b);
  if (!first || !second) return undefined;
  return [(first[0] + second[0]) / 2, (first[1] + second[1]) / 2, (first[2] + second[2]) / 2];
}

/**
 * The travel between two anchor points, or `undefined` below tracking noise.
 * Direct grips use the raw hand-travel bound; amplified ray anchors pass an
 * unbounded maximum after their measured controller travel has been checked.
 */
export function travelBetween(from, to, maximum = MAX_FRAME_TRANSLATION) {
  const first = finiteTriple(from), second = finiteTriple(to);
  if (!first || !second) return undefined;
  const delta = [second[0] - first[0], second[1] - first[1], second[2] - first[2]];
  const length = Math.hypot(delta[0], delta[1], delta[2]);
  if (!(length > TRANSLATION_EPSILON)) return undefined;
  if (length > maximum) return undefined;
  return delta;
}

/** Amplify measured travel along a fixed grab-start head-to-target axis.
 * Call only after checking the raw physical travel for tracking jumps.
 * A missing axis preserves direct movement rather than using wrist direction.
 */
export function gripDepthTranslation(delta, axis) {
  const travel = finiteTriple(delta), forward = normalize(axis);
  if (!travel || !forward) return travel;
  const axial = travel.reduce((sum, value, i) => sum + value * forward[i], 0);
  return travel.map((value, i) => value + forward[i] * axial * (GRIP_DEPTH_GAIN - 1));
}

/** Distance between two points, or `undefined` when either is unusable. */
export function spanBetween(a, b) {
  const first = finiteTriple(a), second = finiteTriple(b);
  if (!first || !second) return undefined;
  return Math.hypot(first[0] - second[0], first[1] - second[1], first[2] - second[2]);
}

/**
 * The shortest rotation carrying one direction onto another, column-major in
 * the layout Mol* `Mat4` uses.
 *
 * This is the trackball: the structure turns exactly as far as the controller's
 * aim turned, about the axis perpendicular to both, so the molecule follows the
 * hand rather than an accumulated screen delta. Roll is deliberately absent —
 * a ray has no roll — which is what keeps a grab from drifting when the wearer
 * rotates their wrist without moving their aim.
 *
 * @param {ArrayLike<number>} from previous aim direction
 * @param {ArrayLike<number>} to current aim direction
 * @returns {number[]} 16 numbers, column-major; identity when there is no turn
 */
export function rotationBetween(from, to) {
  const a = normalize(from), b = normalize(to);
  if (!a || !b) return [...IDENTITY_4];
  const dot = Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  const cross = [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const sine = Math.hypot(cross[0], cross[1], cross[2]);
  // The dead zone belongs to the gesture, not to this matrix: a controller
  // turning half a degree a frame is a real, slow grab, and rejecting it here
  // once cost every gentle turn in the headset.
  if (sine <= VECTOR_EPSILON && dot > 0) return [...IDENTITY_4];
  let axis = normalize(cross);
  // Exactly opposed directions have no unique axis. Any perpendicular one is
  // a correct half turn; take it from the smallest component of `a`.
  if (!axis) {
    const smallest = Math.abs(a[0]) <= Math.abs(a[1]) && Math.abs(a[0]) <= Math.abs(a[2]) ? [1, 0, 0]
      : Math.abs(a[1]) <= Math.abs(a[2]) ? [0, 1, 0] : [0, 0, 1];
    axis = normalize([
      a[1] * smallest[2] - a[2] * smallest[1],
      a[2] * smallest[0] - a[0] * smallest[2],
      a[0] * smallest[1] - a[1] * smallest[0],
    ]) ?? [1, 0, 0];
  }
  // atan2 keeps its precision at the small per-frame angles a hand actually
  // makes, where acos of a dot product near one does not.
  const angle = Math.atan2(sine, dot), s = Math.sin(angle), c = Math.cos(angle), t = 1 - c;
  const [x, y, z] = axis;
  return [
    c + x * x * t, y * x * t + z * s, z * x * t - y * s, 0,
    x * y * t - z * s, c + y * y * t, z * y * t + x * s, 0,
    x * z * t + y * s, y * z * t - x * s, c + z * z * t, 0,
    0, 0, 0, 1,
  ];
}

/** Column-major 4x4 product, `a · b`, in the layout above. */
export function multiplyMatrix4(a, b) {
  if (!a || a.length !== 16 || !b || b.length !== 16) return undefined;
  const out = new Array(16).fill(0);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) sum += a[k * 4 + row] * b[column * 4 + k];
      out[column * 4 + row] = sum;
    }
  }
  return out;
}

/** The turn in degrees a rotation matrix represents, for the diagnostic log. */
export function rotationDegrees(matrix) {
  if (!matrix || matrix.length !== 16) return 0;
  const trace = matrix[0] + matrix[5] + matrix[10];
  return Math.acos(Math.min(1, Math.max(-1, (trace - 1) / 2))) * 180 / Math.PI;
}

/** A fresh, idle gesture state. */
export function idleManipulation() {
  return { phase: 'idle', hand: undefined, direction: undefined, orientation: undefined, span: undefined, anchor: undefined };
}

/**
 * One frame of the gesture state machine.
 *
 * The rules follow the headset convention and the claims already in the
 * viewer. A hand the spatial toolbar has claimed is not a grab hand, so a press
 * on a menu plate can never start a grab.
 *
 * `state.hand` is the grip that owns the grab. It is set on the frame the first
 * grip is pressed and changes only when that grip is released while the other
 * is still down, which is what makes release order irrelevant: whichever hand
 * survives carries the structure on.
 *
 * Three frames change what the structure is pinned to rather than moving it:
 * the second grip joining (hand to midpoint), the second grip leaving (midpoint
 * to hand), and ownership passing to the surviving hand. Each returns a fresh
 * anchor with no translation, so the structure never jumps by the distance
 * between the old anchor and the new one.
 *
 * @param {{phase:string, hand?:string, direction?:number[], span?:number}} state previous state
 * @param {{right?:object, left?:object}} hands `{grip, claimed, origin, direction}` per hand
 * @returns {{state:object, rotation?:number[], scale?:number, started?:string, ended?:string, rebased?:string}}
 */
export function nextManipulation(state, hands = {}) {
  const previous = state ?? idleManipulation();
  const holding = MANIPULATION_HANDS.filter(name => Boolean(hands[name]?.grip) && !hands[name]?.claimed);

  if (!holding.length) {
    // A grip that is held but cannot grab is a real failure on hardware, so it
    // is named rather than silently dropped.
    const rejected = MANIPULATION_HANDS.some(name => hands[name]?.grip && hands[name]?.claimed)
      ? GRAB_REJECTED.claimed : undefined;
    if (previous.phase === 'idle') return { state: idleManipulation(), rejected };
    return { state: idleManipulation(), ended: previous.phase, rejected };
  }
  // The owning hand keeps the grab while its grip is down. `holding` is in
  // `MANIPULATION_HANDS` order, so two grips arriving together give the right.
  const owner = holding.includes(previous.hand) ? previous.hand : holding[0];
  const lead = hands[owner];
  const second = hands[holding.find(name => name !== owner)];
  const positionTracked = lead.positionTracked !== false;
  const positionQuality = savedPositionQuality(lead);
  const scaling = Boolean(second) && positionTracked && second.positionTracked !== false && lead.kind !== 'ray' && second.kind !== 'ray' && previous.phase !== 'idle';
  const kind = lead.kind ?? 'grip';
  // One grip pins the structure to that hand, so the molecule travels exactly
  // as far as the hand does. Two grips pin it to the point between them, which
  // keeps a pull-apart a pure size change rather than a size change that also
  // drags the structure toward one hand.
  const anchor = scaling ? midpointBetween(lead.origin, second.origin) ?? finiteTriple(lead.origin)
    : finiteTriple(lead.origin);
  const direction = finiteTriple(lead.direction);
  const orientation = normalizeQuaternion(lead.orientation);
  // A pose with no usable ray cannot say where the hand is or where it points.
  const rejected = anchor && direction ? undefined : GRAB_REJECTED.noRay;
  if (previous.phase === 'idle') {
    return { state: { phase: 'grab', hand: owner, direction, orientation, span: undefined, anchor, kind, positionTracked, positionQuality }, started: 'grab', rejected };
  }
  if (scaling && previous.phase === 'grab') {
    const span = spanBetween(lead.origin, second.origin);
    return { state: { phase: 'scale', hand: owner, direction, orientation, span, anchor, kind, positionTracked, positionQuality }, started: 'scale', rejected };
  }
  if (!scaling && previous.phase === 'scale') {
    return { state: { phase: 'grab', hand: owner, direction, orientation, span: undefined, anchor, kind, positionTracked, positionQuality }, ended: 'scale', rejected };
  }
  if (owner !== previous.hand || kind !== (previous.kind ?? 'grip') || positionQuality !== savedPositionQuality(previous)) {
    return { state: { phase: previous.phase, hand: owner, direction, orientation, span: previous.span, anchor, kind, positionTracked, positionQuality }, rebased: owner, rejected };
  }
  // The hand carries the structure in both phases. Rotation is read from the
  // pose orientation and translation from the pose position, so a wrist turn
  // never drags the molecule and a straight reach never spins it.
  // Ray drags already check raw controller travel before applying their
  // distance gain. Rejecting their output would silently discard fast pulls.
  const translation = kind === 'ray' || positionTracked
    ? travelBetween(previous.anchor, anchor, kind === 'ray' ? Infinity : MAX_FRAME_TRANSLATION) : undefined;
  if (previous.phase === 'scale') {
    const span = spanBetween(lead.origin, second.origin);
    // Re-aim the rotation baseline while scaling, so releasing the second grip
    // resumes the turn from where the hand is rather than snapping to it.
    const next = { phase: 'scale', hand: owner, direction, orientation, span: span ?? previous.span,
      anchor: anchor ?? previous.anchor, kind, positionTracked, positionQuality };
    if (!(span > 0) || !(previous.span > 0)) return { state: next, translation, rejected };
    const raw = span / previous.span;
    const factor = Math.min(MAX_FRAME_SCALE, Math.max(1 / MAX_FRAME_SCALE, raw));
    if (Math.abs(factor - 1) < SCALE_EPSILON) return { state: next, translation, rejected };
    return { state: next, scale: factor, translation, rejected };
  }
  const next = { phase: 'grab', hand: owner, direction: direction ?? previous.direction, orientation: orientation ?? previous.orientation,
    span: undefined, anchor: anchor ?? previous.anchor, kind, positionTracked, positionQuality };
  if (kind === 'ray' || !previous.direction || !direction) return { state: next, translation, rejected };
  const rotation = kind === 'grip' && previous.orientation && orientation
    ? rotationBetweenOrientations(previous.orientation, orientation)
    : rotationBetween(previous.direction, direction);
  if (!rotation) return { state: next, translation, rejected };
  if (rotationDegrees(rotation) < ROTATION_EPSILON) return { state: next, translation, rejected };
  return { state: next, rotation, translation, rejected };
}

/**
 * A short controller buzz. Quest Touch controllers expose one actuator; a
 * hand, a gaze pointer or an emulator exposes none, and each of those is a
 * silent no-op rather than an error.
 */
export function pulseController(source, { intensity, durationMs } = {}) {
  try {
    const actuator = source?.gamepad?.hapticActuators?.[0];
    if (typeof actuator?.pulse !== 'function') return false;
    const result = actuator.pulse(intensity, durationMs);
    if (typeof result?.catch === 'function') result.catch(() => {});
    return true;
  } catch { return false; }
}

/** Diagnostics never cost a gesture: a broken recorder hook must not throw. */
export function recordManipulation(kind, detail) {
  try { globalThis.__stereofoldDiagnostics?.record?.(kind, detail); }
  catch { /* The page may have no diagnostics hook installed. */ }
}

/**
 * The one in-headset caption line.
 *
 * The spatial toolbar owns it through `setStatus`, and only the immersive
 * session holds that toolbar. Push-to-talk is already handed the same writer,
 * so it registers it here and the viewer's picks and gestures reach the same
 * plate without either module learning about the other. A page with no
 * immersive session has no sink and every caption is dropped.
 */
let captionSink;
export function setHeadsetCaptionSink(sink) {
  captionSink = typeof sink === 'function' ? sink : undefined;
}
export function headsetCaptionSink() { return captionSink; }
export function showHeadsetCaption(text) {
  if (typeof text !== 'string' || !captionSink) return false;
  try {
    const result = captionSink(text);
    if (result && typeof result.catch === 'function') result.catch(() => {});
    return true;
  } catch { return false; }
}

/**
 * The caption for a picked residue: chain and residue, nothing else.
 *
 * The caption plate holds one short line beside the menu. Chain and component
 * with the author numbering are what a structural biologist reads back, and
 * they match the labels the 2D panel writes for the same click.
 */
export function residueCaption(identity) {
  if (!identity || typeof identity !== 'object') return undefined;
  const chain = typeof identity.authorChain === 'string' && identity.authorChain
    ? identity.authorChain : identity.labelChain;
  const component = typeof identity.componentId === 'string' ? identity.componentId : undefined;
  if (typeof chain !== 'string' || !chain || !component) return undefined;
  const number = Number.isFinite(identity.authorResidue) ? `${identity.authorResidue}`
    : Number.isFinite(identity.labelSequenceId) ? `${identity.labelSequenceId}` : '';
  const insertion = typeof identity.insertionCode === 'string' ? identity.insertionCode : '';
  return `Chain ${chain} · ${component}${number ? ` ${number}${insertion}` : ''}`;
}

/** How much of a tier's name still fits on the plate beside the rest of the line. */
export const TIER_NAME_PLATE_LIMIT = 18;

/**
 * The refusal a density tier earns, short enough to survive the plate.
 *
 * `detailed-view-contract.ts` refuses a map tier with a full sentence, because
 * the record and the Mac reader both want it: "The filament-density tier has
 * no atom coordinates. Switch to an atomic tier, then open Mol* again." The
 * wearer's caption plate holds one short line, and that sentence arrived there
 * as "Could not open Mol*…" — the tier and the way out both cut off, which is
 * the one thing the wearer needed.
 *
 * So the plate gets the same two facts in the settled short-reply length: the
 * tier that has no atoms, and the tier to switch to. A tier whose name is too
 * long to fit beside them is called what it is instead, because a truncated
 * name is worse than a general one. The full sentence still travels in the
 * diagnostics record and in the host's own reply.
 */
export function densityTierCaption(message) {
  const text = typeof message === 'string' ? message : '';
  const named = /^the\s+(.+?)\s+tier has no atom coordinates/iu.exec(text)?.[1] ?? '';
  const tier = named && named.length <= TIER_NAME_PLATE_LIMIT
    ? named.charAt(0).toUpperCase() + named.slice(1) : 'This density';
  return `${tier} tier has no atoms. Switch to an atomic tier.`;
}

/**
 * What the caption says when the Mac could not show the full Mol* viewer.
 *
 * Claude Science has no browser to open and says so through the tool's own
 * `not-macos`/`could not open` wording; everything else is one line the wearer
 * can act on without leaving immersion.
 *
 * A LAN share that ran out of time answers 410 or refuses the connection
 * outright, and the client turns both into an expired/lost/timed-out sentence
 * (`inspection-companion-client.ts:39-53`). Reported as "Could not open Mol* on
 * the Mac" it sent the wearer hunting for a broken button; the share is what
 * broke, and only the agent on the Mac can re-open it.
 */
export function workbenchFailureCaption(message) {
  const text = typeof message === 'string' ? message : '';
  // "unreachable" is this page's own answer about its own
  // origin (`DETAILED_VIEW_UNREACHABLE_CAPTION` in workbench-handoff.mjs), not
  // a report from the Mac. Rewriting it as "Could not open Mol* on the Mac"
  // told the wearer the opposite of what happened, so it passes through as
  // itself. This module stays import-free on purpose, hence the match.
  if (text.length <= 80 && /unreachable/iu.test(text)) return text;
  if (/no atom coordinates/iu.test(text)) return densityTierCaption(text);
  if (/expired|connection was lost|timed out/iu.test(text)) return 'Share expired. Ask Claude to re-open it.';
  if (/not[- ]macos|only on macos/iu.test(text)) return 'This host cannot open a Mac browser';
  if (/could not open/iu.test(text)) return 'The Mac browser did not open';
  return 'Could not open Mol* on the Mac';
}

/**
 * The full viewer opens on the Mac monitor, not in the headset. "Opened Mol* on
 * the Mac" left the wearer waiting in VR for something to appear there, so the
 * caption now says the one thing left to do.
 */
export const WORKBENCH_OPENED_CAPTION = 'Mol* is open on the Mac. Lift the headset.';

/**
 * Track the gesture across frames and turn it into viewer work.
 *
 * `update` is called once per XR frame with the tracked pointers Mol* already
 * publishes, so the aim it reads is the same one the renderer used. Callbacks
 * are deliberately narrow: this module never touches a representation, a
 * camera or the presentation scene.
 */
export function createXrManipulation({
  isClaimed = () => false,
  canManipulate = () => true,
  onGrabStart = () => {},
  // A renderer can consume one complete frame delta and flush its transforms
  // once. Omit this to retain the individual callbacks below, in their order.
  onDelta,
  onRotate = () => {},
  onTranslate = () => {},
  onScale = () => {},
  onGrabEnd = () => {},
  // A grip the viewer could not honour. Called once a second
  // while it persists, on the same throttle as the log line, so the wearer can
  // be told rather than left holding a controller that does nothing.
  onGrabRefused = () => {},
  record = recordManipulation,
  pulse = pulseController,
  now = () => (globalThis.performance?.now?.() ?? Date.now()),
  gripLatch = createGripLatch(),
  // In pointer coordinates: target centre minus viewer head, sampled on press.
  gripDepthAxis = () => undefined,
  triggerTargetDistance = () => undefined,
  triggerStickOwnsMotion = () => false,
  isRayOnMenu = () => false,
} = {}) {
  let state = idleManipulation();
  const triggerDrag = createTriggerDrag({ targetDistance: triggerTargetDistance, isClaimed, isRayOnMenu,
    suppressMotion: triggerStickOwnsMotion, now });
  const lastSources = new Map();
  const gripDepthAxes = new Map();
  // A menu may end its drag before the physical squeeze ends (for example on
  // tracking timeout). That same press must not become a molecular grab.
  const claimedGrips = new Set();
  const lastPointers = new Map(), missingAt = new Map(), missingPoseAt = new Map(), mustRelease = new Set();
  let lastUpdateAt;
  let ambiguousPickUntil = -Infinity;
  let turnedDegrees = 0, scaledBy = 1;
  const travelled = [0, 0, 0];
  let lastSource;
  // A rejection at 72 Hz would bury the log it exists to explain. Say each
  // distinct reason once, then once a second while it persists.
  let lastReason, lastReasonAt = 0, inventoried = false;

  function reject(reason, detail) {
    if (!reason) { lastReason = undefined; return false; }
    const at = now();
    if (reason === lastReason && at - lastReasonAt < 1000) return false;
    lastReason = reason; lastReasonAt = at;
    record('xr-grab', { event: 'rejected', reason, ...detail });
    return true;
  }

  function finish(phase) {
    const summary = { phase, degrees: Math.round(turnedDegrees * 10) / 10,
      scale: Math.round(scaledBy * 1000) / 1000,
      moved: Math.round(Math.hypot(...travelled) * 1000) / 1000 };
    turnedDegrees = 0; scaledBy = 1; travelled[0] = travelled[1] = travelled[2] = 0;
    pulse(lastSource, RELEASE_PULSE);
    try { onGrabEnd(summary); } catch (error) { console.error(error); }
    record('xr-grab', { ...summary, event: 'end' });
  }

  return {
    phase: () => state.phase,
    /** Explicit focus loss must cancel even when it lasts less than a frame-gap timeout. */
    suspend() {
      for (const [hand, pointer] of lastPointers) {
        if (triggerDrag.owns(hand) || gripLatch.holds(hand) || (pointer.buttons & (POINTER_TRIGGER | POINTER_GRIP))) {
          mustRelease.add(hand); triggerDrag.cancel(hand);
        }
      }
      if (state.phase !== 'idle') { const phase = state.phase; state = idleManipulation(); finish(phase); }
      gripLatch.reset(); gripDepthAxes.clear(); claimedGrips.clear(); missingAt.clear(); missingPoseAt.clear(); lastUpdateAt = undefined;
    },
    /**
     * Whether the grip's Schmitt trigger holds this hand, for readers outside
     * the grab.
     *
     * The stick's scale modifier used to read Mol*'s thresholded grip bit,
     * which crosses at a different squeeze than this latch: relaxing a grab to
     * about 0.5 kept the structure held and dropped the stick back to sliding,
     * so one hand drove two paths at once. Both now read this.
     *
     * @param {string} hand `'left'` or `'right'`
     */
    // Stick travel moves the subject and its held ray anchor together.
    // Otherwise a close subject still swings on its former distant radius.
    offsetRayAnchor(hand, translation) {
      if (!triggerDrag.offset(hand, translation)) return;
      if (state.hand === hand && state.kind === 'ray' && state.anchor) {
        state = { ...state, anchor: state.anchor.map((value, axis) => value + translation[axis]) };
      }
    },
    gripHeld: hand => gripLatch.holds(hand),
    triggerPhase: hand => triggerDrag.phase(hand),
    triggerOwns: hand => triggerDrag.owns(hand),
    consumesPick: hand => triggerDrag.consumesPick(hand),
    /** Cancellation also blocks this hand's stick until its buttons come up. */
    requiresRelease: hand => mustRelease.has(hand),
    // Mol* click events omit handedness. Concurrent triggers need a bounded
    // global release guard so one hand's drag cannot spend the other's pick.
    pickAmbiguous: () => now() <= ambiguousPickUntil,
    /**
     * Whether one named hand is holding the structure right now.
     *
     * A grab is held by `state.hand` alone; a scale is held by both. Nothing
     * else in the gesture claims a hand, so this is the whole answer. The
     * thumbstick readers ask it per hand: a wearer grabbing with the left
     * hand still has a right thumb free, and freezing that stick because some
     * gesture is running took away the coarse control the grab cannot give.
     *
     * @param {string} hand `'left'` or `'right'`
     */
    holds: hand => state.phase === 'scale' ? MANIPULATION_HANDS.includes(hand)
      : state.phase !== 'idle' && state.hand === hand,
    /** @param {Array<object>} pointers `{handedness, buttons, ray, source}` per tracked controller */
    update(pointers) {
      const at = now();
      if ((pointers ?? []).filter(pointer => ((pointer?.buttons | 0) & POINTER_TRIGGER) !== 0).length > 1) {
        ambiguousPickUntil = at + TRIGGER_PICK_GUARD_MS;
      }
      if (Number.isFinite(lastUpdateAt) && at - lastUpdateAt > MANIPULATION_FRAME_GAP_MS) {
        for (const [hand, pointer] of lastPointers) {
          if (triggerDrag.owns(hand) || claimedGrips.has(hand) || (state.phase !== 'idle' && (state.hand === hand || state.phase === 'scale'))) {
            mustRelease.add(hand); triggerDrag.cancel(hand);
          }
        }
        if (state.phase !== 'idle') { const held = state.phase; state = idleManipulation(); finish(held); }
        gripLatch.reset(); gripDepthAxes.clear(); claimedGrips.clear();
      }
      lastUpdateAt = at;
      const hands = {};
      const replacedHands = new Set();
      const copyPose = pose => pose && ({ ...pose,
        origin: Array.from(pose.origin ?? []), direction: Array.from(pose.direction ?? []),
        ...(pose.orientation ? { orientation: Array.from(pose.orientation) } : {}) });
      const present = new Map((pointers ?? []).filter(pointer => MANIPULATION_HANDS.includes(pointer?.handedness))
        .map(pointer => [pointer.handedness, pointer]));
      for (const handedness of MANIPULATION_HANDS) {
        let previousPointer = lastPointers.get(handedness);
        let pointer = present.get(handedness);
        // A pose timeout can prune lastPointers while its release guard stays.
        // Keep source identity until the slot is replaced or the session ends.
        const previousSource = previousPointer?.source ?? lastSources.get(handedness);
        if (previousSource && pointer?.source && previousSource !== pointer.source) {
          // A new source owns a fresh gesture, including when a controller
          // replaces a tracked hand. Handedness alone cannot carry the old
          // source's pose, grip latch or release guard into that gesture.
          replacedHands.add(handedness);
          gripDepthAxes.delete(handedness);
          claimedGrips.delete(handedness);
          gripLatch.read(handedness, { buttons: 0 }); triggerDrag.forget(handedness);
          lastPointers.delete(handedness); missingAt.delete(handedness); missingPoseAt.delete(handedness); mustRelease.delete(handedness);
          previousPointer = undefined;
        }
        if (pointer?.source) lastSources.set(handedness, pointer.source);
        if (!pointer) {
          const last = lastPointers.get(handedness);
          if (!last) continue;
          // A transient pinch source exists only for the duration of its
          // gesture. Its disappearance is an explicit release, not occlusion.
          if (last.transient || last.source?.targetRayMode === 'transient-pointer') {
            gripDepthAxes.delete(handedness);
            claimedGrips.delete(handedness);
            mustRelease.delete(handedness);
            gripLatch.read(handedness, { buttons: 0 });
            lastPointers.delete(handedness); missingAt.delete(handedness); missingPoseAt.delete(handedness);
            continue;
          }
          const since = missingAt.get(handedness) ?? now();
          missingAt.set(handedness, since);
          if (now() - since > TRIGGER_TRACKING_GRACE_MS) {
            if (gripLatch.holds(handedness) || triggerDrag.owns(handedness) || (last.buttons & (POINTER_TRIGGER | POINTER_GRIP))) {
              mustRelease.add(handedness);
            }
            triggerDrag.cancel(handedness);
            gripLatch.read(handedness, { buttons: 0 });
            lastPointers.delete(handedness); missingPoseAt.delete(handedness);
            continue;
          }
          // Keep the press, but clear its pose baseline until tracking returns.
          pointer = { ...last, ray: undefined, gripPose: undefined };
          if (state.hand === handedness || state.phase === 'scale') state = { ...state, anchor: undefined, direction: undefined, orientation: undefined, span: undefined };
        } else {
          if (missingAt.has(handedness) && (state.hand === handedness || state.phase === 'scale')) {
            state = { ...state, anchor: undefined, direction: undefined, orientation: undefined, span: undefined };
          }
          missingAt.delete(handedness);
          lastPointers.set(handedness, { ...pointer, ray: copyPose(pointer.ray), gripPose: copyPose(pointer.gripPose) });
        }
        const wasGrip = gripLatch.holds(handedness);
        const grip = gripLatch.read(handedness, pointer);
        const claimed = Boolean(isClaimed(handedness));
        if (!grip) claimedGrips.delete(handedness);
        else if (claimed) claimedGrips.add(handedness);
        else if (claimedGrips.has(handedness)) mustRelease.add(handedness);
        if (!grip) gripDepthAxes.delete(handedness);
        else if (!wasGrip) {
          let axis;
          try { axis = normalize(gripDepthAxis(handedness, pointer)); } catch { /* Direct movement remains available. */ }
          gripDepthAxes.set(handedness, axis);
        }
        const metricPointer = { ...pointer, ray: copyPose(pointer.ray), gripPose: copyPose(pointer.gripPose) };
        const trigger = triggerDrag.read(handedness, metricPointer, grip);
        if (trigger?.rebased) record('xr-grab', { event: 'rebased', hand: handedness, reason: trigger.rebased });
        const rayHeld = trigger?.phase === 'drag';
        const triggerOwns = triggerDrag.owns(handedness);
        const gripTransform = metricPointer.hasGripSpace === true ? metricPointer.gripPose : metricPointer.ray;
        const stateOwnsHand = state.phase === 'scale' || (state.phase !== 'idle' && state.hand === handedness);
        // A measured position discontinuity invalidates the whole grip pose,
        // including its orientation and its contribution to a two-hand span.
        // Testing only midpoint travel hid one hand's jump; discarding only
        // translation still rotated or resized the molecule on that frame.
        const previousGrip = previousPointer?.hasGripSpace === true ? previousPointer.gripPose : previousPointer?.ray;
        const quality = positionQuality(metricPointer, metricPointer.hasGripSpace === true);
        if (stateOwnsHand && state.kind !== 'ray' && grip && canUsePosition(quality)
            && quality === positionQuality(previousPointer, previousPointer?.hasGripSpace === true)
            && spanBetween(previousGrip?.origin, gripTransform?.origin) > MAX_FRAME_TRANSLATION) {
          state = { ...state, anchor: undefined, direction: undefined, orientation: undefined, span: undefined };
          record('xr-grab', { event: 'rebased', hand: handedness, reason: 'tracking-jump' });
        }
        const needsRayPose = triggerOwns || rayHeld || (stateOwnsHand && state.kind === 'ray');
        const needsGripPose = !needsRayPose && (grip || (stateOwnsHand && state.kind !== 'ray'));
        const activePose = needsRayPose ? metricPointer.ray : needsGripPose ? gripTransform : undefined;
        if ((!needsRayPose && !needsGripPose) || activePose) missingPoseAt.delete(handedness);
        else {
          const since = missingPoseAt.get(handedness) ?? at;
          missingPoseAt.set(handedness, since);
          if (stateOwnsHand) state = { ...state, anchor: undefined, direction: undefined, orientation: undefined, span: undefined };
          // A still-present controller supplies live analog release even when
          // its grip pose is missing. Give camera occlusion time to recover;
          // Transient pinches do not supply independent analog release, so
          // they keep the short timeout even while their source remains listed.
          const liveController = present.has(handedness) && !pointer.transient
            && pointer.source?.targetRayMode === 'tracked-pointer'
            && Number.isFinite(pointer.source?.gamepad?.buttons?.[1]?.value);
          const grace = needsGripPose && liveController ? GRIP_TRACKING_GRACE_MS : TRIGGER_TRACKING_GRACE_MS;
          if (at - since > grace && (triggerOwns || stateOwnsHand)) {
            mustRelease.add(handedness); triggerDrag.cancel(handedness);
          }
        }
        if (mustRelease.has(handedness)) {
          // Cancellation clears the engage latch, but a relaxed analog grip
          // above its release threshold is still physically held. Requiring
          // the engage threshold here would silently re-arm that cancelled hand.
          const gripValue = pointer?.source?.gamepad?.buttons?.[1]?.value;
          const gripNotReleased = Number.isFinite(gripValue) ? gripValue >= GRIP_RELEASE : grip;
          if (gripNotReleased || ((pointer.buttons | 0) & POINTER_TRIGGER)) continue;
          mustRelease.delete(handedness);
        }
        const rayQuality = positionQuality(metricPointer);
        const gripQuality = positionQuality(metricPointer, metricPointer.hasGripSpace === true);
        const handQuality = rayHeld ? rayQuality : gripQuality;
        hands[handedness] = {
          grip: rayHeld || (grip && !triggerOwns && (Boolean(gripTransform) || stateOwnsHand)),
          positionTracked: canUsePosition(handQuality),
          positionQuality: handQuality,
          kind: rayHeld ? 'ray' : 'grip',
          claimed: rayHeld ? false : claimed,
          origin: rayHeld ? trigger.anchor : gripTransform?.origin,
          direction: rayHeld ? metricPointer.ray?.direction : gripTransform?.direction,
          orientation: rayHeld ? undefined : gripTransform?.orientation,
          source: pointer.source,
        };
      }
      if (state.phase !== 'idle' && [...replacedHands].some(hand => state.phase === 'scale' || state.hand === hand)) {
        const survivor = MANIPULATION_HANDS.some(hand => !replacedHands.has(hand)
          && (state.phase === 'scale' || state.hand === hand) && hands[hand]?.grip && !hands[hand]?.claimed);
        if (survivor) state = { ...state, anchor: undefined, direction: undefined, orientation: undefined, span: undefined };
        else { const held = state.phase; state = idleManipulation(); finish(held); }
      }
      // What the hardware actually publishes, once per session. The session
      // record is capped at 400 characters and loses its input sources, so
      // without this a dead grip cannot be told from an absent controller.
      if (!inventoried && (pointers ?? []).length) {
        inventoried = true;
        const first = MANIPULATION_HANDS.find(name => hands[name]);
        record('xr-grab', { event: 'pointers', count: (pointers ?? []).length,
          hands: Object.keys(hands), ray: Boolean(hands[first]?.direction),
          haptics: Boolean(hands[first]?.source?.gamepad?.hapticActuators?.length) });
      }
      // The release buzz goes to the hand that was holding the structure, which
      // is whichever grip owns the grab rather than a fixed side.
      if (hands[state.hand]?.source) lastSource = hands[state.hand].source;
      // A viewer that is not ready has no placement to change. Drop a gesture
      // in flight rather than accumulating a turn nothing can bake.
      if (!canManipulate()) {
        // The grip is still down and the structure is not going to move this
        // frame. Say so once, and say it again every second it lasts; the
        // wearer gets the next frame the viewer is ready, because a held grip
        // starts the grab on its own the moment this gate opens.
        if (MANIPULATION_HANDS.some(name => hands[name]?.grip) && reject(GRAB_REJECTED.notReady)) {
          try { onGrabRefused(GRAB_REJECTED.notReady); } catch (error) { console.error(error); }
        }
        if (state.phase !== 'idle') { const held = state.phase; state = idleManipulation(); finish(held); }
        return state.phase;
      }
      // Both poses define a two-grip midpoint and span. A missing pose cannot
      // turn that midpoint into the surviving hand's origin. Freeze the scale
      // and rebase its first complete frame after tracking returns.
      if (state.phase === 'scale' && MANIPULATION_HANDS.every(hand => hands[hand]?.grip)
          && MANIPULATION_HANDS.some(hand => !hands[hand]?.origin || !hands[hand]?.direction)) {
        state = { ...state, anchor: undefined, direction: undefined, span: undefined };
        return state.phase;
      }
      const step = nextManipulation(state, hands);
      const previousHand = state.hand;
      state = step.state;
      if (state.phase === 'grab' && state.kind === 'grip' && step.translation) {
        step.translation = gripDepthTranslation(step.translation, gripDepthAxes.get(state.hand));
      }
      if (hands[state.hand]?.source) lastSource = hands[state.hand].source;
      reject(step.rejected);
      if (step.started === 'grab') {
        pulse(hands[state.hand]?.source, GRAB_PULSE);
        try { onGrabStart({ hand: state.hand, kind: state.kind }); } catch (error) { console.error(error); }
        record('xr-grab', { event: 'start', hand: state.hand, kind: state.kind });
      }
      if (step.started === 'scale') {
        const joined = MANIPULATION_HANDS.find(name => name !== state.hand);
        pulse(hands[joined]?.source, GRAB_PULSE);
        record('xr-scale', { event: 'start' });
      }
      // Ownership passing to the surviving grip is worth one line: on hardware
      // it is the difference between "I let go and it stayed" and a bug report.
      if (step.rebased || (step.ended === 'scale' && state.hand !== previousHand)) {
        record('xr-grab', { event: 'rebased', hand: state.hand, from: previousHand });
      }
      if (step.rotation) {
        turnedDegrees += rotationDegrees(step.rotation);
        if (!onDelta) try { onRotate(step.rotation); } catch (error) { console.error(error); }
      }
      if (step.translation) {
        for (let axis = 0; axis < 3; axis += 1) travelled[axis] += step.translation[axis];
        if (!onDelta) try { onTranslate(step.translation); } catch (error) { console.error(error); }
      }
      if (step.scale) {
        scaledBy *= step.scale;
        if (!onDelta) try { onScale(step.scale); } catch (error) { console.error(error); }
      }
      if (onDelta && (step.rotation || step.translation || step.scale)) {
        try { onDelta({ rotation: step.rotation, translation: step.translation, scale: step.scale }); }
        catch (error) { console.error(error); }
      }
      if (step.ended === 'scale') record('xr-scale', { event: 'end', scale: Math.round(scaledBy * 1000) / 1000 });
      // Releasing the second grip ends the scale and leaves the grab running.
      // Releasing the grab hand ends whichever phase was live, and only then
      // is there a placement to bake.
      if (step.ended && state.phase === 'idle') finish(step.ended);
      return state.phase;
    },
    /** Drop a gesture the session ended under, without baking a placement. */
    reset() {
      const held = state.phase !== 'idle';
      state = idleManipulation();
      turnedDegrees = 0; scaledBy = 1; travelled[0] = travelled[1] = travelled[2] = 0;
      lastSource = undefined; lastReason = undefined; inventoried = false;
      lastUpdateAt = undefined;
      ambiguousPickUntil = -Infinity;
      gripLatch.reset(); triggerDrag.reset(); lastSources.clear(); lastPointers.clear(); missingAt.clear(); missingPoseAt.clear(); mustRelease.clear();
      gripDepthAxes.clear(); claimedGrips.clear();
      return held;
    },
  };
}
