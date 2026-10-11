/**
 * Fill in the session binding a local tool call needs, so a person driving the
 * standalone host does not have to copy four revision fields by hand.
 *
 * Most tools on the loopback `/agent` route are bound to one exact source
 * capability and one exact pair of revisions: they take `serverEpoch`,
 * `sourceToken`, `baseStateRevision` and `baseInspectionRevision`, and refuse
 * the call when any of them names an older state. `get_inspection_state`
 * returns all four, so the fix is mechanical: read the state, copy the fields
 * across, send the call. That is what this module does.
 *
 * Nothing here relaxes a check. The server still compares every field, so a
 * filled call fails exactly where a hand-assembled one would; it only stops
 * being a transcription exercise. A value the caller supplied always wins,
 * which is what makes a deliberate stale-revision test still possible.
 *
 * The map is written out rather than derived, because this runs as an HTTP
 * client that never sees a schema. `test/agent-arguments.test.ts` rebuilds it
 * from the real server's advertised schemas and fails if the two disagree.
 */
import { randomUUID } from 'node:crypto';
import type { CompanionLoadState } from '../src/inspection-commands.js';
import { classifyPanelAvailability, type AvailabilityCause } from '../src/inspection-contract.js';
import { assertStructureSourceRequest } from '../src/structure-sources.js';

/** Fields carried by `inspectionBindingSchema`, and where each comes from. */
export const BINDING_SOURCES = {
  serverEpoch: 'serverEpoch',
  sourceToken: 'sourceToken',
  baseStateRevision: 'stateRevision',
  baseInspectionRevision: 'inspectionRevision',
} as const;
export type BindingField = keyof typeof BINDING_SOURCES;
export const BINDING_FIELDS = Object.keys(BINDING_SOURCES) as BindingField[];

/** Every tool whose schema requires the whole binding. */
const FULL_BINDING = [
  'acknowledge_experience_step', 'acknowledge_voice_intent', 'acknowledge_voice_playback', 'attach_inspection',
  'claim_voice_intent', 'complete_inspection', 'control_tour', 'detach_inspection', 'emphasize', 'focus_selection',
  'grow_structure', 'import_detailed_view', 'navigate_experience', 'open_companion', 'open_detailed_view', 'poll_inspection', 'replace_inspection_source',
  'report_source_failure', 'resolve_scene_import', 'speak_to_headset', 'submit_headset_view', 'sync_inspection', 'undo_last_change', 'redo_last_change', 'update_inspection',
  'voice_acknowledgement', 'voice_command',
] as const;
/** `manage_companion` is scoped to the source, not to a pair of revisions. */
const SOURCE_ONLY = ['manage_companion'] as const;
/** Tools whose schema also requires an explicit target panel. */
export const TOOLS_NEEDING_PANEL = new Set([
  'acknowledge_experience_step', 'acknowledge_voice_intent', 'acknowledge_voice_playback', 'claim_voice_intent',
  'complete_inspection', 'control_tour', 'detach_inspection', 'emphasize', 'focus_selection', 'grow_structure', 'import_detailed_view', 'navigate_experience',
  'poll_inspection', 'replace_inspection_source', 'report_source_failure', 'report_detailed_selection', 'speak_to_headset', 'submit_headset_view',
  'undo_last_change', 'redo_last_change', 'update_inspection', 'voice_acknowledgement', 'voice_command',
]);
/** Tools whose schema also requires a caller-chosen command ID. */
export const TOOLS_NEEDING_COMMAND_ID = new Set([
  'complete_inspection', 'control_tour', 'emphasize', 'focus_selection', 'import_detailed_view', 'undo_last_change', 'redo_last_change',
  'update_inspection',
]);

const BY_TOOL = new Map<string, readonly BindingField[]>([
  ...FULL_BINDING.map(name => [name, BINDING_FIELDS] as const),
  ...SOURCE_ONLY.map(name => [name, ['serverEpoch', 'sourceToken'] as BindingField[]] as const),
]);

