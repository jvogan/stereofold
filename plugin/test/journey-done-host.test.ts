import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { transpileModule, ScriptTarget, ModuleKind } from 'typescript';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, it, vi } from 'vitest';
import { createStereoStructureServer } from '../src/server.js';
import { createReplyAudioSynthesizer } from '../src/headset-reply-audio.js';
import { PRIVATE_INSPECTION_META_KEY as KEY, cameraPose } from '../src/inspection-contract.js';
import { decodeInspectionCatalog } from '../src/inspection-catalog-codec.js';
import { readStructureHeading } from '../src/structure-heading.js';
import { mountExperiencePlayer } from '../src/experience-player.js';
import { savedLessonPlayback } from '../src/tour-player.js';
import { TOURS } from '../src/tour-catalog.js';
import { abortableSwapPhase, createSourceSwapTrace, SWAP_PHASE_TIMEOUT_MS } from '../src/source-swap-trace.js';
import { followsSourceTransition } from '../src/inspection-panel-recovery.js';
import { createSaveRetryAdmission } from '../src/inspection-save-retry.js';
import { canRefreshInspectionAttach, isStaleInspectionAttach, MAX_ATTACH_REFRESHES, STALE_ATTACH_MESSAGE } from '../src/inspection-attach-recovery.js';
import { inspectionRefusalCaption, shouldCaptionInspectionRefusal } from '../src/inspection-refusal-caption.js';
import { createPanelNarrator, narrationLines } from '../src/panel-narration.js';
import { applyTourCommand, tourHeartbeat, createPanelTourController } from '../src/inspection-tour-client.js';
import { createCompanionClient, forgetCompanionPageKey } from '../src/inspection-companion-client.js';
import { inMemoryCompanionNetwork } from './fixtures/in-memory-companion-network.js';
import { standaloneHostCall } from './fixtures/standalone-host-call.js';
// @ts-ignore Execute the production inspector closures with page/GPU adapters.
import { journeyNavigationHarness, inspectorSource } from '../../lab/browser-roundtrip/fixtures/journey-navigation-harness.mjs';
// @ts-ignore Shared DOM adapter.
import { tourEndHarness } from '../../lab/browser-roundtrip/fixtures/tour-end-harness.mjs';
// @ts-ignore Production menu rows and page hook; the viewer action closure is executed below.
import { spatialToolbarRows } from '../../lab/browser-roundtrip/spatial-toolbar-content.mjs';
// @ts-ignore Shared page menu hook.
import { installSpatialMenuHook } from '../../lab/browser-roundtrip/spatial-menu-hook.mjs';
// @ts-ignore Real toolbar/action chain with GPU adapters.
import { toolbarFrameRuntime, toolbarFrameHarness } from '../../lab/browser-roundtrip/fixtures/toolbar-frame-runtime.mjs';
// @ts-ignore The page caption writer used by the inspector.
import { showHeadsetCaption, setHeadsetCaptionSink } from '../../lab/browser-roundtrip/xr-manipulate.mjs';
// @ts-ignore Real Mol* source staging with a controlled canvas/XR scheduler.
import { sourceLoadHarness } from '../../lab/browser-roundtrip/fixtures/source-load-harness.mjs';
// @ts-ignore The wearer plate's own copy, so the test reads what the headset reads.
import { outcomeCopy } from '../../lab/browser-roundtrip/outcome-copy.mjs';
// @ts-ignore Keep the extracted attach/advisory path on its production validators.
import { sourceGeometryBudget, geometryBudgetChanged } from '../../lab/browser-roundtrip/geometry-advisory.mjs';

// Normalized molecular placement from a device session record.
// No room pose, eye matrices or private source coordinates are retained here.
const d80Standoff = { translation: [-4.092050236223615, .45296589069680104, 6.137153077783037],
  rotation: [0, 0, 0], scale: 1.020230173879569 };

const transport = vi.hoisted(() => ({ dispatch: undefined as any, lan: false }));
const sources = vi.hoisted(() => ({ swap: false, binder: false, refused: false }));
vi.mock('../src/molecular-experience.js', async original => {
  const module = await original<any>();
  const base = module.experienceById('hemoglobin-quaternary-structure');
  // Two checked-in public coordinate fixtures, with the real stage validator,
  // server navigation and claim rules. No external database is contacted.
  const first = base.stages[0];
  const second = { ...first, id: 'crambin-fixture', source: { ...first.source, pdbId: '1CRN' },
    assembly: { ...first.assembly, visibleEntityIds: ['1'], selectedEntityIds: ['1'] } };
  const fixture = { ...base, stages: [first, second], steps: base.steps.map((step: any, index: number) =>
    index === 0 ? step : { ...step, stageId: second.id, selectionEntityIds: ['1'] }) };
  // Keep the binder's authored chapter/stage order, using the two local
  // coordinate fixtures and their entity selections at each source boundary.
  const binder = module.experienceById('public-binder-workflow');
  const binderFixture = { ...binder,
    stages: binder.stages.map((stage: any, index: number) => ({ ...(index % 2 ? second : first), id: stage.id })),
    steps: binder.steps.map((step: any) => ({ ...step, selectionEntityIds: ['1'] })),
  };
  const definition = (id: string) => {
    if (sources.binder && id === binder.id) return binderFixture;
    if (sources.swap && id === base.id) return sources.refused ? { ...fixture,
      stages: [first, { ...second, source: { ...second.source, modelNumber: 2 } }],
    } : fixture;
    return module.experienceById(id);
  };
  return { ...module, experienceById: definition,
    get MOLECULAR_EXPERIENCES() { return module.MOLECULAR_EXPERIENCES.map((item: any) => definition(item.id)); },
  };
});
vi.mock('../src/inspection-companion-http.js', async original => {
  const module = await original<any>();
  return { ...module, InspectionCompanionHttp: class extends module.InspectionCompanionHttp {
    constructor(options: any) {
      super({ ...options, ...(transport.lan ? { htmlPath: new URL('./fixtures/companion-shell.html', import.meta.url).pathname } : {}) });
      transport.dispatch = options.dispatch;
    }
    // Share the real server session without opening a socket in the fixture.
    async open(...args: any[]) { return transport.lan ? super.open(...args) : { url: 'http://127.0.0.1:12345/#fixture', port: 12345 }; }
  } };
});
vi.mock('../src/inspection-lan.js', async original => {
  const module = await original<any>();
  return { ...module, LanCompanion: class extends module.LanCompanion {
    constructor(options: any) { super({ ...options, ...(transport.lan ? {
      interfaces: () => ({ en0: [{ address: '10.0.0.1', family: 'IPv4', internal: false }] }), remember: false,
      createCertificate: async () => ({ key: Buffer.alloc(0), cert: Buffer.alloc(0), fingerprint: 'fixture' }),
    } : {}) }); }
  } };
});
const experienceId = 'hemoglobin-quaternary-structure';
const crn = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');
const hhb = await readFile(new URL('../../fixtures/4HHB.cif', import.meta.url), 'utf8');
const viewerSource = await readFile(new URL('../../lab/browser-roundtrip/viewer.mjs', import.meta.url), 'utf8');
const toolbarRuntime = await toolbarFrameRuntime();
async function toolbarMenu(t: Awaited<ReturnType<typeof setup>>) {
  const start = viewerSource.indexOf("        if (action.kind === 'tour-done')");
  const end = viewerSource.indexOf("        if (action.kind === 'tour-page')", start);
  expect(start).toBeGreaterThanOrEqual(0); expect(end).toBeGreaterThan(start);
  let complete: () => void, fail: (error: unknown) => void;
  const captions: string[] = [], plates: string[] = [];
  const live = toolbarFrameHarness(toolbarRuntime, { state: { tour: t.context.panelTour.getState() },
    onAction: async (action: any) => {
      try { await vm.runInNewContext(`(async()=>{${viewerSource.slice(start, end)}})()`, { action, spatialTour: t.context.panelTour }); complete?.(); }
      catch (error) { fail?.(error); throw error; }
    } });
  // Let the real serialized action wait for an XR frame. Yield between frames
  // so the toolbar's reading-window timer cannot spin inside microtasks.
  live.session.requestAnimationFrame = (callback: Function) => setImmediate(() => callback(performance.now(), live.frame));
  live.session.cancelAnimationFrame = clearImmediate;
  const unsubscribe = t.context.panelTour.subscribe(() => live.setState({ tour: t.context.panelTour.getState() }));
  toolbarRuntime.setTalkOutcomeSink((text: string) => { captions.push(text); });
  setHeadsetCaptionSink((text: string) => { plates.push(text); return live.toolbar.setStatus(text); });
  t.context.showHeadsetCaption = (text: string) => { t.events.push(text); return showHeadsetCaption(text); };
  await live.toolbar.update();
  // Early Done belongs to the expanded menu. These tests exercise its real
  // action chain, so open it explicitly rather than depending on entry layout.
  live.toolbar.runAction({ kind: 'collapse', value: false });
  await vi.waitFor(() => expect(live.toolbar.isCollapsed()).toBe(false));
  const detach = installSpatialMenuHook({ readRows: () => live.toolbar.rows(), readState: () => ({ tour: t.context.panelTour.getState() }),
    runAction: (action: any) => live.toolbar.runAction(action) });
  return { captions, plates, toolbar: live.toolbar, press: (id: string) => new Promise<void>((resolve, reject) => {
    complete = resolve; fail = reject;
    expect((globalThis as any).__stereofoldMenu.press(id)).toBe(true);
  }), close: async () => { detach(); unsubscribe(); setHeadsetCaptionSink(undefined); toolbarRuntime.setTalkOutcomeSink(undefined); await live.toolbar.dispose(); } };
}
function menu(player: ReturnType<typeof mountExperiencePlayer>) {
  const start = viewerSource.indexOf("        if (action.kind === 'tour-done')");
  const end = viewerSource.indexOf("        if (action.kind === 'tour-page')", start);
  expect(start).toBeGreaterThanOrEqual(0); expect(end).toBeGreaterThan(start);
  let pending: Promise<unknown>;
  const detach = installSpatialMenuHook({
    readRows: () => spatialToolbarRows({ tour: player.getState(), collapsed: false }),
    readState: () => ({ tour: player.getState() }),
    runAction: (action: any) => {
      pending = vm.runInNewContext(`(async()=>{${viewerSource.slice(start, end)}})()`, { action, spatialTour: player });
    },
  });
  return { detach, press: async (id: string) => {
    expect((globalThis as any).__stereofoldMenu.press(id)).toBe(true);
    return pending;
  } };
}
const bound = (data: any) => ({ sessionId: data.sessionId, serverEpoch: data.serverEpoch, sourceToken: data.sourceToken,
  stateRevision: data.stateRevision, inspectionRevision: data.inspectionRevision });
function execute(context: any, source: string) {
  return vm.runInContext(transpileModule(source, { compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.None } }).outputText, context);
}
function install(context: any, name: string) {
  let start = inspectorSource.indexOf(`async function ${name}(`);
  if (start < 0) start = inspectorSource.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThanOrEqual(0);
  execute(context, inspectorSource.slice(start, inspectorSource.indexOf('\n}\n', start) + 2));
}
async function setup(sameSource: boolean, livePage = false, now = Date.now, network?: ReturnType<typeof inMemoryCompanionNetwork>, journeyId = experienceId,
  acknowledge = async () => ({ wavBase64: 'UklGRg==' }), hostTransport = false, transcriber?: any) {
  const dom = tourEndHarness(), events: string[] = [], diagnostics: any[] = [];
  const create = document.createElement.bind(document);
  document.createElement = ((name: string) => Object.assign(create(name), { querySelectorAll: () => [], remove() {} })) as any;
  document.removeEventListener = () => {};
  document.querySelector = (() => Object.assign(create('span'), { prepend() {} })) as any;
  const [a, b] = InMemoryTransport.createLinkedPair();
  // A Wi-Fi share publishes the scene record, so it goes to a file of this test's own.
  const sceneServiceFile = join(tmpdir(), `stereofold-journey-scene-${randomUUID()}.json`);
  const server = createStereoStructureServer(undefined, { now, sceneServiceFile, voice: { acknowledge }, ...(transcriber ? { transcriber } : {}), fetchPdbText: async (id: string) => id === '1CRN' ? crn : hhb, replyAudio: createReplyAudioSynthesizer({ enabled: false }) });
  const client = new Client({ name: 'Done regression', version: '1' });
  await server.connect(b); await client.connect(a);
  const hostCall = hostTransport ? standaloneHostCall(client) : undefined;
  const call = async (name: string, args: any) => {
    const result = await (hostCall ? hostCall(name, args) : client.callTool({ name: `stereo_structure.${name}`, arguments: args })) as any;
    if (result.isError) throw Error(result.content[0].text);
    return result;
  };
  const sessionId = (await call('inspect', { structureText: sameSource ? hhb : crn })).structuredContent.sessionId;
  const read = async () => (await call('get_inspection', { sessionId }))._meta[KEY];
  const initial = await read(); initial.catalog = await decodeInspectionCatalog(initial.catalogWire ?? initial.catalog); let token = initial.sourceToken;
  let scene: any = { sourceSha256: initial.catalog.source.sha256, modelNumber: 1, assemblyId: initial.catalog.assemblyId,
    selectionKeys: [initial.catalog.rows[0].key], camera: { mode: 'perspective', fov: Math.PI / 4, position: [0, 0, 80], up: [0, 1, 0], target: [0, 0, 0],
      radius: 20, radiusMax: 20, fog: 50, clipFar: true, minNear: 5, minFar: 0 },
    inspection: { appearance: { representation: 'cartoon', color: 'chain-id', uniformColor: '#ffffff', background: '#000000',
      highlightColor: '#ffff00', opacity: 1, labels: false, clipping: 0, fog: 0 }, placement: { translation: [.2, 0, 0], rotation: [0, 30, 0], scale: 1.2 } } };
  const originalScene = structuredClone(scene);
  const context = journeyNavigationHarness({ PRIVATE_KEY: KEY, binding: bound(initial), savedScene: scene,
    tourHeartbeat, applyTourCommand, savedLessonPlayback, TOURS, inspectionRefusalCaption, shouldCaptionInspectionRefusal, isCompanion: true, console: { warn() {} },
    toolResultError: (result: any) => result.isError ? result.content[0].text : undefined,
    publishModelContext() {}, detailedView: { note() {} }, updateReadinessStrip() {},
    voiceCommandSpeaker: () => undefined,
    recordHeadsetEvent: (kind: string, detail: any) => diagnostics.push({ kind, ...detail }), showHeadsetCaption: (text: string) => events.push(text),
    callStatus: (error: any) => error.status,
    companionCall: async (name: string, args: any) => {
      events.push(name);
      try {
        // HTTP owns snapshots, never references to the host's live attachment.
        const result = JSON.parse(JSON.stringify(await transport.dispatch(sessionId, token, name, JSON.parse(JSON.stringify(args)))));
        if (result.structuredContent?.sourceToken) token = result.structuredContent.sourceToken;
        return result;
      } catch (error) {
        throw Object.assign(error as Error, { status: 409, code: 'companion_request' });
      }
    },
    workspace: { snapshot: () => ({ ready: true, interactionActive: false }), capture: () => scene },
    recoverConfirmation: async (error: Error) => { throw error; },
  });
  install(context, 'call');
  let drawFailure = false, hold: Promise<void> | undefined, beginRestore!: () => void;
  const restoreStarted = new Promise<void>(resolve => { beginRestore = resolve; });
  context.save = async (journeySave?: any) => {
    if (!context.dirty || context.remote || context.loading || context.blocked) return;
    const result = await context.call('sync_inspection', { ...context.expected(), scene, ...(journeySave ? { journeySave } : {}) });
    expect(result.structuredContent.saved).toBe(true);
    context.binding = bound(result.structuredContent); context.savedScene = scene; context.dirty = false;
  };
  context.scheduleSave = () => { context.dirty = true; };
  context.attach = async (replacesPanelId?: string, journeySave?: any) => {
    const attached = await context.call('attach_inspection', { ...context.expected(), surface: 'companion', ...(replacesPanelId ? { replacesPanelId } : {}), ...(journeySave ? { journeySave } : {}) });
    context.panelId = attached.structuredContent.panelId;
  };
  document.body ??= { dataset: {} } as any;
  Object.assign(context, {
    document, completedHydration: true, voiceOwnedSourceTransition: false, voiceInteraction: undefined, tourPlayer: undefined,
    sourceGeometryBudget, geometryBudgetChanged, sourceAdvisory: undefined, activePreviewRecording: undefined,
    sourceGeometryBudgetSupported: initial.sourceGeometryBudget === true, rendererContextSupported: initial.rendererContext === true,
    canRefreshInspectionAttach, isStaleInspectionAttach, MAX_ATTACH_REFRESHES, STALE_ATTACH_MESSAGE,
    epoch: initial.serverEpoch, sourceSwapTrace: undefined, sourceSwapContext: {}, retry: {}, reload: {}, details: {},
    syncHandoff() {}, handoffVersion: 0, registerComparisonSources: async () => {},
    decodeInspectionCatalog, verifyInspectionCatalogSource: async () => {}, sceneImportLoadSettings: () => ({}),
    beginSourceSwapTrace: () => ({ phase: async (_phase: string, task: any) => task, skip() {}, fail() {} }),
    parseNativeStructureViewerHandoff: () => undefined, noteNamedViews() {}, updateSceneImportNotice() {}, openGrownTier: async () => {},
    hostTakesPageBuild: true, rejectsPageBuild: () => false,
    abortableSwapPhase,
    placeLessonScene: async (_workspace: any, options: any) => { await options.placeExperienceStep?.(); },
    detach: async () => {
      const retiring = context.panelId; context.panelId = undefined;
      if (retiring) await context.call('detach_inspection', { ...context.expected(), panelId: retiring, reason: 'loading' });
    },
  });
  Object.assign(context.workspace, {
    snapshot: () => ({ ready: true, interactionActive: false, sourceSha256: scene.sourceSha256, modelNumber: scene.modelNumber, assemblyId: scene.assemblyId, sourceSubset: false, xrPresenting: true }),
    setStatus() {}, identityRows: () => [],
    viewer: { xr: { refreshToolbar: async () => {} }, inspection: { configure: async (appearance: any) => {
      scene = { ...scene, inspection: { ...scene.inspection, appearance: { ...scene.inspection.appearance, ...appearance } } };
    } }, select: async (keys: string[]) => { scene = { ...scene, selectionKeys: keys }; } },
    loadSource: async (source: any, options: any) => {
      if (options.restorePlacement) {
        events.push('restore-draw-pending'); beginRestore(); await hold;
        if (drawFailure) { drawFailure = false; throw Error('Restore draw failed'); }
      }
      scene = options.scene ? structuredClone(options.scene) : { ...scene, sourceSha256: source.sha256,
        assemblyId: source.catalog.assemblyId, selectionKeys: [] };
      events.push('drawn');
    },
    restore: async (saved: any, options: any = {}) => {
      if (options.restorePlacement) {
        events.push('restore-draw-pending'); beginRestore(); await hold;
        if (drawFailure) { drawFailure = false; throw Error('Restore draw failed'); }
      }
      scene = structuredClone(saved); events.push('drawn');
    },
    applyRemote: async (change: any, admit: () => Promise<void>, confirm: (scene: any) => Promise<void>) => {
      await admit();
      scene = { ...scene, inspection: { ...scene.inspection, appearance: { ...scene.inspection.appearance, ...change.patch } } };
      await confirm(scene);
    },
  });
  install(context, 'hydrate');
  install(context, 'reconcileExperience');
  install(context, 'announceSourceGeometryBudget');
  if (livePage) {
    Object.assign(context, {
      edits: 0, saving: Promise.resolve(), timer: undefined, saveAttempts: 0, reloading: false,
      saveRetryAdmission: createSaveRetryAdmission(),
      panelId: undefined, attaching: undefined, attachRetryAt: 0, leavingForDetailedView: false,
      localInteractionSerial: 0, canRefreshInspectionAttach, isStaleInspectionAttach, MAX_ATTACH_REFRESHES, STALE_ATTACH_MESSAGE,
      clearTimeout, setTimeout, pollInFlight: false, repairNeeded: false, armPoll() {},
      // Poll's caption delivery reaches the page event boundary after refusal.
      recordTalkReplyDelivery() {}, dispatchEvent: (event: { type: string }) => { events.push(event.type); },
      CustomEvent: class { constructor(public type: string, public options: unknown) {} },
      xrStartupReport: () => ({ phase: 'active', pending: false, reloadRequired: false, mode: 'immersive-ar', gestureActive: true, presenting: true }), handoffSpokenRequest() {}, followsSourceTransition,
      recoverSave: (_kind: string, message: string) => { throw Error(message); },
    });
    for (const name of ['scheduleSave', 'save', 'recoverSave', 'attach', 'detach', 'poll', 'beatSuspended']) install(context, name);
    execute(context, inspectorSource.match(/^const voiceBindingKey=.*$/m)![0]);
    context.workspace.restoreShared = async (saved: any, admit: () => void, preserveCamera: boolean, restorePlacement: boolean) => {
      admit(); await context.workspace.restore(saved, { preserveCamera, restorePlacement });
    };
    context.beginSourceSwapTrace = () => ({
      phase: async (phase: string, task: any) => {
        const value = await task;
        // A timer tick resumes after save and before hydrate's attach. This
        // is normal on device; the old fixture never ran the actual poll.
        if (phase === 'saved' && context.pollDuringSave) await context.poll();
        return value;
      }, skip() {}, fail() {},
    });
  }
  // Execute every production player callback, including finish's navigation
  // and receipt checks. Only the DOM, GPU and speech output are adapters.
  const playerStart = inspectorSource.indexOf('  experiencePlayer=mountExperiencePlayer({after:');
  const playerEnd = inspectorSource.indexOf('\n  panelTour=', playerStart);
  expect(playerStart).toBeGreaterThanOrEqual(0); expect(playerEnd).toBeGreaterThan(playerStart);
  Object.assign(context, { mountExperiencePlayer, speakNarration: async () => {} });
  execute(context, inspectorSource.slice(playerStart, playerEnd));
  const player = context.experiencePlayer as ReturnType<typeof mountExperiencePlayer>;
  player.setCatalog([{ id: journeyId, title: journeyId }]); context.panelTour = createPanelTourController({ ...player, getState: () => ({ ...player.getState(), active: false, navigating: false, tours: [] }) }, player); context.experiencePlayer = player;
  context.dirty = true; await context.save(); await context.attach();
  if (livePage) {
    const opened = await call('open_companion', { ...context.expected(), connection: network ? 'lan' : 'loopback' });
    if (network) {
      const key = await network.pair(opened.structuredContent.companion);
      vi.stubGlobal('fetch', network.fetch);
      vi.stubGlobal('location', { hash: `#${key}`, href: `https://10.0.0.1:8443/viewer#${key}` });
      forgetCompanionPageKey();
      const clientCall = createCompanionClient();
      context.companionCall = async (name: string, args: any) => { events.push(name); return clientCall(name, args); };
    }
  }
  const state = async (commandId?: string) => (await call('get_inspection_state', { sessionId, ...(commandId ? { commandId } : {}) })).structuredContent;
  let serial = 0;
  const remote = async (action: string, targetPanel = context.panelId) => {
    const commandId = `d38-${action}-${serial++}`;
    const sent = { ...context.expected(), panelId: context.panelId, availability: 'ready', tourState: tourHeartbeat(player) };
    await context.call('poll_inspection', sent);
    const queued = await call('control_tour', { ...context.expected(), panelId: targetPanel, commandId, action, ...(action === 'start' ? { tourId: journeyId } : {}) });
    expect(queued.structuredContent.command.status).toBe('queued');
    const delivery = (await context.call('poll_inspection', sent))._meta[KEY].delivery;
    expect(delivery).toBeTruthy();
    await context.receive(delivery, sent, context.generation);
    return state(commandId);
  };
  const colour = async (targetPanel = context.panelId, utteranceId?: string) => {
    const commandId = `d43-colour-${serial++}`;
    const sent = { ...context.expected(), panelId: context.panelId, availability: context.liveAvailability() };
    await context.call('poll_inspection', sent);
    await call('update_inspection', { ...context.expected(), panelId: targetPanel, commandId, ...(utteranceId ? { utteranceId } : {}),
      change: { kind: 'appearance', patch: { color: 'uniform', uniformColor: '#ff0000' } } });
    const delivery = (await context.call('poll_inspection', sent))._meta[KEY].delivery;
    expect(delivery).toBeTruthy();
    await context.receive(delivery, sent, context.generation);
    return state(commandId);
  };
  return { context, player, originalScene, read, state, call, remote, colour, events, diagnostics, restoreStarted,
    failDraw: () => { drawFailure = true; }, holdDraw: (value: Promise<void>) => { hold = value; },
    close: async () => { clearTimeout(context.timer); player.dispose(); dom.cleanup(); await client.close(); await server.close(); } };
}

