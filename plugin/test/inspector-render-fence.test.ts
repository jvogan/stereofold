import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { createSaveRetryAdmission } from '../src/inspection-save-retry.js';
import { InspectionCommands, type InspectionBinding } from '../src/inspection-commands.js';
import type { InspectionScene } from '../src/inspection-contract.js';
import { inspectionFailureReceipt } from '../src/inspection-failure-receipt.js';
// @ts-expect-error Shared production browser transaction.
import { interruptibleCommand } from '../../lab/inspection/interruptible-command.mjs';
// @ts-expect-error Shared production browser publication guard.
import { createNamedPublication } from '../../lab/inspection/named-publication.mjs';

const inspector = readFileSync(new URL('../src/inspector.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('inspector.ts', inspector, ts.ScriptTarget.Latest, true);
const names = ['receive', 'confirmReceipt', 'save', 'scheduleSave'];
const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? ''))
  .map(node => node.getText(ast)).join('\n');
for (const name of names) expect(functions).toContain(`function ${name}`);
const workspace = readFileSync(new URL('../../lab/inspection/workspace.mjs', import.meta.url), 'utf8');
const runSource = workspace.slice(workspace.indexOf('function run('), workspace.indexOf('\nfunction ui('));
const remoteSource = workspace.slice(workspace.indexOf('  applyRemote:') + '  applyRemote:'.length, workspace.lastIndexOf('\n});')).trim().replace(/,$/, '');
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

function fixture(options: { uiFailure?: boolean; rollbackFailure?: boolean; localEditAfterRollback?: boolean; lostSettlement?: boolean } = {}) {
  let now = 0;
  const host = new InspectionCommands(() => now);
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
    moleculeCanvas: { style: {} }, $$: () => [], setStatus: () => {},
    sync: () => {
      if (options.localEditAfterRollback && rebuilt) { drawn.inspection.appearance.opacity = .7; rebuilt = false; }
      if (options.uiFailure && rebuilt) { rebuilt = false; throw Error('Synthetic UI refresh failed after rollback.'); }
    }, viewer, namedPublication: publication, interruptibleCommand });
  vm.runInContext(`${runSource}\nglobalThis.applyRemote = (${remoteSource});`, queue);
  const page: any = vm.createContext({ closed: false, generation: 1, panelId, dirty: false, blocked: false, loading: false, remote: false,
    isCompanion: false, PRIVATE_KEY: 'private', reloading: false, edits: 0, timer: undefined, saving: Promise.resolve(), saveAttempts: 0,
    saveRetryAdmission: createSaveRetryAdmission(),
    binding: { ...binding, sessionId: 'session' }, savedScene: structuredClone(saved), pendingReceipt: undefined, pendingReceiptFields: undefined,
    outcome: { textContent: '' }, notice: { hidden: true }, tourPlayer: undefined, panelTour: undefined,
    // Receive() clears its tour command context and reads the tour heartbeat; inert here.
    tourCommandContext: undefined, tourCommandReceipt: undefined, tourHeartbeat: () => ({}), applyTourCommand: async () => { throw Error('no tour in this fixture'); },
    workspace: { capture: viewer.inspection.capture, snapshot: viewer.snapshot, applyRemote: queue.applyRemote, setStatus: () => {},
      restoreShared: async (scene: InspectionScene, admit: () => void) => {
        admit();
        if(options.rollbackFailure) throw Error('Synthetic saved-view recovery frame failed.');
        await viewer.inspection.restore(scene,{preserveCamera:true,restorePlacement:true});
      } },
    // Production save/receipt logic runs above; only platform and transport are synthetic.
    setTimeout: () => 1, clearTimeout: () => {},
    recordLoopStage: () => {}, showOutcome: (outcome: any) => { calls.push({ outcome }); }, speakRemoteConfirmation: (_change: any, _applied: any, _narrating: any, delivery: any) => {
      expect(host.summary(binding, delivery.commandId).command).toMatchObject({ status: 'rendered' }); confirmations.push(delivery.commandId);
    },
    inspectionFailureReceipt,
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
