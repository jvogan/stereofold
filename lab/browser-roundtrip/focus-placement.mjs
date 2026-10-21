import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { Euler } from 'molstar/lib/mol-math/linear-algebra/3d/euler.js';
import { PLATE_CLEARANCE_LENS, PLATE_STANDOFF_METRES, STANDOFF_REACH_METRES, SUBJECT_CENTRE_LENS, SUBJECT_GHOST_LENS_CEILING, SUBJECT_GHOST_LENS_LIMIT, SUBJECT_LENS_CEILING, SUBJECT_LENS_FLOOR, SUBJECT_RISE_CEILING, SUBJECT_WHOLE_LENS_CEILING, ghostButtonAvoidance, lensBounds, lensFraction, lensRect, lensRectFromPoints, lensRectsOverlap, menuAvoidance, plateAvoidance, projectedExtent, standoffFraming, subjectCapShrink, viewBasis, volumeMenuAvoidance } from './plate-standoff.mjs';
import { PLACEMENT_MIN_SCALE, PLACEMENT_MAX_SCALE, PLACEMENT_MAX_TRANSLATION } from './placement-limits.mjs';
import { EYE_TAN_HALF_HORIZONTAL, EYE_TAN_HALF_VERTICAL } from './spatial-toolbar-geometry.mjs';

/**
 * Bring one region of the structure into view without moving the wearer.
 *
 * A headset has no camera a command may set. The head pose is the wearer's
 * and nothing here writes to it; what moves is the structure, through the
 * same saved placement the grab gesture bakes. So "zoom to the PAM" is solved
 * as a placement: put the target's bounding sphere in front of the wearer, at
 * the distance and scale that make it span the asked-for angle.
 *
 * Both numbers below are angular diameters, not sizes. `fill` is about sixty
 * degrees, which is a region held up close and filling most of what the
 * wearer can attend to. `context` is about thirty, which keeps the target
 * clearly the subject while its surroundings stay in frame.
 */
export const FOCUS_FRAMINGS = Object.freeze({ fill: 60, context: 30 });
/**
 * How far above the horizon the target centre sits, so the wearer looks slightly up.
 *
 * This is the default for a one-off `focus_selection`, where a small lift reads
 * as the structure being presented to the wearer. It is NOT what a lesson
 * wants, and callers may override it. Measured on Quest 2 wearer-view captures:
 * in all nine chapters the emphasised part's pixel centre sat 12 to 19 per cent of the
 * lens's height ABOVE the lens centre, while the head-anchored menu — seated
 * level by the same head pose — sat within 3 per cent of it. In chapters 2 and
 * 6 that lift is what pushed the guide RNA, half a lens tall, off the top edge.
 */
const ELEVATION_DEGREES = 8;
/** The distance a focus prefers before scale limits force a different one. */
const PREFERRED_DISTANCE_METRES = 1.2;
const MIN_DISTANCE_METRES = 0.45;
const MAX_DISTANCE_METRES = 8;
/**
 * The largest share of the focus distance a framed sphere's radius may fill.
 *
 * A sphere whose radius equals its distance has its near surface on the
 * wearer's eye, so a framing may approach that and never pass it. `fill` is
 * sixty degrees, an enclosure of .577; the lesson path asks for .85, which is
 * as close as a whole structure comes before it is over the wearer. It is the
 * largest ask this module ACCEPTS, not the one it grants: the plate rule below
 * cuts it to whatever keeps the whole assembly behind the plates.
 */
export const MAX_ENCLOSURE = 0.85;
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/**
 * The rotation half of `viewer.mjs` `placementTransform`, on its own.
 *
 * A focus never turns the structure: the wearer keeps the orientation they
 * set. But the saved rotation still decides where inside the placed structure
 * the target sphere ends up, so solving for the translation needs it.
 */
export function focusRotation(degrees) {
  const [x, y, z] = degrees.map(value => value * Math.PI / 180);
  return Mat4.mul(Mat4(), Mat4.fromRotation(Mat4(), z, Vec3.create(0, 0, 1)),
    Mat4.mul(Mat4(), Mat4.fromRotation(Mat4(), y, Vec3.create(0, 1, 0)), Mat4.fromRotation(Mat4(), x, Vec3.create(1, 0, 0))));
}

/**
 * Everything a chapter's turn sweeps, as points a seat can be solved from.
 *
 * A seat solved from the drawn extent at t=0 holds only while nothing turns.
 * The filament's spin chapters were seated for the tube standing end on to
 * the wearer, and a quarter turn later it lay across far more than the lens,
 * its ends swinging behind the menu and past the wearer. `turn` is the
 * apparent turn of the drawn molecule: a render-space `axis` and signed
 * `degrees` (a full turn or more sweeps the whole circle). `pivot` is the
 * model-space point it turns about and `rotation` the placement rotation,
 * both as `focusPlacement` reads them. The points come back in the same model
 * coordinates, turned through the turn about the pivot in steps of at most
 * 15 degrees and pushed out from the axis by `1 / cos` of half a step, so the
 * arc between two steps lies inside them too and no turn reaches past the
 * extent solved for it. Without a turn they come back unchanged.
 */
export function turnSweptPoints(points, turn, { pivot, rotation } = {}) {
  const list = Array.isArray(points) ? points.filter(finitePoint) : [];
  const axis = turn?.axis?.length === 3 && turn.axis.every(Number.isFinite) ? Vec3.create(...turn.axis) : undefined;
  if (!list.length || !axis || Vec3.magnitude(axis) < 1e-9 || !Number.isFinite(turn.degrees) || turn.degrees === 0
    || !finitePoint(pivot) || rotation?.length !== 3 || !rotation.every(Number.isFinite)) return points;
  // The render-space axis, carried out of the placement into the model frame.
  const local = Vec3.transformDirection(Vec3(), axis, Mat4.transpose(Mat4(), focusRotation(rotation)));
  Vec3.normalize(local, local);
  const full = Math.abs(turn.degrees) >= 360;
  const arc = full ? 360 : turn.degrees;
  const steps = Math.max(1, Math.ceil(Math.abs(arc) / 15));
  const reach = 1 / Math.cos(Math.abs(arc) / steps / 2 * Math.PI / 180);
  const centre = Vec3.create(...pivot), swept = [];
  for (let step = 0; step < steps + (full ? 0 : 1); step++) {
    const turned = Mat4.fromRotation(Mat4(), arc * step / steps * Math.PI / 180, local);
    for (const point of list) {
      const offset = Vec3.transformMat4(Vec3(), Vec3.sub(Vec3(), Vec3.create(...point), centre), turned);
      const along = Vec3.scale(Vec3(), local, Vec3.dot(offset, local));
      const out = Vec3.scale(Vec3(), Vec3.sub(Vec3(), offset, along), reach);
      swept.push(Array.from(Vec3.add(Vec3(), Vec3.add(out, out, along), centre)));
    }
  }
  return swept;
}

/**
 * The pose a grown tier lands in, and the turn that reaches it.
 *
 * A focus never turns the structure — the wearer owns the orientation — and
 * that is right for every framing EXCEPT the one frame after a tier has grown.
 * On Quest 2 captures the second dimer stacked along the viewing axis, so the
 * protofilament drew 51.4 per cent of the lens against the dimer's 51.9: twice
 * the molecule, the same silhouette, and the wearer read the growth step as the
 * strand THICKENING. The long axis has to run across the lens for the step to
 * read as "it got longer".
 *
 * `GROWTH_TILT_DEGREES` is the angle the long axis is held at out of the lens
 * plane: at 35 degrees it projects cos 35 = .82 of its true length across the
 * lens while sin 35 = .57 of it still recedes, which is the depth cue that says
 * this is a solid object seen obliquely rather than a flat drawing. A small
 * `GROWTH_ROLL_DEGREES` inside the lens plane keeps the strand off the exact
 * horizontal, which is the axis the caption plate and the menu column run along.
 *
 * The same canonical pose is what removes the perspective snap into the wall.
 * Every tier lands with its own long axis on THIS direction, so the
 * orientation the wall arrives at differs from the protofilament's by the
 * amount the two coordinate files' own axes differ and by nothing else, and
 * what is left is travelled rather than cut (`growthTurnDurationMs`).
 */
export const GROWTH_TILT_DEGREES = 35;
export const GROWTH_ROLL_DEGREES = 12;
/**
 * The twist a wall-like grown tier lands with, about the same canonical axis
 * the tilt and roll above put across the lens.
 *
 * The tilt and the roll place the tier's long axis; they say nothing about the
 * twist around that axis, which for a filament is invisible and for an open
 * sheet is the whole face the wearer sees. The shortest-arc turn leaves that
 * twist wherever the arrival pose had it, so a wall can land edge-on — its
 * lateral neighbours stacked in depth behind each other — with the beta
 * plus-ends covering the view. The 76aa6ff wall landing read 75.6 per cent
 * amber for exactly this reason. A quarter turn about the landed long axis
 * presents the sheet's broad face instead: the protofilament axis stays across
 * the lens, the lateral neighbours spread across it beside each other, and the
 * alpha/beta alternation along every strand reads evenly. Filament tiers are
 * twist-invariant (their alternation runs along the axis, readable from any
 * side), so sharing this landing with them changes no silhouette — the exact
 * degrees stay a hardware-tunable constant, like the tilt and the roll.
 */
