/**
 * The conversational consumer for the Claude Code route: one long-running
 * process that hears the wearer and sends what the terminal agent decides.
 *
 *     tsx scripts/converse.ts <state.json>
 *
 * There is no model in here. Claude Code is the model: this prints what the
 * wearer said as one JSON line each, with the scene as it stood when they said
 * it, and reads JSON commands back on stdin.
 *
 *     out  {"type":"voice","utteranceId":"…","sequence":4,"text":"show me the guide RNA",…}
 *     in   {"tool":"emphasize","args":{"parts":["guide RNA"]}}
 *     out  {"type":"result","tool":"emphasize","receipt":{"status":"rendered"},"rendered":true,…}
 *
 * Every command goes out through `sendAgentCall`, which is the same path
 * `inspection-agent.ts` uses, so the binding is filled in from the current
 * state, a named surface resolves to a panel, an utterance is declared before
 * the command it corrects, and the answer waits for a rendered receipt rather
 * than reporting a queued one. `rendered: true` on a result line is the only
 * thing here that means the wearer saw the change.
 *
 * A voice line carries four times. `at` is when the last of that press's audio
 * reached the Mac, stamped before any recognizer ran; `transcribedAt` is when
 * the recognizer's text was accepted and `recognizerMs` what that run cost;
 * `emittedAt` is when this loop printed the line. So `transcribedAt - at` is
 * recognition and `emittedAt - transcribedAt` is everything after it. `sceneAt`
 * and `sceneAgeMs` say when the scene folded into the line was read, which is
 * beside the poll and therefore a little before the words.
 *
 * Result `timing` separates `transcriptToCommandMs` (until this loop sends the
 * agent's command), `acceptedToRenderedMs` (the host receipt's interval), and
 * `transcriptToRenderedMs` (the complete transcript-to-visible-change
 * interval). All three run from `at`, so they exclude the wearer speaking and
 * include recognition; subtract the line's own `recognizerMs` to take it out.
 * Unmatched utterances, absent receipt timestamps and non-rendered outcomes
 * omit the corresponding durations. `inputQueueMs` records waiting inside this
 * loop. Timestamps are Unix milliseconds; durations are milliseconds.
 *
 * Two loops run at once. The listening loop long-polls `listen_voice`, which
 * blocks on the host for up to its own ceiling and answers early the moment an
 * utterance is ready; the command loop reads stdin, so a correction can be sent
 * while the listener is still waiting. Ordinary commands bind and dispatch in
 * order. Corrections and cancellations bypass their receipt waits and
 * invalidate older buffered work before it acquires a fresh scene binding.
 *
 * The control binding is re-read every call,
 * because the host rotates its token and session ID when it recovers an
 * expired session, and a loop holding the old ones would go deaf at exactly the
 * moment the wearer starts over.
 * Recent transcript timestamps used for timing are forgotten on that rotation.
 */
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { sendAgentCall, RECEIPT_POLL_MS, RECEIPT_WAIT_MS, UTTERANCE_ACTIONS, type ReceiptWait, type UtteranceAction } from './inspection-agent.js';
import { commandReceiptOf, isReceiptPending, isPanelSurface, PANEL_SURFACES, type CommandReceipt, type PanelSurface } from './agent-arguments.js';
import { agentText, callLocalAgent, readControlState, type AgentResult, type ControlState } from './local-agent.js';
import { sameVoiceSession } from './voice-transcript-consumer.js';

/**
 * The listening window, in seconds.
 *
 * `listen_voice` caps `timeoutSeconds` at 25 and defaults to 20. Both numbers
 * are written out here rather than imported, because this script is a plain
 * HTTP client and pulling the contract in would drag the transcriber and its
 * process handling behind it. `test/converse.test.ts` compares the two against
 * the contract's own constants, so they cannot drift apart in silence.
 */
export const LISTEN_WINDOW_SECONDS = 20;
export const LISTEN_CEILING_SECONDS = 25;

/**
 * The shortest a poll-and-answer cycle is allowed to take when nothing was
 * said. The host does the waiting, so an empty answer normally costs a whole
 * window; a host that answers instantly instead would otherwise be polled in a
 * tight loop.
 */
