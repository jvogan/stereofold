/**
 * Send one session-bound MCP call to a running standalone host, and read back
 * what it said. No coordinates cross this route.
 *
 *     tsx scripts/inspection-agent.ts <state.json> <tool> [arguments-json]
 *       [--json] [--wait] [--wait-for-host] [--panel desktop|companion|detailed] [--utterance begin|correct|cancel]
 *
 * Tools bound to one exact source and revision pair need `serverEpoch`,
 * `sourceToken`, `baseStateRevision` and `baseInspectionRevision`, and several
 * also need a target `panelId` and a fresh `commandId`. Omit them and this
 * reads `get_inspection_state` first and fills them in; supply any of them and
 * yours is used unchanged, so a deliberate stale-revision call still fails the
 * way it should.
 *
 * `control_tour`, `install_lesson` and `update_inspection` are sent without
 * the two revisions unless you supply them. The host fills them on arrival,
 * and a command waiting for the headset then follows the wearer's placement
 * saves (a grab, a stick nudge, the VR entry seat) instead of conflicting
 * with them; a scientific edit made meanwhile still refuses it.
 *
 * `--panel` names the surface instead of a panel ID, for the calls where the
 * surface is the point: a change meant for the Mac's own tab, or the
 * return-to-desktop view action the server refuses anywhere else. Without it
 * the panel the wearer is looking through wins, as it always has.
 *
 * `--utterance` declares an utterance before the call it wraps and threads the
 * ID the host allocated into it, which is how a correction reaches the queue
 * ahead of the request it corrects instead of racing it. On a headset panel
 * the allocated ID is the agent's own turn: `say_to_headset --utterance begin`
 * is shown and spoken, and a reply bound to that ID is refused as stale once
 * the wearer speaks again or another utterance begins there.
 *
 * The result prints as the host's own sentences, followed by what the command
 * receipt says: a command tool answers `queued`, and only `rendered` means the
 * wearer saw it. `--wait` follows that receipt until it is terminal before
 * printing. A call that replaced the source answers with no receipt at all, and
 * there `--wait` follows the panels back to a saved, ready scene instead.
 * `--json` prints the whole response, which is what to use when reading
 * structured fields.
 */
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { assertAgentRequest, busyPanelRefusal, commandReceiptOf, describeCommandOutcome, describeSource, fillAgentArguments, isPanelSurface,
  isPreDispatchRefusal, isReceiptPending, needsInspectionState, panelOnSurface, sceneSettled, sentAfterBlurNote,
  shouldWaitOutBlur, TOOLS_ACCEPTING_UTTERANCE_ID, PANEL_BLUR_POLL_MS, PANEL_SURFACES,
  type CommandReceipt, type InspectionStateSummary, type PanelSummary, type PanelSurface } from './agent-arguments.js';
import { agentText, callLocalAgent, readControlState, waitForHostRequested, type AgentResult, type ControlState } from './local-agent.js';

/** How a `--wait` run polls for the receipt: often enough to feel live, bounded. */
// Host-only observation; the companion heartbeat and XR frame loop are unchanged.
export const RECEIPT_POLL_MS = 250;
export const RECEIPT_WAIT_MS = 60_000;
/** How long a named surface that is attached but not yet current is waited for. */
export const SURFACE_CURRENCY_WAIT_MS = 3_000;
/**
 * The first slice of a source render that the HOST is asked to wait out.
 *
 * It is deliberately short, and it is no longer the whole wait. A host that
 * blocks inside the tool call for two minutes leaves its caller silent for two
 * minutes, which is worse for an agent than a slightly later answer. So the
 * host is asked for half a minute, and whatever is left of the host's own
 * stated `renderBudgetMs` is followed here, out loud, by polling.
 */
export const SOURCE_RENDER_WAIT_MS = 30_000;
/** How often a long wait says it is still waiting. */
export const WAIT_PROGRESS_MS = 5_000;

/**
 * How a wait is bounded and how it says so.
 *
 * `timeoutMs` is the caller's own patience and remains a floor, never a cap on
 * the host: a host that states a longer budget for the work it is doing is
 * followed to that budget. `progress` is where "still rendering, budget 130 s"
 * goes, so a two-minute wait is never two minutes of silence.
 */
export type ReceiptWait = { pollMs: number; timeoutMs: number; progress?: (line: string) => void };

