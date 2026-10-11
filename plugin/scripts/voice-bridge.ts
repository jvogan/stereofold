/**
 * Voice bridge: the missing middle between the headset page's instant grammar
 * and the orchestrating agent's 15-40 s transcript loop.
 *
 * The page executes ~40 fixed phrases itself the moment it transcribes them
 * and speaks its own confirmation, through the OAuth narration route when one
 * is registered
 * (lab/browser-roundtrip/voice-command-runner.mjs).
 * Everything else sits in the transcript queue until an agent polls it. This
 * daemon polls the same queue `listen-voice.ts` reads
 * (`poll_voice_transcripts` on the loopback `/agent` route) and acts within
 * ~2 s, in two tiers:
 *
 * - Tier 0 (local, microseconds): `voice-bridge-tier0.ts` synonym table over
 *   the existing grammar, mapped to update_inspection / control_tour /
 *   focus_selection with the binding filled from get_inspection_state, plus a
 *   sub-six-word confirmation via say_to_headset.
 * - Tier 1 (fast model, <2 s): anything Tier 0 misses goes to a small LLM
 *   with four tools as a JSON schema and a state summary. It returns one tool
 *   call or a short spoken answer. The plugin's existing authenticated routes
 *   (headset-voice-provider.ts, oauth-voice-*.ts) carry transcription and
 *   narration audio only — none reaches an Anthropic model — so Tier 1 reads
 *   STEREOFOLD_BRIDGE_MODEL / ANTHROPIC_API_KEY from the environment at
 *   runtime and never writes a key anywhere.
 *
 * Safety: the bridge only ever calls get_inspection_state,
 * poll_voice_transcripts, update_inspection, control_tour, focus_selection,
 * emphasize and say_to_headset. It never navigates, reloads, or touches a
 * destructive tool; it takes at most one action per utterance; it rate
 * limits; every decision is appended (redacted) to the bridge log.
 *
 *     tsx scripts/voice-bridge.ts /absolute/path/to/host-state.json [--dry-run]
 *       [--replay] [--require-prefix claude] [--log bridge.log]
 *       [--escalations escalations.log] [--once]
 *     tsx scripts/voice-bridge.ts --say "make it tiny"   # one-shot decision, no host
 *     tsx scripts/voice-bridge.ts --help
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { fillAgentArguments, isPreDispatchRefusal } from './agent-arguments.js';
import { reportRefusalToHeadset } from './inspection-agent.js';
import { RECEIPT_POLL_MS, RECEIPT_WAIT_MS, awaitReceipt } from './inspection-agent.js';
import { callLocalAgent, readControlState, type ControlState } from './local-agent.js';
import { createVoiceTranscriptConsumer, sameVoiceSession } from './voice-transcript-consumer.js';
import { matchTier0, normalizeBridgeTranscript, type Tier0Decision } from './voice-bridge-tier0.js';
// @ts-ignore Shared numerical placement guardrails used by the renderer and host.
import { PLACEMENT_MIN_SCALE, PLACEMENT_MAX_SCALE, PLACEMENT_MAX_TRANSLATION } from '../../lab/browser-roundtrip/placement-limits.mjs';
// @ts-ignore The page grammar is JavaScript with no types; the bridge reuses
// the real resolver rather than a copy so the two cannot drift apart.
import { spatialVoiceAction } from '../../lab/browser-roundtrip/voice-command-runner.mjs';

const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;
/** Minimum gap between two executed actions. */
export const MIN_ACTION_INTERVAL_MS = 800;
/** Sliding-window ceiling on executed actions. */
export const MAX_ACTIONS_PER_MINUTE = 20;
/** How long Tier 1 may take; the whole utterance must land under ~2 s. */
export const TIER1_TIMEOUT_MS = 1_500;
export const TIER1_MAX_WORDS = 12;
export const BRIDGE_MODEL_ENV = 'STEREOFOLD_BRIDGE_MODEL';
export const BRIDGE_KEY_ENV = 'ANTHROPIC_API_KEY';
export const DEFAULT_BRIDGE_MODEL = 'claude-haiku-4-5-20251001';
/** Spoken right after an action posts, before its receipt lands. Two words. */
export const BRIDGE_ACK_TEXT = 'On it.';
/** Spoken when an action fails to render or its call throws. Four words. */
export const BRIDGE_FAILURE_TEXT = "Sorry, that didn't work.";
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const BLUR_RETRIES = 5;
const BLUR_POLL_MS = 400;

const here = dirname(fileURLToPath(import.meta.url));
const worktreeRoot = resolve(here, '..', '..');
export const DEFAULT_ESCALATIONS_PATH = resolve(worktreeRoot, '.stereofold/voicebridge/escalations.log');
export const DEFAULT_BRIDGE_LOG_PATH = resolve(worktreeRoot, '.stereofold/voicebridge/bridge.log');

export type BridgeOptions = {
  statePath: string;
  dryRun?: boolean;
  replay?: boolean;
  requirePrefix?: string;
  logPath?: string;
  escalationsPath?: string;
  once?: boolean;
  /** One-shot decision print: route one transcript with no host and exit. */
  say?: string;
  help?: boolean;
  environment?: NodeJS.ProcessEnv;
};

export const BRIDGE_USAGE = [
  'Usage:',
  '  voice-bridge.ts /absolute/path/to/host-state.json [--dry-run] [--replay] [--require-prefix word] [--log path] [--escalations path] [--once]',
  '  voice-bridge.ts --say "make it tiny" [--require-prefix word]',
  '  voice-bridge.ts --help',
  '',
  '--say prints the routing decision for one transcript and calls nothing:',
  'no host, no log, no key. The scale step assumes the saved placement is 1.',
].join('\n');

