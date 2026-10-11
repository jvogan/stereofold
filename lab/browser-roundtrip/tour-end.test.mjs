import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { tourEndHarness } from './fixtures/tour-end-harness.mjs';
import { toolbarFrameRuntime, identity } from './fixtures/toolbar-frame-runtime.mjs';

const require = createRequire(new URL('../../plugin/package.json', import.meta.url));
const { tsImport } = require('tsx/esm/api');
const { mountTourPlayer } = await tsImport('../../plugin/src/tour-player.ts', import.meta.url);
const { molecularLessonToTour } = await tsImport('../../plugin/src/molecular-lesson-tour.ts', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('../../plugin/demos/telomerase-haca.json', import.meta.url)));
const tour = molecularLessonToTour(manifest);
const flush = async () => { for (let i = 0; i < 150; i++) await Promise.resolve(); };

for (const early of [false, true]) test(`telomerase returns to rest through the real player (Done=${early})`, async t => {
  const runtime = await toolbarFrameRuntime();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const h = tourEndHarness();
  const player = mountTourPlayer({ ...h, tours: [tour] });
  const session = Object.assign(new EventTarget(), { inputSources: [],
    requestAnimationFrame: callback => { queueMicrotask(() => callback(0, frame)); return 1; }, cancelAnimationFrame() {} });
  const frame = { getViewerPose: () => ({ transform: { position: { x: 0, y: 1.6, z: 0 }, matrix: identity } }) };
  const toolbar = runtime.createSpatialToolbar({ plugin: { runTask: task => task.run() },
    canvas: {}, session, space: {}, Mat4: {},
    presentation: { add() {}, remove() {}, update() {}, setVisible() {}, roomMatrix: () => identity },
    getMolecularBounds: () => ({ center: [0, 0, -1], radius: .1 }),
    getState: () => ({ tour: player.getState(), voice: { state: 'idle' } }),
    onAction: () => h.dispatchDone(player), onActionError: error => { throw error; } });
  try {
    await h.install(tour); const baseline = h.capture();
    await player.select(tour.id); await toolbar.update();
    // Explicitly close the menu: only that form may quiet during a chapter.
    toolbar.runAction({ kind: 'collapse', value: true }); await flush();
    const restingRows = toolbar.menuRows().length;
    await player.start(true);
    for (let step = 0; step < (early ? 1 : tour.steps.length - 1); step++) {
      assert.equal(player.getState().step, step);
      t.mock.timers.tick(tour.steps[step].durationMs); await flush();
    }
    await toolbar.update();
    assert.equal(toolbar.isDimmed(), true);
    if (early) {
      toolbar.runAction({ kind: 'tour-done' }); await flush();
    } else {
      assert.equal(player.getState().step, 4);
      t.mock.timers.tick(8999); await flush();
      assert.equal(player.getState().active, true, 'the final scene receives its entire nine-second dwell');
      t.mock.timers.tick(1); await flush();
    }
    assert.equal(player.getState().active, false);
    assert.equal(player.getState().step, -1);
    assert.equal(player.getState().autoplay, false);
    assert.equal(player.getState().menuOpen, false);
    assert.deepEqual(h.capture(), baseline, 'appearance, emphasis and placement return to their starting values');
    await toolbar.update();
    assert.equal(toolbar.isDimmed(), false);
    assert.equal(toolbar.menuRows().length, restingRows, 'the actual column returns to its resting rows');
    assert.deepEqual(h.spoken, ['Tour complete. Explore freely.']);
    assert.equal(h.restores.at(-1).preserveCamera, true);
    const ends = h.records.all().filter(e => e.kind === 'tour' && e.detail.action === 'end');
    assert.equal(ends.length, 1);
    assert.equal(ends[0].detail.reason, early ? 'done' : 'completed');
    assert.equal(ends[0].detail.outcome, 'restored');
    assert.equal(ends[0].detail.active, false);
    await h.dispatchDone(player); t.mock.timers.tick(60000); await flush();
    assert.equal(h.spoken.length, 1, 'repeated Done and the cancelled dwell cannot speak twice');
  } finally { player.pause(); await toolbar.dispose(); h.cleanup(); }
});
