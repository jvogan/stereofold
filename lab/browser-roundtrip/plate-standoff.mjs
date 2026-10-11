import { SUBJECT_CENTRE_LENS } from './placement-fit-envelope.mjs';
export { SUBJECT_CENTRE_LENS } from './placement-fit-envelope.mjs';
/**
 * The structure must never pierce the caption or the menu.
 *
 * The plates are UI. They have to read, in every chapter, from wherever the
 * wearer's head is. Without these rules they do not: a blue ribbon comes
 * through the caption card, and a grey ghost protofilament is drawn across
 * Play, Next and Menu. Both are the same defect. Canvas3D draws the
 * presentation layer AFTER the molecular scene but WITH the molecular depth
 * attached, so a plate is occluded wherever a molecular fragment is nearer to
 * the eye than the plate is — and a lesson framing put the structure nearer
 * than the plates in every chapter of the wall tier.
 *
 * Two rules fix it, and this module is both of them:
 *
 *  1. STANDOFF. A framing may not leave any part of the placed assembly nearer
 *     to the eye than the nearest plate plus `PLATE_STANDOFF_METRES`. The
 *     framing keeps the angle it asked for and moves the structure back and
 *     scales it up together, so the subject's angular size is unchanged.
 *  2. WHOLE-ASSEMBLY FIT. The fit is measured on the whole assembly — the lit
 *     subject AND the faded ghost around it — not on the lit part alone. The
 *     ghost can span 82 per cent of the lens when only the lit protofilament
 *     is fitted.
 *
 * Everything here is pure and import-light on purpose: it is the one place the
 * numbers live, and `node --test` runs it without a browser.
 *
 * Angles are carried as the TANGENT of their half-angle, which is what relates
 * a radius to a distance and what a pixel share of the lens is proportional to.
 */
import { EYE_TAN_HALF_HORIZONTAL, EYE_TAN_HALF_VERTICAL } from './spatial-toolbar-geometry.mjs';

/**
 * The clear air the nearest plate keeps in front of the structure, in metres.
 *
 * ONE constant, picked from the measured geometry rather than from taste. The
 * plates sit in a 0.90-1.05 m band from the eye: the talk caption at
 * `CAPTION_FORWARD_METERS` = 0.90 m, the menu at a 0.95 m seat whose caption
 * block rides up to about 1.05 m of range. An unconstrained microtubule wall
 * tour puts the structure's nearest point at 0.42-0.63 m, which is
 * 0.3-0.5 m INSIDE the plates. A
 * quarter of a metre is the smallest margin that both survives the bounding
 * sphere being a loose fit around a ribbon and stays inside a Quest 2's
 * comfortable convergence range once the structure is pushed back: it puts the
 * nearest molecular surface at 1.15 m and the subject's centre near 2-3 m.
 */
export const PLATE_STANDOFF_METRES = 0.25;

/**
 * The plate range assumed when no panel is seated to measure.
 *
 * The menu can be hidden and the talk caption is transient, so a framing can
 * legitimately happen with no plate on screen. The wearer may raise either one
 * in the next second without the structure moving, so the rule holds the
 * nearest seat either of them can take rather than giving the structure the
 * room a hidden menu leaves behind.
 */
export const PLATE_NEAR_FALLBACK_METRES = 0.90;
/**
 * Room band a plate near-range must fall in, in metres. A number outside it is
 * a unit leak (scene units read as metres) or a menu that has already been
 * exiled; either way the solver must not treat it as a seat. An ungated near
 * plane can report 3.4 m, which is the exiled case; this band is insurance
 * against the unit leak.
 */
export const PLATE_NEAR_MIN_METRES = 0.3;
export const PLATE_NEAR_MAX_METRES = 2.5;

/**
 * The share of the lens WIDTH the whole assembly, lit plus ghost, may span.
 *
 * Granting the bounding-sphere or extrema share at the seat RANGE draws a
 * whole wall at 89 per cent of the lens and a part-chapter ghost at 80-89
 * while the solver claims 70: the cartoon ribbons project wider, and the ghost
 * is not the rectangle being capped. The projected whole-subject width, ghost included,
 * is now held to 60 per cent. That is a named cap of its own, not the lit
 * ceiling reused. A ghost so much wider than its subject that honouring this
 * would shrink the lit part under SUBJECT_LENS_FLOOR is still allowed past
 * it, because a subject too small to read teaches nothing at all.
 */
export const SUBJECT_GHOST_LENS_CEILING = 0.60;
export const ASSEMBLY_LENS_FRACTION = SUBJECT_GHOST_LENS_CEILING;
/**
 * How far past its ceiling a ghost may run before the lit part shrinks.
 *
 * The lit floor wins over the ghost ceiling. A ghost wider than 0.60 is
 * allowed up to this limit while the lit part holds at or above
 * SUBJECT_LENS_FLOOR; only a ghost past this limit shrinks the lit part below
 * its floor. Measured part-chapter ghosts run 62.8 and 76.4 per cent of the
 * lens around lit parts at 29.7 and 35.9. The 62.8 ghost sits inside the limit
 * and is left alone. The 76.4 one is capped to the limit, which costs its lit
 * part 0.007 of the lens (0.359 to 0.352); both lit parts are drawn under the
 * 0.40 floor before this cap runs, because the context framing's own ask is
 * that small — the floor is a shrink guard, not a growth promise, and no cap
 * here grows it.
 */
export const SUBJECT_GHOST_LENS_LIMIT = 0.75;

/**
 * What share of the lens the lit subject may be reduced to, and grown to.
 *
 * The product rule is 40-50 per cent of eye width for a lit part (the old
 * sixty was the grant the ribbons then overran). The floor is a floor on the
 * REDUCTION the assembly fit may impose. `limited` says which way it went.
 */
export const SUBJECT_LENS_FLOOR = 0.40;
export const SUBJECT_LENS_CEILING = 0.50;
/**
 * The ceiling a chapter whose subject IS the structure may have.
 *
 * 0.55, not the ghost ceiling reused. A 0.60 cap granted on the on-axis width
 * draws a whole wall at 61.8 per cent of the lens, because the off-axis spread
 * spends the difference. The drawn width is what the wearer sees, so the grant
 * leaves room for the spread and the caption clearance.
 */
export const SUBJECT_WHOLE_LENS_CEILING = 0.55;
/**
 * The ceiling a chapter whose subject IS the density map may have.
 *
 * The map tier's brief is stricter than the atomic one: the whole map must
 * stay at or under 55 per cent of the lens, centred, clear of the menu column
 * and the caption plate. The atomic whole-structure ceiling above would let a
 * whole-map chapter spend seventy, which is how a hero object becomes a room.
 * `focusPlacement` takes this through `wholeSubjectCeiling`, and only a
 * volume record passes anything but the default.
 */
export const VOLUME_WHOLE_LENS_CEILING = 0.55;
/**
 * The share of the lens HEIGHT the lit subject may span.
 *
 * A width band alone cannot size a subject that is taller than it is wide:
 * growing a standing protofilament until it is half a lens across puts its ends
 * off the top and the bottom of the frame. The eye's vertical field is
 * `EYE_TAN_HALF_VERTICAL` (90 degrees), so eighty per cent of it is 77 degrees
 * of structure — as tall as a subject gets before the wearer has to tilt their
 * head to see the end of it. It bites only on a subject whose projected height
 * is more than about one and a half times its width; everything rounder is
 * sized by the width band and never sees this number.
 */
