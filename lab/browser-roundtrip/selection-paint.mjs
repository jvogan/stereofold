/**
 * Making a selection something the wearer can SEE.
 *
 * On a Quest 2, "select residues 10 to 20" rendered, the plate read `11 selected`, and the 1CRN
 * cartoon was one uniform orange with no mark anywhere on residues 10 to 20.
 * `focus_selection` reframed the view and changed nothing about that. The
 * host-side selection was real — eleven canonical keys — and the wearer had no
 * way to tell which eleven.
 *
 * The page was marking the selection the way the flat Mol* viewer does, through
 * `canvas.mark(..., MarkerAction.Select)`. That is a per-vertex marker the
 * renderer resolves in its own pass, and the immersive path does not show it.
 * An OVERPAINT layer is geometry-independent: it is the same state-tree
 * transform the lesson emphasis already paints with, it survives into the XR
 * frame because it changes the representation's colours rather than a marker
 * buffer, and it is rebuilt from the saved keys by anything that rebuilds the
 * representation.
 *
 * Nothing here imports Mol*. The plugin, the transforms and the loci helpers
 * are handed in, so this module runs under Node in a test with a real structure
 * and a recording builder.
 */

/** The state-tree ref the selection overpaint hangs off its representation with. */
export const SELECTION_LAYER_REF = 'stereofold-selection';

/**
 * Colours a selection can be painted in, brightest and most unusual first.
 *
 * A selection has to be legible against a black background and a white one,
 * against a chain-id rainbow and a one-colour cartoon, and it must not be
 * mistaken for the lesson's own emphasis key. No single colour does all of
 * that, so the mark is CHOSEN: the first candidate that is far enough from both
 * the background and the highlight colour currently in use wins, and the list
 * ends with a colour that is far from almost everything.
 */
export const SELECTION_MARK_COLORS = Object.freeze([
  '#ff2dd4', // magenta: rare in protein colour themes, reads on black and white
  '#39ff14', // green
  '#00e5ff', // cyan
  '#ffd400', // amber
  '#ffffff', // white, the last resort against a dark, saturated scene
]);

/** How far apart two colours must be before a wearer can tell them apart, 0-255 per channel. */
export const SELECTION_MARK_MIN_DISTANCE = 96;
/** How far the mark must be from the background before it stops disappearing into it. */
export const SELECTION_MARK_MIN_BACKGROUND_DISTANCE = 120;

function channels(value) {
  const text = String(value ?? '').trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(text)) return undefined;
  const number = Number.parseInt(text, 16);
  return [(number >> 16) & 255, (number >> 8) & 255, number & 255];
}

/**
 * Perceptual-ish distance between two colours.
 *
 * The weights are the usual luminance weights, so a difference the eye barely
 * registers in blue does not read here as a difference it registers in green.
 */
export function colorDistance(a, b) {
  const first = channels(a), second = channels(b);
  if (!first || !second) return Number.POSITIVE_INFINITY;
  const weights = [0.5, 1, 0.34];
  return Math.sqrt(weights.reduce((sum, weight, index) => sum + weight * (first[index] - second[index]) ** 2, 0));
}

/**
 * The colour this selection is marked in, given the palette it has to read against.
 *
 * Deterministic: the same appearance always gets the same mark, so a wearer
 * does not watch the selection change colour because a chapter changed the
 * background. A palette that defeats every candidate keeps the first one rather
 * than leaving the selection unpainted; an invisible mark is that defect again.
 */
export function selectionMarkColor({ background, highlightColor, uniformColor } = {}) {
  const avoid = [background, highlightColor, uniformColor].filter(Boolean);
  for (const candidate of SELECTION_MARK_COLORS) {
    const nearBackground = background !== undefined
      && colorDistance(candidate, background) < SELECTION_MARK_MIN_BACKGROUND_DISTANCE;
    if (nearBackground) continue;
    if (avoid.some(other => other !== background && colorDistance(candidate, other) < SELECTION_MARK_MIN_DISTANCE)) continue;
    return candidate;
  }
  return SELECTION_MARK_COLORS[0];
}

/**
 * What to paint, from the saved selection and what is currently on screen.
 *
 * The SAVED selection is every key the wearer picked; hiding a chain does not
 * unpick it, and a selection edge drawn over atoms that are not on screen is a
 * hidden chain still glowing in the headset. So the plan carries only the
 * visible half, exactly as the marker pass in `markSelection` does, and the
 * saved keys stay where they are.
 */
export function selectionPaintPlan({ selectionKeys = [], hiddenKeys = [], appearance = {} } = {}) {
  const hidden = new Set(hiddenKeys);
  const keys = selectionKeys.filter(key => !hidden.has(key));
  return Object.freeze({ keys: Object.freeze([...keys]), color: selectionMarkColor(appearance) });
}

/**
 * The selection's own overpaint layer, appended to the emphasis layers.
 *
 * There is exactly ONE overpaint decorator per representation in this viewer:
 * `paintEmphasisLayers` builds it, and a second decorator of the same kind on
 * the same node would replace rather than add to it. So the selection is a
 * LAYER inside that one overpaint, and it is the last layer, which is how it
 * wins over the lesson's colour key on a residue that is in both. A wearer who
 * selects part of a highlighted region has asked to see that part.
 *
 * `bundleFor` is the caller's remap-and-take; it returns undefined for a
 * selection that has no atoms on this target, and that target then carries no
 * selection layer rather than an empty one.
 */
export function selectionOverpaintLayer({ plan, bundleFor, data, color }) {
  if (!plan?.keys?.length) return undefined;
  const bundle = bundleFor(plan.keys, data);
  if (!bundle) return undefined;
  return { bundle, color: color(plan.color), clear: false };
}

/**
 * The emphasis key's layers with the selection's layer last.
 *
 * Kept here rather than inline at the call site so the precedence is one
 * testable rule: emphasis first in authored order, selection last.
 */
export function composeOverpaintLayers(emphasisLayers = [], selectionLayer) {
  const layers = [...emphasisLayers];
  if (selectionLayer) layers.push(selectionLayer);
  return layers;
}
