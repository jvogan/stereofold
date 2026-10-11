import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { inspectionBindingSchema, type RequestReferent } from './inspection-contract.js';
import { createOAuthVoiceTranscriber } from './oauth-voice-transcription.js';
import { voiceAcknowledgementFromEnv } from './headset-voice-provider.js';

export const VOICE_MAX_TRANSCRIPT_CHARS = 240;
export const VOICE_MAX_INTENT_CHARS = 2_000;
export const voiceCommandSchema = z.enum([
  'show-molecule', 'show-tubulin', 'show-cas9', 'show-telomerase', 'assemble-filament', 'assemble-microtubule', 'add-eb-protein', 'add-eb3-protein', 'move-overhead',
  'scale-larger', 'scale-smaller', 'tour-next', 'tour-back', 'tour-play', 'tour-pause', 'retry',
  // Growing the staged lesson in place, without leaving VR.
  'grow-structure', 'shrink-structure', 'grow-wall', 'grow-tip',
  // "undo that" takes back the last operation whoever made it.
  // This one is executed on the HOST, not in the page: the history it reads
  // belongs to the shared scene, so the headset can take back a change an
  // agent made from the Mac and the desktop panel can take back the wearer's.
  'undo',
]);
export type VoiceCommand = z.output<typeof voiceCommandSchema>;

export const voiceAudioSchema = z.object({
  pcm16leBase64: z.string().min(4).max(960_000).regex(/^[A-Za-z0-9+/]*={0,2}$/),
  sampleRate: z.literal(24_000),
  durationMs: z.number().int().min(180).max(12_000),
}).strict();

/** A voice request carries all current binding fields and short-lived audio only. */
export const voiceCommandRequestSchema = inspectionBindingSchema.extend({
  panelId: z.string().uuid(),
  audio: voiceAudioSchema,
}).strict();
export type VoiceCommandRequest = z.output<typeof voiceCommandRequestSchema>;

/** Narration is requested only after the renderer has completed an action. */
export const voiceAcknowledgementRequestSchema = inspectionBindingSchema.extend({
  panelId: z.string().uuid(),
  message: z.string().min(1).max(180).refine(value => !/[\0\r\n]/.test(value), 'Message must be one line.'),
}).strict();
export type VoiceAcknowledgementRequest = z.output<typeof voiceAcknowledgementRequestSchema>;

