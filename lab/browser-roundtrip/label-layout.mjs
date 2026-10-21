// Import-free apart from the label sizing rule it shares a unit with. Keep
// this runnable in Node so the arrangement of ten name plates can be measured
// without a GPU or a headset.
//
// Why this exists
// ---------------
// `label-facing.mjs` decides how big a plate is drawn and which way it faces.
// Neither answer moves a plate, and on the Quest 2 captures of the
// telomerase resting state that was the whole defect: ten plates were drawn,
// ten faced the wearer, nine could be read, and five of them were piled on one
// another across the middle of the cluster with one name completely buried.
//
// Making the text smaller does not fix that. The plates stack because their
// PARTS are close together on screen — two dyskerins, two NOP10s and the RNA
// hairpin they all bind occupy about a quarter of the cluster's width — while
// a plate is as wide as its name: "Telomerase RNA H/ACA domain" is twenty-
// seven characters, which at the resting size is most of the subject's own
// radius. Shrinking the text shrinks the pile; it does not unstack it.
//
// So this moves them. The rule is screen-space, because that is the only space
// in which "these two plates overlap" is a question with an answer, and
// because Mol* already offers exactly that lever:
//
//     vec2 cornerOffset = aMapping * size * scale;
//     cornerOffset.x += offsetX;
//     cornerOffset.y += offsetY;
//     clip.xy += vec2(uProjection[0][0], uProjection[1][1]) * cornerOffset;
//
// `offsetX` and `offsetY` (`mol-gl/shader/text.vert`) displace the whole plate
// — glyphs and background quad together — in the EYE's own plane, through the
// same expansion that makes the plate a billboard. So a plate that is fanned
// by this module is still square to the wearer, still glued to its part's
// depth, and still correct in both eyes: the displacement is applied per eye,
// in that eye's plane, exactly like the glyphs. A world-space nudge would not
// be; it would land at a different screen position in each eye and read as a
// plate floating off its part.
//
// Bounds, the silhouette, and the leader lines
// --------------------------------------------
// A displacement used to be bounded by the projected radius of the part the
// plate names, so a plate could be fanned across the subject but never off it.
// That is the arrangement that was rejected: ten names drawn over the thing
// they describe. The subject's own silhouette is a blocker now, like the
// toolbar, and the bound is widened by whatever clearing it takes, so the
// plates come to rest in a band around the structure instead of on it.
//
// A plate out there is no longer touching its part, so it carries a leader:
// Mol*'s text `tether`, a wedge from the part's centroid to the plate's near
// edge, drawn in the same screen plane as the glyphs and therefore right in
// both eyes. `plateLeader` picks the attachment and length; the viewer draws
// it as one more text layer with a zero-width label, so the wedge lands and no
// second glyph does.
//
// And there is a limit nothing yields to: the field. "Outside the silhouette"
// and "on the glass" ask for opposite things once the subject is seated large,
// and an early device run proved it — an eighty-six degree
// structure, every plate dutifully clear of it, every plate off the edge of
// the display with its leader running out of frame. So `PLATE_FIELD` caps
// every escape, and when the two cannot both be had it is the subject that
// gives way, reported as `subjectOverlaps` rather than hidden.
//
// The menu column, and counting honestly
// --------------------------------------
// The toolbar is an `obstacles` rectangle like any other, and the solver has
// cleared it from the start. What it could not do was see one: the
// viewer solves this layout off `canvas.xr.isPresenting`, which flips seconds
// before the spatial toolbar draws its first panel, and a toolbar with no
// panel reports no points. So every entry solved with an empty
// obstacle list and put "GAR1, first copy" under the Pg 1/8 row. The session
// now calls back when the panel has drawn (`onMenuPlaced`) and the plates are
// solved again against a rectangle that exists.
//
// The diagnostic was no help, because it was not a measurement. Plates are
// placed one at a time and each new plate escapes the ones already down, so
// counting overlaps over the solver's own scratch rectangles answers zero by
// construction. `overlaps`, `menuOverlaps` and every plate's `rect` are now
// rebuilt by `drawnPlateRects` from the offsets about to be emitted, at the
// plate geometry `text-builder.js` actually draws — which is a fifth narrower
// and a third shorter than the half-em paraphrase this module used to model a
// plate with.
//
// The part being explained
// ------------------------
// One plate is not negotiable: the part the current chapter has focused, or
// the part an agent's `emphasize` named, is the thing the wearer is being
// asked to look at. Its plate is placed first, at full size, at its own
// centroid, and every other plate yields to it — first by fanning, then by
// shrinking toward the size the wide view was already read at, and last by
// dimming to the context opacity. A secondary plate may end up overlapping
// another secondary plate when the geometry leaves it no room; it may never
// end up overlapping the focused one.

import { MOLSTAR_TEXT_EM_PER_SIZE } from './label-facing.mjs';

/**
 * Mean glyph advance as a fraction of the em box, for the sans-serif atlas
 * Mol* builds its font from.
 *
 * Mol*'s own text builder measures every character from the atlas
 * (`mol-geo/geometry/text/text-builder.js`), which this cannot reach without a
 * WebGL context. The mean is deliberately on the generous side of a real
 * proportional sans: over-estimating a plate's width only ever makes the
 * solver separate plates that the renderer would have drawn slightly clear of
 * one another, which is the safe direction to be wrong in.
 */
export const PLATE_ADVANCE_PER_EM = 0.55;

/**
 * The `backgroundMargin` the viewer hands Mol* for a headset plate.
 *
 * This is a Mol* PARAMETER, not a length. `mol-geo/geometry/text/
 * text-builder.js:35` turns it into the margin it actually draws with,
 * `margin = (1 / 2.5) * backgroundMargin`, in the mapping units where one em
 * box is `MOLSTAR_TEXT_EM_PER_SIZE`. Reading 0.5 as half an em was the size
 * error this module shipped with: it made every modelled plate a third taller
 * and a fifth wider than the one on the glass, so the record below was
 * measuring a rectangle the renderer never drew.
 */
export const MOLSTAR_BACKGROUND_MARGIN = 0.5;

/** `margin` in `text-builder.js:35`, in mapping units. */
const marginUnits = background => (1 / 2.5) * background;

/**
 * The horizontal padding Mol* draws around a plate's glyphs, in em per side.
 *
 * `text-builder.js` builds the background quad from `xLeft = -xShift - margin
 * - 0.1` to `xRight = bWidth - xShift + margin + 0.1`, so each side carries
 * the margin plus a fixed tenth of a mapping unit.
 */
export const plateMarginEm = (background = MOLSTAR_BACKGROUND_MARGIN) =>
  (marginUnits(background) + 0.1) / MOLSTAR_TEXT_EM_PER_SIZE;

/**
 * The height of one drawn plate line, in em.
 *
 * `yTop - yBottom` is `bHeight + 2 * margin`, and `bHeight` is one em box, so
 * a one-line plate is taller than its character box by the margin alone. A
 * two-line plate is two labels an em apart, so the pair spans one more em than
 * this.
 */
export const plateLineEm = (background = MOLSTAR_BACKGROUND_MARGIN) =>
  1 + (2 * marginUnits(background)) / MOLSTAR_TEXT_EM_PER_SIZE;

/** The background margin around a plate, in em per side, at the drawn setting. */
export const PLATE_MARGIN_EM = plateMarginEm();

/**
 * Clear air between two plates, in em, so a fan reads as two plates.
 *
 * Everything this module measures is in the rendered eye
 * buffer, and what the wearer looks at is that buffer through a lens that
 * compresses the periphery. Four tenths of an em was a real gap in the
 * buffer and no gap at all on the glass: on a later device run
 * "GAR1 1" and "Dyskerin 1" sat in the lower band with the solver reporting
 * them clear, and the capture shows them touching. Distortion can only ever
 * close a gap, so the gap has to be wide enough to survive being closed —
 * and no wider, because every em of it is a plate that no longer fits.
 */
export const PLATE_GAP_EM = 0.5;

/**
 * How far a plate may travel past its part, in plate heights.
 *
 * The bound is the part's own projected radius PLUS this much slack, and the
 * slack is what makes the rule usable on a small subunit: NOP10 is sixty-four
 * residues and about twelve Angstroms across, so its name plate is wider than
 * the subunit is and a bound of "one radius" would leave it nowhere to go. A
 * plate that stays inside the bound is still touching the part it names, which
 * is the property that makes a leader line unnecessary.
 */
export const PLATE_BOUND_HEIGHTS = 3;

/** How many of its part's projected radii a plate may be displaced by. */
export const PLATE_BOUND_RADII = 1;

/**
 * How far past its bound a plate may be pushed when what it is blocking is the
 * focused plate. Clearing the part being explained is mandatory; clearing
 * another secondary plate is not.
 */
export const PLATE_FOCUS_ESCAPE = 3;

/**
 * How far a non-radial escape has to beat the radial one to be taken.
 *
 * Every direction is measured and the shortest wins, which on its own puts
 * every plate off the nearest edge of the subject: a silhouette wider than it
 * is tall sends all ten plates straight down into a column. The subject is a
 * round thing in the middle of the view and the wearer reads the arrangement
 * as a ring around it, so a plate keeps its own outward spoke unless another
 * direction is substantially cheaper.
 */
export const PLATE_RADIAL_BIAS = 1.2;

/**
 * The band of the wearer's view a plate is allowed to come to rest in.
 *
 * A Quest 2 shows about ninety-six degrees across and ninety down the middle
 * of each eye, but the outer third of that is the soft, smeared edge of the
 * lens rather than anything a wearer reads. Forty and thirty-six put the
 * second device run's plates hard against the boundary of the capture with
 * their names cut in half, and thirty-four across still had the fourth run's
 * "NHP2 2" clipped by the right edge. Thirty-one across by thirty down is the
 * band those captures show whole, stated as half-angles. The width is the
 * tighter of the two because a lens compresses hardest where it is widest.
 *
 * It exists because "outside the silhouette" and "on the glass" can ask for
 * opposite things. On an early device run the structure was
 * seated eighty-six degrees across and every plate dutifully cleared it — off
 * the edge of the display, leaving ten leaders running out of frame to names
 * the wearer could not see. Clearing the subject is worth a great deal; it is
 * not worth the plate. Prefer this field for every escape; the final free-space
 * solve uses outward bands only when the remaining readable bands are full.
 * Subject clearance, plate dimensions and maximum tether reach remain intact.
 */
export const PLATE_FIELD_DEGREES = Object.freeze({ halfWidth: 31, halfHeight: 30 });

/** That band in tangent units, which is what the solver measures in. */
export const PLATE_FIELD = Object.freeze({
  halfWidth: Math.tan((PLATE_FIELD_DEGREES.halfWidth * Math.PI) / 180),
  halfHeight: Math.tan((PLATE_FIELD_DEGREES.halfHeight * Math.PI) / 180),
});

/**
 * How many resting slots the band around the silhouette carries per side.
 *
 * The fifth device run put seven of ten plates in a heap
 * under the structure, each leader running the height of the view, while the
 * band above and to the right of it was empty. The cause is that a straight
 * shortest escape is the SAME direction for every part in the middle of a
 * silhouette that is wider than it is tall — down — and a plate that finds the
 * bottom occupied is pushed further down rather than around. Nine per side is
 * enough that a name plate has somewhere to sit at every point of the band and
 * few enough that the nearest free one is still near its own part.
 */
export const PLATE_BAND_SLOTS = 15;

/**
 * The air, in tangent units, the name plates keep off the menu and card
 * glass. The menu admits a chapter only with 0.04 of each eye's view between
 * its glass and every drawn plate quad, which is wider than the text the
 * layout measures and sits half an eye's spacing off the head centre. A plate
 * laid flush against the card failed that admission, and the menu left the
 * forward view for a turned-head seat. This is that gap, the quad's pad and
 * the parallax, with a little to spare.
 */
export const MENU_PLATE_AIR = 0.07;

