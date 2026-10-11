import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { toolbarFrameRuntime, identity } from './fixtures/toolbar-frame-runtime.mjs';
import { syntheticViews } from './fixtures/component-label-diagnostics.mjs';

const source = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
const message = 'Showing space filling at requested detail; it may run slowly.';
function body(name) {
  const start = source.search(new RegExp(`  (?:async )?function ${name}\\(`));
  assert.ok(start >= 0);
  return source.slice(start, source.indexOf('\n  }', start) + 4);
}
function harness(extra = {}) {
  const shown = [];
  const h = vm.createContext({
    entryGeometryAdvisory: undefined,
    canvas: { webgl: { xr: { session: {} } }, xr: { isPresenting: { value: true } } },
    latestRoomPlacementPose: { headInRoom: identity, labelViews: [{ eye: 'left' }, { eye: 'right' }] },
    busy: false, state: { status: 'ready' }, companionRecoveryActive: false,
    pendingRoomSeat: false, retainedEntryCheckPending: false, retainedPoseHidden: false,
    talkCaption: {}, appliedGeometryBudget: { message },
    onXrPresented: async () => true, canRebuildForXr: () => true, recordCost: () => {},
    showTalkOutcome: (text, holdMs) => { shown.push({ text, holdMs }); return true; }, ...extra,
  });
  vm.runInContext(body('prepareEntryGeometryAdvisory') + '\n' + body('rebuildEntryGeometryAdvisory') + '\n' + body('flushEntryGeometryAdvisory'), h);
  return { h, shown };
}

test('entry rebuild produces the current advisory before a tracked draw can replay it exactly once', async () => {
  let finish;
  const { h, shown } = harness({ appliedGeometryBudget: undefined,
    onXrPresented: () => new Promise(resolve => { finish = resolve; }) });
  const entered = h.prepareEntryGeometryAdvisory();
  h.flushEntryGeometryAdvisory(true); assert.equal(shown.length, 0);
  h.appliedGeometryBudget = { message }; finish(true); await entered;
  h.flushEntryGeometryAdvisory(false); assert.equal(shown.length, 0);
  h.flushEntryGeometryAdvisory(true); h.flushEntryGeometryAdvisory(true);
  assert.deepEqual(shown, [{ text: message, holdMs: 6000 }]);
});

test('caption waits for tracked views, a visible settled scene, and an available outcome sink', async () => {
  const { h, shown } = harness(); await h.prepareEntryGeometryAdvisory();
  for (const key of ['busy', 'companionRecoveryActive', 'pendingRoomSeat', 'retainedEntryCheckPending', 'retainedPoseHidden']) {
    h[key] = true; h.flushEntryGeometryAdvisory(true); h[key] = false;
  }
  h.state.status = 'recovering'; h.flushEntryGeometryAdvisory(true); h.state.status = 'ready';
  h.talkCaption = undefined; h.flushEntryGeometryAdvisory(true); h.talkCaption = {};
  h.latestRoomPlacementPose = null; h.flushEntryGeometryAdvisory(true);
  h.latestRoomPlacementPose = { headInRoom: identity, labelViews: [{ eye: 'left' }] };
  h.flushEntryGeometryAdvisory(true); assert.equal(shown.length, 0);
  h.latestRoomPlacementPose.labelViews = [{ eye: 'none' }];
  const show = h.showTalkOutcome; h.showTalkOutcome = () => false;
  h.flushEntryGeometryAdvisory(true); assert.ok(h.entryGeometryAdvisory);
  h.showTalkOutcome = show; h.flushEntryGeometryAdvisory(true); assert.equal(shown.length, 1);
});

test('a replacement source clears a stale warning or supplies its own current warning', async () => {
  const { h, shown } = harness(); await h.prepareEntryGeometryAdvisory();
  h.appliedGeometryBudget = undefined; h.flushEntryGeometryAdvisory(true);
  h.appliedGeometryBudget = { message }; h.flushEntryGeometryAdvisory(true);
  assert.equal(shown.length, 0, 'a later edit is not mistaken for the initial entry');
  await h.prepareEntryGeometryAdvisory();
  h.appliedGeometryBudget = { message: 'Current source may run slowly.' };
  h.flushEntryGeometryAdvisory(true);
  assert.equal(shown[0].text, 'Current source may run slowly.');
});

