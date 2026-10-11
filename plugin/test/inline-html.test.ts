import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { INSPECTOR_CSS_MARKER, readInlineHtml } from '../src/inline-html.js';
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
