import { createPollBackoff } from '../src/inspection-poll-backoff.js';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSaveRetryAdmission } from '../src/inspection-save-retry.js';
import { saveFailureRecovery } from '../src/inspection-panel-recovery.js';
import { inspectionFailureReceipt } from '../src/inspection-failure-receipt.js';
import { panelEntering, sameEntryScene, waitForPanelRender, withWearerEdits } from '../src/inspection-render-settle.js';
import { movedBy, sharedPanelSession } from './helpers/shared-panel-session.js';

const source = readFileSync(new URL('../src/inspector.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('inspector.ts', source, ts.ScriptTarget.Latest, true);
const names = ['scheduleSave', 'recoverSave', 'save', 'poll', 'clearConnectionProblem'];
const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? ''))
  .map(node => node.getText(ast)).join('\n');
afterEach(() => vi.useRealTimers());

/** Real page save/poll functions; only rendering, HTTP and DOM boundaries are adapted. */
function page() {
  vi.useFakeTimers(); vi.setSystemTime(0);
  let scene = { sourceSha256: 'a'.repeat(64), inspection: { placement: { scale: 4.66 } } };
  const captures: number[] = [], posts: { at: number; args: any }[] = [];
  let fail = true;
  const h: any = vm.createContext({
    failedSourceLoad: undefined, pollBackoff: createPollBackoff(() => Date.now(), () => 0.5),
    Date, Promise, JSON, Math, setTimeout, clearTimeout,
    saveRetryAdmission: createSaveRetryAdmission(), saveFailureRecovery,
    loading: false, remote: false, closed: false, reloading: false, dirty: true, blocked: false,
    generation: 1, edits: 1, timer: undefined, saveAttempts: 0, lastAutoReload: 0,
    binding: { sessionId: 'session', serverEpoch: 'epoch', sourceToken: 'source', stateRevision: 1, inspectionRevision: 1 },
    savedScene: structuredClone(scene), saving: Promise.resolve(), rendering: Promise.resolve(),
    isCompanion: true, experiencePreparing: false, pollInFlight: false, panelId: 'panel', repairNeeded: false,
    pendingReceipt: undefined, tourPlayer: undefined, panelTour: undefined, experienceView: undefined,
    connectionRecoveryLine: '', connectionNotice: false, connectionWatchdog: undefined,
    outcome: {}, notice: {}, retry: {}, reload: {}, pairAgain: {},
    document: { visibilityState: 'visible' }, globalThis: {},
    workspace: { snapshot: () => ({ ready: true, interactionActive: false, xrPresenting: true }),
      capture: () => { captures.push(Date.now()); return structuredClone(scene); },
      // Internal comparison serializes the same history-free scene without a
      // public detached capture; the counter measures actual save captures.
      serializeCapture: () => JSON.stringify(scene),
      syncSceneHistory() {}, setStatus() {}, viewer: { xr: {} } },
    recordHeadsetEvent() {}, thrownErrorMessage: (error: Error) => error.message,
    showProblem: () => { throw Error('Should retain offline work without blocking'); }, problemMessage: (_kind: string, problem: string) => problem,
    armPoll() {}, syncHandoff() {}, expected: () => h.binding, liveAvailability: () => 'unsaved',
    tourHeartbeat: () => ({}), xrStartupReport: () => ({}), isRendererHeartbeatFailure: () => false,
    showConnectionProblem: () => { h.connectionRecoveryLine = 'Disconnected'; return true; }, retireStaleHud() {}, setConnectionStatus() {},
    call: async (name: string, args: any) => {
      if (name === 'sync_inspection') {
        // Exercise the transport's serialization cost as well as capture.
        posts.push({ at: Date.now(), args: JSON.parse(JSON.stringify(args)) });
        if (fail) throw Object.assign(Error('Link lost'), { code: 'companion_connection' });
        return { structuredContent: { saved: true, inspectionRevision: 2 } };
      }
      throw Object.assign(Error('Link lost'), { code: 'companion_connection' });
    },
  });
  vm.runInContext(ts.transpileModule(functions, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, h);
  return { h, posts, captures, edit(scale: number) { scene.inspection.placement.scale = scale; h.scheduleSave(); },
    recover() { fail = false; h.clearConnectionProblem(); }, succeed() { fail = false; } };
}

it('fast connection failures cannot recapture and post each 250 ms poll; later edits remain dirty', async () => {
  const p = page();
  await p.h.poll();
  expect(p.posts.map(x => x.at)).toEqual([0]);
  for (let i = 1; i < 4; i++) {
    await vi.advanceTimersByTimeAsync(250); await p.h.poll();
    if (i === 1) p.edit(5.93);
  }
  expect(p.posts).toHaveLength(1); expect(p.captures).toHaveLength(1);
  expect(p.h.dirty).toBe(true); expect(p.h.blocked).toBe(false);
  await vi.advanceTimersByTimeAsync(250); await p.h.poll();
  expect(p.posts.map(x => x.at)).toEqual([0, 1000]);
  expect(p.posts[1]!.args.scene.inspection.placement.scale).toBe(5.93);
  // The second failure waits two seconds even though the poll keeps beating.
  for (let i = 0; i < 7; i++) { await vi.advanceTimersByTimeAsync(250); await p.h.poll(); }
  expect(p.posts).toHaveLength(2);
  p.succeed(); await vi.advanceTimersByTimeAsync(250);
  expect(p.posts.map(x => x.at)).toEqual([0, 1000, 3000]); expect(p.h.dirty).toBe(false);
});

it('a valid reconnect clears the cooldown once and saves the latest retained edit', async () => {
  const p = page(); await p.h.poll(); p.edit(5.93);
  await vi.advanceTimersByTimeAsync(250);
  p.recover(); await p.h.save(undefined, true);
  expect(p.posts.map(x => x.at)).toEqual([0, 250]);
  expect(p.posts[1]!.args.scene.inspection.placement.scale).toBe(5.93);
  expect(p.h.dirty).toBe(false); expect(p.h.saveAttempts).toBe(0);
  // A normal healthy heartbeat must not erase an unrelated save cooldown.
  p.h.saveRetryAdmission.defer(p.h.binding, p.h.generation, 8000);
  p.h.clearConnectionProblem();
  expect(p.h.saveRetryAdmission.delay(p.h.binding, p.h.generation)).toBe(8000);
});

it('an explicit Retry bypasses the deadline without weakening the binding sent to the host', async () => {
  const p = page(); await p.h.poll(); p.succeed();
  await p.h.save();
  expect(p.posts).toHaveLength(2);
  expect(p.posts[1]!.args).toMatchObject({ sourceToken: 'source', serverEpoch: 'epoch', baseStateRevision: 1, baseInspectionRevision: 1 });
  expect(p.h.dirty).toBe(false);
});

it.each(['sourceToken', 'sessionId', 'serverEpoch', 'generation'])('a changed %s does not inherit a failed old save cooldown', async field => {
  const p = page(); await p.h.poll(); p.succeed();
  if (field === 'generation') p.h.generation++;
  else p.h.binding = { ...p.h.binding, [field]: 'new' };
  await p.h.save(undefined, true);
  expect(p.posts).toHaveLength(2); expect(p.h.dirty).toBe(false);
});

it('a save queued before another failure rechecks admission before capture', async () => {
  const p = page();
  await Promise.all([p.h.save(undefined, true), p.h.save(undefined, true)]);
  expect(p.posts).toHaveLength(1); expect(p.captures).toHaveLength(1); expect(p.h.dirty).toBe(true);
});

it('the first settled local edit still saves after the ordinary 250 ms debounce', async () => {
  const p = page(); p.h.dirty = false; p.edit(5.93); p.succeed();
  await vi.advanceTimersByTimeAsync(249); expect(p.posts).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(1);
  expect(p.posts.map(x => x.at)).toEqual([250]); expect(p.h.dirty).toBe(false);
});

it('an awaited journey save during cooldown really commits its scoped claim', async () => {
  const p = page(); await p.h.poll(); p.succeed();
  const claim = { panelId: 'panel', navigationId: 'navigation' };
  await p.h.save(claim);
  expect(p.posts).toHaveLength(2); expect(p.posts[1]!.args.journeySave).toEqual(claim);
  expect(p.h.dirty).toBe(false);
});

it('a mandatory experience save during cooldown fails truthfully rather than resolving unsaved', async () => {
  const p = page(); await p.h.poll(); p.h.experiencePreparing = true;
  await expect(p.h.save()).rejects.toThrow('Could not save your work');
  expect(p.posts).toHaveLength(2); expect(p.h.dirty).toBe(true);
  expect(p.h.blocked).toBe(false);
});

it('an awaited non-journey scene checkpoint also commits during cooldown', async () => {
  const p = page(); await p.h.poll(); p.edit(5.93); p.succeed();
  await p.h.save();
  expect(p.posts).toHaveLength(2); expect(p.h.dirty).toBe(false);
});

/**
 * The wearer's placement save against a command that carries its own binding.
 *
 * In a session shared with a headset the host used to refuse every page save
 * as `busy` while any bound command waited, so the page kept its seat or grab
 * unsaved, reported `unsaved`, and the command conflicted. A save that moves
 * only the structure and the camera now commits, and the command follows it.
 */
describe('a placement save while a bound command waits', () => {
  type Live = Awaited<ReturnType<typeof sharedPanelSession>>;
  const send = async (live: Live, tool: string, args: Record<string, unknown>) => {
    const answer = await live.call(tool, { sessionId: live.sessionId, ...live.binding, panelId: live.panelId, ...args });
    expect(answer.isError, JSON.stringify(answer.content)).not.toBe(true);
    return answer.structuredContent.command as { commandId: string; status: string };
  };
  const edits = {
    'an explicit appearance edit': { tool: 'update_inspection', args: { commandId: 'opacity', change: { kind: 'appearance', patch: { opacity: .6 } } },
      draw: (scene: any) => { scene.inspection.appearance.opacity = .6; return scene; } },
    'an explicit tour start': { tool: 'control_tour', args: { commandId: 'start', action: 'start', autoplay: false, narration: false },
      draw: (scene: any) => scene },
  };

  it.each(Object.entries(edits))('commits under %s, which follows it to the panel', async (_name, edit) => {
    const live = await sharedPanelSession();
    try {
      await live.beat('ready');
      const tourId = (await live.state()).tours[0].id;
      const queued = await send(live, edit.tool, edit.tool === 'control_tour' ? { ...edit.args, tourId } : edit.args);
      expect(queued.status).toBe('queued');
      await live.beat('busy');
      const before = live.binding, moved = movedBy(live.saved);
      expect(await live.save(moved)).toMatchObject({ saved: true });
      expect(await live.beat('busy', before)).toBeUndefined();
      expect((await live.state(queued.commandId)).command).toMatchObject({ status: 'queued', heldForPanel: true });
      const delivery = await live.beat('ready');
      expect(delivery).toMatchObject({ commandId: queued.commandId, deferLocalSave: false });
      expect((await live.complete(delivery, edit.draw(structuredClone(moved)))).command.status).toBe('rendered');
      expect(live.saved.inspection.placement).toEqual(moved.inspection.placement);
    } finally { await live.close(); }
  });

  it('refuses a scientific save as busy, and the unsaved beat then conflicts the command', async () => {
    const live = await sharedPanelSession();
    try {
      await live.beat('ready');
      const queued = await send(live, 'update_inspection', edits['an explicit appearance edit'].args);
      const edited = live.saved; edited.selectionKeys = [];
      expect(await live.save(edited)).toMatchObject({ busy: true });
      await live.beat('unsaved');
      expect((await live.state(queued.commandId)).command).toMatchObject({ status: 'conflict',
        reason: 'The target panel has newer or unsaved local work.' });
    } finally { await live.close(); }
  });

  it('conflicts a placement change the wearer’s own rescale overtook, and says why', async () => {
    const live = await sharedPanelSession();
    try {
      await live.beat('ready');
      const queued = await send(live, 'update_inspection', { commandId: 'bigger', change: { kind: 'placement', patch: { scale: 2 } } });
      expect(await live.save(movedBy(live.saved))).toMatchObject({ saved: true });
      expect((await live.state(queued.commandId)).command).toMatchObject({ status: 'conflict',
        reason: expect.stringContaining('The wearer moved the structure while this command waited') });
    } finally { await live.close(); }
  });

  it('hands a delivered bound command back while the page saves its placement, then delivers it again', async () => {
    const live = await sharedPanelSession();
    try {
      await live.beat('ready');
      const queued = await send(live, 'update_inspection', edits['an explicit appearance edit'].args);
      const first = await live.beat('ready');
      expect(first?.commandId).toBe(queued.commandId);
      const handed = await live.call('complete_inspection', { sessionId: live.sessionId, ...live.binding, panelId: live.panelId,
        commandId: first.commandId, claimToken: first.claimToken, phase: 'defer-local-save' });
      expect(handed.structuredContent).toMatchObject({ deferred: true, command: { status: 'queued' } });
      const moved = movedBy(live.saved);
      expect(await live.save(moved)).toMatchObject({ saved: true });
      const again = await live.beat('ready');
      expect(again).toMatchObject({ commandId: queued.commandId });
      expect(again.claimToken).not.toBe(first.claimToken);
      const drawn = structuredClone(moved); drawn.inspection.appearance.opacity = .6;
      expect((await live.complete(again, drawn)).command.status).toBe('rendered');
    } finally { await live.close(); }
  });

  it('keeps a voice command bound to words begun before the wearer moved the structure', async () => {
    const live = await sharedPanelSession();
    try {
      await live.beat('ready');
      const begun = await live.call('update_inspection', { sessionId: live.sessionId, ...live.binding, panelId: live.panelId,
        commandId: 'words', change: { kind: 'utterance', patch: { action: 'begin' } } });
      const utteranceId = begun.structuredContent.lifecycle.utterance.utteranceId as string;
      const queued = await send(live, 'update_inspection', { commandId: 'spoken', utteranceId,
        change: { kind: 'appearance', patch: { opacity: .6 } } });
      const moved = movedBy(live.saved);
      expect(await live.save(moved)).toMatchObject({ saved: true });
      const delivery = await live.beat('ready');
      expect(delivery).toMatchObject({ commandId: queued.commandId, utteranceId });
      const drawn = structuredClone(moved); drawn.inspection.appearance.opacity = .6;
      expect((await live.complete(delivery, drawn)).command.status).toBe('rendered');
    } finally { await live.close(); }
  });
});

const receiveSource = ast.statements.find((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === 'receive')!.getText(ast);

/**
 * The real page `receive()` for one delivered tour start. The host, renderer
 * and tour player are synthetic; the waits, the deferral and the admission
 * checks are the production ones.
 */
function receiver(options: { deferLocalSave?: boolean; player?: boolean } = {}) {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const saved = { sourceSha256: 'a'.repeat(64), camera: { position: [0, 0, 10] },
    inspection: { appearance: { opacity: 1 }, placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } } };
  const state = { held: false, drawn: structuredClone(saved) as any, applies: 0, saves: 0, restores: 0, during: undefined as undefined | (() => void),
    chapter: undefined as undefined | (() => void), drawnScene: undefined as undefined | { scene: any; serial: number } };
  // The lesson player, which records what its last action left on screen.
  const player = { pause() {}, restorePlayback() {}, drawnScene: () => state.drawnScene };
  const calls: string[] = [], receipts: any[] = [];
  const h: any = vm.createContext({
    // The page's errors are this realm's, so `inspectionFailureReceipt` reads their sentences.
    performance, Date, Error, localInteractionSerial: 0, lastLocalEditAt: -Infinity,
    panelEntering, sameEntryScene, waitForPanelRender, withWearerEdits, inspectionFailureReceipt,
    closed: false, generation: 1, panelId: 'panel', dirty: false, blocked: false, loading: false, remote: false,
    binding: { sessionId: 'session', serverEpoch: 'epoch', sourceToken: 'source', stateRevision: 1, inspectionRevision: 1 },
    savedScene: structuredClone(saved), pendingReceipt: undefined, outcome: { textContent: '' }, notice: { hidden: true },
    panelTour: options.player ? { matchesLoadedSource: false, current: () => player, pause() {},
      getState: () => ({ active: false, navigating: false, step: -1 }) } : undefined,
    narrationGeneration: 0, tourCommandContext: undefined, tourCommandReceipt: undefined,
    workspace: { viewer: { xr: { startup: () => ({ phase: 'active', pending: false }) } },
      snapshot: () => ({ ready: true, xrPresenting: true, drawCount: 1, interactionActive: state.held }),
      capture: () => structuredClone(state.drawn),
      // The checkpoint a failed start puts back, through the workspace path.
      restoreShared: async (scene: any, admit: () => void) => { admit(); state.drawn = structuredClone(scene); state.restores++; } },
    call: async (_name: string, args: any) => {
      calls.push(args.phase ?? _name);
      return { structuredContent: args.phase === 'defer-local-save' ? { deferred: true } : { admitted: true } };
    },
    scheduleSave: () => { h.dirty = true; }, save: async () => { state.saves++; },
    applyTourCommand: async () => { state.applies++; state.chapter?.(); state.during?.(); return {}; },
    confirmReceipt: async (receipt: any) => { receipts.push(receipt); return { status: receipt.failure ? 'rejected' : 'rendered' }; },
    recordHeadsetEvent() {}, showOutcome() {}, recordLoopStage() {}, speakRemoteConfirmation() {}, tourHeartbeat: () => ({}),
    recoverConfirmation: async () => {}, busyBeat: async () => {}, isCompanion: true,
    tourPlayer: undefined, thrownErrorMessage: (error: Error) => error.message,
  });
  vm.runInContext(ts.transpileModule(receiveSource, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, h);
  const sent = { sessionId: 'session', serverEpoch: 'epoch', sourceToken: 'source', baseStateRevision: 1, baseInspectionRevision: 1 };
  const receive = (settleBudgetMs = 15000) => h.receive({ panelId: 'panel', commandId: 'start', claimToken: 'claim', settleBudgetMs,
    deferLocalSave: options.deferLocalSave === true, change: { kind: 'tour', patch: { action: 'start', tourId: 'walk' } } }, sent, 1);
  return { h, state, calls, receipts, receive };
}

describe('a held grip or stick when Claude’s start arrives', () => {
  it('delays the start until the release instead of refusing it', async () => {
    const r = receiver();
    r.state.held = true;
    const pending = r.receive();
    await vi.advanceTimersByTimeAsync(4000);
    expect(r.state.applies).toBe(0);
    expect(r.calls).not.toContain('admit');
    r.state.held = false;
    await vi.advanceTimersByTimeAsync(100); await pending;
    expect(r.calls).toEqual(['admit']);
    expect(r.state.applies).toBe(1);
    expect(r.receipts).toHaveLength(1);
    expect(r.receipts[0].failure).toBeUndefined();
  });

  it('refuses with the existing wording only once the settle budget runs out', async () => {
    const r = receiver();
    r.state.held = true;
    const pending = r.receive(3000);
    await vi.advanceTimersByTimeAsync(2900);
    expect(r.receipts).toEqual([]);
    await vi.advanceTimersByTimeAsync(200); await pending;
    expect(r.state.applies).toBe(0);
    expect(r.receipts).toEqual([expect.objectContaining({ failure: 'interaction_active',
      failureReason: 'Release the molecular drag before applying a command.' })]);
  });

  it.each([false, true])('saves the placement left at release first, and the host delivers the same start again (unbound: %s)', async unbound => {
    const r = receiver({ deferLocalSave: unbound });
    r.state.held = true;
    const pending = r.receive();
    await vi.advanceTimersByTimeAsync(500);
    r.state.drawn.inspection.placement = { translation: [0.3, 0, -1], rotation: [0, 20, 0], scale: 1.6 };
    r.state.held = false;
    await vi.advanceTimersByTimeAsync(100); await pending;
    expect(r.calls).toEqual(['defer-local-save']);
    expect(r.state.saves).toBe(1);
    expect(r.h.dirty).toBe(true);
    expect(r.state.applies).toBe(0);
    expect(r.receipts).toEqual([]);
  });

  it('carries a grab made during the chapter draw in the receipt, after its release', async () => {
    const r = receiver();
    r.state.during = () => {
      r.h.localInteractionSerial++; r.state.held = true;
      r.state.drawn.inspection.placement.scale = 1.4;
      setTimeout(() => { r.state.held = false; }, 1000);
    };
    const pending = r.receive();
    await vi.advanceTimersByTimeAsync(600);
    expect(r.receipts).toEqual([]);
    await vi.advanceTimersByTimeAsync(600); await pending;
    expect(r.receipts).toHaveLength(1);
    expect(r.receipts[0].failure).toBeUndefined();
    expect(r.receipts[0].scene.inspection.placement.scale).toBe(1.4);
  });

  it('still refuses a menu edit made during the chapter draw', async () => {
    const r = receiver();
    r.state.during = () => {
      r.h.localInteractionSerial++; r.h.lastLocalEditAt = performance.now();
      r.state.drawn.inspection.appearance.opacity = .3;
    };
    const pending = r.receive();
    await vi.advanceTimersByTimeAsync(200); await pending;
    expect(r.receipts).toEqual([expect.objectContaining({ failure: 'local_changed' })]);
    // The command drew nothing of its own, so only the wearer's edit is on screen, and it stays.
    expect(r.state.restores).toBe(0);
    expect(r.state.drawn.inspection.appearance.opacity).toBe(.3);
    expect(r.h.dirty).toBe(true);
  });

  it('keeps wearer opacity 0.3 when its queued edit lands ahead of checkpoint restoration', async () => {
    const r = receiver({ player: true });
    const source = readFileSync(new URL('../../lab/inspection/workspace.mjs', import.meta.url), 'utf8');
    const run = source.slice(source.indexOf('function run('), source.indexOf('\nfunction ui('));
    const restore = source.slice(source.indexOf('  restoreShared:') + '  restoreShared:'.length,
      source.indexOf('\n  captureNamedView:')).trim().replace(/,$/, '');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const queue: any = vm.createContext({ queue: Promise.resolve(), closing: false, busy: false,
      moleculeCanvas: { style: {} }, $$: () => [],
      // The headset queue has no desktop sequence group; keep the DOM lookup.
      $: (selector: string) => { expect(selector).toBe('.sequence-items'); return null; },
      setStatus() {}, sync() {}, options: {},
      captureScene: r.h.workspace.capture, namedPublication: { run: (action: () => unknown) => action() },
      viewer: { snapshot: r.h.workspace.snapshot, inspection: {
        runChapter: (action: () => unknown) => action(),
        restore: async (scene: any) => { r.state.drawn = structuredClone(scene); r.state.restores++; },
      } },
    });
    vm.runInContext(`${run}\nglobalThis.restoreShared=(${restore});`, queue);
    r.h.workspace.restoreShared = queue.restoreShared;
    r.state.chapter = () => {
      r.state.drawn.inspection.appearance.representation = 'spacefill';
      r.state.drawn.inspection.lessonPlayback = { tourId: 'walk', chapterId: 'one', stopped: false };
      r.state.drawnScene = { scene: structuredClone(r.state.drawn), serial: 1 };
    };
    r.state.during = () => {
      r.h.localInteractionSerial++; r.h.lastLocalEditAt = performance.now();
      void queue.run('Wearer opacity', async () => { await gate; r.state.drawn.inspection.appearance.opacity = .3; });
    };
    const pending = r.receive();
    await vi.advanceTimersByTimeAsync(200);
    expect(r.state.restores).toBe(0);
    release(); await pending;
    expect(r.receipts).toEqual([expect.objectContaining({ failure: 'local_changed' })]);
    expect(r.state.restores).toBe(1);
    expect(r.state.drawn.inspection.appearance).toEqual({ opacity: .3 });
    expect(r.state.drawn.inspection.lessonPlayback).toBeUndefined();
    expect(r.h.dirty).toBe(true);
  });

  it('keeps wearer focus and emphasis during a refused chapter draw', async () => {
    const r = receiver({ player: true });
    const wearer = { parts: [{ id: 'wearer', label: 'My site', color: '#ffffff', chain: 'A' }],
      focus: ['wearer'], contextOpacity: .2, origin: 'command' };
    r.state.chapter = () => {
      r.state.drawn.inspection.emphasis = { parts: [], focus: [], contextOpacity: .5, origin: 'lesson' };
      r.state.drawn.inspection.lessonPlayback = { tourId: 'walk', chapterId: 'one', stopped: false };
      r.state.drawnScene = { scene: structuredClone(r.state.drawn), serial: 1 };
    };
    r.state.during = () => {
      r.h.localInteractionSerial++; r.h.lastLocalEditAt = performance.now();
      r.state.drawn.inspection.emphasis = structuredClone(wearer);
    };
    const pending = r.receive();
    await vi.advanceTimersByTimeAsync(200); await pending;
    expect(r.receipts).toEqual([expect.objectContaining({ failure: 'local_changed' })]);
    expect(r.state.drawn.inspection.emphasis).toEqual(wearer);
    expect(r.state.drawn.inspection.lessonPlayback).toBeUndefined();
    expect(r.h.dirty).toBe(true);
  });

  it('puts the refused chapter back but keeps the opacity the wearer set while it drew', async () => {
    const r = receiver({ player: true });
    r.state.chapter = () => {
      r.state.drawn.inspection.appearance.representation = 'spacefill';
      r.state.drawn.inspection.lessonPlayback = { tourId: 'walk', chapterId: 'one', stopped: false };
      r.state.drawnScene = { scene: structuredClone(r.state.drawn), serial: 1 };
    };
    // The toolbar edit was asked for during the draw and landed after it.
    r.state.during = () => {
      r.h.localInteractionSerial++; r.h.lastLocalEditAt = performance.now();
      r.state.drawn.inspection.appearance.opacity = .3;
    };
    const pending = r.receive();
    await vi.advanceTimersByTimeAsync(200); await pending;
    expect(r.receipts).toEqual([expect.objectContaining({ failure: 'local_changed' })]);
    expect(r.state.restores).toBe(1);
    expect(r.state.drawn.inspection.appearance).toEqual({ opacity: .3 });
    expect(r.state.drawn.inspection.lessonPlayback).toBeUndefined();
    expect(r.state.drawn.inspection.placement).toEqual(r.h.savedScene.inspection.placement);
    expect(r.h.dirty).toBe(true);
  });
});

describe('a headset viewer left in error', () => {
  const recovery = ast.statements.filter(node => ts.isFunctionDeclaration(node)
    && ['recoverViewerError', 'reloadSavedScene', 'renderingSettled'].includes(node.name?.text ?? '')).map(node => node.getText(ast)).join('\n');
  function viewer(recover?: () => Promise<void>) {
    const scene = { sourceSha256: 'a'.repeat(64), inspection: { placement: { scale: 1 } } };
    const state = { status: 'error', error: 'The molecular figure surroundings changed while preparing its layers.' };
    const events: any[] = [];
    const h: any = vm.createContext({ Date, Promise, JSON, String, setTimeout, Error,
      VIEWER_RECOVERY_BACKOFF_MS: [0, 5_000, 15_000, 60_000], viewerErrorRecovery: undefined,
      isCompanion: true, closed: false, remote: false, loading: false, reloading: false, experiencePreparing: false,
      activePreviewRecording: undefined, pendingReceipt: undefined, dirty: false, rendering: Promise.resolve(),
      binding: { sessionId: 'session' }, savedScene: structuredClone(scene),
      workspace: { snapshot: () => ({ ...state, ready: state.status === 'ready' }), capture: () => structuredClone(scene),
        viewer: { inspection: { recover: recover && (async () => { expect(h.remote).toBe(true); await recover(); state.status = 'ready'; }) } } },
      hydrate: vi.fn(async () => { expect(h.reloading).toBe(true); state.status = 'ready'; }),
      recordHeadsetEvent: (kind: string, detail: any) => events.push({ kind, ...detail }),
      thrownErrorMessage: (error: Error) => error.message, showProblem: () => { throw Error('A headset must not block'); },
      problemMessage: () => '',
    });
    vm.runInContext(ts.transpileModule(recovery, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, h);
    return { h, state, events };
  }

  it('redraws once through the viewer and never marks the recovered scene dirty', async () => {
    const v = viewer(async () => {});
    await v.h.recoverViewerError();
    expect(v.state.status).toBe('ready'); expect(v.h.dirty).toBe(false); expect(v.h.remote).toBe(false);
    expect(v.h.hydrate).not.toHaveBeenCalled();
    expect(v.events.map(event => event.phase)).toEqual(['recover', 'recovered']);
  });

  it('reloads the saved scene by drawing the source again when the viewer cannot redraw', async () => {
    const v = viewer(async () => { throw Error('recovery failed'); });
    await v.h.recoverViewerError(); await v.h.rendering;
    expect(v.h.hydrate).toHaveBeenCalledWith('session', undefined, undefined, { restoreExactScene: true, redraw: true });
    expect(v.h.dirty).toBe(false); expect(v.h.reloading).toBe(false);
    expect(v.events.map(event => event.phase)).toEqual(['recover', 'recover-failed', 'reload', 'reloaded']);
  });

  it('backs off between attempts and waits for local work', async () => {
    const recover = vi.fn(async () => { throw Error('still failing'); });
    const v = viewer(recover);
    v.h.remote = true; await v.h.recoverViewerError(); expect(recover).not.toHaveBeenCalled();
    v.h.remote = false; v.h.hydrate.mockImplementation(async () => {});
    await v.h.recoverViewerError(); await v.h.rendering;
    await v.h.recoverViewerError(); await v.h.rendering;
    expect(recover).toHaveBeenCalledTimes(1);
    v.state.error = 'A different failure.';
    await v.h.recoverViewerError(); expect(recover).toHaveBeenCalledTimes(1); // Inside the 5 s backoff.
    v.h.viewerErrorRecovery.at -= 5_000;
    await v.h.recoverViewerError(); expect(recover).toHaveBeenCalledTimes(2);
  });
  it('recovers the same error again once the viewer has recovered from it', async () => {
    const recover = vi.fn(async () => {});
    const v = viewer(recover);
    await v.h.recoverViewerError();
    expect(v.state.status).toBe('ready');
    // The same failure, minutes later.
    v.state.status = 'error';
    await v.h.recoverViewerError();
    expect(recover).toHaveBeenCalledTimes(2); expect(v.state.status).toBe('ready');
    expect(v.h.hydrate).not.toHaveBeenCalled();
  });

  it('retries a persistent error after each longer wait, then stops', async () => {
    const recover = vi.fn(async () => { throw Error('still failing'); });
    const v = viewer(recover);
    v.h.hydrate.mockImplementation(async () => {});
    for (const wait of [0, 5_000, 15_000, 60_000, 60_000]) {
      if (v.h.viewerErrorRecovery) v.h.viewerErrorRecovery.at -= wait;
      await v.h.recoverViewerError(); await v.h.rendering;
    }
    expect(recover).toHaveBeenCalledTimes(4);
    expect(v.h.hydrate).toHaveBeenCalledTimes(4);
  });
});
