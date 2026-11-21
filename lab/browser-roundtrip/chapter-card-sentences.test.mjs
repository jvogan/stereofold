/**
 * Every chapter line of the animated demos can be read in whole sentences on
 * the lesson card a chapter is given.
 *
 * A lesson chapter gets the full card (its title over three caption lines)
 * where one clears, and otherwise keeps a short card, which covers less of
 * the molecule. The short card was only ever the title over one caption
 * line, and most chapter lines run longer than one card line: kinesin's
 * first chapter read `Pink and green heads trade…` on one page and `the
 * lead, hand over hand.` on the next. Each seat whose one-line card splits
 * a sentence also offers the card grown to two caption lines, and the
 * kept-card rank prefers the one that keeps it whole
 * (`kept-card-order.test.mjs`).
 *
 * Which card a chapter gets depends on the room and the head, so each line
 * is paged here on every card size the product offers, at both bands,
 * through its own seats (`menuRelocationCandidates`) and the real pager.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { toolbarFrameRuntime } from './fixtures/toolbar-frame-runtime.mjs';
import { createToolbarPanel, SPATIAL_TOOLBAR_LAYOUT } from './spatial-toolbar-geometry.mjs';
import { spatialToolbarRows } from './spatial-toolbar-content.mjs';
import { menuRelocationCandidates } from './menu-relocation.mjs';

const metrics = JSON.parse(readFileSync(new URL('./fixtures/toolbar-bold-font-metrics.json', import.meta.url), 'utf8'));
const runtime = await toolbarFrameRuntime(new URL('./', import.meta.url), { glyphAdvances: metrics.advances });
const head = { position: { x: 0, y: 1.6, z: 0 }, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1.6, 0, 1] };
const demosUrl = new URL('../../plugin/demos/', import.meta.url);
const index = JSON.parse(readFileSync(new URL('index.json', demosUrl), 'utf8'));
const ANIMATED = ['kinesin-walk', 'daraxonrasib-assembly', 'hemoglobin-switch', 'atp-synthase-rotor', 'microtubule-growth', 'microtubule-arrival'];
const words = text => text.replaceAll('…', ' ').split(/\s+/u).filter(Boolean);
const sentenceEnd = /[.!?]["'”’)]?$/u;

const lessons = ANIMATED.flatMap(name => {
  const demo = index.demos.find(entry => entry.name === name);
  assert.ok(demo, `${name} is in the demo index`);
  const files = [...new Set((demo.stages ?? []).map(stage => stage.lesson).concat(demo.lesson ? [demo.lesson] : []))];
  return files.map(file => ({ name, file, lesson: JSON.parse(readFileSync(new URL(file, demosUrl), 'utf8')) }));
});

// The line the plate carries: the spoken line, else the desktop caption
// (`captionLine` in `plugin/src/tour-player.ts`).
const cardLine = chapter => chapter.immersive?.narration?.trim() || chapter.caption;

// Every card size the product offers this chapter at the first seat of each
// band: the full card, the one-line short card and, where offered, the short
// card grown to keep its sentences whole. Each with all of its pages.
function cards(lesson, index) {
  const chapter = lesson.chapters[index];
  const tour = { active: true, autoplay: false, selectedId: lesson.id, selectedTitle: lesson.title, title: chapter.title,
    progress: `Scene ${index + 1} / ${lesson.chapters.length}`, step: index, total: lesson.chapters.length, chapterStartedAt: 0,
    bodyPage: cardLine(chapter), bodyPageIndex: 0, bodyPageCount: 1, canBack: index > 0, canNext: index < lesson.chapters.length - 1 };
  const readout = runtime.tourReadout(tour, undefined, 0);
  const options = { stableLesson: true, measureText: runtime.toolbarTextWidth, head, constants: SPATIAL_TOOLBAR_LAYOUT,
    readout, status: '', assistantLines: ['No assistant'], readoutPage: 0,
    rows: spatialToolbarRows({ collapsed: true, quiet: true, voice: { state: 'idle' }, tour }) };
  return [false, true].flatMap(shortCard => {
    const seats = menuRelocationCandidates(options, head, { cardOnly: true, shortCard });
    return ['top', 'bottom'].flatMap(band => {
      const first = seats.find(seat => seat.band === band);
      assert.ok(first, `a ${band} ${shortCard ? 'short' : 'full'} card seat is offered`);
      // The grown card shares its seat's id with the line count appended.
      return seats.filter(seat => seat.id === first.id || seat.id.startsWith(first.id) && /\d$/u.test(seat.id.slice(first.id.length)))
        .map(seat => ({ id: seat.id, shortCard, band, seat, panel: seat.panel, title: readout[0].text,
          pages: Array.from({ length: seat.panel.readoutPageCount }, (_, page) =>
            createToolbarPanel({ ...options, constants: seat.constants, readoutPage: page }).readoutPoints.map(line => line.text)) }));
    });
  });
}
const splits = pages => pages.slice(0, -1).some(page => !sentenceEnd.test(page.at(-1)));

for (const { name, file, lesson } of lessons) for (const [index, chapter] of lesson.chapters.entries()) {
  test(`${file} chapter ${index + 1} reads in whole sentences on the card it is given`, () => {
    const line = cardLine(chapter);
    const offered = cards(lesson, index);
    for (const { id, pages, title, seat } of offered) {
      assert.ok(title.startsWith(chapter.title), `${id}: the card is titled ${chapter.title}`);
      for (const page of pages) assert.equal(page[0], title, `${id}: the title line heads every page`);
      assert.deepEqual(words(pages.map(page => page.slice(1).join(' ')).join(' ')), words(line), `${id}: the pages joined are the whole line`);
      // The rank reads this flag, so it has to say what the pages do.
      assert.equal(seat.splitsSentence === true, splits(pages), `${id}: the seat says whether it splits a sentence`);
    }
    for (const band of ['top', 'bottom']) {
      const full = offered.find(card => card.band === band && !card.shortCard);
      const shorts = offered.filter(card => card.band === band && card.shortCard);
      const whole = shorts.find(card => !card.seat.splitsSentence);
      assert.ok(!full.seat.splitsSentence, `${name} ${band} full card ends a page inside a sentence: ${JSON.stringify(full.pages)}`);
      assert.ok(whole, `${name} ${band}: no short card keeps the sentences whole: ${JSON.stringify(shorts.map(card => card.pages.map(page => page.slice(1))))}`);
      // The short card is there to cover less, so it is never the taller one.
      assert.ok(whole.panel.captionBacking.halfHeight <= full.panel.captionBacking.halfHeight + 1e-9, `${band}: the short card is no taller than the full card`);
      // A one-line card that reads whole is the only short card offered.
      if (!shorts[0].seat.splitsSentence) assert.equal(shorts.length, 1, `${band}: no grown card where one line reads whole`);
    }
  });
}

// Kinesin's line now fits one card line; the title carries `hand over hand`.
test('kinesin chapter 1 reads whole on the one-line short card', () => {
  const { lesson } = lessons.find(entry => entry.file === 'kinesin-walk/motion.json');
  const shorts = cards(lesson, 0).filter(card => card.shortCard);
  assert.equal(shorts.length, 2, 'one short card at each band');
  for (const card of shorts) {
    assert.equal(card.panel.readoutLineBudget, 2, `${card.id}: the title over one line`);
    assert.deepEqual(card.pages.map(page => page.slice(1)), [['Pink and green heads trade the lead.']]);
  }
});

// The ATP rotor's whole-enzyme line kept a one-line bottom card on the
// headset, which pages it as `Bacterial ATP synthase: catalytic head…`, then
// `on top, membrane ring below.`
test('a line longer than one card line reads whole on the grown short card', () => {
  const { lesson } = lessons.find(entry => entry.file === 'atp-synthase-rotor/motion.json');
  const shorts = cards(lesson, lesson.chapters.findIndex(chapter => chapter.id === 'machine')).filter(card => card.shortCard);
  for (const band of ['top', 'bottom']) {
    const [one, grown, ...rest] = shorts.filter(card => card.band === band);
    assert.equal(rest.length, 0);
    assert.ok(one.seat.splitsSentence && one.pages.length === 2, `${band}: one line pages the sentence in two`);
    assert.ok(grown && !grown.seat.splitsSentence, `${band}: the grown card is offered`);
    assert.equal(grown.panel.readoutLineBudget, 3, `${band}: the title over two lines`);
    assert.deepEqual(grown.pages.map(page => page.slice(1).join(' ')), ['Bacterial ATP synthase: catalytic head on top, membrane ring below.']);
  }
});

// The ATP rotor's distance chapter was a reason the short card beats a full
// card that covers more: it keeps the one-line card.
test('a line that fits one card line keeps the one-line short card', () => {
  const { lesson } = lessons.find(entry => entry.file === 'atp-synthase-rotor/motion.json');
  for (const id of ['distance']) {
    const at = lesson.chapters.findIndex(chapter => chapter.id === id);
    assert.ok(at >= 0, `the ATP ${id} chapter is found`);
    const shorts = cards(lesson, at).filter(card => card.shortCard);
    assert.equal(shorts.length, 2, `${id}: one short card at each band`);
    for (const card of shorts) {
      assert.equal(card.panel.readoutLineBudget, 2, `${id} ${card.id} stays the title over one line`);
      assert.equal(card.pages.length, 1);
    }
  }
});

// Sentences that each fit one line page one sentence at a time rather
// than growing the card.
test('a line of short sentences pages one sentence a page on the one-line card', () => {
  for (const [file, id, sentences] of [
    ['atp-synthase-rotor/motion.json', 'rotor', ['The rotor turns counterclockwise.', 'Steps are idealized, so parts overlap.']],
  ]) {
    const { lesson } = lessons.find(entry => entry.file === file);
    const shorts = cards(lesson, lesson.chapters.findIndex(chapter => chapter.id === id)).filter(card => card.shortCard && card.band === 'top');
    assert.equal(shorts.length, 1, `${id}: one short card`);
    assert.equal(shorts[0].panel.readoutLineBudget, 2);
    assert.deepEqual(shorts[0].pages.map(page => page.slice(1)), sentences.map(sentence => [sentence]));
  }
});

// Each card page stands seven seconds, so a line paged in three holds its
// chapter for twenty-one seconds whatever the chapter's duration. The
// assembly clip lasts nine, and the contacts follow it.
test('the daraxonrasib assembly line reads on one page of every card that keeps it whole', () => {
  const { lesson } = lessons.find(entry => entry.file === 'daraxonrasib-assembly/motion.json');
  const at = lesson.chapters.findIndex(chapter => chapter.id === 'assemble');
  const whole = cards(lesson, at).filter(card => !card.seat.splitsSentence);
  assert.ok(whole.some(card => card.shortCard) && whole.some(card => !card.shortCard), 'a full and a short card keep it whole');
  for (const card of whole) assert.equal(card.pages.length, 1, `${card.id}: ${JSON.stringify(card.pages)}`);
});