const positive = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;

/**
 * How much longer to follow a source the host's own wait
 * did not see land.
 *
 * The number comes from the host. `renderWait.budgetMs` is what this host
 * budgets for the structure it just committed — 130 s for the 4,779 sites of
 * 4HHB — and `renderWait.waitedForMs` is how much of it the host already spent
 * inside the call. A host that states no budget is an older one, and gets the
 * caller's own timeout, which is exactly what it got before.
 */
export function renderContinuationMs(input: { budgetMs?: unknown; waitedForMs?: unknown; floorMs: number }): number {
  const budget = positive(input.budgetMs);
  if (budget === undefined) return Math.max(0, input.floorMs);
  return Math.max(0, budget - (positive(input.waitedForMs) ?? 0));
}

/** What a long wait says while it is waiting, in one line. */
export function stillWaitingLine(what: string, waitedMs: number, budgetMs: number): string {
  return `still ${what}, ${(Math.max(0, waitedMs) / 1000).toFixed(0)} s of a ${Math.round(budgetMs / 1000)} s budget the host stated`;
}

/** What `--utterance` can declare, in the words the contract uses. */
export const UTTERANCE_ACTIONS = ['begin', 'correct', 'cancel'] as const;
export type UtteranceAction = typeof UTTERANCE_ACTIONS[number];

const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));

export type AgentInvocation = {
  statePath: string; name: string; payload: string;
  json: boolean; wait: boolean;
  panel?: PanelSurface; utterance?: UtteranceAction;
};

export const USAGE = 'Usage: inspection-agent.ts private-state.json get_inspection_state [arguments-json] '
  + `[--json] [--wait] [--wait-for-host] [--panel ${PANEL_SURFACES.join('|')}] [--utterance ${UTTERANCE_ACTIONS.join('|')}]`;

/**
 * Read the command line, including the two flags that take a value.
 *
 * Written out rather than filtered through a set, because a flag with a value
 * cannot be removed by one: `--panel desktop` would leave `desktop` sitting in
 * the positional list, where it would be read as the tool name.
 */
export function parseAgentArgv(argv: string[]): AgentInvocation {
  const positional: string[] = [];
  let json = false, wait = false;
  let panel: PanelSurface | undefined, utterance: UtteranceAction | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const valueOf = (flag: string): string | undefined => {
      if (argument === flag) {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith('--')) throw Error(`${flag} needs a value. ${USAGE}`);
        index += 1;
        return value;
      }
      return argument.startsWith(`${flag}=`) ? argument.slice(flag.length + 1) : undefined;
    };
    if (argument === '--json') { json = true; continue; }
    if (argument === '--wait') { wait = true; continue; }
    if (argument === '--wait-for-host') continue; // read by waitForHostRequested
    const surface = valueOf('--panel');
    if (surface !== undefined) {
      if (!isPanelSurface(surface)) throw Error(`--panel takes ${PANEL_SURFACES.join(', ')}, not "${surface}".`);
      panel = surface; continue;
    }
    const declared = valueOf('--utterance');
    if (declared !== undefined) {
      if (!(UTTERANCE_ACTIONS as readonly string[]).includes(declared)) throw Error(`--utterance takes ${UTTERANCE_ACTIONS.join(', ')}, not "${declared}".`);
      utterance = declared as UtteranceAction; continue;
    }
    if (argument.startsWith('--')) throw Error(`Unknown flag ${argument}. ${USAGE}`);
    positional.push(argument);
  }
  const [statePath, name, payload = '{}'] = positional;
  if (!statePath || !name) throw Error(USAGE);
  return { statePath, name, payload, json, wait, ...(panel ? { panel } : {}), ...(utterance ? { utterance } : {}) };
}

/**
 * Follow one command's receipt until it stops being pending.
 *
 * Only used with `--wait`, because a command tool answers `queued` by design
 * and a caller that wants the answer immediately should keep getting it. What
 * this changes is that "Applied" can be said at all: it is printed from a
 * `rendered` receipt or not printed.
 */
