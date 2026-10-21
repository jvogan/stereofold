import { registerTextTool as registerHostTool } from './tool-text-state.js';
import { createPreparedCompositeStore } from './prepared-composite.js';
import { MAX_STRUCTURE_SOURCE_BYTES, STRUCTURE_SOURCE_SIZE_LABEL } from './inspection-limits.js';
import { resolveStructureSource, inspectionSource, type StructureSourceRequest, type StructureSelection, type ResolvedStructureSource } from './structure-sources.js';
import { registerInspection } from './inspection-server.js';
import type { DeviceCaptureHooks } from './headset-view-device.js';
import type { DevtoolsTransport } from './headset-devtools.js';
import type { Opener, OpenerSpawn, Runner } from './quest-launch.js';
import type { VoiceTranscriber } from './inspection-voice.js';
import { pushToTalkTranscriberFromEnv, type PushToTalkTranscriber } from './push-to-talk-transcribe.js';
import { replyAudioFromEnv } from './headset-voice-provider.js';
import { oauthTranscriptionState } from './oauth-voice-transcription.js';
import type { ReplyAudioSynthesizer } from './headset-reply-audio.js';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { constants } from 'node:os';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { abortable } from './abortable.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { LocalSceneService } from './scene-service.js';
import { DEPTH_FIXTURE_ID, DEPTH_FIXTURE_PDB } from './depth-fixture.js';
import { DEFAULT_LOOK_COLOR, DEFAULT_LOOK_STYLE, type LookColor, type LookStyle } from './look.js';
import { createPanelReportStore, type PanelSummary } from './panel-reports.js';
import { PRIVATE_STRUCTURE_META_KEY } from './structure-result.js';
import {
  claimActionInputSchema,
  completeActionInputSchema,
  controlInputSchema,
  getStateInputSchema,
  getStructureInputSchema,
  openInputSchema,
  parseControlInput,
  parseOpenInput,
  reportDiagnosticsInputSchema,
  sessionIdSchema,
  setMotionInputSchema,
  setModeInputSchema,
  syncViewInputSchema,
  type DiagnosticsPayload,
} from './schemas.js';

export const APP_RESOURCE_URI = 'ui://stereo-structure/viewer';
export const SERVER_NAME = 'Stereofold';

/**
 * Claude Science reads these automatic viewer-binding fields from a tool's
 * `_meta`. This binding describes the `structureText`
 * input, never a tool result.
 *
 * `nameParam` is deliberately omitted: `stereo_structure.open` has no
 * `filename` input and its strict schema would reject an advertised parameter.
 */
export const CLAUDE_SCIENCE_VIEWER_BINDING = {
  opensMimeTypes: ['chemical/x-pdb', 'chemical/x-mmcif'],
  opensExtensions: ['.pdb', '.ent', '.cif', '.mmcif'],
  contentParam: 'structureText',
  contentEncoding: 'utf8',
  promptHint: 'Open PDB or mmCIF coordinates in the Stereofold Mol* viewer.',
} as const;

type MotionPayload = {
  mode: 'none' | 'rock' | 'spin' | 'parallax';
  amplitudeDeg?: number;
  periodS?: number;
  axis?: 'y' | 'x';
};

/** Coordinates are retained only in an app-only session cache. */
type StructureCache = {
  structureText: string;
  format: 'pdb' | 'mmcif';
  pdbId?: string;
  fixture?: 'three-depth-markers';
  sourceKind?: StructureSourceRequest['kind'];
  sourceFilename?: string;
  sourceSelection?: StructureSelection;
};

/** State that is safe to return to a model. */
type StereoState = {
  mode: 'off' | 'parallel' | 'cross' | 'anaglyph';
  depthBudgetArcmin: number;
  swapEyes: boolean;
  variant: 'balanced' | 'dubois';
  motion: MotionPayload;
  color: LookColor;
  style: LookStyle;
  pdbId?: string;
};

/** Model-visible state result: deliberately no coordinate-bearing fields. */
type ViewerPayload = StereoState & {
  sourceKind?: StructureSourceRequest['kind'];
  kind: 'open' | 'control' | 'state' | 'mode' | 'motion' | 'view' | 'diagnostics' | 'action_claim' | 'action_complete';
  /** Opaque capability the caller passes to every later call. */
  sessionId: string;
  /** Random per-server lifecycle identity for render/state ordering. */
  serverEpoch: string;
  /** Whether the session has coordinates available through app-only get_structure. */
  hasStructure: boolean;
  /** Monotonic per-session revision of all render-affecting safe state. */
  stateRevision: number;
  /**
   * Server-instance monotonic ordering marker on structure-bearing results.
   * Panels use it to discard an older delayed render result before it can
   * reclaim a reused frame. It is not a model/user state-control input; an
   * app panel returns it only to the private action lease/ack tools when an
   * advertised reset/fit needs one-shot execution.
   */
  renderToken?: number;
  /** App-only sync write was rejected because its base snapshot was stale. */
  conflict?: boolean;
  /**
   * What a source-bearing legacy call did to a live headset share.
   *
   * Present only when the session being loaded into is shared. `kept` says the
   * wearer still has a link and `sourceToken` is the one to use from now on,
   * because a new structure means a new attachment and the token read before
   * the call is spent. It is never absent on a shared session: a load that
   * ended the share says so here rather than answering with a plain success.
   */
  share?: {
    kept: boolean;
    sourceToken?: string;
    previousSourceToken?: string;
    wearerPanelId?: string;
    note: string;
  };
  action?: string;
  /** Server-issued identity for a one-shot reset/fit action. */
  actionId?: string;
  /** Whether an app-only action claim acquired the latest execution lease. */
  claimed?: boolean;
  /** Whether the matching leased action completed and cleared its identity. */
  completed?: boolean;
  diagnostics?: DiagnosticsPayload;
  diagnosticsPanels?: PanelSummary[];
};

/** Private component-only coordinate hydration payload. */
type StructurePayload = {
  kind: 'structure';
  sessionId: string;
  /** Matches the server lifecycle that issued the enclosing render result. */
  serverEpoch: string;
  empty: boolean;
  structureText?: string;
  format?: 'pdb' | 'mmcif';
  pdbId?: string;
  fixture?: 'three-depth-markers';
  color: LookColor;
  style: LookStyle;
  mode: 'off' | 'parallel' | 'cross' | 'anaglyph';
  depthBudgetArcmin: number;
  swapEyes: boolean;
  variant: 'balanced' | 'dubois';
  motion: MotionPayload;
  /** Matches the safe state snapshot carried with these private coordinates. */
  stateRevision: number;
};

/** A camera command that can be claimed exactly once after successful hydration. */
type PendingRenderAction = {
  action: 'reset_camera' | 'fit';
  actionId: string;
  /** Render results that actually advertised this action to a panel. */
  advertisedRenderTokens: Set<number>;
  /** The newest render invocation currently allowed to execute this action. */
  leaseRenderToken?: number;
};

type StereoSession = {
  /** Server lifecycle that owns this retained in-memory session bucket. */
  serverEpoch: string;
  state: StereoState;
  /** Monotonic safe-state freshness marker, independent of source/render order. */
  stateRevision: number;
  structureCache?: StructureCache;
  panelReports: ReturnType<typeof createPanelReportStore<DiagnosticsPayload>>;
  /** Monotonic source request generation; never returned to callers. */
  sourceRevision: number;
  /** One-shot camera command advertised by opens and claimed app-only after hydration. */
  pendingAction?: PendingRenderAction;
};

type SessionEntry<T> = {
  value: T;
  lastUsedAt: number;
};

/** One in-flight external source request for a retained session. */
type SourceLoadReservation = {
  revision: number;
  settled: Promise<void>;
  settle(): void;
};

/** Conservative bounds: preserve active multi-panel sessions without retaining them forever. */
export const DEFAULT_SESSION_TTL_MS = 30 * 60_000;
export const DEFAULT_MAX_SESSIONS = 64;

