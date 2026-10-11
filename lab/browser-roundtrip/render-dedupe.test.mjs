import test from 'node:test';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { harness, viewerSource } from './render-dedupe-harness.mjs';
import { pageFunction } from './fixtures/label-action-harness.mjs';
import { createGesturePivot } from './gesture-pivot.mjs';
import { createXrPlacementLifecycle } from './xr-input-release.mjs';

const compound = (keys, reverse = false) => ({ patch: { ops: [
  { kind: 'appearance', patch: { opacity: 0.5, labels: true, clipping: 20 } },
  { kind: 'placement', patch: { scale: 2 } },
  { kind: 'selection', patch: { selectionKeys: keys } },
  { kind: 'emphasis', patch: { parts: [{ id: 'rna', label: 'RNA', chain: 'A', color: '#ffaa33' }], focus: ['rna'], contextOpacity: 0.18 } },
][reverse ? 'reverse' : 'slice']() } });

async function selectedHarness() {
  const h = harness();
  h.context.inspectionState.configure({ labels: true });
  await h.select(h.rows.slice(0, 3).map(row => row.key));
  h.resetCounts();
  return h;
}

test('canonical repeated selection retains exact labels and marking, but waits before publishing', async () => {
  const h = await selectedHarness();
  const labels = h.labels();
  const undo = h.snapshot().inspection.history.undoCount;
  let release;
  h.gateFrame(new Promise(resolve => { release = resolve; }));
  const pending = h.select([...h.state.selectionKeys].reverse().concat(h.state.selectionKeys[0]));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.counts.publications, 0);
  assert.equal(h.counts.marks, 0);
  assert.equal(h.counts.residueLabels, 0);
  assert.equal(h.counts.componentLabels, 0);
  assert.equal(h.labels(), labels, 'no new layout or label object identity');
  release(); await pending;
  assert.equal(h.counts.frames, 1);
  assert.equal(h.counts.publications, 1);
  assert.equal(h.snapshot().inspection.history.undoCount, undo, 'a no-op is not another undo');
});

test('same-selection cache invalidates for source, marker, label, appearance and placement changes', async () => {
  for (const invalidate of [
    h => { h.state.generation++; },
    h => { h.marker.values.tMarker.ref.version++; },
    h => { h.cells.delete('label-repr'); },
    h => { h.context.inspectionState.configure({ highlightColor: '#123456' }); },
    h => { h.context.inspectionState.place({ scale: 2 }); },
  ]) {
    const h = await selectedHarness();
    invalidate(h);
    await h.select(h.state.selectionKeys);
    assert.equal(h.counts.marks, 1);
    assert.equal(h.counts.residueLabels, 1);
    assert.equal(h.counts.componentLabels, 1);
  }
});

test('unknown canonical keys and busy viewers are still refused before mutation', async () => {
  const h = await selectedHarness();
  await assert.rejects(h.select(['other-copy']), /invalid_selection/);
  h.context.busy = true;
  await assert.rejects(h.select(h.state.selectionKeys), /viewer_busy/);
  assert.equal(h.counts.commits, 0);
});

test('changed selection and clear still rebuild, while repeated clear reuses', async () => {
  const h = await selectedHarness();
  await h.select([h.rows[8].key]);
  await h.select([]);
  await h.select([]);
  assert.equal(h.counts.marks, 2);
  assert.equal(h.counts.residueLabels, 2);
  assert.equal(h.labels().length, 0);
  assert.equal(h.counts.frames, 3);
});

test('representation no-change path preserves labels and emphasis; missing layers and real changes repair', async () => {
  const h = await selectedHarness();
  h.context.emphasisState = { parts: [{ id: 'a', label: 'A', color: '#ffffff' }], focus: ['a'], contextOpacity: 0.2 };
  const labels = h.labels(), emphasis = h.context.emphasisState;
  await h.setRepresentation('cartoon');
  assert.equal(h.counts.appearance, 0);
  assert.equal(h.labels(), labels);
  assert.equal(h.context.emphasisState, emphasis);
  h.cells.delete('label-repr');
  await h.setRepresentation('cartoon');
  assert.equal(h.counts.appearance, 1);
  assert.equal(h.counts.emphasis, 1);
  await h.setRepresentation('ball-and-stick');
  assert.equal(h.counts.appearance, 2);
  assert.equal(h.counts.emphasis, 2);
  assert.equal(h.snapshot().inspection.appearance.representation, 'ball-and-stick');
});