const phrases = new Map<string, VoiceCommand>([
  ['show molecule', 'show-molecule'], ['show the molecule', 'show-molecule'], ['show structure', 'show-molecule'],
  ['show tubulin', 'show-tubulin'], ['show me tubulin', 'show-tubulin'], ['show a tubulin dimer', 'show-tubulin'],
  ['show cas9', 'show-cas9'], ['show me cas9', 'show-cas9'], ['show cas 9', 'show-cas9'], ['show the cas9 molecule', 'show-cas9'],
  ['show telomerase', 'show-telomerase'], ['show me telomerase', 'show-telomerase'], ['show the telomerase molecule', 'show-telomerase'],
  ['assemble filament', 'assemble-filament'], ['assemble a filament', 'assemble-filament'], ['build filament', 'assemble-filament'], ['show protofilament', 'assemble-filament'],
  ['assemble microtubule', 'assemble-microtubule'], ['assemble a microtubule', 'assemble-microtubule'], ['assemble a microtubule filament', 'assemble-microtubule'], ['build a microtubule', 'assemble-microtubule'], ['show microtubule', 'assemble-microtubule'],
  ['add eb protein', 'add-eb-protein'], ['add an eb protein', 'add-eb-protein'], ['add eb', 'add-eb-protein'], ['decorate filament', 'add-eb-protein'],
  ['add eb3', 'add-eb3-protein'], ['add eb3 protein', 'add-eb3-protein'],
  ['move overhead', 'move-overhead'], ['view overhead', 'move-overhead'], ['overhead view', 'move-overhead'], ['put it above us', 'move-overhead'], ['put it above me', 'move-overhead'],
  ['scale up', 'scale-larger'], ['scale larger', 'scale-larger'], ['make it larger', 'scale-larger'], ['make it bigger', 'scale-larger'], ['zoom in', 'scale-larger'],
  ['scale down', 'scale-smaller'], ['scale smaller', 'scale-smaller'], ['make it smaller', 'scale-smaller'], ['make it smaller please', 'scale-smaller'], ['zoom out', 'scale-smaller'],
  ['next', 'tour-next'], ['next scene', 'tour-next'], ['next step', 'tour-next'],
  ['back', 'tour-back'], ['previous', 'tour-back'], ['previous scene', 'tour-back'],
  ['play', 'tour-play'], ['play tour', 'tour-play'], ['start tour', 'tour-play'], ['resume', 'tour-play'],
  ['pause', 'tour-pause'], ['pause tour', 'tour-pause'],
  // "grow it" is the spoken phrase for the next tier, and
  // "add tubulin" is the same request said in molecules. These step the staged
  // lesson; the `assemble-*` phrases above still open the source-verified
  // experience, which is a different journey.
  ['grow it', 'grow-structure'], ['grow', 'grow-structure'], ['grow the microtubule', 'grow-structure'], ['keep growing', 'grow-structure'],
  ['add tubulin', 'grow-structure'], ['add a tubulin', 'grow-structure'], ['add another tubulin', 'grow-structure'], ['add more tubulin', 'grow-structure'],
  ['grow the filament', 'grow-structure'], ['make it grow', 'grow-structure'],
  ['shrink it', 'shrink-structure'], ['shrink', 'shrink-structure'], ['go back a tier', 'shrink-structure'],
  ['take one away', 'shrink-structure'], ['remove a tubulin', 'shrink-structure'], ['shrink the microtubule', 'shrink-structure'],
  ['build the wall', 'grow-wall'], ['show the wall', 'grow-wall'], ['make the wall', 'grow-wall'], ['build a wall', 'grow-wall'],
  ['cap it', 'grow-tip'], ['cap the end', 'grow-tip'], ['show the tip', 'grow-tip'], ['show the cap', 'grow-tip'], ['add the cap', 'grow-tip'],
  // The wearer's one-phrase answer to a failed chapter
  // highlight. The failure line says "Say retry", so the bare word must
  // dispatch instead of landing in the intent queue.
  ['retry', 'retry'], ['try again', 'retry'], ['retry the highlight', 'retry'],
  // The wearer taking back the last change, whoever made it.
  ['undo', 'undo'], ['undo that', 'undo'], ['undo it', 'undo'], ['undo the last change', 'undo'],
  ['put it back', 'undo'], ['take that back', 'undo'],
]);

/** Preserve a short user utterance for the desktop host, never raw audio. */
export function boundedVoiceTranscript(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const transcript = value.normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().replace(/\s+/g, ' ');
  return transcript && transcript.length <= VOICE_MAX_INTENT_CHARS ? transcript : undefined;
}

export function normalizeVoiceTranscript(value: unknown): string | undefined {
  const bounded = boundedVoiceTranscript(value);
  if (!bounded) return undefined;
  let normalized = bounded.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
  // Natural invocations are cosmetic. Remove them only at the beginning, so a
  // command cannot become valid by hiding meaningful middle words.
  normalized = normalized.replace(/^(?:(?:jarvis|please|now|can you)\s+)+/, '');
  normalized = normalized.replace(/(?:\s+(?:please|now))+$/, '');
  return normalized && normalized.length <= VOICE_MAX_TRANSCRIPT_CHARS ? normalized : undefined;
}

export function voiceCommandFromTranscript(value: unknown): VoiceCommand | undefined {
  const transcript = normalizeVoiceTranscript(value);
  return transcript ? phrases.get(transcript) : undefined;
}

export type VoiceTranscriber = (audio: z.output<typeof voiceAudioSchema>) => Promise<string>;
export type VoiceBindingValidator = (request: Omit<VoiceCommandRequest, 'audio'>) => void | Promise<void>;
export type VoiceCommandDispatcher = (command: VoiceCommand, request: Omit<VoiceCommandRequest, 'audio'>) => Promise<{ message: string }>;

