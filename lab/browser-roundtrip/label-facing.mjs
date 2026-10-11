// Import-free. Keep this runnable in Node so the rule that decides whether the
// wearer can read a label can be checked without a GPU or a headset.
//
// Why this exists
// ---------------
// Two separate things decide whether an in-scene label is legible in a Quest:
// which way its quad faces, and how big it subtends at the eye. Both are
// decided by numbers this file owns, and neither was written down before.
//
// Facing
// ------
// Mol* expands every glyph into a quad in `mol-gl/shader/text.vert`, and that
// expansion has two branches:
//
//     if (uHasHeadRotation) {
//         vec3 rotatedOffset = (uInvHeadRotation * vec4(cornerOffset, 0, 0)).xyz;
//         clip += uProjection * vec4(rotatedOffset, 0.0);
//     } else {
//         clip.xy += vec2(uProjection[0][0], uProjection[1][1]) * cornerOffset;
//     }
//
// The `else` branch is the one that is always right for a headset. It adds the
// corner offset in the EYE's own clip space, so the quad is expanded in the
// plane of whichever eye is being drawn, upright with respect to that eye's up
// axis, with a positive 2x2 basis: it cannot come out mirrored, upside down or
// edge-on for any head pose, any structure rotation, or any structure scale.
// The atom position still goes through `aTransform`, so the label stays glued
// to its part; only the glyph expansion is screen-space, which is exactly the
// billboard that was asked for ("always legible facing clear to user").
//
// The `if` branch is the bug. `uInvHeadRotation` is the inverse of the wearer's
// head orientation in the XR REFERENCE space, not in the eye's frame, so it
// rotates a screen-plane vector by an amount that has nothing to do with the
// screen plane. `labelScreenBasis` below reproduces both branches so a test can
// state the consequence in numbers: at 180 degrees of yaw the basis determinant
// is -1 (mirrored text, which is what was reported), at 90
// degrees it is 0 (the quad collapses edge-on), and only at the identity pose
// -- where a desktop emulator starts -- does it agree with the `else` branch.
//
// `head-rotation-lock.mjs` selects the `else` branch by holding
// `camera.headRotation` at zero. Until now that hold belonged to the
// presentation layer, so the molecule's own labels were only ever unmirrored as
// a side effect of the menu existing; `immersive-session.mjs` now takes the
// hold for the whole session.
//
// Size
// ----
// Mol* sizes text in WORLD units, so a label's angular size at the eye falls
// off with distance and rises with the scene-to-room camera scale, and nothing
// in the pipeline holds it constant. The glyph box a character occupies is
// `bHeight = 1 / 1.25` mapping units (mol-geo/geometry/text/text-builder.js:52)
// times the size theme's value times `uSizeFactor` (mol-gl/shader/chunks/
// assign-size.glsl), and the shader then multiplies by `uModelScale`, which is
// `camera.scale` -- the scene-units-per-room-metre factor Mol*'s XR manager
// sets from `sceneRadiusInMeters` (mol-canvas3d/helper/xr-manager.js:203).
//
// So one character's height in room metres is
//
//     EM_PER_SIZE * sizeThemeValue * sizeFactor * cameraScale
//
// and `labelSizeFactor` inverts that for a wanted angular height at a wanted
// distance. Feeding it the seat distance keeps a label the same angular size
// whatever the wearer does to the structure: placement scale and rotation live
// in `aTransform`, which the glyph expansion never touches, and a structure
// pushed away or pulled in re-derives the factor from the new distance.
//
// Meta's guidance for the angular numbers points the same way; the
// short version is that a Quest 2's ~1.2 arcmin-per-pixel lens needs a cap
// height of at least ~20 arcmin to be read at all, that Meta's own comfortable
// working range for text is a character height of about one to one and a half
// degrees, and that UI belongs in the 1-3 m depth band the seat solver already
// places the structure in.

/** `bHeight` in `mol-geo/geometry/text/text-builder.js:52`: one em, in mapping units. */
export const MOLSTAR_TEXT_EM_PER_SIZE = 1 / 1.25;

/**
 * Cap height as a fraction of the em box, for the sans-serif atlas Mol* builds
 * its font from. Used only to report a cap height; the sizing rule itself is
 * stated in whole characters, which is what a reader actually resolves.
 */