export async function awaitReceipt(state: ControlState, commandId: string,
  wait: ReceiptWait = { pollMs: RECEIPT_POLL_MS, timeoutMs: RECEIPT_WAIT_MS },
  request = callLocalAgent,
): Promise<{ receipt: CommandReceipt; waitedMs: number; timedOut: boolean }> {
  const started = Date.now();
  // The caller's patience is the floor, and the host's
  // own remaining deadline for this command is what extends it. A queued
  // command has 15 s to reach a panel; one a panel has claimed and is
  // rendering has 120 s from that claim, and a 60 s cap invented here would
  // report "not applied yet" on a command the host was still happily waiting
  // for. `budgetMs` on the polled receipt is that remaining deadline.
  let deadline = started + wait.timeoutMs;
  let said = started;
  let statedBudgetMs = 0;
  let receipt: CommandReceipt = { commandId, status: 'queued' };
  for (;;) {
    if (Date.now() >= deadline) return { receipt, waitedMs: Date.now() - started, timedOut: true };
    await sleep(wait.pollMs);
    const reading = await request(state, 'get_inspection_state', { commandId });
    const polled = commandReceiptOf(reading.structuredContent);
    // A receipt the host has not filed yet reads as `unknown`, which is not a
    // terminal answer: returning on it would report "the command is unknown"
    // for a command that is about to render. Keep waiting for a real status.
    if (!polled || polled.status === undefined || polled.status === 'unknown') continue;
    receipt = polled;
    if (!isReceiptPending(receipt.status)) return { receipt, waitedMs: Date.now() - started, timedOut: false };
    const budget = positive(receipt.budgetMs);
    if (budget !== undefined) {
      statedBudgetMs = budget;
      // Never shortened by the host, only lengthened: a caller that asked to
      // wait longer than the host's deadline is still allowed to.
      deadline = Math.max(deadline, Date.now() + budget);
    }
    if (wait.progress && Date.now() - said >= WAIT_PROGRESS_MS) {
      said = Date.now();
      wait.progress(stillWaitingLine(String(receipt.status ?? 'waiting'), Date.now() - started,
        statedBudgetMs || wait.timeoutMs));
    }
  }
}

/**
 * Follow a replaced source until the panels have drawn and saved it.
 *
 * `replace_inspection_source` and `grow_structure` answer with no command
 * receipt, because nothing was queued: the coordinates were verified and
 * swapped, the saved scene was cleared, and every panel now has to hydrate the
 * new source by itself. Their answer is therefore true and says nothing about
 * what the wearer can see, so a caller that reported the new structure from it
 * was acknowledging before rendering. This is the wait that makes the report
 * honest, on the same bounded budget a receipt gets.
 */
export async function awaitSceneSettled(state: ControlState,
  wait: ReceiptWait = { pollMs: RECEIPT_POLL_MS, timeoutMs: RECEIPT_WAIT_MS },
  source: { expected?: string; replaced?: string } = {},
  request = callLocalAgent,
): Promise<{ settled: boolean; waitedMs: number; reading: AgentResult }> {
  const started = Date.now();
  const deadline = started + wait.timeoutMs;
  let said = started;
  for (;;) {
    const reading = await request(state, 'get_inspection_state');
    const token = (reading.structuredContent as { sourceToken?: unknown } | undefined)?.sourceToken;
    const onNewSource = source.expected !== undefined ? token === source.expected
      : source.replaced === undefined || (typeof token === 'string' && token !== source.replaced);
    if (onNewSource && sourceRenderReceiptOf(reading.structuredContent)?.status==='failed')
      return {settled:false,waitedMs:Date.now()-started,reading};
    if (onNewSource && sceneSettled(reading.structuredContent)) return { settled: true, waitedMs: Date.now() - started, reading };
    if (Date.now() >= deadline) return { settled: false, waitedMs: Date.now() - started, reading };
    // A source load can run past two minutes on a large structure. Saying so
    // every few seconds is the difference between a patient wait and a dead
    // terminal; nothing here shortens the wait.
    if (wait.progress && Date.now() - said >= WAIT_PROGRESS_MS) {
      said = Date.now();
      wait.progress(stillWaitingLine('rendering', Date.now() - started, wait.timeoutMs));
    }
    await sleep(wait.pollMs);
  }
}

