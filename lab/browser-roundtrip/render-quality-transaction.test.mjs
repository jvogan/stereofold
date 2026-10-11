import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { Sphere } from 'molstar/lib/mol-geo/primitive/sphere.js';
import * as budget from './xr-render-budget.mjs';
import { pageFunction } from './fixtures/label-action-harness.mjs';
import { sourceLoadHarness } from './fixtures/source-load-harness.mjs';
import extraction from '../identity/extract.cjs';

const viewer = readFileSync(process.env.RENDER_QUALITY_TRANSACTION_SOURCE ?? new URL('./viewer.mjs', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const fault = (code, message = code) => Object.assign(new Error(message), { code });

// Execute the production transaction and ownership/guards. GPU submission is
// the fault-injection seam: a builder replaces real Mol* primitive buffers and
// a frame can fail after the outgoing geometry has already been deleted.
function harness({ presenting = true, empty = false, level = 'balanced', stored = level } = {}) {
  budget.setActiveRenderQuality(level);
  const storage = new Map(stored === undefined ? [] : [[budget.RENDER_QUALITY_STORAGE_KEY, stored]]);
  const records = [], builds = [], buildModes = [], frames = [], commits = [], captions = [];
  const science = { sourceSha256: 'same-source', selections: { site: [1, 2] },
    placement: { scale: 20, translation: [0, 0, -12] }, history: ['authored'] };
  const initialProps = structuredClone(budget.xrPostprocessingProps(true));
  initialProps.postprocessing.outline = { name: 'on', params: { threshold: 0.41 } };
  initialProps.illumination.custom = 17;
  initialProps.multiSample = { mode: 'on', sampleLevel: 3 };
  initialProps.xr.disablePostprocessing = true;
  const canvas = { props: structuredClone(initialProps), xr: { isPresenting: { value: presenting } },
    webgl: { isContextLost: false, xr: { session: presenting ? { inputSources: [] } : undefined } },
    setProps(props) {
      for (const key of Object.keys(props)) this.props[key] = { ...this.props[key], ...structuredClone(props[key]) };
    }, commit(force) { commits.push(force); } };
  const geometry = level => {
    const mode = Boolean(canvas.xr.isPresenting.value);
    const detail = { fast: 0, balanced: 1, best: 2 }[level] + (mode ? 0 : 1);
    const mesh = Sphere(detail);
    return { level, presenting: mode, vertices: mesh.vertices, indices: mesh.indices };
  };
  const initialGeometry = geometry(level);
  let currentGeometry = initialGeometry;
  const context = vm.createContext({ ...budget, structuredClone, Promise,
    navigator: { userAgent: 'Mozilla/5.0 Quest 2 OculusBrowser/150.0' },
    location: { search: '' },
    sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    __stereofoldDiagnostics: { record: (kind, value) => records.push({ kind, ...plain(value) }) },
    canvas, state: { status: empty ? 'empty' : 'ready', contextLossCount: 0, error: null },
    busy: false, appearanceWork: undefined, activeWork: undefined, pendingContextLoss: undefined,
    inspectionState: empty ? undefined : {}, structure: empty ? undefined : { obj: { data: {} } },
    representation: empty ? undefined : {}, plugin: {}, appliedGeometryBudget: undefined,
    detached: structuredClone, failure: fault,
    interactionActive: () => false,
    retainCurrent: () => empty ? undefined : ({ source: science.sourceSha256, inspection: structuredClone(science) }),
    inspectionSnapshot: () => ({ appearance: { representation: 'molecular-surface' } }),
    structureAtomSites: () => 13121,
    snapshot: () => structuredClone(science), refreshStructureSubject: () => {},
    recordCost: (kind, value) => records.push({ kind, ...plain(value) }),
    showHeadsetCaption: message => captions.push(message),
    async applyInspectionAppearance(options) {
      assert.equal(context.busy, true, 'candidate and rollback share the admitted owner');
      assert.ok(context.activeWork, 'rebuild never starts outside the quality transaction');
      assert.equal(options.preservePlacement, true);
      const level = budget.activeRenderQuality(context);
      builds.push(level);
      buildModes.push(Boolean(canvas.xr.isPresenting.value));
      // This replaces the old buffers, so resetting the scalar alone cannot
      // pass the failed-final-frame regression.
      currentGeometry = geometry(level);
      await hooks.build?.(level, builds.length);
      options.check?.();
    },
    async waitForFrame() {
      frames.push(currentGeometry.level);
      await hooks.frame?.(frames.length);
      assert.equal(canvas.webgl.isContextLost, false);
    },
  });
  context.xrRepresentationQuality = options => budget.xrRepresentationQuality({ ...options, navigator: context.navigator, scope: context });
  context.xrRepresentationMaterial = options => budget.xrRepresentationMaterial({ ...options, navigator: context.navigator, scope: context });
  context.xrColorParams = options => budget.xrColorParams({ ...options, navigator: context.navigator, scope: context });
  const hooks = {};
  for (const name of ['assertContext', 'assertReady', 'currentXrSession', 'renderQualityLevel',
    'renderQualityApplied', 'recordRenderQuality', 'renderQualityContext', 'assertRenderQualityContext',
    'applyRenderQualityPostprocessing', 'renderQualityCheckpoint', 'restoreRenderQualityCheckpoint',
    'canRebuildForXr', 'beginWork', 'setRenderQuality']) vm.runInContext(pageFunction(viewer, name), context);
  return { context, canvas, hooks, builds, buildModes, frames, records, commits, captions, storage, initialProps, initialGeometry,
    geometry: () => currentGeometry, set: level => context.setRenderQuality(level),
    stored: () => storage.get(budget.RENDER_QUALITY_STORAGE_KEY) };
}

function assertRestored(h) {
  assert.equal(budget.activeRenderQuality(h.context), 'balanced');
  assert.equal(h.stored(), 'balanced');
  assert.deepEqual(h.canvas.props, h.initialProps);
  assert.deepEqual(h.geometry(), h.initialGeometry);
  assert.equal(h.context.busy, false);
  assert.equal(h.context.activeWork, undefined);
  assert.equal(h.context.state.status, 'ready');
  assert.equal(h.records.some(record => record.kind === 'render-quality'), false);
}

test('quality preference and successful receipt wait for an accepted rebuilt frame', async () => {
  const h = harness();
  let release;
  h.hooks.frame = () => new Promise(resolve => { release = resolve; });
  const pending = h.set('best');
  while (!release) await Promise.resolve();
  assert.equal(h.stored(), 'balanced');
  assert.equal(h.context.busy, true);
  assert.equal(budget.activeRenderQuality(h.context), 'best');
  assert.ok(h.geometry().indices.length > h.initialGeometry.indices.length);
  assert.equal(h.records.length, 0);
  await assert.rejects(h.set('fast'), { code: 'viewer_busy' });
  release();
  const receipt = await pending;
  assert.equal(h.stored(), 'best');
  assert.equal(receipt.level, 'best');
  assert.equal(receipt.applied.rebuilt, true);
  assert.equal(receipt.applied.postfx, true);
  assert.equal(h.canvas.props.postprocessing.enabled, true);
  assert.equal(h.canvas.props.xr.disablePostprocessing, false);
  assert.equal(h.canvas.props.postprocessing.occlusion.name, 'on');
  assert.equal(h.canvas.props.postprocessing.outline.name, 'on');
  assert.equal(h.canvas.props.multiSample.mode, 'off');
  assert.equal(h.context.busy, false);
  assert.equal(h.records.filter(record => record.kind === 'render-quality').length, 1);
});

test('failed candidate rebuild restores prior quality, exact custom passes and geometry', async () => {
  const h = harness();
  const error = fault('representation_build_failed');
  h.hooks.build = (_, n) => { if (n === 1) throw error; };
  await assert.rejects(h.set('best'), value => value === error);
  assertRestored(h);
  assert.deepEqual(h.builds, ['best', 'balanced']);
  assert.equal(error.renderQualityRestoration.status, 'restored');
});

test('failed final frame rebuilds old geometry after the candidate replaced its buffers', async () => {
  const h = harness();
  const error = fault('frame_timeout');
  h.hooks.frame = n => { if (n === 1) throw error; };
  await assert.rejects(h.set('best'), value => value === error && value.code === 'frame_timeout');
  assertRestored(h);
  assert.deepEqual(h.frames, ['best', 'balanced']);
  assert.equal(h.commits.length, 2);
});

test('failed rollback keeps the original refusal and reports its restoration failure honestly', async () => {
  const h = harness();
  const error = fault('frame_timeout', 'Candidate did not draw.');
  h.hooks.frame = n => { if (n === 1) throw error; };
  h.hooks.build = (_, n) => { if (n === 2) throw fault('restore_failed', 'Previous buffers failed.'); };
  await assert.rejects(h.set('best'), value => value === error);
  assert.equal(error.renderQualityRestoration.status, 'failed');
  assert.match(error.renderQualityRestoration.message, /Previous buffers failed/);
  assert.equal(h.captions.at(-1), error.message);
  assert.equal(h.context.state.status, 'error');
  assert.match(h.context.state.error, /Candidate did not draw.*restoration failed.*Previous buffers failed/);
  assert.equal(h.stored(), 'balanced');
  assert.equal(h.context.busy, false);
  assert.equal(h.context.activeWork, undefined);
});

test('synchronous GL loss retains old quality for the delayed contextlost recovery event', async () => {
  const h = harness();
  const error = fault('context_lost');
  h.hooks.frame = () => { h.canvas.webgl.isContextLost = true; throw error; };
  await assert.rejects(h.set('best'), value => value === error);
  assert.equal(error.renderQualityRestoration.status, 'pending');
  assert.equal(h.stored(), 'balanced');
  assert.equal(budget.activeRenderQuality(h.context), 'balanced');
  assert.deepEqual(h.builds, ['best'], 'no GPU rollback while context is lost');
  const retained = h.context.pendingContextLoss.previous;
  assert.equal(retained.renderQualityCheckpoint.level, 'balanced');
  assert.deepEqual(plain(retained.inspection.placement), { scale: 20, translation: [0, 0, -12] });
});

test('contextlost dispatched during the frame sees the quality operation checkpoint', async () => {
  const h = harness();
  let retained, finish;
  h.hooks.frame = () => {
    retained = h.context.activeWork.previous;
    finish = h.context.activeWork.done;
    h.context.state.contextLossCount++;
    h.context.state.status = 'context_lost';
    h.canvas.webgl.isContextLost = true;
    throw fault('context_lost');
  };
  await assert.rejects(h.set('fast'), { code: 'context_lost' });
  await finish;
  assert.equal(retained.renderQualityCheckpoint.level, 'balanced');
  assert.equal(budget.activeRenderQuality(h.context), 'balanced');
  assert.equal(h.context.pendingContextLoss, undefined, 'dispatched event needs no delayed record');
});

test('rollback replaces a newer session\'s provisional passes with the retained tier', async () => {
  const h = harness();
  h.hooks.frame = n => {
    if (n !== 1) return;
    h.canvas.webgl.xr.session = { inputSources: [], newer: true };
    h.canvas.props.postprocessing = { newer: true };
    throw fault('frame_timeout');
  };
  await assert.rejects(h.set('best'), { code: 'frame_timeout' });
  assert.equal(h.canvas.props.postprocessing.enabled, false);
  assert.equal(h.canvas.props.xr.disablePostprocessing, true);
  assert.equal(budget.activeRenderQuality(h.context), 'balanced');
});

test('loading/busy or recovering viewers refuse before changing any quality settings', async () => {
  const h = harness();
  h.context.busy = true;
  h.context.state.status = 'loading';
  await assert.rejects(h.set('best'), { code: 'viewer_busy' });
  h.context.busy = false;
  h.context.state.status = 'recovering';
  await assert.rejects(h.set('best'), { code: 'context_recovering' });
  assert.equal(h.stored(), 'balanced');
  assert.deepEqual(h.canvas.props, h.initialProps);
  assert.equal(h.builds.length, 0);
});

test('an empty idle viewer can retain an explicit next-load quality without a rebuild', async () => {
  const h = harness({ empty: true, presenting: false });
  const result = await h.set('fast');
  assert.equal(result.level, 'fast');
  assert.equal(result.applied.rebuilt, false);
  assert.equal(h.stored(), 'fast');
  assert.equal(h.builds.length, 0);
  assert.equal(h.frames.length, 0);
  await assert.rejects(h.set('lowest'), { code: 'invalid_render_quality' });
});

test('failed desktop rebuild restores old buffers and exact passes', async () => {
  const h = harness({ presenting: false });
  h.hooks.frame = n => { if (n === 1) throw fault('frame_timeout'); };
  await assert.rejects(h.set('best'), { code: 'frame_timeout' });
  assertRestored(h);
  assert.deepEqual(h.commits, [true, true]);
});

test('XR entry during a provisional rebuild refuses and restores the prior tier in the new session', async () => {
  const h = harness({ presenting: false, level: 'best' });
  h.hooks.build = (_, n) => {
    if (n !== 1) return;
    h.canvas.xr.isPresenting.value = true;
    h.canvas.webgl.xr.session = { inputSources: [], newlyEntered: true };
    h.canvas.setProps(budget.xrPostprocessingProps(false));
  };
  await assert.rejects(h.set('fast'), { code: 'stale_transition' });
  assert.equal(h.stored(), 'best');
  assert.equal(budget.activeRenderQuality(h.context), 'best');
  assert.equal(h.geometry().level, 'best');
  assert.equal(h.geometry().presenting, true);
  assert.deepEqual(h.buildModes, [false, true]);
  assert.equal(h.canvas.props.postprocessing.enabled, true);
  assert.equal(h.canvas.props.xr.disablePostprocessing, false);
  assert.equal(h.canvas.props.postprocessing.occlusion.name, 'on');
  assert.equal(h.context.state.status, 'ready');
});

test('XR exit after the candidate draw restores desktop geometry without clobbering exit passes', async () => {
  const h = harness();
  h.hooks.frame = n => {
    if (n !== 1) return;
    h.canvas.xr.isPresenting.value = false;
    h.canvas.webgl.xr.session = undefined;
    h.canvas.props.postprocessing = { enabled: true, desktopExit: true };
  };
  await assert.rejects(h.set('best'), { code: 'stale_transition' });
  assert.equal(h.stored(), 'balanced');
  assert.equal(h.geometry().level, 'balanced');
  assert.equal(h.geometry().presenting, false);
  assert.deepEqual(h.buildModes, [true, false]);
  assert.deepEqual(h.canvas.props.postprocessing, { enabled: true, desktopExit: true });
  assert.equal(h.context.state.status, 'ready');
});

test('a replacement XR layer with provisional scale is reported through the normal refusal message', async () => {
  const h = harness();
  const provisionalScale = budget.renderQualityPreset('best', { deviceClass: 'quest2', atomSites: 13121 }).framebufferScale;
  h.context.lastLayerScale = () => provisionalScale;
  h.hooks.frame = n => {
    if (n !== 1) return;
    h.canvas.webgl.xr.session = { inputSources: [], replacement: true };
    h.canvas.setProps(budget.xrPostprocessingProps(true));
  };
  let refusal;
  await assert.rejects(h.set('best'), error => { refusal = error; return error.code === 'stale_transition'; });
  assert.equal(refusal.renderQualityRestoration.status, 'restored_next_entry');
  assert.equal(refusal.renderQualityRestoration.scaleAppliesOnNextEntry, true);
  assert.equal(refusal.renderQualityRestoration.layerScale, provisionalScale);
  assert.match(refusal.message, /framebuffer resolution applies on the next XR entry/);
  assert.equal(h.captions.at(-1), refusal.message, 'the wearer receives the same actionable recovery detail');
  assert.equal(h.stored(), 'balanced');
  assert.equal(h.canvas.props.postprocessing.enabled, false);
  assert.equal(h.geometry().level, 'balanced');
  assert.equal(h.context.state.status, 'ready');
});

test('one XR edge during rollback gets one rebuild in the new mode and preserves the original error', async () => {
  const h = harness();
  const error = fault('frame_timeout');
  h.hooks.frame = n => { if (n === 1) throw error; };
  h.hooks.build = (_, n) => {
    if (n !== 2) return;
    h.canvas.xr.isPresenting.value = false;
    h.canvas.webgl.xr.session = undefined;
    h.canvas.props.postprocessing = { enabled: false, desktopExit: true };
  };
  await assert.rejects(h.set('best'), value => value === error);
  assert.deepEqual(h.buildModes, [true, true, false]);
  assert.equal(h.geometry().presenting, false);
  assert.equal(h.geometry().level, 'balanced');
  assert.equal(h.stored(), 'balanced');
  assert.equal(error.renderQualityRestoration.status, 'restored');
  assert.equal(h.context.state.status, 'ready');
});

test('repeated rollback session edges stop after the bounded retry and expose failed restoration', async () => {
  const h = harness();
  const error = fault('frame_timeout');
  h.hooks.frame = n => { if (n === 1) throw error; };
  h.hooks.build = (_, n) => { if (n > 1) h.canvas.webgl.xr.session = { inputSources: [], n }; };
  await assert.rejects(h.set('best'), value => value === error);
  assert.equal(h.builds.length, 3);
  assert.equal(error.code, 'frame_timeout');
  assert.equal(error.renderQualityRestoration.status, 'failed');
  assert.match(error.message, /Previous quality restoration failed.*XR session changed/);
  assert.equal(h.stored(), 'balanced');
  assert.equal(h.context.state.status, 'error');
  assert.equal(h.context.busy, false);
});

test('GL loss during rollback reports pending recovery while preserving the original refusal', async () => {
  const h = harness();
  const error = fault('frame_timeout');
  h.hooks.frame = n => { if (n === 1) throw error; };
  h.hooks.build = (_, n) => {
    if (n !== 2) return;
    h.canvas.webgl.isContextLost = true;
    throw fault('context_lost', 'The molecular WebGL context was lost.');
  };
  await assert.rejects(h.set('best'), value => value === error);
  assert.equal(error.code, 'frame_timeout');
  assert.equal(error.renderQualityRestoration.status, 'pending');
  assert.match(error.message, /pending context recovery/);
  assert.doesNotMatch(error.message, /restoration failed/);
  assert.equal(h.stored(), 'balanced');
  assert.equal(budget.activeRenderQuality(h.context), 'balanced');
  assert.equal(h.context.pendingContextLoss.previous.renderQualityCheckpoint.level, 'balanced');
});

for (const search of ['?xrRenderBudget=postfx:off', '?xrRenderBudget=off'])
  test(`best receipt reads actual disabled XR passes for ${search}`, async () => {
    const h = harness();
    h.context.location.search = search;
    const result = await h.set('best');
    assert.equal(result.applied.postfx, false);
    assert.equal(h.canvas.props.postprocessing.enabled, false);
    assert.equal(h.canvas.props.xr.disablePostprocessing, true);
    assert.equal(h.stored(), 'best');
  });

test('desktop postfx receipt reads retained canvas settings rather than the best preset', async () => {
  const h = harness({ presenting: false });
  h.canvas.props.postprocessing.enabled = false;
  const result = await h.set('best');
  assert.equal(result.applied.postfx, false);
  assert.equal(h.canvas.props.postprocessing.enabled, false);
});

test('held manipulation refuses quality admission before any shared setting or geometry changes', async () => {
  const h = harness();
  h.context.interactionActive = () => true;
  await assert.rejects(h.set('best'), { code: 'interaction_active' });
  assert.equal(h.stored(), 'balanced');
  assert.equal(budget.activeRenderQuality(h.context), 'balanced');
  assert.equal(h.builds.length, 0);
  assert.equal(h.frames.length, 0);
  assert.deepEqual(h.canvas.props, h.initialProps);
});

for (const delayedEvent of [false, true])
test(`actual context recovery rebuilds retired Mol* geometry at retained quality, delayed event=${delayedEvent}`, async () => {
  const cif = readFileSync(new URL('../../fixtures/identity-edge.cif', import.meta.url), 'utf8');
  const catalog = await extraction.extractBytes(Buffer.from(cif), { assemblyId: '1' });
  const source = { id: 'quality-recovery', cif, catalog, sha256: catalog.source.sha256 };
  const scene = { modelNumber: 1, assemblyId: '1',
    camera: { mode: 'perspective', fov: Math.PI / 4, position: [0, 0, 100], target: [0, 0, 0], up: [0, 1, 0],
      radius: 20, radiusMax: 20, fog: 0, clipFar: true, minNear: 0, minFar: 0 },
    inspection: { placement: { translation: [0, 1, -4], rotation: [0, 0, 0], scale: 20 } } };
  budget.setActiveRenderQuality('balanced');
  const previousDocument = globalThis.document;
  globalThis.document = { addEventListener() {}, removeEventListener() {},
    createElement: () => ({ setAttribute() {} }), head: { appendChild() {}, removeChild() {} } };
  const h = await sourceLoadHarness(source, scene);
  try {
    const c = h.context;
    const retainedScene = plain(c.liveScene());
    h.canvas.props = structuredClone(budget.xrPostprocessingProps(true));
    h.canvas.setProps = props => {
      for (const key of Object.keys(props)) h.canvas.props[key] = { ...h.canvas.props[key], ...structuredClone(props[key]) };
    };
    h.canvas.setProps(budget.xrPostprocessingProps(false));
    const storage = new Map([[budget.RENDER_QUALITY_STORAGE_KEY, 'balanced']]);
    Object.assign(c, { ...budget, navigator: { userAgent: 'Mozilla/5.0 Quest 2 OculusBrowser/150.0' },
      sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
      recordCost() {}, structureAtomSites: () => 100, refreshStructureSubject() {},
      renderQualityApplied: () => ({}), recordRenderQuality() {},
      spatialInputOwners: new Set(), spatialOwnedHands: new Set(), manualXrInputHeld: false,
      spatialReleaseUntil: 0, latestHeadContext: null, pendingPresentationPick: undefined,
      motionContextPaused: false, recoveryRecord: undefined, recoveryPromise: undefined,
    });
    c.state.contextRestorationCount = 0;
    const desktopProps = structuredClone(h.canvas.props);
    desktopProps.postprocessing.outline = { name: 'on', params: { desktop: true } };
    c.plugin.animationLoop = { isAnimating: true, stop() {} }; h.canvas.requestResize = () => {};
    c.immersiveSession.end = async () => {
      h.canvas.xr.isPresenting.value = false;
      h.canvas.webgl.xr.session = undefined;
      h.canvas.props = structuredClone(desktopProps);
    };
    c.candidateRecords.delete(c.current);
    for (const name of ['assertContext', 'assertReady', 'renderQualityLevel', 'renderQualityContext', 'assertRenderQualityContext',
      'applyRenderQualityPostprocessing', 'renderQualityCheckpoint', 'restoreRenderQualityCheckpoint', 'canRebuildForXr',
      'beginWork', 'restoreRecord', 'setRenderQuality', 'contextLost', 'contextRestored'])
      vm.runInContext(pageFunction(viewer, name), c);
    const builtLevels = [];
    c.xrRepresentationQuality = options => {
      builtLevels.push(budget.activeRenderQuality(c));
      return budget.xrRepresentationQuality({ ...options, session: h.session, navigator: c.navigator, scope: c });
    };
    c.applyInspectionAppearance = async options => {
      options?.check?.();
      const appearance = c.inspectionSnapshot().appearance;
      const quality = c.xrRepresentationQuality({ presenting: h.canvas.xr.isPresenting.value, representation: appearance.representation });
      const params = c.createStructureRepresentationParams(c.plugin, c.structure.obj.data,
        { type: appearance.representation, color: appearance.color, typeParams: quality ? { quality } : {} });
      await c.representation.update(params).commit({ revertOnError: true });
      c.representation.obj.data.repr.setState({ visible: true });
      options?.check?.();
    };
    const originalWait = c.waitForFrame;
    let failFrame = true;
    c.waitForFrame = async (...args) => {
      if (!failFrame) return originalWait(...args);
      failFrame = false;
      // Model the staged renderer's outgoing subtree retirement, followed by
      // GL loss after that draw. Recovery must construct real cells again.
      h.canvas.remove(c.current.representation.obj.data.repr);
      await c.plugin.state.data.build().delete(c.current.representation.ref).commit();
      h.canvas.webgl.isContextLost = true;
      if (!delayedEvent) c.contextLost();
      throw fault('context_lost');
    };
    await assert.rejects(c.setRenderQuality('best'), { code: 'context_lost' });
    if (delayedEvent) {
      assert.equal(c.activeWork, undefined);
      assert.equal(c.pendingContextLoss.previous.renderQualityCheckpoint.level, 'balanced');
      c.contextLost();
    }
    assert.equal(c.recoveryRecord.renderQualityCheckpoint.level, 'balanced');
    assert.equal(storage.get(budget.RENDER_QUALITY_STORAGE_KEY), 'balanced');
    // A late provisional read must also be corrected by restoreRecord itself.
    budget.setActiveRenderQuality('best');
    h.canvas.webgl.isContextLost = false;
    c.contextRestored();
    await c.recoveryPromise;
    assert.equal(c.state.status, 'ready');
    assert.equal(c.state.contextRestorationCount, 1);
    assert.ok(builtLevels.length > 0);
    assert.equal(builtLevels[0], 'best', 'the provisional change builds actual Mol* geometry');
    assert.ok(builtLevels.slice(1).every(level => level === 'balanced'));
    assert.ok(builtLevels.length >= 3, 'source recovery and its final appearance both build at the retained tier');
    assert.equal(budget.activeRenderQuality(c), 'balanced');
    assert.deepEqual(plain(c.liveScene()), retainedScene);
    assert.equal(h.canvas.xr.isPresenting.value, false, 'context loss ends the XR session');
    assert.deepEqual(h.canvas.props, desktopProps);
    assert.ok(h.canvas.getRenderObjects().length > 0, 'actual rebuilt Mol* geometry is retained');
    assert.equal(c.busy, false);
  } finally {
    h.dispose(); budget.setActiveRenderQuality('balanced');
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});
