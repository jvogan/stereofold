import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { INSPECTOR_CSS_MARKER, INSPECTOR_SCRIPT_FILES, INSPECTOR_SCRIPT_MARKERS, INSPECTOR_SCRIPT_CHUNK_MAX_BYTES, splitInspectorScript, readInlineHtml } from '../src/inline-html.js';
import { readStampedBuildId, stampedBuildId } from '../src/build-identity.js';
import { VIEWER_BUILD_PLACEHOLDER } from '../src/viewer-build.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function page(html: string, css?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'stereofold-inline-')); roots.push(root);
  const path = join(root, 'inspector.html'); await writeFile(path, html);
  if (css !== undefined) await writeFile(join(root, 'inspector.css'), css);
  return path;
}

it('reassembles exact inline styles and includes them in the verified build identity', async () => {
  const css = 'body{color:#123456}/* $& is literal CSS text */';
  const original = `<style>${css}</style><script>const build='${VIEWER_BUILD_PLACEHOLDER}'</script>`;
  const digest = createHash('sha256').update(original).digest('hex');
  const complete = original.replace(VIEWER_BUILD_PLACEHOLDER, digest);
  const path = await page(complete.replace(css, INSPECTOR_CSS_MARKER), css);
  expect(await readInlineHtml(path)).toBe(complete);
  expect(await readStampedBuildId(path)).toBe(digest);
  await writeFile(join(path, '..', 'inspector.css'), css + 'body{color:red}');
  expect(await readStampedBuildId(path)).toBeNull();
});

it('keeps complete older pages readable without requiring an adjacent stylesheet', async () => {
  const html = '<style>body{color:red}</style><p>Hello</p>';
  expect(await readInlineHtml(await page(html))).toBe(html);
});

it('fails when a split stylesheet is missing or contains malformed inline content', async () => {
  await expect(readInlineHtml(await page(`<style>${INSPECTOR_CSS_MARKER}</style>`))).rejects.toThrow();
  for (const css of [INSPECTOR_CSS_MARKER, '</style><script>alert(1)</script>']) {
    await expect(readInlineHtml(await page(`<style>${INSPECTOR_CSS_MARKER}</style>`, css))).rejects.toThrow(/invalid inline/u);
  }
  await expect(readInlineHtml(await page(INSPECTOR_CSS_MARKER.repeat(2), 'body{}'))).rejects.toThrow(/exactly one/u);
  expect(stampedBuildId('unstamped')).toBeNull();
});


async function scriptPage(script: string, html = `<script>${INSPECTOR_SCRIPT_MARKERS.join('')}</script>`): Promise<string> {
  const path = await page(html);
  const chunks = splitInspectorScript(script);
  await Promise.all(INSPECTOR_SCRIPT_FILES.map((file, index) => writeFile(join(path, '..', file), chunks[index]!)));
  return path;
}

it('reconstructs stamped scripts byte for byte including Unicode and literal replacement text', async () => {
  const css = 'body{color:white}';
  const script = `const build='${VIEWER_BUILD_PLACEHOLDER}'; const text='🧬é漢字 $&';`;
  const original = `<style>${css}</style><script>${script}</script>`;
  const digest = createHash('sha256').update(original).digest('hex');
  const complete = original.replace(VIEWER_BUILD_PLACEHOLDER, digest);
  const path = await scriptPage(script.replace(VIEWER_BUILD_PLACEHOLDER, digest), `<style>${INSPECTOR_CSS_MARKER}</style><script>${INSPECTOR_SCRIPT_MARKERS.join('')}</script>`);
  await writeFile(join(path, '..', 'inspector.css'), css);
  expect(await readInlineHtml(path)).toBe(complete);
  expect(await readStampedBuildId(path)).toBe(digest);
  await writeFile(join(path, '..', INSPECTOR_SCRIPT_FILES[1]), 'tampered');
  expect(await readStampedBuildId(path)).toBeNull();
});

it('splits UTF-8 code points without changing the script and bounds both stored files', () => {
  for (const source of ['', 'é', 'a🧬b', '漢字é🧬', 'x'.repeat(1001)]) {
    const chunks = splitInspectorScript(source);
    expect(chunks.join('')).toBe(source);
    expect(Buffer.concat(chunks.map(chunk => Buffer.from(chunk)))).toEqual(Buffer.from(source));
  }
  expect(() => splitInspectorScript('x'.repeat(INSPECTOR_SCRIPT_CHUNK_MAX_BYTES * 2 + 1))).toThrow(/storage limit/u);
});

it('rejects missing chunks and malformed, duplicated, reordered or misplaced script markers', async () => {
  const markers = INSPECTOR_SCRIPT_MARKERS;
  for (const html of [
    `<script>${markers[0]}</script>`, `<script>${markers[1]}${markers[0]}</script>`,
    `<script>${markers.join('')}${markers[0]}</script>`, markers.join(''),
    '<script>/* STEREOFOLD_INSPECTOR_SCRIPT_3 */</script>',
  ]) await expect(readInlineHtml(await page(html))).rejects.toThrow(/two ordered/u);
  const path = await scriptPage('const value=1;');
  await rm(join(path, '..', INSPECTOR_SCRIPT_FILES[1]));
  await expect(readInlineHtml(path)).rejects.toThrow();
  expect(await readStampedBuildId(path)).toBeNull();
});

it('rejects unsafe or oversized script companions, including a closing tag split across files', async () => {
  for (const source of [INSPECTOR_SCRIPT_MARKERS[0], INSPECTOR_CSS_MARKER, '</SCRIPT>'])
    expect(() => splitInspectorScript(source)).toThrow(/invalid inline/u);
  const path = await scriptPage('const value=1;');
  await writeFile(join(path, '..', INSPECTOR_SCRIPT_FILES[0]), '</scr');
  await writeFile(join(path, '..', INSPECTOR_SCRIPT_FILES[1]), 'ipt>');
  await expect(readInlineHtml(path)).rejects.toThrow(/invalid inline/u);
  await writeFile(join(path, '..', INSPECTOR_SCRIPT_FILES[0]), 'x'.repeat(INSPECTOR_SCRIPT_CHUNK_MAX_BYTES + 1));
  await expect(readInlineHtml(path)).rejects.toThrow(/storage limit/u);
});