export const GROWTH_WALL_AZIMUTH_DEGREES = 90;
/**
 * How much longer than it is wide a subject must be before it is turned.
 *
 * A monomer is a blob: it has no long axis worth showing and turning it would
 * be motion the wearer cannot read as anything. The ratio is the subject's own
 * half length over the widest distance any of its points stand off that axis.
 */
export const GROWTH_MIN_ELONGATION = 1.25;
/** Below this the pose is already the one asked for, so nothing is travelled. */
export const GROWTH_SNAP_DEGREES = 6;
export const GROWTH_TURN_MIN_MS = 600;
export const GROWTH_TURN_MAX_MS = 1_000;
/** The turn that earns the whole window. Anything larger still lands in it. */
export const GROWTH_TURN_FULL_DEGREES = 120;

/**
 * How long a turn of `deltaDegrees` takes: 0.6 s for a small one, 1.0 s for a
 * large one, never a cut. The bound is the product rule, not an easing detail:
 * the wall must not arrive at a new orientation in one frame.
 */
export function growthTurnDurationMs(deltaDegrees) {
  const delta = Number.isFinite(deltaDegrees) ? Math.abs(deltaDegrees) : 0;
  const share = Math.min(1, Math.max(0, delta / GROWTH_TURN_FULL_DEGREES));
  return Math.round(GROWTH_TURN_MIN_MS + (GROWTH_TURN_MAX_MS - GROWTH_TURN_MIN_MS) * share);
}

const finitePoint = value => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);

/**
 * The long axis of a point cloud, about `centre`, in the points' own frame.
 *
 * Two passes of the standard diameter walk: the point farthest from the centre,
 * then the point farthest from that one. A Mol* boundary's `extrema` are the
 * extreme points along a fixed set of directions, so for a filament the pair
 * this finds is its two ends. `elongation` is what tells a strand from a blob.
 */
export function longestAxis({ points, centre } = {}) {
  const list = (Array.isArray(points) ? points : []).filter(finitePoint);
  if (!finitePoint(centre) || list.length < 2) return undefined;
  const middle = Vec3.create(...centre);
  const farthest = origin => list.reduce((best, point) => {
    const distance = Vec3.distance(Vec3.create(...point), origin);
    return distance > best.distance ? { point, distance } : best;
  }, { point: list[0], distance: -1 });
  const first = farthest(middle).point;
  const second = farthest(Vec3.create(...first)).point;
  const axis = Vec3.sub(Vec3(), Vec3.create(...second), Vec3.create(...first));
  if (Vec3.magnitude(axis) < 1e-6) return undefined;
  Vec3.normalize(axis, axis);
  let halfLength = 0, halfGirth = 0;
  for (const point of list) {
    const offset = Vec3.sub(Vec3(), Vec3.create(...point), middle);
    const along = Vec3.dot(offset, axis);
    halfLength = Math.max(halfLength, Math.abs(along));
    halfGirth = Math.max(halfGirth, Vec3.magnitude(Vec3.sub(Vec3(), offset, Vec3.scale(Vec3(), axis, along))));
  }
  if (halfLength <= 0) return undefined;
  return { axis: Array.from(axis), halfLength, halfGirth,
    elongation: halfGirth > 0 ? halfLength / halfGirth : Infinity };
}

/** ZYX Euler degrees of a rotation matrix, the spelling `placement.rotation` is in. */
export function placementDegrees(matrix) {
  return Array.from(Euler.fromMat4(Euler(), matrix, 'ZYX'), value => value * 180 / Math.PI);
}

/**
 * The placement rotation that puts this subject's long axis across the lens,
 * and the shortest turn from the one it is in now.
 *
 * Everything is solved in the renderer's own frame, because that is the frame
 * `grabRotation` composes in: the wearer's lens axes are carried into it by
 * `renderFromRoom` exactly as `focusPlacement` carries them into the
 * structure's, and the subject's long axis is carried into it by the placement
 * rotation the structure is standing in. The turn is then one shortest arc
 * between two directions, and the caller may ease it over `durationMs` through
 * the same transient a held grip uses.
 *
 * Returns nothing for a subject with no long axis to show, and a turn of zero
 * degrees for one already standing in the pose — both of which the caller
 * treats as "frame it where it is".
 */
export function obliqueGrowthTurn({ headInRoom, renderFromRoom, placement, points, centre,
  tiltDegrees = GROWTH_TILT_DEGREES, rollDegrees = GROWTH_ROLL_DEGREES,
  minElongation = GROWTH_MIN_ELONGATION, azimuthDegrees = 0 } = {}) {
  if (headInRoom?.length !== 16 || renderFromRoom?.length !== 16
    || placement?.rotation?.length !== 3 || !placement.rotation.every(Number.isFinite)) return undefined;
  const ahead = Vec3.create(-headInRoom[8], 0, -headInRoom[10]);
  if (Vec3.magnitude(ahead) < .01) return undefined;
  Vec3.normalize(ahead, ahead);
  const basis = viewBasis(Array.from(ahead));
  if (!basis) return undefined;
  const long = longestAxis({ points, centre });
  if (!long || !(long.elongation >= minElongation)) return undefined;
  const intoRender = axis => {
    const direction = Vec3.create(...axis);
    Vec3.transformDirection(direction, direction, renderFromRoom);
    if (Vec3.magnitude(direction) < 1e-9) return undefined;
    return Vec3.normalize(direction, direction);
  };
  const right = intoRender(basis.right), up = intoRender(basis.up), forward = intoRender(basis.forward);
  if (!right || !up || !forward) return undefined;
  const tilt = (Number.isFinite(tiltDegrees) ? tiltDegrees : GROWTH_TILT_DEGREES) * Math.PI / 180;
  const roll = (Number.isFinite(rollDegrees) ? rollDegrees : GROWTH_ROLL_DEGREES) * Math.PI / 180;
  const wanted = Vec3.create(0, 0, 0);
  Vec3.scaleAndAdd(wanted, wanted, right, Math.cos(tilt) * Math.cos(roll));
  Vec3.scaleAndAdd(wanted, wanted, up, Math.cos(tilt) * Math.sin(roll));
  Vec3.scaleAndAdd(wanted, wanted, forward, Math.sin(tilt));
  Vec3.normalize(wanted, wanted);
  const current = focusRotation(placement.rotation);
  const placed = Vec3.transformDirection(Vec3(), Vec3.create(...long.axis), current);
  if (Vec3.magnitude(placed) < 1e-9) return undefined;
  Vec3.normalize(placed, placed);
  // A long axis has no head and no tail, so the end that travels is whichever
  // one is already nearer: the turn is never more than a right angle.
  if (Vec3.dot(placed, wanted) < 0) Vec3.negate(placed, placed);
  const cosine = Math.min(1, Math.max(-1, Vec3.dot(placed, wanted)));
  const angle = Math.acos(cosine);
  let axis = Vec3.cross(Vec3(), placed, wanted);
  if (Vec3.magnitude(axis) < 1e-9) {
    // Parallel: nothing to turn about, and nothing to turn.
    axis = Vec3.create(0, 1, 0);
  } else Vec3.normalize(axis, axis);
  const delta = Mat4.fromRotation(Mat4(), angle, axis);
  const deltaDegrees = angle * 180 / Math.PI;
  // The wall azimuth, as a twist about the landed long axis. It
  // is composed outside the shortest arc, so the arc itself — `deltaDegrees`,
  // `durationMs`, `before` and `after` — is exactly what it was without one,
  // and the long axis still lands on `wanted`. Only the face around it turns,
  // which is nothing on a filament and the sheet's broad face on a wall.
  const azimuth = (Number.isFinite(azimuthDegrees) ? azimuthDegrees : 0) * Math.PI / 180;
  const landed = Math.abs(azimuth) < 1e-9 ? Mat4.mul(Mat4(), delta, current)
    : Mat4.mul(Mat4(), Mat4.fromRotation(Mat4(), azimuth, wanted), Mat4.mul(Mat4(), delta, current));
  const alongLens = direction => Math.hypot(Vec3.dot(direction, right), Vec3.dot(direction, up));
  return { rotation: placementDegrees(landed),
    axis: Array.from(axis), angleRadians: angle, deltaDegrees,
    turned: deltaDegrees >= GROWTH_SNAP_DEGREES,
    durationMs: growthTurnDurationMs(deltaDegrees),
    tiltDegrees: tilt * 180 / Math.PI, rollDegrees: roll * 180 / Math.PI,
    azimuthDegrees: azimuth * 180 / Math.PI,
    // The share of the subject's own length that reaches the lens, before and
    // after. `after` is cos(tilt) by construction; `before` is what the tier
    // would have been drawn at, which on the protofilament was the defect.
    before: alongLens(placed), after: alongLens(wanted),
    halfLength: long.halfLength, elongation: long.elongation };
}

/**
 * Where placed molecular points land on the lens, as fractions.
 *
 * `points` are in the same untransformed molecular coordinates as
 * `targetCenter`; `rotation` is the saved placement rotation (a focus never
 * turns the structure), `scale` the solved placement scale, and `centre` the
 * room-space seat the target centre was placed at. Room comes back through the
 * inverse of `renderFromRoom`, which is rigid — a rotation plus a seat — so an
 * offset travels by its rotation part alone. Points behind the eye are dropped
 * rather than folded onto the front. The frame is the one every lens share is
 * quoted in: x and y run -1 to +1 across the lens.
 */
