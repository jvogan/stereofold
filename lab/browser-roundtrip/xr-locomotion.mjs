// The stock Mol* XR thumbstick, retired in favour of one that moves the
// structure.
//
// The stock bindings move the scene slowly and on one axis only, for two
// separate reasons.
// `mol-util/input/input-observer.js:449,461` turns a thumbstick into four key
// codes, `GamepadUp`/`GamepadDown` from the vertical axis and
// `GamepadLeft`/`GamepadRight` from the horizontal one, but
// `mol-canvas3d/controls/trackball.js:37,45` binds only the first two, to
// `keyMoveForward` and `keyMoveBack`. Nothing listens for left or right, so
// the stick travels on one axis and no other. Slow has the same root: with
// `flyMode` off, forward and back take the proportional branch in `moveCamera`
// at `trackball.js:328`, shrinking the eye vector by `moveSpeed / 100` a
// frame, and the stock `moveSpeed` of 0.75 is three quarters of a percent per
// frame at the 25 to 35 fps the headset log records.
//
// Raising the speed and binding strafe was the first fix here. Even retuned,
// a camera dolly on a thumbstick is the least comfortable control in the
// build, and moving the structure is what the interaction actually wants. So
// both gamepad codes come off the trackball, and `xr-buttons.mjs` drives the right
// thumbstick against the structure's own placement instead. Both hands emit
// the same four codes, so there is no way to leave one stick on the camera and
// give the other to the structure without editing Mol*.
//
// The room-locked menu and talk orb were never at risk either way.
// `room-lock.mjs:65` builds its matrix as `scale(1 / cameraScale)` times the
// inverse camera view, so it cancels both the camera's scale and its pose.

/**
 * What one hand's thumbstick means this frame.
 *
 * `slide` is the bare stick: right and left, up and down. `depth-yaw` is the
 * stick under a held trigger: closer and farther, and yaw. `scale` is the stick
 * under a held grip. `inert` is a trigger held while the ray is on the menu,
 * where the trigger is a select and nothing else.
 */
export const STICK_MODE = Object.freeze({ slide: 'slide', depthYaw: 'depth-yaw', scale: 'scale', inert: 'inert' });

/** `ButtonsType.Flag.Primary`, the trigger, as the pointer bitmask carries it. */
export const POINTER_TRIGGER_BIT = 1;
/** `ButtonsType.Flag.Secondary`, the grip. */
export const POINTER_GRIP_BIT = 2;

/**
 * How far a thumbstick may be pushed and still count as centred.
 *
 * The same 0.15 the travel dead zone uses (`STICK_DEAD_ZONE` in
 * `xr-buttons.mjs`): below it the stick moves nothing, so a mode change made
 * there cannot move the structure either.
 */
export const STICK_RECENTRE = 0.15;
/**
 * How long after a trigger modifier ends its press still owns the pick.
 *
 * Mol* raises `interaction.click` on the release, after the latch has already
 * cleared, so the guard has to outlive the latch by more than one frame at
 * 72 Hz and by less than the time it takes to aim and pull again.
 */
export const MODIFIER_PICK_GUARD_MS = 400;
/**
 * How long a hand may stop reporting before its trigger latch is dropped.
 *
 * Quest loses a controller pose for a frame or two when it leaves the headset's
 * cameras, and the wearer's finger is still on the trigger. Past this the
 * controller has been set down, and a latch kept any longer would go on
 * suppressing residue picks for the rest of the session.
 */
export const MISSING_POINTER_GRACE_MS = 250;

/** How far one hand's stick is pushed, 0 at rest and 1 at the rim. */
function stickPush(pointer) {
  const axes = pointer?.axes;
  const x = Number.isFinite(axes?.[2]) ? axes[2] : 0;
  const y = Number.isFinite(axes?.[3]) ? axes[3] : 0;
  return Math.min(1, Math.hypot(x, y));
}

