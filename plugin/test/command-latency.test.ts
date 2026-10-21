// @ts-ignore Shared menu status used by the extracted inspector closure.
import { assistantStatus } from '../../lab/browser-roundtrip/assistant-status.mjs';
// The heartbeat must not be behind the slow half of the beat.
//
// On the second wearer run every first command after an utterance
// expired at its fifteen second deadline and the immediate retry rendered in
// seven, while `spatialContext.ageMs` on the Mac climbed from ten seconds to
// forty-three with the headset holding seventy frames a second. One in-flight
// guard covered the whole of `poll`, so anything slow inside it — a save, a
// re-attach, a hydration, or a `poll_inspection` running out its own fetch
// deadline — suppressed every tick behind it and the queued command was never
// offered to the page. These tests drive the page's real `poll` and `busyBeat`
// on fake timers and hold that line.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import { afterEach, expect, it, vi } from 'vitest';
// @ts-ignore Shared browser state the page and the watchdog both read.
import { createConnectionWatchdog, connectionStatus, setConnectionStatus, LINK_LOST, PAIR_AGAIN } from '../../lab/browser-roundtrip/connection-liveness.mjs';
import { PRIVATE_INSPECTION_META_KEY as KEY } from '../src/inspection-contract.js';
import type { InspectionScene } from '../src/inspection-contract.js';
import { InspectionCommands } from '../src/inspection-commands.js';
import { thrownErrorMessage } from '../src/tool-result.js';
import { companionStartupMessage } from '../src/companion-startup.js';
import { createSaveRetryAdmission } from '../src/inspection-save-retry.js';
import { createPollBackoff } from '../src/inspection-poll-backoff.js';
import { createHeadsetViewStore } from '../src/headset-view.js';

afterEach(() => { setConnectionStatus(); vi.useRealTimers(); });

const inspectorSource = await readFile(new URL('../src/inspector.ts', import.meta.url), 'utf8');
const inspectorAst = ts.createSourceFile('inspector.ts', inspectorSource, ts.ScriptTarget.Latest, true);
const WANTED = ['armPoll', 'beatSuspended', 'registerPollState', 'receivePollDelivery', 'busyBeat', 'poll', 'problemMessage', 'showProblem',
  'showConnectionProblem', 'registerComparisonSources', 'stepAsideWhileHidden'];
const beatFunctions = inspectorAst.statements
  .filter(node => ts.isFunctionDeclaration(node) && WANTED.includes(node.name?.text ?? ''))
  .map(node => node.getText(inspectorAst)).join('\n');
// A missing name would silently stub the behaviour under test out of the page.
for (const name of WANTED) expect(beatFunctions, `${name} is no longer a function declaration`).toContain(`function ${name}`);

type Sent = Record<string, any>;

/**
 * One immersive companion whose renderer is loaded, saved and ready.
 *
 * `slow` is the request the page is legitimately waiting on. Everything else
 * answers at once, so anything that takes time in a test took it because the
 * page waited, not because the fake host did.
 */
