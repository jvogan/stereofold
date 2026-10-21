/**
 * Backing alpha and filled-type numbers for the caption plate and the menu
 * column.
 *
 * Drawn as a faint SDF stroke on a quarter-alpha card, both wash out against a
 * white passthrough wall: the fill disappears, only the glyph edge remains,
 * and 20-24 px type becomes unreadable. Every alpha and fill number for those
 * plates lives here. Sizes, seats, wrap widths and the teal accent stay where
 * they were.
 *
 * Mol*-free on purpose: `node --test` can load this without the viewer bundle.
 */

/**
 * How solid the glass is while the wearer is using the menu.
 * 80% opaque near-black, the top of the legible 70-80% band.
 */
export const MENU_IDLE_ALPHA = Object.freeze({ plates: 0.80, labels: 1, readout: 1 });

/**
 * How solid the same glass is while a lesson chapter is on screen.
 *
 * A quarter lets the molecule outshine the menu, but a quarter is what
 * vanishes against a white wall. The asleep state still
 * drops below idle — the menu reads as standing back — but the backing stays
 * in the 70% band so filled white type still has a dark card under it.
 */
export const MENU_PLAY_ALPHA = Object.freeze({ plates: 0.70, labels: 0.90, readout: 1 });

/** The alpha the three menu layers want when the menu is standing back. */
export const menuAlpha = (standingBack) => standingBack ? MENU_PLAY_ALPHA : MENU_IDLE_ALPHA;

/**
 * Mol* text draw props for every toolbar string.
 *
 * `borderWidth: 0` is the stroke removal: SDF glyphs fill, they do not
 * outline. `background: false` because the plate mesh is the dark card, not
 * a per-glyph box. Alpha is layered on by `toolbarTextProps`.
 */
export const TOOLBAR_TEXT_DRAW = Object.freeze({
  sizeFactor: 1,
  fontFamily: 'sans-serif', fontWeight: 'bold', fontQuality: 2,
  background: false,
  attachment: 'middle-center',
  offsetZ: 0,
  borderWidth: 0,
});

/** Text `createOrUpdate` props at the alpha this layer is currently drawing. */
export function toolbarTextProps(alpha) {
  return { ...TOOLBAR_TEXT_DRAW, alpha };
}

/**
 * The recessed Done seat on the last chapter.
 *
 * Near-black type on a near-black chip vanishes on a passthrough wall, so the
 * seat reads in the same near-white as every other row
 * (`PALETTE.text` in `spatial-toolbar.mjs`), at a reduced alpha so it still
 * reads as inactive, on the same flat recessed backing. The backing stays
 * flat (no lift, narrow chamfer in `roomPlates`) and the hit test still
 * refuses it, so only the paint changed: legible, still not a button.
 */
export const DONE_LABEL_ALPHA = 0.6;

/** Text `createOrUpdate` props for a recessed state row such as Done. */
export function toolbarDoneTextProps() {
  return { ...TOOLBAR_TEXT_DRAW, alpha: DONE_LABEL_ALPHA };
}

/**
 * The recessed chip's own fill, raised with its label.
 *
 * A near-black chip (`face 0x101b21 / edge 0x16242b`) swallows the dim label.
 * This is still clearly darker than an `action` face so it cannot read as
 * pressable, just light enough that button-white type at 0.6 has an edge.
 */
export const STATE_PLATE_STYLE = Object.freeze({ face: 0x24333b, edge: 0x31454e });

/** Plate-mesh `createOrUpdate` props. Lighting stays on so the chamfer still reads. */
export function toolbarPlateProps(alpha) {
  return { alpha, doubleSided: true, ignoreLight: false };
}