/** Menu and card glass rectangles as plate obstacles, each widened by `MENU_PLATE_AIR`. */
export const menuGlassObstacles = rects => rects.filter(Boolean).map(glass => ({ ...glass,
  halfWidth: glass.halfWidth + MENU_PLATE_AIR, halfHeight: glass.halfHeight + MENU_PLATE_AIR }));

/**
 * How many plate-deep bands the slot set carries on each side.
 *
 * Ten plates do not fit on one ring around a silhouette that fills most of the
 * readable field, and the alternative to a second ring is a plate sent to the
 * far side of the structure on a leader drawn across it. Three is what the
 * telomerase lobe needs at the resting gain; a fourth would be off the glass.
 */
export const PLATE_BAND_RINGS = 3;

/**
 * How much a slot on the plate's own outward spoke is preferred, as a share of
 * the leader length it costs.
 *
 * Nearest-free-slot alone would let a plate cross the silhouette to reach a
 * marginally closer slot on the far side, which reads as a leader pointing
 * through the structure. This discount is small: it decides near-ties in
 * favour of the plate's own side and never buys a materially longer leader.
 */
export const PLATE_SLOT_RADIAL_PREFERENCE = 0.15;

/** The size steps a secondary plate yields through before it dims. */
export const PLATE_SIZE_LADDER = Object.freeze([1, 0.85]);

/**
 * The eight ways Mol* can hang a plate off its anchor, and which way that
 * displaces the plate.
 *
 * `attachment` names the corner or edge of the plate the anchor sits at, so
 * the plate travels the OPPOSITE way: `middle-left` puts the anchor at the
 * plate's left edge and the plate to the right of it. With `tether` on,
 * `text-builder.js` shifts the plate by the tether length along that direction
 * and lands the triangle's tip exactly on the anchor, which is what makes a
 * leader possible at all.
 *
 * `axes` is how many axes the shift is split across: an edge attachment moves
 * the plate by the whole tether length, a corner attachment by half of it on
 * each axis.
 */
export const PLATE_ATTACHMENTS = Object.freeze([
  Object.freeze({ attachment: 'middle-left', direction: Object.freeze([1, 0]), axes: 1 }),
  Object.freeze({ attachment: 'middle-right', direction: Object.freeze([-1, 0]), axes: 1 }),
  Object.freeze({ attachment: 'bottom-center', direction: Object.freeze([0, 1]), axes: 1 }),
  Object.freeze({ attachment: 'top-center', direction: Object.freeze([0, -1]), axes: 1 }),
  Object.freeze({ attachment: 'bottom-left', direction: Object.freeze([Math.SQRT1_2, Math.SQRT1_2]), axes: 2 }),
  Object.freeze({ attachment: 'bottom-right', direction: Object.freeze([-Math.SQRT1_2, Math.SQRT1_2]), axes: 2 }),
  Object.freeze({ attachment: 'top-left', direction: Object.freeze([Math.SQRT1_2, -Math.SQRT1_2]), axes: 2 }),
  Object.freeze({ attachment: 'top-right', direction: Object.freeze([-Math.SQRT1_2, -Math.SQRT1_2]), axes: 2 }),
]);

/**
 * The leader that ties a displaced plate back to the part it names.
 *
 * A plate placed outside the subject's silhouette is no longer touching the
 * thing it names, so the wearer needs a line saying which is which. Mol*'s
 * text geometry draws exactly that — a wedge from the anchor to the plate's
 * own edge, in the same screen plane as the glyphs and therefore right in both
 * eyes — and it costs one more text layer rather than a new primitive.
 *
 * The wedge's direction is one of the eight `attachment` values, so it is
 * quantised where the plate's own displacement is not. The length returned is
 * the displacement's component along the direction chosen, which leaves the
 * wide end of the wedge at the plate rather than past it.
 *
 * `tetherLength` comes back in Mol*'s own mapping units, which is what the
 * `tetherLength` parameter takes: one mapping unit is the size factor in scene
 * units, and `characterUnits` is that factor times one em box.
 *
 * @param {object} options
 * @param {number} options.offsetX the plate's displacement, in scene units
 * @param {number} options.offsetY the plate's displacement, in scene units
 * @param {number} options.characterUnits scene units per character box, as drawn
 * @returns {{attachment:string, tetherLength:number}|null} null when the plate did not move
 */
export function plateLeader({ offsetX = 0, offsetY = 0, characterUnits } = {}) {
  if (!finite(characterUnits) || characterUnits <= 0) throw Error('A plate leader needs a positive character size.');
  const dx = finite(offsetX) ? offsetX : 0, dy = finite(offsetY) ? offsetY : 0;
  const length = Math.hypot(dx, dy);
  if (!(length > EPS)) return null;
  // Scene units to mapping units: `characterUnits` is one em box drawn, and
  // `MOLSTAR_TEXT_EM_PER_SIZE` is that box in mapping units.
  const mapping = MOLSTAR_TEXT_EM_PER_SIZE / characterUnits;
  let best = null;
  for (const option of PLATE_ATTACHMENTS) {
    const along = dx * option.direction[0] + dy * option.direction[1];
    if (!(along > EPS)) continue;
    if (!best || along > best.along + EPS) best = { option, along };
  }
  if (!best) return null;
  // An edge attachment shifts the plate by the whole tether length; a corner
  // attachment splits it in half across both axes, so the same travel needs a
  // tether root-two times longer.
  const scale = best.option.axes === 2 ? Math.SQRT2 : 1;
  return { attachment: best.option.attachment, tetherLength: best.along * mapping * scale };
}

/** Maximum content width of one name-plate line, in character ems. */
export const PLATE_MAX_WIDTH_EM = 24;

const EPS = 1e-9;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const vec3 = (value, fallback) => (Array.isArray(value) && value.length >= 3
  && value.slice(0, 3).every(entry => finite(Number(entry)))
  ? [Number(value[0]), Number(value[1]), Number(value[2])] : (fallback ? [...fallback] : null));
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const length = a => Math.hypot(a[0], a[1], a[2]);

/**
 * The depth a plate is DRAWN at, given the depth its anchor sits at.
 *
 * Mol*'s `text.vert` pushes every plate toward the eye by
 * its `offsetZ` before it projects the centre, and it does so in the headset
 * too: the stereo eye cameras never carry a `viewEye`, so `uHasEyeCamera` is
 * false and the radial push runs in every eye pass. The push does not move
 * the anchor on the glass, but the glyph expansion and the solver's
 * `offsetX`/`offsetY` are added in clip space and divided by the PUSHED
 * depth, so a plate lands `depth / drawDepth` times further from its anchor,
 * and that much bigger, than a model that divides by the anchor depth says.
 * On the telomerase entry that ratio was about 1.4: half to one plate width
 * on every fanned plate, and GAR1 1 drawn over dyskerin 1 while the solver
 * counted no overlap. Every conversion between scene units and tangent
 * units that describes the plate itself goes through this; the part's own
 * disc and gap, which are not pushed, stay on the anchor depth.
 *
 * @param {ArrayLike<number>} relative the anchor, relative to the eye
 * @param {number} depth the anchor's depth along the view axis
 * @param {number} [standoff] the plate's `offsetZ`, in scene units
 * @returns {number} the pushed depth, or the anchor depth without a stand-off
 */
export function plateDrawDepth(relative, depth, standoff = 0) {
  if (!finite(standoff) || standoff <= 0) return depth;
  const distance = length(relative);
  return distance > EPS ? depth * (1 - standoff / distance) : depth;
}
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = a => {
  const length = Math.hypot(a[0], a[1], a[2]);
  return length > EPS ? [a[0] / length, a[1] / length, a[2] / length] : null;
};

/**
 * The wearer's own right/up/forward at the seat, as three orthonormal vectors
 * in the structure's coordinate space.
 *
 * This is the frame `offsetX`/`offsetY` act in. It is built from the camera's
 * eye, target and up rather than from a view matrix so a test can state a seat
 * in three readable vectors.
 *
 * @param {object} options
 * @param {ArrayLike<number>} options.eye where the wearer's eye is
 * @param {ArrayLike<number>} options.target what it is looking at
 * @param {ArrayLike<number>} [options.up] the wearer's up, roughly
 * @returns {{right:number[], up:number[], forward:number[]}}
 */
export function plateViewBasis({ eye, target, up = [0, 1, 0] } = {}) {
  const from = vec3(eye);
  const at = vec3(target);
  if (!from || !at) throw Error('A plate layout needs a finite eye and target.');
  const forward = unit(sub(at, from));
  if (!forward) throw Error('A plate layout needs an eye and a target that differ.');
  const hint = vec3(up, [0, 1, 0]);
  // A wearer looking straight up or down leaves `up` parallel to `forward` and
  // the cross product degenerate. Substituting an axis keeps the frame defined
  // rather than handing the solver a NaN basis.
  let right = unit(cross(forward, hint));
  if (!right) right = unit(cross(forward, Math.abs(forward[1]) > 0.9 ? [0, 0, 1] : [0, 1, 0]));
  // A cross product mints negative zero freely. It is a fine number and a
  // failed deep-equal, so normalise it away before the basis is handed on.
  const clean = axis => axis.map(value => (value === 0 ? 0 : value));
  return { right: clean(right), up: clean(cross(right, forward)), forward: clean(forward) };
}

const textLines = text => Array.isArray(text)
  ? text.map(line => String(line ?? '')).filter(Boolean)
  : String(text ?? '').split(/\r?\n/u).filter(Boolean);

const textWidthEm = (text, measureText, advancePerEm) => {
  const measured = typeof measureText === 'function' ? Number(measureText(String(text ?? ''))) : NaN;
  return Number.isFinite(measured) && measured >= 0
    ? measured : Math.max(1, String(text ?? '').length) * advancePerEm;
};

/**
 * Wrap a plate name into at most two lines before it reaches the widest plate.
 * The callback measures the same drawn font as the renderer, in ems of the
 * character box. A character split is the last resort for a single long token.
 */
export function wrapPlateText(text, { measureText, advancePerEm = PLATE_ADVANCE_PER_EM,
  maxWidthEm = PLATE_MAX_WIDTH_EM } = {}) {
  const raw = String(text ?? '').trim().replace(/\s+/gu, ' ');
  if (!raw) return [''];
  if (!(Number.isFinite(maxWidthEm) && maxWidthEm > 0)) return [raw];
  if (textWidthEm(raw, measureText, advancePerEm) <= maxWidthEm + EPS) return [raw];

  const words = raw.split(' ');
  let best;
  for (let split = 1; split < words.length; split += 1) {
    const first = words.slice(0, split).join(' '), second = words.slice(split).join(' ');
    const width = Math.max(textWidthEm(first, measureText, advancePerEm),
      textWidthEm(second, measureText, advancePerEm));
    if (width <= maxWidthEm + EPS && (!best || width < best.width)) best = { lines: [first, second], width };
  }
  if (best) return best.lines;

  // There was no usable word boundary. Split the string at the closest measured
  // half while retaining every character, so even a deliberately long token
  // is never silently clipped.
  let split;
  for (let index = 1; index < raw.length; index += 1) {
    const left = raw.slice(0, index), right = raw.slice(index);
    if (textWidthEm(left, measureText, advancePerEm) <= maxWidthEm + EPS
      && textWidthEm(right, measureText, advancePerEm) <= maxWidthEm + EPS) {
      if (split === undefined || Math.abs(index - raw.length / 2) < Math.abs(split - raw.length / 2)) split = index;
    }
  }
  if (split === undefined) split = Math.max(1, Math.floor(raw.length / 2));
  return [raw.slice(0, split).trimEnd(), raw.slice(split).trimStart()];
}

/**
 * Half the width and height of the plate Mol* will DRAW, in scene units.
 *
 * Every term is `text-builder.js`'s own: the glyph run `bWidth`, the
 * background margin it derives from `backgroundMargin`, the fixed tenth of a
 * unit on each side, and the one-em pitch the viewer stacks a wrapped name at.
 * Nothing here is a paraphrase, because the solver's separation and the
 * record's overlap count both have to be the rectangle on the glass.
 *
 * @param {object} options
 * @param {string|string[]} options.text the name drawn on the plate
 * @param {number} options.characterUnits scene units per character box
 * @param {number} [options.backgroundMargin] the Mol* param the viewer passes
 * @returns {{halfWidth:number, halfHeight:number, lines:string[]}}
 */
