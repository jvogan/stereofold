/**
 * Headset microphone -> local text. Version 2 of push-to-talk.
 *
 * Version 1 sent only a grip edge and ran a shell command the user had
 * exported, which meant the wearer had to be within earshot of the Mac's own
 * microphone and that the command usually synthesized a keystroke. This module
 * takes the audio itself: the companion posts one-second Opus chunks through
 * the authenticated `/tool` route, they are assembled here, decoded by ffmpeg,
 * transcribed by whisper-cpp on this machine, and published as text.
 *
 * Properties that hold by construction:
 *
 * - No audio leaves the Mac. `whisper-cli` is a local process with a local
 *   model file; nothing in this module opens a socket.
 * - Nothing here synthesizes a keystroke, a pointer event, or any other input.
 *   Text is appended to a file, written into the headset bridge, piped to a
 *   command's stdin, and returned to the headset. All four are optional and
 *   independent, and a failure in one never stops the others.
 * - Chunks land in a 0700 directory under the OS temp root and are deleted as
 *   soon as the transcript exists, whether or not transcription succeeded.
 * - Every bound is explicit: bytes per chunk, bytes per utterance, chunks per
 *   utterance, live utterances, utterance lifetime, and a per-session rate.
 */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants } from 'node:fs';
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
// The shape of what the wearer meant by "this" when they pressed.
// Type-only, so nothing of the contract's runtime reaches this module.
import type { RequestReferent } from './inspection-contract.js';
import { writeBridgeVoice } from './headset-bridge.js';
import { sessionIdSchema } from './schemas.js';
import { buildSpeechVocabulary, isSpeechVocabularyEcho, normalizeSpeechText, WHISPER_DOMAIN_HINT, type SpeechSceneContext, type SpeechNormalizationRule } from './speech-vocabulary.js';

export const PUSH_TO_TALK_AUDIO_TOOL = 'push_to_talk_audio';
export const PUSH_TO_TALK_TRANSCRIBE_ENV = 'STEREOFOLD_PTT_TRANSCRIBE';
export const WHISPER_BIN_ENV = 'STEREOFOLD_WHISPER_BIN';
export const WHISPER_MODEL_ENV = 'STEREOFOLD_WHISPER_MODEL';
/**
 * `1` runs whisper on the GPU. The default is the CPU: under heavy Metal load
 * on this host, whisper's GPU path set off a kernel panic in the GPU driver.
 */
export const WHISPER_GPU_ENV = 'STEREOFOLD_WHISPER_GPU';
export const FFMPEG_BIN_ENV = 'STEREOFOLD_FFMPEG_BIN';
/** `whisper` (the default) or `apple`. See `transcriberKind`. */
export const TRANSCRIBER_ENV = 'STEREOFOLD_PTT_TRANSCRIBER';
export const APPLESPEECH_BIN_ENV = 'STEREOFOLD_APPLESPEECH_BIN';
export const TRANSCRIPT_LOG_ENV = 'STEREOFOLD_PTT_TRANSCRIPTS';
export const TEXT_COMMAND_ENV = 'STEREOFOLD_PTT_TEXT_COMMAND';
/** An absolute headset-bridge directory. Set only when a bridge harness is running. */
export const BRIDGE_DIR_ENV = 'STEREOFOLD_BRIDGE_DIR';

/** Base64 costs a third more than the bytes it carries; this stays far under the 2 MiB body cap. */
export const PTT_MAX_CHUNK_BASE64 = 320 * 1024;
export const PTT_MAX_UTTERANCE_BYTES = 8 * 1024 * 1024;
export const PTT_MAX_CHUNKS = 4_096;
/** Sixty seconds of speech, plus the slack a one-second timeslice can add. */
export const PTT_MAX_DURATION_MS = 66_000;
export const PTT_MAX_ACTIVE_UTTERANCES = 4;
/** An utterance whose final marker never arrives is swept rather than kept. */
export const PTT_UTTERANCE_IDLE_MS = 120_000;
/** Per-session rate limit: enough for four full-length utterances a minute. */
export const PTT_RATE_WINDOW_MS = 60_000;
export const PTT_MAX_CHUNKS_PER_WINDOW = 320;
export const PTT_MAX_UTTERANCES_PER_WINDOW = 12;
/** whisper-cpp on a 60 s clip with small.en is seconds, not minutes. */
export const PTT_TRANSCRIBE_TIMEOUT_MS = 120_000;
export const PTT_DECODE_TIMEOUT_MS = 30_000;
export const PTT_TEXT_COMMAND_TIMEOUT_MS = 10_000;
export const PTT_MAX_TRANSCRIPT_CHARS = 2_000;
/** How many transcripts the agent long-poll can fall behind before losing the oldest. */
export const PTT_TRANSCRIPT_HISTORY = 64;
export const PTT_POLL_MAX_WAIT_MS = 18_000;
export const PTT_POLL_DEFAULT_WAIT_MS = 15_000;

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const SHELL = '/bin/sh';
const WHISPER_SAMPLE_RATE = 16_000;
/**
 * Legacy prompt, retained for diagnostics and echo tests only. The live Whisper
 * route must not use it: a complete audible "pause the animation" clip
 * returned the live vocabulary's tail instead. Apple's contextual hints are a
 * separate recognizer API and still use the bounded phrase list.
 */
export const WHISPER_INITIAL_PROMPT = buildSpeechVocabulary().whisperPrompt;

export const DEFAULT_WHISPER_BINS = Object.freeze([
  '/opt/homebrew/bin/whisper-cli', '/usr/local/bin/whisper-cli', '/usr/bin/whisper-cli',
]);
export const DEFAULT_FFMPEG_BINS = Object.freeze([
  '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg',
]);

/**
 * Where a packaged `applespeech` sits, relative to whatever copy of this
 * package is running.
 *
 * One expression covers every layout because the module is always two levels
 * inside the package: `plugin/src/push-to-talk-transcribe.ts` under tsx,
 * `plugin/dist/server.mjs` once bundled, and
 * `release/stereofold/dist/server.mjs` for a Codex user running the staged
 * artifact. The staged copy is named as well, so a host started from the
 * checkout still finds a binary that was only ever built into the release.
 */
export function packagedApplespeechBins(moduleUrl = import.meta.url): readonly string[] {
  const packageRoot = resolve(fileURLToPath(new URL('..', moduleUrl)));
  return [
    join(packageRoot, 'native/applespeech/bin/applespeech'),
    join(packageRoot, 'release/stereofold/native/applespeech/bin/applespeech'),
  ];
}

/**
 * Apple's on-device recognizer, and on a Mac that has one the default route.
 *
 * A Mac needs no whisper install: the Speech framework recognizes
 * on-device, so there is no Homebrew formula and no 466 MB model file.
 * `applespeech` is the small Swift wrapper that exposes it as a command,
 * because the framework has no first-party CLI. Over 60 synthesized clips of
 * the real grammar it resolved 60 commands to whisper small.en's
 * 56, at a 535 ms median against 630 ms.
 *
 * The build output comes before the Homebrew paths because a user who ran
 * `pnpm run build:applespeech` meant that binary, and because the packaged one
 * is the copy this feature was measured against.
 *
 * It is still not unconditional. This route depends on a macOS privacy grant
 * that whisper does not need: the first run raises a Speech Recognition dialog
 * for whichever app started the host, and a launchd daemon with no GUI session
 * can never show one. So the route is chosen only when a binary is actually
 * present, and a clip that fails on it falls back to whisper. See
 * `transcriberKind`.
 */
export const DEFAULT_APPLESPEECH_BINS = Object.freeze([
  ...packagedApplespeechBins(),
  '/opt/homebrew/bin/applespeech', '/usr/local/bin/applespeech',
]);

/**
 * What a transcript records as its model on the Apple route.
 *
 * Whisper records the model file's path, because which of several `.bin` files
 * transcribed the speech is a real question. Apple exposes no such handle: the
 * recognizer is one system model, versioned with macOS, so the honest value is
 * a name rather than a path.
 */
export const APPLESPEECH_MODEL_NAME = 'apple-speech-on-device';

/**
 * The phrases handed to the recognizer as `contextualStrings`.
 *
 * This is Apple's counterpart to `WHISPER_INITIAL_PROMPT` and it is not
 * optional decoration. Over a 60-clip synthesized corpus,
 * dropping it took exact transcripts from 58/60 to 42/60, and the losses were
 * the words this product is made of: `show cas9` became `Show cast nine`,
 * `assemble a microtubule` became `Assemble a microphone`, and `start the tour`
 * became `Stop the tour`, which is the same command inverted.
 *
 * Unlike whisper's prompt this is a phrase list, not a sentence the model
 * continues. Commands now share it with molecular terms and per-press scene
 * vocabulary; only the original fixed hints were measured in that corpus.
 */
export const APPLESPEECH_HINTS = Object.freeze(buildSpeechVocabulary().phrases);

/**
 * What each `applespeech` exit code means, in words a fallback line can carry.
 *
 * `3` is the one that shaped this design. macOS asks for Speech Recognition
 * consent once, on behalf of the application that launched the host, and until
 * somebody clicks Allow in Terminal or Claude Code every request is refused.
 * A wearer mid-session cannot click it and would otherwise lose every press
 * until they took the headset off, so the clip goes to whisper instead.
 */
