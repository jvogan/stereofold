import { assistantStatus } from '../assistant-status.mjs';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(new URL('../../../plugin/package.json', import.meta.url));
const { transpileModule, ScriptTarget, ModuleKind } = require('typescript');
export const inspectorSource = readFileSync(new URL('../../../plugin/src/inspector.ts', import.meta.url), 'utf8');
// Receive's refusal path uses the production receipt normalizer as well as
// the inspector closure. Load its real dependency without a browser I/O shim.
const errorSource = readFileSync(new URL('../../../plugin/src/tool-result.ts', import.meta.url), 'utf8');
const errorStart = errorSource.indexOf('export function thrownErrorMessage(');
const errorModule = { exports: {} };
vm.runInNewContext(transpileModule(errorSource.slice(errorStart), { compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS } }).outputText,
  { exports: errorModule.exports, Error });
const receiptModule = { exports: {} };
vm.runInNewContext(transpileModule(readFileSync(new URL('../../../plugin/src/inspection-failure-receipt.ts', import.meta.url), 'utf8'),
  { compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS } }).outputText,
  { exports: receiptModule.exports, require: name => {
    if (name !== './tool-result.js') throw Error(`Unexpected receipt dependency ${name}`);
    return errorModule.exports;
  }, Error });
const settleModule = {exports:{}};
vm.runInNewContext(transpileModule(readFileSync(new URL('../../../plugin/src/inspection-render-settle.ts',import.meta.url),'utf8'), {compilerOptions:{target:ScriptTarget.ES2022,module:ModuleKind.CommonJS}}).outputText,{exports:settleModule.exports,Date,Error,Promise,setTimeout});
const backoffModule = { exports: {} };
vm.runInNewContext(transpileModule(readFileSync(new URL('../../../plugin/src/inspection-poll-backoff.ts', import.meta.url), 'utf8'),
  { compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS } }).outputText,
  { exports: backoffModule.exports, Date, Math });

/** Execute the production navigation and heartbeat closures; adapt only page/HTTP I/O. */
export function journeyNavigationHarness(overrides = {}) {
  const context = vm.createContext({ Promise, Error, Date, performance, localInteractionSerial:0, recordHeadsetEvent() {},
    panelEntering:settleModule.exports.panelEntering, sameEntryScene:settleModule.exports.sameEntryScene,
    inspectionFailureReceipt: receiptModule.exports.inspectionFailureReceipt,
    pollBackoff: backoffModule.exports.createPollBackoff(() => (overrides.Date ?? Date).now()),
    binding: { sessionId: 'session', serverEpoch: 'epoch', sourceToken: 'source', stateRevision: 1, inspectionRevision: 1 },
    panelId: 'panel', dirty: false, blocked: false, loading: false, remote: false, generation: 0, closed: false,
    experiencePreparing: false, experienceSourceChanged: false, tourCommandContext: undefined, experienceView: undefined,
    beatInFlight: false, beatCompletion: undefined, desktopReceiptInFlight: false, desktopReceiptBeat: undefined, isCompanion: false, replyOnThisBeat: false, PRIVATE_KEY: 'private',
    rendering: Promise.resolve(), save: async () => {}, attach: async () => {},
    workspace: { snapshot: () => ({ ready: true, interactionActive: false }),
      viewer: { inspection: { captureXrRecoveryFrame: () => undefined } } },
    panelTour: undefined, tourHeartbeat: () => undefined, beatSuspended: () => false,
    heldComparisons: new Map(), comparisonRegistration: 0, noteNamedViews() {}, clearConnectionProblem() {}, noteRendererHeartbeat() {}, noteAgentPresence() {}, assistantStatus, waitForPanelRender:settleModule.exports.waitForPanelRender, receiveSpokenReply() {},
    isRendererHeartbeatFailure: () => false, showConnectionProblem: () => false, retireStaleHud() {},
    showProblem: message => { throw Error(message); }, problemMessage: (_kind, error) => error.message,
    thrownErrorMessage: error => error.message,
    savedScene: {}, pendingReceipt: undefined, pendingReceiptFields: undefined, narrationGeneration: 0,
    tourCommandReceipt: undefined, notice: {}, outcome: {}, recordLoopStage() {}, showOutcome() {}, speakRemoteConfirmation() {},
    sourceLoadOutcome: undefined, failedSourceLoad: undefined,
    // These navigation fixtures do not drive the history buttons. Retain the
    // inspector's request bookkeeping dependency without replacing its call.
    sceneHistoryClient: { requestStarted: () => 0, note() {} },
    // `hydrate` reaches the coordinates through one of two
    // transports. These contexts drive the INLINE one, which is what the
    // headset uses and what their in-memory servers answer with, so the chunk
    // assembler is a no-op here. The chunk route has its own tests in
    // plugin/test/inspection-chunked-hydration.test.ts.
    HYDRATION_TRANSPORT: {},
    hydrateInspectionBytes: async () => {},
    ...overrides,
  });
  context.expected = () => ({ sessionId: context.binding.sessionId, serverEpoch: context.binding.serverEpoch,
    sourceToken: context.binding.sourceToken, baseStateRevision: context.binding.stateRevision,
    baseInspectionRevision: context.binding.inspectionRevision });
  context.liveAvailability = () => context.dirty || context.blocked ? 'unsaved' : context.loading ? 'busy' : 'ready';
  // `hydrate` draws the wearer's Waiting and Applied for a source
  // load through these three, so every context that runs it carries them. They
  // route through whatever `showOutcome` the context holds.
  for (const name of ['navigateExperience', 'busyBeat', 'confirmReceipt', 'receive',
    'registerComparisonSources', 'registerPollState', 'receivePollDelivery', 'beginSourceLoadOutcome', 'finishSourceLoadOutcome', 'failSourceLoadOutcome']) {
    if (Object.hasOwn(overrides, name)) continue;
    let start = inspectorSource.indexOf(`async function ${name}(`);
    if (start < 0) start = inspectorSource.indexOf(`function ${name}(`);
    if (start < 0) throw Error(`Missing production closure ${name}`);
    const source = inspectorSource.slice(start, inspectorSource.indexOf('\n}\n', start) + 2);
    vm.runInContext(transpileModule(source, { compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.None } }).outputText, context);
  }
  return context;
}
