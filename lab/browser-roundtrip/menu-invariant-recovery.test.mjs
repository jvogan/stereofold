import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { menuInvariantHarness, realAppearanceWorker } from './fixtures/menu-invariant-harness.mjs';
import { compoundOps } from './compound-change.mjs';
import { createInspectionState, normalizeAppearance, normalizePlacement, sameAppearance } from './inspection-state.mjs';
import { placementFitWithinEnvelope } from './placement-fit-envelope.mjs';

function heldCompoundHarness() {
  const t = menuInvariantHarness({ held: true });
  const h = t.h, inspectionState = createInspectionState();
  inspectionState.place(t.placement());
  Object.assign(h, {
    inspectionState,
    inspectionSnapshot: () => inspectionState.snapshot(),
    snapshot: () => inspectionState.snapshot(),
    compoundOps, normalizeAppearance, normalizePlacement, sameAppearance,
    selectedKeys: keys => keys, normalizeStyles: styles => styles ?? [],
    normalizeVisibility: visibility => visibility ?? {},
    inspectionLayersIntact: () => true, selectionLayersUnchanged: () => true, selectionLayerStamp: () => 'clear',
    completeInspectionCapture: () => inspectionState.snapshot(),
    inspectionPayload: () => null, stylesState: [], visibilityState: {}, emphasisState: null, emphasisOrigin: null,
    restoreInspection: async () => {},
  });
  h.plugin.representation = { structure: { registry: { get: () => ({ isApplicable: () => true }) } } };
  h.presentationTransform = () => h.placementTransform(inspectionState.snapshot().placement);
  h.applyInspectionTransform = () => {
    for (const repr of h.scientificRepresentations(true)) for (const object of repr.renderObjects)
      object.values.aTransform.ref.value = h.presentationTransform();
    t.events.push('transform');
  };
  const source = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('  async function applyCompoundInspection(');
  vm.runInContext(source.slice(start, source.indexOf('\n  }', start) + 4), h);
  return { ...t, placement: () => inspectionState.snapshot().placement };
}

test('explicit placement in a held compound refuses a clearance adjustment and preserves the requested pose', async () => {
  const t = heldCompoundHarness(), before = t.h.inspectionSnapshot(), requested = { translation: [0, 0, -1.2], scale: 1 };
  await assert.rejects(t.h.applyCompoundInspection({ patch: { ops: [
    { kind: 'placement', patch: requested }, { kind: 'appearance', patch: { background: '#123456' } },
  ] } }), /requested room placement would cover the menu/);
  const after = t.h.inspectionSnapshot();
  assert.deepEqual(after.placement, before.placement, 'the failed compound keeps the wearer’s committed room pose');
  assert.deepEqual(after.appearance, before.appearance, 'the appearance change rolls back with the rejected placement');
  assert.ok(!t.events.some(event => event?.kind === 'outcome' && event.action === 'compound' && event.status === 'adjusted'));
  assert.equal(t.h.wearerPlacement.holdsPlacement(), true, 'the existing wearer hold survives refusal');
  assert.equal(t.h.frameWaiters.size, 0);
});

test('held compound without placement refuses an appearance that needs a fit and keeps the wearer pose', async () => {
  const t = heldCompoundHarness(), before = t.placement(), appearance = t.h.inspectionSnapshot().appearance;
  await assert.rejects(t.h.applyCompoundInspection({ patch: { ops: [
    { kind: 'appearance', patch: { background: '#123456' } }, { kind: 'selection', patch: { selectionKeys: [] } },
  ] } }), /would cover the menu/);
  assert.deepEqual(t.placement(), before);
  assert.deepEqual(t.h.inspectionSnapshot().appearance, appearance, 'the compound rolls back atomically');
  assert.ok(!t.events.some(event => event.kind === 'outcome' && event.status === 'adjusted'));
});

for (const held of [false, true]) test(`scoped surface with unchanged base is measured hidden; wearer owned=${held}`, async () => {
  const t = menuInvariantHarness({ held });
  const before = t.placement();
  if (held) {
    await assert.rejects(t.appearance(), /would cover the menu/);
    assert.deepEqual(t.placement(), before);
    assert.equal(t.h.styleLayers[0].representation.obj.data.repr.state.visible, false);
    assert.ok(!t.events.includes('reveal-cell'));
  } else {
    await t.appearance();
    assert.ok(t.events.indexOf('fit') < t.events.indexOf('reveal-cell'));
    assert.ok(t.events.indexOf('reveal-cell') < t.events.indexOf('draw'));
    assert.equal(t.h.frameWaiters.size, 0, 'real draw gate completed');
    assert.notDeepEqual(t.placement(), before);
  }
  assert.equal(t.reads(), 1);
  assert.equal(t.fits(), 1);
});