test('density representation refusal and unsupported representation refusal remain explicit', async () => {
  const h = harness();
  h.context.volume = {};
  await assert.rejects(h.setRepresentation('cartoon'), /density map; its isosurface is the only representation/);
  h.context.volume = undefined;
  await assert.rejects(h.setRepresentation('bad'), /unsupported_representation/);
  assert.equal(h.counts.commits, 0);
});

test('forward and reverse compound field orders use one final frame, one publication, one undo and one emphasis paint', async () => {
  for (const reverse of [false, true]) {
    const h = await selectedHarness();
    const before = h.snapshot();
    const keys = [h.rows[9].key];
    let release;
    h.gateFrame(new Promise(resolve => { release = resolve; }));
    const pending = h.compound(compound(keys, reverse));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.counts.publications, 0);
    release(); await pending;
    assert.equal(h.counts.commits, 1);
    assert.equal(h.counts.frames, 1);
    assert.equal(h.counts.publications, 1);
    assert.equal(h.counts.emphasis, 1);
    assert.equal(h.counts.residueLabels, 1);
    assert.equal(h.counts.componentLabels, 1);
    assert.equal(h.snapshot().inspection.history.undoCount, before.inspection.history.undoCount + 1);
    assert.equal(h.snapshot().inspection.history.lastAction, 'agent-compound');
    assert.equal(h.snapshot().inspection.placement.scale, 2);
    assert.equal(h.snapshot().inspection.appearance.opacity, 0.5);
    assert.deepEqual(Array.from(h.state.selectionKeys), keys);
    assert.equal(h.snapshot().emphasis.focus[0], 'rna');
    const undone = h.context.inspectionState.undo();
    assert.deepEqual(undone.appearance, before.inspection.appearance);
    assert.deepEqual(undone.placement, before.inspection.placement);
  }
});

test('compound validation refuses bad later fields before any earlier render or undo', async () => {
  const h = await selectedHarness();
  const before = h.snapshot();
  const change = compound([h.rows[0].key]);
  change.patch.ops[1].patch.scale = 1000001;
  await assert.rejects(h.compound(change), /scale must be between/);
  assert.equal(h.counts.commits, 0);
  assert.equal(h.counts.appearance, 0);
  assert.deepEqual(h.snapshot(), before);
  change.patch.ops[1].patch.scale = 2;
  change.patch.ops[2].patch.selectionKeys = ['wrong-copy'];
  await assert.rejects(h.compound(change), /invalid_selection/);
  assert.equal(h.counts.commits, 0);
});

test('failed compound frame publishes no success and restores the captured scene and history', async () => {
  const h = await selectedHarness();
  const before = h.snapshot();
  h.failFrame();
  await assert.rejects(h.compound(compound([h.rows[9].key])), /frame_failed/);
  assert.equal(h.counts.publications, 0);
  assert.equal(h.counts.restores, 1);
  assert.deepEqual(h.snapshot().inspection, before.inspection);
  assert.deepEqual(h.snapshot().emphasis, before.emphasis);
  assert.deepEqual(Array.from(h.state.selectionKeys), Array.from(before.selectionKeys));
  assert.equal(h.context.inspectionState.groupOpen(), false);
});

