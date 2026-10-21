/**
 * A chapter card reads `Title · 1/5` over three lines of caption, and turns
 * its own pages.
 *
 * On the headset each page showed the title, `Scene 1 / 5` and a single
 * caption line ending in an ellipsis. The page row that turns it is on the
 * expanded menu only, and a chapter held by the wearer never turned at all.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { toolbarFrameRuntime, toolbarFrameHarness } from './fixtures/toolbar-frame-runtime.mjs';
import { createToolbarPanel, SPATIAL_TOOLBAR_LAYOUT } from './spatial-toolbar-geometry.mjs';
import { spatialToolbarRows } from './spatial-toolbar-content.mjs';

const metrics = JSON.parse(readFileSync(new URL('./fixtures/toolbar-bold-font-metrics.json', import.meta.url), 'utf8'));
const runtime = await toolbarFrameRuntime(new URL('./', import.meta.url), { glyphAdvances: metrics.advances });
const head = { position: { x: 0, y: 1.6, z: 0 }, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1.6, 0, 1] };
const words = text => text.replaceAll('…', ' ').split(/\s+/u).filter(Boolean);
const lesson = JSON.parse(readFileSync(new URL('../../plugin/demos/atp-synthase.json', import.meta.url), 'utf8'));
const chapterTour = (index, extra = {}) => {
  const chapter = lesson.chapters[index];
  return { active: true, autoplay: false, selectedId: lesson.id, selectedTitle: lesson.title, title: chapter.title,
    progress: `Scene ${index + 1} / ${lesson.chapters.length}`, step: index, total: lesson.chapters.length, chapterStartedAt: 0,
    bodyPage: chapter.immersive?.narration ?? chapter.caption, bodyPageIndex: 0, bodyPageCount: 1, ...extra };
};

test('the title and the scene counter share the first line', () => {
  const readout = runtime.tourReadout(chapterTour(0), undefined, 0);
  assert.equal(readout[0].text, `${lesson.chapters[0].title} · 1/${lesson.chapters.length}`);
  assert.ok(!readout.some(line => /Scene \d/u.test(line.text)), 'no separate scene line');
});

for (const [index, chapter] of lesson.chapters.entries()) test(`chapter ${index + 1} pages hold three caption lines under the title line`, () => {
  const tour = chapterTour(index);
  const readout = runtime.tourReadout(tour, undefined, 0);
  const options = { measureText: runtime.toolbarTextWidth, head, constants: SPATIAL_TOOLBAR_LAYOUT, readout, readoutPage: 0,
    rows: spatialToolbarRows({ collapsed: true, quiet: true, voice: { state: 'idle' }, tour: { ...tour, canNext: true } }) };
  const first = createToolbarPanel(options);
  assert.equal(first.readoutLineBudget, 4);
  assert.ok(first.readoutWrapWidth >= 40, `about 45 characters a line, not ${first.readoutWrapWidth}`);
  const pages = Array.from({ length: first.readoutPageCount }, (_, page) =>
    createToolbarPanel({ ...options, readoutPage: page }).readoutPoints.map(line => line.text));
  for (const page of pages) {
    assert.equal(page[0], readout[0].text, 'the title line heads every page');
    assert.ok(page.length >= 2 && page.length <= 4, `one title line and up to three caption lines: ${JSON.stringify(page)}`);
  }
  // A page of one caption line holds a whole sentence, never a fragment.
  if (pages.length > 1) assert.ok(pages.slice(0, -1).every(page => page.length >= 3 || /[.!?]$/u.test(page[1])),
    `a page is not left with one stranded line: ${JSON.stringify(pages)}`);
  assert.deepEqual(words(pages.map(page => page.slice(1).join(' ')).join(' ')), words(chapter.immersive?.narration ?? chapter.caption),
    'the pages joined are the whole caption');
});

test('a held chapter turns its own pages every seven seconds and loops', async () => {
  let clock = 0;
  const long = lesson.chapters.map(chapter => chapter.immersive?.narration ?? chapter.caption).join(' ');
  const tour = chapterTour(0, { bodyPage: long });
  const f = toolbarFrameHarness(runtime, { state: { tour, voice: { state: 'idle' } }, now: () => clock });
  try {
    await f.toolbar.update();
    const pages = f.toolbar.readout().cardPageCount;
    assert.ok(pages > 1, 'the fixture caption needs more than one page');
    const seen = [];
    for (let turn = 0; turn <= pages; turn++) {
      seen.push(f.toolbar.readout().cardPageIndex);
      f.toolbar.syncPose(); clock += 6_999; f.toolbar.syncPose();
      assert.equal(f.toolbar.readout().cardPageIndex, seen.at(-1), 'a page stands for its full seven seconds');
      clock += 1; f.toolbar.syncPose();
      for (let i = 0; i < 400; i++) await Promise.resolve();
    }
    assert.deepEqual(seen, [...Array.from({ length: pages }, (_, page) => page), 0], 'every page in turn, then the first again');
  } finally { await f.toolbar.dispose(); }
});

// Autoplay asks the card how long it still needs, so a chapter never moves
// on before the wearer has had its last page for seven seconds.
test('the card owes reading time until its last page has stood seven seconds', async () => {
  let clock = 0;
  const long = lesson.chapters.map(chapter => chapter.immersive?.narration ?? chapter.caption).join(' ');
  const f = toolbarFrameHarness(runtime, { state: { tour: chapterTour(0, { bodyPage: long }), voice: { state: 'idle' } }, now: () => clock });
  try {
    await f.toolbar.update();
    const pages = f.toolbar.readout().cardPageCount;
    assert.ok(pages > 1, 'the fixture caption needs more than one page');
    f.toolbar.syncPose();
    assert.equal(f.toolbar.readout().cardHoldMs, pages * 7_000, 'every page still to read');
    for (let page = 0; page < pages; page++) {
      clock += 3_000; f.toolbar.syncPose();
      assert.equal(f.toolbar.readout().cardHoldMs, (pages - page) * 7_000 - 3_000);
      clock += 4_000; f.toolbar.syncPose();
      for (let i = 0; i < 400; i++) await Promise.resolve();
      f.toolbar.syncPose();
    }
    assert.equal(f.toolbar.readout().cardHoldMs, 0, 'the last page has stood its seven seconds');
    clock += 3_000; f.toolbar.syncPose();
    assert.equal(f.toolbar.readout().cardHoldMs, 0, 'and the looping card owes nothing more');
  } finally { await f.toolbar.dispose(); }
});

test('a one-page card owes its seven seconds too', async () => {
  let clock = 0;
  const f = toolbarFrameHarness(runtime, { state: { tour: chapterTour(1, { bodyPage: 'One short line.' }), voice: { state: 'idle' } }, now: () => clock });
  try {
    await f.toolbar.update();
    assert.equal(f.toolbar.readout().cardPageCount, 1);
    f.toolbar.syncPose();
    clock += 5_000; f.toolbar.syncPose();
    assert.equal(f.toolbar.readout().cardHoldMs, 2_000);
    clock += 2_000; f.toolbar.syncPose();
    assert.equal(f.toolbar.readout().cardHoldMs, 0);
  } finally { await f.toolbar.dispose(); }
});

test('restarting the same three-page chapter resets reading, page and frame time', async () => {
  let clock = 0;
  const tour = chapterTour(0, {bodyPage: lesson.chapters.slice(0,2).map(chapter=>chapter.immersive?.narration ?? chapter.caption).join(' ')});
  const f = toolbarFrameHarness(runtime, { state:{tour,voice:{state:'idle'}}, now:()=>clock });
  try {
    await f.toolbar.update(); f.toolbar.syncPose();
    assert.equal(f.toolbar.readout().cardPageCount,3);
    for (let page=0; page<3; page++) {
      clock+=7000; f.toolbar.syncPose();
      for(let i=0;i<400;i++) await Promise.resolve();
      f.toolbar.syncPose();
    }
    assert.equal(f.toolbar.readout().cardHoldMs,0);
    clock+=3000;
    f.setState({tour:{...tour,chapterStartedAt:clock},voice:{state:'idle'}});
    await f.toolbar.update(); f.toolbar.syncPose();
    assert.equal(f.toolbar.readout().cardPageIndex,0);
    assert.equal(f.toolbar.readout().cardHoldMs,21000);
    clock+=1000; f.toolbar.syncPose(); await f.toolbar.update();
    assert.equal(f.toolbar.readout().cardHoldMs,20000,'status redraw does not reset reading');
  } finally {await f.toolbar.dispose();}
});
