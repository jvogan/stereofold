import { normalizeAppearance } from './inspection-state.mjs';

export const MAX_SCOPED_STYLES = 8;
export const MAX_STYLE_KEYS = 20000;
export const STYLE_FIELDS = Object.freeze(['representation', 'color', 'uniformColor', 'opacity']);

export function normalizeStylePatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)
    || !Object.keys(patch).length || Object.keys(patch).some(key => !STYLE_FIELDS.includes(key)))
    throw Error('A scoped style needs representation, color, uniformColor or opacity.');
  normalizeAppearance(patch);
  if (patch.representation === 'isosurface') throw Error('A residue style needs an atomic representation.');
  return Object.fromEntries(STYLE_FIELDS.filter(key => patch[key] !== undefined).map(key => [key, patch[key]]));
}

/** Canonical residue sets; stable field and key order on both ends. */
export function normalizeStyles(styles = []) {
  if (!Array.isArray(styles) || styles.length > MAX_SCOPED_STYLES) throw Error('At most eight scoped styles can be saved.');
  return styles.map(entry => {
    const { selectionKeys, ...patch } = entry;
    if (!Array.isArray(selectionKeys) || !selectionKeys.length || selectionKeys.length > MAX_STYLE_KEYS
      || selectionKeys.some(key => typeof key !== 'string' || !key.length || key.length > 4096))
      throw Error('A scoped style needs 1–20000 canonical residue keys.');
    const held = new Set();
    for (const key of selectionKeys) {
      if (held.has(key)) throw Error('Each scoped style must use unique canonical residue keys.');
      held.add(key);
    }
    return { selectionKeys: [...selectionKeys].sort(), ...normalizeStylePatch(patch) };
  });
}

/** Merge a partial edit on the target while keeping every other residue's look. */
export function applyScopedStyle(styles, selectionKeys, patch) {
  if (!selectionKeys.length) throw Error('Select residues before styling a selection.');
  if (new Set(selectionKeys).size !== selectionKeys.length || selectionKeys.length > MAX_STYLE_KEYS)
    throw Error('A scoped style needs at most 20000 unique canonical residue keys.');
  const clear = patch.clear === true;
  if (clear && Object.keys(patch).length !== 1) throw Error('clear cannot be combined with appearance fields.');
  const edit = clear ? undefined : normalizeStylePatch(patch);
  const targets = new Set(selectionKeys), groups = new Map();
  const previous = new Map(selectionKeys.map(key => [key, {}]));
  const add = (keys, style) => {
    if (!keys.length) return;
    const normalized = normalizeStylePatch(style), signature = JSON.stringify(normalized);
    const group = groups.get(signature) ?? { selectionKeys: [], ...normalized };
    group.selectionKeys.push(...keys); groups.set(signature, group);
  };
  for (const { selectionKeys: keys, ...style } of normalizeStyles(styles)) {
    add(keys.filter(key => !targets.has(key)), style);
    for (const key of keys) if (targets.has(key)) previous.set(key, { ...previous.get(key), ...style });
  }
  if (!clear) for (const [key, style] of previous) add([key], { ...style, ...edit });
  return normalizeStyles([...groups.values()].map(entry => ({...entry,selectionKeys:[...new Set(entry.selectionKeys)]})));
}
