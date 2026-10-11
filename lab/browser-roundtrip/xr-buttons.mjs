// Face buttons and thumbsticks on the Touch controllers.
//
// The face buttons used to do nothing: nothing read them, and nothing read a
// thumbstick except Mol*'s own camera dolly, which is retired in
// `xr-locomotion.mjs`.
//
// A now holds push-to-talk, so that both grips can grab the structure instead
// of one of them opening a microphone.
//
// Both live here because both arrive on the same stream. `XRManager.update`
// publishes one tracked pointer per controller carrying a `buttons` bitmask
// and the raw gamepad `axes`, and `xr-manager.js:146-160` builds that mask
// from the Quest Touch gamepad: `buttons[0]` is the trigger and becomes
// `Primary`, `buttons[1]` the grip and becomes `Secondary`, `buttons[3]` the
// thumbstick press and becomes `Auxilary`, `buttons[4]` (A on the right hand,
// X on the left) becomes `Forth`, and `buttons[5]` (B, Y) becomes `Five`.
// Reading the mask rather than the gamepad keeps this on the same frame Mol*
// drew, and keeps the trigger out of it: nothing here ever tests `Primary`.
//
// Keep this module import-free so the mapping runs under Node.

/** `ButtonsType.Flag.Auxilary`, the thumbstick press. */
export const STICK_PRESS = 4;
/** `ButtonsType.Flag.Forth`: A on the right hand, X on the left. */
export const FACE_LOWER = 8;
/** `ButtonsType.Flag.Five`: B on the right hand, Y on the left. */
export const FACE_UPPER = 16;

/** A press repeated inside this window is a controller bounce, not a press. */
export const BUTTON_DEBOUNCE_MS = 250;
/** The confirmation tick, shorter and lighter than the grab's. */
export const BUTTON_PULSE = Object.freeze({ intensity: 0.45, durationMs: 25 });
/**
 * How long a talk button must be down before the microphone opens.
 *
 * A thumb brushing A on the way to the stick is a tap, and a tap that opened
 * and closed the microphone would post a `down` and an `up` to the Mac and
 * transcribe a few milliseconds of nothing, which comes back as a stray filler
 * word. Below this the press is dropped entirely
 * and only the buzz tells the wearer it was seen. It is short enough that a
 * wearer who means to talk never notices it: the microphone grant is already
 * held from the Enter VR gesture, so nothing else is waiting on the press.
 */
export const TALK_MIN_HOLD_MS = 150;

/**
 * When the "Hold to reset…" caption goes up under a held upper face button.
 *
 * The same 150 ms the talk hold uses, for the same reason: below it a thumb
 * crossing the button is transit, not a press worth captioning.
 */
export const HOLD_HINT_MS = 150;
/** How long an upper face button must be down before the reset fires. */
export const RESET_HOLD_MS = 500;
/**
 * The longest release that still counts as a tap on an upper face button.
 *
 * It was the full 500 ms of the reset hold, so that no press fell between the
 * two actions. That cost more than it bought: a wearer holding for a reset who
 * let go at 400 ms got the menu hidden instead — the one thing they had not
 * asked for, at the moment they were already lost. A press that long is a hold
 * that fell short, and the 250-500 ms band now says so in a caption rather than
 * doing something else. Under 250 ms is a thumb that went down and came back
 * up, which is the menu.
 */
export const TAP_MAX_MS = 250;
/**
 * How close two taps of the same button may be before the second is a bounce.
 *
 * A Touch face button can break contact twice on one thumb release, and the
 * menu toggles: two taps left it where it started with two buzzes to say so.
 * Shorter than `BUTTON_DEBOUNCE_MS` because a tap ends with the thumb already
 * off the button, so a deliberate second tap can follow quickly.
 */
export const TAP_DEBOUNCE_MS = 120;
/**
 * How far a thumbstick may be pushed and still have its click count.
 *
 * A Touch stick clicks off-axis under a deflection, so a wearer sliding the
 * structure sideways can press the stick without meaning to. Above this the
 * click is thumb pressure on a moving stick and is dropped.
 */
export const STICK_CLICK_MAX_DEFLECTION = 0.3;

