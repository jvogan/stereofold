import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { voiceAudioSchema, type VoiceTranscriber } from './inspection-voice.js';
import {
  PYTHON3_CONFIG_KEY, executable, findOnPath, helperSearchAdvice, readLocalConfig, type LocalConfig,
} from './local-helper-config.js';

export const OAUTH_VOICE_TIMEOUT_MS = 45_000;
export const OAUTH_VOICE_MAX_AUDIO_BYTES = 576_000;
/** An absolute Python 3, for a Mac that keeps its own outside the usual places. */
export const PYTHON3_BIN_ENV = 'STEREOFOLD_PYTHON3_BIN';
export { PYTHON3_CONFIG_KEY };
// Match the established `agent-voice` interpreter on this Mac. It carries the
// `websockets` dependency used by the OAuth-only helper; /usr/bin/python3 does
// not, so it is intentionally not preferred just because it is present.
const PYTHONS = ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3'] as const;
/** The transcription helper, beside this module in the checkout and the bundle. */
export const TRANSCRIBE_SCRIPT = fileURLToPath(new URL('../assets/oauth-transcribe.py', import.meta.url));

type Spawn = (command: string, args: readonly string[], options: { shell: false; stdio: ['pipe', 'pipe', 'pipe']; windowsHide: true }) => ChildProcess;

export type PythonLookup = {
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
  config?: LocalConfig;
  home?: string;
};

/**
 * The Python 3 this host transcribes with, or nothing when it has none.
 *
 * This used to be a default parameter of `createOAuthVoiceTranscriber`, which
 * meant it ran while the MCP server was registering its tools. A Mac without
 * Python therefore could not start the viewer at all: the process threw during
 * registration and every tool went with it, including the ones that only draw
 * molecules. Voice is optional, so this answer is now read at the moment the
 * microphone is used and never before.
 */
export function findPython3({ env = process.env, exists = executable, config, home }: PythonLookup = {}): string | undefined {
  const named = (env[PYTHON3_BIN_ENV] ?? '').trim();
  if (named) {
    if (!isAbsolute(named)) throw Error(`${PYTHON3_BIN_ENV} must be an absolute path; received ${named}.`);
    return named;
  }
  const settings = config ?? readLocalConfig({ env, ...(home === undefined ? {} : { home }) });
  const configured = (settings[PYTHON3_CONFIG_KEY] ?? '').trim();
  if (configured) {
    if (!isAbsolute(configured)) throw Error(`${PYTHON3_CONFIG_KEY} must be an absolute path; received ${configured}.`);
    return configured;
  }
  return PYTHONS.find(exists) ?? findOnPath('python3', env, exists);
}

/** One sentence saying voice recognition is off and how to turn it on. */
export function missingPython3Message(env: NodeJS.ProcessEnv = process.env, home?: string): string {
  return `Voice recognition is off: no Python 3 was found on this Mac. ${helperSearchAdvice('python3', PYTHON3_BIN_ENV, PYTHON3_CONFIG_KEY, env, home)}`;
}

/** The helper script ships as source, so it is read rather than executed. */
function defaultReadable(path: string): boolean {
  try { accessSync(path, constants.R_OK); return true; } catch { return false; }
}

/** The interpreter for one request, or the disabled sentence as an error. */
function oauthTranscriberPython(lookup: PythonLookup): string {
  const python = findPython3(lookup);
  if (!python) throw Error(missingPython3Message(lookup.env ?? process.env, lookup.home));
  return python;
}

/**
 * Whether this Mac can transcribe, and why not when it cannot. Callers use it
 * to print a readiness line without spawning anything.
 */
export function oauthTranscriptionState(options: PythonLookup & { script?: string; scriptExists?: (path: string) => boolean } = {}): { ready: boolean; reason?: string; python?: string } {
  const exists = options.exists ?? executable;
  const readable = options.scriptExists ?? defaultReadable;
  const env = options.env ?? process.env;
  let python: string | undefined;
  try { python = findPython3(options); }
  catch (error) { return { ready: false, reason: error instanceof Error ? error.message : missingPython3Message(env, options.home) }; }
  if (!python) return { ready: false, reason: missingPython3Message(env, options.home) };
  if (!exists(python)) return { ready: false, reason: `Voice recognition is off: ${python} is not executable. ${helperSearchAdvice('python3', PYTHON3_BIN_ENV, PYTHON3_CONFIG_KEY, env, options.home)}`, python };
  const script = options.script ?? TRANSCRIBE_SCRIPT;
  if (!readable(script)) return { ready: false, reason: `Voice recognition is off: the transcription helper is missing at ${script}. Reinstall the plugin to restore it.`, python };
  return { ready: true, python };
}