export const APPLESPEECH_EXIT_REASONS: Readonly<Record<number, string>> = Object.freeze({
  2: 'applespeech rejected its arguments',
  3: 'macOS has not granted Speech Recognition to the app that launched this host',
  4: 'this Mac has no on-device speech model for that locale',
  5: 'applespeech could not decode the recording',
  6: 'the recognizer failed',
});

export function applespeechBinCandidates(environment: NodeJS.ProcessEnv = process.env): readonly string[] {
  return [...new Set([...DEFAULT_APPLESPEECH_BINS, ...onPath('applespeech', environment)])];
}

export type TranscriberKind = 'whisper' | 'apple';

export type TranscriberSelection = { platform?: NodeJS.Platform; exists?: (path: string) => boolean };

/**
 * Which recognizer this host uses.
 *
 * `STEREOFOLD_PTT_TRANSCRIBER` decides when it is set: `apple` forces Apple's
 * recognizer, any other value forces whisper, so a typo lands on the route
 * that needs no privacy grant rather than silently on the one that does.
 *
 * Unset is the case a new user is in, and there the answer is Apple on a Mac
 * that has the binary and whisper everywhere else. Both halves of that
 * condition matter. Off macOS the Speech framework does not exist at all. On
 * macOS without a built binary there is nothing to run, and answering `apple`
 * would turn a host that transcribes perfectly well with whisper into one that
 * reports a missing tool.
 *
 * Choosing Apple is not a commitment to it: a clip the recognizer cannot
 * handle, including the denied-permission case a wearer cannot fix from inside
 * the headset, is transcribed with whisper instead.
 */
export function transcriberKind(environment: NodeJS.ProcessEnv = process.env,
  { platform = process.platform, exists }: TranscriberSelection = {}): TranscriberKind {
  const setting = environment[TRANSCRIBER_ENV]?.trim().toLowerCase();
  if (setting) return setting === 'apple' ? 'apple' : 'whisper';
  if (platform !== 'darwin') return 'whisper';
  return resolvePath(environment[APPLESPEECH_BIN_ENV], applespeechBinCandidates(environment), exists ?? existsExecutable)
    ? 'apple' : 'whisper';
}

/**
 * One line of speech from `applespeech` stdout.
 *
 * The tool already prints exactly one transcript line and sends every
 * diagnostic to stderr, so this only has to normalize. It reuses the whisper
 * silence filter deliberately: none of those fillers is a command in the
 * headset grammar, so nothing actionable can be lost, and the caption reading
 * `Heard: you` is the failure the wearer complained about whichever recognizer
 * produced it.
 */
export function parseAppleSpeechText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const text = raw.normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (isWhisperSilence(text)) return '';
  return text.length > PTT_MAX_TRANSCRIPT_CHARS ? text.slice(0, PTT_MAX_TRANSCRIPT_CHARS).trim() : text;
}

/**
 * The documented paths first, then whatever PATH names.
 *
 * The documented ones come first because a daemon starts with no PATH at all
 * (the Claude Science host is the case that matters), and because they are the
 * installs this feature was measured against. PATH is the fallback for a Mac
 * that keeps its tools somewhere else, which is the only way a terminal user
 * with a working `whisper-cli` would otherwise be told it is missing.
 */
function onPath(name: string, environment: NodeJS.ProcessEnv): string[] {
  return (environment.PATH ?? '').split(delimiter).filter(entry => isAbsolute(entry)).map(entry => join(entry, name));
}
export function whisperBinCandidates(environment: NodeJS.ProcessEnv = process.env): readonly string[] {
  return [...new Set([...DEFAULT_WHISPER_BINS, ...onPath('whisper-cli', environment)])];
}
export function ffmpegBinCandidates(environment: NodeJS.ProcessEnv = process.env): readonly string[] {
  return [...new Set([...DEFAULT_FFMPEG_BINS, ...onPath('ffmpeg', environment)])];
}
/** The conventional whisper.cpp cache; other locations use STEREOFOLD_WHISPER_MODEL. */
export function defaultWhisperModels(home = homedir()): readonly string[] {
  return Object.freeze([
    join(home, '.cache/whisper-cpp/ggml-base.en.bin'),
  ]);
}

/**
 * One chunk of one utterance. `data` is absent only on a bare final marker,
 * which is how the headset closes an utterance whose audio is already sent.
 */
/**
 * The file extension to write a recording under, from the type the headset
 * declared.
 *
 * Every recording used to be saved as `.webm` whatever it was. ffmpeg usually
 * recovers from a wrong extension by probing the bytes, but it does not have
 * to, and Quest Browser is not the only browser that will ever reach this
 * host: Safari records MP4, and a Chromium build without the WebM muxer falls
 * back to Ogg. Naming the file for what it is costs nothing and removes the
 * guess. An unknown type keeps WebM, which is what Quest sends.
 */
export function containerExtension(mime: string): string {
  switch ((mime ?? '').split(';')[0].trim().toLowerCase()) {
    case 'audio/mp4': case 'audio/aac': case 'audio/x-m4a': case 'audio/mp4a-latm': return 'mp4';
    case 'audio/ogg': case 'audio/opus': case 'audio/x-ogg': return 'ogg';
    case 'audio/mpeg': case 'audio/mp3': return 'mp3';
    case 'audio/wav': case 'audio/wave': case 'audio/x-wav': return 'wav';
    case 'audio/flac': case 'audio/x-flac': return 'flac';
    default: return 'webm';
  }
}

export const pushToTalkAudioSchema = z.object({
  sessionId: sessionIdSchema,
  panelId: z.string().uuid().optional(),
  utteranceId: z.string().uuid(),
  seq: z.number().int().min(0).max(PTT_MAX_CHUNKS - 1),
  // A recorder may report its type with spaces after the separators
  // (`audio/webm; codecs=opus`). Rejecting that shape would refuse a headset
  // whose recording is otherwise perfectly decodable here.
  mime: z.string().min(5).max(80).regex(/^audio\/[a-z0-9.+-]+(?:\s*;\s*[a-z0-9]+=[a-z0-9.+-]+)*$/i, 'Expected an audio MIME type.'),
  data: z.string().min(4).max(PTT_MAX_CHUNK_BASE64).regex(/^[A-Za-z0-9+/]*={0,2}$/, 'Expected base64.').optional(),
  final: z.boolean(),
  pageDecision: z.object({ token: z.string().uuid(), handled: z.boolean() }).strict().optional(),
}).strict();
export type PushToTalkAudioInput = z.output<typeof pushToTalkAudioSchema>;

/**
 * The desktop agent's long poll. `after` is the cursor from the previous
 * answer, so a listener that restarts mid-session resumes where it stopped
 * rather than replaying everything the wearer has ever said.
 */
export const pollVoiceTranscriptsSchema = z.object({
  sessionId: sessionIdSchema,
  after: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  waitMs: z.number().int().min(0).max(PTT_POLL_MAX_WAIT_MS).optional(),
}).strict();
export type PollVoiceTranscriptsInput = z.output<typeof pollVoiceTranscriptsSchema>;

/** How long `listen_voice` waits for the wearer when the caller names no window. */
export const LISTEN_VOICE_DEFAULT_SECONDS = 20;
export const LISTEN_VOICE_MAX_SECONDS = 25;

/**
 * The desktop agent's own long poll, and the only voice route a model sees.
 *
 * It carries no session: the wearer speaks into a headset, not into one
 * inspection, and an agent that has not yet opened a panel still has to be
 * able to listen. `cursor` is the value the previous answer returned, so a
 * conversation never replays an utterance it already acted on. `epoch` names
 * the queue that cursor counts in: a restarted server counts from zero again.
 */
export const listenVoiceSchema = z.object({
  timeoutSeconds: z.number().int().min(1).max(LISTEN_VOICE_MAX_SECONDS).optional(),
  cursor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  epoch: z.string().uuid().optional()
    .describe('The epoch from the previous answer. A different epoch means the voice queue restarted, so the answer starts from the oldest utterance it holds.'),
}).strict();
export type ListenVoiceInput = z.output<typeof listenVoiceSchema>;

export type TranscriptRecord = {
  sessionId?: string;
  panelId?: string;
  utteranceId: string;
  text: string;
  /** Scene-checked proposal; raw recognizer text above is never replaced. */
  normalizedText?: string;
  normalizationRules?: SpeechNormalizationRule[];
  durationMs: number;
  receivedAt: string;
  /**
   * When these words existed, as Unix milliseconds.
   *
   * `receivedAt` is stamped the moment the last audio chunk lands, before
   * ffmpeg runs and before any recognizer is spawned, so everything the
   * recognizer spends sits between the two stamps. Read on its own,
   * `receivedAt` made recognition look like delivery: the timing table
   * called a 334 ms upload "recognition" and hid the recognizer's whole run
   * inside "delivery". Differencing the two stamps separates them.
   *
   * Taken immediately before the deliveries fan out, so it marks the words
   * existing and not the log append, the bridge write or the text command.
   * Unix milliseconds rather than an instant string, because every reader of
   * it subtracts it from another millisecond stamp.
   */
  transcribedAt?: number;
  /**
   * How long recognition itself took, in milliseconds: from the first
   * recognizer process starting to its text being accepted. A press the energy
   * gate answered without spawning a recognizer reports 0. A press that fell
   * back from Apple to whisper reports both attempts, because both are time
   * the wearer waited.
   */
  recognizerMs?: number;
  model: string;
  /**
   * Why this one clip was transcribed by whisper on a host whose route is
   * Apple's recognizer. Absent on every clip that went the way it was meant to.
   *
   * It is on the record rather than only in the log because the failure that
   * matters is invisible from inside the headset: an undismissed Speech
   * Recognition dialog makes every press fall back, the wearer hears correct
   * answers throughout, and nothing says the Mac is one click from being twice
   * as fast. Whoever reads the transcripts should be able to see it.
   */
  transcriberFallback?: string;
  /**
   * Where the wearer was when this press BEGAN.
   *
   * A press takes a second or two to finish, the transcription another, and a
   * model's answer several more. By the time anyone acts on these words the
   * selection may have moved on, so "this part" read at that point names
   * whatever is under the pointer now. The referent is taken when the
   * utterance opens and travels with the words, and the tools that resolve
   * "this" and "that" take it back unchanged.
   */
  referent?: RequestReferent;
  /**
   * The headset page's own grammar acts on these words, so the page does it
   * and no assistant is handed them. Absent on everything else.
   */
  headsetAction?: true;
  /** Opaque offer answered only by the recording page before local execution. */
  pageDecision?: string;
};

