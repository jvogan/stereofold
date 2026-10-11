import { describe, expect, it } from 'vitest';
import {
  colorThemeForRepresentation,
  MOLSTAR_DEFAULT_THEME,
  NON_POLYMER_REPRESENTATION_TAGS,
  DEFAULT_LOOK_COLOR,
  DEFAULT_LOOK_STYLE,
  LOOK_COLOR_CHOICES,
  LOOK_COLOR_OPTIONS,
  LOOK_CONFIDENCE_FALLBACK,
  LOOK_STYLE_CHOICES,
  LOOK_STYLE_OPTIONS,
  isLookColor,
  isLookStyle,
  lookColorLabel,
  lookColorOrDefault,
  lookStyleLabel,
  lookStyleOrDefault,
  resolveColorTheme,
} from '../src/look.js';

describe('Stereofold look choices', () => {
  it('offers the five colours and three styles the drawer draws, in that order', () => {
    expect(LOOK_COLOR_OPTIONS.map((option) => option.label)).toEqual([
      'Chain',
      'Rainbow, N to C',
      'Secondary structure',
      'Element',
      'Confidence (pLDDT / B)',
    ]);
    expect(LOOK_STYLE_OPTIONS.map((option) => option.label)).toEqual([
      'Cartoon',
      'Ball and stick',
      'Surface',
    ]);
  });

  it('names every option for the Mol* theme or preset it selects', () => {
    expect(LOOK_COLOR_OPTIONS.map((option) => option.value)).toEqual([
      'chain-id',
      'sequence-id',
      'secondary-structure',
      'element-symbol',
      'plddt-confidence',
    ]);
    expect(LOOK_STYLE_OPTIONS.map((option) => option.value)).toEqual([
      'polymer-and-ligand',
      'atomic-detail',
      'molecular-surface',
    ]);
    // The option list and the schema's enum are the same array, so a theme
    // cannot appear in the drawer without also being accepted by the tools.
    expect(LOOK_COLOR_OPTIONS.map((option) => option.value)).toEqual([...LOOK_COLOR_CHOICES]);
    expect(LOOK_STYLE_OPTIONS.map((option) => option.value)).toEqual([...LOOK_STYLE_CHOICES]);
  });

  it('defaults to the look this viewer already drew', () => {
    expect(DEFAULT_LOOK_COLOR).toBe('chain-id');
    expect(DEFAULT_LOOK_STYLE).toBe('polymer-and-ligand');
    expect(LOOK_COLOR_OPTIONS[0]?.value).toBe(DEFAULT_LOOK_COLOR);
    expect(LOOK_STYLE_OPTIONS[0]?.value).toBe(DEFAULT_LOOK_STYLE);
  });

  it('passes every colour but Confidence through to Mol* unchanged', () => {
    for (const choice of ['chain-id', 'sequence-id', 'secondary-structure', 'element-symbol'] as const) {
      expect(resolveColorTheme(choice, { plddtApplicable: true })).toBe(choice);
      expect(resolveColorTheme(choice, { plddtApplicable: false })).toBe(choice);
    }
  });

  it('resolves Confidence to pLDDT only where the structure carries it', () => {
    // A predicted model with a quality-assessment score, or a B-factor column
    // on a non-experimental model: Mol*'s own applicability test.
    expect(resolveColorTheme('plddt-confidence', { plddtApplicable: true })).toBe('plddt-confidence');
    // An experimental crystal structure has B-factors but no confidence, so
    // the choice becomes the B-factor theme rather than failing or rendering
    // flat. That is the "/ B" half of the label.
    expect(resolveColorTheme('plddt-confidence', { plddtApplicable: false })).toBe('uncertainty');
    expect(LOOK_CONFIDENCE_FALLBACK).toBe('uncertainty');
  });

  it('rejects anything that is not one of the offered choices', () => {
    expect(isLookColor('chain-id')).toBe(true);
    expect(isLookColor('uncertainty')).toBe(false);
    expect(isLookColor('rainbow')).toBe(false);
    expect(isLookColor(undefined)).toBe(false);
    expect(isLookStyle('molecular-surface')).toBe(true);
    expect(isLookStyle('illustrative')).toBe(false);
    expect(isLookStyle(null)).toBe(false);
  });

  it('falls back to the default for a value a host or payload got wrong', () => {
    expect(lookColorOrDefault('element-symbol')).toBe('element-symbol');
    expect(lookColorOrDefault('nonsense')).toBe(DEFAULT_LOOK_COLOR);
    expect(lookColorOrDefault(undefined)).toBe(DEFAULT_LOOK_COLOR);
    expect(lookStyleOrDefault('atomic-detail')).toBe('atomic-detail');
    expect(lookStyleOrDefault(7)).toBe(DEFAULT_LOOK_STYLE);
  });

  it('leaves ligands, waters and ions element-coloured under Chain', () => {
    // The look every structure had before this control existed: a
    // chain-coloured cartoon with element-coloured everything else. Chain must
    // not change it, so the non-polymer representations go back to Mol*'s own
    // per-representation default rather than to chain-id.
    const chain = (tags: string[]): string =>
      colorThemeForRepresentation({ color: 'chain-id', resolvedTheme: 'chain-id', tags });

    expect(chain(['polymer'])).toBe('chain-id');
    for (const tag of NON_POLYMER_REPRESENTATION_TAGS) {
      expect(chain([tag])).toBe(MOLSTAR_DEFAULT_THEME);
    }
    expect(NON_POLYMER_REPRESENTATION_TAGS).toContain('ligand');
    expect(NON_POLYMER_REPRESENTATION_TAGS).toContain('water');
    expect(NON_POLYMER_REPRESENTATION_TAGS).toContain('ion');
    // A representation carrying several tags is exempt if any of them is.
    expect(chain(['branched-snfg-3d', 'extra'])).toBe(MOLSTAR_DEFAULT_THEME);
  });

  it('gives Chain to a component that cannot be split into polymer and ligand', () => {
    // `atomic-detail` and `molecular-surface` build one `all` component holding
    // the polymer and its ligands together, so there is nothing to exempt. It
    // takes the choice, because the alternative is a Colour control that does
    // nothing at all under two of the three styles.
    const chain = (tags: string[]): string =>
      colorThemeForRepresentation({ color: 'chain-id', resolvedTheme: 'chain-id', tags });
    expect(chain(['all'])).toBe('chain-id');
    expect(chain([])).toBe('chain-id');
  });

  it('lets the other four colours reach every representation', () => {
    // Only Chain is selective: someone asking for Rainbow or Secondary
    // structure is asking about the whole scene, and those themes have no
    // sensible per-part fallback.
    for (const color of ['sequence-id', 'secondary-structure', 'element-symbol'] as const) {
      for (const tag of ['polymer', 'ligand', 'water', 'ion', 'all']) {
        expect(colorThemeForRepresentation({ color, resolvedTheme: color, tags: [tag] })).toBe(color);
      }
    }
    // Confidence carries its resolved theme, not its choice name, everywhere.
    expect(colorThemeForRepresentation({ color: 'plddt-confidence', resolvedTheme: 'uncertainty', tags: ['water'] }))
      .toBe('uncertainty');
    expect(colorThemeForRepresentation({ color: 'plddt-confidence', resolvedTheme: 'plddt-confidence', tags: ['ligand'] }))
      .toBe('plddt-confidence');
  });

  it('labels a choice for a person rather than for Mol*', () => {
    expect(lookColorLabel('sequence-id')).toBe('Rainbow, N to C');
    expect(lookStyleLabel('polymer-and-ligand')).toBe('Cartoon');
    expect(lookStyleLabel('molecular-surface')).toBe('Surface');
  });
});
