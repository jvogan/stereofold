/**
 * The structure text Mol* is given, with every '<' written as '&lt;'.
 *
 * Mol*'s stock Structure Tools render the selection history, the measurement
 * list and the superposition entries as HTML, and Mol* copies the names it
 * reads out of the file into those labels unescaped: the entry id, and chain,
 * residue and atom names and insertion codes. A file whose chain id was
 * `<img src=x onerror=…>` would run that handler on the inspector page once
 * the atom was selected in those tools. Mol* puts those names only between
 * tags, where '<' is the one character that can start markup, and mmCIF gives
 * '<' no meaning, so a label built from the rewritten text shows the character
 * instead of parsing it. Coordinates and numbers never contain one, and a file
 * without one reaches Mol* unchanged.
 *
 * This is the same rewrite the detailed view applies before its own Mol*
 * parse (`DETAILED_VIEW_ESCAPE_SOURCE` in plugin/src/detailed-view-page.ts),
 * so the two pages treat a file alike. It is applied only to the copy handed
 * to Mol*: the source digest, the catalog and Stereofold's own headings read
 * the original text. The selection adapter binds the names Mol* parsed to the
 * catalog's, so a file with a '<' in a chain, residue or atom name or an
 * insertion code no longer matches its catalog and does not load; one with a
 * '<' only in its title, entry id or entity description loads as before.
 */
export const escapeStructureMarkup = text => text.replace(/</g, '&lt;');

/**
 * A name read back out of Mol*'s parse, as the file wrote it, for text
 * Stereofold draws itself.
 *
 * `original` is the file text before the rewrite. A file without a '<' was
 * handed to Mol* unchanged, so its names are already exact, including a
 * literal '&lt;'. Otherwise each '&lt;' in the name is either a '<' the
 * rewrite made or one the file spelled out, and the original text says which:
 * the first place it holds the name, with either spelling at each of them, is
 * the file's own wording. Only a name that cannot be found there, or a caller
 * without the original, falls back to reading every '&lt;' as '<'.
 */
export function unescapeStructureMarkup(text, original) {
  if (typeof text !== 'string' || !text.includes('&lt;')) return text;
  if (typeof original === 'string') {
    if (!original.includes('<')) return text;
    const pattern = text.split('&lt;').map(part => part.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')).join('(?:<|&lt;)');
    const found = original.match(new RegExp(pattern));
    if (found) return found[0];
  }
  return text.replace(/&lt;/g, '<');
}

/**
 * The `_struct.title` value as the file wrote it, read in the item form
 * mmCIF files use for `_struct` (not a loop), or undefined when the file has
 * no such item. The value is the one place the title's own
 * spelling lives, so `unescapeStructureMarkup` is given it rather than the
 * whole file, where a comment or another field could spell the same words
 * differently. Single-line quoted, unquoted and semicolon-delimited values
 * are read, after the tag on its line or on the next.
 */
export function structureTitleSource(text) {
  if (typeof text !== 'string') return undefined;
  const tag = /^_struct\.title(?=\s)/imu.exec(text);
  if (!tag) return undefined;
  // CIF allows comments between a tag and its value; the value is what follows them.
  const rest = text.slice(tag.index + tag[0].length)
    .replace(/^((?:[ \t]*\r?\n)*)(?:[ \t]*#[^\r\n]*\r?\n(?:[ \t]*\r?\n)*)+/u, '\n');
  const field = /^[ \t]*\r?\n;([^]*?)\r?\n;/u.exec(rest);
  if (field) return field[1];
  const value = /^\s*(?:'([^\r\n]*?)'(?=\s|$)|"([^\r\n]*?)"(?=\s|$)|([^\s'"_;][^\s]*))/u.exec(rest);
  if (!value) return undefined;
  return value[1] ?? value[2] ?? value[3];
}