/**
 * A source transition invalidates a pending recording twice: before OAuth
 * transcription starts, and again before a recognized command is dispatched.
 * Transcript and audio are intentionally absent from the return value.
 */
export function createVoiceCommandHandler({ validate, transcribe, dispatch }: {
  validate: VoiceBindingValidator; transcribe: VoiceTranscriber; dispatch: VoiceCommandDispatcher;
}) {
  if (typeof validate !== 'function' || typeof transcribe !== 'function' || typeof dispatch !== 'function') {
    throw new TypeError('Voice commands require validation, transcription and dispatch callbacks.');
  }
  return async (raw: unknown): Promise<{ command?: VoiceCommand; message: string }> => {
    const input = voiceCommandRequestSchema.parse(raw);
    const { audio, ...binding } = input;
    await validate(binding);
    const transcript = await transcribe(audio);
    const command = voiceCommandFromTranscript(transcript);
    await validate(binding);
    if (!command) return { message: 'I did not recognize that command.' };
    const result = await dispatch(command, binding);
    return { command, message: result.message };
  };
}

type PrivateTool = (name: string, config: {
  title: string; description: string; inputSchema: { parse: (input: unknown) => unknown };
  annotations?: Record<string, unknown>; _meta?: Record<string, unknown>;
}, handle: (input: unknown) => Promise<unknown>) => unknown;

export type InspectionVoiceToolHooks = {
  /** Re-reads the current session/source/panel binding on every edge. */
  validate: VoiceBindingValidator;
  /** Production additionally confirms that a panel is the companion headset surface. */
  validateCompanion?: VoiceBindingValidator;
  /**
   * Speech only. Narration saves nothing, and it is requested exactly when the
   * view is moving: a tour step has just bumped the saved revision, or a remote
   * command is still `rendering`. Validating it with the capture gate refused
   * every spoken line the page originated as a 409 `request_failed`.
   * Production checks identity and surface here, not currency.
   */
  validateNarration?: VoiceBindingValidator;
  /** Test seam; production uses the OAuth-only Realtime helper. */
  transcribe?: VoiceTranscriber;
  /** Test seam; production uses the external OAuth-only speech helper. */
  acknowledge?: (message: string) => Promise<{ wavBase64: string }>;
  now?: () => number;
  annotations?: Record<string, unknown>;
  privateMeta?: Record<string, unknown>;
  cooldownMs?: number;
  /** Injectable bounded queues for server tests; production callers use the returned queues. */
  intentQueue?: InspectionVoiceIntentQueue;
  playbackQueue?: HeadsetVoicePlaybackQueue;
  /**
   * The one spoken command the HOST executes.
   *
   * Every other phrase in this vocabulary is a thing the page can do to itself,
   * so the page does it. "Undo that" is not: the history it reads belongs to
   * the shared scene on this Mac, and the change it takes back may have come
   * from the desktop panel or from an agent tool. So the host queues the
   * restoring command against the wearer's own panel and answers with the line
   * the wearer hears; the page speaks it and renders the command on its next
   * heartbeat, the same way it renders any other.
   */
  undo?: (request: Omit<VoiceCommandRequest, 'audio'>) => Promise<{ message: string }>;
  /**
   * Read where the wearer is, before transcription runs.
   *
   * The audio in hand was recorded a moment ago, so this is as close to the
   * start of the request as this route can get, and it is seconds earlier than
   * the answer. It rides on any request handed to the desktop agent.
   */
  captureReferent?: (request: Omit<VoiceCommandRequest, 'audio'>) => Promise<RequestReferent | undefined>;
};

export type InspectionVoiceIntent = Omit<VoiceCommandRequest, 'audio'> & {
  id: string;
  createdAt: number;
  transcript: string;
  /**
   * What the wearer meant by "this" when the press began.
   *
   * A free-spoken request leaves here for the desktop agent, which may take
   * seconds to answer it. Reading the selection at that point names whatever
   * is under the pointer then, so the referent travels with the words.
   */
  referent?: RequestReferent;
};