/**
 * The trigger and grip modifier layers, one latch per hand.
 *
 * One controller does everything: keep the thumb on the stick and change what
 * it means with a finger that is not the thumb. The index finger holds the
 * trigger for depth and yaw, the middle finger holds the grip for scale.
 *
 * Two rules make it survive a menu in the same room. The trigger is a select
 * while the ray is on the menu, so a press that starts there never becomes a
 * modifier and the stick stays inert until the trigger comes up. And a modifier
 * that engaged off the menu is kept until the trigger is released even if the
 * ray later crosses the menu, which is the Midas-touch rule: a wearer pushing
 * the structure away must not have the push turn into a menu press because the
 * structure travelled behind the panel.
 *
 * `onEngage` is the haptic tick, fired once on the frame the trigger modifier
 * takes hold. It never throws into the frame loop.
 *
 * @param {object} options
 * @param {(hand:string)=>boolean} options.isRayOnMenu whether that hand's ray is over the menu
 * @param {(hand:string)=>void} [options.onEngage] called once per trigger modifier
 * @param {(hand:string)=>boolean} [options.gripHeld] the grab's grip latch; the pointer bitmask is the fallback
 * @param {()=>boolean} [options.scaleActive] whether both grips are already scaling
 */
export function createStickModifiers({ isRayOnMenu = () => false, onEngage = () => {}, record = () => {},
  gripHeld, scaleActive = () => false, recentre = STICK_RECENTRE, pickGuardMs = MODIFIER_PICK_GUARD_MS,
  triggerOwned = () => false, triggerDragging = () => false,
  requiresRelease = () => false,
  missingGraceMs = MISSING_POINTER_GRACE_MS,
  now = () => (globalThis.performance?.now?.() ?? Date.now()) } = {}) {
  const modes = new Map(), latched = new Set(), triggerWas = new Set(), missingSince = new Map(), blockedUntilRecentre = new Set();
  const consumedAt = new Map();

  /**
   * The grip, read through the grab's own Schmitt trigger when the caller
   * supplies it. Mol*'s bitmask crosses at a different squeeze than the latch,
   * so a hand that relaxed to 0.5 kept the structure and lost the scale stick.
   * The bitmask stays the fallback for a caller that has no latch to lend.
   */
  const gripFor = (hand, pointer) => typeof gripHeld === 'function'
    ? gripHeld(hand) === true
    : ((pointer?.buttons | 0) & POINTER_GRIP_BIT) !== 0;

  function handMode(hand, pointer) {
    // Tracking loss or a suspended frame loop cancels the whole hand gesture.
    // The grip latch alone cannot communicate that cancellation to the stick.
    if (requiresRelease(hand)) {
      latched.delete(hand); triggerWas.delete(hand);
      return STICK_MODE.inert;
    }
    // A frame with no pointer is lost tracking, not a release. Clearing the
    // latch there made the still-held trigger arrive next frame as a fresh
    // press, which flipped the mode in the middle of the wearer's push. A
    // controller that stays away past the grace has been put down, and its
    // latch goes with it rather than holding the pick guard open for the rest
    // of the session.
    if (!pointer) {
      const since = missingSince.get(hand) ?? now();
      missingSince.set(hand, since);
      if (now() - since < missingGraceMs) return latched.has(hand) ? STICK_MODE.depthYaw : STICK_MODE.slide;
      latched.delete(hand); triggerWas.delete(hand);
      return STICK_MODE.slide;
    }
    missingSince.delete(hand);
    const buttons = pointer.buttons | 0;
    const trigger = (buttons & POINTER_TRIGGER_BIT) !== 0;
    const grip = gripFor(hand, pointer);
    if (trigger && !triggerWas.has(hand)) consumedAt.delete(hand);
    if (trigger && triggerOwned(hand)) {
      triggerWas.add(hand); latched.delete(hand);
      // The pointed grab must keep the same depth control as empty space.
      // A computed controller position cannot supply an inward hand pull.
      if (grip) return scaleActive() ? STICK_MODE.inert : STICK_MODE.scale;
      return triggerDragging(hand) ? STICK_MODE.depthYaw : STICK_MODE.inert;
    }
    if (!trigger) {
      if (latched.has(hand) && consumedAt.has(hand)) consumedAt.set(hand, now());
      latched.delete(hand); triggerWas.delete(hand);
      if (!grip) return STICK_MODE.slide;
      // Both grips are already scaling with the span between the hands; a
      // thumb on either stick must not scale a third time.
      if (scaleActive()) return STICK_MODE.inert;
      return STICK_MODE.scale;
    }
    // A precision grip remains the transform owner if the index finger also
    // rests on the trigger. It must not turn its resize stick into depth/yaw.
    if (grip && !triggerWas.has(hand) && isRayOnMenu(hand)) { triggerWas.add(hand); return STICK_MODE.inert; }
    if (grip) return scaleActive() ? STICK_MODE.inert : STICK_MODE.scale;
    if (latched.has(hand)) return STICK_MODE.depthYaw;
    // A trigger already down when this hand first reported is not a press this
    // layer saw begin, so it cannot claim it. It becomes a modifier only on the
    // frame it goes down, and only away from the menu.
    const pressed = !triggerWas.has(hand);
    triggerWas.add(hand);
    if (!pressed) return STICK_MODE.inert;
    if (isRayOnMenu(hand)) { record('xr-stick', { hand, event: 'modifier-blocked', reason: 'menu' }); return STICK_MODE.inert; }
    consumedAt.delete(hand);
    latched.add(hand);
    record('xr-stick', { hand, event: 'modifier', mode: STICK_MODE.depthYaw });
    try { onEngage(hand); } catch { /* Haptics never cost a modifier. */ }
    return STICK_MODE.depthYaw;
  }

  return {
    /** @param {Array<object>} pointers this frame's tracked pointers */
    update(pointers) {
      for (const hand of ['left', 'right']) {
        const pointer = (pointers ?? []).find(entry => entry?.handedness === hand);
        const next = handMode(hand, pointer);
        const previous = modes.get(hand);
        const push = stickPush(pointer);
        // A held thumbstick keeps its old lane when a new modifier is added:
        // the wearer started that push in slide/depth/scale and moving it to
        // another axis underneath their thumb would veer. Releasing the
        // modifier is different. Continuing scale or depth after the finger
        // comes up makes the stick act like a latched control; stop it until
        // the thumb comes back to centre, then let the next push choose again.
        if (pointer && push < recentre) blockedUntilRecentre.delete(hand);
        const grip = pointer ? gripFor(hand, pointer) : false;
        const trigger = pointer ? ((pointer.buttons | 0) & POINTER_TRIGGER_BIT) !== 0 : false;
        const releasedModifier = pointer && (
          (previous === STICK_MODE.scale && !grip)
          || (previous === STICK_MODE.depthYaw && !trigger)
        );
        if (releasedModifier && push >= recentre) {
          blockedUntilRecentre.add(hand);
          record('xr-stick', { hand, event: 'modifier-released-held', from: previous, mode: STICK_MODE.inert });
        }
        // A mode change under a pushed stick would move the structure along a
        // different axis without the thumb moving: letting the trigger go a
        // beat before centring the thumb turned a depth push into a slide and
        // the structure veered. The mode the push started in is kept until the
        // stick comes back inside `recentre`.
        // Cancellation and two-hand scaling must stop the stick immediately,
        // even when the thumb is still pushed in its previous movement mode.
        let mode = next;
        if (next !== STICK_MODE.inert && blockedUntilRecentre.has(hand)) mode = STICK_MODE.inert;
        else if (next !== STICK_MODE.inert && (!triggerOwned(hand) || previous !== STICK_MODE.inert)
          && previous !== undefined && next !== previous && push >= recentre) mode = previous;
        modes.set(hand, mode);
        // Merely tapping a trigger does not move anything. Only a deliberate
        // stick push under the modifier consumes its eventual residue click.
        if (modes.get(hand) === STICK_MODE.depthYaw && push >= recentre) consumedAt.set(hand, now());
        if (latched.has(hand) && consumedAt.has(hand)) consumedAt.set(hand, now());
      }
    },
    /** @param {string} hand `'left'` or `'right'` */
    mode: hand => modes.get(hand) ?? STICK_MODE.slide,
    /** Whether either hand is holding the trigger modifier, for the caption. */
    engaged: () => latched.size > 0 || [...modes.values()].includes(STICK_MODE.depthYaw),
    /**
     * Whether a trigger modifier owns this press, for the residue pick.
     *
     * Mol* publishes its click on the release, by which time the latch is
     * already gone, so the guard covers a short window after it. A wearer who
     * pushed the structure away meant to move it, not to select the atom the
     * ray happened to cross.
     *
     * @param {number} [ms] how long after the modifier ends the guard holds
     */
    engagedWithin: (ms = pickGuardMs, hand) => hand ? now() - (consumedAt.get(hand) ?? -Infinity) <= ms
      : [...consumedAt.values()].some(at => now() - at <= ms),
    reset() { modes.clear(); latched.clear(); triggerWas.clear(); missingSince.clear(); consumedAt.clear(); blockedUntilRecentre.clear(); },
  };
}