export type PushToTalkAudioOutcome = {
  utteranceId: string;
  seq: number;
  accepted: boolean;
  final: boolean;
  reason: 'chunk' | 'transcribed' | 'disabled' | 'rate_limited' | 'too_large' | 'too_many' | 'duplicate' | 'unknown_utterance' | 'gap' | 'failed';
  message: string;
  transcript?: TranscriptRecord;
};

type Spawn = (command: string, args: readonly string[], options: {
  shell: false; stdio: ['ignore' | 'pipe', 'pipe', 'pipe']; windowsHide: true; env?: NodeJS.ProcessEnv;
}) => ChildProcess;

export type PushToTalkTranscribeOptions = {
  enabled?: boolean;
  whisperBin?: string;
  whisperModel?: string;
  ffmpegBin?: string;
  /** Left unset, `transcriberKind` picks it from the platform and what is installed. */
  transcriber?: TranscriberKind;
  /** Test seam for that choice; the real host reads `process.platform`. */
  platform?: NodeJS.Platform;
  applespeechBin?: string;
  /** Loudest-window RMS below which a press is silence. `0` disables the gate. */
  silenceRms?: number;
  transcriptLog?: string;
  textCommand?: string;
  bridge?: { voice: (record: TranscriptRecord) => Promise<unknown> | unknown } | undefined;
  /** Extra fan-out targets; each is called with the finished record and may fail independently. */
  deliver?: readonly ((record: TranscriptRecord) => Promise<unknown> | unknown)[];
  spawn?: Spawn;
  log?: (line: string) => void;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  /** Test seam: a directory to assemble in instead of one made under `os.tmpdir()`. */
  temporaryRoot?: string;
  exists?: (path: string) => boolean;
};

type Utterance = {
  sessionId: string;
  panelId?: string;
  mime: string;
  directory?: string;
  chunks: Map<number, Buffer>;
  bytes: number;
  startedAt: number;
  lastAt: number;
  /** Copied on the first chunk, shared by recognition and normalization. */
  speechScene?: SpeechSceneContext | Promise<SpeechSceneContext>;
  finalSeq?: number;
  finishing?: Promise<PushToTalkAudioOutcome>;
  /** Read once, when this utterance opened. */
  referent?: RequestReferent;
};

type RateWindow = { startedAt: number; chunks: number; utterances: number };

function existsExecutable(path: string): boolean {
  try { accessSync(path, constants.X_OK); return true; } catch { return false; }
}

function existsReadable(path: string): boolean {
  try { accessSync(path, constants.R_OK); return true; } catch { return false; }
}

/** An explicit setting wins even when it is missing, so a typo is reported, not silently replaced. */
function resolvePath(explicit: string | undefined, candidates: readonly string[], exists: (path: string) => boolean): string | undefined {
  if (explicit !== undefined && explicit !== '') {
    if (!isAbsolute(explicit)) throw Error('A push-to-talk tool path must be absolute.');
    return explicit;
  }
  return candidates.find(candidate => exists(candidate));
}

/**
 * What whisper says when it was given no speech.
 *
 * These are not transcription errors, they are the model's priors leaking on
 * near-silent audio: a short press with only a breath in it comes back as
 * `you`, `Thank you.` or `Thanks for watching!` with nothing spoken anywhere
 * in the clip. The 11:08 Quest 2 pass is exactly this case, and it was the
 * whole of what the wearer saw: a caption reading `Heard: you`.
 *
 * Only a transcript that is nothing but one of these is dropped. A real
 * sentence containing "thank you" is untouched, and none of these is a command
 * in the headset grammar, so nothing the wearer can act on is lost.
 */
export const WHISPER_SILENCE_TRANSCRIPTS: ReadonlySet<string> = new Set([
  'you', 'thank you', 'thanks', 'thank you very much', 'thank you so much',
  'thanks for watching', 'thank you for watching', 'please subscribe',
  'bye', 'bye bye', 'goodbye', 'okay', 'ok', 'oh', 'um', 'uh', 'hmm', 'mm', 'mhm',
  'so', 'and', 'the', 'a', 'i', 'yeah', 'yep', 'huh', 'ah', 'eh',
]);

/**
 * Compare on words alone, so `You.` and `you` are the same non-answer.
 *
 * Whisper repeats itself on silence as readily as it invents one filler:
 * `Thank you. Thank you.` and `Bye. Bye.` are the same prior spoken twice, and
 * the exact-match set alone let them through to the wearer's caption. A
 * transcript made of nothing but these words is silence however many times they
 * repeat. Every headset command has at least one word outside this set, so no
 * command can be silenced by the rule: `next`, `back`, `up`, `stop`, `bigger`,
 * `play` and the rest are all absent from it.
 */
export function isWhisperSilence(text: string): boolean {
  const key = text.toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!key.length) return false;
  if (WHISPER_SILENCE_TRANSCRIPTS.has(key)) return true;
  const words = key.split(' ');
  if (words.length < 2) return false;
  if (words.every(word => WHISPER_SILENCE_TRANSCRIPTS.has(word))) return true;
  // `Thank you. Thank you.` is one filler said twice. Fold any whole-phrase
  // repetition back to the phrase before deciding.
  for (let size = 1; size < words.length; size++) {
    if (words.length % size) continue;
    const first = words.slice(0, size).join(' ');
    if (!WHISPER_SILENCE_TRANSCRIPTS.has(first)) continue;
    let repeated = true;
    for (let start = size; start < words.length && repeated; start += size) {
      if (words.slice(start, start + size).join(' ') !== first) repeated = false;
    }
    if (repeated) return true;
  }
  return false;
}

/**
 * Turn whisper-cpp output into one line of speech.
 *
 * `-nt` already suppresses timestamps, but a whisper build that ignores it, or
 * a `.txt` file written by an older version, still carries them, so the
 * bracket form is stripped here rather than trusted away. The non-speech
 * markers whisper emits for silence are dropped outright: an empty string is
 * an honest "nothing was said", and a literal `[BLANK_AUDIO]` is not. The
 * filler transcripts in `WHISPER_SILENCE_TRANSCRIPTS` are dropped for exactly
 * the same reason.
 */
export function parseWhisperText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const lines = raw.split(/\r?\n/).map(line => line
    .replace(/^\s*\[\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[.,]\d{3}\]\s*/, '')
    // A non-speech marker in front of a command used to break the command:
    // `[LAUGHTER] next` reached the headset as `laughter next`, which is not a
    // phrase, so the tour did not advance. Strip the marker and keep the word.
    .replace(/\[(?:BLANK_AUDIO|SOUND|MUSIC|NOISE|SILENCE|APPLAUSE|LAUGHTER|LAUGHS|COUGH|COUGHING|SIGH|SNIFF|BREATH|BREATHING|CLICK|CLICKING|GIGGLES|_[A-Z]+_)\]/gi, '')
    .replace(/\*(?:applause|laughter|laughs|giggles|cough|coughing|sigh|sniff|breath|breathing)\*/gi, '')
    // Whisper writes a run of musical notes, not a bracketed marker, when it
    // decides a clip is music. A breath-only press came back as
    // `♪♪` and reached the caption as `Heard: ♪♪`. It is the same claim as
    // `[MUSIC]` in a different notation.
    .replace(/[♪♫♬♩\u{1d160}-\u{1d165}]+/gu, '')
    .replace(/^\s*\((?:blank audio|silence|music|inaudible)\)\s*$/i, ''));
  const text = lines.join(' ').normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (isWhisperSilence(text)) return '';
  return text.length > PTT_MAX_TRANSCRIPT_CHARS ? text.slice(0, PTT_MAX_TRANSCRIPT_CHARS).trim() : text;
}

/**
 * The energy gate that stops a silent press from inventing a command.
 *
 * Whisper decodes its initial prompt as if it had just heard it, so on a clip
 * with no speech in it the likeliest continuation of the prompt is more of the
 * prompt. Measured with small.en and the shipped
 * `WHISPER_INITIAL_PROMPT`, three seconds of pink room noise came back as
 * `Start the tour.`, which resolves to `tour-play` and starts a tour nobody
 * asked for. Apple's recognizer is far better behaved but not clean either: it
 * answers three seconds of digital silence with `No`, reproducibly.
 *
 * Reordering the prompt does not fix this and the obvious reordering makes it
 * worse; see the comment on `WHISPER_INITIAL_PROMPT`. The fix has to be
 * upstream of the recognizer, which is what this is.
 *
 * `STEREOFOLD_PTT_SILENCE_RMS` overrides the threshold; the live route keeps
 * the default for `0` so a command cannot bypass the gate. It is tunable
 * because it was set on synthesized speech, not on a Quest 2
 * microphone in a real room.
 */
