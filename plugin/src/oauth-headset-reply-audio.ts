import { HEADSET_SPEECH_MAX_SECONDS } from './headset-captions.js';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DEFAULT_FFMPEG_BINS, oggOpusSeconds, REPLY_AUDIO_BITRATE, REPLY_AUDIO_ENCODE_TIMEOUT_MS,
  REPLY_AUDIO_FORMAT, REPLY_AUDIO_MAX_BASE64, REPLY_AUDIO_MAX_CHARS,
  REPLY_AUDIO_MIME, REPLY_AUDIO_SAMPLE_RATE, type ReplyAudioClip, type ReplyAudioSynthesizer,
} from './headset-reply-audio.js';
import {
  agentVoiceBin, missingAgentVoiceMessage, OAUTH_SPEECH_INSTRUCTIONS,
  synthesizeOAuthSpeech as defaultSynthesizeOAuthSpeech,
  type OAuthSpeechOptions,
} from './oauth-voice-acknowledgement.js';
import { createReplyVoiceCache, type ReplyVoiceCache } from './reply-voice-cache.js';

const FILE_MODE = 0o600;
const MAX_WAV_BYTES = 1_500_000;
/** The voice this adapter asks for, and part of what a cached clip is keyed on. */
const OAUTH_REPLY_VOICE = 'marin';

type Spawn = typeof nodeSpawn;
type OAuthSpeech = (text: string, options?: OAuthSpeechOptions) => Promise<{ wavBase64: string }>;

export type OAuthReplyAudioOptions = {
  enabled?: boolean;
  ffmpegBin?: string;
  spawn?: Spawn;
  exists?: (path: string) => boolean;
  tmpRoot?: string;
  maxBase64?: number;
  timeoutMs?: number;
  synthesize?: OAuthSpeech;
  log?: (message: string) => void;
  /** The host's environment, which names the OAuth narration helper. */
  env?: NodeJS.ProcessEnv;
  /**
   * Where recently spoken lines are kept, so a repeated sentence skips the
   * round trip. `false` turns the cache off; a value replaces it for a test.
   */
  cache?: ReplyVoiceCache | false;
};

function existsExecutable(path: string): boolean {
  try { accessSync(path, constants.X_OK); return true; }
  catch { return false; }
}

function resolveBin(configured: string | undefined, exists: (path: string) => boolean) {
  const chosen = typeof configured === 'string' ? configured.trim() : '';
  if (chosen) return exists(chosen) ? chosen : undefined;
  return DEFAULT_FFMPEG_BINS.find(exists);
}

function runFfmpeg(spawn: Spawn, command: string, args: readonly string[], timeoutMs: number) {
  return new Promise<{ code: number | null; stderr: string; timedOut: boolean }>(resolve => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      resolve({ code: null, stderr: error instanceof Error ? error.message : 'spawn failed', timedOut: false });
      return;
    }
    let stderr = '', settled = false, timedOut = false;
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { if (stderr.length < 16_384) stderr += chunk; });
    const settle = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stderr, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* The process may have exited already. */ }
      settle(null);
    }, timeoutMs);
    timer.unref?.();
    child.on('error', (error: Error) => { stderr += error.message; settle(null); });
    child.on('close', (code: number | null) => settle(code));
  });
}

function decodeWav(base64: unknown): Buffer {
  if (typeof base64 !== 'string' || !base64 || base64.length % 4
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw Error('OAuth voice returned invalid audio encoding.');
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.byteLength < 44 || bytes.byteLength > MAX_WAV_BYTES
      || bytes.toString('base64') !== base64 || bytes.subarray(0, 4).toString('ascii') !== 'RIFF') {
    throw Error('OAuth voice returned invalid audio.');
  }
  return bytes;
}

/**
 * Adapt the established OAuth-only voice route to the headset's Ogg Opus
 * heartbeat contract. Authentication and speech generation stay in the
 * injected OAuth helper; this adapter only performs bounded local encoding.
 */
