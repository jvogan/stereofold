// Apple's look-and-pinch, carried to the molecule.
//
// Why this exists
// ---------------
// On Vision Pro there is no controller and no trigger. A person looks at
// something and pinches, and Safari answers with an `XRInputSource` whose
// `targetRayMode` is `transient-pointer`: it is created just before
// `selectstart`, it carries the pinch for as long as it is held, and it is
// gone again after `selectend`. It has no gamepad. If hand tracking is
// refused it has no joints either. Its target ray aims from the eyes, while
// its optional grip pose locates the pinching fingers independently of joints. WebKit's own note on natural input is the reference:
// https://webkit.org/blog/15162/
//
// Mol*'s XR manager publishes tracked pointers. This adapter adds transient
// pinches to the shared molecule manipulation path, while the spatial menu
// consumes their native select events. Eye rays determine selection; finger
// poses determine physical movement and spacing when gripSpace is available.
//
// This module is the bridge. It reads the pinch from the session's own select
// events, takes the pose from the event's own frame, and hands the result to
// the two paths the Quest controller already drives: the same residue pick,
// and the same grab, rotate and scale gesture machine. Nothing here knows
// about Mol*, a camera or a representation; the viewer owns all of that and
// passes in two callbacks.
//
// Ownership
// ---------
// One pinch is the whole vocabulary, so who it belongs to is decided once, at
// `selectstart`, from where the ray was pointing then. A pinch that starts on
// the menu belongs to the menu for its whole life and never reaches the
// molecule, even if the wearer's gaze drifts off the panel mid-pinch. A pinch
// that starts on the molecule is ours, and the menu declines it by its own
// rule: the toolbar starts a gesture only when the ray hits its visible glass.
//
// Tap or drag
// -----------
// A controller separates the two with two buttons. A pinch has to be read.
// A pinch that is released without travelling is a pick, and the pick runs
// against the pose the `select` event carried. A pinch that travels past
// `PINCH_DRAG_METERS` or turns past `PINCH_DRAG_DEGREES` becomes a grab from
// the finger pose it had at that moment, not from where the pinch began, so crossing
// the threshold never jumps the structure by the threshold. A gesture that
// became a grab is never also a pick.
//
// Every function here runs in Node against plain fakes. An input source is
// anything with `targetRayMode` and `targetRaySpace`; a frame is anything with
// `getPose`.

import { POINTER_GRIP, recordManipulation } from './xr-manipulate.mjs';

/** The ray mode Apple reports for a pinch, and no other runtime reports. */
export const TRANSIENT_RAY_MODE = 'transient-pointer';

/**
 * The two slots `createXrManipulation` understands.
 *
 * A transient source is not a controller and its `handedness` is whatever the
 * runtime felt like reporting, so a slot is assigned on arrival rather than
 * read off the source. Identity lives in the gesture map; the slot is only the
 * shape the existing gesture machine takes. Right first, matching the tie
 * `MANIPULATION_HANDS` already breaks, so a single pinch behaves like a right
 * grip and two pinches become the two-hand scale.
 */
export const NATURAL_HANDS = Object.freeze(['right', 'left']);

/** Metres a pinch must carry before it stops being a tap. */
export const PINCH_DRAG_METERS = 0.03;
/** Degrees a pinch must turn before it stops being a tap. */
export const PINCH_DRAG_DEGREES = 2;

/** Who a pinch belongs to, decided at `selectstart` and never revisited. */
export const NATURAL_OWNER = Object.freeze({ menu: 'menu', molecule: 'molecule', none: 'none' });

/** The diagnostic kind every line from this module is filed under. */
export const NATURAL_INPUT_DIAGNOSTIC = 'natural-input';

/** True for a pinch, false for a Quest controller and for a tracked hand. */
export function isNaturalInputSource(source) {
  return Boolean(source) && typeof source === 'object' && source.targetRayMode === TRANSIENT_RAY_MODE;
}