export function projectPlacedToLens({ points, targetCenter, rotation, scale, cameraScale,
  renderFromRoom, centre, eye, basis } = {}) {
  const list = (Array.isArray(points) ? points : [])
    .filter(point => Array.isArray(point) && point.length === 3 && point.every(Number.isFinite));
  if (!list.length || !rotation || !renderFromRoom || !(scale > 0) || !(cameraScale > 0)
    || !Array.isArray(targetCenter) || !Array.isArray(centre) || !Array.isArray(eye)
    || !basis?.right || !basis?.up || !basis?.forward) return [];
  let inverse = null;
  try { inverse = Mat4.invert(Mat4(), renderFromRoom); } catch { return []; }
  if (!inverse) return [];
  const out = [];
  for (const point of list) {
    const ox = (point[0] - targetCenter[0]) * scale, oy = (point[1] - targetCenter[1]) * scale,
      oz = (point[2] - targetCenter[2]) * scale;
    const rx = rotation[0] * ox + rotation[4] * oy + rotation[8] * oz;
    const ry = rotation[1] * ox + rotation[5] * oy + rotation[9] * oz;
    const rz = rotation[2] * ox + rotation[6] * oy + rotation[10] * oz;
    const kx = rx * cameraScale, ky = ry * cameraScale, kz = rz * cameraScale;
    const qx = centre[0] + inverse[0] * kx + inverse[4] * ky + inverse[8] * kz;
    const qy = centre[1] + inverse[1] * kx + inverse[5] * ky + inverse[9] * kz;
    const qz = centre[2] + inverse[2] * kx + inverse[6] * ky + inverse[10] * kz;
    const ex = qx - eye[0], ey = qy - eye[1], ez = qz - eye[2];
    const depth = ex * basis.forward[0] + ey * basis.forward[1] + ez * basis.forward[2];
    if (!(depth > 1e-6)) continue;
    out.push({ x: (ex * basis.right[0] + ey * basis.right[1] + ez * basis.right[2])
        / (depth * EYE_TAN_HALF_HORIZONTAL),
      y: (ex * basis.up[0] + ey * basis.up[1] + ez * basis.up[2]) / (depth * EYE_TAN_HALF_VERTICAL) });
  }
  return out;
}

/**
 * The placement that frames `targetCenter`/`targetRadius` for this wearer.
 *
 * `center` and `radius` are the whole structure's own boundary sphere, which
 * is what the saved translation is measured in; the target sphere is the
 * selection's, in the same untransformed molecular coordinates. Room metres
 * and molecular units are related exactly as `room-placement.mjs` relates
 * them: a render-space length is `cameraScale` metres.
 */