export function plateHalfExtents({ text, characterUnits,
  advancePerEm = PLATE_ADVANCE_PER_EM, backgroundMargin = MOLSTAR_BACKGROUND_MARGIN,
  measureText, maxWidthEm = PLATE_MAX_WIDTH_EM } = {}) {
  if (!finite(characterUnits) || characterUnits <= 0) throw Error('A plate needs a positive character size.');
  const lines = Array.isArray(text) ? textLines(text) : wrapPlateText(text, { measureText, advancePerEm, maxWidthEm });
  const widths = lines.map(line => textWidthEm(line, measureText, advancePerEm));
  const count = Math.max(1, lines.length);
  return {
    halfWidth: characterUnits * (Math.max(1, ...widths) + 2 * plateMarginEm(backgroundMargin)) / 2,
    halfHeight: characterUnits * ((count - 1) + plateLineEm(backgroundMargin)) / 2,
    lines,
  };
}

/**
 * Project a set of scene points into one conservative screen-space rectangle.
 * Toolbar points are room geometry after their room-to-scene transform; the
 * solver only needs their tangent-space footprint and never counts this rect
 * as a plate-to-plate overlap.
 */
export function screenRectFromPoints({ points = [], eye, target, up = [0, 1, 0] } = {}) {
  const basis = plateViewBasis({ eye, target, up });
  const from = vec3(eye);
  // A whole mesh can arrive here, so the extremes stream rather than spread.
  let seen = 0, minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const point of points) {
    const value = vec3(point);
    if (!value) continue;
    const relative = sub(value, from), depth = dot(relative, basis.forward);
    if (!(depth > EPS)) continue;
    const x = dot(relative, basis.right) / depth, y = dot(relative, basis.up) / depth;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    seen++;
  }
  if (!seen) return null;
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2,
    halfWidth: Math.max(EPS, (maxX - minX) / 2), halfHeight: Math.max(EPS, (maxY - minY) / 2) };
}

/**
 * The screen rectangle a sphere fills: the subject's own silhouette.
 *
 * Square rather than round, which over-states the corners. That is the safe
 * direction: a plate cleared of the square is clear of the structure, and the
 * few extra tangent units it travels to get there are a plate it is not
 * sitting on.
 *
 * @param {object} options
 * @param {ArrayLike<number>} options.anchor the sphere's centre, in scene units
 * @param {number} options.radius the sphere's radius, in scene units
 * @returns {{x:number,y:number,halfWidth:number,halfHeight:number}|null}
 */
export function projectedSphereRect({ anchor, radius, eye, target, up = [0, 1, 0] } = {}) {
  const basis = plateViewBasis({ eye, target, up });
  const from = vec3(eye);
  const centre = vec3(anchor);
  if (!centre || !finite(radius) || radius <= 0) return null;
  const relative = sub(centre, from);
  const depth = dot(relative, basis.forward);
  if (!(depth > EPS)) return null;
  const half = radius / depth;
  return { x: dot(relative, basis.right) / depth, y: dot(relative, basis.up) / depth,
    halfWidth: half, halfHeight: half };
}

const overlaps = (a, b, gap) => Math.abs(a.x - b.x) < a.halfWidth + b.halfWidth + gap - EPS
  && Math.abs(a.y - b.y) < a.halfHeight + b.halfHeight + gap - EPS;

/** How many plates draw over the subject's own silhouette. */
export function countSubjectOverlaps(placements = [], subject = null) {
  return subject ? countObstacleOverlaps(placements, [subject]) : 0;
}

/**
 * The box the named parts fill on the glass, from their own projected discs.
 *
 * Needs three parts before it will speak: two subunits bound nothing, and a
 * subject the solver has under-measured is worse than one it has over-measured
 * — a plate cleared of too small a box lands on the structure.
 *
 * @param {Array<{x:number,y:number,radius:number}>} live entries at a real depth
 * @returns {{x:number,y:number,halfWidth:number,halfHeight:number}|null}
 */
export function partsSilhouette(live = []) {
  const usable = live.filter(entry => finite(entry?.x) && finite(entry?.y) && finite(entry?.radius));
  if (usable.length < 3) return null;
  const minX = Math.min(...usable.map(entry => entry.x - entry.radius));
  const maxX = Math.max(...usable.map(entry => entry.x + entry.radius));
  const minY = Math.min(...usable.map(entry => entry.y - entry.radius));
  const maxY = Math.max(...usable.map(entry => entry.y + entry.radius));
  if (!(maxX > minX + EPS) || !(maxY > minY + EPS)) return null;
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2,
    halfWidth: (maxX - minX) / 2, halfHeight: (maxY - minY) / 2 };
}

/** Whether two laid-out plates draw over one another. Tests count with this. */
export function platesOverlap(a, b) {
  return Boolean(a?.rect && b?.rect && overlaps(a.rect, b.rect, 0));
}

/** How many pairs of laid-out plates draw over one another. */
export function countPlateOverlaps(placements = []) {
  let pairs = 0;
  for (let i = 0; i < placements.length; i++) {
    for (let j = i + 1; j < placements.length; j++) if (platesOverlap(placements[i], placements[j])) pairs += 1;
  }
  return pairs;
}

/** How many plates draw over one of the rectangles the solver was told to avoid. */
export function countObstacleOverlaps(placements = [], obstacles = []) {
  let pairs = 0;
  for (const placement of placements) {
    if (!placement?.rect) continue;
    for (const obstacle of obstacles) {
      if (obstacle && overlaps(placement.rect, obstacle, 0)) pairs += 1;
    }
  }
  return pairs;
}

/**
 * Complete free-space query for one rectangle. Expand obstacles by the plate's
 * half extents, then scan every horizontal boundary of that arrangement. A
 * free band has constant blocked x intervals; its closest point to the anchor
 * lies on a boundary or on the anchor's own scan line. No pixel grid, candidate
 * budget or search timeout can hide a slot. The nearest point also decides
 * whether any slot satisfies the existing maximum anchor displacement.
 */
export function freePlateSlot(rect, obstacles, field, anchor = rect, maxTravel = Infinity, gap = 0, preferred = anchor, exclusion, collect) {
  let lx = -field.halfWidth + rect.halfWidth, rx = -lx;
  let by = -field.halfHeight + rect.halfHeight, ty = -by;
  if (lx > rx + EPS || by > ty + EPS) return null;
  if (lx > rx) lx = rx = 0;
  if (by > ty) by = ty = 0;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const boxes = obstacles.map(o => ({
    l: o.x - o.halfWidth - rect.halfWidth - gap,
    r: o.x + o.halfWidth + rect.halfWidth + gap,
    b: o.y - o.halfHeight - rect.halfHeight - gap,
    t: o.y + o.halfHeight + rect.halfHeight + gap,
  }));
  const cuts = [by, ty, clamp(anchor.y, by, ty), clamp(preferred.y, by, ty),
    ...boxes.flatMap(o => [o.b, o.t])];
  // A nonzero stand-off pushes along the eye ray. On an off-axis anchor,
  // an in-plane move back toward that ray can reduce the physical separation.
  // Exclude that disk, and include every disk/edge and disk/disk intersection
  // in the scan. These are all events at which a free interval can appear.
  const circles = [exclusion, Number.isFinite(maxTravel)
    ? { x: anchor.x, y: anchor.y, radius: maxTravel } : null].filter(Boolean);
  for (const circle of circles) {
    cuts.push(circle.y - circle.radius, circle.y + circle.radius);
    for (const x of [lx, rx, ...boxes.flatMap(o => [o.l, o.r])]) {
      const square = circle.radius ** 2 - (x - circle.x) ** 2;
      if (square >= 0) cuts.push(circle.y - Math.sqrt(square), circle.y + Math.sqrt(square));
    }
  }
  if (circles.length === 2) {
    const [a, b] = circles, dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy);
    if (d > EPS && d <= a.radius + b.radius && d >= Math.abs(a.radius - b.radius)) {
      const along = (a.radius ** 2 - b.radius ** 2 + d * d) / (2 * d);
      const cross = Math.sqrt(Math.max(0, a.radius ** 2 - along * along));
      cuts.push(a.y + along * dy / d - cross * dx / d, a.y + along * dy / d + cross * dx / d);
    }
  }
  const ys = [...new Set(cuts.filter(y => y >= by && y <= ty))].sort((a, b) => a - b);
  let best, distance = Infinity;
  for (const y of ys) {
    const intervals = boxes.filter(o => y > o.b + EPS && y < o.t - EPS)
      .sort((a, b) => a.l - b.l || a.r - b.r);
    let left = lx;
    const consider = right => {
      let lo = left, hi = right;
      if (Number.isFinite(maxTravel)) {
        const square = maxTravel ** 2 - (y - anchor.y) ** 2;
        if (square < -EPS) return;
        const width = Math.sqrt(Math.max(0, square));
        lo = Math.max(lo, anchor.x - width); hi = Math.min(hi, anchor.x + width);
      }
      const candidate = (l, r) => {
        if (r < l - EPS) return;
        for (const x of collect ? [l, clamp(preferred.x, l, r), r] : [clamp(preferred.x, l, r)]) {
          const travel = Math.hypot(x - anchor.x, y - anchor.y);
          const at = { ...rect, x, y }, cost = Math.hypot(x - preferred.x, y - preferred.y);
          if (travel <= maxTravel + EPS && (collect || cost < distance - EPS)
            && (!exclusion || Math.hypot(x - exclusion.x, y - exclusion.y) >= exclusion.radius - EPS)
            && !obstacles.some(o => overlaps(at, o, gap))) {
            collect?.(at);
            if (cost < distance - EPS) { best = at; distance = cost; }
          }
        }
      };
      const square = exclusion ? exclusion.radius ** 2 - (y - exclusion.y) ** 2 : -1;
      if (square > 0) {
        const width = Math.sqrt(square);
        candidate(lo, Math.min(hi, exclusion.x - width));
        candidate(Math.max(lo, exclusion.x + width), hi);
      } else candidate(lo, hi);
    };
    for (const interval of intervals) {
      if (interval.r < lx || interval.l > rx) continue;
      consider(Math.min(rx, interval.l));
      left = Math.max(left, interval.r);
      if (left > rx) break;
    }
    if (left <= rx) consider(rx);
  }
  return best ?? null;
}

/** Nodes the exact plate search may visit before it reports an incomplete answer. */
export const PLATE_SEARCH_CEILING = 20000;

/** Area of the field not covered by the union of the rectangles, clipped to it. */
export function clippedFreeArea(field, rects) {
  const clampX = value => Math.max(-field.halfWidth, Math.min(field.halfWidth, value));
  const cuts = [...new Set([-field.halfWidth, field.halfWidth,
    ...rects.flatMap(o => [clampX(o.x - o.halfWidth), clampX(o.x + o.halfWidth)])])].sort((a, b) => a - b);
  let free = 4 * field.halfWidth * field.halfHeight;
  for (let i = 1; i < cuts.length; i++) {
    const x = (cuts[i - 1] + cuts[i]) / 2;
    const spans = rects.filter(o => Math.abs(x - o.x) < o.halfWidth).map(o =>
      [Math.max(-field.halfHeight, o.y - o.halfHeight), Math.min(field.halfHeight, o.y + o.halfHeight)])
      .filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
    let top = -field.halfHeight, covered = 0;
    for (const [a, b] of spans) { covered += Math.max(0, b - Math.max(a, top)); top = Math.max(top, b); }
    free -= (cuts[i] - cuts[i - 1]) * covered;
  }
  return free;
}