export const IDLE_FLOOR_MS = 250;
/** After a failed poll, back off from one second to thirty rather than spinning. */
export const RETRY_MIN_MS = 1_000;
export const RETRY_MAX_MS = 30_000;

/**
 * How old the scene folded into a voice line is allowed to get.
 *
 * The scene beside a transcript used to be read after the transcript arrived,
 * so every utterance paid a whole `get_inspection_state` round trip before the
 * wearer's words were printed at all. The read runs beside the `listen_voice`
 * long poll instead: while the poll blocks, the snapshot is refreshed whenever
 * it is older than this, and every state reading a dispatched command already
 * makes refreshes it for nothing.
 *
 * So a scene this loop changed itself is always current, and the interval only
 * covers a change made by the headset's own controls or another assistant. Two
 * seconds keeps that inside one spoken sentence; an idle session pays one
 * loopback state read every two seconds to hold it there. The printed line
 * carries `sceneAt` and `sceneAgeMs`, so nobody has to assume the fold was
 * taken at the moment the words were.
 */
export const SCENE_REFRESH_MS = 2_000;

const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));

export type ConverseOptions = {
  statePath: string;
  /** JSON command lines. Defaults to stdin. */
  input?: AsyncIterable<string>;
  /** One JSON line out. Defaults to stdout. */
  write?: (line: string) => void;
  /** Human notes that are not part of the protocol. Defaults to stderr. */
  note?: (line: string) => void;
  listenSeconds?: number;
  wait?: ReceiptWait;
  idleFloorMs?: number;
  /** How old the scene folded into a voice line may get. Defaults to `SCENE_REFRESH_MS`. */
  sceneRefreshMs?: number;
  retry?: { minMs: number; maxMs: number };
  stop?: AbortSignal;
};

/** One command line read from stdin. */
export type ConverseCommand = {
  tool: string;
  args: Record<string, unknown>;
  wait: boolean;
  panel?: PanelSurface;
  utterance?: UtteranceAction;
  id?: string;
};

/**
 * Read one stdin line as a command, or say exactly what is wrong with it.
 *
 * A malformed line is a typo in a live session, not a reason to stop hearing
 * the wearer, so this refuses by returning a sentence rather than throwing.
 */
export function parseCommandLine(line: string): ConverseCommand | { error: string } {
  let parsed: unknown;
  try { parsed = JSON.parse(line); }
  catch { return { error: 'That line is not JSON. Send {"tool":"update_inspection","args":{…}}.' }; }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: 'A command is a JSON object with a tool and its args.' };
  const input = parsed as Record<string, unknown>;
  if (typeof input.tool !== 'string' || input.tool.length === 0) return { error: 'A command needs "tool".' };
  const args = input.args ?? {};
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return { error: `"args" for ${input.tool} has to be a JSON object.` };
  if (input.panel !== undefined && (typeof input.panel !== 'string' || !isPanelSurface(input.panel))) {
    return { error: `"panel" takes ${PANEL_SURFACES.join(', ')}.` };
  }
  if (input.utterance !== undefined
    && (typeof input.utterance !== 'string' || !(UTTERANCE_ACTIONS as readonly string[]).includes(input.utterance))) {
    return { error: `"utterance" takes ${UTTERANCE_ACTIONS.join(', ')}.` };
  }
  return {
    tool: input.tool,
    args: args as Record<string, unknown>,
    // Waiting for the rendered receipt is the point of this loop, so it is on
    // unless a caller deliberately wants the queued answer back at once.
    wait: input.wait !== false,
    ...(input.panel ? { panel: input.panel as PanelSurface } : {}),
    ...(input.utterance ? { utterance: input.utterance as UtteranceAction } : {}),
    ...(typeof input.id === 'string' ? { id: input.id } : {}),
  };
}

/**
 * What is on the panel right now, small enough to sit beside every transcript.
 *
 * The wearer says "make this one orange" and means whatever they were looking
 * at when they pressed the talk control. The referent carries the part they
 * meant; this carries everything else the answer depends on — what is loaded,
 * what is selected, what is lit, and whether a command is still in flight.
 */