test('XR pick uses the same validated selection path before reporting a rendered pick', () => {
  const pick = viewerSource.slice(viewerSource.indexOf('  function dispatchPresentationPick('), viewerSource.indexOf('  function flushPendingPresentationPick('));
  assert.match(pick, /const applyPick = select\(keys, 'pick'\)/);
  assert.match(pick, /applyPick\.then\(result =>/);
  assert.match(pick, /reportHeadsetPick\(keys\)/);
  assert.doesNotMatch(pick, /rebuildInspectionLabels|rebuildComponentLabels/);
});


test('a removed emphasis layer forces the appearance preservation path to repair', async () => {
  const h = await selectedHarness();
  h.context.currentEmphasisPlan = () => ({ colours: [{ keys: [h.rows[0].key] }], faded: [] });
  h.cells.set('emphasis-colour', { obj: {} });
  await h.setRepresentation('cartoon');
  assert.equal(h.counts.appearance, 0);
  h.cells.delete('emphasis-colour');
  await h.setRepresentation('cartoon');
  assert.equal(h.counts.appearance, 1);
  assert.equal(h.counts.emphasis, 1);
});

test('legacy selection never consults disabled inspection state', async () => {
  const h = harness();
  h.context.inspectionState = undefined;
  h.context.inspectionSnapshot = () => { throw Error('inspection_disabled'); };
  await h.select([h.rows[0].key]);
  await h.select([h.rows[0].key]);
  assert.equal(h.counts.frames, 2);
});

test('compound refuses active manipulation and context loss before publishing', async () => {
  for (const block of ['interaction', 'context']) {
    const h = await selectedHarness();
    if (block === 'interaction') h.context.interactionActive = () => true;
    else h.context.canvas.webgl.isContextLost = true;
    await assert.rejects(h.compound(compound([h.rows[9].key])), block === 'interaction' ? /Release the molecular drag/ : /context_lost/);
    assert.equal(h.counts.publications, 0);
    assert.equal(h.counts.commits, 0);
    assert.equal(h.context.inspectionState.groupOpen(), false);
  }
});

test('compound without an appearance patch can repair missing live labels', async () => {
  const h = await selectedHarness();
  h.cells.delete('label-repr');
  await h.compound({ patch: { ops: [
    { kind: 'placement', patch: { scale: 2 } },
    { kind: 'selection', patch: { selectionKeys: [h.rows[9].key] } },
  ] } });
  assert.equal(h.counts.appearance, 1);
  assert.equal(h.counts.frames, 1);
  assert.equal(h.counts.publications, 1);
});


test('render diagnostics are opt-in, bounded, frame-timed and fail closed', () => {
  const source = viewerSource.slice(viewerSource.indexOf('  function recordRenderCost('), viewerSource.indexOf('  /**\n   * The two layers themselves,'));
  const records = [];
  const ctx = vm.createContext({
    // This fixture does not paint, so drawing the selection costs it
    // nothing. `render-dedupe-harness.mjs` is the one that counts paints, and
    // its stub runs the real emphasis pass.
    currentSelectionPlan: () => undefined,
    async paintSelectionOverlay() {}, now: () => 100, structureAtomSites: () => 500, plugin: {},
    state: { selectionKeys: ['private key'] }, canvas: { reprCount: { value: 3 } },
    componentLabelRepresentations: () => [1, 2], inspectionLabel: {},
    recordCost: (kind, detail) => records.push({ kind, ...detail }) });
  vm.runInContext(source + '\nglobalThis.measure = recordRenderCost;', ctx);
  ctx.measure('compound', 0, 50, ['appearance']);
  assert.equal(records.length, 0);
  ctx.__stereofoldDiagnostics = { record() {} };
  ctx.measure('load', 0, 50, Array(20).fill('source'), 'rendered', 75);
  assert.equal(records[0].commitToFrameMs, 25, 'cleanup time is not frame latency');
  assert.equal(records[0].selectionSize, 1);
  assert.equal(records[0].changedLayers.length, 8);
  assert.equal(records[0].labelCount, 3);
  assert.doesNotMatch(JSON.stringify(records), /private key/);
  ctx.recordCost = () => { throw Error('diagnostics unavailable'); };
  assert.doesNotThrow(() => ctx.measure('load', 0, undefined, ['source'], 'failed'));
});

/** Real placement/mutation/frame-wait functions, with a controlled draw stream
 * and clock. No renderer runs; the clock advances the production frame timeout.
 */
function placementLifecycleHarness() {
  const h = harness(), c = h.context, timers = new Map(), draws = new Set();
  let clock = 0, nextTimer = 0, takeovers = 0;
  Object.assign(c, {
    AbortController, sourceRecord: {}, visibleStage: undefined, focusPivotRequest: undefined, gesturePivot: createGesturePivot(), xrPlacementFollowup: undefined,
    pivotCenter: () => [0, 0, 0],
    xrInputLifecycle: createXrPlacementLifecycle(),
    xrInputBlind: false, xrDeferredGrab: undefined, xrDeferredBake: undefined,
    xrManipulation: { phase: () => 'idle' },
    grabRotation: undefined, grabScale: 1.2, grabOffset: undefined,
    immersiveSession: { syncBounds() {} }, talkCaption: undefined,
    frameWaiters: new Set(), XR_FRAME_TIMEOUT_MS: 15000, FRAME_TIMEOUT_MS: 30000,
    xrPresentationRepresentationCount: 0, scientificRepresentationCount: () => 1,
    recordManipulation() {}, clampPlacementScale: value => value,
    rotationFromPlacement: () => [], rotationDegreesZYX: () => [0, 0, 0],
    pivotBounds: () => ({ baseCenter: [0, 0, 0], visibleCenter: [0, 0, 0] }),
    checkDrawnRecord() {}, drawnRecordIsVisible: () => true,
    lessonFigure: { drawn: () => true }, latestRoomPlacementPose: null,
    takeWearerPlacement: () => { takeovers++; },
    now: () => clock, performance: { now: () => clock },
    setTimeout(callback, ms) { const id = ++nextTimer; timers.set(id, { callback, at: clock + ms }); return id; },
    clearTimeout: id => timers.delete(id),
  });
  c.canvas.xr.isPresenting.value = true;
  c.canvas.webgl.xr = { session: { inputSources: [] } };
  c.canvas.commitQueueSize = { value: 0 };
  c.canvas.didDraw = { subscribe(callback) { draws.add(callback); return { unsubscribe: () => draws.delete(callback) }; } };
  c.canvas.requestDraw = () => {};
  for (const name of ['invalidateGesturePivot', 'gesturePivotContext', 'beginGesturePivot', 'gesturePivotCenter', 'grabPivotBounds', 'cancelXrPlacementFollowup', 'startXrPlacementFollowup', 'waitForFrame', 'bakeGrab', 'flushXrDeferredGrab']) vm.runInContext(pageFunction(viewerSource, name), c);
  const drain = () => new Promise(resolve => setImmediate(resolve));
  return { h, c, drain, timers, draws, takeovers: () => takeovers,
    bake: (token = c.xrInputLifecycle) => c.bakeGrab({ gesture: 'stick' }, { inputLifecycle: token }),
    advance(ms) {
      clock += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= clock && timers.delete(id)) timer.callback();
    },
    draw() { c.state.drawCount = (c.state.drawCount ?? 0) + 1; for (const callback of [...draws]) callback(); },
  };
}