for (const action of ['Fit', 'Reset', 'placement']) test(`hidden unsafe pose recovers through ${action} before the real draw gate`, async () => {
  const t = menuInvariantHarness({ held: true, half: .7 });
  await t.h.checkRetainedEntryPose();
  assert.equal(t.h.retainedPoseHidden, true);
  if (action === 'placement') await t.h.placeInspection({ translation: [0, 0, -4], scale: .25 });
  else await t.h.seatStructureForEntry({ resetMenu: action === 'Reset' });
  assert.equal(t.h.retainedPoseHidden, false);
  assert.ok(t.events.indexOf('reveal') < t.events.indexOf('draw'));
  assert.equal(t.h.frameWaiters.size, 0);
});

test('automatic refusal checks the retained host pose, hides unsafe geometry, then Fit recovers through the real gate', async () => {
  const t = menuInvariantHarness({ half: .7 });
  // Enclosing glass makes the real automatic fitter refuse all candidates.
  const menu = t.h.immersiveSession.platePoints;
  t.h.immersiveSession.platePoints = () => [-5, 5].flatMap(x => [-5, 5].map(y => [x, y, -1]));
  t.h.settleInRoom({}, {});
  assert.match(t.h.roomEntry.seatRefusal, /Could not reset/);
  assert.equal(t.h.pendingRoomSeat, false);
  assert.equal(t.h.retainedPoseHidden, true);
  assert.equal(t.live.size, 0);
  await t.h.retainedEntryCheck;
  t.h.immersiveSession.platePoints = menu;
  await t.h.seatStructureForEntry();
  assert.equal(t.h.retainedPoseHidden, false);
  assert.equal(t.h.frameWaiters.size, 0);
});

for (const reason of ['session ended', 'viewer disposed']) test(`eye wait drains without another XR frame: ${reason}`, async () => {
  const t = menuInvariantHarness();
  t.h.latestRoomPlacementPose = null;
  const waiting = t.h.awaitPlacementViews();
  if (reason === 'session ended') { t.h.canvas.xr.isPresenting.value = false; t.h.beginRoomEntry(false); }
  else await t.h.dispose();
  await assert.rejects(waiting, reason === 'session ended' ? /session ended/ : /viewer was disposed/);
  assert.equal(t.h.placementViewWaiters.size, 0);
});
test('non-XR eye wait resolves without tracking', async () => {
  const t = menuInvariantHarness();
  t.h.canvas.xr.isPresenting.value = false; t.h.latestRoomPlacementPose = null;
  await t.h.awaitPlacementViews();
  assert.equal(t.h.placementViewWaiters.size, 0);
});

for (const held of [false, true]) test(`new companion waits for the single final appearance fit; wearer owned=${held}`, async () => {
  const t = menuInvariantHarness({ held });
  await t.h.restoreCompanion({ sourceSha256: 'synthetic', assemblyId: '1', appearance: { representation: 'cartoon' } });
  assert.equal(t.h.companionRecord.representation.obj.data.repr.state.visible, false);
  assert.ok(!t.events.includes('reveal-cell'));
  if (held) {
    await assert.rejects(t.appearance(), /would cover the menu/);
    assert.equal(t.h.companionRecord.representation.obj.data.repr.state.visible, false);
  } else {
    await t.appearance();
    assert.equal(t.h.companionRecord.representation.obj.data.repr.state.visible, true);
    assert.equal(t.h.frameWaiters.size, 0);
    t.hide(); t.h.canvas.remove(t.h.companionRecord.representation.obj.data.repr);
    t.h.showRetainedPose();
    assert.ok(t.live.has(t.h.companionRecord.representation.obj.data.repr));
  }
  assert.equal(t.fits(), 1); assert.equal(t.reads(), 1);
});

// This suite uses actual worker_threads through the production reveal/draw gate.
// Constructor failure and an actual worker-thread crash both refuse in XR.
for (const mode of ['constructor', 'error']) test(`worker ${mode} failure refuses through the real reveal gate in XR`, async () => {
  const diagnostics = [];
  const t = menuInvariantHarness({ workerOptions: { record: detail => diagnostics.push(detail), makeWorker: () => {
    if (mode === 'constructor') throw Error('CSP blocked worker');
    const worker = new Worker(`throw Error('Worker script failed');`, { eval: true });
    const adapter = { postMessage() {}, terminate: () => worker.terminate() };
    worker.on('error', error => adapter.onerror(error));
    return adapter;
  } } });
  const before = t.placement();
  await assert.rejects(t.appearance(), /headset browser could not run the fitting helper/);
  assert.deepEqual(t.placement(), before);
  assert.equal(t.h.frameWaiters.size, 0);
  assert.ok(!t.events.includes('reveal-cell'));
  assert.ok(t.base.obj.data.repr.state.visible, 'previous base appearance retained');
  assert.match(t.caption(), /headset browser could not run the fitting helper/);
  assert.ok(diagnostics.some(d => d.path === 'worker-unavailable-xr' && d.outcome === 'refused'));
  assert.ok(!diagnostics.some(d => d.path === 'main-thread-fallback'));
});

