/**
 * A chapter card never runs past the top or bottom of the view, and what it
 * cannot hold at once it shows in pages that carry every word.
 *
 * Telomerase and daraxonrasib hide their chapter card during playback. Their
 * resting structure readout still has a long title page and four facts. At the entry
 * seat that card is fitted for a glance and reaches 57 degrees up in the
 * forward view, so the chapter menu has to move to a seat the wearer can see
 * without turning. Every such seat used to fail the view band
 * (`menuSeatWithinView`) by its card or the assistant card beside it, and the
 * menu hid for the whole chapter.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { toolbarFrameRuntime } from './fixtures/toolbar-frame-runtime.mjs';
import { createToolbarPanel, SPATIAL_TOOLBAR_LAYOUT, toolbarCaptionPoints, toolbarPlatePoints, VIEW_BAND } from './spatial-toolbar-geometry.mjs';
import { spatialToolbarRows } from './spatial-toolbar-content.mjs';
import { menuSeatWithinGlance, menuSeatWithinView } from './menu-view-band.mjs';
import { menuRelocationCandidates } from './menu-relocation.mjs';

const metrics = JSON.parse(readFileSync(new URL('./fixtures/toolbar-bold-font-metrics.json', import.meta.url), 'utf8'));
const runtime = await toolbarFrameRuntime(new URL('./', import.meta.url), { glyphAdvances: metrics.advances });
const head = { position: { x: 0, y: 1.6, z: 0 }, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1.6, 0, 1] };
// What the loaded entries report: the readout is built from these, not from the lesson.
const subjects = {
  'telomerase-haca': { pdbId: '8OUE', chains: 10, assembly: 'asymmetric_unit', representation: 'cartoon',
    color: 'chain-id', selectionCount: 0, emphasisCount: 10, contextOpacity: 0.35,
    title: 'The H/ACA RNP lobe of human telomerase with the dyskerin thumb loop in a semi-closed conformation' },
  daraxonrasib: { pdbId: '9AX6', chains: 3, assembly: '1', representation: 'cartoon', color: 'chain-id',
    selectionCount: 0, emphasisCount: 3, contextOpacity: 0.35, title: 'Tricomplex of RMC-6236, KRAS G12D, and CypA' },
};
// The wearer reads words, so compare words: a break may take a ` · `
// separator or a continuation mark with it, and may fall after a hyphen.
const words = text => text.replaceAll('…', ' ').replace(/([/-]) /gu, '$1').split(/\s+/u).filter(word => word && word !== '·');

for (const [id, subject] of Object.entries(subjects)) {
  const lesson = JSON.parse(readFileSync(new URL(`../../plugin/demos/${id}.json`, import.meta.url), 'utf8'));
  const chapter = lesson.chapters[0];
  const tour = { active: true, selectedId: lesson.id, selectedTitle: lesson.title, title: chapter.title,
    progress: `Scene 1 / ${lesson.chapters.length}`, step: 0, total: lesson.chapters.length,
    bodyPage: chapter.immersive?.narration ?? chapter.caption, bodyPageIndex: 0, bodyPageCount: 1, chapterStartedAt: 0,
    ...(lesson.presentation?.captionCard ? { captionCard: lesson.presentation.captionCard } : {}) };
  test(`${id}: the authored hidden card adds no caption glass during playback`, () => {
    const readout = runtime.tourReadout(tour, subject, 60_000);
    assert.deepEqual(readout, []);
    const panel = createToolbarPanel({ head, rows: spatialToolbarRows({ collapsed: true, tour }), readout });
    assert.equal(panel.captionBacking, undefined);
    assert.deepEqual(panel.readoutPoints, []);
  });
  // Keep exercising the same long source titles where they belong: after
  // the lesson, rather than replacing a card the author explicitly hid.
  const readout = runtime.tourReadout({ ...tour, active: false }, subject, 60_000);
  const rows = spatialToolbarRows({ collapsed: true, quiet: true, voice: { state: 'idle' }, tour: { ...tour, canNext: true } });

  for (const assistantLines of [[], ['No assistant connected', 'Hold A or X to talk', 'No action applied yet']]) {
    const label = `${id}${assistantLines.length ? ' with the assistant card' : ''}`;
    const options = { measureText: runtime.toolbarTextWidth, rows, head, constants: SPATIAL_TOOLBAR_LAYOUT,
      readout, status: '', assistantLines, readoutPage: 0 };

    test(`${label}: chapter 1 keeps its card inside the forward view at the entry seat`, () => {
      // The entry card is fitted for a glance, but the wearer also sees it
      // from the forward gaze, where the same rise is steeper: the 8-line
      // card reached 57 degrees up and the menu left for another seat.
      const entry = createToolbarPanel(options);
      // The chapter card alone: the assistant card below the menu is its own glass.
      const card = toolbarCaptionPoints({ ...entry, statusBacking: undefined, assistantFontMeters: undefined });
      assert.ok(card.length > 0);
      assert.equal(entry.captionBacking.point[0], 0, 'centered above the molecule');
      assert.ok(entry.captionBacking.point[1] > head.position.y);
      assert.ok(entry.readoutWrapWidth >= 30 && entry.readoutWrapWidth <= 45);
      // A title line and three caption lines; a hidden card's structure
      // readout keeps three.
      assert.equal(entry.readoutLineBudget, tour.captionCard === 'hidden' ? 3 : 4);
      assert.equal(entry.readoutFontMeters, entry.fontMeters);
      for (const [, y, z] of card) {
        assert.ok(Math.abs(y - head.position.y) <= VIEW_BAND.vertical * -z + 1e-9,
          `card corner ${Math.round(Math.atan2(y - head.position.y, -z) * 180 / Math.PI)} degrees off the forward view`);
      }
      assert.ok(menuSeatWithinView(toolbarPlatePoints(entry), head), 'the entry seat is admitted');
    });

    test(`${label}: chapter 1 is never drawn with its card past the view at an alternate seat`, () => {
      // Where the entry seat cannot be used, the menu moves to an alternate
      // seat, so every one of those keeps the whole panel inside the view band.
      for (const side of [-1, 1]) for (const lift of [0, .15, -.15, .3, -.3]) {
        const constants = { ...options.constants, peripheralSeat: false,
          rightMeters: side * Math.abs(options.constants.rightMeters), lowerMeters: options.constants.lowerMeters - lift };
        const panel = createToolbarPanel({ ...options, constants });
        // Status may leave the lower lens at a lowered column. The same
        // seat without it still holds the complete card and menu.
        assert.ok(menuSeatWithinView(toolbarPlatePoints({ ...panel, statusBacking: undefined,
          statusPoints: [], statusPoint: panel.buttons[0].point }), head),
          `the ${side < 0 ? 'left' : 'right'} seat raised ${lift} m keeps card and menu inside`);
      }
      const candidates = menuRelocationCandidates(options, head);
      assert.ok(candidates.length >= 12, 'alternate seats remain with status folded or off');
      for (const seat of candidates) assert.ok(menuSeatWithinView(seat.points, head), `${seat.id} is whole in both eyes`);
    });

    test(`${label}: every seat's card pages carry the whole readout, at word boundaries`, () => {
      const seats = [options.constants, ...menuRelocationCandidates(options, head).map(candidate => candidate.constants)];
      for (const [index, constants] of seats.entries()) {
        const first = createToolbarPanel({ ...options, constants });
        const pages = Array.from({ length: first.readoutPageCount }, (_, page) =>
          createToolbarPanel({ ...options, constants, readoutPage: page }).readoutPoints.map(line => line.text));
        assert.ok(pages.every(page => page.length > 0 && page.length <= first.readoutLineBudget),
          `seat ${index}: no page is empty or taller than the glass`);
        assert.deepEqual(words(pages.flat().join(' ')), words(readout.map(line => line.text).join(' ')),
          `seat ${index}: the pages joined are the readout`);
      }
    });
  }
}