type VoiceIntentScope = Pick<InspectionVoiceIntent, 'sessionId' | 'sourceToken'>;
export type DesktopVoiceIntentScope = VoiceIntentScope & { desktopPanelId: string };
export type VoiceIntentClaim = { intent: InspectionVoiceIntent; claimToken: string; desktopPanelId: string };
export type VoiceIntentAcknowledgement = { intentId: string; claimToken: string; desktopPanelId: string };
export type InspectionVoiceIntentQueue = {
  enqueue(intent: Omit<InspectionVoiceIntent, 'id' | 'createdAt'>): { id: string };
  claim(scope: DesktopVoiceIntentScope): VoiceIntentClaim | undefined;
  acknowledge(receipt: VoiceIntentAcknowledgement): boolean;
  clear(scope: VoiceIntentScope): number;
  size(scope?: VoiceIntentScope): number;
};

/**
 * A small source-scoped handoff queue for requests outside the deterministic
 * grammar. Its consumer is the current desktop host panel, which can ask
 * Codex to handle the user's text. Audio and old-source intents never leave
 * the capture request.
 */
export function createInspectionVoiceIntentQueue({ now = Date.now, ttlMs = 300_000, maxPending = 16 }: {
  now?: () => number; ttlMs?: number; maxPending?: number;
} = {}): InspectionVoiceIntentQueue {
  if (typeof now !== 'function' || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || !Number.isSafeInteger(maxPending) || maxPending < 1) {
    throw new TypeError('Voice intent queue requires bounded lifetime and capacity.');
  }
  const pending = new Map<string, InspectionVoiceIntent>();
  const claimed = new Map<string, VoiceIntentClaim>();
  const prune = () => {
    const cutoff = now() - ttlMs;
    for (const [id, intent] of pending) if (intent.createdAt <= cutoff) pending.delete(id);
    for (const [id, claim] of claimed) if (claim.intent.createdAt <= cutoff) claimed.delete(id);
  };
  const matches = (intent: InspectionVoiceIntent, scope: VoiceIntentScope) => intent.sessionId === scope.sessionId && intent.sourceToken === scope.sourceToken;
  return {
    enqueue(intent: Omit<InspectionVoiceIntent, 'id' | 'createdAt'>) {
      prune();
      if (pending.size + claimed.size >= maxPending) throw Error('Too many pending voice requests.');
      const id = randomUUID();
      pending.set(id, { ...intent, id, createdAt: now() });
      return { id };
    },
    /** Atomically claims one intent, so retrying a host poll cannot send it twice. */
    claim(scope: DesktopVoiceIntentScope): VoiceIntentClaim | undefined {
      prune();
      for (const [id, intent] of pending) {
        if (!matches(intent, scope)) continue;
        pending.delete(id);
        const claim = { intent, claimToken: randomUUID(), desktopPanelId: scope.desktopPanelId };
        claimed.set(id, claim);
        return claim;
      }
      return undefined;
    },
    /** Records a successful host delivery and drops the one-time intent. */
    acknowledge(receipt: VoiceIntentAcknowledgement) {
      const stored = claimed.get(receipt.intentId);
      if (!stored || stored.claimToken !== receipt.claimToken || stored.desktopPanelId !== receipt.desktopPanelId) return false;
      return claimed.delete(receipt.intentId);
    },
    /** A source replacement drops both queued and claimed old-source text. */
    clear(scope: VoiceIntentScope) {
      let removed = 0;
      for (const [id, intent] of pending) if (matches(intent, scope)) { pending.delete(id); removed++; }
      for (const [id, claim] of claimed) if (matches(claim.intent, scope)) { claimed.delete(id); removed++; }
      return removed;
    },
    size(scope?: VoiceIntentScope) {
      prune();
      if (!scope) return pending.size + claimed.size;
      let count = 0;
      for (const intent of pending.values()) if (matches(intent, scope)) count++;
      for (const claim of claimed.values()) if (matches(claim.intent, scope)) count++;
      return count;
    },
  };
}

