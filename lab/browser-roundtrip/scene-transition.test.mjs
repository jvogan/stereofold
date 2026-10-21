import { emptyLessonFigureBinding } from './fixtures/empty-lesson-figure.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { CommitQueue } from 'molstar/lib/mol-gl/commit-queue.js';
import { Task } from 'molstar/lib/mol-task/task.js';
import { installTransitionWorkBudget, prepareRepresentationUploads, runTransitionTask, representationLayerRef } from './scene-transition.mjs';
import { beginSceneTransition, watchFrameCost } from './xr-render-budget.mjs';

// Real Mol* queue cancellation with a deterministic upload/draw boundary.
// These costs are injected, not GPU measurements of either public molecule.
function uploadHarness(costs = [8, 8, 8]) {
  const queue = new CommitQueue(), live = new Map(), objects = new Set(), uploads = [], commits = [];
  const old = { state: { visible: true }, renderObjects: [{ id: 'old', ms: 0 }] };
  const next = { state: { visible: false }, renderObjects: costs.map((ms, id) => ({ id, ms })) };
  let clock = 0, callback;
  const records = [], session = { frameRate: 72, requestAnimationFrame(fn) { callback = fn; return 1; } };
  const sampler = watchFrameCost({ session, now: () => clock, intervalMs: 1, record: (kind, detail) => records.push({ kind, detail }), scope: {} });
  const canvas = {
    add(repr) { for (const obj of repr.renderObjects) if (!live.get(repr)?.has(obj)) queue.add(obj); live.set(repr, new Set(repr.renderObjects)); },
    remove(repr) { for (const obj of live.get(repr) ?? []) queue.remove(obj); live.delete(repr); },
    commit(sync) {
      commits.push(sync);
      let obj;
      while ((obj = queue.tryGetRemove())) objects.delete(obj);
      while ((obj = queue.tryGetAdd())) if (!objects.has(obj)) { objects.add(obj); uploads.push(obj); clock += obj.ms; }
    },
  };
  const frame = () => { session.requestAnimationFrame(() => { clock += 1; }); callback(clock); };
  canvas.add(old); canvas.commit(false); uploads.length = 0; frame();
  canvas.add(next);
  return { canvas, old, next, objects, live, uploads, commits, records, sampler,
    get clock() { return clock; }, frame, session,
    yieldFrame: async () => { assert.ok(live.has(old)); assert.ok(objects.has(old.renderObjects[0])); frame(); },
  };
}

test('hidden uploads retain the old drawing, upload once per object and leave one real representation', async () => {
  const h = uploadHarness();
  const count = await prepareRepresentationUploads({ canvas: h.canvas, representation: { obj: { data: { repr: h.next } } }, yieldFrame: h.yieldFrame });
  assert.equal(count, 3);
  assert.deepEqual(h.uploads, h.next.renderObjects);
  assert.deepEqual([...h.live.keys()], [h.old, h.next]);
  assert.equal(h.next.state.visible, false);
  assert.ok(h.commits.every(sync => sync === false));
  h.sampler.stop();
});

for (const failure of ['cancelled', 'context lost', 'draw timeout', 'session ended']) test(`an upload ${failure} removes all partial batches and retains the old drawing`, async () => {
  const h = uploadHarness(); let checks = 0;
  await assert.rejects(prepareRepresentationUploads({ canvas: h.canvas, representation: { obj: { data: { repr: h.next } } },
    yieldFrame: h.yieldFrame, check() { if (++checks === 3) throw Error(failure); } }), new RegExp(failure));
  assert.deepEqual([...h.live.keys()], [h.old]);
  assert.deepEqual([...h.objects], h.old.renderObjects);
  h.sampler.stop();
});

test('a visible replacement refuses before changing canvas ownership', async () => {
  const h = uploadHarness(); h.next.state.visible = true;
  await assert.rejects(prepareRepresentationUploads({ canvas: h.canvas, representation: { obj: { data: { repr: h.next } } }, yieldFrame: h.yieldFrame }), /must stay hidden/);
  assert.deepEqual([...h.live.keys()], [h.old, h.next]); h.sampler.stop();
});

test('transition tasks use Mol* observable updates and recheck cancellation after a yield', async () => {
  let checks = 0, cancelled = false;
  const task = Task.create('cooperative geometry', async ctx => {
    assert.equal(ctx.isSynchronous, false);
    await ctx.update('geometry'); cancelled = true;
    await ctx.update('cancel');
    assert.fail('cancelled geometry continued');
  });
  await assert.rejects(runTransitionTask(task, () => { checks++; if (cancelled) throw Error('superseded source'); }), /superseded source/);
  assert.ok(checks >= 3);
});

