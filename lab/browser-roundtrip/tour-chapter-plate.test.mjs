import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { spatialToolbarRows } from './spatial-toolbar-content.mjs';
import { tourEndHarness } from './fixtures/tour-end-harness.mjs';
import { toolbarFrameRuntime, toolbarFrameHarness, identity } from './fixtures/toolbar-frame-runtime.mjs';

const require = createRequire(new URL('../../plugin/package.json', import.meta.url));
const { tsImport } = require('tsx/esm/api');
const { TOURS } = await tsImport('../../plugin/src/tour-catalog.ts', import.meta.url);
const { mountTourPlayer, wearerPages } = await tsImport('../../plugin/src/tour-player.ts', import.meta.url);
const { mountExperiencePlayer } = await tsImport('../../plugin/src/experience-player.ts', import.meta.url);
const { applyTourCommand, createPanelTourController, tourHeartbeat } = await tsImport('../../plugin/src/inspection-tour-client.ts', import.meta.url);
const { MOLECULAR_EXPERIENCES, stageForStep } = await tsImport('../../plugin/src/molecular-experience.ts', import.meta.url);
const runtime = await toolbarFrameRuntime(undefined, { glyphAdvances: JSON.parse(readFileSync(new URL('./fixtures/toolbar-bold-font-metrics.json', import.meta.url))).advances });
const flush = async () => { for (let i = 0; i < 200; i++) await Promise.resolve(); };
const compact = text => text.replace(/\s+/gu, '');
const subject = { title: 'Human deoxyhaemoglobin', pdbId: '4HHB', chains: 4, assembly: 'asymmetric_unit',
  representation: 'cartoon', color: 'chain-id', selectionCount: 5, focus: ['heme'], contextOpacity: .18 };
const tour = { id: 'chapter-plate', title: 'Chapter plate', summary: 'A two-chapter fixture.',
  presentation: { captionCard: 'shown', end: 'hold' }, steps: [
    { id: 'one', title: 'Meet the fold', narration: 'Four chains carry oxygen.', appearance: { representation: 'cartoon' }, durationMs: 12000 },
    { id: 'two', title: 'Follow the chain', narration: 'A chain folds around its heme.', appearance: { representation: 'ball-and-stick' }, durationMs: 14000 },
  ] };

