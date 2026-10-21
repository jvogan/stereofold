import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

/** Fixed local asset marker; no package content controls which file is read. */
export const INSPECTOR_CSS_MARKER = '/* STEREOFOLD_INSPECTOR_CSS */';
export const INSPECTOR_SCRIPT_FILES = ['inspector-script-1.js', 'inspector-script-2.js'] as const;
export const INSPECTOR_SCRIPT_MARKERS = ['/* STEREOFOLD_INSPECTOR_SCRIPT_1 */', '/* STEREOFOLD_INSPECTOR_SCRIPT_2 */'] as const;
export const INSPECTOR_SCRIPT_CHUNK_MAX_BYTES = 3 * 1024 * 1024;
const SCRIPT_NAMESPACE = 'STEREOFOLD_INSPECTOR_SCRIPT_';

function checkScript(source: string): void {
  if (source.includes(SCRIPT_NAMESPACE) || source.includes(INSPECTOR_CSS_MARKER) || /<\/script/iu.test(source))
    throw new Error('Inspector script contains an invalid inline marker or closing tag.');
}

/** Split stored UTF-8 without cutting a code point or changing rendered bytes. */
export function splitInspectorScript(source: string): [string, string] {
  checkScript(source);
  const bytes = Buffer.from(source, 'utf8');
  let middle = Math.ceil(bytes.length / 2);
  while (middle > 0 && (bytes[middle]! & 0xc0) === 0x80) middle--;
  const chunks: [string, string] = [bytes.subarray(0, middle).toString('utf8'), bytes.subarray(middle).toString('utf8')];
  if (chunks.some(chunk => Buffer.byteLength(chunk, 'utf8') > INSPECTOR_SCRIPT_CHUNK_MAX_BYTES))
    throw new Error('Inspector script exceeds the fixed two-chunk storage limit.');
  return chunks;
}

/** Reassemble the self-contained page used by every inspector host. */
export async function readInlineHtml(path: string): Promise<string> {
  let html = await readFile(path, 'utf8');
  const count = html.split(INSPECTOR_CSS_MARKER).length - 1;
  if (count > 1) throw new Error('Inspector HTML must contain exactly one stylesheet marker.');
  if (count === 1) {
    const css = await readFile(resolve(dirname(path), 'inspector.css'), 'utf8');
    if (css.includes(INSPECTOR_CSS_MARKER) || css.includes(SCRIPT_NAMESPACE) || /<\/style/iu.test(css))
      throw new Error('Inspector stylesheet contains an invalid inline marker or closing tag.');
    html = html.replace(INSPECTOR_CSS_MARKER, () => css);
  }
  if (!html.includes(SCRIPT_NAMESPACE)) return html;
  const markers = INSPECTOR_SCRIPT_MARKERS.join('');
  if (html.split(SCRIPT_NAMESPACE).length - 1 !== INSPECTOR_SCRIPT_MARKERS.length
    || INSPECTOR_SCRIPT_MARKERS.some(marker => html.split(marker).length - 1 !== 1)
    || !html.includes(`<script>${markers}</script>`))
    throw new Error('Inspector HTML must contain the two ordered script markers inside one inline script.');
  const chunks = await Promise.all(INSPECTOR_SCRIPT_FILES.map(async file => {
    const chunk = await readFile(resolve(dirname(path), file), 'utf8');
    if (Buffer.byteLength(chunk, 'utf8') > INSPECTOR_SCRIPT_CHUNK_MAX_BYTES)
      throw new Error(`Inspector script chunk exceeds its storage limit: ${file}.`);
    return chunk;
  }));
  const script = chunks.join('');
  checkScript(script);
  return html.replace(markers, () => script);
}
