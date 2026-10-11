import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { tourEndHarness } from './fixtures/tour-end-harness.mjs';
import { toolbarFrameRuntime, toolbarFrameHarness } from './fixtures/toolbar-frame-runtime.mjs';
import { journeyNavigationHarness, inspectorSource } from './fixtures/journey-navigation-harness.mjs';
import { prepareRepresentationUploads } from './scene-transition.mjs';
import { beginSceneTransition } from './xr-render-budget.mjs';
import { spatialToolbarRows } from './spatial-toolbar-content.mjs';

test('the journey heartbeat uses production backoff and resumes immediately after a successful retry', async () => {
  let now = 0, calls = 0, retries = 0, offline = true;
  const context = journeyNavigationHarness({ Date: { now: () => now },
    armPoll: () => { retries++; }, showConnectionProblem: () => true,
    call: async () => {
      calls++;
      if (offline) throw Object.assign(Error('Host offline'), { code: 'companion_connection' });
      return { structuredContent: {} };
    },
  });
  await context.busyBeat(context.generation);
  assert.equal(calls, 1); assert.equal(retries, 1);
  assert.ok(context.pollBackoff.remaining() >= 250 && context.pollBackoff.remaining() <= 500);
  await context.busyBeat(context.generation);
  assert.equal(calls, 1, 'a heartbeat during backoff must not contact the host');
  now = 500; offline = false;
  await context.busyBeat(context.generation);
  assert.equal(calls, 2); assert.equal(context.pollBackoff.remaining(), 0);
  await context.busyBeat(context.generation);
  assert.equal(calls, 3, 'success releases the next heartbeat immediately');
});
const require = createRequire(new URL('../../plugin/package.json', import.meta.url));
const { tsImport } = require('tsx/esm/api');
const { mountExperiencePlayer } = await tsImport('../../plugin/src/experience-player.ts', import.meta.url);
const { mountTourPlayer } = await tsImport('../../plugin/src/tour-player.ts', import.meta.url);
const { createPanelTourController, applyTourCommand, tourHeartbeat } = await tsImport('../../plugin/src/inspection-tour-client.ts', import.meta.url);
const { MOLECULAR_EXPERIENCES, stageForStep } = await tsImport('../../plugin/src/molecular-experience.ts', import.meta.url);
const runtime = await toolbarFrameRuntime();
const definition = MOLECULAR_EXPERIENCES.find(item => item.id === 'hemoglobin-quaternary-structure');
const view = stepIndex => ({ definition, stepIndex, revision: stepIndex + 1, stageId: stageForStep(definition, stepIndex).id, sourceKey: 'rendered' });
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
function dom() {
  const h = tourEndHarness(), create = document.createElement.bind(document);
  document.createElement = (...args) => Object.assign(create(...args), { querySelectorAll: () => [], remove() {} });
  document.removeEventListener = () => {};
  return h;
}