export type HeadsetVoicePlayback = Omit<VoiceAcknowledgementRequest, 'message'> & {
  id: string; createdAt: number; wavBase64: string;
};
export type HeadsetVoicePlaybackQueue = {
  enqueue(playback: Omit<HeadsetVoicePlayback, 'id' | 'createdAt'>): { id: string };
  next(scope: Pick<HeadsetVoicePlayback, 'sessionId' | 'sourceToken' | 'panelId'>): HeadsetVoicePlayback | undefined;
  acknowledge(id: string, scope: Pick<HeadsetVoicePlayback, 'sessionId' | 'sourceToken' | 'panelId'>): boolean;
  clear(scope: VoiceIntentScope): number;
  size(scope?: VoiceIntentScope): number;
  lastAcknowledgement(scope: VoiceIntentScope): HeadsetVoicePlaybackReceipt | undefined;
};
export type HeadsetVoicePlaybackReceipt = Pick<HeadsetVoicePlayback, 'id' | 'sessionId' | 'sourceToken' | 'panelId'> & { acknowledgedAt: number };

/** Short OAuth WAV responses await a companion playback receipt in memory. */
export function createHeadsetVoicePlaybackQueue({ now = Date.now, ttlMs = 300_000, maxPending = 8 }: {
  now?: () => number; ttlMs?: number; maxPending?: number;
} = {}): HeadsetVoicePlaybackQueue {
  if (typeof now !== 'function' || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || !Number.isSafeInteger(maxPending) || maxPending < 1) {
    throw new TypeError('Headset voice playback queue requires bounded lifetime and capacity.');
  }
  const pending = new Map<string, HeadsetVoicePlayback>();
  const acknowledgements = new Map<string, HeadsetVoicePlaybackReceipt>();
  const prune = () => { const cutoff = now() - ttlMs; for (const [id, item] of pending) if (item.createdAt <= cutoff) pending.delete(id); };
  const matches = (item: HeadsetVoicePlayback, scope: Pick<HeadsetVoicePlayback, 'sessionId' | 'sourceToken' | 'panelId'>) => item.sessionId === scope.sessionId && item.sourceToken === scope.sourceToken && item.panelId === scope.panelId;
  return {
    enqueue(playback) {
      prune();
      if (pending.size >= maxPending) throw Error('Too many pending headset acknowledgements.');
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(playback.wavBase64) || playback.wavBase64.length < 4 || playback.wavBase64.length > 1_000_000) throw Error('Headset acknowledgement is not bounded WAV data.');
      const id = randomUUID(); pending.set(id, { ...playback, id, createdAt: now() }); return { id };
    },
    next(scope) { prune(); for (const item of pending.values()) if (matches(item, scope)) return item; return undefined; },
    acknowledge(id, scope) {
      prune(); const item = pending.get(id);
      if (!item || !matches(item, scope)) return false;
      pending.delete(id);
      acknowledgements.set(`${item.sessionId}:${item.sourceToken}`, { id:item.id, sessionId:item.sessionId, sourceToken:item.sourceToken, panelId:item.panelId, acknowledgedAt:now() });
      while (acknowledgements.size > 64) acknowledgements.delete(acknowledgements.keys().next().value!);
      return true;
    },
    clear(scope) { let removed = 0; for (const [id, item] of pending) if (item.sessionId === scope.sessionId && item.sourceToken === scope.sourceToken) { pending.delete(id); removed++; } return removed; },
    size(scope?: VoiceIntentScope) {
      prune();
      if (!scope) return pending.size;
      let count = 0;
      for (const item of pending.values()) if (item.sessionId === scope.sessionId && item.sourceToken === scope.sourceToken) count++;
      return count;
    },
    lastAcknowledgement(scope) { return acknowledgements.get(`${scope.sessionId}:${scope.sourceToken}`); },
  };
}

const VOICE_PANEL_COOLDOWN_MS = 1_000;
const MAX_TRACKED_VOICE_PANELS = 64;
/** Narration, a scene confirmation and one agent line may all be in flight. */
const MAX_CONCURRENT_SPEECH_PER_PANEL = 4;

/**
 * Register the two app-only voice tools on the existing inspection `/tool`
 * route. Recognition never changes an experience: the browser validates its
 * local generation and executes the returned typed command. It may then call
 * the acknowledgement tool after a renderer success.
 */