/**
 * The candidate space of one plate: the finite slot set the exact packer
 * enumerates for it, nearest to its anchor first.
 *
 *   X_p = { anchor.x }
 *       ∪ { ±(field.halfWidth − halfWidth_p) }                 flush with the glass edge
 *       ∪ { o.x ± (o.halfWidth + halfWidth_p) : o an obstacle } flush with a blocker
 *       ∪ { −field.halfWidth + halfWidth_p + k·ρ : k ≥ 0 }     the ρ grid across the field
 *   Y_p likewise, with horizontal edges, halfHeight_p and the same ρ.
 *   S_p = { (x, y) ∈ X_p × Y_p : inside the field, within the maximum tether
 *           reach of the anchor, outside the stand-off exclusion disk, and
 *           clear of every obstacle }.
 *
 * ρ is the named `resolution` parameter; its default in `packPlateField` and
 * `exactPlateSearch` is the smallest plate half-height. The search is exhaustive
 * only over these declared candidate sets (unless its node ceiling interrupts
 * it): anchor coordinates, flush contacts with field and obstacle edges, and
 * the ρ grid. An arrangement requiring positions outside these sets is not
 * searched. In particular, plate-to-plate contacts do not add coordinates.
 * Halving ρ samples more positions at greater slot and search cost; it does
 * not establish completeness over continuous free space.
 *
 * @param {{rect:object, anchorRect?:object, maxTravel?:number, exclusion?:object}} p
 * @param {Array<{x:number,y:number,halfWidth:number,halfHeight:number}>} obstacles
 * @param {{halfWidth:number, halfHeight:number}} field
 * @param {number} resolution the grid step ρ, in the field's tangent units
 * @returns {Array<{x:number,y:number,halfWidth:number,halfHeight:number}>}
 */
export function plateFieldSlots(p, obstacles, field, resolution) {
  const rect = p.rect, anchor = p.anchorRect ?? rect, reach = p.maxTravel ?? Infinity;
  const lx = -field.halfWidth + rect.halfWidth, rx = -lx;
  const by = -field.halfHeight + rect.halfHeight, ty = -by;
  if (lx > rx + EPS || by > ty + EPS || !(resolution > EPS)) return [];
  const xs = new Set([anchor.x, lx, rx]), ys = new Set([anchor.y, by, ty]);
  for (const o of obstacles) for (const sign of [-1, 1]) {
    xs.add(o.x + sign * (o.halfWidth + rect.halfWidth));
    ys.add(o.y + sign * (o.halfHeight + rect.halfHeight));
  }
  for (let k = 0, x = lx; x <= rx + EPS; k++, x = lx + k * resolution) xs.add(x);
  for (let k = 0, y = by; y <= ty + EPS; k++, y = by + k * resolution) ys.add(y);
  const slots = [];
  for (const x of xs) {
    if (x < lx - EPS || x > rx + EPS) continue;
    for (const y of ys) {
      if (y < by - EPS || y > ty + EPS) continue;
      if (Math.hypot(x - anchor.x, y - anchor.y) > reach + EPS) continue;
      if (p.exclusion && Math.hypot(x - p.exclusion.x, y - p.exclusion.y) < p.exclusion.radius - EPS) continue;
      const at = { ...rect, x, y };
      if (!obstacles.some(o => overlaps(at, o, 0))) slots.push(at);
    }
  }
  const cost = at => Math.hypot(at.x - anchor.x, at.y - anchor.y);
  return slots.sort((a, b) => cost(a) - cost(b) || a.y - b.y || a.x - b.x);
}

/**
 * The lowest, then leftmost, point of the field not inside any blocker: the
 * corner every completion of a tight field must cover first.
 */
export function lowestFreePoint(field, blockers) {
  const ys = [...new Set([-field.halfHeight, ...blockers.map(o => o.y + o.halfHeight)])]
    .filter(y => y >= -field.halfHeight - EPS && y < field.halfHeight - EPS).sort((a, b) => a - b);
  for (const y of ys) {
    const spans = blockers.filter(o => o.y - o.halfHeight <= y + EPS && o.y + o.halfHeight > y + EPS)
      .map(o => [o.x - o.halfWidth, o.x + o.halfWidth]).sort((a, b) => a[0] - b[0]);
    let x = -field.halfWidth;
    for (const [left, right] of spans) { if (left > x + EPS) break; x = Math.max(x, right); }
    if (x < field.halfWidth - EPS) return { x, y };
  }
  return null;
}

/**
 * Exact search over the product of the plates' candidate spaces.
 *
 * Depth-first. In a loose field (the plates need less area than is free) it
 * branches on the plate with the fewest slots still compatible with the
 * placed plates, tries every one of those slots, and after each placement
 * drops the remaining plates' slots that overlap it. This enumerates
 * S_1 × … × S_n completely: branching on a plate tries all of its slots, so
 * the choice of plate loses nothing; a dropped slot overlaps a placed plate,
 * so it is in no completion of that branch; a plate left with no slot, or
 * less free area than the unplaced plates need, proves the branch empty.
 *
 * In a tight field (the plates need exactly the free area) every completion
 * covers every free point, so the plate covering the lowest, leftmost free
 * point `q` has its bottom-left corner exactly at `q`: a plate whose bottom
 * edge were lower, or left edge further left, would have free interior below
 * or beside `q`. Branching over the plates that own a slot cornered at `q`
 * is therefore complete as well, with at most one slot per plate per node.
 *
 * The search returns an arrangement whenever one exists in the product, and
 * null when none does, unless it reaches `ceiling` nodes first, which it
 * reports as `complete: false`. Worst case: ∏|S_p| nodes in a loose field
 * and n! in a tight one, each O(Σ|S_q|) overlap tests; ten plates on the
 * acceptance fields have a few hundred slots each and the forward checking
 * keeps the visited count in the tens. overprint-device.test.mjs measures
 * nodes and milliseconds per action, including planted tight tilings.
 *
 * @returns {{placed: Map<string, object>|null, nodes:number, complete:boolean,
 *   slots:number, resolution:number, tight:boolean}}
 */
export function exactPlateSearch(placements, obstacles, field, { resolution, ceiling = PLATE_SEARCH_CEILING } = {}) {
  const rho = finite(resolution) && resolution > EPS ? resolution
    : Math.min(...placements.map(p => p.rect.halfHeight));
  const domains = placements.map(p => ({ p, slots: plateFieldSlots(p, obstacles, field, rho) }));
  const placed = new Map();
  const area = rect => 4 * rect.halfWidth * rect.halfHeight;
  const needed = placements.reduce((sum, p) => sum + area(p.rect), 0);
  const tight = Math.abs(clippedFreeArea(field, obstacles) - needed) < 1e-7;
  let nodes = 0, complete = true;
  const attempt = (entry, at, live, remaining) => {
    const next = live.filter(other => other !== entry)
      .map(other => ({ p: other.p, slots: other.slots.filter(slot => !overlaps(slot, at, 0)) }));
    if (next.some(other => !other.slots.length)) return false;
    placed.set(entry.p.id, at);
    if (next.length && !tight && clippedFreeArea(field, [...obstacles, ...placed.values()]) < remaining - EPS) {
      placed.delete(entry.p.id);
      return false;
    }
    if (step(next, remaining)) return true;
    placed.delete(entry.p.id);
    return false;
  };
  function step(live, remaining) {
    if (!live.length) return true;
    if (nodes >= ceiling) { complete = false; return false; }
    nodes++;
    if (tight) {
      const corner = lowestFreePoint(field, [...obstacles, ...placed.values()]);
      if (!corner) return false;
      for (const entry of live) {
        const at = entry.slots.find(slot => Math.abs(slot.x - slot.halfWidth - corner.x) < EPS
          && Math.abs(slot.y - slot.halfHeight - corner.y) < EPS);
        if (at && attempt(entry, at, live, remaining - area(entry.p.rect))) return true;
        if (!complete) return false;
      }
      return false;
    }
    let pick = 0;
    for (let i = 1; i < live.length; i++) if (live[i].slots.length < live[pick].slots.length) pick = i;
    const entry = live[pick];
    for (const at of entry.slots) {
      if (attempt(entry, at, live, remaining - area(entry.p.rect))) return true;
      if (!complete) return false;
    }
    return false;
  }
  const found = step(domains, needed);
  return { placed: found ? placed : null, nodes, complete, resolution: rho, tight,
    slots: domains.reduce((sum, entry) => sum + entry.slots.length, 0) };
}

/**
 * Repack the field. Every plate keeps its dimensions. Greedy band passes come
 * first: the readable field with breathing room, then contact-free packing,
 * each from the anchors and from every corner. When they fail, the exact
 * search above runs over the explicit candidate space (`plateFieldSlots`, at
 * `resolution`, defaulting to the smallest plate half-height). If that finite
 * search finds no arrangement, this does not prove the continuous field full:
 * stack outward in the nearest free band within the tether. The maximum
 * tether reach remains a hard bound; otherwise overlap is minimized with the
 * subject kept clear. The returned map carries `search` whenever the exact
 * search ran: its node count, slot count, resolution and whether it completed.
 */
export function packPlateField(placements, obstacles, field, {
  resolution = Math.min(...placements.map(p => p.rect?.halfHeight ?? Infinity)),
  ceiling = PLATE_SEARCH_CEILING, prioritizeFocus = false,
} = {}) {
  if (!field || !placements.length || placements.some(p => !p.rect)) return null;
  const order = [...placements].sort((a, b) => (prioritizeFocus
    ? Number(Boolean(b.focused)) - Number(Boolean(a.focused)) : 0) || b.rect.halfWidth - a.rect.halfWidth
    || b.rect.halfHeight - a.rect.halfHeight || String(a.id).localeCompare(String(b.id)));
  const gap = Math.min(...placements.map(p => p.rect.halfHeight)) * 0.5;
  function pack(air, outward, corner) {
    const placed = new Map();
    for (const p of order) {
      const anchor = p.anchorRect ?? p.rect, avoid = [...obstacles, ...placed.values()];
      let at = freePlateSlot(p.rect, avoid, field, anchor, p.maxTravel, air, corner ?? anchor, p.exclusion);
      if (!at && outward) {
        // A finite box contains every point reachable by this anchor. For
        // unrestricted standalone callers, all blockers plus one plate do.
        const reach = Number.isFinite(p.maxTravel) ? p.maxTravel : Math.max(
          field.halfWidth, field.halfHeight,
          ...avoid.map(o => Math.max(Math.abs(o.x) + o.halfWidth, Math.abs(o.y) + o.halfHeight)))
          + 2 * (p.rect.halfWidth + p.rect.halfHeight) + air;
        at = freePlateSlot(p.rect, avoid, {
          halfWidth: Math.abs(anchor.x) + reach + p.rect.halfWidth,
          halfHeight: Math.abs(anchor.y) + reach + p.rect.halfHeight,
        }, anchor, p.maxTravel, air, anchor, p.exclusion);
      }
      if (!at) return null;
      placed.set(p.id, at);
    }
    return placed;
  }
  for (const air of [gap, 0]) {
    for (const corner of [null, ...[-1, 1].flatMap(x => [-1, 1].map(y =>
      ({ x: x * field.halfWidth, y: y * field.halfHeight })))]) {
      const packed = pack(air, false, corner);
      if (packed) return packed;
    }
  }
  const hard = obstacles.filter(o => o.subject), soft = obstacles.filter(o => !o.subject);
  // Even degradation must clear the subject. Reject an empty individual
  // domain before considering combinations of the other nine plates.
  if (order.some(p => !freePlateSlot(p.rect, hard, field, p.anchorRect ?? p.rect,
    p.maxTravel, 0, p.anchorRect ?? p.rect, p.exclusion))) {
    const outward = pack(gap, true) ?? pack(0, true);
    if (outward) { outward.degraded = true; outward.overlapArea = 0; }
    return outward;
  }
  const summary = ({ nodes, complete, slots }) => ({ nodes, complete, slots, resolution });
  // Exact union area of clipped obstacles is a cheap impossibility bound.
  const fitsArea = order.reduce((sum, p) => sum + 4 * p.rect.halfWidth * p.rect.halfHeight, 0)
    <= clippedFreeArea(field, obstacles) + EPS;
  let search = null;
  if (fitsArea) {
    search = exactPlateSearch(order, obstacles, field, { resolution, ceiling });
    if (search.placed) { search.placed.search = summary(search); return search.placed; }
  }
  // The readable bands are exhausted. A clear reachable outward placement
  // has the global minimum overlap area (zero); retain the existing tether
  // bound and explicitly report that this seat is degraded/off-glass.
  const outward = pack(gap, true) ?? pack(0, true);
  if (outward) {
    outward.degraded = true; outward.overlapArea = 0;
    if (search) outward.search = summary(search);
    return outward;
  }

  // No clear arrangement: subject obstacles remain hard constraints. Search
  // the same candidate space, clear of the subject only, for the least total
  // overlap with the menu and the other plates.
  const area = (a, b) => Math.max(0, Math.min(a.x + a.halfWidth, b.x + b.halfWidth)
    - Math.max(a.x - a.halfWidth, b.x - b.halfWidth))
    * Math.max(0, Math.min(a.y + a.halfHeight, b.y + b.halfHeight)
    - Math.max(a.y - a.halfHeight, b.y - b.halfHeight));
  const domains = order.map(p => plateFieldSlots(p, hard, field, resolution));
  if (domains.some(domain => !domain.length)) return null;
  let best, cost = Infinity, nodes = 0, complete = true;
  function degrade(index, placed, overlap) {
    if (overlap >= cost - EPS) return;
    if (index === order.length) { best = new Map(placed); cost = overlap; return; }
    if (nodes >= ceiling) { complete = false; return; }
    nodes++;
    // Sum independent lower bounds for every unplaced plate before branching.
    // Each bound may choose a different position; that makes it optimistic,
    // hence safe for pruning, and avoids enumerating equivalent crowded rows.
    let lower = overlap;
    for (let j = index; j < order.length; j++) {
      let least = Infinity;
      for (const at of domains[j]) least = Math.min(least,
        [...soft, ...placed.values()].reduce((sum, other) => sum + area(at, other), 0));
      lower += least;
    }
    if (lower >= cost - EPS) return;
    const ranked = domains[index].map(at => ({ at,
      extra: [...soft, ...placed.values()].reduce((sum, other) => sum + area(at, other), 0) }))
      .sort((a, b) => a.extra - b.extra);
    for (const { at, extra } of ranked) {
      placed.set(order[index].id, at);
      degrade(index + 1, placed, overlap + extra);
      placed.delete(order[index].id);
      if (!complete) return;
    }
  }
  degrade(0, new Map(), 0);
  if (best) {
    best.degraded = true; best.overlapArea = cost;
    best.search = { nodes: nodes + (search?.nodes ?? 0), complete: complete && (search?.complete ?? true),
      slots: domains.reduce((sum, domain) => sum + domain.length, 0), resolution };
  }
  return best ?? null;
}