export function sceneSummary(structured: unknown): Record<string, unknown> {
  if (structured === null || typeof structured !== 'object') return { hasScene: false };
  const content = structured as Record<string, any>;
  const view = content.view ?? undefined;
  // A normal state read publishes an array, including superseded commands
  // whose render fence still owns a rollback. `command` is only the receipt
  // of an explicitly queried command and can already be terminal.
  const pendingCommands = Array.isArray(content.pendingCommand) ? content.pendingCommand
    : content.command && (isReceiptPending(content.command.status) || content.command.renderFence === true)
      ? [content.command] : [];
  return {
    hasScene: content.hasScene === true,
    source: { kind: content.sourceKind ?? null, modelNumber: content.sourceSelection?.modelNumber ?? null,
      assemblyId: content.sourceSelection?.assemblyId ?? null },
    lesson: content.lesson ?? null,
    selectedResidueCount: view?.selectedResidueCount ?? 0,
    representation: view?.appearance?.representation ?? null,
    emphasis: view?.emphasis ?? null,
    panels: (content.panels ?? []).map((panel: any) => ({ surface: panel.surface ?? null,
      availability: panel.availability ?? null, current: panel.current === true })),
    pendingCommand: pendingCommands[0] ?? null,
    pendingCommands,
  };
}

/** The transcripts one `listen_voice` answer carried, in the shape printed. */
export function voiceLines(answer: unknown, scene: Record<string, unknown>): Record<string, unknown>[] {
  const transcripts = (answer as { transcripts?: any[] } | undefined)?.transcripts ?? [];
  return transcripts.map(entry => ({
    type: 'voice',
    utteranceId: entry.utteranceId ?? null,
    sequence: entry.utteranceSequence ?? null,
    text: String(entry.text ?? '').replace(/\s+/gu, ' ').trim(),
    ...(typeof entry.normalizedText === 'string' ? { normalizedText: entry.normalizedText,
      normalizationRules: entry.normalizationRules ?? [] } : {}),
    at: entry.at ?? null,
    // `at` is when the last of the press's audio reached the Mac,
    // stamped before any recognizer ran. `transcribedAt` is when the words
    // existed, so `transcribedAt - at` is recognition and `emittedAt -
    // transcribedAt` is everything this loop and the host added after it.
    ...(typeof entry.transcribedAt === 'number' ? { transcribedAt: entry.transcribedAt } : {}),
    ...(typeof entry.recognizerMs === 'number' ? { recognizerMs: entry.recognizerMs } : {}),
    ...(entry.durationMs !== undefined ? { durationMs: entry.durationMs } : {}),
    ...(entry.referent !== undefined ? { referent: entry.referent } : {}),
    scene,
  }));
}

/**
 * The commands that are allowed past the queue: a correction or cancellation
 * declared around a command, or a bare utterance lifecycle change. The host
 * invalidates posted work; this client must also drop work still buffered here.
 */
export function isLifecycleCommand(command: ConverseCommand): boolean {
  if (command.utterance === 'correct' || command.utterance === 'cancel') return true;
  const change = (command.args as { change?: { kind?: unknown } } | undefined)?.change;
  return command.tool === 'update_inspection' && change?.kind === 'utterance';
}

type DropReason = 'utterance_cancel' | 'utterance_correct' | 'host_rotated';
class SupersededWork extends Error {
  constructor(readonly reason: DropReason) { super(reason); }
}
type Turn = { invalidated?: DropReason };
type ConversationSession = {
  control: ControlState; sessionId: string; serverEpoch?: string; cursor?: number;
  turn: Turn; queue: Promise<unknown>; transcripts: Map<string, number>;
  /** The last scene reading, and when it was taken. */
  scene?: { summary: Record<string, unknown>; at: number };
  /**
   * The listening cycle in which a response last proved this host is still the
   * one this session is bound to. Only an answer carrying an epoch or a
   * session ID can prove it, and `listen_voice` carries neither. Counted in
   * cycles rather than stamped in milliseconds, because two of these can fall
   * inside one millisecond and a vouch from the cycle before is no vouch.
   */
  vouchedIn?: number;
  /** A refresh already in flight, so two never run at once. */
  sceneRefresh?: Promise<void>;
  receipts: Map<BufferedWork, { commandId: string; panelId?: string; started: number; receipt?: CommandReceipt; line?: Record<string, unknown> }>;
};
type BufferedWork = { command: ConverseCommand; session: ConversationSession; turn: Turn; sent: boolean;
  receivedAt: number; sentAt?: number };