/** Each distinct reason once per process, so a silent headset leaves one line in the log rather than one per chapter. */
const silentReasons = new Set<string>();
function noteSilentAcknowledgement(error: unknown) {
  const reason = error instanceof Error ? error.message : String(error);
  if (silentReasons.has(reason)) return;
  silentReasons.add(reason);
  console.error(`Stereofold: spoken confirmations are silent on this Mac. ${reason}`);
}

export function registerInspectionVoiceTools(privateTool: PrivateTool, hooks: InspectionVoiceToolHooks) {
  if (typeof privateTool !== 'function' || typeof hooks?.validate !== 'function') {
    throw new TypeError('Voice tool registration requires the private tool and binding validator.');
  }
  const transcribe = hooks.transcribe ?? createOAuthVoiceTranscriber();
  const acknowledge = hooks.acknowledge ?? voiceAcknowledgementFromEnv();
  const validateCompanion = hooks.validateCompanion ?? hooks.validate;
  const validateNarration = hooks.validateNarration ?? validateCompanion;
  const now = hooks.now ?? Date.now;
  const cooldownMs = hooks.cooldownMs ?? VOICE_PANEL_COOLDOWN_MS;
  if (!Number.isSafeInteger(cooldownMs) || cooldownMs < 0) throw new TypeError('Voice tool cooldown must be a non-negative integer.');
  const active = new Set<string>();
  const lastStarted = new Map<string, number>();
  const intents = hooks.intentQueue ?? createInspectionVoiceIntentQueue({ now });
  const playbacks = hooks.playbackQueue ?? createHeadsetVoicePlaybackQueue({ now });

  const enter = (panelId: string) => {
    const time = now();
    for (const [known, started] of lastStarted) if (time - started > 60_000) lastStarted.delete(known);
    if (active.has(panelId)) throw Error('A voice request is already processing for this panel.');
    const previous = lastStarted.get(panelId);
    if (previous !== undefined && time - previous < cooldownMs) throw Error('Please wait briefly before another voice request.');
    if (!lastStarted.has(panelId) && lastStarted.size >= MAX_TRACKED_VOICE_PANELS) throw Error('Too many active voice panels.');
    active.add(panelId); lastStarted.set(panelId, time);
  };
  const leave = (panelId: string) => { active.delete(panelId); };
  /**
   * Speech is not capture, so it does not take the capture lock.
   *
   * A tour step narrates and confirms in the same tick, and the wearer's own
   * request is answered while the scene it describes is still settling. Sharing
   * `enter`'s exclusive slot and one-second cooldown made the second line of
   * every pair fail. Concurrency is still bounded, only high enough that the
   * lines a single scene change produces all reach the wearer.
   */
  const speaking = new Map<string, number>();
  const beginSpeech = (panelId: string) => {
    const count = speaking.get(panelId) ?? 0;
    if (!speaking.has(panelId) && speaking.size >= MAX_TRACKED_VOICE_PANELS) throw Error('Too many active voice panels.');
    if (count >= MAX_CONCURRENT_SPEECH_PER_PANEL) throw Error('Too many spoken lines are already in flight for this panel.');
    speaking.set(panelId, count + 1);
  };
  const endSpeech = (panelId: string) => {
    const count = (speaking.get(panelId) ?? 1) - 1;
    if (count > 0) speaking.set(panelId, count); else speaking.delete(panelId);
  };
  const config = { annotations: hooks.annotations ?? { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }, _meta: hooks.privateMeta ?? { ui: { visibility: ['app'] } } };

  privateTool('stereo_structure.voice_command', {
    title: 'Recognize a bounded headset voice command',
    description: 'App-only OAuth transcription for one short microphone capture from a current ready companion panel. It returns only a known typed command, never a transcript or molecular edit.',
    inputSchema: voiceCommandRequestSchema, ...config,
  }, async raw => {
    const input = voiceCommandRequestSchema.parse(raw);
    const { audio, ...binding } = input;
    enter(binding.panelId);
    try {
      await validateCompanion(binding);
      // Before the seconds of transcription, not after them.
      const referent = await hooks.captureReferent?.(binding);
      const transcript = boundedVoiceTranscript(await transcribe(audio));
      const command = voiceCommandFromTranscript(transcript);
      await validateCompanion(binding);
      if (command) {
        // The host owns the shared undo history, so this one
        // phrase is executed here and the page is told it was handled.
        if (command === 'undo' && hooks.undo) {
          const { message } = await hooks.undo(binding);
          return { content: [{ type: 'text' as const, text: message }], structuredContent: { command, message, handled: true } };
        }
        const message = `Recognized ${command}.`;
        return { content: [{ type: 'text' as const, text: message }], structuredContent: { command, message } };
      }
      // An unrecognized spoken request is not a dead end. The companion sees
      // no transcript; the current desktop host may claim the bounded text
      // from its source-scoped queue and submit it as the user's own request.
      if (transcript) {
        const intent = intents.enqueue({ ...binding, transcript, ...(referent ? { referent } : {}) });
        const message = 'Request queued for the connected task.';
        return { content: [{ type: 'text' as const, text: message }], structuredContent: { intentId: intent.id, message } };
      }
      return { content: [{ type: 'text' as const, text: 'I could not hear a usable request.' }], structuredContent: { message: 'I could not hear a usable request.' } };
    } finally { leave(binding.panelId); }
  });

  privateTool('stereo_structure.voice_acknowledgement', {
    title: 'Create a short completed-action voice acknowledgement',
    description: 'App-only OAuth narration for a current ready companion panel after its renderer completed an action. The message is one short line and the response is WAV audio only.',
    inputSchema: voiceAcknowledgementRequestSchema, ...config,
  }, async raw => {
    const input = voiceAcknowledgementRequestSchema.parse(raw);
    const { message, ...binding } = input;
    beginSpeech(binding.panelId);
    try {
      await validateNarration(binding);
      let wav: { wavBase64: string } | undefined;
      try { wav = await acknowledge(message); }
      catch (error) {
        // The page keeps its caption and plays nothing. The reason names
        // settings and paths on this Mac, so it goes to this Mac's log and to
        // get_readiness, never onto the wearer's screen.
        noteSilentAcknowledgement(error);
        return { structuredContent: { speechDropped: true } };
      }
      if (!wav || typeof wav.wavBase64 !== 'string' || wav.wavBase64.length < 4) throw Error('Voice acknowledgement did not return WAV audio.');
      // Synthesis can run for seconds. A line about a structure that has since
      // been replaced is still refused; only currency of revision is not.
      await validateNarration(binding);
      return { structuredContent: { wavBase64: wav.wavBase64 } };
    } finally { endSpeech(binding.panelId); }
  });

  // This registration deliberately has no app-only visibility metadata. The
  // desktop host/model can request a brief spoken answer for an explicit,
  // current headset panel, while the companion can only receive it through
  // the source-scoped playback queue and acknowledge it after playing.
  privateTool('stereo_structure.speak_to_headset', {
    title: 'Speak a short response to the intended headset panel',
    description: 'After completing a user-requested action, create one short OAuth voice response for the current intended companion panel. Use current inspection bindings and do not claim playback completed until its panel acknowledges it.',
    inputSchema: voiceAcknowledgementRequestSchema,
    annotations: config.annotations,
    _meta: {},
  }, async raw => {
    const input = voiceAcknowledgementRequestSchema.parse(raw);
    const { message, ...binding } = input;
    beginSpeech(binding.panelId);
    try {
      await validateNarration(binding);
      const wav = await acknowledge(message);
      if (!wav || typeof wav.wavBase64 !== 'string' || wav.wavBase64.length < 4) throw Error('Voice acknowledgement did not return WAV audio.');
      await validateNarration(binding);
      const queued = playbacks.enqueue({ ...binding, wavBase64: wav.wavBase64 });
      return { content: [{ type: 'text' as const, text: 'Headset response queued for playback.' }], structuredContent: { playbackId: queued.id, queued: true } };
    } finally { endSpeech(binding.panelId); }
  });
  return { intents, playbacks };
}