/** What one call has to carry before the server will look at it. */
export type ToolRequirements = { binding: readonly BindingField[]; panel: boolean; commandId: boolean };

/**
 * Tools whose input is a union of branches rather than one object.
 *
 * These are the ones the written map above cannot describe, and the ones its
 * consistency test could not catch either: a zod discriminated union converts
 * to a JSON schema with no properties and no `required` array, so "this tool
 * needs nothing" and "this tool's requirements were dropped in conversion"
 * look identical to an HTTP client that never sees a zod schema.
 * `manage_inspection_view` was the second and read as the first, so save,
 * restore and return-to-desktop left here carrying no binding at all and came
 * back as zod's "expected string, received undefined" (Claude Code probe,
 *). Each branch is therefore written out under the argument that
 * selects it.
 */
export type UnionRequirements = { discriminator: string; branches: Record<string, ToolRequirements> };
const RENDERS: ToolRequirements = { binding: BINDING_FIELDS, panel: true, commandId: true };
export const UNION_TOOLS: ReadonlyMap<string, UnionRequirements> = new Map([
  ['manage_inspection_view', {
    discriminator: 'action',
    branches: {
      // Reading the list is scoped to the session and nothing else.
      list: { binding: [], panel: false, commandId: false },
      save: RENDERS,
      restore: RENDERS,
      // Deleting is checked against the listed viewRevision rather than
      // against a panel, and it draws nothing, so it carries neither.
      delete: { binding: BINDING_FIELDS, panel: false, commandId: false },
      'return-to-desktop': RENDERS,
    },
  }],
]);

/** What this exact call has to carry, branch included. */
export function requirementsFor(name: string, args: Record<string, unknown> = {}): ToolRequirements {
  const union = UNION_TOOLS.get(name);
  if (!union) {
    return { binding: BY_TOOL.get(name) ?? [], panel: TOOLS_NEEDING_PANEL.has(name), commandId: TOOLS_NEEDING_COMMAND_ID.has(name) };
  }
  const chosen = args[union.discriminator];
  const branch = typeof chosen === 'string' ? union.branches[chosen] : undefined;
  if (!branch) {
    throw Error(`${name} needs ${union.discriminator} to be one of ${Object.keys(union.branches).join(', ')}: `
      + 'what the call has to carry depends on it.');
  }
  return branch;
}

/** The binding fields this tool's schema requires, or none. */
export function bindingFieldsFor(name: string, args: Record<string, unknown> = {}): readonly BindingField[] {
  const union = UNION_TOOLS.get(name);
  if (union && args[union.discriminator] === undefined) return [];
  return requirementsFor(name, args).binding;
}

/**
 * Tools whose schema carries `utteranceId`, which is what `--utterance` can
 * thread a freshly declared utterance into. Anything else is told it does not
 * take one, rather than having the field added and refused.
 */
export const TOOLS_ACCEPTING_UTTERANCE_ID: ReadonlySet<string> = new Set([
  'control_tour', 'emphasize', 'focus_selection', 'manage_inspection_view', 'push_to_talk_audio',
  'say_to_headset', 'undo_last_change', 'redo_last_change', 'update_inspection', 'replace_inspection_source',
]);

export type PanelSummary = { panelId: string; surface?: string; availability?: string; current?: boolean;
  registeringRevision?: boolean;
  availabilityCause?: AvailabilityCause; xrStartup?: { presenting?: boolean; sessionVisibility?: string | null; rendererContext?: {status?:string} | null } | null };
type PendingCommandSummary = { panelId?: string; status?: string; renderFence?: boolean };
export type InspectionStateSummary = {
  serverEpoch?: unknown; sourceToken?: unknown; stateRevision?: unknown; inspectionRevision?: unknown;
  panels?: PanelSummary[]; companionInDetailedView?: unknown; companionLoading?: unknown; companionRegistered?: unknown;
  companionLoad?: CompanionLoadState|null;
  sourceRecovery?:{panelId:string;ready:boolean};
  pendingCommand?: PendingCommandSummary[];
};

