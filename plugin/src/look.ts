/**
 * Colour and style: the two choices that decide what the structure is made of.
 *
 * Both are named for the Mol* thing they select, so a choice is its own wire
 * value and no lookup table stands between the drawer's `<select>`, the tool
 * schema, and the Mol* call. The one exception is `plddt-confidence`, which is
 * a *request* rather than a theme name: Mol*'s pLDDT provider only applies to a
 * model that carries a quality-assessment score or a B-factor column on a
 * predicted model, so `resolveColorTheme` falls back to `uncertainty` — the
 * B-factor theme — for an experimental structure. See `LOOK_CONFIDENCE_FALLBACK`.
 *
 * This module is pure so the mapping can be tested without Mol*, a browser or
 * a host.
 */

/** Colour choice: a Mol* colour-theme name, or a request resolved at apply time. */
export const LOOK_COLOR_CHOICES = [
  'chain-id',
  'sequence-id',
  'secondary-structure',
  'element-symbol',
  'plddt-confidence',
] as const;

/** Style choice: a Mol* structure-representation preset id. */
export const LOOK_STYLE_CHOICES = [
  'polymer-and-ligand',
  'atomic-detail',
  'molecular-surface',
] as const;

export type LookColor = typeof LOOK_COLOR_CHOICES[number];
export type LookStyle = typeof LOOK_STYLE_CHOICES[number];

/**
 * Chain colouring on the polymer-and-ligand preset is what this viewer has
 * drawn since T1, so both defaults keep the existing render.
 */
export const DEFAULT_LOOK_COLOR: LookColor = 'chain-id';
export const DEFAULT_LOOK_STYLE: LookStyle = 'polymer-and-ligand';

/**
 * What Confidence falls back to when the structure carries no pLDDT.
 *
 * `uncertainty` is Mol*'s B-factor/occupancy theme, which is the same physical
 * quantity the label's "/ B" refers to, so the option stays truthful on an
 * experimental structure instead of failing or rendering flat.
 */
export const LOOK_CONFIDENCE_FALLBACK = 'uncertainty';

export interface LookOption<T extends string> {
  value: T;
  label: string;
}

/** Drawer labels, in the order the mockup draws them. */
export const LOOK_COLOR_OPTIONS: ReadonlyArray<LookOption<LookColor>> = [
  { value: 'chain-id', label: 'Chain' },
  { value: 'sequence-id', label: 'Rainbow, N to C' },
  { value: 'secondary-structure', label: 'Secondary structure' },
  { value: 'element-symbol', label: 'Element' },
  { value: 'plddt-confidence', label: 'Confidence (pLDDT / B)' },
];

export const LOOK_STYLE_OPTIONS: ReadonlyArray<LookOption<LookStyle>> = [
  { value: 'polymer-and-ligand', label: 'Cartoon' },
  { value: 'atomic-detail', label: 'Ball and stick' },
  { value: 'molecular-surface', label: 'Surface' },
];

export function isLookColor(value: unknown): value is LookColor {
  return typeof value === 'string' && (LOOK_COLOR_CHOICES as readonly string[]).includes(value);
}

export function isLookStyle(value: unknown): value is LookStyle {
  return typeof value === 'string' && (LOOK_STYLE_CHOICES as readonly string[]).includes(value);
}

/** A choice that arrived from a tool payload, or the default when it did not. */
export function lookColorOrDefault(value: unknown): LookColor {
  return isLookColor(value) ? value : DEFAULT_LOOK_COLOR;
}

export function lookStyleOrDefault(value: unknown): LookStyle {
  return isLookStyle(value) ? value : DEFAULT_LOOK_STYLE;
}

export function lookColorLabel(value: LookColor): string {
  return LOOK_COLOR_OPTIONS.find((option) => option.value === value)?.label ?? value;
}

export function lookStyleLabel(value: LookStyle): string {
  return LOOK_STYLE_OPTIONS.find((option) => option.value === value)?.label ?? value;
}

/**
 * Representation tags the Chain choice must not recolour.
 *
 * These are the tags Mol*'s `polymer-and-ligand` preset gives its non-polymer
 * representations. Chain colours the polymer by chain and leaves these on the
 * preset's own per-representation default, which is element colouring for the
 * ball-and-stick and line visuals they use. That keeps the default look of
 * every structure opened before this control existed exactly as it was: a
 * chain-coloured cartoon with element-coloured ligands, waters and ions.
 *
 * The other four colour choices are global and recolour these too, because a
 * person asking for Rainbow or Secondary structure is asking about the whole
 * scene, and because those themes have no sensible per-part fallback.
 */
export const NON_POLYMER_REPRESENTATION_TAGS: readonly string[] = [
  'ligand',
  'non-standard',
  'branched-ball-and-stick',
  'branched-snfg-3d',
  'water',
  'ion',
  'lipid',
];

/**
 * `'default'` is Mol*'s own word, not a sentinel of ours: passed to
 * `updateRepresentationsTheme` it restores the registry default for that
 * representation type — `element-symbol` for ball-and-stick and line,
 * `chain-id` for cartoon and molecular-surface.
 */
export const MOLSTAR_DEFAULT_THEME = 'default';

/**
 * The theme one representation gets, given the choice and the representation's
 * own tags.
 *
 * Only Chain is selective. A representation with no tag this module knows —
 * the single `all` component that `atomic-detail` and `molecular-surface`
 * build, which contains the polymer and its ligands together and so cannot be
 * split — takes the chosen theme, because the alternative is a Colour control
 * that does nothing at all under two of the three styles.
 */
export function colorThemeForRepresentation(options: {
  color: LookColor;
  /** What `resolveColorTheme` decided for this structure. */
  resolvedTheme: string;
  tags: readonly string[];
}): string {
  if (options.color !== 'chain-id') return options.resolvedTheme;
  const nonPolymer = options.tags.some((tag) => NON_POLYMER_REPRESENTATION_TAGS.includes(tag));
  return nonPolymer ? MOLSTAR_DEFAULT_THEME : options.resolvedTheme;
}

/**
 * The Mol* colour theme a choice actually applies, decided at apply time.
 *
 * `plddtApplicable` is the answer `PLDDTConfidenceColorThemeProvider.isApplicable`
 * gives for the loaded structure; every other choice is already a theme name
 * and is returned unchanged.
 */
export function resolveColorTheme(
  color: LookColor,
  options: { plddtApplicable: boolean },
): string {
  if (color !== 'plddt-confidence') return color;
  return options.plddtApplicable ? 'plddt-confidence' : LOOK_CONFIDENCE_FALLBACK;
}