/**
 * Every bound controller button, identical on both hands.
 *
 * Either controller alone does everything. The split map before this put the
 * menu on B and the reset on Y, so neither hand alone could do both, and a
 * wearer holding the structure in one hand had no way back.
 *
 * Both lower buttons hold push-to-talk. Both upper buttons are tap for the menu
 * and hold for the reset. Both stick clicks are the reset again, which is the
 * one action a lost wearer needs and the one that must never take a search.
 * Talk is deliberately not on the stick click: it would take 4 to 5 N of axial
 * force for the length of a sentence, and a stick deflected while speaking
 * clicks itself.
 *
 * Tour play and repeat-reply are not here. They stay on the menu rows and on
 * voice ("start the tour", "say that again").
 */
export const FACE_BUTTONS = Object.freeze([
  Object.freeze({ hand: 'right', mask: FACE_LOWER, button: 'A', action: 'push-to-talk', hold: true }),
  Object.freeze({ hand: 'left', mask: FACE_LOWER, button: 'X', action: 'push-to-talk', hold: true }),
  Object.freeze({ hand: 'right', mask: FACE_UPPER, button: 'B', action: 'menu', tapHold: true, holdAction: 'recenter-structure' }),
  Object.freeze({ hand: 'left', mask: FACE_UPPER, button: 'Y', action: 'menu', tapHold: true, holdAction: 'recenter-structure' }),
  Object.freeze({ hand: 'right', mask: STICK_PRESS, button: 'stick', action: 'recenter-structure', restingStick: true }),
  Object.freeze({ hand: 'left', mask: STICK_PRESS, button: 'stick', action: 'recenter-structure', restingStick: true }),
]);

/** Below this deflection a Touch thumbstick is resting, not pushed. */
export const STICK_DEAD_ZONE = 0.15;
/**
 * Metres a second the structure travels at full stick deflection.
 *
 * Raised from 1.2 with the second stick. The entry seat stands the structure
 * between 1 m and 4 m away (`ENTRY_STANDOFF_RANGE` in `room-anchor.mjs`), so
 * the useful travel is about 3 m end to end: 2.5 s of held stick at 1.2 m/s,
 * 1.7 s at 1.8. One second of full deflection still moves a 3.6 m structure by
 * half its own width, so the stick cannot fling it past the wearer.
 */
export const STICK_METRES_PER_SECOND = 1.8;
/**
 * Degrees a second the structure yaws at full left-stick deflection.
 *
 * A quarter turn a second: a wearer looking for the other face of a structure
 * gets there in two seconds and can stop on a face without overshooting it.
 */
export const STICK_DEGREES_PER_SECOND = 90;
/** A frame longer than this is a stall; do not integrate travel across it. */
export const STICK_MAX_FRAME_MS = 100;

/**
 * One axis past its dead zone, rescaled so the first millimetre of travel
 * past the edge is the slowest speed rather than an immediate jump.
 */
export function stickAxis(value, deadZone = STICK_DEAD_ZONE) {
  if (!Number.isFinite(value)) return 0;
  const size = Math.min(1, Math.abs(value));
  if (size <= deadZone || deadZone >= 1) return 0;
  return Math.sign(value) * ((size - deadZone) / (1 - deadZone));
}

function handOf(pointers, hand) {
  for (const pointer of pointers ?? []) if (pointer?.handedness === hand) return pointer;
  return undefined;
}

/**
 * How far one hand's thumbstick is pushed, 0 at rest and 1 at the rim.
 *
 * Raw, not dead-zoned: this decides whether a stick click was made on a stick
 * the thumb was also steering, and the dead zone would hide exactly the small
 * deflections that cause an off-axis click.
 */
export function stickDeflection(pointer) {
  const axes = pointer?.axes;
  const x = Number.isFinite(axes?.[2]) ? axes[2] : 0;
  const y = Number.isFinite(axes?.[3]) ? axes[3] : 0;
  return Math.min(1, Math.hypot(x, y));
}