/**
 * The trackball drags a controller must never reach in XR.
 *
 * `xr-manager.js:146-160` rebuilds each controller's buttons as a pointer
 * mask: the trigger arrives as `ButtonsType.Flag.Primary`, the grip as
 * `Secondary`, the stick click as `Auxilary` and the A/X face button as
 * `Forth`. `trackball.js:22-33` binds Primary to `dragRotate`, Secondary to
 * `dragPan`, Forth to `dragFocus` and Auxilary to `dragFocusZoom`, and
 * `canvas3d.js:507` runs `controls.update` on XR frames as well as desktop
 * ones. So every one of this build's held buttons was also dragging the
 * camera, and `dragRotate` orbits it about `camera.target` — an invisible
 * point the placed structure is nowhere near.
 *
 * The symptom is a held trigger swinging the whole scene around an offset,
 * invisible centre. The headset log shows it exactly: an `xr-selectstart` and
 * an `xr-selectend` 8.5 seconds apart with no `xr-stick` and no `xr-grab` in
 * between, so nothing this page owns moved anything for that span.
 * `xr-manager.js:164` also caps a frame's drag at 100 screen pixels, which at
 * 72 Hz is why one held trigger carried the scene across the room.
 *
 * Only pointer drags are cleared. A wheel never reaches a headset, so the
 * scroll bindings are left as found, and the keyboard triggers stay so the
 * desktop `W` and `S` keys still move the camera exactly as they did.
 */
