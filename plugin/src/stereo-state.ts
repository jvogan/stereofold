/**
 * The stereo view state a panel adopts from the server, before it draws.
 *
 * Two panels look at the same session. Codex mounts a fresh app for every tool
 * call that carries UI metadata, so the panel a person ends up looking at is
 * usually not the one they set the mode on: it is a new mount whose own state
 * is the shipped default, mono at 20 arcminutes. Until this module existed the
 * new panel came up in mono, framed the structure for the whole stage, and
 * only reached the right geometry if someone clicked a mode button afterwards.
 *
 * So the server's mode, depth budget, eye swap and anaglyph variant travel
 * with the structure — on `stereo_structure.open` and on the app-only
 * `stereo_structure.get_structure` — and the panel applies them *before* the
 * load. That ordering is the point: `fitCameraToStage` measures one eye's
 * viewport, and one eye is half of a capped stage in a pair and the whole
 * stage in mono. A fit that runs before the mode arrives frames for the wrong
 * viewport, and on a tall side panel that is 3.7x too close.
 *
 * Kept pure and separate from the DOM so the "which fields did the payload
 * actually carry" question is testable without a browser.
 */

export type StereoModeName = 'off' | 'parallel' | 'cross' | 'anaglyph';
export type AnaglyphVariantName = 'balanced' | 'dubois';

/** The four fields that change what geometry a fit has to frame for. */
export interface StereoStatePatch {
  mode?: StereoModeName;
  depthBudgetArcmin?: number;
  swapEyes?: boolean;
  variant?: AnaglyphVariantName;
}

const MODES: readonly string[] = ['off', 'parallel', 'cross', 'anaglyph'];
const VARIANTS: readonly string[] = ['balanced', 'dubois'];

/** Same bounds as `setModeInputSchema`, restated where the value is read. */
const MIN_DEPTH_ARCMIN = 0;
const MAX_DEPTH_ARCMIN = 60;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Take the stereo state out of a tool payload, keeping only what it carries.
 *
 * Every field is optional and each is validated on its own, so a payload from
 * an older server that carries only `mode` still moves the mode, and a
 * malformed field is dropped rather than poisoning the ones beside it. An
 * out-of-range depth is dropped for the same reason: the slider's own bounds
 * are 0 to 60, and a payload outside them is not a value this panel can show.
 */
export function pickStereoState(payload: unknown): StereoStatePatch {
  if (!isRecord(payload)) return {};
  const patch: StereoStatePatch = {};
  const mode = payload.mode;
  if (typeof mode === 'string' && MODES.includes(mode)) patch.mode = mode as StereoModeName;
  const depth = payload.depthBudgetArcmin;
  if (typeof depth === 'number' && Number.isFinite(depth) && depth >= MIN_DEPTH_ARCMIN && depth <= MAX_DEPTH_ARCMIN) {
    patch.depthBudgetArcmin = depth;
  }
  if (typeof payload.swapEyes === 'boolean') patch.swapEyes = payload.swapEyes;
  const variant = payload.variant;
  if (typeof variant === 'string' && VARIANTS.includes(variant)) patch.variant = variant as AnaglyphVariantName;
  return patch;
}

/** True when the patch would change nothing, so the caller can skip the work. */
export function isEmptyStereoState(patch: StereoStatePatch): boolean {
  return patch.mode === undefined
    && patch.depthBudgetArcmin === undefined
    && patch.swapEyes === undefined
    && patch.variant === undefined;
}
