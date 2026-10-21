// @ts-ignore Shared menu status used by the extracted inspector closure.
import { assistantStatus } from '../../lab/browser-roundtrip/assistant-status.mjs';
import { createPollBackoff } from '../src/inspection-poll-backoff.js';
// @ts-ignore Shared browser state exercised by the inspector slice.
import { connectionStatus, setConnectionStatus, LINK_LOST, PAIR_AGAIN } from '../../lab/browser-roundtrip/connection-liveness.mjs';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createStereoStructureServer } from '../src/server.js';
import { PRIVATE_INSPECTION_META_KEY as KEY } from '../src/inspection-contract.js';
import { createReplyAudioSynthesizer } from '../src/headset-reply-audio.js';
import { thrownErrorMessage, toolResultError } from '../src/tool-result.js';
import { inspectionRefusalCaption } from '../src/inspection-refusal-caption.js';
import { companionStartupMessage } from '../src/companion-startup.js';
import { sceneImportPreflightView } from '../src/scene-import-preflight-view.js';
import { createSaveRetryAdmission } from '../src/inspection-save-retry.js';

// Only the socket and packaged HTML boundaries are replaced. Capability
// issuance, request parsing, dispatch, session expiry and scene storage run.
vi.mock('node:http', async importOriginal => {
  const actual = await importOriginal<typeof import('node:http')>();
  const boundPorts=new Set<number>();
  return { ...actual, default: { ...actual, createServer: vi.fn((_options, handler) => {
    const server = new EventEmitter() as any;
    server.handler = handler;
    server.setTimeout = () => server;
    server.unref = () => server;
    server.closeAllConnections = () => {};
    server.listen = (_port: number, host: string, ready: () => void) => {
      let port=_port||45000;
      while(boundPorts.has(port))port++;
      boundPorts.add(port);
      server.listening = true;
      server.address = () => ({ address: host, port });
      ready();
    };
    server.close = (done: () => void) => { boundPorts.delete(server.address?.().port);server.listening = false; done(); };
    return server;
  }) } };
});
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: (...args: any[]) => String(args[0]).endsWith('/recovery-pages/inspector.html')
    ? Promise.resolve('<html><script>void 0;</script></html>')
    : (actual.readFile as any)(...args) };
});

const cif = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');
const cleanups: (() => Promise<void>)[] = [];
let sceneServiceDirectory: string;
beforeEach(async () => { sceneServiceDirectory = await mkdtemp(join(tmpdir(), 'stereofold-recovery-test-')); });
afterEach(async () => {
  setConnectionStatus();
  try { for (const close of cleanups.splice(0)) await close(); }
  finally { await rm(sceneServiceDirectory, { recursive: true, force: true }); }
});

// Run the inspector's actual poll and notice functions without its DOM boot.
const inspectorSource = await readFile(new URL('../src/inspector.ts', import.meta.url), 'utf8');
const inspectorAst = ts.createSourceFile('inspector.ts', inspectorSource, ts.ScriptTarget.Latest, true);
const recoveryFunctions = inspectorAst.statements.filter(node => ts.isFunctionDeclaration(node)
  // `poll` now arms its own next tick and hands a stuck beat
  // to `busyBeat`, so both travel with it into this harness.
  && ['registerComparisonSources', 'poll', 'armPoll', 'beatSuspended', 'registerPollState', 'receivePollDelivery', 'busyBeat', 'problemMessage', 'showProblem', 'showConnectionProblem', 'refreshGrowBinding', 'recoverConfirmation', 'rebindCompanionSession'].includes(node.name?.text ?? ''))
  .map(node => node.getText(inspectorAst)).join('\n');
const reloadListener = inspectorAst.statements.find(node =>
  node.getText(inspectorAst).startsWith("reload.addEventListener('click'"))!.getText(inspectorAst);
const retryListener = inspectorAst.statements.find(node =>
  node.getText(inspectorAst).startsWith("retry.addEventListener('click'"))!.getText(inspectorAst);
const pairAgainListener = inspectorAst.statements.find(node =>
  node.getText(inspectorAst).startsWith("pairAgain.addEventListener('click'"))!.getText(inspectorAst);