export function focusPlacement(options = {}) {
  const { headInRoom, renderFromRoom, cameraScale, center, radius, placement, targetCenter, targetRadius, framing,
  enclosure, assemblyRadius = radius, elevationDegrees = ELEVATION_DEGREES, plateNearMetres, standoffMetres = PLATE_STANDOFF_METRES,
  // The subject's and the structure's boundary `extrema`, in the
  // same untransformed molecular coordinates as `targetCenter` and `center`,
  // and the plate points in room metres. All three are optional: without them
  // the framing falls back to the bounding spheres it used to be solved from,
  // which is a subject as tall and as deep as it is wide.
  // The CAPTION plate's own points, in room metres, which is
  // the only rectangle the screen-space dodge below avoids. Omitted, it falls
  // back to `platePoints` so an older caller behaves as it always did; handed
  // in empty — a panel with no readout drawn — there is nothing to dodge.
// `menuRows` is one drawn-point set per menu button row, in
  // room metres (see `toolbarMenuRowPoints`). After the seat is chosen, the
  // ghost's projected points are checked against one rectangle per row, so a
  // strand may cross the menu column but never lie over a button.
  // `wholeSubjectCeiling` is a density tier's own whole-map lens
  // ceiling, stricter than the atomic whole-structure one. Only a volume
  // caller passes it; every other caller keeps the default below.
  // `avoidMenu` asks for the volume-only sideways menu dodge on
  // top of the caption seat. Only a volume caller passes it: an atomic
  // chapter's ghost may cross a dimmed menu, but a half-lens map drawn over
  // Talk and Play is binocular rivalry, not a ghost
  //. Omitted, the seat below
  // is exactly the one it always was.
  // `sweptTurn` requires the swept assembly to stand in front of the eye,
  // including an end-on short arc that static pocket framing permits inside out.
  // `drawnGains` is this module's OWN later passes talking to
  // themselves. It carries how much wider and taller the wearer saw the granted
  // rectangle drawn on the pass before, so the caps below can be granted on the
  // size the wearer will actually see. See the drawn round at the end of this
  // function. A caller has no reason to set it; a TEST does, pinned at gain 1
  // with `pass` at `DRAWN_GAIN_PASSES`, which is how the framing this
  // replaced can still be measured — `frame.drawn.granted` is then exactly what
  // the captures measured.
  subjectPoints, assemblyPoints, platePoints, captionPoints, menuPoints, menuRows, avoidMenu = false,
  sweptTurn = false, wholeStructure = false, minExtentFraction = 0, subjectCeiling, wholeSubjectCeiling, drawnGains } = options;

  const angle = FOCUS_FRAMINGS[framing];
  if (!angle) throw Error('A focus framing must be fill or context.');
  const given = enclosure === undefined || enclosure === null ? undefined : enclosure;
  if (given !== undefined && (!Number.isFinite(given) || given <= 0 || given > MAX_ENCLOSURE))
    throw Error(`A framing enclosure must be a share of the distance above zero and no more than ${MAX_ENCLOSURE}.`);
  if (headInRoom?.length !== 16 || renderFromRoom?.length !== 16 || center?.length !== 3 || targetCenter?.length !== 3
    || placement?.rotation?.length !== 3 || placement?.translation?.length !== 3
    || ![...headInRoom, ...renderFromRoom, ...center, ...targetCenter, ...placement.rotation, ...placement.translation,
      placement.scale, cameraScale, radius, assemblyRadius, targetRadius].every(Number.isFinite)
    || cameraScale <= 0 || radius <= 0 || assemblyRadius <= 0 || targetRadius <= 0) throw Error('A current tracked room pose is required.');

  /**
   * THE RESOLVED RULE, where the asked-for enclosure and the plate rule meet.
   *
   * `asked` is what the caller wants the subject's radius to be as a share of
   * its distance — either an `enclosure` stated outright (the lesson's
   * whole-structure chapter asks for LESSON_MAX_ENCLOSURE, .85) or the tangent
   * of a named framing's half angle (`fill` is sixty degrees, .577).
   *
   * The plate rule outranks it, both halves of it. `standoffFraming` fits the
   * WHOLE assembly — the lit subject and the ghost around it — to
   * ASSEMBLY_LENS_FRACTION of the lens and returns the distance at which
   * nothing of the assembly is nearer than the plates plus PLATE_STANDOFF_METRES.
   * A bigger subject must never put molecular surface nearer to the eye than
   * the caption and the menu are, so an enclosure is a CEILING the fit may cut,
   * never a floor it must reach: `fit.tanHalfSubject` is `min(asked, cap)`.
   * Inside that bound the whole-structure chapter takes everything the bound
   * allows — its subject IS the assembly, so the cap hands it the full
   * seventy per cent of the lens rather than the sixty degrees (sixty-four per
   * cent) it used to ask for, and `limited` says which rule bit.
   *
   * Distance is then the larger of the preferred 1.2 m and the stand-off
   * floor, and the scale is whatever frames the subject at `halfAngle` there —
   * back and bigger TOGETHER, so honouring the plates costs the subject none of
   * its angular size. Placement uses the shared numerical range, so source
   * units do not impose a framing preference. Only when the required scale
   * falls below that range does the scene-scale fallback shrink the whole
   * plan. At the numerical ceiling the target may arrive smaller; the actual
   * angle below reports that result. Physical lens and plate constraints are
   * solved independently of these numerical bounds.
   */
  const asked = given ?? Math.tan(angle * Math.PI / 360);
  const reachUnits = Vec3.distance(Vec3.create(...targetCenter), Vec3.create(...center)) + assemblyRadius;

  const forward = Vec3.create(-headInRoom[8], 0, -headInRoom[10]);
  if (Vec3.magnitude(forward) < .01) throw Error('Look ahead before bringing a region into view.');
  Vec3.normalize(forward, forward);
  const eye = Vec3.create(headInRoom[12], headInRoom[13], headInRoom[14]);
  /**
   * The eye's own axes, carried into the structure's frame.
   *
   * A projected extent has to be measured along the axes the wearer's lens
   * runs along, and the points to measure are in molecular coordinates, so the
   * axes are the things that travel: room to render space by `renderFromRoom`
   * (rigid — the scene's size lives in `cameraScale`), then out of the saved
   * placement rotation, which is the only rotation a focus does not change.
   */
  const basis = viewBasis(Array.from(forward));
  const outOfPlacement = Mat4.transpose(Mat4(), focusRotation(placement.rotation));
  const intoStructure = axis => {
    const direction = Vec3.create(...axis);
    Vec3.transformDirection(direction, direction, renderFromRoom);
    Vec3.transformDirection(direction, direction, outOfPlacement);
    Vec3.normalize(direction, direction);
    return Array.from(direction);
  };
  const local = basis && { right: intoStructure(basis.right), up: intoStructure(basis.up),
    forward: intoStructure(basis.forward) };
  const subjectExtent = local && projectedExtent({ points: subjectPoints, centre: targetCenter, basis: local });
  const assemblyExtent = local && projectedExtent({ points: assemblyPoints, centre: targetCenter, basis: local });
  // Both or neither: a subject measured against a sphere-sized assembly would
  // be fitted to a ghost that is not the shape the wearer sees either.
  const measured = Boolean(subjectExtent && assemblyExtent);
  const asmWide = measured ? assemblyExtent.halfWidth : reachUnits;
  const asmTall = measured ? assemblyExtent.halfHeight : reachUnits;
  // The assembly's half DEPTH is what decides how close any of it comes to the
  // eye, and it is the one number a bounding sphere gets most wrong: a tier
  // whose long axis runs into the screen has a sphere radius twice its depth.
  const asmDeep = measured ? assemblyExtent.halfDepth : reachUnits;
  // The lesson framing floor, in projected-extent terms: a lesson never frames
  // tighter than a share of the structure, so the subject's projected extent is
  // floored at that share of the assembly's. The sphere path is already floored
  // by its caller, through `targetRadius`.
  const share = Math.max(0, Number.isFinite(minExtentFraction) ? minExtentFraction : 0);
  const wideUnits = measured ? Math.max(subjectExtent.halfWidth, asmWide * share) : targetRadius;
  const tallUnits = measured ? Math.max(subjectExtent.halfHeight, asmTall * share) : targetRadius;
  // A density chapter's whole-map ceiling (0.55 of the lens) is
  // stricter than the atomic whole-structure one (0.70). Only a volume caller
  // passes it; every other caller keeps the default below.
  const wholeCeiling = Number.isFinite(wholeSubjectCeiling) && wholeSubjectCeiling > 0
    ? wholeSubjectCeiling : SUBJECT_WHOLE_LENS_CEILING;
  /**
   * Every lens cap below, restated in the size the wearer SEES.
   *
   * The Quest 2 wall tier is what this is for. Chapter 1 planned
   * the 0.55 whole-subject share exactly and the capture measured 0.596; over
   * the tier's twist the drawn wall ran 0.575 to 0.696. Nothing had gone wrong
   * in the arithmetic — the cap was simply granted on the PRE-ROTATION
   * rectangle, the eye's own axis-aligned extent divided by one seat depth,
   * and what the wearer sees is the perspective projection of the rotated,
   * placed points, whose near corners divide by a shorter depth than the far
   * ones. The gap is the rotation-dependent spread, and it is a property of the
   * chapter's pose, so no constant can absorb it.
   *
   * So the caps are divided by the measured gain: grant `ceiling / gain` and
   * the wearer is drawn `ceiling`. `gain` is `drawnGains`, which the drawn
   * round at the end of this function measures on the final rotated projection
   * and hands to one re-solve of the same framing. The first pass runs at gain
   * 1 and behaves exactly as it always did.
   *
   * `lit` is the lit selection's own drawn half width over the share the record
   * granted it, so it also carries the `minExtentFraction` floor: a chapter
   * whose lit part is a third of the framed region has a lit gain near a third,
   * and SUBJECT_LENS_FLOOR then asks for the framing that draws the LIT part at
   * the floor rather than the framed region. `ghost` and `rise` are the same
   * ratio for the assembly's width and the lit part's height.
   */
  const gain = drawnGain(drawnGains);
  /** The share of the lens to GRANT so the wearer is drawn `share`. */
  const litGrant = share => share / gain.lit;
  const ghostGrant = share => share / gain.ghost;
  const fit = standoffFraming({ tanHalfSubject: asked,
    // The near-clearance reach. Measured, it is the assembly's own depth; a
    // sphere is the conservative answer when nothing was measured.
    reachRatio: asmDeep / wideUnits,
    riseRatio: tallUnits / wideUnits,
    assemblyWidthRatio: asmWide / wideUnits, assemblyRiseRatio: asmTall / wideUnits,
    // The cap is on the PROJECTED width, ghost included. A
    // Quest 2 wall measured 89 per cent of the lens while the grant
    // was a sphere or extrema share at the seat range. Whole-structure
    // chapters take the ghost-included ceiling; a lit part takes the tighter
    // lit ceiling. The assembly ratio holds the ghost to the same named cap.
    // The product band on a measured extent only: the sphere path still solves
    // a fill framing by the assembly cap alone.
    // The whole-structure ceiling is 0.55, so the drawn wall
    // lands about there instead of overrunning a reused 0.60.
    // A whole-map density chapter takes `wholeCeiling` — the
    // volume caller's own whole-map ceiling — where an atomic whole-structure
    // chapter keeps the named constant.
    // And every one of them granted in the size the wearer sees.
    // At gain 1 — the first pass, and every unmeasured caller — these are the
    // named constants unchanged.
    assemblyFraction: ghostGrant(SUBJECT_GHOST_LENS_CEILING),
    subjectFloor: litGrant(SUBJECT_LENS_FLOOR),
    riseCeiling: SUBJECT_RISE_CEILING / gain.rise,
    ...(measured || subjectCeiling !== undefined
      ? { subjectCeiling: litGrant(subjectCeiling ?? (wholeStructure ? wholeCeiling : SUBJECT_LENS_CEILING)) } : {}),
    plateNearMetres, standoffMetres });
  // A swept subject must stay in front of the eye. The pocket/inside-out
  // framing is useful for static selections, but its projection has no safe
  // scale interval for a turn. Bound its depth before projecting any points.
  const sweptDepthLimited = sweptTurn && measured && fit.tanHalfAssembly >= 1;
  const halfAngle = sweptDepthLimited
    ? Math.min(fit.tanHalfSubject, wideUnits / asmDeep * (1 - fit.floorMetres / STANDOFF_REACH_METRES))
    : fit.tanHalfSubject;
  // The framing the same call would have produced with neither rule, kept only
  // so the caller can record what the plate rule cost.
  const unconstrained = (tangent => {
    const want = PREFERRED_DISTANCE_METRES * tangent / (wideUnits * cameraScale);
    const at = clamp(want, PLACEMENT_MIN_SCALE, PLACEMENT_MAX_SCALE);
    return { scale: at, distance: clamp(at * wideUnits * cameraScale / tangent, MIN_DISTANCE_METRES, MAX_DISTANCE_METRES) };
  })(asked);
  const floorMetres = sweptDepthLimited ? STANDOFF_REACH_METRES : Math.min(fit.minDistanceMetres, MAX_DISTANCE_METRES);
  const seat = clamp(Math.max(PREFERRED_DISTANCE_METRES, floorMetres), MIN_DISTANCE_METRES, MAX_DISTANCE_METRES);
  const wanted = seat * halfAngle / (wideUnits * cameraScale);
  const framedScale = clamp(wanted, PLACEMENT_MIN_SCALE, PLACEMENT_MAX_SCALE);
  const nextCameraScale = framedScale > wanted ? cameraScale * wanted / framedScale : cameraScale;
  if (!Number.isFinite(nextCameraScale) || nextCameraScale <= 0) throw Error('That region has no safe XR scene scale.');
  const distance = clamp(Math.max(framedScale * wideUnits * nextCameraScale / halfAngle, floorMetres),
    MIN_DISTANCE_METRES, MAX_DISTANCE_METRES);
  /**
   * WHICH distance this seat came from, written down.
   *
   * `angular` is the preferred 1.2 m — the distance at which the subject's
   * projected half width lands exactly on the share of the lens `standoffFraming`
   * granted it, so the size is the framing's and not a by-product of the plate
   * rule. `standoff-floor` is the plate rule pushing the structure back to keep
   * the assembly behind the glass. `scale-capped` is a target so small that the
   * placement scale ceiling bit first and it arrived smaller than it asked to be.
   *
   * A growth run needed this line to be readable: the dimer and
   * the protofilament both recorded `limited: inside-out`, which zeroes the
   * stand-off floor, so their 1.2 m seats were `angular` and the wearer stood
   * inside the GHOST rather than inside a floored seat. Nothing about the seat
   * distance was what put the subject in the corner of the lens; the dodge was.
   */
  const seatReason = distance < seat - 1e-6 ? 'scale-capped'
    : (floorMetres > PREFERRED_DISTANCE_METRES + 1e-9 ? 'standoff-floor' : 'angular');

  const elevation = (Number.isFinite(elevationDegrees) ? elevationDegrees : ELEVATION_DEGREES) * Math.PI / 180;
  /**
   * The second half of the plate rule, in screen space.
   *
   * The subject's seat is a pair of TANGENT offsets — where it sits on the
   * lens, not where it sits in the room — and the range from the eye is held at
   * the `distance` the stand-off solved, so moving the subject out of the
   * caption's corner costs it none of its angular size and brings it no closer
   * to the glass. An elevation is the same kind of offset, which is why the
   * seat below reduces to the `cos`/`sin` pair it used to be when there is
   * nothing to dodge.
   *
   * And the seat is solved at the size the seat itself makes.
   *
   * The range from the eye is held, so a subject moved off the view axis sits
   * at a smaller DEPTH than its range — `distance / hypot(1, lateral, rise)`,
   * the same divisor the placement below uses — and a projection divides by
   * depth, not by range. Quoting the rectangle at the on-axis size therefore
   * understated it by exactly that factor, and the understatement grows with
   * the very offset the dodge is choosing. On one wall chapter the dodge seated
   * the structure at 0.46 of the lens and called its right edge 0.98; at that
   * offset the wearer's own edge was past 1.0, which is the structure leaving
   * the frame on the right while its left edge came back over the caption.
   *
   * So the two are solved together: seat, re-measure at the depth that seat
   * implies, seat again. Three passes is far more than this needs — the factor
   * is under 1.2 for any seat inside the lens and each pass moves it by less
   * than the last — and the loop stops as soon as it stops moving.
   */
  const lensSize = units => framedScale * units * nextCameraScale / distance;
  const onAxis = { x: 0, y: Math.tan(elevation) / EYE_TAN_HALF_VERTICAL,
    halfWidth: lensFraction(lensSize(wideUnits)), halfHeight: lensSize(tallUnits) / EYE_TAN_HALF_VERTICAL };
  const plateRect = lensRectFromPoints({ points: platePoints, origin: Array.from(eye), basis });
  /**
   * The rectangle the subject is actually seated around.
   *
   * `plateRect` above is every drawn point of the panel — the caption glass AND
   * the menu column under it. On one growth run that union spanned
   * x −0.87..−0.10 and y −0.64..0.84, the whole left half of the lens, and the
   * only seat outside it was hard right against the vignette. The menu is dimmed
   * during a lesson and a ghost drawn across a dimmed button is not what the
   * wearer lost; the caption is the thing that has to read. So the dodge avoids
   * the caption alone, and `plateRect` stays in the record as the wider context
   * the next run is measured against.
   */
  const captionRect = lensRectFromPoints({ points: captionPoints ?? platePoints,
    origin: Array.from(eye), basis });
  /**
   * The caption card and the assistant status card, one rectangle each. The
   * box around both spans the middle of the lens, so a close-up framed in the
   * gap between them, clear of each, was shifted out to the lens edge, or,
   * with the status card beneath the menu column, lowered or raised toward
   * the rim. It stays where it was framed instead. A subject over either
   * card still takes the box's answer.
   */
  const captionPlateRects = (Array.isArray(captionPoints?.plates) ? captionPoints.plates : [])
    .map(points => lensRectFromPoints({ points, origin: Array.from(eye), basis })).filter(Boolean);
  const clearOfCaptions = subject => captionPlateRects.length > 1
    && !captionPlateRects.some(rect => lensRectsOverlap(lensRect(subject), rect, PLATE_CLEARANCE_LENS));
  /**
   * The four button rows, no caption. After the caption seat the whole
   * projected subject (ghost included) is checked against this, and one
   * rectangle per row keeps the ghost strand off the buttons after the seat is
   * chosen.
   */
  const menuRect = lensRectFromPoints({ points: menuPoints, origin: Array.from(eye), basis });
  // The same rectangle, for the volume-only sideways dodge below.
  // Undefined unless a volume caller asked for it and handed points in:
  // without either there is no menu to clear and no `frame.menu` record of one.
  const volumeMenuRect = avoidMenu === true ? menuRect : undefined;
  const buttonRects = (Array.isArray(menuRows) ? menuRows : [])
    .map(row => lensRectFromPoints({ points: row, origin: Array.from(eye), basis }))
    .filter(Boolean);
  const wholeRatioW = wideUnits > 0 ? asmWide / wideUnits : 1;
  const wholeRatioH = tallUnits > 0 ? asmTall / tallUnits : 1;
  // A chapter that IS the structure draws about 0.55, not the 0.60 the ghost
  // ceiling grants a part chapter's ghost. A Quest 2 capture drew a whole wall
  // at 61.8 per cent against the 0.60 cap: the cap was granted on the on-axis
  // width and the off-axis spread spent the difference.
  // A whole-map density chapter seats under `wholeCeiling`, the
  // volume caller's own ceiling, not the atomic whole-structure constant.
  const litCap = subjectCeiling ?? (wholeStructure || wholeRatioW <= 1 + 1e-6 ? wholeCeiling : SUBJECT_LENS_CEILING);
  /** How much wider than its on-axis size a subject seated here draws. */
  const spreadAt = (x, y) => Math.hypot(1, x * EYE_TAN_HALF_HORIZONTAL, y * EYE_TAN_HALF_VERTICAL);
  // The cap is the precedence in `subjectCapShrink`. The lit
  // floor wins over the ghost ceiling, and the ghost may run to
  // SUBJECT_GHOST_LENS_LIMIT before the lit part shrinks below its floor —
  // but only for a ghost that is measured, because only a drawn ribbon can be
  // wider than the lens and still be a thing on it. The sphere path's reach
  // is a bound the wearer may stand inside, and the old rule holds there:
  // never shrink a framing to make an inside-out ghost fit.
  // And the same precedence, restated in the size the wearer
  // sees. Every share here is an on-axis grant, so each named cap is divided
  // by its own drawn gain before it is spent.
  const shareShrink = (litW, wholeW) => subjectCapShrink({ litHalfWidth: litW, wholeHalfWidth: wholeW,
    litCeiling: measured ? litGrant(litCap) : undefined, floor: litGrant(SUBJECT_LENS_FLOOR),
    ghostCeiling: ghostGrant(SUBJECT_GHOST_LENS_CEILING), ghostLimit: ghostGrant(SUBJECT_GHOST_LENS_LIMIT),
    ghostOnLens: measured });
  /** The lit part's floor, as an on-axis share: what draws SUBJECT_LENS_FLOOR. */
  const litFloorShare = litGrant(SUBJECT_LENS_FLOOR);
  const scaleFloor = Math.min(1, PLACEMENT_MIN_SCALE / framedScale);
  const seatFor = spread => {
    const litW = onAxis.halfWidth * spread, litH = onAxis.halfHeight * spread;
    const cap = shareShrink(litW, litW * wholeRatioW);
    const subject = { x: onAxis.x, y: onAxis.y, halfWidth: litW * cap, halfHeight: litH * cap };
    const litFloor = Math.max(subject.halfWidth > 0 ? Math.min(1, litFloorShare / subject.halfWidth) : 1,
      scaleFloor);
    const boxed = plateAvoidance({ subject, plate: captionRect, shrinkFloor: litFloor });
    const dodge = clearOfCaptions(subject) ? plateAvoidance({ subject }) : boxed;
    const ghost = { x: dodge.x, y: dodge.y,
      halfWidth: dodge.rect.halfWidth * wholeRatioW, halfHeight: dodge.rect.halfHeight * wholeRatioH };
    const ghostFloor = ghost.halfWidth > 0
      ? Math.max(Math.min(1, (litFloorShare * wholeRatioW) / ghost.halfWidth), scaleFloor)
      : 1;
    const menu = menuAvoidance({ subject: ghost, menu: menuRect, caption: captionRect,
      shrinkFloor: ghostFloor, centreLimit: SUBJECT_CENTRE_LENS,
      // A menu must not lift a level focus to the lens rim. Caption placement
      // and an explicitly elevated focus retain their own seat; menu avoidance
      // may spend only the remaining middle band, then shift/shrink or hold.
      riseLimit: Math.max(SUBJECT_CENTRE_LENS, dodge.y) });
    return { subject, dodge, menu, cap };
  };
  let spread = spreadAt(onAxis.x, onAxis.y);
  let seated = seatFor(spread);
  for (let pass = 0; pass < 3; pass += 1) {
    const next = spreadAt(seated.menu.x, seated.menu.y);
    if (Math.abs(next - spread) < 1e-4) break;
    spread = next; seated = seatFor(spread);
  }
  const aim = seated.subject;
  const dodge = seated.dodge;
  const menu = seated.menu;
  /**
   * The ghost strand off the buttons, after the seat is
   * chosen. The ghost's assembly points are placed at the menu-pass seat —
   * the translation below is still solved from the seat this pass leaves —
   * and projected to the lens, so a strand over a button row is a measured
   * point inside a measured rectangle rather than a rectangle crossing a
   * column. The pass moves the whole subject rigidly: raise, then shift right
   * within the centre band, then shrink. The menu and the caption never move.
   */
  let menuScale = clamp(framedScale * seated.cap * dodge.shrink * menu.shrink, PLACEMENT_MIN_SCALE, PLACEMENT_MAX_SCALE);
  const menuLateral = menu.x * EYE_TAN_HALF_HORIZONTAL, menuRise = menu.y * EYE_TAN_HALF_VERTICAL;
  const menuDepth = distance / Math.hypot(1, menuLateral, menuRise);
  if (sweptDepthLimited) menuScale = Math.min(menuScale, (menuDepth - fit.floorMetres) / (asmDeep * nextCameraScale));
  const menuCentre = Vec3.clone(eye);
  Vec3.scaleAndAdd(menuCentre, menuCentre, forward, menuDepth);
  Vec3.scaleAndAdd(menuCentre, menuCentre, Vec3.create(...basis.right), menuLateral * menuDepth);
  Vec3.scaleAndAdd(menuCentre, menuCentre, Vec3.create(...basis.up), menuRise * menuDepth);
  const atMenuSeat = points => projectPlacedToLens({ points, targetCenter,
    rotation: focusRotation(placement.rotation), scale: menuScale, cameraScale: nextCameraScale,
    renderFromRoom, centre: menuCentre, eye: Array.from(eye), basis });
  const ghostLensPoints = atMenuSeat(assemblyPoints);
  // And the lit selection's own points, which are inside the
  // assembly's extrema and so are not in the set above.
  const litLensPoints = atMenuSeat(subjectPoints);
  const ghostFloorFinal = menu.rect.halfWidth > 0
    ? Math.max(Math.min(1, (litFloorShare * wholeRatioW) / menu.rect.halfWidth), scaleFloor)
    : 1;
  const ghosted = ghostButtonAvoidance({ ghost: { x: menu.x, y: menu.y,
      halfWidth: menu.rect.halfWidth, halfHeight: menu.rect.halfHeight },
    ghostPoints: ghostLensPoints, litPoints: litLensPoints,
    buttons: buttonRects, menu: menuRect, caption: captionRect,
    // The caption guard is the lit part's, so a ghost twice its lit width can
    // still be raised or shifted past a button without dragging the lit
    // strand over the caption plate. Same extents as `frame.subject` below.
    litHalfWidth: wholeRatioW > 0 ? menu.rect.halfWidth / wholeRatioW : menu.rect.halfWidth,
    litHalfHeight: wholeRatioH > 0 ? menu.rect.halfHeight / wholeRatioH : menu.rect.halfHeight,
    shrinkFloor: ghostFloorFinal, centreLimit: SUBJECT_CENTRE_LENS,
    riseLimit: Math.max(SUBJECT_CENTRE_LENS, dodge.y) });
  let scale = clamp(menuScale * ghosted.shrink, PLACEMENT_MIN_SCALE, PLACEMENT_MAX_SCALE);
  /**
   * The volume round, after every atomic pass has had its say.
   *
   * The caption dodge lowers a tall subject under the caption glass, which is
   * exactly where the menu column stands — every volume seat measured cleared
   * the caption and crossed the menu, over 6,260 map pixels drawn across Talk
   * and Play.
   * The passes above may honestly HOLD rather than clear that crossing: a
   * half-lens map has nowhere left to rise to. So a volume caller gets one more
   * step, and its clearance is SIDEWAYS: the sidestep just clear of the menu's
   * right edge at full size when that seat stays centred and inside the shift
   * wall, else the same seat bought with size. y never moves, so a
   * caption-cleared seat stays caption-clear. An atomic caller never reaches
   * here — `volumeMenuRect` is undefined unless `avoidMenu` asked for it.
   */
  let seatX = ghosted.x, seatY = ghosted.y, seatRect = ghosted.rect, volumeShrink = 1;
  let menuDodge = null;
  if (volumeMenuRect) {
    const floor = Math.max(seatRect.halfWidth > 0
      ? Math.min(1, (litFloorShare * wholeRatioW) / seatRect.halfWidth) : 1, scaleFloor);
    menuDodge = volumeMenuAvoidance({ subject: seatRect, menu: volumeMenuRect, shrinkFloor: floor });
    if (menuDodge.move !== 'none') {
      seatX = menuDodge.x; seatY = menuDodge.y; seatRect = menuDodge.rect;
      volumeShrink *= menuDodge.shrink;
    }
  }
  // Hold the DRAWN width inside an explicitly passed ceiling. The
  // fit grants the ceiling on the on-axis size and the off-axis spread then
  // spends a few per cent past it — a lowered 0.55 subject draws 0.57. Only a
  // volume caller passes `wholeSubjectCeiling`, so only a volume seat pays
  // this; the product floor still bounds it and the record keeps both numbers.
  const ceilingShare = Number.isFinite(wholeSubjectCeiling) && wholeSubjectCeiling > 0 ? wholeSubjectCeiling : 0;
  if (ceilingShare > 0 && seatRect.halfWidth > ceilingShare) {
    const compensation = Math.max(
      Math.min(1, SUBJECT_LENS_FLOOR / seatRect.halfWidth),
      Math.min(1, ceilingShare / seatRect.halfWidth));
    if (compensation < 1) {
      seatRect = lensRect({ x: seatX, y: seatY,
        halfWidth: seatRect.halfWidth * compensation, halfHeight: seatRect.halfHeight * compensation });
      volumeShrink *= compensation;
    }
  }
  scale = clamp(scale * volumeShrink, PLACEMENT_MIN_SCALE, PLACEMENT_MAX_SCALE);
  // The overlaps the ring is read against, measured on the FINAL
  // rect. Any round above may have moved or shrunk the seat since its own check
  // ran (a menu raise can land back under the caption; compensation can lift a
  // seat off both), so both are re-measured here rather than trusted from the
  // rounds. Only the volume record reads them; the atomic record keeps the
  // verdicts its own passes returned.
  const captionOverlapFinal = captionRect
    ? lensRectsOverlap(seatRect, captionRect, PLATE_CLEARANCE_LENS - 1e-9) : false;
  const menuOverlapFinal = menuRect
    ? lensRectsOverlap(seatRect, menuRect, PLATE_CLEARANCE_LENS - 1e-9) : false;
  const lateralTangent = seatX * EYE_TAN_HALF_HORIZONTAL, riseTangent = seatY * EYE_TAN_HALF_VERTICAL;
  const depth = distance / Math.hypot(1, lateralTangent, riseTangent);
  const point = Vec3.clone(eye);
  Vec3.scaleAndAdd(point, point, forward, depth);
  Vec3.scaleAndAdd(point, point, Vec3.create(...basis.right), lateralTangent * depth);
  Vec3.scaleAndAdd(point, point, Vec3.create(...basis.up), riseTangent * depth);
  const range = distance;
  // The seat in room metres, kept before `point` is carried into
  // render space, because the drawn round below projects the placed points from
  // exactly here — the same centre, scale and scene scale the wearer's frame
  // will be drawn with.
  const seatCentreRoom = Array.from(point);
  if (sweptDepthLimited) scale = Math.min(scale, (depth - fit.floorMetres) / (asmDeep * nextCameraScale));
  /**
   * The last word, on the drawn rectangle, and it only ever
   * shrinks.
   *
   * The round below re-solves the framing until the grant lands the drawn
   * extent on its cap, and it stops inside `DRAWN_GAIN_TOLERANCE` rather than
   * on it — a thousandth or two of the lens either side. Either side is the
   * problem: a ceiling the wearer is measured against must not be exceeded by
   * a rounding, and a capture reading 0.552 against a 0.55 rule is a failed
   * chapter however small the miss. So the converged seat is measured once more
   * and cut to fit, never grown: a shrink about the seat centre moves nothing
   * and costs the plates nothing, so it is always safe to take, where a growth
   * would spend the stand-off clearance the whole module exists to keep.
   */
  const drawnFrom = (points, atScale) => lensBounds(projectPlacedToLens({ points, targetCenter,
    rotation: focusRotation(placement.rotation), scale: atScale, cameraScale: nextCameraScale,
    renderFromRoom, centre: seatCentreRoom, eye: Array.from(eye), basis }));
  // The extents the GRANT drew, measured before the cut below takes any of them
  // away. The round's gains are this ratio and nothing else: measuring them
  // after the cut would read the cut as more spread, grant more to compensate,
  // and cut more again — a chapter shrinking itself to a speck one pass at a
  // time. The cut is the last word, not an input.
  const grantLit = measured ? drawnFrom(subjectPoints, scale) : undefined;
  const grantGhost = measured ? drawnFrom(assemblyPoints, scale) : undefined;
  /**
   * Who the round runs for: a measured ATOMIC chapter, and nobody else.
   *
   * A density caller already holds its drawn width inside its own ceiling, in
   * the mapch4 compensation above, and it dodges the menu sideways where an
   * atomic chapter tolerates the crossing. Two rules for one number is how a
   * map ends up solved twice and seated smaller than either rule asked for, so
   * the volume tier keeps the one it has. `wholeSubjectCeiling` and `avoidMenu`
   * are the two things only a volume caller ever passes.
   */
  const drawnRound = measured && wholeSubjectCeiling === undefined && avoidMenu !== true;
  if (sweptDepthLimited) {
    // Perspective near the eye is nonlinear: a proportional cut can throw
    // away almost the entire subject. Bisect the valid depth interval for
    // the largest scale that satisfies the same width and height caps.
    let low = 0, high = scale;
    for (let i = 0; i < 32; i++) {
      const candidate = (low + high) / 2;
      const lit = drawnFrom(subjectPoints, candidate), ghost = drawnFrom(assemblyPoints, candidate);
      const fits = subjectCapShrink({ litHalfWidth: lit?.halfWidth, wholeHalfWidth: ghost?.halfWidth,
        litCeiling: litCap, ghostOnLens: true }) >= 1 - 1e-9 && lit?.halfHeight <= SUBJECT_RISE_CEILING;
      if (fits) low = candidate; else high = candidate;
    }
    scale = low;
  } else if (drawnRound) {
    const cut = Math.min(
      // The width band, in the precedence `subjectCapShrink` owns: the ghost
      // limit outranks the lit floor, the lit floor outranks the ghost ceiling.
      subjectCapShrink({ litHalfWidth: grantLit?.halfWidth, wholeHalfWidth: grantGhost?.halfWidth,
        litCeiling: litCap, ghostOnLens: true }),
      // and the height of the lens, which no band above measures.
      grantLit?.halfHeight > SUBJECT_RISE_CEILING ? SUBJECT_RISE_CEILING / grantLit.halfHeight : 1);
    if (cut < 1 - 1e-9) scale = clamp(scale * cut, PLACEMENT_MIN_SCALE, PLACEMENT_MAX_SCALE);
  }
  // The placed assembly, in room metres, before `point` is carried into render
  // space below. The caller measures the pierce against this and nothing else.
  // A placed length is metres only through the scene scale the
  // plan lands in, so the pierce is measured in `nextCameraScale` and the
  // `before` framing in the one the caller came in with.
  const assemblyAt = (centre, atDistance, atScale, atCameraScale) => {
    const metres = units => atScale * units * atCameraScale;
    // The sphere is kept for the pierce, which the caller measures ray by ray
    // and which must stay conservative; the near and far faces are the
    // assembly's own depth, which is what the stand-off was solved against.
    const reach = metres(reachUnits), deep = metres(asmDeep);
    return { centre: Array.from(centre), radiusMetres: reach, depthMetres: deep, distanceMetres: atDistance,
      nearestMetres: atDistance - deep, farthestMetres: atDistance + deep,
      // Shares of the lens the wearer's own view can be measured for, because
      // they are the projected rectangle and not a sphere's silhouette.
      // `subjectLens` once read 0.4 while the capture read 0.32; these two now
      // mean the same thing.
      subjectFraction: lensFraction(metres(wideUnits) / atDistance),
      subjectRise: metres(tallUnits) / (atDistance * EYE_TAN_HALF_VERTICAL),
      assemblyFraction: lensFraction(reach / atDistance),
      assemblyWide: lensFraction(metres(asmWide) / atDistance),
      assemblyTall: metres(asmTall) / (atDistance * EYE_TAN_HALF_VERTICAL) };
  };
  const assembly = assemblyAt(point, range, scale, nextCameraScale);
  const before = assemblyAt(Vec3.scaleAndAdd(Vec3.clone(eye), eye, forward, unconstrained.distance),
    unconstrained.distance, unconstrained.scale, cameraScale);

  // Room metres to the molecule's own render space, the way roomPlacement does.
  // The scene scale this plan lands on is the one the position is solved in,
  // so an escape above moves the structure and its frame together.
  Vec3.transformMat4(point, point, renderFromRoom);
  Vec3.scale(point, point, 1 / nextCameraScale);
  // placementTransform puts the target sphere's centre at
  // `rotation·(scale·(targetCenter − center)) + center + translation·radius`.
  // Everything but the translation is known, so this is one subtraction.
  const inner = Vec3.scale(Vec3(), Vec3.sub(Vec3(), Vec3.create(...targetCenter), Vec3.create(...center)), scale);
  Vec3.transformMat4(inner, inner, focusRotation(placement.rotation));
  Vec3.sub(point, point, Vec3.add(Vec3(), Vec3.create(...center), inner));
  Vec3.scale(point, point, 1 / radius);
  if (Array.from(point).some(value => !Number.isFinite(value) || Math.abs(value) > PLACEMENT_MAX_TRANSLATION))
    throw Error('That region is outside the current placement range. Bring the structure closer first.');
  // The angle actually achieved, not the one asked for. A target small enough
  // to hit both the scale ceiling and the near-distance floor arrives smaller
  // than sixty degrees, and saying so is cheaper than pretending otherwise.
  const achieved = 2 * Math.atan(scale * wideUnits * nextCameraScale / distance) * 180 / Math.PI;
  /**
   * THE DRAWN ROUND — what the wearer will actually see.
   *
   * Everything above is solved on rectangles: an eye-aligned extent measured
   * about the subject's centre, divided by one seat depth. The frame the wearer
   * gets is the perspective projection of the ROTATED, PLACED points, and the
   * two differ by the chapter's own pose — a wall turned 30 degrees out of the
   * lens plane puts its near edge at a shorter depth than its far one and draws
   * wider than any rectangle said it would. The Quest 2 tier is the
   * proof: chapter 1 planned 0.55 and drew 0.596, and over the twist the wall
   * ran 0.575 to 0.696 against the same 0.55 grant.
   *
   * So the drawn extents are measured here, from the seat this plan landed on,
   * and recorded. When they differ from what was granted by more than
   * `DRAWN_GAIN_TOLERANCE`, the same framing is solved again with the measured
   * gains, which divide every cap so the grant lands the DRAWN extent on the
   * named limit.
   *
   * It iterates, and it has to. If the drawn extent were proportional to the
   * grant, one pass would land it exactly; it is not, because the spread that
   * makes the two differ is itself a function of size — a wall that fills the
   * seat's depth spreads hard, and the same wall at half the size spreads
   * barely at all. So each pass composes its measurement onto the gain it was
   * solved with and the sequence walks in, which for a Quest 2 seat is two or
   * three passes. `DRAWN_GAIN_PASSES` is the wall: a chapter still moving after
   * that keeps the last seat, which is a legal one — every pass is solved by
   * the same rules — rather than a loop the frame clock pays for.
   *
   * Unmeasured callers — no subject or assembly points — never enter it. Their
   * "extent" is a bounding sphere the wearer may be standing inside, and a
   * sphere has no pose to spread.
   */
  const drawnLit = measured ? drawnFrom(subjectPoints, scale) : undefined;
  const drawnGhost = measured ? drawnFrom(assemblyPoints, scale) : undefined;
  const nextGains = measured ? drawnGain(drawnLensGains({ drawnLit: grantLit, drawnGhost: grantGhost,
    grantedLit: seatRect.halfWidth / wholeRatioW, grantedGhost: seatRect.halfWidth,
    grantedRise: seatRect.halfHeight / wholeRatioH, previous: gain })) : gain;
  if (drawnRound && !sweptDepthLimited && (drawnGains?.pass ?? 0) < DRAWN_GAIN_PASSES && drawnGainsMoved(gain, nextGains))
    return focusPlacement({ ...options,
      drawnGains: { ...dampedGain(gain, nextGains), pass: (drawnGains?.pass ?? 0) + 1 } });
  return { translation: Array.from(point), scale, framing, distance: range, angleDegrees: achieved,
    targetRoom: seatCentreRoom, targetLens: [seatX, seatY],
    // The scene scale the caller must be in for this placement
    // to mean what it says. It is the one it passed in unless the floor bit.
    cameraScale: nextCameraScale, usedCameraScale: nextCameraScale !== cameraScale,
    // The enclosure the plan actually landed on, which is the one asked for
    // only when the plate rule left it alone.
    enclosure: halfAngle, askedEnclosure: asked,
    // What the plates are owed, what they got, and what the
    // same framing would have done without the rule. A caller records all
    // three; the wearer only ever sees the middle one.
    standoff: { plateNearMetres: fit.plateNearMetres, floorMetres: fit.floorMetres,
      minDistanceMetres: sweptDepthLimited ? floorMetres : fit.minDistanceMetres, limited: fit.limited,
      clears: assembly.nearestMetres >= fit.floorMetres - 1e-6, assembly, before,
      // What the plates were granted once the reach cap had its
      // say, and whether the subject was measured or merely bounded. A run
      // whose `measured` is false is one where no boundary extrema reached the
      // solver, and its lens shares are sphere silhouettes again.
      measured, grantedStandoffMetres: fit.grantedStandoffMetres, reachLimited: fit.reachLimited,
      // The two rectangles, in lens fractions, so the next run proves the
      // overlap is gone from the ring rather than from a screenshot.
      // x and y run -1 to +1 across the lens; `axis` is the way the subject was
      // moved out from behind the glass and `shrink` what that cost it.
      // `fitted` is the share of the lens the subject covered
      // BEFORE the dodge, at the size the wearer sees it, and `spread` is how
      // much of that is the off-axis widening. Without the pair, a ring line
      // reading `limited: lens-ceiling` beside `subjectLens: 0.52` gives no way
      // to see that the solver did grant the whole-structure 0.70 and that the
      // scale ceiling and the dodge spent the difference.
      // `seatReason` says which distance the seat came from,
      // `caption` is the rectangle the dodge actually avoided (`plate` is still
      // the whole panel, for context), `move` is the step that won — `lower`,
      // `shrink+lower`, `shift`, `held` — and `centred` is the product rule,
      // true when the subject's centre is inside
      // SUBJECT_CENTRE_LENS of the middle of the lens.
      seatReason,
      // `share.wide` / `share.tall` are the DRAWN width and height
      // of the seated subject as shares of the lens — the spread-inclusive
      // numbers a capture measures, not what the fit granted — beside the
      // ghost pair (`whole` the ghost, `lit` the lit part). `menu.overlap`
      // is the final seat re-measured against the menu rectangle, and
      // `menu.volume` is the sideways round's own verdict; `menu` itself is
      // null when no menu points were handed in.
      frame: { subject: lensRect({ x: seatX, y: seatY,
        halfWidth: seatRect.halfWidth / wholeRatioW, halfHeight: seatRect.halfHeight / wholeRatioH }),
        plate: plateRect ?? null, caption: captionRect ?? null,
        // Match volumeMenuAvoidance's boundary tolerance: a tighter menu can
        // seat at 0.15000000000000002 without leaving the 0.15 centre band.
        axis: dodge.axis, move: dodge.move, centred: Math.abs(seatX) <= SUBJECT_CENTRE_LENS + 1e-9,
        shrink: seated.cap * dodge.shrink * menu.shrink * ghosted.shrink * volumeShrink,
        overlap: volumeMenuRect ? captionOverlapFinal : (dodge.overlap || menu.overlap),
        elevationTangent: aim.y, fitted: aim.halfWidth,
        spread: volumeMenuRect ? spreadAt(seatX, seatY) : spread,
        menu: { rect: menuRect ?? null, move: menu.move, cleared: menu.cleared,
          // The strand's own verdict. `crossed` is whether the
          // ghost rectangle still crosses the menu column (allowed); `cleared`
          // is whether no ghost point lies over a button (required).
          // `covered` is whether a button row is still under the
          // ghost's or the lit part's RECTANGLE, which is what a capture shows
          // and what eight corners kept missing.
          ghost: { crossed: ghosted.crossed, cleared: ghosted.cleared, covered: ghosted.covered },
          overlap: menuOverlapFinal,
          volume: menuDodge ? { move: menuDodge.move, axis: menuDodge.axis,
            centred: menuDodge.centred, shrink: menuDodge.shrink } : null },
        // `drawn` is the FINAL ROTATED PROJECTION — the lit
        // selection's and the assembly's own placed points projected from this
        // seat, which is the number a capture measures and the one every cap
        // above was granted against on the second pass. `gain` is how far the
        // granted rectangle was from it, so a ring line reading `lit: 0.408`
        // beside `drawn.lit: 0.208` names the gap instead of hiding it.
        // `drawn` is null for an unmeasured caller: a bounding sphere has no
        // pose to project.
        // `granted` is the same three measured BEFORE the final cut — what the
        // grant on its own would have drawn. Pinned at gain 1 it is the number
        // this work was opened for: the wall tier's 0.575 to 0.696 against a
        // 0.55 grant.
        drawn: drawnLit && drawnGhost ? { lit: drawnLit.halfWidth, whole: drawnGhost.halfWidth,
          litRise: drawnLit.halfHeight, wholeRise: drawnGhost.halfHeight,
          // Where each drawn rectangle sits, which is not quite `subject.x/y`:
          // perspective moves an off-axis silhouette's middle as well as
          // widening it, and a button is under the rectangle or it is not.
          litAt: [drawnLit.x, drawnLit.y], wholeAt: [drawnGhost.x, drawnGhost.y],
          granted: { lit: grantLit.halfWidth, whole: grantGhost.halfWidth,
            litRise: grantLit.halfHeight, wholeRise: grantGhost.halfHeight,
            litAt: [grantLit.x, grantLit.y], wholeAt: [grantGhost.x, grantGhost.y] },
          gain: { lit: nextGains.lit, ghost: nextGains.ghost, rise: nextGains.rise },
          resolved: drawnGains !== undefined } : null,
        share: { whole: seatRect.halfWidth, lit: seatRect.halfWidth / wholeRatioW,
          wide: seatRect.halfWidth, tall: seatRect.halfHeight } } } };
}