function companionPage(options: { slow?: () => Promise<any>; delivery?: () => any; hangFirstBeat?: boolean; capture?: () => any } = {}) {
  const beats: Sent[] = [], calls: string[] = [], received: any[] = [];
  const scene = { representation: 'cartoon' };
  let hung = false;
  const h: any = vm.createContext({
    failedSourceLoad: undefined, pollBackoff: createPollBackoff(() => Date.now(), () => 0.5),
    // Page state the extracted functions read and write.
    closed: false, experiencePreparing: false, pollInFlight: false, beatInFlight: false, beatCompletion: undefined, desktopReceiptInFlight: false, desktopReceiptBeat: undefined, pollTimer: undefined,
    generation: 1, dirty: false, blocked: false, remote: false, loading: false, edits: 0,
    heldComparisons: new Map(), comparisonRegistration: 0,
    binding: { sessionId: 's', serverEpoch: 'e', sourceToken: 't', stateRevision: 1, inspectionRevision: 1 },
    panelId: 'panel', savedScene: scene, pendingReceipt: undefined, pendingReceiptFields: undefined,
    isCompanion: true, repairNeeded: false, nextRepairAt: 0, replyOnThisBeat: false,
    hiddenSince: undefined, steppedAside: undefined, HIDDEN_STEP_ASIDE_MS: 10_000,
    voiceReadyBinding: '', connectionRecoveryLine: '', connectionNotice: false,
    retryHydrationId: undefined, loadErrorDetails: '', problemRetryKind: 'save',
    rendering: Promise.resolve(), saving: Promise.resolve(), connectionWatchdog: undefined,
    saveRetryAdmission: createSaveRetryAdmission(), saveAttempts: 0,
    // Platform.
    Error, JSON, Date, Promise, String, Boolean, Object, CustomEvent, globalThis: {},
    setTimeout, clearTimeout, PRIVATE_KEY: KEY,
    document: { visibilityState: 'visible', body: { dataset: {} }, querySelector: () => undefined },
    app: { getHostCapabilities: () => ({}) },
    // Collaborators, all fast unless the test says otherwise.
    workspace: { snapshot: () => ({ ready: true, interactionActive: false, xrPresenting: true }),
      capture: () => scene, serializeCapture() { return JSON.stringify(this.capture()); },
      viewer: { xr: { spatialContext: () => ({ distance: 1 }) } } },
    expected: () => ({ sessionId: 's', serverEpoch: 'e', sourceToken: 't', baseStateRevision: 1, baseInspectionRevision: 1 }),
    liveAvailability: () => h.blocked || h.dirty ? 'unsaved' : 'ready', tourHeartbeat: () => ({}), tourPlayer: undefined, panelTour: undefined, experiencePlayer: undefined, experienceView: undefined,
    xrStartupReport: () => ({ presenting: true }), isRendererHeartbeatFailure: () => false,
    noteRendererHeartbeat: () => {}, noteAgentPresence: () => {}, assistantStatus, noteNamedViews: () => {},
    receiveSpokenReply: () => {}, recordTalkReplyDelivery: () => {}, requestHeadsetViewCapture: () => {},
    showOutcome: () => {}, retireStaleHud: () => {}, syncHandoff: () => {}, scheduleSave: () => {},
    handoffSpokenRequest: async () => {}, voiceBindingKey: () => 'key',
    followsSourceTransition: () => false, registerComparisonSources: async () => {},
    confirmReceipt: async () => {}, recoverCompanionConnection: async () => true,
    setConnectionStatus, connectionStatus, LINK_LOST, PAIR_AGAIN, thrownErrorMessage, companionStartupMessage,
    clearConnectionProblem: () => { h.connectionWatchdog?.succeeded(); setConnectionStatus(); },
    receive: async (delivery: any) => { received.push(delivery); },
    attach: async () => {}, hydrate: async () => {},
    save: options.slow ?? (async () => {}),
    // The transport. Only `poll_inspection` is modelled; nothing else is sent.
    call: async (name: string, args: Sent) => {
      calls.push(name);
      if (name !== 'poll_inspection') return { structuredContent: {}, _meta: {} };
      // The first beat runs out its own fetch deadline: the exact shape of the
      // hardware failure, where the answer never arrives and the page waits.
      if (options.hangFirstBeat && !hung) { hung = true; return new Promise(() => {}); }
      beats.push(args);
      const delivery = options.delivery?.();
      const headsetViewRequest = options.capture?.();
      return { structuredContent: { attached: true, hasScene: true, sourceToken: 't', serverEpoch: 'e' },
        _meta: { [KEY]: { ...(delivery ? { delivery } : {}), ...(headsetViewRequest ? { headsetViewRequest } : {}) } } };
    },
    // Notice elements.
    notice: blank(), message: blank(), retry: blank(), reload: blank(), pairAgain: blank(),
    details: blank(), detailsText: blank(), outcome: blank(), showHeadsetCaption: () => {},
  });
  h.globalThis = { dispatchEvent: () => true, __stereofoldDiagnostics: undefined };
  vm.runInContext(ts.transpileModule(beatFunctions,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, alwaysStrict: true } }).outputText, h);
  return { h, beats, calls, received };
}
function blank() { return { hidden: true, textContent: '', addEventListener() {}, dataset: {} }; }

it.each(['poll', 'busyBeat'] as const)('%s arms a reoffered capture before renderer work can consume the heartbeat', async route => {
  vi.useFakeTimers();
  const store = createHeadsetViewStore();
  const view = { sessionId: 's', serverEpoch: 'e', sourceToken: 't' };
  const request = store.request();
  const droppedResponse = store.claim('panel', view);
  const page = companionPage({ capture: () => store.claim('panel', view) });
  const received: unknown[] = [];
  page.h.requestHeadsetViewCapture = (value: unknown) => received.push(value);
  if (route === 'busyBeat') page.h.remote = true;
  else page.h.followsSourceTransition = () => true; // Full poll returns from hydrate.
  try {
    await page.h[route](page.h.generation);
    expect(received).toEqual([droppedResponse]);
    expect((received[0] as any).id).toBe(request.id);
  } finally { page.h.closed = true; clearTimeout(page.h.pollTimer); }
});