/**
 * How long a command waits out a blurred headset panel before giving up.
 *
 * A Quest 2 system dialog blurs the wearer's session for two to five seconds at
 * a time. Refusing a command inside one of those windows is what produced "you
 * didn't seem able to do anything" so the caller re-reads the
 * state until the panel is back rather than answering straight away. If it is
 * still busy after this wait, the refusal names the last reported XR condition.
 */
export const PANEL_BLUR_WAIT_MS = 8_000;
export const PANEL_BLUR_POLL_MS = 400;

/** Wording for an existing refusal, using the host's cause or older-host XR telemetry. */
export function busyPanelRefusal(panels: PanelSummary[], description: string): string {
  const busy = panels.filter(panel => panel.current === true && panel.availability === 'busy');
  // Keep visibility advice even when another panel, or the same panel during
  // asynchronous XR teardown, also reports a renderer failure.
  const causes = busy.flatMap(panel => [panel.availabilityCause, classifyPanelAvailability(panel.xrStartup)]);
  const visibilityAdvice = causes.includes('hidden-session')
    ? 'The headset\'s own dialog or guardian has suspended the immersive session. '
      + 'A person must clear it on the headset (press Confirm or reset the boundary). Retrying will not help while the session stays hidden.'
    : causes.includes('blurred')
      ? 'A headset system overlay has focus. Dismiss it on the headset to return focus to the immersive session.' : '';
  const rendererStatuses = busy.map(panel => panel.xrStartup?.rendererContext?.status);
  const rendererAdvice = causes.includes('context-lost') || causes.includes('renderer-error')
    || rendererStatuses.includes('context_lost') || rendererStatuses.includes('error')
    ? 'The molecular renderer lost its graphics context or failed. Wait for recovery; if it does not complete, reopen the same inspection before requesting another visual edit. The host saved scene is retained.'
    : causes.includes('context-recovering') || rendererStatuses.includes('recovering')
      ? 'The renderer is rebuilding its retained scene after graphics context loss. Wait until it reports ready.' : '';
  const advice = [visibilityAdvice, rendererAdvice].filter(Boolean).join(' ') || 'Let the panel finish, then try again.';
  return `No panel is ready for a command right now (${description}). ${advice}`;
}

/** What the wearer is told to do when the headset went to the Mol* detail view. */
// This used to be the whole answer, and it is advice for
// somebody the agent cannot talk to — the wearer's tab is in Mol*, so nothing
// spoken or drawn reaches them, and a wearer could not find
// that control at all. `recall_headset` is the agent's own way to move them.
//
// This is now the narrow case rather than the whole
// answer. The detailed page registers as a panel and draws appearance,
// selection and colour keys itself, so a command it can draw is sent there.
// This is what is left: a change that belongs to the molecule seated in the
// wearer's room, or a page too old to register.
export const IN_DETAILED_VIEW_MESSAGE =
  'The headset is in Mol* detail view, which cannot render this change. Call recall_headset to bring the wearer back '
  + '(they can also press Back to headset view at the top of the Mol* page), then try again. Appearance, selection '
  + 'and lesson colour keys do render there, so send one of those instead if it answers the same question.';

/**
 * What an empty registry means while the headset page loads.
 *
 * The page detaches its panel before it hydrates and cannot register again
 * until the structure has rendered and saved (inspector.ts hydrate). On a Quest
 * 2 that is a second for 9KJ6 and tens of seconds for the microtubule wall
 * stage's 40,908 atom sites. A tour sent inside that window used to be
 * answered by telling the caller to open the printed address in a browser,
 * which is wrong when the page is already open on the headset. This says what
 * is actually happening and that waiting is the thing to do.
 */