/**
 * The gains, made safe to divide a cap by.
 *
 * A gain is a measurement of a projection, so it can come back degenerate — a
 * chapter the wearer is standing inside drops every point behind the eye, a
 * near-edge-on wall measures a sliver. Dividing a cap by either would hand the
 * fit a nonsense ask, so the band below is what a gain may be: from an eighth
 * to eight times the granted rectangle. Outside it the cap is granted as it
 * always was, which is the behaviour every unmeasured caller already has.
 */
export const DRAWN_GAIN_MIN = 0.125;
export const DRAWN_GAIN_MAX = 8;
/** How far a gain must move before the framing is worth solving again. */
export const DRAWN_GAIN_TOLERANCE = 0.005;
/** How many times the drawn round may solve the framing again. */
export const DRAWN_GAIN_PASSES = 12;
function drawnGain(gains) {
  const one = value => (Number.isFinite(value) && value >= DRAWN_GAIN_MIN && value <= DRAWN_GAIN_MAX
    ? value : 1);
  return { lit: one(gains?.lit), ghost: one(gains?.ghost), rise: one(gains?.rise) };
}
/**
 * The drawn half extents over the shares this seat actually granted them.
 *
 * The denominators are the seat's own rectangle, not the caps, so each ratio is
 * this pass's gain outright and nothing composes: a pass solved at gain 0.5
 * that draws exactly what it granted has a gain of 1 and the loop stops there.
 * `previous` is only what an unmeasurable extent falls back to.
 */