export const XR_CLEARED_CAMERA_DRAGS = Object.freeze([
  'dragRotate', 'dragRotateZ', 'dragPan', 'dragZoom', 'dragFocus', 'dragFocusZoom',
]);

/**
 * Trackball bindings with every gamepad code and controller drag removed.
 *
 * `TrackballControls.setAttribs` assigns the object it is handed over the live
 * attribs, so a partial set would drop every binding it omits from
 * `controls.attribs`; the whole set is returned with the camera-move bindings
 * rebuilt and the camera drags emptied. A set that is already in that shape
 * gives `undefined`, which keeps this callable on every session start.
 * `tuneXrLocomotion` restores the originals when the session ends.
 *
 * @param {object} bindings the live `canvas.attribs.trackball.bindings`
 * @param {object} [empty] `Binding.Empty`; without it the drags are left alone
 */
export function xrLocomotionAttribs(bindings, empty) {
  if (!bindings) return undefined;
  const changed = {};
  for (const name of ['keyMoveForward', 'keyMoveBack', 'keyMoveLeft', 'keyMoveRight', 'keyMoveUp', 'keyMoveDown']) {
    const binding = bindings[name];
    const triggers = binding?.triggers;
    if (!Array.isArray(triggers)) continue;
    const kept = triggers.filter(trigger => !String(trigger?.code ?? '').startsWith('Gamepad'));
    if (kept.length === triggers.length) continue;
    changed[name] = { ...binding, triggers: kept };
  }
  if (empty) {
    for (const name of XR_CLEARED_CAMERA_DRAGS) {
      if (!(name in bindings) || bindings[name] === empty) continue;
      changed[name] = empty;
    }
  }
  return Object.keys(changed).length ? { ...bindings, ...changed } : undefined;
}

