import { registerAppTool as registerHostTool } from '@modelcontextprotocol/ext-apps/server';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { ZodError } from 'zod';
import { molecularLessonSchema, assertLessonSize } from './molecular-lesson.js';

/** Bound applies to the appended text block, including its Markdown fences. */
export const TEXT_STATE_MAX_CHARS = 6_000;
// Increment when the public tool/schema contract changes.
export const TOOL_SET_VERSION = '2026-10-14.demo.1';
const prefix = '```json\n', suffix = '\n```';
const marker = '[truncated]';
export const RECEIPT_TERMINAL_STATUSES = ['rendered', 'saved', 'rejected', 'conflict', 'expired', 'unconfirmed', 'cancelled', 'superseded', 'failed'] as const;
const receiptKeys = new Set(['command', 'commandReplay', 'sourceRenderReceipt', 'sourceRenderStatus', 'detailedRecallReceipt']);
function editableManifest(value: unknown): boolean {
  try { assertLessonSize(value); return molecularLessonSchema.safeParse(value).success; } catch { return false; }
}
type RecordValue = Record<string, any>;

// Only published result fields are candidates. Private metadata, raw scene
// snapshots, coordinate payloads and receipt history never enter this projection.
const fields = `toolSetVersion error kind role retry reason recordPath socketPath sessionId sceneId serverEpoch sourceToken
stateRevision inspectionRevision hasScene hasStructure sourceKind sourceSelection sourceProvenance pdbId shared
commandId command commandReplay sourceRenderStatus sourceRenderReceipt sourceTransition renderWait
measurement measurementId lessonManifest labelChainMapping chapters animation lesson tours panels scene experiences readiness
view visibilityTargets residues experienceCatalog wearer sourceRecovery renderBudgetMs
history namedViews experience experienceTransition experienceCompletion sourceOperation
undone redone focus emphasis style placement operation detailedView detailedImport detailedReturn detailedRecall
companionInDetailedView companionRegistered companionLoading companionLoad detailedViewRecallPending detailedRecallReceipt
customTourId sceneImport preflight choices imported provenanceStatus disclosure
inspector companion lan share shareClosed sharePending headsetPage launch wearerInstructions
readinessStatus modelContext voice voiceDelivery authoringRoute assistants tookOver
mode strength depthBudgetArcmin variant swapEyes swap anaglyph motion look style representation color background opacity action actionId renderToken
conflict diagnostics diagnosticsPanels queued delivered captionId text spoken speechLimit holdSeconds
speech playback playbackId status pending acknowledged cursor transcripts active listening epoch timedOut handover
entries more limit summary captured source sha256 bodies sources atomSites read port target state browser reason detail filePath path width height bytes
saved removed restored name views selected changed applied dropped kept
appearanceReset assemblyId comparison deleted detailedSelection detailedViewAvailable enterVr
experienceAcknowledged experienceReconciled grow handoffMode lifecycle operationInventory outcome panelId
recovery redid refusal rememberedDevices rendererContext restores stale tourBefore undid
utteranceBinding utteranceId viewAction viewId
abandonedSegments activeUtteranceId audible audibleSegments busy captionDrawnMs detached drawn durations
firstAudioMs played segmentCount segments speechReadyMs spokenVia totalSeconds`.split(/\s+/);
const forbidden = /(?:credential|password|secret|private.?key|pairing.?code|device.?key|page.?key|bearer|authorization|cookie|claimToken|accessToken|refreshToken|apiKey|certificate|^token$|^key$|^code$|^url$|^href$|^address$|^addresses$|structureText|coordinates|atomSites|^atoms$|^positions$|^data$|^snapshot$|^definition$|^camera$|cameraPose|spatialContext)/i;
// Guidance belongs in the original prose. Keep state, identifiers and explicit
// failure diagnostics here, rather than repeating advisory sentences as data.
const advisory = /^(?:notes?|advice|instructions?|wearerInstructions|nextSteps?|nextAction|remedy|remediation)$/i;
const failedStatus = /^(?:failed|rejected|conflict|unconfirmed|expired|cancelled|timed-out|error)$/;

