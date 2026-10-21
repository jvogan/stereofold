/**
 * The chapter card is as wide as the line it holds, and the caption fills it.
 *
 * The card was sized as 45 characters of a 0.54 em stand-in glyph, while the
 * bold sans the headset draws averages 0.31 em, so the plate held about 77
 * characters. A lesson without a spoken line also reached the card already
 * cut into 45-character pages, so each page was one line ending `…` that
 * filled half the plate.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { toolbarFrameRuntime } from './fixtures/toolbar-frame-runtime.mjs';
import { createToolbarPanel, SPATIAL_TOOLBAR_LAYOUT } from './spatial-toolbar-geometry.mjs';
import { spatialToolbarRows } from './spatial-toolbar-content.mjs';

const require = createRequire(new URL('../../plugin/package.json', import.meta.url));
const { tsImport } = require('tsx/esm/api');
const { wearerPages } = await tsImport('../../plugin/src/tour-player.ts', import.meta.url);
const { molecularLessonToTour } = await tsImport('../../plugin/src/molecular-lesson-tour.ts', import.meta.url);
const metrics = JSON.parse(readFileSync(new URL('./fixtures/toolbar-bold-font-metrics.json', import.meta.url), 'utf8'));
const runtime = await toolbarFrameRuntime(new URL('./', import.meta.url), { glyphAdvances: metrics.advances });
const head = { position: { x: 0, y: 1.6, z: 0 }, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1.6, 0, 1] };
const lesson = JSON.parse(readFileSync(new URL('../../plugin/demos/atp-synthase.json', import.meta.url), 'utf8'));
const tour = molecularLessonToTour(lesson);
const words = text => text.replaceAll('…', ' ').split(/\s+/u).filter(Boolean);

// What the headset's Chromium measures for Mol*'s atlas (bold sans-serif at
// 192 px, line height 304, buffer 24) on a line of this lesson's prose.
const BROWSER_LINE = { text: 'Gamma forms the shaft into the catalytic head', em: 13.921 };

function cardPages(index) {
  const step = tour.steps[index];
  const pages = wearerPages(step);
  const state = { active: true, autoplay: false, selectedId: lesson.id, selectedTitle: lesson.title, title: step.title,
    progress: `Scene ${index + 1} / ${tour.steps.length}`, step: index, total: tour.steps.length, chapterStartedAt: 0,
    bodyPage: pages[0], bodyPageIndex: 0, bodyPageCount: pages.length };
  const readout = runtime.tourReadout(state, undefined, 0);
  const options = { measureText: runtime.toolbarTextWidth, head, constants: SPATIAL_TOOLBAR_LAYOUT, readout, readoutPage: 0,
    rows: spatialToolbarRows({ collapsed: true, quiet: true, voice: { state: 'idle' }, tour: { ...state, canNext: true } }) };
  const first = createToolbarPanel(options);
  return { step, pages, panels: Array.from({ length: first.readoutPageCount }, (_, page) => createToolbarPanel({ ...options, readoutPage: page })) };
}

test('the stand-in glyph advances are the ones the headset browser measures', () => {
  const width = Array.from(BROWSER_LINE.text).reduce((sum, character) => sum + metrics.advances[character], 0);
  assert.ok(Math.abs(width - BROWSER_LINE.em) < 0.01, `a measured line is ${width.toFixed(3)} em, the browser's ${BROWSER_LINE.em}`);
  // Mol*'s atlas caps a glyph cell at three quarters of its line height, so
  // no advance exceeds (228 - 2 * 24) / 304.
  const cap = (Math.round(metrics.lineHeight * 0.75) - 2 * metrics.buffer) / metrics.lineHeight;
  for (const [character, advance] of Object.entries(metrics.advances)) {
    assert.ok(advance <= cap + 1e-9, `${JSON.stringify(character)} advances ${advance.toFixed(3)}, past the atlas cap ${cap.toFixed(3)}`);
  }
});

test('a lesson without a spoken line sends its whole caption to the card', () => {
  for (const step of tour.steps) assert.deepEqual(wearerPages(step), [step.body ?? step.description], step.id);
});

test('the chapter card is about 45 measured characters wide', () => {
  const { panels: [panel] } = cardPages(0);
  const glass = 2 * panel.captionBacking.halfWidth;
  const line = runtime.toolbarTextWidth(BROWSER_LINE.text) * panel.readoutFontMeters;
  assert.ok(glass > line && glass < line * 1.25, `the glass is ${(glass / line).toFixed(2)} of a 45-character line`);
  assert.ok(panel.readoutWrapWidth >= 40 && panel.readoutWrapWidth <= 50, `${panel.readoutWrapWidth} characters a line`);
});

for (const [index] of lesson.chapters.entries()) test(`chapter ${index + 1}: the caption fills the card's lines and pages whole`, () => {
  const { step, panels } = cardPages(index);
  const caption = step.body ?? step.description;
  const shown = panels.map(panel => panel.readoutPoints.map(line => line.text));
  assert.deepEqual(words(shown.flatMap(page => page.slice(1)).join(' ')), words(caption), 'the pages joined are the whole caption');
  for (const [page, panel] of panels.entries()) {
    const lines = shown[page];
    assert.ok(lines.length >= 2 && lines.length <= 4, JSON.stringify(lines));
    // Only a page that continues may end on the mark (when it fits).
    assert.ok(lines.every((line, row) => !line.endsWith('…') || (row === lines.length - 1 && page < panels.length - 1)),
      `only the last line of a page that continues ends on the mark: ${JSON.stringify(lines)}`);
    const glass = 2 * panel.captionBacking.halfWidth;
    // A caption line that wraps fills most of the glass: the next word would
    // not have fitted.
    for (const line of lines.slice(1, -1)) {
      const width = runtime.toolbarTextWidth(line) * panel.readoutFontMeters;
      assert.ok(width >= 0.6 * glass, `${JSON.stringify(line)} fills ${(width / glass).toFixed(2)} of the card`);
    }
  }
});
