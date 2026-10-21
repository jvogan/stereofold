import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { createSaveRetryAdmission } from '../src/inspection-save-retry.js';
import { InspectionCommands, type InspectionBinding } from '../src/inspection-commands.js';
import type { InspectionScene } from '../src/inspection-contract.js';
import { inspectionFailureReceipt } from '../src/inspection-failure-receipt.js';
import { waitForPanelRender, panelEntering, sameEntryScene, withWearerEdits } from '../src/inspection-render-settle.js';
// @ts-expect-error Shared production browser transaction.
import { interruptibleCommand } from '../../lab/inspection/interruptible-command.mjs';
// @ts-expect-error Shared production browser publication guard.
import { createNamedPublication } from '../../lab/inspection/named-publication.mjs';

const inspector = readFileSync(new URL('../src/inspector.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('inspector.ts', inspector, ts.ScriptTarget.Latest, true);
const names = ['receive', 'confirmReceipt', 'save', 'scheduleSave', 'registerPollState', 'receivePollDelivery'];
const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? ''))
  .map(node => node.getText(ast)).join('\n');
for (const name of names) expect(functions).toContain(`function ${name}`);
const workspace = readFileSync(new URL('../../lab/inspection/workspace.mjs', import.meta.url), 'utf8');
const runSource = workspace.slice(workspace.indexOf('function run('), workspace.indexOf('\nfunction ui('));
const remoteSource = workspace.slice(workspace.indexOf('  applyRemote:') + '  applyRemote:'.length, workspace.lastIndexOf('\n});')).trim().replace(/,$/, '');
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