/**
 * A small capability-keyed LRU/TTL store.
 *
 * MCP's stdio transport exposes no reliable conversation identity to a tool
 * handler, so a connection-wide default bucket would leak state between
 * conversations. The only key here is the opaque server-issued sessionId.
 */
class SessionStore<T> {
  private readonly entries = new Map<string, SessionEntry<T>>();
  /** Told of each session this store drops, by expiry or for capacity. */
  onEvict: ((sessionId: string) => void) | undefined;

  constructor(
    private readonly now: () => number,
    private readonly ttlMs: number,
    private readonly maxSessions: number,
    private readonly createId: () => string,
  ) {}

  get(sessionId: string): T | undefined {
    this.pruneExpired();
    const entry = this.entries.get(sessionId);
    if (entry == null) return undefined;
    entry.lastUsedAt = this.now();
    // Map order is our deterministic LRU tie-breaker when a coarse/fake clock
    // gives several accesses the same millisecond. Refresh it on every read,
    // not only on writes, so a touched session survives capacity eviction.
    this.entries.delete(sessionId);
    this.entries.set(sessionId, entry);
    return entry.value;
  }

  create(value: T): string {
    this.pruneExpired();
    this.evictToCapacity();
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const sessionId = this.createId();
      if (!sessionIdSchema.safeParse(sessionId).success) {
        throw new Error('Stereofold session ID factory returned a non-UUID value.');
      }
      if (this.entries.has(sessionId)) continue;
      this.entries.set(sessionId, { value, lastUsedAt: this.now() });
      return sessionId;
    }
    throw new Error('Stereofold could not allocate a unique session ID.');
  }

  /** Drop every expired session now, rather than when the store is next asked. */
  sweep(): void {
    this.pruneExpired();
  }

  /** Whether a session is still held, asked without counting as a use of it. */
  has(sessionId: string): boolean {
    this.pruneExpired();
    return this.entries.has(sessionId);
  }

  replace(sessionId: string, value: T): boolean {
    this.pruneExpired();
    const entry = this.entries.get(sessionId);
    if (entry == null) return false;
    entry.value = value;
    entry.lastUsedAt = this.now();
    this.entries.delete(sessionId);
    this.entries.set(sessionId, entry);
    return true;
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [sessionId, entry] of this.entries) {
      if (now - entry.lastUsedAt >= this.ttlMs) this.drop(sessionId);
    }
  }

  private evictToCapacity(): void {
    while (this.entries.size >= this.maxSessions) {
      let oldestId: string | undefined;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [sessionId, entry] of this.entries) {
        if (entry.lastUsedAt < oldestAt) {
          oldestId = sessionId;
          oldestAt = entry.lastUsedAt;
        }
      }
      if (oldestId == null) return;
      this.drop(oldestId);
    }
  }

  private drop(sessionId: string): void {
    this.entries.delete(sessionId);
    // The entry is already gone; a listener's failure is the listener's.
    try { this.onEvict?.(sessionId); } catch { /* nothing here to undo */ }
  }
}

/** Everything a headset launch touches outside this process. */
export type QuestLaunchSeams = { platform?: string; environment?: NodeJS.ProcessEnv; opener?: string; launch?: Opener; run?: Runner; find?: () => string | undefined; clipboardSpawn?: OpenerSpawn };

export interface StereoStructureServerOptions {
  /** Substitute the RCSB fetcher in tests; production uses HTTPS fetch below. */
  fetchPdbText?: (pdbId: string, signal?:AbortSignal) => Promise<string>;
  /** Test injection for non-RCSB remote sources; injected responses are never disk-cached. */
  sourceFetch?: typeof fetch;
  /** Composite cache location override for isolated tests. */
  compositeCachePath?: (file: string) => string;
  /** Test seam for deterministic TTL/LRU behavior. */
  now?: () => number;
  /** Idle-session lifetime; defaults to 30 minutes. */
  sessionTtlMs?: number;
  /** Maximum retained sessions; defaults to 64. */
  maxSessions?: number;
  /** Test seam; production creates cryptographically random UUIDs. */
  sessionIdFactory?: () => string;
  /** Explicit in-process test seams; production leaves OAuth voice helpers intact. */
  voice?: { transcribe?: VoiceTranscriber; acknowledge?: (message: string) => Promise<{ wavBase64: string }> };
  /** Test seam for headset push-to-talk audio; production reads the environment. */
  transcriber?: PushToTalkTranscriber;
  /** Test seam for putting the companion on the headset; production opens the real browser or adb. */
  questLaunch?: QuestLaunchSeams;
  /** Test seam for the Mac-rendered headset reply audio; production reads the environment. */
  replyAudio?: ReplyAudioSynthesizer;
  /**
   * The shared local scene this server may join.
   *
   * Supply one to put two servers on the same scene inside one test process;
   * production builds its own, which stays silent until a host asks to
   * continue a session or opens a Wi-Fi share.
   */
  sceneService?: LocalSceneService;
  /** Where the shared-scene runtime record lives; production uses the per-user file. */
  sceneServiceFile?: string;
  /** Test seam for the sandbox loopback probe used by continue_session. */
  loopbackListenDenied?: () => Promise<boolean>;
  /**
   * Test seam for the adb screencap headset still.
   *
   * A test that leaves this unset and lets `capture_headset_view` fall through
   * to the device would read the display buffer of whatever headset is
   * actually attached to the machine running the test. Every test that can
   * reach that branch supplies this or passes `source: "page"`.
   */
  headsetDevice?: DeviceCaptureHooks;
  /**
   * The Quest Browser debugger transport, for `read_headset_browser`.
   *
   * Same hazard as `headsetDevice`: a test that leaves this unset reaches the
   * forwarded loopback port and reads whatever headset is attached to the
   * machine running the test. Every test that can reach that branch supplies
   * one.
   */
  headsetDevtools?: DevtoolsTransport;
  /** Where `STEREOFOLD_BRIDGE_DIR` is read from; production uses this process's environment. */
  environment?: NodeJS.ProcessEnv;
}

function normalizedPositiveInteger(value: number | undefined, fallback: number): number {
  if (value == null || !Number.isFinite(value) || value < 1) return fallback;
  return Math.max(1, Math.floor(value));
}

function createInitialState(): StereoState {
  return {
    mode: 'off',
    depthBudgetArcmin: 20,
    swapEyes: false,
    variant: 'balanced',
    motion: { mode: 'rock' },
    color: DEFAULT_LOOK_COLOR,
    style: DEFAULT_LOOK_STYLE,
  };
}

function createSession(serverEpoch: string): StereoSession {
  return {
    serverEpoch,
    state: createInitialState(),
    stateRevision: 0,
    panelReports: createPanelReportStore<DiagnosticsPayload>(),
    sourceRevision: 0,
  };
}

function result(payload: ViewerPayload) {
  return {
    content: [{ type: 'text' as const, text: 'Stereofold session state updated.' }],
    structuredContent: payload,
  };
}

/**
 * The coordinate payload lives only in result metadata. App-only visibility
 * prevents the model from invoking this tool, but does not make its
 * `structuredContent` private once a host has produced a result.
 */
function structureResult(payload: StructurePayload) {
  return {
    content: [{
      type: 'text' as const,
      text: payload.empty
        ? 'Stereofold has not opened a structure in this session yet.'
        : 'Stereofold returned this session’s cached structure to the viewer.',
    }],
    structuredContent: {
      kind: payload.kind,
      sessionId: payload.sessionId,
      serverEpoch: payload.serverEpoch,
      empty: payload.empty,
      stateRevision: payload.stateRevision,
    },
    _meta: { [PRIVATE_STRUCTURE_META_KEY]: payload },
  };
}

export async function fetchPdbText(pdbId: string,signal?:AbortSignal): Promise<string> {
  return (await resolveStructureSource({kind:'pdb',id:pdbId},{signal})).structureText;
}