test('a deferred placement survives another hidden interval while its real draw wait is pending', async () => {
  const p = placementLifecycleHarness(), token = p.c.xrInputLifecycle;
  token.setBlind(true); token.setBlind(false);
  const pending = p.bake();
  await p.drain();
  assert.equal(p.c.state.status, 'mutating');
  p.advance(100);
  token.setBlind(true);
  p.advance(30000); await p.drain();
  assert.equal(p.c.state.status, 'mutating', 'hidden time cannot expire the visible-frame deadline');
  assert.equal(p.h.counts.publications, 0);
  assert.equal(p.c.inspectionState.snapshot().placement.scale, 1.2);
  token.setBlind(false);
  p.advance(14000); p.draw(); await pending; p.advance(0); await p.drain();
  assert.equal(p.c.state.status, 'ready');
  assert.equal(p.c.inspectionState.snapshot().placement.scale, 1.2);
  assert.equal(p.h.counts.publications, 1);
  assert.equal(p.takeovers(), 1);
  assert.equal(p.timers.size, 0); assert.equal(p.draws.size, 0);
});

test('session end cancels the old placement wait without publishing and a new session can draw', async () => {
  const p = placementLifecycleHarness(), old = p.c.xrInputLifecycle;
  const pending = p.bake().catch(error => { assert.equal(error.code, 'xr_input_ended'); });
  await p.drain(); old.end(); await pending;
  assert.equal(p.c.state.status, 'ready');
  assert.equal(p.c.inspectionState.snapshot().placement.scale, 1.2, 'ending keeps the last visibly held pose');
  assert.equal(p.h.counts.publications, 0, 'ending cannot claim an unobserved rendered frame');
  assert.equal(p.takeovers(), 0, 'an ended session cannot run placement followups');
  assert.equal(p.timers.size, 0); assert.equal(p.draws.size, 0);
  p.c.xrInputLifecycle = createXrPlacementLifecycle(); p.c.grabScale = 1.1;
  const next = p.bake(); await p.drain(); p.draw(); await next;
  assert.equal(p.c.state.status, 'ready');
  assert.ok(Math.abs(p.c.inspectionState.snapshot().placement.scale - 1.32) < 1e-9);
  assert.equal(p.h.counts.publications, 1); assert.equal(p.takeovers(), 1);
});