test('a phase abort stops its cooperative geometry task without canceling a replacement task', async () => {
  const deadline = new AbortController();
  let continued = false;
  const task = Task.create('expired surface', async ctx => {
    await ctx.update('building');
    deadline.abort(Error('placement deadline'));
    await ctx.update('next surface batch');
    continued = true;
  });
  await assert.rejects(runTransitionTask(task, () => deadline.signal.throwIfAborted()), /placement deadline/);
  assert.equal(continued, false);
  const recovery = Task.create('recovery geometry', async ctx => { await ctx.update('restoring'); return 'restored'; });
  assert.equal(await runTransitionTask(recovery), 'restored');
});

test('nested tasks count work after resume, excluding slow renderer waits without starving frames', async () => {
  let clock = 0, notifications = 0, working = false;
  const contexts = [];
  const child = Task.create('small surface chunk', async ctx => {
    contexts.push(ctx);
    for (let i = 0; i < 4; i++) { clock++; if (ctx.shouldUpdate) await ctx.update('geometry'); }
  });
  const parent = Task.create('surface tree', async ctx => {
    contexts.push(ctx); working = true;
    for (let i = 0; i < 12; i++) await child.runAsChild(ctx);
    working = false; return 'unchanged geometry';
  });
  assert.equal(await runTransitionTask(parent, () => {
    if (working) { notifications++; clock += 100; } // Renderer work while yielded.
  }, { now: () => clock }), 'unchanged geometry');
  assert.equal(notifications, 6, '48 ms of work yields every 8 ms across tiny child tasks');
  for (const context of contexts) for (const name of ['shouldUpdate', 'update', 'runChild'])
    assert.equal(Object.hasOwn(context, name), false, `the temporary ${name} override was restored`);
});

test('nested task cancellation keeps original parent/child cleanup and independent recovery', async () => {
  let callbacks = 0, cancel = false;
  const child = Task.create('child', async ctx => { cancel = true; await ctx.update('cancel'); assert.fail('continued'); }, () => callbacks++);
  const parent = Task.create('parent', ctx => child.runAsChild(ctx), () => callbacks++);
  await assert.rejects(runTransitionTask(parent, () => { if (cancel) throw Error('deadline'); }), /deadline/);
  assert.equal(callbacks, 2);
  assert.equal(await runTransitionTask(Task.constant('recovery', 'restored')), 'restored');
});

test('unsupported or locked runtime contexts retain their original behavior', () => {
  const context = { get shouldUpdate() { return true; }, update() {}, runChild() {} };
  Object.defineProperty(context, 'update', { configurable: false });
  const before = Object.getOwnPropertyDescriptors(context);
  assert.equal(installTransitionWorkBudget(context, { now: () => 0, resumedAt: 0 }, task => task), undefined);
  assert.deepEqual(Object.getOwnPropertyDescriptors(context), before);
  const unsupported = { update() {} };
  assert.equal(installTransitionWorkBudget(unsupported, { now: () => 0, resumedAt: 0 }, task => task), undefined);
});

test('retained abort recovery restores readiness only after its recovery frame, never on a failed draw', async () => {
  for (const failDraw of [false, true]) {
    let release;
    const frame = new Promise((resolve, reject) => { release = () => failDraw ? reject(Error('recovery draw failed')) : resolve(); });
    const events = [], cell = { status: 'ok' };
    const c = vm.createContext({ ...emptyLessonFigureBinding(),
      Error,
      state: { status: 'error', error: 'placement deadline' }, busy: false,
      inspectionState: { checkpoint: () => ({ current: {} }), restoreCheckpoint: () => events.push('checkpoint'), payload: () => undefined },
      mutate: async () => { throw Error('placement deadline'); }, companionRecord: undefined,
      representation: { ref: 'old', cell }, plugin: { state: { data: { cells: new Map([['old', cell]]) } } },
      canvas: { webgl: { isContextLost: false }, xr: { isPresenting: { value: true } }, commit() {} },
      restoreInspectionPayload: () => events.push('payload'), applyInspectionAppearance: async () => events.push('appearance'),
      applyInspectionTransform() {}, waitForFrame: () => { events.push('draw'); return frame; }, assertContext() {},
    });
    vm.runInContext(pageFunction('inspectionMutation'), c);
    const pending = c.inspectionMutation(() => {}, { recoverRetained: () => true });
    const rejected = assert.rejects(pending, failDraw ? /recovery draw failed/ : /placement deadline/);
    for (let i = 0; i < 8; i++) await Promise.resolve();
    assert.deepEqual(events, ['checkpoint', 'payload', 'appearance', 'draw']);
    assert.equal(c.state.status, 'mutating'); assert.equal(c.busy, true);
    release(); await rejected;
    assert.equal(c.state.status, failDraw ? 'error' : 'ready'); assert.equal(c.busy, false);
    assert.equal(c.state.error, failDraw ? 'recovery draw failed' : null);
  }
});