function failedPoll(kind: 'save' | 'poll' | 'reconnect', error: Error) {
  const blank = () => ({ hidden: true, textContent: '' });
  const fail = async () => { throw error; };
  // The extracted functions run in their own realm, so a spy on this file's
  // Date never reaches them. `clock.value` is the seam: unset means real time.
  const realNow = Date.now;
  const clock: { value?: number } = {};
  const h = vm.createContext({ pollBackoff:createPollBackoff(()=>clock.value??realNow(),()=>0.5), clock, Date: { now: () => clock.value ?? realNow() },
    failedSourceLoad:undefined, experiencePreparing:false, pollInFlight:false, beatInFlight:false, beatCompletion:undefined, desktopReceiptInFlight:false, desktopReceiptBeat:undefined, repairNeeded:false, nextRepairAt:0, connectionWatchdog:undefined,
    connectionStatus, setConnectionStatus, LINK_LOST, PAIR_AGAIN, Error, thrownErrorMessage, closed: false, binding: { sessionId: 'session' },
    loading: false, isCompanion: true, remote: false, generation: 1, dirty: kind === 'save', blocked: false,
    heldComparisons: new Map(), comparisonRegistration: 0,
    panelId: kind === 'reconnect' ? undefined : 'panel', savedScene: {},
    workspace: { setStatus:()=>{}, snapshot: () => ({ ready: true }), capture: () => ({}),
      serializeCapture() { return JSON.stringify(this.capture()); }, viewer: { xr: {} } },
    syncHandoff() {}, save: fail, attach: fail, call: fail, expected: () => ({}),
    liveAvailability: () => 'ready', tourHeartbeat: () => ({}), tourPlayer: undefined, panelTour: undefined, experiencePlayer: undefined, experienceView: undefined,
    xrStartupReport: () => ({}), isRendererHeartbeatFailure: () => false, companionStartupMessage,
    connectionRecoveryLine: '', connectionTroubleSince: 0, LINK_LOSS_CAPTION_MS: 8_000, showHeadsetCaption: vi.fn(),
    connectionNotice: false, pendingReceipt: undefined, pendingReceiptFields: undefined, retryHydrationId: undefined, loadErrorDetails: '',
    sceneImportPreflightView, scenePreflightNotice: blank(), sceneImportNoticeSource: undefined, document: { visibilityState: 'visible', body: { dataset: {} } },
    rebinding: undefined, rebindRetryAt: 0, epoch: 'epoch', completedHydration: true, recordHeadsetEvent: vi.fn(),
    notice: blank(), message: blank(), retry: blank(), reload: blank(), pairAgain: blank(), details: blank(), detailsText: blank(),
    problemRetryKind: 'save', pollTimer: undefined, setTimeout: vi.fn(), clearTimeout: vi.fn(),
    rendering: Promise.resolve(), saving: Promise.resolve(), PRIVATE_KEY: KEY,
    requestedId: 'session', hydrate: fail, confirmReceipt: fail,
    confirmFailureRecovery: () => ({ action: 'block' }), registerComparisonSources: async () => {},
  });
  vm.runInContext(ts.transpileModule(recoveryFunctions,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, alwaysStrict: true } }).outputText, h);
  return h;
}

function installEarlyHydration(h: vm.Context) {
  const hydrate = inspectorAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'hydrate')!;
  Object.assign(h, { sourceSwapTrace: undefined, HYDRATION_TRANSPORT: {},
    beginSourceSwapTrace: () => ({ phase: (_name: string, work: Promise<unknown>) => work, fail: vi.fn(), skip: vi.fn() }),
  });
  runInspector(h, hydrate.getText(inspectorAst));
}

it.each([false, true])('retries an early hydration transport failure with a preserved ready view=%s', async ready => {
  const failure = Error('get_inspection transport unavailable');
  const h = failedPoll('poll', failure);
  h.workspace.snapshot = () => ({ ready });
  h.binding = ready ? { sessionId: 'previous', sourceToken: 'preserved-source' } : undefined;
  const beforeBinding = h.binding;
  const shown = new Map<string, { textContent: string }>();
  h.document.querySelector = (selector: string) => {
    if (!shown.has(selector)) shown.set(selector, { textContent: 'existing view' });
    return shown.get(selector);
  };
  h.document.body.dataset.ready = ready ? 'true' : 'loading';
  h.call = vi.fn(async () => { throw failure; });
  installEarlyHydration(h);
  await expect(h.hydrate('requested-source')).rejects.toThrow(failure.message);
  expect(h.retryHydrationId).toBe('requested-source');
  expect(h.loadErrorDetails).toBe(failure.message);
  expect(h.loading).toBe(false);
  expect(h.binding).toBe(beforeBinding);
  h.showProblem(h.problemMessage('loading', failure), 'loading', failure);
  expect(h.retry.textContent).toBe('Retry loading');
  expect(h.detailsText.textContent).toBe(failure.message);
  expect(h.document.body.dataset.ready).toBe(ready ? 'true' : 'error');
  expect(h.message.textContent).toBe(ready ? 'Structure load failed. View preserved. Choose Retry loading.' : 'Structure load failed. Choose Retry loading.');
  let click!: () => void;
  h.retry.addEventListener = (_event: string, listener: () => void) => { click = listener; };
  runInspector(h, retryListener);
  click(); await h.rendering;
  expect(h.call).toHaveBeenCalledTimes(2);
  expect(h.call).toHaveBeenLastCalledWith('get_inspection', { sessionId: 'requested-source' });
  expect(h.binding).toBe(beforeBinding);
});

it.each(['newer-hydration', 'closed'] as const)('does not publish an old hydration read failure after %s', async mode => {
  const h = failedPoll('poll', Error('unused'));
  let rejectRead!: (error: Error) => void;
  h.call = () => new Promise((_resolve, reject) => { rejectRead = reject; });
  installEarlyHydration(h);
  const pending = h.hydrate('old-source');
  if (mode === 'closed') h.closed = true;
  else h.generation++;
  h.retryHydrationId = 'new-source'; h.loadErrorDetails = 'new source problem';
  rejectRead(Error('obsolete fetch failure'));
  await expect(pending).resolves.toBeUndefined();
  expect(h.retryHydrationId).toBe('new-source');
  expect(h.loadErrorDetails).toBe('new source problem');
  expect(h.recordHeadsetEvent).not.toHaveBeenCalled();
  if (mode === 'newer-hydration') expect(h.loading).toBe(true);
});

function installHydrationCall(h: vm.Context, invoke: (input: unknown) => Promise<unknown>) {
  Object.assign(h, { sceneHistoryClient: { requestStarted: () => 0 }, tourCommandContext: undefined,
    companionCall: undefined, app: { callServerTool: invoke }, toolResultError, inspectionRefusalCaption,
    isCompanion: false, hostTakesPageBuild: false,
  });
  for (const name of ['callStatus', 'call']) {
    const node = inspectorAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)!;
    runInspector(h, node.getText(inspectorAst));
  }
}