for (const action of ['Reset', 'Fit', 'Done']) test(`worker refusal at saved-pose entry and host appearance still permits ${action}`, async () => {
  const t = menuInvariantHarness({ held: true, productionRecovery: true,
    workerOptions: { makeWorker: () => { throw Error('CSP blocked worker'); } } });
  t.h.inspectionState.place({ translation: [0, 0, -2], scale: .25 });
  const saved = t.placement();
  await t.h.checkRetainedEntryPose();
  assert.equal(t.h.state.status, 'ready', t.h.state.error);
  assert.equal(t.h.retainedPoseHidden, true);
  await assert.rejects(t.h.inspectionMutation(() => t.h.applyInspectionAppearance()),
    /headset browser could not run the fitting helper/);
  assert.equal(t.h.state.status, 'ready', t.h.state.error);
  assert.equal(t.h.state.error, null);
  assert.equal(t.h.retainedPoseHidden, true);
  assert.deepEqual(t.placement(), saved, 'the refused host edit preserves the wearer pose');
  if (action === 'Done') {
    t.h.roomEntry = null;
    await t.h.restoreJourneySeat({ scene: { camera: {} } });
  } else await t.h.seatStructureForEntry({ resetMenu: action === 'Reset' });
  assert.equal(t.h.state.status, 'ready', t.h.state.error);
  assert.equal(t.h.retainedPoseHidden, false);
  assert.ok(t.live.has(t.base.obj.data.repr));
  if (action === 'Done') assert.deepEqual(t.placement(), saved, 'an already-clear Done keeps the saved pose');
});

test('companion and saved pose survive a refused host appearance; Reset can reveal them', async () => {
  const t = menuInvariantHarness({ held: true, productionRecovery: true,
    workerOptions: { makeWorker: () => { throw Error('CSP blocked worker'); } } });
  const companion = { sourceSha256: 'synthetic', assemblyId: '1', appearance: { representation: 'cartoon' } };
  await t.h.restoreCompanion(companion);
  const snapshot = t.h.inspectionSnapshot;
  let appearance = snapshot().appearance;
  t.h.INSPECTION_COLORS.add('uniform');
  t.h.inspectionSnapshot = () => ({ ...snapshot(), appearance, companionStructure: companion });
  const checkpoint = t.h.inspectionState.checkpoint;
  const restoreCheckpoint = t.h.inspectionState.restoreCheckpoint;
  t.h.inspectionState.checkpoint = () => ({ ...checkpoint(), current: { companionStructure: companion,
    appearance: structuredClone(appearance) } });
  t.h.inspectionState.restoreCheckpoint = saved => { restoreCheckpoint(saved); appearance = saved.current.appearance; };
  t.h.inspectionState.place({ translation: [0, 0, -2], scale: .25 });
  const saved = t.placement();
  assert.ok(t.h.companionRecord);
  assert.ok(t.h.inspectionState.checkpoint().current.companionStructure);
  await t.h.checkRetainedEntryPose();
  assert.equal(t.h.retainedPoseHidden, true);
  assert.equal(t.h.state.status, 'ready');
  await assert.rejects(t.h.inspectionMutation(() => {
    appearance = { ...appearance, color: 'uniform', uniformColor: '#ff0000' };
    return t.h.applyInspectionAppearance();
  }), error => {
    assert.match(error.message, /headset browser could not run the fitting helper/);
    assert.equal(error.fitRefusal, true);
    return true;
  });
  assert.equal(t.h.state.status, 'ready', t.h.state.error);
  assert.equal(t.h.state.error, null);
  assert.deepEqual(t.placement(), saved);
  assert.equal(t.h.inspectionSnapshot().appearance.color, 'chain-id', 'the host appearance edit rolled back');
  assert.equal(t.h.retainedPoseHidden, true);
  assert.equal(t.live.size, 0);
  await t.h.seatStructureForEntry({ resetMenu: true });
  assert.equal(t.h.state.status, 'ready');
  assert.equal(t.h.retainedPoseHidden, false);
  assert.ok(t.live.has(t.base.obj.data.repr));
  assert.ok(t.live.has(t.h.companionRecord.representation.obj.data.repr));
});

test('session exit during an appearance fit restores the desktop structure without menu blame', async () => {
  const t = menuInvariantHarness({ productionRecovery: true,
    workerOptions: { makeWorker: () => ({ postMessage() {}, terminate() {} }) } });
  const before = t.placement();
  const running = t.h.inspectionMutation(() => t.h.applyInspectionAppearance());
  const rejected = assert.rejects(running, /session ended/);
  while (!t.h.placementViewWaiters.size) await new Promise(resolve => setImmediate(resolve));
  t.h.canvas.xr.isPresenting.value = false;
  t.h.beginRoomEntry(false);
  await rejected;
  assert.equal(t.h.state.status, 'ready', t.h.state.error);
  assert.equal(t.h.state.error, null);
  assert.deepEqual(t.placement(), before);
  assert.equal(t.h.retainedPoseHidden, false);
  assert.ok(t.live.has(t.base.obj.data.repr));
  assert.doesNotMatch(t.caption(), /menu/i);
});