/** Receipt times measure rendering; local times expose time spent before dispatch. */
function commandTiming(work: BufferedWork, startedAt: number, utteranceId: unknown, receipt?: CommandReceipt) {
  const transcriptAt = typeof utteranceId === 'string' ? work.session.transcripts.get(utteranceId) : undefined;
  const timing: Record<string, number> = { commandReceivedAt: work.receivedAt, inputQueueMs: startedAt - work.receivedAt };
  if (transcriptAt !== undefined) timing.transcriptAt = transcriptAt;
  if (work.sentAt !== undefined) timing.commandSentAt = work.sentAt;
  const duration = (key: string, start: unknown, end: unknown) => {
    if (typeof start === 'number' && Number.isFinite(start) && typeof end === 'number'
      && Number.isFinite(end) && end >= start) timing[key] = end - start;
  };
  duration('transcriptToCommandMs', transcriptAt, work.sentAt);
  if (receipt?.status === 'rendered') {
    duration('acceptedToRenderedMs', receipt.acceptedAt, receipt.renderedAt);
    duration('transcriptToRenderedMs', transcriptAt, receipt.renderedAt);
  }
  return timing;
}

function supersedingAction(command: ConverseCommand): 'correct' | 'cancel' | undefined {
  const change = command.args.change as { kind?: unknown; patch?: { action?: unknown } } | undefined;
  const action = command.utterance === 'correct' || command.utterance === 'cancel' ? command.utterance
    : command.tool === 'update_inspection' && change?.kind === 'utterance' ? change.patch?.action : undefined;
  return action === 'correct' || action === 'cancel' ? action : undefined;
}

