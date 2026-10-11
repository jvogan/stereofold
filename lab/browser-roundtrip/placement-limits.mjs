/** Numerical guardrails shared by rendered, saved and imported placements.
 * Automatic Fit/Reset framing chooses its own initial size inside this range.
 */
export const PLACEMENT_MIN_SCALE = 1e-6;
export const PLACEMENT_MAX_SCALE = 1e6;
export const PLACEMENT_MAX_TRANSLATION = 1e6;
export const clampPlacementScale = value => Math.min(PLACEMENT_MAX_SCALE, Math.max(PLACEMENT_MIN_SCALE, value));
export const clampPlacementTranslation = value => Math.min(PLACEMENT_MAX_TRANSLATION, Math.max(-PLACEMENT_MAX_TRANSLATION, value));