test('an ended deferred placement cannot write after awaiting an earlier mutation', async () => {
  const p = placementLifecycleHarness();
  let release;
  p.c.busy = true; p.c.activeWork = { done: new Promise(resolve => { release = resolve; }) };
  const pending = p.bake().catch(error => { assert.equal(error.code, 'xr_input_ended'); });
  await p.drain(); p.c.xrInputLifecycle.end(); p.c.busy = false; release(); await pending;
  assert.equal(p.c.inspectionState.snapshot().placement.scale, 1);
  assert.equal(p.h.counts.commits, 0); assert.equal(p.h.counts.publications, 0);
  assert.equal(p.takeovers(), 0); assert.equal(p.timers.size, 0);
  assert.equal(p.c.grabScale, 1, 'an ended uncommitted scale must not survive for the next session');
  assert.equal(p.c.grabOffset, undefined);
  assert.equal(p.c.grabRotation, undefined);
});


test('XR exit drops a released placement still waiting behind another mutation', async () => {
  const p = placementLifecycleHarness(), c = p.c;
  let release;
  Object.assign(c, {
    xrManipulation: { phase: () => 'idle', reset: () => false }, xrInputRelease: { reset() {} },
    xrControllerInput: undefined, xrButtons: undefined, xrThumbstick: undefined, xrPushStick: undefined,
    stickModifiers: undefined, triggerStickIntent: undefined, naturalInput: undefined,
    setTalkOutcomeSink() {}, setTalkProgressSink() {}, detachConnectionMenu: undefined,
    tuneXrLocomotion() {}, lastTriggerHand: undefined, lastTriggerAt: 0,
    xrTransformPending: false, xrInputHeadInRoom: undefined, xrAimUnavailable: false, latestXrSpace: undefined,
  });
  vm.runInContext(pageFunction(viewerSource, 'endXrManipulation'), c);
  c.busy = true; c.activeWork = { done: new Promise(resolve => { release = resolve; }) };
  c.xrDeferredGrab = { gesture: 'stick' }; c.flushXrDeferredGrab();
  const old = c.xrDeferredBake;
  await p.drain();
  assert.equal(c.xrDeferredGrab, undefined, 'release summary has already been consumed');
  c.canvas.xr.isPresenting.value = false; c.canvas.webgl.xr.session = undefined;
  c.endXrManipulation();
  assert.equal(c.grabScale, 1, 'idle gesture machine does not mean its released bake committed');
  // A later continuation must not erase a new session's movement.
  c.xrInputLifecycle = createXrPlacementLifecycle(); c.canvas.webgl.xr.session = {};
  c.canvas.xr.isPresenting.value = true; c.beginGesturePivot();
  c.grabScale = 1.2; c.busy = false; release(); await old;
  assert.equal(c.grabScale, 1.2, 'even an identical scale belongs to the new gesture token');
  assert.equal(c.inspectionState.placement().scale, 1);
  assert.equal(p.h.counts.commits, 0); assert.equal(p.h.counts.publications, 0);
});