/**
 * Edge-triggered face buttons, and held ones.
 *
 * A plain binding fires once, on the frame the bit goes from clear to set, and
 * never again while the thumb is down. A `hold: true` binding fires twice: once
 * with phase `down`, on the first frame the thumb has been on the button for
 * `TALK_MIN_HOLD_MS`, and once with phase `up` when it comes off. A press
 * released before that never fires at all.
 *
 * `run` is called with the action name, the binding and the phase, and may
 * return a promise; a rejection is recorded rather than thrown, because a
 * failed menu press must not stop the next button from working.
 *
 * Only one hold runs at a time. A and X are both push-to-talk, and a wearer
 * with a thumb on each must not open two microphones: the second is recorded
 * and dropped.
 *
 * A `tapHold: true` binding is the upper face buttons. It fires `action` with
 * phase `tap` when the thumb comes off inside `tapMs`, `holdAction` with phase
 * `hint` once the thumb has been down for `hintMs`, and `holdAction` with phase
 * `hold` once at `holdActionMs`. A release after a hold fires nothing, so the
 * reset cannot also toggle the menu; a release after a hint but inside the tap
 * window fires `holdAction` with phase `abort`, which is how the caption comes
 * down. A release between `tapMs` and `holdActionMs` is a hold that fell short:
 * it fires `holdAction` with phase `short-hold` and nothing else, so a wearer
 * who nearly held long enough for the reset is told to hold longer rather than
 * handed a menu toggle they did not ask for.
 *
 * A `restingStick: true` binding is the stick click. It is dropped when the
 * stick is deflected past `STICK_CLICK_MAX_DEFLECTION`, because a Touch stick
 * clicks off-axis under a push.
 *
 * @param {object} options
 * @param {(action:string, binding:object, phase:string)=>unknown} options.run the action dispatcher
 * @param {(source:object, shape:object)=>unknown} options.pulse haptics
 * @param {(kind:string, detail:object)=>void} options.record diagnostics
 * @param {(hand:string)=>object} options.sourceFor the live input source, for haptics
 */