export const SUBJECT_RISE_CEILING = 0.80;
/**
 * The gap kept between the subject's rectangle and a plate's, and the margin
 * either of them keeps off the frame edge, both as lens fractions.
 *
 * Screen-space avoidance is not a depth rule: a structure can sit BEHIND the
 * plates (`clears: true`, nothing pierced) and the wearer still loses the
 * caption's last lines, because a lit orange lobe is drawn in the same corner
 * of the lens as the glass. Two rectangles that merely touch read as one
 * crowded corner, so the rule separates them by a visible sliver.
 */
export const PLATE_CLEARANCE_LENS = 0.03;
export const LENS_EDGE_MARGIN = 0.02;
/**
 * How far off the lens centre a seated subject may sit, and how far a sideways
 * dodge may carry its edge.
 *
 * A dodge that only takes the cheapest way out of the plate rectangle goes
 * sideways, and the wearer gets a protofilament whose centre sits in the right
 * half of the lens with its right edge parked on `subject.right` 0.98, clipped
 * by the lens margin. A subject is the thing the wearer is being shown; it
 * belongs in front of their eyes.
 *
 * So the seat is centred FIRST and a sideways move is the last resort rather
 * than the cheapest one. `SUBJECT_CENTRE_LENS` is what "centred" means when the
 * record is read back: a tenth of the lens either way of its middle plus the
 * elevation slop a one-off focus adds. `SUBJECT_SHIFT_LIMIT` is the wall the
 * shift may not cross — 0.90 leaves a tenth of the lens between the subject's
 * edge and the vignette, where 0.98 put it inside the distortion.
 */
export const SUBJECT_SHIFT_LIMIT = 0.90;

/**
 * How far back the rule may push a structure to clear the plates, in metres.
 *
 * A stereoscopic viewer's whole point is that the two eyes disagree. At a
 * 63 mm interpupillary distance that disagreement is about a degree at three
 * and a half metres and falls off with the distance, so a structure pushed
 * further than this to clear a plate is bought flat. Where the assembly fit
 * holds — the 70 per cent cap — a 1.20 m floor needs 3.24 m, which is inside
 * this; the cap only bites on a framing that could not be made to clear the
 * plates anyway, and those are the ones render order carries.
 */
export const STANDOFF_REACH_METRES = 3.5;

/** A half-angle tangent as a share of the lens's half width. */
export function lensFraction(tangent) {
  return Number.isFinite(tangent) && tangent > 0 ? tangent / EYE_TAN_HALF_HORIZONTAL : 0;
}
/** The inverse: the half-angle tangent that spans this share of the lens. */
export function lensTangent(fraction) {
  return Math.max(0, Number.isFinite(fraction) ? fraction : 0) * EYE_TAN_HALF_HORIZONTAL;
}

const finite3 = value => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);

/**
 * The framing this structure may actually have, given the plates in front of it.
 *
 * Every ratio below is measured on the PROJECTED EXTENT of the thing it names
 * — the width and height of its oriented bounding rectangle as the eye sees it
 * — and `tanHalfSubject` is the tangent of the subject's half WIDTH, not of a
 * bounding sphere's radius. A bounding sphere around an elongated subject has
 * the radius of its LENGTH, so a dimer whose long axis runs into the screen is
 * sized as if it were a ball that wide: the record claims the subject holds
 * forty per cent of the lens (`subjectLens: 0.4`) while the drawn view is
 * thirty-two, and the protofilament behind it draws at 18.9 — a speck. The
 * same sphere makes the ghost look bigger than it is, so the assembly cap cuts
 * the subject to its floor and the stand-off runs to its reach cap for room
 * that was never needed.
 *
 * Left alone, the defaults describe a subject and an assembly that are as tall
 * and as deep as they are wide, which is the sphere the caller used to pass and
 * the same arithmetic it used to get.
 *
 * @param {number} tanHalfSubject tangent of the asked framing's half WIDTH
 * @param {number} reachRatio how much further the whole assembly reaches from
 *   the subject's centre than the subject's own projected half width:
 *   `(|targetCentre − centre| + radius) / subjectHalfWidth`. This one is a
 *   RADIUS, deliberately: it is what the near-clearance is solved from, and a
 *   bounding sphere is the conservative answer to "how close does any of this
 *   come to the eye".
 * @param {number} [riseRatio] the subject's projected half height over its half
 *   width, so 1 is a subject as tall as it is wide
 * @param {number} [assemblyWidthRatio] the whole assembly's projected half
 *   width over the subject's, defaulting to `reachRatio`
 * @param {number} [assemblyRiseRatio] the same for its projected half height
 * @param {number} [subjectCeiling] the share of the lens width the subject may
 *   span. Undefined leaves the subject uncapped except by the assembly, which
 *   is what a sphere-measured caller wants: under that measure a `fill` framing
 *   is already inside the band by the time it reaches the lens.
 * @param {number} [plateNearMetres] the nearest plate's range from the eye
 * @returns {{tanHalfSubject:number, tanHalfAssembly:number, subjectFraction:number,
 *   assemblyFraction:number, subjectRise:number, assemblyRise:number,
 *   minDistanceMetres:number, plateNearMetres:number, floorMetres:number,
 *   grantedStandoffMetres:number, reachLimited:boolean,
 *   limited:'none'|'assembly'|'subject-floor'|'lens-ceiling'|'subject-rise'|'inside-out'}}
 */
