/**
 * Where the structure went, in the wearer's own words.
 *
 * A row-by-row walk of the spatial menu on a Quest 2: pressing `Above us`
 * moves the structure
 * three metres over the wearer's head, out of the forward view, and the caption
 * plate says nothing at all. A wearer who pressed that row by mistake is left
 * standing in an empty room with a menu, and nothing anywhere tells them to
 * look up. `In reach`, `Fit` and `Reset` are the same silence; they only get
 * away with it because the pose each of them produces happens to leave the
 * structure somewhere the wearer was already looking.
 *
 * The plate describes the rendered placement relative to the wearer. A
 * completed Fit receipt breaks a tie when that placement also matches entry;
 * it cannot override an overhead, behind, or overlapping measurement. This is a
 * function of the placement that came back from the render, the head pose the
 * frame loop last sampled, and the menu glass already standing in the room.
 *
 * Two consequences of that, both deliberate:
 *
 *  1. A reading that cannot be taken produces NO sentence. An untracked head,
 *     a missing camera scale or an unloaded structure all return `undefined`,
 *     and the plate simply keeps the rows it had. A guessed direction is worse
 *     than no direction: it sends the wearer's head the wrong way.
 *  2. `Back at the start` is the only sentence that is about history rather
 *     than geometry, and it is still measured — against `startRoomPoint`, the
 *     room point the entry seat committed at when this session settled. A
 *     wearer who has since walked across the room gets the plain positional
 *     sentence instead, because from where they now stand the structure is not
 *     back at anything.
 *
 * Runs in Node without a Mol* bundle, like the other placement modules, so the
 * four sentences can be held by `node --test` against poses rather than against
 * the labels that produced them.
 */

import { applyMatrix4, invertMatrix4 } from './room-lock.mjs';
import { toolbarSeatBasis } from './spatial-toolbar-geometry.mjs';
import { TRACKED_AXIS_MINIMUM } from './wearer-axes.mjs';

/**
 * How far above the eye line the structure's centre must sit before the plate
 * sends the wearer's head up.
 *
 * The entry seat rides six degrees above the eye line
 * (`room-anchor.mjs ENTRY_ELEVATION_DEGREES`) and is emphatically not an
 * overhead placement: a wearer looking straight ahead sees all of it. The
 * `overhead` target puts the centre three metres above the head, or a floor
 * lock's `2.2 m + half the width`, both of which read well past sixty degrees
 * from any standing pose. Thirty degrees is clear of the first and nowhere
 * near the second, so neither is a near miss.
 */
export const PLACEMENT_OVERHEAD_DEGREES = 30;

/**
 * How far round the wearer the structure must be before the plate tells them
 * to turn rather than to look.
 *
 * A hundred and twenty degrees is past the shoulder: nothing of the structure
 * is in the lens, and a sentence that says "to your right" would have the
 * wearer sweep their eyes over empty room and conclude the press did nothing.
 */
export const PLACEMENT_BEHIND_DEGREES = 120;

/**
 * Within this bearing of straight ahead, the structure is simply in front, and
 * the plate says so rather than relating it to the menu.
 *
 * Twelve degrees distinguishes the gaze from a structure placed beside the
 * menu. The recorded entry point takes priority when Reset restores it.
 */
export const PLACEMENT_AHEAD_DEGREES = 12;

/**
 * Arm's length, near surface to eye, in metres.
 *
 * The `front` target stands the structure two metres out at 1.6 m across, so
 * its near surface is 1.2 m from the head — the wearer can put a hand on it.
 * The bound is a little past that so a structure sized by the device budget
 * rather than by the target still reads as reachable when it is.
 */
export const PLACEMENT_REACH_METERS = 1.4;

/**
 * The air a structure must leave beside the menu before the plate says it is
 * clear of it, in degrees of bearing.
 *
 * `reset-view-placement.mjs` slides the structure sideways until its sphere
 * clears every plate in BOTH EYES with one degree of tangent to spare. This is
 * the same judgement read back off the finished pose, and it uses the same one
 * degree: a larger margin would make the plate go quiet after exactly the row
 * whose whole job is to produce this arrangement — the harness Fit
 * clears the glass by 1.85 degrees of bearing, so three degrees said nothing.
 *
 * The reading is taken from the head centre rather than from each eye, so it
 * differs from the solver by the interpupillary parallax — under a degree at
 * any distance a structure is seated at. A placement that grazes clear can
 * therefore read as merely "in front of you", which is still true; one that is
 * overlapping the glass can never read as clear of it.
 */
export const PLACEMENT_MENU_CLEARANCE_DEGREES = 1;