it('voice replaces a presenting standoff through Mol* with two current panels and a 130000 ms wait', async () => {
  const network = inMemoryCompanionNetwork(); transport.lan = true;
  let t: Awaited<ReturnType<typeof setup>> | undefined, viewer: any, surface: Awaited<ReturnType<typeof toolbarMenu>> | undefined,
    now = 0, pending: Promise<void> | undefined;
  try {
    t = await setup(true, true, () => now, network, experienceId, undefined, true);
    const scene = structuredClone(t.originalScene);
    scene.inspection.placement = structuredClone(d80Standoff);
    await t.context.workspace.restore(scene); t.context.scheduleSave(); await t.context.save(); await t.context.poll();
    const initial = await t.read();
    initial.catalog = await decodeInspectionCatalog(initial.catalogWire ?? initial.catalog);
    viewer = await sourceLoadHarness({ id: '4HHB', cif: hhb, sha256: initial.catalog.source.sha256, catalog: initial.catalog }, scene,
      (kind: string, detail: any) => t!.diagnostics.push({ kind, ...detail }));
    surface = await toolbarMenu(t);
    t.context.workspace.viewer.xr.refreshToolbar = () => surface!.toolbar.update();
    viewer.context.immersiveSession.syncBounds = () => surface!.toolbar.syncBounds();
    const owner = t.context.panelId;
    const desktop = (await t.call('attach_inspection', { ...t.context.expected(), surface: 'desktop' })).structuredContent.panelId;
    expect((await t.state()).panels.every((panel: any) => panel.current)).toBe(true);
    const desktopBeat = { ...t.context.expected(), panelId: desktop, availability: 'ready' };
    const utteranceId = (await t.call('update_inspection', { ...t.context.expected(), panelId: owner, commandId: 'd80-begin',
      change: { kind: 'utterance', patch: { action: 'begin' } } })).structuredContent.lifecycle.utterance.utteranceId;
    const load = t.context.workspace.loadSource;
    t.context.workspace.loadSource = async (next: any, options: any) => {
      expect(options.preserveCamera).toBe(true);
      await viewer.load(next, { modelNumber: options.modelNumber ?? 1, assemblyId: options.assemblyId ?? next.catalog.assemblyId });
      await load(next, options);
      await t!.context.workspace.restore({ ...t!.context.workspace.capture(), camera: viewer.snapshot().camera,
        inspection: { ...t!.context.workspace.capture().inspection, placement: viewer.snapshot().inspection.placement } });
    };
    // The wider placement range keeps these swaps in one render frame.
    // Measure the held molecular center and size rather than requiring the
    // camera rebase that the former ten-radius limit forced.
    const roomBounds = () => {
      const { base } = viewer.context.transitionBounds(viewer.context.current);
      const placement = viewer.snapshot().inspection.placement;
      return { center: base.center.map((value: number, axis: number) =>
        (value + placement.translation[axis] * base.radius) * viewer.canvas.camera.scale),
      radius: base.radius * placement.scale * viewer.canvas.camera.scale };
    };
    const heldBounds = roomBounds(), heldCamera = viewer.canvas.camera.getSnapshot();
    const heldCameraScale = viewer.canvas.camera.scale;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // Replace and then return, retaining the same scene, page, XR session and panel.
    for (const pdbId of ['1CRN', '4HHB']) {
      const oldToken = t.context.binding.sourceToken;
      let answer: any, toolError: unknown, drawError: unknown, settled = false;
      pending = t.call('replace_inspection_source', { ...t.context.expected(), panelId: owner, pdbId, utteranceId, waitForRenderMs: 130_000 })
        .then(value => { answer = value; }, error => { toolError = error; });
      while ((await t.state()).sourceToken === oldToken) {
        if (toolError) throw toolError;
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      expect((await t.state()).sourceRenderReceipt).toBeUndefined();
      const drawing = t.context.poll().catch((error: unknown) => { drawError = error; }).finally(() => { settled = true; });
      for (let step = 0; step < 500 && !settled; step++) {
        now += 20; await vi.advanceTimersByTimeAsync(20);
        await new Promise<void>(resolve => setImmediate(resolve));
        await t.context.busyBeat(t.context.generation);
        expect((await t.call('poll_inspection', desktopBeat))._meta[KEY].transitionTarget).toBe(false);
      }
      expect(settled).toBe(true); await drawing;
      expect(drawError).toBeUndefined();
      await vi.advanceTimersByTimeAsync(200); await pending;
      expect(toolError).toBeUndefined();
      expect(answer.structuredContent.sourceRenderStatus).toMatchObject({ rendered: true, panelId: owner });
      const after = await t.state();
      expect(after.sourceRenderReceipt).toMatchObject({ panelId: owner, rendered: true });
      expect(after.reclaimedPanels).toEqual([]);
      expect(after.panels).toHaveLength(2);
      expect(t.context.panelId).toBe(owner);
      const loadedSource = await t.read(), catalog = await decodeInspectionCatalog(loadedSource.catalogWire ?? loadedSource.catalog);
      expect(viewer.snapshot()).toMatchObject({ ready: true, xrPresenting: true, modelNumber: 1, assemblyId: 'asymmetric_unit',
        sourceSha256: catalog.source.sha256 });
      expect(viewer.frames.at(-1).some((repr: any) => repr.renderObjects.some((object: any) => object.values.drawCount.ref.value > 0))).toBe(true);
      const currentBounds = roomBounds();
      currentBounds.center.forEach((value: number, axis: number) => expect(value).toBeCloseTo(heldBounds.center[axis], 9));
      expect(currentBounds.radius).toBeCloseTo(heldBounds.radius, 9);
      expect(viewer.canvas.camera.scale).toBeCloseTo(heldCameraScale, 12);
      expect(viewer.canvas.camera.getSnapshot()).toEqual(heldCamera);
    }
    expect(t.diagnostics.filter(event => event.kind === 'transition' && event.operation === 'source').map(event => event.phase))
      .toEqual(['start', 'first-frame', 'old-removed', 'complete', 'start', 'first-frame', 'old-removed', 'complete', 'start', 'first-frame', 'old-removed', 'complete']);
    expect(t.events.join('\n')).not.toMatch(/detach_inspection|No link|Link.*lost|reconnecting/i);
    expect(surface.toolbar.rows().length).toBeGreaterThan(0);
    expect([...surface.captions, ...surface.plates].join('\n')).not.toMatch(/No link|Link.*lost|reconnecting/i);
    expect(t.diagnostics).not.toContainEqual(expect.objectContaining({ kind: 'source-anchor', anchor: 'rebased' }));
    expect((await t.colour(owner, utteranceId)).command.status).toBe('rendered');
  } finally {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(130_000);
    await pending; vi.useRealTimers(); await surface?.close(); viewer?.dispose();
    await t?.close(); network.close(); transport.lan = false;
    vi.unstubAllGlobals(); forgetCompanionPageKey();
  }
});

for (const failAt of ['after_representation', 'after_room_anchor']) it(`a source failure at ${failAt} records its reason and rolls back before retry`, async () => {
  const network = inMemoryCompanionNetwork(); transport.lan = true;
  let t: Awaited<ReturnType<typeof setup>> | undefined, viewer: any;
  try {
    t = await setup(true, true, Date.now, network);
    const scene = structuredClone(t.originalScene);
    scene.inspection.placement = structuredClone(d80Standoff);
    await t.context.workspace.restore(scene); t.context.scheduleSave(); await t.context.save(); await t.context.poll();
    const initial = await t.read(), catalog = await decodeInspectionCatalog(initial.catalogWire ?? initial.catalog);
    viewer = await sourceLoadHarness({ id: '4HHB', cif: hhb, sha256: catalog.source.sha256, catalog }, scene,
      (kind: string, detail: any) => t!.diagnostics.push({ kind, ...detail }));
    const beforeCamera = viewer.canvas.camera.getSnapshot(), beforeScale = viewer.canvas.camera.scale;
    const load = t.context.workspace.loadSource;
    t.context.workspace.loadSource = async (next: any, options: any) => { await viewer.load(next); await load(next, options); };
    const owner = t.context.panelId;
    await t.call('replace_inspection_source', { ...t.context.expected(), panelId: owner, pdbId: '1CRN' });
    viewer.context.failAt = failAt;
    const reason = `Injected ${failAt} failure`;
    await expect(t.context.poll()).rejects.toThrow(reason);
    expect(viewer.context.state.lastLoadFailure).toMatchObject({ message: reason, recovered: true });
    expect(viewer.snapshot()).toMatchObject({ sourceSha256: scene.sourceSha256, ready: true });
    expect(viewer.snapshot().inspection.placement).toEqual(scene.inspection.placement);
    expect(viewer.canvas.camera.getSnapshot()).toEqual(beforeCamera);
    expect(viewer.canvas.camera.scale).toBe(beforeScale);
    expect((await t.state()).sourceRenderReceipt).toMatchObject({ status: 'failed', rendered: false,
      failure: 'render_failed', failureReason: reason, panelId: owner });
    expect(t.context.panelId).toBe(owner);
    expect(t.diagnostics).toContainEqual(expect.objectContaining({ kind: 'transition', operation: 'source', phase: 'failed', reason }));
    expect(t.diagnostics).toContainEqual(expect.objectContaining({ kind: 'page-error', operation: 'source', message: reason }));
    expect(t.context.loadErrorDetails).toBe(reason);
    expect(t.events).toContain('Structure load failed. Your previous view is still shown.');
    viewer.context.failAt = undefined;
    await t.context.poll();
    expect((await t.state()).sourceRenderReceipt).toMatchObject({ panelId: owner, rendered: true });
  } finally {
    viewer?.dispose(); await t?.close(); network.close(); transport.lan = false;
    vi.unstubAllGlobals(); forgetCompanionPageKey();
  }
});

for (const journey of [false, true]) it(`voice source replacement retains the presenting companion (journey ${journey})`, async () => {
  const network = inMemoryCompanionNetwork(); transport.lan = true;
  let t: Awaited<ReturnType<typeof setup>> | undefined;
  try {
    t = await setup(true, true, Date.now, network);
    if (journey) await t.remote('start');
    await t.context.poll();
    const owner = t.context.panelId, before = await t.state();
    const utterance = (await t.call('update_inspection', { ...t.context.expected(), panelId: owner,
      commandId: 'd78-begin', change: { kind: 'utterance', patch: { action: 'begin' } } })).structuredContent.lifecycle.utterance;
    const opened = await t.call('replace_inspection_source', { ...t.context.expected(), panelId: owner,
      pdbId: '1CRN', utteranceId: utterance.utteranceId });
    expect(opened.structuredContent.sourceTransition.sourceChanged).toBe(true);
    const callStart = t.events.length;
    await t.context.poll();
    expect(t.events.slice(callStart)).not.toContain('detach_inspection');
    expect(t.events.slice(callStart)).not.toContain('acknowledge_experience_step');
    expect(t.events).not.toContain('The lesson ended while the link was down. Back to your view.');
    expect(t.context.panelId).toBe(owner);
    const after = await t.state();
    expect(after.panels).toEqual([expect.objectContaining({ panelId: owner, current: true, availability: 'ready' })]);
    expect(after.reclaimedPanels).toEqual(before.reclaimedPanels);
    expect(after.sourceRenderReceipt).toMatchObject({ panelId: owner, rendered: true, sourceToken: after.sourceToken });
    expect(t.context.workspace.capture().sourceSha256).toBe((await t.read()).catalog.source.sha256);
    expect((await t.read()).pdbId).toBe('1CRN');
    expect(t.player.getState().active).toBe(false);
    expect(t.events.join('\n')).not.toMatch(/No link|Link.*lost|reconnecting/i);
    expect((await t.colour(owner, utterance.utteranceId)).command).toMatchObject({ status: 'rendered', panelId: owner });
  } finally {
    await t?.close(); network.close(); transport.lan = false;
    vi.unstubAllGlobals(); forgetCompanionPageKey();
  }
});

for (const renderAt of [61_000, 120_999, 140_000]) it(`presenting source draw at ${renderAt} ms keeps one panel and the host receipt`, async () => {
  const network = inMemoryCompanionNetwork(); transport.lan = true;
  let t: Awaited<ReturnType<typeof setup>> | undefined, now = 0;
  let release!: () => void, pending: Promise<void> | undefined, drawing: Promise<void> | undefined;
  try {
    t = await setup(true, true, () => now, network, experienceId, undefined, true);
    await t.remote('start'); await t.context.poll();
    const owner = t.context.panelId, oldToken = t.context.binding.sourceToken;
    const desktop = (await t.call('attach_inspection', { ...t.context.expected(), surface: 'desktop' })).structuredContent.panelId;
    const desktopBeat = { ...t.context.expected(), panelId: desktop, availability: 'ready' };
    const utteranceId = (await t.call('update_inspection', { ...t.context.expected(), panelId: owner,
      commandId: 'd78-wait-begin', change: { kind: 'utterance', patch: { action: 'begin' } } })).structuredContent.lifecycle.utterance.utteranceId;
    const loaded = t.context.workspace.loadSource;
    let started!: () => void;
    const drawStarted = new Promise<void>(resolve => { started = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    t.context.workspace.loadSource = async (...args: any[]) => { started(); await held; await loaded(...args); };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let answer: any, failure: unknown;
    pending = t.call('replace_inspection_source', { ...t.context.expected(), panelId: owner,
      pdbId: '1CRN', utteranceId, waitForRenderMs: 130_000 })
      .then(value => { answer = value; }, error => { failure = error; });
    while ((await t.state()).sourceToken === oldToken) await new Promise<void>(resolve => setImmediate(resolve));
    const budgetMs = (await t.state()).renderBudgetMs;
    drawing = t.context.poll();
    await drawStarted;
    const callStart = t.events.length;
    while (now < renderAt) {
      const step = Math.min(5_000, renderAt - now); now += step;
      await vi.advanceTimersByTimeAsync(step);
      const follower = await t.call('poll_inspection', desktopBeat);
      expect(follower._meta[KEY].transitionTarget).toBe(false);
      await t.context.busyBeat(t.context.generation, true);
      const state = await t.state();
      expect(t.context.panelId).toBe(owner);
      expect(state.panels).toEqual([expect.objectContaining({ panelId: owner, availability: 'busy' }),
        expect.objectContaining({ panelId: desktop, current: false })]);
      expect(state.sourceRenderReceipt).toBeUndefined();
      expect(failure).toBeUndefined();
      if (now < Math.min(budgetMs, 40_000)) expect(answer).toBeUndefined();
    }
    if (renderAt > Math.min(budgetMs, 40_000)) {
      await pending;
      expect(answer.structuredContent).toMatchObject({ sourceRenderReceipt: null,
        sourceRenderStatus: { rendered: false, status: 'timed_out' }, renderWait: { timedOut: true, budgetMs, askedMs: 130_000, waitedForMs: 40_000 } });
    }
    release(); await drawing; await pending;
    const state = await t.state(), source = await t.read();
    expect(state.panels).toEqual([expect.objectContaining({ panelId: owner, current: true, availability: 'ready' }),
      expect.objectContaining({ panelId: desktop, current: false })]);
    expect(state.sourceRenderReceipt).toMatchObject({ panelId: owner, rendered: true, renderedAt: renderAt });
    expect(source.pdbId).toBe('1CRN');
    expect(t.context.workspace.capture().sourceSha256).toBe(source.catalog.source.sha256);
    expect(t.events.slice(callStart).join('\n')).not.toMatch(/detach_inspection|No link|Link.*lost|reconnecting/i);
    expect(t.diagnostics.filter(event => event.kind === 'tool-refused')).toEqual([]);
    expect((await t.colour(owner, utteranceId)).command.status).toBe('rendered');
  } finally {
    release?.(); await drawing?.catch(() => {}); vi.useRealTimers();
    await t?.close(); await pending; network.close(); transport.lan = false;
    vi.unstubAllGlobals(); forgetCompanionPageKey();
  }
});

it.each(['registerComparisonSources','hydrateInspectionBytes'])('reports a source refusal before drawing when %s fails, and retries a dropped acknowledgement',async seam=>{
  const network=inMemoryCompanionNetwork();transport.lan=true;
  let t:Awaited<ReturnType<typeof setup>>|undefined;
  try {
    t=await setup(true,true,Date.now,network);
    const owner=t.context.panelId;
    await t.call('replace_inspection_source',{...t.context.expected(),panelId:owner,pdbId:'1CRN'});
    const original=t.context[seam],originalCall=t.context.call;
    let reports=0;
    t.context.call=async(name:string,args:any)=>{
      if(name==='report_source_failure' && ++reports<=2)throw Error('Acknowledgement socket dropped.');
      return originalCall(name,args);
    };
    t.context[seam]=async()=>{throw Error('Pre-draw source hydration failed.');};
    await expect(t.context.poll()).rejects.toThrow('Pre-draw source hydration failed.');
    expect(t.context.failedSourceLoad.receipt).toBeDefined();
    expect(t.context.panelId).toBe(owner);
    expect(t.context.workspace.capture()).toEqual(t.originalScene);
    t.context[seam]=original;
    t.context.blocked=true;
    await t.context.poll();
    expect(reports).toBe(2);
    expect(t.context.failedSourceLoad.receipt).toBeDefined();
    expect(t.context.panelId).toBe(owner);
    await t.context.poll();
    expect(reports).toBe(3);
    expect(t.context.failedSourceLoad.receipt).toBeUndefined();
    expect((await t.state()).sourceRenderReceipt).toMatchObject({status:'failed',rendered:false,
      failureReason:'Pre-draw source hydration failed.',panelId:owner});
    expect((await t.state()).sourceRecovery).toEqual({panelId:owner,ready:true});
    // A later manual retry advertises busy before reading its descriptor and
    // may fail with a different reason without losing the recovery owner.
    const calls:string[]=[];
    t.context.call=async(name:string,args:any)=>{calls.push(name+':'+(args.availability??''));return originalCall(name,args);};
    t.context[seam]=async()=>{throw Error('Second hydration failure.');};
    await expect(t.context.hydrate(t.context.binding.sessionId)).rejects.toThrow('Second hydration failure.');
    expect(calls.slice(0,2)).toEqual(['poll_inspection:busy','get_inspection:']);
    expect(t.context.failedSourceLoad.receipt).toBeUndefined();
    expect(t.context.panelId).toBe(owner);
    t.context[seam]=original;
    t.context.blocked=true;await t.context.poll();
    expect((await t.state()).sourceRecovery).toEqual({panelId:owner,ready:true});
  }finally{await t?.close();network.close();transport.lan=false;vi.unstubAllGlobals();forgetCompanionPageKey();}
});

it('a failed replacement draw keeps the panel and cannot publish a rendered receipt', async () => {
  const network = inMemoryCompanionNetwork(); transport.lan = true;
  let t: Awaited<ReturnType<typeof setup>> | undefined;
  try {
    t = await setup(true, true, Date.now, network);
    const owner = t.context.panelId, before = t.context.expected();
    await t.call('replace_inspection_source', { ...before, panelId: owner, pdbId: '1CRN' });
    const loaded = t.context.workspace.loadSource;
    t.context.workspace.loadSource = async () => { throw Error('Replacement draw failed'); };
    await expect(t.context.poll()).rejects.toThrow('Replacement draw failed');
    expect(t.context.panelId).toBe(owner);
    expect((await t.state()).sourceRenderReceipt).toMatchObject({ status: 'failed', rendered: false,
      failure: 'render_failed', failureReason: 'Replacement draw failed', panelId: owner });
    expect(t.context.workspace.capture()).toEqual(t.originalScene);
    await expect(t.call('update_inspection', { ...before, panelId: owner, commandId: 'd78-stale-edit',
      change: { kind: 'appearance', patch: { opacity: .5 } } })).rejects.toThrow('Load and save the intended inspection before changing appearance.');
    t.context.workspace.loadSource = loaded;
    await t.context.poll();
    expect((await t.state()).sourceRenderReceipt).toMatchObject({ rendered: true, panelId: owner });
    expect(t.context.panelId).toBe(owner);
  } finally {
    await t?.close(); network.close(); transport.lan = false;
    vi.unstubAllGlobals(); forgetCompanionPageKey();
  }
});

for (const replay of [false, true]) for (const start of ['menu', 'model']) it(`LAN row ${start === 'menu' ? 3 : 5}: ${start} start, two Nexts and model Done retain the panel and rendered receipt (transport replay ${replay})`, async () => {
  const network = inMemoryCompanionNetwork(replay);
  transport.lan = true;
  let t: Awaited<ReturnType<typeof setup>> | undefined;
  let now = 0, release!: () => void, pending: Promise<any> | undefined;
  try {
    t = await setup(true, true, () => now, network);
    const owner = t.context.panelId;
    if (start === 'model') {
      expect((await t.remote('start')).command.status).toBe('rendered');
      expect((await t.remote('pause')).command.status).toBe('rendered');
      for (let i = 0; i < 2; i++) expect((await t.remote('next')).command.status).toBe('rendered');
    } else {
      t.player.setCatalog((await t.read()).experienceCatalog);
      t.player.setSubject({ pdbId: '4HHB', sourceSha256: t.originalScene.sourceSha256, assembly: t.originalScene.assemblyId, modelNumber: 1 });
      const controls = menu(t.player);
      try {
        await controls.press('tour');
        await controls.press('next'); await controls.press('next');
      } finally { controls.detach(); }
    }
    expect(t.player.getState().step).toBe(2);
    expect(t.context.panelId).toBe(owner);
    const doneId = start === 'model' ? 'd38-done-4' : 'd38-done-0';
    const dispatch = t.context.companionCall, calls: string[] = [];
    let transition: any;
    t.context.companionCall = async (name: string, args: any) => {
      calls.push(name);
      if (name === 'sync_inspection' || name === 'attach_inspection') {
        expect(args.journeySave).toEqual({ panelId: owner, rollbackToken: transition.rollbackToken });
        expect(args.tourCommand).toMatchObject({ panelId: owner, commandId: doneId });
      }
      if (name === 'acknowledge_experience_step') {
        expect((await t!.state(doneId)).command.status).toBe('rendering');
        expect(t!.events).not.toContain('Back to your view');
        expect(args.completionToken).toBe(transition.completionToken);
      }
      const result = await dispatch(name, args);
      if (name === 'navigate_experience') transition = result.structuredContent.experienceTransition;
      return result;
    };
    t.holdDraw(new Promise<void>(resolve => { release = resolve; }));
    pending = t.remote('done');
    await Promise.race([t.restoreStarted, pending.then(() => { throw Error('Done ended before the restored draw'); })]);
    const waiting = await t.state(doneId);
    expect(waiting.command.status).toBe('rendering');
    expect(waiting.experienceCompletion.status).toBe('pending');
    expect(waiting.experienceCompletion.savedRevision).toBeUndefined();
    expect(t.context.panelId).toBe(owner);
    await t.context.busyBeat(t.context.generation, true);
    release();
    const done = await pending;
    t.context.companionCall = dispatch;
    expect(calls.filter(name => ['navigate_experience', 'get_inspection', 'sync_inspection', 'attach_inspection', 'acknowledge_experience_step'].includes(name)))
      .toEqual(['get_inspection', 'navigate_experience', 'get_inspection', 'sync_inspection', 'attach_inspection', 'acknowledge_experience_step']);
    expect(done.command).toMatchObject({ status: 'rendered', panelId: owner, renderedRevision: done.inspectionRevision });
    expect(done.experienceCompletion).toMatchObject({ status: 'rendered', savedRevision: done.inspectionRevision });
    expect(done.panels).toEqual([expect.objectContaining({ panelId: owner, current: true, availability: 'ready', tour: expect.objectContaining({ active: false }) })]);
    expect(done.pendingCommand).toEqual([]); expect(done.reclaimedPanels).toEqual([]);
    expect(t.context.workspace.capture()).toEqual(t.originalScene);
    expect(t.player.getState().active).toBe(false);
    expect(t.diagnostics.filter(event => event.kind === 'tool-refused')).toEqual([]);
    expect(t.events).toContain('Back to your view');
    expect((await t.colour()).command).toMatchObject({ status: 'rendered', panelId: owner });
    // Keep real heartbeats running beyond the old command/render budget.
    for (let i = 0; i < 3; i++) { now += 45_000; await t.context.busyBeat(t.context.generation); }
    const later = await t.state(doneId);
    expect(network.replays).toBe(0);
    expect(later.command.status).toBe('rendered'); expect(later.reclaimedPanels).toEqual([]);
    expect(later.panels).toEqual([expect.objectContaining({ panelId: owner, current: true, availability: 'ready', tour: expect.objectContaining({ active: false }) })]);
  } finally {
    release?.(); await pending?.catch(() => {});
    await t?.close(); network.close(); transport.lan = false;
    vi.unstubAllGlobals(); forgetCompanionPageKey();
  }
});

/** Observe real page calls through LAN, including the unsaved transition. */
async function traceJourneyPanel(t: Awaited<ReturnType<typeof setup>>) {
  const initial = await t.state(), owner = t.context.panelId;
  const calls: string[] = [], transitions: any[] = [];
  const dispatch = t.context.companionCall;
  const retained = async () => {
    const state = await t.state();
    expect(t.context.panelId).toBe(owner);
    expect(state.panels.map((panel: any) => panel.panelId)).toEqual([owner]);
    expect(state.reclaimedPanels).toEqual(initial.reclaimedPanels);
    return state;
  };
  t.context.companionCall = async (name: string, args: any) => {
    calls.push(name);
    expect(name).not.toBe('detach_inspection');
    await retained();
    if (args.journeySave) {
      expect(args.journeySave).toEqual({ panelId: owner, rollbackToken: transitions.at(-1).rollbackToken });
    }
    if (name === 'acknowledge_experience_step') {
      expect(calls.slice(calls.lastIndexOf('navigate_experience')).filter(tool =>
        ['navigate_experience', 'sync_inspection', 'attach_inspection', 'acknowledge_experience_step'].includes(tool)))
        .toEqual(['navigate_experience', 'sync_inspection', 'attach_inspection', 'acknowledge_experience_step']);
      if (args.tourCommand) expect((await t.state(args.tourCommand.commandId)).command.status).toBe('rendering');
    }
    const result = await dispatch(name, args);
    if (name === 'navigate_experience') transitions.push(result.structuredContent.experienceTransition);
    if (name === 'attach_inspection') expect(result.structuredContent.panelId).toBe(owner);
    await retained();
    return result;
  };
  return { owner, calls, transitions, async ready(step: number) {
    await t.context.poll();
    const state = await retained();
    expect(state.panels[0]).toMatchObject({ current: true, availability: 'ready' });
    expect(state.pendingCommand).toEqual([]);
    expect(t.player.getState().step).toBe(step);
    expect((await t.read()).scene).toEqual(t.context.workspace.capture());
    return state;
  } };
}

for (const sameSource of [false, true]) for (const origin of ['model', 'menu']) {
  it(`LAN panel trace: ${origin} start, same source ${sameSource}, next/back, pause/play, rejoin, restore-start and Done`, async () => {
    const network = inMemoryCompanionNetwork(); transport.lan = true;
    let t: Awaited<ReturnType<typeof setup>> | undefined, controls: ReturnType<typeof menu> | undefined;
    try {
      t = await setup(sameSource, true, Date.now, network);
      const trace = await traceJourneyPanel(t);
      controls = menu(t.player);
      const action = async (name: string) => {
        if (origin === 'model') {
          const state = await t!.remote(name, trace.owner);
          expect(state.command).toMatchObject({ status: 'rendered', panelId: trace.owner, renderedRevision: state.inspectionRevision });
        } else if (name === 'start') { await controls!.press('tours'); await controls!.press('tour'); }
        else await controls!.press(name === 'pause' || name === 'play' ? 'tour' : name);
      };
      await action('start'); await trace.ready(0);
      expect(trace.transitions.at(-1).sourceChanged).toBe(!sameSource);
      await action('pause'); await trace.ready(0);
      expect(t.player.getState().autoplay).toBe(false);
      const navigations = trace.transitions.length;
      await action('play'); await trace.ready(0);
      expect(t.player.getState().autoplay).toBe(true);
      expect(trace.transitions).toHaveLength(navigations);
      await action('pause');
      await action('next'); await trace.ready(1);
      expect(trace.transitions.at(-1).sourceChanged).toBe(false);
      await action('back'); await trace.ready(0);
      expect(trace.transitions.at(-1).sourceChanged).toBe(false);
      if (origin === 'model') {
        await action('rejoin'); await trace.ready(0);
        await action('next'); await trace.ready(1);
        await action('restore-start'); await trace.ready(0);
      }
      await action('done'); const done = await trace.ready(-1);
      expect(done.experienceCompletion).toMatchObject({ status: 'rendered', savedRevision: done.inspectionRevision });
      expect(t.context.workspace.capture()).toEqual(t.originalScene);
      expect((await t.colour(trace.owner)).command).toMatchObject({ status: 'rendered', panelId: trace.owner });
      expect(network.replays).toBe(0);
    } finally {
      controls?.detach(); await t?.close(); network.close(); transport.lan = false;
      vi.unstubAllGlobals(); forgetCompanionPageKey();
    }
  });
}

for (const origin of ['model', 'menu']) {
  it(`LAN panel trace: binder ${origin} next/back across all three source boundaries retains the pre-command ID`, async () => {
    const network = inMemoryCompanionNetwork(); transport.lan = true; sources.binder = true;
    let t: Awaited<ReturnType<typeof setup>> | undefined, controls: ReturnType<typeof menu> | undefined;
    try {
      t = await setup(true, true, Date.now, network, 'public-binder-workflow');
      const trace = await traceJourneyPanel(t);
      controls = menu(t.player);
      const action = async (name: string) => {
        if (origin === 'model') expect((await t!.remote(name, trace.owner)).command)
          .toMatchObject({ status: 'rendered', panelId: trace.owner });
        else if (name === 'start') { await controls!.press('tours'); await controls!.press('tour'); }
        else await controls!.press(name);
      };
      await action('start'); t.player.pause(); await trace.ready(0);
      for (let step = 1; step <= 15; step++) {
        const previous = { ...t.context.expected(), panelId: trace.owner };
        await action('next'); await trace.ready(step);
        expect(trace.transitions.at(-1).sourceChanged).toBe(step % 5 === 0);
        if (step % 5 !== 0) continue;
        const saved = await t.read();
        // A retained panel ID does not authorize a stale source binding.
        await expect(t.context.call('sync_inspection', { ...previous, scene: saved.scene }))
          .rejects.toThrow('This action belongs to a different structure.');
        expect((await t.read()).scene).toEqual(saved.scene);
        await action('back'); await trace.ready(step - 1);
        expect(trace.transitions.at(-1).sourceChanged).toBe(true);
        await action('next'); await trace.ready(step);
        expect(trace.transitions.at(-1).sourceChanged).toBe(true);
      }
      await action('done'); await trace.ready(-1);
      expect((await t.colour(trace.owner)).command).toMatchObject({ status: 'rendered', panelId: trace.owner });
      expect(network.replays).toBe(0);
    } finally {
      controls?.detach(); await t?.close(); network.close(); transport.lan = false; sources.binder = false;
      vi.unstubAllGlobals(); forgetCompanionPageKey();
    }
  });
}

for (const origin of ['model', 'menu']) {
  it(`LAN panel trace: catalog-refused ${origin} chapter retains its source, panel and refusal`, async () => {
    const network = inMemoryCompanionNetwork(); transport.lan = true; sources.swap = true; sources.refused = true;
    let t: Awaited<ReturnType<typeof setup>> | undefined, controls: ReturnType<typeof menu> | undefined;
    try {
      t = await setup(true, true, Date.now, network);
      const trace = await traceJourneyPanel(t);
      controls = menu(t.player);
      if (origin === 'model') expect((await t.remote('start', trace.owner)).command.status).toBe('rendered');
      else { await controls.press('tours'); await controls.press('tour'); }
      t.player.pause(); await trace.ready(0);
      const before = await t.read(), callCount = trace.calls.length;
      expect(before.experienceCatalog.find((item: any) => item.id === experienceId).deviceBudget.chapters[1])
        .toMatchObject({ status: 'refused', message: expect.stringContaining('Journey needs model 2; this source does not contain it.') });
      if (origin === 'model') {
        const refused = await t.remote('next', trace.owner);
        expect(refused.command).toMatchObject({ status: 'rejected', panelId: trace.owner,
          detail: expect.stringContaining('Journey needs model 2; this source does not contain it.') });
        expect(refused.command.renderedAt).toBeUndefined();
      } else await expect(controls.press('next')).rejects.toThrow('Journey needs model 2; this source does not contain it.');
      await trace.ready(0);
      const after = await t.read();
      expect(after.sourceToken).toBe(before.sourceToken);
      expect(after.inspectionRevision).toBe(before.inspectionRevision);
      expect(after.experience.revision).toBe(before.experience.revision);
      expect(after.scene).toEqual(before.scene);
      expect(trace.calls.slice(callCount)).not.toContain('attach_inspection');
      expect(trace.calls.slice(callCount)).not.toContain('acknowledge_experience_step');
      expect(t.player.getState().feedback).toContain('Journey needs model 2; this source does not contain it.');
      expect((await t.colour(trace.owner)).command).toMatchObject({ status: 'rendered', panelId: trace.owner });
    } finally {
      controls?.detach(); await t?.close(); network.close(); transport.lan = false; sources.swap = false; sources.refused = false;
      vi.unstubAllGlobals(); forgetCompanionPageKey();
    }
  });
}
for (const sameSource of [false, true]) for (const start of ['menu', 'model']) for (const done of ['menu', 'model']) {
  it(`delayed bookkeeping never captions after ${start} start, two Nexts and ${done} Done (same source ${sameSource})`, async () => {
    const network = inMemoryCompanionNetwork(); transport.lan = true;
    let t: Awaited<ReturnType<typeof setup>> | undefined, controls: Awaited<ReturnType<typeof toolbarMenu>> | undefined;
    let held: ReturnType<typeof network.holdNextTool> | undefined, speech: Promise<unknown> | undefined;
    try {
      t = await setup(sameSource, true, Date.now, network);
      controls = await toolbarMenu(t);
      // Run the actual page speaker, including its synthesis queue and call()
      // closure. Its Done feedback starts after the player clears pending.
      let speaker: any;
      Object.assign(t.context, { createPanelNarrator, setVoiceCommandSpeaker: (value: any) => { speaker = value; },
        voiceCommandSpeaker: () => speaker, voiceInteraction: { play: async () => {} } });
      const speakerStart = inspectorSource.indexOf('    setVoiceCommandSpeaker(createPanelNarrator(');
      const speakerEnd = inspectorSource.indexOf("    orb.addEventListener('click'", speakerStart);
      execute(t.context, inspectorSource.slice(speakerStart, speakerEnd));
      const owner = t.context.panelId;
      t.context.voiceCommandSpeaker = () => (...args: any[]) => { speech = speaker(...args); return speech; };
      if (start === 'model') { await t.remote('start'); await t.remote('pause'); }
      else { await controls.press('tours'); await controls.press('tour'); await controls.press('tour'); }
      await controls.press('next'); await controls.press('next');
      expect(t.player.getState().step).toBe(2);
      held = network.holdNextTool('voice_acknowledgement');
      const finished = done === 'menu' ? (await controls.press('done'), await t.state()) : await t.remote('done');
      expect(finished.experienceCompletion).toMatchObject({ status: 'rendered', savedRevision: finished.inspectionRevision });
      if (done === 'model') expect(finished.command).toMatchObject({ status: 'rendered', panelId: owner });
      expect(t.context.workspace.capture()).toEqual(t.originalScene);
      expect(t.context.panelId).toBe(owner);
      await held.request;
      expect(t.player.getState().navigating).toBe(false); expect(t.player.getState().active).toBe(false);
      expect((await t.colour()).command).toMatchObject({ status: 'rendered', panelId: owner });
      // A host transition can advance the companion before this page hydrates.
      // Recreate the device's two false flags with a real dispatcher refusal,
      // not a fabricated error or altered player state.
      await t.call('replace_inspection_source', { ...t.context.expected(), panelId: owner, pdbId: sameSource ? '1CRN' : '4HHB' });
      await t.context.companionCall('get_inspection', { sessionId: t.context.expected().sessionId });
      held.releaseRequest(); expect(await held.response).toBe(409);
      held.releaseResponse(); await speech?.catch(() => {});
      const refused = t.diagnostics.filter(event => event.kind === 'tool-refused' && event.tool === 'voice_acknowledgement');
      expect(refused).toEqual([expect.objectContaining({ status: 409, reason: 'This action belongs to a different structure.',
        captioned: false, journeyPending: false, staleBinding: false })]);
      expect(controls.captions).not.toContain('This action belongs to a different structure.');
      expect(controls.plates).not.toContain('This action belongs to a different structure.');
      expect(controls.plates).toContain('Back to your view');
      // The same host/page gap still explains a genuine live command refusal.
      await expect(t.context.call('replace_inspection_source', { ...t.context.expected(), panelId: owner, pdbId: '1CRN' }))
        .rejects.toThrow('This action belongs to a different structure.');
      expect(t.diagnostics).toContainEqual(expect.objectContaining({ tool: 'replace_inspection_source', captioned: true,
        journeyPending: false, staleBinding: false }));
      expect(controls.captions).toContain('This action belongs to a different structure.');
      expect(controls.plates).toContain('This action belongs to a different structure.');
    } finally {
      held?.releaseRequest(); held?.releaseResponse(); await speech?.catch(() => {});
      await controls?.close(); await t?.close(); network.close(); transport.lan = false;
      vi.unstubAllGlobals(); forgetCompanionPageKey();
    }
  });
}

it('live model and reported refusals keep tool hints off the wearer caption while preserving the model error', async () => {
  const network = inMemoryCompanionNetwork(); transport.lan = true;
  let t: Awaited<ReturnType<typeof setup>> | undefined;
  try {
    t = await setup(true, true, Date.now, network);
    const sent = { ...t.context.expected(), panelId: t.context.panelId, availability: 'ready' };
    await t.context.call('poll_inspection', sent);
    await expect(t.call('emphasize', { ...t.context.expected(), panelId: t.context.panelId, commandId: 'd76-live', parts: ['missing'] }))
      .rejects.toThrow('Open a lesson with inspect_lesson first.');
    const caption = (await t.context.call('poll_inspection', sent))._meta[KEY].headsetCaption;
    expect(caption.text).toBe('Could not apply · request refused. This inspection has no lesson colour key, so it has no named parts to emphasise. Open a lesson first.');
    expect(caption.speak).toBe(false);
    // A live page refusal still displays its reason, but downstream feedback
    // must receive the wearer copy while diagnostics retain the host's hint.
    await expect(t.context.call('voice_acknowledgement', { ...t.context.expected(), serverEpoch: randomUUID(),
      panelId: t.context.panelId, message: 'Current view.' }))
      .rejects.toThrow('The spoken line belongs to a replaced source. Try again with the current view.');
    expect(t.events).toContain('The spoken line belongs to a replaced source. Try again with the current view.');
    expect(t.diagnostics).toContainEqual(expect.objectContaining({ tool: 'voice_acknowledgement', captioned: true,
      reason: 'The spoken line belongs to a replaced source. Read get_inspection_state.' }));
    const report = t.call('say_to_headset', { text: 'The inspection changed. Read get_inspection_state and try again.',
      refusal: { tool: 'update_inspection', sessionId: sent.sessionId } });
    // Delivery is polled after the caller has enqueued the refusal.
    await vi.waitFor(async () => {
      const next = (await t!.context.call('poll_inspection', sent))._meta[KEY].headsetCaption;
      expect(next?.text).toBe('Could not apply · request refused. The inspection changed. Try again with the current view.');
    });
    await report;
  } finally {
    await t?.close(); network.close(); transport.lan = false; vi.unstubAllGlobals(); forgetCompanionPageKey();
  }
});

it('journey-owned voice refusal cannot return as a host-queued caption on the next heartbeat', async () => {
  const network = inMemoryCompanionNetwork(); transport.lan = true;
  let t: Awaited<ReturnType<typeof setup>> | undefined;
  try {
    t = await setup(true, true, Date.now, network);
    const sent = { ...t.context.expected(), panelId: t.context.panelId, availability: 'ready' };
    await t.context.call('poll_inspection', sent);
    await expect(t.context.call('voice_acknowledgement', { ...t.context.expected(), panelId: randomUUID(), message: 'Next chapter.' }, true))
      .rejects.toThrow('Headset speech requires a current headset page.');
    expect(t.diagnostics).toContainEqual(expect.objectContaining({ tool: 'voice_acknowledgement', captioned: false,
      staleBinding: false, journeyOwned: true }));
    expect((await t.context.call('poll_inspection', sent))._meta[KEY].headsetCaption).toBeUndefined();
  } finally {
    await t?.close(); network.close(); transport.lan = false; vi.unstubAllGlobals(); forgetCompanionPageKey();
  }
});

for (const origin of ['model', 'menu']) it(`binder ${origin} Next ×5 drops queued narration refused across the source boundary`, async () => {
  const network = inMemoryCompanionNetwork(); transport.lan = true; sources.binder = true;
  let t: Awaited<ReturnType<typeof setup>> | undefined, controls: Awaited<ReturnType<typeof toolbarMenu>> | undefined;
  let release!: () => void, entered!: () => void, holdSynthesis = true;
  const synthesisStarted = new Promise<void>(resolve => { entered = resolve; });
  const synthesisGate = new Promise<void>(resolve => { release = resolve; });
  const speech: Promise<unknown>[] = [], played: string[] = [];
  let held: ReturnType<typeof network.holdNextTool> | undefined;
  try {
    t = await setup(true, true, Date.now, network, 'public-binder-workflow', async () => {
      if (holdSynthesis) { holdSynthesis = false; entered(); await synthesisGate; }
      return { wavBase64: 'UklGRg==' };
    });
    controls = await toolbarMenu(t);
    const owner = t.context.panelId;
    // Model start and pause, followed by five Next commands through either UI.
    expect((await t.remote('start')).command.status).toBe('rendered');
    expect((await t.remote('pause')).command.status).toBe('rendered');
    const next = async () => {
      if (origin === 'model') expect((await t!.remote('next')).command).toMatchObject({ status: 'rendered', panelId: owner });
      else await controls!.press('next');
    };
    for (let step = 1; step <= 4; step++) { await next(); expect(t.player.getState().step).toBe(step); }
    const before = t.context.expected();
    let speaker: any;
    Object.assign(t.context, { createPanelNarrator, setVoiceCommandSpeaker: (value: any) => { speaker = value; },
      voiceCommandSpeaker: () => (...args: any[]) => { const pending = speaker(...args); speech.push(pending); return pending; },
      voiceInteraction: { play: async (_wav: string, line: string) => { played.push(line); } }, speechWasInterrupted: () => false });
    const speakerStart = inspectorSource.indexOf('    setVoiceCommandSpeaker(createPanelNarrator(');
    const speakerEnd = inspectorSource.indexOf("    orb.addEventListener('click'", speakerStart);
    execute(t.context, inspectorSource.slice(speakerStart, speakerEnd));
    install(t.context, 'speakNarration');
    held = network.holdNextTool('voice_acknowledgement');
    held.releaseRequest();
    const oldLine = t.context.experienceView.definition.steps[4].body;
    const previousNarration = t.context.speakNarration(oldLine);
    await synthesisStarted;
    await next();
    expect(t.player.getState().step).toBe(5);
    expect(t.context.binding.sourceToken).not.toBe(before.sourceToken);
    expect(t.context.panelId).toBe(owner);
    // The first validation passed before synthesis. Its second validation now
    // produces the real narration-specific 409, through the HTTP/LAN handlers.
    release(); expect(await held.response).toBe(409); held.releaseResponse();
    await previousNarration; await Promise.allSettled(speech);
    const reason = 'The spoken line belongs to a replaced source. Read get_inspection_state.';
    expect(t.diagnostics.filter(event => event.kind === 'tool-refused')).toEqual([
      expect.objectContaining({ tool: 'voice_acknowledgement', status: 409, reason,
        captioned: false, staleBinding: true, journeyOwned: true }),
    ]);
    expect(controls.captions.join('\n')).not.toContain('get_inspection_state');
    expect(controls.plates.join('\n')).not.toContain('get_inspection_state');
    expect(controls.captions).not.toContain(reason); expect(controls.plates).not.toContain(reason);
    expect(played).not.toContain(narrationLines(oldLine)[0]);
    expect(played.join(' ')).toContain(t.context.experienceView.definition.steps[5].body.replace(/\s+/g, ' ').trim());
    expect((await t.remote('back')).command).toMatchObject({ status: 'rendered', panelId: owner });
    const done = await t.remote('done');
    expect(done.experienceCompletion).toMatchObject({ status: 'rendered', savedRevision: done.inspectionRevision });
    expect(t.context.workspace.capture()).toEqual(t.originalScene);
    expect((await t.colour(owner)).command).toMatchObject({ status: 'rendered', panelId: owner });
    await Promise.allSettled(speech);
    expect(t.diagnostics.filter(event => event.kind === 'tool-refused' && event.captioned)).toEqual([]);
    expect(controls.captions.join('\n')).not.toContain('get_inspection_state');
    expect(controls.plates.join('\n')).not.toContain('get_inspection_state');
  } finally {
    release(); held?.releaseRequest(); held?.releaseResponse(); await Promise.allSettled(speech);
    await controls?.close(); await t?.close(); network.close(); transport.lan = false; sources.binder = false;
    vi.unstubAllGlobals(); forgetCompanionPageKey();
  }
});

for (const sourceChange of [true, false]) for (const action of ['next', 'done']) for (const failure of ['attach', 'acknowledge']) {
  it(`menu ${action} restores the exact pre-step source after its own save and failed ${failure} (source change ${sourceChange})`, async () => {
    sources.swap = sourceChange;
    const t = await setup(false, true), controls = menu(t.player);
    try {
      await controls.press('tours'); await controls.press('tour'); await controls.press('tour');
      const before = await t.read(), oldPanel = t.context.panelId;
      const dispatch = t.context.companionCall;
      const failedTool = failure === 'attach' ? 'attach_inspection' : 'acknowledge_experience_step';
      let fail = true, saved = false, rollbackAccepted = false;
      t.context.companionCall = async (name: string, args: any) => {
        expect(args.tourCommand).toBeUndefined();
        if (fail && name === failedTool) {
          fail = false;
          expect(saved, 'the journey saved successfully before the injected failure').toBe(true);
          const prepared = await t.read();
          expect(prepared.inspectionRevision).toBeGreaterThan(0);
          if (sourceChange || action === 'done') expect(prepared.sourceToken).not.toBe(before.sourceToken);
          throw Error(`Menu ${failure} failed`);
        }
        const result = await dispatch(name, args);
        if (name === 'sync_inspection' && fail) saved = result.structuredContent?.saved === true;
        if (name === 'navigate_experience' && args.rollbackToken) rollbackAccepted = result.structuredContent?.experienceTransition?.restored === true;
        return result;
      };
      t.context.pollDuringSave = true;
      await expect(controls.press(action)).rejects.toThrow(`Journey could not render: Menu ${failure} failed. Previous view restored.`);
      expect(rollbackAccepted).toBe(true);
      const restored = await t.read(), state = await t.state();
      expect(restored.structureText).toBe(before.structureText);
      expect(restored.scene).toEqual(before.scene);
      expect(restored.experience).toEqual(before.experience);
      expect(t.context.workspace.capture()).toEqual(before.scene);
      expect(t.context.panelId).not.toBe(oldPanel);
      expect(state.panels.find((p: any) => p.panelId === t.context.panelId)).toMatchObject({ current: true, availability: 'ready' });
      expect(state.pendingCommand).toHaveLength(0);
      expect(state.companionLoading).toBe(false);
      expect(t.context.liveAvailability()).toBe('ready');
      expect((await t.colour()).command.status).toBe('rendered');
    } finally { sources.swap = false; controls.detach(); await t.close(); }
  });
}

for (const invalid of ['wrong panel', 'wrong token', 'previous journey']) {
  it(`a menu save with a ${invalid} claim cannot commit or advance the rollback revision`, async () => {
    sources.swap = true;
    const t = await setup(false, true), controls = menu(t.player);
    try {
      const dispatch = t.context.companionCall;
      let previousClaim: any;
      t.context.companionCall = async (name: string, args: any) => {
        const result = await dispatch(name, args);
        if (name === 'navigate_experience') previousClaim = { panelId: args.panelId, rollbackToken: result.structuredContent.experienceTransition.rollbackToken };
        return result;
      };
      await controls.press('tours'); await controls.press('tour'); await controls.press('tour');
      const before = await t.read();
      let attempted = false;
      t.context.companionCall = async (name: string, args: any) => {
        if (name === 'sync_inspection' && args.journeySave && !attempted) {
          attempted = true;
          const prepared = await t.read();
          const journeySave = invalid === 'previous journey' ? previousClaim : { ...args.journeySave,
            ...(invalid === 'wrong panel' ? { panelId: randomUUID() } : { rollbackToken: randomUUID() }) };
          await expect(dispatch(name, { ...args, journeySave })).rejects.toThrow('This save does not belong to the current journey transition.');
          const unchanged = await t.read();
          expect(unchanged.scene).toEqual(prepared.scene);
          expect(unchanged.inspectionRevision).toBe(prepared.inspectionRevision);
          throw Error('Invalid journey save refused');
        }
        return dispatch(name, args);
      };
      await expect(controls.press('next')).rejects.toThrow('Previous view restored.');
      expect(attempted).toBe(true);
      expect((await t.read()).scene).toEqual(before.scene);
      expect((await t.colour()).command.status).toBe('rendered');
    } finally { sources.swap = false; controls.detach(); await t.close(); }
  });
}

for(const preResolved of [false,true])it(`native scene hydration saves its initial uncommitted import (pre-resolved ${preResolved})`,async()=>{
  const t=await setup(false,true);
  const folder=await mkdtemp(join(tmpdir(),'stereofold-import-hydration-'));
  try {
    const paths={scenePath:join(folder,'scene.json'),coordinatePath:join(folder,'source.cif'),provenancePath:join(folder,'provenance.json')};
    const scene={version:2,revision:0,
      objects:[{id:'primary',primary:true,visible:true,derived:false,frameCount:1,
        matrix:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],construction:{kind:'model',modelIndex:0},
        constructionOptions:{models:[{index:0,modelNumber:1}],assemblies:[]}}],
      selection:{atomIds:['atom-1'],atomIdsTruncated:false},focus:{atomIds:[],expression:null,summary:null},
      camera:{mode:'perspective',fovDegrees:42,position:[12,8,35],target:[0,0,0],up:[0,1,0]},
      layers:[{id:'primary',visible:true,target:{kind:'all'},labels:false,opacity:1,representation:'cartoon',color:{kind:'uniform',value:'#d85c9d'}}],
      background:'#162638',lighting:'studio',trajectory:null,namedSelections:{}};
    const json=JSON.stringify(scene),hash=(value:string)=>createHash('sha256').update(value).digest('hex');
    await writeFile(paths.scenePath,json);await writeFile(paths.coordinatePath,crn);
    await writeFile(paths.provenancePath,JSON.stringify({version:1,kind:'structure-viewer-local-snapshot',
      sceneSha256:hash(json),expectedRevision:0,sourceObjectId:'primary',coordinate:{format:'selection-mmcif',sha256:hash(crn),
        coordinateProvenance:{identityPreserving:true,generatedAtomIdentifierCount:0,generatedModelCount:0,namespacedAtomIdentifierCount:0,remappedModelCount:0}}}));
    const opened=await t.call('inspect_scene',paths),sessionId=opened.structuredContent.sessionId;
    const read=async()=>(await t.call('get_inspection',{sessionId}))._meta[KEY];
    const data=await read(),catalog=await decodeInspectionCatalog(data.catalogWire??data.catalog);
    expect(data.scene).toBeNull();expect(data.inspectionRevision).toBe(0);
    const target={sourceSha256:catalog.source.sha256,modelNumber:1,assemblyId:catalog.assemblyId,
      molecularCenterAngstrom:[0,0,0],molecularRadiusAngstrom:10,cameraBaseline:t.originalScene.camera,
      atomIdToSelectionKey:{'atom-1':catalog.rows[0].key}};
    Object.assign(t.context,{binding:bound(data),panelId:undefined,savedScene:undefined,isCompanion:false,
      console:{warn(){},debug(){}},readStructureHeading});
    t.context.workspace.viewer.inspection.captureStructureViewerImportTarget=()=>target;
    const calls:string[]=[];
    t.context.companionCall=async(name:string,args:any)=>{calls.push(name);return JSON.parse(JSON.stringify(await t.call(name,args)));};
    if(preResolved) {
      expect((await t.call('resolve_scene_import',{...t.context.expected(),target})).structuredContent.imported).toBe(true);
      const candidate=await read();
      expect(candidate.scene).toBeNull();expect(candidate.inspectionRevision).toBe(0);
      expect(candidate.sceneImport.resolvedScene).toBeTruthy();
    }
    await t.context.hydrate(sessionId);
    const saved=await read();
    expect(calls.filter(name=>name==='resolve_scene_import')).toHaveLength(preResolved?0:1);
    expect(calls.filter(name=>name==='sync_inspection')).toHaveLength(1);
    expect(saved.inspectionRevision).toBe(1);
    expect(saved.sceneImport).toBeUndefined();
    expect(saved.scene).toEqual(t.context.workspace.capture());
    expect(saved.scene.selectionKeys).toEqual([catalog.rows[0].key]);
    expect(saved.scene.inspection.appearance).toMatchObject({color:'uniform',uniformColor:'#D85C9D',background:'#162638'});
    expect(saved.scene.camera.position).toEqual(scene.camera.position);
    const state=(await t.call('get_inspection_state',{sessionId})).structuredContent;
    expect(state.panels).toContainEqual(expect.objectContaining({panelId:t.context.panelId,surface:'desktop',current:true,availability:'ready'}));
    // Once committed, restoring that identical source becomes a passive read.
    await t.context.hydrate(sessionId);
    expect(calls.filter(name=>name==='sync_inspection')).toHaveLength(1);
    expect((await read()).inspectionRevision).toBe(1);
  } finally {await t.close();await rm(folder,{recursive:true,force:true});}
});

/** A second renderer of the same host, with only its GPU/DOM adapted. */
async function savedJourneyFollower(t: Awaited<ReturnType<typeof setup>>) {
  const current=await t.read();
  let scene=structuredClone(current.scene);
  scene.camera.radius+=1; // A different local preview forces the real restore path.
  const calls:string[]=[];
  const follower=journeyNavigationHarness({...t.context,
    binding:bound(current),savedScene:structuredClone(scene),isCompanion:false,
    generation:0,loading:false,dirty:false,blocked:false,experiencePreparing:false,
    experienceView:t.context.experienceView,experiencePlayer:undefined,panelTour:undefined,tourPlayer:undefined,
    saving:Promise.resolve(),attaching:undefined,timer:undefined,rendering:Promise.resolve(),
    console:{warn(){},debug(){}},readStructureHeading,
    companionCall:async(name:string,args:any)=>{
      calls.push(name);
      return JSON.parse(JSON.stringify(await t.call(name,args)));
    },
    workspace:{...t.context.workspace,
      capture:()=>scene,
      snapshot:()=>({...t.context.workspace.snapshot(),sourceSha256:scene.sourceSha256,
        modelNumber:scene.modelNumber,assemblyId:scene.assemblyId,xrPresenting:false}),
      restore:async(saved:any)=>{scene=structuredClone(saved);scene.camera.radius+=.125;},
      loadSource:async(source:any,options:any)=>{scene=options.scene?structuredClone(options.scene)
        :{...scene,sourceSha256:source.sha256,assemblyId:source.catalog.assemblyId,selectionKeys:[]};},
      viewer:{xr:{refreshToolbar:async()=>{}},inspection:{configure:async(appearance:any)=>{
        scene={...scene,inspection:{...scene.inspection,appearance:{...scene.inspection.appearance,...appearance}}};
      }},select:async(keys:string[])=>{scene={...scene,selectionKeys:keys};}},
    },
  });
  for(const name of ['call','hydrate','scheduleSave','save','recoverSave','attach','detach','poll','busyBeat','beatSuspended'])install(follower,name);
  follower.panelId=(await t.call('attach_inspection',{...follower.expected(),surface:'desktop'})).structuredContent.panelId;
  return {follower,calls,edit:()=>{scene.selectionKeys=[];scene.inspection.appearance={...scene.inspection.appearance,color:'uniform',uniformColor:'#12ab34'};},
    close:()=>clearTimeout(follower.timer)};
}

it('a passive follower restore cannot supersede Back, but its later actual edit still saves',async()=>{
  const t=await setup(true,true);
  let f:Awaited<ReturnType<typeof savedJourneyFollower>>|undefined;
  let releaseRestore!:()=>void,releaseOwner!:()=>void;
  try {
    await t.remote('start');await t.remote('next');
    f=await savedJourneyFollower(t);
    const before=await t.read();
    let enteredRestore!:()=>void,prepared!:()=>void;
    const restoring=new Promise<void>(resolve=>{enteredRestore=resolve;});
    const preparedBack=new Promise<void>(resolve=>{prepared=resolve;});
    const restoreGate=new Promise<void>(resolve=>{releaseRestore=resolve;});
    const ownerGate=new Promise<void>(resolve=>{releaseOwner=resolve;});
    const restore=f.follower.workspace.restore;
    f.follower.workspace.restore=async(...args:any[])=>{enteredRestore();await restoreGate;await restore(...args);};
    const following=f.follower.hydrate(before.sessionId);
    await restoring;
    const dispatch=t.context.companionCall;
    t.context.companionCall=async(name:string,args:any)=>{
      const result=await dispatch(name,args);
      if(name==='navigate_experience' && !args.rollbackToken){prepared();await ownerGate;}
      return result;
    };
    const back=t.context.navigateExperience(experienceId,0);
    await preparedBack;
    expect((await t.read()).journeyTransition.panelId).toBe(t.context.panelId);
    releaseRestore();await following;
    expect(f.calls).not.toContain('sync_inspection');
    expect(f.calls).not.toContain('acknowledge_experience_step');
    expect(f.follower.savedScene).toEqual(f.follower.workspace.capture());
    expect(f.follower.savedScene.camera.radius).toBe(before.scene.camera.radius+.125);
    expect(f.follower.savedScene.selectionKeys).toEqual(before.scene.selectionKeys);
    expect(f.follower.savedScene.inspection).toEqual(before.scene.inspection);
    expect((await t.read()).scene).toEqual(before.scene);
    expect((await t.read()).inspectionRevision).toBe(before.inspectionRevision);
    releaseOwner();await back;
    expect((await t.read()).experience).toMatchObject({stepIndex:0,applied:true});
    await f.follower.hydrate(before.sessionId);
    expect(f.calls).not.toContain('sync_inspection');
    f.edit();f.follower.scheduleSave();await f.follower.save();
    expect(f.calls.filter(name=>name==='sync_inspection')).toHaveLength(1);
    expect((await t.read()).scene).toEqual(f.follower.workspace.capture());
    expect((await t.read()).scene.inspection.appearance.uniformColor).toBe('#12ab34');
  } finally {releaseRestore?.();releaseOwner?.();f?.close();await t.close();}
});

it('an authoritative pending journey read defers a follower before stopping, detaching or drawing',async()=>{
  const t=await setup(true,true);
  let f:Awaited<ReturnType<typeof savedJourneyFollower>>|undefined,releaseOwner!:()=>void;
  try {
    await t.remote('start');await t.remote('next');
    f=await savedJourneyFollower(t);
    const saved=structuredClone(f.follower.workspace.capture()),panel=f.follower.panelId;
    const stop=vi.fn(),restore=vi.fn(f.follower.workspace.restore);
    f.follower.tourPlayer={stop};f.follower.workspace.restore=restore;
    let prepared!:()=>void;
    const preparedBack=new Promise<void>(resolve=>{prepared=resolve;});
    const ownerGate=new Promise<void>(resolve=>{releaseOwner=resolve;});
    const dispatch=t.context.companionCall;
    t.context.companionCall=async(name:string,args:any)=>{
      const result=await dispatch(name,args);
      if(name==='navigate_experience' && !args.rollbackToken){prepared();await ownerGate;}
      return result;
    };
    const back=t.context.navigateExperience(experienceId,0);
    await preparedBack;
    await f.follower.hydrate(t.context.binding.sessionId);
    expect(f.calls).toEqual(['get_inspection']);
    expect(stop).not.toHaveBeenCalled();expect(restore).not.toHaveBeenCalled();
    expect(f.follower.panelId).toBe(panel);
    expect(f.follower.workspace.capture()).toEqual(saved);
    expect(f.follower.loading).toBe(false);
    releaseOwner();await back;
    expect((await t.read()).experience).toMatchObject({stepIndex:0,applied:true});
  } finally {releaseOwner?.();f?.close();await t.close();}
});

for (const competing of ['before journey save', 'after journey save']) {
  it(`another source saves ${competing} and still prevents the menu rollback`, async () => {
    sources.swap = true;
    const t = await setup(false, true), controls = menu(t.player);
    try {
      await controls.press('tours'); await controls.press('tour'); await controls.press('tour');
      const dispatch = t.context.companionCall;
      let otherScene: any, otherSource: string | undefined, attempted = false;
      t.context.companionCall = async (name: string, args: any) => {
        if (name === 'sync_inspection' && args.journeySave && !attempted) {
          attempted = true;
          if (competing === 'after journey save') expect((await dispatch(name, args)).structuredContent.saved).toBe(true);
          const current = await t.read();
          otherSource = current.sourceToken;
          otherScene = structuredClone(args.scene);
          otherScene.inspection.appearance = { ...otherScene.inspection.appearance, color: 'uniform', uniformColor: '#00ff00' };
          const saved = await dispatch(name, { ...args, journeySave: undefined, baseInspectionRevision: current.inspectionRevision, scene: otherScene });
          expect(saved.structuredContent.saved).toBe(true);
          // Even a fresh binding cannot turn another source's revision into
          // the original journey's save. The original token is insufficient.
          await expect(dispatch(name, { ...args, baseInspectionRevision: saved.structuredContent.inspectionRevision }))
            .rejects.toThrow('This save does not belong to the current journey transition.');
          throw Error('Competing save interrupted the chapter');
        }
        return dispatch(name, args);
      };
      await expect(controls.press('next')).rejects.toThrow('A newer scene or request superseded this journey; its previous source cannot be restored.');
      expect(attempted).toBe(true);
      const retained = await t.read();
      expect(retained.sourceToken).toBe(otherSource);
      expect(retained.scene).toEqual(otherScene);
      expect(retained.journeyTransition.status).toBe('superseded');
      const follower=await savedJourneyFollower(t);
      try {
        await follower.follower.hydrate(retained.sessionId);
        expect(follower.calls).not.toContain('sync_inspection');
        expect(follower.calls).not.toContain('acknowledge_experience_step');
        expect(follower.follower.workspace.capture().inspection).toEqual(otherScene.inspection);
        expect(follower.follower.workspace.capture().selectionKeys).toEqual(otherScene.selectionKeys);
        expect((await t.read()).scene).toEqual(otherScene);
      } finally {follower.close();}
    } finally { sources.swap = false; controls.detach(); await t.close(); }
  });
}

it('a newer pending command prevents the menu rollback after its own save', async () => {
  sources.swap = true;
  const t = await setup(false, true), controls = menu(t.player);
  try {
    await controls.press('tours'); await controls.press('tour'); await controls.press('tour');
    const dispatch = t.context.companionCall;
    let claimedSave: any, retainedSource: string | undefined;
    t.context.companionCall = async (name: string, args: any) => {
      if (name === 'sync_inspection' && args.journeySave) claimedSave = args;
      if (name === 'acknowledge_experience_step') {
        expect(claimedSave).toBeTruthy();
        retainedSource = (await t.read()).sourceToken;
        await t.call('update_inspection', { ...t.context.expected(), panelId: t.context.panelId, commandId: 'd47-newer-colour',
          change: { kind: 'appearance', patch: { color: 'uniform', uniformColor: '#00ff00' } } });
        await expect(dispatch('sync_inspection', { ...claimedSave, ...t.context.expected() }))
          .rejects.toThrow('This save does not belong to the current journey transition.');
        throw Error('A newer command interrupted acknowledgement');
      }
      return dispatch(name, args);
    };
    await expect(controls.press('next')).rejects.toThrow('A newer scene or request superseded this journey; its previous source cannot be restored.');
    expect((await t.read()).sourceToken).toBe(retainedSource);
    expect((await t.state('d47-newer-colour')).command.status).toBe('queued');
  } finally { sources.swap = false; controls.detach(); await t.close(); }
});

for (const start of ['model', 'menu']) {
  it(`live page saves and retains its panel through Next and Done (${start} start)`, async () => {
    sources.swap = true;
    const t = await setup(false, true);
    try {
      const panels = [t.context.panelId];
      if (start === 'menu') { await t.player.openMenu(); await t.player.start(); }
      else expect((await t.remote('start')).command.status).toBe('rendered');
      t.player.pause(); panels.push(t.context.panelId);
      const journeySource = t.context.binding.sourceToken;
      if (start === 'menu') t.context.pollDuringSave = true;
      for (let i = 0; i < (start === 'model' ? 2 : 4); i++) {
        const next = await t.remote('next');
        expect(next.command.status, JSON.stringify(next.command)).toBe('rendered');
        panels.push(t.context.panelId);
        if (i === 0) expect(t.context.binding.sourceToken).not.toBe(journeySource);
      }
      t.context.pollDuringSave = true;
      const done = await t.remote('done');
      expect(done.command.status, JSON.stringify(done.command)).toBe('rendered');
      panels.push(t.context.panelId);
      expect(new Set(panels).size).toBe(1);
      expect((await t.read()).scene).toEqual(t.context.workspace.capture());
      expect(t.context.workspace.capture()).toEqual(t.originalScene);
      expect(t.context.liveAvailability()).toBe('ready');
      expect((await t.colour()).command.status).toBe('rendered');
    } finally { sources.swap = false; await t.close(); }
  });
}

it('a rendered tour load followed by a failed fit reports the journey failure once with a single period', async () => {
  const t = await setup(false, true);
  try {
    const configure = t.context.workspace.viewer.inspection.configure;
    let once = true;
    t.context.workspace.viewer.inspection.configure = async (...args: any[]) => {
      if (once) { once = false; throw Error('This change needs too much travel to clear the menu. Press Reset or Fit, then try again.'); }
      return configure(...args);
    };
    const result = await t.remote('start');
    expect(result.command.status).toBe('rejected');
    expect(result.command.detail).toBe('Journey could not render: This change needs too much travel to clear the menu. Press Reset or Fit, then try again. Previous view restored.');
    expect(t.events).toContain('drawn');
    expect(t.events.some((event: string) => event.startsWith('Structure load failed'))).toBe(false);
    expect(t.diagnostics).toContainEqual(expect.objectContaining({ kind: 'page-error', operation: 'view' }));
    expect(t.context.workspace.capture()).toEqual(t.originalScene);
  } finally { await t.close(); }
});

for (const action of ['done', 'next']) for (const failure of ['draw', 'save', 'attach', 'acknowledge']) {
  it(`live ${action} rolls back a failed ${failure}, rejects, and accepts colour on the saved current panel`, async () => {
    const t = await setup(false, true);
    try {
      await t.remote('start'); t.player.pause(); await t.remote('next'); await t.remote('next');
      t.context.pollDuringSave = true;
      if (failure === 'draw') {
        if (action === 'done') t.failDraw();
        else {
          const configure = t.context.workspace.viewer.inspection.configure;
          let once = true;
          t.context.workspace.viewer.inspection.configure = async (...args: any[]) => {
            if (once) { once = false; throw Error('Chapter draw failed'); }
            return configure(...args);
          };
        }
      }
      else {
        const dispatch = t.context.companionCall;
        const tool = { save: 'sync_inspection', attach: 'attach_inspection', acknowledge: 'acknowledge_experience_step' }[failure];
        let once = true;
        t.context.companionCall = async (name: string, args: any) => {
          if (once && name === tool) { once = false; throw Error(`Done ${failure} failed`); }
          return dispatch(name, args);
        };
      }
      const result = await t.remote(action);
      expect(result.command.status, JSON.stringify(result.command)).toBe('rejected');
      expect(result.command.detail).toContain('Previous view restored.');
      expect(result.command.renderedAt).toBeUndefined();
      expect(result.pendingCommand).toHaveLength(0);
      expect(result.panels.find((p: any) => p.panelId === t.context.panelId)).toMatchObject({ current: true, availability: 'ready' });
      expect(t.context.liveAvailability()).toBe('ready');
      expect((await t.read()).scene).toEqual(t.context.workspace.capture());
      expect((await t.colour()).command.status).toBe('rendered');
    } finally { await t.close(); }
  });
}

it('Done rejects at the existing draw deadline and restores a saved ready panel', async () => {
  const t = await setup(false, true);
  try {
    await t.remote('start'); t.player.pause(); await t.remote('next'); await t.remote('next');
    const deadlines: { run: () => void; ms: number }[] = [];
    t.context.beginSourceSwapTrace = () => createSourceSwapTrace({ presenting: () => true,
      defer: (run, ms) => { deadlines.push({ run, ms }); }, record() {} });
    t.holdDraw(new Promise(() => {}));
    const pending = t.remote('done');
    await Promise.race([t.restoreStarted, pending.then(() => { throw Error('Done finished before restoring its frame'); })]);
    expect(t.events).toContain('restore-draw-pending');
    expect((await t.state('d38-done-3')).command.status).toBe('rendering');
    expect(deadlines.at(-1)?.ms).toBeLessThanOrEqual(SWAP_PHASE_TIMEOUT_MS);
    // Hold only the failed draw; the exact rollback must render normally.
    t.holdDraw(Promise.resolve());
    deadlines.at(-1)!.run();
    const result = await pending;
    expect(result.command.status, JSON.stringify(result.command)).toBe('rejected');
    expect(result.command.detail).toContain('built step did not finish within 45 seconds');
    expect(result.command.detail).toContain('Previous view restored.');
    expect(result.command.renderedAt).toBeUndefined();
    expect(result.pendingCommand).toHaveLength(0);
    expect(t.context.liveAvailability()).toBe('ready');
    expect((await t.read()).scene).toEqual(t.context.workspace.capture());
    expect((await t.colour()).command.status).toBe('rendered');
  } finally { await t.close(); }
});

it('exact rollback hydration restores saved placement on a reused XR source', async () => {
  const t = await setup(true, true);
  try {
    await t.remote('start'); t.player.pause();
    const saved = await t.read(), retained = structuredClone(saved.scene);
    t.context.workspace.capture().inspection.placement.scale *= 0.75;
    const restore = t.context.workspace.restore, xrRecoveryFrame = Object.freeze({});
    let restored = false;
    t.context.workspace.restore = async (scene: any, options: any) => {
      expect(options).toMatchObject({ preserveCamera: true, restorePlacement: true, preservePreviewCamera: true });
      expect(options.xrRecoveryFrame).toBe(xrRecoveryFrame);
      await restore(scene, options); restored = true;
    };
    await t.context.hydrate(saved.sessionId, { _meta: { [KEY]: saved } }, undefined, { restoreExactScene: true, xrRecoveryFrame });
    expect(restored).toBe(true);
    expect((await t.read()).scene).toEqual(retained);
    // camera.scale is absent from saved JSON: exact rollback must execute
    // even when serialized scene state already compares equal.
    restored = false;
    const current = await t.read();
    await t.context.hydrate(current.sessionId, { _meta: { [KEY]: current } }, undefined, { restoreExactScene: true, xrRecoveryFrame });
    expect(restored).toBe(true);
  } finally { await t.close(); }
});

it('a placement deadline cancels its renderer and clears the stale disconnect notice after rollback attaches', async () => {
  const t = await setup(false, true);
  try {
    await t.remote('start'); t.player.pause(); await t.remote('next');
    const deadlines: { run: () => void; ms: number }[] = [];
    t.context.beginSourceSwapTrace = () => createSourceSwapTrace({ presenting: () => true,
      defer: (run, ms) => { deadlines.push({ run, ms }); }, record() {} });
    let began!: () => void, cancelled = false;
    const retainedScene = structuredClone(t.context.workspace.capture());
    const xrRecoveryFrame = Object.freeze({});
    t.context.workspace.viewer.inspection.captureXrRecoveryFrame = () => xrRecoveryFrame;
    const rollbackDraws: string[] = [];
    for (const method of ['restore', 'loadSource']) {
      const original = t.context.workspace[method];
      t.context.workspace[method] = async (value: any, options: any = {}) => {
        await original(value, options);
        if (!cancelled) return;
        rollbackDraws.push(method);
        expect(options.xrRecoveryFrame).toBe(xrRecoveryFrame);
        // Model the real XR anchor path: absent exact restoration, a reload
        // keeps its candidate-derived size instead of the saved placement.
        if (!options.restorePlacement) t.context.workspace.capture().inspection.placement.scale *= 0.75;
        if (method === 'restore') expect(options.preservePreviewCamera).toBe(true);
      };
    }
    const started = new Promise<void>(resolve => { began = resolve; });
    const originalConfigure = t.context.workspace.viewer.inspection.configure;
    t.context.workspace.viewer.inspection.configure = (_patch: any, options: any) => {
      t.context.workspace.viewer.inspection.configure = originalConfigure;
      began();
      return new Promise((_, reject) => options.signal.addEventListener('abort', () => {
        cancelled = true; reject(options.signal.reason);
      }, { once: true }));
    };
    Object.assign(t.context, { connectionRecoveryLine: 'Disconnected', connectionTroubleSince: 1,
      repairNeeded: false, connectionWatchdog: undefined, setConnectionStatus() {}, pairAgain: {} });
    install(t.context, 'clearConnectionProblem');
    const attach = t.context.attach;
    t.context.attach = async (...args: any[]) => {
      await attach(...args);
      t.context.connectionNotice = true; t.context.notice.hidden = false;
    };
    const pending = t.remote('back');
    await Promise.race([started, pending.then(() => { throw Error('Back finished before its placement'); })]);
    await Promise.resolve();
    deadlines.at(-1)!.run();
    const result = await pending;
    expect(cancelled).toBe(true);
    expect(rollbackDraws.length).toBeGreaterThan(0);
    expect((await t.read()).scene).toEqual(retainedScene);
    expect(result.command.status).toBe('rejected');
    expect(result.command.detail).toContain('Previous view restored.');
    expect(t.context.connectionNotice).toBe(false);
    expect(t.context.notice.hidden).toBe(true);
    expect(t.context.connectionRecoveryLine).toBe('');
    expect(t.context.liveAvailability()).toBe('ready');
    expect((await t.colour()).command.status).toBe('rendered');
  } finally { await t.close(); }
});
for (const sameSource of [false, true]) for (const start of ['menu', 'model']) {
  it(`Done restores and confirms through the companion dispatcher (${start} start, same source ${sameSource})`, async () => {
    const t = await setup(sameSource);
    try {
      if (start === 'menu') { await t.player.openMenu(); await t.player.start(); }
      else { const started = await t.remote('start'); expect(started.command.status, JSON.stringify(started.command)).toBe('rendered'); }
      t.player.pause();
      await t.remote('next'); await t.remote('back');
      const result = await t.remote('done');
      expect(result.command.status, JSON.stringify(result.command)).toBe('rendered');
      expect(result.command.renderedAt).toEqual(expect.any(Number));
      expect((await t.read()).scene).toEqual(t.originalScene);
      expect(result.pendingCommand).toHaveLength(0);
      expect(t.context.liveAvailability()).toBe('ready');
      expect(t.player.getState().active).toBe(false);
    } finally { await t.close(); }
  });
}
/**
 * After Done
 * the molecule filled the wearer's view across the menu and the caption.
 *
 * Two questions the states could not answer, because the published `view`
 * carried a placement and no pose at all: what framing the journey saved before
 * it started, and what framing Done put back. Both are answered here against
 * the real host, and the panel's end of it is the call the viewer's journey
 * ending hangs off.
 */
it('Done publishes and restores the exact pre-journey pose and placement, and re-seats the panel', async () => {
  const t = await setup(false);
  const seats: unknown[] = [];
  try {
    t.context.workspace.viewer.inspection.restoreJourneySeat = async (options: unknown) => { seats.push(options); };
    const opening = await t.state();
    expect(opening.view.cameraPose).toEqual(cameraPose(t.originalScene.camera));
    expect(opening.view.placement).toEqual(t.originalScene.inspection.placement);

    await t.remote('start'); t.player.pause(); await t.remote('next');
    const chapter = await t.state();
    expect(chapter.view.cameraPose).toEqual(opening.view.cameraPose);

    const done = await t.remote('done');
    expect(done.command.status, JSON.stringify(done.command)).toBe('rendered');
    // The framing the wearer had before the journey, both halves of it.
    expect(done.view.cameraPose).toEqual(cameraPose(t.originalScene.camera));
    expect(done.view.placement).toEqual(t.originalScene.inspection.placement);
    expect((await t.read()).scene).toEqual(t.originalScene);
    // And the panel was told to end the journey the way a lesson tour ends:
    // once, handed the restored view so the renderer can judge its pose.
    expect(seats).toHaveLength(1);
    expect((seats[0] as { scene: typeof t.originalScene }).scene).toEqual(t.originalScene);
  } finally { await t.close(); }
});

for (const action of ['menu', 'model']) for (const placementRestored of [true, false]) {
  it(`${action} Done captions the rendered placement outcome (exact ${placementRestored})`, async () => {
    const t = await setup(true);
    let release!: () => void;
    const draw = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const controls = await toolbarMenu(t);
    const sentence = placementRestored ? 'Restored your pre-tour view.' : 'Restored your view and adjusted it to clear the menu.';
    const savedPlacement = { translation: [-.7552, 0, -3.8], rotation: [0, 0, 0], scale: 1.0180534 };
    try {
      t.context.workspace.capture().inspection.placement = structuredClone(savedPlacement);
      t.context.scheduleSave(); await t.context.save();
      await t.player.openMenu(); await t.player.start(); t.player.pause();
      for (const scale of [.4543570, .4172]) {
        await t.remote('next');
        t.context.workspace.capture().inspection.placement = { ...savedPlacement, scale };
      }
      t.context.workspace.viewer.inspection.restoreJourneySeat = async ({ scene }: any) => {
        expect(scene.inspection.placement).toEqual(savedPlacement);
        expect(t.context.workspace.capture().inspection.placement).toEqual(savedPlacement);
        started(); await draw;
        if (!placementRestored) t.context.workspace.capture().inspection.placement.translation[0] += .1;
        return { placementRestored, fitted: false };
      };
      const done = action === 'menu' ? controls.press('done') : t.remote('done');
      await entered;
      expect(controls.plates).not.toContain(sentence);
      expect((await t.read()).experienceCompletion.status).toBe('pending');
      release(); await done;
      expect(t.player.getState()).toMatchObject({ active: false, feedback: sentence, feedbackError: false });
      expect(controls.plates).toContain(sentence);
      expect((await t.read()).experienceCompletion.status).toBe('rendered');
      expect((await t.read()).scene.inspection.placement).toEqual({ ...savedPlacement,
        translation: [savedPlacement.translation[0] + (placementRestored ? 0 : .1), 0, -3.8] });
      if (!placementRestored) expect(controls.plates).not.toContain('Restored your pre-tour view.');
    } finally { release(); await controls.close(); await t.close(); }
  });
}

it('a failed model Done restores the journey and rejects the claim before the next command', async () => {
  const t = await setup(false);
  try {
    await t.remote('start'); t.player.pause(); t.failDraw();
    const failed = await t.remote('done');
    expect(failed.command).toMatchObject({ status: 'rejected', detail: 'Journey could not render: Restore draw failed. Previous view restored.' });
    expect(failed.command.renderedAt).toBeUndefined();
    expect(failed.pendingCommand).toHaveLength(0);
    expect(t.context.liveAvailability()).toBe('ready');
    expect(t.player.getState().active).toBe(true);
    expect((await t.remote('done')).command.status).toBe('rendered');
  } finally { await t.close(); }
});

it('a model journey after a menu Done restores the new pre-tour view', async () => {
  const t = await setup(true);
  try {
    await t.player.openMenu(); await t.player.start(); await t.player.finish();
    expect(t.player.getState().active).toBe(false);
    expect((await t.remote('start')).command.status).toBe('rendered'); t.player.pause();
    for (let i = 0; i < 4; i++) await t.player.next();
    const result = await t.remote('done');
    expect(result.command.status, JSON.stringify(result.command)).toBe('rendered');
    expect(t.context.liveAvailability()).toBe('ready');
  } finally { await t.close(); }
});

it('a lost Done acknowledgement uses the immutable tour claim and never posts an ordinary old-source receipt', async () => {
  const t = await setup(false);
  try {
    await t.remote('start'); t.player.pause();
    const hydrate = t.context.hydrate;
    t.context.hydrate = async (...args: any[]) => {
      const receipt = await hydrate(...args);
      // The host has confirmed the restored frame; a late callback loses the
      // page's receipt slot before receive resumes. Retain the exact host claim.
      if (receipt?.status === 'rendered') t.context.tourCommandReceipt = undefined;
      return receipt;
    };
    const result = await t.remote('done');
    expect(result.command.status).toBe('rendered');
    expect(t.context.liveAvailability()).toBe('ready');
    expect(t.context.pendingReceipt).toBeUndefined();
    expect((await t.read()).scene).toEqual(t.originalScene);
  } finally { await t.close(); }
});

it('Done stays rendering until the restored frame saves and acknowledges', async () => {
  const t = await setup(false);
  let release!: () => void;
  try {
    await t.remote('start'); t.player.pause();
    t.holdDraw(new Promise<void>(resolve => { release = resolve; }));
    const pending = t.remote('done');
    await Promise.race([t.restoreStarted, pending.then(() => { throw Error('Done finished before restoring its frame'); })]);
    expect(t.events).toContain('restore-draw-pending');
    const waiting = await t.state('d38-done-1');
    expect(waiting.command.status).toBe('rendering');
    expect(waiting.command.renderedAt).toBeUndefined();
    expect(t.events).not.toContain('Back to your view');
    release();
    expect((await pending).command.status).toBe('rendered');
    expect(t.events).toContain('Back to your view');
  } finally { release?.(); await t.close(); }
});

it('an unacknowledged Done rolls back, rejects and leaves the replacement panel ready', async () => {
  const t = await setup(false);
  try {
    await t.remote('start'); t.player.pause();
    const dispatch = t.context.companionCall; let fail = true;
    t.context.companionCall = async (name: string, args: any) => {
      if (name === 'acknowledge_experience_step' && args.completionToken && fail) {
        fail = false; throw Error('Done acknowledgement transport failed');
      }
      return dispatch(name, args);
    };
    const result = await t.remote('done');
    expect(result.command.status).toBe('rejected');
    expect(result.command.renderedAt).toBeUndefined();
    expect(result.command.detail).toContain('Previous view restored.');
    expect(result.pendingCommand).toHaveLength(0);
    expect(t.context.liveAvailability()).toBe('ready');
    expect(result.panels.find((p: any) => p.panelId === t.context.panelId)).toMatchObject({ current: true, availability: 'ready' });
    expect(t.player.getState().active).toBe(true);
    expect((await t.remote('done')).command.status).toBe('rendered');
  } finally { await t.close(); }
});

it('a completion flag without a host command receipt cannot manufacture rendered success', async () => {
  const t = await setup(false);
  try {
    await t.remote('start'); t.player.pause();
    const dispatch = t.context.companionCall;
    t.context.companionCall = async (name: string, args: any) => {
      if (name === 'acknowledge_experience_step' && args.completionToken) {
        // A malformed transport response carries completion metadata but never
        // invokes the host acknowledgement. The command must remain unrendered.
        return { structuredContent: { experienceAcknowledged: true,
          experienceCompletion: { token: args.completionToken, status: 'rendered' } } };
      }
      return dispatch(name, args);
    };
    const result = await t.remote('done');
    expect(result.command.status).toBe('rejected');
    expect(result.command.renderedAt).toBeUndefined();
    expect(result.pendingCommand).toHaveLength(0);
    expect(t.context.liveAvailability()).toBe('ready');
    expect(t.context.pendingReceipt).toBeUndefined();
  } finally { await t.close(); }
});

for (const sameSource of [false, true]) for (const action of ['model', 'menu']) it(`${action} Done keeps its panel through a source restore and drops old-source narration (same source ${sameSource})`, async () => {
  const t = await setup(sameSource, true);
  let release!: () => void, pending: Promise<any> | undefined;
  try {
    await t.remote('start'); t.player.pause(); await t.remote('next'); await t.remote('next');
    const owner = t.context.panelId, before = { ...t.context.expected(), panelId: owner };
    const dispatch = t.context.companionCall;
    let acknowledged = false, staleHeartbeat: any;
    t.context.companionCall = async (name: string, args: any) => {
      if (name === 'acknowledge_experience_step' && args.completionToken) {
        const saved = await t.state(action === 'model' ? 'd38-done-3' : undefined);
        expect(saved.experienceCompletion).toMatchObject({ status: 'pending', savedRevision: saved.inspectionRevision });
        if (action === 'model') expect(saved.command.status).toBe('rendering');
        expect(t.context.workspace.capture()).toEqual(t.originalScene);
        expect(t.events).not.toContain('Back to your view');
        staleHeartbeat = { ...t.context.expected(), panelId: owner, availability: 'ready', tourState: tourHeartbeat(t.player) };
        acknowledged = true;
      }
      return dispatch(name, args);
    };
    t.holdDraw(new Promise<void>(resolve => { release = resolve; }));
    pending = action === 'model' ? t.remote('done') : t.player.finish();
    await Promise.race([t.restoreStarted, pending.then(() => { throw Error('Done finished before restoring its frame'); })]);
    expect(t.events).toContain('restore-draw-pending');
    // The old fixture drew synchronously, with no narration/heartbeat during
    // source hydration. The real speaker can still hold the chapter binding.
    await t.context.call('voice_acknowledgement', { ...before, message: 'Earlier chapter narration' }).catch(() => {});
    expect(t.events).not.toContain('This action belongs to a different structure.');
    expect(t.diagnostics).toContainEqual(expect.objectContaining({ kind: 'tool-refused', tool: 'voice_acknowledgement', status: 409 }));
    const waiting = await t.state(action === 'model' ? 'd38-done-3' : undefined);
    expect(waiting.experienceCompletion.status).toBe('pending');
    expect(waiting.experienceCompletion.savedRevision).toBeUndefined();
    if (action === 'model') expect(waiting.command.status).toBe('rendering');
    expect(t.context.panelId).toBe(owner);
    await t.context.busyBeat(t.context.generation, true);
    expect(t.events).not.toContain('Back to your view');
    release(); await pending;
    expect(acknowledged).toBe(true);
    // A heartbeat captured before acknowledgement can reach the host last.
    await dispatch('poll_inspection', staleHeartbeat);
    const finished = await t.state(action === 'model' ? 'd38-done-3' : undefined);
    expect(finished.experienceCompletion).toMatchObject({ status: 'rendered', savedRevision: finished.inspectionRevision });
    if (action === 'model') expect(finished.command).toMatchObject({ status: 'rendered', panelId: owner, renderedRevision: finished.inspectionRevision });
    expect(finished.panels).toEqual([expect.objectContaining({ panelId: owner, current: true, availability: 'ready', tour: expect.objectContaining({ active: false }) })]);
    expect(finished.reclaimedPanels).toEqual([]);
    expect(t.context.workspace.capture()).toEqual(t.originalScene);
    expect(t.player.getState().active).toBe(false);
    expect(t.events).toContain('Back to your view');
    // A delayed response can arrive after the journey cleared its pending flag.
    expect(await t.context.call('voice_acknowledgement', { ...before, message: 'Obsolete chapter' }))
      .toMatchObject({ structuredContent: { speechDropped: true } });
    expect(t.events).not.toContain('This action belongs to a different structure.');
    expect((await t.colour()).command.status).toBe('rendered');
  } finally { release?.(); await pending?.catch(() => {}); await t.close(); }
});

for (const mismatch of ['owner', 'token', 'revision']) it(`Done refuses a ${mismatch} mismatch before retaining its panel`, async () => {
  const t = await setup(false, true);
  try {
    await t.remote('start'); t.player.pause();
    const owner = t.context.panelId, dispatch = t.context.companionCall;
    let checked = false;
    t.context.companionCall = async (name: string, args: any) => {
      if (name === 'attach_inspection' && args.journeySave && !checked) {
        checked = true;
        const invalid = { ...args, ...(mismatch === 'owner' ? { replacesPanelId: randomUUID() }
          : mismatch === 'token' ? { journeySave: { ...args.journeySave, rollbackToken: randomUUID() } }
          : { baseInspectionRevision: args.baseInspectionRevision + 1 }) };
        await expect(dispatch(name, invalid)).rejects.toThrow(mismatch === 'revision'
          ? 'The panel must save or load the current inspection before attaching.'
          : 'This attachment does not belong to the current saved journey transition.');
        expect((await t.state()).panels.map((panel: any) => panel.panelId)).toEqual([owner]);
      }
      return dispatch(name, args);
    };
    expect((await t.remote('done')).command).toMatchObject({ status: 'rendered', panelId: owner });
    expect(checked).toBe(true);
  } finally { await t.close(); }
});

it('a model action for another structure remains refused and captioned during a journey', async () => {
  const t = await setup(false, true);
  try {
    t.context.experiencePreparing = true;
    await expect(t.context.call('update_inspection', { ...t.context.expected(), sourceToken: randomUUID() }))
      .rejects.toThrow('This action belongs to a different structure.');
    expect(t.events).toContain('This action belongs to a different structure.');
    expect(t.diagnostics).toContainEqual(expect.objectContaining({ tool: 'update_inspection', captioned: true }));
    expect((await t.read()).scene).toEqual(t.originalScene);
  } finally { await t.close(); }
});

it('a Done owner survives the heartbeat grace only until its original command deadline', async () => {
  let now = 0, release!: () => void, pending: Promise<any> | undefined;
  const t = await setup(false, true, () => now);
  try {
    await t.remote('start'); t.player.pause();
    const owner = t.context.panelId;
    t.holdDraw(new Promise<void>(resolve => { release = resolve; }));
    pending = t.remote('done');
    await Promise.race([t.restoreStarted, pending.then(() => { throw Error('Done finished before restoring its frame'); })]);
    expect(t.events).toContain('restore-draw-pending');
    now = 60_001;
    const held = await t.state('d38-done-1');
    expect(held.panels.map((panel: any) => panel.panelId)).toEqual([owner]);
    expect(held.command.status).toBe('rendering');
    expect(held.experienceCompletion.status).toBe('pending');
    // The claim started at time zero and retains the per-source budget on its
    // original receipt, even while Done restores the smaller starting source.
    expect(held.command.acceptedAt).toBe(0);
    expect(held.command.renderBudgetMs).toBeGreaterThanOrEqual(120_000);
    now = held.command.renderBudgetMs - 1;
    const beforeDeadline = await t.state('d38-done-1');
    expect(beforeDeadline.command.status).toBe('rendering');
    expect(beforeDeadline.panels.map((panel: any) => panel.panelId)).toEqual([owner]);
    now++;
    const expired = await t.state('d38-done-1');
    expect(expired.command).toMatchObject({ status: 'unconfirmed', reason: 'The panel did not confirm this command before its deadline.' });
    expect(expired.command.renderedAt).toBeUndefined();
    expect(expired.panels).toEqual([]);
  } finally { release?.(); await pending?.catch(() => {}); await t.close(); }
});


for (const hostEnded of [true, false]) it(`reconnect adopts the host journey after link loss (ended ${hostEnded})`, async () => {
  const network = inMemoryCompanionNetwork(); transport.lan = true;
  let now = 0, t: Awaited<ReturnType<typeof setup>> | undefined;
  try {
    t = await setup(true, true, () => now, network);
    await t.remote('start'); await t.remote('pause');
    const stale = structuredClone(t.context.experienceView);
    await t.remote('next');
    const hostStep = structuredClone(t.context.experienceView);
    if (hostEnded) await t.remote('done');
    // The response was applied to the scene/host, but the disconnected page
    // retained its player. Replay that residue at the JSON transport boundary.
    t.player.update(stale); t.context.experienceView = hostEnded ? undefined : stale;
    expect(t.player.getState().active).toBe(true);
    now += 61_001; t.context.panelId = undefined;
    await t.context.attach();
    expect(t.player.getState()).toMatchObject(hostEnded
      ? { active: false, step: -1, autoplay: false, navigating: false }
      : { active: true, step: hostStep.stepIndex, selectedId: experienceId, navigating: false });
    const rows = spatialToolbarRows({ tour: t.context.panelTour.getState(), collapsed: false });
    expect(rows.some((row: any) => row.id === 'tours')).toBe(hostEnded);
    expect(rows.some((row: any) => row.id === 'done')).toBe(!hostEnded);
    const state = await t.state();
    if (hostEnded) {
      expect(state.experienceCompletion).toBeUndefined();
      expect(t.context.workspace.capture()).toEqual(t.originalScene);
      expect(t.events).toContain('The lesson ended while the link was down. Back to your view.');
      expect(t.player.getState().feedback).toContain('lesson ended while the link was down');
    } else expect(t.context.experienceView.stepIndex).toBe(hostStep.stepIndex);
  } finally { await t?.close(); network.close(); vi.unstubAllGlobals(); transport.lan = false; }
});

for (const route of ['model', 'menu']) for (const staleView of [false, true])
it(`${route} Done clears a page-only journey (stale view ${staleView})`, async () => {
  const network = inMemoryCompanionNetwork(); transport.lan = true;
  let t: Awaited<ReturnType<typeof setup>> | undefined;
  try {
    t = await setup(true, true, Date.now, network);
    await t.remote('start'); await t.remote('pause'); await t.remote('next');
    const stale = structuredClone(t.context.experienceView);
    await t.remote('done');
    t.player.update(stale); t.context.experienceView = staleView ? stale : undefined;
    if (route === 'model') expect((await t.remote('done')).command.status).toBe('rendered');
    else { const controls = menu(t.context.panelTour); try { await controls.press('done'); } finally { controls.detach(); } }
    expect(t.player.getState()).toMatchObject({ active: false, step: -1, navigating: false });
    expect(t.context.workspace.capture()).toEqual(t.originalScene);
    expect((await t.state()).experienceCompletion).toBeUndefined();
    const rows = spatialToolbarRows({ tour: t.context.panelTour.getState(), collapsed: false });
    expect(rows.some((row: any) => row.id === 'tours')).toBe(true);
    expect(rows.some((row: any) => row.id === 'done')).toBe(false);
    expect(t.events).toContain('The lesson ended while the link was down. Back to your view.');
  } finally { await t?.close(); network.close(); vi.unstubAllGlobals(); transport.lan = false; }
});


for (const route of ['reconnect', 'model', 'menu']) for (const fail of [false, true])
it(`${route} reconciliation waits for the restored draw (failure ${fail})`, async () => {
  const network = inMemoryCompanionNetwork(); transport.lan = true;
  let t: Awaited<ReturnType<typeof setup>> | undefined, release!: () => void, pending: Promise<any> | undefined;
  let now = 0;
  try {
    t = await setup(true, true, () => now, network);
    await t.remote('start'); await t.remote('pause'); await t.remote('next');
    const stale = structuredClone(t.context.experienceView), chapterScene = structuredClone(t.context.workspace.capture());
    await t.remote('done');
    const token = (await t.state()).experienceCompletion.token;
    t.player.update(stale); t.context.experienceView = undefined;
    // Keep a visibly different local chapter so a state-only reset cannot pass.
    await t.context.workspace.restore(chapterScene); t.context.savedScene = chapterScene;
    const draw = t.context.workspace.restoreShared;
    const hold = new Promise<void>(resolve => { release = resolve; });
    let began!: () => void; const started = new Promise<void>(resolve => { began = resolve; });
    t.context.workspace.restoreShared = async (...args: any[]) => {
      expect(args[2]).toBe(true); expect(args[3]).toBe(true);
      began(); await hold;
      if (fail) throw Error('Reconciliation draw failed');
      return draw(...args);
    };
    t.events.length = 0;
    if (route === 'reconnect') { now += 61_001; t.context.panelId = undefined; pending = t.context.attach(); }
    else pending = route === 'model' ? t.remote('done') : t.player.finish();
    const settled = pending!.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    await Promise.race([started, settled.then(() => { throw Error('Reconciliation settled before its draw'); })]);
    expect(t.player.getState().active).toBe(true);
    expect((await t.state()).experienceCompletion.token).toBe(token);
    expect(t.events).not.toContain('acknowledge_experience_step');
    expect(t.events).not.toContain('The lesson ended while the link was down. Back to your view.');
    if (route === 'model') expect((await t.state('d38-done-4')).command.status).toBe('rendering');
    release(); const result = await settled;
    if (fail) {
      if (route === 'model') expect(result.value.command).toMatchObject({ status: 'rejected', reason: 'render_failed', detail: 'Reconciliation draw failed' });
      else expect(result.error?.message).toBe('Reconciliation draw failed');
      expect(t.player.getState().active).toBe(true);
      expect((await t.state()).experienceCompletion.token).toBe(token);
    } else {
      expect(result.error).toBeUndefined();
      expect(t.context.workspace.capture()).toEqual(t.originalScene);
      expect(t.player.getState().active).toBe(false);
      expect((await t.state()).experienceCompletion).toBeUndefined();
      const late = { ...t.context.expected(), panelId: t.context.panelId, availability: 'ready',
        tourState: { selectedId: experienceId, step: stale.stepIndex, total: 20, active: true, autoplay: true, navigating: false } };
      await t.context.call('poll_inspection', late);
      expect((await t.state()).panels.find((p: any) => p.panelId === t!.context.panelId).tour.active).toBe(false);
    }
  } finally { release?.(); await pending?.catch(() => {}); await t?.close(); network.close(); vi.unstubAllGlobals(); transport.lan = false; }
});

it('a live hydration recovers a desktop edit between save and attach with exact custom scene state', async () => {
  const t = await setup(false, true);
  try {
    const invoke=t.context.companionCall;
    let once=true, custom:any;
    t.context.companionCall=async(name:string,args:any)=>{
      if(name==='attach_inspection' && once) {
        once=false;
        const current=await t.read();
        custom=structuredClone(current.scene);
        custom.inspection.placement={translation:[.7,-.4,-1.3],rotation:[.1,.2,.3],scale:4.4};
        custom.inspection.appearance.labels=true;
        await t.call('sync_inspection',{sessionId:current.sessionId,serverEpoch:current.serverEpoch,sourceToken:current.sourceToken,
          baseStateRevision:current.stateRevision,baseInspectionRevision:current.inspectionRevision,scene:custom});
      }
      return invoke(name,args);
    };
    const originalToken=t.context.binding.sourceToken;
    await t.context.hydrate(t.context.binding.sessionId);
    expect(t.context.workspace.capture()).toEqual(custom);
    expect((await t.read()).scene).toEqual(custom);
    expect(t.context.binding.sourceToken).toBe(originalToken);
    expect(t.context.liveAvailability()).toBe('ready');
    expect((await t.state()).panels).toEqual([expect.objectContaining({panelId:t.context.panelId,current:true,availability:'ready'})]);
    expect(t.diagnostics).toContainEqual(expect.objectContaining({kind:'connection',phase:'attach-revision-refresh',attempt:1}));
    expect(t.diagnostics).toContainEqual(expect.objectContaining({kind:'tool-refused',tool:'attach_inspection',captioned:false}));
    expect(t.events).not.toContain(STALE_ATTACH_MESSAGE);
  } finally {await t.close();}
});

it('a desktop follower of an applied chapter follows a companion selection saved after attach without a stale acknowledgement', async () => {
  const t=await setup(true,true);
  try {
    expect((await t.remote('start')).command.status).toBe('rendered');t.player.pause();
    const before=await t.read();expect(before.experience.applied).toBe(true);
    const owner=t.context.panelId;
    // Keep the companion's capability: this newly mounted context represents
    // the desktop follower, with the same source and shared saved scene.
    t.context.panelId=undefined;t.context.isCompanion=false;t.context.console.debug=()=>{};
    const invoke=(name:string,args:any)=>{t.events.push(name);return t.call(name,args);};
    let selected:any,once=true;
    t.context.companionCall=async(name:string,args:any)=>{
      const response=await invoke(name,args);
      if(name==='attach_inspection' && once) {
        once=false;
        const current=await t.read(),catalog=await decodeInspectionCatalog(current.catalogWire ?? current.catalog);
        selected=structuredClone(current.scene);selected.selectionKeys=[catalog.rows[1].key];
        await t.call('sync_inspection',{sessionId:current.sessionId,serverEpoch:current.serverEpoch,sourceToken:current.sourceToken,
          baseStateRevision:current.stateRevision,baseInspectionRevision:current.inspectionRevision,scene:selected});
      }
      return response;
    };
    const start=t.events.length;
    await t.context.hydrate(before.sessionId);
    expect(t.events.slice(start)).not.toContain('acknowledge_experience_step');
    expect(t.context.blocked).toBe(false);expect(t.context.dirty).toBe(false);
    await expect(t.call('acknowledge_experience_step',{...t.context.expected(),panelId:t.context.panelId,
      experienceId:t.context.experienceView.definition.id,experienceRevision:t.context.experienceView.revision,
      stepIndex:t.context.experienceView.stepIndex})).rejects.toThrow('The panel did not acknowledge the current saved experience step.');
    // The ordinary revision-ordered follow restores the companion's newer
    // selection, preserving source, placement and the existing lesson scene.
    await t.context.poll();
    expect(t.context.workspace.capture()).toEqual(selected);
    expect(t.context.binding.inspectionRevision).toBe((await t.read()).inspectionRevision);
    expect(t.context.liveAvailability()).toBe('ready');
    await t.context.poll();
    const current=await t.state();
    expect(current.panels.map((panel:any)=>panel.panelId)).toContain(owner);
    expect(current.panels.find((panel:any)=>panel.panelId===t.context.panelId)).toMatchObject({surface:'desktop',current:true,availability:'ready'});
  } finally {await t.close();}
});

it('hydration clears an ended journey after a source-changing reconnect', async () => {
  const t = await setup(false, true);
  try {
    await t.remote('start'); await t.remote('pause');
    const stale = structuredClone(t.context.experienceView);
    await t.remote('done');
    t.player.update(stale); t.context.experienceView = stale;
    await t.context.hydrate(t.context.binding.sessionId);
    expect(t.player.getState()).toMatchObject({ active: false, feedback: 'The lesson ended while the link was down. Back to your view.' });
    expect((await t.state()).experienceCompletion).toBeUndefined();
    expect(t.context.workspace.capture()).toEqual(t.originalScene);
  } finally { await t.close(); }
});

for (const invalid of ['active journey', 'stale source', 'stale revision', 'active report'])
it(`ended-journey acknowledgement refuses ${invalid}`, async () => {
  const t = await setup(true, true);
  try {
    await t.remote('start'); await t.remote('pause');
    if (invalid !== 'active journey') await t.remote('done');
    const before = await t.state();
    const input = { ...t.context.expected(), panelId: t.context.panelId, experienceId, experienceRevision: 1, stepIndex: 0,
      reconcileEnded: true, tourState: { step: -1, total: 0, active: false, autoplay: false, navigating: false },
      ...(invalid === 'stale source' ? { sourceToken: randomUUID() } : {}),
      ...(invalid === 'stale revision' ? { baseInspectionRevision: 0 } : {}) };
    if (invalid === 'active report') input.tourState.active = true;
    await expect(t.call('acknowledge_experience_step', input)).rejects.toThrow('The ended journey must reconcile with the current rendered and saved view.');
    const after = await t.state();
    expect(after.experienceCompletion).toEqual(before.experienceCompletion);
    expect(after.experience).toEqual(before.experience);
    expect(after.inspectionRevision).toBe(before.inspectionRevision);
  } finally { await t.close(); }
});


it('poll delivers Done before reconciling a same-source ended journey', async () => {
  const t = await setup(true, true);
  try {
    await t.remote('start'); await t.remote('pause');
    const stale = structuredClone(t.context.experienceView);
    await t.remote('done');
    t.player.update(stale); t.context.experienceView = undefined;
    t.context.followsSourceTransition = followsSourceTransition;
    t.context.voiceBindingKey = () => '';
    t.context.hydrate = async () => { throw Error('Done delivery was bypassed by hydration'); };
    const commandId = 'd67-poll-done';
    await t.call('control_tour', { ...t.context.expected(), panelId: t.context.panelId, commandId, action: 'done' });
    await t.context.poll(); await t.context.rendering;
    expect((await t.state(commandId)).command.status).toBe('rendered');
    expect(t.player.getState().active).toBe(false);
    expect((await t.state()).experienceCompletion).toBeUndefined();
  } finally { await t.close(); }
});


it('reconnect renders a host step that was prepared but never applied', async () => {
  const t = await setup(true, true);
  try {
    await t.remote('start'); await t.remote('pause');
    const prepared=await t.context.call('navigate_experience', { ...t.context.expected(), panelId: t.context.panelId,
      experienceId, stepIndex: 1, baseExperienceRevision: t.context.experienceView.revision });
    expect((await t.read()).experience.applied).toBe(false);
    const configure = vi.fn(t.context.workspace.viewer.inspection.configure); t.context.workspace.viewer.inspection.configure = configure;
    const oldPanel = t.context.panelId; t.context.panelId = undefined;
    const dispatch=t.context.companionCall,claims:any[]=[];
    t.context.companionCall=async(name:string,args:any)=>{
      const response=await dispatch(name,args);
      if(name==='sync_inspection')claims.push(args.journeySave);
      if(name==='attach_inspection' && response._meta?.[KEY]?.journeySave) {
        expect(JSON.stringify(response.structuredContent)).not.toContain(prepared.structuredContent.experienceTransition.rollbackToken);
        expect(JSON.stringify(response.content)).not.toContain(prepared.structuredContent.experienceTransition.rollbackToken);
      }
      return response;
    };
    await t.context.attach(oldPanel);
    expect(t.context.panelId).toBe(oldPanel);
    expect(claims).toEqual([{panelId:oldPanel,rollbackToken:prepared.structuredContent.experienceTransition.rollbackToken}]);
    expect(configure).toHaveBeenCalledOnce();
    expect(configure).toHaveBeenCalledWith({ ...(await t.read()).experience.definition.steps[1].appearance, labels: false },
      { signal: expect.any(AbortSignal) });
    expect(t.player.getState()).toMatchObject({ active: true, step: 1, navigating: false });
    expect((await t.read()).experience.applied).toBe(true);
  } finally { await t.close(); }
});

it('journey reconnect claims refuse stale bindings and other surfaces and are never issued to a follower',async()=>{
  const t=await setup(true,true);
  try {
    await t.remote('start');await t.remote('pause');
    const owner=t.context.panelId;
    await t.context.call('navigate_experience',{...t.context.expected(),panelId:owner,experienceId,stepIndex:1,
      baseExperienceRevision:t.context.experienceView.revision});
    const request={...t.context.expected(),surface:'companion',replacesPanelId:owner};
    for(const patch of [{serverEpoch:randomUUID()},{sourceToken:randomUUID()},
      {baseStateRevision:request.baseStateRevision+1},{baseInspectionRevision:request.baseInspectionRevision+1},
      {surface:'desktop'}])await expect(t.call('attach_inspection',{...request,...patch})).rejects.toThrow();
    const other=(await t.call('attach_inspection',{...t.context.expected(),surface:'desktop'}));
    expect(other._meta?.[KEY]?.journeySave).toBeUndefined();
    const replacedOther=await t.call('attach_inspection',{...t.context.expected(),surface:'desktop',replacesPanelId:other.structuredContent.panelId});
    expect(replacedOther._meta?.[KEY]?.journeySave).toBeUndefined();
    expect((await t.read()).journeyTransition).toEqual({panelId:owner,status:'pending'});
  } finally {await t.close();}
});

for(const sourceChange of [false,true])it(`an expired missing journey owner yields its claim only to the live leased follower (source change ${sourceChange})`,async()=>{
  sources.swap=sourceChange;
  let now=0;
  const t=await setup(true,true,()=>now);
  let f:Awaited<ReturnType<typeof savedJourneyFollower>>|undefined;
  try {
    await t.remote('start');await t.remote('pause');
    f=await savedJourneyFollower(t);
    const owner=t.context.panelId,oldToken=f.follower.binding.sourceToken;
    const prepared=await t.call('navigate_experience',{...t.context.expected(),panelId:owner,experienceId,stepIndex:1,
      baseExperienceRevision:t.context.experienceView.revision});
    const request=f.follower.expected(),followerId=f.follower.panelId;
    for(now=5_000;now<=120_000;now+=5_000) {
      if(now===120_000) {
        const unknown=await t.call('poll_inspection',{...request,panelId:randomUUID(),availability:'ready'});
        expect(unknown._meta[KEY].transitionTarget).toBe(false);
        expect(unknown._meta[KEY].journeySave).toBeUndefined();
      }
      const beat=await t.call('poll_inspection',{...request,panelId:followerId,availability:'ready'});
      if(now<120_000)expect(beat._meta[KEY].journeySave).toBeUndefined();
      else {
        expect(beat._meta[KEY].journeySave).toEqual({panelId:followerId,rollbackToken:prepared.structuredContent.experienceTransition.rollbackToken});
        expect(JSON.stringify(beat.structuredContent)).not.toContain(prepared.structuredContent.experienceTransition.rollbackToken);
      }
    }
    await f.follower.poll();
    expect(f.follower.panelId).toBe(followerId);
    const restored=await t.read();
    expect(restored.experience).toMatchObject({stepIndex:1,applied:true});
    expect(restored.journeyTransition).toBeUndefined();
    expect(f.calls.filter(name=>name==='sync_inspection')).toHaveLength(1);
    expect(f.calls.filter(name=>name==='acknowledge_experience_step')).toHaveLength(1);
    expect(f.follower.binding.sourceToken===oldToken).toBe(!sourceChange);
  } finally {f?.close();await t.close();sources.swap=false;}
});

it('a follower preserves a genuine newer edit that superseded Done without saving or acknowledging the aborted completion',async()=>{
  const t=await setup(true,true);
  let f:Awaited<ReturnType<typeof savedJourneyFollower>>|undefined;
  try {
    await t.remote('start');await t.remote('pause');
    const dispatch=t.context.companionCall;
    let newer:any;
    t.context.companionCall=async(name:string,args:any)=>{
      if(name==='sync_inspection' && args.journeySave && !newer) {
        newer=structuredClone(args.scene);newer.inspection.appearance.uniformColor='#aa23bb';
        newer.inspection.appearance.color='uniform';
        await dispatch(name,{...args,journeySave:undefined,scene:newer});
      }
      return dispatch(name,args);
    };
    await expect(t.context.navigateExperience(experienceId,t.context.experienceView.stepIndex,false,true)).rejects.toThrow('superseded');
    const retained=await t.read();
    expect(retained.journeyTransition.status).toBe('superseded');
    expect(retained.experienceCompletion.status).toBe('pending');
    f=await savedJourneyFollower(t);
    await f.follower.hydrate(retained.sessionId);
    expect(f.calls).not.toContain('sync_inspection');expect(f.calls).not.toContain('acknowledge_experience_step');
    expect(f.follower.workspace.capture().inspection).toEqual(newer.inspection);
    expect((await t.read()).scene).toEqual(newer);
    expect((await t.read()).experienceCompletion.status).toBe('pending');
  } finally {f?.close();await t.close();}
});


// The actual page/companion callbacks after the older frame is drawn.
// Only geometry/frame submission is adapted; motion uses the viewer's closures.
async function drawnCorrectionPage(t: Awaited<ReturnType<typeof setup>>, network: ReturnType<typeof inMemoryCompanionNetwork>, failRestore: boolean | 'always' = false) {
  // @ts-ignore Shared production browser module.
  const { interruptibleCommand } = await import('../../lab/inspection/interruptible-command.mjs');
  // @ts-ignore Shared production browser module.
  const { createNamedPublication } = await import('../../lab/inspection/named-publication.mjs');
  // @ts-ignore Shared production caption formatter.
  const { outcomeCopy } = await import('../../lab/browser-roundtrip/outcome-copy.mjs');
  // Run the production configure/no-op, layer checks and mutation/frame code.
  // @ts-ignore Mol* geometry and canvas submission use this shared adapter.
  const { harness } = await import('../../lab/browser-roundtrip/render-dedupe-harness.mjs');
  const renderer = harness();
  const inspectionState = renderer.context.inspectionState; inspectionState.replace(t.originalScene.inspection);
  const undoBefore = inspectionState.snapshot().history.undoCount;
  const workspaceSource = await readFile(new URL('../../lab/inspection/workspace.mjs', import.meta.url), 'utf8');
  const remote = workspaceSource.slice(workspaceSource.indexOf('  applyRemote:') + '  applyRemote:'.length, workspaceSource.lastIndexOf('\n});')).trim().replace(/,$/, '');
  let scene = structuredClone(t.originalScene), restores = 0, queue = Promise.resolve(), hold: ReturnType<typeof network.holdNextTool> | undefined;
  const frames: string[] = [], captions: string[] = [], mutations: any[] = [], completionFrames: any[] = [];
  let drawnAppearance = structuredClone(t.originalScene.inspection.appearance);
  let drawHold: Promise<void> | undefined, failReplacement = false;
  const rebaseStart = viewerSource.indexOf('    rebaseOperation: ');
  const rebaseEnd = viewerSource.indexOf('\n    rollbackOperation:', rebaseStart);
  const rebaseOperation = rebaseStart < 0 ? undefined : new Function('inspectionState', `return (${viewerSource.slice(rebaseStart + '    rebaseOperation: '.length, rebaseEnd).trim().replace(/,$/, '')});`)(inspectionState);
  const motion: any = vm.createContext({
    inspectionState: {}, reducedMotionQuery: undefined, motionContextPaused: false, motionMutationPaused: false,
    motionToolPaused: false, motionUserPaused: false, motionDocumentPaused: false, motionXrExplicit: false,
    state: { status: 'ready' }, representation: { obj: {} }, canvas: { xr: { isPresenting: { value: true } } },
    interactionActive: () => false, motionDegreesPerSecond: () => 6, detached: structuredClone,
    syncPresentationMotion() {}, pausePresentationForInput: async () => { motion.motionToolPaused = true; },
    failure: (code: string, message: string) => Object.assign(Error(message), { code }),
  });
  for (const name of ['motionReason', 'inspectionMotionSnapshot', 'setInspectionMotion']) {
    const start = viewerSource.search(new RegExp(`  (?:async )?function ${name}\\(`));
    vm.runInContext(viewerSource.slice(start, viewerSource.indexOf('\n  }', start) + 4), motion);
  }
  const publication = createNamedPublication((snapshot: any) => mutations.push(snapshot));
  const capture = () => {
    const current = structuredClone(scene);
    Object.assign(current.inspection.appearance, inspectionState.snapshot().appearance);
    return current;
  };
  const waitForFrame = renderer.context.waitForFrame;
  renderer.context.waitForFrame = async () => {
    const params = renderer.cells.get('structure-repr').params.values;
    await drawHold;
    if (failReplacement) { failReplacement = false; throw Error('Injected correction frame failure'); }
    await waitForFrame();
    drawnAppearance = { ...inspectionState.snapshot().appearance,
      representation: params.type.name, color: params.colorTheme.name, opacity: params.type.params.alpha };
    frames.push(drawnAppearance.representation);
    if (drawnAppearance.representation === 'molecular-surface' && !hold) hold = network.holdNextTool('complete_inspection');
  };
  renderer.context.onMutation = () => {
    motion.motionToolPaused = true;
    publication.mutation(capture());
  };
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const request = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    const submitted = request.name === 'complete_inspection' && request.args?.scene
      ? { commandId: request.args.commandId, scene: structuredClone(request.args.scene), drawn: structuredClone(drawnAppearance) } : undefined;
    const response = await network.fetch(url, init);
    if (submitted) completionFrames.push({ ...submitted, result: await response.clone().json() });
    return response;
  });
  const viewer: any = { snapshot: () => ({ ready: true, interactionActive: false, xrPresenting: true }), inspection: {
    capture, getMotion: motion.inspectionMotionSnapshot, setMotion: motion.setInspectionMotion,
    beginOperation: () => inspectionState.checkpoint(), endOperation() {}, rebaseOperation,
    rollbackOperation: async (checkpoint: any) => { inspectionState.restoreCheckpoint(checkpoint); },
    configure: renderer.configureInspection,
    restore: async (saved: any, options: any) => {
      restores++; expect(options).toMatchObject({ preserveCamera: true, restorePlacement: true });
      if (failRestore) { if (failRestore !== 'always') failRestore = false; throw Error('Injected recovery frame failure'); }
      scene = structuredClone(saved); inspectionState.replace(scene.inspection); frames.push(scene.inspection.appearance.representation);
      drawnAppearance = structuredClone(scene.inspection.appearance);
      await renderer.context.applyInspectionAppearance();
      renderer.state.status = 'ready'; delete renderer.state.error;
      publication.mutation(structuredClone(scene));
    },
  }, xr: { outcome: async (text: string, status: string) => { captions.push(outcomeCopy(text, status).text); } } };
  const applyRemote = new Function('run', 'namedPublication', 'interruptibleCommand', 'viewer', `return (${remote});`)(
    (_message: string, action: () => Promise<any>) => { const next = queue.then(action); queue = next.catch(() => {}); return next; }, publication, interruptibleCommand, viewer);
  Object.assign(t.context.workspace, { viewer, snapshot: viewer.snapshot, capture: viewer.inspection.capture, applyRemote,
    restoreShared: async (saved: any, admit: () => void, preserveCamera: boolean, restorePlacement: boolean) => {
      admit(); await viewer.inspection.restore(saved, { preserveCamera, restorePlacement });
    } });
  Object.assign(t.context, { hudSignature: '', hudWaitingSince: 0, outcome: { dataset: {}, textContent: '' },
    confirmFailureRecovery: () => ({ action: 'drop' }) });
  install(t.context, 'showOutcome'); install(t.context, 'recoverConfirmation');
  const edit = async (commandId: string, patch: object, utteranceId?: string) => t.call('update_inspection', {
    ...t.context.expected(), panelId: t.context.panelId, commandId, ...(utteranceId ? { utteranceId } : {}), change: { kind: 'appearance', patch },
  });
  const utterance = async (commandId: string, action: string, utteranceId?: string) => (await t.call('update_inspection', {
    ...t.context.expected(), panelId: t.context.panelId, commandId, ...(utteranceId ? { utteranceId } : {}), change: { kind: 'utterance', patch: { action } },
  })).structuredContent.lifecycle.utterance.utteranceId;
  const deliver = async () => {
    const sent = { ...t.context.expected(), panelId: t.context.panelId, availability: t.context.liveAvailability() };
    const delivery = (await t.context.call('poll_inspection', sent))._meta[KEY].delivery;
    if (delivery) await t.context.receive(delivery, sent, t.context.generation);
    return delivery;
  };
  return { frames, captions, mutations, completionFrames, renderer, edit, utterance, deliver, undoBefore, inspectionState,
    get drawnAppearance() { return structuredClone(drawnAppearance); },
    holdDraw: (promise: Promise<void>) => { drawHold = promise; }, failReplacement: () => { failReplacement = true; }, get hold() { return hold; }, get restores() { return restores; } };
}