it('keeps original transport and tool details through the actual call and hydration error rewrites', async () => {
  const h = failedPoll('poll', Error('unused'));
  installEarlyHydration(h);
  let attempt = 0;
  installHydrationCall(h, async () => {
    if (++attempt === 1) throw Object.assign(Error('thread not found: retired desktop task'), { code: 'bridge_missing', status: 503 });
    return { isError: true, content: [{ type: 'text', text: 'Unknown tool: stereo_structure.get_inspection' }] };
  });
  await expect(h.hydrate('requested-source')).rejects.toMatchObject({
    message: 'This panel lost its connection to the desktop app. Open Stereofold in a new task.', code: 'bridge_missing', status: 503,
  });
  expect(h.loadErrorDetails).toBe('thread not found: retired desktop task');
  h.showProblem('friendly loading headline', 'loading');
  expect(h.detailsText.textContent).toBe('thread not found: retired desktop task');
  let click!: () => void;
  h.retry.addEventListener = (_event: string, listener: () => void) => { click = listener; };
  runInspector(h, retryListener);
  click(); await h.rendering;
  expect(attempt).toBe(2);
  expect(h.detailsText.textContent).toBe(inspectionRefusalCaption('Unknown tool: stereo_structure.get_inspection'));
  expect(h.message.textContent).toBe('Structure load failed. View preserved. Choose Retry loading.');
});

it('does not let an obsolete call rewrite overwrite a newer hydration error detail', async () => {
  const h = failedPoll('poll', Error('unused'));
  installEarlyHydration(h);
  let rejectRead!: (error: Error) => void;
  installHydrationCall(h, () => new Promise((_resolve, reject) => { rejectRead = reject; }));
  const pending = h.hydrate('old-source');
  h.generation++;
  h.retryHydrationId = 'new-source'; h.loadErrorDetails = 'newer source detail';
  rejectRead(Error('thread not found: obsolete task'));
  await pending;
  expect(h.retryHydrationId).toBe('new-source');
  expect(h.loadErrorDetails).toBe('newer source detail');
});

it('poll keeps a long error in details and shows a plain retry message', async () => {
  const h = failedPoll('poll', Error('  The\n panel\t is   busy with another very long operation that has not completed yet.  '));
  await h.poll();
  expect(h.message.textContent).toBe('Your view is preserved; choose Retry.');
  expect(h.details.hidden).toBe(false);
  expect(h.detailsText.textContent).toContain('very long operation');
});

it('waits for the next beat when a molecular capture is still rendering', async () => {
  const h = failedPoll('poll', Error('unused'));
  h.workspace.capture = () => {
    throw Object.assign(Error('A molecular change is still rendering.'), {code:'viewer_busy'});
  };
  await h.poll();
  expect(h.blocked).toBe(false);
  expect(h.notice.hidden).toBe(true);
  expect(h.setTimeout).toHaveBeenCalledOnce();
});

it('a failed source names the available retry and keeps the complete error in details', () => {
  const h = failedPoll('reconnect', Error('unused'));
  h.retryHydrationId = 'session';
  h.loadErrorDetails = 'The next source cannot preserve the current room position within the supported placement range.';
  h.showProblem(h.problemMessage('reconnect', Error(h.loadErrorDetails)), 'reconnect');
  expect(h.message.textContent).toBe('Structure load failed. View preserved. Choose Retry loading.');
  expect(h.retry.textContent).toBe('Retry loading');
  expect(h.details.hidden).toBe(false);
  expect(h.detailsText.textContent).toBe(h.loadErrorDetails);
});

it.each(['save', 'poll', 'reconnect'] as const)('%s failures offer their matching retry action', async kind => {
  const h = failedPoll(kind, Error('Request failed.'));
  await h.poll();
  expect(h.message.textContent).toBe(kind === 'save'
    ? 'Your changes are unsaved; choose Retry.' : 'Your view is preserved; choose Retry.');
  expect(h.retry.textContent).toBe('Retry');
  expect(h.detailsText.textContent).toBe('Request failed.');
  expect(h.blocked).toBe(true);
  expect(h.setTimeout).toHaveBeenCalledOnce();
  let click!: () => void;
  h.retry.addEventListener = (_event: string, listener: () => void) => { click = listener; };
  vm.runInContext(ts.transpileModule(retryListener,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, alwaysStrict: true } }).outputText, h);
  h.save = vi.fn(async () => {});
  h.poll = vi.fn(async () => {});
  click(); await h.rendering;
  expect(h.save).toHaveBeenCalledTimes(kind === 'save' ? 1 : 0);
  expect(h.poll).toHaveBeenCalledTimes(kind === 'save' ? 0 : 1);
  expect(h.clearTimeout).toHaveBeenCalledTimes(kind === 'save' ? 0 : 1);
  expect(h.blocked).toBe(false);
});

it('requires a deliberate Pair again click before leaving a disconnected loaded scene', () => {
  const navigations: string[] = [];
  let click!: () => void;
  const h = vm.createContext({ pairAgain: { addEventListener(_event: string, listener: () => void) { click = listener; } },
    location: { search: '?xrRenderBudget=scale:0.5', assign: (path: string) => navigations.push(path) } });
  runInspector(h, pairAgainListener);
  expect(navigations).toEqual([]);
  click();
  expect(navigations).toEqual(['/?xrRenderBudget=scale:0.5']);
});

it('offers Pair again on disconnect while preserving the loaded workspace', () => {
  const h = failedPoll('poll', Error('unused'));
  const before = h.workspace;
  expect(h.showConnectionProblem(Object.assign(Error('Connection was lost.'), { code: 'companion_connection' }), 1)).toBe(true);
  expect(h.message.textContent).toBe('Disconnected. View preserved; use Pair again to reconnect.');
  expect(connectionStatus().line).toBe('Link to the Mac lost. Your view is still here.');
  expect(h.pairAgain.hidden).toBe(false);
  expect(h.workspace).toBe(before);
  expect(h.blocked).toBe(false);
});

