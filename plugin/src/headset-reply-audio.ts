import { HEADSET_SPEECH_MAX_SECONDS } from './headset-captions.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Sound for a headset that has no voice of its own.
 *
 * `say_to_headset` draws a caption and asks the browser to read it aloud. On a
 * real Quest 2 that second half does nothing: Quest Browser reports zero
 * `speechSynthesis` voices, so every reply is silent. This module renders the
 * same sentence on the Mac with `/usr/bin/say`, encodes it to Opus with the
 * ffmpeg the local transcriber already requires, and hands back a small
 * base64 clip that rides the caption itself down the companion heartbeat.
 *
 * System speech uses local `say` and `ffmpeg`, avoiding an external voice
 * service; reply audio still travels to the headset over the private LAN or
 * the explicitly configured relay. Text reaches `say` through a file rather
 * than argv, so a reply that begins with a dash is spoken instead of parsed
 * as a flag.
 *
 * Every failure here is silent by design. A missing binary, an unknown voice,
 * a slow render or a clip that came out too large costs the wearer the sound,
 * never the caption: the synthesiser answers `undefined` and the reply is
 * queued exactly as it was before.
 */

/** Ogg Opus: Chromium decodes it natively and 24 kbps speech is a few kilobytes a second. */
export const REPLY_AUDIO_MIME = 'audio/ogg; codecs=opus';
export const REPLY_AUDIO_FORMAT = 'ogg-opus';
export const REPLY_AUDIO_SAMPLE_RATE = 24_000;
export const REPLY_AUDIO_BITRATE = '24k';
/** Inline delivery ceiling. A 280-character reply encodes to roughly 30 KB of base64. */
export const REPLY_AUDIO_MAX_BASE64 = 200_000;
/** `say` renders faster than real time; this only bounds a wedged process. */
export const REPLY_AUDIO_SAY_TIMEOUT_MS = 8_000;
export const REPLY_AUDIO_ENCODE_TIMEOUT_MS = 5_000;
export const REPLY_AUDIO_VOICE_LIST_TIMEOUT_MS = 4_000;
/** Words per minute. macOS defaults to 175; 180 reads as ordinary speech. */
export const REPLY_AUDIO_DEFAULT_RATE = 180;
export const REPLY_AUDIO_MAX_CHARS = 280;

// mkdtemp already creates the directory 0700; the script file is narrowed too.
const FILE_MODE = 0o600;

export const DEFAULT_SAY_BINS = Object.freeze(['/usr/bin/say']);
export const DEFAULT_FFMPEG_BINS = Object.freeze([
  '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg',
]);
/**
 * Best installed English voice, most natural first. The premium and enhanced
 * downloads are preferred when the wearer has them; Samantha is the voice
 * every macOS install already carries. Nothing here downloads a voice.
 */
export const REPLY_AUDIO_VOICE_CANDIDATES = Object.freeze([
  'Ava (Premium)', 'Zoe (Premium)', 'Evan (Premium)', 'Allison (Premium)',
  'Ava (Enhanced)', 'Zoe (Enhanced)', 'Evan (Enhanced)', 'Allison (Enhanced)',
  'Ava', 'Allison', 'Samantha', 'Alex', 'Daniel',
]);

export const REPLY_AUDIO_ENABLED_ENV = 'STEREOFOLD_REPLY_AUDIO';
export const REPLY_AUDIO_SAY_BIN_ENV = 'STEREOFOLD_SAY_BIN';
export const REPLY_AUDIO_VOICE_ENV = 'STEREOFOLD_REPLY_VOICE';
export const REPLY_AUDIO_RATE_ENV = 'STEREOFOLD_REPLY_RATE';
export const FFMPEG_BIN_ENV = 'STEREOFOLD_FFMPEG_BIN';