test('companion recovery holds XR entry until its frame and draws immersive quality before ready', async () => {
  let releaseRecovery, releaseXr;
  const recoveryFrame = new Promise(resolve => { releaseRecovery = resolve; });
  const xrFrame = new Promise(resolve => { releaseXr = resolve; });
  const events = [];
  const c = vm.createContext({ ...emptyLessonFigureBinding(),
    state: { status: 'ready', error: null }, busy: false,
    companionRecoveryActive: false, companionRecoveryPendingXr: false,
    inspectionState: { checkpoint: () => ({ current: {} }), restoreCheckpoint() {}, payload: () => undefined },
    mutate: async (_kind, operation) => { await operation(); c.state.status = 'error'; throw Error('edit failed'); },
    companionRecord: {}, retiredComparisons: new Set(),
    canvas: { webgl: { isContextLost: false }, xr: { isPresenting: { value: false } }, commit: () => events.push('commit') },
    inspectionSnapshot: () => ({ companionStructure: {} }), restoreInspectionPayload() {},
    restoreCompanion: async () => events.push('companion'),
    applyInspectionAppearance: async options => events.push(options?.componentLabels === false ? 'xr appearance' : 'recovery appearance'),
    applyInspectionTransform() {}, waitForFrame: () => {
      events.push('frame'); return events.filter(event => event === 'frame').length === 1 ? recoveryFrame : xrFrame;
    },
    assertContext() {}, snapshot: () => ({ ready: c.state.status === 'ready' && !c.busy }),
    refreshStructureSubject: rendered => { if (rendered.ready) events.push('subject'); },
  });
  vm.runInContext(pageFunction('inspectionMutation'), c);
  vm.runInContext(pageFunction('onXrPresented'), c);
  const rejected = assert.rejects(c.inspectionMutation(() => {}), /edit failed/);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['companion', 'recovery appearance', 'commit', 'frame']);
  assert.equal(c.busy, true); assert.equal(c.state.status, 'mutating');
  c.canvas.xr.isPresenting.value = true;
  await c.onXrPresented();
  assert.equal(c.companionRecoveryPendingXr, true);
  assert.equal(events.filter(event => event.includes('appearance')).length, 1);
  releaseRecovery();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['companion', 'recovery appearance', 'commit', 'frame', 'xr appearance', 'commit', 'frame']);
  assert.equal(c.busy, true); assert.equal(c.state.status, 'mutating');
  releaseXr(); await rejected;
  assert.equal(c.busy, false); assert.equal(c.state.status, 'ready');
  assert.equal(c.state.error, null);
  assert.deepEqual(events.at(-1), 'subject');
});

test('companion recovery redraws desktop quality when XR exits during its deferred frame', async () => {
  const releases = [];
  const frames = Array.from({ length: 3 }, () => new Promise(resolve => releases.push(resolve)));
  const appearances = [];
  let builtPresenting = false, framesStarted = 0, subjectQuality;
  const c = vm.createContext({ ...emptyLessonFigureBinding(),
    state: { status: 'ready', error: null }, busy: false,
    companionRecoveryActive: false, companionRecoveryPendingXr: false,
    inspectionState: { checkpoint: () => ({ current: {} }), restoreCheckpoint() {}, payload: () => undefined },
    mutate: async (_kind, operation) => { await operation(); c.state.status = 'error'; throw Error('edit failed'); },
    companionRecord: {}, retiredComparisons: new Set(), structure: { obj: { data: {} } }, representation: {},
    canvas: { webgl: { isContextLost: false }, xr: { isPresenting: { value: false } }, commit() {} },
    inspectionSnapshot: () => ({ companionStructure: {} }), restoreInspectionPayload() {},
    restoreCompanion: async () => {},
    applyInspectionAppearance: async () => {
      builtPresenting = c.canvas.xr.isPresenting.value;
      appearances.push(builtPresenting ? 'immersive' : 'desktop');
    },
    applyInspectionTransform() {}, waitForFrame: () => frames[framesStarted++],
    assertContext() {}, fitDesktopPreview() {}, releaseFigurePlates() {},
    snapshot: () => ({ ready: c.state.status === 'ready' && !c.busy }),
    refreshStructureSubject: () => { subjectQuality = builtPresenting; },
  });
  vm.runInContext(pageFunction('inspectionMutation'), c);
  vm.runInContext(pageFunction('canRebuildForXr'), c);
  vm.runInContext(pageFunction('onXrPresented'), c);
  const exit = source.match(/onLeavingPresentation: (async \(\) => \{[^\n]+\})/)[1];
  const rejected = assert.rejects(c.inspectionMutation(() => {}), /edit failed/);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(appearances, ['desktop']);
  c.canvas.xr.isPresenting.value = true;
  await c.onXrPresented();
  releases[0]();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(appearances, ['desktop', 'immersive']);
  c.canvas.xr.isPresenting.value = false;
  await vm.runInContext(`(${exit})()`, c);
  assert.equal(c.busy, true);
  assert.deepEqual(appearances, ['desktop', 'immersive']);
  releases[1]();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(appearances, ['desktop', 'immersive', 'desktop']);
  assert.equal(c.state.status, 'mutating');
  assert.equal(c.busy, true);
  releases[2](); await rejected;
  assert.equal(c.state.status, 'ready');
  assert.equal(c.busy, false);
  assert.equal(builtPresenting, false);
  assert.equal(subjectQuality, false);
});