/** What a source wait is allowed to say, and never more than it saw. */
export function describeSceneSettled(input: { settled: boolean; waitedMs: number; structured: unknown }): string {
  const waited = `${(input.waitedMs / 1000).toFixed(1)} s`;
  if (input.settled) return `${describeSource(input.structured)} Drawn and saved after ${waited}.`;
  const refusal=sourceRenderReceiptOf(input.structured);
  if(refusal?.status==='failed') return `Not drawn: ${String(refusal.failureReason??refusal.reason??'The renderer refused this source.')}`;
  const panels = ((input.structured as { panels?: { surface?: string; availability?: string }[] } | undefined)?.panels ?? [])
    .map(panel => `${panel.surface ?? 'panel'} ${panel.availability ?? 'unknown'}`).join(', ');
  return `Not drawn yet: the source was replaced but no panel has saved it after ${waited}`
    + `${panels ? ` (${panels})` : ''}. Read get_inspection_state before reporting the new structure.`;
}

/**
 * Fill one call in from the current state, waiting out a blurred headset panel.
 *
 * A headset panel blurs for a few seconds whenever the system puts a dialog in
 * front of the wearer. Re-reading the state and picking the panel up again when
 * it clears is what stops "companion busy" reaching someone who is wearing the
 * headset and watching nothing happen.
 */
export async function bindArguments(state: ControlState, name: string, requested: Record<string, unknown>, request = callLocalAgent):
  Promise<{ arguments: Record<string, unknown>; filled: string[]; waitedMs: number }> {
  if (!needsInspectionState(name, requested)) return { arguments: requested, filled: [], waitedMs: 0 };
  let waitedMs = 0;
  for (;;) {
    const reading = await request(state, 'get_inspection_state');
    const summary: InspectionStateSummary = reading.structuredContent ?? {};
    const chosen = fillAgentArguments(name, requested, summary);
    if (!shouldWaitOutBlur({ blurred: chosen.blurred === true, waitedMs })) {
      // A system dialog can outlast the wait; diagnose the selected panel from
      // this final state read without changing the wait or dispatch decision.
      if (chosen.blurred === true) throw Error(busyPanelRefusal(
        (summary.panels ?? []).filter(panel => panel.panelId === chosen.arguments.panelId),
        `companion busy for ${(waitedMs / 1000).toFixed(1)} s`));
      return { arguments: chosen.arguments, filled: chosen.filled, waitedMs };
    }
    await sleep(PANEL_BLUR_POLL_MS);
    waitedMs += PANEL_BLUR_POLL_MS;
  }
}

/**
 * Declare an utterance, and hand back the ID the host allocated for it.
 *
 * `correct` and `cancel` are how a newer request supersedes the pending ones
 * that came before it, so they have to reach the queue before the replacement
 * command rather than beside it. The ID comes back in `lifecycle.utterance`,
 * and threading it into the wrapped call is what ties the two together; without
 * it the replacement is one more command in the same race. `begin` opens a
 * turn with nothing to supersede, which is how the agent speaks first.
 */
export async function declareUtterance(state: ControlState, action: UtteranceAction, requested: Record<string, unknown>, request = callLocalAgent):
  Promise<{ utteranceId: string; panelId: string; sequence?: number; superseded: number }> {
  const bound = await bindArguments(state, 'update_inspection', {
    change: { kind: 'utterance', patch: { action } },
    ...(typeof requested.utteranceId === 'string' ? { utteranceId: requested.utteranceId } : {}),
    ...(typeof requested.panelId === 'string' ? { panelId: requested.panelId } : {}),
  }, request);
  const answered = await request(state, 'update_inspection', bound.arguments);
  const lifecycle = (answered.structuredContent as { lifecycle?: { utterance?: { utteranceId?: unknown; sequence?: unknown };
    commands?: unknown[] } } | undefined)?.lifecycle;
  const utteranceId = lifecycle?.utterance?.utteranceId;
  if (typeof utteranceId !== 'string') throw Error(`The host recorded the ${action} but returned no utterance ID, so nothing can be threaded into the command.`);
  return { utteranceId, panelId: bound.arguments.panelId as string,
    ...(typeof lifecycle?.utterance?.sequence === 'number' ? { sequence: lifecycle.utterance.sequence } : {}),
    superseded: Array.isArray(lifecycle?.commands) ? lifecycle.commands.length : 0 };
}