export const SILENCE_RMS_ENV = 'STEREOFOLD_PTT_SILENCE_RMS';
/**
 * Loudest 100 ms window, 0..1, below which a recording counts as silence.
 *
 * Measured separation on the corpus: the quietest of 60 spoken
 * clips peaked at 0.135, and the loudest non-speech clip (a breath) at 0.0069.
 * The hard case is one short word inside a long press by a wearer well off the
 * microphone, synthesized at 20 dB down: that peaks at 0.0222 while its
 * whole-clip RMS is only 0.0039. This threshold is the geometric midpoint of
 * 0.0069 and 0.0222, so it clears the loudest noise and the quietest word by
 * the same factor of about 1.85.
 */
export const PTT_SILENCE_RMS = 0.012;
/**
 * Why a window and not the whole clip: a wearer who holds the grip for six
 * seconds and says one word in the middle has a whole-clip RMS near the noise
 * floor. Averaging over the press would discard that word. The loudest window
 * asks the question that matters, which is whether anything was ever said.
 */
export const PTT_SILENCE_WINDOW_MS = 100;

/** The sample rate and 16-bit frames of a RIFF/WAVE file, or undefined if it is not one we wrote. */
export function readPcm16Wav(buffer: Buffer): { sampleRate: number; samples: Int16Array } | undefined {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') return undefined;
  let sampleRate = 0, bitsPerSample = 0, offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ' && body + 16 <= buffer.length) {
      if (buffer.readUInt16LE(body) !== 1) return undefined; // Not linear PCM.
      sampleRate = buffer.readUInt32LE(body + 4);
      bitsPerSample = buffer.readUInt16LE(body + 14);
    } else if (id === 'data') {
      if (bitsPerSample !== 16 || !sampleRate) return undefined;
      // A `data` size of 0 or one that overruns the file is what a truncated
      // decode leaves behind; trust the file length over the header.
      const end = Math.min(buffer.length, size > 0 ? body + size : buffer.length);
      const count = Math.max(0, (end - body) >> 1);
      const samples = new Int16Array(count);
      for (let index = 0; index < count; index++) samples[index] = buffer.readInt16LE(body + index * 2);
      return { sampleRate, samples };
    }
    // Chunks are word-aligned, so an odd size is followed by one pad byte.
    offset = body + size + (size % 2);
  }
  return undefined;
}

/** The loudest `windowMs` window as RMS in 0..1. Zero for an empty recording. */
export function loudestWindowRms(samples: Int16Array, sampleRate: number, windowMs = PTT_SILENCE_WINDOW_MS): number {
  if (!samples.length || sampleRate <= 0) return 0;
  const size = Math.max(1, Math.round((sampleRate * windowMs) / 1000));
  let loudest = 0;
  for (let start = 0; start < samples.length; start += size) {
    const end = Math.min(samples.length, start + size);
    // A trailing sliver is too short to measure honestly; the windows before it
    // already covered the press.
    if (end - start < size && start > 0) break;
    let sum = 0;
    for (let index = start; index < end; index++) sum += samples[index]! * samples[index]!;
    const rms = Math.sqrt(sum / (end - start)) / 32_768;
    if (rms > loudest) loudest = rms;
  }
  return loudest;
}

/** Whether a decoded recording is quiet enough that no recognizer should see it. */
export function isSilentRecording(wav: Buffer, threshold = PTT_SILENCE_RMS): { silent: boolean; rms: number } {
  if (!(threshold > 0)) return { silent: false, rms: Number.NaN };
  const decoded = readPcm16Wav(wav);
  // An unreadable wav is not evidence of silence. Let the recognizer answer.
  if (!decoded) return { silent: false, rms: Number.NaN };
  const rms = loudestWindowRms(decoded.samples, decoded.sampleRate);
  return { silent: rms < threshold, rms };
}

/**
 * How much quiet to leave after the last thing that was said.
 *
 * Comfortably inside the 1.5 s that still worked in the measurement below, and
 * long enough that a trailing consonant is never clipped.
 */
export const PTT_APPLE_TAIL_KEEP_MS = 800;

/**
 * Cut the dead air off the end of a recording, for Apple's recognizer only.
 *
 * Apple returns *nothing at all* for a clip whose speech is followed by about
 * two seconds of silence. Measured on one `say` clip of "next step"
 * with a padded tail:
 *
 *   tail 0 s / 1 s / 1.5 s   ->  "Next step"
 *   tail 2 s / 2.5 s / 3 s / 6 s -> "" (kAFAssistantErrorDomain, no speech)
 *
 * Adding pink room noise to the tail does not help, so it is the duration and
 * not the digital silence. Leading silence is harmless: three seconds in front
 * of the word still transcribed.
 *
 * This matters because the headset stops recording after
 * `PUSH_TO_TALK_SILENCE_HOLD_MS` (2.5 s) of quiet, so *every* auto-stopped
 * press arrives with about 2.5 s of tail and Apple would answer every one of
 * them with silence. Whisper is unaffected and its path does not call this.
 *
 * Returns undefined when there is nothing worth trimming, so the caller keeps
 * the file it already has.
 */
export function trimTrailingSilence(wav: Buffer, threshold = PTT_SILENCE_RMS,
  keepMs = PTT_APPLE_TAIL_KEEP_MS): Buffer | undefined {
  const decoded = readPcm16Wav(wav);
  if (!decoded || !(threshold > 0)) return undefined;
  const { samples, sampleRate } = decoded;
  const size = Math.max(1, Math.round((sampleRate * PTT_SILENCE_WINDOW_MS) / 1000));
  let lastLoudEnd = -1;
  for (let start = 0; start < samples.length; start += size) {
    const end = Math.min(samples.length, start + size);
    let sum = 0;
    for (let index = start; index < end; index++) sum += samples[index]! * samples[index]!;
    if (Math.sqrt(sum / (end - start)) / 32_768 >= threshold) lastLoudEnd = end;
  }
  // Nothing was ever loud: the energy gate owns that case, not this.
  if (lastLoudEnd < 0) return undefined;
  const keep = Math.min(samples.length, lastLoudEnd + Math.round((sampleRate * keepMs) / 1000));
  if (keep >= samples.length) return undefined;

  const body = Buffer.alloc(keep * 2);
  for (let index = 0; index < keep; index++) body.writeInt16LE(samples[index]!, index * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + body.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(body.length, 40);
  return Buffer.concat([header, body]);
}

/** Read the gate's threshold from the environment, keeping the default for anything unparseable. */
export function silenceThreshold(environment: NodeJS.ProcessEnv = process.env): number {
  const setting = environment[SILENCE_RMS_ENV]?.trim();
  if (setting === undefined || setting === '') return PTT_SILENCE_RMS;
  const value = Number(setting);
  if (!Number.isFinite(value) || value < 0 || value >= 1) return PTT_SILENCE_RMS;
  return value;
}

/** Concatenate contiguous chunks 0..finalSeq, refusing a hole rather than transcribing a splice. */
export function assembleChunks(chunks: ReadonlyMap<number, Buffer>, finalSeq: number): Buffer {
  const ordered: Buffer[] = [];
  for (let seq = 0; seq <= finalSeq; seq++) {
    const chunk = chunks.get(seq);
    // A bare final marker carries no data, so the last index may legitimately
    // be absent; any earlier hole means a chunk was lost in flight.
    if (!chunk) {
      if (seq === finalSeq) continue;
      throw Error(`The recording is missing chunk ${seq}.`);
    }
    ordered.push(chunk);
  }
  return Buffer.concat(ordered);
}

function runProcess(spawn: Spawn, command: string, args: readonly string[], options: {
  timeoutMs: number; stdin?: string; env?: NodeJS.ProcessEnv;
}): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise(resolve => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        shell: false,
        stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        windowsHide: true,
        ...(options.env ? { env: options.env } : {}),
      });
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: error instanceof Error ? error.message : 'spawn failed', timedOut: false });
      return;
    }
    let stdout = '', stderr = '', settled = false, timedOut = false;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { if (stdout.length < 1_000_000) stdout += chunk; });
    child.stderr?.on('data', (chunk: string) => { if (stderr.length < 16_384) stderr += chunk; });
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* It may have exited between the check and the signal. */ }
      settle(null);
    }, options.timeoutMs);
    const settle = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    };
    child.on('error', (error: Error) => { stderr += error.message; settle(null); });
    child.on('close', (code: number | null) => settle(code));
    if (options.stdin !== undefined) {
      try { child.stdin?.end(options.stdin); } catch { /* A command that closed stdin still gets its exit code. */ }
    }
  });
}

/**
 * A bounded, cursor-addressed queue of finished transcripts.
 *
 * `since` is the long-poll the Claude Code listener uses. It resolves as soon
 * as anything newer than the cursor exists, so a caller that already fell
 * behind never waits, and a caller at the head waits out the window once.
 */