/**
 * The caption plate holds one line, and a delivered reply is
 * on it. Connection notices must never replace that answer; the renderer
 * displays one brief warning after the answer's promised reading window.
 */
it('leaves a delivered reply owned by the caption through repeated failed beats', () => {
  const h = failedPoll('poll', Error('unused'));
  const dropped = Object.assign(Error('The companion connection was lost while sending the request.'), { code: 'companion_connection' });
  h.clock.value = 1_000_000;
  expect(h.showConnectionProblem(dropped, 1)).toBe(true);
  expect(h.showHeadsetCaption).not.toHaveBeenCalled();
  expect(h.message.textContent).toBe('Disconnected. View preserved; use Pair again to reconnect.');

  // Still inside the deadline on a later beat: still the wearer's answer.
  h.clock.value = 1_007_999;
  expect(h.showConnectionProblem(dropped, 1)).toBe(true);
  expect(h.showHeadsetCaption).not.toHaveBeenCalled();

  // Past it, the renderer still owns the answer and warning lifetimes.
  h.clock.value = 1_008_000;
  expect(h.showConnectionProblem(dropped, 1)).toBe(true);
  expect(h.showHeadsetCaption).not.toHaveBeenCalled();
  expect(connectionStatus().line).toBe(LINK_LOST);
});

it('reports an ended share without replacing a pending scientific caption', () => {
  const h = failedPoll('poll', Error('unused'));
  expect(h.showConnectionProblem(Object.assign(Error('expired'), { code: 'companion_expired' }), 1)).toBe(true);
  expect(h.showHeadsetCaption).not.toHaveBeenCalled();
  expect(h.message.textContent).toBe('Share ended. Reopen sharing on the desktop; open its new link.');
  expect(connectionStatus().line).toBe(LINK_LOST);
  expect(h.repairNeeded).toBe(true);
});

/**
 * After a Mac restart or a re-share the page re-pairs onto a link that serves
 * another session. Every call naming its old session is refused with
 * `session_changed`; `get_inspection` with no session answers the new one.
 */
const sessionChanged = () => Object.assign(Error('This link shares a different session.'), { code: 'companion_session_changed', status: 400 });
const newSession = { structuredContent: {}, _meta: { [KEY]: { sessionId: 'new-session', serverEpoch: 'new-epoch' } } };
function repairedPage(hydrate: (h: vm.Context, id: string) => Promise<void>) {
  const h = failedPoll('poll', sessionChanged());
  h.document.body.dataset.panelId = 'panel';
  h.expected = () => ({ sessionId: h.binding.sessionId });
  h.call = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === 'get_inspection' && !('sessionId' in args)) return newSession;
    throw sessionChanged();
  });
  // The real hydrate refuses data whose epoch is not `epoch`, detaches any
  // panel it still holds, and opens a lesson as a fresh tab only while no
  // hydration has completed; all three have to be settled before it runs.
  h.hydrate = vi.fn(async (id: string) => {
    expect([h.epoch, h.requestedId, h.panelId, h.document.body.dataset.panelId, h.completedHydration])
      .toEqual(['new-epoch', 'new-session', undefined, undefined, false]);
    await hydrate(h, id);
  });
  return h;
}
const hydrated = async (h: vm.Context, id: string) => { h.binding = { sessionId: id }; };
const bindingReads = (h: vm.Context) => h.call.mock.calls.filter(([name]: [string]) => name === 'get_inspection');

it.each(['poll', 'busyBeat'] as const)('a %s refused for a changed session re-binds to the new session without blocking', async beat => {
  const h = repairedPage(hydrated);
  // A poll still saving or re-attaching hands the beat to busyBeat.
  h.pollInFlight = beat === 'busyBeat';
  await h.poll();
  await h.rendering;
  expect(bindingReads(h)).toEqual([['get_inspection', {}]]);
  expect(h.hydrate).toHaveBeenCalledOnce();
  expect(h.hydrate).toHaveBeenCalledWith('new-session', newSession);
  expect(h.binding.sessionId).toBe('new-session');
  expect(h.blocked).toBe(false);
  expect([h.notice.hidden, h.message.textContent, h.problemRetryKind]).toEqual([true, '', 'save']);
  expect(h.showHeadsetCaption).toHaveBeenCalledWith('The Mac now shares a new session. Loading it.');
  expect(h.recordHeadsetEvent).toHaveBeenCalledWith('connection', { phase: 'session-changed' });
  expect(h.rebinding).toBeUndefined();
});

it('ignores a late refusal naming a session the page has already left', async () => {
  const h = repairedPage(hydrated);
  await h.poll();
  await h.rendering;
  h.rebindCompanionSession('session');
  await h.rendering;
  expect(bindingReads(h)).toHaveLength(1);
  expect(h.hydrate).toHaveBeenCalledOnce();
});

it('a re-bind that cannot load the new session offers Pair again and tries again later', async () => {
  const h = repairedPage(async () => { throw Error('Structure load failed.'); });
  const line = 'The new session didn’t load. Use Pair again.';
  h.clock.value = 1_000_000;
  await h.poll();
  await h.rendering;
  expect(h.message.textContent).toBe(line);
  expect([h.notice.hidden, h.pairAgain.hidden, h.retry.hidden, h.reload.hidden]).toEqual([false, false, true, true]);
  expect([h.blocked, h.connectionNotice]).toEqual([false, true]);
  expect(connectionStatus()).toMatchObject({ line: PAIR_AGAIN, recovery: true });
  expect(h.showHeadsetCaption).toHaveBeenLastCalledWith(line);
  expect(h.recordHeadsetEvent).toHaveBeenCalledWith('connection', { phase: 'rebind-failed', message: 'Structure load failed.' });
  // The page no longer holds a panel, so the next beat re-attaches under the
  // old session and is refused the same way: no block, no immediate re-read.
  await h.poll();
  await h.rendering;
  expect(h.hydrate).toHaveBeenCalledOnce();
  expect([h.message.textContent, h.blocked, h.problemRetryKind]).toEqual([line, false, 'save']);
  h.clock.value = 1_015_000;
  await h.poll();
  await h.rendering;
  expect(h.hydrate).toHaveBeenCalledTimes(2);
});