for (const route of ['model', 'menu']) for (const kind of ['lesson', 'staged journey']) {
  test(`${route}-started ${kind}: drawn chapters 1 and 2 retain title, narration and expanded transport through the dwell`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
    t.mock.method(globalThis.performance, 'now', () => Date.now());
    const h = tourEndHarness(), spoken = [];
    const create = document.createElement.bind(document);
    document.createElement = (...args) => Object.assign(create(...args), { querySelectorAll: () => [], remove() {} });
    document.removeEventListener = () => {};
    const lesson = mountTourPlayer({ ...h, tours: [tour], narrate: line => spoken.push(line) });
    const definition = MOLECULAR_EXPERIENCES.find(item => item.id === 'hemoglobin-quaternary-structure');
    let release, hold = false;
    const experience = mountExperiencePlayer({ after: h.after, explore() {}, narrate: line => spoken.push(line),
      finish: async () => ({ status: 'rendered' }),
      navigate: async (id, stepIndex) => {
        assert.equal(id, definition.id);
        if (hold) await new Promise(resolve => { release = resolve; });
        experience.update({ definition, stepIndex, revision: stepIndex + 1,
          stageId: stageForStep(definition, stepIndex).id, sourceKey: 'rendered' });
      } });
    experience.setCatalog([{ id: definition.id, title: definition.title, steps: definition.steps.length }]);
    const panel = createPanelTourController(lesson, experience), representations = new Set();
    const f = toolbarFrameHarness(runtime, { state: { subject, tour: panel.getState(), voice: { state: 'idle' } },
      presentation: { add: representation => representations.add(representation), remove: representation => representations.delete(representation) } });
    const refresh = async () => { f.setState({ subject, tour: panel.getState(), voice: { state: 'idle' } }); await f.toolbar.update(); };
    const drawn = () => [...representations].find(rep => rep.shape?.name === 'Stereofold toolbar readout')?.shape.geometry.lines.join('') ?? '';
    const assertChapter = (body = true) => {
      const state = panel.getState(), text = compact(drawn());
      assert.ok(text.includes(compact(state.title)), `drawn title: ${drawn()}`);
      if (body) assert.ok(text.includes(compact(state.bodyPage)), `drawn narration page: ${drawn()}`);
      assert.ok(spoken.includes(kind === 'lesson' ? tour.steps[state.step].narration : definition.steps[state.step].body));
      assert.equal(f.toolbar.isCollapsed(), false);
      assert.equal(f.toolbar.isDimmed(), false);
      assert.ok(f.toolbar.rows().some(row => row.id === 'done'));
      assert.ok(f.toolbar.rows().some(row => row.id === 'tour'));
      if (state.canNext) assert.ok(f.toolbar.rows().some(row => row.id === 'next'));
      assert.equal(f.toolbar.menuRows().length, f.toolbar.rows().length, 'transport rows are committed geometry');
      if (state.bodyPageCount > 1) assert.ok(f.toolbar.rows().some(row => row.id === 'page'));
      if (state.step > 0) assert.ok(f.toolbar.rows().some(row => row.id === 'back'));
    };
    try {
      await refresh();
      // Exercise the wearer's close/open press, not merely the default grid.
      f.toolbar.runAction({ kind: 'collapse', value: true }); await flush();
      f.toolbar.runAction({ kind: 'collapse', value: false }); await flush();
      const id = kind === 'lesson' ? tour.id : definition.id;
      if (route === 'model') await applyTourCommand(panel, { action: 'start', tourId: id });
      else { await panel.select(id); await panel.start(true); }
      await panel.pause(); await refresh();
      assert.equal(panel.getState().step, 0); assertChapter();
      if (kind === 'staged journey') hold = true;
      const next = route === 'model' ? applyTourCommand(panel, { action: 'next' }) : panel.next();
      await flush(); await refresh();
      if (hold) {
        assert.equal(panel.getState().step, 0, 'pending stage cannot publish the next chapter');
        assert.ok(compact(drawn()).includes(compact(definition.steps[0].title)));
        release();
      }
      await next; await refresh();
      assert.equal(panel.getState().step, 1); assertChapter();
      // Refresh after the old wake window and after each point of a 14s dwell.
      for (const delta of [2999, 1, 8999, 1, 2000]) {
        t.mock.timers.tick(delta); await flush(); await refresh(); assertChapter(false);
      }
      // A page press after the reading window opens that page's full window.
      if (panel.getState().bodyPageCount > 1) { await panel.nextReadoutPage(); await refresh(); assertChapter(); }
      if (route === 'model') await applyTourCommand(panel, { action: 'done' });
      else await h.dispatchDone(panel);
      await refresh();
      assert.ok(compact(drawn()).includes('Backtoyourview'));
      assert.ok(!compact(drawn()).includes(compact(kind === 'lesson' ? tour.steps[1].title : definition.steps[1].title)));
      assert.deepEqual(tourHeartbeat(panel), { step: -1, total: 0, active: false, autoplay: false, navigating: false });
    } finally { panel.pause(); panel.dispose(); experience.dispose(); await f.toolbar.dispose(); h.cleanup(); }
  });
}


test('all shipped catalog and experience pages retain their full title and prose in both menu forms', () => {
  let checked = 0;
  for (const tour of [...TOURS, ...MOLECULAR_EXPERIENCES]) for (const [step, chapter] of tour.steps.entries()) {
    const pages = wearerPages(chapter);
    for (const [pageIndex, page] of pages.entries()) for (const collapsed of [false, true]) {
      const state = { selectedId: tour.id, active: true, autoplay: true, step, total: tour.steps.length,
        title: chapter.title, bodyPage: page, bodyPageCount: pages.length, bodyPageIndex: pageIndex };
      // The card wraps the caption at its own width and turns its own pages,
      // each opening on the chapter's title line.
      const options = { head: { position: { x: 0, y: 1.6, z: 0 }, matrix: identity },
        rows: spatialToolbarRows({ tour: state, collapsed }), readout: runtime.tourReadout(state, subject),
        measureText: runtime.toolbarTextWidth, readoutPage: 0 };
      const first = runtime.createToolbarPanel(options);
      const plates = Array.from({ length: first.readoutPageCount }, (_, readoutPage) => runtime.createToolbarPanel({ ...options, readoutPage }));
      const context = `${tour.id} chapter ${step + 1} page ${pageIndex + 1} collapsed ${collapsed}`;
      for (const plate of plates) {
        assert.ok(compact(plate.readoutPoints[0].text).includes(compact(chapter.title)), context);
        assert.ok(plate.readoutPoints.length <= plate.readoutLineBudget, context);
      }
      const drawn = compact(plates.map(plate => plate.readoutPoints.slice(1).map(line => line.text.replace(/…$/u, '')).join(' ')).join(' '));
      assert.ok(drawn.includes(compact(page)), `${context}: ${drawn}`);
      checked++;
    }
  }
  assert.equal(checked, 800, 'covers every shipped chapter of the frozen catalog in both menu forms');
});
