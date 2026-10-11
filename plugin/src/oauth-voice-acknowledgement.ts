import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  AGENT_VOICE_CONFIG_KEY, executable, findHelper, helperSearchAdvice, type LocalConfig,
} from './local-helper-config.js';

/**
 * Where the OAuth narration helper lives, and how any Mac names its own.
 *
 * The path used to be a constant compiled into this module, which made the
 * OAuth voice route work on exactly one machine: any other host reached
 * `execFile` with a path that does not exist and got a bare `ENOENT` naming a
 * stranger's home directory. Then one machine's own path became the default,
 * which is the same bug with a nicer error.
 *
 * There is no default now. The helper is discovered: the environment variable
 * first, then the local config file a setup step can write, then PATH. A Mac
 * that has none of the three gets one sentence naming all of them, and every
 * other feature still works.
 */
export const AGENT_VOICE_BIN_ENV = 'STEREOFOLD_AGENT_VOICE_BIN';
/** The program that is looked for on PATH, and the name used in messages. */
export const AGENT_VOICE_BIN_NAME = 'agent-voice';
export { AGENT_VOICE_CONFIG_KEY };
/** Named here rather than imported, because the provider module imports this one. */
const REPLY_VOICE_PROVIDER_ENV = 'STEREOFOLD_REPLY_VOICE_PROVIDER';
const execFileAsync = promisify(execFile);
export const VOICE_ACK_MAX_CHARS = 180;
export const OAUTH_SPEECH_MAX_CHARS = 280;
export const OAUTH_SPEECH_INSTRUCTIONS = 'Read the supplied script word for word. This is a recording, not a conversation. Speak only the exact script text, without acknowledgement, substitution, introduction, or extra words.';

export type OAuthSpeechOptions = {
  env?: NodeJS.ProcessEnv;
  /** Test seam; defaults to an executable-bit check on the resolved path. */
  exists?: (path: string) => boolean;
  /** Test seam; defaults to the local config file this host reads. */
  config?: LocalConfig;
  /** Test seam; defaults to the current user's home directory. */
  home?: string;
};

/**
 * The helper this host narrates with, or nothing when this Mac has none.
 *
 * A path the user named is returned whether or not it exists, so the caller
 * can say "not executable at <path>" and the user can see their own typo. A
 * relative setting is refused rather than resolved against whatever directory
 * the host happened to start in.
 */
export function agentVoiceBin(env: NodeJS.ProcessEnv = process.env, options: Omit<OAuthSpeechOptions, 'env'> = {}): string | undefined {
  return findHelper({
    name: AGENT_VOICE_BIN_NAME, envName: AGENT_VOICE_BIN_ENV, configKey: AGENT_VOICE_CONFIG_KEY,
    env, ...(options.home === undefined ? {} : { home: options.home }),
    ...(options.exists === undefined ? {} : { exists: options.exists }),
    ...(options.config === undefined ? {} : { config: options.config }),
  })?.path;
}

/**
 * One sentence that names every way out: point at the helper, install it on
 * PATH, write it into the config, or stop using this route entirely.
 *
 * `path` is the helper the user named and this Mac cannot run. Leave it out
 * when nothing was named at all.
 */
export function missingAgentVoiceMessage(path?: string, env: NodeJS.ProcessEnv = process.env, home?: string): string {
  const advice = helperSearchAdvice(AGENT_VOICE_BIN_NAME, AGENT_VOICE_BIN_ENV, AGENT_VOICE_CONFIG_KEY, env, home);
  const escape = `Or set ${REPLY_VOICE_PROVIDER_ENV}=system to speak with /usr/bin/say instead.`;
  return path
    ? `The OAuth voice helper is not executable at ${path}. ${advice} ${escape}`
    : `Voice replies are off: no ${AGENT_VOICE_BIN_NAME} helper was found on this Mac. ${advice} ${escape}`;
}

/**
 * Produce one short acknowledgement after a renderer receipt. This deliberately
 * delegates to the external OAuth-only speech helper; it neither
 * reads credentials nor falls back to an API key or browser synthesizer.
 */
export async function oauthVoiceAcknowledgement(message: string, options: OAuthSpeechOptions = {}): Promise<{ wavBase64: string }> {
  if (typeof message !== 'string' || !message.trim() || message.length > VOICE_ACK_MAX_CHARS || /[\0\r\n]/.test(message)) {
    throw Error('Voice acknowledgement text must be one short line.');
  }
  return synthesizeOAuthSpeech(message, options);
}

/** Shared OAuth narration for both direct commands and the standalone reply queue. */
export async function synthesizeOAuthSpeech(message: string, options: OAuthSpeechOptions = {}): Promise<{ wavBase64: string }> {
  if (typeof message !== 'string' || !message.trim() || message.length > OAUTH_SPEECH_MAX_CHARS || /[\0\r\n]/.test(message)) {
    throw Error('OAuth speech text must be one line of at most 280 characters.');
  }
  const env = options.env ?? process.env;
  const agentVoice = agentVoiceBin(env, options);
  // Ask before spawning, so a host without the helper reads one sentence that
  // names every setting rather than an `ENOENT` on somebody else's path.
  if (!agentVoice) throw Error(missingAgentVoiceMessage(undefined, env, options.home));
  if (!(options.exists ?? executable)(agentVoice)) throw Error(missingAgentVoiceMessage(agentVoice, env, options.home));
  const directory = await mkdtemp(join(tmpdir(), 'stereofold-voice-'));
  const input = join(directory, 'input.txt'), directions = join(directory, 'directions.txt'), output = join(directory, 'reply.wav');
  try {
    await writeFile(input, message.trim(), { mode: 0o600 });
    await writeFile(directions, OAUTH_SPEECH_INSTRUCTIONS, { mode: 0o600 });
    await execFileAsync(agentVoice, ['--input-file', input, '--instructions-file', directions, '--voice', 'marin', '--speed', '1', '--out', output],
      { timeout: 45_000, maxBuffer: 8_192, windowsHide: true });
    const wav = await readFile(output);
    if (wav.byteLength < 44 || wav.byteLength > 1_500_000 || wav.subarray(0, 4).toString('ascii') !== 'RIFF') throw Error('OAuth voice returned invalid audio.');
    return { wavBase64: wav.toString('base64') };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