it.each(['cartoon', 'spacefill', 'molecular-surface', 'surface-opacity'] as const)('device order credits only the correction appearance actually drawn: %s', async path => {
    const patch = path === 'surface-opacity' ? { representation: 'molecular-surface', opacity: 0.5 } : { representation: path };
    const needsDraw = path !== 'molecular-surface';
    const network = inMemoryCompanionNetwork(); transport.lan = true;
    const entries: any[] = [];
    const transcriber = { enabled: true, ready: true, route: 'whisper', describe: () => 'fixture', missing: () => [], startupLine: () => '', dispose: async () => {},
      accept: async (input: any) => {
        const transcript = { utteranceId: input.utteranceId, text: entries.length ? `No make it ${path}` : 'Show it as a surface',
          receivedAt: new Date().toISOString(), durationMs: 100, cursor: entries.length + 1 };
        entries.push(transcript);
        return { accepted: true, utteranceId: input.utteranceId, seq: input.seq, final: true, reason: 'transcribed', message: 'Fixture', transcript };
      },
      transcripts: { get cursor() { return entries.length; }, since: async (after: number) => ({ cursor: entries.length, entries: entries.filter(e => e.cursor > after) }) },
    };
    let t: Awaited<ReturnType<typeof setup>> | undefined, page: Awaited<ReturnType<typeof drawnCorrectionPage>> | undefined, pending: Promise<any> | undefined;
    let release!: () => void; const frame = new Promise<void>(resolve => { release = resolve; });
    try {
      t = await setup(true, true, Date.now, network, experienceId, undefined, false, transcriber);
      page = await drawnCorrectionPage(t, network);
      const beforeRevision = (await t.state()).inspectionRevision;
      const old = randomUUID(), correction = randomUUID();
      // Both transcripts existed before either command was dispatched on a device run.
      for (const utteranceId of [old, correction]) await t.context.call('push_to_talk_audio', {
        sessionId: t.context.expected().sessionId, panelId: t.context.panelId, utteranceId, seq: 0, final: true, mime: 'audio/webm', data: 'AAAA',
      });
      const heard = (await t.call('listen_voice', { timeoutSeconds: 1 })).structuredContent.transcripts;
      expect(heard.map((entry: any) => entry.utteranceId)).toEqual([old, correction]);
      await page.edit('d86-surface', { representation: 'molecular-surface' }, old);
      pending = page.deliver();
      await vi.waitFor(async () => expect(page!.hold, JSON.stringify((await t!.state('d86-surface')).command)).toBeTruthy()); await page.hold!.request;
      expect(page.frames).toEqual(['molecular-surface']);
      expect((await t.state('d86-surface')).command.status).toBe('rendering');
      // Supersession reaches the page after the surface frame has committed.
      await page.utterance('d86-correct', 'correct', correction);
      await page.edit('d86-correction', patch, correction);
      page.holdDraw(frame);
      page.hold!.releaseRequest(); page.hold!.releaseResponse();
      if (needsDraw) {
        await vi.waitFor(async () => expect(['rendering', 'rendered']).toContain((await t!.state('d86-correction')).command.status));
        expect.soft((await t.state('d86-correction')).command.status).toBe('rendering');
        expect(page.drawnAppearance.representation).toBe('molecular-surface');
        expect.soft(page.mutations).toEqual([]);
        expect.soft(page.completionFrames.filter(item => item.commandId === 'd86-correction')).toEqual([]);
      }
      release(); await pending;
      const corrected = await t.state('d86-correction');
      expect(corrected.command).toMatchObject({ status: 'rendered', renderedRevision: beforeRevision + 1 });
      expect(page.drawnAppearance, 'saved appearance must equal the submitted frame').toEqual(corrected.view.appearance);
      expect(page.frames).toEqual(needsDraw ? ['molecular-surface', patch.representation] : ['molecular-surface']);
      const receipt = page.completionFrames.find(item => item.commandId === 'd86-correction');
      expect(receipt.drawn).toEqual(receipt.scene.inspection.appearance);
      expect(receipt.result.structuredContent.command.renderedRevision).toBe(corrected.inspectionRevision);
      expect(page.restores).toBe(0);
      expect((await t.state('d86-surface')).command).toMatchObject({ status: 'superseded', fenceReleased: 'replacement-rendered' });
      expect(page.inspectionState.snapshot().history.undoCount).toBe(page.undoBefore + 1);
      const checkpoint = page.inspectionState.checkpoint();
      expect(page.inspectionState.undo().appearance).toEqual(t.originalScene.inspection.appearance);
      page.inspectionState.restoreCheckpoint(checkpoint);
      await page.edit('d86-next', { representation: 'ball-and-stick' }); await page.deliver();
      expect((await t.state('d86-next')).command.status).toBe('rendered');
      expect(page.frames.at(-1)).toBe('ball-and-stick');
      expect((await t.state()).view.appearance).toEqual(page.drawnAppearance);
      expect((await t.state()).pendingCommand).toEqual([]);
    } finally {
      release(); page?.hold?.releaseRequest(); page?.hold?.releaseResponse(); await pending;
      await t?.close(); network.close(); transport.lan = false; vi.unstubAllGlobals();
    }
  });