function fixture(options: { uiFailure?: boolean; rollbackFailure?: boolean; localEditAfterRollback?: boolean; lostSettlement?: boolean; clock?: () => number } = {}) {
  let now = 0;
  const host = new InspectionCommands(options.clock ?? (() => now));
  let binding: InspectionBinding = { serverEpoch: 'epoch', sourceToken: 'source', stateRevision: 1, inspectionRevision: 1 };
  let saved: InspectionScene = { sourceSha256: 'a'.repeat(64), modelNumber: 1, assemblyId: '1', selectionKeys: ['one'],
    camera: { mode: 'perspective', fov: 45, position: [0,0,10], target: [0,0,0], up: [0,1,0], radius: 4, radiusMax: 8, fog: 50, clipFar: true, minNear: .1, minFar: 1 },
    inspection: { appearance: { representation: 'ball-and-stick', color: 'element-symbol', uniformColor: '#ffffff', background: '#000000',
      highlightColor: '#ffff00', opacity: 1, labels: false, clipping: 0, fog: 0 }, placement: { translation: [0,0,0], rotation: [0,0,0], scale: 1 } } };
  let drawn = structuredClone(saved);
  const expected = () => ({ serverEpoch: binding.serverEpoch, sourceToken: binding.sourceToken,
    baseStateRevision: binding.stateRevision, baseInspectionRevision: binding.inspectionRevision });
  const panelId = host.attach({ ...expected(), surface: 'companion' }, binding);
  const drawing = deferred(), releaseDraw = deferred(), rebuilding = deferred(), releaseRollback = deferred();
  const calls: any[] = [], publications: any[] = [], confirmations: any[] = [];
  let rebuilt = false, lostSettlement = options.lostSettlement;
  const viewer = { snapshot: () => ({ ready: true, xrPresenting: true, interactionActive: false }), inspection: {
    capture: () => structuredClone(drawn),
    beginOperation: () => ({}), endOperation: () => {},
    configure: async (patch: any) => {
      if (patch.representation === 'molecular-surface') { drawing.resolve(); await releaseDraw.promise; }
      Object.assign(drawn.inspection.appearance, patch); publication.mutation(drawn);
    },
    restore: async (scene: InspectionScene, restoreOptions: any) => {
      expect(restoreOptions).toMatchObject({ preserveCamera: true, restorePlacement: true });
      drawn = structuredClone(scene); publication.mutation(drawn);
    },
    rollbackOperation: async () => {
      rebuilding.resolve(); await releaseRollback.promise;
      if (options.rollbackFailure) throw Error('Synthetic rollback frame failed.');
      rebuilt = true; publication.mutation(drawn);
    },
  } };
  const publication = createNamedPublication((scene: InspectionScene) => publications.push(structuredClone(scene)));
  const queue: any = vm.createContext({ queue: Promise.resolve(), closing: false, busy: false, options: { onSettled: () => { throw Error('remote must hold saves'); } },
    // This renderer transaction fixture has no sequence DOM. Match the real
    // query contract (absent group => null) as well as the empty control list.
    moleculeCanvas: { style: {} }, $: () => null, $$: () => [], setStatus: () => {},
    sync: () => {
      if (options.localEditAfterRollback && rebuilt) { drawn.inspection.appearance.opacity = .7; rebuilt = false; }
      if (options.uiFailure && rebuilt) { rebuilt = false; throw Error('Synthetic UI refresh failed after rollback.'); }
    }, viewer, namedPublication: publication, interruptibleCommand });
  vm.runInContext(`${runSource}\nglobalThis.applyRemote = (${remoteSource});`, queue);
  const page: any = vm.createContext({ localInteractionSerial: 0, performance, Date, recordHeadsetEvent: () => {}, closed: false, generation: 1, panelId, dirty: false, blocked: false, loading: false, remote: false,
    isCompanion: false, beatCompletion: undefined, desktopReceiptInFlight: false, desktopReceiptBeat: undefined, PRIVATE_KEY: 'private', reloading: false, edits: 0, timer: undefined, saving: Promise.resolve(), saveAttempts: 0,
    saveRetryAdmission: createSaveRetryAdmission(),
    binding: { ...binding, sessionId: 'session' }, savedScene: structuredClone(saved), pendingReceipt: undefined, pendingReceiptFields: undefined,
    outcome: { textContent: '' }, notice: { hidden: true }, tourPlayer: undefined, panelTour: undefined,
    // Receive() clears its tour command context and reads the tour heartbeat; inert here.
    narrationGeneration: 0, tourCommandContext: undefined, tourCommandReceipt: undefined, tourHeartbeat: () => ({}), applyTourCommand: async () => { throw Error('no tour in this fixture'); },
    workspace: { viewer, capture: viewer.inspection.capture, snapshot: viewer.snapshot, applyRemote: queue.applyRemote, setStatus: () => {},
      restoreShared: async (scene: InspectionScene, admit: () => void) => {
        admit();
        if(options.rollbackFailure) throw Error('Synthetic saved-view recovery frame failed.');
        await viewer.inspection.restore(scene,{preserveCamera:true,restorePlacement:true});
      } },
    // Production save/receipt logic runs above; only platform and transport are synthetic.
    setTimeout: () => 1, clearTimeout: () => {},
    failedSourceLoad: undefined, recordLoopStage: () => {}, showOutcome: (outcome: any) => { calls.push({ outcome }); }, speakRemoteConfirmation: (_change: any, _applied: any, _narrating: any, delivery: any) => {
      expect(host.summary(binding, delivery.commandId).command).toMatchObject({ status: 'rendered' }); confirmations.push(delivery.commandId);
    },
    registerComparisonSources: async () => {}, noteNamedViews() {}, rendering: Promise.resolve(),
    inspectionFailureReceipt, waitForPanelRender, panelEntering, sameEntryScene, withWearerEdits, expected, busyBeat: async () => {},
    thrownErrorMessage: (error: Error) => error.message,
    recoverConfirmation: async (error: Error) => { calls.push({ recovery: error.message }); },
    recoverSave: (kind: string, problem: string) => { throw Error(`${kind}: ${problem}`); },
    showProblem: (problem: string) => { throw Error(problem); }, problemMessage: (_kind: string, problem: string) => problem,
    call: async (name: string, input: any) => {
      calls.push({ name, ...input });
      if (name === 'sync_inspection') {
        expect(host.hasPending(binding)).toBe(false);
        saved = structuredClone(input.scene); binding = { ...binding, inspectionRevision: binding.inspectionRevision + 1 };
        return { structuredContent: { ...binding, saved: true } };
      }
      if(name==='poll_inspection') return {structuredContent:host.poll(input,binding)};
      expect(name).toBe('complete_inspection');
      let result: any;
      if (input.phase === 'admit') result = host.admit(input, binding);
      else if (input.phase === 'settled') {
        result = host.settled(input);
        if (lostSettlement) { lostSettlement = false; throw Error('Synthetic settlement response lost.'); }
      } else {
        result = host.complete(input, binding);
        if (result.accepted) { saved = structuredClone(input.scene); binding = { ...binding, inspectionRevision: result.command.renderedRevision }; }
      }
      return { structuredContent: { ...binding, ...result } };
    },
  });
  vm.runInContext(ts.transpileModule(functions, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, page);
  const enqueue = (commandId: string, patch: any, utteranceId?: string) => host.enqueue({ ...expected(), panelId, commandId,
    ...(utteranceId ? { utteranceId } : {}), change: { kind: 'appearance', patch } }, binding, saved);
  const receive = async () => {
    const sent = { ...expected(), panelId, availability: page.dirty || page.blocked ? 'unsaved' : 'ready' };
    const delivery = (host.poll(sent as any, binding) as any).delivery;
    expect(delivery).toBeDefined();
    await page.receive(delivery, sent, 1);
  };
  return { host, page, calls, publications, confirmations, panelId, drawing, releaseDraw, rebuilding, releaseRollback, enqueue, receive,
    expected, get binding() { return binding; }, get drawn() { return drawn; }, get saved() { return saved; },
    correct: () => { now = 262; return host.controlUtterance({ ...expected(), panelId, commandId: 'correction',
      change: { kind: 'utterance', patch: { action: 'correct' } } }, binding).utterance!.utteranceId; },
  };
}

it.each([false, true])('inspector settles a completed workspace rollback with its claim token (UI failure: %s), then renders correction and third command', async uiFailure => {
  const t = fixture({ uiFailure });
  // The correction omits opacity, so this path must restore the original scene.
  t.enqueue('surface', { representation: 'molecular-surface', opacity: .5 });
  const first = t.receive(); await t.drawing.promise;
  const correction = t.correct(); t.enqueue('cartoon', { representation: 'cartoon' }, correction);
  t.releaseDraw.resolve(); await t.rebuilding.promise;
  expect(t.host.summary(t.binding).pendingCommand).toContainEqual(expect.objectContaining({ commandId: 'surface', renderFence: true }));
  expect(t.calls.some(call => call.phase === 'settled')).toBe(false);
  expect(t.publications).toEqual([]); expect(t.confirmations).toEqual([]);
  expect(t.page.remote).toBe(true);
  t.releaseRollback.resolve(); await first;
  const admitted = t.calls.find(call => call.phase === 'admit');
  expect(t.calls.find(call => call.phase === 'settled')).toMatchObject({ ...admitted, phase: 'settled' });
  expect(t.host.summary(t.binding, 'surface').command).toMatchObject({ status: 'superseded', supersededBy: correction, fenceReleased: 'rolled-back' });
  expect(t.drawn).toEqual(t.saved);
  expect(t.page.dirty).toBe(false); expect(t.page.blocked).toBe(false); expect(t.page.remote).toBe(false);
  expect(t.calls.some(call => call.name === 'sync_inspection')).toBe(false);
  await t.receive();
  t.enqueue('third', { opacity: .8 }); await t.receive();
  expect(t.confirmations).toEqual(['cartoon', 'third']);
  expect(t.drawn).toEqual(t.saved); expect(t.saved.inspection.appearance).toMatchObject({ representation: 'cartoon', opacity: .8 });
  expect(t.host.summary(t.binding).pendingCommand).toEqual([]);
});

it('inspector saves the actual scene if a local edit follows rollback before it can advertise ready', async () => {
  const t = fixture({ localEditAfterRollback: true });
  // The correction omits opacity, so this path must restore the original scene.
  t.enqueue('surface', { representation: 'molecular-surface', opacity: .5 });
  const first = t.receive(); await t.drawing.promise; t.correct();
  t.releaseDraw.resolve(); await t.rebuilding.promise; t.releaseRollback.resolve(); await first;
  expect(t.calls.filter(call => call.name === 'sync_inspection')).toHaveLength(1);
  expect(t.calls.findIndex(call => call.phase === 'settled')).toBeLessThan(t.calls.findIndex(call => call.name === 'sync_inspection'));
  expect(t.drawn).toEqual(t.saved); expect(t.saved.inspection.appearance.opacity).toBe(.7);
  expect(t.page.dirty).toBe(false); expect(t.page.blocked).toBe(false);
  t.host.poll({ ...t.expected(), panelId: t.panelId, availability: 'ready' }, t.binding);
  t.enqueue('third', { representation: 'cartoon' }); await t.receive();
  expect(t.confirmations).toEqual(['third']);
});

it('failed rollback and saved-view recovery release the fence without claiming a restored frame', async () => {
  const t = fixture({ rollbackFailure: true });
  // The correction omits opacity, so this path must restore the original scene.
  t.enqueue('surface', { representation: 'molecular-surface', opacity: .5 });
  const first = t.receive(); await t.drawing.promise; t.correct();
  t.releaseDraw.resolve(); await t.rebuilding.promise; t.releaseRollback.resolve(); await first;
  expect(t.calls.find(call => call.phase === 'settled')).toMatchObject({recoveryFailed:true});
  expect(t.host.summary(t.binding,'surface').command).toMatchObject({status:'superseded',fenceReleased:'recovery-failed'});
  expect(t.calls.find(call=>call.outcome?.reason==='recovery_failed').outcome.detail).toBe('The previous change could not be restored. Load the saved view before trying again.');
  expect(t.page.dirty).toBe(true); expect(t.page.blocked).toBe(true); expect(t.confirmations).toEqual([]);
});

it('a lost settlement response retains the same claim for retry without repeating rollback', async () => {
  const t = fixture({ lostSettlement: true });
  // The correction omits opacity, so this path must restore the original scene.
  t.enqueue('surface', { representation: 'molecular-surface', opacity: .5 });
  const first = t.receive(); await t.drawing.promise; const correction = t.correct();
  t.enqueue('cartoon', { representation: 'cartoon' }, correction);
  t.releaseDraw.resolve(); await t.rebuilding.promise; t.releaseRollback.resolve(); await first;
  const pending = t.page.pendingReceipt;
  expect(pending).toMatchObject({ commandId: 'surface', phase: 'settled' });
  await t.page.confirmReceipt(pending, []);
  expect(t.page.pendingReceipt).toBeUndefined();
  expect(t.calls.filter(call => call.phase === 'settled')).toEqual([expect.objectContaining(pending), expect.objectContaining(pending)]);
  await t.receive(); t.enqueue('third', { opacity: .8 }); await t.receive();
  expect(t.confirmations).toEqual(['cartoon', 'third']); expect(t.drawn).toEqual(t.saved);
});

it.each(['serverEpoch', 'sourceToken'] as const)('rotation of %s releases old fences and refuses old admission in the new scene', field => {
  const t = fixture();
  // The correction omits opacity, so this path must restore the original scene.
  t.enqueue('surface', { representation: 'molecular-surface', opacity: .5 });
  const old = (t.host.poll({ ...t.expected(), panelId: t.panelId, availability: 'ready' }, t.binding) as any).delivery;
  const claim = { ...t.expected(), panelId: t.panelId, commandId: old.commandId, claimToken: old.claimToken };
  expect(t.host.admit(claim, t.binding).admitted).toBe(true);
  t.correct(); t.enqueue('cartoon', { representation: 'cartoon' });
  const rotated = { ...t.binding, [field]: 'rotated' };
  expect(t.host.summary(rotated, 'surface').command).toMatchObject({ status: 'superseded', fenceReleased: 'panel-lost' });
  expect(t.host.hasPending(rotated)).toBe(false);
  expect(t.host.admit(claim, rotated).admitted).toBe(false);
  const expected = { ...t.expected(), [field]: 'rotated' };
  const panelId = t.host.attach({ ...expected, surface: 'companion' }, rotated);
  t.host.enqueue({ ...expected, panelId, commandId: 'third', change: { kind: 'appearance', patch: { opacity: .8 } } }, rotated, t.saved);
  const third = (t.host.poll({ ...expected, panelId, availability: 'ready' }, rotated) as any).delivery;
  const scene = structuredClone(t.saved); scene.inspection.appearance.opacity = .8;
  expect(t.host.complete({ ...expected, panelId, ...third, scene }, rotated)).toMatchObject({ accepted: true, command: { status: 'rendered' } });
  expect(t.host.complete({ ...claim, scene }, rotated)).toMatchObject({ accepted: false, command: { status: 'superseded' } });
});


it.each(['presenting', '2d', 'slow-19s'])('entry command waits for %s before admission, then draws and saves once', async route => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(2407); // Recorded driver time when the command was sent.
    const t = fixture({clock:()=>Date.now()});
    let presenting = false, drawCount = 10;
    const startup = { phase: 'requesting-headset', pending: true };
    t.page.workspace.viewer.xr = { startup: () => startup };
    t.page.workspace.snapshot = () => ({ ready: true, xrPresenting: presenting, drawCount });
    let applies = 0;
    t.page.applyTourCommand = async () => { applies++; drawCount++; return {}; };
    t.host.enqueue({ ...t.expected(), panelId: t.panelId, commandId: 'entry-tour',
      change: { kind: 'tour', patch: { action: 'start', tourId: 'flipbook', narration: false, autoplay: false } } }, t.binding, t.saved);
    const pending = t.receive();
    // The device sent at 2.407 s while requesting-headset, despite ready:true.
    await vi.advanceTimersByTimeAsync(route === 'slow-19s' ? 18900 : 1407);
    expect(applies).toBe(0);
    expect(t.calls.some(c => c.phase === 'admit')).toBe(false);
    if (route !== '2d') { presenting = true; startup.phase = 'preparing-menu'; } // First presentation at 3814 ms.
    else { drawCount++; startup.phase = 'idle'; startup.pending = false; }
    await vi.advanceTimersByTimeAsync(50);
    if(route!=='2d') expect(applies).toBe(0);
    startup.phase = 'active'; startup.pending = false;
    await vi.advanceTimersByTimeAsync(50); await pending;
    await vi.advanceTimersByTimeAsync(612); // Stable VR at 4476 ms must not replay the command.
    expect(applies).toBe(1);
    expect(t.host.summary(t.binding, 'entry-tour').command).toMatchObject({ status: 'rendered' });
    expect(t.confirmations).toEqual(['entry-tour']);
  } finally { vi.useRealTimers(); }
});