test('ordinary failures, lost contexts and missing retained cells never take abort recovery', async () => {
  for (const entry of [{ opted: false, status: 'error' }, { opted: true, status: 'disposed' },
    { opted: true, status: 'context_lost', lost: true }, { opted: true, status: 'error', missing: true }]) {
    const cell = { status: 'ok' };
    const c = vm.createContext({ ...emptyLessonFigureBinding(),
      state: { status: entry.status, error: 'failed' }, busy: false,
      inspectionState: { checkpoint: () => ({ current: {} }), restoreCheckpoint() {}, payload: () => undefined },
      mutate: async () => { throw Error('failed'); }, companionRecord: undefined,
      representation: { ref: 'old', cell }, plugin: { state: { data: { cells: new Map(entry.missing ? [] : [['old', cell]]) } } },
      canvas: { webgl: { isContextLost: Boolean(entry.lost) } },
      restoreInspectionPayload: () => assert.fail('unsafe recovery'),
    });
    vm.runInContext(pageFunction('inspectionMutation'), c);
    await assert.rejects(c.inspectionMutation(() => {}, { recoverRetained: () => entry.opted }), /failed/);
    assert.equal(c.state.status, entry.status);
  }
});

test('frame-gap diagnostics include work after an await that callback timing cannot measure', async () => {
  let clock = 0, callback; const entries = [];
  const session = { frameRate: 72, requestAnimationFrame(fn) { callback = fn; } };
  const record = (kind, detail) => entries.push({ kind, detail });
  const cost = watchFrameCost({ session, record, now: () => clock, intervalMs: 100, scope: {} });
  const transition = beginSceneTransition({ session, operation: 'appearance', record, now: () => clock });
  session.requestAnimationFrame(async () => { clock += 1; await Promise.resolve(); clock += 209; });
  await callback(0);
  session.requestAnimationFrame(() => { clock += 1; }); callback(clock);
  transition.firstFrame(); transition.oldRemoved(); transition.finish(); cost.stop();
  const frame = entries.find(entry => entry.kind === 'frame-cost').detail;
  assert.equal(frame.maxFrameMs, 1);
  assert.equal(frame.maxFrameGapMs, 210);
  assert.equal(frame.reportedFrameRate, 72);
  assert.deepEqual(entries.filter(e => e.kind === 'transition').map(e => e.detail.phase), ['start', 'first-frame', 'old-removed', 'complete']);
  assert.equal(entries.at(-1).detail.worstFrameMs, 210);
  assert.equal(entries.at(-1).detail.frames, 2);
});

test('a failed transition records its reason once without a first-frame claim', () => {
  const records = [];
  const transition = beginSceneTransition({ operation: 'source', now: () => 130,
    record: (kind, detail) => records.push({ kind, detail }) });
  transition.finish('failed', Error('Source placement failed.'));
  transition.finish(); transition.firstFrame();
  assert.deepEqual(records.map(entry => entry.detail.phase), ['start', 'failed']);
  assert.equal(records.at(-1).detail.reason, 'Source placement failed.');
  assert.equal(records.at(-1).detail.firstFrameAtMs, null);
});

test('the deterministic render harness separates aggregate uploads across frames (24 ms to 8 ms)', async t => {
  const before = uploadHarness(); const after = uploadHarness();
  const begin = before.clock; before.canvas.commit(true); const oldWorst = before.clock - begin;
  let worst = 0, previous = after.clock;
  await prepareRepresentationUploads({ canvas: after.canvas, representation: { obj: { data: { repr: after.next } } }, yieldFrame: async () => {
    worst = Math.max(worst, after.clock - previous); await after.yieldFrame(); previous = after.clock;
  } });
  assert.equal(oldWorst, 24); assert.equal(worst, 8);
  t.diagnostic(`Injected three-object upload workload: before worst work=24 ms; after=8 ms; not device or molecule timings.`);
  before.sampler.stop(); after.sampler.stop();
});