export const CAP_HEIGHT_PER_EM = 0.72;

/**
 * The angular height of one character, in degrees, that a headset label is
 * aimed at.
 *
 * `floor` is Meta's legibility limit restated in whole characters: a cap
 * height of 20 arcmin (1/3 of a degree) divided by the cap fraction of the em
 * box, so that a label drawn AT the floor still clears the 20 arcmin minimum
 * on its cap height rather than on the box around it. Nothing drawn here
 * is allowed below it whatever the arithmetic says. `min` and `max` bound the
 * comfortable band, and `comfortable` is what a label gets when no one asks
 * for anything else.
 */
export const LABEL_CHARACTER_DEGREES = Object.freeze({
  floor: (1 / 3) / CAP_HEIGHT_PER_EM,
  min: 1,
  comfortable: 1.5,
  max: 3,
});

/**
 * The distance band the seat solver keeps the structure in, in metres, and the
 * distance a label is sized for when no seat has been measured yet.
 *
 * Meta puts comfortable UI between 1 m and 3 m; a label nearer than a metre is
 * a vergence problem rather than a legibility one, and one further than three
 * metres is being read across a room.
 */
export const LABEL_DISTANCE_BAND = Object.freeze({ min: 1, max: 3, fallback: 1.5 });

/**
 * The component plate stand-off at authored placement scale 1, in Angstroms.
 * Mol* applies `offsetZ` before the structure's placement, so the authored
 * stand-off must grow with an enlarged cartoon to stay outside its fold.
 */
export const COMPONENT_LABEL_BASE_OFFSET_Z = 50;

/**
 * The same stand-off for a plate on the desktop panel, at placement scale 1.
 *
 * A flat panel is looked at from one eye's worth of distance with no vergence
 * to fight, so the plate needs to clear the fold rather than float clear of it
 * -- an XR-sized push on a desktop canvas reads as a name detached from the
 * thing it names. What it must NOT do is stay fixed: this was hard-coded at 4
 * while only the XR branch scaled, so a desktop wearer at placement scale 2.4
 * had every plate buried inside the cartoon it was naming.
 */
export const DESKTOP_COMPONENT_LABEL_BASE_OFFSET_Z = 4;

/**
 * The hardware calibration of the angular model, as a curve rather than a
 * constant.
 *
 * The angular rule under-sizes on a Quest 2, so the factor it returns is
 * multiplied by a gain. That gain was a single number, and a single number
 * cannot be right for this lesson: run 13 at 2.7 was judged ideal in the
 * `site` chapter (placement scale 2.4) and put ten plates over each other in
 * the wide chapter (scale 1); run 14 at 1.3 read wide and went small and
 * partly buried up close. The two readings are not in conflict — they are two
 * points on a line the constant could not follow.
 *
 * `scale`/`gain` is the measured point: 2.7 at placement scale 2.4. The
 * `exponent` of one half splits the difference between the two rules that
 * bracket the problem — hold the plate at a fixed angular size whatever the
 * subject does (exponent 0, which reads small beside an enlarged cartoon), and
 * grow it with the subject (exponent 1, which swamps the wide view). A plate
 * that grows as the square root of the placement therefore keeps its share of
 * the subject roughly constant while its angular size still rises. Through the
 * measured point that puts the wide resting view at 1.74, which is the "around
 * 1.8" the handoff guessed at from the same captures.
 *
 * `min` is the gain that was already known to read in the wide view, so no
 * chapter is ever drawn below it; `max` is Meta's comfortable ceiling restated
 * as a gain on the comfortable character height.
 */
export const COMPONENT_LABEL_GAIN = Object.freeze({
  scale: 2.4,
  gain: 2.7,
  exponent: 0.5,
  min: 1.3,
  max: 3,
});

const DEGREES = Math.PI / 180;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/**
 * Component-label stand-off for the current placement scale.
 * Missing or invalid scale is the legacy scale-one case.
 *
 * @param {number|null|undefined} placementScale
 * @param {number} [base] the stand-off at scale 1; the desktop panel has its own
 * @returns {number} Angstroms to pass as Mol*'s label `offsetZ`
 */