export type ReplyAudioClip = {
  /** Ogg Opus bytes, base64 encoded, for inline delivery on the heartbeat. */
  base64: string;
  mimeType: string;
  format: typeof REPLY_AUDIO_FORMAT;
  /** Decoded byte length, so a log line can report the clip without the clip. */
  bytes: number;
  voice?: string;
  /** The clip's own length in seconds, read off the container. Absent if unreadable. */
  seconds?: number;
};

/** 48 kHz is the Opus granule clock, whatever the sample rate the encoder was given. */
const OPUS_GRANULE_RATE = 48_000;
/** An unset granule position. A page carrying it says nothing about duration. */
const OGG_GRANULE_UNSET = 0xffffffffffffffffn;

/**
 * How long an Ogg Opus clip runs, from the container rather than from a guess.
 *
 * The last page's granule position is the clip's end in 48 kHz samples, and
 * the `OpusHead` pre-skip is how much of the start the decoder throws away.
 * Pages are walked rather than searched for, because the four bytes `OggS`
 * also occur inside compressed audio and a spurious match would report a
 * duration that is not the clip's.
 *
 * Undefined whenever the bytes do not read as a complete Ogg stream. The
 * caller then falls back to an estimate and says that it did.
 */
export function oggOpusSeconds(bytes: Buffer): number | undefined {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength < 27) return undefined;
  let offset = 0;
  let granule: bigint | undefined;
  let preSkip: number | undefined;
  while (offset + 27 <= bytes.byteLength) {
    if (bytes.subarray(offset, offset + 4).toString('ascii') !== 'OggS') return undefined;
    const segments = bytes[offset + 26]!;
    const body = offset + 27 + segments;
    if (body > bytes.byteLength) return undefined;
    let payload = 0;
    for (let index = 0; index < segments; index++) payload += bytes[offset + 27 + index]!;
    if (preSkip === undefined && body + 12 <= bytes.byteLength
      && bytes.subarray(body, body + 8).toString('ascii') === 'OpusHead') preSkip = bytes.readUInt16LE(body + 10);
    granule = bytes.readBigUInt64LE(offset + 6);
    offset = body + payload;
  }
  if (granule === undefined || granule === OGG_GRANULE_UNSET) return undefined;
  const samples = Number(granule) - (preSkip ?? 0);
  if (!(samples > 0)) return undefined;
  return Math.round((samples / OPUS_GRANULE_RATE) * 100) / 100;
}

export type ReplyAudioSynthesizer = {
  /** True when both binaries were found. A false synthesiser always answers undefined. */
  readonly ready: boolean;
  readonly enabled: boolean;
  /** One line for the host banner. Never contains a path the user did not set. */
  describe(): string;
  /** The clip for one reply, or undefined when this Mac cannot make one. */
  synthesize(text: string): Promise<ReplyAudioClip | undefined>;
};

type Spawn = typeof nodeSpawn;

function existsExecutable(path: string): boolean {
  try { accessSync(path, constants.X_OK); return true; }
  catch { return false; }
}

function resolveBin(configured: string | undefined, defaults: readonly string[], exists: (path: string) => boolean) {
  const chosen = typeof configured === 'string' ? configured.trim() : '';
  if (chosen) return exists(chosen) ? chosen : undefined;
  return defaults.find(exists);
}

function runProcess(spawn: Spawn, command: string, args: readonly string[], timeoutMs: number):
Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise(resolve => {
    let child: ChildProcess;
    try { child = spawn(command, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); }
    catch (error) {
      resolve({ code: null, stdout: '', stderr: error instanceof Error ? error.message : 'spawn failed', timedOut: false });
      return;
    }
    let stdout = '', stderr = '', settled = false, timedOut = false;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { if (stdout.length < 262_144) stdout += chunk; });
    child.stderr?.on('data', (chunk: string) => { if (stderr.length < 16_384) stderr += chunk; });
    const settle = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* It may have exited between the check and the signal. */ }
      settle(null);
    }, timeoutMs);
    timer.unref?.();
    child.on('error', (error: Error) => { stderr += error.message; settle(null); });
    child.on('close', (code: number | null) => settle(code));
  });
}