const source = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
const pageFunction = name => { const start = source.search(new RegExp(`  (?:async )?function ${name}\\(`)); assert.ok(start >= 0); return source.slice(start, source.indexOf('\n  }', start) + 4); };
test('the production transition guard rejects session exit, session replacement and source replacement', () => {
  for (const change of ['exit', 'session', 'source']) {
    const session = {}, h = vm.createContext({ ...emptyLessonFigureBinding(),
    // This fixture does not paint, so drawing the selection costs it
    // nothing. `render-dedupe-harness.mjs` is the one that counts paints, and
    // its stub runs the real emphasis pass.
    styleLayers: [], ligandOverlay: undefined, companionRecord: undefined, showRetainedPose() {},
    currentSelectionPlan: () => undefined,
    async paintSelectionOverlay() {}, session, state: { generation: 1 }, canvas: { xr: { isPresenting: { value: true } } },
      currentXrSession: () => h.session, failure: (code, message) => Object.assign(Error(message), { code }) });
    vm.runInContext(pageFunction('transitionGuard'), h);
    const guard = h.transitionGuard(() => {}); guard();
    if (change === 'exit') h.canvas.xr.isPresenting.value = false;
    if (change === 'session') h.session = {};
    if (change === 'source') h.state.generation++;
    assert.throws(guard, error => error.code === 'stale_transition');
  }
});
test('all upload batches share the existing render deadline', async () => {
  let clock = 0; const h = vm.createContext({ ...emptyLessonFigureBinding(),
    // This fixture does not paint, so drawing the selection costs it
    // nothing. `render-dedupe-harness.mjs` is the one that counts paints, and
    // its stub runs the real emphasis pass.
    currentSelectionPlan: () => undefined,
    async paintSelectionOverlay() {}, canvas: { xr: { isPresenting: { value: true } } }, now: () => clock,
    XR_FRAME_TIMEOUT_MS: 15000, assertContext() {}, transitionGuard: check => check,
    failure: (code, message) => Object.assign(Error(message), { code }),
    async yieldUploadFrame(deadline) { assert.equal(deadline, 15000); clock += 8000; },
    async prepareRepresentationUploads({ yieldFrame, check }) { check(); await yieldFrame(); check(); await yieldFrame(); check(); },
  });
  vm.runInContext(pageFunction('prepareUploads'), h);
  await assert.rejects(h.prepareUploads({}), error => error.code === 'render_timeout');
});
function sourceSwapHarness(settings = { preserveRoomPlacement: true }) {
  const events = [], visible = new Set(['old', 'companion', 'style', 'new']);
  const repr = name => ({ obj: { data: { repr: name } }, ref: name });
  const candidateSphere = { center: [1, 2, 3], radius: 4 };
  const candidate = { representation: repr('new'), selectionKeys: [], structure: { obj: { data: { boundary: { sphere: candidateSphere } } } } };
  const previous = { representation: repr('old'), structure: { obj: { data: { boundary: { sphere: { center: [0, 0, 0], radius: 1000 } } } } },
    companionRecord: { representation: repr('companion') }, styleLayers: [{ representation: repr('style') }] };
  const focuses = []; let sceneResets = 0;
  const context = vm.createContext({ ...emptyLessonFigureBinding(),
    // This fixture does not paint, so drawing the selection costs it
    // nothing. `render-dedupe-harness.mjs` is the one that counts paints, and
    // its stub runs the real emphasis pass.
    currentSelectionPlan: () => undefined,
    now: () => 0, recordCost() {},
    async paintSelectionOverlay() {}, state: {}, retainedRepresentationCount: 0, styleLayers: previous.styleLayers,
    assertLoad(operation) { if (operation.cancelled) throw Error('cancelled'); },
    plugin: { state: { data: { updateCellState() {} } }, managers: { camera: {
      focusSphere(sphere, options) { focuses.push({ sphere, options }); },
    } } },
    canvas: { xr: { isPresenting: { value: true } }, remove(repr) { visible.delete(repr); events.push(`remove:${repr}`); },
      requestCameraReset() { sceneResets++; }, commit() {} },
    recordBoundingSphere: record => record?.structure?.obj?.data?.boundary?.sphere,
    markRecord() {}, waitForFrame: async () => { events.push('draw'); assert.ok(visible.has('new')); }, checkpoint: async () => {},
  });
  vm.runInContext(pageFunction('showCandidate'), context);
  const operation = { transition: { firstFrame: () => events.push('first-frame'), oldRemoved: () => events.push('old-removed') } };
  return { context, events, visible, operation, focuses, candidateSphere, get sceneResets() { return sceneResets; },
    run: () => context.showCandidate(candidate, previous, settings, operation) };
}
test('the production source swap retains every old representation through the first candidate draw', async () => {
  const h = sourceSwapHarness({}); let frame = 0;
  h.context.waitForFrame = async () => {
    if (++frame === 1) { assert.equal(h.visible.size, 4); assert.equal(h.context.retainedRepresentationCount, 3); }
    else { assert.deepEqual([...h.visible], ['new']); assert.equal(h.context.retainedRepresentationCount, 0); }
    h.events.push('draw');
  };
  await h.run();
  assert.deepEqual(h.events, ['draw', 'first-frame', 'remove:old', 'remove:companion', 'remove:style', 'draw', 'old-removed']);
  assert.equal(h.focuses.length, 1);
  assert.equal(h.focuses[0].sphere, h.candidateSphere, 'camera focus comes from the incoming structure, not the 1000-unit outgoing sphere');
  assert.equal(h.focuses[0].options.extraRadius, 0);
  assert.equal(h.sceneResets, 0, 'source replacement does not request a scene-wide fit');
});
test('cancellation at the first source draw leaves the old drawing for rollback and emits no first-frame claim', async () => {
  const h = sourceSwapHarness();
  h.context.waitForFrame = async () => { h.operation.cancelled = true; };
  await assert.rejects(h.run(), /cancelled/);
  assert.equal(h.visible.size, 4); assert.deepEqual(h.events, []);
});