function drawnLensGains({ drawnLit, drawnGhost, grantedLit, grantedGhost, grantedRise, previous } = {}) {
  const ratio = (drawn, granted, before) => (Number.isFinite(drawn) && drawn > 0
    && Number.isFinite(granted) && granted > 0 ? drawn / granted : (before ?? 1));
  return { lit: ratio(drawnLit?.halfWidth, grantedLit, previous?.lit),
    ghost: ratio(drawnGhost?.halfWidth, grantedGhost, previous?.ghost),
    rise: ratio(drawnLit?.halfHeight, grantedRise, previous?.rise) };
}
/** Is the measured gain far enough from the one this pass used to re-solve? */
function drawnGainsMoved(used, next) {
  return ['lit', 'ghost', 'rise'].some(key => Math.abs(next[key] - used[key]) > DRAWN_GAIN_TOLERANCE);
}
/**
 * The gain the next pass is solved with: halfway, in the log, between the one
 * this pass used and the one it measured.
 *
 * Stepping straight onto the measurement diverges, and the wall tier is where
 * it shows. A steeply tilted chapter's spread is strongly size-dependent — the
 * drawn height of the 60-degree wall more than doubles between one grant and
 * the next — so a jump to `cap / measured` overshoots, the next measurement
 * overshoots back, and the framing rings between a wall off the top of the lens
 * and a speck. Halving the step in the log keeps the direction and kills the
 * ring: the sequence is monotone in practice and lands in two or three passes
 * where the undamped one never lands at all.
 */