export const COMPANION_LOADING_MESSAGE =
  'The headset page is loading this structure and has no panel yet; it registers again once the structure has rendered and saved. Wait for it and try again — a heavy structure takes tens of seconds on a Quest 2.';

/** The three surfaces a panel reports itself as. */
export const PANEL_SURFACES = ['companion', 'desktop', 'detailed'] as const;
export type PanelSurface = typeof PANEL_SURFACES[number];
export function isPanelSurface(value: string): value is PanelSurface {
  return (PANEL_SURFACES as readonly string[]).includes(value);
}

/**
 * The current panel on one named surface.
 *
 * `choosePanel` below decides for a caller who said nothing, and it decides for
 * the wearer: the headset wins whenever there is one. That is the right default
 * and the wrong answer for the two cases where the surface is the point — a
 * change meant for the Mac's own tab, and `manage_inspection_view`'s
 * return-to-desktop, which the server refuses anywhere but a desktop panel. So
 * a caller can name the surface instead of copying a panel ID by hand.
 *
 * Readiness is not part of the choice. A busy panel named by surface is still
 * the panel the caller meant, and the blur wait upstream is what handles it;
 * silently skipping to another surface would be the bug this replaces.
 */
export function panelOnSurface(panels: PanelSummary[] | undefined, surface: PanelSurface): { panelId: string } | { error: string } {
  const live = (panels ?? []).filter(panel => panel.current === true && typeof panel.panelId === 'string');
  const matching = live.filter(panel => panel.surface === surface);
  if (matching.length === 1) return { panelId: matching[0].panelId };
  if (matching.length > 1) return tooManyPanels(matching);
  const seen = live.map(panel => `${panel.surface ?? 'panel'} ${panel.availability ?? 'unknown'}`).join(', ');
  return { error: `No current ${surface} panel is in this inspection${seen ? ` (${seen})` : ''}. Drop --panel to use the panel the wearer is looking through.` };
}

/** The refusal when two panels could equally well take one command. */
function tooManyPanels(candidates: PanelSummary[]) {
  return { error: `Several panels could take this command (${candidates.map(panel => `${panel.surface ?? 'panel'} ${panel.panelId}`).join(', ')}). Name one with panelId.` };
}

/**
 * The panel a command should target when the caller named none.
 *
 * A headset session usually has two current panels, the desktop browser and
 * the companion page the wearer is looking through. The companion wins,
 * because that is the view the person asking for the change is in; a saved
 * scene reaches the other panel through the shared session anyway. Anything
 * ambiguous past that is refused rather than guessed.
 *
 * The headset wins even when it is not ready. A desktop panel is almost always
 * `ready`, because nothing is happening on it, so ranking by readiness first
 * handed the wearer's command to the Mac the moment the headset blurred behind
 * a system dialog or stepped into Mol* — and the agent then reported success
 * for a change nobody in the headset could see. While a headset panel is in
 * the session it is the only candidate: the command waits for it, or the
 * refusal says why. The desktop is a target only when there is no headset.
 */