function appearanceHarness(failFrame) {
  const events = [], live = new Set(['old']), cells = new Map();
  const makeRepr = name => ({ ref: name, checkValid() {},
    cell: { transform: { parent: 'structure' }, params: { values: { type: { name: 'cartoon', params: {} } } } },
    obj: { data: { repr: { name, state: { visible: name === 'old' } } } },
    update() { throw Error('the live representation must remain intact'); },
  });
  const old = makeRepr('old'), next = makeRepr('new'); cells.set('old', old);
  const plugin = { state: { data: { cells, updateCellState(ref, state) { cells.get(ref).obj.data.repr.state.visible = !state.isHidden; }, build() {
    const builder = { to(parent) { assert.equal(parent, 'structure'); return builder; },
      apply(_type, params, options) { assert.equal(options.state.isHidden, true); next.cell.params.values = params; return { selector: next }; },
      delete(ref) { builder.deleted = ref; return builder; },
      async commit() { events.push(`delete:${builder.deleted}`); cells.delete(builder.deleted); live.delete(builder.deleted); },
    }; return builder;
  } } } };
  let frame = 0;
  const records = [];
  const camera = { state: { position: [0, 0, 0], target: [0, 0, -1], up: [0, 1, 0], radius: 1 },
    getSnapshot() { return { ...structuredClone(this.state), tracked: 'unchanged' }; },
    setState(value) {
      assert.equal(value.tracked, 'unchanged');
      for (const key of Object.keys(this.state)) assert.deepEqual(value[key], this.state[key]);
    } };
  const context = vm.createContext({ appearanceWork: undefined, busy: true, retainedPoseHidden: false, frameWaiters: new Set(), ...emptyLessonFigureBinding(),
    styleLayers: [], ligandOverlay: undefined, companionRecord: undefined, showRetainedPose() {},
    // This fixture does not paint, so drawing the selection costs it
    // nothing. `render-dedupe-harness.mjs` is the one that counts paints, and
    // its stub runs the real emphasis pass.
    currentSelectionPlan: () => undefined,
    async paintSelectionOverlay() {}, assertContext() {}, plugin, volume: undefined, representation: old, structure: { obj: { data: {} } },
    crypto: { randomUUID: () => 'new' }, VISIBILITY_LAYER_REF: {}, representationLayerRef,
    builtRepresentation: 'cartoon', appliedGeometryBudget: 'old-budget', retainedRepresentationCount: 0,
    inspectionSnapshot: () => ({ appearance: { representation: 'molecular-surface', color: 'chain-id', opacity: 1, clipping: 0 } }),
    inspectionRepresentationName() {}, INSPECTION_COLORS: new Set(['chain-id']),
    createStructureRepresentationParams: (_plugin, _structure, params) => ({ type: { name: params.type, params: params.typeParams } }),
    representationForBudget: name => name, sessionDeviceClass: () => 'quest2', currentXrSession: () => ({}), structureAtomSites: () => 327,
    xrRepresentationQuality: () => null, xrRepresentationMaterial: () => null, xrColorParams: () => null,
    // The merged function sizes sticks from the atom count; irrelevant to staging order.
    xrBallAndStickParams: () => ({}),
    geometryFor: () => ({ typeParams: {} }), geometryBudgetReceipt: () => 'new-budget',
    Color: value => value, colorNumber: () => 0, now: () => 0,
    beginSceneTransition: () => ({ firstFrame: () => events.push('first-frame'), oldRemoved: () => events.push('old-removed'), finish: phase => records.push(phase ?? 'complete') }),
    StateTransforms: { Representation: { StructureRepresentation3D: 'structure-representation' } },
    async commitRepresentationUpdate() { events.push('build'); assert.ok(live.has('old')); cells.set('new', next); live.add('new'); },
    async prepareUploads(repr) { events.push('uploads'); assert.ok(live.has('old')); assert.equal(repr.obj.data.repr.state.visible, false); },
    async paintCompanion() {}, async rebuildLigandOverlay() {}, ligandOverlayForBudget: () => null, ligandAtomSites: () => 0,
    async rebuildStyleLayers() { assert.equal(context.representation, next); }, currentEmphasisPlan: () => undefined,
    async paintVisibilityLayers() {}, markSelection() {}, state: { selectionKeys: ['canonical-key'] },
    canvas: { camera, xr: { isPresenting: { value: true } }, setProps() {}, commit() {},
      remove(repr) { events.push(`remove:${repr.name}`); live.delete(repr.name); }, add(repr) { live.add(repr.name); } },
    applyInspectionTransform() {}, async rebuildInspectionLabels() {}, async rebuildComponentLabels() {},
    async waitForFrame() {
      assert.equal(next.obj.data.repr.state.visible, true);
      events.push('draw');
      if (++frame === 1) { assert.ok(live.has('old')); assert.equal(context.retainedRepresentationCount, 1); }
      else { assert.ok(!live.has('old')); assert.equal(context.retainedRepresentationCount, 0); }
      if (frame === failFrame) throw Error('render timeout');
    }, recordCost() {},
  });
  vm.runInContext(pageFunction('applyInspectionAppearance'), context);
  return { context, cells, live, events, old, next, records, run: options => context.applyInspectionAppearance(options) };
}