for (const entry of ['controller release', 'stick release']) {
  test(`${entry} enters the lifecycle-protected placement path`, async () => {
    const p = placementLifecycleHarness();
    // Execute the entry callbacks from createViewer, so a future direct bake
    // call cannot bypass the lifecycle tests while those tests still pass.
    if (entry === 'controller release') {
      const callback = viewerSource.match(/onGrabEnd: (summary => \{[\s\S]*?\}), \/\/ And comes back on release\./)?.[1];
      assert.ok(callback, 'production controller release callback exists');
      vm.runInContext(`globalThis.releaseInput = ${callback};`, p.c);
    } else {
      const start = viewerSource.indexOf('    const bakeStick = () => {');
      const end = viewerSource.indexOf('\n    xrThumbstick = ', start);
      assert.ok(start >= 0 && end > start, 'production stick release callback exists');
      vm.runInContext(viewerSource.slice(start, end) + '\nglobalThis.releaseInput = bakeStick;', p.c);
    }
    p.c.releaseInput({ phase: 'grab' });
    const pending = p.c.xrDeferredBake;
    assert.ok(pending, 'input remains gated until this placement settles');
    await p.drain();
    p.c.xrInputLifecycle.setBlind(true); p.advance(30000); await p.drain();
    assert.equal(p.c.state.status, 'mutating', 'the entry uses the protected frame budget');
    p.c.xrInputLifecycle.setBlind(false); p.draw(); await pending;
    assert.equal(p.c.state.status, 'ready');
    assert.equal(p.c.inspectionState.snapshot().placement.scale, 1.2);
    assert.equal(p.h.counts.publications, 1);
    assert.equal(p.c.xrDeferredBake, undefined);
  });
}

function deferredClearanceHarness() {
  const p = placementLifecycleHarness(), c = p.c, fits = [], relocations = [], labels = [], records = [];
  Object.assign(c, {
    latestRoomPlacementPose: { labelViews: [{ eye: 'none' }] }, placementViewWaiters: new Set(),
    loadedSphere: () => ({ center: [0, 0, 0], radius: 1 }), lessonFigure: { drawn: () => true, snapshot: () => null },
    scientificRepresentations: () => [{ renderObjects: [{ type: 'mesh', state: { visible: true } }] }],
    presentationTransform: () => [c.inspectionState.placement().scale, c.grabScale], placementTransform: placement => [placement.scale, 1],
    wearerPlacement: { holdsPlacement: () => true }, latestRetainedProof: undefined,
    capturePlacementFitEvidence: () => ({}), lastPlacementFitEvidence: undefined,
    fitAppearanceInWorker: (options, ownership) => new Promise((resolve, reject) => fits.push({ options, ownership, resolve, reject })),
    recordManipulation: (kind, detail) => records.push({ kind, ...detail }),
    componentLabels: { active: () => true, relayout: async (_reason, guard) => { assert.equal(guard.isCurrent(), true); labels.push(c.inspectionState.placement()); } },
    appearanceWork: undefined, GRABBABLE_STATUS: new Set(['ready', 'mutating']), pendingGrowthTurn: false,
    xrTransformBatchDepth: 0, xrTransformPending: false,
  });
  c.immersiveSession = { syncBounds() {}, platePoints: () => [[0, 0, -1]],
    toolbarRelocationCandidates: () => [{ id: 'side', points: [[1, 0, -1]] }],
    relocateToolbar: async candidate => { relocations.push(candidate); } };
  for (const name of ['clearHeldPlatePlacement', 'canManipulateNow', 'applyGrabDelta', 'processXrPointers'])
    vm.runInContext(pageFunction(viewerSource, name), c);
  Object.assign(c, { pointerManipulates: () => false, xrInputHeld: false, xrAimUnavailable: false, xrInputRelease: { filter: pointers => pointers }, manualXrInputHeld: false,
    updateXrManipulation: () => c.applyGrabDelta({ scale: 1.1 }), applyImmersiveDepth() {}, syncPresentationMotion() {} });
  return { ...p, fits, labels, relocations, records, async release() {
    c.xrDeferredGrab = { phase: 'stick' }; c.flushXrDeferredGrab();
    const pending = c.xrDeferredBake;
    await p.drain(); assert.ok(c.xrDeferredBake); assert.equal(fits.length, 0);
    p.draw(); await pending;
    assert.equal(c.xrDeferredBake, undefined, 'only the actual committed frame opens input');
    assert.equal(fits.length, 0, 'geometry sampling cannot extend the release gate');
    p.advance(0); await p.drain();
    return c.xrPlacementFollowup;
  } };
}