export function createXrButtons({
  run = () => {},
  pulse = () => {},
  record = () => {},
  sourceFor = () => undefined,
  now = () => (globalThis.performance?.now?.() ?? Date.now()),
  debounceMs = BUTTON_DEBOUNCE_MS,
  holdMs = TALK_MIN_HOLD_MS,
  hintMs = HOLD_HINT_MS,
  holdActionMs = RESET_HOLD_MS,
  tapMs = TAP_MAX_MS,
  tapDebounceMs = TAP_DEBOUNCE_MS,
  maxClickDeflection = STICK_CLICK_MAX_DEFLECTION,
  bindings = FACE_BUTTONS,
} = {}) {
  const held = new Map(), firedAt = new Map(), pressedAt = new Map(), hinted = new Set(), fired = new Set();
  let holdOwner, tapOwner;
  const key = binding => `${binding.hand}:${binding.button}`;

  function dispatch(binding, phase, action = binding.action, detail) {
    const entry = { hand: binding.hand, button: binding.button, action, ...(detail ?? {}) };
    record('xr-button', phase ? { ...entry, phase } : entry);
    let result;
    try { result = run(action, binding, phase); }
    catch (error) { record('xr-button', { ...entry, phase, outcome: 'failed', error: error?.message }); return; }
    if (result && typeof result.catch === 'function') {
      result.catch(error => record('xr-button', { ...entry, phase, outcome: 'failed', error: error?.message }));
    }
  }

  function buzz(hand) {
    try { pulse(sourceFor(hand), BUTTON_PULSE); } catch { /* Haptics never cost a press. */ }
  }

  return {
    /** @param {Array<object>} pointers the tracked pointers for this frame */
    update(pointers, { releaseOnly = false } = {}) {
      for (const binding of bindings) {
        const pointer = handOf(pointers, binding.hand);
        // A controller that is not reporting this frame holds nothing. Clearing
        // the edge means the next frame it returns is a fresh press, not a
        // continuation of one the wearer let go of while tracking was lost, and
        // for a hold it closes the microphone rather than leaving it open.
        const down = pointer ? ((pointer.buttons | 0) & binding.mask) !== 0 : false;
        const name = key(binding);
        const was = held.get(name) === true;
        held.set(name, down);
        if (releaseOnly) {
          // Saving placement may take several frames. Close an already-open
          // microphone on release, but drain other presses without actions.
          pressedAt.delete(name); hinted.delete(name); fired.delete(name);
          if (tapOwner === name) tapOwner = undefined;
          if (!down && holdOwner === name) { holdOwner = undefined; dispatch(binding, 'up'); }
          continue;
        }
        const at = now();

        if (binding.hold) {
          if (down && !was) { pressedAt.set(name, at); continue; }
          if (down) {
            // Arm the microphone once the thumb has stayed on the button.
            if (holdOwner !== undefined || pressedAt.get(name) === undefined) continue;
            if (at - pressedAt.get(name) < holdMs) continue;
            pressedAt.delete(name);
            holdOwner = name;
            buzz(binding.hand);
            dispatch(binding, 'down');
            continue;
          }
          if (holdOwner === name) { holdOwner = undefined; buzz(binding.hand); dispatch(binding, 'up'); continue; }
          if (was && pressedAt.delete(name)) {
            // Short enough to be a brush past the button rather than a hold.
            buzz(binding.hand);
            record('xr-button', { hand: binding.hand, button: binding.button, action: binding.action, outcome: 'tap' });
          }
          continue;
        }

        if (binding.tapHold) {
          if (down && !was) {
            // First thumb wins. B and Y are the same button on two hands, so a
            // wearer with a thumb on each would toggle the menu twice, or reset
            // twice, from one intent.
            if (tapOwner !== undefined && tapOwner !== name) {
              record('xr-button', { hand: binding.hand, button: binding.button, action: binding.action, outcome: 'other-hand' });
              continue;
            }
            tapOwner = name; pressedAt.set(name, at); hinted.delete(name); fired.delete(name); continue;
          }
          if (tapOwner !== undefined && tapOwner !== name) continue;
          const startedAt = pressedAt.get(name);
          if (down) {
            if (startedAt === undefined || fired.has(name)) continue;
            const elapsed = at - startedAt;
            if (elapsed >= holdActionMs) {
              fired.add(name); hinted.delete(name);
              buzz(binding.hand);
              dispatch(binding, 'hold', binding.holdAction);
            } else if (elapsed >= hintMs && !hinted.has(name)) {
              hinted.add(name);
              dispatch(binding, 'hint', binding.holdAction);
            }
            continue;
          }
          if (!was) continue;
          pressedAt.delete(name);
          if (tapOwner === name) tapOwner = undefined;
          // A release after the reset has fired is the wearer letting go of a
          // reset, never a menu tap. This is the whole of "the release after a
          // hold must not toggle the menu".
          if (fired.delete(name)) { hinted.delete(name); continue; }
          // A release past the tap window is a hold that fell short, not a menu
          // press. It used to be both: the abort took the "Hold to reset…"
          // caption down and the same release then toggled the menu, so a
          // wearer who nearly held long enough for a reset had the menu
          // disappear instead. One answer, and it says what to do next.
          if (startedAt !== undefined && at - startedAt >= tapMs) {
            hinted.delete(name);
            record('xr-button', { hand: binding.hand, button: binding.button, action: binding.action, outcome: 'no-tap' });
            if (at - startedAt < holdActionMs) dispatch(binding, 'short-hold', binding.holdAction);
            continue;
          }
          if (hinted.delete(name)) dispatch(binding, 'abort', binding.holdAction);
          if (startedAt === undefined) {
            record('xr-button', { hand: binding.hand, button: binding.button, action: binding.action, outcome: 'no-tap' });
            continue;
          }
          const tapKey = `${name}:tap`;
          if (at - (firedAt.get(tapKey) ?? -Infinity) < tapDebounceMs) {
            record('xr-button', { hand: binding.hand, button: binding.button, action: binding.action, outcome: 'debounced' });
            continue;
          }
          firedAt.set(tapKey, at);
          buzz(binding.hand);
          dispatch(binding, 'tap');
          continue;
        }

        if (!down || was) continue;
        if (binding.restingStick && stickDeflection(pointer) > maxClickDeflection) {
          // The press is still refused: a reset is a jump the wearer cannot
          // undo, and a Touch stick clicks itself under a push. What changed is
          // that the refusal is answered rather than leaving a mark only in the
          // log. `refused` reaches the action so it can say so in the headset;
          // the deflection goes to the log so the threshold can be set from
          // hardware rather than from argument.
          dispatch(binding, 'refused', binding.action,
            { outcome: 'stick-deflected', deflection: Math.round(stickDeflection(pointer) * 100) / 100 });
          continue;
        }
        if (at - (firedAt.get(name) ?? -Infinity) < debounceMs) {
          record('xr-button', { hand: binding.hand, button: binding.button, action: binding.action, outcome: 'debounced' });
          continue;
        }
        firedAt.set(name, at);
        buzz(binding.hand);
        dispatch(binding);
      }
    },
    /** Which hold is open, for the caller's own diagnostics. */
    holding: () => holdOwner,
    /** Drop every edge, so a new session starts with no thumb held. */
    reset() { held.clear(); firedAt.clear(); pressedAt.clear(); hinted.clear(); fired.clear(); holdOwner = undefined; tapOwner = undefined; },
  };
}