/** The sentence an `--utterance` run puts on stderr, beside the filled-in note. */
export function utteranceNote(action: UtteranceAction,
  declared: { utteranceId: string; sequence?: number; superseded: number }): string {
  const sequence = declared.sequence === undefined ? '' : `, sequence ${declared.sequence}`;
  const dropped = declared.superseded === 0 ? ''
    : ` ${declared.superseded} earlier pending command${declared.superseded === 1 ? ' was' : 's were'} dropped, which undoes nothing that already rendered.`;
  return `Utterance ${action}: ${declared.utteranceId}${sequence}.${dropped}`;
}

/**
 * `get_inspection_state` answers with one unchanging sentence, because its
 * content is in the structured fields. Say the two things a person waiting on
 * a panel is actually waiting for.
 */
function stateSummary(result: AgentResult): string {
  const content = result.structuredContent ?? {};
  const panels = (content.panels ?? []) as { surface?: string; availability?: string; current?: boolean }[];
  const described = panels.map(panel => `${panel.surface ?? 'panel'} ${panel.availability ?? 'unknown'}${panel.current ? '' : ' (stale)'}`);
  const command = content.command as { commandId?: string; status?: string } | undefined;
  return [`Saved scene: ${content.hasScene ? 'yes' : 'not yet'}. Panels: ${described.length ? described.join(', ') : 'none'}.`,
    command ? `Command ${command.commandId}: ${command.status}.` : ''].filter(Boolean).join('\n');
}

export type AgentCall = {
  name: string; arguments: Record<string, unknown>;
  wait?: boolean; panel?: PanelSurface; utterance?: UtteranceAction;
};
/**
 * The receipt a source replacement answered with, if the host stated one.
 *
 * An older host that states none leaves the caller exactly where it was: no
 * receipt, and `rendered` false, which is the honest reading of an answer that
 * proves nothing.
 */
export function sourceRenderReceiptOf(structured: unknown): CommandReceipt | undefined {
  if (structured === null || typeof structured !== 'object') return undefined;
  const content = structured as { sourceRenderStatus?: unknown; sourceRenderReceipt?: unknown };
  // The tool answer states one; `get_inspection_state` publishes the rendered
  // one, which is what a caller that outlived the host's wait reads.
  const stated = content.sourceRenderStatus ?? content.sourceRenderReceipt;
  if (stated === null || typeof stated !== 'object') return undefined;
  const record = stated as Record<string, unknown>;
  if (typeof record.status !== 'string') return undefined;
  return { ...record, status: record.status };
}

export type AgentCallOutcome = {
  result: AgentResult;
  /** What was actually sent, binding and panel included. */
  arguments: Record<string, unknown>;
  filled: string[];
  blurWaitedMs: number;
  receipt?: CommandReceipt;
  receiptWaitedMs: number;
  receiptTimedOut: boolean;
  panelId?: string;
  utterance?: { action: UtteranceAction; utteranceId: string; sequence?: number; superseded: number };
  scene?: { settled: boolean; waitedMs: number; reading: AgentResult };
};

/**
 * Tell the wearer about a request this surface refused before dispatch.
 *
 * The refusal is already correct and already on its way to the caller; this is
 * the half that reaches the person who asked for it. `say_to_headset` with a
 * `refusal` draws the card and writes the outcome record on the host, so the
 * wearer's spoken request and a pressed menu row are answered the same way.
 *
 * Nothing here can fail the call it is reporting: a host that is older, busy
 * or gone leaves the original refusal exactly as it was.
 */
export async function reportRefusalToHeadset(state: ControlState, refusal: { tool: string; message: string },
  requested: Record<string, unknown>, request = callLocalAgent): Promise<boolean> {
  try {
    await request(state, 'say_to_headset', {
      text: refusal.message.slice(0, HEADSET_REFUSAL_MAX_CHARS),
      refusal: { tool: refusal.tool, ...(state.sessionId ? { sessionId: state.sessionId } : {}) },
      ...(typeof requested.utteranceId === 'string' ? { utteranceId: requested.utteranceId } : {}),
      ...(typeof requested.commandId === 'string' ? { commandId: requested.commandId } : {}),
    });
    return true;
  } catch { return false; }
}

/**
 * The longest refusal sentence this surface hands to the headset.
 *
 * `say_to_headset` refuses a reply past its own bound rather than shortening
 * it, and a refusal that is itself refused reaches nobody. Host refusal
 * sentences run to about 300 characters; this is well clear of them and well
 * inside the tool's 1200.
 */
export const HEADSET_REFUSAL_MAX_CHARS = 900;