/**
 * The aim a pose describes: where it is, and the way it faces.
 *
 * Same reading the spatial toolbar takes (`spatial-toolbar.mjs:606`) and the
 * same one Mol* takes for a controller, which is the negative Z basis of the
 * pose matrix. Keeping all three identical is what lets a pinch reach the pick
 * the trigger reaches.
 */
export function naturalRayFromPose(pose) {
  const matrix = pose?.transform?.matrix, origin = pose?.transform?.position;
  if (!matrix || !origin || matrix.length < 16) return undefined;
  const ray = { origin: [origin.x, origin.y, origin.z], direction: [-matrix[8], -matrix[9], -matrix[10]] };
  if (!Array.from(matrix).every(Number.isFinite) || !ray.origin.every(Number.isFinite)
      || !ray.direction.every(Number.isFinite) || Math.hypot(...ray.direction) <= 1e-9) return undefined;
  const q = pose.transform.orientation;
  return { ...ray, matrix: Array.from(matrix),
    orientation: q && [q.x, q.y, q.z, q.w].every(Number.isFinite) ? [q.x, q.y, q.z, q.w] : undefined,
    emulatedPosition: typeof pose.emulatedPosition === 'boolean' ? pose.emulatedPosition : undefined,
    poseQualitySource: 'webxr' };
}

/** The pinch's aim this frame, or `undefined` when the pose is not resolved. */
export function naturalRayFor(frame, source, space) {
  let pose;
  try { pose = frame?.getPose?.(source?.targetRaySpace, space); }
  catch { return undefined; }
  return naturalRayFromPose(pose);
}

/** Finger pose, independent of the eye-target ray and optional hand joints. */
export function naturalGripFor(frame, source, space) {
  return source?.gripSpace ? naturalRayFor(frame, { targetRaySpace: source.gripSpace }, space) : undefined;
}

/** Convert manipulation poses only; menu hit tests and picks stay in room space. */
export function transformNaturalPointer(pointer, transformPose) {
  return { ...pointer,
    ray: pointer.ray ? transformPose(pointer.ray) : undefined,
    gripPose: pointer.gripPose ? transformPose(pointer.gripPose) : undefined };
}

function measuredPosition(pose) {
  return pose?.emulatedPosition !== true && (pose?.poseQualitySource !== 'webxr' || pose.emulatedPosition === false);
}
function tracking(pose) {
  return !pose ? 'unavailable' : pose.emulatedPosition === true ? 'emulated-position'
    : pose.emulatedPosition === false ? 'tracked-position' : 'unknown';
}

/**
 * Who owns a pinch, from where it started.
 *
 * A pinch with no resolved pose belongs to nobody. Without a ray there is no
 * way to tell the menu from the molecule, and guessing would either swallow a
 * menu press or move the structure from a press aimed at a row.
 */
export function pinchOwner({ ray, onMenu } = {}) {
  if (!ray) return NATURAL_OWNER.none;
  return onMenu === true ? NATURAL_OWNER.menu : NATURAL_OWNER.molecule;
}

/** Degrees between two aims, for the tap-or-drag reading. */
export function aimDegrees(from, to) {
  if (!from || !to) return 0;
  const lengthFrom = Math.hypot(...from), lengthTo = Math.hypot(...to);
  if (!(lengthFrom > 0) || !(lengthTo > 0)) return 0;
  const dot = (from[0] * to[0] + from[1] * to[1] + from[2] * to[2]) / (lengthFrom * lengthTo);
  return Math.acos(Math.min(1, Math.max(-1, dot))) * 180 / Math.PI;
}

