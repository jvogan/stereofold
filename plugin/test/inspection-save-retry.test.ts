import { createPollBackoff } from '../src/inspection-poll-backoff.js';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { afterEach, expect, it, vi } from 'vitest';
import { createSaveRetryAdmission } from '../src/inspection-save-retry.js';
import { saveFailureRecovery } from '../src/inspection-panel-recovery.js';

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