/** Lets a persistent client invalidate pending bindings while still following a posted receipt. */
export type AgentCallTransport = (state: ControlState, name: string, args: Record<string, unknown> | undefined,
  phase: 'binding' | 'command' | 'receipt') => Promise<AgentResult>;

/**
 * One bound call, with the two waits and the two conveniences around it.
 *
 * `main` below prints this and `converse.ts` emits it as JSON, so both routes
 * send the same call and honour the same rule about what a receipt means.
 * Nothing here prints.
 */
export async function sendAgentCall(state: ControlState, call: AgentCall,
  wait: ReceiptWait = { pollMs: RECEIPT_POLL_MS, timeoutMs: RECEIPT_WAIT_MS },
  request: AgentCallTransport = callLocalAgent): Promise<AgentCallOutcome> {
  let sent=false, reported=false;
  try {
    return await sendBoundAgentCall(state,call,wait,async(host,name,args,phase)=>{
      if(phase==='command') sent=true;
      if(name==='say_to_headset' && args?.refusal) reported=true;
      return request(host,name,args,phase);
    });
  } catch(error) {
    // Binding, scope and surface errors can precede dispatch too. Once sent,
    // the host owns refusal delivery; reporting here would duplicate its card.
    if(!sent && !reported && typeof call.arguments.utteranceId==='string')
      await reportRefusalToHeadset(state,{tool:call.name,message:error instanceof Error?error.message:String(error)},
        call.arguments,(host,name,args)=>request(host,name,args,'binding'));
    throw error;
  }
}