test('Done reveals an already-clear saved pose after an entry worker refusal', async () => {
  const t = menuInvariantHarness({ held: true, productionRecovery: true,
    workerOptions: { makeWorker: () => { throw Error('CSP blocked worker'); } } });
  t.h.inspectionState.place({ translation: [0, 0, -2], scale: .25 });
  await t.h.checkRetainedEntryPose();
  assert.equal(t.h.retainedPoseHidden, true);
  t.h.roomEntry = null;
  await t.h.restoreJourneySeat({ scene: { camera: {} } });
  assert.equal(t.h.retainedPoseHidden, false);
  assert.equal(t.h.state.status, 'ready');
  assert.ok(t.live.has(t.base.obj.data.repr));
});

test('menu fit refusal during a host edit leaves synchronous Fit available', async () => {
  const t = menuInvariantHarness({ held: true, half: .7, productionRecovery: true });
  await t.h.checkRetainedEntryPose();
  assert.equal(t.h.retainedPoseHidden, true);
  await assert.rejects(t.h.inspectionMutation(() => t.h.applyInspectionAppearance()), /would cover the menu/);
  assert.equal(t.h.state.status, 'ready');
  await t.h.seatStructureForEntry();
  assert.equal(t.h.retainedPoseHidden, false);
  assert.equal(t.h.state.status, 'ready');
});

test('a slow fit remains hidden beyond two seconds and completes through the draw gate', async () => {
  let terminated = 0;
  const t = menuInvariantHarness({ workerOptions: { makeWorker: () => {
    const worker = realAppearanceWorker(), post = worker.postMessage, terminate = worker.terminate;
    let timer;
    worker.postMessage = (data, transfers) => { timer = setTimeout(() => post(data, transfers), 2300); };
    worker.terminate = () => { terminated++; clearTimeout(timer); terminate(); };
    return worker;
  } } });
  const running = t.appearance();
  await new Promise(resolve => setTimeout(resolve, 2100));
  assert.equal(t.h.styleLayers[0].representation.obj.data.repr.state.visible, false);
  assert.ok(!t.events.includes('reveal-cell'));
  assert.equal(t.caption(), 'Checking the structure against the menu…', 'captionText renders the fit while neither talking nor sending');
  assert.equal(t.h.placementViewWaiters.size, 1);
  await running;
  assert.equal(terminated, 1);
  assert.equal(t.h.frameWaiters.size, 0);
  assert.ok(t.events.includes('reveal-cell'));
});

for (const cause of ['supersession', 'session end', 'disposal']) test(`pending appearance cancels on ${cause} without revealing a new fit`, async () => {
  let terminated = 0;
  const t = menuInvariantHarness({ workerOptions: { makeWorker: () => ({ postMessage() {}, terminate() { terminated++; } }) } });
  const before = t.placement(), running = t.appearance();
  const rejected = assert.rejects(running, error => {
    if (cause === 'disposal') {
      // The source/generation owner cancels before touching a disposed UI;
      // require its semantic cancellation code rather than a word match.
      assert.equal(error.code, 'FIT_CANCELLED');
      assert.match(error.message, /superseded/);
    } else assert.match(error.message, /cancelled|session ended|disposed/);
    return true;
  });
  while (!t.h.placementViewWaiters.size) await new Promise(resolve => setImmediate(resolve));
  const outcomes = () => t.events.filter(event => event && typeof event === 'object' && Object.hasOwn(event, 'outcome'));
  const beforeCancellationOutcomes = structuredClone(outcomes());
  if (cause === 'supersession') await t.h.supersedePlacementFit();
  else if (cause === 'session end') { t.h.canvas.xr.isPresenting.value = false; t.h.beginRoomEntry(false); }
  else await t.h.dispose();
  await rejected;
  assert.equal(terminated, 1);
  assert.deepEqual(t.placement(), before);
  assert.ok(!t.events.includes('reveal-cell'));
  assert.equal(t.h.placementViewWaiters.size, 0);
  if (cause === 'session end') {
    assert.ok(t.live.has(t.base.obj.data.repr), 'desktop keeps the previous structure');
    assert.doesNotMatch(t.caption(), /menu/i);
  } else if (cause === 'disposal') {
    assert.equal(t.h.state.status, 'disposed');
    assert.deepEqual(outcomes(), beforeCancellationOutcomes, 'a cancelled owner must not publish an outcome after disposal');
  } else assert.ok(t.events.some(e => /cancelled|disposed/.test(e.outcome ?? '')));
});