export function choosePanel(panels: PanelSummary[] | undefined,
  context: { companionInDetailedView?: unknown; companionLoading?: unknown; companionRegistered?: unknown; detailedRenders?: boolean;
    companionLoad?: CompanionLoadState|null;
    interrupting?: boolean; pendingCommand?: PendingCommandSummary[] } = {}):
  { panelId: string; blurred?: boolean } | { error: string } {
  const live = (panels ?? []).filter(panel => panel.current === true && typeof panel.panelId === 'string');
  // A correction must reach the owner of the active render before it finishes.
  // Waiting for that panel to stop reporting busy would wait out the very
  // command being cancelled. A receipt alone never revives a stale/dirty panel
  // or permits retargeting its correction to another ready surface.
  if (context.interrupting) {
    const owners = new Set(context.pendingCommand?.filter(command => typeof command.panelId === 'string'
      && (command.status === 'rendering' || command.renderFence === true)).map(command => command.panelId));
    if (owners.size > 0) {
      const rendering = live.filter(panel => owners.has(panel.panelId)
        && (panel.availability === 'ready' || panel.availability === 'busy'));
      if (rendering.length !== owners.size) return { error: 'The panel rendering the earlier command is unavailable, stale, or has unsaved work. '
        + 'Read get_inspection_state; cancellation will not be retargeted.' };
      return rendering.length > 1 ? tooManyPanels(rendering) : { panelId: rendering[0].panelId };
    }
  }
  const companions = live.filter(panel => panel.surface === 'companion');
  const ready = live.filter(panel => panel.availability === 'ready');
  // The full Mol* viewer is a target now, for the
  // commands it can draw. The wearer standing in it is the person asking, so a
  // ready detailed page beats a desktop panel for exactly the same reason a
  // companion does, and it beats the old "press Back to headset view" answer,
  // which was advice rather than a change they could see.
  const detailed = live.filter(panel => panel.surface === 'detailed' && panel.availability === 'ready');
  if (context.detailedRenders === true && detailed.length > 0 && companions.every(panel => panel.availability !== 'ready')) {
    return detailed.length > 1 ? tooManyPanels(detailed) : { panelId: detailed[0].panelId };
  }
  const seen = () => live.map(panel => `${panel.surface ?? 'panel'} ${panel.availability ?? 'unknown'}`).join(', ');
  const tooMany = tooManyPanels;

  const readyCompanions = companions.filter(panel => panel.availability === 'ready');
  if (readyCompanions.length > 0) {
    return readyCompanions.length > 1 ? tooMany(readyCompanions) : { panelId: readyCompanions[0].panelId };
  }
  if (companions.length > 0 || context.companionInDetailedView === true || context.companionLoading === true || context.companionLoad?.status === 'timed-out') {
    // Keep the existing wait for a busy headset, whether rendering or behind
    // a system dialog. Unsaved work still cannot be a command's base scene.
    const waiting = companions.filter(panel => panel.availability === 'busy');
    if (waiting.length === 1) return { panelId: waiting[0].panelId,
      ...(waiting[0].registeringRevision ? {} : { blurred: true }) };
    if (context.companionInDetailedView === true) return { error: IN_DETAILED_VIEW_MESSAGE };
    // A loading headset page pre-empts the desktop for the same reason a
    // blurred one does: the person asking is wearing the headset, and a change
    // rendered on the Mac is a change nobody in the session can see.
    if (companions.length === 0 && context.companionLoading === true) return { error: COMPANION_LOADING_MESSAGE };
    if (companions.length === 0 && context.companionLoad?.status === 'timed-out') {
      const { budgetMs, lastPanel } = context.companionLoad;
      return { error: `The headset page did not re-register within its ${budgetMs} ms render budget. Last panel ${lastPanel.panelId} was ${lastPanel.availability} at state revision ${lastPanel.stateRevision}, inspection revision ${lastPanel.inspectionRevision}. Read the headset diagnostics before retrying.` };
    }
    return { error: busyPanelRefusal(companions, seen()) };
  }

  // No headset in this session, so the desktop is the only view there is.
  if (ready.length > 0) return ready.length > 1 ? tooMany(ready) : { panelId: ready[0].panelId };
  if (live.length === 0) {
    if (context.companionRegistered === true) return { error: busyPanelRefusal(panels ?? [],
      (panels ?? []).map(panel => `${panel.surface ?? 'panel'} ${panel.availability ?? 'unknown'}`).join(', ')) };
    return { error: 'No panel is showing this inspection. Open the printed address in a browser, let the structure render and save, then try again.' };
  }
  return { error: busyPanelRefusal(live, seen()) };
}

