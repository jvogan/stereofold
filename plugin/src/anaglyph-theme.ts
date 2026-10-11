import { luminancePalette, type GlassesKind, type Variant } from '@stereo/anaglyph';
import { ElementSymbolColorTheme, ElementSymbolColorThemeProvider } from 'molstar/lib/mol-theme/color/element-symbol.js';
import { Color } from 'molstar/lib/mol-util/color/index.js';

/**
 * An element-aware theme that preserves each element's luminance while the
 * anaglyph compositor is active. Hue is intentionally only a weak cue.
 *
 * The variant matters because the two compositors want different tints. Under
 * `balanced` the projector keeps only Rec.709 luma, so the returned tint is
 * discarded by the composite and only the luma ordering survives. Under
 * `dubois` the palette searches the largest isoluminant tint that keeps the
 * package's internal residual bound, so it must be told which one is active.
 */
let activeGlasses: GlassesKind = 'red-cyan';
let activeVariant: Variant = 'balanced';

export function setAnaglyphThemeGlasses(glasses: GlassesKind, variant: Variant = activeVariant): void {
  activeGlasses = glasses;
  activeVariant = variant;
}

export const AnaglyphLuminanceColorThemeProvider = {
  name: 'stereo-anaglyph-luminance',
  label: 'Stereo luminance-led elements',
  category: 'Atom',
  factory: (ctx: Parameters<typeof ElementSymbolColorTheme>[0]) => {
    const base = ElementSymbolColorTheme(ctx, ElementSymbolColorThemeProvider.defaultValues);
    return {
      ...base,
      factory: AnaglyphLuminanceColorThemeProvider.factory,
      color: (location: Parameters<typeof base.color>[0]) => {
        const [r, g, b] = Color.toRgbNormalized(base.color(location, false));
        const mapped = luminancePalette([r, g, b], { glasses: activeGlasses, variant: activeVariant });
        return Color.fromNormalizedArray(mapped, 0);
      },
      props: {},
      description: 'Luminance-led element palette for anaglyph glasses.',
    };
  },
  getParams: () => ({}),
  defaultValues: {},
  isApplicable: (ctx: { structure?: unknown }) => !!ctx.structure,
};