it.each(['same-field', 'different-field', 'restore-failure'] as const)('drawn supersession renders its correction and next representation: %s', async path => {
  const network = inMemoryCompanionNetwork(); transport.lan = true;
  let t: Awaited<ReturnType<typeof setup>> | undefined, page: Awaited<ReturnType<typeof drawnCorrectionPage>> | undefined, pending: Promise<any> | undefined;
  try {
    t = await setup(true, true, Date.now, network);
    const panelId = t.context.panelId;
    page = await drawnCorrectionPage(t, network, path === 'restore-failure');
    const old = await page.utterance('d82-begin', 'begin');
    await page.edit('d82-surface', { representation: 'molecular-surface' }, old);
    pending = page.deliver();
    await vi.waitFor(() => expect(page!.hold).toBeTruthy());
    await page.hold!.request;
    expect(page.frames).toEqual(['molecular-surface']);
    expect((await t.state('d82-surface')).command.status).toBe('rendering');
    expect(page.mutations).toEqual([]);
    const correction = await page.utterance('d82-correct', 'correct');
    await page.edit('d82-correction', path === 'same-field' ? { representation: 'cartoon' } : { color: 'element-symbol' }, correction);
    expect((await t.state('d82-correction')).command.status).toBe('queued');
    page.hold!.releaseRequest(); page.hold!.releaseResponse(); await pending;
    await page.deliver();
    const corrected = await t.state('d82-correction');
    expect(corrected.command.status).toBe('rendered');
    expect(corrected.view.appearance.representation).toBe('cartoon');
    expect(corrected.panels.map((panel: any) => panel.panelId)).toEqual([panelId]);
    expect(corrected.pendingCommand).toEqual([]);
    expect(page.captions.join(' ')).not.toMatch(/could not restore the previous view|Could not apply · style/i);
    expect(t.context.blocked).toBe(false); expect(t.context.dirty).toBe(false);
    if (path === 'same-field') {
      expect(page.restores).toBe(0);
      expect(page.inspectionState.snapshot().history.undoCount).toBe(page.undoBefore + 1);
    }
    await page.edit('d82-next', { representation: 'ball-and-stick' }); await page.deliver();
    expect((await t.state('d82-next')).command.status).toBe('rendered');
    expect((await t.state()).view.appearance.representation).toBe('ball-and-stick');
    expect((await t.state('d82-surface')).command.status).toBe('superseded');
  } finally {
    page?.hold?.releaseRequest(); page?.hold?.releaseResponse(); await pending;
    await t?.close(); network.close(); transport.lan = false; vi.unstubAllGlobals();
  }
});