/**
 * Whether the full Mol* viewer can draw this command.
 *
 * It draws the saved picture, so it takes the changes that are pictures of it:
 * appearance, the residue selection, and a lesson's colour key. Placement,
 * camera, motion, framing, tours and render quality belong to the molecule
 * seated in the wearer's room, and the detailed page refuses them by name
 * rather than drawing something that is not what was asked for.
 */
export const DETAILED_VIEW_CHANGES = new Set(['appearance', 'selection', 'emphasis']);
export function drawnInDetailedView(name: string, args: Record<string, unknown>): boolean {
  if (name === 'emphasize') return true;
  if (name !== 'update_inspection') return false;
  const kind = (args.change as { kind?: unknown } | undefined)?.kind;
  return typeof kind === 'string' && DETAILED_VIEW_CHANGES.has(kind);
}

export type Filled = { arguments: Record<string, unknown>; filled: string[]; blurred?: boolean };

/**
 * A refusal of the request itself, raised before it could become a tool call.
 *
 * The host refuses the same requests in the same order and says the same
 * sentence; this surface refuses them one hop earlier so a wearer asking for
 * an insecure URL is told about the URL rather than about a busy panel
 * The consequence found on the
 * Quest 2 is that the sentence reached the terminal and nothing
 * else: no outcome record, no card, nothing the wearer could see
 * The class exists so a caller can
 * tell that refusal apart from a binding failure and hand it to the headset.
 */
export class PreDispatchRefusal extends Error {
  readonly tool: string;
  constructor(tool: string, message: string) {
    super(message);
    this.name = 'PreDispatchRefusal';
    this.tool = tool;
  }
}

/** Whether this error is a refusal of the request, rather than of this surface's state. */
export function isPreDispatchRefusal(error: unknown): error is PreDispatchRefusal {
  return error instanceof PreDispatchRefusal
    || (error instanceof Error && error.name === 'PreDispatchRefusal' && typeof (error as PreDispatchRefusal).tool === 'string');
}

/**
 * The structure request a call carries, for the tools that carry one.
 *
 * Only `replace_inspection_source` does. It takes exactly one of `pdbId` or
 * `source`; the server refuses a call that sends both, and this reads the one
 * the server would read.
 */
function requestedStructureSource(name: string, args: Record<string, unknown>): unknown {
  if (name !== 'replace_inspection_source') return undefined;
  if (args.source !== undefined) return args.source;
  return typeof args.pdbId === 'string' ? { kind: 'pdb', id: args.pdbId } : undefined;
}

/** Validate before choosing a panel or declaring an utterance that cancels work. */
export function assertAgentRequest(name: string, args: Record<string, unknown>): void {
  const requested = requestedStructureSource(name, args);
  if (requested === undefined) return;
  try { assertStructureSourceRequest(requested); }
  catch (error) { throw new PreDispatchRefusal(name, error instanceof Error ? error.message : String(error)); }
}

/**
 * Copy whatever this tool needs and the caller omitted out of an inspection
 * state reading. Returns the fields it filled so a CLI can say what it did.
 *
 * Throws when a panel is required and cannot be chosen without guessing, and —
 * before that — when the request itself is one this surface refuses outright.
 *
 * The order of those two matters. On the Quest 2 a
 * wearer asked to load an `http://` URL while the headset panel was unsaved and
 * heard "No panel is ready for a command right now (companion unsaved, desktop
 * ready)": the panel was consulted first, so the insecure-URL refusal was never
 * reached and the wearer was told about the panel instead of about the limit
 * A request that would be
 * refused whatever the panel is doing is now refused by name, and the readiness
 * refusal is kept for the requests this surface would otherwise have honoured.
 */
