import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { createToolbarPanel, SPATIAL_TOOLBAR_LAYOUT } from './spatial-toolbar-geometry.mjs';
import { spatialToolbarRows } from './spatial-toolbar-content.mjs';
import { toolbarFrameRuntime } from './fixtures/toolbar-frame-runtime.mjs';

const metrics = JSON.parse(readFileSync(new URL('./fixtures/toolbar-bold-font-metrics.json', import.meta.url)));
const runtime = await toolbarFrameRuntime(undefined, { glyphAdvances: metrics.advances });
const head = { position: { x: 0, y: 1.6, z: 0 }, matrix: [1,0,0,0,0,1,0,0,0,0,1,0,0,1.6,0,1] };
let measured = 0;
const measureText = text => { measured++; return runtime.toolbarTextWidth(text); };
function draw(caption, page = 0, stableLesson = true) {
  const tour = { active: true, selectedId: 'custom', step: 0, total: 5, canNext: true,
    title: 'EB3 arrives', progress: 'Tip 1 / 5', bodyPage: caption, bodyPageCount: 1 };
  return createToolbarPanel({ head, stableLesson, constants: SPATIAL_TOOLBAR_LAYOUT,
    rows: spatialToolbarRows({ collapsed: true, quiet: true, voice: { state: 'idle' }, tour }),
    readout: runtime.tourReadout(tour), readoutPage: page, measureText,
    assistantLines: ['No assistant connected'] });
}
const body = panel => panel.readoutPoints.slice(1).map(row => row.text.replace(/…$/u, '')).join(' ');
const pages = caption => Array.from({ length: draw(caption).readoutPageCount }, (_, i) => draw(caption, i));

test('a two-line lesson caption stays on one page at the original text size', () => {
  for (const caption of ['Green is EB3, landed on the outside of the lattice.',
    'Green is EB3, landed on the outside of the lattice. New tubulin pairs extend the tip.']) {
    const original = draw(caption, 0, false), panel = draw(caption);
    assert.equal(original.readoutPageCount, 1);
    assert.equal(panel.readoutPageCount, 1);
    assert.equal(body(panel), caption);
    assert.equal(panel.readoutFontMeters, original.readoutFontMeters);
    assert.equal(panel.buttons.length, 4);
    assert.equal(panel.statusPoints.length, 1);
    if (caption.includes('New tubulin')) assert.equal(panel.readoutPoints.length, 3, 'title plus two caption lines');
  }
});

test('a long lesson caption never strands its last word or a short tail on a page', () => {
  const caption = 'Green is EB3, landed on the outside of the lattice. The growing end adds new tubulin pairs, while EB3 follows the fresh lattice. It grows.';
  const panels = pages(caption), text = panels.map(body);
  assert.ok(panels.length > 1, 'the caption really exceeds the glass');
  assert.equal(text.join(' '), caption);
  for (const page of text) assert.ok(page.split(/\s+/u).length >= 4, `orphan page: ${page}`);
  for (const page of text.slice(0, -1)) assert.match(page, /[.!?;:,]$/u, `mid-clause page: ${page}`);
  for (const panel of panels) {
    assert.equal(panel.readoutFontMeters, draw(caption, 0, false).readoutFontMeters);
    assert.ok(panel.readoutPoints.length <= panel.readoutLineBudget);
  }
});

test('complete sentences take precedence over packing pages with half-sentences', () => {
  const sentence = 'Green EB3 marks the lattice outside the growing end of the microtubule.';
  const caption = [sentence, sentence, sentence].join(' ');
  const text = pages(caption).map(body);
  assert.equal(text.join(' '), caption);
  assert.ok(text.length > 1);
  for (const page of text) assert.ok(page.endsWith('.'), `mid-sentence page: ${page}`);
});

test('every shipped caption that fit the original card still fits one lesson page', () => {
  const root = new URL('../../plugin/demos/', import.meta.url);
  let captions = 0, paged = 0;
  for (const file of readdirSync(root, { recursive: true }).filter(file => file.endsWith('.json'))) {
    const lesson = JSON.parse(readFileSync(new URL(file, root)));
    for (const chapter of lesson.chapters ?? []) {
      const caption = chapter.immersive?.narration?.trim() || chapter.caption;
      if (!caption) continue;
      captions++;
      const original = draw(caption, 0, false), panel = draw(caption);
      const label = `${file} / ${chapter.id}`;
      assert.equal(panel.readoutFontMeters, original.readoutFontMeters, label);
      if (original.readoutPageCount === 1) assert.equal(panel.readoutPageCount, 1, label);
      const text = pages(caption).map(body);
      assert.equal(text.join(' ').replace(/\s/gu, ''), caption.replace(/\s/gu, ''), label);
      if (text.length > 1) {
        paged++;
        for (const page of text) assert.ok(page.split(/\s+/u).length >= 4, `${label}: ${page}`);
      }
    }
  }
  assert.ok(captions > 100 && paged > 0, `${captions} captions, ${paged} paged`);
});

test('a page breaks at its strongest punctuation and ends a finished sentence without a mark', () => {
  // A shipped caption. Its list holds an `and` that joins two nouns, and
  // the break belongs at the colon before the list.
  const caption = 'Inside, every dimer holds the same bound molecules: GTP and magnesium in the alpha subunit, GDP in the beta subunit, and Taxol on beta.';
  const panels = pages(caption);
  assert.equal(panels.length, 2);
  assert.equal(panels[0].readoutPoints.at(-1).text, 'molecules:…');
  assert.equal(body(panels[1]), 'GTP and magnesium in the alpha subunit, GDP in the beta subunit, and Taxol on beta.');
  const sentences = pages('Human mitochondrial ATP synthase, entry 8H9V, at 3.02 Angstrom. Sixteen different proteins in one machine: a catalytic head, a membrane motor, and a stalk between them.');
  assert.equal(sentences.length, 2);
  assert.equal(sentences[0].readoutPoints.at(-1).text, '8H9V, at 3.02 Angstrom.');
});

test('a long caption is paged without measuring every candidate page', () => {
  // The panel is rebuilt by clearance solves, so its paging stays linear in
  // the words: each word is measured once, then each chosen page is wrapped.
  const caption = 'Green is EB3, landed on the outside of the lattice. The growing end adds new tubulin pairs, while EB3 follows the fresh lattice. It grows. '.repeat(3).trim();
  measured = 0;
  assert.ok(draw(caption).readoutPageCount > 2);
  assert.ok(measured < 10 * caption.split(' ').length, `${measured} measurements`);
});