it('a capture claimed by a lost busy response resolves its real failure on the next heartbeat', async () => {
  const store = createHeadsetViewStore();
  const view = { sessionId: 's', serverEpoch: 'e', sourceToken: 't' };
  const request = store.request();
  const page = companionPage({ capture: () => store.claim('panel', view) });
  const originalCall = page.h.call;
  let lose = true, armed = 0;
  page.h.call = async (...args: unknown[]) => {
    const response = await originalCall(...args);
    if (lose) { lose = false; throw Error('Lost poll response'); }
    return response;
  };
  page.h.requestHeadsetViewCapture = (value: any) => {
    armed++;
    store.submit('s', 'panel', { ...view, requestId: value.id, status: 'failed', reason: 'No immersive frame.' });
  };
  const waiting = store.waitFor(request.id, 1000);
  await page.h.busyBeat(page.h.generation);
  expect(armed).toBe(0);
  await page.h.busyBeat(page.h.generation);
  expect(await waiting).toEqual({ ok: false, reason: 'No immersive frame.' });
  await page.h.busyBeat(page.h.generation);
  expect(armed).toBe(1);
});

it.each(['poll', 'busyBeat'] as const)('%s cannot arm a capture from a changed-source response', async route => {
  vi.useFakeTimers();
  const page = companionPage({ capture: () => ({ id: 'old-view' }) });
  const received: unknown[] = [];
  page.h.requestHeadsetViewCapture = (value: unknown) => received.push(value);
  const originalCall = page.h.call;
  page.h.call = async (...args: unknown[]) => {
    const response = await originalCall(...args);
    response.structuredContent.sourceToken = 'new-source';
    return response;
  };
  try { await page.h[route](page.h.generation); expect(received).toEqual([]); }
  finally { page.h.closed = true; clearTimeout(page.h.pollTimer); }
});

/** A request that is still waiting, and the handle that lets it finish. */
function suspended<T>() {
  let settle!: (value: T) => void;
  const promise = new Promise<T>(resolve => { settle = resolve; });
  return { promise, settle };
}

it.each([
  { visible: true, immersive: false, companion: true, before: 249, interval: 250 },
  { visible: false, immersive: true, companion: true, before: 249, interval: 250 },
  { visible: false, immersive: false, companion: true, before: 999, interval: 1000 },
  { visible: true, immersive: false, companion: false, before: 999, interval: 1000 },
])('uses the active-companion cadence without speeding up idle/embedded pages: %j', async scenario => {
  vi.useFakeTimers();
  const page = companionPage();
  page.h.isCompanion = scenario.companion;
  page.h.document.visibilityState = scenario.visible ? 'visible' : 'hidden';
  page.h.workspace.snapshot = () => ({ ready: true, interactionActive: false, xrPresenting: scenario.immersive });
  page.h.armPoll();
  await vi.advanceTimersByTimeAsync(scenario.before);
  expect(page.beats).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(scenario.interval - scenario.before);
  expect(page.beats).toHaveLength(1);
  page.h.closed = true; clearTimeout(page.h.pollTimer);
});

it('keeps beating on its own cadence while a request that can take a minute is outstanding', async () => {
  vi.useFakeTimers();
  const page = companionPage({ hangFirstBeat: true });
  // The wearer's spoken line is still being rendered on the Mac: its deadline
  // is 55 s, and it must not own the beat for any of them.
  void page.h.call('voice_acknowledgement', {});
  const stuck = page.h.poll();  // its own poll_inspection never answers
  await vi.advanceTimersByTimeAsync(0);
  expect(page.h.pollInFlight).toBe(true);
  expect(page.beats.length).toBe(0);

  await vi.advanceTimersByTimeAsync(300);
  expect(page.beats.length, 'an active companion heartbeat within 300 ms of a stuck poll').toBe(1);
  await vi.advanceTimersByTimeAsync(3_000);
  expect(page.beats.length).toBeGreaterThanOrEqual(4);
  // The renderer is free, so the beat says so and stays eligible for a command.
  expect(new Set(page.beats.map(beat => beat.availability))).toEqual(new Set(['ready']));
  // Each beat still carries the wearer's spatial context, which is what the
  // Mac's `spatialContext.ageMs` reads and what climbed to 43 s on hardware.
  expect(page.beats.at(-1)!.spatialContext).toEqual({ distance: 1 });

  page.h.closed = true; clearTimeout(page.h.pollTimer); void stuck;
});