function safeString(value: string): string {
  // Diagnostics can quote a connection URL or a source payload. Neither belongs
  // in the text projection, even when nested under an otherwise public field.
  if (/-----BEGIN [^-]*PRIVATE KEY-----|_atom_site\.|(?:^|\n)(?:ATOM  |HETATM)/.test(value)) return '[excluded]';
  return value.replace(/(?:https?|wss?):\/\/[^\s<>"']+/gi, '[connection omitted]')
    .replace(/\b(?:Bearer\s+\S+|(?:pairing[ _-]?code|password|secret|api[ _-]?key|token)\s*[:=]\s*\S+)/gi, '[credential omitted]');
}

function safe(value: any, key = '', failure = false): any {
  // An editable manifest is schema-validated authored data, not diagnostic
  // metadata. Its coordinates describe a volume; its URLs cite public sources.
  // Return a copy so bounding the text cannot mutate structuredContent.
  if (key === 'lessonManifest' && molecularLessonSchema.safeParse(value).success) return structuredClone(value);
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return safeString(value);
  if (Array.isArray(value)) return value.map(item => safe(item, key, failure)).filter(item => item !== undefined);
  if (!value || typeof value !== 'object') return undefined;
  const diagnostics = failure || ['error','errors'].includes(key) || failedStatus.test(value.status);
  // Source identities are useful; source text and connection routes are not.
  const entries = key === 'source'
    ? Object.entries(value).filter(([name]) => ['kind', 'id', 'pdbId', 'accession', 'sha256', 'handle'].includes(name))
    : Object.entries(value);
  const result = Object.fromEntries(entries.filter(([name, item]) => {
    if (advisory.test(name)) return false;
    if (!diagnostics && /^(?:detail|message|reason)$/.test(name)) {
      // Machine-readable reason codes still describe readiness and recovery.
      if (name !== 'reason' || typeof item !== 'string' || !/^[a-z][a-z0-9_-]*$/.test(item)) return false;
    }
    if ((name === 'atoms' && key === 'measurement') || (name === 'code' && key === 'errors')) return true;
    if (name === 'atomSites' && typeof item === 'number') return true;
    return (name === 'key' && ['rows', 'candidates', 'atoms'].includes(key)) || !forbidden.test(name);
  }).map(([name, item]) => [name, safe(item, name, diagnostics)]).filter(([, item]) => item !== undefined));
  if (receiptKeys.has(key) || (typeof value.commandId === 'string' && typeof value.status === 'string')) {
    const statuses = key === 'detailedRecallReceipt' ? ['returned', 'expired'] : RECEIPT_TERMINAL_STATUSES;
    const terminal = statuses.includes(value.status) || value.rendered === true;
    return { ...result, terminal };
  }
  return result;
}

function pick(value: RecordValue, keys: string[]) {
  return Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
}

export function textStateProjection(value: RecordValue, isError = false): RecordValue {
  // Receipt and binding fields precede optional catalogs so a large catalog
  // cannot displace the operation the caller explicitly asked to confirm.
  const result: RecordValue = {};
  for (const key of fields) {
    if (value[key] === undefined || key in result) continue;
    if (key === 'commandId') result.commandId = value.commandId;
    else if (key === 'panels' && Array.isArray(value.panels)) {
      result.panels = value.panels.map((panel: RecordValue) => pick(panel,
        ['panelId', 'surface', 'availability', 'current', 'inspectionRevision', 'tour', 'animation']));
    } else if (key === 'lesson' && value.lesson) {
      result.lesson = { ...pick(value.lesson, ['id', 'title']),
        parts: value.lesson.parts?.map((part: RecordValue) => pick(part, ['id', 'label'])) };
    } else result[key] = value[key];
  }
  if (typeof value.command?.commandId === 'string') result.commandId = value.command.commandId;
  // Placement remains a room transform; molecular coordinates are excluded.
  if (value.view?.placement) {
    result.placement = value.view.placement;
    const { placement: _placement, ...view } = result.view;
    result.view = view;
  }
  const panels = result.panels?.filter((panel: RecordValue) => panel.current && panel.availability !== 'unsaved' && panel.surface !== 'detailed') ?? [];
  const targetPanel = result.panels?.find((panel: RecordValue) => panel.panelId === (value.command?.panelId ?? value.wearer?.panelId))
    ?? panels.find((panel: RecordValue) => panel.surface === 'companion')
    ?? panels.find((panel: RecordValue) => panel.surface === 'desktop') ?? panels[0];
  return safe({ ...pick(result, ['error', 'kind', 'sessionId', 'serverEpoch', 'sourceToken', 'stateRevision', 'inspectionRevision',
    'role', 'retry', 'hasScene', 'sourceProvenance', 'measurement', 'measurementId', 'residues', 'lessonManifest', 'source', 'sha256', 'bodies', 'sources', 'labelChainMapping', 'atomSites', 'bytes', 'commandId', 'command', 'commandReplay', 'sourceRenderStatus', 'sourceRenderReceipt']),
    ...(targetPanel ? { targetPanel } : {}),
    ...pick(result, ['animation', 'placement', 'lesson', 'tours', 'panels']), ...result }, '', isError);
}

/** Remove trailing values, never cut JSON syntax or turn a partial ID into an ID. */
function trimLast(value: RecordValue | any[]): boolean {
  if (Array.isArray(value)) return value.length > 0 ? (value.pop(), true) : false;
  const keys = Object.keys(value);
  const key = keys.at(-1);
  if (key === undefined) return false;
  const child = (value as RecordValue)[key];
  // A partial manifest must never look like an editable lesson.
  if (key !== 'lessonManifest' && !receiptKeys.has(key) && child && typeof child === 'object' && !('terminal' in child) && trimLast(child)) return true;
  delete value[key];
  return true;
}

export function textStateBlock(value: RecordValue, isError = false): string {
  const data = textStateProjection(value, isError);
  if (data.lessonManifest !== null) delete data.lessonManifest;
  const envelope = { textStateVersion: 1, toolSetVersion: value.toolSetVersion ?? TOOL_SET_VERSION, maxChars: TEXT_STATE_MAX_CHARS, truncated: false,
    truncationMarker: marker, terminalStatuses: RECEIPT_TERMINAL_STATUSES, ...(isError ? { isError: true } : {}),
    lessonManifestNotice: value.lessonManifest == null ? undefined : editableManifest(value.lessonManifest)
      ? 'Complete editable lessonManifest is in the separate JSON block.'
      : 'Lesson manifest omitted: invalid or exceeds the 262144-byte contract; no editable manifest was returned.' };
  const encode = () => prefix + JSON.stringify({ ...envelope, ...data }) + suffix;
  if (value.lessonManifest != null && !editableManifest(value.lessonManifest)) envelope.truncated = true;
  let block = encode();
  while (block.length > TEXT_STATE_MAX_CHARS && trimLast(data)) {
    envelope.truncated = true;
    block = encode();
  }
  return block;
}

export function withTextState<T extends { structuredContent?: RecordValue; content?: any[]; isError?: boolean }>(answer: T): T & { content: any[] } {
  // Forwarded results can already carry this block. Rebuild it from the final
  // structured result, after receipt waits and proxy forwarding have settled.
  const content = (answer.content ?? []).flatMap(item => {
    if (item.type !== 'text') return [item];
    // Legacy handlers sometimes print their JSON after a prose line. Strip
    // those duplicate objects; the blocks below carry state and the complete requested manifest.
    let raw = item.text;
    try { if (typeof JSON.parse(raw) === 'object') return []; } catch { /* prose */ }
    const prose = raw.replace(/```json\n[\s\S]*?\n```/g, '').split('\n').filter((line: string) => {
      try { const parsed = JSON.parse(line); return !parsed || typeof parsed !== 'object'; }
      catch { return true; }
    }).join('\n');
    return prose.trim() ? [{ ...item, text: prose }] : [];
  });
  const data: RecordValue = { ...answer.structuredContent, ...(answer.isError ? { error: {
    message: content.filter(item => item.type === 'text').map(item => item.text).join('\n'),
  } } : {}) };
  const manifest = editableManifest(data.lessonManifest)
    ? [{ type: 'text', text: prefix + JSON.stringify({ lessonManifest: data.lessonManifest }) + suffix }] : [];
  return { ...answer, content: [...content, ...manifest, { type: 'text', text: textStateBlock(data, answer.isError) }] };
}

/**
 * The prose a thrown tool error leaves for the caller.
 *
 * A validation error's message is its issue list as JSON, which `withTextState`
 * drops as a duplicate state object, so the caller saw an empty error. Name the
 * first failing field instead.
 */
export function thrownToolMessage(error: unknown): string {
  if (error instanceof ZodError) {
    const issue = error.issues[0];
    return `Invalid ${issue?.path.length ? issue.path.join('.') : 'request'}: ${issue?.message ?? 'validation failed'}.`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Append at the MCP boundary; internal render transports retain their shape. */
export const registerTextTool: typeof registerHostTool = ((server: any, name: string, config: any, handler: any) =>
  registerHostTool(server, name, config, (async (...args: any[]) => {
    const visible = (config._meta?.ui?.visibility ?? ['model']).includes('model');
    try {
      const answer = await handler(...args);
      return visible ? withTextState(answer) : answer;
    } catch (error) {
      if (!visible || (error instanceof McpError && error.code === ErrorCode.UrlElicitationRequired)) throw error;
      // Match the SDK's error prose, then expose the same failure to text-only
      // hosts. App-only tools retain the SDK's original error handling.
      return withTextState({ isError: true, content: [{ type: 'text', text: thrownToolMessage(error) }] });
    }
  }) as any)) as typeof registerHostTool;