function dampedGain(used, measured) {
  const half = key => Math.sqrt(Math.max(1e-6, used[key]) * Math.max(1e-6, measured[key]));
  return { lit: half('lit'), ghost: half('ghost'), rise: half('rise') };
}

/** Ease in and out, so the travel starts and settles rather than snapping. */
const ease = u => u < .5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;

/**
 * How long past its own duration a travel waits for a frame before landing.
 *
 * Quest Browser stops servicing the window's `requestAnimationFrame` for the
 * whole length of an immersive session — only `XRSession.requestAnimationFrame`
 * runs. That turned chapter 2 of the CRISPR lesson into a permanent hang on
 * real hardware: the emphasis
 * layers rendered, the travel scheduled its next frame on a clock that never
 * ticked again, and every await behind it — the scene, the workspace queue,
 * and the page's heartbeat to the Mac — stopped with no error at 72 fps.
 * Callers must pass a `frame` scheduler; this deadline is the guarantee that
 * holds even when that clock never ticks. A travel is an easing, not a gate,
 * so when no frame arrives the placement still lands in one step and the
 * caller still continues.
 */
export const FOCUS_TRAVEL_GRACE_MS = 2_000;

/**
 * Travel from one placement to another over `durationMs`, as a transient.
 *
 * `step` receives exactly what a held grip produces: a world-space offset in
 * render units and a scale multiplier over the saved placement. The caller
 * bakes the last frame the way it bakes a released grab, so the travel costs
 * no extra saved revision and cannot leave the drawn transform doubled.
 *
 * The returned promise always settles: on its last frame, on a thrown `step`,
 * or on the deadline above. It must never be the thing an immersive session is
 * waiting on.
 */
