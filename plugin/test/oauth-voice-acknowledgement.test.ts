import { describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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

/** Real helper processes, with generation and teardown separated by a gate. */
async function withCompletionHelper(mode: 'ready' | 'ready-late-failure' | 'legacy' | 'failed' | 'bad-digest' | 'unfinished',
  body: (fixture: { options: { env: NodeJS.ProcessEnv; config: {} }; release: () => Promise<void>;
    output: () => Promise<string>; root: string }) => Promise<void>, exitFast = false) {
  const root = await mkdtemp(join(tmpdir(), 'voice-completion-test-'));
  const helperPath = join(root, 'agent-voice');
  const releasePath = join(root, 'release');
  const startedPath = join(root, 'started.json');
  await writeFile(helperPath, `#!${process.execPath}
const fs = require('node:fs');
const crypto = require('node:crypto');
const args = process.argv.slice(2);
const output = args[args.indexOf('--out') + 1];
const ready = process.env.STEREOFOLD_AGENT_VOICE_READY_FILE;
const mode = ${JSON.stringify(mode)};
const wav = Buffer.alloc(46);
wav.write('RIFF'); wav.writeUInt32LE(38, 4); wav.write('WAVE', 8);
fs.writeFileSync(output, wav);
fs.writeFileSync(${JSON.stringify(startedPath)}, JSON.stringify({ output }));
if (mode === 'failed') { process.stderr.write('Injected generation failure'); process.exit(1); }
if (mode !== 'legacy') {
  const receipt = { version: 1, status: mode === 'unfinished' ? 'generating' : 'completed',
    bytes: wav.length, sha256: mode === 'bad-digest' ? '0'.repeat(64) : crypto.createHash('sha256').update(wav).digest('hex') };
  fs.writeFileSync(ready + '.tmp', JSON.stringify(receipt)); fs.renameSync(ready + '.tmp', ready);
}
if (${exitFast}) process.exit(mode === 'ready-late-failure' ? 1 : 0);
const timer = setInterval(() => {
  if (fs.existsSync(${JSON.stringify(releasePath)})) { clearInterval(timer); process.exit(mode === 'ready-late-failure' ? 1 : 0); }
}, 10);
// A failed test must never leave a helper behind.
setTimeout(() => process.exit(2), 5000).unref();
`, { mode: 0o700 });
  await chmod(helperPath, 0o700);
  const release = () => writeFile(releasePath, 'done');
  const output = async () => {
    await vi.waitFor(() => expect(existsSync(startedPath)).toBe(true));
    return JSON.parse(await readFile(startedPath, 'utf8')).output as string;
  };
  try { await body({ options: { env: { [AGENT_VOICE_BIN_ENV]: helperPath }, config: {} }, release, output, root }); }
  finally {
    await release();
    // The adapter owns this directory; retain the release gate until it has
    // reaped the helper and removed the input files even after an early result.
    if (existsSync(startedPath)) {
      const path = JSON.parse(await readFile(startedPath, 'utf8')).output as string;
      await vi.waitFor(() => expect(existsSync(path)).toBe(false), { timeout: 6000 });
    }
    await rm(root, { recursive: true, force: true });
  }
}

describe('OAuth completed-audio handoff', () => {
  it.each(['ready', 'ready-late-failure'] as const)('returns verified complete speech before teardown and observes %s exit', async mode => {
    await withCompletionHelper(mode, async ({ options, release, output }) => {
      let result: { wavBase64: string } | undefined;
      const speech = synthesizeOAuthSpeech('Ready.', options).then(value => { result = value; return value; });
      const path = await output();
      await vi.waitFor(() => expect(result).toBeDefined());
      expect(Buffer.from((await speech).wavBase64, 'base64')).toEqual(await readFile(path));
      expect(existsSync(path)).toBe(true);
      await release();
      await vi.waitFor(() => expect(existsSync(path)).toBe(false));
    });
  });

  it('waits for successful exit from an older helper that publishes no receipt', async () => {
    await withCompletionHelper('legacy', async ({ options, release, output }) => {
      let resolved = false;
      const speech = synthesizeOAuthSpeech('Ready.', options).then(value => { resolved = true; return value; });
      await output();
      // A complete-looking WAV alone is not permission to return early.
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(resolved).toBe(false);
      await release();
      expect((await speech).wavBase64).toBeTruthy();
    });
  });

  it('preserves a helper failure even when it left a WAV behind', async () => {
    await withCompletionHelper('failed', async ({ options }) => {
      await expect(synthesizeOAuthSpeech('Ready.', options)).rejects.toThrow('Injected generation failure');
    });
  });

  it.each(['ready', 'legacy', 'ready-late-failure'] as const)('accepts %s audio from a helper that exits immediately', async mode => {
    await withCompletionHelper(mode, async ({ options }) => {
      expect((await synthesizeOAuthSpeech('Ready.', options)).wavBase64).toBeTruthy();
    }, true);
  });

  it.each([
    ['bad-digest', false], ['unfinished', false], ['bad-digest', true], ['unfinished', true],
  ] as const)('refuses a %s completion receipt (immediate exit: %s)', async (mode, exitFast) => {
    await withCompletionHelper(mode, async ({ options, release }) => {
      await expect(synthesizeOAuthSpeech('Ready.', options)).rejects.toThrow(/completion receipt/);
      await release();
    }, exitFast);
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
