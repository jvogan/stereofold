/**
 * What the wearer's status plate says about an agent command.
 *
 * The plate is two lines of roughly fifteen characters seated off to one side
 * of the eye (`spatial-toolbar-geometry.mjs`, `READOUT_PAGE_LINE_WIDTH`), so
 * the page's own sentence -- `Applied · render quality · revision 26` -- is
 * three times too long for it. This module is the translation: it reads the
 * sentence the inspector already wrote for the flat page and returns the short
 * form the plate can hold, plus the colour that tells the state apart at a
 * glance without reading it at all.
 *
 * It is pure and separate from `immersive-session.mjs` so a test can hold it;
 * the session module itself cannot be imported outside a bundle, because it
 * pulls in Mol*.
 */

/** Orange: a command the panel has taken but not yet drawn. */
export const OUTCOME_WAITING_COLOR = 0xf2c47c;
/** Teal: drawn and saved. The same teal as the panel's own accent edge. */
export const OUTCOME_APPLIED_COLOR = 0x58dcc9;
/** Red: refused or failed. */
export const OUTCOME_FAILED_COLOR = 0xf07d7d;

/**
 * The wearer's word for the half of the scene a command moved.
 *
 * A translation table rather than a pass-through, because the names on the
 * wire are the protocol's: a `render-quality` command carries `level`, a tour
 * command carries `action`, an appearance command carries `uniformColor`. When
 * `motion`, `level` and `action` were unlisted, a tour, a spin, a stop and two
 * quality commands all read `change` on the plate and the wearer could not
 * tell which had landed.
 *
 * Keys are the lower-cased, space-separated form `inspector.ts showOutcome`
 * writes (`uniformColor` reaches here as `uniform color`). Anything unlisted
 * falls back to `change`, so a field nobody has shortened yet can never put
 * a word on the plate that is wider than the plate.
 */
export const OUTCOME_FIELD_WORDS = new Map([
  // `structure` is a source load. The readout's title line carries
  // the structure's own name, so the status row says only what changed.
  ...['appearance', 'placement', 'scene', 'background', 'color', 'opacity', 'labels',
    'clipping', 'fog', 'rotation', 'scale', 'selection', 'camera', 'motion', 'tour', 'focus', 'structure']
    .map(word => [word, word]),
  // `Applied · representation · r26` is 30 characters against a plate that
  // holds 30 including the revision, and it is the menu's own Cartoon/Surface/
  // Atoms row under another name. Same for a placement `translation`.
  ['representation', 'style'],
  ['translation', 'move'],
  ['uniform color', 'color'],
  ['selection keys', 'selection'],
  // `render-quality` patches `level`; the receipt the agent polls names it
  // `renderQuality`. Both are the one thing the wearer calls quality.
  ['level', 'quality'],
  ['render quality', 'quality'],
  // `tour` patches `action` and, on a start, `tourId`. The wearer has one word.
  ['action', 'tour'],
  ['tour id', 'tour'],
  ['framing', 'focus'],
]);

/**
 * The short name for what a command touched, or `change` when nothing in the
 * sentence is a field this plate has a word for.
 *
 * Several fields collapse to one word (`color` and `uniform color` are both
 * colour), so the list is deduplicated after translation and only then
 * counted: `color +1` has to mean one more thing the wearer would notice.
 */
export function outcomeFields(text) {
  const match = typeof text === 'string'
    ? /^(?:applied|waiting|could not apply)\s*[·•]\s*([^·•]+)/i.exec(text) : undefined;
  const named = match?.[1].split(',')
    .map(value => OUTCOME_FIELD_WORDS.get(value.trim().toLowerCase()))
    .filter(Boolean) ?? [];
  const fields = [...new Set(named)];
  if (!fields.length) return 'change';
  return fields.length === 1 ? fields[0] : `${fields[0]} +${Math.min(fields.length - 1, 2)}`;
}

/**
 * One plate line and its colour, from the page's sentence and its state.
 *
 * The state is `outcome.dataset.state` in `inspector.ts`: `waiting`, `applied`
 * or `error`. Anything else is read as applied, because the only other states
 * the page sets (`connected`) mean the panel is up and nothing is pending.
 */
export function outcomeCopy(text, status) {
  const normalized = typeof status === 'string' ? status.toLowerCase() : '';
  const fields = outcomeFields(text);
  if (normalized === 'waiting' || normalized === 'pending') {
    return { text: `Waiting · ${fields}`, color: OUTCOME_WAITING_COLOR };
  }
  if (normalized === 'error' || normalized === 'failed' || normalized === 'failure') {
    // A pre-dispatch hold did not attempt this style. Keep its wearer sentence,
    // including why it was dropped, on the same paged caption surface.
    if (typeof text === 'string' && /^(?:The change was not sent because |The previous change could not be restored\.|The earlier request was dropped for your correction\.)/.test(text))
      return { text, color: OUTCOME_FAILED_COLOR };
    return { text: `Could not apply · ${fields}`, color: OUTCOME_FAILED_COLOR };
  }
  const revision = typeof text === 'string' ? /\brevision\s*#?\s*(\d{1,9})\b/i.exec(text) : undefined;
  return { text: revision ? `Applied · ${fields} · r${revision[1]}` : `Applied · ${fields}`,
    color: OUTCOME_APPLIED_COLOR };
}