/**
 * Predicted rectangles reconstructed from solver offsets in one camera basis.
 * This is a solver consistency check, not a rendered measurement. Per-eye
 * evidence comes from committed objects in component-label-measurement.mjs.
 *
 * @param {object} options
 * @param {Array<{id:string, text:string|string[], anchor:ArrayLike<number>}>} options.plates
 * @param {Array<{id:string, offsetX:number, offsetY:number, sizeScale:number, lines?:string[]}>} options.placements
 * @param {number} options.characterUnits scene units per character box, before any size scale
 * @returns {Array<{id:string, rect:{x:number,y:number,halfWidth:number,halfHeight:number}|null}>}
 */
export function drawnPlateRects({ plates = [], placements = [], eye, target, up = [0, 1, 0],
  characterUnits, advancePerEm = PLATE_ADVANCE_PER_EM,
  backgroundMargin = MOLSTAR_BACKGROUND_MARGIN, measureText,
  maxWidthEm = PLATE_MAX_WIDTH_EM, standoff = 0 } = {}) {
  if (!finite(characterUnits) || characterUnits <= 0) throw Error('A drawn plate needs a positive character size.');
  const basis = plateViewBasis({ eye, target, up });
  const from = vec3(eye);
  const placed = new Map(placements.map(entry => [entry?.id, entry]));
  return plates.map(plate => {
    const anchor = vec3(plate?.anchor);
    const place = placed.get(plate?.id);
    if (!anchor || !place) return { id: plate?.id, rect: null };
    const relative = sub(anchor, from);
    const depth = dot(relative, basis.forward);
    // A plate behind the eye is on no one's glass, so it has no rectangle to
    // count. The solver leaves it where it was for the same reason.
    if (!(depth > EPS)) return { id: plate.id, rect: null };
    const drawDepth = plateDrawDepth(relative, depth, standoff);
    if (!(drawDepth > EPS)) return { id: plate.id, rect: null };
    const sizeScale = finite(place.sizeScale) && place.sizeScale > 0 ? place.sizeScale : 1;
    const extents = plateHalfExtents({
      text: place.lines?.length ? place.lines : plate.text,
      characterUnits: characterUnits * sizeScale,
      advancePerEm, backgroundMargin, measureText, maxWidthEm,
    });
    // Mol* adds `offsetX`/`offsetY` to the same corner offset it expands the
    // glyphs with, so a scene-unit offset lands as `offset / drawDepth` on the
    // glass — the inverse of the conversion the solver does on its way out.
    const offsetX = finite(place.offsetX) ? place.offsetX : 0;
    const offsetY = finite(place.offsetY) ? place.offsetY : 0;
    return { id: plate.id, rect: {
      x: dot(relative, basis.right) / depth + offsetX / drawDepth,
      y: dot(relative, basis.up) / depth + offsetY / drawDepth,
      halfWidth: extents.halfWidth / drawDepth,
      halfHeight: extents.halfHeight / drawDepth,
    } };
  });
}

/**
 * The smallest distance along one axis that takes a separation of `delta`
 * out past `reach`, for a plate travelling at `speed` on that axis.
 *
 * Two axis-aligned rectangles are clear of one another as soon as EITHER axis
 * is clear, so this is half of the per-blocker answer and the nearer of the
 * two halves is the whole of it.
 */
function axisEscape(delta, reach, speed) {
  if (speed > EPS) return (reach - delta) / speed;
  if (speed < -EPS) return (reach + delta) / -speed;
  return Number.POSITIVE_INFINITY;
}

/**
 * The smallest distance along `direction` that takes `rect` clear of every
 * blocker, or null when no distance inside `limit` does.
 *
 * Stepping clear of one blocker can step into another, so this is a walk. The
 * distance only ever increases, so it terminates.
 */
function escapeAlong(rect, blockers, direction, limit, gap) {
  const [dx, dy] = direction;
  if (Math.abs(dx) <= EPS && Math.abs(dy) <= EPS) {
    return blockers.some(blocker => overlaps(rect, blocker, gap)) ? null : 0;
  }
  let travel = 0;
  for (let step = 0; step <= blockers.length + 1; step++) {
    const at = { ...rect, x: rect.x + travel * dx, y: rect.y + travel * dy };
    let needed = 0;
    for (const blocker of blockers) {
      if (!overlaps(at, blocker, gap)) continue;
      needed = Math.max(needed, Math.min(
        axisEscape(at.x - blocker.x, at.halfWidth + blocker.halfWidth + gap, dx),
        axisEscape(at.y - blocker.y, at.halfHeight + blocker.halfHeight + gap, dy)));
    }
    if (needed <= 0) return travel;
    if (!Number.isFinite(needed)) return null;
    travel += needed + 1e-6 * Math.max(1, Math.abs(travel));
    if (travel > limit) return null;
  }
  return null;
}

/**
 * The cheapest way out of every blocker, with the plate's own outward spoke
 * preferred.
 *
 * Pure shortest-escape sends every plate off the nearest edge of whatever is
 * in the middle of the view, which piles them into a line instead of spreading
 * them around. The radial direction is taken whenever it is within
 * `PLATE_RADIAL_BIAS` of the shortest, and the shortest otherwise.
 *
 * The margin is deliberately narrow. A plate's own spoke is the right first
 * guess and a poor second one: once the spoke is occupied, holding it costs
 * the arrangement a plate pushed further out for every plate already there.
 */
function chooseEscape(rect, blockers, radial, limit, gap, field) {
  let best = null, radialEscape = null;
  const directions = directionsFor(radial);
  for (let index = 0; index < directions.length; index++) {
    const direction = directions[index];
    const reach = Math.min(limit, fieldTravel(rect, direction, field));
    if (!(reach >= 0)) continue;
    const travel = escapeAlong(rect, blockers, direction, reach, gap);
    if (travel === null) continue;
    if (index === 0) radialEscape = { travel, direction };
    if (!best || travel < best.travel - EPS) best = { travel, direction };
  }
  if (radialEscape && best && radialEscape.travel <= best.travel * PLATE_RADIAL_BIAS + EPS) return radialEscape;
  return best;
}

/**
 * The smallest move that brings `rect` back inside the field, as a vector.
 *
 * The escape search can only decline to leave the field; it cannot pull a
 * plate in that started outside one, and a part near the edge of the view has
 * exactly such a plate. Visibility is the rule nothing yields to, so this runs
 * last, on the placement the search settled on, and its move is added to the
 * offsets the shader is handed. The leader is derived from those offsets
 * afterwards, so it follows the plate rather than pointing where it used to be.
 *
 * A plate wider than the field itself cannot be brought inside; it is centred,
 * and `offGlass` still counts it.
 */
function pullIntoField(rect, field) {
  if (!field) return [0, 0];
  const axis = (position, half, limit) => {
    if (half >= limit) return -position;
    if (position + half > limit) return limit - half - position;
    if (position - half < -limit) return -limit + half - position;
    return 0;
  };
  return [axis(rect.x, rect.halfWidth, field.halfWidth),
    axis(rect.y, rect.halfHeight, field.halfHeight)];
}

/**
 * How far `rect` may travel along `direction` before it leaves the field.
 *
 * A plate that starts outside the field — its part is already off the side of
 * the wearer's view — is not dragged back in here; it simply may not go
 * further out, so the limit is zero on the axes it is already past.
 */
function fieldTravel(rect, [dx, dy], field) {
  if (!field) return Number.POSITIVE_INFINITY;
  const axis = (position, half, limit, speed) => {
    if (Math.abs(speed) <= EPS) return Number.POSITIVE_INFINITY;
    const edge = speed > 0 ? limit - half - position : -limit + half - position;
    return Math.max(0, edge / speed);
  };
  return Math.min(
    axis(rect.x, rect.halfWidth, field.halfWidth, dx),
    axis(rect.y, rect.halfHeight, field.halfHeight, dy));
}

/**
 * The fan directions a plate is allowed to take, in preference order.
 *
 * Radial first, then the two TANGENTS of that spoke, then the axes and the
 * diagonals. The tangents are what turn a queue into a ring: once a plate has
 * cleared the subject, the thing in its way is another plate already resting
 * on the band, and the cheap way past that is to slide along the band rather
 * than to push further out. Without them a device run put
 * six of ten names in a column under the structure, each one further from it
 * than the last, joined to their parts by leaders the height of the view.
 */
function directionsFor(radial) {
  const diagonal = sign => {
    const candidate = [radial[0], radial[1] + sign];
    const length = Math.hypot(candidate[0], candidate[1]);
    return length > EPS ? [candidate[0] / length, candidate[1] / length] : [0, sign];
  };
  const tangent = sign => [-sign * radial[1], sign * radial[0]];
  return [radial, tangent(1), tangent(-1), [0, -1], [0, 1],
    diagonal(-1), diagonal(1), [1, 0], [-1, 0]];
}

