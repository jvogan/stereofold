// A Vision Pro pinch, without a Vision Pro.
//
// There is no headset on this machine and no simulator in this repository, so
// the natural-input rules would otherwise only ever be read, never run. This
// fabricates what visionOS Safari actually delivers: a source that appears
// just before `selectstart`, reports `transient-pointer`, carries no gamepad,
// carries no hand joints unless the person granted hand tracking, and is gone
// again after `selectend`. Frames answer `getPose` for whichever aim the pinch
// currently holds and nothing else.
//
// It is deliberately not a WebXR polyfill. It emits the five events the
// adapter binds and it resolves one pose per source, which is the whole of
// what the adapter reads.

/** The ray mode Apple reports for a pinch. */
const TRANSIENT = 'transient-pointer';

function normalize(vector) {
  const length = Math.hypot(...vector);
  return length > 0 ? vector.map(value => value / length) : [0, 0, -1];
}
function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/**
 * A rigid pose whose negative Z basis is the aim, which is the reading Mol*,
 * the spatial toolbar and the adapter all take.
 */
export function poseFromRay({ origin, direction, emulatedPosition = false }) {
  const forward = normalize(direction);
  const z = forward.map(value => -value);
  const reference = Math.abs(z[1]) > 0.99 ? [1, 0, 0] : [0, 1, 0];
  const x = normalize(cross(reference, z));
  const y = cross(z, x);
  return Object.freeze({
    emulatedPosition,
    transform: Object.freeze({
      position: Object.freeze({ x: origin[0], y: origin[1], z: origin[2] }),
      matrix: Object.freeze([x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0,
        origin[0], origin[1], origin[2], 1]),
    }),
  });
}

/**
 * The emulator.
 *
 * @param {{space?:object}} [options] the reference space poses are resolved in
 */
export function createNaturalInputEmulator({ space = Object.freeze({ reference: 'local' }) } = {}) {
  const listeners = new Map();
  const sources = [];
  const rays = new Map();
  const grips = new Map();
  let serial = 0;

  function on(type, handler) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(handler);
  }
  function off(type, handler) { listeners.get(type)?.delete(handler); }
  function emit(type, event) { for (const handler of [...(listeners.get(type) ?? [])]) handler(event); }

  const session = Object.freeze({
    addEventListener: on,
    removeEventListener: off,
    get inputSources() { return [...sources]; },
    /** How many listeners are bound, so a test can prove `dispose` unbinds. */
    listenerCount: type => listeners.get(type)?.size ?? 0,
  });

  /** This tick's frame. Only the live pinches and hands resolve a pose. */
  function frame() {
    return Object.freeze({
      getPose(targetRaySpace, reference) {
        if (reference !== space) return undefined;
        for (const [source, grip] of grips) {
          if (source.gripSpace === targetRaySpace) return grip ? poseFromRay(grip) : undefined;
        }
        for (const [source, ray] of rays) {
          if (source.targetRaySpace === targetRaySpace) return ray ? poseFromRay(ray) : undefined;
        }
        return undefined;
      },
    });
  }

  function add(source, ray) {
    sources.push(source);
    rays.set(source, ray);
    emit('inputsourceschange', { session, added: [source], removed: [] });
  }
  function remove(source) {
    const at = sources.indexOf(source);
    if (at >= 0) sources.splice(at, 1);
    rays.delete(source); grips.delete(source);
    emit('inputsourceschange', { session, added: [], removed: [source] });
  }

  /**
   * A persistent hand, the way visionOS reports one when the person granted
   * hand tracking. It is a tracked pointer with joints and no gamepad, so it
   * belongs to the existing hand path and the adapter must leave it alone.
   */
  function addHand(handedness = 'left', { ray = { origin: [0, 1.2, 0], direction: [0, 0, -1] } } = {}) {
    const source = { handedness, targetRayMode: 'tracked-pointer', profiles: ['generic-hand'],
      targetRaySpace: { id: `hand-${handedness}` }, hand: new Map(), gamepad: undefined };
    add(source, ray);
    return source;
  }

  /** A Quest controller, for the same reason: it must keep its own path. */
  function addController(handedness = 'right') {
    const source = { handedness, targetRayMode: 'tracked-pointer', profiles: ['oculus-touch-v3'],
      targetRaySpace: { id: `controller-${handedness}` },
      gamepad: { buttons: [{ value: 0 }, { value: 0 }], axes: [0, 0], hapticActuators: [] } };
    add(source, { origin: [0.2, 1.2, 0], direction: [0, 0, -1] });
    return source;
  }

  /**
   * One pinch, from the source appearing to the source vanishing.
   *
   * @param {{ray?:object, handedness?:string, hands?:boolean}} [options]
   */
  function pinch({ ray = { origin: [0, 1.4, 0], direction: [0, 0, -1] }, handedness = 'none', hands = false, grip = undefined } = {}) {
    serial += 1;
    const source = { handedness, targetRayMode: TRANSIENT, profiles: ['generic-touchpad'],
      targetRaySpace: { id: `pinch-${serial}` }, gamepad: undefined,
      ...(grip !== undefined ? { gripSpace: { id: `pinch-grip-${serial}` } } : {}),
      ...(hands ? { hand: new Map() } : {}) };
    let aim = ray;
    if (source.gripSpace) grips.set(source, grip);
    const handle = {
      source,
      /** The source arrives, then the pinch closes. */
      start() { add(source, aim); emit('selectstart', { inputSource: source, frame: frame(), session }); return handle; },
      /** The hand moved, or the person looked somewhere else. */
      aimAt(next) { aim = next; rays.set(source, next); return handle; },
      gripAt(next) { if (source.gripSpace) grips.set(source, next); return handle; },
      /** The pinch completed. Apple sends this before `selectend`. */
      select() { emit('select', { inputSource: source, frame: frame(), session }); return handle; },
      /** The fingers opened, and the source is taken away. */
      end({ remove: withdraw = true } = {}) {
        emit('selectend', { inputSource: source, frame: frame(), session });
        if (withdraw) remove(source);
        return handle;
      },
      /** The runtime took the gesture back. */
      cancel() { emit('selectcancel', { inputSource: source, frame: frame(), session }); remove(source); return handle; },
      /** Tracking lost the hand: the source is withdrawn with no release. */
      vanish() { remove(source); return handle; },
    };
    return handle;
  }

  return Object.freeze({ session, space, frame, pinch, addHand, addController, emit,
    sources: () => [...sources] });
}