it.each(['busy', 'cancelled-render'] as const)('an expired dispatch hold explains why it never drew: %s', async path => {
  const network = inMemoryCompanionNetwork(); transport.lan = true; let now = 0;
  let t: Awaited<ReturnType<typeof setup>> | undefined;
  try {
    t = await setup(true, true, () => now, network);
    const page = await drawnCorrectionPage(t, network);
    const poll = (availability: string) => t!.context.call('poll_inspection', { ...t!.context.expected(), panelId: t!.context.panelId, availability });
    if (path === 'cancelled-render') {
      const old = await page.utterance('d82-held-begin', 'begin');
      await page.edit('d82-held-surface', { representation: 'molecular-surface' }, old);
      const delivery = (await poll('ready'))._meta[KEY].delivery;
      await t.context.call('complete_inspection', { ...t.context.expected(), ...delivery, change: undefined, utteranceId: undefined, phase: 'admit' });
      const correction = await page.utterance('d82-held-correct', 'correct');
      await page.edit('d82-held', { representation: 'cartoon' }, correction);
      expect((await poll('ready'))._meta[KEY].delivery).toBeUndefined();
    } else {
      await poll('busy'); await page.edit('d82-held', { representation: 'cartoon' });
      expect((await poll('busy'))._meta[KEY].delivery).toBeUndefined();
      // The page keeps beating busy. A busy page silent for five seconds reads
      // as paused instead, and the host saves the edit for it (asleep-wearer.test.ts).
      for (now = 4_000; now <= 12_000; now += 4_000) expect((await poll('busy'))._meta[KEY].delivery).toBeUndefined();
    }
    now = 15_001;
    const receipt = (await t.state('d82-held')).command;
    expect(receipt).toMatchObject({ status: 'expired', heldForPanel: true, reason: 'panel_hold_expired' });
    expect(receipt.detail).toContain(path === 'busy' ? 'panel stayed busy' : 'previous cancelled change was still being restored');
    t.context.showOutcome({ ...receipt, fields: ['representation'] });
    expect(page.captions.at(-1)).toBe(receipt.detail);
    expect(page.captions.at(-1)).not.toContain('Could not apply'); expect(page.frames).toEqual([]);
  } finally { await t?.close(); network.close(); transport.lan = false; vi.unstubAllGlobals(); }
});