it('advertises a page waiting on its own save as unsaved, so no command is claimed into it', async () => {
  vi.useFakeTimers();
  const held = suspended<void>();
  const page = companionPage({ slow: () => held.promise,
    delivery: () => ({ commandId: 'c0', panelId: 'panel', claimToken: 'k', change: { kind: 'appearance' } }) });
  page.h.dirty = true;          // the one thing that makes this poll wait on `save`
  const stuck = page.h.poll();  // enters `save` and stays there
  await vi.advanceTimersByTimeAsync(2_100);
  expect(page.beats.length).toBeGreaterThanOrEqual(2);
  expect(new Set(page.beats.map(beat => beat.availability))).toEqual(new Set(['unsaved']));
  await page.h.rendering;
  expect(page.received).toEqual([]);

  held.settle(); page.h.dirty = false;
  page.h.closed = true; clearTimeout(page.h.pollTimer); void stuck;
});

it('claims a command issued during a slow beat well inside its fifteen second deadline', async () => {
  vi.useFakeTimers();
  let queued = false;
  const page = companionPage({ hangFirstBeat: true,
    delivery: () => queued ? { commandId: 'c1', panelId: 'panel', claimToken: 'k', change: { kind: 'appearance' } } : undefined });
  const stuck = page.h.poll();
  await vi.advanceTimersByTimeAsync(0);
  expect(page.h.pollInFlight, 'the first beat is still waiting for its answer').toBe(true);

  // The agent enqueues `update_inspection` while the page is still waiting.
  const enqueuedAt = Date.now();
  queued = true;
  await vi.advanceTimersByTimeAsync(300);
  await page.h.rendering;
  expect(page.received.map((d: any) => d.commandId)).toEqual(['c1']);
  expect(Date.now() - enqueuedAt, 'claimed within half a second').toBeLessThan(500);
  expect(page.h.pollInFlight, 'and the first beat is still waiting').toBe(true);

  page.h.closed = true; clearTimeout(page.h.pollTimer); void stuck;
});

it('never claims a command into a renderer that is mid-command or mid-hydration', async () => {
  vi.useFakeTimers();
  const page = companionPage({ delivery: () => ({ commandId: 'c2', panelId: 'panel', claimToken: 'k', change: { kind: 'appearance' } }) });
  for (const state of ['remote', 'loading'] as const) {
    page.h[state] = true;
    await page.h.poll();
    await page.h.rendering;
    expect(page.beats.at(-1)!.availability, `${state} advertises busy`).toBe('busy');
    expect(page.received).toEqual([]);
    page.h[state] = false;
  }
  // Free again, the same queued command is taken on the next beat.
  await page.h.poll();
  await page.h.rendering;
  expect(page.received.map((d: any) => d.commandId)).toEqual(['c2']);
  page.h.closed = true; clearTimeout(page.h.pollTimer);
});

it('arms the next tick before the beat runs, not after it', async () => {
  vi.useFakeTimers();
  const held = suspended<void>();
  const page = companionPage({ slow: () => held.promise });
  page.h.dirty = true;
  const stuck = page.h.poll();
  await vi.advanceTimersByTimeAsync(0);
  expect(page.h.pollTimer, 'the next tick is armed while this one is still running').toBeDefined();
  held.settle(); page.h.dirty = false; await stuck;
  page.h.closed = true; clearTimeout(page.h.pollTimer);
});

it('still reports a lost link when every beat fails, and clears it when one lands', async () => {
  const page = companionPage();
  let fail = true, at = 0;
  page.h.pollBackoff = createPollBackoff(() => at, () => 0.5);
  page.h.call = async (name: string) => {
    if (fail) throw Object.assign(Error('The companion connection was lost while sending the request.'), { code: 'companion_connection' });
    page.beats.push({ name });
    return { structuredContent: { attached: true }, _meta: { [KEY]: {} } };
  };
  const missed: number[] = [];
  const watchdog = createConnectionWatchdog({ now: () => at, poll: () => page.h.poll(),
    onMissed: () => missed.push(at), active: () => true });
  page.h.connectionWatchdog = watchdog;
  for (at = 0; at <= 16_000; at += 500) { watchdog.frame(); await Promise.resolve(); await Promise.resolve(); }
  expect(missed.length, 'the watchdog reports one lost link at fifteen seconds').toBe(1);
  expect(connectionStatus().line).toBe(LINK_LOST);

  fail = false;
  at += Math.max(500, page.h.pollBackoff.remaining()); watchdog.frame();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(connectionStatus().line).toBe('');
  watchdog.dispose();
  page.h.closed = true; clearTimeout(page.h.pollTimer);
});

