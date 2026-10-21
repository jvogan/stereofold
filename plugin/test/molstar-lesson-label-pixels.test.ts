import { uniformCacheBuildPlugins } from '../src/molstar-uniform-cache-patch.js';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { patchLessonLabelRenderer, patchLessonLabelDraw, patchLessonLabelRenderItem, patchLessonLabelFragment } from '../src/molstar-lesson-label-patch.js';

// Explicit opt-in like the repository's other browser acceptance commands.
// STEREOFOLD_LABEL_PIXELS=1 runs real WebGL2 rasterization in Chromium.
const enabled = process.env.STEREOFOLD_LABEL_PIXELS === '1';
// SDF smoothing intentionally differs from the stock binary cutoff. Its
// derivative edge and the fixture's raster-derived 20-byte contrast mask
// disagree at two pixels in the reported WebGL run (of 120,000). This is the
// smallest observed allowance; broad interior/color changes still fail.
const MAX_NONEDGE_DIFFERENCE = 2;
let browser: Browser, script: string;
beforeAll(async () => {
  if (!enabled) return;
  const result = await build({ entryPoints: [new URL('fixtures/lesson-label-pixels.mjs', import.meta.url).pathname],
    bundle: true, platform: 'browser', format: 'iife', write: false, plugins: [...uniformCacheBuildPlugins(process.env.STEREOFOLD_UNIFORM_CACHE_PATCH !== '0'), { name: 'lesson-label-pixels', setup(b) {
      for (const [filter, patch] of [
        [/mol-gl[/\\]renderer\.js$/, patchLessonLabelRenderer],
        [/mol-canvas3d[/\\]passes[/\\]draw\.js$/, patchLessonLabelDraw],
        [/mol-gl[/\\]webgl[/\\]render-item\.js$/, patchLessonLabelRenderItem],
        [/mol-gl[/\\]shader[/\\]text\.frag\.js$/, patchLessonLabelFragment],
      ] as const) b.onLoad({ filter }, async ({ path }) => ({ contents: patch(await readFile(path, 'utf8')), loader: 'js' }));
    } }] });
  script = result.outputFiles[0]!.text;
  browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
});
afterAll(async () => { await browser?.close(); });
it.skipIf(!enabled).each(['blended', 'wboit', 'dpoit'])('keeps a buried plate visible with %s WebGL2 rendering', async mode => {
  const page = await browser.newPage();
  try {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.addScriptTag({ content: script });
    for (const postfx of [false, true]) {
      const result = await page.evaluate(async ({ mode, postfx }) => (globalThis as any).probeLessonLabels(mode, postfx), { mode, postfx });
      console.log(JSON.stringify(result));
      expect(result.actualMode).toBe(mode);
      expect(result.error).toBe(0);
      expect(result.postprocessingEnabled).toBe(postfx);
      expect(result.antialiasingEnabled).toBe(postfx);
      expect(result.fixedLabelDraws).toEqual(['colorLabelOccluded', 'colorLabelExposed']);
      expect(result.duplicateDifference).toBeGreaterThan(100);
      expect(result.stockBuriedPixels).toBe(0);
      expect(result.fixedBuriedPixels).toBeGreaterThan(100);
      // Preserve exposed interiors while allowing the intended glyph smoothing.
      expect(result.outsideEdgeDifference).toBeLessThanOrEqual(MAX_NONEDGE_DIFFERENCE);
      if (!postfx) expect(result.exposedDifference).toBeGreaterThan(20);
    }
    expect(errors).toEqual([]);
    if (process.env.STEREOFOLD_LABEL_SCREENSHOTS) await page.screenshot({ path: `${process.env.STEREOFOLD_LABEL_SCREENSHOTS}/${mode}.png` });
  } finally { await page.close(); }
});

it.skipIf(!enabled).each([1.5, 3, 5])('antialiases exposed glyphs at size %s without postprocessing', async size => {
  const page = await browser.newPage();
  try {
    await page.addScriptTag({ content: script });
    const result = await page.evaluate(async size => (globalThis as any).probeLessonLabels('blended', false, size), size);
    expect(result.error).toBe(0);
    expect(result.stockGrayPixels).toBe(0);
    expect(result.fixedGrayPixels).toBeGreaterThan(20);
    expect(result.outsideEdgeDifference).toBeLessThanOrEqual(MAX_NONEDGE_DIFFERENCE);
    expect(result.fixedLabelDraws).toEqual(['colorLabelOccluded', 'colorLabelExposed']);
  } finally { await page.close(); }
});