export function parseBridgeArgs(argv: string[]): BridgeOptions {
  const positional: string[] = [];
  const options: BridgeOptions = { statePath: '' };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--replay') options.replay = true;
    else if (argument === '--once') options.once = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--say') {
      const text = argv[++index];
      if (!text) throw Error('--say needs a transcript.');
      options.say = text;
    }
    else if (argument === '--require-prefix') options.requirePrefix = argv[++index] ?? '';
    else if (argument === '--log') options.logPath = argv[++index] ?? '';
    else if (argument === '--escalations') options.escalationsPath = argv[++index] ?? '';
    else if (argument.startsWith('--')) throw Error(`Unknown flag ${argument}.\n${BRIDGE_USAGE}`);
    else positional.push(argument);
  }
  if (options.help === true) return options;
  // One-shot mode needs no control file: there is no host to read.
  if (options.say !== undefined) {
    if (positional.length > 0) throw Error(`--say takes no control file.\n${BRIDGE_USAGE}`);
    return options;
  }
  if (positional.length !== 1 || !positional[0]) {
    throw Error(BRIDGE_USAGE);
  }
  if (!isAbsolute(positional[0])) throw Error('The control state-file path must be absolute.');
  options.statePath = positional[0];
  return options;
}

/**
 * Route one transcript with no host: the page guard runs locally, Tier 0
 * reads a default scale of 1, and anything else reports tier1 (the model
 * itself is never called). Prints the decision as JSON.
 */
export function printSayDecision(raw: string, prefix?: string): BridgeDecision {
  const summary: InspectionSummary = { hasScene: false, scale: 1, tours: [], readyPanels: 0 };
  const decision = decideUtterance({ raw, prefix, summary });
  console.log(JSON.stringify({ utterance: raw, normalized: normalizeBridgeTranscript(raw) ?? null, decision }, null, 2));
  return decision;
}

const SENSITIVE_KEY = /(token|secret|password|api[_-]?key|authorization|bearer|wav|base64|audio)/i;

/** Deep-clone for the log with capabilities, keys and audio replaced. */
export function redactForLog(value: unknown): unknown {
  if (typeof value === 'string') {
    return value
      .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer <redacted>')
      .replace(/#\S*/g, '#<page key hidden>')
      .slice(0, 500);
  }
  if (Array.isArray(value)) return value.slice(0, 32).map(redactForLog);
  if (value !== null && typeof value === 'object') {
    const clone: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      clone[key] = SENSITIVE_KEY.test(key) ? '<redacted>' : redactForLog(entry);
    }
    return clone;
  }
  return value;
}

export function createRateLimiter({ minIntervalMs = MIN_ACTION_INTERVAL_MS, maxPerMinute = MAX_ACTIONS_PER_MINUTE, now = Date.now } = {}) {
  let lastAt = Number.NEGATIVE_INFINITY;
  const hits: number[] = [];
  return {
    check(): { ok: true } | { ok: false; reason: string } {
      const at = now();
      while (hits.length && hits[0] <= at - 60_000) hits.shift();
      if (at - lastAt < minIntervalMs) return { ok: false, reason: 'too soon after the previous action' };
      if (hits.length >= maxPerMinute) return { ok: false, reason: 'too many actions in the last minute' };
      lastAt = at;
      hits.push(at);
      return { ok: true };
    },
  };
}

/** Optional wake word, off by default because the wearer presses Talk. */
export function stripWakePrefix(normalized: string, prefix?: string): string | undefined {
  const wake = (prefix ?? '').toLowerCase().trim().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!wake) return normalized;
  if (normalized === wake) return undefined;
  if (normalized.startsWith(`${wake} `)) return normalized.slice(wake.length + 1).trim() || undefined;
  return undefined;
}

export type LessonPart = { id: string; label?: string };

/**
 * Whether the companion page already acted on this utterance and spoke its
 * own confirmation. The page's resolver is context-sensitive in two ways — a
 * bare "stop" (tour pause vs spin stop) and, since then, a jump to a numbered
 * residue (the residue browser vs the molecule) — so every combination is
 * tried: a claim under any one of them means the page took it. Lesson parts
 * come from the current inspection state, read fresh for the utterance.
 *
 * The residue-browser reading is new here. Without it "go to 141"
 * looked unclaimed from the Mac while the page's own grammar acted on it the
 * moment the browser was open, and the wearer would have had the residue
 * framed twice, by two speakers, for one sentence. Erring towards the page is
 * the module's standing rule: Tier 0 exists for the synonyms the page misses.
 */
export function pageClaimsAction(rawTranscript: string, lessonParts: LessonPart[] = []): boolean {
  for (const spinning of [false, true]) {
    for (const sequenceOpen of [false, true]) {
      try {
        const resolved = spatialVoiceAction(rawTranscript, { spinning, lessonParts, sequenceOpen }) as
          { action?: unknown } | undefined;
        if (resolved && resolved.action) return true;
      } catch { /* An unresolvable transcript is unclaimed. */ }
    }
  }
  return false;
}

export type InspectionSummary = {
  hasScene: boolean;
  scale?: number;
  selectedResidueCount?: number;
  lesson?: { id: string; title: string; parts: LessonPart[] };
  tours: { id: string; title: string }[];
  readyPanels: number;
};