for (const path of ['entry', 'mutation', 'wearer placement']) test(`${path} retained check dispatch reads zero vertices and reveals only after proof`, async () => {
  let reads = 0, answer, data;
  const vertices = new Proxy(new Float32Array(150000 * 3), {
    get(target, key) { if (/^\d+$/.test(String(key))) reads++; return Reflect.get(target, key, target); },
  });
  const t = menuInvariantHarness({ vertices, workerOptions: { makeWorker: () => ({
    postMessage(message) { data = message; answer = () => this.onmessage({ data: { fitted: message.seat } }); }, terminate() {},
  }) } });
  t.hide();
  const running = path === 'entry' ? t.h.checkRetainedEntryPose()
    : path === 'mutation' ? t.h.mutate('inspection', async () => {})
    : t.h.placeInspection({ scale: .25, translation: [0, 0, -4] }, 'place', { wearer: true });
  while (!answer) await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 0, 'no indexed vertex read during frame/press or pending recovery');
  assert.equal(t.h.retainedPoseHidden, true);
  assert.equal(t.live.size, 0);
  if (path === 'entry') {
    assert.equal(t.h.retainedEntryCheckPending, true);
    assert.equal(t.h.checkRetainedEntryPose(), running, 'frames reuse the pending check');
    const source = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
    const start = source.indexOf('          if (latestRoomPlacementPose && typeof retainedEntryCheckPending');
    const end = source.indexOf('          if (latestRoomPlacementPose && pendingRoomLabels', start);
    t.h.pendingRoomSeat = false;
    vm.runInContext(source.slice(start, end), t.h);
    assert.equal(t.h.retainedEntryCheckPending, true, 'the actual frame callback cannot clear a pending check');
    assert.equal(t.h.roomEntry.seat, undefined, 'entry adoption cannot publish an unchecked pose');
  }
  assert.equal(data.restoreSaved, true);
  answer(); await running;
  assert.equal(t.h.retainedPoseHidden, false);
  assert.equal(t.h.retainedEntryCheckPending, false);
  assert.equal(reads, 0, 'reveal is bounded work too');
});

for (const first of ['appearance', 'retained-pose']) test(`${first} and the other job kind coexist through the real worker and draw gate`, async () => {
  const queued = [], diagnostics = [];
  const t = menuInvariantHarness({ workerOptions: { record: detail => diagnostics.push(detail), makeWorker: () => {
    const worker = realAppearanceWorker(), post = worker.postMessage;
    worker.postMessage = (data, transfers) => queued.push(() => post(data, transfers));
    return worker;
  } } });
  const waitUntil = async predicate => { while (!predicate()) await new Promise(resolve => setImmediate(resolve)); };
  let appearance, retained;
  if (first === 'appearance') { appearance = t.appearance(); await waitUntil(() => queued.length === 1); retained = t.h.checkRetainedEntryPose(); }
  else { retained = t.h.checkRetainedEntryPose(); await waitUntil(() => queued.length === 1); appearance = t.appearance(); }
  await waitUntil(() => queued.length === 2);
  assert.deepEqual([...t.h.placementViewWaiters].map(check => check.fitKind).sort(), ['appearance', 'retained-pose']);
  assert.equal(t.h.retainedPoseHidden, true);
  assert.ok(!t.events.includes('reveal-cell'));
  // Subsequent checks/retries use real workers immediately.
  t.h.fitAppearanceInWorker = (await import('./appearance-fit.mjs')).fitAppearanceInWorker;
  // Keep the adapter (Node does not expose a browser Worker globally).
  const fit = t.h.fitAppearanceInWorker;
  t.h.fitAppearanceInWorker = (options, policy) => fit(options, { ...policy, makeWorker: realAppearanceWorker,
    record: detail => diagnostics.push(detail) });
  queued[first === 'retained-pose' ? 0 : 1]();
  await retained;
  assert.equal(t.caption(), 'Checking the structure against the menu…', 'one completed kind cannot clear another kind’s progress');
  queued[first === 'appearance' ? 0 : 1]();
  await Promise.all([appearance, retained]);
  assert.ok(!diagnostics.some(d => /cancelled/.test(d.reason ?? '')), 'the kinds do not supersede one another');
  assert.equal(t.h.placementViewWaiters.size, 0);
  assert.equal(t.h.frameWaiters.size, 0);
  assert.equal(t.h.retainedPoseHidden, false);
  assert.ok(t.events.includes('draw'));
});

test('a superseded retained check adopts the newer proof before revealing', async () => {
  const queued = [];
  let creations = 0;
  const t = menuInvariantHarness({ workerOptions: { makeWorker: () => {
    const worker = realAppearanceWorker(), post = worker.postMessage;
    if (++creations <= 2) worker.postMessage = (data, transfers) => queued.push(() => post(data, transfers));
    return worker;
  } } });
  const retained = t.h.checkRetainedEntryPose();
  while (queued.length < 1) await new Promise(resolve => setImmediate(resolve));
  const newer = t.h.clearHeldPlatePlacement(t.placement(), { keepWearer: true, kind: 'retained-pose' });
  while (queued.length < 2) await new Promise(resolve => setImmediate(resolve));
  assert.equal(t.h.retainedPoseHidden, true);
  assert.equal(t.h.retainedEntryCheckPending, true);
  assert.equal(t.h.placementViewWaiters.size, 1);
  queued[1]();
  await Promise.all([retained, newer]);
  assert.equal(creations, 2, 'the newer proof needs no redundant third worker');
  assert.equal(t.h.retainedPoseHidden, false);
  assert.equal(t.h.retainedEntryCheckPending, false);
  await t.h.mutate('inspection', async () => {});
  assert.equal(t.h.frameWaiters.size, 0);
  assert.ok(t.events.indexOf('reveal') < t.events.indexOf('draw'));
});

