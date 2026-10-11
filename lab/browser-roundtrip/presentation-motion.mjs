// Who is allowed to stop the room-locked presentation spin, and how fast it
// turns.
//
// Two headset findings land here.
//
// 1. Talking is not manipulation. Push-to-talk is a hold of A or X
//    (`push-to-talk-grip.mjs`) and the menu is a tap of B or Y, so both arrive
//    on the same tracked-pointer `buttons` bitmask as a grip grab or a stick
//    slide. `viewer.mjs` treated any pressed button as the wearer taking hold
//    of the structure: it stopped the spin AND reset its transient angle, so a
//    wearer who said "spin it" and then held A to say anything at all watched
//    the structure snap back and sit still. The spin must survive a talk hold
//    and a menu tap. A grab, a stick slide, a trigger press and a stick click
//    still stop it, and reset view stops it through its own explicit
//    `setInspectionMotion({ paused: true })` in `seatStructureForEntry`.
//
// 2. 4 deg/s is a desktop-panel rate. The presentation layer was written for a
//    2D inspector panel where a slow drift reads as alive without being
//    distracting. In the headset the structure is metres across and the wearer
//    asked for it out loud, so the same 4 deg/s (90 s per revolution) reads as
//    broken rather than slow. An immersive session turns at 12 deg/s, one
//    revolution every 30 s, which is a clear turn that is still well under the
//    speed that provokes vection.
//
// Both are headset-side. `setInspectionMotion` still accepts exactly
// `{ paused }`; nothing here widens that contract.
//
// Keep this module import-free apart from the button masks so it runs under
// Node with no DOM and no Mol*.

import { FACE_LOWER, FACE_UPPER } from './xr-buttons.mjs';

/**
 * The face buttons that speak or open the menu rather than move the structure.
 *
 * `FACE_LOWER` is A on the right hand and X on the left: hold to talk.
 * `FACE_UPPER` is B and Y: tap for the menu, hold for reset view.
 */
export const NON_MANIPULATION_BUTTONS = FACE_LOWER | FACE_UPPER;

/** How far a thumbstick must be pushed before it counts as a manipulation. */
export const STICK_DEADZONE = 0.1;

/** The presentation spin on the Mac panel, in degrees per second. */
export const PRESENTATION_DEGREES_PER_SECOND = 4;
/** The presentation spin inside an immersive session, in degrees per second. */
export const IMMERSIVE_DEGREES_PER_SECOND = 12;

/**
 * The pressed buttons on `mask` that mean the wearer is handling the structure.
 *
 * Returns the bitmask with talk and menu cleared, so `0` means "nothing here
 * touches the molecule". The trigger, the grip and the stick click survive.
 */
export function manipulationButtons(mask) {
  return (Number.isFinite(mask) ? mask | 0 : 0) & ~NON_MANIPULATION_BUTTONS;
}

/**
 * Whether one tracked pointer is manipulating the structure this frame.
 *
 * A held talk or menu button alone is not. A deflected stick is, whichever
 * button is down with it, so holding A while sliding still stops the spin.
 */
export function pointerManipulates(pointer) {
  if (!pointer) return false;
  if (manipulationButtons(pointer.buttons) !== 0) return true;
  return Array.isArray(pointer.axes) && pointer.axes.some(value => Math.abs(value) > STICK_DEADZONE);
}

/**
 * The presentation spin rate for the surface it is being watched on.
 *
 * `immersive` is `canvas.xr.isPresenting.value` at the call site.
 */
export function presentationDegreesPerSecond(immersive) {
  return immersive ? IMMERSIVE_DEGREES_PER_SECOND : PRESENTATION_DEGREES_PER_SECOND;
}
