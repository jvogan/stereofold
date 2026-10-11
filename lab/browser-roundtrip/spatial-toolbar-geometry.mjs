import { HALF_IPD_METERS, EYE_HALF_FIELD_DEGREES } from './placement-fit-envelope.mjs';
export { HALF_IPD_METERS, EYE_HALF_FIELD_DEGREES } from './placement-fit-envelope.mjs';
import { replyCardOffset } from './reply-card-layout.mjs';
// Renderer-free physical XR toolbar geometry. Keep this module runnable in Node
// so controller targeting can be verified without loading the Mol* renderer.
export const EPSILON = 1e-6;
// Metres in the XR `local` space. These public constants make controller-ray
// acceptance deterministic without exposing a production test hook.
// Known limit: the anchor is head-relative only. `toolbarLayoutForDepthRange`
// keeps it inside the legal clip band, which is not the molecule's rendered
// volume, so a wearer-enlarged structure can still surround the panel. A
// bounds clamp would have to move the entry-pose anchor the session
// deliberately retains, so it needs in-headset verification first.
// The panel's seat, as a bearing rather than a raw offset.
//
// It used to be written as a forward and a sideways offset, which put it 23
// degrees off the forward axis: on hardware that is the middle of the view,
// and the wearer reported that the menu blocked the structure. A menu is
// read by choice and a molecule is looked at continuously, so the panel is
// now seated by the angle it subtends from the entry gaze. At 47 degrees its
// inner edge clears 34 degrees, which leaves the central 60 degree cone -- the
// band a wearer looking at the structure actually occupies -- empty of panel,
// caption and status line alike. `faceViewer` then yaws it back square, so an
// off-axis panel is still read as a surface rather than edge-on.
//
// Dimensions are authored at 0.95 m, then scaled together to the 1.35 m
// reading range. This keeps their apparent size without close-up glass.
/**
 * Cap height as a fraction of a Mol* text `size`, and Meta's minimum.
 *
 * Mol* scales a glyph quad by the font atlas line height, not by the cap:
 * `font-atlas.js` builds `lineHeight = fontSize + 2 * fontSize / 8 +
 * fontSize / 3` and normalises each glyph's measured box by it, so a capital
 * plus the atlas buffer is about 0.95 of `fontSize` against a 1.583 line
 * height. Meta publishes 14 dp as the minimum body size on a spatial panel
 * and 500 dp per metre as the default density, which is 0.028 m of cap.
 *
 * Any type on this panel must satisfy `size * GLYPH_CAP_FRACTION >=
 * META_MIN_CAP_METERS` at the seat, which is what the tests assert.
 */
export const GLYPH_CAP_FRACTION = 0.58;
export const META_MIN_CAP_METERS = 0.028;

/**
 * The lens the panel has to fit inside, in degrees off the forward axis.
 *
 * Measured on Quest 2 wearer-view frames (3664x1920, one 1832-wide eye each).
 * The lens-visible field -- the non-black region inside the compositor's barrel
 * vignette -- is 1712 x 1846 pixels in the left eye. Two drawn landmarks put a
 * scale on it: `captionEnvelope` stops the caption glass's inboard edge exactly
 * at `CENTRAL_CONE_HALF_ANGLE_DEGREES`, and that edge lands 611 px from the lens
 * centre, while the menu plate's inboard edge, 34.7 degrees off the axis by
 * construction, lands at 707 px. Both give 20.4 px per degree, so the half-lens
 * is 856 / 20.4 = 42 degrees across and 923 / 20.4 = 45 degrees high. That is
 * Meta's published 89 x 93 degree Quest 2 field, measured rather than quoted.
 *
 * `PANEL_FRAME_MARGIN_DEGREES` is what the panel keeps off that edge, and
 * `HALF_IPD_METERS` is half the 63 mm interpupillary distance the emulator and
 * the headset both use: a panel on the wearer's left is further off the axis in
 * the RIGHT eye, by about 1.7 degrees at this seat, which is one character of
 * row type. That is the one-eye clipping that drops the first letter of a
 * caption row in one eye only, so every fit below is measured from the eye
 * that sees the panel worst, never from the head centre.
 */
export const EYE_HALF_FIELD_VERTICAL_DEGREES = 45;
export const PANEL_FRAME_MARGIN_DEGREES = 3;

/**
 * The furthest off-axis the panel may be seated, and the range it sits at.
 *
 * Compact controls use the 47-degree peripheral seat, read by a deliberate
 * glance. Expanded grids and relocation candidates instead use
 * `toolbarSeatDegrees` to fit their complete width in the forward lens.
 * Neither policy follows subsequent head movement.
 */
const MENU_SEAT_DEGREES = 47, DESIGN_SEAT_METERS = 0.95;
// Keep the established angular layout, but put its glass beyond the close
// reach of the wearer. Physical type and targets grow with this distance.
export const TOOLBAR_READING_RANGE_METERS = 1.35;
export const TOOLBAR_MIN_HEAD_CLEARANCE_METERS = 0.85;
const menuSeat = MENU_SEAT_DEGREES * Math.PI / 180;

/**
 * The bearing that puts a panel of this half width inside the lens.
 *
 * The RANGE is what is held fixed, not the depth: range is what sets the
 * panel's angular size, and a nine-row menu pulled closer to hold its depth
 * grows past the lens top and bottom instead. So a panel seated inboard of the
 * ceiling is DEEPER than one seated out at it, and a caller that cannot afford
 * that -- a molecular cutaway's clip band -- says so with `maxDepthMeters`,
 * which `createToolbarPanel` honours by shortening the range.
 *
 * The panel faces the wearer, so its outboard corner sits `halfWidthMeters`
 * along a line square to the bearing: at bearing s and range R that corner is
 * `R sin s + w cos s` aside and `R cos s − w sin s` deep, and the far eye adds
 * its half-interpupillary offset to the first. The angle that makes grows with
 * s, so one bisection finds the largest bearing whose corner still clears the
 * frame margin. A panel that cannot fit at any bearing gets 0, which is
 * straight ahead and visible -- a menu in the way is recoverable, a menu half
 * off the edge of the eye just looks broken.
 */
export function toolbarSeatDegrees(halfWidthMeters, rangeMeters = TOOLBAR_READING_RANGE_METERS,
  preferredDegrees = MENU_SEAT_DEGREES) {
  const width = Number.isFinite(halfWidthMeters) ? Math.max(0, halfWidthMeters) : 0;
  const range = Number.isFinite(rangeMeters) && rangeMeters > EPSILON ? rangeMeters : TOOLBAR_READING_RANGE_METERS;
  const preferred = Number.isFinite(preferredDegrees) ? Math.max(0, preferredDegrees) : MENU_SEAT_DEGREES;
  const limit = Math.tan((EYE_HALF_FIELD_DEGREES - PANEL_FRAME_MARGIN_DEGREES) * Math.PI / 180);
  const outboardTangent = degrees => {
    const s = degrees * Math.PI / 180;
    const depth = range * Math.cos(s) - width * Math.sin(s);
    if (!(depth > EPSILON)) return Infinity;
    return (range * Math.sin(s) + width * Math.cos(s) + HALF_IPD_METERS) / depth;
  };
  if (outboardTangent(preferred) <= limit) return preferred;
  let low = 0, high = preferred;
  for (let step = 0; step < 40; step += 1) {
    const middle = (low + high) / 2;
    if (outboardTangent(middle) <= limit) low = middle; else high = middle;
  }
  return low;
}
const TOOLBAR_DESIGN_LAYOUT = Object.freeze({
  // Compact controls live beside the subject. Reading their full width may
  // require a glance left; fitting every corner into the forward lens moved
  // the panel back over the molecule. B/Y deliberately recalls this seat.
  peripheralSeat: true,
  // Derived from the seat above. `rightMeters` is signed: negative is the
  // wearer's left, which is the side the panel takes because the talk orb
  // takes the right. `forwardMeters` is the panel's view-space depth, which is
  // what `toolbarLayoutForDepthRange` clamps, and the three offsets scale
  // together there, so the bearing survives any clamp. Roughly a metre of
  // range, so a 4.8 cm label carries a 3.4 cm cap height: the same apparent
  // size as 2.5 cm read at 0.8 m.
  forwardMeters: DESIGN_SEAT_METERS * Math.cos(menuSeat),
  rightMeters: -DESIGN_SEAT_METERS * Math.sin(menuSeat),
  // Just under 10 degrees below the horizon, so the panel is centred a little
  // under eye height and its caption block does not ride up over the room.
  lowerMeters: 0.16,
  // 0.050 m of Mol* text `size` is a 0.029 m cap at `GLYPH_CAP_FRACTION`,
  // which clears Meta's 0.028 m minimum body size for a spatial panel. The
  // 0.048 m this was fell 0.6 percent short of it. Row step holds its 1.5
  // ratio to the type so the rows keep their spacing.
  //
  // That is 1.72 degrees of cap read at the seat, and it is what the wearer is
  // owed. The wearer got 0.49 degrees of it, measured off the device
  // capture, and said "the menu is like super small, super tiny, I can't read
  // anything". None of that was this number. The entry seat was lengthening
  // its own range, which `toolbarLayoutForOutboard` now refuses to do; these
  // constants drew at their stated size the whole time.
  //
  // They are also the largest that fit. `CENTRAL_CONE_HALF_ANGLE_DEGREES` is
  // 16 and the expanded grid's is 12; at this type the nearest drawn corner of
  // the quiet menu sits at 16.63 degrees, the compact tour's at 16.52 and the
  // grid's at 12.88. Five per cent more type takes the grid to 11.69 and
  // inside its cone. Rows bigger than this are not a constant to nudge: they
  // are a decision to hand the menu lens the structure currently has, and it
  // belongs to whoever owns that trade.
  //
  // The column pitch grew with the type. A plate is capped at
  // `maxColumnHalfWidthFactor` of the pitch. The `Mol*` row is four glyphs;
  // the 0.36 m pitch below is retained from sizing for its former twelve-
  // glyph label, whose text half-width was 0.162 m against a 0.163 m plate
  // half-width at the old 0.34 m pitch. This historical spacing remains
  // unchanged now that the label is shorter.
  fontMeters: 0.050, rowStepMeters: 0.075, columnStepMeters: 0.36,
  // Ten lines is the ceiling the caption may ask for. What it actually gets is
  // `captionEnvelope`'s line budget, which is what the eye has room for above
  // the rows at this seat, and on the shipped nine-row menu that is three.
  maxRows: 15, maxReadoutLines: 10, backgroundMargin: 0.12,
  // Physical target geometry. A wearer aims a hand-held ray whose angular
  // jitter is a degree or more, and the first Quest 2 session found the old
  // glyph-sized targets unhittable. A row is therefore a plate, not its text
  // extent: uniform across its column, and tall enough that neighbouring
  // plates overlap slightly, so there is no dead band between two rows at
  // all: a ray between two labels presses the nearer of the two. The drawn
  // plate is inset inside that target, so the visible gap between two
  // buttons is real while the aimable area still has no seam.
  rowHalfHeightFactor: 0.52, plateInsetFactor: 0.10,
  rowPadMeters: 0.030, glyphAspect: 0.54,
  minColumnHalfWidthFactor: 0.30, maxColumnHalfWidthFactor: 0.48,
  plateCornerMeters: 0.016, plateBorderMeters: 0.005, plateDepthMeters: 0.022,
  // A button is a chamfered slab, not a decal: the face stands off the
  // backing plate and a bevel runs around it, so scene lighting draws an
  // edge the wearer can see from any angle. Every depth here is measured
  // away from the wearer along the panel normal, so the label plane at zero
  // stays in front of the face, the face in front of the bevel's outer edge,
  // and all of them in front of the backing glass.
  //
  // A hovered or pressed row is drawn as its own plate over the merged one.
  // `highlightBiasMeters` keeps it in front so the two never fight for the
  // same pixels; a press gives back part of that bias and narrows its
  // footprint, so the face is seen to move into its socket.
  bevelMeters: 0.007, faceLiftMeters: 0.010,
  highlightBiasMeters: 0.006, pressSinkMeters: 0.005,
  // The least height above the anchor at which the caption glass may sit.
  //
  // The glass used to start immediately above whatever rows there were, so it
  // rode up and down as rows appeared: the four-row quiet menu put the scene
  // title across the middle of the structure, and the nine-row tour menu put it
  // well above. Two costs, both measured. The title moved between chapters. And
  // the low seat is where the central cone bites hardest -- the cone is a cone,
  // so a block high above the horizon may reach much further inboard than one
  // beside it -- which left the quiet menu's caption twelve characters wide
  // against the fifteen a page is cut to.
  //
  // 0.44 m above the anchor is about 27 degrees of elevation at the seat, which
  // is above a structure framed at up to 24 degrees of half-height, and it is
  // the floor the nine-row menu already produced. Every row set now gets that
  // same block: one place for the title, and the same twenty characters of it.
  captionFloorMeters: 0.44,
  // The dark-glass plate every control sits on, and the margin it keeps
  // around the outermost row and the status line.
  backingPadMeters: 0.034, backingCornerMeters: 0.034,
  backingBorderMeters: 0.008, backingDepthMeters: 0.034,
  // Comfort against capacity. Up to this many rows the panel is laid out at
  // full size. Beyond it the whole panel steps down together, to a floor, so
  // the expanded control grid still fits a Quest 2 field of view. Every
  // compact-menu state stays at or under `comfortRows`.
  //
  // Nine, not eight, since `Reset view` joined the compact menu. The busiest
  // compact state a wearer can reach -- a tour running, with Back, Next and a
  // caption page -- is nine rows, and at eight the whole panel stepped down to
  // 0.047 m type, a 0.027 m cap, under Meta's spatial minimum. The expanded
  // grid is unaffected: at two dozen rows it was already on `densityFloor`.
  comfortRows: 9, densityFloor: 0.62,
  // Turn the panel to face the wearer. Without this an off-axis panel is a
  // sheet seen edge-on, which is most of why the first session read it as
  // floating words rather than a surface.
  faceViewer: true,
});