/**
 * One thumbstick, moving the structure rather than the camera.
 *
 * The stock Mol* binding moved the camera along its own eye vector by three
 * quarters of a percent a frame, so the scene crawled back and forth along one
 * axis. Both sticks drive the structure instead,
 * and both drive it the same way: a bare stick slides it,
 * a stick under a held trigger pushes and yaws it, a stick under a held grip
 * scales it. Which of the three is `xr-locomotion.mjs`'s answer, not this
 * reader's. All of it is coarse placement; the grab is the fine control.
 *
 * This reader says only how far the stick is pushed and for how long. `onMove`
 * is handed `x` and `y`, dead-zoned deflections between -1 and 1 with `y`
 * positive when the stick is pushed forward, and `seconds`, the frame time
 * capped at `STICK_MAX_FRAME_MS`. The caller turns those into metres or degrees
 * because the two sticks mean different things by the same deflection, and it
 * bakes one placement when `onEnd` runs, which is the frame the stick returns
 * to its dead zone. Multiplying by elapsed time rather than by the frame keeps
 * the travel the same at 30 fps and at 72.
 *
 * @param {object} options
 * @param {(deflection:{x:number, y:number, seconds:number})=>void} options.onMove this frame's push
 * @param {()=>void} options.onEnd called once when the stick returns to rest
 */
export function createXrThumbstick({
  onMove = () => {},
  onEnd = () => {},
  record = () => {},
  now = () => (globalThis.performance?.now?.() ?? Date.now()),
  hand = 'right',
  deadZone = STICK_DEAD_ZONE,
  isClaimed = () => false,
} = {}) {
  let lastAt, moving = false;

  function stop() {
    if (!moving) return;
    moving = false;
    record('xr-stick', { hand, event: 'end' });
    try { onEnd(); } catch (error) { console.error(error); }
  }

  return {
    moving: () => moving,
    update(pointers) {
      const pointer = handOf(pointers, hand);
      const at = now();
      const elapsed = Number.isFinite(lastAt) ? at - lastAt : 0;
      lastAt = at;
      // A grip on this hand is a grab, and the thumb resting on the stick
      // during one must not add travel the wearer did not ask for.
      if (!pointer || isClaimed(hand)) { stop(); return; }
      // The Touch thumbstick is axes 2 and 3 on both hands; axes 0 and 1 are the
      // trackpad slot no Quest controller fills.
      const axes = pointer.axes;
      const x = stickAxis(axes?.[2], deadZone);
      // WebXR reports a stick pushed forward as negative on its second axis.
      const y = -stickAxis(axes?.[3], deadZone);
      if (x === 0 && y === 0) { stop(); return; }
      if (!moving) { moving = true; record('xr-stick', { hand, event: 'start' }); }
      // Do not turn a paused save, hidden tab, or stalled XR frame into one
      // large movement when input resumes. `lastAt` is updated above so later
      // frames resume from this one without carrying the gap forward.
      if (elapsed > STICK_MAX_FRAME_MS) return;
      const seconds = Math.max(0, elapsed) / 1000;
      if (seconds <= 0) return;
      try { onMove({ x, y, seconds }); }
      catch (error) { console.error(error); }
    },
    /** Rebase the time origin across a deferred save without ending the held stick. */
    resetTimer() { lastAt = undefined; },
    reset() { lastAt = undefined; moving = false; },
  };
}

/**
 * Remember the last spoken reply so the menu row and "say that again" can play
 * it again. It left the X button when push-to-talk took both lower buttons.
 *
 * `voiceInteraction.play` is the only path an audible reply takes, so wrapping
 * it captures every reply without the reply producer knowing. The wrapper is a
 * spread of the original, which keeps `Object.freeze` and every other method
 * intact, and it stores at most one reply.
 */
export function rememberSpokenReply(voice) {
  if (!voice || typeof voice.play !== 'function') return voice;
  let last;
  const wrapped = {
    ...voice,
    play(audio, text) { last = { audio, text }; return voice.play(audio, text); },
    lastSpokenReply: () => last,
    repeatLastReply() {
      if (!last) throw Error('Nothing has been said yet.');
      return voice.play(last.audio, last.text);
    },
  };
  return wrapped;
}
