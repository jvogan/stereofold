/**
 * No shipped lesson card turns a page inside a sentence that fits a page of
 * its own.
 *
 * Every chapter of every lesson in `plugin/demos/index.json` is paged here by
 * the real pager (`createToolbarPanel` with `readoutPage`) on each card the
 * headset offers it (`menuRelocationCandidates`): the full card, the one-line
 * short card and, where offered, the short card grown by a line, at both
 * bands. A page before the last that does not end a sentence is listed. It is
 * a fault when the sentence it cuts fits whole on a page of that card: the
 * pager could have started the sentence on the next page instead. A sentence
 * longer than a page has to be cut somewhere, and is cut at a clause.
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
const words = text => text.replaceAll('…', ' ').split(/\s+/u).filter(Boolean);
const endsSentence = word => /[.!?]["'”’)]?$/u.test(word);
// A cut that is not at a sentence end is at a clause when its last word ends
// in a colon, semicolon, dash or comma, or the next word opens a clause.
const clauseCut = (last, next) => /[;:—,]["'”’)]?$/u.test(last) || /^(?:and|but|while|whereas|because|which|so)$/iu.test(next ?? '');

const lessonFiles = [...new Set(index.demos.flatMap(demo =>
  (demo.stages ?? []).map(stage => stage.lesson).concat(demo.lesson ? [demo.lesson] : [])))];

// The line the card carries: the spoken line, else the desktop caption
// (`captionLine` in `plugin/src/tour-player.ts`).
const cardLine = chapter => chapter.immersive?.narration?.trim() || chapter.caption;

function tourOptions(lesson, at, line = cardLine(lesson.chapters[at])) {
  const chapter = lesson.chapters[at];
  const tour = { active: true, autoplay: false, selectedId: lesson.id, selectedTitle: lesson.title, title: chapter.title,
    progress: `Scene ${at + 1} / ${lesson.chapters.length}`, step: at, total: lesson.chapters.length, chapterStartedAt: 0,
    bodyPage: line, bodyPageIndex: 0, bodyPageCount: 1, canBack: at > 0, canNext: at < lesson.chapters.length - 1 };
  const readout = runtime.tourReadout(tour, undefined, 0);
  return { stableLesson: true, measureText: runtime.toolbarTextWidth, head, constants: SPATIAL_TOOLBAR_LAYOUT,
    readout, status: '', assistantLines: ['No assistant'], readoutPage: 0,
    rows: spatialToolbarRows({ collapsed: true, quiet: true, voice: { state: 'idle' }, tour }) };
}

const pagesOf = (options, constants) => {
  const first = createToolbarPanel({ ...options, constants, readoutPage: 0 });
  return Array.from({ length: first.readoutPageCount }, (_, page) =>
    createToolbarPanel({ ...options, constants, readoutPage: page }).readoutPoints.map(row => row.text).slice(1));
};

// Each card size the headset offers this chapter, at the first seat of each
// band: the full card, the one-line short card and the grown short card.
function offeredCards(lesson, at) {
  const options = tourOptions(lesson, at);
  return [false, true].flatMap(shortCard => {
    const seats = menuRelocationCandidates(options, head, { cardOnly: true, shortCard });
    return ['top', 'bottom'].flatMap(band => {
      const first = seats.find(seat => seat.band === band);
      assert.ok(first, `a ${band} ${shortCard ? 'short' : 'full'} card seat is offered`);
      // The grown card shares its seat's id with the line count appended.
      return seats.filter(seat => seat.id === first.id || seat.id.startsWith(first.id) && /^\d+$/u.test(seat.id.slice(first.id.length)))
        .map(seat => ({ size: `${seat.panel.readoutLineBudget - 1}-line${shortCard ? ' short' : ''}`, band, constants: seat.constants,
          lines: seat.panel.readoutLineBudget - 1, pages: pagesOf(options, seat.constants) }));
    });
  });
}

// Whether a sentence alone is one page of this card.
function fitsOnePage(lesson, at, constants, sentence) {
  const options = tourOptions(lesson, at, sentence);
  return pagesOf(options, constants).length === 1;
}

// Every page of every offered card that stops inside a sentence.
function midSentencePages(file, lesson) {
  const found = [];
  for (const [at, chapter] of lesson.chapters.entries()) {
    const line = words(cardLine(chapter));
    const sentences = [];
    for (let start = 0, end = 0; end < line.length; end++) {
      if (endsSentence(line[end]) || end === line.length - 1) { sentences.push([start, end + 1]); start = end + 1; }
    }
    for (const card of offeredCards(lesson, at)) {
      const where = `${file} chapter ${at + 1} ${card.size} ${card.band}`;
      assert.deepEqual(words(card.pages.map(page => page.join(' ')).join(' ')), line, `${where}: the pages are the whole line`);
      for (const page of card.pages) {
        assert.ok(page.length <= card.lines, `${where}: no page is longer than the card: ${JSON.stringify(page)}`);
        if (card.pages.length > 1) assert.ok(words(page.join(' ')).length > 1, `${where}: no page is one word: ${JSON.stringify(card.pages)}`);
      }
      let read = 0;
      card.pages.forEach((page, number) => {
        read += words(page.join(' ')).length;
        if (number === card.pages.length - 1 || endsSentence(line[read - 1])) return;
        const [start, end] = sentences.find(([start, end]) => start < read && read < end);
        const sentence = line.slice(start, end).join(' ');
        found.push({ file, chapter: at + 1, size: card.size, lines: card.lines, band: card.band, page: `${number + 1}/${card.pages.length}`,
          ends: page.at(-1), clause: clauseCut(line[read - 1], line[read]),
          fits: fitsOnePage(lesson, at, card.constants, sentence), sentence });
      });
    }
  }
  return found;
}

const report = [];
for (const file of lessonFiles) {
  const lesson = JSON.parse(readFileSync(new URL(file, demosUrl), 'utf8'));
  test(`${file}: no card page ends inside a sentence that fits a page of its own`, t => {
    const found = midSentencePages(file, lesson);
    report.push(...found);
    for (const cut of found) t.diagnostic(`${cut.fits ? 'AVOIDABLE' : 'long'} ${cut.clause ? 'clause' : 'MID-CLAUSE'} ${cut.file} ch${cut.chapter} ${cut.size} ${cut.band} page ${cut.page} ends "${cut.ends}" | ${cut.sentence}`);
    const avoidable = found.filter(cut => cut.fits);
    assert.deepEqual(avoidable.map(cut => `ch${cut.chapter} ${cut.size} ${cut.band} page ${cut.page}: ${cut.ends}`), [],
      `${file}: pages that cut a sentence which fits a page of its own`);
    // A sentence longer than a page of more than one line is cut at a
    // clause. One line often holds no whole clause, so the one-line card is
    // listed above and not held to it.
    const midClause = found.filter(cut => !cut.clause && cut.lines > 1);
    assert.deepEqual(midClause.map(cut => `ch${cut.chapter} ${cut.size} ${cut.band} page ${cut.page}: ${cut.ends}`), [],
      `${file}: pages that cut a sentence inside a clause`);
  });
}

// A short whole sentence stands alone on a one-line page rather than taking
// the next sentence's first word: `Nucleases are inactive. Red…` then
// `marks mutated active-site regions.` was the page before.
test('a short sentence keeps a one-line page to itself', () => {
  const lesson = JSON.parse(readFileSync(new URL('crispr-cas9.json', demosUrl), 'utf8'));
  const at = lesson.chapters.findIndex(chapter => chapter.id === 'nucleases' || /^Nucleases are inactive\./u.test(cardLine(chapter)));
  assert.ok(at >= 0, 'the CRISPR nuclease chapter is found');
  const shorts = offeredCards(lesson, at).filter(card => card.size === '1-line short');
  assert.equal(shorts.length, 2, 'one one-line card at each band');
  for (const card of shorts) assert.deepEqual(card.pages, [['Nucleases are inactive.'], ['Red marks mutated active-site regions.']]);
});

// No pager can keep a sentence whole on a page shorter than it. These lines
// were each a sentence longer than the card a headset showed them on, and
// paged inside it: the GLUT1 opening and membrane chapters on the full card
// (`…One chain of 504 residues,…`, `…a polar transport cavity,…`) and the ATP
// rotor's full-turn chapter on the one-line card (`Back to state one:…`).
test('the lines a headset paged inside a sentence fit the card it showed them on', () => {
  const glucose = JSON.parse(readFileSync(new URL('glucose-transporter.json', demosUrl), 'utf8'));
  for (const at of [0, 1]) for (const card of offeredCards(glucose, at).filter(card => card.size === '3-line')) {
    assert.ok(card.pages.slice(0, -1).every(page => endsSentence(page.at(-1))),
      `GLUT1 chapter ${at + 1} ${card.band}: every full-card page ends a sentence: ${JSON.stringify(card.pages)}`);
  }
  const rotor = JSON.parse(readFileSync(new URL('atp-synthase-rotor/flipbook.json', demosUrl), 'utf8'));
  const turn = rotor.chapters.findIndex(chapter => chapter.id === 'full-turn');
  const shorts = offeredCards(rotor, turn).filter(card => card.size === '1-line short');
  assert.equal(shorts.length, 2, 'one one-line card at each band');
  for (const card of shorts) assert.equal(card.pages.length, 1, `full turn ${card.band}: one page on the one-line card: ${JSON.stringify(card.pages)}`);
  // The distance chapter keeps the one-line card where the card grown by a
  // line would cross a name plate, and paged `Proton exit and closed
  // catalytic…` then `site are 11 nanometres apart.` on it.
  const distance = rotor.chapters.findIndex(chapter => chapter.id === 'distance');
  for (const card of offeredCards(rotor, distance).filter(card => card.size === '1-line short'))
    assert.equal(card.pages.length, 1, `distance ${card.band}: one page on the one-line card: ${JSON.stringify(card.pages)}`);
});

test('the scan pages every chapter of every shipped lesson', t => {
  const chapters = lessonFiles.reduce((sum, file) => sum + JSON.parse(readFileSync(new URL(file, demosUrl), 'utf8')).chapters.length, 0);
  t.diagnostic(`${lessonFiles.length} lesson files, ${chapters} chapters, ${report.length} mid-sentence pages, ${report.filter(cut => cut.fits).length} avoidable`);
  assert.ok(lessonFiles.length >= 40 && chapters >= 380);
});