test('an aborted appearance build retires its hidden candidate and preserves the previous view', async () => {
  const h = appearanceHarness(), controller = new AbortController();
  h.context.commitRepresentationUpdate = async (_builder, check) => {
    h.cells.set('new', h.next); h.live.add('new');
    await runTransitionTask(Task.create('surface deadline', async ctx => {
      controller.abort(Error('placement deadline'));
      await ctx.update('cancel surface');
      assert.fail('expired build continued');
    }), check);
  };
  await assert.rejects(h.run({ check: () => controller.signal.throwIfAborted() }), /placement deadline/);
  assert.equal(h.context.representation, h.old);
  assert.deepEqual([...h.live], ['old']);
  assert.deepEqual(h.records, ['failed']);
  assert.ok(!h.events.includes('first-frame'));
});

test('an abort after the candidate draw restores the previous reference and removes the staged cell', async () => {
  const h = appearanceHarness(), controller = new AbortController();
  const draw = h.context.waitForFrame;
  h.context.waitForFrame = async () => { await draw(); controller.abort(Error('placement deadline')); };
  await assert.rejects(h.run({ check: () => controller.signal.throwIfAborted() }), /placement deadline/);
  assert.equal(h.context.representation, h.old);
  assert.equal(h.context.retainedRepresentationCount, 0);
  assert.equal(h.cells.has('new'), false);
  assert.deepEqual([...h.live], ['old']);
  assert.deepEqual(h.records, ['failed']);
  assert.ok(!h.events.includes('first-frame'));
});

test('the production appearance swap builds and paints a hidden candidate before retiring the old cell', async () => {
  const h = appearanceHarness(); await h.run();
  assert.deepEqual(h.events, ['build', 'uploads', 'draw', 'first-frame', 'remove:old', 'draw', 'old-removed', 'delete:old']);
  assert.deepEqual([...h.cells.keys()], ['new']); assert.equal(h.context.representation, h.next);
  assert.equal(h.context.retainedRepresentationCount, 0); assert.deepEqual(h.records, ['complete']);
});

test('a staged appearance clears the menu before reveal and refuses to move a wearer pose', async () => {
  const fit = appearanceHarness();
  let placement = { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 };
  fit.context.inspectionSnapshot = () => ({ appearance: { representation: 'molecular-surface', color: 'chain-id', opacity: 1, clipping: 0 }, placement });
  fit.context.inspectionState = { place: next => { placement = next; fit.events.push('fit'); } };
  fit.context.recordManipulation = () => {};
  fit.context.immersiveSession = { platePoints: () => [[-.5, 0, -1]] };
  fit.context.awaitPlacementViews = async () => {};
  fit.context.resetEntryGeometry = () => ({ subject: [{}] });
  fit.context.wearerPlacement = { holdsPlacement: () => false };
  fit.context.clearHeldPlatePlacement = (requested, { hidden, keepWearer }) => {
    assert.deepEqual(Array.from(hidden), [fit.next.obj.data.repr]);
    assert.equal(hidden[0].state.visible, false);
    assert.equal(keepWearer, false);
    fit.events.push('measure');
    return { ...requested, scale: .5 };
  };
  await fit.run();
  assert.ok(fit.events.indexOf('measure') < fit.events.indexOf('draw'));
  assert.ok(fit.events.indexOf('fit') < fit.events.indexOf('draw'));
  assert.equal(placement.scale, .5);

  const held = appearanceHarness();
  held.context.immersiveSession = { platePoints: () => [[-.5, 0, -1]] };
  held.context.awaitPlacementViews = async () => {};
  held.context.resetEntryGeometry = () => ({ subject: [{}] });
  held.context.inspectionSnapshot = () => ({ appearance: { representation: 'molecular-surface', color: 'chain-id', opacity: 1, clipping: 0 },
    placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } });
  held.context.wearerPlacement = { holdsPlacement: () => true };
  held.context.clearHeldPlatePlacement = (_requested, options) => {
    assert.equal(options.keepWearer, true);
    assert.equal(options.hidden[0].state.visible, false);
    throw Error('This appearance would cover the menu at your placement.');
  };
  await assert.rejects(held.run(), /cover the menu/);
  assert.equal(held.context.representation, held.old);
  assert.ok(!held.events.includes('draw'));
});
for (const frame of [1, 2]) test(`a failed appearance draw ${frame} restores the intact old representation without a success claim`, async () => {
  const h = appearanceHarness(frame); await assert.rejects(h.run(), /render timeout/);
  assert.deepEqual([...h.cells.keys()], ['old']); assert.deepEqual([...h.live], ['old']);
  assert.equal(h.context.representation, h.old); assert.equal(h.context.retainedRepresentationCount, 0);
  assert.equal(h.context.builtRepresentation, 'cartoon'); assert.equal(h.context.appliedGeometryBudget, 'old-budget');
  assert.deepEqual(h.records, ['failed']);
});