/** Whether a pinch has moved far enough to be carrying the structure. */
export function pinchBecameDrag(from, to, { meters = PINCH_DRAG_METERS, degrees = PINCH_DRAG_DEGREES } = {}) {
  if (!from?.origin || !to?.origin) return false;
  const travel = Math.hypot(to.origin[0] - from.origin[0], to.origin[1] - from.origin[1], to.origin[2] - from.origin[2]);
  if (measuredPosition(from) && measuredPosition(to) && Number.isFinite(travel) && travel >= meters) return true;
  if (from.orientation?.length === 4 && to.orientation?.length === 4) {
    const norm = Math.hypot(...from.orientation) * Math.hypot(...to.orientation);
    const dot = from.orientation.reduce((sum, value, axis) => sum + value * to.orientation[axis], 0);
    if (norm > 0 && 2 * Math.acos(Math.min(1, Math.abs(dot / norm))) * 180 / Math.PI >= degrees) return true;
  }
  return aimDegrees(from.direction, to.direction) >= degrees;
}

/**
 * The adapter.
 *
 * @param {object} options
 * @param {(frame:object, source:object)=>object|undefined} options.rayFor this pinch's aim from a frame
 * @param {(frame:object, source:object)=>object|undefined} options.gripFor optional finger pose
 * @param {(ray:object, source:object)=>boolean} options.onMenu whether a ray starts on the spatial menu
 * @param {(hand:string)=>boolean} options.isClaimed whether the menu already holds that slot
 * @param {(pick:{ray:object, source:object})=>void} options.pick run the viewer's own residue pick
 * @param {()=>void} options.onDrive run one frame of the gesture machine
 * @param {(report:{inputSource:object, phase:string, owner:string, hand:string|null})=>void} options.onOwn
 */