/**
 * How near the entry seat's room point the structure must be to count as back
 * where the session started, in metres.
 *
 * A quarter of a metre is inside the wearer's own body sway over a session and
 * far under the smallest distance any two of these rows put between their
 * placements.
 */
export const PLACEMENT_START_METERS = 0.25;

const finite = value => typeof value === 'number' && Number.isFinite(value);
const finite3 = value => Array.isArray(value) && value.length === 3 && value.every(finite);
const matrix16 = value => value?.length === 16 && Array.from(value).every(finite);

/**
 * Whether this viewer-pose matrix came from a head the runtime was tracking.
 *
 * A lost pose is all zeros (`wearer-axes.mjs`, and Mol*'s own camera fallback),
 * which is finite, invertible and completely meaningless: its forward axis
 * collapses to the room's, so every sentence would be measured against a
 * direction the wearer is not facing. `TRACKED_AXIS_MINIMUM` is the same half-
 * unit threshold `wearerAxesFrom` uses, so the two modules agree about when a
 * head has stopped answering.
 */
const trackedHead = matrix => matrix16(matrix)
  && Math.hypot(matrix[0], matrix[1], matrix[2]) >= TRACKED_AXIS_MINIMUM
  && Math.hypot(matrix[8], matrix[9], matrix[10]) >= TRACKED_AXIS_MINIMUM;
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const degrees = radians => radians * 180 / Math.PI;

/**
 * The bearing and elevation of one room point, seen from the wearer.
 *
 * `basis` is the levelled seat basis the toolbar and the Fit slide both use
 * (`toolbarSeatBasis`), so a bearing computed here is the same number
 * `reset-view-placement.mjs` shifted against. Bearing is signed: positive is
 * the wearer's right.
 */
function bearingOf(basis, point) {
  const relative = point.map((value, axis) => value - basis.origin[axis]);
  const ahead = dot(relative, basis.forward);
  const across = dot(relative, basis.right);
  const rise = dot(relative, basis.up);
  const level = Math.hypot(ahead, across);
  return { bearing: degrees(Math.atan2(across, ahead)), elevation: degrees(Math.atan2(rise, level)),
    distance: Math.hypot(level, rise) };
}

/**
 * Where the placement the render committed put the structure, relative to the
 * wearer, in room metres and degrees.
 *
 * `translation` and `scale` are the placement as `inspection-state.mjs` stores
 * it: the translation is in molecular radii from the structure's own centre,
 * which is why `center`, `radius`, `cameraScale` and `renderFromRoom` all have
 * to come with it. The conversion is the one `reset-view-placement.mjs` uses
 * for the same purpose, in the same order, so the two agree about where a
 * placement landed.
 *
 * `menuPoints` are the drawn toolbar glass corners in room metres
 * (`immersive-session.mjs platePoints`). With none, the reading carries no menu
 * span and the sentence never mentions the menu.
 *
 * Returns `undefined` when any input needed for the reading is missing or
 * unusable. The caller draws nothing in that case.
 */
export function wearerPlacementReading({ translation, scale, center, radius, cameraScale,
  renderFromRoom, headInRoom, menuPoints = [], startRoomPoint = null } = {}) {
  if (!finite3(translation) || !finite(scale) || scale <= 0 || !finite(radius) || radius <= 0
    || !finite(cameraScale) || cameraScale <= 0 || !matrix16(renderFromRoom) || !trackedHead(headInRoom)) return undefined;
  const middle = center?.length === 3 ? Array.from(center) : null;
  if (!finite3(middle)) return undefined;
  const roomFromRender = invertMatrix4(renderFromRoom);
  if (!roomFromRender) return undefined;
  const roomPoint = applyMatrix4(middle.map((value, axis) => (value + translation[axis] * radius) * cameraScale), roomFromRender);
  if (!finite3(roomPoint)) return undefined;
  const basis = toolbarSeatBasis({ matrix: Array.from(headInRoom),
    position: { x: headInRoom[12], y: headInRoom[13], z: headInRoom[14] } });
  if (!basis) return undefined;
  const { bearing, elevation, distance } = bearingOf(basis, roomPoint);
  // The sphere the wearer sees, in room metres. `scale` is applied to the
  // camera-scaled molecular radius exactly as `placementTransform` applies it.
  const roomRadius = radius * cameraScale * scale;
  const level = Math.max(distance, 1e-6);
  // Half the angle the structure subtends from here. A sphere the wearer is
  // inside has no meaningful half-angle; it is clamped to a right angle so a
  // near-enclosing placement reads as covering everything rather than as NaN.
  const halfAngle = roomRadius >= level ? 90 : degrees(Math.asin(roomRadius / level));
  const spans = menuPoints.filter(finite3).map(point => bearingOf(basis, point).bearing);
  const menuSpan = spans.length ? [Math.min(...spans), Math.max(...spans)] : null;
  const clearsMenuRight = menuSpan !== null && bearing - halfAngle >= menuSpan[1] + PLACEMENT_MENU_CLEARANCE_DEGREES;
  const clearsMenuLeft = menuSpan !== null && bearing + halfAngle <= menuSpan[0] - PLACEMENT_MENU_CLEARANCE_DEGREES;
  const start = finite3(startRoomPoint) ? Array.from(startRoomPoint) : null;
  return Object.freeze({
    roomPoint, bearingDegrees: bearing, elevationDegrees: elevation, distanceMeters: distance,
    roomRadiusMeters: roomRadius, halfAngleDegrees: halfAngle,
    // Near surface to eye. Negative means the wearer is inside the sphere.
    reachMeters: distance - roomRadius,
    menuSpanDegrees: menuSpan, clearsMenuRight, clearsMenuLeft,
    atStart: start !== null
      && Math.hypot(...roomPoint.map((value, axis) => value - start[axis])) <= PLACEMENT_START_METERS,
  });
}