/** The persistent consumer loop. Returns when `stop` aborts. */
export async function converse(options: ConverseOptions): Promise<void> {
  const write = options.write ?? (line => { process.stdout.write(`${line}\n`); });
  const note = options.note ?? (line => { process.stderr.write(`${line}\n`); });
  const emit = (line: Record<string, unknown>) => write(JSON.stringify(line));
  const listenSeconds = Math.min(options.listenSeconds ?? LISTEN_WINDOW_SECONDS, LISTEN_CEILING_SECONDS);
  // A source load can run past two minutes on this host's
  // own stated budget, and a consumer loop that says nothing for two minutes
  // reads as a hung host. Progress lines go to the note channel, never to the
  // JSON protocol on stdout.
  const configured = options.wait ?? { pollMs: RECEIPT_POLL_MS, timeoutMs: RECEIPT_WAIT_MS };
  const wait: ReceiptWait = { ...configured, progress: configured.progress ?? note };
  const idleFloorMs = options.idleFloorMs ?? IDLE_FLOOR_MS;
  // Floored at a millisecond: a zero-delay heartbeat would spin the loop.
  const sceneRefreshMs = Math.max(1, options.sceneRefreshMs ?? SCENE_REFRESH_MS);
  const retry = options.retry ?? { minMs: RETRY_MIN_MS, maxMs: RETRY_MAX_MS };
  const stop = options.stop;
  const stopped = () => stop?.aborted === true;
  let session: ConversationSession | undefined;
  /** Which listening cycle is open, so a vouch can be read as belonging to it. */
  let listenCycle = 0;
  const invalidate = (target: ConversationSession, reason: DropReason) => {
    target.turn.invalidated = reason;
    target.turn = {};
  };
  const adopt = (state: ControlState, serverEpoch = state.serverEpoch, sessionId = state.sessionId) => {
    if (session) invalidate(session, 'host_rotated');
    return session = { control: state, sessionId, serverEpoch, turn: {}, queue: Promise.resolve(), receipts: new Map(), transcripts: new Map() };
  };
  // Serialize file reads so an earlier read cannot finish late and rotate us
  // back to an obsolete identity. Network requests never hold this queue.
  let readingControl: Promise<unknown> = Promise.resolve();
  const control = (): Promise<ConversationSession> => {
    const next = readingControl.then(async () => {
      const state = await readControlState(options.statePath);
      return session && sameVoiceSession(session.control, state) ? session : adopt(state);
    });
    readingControl = next.catch(() => {});
    return next;
  };
  const assertSession = (target: ConversationSession) => {
    if (target !== session) throw new SupersededWork('host_rotated');
  };
  const acceptResponse = (target: ConversationSession, answer: AgentResult) => {
    assertSession(target);
    const epoch = answer.structuredContent?.serverEpoch;
    const id = answer.structuredContent?.sessionId;
    if ((typeof epoch === 'string' && target.serverEpoch !== undefined && epoch !== target.serverEpoch)
      || (typeof id === 'string' && id !== target.sessionId)) {
      adopt(target.control, typeof epoch === 'string' ? epoch : target.serverEpoch,
        typeof id === 'string' ? id : target.sessionId);
      throw new SupersededWork('host_rotated');
    }
    if (typeof epoch === 'string') target.serverEpoch = epoch;
    // This answer agreed about who the host is, so a batch of
    // speech read in the same cycle can be printed without a read of its own.
    if (typeof epoch === 'string' || typeof id === 'string') target.vouchedIn = listenCycle;
  };
  const assertPending = (work: BufferedWork) => {
    assertSession(work.session);
    if (work.turn.invalidated) throw new SupersededWork(work.turn.invalidated);
  };
  const receiptForEcho = (receipt: CommandReceipt) => ({ ...receipt,
    ...(receipt.status === 'superseded' ? { fenceReleased: receipt.fenceReleased ?? 'pending' } : {}),
  });
  const observeReceipts = (target: ConversationSession, answer: AgentResult) => {
    const state = answer.structuredContent as { command?: unknown; commands?: unknown[];
      lifecycle?: { commands?: unknown[] } } | undefined;
    for (const command of [state?.command, ...(state?.commands ?? []), ...(state?.lifecycle?.commands ?? [])]) {
      const receipt = commandReceiptOf({ command });
      if (!receipt?.status || receipt.status === 'unknown' || isReceiptPending(receipt.status)) continue;
      for (const [work, prior] of target.receipts) {
        if (prior.commandId !== receipt.commandId) continue;
        if (prior.panelId && typeof receipt.panelId === 'string' && prior.panelId !== receipt.panelId) continue;
        // An active follower emits its own terminal result. Retain an observed
        // supersession if the original queued HTTP response arrives after it.
        prior.receipt = receipt;
        if (!prior.line) continue;
        target.receipts.delete(work);
        // wait=false already emitted queued. Echo the host's later lifecycle
        // receipt under the same caller ID, once, without claiming a draw.
        if (receipt.status === 'superseded' || receipt.status === 'cancelled') emit({ ...prior.line,
          receipt: receiptForEcho({ ...(prior.line.receipt as CommandReceipt), ...receipt }),
          text: receipt.reason ?? 'A newer utterance dropped this earlier request. This is not a rendered confirmation.',
          rendered: false, timedOut: false, waitedMs: Date.now() - prior.started,
        });
      }
    }
    // State reads retire receipts the host has already pruned. No additional
    // poll, deadline or history limit is needed for callers using wait=false.
    if (Array.isArray(state?.commands)) {
      const known = new Set(state.commands.map(command => commandReceiptOf({ command })?.commandId));
      for (const [work, prior] of target.receipts) if (prior.line && !known.has(prior.commandId)) target.receipts.delete(work);
    }
  };
  /**
   * Keep the scene fold current without a transcript waiting on it.
   *
   * Every `get_inspection_state` this loop makes, for a binding or a receipt,
   * updates the snapshot, so an active conversation refreshes it for nothing.
   */
  const noteScene = (target: ConversationSession, answer: AgentResult) => {
    if (answer.structuredContent) target.scene = { summary: sceneSummary(answer.structuredContent), at: Date.now() };
  };
  const sceneStale = (target: ConversationSession) =>
    target.scene === undefined || Date.now() - target.scene.at >= sceneRefreshMs;
  /** The last refresh failure already reported, so a broken host says it once. */
  let sceneFailure: string | undefined;
  const refreshScene = (target: ConversationSession): Promise<void> => {
    if (target.sceneRefresh) return target.sceneRefresh;
    const task = (async () => {
      try {
        const reading = await callLocalAgent(target.control, 'get_inspection_state');
        await control();
        acceptResponse(target, reading);
        observeReceipts(target, reading);
        noteScene(target, reading);
        sceneFailure = undefined;
      } catch (error) {
        // A rotated host is the listening loop's own business: it re-reads the
        // control file every cycle and adopts the new identity there.
        if (error instanceof SupersededWork) return;
        const message = error instanceof Error ? error.message : String(error);
        // A failed state read must not lose an otherwise valid transcript, and
        // a host that is down must not print the same sentence every interval.
        if (!stopped() && sceneFailure !== message) { sceneFailure = message; emit({ type: 'error', scope: 'voice', message }); }
      } finally { target.sceneRefresh = undefined; }
    })();
    target.sceneRefresh = task;
    return task;
  };
  /** A wait a finished poll can cut short, so no timer outlives its cycle. */
  const heartbeat = (ms: number) => {
    let cancel: (() => void) | undefined;
    return {
      tick: () => new Promise<void>(done => {
        const timer = setTimeout(() => { cancel = undefined; done(); }, ms);
        cancel = () => { clearTimeout(timer); cancel = undefined; done(); };
      }),
      stop: () => cancel?.(),
    };
  };
  const pending = new Set<Promise<void>>();
  const track = (task: Promise<void>) => {
    pending.add(task);
    void task.then(() => pending.delete(task), () => pending.delete(task));
    return task;
  };

  async function dispatch(work: BufferedWork) {
    const { command, session: target } = work;
    const started = Date.now();
    try {
      await control();
      assertPending(work);
      const outcome = await sendAgentCall(target.control, {
        name: command.tool, arguments: command.args, wait: command.wait,
        ...(command.panel ? { panel: command.panel } : {}),
        ...(command.utterance ? { utterance: command.utterance } : {}),
      }, wait, async (state, name, args, phase) => {
        await control();
        assertSession(target);
        if (phase !== 'receipt') assertPending(work);
        if (phase === 'command') {
          work.sent = true; work.sentAt = Date.now();
          if (typeof args?.commandId === 'string') target.receipts.set(work, { commandId: args.commandId, started,
            ...(typeof args.panelId === 'string' ? { panelId: args.panelId } : {}) });
        }
        const answer = await callLocalAgent(state, name, args);
        await control();
        acceptResponse(target, answer);
        observeReceipts(target, answer);
        // A binding or receipt read is a free scene refresh.
        if (name === 'get_inspection_state') noteScene(target, answer);
        if (phase === 'binding') assertPending(work);
        return answer;
      });
      const observed = target.receipts.get(work);
      const receipt = observed?.receipt ? { ...outcome.receipt, ...observed.receipt } : outcome.receipt;
      const line = {
        type: 'result',
        ...(command.id ? { id: command.id } : {}),
        tool: command.tool,
        ...(typeof outcome.arguments.utteranceId === 'string' ? { utteranceId: outcome.arguments.utteranceId } : {}),
        timing: commandTiming(work, started, outcome.arguments.utteranceId, receipt),
        text: observed?.receipt?.reason ?? agentText(outcome.result),
        ...(outcome.panelId ? { panelId: outcome.panelId } : {}),
        ...(outcome.utterance ? { utterance: outcome.utterance } : {}),
        ...(receipt ? { receipt: receiptForEcho(receipt) } : {}),
        // The one field that means the wearer saw it. Anything else — queued,
        // rendering, cancelled, superseded, unconfirmed, no receipt at all —
        // leaves this false, and a queued command is not a change to report.
        rendered: receipt?.status === 'rendered',
        ...(outcome.scene ? { scene: { settled: outcome.scene.settled, waitedMs: outcome.scene.waitedMs,
          summary: sceneSummary(outcome.scene.reading.structuredContent) } } : {}),
        waitedMs: Date.now() - started,
        timedOut: outcome.receiptTimedOut,
      };
      emit(line);
      if (observed && isReceiptPending(receipt?.status)) observed.line = line;
      else target.receipts.delete(work);
    } catch (error) {
      target.receipts.delete(work);
      if (error instanceof SupersededWork) {
        emit({ type: 'result', ...(command.id ? { id: command.id } : {}), tool: command.tool,
          status: error.reason === 'utterance_cancel' ? 'cancelled' : 'superseded',
          dropped: true, sent: work.sent, reason: error.reason, rendered: false, timedOut: false,
          timing: commandTiming(work, started, command.args.utteranceId),
          text: error.reason === 'host_rotated' ? 'Superseded by a new host session.'
            : error.reason === 'utterance_cancel' ? 'Buffered command cancelled before sending.'
              : 'Buffered command superseded by a correction before sending.',
          waitedMs: Date.now() - started });
        return;
      }
      // The host's own refusal sentence is the useful part; it names the limit.
      emit({ type: 'error', scope: 'command', ...(command.id ? { id: command.id } : {}),
        tool: command.tool, timing: commandTiming(work, started, command.args.utteranceId),
        message: error instanceof Error ? error.message : String(error) });
    }
  }

  async function commandLoop() {
    const input = options.input;
    if (!input) return;
    for await (const raw of input) {
      if (stopped()) return;
      const receivedAt = Date.now();
      const line = raw.trim();
      if (line.length === 0) continue;
      const command = parseCommandLine(line);
      if ('error' in command) { emit({ type: 'error', scope: 'command', message: command.error }); continue; }
      const action = supersedingAction(command);
      const previous = session;
      if (action && previous) invalidate(previous, `utterance_${action}`);
      let target: ConversationSession;
      try { target = await control(); }
      catch (error) {
        emit({ type: 'error', scope: 'command', ...(command.id ? { id: command.id } : {}), tool: command.tool,
          message: error instanceof Error ? error.message : String(error) });
        continue;
      }
      if (action && target !== previous) invalidate(target, `utterance_${action}`);
      const work: BufferedWork = { command, session: target, turn: target.turn, sent: false, receivedAt };
      // A correction or a cancellation exists to reach the host while an older
      // command is still drawing, so it must not queue behind that command's
      // receipt wait. It goes now; ordinary mutations keep their order.
      if (isLifecycleCommand(command)) {
        const lifecycle = track(dispatch(work));
        // Later edits bind only after the replacement has settled. Another
        // correction still bypasses this barrier and can supersede it freely.
        target.queue = Promise.all([target.queue, lifecycle]).then(() => {});
        continue;
      }
      // Reading the next line never waits on this one: a correction typed
      // while this command draws has to be read to be sent. Ordinary commands
      // still run one at a time, in order, through the queue.
      target.queue = track(target.queue.then(() => dispatch(work), () => dispatch(work)));
    }
    await Promise.all(pending);
  }

  async function listenLoop() {
    let backoff = retry.minMs;
    while (!stopped()) {
      const started = Date.now();
      try {
        listenCycle += 1;
        const target = await control();
        // The long poll and the scene read run side by side. The
        // poll blocks on the host until the wearer speaks; while it does, the
        // snapshot that will be folded into the printed line is kept current,
        // so the words are not held behind a round trip started after them.
        const poll = callLocalAgent(target.control, 'listen_voice',
          { timeoutSeconds: listenSeconds, ...(target.cursor === undefined ? {} : { cursor: target.cursor }) });
        const beat = heartbeat(sceneRefreshMs);
        let polled = false;
        const settle = () => { polled = true; beat.stop(); };
        void poll.then(settle, settle);
        const tracking = (async () => {
          while (!polled && !stopped()) {
            // Only a session that has already folded a scene into a line keeps
            // one warm: before the wearer has said anything there is nothing to
            // be current for. Once it does, this reads at the top of every
            // cycle and then on the interval, so by the time words arrive the
            // snapshot is fresh and this host has already answered inside this
            // cycle. Both are what the printed line would otherwise wait for.
            if (target.scene !== undefined && (sceneStale(target) || (target.vouchedIn ?? -1) < listenCycle)) {
              await refreshScene(target);
            }
            if (polled || stopped()) return;
            await beat.tick();
          }
        })();
        const answer = await poll.finally(settle);
        await tracking;
        await control();
        acceptResponse(target, answer);
        if (stopped()) return;
        const structured = (answer.structuredContent ?? {}) as
          { transcripts?: any[]; cursor?: number; listening?: boolean; handover?: unknown };
        const heard = structured.transcripts ?? [];
        for (const entry of heard) {
          const at = typeof entry.at === 'string' ? Date.parse(entry.at) : NaN;
          if (typeof entry.utteranceId === 'string' && Number.isFinite(at)) {
            target.transcripts.set(entry.utteranceId, at);
            // Only recent correlations are useful in a persistent session.
            if (target.transcripts.size > 256) target.transcripts.delete(target.transcripts.keys().next().value!);
          }
        }
        // Two reasons a batch still waits on a state read, and a transcript
        // arriving is neither of them. The first utterance of a session has no
        // snapshot to fold, so it reads once and every later utterance uses
        // what is held. And speech is never printed on the word of a host that
        // has not answered inside this cycle: `listen_voice` carries no epoch,
        // so a host that rotated mid-poll would otherwise be found only after
        // its stale request had been handed to the agent. The refresh running
        // beside the poll normally satisfies this before the words arrive, and
        // this awaits its tail rather than starting anything new.
        if (heard.length > 0 && (target.scene === undefined || (target.vouchedIn ?? -1) < listenCycle)) {
          await refreshScene(target);
        }
        assertSession(target);
        const snapshot = target.scene;
        const scene: Record<string, unknown> = snapshot?.summary ?? { hasScene: false };
        if (typeof structured.cursor === 'number') target.cursor = structured.cursor;
        if (structured.handover !== undefined) emit({ type: 'handover', handover: structured.handover, text: agentText(answer) });
        if (structured.listening === false) emit({ type: 'idle', listening: false, text: agentText(answer) });
        for (const line of voiceLines(structured, scene)) {
          if (!line.text) continue;
          const emittedAt = Date.now();
          // How old the fold is, so nobody reads it as the scene at the instant
          // the words were said.
          emit({ ...line, emittedAt,
            ...(snapshot ? { sceneAt: snapshot.at, sceneAgeMs: emittedAt - snapshot.at } : {}) });
        }
        backoff = retry.minMs;
        const spent = Date.now() - started;
        if (heard.length === 0 && spent < idleFloorMs) await sleep(idleFloorMs - spent);
      } catch (error) {
        if (stopped()) return;
        if (error instanceof SupersededWork) { backoff = retry.minMs; continue; }
        emit({ type: 'error', scope: 'voice', message: error instanceof Error ? error.message : String(error),
          retryInMs: backoff });
        await sleep(backoff);
        backoff = Math.min(backoff * 2, retry.maxMs);
        continue;
      }
    }
  }

  note(`Conversing through ${options.statePath}. Transcripts and receipts print as JSON lines; send {"tool":…,"args":…} on stdin.`);
  await Promise.all([listenLoop(), commandLoop()]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [statePath] = process.argv.slice(2);
  if (!statePath) {
    console.error('Usage: converse.ts /absolute/path/to/host-state.json');
    process.exitCode = 1;
  } else {
    const stopping = new AbortController();
    // Ctrl-C ends the two loops and says so on the same channel everything
    // else went out on, so a reader of the stream knows it stopped rather than
    // that the wearer went quiet.
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.on(signal, () => {
        if (stopping.signal.aborted) process.exit(0);
        stopping.abort();
        process.stdout.write(`${JSON.stringify({ type: 'stopped' })}\n`);
        // The listening poll is blocked on the host for the rest of its
        // window, and nothing it could return now would be acted on.
        process.exit(0);
      });
    }
    const input = createInterface({ input: process.stdin });
    try { await converse({ statePath: resolve(statePath), input, stop: stopping.signal }); }
    catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
    finally { input.close(); }
  }
}