/**
 * The measurement: the page's real beat against the host's real command queue.
 *
 * `InspectionCommands` is the thing that expired the wearer's commands, and the
 * fifteen seconds it allows is set where the command is accepted
 * (`inspection-commands.ts:543`). Nothing is stubbed between the two here
 * except the socket, so the number this records is the page's claim latency
 * under the exact failure the Quest showed: the beat in flight when the agent
 * enqueues never gets an answer.
 */
const queueBinding = { serverEpoch: 'epoch', sourceToken: 'source', stateRevision: 4, inspectionRevision: 7 };
const queueExpected = () => ({ serverEpoch: 'epoch', sourceToken: 'source', baseStateRevision: 4, baseInspectionRevision: 7 });
const queueScene: InspectionScene = { sourceSha256: 'a'.repeat(64), modelNumber: 1, assemblyId: '1', selectionKeys: [],
  camera: { mode: 'perspective', fov: 45, position: [0, 0, 10], target: [0, 0, 0], up: [0, 1, 0], radius: 4, radiusMax: 8, fog: 50, clipFar: true, minNear: .1, minFar: 1 },
  inspection: { appearance: { representation: 'cartoon', color: 'chain-id', uniformColor: '#ffffff', background: '#000000', highlightColor: '#ffff00', opacity: 1, labels: true, clipping: 0, fog: 50 },
    placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } } };

it('claims through the real command queue inside the deadline the queue itself sets', async () => {
  vi.useFakeTimers();
  let clock = 1_000_000;
  const commands = new InspectionCommands(() => clock);
  const panelId = commands.attach({ ...queueExpected(), surface: 'companion' }, queueBinding);
  let hung = false;
  const page = companionPage();
  page.h.panelId = panelId;
  page.h.call = async (name: string, args: any) => {
    if (name !== 'poll_inspection') return { structuredContent: {}, _meta: {} };
    if (!hung) { hung = true; return new Promise(() => {}); }   // the beat that never answers
    const answer: any = commands.poll({ ...queueExpected(), panelId, availability: args.availability }, queueBinding);
    return { structuredContent: { attached: answer.attached }, _meta: { [KEY]: { ...(answer.delivery ? { delivery: answer.delivery } : {}) } } };
  };

  const stuck = page.h.poll();
  await vi.advanceTimersByTimeAsync(0);
  expect(page.h.pollInFlight).toBe(true);

  const receipt = commands.enqueue({ ...queueExpected(), panelId, commandId: 'cmd-1',
    change: { kind: 'appearance', patch: { representation: 'molecular-surface' } } } as any, queueBinding, queueScene);
  expect(receipt.status).toBe('queued');
  const acceptedAt = clock;

  let claimedAt: number | undefined;
  for (let step = 0; step < 20 && claimedAt === undefined; step++) {
    clock += 1_000;
    await vi.advanceTimersByTimeAsync(1_000);
    await page.h.rendering;
    if (page.received.length) claimedAt = clock;
  }
  expect(claimedAt, 'the queued command was claimed').toBeDefined();
  const waited = claimedAt! - acceptedAt;
  expect(waited, `claimed after ${waited} ms, deadline 15000 ms`).toBeLessThanOrEqual(2_000);
  expect(commands.summary(queueBinding).commands[0].status).toBe('rendering');
  expect(page.h.pollInFlight, 'and the first beat never answered').toBe(true);

  page.h.closed = true; clearTimeout(page.h.pollTimer); void stuck;
});

/**
 * A hidden Mac tab cannot draw, because the browser stops calling
 * requestAnimationFrame there. On a headset share it asks the host to detach
 * its panel instead of being offered edits for ten seconds of heartbeat grace;
 * the host says whether it agreed (see hidden-mac-tab.test.ts).
 */
function hiddenMacPage(detached: boolean) {
  const page = companionPage();
  page.h.isCompanion = false;
  page.h.document.visibilityState = 'hidden';
  page.h.workspace.snapshot = () => ({ ready: true, interactionActive: false, xrPresenting: false });
  const detaches: Sent[] = [];
  const poll = page.h.call;
  page.h.call = async (name: string, args: Sent) => {
    if (name !== 'detach_inspection') return poll(name, args);
    detaches.push(args);
    return { structuredContent: { detached }, _meta: {} };
  };
  return { ...page, detaches };
}