// Execute the viewer input boundaries and actual Reset; only seating/render I/O
// is synthetic. This catches a missing callback rather than incrementing the
// inspector serial in the test itself.
function wearerActions(page: any) {
  const source = readFileSync(new URL('../../lab/browser-roundtrip/viewer.mjs', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('viewer.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const h: any = vm.createContext({
    onLocalEdit: () => page.localInteractionSerial++,
    onInteraction: () => page.localInteractionSerial++, inspectionState: undefined,
    placementViewWaiters: new Set(),
    immersiveSession: { refreshToolbar: async () => {}, toolbarAction: async () => {} },
    talkCaption: { set() {} }, xrManipulation: { phase: () => 'idle' },
    seatStructureForEntry: async () => ({}), menuResetActions: () => [{kind: 'recenter-menu'}],
    recordManipulation() {}, showHeadsetCaption() {},
    spatialInputOwners: new Set(), spatialOwnedHands: new Set(),
  });
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'signalManualInteraction')
      h.signalManualInteraction = vm.runInContext('('+node.initializer!.getText(ast)+')',h);
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'runFaceAction')
      vm.runInContext(node.getText(ast),h);
    if (ts.isPropertyAssignment(node) && ['onSpatialActionIntent','onConsumeSpatialSelect'].includes(node.name.getText(ast)))
      h[node.name.getText(ast)] = vm.runInContext('('+node.initializer.getText(ast)+')',h);
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'createXrButtons') {
      const props = (node.arguments[0] as ts.ObjectLiteralExpression).properties;
      const run = props.find(p => ts.isPropertyAssignment(p) && p.name.getText(ast) === 'run') as ts.PropertyAssignment;
      h.face = vm.runInContext('('+run.initializer.getText(ast)+')',h);
    }
    ts.forEachChild(node,visit);
  }
  visit(ast);
  h.immersiveSession.toolbarAction = (action: any) => h.onSpatialActionIntent(action,{origin:'programmatic'});
  return h;
}