/**
 * How far the panel scales down for its row count.
 *
 * The compact menu, which is what a demo shows, is always full size. The
 * expanded grid carries about thirty controls; at full size it would span
 * more than a Quest 2 can show at once, so it shrinks by one factor applied
 * to every physical length at once. Angular text size falls with it, which
 * is the deliberate trade: a dense grid is a power-user surface.
 */
export function toolbarDensity(rowCount, constants = SPATIAL_TOOLBAR_LAYOUT) {
  const comfort = Math.max(1, constants.comfortRows ?? 8);
  const count = Number.isFinite(rowCount) ? Math.max(1, Math.round(rowCount)) : 1;
  if (count <= comfort) return 1;
  return Math.max(constants.densityFloor ?? 0.62, Math.sqrt(comfort / count));
}

// Every length that must shrink together when the panel steps down. The
// anchor offsets are not among them: the panel keeps its seat and only its
// contents get denser.
const DENSITY_SCALED = Object.freeze(['fontMeters', 'rowStepMeters', 'columnStepMeters', 'rowPadMeters',
  'plateCornerMeters', 'plateBorderMeters', 'plateDepthMeters', 'bevelMeters', 'faceLiftMeters',
  'highlightBiasMeters', 'pressSinkMeters', 'captionFloorMeters', 'backingPadMeters', 'backingCornerMeters',
  'backingBorderMeters', 'backingDepthMeters']);

function scaleConstants(constants, factor) {
  if (factor === 1) return constants;
  const scaled = { ...constants };
  for (const key of DENSITY_SCALED) {
    if (Number.isFinite(constants[key])) scaled[key] = constants[key] * factor;
  }
  return scaled;
}

const readingScale = TOOLBAR_READING_RANGE_METERS / DESIGN_SEAT_METERS;
export const SPATIAL_TOOLBAR_LAYOUT = Object.freeze({
  ...scaleConstants(TOOLBAR_DESIGN_LAYOUT, readingScale),
  forwardMeters: TOOLBAR_DESIGN_LAYOUT.forwardMeters * readingScale,
  rightMeters: TOOLBAR_DESIGN_LAYOUT.rightMeters * readingScale,
  lowerMeters: TOOLBAR_DESIGN_LAYOUT.lowerMeters * readingScale,
});

function finite3(v) { return Array.isArray(v) && v.length === 3 && v.every(Number.isFinite); }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function scale(a, n) { return [a[0] * n, a[1] * n, a[2] * n]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }

export function normalizeSpatialVector(value, fallback = [0, 0, -1]) {
  if (!finite3(value)) return [...fallback];
  const n = Math.hypot(...value);
  return n > EPSILON && Number.isFinite(n) ? value.map(x => x / n) : [...fallback];
}

/**
 * How far the wearer's yaw may leave the panel's seat before the seat is
 * stale, and how long it has to stay there. Nothing here moves the panel: a
 * menu that chased the head would be in the way of the molecule the wearer
 * turned to look at, and the wearer already has a press that brings it back.
 * The pair exists so a stale seat is recorded rather than guessed at from a
 * hardware session where the wearer says the menu is not there.
 */
export const MENU_SEAT_DRIFT_DEGREES = 70, MENU_SEAT_DRIFT_MS = 1500;

/**
 * The seat's own axes: the wearer's eye height and yaw, and nothing else.
 *
 * The head matrix carries pitch and roll too, and the seat used to be built
 * straight from it. A wearer who enters looking down at the structure -- which
 * is what a wearer does -- got a panel pitched down with them and seated below
 * their level gaze, so from a level head it was a sheet seen from above with
 * its glyphs raked away, and the wearer loses track of where the menu is
 * relative to them.
 *
 * XR `local` space is Y-up, so levelling is one projection onto the horizontal
 * plane. A head pitched to straight up or straight down has no yaw left in its
 * forward vector, and its own right axis carries the yaw instead.
 */
export function toolbarSeatBasis(head) {
  const matrix = head?.transform?.matrix ?? head?.matrix;
  const position = head?.transform?.position ?? head?.position;
  const origin = position && [position.x, position.y, position.z];
  if (!finite3(origin)) return undefined;
  const up = [0, 1, 0];
  const headNormal = normalizeSpatialVector(matrix && [-matrix[8], -matrix[9], -matrix[10]], [0, 0, -1]);
  const headRight = normalizeSpatialVector(matrix && [matrix[0], matrix[1], matrix[2]], [1, 0, 0]);
  const level = sub(headNormal, scale(up, dot(headNormal, up)));
  const forward = Math.hypot(...level) > EPSILON
    ? normalizeSpatialVector(level, [0, 0, -1])
    : normalizeSpatialVector(cross(up, headRight), [0, 0, -1]);
  return { origin, forward, right: normalizeSpatialVector(cross(forward, up), [1, 0, 0]), up };
}

/**
 * How far the wearer's yaw has turned from the yaw the panel was seated at,
 * in degrees, or `undefined` when either pose is unreadable. Read-only: the
 * caller records it, and the panel stays where it was put.
 */
export function seatYawDriftDegrees(panel, head) {
  const basis = toolbarSeatBasis(head);
  if (!basis || !finite3(panel?.seatForward)) return undefined;
  const seated = panel.seatForward;
  const cosine = Math.min(1, Math.max(-1, dot(basis.forward, [seated[0], 0, seated[2]])
    / Math.max(EPSILON, Math.hypot(seated[0], seated[2]))));
  return Math.acos(cosine) * 180 / Math.PI;
}

/**
 * Keep the panel beyond a valid XR near plane without changing its angular
 * size. The normal layout is returned unchanged, preserving its deterministic
 * default physical positions. A deliberate molecular cutaway can move the
 * entire local panel to a legal interior depth without changing its angles.
 */