/**
 * The resting slots on the band just outside a silhouette, for one plate.
 *
 * The band is the silhouette grown by this plate's own half extents and its
 * gap, so a plate centred on any slot is clear of the structure by
 * construction. Slots run along all four sides; the ones a plate cannot use —
 * off the readable field, under the menu, on a plate already down — are
 * rejected by the caller, which is what leaves the arrangement spread over
 * whichever sides are actually free.
 *
 * @param {object} options
 * @param {{x:number,y:number,halfWidth:number,halfHeight:number}} options.subject
 * @param {number} options.halfWidth the plate's own half width, in tangent units
 * @param {number} options.halfHeight the plate's own half height
 * @param {number} [options.gap] clear air between the plate and the silhouette
 * @param {number} [options.perSide] how many slots each side carries
 * @returns {Array<{x:number, y:number, side:string}>}
 */
export function plateBandSlots({ subject, halfWidth, halfHeight, gap = 0,
  perSide = PLATE_BAND_SLOTS, rings = PLATE_BAND_RINGS } = {}) {
  if (!subject || !finite(subject.x) || !finite(subject.y)
    || !finite(subject.halfWidth) || !finite(subject.halfHeight)) return [];
  if (!finite(halfWidth) || !finite(halfHeight)) return [];
  const steps = Math.max(2, Math.round(perSide));
  const depth = Math.max(1, Math.round(rings));
  const air = finite(gap) ? gap : 0;
  const slots = [];
  for (let ring = 0; ring < depth; ring++) {
    // Each further ring is one whole plate further out, so a plate that finds
    // its own side's inner band full sits behind the plate already there
    // rather than crossing the structure to the other side.
    const reachX = subject.halfWidth + halfWidth + air + ring * (2 * halfWidth + air);
    const reachY = subject.halfHeight + halfHeight + air + ring * (2 * halfHeight + air);
    for (let index = 0; index < steps; index++) {
      const t = (index / (steps - 1)) * 2 - 1;
      // The corners are shared by two sides, so each side spans the silhouette
      // plus its own half extent and the sides meet rather than leave a hole.
      const x = subject.x + t * reachX;
      const y = subject.y + t * reachY;
      slots.push({ x, y: subject.y + reachY, side: 'above', ring });
      slots.push({ x, y: subject.y - reachY, side: 'below', ring });
      slots.push({ x: subject.x + reachX, y, side: 'right', ring });
      slots.push({ x: subject.x - reachX, y, side: 'left', ring });
    }
  }
  return slots;
}

/** Whether a rectangle sits wholly inside the readable field. */
function insideField(rect, field) {
  if (!field) return true;
  return Math.abs(rect.x) + rect.halfWidth <= field.halfWidth + EPS
    && Math.abs(rect.y) + rect.halfHeight <= field.halfHeight + EPS;
}

/**
 * Which side of the silhouette each laid-out plate came to rest on.
 *
 * A plate is credited to the side it is furthest past: above, below, left or
 * right of the silhouette's own box. A plate still drawn over the structure is
 * credited to no side at all, which is what keeps this an honest measure of
 * how far the arrangement is spread rather than a restatement of where the
 * solver aimed.
 *
 * @returns {{above:number, below:number, left:number, right:number, over:number}}
 */
export function plateSideSpread(placements = [], subject = null) {
  const tally = { above: 0, below: 0, left: 0, right: 0, over: 0 };
  if (!subject) return tally;
  for (const entry of placements) {
    const rect = entry?.rect;
    if (!rect) continue;
    const past = {
      above: rect.y - rect.halfHeight - (subject.y + subject.halfHeight),
      below: (subject.y - subject.halfHeight) - (rect.y + rect.halfHeight),
      right: rect.x - rect.halfWidth - (subject.x + subject.halfWidth),
      left: (subject.x - subject.halfWidth) - (rect.x + rect.halfWidth),
    };
    let side = null;
    for (const name of ['above', 'below', 'right', 'left']) {
      if (past[name] > EPS && (!side || past[name] > past[side])) side = name;
    }
    if (side) tally[side] += 1; else tally.over += 1;
  }
  return tally;
}

/**
 * The mean distance a plate travelled from its own part, in character ems.
 *
 * That distance IS the leader the wearer follows, so it is the number that
 * says whether a plate is resting beside the thing it names or across the
 * view from it. Stated in ems rather than tangent units so a bound reads the
 * same at every seat and every size.
 */
export function meanPlateLeaderEm(placements = [], characterUnits) {
  if (!finite(characterUnits) || characterUnits <= 0) throw Error('A leader mean needs a positive character size.');
  const moved = placements.filter(entry => finite(entry?.displacement));
  if (!moved.length) return 0;
  return moved.reduce((sum, entry) => sum + entry.displacement, 0) / moved.length / characterUnits;
}

/**
 * Arrange a set of name plates so none of them is buried.
 *
 * Every length in and out of this is in SCENE units — the units of the plate
 * anchors, of `characterUnits`, and of Mol*'s own `offsetX`/`offsetY` params —
 * so nothing here needs to know the scene-to-room scale or the seat distance.
 * Screen-space arithmetic happens in tangent units (a length divided by its
 * depth from the eye), which is what makes two plates at different depths
 * comparable at all; the offsets are converted back at the end by multiplying
 * by each plate's own depth, because that is how the shader reads them.
 *
 * Every count in the result is read off the rectangles the renderer will draw
 * — `drawnPlateRects` rebuilds them from the offsets this is about to emit —
 * rather than off the scratch rectangles the placement loop works in. The two
 * agree today, because `plateHalfExtents` is now Mol*'s own plate geometry and
 * nothing else; the point is that a future divergence would be a number here
 * instead of a wearer's complaint.
 *
 * @param {object} options
 * @param {Array<{id:string, text:string, anchor:ArrayLike<number>, radius?:number,
 *   focused?:boolean}>} options.plates one entry per part, in draw order
 * @param {ArrayLike<number>} options.eye the wearer's eye, in scene units
 * @param {ArrayLike<number>} options.target what the wearer is looking at
 * @param {ArrayLike<number>} [options.up] the wearer's up
 * @param {number} options.characterUnits scene units per character box
 * @param {number} [options.minSizeScale] how far a yielding plate may shrink
 * @param {number} [options.contextAlpha] the opacity a dimmed plate falls to
 * @param {number} [options.standoff] the plates' `offsetZ`, in scene units: the
 *   push toward the eye Mol* draws every plate with, see `plateDrawDepth`
 * @param {Array<{x:number,y:number,halfWidth:number,halfHeight:number}>} [options.obstacles]
 *   screen rectangles, in the same tangent units, that no plate may be drawn
 *   over. The spatial toolbar's menu column is the only one today; pass it and
 *   `menuOverlaps` answers the question, leave it out and nothing does.
 * @returns {{placements: Array<object>, overlaps:number, menuOverlaps:number,
 *   fanned:number, shrunk:number, dimmed:number, yielded:number,
 *   unresolved:number, beyondRadius:number}}
 */
