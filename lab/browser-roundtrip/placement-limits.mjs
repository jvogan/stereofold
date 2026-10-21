/** Numerical guardrails shared by rendered, saved and imported placements.
 * Automatic Fit/Reset framing chooses its own initial size inside this range.
 */
// Preserve the 0.1.22 saved-scene range and allow fits in large source units.
// This is a numerical floor, not a visibility limit: wearer resizing is bounded
// relative to the committed entry below, regardless of the source's units.
export const PLACEMENT_MIN_SCALE = 1e-6;
export const PLACEMENT_MAX_SCALE = 1e6;
export const PLACEMENT_MAX_TRANSLATION = 1e6;
/** The farthest an automatic XR fit may seat a structure from the eye, in metres: a room holds it. */
export const XR_ROOM_MAX_METRES = 8;
/** Wearer resizing spans one fifth to five times the committed XR entry size.
 * The reference stays fixed across releases and authored placements; a fresh
 * entry establishes a new one. Outside the band, hold outward gestures and
 * allow gradual inward gestures, without snapping to the nearest boundary.
 * Automatic framing and assistant placements use the absolute numerical range.
 */
export const WEARER_SCALE_RANGE = 5;
export function clampPlacementScale(value, entryScale, currentScale) {
  const reference = Number.isFinite(entryScale) && entryScale > 0
    ? Math.min(PLACEMENT_MAX_SCALE, Math.max(PLACEMENT_MIN_SCALE, entryScale)) : undefined;
  const low = reference === undefined ? PLACEMENT_MIN_SCALE : Math.max(PLACEMENT_MIN_SCALE, reference / WEARER_SCALE_RANGE);
  const high = reference === undefined ? PLACEMENT_MAX_SCALE : Math.min(PLACEMENT_MAX_SCALE, reference * WEARER_SCALE_RANGE);
  // Include the currently drawn size, not the gesture's starting size: once a
  // close-up moves toward the band, reversing direction cannot ratchet outward.
  const current = Number.isFinite(currentScale) && currentScale >= PLACEMENT_MIN_SCALE && currentScale <= PLACEMENT_MAX_SCALE
    ? currentScale : undefined;
  return Math.min(Math.max(high, current ?? high), Math.max(Math.min(low, current ?? low),
    Number.isFinite(value) ? value : current ?? reference ?? 1));
}
export const clampPlacementTranslation = value => Math.min(PLACEMENT_MAX_TRANSLATION, Math.max(-PLACEMENT_MAX_TRANSLATION, value));