export function toolbarLayoutForDepthRange(nearDepth, farDepth, constants = SPATIAL_TOOLBAR_LAYOUT) {
  const near = Number.isFinite(nearDepth) && nearDepth > 0 ? nearDepth : 0;
  const far = Number.isFinite(farDepth) && farDepth > near ? farDepth : Infinity;
  const margin = 0.05;
  const minimum = near + margin, maximum = far - margin;
  // Keep the default physical layout when it is legal. Otherwise select an
  // interior plane; all physical dimensions scale with distance so controls
  // preserve their angular size and controller hit area.
  let forwardMeters = Math.max(constants.forwardMeters, minimum);
  if (Number.isFinite(maximum) && forwardMeters > maximum) {
    forwardMeters = Math.max(near + Number.EPSILON, (near + far) / 2);
  }
  // The far plane travels with the constants. The seat solver may swing the
  // panel inboard, which is deeper at the same range, so it has to be told
  // where the band ends; without this a clamped panel walked out through the
  // far plane and the menu was clipped away entirely.
  const bound = Number.isFinite(maximum) ? { maxDepthMeters: maximum } : {};
  const factor = forwardMeters / constants.forwardMeters;
  if (factor === 1) return Number.isFinite(maximum) ? { ...constants, ...bound } : constants;
  // Every physical length scales together, so a cutaway-relocated panel keeps
  // the angular size of its plates, its bevels and its backing as well as of
  // its text. The three anchor offsets scale by the same factor, so the panel
  // slides out along its own bearing: a clamp can move it further away but can
  // never swing it back toward the forward axis, where the molecule is.
  return { ...scaleConstants(constants, factor), ...bound, forwardMeters,
    rightMeters: constants.rightMeters * factor, lowerMeters: constants.lowerMeters * factor };
}

// Compatibility shorthand for callers that only know the near plane.
export function toolbarLayoutForNearDepth(nearDepth, constants = SPATIAL_TOOLBAR_LAYOUT) {
  return toolbarLayoutForDepthRange(nearDepth, Infinity, constants);
}

/** How far along its own bearing the panel's seat sits, in metres. */
export function toolbarSeatRange(constants = SPATIAL_TOOLBAR_LAYOUT) {
  return Math.hypot(constants.forwardMeters, constants.rightMeters, constants.lowerMeters);
}

/**
 * How far out a seat has to sit to clear the structure, along its own bearing.
 *
 * A seat is a fixed distance from the entry pose, and the structure is not:
 * the wearer scales it, and a demo can open at a scale where the molecule is
 * metres across. A 13,000-atom structure at demo scale reaches straight
 * through the menu plates, which is half of why the panel read as being in
 * the way even before it was moved off the forward axis.
 *
 * This is the far intersection of the seat's bearing with the structure's
 * bounding sphere grown by `marginMeters`: the nearest distance along that
 * bearing at which nothing of the panel is inside the structure. A bearing
 * that misses the grown sphere needs no stand-off and returns 0.
 *
 * @param {{centre: number[], radius: number}} sphere structure bounds, room metres
 * @param {number[]} origin the entry-pose eye, room metres
 * @param {number[]} direction the seat's bearing, normalized
 * @param {number} marginMeters clearance to keep outside the sphere
 */
export function toolbarStandoffMeters(sphere, origin, direction, marginMeters = 0) {
  const centre = sphere?.centre ?? sphere?.center;
  const radius = sphere?.radius;
  if (!finite3(centre) || !Number.isFinite(radius) || radius <= 0) return 0;
  if (!finite3(origin) || !finite3(direction)) return 0;
  const margin = Number.isFinite(marginMeters) && marginMeters > 0 ? marginMeters : 0;
  const unitDirection = normalizeSpatialVector(direction, [0, 0, -1]);
  const toCentre = sub(centre, origin);
  const reach = radius + margin;
  const along = dot(toCentre, unitDirection);
  const discriminant = along * along - (dot(toCentre, toCentre) - reach * reach);
  if (!Number.isFinite(discriminant) || discriminant <= 0) return 0;
  return Math.max(0, along + Math.sqrt(discriminant));
}

/** The most a stand-off may scale the panel's own dimensions. */
export const STANDOFF_MAX_FACTOR = 1.5;

/**
 * Push the whole seat out to `standoffMeters` along its own bearing.
 *
 * Every physical length scales with it, exactly as the cutaway clamp does, so
 * the panel keeps its angular size, its type size and its controller targets,
 * and the bearing that keeps it out of the central view is preserved. A
 * stand-off shorter than the default seat leaves the layout untouched, and
 * `STANDOFF_MAX_FACTOR` caps how far a scaled-up structure can push it.
 */
export function toolbarLayoutForStandoff(standoffMeters, constants = SPATIAL_TOOLBAR_LAYOUT) {
  const seat = toolbarSeatRange(constants);
  if (!Number.isFinite(standoffMeters) || !Number.isFinite(seat) || seat <= EPSILON) return constants;
  if (standoffMeters <= seat) return constants;
  // A stand-off that clears a structure the wearer scaled to fill the room
  // would scale every plate and every type size with it, and the menu becomes
  // giant. Past this cap the structure passes behind the panel instead of
  // pushing it across the room.
  const factor = Math.min(standoffMeters / seat, STANDOFF_MAX_FACTOR);
  return { ...scaleConstants(constants, factor),
    forwardMeters: constants.forwardMeters * factor,
    rightMeters: constants.rightMeters * factor,
    lowerMeters: constants.lowerMeters * factor };
}

/**
 * Swing the seat further outboard WITHOUT moving it further away.
 *
 * The entry seat asks for more clearance from the structure by multiplying
 * `rightMeters`. That is a bearing request, and it was written as one, but
 * `createToolbarPanel` takes its range from `hypot(forwardMeters,
 * rightMeters)`: a bare multiply on one leg lengthens the hypotenuse, so an
 * outboard factor of 3.5 seated the menu at 2.8 m instead of 0.95 m and every
 * plate and glyph kept its metres while losing two thirds of its angular size.
 * Measured on the wearer capture: 1.5 degrees of row pitch and half
 * a degree of cap against the 4.5 and 1.7 the constants describe, which is the
 * wearer's "the menu is super small, I can't read anything".
 *
 * The range is what sets angular size, so the range is what is held. Both legs
 * are rescaled after the multiply, which leaves the seat on its own sphere and
 * changes only the bearing it asks for. `toolbarSeatDegrees` still caps that
 * bearing at what the lens can hold, so an unspendable factor now costs
 * nothing at all instead of costing legibility.
 */
export function toolbarLayoutForOutboard(factor, constants = SPATIAL_TOOLBAR_LAYOUT) {
  if (!Number.isFinite(factor) || factor === 1) return constants;
  const forward = constants.forwardMeters, right = constants.rightMeters * factor;
  const range = Math.hypot(forward, constants.rightMeters), swung = Math.hypot(forward, right);
  if (!(range > EPSILON) || !(swung > EPSILON)) return constants;
  const hold = range / swung;
  return { ...constants, forwardMeters: forward * hold, rightMeters: right * hold };
}

/**
 * Wrap one status line to the plate, bounded.
 *
 * The same word-wrap the caption block uses, kept here so the geometry module
 * stays import-free and testable under Node. An empty status produces no
 * lines at all, which is what keeps the plate the height it was before the
 * status row could grow.
 */
export function captionTokens(text, width) {
  return text.trim().split(/\s+/u).filter(Boolean).flatMap(word => {
    if (word.length <= width) return [word];
    const pieces = word.match(/[^/-]+[/-]?|[/-]/gu) ?? [word];
    const tokens = []; let token = '';
    for (const piece of pieces) {
      if (token && token.length + piece.length > width) { tokens.push(token); token = ''; }
      token += piece;
    }
    if (token) tokens.push(token);
    return tokens;
  });
}