export function fillAgentArguments(name: string, args: Record<string, unknown>, state: InspectionStateSummary,
  newCommandId: () => string = () => `cli-${randomUUID()}`): Filled {
  const next = { ...args };
  const needs = requirementsFor(name, next);
  const filled: string[] = [];
  let blurred = false;
  for (const field of needs.binding) {
    if (next[field] !== undefined) continue;
    const value = state[BINDING_SOURCES[field]];
    if (value === undefined || value === null) throw Error(`The host did not report ${BINDING_SOURCES[field]}, so ${name} cannot be bound to the current inspection.`);
    next[field] = value;
    filled.push(field);
  }
  assertAgentRequest(name, next);
  if (needs.panel && next.panelId === undefined) {
    const chosen = name==='replace_inspection_source' && next.mode!=='compare' && state.sourceRecovery?.ready
      ? {panelId:state.sourceRecovery.panelId}
      : choosePanel(state.panels,
      { companionInDetailedView: state.companionInDetailedView, companionLoading: state.companionLoading,
        companionRegistered: state.companionRegistered,
        companionLoad: state.companionLoad,
        detailedRenders: drawnInDetailedView(name, next), pendingCommand: state.pendingCommand,
        interrupting: name === 'update_inspection' && isInterruptingChange(next.change) });
    if ('error' in chosen) throw Error(chosen.error);
    next.panelId = chosen.panelId;
    blurred = chosen.blurred === true;
    filled.push('panelId');
  }
  if (needs.commandId && next.commandId === undefined) {
    next.commandId = newCommandId();
    filled.push('commandId');
  }
  return { arguments: next, filled, ...(blurred ? { blurred: true } : {}) };
}

function isInterruptingChange(change: unknown): boolean {
  const control = change as { kind?: unknown; patch?: { action?: unknown } } | undefined;
  return control?.kind === 'utterance' && (control.patch?.action === 'correct' || control.patch?.action === 'cancel');
}

/**
 * Whether to re-read the inspection state and try this panel again.
 *
 * The state is read once, so a panel that was blurred when it was chosen may
 * already be back. Re-reading until the wait runs out is what turns a refusal
 * into a change the wearer sees.
 */
export function shouldWaitOutBlur(input: { blurred: boolean; waitedMs: number }): boolean {
  return input.blurred && input.waitedMs < PANEL_BLUR_WAIT_MS;
}

/** The sentence that says a command was sent once the wearer's view came back. */
export function sentAfterBlurNote(waitedMs: number): string {
  return `Sent after the headset view came back (blurred for ${(Math.max(0, waitedMs) / 1000).toFixed(1)} s).`;
}

/**
 * Receipt statuses that mean "not yet": the command is accepted and still on
 * its way to a frame. `rendering` is a Quest 2 mid-rebuild, which takes several
 * seconds at best quality and is not an answer either way.
 */
export const RECEIPT_PENDING: ReadonlySet<string> = new Set(['queued', 'claimed', 'rendering']);
export function isReceiptPending(status: string | undefined): boolean {
  return status !== undefined && RECEIPT_PENDING.has(status);
}

export type CommandReceipt = { commandId?: string; status?: string; reason?: string; [field: string]: unknown };

/** The receipt a command tool answered with, from either shape the host returns. */
export function commandReceiptOf(structured: unknown): CommandReceipt | undefined {
  if (structured === null || typeof structured !== 'object') return undefined;
  const command = (structured as { command?: unknown }).command;
  if (command === null || typeof command !== 'object') return undefined;
  const record = command as Record<string, unknown>;
  if (typeof record.status !== 'string' && typeof record.commandId !== 'string') return undefined;
  const { commandId, status, reason, ...publicReceipt } = record;
  return {
    ...publicReceipt,
    ...(typeof commandId === 'string' ? { commandId } : {}),
    ...(typeof status === 'string' ? { status } : {}),
    ...(typeof reason === 'string' ? { reason } : {}),
  };
}

/**
 * What actually happened to a command, in one sentence.
 *
 * The CLI used to print "Applied." for anything it managed to send, which was
 * the one thing it could not know: `update_inspection` returns a *queued*
 * receipt, and only `status: "rendered"` means the wearer saw the change. An
 * agent that reads "Applied" and repeats it is wrong exactly when it
 * matters — a panel that never rendered, a command the page rejected. So the
 * status the host reported is what gets said, and a pending one names the
 * command so the caller can ask again.
 */