test('incoming chapter plate is drawn before staged uploads and remains correct through the delayed render receipt', async () => {
  const h = dom(), spoken = [], representations = new Set();
  let release, uploadStarted, player;
  const started = new Promise(resolve => { uploadStarted = resolve; });
  const frame = toolbarFrameHarness(runtime, { presentation: {
    add: rep => representations.add(rep), remove: rep => representations.delete(rep),
  } });
  const refresh = async () => { frame.setState({ tour: player.getState() }); await frame.toolbar.update(); };
  const drawn = () => [...representations].find(rep => rep.shape?.name === 'Stereofold toolbar readout')?.shape.geometry.lines.join('').replace(/\s+/g, '') ?? '';
  player = mountExperiencePlayer({ after: h.after, explore() {}, finish: async () => ({ status: 'rendered' }),
    narrate: line => spoken.push(line), navigate: async (_id, step) => {
      if (step === 1) {
        // The same preview + awaited toolbar update precedes viewer.load in hydrate.
        const previewAt = inspectorSource.indexOf('experiencePlayer?.preview(experience)');
        assert.ok(previewAt > 0 && previewAt < inspectorSource.indexOf('await workspace.load', previewAt));
        assert.match(inspectorSource.slice(previewAt, previewAt + 110), /await workspace.viewer.xr\?\.refreshToolbar\?\.\(\)/);
        player.preview(view(step)); await refresh();
        const checkCaption = () => {
          assert.ok(drawn().includes(definition.steps[1].title.replace(/\s+/g, '')), drawn());
          assert.ok(!drawn().includes(definition.steps[0].title.replace(/\s+/g, '')), drawn());
          assert.match(drawn(), /PreparingScene2/);
          assert.equal(player.getState().step, 0);
          assert.equal(tourHeartbeat(player).step, 0);
          assert.equal(spoken.length, 1, 'new narration still needs a rendered acknowledgement');
        };
        const repr = { state: { visible: false }, renderObjects: [{}, {}] };
        await prepareRepresentationUploads({ canvas: { remove() {}, add() {}, commit() { checkCaption(); } },
          representation: { obj: { data: { repr } } }, yieldFrame: async () => { checkCaption(); } });
        const transition = beginSceneTransition({ operation: 'representation', record: (_kind, detail) => {
          if (detail.phase === 'first-frame') checkCaption();
        } });
        transition.firstFrame(); checkCaption(); uploadStarted();
        await new Promise(resolve => { release = resolve; });
        checkCaption(); transition.oldRemoved(); transition.finish();
      }
      player.update(view(step));
    } });
  player.setCatalog([{ id: definition.id, title: definition.title }]);
  try {
    await player.select(definition.id); await player.start(); await refresh();
    const pending = player.next(); await started;
    await refresh(); assert.match(drawn(), /PreparingScene2/);
    release(); await pending; await refresh();
    assert.equal(player.getState().step, 1); assert.equal(player.getState().chapterPreview, undefined);
    assert.equal(spoken.at(-1), definition.steps[1].body);
  } finally { release?.(); player.dispose(); await frame.toolbar.dispose(); h.cleanup(); }
});

test('lesson captions preview the target before a representation rebuild without advancing the rendered step', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = dom();
  const lesson = { id: 'preview', title: 'Preview', summary: '', steps: [
    { id: 'one', title: 'First chapter', narration: 'First line', appearance: { representation: 'cartoon' } },
    { id: 'two', title: 'Second chapter', narration: 'Second line', appearance: { representation: 'ball-and-stick' } },
  ] };
  let player, painted = [], refreshes = 0;
  h.workspace.viewer.xr = { refreshToolbar: async () => { refreshes++; } };
  const configure = h.workspace.viewer.inspection.configure;
  h.workspace.viewer.inspection.configure = async patch => {
    const state = player.getState();
    painted.push({ step: state.step, title: state.chapterPreview?.title, refreshes });
    await configure(patch);
  };
  player = mountTourPlayer({ ...h, tours: [lesson] });
  try {
    await player.select(lesson.id); await player.start(false); await player.next();
    assert.equal(painted.at(-1).step, 0); assert.equal(painted.at(-1).title, 'Second chapter');
    assert.ok(painted.at(-1).refreshes > 0); assert.equal(player.getState().step, 1);
  } finally { player.pause(); h.cleanup(); }
});

for (const surface of ['menu', 'desktop']) test(`${surface} pause then Next keeps navigation ready through concurrent heartbeats`, async () => {
  let availability = 'ready', queuedPause = surface === 'desktop', received = 0, navigated = 0;
  const context = journeyNavigationHarness({
    receive: async () => { received++; context.binding.inspectionRevision++; },
    hydrate: async () => {},
    call: async (name, args) => {
      if (name === 'poll_inspection') {
        availability = args.availability;
        const data = { attached: true, sourceToken: args.sourceToken, stateRevision: args.baseStateRevision, inspectionRevision: args.baseInspectionRevision };
        if (queuedPause) { queuedPause = false; return { structuredContent: data, _meta: { private: { delivery: {} } } }; }
        return { structuredContent: data };
      }
      assert.equal(name, 'navigate_experience');
      await context.busyBeat(context.generation);
      assert.equal(availability, 'ready', 'preparing a journey must not mark its own panel busy');
      navigated++;
      return { structuredContent: { experienceTransition: { sourceChanged: false } } };
    },
  });
  if (surface === 'desktop') await assert.rejects(context.navigateExperience('journey', 1), /A desktop command arrived/);
  await context.navigateExperience('journey', 1);
  assert.equal(navigated, 1); assert.equal(received, surface === 'desktop' ? 1 : 0);
  assert.equal(context.experiencePreparing, false); assert.equal(context.remote, false);
});