test('ten hidden-pose host checks settle without retry amplification or duplicate reveal', async () => {
  const queued = [];
  let creations = 0, releaseBurst = false;
  const t = menuInvariantHarness({ workerOptions: { makeWorker: () => {
    creations++;
    const worker = realAppearanceWorker(), post = worker.postMessage;
    worker.postMessage = (data, transfers) => releaseBurst ? post(data, transfers)
      : queued.push(() => post(data, transfers));
    return worker;
  } } });
  const checks = [t.h.checkRetainedEntryPose()];
  while (queued.length < 1) await new Promise(resolve => setImmediate(resolve));
  for (let edit = 0; edit < 9; edit++)
    checks.push(t.h.clearHeldPlatePlacement(t.placement(), { keepWearer: true, kind: 'retained-pose' }));
  assert.equal(t.h.retainedPoseHidden, true);
  const atBurst = creations;
  assert.equal(atBurst, 10, 'one initial job per retained check before settlement');
  releaseBurst = true;
  queued.at(-1)();
  await Promise.all(checks);
  assert.ok(creations - atBurst <= 2, 'settlement may cause at most two further worker jobs');
  assert.equal(t.events.filter(event => event === 'reveal').length, 1);
  assert.equal(t.h.retainedPoseHidden, false);
  assert.equal(t.h.placementViewWaiters.size, 0);
});

test('a newer retained proof reruns only after the pose changes during its check', async () => {
  const queued = [];
  let creations = 0;
  const t = menuInvariantHarness({ workerOptions: { makeWorker: () => {
    const worker = realAppearanceWorker(), post = worker.postMessage;
    if (++creations <= 2) worker.postMessage = (data, transfers) => queued.push(() => post(data, transfers));
    return worker;
  } } });
  const first = t.h.checkRetainedEntryPose();
  while (queued.length < 1) await new Promise(resolve => setImmediate(resolve));
  const newer = t.h.clearHeldPlatePlacement(t.placement(), { keepWearer: true, kind: 'retained-pose' });
  while (queued.length < 2) await new Promise(resolve => setImmediate(resolve));
  t.h.inspectionState.place({ translation: [0, 0, -2], scale: .25 });
  t.h.applyInspectionTransform();
  queued[1]();
  await Promise.all([first, newer]);
  assert.equal(creations, 3, 'the changed pose requires one fresh proof');
  assert.equal(t.h.retainedPoseHidden, false);
  assert.equal(t.events.filter(event => event === 'reveal').length, 1);
});

test('page solver receipts pass the host consistency envelope', async () => {
  const { placementFitWithinEnvelope } = await import('./placement-fit-envelope.mjs');
  const reference = menuInvariantHarness(), before = reference.placement();
  await reference.appearance();
  assert.equal(placementFitWithinEnvelope(before, reference.placement(), reference.h.lastPlacementFitEvidence), true);

});

for (const mode of ['constructor', 'error']) test(`desktop ${mode} fallback admits the exact solve through the real draw gate`, async () => {
  const { fitAppearanceInWorker } = await import('./appearance-fit.mjs');
  const { solveAppearanceFit } = await import('./appearance-fit-worker.mjs');
  const t = menuInvariantHarness(), h = t.h, diagnostics = [];
  const pose = h.latestRoomPlacementPose;
  const options = { seat: t.placement(), fit: true, points: h.immersiveSession.platePoints(),
    ...pose, cameraScale: 1, center: [0, 0, 0], radius: 1,
    geometry: { objects: t.base.obj.data.repr.renderObjects,
      fromPlacement: h.presentationTransform(), toPlacement: h.presentationTransform(), views: pose.labelViews } };
  const expected = solveAppearanceFit(options);
  h.canvas.xr.isPresenting.value = false;
  t.hide();
  await h.mutate('inspection', async () => {
    const fitted = await fitAppearanceInWorker(options, {
      isPresenting: () => h.canvas.xr.isPresenting.value, record: detail => diagnostics.push(detail),
      makeWorker: () => {
        if (mode === 'constructor') throw Error('Worker unavailable');
        const worker = new Worker(`throw Error('Worker crashed');`, { eval: true });
        const adapter = { postMessage() {}, terminate: () => worker.terminate() };
        worker.on('error', error => adapter.onerror(error));
        return adapter;
      },
    });
    assert.deepEqual(fitted, expected);
    h.inspectionState.place(fitted); h.applyInspectionTransform(); h.showRetainedPose();
  });
  assert.ok(diagnostics.some(d => d.path === 'main-thread-fallback' && d.outcome === 'fitted'));
  assert.equal(h.frameWaiters.size, 0);
  assert.ok(t.events.indexOf('reveal') < t.events.indexOf('draw'));
});