it('re-binds on the refusal the companion client raises for a session_changed body', async () => {
  const { createCompanionClient, forgetCompanionPageKey } = await import('../src/inspection-companion-client.js');
  const sent: Array<{ name: string; args: Record<string, unknown> }> = [];
  vi.stubGlobal('location', { hash: `#${'a'.repeat(64)}`, pathname: '/viewer' });
  vi.stubGlobal('history', { replaceState() {} });
  vi.stubGlobal('sessionStorage', { setItem() {} });
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); sent.push(body);
    return 'sessionId' in body.args
      ? Response.json({ error: 'session_changed', message: 'This link shares a different session.' }, { status: 400 })
      : Response.json(newSession);
  });
  forgetCompanionPageKey();
  try {
    const h = repairedPage(hydrated);
    h.call = createCompanionClient();
    await h.poll();
    await h.rendering;
    expect(sent.map(({ name, args }) => [name, args.sessionId])).toEqual([['poll_inspection', 'session'], ['get_inspection', undefined]]);
    expect(h.hydrate).toHaveBeenCalledWith('new-session', newSession);
    expect(h.blocked).toBe(false);
  } finally { vi.unstubAllGlobals(); forgetCompanionPageKey(); }
});

const longFailure = Error('  The\n panel\t is   busy with another very long operation that has not completed yet.  ');
function runInspector(h: vm.Context, text: string) {
  vm.runInContext(ts.transpileModule(text,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, alwaysStrict: true } }).outputText, h);
}
function installSaveRecovery(h: vm.Context) {
  Object.assign(h, { saveAttempts: 0, lastAutoReload: 0, reloading: false, timer: undefined,
    saveRetryAdmission: createSaveRetryAdmission(),
    edits: 1, outcome: { textContent: '' }, saveFailureRecovery: () => ({ action: 'block' }) });
  runInspector(h, inspectorAst.statements.filter(node => ts.isFunctionDeclaration(node)
    && ['save', 'recoverSave'].includes(node.name?.text ?? '')).map(node => node.getText(inspectorAst)).join('\n'));
}

it('every showProblem call formats its error through problemMessage with an explicit kind', () => {
  const rawSites: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(inspectorAst) === 'showProblem') {
      const first = node.arguments[0];
      if (!first || !ts.isCallExpression(first) || first.expression.getText(inspectorAst) !== 'problemMessage'
        || first.arguments.length < 1 || node.arguments.length !== 3) rawSites.push(node.getText(inspectorAst));
    }
    ts.forEachChild(node, visit);
  };
  visit(inspectorAst);
  expect(rawSites).toEqual([]);
});

it('automatic saved-view reload bounds a long loading failure', async () => {
  const h = failedPoll('poll', longFailure);
  installSaveRecovery(h);
  h.saveFailureRecovery = () => ({ action: 'reload' });
  h.recoverSave('conflict', longFailure.message);
  await h.rendering;
  expectProblem(h, 'loading');
  expect(h.reloading).toBe(false);
});

it.each(['busy', 'conflict', 'error'] as const)('blocked %s save recovery bounds a long raw error', kind => {
  const h = failedPoll('poll', longFailure);
  installSaveRecovery(h);
  h.recoverSave(kind, longFailure.message);
  expectProblem(h, 'save');
});

it.each(['request', 'queue'] as const)('%s save catch bounds a long raw error', async site => {
  const h = failedPoll('save', longFailure);
  installSaveRecovery(h);
  if (site === 'queue') h.saving = Promise.reject(longFailure);
  await h.save();
  expectProblem(h, 'save');
});

it.each(['unsaved', 'save', 'loading'] as const)('incoming view %s failure offers the matching action', async site => {
  const h = failedPoll('poll', longFailure);
  Object.assign(h, { app: {}, publishModelContext() {}, retiredEpochs: new Set(), epoch: 'epoch', latestToken: 0 });
  if (site !== 'save') h.save = async () => { h.dirty = site === 'unsaved'; };
  let listener!: ts.BinaryExpression;
  const visit = (node: ts.Node) => {
    if (ts.isBinaryExpression(node) && node.left.getText(inspectorAst) === 'app.ontoolresult') listener = node;
    ts.forEachChild(node, visit);
  };
  visit(inspectorAst);
  runInspector(h, listener.getText(inspectorAst));
  await h.app.ontoolresult({ structuredContent: { kind: 'inspect', sessionId: 'new-session', serverEpoch: 'epoch', renderToken: 1 } });
  expectProblem(h, site === 'loading' ? 'loading' : 'save');
});

function expectProblem(h: vm.Context, kind: string) {
  expect(h.message.textContent.trim().split(/\s+/).length).toBeLessThanOrEqual(12);
  expect(h.message.textContent).toBe(h.retryHydrationId
    ? 'Structure load failed. View preserved. Choose Retry loading.'
    : kind === 'save' ? 'Your changes are unsaved; choose Retry.' : 'Your view is preserved; choose Retry.');
  expect(h.retry.textContent).toBe(kind === 'loading' && h.retryHydrationId ? 'Retry loading' : 'Retry');
  expect(h.problemRetryKind).toBe(kind);
}

