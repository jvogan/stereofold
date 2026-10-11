import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { DEFAULT_SAY_BINS, REPLY_AUDIO_SAY_BIN_ENV, REPLY_AUDIO_VOICE_ENV, replyAudioFromEnv as systemReplyAudioFromEnv,
  type ReplyAudioSynthesizer } from './headset-reply-audio.js';
import { createOAuthReplyAudioSynthesizer } from './oauth-headset-reply-audio.js';
import { oauthVoiceAcknowledgement, VOICE_ACK_MAX_CHARS } from './oauth-voice-acknowledgement.js';
import { readLocalConfig, REPLY_VOICE_PROVIDER_CONFIG_KEY, safeConfigName } from './local-helper-config.js';

const execFileAsync = promisify(execFile);

/**
 * The short line a page speaks once it has drawn something ("Spinning.", a
 * tour chapter), through the same provider as replies. It used to be OAuth
 * whatever the provider said, so a Mac set to the system voice showed its
 * wearer a setup sentence instead of speaking.
 */
export function voiceAcknowledgementFromEnv(env: NodeJS.ProcessEnv = process.env) {
  return (message: string): Promise<{ wavBase64: string }> => replyVoiceProvider(env) === 'system'
    ? systemVoiceAcknowledgement(message, env[REPLY_AUDIO_SAY_BIN_ENV]?.trim() || undefined, env[REPLY_AUDIO_VOICE_ENV]?.trim() || undefined)
    : oauthVoiceAcknowledgement(message, { env });
}

/** `say` writes WAV itself, so this route needs neither the OAuth helper nor ffmpeg. */
export async function systemVoiceAcknowledgement(message: string, sayBin: string = DEFAULT_SAY_BINS[0]!, voice?: string): Promise<{ wavBase64: string }> {
  if (typeof message !== 'string' || !message.trim() || message.length > VOICE_ACK_MAX_CHARS || /[\0\r\n]/.test(message)) {
    throw Error('Voice acknowledgement text must be one short line.');
  }
  const directory = await mkdtemp(join(tmpdir(), 'stereofold-say-'));
  // Read from a file, so a line that starts with "-" is never taken for an option.
  const script = join(directory, 'line.txt'), output = join(directory, 'line.wav');
  try {
    await writeFile(script, message.trim(), { mode: 0o600 });
    await execFileAsync(sayBin, [...(voice ? ['-v', voice] : []), '-f', script, '-o', output, '--file-format=WAVE', '--data-format=LEI16@22050'],
      { timeout: 20_000, maxBuffer: 8_192, windowsHide: true });
    const wav = await readFile(output);
    if (wav.byteLength < 44 || wav.byteLength > 1_500_000 || wav.subarray(0, 4).toString('ascii') !== 'RIFF') throw Error('The system voice returned invalid audio.');
    return { wavBase64: wav.toString('base64') };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export const REPLY_VOICE_PROVIDER_ENV = 'STEREOFOLD_REPLY_VOICE_PROVIDER';

/** Provider choice is explicit; a failed OAuth request never changes providers. */
export function replyVoiceProvider(env: NodeJS.ProcessEnv = process.env): 'oauth' | 'system' {
  const named = (env[REPLY_VOICE_PROVIDER_ENV] ?? '').trim();
  const configured = named ? '' : (readLocalConfig({ env })[REPLY_VOICE_PROVIDER_CONFIG_KEY] ?? '').trim();
  const provider = (named || configured || 'oauth').toLowerCase();
  if (provider === 'oauth' || provider === 'system') return provider;
  if (!named) {
    throw Error(`${REPLY_VOICE_PROVIDER_CONFIG_KEY} in ${safeConfigName(env)} must be oauth or system; received ${configured}.`);
  }
  throw Error(`${REPLY_VOICE_PROVIDER_ENV} must be oauth or system. API voice is not configured.`);
}

export function replyAudioFromEnv(env: NodeJS.ProcessEnv = process.env): ReplyAudioSynthesizer {
  if (replyVoiceProvider(env) === 'system') return systemReplyAudioFromEnv(env);
  const flag = (env.STEREOFOLD_REPLY_AUDIO ?? '').trim().toLowerCase();
  return createOAuthReplyAudioSynthesizer({
    enabled: !['0', 'false', 'off'].includes(flag),
    ffmpegBin: env.STEREOFOLD_FFMPEG_BIN,
    // The narration helper is named in this environment, not in the host
    // process's own, so a filtered child environment still finds it.
    env,
  });
}
