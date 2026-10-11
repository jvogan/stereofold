import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

/** Fixed local asset marker; no package content controls which file is read. */
export const INSPECTOR_CSS_MARKER = '/* STEREOFOLD_INSPECTOR_CSS */';

/** Reassemble the self-contained page used by every inspector host. */
export async function readInlineHtml(path: string): Promise<string> {
  const html = await readFile(path, 'utf8');
  const count = html.split(INSPECTOR_CSS_MARKER).length - 1;
  if (count === 0) return html;
  if (count !== 1) throw new Error('Inspector HTML must contain exactly one stylesheet marker.');
  const css = await readFile(resolve(dirname(path), 'inspector.css'), 'utf8');
  if (css.includes(INSPECTOR_CSS_MARKER) || /<\/style/iu.test(css)) {
    throw new Error('Inspector stylesheet contains an invalid inline marker or closing tag.');
  }
  return html.replace(INSPECTOR_CSS_MARKER, () => css);
}