it.each(['save', 'poll', 'reconnect', 'delivery', 'confirmation', 'loading'] as const)(
  '%s status bounds long raw errors and accepts an omitted error', kind => {
    const h = failedPoll('poll', longFailure);
    for (const error of [longFailure, undefined]) {
      h.showProblem(h.problemMessage(kind, error), kind, error);
      expectProblem(h, kind);
      expect(h.details.hidden).toBe(error === undefined);
    }
  });

it.each(['save', 'poll', 'reconnect'] as const)('poll catch bounds a long %s failure', async kind => {
  const h = failedPoll(kind, longFailure);
  await h.poll();
  expectProblem(h, kind);
});

it.each(['grow', 'poll'] as const)('%s delivery catch bounds its error and offers delivery retry', async site => {
  const h = failedPoll('poll', longFailure);
  h.call = async () => ({ structuredContent: { ...h.binding, attached: true },
    _meta: { [KEY]: { delivery: { commandId: 'command' } } } });
  Object.assign(h, { clearConnectionProblem() {}, noteRendererHeartbeat() {}, showOutcome() {},
    retireStaleHud() {}, noteAgentPresence() {}, assistantStatus, followsSourceTransition: () => false,
    voiceBindingKey: () => '', voiceReadyBinding: '', replyOnThisBeat: false, experienceView: undefined,
    receiveSpokenReply() {}, handoffSpokenRequest() {},
    receive: async () => { throw longFailure; } });
  await (site === 'grow' ? h.refreshGrowBinding() : h.poll());
  await h.rendering;
  expectProblem(h, 'delivery');
});

it.each([true, false])('confirmation recovery bounds its error with pending receipt=%s', async pending => {
  const h = failedPoll('poll', longFailure);
  h.pendingReceipt = pending ? {} : undefined;
  await h.recoverConfirmation(longFailure, ' Additional unbounded context '.repeat(20), 1);
  expectProblem(h, pending ? 'confirmation' : 'delivery');
});

it('load saved view catch bounds its error and offers loading retry', async () => {
  const h = failedPoll('poll', longFailure);
  let click!: () => void;
  h.reload.addEventListener = (_event: string, listener: () => void) => { click = listener; };
  vm.runInContext(ts.transpileModule(reloadListener,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, alwaysStrict: true } }).outputText, h);
  click(); await h.rendering;
  expectProblem(h, 'loading');
});

it.each(['save', 'poll', 'reconnect', 'delivery', 'confirmation', 'loading'] as const)(
  'retry button catch preserves the %s action for a long failure', async kind => {
    const h = failedPoll('poll', longFailure);
    // Stale prior wording must not override the action selected by receipt/loading state.
    h.problemRetryKind = ['confirmation', 'loading'].includes(kind) ? 'save' : kind;
    h.pendingReceipt = kind === 'confirmation' ? {} : undefined;
    h.retryHydrationId = kind === 'loading' ? 'session' : undefined;
    h.poll = async () => { throw longFailure; };
    let click!: () => void;
    h.retry.addEventListener = (_event: string, listener: () => void) => { click = listener; };
    vm.runInContext(ts.transpileModule(retryListener,
      { compilerOptions: { target: ts.ScriptTarget.ES2022, alwaysStrict: true } }).outputText, h);
    click(); await h.rendering;
    expectProblem(h, kind);
  });

async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Error('Recovery response exceeded one second')), 1000);
  });
  try { return await Promise.race([work, deadline]); }
  finally { clearTimeout(timer!); }
}

async function host(sessionTtlMs = 2 * 60 * 60 * 1000) {
  let now = 0;
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createStereoStructureServer(new URL('./recovery-pages/viewer.html', import.meta.url).pathname,
    { now: () => now, sessionTtlMs, replyAudio: createReplyAudioSynthesizer({ enabled: false }),
      // Hosts within this test share discovery, but parallel test files must
      // not occupy its owner record or change its session-refusal semantics.
      sceneServiceFile: join(sceneServiceDirectory, 'scene-service.json') });
  const client = new Client({ name: 'Recovery contract', version: '1' });
  await server.connect(b); await client.connect(a);
  let closed = false;
  const close = async () => { if (closed) return; closed = true; await client.close(); await server.close(); };
  cleanups.push(close);
  const call = (name: string, args: Record<string, unknown>) => bounded(client.callTool({
    name: `stereo_structure.${name}`, arguments: args,
  })) as Promise<any>;
  const opened = await call('inspect', { structureText: cif });
  expect(opened.isError).not.toBe(true);
  const sessionId = opened.structuredContent.sessionId;
  const data = (await call('get_inspection', { sessionId }))._meta[KEY];
  const scene = { sourceSha256: data.catalog.source.sha256, modelNumber: data.catalog.modelNumbers[0],
    assemblyId: data.catalog.assemblyId, selectionKeys: [data.catalog.rows[0].key],
    camera: { mode: 'perspective', fov: Math.PI / 4, position: [0, 0, 80], up: [0, 1, 0], target: [0, 0, 0],
      radius: 20, radiusMax: 20, fog: 50, clipFar: true, minNear: 5, minFar: 0 },
    inspection: { appearance: { representation: 'cartoon', color: 'chain-id', uniformColor: '#44aaff',
      background: '#192734', highlightColor: '#ffccee', opacity: 1, labels: false, clipping: 0, fog: 30 },
      placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } } };
  const saved = (await call('sync_inspection', { sessionId, serverEpoch: data.serverEpoch, sourceToken: data.sourceToken,
    baseStateRevision: data.stateRevision, baseInspectionRevision: data.inspectionRevision, scene })).structuredContent;
  const binding = { sessionId, serverEpoch: saved.serverEpoch, sourceToken: saved.sourceToken,
    baseStateRevision: saved.stateRevision, baseInspectionRevision: saved.inspectionRevision };
  async function share() {
    const result = await call('open_companion', { ...binding, connection: 'loopback' });
    expect(result.isError).not.toBe(true);
    const url = new URL(result.structuredContent.companion.url);
    // Publishing the shared scene also opens a listener. Route to the exact
    // companion address returned by the tool, as the page does over HTTP.
    const listeners=vi.mocked(http.createServer).mock.results.map(result=>result.value as any)
      .filter(listener=>listener?.listening && listener.address?.().port===Number(url.port));
    expect(listeners).toHaveLength(1);
    const listener=listeners[0];
    return { url, listener };
  }
  return { call, binding, scene, sessionId, share, close, advance: (ms: number) => { now += ms; },
    read: () => call('get_inspection', { sessionId }) };
}

