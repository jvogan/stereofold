/**
 * Finding an optional helper on somebody else's Mac.
 *
 * Voice needs two programs this repository does not ship. They were once named
 * by an absolute path inside one person's home directory, so the voice route
 * worked on exactly one machine. These tests hold the replacement to its
 * contract: three places a user controls, in a fixed order, and an honest
 * disabled answer that names the setting when none of them has it.
 */
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AGENT_VOICE_CONFIG_KEY, LOCAL_CONFIG_ENV, PYTHON3_CONFIG_KEY,
  questDeviceIdleMs, findHelper, findOnPath, helperSearchAdvice, localConfigPath, safeConfigName,
} from '../src/local-helper-config.js';
import { AGENT_VOICE_BIN_ENV } from '../src/oauth-voice-acknowledgement.js';
import { PYTHON3_BIN_ENV, findPython3, missingPython3Message } from '../src/oauth-voice-transcription.js';

const pluginRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const nowhere = { config: {}, home: '/nonexistent-home', exists: () => false };

describe('the helper lookup', () => {
  it('reads the environment first, then the config, then PATH', () => {
    const lookup = { name: 'agent-voice', envName: AGENT_VOICE_BIN_ENV, configKey: AGENT_VOICE_CONFIG_KEY };
    expect(findHelper({ ...lookup, ...nowhere, env: { [AGENT_VOICE_BIN_ENV]: '/opt/a/agent-voice' } }))
      .toEqual({ path: '/opt/a/agent-voice', source: 'environment' });
    expect(findHelper({ ...lookup, ...nowhere, env: {}, config: { [AGENT_VOICE_CONFIG_KEY]: '/opt/b/agent-voice' } }))
      .toEqual({ path: '/opt/b/agent-voice', source: 'config' });
    expect(findHelper({ ...lookup, config: {}, home: '/nonexistent-home', env: { PATH: '/opt/c' }, exists: () => true }))
      .toEqual({ path: '/opt/c/agent-voice', source: 'path' });
  });

  it('returns the disabled state, naming the variable, when nothing is configured', () => {
    const lookup = { name: 'agent-voice', envName: AGENT_VOICE_BIN_ENV, configKey: AGENT_VOICE_CONFIG_KEY };
    expect(findHelper({ ...lookup, ...nowhere, env: { PATH: '/opt/c' } })).toBeUndefined();
    const advice = helperSearchAdvice('agent-voice', AGENT_VOICE_BIN_ENV, AGENT_VOICE_CONFIG_KEY, {}, '/nonexistent-home');
    expect(advice).toContain(AGENT_VOICE_BIN_ENV);
    expect(advice).toContain(AGENT_VOICE_CONFIG_KEY);
    expect(advice).toContain('on PATH');
  });

  it('finds nothing rather than guessing when Python is absent', () => {
    expect(findPython3({ env: { PATH: '/opt/c' }, ...nowhere })).toBeUndefined();
    const reason = missingPython3Message({ PATH: '' }, '/nonexistent-home');
    expect(reason).toContain(PYTHON3_BIN_ENV);
    expect(reason).toContain(PYTHON3_CONFIG_KEY);
  });

  it('skips relative PATH entries rather than resolving them against the working directory', () => {
    expect(findOnPath('agent-voice', { PATH: 'bin:./tools' }, () => true)).toBeUndefined();
    expect(findOnPath('agent-voice', { PATH: 'bin:/opt/c' }, () => true)).toBe('/opt/c/agent-voice');
  });

  it('keeps the config file under the user home, and lets a host move it', () => {
    expect(localConfigPath({}, '/home/anne')).toBe('/home/anne/.stereofold/config.json');
    expect(localConfigPath({ [LOCAL_CONFIG_ENV]: '/etc/stereofold.json' }, '/home/anne')).toBe('/etc/stereofold.json');
    expect(() => localConfigPath({ [LOCAL_CONFIG_ENV]: 'stereofold.json' }, '/home/anne')).toThrow('must be an absolute path');
    // A bad setting must not break the sentence that explains the setting.
    expect(safeConfigName({ [LOCAL_CONFIG_ENV]: 'stereofold.json' }, '/home/anne')).toBe('~/.stereofold/config.json');
  });
});

describe('the shipped source', () => {
  /** Every .ts file under a directory, without walking into node_modules. */
  async function sources(root: string): Promise<string[]> {
    const found: string[] = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const absolute = resolve(root, entry.name);
      if (entry.isDirectory()) found.push(...await sources(absolute));
      else if (/\.(?:ts|mts|mjs|js)$/.test(entry.name)) found.push(absolute);
    }
    return found;
  }

  it('names no personal home directory in src or scripts', async () => {
    const files = [...await sources(resolve(pluginRoot, 'src')), ...await sources(resolve(pluginRoot, 'scripts'))];
    expect(files.length).toBeGreaterThan(50);
    const offenders: string[] = [];
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      // `/Users/<someone>` and `~/.local/bin` are both somebody's machine, not
      // a product. Helpers are discovered, never assumed to sit in one home.
      if (/\/Users\/[A-Za-z0-9._-]+/.test(text) || /\.local\/bin/.test(text)) {
        offenders.push(file.slice(pluginRoot.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });
});


describe('remembered headset idle expiry config', () => {
  it('defaults to fourteen days and reads a positive day count from config', () => {
    expect(questDeviceIdleMs({})).toBe(14 * 86_400_000);
    expect(questDeviceIdleMs({ questDeviceIdleDays: '7' })).toBe(7 * 86_400_000);
    for (const value of ['', 'bad', '0', '-1', 'Infinity', '366']) {
      expect(questDeviceIdleMs({ questDeviceIdleDays: value })).toBe(14 * 86_400_000);
    }
  });
});