async function sendBoundAgentCall(state: ControlState, call: AgentCall, wait:ReceiptWait,
  request:AgentCallTransport):Promise<AgentCallOutcome> {
  const bindingRequest: typeof callLocalAgent = (host, tool, args) => request(host, tool, args, 'binding');
  const receiptRequest: typeof callLocalAgent = (host, tool, args) => request(host, tool, args, 'receipt');
  const { name } = call;
  let requested = call.arguments;
  let utterance: AgentCallOutcome['utterance'];

  // An invalid replacement must retain its own refusal, even when the caller
  // also asked to correct pending work or named an unavailable surface.
  try { if (call.utterance || call.panel) assertAgentRequest(name, requested); }
  catch (error) {
    if (isPreDispatchRefusal(error)) await reportRefusalToHeadset(state, error, requested, bindingRequest);
    throw error;
  }

  // The surface is resolved before anything else fills a panel in, so the
  // panel the caller named is the one every later step uses, the utterance
  // declaration included.
  if (call.panel) {
    if (requested.panelId !== undefined) throw Error('A named surface and a panelId in the arguments name the same thing. Send one of them.');
    // A panel that did not render the last change is current again only when
    // its next heartbeat carries the new revision, about a second later. A
    // surface that is attached but not yet current is waited for, briefly,
    // rather than refused in that second; one that is not there at all is
    // refused at once.
    const started = Date.now();
    let chosen = panelOnSurface(((await bindingRequest(state, 'get_inspection_state')).structuredContent ?? {}).panels, call.panel);
    while ('error' in chosen && Date.now() - started < SURFACE_CURRENCY_WAIT_MS) {
      await sleep(wait.pollMs);
      const panels = ((await bindingRequest(state, 'get_inspection_state')).structuredContent ?? {}).panels as PanelSummary[] | undefined;
      if (!(panels ?? []).some(panel => panel.surface === call.panel)) break;
      chosen = panelOnSurface(panels, call.panel);
    }
    if ('error' in chosen) throw Error(chosen.error);
    requested = { ...requested, panelId: chosen.panelId };
  }

  if (call.utterance) {
    if (!TOOLS_ACCEPTING_UTTERANCE_ID.has(name)) throw Error(`${name} does not take an utteranceId, so there is nothing to thread an utterance into.`);
    const { panelId, ...declared } = await declareUtterance(state, call.utterance, requested,
      (host,tool,args)=>request(host,tool,args,tool==='update_inspection'?'command':'binding'));
    // The host owns a lifecycle refusal too. Treating its mutation as binding
    // reports the same error again and can displace the host's scoped caption.
    // Keep the declaration's exact target while the superseded render rolls
    // back. Re-selecting here would turn its busy heartbeat into a blur wait.
    // A reply names no panel: its utterance ID already says which turn it
    // answers, and say_to_headset's strict schema refuses a panelId.
    requested = { ...requested, ...(name === 'say_to_headset' ? {} : { panelId }), utteranceId: declared.utteranceId };
    utterance = { action: call.utterance, ...declared };
  }

  // A waited source replacement asks the host to wait for the selected
  // renderer's own saved reattachment, so the answer is correlated to the
  // panel that was asked rather than to whichever panel is ready afterwards.
  if (call.wait && name === 'replace_inspection_source' && requested.waitForRenderMs === undefined)
    requested = { ...requested, waitForRenderMs: Math.min(SOURCE_RENDER_WAIT_MS, wait.timeoutMs) };
  const askedRenderMs = typeof requested.waitForRenderMs === 'number' ? requested.waitForRenderMs : 0;
  let bound;
  try { bound = await bindArguments(state, name, requested, bindingRequest); }
  catch (error) {
    // A refusal of the request itself is the wearer's answer, and
    // until now it was only the terminal's. The headset draws it as a refusal
    // card and the host writes the outcome record `read_headset_log` shows,
    // scoped to this session and to the utterance that asked for it
    // Delivery is best effort: a
    // reporting failure must not replace the host's own sentence, and the
    // original refusal is re-thrown either way.
    if (isPreDispatchRefusal(error)) await reportRefusalToHeadset(state, error, requested, bindingRequest);
    throw error;
  }
  const result = await request(state, name, bound.arguments, 'command');

  // What the host handed back is a receipt, not a result: `update_inspection`
  // and every other command tool answer `queued`. Waiting follows it to a
  // terminal status; either way the status reported is the one this run has
  // rather than a claim that the change landed.
  let receipt = commandReceiptOf(result.structuredContent);
  let receiptWaitedMs = 0;
  let receiptTimedOut = false;
  let scene: AgentCallOutcome['scene'];
  const structured = result.structuredContent as { command?: unknown; sceneSettled?: unknown;
    sourceTransition?: { sourceChanged?: unknown }; sourceRenderReceipt?: unknown; sourceRenderStatus?: unknown;
    renderWait?: unknown } | undefined;
  if (call.wait && receipt?.commandId && isReceiptPending(receipt.status)) {
    const followed = await awaitReceipt(state, receipt.commandId, wait, receiptRequest);
    receipt = followed.receipt; receiptWaitedMs = followed.waitedMs; receiptTimedOut = followed.timedOut;
    // Everything a caller reads afterwards comes off this response, `--json`
    // included, so the waited-for receipt replaces the queued one rather than
    // leaving two ages of the same command in one answer.
    if (structured && typeof structured === 'object') structured.command = { ...receipt };
  } else if (call.wait && !receipt && structured?.sourceTransition?.sourceChanged === true) {
    if (structured.renderWait !== undefined || 'sourceRenderReceipt' in structured) {
      // The host waited itself and answered with the selected renderer's own
      // receipt, or with none. That receipt is the only thing that says the
      // new source was drawn; a later scene on some other panel is not.
      const stated=sourceRenderReceiptOf(structured);
      const settled=stated?.status==='rendered' && stated.rendered!==false;
      const failed=stated?.status==='failed';
      const renderWait = (structured.renderWait ?? {}) as { budgetMs?: unknown; waitedForMs?: unknown };
      // The host's slice ran out, not the load.
      //
      // 4HHB is 4,779 atom sites and this host budgets 130 s for it, so a 25 s
      // answer saying "no receipt" is a report about the wait, not about the
      // headset — which is exactly what "go back to hemoglobin" produced on
      // while the wearer watched it render. The remaining budget is
      // the host's own number; nothing here invents one, and a host that
      // states none keeps the old behaviour of answering immediately.
      const continueMs = settled || failed ? 0
        : renderContinuationMs({ budgetMs: renderWait.budgetMs, waitedForMs: renderWait.waitedForMs ?? askedRenderMs, floorMs: 0 });
      if (continueMs > 0) {
        const budgetMs = positive(renderWait.budgetMs) ?? continueMs;
        wait.progress?.(`still rendering, budget ${Math.round(budgetMs / 1000)} s stated by the host; following it`);
        const answered = (structured as { sourceToken?: unknown }).sourceToken;
        scene = await awaitSceneSettled(state, { ...wait, timeoutMs: continueMs },
          typeof answered === 'string' ? { expected: answered } : {}, receiptRequest);
      } else {
        const reading = await receiptRequest(state, 'get_inspection_state');
        scene = { settled, waitedMs: 0, reading };
      }
    } else {
      // An older host that did not wait: the panels are followed instead, and
      // only a scene on the source this call replaced with counts: the one the
      // host named in its answer, or failing that anything but the one before.
      const answered = (structured as { sourceToken?: unknown }).sourceToken;
      scene = await awaitSceneSettled(state, wait, {
        ...(typeof answered === 'string' ? { expected: answered } : {}),
        ...(typeof bound.arguments.sourceToken === 'string' ? { replaced: bound.arguments.sourceToken } : {}) }, receiptRequest);
    }
    if (structured && typeof structured === 'object') structured.sceneSettled = { settled: scene.settled, waitedMs: scene.waitedMs };
    // A source replacement gets a receipt like every other command.
    //
    // `commandReceiptOf` reads `command`, which a replacement has never had, so
    // every swap of the device run left `receipt` undefined and
    // `rendered` false while the host's own sentence said the panel had drawn
    // it. The host now states one `sourceRenderStatus` per replacement, and the
    // `rendered` a caller prints is that receipt's status, not a guess.
    receipt = (scene ? sourceRenderReceiptOf(scene.reading.structuredContent) : undefined)
      ?? sourceRenderReceiptOf(structured) ?? receipt;
  }

  return { result, arguments: bound.arguments, filled: bound.filled, blurWaitedMs: bound.waitedMs,
    ...(receipt ? { receipt } : {}), receiptWaitedMs, receiptTimedOut,
    ...(typeof bound.arguments.panelId === 'string' ? { panelId: bound.arguments.panelId } : {}),
    ...(utterance ? { utterance } : {}), ...(scene ? { scene } : {}) };
}

