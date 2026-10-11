import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { recordedEndings, recordedTourSeat } from './fixtures/recorded-tour-seat.mjs';
const require = createRequire(new URL('../../plugin/package.json', import.meta.url));
const { tsImport } = require('tsx/esm/api');
const { mountTourPlayer } = await tsImport('../../plugin/src/tour-player.ts', import.meta.url);
const { molecularLessonToTour } = await tsImport('../../plugin/src/molecular-lesson-tour.ts', import.meta.url);
const tour = molecularLessonToTour(JSON.parse(readFileSync(new URL('../../plugin/demos/telomerase-haca.json', import.meta.url))));
const flush = async () => { for (let i = 0; i < 300; i++) await Promise.resolve(); };

for (const reason of ['done', 'completed']) test(`acceptance 6 ${reason}: restores the complete resting column and emits seat evidence`, async t => {
  const h = await recordedTourSeat(mountTourPlayer, tour);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: recordedEndings.completed.entries[0].at });
  try {
    await h.player.start(true);
    const entries = recordedEndings[reason].entries;
    const scenes = entries.filter(e => e.kind === 'tour' && e.detail.action === 'scene');
    for (const scene of scenes) {
      assert.equal(h.player.getState().step, scene.detail.step);
      await h.scene({ ...scene, reason });
      if (scene !== scenes.at(-1)) { t.mock.timers.tick(scene.detail.dwellMs); await flush(); }
    }
    if (reason === 'done') {
      const action = entries.find(e => e.kind === 'toolbar-action' && e.detail.kind === 'tour-done');
      t.mock.timers.tick(action.at - scenes.at(-1).at); await flush();
      assert.equal(globalThis.__stereofoldMenu.press('done'), true); await flush();
    } else { t.mock.timers.tick(scenes.at(-1).detail.dwellMs); await flush(); }
    await h.toolbar.update();
    assert.deepEqual(h.captureSeat(), h.baseline, 'seat, scale, columns, appearance and placement must equal pre-tour');
    const evidence = h.records.all().filter(e => e.kind === 'plate-standoff' && e.detail.phase === 'tour-end');
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0].detail.frame.menu.clear, true);
    assert.ok(evidence[0].detail.clearanceLeft > 0 && evidence[0].detail.clearanceRight > 0);
    assert.equal(h.toolbar.isDimmed(), false);
    t.mock.timers.tick(180000); await flush(); await h.toolbar.update();
    assert.deepEqual(h.captureSeat(), h.baseline, 'late refresh cannot revive the near chapter column');
    h.replayResting();
    const layouts = h.labels.records.filter(e => e.kind === 'component-label-layout');
    assert.equal(layouts.length, 1, 'snapshot and column restore solve once');
    assert.match(layouts[0].reason, /seat/);
    assert.equal(layouts[0].overlaps, 0);
    assert.equal(layouts[0].subject, 0);
    assert.equal(h.labels.records.filter(e => e.kind === 'plate-update').length, 1);
  } finally { await h.cleanup(); }
});

test('the page hook can reach early Done through Menu in every recorded chapter', async t => {
  const h = await recordedTourSeat(mountTourPlayer, tour);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: recordedEndings.completed.entries[0].at });
  try {
    await h.player.start(true);
    const scenes = recordedEndings.completed.entries.filter(e => e.kind === 'tour' && e.detail.action === 'scene');
    for (const scene of scenes) {
      await h.scene(scene);
      if (!globalThis.__stereofoldMenu.rows().some(row => row.id === 'done')) {
        assert.equal(globalThis.__stereofoldMenu.press('menu'), true); await flush();
      }
      assert.ok(globalThis.__stereofoldMenu.rows().some(row => row.id === 'done' && row.active), `scene ${scene.detail.step + 1} exposes Done`);
      if (scene !== scenes.at(-1)) { t.mock.timers.tick(scene.detail.dwellMs); await flush(); }
    }
  } finally { await h.cleanup(); }
});
