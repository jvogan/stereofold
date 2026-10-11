/** One categorical palette for a structure's root chain table. Mol* chain-id
 * resolves both atom and bond locations against that root, including components
 * and assembly copies. Keep author-chain identity, as in the existing viewer.
 * The first four entries keep the wearer's orange/green/pink/purple key. No
 * representation, quality setting or XR session edge regenerates these hues. */
export const CHAIN_COLOR_PARAMS = Object.freeze({
  asymId: 'auth',
  palette: Object.freeze({ name: 'colors', params: Object.freeze({
    list: Object.freeze({ kind: 'set', colors: Object.freeze([
      0xd95f02, 0x1b9e77, 0xe7298a, 0x7570b3, 0x66a61e, 0xe6ab02, 0xa6761d, 0x666666,
      0xe41a1c, 0x377eb8, 0x4daf4a, 0x984ea3, 0xff7f00, 0xffff33, 0xa65628, 0xf781bf,
      0x999999, 0x66c2a5, 0xfc8d62, 0x8da0cb, 0xe78ac3, 0xa6d854, 0xffd92f, 0xe5c494, 0xb3b3b3,
    ]) }),
  }) }),
});

/** Radius multipliers for Mol*'s physical size theme (angstroms). The atom
 * tiers reduce screen coverage as scenes grow; the admitted geometry level
 * caps small-scene radii. Neither radius changes tessellation or the budget.
 * At 4,400 atoms / lowest: carbon radius = 1.7 * .24 = .408 A;
 * carbon bond radius = .408 * .75 = .306 A (previously .085 A).
 * Seated readability and GPU fill cost still require a physical 1.5 m check. */
export function xrBallAndStickParams({ representation, presenting = false, atoms, level } = {}) {
  if (!presenting || !['ball-and-stick', 'ball_and_stick'].includes(representation)) return {};
  if (!Number.isSafeInteger(atoms) || atoms < 0) throw Error('Cannot size XR sticks: invalid atom count.');
  const factor = atoms <= 2_000 ? .28 : atoms <= 8_000 ? .24 : atoms <= 25_000 ? .20 : .18;
  const cap = level === 'lowest' ? .24 : level === 'lower' ? .26 : .28;
  return { sizeFactor: Math.min(factor, cap), sizeAspectRatio: .75 };
}

/** Compare normalized appearances, allowing an otherwise repeated full patch. */
export function colorOnlyAppearanceChange(before, after) {
  return (before.color !== after.color || before.uniformColor !== after.uniformColor)
    && Object.keys(after).every(key => ['color', 'uniformColor'].includes(key) || before[key] === after[key]);
}
