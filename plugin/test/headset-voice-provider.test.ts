import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { replyAudioFromEnv, replyVoiceProvider } from '../src/headset-voice-provider.js';
import { forgetLocalConfig, LOCAL_CONFIG_ENV } from '../src/local-helper-config.js';

describe('headset reply provider selection', () => {
  let directory: string;
  let configPath: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'stereofold-voice-provider-'));
    configPath = join(directory, 'config.json');
    env = { [LOCAL_CONFIG_ENV]: configPath };
  });
  afterEach(() => {
    forgetLocalConfig();
    rmSync(directory, { recursive: true, force: true });
  });

  it('defaults to OAuth even when a system voice is configured', () => {
    expect(replyVoiceProvider(env)).toBe('oauth');
    expect(replyVoiceProvider({ ...env, STEREOFOLD_REPLY_VOICE: 'Samantha' })).toBe('oauth');
  });
  it.each(['oauth', 'system', ' SYSTEM '])('selects %s from the config key alone', provider => {
    writeFileSync(configPath, JSON.stringify({ replyVoiceProvider: provider }));
    expect(replyVoiceProvider(env)).toBe(provider.trim().toLowerCase());
  });
  it.each([
    ['system', 'oauth'],
    ['oauth', 'system'],
    ['invalid', 'system'],
  ])('overrides config %s with environment %s', (configured, provider) => {
    writeFileSync(configPath, JSON.stringify({ replyVoiceProvider: configured }));
    expect(replyVoiceProvider({ ...env, STEREOFOLD_REPLY_VOICE_PROVIDER: provider })).toBe(provider);
  });
  it('ignores a blank environment setting like other local config lookups', () => {
    writeFileSync(configPath, JSON.stringify({ replyVoiceProvider: 'system' }));
    expect(replyVoiceProvider({ ...env, STEREOFOLD_REPLY_VOICE_PROVIDER: ' ' })).toBe('system');
  });
  it('reports an invalid config value with the key, file, and received value', () => {
    writeFileSync(configPath, JSON.stringify({ replyVoiceProvider: 'api' }));
    expect(() => replyVoiceProvider(env)).toThrow(
      `replyVoiceProvider in ${configPath} must be oauth or system; received api.`,
    );
  });
  it('keeps OAuth as the default when the config has no provider key', () => {
    writeFileSync(configPath, '{}');
    expect(replyVoiceProvider(env)).toBe('oauth');
  });
  it('requires explicit system voice selection', () => {
    expect(replyVoiceProvider({ ...env, STEREOFOLD_REPLY_VOICE_PROVIDER: 'system' })).toBe('system');
  });
  it('does not interpret an unconfigured API route as a fallback', () => {
    expect(() => replyVoiceProvider({ ...env, STEREOFOLD_REPLY_VOICE_PROVIDER: 'api' })).toThrow('API voice is not configured');
  });
  it('keeps the no-speech setting on the OAuth route without generating audio', async () => {
    const voice = replyAudioFromEnv({ ...env, STEREOFOLD_REPLY_AUDIO: '0' });
    expect(voice.enabled).toBe(false);
    await expect(voice.synthesize('Hello.')).resolves.toBeUndefined();
  });
});