it('a hidden Mac tab on a headset share detaches its panel once, keeps its panel ID and sends no beat', async () => {
  vi.useFakeTimers();
  const page = hiddenMacPage(true);
  for (let tick = 0; tick < 4; tick++) { await page.h.poll(); await vi.advanceTimersByTimeAsync(1_000); }
  expect(page.detaches).toEqual([expect.objectContaining({ panelId: 'panel', reason: 'hidden', sessionId: 's' })]);
  expect(page.beats, 'a hidden page offers nothing a command could be delivered to').toEqual([]);
  // Kept, so the host's `attached:false` on the next visible beat re-attaches it.
  expect(page.h.panelId).toBe('panel');

  page.h.document.visibilityState = 'visible';
  await page.h.poll();
  expect(page.beats).toHaveLength(1);
  expect(page.beats[0].panelId).toBe('panel');
  page.h.closed = true; clearTimeout(page.h.pollTimer);
});

it('a hidden Mac-only tab asks only within the host grace, then stays idle as before', async () => {
  vi.useFakeTimers();
  const page = hiddenMacPage(false);  // no share: the host keeps the panel
  const hiddenAt = Date.now(), askedAt: number[] = [];
  const ask = page.h.call;
  page.h.call = async (name: string, args: Sent) => { if (name === 'detach_inspection') askedAt.push(Date.now() - hiddenAt); return ask(name, args); };
  await page.h.poll();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(askedAt.length).toBeGreaterThan(1);
  expect(Math.max(...askedAt), 'no request after the ten second grace').toBeLessThanOrEqual(10_000);
  expect(page.beats).toEqual([]);
  page.h.closed = true; clearTimeout(page.h.pollTimer);
});

it('a hidden Mac tab in the middle of a command or holding unsaved work does not detach', async () => {
  const page = hiddenMacPage(true);
  for (const state of ['remote', 'loading', 'dirty', 'blocked', 'experiencePreparing'] as const) {
    page.h[state] = true;
    await page.h.poll();
    page.h[state] = false;
  }
  expect(page.detaches).toEqual([]);
  expect(page.beats).toEqual([]);
  page.h.closed = true; clearTimeout(page.h.pollTimer);
});

it('a hidden headset page and an immersive page keep beating and never detach', async () => {
  const headset = hiddenMacPage(true);
  headset.h.isCompanion = true;
  await headset.h.poll();
  const immersive = hiddenMacPage(true);
  immersive.h.workspace.snapshot = () => ({ ready: true, interactionActive: false, xrPresenting: true });
  await immersive.h.poll();
  for (const page of [headset, immersive]) {
    expect(page.detaches).toEqual([]);
    expect(page.beats).toHaveLength(1);
    page.h.closed = true; clearTimeout(page.h.pollTimer);
  }
});

it('the registered capture sender requires host acknowledgement, including stored failure receipts', async () => {
  const node = inspectorAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'sendHeadsetViewCapture')!;
  expect(inspectorSource).toContain('setHeadsetViewSender(sendHeadsetViewCapture)');
  let response: any = { structuredContent: { accepted: true } };
  const calls: any[] = [];
  const h: any = vm.createContext({ Error, expected: () => ({ sessionId: 's', sourceToken: 't', serverEpoch: 'e' }), panelId: 'panel',
    call: async (...args: any[]) => { calls.push(args); return response; } });
  vm.runInContext(ts.transpileModule(node.getText(inspectorAst), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, h);
  await h.sendHeadsetViewCapture({ requestId: 'capture', status: 'captured', data: 'jpeg' });
  expect(calls[0]).toEqual(['submit_headset_view', { sessionId: 's', sourceToken: 't', serverEpoch: 'e', panelId: 'panel', requestId: 'capture', status: 'captured', data: 'jpeg' }]);
  for (const rejected of [{ isError: true, structuredContent: { accepted: true } }, { structuredContent: { accepted: false } }, { structuredContent: {} }]) {
    response = rejected;
    await expect(h.sendHeadsetViewCapture({ status: 'captured' })).rejects.toThrow(/acknowledge/);
  }
  response = { structuredContent: { accepted: false } };
  await expect(h.sendHeadsetViewCapture({ status: 'failed', reason: 'no frame' })).resolves.toBe(response);
});