it.each(['held-frame', 'failed-frame', 'persistent-restore', 'lost-response'] as const)('replacement receipt and recovery keep draw ownership: %s', async path => {
  const network = inMemoryCompanionNetwork(); transport.lan = true;
  let t: Awaited<ReturnType<typeof setup>> | undefined, page: Awaited<ReturnType<typeof drawnCorrectionPage>> | undefined, pending: Promise<any> | undefined;
  let release!: () => void; const frame = new Promise<void>(resolve => { release = resolve; });
  try {
    t = await setup(true, true, Date.now, network);
    page = await drawnCorrectionPage(t, network, path === 'persistent-restore' ? 'always' : false);
    if (path === 'lost-response') {
      let dropped=false;
      t.context.confirmFailureRecovery=({attempt}: {attempt: number})=>attempt===1?{action:'retry',delayMs:0}:{action:'drop'};
      vi.stubGlobal('fetch',async (url: string, init: RequestInit) => {
        const request=typeof init?.body==='string'?JSON.parse(init.body):{};
        const response=await network.fetch(url,init);
        if(!dropped && request.name==='complete_inspection' && request.args?.scene) {
          dropped=true;throw Error('The old receipt response was lost after the host claimed the correction.');
        }
        return response;
      });
    }
    const old = await page.utterance('d82-proof-begin', 'begin');
    await page.edit('d82-proof-surface', { representation: 'molecular-surface' }, old); pending = page.deliver();
    await vi.waitFor(() => expect(page!.hold).toBeTruthy()); await page.hold!.request;
    const correction = await page.utterance('d82-proof-correct', 'correct');
    await page.edit('d82-proof-correction', path === 'persistent-restore' ? { color: 'element-symbol' } : { representation: 'cartoon' }, correction);
    if (path === 'held-frame') page.holdDraw(frame);
    if (path === 'failed-frame') page.failReplacement();
    page.hold!.releaseRequest(); page.hold!.releaseResponse();
    if (path === 'held-frame') {
      await vi.waitFor(async () => expect((await t!.state('d82-proof-correction')).command.status).toBe('rendering'));
      expect(page.frames).toEqual(['molecular-surface']); expect(page.mutations).toEqual([]);
      expect((await t.state('d82-proof-surface')).command).toMatchObject({ status: 'superseded', fenceReleased: 'pending' });
      release();
    }
    await pending; await page.deliver();
    const receipt = (await t.state('d82-proof-correction')).command;
    expect(receipt.status).toBe(path === 'held-frame' || path === 'lost-response' ? 'rendered' : 'rejected');
    expect((await t.state()).pendingCommand).toEqual([]);
    expect((await t.state('d82-proof-surface')).command.fenceReleased).toBe(path === 'held-frame' || path === 'lost-response' ? 'replacement-rendered' : path === 'failed-frame' ? 'rolled-back' : 'recovery-failed');
    if (path === 'persistent-restore') {
      expect(t.context.blocked).toBe(true); expect(t.context.dirty).toBe(true);
      expect(receipt.detail).toBe('The previous change could not be restored. Load the saved view before trying again.');
      t.context.showOutcome(receipt); expect(page.captions.at(-1)).toBe(receipt.detail);
    } else {
      await page.edit('d82-proof-next', { representation: 'ball-and-stick' }); await page.deliver();
      expect((await t.state('d82-proof-next')).command.status).toBe('rendered');
    }
  } finally {
    release(); page?.hold?.releaseRequest(); page?.hold?.releaseResponse(); await pending;
    await t?.close(); network.close(); transport.lan = false; vi.unstubAllGlobals();
  }
});