export function standoffFraming({ tanHalfSubject, reachRatio, plateNearMetres,
  standoffMetres = PLATE_STANDOFF_METRES, assemblyFraction = ASSEMBLY_LENS_FRACTION,
  subjectFloor = SUBJECT_LENS_FLOOR, subjectCeiling,
  riseRatio, assemblyWidthRatio, assemblyRiseRatio, riseCeiling = SUBJECT_RISE_CEILING } = {}) {
  const asked = Number.isFinite(tanHalfSubject) && tanHalfSubject > 0 ? tanHalfSubject : 0;
  const ratio = Number.isFinite(reachRatio) && reachRatio > 1 ? reachRatio : 1;
  const positive = (value, fallback) => (Number.isFinite(value) && value > 0 ? value : fallback);
  const rise = positive(riseRatio, 1);
  const wide = positive(assemblyWidthRatio, ratio);
  const tall = positive(assemblyRiseRatio, wide);
  const plateNear = Number.isFinite(plateNearMetres)
    && plateNearMetres >= PLATE_NEAR_MIN_METRES && plateNearMetres <= PLATE_NEAR_MAX_METRES
    ? plateNearMetres : PLATE_NEAR_FALLBACK_METRES;
  const margin = Number.isFinite(standoffMetres) && standoffMetres > 0 ? standoffMetres : 0;
  const floorMetres = plateNear + margin;
  // Every cap, as a bound on the subject's half-width tangent. A share of the
  // lens HEIGHT is measured against `EYE_TAN_HALF_VERTICAL` and a share of its
  // width against `EYE_TAN_HALF_HORIZONTAL`, which is the whole reason the two
  // axes are carried separately: the eye is wider than it is tall in tangent
  // terms only because its horizontal field is narrower.
  const riseTangent = fraction => Math.max(0, fraction) * EYE_TAN_HALF_VERTICAL;
  // What the subject's own frame allows: the product's band, and the height of
  // the lens. Neither may be spent to make the ghost fit, because both are
  // about the subject being on screen at all.
  const hard = [{ tan: riseTangent(riseCeiling) / rise, why: 'subject-rise' }];
  if (Number.isFinite(subjectCeiling) && subjectCeiling > 0)
    hard.push({ tan: lensTangent(subjectCeiling), why: 'lens-ceiling' });
  const hardest = hard.reduce((low, cap) => (cap.tan < low.tan ? cap : low));
  // What the assembly cap allows the subject, and the floor under it. A fit is
  // only ever a REDUCTION: a subject already inside its band is never grown to
  // fill the lens, because `context` means thirty degrees and asking for
  // context is not asking for half the view.
  const capped = Math.min(lensTangent(assemblyFraction) / wide, riseTangent(assemblyFraction) / tall);
  const floored = Math.min(lensTangent(subjectFloor), hardest.tan);
  let fitted = asked > 0 ? Math.min(asked, hardest.tan, Math.max(capped, floored)) : 0;
  let limited = 'none';
  if (fitted < asked - 1e-12) limited = fitted >= hardest.tan - 1e-12 ? hardest.why
    : (capped >= floored ? 'assembly' : 'subject-floor');
  if (!(fitted > 0)) return { tanHalfSubject: asked, tanHalfAssembly: asked * ratio,
    subjectFraction: lensFraction(asked), assemblyFraction: lensFraction(asked * ratio),
    subjectRise: 0, assemblyWide: 0, assemblyTall: 0, grantedStandoffMetres: margin, reachLimited: false,
    minDistanceMetres: 0, wantedDistanceMetres: 0, plateNearMetres: plateNear, floorMetres, limited: 'inside-out' };
  // A reduction that still leaves the wearer inside the assembly has bought
  // nothing and cost the subject its size, so it is not made: a pocket inside a
  // large complex keeps the sixty degrees it asked for.
  // And it keeps the framing only as far as the subject's own
  // caps allow. Giving a tier back the sixty degrees it asked for is one thing;
  // giving it back past the lens is how a subject leaves the frame.
  if (fitted * ratio >= 1) { fitted = Math.min(asked, hardest.tan); limited = 'inside-out'; }
  const tanHalfAssembly = fitted * ratio;
  // The whole assembly's near point is `distance · (1 − tanHalfAssembly)`: the
  // assembly's own radius grows with the distance it is placed at, because the
  // framing is held. An assembly wider than a right angle has no distance at
  // which the eye is outside it at all — a subject that small inside a complex
  // that large is a framing the wearer stands inside whatever anyone does with
  // it. There is no distance to ask for, so none is asked for, and the plates
  // are kept legible by render order alone. `limited` says so.
  const clearance = 1 - tanHalfAssembly;
  const wanted = clearance > 0 ? floorMetres / clearance : 0;
  // A stand-off is bounded by what a stereoscopic viewer is for. Past about
  // three and a half metres a Quest 2's two eyes see the same image and the
  // structure goes flat, so the rule pushes the structure as far as it may
  // and no further; where that is not far enough, the plates stay legible on
  // render order alone and `clears` says the geometry did not get there.
  const seated = Math.min(wanted, STANDOFF_REACH_METRES);
  return { tanHalfSubject: fitted, tanHalfAssembly,
    subjectFraction: lensFraction(fitted), assemblyFraction: lensFraction(tanHalfAssembly),
    // The same three measured on the projected rectangle rather
    // than on the reach sphere. `subjectFraction` above and `subjectRise` here
    // are the pair the product rule is written in.
    subjectRise: fitted * rise / EYE_TAN_HALF_VERTICAL,
    assemblyWide: lensFraction(fitted * wide), assemblyTall: fitted * tall / EYE_TAN_HALF_VERTICAL,
    minDistanceMetres: seated,
    wantedDistanceMetres: wanted,
    // What the plates were actually GRANTED once the reach cap
    // had its say. The rule would rather spend this margin than shrink the
    // subject under its floor — a subject too small to read teaches nothing,
    // and a plate the structure is merely near is still legible where the
    // screen-space rule below has kept it out from behind the structure. A
    // negative number is a structure in front of the glass, which is exactly
    // the case `plateAvoidance` exists to survive.
    grantedStandoffMetres: clearance > 0 ? seated * clearance - plateNear : 0,
    reachLimited: clearance > 0 && wanted > STANDOFF_REACH_METRES,
    plateNearMetres: plateNear, floorMetres,
    limited: clearance > 0 ? limited : 'inside-out' };
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = v => { const length = Math.hypot(v[0], v[1], v[2]);
  return length > 1e-9 ? [v[0] / length, v[1] / length, v[2] / length] : undefined; };

/**
 * The eye's own right/up/forward axes, from where it is looking.
 *
 * Everything a wearer complains about — "it is off in the corner", "it covers
 * the caption", "it is a speck" — is a statement about this frame and not about
 * the room, so this is the frame the framing is solved in. `worldUp` is the
 * room's up rather than the head's: the structure is placed level with the
 * floor whatever the head is doing, which is what `holdHeadRotationZero` and
 * the room-locked menu already assume.
 */
export function viewBasis(forward, worldUp = [0, 1, 0]) {
  const ahead = finite3(forward) ? unit(forward) : undefined;
  if (!ahead) return undefined;
  const side = unit(cross(ahead, finite3(worldUp) ? worldUp : [0, 1, 0]))
    // Straight up or straight down: any horizontal axis will do, so take the
    // one the head's own roll implies rather than returning nothing.
    ?? unit(cross(ahead, [0, 0, 1])) ?? [1, 0, 0];
  return { right: side, up: cross(side, ahead), forward: ahead };
}

/**
 * The half width, height and depth of a point cloud as this eye
 * sees it, about `centre`, in whatever units the points are in.
 *
 * This is the number a bounding sphere cannot give. A sphere has one radius for
 * every direction, so an elongated subject pointing into the screen is measured
 * at its LENGTH and drawn at its width, which is what undersizes an elongated
 * dimer or protofilament. The extent is measured about the subject's own centre
 * and axis-aligned to the eye, which is the rectangle the wearer sees it fill.
 *
 * `points` are a Mol* boundary's `extrema` in the frame the placement rotation
 * has already been applied in; the caller is responsible for rotating the basis
 * into that frame. Missing or degenerate points return undefined, and the
 * caller falls back to the sphere it used to use.
 */
export function projectedExtent({ points, centre, basis } = {}) {
  const list = (Array.isArray(points) ? points : []).filter(finite3);
  if (!finite3(centre) || !basis?.right || !basis?.up || !basis?.forward || !list.length) return undefined;
  let halfWidth = 0, halfHeight = 0, halfDepth = 0;
  for (const point of list) {
    const offset = [point[0] - centre[0], point[1] - centre[1], point[2] - centre[2]];
    halfWidth = Math.max(halfWidth, Math.abs(dot(offset, basis.right)));
    halfHeight = Math.max(halfHeight, Math.abs(dot(offset, basis.up)));
    halfDepth = Math.max(halfDepth, Math.abs(dot(offset, basis.forward)));
  }
  return halfWidth > 0 && halfHeight > 0 ? { halfWidth, halfHeight, halfDepth } : undefined;
}

/**
 * Where a set of room points lands on the lens, as fractions.
 *
 * The frame is the one a share of the lens is already quoted in everywhere
 * else: x and y run from -1 at the left and bottom edge to +1 at the right and
 * top, so a rectangle's half width IS its share of the lens width and the
 * numbers in a `plate-standoff` record can be read against each other without
 * conversion. Points behind the eye are dropped rather than folded onto the
 * front, which is what dividing by a negative depth would do.
 */
export function lensRectFromPoints({ points, origin, basis } = {}) {
  const list = (Array.isArray(points) ? points : []).filter(finite3);
  if (!finite3(origin) || !basis?.forward || !list.length) return undefined;
  let left = Infinity, right = -Infinity, bottom = Infinity, top = -Infinity;
  for (const point of list) {
    const offset = [point[0] - origin[0], point[1] - origin[1], point[2] - origin[2]];
    const depth = dot(offset, basis.forward);
    if (!(depth > 1e-6)) continue;
    const x = dot(offset, basis.right) / (depth * EYE_TAN_HALF_HORIZONTAL);
    const y = dot(offset, basis.up) / (depth * EYE_TAN_HALF_VERTICAL);
    left = Math.min(left, x); right = Math.max(right, x);
    bottom = Math.min(bottom, y); top = Math.max(top, y);
  }
  return Number.isFinite(left) ? { left, right, bottom, top } : undefined;
}

/**
 * The rectangle a set of ALREADY PROJECTED lens points covers.
 *
 * `lensRectFromPoints` above projects room points from the eye; this is the
 * same rectangle for points `projectPlacedToLens` has already put on the lens,
 * which is how the drawn extent of a placed, rotated structure is measured.
 * The pair is deliberate: a plate is a fixed room object and a structure is
 * not, so only one of them can be measured from its room coordinates.
 */
export function lensBounds(points) {
  const list = (Array.isArray(points) ? points : [])
    .filter(point => point && Number.isFinite(point.x) && Number.isFinite(point.y));
  if (!list.length) return undefined;
  let left = Infinity, right = -Infinity, bottom = Infinity, top = -Infinity;
  for (const point of list) {
    left = Math.min(left, point.x); right = Math.max(right, point.x);
    bottom = Math.min(bottom, point.y); top = Math.max(top, point.y);
  }
  return { left, right, bottom, top, x: (left + right) / 2, y: (bottom + top) / 2,
    halfWidth: (right - left) / 2, halfHeight: (top - bottom) / 2 };
}

/** The rectangle a subject centred at (x, y) with these half extents covers. */
export function lensRect({ x = 0, y = 0, halfWidth = 0, halfHeight = 0 } = {}) {
  return { left: x - halfWidth, right: x + halfWidth, bottom: y - halfHeight, top: y + halfHeight,
    x, y, halfWidth, halfHeight };
}

/** Do two lens rectangles share any of the lens, allowing for a gap? */
export function lensRectsOverlap(a, b, clearance = 0) {
  if (!a || !b) return false;
  return a.left < b.right + clearance && a.right > b.left - clearance
    && a.bottom < b.top + clearance && a.top > b.bottom - clearance;
}

/**
 * Move the subject out from behind the glass, in screen space.
 *
 * The stand-off rule above is about DEPTH, and depth alone is not enough: a
 * chapter can record `clears: true` and `pierced: 0` and the wearer still
 * cannot read the caption, because a lit ribbon sits in the same top-left
 * corner of the lens as the caption plate and the eye has no depth cue that
 * separates two things it cannot see at once. Depth clearance is necessary and
 * it is not sufficient; this is the other half.
 *
 * It moves DOWN before it moves sideways.
 *
 * Taking the cheapest way out, which for a caption seated top-left of the
 * wearer is a step to the right, is the wrong trade every time: it puts a
 * correctly sized protofilament (0.485 of the lens) with its centre in the
 * RIGHT half of the lens and its right edge on 0.98, against the vignette,
 * while the middle of the view stands empty. The subject is what the
 * wearer came to look at, so where it sits left-to-right is not a free variable
 * to spend on the caption. Its height is.
 *
 * The order below is that judgement, and `move` says which step won:
 *
 *  1. `none` — the rectangles already clear each other.
 *  2. `lower` / `raise` — slide the subject off the plate along Y at full size,
 *     as long as the moved rectangle stays inside the lens margin. For the
 *     top-left caption this is always a lowering.
 *  3. `shrink`, `shrink+lower`, `shrink+raise` — give up size, never past
 *     `shrinkFloor` (the caller sets that from SUBJECT_LENS_FLOOR), either
 *     standing still or to make the vertical slide fit.
 *  4. `shift` — only now, sideways, and never so far that an edge passes
 *     `shiftLimit`. A subject shoved off the edge of the lens to clear a
 *     caption has been made worse, not better.
 *  5. `held` — no legal seat at all. The best candidate is taken at the floor
 *     and clamped into the lens; `overlap` stays true and render order is what
 *     keeps the caption readable.
 *
 * The plate handed in is the CAPTION plate alone, never the union of the
 * caption and the menu: that union spans the whole left column of the lens
 * (x −0.87..−0.10 on the run above) and nothing can be centred beside it. A
 * lesson dims the menu, and a ghost crossing a dimmed button is not what the
 * wearer complained about.
 *
 * @returns {{x:number, y:number, shrink:number, move:string, axis:string,
 *   centred:boolean, overlap:boolean, rect:object}}
 */
export function plateAvoidance({ subject, plate, clearance = PLATE_CLEARANCE_LENS,
  edge = LENS_EDGE_MARGIN, shrinkFloor = 1, shiftLimit = SUBJECT_SHIFT_LIMIT,
  centreTolerance = SUBJECT_CENTRE_LENS } = {}) {
  const halfW = shrink => subject.halfWidth * shrink, halfH = shrink => subject.halfHeight * shrink;
  const at = (x, y, shrink) => lensRect({ x, y, halfWidth: halfW(shrink), halfHeight: halfH(shrink) });
  const still = (x, y, shrink) => lensRectsOverlap(at(x, y, shrink), plate, clearance);
  // A seat solved to touch the clearance exactly lands a few ulps inside it, so
  // the REPORTED overlap allows for that; the test that decides whether to dodge
  // at all, above, does not. Without the slack every clean seat this rule
  // produces would be written down as a failure.
  const rubbing = (x, y, shrink) => lensRectsOverlap(at(x, y, shrink), plate, clearance - 1e-9);
  const answer = (x, y, shrink, move, axis) => ({ x, y, shrink, move, axis,
    centred: Math.abs(x) <= centreTolerance, overlap: rubbing(x, y, shrink), rect: at(x, y, shrink) });
  const standing = answer(subject?.x ?? 0, subject?.y ?? 0, 1, 'none', 'none');
  if (!plate || !(subject?.halfWidth > 0) || !(subject?.halfHeight > 0)) return standing;
  if (!still(subject.x, subject.y, 1)) return standing;
  const floor = Math.min(1, Math.max(0, Number.isFinite(shrinkFloor) ? shrinkFloor : 1));
  const limit = Number.isFinite(shiftLimit) && shiftLimit > 0 ? shiftLimit : 1;
  const sized = way => Math.min(1, way.cap);
  // Of the candidates the floor allows, the one that leaves the subject the
  // biggest; between two that leave it the same size, the one that moves it
  // least. `cheapest` is the same choice where every candidate is full size.
  const best = list => list.filter(way => way.cap > 0 && way.cap >= floor - 1e-12)
    .sort((a, b) => (b.cap - a.cap) || (a.cost(sized(a)) - b.cost(sized(b))))[0];
  const cheapest = list => list.filter(way => way.cap >= 1).sort((a, b) => a.cost(1) - b.cost(1))[0];
  // Sliding along Y, which costs the subject nothing the wearer minds. `cap` is
  // the largest shrink at which the moved rectangle still clears the lens
  // margin on the far side; `seat` is where its centre lands at that size.
  const verticals = [
    { move: 'lower', axis: 'down', seat: shrink => plate.bottom - clearance - halfH(shrink),
      cap: (plate.bottom - clearance + 1 - edge) / (2 * subject.halfHeight) },
    { move: 'raise', axis: 'up', seat: shrink => plate.top + clearance + halfH(shrink),
      cap: (1 - edge - plate.top - clearance) / (2 * subject.halfHeight) },
  ].map(way => ({ ...way, place: shrink => ({ x: subject.x, y: way.seat(shrink) }),
    cost: shrink => Math.abs(way.seat(shrink) - subject.y) }));
  const upright = cheapest(verticals);
  if (upright) { const { x, y } = upright.place(1); return answer(x, y, 1, upright.move, upright.axis); }
  // Size, then. Either standing exactly where it is — the cheapest of all, when
  // the subject is merely a little too big for the gap beside the glass — or
  // small enough for the vertical slide above to fit inside the lens.
  const inPlace = {
    move: 'shrink', axis: 'none', place: () => ({ x: subject.x, y: subject.y }), cost: () => 0,
    cap: Math.max((subject.y - plate.top - clearance) / subject.halfHeight,
      (plate.bottom - clearance - subject.y) / subject.halfHeight,
      (subject.x - plate.right - clearance) / subject.halfWidth,
      (plate.left - clearance - subject.x) / subject.halfWidth),
  };
  const shrunk = best([inPlace, ...verticals.map(way => ({ ...way, move: `shrink+${way.move}` }))]);
  if (shrunk) {
    const shrink = Math.min(1, shrunk.cap);
    const { x, y } = shrunk.place(shrink);
    return answer(x, y, shrink, shrunk.move, shrunk.axis);
  }
  // Sideways is the last thing tried and the first thing the wearer notices, so
  // it is bounded by `shiftLimit` rather than by the lens edge.
  const shifts = [
    { move: 'shift', axis: 'right', seat: shrink => plate.right + clearance + halfW(shrink),
      cap: (limit - clearance - plate.right) / (2 * subject.halfWidth) },
    { move: 'shift', axis: 'left', seat: shrink => plate.left - clearance - halfW(shrink),
      cap: (limit - clearance + plate.left) / (2 * subject.halfWidth) },
  ].map(way => ({ ...way, place: shrink => ({ x: way.seat(shrink), y: subject.y }),
    cost: shrink => Math.abs(way.seat(shrink) - subject.x) }));
  const aside = best(shifts);
  if (aside) {
    const shrink = Math.min(1, aside.cap);
    const { x, y } = aside.place(shrink);
    return answer(x, y, shrink, aside.move, aside.axis);
  }
  // Nothing separates them. Take the roomiest candidate at the floor, hold it
  // inside the lens and inside the shift limit, and say so: `overlap` stays
  // true and the plates are kept legible by render order alone.
  const held = [...verticals, ...shifts, inPlace].reduce((a, b) => (b.cap > a.cap ? b : a));
  const shrink = Math.max(floor, Math.min(1, held.cap));
  const { x, y } = held.place(shrink);
  const sideRoom = Math.max(0, limit - halfW(shrink)), riseRoom = Math.max(0, 1 - edge - halfH(shrink));
  return answer(Math.max(-sideRoom, Math.min(sideRoom, x)),
    Math.max(-riseRoom, Math.min(riseRoom, y)), shrink, 'held', held.axis);
}

/**
 * After the caption seat, keep the whole projected subject (ghost included)
 * off the menu column. Never move the menu or the caption.
 *
 * The caption dodge sits the subject clear of the top-left card and may have
 * lowered it. The menu is the four button rows under that card, and a lit
 * strand or a ghost ribbon can still run through Talk and Play. This step sees
 * the GHOST rectangle, and the order is raise, then shift, then shrink:
 *
 *  1. `raise` within the lens margin and optional `riseLimit`, toward the eye
 *     line (y = 0) when nothing still forces the subject down. Focus callers
 *     cap menu-induced rise to keep a level subject in the middle band.
 *  2. `shift` right, never so the centre passes `centreLimit`
 *     (SUBJECT_CENTRE_LENS).
 *  3. `shrink` in place — and only when the shrunk rectangle itself clears
 *     the column, down to `shrinkFloor` (the caller sets that from
 *     SUBJECT_LENS_FLOOR on the LIT part, so the lit floor still wins).
 *
 * What the order does NOT do is spend size on a crossing it cannot clear. A
 * shrink that still leaves the ghost over the column buys the wearer a smaller
 * subject in the same crowded corner, so a seat no raise, shift or clearing
 * shrink separates is held at full size instead: `held` means the ghost still
 * crosses the column, and the ghost-button step after this one is what keeps
 * its strand off the buttons. `cleared` is whether the
 * menu column is free of the subject after those steps.
 *
 * @returns {{x:number, y:number, shrink:number, move:string, cleared:boolean,
 *   overlap:boolean, centred:boolean, rect:object}}
 */
export function menuAvoidance({ subject, menu, caption, clearance = PLATE_CLEARANCE_LENS,
  edge = LENS_EDGE_MARGIN, shrinkFloor = 1, centreLimit = SUBJECT_CENTRE_LENS,
  riseLimit = Infinity } = {}) {
  const halfW = shrink => subject.halfWidth * shrink, halfH = shrink => subject.halfHeight * shrink;
  const at = (x, y, shrink) => lensRect({ x, y, halfWidth: halfW(shrink), halfHeight: halfH(shrink) });
  const hits = (x, y, shrink, plate) => plate ? lensRectsOverlap(at(x, y, shrink), plate, clearance) : false;
  const hitsMenu = (x, y, shrink) => hits(x, y, shrink, menu);
  const hitsCaption = (x, y, shrink) => hits(x, y, shrink, caption);
  const rubbing = (x, y, shrink) => lensRectsOverlap(at(x, y, shrink), menu, clearance - 1e-9);
  const answer = (x, y, shrink, move) => ({ x, y, shrink, move,
    cleared: !menu || !rubbing(x, y, shrink), overlap: Boolean(menu) && rubbing(x, y, shrink),
    centred: Math.abs(x) <= centreLimit, rect: at(x, y, shrink) });
  const standing = answer(subject?.x ?? 0, subject?.y ?? 0, 1, 'none');
  if (!(subject?.halfWidth > 0) || !(subject?.halfHeight > 0)) return standing;
  if (!menu && !(subject.y < -1e-9)) return standing;
  const floor = Math.min(1, Math.max(0, Number.isFinite(shrinkFloor) ? shrinkFloor : 1));
  const limit = Number.isFinite(centreLimit) ? centreLimit : SUBJECT_CENTRE_LENS;
  let x = subject.x, y = subject.y, shrink = 1;
  const steps = [];
  const room = shrink => ({
    maxY: Math.min(riseLimit, 1 - edge - halfH(shrink)),
    minY: -1 + edge + halfH(shrink),
    captionY: caption ? caption.bottom - clearance - halfH(shrink) : Infinity,
  });
  const lift = shrinkAt => {
    const bounds = room(shrinkAt);
    const aboveMenu = menu ? menu.top + clearance + halfH(shrinkAt) : 0;
    // Prefer the eye line when that seat is legal. Otherwise rise just far
    // enough to sit above the menu, and never back into the caption or out of
    // the lens.
    const want = menu && hitsMenu(x, 0, shrinkAt) ? aboveMenu : 0;
    return Math.min(bounds.maxY, bounds.captionY, Math.max(bounds.minY, y, want));
  };
  // Raise first, at full size: sitting above the menu costs the subject
  // nothing, and toward the eye line when that seat is legal.
  const raised = lift(1);
  if (raised > y + 1e-9 && (hitsMenu(x, y, 1) || y < -1e-9) && !hitsCaption(x, raised, 1)) {
    y = raised;
    steps.push('raise');
  }
  // Then shift right at full size, never past the centre limit.
  if (hitsMenu(x, y, 1)) {
    const shifted = Math.min(limit, menu.right + clearance + halfW(1));
    if (shifted > x + 1e-9 && !hitsCaption(shifted, y, 1) && !hitsMenu(shifted, y, 1)) {
      x = shifted;
      steps.push('shift');
    }
  }
  // Then shrink in place, and only when the shrunk rectangle itself clears the
  // column: the least reduction that separates the rectangles on one axis,
  // never past the lit-part floor. A shrink that still leaves the ghost over
  // the column is refused — the seat below holds full size instead.
  if (hitsMenu(x, y, 1)) {
    const gapRight = x - menu.right - clearance;
    const gapAbove = y - menu.top - clearance;
    const gapBelow = menu.bottom - clearance - y;
    const need = Math.max(
      subject.halfWidth > 0 && gapRight > 0 ? gapRight / subject.halfWidth : 0,
      subject.halfHeight > 0 && gapAbove > 0 ? gapAbove / subject.halfHeight : 0,
      subject.halfHeight > 0 && gapBelow > 0 ? gapBelow / subject.halfHeight : 0);
    if (need >= floor - 1e-12 && need < 1 - 1e-12) {
      shrink = Math.max(floor, Math.min(1, need));
      if (shrink < 1 - 1e-12) steps.push('shrink');
    }
  }
  if (hitsMenu(x, y, shrink)) {
    // Nothing separates them. Hold the seat the raise and the shift found at
    // full size, inside the lens and the centre limit, and say so: `cleared`
    // stays false and the ghost-button pass keeps the strand off the buttons.
    const bounds = room(shrink);
    x = Math.min(limit, Math.max(-limit, x));
    y = Math.min(bounds.maxY, Math.max(bounds.minY, y));
    return answer(x, y, shrink, 'held');
  }
  return answer(x, y, shrink, steps.length ? steps.join('+') : 'none');
}

/**
 * The shrink the width caps alone impose, with the precedence written down.
 *
 * The lit floor wins over the ghost ceiling. A ghost past
 * SUBJECT_GHOST_LENS_CEILING is allowed up to SUBJECT_GHOST_LENS_LIMIT while
 * the lit part holds SUBJECT_LENS_FLOOR; only a ghost past the limit shrinks
 * the lit part below its floor. Measured part chapters draw lit parts at 29.7
 * and 35.9 per cent of the lens inside ghosts at 62.8 and 76.4. The 62.8 ghost
 * sits inside the limit and is left alone; the 76.4 one is capped to the limit
 * and its lit part gives up 0.007 (0.359 to 0.352). Both lit parts are already
 * under the 0.40 floor — the context framing's own ask — and no cap here grows
 * them back.
 *
 * The limit branch needs a ghost that is actually DRAWN on the lens
 * (`ghostOnLens`). When nothing was measured the whole is a bounding-sphere
 * reach the wearer may stand inside — a "ghost" of several lens widths that no
 * seat could ever draw — and shrinking the subject onto it would crush a
 * framing the sphere path exists to keep (the sixty degrees a pocket asks
 * for). So past an undrawn ghost the ceiling branch keeps the floor guard and
 * the limit branch is skipped entirely.
 *
 * @returns {number} the combined cap shrink, never above 1.
 */
export function subjectCapShrink({ litHalfWidth, wholeHalfWidth, litCeiling,
  floor = SUBJECT_LENS_FLOOR, ghostCeiling = SUBJECT_GHOST_LENS_CEILING,
  ghostLimit = SUBJECT_GHOST_LENS_LIMIT, ghostOnLens = true } = {}) {
  const litW = Number.isFinite(litHalfWidth) ? litHalfWidth : 0;
  const wholeW = Number.isFinite(wholeHalfWidth) ? wholeHalfWidth : litW;
  if (!(litW > 0)) return 1;
  let shrink = 1;
  if (ghostOnLens && wholeW > ghostLimit) shrink = Math.min(shrink, ghostLimit / wholeW);
  else if (wholeW > ghostCeiling) {
    const next = ghostCeiling / wholeW;
    if (litW * next >= floor - 1e-9) shrink = Math.min(shrink, next);
  }
  if (Number.isFinite(litCeiling) && litCeiling > 0 && litW * shrink > litCeiling)
    shrink = Math.min(shrink, litCeiling / litW);
  return shrink;
}

/**
 * After the seat is chosen, keep the ghost's foreground strand off the
 * buttons. Never moves the menu or the caption.
 *
 * The ghost's rectangle may cross the menu column — a dimmed button behind a
 * faded ribbon still reads — but a strand lying OVER a button does not: a
 * ghost that crosses the menu column can sit directly on the Menu button. So
 * this step sees GHOST POINTS, already projected to lens fractions at this
 * seat, against one rectangle per button row, and moves the whole subject (lit
 * and ghost rigidly together):
 *
 *  1. `raise` — up, just far enough that no point sits over a button, staying
 *     inside the lens margin and clear of the caption.
 *  2. `shift` — right, never so the centre passes `centreLimit`
 *     (SUBJECT_CENTRE_LENS).
 *  3. `shrink` — about the seat, never past `shrinkFloor` (the caller sets that
 *     from SUBJECT_LENS_FLOOR on the lit part, so the lit floor still wins).
 *
 * `crossed` is whether the ghost rectangle still crosses the menu column;
 * `cleared` is whether no ghost point lies over any button. `held` means the
 * raise, the shift and the floor ran out together.
 *
 * The caption guard in the raise and the shift is the LIT part's rectangle,
 * not the ghost's. The lit strand is what would hide the plate, and the dodge
 * already seated it clear; the faded ribbon may cross the glass the same way
 * this rule tolerates it crossing the dimmed menu column, and render order
 * keeps the caption legible behind it. A ghost-wide guard refuses every raise
 * and shift for a part whose ghost is twice its lit width, leaving the strand
 * on the Menu button — the one outcome this step exists to prevent. Callers pass the lit
 * half extents (the ghost's own, divided by the whole ratio); without them the
 * ghost rectangle is the guard, which is exact for a chapter that IS the
 * structure.
 *
 * And it sees the RECTANGLES as well as the points, and the lit
 * part's points as well as the ghost's.
 *
 * Eight corners are a poor sample of a drawn ribbon. On the wall
 * tier the pass reported `cleared: true` for chapters 3 and 4 while the ghost's
 * own drawn rectangle covered the Menu button in both and the lit part's
 * covered it in chapter 4 — every assembly corner missed the row and the face
 * between them did not, and the lit selection's corners were never in
 * `ghostPoints` at all, because they are interior to the assembly's extrema.
 * So `litPoints` are checked beside the ghost's, and each candidate seat is
 * scored on the RECTANGLE too: the raise and the shift take the first seat that
 * clears points AND rectangles, and fall back to one that clears the points
 * alone, which is the seat this pass has always chosen. `covered` says which
 * of the two the answer is, so a record can no longer read clear while a button
 * is under a ribbon.
 * `riseLimit`, when supplied, also bounds this pass: button avoidance cannot
 * undo the middle band preserved by the preceding menu pass.
 *
 * @returns {{x:number, y:number, shrink:number, move:string, crossed:boolean,
 *   cleared:boolean, covered:boolean, rect:object}}
 */
export function ghostButtonAvoidance({ ghost, ghostPoints, litPoints, buttons, menu, caption,
  clearance = PLATE_CLEARANCE_LENS, edge = LENS_EDGE_MARGIN, shrinkFloor = 1,
  centreLimit = SUBJECT_CENTRE_LENS, riseLimit = Infinity, litHalfWidth, litHalfHeight } = {}) {
  const halfW = shrink => ghost.halfWidth * shrink, halfH = shrink => ghost.halfHeight * shrink;
  const at = (x, y, shrink) => lensRect({ x, y, halfWidth: halfW(shrink), halfHeight: halfH(shrink) });
  const litW = Number.isFinite(litHalfWidth) && litHalfWidth > 0 ? litHalfWidth : 0;
  const litH = Number.isFinite(litHalfHeight) && litHalfHeight > 0 ? litHalfHeight : 0;
  const guarded = (x, y, shrink) => litW > 0 && litH > 0
    ? lensRect({ x, y, halfWidth: litW * shrink, halfHeight: litH * shrink }) : at(x, y, shrink);
  const rows = (Array.isArray(buttons) ? buttons : []).filter(Boolean);
  const finitePoint = point => point && Number.isFinite(point.x) && Number.isFinite(point.y);
  const points = (Array.isArray(ghostPoints) ? ghostPoints : []).filter(finitePoint);
  // The lit selection's own corners, which are interior to the
  // assembly's extrema and so were never in `ghostPoints`. A lit strand over a
  // button is the same defect as a ghost one and a worse-looking one, because
  // the lit part is not faded.
  const lit = (Array.isArray(litPoints) ? litPoints : []).filter(finitePoint);
  const moved = (point, x, y, shrink) => ({ x: x + (point.x - ghost.x) * shrink,
    y: y + (point.y - ghost.y) * shrink });
  const pointOver = (point, x, y, shrink) => rows.some(row =>
    lensRectsOverlap(lensRect({ x: moved(point, x, y, shrink).x, y: moved(point, x, y, shrink).y,
      halfWidth: 0, halfHeight: 0 }), row, clearance));
  const over = (x, y, shrink) => points.some(point => pointOver(point, x, y, shrink))
    || lit.some(point => pointOver(point, x, y, shrink));
  // And the silhouettes between those corners. A ribbon fills its
  // rectangle, so a row under the ghost's or the lit part's rectangle is a
  // button the wearer cannot see even when every corner misses it.
  const covers = (x, y, shrink) => rows.some(row => lensRectsOverlap(at(x, y, shrink), row, clearance))
    || (litW > 0 && litH > 0
      && rows.some(row => lensRectsOverlap(guarded(x, y, shrink), row, clearance)));
  const inLens = (x, y, shrink) => x - halfW(shrink) >= -1 - 1e-9 && x + halfW(shrink) <= 1 + 1e-9
    && y - halfH(shrink) >= -1 + edge - 1e-9 && y + halfH(shrink) <= 1 - edge + 1e-9;
  const hitsCaption = (x, y, shrink) => caption
    ? lensRectsOverlap(guarded(x, y, shrink), caption, clearance) : false;
  const crossedAt = (x, y, shrink) => menu ? lensRectsOverlap(at(x, y, shrink), menu, clearance) : false;
  const answer = (x, y, shrink, move) => ({ x, y, shrink, move,
    crossed: crossedAt(x, y, shrink), cleared: !over(x, y, shrink),
    covered: covers(x, y, shrink), rect: at(x, y, shrink) });
  const standing = answer(ghost?.x ?? 0, ghost?.y ?? 0, 1, 'none');
  if (!(ghost?.halfWidth > 0) || !(ghost?.halfHeight > 0) || !(points.length || lit.length) || !rows.length)
    return standing;
  // A covered button is worth a move even when every corner
  // misses the row, which is the chapter-3 and chapter-4 case exactly.
  if (!over(ghost.x, ghost.y, 1) && !covers(ghost.x, ghost.y, 1)) return standing;
  const floor = Math.min(1, Math.max(0, Number.isFinite(shrinkFloor) ? shrinkFloor : 1));
  const limit = Number.isFinite(centreLimit) ? centreLimit : SUBJECT_CENTRE_LENS;
  let x = ghost.x, y = ghost.y, shrink = 1;
  const steps = [];
  /**
   * A candidate seat is legal when it is inside the lens and off the caption.
   * Of the legal ones the BEST clears the buttons of both the corners and the
   * rectangles; the GOOD ONE clears the corners, which is the seat this pass
   * has always taken. The loops below keep the first of each and prefer the
   * best, so this pass never returns a worse seat than it used to.
   */
  const legal = (cx, cy) => cy <= riseLimit + 1e-9
    && !hitsCaption(cx, cy, shrink) && inLens(cx, cy, shrink);
  const pick = (gaps, seatOf) => {
    let good;
    for (const gap of gaps.sort((a, b) => a - b)) {
      const [cx, cy] = seatOf(gap);
      if (!legal(cx, cy)) continue;
      if (over(cx, cy, shrink)) continue;
      if (!covers(cx, cy, shrink)) return [cx, cy];
      good = good ?? [cx, cy];
    }
    return good;
  };
  // Raise: lift each offending point out through the top of its row, and lift
  // the whole rectangle out through it too, lowest lift first. A point buried
  // in the column climbs several rows.
  const lifts = [];
  for (const row of rows) {
    for (const point of [...points, ...lit]) {
      const gap = row.top + clearance - moved(point, x, y, shrink).y;
      if (gap > 1e-9) lifts.push(gap);
    }
    const rectGap = row.top + clearance - (y - halfH(shrink));
    if (rectGap > 1e-9) lifts.push(rectGap);
  }
  const raised = pick(lifts, gap => [x, y + gap]);
  if (raised && raised[1] > y + 1e-9) { [x, y] = raised; steps.push('raise'); }
  // Shift right, from wherever the raise left the subject, never past the
  // centre limit: the strand and then the whole rectangle leave through the
  // row's right edge.
  if (over(x, y, shrink) || covers(x, y, shrink)) {
    const gaps = [];
    for (const row of rows) {
      for (const point of [...points, ...lit]) {
        const gap = row.right + clearance - moved(point, x, y, shrink).x;
        if (gap > 1e-9) gaps.push(gap);
      }
      const rectGap = row.right + clearance - (x - halfW(shrink));
      if (rectGap > 1e-9) gaps.push(rectGap);
    }
    const shifted = pick(gaps.filter(gap => x + gap <= limit + 1e-9), gap => [x + gap, y]);
    if (shifted && shifted[0] > x + 1e-9) { [x, y] = shifted; steps.push('shift'); }
  }
  // Shrink about the seat, the most shrink that still clears a button. Points
  // converge on the centre, so bisection finds the largest working size, and
  // the floor is where the search stops rather than what it spends.
  if (over(x, y, shrink)) {
    if (!over(x, y, floor)) {
      let low = floor, high = 1;
      for (let pass = 0; pass < 24; pass += 1) {
        const mid = (low + high) / 2;
        if (over(x, y, mid)) low = mid; else high = mid;
      }
      if (high < 1 - 1e-9) { shrink = high; steps.push('shrink'); }
    } else {
      shrink = floor;
      if (shrink < 1 - 1e-9) steps.push('shrink');
    }
  }
  if (over(x, y, shrink)) return answer(x, y, shrink, 'held');
  return answer(x, y, shrink, steps.length ? steps.join('+') : 'none');
}

/**
 * Move the subject out from behind the MENU, in screen space.
 *
 * `plateAvoidance` above dodges the caption alone, on purpose: the menu is
 * dimmed during a lesson and a ghost crossing a dimmed button still reads. A
 * density chapter is not a ghost: with the whole map at half the lens, the
 * caption dodge lowers it onto the menu column and over 6,260 map pixels draw
 * over Talk and Play.
 * A volume chapter therefore dodges BOTH plates: the caption first, through
 * `plateAvoidance`, then the menu here. Only a volume caller asks; every
 * atomic caller keeps the caption-only seat it always had.
 *
 * The menu is a SIDE column, so its clearance is sideways, not vertical: the
 * seat that wins when one exists is the sidestep just clear of the menu's
 * right edge at full size, and only when that seat stays centred
 * (`SUBJECT_CENTRE_LENS`) and inside the shift wall. Anything else — the menu
 * wider than the centred subject can clear, or on the wrong side — falls
 * through to the full `plateAvoidance` order against the menu rect, which may
 * shrink, shift past centre, or hold and say so.
 *
 * @returns {{x:number, y:number, shrink:number, move:string, axis:string,
 *   centred:boolean, overlap:boolean, rect:object}} like `plateAvoidance`.
 */
export function volumeMenuAvoidance({ subject, menu, clearance = PLATE_CLEARANCE_LENS,
  edge = LENS_EDGE_MARGIN, shrinkFloor = 1, shiftLimit = SUBJECT_SHIFT_LIMIT,
  centreTolerance = SUBJECT_CENTRE_LENS } = {}) {
  const passThrough = (move = 'none', axis = 'none') => ({ x: subject?.x ?? 0, y: subject?.y ?? 0, shrink: 1,
    move, axis, centred: Math.abs(subject?.x ?? 0) <= centreTolerance,
    overlap: false, rect: lensRect({ x: subject?.x ?? 0, y: subject?.y ?? 0,
      halfWidth: subject?.halfWidth ?? 0, halfHeight: subject?.halfHeight ?? 0 }) });
  if (!menu || !(subject?.halfWidth > 0) || !(subject?.halfHeight > 0)) return passThrough();
  if (!lensRectsOverlap(lensRect({ x: subject.x, y: subject.y,
    halfWidth: subject.halfWidth, halfHeight: subject.halfHeight }), menu, clearance)) return passThrough();
  // The menu lives on the left of the lens; a menu anywhere else is a layout
  // this sidestep does not understand, so the general rule takes it.
  const menuCentre = (menu.left + menu.right) / 2;
  if (!(menuCentre < subject.x)) {
    const fell = plateAvoidance({ subject, plate: menu, clearance, edge, shrinkFloor, shiftLimit, centreTolerance });
    return { ...fell, move: fell.move === 'none' ? 'none' : `menu-${fell.move}`, axis: fell.axis };
  }
  // The sidestep at full size, then the same seat bought with size: a subject
  // a few per cent too wide for the centred seat beside the menu keeps its
  // seat and spends the difference, never dropping past `shrinkFloor`. Both
  // keep y, so a seat the caption round cleared stays clear of the caption —
  // the menu is left of the subject and the sidestep only moves right.
  const floor = Math.min(1, Math.max(0, Number.isFinite(shrinkFloor) ? shrinkFloor : 1));
  for (const shrink of [1, Math.max(floor, Math.min(1,
    (centreTolerance - menu.right - clearance) / subject.halfWidth))]) {
    if (!(shrink > 0) || shrink < floor - 1e-12) continue;
    const seat = menu.right + clearance + subject.halfWidth * shrink;
    const cap = (shiftLimit - clearance - menu.right) / (2 * subject.halfWidth * shrink);
    if (Math.abs(seat) <= centreTolerance + 1e-9 && cap >= 1) {
      const rect = lensRect({ x: seat, y: subject.y,
        halfWidth: subject.halfWidth * shrink, halfHeight: subject.halfHeight * shrink });
      const rubbing = lensRectsOverlap(rect, menu, clearance - 1e-9);
      return { x: seat, y: subject.y, shrink, move: shrink >= 1 - 1e-12 ? 'sidestep' : 'sidestep+shrink',
        axis: 'right', centred: true, overlap: rubbing, rect };
    }
  }
  const fell = plateAvoidance({ subject, plate: menu, clearance, edge, shrinkFloor, shiftLimit, centreTolerance });
  return { ...fell, move: fell.move === 'none' ? 'none' : `menu-${fell.move}`, axis: fell.axis };
}

/** The nearest and furthest range of a set of room points from one eye. */
export function pointRange(points, origin) {
  if (!finite3(origin) || !Array.isArray(points) || !points.length) return undefined;
  let near = Infinity, far = 0;
  for (const point of points) {
    if (!finite3(point)) continue;
    const range = Math.hypot(point[0] - origin[0], point[1] - origin[1], point[2] - origin[2]);
    if (!Number.isFinite(range)) continue;
    near = Math.min(near, range); far = Math.max(far, range);
  }
  return Number.isFinite(near) && far > 0 ? { near, far } : undefined;
}

/**
 * The share of plate points the structure draws in front of.
 *
 * This is the pierce, measured rather than looked at: a plate point is
 * occluded when the segment from the eye to it passes through the structure's
 * placed bounding sphere. It is the geometric form of the pixel overlap the
 * a wearer-view frame shows, it is conservative (a bounding sphere is a loose
 * fit around a ribbon, so it can only over-report), and unlike a rendered
 * frame it can be read on every chapter of every run.
 *
 * @returns {{points:number, occluded:number, share:number}}
 */
export function occludedPlateShare({ points, origin, sphere } = {}) {
  const centre = sphere?.centre ?? sphere?.center;
  const radius = sphere?.radius;
  const list = (Array.isArray(points) ? points : []).filter(finite3);
  if (!finite3(origin) || !finite3(centre) || !Number.isFinite(radius) || radius <= 0 || !list.length) {
    return { points: list.length, occluded: 0, share: 0 };
  }
  const toCentre = [centre[0] - origin[0], centre[1] - origin[1], centre[2] - origin[2]];
  let occluded = 0;
  for (const point of list) {
    const ray = [point[0] - origin[0], point[1] - origin[1], point[2] - origin[2]];
    const lengthSquared = ray[0] * ray[0] + ray[1] * ray[1] + ray[2] * ray[2];
    if (!(lengthSquared > 0)) continue;
    const along = (ray[0] * toCentre[0] + ray[1] * toCentre[1] + ray[2] * toCentre[2]) / lengthSquared;
    const nearestOnRay = Math.min(1, Math.max(0, along));
    const offset = [toCentre[0] - ray[0] * nearestOnRay, toCentre[1] - ray[1] * nearestOnRay,
      toCentre[2] - ray[2] * nearestOnRay];
    const distance = Math.hypot(offset[0], offset[1], offset[2]);
    // Touching the sphere at the plate itself is not a pierce: the plate has to
    // be BEHIND molecular surface for the wearer to lose the glyph.
    if (distance < radius && nearestOnRay < 1) occluded += 1;
  }
  return { points: list.length, occluded, share: occluded / list.length };
}