for (const concurrent of [false, true]) test(`no held menu completes placement without orphaned progress: concurrent fit=${concurrent}`, async () => {
  const t = menuInvariantHarness();
  let measured = false;
  t.h.immersiveSession.platePoints = () => {
    measured = true;
    assert.equal(t.caption(), 'Checking the structure against the menu…', 'publish before measuring because the caption can change plate geometry');
    return [];
  };
  const otherFit = () => {};
  otherFit.fitKind = 'retained-pose';
  if (concurrent) t.h.placementViewWaiters.add(otherFit);
  const requested = t.placement();
  const accepted = await t.h.clearHeldPlatePlacement(requested);
  assert.equal(accepted, requested, 'no hidden menu means no placement adjustment');
  assert.equal(measured, true);
  assert.equal(t.fits(), 0, 'the early return never starts a worker');
  assert.equal(t.h.placementViewWaiters.size, concurrent ? 1 : 0);
  if (concurrent) {
    assert.equal(t.caption(), 'Checking the structure against the menu…', 'an outstanding fit retains its progress');
    t.h.placementViewWaiters.delete(otherFit);
    await t.h.clearHeldPlatePlacement(requested);
  }
  assert.notEqual(t.caption(), 'Checking the structure against the menu…', 'nothing remains pending when no fit owns progress');
});

for (const missing of ['pose', 'sphere']) for (const concurrent of [false, true])
  test(`synchronous fit refusal clears only unowned progress: missing=${missing}, concurrent=${concurrent}`, () => {
    const t = menuInvariantHarness();
    if (missing === 'pose') t.h.latestRoomPlacementPose = null;
    else t.h.loadedSphere = () => null;
    const otherFit = () => {};
    otherFit.fitKind = 'retained-pose';
    if (concurrent) t.h.placementViewWaiters.add(otherFit);
    assert.throws(() => t.h.clearHeldPlatePlacement(t.placement()), missing === 'pose'
      ? /both eye views and the held menu are measurable/ : /geometry is measurable/);
    assert.equal(t.fits(), 0);
    assert.equal(t.h.placementViewWaiters.size, concurrent ? 1 : 0);
    assert.equal(t.caption() === 'Checking the structure against the menu…', concurrent);
  });

test('appearance progress measures the plate after its own caption changes it', async () => {
  const t = menuInvariantHarness();
  const set = t.h.talkCaption.set;
  t.h.talkCaption.set = detail => {
    set(detail);
    if (detail.progress) t.h.immersiveSession.platePoints = () => [[-1,-1,-1],[-1,1,-1],[-.9,-1,-1],[-.9,1,-1]];
  };
  await t.appearance();
  assert.ok(!t.events.some(event => event.outcome === 'stale'));
  assert.ok(t.events.includes('draw'));
});

for (const clear of [true, false]) test(`stale appearance rollback proves current clearance before ready: clear=${clear}`, async () => {
  const t = menuInvariantHarness({ productionRecovery: true });
  const fit = t.h.fitAppearanceInWorker;
  let calls = 0;
  t.h.fitAppearanceInWorker = async (options, policy) => {
    const own = ++calls;
    const result = await fit(options, policy);
    if (own <= 2) t.h.immersiveSession.platePoints = () => clear || own === 1
      ? [[-3-own,-1,-1],[-3-own,1,-1],[-2-own,-1,-1],[-2-own,1,-1]]
      : [[-5-own,-5,-1],[-5-own,5,-1],[5,-5,-1],[5,5,-1]];
    return result;
  };
  const original = t.placement();
  await assert.rejects(t.h.inspectionMutation(() => t.h.applyInspectionAppearance()));
  assert.equal(calls, 3, 'one menu retry, then one bounded fresh proof on the restored geometry');
  assert.deepEqual(t.placement(), original, 'rollback never moves the retained pose');
  assert.equal(t.h.state.status, 'ready', 'a retained hidden scene still admits Reset/Fit');
  assert.equal(t.h.retainedPoseHidden, !clear);
  assert.equal(t.live.has(t.base.obj.data.repr), clear);
  if (clear) assert.ok(t.events.includes('draw'));
  else {
    t.h.fitAppearanceInWorker = fit;
    t.h.immersiveSession.platePoints = () => [[-3,-1,-1],[-3,1,-1],[-2,-1,-1],[-2,1,-1]];
    await t.h.seatStructureForEntry({ resetMenu: true });
    assert.equal(t.h.retainedPoseHidden, false);
    assert.equal(t.h.state.status, 'ready');
    assert.equal(t.h.busy, false);
    assert.equal(t.h.placementViewWaiters.size, 0);
    assert.equal(t.h.frameWaiters.size, 0);
  }
});