for (const action of ['model', 'menu']) it(`${action} Done restores a clear recorded view without reloading, then repeats exactly`, async () => {
  // @ts-ignore Shared production viewer/toolbar closure harness.
  const { deviceDoneClearance, devicePlacement } = await import('../../lab/browser-roundtrip/fixtures/device-done-clearance.mjs');
  const network = inMemoryCompanionNetwork(); transport.lan = true;
  const t = await setup(true, true, Date.now, network);
  const controls = await toolbarMenu(t);
  const fetches = vi.fn(network.fetch); vi.stubGlobal('fetch', fetches);
  let geometry: any, sourceViewer: any;
  try {
    const initial = t.context.workspace.capture();
    initial.inspection.placement = structuredClone(devicePlacement);
    initial.inspection.appearance.representation = 'molecular-surface';
    t.context.scheduleSave(); await t.context.save(); await t.context.poll();
    const original = structuredClone(initial);
    const opened = await t.read(), catalog = await decodeInspectionCatalog(opened.catalogWire ?? opened.catalog);
    sourceViewer = await sourceLoadHarness({ id: '4HHB', cif: hhb, sha256: catalog.source.sha256, catalog }, original);
    const sourceCameraScale = sourceViewer.canvas.camera.scale;
    geometry = await deviceDoneClearance({ runtime: toolbarRuntime,
      getPlacement: () => t.context.workspace.capture().inspection.placement,
      setPlacement: (value: any) => { t.context.workspace.capture().inspection.placement = value; } });
    // The larger current menu needs a 40 cm left seat to establish the
    // same clear starting view. Keep the strict binocular gap throughout.
    await geometry.moveChapterMenu(-.4);
    expect(geometry.measure().eyes.every((eye: any) => eye.clearance > .1)).toBe(true);
    t.context.workspace.viewer.inspection.restoreJourneySeat = ({ scene }: any) => geometry.restore(scene);
    const load = t.context.workspace.loadSource;
    // On base code, Done enters production Mol* source staging before the
    // saved-scene draw and clearance check. The fix must avoid this path.
    const loadSource = vi.fn(async (next: any, options: any) => { await sourceViewer.load(next); await load(next, options); });
    t.context.workspace.loadSource = loadSource;
    const sentence = 'Restored your pre-tour view.';
    for (let pass = 0; pass < 2; pass++) {
      await t.player.openMenu(); await t.player.start();
      await t.remote('next'); await t.remote('next'); t.player.pause();
      // Device sequence: menu start, paused chapter, two Next presses, Done.
      await controls.press('next'); await geometry.chapter(3);
      await controls.press('next'); await geometry.chapter(4);
      const loads = loadSource.mock.calls.length;
      const sourceReads = fetches.mock.calls.filter(([url]) => url === '/source').length;
      const owner = t.context.panelId;
      const result = action === 'model' ? await t.remote('done') : (await controls.press('done'), await t.state());
      expect(result.experienceCompletion.status).toBe('rendered');
      expect(t.context.panelId).toBe(owner);
      expect.soft(sourceViewer.canvas.camera.scale).toBe(sourceCameraScale);
      expect.soft(fetches.mock.calls.filter(([url]) => url === '/source')).toHaveLength(sourceReads);
      if (action === 'model') expect(result.command.status).toBe('rendered');
      expect.soft(loadSource.mock.calls.length, 'same-source Done must restore the loaded scene').toBe(loads);
      expect(t.context.workspace.capture()).toEqual(original);
      expect(controls.plates).toContain(sentence);
      expect(controls.plates).not.toContain('Restored your view and adjusted it to clear the menu.');
      expect(geometry.measure().eyes.every((eye: any) => eye.clearance > .1)).toBe(true);
    }
  } finally { sourceViewer?.dispose(); await geometry?.dispose(); await controls.close(); await t.close(); network.close(); transport.lan = false;
    vi.unstubAllGlobals(); forgetCompanionPageKey(); }
});