/**
 * Validate a fetched RCSB document before it can replace a session cache.
 *
 * Network success is not enough: a proxy/login page or a mocked malformed
 * response can be HTTP 200 and still be unusable.  The application loads PDB
 * fetches as mmCIF, whose minimal recognizable shape is a `data_` block with
 * atom-site fields.  Pasted coordinates intentionally use their own broader
 * schema and never pass through this check.
 */
function assertRcsbMmcifPayload(pdbId: string, text: string): void {
  if (Buffer.byteLength(text, 'utf8') > MAX_STRUCTURE_SOURCE_BYTES) {
    throw new Error(`The structure is larger than the ${STRUCTURE_SOURCE_SIZE_LABEL} source policy; this is not a measured rendering limit.`);
  }
  const trimmed = text.trimStart();
  if (
    text.length < 20
    || !trimmed.startsWith('data_')
    || !/_atom_site\./.test(trimmed)
  ) {
    throw new Error(`Stereofold received an unsupported mmCIF payload for PDB ${pdbId}.`);
  }
}

function viewerMetadata(options: { fileBinding?: boolean } = {}) {
  return {
    ui: {
      resourceUri: APP_RESOURCE_URI,
      // The bundle is inline; blob: permits Mol* worker/object-URL internals.
      // data: is required for Mol*'s own textures.
      csp: { resourceDomains: ['blob:', 'data:'] },
      prefersBorder: false,
    },
    ...(options.fileBinding ? { 'operon.dev/viewer': CLAUDE_SCIENCE_VIEWER_BINDING } : {}),
  };
}

function stateResult(
  kind: ViewerPayload['kind'],
  sessionId: string,
  session: StereoSession,
  extras: Pick<ViewerPayload, 'action' | 'actionId' | 'claimed' | 'completed' | 'renderToken' | 'conflict' | 'diagnostics' | 'diagnosticsPanels'> = {},
): ViewerPayload {
  const { pdbId, ...stateWithoutPdbId } = session.state;
  return {
    kind,
    sessionId,
    serverEpoch: session.serverEpoch,
    hasStructure: session.structureCache != null,
    ...(session.structureCache?.sourceKind?{sourceKind:session.structureCache.sourceKind}:{}),
    stateRevision: session.stateRevision,
    ...stateWithoutPdbId,
    ...(pdbId == null ? {} : { pdbId }),
    ...extras,
  };
}

function structureView(session: StereoSession): Omit<StructurePayload, 'kind' | 'sessionId' | 'empty' | 'structureText' | 'format' | 'pdbId' | 'fixture'> {
  return {
    serverEpoch: session.serverEpoch,
    color: session.state.color,
    style: session.state.style,
    mode: session.state.mode,
    depthBudgetArcmin: session.state.depthBudgetArcmin,
    swapEyes: session.state.swapEyes,
    variant: session.state.variant,
    motion: session.state.motion,
    stateRevision: session.stateRevision,
  };
}

function applyOpenAppearance(state: StereoState, input: { color?: LookColor; style?: LookStyle }): StereoState {
  return {
    ...state,
    ...(input.color == null ? {} : { color: input.color }),
    ...(input.style == null ? {} : { style: input.style }),
  };
}

function sameMotion(left: MotionPayload, right: MotionPayload): boolean {
  return left.mode === right.mode
    && left.amplitudeDeg === right.amplitudeDeg
    && left.periodS === right.periodS
    && left.axis === right.axis;
}

function sameStereoState(left: StereoState, right: StereoState): boolean {
  return left.mode === right.mode
    && left.depthBudgetArcmin === right.depthBudgetArcmin
    && left.swapEyes === right.swapEyes
    && left.variant === right.variant
    && left.color === right.color
    && left.style === right.style
    && left.pdbId === right.pdbId
    && sameMotion(left.motion, right.motion);
}

/** Copy a session with a newer freshness revision only when safe render state changed. */
function withState(session: StereoSession, state: StereoState): StereoSession {
  if (sameStereoState(session.state, state)) return session;
  if (session.stateRevision >= Number.MAX_SAFE_INTEGER) {
    throw new Error('Stereofold exhausted this session’s state revision; open a new session before changing view state.');
  }
  return { ...session, state, stateRevision: session.stateRevision + 1 };
}

/**
 * A control result deliberately has no viewer resource. Preserve transient
 * reset/fit intent until a successfully hydrated viewer atomically claims it;
 * concurrent/retried opens may all advertise the same identity meanwhile.
 */
function pendingActionExtras(session: StereoSession): Pick<ViewerPayload, 'action' | 'actionId'> {
  if (session.pendingAction == null) return {};
  return {
    action: session.pendingAction.action,
    actionId: session.pendingAction.actionId,
  };
}

/** Bound action-token memory even if an app repeatedly opens before acknowledging. */
const MAX_ADVERTISED_ACTION_RENDER_TOKENS = 64;

/**
 * Bind a pending action to a render result that really advertised its actionId.
 *
 * The action tools are app-only, but a renderToken is still not a free-form
 * capability: a claim must name a token emitted by an open result for this
 * exact pending action. Keeping a bounded recent set preserves concurrent
 * result delivery while preventing an arbitrary large token from reserving a
 * lease or an unacknowledged action from growing memory forever.
 */
function advertisePendingAction(session: StereoSession, renderToken: number): StereoSession {
  const pending = session.pendingAction;
  if (pending == null) return session;
  const advertisedRenderTokens = new Set(pending.advertisedRenderTokens);
  advertisedRenderTokens.add(renderToken);
  while (advertisedRenderTokens.size > MAX_ADVERTISED_ACTION_RENDER_TOKENS) {
    const oldest = advertisedRenderTokens.values().next().value;
    if (oldest == null) break;
    advertisedRenderTokens.delete(oldest);
  }
  return { ...session, pendingAction: { ...pending, advertisedRenderTokens } };
}