for (const edge of ['menu', 'context-loss']) test(`stale appearance recovery cannot reveal after ${edge} changes again`, async () => {
  const t = menuInvariantHarness({ productionRecovery: true });
  const fit = t.h.fitAppearanceInWorker;
  let calls = 0;
  t.h.fitAppearanceInWorker = async (options, policy) => {
    const own = ++calls;
    const result = await fit(options, policy);
    t.h.immersiveSession.platePoints = () => [[-3-own,-1,-1],[-3-own,1,-1],[-2-own,-1,-1],[-2-own,1,-1]];
    if (own === 3 && edge === 'context-loss') t.h.canvas.webgl.isContextLost = true;
    return result;
  };
  await assert.rejects(t.h.inspectionMutation(() => t.h.applyInspectionAppearance()));
  assert.equal(calls, edge === 'menu' ? 4 : 3, 'at most one fresh-menu retry per original or recovery proof');
  assert.equal(t.h.state.status, edge === 'context-loss' ? 'context_lost' : 'ready');
  assert.equal(t.h.retainedPoseHidden, true);
  assert.equal(t.live.size, 0);
  if (edge === 'context-loss') assert.match(t.caption(), /structure remains hidden until the graphics context recovers\./);
  if (edge === 'menu') {
    assert.match(t.caption(), /structure remains hidden\. Press Reset or Fit to show it\./);
    assert.equal(t.h.state.error, null);
    t.h.fitAppearanceInWorker = fit;
    await t.h.seatStructureForEntry({ resetMenu: true });
    assert.equal(t.h.retainedPoseHidden, false, 'the offered Reset action really recovers the hidden scene');
    assert.equal(t.h.state.status, 'ready');
    assert.equal(t.h.busy, false);
    assert.equal(t.h.placementViewWaiters.size, 0);
  }
});

const freshProgressMenu = [[-3,-1,-1],[-3,1,-1],[-2,-1,-1],[-2,1,-1]];
test('an asynchronously drawn progress plate retries the production appearance fit once against fresh glass', async () => {
  const t = menuInvariantHarness();
  const fit = t.h.fitAppearanceInWorker, set = t.h.talkCaption.set;
  const measured = [], timeouts = [];
  let progressPublications = 0;
  t.h.fitAppearanceInWorker = (options, policy) => {
    measured.push(structuredClone(options.points)); timeouts.push(policy.timeoutMs);
    return fit(options, policy);
  };
  t.h.talkCaption.set = detail => {
    set(detail);
    if (!detail.progress) return;
    progressPublications++;
    // Like the real asynchronous caption mesh/seat commit: dispatch the first
    // worker before publishing the new drawn plate, rather than changing it
    // synchronously inside set(). The actual stereo worker measures both fits.
    queueMicrotask(() => {
      assert.equal(measured.length, 1, 'first worker already dispatched');
      t.h.immersiveSession.platePoints = () => freshProgressMenu;
    });
  };
  await t.appearance();
  assert.equal(progressPublications, 1, 'retry cannot start another caption rebuild');
  assert.equal(measured.length, 2);
  assert.notDeepEqual(measured[0], measured[1]);
  assert.deepEqual(measured[1], freshProgressMenu, 'fresh solve measures actual drawn glass');
  assert.ok(timeouts[1] < timeouts[0] && timeouts[0] <= 30000, 'one shared deadline');
  assert.ok(t.events.some(event => event.outcome === 'retry-menu'));
  assert.ok(t.events.includes('reveal-cell') && t.events.includes('draw'));
  assert.equal(t.h.placementViewWaiters.size, 0);
  assert.notEqual(t.caption(), 'Checking the structure against the menu…');
});

for (const phase of [1, 2]) for (const edge of ['placement', 'session', 'abort', 'source'])
  test(`menu refresh does not retry or accept changed ${edge} during fit ${phase}`, async () => {
    const t = menuInvariantHarness(), fit = t.h.fitAppearanceInWorker;
    const abort = new AbortController();
    let calls = 0;
    t.h.fitAppearanceInWorker = async (options, policy) => {
      const own = ++calls, result = await fit(options, policy);
      t.h.immersiveSession.platePoints = () => freshProgressMenu;
      if (own === phase) {
        if (edge === 'placement') t.h.inspectionState.place({ scale: 2 });
        if (edge === 'session') t.h.canvas.webgl.xr.session = {};
        if (edge === 'abort') abort.abort();
        if (edge === 'source') t.h.sourceRecord = {};
      }
      return result;
    };
    await assert.rejects(t.h.clearHeldPlatePlacement(t.placement(), { signal: abort.signal }),
      edge === 'abort' || edge === 'source' ? /superseded/ : /changed while fitting/);
    assert.equal(calls, phase, 'owner changes never start another solve');
    assert.equal(t.h.placementViewWaiters.size, 0);
    assert.ok(!t.events.includes('reveal-cell'));
  });

test('menu-only retry uses the original fit deadline and never renews an expired budget', async () => {
  for (const elapsed of [29000, 30001]) {
    const t = menuInvariantHarness(), fit = t.h.fitAppearanceInWorker;
    let clock = 100, calls = 0;
    const timeouts = [];
    t.h.now = () => clock;
    t.h.fitAppearanceInWorker = async (options, policy) => {
      timeouts.push(policy.timeoutMs);
      const result = await fit(options, policy);
      if (++calls === 1) { clock += elapsed; t.h.immersiveSession.platePoints = () => freshProgressMenu; }
      return result;
    };
    const check = t.h.clearHeldPlatePlacement(t.placement());
    if (elapsed > 30000) await assert.rejects(check, /changed while fitting/);
    else await check;
    assert.deepEqual(timeouts, elapsed > 30000 ? [30000] : [30000, 1000]);
    assert.equal(t.h.placementViewWaiters.size, 0);
  }
});