/**
 * The one line the caption plate draws for a finished placement.
 *
 * The order of these tests is the order the wearer needs them in, not the
 * order the rows sit in on the menu:
 *
 *  1. Back where the session started, and in front, is the most useful thing
 *     that can be said: nothing has to be found.
 *  2. Overhead comes next, because a structure the wearer cannot see is the
 *     defect this line exists for, and "look up" is the whole instruction.
 *  3. Behind, for the same reason, with the other instruction.
 *  4. In front, near or far — the gaze, not the whole forward view. A
 *     structure the wearer is already looking at needs no further directions.
 *  5. Beside the menu. This is the Fit pose read back: the size kept and the
 *     structure slid sideways until it clears the glass. It comes after "in
 *     front" because a RESET structure is also clear of the menu — the centred
 *     entry seat can be clear of the menu too.
 *  6. Off to one side, when there is no menu reading to relate it to.
 */
export function placementSentence(reading, reason) {
  if (!reading) return undefined;
  const { bearingDegrees, elevationDegrees, reachMeters, atStart, clearsMenuLeft, clearsMenuRight } = reading;
  const ahead = Math.abs(bearingDegrees) < PLACEMENT_AHEAD_DEGREES;
  if (atStart && Math.abs(bearingDegrees) < 90 && elevationDegrees < PLACEMENT_OVERHEAD_DEGREES) {
    if (reason === 'fit' && clearsMenuRight) return 'Fitted to the right of the menu';
    if (reason === 'fit' && clearsMenuLeft) return 'Fitted to the left of the menu';
    return 'Back at the start';
  }
  if (elevationDegrees >= PLACEMENT_OVERHEAD_DEGREES) return 'Above you · look up';
  if (Math.abs(bearingDegrees) >= PLACEMENT_BEHIND_DEGREES) return 'Behind you · turn around';
  if (ahead) {
    return reachMeters <= PLACEMENT_REACH_METERS ? 'In front of you, within reach' : 'In front of you, a step away';
  }
  if (clearsMenuRight) return 'Fitted to the right of the menu';
  if (clearsMenuLeft) return 'Fitted to the left of the menu';
  return bearingDegrees > 0 ? 'To your right' : 'To your left';
}

/**
 * The whole reading, in one call, for a caller that has the pose to hand.
 *
 * Returns `undefined` when nothing can be said, which is the value the viewer
 * stores: a note that is `undefined` draws no line and clears any line the
 * previous placement left.
 */
export function placementNoteFor(input) {
  const reading = wearerPlacementReading(input);
  const text = placementSentence(reading, input?.reason);
  return text ? Object.freeze({ text, reading }) : undefined;
}

/**
 * The caption rows a stored note contributes, above the structure readout.
 *
 * Keep the whole placement sentence. The geometry measures its glyphs and
 * uses the compact form or wraps it before allocating the structure rows.
 */
export function placementPlateLines(note) {
  const text = typeof note === 'string' ? note : note?.text;
  if (typeof text !== 'string' || !text.trim()) return [];
  const compactText = text.replace('Fitted to the right of the menu', 'Fitted right of the menu')
    .replace('Fitted to the left of the menu', 'Fitted left of the menu');
  return [{ text, compactText, maxLines: 2, whole: true }];
}