export function createTranscriptQueue({ history = PTT_TRANSCRIPT_HISTORY } = {}) {
  const entries: (TranscriptRecord & { cursor: number })[] = [];
  const waiters = new Set<() => void>();
  const subscribers = new Set<(entry: TranscriptRecord & { cursor: number }) => void>();
  // Cursors restart at zero with the process, so a cursor means something only
  // beside the queue that issued it.
  const epoch = randomUUID();
  let cursor = 0;
  return {
    get epoch() { return epoch; },
    get cursor() { return cursor; },
    all() { return entries.map(entry => ({ ...entry })); },
    subscribe(listener: (entry: TranscriptRecord & { cursor: number }) => void) {
      subscribers.add(listener);
      return () => { subscribers.delete(listener); };
    },
    publish(record: TranscriptRecord) {
      const entry = { ...record, cursor: ++cursor };
      entries.push(entry);
      while (entries.length > history) entries.shift();
      for (const listener of subscribers) listener(entry);
      for (const wake of [...waiters]) { waiters.delete(wake); wake(); }
      return entry;
    },
    /** Everything strictly newer than `after`, or `[]` once the wait expires. */
    async since(after: number, { waitMs = PTT_POLL_DEFAULT_WAIT_MS, signal }: { waitMs?: number; signal?: AbortSignal } = {}) {
      const bounded = Math.max(0, Math.min(waitMs, PTT_POLL_MAX_WAIT_MS));
      const take = () => entries.filter(entry => entry.cursor > after).map(entry => ({ ...entry }));
      let ready = take();
      if (!ready.length && bounded > 0 && !signal?.aborted) {
        await new Promise<void>(resolve => {
          const wake = () => { waiters.delete(wake); clearTimeout(timer); signal?.removeEventListener('abort', wake); resolve(); };
          const timer = setTimeout(wake, bounded);
          waiters.add(wake);
          signal?.addEventListener('abort', wake, { once: true });
        });
        ready = take();
      }
      return { cursor, entries: ready };
    },
  };
}
export type TranscriptQueue = ReturnType<typeof createTranscriptQueue>;