test('actual release producer accepts new input during unresolved fit; late fit cannot move menu, pose, history or labels', async () => {
  const p = deferredClearanceHarness(), token = await p.release();
  assert.equal(p.fits.length, 1, JSON.stringify(p.records));
  const saved = p.c.inspectionState.snapshot(), fit = p.fits[0];
  p.c.processXrPointers([{ buttons: 0 }]);
  assert.equal(p.c.grabScale, 1.1, 'fresh input reaches production delta despite outstanding fit');
  assert.equal(fit.ownership.signal.aborted, true);
  fit.resolve({ ...fit.options.seat, menuRelocation: 'side' }); await token.done;
  assert.equal(p.relocations.length, 0); assert.equal(p.labels.length, 0);
  assert.deepEqual(p.c.inspectionState.snapshot(), saved, 'late clearance cannot create another history entry');
  assert.equal(p.c.grabScale, 1.1, 'the new transient remains intact');
  assert.equal(p.records.at(-1).outcome, 'cancelled');
});

test('successful release follows with exact wearer clearance and current labels after input gate opens', async () => {
  const p = deferredClearanceHarness(), token = await p.release(), fit = p.fits[0];
  assert.equal(fit.options.restoreSaved, true); assert.equal(fit.options.allowOffscreen, true);
  fit.resolve({ ...fit.options.seat, menuRelocation: 'side' }); await token.done;
  assert.equal(p.relocations.length, 1, JSON.stringify(p.records)); assert.equal(p.labels.length, 1);
  assert.equal(p.c.inspectionState.placement().scale, 1.2);
  assert.equal(p.c.xrPlacementFollowup, undefined);
  assert.equal(p.records.at(-1).outcome, 'completed');
  assert.equal(p.records.at(-1).committedMs, 0);
});

for (const replacement of ['source', 'session', 'dispose']) test(`late release fit is inert after ${replacement} replacement`, async () => {
  const p = deferredClearanceHarness(), token = await p.release(), fit = p.fits[0];
  if (replacement === 'source') { p.c.sourceRecord = {}; p.c.state.generation++; }
  if (replacement === 'session') { p.c.xrInputLifecycle.end(); p.c.canvas.webgl.xr.session = {}; }
  if (replacement === 'dispose') { p.c.state.status = 'disposed'; p.c.state.generation++; }
  fit.resolve({ ...fit.options.seat, menuRelocation: 'side' }); await token.done;
  assert.equal(p.relocations.length, 0); assert.equal(p.labels.length, 0);
  assert.equal(p.fits.length, 1, 'cancelled owners never recursively retry');
  assert.equal(p.c.xrPlacementFollowup, undefined);
});

test('new gesture before scheduled followup cancels sampling entirely', async () => {
  const p = deferredClearanceHarness();
  p.c.xrDeferredGrab = { phase: 'stick' }; p.c.flushXrDeferredGrab();
  const pending = p.c.xrDeferredBake; await p.drain(); p.draw(); await pending;
  const token = p.c.xrPlacementFollowup;
  p.c.processXrPointers([{ buttons: 0 }]); await token.done;
  p.advance(0); await p.drain();
  assert.equal(p.fits.length, 0); assert.equal(p.labels.length, 0); assert.equal(p.timers.size, 0);
});

test('a pending manual bake cannot overwrite a newly framed focus at the same pose', async () => {
  const p = placementLifecycleHarness(); p.c.beginGesturePivot();
  let release; p.c.busy = true; p.c.activeWork = { done: new Promise(resolve => { release = resolve; }) };
  const pending = p.bake(); await p.drain();
  p.c.gesturePivot.rememberFocus({ source: p.c.sourceRecord, subject: p.c.visibleStage,
    placement: p.c.inspectionState.placement(), targetCenter: [5, 1, 0] });
  p.c.busy = false; release(); assert.equal(await pending, false);
  assert.equal(p.h.counts.commits, 0); assert.equal(p.h.counts.publications, 0);
  p.c.beginGesturePivot(); assert.deepEqual(Array.from(p.c.gesturePivotCenter()), [5, 1, 0]);
});