/** The facts Tier 0 needs (scale) and Tier 1 gets (lesson, selection). */
export function summarizeInspectionState(structured: any): InspectionSummary {
  const view = structured?.view ?? {};
  const placement = view?.inspection?.placement ?? view?.placement ?? {};
  const scale = typeof placement?.scale === 'number' && Number.isFinite(placement.scale) ? placement.scale : undefined;
  const lesson = structured?.lesson && typeof structured.lesson === 'object'
    ? {
      id: String(structured.lesson.id ?? ''),
      title: String(structured.lesson.title ?? ''),
      parts: Array.isArray(structured.lesson.parts)
        ? structured.lesson.parts
          .filter((part: any) => part && typeof part.id === 'string')
          .slice(0, 12)
          .map((part: any) => ({ id: part.id, ...(typeof part.label === 'string' ? { label: part.label } : {}) }))
        : [],
    }
    : undefined;
  const tours = Array.isArray(structured?.tours)
    ? structured.tours
      .filter((tour: any) => tour && typeof tour.id === 'string')
      .slice(0, 12)
      .map((tour: any) => ({ id: tour.id, title: String(tour.title ?? tour.id) }))
    : [];
  const panels = Array.isArray(structured?.panels) ? structured.panels : [];
  return {
    hasScene: structured?.hasScene === true,
    ...(scale === undefined ? {} : { scale }),
    ...(typeof view?.selectedResidueCount === 'number' ? { selectedResidueCount: view.selectedResidueCount } : {}),
    ...(lesson ? { lesson } : {}),
    tours,
    readyPanels: panels.filter((panel: any) => panel?.current === true && panel?.availability === 'ready').length,
  };
}

export type Tier1ToolName = 'update_inspection' | 'control_tour' | 'focus_selection' | 'emphasize';

/** The only tools Tier 1 may call. Nothing here navigates, reloads, opens, closes, or deletes. */
export function tier1Tools(summary: InspectionSummary): Record<string, unknown>[] {
  const partNames = summary.lesson?.parts.map(part => part.label ?? part.id) ?? [];
  return [
    {
      name: 'update_inspection',
      description: 'Change molecule placement, turntable spin, or render quality. One change per call.',
      input_schema: {
        type: 'object',
        properties: {
          change: {
            type: 'object',
            oneOf: [
              {
                type: 'object', properties: {
                  kind: { const: 'placement' },
                  patch: {
                    type: 'object',
                    properties: {
                      translation: { type: 'array', items: { type: 'number', minimum: -PLACEMENT_MAX_TRANSLATION, maximum: PLACEMENT_MAX_TRANSLATION }, minItems: 3, maxItems: 3 },
                      rotation: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
                      scale: { type: 'number', minimum: PLACEMENT_MIN_SCALE, maximum: PLACEMENT_MAX_SCALE },
                    },
                    minProperties: 1,
                  },
                },
                required: ['kind', 'patch'],
              },
              {
                type: 'object', properties: {
                  kind: { const: 'motion' },
                  patch: { type: 'object', properties: { state: { enum: ['spin', 'stop'] } }, required: ['state'] },
                },
                required: ['kind', 'patch'],
              },
              {
                type: 'object', properties: {
                  kind: { const: 'render-quality' },
                  patch: { type: 'object', properties: { level: { enum: ['fast', 'balanced', 'best'] } }, required: ['level'] },
                },
                required: ['kind', 'patch'],
              },
            ],
          },
        },
        required: ['change'],
      },
    },
    {
      name: 'control_tour',
      description: 'Play, pause, step, or open the menu of the running tour.',
      input_schema: {
        type: 'object',
        properties: {
          action: { enum: ['play', 'pause', 'next', 'back', 'menu'] },
          ...(summary.tours.length ? { tourId: { enum: summary.tours.map(tour => tour.id) } } : {}),
        },
        required: ['action'],
      },
    },
    {
      name: 'focus_selection',
      description: 'Bring what is already selected into view. framing fill holds it close, context keeps surroundings.',
      input_schema: {
        type: 'object',
        properties: { framing: { enum: ['fill', 'context'] } },
      },
    },
    {
      name: 'emphasize',
      description: partNames.length
        ? `Light named lesson parts, fading the rest. Only these names exist: ${partNames.join(', ')}.`
        : 'Light named lesson parts. No lesson is loaded, so this tool cannot be used right now.',
      input_schema: {
        type: 'object',
        properties: { parts: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8 } },
        required: ['parts'],
      },
    },
  ];
}

export function tier1SystemPrompt(summary: InspectionSummary): string {
  const lines = [
    'You are the fast voice loop for a person wearing a VR headset looking at a molecule.',
    'Answer with exactly one tool call, or with a spoken reply of at most 12 words.',
    'Use a tool only for a visible change the tools can make. Otherwise reply in words.',
    `Scene loaded: ${summary.hasScene ? 'yes' : 'no'}.`,
    `Current scale: ${summary.scale ?? 'unknown'}.`,
    `Selected residues: ${summary.selectedResidueCount ?? 0}.`,
    summary.lesson
      ? `Lesson: ${summary.lesson.title} (parts: ${summary.lesson.parts.map(part => part.label ?? part.id).join(', ') || 'none'}).`
      : 'No lesson loaded.',
    summary.tours.length ? `Tours: ${summary.tours.map(tour => tour.id).join(', ')}.` : 'No tours listed.',
  ];
  return lines.join('\n');
}

export type Tier1Result =
  | { kind: 'tool'; name: Tier1ToolName; args: Record<string, unknown> }
  | { kind: 'speak'; text: string }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'refused'; reason: string };