export function boundStatusLines(text, width, maxLines) {
  const value = typeof text === 'string' ? text.trim() : '';
  if (!value || !(width > 0) || !(maxLines > 0)) return [];
  const lines = [];
  let line = '';
  for (const word of captionTokens(value, width)) {
    const next = line ? `${line} ${word}` : word;
    if (line && next.length > width) { lines.push(line); line = word; }
    else line = next;
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return lines;
  const bounded = lines.slice(0, maxLines);
  // The last kept line ends on a whole word. Cutting at the width alone is
  // what puts `Taxol-stabilise…` on the plate -- the character the
  // ellipsis spends lands inside a hyphenated word, which is one word. Back
  // up to the boundary the room leaves; a lone token longer than a line has no
  // boundary to give back, and it is kept whole rather than cut mid-word.
  const room = Math.max(1, width - 1);
  const last = bounded[maxLines - 1];
  let kept = last;
  if (last.length > room) {
    const cut = last.slice(0, room);
    const boundary = cut.lastIndexOf(' ');
    if (boundary > 0 && !/[/-]$/u.test(cut.slice(0, boundary))) kept = cut.slice(0, boundary);
  }
  bounded[maxLines - 1] = `${kept.trimEnd()}…`;
  return bounded;
}

/**
 * The smallest readout font factor the caption may shrink to before lines are
 * dropped instead, and the step it shrinks by.
 *
 * The floor is Meta's own minimum, not a preference. The shipped row type is
 * 0.050 m, which `GLYPH_CAP_FRACTION` makes a 0.029 m cap, and
 * `META_MIN_CAP_METERS` is 0.028: 0.028 / 0.029 is 0.966, so one step of
 * `READOUT_FONT_STEP` is the whole of the room there is. A floor of 0.88 buys
 * four more characters a line at a 0.0255 m cap, under the minimum, and the
 * surviving text is then too small to read in the headset.
 */
export const READOUT_FONT_FLOOR = 0.97;
export const READOUT_FONT_STEP = 0.03;
/** Baseline to baseline, as a multiple of the readout font. */
export const READOUT_LINE_STEP_FACTOR = 1.36;

/**
 * The caption page the glass promises to hold, in lines of characters.
 *
 * A tour caption is paginated before it ever reaches the panel, by `pageText`
 * in `plugin/src/tour-player.ts`, and the wearer pages through it on the
 * `Caption 2/6` row. Pagination and glass therefore have to agree, or the page
 * that was cut to fit is re-wrapped on arrival and loses its end.
 *
 * These two numbers are that agreement, and `pageText` takes its defaults from
 * them. They are the narrowest and shortest block the eye leaves above the
 * shipped menus, measured across four to twelve rows, not a preference: above
 * the nine-row menu the glass is 0.49 m wide on a panel plane 0.53 m deep at
 * its outboard corner, which is 16 characters of row type on 3 lines, and four
 * rows leave 15 on 5. Wrapping the same words wider never makes more lines, so
 * a page cut to 15 by 3 fits every block at least that big.
 *
 * The 28 to 32 characters a wider brief asked for is not reachable at this
 * seat. A character of row type subtends 2.7 degrees there, so 30 of them want
 * 76 degrees of horizontal field, starting at the 30 degree edge of the cone
 * the structure keeps. That runs past the far edge of the eye. Fewer rows, a
 * narrower cone or a nearer seat are the levers; the caption's own layout is
 * not one of them.
 */
export const READOUT_PAGE_LINE_WIDTH = 15;
export const READOUT_PAGE_LINES = 3;

/**
 * One long caption cut into pages the glass can hold whole.
 *
 * This is the single paginator. `pageText` in `plugin/src/tour-player.ts` is a
 * thin wrapper over it, and the resting structure description in
 * `structure-subject.mjs` calls it with its own row budget, so a lesson caption
 * and a source description can never drift into two different ideas of a page.
 *
 * The bound is physical: pages are cut against the lines the glass promises,
 * not against a character count, because word wrapping can turn a page that
 * counted short into one line more than the block holds. Every source word is
 * kept and the pages read in order — nothing is elided, which is the whole
 * point of paging a sentence rather than cutting it.
 */
export function pageCaptionText(value, maxCharacters = READOUT_PAGE_LINE_WIDTH * READOUT_PAGE_LINES,
  lineWidth = READOUT_PAGE_LINE_WIDTH, maxLines = READOUT_PAGE_LINES) {
  const words = String(value ?? '').replace(/\s+/gu, ' ').trim().split(' ').filter(Boolean);
  if (!words.length) return [''];
  const pages = []; let lines = [], line = '';
  const pushPage = () => {
    if (line) { lines.push(line); line = ''; }
    if (lines.length) { pages.push(lines.join('\n')); lines = []; }
  };
  for (const word of captionTokens(words.join(' '), lineWidth)) {
    const next = line ? `${line} ${word}` : word;
    if (line && next.length > lineWidth) {
      lines.push(line); line = '';
      if (lines.length >= maxLines) pushPage();
    }
    const candidate = line ? `${line} ${word}` : word;
    // Keep the historical character bound when it can be honored without
    // reducing the physical line budget. The line budget is authoritative.
    if (line && candidate.length > maxCharacters && lines.length) pushPage();
    line = candidate;
  }
  pushPage();
  return pages;
}

/**
 * The eye the caption glass has to fit inside, and the cone it has to stay out
 * of.
 *
 * A panel seated 47 degrees off the forward axis is only 0.65 m deep at 0.95 m
 * of range, and an eye's vertical extent is measured against that depth, not
 * against the range. Eight caption lines stacked above a nine-row panel reach
 * 0.81 m above eye level at a corner 0.50 m deep, which is 58 degrees of
 * elevation in a 90 degree eye, putting the top four lines outside the frame.
 *
 * So the caption is no longer stacked and hoped for. `captionEnvelope` returns
 * the rectangle the glass may occupy: as far inboard as the central cone
 * allows, and as tall as the eye allows at its shallowest corner. Compact
 * peripheral panels measure the eye after a glance toward their anchor and
 * reserve a 30-degree half cone around the original gaze; expanded panels
 * retain the forward-eye envelope below. The wrap width and line budget both
 * come from that rectangle.
 *
 * `EYE_TAN_HALF_VERTICAL` is a 90 degree vertical field of view, which is what
 * `plugin/scripts/xr-gate.ts` measures with (`EMULATED_DEVICE`) and a little
 * under what a Quest 3 shows. `CAPTION_FRAME_MARGIN` keeps the glass off the
 * frame edge, which also covers the half-interpupillary offset of each eye.
 */
export const EYE_TAN_HALF_VERTICAL = 1;
export const EYE_TAN_HALF_HORIZONTAL = Math.tan(EYE_HALF_FIELD_DEGREES * Math.PI / 180);
/**
 * The cone the structure keeps to itself, as a half-angle.
 *
 * It was 30 degrees, and 30 degrees is not affordable at a Quest 2's 42 degree
 * half-lens. A legible row is the arithmetic: Meta's 14 dp minimum body size at
 * 500 dp per metre is a 0.028 m cap, which is 1.7 degrees at the panel's range,
 * so a twelve-character label plus its plate is 24 degrees of field however far
 * away it is put -- distance scales the panel and the type together. A band
 * running from 30 degrees to the 39 degree frame margin is 9 degrees wide and
 * holds three characters. The old seat resolved that by putting the panel
 * outside the eye entirely.
 *
 * 16 degrees is what the band needs to hold the shipped rows and a fifteen-
 * character caption page, and it is still outside the structure's own centre:
 * a framed subject measures 30 to 47 per cent of the lens wide, a half-width of
 * 13 to 20 degrees. So the menu grazes the outer fringe of a widely-framed
 * structure instead of clearing it, and in exchange it is on the glass.
 *
 * The third lever -- shorter labels -- is measured too, and
 * 30 degrees is unreachable at ANY label length. A row plate has a minimum width
 * of its own (`minColumnHalfWidthFactor`), so below six characters the panel
 * stops narrowing: the furthest inboard edge the compact menu can ever reach is
 * 20.5 degrees, against the 30 a cone would need. What eight characters buy is
 * that 16 is now TRUE rather than aspirational -- the rows themselves cleared
 * only 13.9 degrees at twelve characters, so the constant named a cone the menu
 * was sitting inside. See `MENU_LABEL_BUDGET_CHARACTERS` for the table.
 */
export const PERIPHERAL_MENU_CONE_HALF_ANGLE_DEGREES = 30;
export const CENTRAL_CONE_HALF_ANGLE_DEGREES = 16;
export const CENTRAL_CONE_TANGENT = Math.tan(CENTRAL_CONE_HALF_ANGLE_DEGREES * Math.PI / 180);
/**
 * The same cone, for the expanded control grid, which cannot honour the other.
 *
 * Thirty controls do not fit in one column that a Quest 2 can also show from
 * top to bottom, so the grid is two columns wide: 0.44 m of panel, which is 26
 * degrees of field at the seat. The band between the cone and the frame margin
 * is 39 - 16 = 23 degrees. A two-column grid is three degrees wider than the
 * space a compact menu is held to, and no label length changes that -- at the
 * plate's own minimum width it is still 24 degrees across.
 *
 * So the grid gets its own number rather than a quiet exemption. It is a modal
 * surface: the wearer opens it deliberately, its first row closes it, and any
 * press returns the compact menu. A lesson chapter is never played against it.
 * 12 degrees is what the shipped grid measures (12.9) with a degree of margin.
 */
export const EXPANDED_GRID_CONE_HALF_ANGLE_DEGREES = 12;
export const CAPTION_FRAME_MARGIN = 0.04;

/**
 * The caption rectangle, in the panel's own axes, for one eye at `origin`.
 *
 * `floor` is where the block starts, `outboard` its far edge from the forward
 * axis. Both are given; the two the eye decides are how far inboard the glass
 * may reach before it enters the cone the structure keeps, and how high it may
 * go before it leaves the frame.
 */
export function captionEnvelope({ origin, anchor, right, up, forward, headRight,
  outboard, floor, font, glyphAspect = 0.54, pad = 0, minLines = 1, maxLines = 10,
  viewForward = forward, viewRight = headRight, coneTangent = CENTRAL_CONE_TANGENT }) {
  // The glass is measured from the eye that sees it worst, never from the head
  // centre. A panel on the wearer's left is further off the axis in the right
  // eye by half an interpupillary distance, which at this seat is about one
  // character of row type: measured from the centre, the glass fits and the
  // outer eye still loses the first letter of every line, so a caption row is
  // whole in one eye and cut in the other. The cone the structure keeps belongs
  // to both eyes, so it stays measured from the head.
  const side = dot(sub(anchor, origin), headRight) <= 0 ? -1 : 1;
  const eyes = [add(origin, scale(viewRight, -HALF_IPD_METERS)), add(origin, scale(viewRight, HALF_IPD_METERS))];
  const seenFrom = (eye, dx, dy) => {
    const v = sub(add(add(anchor, scale(right, dx)), scale(up, dy)), eye);
    return { lateral: dot(v, headRight), rise: dot(v, up), depth: dot(v, forward) };
  };
  // Both bounds, not just the vertical one, and BOTH EYES, not just the one
  // that sees a left-seated panel worst. `outboard` is handed in as the panel's
  // own outer edge, and without testing it against the lens a panel seated
  // past the eye takes its caption with it, so titles arrive clipped
  // ("HE GUIDE RNA"). One eye is not enough either: the far
  // eye is only the far eye while the glass stays on the panel's own side, and
  // a glass that reaches across the forward axis is worst in the NEAR eye, so a
  // single-eye test let the 10-row menu's glass run to 41.9 degrees in the eye
  // it was not measuring.
  const visible = (eye, dx, dy) => {
    const relative = sub(add(add(anchor, scale(right, dx)), scale(up, dy)), eye);
    const point = { lateral: dot(relative, viewRight), rise: dot(relative, up), depth: dot(relative, viewForward) };
    return point.depth > EPSILON
      && Math.abs(point.rise) <= EYE_TAN_HALF_VERTICAL * point.depth * (1 - CAPTION_FRAME_MARGIN)
      && Math.abs(point.lateral) <= EYE_TAN_HALF_HORIZONTAL * point.depth * (1 - CAPTION_FRAME_MARGIN);
  };
  const insideEye = (dx, dy) => eyes.every(eye => visible(eye, dx, dy));
  // The cone stays a cone -- the structure is a ball about the gaze, not an
  // infinite slab, and a caption block seated above it is genuinely clear of it
  // at a lateral the rows could not take. But a cone alone does not BOUND that
  // block: at a large rise `hypot(lateral, rise)` clears the cone at any lateral
  // at all, so the inboard walk ran past the forward axis and out the far side.
  // On the 10-row tour menu that produced a 94-character glass 2.5 m wide,
  // centred half a metre to the wearer's RIGHT of a panel seated on their left,
  // reaching 41.9 degrees into the eye the one-eye test was not measuring.
  //
  // So the walk stops at the axis at the latest. The glass belongs to a panel
  // that has a side; it may grow across the whole of that side and no further.
  const clearsCone = (dx, dy) => {
    const seen = seenFrom(origin, dx, dy);
    return side * seen.lateral >= 0
      && Math.hypot(seen.lateral, seen.rise) >= coneTangent * seen.depth;
  };
  // Every edge below is found by walking, at a step fine enough that its own
  // rounding cannot cost a line or a character: a thirty-second of the type.
  // At a quarter of the type the ceiling above the nine-row menu lost 12 mm to
  // rounding, and 12 mm there was the third caption line.
  const step = font / 32;
  // The inboard edge, measured at the block's lowest corner: that is the
  // corner closest to the forward axis, and the cone angle only grows above
  // it. It does not depend on where the outboard edge is, so it is found once.
  // The outboard edge is handed in as the panel's own outer edge, so that the
  // two plates line up. It is only a starting point: an edge the far eye cannot
  // see is walked inboard until it can, before any width is measured from it.
  let outer = outboard;
  for (let guard = 0; guard < 2048 && !insideEye(outer, floor); guard += 1) outer += step;
  // The inboard edge stops at the cone -- or at the far side of the lens, for a
  // block seated so high that the cone never bites: the cone is a cone, so at a
  // large rise `hypot(lateral, rise)` clears it whatever the lateral, and the
  // walk used to run to its guard and hand back an edge nothing could see.
  let inboard = outer;
  for (let dx = outer, guard = 0; guard < 2048; dx += step, guard += 1) {
    if (!clearsCone(dx, floor) || !insideEye(dx, floor)) break;
    inboard = dx;
  }
  // The ceiling is set by the outboard edge, which is the shallowest corner
  // and so the first to leave the frame. Width and height therefore trade
  // against each other: give up outboard width and the block may be taller.
  const ceilingFor = edge => {
    let ceiling = floor;
    for (let dy = floor, guard = 0; guard < 2048; dy += step, guard += 1) {
      if (!insideEye(edge, dy) || !insideEye(inboard, dy)) break;
      ceiling = dy;
    }
    return ceiling;
  };
  const measure = edge => {
    const ceiling = ceilingFor(edge);
    const wrapWidth = Math.max(0, Math.floor((inboard - edge - 2 * pad) / (font * glyphAspect)));
    const lineBudget = Math.max(0, Math.min(maxLines,
      Math.floor((ceiling - floor - 2 * pad - font) / (font * READOUT_LINE_STEP_FACTOR)) + 1));
    return { outboard: edge, inboard, floor, ceiling, wrapWidth, lineBudget,
      characters: wrapWidth * lineBudget };
  };
  // Height first, up to `minLines`; every millimetre after that goes to the
  // line width.
  //
  // Area is the wrong thing to maximise here, and maximising it is what put 15
  // characters on a line above the shipped nine-row menu. A caption arrives
  // already paginated, to a fixed number of lines of a fixed width. A block
  // that is one line short of that page re-wraps it and loses its end however
  // many characters it carries, and a block that is a character short of the
  // page's width turns every line into a fragment. So the widest rectangle
  // that still holds a whole page wins, and when no rectangle holds one, the
  // tallest does.
  //
  // The search never moves the outboard edge further out than the panel's own,
  // so the caption plate lines up with the control plate on the side the
  // wearer turns to, and it never gives up more than half the panel's width,
  // so it stays a plate the rows sit under rather than a banner off to one
  // side.
  const trials = [measure(outer)];
  for (let edge = outer + step; edge <= outer / 2 + EPSILON; edge += step) trials.push(measure(edge));
  const holdsPage = trials.filter(trial => trial.lineBudget >= minLines);
  const pool = holdsPage.length ? holdsPage : trials;
  const better = holdsPage.length
    ? (trial, best) => trial.wrapWidth > best.wrapWidth
      || (trial.wrapWidth === best.wrapWidth && trial.lineBudget > best.lineBudget)
    : (trial, best) => trial.lineBudget > best.lineBudget
      || (trial.lineBudget === best.lineBudget && trial.wrapWidth > best.wrapWidth);
  let best = pool[0];
  for (const trial of pool) if (better(trial, best)) best = trial;
  return best;
}

/**
 * Say on the headset log that a caption lost lines.
 *
 * This module stays import-free so it runs under Node, so the recorder is
 * reached through the global the diagnostics module installs. Everything here
 * is advisory: a missing or throwing recorder never changes the geometry the
 * caller gets back.
 */
function recordToolbarTruncation(detail) {
  try {
    const record = globalThis?.__stereofoldDiagnostics?.record;
    if (typeof record === 'function') record('toolbar', { reason: 'readout-truncated', ...detail });
  } catch { /* Layout never fails on a diagnostics failure. */ }
}

/** Pure, physical XR-local toolbar layout for deterministic ray tests. */
export function createToolbarPanel({ rows, head, constants: baseConstants = SPATIAL_TOOLBAR_LAYOUT, readout = [], status = '', measureText, seatAnchor }) {
  // The seat takes the wearer's eye height and yaw only. `toolbarSeatBasis`
  // carries the reasoning; the short version is that a panel built on a
  // pitched head is read edge-on from a level one.
  const basis = toolbarSeatBasis(head);
  if (!Array.isArray(rows) || rows.length === 0 || !basis) return undefined;
  const { origin, forward: headNormal, right: headRight, up: y } = basis;
  const density = toolbarDensity(rows.length, baseConstants);
  const constants = scaleConstants(baseConstants, density);
  const columns = Math.max(1, Math.ceil(rows.length / constants.maxRows));
  const lines = Math.max(1, Math.min(constants.maxRows, rows.length));
  // One plate width per column, sized to that column's widest label and
  // clamped to the column pitch. A uniform column reads as a stack of
  // buttons, and every row in it accepts the same generous ray target
  // whether its label is `Fit` or `Move menu`.
  const glyphHalfWidth = row => Math.max(...(typeof row === 'string' ? [row] : row.labelLines ?? [row.label]).map(label =>
    typeof label === 'string' ? label.length : 0)) * constants.fontMeters * (constants.glyphAspect ?? 0.54) / 2;
  const columnHalfWidths = Array.from({ length: columns }, (_, column) => {
    const widest = rows.reduce((widthSoFar, row, index) =>
      Math.floor(index / constants.maxRows) === column ? Math.max(widthSoFar, glyphHalfWidth(row)) : widthSoFar, 0);
    return Math.min(constants.columnStepMeters * (constants.maxColumnHalfWidthFactor ?? 0.46),
      Math.max(constants.columnStepMeters * (constants.minColumnHalfWidthFactor ?? 0.26), widest + (constants.rowPadMeters ?? 0)));
  });
  // The seat's bearing follows the panel's own width, because how far off the
  // axis a panel may sit depends on how wide it is. The constants carry the
  // furthest bearing the panel may take -- and `toolbarLayoutForStandoff` and
  // the cutaway clamp scale their offsets together, so that bearing survives
  // both -- while `toolbarSeatDegrees` brings it in until the outboard corner
  // is inside the lens with its margin, measured from the eye that sees the
  // panel worst. A four-row quiet menu is narrow and keeps most of the bearing;
  // the two-column expanded grid is wide and is seated well inboard of it.
  const seatSide = constants.rightMeters <= 0 ? -1 : 1;
  const panelHalfWidth = (columns - 1) / 2 * constants.columnStepMeters
    + Math.max(...columnHalfWidths) + (constants.backingPadMeters ?? 0);
  const preferredDegrees = Math.atan2(Math.abs(constants.rightMeters), Math.max(EPSILON, constants.forwardMeters)) * 180 / Math.PI;
  // A bearing nearer the axis is a deeper panel at the same range, and a
  // cutaway band has a far plane. `maxDepthMeters` is that plane, set by
  // `toolbarLayoutForDepthRange`; where there is one the range is shortened
  // until the panel's deepest drawn corner -- its INBOARD one, which the
  // bearing swings away from the wearer -- is inside it, and the bearing is
  // re-solved at that shorter range. Two passes settle it; without a band the
  // loop runs once and changes nothing.
  let seatRange = Math.hypot(constants.forwardMeters, constants.rightMeters);
  const seatBearing = range => constants.peripheralSeat === true && columns === 1
    ? Math.min(MENU_SEAT_DEGREES, preferredDegrees)
    : toolbarSeatDegrees(panelHalfWidth, range, preferredDegrees);
  let seatDegrees = seatBearing(seatRange);
  const maxDepth = Number.isFinite(constants.maxDepthMeters) ? constants.maxDepthMeters : Infinity;
  for (let pass = 0; pass < 3 && Number.isFinite(maxDepth); pass += 1) {
    const s = seatDegrees * Math.PI / 180;
    const deepest = seatRange * Math.cos(s) + panelHalfWidth * Math.sin(s);
    if (deepest <= maxDepth) break;
    seatRange *= maxDepth / deepest;
    seatDegrees = seatBearing(seatRange);
  }
  const seatRadians = seatDegrees * Math.PI / 180;
  const forwardMeters = seatRange * Math.cos(seatRadians);
  const rightMeters = seatSide * seatRange * Math.sin(seatRadians);
  const anchor = Array.isArray(seatAnchor) && seatAnchor.length === 3 && seatAnchor.every(Number.isFinite)
    ? seatAnchor : add(add(add(origin, scale(headNormal, forwardMeters)), scale(headRight, rightMeters)), scale(y, -constants.lowerMeters));
  // Turn the panel about its own vertical axis until it faces the wearer.
  // The panel stays upright, as a Quest system panel does; only its yaw
  // changes, so a panel seated well off the forward axis is read square on
  // instead of edge-on. Every ray test uses this same basis, so what the
  // wearer sees and what the ray accepts cannot drift apart.
  let normal = headNormal, x = headRight;
  if (constants.faceViewer !== false) {
    const toAnchor = sub(anchor, origin);
    const level = sub(toAnchor, scale(y, dot(toAnchor, y)));
    if (Math.hypot(...level) > EPSILON) {
      normal = normalizeSpatialVector(level, headNormal);
      x = normalizeSpatialVector(cross(normal, y), headRight);
    }
  }
  const halfHeight = constants.rowStepMeters * (constants.rowHalfHeightFactor ?? 0.47);
  const buttons = rows.map((row, index) => {
    const column = Math.floor(index / constants.maxRows), line = index % constants.maxRows;
    const point = add(add(anchor, scale(x, (column - (columns - 1) / 2) * constants.columnStepMeters)),
      scale(y, ((lines - 1) / 2 - line) * constants.rowStepMeters));
    // A row that only reports state is not a control. It is drawn as a flat
    // recessed chip with no rim and refused by the hit test, so it can never
    // be mistaken for a button. A row the content module marks `accent` is a
    // primary action and gets the brighter plate.
    const targetable = row?.state !== true;
    const style = !targetable ? 'state' : row?.accent === true ? 'accent' : 'action';
    return { ...row, point, column, line, targetable, style,
      halfWidth: columnHalfWidths[column], halfHeight };
  });
  // Status text is deliberately outside the hit grid, one row above the
  // controls. It therefore cannot shift a control anchor or ray target.
  //
  // Keep the whole answer. The voice path limits replies to twelve words;
  // a two-line cap at button width lost even the short filament refusal.
  // Display text can grow inboard without moving any button or the outboard
  // edge the seat keeps inside the eye. Extra lines stack upward from the
  // Listening… baseline; the backing and caption floor follow their extent.
  const statusHalfWidth = (columns - 1) / 2 * constants.columnStepMeters
    + Math.max(...columnHalfWidths) + (constants.backingPadMeters ?? 0);
  const statusWrapWidth = Math.max(28, Math.floor(statusHalfWidth * 2
    / (constants.fontMeters * (constants.glyphAspect ?? 0.54))));
  const statusLines = boundStatusLines(status, statusWrapWidth, Infinity);
  const statusTextHalfWidth = Math.max(0, ...statusLines.map(glyphHalfWidth));
  const statusDx = Math.max(0, statusTextHalfWidth - Math.max(...columnHalfWidths));
  const statusStepMeters = constants.fontMeters * READOUT_LINE_STEP_FACTOR;
  const statusBottom = (lines + 1) / 2 * constants.rowStepMeters;
  const statusPoints = statusLines.map((text, index) =>
    ({ text, point: add(add(anchor, scale(x, statusDx)),
      scale(y, statusBottom + (statusLines.length - 1 - index) * statusStepMeters)) }));
  let statusPoint = add(anchor, scale(y, statusBottom));
  const statusTopOffset = statusBottom + Math.max(0, statusLines.length - 1) * statusStepMeters;
  // Only controls belong on the menu backing. Status owns the separate reply
  // card below: including its old extent here leaves a large empty sheet over
  // the menu after the reply moves inboard (acceptance 3, refusal #808).
  const spans = [
    ...buttons.map(button => ({
      dx: (button.column - (columns - 1) / 2) * constants.columnStepMeters, halfX: button.halfWidth,
      dy: ((lines - 1) / 2 - button.line) * constants.rowStepMeters, halfY: button.halfHeight,
    })),
  ];
  const pad = constants.backingPadMeters ?? 0;
  const minX = Math.min(...spans.map(span => span.dx - span.halfX)) - pad;
  const maxX = Math.max(...spans.map(span => span.dx + span.halfX)) + pad;
  const minY = Math.min(...spans.map(span => span.dy - span.halfY)) - pad;
  const maxY = Math.max(...spans.map(span => span.dy + span.halfY)) + pad;
  // Reserve twelve lines from the first seat: even twelve long words can
  // wrap to one word per line. This obstacle is independent of the glyphs
  // currently drawn, so confirmations cannot displace component labels.
  const reservedHalfWidth = Math.max(...columnHalfWidths, statusWrapWidth * constants.fontMeters * (constants.glyphAspect ?? 0.54) / 2);
  const reservedDx = Math.max(0, reservedHalfWidth - Math.max(...columnHalfWidths));
  const obstacleMinX = Math.min(...buttons.map(button =>
    (button.column - (columns - 1) / 2) * constants.columnStepMeters - button.halfWidth),
    reservedDx - reservedHalfWidth) - pad;
  const obstacleMaxX = Math.max(...buttons.map(button =>
    (button.column - (columns - 1) / 2) * constants.columnStepMeters + button.halfWidth),
    reservedDx + reservedHalfWidth) + pad;
  const obstacleMaxY = statusBottom + 11 * statusStepMeters + constants.fontMeters / 2 + pad;
  const menuObstacle = {
    point: add(add(anchor, scale(x, (obstacleMinX + obstacleMaxX) / 2)), scale(y, (minY + obstacleMaxY) / 2)),
    halfWidth: (obstacleMaxX - obstacleMinX) / 2, halfHeight: (obstacleMaxY - minY) / 2,
  };
  const backing = {
    point: add(add(anchor, scale(x, (minX + maxX) / 2)), scale(y, (minY + maxY) / 2)),
    halfWidth: (maxX - minX) / 2, halfHeight: (maxY - minY) / 2,
  };
  // Replies own a separate card, outside the same reserved menu rectangle
  // passed to the component plate solver. Never grow a reply across Talk.
  let statusBacking;
  if (statusLines.length) {
    statusBacking = {
      point: add(add(anchor, scale(x, statusDx)), scale(y, (statusBottom + statusTopOffset) / 2)),
      halfWidth: statusTextHalfWidth + pad,
      halfHeight: (statusTopOffset - statusBottom + constants.fontMeters) / 2 + pad,
    };
    const cardPanel = { right: x, up: y, normal, backing: statusBacking, buttons };
    const menuPoints = toolbarMenuPoints({ ...cardPanel, menuObstacle,
      backingDepthMeters: constants.backingDepthMeters, plateDepthMeters: constants.plateDepthMeters });
    const offset = replyCardOffset({ points: toolbarBackingOutline(cardPanel, { segments: 1 }),
      menuPoints, eye: origin, target: add(origin, headNormal), up: y });
    statusBacking.point = add(statusBacking.point, offset);
    statusPoint = add(statusPoint, offset);
    for (const line of statusPoints) line.point = add(line.point, offset);
  }
  // The caption block gets its own glass, seated a short gap above the
  // controls. Text floating unbacked over the room is what the first Quest 2
  // session called a fake word thing, and the caption is the last of it. Its
  // lowest line therefore clears the panel plate by the gap plus its own
  // margin, which also keeps it clear of the status line inside that plate.
  // Both plates are display-only.
  //
  // The glass is no longer the width of the controls. It keeps their outboard
  // edge, so the two plates line up on the side the wearer turns to, and grows
  // inboard to wherever `captionEnvelope` says the central cone starts. Above
  // the shipped nine-row menu that is 0.55 m against the panel's 0.37 m, which
  // is 18 characters of row type instead of 13, and the difference is what
  // stops a caption page from arriving as ragged fragments.
  const captionGap = pad * 0.6, captionPad = pad * 0.8;
  // Preserve the parent's caption floor over the full status extent,
  // including its blank baseline, without adding that space to menu glass.
  const captionMenuTop = Math.max(maxY, statusTopOffset + constants.fontMeters / 2 + pad);
  const envelope = captionEnvelope({ origin, anchor, right: x, up: y, forward: headNormal,
    headRight, outboard: minX,
    floor: Math.max(captionMenuTop + captionGap, constants.captionFloorMeters ?? 0), font: constants.fontMeters,
    glyphAspect: constants.glyphAspect ?? 0.54, pad: captionPad,
    minLines: constants.readoutPageLines ?? READOUT_PAGE_LINES,
    maxLines: constants.maxReadoutLines ?? 10,
    // A compact peripheral menu is read after a deliberate glance toward its
    // room anchor. Measure its caption in that same binocular frame, while
    // retaining a central sixty-degree cone around the original gaze for
    // molecular clearance. These are construction frames, not head tracking.
    ...(constants.peripheralSeat === true && columns === 1 ? { viewForward: normal, viewRight: x, coneTangent: Math.tan(PERIPHERAL_MENU_CONE_HALF_ANGLE_DEGREES * Math.PI / 180) } : {}) });
  const captionCentre = (envelope.outboard + envelope.inboard) / 2;
  const glassWidth = Math.max(constants.fontMeters, envelope.inboard - envelope.outboard - 2 * captionPad);
  const glassHeight = Math.max(0, envelope.ceiling - envelope.floor - 2 * captionPad);
  // Readout text is display-only and lives above the hit grid. Its bounded
  // copy cannot move buttons or change the deterministic controller targets.
  // The first tour line sits at the top; following lines descend toward the
  // grid, so title, scene, progress, then caption read in their natural order.
  //
  // Meta publishes 14 dp as the minimum body size on a spatial panel and 500
  // dp per metre as the default density, which is 0.028 m of cap height. Mol*
  // scales a glyph quad by the font atlas line height rather than by the cap:
  // the atlas line height is `fontSize * (1 + 2/8 + 1/3)`, and a capital plus
  // the atlas buffer fills about 0.95 of `fontSize`, so a Mol* `size` of s
  // carries a cap near 0.58 s. The row type is 0.050 m, a 0.029 m cap, which
  // clears Meta's minimum and is legible in the headset.
  //
  // Three budgets bound the block, in this order. Its width and its line count
  // come from the eye, through the envelope. Wrapping is what pushes a caption
  // over the line count, so the first remedy is a smaller font, down to
  // `READOUT_FONT_FLOOR`: a narrower glyph fits more characters on a line and
  // so produces fewer lines for the same words. What survives after that is
  // decided by the caller: an entry marked `optional` is dropped whole, from
  // the end, before any line is cut. The tour readout marks its title, scene
  // and progress lines that way, so a caption sentence is never the thing that
  // goes.
  const readoutLimit = constants.maxReadoutLines ?? 10;
  const readoutSource = Array.isArray(readout)
    ? readout.filter(line => typeof line?.text === 'string' && line.text)
    : [];
  const wrapWidthFor = font => Math.max(8, Math.floor(glassWidth / (font * (constants.glyphAspect ?? 0.54))));
  const lineBudgetFor = font => Math.max(0, Math.min(readoutLimit,
    Math.floor((glassHeight - font) / (font * READOUT_LINE_STEP_FACTOR)) + 1));
  const widthOf = measureText ?? (text => text.length * (constants.glyphAspect ?? 0.54));
  const wrapAt = (font, entries) => entries.flatMap(line => {
    const width = glassWidth / font;
    let text = line.text;
    if (line.whole && widthOf(text) > width && line.compactText) text = line.compactText;
    // Protect assembly names without changing the rendered string or its font.
    for (const phrase of line.keepTogether ?? []) text = text.replaceAll(phrase, phrase.replaceAll(' ', '\u00a0'));
    const tokens = text.split(/[ \t\r\n]+/u).flatMap(word => {
      if (widthOf(word) <= width || word.includes('\u00a0')) return [word];
      return word.match(/[^/-]+[/-]?/gu) ?? [word];
    });
    const wrapped = [];
    let current = '';
    for (const word of tokens) {
      const next = current ? `${current} ${word}` : word;
      if (current && widthOf(next.replaceAll('\u00a0', ' ')) > width) {
        wrapped.push(current); current = word;
      } else current = next;
    }
    if (current) wrapped.push(current);
    const limit = line.whole ? readoutLimit : Math.min(line.maxLines ?? readoutLimit, readoutLimit);
    return wrapped.slice(0, limit).map((value, index) => {
      const clipped = index === limit - 1 && wrapped.length > limit;
      let text = value.replaceAll('\u00a0', ' ');
      if (!line.whole && (clipped || widthOf(text) > width)) {
        // Remove complete tokens (including protected phrases), never letters.
        const words = value.split(' ');
        while (words.length && widthOf(words.join(' ').replaceAll('\u00a0', ' ') + '…') > width) words.pop();
        text = words.join(' ').replaceAll('\u00a0', ' ') + '…';
      }
      return { ...line, text };
    });
  });
  // Which optional entry yields next. The rank defaults to the entry's own
  // position, which is the old "drop from the end" rule, so an entry that
  // names no rank behaves exactly as it did. A caller that knows better says
  // so: the tour readout ranks its caption sentence above its headings,
  // because the sentence is narrated aloud and paged from its own row while
  // the scene title is the only line that says what the wearer is looking at.
  const nextToDrop = entries => {
    let chosen = -1, rank = -Infinity;
    entries.forEach((line, index) => {
      if (line.optional !== true) return;
      const value = Number.isFinite(line.dropRank) ? line.dropRank : index;
      if (value >= rank) { chosen = index; rank = value; }
    });
    return chosen;
  };
  const fitAt = (font, { clamp = true } = {}) => {
    const budget = lineBudgetFor(font);
    let entries = readoutSource, wrapped = wrapAt(font, entries);
    while (wrapped.length > budget) {
      const last = nextToDrop(entries);
      if (last < 0) break;
      entries = entries.filter((_, index) => index !== last);
      wrapped = wrapAt(font, entries);
    }
    const overflow = wrapped.length;
    if (clamp && wrapped.length > budget && budget > 0) {
      // Nothing left to drop whole, so the block is shared out rather than
      // cut. Every surviving entry gets an equal number of lines and
      // `boundStatusLines` ends the last of them on a whole word and an
      // ellipsis; the room welcome is three separate instructions, and the
      // third one is the one that says how to press a row.
      //
      // What this replaces was a plain slice of the first `budget` lines,
      // which stopped mid-word: keeping two lines of five leaves the wearer a
      // sentence with no beginning and no end.
      const kept = entries.slice(0, Math.max(1, budget));
      if (kept.some(line => typeof line.compactText === 'string')) {
        // A detailed structure readout has a shorter identity for the compact
        // plate. Reserve one line for each fact (including selection), then
        // spend spare lines on whole words, starting with the molecule title.
        const compact = kept.map(line => ({ ...line, text: line.compactText ?? line.text }));
        const limits = compact.map(line => line.whole ? wrapAt(font, [line]).length : 1);
        let spare = budget - limits.reduce((sum, count) => sum + count, 0);
        for (let index = 0; index < compact.length && spare > 0; index++) {
          const wanted = wrapAt(font, [compact[index]]).length;
          const extra = Math.min(spare, wanted - limits[index]);
          limits[index] += extra; spare -= extra;
        }
        wrapped = wrapAt(font, compact.map((line, index) => ({ ...line, maxLines: limits[index] })));
      } else {
        const share = Math.max(1, Math.floor(budget / kept.length));
        wrapped = wrapAt(font, kept.map(line =>
          ({ ...line, maxLines: Math.min(line.maxLines ?? share, share) })));
      }
    }
    return { wrapped, budget, overflow, dropped: readoutSource.length - entries.length };
  };
  let readoutFactor = constants.readoutFontFactor ?? 1;
  let readoutFontMeters = constants.fontMeters * readoutFactor;
  let fitted = fitAt(readoutFontMeters, { clamp: false });
  // Smaller type is only worth taking when it makes the caption whole. A
  // caption that shrinks to the floor and still loses three lines has paid
  // 0.0255 m of cap height, under Meta's 0.028 m minimum, for nothing. The
  // floor is that minimum, so a caption the eye cannot hold loses words at a
  // legible size rather than keeping them at an illegible one.
  for (let factor = readoutFactor - READOUT_FONT_STEP;
    fitted.wrapped.length > fitted.budget && factor >= READOUT_FONT_FLOOR - EPSILON;
    factor -= READOUT_FONT_STEP) {
    const font = constants.fontMeters * factor;
    const trial = fitAt(font, { clamp: false });
    if (trial.wrapped.length > trial.budget) continue;
    readoutFactor = factor;
    readoutFontMeters = font;
    fitted = trial;
  }
  // No font in the range makes the words whole, so the block is fitted to the
  // lines the eye leaves instead: whole entries, each ending on a word.
  if (fitted.wrapped.length > fitted.budget) fitted = fitAt(readoutFontMeters);
  const readoutLines = fitted.wrapped.slice(0, fitted.budget);
  // A whole page can still exceed the physical block after all optional
  // headings yield. Never let the final defensive slice hide that omission.
  if (fitted.wrapped.length > fitted.budget && readoutLines.length) {
    const last = readoutLines.at(-1), words = last.text.replace(/…$/u, '').split(' ');
    while (words.length && widthOf(words.join(' ') + '…') > glassWidth / readoutFontMeters) words.pop();
    readoutLines[readoutLines.length - 1] = { ...last, text: words.join(' ') + '…' };
  }
  // Words went. They end in an ellipsis now rather than mid-sentence, but the
  // headset log is still the only place the loss can be traced from:
  // `read_headset_log` on the Mac reads it.
  if (fitted.overflow > readoutLines.length) {
    recordToolbarTruncation({ kept: readoutLines.length, wrapped: fitted.overflow,
      limit: fitted.budget, fontFactor: Math.round(readoutFactor * 100) / 100,
      wrapWidth: wrapWidthFor(readoutFontMeters), droppedEntries: fitted.dropped });
  }
  const readoutLineStepMeters = readoutFontMeters * READOUT_LINE_STEP_FACTOR;
  const captionBottom = envelope.floor + captionPad + readoutFontMeters / 2;
  const readoutBottom = add(add(anchor, scale(x, captionCentre)), scale(y, captionBottom));
  const readoutTop = add(readoutBottom, scale(y, (readoutLines.length - 1) * readoutLineStepMeters));
  const readoutPoints = readoutLines.map((line, index) => ({ ...line,
    point: add(readoutTop, scale(y, -index * readoutLineStepMeters)) }));
  const captionTop = captionBottom + (readoutLines.length - 1) * readoutLineStepMeters + readoutFontMeters / 2 + captionPad;
  const captionFloor = envelope.floor;
  const captionBacking = readoutLines.length ? {
    point: add(add(anchor, scale(x, captionCentre)), scale(y, (captionFloor + captionTop) / 2)),
    halfWidth: (envelope.inboard - envelope.outboard) / 2, halfHeight: (captionTop - captionFloor) / 2,
  } : undefined;
  // `seatOrigin` and `seatForward` are the levelled head this panel was seated
  // from, kept so a caller can measure how far the wearer has turned away from
  // it without holding a copy of the pose. Neither is used to draw.
  return { anchor, right: x, up: y, normal, seatOrigin: origin, seatForward: headNormal,
    buttons, statusPoint, statusPoints, readoutPoints, backing, menuObstacle, captionBacking, statusBacking, density,
    fontMeters: constants.fontMeters, readoutFontMeters,
    readoutWrapWidth: wrapWidthFor(readoutFontMeters), readoutLineBudget: fitted.budget,
    captionEnvelope: envelope,
    plateCornerMeters: constants.plateCornerMeters ?? 0, plateBorderMeters: constants.plateBorderMeters ?? 0,
    plateInsetMeters: constants.rowStepMeters * (constants.plateInsetFactor ?? 0.06),
    plateDepthMeters: constants.plateDepthMeters ?? 0,
    bevelMeters: constants.bevelMeters ?? 0, faceLiftMeters: constants.faceLiftMeters ?? 0,
    highlightBiasMeters: constants.highlightBiasMeters ?? 0, pressSinkMeters: constants.pressSinkMeters ?? 0,
    backingCornerMeters: constants.backingCornerMeters ?? 0, backingBorderMeters: constants.backingBorderMeters ?? 0,
    backingDepthMeters: constants.backingDepthMeters ?? 0 };
}

/** Pure target-ray/panel hit test; all arguments are XR local metres. */
export function hitToolbarPanel(panel, ray) {
  if (!panel || !finite3(ray?.origin) || !finite3(ray?.direction)) return undefined;
  const direction = normalizeSpatialVector(ray.direction, [0, 0, 0]);
  if (Math.hypot(...direction) <= EPSILON) return undefined;
  const divisor = dot(direction, panel.normal);
  if (Math.abs(divisor) <= EPSILON) return undefined;
  const distance = dot(sub(panel.anchor, ray.origin), panel.normal) / divisor;
  if (!Number.isFinite(distance) || distance < 0) return undefined;
  const point = add(ray.origin, scale(direction, distance));
  return panel.buttons.find(button => {
    if (button.targetable === false) return undefined;
    const offset = sub(point, button.point);
    return Math.abs(dot(offset, panel.right)) <= button.halfWidth && Math.abs(dot(offset, panel.up)) <= button.halfHeight;
  });
}

/**
 * Rounded-rectangle outline for one row plate, in XR local metres. `inset`
 * shrinks it, so the same call gives both the border and the fill, and `depth`
 * pushes it along the panel normal, away from the wearer, so a plate sits
 * behind its own label. The points run counter-clockwise around the perimeter
 * and are consumed as a triangle fan about the row centre.
 */
export function toolbarPlateOutline(panel, button, { inset = 0, segments = 4, depth = 0, corner: cornerMeters } = {}) {
  if (!panel || !button) return [];
  const halfWidth = Math.max(EPSILON, button.halfWidth - inset);
  const halfHeight = Math.max(EPSILON, button.halfHeight - inset);
  const corner = Math.max(0, Math.min(Number.isFinite(cornerMeters) ? cornerMeters : panel.plateCornerMeters ?? 0, halfWidth, halfHeight));
  const steps = Math.max(1, Math.round(segments));
  const points = [];
  // Counter-clockwise from the top-right corner, so the fan built from these
  // points never folds back on itself.
  const corners = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
  corners.forEach(([signX, signY], index) => {
    const centreX = signX * (halfWidth - corner), centreY = signY * (halfHeight - corner);
    const start = Math.PI / 4 + index * Math.PI / 2 - Math.PI / 4;
    for (let step = 0; step <= steps; step++) {
      const angle = start + (step / steps) * (Math.PI / 2);
      points.push(add(add(add(button.point, scale(panel.right, centreX + Math.cos(angle) * corner)),
        scale(panel.up, centreY + Math.sin(angle) * corner)), scale(panel.normal, depth)));
    }
  });
  return points;
}

/**
 * Rounded-rectangle outline for the dark-glass backing plate, in XR local
 * metres. Same convention as `toolbarPlateOutline`: `inset` shrinks it and
 * `depth` pushes it away from the wearer, so the same call gives the rim and
 * the glass inside it. The corners are wider than a button's, which is what
 * makes it read as the panel rather than one more control.
 */
export function toolbarBackingOutline(panel, { inset = 0, segments = 5, depth = 0, plate } = {}) {
  const target = plate ?? panel?.backing;
  if (!panel || !target) return [];
  return toolbarPlateOutline(panel, target, { inset, segments, depth, corner: panel.backingCornerMeters ?? 0 });
}

/**
 * Every point of the drawn panel, in XR room metres.
 *
 * The plates are what the structure must not pierce, so the rule needs their
 * geometry rather than their layout constants — the seat
 * solver may have swung the panel inboard, a stand-off may have pushed it out,
 * and the caption block's height above the anchor is decided by the envelope.
 * This is the same point set `depthRange` measures the clip band from, taken
 * at its front and back faces so a range built from it holds the whole slab.
 * Read-only: nothing here moves the panel.
 */
export function toolbarPlatePoints(panel) {
  if (!panel) return [];
  const plateDepth = panel.plateDepthMeters ?? 0, backingDepth = panel.backingDepthMeters ?? 0;
  return [...panel.buttons.map(button => button.point),
    ...panel.buttons.flatMap(button => [...toolbarPlateOutline(panel, button, { segments: 1 }),
      ...toolbarPlateOutline(panel, button, { depth: plateDepth, segments: 1 })]),
    ...toolbarBackingOutline(panel, { segments: 2 }),
    ...toolbarBackingOutline(panel, { depth: backingDepth, segments: 2 }),
    ...toolbarBackingOutline(panel, { segments: 2, plate: panel.captionBacking }),
    ...toolbarBackingOutline(panel, { depth: backingDepth, segments: 2, plate: panel.captionBacking }),
    ...(panel.statusBacking ? toolbarBackingOutline(panel, { plate: panel.statusBacking }) : []),
    ...(panel.readoutPoints ?? []).map(line => line.point),
    ...(panel.statusPoints ?? []).map(line => line.point),
    ...(panel.statusPoint ? [panel.statusPoint] : [])].filter(finite3);
}

/** Nearest drawn glass to either eye, including the interiors of the cards. */
export function toolbarHeadClearance(panel, head, offset = [0, 0, 0]) {
  const basis = toolbarSeatBasis(head);
  if (!panel || !basis || !finite3(offset)) return undefined;
  const matrix = head?.transform?.matrix ?? head?.matrix;
  const eyeRight = normalizeSpatialVector(matrix && [matrix[0], matrix[1], matrix[2]], basis.right);
  const plates = [panel.backing, panel.captionBacking, panel.statusBacking, ...panel.buttons].filter(Boolean);
  // Include the lifted face and the back of every plate. Rectangle interiors
  // matter: corners can be far from an eye that is almost touching the glass.
  const front = -(panel.faceLiftMeters ?? 0) - (panel.highlightBiasMeters ?? 0);
  const back = Math.max(panel.backingDepthMeters ?? 0, panel.plateDepthMeters ?? 0);
  let nearest = Infinity;
  for (const side of [-1, 1]) {
    const eye = add(basis.origin, scale(eyeRight, side * HALF_IPD_METERS));
    for (const plate of plates) {
      const relative = sub(eye, add(plate.point, offset));
      const x = Math.max(0, Math.abs(dot(relative, panel.right)) - plate.halfWidth);
      const y = Math.max(0, Math.abs(dot(relative, panel.up)) - plate.halfHeight);
      const depth = dot(relative, panel.normal);
      const z = Math.max(front - depth, depth - back, 0);
      nearest = Math.min(nearest, Math.hypot(x, y, z));
    }
  }
  return nearest;
}

/**
 * Only the caption card's drawn points, in XR room metres.
 *
 * The panel is two cards, not one. The caption glass carries the line the
 * wearer is being spoken and has to read; the menu column under it is buttons,
 * and a lesson dims them. `toolbarPlatePoints` above is the union of both,
 * which is the right answer for the DEPTH stand-off — nothing should be drawn
 * in front of either — and the wrong one for the screen-space seat: that union
 * can span the whole left half of the lens (x −0.87..−0.10, y −0.64..0.84),
 * leaving no seat outside it but hard right against the vignette. The
 * screen-space rule takes this narrower set instead.
 *
 * Empty when there is no caption drawn, which is a panel with no readout: then
 * there is nothing for the subject to sit clear of. Read-only.
 */
export function toolbarCaptionPoints(panel) {
  if (!panel?.captionBacking) return [];
  return [...toolbarBackingOutline(panel, { segments: 2, plate: panel.captionBacking }),
    ...toolbarBackingOutline(panel, { depth: panel.backingDepthMeters ?? 0, segments: 2, plate: panel.captionBacking }),
    ...(panel.readoutPoints ?? []).map(line => line.point)].filter(finite3);
}

/**
 * The menu column's reserved label obstacle, in XR room metres.
 *
 * The buttons and the full reserved status block, without caption glass or
 * status glyph points. The obstacle and its motion signature are identical
 * before, during, and after a spoken confirmation. Read-only.
 */
export function toolbarMenuPoints(panel) {
  if (!panel?.buttons?.length) return [];
  const plateDepth = panel.plateDepthMeters ?? 0;
  const statusBacking = [
    ...toolbarBackingOutline(panel, { segments: 2, plate: panel.menuObstacle ?? panel.backing }),
    ...toolbarBackingOutline(panel, { depth: panel.backingDepthMeters ?? 0, segments: 2,
      plate: panel.menuObstacle ?? panel.backing }),
  ];
  return [...panel.buttons.map(button => button.point),
    ...statusBacking,
    ...panel.buttons.flatMap(button => [...toolbarPlateOutline(panel, button, { segments: 1 }),
      ...toolbarPlateOutline(panel, button, { depth: plateDepth, segments: 1 })])].filter(finite3);
}

/** Actual glass for subject framing; reserved empty space belongs to labels. */
export function toolbarDrawnMenuPoints(panel) {
  if (!panel?.buttons?.length) return [];
  const plateDepth = panel.plateDepthMeters ?? 0;
  const statusBacking = panel.statusPoints?.length ? [
    ...toolbarBackingOutline(panel, { segments: 2 }),
    ...toolbarBackingOutline(panel, { depth: panel.backingDepthMeters ?? 0, segments: 2 }),
  ] : [];
  return [...panel.buttons.map(button => button.point),
    ...statusBacking,
    ...panel.buttons.flatMap(button => [...toolbarPlateOutline(panel, button, { segments: 1 }),
      ...toolbarPlateOutline(panel, button, { depth: plateDepth, segments: 1 })])].filter(finite3);
}

/**
 * One drawn-point set per menu button row, in XR room metres.
 *
 * The ghost-button check tests GHOST POINTS against one rectangle per button,
 * not against the whole column, so it needs the rows
 * unmerged. Same points as `toolbarMenuPoints`, grouped by button. Read-only.
 */
export function toolbarMenuRowPoints(panel) {
  if (!panel?.buttons?.length) return [];
  const plateDepth = panel.plateDepthMeters ?? 0;
  return panel.buttons.map(button => [...(button?.point ? [button.point] : []),
    ...toolbarPlateOutline(panel, button, { segments: 1 }),
    ...toolbarPlateOutline(panel, button, { depth: plateDepth, segments: 1 })].filter(finite3))
    .filter(row => row.length > 0);
}

function transformPoint(point, matrix) {
  const [x, y, z] = point;
  const w = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
  const divisor = Number.isFinite(w) && Math.abs(w) > EPSILON ? w : 1;
  return [(matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]) / divisor,
    (matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]) / divisor,
    (matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]) / divisor];
}


export function mapXrPointToScene(point, inverseView, cameraScale) {
  if (!finite3(point) || !inverseView || !Number.isFinite(cameraScale) || Math.abs(cameraScale) <= EPSILON) return undefined;
  // Transform in XR-local metres first: the camera inverse includes a
  // translation which must be scaled along with the transformed result.
  return scale(transformPoint(point, inverseView), 1 / cameraScale);
}