export function layoutComponentPlates({ plates = [], eye, target, up = [0, 1, 0],
  characterUnits, minSizeScale = 0.75, contextAlpha = 0.45,
  boundHeights = PLATE_BOUND_HEIGHTS, boundRadii = PLATE_BOUND_RADII,
  measureText, maxWidthEm = PLATE_MAX_WIDTH_EM, obstacles = [], subject = null,
  field = null, standoff = 0, clearance = 0 } = {}) {
  if (!finite(characterUnits) || characterUnits <= 0) throw Error('A plate layout needs a positive character size.');
  if (!finite(clearance) || clearance < 0) throw Error('Plate clearance must be finite and nonnegative.');
  const basis = plateViewBasis({ eye, target, up });
  const from = vec3(eye);

  const entries = [];
  for (const plate of plates) {
    const anchor = vec3(plate?.anchor);
    if (!anchor) continue;
    const relative = sub(anchor, from);
    const depth = dot(relative, basis.forward);
    // A plate behind the eye has no screen rectangle to arrange. It is drawn
    // where it always was rather than dropped: the wearer only has to turn.
    const drawDepth = plateDrawDepth(relative, depth, standoff);
    if (!(depth > EPS) || !(drawDepth > EPS)) {
      entries.push({ plate, depth: null });
      continue;
    }
    const extents = plateHalfExtents({ text: plate.text, characterUnits, measureText, maxWidthEm });
    const radius = finite(plate?.radius) && plate.radius > 0 ? plate.radius : 0;
    entries.push({
      plate,
      depth,
      drawDepth,
      x: dot(relative, basis.right) / depth,
      y: dot(relative, basis.up) / depth,
      halfWidth: extents.halfWidth / drawDepth,
      halfHeight: extents.halfHeight / drawDepth,
      radius: radius / depth,
      exclusion: standoff > 0 ? (() => {
        const push = standoff / Math.hypot(...relative);
        const x = dot(relative, basis.right) * push / drawDepth;
        const y = dot(relative, basis.up) * push / drawDepth;
        return { x: dot(relative, basis.right) / depth + x,
          y: dot(relative, basis.up) / depth + y, radius: Math.hypot(x, y) };
      })() : null,
      gap: (PLATE_GAP_EM * characterUnits) / drawDepth + 2 * clearance,
      lines: extents.lines,
    });
  }

  const live = entries.filter(entry => entry.depth !== null);
  const centre = live.length
    ? live.reduce((sum, entry) => [sum[0] + entry.x / live.length, sum[1] + entry.y / live.length], [0, 0])
    : [0, 0];

  // The focused plate first, then the outermost of the rest: a plate that is
  // already clear of the pile keeps the position the wearer can already read,
  // and the crowded middle is what moves.
  const order = [...live].sort((a, b) => {
    const focus = Number(Boolean(b.plate.focused)) - Number(Boolean(a.plate.focused));
    if (focus) return focus;
    const distance = Math.hypot(b.x - centre[0], b.y - centre[1]) - Math.hypot(a.x - centre[0], a.y - centre[1]);
    return distance || String(a.plate.id).localeCompare(String(b.plate.id));
  });

  const placed = [];
  const obstacleRects = obstacles.filter(obstacle => obstacle && finite(obstacle.x) && finite(obstacle.y)
    && finite(obstacle.halfWidth) && obstacle.halfWidth > 0 && finite(obstacle.halfHeight) && obstacle.halfHeight > 0)
    .map(obstacle => ({ x: Number(obstacle.x), y: Number(obstacle.y),
      halfWidth: Number(obstacle.halfWidth), halfHeight: Number(obstacle.halfHeight) }));
  /**
   * The subject's own silhouette, which no plate may be drawn over.
   *
   * The bound every plate used to be held inside was its own PART's projected
   * radius plus a few plate heights, so a plate could never leave the structure
   * it was naming: ten plates were fanned into rows across the middle of the
   * cluster and the wearer read ten names over the thing they were describing.
   * The subject is a blocker like the toolbar now, and the bound below is
   * widened by whatever it takes to get past it, so the plates come to rest
   * around the structure instead of on it. A plate that has left its part needs
   * a leader, which is what `plateLeader` puts on every placement that moved.
   */
  const subjectRect = (() => {
    if (!subject) return null;
    let drawn;
    if (finite(subject.halfWidth) && finite(subject.halfHeight) && finite(subject.x) && finite(subject.y)) {
      drawn = { x: Number(subject.x), y: Number(subject.y),
        halfWidth: Number(subject.halfWidth), halfHeight: Number(subject.halfHeight) };
    }
    // The parts the lesson names ARE the structure, and the box around their
    // projected discs is what the wearer sees. A square around the bounding
    // SPHERE is not: it is round where the complex is flat and square where
    // the complex is round, and on the telomerase seat it claimed
    // the whole upper field, which pushed ten plates out to the edge of the
    // display with leaders running the length of the view. The sphere is the
    // fallback for a subject with too few parts to bound.
    drawn ??= partsSilhouette(live);
    // The part discs divide each radius by its centre depth. That misses
    // perspective extrema (#528's lower fringe), even with all ten parts.
    // Keep the whole assembly's transformed extrema, including faded parts.
    const measured = screenRectFromPoints({ points: subject.points ?? [], eye, target, up });
    if (measured && drawn) {
      const left = Math.min(drawn.x - drawn.halfWidth, measured.x - measured.halfWidth);
      const right = Math.max(drawn.x + drawn.halfWidth, measured.x + measured.halfWidth);
      const bottom = Math.min(drawn.y - drawn.halfHeight, measured.y - measured.halfHeight);
      const top = Math.max(drawn.y + drawn.halfHeight, measured.y + measured.halfHeight);
      return { x: (left + right) / 2, y: (bottom + top) / 2,
        halfWidth: (right - left) / 2, halfHeight: (top - bottom) / 2 };
    }
    if (measured) return measured;
    if (drawn) return drawn;
    try { return projectedSphereRect({ ...subject, eye, target, up }); } catch { return null; }
  })();
  const blockers = subjectRect ? [...obstacleRects, subjectRect] : obstacleRects;
  const fieldRect = field && finite(field.halfWidth) && field.halfWidth > 0
    && finite(field.halfHeight) && field.halfHeight > 0
    ? { halfWidth: Number(field.halfWidth), halfHeight: Number(field.halfHeight) } : null;
  const focusRects = [];
  const results = new Map();
  const floorScale = Math.min(1, Math.max(0.1, finite(minSizeScale) ? minSizeScale : 0.75));

  /**
   * The slot on the band around the silhouette that costs this plate the least
   * leader, among those that are free.
   *
   * Free means: inside the readable field, clear of every blocker and of every
   * plate already down, both by the plate's own gap. The cost is the leader
   * length the slot would need, discounted slightly on the plate's own outward
   * spoke so a near-tie is settled on its own side of the structure rather than
   * by a leader drawn across it.
   *
   * @returns {{travel:number, direction:number[]}|null} in the same shape a
   *   straight escape returns, so the caller treats the two alike.
   */
  function nearestFreeSlot(entry, rect, radial, avoid) {
    if (!subjectRect) return null;
    let best = null;
    for (const slot of plateBandSlots({ subject: subjectRect,
      halfWidth: rect.halfWidth, halfHeight: rect.halfHeight, gap: entry.gap })) {
      const at = { ...rect, x: slot.x, y: slot.y };
      if (!insideField(at, fieldRect)) continue;
      if (avoid.some(blocker => overlaps(at, blocker, entry.gap))) continue;
      const dx = slot.x - entry.x, dy = slot.y - entry.y;
      const travel = Math.hypot(dx, dy);
      if (!(travel > EPS)) return { travel: 0, direction: [0, 0] };
      const along = (dx * radial[0] + dy * radial[1]) / travel;
      const cost = travel * (1 - PLATE_SLOT_RADIAL_PREFERENCE * Math.max(0, along));
      if (!best || cost < best.cost - EPS) best = { cost, travel, direction: [dx / travel, dy / travel] };
    }
    return best ? { travel: best.travel, direction: best.direction } : null;
  }

  // A part can start above the field after a focus or resize. Rays from that
  // anchor and three rings around its silhouette do not exhaust the free
  // glass below it. Before yielding, search rectangle edges inside the field.
  // Every free axis-aligned cell has a corner on these boundaries, so this
  // finds available space without a pixel grid or an unbounded search.
  function freeFieldSlot(entry, rect, radial, avoid) {
    if (!fieldRect) return null;
    const lowX = -fieldRect.halfWidth + rect.halfWidth, highX = -lowX;
    const lowY = -fieldRect.halfHeight + rect.halfHeight, highY = -lowY;
    if (lowX > highX || lowY > highY) return null;
    const xs = [lowX, highX, Math.max(lowX, Math.min(highX, entry.x))];
    const ys = [lowY, highY, Math.max(lowY, Math.min(highY, entry.y))];
    const air = entry.gap + 1e-6;
    for (const other of avoid) {
      xs.push(other.x - other.halfWidth - rect.halfWidth - air,
        other.x + other.halfWidth + rect.halfWidth + air);
      ys.push(other.y - other.halfHeight - rect.halfHeight - air,
        other.y + other.halfHeight + rect.halfHeight + air);
    }
    let best;
    for (const x of xs.filter(x => x >= lowX && x <= highX)) {
      for (const y of ys.filter(y => y >= lowY && y <= highY)) {
        const at = { ...rect, x, y };
        if (avoid.some(other => overlaps(at, other, entry.gap))) continue;
        const dx = x - entry.x, dy = y - entry.y, travel = Math.hypot(dx, dy);
        const along = travel > EPS ? (dx * radial[0] + dy * radial[1]) / travel : 0;
        const cost = travel * (1 - PLATE_SLOT_RADIAL_PREFERENCE * Math.max(0, along));
        if (!best || cost < best.cost - EPS) best = { cost, travel,
          direction: travel > EPS ? [dx / travel, dy / travel] : [0, 0] };
      }
    }
    return best ?? null;
  }

  order.forEach((entry, index) => {
    const radial = (() => {
      const away = [entry.x - centre[0], entry.y - centre[1]];
      const length = Math.hypot(away[0], away[1]);
      if (length > EPS) return [away[0] / length, away[1] / length];
      // Dead centre has no outward direction of its own, so give it a stable
      // one: the same plate gets the same spoke on every rebuild.
      const angle = (index * 2 * Math.PI) / Math.max(1, order.length);
      return [Math.cos(angle), Math.sin(angle)];
    })();
    // Whatever it takes to leave the silhouette, so the subject is never the
    // thing a plate is held inside by.
    const subjectReach = subjectRect
      ? Math.hypot(entry.x - subjectRect.x, entry.y - subjectRect.y)
        + Math.hypot(subjectRect.halfWidth, subjectRect.halfHeight)
        + 2 * Math.hypot(entry.halfWidth, entry.halfHeight) + entry.gap
      : 0;
    const bound = Math.max(boundRadii * entry.radius + boundHeights * 2 * entry.halfHeight, subjectReach);
    entry.maxTravel = bound * PLATE_FOCUS_ESCAPE;
    const ladder = entry.plate.focused ? [1] : [...PLATE_SIZE_LADDER, floorScale]
      .filter((scale, at, all) => scale <= 1 && scale >= floorScale && all.indexOf(scale) === at);

    let chosen = null;
    if (entry.plate.focused) {
      // Never yields to a secondary plate, but it still clears the toolbar, the
      // subject, and the other focused plates: the toolbar is not part of the
      // lesson and must not cover it, the structure is what it is naming, and
      // two parts emphasised together are two things the wearer is being asked
      // to look at. That last blocker was missing, so an `emphasize` naming two
      // parts whose centroids project to the same point left both plates at
      // travel zero, drawn over one another, and the record said so in
      // `focusOverlaps` without anything acting on it.
      const rect = { x: entry.x, y: entry.y, halfWidth: entry.halfWidth, halfHeight: entry.halfHeight };
      const reach = bound * PLATE_FOCUS_ESCAPE;
      // The subject is what yields when clearing it would take the plate off
      // the glass: a name the wearer can read over the structure beats a name
      // they cannot see at all. The toolbar and the other focused plates do
      // not yield, because neither is the thing being explained.
      const best = chooseEscape(rect, [...blockers, ...focusRects], radial, reach, entry.gap, fieldRect)
        ?? freeFieldSlot(entry, rect, radial, [...blockers, ...focusRects])
        ?? chooseEscape(rect, [...obstacleRects, ...focusRects], radial, reach, entry.gap, fieldRect);
      chosen = best ? { ...best, sizeScale: 1, alpha: 1 }
        : { travel: 0, direction: [0, 0], sizeScale: 1, alpha: 1 };
    } else {
      for (const sizeScale of ladder) {
        const rect = {
          x: entry.x, y: entry.y,
          halfWidth: entry.halfWidth * sizeScale, halfHeight: entry.halfHeight * sizeScale,
        };
        // The nearest FREE spot on the band around the
        // silhouette, before any straight-line escape is considered.
        //
        // A shortest escape is one direction from the part, and on a silhouette
        // wider than it is tall that direction is down for every part in the
        // middle of it. A plate that then finds the bottom occupied is pushed
        // further down, which is how the fifth device run ended with seven
        // names heaped under the structure on leaders the height of the view
        // while the band above and to the right of it was empty. Choosing among
        // slots on all four sides instead spreads the arrangement around the
        // subject, and choosing the nearest free one keeps each leader short:
        // a plate only leaves its own side once that side is full.
        const slot = nearestFreeSlot(entry, rect, radial, [...blockers, ...placed]);
        const best = chooseEscape(rect, [...blockers, ...placed], radial, bound, entry.gap, fieldRect);
        // Whichever costs this plate the shorter leader. A band slot is the
        // better answer when there is a band — it spreads the arrangement and
        // it is inside the field by construction — but on a seat where the
        // silhouette fills most of the readable field there is barely a band
        // to sit on, and insisting on one sends a plate the long way round a
        // structure it could have stepped off in a tenth of the distance.
        const take = (slot && (!best || slot.travel <= best.travel + EPS) ? slot : best)
          ?? freeFieldSlot(entry, rect, radial, [...blockers, ...placed]);
        if (take) { chosen = { ...take, sizeScale, alpha: 1 }; break; }
      }
    }
    if (!chosen) {
      // Nothing inside the bound clears every plate already down. The bound is
      // lifted rather than abandoned: a plate that has to leave its part is
      // still readable, and a plate dropped back on the pile is not. This used
      // to escape only the toolbar and the focused plate, which on a resting
      // lesson — no focus, and no menu rectangle reaching the solver — meant
      // escaping nothing at all, so the plate came to rest at its own centroid
      // on top of whatever was already there.
      const rect = {
        x: entry.x, y: entry.y,
        halfWidth: entry.halfWidth * floorScale, halfHeight: entry.halfHeight * floorScale,
      };
      const reach = bound * PLATE_FOCUS_ESCAPE;
      // What gets given up, in the order it is worth giving up. The field is
      // never in this list: a plate off the glass is not a placement.
      let best = nearestFreeSlot(entry, rect, radial, [...blockers, ...placed])
        ?? chooseEscape(rect, [...blockers, ...placed], radial, reach, entry.gap, fieldRect)
        // Landing on another secondary plate, which `unresolved` reports.
        ?? chooseEscape(rect, [...blockers, ...focusRects], radial, reach, entry.gap, fieldRect)
        // Landing on the structure, which `subjectOverlaps` reports. A field
        // too narrow to hold both the subject and a band of plates is the
        // seat's problem to fix, and this is how it says so.
        ?? chooseEscape(rect, [...obstacleRects, ...focusRects], radial, reach, entry.gap, fieldRect);
      chosen = { travel: best?.travel ?? 0, direction: best?.direction ?? radial,
        sizeScale: floorScale, alpha: contextAlpha, yielded: true };
    }

    const rect = {
      x: entry.x + chosen.travel * chosen.direction[0],
      y: entry.y + chosen.travel * chosen.direction[1],
      halfWidth: entry.halfWidth * chosen.sizeScale,
      halfHeight: entry.halfHeight * chosen.sizeScale,
    };
    // Last, and over everything else: on the glass.
    const [pullX, pullY] = pullIntoField(rect, fieldRect);
    if (pullX || pullY) {
      rect.x += pullX;
      rect.y += pullY;
      // The pull used to be the end of it, and it answers
      // to no blocker — a plate dragged back inside the field lands wherever
      // the field puts it, including on a plate already down. That is a
      // collision the search had already avoided and nothing afterwards looks
      // at, so it reached the glass as two plates drawn across one another,
      // and on a later device run as one drawn back over the
      // structure, while every count said the arrangement was clear. A free
      // slot on the band clears every blocker and is inside the field by
      // construction, so it is the right rescue for both.
      if ([...blockers, ...placed].some(other => overlaps(rect, other, entry.gap))) {
        const rescue = nearestFreeSlot(entry,
          { ...rect, x: entry.x, y: entry.y }, radial, [...blockers, ...placed])
          ?? freeFieldSlot(entry, rect, radial, [...blockers, ...placed]);
        if (rescue) {
          rect.x = entry.x + rescue.travel * rescue.direction[0];
          rect.y = entry.y + rescue.travel * rescue.direction[1];
        }
      }
    }
    placed.push(rect);
    if (entry.plate.focused) focusRects.push(rect);
    // Tangent units times the depth the plate is DRAWN at is the shader's
    // unit: the corner offset is divided by the pushed depth, not the anchor's.
    // Negative zero is a fine number and a failed deep-equal, so it is
    // normalised away.
    const zeroed = value => (value === 0 ? 0 : value);
    const offsetX = zeroed((rect.x - entry.x) * entry.drawDepth);
    const offsetY = zeroed((rect.y - entry.y) * entry.drawDepth);
    // Measured on where the plate ended up, not on where the search sent it,
    // because the field correction above may have moved it again.
    const travel = Math.hypot(rect.x - entry.x, rect.y - entry.y);
    results.set(entry.plate.id, {
      id: entry.plate.id,
      offsetX,
      offsetY,
      sizeScale: chosen.sizeScale,
      alpha: chosen.alpha,
      focused: Boolean(entry.plate.focused),
      lines: entry.lines,
      moved: travel > EPS,
      /** How far the plate travelled, in scene units at its drawn depth. */
      displacement: travel * entry.drawDepth,
      /** That travel as a share of the part's own radius. */
      radiusShare: entry.radius > EPS ? travel / entry.radius : Number.POSITIVE_INFINITY,
      /**
       * Whether the plate has come off the part it names. A plate that still
       * overlaps its part's projected disc needs no leader line to say what it
       * belongs to; one that does not, would.
       */
      detached: travel > entry.radius + entry.halfHeight * chosen.sizeScale + EPS,
      /**
       * Whether this plate ran out of room and took the last-resort placement.
       * It is recorded on its own because the two signals that used to stand
       * for it are both silent on a resting lesson: `shrunk` is zero whenever
       * the chapter's gain leaves `minSizeScale` at one, and `dimmed` is zero
       * whenever nothing is faded and `contextAlpha` is one.
       */
      yielded: Boolean(chosen.yielded),
      /**
       * The wedge that ties this plate back to the part it names, or null when
       * the plate never left it. Drawn at the plate's own drawn size, which is
       * why the size scale is folded in here rather than at the painter.
       */
      leader: plateLeader({ offsetX, offsetY, characterUnits: characterUnits * chosen.sizeScale }),
      depth: entry.depth,
      /** The depth the plate is drawn at: the anchor's, less the stand-off push. */
      drawDepth: entry.drawDepth,
    });
  });

  const placements = plates
    .map(plate => results.get(plate?.id) ?? {
      id: plate?.id, offsetX: 0, offsetY: 0, sizeScale: 1, alpha: 1,
      focused: Boolean(plate?.focused), moved: false, displacement: 0,
      radiusShare: 0, detached: false, yielded: false, leader: null, rect: null, depth: null,
    });

  // The rectangles the renderer will draw, rebuilt from the offsets above
  // rather than read back out of the solver's scratch. `rect` on each
  // placement IS this rectangle, so every count below — and every test — is
  // reading the glass instead of the algorithm.
  const drawn = drawnPlateRects({ plates, placements, eye, target, up,
    characterUnits, advancePerEm: PLATE_ADVANCE_PER_EM, measureText, maxWidthEm, standoff });
  for (let index = 0; index < placements.length; index++) placements[index].rect = drawn[index]?.rect ?? null;

  // Validate the emitted rectangles, including dimmed context plates. Repack
  // the whole field when greedy choices used up one band; no extra layout or
  // renderer commit is scheduled, and the pushed-depth stand-off is retained.
  let degraded = false, overlapArea = 0, search = null;
  const beyondReach = live.some(entry => results.get(entry.plate.id).displacement
    > entry.maxTravel * entry.drawDepth + EPS);
  const insideStandoff = live.some(entry => {
    const rect = results.get(entry.plate.id).rect, disk = entry.exclusion;
    return disk && Math.hypot(rect.x - disk.x, rect.y - disk.y) < disk.radius - EPS;
  });
  if (countPlateOverlaps(placements) || countObstacleOverlaps(placements, blockers) || beyondReach || insideStandoff) {
    // A perfect tiling has no area for extra air. Keep its exact search, and
    // measure unavoidable menu overlap using the actual quad dimensions.
    const packingClearance = fieldRect && clippedFreeArea(fieldRect, blockers)
      <= placements.reduce((area, p) => area + (p.rect ? 4 * p.rect.halfWidth * p.rect.halfHeight : 0), 0) + EPS
      ? 0 : clearance;
    const packed = packPlateField(placements.filter(p => p.rect).map(p => {
      const entry = live.find(e => e.plate.id === p.id);
      return { ...p, rect: { ...p.rect, halfWidth: p.rect.halfWidth + packingClearance,
        halfHeight: p.rect.halfHeight + packingClearance },
        anchorRect: { x: entry.x, y: entry.y }, maxTravel: entry.maxTravel, exclusion: entry.exclusion };
    }), [...obstacleRects, ...(subjectRect ? [{ ...subjectRect, subject: true }] : [])], fieldRect, { prioritizeFocus: clearance > 0 });
    if (!packed && fieldRect) throw new RangeError('No clear plate placement within the maximum tether reach.');
    degraded = packed?.degraded === true;
    overlapArea = packed?.overlapArea ?? 0;
    search = packed?.search ?? null;
    if (packed) for (const entry of live) {
      const place = results.get(entry.plate.id), rect = packed.get(entry.plate.id);
      const travel = Math.hypot(rect.x - entry.x, rect.y - entry.y);
      place.offsetX = (rect.x - entry.x) * entry.drawDepth;
      place.offsetY = (rect.y - entry.y) * entry.drawDepth;
      place.moved = travel > EPS;
      place.displacement = travel * entry.drawDepth;
      place.radiusShare = entry.radius > EPS ? travel / entry.radius : Infinity;
      place.detached = travel > entry.radius + entry.halfHeight * place.sizeScale + EPS;
      place.alpha = 1;
      place.yielded = false;
      place.leader = plateLeader({ ...place, characterUnits: characterUnits * place.sizeScale });
    }
    if (packed) {
      const repaired = drawnPlateRects({ plates, placements, eye, target, up,
        characterUnits, measureText, maxWidthEm, standoff });
      for (let i = 0; i < placements.length; i++) placements[i].rect = repaired[i].rect;
    }
  }

  if (clearance > 0 && placements.some(p => !p.rect)) degraded = true;
  const overlapPairs = countPlateOverlaps(placements);
  return {
    placements,
    overlaps: overlapPairs,
    fanned: placements.filter(entry => entry.moved).length,
    shrunk: placements.filter(entry => entry.sizeScale < 1 - EPS).length,
    dimmed: placements.filter(entry => entry.alpha < 1 - EPS).length,
    /** Pairs still overlapping. `focusOverlaps` must always be zero. */
    unresolved: overlapPairs + countObstacleOverlaps(placements, obstacleRects),
    degraded, overlapArea,
    /** Plates that ran out of room, whether or not shrinking or dimming showed it. */
    yielded: placements.filter(entry => entry.yielded).length,
    /** Plates drawn over a rectangle the solver was told to keep clear. */
    menuOverlaps: countObstacleOverlaps(placements, obstacleRects),
    /**
     * Plates still drawn over the structure itself, and the silhouette they
     * were measured against. `subject: null` says no silhouette reached the
     * solver, which is a different state from none of them covering it.
     */
    subjectOverlaps: subjectRect ? countSubjectOverlaps(placements, subjectRect) : null,
    subject: subjectRect,
    /**
     * Plates whose drawn rectangle leaves the band the wearer can read, and
     * the band they were measured against. Zero when the readable bands fit;
     * a full field's deterministic outward stack is reported here.
     */
    offGlass: fieldRect ? placements.filter(entry => (clearance > 0 && !entry.rect) || (entry.rect
      && (Math.abs(entry.rect.x) + entry.rect.halfWidth > fieldRect.halfWidth + EPS
        || Math.abs(entry.rect.y) + entry.rect.halfHeight > fieldRect.halfHeight + EPS))).length : null,
    /** Plates carrying a leader back to the part they name. */
    led: placements.filter(entry => entry.leader).length,
    focusOverlaps: placements.filter(entry => entry.focused)
      .reduce((count, focused) => count + placements
        .filter(other => other !== focused && platesOverlap(focused, other)).length, 0),
    /** Plates that came off their part. A leader line is only ever wanted here. */
    detached: placements.filter(entry => entry.detached).length,
    /** How the arrangement is spread around the silhouette, per side. */
    sides: subjectRect ? plateSideSpread(placements, subjectRect) : null,
    /** The mean leader a wearer has to follow, in character ems. */
    leaderEm: meanPlateLeaderEm(placements, characterUnits),
    beyondRadius: placements.filter(entry => entry.radiusShare > 1 + EPS && entry.moved).length,
    /**
     * The exact repack, when the greedy bands failed: nodes visited, slots
     * enumerated, the grid step, and whether the search completed. Null when
     * the greedy bands placed every plate.
     */
    search,
    /**
     * What the solver actually arranged: each plate's projected anchor
     * (tangent x, y at its depth), its part radius and line count, plus the
     * scalar inputs and blockers, so a ring record can replay this exact
     * call with an on-axis basis. Plates behind the eye have null tangents.
     */
    inputs: {
      characterUnits, minSizeScale: floorScale, contextAlpha, standoff, clearance,
      field: fieldRect, obstacles: obstacleRects, subject: subjectRect,
      anchors: entries.map(entry => ({ id: entry.plate.id,
        x: entry.depth === null ? null : entry.x, y: entry.depth === null ? null : entry.y,
        depth: entry.depth,
        radius: finite(entry.plate?.radius) && entry.plate.radius > 0 ? entry.plate.radius : 0,
        halfWidth: entry.depth === null ? null : entry.halfWidth,
        halfHeight: entry.depth === null ? null : entry.halfHeight,
        lines: entry.lines?.length ?? 1, focused: entry.plate.focused === true })),
    },
  };
}