/**
 * The installed voice names, in the order `say` lists them.
 *
 * A line is `Name  locale  # sample`. A name may itself contain spaces and
 * brackets, and a long one leaves a single space before its locale, so the
 * name is whatever precedes the locale that precedes the sample marker.
 */
export function parseSayVoices(listing: string): string[] {
  const names: string[] = [];
  for (const line of String(listing ?? '').split('\n')) {
    const match = /^(.*?)\s+([a-z]{2}(?:[-_][A-Za-z0-9]{2,})?)\s+#/.exec(line);
    if (match?.[1]) names.push(match[1].trim());
  }
  return names;
}

/** The first candidate this Mac actually has, or undefined for the system default. */
export function chooseReplyVoice(installed: readonly string[], candidates: readonly string[] = REPLY_AUDIO_VOICE_CANDIDATES) {
  const present = new Set(installed);
  return candidates.find(name => present.has(name));
}

export type ReplyAudioOptions = {
  enabled?: boolean;
  sayBin?: string;
  ffmpegBin?: string;
  /** Forces one voice by name. Unset, the best installed candidate is chosen once. */
  voice?: string;
  rate?: number;
  spawn?: Spawn;
  exists?: (path: string) => boolean;
  tmpRoot?: string;
  maxBase64?: number;
  /** Reported when a render or an encode fails, so a host can surface it once. */
  log?: (message: string) => void;
};