function request(share: { url: URL; listener: any }, name = 'poll_inspection', args: Record<string, unknown> = {}) {
  return bounded(new Promise<{ status: number; body: any }>(resolve => {
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ name, args }))]), {
      url: '/tool', method: 'POST', headers: { host: share.url.host, origin: share.url.origin,
        authorization: `Bearer ${share.url.hash.slice(1)}`, 'content-type': 'application/json' },
    });
    let status = 0;
    const response = { setHeader() {}, writeHead: (value: number) => { status = value; },
      end: (body: string) => resolve({ status, body: JSON.parse(body) }) };
    share.listener.handler(req, response);
  }));
}

it('routes the paired page to its companion address while a separate shared-scene listener is live',async()=>{
  const h=await host(),share=await h.share();
  const listeners=vi.mocked(http.createServer).mock.results.map(result=>result.value as any).filter(listener=>listener?.listening);
  expect(listeners.length).toBeGreaterThanOrEqual(2);
  expect(new Set(listeners.map(listener=>listener.address().port)).size).toBe(listeners.length);
  expect(share.listener.address().port).toBe(Number(share.url.port));
  const answer=await request(share,'get_inspection');
  expect(answer.status).toBe(200);
  expect(answer.body._meta[KEY].sessionId).toBe(h.sessionId);
});

it('expired share answers once within a bound and leaves desktop reads and edits usable', async () => {
  const h = await host(), share = await h.share();
  h.advance(30 * 60 * 1000);
  expect(await request(share)).toEqual({ status: 401, body: { error: 'unauthorized' } });
  expect((await h.read())._meta[KEY].scene).toEqual(h.scene);
  const edit = structuredClone(h.scene); edit.selectionKeys = [];
  const saved = await h.call('sync_inspection', { ...h.binding, scene: edit });
  expect(saved.isError).not.toBe(true);
  expect((await h.read())._meta[KEY].scene.selectionKeys).toEqual([]);
});

it('expired host session returns a bounded refusal and accepts a fresh inspection', async () => {
  const h = await host(1000), share = await h.share();
  h.advance(1001);
  const failed = await request(share, 'get_inspection');
  expect(failed.status).toBe(409);
  expect(failed.body.message).toMatch(/session.*expired/i);
  expect((await h.read()).isError).toBe(true);
  const fresh = await h.call('inspect', { structureText: cif });
  expect(fresh.isError).not.toBe(true);
  expect((await h.call('get_inspection', { sessionId: fresh.structuredContent.sessionId })).isError).not.toBe(true);
});

it('a disconnected companion can reattach without changing the desktop scene', async () => {
  const h = await host(), share = await h.share();
  const attached = await request(share, 'attach_inspection', h.binding);
  expect(attached.status).toBe(200);
  const panelId = attached.body.structuredContent.panelId;
  // No heartbeat arrives during the outage; advance beyond the panel lease.
  h.advance(61_000);
  const poll = await request(share, 'poll_inspection', { ...h.binding, panelId, availability: 'ready' });
  expect(poll.status).toBe(200);
  expect(poll.body.structuredContent.attached).toBe(false);
  const next = await request(share, 'attach_inspection', h.binding);
  expect(next.status).toBe(200);
  expect(next.body.structuredContent.panelId).not.toBe(panelId);
  expect((await h.read())._meta[KEY].scene).toEqual(h.scene);
  const edited = structuredClone(h.scene); edited.inspection.placement.scale = 1.5;
  expect((await h.call('sync_inspection', { ...h.binding, scene: edited })).isError).not.toBe(true);
  expect((await h.read())._meta[KEY].scene.inspection.placement.scale).toBe(1.5);
});

it('a fresh host refuses old shares and sessions without damaging its desktop scene', async () => {
  const old = await host(), oldShare = await old.share();
  await old.close();
  const fresh = await host(), newShare = await fresh.share();
  // A restarted listener has the same address but a new capability registry.
  expect(await request({ url: oldShare.url, listener: newShare.listener }))
    .toEqual({ status: 401, body: { error: 'unauthorized' } });
  const stale = await fresh.call('get_inspection', { sessionId: old.sessionId });
  expect(stale.isError).toBe(true);
  expect(stale.content[0].text).toMatch(/session.*expired/i);
  const accepted = await request(newShare, 'get_inspection');
  expect(accepted.status).toBe(200);
  expect((await fresh.read())._meta[KEY].scene).toEqual(fresh.scene);
});