const TIER1_NAMES: ReadonlySet<string> = new Set(['update_inspection', 'control_tour', 'focus_selection', 'emphasize']);

function finiteTriple(value: unknown, min: number, max: number): value is [number, number, number] {
  return Array.isArray(value) && value.length === 3
    && value.every(entry => typeof entry === 'number' && Number.isFinite(entry) && entry >= min && entry <= max);
}

/** Validate one model-proposed tool call against the allowlist. Refuses anything else. */
export function validateTier1Call(name: string, args: any, summary: InspectionSummary): Tier1Result {
  if (!TIER1_NAMES.has(name)) return { kind: 'refused', reason: `tool ${name} is not offered` };
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return { kind: 'refused', reason: 'tool arguments must be an object' };
  }
  if (name === 'update_inspection') {
    const change = (args as any).change;
    const kind = change?.kind;
    if (kind === 'placement') {
      const patch = change?.patch;
      if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return { kind: 'refused', reason: 'bad placement patch' };
      const { translation, rotation, scale } = patch as Record<string, unknown>;
      if (translation !== undefined && !finiteTriple(translation, -PLACEMENT_MAX_TRANSLATION, PLACEMENT_MAX_TRANSLATION)) return { kind: 'refused', reason: 'bad translation' };
      if (rotation !== undefined && !finiteTriple(rotation, -360, 360)) return { kind: 'refused', reason: 'bad rotation' };
      if (scale !== undefined && (typeof scale !== 'number' || !Number.isFinite(scale) || scale < PLACEMENT_MIN_SCALE || scale > PLACEMENT_MAX_SCALE)) {
        return { kind: 'refused', reason: 'scale out of range' };
      }
      if (translation === undefined && rotation === undefined && scale === undefined) {
        return { kind: 'refused', reason: 'empty placement patch' };
      }
      return { kind: 'tool', name, args: { change: { kind: 'placement', patch: { ...(translation !== undefined ? { translation } : {}), ...(rotation !== undefined ? { rotation } : {}), ...(scale !== undefined ? { scale } : {}) } } } };
    }
    if (kind === 'motion') {
      const state = change?.patch?.state;
      if (state !== 'spin' && state !== 'stop') return { kind: 'refused', reason: 'bad motion state' };
      return { kind: 'tool', name, args: { change: { kind: 'motion', patch: { state } } } };
    }
    if (kind === 'render-quality') {
      const level = change?.patch?.level;
      if (level !== 'fast' && level !== 'balanced' && level !== 'best') return { kind: 'refused', reason: 'bad quality level' };
      return { kind: 'tool', name, args: { change: { kind: 'render-quality', patch: { level } } } };
    }
    return { kind: 'refused', reason: `change kind ${String(kind)} is not offered` };
  }
  if (name === 'control_tour') {
    const action = (args as any).action;
    if (!['play', 'pause', 'next', 'back', 'menu'].includes(action)) return { kind: 'refused', reason: 'bad tour action' };
    if ((args as any).tourId !== undefined) return { kind: 'refused', reason: 'tour start needs a tour id the summary does not list' };
    return { kind: 'tool', name, args: { action } };
  }
  if (name === 'focus_selection') {
    const framing = (args as any).framing ?? 'context';
    if (framing !== 'fill' && framing !== 'context') return { kind: 'refused', reason: 'bad framing' };
    if ((args as any).selectionKeys !== undefined || (args as any).residues !== undefined) {
      return { kind: 'refused', reason: 'the model cannot name residues' };
    }
    return { kind: 'tool', name, args: { framing } };
  }
  // Narrow the tool name: the three branches above returned, so anything
  // left that is not emphasize was never offered.
  if (name !== 'emphasize') return { kind: 'refused', reason: `tool ${name} is not offered` };
  const parts = (args as any).parts;
  if (!Array.isArray(parts) || !parts.length || parts.length > 8 || !parts.every(part => typeof part === 'string' && part.length && part.length <= 80)) {
    return { kind: 'refused', reason: 'bad parts list' };
  }
  const known = new Set((summary.lesson?.parts ?? []).flatMap(part => [part.id, part.label ?? '']));
  if (!parts.every(part => known.has(part))) return { kind: 'refused', reason: 'unknown lesson part' };
  return { kind: 'tool', name, args: { parts } };
}

export type Tier1Fetch = (url: string, init: Record<string, unknown>) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;

/**
 * One fast-model turn. The key travels only in the request header and is
 * never logged, stored, or written; it is read from the environment here, at
 * call time, so a key exported after the daemon started still works and one
 * removed mid-session stops being used.
 */