test('focus publishes its exact target at commit and cannot republish after a deferred label pass', async () => {
  const p = placementLifecycleHarness(), c = p.c;
  let finishLabels; c.componentLabels = { active: () => true,
    relayout: () => new Promise(resolve => { finishLabels = resolve; }) };
  const focusOwner = c.focusPivotRequest = {};
  const pending = c.bakeGrab({ gesture: 'focus' }, { focusPivot: { owner: focusOwner,
    source: c.sourceRecord, subject: c.visibleStage, targetCenter: [7, 2, 0] } });
  await p.drain(); p.draw(); await p.drain();
  assert.equal(typeof finishLabels, 'function');
  c.beginGesturePivot(); assert.deepEqual(Array.from(c.gesturePivotCenter()), [7, 2, 0]);
  // A newer framing at identical numeric placement must still own its target.
  c.gesturePivot.rememberFocus({ source: c.sourceRecord, subject: c.visibleStage,
    placement: c.inspectionState.placement(), targetCenter: [-2, 4, 1] });
  finishLabels(); await pending;
  c.beginGesturePivot(); assert.deepEqual(Array.from(c.gesturePivotCenter()), [-2, 4, 1]);
});

for (const newerGesture of [false, true]) test(`stale bake clears only its own transient after another pose commits; newer=${newerGesture}`, async () => {
  const p = placementLifecycleHarness(), c = p.c; c.beginGesturePivot();
  let release; c.busy = true; c.activeWork = { done: new Promise(resolve => { release = resolve; }) };
  const pending = p.bake(); await p.drain();
  c.inspectionState.place({ scale: 3 }, 'external');
  if (newerGesture) { c.beginGesturePivot(); c.grabScale = 1.4; }
  c.busy = false; release(); assert.equal(await pending, false);
  assert.equal(c.inspectionState.placement().scale, 3); assert.equal(c.grabScale, newerGesture ? 1.4 : 1);
  assert.equal(p.h.counts.commits, 0); assert.equal(p.h.counts.publications, 0);
});

test('focus bake refuses an externally changed saved pose and clears its abandoned travel', async () => {
  const p = placementLifecycleHarness(), c = p.c, owner = c.focusPivotRequest = {};
  const focusPivot = { owner, source: c.sourceRecord, subject: c.visibleStage, targetCenter: [7, 2, 0],
    placement: JSON.stringify(c.inspectionState.placement()) };
  c.inspectionState.place({ scale: 4 }, 'external');
  assert.equal(await c.bakeGrab({ gesture: 'focus' }, { focusPivot }), false);
  assert.equal(c.grabScale, 1); assert.equal(c.inspectionState.placement().scale, 4);
  assert.equal(p.h.counts.commits, 0); c.beginGesturePivot();
  assert.deepEqual(Array.from(c.gesturePivotCenter()), [0, 0, 0]);
});

test('old focus completion never captures or clears a newer focus travel transient', async () => {
  const p = placementLifecycleHarness(), c = p.c, oldOwner = {};
  c.focusPivotRequest = {}; c.grabScale = 2.7;
  assert.equal(await c.bakeGrab({ gesture: 'focus' }, { focusPivot: { owner: oldOwner,
    source: c.sourceRecord, subject: c.visibleStage, targetCenter: [7, 2, 0] } }), false);
  assert.equal(c.grabScale, 2.7); assert.equal(p.h.counts.commits, 0);
});

test('manual bake waiting on busy work cannot clear a newer focus animation', async () => {
  const p = placementLifecycleHarness(), c = p.c; c.beginGesturePivot();
  let release; c.busy = true; c.activeWork = { done: new Promise(resolve => { release = resolve; }) };
  const pending = p.bake(); await p.drain();
  c.invalidateGesturePivot(); c.focusPivotRequest = {}; // numerically identical transient, different owner
  c.busy = false; release(); assert.equal(await pending, false);
  assert.equal(c.grabScale, 1.2); assert.equal(p.h.counts.commits, 0);
});

test('a genuine retained-clearance failure keeps the committed pose and records failure without gating input', async () => {
  const p = deferredClearanceHarness(), token = await p.release(), fit = p.fits[0];
  fit.reject(Error('No clear menu seat')); await token.done;
  assert.equal(p.c.inspectionState.placement().scale, 1.2); assert.equal(p.c.xrDeferredBake, undefined);
  assert.equal(p.labels.length, 1); assert.equal(p.relocations.length, 0);
  assert.equal(p.records.at(-1).outcome, 'failed');
  assert.ok(p.records.some(record => record.event === 'menu-clearance-deferred'));
});