// Run the real inspector receive/save/receipt functions against the host queue.
it.each(['entry', 'remote-reset', 'reset-face', 'reset-menu', 'face-menu', 'menu-action', 'menu-grab', 'drag', 'edit', 'edit-undone', 'source'])(
  'entry placement/capture save race preserves admission and real conflicts: %s', async change => {
  vi.useFakeTimers();
  try {
    const t = fixture(); let presenting = false, applies = 0;
    const wearer = wearerActions(t.page);
    const allowed = change === 'entry' || change === 'remote-reset';
    const startup = {phase:'requesting-headset', pending:true};
    t.page.workspace.viewer.xr = {startup:()=>startup};
    t.page.workspace.snapshot = () => ({ready:true, xrPresenting:presenting, drawCount:10});
    t.page.applyTourCommand = async () => { applies++; return {}; };
    t.host.enqueue({...t.expected(), panelId:t.panelId, commandId:'entry-race',
      change:{kind:'tour',patch:{action:'start',tourId:'custom',autoplay:true,narration:false}}},t.binding,t.saved);
    const pending=t.receive();
    await vi.advanceTimersByTimeAsync(50);
    presenting=true; startup.phase='preparing-menu';
    t.drawn.inspection.placement.scale=1.7;
    t.drawn.camera.position=[1,2,3];
    t.page.scheduleSave(); await t.page.save();
    expect(t.calls.some(c=>c.name==='sync_inspection')).toBe(false);
    if(change==='reset-face') {
      const reset=wearer.face('recenter-structure',undefined,'hold');
      expect(t.page.localInteractionSerial).toBeGreaterThan(0); // before async Reset completes
      await reset;
    }
    if(change==='reset-menu') { wearer.onSpatialActionIntent(); await wearer.runFaceAction('recenter-structure'); }
    if(change==='remote-reset') await wearer.runFaceAction('recenter-structure');
    if(change==='face-menu') await wearer.face('menu');
    if(change==='menu-action') wearer.onSpatialActionIntent();
    if(change==='menu-grab') wearer.onConsumeSpatialSelect({inputSource:{handedness:'left'},phase:'start'});
    if(change==='drag' || change==='edit-undone') wearer.signalManualInteraction('xr-grab');
    if(change==='edit') t.drawn.inspection.appearance.opacity=.4;
    if(change==='source') t.page.binding.sourceToken='other';
    await vi.advanceTimersByTimeAsync(400);
    expect(applies).toBe(0);
    startup.phase='active'; startup.pending=false;
    await vi.advanceTimersByTimeAsync(50); await pending;
    expect(applies).toBe(allowed?1:0);
    expect(t.host.summary(t.binding,'entry-race').command).toMatchObject(
      allowed?{status:'rendered'}:{status:'rejected',reason:'local_changed'});
    if(allowed) {
      expect(t.saved.inspection.placement.scale).toBe(1.7);
      expect(t.saved.camera.position).toEqual([1,2,3]);
      expect(t.calls.filter(c=>c.phase==='admit')).toHaveLength(1);
      expect(t.confirmations).toEqual(['entry-race']);
    }
  } finally { vi.useRealTimers(); }
});