export function createNaturalInput({
  rayFor = () => undefined,
  gripFor = () => undefined,
  onMenu = () => false,
  isClaimed = () => false,
  pick = () => {},
  onDrive = () => {},
  onOwn = () => {},
  record = recordManipulation,
  drag = undefined,
} = {}) {
  // Keyed by the source object itself. A transient source is a fresh object
  // for every pinch, so identity is the only stable key there is: handedness
  // repeats, and array position moves whenever hand tracking adds a persistent
  // source ahead of the pinch.
  const gestures = new Map();
  // A runtime that emits `select` before `selectstart` in one dispatch turn,
  // which the pinned IWER emulator does. Retained for that turn only, exactly
  // as the toolbar's own tracker retains it.
  const orphans = new Map();
  // The pick waits one frame on purpose. `select` fires outside the render
  // loop, and the viewer's pick reads the GPU pick buffer; running it from the
  // frame hook keeps that read where every other read already is. The ray is
  // the one the select event carried, so the deferral costs nothing but a
  // frame.
  let queuedPick;
  // One frame after a grab lets go, the gesture machine has to see the pointer
  // gone so it can bake the placement.
  let closing = false;

  function report(source, phase, gesture) {
    try { onOwn({ inputSource: source, phase, owner: gesture.owner, hand: gesture.hand ?? null }); }
    catch { /* Ownership consumers own their errors. */ }
  }
  function note(detail) {
    try { record(NATURAL_INPUT_DIAGNOSTIC, detail); }
    catch { /* Diagnostics never cost a gesture. */ }
  }
  function freeHand() {
    const taken = new Set([...gestures.values()].map(gesture => gesture.hand).filter(Boolean));
    return NATURAL_HANDS.find(hand => !taken.has(hand) && isClaimed(hand) !== true);
  }
  function keepOrphan(source) {
    orphans.set(source, true);
    queueMicrotask(() => orphans.delete(source));
  }
  function drop(source, gesture, phase) {
    gestures.delete(source);
    if (gesture.owner === NATURAL_OWNER.molecule && gesture.phase === 'grab') closing = true;
    note({ event: phase, owner: gesture.owner, hand: gesture.hand ?? null, held: gesture.phase });
    report(source, phase, gesture);
    return gesture.owner;
  }

  function selectStart(event) {
    const source = event?.inputSource;
    // A Quest controller and a tracked hand keep the path they already have.
    if (!isNaturalInputSource(source)) return undefined;
    if (gestures.has(source)) return gestures.get(source).owner;
    const ray = rayFor(event?.frame, source);
    let onPanel = false;
    if (ray) { try { onPanel = onMenu(ray, source) === true; } catch { onPanel = true; } }
    let owner = pinchOwner({ ray, onMenu: onPanel });
    let hand;
    if (owner === NATURAL_OWNER.molecule) {
      hand = freeHand();
      // Both slots are already carrying something. A third pinch has nothing
      // to drive and is better ignored than given a slot it would fight over.
      if (!hand) owner = NATURAL_OWNER.none;
    }
    const grip = source.gripSpace ? gripFor(event?.frame, source) : undefined;
    const gesture = { owner, hand, phase: 'pending', startPose: source.gripSpace ? grip : ray,
      ray, grip, selected: orphans.delete(source), picked: false };
    gestures.set(source, gesture);
    note({ event: 'start', owner, hand: hand ?? null, ray: Boolean(ray) });
    report(source, 'start', gesture);
    return owner;
  }

  function sampleGesture(gesture, source, frame) {
    gesture.ray = rayFor(frame, source);
    gesture.grip = source.gripSpace ? gripFor(frame, source) : undefined;
    const pose = source.gripSpace ? gesture.grip : gesture.ray;
    if (gesture.owner !== NATURAL_OWNER.molecule || gesture.phase !== 'pending') return;
    // A missing or changed-quality baseline cannot establish hand travel.
    if (!pose || !gesture.startPose || tracking(pose) !== tracking(gesture.startPose)) {
      gesture.startPose = pose;
      return;
    }
    if (!pinchBecameDrag(gesture.startPose, pose, drag ?? {})) return;
    gesture.phase = 'grab';
    if (queuedPick?.source === source) queuedPick = undefined;
    note({ event: 'grab', hand: gesture.hand });
  }

  function select(event) {
    const source = event?.inputSource;
    if (!isNaturalInputSource(source)) return false;
    const gesture = gestures.get(source);
    if (!gesture) { keepOrphan(source); return false; }
    gesture.selected = true;
    sampleGesture(gesture, source, event?.frame);
    if (gesture.owner !== NATURAL_OWNER.molecule || gesture.phase !== 'pending' || gesture.picked || !gesture.ray) return true;
    gesture.picked = true;
    queuedPick = { ray: gesture.ray, source };
    note({ event: 'pick-queued', hand: gesture.hand ?? null });
    return true;
  }

  function selectEnd(event) {
    const source = event?.inputSource;
    if (!isNaturalInputSource(source)) return undefined;
    const gesture = gestures.get(source);
    if (!gesture) { orphans.delete(source); return undefined; }
    sampleGesture(gesture, source, event?.frame);
    // A release with no select is a cancelled pinch, and cancelled picks
    // nothing. A drag that already carried the structure still ends as a
    // release: the wearer watched it move, so it bakes where they left it.
    if (gesture.owner === NATURAL_OWNER.molecule && gesture.phase === 'pending' && gesture.selected && !gesture.picked && gesture.ray) {
      gesture.picked = true;
      queuedPick = { ray: gesture.ray, source };
    }
    return drop(source, gesture, gesture.selected ? 'end' : 'cancel');
  }

  function cancel(source) {
    const gesture = gestures.get(source);
    if (!gesture) { orphans.delete(source); return undefined; }
    // The runtime took the gesture back, or the source vanished mid-pinch. A
    // pick it queued is dropped; a grab still bakes, for the same reason a
    // cancelled release does.
    if (queuedPick?.source === source) queuedPick = undefined;
    return drop(source, gesture, 'cancel');
  }
  function selectCancel(event) { return cancel(event?.inputSource); }
  function sourcesChange(event) {
    for (const source of event?.removed ?? []) cancel(source);
  }

  /** The pointers this pinch publishes, in the shape the controller path uses. */
  function pointers() {
    const list = [];
    for (const [source, gesture] of gestures) {
      if (gesture.owner !== NATURAL_OWNER.molecule || gesture.phase !== 'grab' || !gesture.hand) continue;
      // No gamepad on a transient source, so the grip latch reads this bitmask
      // instead of a squeeze value. That fallback already exists for tracked
      // hands and the emulator; a pinch is the third reader of it.
      const physical = source.gripSpace ? gesture.grip : gesture.ray;
      list.push({ handedness: gesture.hand, buttons: POINTER_GRIP, ray: gesture.ray, source, transient: true,
        hasGripSpace: Boolean(source.gripSpace), gripPose: gesture.grip,
        emulatedPosition: gesture.ray?.emulatedPosition, gripEmulatedPosition: gesture.grip?.emulatedPosition,
        tracking: tracking(gesture.ray), gripTracking: tracking(physical),
        poseQualitySource: physical?.poseQualitySource ?? gesture.startPose?.poseQualitySource });
    }
    return list;
  }

  /**
   * One XR frame. Promote pinches that have started travelling, drive the
   * gesture machine while any of them is carrying the structure, and run one
   * queued pick.
   */
  function frame(xrFrame) {
    // A Quest session reaches this on every frame and has nothing to do in it.
    // Return before allocating a pointer list, so the bridge costs a headset
    // that will never see a pinch one comparison per frame.
    if (!gestures.size && !closing && !queuedPick) return 0;
    for (const [source, gesture] of gestures) {
      if (gesture.owner !== NATURAL_OWNER.molecule) continue;
      sampleGesture(gesture, source, xrFrame);
    }
    const list = pointers();
    if (list.length || closing) {
      closing = false;
      try { onDrive(list); } catch (error) { console.error(error); }
    }
    const queued = queuedPick;
    if (queued) {
      queuedPick = undefined;
      note({ event: 'pick' });
      // `grabbing` says another pinch is carrying the structure, so the viewer
      // can keep a tap that missed everything from summoning the menu mid-grab.
      try { pick({ ...queued, frame: xrFrame, grabbing: list.length > 0 }); } catch (error) { console.error(error); }
    }
    return list.length;
  }

  return Object.freeze({
    selectStart, select, selectEnd, selectCancel, sourcesChange, frame, pointers,
    /** Who owns this source's live pinch, or `undefined` when it has none. */
    owner: source => gestures.get(source)?.owner,
    /** `'pending'` before a pinch travels, `'grab'` once it carries. */
    phase: source => gestures.get(source)?.phase,
    active: () => gestures.size,
    /**
     * Drop everything without picking and without baking. A session that ended
     * has no molecule to place, which is the same rule `createXrManipulation`
     * follows for a controller still held when immersion stops.
     */
    reset() {
      const held = pointers().length > 0;
      gestures.clear(); orphans.clear();
      queuedPick = undefined;
      closing = false;
      return held;
    },
  });
}

/**
 * Bind the adapter to a live session.
 *
 * The five listeners are the whole surface: four select events and the source
 * list. `dispose` removes them and drops any pinch still in flight, so a
 * session edge cannot leave a pinch owning a slot the next session reuses.
 */
export function attachNaturalInput({ session, ...options } = {}) {
  const adapter = createNaturalInput(options);
  const bindings = [
    ['selectstart', event => adapter.selectStart(event)],
    ['select', event => adapter.select(event)],
    ['selectend', event => adapter.selectEnd(event)],
    ['selectcancel', event => adapter.selectCancel(event)],
    ['inputsourceschange', event => adapter.sourcesChange(event)],
  ];
  for (const [type, handler] of bindings) {
    try { session?.addEventListener?.(type, handler); } catch { /* A torn-down session binds nothing. */ }
  }
  return Object.freeze({
    ...adapter,
    dispose() {
      for (const [type, handler] of bindings) {
        try { session?.removeEventListener?.(type, handler); } catch { /* The UA may have detached the session. */ }
      }
      return adapter.reset();
    },
  });
}
