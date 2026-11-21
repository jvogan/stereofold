/**
 * A chapter card names only controls the wearer can reach from that chapter,
 * by the path they take.
 *
 * During a lesson chapter the menu is the quiet set: Talk, Play or Pause,
 * Next or Done, and Menu. Everything else is on the grid that Menu opens, and
 * during a chapter that grid folds away again when no seat keeps it off the
 * molecule. The daraxonrasib scale chapter said "Choose Above us" while the
 * wearer saw only Talk, Play, Done and Menu, so the chapter meant to show
 * scale showed none. A grid row is therefore named only on the last chapter,
 * after the lesson ends: `Done, then Menu, then Above us`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { spatialToolbarRows } from './spatial-toolbar-content.mjs';

const demosUrl = new URL('../../plugin/demos/', import.meta.url);
const index = JSON.parse(readFileSync(new URL('index.json', demosUrl), 'utf8'));
const ANIMATED = ['kinesin-walk', 'daraxonrasib-assembly', 'hemoglobin-switch', 'atp-synthase-rotor', 'microtubule-growth', 'microtubule-arrival'];
const cardLine = chapter => chapter.immersive?.narration?.trim() || chapter.caption;

// The rows a lesson chapter shows, mid-lesson or on its last chapter, and the
// grid Menu opens once the lesson has ended.
const labels = (form, tours) => new Set(tours.flatMap(tour => spatialToolbarRows({ ...form, voice: { state: 'idle' }, tour }).map(row => row.label)));
const chapterTour = (canNext, autoplay) => ({ active: true, autoplay, selectedId: 'lesson', step: 1, total: 3, canBack: true, canNext, bodyPageCount: 1 });
const quiet = last => labels({ collapsed: true, quiet: true }, [false, true].map(autoplay => chapterTour(!last, autoplay)));
const afterDone = labels({ collapsed: false, quiet: false }, [{ active: false, autoplay: false, selectedId: 'lesson', step: 2, total: 3 }]);

// A control named after an instruction verb, and one reached through Done and Menu.
const named = /\b(?:[Cc]hoose|[Pp]ress|[Tt]ap|[Uu]se|[Ss]elect)\s+(?:the\s+)?([A-Z][^,.;]*?)(?=\s+(?:and|to|when|after|for|then|row|button)\b|[,.;]|$)/gu;
const throughMenu = /\b(Done, then )?Menu, then\s+([A-Z][^,.;]*?)(?=\s+(?:and|to|when|after|for|row|button)\b|[,.;]|$)/gu;

function problems(line, last) {
  const found = [], rows = quiet(last);
  for (const [, done, name] of line.matchAll(throughMenu)) {
    if (!done || !last) found.push(`${name} is on the grid, which folds away during a chapter: name it on the last chapter as "Done, then Menu, then ${name}"`);
    else if (!afterDone.has(name)) found.push(`${name} is not on the grid Menu opens after the lesson`);
  }
  for (const [, name] of line.matchAll(named)) {
    if (rows.has(name)) continue;
    found.push(afterDone.has(name) ? `${name} is not on the lesson menu` : `${name} is not a menu control`);
  }
  return found;
}

test('the lesson menu, and the grid after Done, are what the cards are checked against', () => {
  assert.deepEqual([...quiet(false)].sort(), ['Menu', 'Next', 'Pause', 'Play', 'Talk']);
  assert.deepEqual([...quiet(true)].sort(), ['Done', 'Menu', 'Pause', 'Play', 'Talk']);
  assert.ok(afterDone.has('Above us') && afterDone.has('In reach'));
  assert.deepEqual(problems('Choose Above us and walk under the seam.', true), ['Above us is not on the lesson menu']);
  assert.equal(problems('Choose Menu, then Above us, and walk under the seam.', true).length, 1);
  assert.ok(problems('Choose Done, then Menu, then Above us.', false).length > 0, 'Done is only on the last chapter');
  assert.deepEqual(problems('When the tube settles, choose Done, then Menu, then Above us.', true), []);
  assert.deepEqual(problems('Press Overhead to lift it.', false), ['Overhead is not a menu control']);
  assert.deepEqual(problems('Hold a grip and push the stick forward to enlarge them.', true), []);
});

for (const name of ANIMATED) {
  const demo = index.demos.find(entry => entry.name === name);
  const files = [...new Set((demo.stages ?? []).map(stage => stage.lesson).concat(demo.lesson ? [demo.lesson] : []))];
  for (const file of files) test(`${file}: every card names reachable controls by their path`, () => {
    const lesson = JSON.parse(readFileSync(new URL(file, demosUrl), 'utf8'));
    const found = lesson.chapters.flatMap((chapter, at) =>
      problems(cardLine(chapter), at === lesson.chapters.length - 1).map(problem => `chapter ${at + 1}: ${problem}`));
    assert.deepEqual(found, []);
  });
}