for (const mismatch of ['model', 'assembly', 'subset']) it(`Done reloads a ${mismatch} mismatch even with matching source bytes`, async () => {
  const t = await setup(true);
  try {
    await t.remote('start'); t.player.pause(); await t.remote('next');
    const snapshot = t.context.workspace.snapshot;
    t.context.workspace.snapshot = () => ({ ...snapshot(), ...(mismatch === 'model' ? { modelNumber: 2 }
      : mismatch === 'assembly' ? { assemblyId: 'another-assembly' } : { sourceSubset: true }) });
    const load = vi.fn(t.context.workspace.loadSource); t.context.workspace.loadSource = load;
    expect((await t.remote('done')).command.status).toBe('rendered');
    expect(load).toHaveBeenCalledOnce();
    expect(t.context.workspace.capture()).toEqual(t.originalScene);
  } finally { await t.close(); }
});

for (const action of ['model', 'menu']) it(`${action} Done clears the held menu and captions the live placement outcome after saving`, async () => {
  // @ts-ignore Production restore and toolbar geometry with synthetic stereo views.
  const { deviceDoneClearance } = await import('../../lab/browser-roundtrip/fixtures/device-done-clearance.mjs');
  // @ts-ignore Production receipt arbitration; the GPU/text sink is adapted below.
  const { outcomeLineDecision } = await import('../../lab/browser-roundtrip/outcome-line.mjs');
  const network = inMemoryCompanionNetwork(); transport.lan = true;
  const t = await setup(true, true, Date.now, network, experienceId, undefined, true);
  const controls = await toolbarMenu(t);
  const fetches = vi.fn(network.fetch); vi.stubGlobal('fetch', fetches);
  let geometry: any, sourceViewer: any, pending: Promise<any> | undefined, seatResult: any;
  let release!: () => void;
  try {
    const initial = t.context.workspace.capture();
    initial.inspection.placement = { translation: [-5.2753, .4539, 5.3812], rotation: [0, 0, 0], scale: 1.034 };
    initial.inspection.appearance.representation = 'molecular-surface';
    t.context.scheduleSave(); await t.context.save(); await t.context.poll();
    const original = structuredClone(initial), owner = t.context.panelId;
    const opened = await t.read(), catalog = await decodeInspectionCatalog(opened.catalogWire ?? opened.catalog);
    sourceViewer = await sourceLoadHarness({ id: '4HHB', cif: hhb, sha256: catalog.source.sha256, catalog }, original);
    await sourceViewer.load({ id: '4HHB', cif: hhb, sha256: catalog.source.sha256, catalog }, { representation: 'molecular-surface' });
    geometry = await deviceDoneClearance({ runtime: toolbarRuntime, placement: original.inspection.placement,
      getPlacement: () => t.context.workspace.capture().inspection.placement,
      setPlacement: (value: any) => { t.context.workspace.capture().inspection.placement = value; } });
    const restoreSeat = vi.fn(async ({ scene }: any) => {
      // Unlike the earlier run, draw the actual pending player state, including its caption.
      await geometry.setTour(t.player.getState());
      // The chapter menu was summoned after its original head sample. Done
      // keeps that anchor, so the saved view may need a clearance adjustment.
      await geometry.moveChapterMenu(.13);
      seatResult = await geometry.restore(scene);
      return seatResult;
    });
    t.context.workspace.viewer.inspection.restoreJourneySeat = restoreSeat;
    const load = t.context.workspace.loadSource;
    const loadSource = vi.fn(async (next: any, options: any) => { await sourceViewer.load(next); await load(next, options); });
    t.context.workspace.loadSource = loadSource;
    t.context.outcome = { dataset: {} }; t.context.hudSignature = ''; t.context.hudWaitingSince = 0;
    t.context.workspace.viewer.xr.outcome = async (text: string, status: string) => {
      if (outcomeLineDecision({ text, status }).draw) t.context.showHeadsetCaption(text);
    };
    install(t.context, 'showOutcome');
    for (let pass = 0; pass < 2; pass++) {
      const preTourPlacement = structuredClone(t.context.workspace.capture().inspection.placement);
      await t.player.openMenu(); await geometry.setTour(t.player.getState());
      await controls.press('tour'); t.player.pause(); await geometry.setTour(t.player.getState());
      await controls.press('next'); await controls.press('next');
      const chapter = structuredClone(t.context.workspace.capture());
      chapter.inspection.placement = { ...chapter.inspection.placement, translation: [-4.8, .6, 5], scale: .7 };
      await t.context.workspace.restore(chapter); t.context.scheduleSave(); await t.context.save(); await t.context.poll();
      expect(t.context.workspace.capture().inspection.placement).not.toEqual(original.inspection.placement);
      const loads = loadSource.mock.calls.length, sourceReads = fetches.mock.calls.filter(([url]) => url === '/source').length;
      const before = t.events.length; controls.plates.length = 0;
      const held = new Promise<void>(resolve => { release = resolve; }); t.holdDraw(held);
      let result: any;
      if (action === 'model') {
        const sent = { ...t.context.expected(), panelId: owner, availability: 'ready', tourState: tourHeartbeat(t.player) };
        await t.context.call('poll_inspection', sent);
        const queued = await t.call('update_inspection', { ...t.context.expected(), panelId: owner,
          commandId: `model-done-${pass}`, change: { kind: 'tour', patch: { action: 'done' } } });
        expect(queued.structuredContent.command.status).toBe('queued');
        const delivery = (await t.context.call('poll_inspection', sent))._meta[KEY].delivery;
        pending = t.context.receive(delivery, sent, t.context.generation);
      } else pending = controls.press('done');
      await vi.waitFor(() => expect(t.events.slice(before)).toContain('restore-draw-pending'));
      expect((await t.state(action === 'model' ? `model-done-${pass}` : undefined)).experienceCompletion.status).toBe('pending');
      expect(controls.plates).not.toContain('Restored your pre-tour view.');
      expect(t.events.slice(before)).not.toContain('acknowledge_experience_step');
      release(); await pending; pending = undefined;
      result = await t.state(action === 'model' ? `model-done-${pass}` : undefined);
      expect(result.experienceCompletion.status).toBe('rendered');
      if (action === 'model') expect(result.command.status).toBe('rendered');
      expect(t.context.panelId).toBe(owner);
      expect(result.panels.map((panel: any) => panel.panelId)).toEqual([owner]);
      expect(geometry.measure().eyes.every((eye: any) => eye.clearance > 0)).toBe(true);
      expect.soft(loadSource.mock.calls.length).toBe(loads);
      expect.soft(fetches.mock.calls.filter(([url]) => url === '/source')).toHaveLength(sourceReads);
      expect.soft(geometry.roomEntry.seat).toEqual(preTourPlacement);
      // The peripheral menu leaves the saved placement clear in both eyes;
      // returning from a chapter no longer needs to shrink this custom view.
      expect.soft(seatResult.placementRestored).toBe(true);
      expect.soft(t.context.workspace.capture().inspection.placement).toEqual(preTourPlacement);
      expect.soft(controls.plates.at(-1)).toBe('Restored your pre-tour view.');
      expect.soft(controls.plates.some(text => text.startsWith('Applied · scene'))).toBe(false);
      const events = t.events.slice(before);
      expect(events.indexOf('drawn')).toBeLessThan(events.indexOf('sync_inspection'));
      expect(events.indexOf('sync_inspection')).toBeLessThan(events.indexOf('acknowledge_experience_step'));
      expect(restoreSeat).toHaveBeenCalledTimes(pass + 1);
    }
  } finally { release?.(); await pending; sourceViewer?.dispose(); await geometry?.dispose(); await controls.close(); await t.close(); network.close();
    transport.lan = false; vi.unstubAllGlobals(); forgetCompanionPageKey(); }
});

/**
 * A source load drew nothing on the wearer's status row.
 *
 * Every appearance, selection, visibility and tour change draws `Waiting ·
 * <field>` when the page takes it and `Applied · <field> · r<N>` when it has
 * drawn and saved, with a `hud-outcome` record for each. On one device session a
 * `replace_inspection_source` load drew neither: the ring held only grow,
 * transition and cost records, and the status row still carried whatever the
 * previous command had left there for the whole of the load. The readout's
 * title and source line did change, so the load was not silent -- but nothing
 * said the request had been heard, and nothing said it had landed.
 *
 * These run the production `poll`, `hydrate`, `attach` and `showOutcome`
 * closures against the real host, so `Applied` is drawn at the same moment
 * `sourceRenderReceipt` goes rendered and on the revision it names.
 */
function hudPlate(t: Awaited<ReturnType<typeof setup>>) {
  const plate: { text: string; state: string }[] = [];
  Object.assign(t.context, { hudSignature: '', hudWaitingSince: 0, sourceLoadOutcome: undefined,
    outcome: { textContent: '', dataset: {} as Record<string, string> } });
  t.context.workspace.viewer.xr.outcome = async (text: string, state: string) => { plate.push({ text, state }); };
  // The harness carries the three source-load writers; this is the production
  // sentence and plate state they drive, in place of the harness's stub.
  install(t.context, 'showOutcome');
  return { plate, copy: () => plate.map(entry => outcomeCopy(entry.text, entry.state).text),
    hud: () => t.diagnostics.filter(event => event.kind === 'hud-outcome') };
}

it('a voice source load draws Waiting and then Applied on the revision its receipt names', async () => {
  const network = inMemoryCompanionNetwork(); transport.lan = true;
  let t: Awaited<ReturnType<typeof setup>> | undefined;
  try {
    t = await setup(true, true, Date.now, network);
    const readout = hudPlate(t);
    await t.context.poll();
    const owner = t.context.panelId;
    const utterance = (await t.call('update_inspection', { ...t.context.expected(), panelId: owner,
      commandId: 'd94-begin', change: { kind: 'utterance', patch: { action: 'begin' } } })).structuredContent.lifecycle.utterance;
    await t.call('replace_inspection_source', { ...t.context.expected(), panelId: owner,
      pdbId: '1CRN', utteranceId: utterance.utteranceId });
    // The host has the new coordinates; the page has not followed them yet.
    expect(readout.hud()).toEqual([]);
    await t.context.poll();
    const after = await t.state();
    expect(after.sourceRenderReceipt).toMatchObject({ panelId: owner, rendered: true });
    const revision = after.sourceRenderReceipt.renderedRevision;
    expect(readout.hud()).toEqual([
      expect.objectContaining({ status: 'rendering', fields: 'structure', revision: null }),
      expect.objectContaining({ status: 'rendered', fields: 'structure', revision }),
    ]);
    expect(readout.copy()).toEqual(['Waiting · structure', `Applied · structure · r${revision}`]);
    // Orange while the load is outstanding, teal once it is drawn and saved.
    expect(readout.plate.map(entry => entry.state)).toEqual(['waiting', 'applied']);
    // The readout's own title line carries the name of the structure. The
    // status row must not repeat it.
    expect(readout.plate.map(entry => entry.text).join('\n')).not.toMatch(/1CRN|crambin|haemoglobin/i);
    // The acknowledgement follows the frame it acknowledges.
    const drawn = t.events.lastIndexOf('drawn'), registered = t.events.lastIndexOf('attach_inspection');
    expect(drawn).toBeGreaterThanOrEqual(0); expect(registered).toBeGreaterThan(drawn);
  } finally {
    await t?.close(); network.close(); transport.lan = false;
    vi.unstubAllGlobals(); forgetCompanionPageKey();
  }
});

it('a failed source load keeps its caption, says so on the plate and never says Applied', async () => {
  const network = inMemoryCompanionNetwork(); transport.lan = true;
  let t: Awaited<ReturnType<typeof setup>> | undefined;
  try {
    t = await setup(true, true, Date.now, network);
    const readout = hudPlate(t);
    await t.context.poll();
    const owner = t.context.panelId;
    await t.call('replace_inspection_source', { ...t.context.expected(), panelId: owner, pdbId: '1CRN' });
    const loadSource = t.context.workspace.loadSource;
    t.context.workspace.loadSource = async () => { throw Error('Injected draw failure'); };
    await expect(t.context.poll()).rejects.toThrow('Injected draw failure');
    expect(t.events).toContain('Structure load failed. Your previous view is still shown.');
    expect((await t.state()).sourceRenderReceipt).toMatchObject({ status: 'failed', rendered: false,
      failure: 'render_failed', failureReason: 'Injected draw failure', panelId: owner });
    expect(readout.hud().map(event => event.status)).toEqual(['rendering', 'failed']);
    expect(readout.hud().at(-1)).toMatchObject({ fields: 'structure', revision: null,
      detail: expect.stringContaining('Injected draw failure') });
    expect(readout.copy()).toEqual(['Waiting · structure', 'Could not apply · structure']);
    expect(readout.copy().some(text => text.startsWith('Applied'))).toBe(false);
    // The retry is a load of its own and is acknowledged as one.
    t.context.workspace.loadSource = loadSource;
    await t.context.poll();
    const after = await t.state();
    expect(after.sourceRenderReceipt).toMatchObject({ panelId: owner, rendered: true });
    expect(readout.copy().slice(2)).toEqual(['Waiting · structure',
      `Applied · structure · r${after.sourceRenderReceipt.renderedRevision}`]);
  } finally {
    await t?.close(); network.close(); transport.lan = false;
    vi.unstubAllGlobals(); forgetCompanionPageKey();
  }
});

/**
 * The plate went back to the structure that had just
 * been replaced.
 *
 * On one device session row 7 "Go back to hemoglobin" loaded 4HHB over 1CRN. The plate
 * drew `Applied · structure · r1` for the new coordinates, and 118 ms later
 * drew `Applied · change · r6` again -- 1CRN's hide-water receipt, from the
 * source that had just been retired. The wearer's acknowledgement of the load
 * was overwritten by a receipt for a picture that was no longer on the screen.
 *
 * The queue itself crosses a source replacement on purpose: it carries the
 * panel registrations and the utterance lifecycle over. What must not cross is
 * a receipt, because a receipt names a revision of a source, and after the
 * replacement neither of those two numbers means what it did. So the last
 * outcome a heartbeat reports is the last outcome OF THIS SOURCE, and a
 * replacement leaves the wearer's own load receipt standing as the last word.
 */
it('a source load retires the previous source receipt instead of redrawing it', async () => {
  const network = inMemoryCompanionNetwork(); transport.lan = true;
  let t: Awaited<ReturnType<typeof setup>> | undefined;
  try {
    t = await setup(true, true, Date.now, network);
    const readout = hudPlate(t);
    await t.context.poll();
    const owner = t.context.panelId;
    // A change rendered on the first structure, the way row 7 left one standing
    // before the load.
    const changed = (await t.colour(owner)).command;
    expect(changed.status).toBe('rendered');
    const retired = changed.renderedRevision;
    expect(readout.hud().at(-1)).toMatchObject({ status: 'rendered', revision: retired });
    await t.context.poll();
    // The second structure replaces the first.
    await t.call('replace_inspection_source', { ...t.context.expected(), panelId: owner, pdbId: '1CRN' });
    await t.context.poll();
    const after = await t.state();
    expect(after.sourceRenderReceipt).toMatchObject({ panelId: owner, rendered: true });
    const loaded = after.sourceRenderReceipt.renderedRevision;
    // The new source counts its own revisions, so the retired receipt names a
    // higher one: reading it back is a jump forwards as well as backwards.
    expect(loaded).toBeLessThan(retired);
    expect(readout.copy().at(-1)).toBe(`Applied · structure · r${loaded}`);
    const drawn = readout.hud().length;
    // The beat after the load is where a device session drew the retired receipt.
    await t.context.poll(); await t.context.poll();
    expect(readout.hud().slice(drawn)).toEqual([]);
    expect(readout.copy().at(-1)).toBe(`Applied · structure · r${loaded}`);
    // And the host says so itself: no outcome belongs to the new source yet.
    const beat = await t.context.call('poll_inspection', { ...t.context.expected(),
      panelId: t.context.panelId, availability: t.context.liveAvailability() });
    expect(beat.structuredContent.outcome).toBeNull();
  } finally {
    await t?.close(); network.close(); transport.lan = false;
    vi.unstubAllGlobals(); forgetCompanionPageKey();
  }
});