export function focusTravel({ from, to, radius, step, durationMs = 600, now, frame, defer,
  graceMs = FOCUS_TRAVEL_GRACE_MS }) {
  if (typeof frame !== 'function') throw Error('focusTravel requires a frame scheduler.');
  const clock = now ?? (() => performance.now());
  const schedule = frame;
  const later = defer ?? ((callback, ms) => { setTimeout(callback, ms); });
  const ratio = to.scale / from.scale;
  const started = clock();
  return new Promise((resolve, reject) => {
    let settled = false;
    const land = u => {
      const eased = ease(u);
      const offset = from.translation.map((value, axis) => (to.translation[axis] - value) * eased * radius);
      // The eased share is handed on as a third argument so a
      // caller that is also TURNING the structure — the one framing after a
      // tier has grown — can put the same easing on its own transient rotation
      // and have the turn, the travel and the resize land on one frame. Every
      // other caller ignores it and behaves exactly as it did.
      step(offset, Math.pow(ratio, eased), eased);
    };
    const arrive = () => { settled = true; resolve({ translation: [...to.translation], scale: to.scale }); };
    const tick = () => {
      if (settled) return;
      try {
        const u = durationMs > 0 ? clamp((clock() - started) / durationMs, 0, 1) : 1;
        land(u);
        if (u >= 1) arrive();
        else schedule(tick);
      } catch (error) { settled = true; reject(error); }
    };
    later(() => {
      if (settled) return;
      try { land(1); arrive(); } catch (error) { settled = true; reject(error); }
    }, Math.max(0, durationMs) + Math.max(0, graceMs));
    tick();
  });
}