/**
 * XR-manager bindings with every stock controller binding cleared.
 *
 * Three separate defaults in `xr-manager.js:38-42` claim buttons this build
 * needs, and two of them are why the A button appears to do nothing.
 *
 * `togglePassthrough` is bound to `GamepadA`, which is the right hand's A
 * button (`input-observer.js:441` emits `GamepadA` for `buttons[4]` on the
 * primary hand) and is now push-to-talk. It is rebound rather than cleared, to
 * `PASSTHROUGH_BINDING` below: the wearer's A press no longer reaches it, and
 * the menu row and the spoken phrases still do.
 *
 * `exit` is bound to `GamepadB`, the right hand's B button, and calls
 * `XRManager.end`. A wearer pressing B was dropped out of VR with no warning,
 * and the IWER run below did exactly that: the session ended three button
 * presses in.
 *
 * `gestureScale` is bound to `Trigger(32)`, and `ButtonsType.Flag.Squeeze` is
 * 48, which carries the trigger bit. `Binding.match` tests `BitFlags.has`, a
 * non-zero intersection rather than a subset, so the binding matched a
 * two-grip squeeze and drove `setScaleFactor` at `xr-manager.js:303` while the
 * grip gesture was scaling the placement. The structure grew by the square of
 * what the wearer asked for: the IWER run measured a 1.669 grip scale arriving
 * with a 1.669 camera scale beside it.
 *
 * Clearing `exit` costs the wearer the controller way out of VR. The headset's
 * own Meta button still leaves, and the toolbar has no exit row to fall back
 * on, which is worth one.
 *
 * @param {object} bindings the live `canvas.attribs.xr.bindings`
 * @param {object} empty `Binding.Empty`
 */
export function xrManagerAttribs(bindings, empty) {
  if (!bindings || !empty) return undefined;
  const names = ['gestureScale', 'exit'];
  const cleared = names.every(name => bindings[name] === empty);
  if (cleared && bindings.togglePassthrough === PASSTHROUGH_BINDING) return undefined;
  return { ...bindings, ...Object.fromEntries(names.map(name => [name, empty])),
    togglePassthrough: PASSTHROUGH_BINDING };
}

/**
 * The key code the passthrough toggle listens for.
 *
 * No controller emits it. `input-observer.js:441` emits `GamepadA` and
 * `GamepadX` for the lower face buttons and `GamepadB`/`GamepadY` for the
 * upper ones, and nothing emits this, so a wearer cannot fire the toggle by
 * pressing a button that now means talk.
 */
export const PASSTHROUGH_KEY = 'StereofoldPassthrough';

/**
 * The `togglePassthrough` binding, rebound rather than cleared.
 *
 * A single button for passthrough is what this build lost and had to get back.
 * The earlier build entered `immersive-ar` and Mol*'s stock `togglePassthrough`
 * on `GamepadA` flipped the transparent clear. Clearing that binding along with
 * `exit` and `gestureScale`, because A had become push-to-talk, took the only
 * route to the toggle with it.
 *
 * Mol* keeps the passthrough flag in a Canvas3D closure variable and writes it
 * over `transparentBackground` on every XR frame (`canvas3d.js:503`), so
 * setting the prop from outside lasts less than one frame. The only way in is
 * the `togglePassthrough` subject, and the only way to that subject is a key
 * event matching this binding (`helper/xr-manager.js:297`). So the binding
 * stays live on a code no hardware sends, and `firePassthroughToggle` sends it.
 *
 * `Binding.matchKey` reads nothing but `triggers`, and a trigger with no
 * `modifiers` matches whatever modifiers arrive, so this plain object is a
 * complete binding without importing Mol*'s constructor into a Node module.
 */
export const PASSTHROUGH_BINDING = Object.freeze({
  triggers: Object.freeze([Object.freeze({ code: PASSTHROUGH_KEY })]),
  description: 'Toggle Stereofold passthrough',
});

/**
 * Ask Mol* to flip the passthrough clear.
 *
 * Only an `alpha-blend` session has anything to flip; Mol* ignores the subject
 * otherwise (`canvas3d.js:406-410`), which is why the caller checks the blend
 * mode itself and offers to leave VR instead.
 *
 * @param {object} input the live `canvas.input`
 * @returns {boolean} whether the event was delivered
 */
export function firePassthroughToggle(input) {
  const subject = input?.keyUp;
  if (typeof subject?.next !== 'function') return false;
  try {
    subject.next({ code: PASSTHROUGH_KEY, key: PASSTHROUGH_KEY,
      modifiers: { shift: false, alt: false, control: false, meta: false }, x: -1, y: -1, pageX: -1, pageY: -1 });
    return true;
  } catch { return false; }
}