export function createPushToTalkTranscriber(options: PushToTalkTranscribeOptions = {}) {
  const spawn = (options.spawn ?? nodeSpawn) as Spawn;
  const log = options.log ?? ((line: string) => { process.stderr.write(`${line}\n`); });
  const now = options.now ?? Date.now;
  const env = options.env ?? process.env;
  const enabled = options.enabled ?? false;
  const exists = options.exists;
  const whisperBin = resolvePath(options.whisperBin, whisperBinCandidates(env), exists ?? existsExecutable);
  const ffmpegBin = resolvePath(options.ffmpegBin, ffmpegBinCandidates(env), exists ?? existsExecutable);
  const whisperModel = resolvePath(options.whisperModel, defaultWhisperModels(), exists ?? existsReadable);
  const configuredAppleBin = options.applespeechBin ?? env[APPLESPEECH_BIN_ENV];
  const transcriber = options.transcriber
    ?? transcriberKind({ ...env, [APPLESPEECH_BIN_ENV]: configuredAppleBin }, { platform: options.platform, exists: exists ?? existsExecutable });
  const silenceThresholdValue = options.silenceRms ?? silenceThreshold(env);
  const applespeechBin = resolvePath(configuredAppleBin, applespeechBinCandidates(env), exists ?? existsExecutable);
  const transcriptLog = options.transcriptLog?.trim() || undefined;
  const textCommand = options.textCommand?.trim() || undefined;
  if (transcriptLog && !isAbsolute(transcriptLog)) throw Error(`${TRANSCRIPT_LOG_ENV} must be an absolute path.`);
  const queue = createTranscriptQueue();
  /** Set by the host once its referent store exists. */
  let readReferent: ((sessionId: string) => RequestReferent | undefined) | undefined;
  const live = new Map<string, Utterance>();
  const rates = new Map<string, RateWindow>();
  let root: Promise<string> | undefined;
  let disposed = false;
  const capturedSessions = new Set<string>();
  let pageDecisions = false;
  const decisions = new Map<string, { record: TranscriptRecord; deadline: number;
    timer: ReturnType<typeof setTimeout>; finish: (handled: boolean) => void }>();
  // Ownership is independent of the bounded transcript log, for this host's lifetime.
  const recordedOwners = new Map<string, string>();
  const decisionResults = new Map<string, { token: string; sessionId?: string; panelId?: string; handled: boolean }>();

  // Apple needs no model file, but headset readiness includes decoding the
  // WebM/Opus recorded by Quest. Direct Apple-supported recordings remain
  // usable without ffmpeg through accept() when capture is explicitly enabled.
  const executable = exists ?? existsExecutable, readable = exists ?? existsReadable;
  const appleReady = Boolean(applespeechBin && executable(applespeechBin));
  const ffmpegReady = Boolean(ffmpegBin && executable(ffmpegBin));
  const whisperBinReady = Boolean(whisperBin && executable(whisperBin));
  const whisperModelReady = Boolean(whisperModel && readable(whisperModel));
  const whisperReady = whisperBinReady && whisperModelReady && ffmpegReady;
  const invalidPaths = [
    ...(transcriber === 'apple' && applespeechBin && !appleReady ? [`applespeech is not executable at ${applespeechBin}`] : []),
    ...(ffmpegBin && !ffmpegReady ? [`ffmpeg is not executable at ${ffmpegBin}`] : []),
    ...(transcriber === 'whisper' || !appleReady ? [
      ...(whisperBin && !whisperBinReady ? [`whisper-cli is not executable at ${whisperBin}`] : []),
      ...(whisperModel && !whisperModelReady ? [`Whisper model is not readable at ${whisperModel}`] : []),
    ] : []),
  ];
  const invalidDetail = invalidPaths.length ? `; ${invalidPaths.join('; ')}` : '';
  // An Apple host with a whisper install is ready either way: the tool being
  // absent is one of the things a clip falls back from, not a reason to refuse
  // the press. Only a host with neither route has nothing to offer.
  const ready = transcriber === 'apple' ? Boolean(appleReady && ffmpegReady) || whisperReady : whisperReady;

  async function temporaryRoot(): Promise<string> {
    if (options.temporaryRoot) {
      await mkdir(options.temporaryRoot, { recursive: true, mode: DIRECTORY_MODE });
      await chmod(options.temporaryRoot, DIRECTORY_MODE);
      return options.temporaryRoot;
    }
    root ??= mkdtemp(join(tmpdir(), 'stereofold-ptt-')).then(async path => { await chmod(path, DIRECTORY_MODE); return path; });
    return root;
  }

  function outcome(input: PushToTalkAudioInput, reason: PushToTalkAudioOutcome['reason'], message: string,
    extra: Partial<PushToTalkAudioOutcome> = {}): PushToTalkAudioOutcome {
    return { utteranceId: input.utteranceId, seq: input.seq, final: input.final, accepted: false, reason, message, ...extra };
  }

  /** Two counters in one rolling window, so neither many tiny presses nor one long one can flood. */
  function withinRate(sessionId: string, newUtterance: boolean): boolean {
    const at = now();
    let window = rates.get(sessionId);
    if (!window || at - window.startedAt >= PTT_RATE_WINDOW_MS) { window = { startedAt: at, chunks: 0, utterances: 0 }; rates.set(sessionId, window); }
    if (rates.size > 32) for (const [id, value] of rates) { if (at - value.startedAt >= PTT_RATE_WINDOW_MS) rates.delete(id); }
    if (window.chunks + 1 > PTT_MAX_CHUNKS_PER_WINDOW) return false;
    if (newUtterance && window.utterances + 1 > PTT_MAX_UTTERANCES_PER_WINDOW) return false;
    window.chunks += 1;
    if (newUtterance) window.utterances += 1;
    return true;
  }

  function sweep() {
    const at = now();
    for (const [id, utterance] of live) {
      if (utterance.finishing) continue;
      if (at - utterance.lastAt > PTT_UTTERANCE_IDLE_MS || at - utterance.startedAt > PTT_MAX_DURATION_MS + PTT_UTTERANCE_IDLE_MS) {
        live.delete(id);
        void discard(utterance);
        log(`push-to-talk audio: utterance ${id} was dropped after no final marker arrived.`);
      }
    }
  }

  async function discard(utterance: Utterance) {
    utterance.chunks.clear();
    if (utterance.directory) await rm(utterance.directory, { recursive: true, force: true }).catch(() => {});
  }

  /** The recording page gets 300 ms to claim local execution. Timeout releases to the assistant. */
  async function fanOut(record: TranscriptRecord, sessionId: string) {
    record.sessionId = sessionId;
    record.panelId = live.get(record.utteranceId)?.panelId;
    if (pageDecisions && record.text) {
      record.pageDecision = randomUUID();
      const finish = (handled: boolean) => {
        const pending = decisions.get(record.utteranceId);
        if (!pending) return;
        clearTimeout(pending.timer);
        decisions.delete(record.utteranceId);
        decisionResults.set(record.utteranceId, { token: record.pageDecision!, sessionId: record.sessionId,
          panelId: record.panelId, handled });
        if (handled) record.headsetAction = true;
        void publish(record, sessionId);
      };
      decisions.set(record.utteranceId, { record, deadline: Date.now() + 300,
        timer: setTimeout(() => finish(false), 300), finish });
      return;
    }
    await publish(record, sessionId);
  }

  async function publish(record: TranscriptRecord, sessionId: string) {
    // Marked before the publish that wakes the listener, so a reader woken by
    // the queue can never see a session that has spoken reported as silent.
    if (record.text && !disposed) {
      capturedSessions.add(sessionId);
      if (capturedSessions.size > 64) capturedSessions.delete(capturedSessions.values().next().value!);
    }
    queue.publish(record);
    const targets: { name: string; run: () => Promise<unknown> }[] = [];
    if (transcriptLog) {
      targets.push({ name: TRANSCRIPT_LOG_ENV, run: async () => {
        await appendFile(transcriptLog, `${JSON.stringify(record)}\n`, { mode: FILE_MODE });
        await chmod(transcriptLog, FILE_MODE).catch(() => {});
      } });
    }
    if (record.text && !record.headsetAction && options.bridge) targets.push({ name: 'headset bridge', run: async () => { await options.bridge!.voice(record); } });
    if (record.text && !record.headsetAction && textCommand) {
      targets.push({ name: TEXT_COMMAND_ENV, run: async () => {
        // The transcript reaches the command on stdin, never inside the command
        // string, so no spoken word can become shell syntax.
        const result = await runProcess(spawn, SHELL, ['-c', textCommand], { timeoutMs: PTT_TEXT_COMMAND_TIMEOUT_MS, stdin: `${record.text}\n`, env });
        if (result.timedOut || result.code !== 0) throw Error(result.stderr.trim() || `exited with ${result.code}`);
      } });
    }
    for (const [index, extra] of (record.text && !record.headsetAction ? options.deliver ?? [] : []).entries()) {
      targets.push({ name: `delivery ${index + 1}`, run: async () => { await extra(record); } });
    }
    await Promise.allSettled(targets.map(async target => {
      try { await target.run(); }
      catch (error) { log(`push-to-talk audio: ${target.name} delivery failed. ${error instanceof Error ? error.message : String(error)}`); }
    }));
  }

  async function transcribe(utterance: Utterance, input: PushToTalkAudioInput): Promise<PushToTalkAudioOutcome> {
    const finalSeq = utterance.finalSeq!;
    const receivedAt = new Date(now()).toISOString();
    const durationMs = Math.max(0, now() - utterance.startedAt);
    /**
     * When the first recognizer process started, or undefined while
     * none has. The energy gate can answer a press before either one runs.
     */
    let recognizerStartedAt: number | undefined;
    /** The pair stamped on a finished record, taken before the deliveries. */
    const heardNow = () => {
      const transcribedAt = Math.round(now());
      return { transcribedAt,
        recognizerMs: Math.max(0, Math.round(transcribedAt - (recognizerStartedAt ?? transcribedAt))) };
    };
    // Captured when this press opened, carried to every reader.
    const referentField = utterance.referent ? { referent: utterance.referent } : {};
    let directory: string | undefined;
    try {
      const speechScene = await utterance.speechScene;
      const vocabulary = buildSpeechVocabulary(speechScene);
      const audio = assembleChunks(utterance.chunks, finalSeq);
      if (!audio.length) return outcome(input, 'failed', 'That press captured no audio.');
      directory = join(await temporaryRoot(), utterance.sessionId.slice(0, 8) + '-' + input.utteranceId);
      utterance.directory = directory;
      await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
      await chmod(directory, DIRECTORY_MODE);
      const encoded = join(directory, `utterance.${containerExtension(utterance.mime)}`);
      // Not `utterance.wav`: `containerExtension` maps `audio/wav` to `wav`, so
      // a recorder that sends wav would make the decode target the same path as
      // its own input and ffmpeg exits with "Output ... same as Input #0",
      // killing voice for that browser entirely. Quest Browser sends WebM, so
      // this was latent, but Safari and a Chromium without the WebM muxer are
      // already in `containerExtension` and wav is one entry down the list.
      const wav = join(directory, 'decoded.16k.wav');
      await writeFile(encoded, audio, { mode: FILE_MODE });

      // Native PCM can be checked directly. Other containers need ffmpeg:
      // no recognizer may bypass the speech-energy gate.
      let recognizable = encoded;
      if (ffmpegReady) {
        const decoded = await runProcess(spawn, ffmpegBin!, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
          '-i', encoded, '-ac', '1', '-ar', String(WHISPER_SAMPLE_RATE), '-c:a', 'pcm_s16le', wav], { timeoutMs: PTT_DECODE_TIMEOUT_MS });
        if (decoded.timedOut || decoded.code !== 0) {
          log(`push-to-talk audio: ffmpeg failed. ${decoded.stderr.trim().slice(0, 400)}`);
          return outcome(input, 'failed', 'The recording could not be decoded on this Mac.');
        }
        recognizable = wav;
      }

      // Gate before the recognizer, not after. A press with nothing spoken in
      // it makes whisper continue its own prompt; see `isSilentRecording`.
      const decodedAudio = await readFile(recognizable);
      if (!readPcm16Wav(decodedAudio)?.samples.length)
        return outcome(input, 'failed', "Didn't catch that. Please speak again.");
      const speechThreshold = silenceThresholdValue || PTT_SILENCE_RMS;
      const quiet = isSilentRecording(decodedAudio, speechThreshold);
      if (quiet.silent) {
        const silentRecord: TranscriptRecord = {
          utteranceId: input.utteranceId, text: '', ...normalizeSpeechText('', speechScene), durationMs, receivedAt,
          ...heardNow(),
          model: transcriber === 'apple' ? APPLESPEECH_MODEL_NAME : whisperModel!,
          ...referentField,
        };
        await fanOut(silentRecord, utterance.sessionId);
        log(`push-to-talk audio: that press was silent (loudest 100 ms ${quiet.rms.toFixed(4)} < ${speechThreshold}), so nothing was transcribed.`);
        return {
          ...outcome(input, 'transcribed', "Didn't catch that. Please speak again."),
          accepted: true, transcript: silentRecord,
        };
      }

      /**
       * Why this clip is not going to Apple after all, or `undefined`.
       *
       * A press is the wearer's only way to say anything, so losing one to a
       * dialog nobody can see is worse than answering it a hundred
       * milliseconds slower with the other recognizer. Every failure here is a
       * property of the host, not of what was said: no tool, no consent, no
       * on-device model, a clip AVFoundation would not open. A clip Apple
       * genuinely heard nothing in is not one of them, because whisper on the
       * same silence invents a command.
       */
      let fallbackFrom: string | undefined;
      if (transcriber === 'apple') {
        if (!applespeechBin) fallbackFrom = 'the applespeech tool was not found';
        else {
          // Apple answers a clip with a two-second tail with silence, and the
          // headset's own auto-stop leaves one on every press. Trim before asking.
          if (recognizable === wav) {
            const trimmed = trimTrailingSilence(await readFile(wav).catch(() => Buffer.alloc(0)), silenceThresholdValue);
            if (trimmed) {
              const short = join(directory, 'trimmed.16k.wav');
              await writeFile(short, trimmed, { mode: FILE_MODE });
              recognizable = short;
            }
          }
          recognizerStartedAt = now();
          const heard = await runProcess(spawn, applespeechBin, [recognizable, '--hint', vocabulary.phrases.join(', ')],
            { timeoutMs: PTT_TRANSCRIBE_TIMEOUT_MS });
          if (heard.timedOut || heard.code !== 0) {
            fallbackFrom = heard.timedOut ? 'applespeech timed out'
              : APPLESPEECH_EXIT_REASONS[heard.code ?? -1] ?? `applespeech exited with ${heard.code}`;
            log(`push-to-talk audio: applespeech failed, ${fallbackFrom}. ${heard.stderr.trim().slice(0, 400)}`);
          } else {
            const appleText = parseAppleSpeechText(heard.stdout);
            if (isSpeechVocabularyEcho(appleText, speechScene))
              return outcome(input, 'failed', "Didn't catch that. Please speak again.");
            const appleRecord: TranscriptRecord = {
              utteranceId: input.utteranceId, text: appleText, ...normalizeSpeechText(appleText, speechScene),
              durationMs, receivedAt, ...heardNow(), model: APPLESPEECH_MODEL_NAME,
              ...referentField,
            };
            await fanOut(appleRecord, utterance.sessionId);
            log(`push-to-talk audio: heard ${appleText ? JSON.stringify(appleText) : '(nothing)'} in ${durationMs} ms`
              + `, recognized in ${appleRecord.recognizerMs} ms.`);
            return {
              ...outcome(input, 'transcribed', appleText ? `Heard: ${appleText}` : 'No speech was recognized.'),
              accepted: true, transcript: appleRecord,
            };
          }
        }
        // Nothing left to fall back to: whisper needs its own binary, a model,
        // and the 16 kHz wav only ffmpeg produces.
        if (!whisperReady || recognizable === encoded) {
          log(`push-to-talk audio: ${fallbackFrom}, and this Mac has no whisper install to fall back to.`);
          return outcome(input, 'failed', 'Local transcription failed on this Mac.');
        }
        log(`push-to-talk audio: falling back to whisper for this press because ${fallbackFrom}.`);
      }

      const prefix = join(directory, 'transcript');
      // A fallback keeps the Apple attempt's start: both runs are time the
      // wearer waited for these words.
      recognizerStartedAt ??= now();
      // A live scene's hint list can override even clearly audible speech:
      // "pause the animation" became its tail, "Residue 15. Hide chain NC2T."
      // Three domain nouns retain short-word accuracy without seeding requests
      // or identifiers. The echo guard below rejects even that small hint list.
      const spoken = await runProcess(spawn, whisperBin!, ['-m', whisperModel!, '-f', wav,
        ...(env[WHISPER_GPU_ENV] === '1' ? [] : ['-ng']),
        '-nt', '-np', '-sns', '--prompt', WHISPER_DOMAIN_HINT, '-otxt', '-of', prefix], { timeoutMs: PTT_TRANSCRIBE_TIMEOUT_MS });
      if (spoken.timedOut || spoken.code !== 0) {
        log(`push-to-talk audio: whisper failed. ${spoken.stderr.trim().slice(0, 400)}`);
        return outcome(input, 'failed', 'Local transcription failed on this Mac.');
      }
      // `-otxt` is the authoritative output; stdout is the same text when the
      // build honours `-np`, and a useful fallback when it does not.
      const written = await readFile(`${prefix}.txt`, 'utf8').catch(() => undefined);
      const text = parseWhisperText(written ?? spoken.stdout) || parseWhisperText(spoken.stdout);
      if (isSpeechVocabularyEcho(text, speechScene))
        return outcome(input, 'failed', "Didn't catch that. Please speak again.");
      const record: TranscriptRecord = {
        utteranceId: input.utteranceId, text, ...normalizeSpeechText(text, speechScene), durationMs, receivedAt,
        ...heardNow(), model: whisperModel!,
        ...(fallbackFrom ? { transcriberFallback: fallbackFrom } : {}),
        ...referentField,
      };
      await fanOut(record, utterance.sessionId);
      log(`push-to-talk audio: heard ${text ? JSON.stringify(text) : '(nothing)'} in ${durationMs} ms`
        + `, recognized in ${record.recognizerMs} ms${fallbackFrom ? ` (whisper, after ${fallbackFrom})` : ''}.`);
      return { ...outcome(input, 'transcribed', text ? `Heard: ${text}` : 'No speech was recognized.'), accepted: true, transcript: record };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The recording could not be transcribed.';
      log(`push-to-talk audio: ${message}`);
      return outcome(input, 'failed', message);
    } finally {
      utterance.chunks.clear();
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
      utterance.directory = undefined;
    }
  }

  return {
    get enabled() { return enabled; },
    get ready() { return ready; },
    get whisperBin() { return whisperBin; },
    get whisperModel() { return whisperModel; },
    get ffmpegBin() { return ffmpegBin; },
    /** Which recognizer this host chose, before asking whether it resolved. */
    get route() { return transcriber; },
    get applespeechBin() { return applespeechBin; },
    captureObserved(sessionId: string) { return capturedSessions.has(sessionId); },
    readinessDetail() {
      return (transcriber === 'apple' && appleReady
        ? `Apple recognizer at ${applespeechBin}; consent not yet observed`
        : `${transcriber === 'apple' ? 'Apple recognizer unresolved; fallback ' : ''}Whisper recognizer at ${whisperBin ?? 'unresolved'}; model ${whisperModel ?? 'unresolved'}`) + invalidDetail;
    },
    /**
     * What `describe()` names as absent, as a list.
     *
     * The sentence is for a startup banner a person reads once. A readiness
     * check has to put the same facts in a structured result and in a refusal,
     * and re-deriving them from prose is how the two drift apart.
     */
    missing(): string[] {
      // Prerequisites are independent of the opt-in. Enabling capture cannot
      // repair an unresolved binary or model, so report these even while off.
      if (ready) return [];
      const absent: string[] = [];
      if (transcriber === 'apple' && !appleReady && !whisperReady) absent.push('the applespeech tool');
      if (transcriber === 'whisper' || (transcriber === 'apple' && !appleReady)) {
        if (!whisperBinReady) absent.push('whisper-cli');
        if (!whisperModelReady) absent.push('a whisper model');
      }
      if (!ffmpegReady) absent.push('ffmpeg');
      return absent;
    },
    transcripts: queue,
    /** Live utterance count; a test seam and a useful assertion about cleanup. */
    pending() { return live.size; },

    /**
     * What the host prints at startup: which recognizer is about to run, and
     * for Apple's, the one thing a new user has to do that nothing else in
     * this product asks of them.
     *
     * The consent sentence is here rather than in a document because this is
     * the moment it is needed. macOS raises the Speech Recognition dialog on
     * the first recognition, against the application that launched the host,
     * and the person who will see it is reading this line in that
     * application's window. A wearer who has already put the headset on will
     * not see it at all.
     */
    describe(): string {
      if (!enabled) return `Headset voice is off (${PUSH_TO_TALK_TRANSCRIBE_ENV}=0). Set it to 1 or use --ptt; --no-ptt overrides the environment.`;
      const missing: string[] = [];
      if (transcriber === 'apple' && !appleReady && !whisperReady) {
        missing.push(`the applespeech tool (build it with \`sh native/applespeech/build.sh\`, or set ${APPLESPEECH_BIN_ENV})`);
      }
      if (transcriber === 'whisper' || (transcriber === 'apple' && !appleReady)) {
        if (!whisperBinReady) missing.push(`whisper-cli (set ${WHISPER_BIN_ENV})`);
        if (!whisperModelReady) missing.push(`a whisper model (set ${WHISPER_MODEL_ENV})`);
      }
      if (!ffmpegReady) missing.push(`ffmpeg (set ${FFMPEG_BIN_ENV})`);
      if (!ready) return `Headset voice is on but cannot transcribe headset recordings: this Mac is missing ${missing.join(', ')}.${invalidDetail}`;
      const deliveries = [transcriptLog ? `appending to ${transcriptLog}` : '', options.bridge ? 'writing to the headset bridge' : '',
        textCommand ? `piping to ${TEXT_COMMAND_ENV}` : ''].filter(Boolean);
      if (transcriber === 'apple' && appleReady) {
        // macOS names the responsible app in that dialog, not
        // this product, so quoting a "Stereofold would like to..." title told
        // the operator to wait for something that never appears.
        const consent = 'The first press raises a macOS Speech Recognition dialog from the app that started this host, '
          + 'Terminal or Claude Code. Click Allow there before the headset goes on: '
          + 'the grant belongs to that app, and a launchd daemon with no window of its own can never show the dialog, '
          + `so a background host should set ${TRANSCRIBER_ENV}=whisper.`;
        const rescue = whisperReady ? ' A press the recognizer refuses falls back to whisper.'
          // The Apple route exists for a Mac with no whisper install, and that
          // is exactly the Mac where an unanswered dialog loses the press
          // outright rather than costing it some accuracy. Say so here, because
          // nothing in the headset can.
          : ' This Mac has no whisper install to fall back to, so a press the recognizer refuses is lost.';
        return `Headset voice transcribes locally with Apple's on-device recognizer through ${applespeechBin}`
          + `${deliveries.length ? `, ${deliveries.join(', ')}` : ''}.${rescue} ${consent}`;
      }
      const why = transcriber === 'apple'
        ? ` Apple's recognizer was asked for but its tool is missing; build it with \`sh native/applespeech/build.sh\`.`
        : '';
      return `Headset voice transcribes locally with ${whisperBin} and ${whisperModel}`
        + `${deliveries.length ? `, ${deliveries.join(', ')}` : ''}.${why}`;
    },

    /**
     * Tell this transcriber where to read the open request's
     * referent from. The host owns that store, and it is created after the
     * transcriber, so it is handed over rather than passed in.
     */
    usePageDecisions() { pageDecisions = true; },
    decide(input: PushToTalkAudioInput) {
      const pending = decisions.get(input.utteranceId), decision = input.pageDecision;
      const previous = decisionResults.get(input.utteranceId);
      if (previous) return previous.token === decision?.token && previous.sessionId === input.sessionId
        && previous.panelId === input.panelId && decision?.handled === true && previous.handled;
      if (!pending || !decision || pending.record.pageDecision !== decision.token
        || pending.record.sessionId !== input.sessionId || pending.record.panelId !== input.panelId) return false;
      const handled = decision.handled && Date.now() < pending.deadline;
      pending.finish(handled);
      return handled;
    },
    useReferents(read: (sessionId: string) => RequestReferent | undefined) { readReferent = read; },

    /**
     * Accept one chunk. The caller resolves the session first, so an expired
     * capability never reaches an assembler or a transcription process.
     */
    async accept(input: PushToTalkAudioInput, speechScene?: SpeechSceneContext | Promise<SpeechSceneContext>): Promise<PushToTalkAudioOutcome> {
      if (disposed || !enabled) return outcome(input, 'disabled', `Headset voice is off on this Mac (${PUSH_TO_TALK_TRANSCRIBE_ENV}=0). Set ${PUSH_TO_TALK_TRANSCRIBE_ENV}=1 in the MCP server environment, or start the standalone launcher with --ptt.`);
      const owner = recordedOwners.get(input.utteranceId);
      if (owner !== undefined && owner !== input.sessionId) return outcome(input, 'unknown_utterance', 'That utterance belongs to another session.');
      const extension = containerExtension(live.get(input.utteranceId)?.mime ?? input.mime);
      const nativeAppleInput = transcriber === 'apple' && appleReady && extension !== 'webm' && extension !== 'ogg';
      if (!ready && !nativeAppleInput) {
        if (transcriber === 'apple' && appleReady && !ffmpegReady) {
          return outcome(input, 'disabled', `Apple's recognizer needs ffmpeg to decode this recording. Install ffmpeg and set ${FFMPEG_BIN_ENV} to its executable, then restart the host.`);
        }
        return outcome(input, 'disabled', transcriber === 'apple'
          ? `This Mac is set to Apple's recognizer but the applespeech tool was not found, and it has no whisper install to fall back to. Build the tool with \`sh native/applespeech/build.sh\`, or set ${APPLESPEECH_BIN_ENV}.`
          : 'This Mac has no local transcriber installed: it needs whisper-cli, a whisper model and ffmpeg. Set STEREOFOLD_WHISPER_BIN, STEREOFOLD_WHISPER_MODEL and STEREOFOLD_FFMPEG_BIN to their absolute paths.');
      }
      sweep();
      const existing = live.get(input.utteranceId);
      if ((existing && existing.sessionId !== input.sessionId)
        || queue.all().some(entry => entry.utteranceId === input.utteranceId && entry.sessionId !== undefined && entry.sessionId !== input.sessionId))
        return outcome(input, 'unknown_utterance', 'That utterance belongs to another session.');
      if (owner && !existing) return outcome(input, 'duplicate', 'That utterance has already finished. Use a new recording ID.');
      if (existing?.finishing) return outcome(input, 'duplicate', 'That utterance is already being transcribed.');
      if (!existing && input.final && !input.data) return outcome(input, 'unknown_utterance', 'That utterance was never started or has already ended.');
      if (!withinRate(input.sessionId, !existing)) return outcome(input, 'rate_limited', 'Too much audio arrived from this session. Wait a moment and speak again.');
      if (!existing && live.size >= PTT_MAX_ACTIVE_UTTERANCES) return outcome(input, 'too_many', 'Too many recordings are still being assembled.');

      recordedOwners.set(input.utteranceId, input.sessionId);
      const at = now();
      const utterance: Utterance = existing ?? { sessionId: input.sessionId, panelId: input.panelId, mime: input.mime, chunks: new Map(), bytes: 0, startedAt: at, lastAt: at };
      // The request starts with its first chunk, so this is the
      // moment the referent is true. A later chunk never re-reads it.
      if (!existing) {
        utterance.referent = readReferent?.(input.sessionId);
        utterance.speechScene = speechScene instanceof Promise ? speechScene.then(value => structuredClone(value))
          : speechScene ? structuredClone(speechScene) : undefined;
        live.set(input.utteranceId, utterance);
      }
      utterance.lastAt = at;
      if (at - utterance.startedAt > PTT_MAX_DURATION_MS) {
        live.delete(input.utteranceId);
        await discard(utterance);
        return outcome(input, 'too_large', 'That press ran past the sixty-second recording limit.');
      }
      if (utterance.chunks.has(input.seq)) return outcome(input, 'duplicate', `Chunk ${input.seq} was already received.`);

      if (input.data) {
        const bytes = Buffer.from(input.data, 'base64');
        // Round-tripping catches a payload that decoded to fewer bytes than it
        // claimed, which is the shape a truncated upload arrives in.
        if (!bytes.length || bytes.toString('base64') !== input.data) return outcome(input, 'failed', 'That audio chunk was not valid base64.');
        if (utterance.bytes + bytes.length > PTT_MAX_UTTERANCE_BYTES) {
          live.delete(input.utteranceId);
          await discard(utterance);
          return outcome(input, 'too_large', 'That recording exceeded the audio size limit.');
        }
        if (utterance.chunks.size + 1 > PTT_MAX_CHUNKS) {
          live.delete(input.utteranceId);
          await discard(utterance);
          return outcome(input, 'too_large', 'That recording produced too many chunks.');
        }
        utterance.chunks.set(input.seq, bytes);
        utterance.bytes += bytes.length;
      }

      if (!input.final) {
        return { ...outcome(input, 'chunk', `Chunk ${input.seq} received.`), accepted: true };
      }
      utterance.finalSeq = input.seq;
      // Hold the entry until transcription resolves so a duplicate final
      // marker joins the same work rather than starting a second whisper run.
      const work = transcribe(utterance, input).finally(() => { live.delete(input.utteranceId); });
      utterance.finishing = work;
      return work;
    },

    async dispose() {
      disposed = true;
      for (const pending of decisions.values()) pending.finish(false);
      recordedOwners.clear();
      decisionResults.clear();
      capturedSessions.clear();
      const pending = [...live.values()];
      live.clear();
      await Promise.allSettled(pending.map(utterance => discard(utterance)));
      if (root) await rm(await root, { recursive: true, force: true }).catch(() => {});
    },
  };
}