export async function callTier1Model({ utterance, summary, environment = process.env, fetchFn = globalThis.fetch as unknown as Tier1Fetch, timeoutMs = TIER1_TIMEOUT_MS }:
{ utterance: string; summary: InspectionSummary; environment?: NodeJS.ProcessEnv; fetchFn?: Tier1Fetch; timeoutMs?: number }): Promise<Tier1Result> {
  const model = (environment[BRIDGE_MODEL_ENV] ?? '').trim() || DEFAULT_BRIDGE_MODEL;
  const apiKey = (environment[BRIDGE_KEY_ENV] ?? '').trim();
  if (!apiKey) return { kind: 'unavailable', reason: `${BRIDGE_KEY_ENV} is not set` };
  let body: any;
  try {
    const response = await fetchFn(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: 200,
        system: tier1SystemPrompt(summary),
        messages: [{ role: 'user', content: utterance }],
        tools: tier1Tools(summary),
        tool_choice: { type: 'auto' },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { kind: 'unavailable', reason: `model answered ${response.status}` };
    body = await response.json();
  } catch (error) {
    return { kind: 'unavailable', reason: error instanceof Error ? error.message.slice(0, 120) : 'model call failed' };
  }
  const blocks = Array.isArray(body?.content) ? body.content : [];
  // One action per utterance: the first tool call wins, the rest are ignored.
  const call = blocks.find((block: any) => block?.type === 'tool_use');
  if (call) return validateTier1Call(String(call.name ?? ''), call.input ?? {}, summary);
  const text = blocks
    .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
    .map((block: any) => block.text as string)
    .join(' ').replace(/\s+/g, ' ').trim();
  if (!text) return { kind: 'refused', reason: 'empty model answer' };
  return { kind: 'speak', text };
}

/** Twelve words or fewer for the spoken half; the full line is escalated. */
export function shortenForSpeech(text: string, maxWords = TIER1_MAX_WORDS): string {
  const words = text.split(/\s+/).filter(Boolean);
  return words.slice(0, maxWords).join(' ');
}

/** Short confirmation for an executed Tier 1 tool call. */
export function tier1Confirmation(name: Tier1ToolName, args: Record<string, unknown>, summary: InspectionSummary): { say: string; speak: boolean } {
  if (name === 'control_tour') {
    const action = (args as any).action;
    if (action === 'next') return { say: 'Next step.', speak: false };
    if (action === 'back') return { say: 'Back one step.', speak: false };
    if (action === 'play') return { say: 'Tour started.', speak: false };
    if (action === 'pause') return { say: 'Tour paused.', speak: true };
    return { say: 'Tour menu.', speak: true };
  }
  if (name === 'update_inspection') {
    const change = (args as any).change;
    if (change?.kind === 'motion') return change.patch.state === 'spin' ? { say: 'Spinning.', speak: true } : { say: 'Stopped.', speak: true };
    if (change?.kind === 'render-quality') {
      return change.patch.level === 'best' ? { say: 'Max quality.', speak: true }
        : change.patch.level === 'fast' ? { say: 'Fast.', speak: true } : { say: 'Balanced.', speak: true };
    }
    const scale = change?.patch?.scale;
    if (typeof scale === 'number' && summary.scale !== undefined) {
      return scale > summary.scale ? { say: 'Bigger.', speak: true } : scale < summary.scale ? { say: 'Smaller.', speak: true } : { say: 'Size set.', speak: true };
    }
    return { say: 'Done.', speak: true };
  }
  if (name === 'focus_selection') return { say: 'Whole structure.', speak: true };
  const parts = (args as any).parts;
  return { say: Array.isArray(parts) && parts.length ? `${String(parts[0]).slice(0, 40)}.` : 'Lit it up.', speak: true };
}

export type BridgeDecision =
  | { route: 'ignored'; reason: 'empty' | 'prefix-missing' }
  | { route: 'page'; rule: 'page-handled' }
  | { route: 'tier0'; decision: Tier0Decision }
  | { route: 'tier1' };

/**
 * Pure routing for one utterance: wake word, then the page's own grammar,
 * then the local table, then the model. The page check comes before Tier 0
 * so an overlap acts once — the page already moved and spoke — and Tier 0
 * stays the path for the page-missed synonyms it was built for.
 */
export function decideUtterance({ raw, proposed, prefix, summary }:
{ raw: string; proposed?: string; prefix?: string; summary: InspectionSummary }): BridgeDecision {
  const decided = decideOneReading(raw, prefix, summary);
  // The Mac's own scene-checked reading, tried only when the raw one
  // resolved to nothing local. The recognizer wrote "Go to resident 141" for
  // "go to residue 141" and every layer lost the sentence
  //; `normalizeSpeechText` corrects it
  // and records the rule, and this is what lets the correction reach a route.
  // Raw first, so no utterance this bridge already understood changes meaning.
  if (decided.route !== 'tier1' || !proposed) return decided;
  const trimmed = proposed.replace(/\s+/gu, ' ').trim();
  if (!trimmed || trimmed === raw.replace(/\s+/gu, ' ').trim()) return decided;
  const corrected = decideOneReading(trimmed, prefix, summary);
  return corrected.route === 'tier1' ? decided : corrected;
}

function decideOneReading(raw: string, prefix: string | undefined, summary: InspectionSummary): BridgeDecision {
  const normalized = normalizeBridgeTranscript(raw);
  if (!normalized) return { route: 'ignored', reason: 'empty' };
  const unprefixed = stripWakePrefix(normalized, prefix);
  if (unprefixed === undefined) return { route: 'ignored', reason: 'prefix-missing' };
  if (pageClaimsAction(raw, summary.lesson?.parts ?? [])) return { route: 'page', rule: 'page-handled' };
  const tier0 = matchTier0(unprefixed, { scale: summary.scale });
  if (tier0) return { route: 'tier0', decision: tier0 };
  return { route: 'tier1' };
}

export function newCommandId(): string {
  return `vb-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

export type BridgeDeps = {
  callAgent?: (state: ControlState, name: string, args?: Record<string, unknown>) => Promise<any>;
  readState?: (state: ControlState) => Promise<any>;
  tier1?: (input: { utterance: string; summary: InspectionSummary; environment?: NodeJS.ProcessEnv }) => Promise<Tier1Result>;
  appendEscalation?: (line: string) => Promise<void>;
  logLine?: (entry: Record<string, unknown>) => void | Promise<void>;
  limiter?: ReturnType<typeof createRateLimiter>;
  environment?: NodeJS.ProcessEnv;
  dryRun?: boolean;
  /** Bound and pace for the rendered-receipt wait; defaults reuse inspection-agent.ts. */
  receiptWait?: { pollMs?: number; timeoutMs?: number };
};

function oneLine(value: string, max = 200): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Read state and fill the session binding for one action tool, waiting out a
 * brief headset blur the way inspection-agent.ts does. Throws when no panel
 * can take the command without guessing.
 */
export async function fillBridgeBinding(state: ControlState, tool: string, partial: Record<string, unknown>,
  readState: (state: ControlState) => Promise<any>): Promise<{ args: Record<string, unknown>; structured: any }> {
  let structured: any;
  let filled: { arguments: Record<string, unknown>; filled: string[]; blurred?: boolean } | undefined;
  for (let attempt = 0; attempt <= BLUR_RETRIES; attempt++) {
    const reading = await readState(state);
    structured = reading?.structuredContent ?? {};
    // The bridge speaks for the wearer too, so a refusal of the
    // request itself reaches the headset rather than only this process's log
    try { filled = fillAgentArguments(tool, partial, structured, newCommandId); }
    catch (error) {
      if (isPreDispatchRefusal(error)) await reportRefusalToHeadset(state, error, partial);
      throw error;
    }
    if (filled.blurred !== true) break;
    if (attempt < BLUR_RETRIES) await new Promise(done => setTimeout(done, BLUR_POLL_MS));
  }
  if (!filled) throw Error('No inspection state could be read.');
  if (filled.blurred === true) throw Error('The headset view is busy; try again in a moment.');
  return { args: filled.arguments, structured };
}

/**
 * Follow one bridge command until its receipt stops being pending.
 *
 * Same channel the rest of the plugin uses: `get_inspection_state` with the
 * commandId (inspection-server.ts), `commandReceiptOf`/`isReceiptPending`
 * (agent-arguments.ts), polled the way inspection-agent.ts `awaitReceipt`
 * and headset-drive.ts `waitForReceipt` do. An `unknown` receipt is not
 * terminal — the host may not have filed it yet — so polling continues.
 * Bounded by the plugin's existing receipt timeouts.
 */
export async function waitForBridgeReceipt(control: ControlState, commandId: string,
  callAgent: (state: ControlState, name: string, args?: Record<string, unknown>) => Promise<any>,
  wait: { pollMs?: number; timeoutMs?: number } = {},
): Promise<{ receipt: { commandId: string; status: string; reason?: string }; timedOut: boolean }> {
  // tabs-and-waits follow-up: the bridge used to poll against its own fixed
  // bound, so a command the host was still rendering inside its stated budget
  // read as timed out here. `awaitReceipt` follows the host's remaining
  // deadline (`budgetMs` on the polled receipt), never shortening the
  // caller's own patience; the bridge now waits exactly as the agent CLI does.
  const { receipt: polled, timedOut } = await awaitReceipt(control, commandId,
    { pollMs: wait.pollMs ?? RECEIPT_POLL_MS, timeoutMs: wait.timeoutMs ?? RECEIPT_WAIT_MS }, callAgent);
  const receipt = { commandId: polled.commandId ?? commandId, status: String(polled.status ?? 'queued'),
    ...(polled.reason ? { reason: polled.reason } : {}) };
  return { receipt, timedOut };
}

/** Best-effort spoken line: a narration miss never masks the receipt outcome. */
async function speakBridgeLine(control: ControlState,
  callAgent: (state: ControlState, name: string, args?: Record<string, unknown>) => Promise<any>,
  text: string, extra: Record<string, unknown> = {}): Promise<void> {
  await callAgent(control, 'say_to_headset', { text, ...extra }).catch(() => {});
}

/** Execute one routed utterance end to end. Returns what was done, for the log. */
export async function handleUtterance({ control, raw, receivedAt, utteranceId, sequence, referent, summary, decision, deps }:
{
  control: ControlState; raw: string; receivedAt?: string; utteranceId?: string; sequence?: number; referent?: unknown; summary: InspectionSummary;
  decision: BridgeDecision; deps: BridgeDeps;
}): Promise<Record<string, unknown>> {
  const started = Date.now();
  const callAgent = deps.callAgent ?? callLocalAgent;
  const logLine = deps.logLine ?? (() => {});
  const appendEscalation = deps.appendEscalation ?? (async () => {});
  const limiter = deps.limiter ?? createRateLimiter();
  const dryRun = deps.dryRun === true;

  const done = async (entry: Record<string, unknown>) => {
    await logLine({ utterance: oneLine(raw, 120), ...(receivedAt ? { receivedAt } : {}), utteranceId, sequence, referent, ...entry, elapsedMs: Date.now() - started });
    return entry;
  };

  if (decision.route === 'ignored') return done({ route: 'ignored', reason: decision.reason });
  if (decision.route === 'page') return done({ route: 'page', rule: decision.rule });

  if (decision.route === 'tier0') {
    const { tool, change, fields, say, speak, rule } = decision.decision;
    if (dryRun) return done({ route: 'tier0', rule, tool, change, say, speak, dryRun: true });
    const limited = limiter.check();
    if (!limited.ok) return done({ route: 'tier0', rule, limited: false, reason: limited.reason });
    try {
      const { args } = await fillBridgeBinding(control, tool, { ...change, ...fields }, deps.readState ?? (async s => callAgent(s, 'get_inspection_state')));
      const posted = await callAgent(control, tool, {...args,...(utteranceId?{utteranceId}:{}),...(referent && ['update_inspection','focus_selection','emphasize'].includes(tool)?{referent}:{}),actionPostedAt:Date.now()});
      const commandId = (posted as any)?.structuredContent?.command?.commandId ?? (args as any).commandId;
      if (typeof commandId !== 'string' || !commandId) throw Error('The action posted without a command id.');
      await speakBridgeLine(control, callAgent, BRIDGE_ACK_TEXT);
      let followed;
      try {
        followed = await waitForBridgeReceipt(control, commandId, callAgent, deps.receiptWait ?? {});
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await speakBridgeLine(control, callAgent, BRIDGE_FAILURE_TEXT);
        await appendEscalation(`${new Date().toISOString()} utterance="${oneLine(raw)}" route=tier0 rule=${rule} error="${oneLine(reason)}"`);
        return done({ route: 'tier0', rule, tool, error: oneLine(reason), say: BRIDGE_FAILURE_TEXT });
      }
      if (!followed.timedOut && followed.receipt.status === 'rendered') {
        await speakBridgeLine(control, callAgent, say, {commandId,...(utteranceId?{utteranceId}:{}),...(speak?{}:{speak:false})});
        return done({ route: 'tier0', rule, tool, change: redactForLog(change), say, speak, receipt: followed.receipt.status });
      }
      const reason = followed.timedOut
        ? `receipt wait timed out (${followed.receipt.status})`
        : `receipt ${followed.receipt.status}${followed.receipt.reason ? `: ${followed.receipt.reason}` : ''}`;
      await speakBridgeLine(control, callAgent, BRIDGE_FAILURE_TEXT);
      await appendEscalation(`${new Date().toISOString()} utterance="${oneLine(raw)}" route=tier0 rule=${rule} error="${oneLine(reason)}"`);
      return done({ route: 'tier0', rule, tool, error: oneLine(reason), say: BRIDGE_FAILURE_TEXT, receipt: followed.receipt.status });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await speakBridgeLine(control, callAgent, BRIDGE_FAILURE_TEXT);
      await appendEscalation(`${new Date().toISOString()} utterance="${oneLine(raw)}" route=tier0 rule=${rule} error="${oneLine(reason)}"`);
      return done({ route: 'tier0', rule, error: oneLine(reason), say: BRIDGE_FAILURE_TEXT });
    }
  }

  // Tier 1.
  const tier1 = deps.tier1 ?? (input => callTier1Model({ ...input, environment: deps.environment }));
  if (dryRun) return done({ route: 'tier1', dryRun: true, prompt: oneLine(tier1SystemPrompt(summary), 300) });
  const result = await tier1({ utterance: oneLine(raw, 240), summary, environment: deps.environment }).catch(
    (error): Tier1Result => ({ kind: 'unavailable', reason: error instanceof Error ? error.message.slice(0, 120) : 'model call failed' }));
  if (result.kind === 'tool') {
    const limited = limiter.check();
    if (!limited.ok) return done({ route: 'tier1', tool: result.name, limited: false, reason: limited.reason });
    try {
      const { args } = await fillBridgeBinding(control, result.name, result.args, deps.readState ?? (async s => callAgent(s, 'get_inspection_state')));
      const posted = await callAgent(control, result.name, {...args,...(utteranceId?{utteranceId}:{}),...(referent && ['update_inspection','focus_selection','emphasize'].includes(result.name)?{referent}:{}),actionPostedAt:Date.now()});
      const commandId = (posted as any)?.structuredContent?.command?.commandId ?? (args as any).commandId;
      if (typeof commandId !== 'string' || !commandId) throw Error('The action posted without a command id.');
      await speakBridgeLine(control, callAgent, BRIDGE_ACK_TEXT);
      const confirmation = tier1Confirmation(result.name, result.args, summary);
      let followed;
      try {
        followed = await waitForBridgeReceipt(control, commandId, callAgent, deps.receiptWait ?? {});
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await speakBridgeLine(control, callAgent, BRIDGE_FAILURE_TEXT);
        await appendEscalation(`${new Date().toISOString()} utterance="${oneLine(raw)}" route=tier1 tool=${result.name} error="${oneLine(reason)}"`);
        return done({ route: 'tier1', tool: result.name, error: oneLine(reason), say: BRIDGE_FAILURE_TEXT });
      }
      if (!followed.timedOut && followed.receipt.status === 'rendered') {
        await speakBridgeLine(control, callAgent, confirmation.say, {commandId,...(utteranceId?{utteranceId}:{}),...(confirmation.speak?{}:{speak:false})});
        return done({ route: 'tier1', tool: result.name, args: redactForLog(result.args), say: confirmation.say, speak: confirmation.speak, receipt: followed.receipt.status });
      }
      const reason = followed.timedOut
        ? `receipt wait timed out (${followed.receipt.status})`
        : `receipt ${followed.receipt.status}${followed.receipt.reason ? `: ${followed.receipt.reason}` : ''}`;
      await speakBridgeLine(control, callAgent, BRIDGE_FAILURE_TEXT);
      await appendEscalation(`${new Date().toISOString()} utterance="${oneLine(raw)}" route=tier1 tool=${result.name} error="${oneLine(reason)}"`);
      return done({ route: 'tier1', tool: result.name, error: oneLine(reason), say: BRIDGE_FAILURE_TEXT, receipt: followed.receipt.status });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await speakBridgeLine(control, callAgent, BRIDGE_FAILURE_TEXT);
      await appendEscalation(`${new Date().toISOString()} utterance="${oneLine(raw)}" route=tier1 tool=${result.name} error="${oneLine(reason)}"`);
      return done({ route: 'tier1', tool: result.name, error: oneLine(reason), say: BRIDGE_FAILURE_TEXT });
    }
  }
  if (result.kind === 'speak') {
    const spoken = shortenForSpeech(result.text);
    await callAgent(control, 'say_to_headset', { text: spoken }).catch(() => { /* The escalation below matters more. */ });
    await appendEscalation(`${new Date().toISOString()} utterance="${oneLine(raw)}" route=tier1 answer="${oneLine(result.text)}"`);
    return done({ route: 'tier1', spoken, escalated: true });
  }
  // Unavailable or refused: say something short, escalate the rest.
  const fallback = result.kind === 'unavailable' && /not set/.test(result.reason) ? 'No model configured.' : 'Can’t do that.';
  await callAgent(control, 'say_to_headset', { text: fallback }).catch(() => {});
  await appendEscalation(`${new Date().toISOString()} utterance="${oneLine(raw)}" route=tier1 ${result.kind}="${oneLine(result.reason)}"`);
  return done({ route: 'tier1', [result.kind]: oneLine(result.reason), say: fallback, escalated: true });
}

/** Follow the transcript queue the way listen-voice.ts does, acting per utterance. */
export async function main(argv: string[], environment: NodeJS.ProcessEnv = process.env) {
  const options = parseBridgeArgs(argv);
  if (options.help === true) {
    console.log(BRIDGE_USAGE);
    return;
  }
  if (options.say !== undefined) {
    printSayDecision(options.say, options.requirePrefix);
    return;
  }
  const logPath = options.logPath || DEFAULT_BRIDGE_LOG_PATH;
  const escalationsPath = options.escalationsPath || DEFAULT_ESCALATIONS_PATH;
  const limiter = createRateLimiter();

  const appendTo = async (path: string, line: string) => {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${line}\n`, { mode: 0o600 });
  };
  const logLine = async (entry: Record<string, unknown>) => {
    // redactForLog types as unknown, so guard the spread: only an object
    // merges into the log line, anything else nests under value.
    const redacted = redactForLog(entry);
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      ...(typeof redacted === 'object' && redacted !== null ? redacted : { value: redacted }),
    });
    if (options.dryRun) console.log(line);
    else await appendTo(logPath, line).catch(error => console.error(`voice bridge: cannot write ${logPath}: ${String(error)}`));
  };
  const appendEscalation = async (line: string) => {
    if (options.dryRun) { console.log(`ESCALATE ${line}`); return; }
    await appendTo(escalationsPath, line).catch(error => console.error(`voice bridge: cannot write ${escalationsPath}: ${String(error)}`));
  };

  const consumer = createVoiceTranscriptConsumer(options.replay === true);
  let backoff = RETRY_MIN_MS;
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { stopping = true; process.exit(0); });

  if (!options.dryRun) {
    console.error(`Voice bridge listening through ${options.statePath}. Decisions append to ${logPath}; escalations to ${escalationsPath}.`);
  } else {
    console.error(`Voice bridge dry run through ${options.statePath}: decisions print, nothing is called.`);
  }

  while (!stopping) {
    let entries;
    let polledControl: ControlState;
    try {
      polledControl = await readControlState(options.statePath);
      entries = await consumer.poll(polledControl);
      backoff = RETRY_MIN_MS;
    } catch (error) {
      console.error(`voice bridge: ${error instanceof Error ? error.message : String(error)} Retrying in ${Math.round(backoff / 1_000)} s.`);
      await new Promise(done => setTimeout(done, backoff));
      backoff = Math.min(backoff * 2, RETRY_MAX_MS);
      continue;
    }
    for (const entry of entries) {
      const raw = String(entry.text ?? '').replace(/\s+/g, ' ').trim();
      if (!raw) continue;
      try {
        const control = await readControlState(options.statePath);
        if (!sameVoiceSession(polledControl, control)) break;
        // Fresh binding inputs for this utterance: scale for Tier 0, lesson
        // parts for the page guard and the Tier 1 summary.
        const reading = await callLocalAgent(control, 'get_inspection_state');
        const structured = reading?.structuredContent ?? {};
        const summary = summarizeInspectionState(structured);
        const proposed = typeof (entry as { normalizedText?: unknown }).normalizedText === 'string'
          ? (entry as { normalizedText: string }).normalizedText : undefined;
        const decision = decideUtterance({ raw, ...(proposed ? { proposed } : {}), prefix: options.requirePrefix, summary });
        if (options.dryRun) {
          await logLine({ utterance: raw, receivedAt: entry.receivedAt, utteranceId: entry.utteranceId, sequence: entry.sequence, referent: entry.referent, decision: redactForLog(decision), dryRun: true });
          continue;
        }
        await handleUtterance({
          control, raw, receivedAt: entry.receivedAt, utteranceId: entry.utteranceId, sequence: entry.sequence, referent: entry.referent, summary, decision,
          deps: { limiter, environment, appendEscalation, logLine },
        });
      } catch (error) {
        await logLine({ utterance: raw, receivedAt: entry.receivedAt, utteranceId: entry.utteranceId, sequence: entry.sequence, referent: entry.referent, route: 'error', error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (options.once && !consumer.lastPollWasSnapshot) return;
  }
}

const invokedAsScript = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) {
  try { await main(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