test('a failed entry rebuild cannot announce a provisional warning or erase a newer session notice', async () => {
  let reject;
  const { h, shown } = harness({ onXrPresented: () => new Promise((_, fail) => { reject = fail; }) });
  const old = h.prepareEntryGeometryAdvisory();
  h.canvas.webgl.xr.session = {}; h.onXrPresented = async () => true;
  await h.prepareEntryGeometryAdvisory(); const current = h.entryGeometryAdvisory;
  reject(new Error('build failed')); await assert.rejects(old, /build failed/);
  assert.equal(h.entryGeometryAdvisory, current);
  h.flushEntryGeometryAdvisory(true); assert.equal(shown.length, 1);
  h.onXrPresented = async () => { throw Error('failed'); };
  await assert.rejects(h.prepareEntryGeometryAdvisory(), /failed/);
  h.flushEntryGeometryAdvisory(true); assert.equal(shown.length, 1);
});

test('session exit/replacement drops pending entry text; a fresh entry may replay', async () => {
  const { h, shown } = harness(); await h.prepareEntryGeometryAdvisory();
  h.canvas.xr.isPresenting.value = false; h.flushEntryGeometryAdvisory(true);
  assert.equal(h.entryGeometryAdvisory, undefined);
  h.canvas.xr.isPresenting.value = true; await h.prepareEntryGeometryAdvisory();
  h.canvas.webgl.xr.session = {}; h.flushEntryGeometryAdvisory(true); assert.equal(shown.length, 0);
  await h.prepareEntryGeometryAdvisory(); h.flushEntryGeometryAdvisory(true); assert.equal(shown.length, 1);
});

test('entry replay reaches the actual caption representation after the room pose becomes usable', async () => {
  const runtime = await toolbarFrameRuntime(), live = new Set();
  const views = syntheticViews().map(view => {
    const matrix = [...view.transform.matrix], inverse = [...view.transform.inverse.matrix];
    matrix[13] += 1.6; inverse[13] -= 1.6;
    return { ...view, transform: { matrix, inverse: { matrix: inverse } } };
  });
  const card = runtime.createTalkCaption({ plugin: { runTask: task => task.run() },
    presentation: { add: repr => live.add(repr), remove: repr => live.delete(repr) },
    head: () => ({ position: { x: 0, y: 1.6, z: 0 }, matrix: identity }),
    clearance: () => ({ views, renderFromRoom: identity }) });
  runtime.setTalkOutcomeSink((text, holdMs) => card.set({ outcome: text, holdMs }));
  const { h } = harness({ talkCaption: card, showTalkOutcome: runtime.showTalkOutcome });
  try {
    await h.prepareEntryGeometryAdvisory(); h.flushEntryGeometryAdvisory(true);
    await new Promise(resolve => setImmediate(resolve)); card.frame();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(card.text(), message);
    assert.equal([...live].filter(repr => repr.shape?.name === 'Stereofold caption').length, 1);
  } finally { runtime.setTalkOutcomeSink(undefined); await card.dispose(); }
});