export function componentLabelOffsetZ(placementScale, base = COMPONENT_LABEL_BASE_OFFSET_Z) {
  const scale = finite(placementScale) && placementScale > 0 ? placementScale : 1;
  const standoff = finite(base) && base > 0 ? base : COMPONENT_LABEL_BASE_OFFSET_Z;
  return standoff * scale;
}

/**
 * The distance a label should be sized for, clamped into the comfortable band.
 *
 * A seat is measured in `placementFromRoom`, which reports the stand-off it
 * used. An unmeasured seat -- no tracking yet, or a desktop canvas -- gets the
 * middle of the band rather than a refusal, because a label of a plausible size
 * is worth more than no label.
 *
 * @param {number|null|undefined} standoffMeters the seat stand-off, if measured
 * @returns {number} metres
 */
export function labelDistanceMeters(standoffMeters) {
  if (!finite(standoffMeters) || standoffMeters <= 0) return LABEL_DISTANCE_BAND.fallback;
  return clamp(standoffMeters, LABEL_DISTANCE_BAND.min, LABEL_DISTANCE_BAND.max);
}

/**
 * The `sizeFactor` that draws one character at a wanted angular height.
 *
 * @param {object} options
 * @param {number} options.distanceMeters how far the label is from the eye
 * @param {number} options.cameraScale Mol*'s `camera.scale`, scene units per room metre
 * @param {number} [options.sizeThemeValue] the size theme's value; 1 for the uniform theme set here
 * @param {number} [options.characterDegrees] wanted character height, in degrees
 * @returns {number} the `sizeFactor` to hand Mol*, never below the legibility floor
 */
export function labelSizeFactor({ distanceMeters, cameraScale,
  sizeThemeValue = 1, characterDegrees = LABEL_CHARACTER_DEGREES.comfortable } = {}) {
  if (!finite(cameraScale) || cameraScale <= 0) throw Error('A positive camera scale is required to size a label.');
  if (!finite(sizeThemeValue) || sizeThemeValue <= 0) throw Error('A positive size theme value is required to size a label.');
  const distance = labelDistanceMeters(distanceMeters);
  const wanted = clamp(finite(characterDegrees) ? characterDegrees : LABEL_CHARACTER_DEGREES.comfortable,
    LABEL_CHARACTER_DEGREES.floor, LABEL_CHARACTER_DEGREES.max);
  const factorFor = degrees => (2 * distance * Math.tan(degrees * DEGREES / 2))
    / (MOLSTAR_TEXT_EM_PER_SIZE * sizeThemeValue * cameraScale);
  // The floor is applied to the FACTOR rather than to the requested angle, so
  // a caller who asks for something unreadable gets a readable label instead of
  // a silently rounded request.
  return Math.max(factorFor(wanted), factorFor(LABEL_CHARACTER_DEGREES.floor));
}

/**
 * What `labelSizeFactor` actually bought, in degrees: the inverse, for tests
 * and for the diagnostics a headset session records about its own labels.
 *
 * @returns {{character:number, cap:number}} degrees of character box and of cap height
 */
export function labelCharacterDegrees({ sizeFactor, cameraScale, distanceMeters, sizeThemeValue = 1 } = {}) {
  if (!finite(sizeFactor) || !finite(cameraScale) || cameraScale <= 0) throw Error('A label angle needs a size factor and a positive camera scale.');
  const distance = labelDistanceMeters(distanceMeters);
  const metres = MOLSTAR_TEXT_EM_PER_SIZE * sizeThemeValue * sizeFactor * cameraScale;
  const character = 2 * Math.atan(metres / (2 * distance)) / DEGREES;
  return { character, cap: 2 * Math.atan(metres * CAP_HEIGHT_PER_EM / (2 * distance)) / DEGREES };
}

/** Whether a label drawn at this factor clears Meta's legibility floor. */
export function labelIsLegible({ sizeFactor, cameraScale, distanceMeters, sizeThemeValue = 1 } = {}) {
  return labelCharacterDegrees({ sizeFactor, cameraScale, distanceMeters, sizeThemeValue })
    .character >= LABEL_CHARACTER_DEGREES.floor - 1e-9;
}

const isZeroMatrix = matrix => {
  for (let index = 0; index < 16; index++) if (matrix[index] !== 0) return false;
  return true;
};