export function createReplyAudioSynthesizer(options: ReplyAudioOptions = {}): ReplyAudioSynthesizer {
  const spawn = (options.spawn ?? nodeSpawn) as Spawn;
  const exists = options.exists ?? existsExecutable;
  const enabled = options.enabled !== false;
  const sayBin = resolveBin(options.sayBin, DEFAULT_SAY_BINS, exists);
  const ffmpegBin = resolveBin(options.ffmpegBin, DEFAULT_FFMPEG_BINS, exists);
  const tmpRoot = options.tmpRoot ?? tmpdir();
  const maxBase64 = Number.isSafeInteger(options.maxBase64) && options.maxBase64! > 0 ? options.maxBase64! : REPLY_AUDIO_MAX_BASE64;
  const rate = Number.isFinite(options.rate) && options.rate! >= 90 && options.rate! <= 320
    ? Math.round(options.rate!) : REPLY_AUDIO_DEFAULT_RATE;
  const ready = Boolean(enabled && sayBin && ffmpegBin);
  const log = options.log ?? ((message: string) => console.error(message));

  // The voice list costs a process, so it is read once, on the first reply,
  // and only when the caller did not name a voice.
  let chosenVoice: string | undefined = options.voice?.trim() || undefined;
  let voiceResolved = Boolean(chosenVoice);
  const resolveVoice = async () => {
    if (voiceResolved) return chosenVoice;
    voiceResolved = true;
    const listing = await runProcess(spawn, sayBin!, ['-v', '?'], REPLY_AUDIO_VOICE_LIST_TIMEOUT_MS);
    if (listing.code !== 0) return chosenVoice;
    chosenVoice = chooseReplyVoice(parseSayVoices(listing.stdout));
    return chosenVoice;
  };

  return {
    ready,
    enabled,
    describe() {
      if (!enabled) return 'Headset reply audio: off.';
      if (!sayBin) return `Headset reply audio: unavailable, no macOS say binary (set ${REPLY_AUDIO_SAY_BIN_ENV}).`;
      if (!ffmpegBin) return `Headset reply audio: unavailable, no ffmpeg (set ${FFMPEG_BIN_ENV}).`;
      return `Headset reply audio: ready, Opus at ${REPLY_AUDIO_BITRATE}${chosenVoice ? `, voice ${chosenVoice}` : ''}.`;
    },
    async synthesize(text: string) {
      if (!ready) return undefined;
      const line = typeof text === 'string' ? text.trim() : '';
      if (!line || line.length > REPLY_AUDIO_MAX_CHARS) return undefined;
      let workspace: string | undefined;
      try {
        workspace = await mkdtemp(join(tmpRoot, 'stereofold-reply-'));
        const scriptPath = join(workspace, 'reply.txt');
        const aiffPath = join(workspace, 'reply.aiff');
        const oggPath = join(workspace, 'reply.ogg');
        // Text reaches `say` as a file, never as argv, so no reply can be read
        // as an option and no shell ever sees the sentence.
        await writeFile(scriptPath, line, { encoding: 'utf8', mode: FILE_MODE });
        const voice = await resolveVoice();
        const rendered = await runProcess(spawn, sayBin!,
          [...(voice ? ['-v', voice] : []), '-r', String(rate), '-f', scriptPath, '-o', aiffPath],
          REPLY_AUDIO_SAY_TIMEOUT_MS);
        if (rendered.code !== 0) {
          log(`Headset reply audio: say failed. ${rendered.timedOut ? 'Timed out.' : rendered.stderr.trim().slice(0, 200)}`);
          return undefined;
        }
        const encoded = await runProcess(spawn, ffmpegBin!,
          ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', aiffPath,
            '-t', String(HEADSET_SPEECH_MAX_SECONDS), '-ac', '1', '-ar', String(REPLY_AUDIO_SAMPLE_RATE),
            '-c:a', 'libopus', '-b:a', REPLY_AUDIO_BITRATE, '-vbr', 'on', '-application', 'voip', oggPath],
          REPLY_AUDIO_ENCODE_TIMEOUT_MS);
        if (encoded.code !== 0) {
          log(`Headset reply audio: ffmpeg failed. ${encoded.timedOut ? 'Timed out.' : encoded.stderr.trim().slice(0, 200)}`);
          return undefined;
        }
        const bytes = await readFile(oggPath);
        if (!bytes.byteLength) return undefined;
        const base64 = bytes.toString('base64');
        // A clip past the inline ceiling is dropped rather than truncated: half
        // a sentence is worse than a caption the wearer reads.
        if (base64.length > maxBase64) {
          log(`Headset reply audio: clip of ${bytes.byteLength} bytes exceeds the inline limit.`);
          return undefined;
        }
        const seconds = oggOpusSeconds(bytes);
        return { base64, mimeType: REPLY_AUDIO_MIME, format: REPLY_AUDIO_FORMAT, bytes: bytes.byteLength,
          ...(voice ? { voice } : {}), ...(seconds ? { seconds } : {}) };
      } catch (error) {
        log(`Headset reply audio: ${error instanceof Error ? error.message.slice(0, 200) : 'render failed'}`);
        return undefined;
      } finally {
        if (workspace) await rm(workspace, { recursive: true, force: true }).catch(() => { /* A temp directory that survives is reaped by the OS. */ });
      }
    },
  };
}

/** The host's default synthesiser. `STEREOFOLD_REPLY_AUDIO=0` turns it off. */
export function replyAudioFromEnv(env: NodeJS.ProcessEnv = process.env): ReplyAudioSynthesizer {
  const flag = (env[REPLY_AUDIO_ENABLED_ENV] ?? '').trim().toLowerCase();
  const rate = Number.parseInt((env[REPLY_AUDIO_RATE_ENV] ?? '').trim(), 10);
  return createReplyAudioSynthesizer({
    enabled: flag !== '0' && flag !== 'false' && flag !== 'off',
    sayBin: env[REPLY_AUDIO_SAY_BIN_ENV],
    ffmpegBin: env[FFMPEG_BIN_ENV],
    voice: env[REPLY_AUDIO_VOICE_ENV],
    ...(Number.isFinite(rate) ? { rate } : {}),
  });
}