export type PushToTalkTranscriber = ReturnType<typeof createPushToTalkTranscriber>;

/**
 * The bridge delivery, when a bridge directory was named.
 *
 * `model` becomes a bare file name here: the bridge file is read by the Claude
 * Science assistant, and which model transcribed the speech is a fact worth
 * publishing while the path it sits at on this Mac is not.
 */
export function bridgeDelivery(directory: string | undefined): PushToTalkTranscribeOptions['bridge'] {
  const root = directory?.trim();
  if (!root) return undefined;
  if (!isAbsolute(root)) throw Error(`${BRIDGE_DIR_ENV} must be an absolute path.`);
  // Named field by field rather than spread: the bridge's voice schema is
  // strict, so a field added to `TranscriptRecord` for the transcript log
  // would otherwise throw here and lose the utterance the headset is waiting
  // for. `transcriberFallback` is the first such field.
  return { voice: ({ utteranceId, text, durationMs, receivedAt, transcribedAt, recognizerMs, model }: TranscriptRecord) =>
    writeBridgeVoice(root, { utteranceId, text, durationMs, receivedAt,
      ...(transcribedAt === undefined ? {} : { transcribedAt }),
      ...(recognizerMs === undefined ? {} : { recognizerMs }),
      model: basename(model) }) };
}