export function describeCommandOutcome(input: {
  status?: string; commandId?: string; reason?: string; waitedForReceiptMs?: number; timedOut?: boolean;
}): string {
  const named = input.commandId ? ` ${input.commandId}` : '';
  const because = input.reason ? ` (${input.reason})` : '';
  const waited = input.waitedForReceiptMs ? ` after ${(input.waitedForReceiptMs / 1000).toFixed(1)} s` : '';
  const check = `Read get_inspection_state with commandId${named || ' <id>'} to see how it ends.`;
  if (input.status === undefined) return '';
  if (input.status === 'rendered') return `Applied: the panel rendered${named}${waited}.`;
  if (isReceiptPending(input.status)) {
    const state = input.status === 'rendering' ? 'the panel is drawing it' : 'the panel has not drawn it yet';
    return input.timedOut
      ? `Not applied yet: ${state} and the wait ran out${waited} (${input.status})${because}. ${check}`
      : `Not applied yet: ${state} (${input.status})${because}. ${check}`;
  }
  if (input.status === 'unconfirmed') {
    // `unconfirmed` is also what a panel that detached or timed out mid-render
    // leaves behind, so it cannot be reported as a draw that happened.
    return `Unconfirmed: the panel may have drawn${named} without confirming the save${because}. Read get_inspection_state before reporting a change.`;
  }
  return `Not applied: the command is ${input.status}${named}${because}.`;
}

/** Whether this call needs an inspection-state reading before it can be sent. */
export function needsInspectionState(name: string, args: Record<string, unknown>): boolean {
  // A union tool whose branch the caller has not chosen is read anyway, so the
  // refusal comes from the filler by name rather than from zod by field.
  const union = UNION_TOOLS.get(name);
  if (union && args[union.discriminator] === undefined) return true;
  const needs = requirementsFor(name, args);
  if (needs.binding.some(field => args[field] === undefined)) return true;
  return needs.panel && args.panelId === undefined;
}

/**
 * Whether the panels have caught up with a source that was just replaced.
 *
 * `replace_inspection_source` answers the moment the new coordinates are
 * verified and swapped in, which is several seconds before anything is drawn:
 * it clears the saved scene, and each panel has to hydrate the new source and
 * save it again. Its answer therefore says nothing about what the wearer can
 * see, and reporting the new structure from it is the acknowledge-before-render
 * mistake in another shape. This is the condition that makes the answer true —
 * a saved scene, at least one current panel, and every current panel back to
 * `ready`.
 */
export function sceneSettled(structured: unknown): boolean {
  if (structured === null || typeof structured !== 'object') return false;
  const content = structured as { hasScene?: unknown; panels?: PanelSummary[] };
  if (content.hasScene !== true) return false;
  const live = (content.panels ?? []).filter(panel => panel.current === true);
  return live.length > 0 && live.every(panel => panel.availability === 'ready');
}

/** What is loaded now, in the terms the state reports it: source, model, assembly. */
export function describeSource(structured: unknown): string {
  if (structured === null || typeof structured !== 'object') return 'The host reported no source.';
  const content = structured as { sourceKind?: unknown; sourceSelection?: { modelNumber?: unknown; assemblyId?: unknown };
    lesson?: { title?: unknown } | null };
  const selection = content.sourceSelection ?? {};
  const parts = [
    `source ${typeof content.sourceKind === 'string' ? content.sourceKind : 'unknown'}`,
    `model ${selection.modelNumber ?? 'unknown'}`,
    `assembly ${selection.assemblyId ?? 'unknown'}`,
  ];
  if (content.lesson && typeof content.lesson.title === 'string') parts.push(`lesson ${content.lesson.title}`);
  return `Now loaded: ${parts.join(', ')}.`;
}