test('an opened tour menu retains transport across the production staged appearance swap and the full dwell', async t => {
  const { createRequire } = await import('node:module');
  const { tsImport } = createRequire(new URL('../../plugin/package.json', import.meta.url))('tsx/esm/api');
  const { mountTourPlayer } = await tsImport('../../plugin/src/tour-player.ts', import.meta.url);
  const { tourEndHarness } = await import('./fixtures/tour-end-harness.mjs');
  const { toolbarFrameRuntime, toolbarFrameHarness } = await import('./fixtures/toolbar-frame-runtime.mjs');
  const runtime = await toolbarFrameRuntime();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const h = tourEndHarness();
  const tour = { id: 'staged-menu', title: 'Staged menu', summary: '', steps: [
    { id: 'one', title: 'First chapter', body: 'The chain folds around a pocket. Read every word before moving to the next scene.', appearance: { representation: 'cartoon' } },
    { id: 'two', title: 'Second chapter', body: 'The surface reveals a pocket. Read every word before leaving the restored view.', appearance: { representation: 'molecular-surface' } },
  ] };
  const player = mountTourPlayer({ ...h, tours: [tour] });
  const f = toolbarFrameHarness(runtime);
  const flush = async () => { for (let i = 0; i < 200; i++) await Promise.resolve(); };
  // A card that pages adds its page row on the update it queues after the
  // draw, so the menu is read once that has run.
  const refresh = async () => { f.setState({ tour: player.getState(), voice: { state: 'idle' } }); await f.toolbar.update(); await flush(); };
  const assertOpen = () => {
    assert.equal(f.toolbar.isCollapsed(), false);
    assert.equal(f.toolbar.isDimmed(), false);
    assert.ok(f.toolbar.rows().some(row => row.id === 'done'));
    // The caption goes to the card whole and the card turns its own pages,
    // so a two-sentence chapter has no tour page row to keep.
    assert.ok(!f.toolbar.rows().some(row => row.id === 'page'));
    assert.equal(f.toolbar.menuRows().length, f.toolbar.rows().length);
  };
  try {
    await refresh();
    f.toolbar.runAction({ kind: 'collapse', value: true }); await flush();
    f.toolbar.runAction({ kind: 'collapse', value: false }); await flush();
    await player.select(tour.id); await player.start(false, 0); await refresh(); assertOpen();
    const swap = appearanceHarness(), configure = h.workspace.viewer.inspection.configure;
    const waitForFrame = swap.context.waitForFrame;
    swap.context.waitForFrame = async () => {
      await waitForFrame(); await refresh(); assertOpen();
      assert.equal(player.getState().step, 0, 'the new chapter waits for both replacement draws');
      t.mock.timers.tick(3000);
    };
    h.workspace.viewer.inspection.configure = async patch => { await swap.run(); await configure(patch); };
    await player.next(); await refresh();
    assert.deepEqual(swap.events, ['build', 'uploads', 'draw', 'first-frame', 'remove:old', 'draw', 'old-removed', 'delete:old']);
    assert.equal(player.getState().step, 1); assertOpen();
    assert.ok(f.toolbar.rows().some(row => row.id === 'back'));
    for (let second = 0; second < 14; second++) { t.mock.timers.tick(1000); await refresh(); assertOpen(); }
    f.toolbar.runAction({ kind: 'collapse', value: true }); await flush();
    assert.equal(f.toolbar.isCollapsed(), true, 'the wearer can still close the menu');
  } finally { player.pause(); await f.toolbar.dispose(); h.cleanup(); }
});