/**
 * Can this Mac transcribe headset recordings through Apple or Whisper, with
 * ffmpeg to decode the headset's WebM/Opus container.
 *
 * Explicit settings retain precedence, but their paths must actually be
 * executable (tools) or readable (the model) before capture auto-enables.
 */
export function localTranscriberInstalled({ environment = process.env, home = homedir(), platform, exists }:
  { environment?: NodeJS.ProcessEnv; home?: string; platform?: NodeJS.Platform; exists?: (path: string) => boolean } = {}): boolean {
  const executable = exists ?? existsExecutable;
  const readable = exists ?? existsReadable;
  // Apple needs one small tool and no Whisper model, but Quest recordings
  // still need ffmpeg before AVFoundation can read them.
  const available = (path: string | undefined, check: (path: string) => boolean) => Boolean(path && check(path));
  const ffmpeg = available(resolvePath(environment[FFMPEG_BIN_ENV], ffmpegBinCandidates(environment), executable), executable);
  const apple = ffmpeg && available(resolvePath(environment[APPLESPEECH_BIN_ENV], applespeechBinCandidates(environment), executable), executable);
  const whisper = ffmpeg && available(resolvePath(environment[WHISPER_BIN_ENV], whisperBinCandidates(environment), executable), executable)
    && available(resolvePath(environment[WHISPER_MODEL_ENV], defaultWhisperModels(home), readable), readable);
  // Either route counts for a host that asked for Apple's, because a clip it
  // cannot take is transcribed by whisper rather than lost.
  return transcriberKind(environment, { platform, exists: executable }) === 'apple' ? apple || whisper : whisper;
}

/** The settings that mean "off"; every other value means on. */
const OFF_SETTINGS = new Set(['0', 'off', 'no', 'false']);

/**
 * Whether this host transcribes what the wearer says.
 *
 * `STEREOFOLD_PTT_TRANSCRIBE` decides when it is set, and `0` turns it off.
 * Unset means on whenever this Mac can actually transcribe. That default is
 * the whole point: the Claude Science and Codex hosts never set the variable,
 * so the headset recorded, the orb glowed, and nothing on the Mac listened.
 */
export function transcriptionEnabled(environment: NodeJS.ProcessEnv = process.env,
  installed: (options: { environment: NodeJS.ProcessEnv }) => boolean = localTranscriberInstalled): boolean {
  const setting = environment[PUSH_TO_TALK_TRANSCRIBE_ENV]?.trim().toLowerCase();
  if (setting) return !OFF_SETTINGS.has(setting);
  return installed({ environment });
}

/**
 * Read the host's configuration from the environment it was started with.
 * A missing binary or model degrades to a clear log line and a `disabled`
 * answer, because headset voice is an accessory to an inspection session.
 */
export function pushToTalkTranscriberFromEnv(env: NodeJS.ProcessEnv = process.env,
  overrides: PushToTalkTranscribeOptions = {}): PushToTalkTranscriber {
  const base: PushToTalkTranscribeOptions = {
    enabled: transcriptionEnabled(env),
    whisperBin: env[WHISPER_BIN_ENV],
    whisperModel: env[WHISPER_MODEL_ENV],
    ffmpegBin: env[FFMPEG_BIN_ENV],
    // Left to `createPushToTalkTranscriber`, which resolves it against the same
    // `exists` seam it uses for every other path, so one host cannot decide the
    // binary is there and then fail to find it.
    applespeechBin: env[APPLESPEECH_BIN_ENV],
    transcriptLog: env[TRANSCRIPT_LOG_ENV],
    textCommand: env[TEXT_COMMAND_ENV],
    env,
    ...overrides,
  };
  // One unusable setting turns headset voice off rather than stopping the
  // server, because voice is an accessory to an inspection session.
  try { return createPushToTalkTranscriber({ bridge: bridgeDelivery(env[BRIDGE_DIR_ENV]), ...base }); }
  catch (error) {
    const log = base.log ?? ((line: string) => { process.stderr.write(`${line}\n`); });
    log(`push-to-talk audio: ${error instanceof Error ? error.message : 'The configuration could not be read.'} Headset voice is off.`);
    return createPushToTalkTranscriber({ ...base, enabled: false, transcriptLog: undefined, textCommand: undefined, bridge: undefined });
  }
}