export function createOAuthReplyAudioSynthesizer(options: OAuthReplyAudioOptions = {}): ReplyAudioSynthesizer {
  const enabled = options.enabled !== false;
  const exists = options.exists ?? existsExecutable;
  const ffmpegBin = resolveBin(options.ffmpegBin, exists);
  const spawn = (options.spawn ?? nodeSpawn) as Spawn;
  const synthesizeOAuthSpeech = options.synthesize ?? defaultSynthesizeOAuthSpeech;
  const tmpRoot = options.tmpRoot ?? tmpdir();
  const maxBase64 = Number.isSafeInteger(options.maxBase64) && options.maxBase64! > 0
    ? options.maxBase64! : REPLY_AUDIO_MAX_BASE64;
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs! >= 1
    ? Math.round(options.timeoutMs!) : REPLY_AUDIO_ENCODE_TIMEOUT_MS;
  const log = options.log ?? ((message: string) => console.error(message));
  const env = options.env ?? process.env;
  // The cache exists to skip the narration helper's round trip. A caller that
  // supplied its own `synthesize` is not paying for that round trip and is
  // usually a test, so it gets no cache unless it asks for one by name: a test
  // double must never read or write the host's own cache directory.
  const cache = options.cache === false ? undefined
    : options.cache ?? (options.synthesize ? undefined : createReplyVoiceCache());
  // Resolving can throw on a relative setting; a startup line reports that
  // rather than letting the host die before it prints anything at all.
  const voiceBin = (() => { try { return agentVoiceBin(env, { exists }); } catch (error) { return error instanceof Error ? error : Error('unusable'); } })();
  const ready = Boolean(enabled && ffmpegBin && (options.synthesize ||
    (typeof voiceBin === 'string' && exists(voiceBin))));

  const inFlight = new Map<string, Promise<ReplyAudioClip | undefined>>();

  async function render(line: string): Promise<ReplyAudioClip | undefined> {
    // Everything that changes the sound is in the key, not the words alone:
    // a different voice, a different reading direction or a different encode
    // has to miss rather than replay the clip it would not have produced.
    const key = cache?.key([OAUTH_REPLY_VOICE, '1', OAUTH_SPEECH_INSTRUCTIONS,
      REPLY_AUDIO_FORMAT, String(REPLY_AUDIO_SAMPLE_RATE), REPLY_AUDIO_BITRATE, line]);
    if (key) {
      const kept = await cache!.get(key);
      // The model renders the same words differently each time, so a hit is
      // a previous reading of this sentence, not a fresh one. It is the same
      // words in the same voice, which is all the wearer was promised. A
      // clip in a shape this adapter no longer sends is a miss, not a
      // container the page is asked to guess at.
      if (kept?.format === REPLY_AUDIO_FORMAT && kept.mimeType === REPLY_AUDIO_MIME) {
        return { ...kept, format: REPLY_AUDIO_FORMAT };
      }
    }
    let workspace: string | undefined;
    try {
      const speech = await synthesizeOAuthSpeech(line, { env });
      const wav = decodeWav(speech?.wavBase64);
      workspace = await mkdtemp(join(tmpRoot, 'stereofold-oauth-reply-'));
      const inputPath = join(workspace, 'reply.wav');
      const outputPath = join(workspace, 'reply.ogg');
      await writeFile(inputPath, wav, { mode: FILE_MODE });
      const encoded = await runFfmpeg(spawn, ffmpegBin!, [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', inputPath,
        '-t', String(HEADSET_SPEECH_MAX_SECONDS), '-ac', '1', '-ar', String(REPLY_AUDIO_SAMPLE_RATE), '-c:a', 'libopus',
        '-b:a', REPLY_AUDIO_BITRATE, '-vbr', 'on', '-application', 'voip', outputPath,
      ], timeoutMs);
      if (encoded.code !== 0) {
        log(`OAuth headset reply audio: ffmpeg failed. ${encoded.timedOut ? 'Timed out.' : encoded.stderr.trim().slice(0, 200)}`);
        return undefined;
      }
      const bytes = await readFile(outputPath);
      if (!bytes.byteLength) throw Error('ffmpeg returned an empty audio clip.');
      const base64 = bytes.toString('base64');
      if (base64.length > maxBase64) throw Error('encoded audio exceeds the inline limit.');
      const seconds = oggOpusSeconds(bytes);
      const clip: ReplyAudioClip = { base64, mimeType: REPLY_AUDIO_MIME, format: REPLY_AUDIO_FORMAT,
        bytes: bytes.byteLength, voice: OAUTH_REPLY_VOICE, ...(seconds ? { seconds } : {}) };
      if (key) await cache!.put(key, clip);
      return clip;
    } catch (error) {
      log(`OAuth headset reply audio: ${error instanceof Error ? error.message.slice(0, 240) : 'render failed'}`);
      return undefined;
    } finally {
      if (workspace) await rm(workspace, { recursive: true, force: true }).catch(() => { /* Best effort cleanup. */ });
    }
  }

  return {
    ready,
    enabled,
    describe() {
      if (!enabled) return 'Headset reply audio: off.';
      if (!ffmpegBin) return 'Headset reply audio: unavailable, no ffmpeg (set STEREOFOLD_FFMPEG_BIN).';
      if (voiceBin instanceof Error) return `Headset reply audio: ${voiceBin.message}`;
      if (!voiceBin) return `Headset reply audio: ${missingAgentVoiceMessage(undefined, env)}`;
      if (!exists(voiceBin)) return `Headset reply audio: ${missingAgentVoiceMessage(voiceBin, env)}`;
      return 'Headset reply audio: OAuth narration selected; local Opus encoder available (OAuth connection checked on use).';
    },
    async synthesize(text: string) {
      const line = typeof text === 'string' ? text.trim() : '';
      if (!ready || !line || line.length > REPLY_AUDIO_MAX_CHARS) return undefined;
      // A disk cache only helps after the first render finishes. Concurrent
      // requests for the same words share that render, including its cache
      // lookup and encoding. Different sentences still render in parallel.
      // The map belongs to one fixed voice/provider/encoder configuration.
      const existing = inFlight.get(line);
      if (existing) return existing;
      const pending = render(line).finally(() => { inFlight.delete(line); });
      inFlight.set(line, pending);
      return pending;
    },
  };
}
