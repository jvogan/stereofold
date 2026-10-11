/**
 * One lightness step per protofilament for whole-wall chapters.
 *
 * In the headset the wall tier's whole-structure chapters read as one ribbon
 * tangle: three protofilaments in identical blue and amber merge, so a learner
 * cannot count three strands from the picture. The fix keeps the hue rule (alpha stays blue, beta stays amber) and steps only
 * the lightness, one step per strand, so the strands are countable.
 *
 * The steps are computed here, in HSL space, rather than hand-typed as hex in
 * the lesson JSON. The JSON keeps the base colours and carries only the
 * per-chapter `strandShades` flag; `planLessonEmphasis` applies these steps at
 * plan time. Part chapters (one lit strand, the rest ghost) never set the
 * flag and keep their exact authored colours.
 */

/** Base colours from plugin/demos/microtubule-growth/wall.json. */
export const STRAND_BASE_ALPHA = '#4a90e2';
export const STRAND_BASE_BETA = '#f5a623';

/**
 * Lightness steps per strand, front to back. The front strand wears the base
 * colours, the middle strand is twelve points lighter, the rear strand is
 * twelve points darker. Hue and saturation are untouched.
 */
export const STRAND_LIGHTNESS_STEPS = [0, 0.12, -0.12];

/**
 * Which strand a wall-tier colour-key part belongs to, by part id. The middle
 * strand ids start with `middle-` and the rear strand ids start with `new-`;
 * the front strand and both ligands (`gtp`, `taxol`) are strand zero and wear
 * the base colours. Unknown ids fall back to strand zero, never to a failure.
 */
export function wallStrandIndex(part = {}) {
  const id = String(part.id ?? '');
  if (id.startsWith('middle-')) return 1;
  if (id.startsWith('new-')) return 2;
  return 0;
}

/** Parse `#rrggbb` into `{ h, s, l }` with h in degrees and s, l in 0..1. */
export function hexToHsl(hex) {
  const match = /^#([0-9a-f]{6})$/i.exec(String(hex ?? ''));
  if (!match) throw Error(`Not a hex colour: ${String(hex ?? '')}.`);
  const value = Number.parseInt(match[1], 16);
  const r = ((value >> 16) & 0xff) / 255;
  const g = ((value >> 8) & 0xff) / 255;
  const b = (value & 0xff) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const delta = max - min;
  const s = delta / (1 - Math.abs(2 * l - 1));
  let h;
  if (max === r) h = 60 * (((g - b) / delta) % 6);
  else if (max === g) h = 60 * ((b - r) / delta + 2);
  else h = 60 * ((r - g) / delta + 4);
  return { h: (h + 360) % 360, s, l };
}

/** Format `{ h, s, l }` back to lowercase `#rrggbb`. */
export function hslToHex({ h = 0, s = 0, l = 0 } = {}) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2 + 2) % 2 - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  const byte = (v) => Math.min(255, Math.max(0, Math.round((v + m) * 255)));
  const hex = (v) => byte(v).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/**
 * Shift a hex colour's lightness by `delta` (HSL points, -1..1) with hue and
 * saturation unchanged, clamped into range.
 */
export function shadeHex(hex, delta = 0) {
  const { h, s, l } = hexToHsl(hex);
  return hslToHex({ h, s, l: Math.min(1, Math.max(0, l + delta)) });
}

/** The colour a wall-tier part wears on a whole-structure chapter. */
export function strandShadeForPart(part = {}) {
  return shadeHex(part.color, STRAND_LIGHTNESS_STEPS[wallStrandIndex(part)] ?? 0);
}

/**
 * Apply the strand steps to a chapter's colour-key parts. Parts keep their
 * ids, labels, chains and residue ranges; only the colour changes, and only
 * by lightness. Chapters without the flag pass through untouched.
 */
export function applyWallStrandShades(parts = [], strandShades = false) {
  if (!strandShades) return parts;
  return parts.map((part) => ({ ...part, color: strandShadeForPart(part) }));
}