/** Canonical solver inputs for exact reuse on a requested relayout.
 * This never runs on an XR frame. Projected positions stay in tangents;
 * scalar dimensions retain their original precision.
 */
export function plateLayoutKey({ plates, eye, target, up, characterUnits, minSizeScale,
  contextAlpha, standoff, subject, obstacles, clearance, field, measureText }) {
  const basis = plateViewBasis({ eye, target, up });
  const projected = plates.map(p => {
    const relative = sub(p.anchor, eye), depth = dot(relative, basis.forward);
    const size = plateHalfExtents({ text: p.text, characterUnits, measureText });
    return [p.id, p.text, Boolean(p.focused), depth > EPS ? dot(relative, basis.right) / depth : null,
      depth > EPS ? dot(relative, basis.up) / depth : null, depth, p.radius,
      size.halfWidth, size.halfHeight];
  });
  const bounds = subject && (Number.isFinite(subject.halfWidth) ? subject
    : screenRectFromPoints({ points: subject.points ?? [], eye, target, up })
      ?? projectedSphereRect({ ...subject, eye, target, up }));
  const rect = r => r ? [r.x, r.y, r.halfWidth, r.halfHeight] : null;
  return [projected, characterUnits, minSizeScale, contextAlpha, standoff,
    rect(bounds), obstacles.map(rect), clearance, field?.halfWidth, field?.halfHeight];
}

export function samePlateLayoutInputs(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length
    && a.every((value, i) => samePlateLayoutInputs(value, b[i]));
  return a === b;
}

/** A smaller toolbar footprint cannot invalidate the layout it occupied.
 * Keep the last solved envelope, so repeated redraws cannot accumulate drift.
 */
export function reusablePlateLayout(next, previous) {
  if (!samePlateLayoutInputs(next.filter((_, i) => i !== 6), previous.filter((_, i) => i !== 6))) return false;
  return next[6].every(([x, y, hw, hh]) => previous[6].some(([px, py, pw, ph]) =>
    x - hw >= px - pw - .001 && x + hw <= px + pw + .001
    && y - hh >= py - ph - .001 && y + hh <= py + ph + .001));
}