test('a chooser press and immediate start wait for the admitted menu command to settle', async () => {
  let release, menuDone = false, posted = false;
  const menuCommit = new Promise(resolve => { release = () => { menuDone = true; resolve(); }; });
  const context = journeyNavigationHarness({ rendering: menuCommit, hydrate: async () => {},
    call: async (name, args) => {
      assert.equal(menuDone, true); posted = true;
      return name === 'poll_inspection' ? { structuredContent: { attached: true, sourceToken: args.sourceToken,
        stateRevision: args.baseStateRevision, inspectionRevision: args.baseInspectionRevision } } : { structuredContent: {} };
    } });
  const start = context.navigateExperience(definition.id, 0); await flush(); assert.equal(posted, false);
  release(); await start; assert.equal(posted, true);
});

test('chooser survives a minute, repeated hydration and default selection; Menu closes it and stale Start reports why', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const h = dom();
  const experience = mountExperiencePlayer({ after: h.after, explore() {}, finish: async () => ({ status: 'rendered' }),
    navigate: async (_id, step) => experience.update(view(step)) });
  experience.setCatalog([{ id: definition.id, title: definition.title }]);
  const lesson = mountTourPlayer({ ...h, tours: [] });
  const panel = createPanelTourController(lesson, experience);
  const source = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
  const begin = source.indexOf("        if (action.kind === 'collapse')"), end = source.indexOf('        // A spoken "next" or "back" with no lesson running starts', begin);
  const dispatch = action => vm.runInNewContext(`(async()=>{${source.slice(begin, end)}})()`, { action, spatialTour: panel });
  const actionErrors = [];
  const frame = toolbarFrameHarness({ ...runtime, createSpatialToolbar: options => runtime.createSpatialToolbar({
    ...options, onAction: dispatch, onActionError: error => actionErrors.push(error),
  }) });
  try {
    await panel.openMenu(); await panel.select(definition.id);
    const start = spatialToolbarRows({ tour: panel.getState() }).find(row => row.action.kind === 'tour-play').action;
    assert.equal(start.chooser, true);
    for (let second = 0; second < 65; second++) {
      t.mock.timers.tick(1000); experience.update(undefined); panel.setDefault(true);
      assert.equal(panel.getState().menuOpen, true); assert.equal(panel.getState().selectedId, definition.id);
    }
    await dispatch(start); await panel.pause(); assert.equal(panel.getState().step, 0);
    await panel.openMenu();
    frame.setState({ tour: panel.getState() }); await frame.toolbar.update();
    frame.toolbar.runAction({ kind: 'collapse', value: true }); await flush();
    assert.equal(panel.getState().menuOpen, false);
    frame.setState({ tour: panel.getState() }); await frame.toolbar.update();
    frame.toolbar.runAction(start); await flush();
    assert.equal(actionErrors.length, 1);
    assert.match(actionErrors[0].message, /The tour chooser is closed. Press Tours to choose a journey./);
    assert.equal(frame.toolbar.statusText(), 'Could not apply that change. Try again.');
  } finally { panel.pause(); panel.dispose(); experience.dispose(); await frame.toolbar.dispose(); h.cleanup(); }
});


test('a pause while the incoming caption commits prevents the superseded lesson geometry from drawing', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = dom();
  let release, begin, configured = 0;
  const waiting = new Promise(resolve => { begin = resolve; });
  h.workspace.viewer.xr = { refreshToolbar: () => { begin(); return new Promise(resolve => { release = resolve; }); } };
  h.workspace.viewer.inspection.configure = async () => { configured++; };
  const player = mountTourPlayer({ ...h, tours: [{ id: 'paused-preview', title: 'Paused preview', summary: '', steps: [
    { id: 'one', title: 'First chapter', narration: 'First line', appearance: { representation: 'cartoon' } },
  ] }] });
  try {
    await player.select('paused-preview');
    const start = player.start(false);
    const rejected = assert.rejects(start, /interrupted before rendering/);
    await waiting; player.pause(); release(); await rejected;
    assert.equal(configured, 0); assert.equal(player.getState().step, -1);
    assert.equal(player.getState().chapterPreview, undefined);
  } finally { release?.(); player.pause(); h.cleanup(); }
});