function decodePcm(base64: string, durationMs: number) {
  if (base64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw Error('Voice audio encoding is invalid.');
  const bytes = Buffer.from(base64, 'base64');
  if (!bytes.length || bytes.length > OAUTH_VOICE_MAX_AUDIO_BYTES || bytes.length % 2 || bytes.toString('base64') !== base64) {
    throw Error('Voice audio is invalid or exceeds the 12-second limit.');
  }
  const expected = Math.round(durationMs * 24_000 * 2 / 1_000);
  if (Math.abs(bytes.length - expected) > 4_096) throw Error('Voice audio duration does not match its PCM payload.');
  return bytes;
}

/**
 * A one-shot subprocess. It reads PCM on stdin and returns only transcript text.
 *
 * Building one of these touches nothing on disk. The interpreter is looked for
 * when audio actually arrives, so a Mac with no Python still registers every
 * tool and starts normally; the first spoken request is where it learns that
 * recognition is off, and it is told which setting turns it on.
 */
export function createOAuthVoiceTranscriber({ spawn = nodeSpawn as unknown as Spawn, timeoutMs = OAUTH_VOICE_TIMEOUT_MS,
  python, script = TRANSCRIBE_SCRIPT, env, exists, config, home }: {
    spawn?: Spawn; timeoutMs?: number; python?: string; script?: string;
  } & PythonLookup = {}): VoiceTranscriber {
  if (typeof spawn !== 'function' || !Number.isFinite(timeoutMs) || timeoutMs < 1
    || (python !== undefined && (typeof python !== 'string' || !python.startsWith('/')))
    || typeof script !== 'string' || !script.startsWith('/')) {
    throw TypeError('OAuth transcription requires absolute helper paths and a valid bounded subprocess.');
  }
  const lookup: PythonLookup = { ...(env === undefined ? {} : { env }), ...(exists === undefined ? {} : { exists }),
    ...(config === undefined ? {} : { config }), ...(home === undefined ? {} : { home }) };
  return async raw => {
    const audio = voiceAudioSchema.parse(raw), pcm = decodePcm(audio.pcm16leBase64, audio.durationMs);
    // The caller's audio is checked before this Mac is, so a malformed clip is
    // never reported as a missing installation.
    const interpreter = python ?? oauthTranscriberPython(lookup);
    return new Promise<string>((resolve, reject) => {
      let child: ChildProcess;
      try { child = spawn(interpreter, [script], { shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); }
      catch { reject(Error('OAuth transcription could not start.')); return; }
      let stdout = '', stderr = '', settled = false;
      const finish = (error?: Error, text?: string) => {
        if (settled) return; settled = true; clearTimeout(timer);
        if (error) reject(error); else resolve(text!);
      };
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} finish(Error('OAuth transcription timed out.')); }, timeoutMs);
      child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', chunk => { if (stdout.length <= 4096) stdout += String(chunk); });
      child.stderr?.on('data', chunk => { if (stderr.length <= 4096) stderr += String(chunk); });
      child.on('error', () => finish(Error('OAuth transcription could not start.')));
      child.on('close', code => {
        if (settled) return;
        if (code !== 0) { finish(Error(`OAuth transcription failed${stderr ? `: ${stderr.trim().slice(0, 1200)}` : '.'}`)); return; }
        try {
          const value = JSON.parse(stdout);
          if (!value || typeof value.transcript !== 'string' || value.transcript.length > 2_000) throw Error();
          finish(undefined, value.transcript);
        } catch { finish(Error('OAuth transcription returned an invalid response.')); }
      });
      child.stdin?.on('error', () => finish(Error('OAuth transcription could not receive audio.')));
      child.stdin?.end(pcm);
    });
  };
}
