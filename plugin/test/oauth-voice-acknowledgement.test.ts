import { describe, expect, it } from 'vitest';
import {
  AGENT_VOICE_BIN_ENV, AGENT_VOICE_BIN_NAME, AGENT_VOICE_CONFIG_KEY, agentVoiceBin,
  missingAgentVoiceMessage, oauthVoiceAcknowledgement, synthesizeOAuthSpeech,
} from '../src/oauth-voice-acknowledgement.js';

const absent = () => false;
/** No config file and no PATH: the state a Mac that never set voice up is in. */
const bare = { config: {}, home: '/nonexistent-home', exists: absent };

describe('OAuth narration helper resolution', () => {
  it('finds nothing on a Mac that has no helper, and names no home directory', () => {
    expect(agentVoiceBin({}, bare)).toBeUndefined();
    expect(agentVoiceBin({ [AGENT_VOICE_BIN_ENV]: '   ' }, bare)).toBeUndefined();
    // The message a user reads must not contain anybody's home directory.
    expect(missingAgentVoiceMessage(undefined, {}, '/nonexistent-home')).not.toContain('/Users/');
  });

  it('takes an absolute helper path from the environment', () => {
    expect(agentVoiceBin({ [AGENT_VOICE_BIN_ENV]: '/opt/homebrew/bin/agent-voice' }, bare)).toBe('/opt/homebrew/bin/agent-voice');
    // A host that exports it with surrounding whitespace still resolves.
    expect(agentVoiceBin({ [AGENT_VOICE_BIN_ENV]: ' /usr/local/bin/agent-voice ' }, bare)).toBe('/usr/local/bin/agent-voice');
  });

  it('takes the helper from the local config when nothing is exported', () => {
    expect(agentVoiceBin({}, { ...bare, config: { [AGENT_VOICE_CONFIG_KEY]: '/opt/local/bin/agent-voice' } }))
      .toBe('/opt/local/bin/agent-voice');
  });

  it('finds the helper on PATH when neither the environment nor the config names one', () => {
    const found = agentVoiceBin({ PATH: '/first:/second' }, {
      config: {}, home: '/nonexistent-home',
      exists: path => path === `/second/${AGENT_VOICE_BIN_NAME}`,
    });
    expect(found).toBe('/second/agent-voice');
  });

  it('prefers an exported path over PATH, so a user setting is never overruled', () => {
    const found = agentVoiceBin({ PATH: '/second', [AGENT_VOICE_BIN_ENV]: '/opt/homebrew/bin/agent-voice' }, {
      config: {}, home: '/nonexistent-home', exists: () => true,
    });
    expect(found).toBe('/opt/homebrew/bin/agent-voice');
  });

  it('refuses a relative helper path rather than resolving it against the working directory', () => {
    expect(() => agentVoiceBin({ [AGENT_VOICE_BIN_ENV]: 'bin/agent-voice' }, bare)).toThrow(AGENT_VOICE_BIN_ENV);
    expect(() => agentVoiceBin({ [AGENT_VOICE_BIN_ENV]: 'bin/agent-voice' }, bare)).toThrow('must be an absolute path');
    expect(() => agentVoiceBin({}, { ...bare, config: { [AGENT_VOICE_CONFIG_KEY]: 'bin/agent-voice' } }))
      .toThrow('must be an absolute path');
  });
});

describe('OAuth narration on a host without the helper', () => {
  it('names every setting and the system-voice escape, and never spawns', async () => {
    await expect(synthesizeOAuthSpeech('Thirteen protofilaments.', { env: {}, ...bare }))
      .rejects.toThrow('Voice replies are off');
    const failure = await synthesizeOAuthSpeech('Thirteen protofilaments.', { env: {}, ...bare }).catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(AGENT_VOICE_BIN_ENV);
    expect((failure as Error).message).toContain(AGENT_VOICE_CONFIG_KEY);
    expect((failure as Error).message).toContain('on PATH');
    expect((failure as Error).message).toContain('STEREOFOLD_REPLY_VOICE_PROVIDER=system');
    expect((failure as Error).message).toContain('/usr/bin/say');
  });

  it('reports the configured path when one was named and cannot run', async () => {
    const env = { [AGENT_VOICE_BIN_ENV]: '/opt/homebrew/bin/agent-voice' };
    await expect(synthesizeOAuthSpeech('Hello.', { env, ...bare }))
      .rejects.toThrow('/opt/homebrew/bin/agent-voice');
    await expect(oauthVoiceAcknowledgement('Spinning.', { env, ...bare }))
      .rejects.toThrow('/opt/homebrew/bin/agent-voice');
  });

  it('checks the text before it checks the Mac', async () => {
    // A malformed line is the caller's error wherever the helper lives, so it
    // must not be reported as a missing installation.
    await expect(synthesizeOAuthSpeech('x'.repeat(281), { env: {}, ...bare }))
      .rejects.toThrow('one line of at most 280 characters');
    await expect(oauthVoiceAcknowledgement('one\nline', { env: {}, ...bare }))
      .rejects.toThrow('one short line');
  });

  it('asks about the helper that the environment names', async () => {
    const asked: string[] = [];
    await synthesizeOAuthSpeech('Hello.', {
      env: { [AGENT_VOICE_BIN_ENV]: '/usr/local/bin/agent-voice' },
      config: {}, home: '/nonexistent-home',
      exists: path => { asked.push(path); return false; },
    }).catch(() => undefined);
    expect(asked).toEqual(['/usr/local/bin/agent-voice']);
  });
});