it('tells a re-paired page still on the old session that the share changed, and reads it the new one', async () => {
  const old = await host();
  await old.share();
  await old.close();
  const fresh = await host(), share = await fresh.share();
  expect(fresh.sessionId).not.toBe(old.sessionId);
  // The bearer is the fresh share's; only the page's remembered session is stale.
  expect(await request(share, 'poll_inspection', { ...old.binding, panelId: 'b'.repeat(32), availability: 'ready' }))
    .toEqual({ status: 400, body: { error: 'session_changed', message: 'This link shares a different session.' } });
  const current = await request(share, 'get_inspection');
  expect(current.status).toBe(200);
  expect(current.body._meta[KEY].sessionId).toBe(fresh.sessionId);
});

it('recovery never replays a rejected mutation and changes only the held bearer', async () => {
  const { createCompanionClient, forgetCompanionPageKey, recoverCompanionConnection } = await import('../src/inspection-companion-client.js');
  const requests: Array<{ url: string; init: RequestInit }> = [], storage = new Map<string, string>();
  vi.stubGlobal('location', { hash: `#${'a'.repeat(64)}`, pathname: '/viewer' });
  vi.stubGlobal('history', { replaceState() {} });
  vi.stubGlobal('sessionStorage', { setItem: (key: string, value: string) => storage.set(key, value) });
  vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ deviceId: 'd'.repeat(32), deviceKey: 'e'.repeat(64) }) });
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    if(url==='/pair')return Response.json({token:'b'.repeat(64)});
    return requests.length===1 ? new Response('', {status:401}) : Response.json({structuredContent:{attached:true}});
  });
  forgetCompanionPageKey();
  try {
    const call=createCompanionClient();
    await expect(call('sync_inspection', {commandId:'once'})).rejects.toMatchObject({code:'companion_expired'});
    expect(requests).toHaveLength(1);
    const repairs=[recoverCompanionConnection(),recoverCompanionConnection()];
    expect(repairs[0]).toBe(repairs[1]);
    expect(await Promise.all(repairs)).toEqual([true,true]);
    await call('poll_inspection', {});
    expect(requests.map(r=>r.url)).toEqual(['/tool','/pair','/tool']);
    expect((requests[2].init.headers as Record<string,string>).authorization).toBe(`Bearer ${'b'.repeat(64)}`);
    expect(storage.get('stereo_structure/page-key')).toBe('b'.repeat(64));
    expect(requests.filter(r=>String(r.init.body).includes('sync_inspection'))).toHaveLength(1);
  } finally { vi.unstubAllGlobals();forgetCompanionPageKey(); }
});


it('the actual heartbeat scheduler retries once within one second, backs off outages and resets after success',async()=>{
  const h=failedPoll('poll',Object.assign(Error('offline'),{code:'companion_connection'}));
  h.clock.value=10000;
  h.retireStaleHud=()=>{};
  h.clearConnectionProblem=()=>{};
  h.noteRendererHeartbeat=()=>{};
  h.showOutcome=()=>{};
  h.call=vi.fn(async()=>{throw Object.assign(Error('offline'),{code:'companion_connection'});});
  const delays:number[]=[];
  for(let i=0;i<6;i++) {
    await h.poll();
    const delay=h.setTimeout.mock.calls.at(-1)[1];delays.push(delay);
    h.clock.value+=delay;
  }
  expect(delays[0]).toBeLessThan(1000);
  expect(delays[1]).toBeGreaterThan(delays[0]);
  expect(delays[5]).toBeLessThanOrEqual(4000);
  expect(h.call).toHaveBeenCalledTimes(6);
  h.call=vi.fn(async()=>({structuredContent:{superseded:true}}));
  await h.poll();expect(h.pollBackoff.remaining()).toBe(0);
  expect(h.closed).toBe(true);
});

it('a failed host source render clears abandoned drag work and offers the next load without reload',async()=>{
  const h=failedPoll('poll',Error('unused'));
  Object.assign(h,{binding:{sessionId:'session',serverEpoch:'epoch',sourceToken:'old',stateRevision:1,inspectionRevision:1},
    panelId:'panel',dirty:true,completedHydration:true,narrationGeneration:0,voiceOwnedSourceTransition:false,
    voiceInteraction:undefined,sourceLoadOutcome:undefined,handoffSource:undefined,handoffFeedback:'',handoffPending:false,
    handoffVersion:0,sourceGeometryBudgetSupported:false,rendererContextSupported:false,renderedSourceIdentitySupported:false,experienceSourceChanged:false,
    beginSourceLoadOutcome:()=>{},failSourceLoadOutcome:()=>{},inspectionFailureReceipt:()=>({failure:'render_failed',failureReason:'GPU failed'}),
  });
  const drawn={preserved:true};h.workspace.capture=()=>drawn;
  const sent:any[]=[];
  h.call=async(name:string,args:any)=>{
    sent.push({name,args});
    if(name==='get_inspection')return {_meta:{[KEY]:{sessionId:'session',serverEpoch:'epoch',sourceToken:'new',
      stateRevision:2,inspectionRevision:0,catalog:{},format:'mmcif',sourceReplacement:{panelId:'panel',previousSourceToken:'old'}}}};
    return {structuredContent:{}};
  };
  h.registerComparisonSources=async()=>{throw Error('GPU failed');};
  installEarlyHydration(h);
  await expect(h.hydrate('session')).rejects.toThrow('GPU failed');
  h.showProblem('GPU failed','loading',Error('GPU failed'));
  expect(h.dirty).toBe(false);
  expect(h.blocked).toBe(false);
  expect(h.savedScene).toEqual(drawn);
  expect(h.failedSourceLoad).toMatchObject({sourceToken:'new',receipt:undefined});
  expect(sent.at(-1)).toMatchObject({name:'report_source_failure',args:{sourceToken:'new'}});
});