/**
 * The 2x2 basis `text.vert` expands a glyph quad with, for one head pose.
 *
 * This is the shader's two branches written out in Node, which is the only way
 * to assert in a test what the wearer will see. `headRotation` is Mol*'s
 * `camera.headRotation` in column-major order: zero, absent, or held at zero by
 * `head-rotation-lock.mjs` selects the screen-space branch, and anything else
 * selects the branch that mirrors.
 *
 * `right` and `up` are where the quad's own +x and +y corner directions land in
 * the eye's screen plane. Legible text needs `determinant > 0` (not mirrored)
 * and `up` pointing up the screen.
 *
 * @param {object} [options]
 * @param {ArrayLike<number>|null} [options.headRotation] Mol*'s `camera.headRotation`
 * @returns {{right:number[], up:number[], determinant:number, mirrored:boolean,
 *   degenerate:boolean, upright:boolean, branch:'screen'|'head-rotation'}}
 */
export function labelScreenBasis({ headRotation = null } = {}) {
  const screen = {
    right: [1, 0], up: [0, 1], determinant: 1,
    mirrored: false, degenerate: false, upright: true, branch: 'screen',
  };
  if (!headRotation || headRotation.length !== 16) return screen;
  const rotation = Array.from(headRotation, Number);
  if (rotation.some(value => !Number.isFinite(value)) || isZeroMatrix(rotation)) return screen;
  // `uInvHeadRotation` is the inverse of a rotation, which for a rotation is its
  // transpose. The quad's +x and +y corner directions are the eye-plane basis
  // vectors, so their images are the first two COLUMNS of that transpose, which
  // are the first two ROWS of `headRotation`.
  const right = [rotation[0], rotation[4]];
  const up = [rotation[1], rotation[5]];
  const determinant = right[0] * up[1] - up[0] * right[1];
  return {
    right, up, determinant,
    mirrored: determinant < 0,
    degenerate: Math.abs(determinant) < 1e-6,
    upright: up[1] > 0,
    branch: 'head-rotation',
  };
}

const validPair = value => value != null && value.length >= 2
  && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]));
const finitePair = (value, fallback) => (validPair(value)
  ? [Number(value[0]), Number(value[1])] : [...fallback]);

/**
 * The negative-determinant guard: repair a label basis that would draw
 * mirrored, before anything is allowed to draw with it.
 *
 * A basis with a negative determinant turns every glyph backwards: the text
 * is still in the right place, in the right order, at the right size, and
 * unreadable. That is exactly what `labelScreenBasis` reports for the
 * unlocked head-rotation branch at 180 degrees of yaw, and what any
 * subject-side placement with a reflection in it (a mirrored author matrix,
 * a negative scale) would hand a JavaScript-side quad. The session hold in
 * `head-rotation-lock.mjs` keeps the shader on the screen-space branch so no
 * per-frame basis reaches the GPU at all; this is the check any basis passes
 * through on the way there.
 *
 * The repair mirrors the basis back: it negates `right`, which flips the
 * determinant positive while leaving `up` — and therefore uprightness —
 * exactly as it was. It never rotates, which would move the label's anchor.
 * A degenerate or non-finite input cannot be repaired, so it comes back as
 * the screen identity instead of as a collapsed quad.
 *
 * @param {object} [options]
 * @param {ArrayLike<number>} [options.right] where the quad's +x lands in the eye plane
 * @param {ArrayLike<number>} [options.up] where the quad's +y lands in the eye plane
 * @returns {{right:number[], up:number[], determinant:number, mirrored:boolean,
 *   degenerate:boolean, upright:boolean, corrected:boolean}}
 */
export function correctLabelBasis({ right = [1, 0], up = [0, 1] } = {}) {
  let rightV = finitePair(right, [1, 0]);
  let upV = finitePair(up, [0, 1]);
  let determinant = rightV[0] * upV[1] - upV[0] * rightV[1];
  // A substituted axis is already a correction: the output no longer matches
  // the input, so it must say so even when the substitute is itself clean.
  let corrected = !validPair(right) || !validPair(up);
  if (!Number.isFinite(determinant) || Math.abs(determinant) <= 1e-6) {
    rightV = [1, 0];
    upV = [0, 1];
    determinant = 1;
    corrected = true;
  } else if (determinant < 0) {
    rightV = [-rightV[0], -rightV[1]];
    determinant = -determinant;
    corrected = true;
  }
  // Negating a basis can mint negative zero, which is a fine number and a
  // failed deep-equal; normalise it away before handing the basis on.
  const clean = value => (value === 0 ? 0 : value);
  return {
    right: rightV.map(clean), up: upV.map(clean), determinant: clean(determinant),
    mirrored: false, degenerate: false, upright: upV[1] > 0, corrected,
  };
}