export function createStereoStructureServer(
  viewerHtmlPath = fileURLToPath(new URL('./viewer.html', import.meta.url)),
  options: StereoStructureServerOptions = {},
): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: '0.1.22' }, {
    capabilities: { experimental: { 'claude/channel': {} } },
    instructions: 'The headset wearer cannot see this terminal. For a headset channel request: act, confirm, stop. Act at once with one scene tool call carrying utteranceId (from utterance_id), the change and waitForRenderMs:10000. Only update_inspection, control_tour, focus_selection and emphasize support this binding: leave out sessionId, panelId and referent, which the host takes from the utterance. Other scene tools still require sessionId, including undo_last_change, redo_last_change and replace_inspection_source. Common requests need no read first: pause or play is update_inspection animation {state}; next or back is control_tour; bigger or smaller is placement scale about 1.25x or 0.8x the scale in your last receipt or continue_session; a named ligand is an update_inspection selection of residues {componentId} spelled as the wearer said it (the host refuses one the structure lacks, so never substitute another); a chapter topic is control_tour next or back to the step continue_session listed; labels on one residue, range or ligand are one update_inspection compound of a selection of residues and appearance {labels:true}. Once rendered, answer with say_to_headset {text, utteranceId} in one short sentence and end the turn with no summary. A typed request also needs only a short confirmation. The selection highlight can replace a color set on selected atoms: call them highlighted, name no color for them, and leave a region unselected when its color should show. Labels show residue names and ligand codes: give a ligand its common name in your reply, and use install_lesson for a text label on a named region. Pushed transcripts recovered by listen_voice may already have been handled: deduplicate by utteranceId.',
  });
  const now = options.now ?? Date.now;
  const sessions = new SessionStore<StereoSession>(
    now,
    normalizedPositiveInteger(options.sessionTtlMs, DEFAULT_SESSION_TTL_MS),
    normalizedPositiveInteger(options.maxSessions, DEFAULT_MAX_SESSIONS),
    options.sessionIdFactory ?? randomUUID,
  );
  /**
   * Who hears a session end. The inspector panel host forgets that session's
   * page key, and stops listening once no key is left.
   */
  const sessionEnds = new Set<(sessionId: string) => void>();
  sessions.onEvict = (sessionId) => { for (const listener of sessionEnds) listener(sessionId); };
  const loadPdbText = options.fetchPdbText ?? fetchPdbText;
  const composites = createPreparedCompositeStore({ cachePath: options.compositeCachePath, fetchPdbText: options.fetchPdbText, fetch: options.sourceFetch });
  // Process-local random identity. Render tokens restart at one when a server
  // restarts, so viewers compare them only inside this lifecycle epoch.
  const serverEpoch = randomUUID();
  /**
   * The one scene this Mac shares, if anyone asked for one.
   *
   * The session store above is process-local by design, which is why a session
   * opened in one host's server is simply absent from another's. This service
   * is the join: while it is unshared it costs nothing, and once two hosts
   * share a scene the attached one answers every session-bound call from the
   * owner rather than from an emptier store of its own.
   */
  const scene = options.sceneService ?? new LocalSceneService({
    serverEpoch, now,
    live: (sessionId: string) => sessions.get(sessionId) != null,
    sweep: () => sessions.sweep(),
    ...(options.sceneServiceFile ? { file: options.sceneServiceFile } : {}),
    ...(options.environment ? { env: options.environment } : {}),
  });
  // An owner whose shared session has ended gives the scene up, so the next
  // host to continue or open a Wi-Fi share becomes the owner.
  sessionEnds.add(sessionId => { void scene.sessionEnded(sessionId).catch(() => undefined); });
  /**
   * Registration, with the shared scene in front of it. A proxied session must
   * never find a second copy of itself here, so the forward happens before the
   * local handler rather than inside each of them.
   */
  const registerAppTool = ((target: any, name: string, config: any, handle: (input: any) => Promise<any>) => {
    const short = name.replace('stereo_structure.', '');
    scene.register(short, handle);
    return registerHostTool(target, name, config, (async (input: any) => {
      const forwarded = await scene.forward(short, input);
      if (forwarded) return forwarded.value;
      const answer = await handle(input);
      // `open` creates the session it returns, so the identity worth sharing is
      // in the result rather than in the call.
      const opened = typeof input?.sessionId === 'string' ? input.sessionId
        : typeof answer?.structuredContent?.sessionId === 'string' ? answer.structuredContent.sessionId : undefined;
      if (opened !== undefined) scene.noteSession(opened);
      return answer;
    }) as any);
  }) as typeof registerHostTool;
  let nextRenderToken = 0;
  /** Latest pending network source per session; source-free renders wait for it. */
  const pendingSourceLoads = new Map<string, SourceLoadReservation>();

  /**
   * Allocate before any render/source-load await. Completion order is not
   * invocation order, and hosts do not promise tool-result delivery order.
   */
  function reserveRenderToken(): number {
    if (nextRenderToken >= Number.MAX_SAFE_INTEGER) {
      throw new Error('Stereofold exhausted its render ordering tokens; restart the server before rendering again.');
    }
    nextRenderToken += 1;
    return nextRenderToken;
  }

  function requireSession(sessionId: string): StereoSession {
    const session = sessions.get(sessionId);
    if (session == null) {
      throw new Error('Stereofold session was not found or has expired. Open a structure to create a new session and use its returned sessionId.');
    }
    return session;
  }

  /** Replaces a retained session only after all asynchronous work has succeeded. */
  function commitSession(sessionId: string | undefined, session: StereoSession): string {
    if (sessionId == null) return sessions.create(session);
    if (!sessions.replace(sessionId, session)) {
      throw new Error('Stereofold session expired while the operation was running; no state was changed.');
    }
    return sessionId;
  }

  /**
   * Reserve the next source generation before an asynchronous PDB fetch.
   *
   * A later source request (including an immediate pasted/fixture open) bumps
   * this number, so an older network response can never overwrite it merely
   * because it completed later.
   */
  function beginSourceLoad(sessionId: string): SourceLoadReservation {
    const current = requireSession(sessionId);
    const updated = { ...current, sourceRevision: current.sourceRevision + 1 };
    if (!sessions.replace(sessionId, updated)) {
      throw new Error('Stereofold session expired while starting a structure load; no state was changed.');
    }
    let resolve: (() => void) | undefined;
    const reservation: SourceLoadReservation = {
      revision: updated.sourceRevision,
      settled: new Promise<void>((done) => { resolve = done; }),
      settle: () => {
        const done = resolve;
        resolve = undefined;
        done?.();
      },
    };
    pendingSourceLoads.set(sessionId, reservation);
    return reservation;
  }

  /** Resolve a reservation without deleting a newer network source that replaced it. */
  function finishSourceLoad(sessionId: string, reservation: SourceLoadReservation): void {
    reservation.settle();
    if (pendingSourceLoads.get(sessionId) === reservation) pendingSourceLoads.delete(sessionId);
  }

  /**
   * A source-free render is a snapshot request, not a competing source
   * mutation. Wait through every source request that was already in flight so
   * its newer render token describes the committed cache rather than an old
   * snapshot that would cause a panel to reject the eventual source result.
   */
  async function sessionAfterPendingSourceLoad(sessionId: string): Promise<StereoSession> {
    while (true) {
      const current = requireSession(sessionId);
      const pending = pendingSourceLoads.get(sessionId);
      // An immediate pasted/fixture source increments sourceRevision and has
      // already committed. Its superseded slow fetch must not make a later
      // source-free render wait for work whose result will be discarded.
      if (pending == null || pending.revision !== current.sourceRevision) return current;
      await pending.settled;
    }
  }

  /** Return the latest session only if no newer source request superseded it. */
  function currentSourceLoad(sessionId: string, sourceRevision: number): StereoSession {
    const current = requireSession(sessionId);
    if (current.sourceRevision !== sourceRevision) {
      throw new Error('A newer Stereofold structure request superseded this load; its result was discarded.');
    }
    return current;
  }

  /**
   * Commit a render result and advertise, without consuming, a pending camera
   * action. Source-free opens always re-read the session here: each one
   * awaited before this point, so two overlapping opens may otherwise each
   * copy the same old token set and overwrite the other's advertised token.
   */
  function completeOpen(
    sessionId: string | undefined,
    session: StereoSession,
    renderToken: number,
    options: { useLatestSession?: boolean; committed?: () => void } = {},
  ) {
    const latest = options.useLatestSession === true && sessionId != null
      ? requireSession(sessionId)
      : session;
    const rendered = advertisePendingAction(latest, renderToken);
    const resolvedSessionId = commitSession(sessionId, rendered);
    // The exact moment the new cache is the session's. A shared
    // session's transition has to be recorded against it before anything else
    // can read the session and build an attachment from it.
    options.committed?.();
    return result(stateResult('open', resolvedSessionId, rendered, (
      {
        renderToken,
        ...pendingActionExtras(rendered),
      }
    )));
  }

  registerAppResource(
    server,
    'Stereofold Viewer',
    APP_RESOURCE_URI,
    { _meta: viewerMetadata() },
    async () => ({
      contents: [{
        uri: APP_RESOURCE_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: await readFile(viewerHtmlPath, 'utf8'),
        _meta: viewerMetadata(),
      }],
    }),
  );

  /* The only tool that names a viewer resource. */
  const openToolConfig = {
    title: 'Open Stereofold',
    description: 'Render a structure in the Stereofold stereo viewer. Supply one source to create a session (leave out sessionId) or to replace a session\'s structure: pdbId, pasted PDB or mmCIF text, the built-in three-depth-markers fixture, or a source object for AlphaFold, https URLs and local files (see the source field). Supply only sessionId to render that session\'s current state again after a data or control call. Keep the returned sessionId; this server issues it, and it is not a conversation ID. For the headset and for agent edits, use inspect. Coordinates reach the viewer through the app-only get_structure tool and never appear in this result. Each render carries a monotonic renderToken and stateRevision for the panel; neither is an input for you. A pending reset_camera or fit arrives with an actionId that the viewer claims and replays exactly once. A network source reveals the requested ID or URL and this Mac\'s IP address to the source host; files, pasted text and the fixture make no network request. Downloads are capped at '+STRUCTURE_SOURCE_SIZE_LABEL+'. This is a source policy, not a rendering capacity. The Quest 2 growth workflow uses a 43,066 atom-site tier tested as cartoon; it is not a universal arbitrary-structure limit. The desktop viewer has no measured size ceiling. PDB inspection needs declared polymer SEQRES; coordinate-only PDB files open here. Loading a source into a session shared with a headset keeps the share: the result carries share, and share.sourceToken replaces the token you read before the call.',
    inputSchema: openInputSchema,
    // A source-bearing call can allocate/replace a retained session, so repeat
    // calls are neither read-only nor idempotent even though RCSB itself is
    // only read. It does read a public RCSB resource when pdbId is used.
    // Replacing a retained session's source discards its prior coordinate
    // cache/state, so the conservative tool-level destructive annotation is
    // accurate even though a source-free render only consumes a pending view
    // action.
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    _meta: viewerMetadata({ fileBinding: true }),
  };
  async function openStructure(rawInput: unknown, committed: () => void = () => {}) {
    const input = parseOpenInput(rawInput);
    // Allocate before any source fetch so this expresses call order, not the
    // order in which asynchronous PDB requests happen to finish.
    const renderToken = reserveRenderToken();

    // Re-render a known cached session. It is intentionally source-free.
    if (!('pdbId' in input) && !('structureText' in input) && !('fixture' in input) && !('source' in input)) {
      const session = await sessionAfterPendingSourceLoad(input.sessionId);
      return completeOpen(input.sessionId, session, renderToken, { useLatestSession: true });
    }

    if ('source' in input || 'structureText' in input) {
      const reservation=input.sessionId==null?undefined:beginSourceLoad(input.sessionId);
      try {
        const source=await resolveStructureSource('source' in input?input.source:{kind:'pasted',text:input.structureText,format:input.format??'mmcif'},{resolveComposite:composites.resolve,fetchPdbText:loadPdbText,fetch:options.sourceFetch,...(options.sourceFetch?{cacheRoot:false as const}:{})});
        const sourceSession=input.sessionId==null?createSession(serverEpoch):currentSourceLoad(input.sessionId,reservation!.revision);
        return completeOpen(input.sessionId,{
          ...withState(sourceSession,{...applyOpenAppearance(sourceSession.state,input),pdbId:source.pdbId}),
          structureCache:{structureText:source.structureText,format:source.format,...(source.pdbId?{pdbId:source.pdbId}:{}),sourceKind:source.kind,
            ...(source.sourceFilename?{sourceFilename:source.sourceFilename}:{})},
          sourceRevision:reservation?.revision??sourceSession.sourceRevision+1,
        },renderToken,{committed});
      } finally {if(input.sessionId && reservation) finishSourceLoad(input.sessionId,reservation);}
    }

    // Do this before an external fetch so an unknown token cannot trigger a
    // request and cannot probe another session’s state.
    if ('pdbId' in input) {
      // Validate before networking, then re-read after it. A panel can sync
      // view state while RCSB is in flight; committing from the pre-fetch
      // snapshot would silently erase that newer state.
      const reservation = input.sessionId == null ? undefined : beginSourceLoad(input.sessionId);
      try {
        const structureText = await loadPdbText(input.pdbId);
        // Injected fetchers use the same atomic boundary as production HTTP:
        // malformed 200 bodies never get as far as a session cache commit.
        assertRcsbMmcifPayload(input.pdbId, structureText);
        // Atomic PDB load: no state/cache assignment occurs until fetch
        // succeeds, and this is the newest retained session at commit time.
        const sourceSession = input.sessionId == null
          ? createSession(serverEpoch)
          : currentSourceLoad(input.sessionId, reservation?.revision as number);
        const state = { ...applyOpenAppearance(sourceSession.state, input), pdbId: input.pdbId };
        const updated: StereoSession = {
          ...withState(sourceSession, state),
          structureCache: { structureText, format: 'mmcif', pdbId: input.pdbId },
          sourceRevision: reservation?.revision ?? sourceSession.sourceRevision + 1,
        };
        return completeOpen(input.sessionId, updated, renderToken, { committed });
      } finally {
        if (input.sessionId != null && reservation != null) finishSourceLoad(input.sessionId, reservation);
      }
    }

    const sourceSession = input.sessionId == null ? createSession(serverEpoch) : requireSession(input.sessionId);
    if ('fixture' in input) {
      const state = { ...applyOpenAppearance(sourceSession.state, input), pdbId: undefined };
      const updated: StereoSession = {
        ...withState(sourceSession, state),
        structureCache: { structureText: DEPTH_FIXTURE_PDB, format: 'pdb', fixture: DEPTH_FIXTURE_ID },
        sourceRevision: sourceSession.sourceRevision + 1,
      };
      return completeOpen(input.sessionId, updated, renderToken, { committed });
    }

    throw Error('Choose a supported structure source.');
  }
  /**
   * THE LEGACY SOURCE TOOLS KEEP THE WEARER'S SHARE.
   *
   * `open` with a source and `control` with load_pdb commit a new structure
   * cache straight into the session. When that session is the one on a wearer's
   * headset, the new cache is a new inspection attachment with a new
   * sourceToken, which the inspection server reads as an unauthorized retarget
   * of a LAN capability and answers by retiring the listener. A
   * `load_pdb` of 1CRN ended a live 4HHB share thirteen seconds into a dress
   * rehearsal, and the tool answered `hasStructure: true` with nothing about it.
   *
   * These two wrappers hand the commit to the inspection server's own
   * controlled transition, the one `replace_inspection_source` uses, so the
   * command queue, the panels, the `shared` flag and the LAN listener all cross
   * to the new source. What happened to the share comes back in `share`, which
   * is present on every source-bearing result for a shared session and absent
   * on every other one.
   */
  let inspection: ReturnType<typeof registerInspection> | undefined;
  function withShare(outcome: { value: ReturnType<typeof result>; share?: ViewerPayload['share'] }) {
    if (!outcome.share) return outcome.value;
    return {
      content: [{ type: 'text' as const, text: `${outcome.value.content[0].text} ${outcome.share.note}` }],
      structuredContent: { ...outcome.value.structuredContent, share: outcome.share },
    };
  }
  async function openStructureTool(rawInput: unknown) {
    const raw = rawInput as Record<string, unknown> | null | undefined;
    const sessionId = typeof raw?.sessionId === 'string' ? raw.sessionId : undefined;
    // A source-free re-render keeps the cache it already has, so it changes no
    // capability and needs no transition.
    const bearsSource = Boolean(raw && (raw.pdbId !== undefined || raw.structureText !== undefined
      || raw.fixture !== undefined || raw.source !== undefined));
    if (!inspection || sessionId === undefined || !bearsSource) return await openStructure(rawInput);
    return withShare(await inspection.loadSharedSource(sessionId,
      async committed => await openStructure(rawInput, committed)));
  }
  registerAppTool(server, 'stereo_structure.open', openToolConfig, openStructureTool);
  async function resolveInspectionSource(request:StructureSourceRequest,signal?:AbortSignal) {
    const resolved=await abortable(resolveStructureSource(request,{resolveComposite:composites.resolve,fetchPdbText:loadPdbText,fetch:options.sourceFetch,
      signal,...(options.sourceFetch?{cacheRoot:false as const}:{})}),signal);
    return abortable(inspectionSource(resolved),signal);
  }
  inspection = registerInspection(server, { serverEpoch, open:openStructure, current:requireSession, now, scene, voice: options.voice, transcriber: options.transcriber, questLaunch: options.questLaunch,
    live:(sessionId:string)=>sessions.has(sessionId), sessionEnded:(listener:(sessionId:string)=>void)=>{ sessionEnds.add(listener); },
    ...(options.replyAudio?{replyAudio:options.replyAudio}:{}),
    ...(options.headsetDevice?{headsetDevice:options.headsetDevice}:{}),
    ...(options.headsetDevtools?{headsetDevtools:options.headsetDevtools}:{}),
    ...(options.environment?{environment:options.environment}:{}),
    ...(options.loopbackListenDenied?{loopbackListenDenied:options.loopbackListenDenied}:{}),
    prepareComposite: composites.prepare,
    resolveComparisonSource: resolveInspectionSource,
    openVerifiedSource: async ({sessionId,source:request,resolved,selection,verify,signal,beforeCommit,committed}:{sessionId?:string;source:StructureSourceRequest;resolved?:ResolvedStructureSource;selection?:StructureSelection;verify:(text:string)=>Promise<void>|void;signal?:AbortSignal;beforeCommit?:()=>void;committed?:()=>void}) => {
      signal?.throwIfAborted();
      const renderToken=reserveRenderToken();
      const reservation=sessionId==null?undefined:beginSourceLoad(sessionId);
      try {
        const source=resolved??await resolveInspectionSource(request,signal);
        await abortable(Promise.resolve(verify(source.structureText)),signal);
        const sourceSession=sessionId==null?createSession(serverEpoch):currentSourceLoad(sessionId,reservation!.revision);
        signal?.throwIfAborted();
        beforeCommit?.();
        const opened=completeOpen(sessionId,{
          ...withState(sourceSession,{...sourceSession.state,pdbId:source.pdbId}),
          structureCache:{structureText:source.structureText,format:'mmcif',...(source.pdbId?{pdbId:source.pdbId}:{}),sourceKind:source.kind,sourceSelection:selection,
            ...(source.sourceFilename?{sourceFilename:source.sourceFilename}:{})},
          sourceRevision:reservation?.revision??sourceSession.sourceRevision+1,
        },renderToken);
        committed?.();
        return opened;
      } finally {if(sessionId && reservation) finishSourceLoad(sessionId,reservation);}
    },
    restoreSource: ({sessionId,expectedCache,cache}) => {
      const session=requireSession(sessionId);
      if(session.structureCache!==expectedCache || pendingSourceLoads.has(sessionId))
        throw Error('A newer structure request superseded this journey; the previous source was not restored.');
      return completeOpen(sessionId,{...withState(session,{...session.state,pdbId:cache.pdbId}),
        structureCache:cache,sourceRevision:session.sourceRevision+1},reserveRenderToken());
    },
    /** One-fetch compare-and-commit path for provenance-checked experiences. */
    openVerifiedPdb: async ({sessionId,pdbId,verify}:{sessionId:string;pdbId:string;verify:(structureText:string)=>Promise<void>|void}) => {
      const renderToken=reserveRenderToken();
      const reservation=beginSourceLoad(sessionId);
      try {
        const structureText=await loadPdbText(pdbId);
        assertRcsbMmcifPayload(pdbId,structureText);
        await verify(structureText);
        const sourceSession=currentSourceLoad(sessionId,reservation.revision);
        const updated: StereoSession={
          ...withState(sourceSession,{...sourceSession.state,pdbId}),
          structureCache:{structureText,format:'mmcif',pdbId},sourceRevision:reservation.revision,
        };
        return completeOpen(sessionId,updated,renderToken);
      } finally { finishSourceLoad(sessionId,reservation); }
    },
    /**
     * The same compare-and-commit path for a local coordinate file.
     *
     * A growth tier is a derived subset of a deposited assembly, so it has no
     * PDB id of its own and `openVerifiedPdb` cannot reach it. The caller has
     * already read the bytes and checked their digest; this only commits them
     * under the same source-load reservation, so a slower open cannot overwrite
     * a newer one.
     */
    openVerifiedLocal: async ({sessionId,structureText,pdbId,verify,committed}:{sessionId:string;structureText:string;pdbId?:string;verify:(structureText:string)=>Promise<void>|void;committed?:()=>void}) => {
      const renderToken=reserveRenderToken();
      const reservation=beginSourceLoad(sessionId);
      try {
        await verify(structureText);
        const sourceSession=currentSourceLoad(sessionId,reservation.revision);
        const updated: StereoSession={
          ...withState(sourceSession,{...sourceSession.state,pdbId}),
          structureCache:{structureText,format:'mmcif',...(pdbId?{pdbId}:{})},sourceRevision:reservation.revision,
        };
        return completeOpen(sessionId,updated,renderToken,{committed});
      } finally { finishSourceLoad(sessionId,reservation); }
    },
    htmlPath:fileURLToPath(new URL('./inspector.html', new URL(viewerHtmlPath, 'file://'))) });

  const controlToolConfig = {
    title: 'Control Stereofold',
    description: 'Apply one exact legacy control action to the session identified by server-issued sessionId: load a public RCSB PDB ID, reset or fit the camera, set/pause legacy motion, or change colour/style. reset_camera, fit and the motion actions act on the legacy stereo viewer, never on the shared headset scene: a linked headset page rehydrates on the state change and can drop out of its immersive session (a fit has detached a wearer mid-demo). For a headset, placement (push back, scale), spin/stop, representation, colour, visibility and labels all go through update_inspection with the binding get_inspection_state prints; use this tool for a headset only for load_pdb. For all new legacy motion requests prefer stereo_structure.set_motion. This tool does not render or mount a viewer; call stereo_structure.open with the same sessionId to render updated model-origin state. reset_camera and fit are advertised by ensuing opens and atomically claimed by a successfully hydrated app panel, exactly once. A successful load_pdb result includes a server-managed monotonic renderToken for an already-mounted panel to reject delayed older source results. It is not a model/user control input; when a later open advertises an actionId, the mounted app returns that open token only to its private claim/complete lease tools. Every safe state snapshot has a separate stateRevision. load_pdb makes exactly one outbound HTTPS request to files.rcsb.org, which reveals this machine\'s IP address and the requested public PDB ID to RCSB; no other action reaches the network and nothing else leaves the machine. load_pdb into a session that is shared with a headset keeps that share rather than ending it: the result then also carries share, and share.sourceToken is the token to use from then on, because the one you read before the call is spent. A load_pdb result on a shared session always says what happened to the share.',
    inputSchema: controlInputSchema,
    // `load_pdb` refetches and replaces the retained structure cache for its
    // session. Other actions are additive, but annotations apply to the
    // complete tool, so it is neither non-destructive nor idempotent.
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    _meta: {},
  };
  registerAppTool(server, 'stereo_structure.control', controlToolConfig, async (rawInput) => {
    const input = parseControlInput(rawInput);
    if (input.action === 'load_pdb') {
      // Like `open`, reserve before the fetch so a panel can reject this
      // delayed source result if a newer structure-bearing call wins.
      const renderToken = reserveRenderToken();
      const load = async (committed: () => void) => {
        // Validate before networking. Re-read it after await so a concurrent
        // app-originated sync_view is not overwritten by this PDB commit.
        const reservation = beginSourceLoad(input.sessionId);
        try {
          const structureText = await loadPdbText(input.pdbId);
          assertRcsbMmcifPayload(input.pdbId, structureText);
          const session = currentSourceLoad(input.sessionId, reservation.revision);
          // Atomic PDB load: a rejected/failed response cannot overwrite the
          // previous pdbId, appearance, coordinate cache, or diagnostics store.
          const updated: StereoSession = {
            ...withState(session, { ...session.state, pdbId: input.pdbId }),
            structureCache: { structureText, format: 'mmcif', pdbId: input.pdbId },
            sourceRevision: reservation.revision,
          };
          commitSession(input.sessionId, updated);
          // The shared transition is recorded against the new cache
          // here, before anything else can read the session.
          committed();
          return result(stateResult('control', input.sessionId, updated, { action: input.action, renderToken }));
        } finally {
          finishSourceLoad(input.sessionId, reservation);
        }
      };
      if (!inspection) return await load(() => {});
      return withShare(await inspection.loadSharedSource(input.sessionId, load));
    }

    const session = requireSession(input.sessionId);
    let state = session.state;
    if (input.action === 'set_motion') {
      state = { ...state, motion: { mode: input.motion === 'paused' ? 'none' : input.motion } };
    }
    if (input.action === 'pause_motion') state = { ...state, motion: { mode: 'none' } };
    if (input.action === 'set_look') {
      state = {
        ...state,
        ...(!('color' in input) || input.color == null ? {} : { color: input.color }),
        ...(input.style == null ? {} : { style: input.style }),
      };
    }
    const pendingAction: PendingRenderAction | undefined = (
      input.action === 'reset_camera' || input.action === 'fit'
        ? { action: input.action, actionId: randomUUID(), advertisedRenderTokens: new Set() }
        : session.pendingAction
    );
    const stateUpdated = withState(session, state);
    const updated = pendingAction === stateUpdated.pendingAction
      ? stateUpdated
      : { ...stateUpdated, pendingAction };
    commitSession(input.sessionId, updated);
    return result(stateResult('control', input.sessionId, updated, { action: input.action }));
  });

  const getStateToolConfig = {
    title: 'Get Stereofold State',
    description: 'Request concise state for one server-issued sessionId. This does not render a viewer or return coordinates; the app-only stereo_structure.get_structure tool hydrates coordinates for a panel.',
    inputSchema: getStateInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: {},
  };
  registerAppTool(server, 'stereo_structure.get_state', getStateToolConfig, async (rawInput) => {
    const input = getStateInputSchema.parse(rawInput);
    const session = requireSession(input.sessionId);
    const newest = session.panelReports.newest();
    const panels = session.panelReports.panels();
    return result(stateResult('state', input.sessionId, session, {
      ...(newest == null ? {} : { diagnostics: newest }),
      ...(panels.length === 0 ? {} : { diagnosticsPanels: panels }),
    }));
  });

  /* App-only coordinate hydration, intentionally without resourceUri. */
  const getStructureToolConfig = {
    title: 'Get Stereofold Structure',
    description: 'Return a concise no-coordinate summary for one server-issued sessionId and put cached coordinates plus viewer state in private component result metadata, so a freshly mounted Stereofold panel can hydrate itself. Makes no network request. Called by the Stereofold viewer only.',
    inputSchema: getStructureInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { visibility: ['app'] } },
  };
  registerAppTool(server, 'stereo_structure.get_structure', getStructureToolConfig, async (rawInput) => {
    const input = getStructureInputSchema.parse(rawInput);
    const session = requireSession(input.sessionId);
    const view = structureView(session);
    if (session.structureCache == null) {
      return structureResult({ kind: 'structure', sessionId: input.sessionId, empty: true, ...view });
    }
    return structureResult({
      kind: 'structure',
      sessionId: input.sessionId,
      empty: false,
      ...session.structureCache,
      ...view,
    });
  });

  /* App-only one-shot action lease/ack, intentionally without resourceUri. */
  const claimActionToolConfig = {
    title: 'Claim Stereofold Render Action',
    description: 'Lease a reset_camera or fit action advertised with a matching Stereofold render result after that panel has successfully hydrated the matching structure. The claim includes that result’s renderToken; a newer render token supersedes an older lease. Claiming does not consume the action: only stereo_structure.complete_action clears the matching lease after the action finished while current. Makes no network request and mounts no viewer. Called by the Stereofold viewer only.',
    inputSchema: claimActionInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    _meta: { ui: { visibility: ['app'] } },
  };
  registerAppTool(server, 'stereo_structure.claim_action', claimActionToolConfig, async (rawInput) => {
    const input = claimActionInputSchema.parse(rawInput);
    const session = requireSession(input.sessionId);
    const pending = session.pendingAction;
    const claimed = pending?.actionId === input.actionId
      && pending.advertisedRenderTokens.has(input.renderToken)
      && (pending.leaseRenderToken == null || input.renderToken > pending.leaseRenderToken);
    const updated = claimed && pending != null
      ? { ...session, pendingAction: { ...pending, leaseRenderToken: input.renderToken } }
      : session;
    if (claimed) commitSession(input.sessionId, updated);
    return result(stateResult('action_claim', input.sessionId, updated, {
      claimed,
      ...(claimed && pending != null ? { action: pending.action, actionId: pending.actionId } : {}),
    }));
  });

  const completeActionToolConfig = {
    title: 'Complete Stereofold Render Action',
    description: 'Acknowledge that the currently leased reset_camera or fit action finished while its render result still owned the panel. Clears only the matching actionId and renderToken lease; a newer render lease or a stale panel cannot clear it. Makes no network request and mounts no viewer. Called by the Stereofold viewer only.',
    inputSchema: completeActionInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    _meta: { ui: { visibility: ['app'] } },
  };
  registerAppTool(server, 'stereo_structure.complete_action', completeActionToolConfig, async (rawInput) => {
    const input = completeActionInputSchema.parse(rawInput);
    const session = requireSession(input.sessionId);
    const pending = session.pendingAction;
    const completed = pending?.actionId === input.actionId && pending.leaseRenderToken === input.renderToken;
    const updated = completed ? { ...session, pendingAction: undefined } : session;
    if (completed) commitSession(input.sessionId, updated);
    return result(stateResult('action_complete', input.sessionId, updated, {
      completed,
      ...(completed && pending != null ? { action: pending.action, actionId: pending.actionId } : {}),
    }));
  });

  /* App-only view synchronization, intentionally without resourceUri. */
  const syncViewToolConfig = {
    title: 'Sync Stereofold View State',
    description: 'Record current mode, depth, eye swap, anaglyph variant, colour/style, and optional motion for one server-issued sessionId. Every view field is optional and merges with current state. Send the last accepted stateRevision as baseStateRevision; a stale full-state write is rejected as a concise conflict response carrying the current snapshot instead of overwriting newer model or panel state. Makes no network request and mounts no viewer. Called by the Stereofold viewer only.',
    inputSchema: syncViewInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { visibility: ['app'] } },
  };
  registerAppTool(server, 'stereo_structure.sync_view', syncViewToolConfig, async (rawInput) => {
    const input = syncViewInputSchema.parse(rawInput);
    const session = requireSession(input.sessionId);
    if (input.baseStateRevision != null && input.baseStateRevision !== session.stateRevision) {
      return result(stateResult('view', input.sessionId, session, { conflict: true }));
    }
    const state: StereoState = {
      ...session.state,
      ...(input.mode == null ? {} : { mode: input.mode }),
      ...(input.depthBudgetArcmin == null ? {} : { depthBudgetArcmin: input.depthBudgetArcmin }),
      ...(input.swapEyes == null ? {} : { swapEyes: input.swapEyes }),
      ...(input.variant == null ? {} : { variant: input.variant }),
      ...(input.color == null ? {} : { color: input.color }),
      ...(input.style == null ? {} : { style: input.style }),
      ...(input.motion == null ? {} : { motion: input.motion }),
    };
    const updated = withState(session, state);
    commitSession(input.sessionId, updated);
    return result(stateResult('view', input.sessionId, updated));
  });

  /* App-only diagnostics, intentionally without resourceUri. */
  const reportDiagnosticsToolConfig = {
    title: 'Report Stereofold Fit Diagnostics',
    description: 'Record live fit diagnostics for one server-issued sessionId so stereo_structure.get_state can report them. Makes no network request, mounts no viewer, and does not change that session’s view state. Called by the Stereofold viewer only.',
    inputSchema: reportDiagnosticsInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { visibility: ['app'] } },
  };
  registerAppTool(server, 'stereo_structure.report_diagnostics', reportDiagnosticsToolConfig, async (rawInput) => {
    const input = reportDiagnosticsInputSchema.parse(rawInput);
    const session = requireSession(input.sessionId);
    // A report that goes backwards for its own panel is dropped rather than
    // stored: the channel does not order deliveries.
    session.panelReports.accept(input.diagnostics);
    return result(stateResult('diagnostics', input.sessionId, session));
  });

  const setModeToolConfig = {
    title: 'Set Stereofold Mode',
    description: 'Set off, parallel, cross, or anaglyph mode for one server-issued sessionId, with optional angular depth strength, eye swap, and anaglyph variant. This tool does not render or mount a viewer; call stereo_structure.open with the same sessionId to render model-origin changes.',
    inputSchema: setModeInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: {},
  };
  registerAppTool(server, 'stereo_structure.set_mode', setModeToolConfig, async (rawInput) => {
    const input = setModeInputSchema.parse(rawInput);
    const session = requireSession(input.sessionId);
    const updated = withState(session, {
      ...session.state,
      mode: input.mode,
      ...(input.depthBudgetArcmin == null ? {} : { depthBudgetArcmin: input.depthBudgetArcmin }),
      ...(input.swapEyes == null ? {} : { swapEyes: input.swapEyes }),
      ...(input.variant == null ? {} : { variant: input.variant }),
    });
    commitSession(input.sessionId, updated);
    return result(stateResult('mode', input.sessionId, updated));
  });

  const setMotionToolConfig = {
    title: 'Set Stereofold Motion',
    description: 'Set no motion, a gentle rock, a slow spin, or mouse parallax for one server-issued sessionId. Optional degrees, period, and axis use package defaults when omitted. This tool does not render or mount a viewer; call stereo_structure.open with the same sessionId to render model-origin changes. This motion belongs to the legacy stereo viewer, not to the shared headset scene: a linked headset page does not spin on it, and rehydrating on the state change can drop the page out of its immersive session. To spin or stop the molecule a wearer is looking at, send update_inspection with change={kind:"motion",patch:{state:"spin"|"stop"}} using the binding get_inspection_state prints.',
    inputSchema: setMotionInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: {},
  };
  registerAppTool(server, 'stereo_structure.set_motion', setMotionToolConfig, async (rawInput) => {
    const input = setMotionInputSchema.parse(rawInput);
    const session = requireSession(input.sessionId);
    const updated = withState(session, {
      ...session.state,
      motion: {
        mode: input.mode,
        ...(input.amplitudeDeg == null ? {} : { amplitudeDeg: input.amplitudeDeg }),
        ...(input.periodS == null ? {} : { periodS: input.periodS }),
        ...(input.axis == null ? {} : { axis: input.axis }),
      },
    });
    commitSession(input.sessionId, updated);
    return result(stateResult('motion', input.sessionId, updated));
  });

  return server;
}