// A lesson start is all or nothing: the real receive() against the host queue,
// with a synthetic lesson player, clock and renderer.
const reloadSource = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'reloadSavedScene')!.getText(ast);
function lessonStart(options: { clock: 'ticks' | 'stuck'; fail?: boolean; restoreFails?: boolean; companion?: boolean; entry?: boolean }) {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const t = fixture({ clock: () => Date.now() });
  const walk = { id: 'walk-1', title: 'Walk', animation: { version: 1, durationSeconds: 10, playback: { autoplay: true, loop: true }, tracks: [] } };
  const lesson = { id: 'walk', title: 'Walk', summary: '', steps: [walk] };
  let draws = 10, animation: any = null, ticking = false, presenting = !options.entry;
  const startup = { phase: options.entry ? 'requesting-headset' : 'active', pending: Boolean(options.entry) };
  const frames = setInterval(() => { draws++; if (animation && ticking) animation = { ...animation, timeSeconds: animation.timeSeconds + .016 }; }, 16);
  const player = { pause: vi.fn(), restorePlayback: vi.fn(), getState: () => ({ selectedId: 'walk', step: 0, active: true, navigating: false, tours: [] }) };
  const hydrate = vi.fn(async (_id: string, _provided: any, _journey: any, hydrateOptions: any) => {
    expect(hydrateOptions).toMatchObject({ restoreExactScene: true });
    await t.page.workspace.viewer.inspection.restore(t.saved, { preserveCamera: true, restorePlacement: true });
  });
  const end = vi.fn();
  // The page's errors are this realm's, so the receipt reads their sentences.
  Object.assign(t.page, { Error, setTimeout, lastLocalEditAt: -Infinity, TOURS: [], installedLesson: lesson, isCompanion: options.companion === true, hydrate,
    panelTour: { matchesLoadedSource: false, current: () => player, getState: player.getState, pause: vi.fn() },
    applyTourCommand: async () => {
      t.calls.push({ drawn: true });
      t.drawn.inspection.appearance.representation = 'cartoon';
      animation = { id: 'clip', chapterId: 'walk-1', state: 'playing', timeSeconds: 0, durationSeconds: 10, loop: true, speed: 1 };
      ticking = options.clock === 'ticks';
      if (options.fail) throw Object.assign(Error('This lesson scene’s molecular animation did not finish within 40 seconds.'), { rollback: 'failed' });
      return { started: true };
    } });
  vm.runInContext(ts.transpileModule(reloadSource, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, t.page);
  t.page.workspace.viewer.xr = { startup: () => startup, end };
  t.page.workspace.snapshot = () => ({ ready: true, xrPresenting: presenting, interactionActive: false, drawCount: draws, animation, status: 'ready' });
  const shared = t.page.workspace.restoreShared;
  t.page.workspace.restoreShared = async (scene: any, admit: () => void, ...rest: any[]) => {
    if (options.restoreFails) throw Error('Synthetic restore failure.');
    await shared(scene, admit, ...rest); await rest[2]?.(scene); t.calls.push({ restored: true });
  };
  t.host.enqueue({ ...t.expected(), panelId: t.panelId, commandId: 'start',
    change: { kind: 'tour', patch: { action: 'start', tourId: 'walk' } } }, t.binding, t.saved);
  const before = structuredClone(t.saved);
  const enter = () => { presenting = true; startup.phase = 'active'; startup.pending = false; };
  const failure = () => t.calls.findIndex(call => call.failure);
  return { t, player, hydrate, end, before, startup, enter, failure, stop: () => { clearInterval(frames); vi.useRealTimers(); } };
}
// The next beat's autosave rule: a clean panel that shows its saved scene saves nothing.
const beatWouldSave = (t: ReturnType<typeof fixture>) => t.page.dirty || JSON.stringify(t.page.workspace.capture()) !== JSON.stringify(t.page.savedScene);

it('a start that fails after its chapter drew puts the saved scene back, stops the player, then refuses', async () => {
  const s = lessonStart({ clock: 'ticks', fail: true });
  try {
    await s.t.receive();
    expect(s.t.drawn).toEqual(s.before);
    expect(s.player.pause).toHaveBeenCalled(); expect(s.player.restorePlayback).toHaveBeenCalledWith(s.before);
    const restored = s.t.calls.findIndex(call => call.restored);
    expect(restored).toBeGreaterThan(s.t.calls.findIndex(call => call.drawn)); expect(restored).toBeLessThan(s.failure());
    expect(s.t.host.summary(s.t.binding, 'start').command).toMatchObject({ status: 'rejected', reason: 'render_failed' });
    expect(s.t.page.remote).toBe(false); expect(beatWouldSave(s.t)).toBe(false);
    expect(s.t.calls.some(call => call.name === 'sync_inspection')).toBe(false);
  } finally { s.stop(); }
});

it('a chapter whose animation never ticks is refused and its scene put back', async () => {
  const s = lessonStart({ clock: 'stuck' });
  const diagnostics: any[] = [];
  s.t.page.recordHeadsetEvent = (kind: string, detail: unknown) => diagnostics.push({ kind, detail });
  const snapshot = s.t.page.workspace.snapshot;
  s.t.page.workspace.snapshot = () => ({ ...snapshot(),
    animationActivity: { ready: true, suspended: false, halted: false, canTick: true, immersive: true,
      scheduled: false, frameSamples: 0, lastFrameTimestampMs: null, faulted: false } });
  try {
    const pending = s.t.receive();
    await vi.advanceTimersByTimeAsync(2900);
    expect(s.failure()).toBe(-1);
    await vi.advanceTimersByTimeAsync(300); await pending;
    expect(s.t.calls[s.failure()].failureReason).toBe('The "Walk" animation was drawn but its clock did not advance.');
    expect(s.t.drawn).toEqual(s.before); expect(s.t.confirmations).toEqual([]);
    expect(beatWouldSave(s.t)).toBe(false);
    expect(diagnostics.find(entry => entry.kind === 'animation-clock-stalled')).toMatchObject({ detail: {
      chapterId: 'walk-1', presenting: true, status: 'ready',
      animation: { state: 'playing', timeSeconds: 0 },
      activity: { frameSamples: 0, canTick: true, suspended: false, halted: false },
    } });
  } finally { s.stop(); }
});

it('a healthy start is confirmed only once its clock has advanced', async () => {
  const s = lessonStart({ clock: 'ticks' });
  try {
    const pending = s.t.receive();
    await vi.advanceTimersByTimeAsync(100); await pending;
    expect(s.t.confirmations).toEqual(['start']);
    const receipt = s.t.calls.find(call => call.name === 'complete_inspection' && call.scene);
    expect(receipt.animation).toMatchObject({ chapterId: 'walk-1', state: 'playing' });
    expect(receipt.animation.timeSeconds).toBeGreaterThan(0);
    expect(s.t.saved.inspection.appearance.representation).toBe('cartoon');
  } finally { s.stop(); }
});

it('a headset that cannot put the scene back reloads the saved scene and saves nothing', async () => {
  const s = lessonStart({ clock: 'ticks', fail: true, restoreFails: true, companion: true });
  try {
    await s.t.receive();
    expect(s.t.page.dirty).toBe(false);
    expect(s.t.host.summary(s.t.binding, 'start').command).toMatchObject({ status: 'rejected' });
    await s.t.page.rendering;
    expect(s.hydrate).toHaveBeenCalledTimes(1); expect(s.t.page.reloading).toBe(false);
    expect(s.t.drawn).toEqual(s.before);
    expect(s.t.calls.some(call => call.name === 'sync_inspection')).toBe(false);
  } finally { s.stop(); }
});

it('a start sent during VR entry renders after entry on the entry seat with its clock ticking', async () => {
  const s = lessonStart({ clock: 'ticks', entry: true });
  try {
    const pending = s.t.receive();
    await vi.advanceTimersByTimeAsync(400);
    s.t.drawn.inspection.placement.scale = 1.7; // The entry seat.
    await vi.advanceTimersByTimeAsync(400);
    expect(s.t.calls.some(call => call.drawn)).toBe(false);
    s.enter(); await vi.advanceTimersByTimeAsync(200); await pending;
    expect(s.t.confirmations).toEqual(['start']);
    expect(s.t.saved.inspection.placement.scale).toBe(1.7);
    expect(s.t.calls.find(call => call.scene)?.animation.timeSeconds).toBeGreaterThan(0);
  } finally { s.stop(); }
});

it('a start that fails right after entry puts back the entry-seated scene and leaves the session in VR', async () => {
  const s = lessonStart({ clock: 'stuck', entry: true });
  try {
    const pending = s.t.receive();
    await vi.advanceTimersByTimeAsync(400);
    s.t.drawn.inspection.placement.scale = 1.7;
    s.enter(); await vi.advanceTimersByTimeAsync(4000); await pending;
    expect(s.failure()).toBeGreaterThan(s.t.calls.findIndex(call => call.restored));
    expect(s.t.drawn.inspection.placement.scale).toBe(1.7);
    expect(s.t.drawn.inspection.appearance.representation).toBe(s.before.inspection.appearance.representation);
    expect(s.end).not.toHaveBeenCalled(); expect(s.startup.phase).toBe('active');
    // Only the entry seat is left to save, which is placement, not the lesson.
    expect(sameEntryScene(s.t.page.savedScene, s.t.drawn)).toBe(true);
  } finally { s.stop(); }
});