/**
 * The hardware gain for a chapter at this placement scale.
 *
 * And for the seat it is actually being read at.
 *
 * Every number in `COMPONENT_LABEL_GAIN` was measured while the model was
 * being handed `LABEL_DISTANCE_BAND.fallback` and the structure was standing
 * somewhere else entirely — "the seat standoff the model is given is not the
 * distance the immersive placement actually puts the structure at", which is
 * what the gain was written to paper over. A session that never found a floor
 * never seated the structure, so that was every session, and the assumption
 * held.
 *
 * It does not hold now that a floorless session settles too: the seat reports
 * its own stand-off, the angular model is fed the real distance, and it sizes
 * the plate correctly on its own. Applying the whole measured shortfall on top
 * of that charges for the same correction twice — 2.47 at the
 * telomerase seat, which is 3.7 degrees of character box against a ceiling of
 * three, and a name plate wider than the structure it is naming.
 *
 * So the part of the gain that stood in for the distance comes off in
 * proportion to how far the measured seat is past the one the calibration
 * assumed. At the calibration distance it is the measured gain exactly.
 *
 * @param {number|null|undefined} placementScale the chapter's authored placement scale
 * @param {object} [options]
 * @param {number|null} [options.measuredMeters] the seat stand-off, when one has been solved
 * @returns {number} the multiplier to apply to `labelSizeFactor`
 */
export function componentLabelHardwareGain(placementScale, { measuredMeters = null } = {}) {
  const scale = finite(placementScale) && placementScale > 0 ? placementScale : 1;
  const raw = COMPONENT_LABEL_GAIN.gain
    * Math.pow(scale / COMPONENT_LABEL_GAIN.scale, COMPONENT_LABEL_GAIN.exponent);
  const measured = finite(measuredMeters) && measuredMeters > 0
    ? labelDistanceMeters(measuredMeters) : null;
  const known = measured === null ? 1 : LABEL_DISTANCE_BAND.fallback / measured;
  return clamp(raw * known, COMPONENT_LABEL_GAIN.min, COMPONENT_LABEL_GAIN.max);
}

/**
 * How far a secondary plate may shrink when it has to yield to the plate of
 * the part being explained: down to the size the wide view already read at,
 * and no further.
 *
 * Expressed as a fraction of the plate size this chapter draws at, because
 * that is what a layout solver scales; at the wide view's own gain it is the
 * gain itself, so a wide-view plate barely shrinks at all.
 *
 * @param {number} gain the gain this chapter is drawing at
 * @returns {number} the smallest size scale a yielding plate may take
 */
export function componentLabelMinimumSizeScale(gain) {
  if (!finite(gain) || gain <= 0) return 1;
  return Math.min(1, COMPONENT_LABEL_GAIN.min / gain);
}

/**
 * The height of one character box in SCENE units, which is the unit Mol*'s
 * `offsetX`/`offsetY` plate offsets are expressed in.
 *
 * `text.vert` expands a glyph with `cornerOffset = aMapping * size * scale`
 * and then adds `uOffsetX * scale` to that same vector, so a plate offset and
 * a glyph share one unit: the em box times the size factor, before the
 * scene-to-room `uModelScale`. Stating it here keeps the layout solver from
 * re-deriving Mol*'s own arithmetic.
 *
 * @param {object} options
 * @param {number} options.sizeFactor the factor handed to Mol*
 * @param {number} [options.sizeThemeValue] the size theme's value
 * @returns {number} scene units per character box
 */
export function labelCharacterUnits({ sizeFactor, sizeThemeValue = 1 } = {}) {
  if (!finite(sizeFactor) || sizeFactor <= 0) throw Error('A character box needs a positive size factor.');
  return MOLSTAR_TEXT_EM_PER_SIZE * sizeThemeValue * sizeFactor;
}
