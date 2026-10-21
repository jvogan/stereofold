/**
 * No seat is admitted where one glass plate covers another in either eye.
 *
 * Telomerase chapter 4 hides its chapter card, and its large subject left
 * only a compact corner seat: the Menu control was drawn over the narrow side
 * card, and its status plate, which rides with the control, over both.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { toolbarFrameRuntime } from './fixtures/toolbar-frame-runtime.mjs';
import { SPATIAL_TOOLBAR_LAYOUT } from './spatial-toolbar-geometry.mjs';
import { spatialToolbarRows } from './spatial-toolbar-content.mjs';
import { menuRelocationCandidates } from './menu-relocation.mjs';
import { glassPlatesOverlap, seatEyeViews } from './glass-overlap.mjs';

const metrics = JSON.parse(readFileSync(new URL('./fixtures/toolbar-bold-font-metrics.json', import.meta.url), 'utf8'));
const runtime = await toolbarFrameRuntime(new URL('./', import.meta.url), { glyphAdvances: metrics.advances });
const head = { position: { x: 0, y: 1.6, z: 0 }, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1.6, 0, 1] };
const quad = (x, y, z, half) => [[x - half, y - half, z], [x + half, y - half, z], [x + half, y + half, z], [x - half, y + half, z]];

test('two plates overlap when either eye sees one cover the other', () => {
  const views = seatEyeViews(head);
  assert.equal(views.length, 2, 'one view per eye');
  assert.equal(glassPlatesOverlap([quad(0, 1.6, -1, .1), quad(.15, 1.6, -1, .1)], views), true, 'side by side and touching');
  assert.equal(glassPlatesOverlap([quad(0, 1.6, -1, .1), quad(.25, 1.6, -1, .1)], views), false, 'a clear gap');
  // A near plate in front of a far one, offset so only the left eye lines them up.
  assert.equal(glassPlatesOverlap([quad(0, 1.6, -.5, .02), quad(-.11, 1.6, -2, .05)], views), true, 'covered in one eye only');
  assert.equal(glassPlatesOverlap([quad(0, 1.6, -1, .1)], views), false, 'one plate covers nothing');
});

test('telomerase chapter 4: no compact seat lays one plate over another', () => {
  const lesson = JSON.parse(readFileSync(new URL('../../plugin/demos/telomerase-haca.json', import.meta.url), 'utf8'));
  const chapter = lesson.chapters[3];
  const tour = { active: true, selectedId: lesson.id, selectedTitle: lesson.title, title: chapter.title,
    progress: `Scene 4 / ${lesson.chapters.length}`, step: 3, total: lesson.chapters.length, canNext: true,
    bodyPage: chapter.immersive?.narration ?? chapter.caption, bodyPageIndex: 0, bodyPageCount: 1, chapterStartedAt: 0,
    captionCard: lesson.presentation.captionCard };
  const subject = { pdbId: '8OUE', chains: 10, assembly: 'asymmetric_unit', representation: 'cartoon', color: 'chain-id',
    selectionCount: 0, emphasisCount: 10, contextOpacity: 0.35,
    title: 'The H/ACA RNP lobe of human telomerase with the dyskerin thumb loop in a semi-closed conformation' };
  const options = { rows: spatialToolbarRows({ collapsed: true, quiet: true, voice: { state: 'idle' }, tour }),
    readout: runtime.tourReadout(tour, subject, 0), status: '', readoutPage: 0,
    assistantLines: ['No assistant connected', 'Hold A or X to talk', 'Assistant: next tour'],
    measureText: runtime.toolbarTextWidth, constants: SPATIAL_TOOLBAR_LAYOUT };
  const candidates = menuRelocationCandidates(options, head, { cardOnly: true });
  assert.ok(candidates.some(seat => String(seat.id).startsWith('compact')), 'compact seats remain');
  const views = seatEyeViews(head);
  for (const seat of candidates) assert.equal(glassPlatesOverlap(seat.glass, views), false, `${seat.id} keeps its plates apart`);
});