/**
 * The readiness sentences every host now prints, in the order the standalone
 * launcher prints them: which narration route will speak, and which recognizer
 * will transcribe the wearer.
 *
 * They existed only in `scripts/serve-inspection.ts`, so the Claude Science
 * daemon and the Codex hosts started silently and the first evidence of a
 * broken microphone was a wearer pressing the talk button and getting nothing.
 * Both sentences are built from file-existence checks alone: nothing here
 * spawns whisper, ffmpeg or the Apple tool, so a host that cannot transcribe
 * still starts at the same speed as one that can.
 *
 * A probe that throws becomes a line rather than a failure. An unusable
 * `STEREOFOLD_REPLY_VOICE_PROVIDER` makes `replyAudioFromEnv` throw, and that
 * must not be the reason a molecular viewer refuses to start.
 */
export function hostReadinessLines(env: NodeJS.ProcessEnv = process.env): string[] {
  const lines: string[] = [];
  const probe = (make: () => string) => {
    try {
      const line = make().trim();
      if (line) lines.push(line);
    } catch (error) {
      lines.push(`readiness could not be read: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  };
  probe(() => replyAudioFromEnv(env).describe());
  probe(() => pushToTalkTranscriberFromEnv(env).describe());
  // The headset microphone route needs a Python 3 this repository does not
  // ship. It is optional, so a Mac without one still starts; saying so here is
  // what turns a silent microphone into a sentence with a setting in it.
  probe(() => {
    const state = oauthTranscriptionState({ env });
    return state.ready ? `Headset voice commands: Python 3 found at ${state.python}.` : state.reason ?? '';
  });
  return lines;
}

/**
 * Write the readiness lines to stderr, once, as the server starts.
 *
 * stderr and never stdout: stdout is the stdio MCP transport itself, and one
 * stray line there is a protocol error that breaks the session. The standalone
 * launcher pipes this child's stderr into a diagnostic buffer rather than the
 * terminal, so it keeps printing its own copy on stdout and the wearer sees
 * each sentence exactly once.
 */
export function announceHostReadiness(env: NodeJS.ProcessEnv = process.env,
  write: (line: string) => void = line => { process.stderr.write(`${line}\n`); }): void {
  try {
    for (const line of hostReadinessLines(env)) write(`${SERVER_NAME}: ${line}`);
  } catch {
    // Startup diagnostics never stop a start.
  }
}

/**
 * Let a signal end the server the way a closed transport does, then die of it.
 *
 * Hosts stop an MCP server with SIGTERM, and the standalone `quest` launcher
 * sends it to its host's whole process group. Node's default for a signal is
 * to exit on the spot, which skipped `close()`: the owner's scene record in
 * ~/.stereofold outlived it, and a relay started later forwarded to a dead
 * port. A close that hangs still ends after the grace. Repeats of a signal
 * during the close are ignored, since a host's follow-up SIGTERM would
 * otherwise cut the close short. Once the close ends, the signal is raised
 * again with no listener, so the process still dies of it.
 */
export function closeOnSignal(close: () => Promise<unknown>, {
  signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as readonly NodeJS.Signals[],
  graceMs = 3_000,
  target = process as Pick<NodeJS.Process, 'on' | 'off'>,
  raise = (signal: NodeJS.Signals) => {
    process.kill(process.pid, signal);
    // Only reached when another listener kept the signal from killing us.
    setTimeout(() => process.exit(128 + (constants.signals[signal] ?? 0)), 1_000).unref();
  },
} = {}): void {
  let received: NodeJS.Signals | undefined;
  const handle = (signal: NodeJS.Signals) => {
    if (received) return;
    received = signal;
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      for (const name of signals) target.off(name, handle);
      raise(signal);
    };
    const timer = setTimeout(end, graceMs);
    void close().catch(() => undefined).finally(end);
  };
  for (const name of signals) target.on(name, handle);
}

/**
 * Send console output to stderr for the life of the stdio server. stdout is
 * the MCP transport, and one stray line there (a timing note, or a bundled
 * library's diagnostic) makes the client drop the connection.
 */
export function keepStdoutForTransport(target: Pick<Console, 'log' | 'info' | 'debug' | 'error'> = console): void {
  const toStderr = (...args: unknown[]) => target.error(...args);
  target.log = toStderr;
  target.info = toStderr;
  target.debug = toStderr;
}

async function main(): Promise<void> {
  keepStdoutForTransport();
  const server = createStereoStructureServer();
  announceHostReadiness();
  await server.connect(new StdioServerTransport());
  closeOnSignal(() => server.close());
}

/**
 * Detect direct execution through canonical filesystem identities, not raw
 * spelling. On macOS Node may canonicalize `/var` and `/tmp` under `/private`,
 * while argv keeps the launch spelling; staging symlinks have the same issue.
 */
export function isDirectServerEntryPoint(
  argvPath: string | undefined = process.argv[1],
  moduleUrl: string = import.meta.url,
): boolean {
  if (argvPath == null || argvPath.length === 0) return false;
  try {
    return realpathSync(argvPath) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    // A missing/non-file argv is never a direct server launch. Avoid making an
    // import fail merely because an embedding host supplies unusual argv.
    return false;
  }
}

if (isDirectServerEntryPoint()) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