test('production entry, tracked-frame and exit callbacks own the replay lifecycle', () => {
  assert.match(source, /onPresented: async \(\) => \{ await prepareEntryGeometryAdvisory\(\); \}/);
  assert.match(source, /flushEntryGeometryAdvisory\(drawn\);\s*xrSnapshotFrame/);
  assert.match(source, /isPresenting\.subscribe\(presenting => \{\s*if \(!presenting\) entryGeometryAdvisory = undefined;/);
});


test('busy desktop-started work cannot consume entry notice before the deferred real XR rebuild', async () => {
  let finish, builds = 0;
  const { h, shown } = harness({ busy: true, appliedGeometryBudget: undefined,
    structure: { obj: { data: {} } }, representation: {}, inspectionState: {},
    companionRecoveryPendingXr: false, refreshStructureSubject: () => {}, snapshot: () => ({}),
    applyInspectionAppearance: () => { builds++; return new Promise(resolve => { finish = resolve; }); },
  });
  vm.runInContext(body('canRebuildForXr') + '\n' + body('onXrPresented'), h);
  await h.prepareEntryGeometryAdvisory();
  assert.equal(h.entryGeometryAdvisory.prepared, false); assert.equal(builds, 0);
  h.busy = false; // desktop operation commits without an immersive receipt
  h.flushEntryGeometryAdvisory(true); h.flushEntryGeometryAdvisory(true);
  assert.equal(builds, 1); assert.equal(shown.length, 0); assert.ok(h.entryGeometryAdvisory);
  h.appliedGeometryBudget = { message }; finish();
  await new Promise(resolve => setImmediate(resolve));
  h.flushEntryGeometryAdvisory(true);
  assert.deepEqual(shown, [{ text: message, holdMs: 6000 }]);
});

test('a deferred entry rebuild failure is bounded and never retried or announced', async () => {
  let builds = 0;
  const { h, shown } = harness({ onXrPresented: async () => false });
  await h.prepareEntryGeometryAdvisory();
  h.onXrPresented = async () => { builds++; throw Error('upload failed'); };
  h.flushEntryGeometryAdvisory(true); await new Promise(resolve => setImmediate(resolve));
  h.flushEntryGeometryAdvisory(true); h.flushEntryGeometryAdvisory(true);
  assert.equal(builds, 1); assert.equal(shown.length, 0); assert.equal(h.entryGeometryAdvisory, undefined);
});

for (const replaceSession of [false, true]) test(`companion recovery credits only its own completed XR rebuild (new session ${replaceSession})`, async () => {
  const releases = [], builds = [];
  const { h, shown } = harness({
    inspectionMutationSettlement: undefined, companionRecoveryPendingXr: false,
    companionRecord: {}, retiredComparisons: new Set(),
    inspectionState: { checkpoint: () => ({ current: {} }), restoreCheckpoint() {}, payload: () => undefined },
    restoreInspectionPayload() {}, inspectionSnapshot: () => ({ companionStructure: {} }),
    restoreCompanion: async () => {}, applyInspectionTransform() {}, assertContext() {},
    snapshot: () => ({}), refreshStructureSubject() {},
    applyInspectionAppearance: async options => { builds.push(options?.componentLabels === false ? 'xr' : 'recovery'); },
    waitForFrame: () => new Promise(resolve => releases.push(resolve)),
  });
  h.canvas.commit = () => {};
  h.canvas.xr.isPresenting.value = false;
  h.mutate = async (_kind, operation) => { await operation(); h.state.status = 'error'; throw Error('edit failed'); };
  vm.runInContext(body('inspectionMutation') + '\n' + body('onXrPresented'), h);
  const rejected = assert.rejects(h.inspectionMutation(() => {}), /edit failed/);
  await new Promise(resolve => setImmediate(resolve));
  h.canvas.xr.isPresenting.value = true;
  await h.prepareEntryGeometryAdvisory();
  const originalNotice = h.entryGeometryAdvisory;
  assert.equal(originalNotice.prepared, false);
  releases[0](); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(builds, ['recovery', 'xr']);
  assert.equal(originalNotice.prepared, false, 'a build before its recovery draw is not credited');
  if (replaceSession) {
    h.canvas.webgl.xr.session = {};
    h.entryGeometryAdvisory = { session: h.canvas.webgl.xr.session, prepared: false, preparing: false };
  }
  releases[1](); await rejected;
  assert.equal(h.entryGeometryAdvisory.prepared, !replaceSession);
  if (!replaceSession) {
    h.flushEntryGeometryAdvisory(true);
    assert.equal(shown.length, 1);
    assert.deepEqual(builds, ['recovery', 'xr'], 'warning replay never repeats the completed recovery rebuild');
  } else {
    assert.equal(originalNotice.prepared, false, 'retired session never receives credit from a later session');
    assert.equal(shown.length, 0);
  }
});