export async function main(argv: string[], wait: ReceiptWait = { pollMs: RECEIPT_POLL_MS, timeoutMs: RECEIPT_WAIT_MS,
  progress: line => { process.stderr.write(`${line}\n`); } }) {
  const invocation = parseAgentArgv(argv);
  const { name } = invocation;

  // Started in the same breath as the host, this call reaches the control file
  // before the host has written one. `--wait-for-host` is the operator saying
  // so; without it the ENOENT stands, because it is usually the truth.
  const state = await readControlState(invocation.statePath, { waitForHost: waitForHostRequested(argv) });
  const parsed = JSON.parse(invocation.payload) as Record<string, unknown>;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error('The arguments must be a JSON object.');

  const outcome = await sendAgentCall(state, { name, arguments: parsed, wait: invocation.wait,
    ...(invocation.panel ? { panel: invocation.panel } : {}), ...(invocation.utterance ? { utterance: invocation.utterance } : {}) }, wait);

  // stdout is the host's answer; stderr is this command's own bookkeeping, so
  // a caller reading `--json` gets one object and nothing else.
  if (invocation.panel) console.error(`--panel ${invocation.panel} is ${outcome.panelId}.`);
  if (outcome.utterance) console.error(utteranceNote(outcome.utterance.action, outcome.utterance));
  if (outcome.filled.length > 0) console.error(`Filled in from the current inspection state: ${outcome.filled.join(', ')}.`);

  if (invocation.json) { console.log(JSON.stringify(outcome.result)); return; }
  const text = name === 'get_inspection_state' ? stateSummary(outcome.result) : agentText(outcome.result) || `${name} returned no text.`;
  const trailer = [
    outcome.blurWaitedMs > 0 ? sentAfterBlurNote(outcome.blurWaitedMs) : '',
    // `get_inspection_state` already prints the receipt in its own summary;
    // adding this line under it prints the same command twice, at two ages.
    name === 'get_inspection_state' ? ''
      : describeCommandOutcome({ ...outcome.receipt, waitedForReceiptMs: outcome.receiptWaitedMs, timedOut: outcome.receiptTimedOut }),
    outcome.scene ? describeSceneSettled({ settled: outcome.scene.settled, waitedMs: outcome.scene.waitedMs,
      structured: outcome.scene.reading.structuredContent }) : '',
  ].filter(Boolean);
  console.log([text, ...trailer].join('\n'));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
