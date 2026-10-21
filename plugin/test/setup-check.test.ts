/**
 * The setup check is the first thing a fresh agent runs, before any install,
 * so two things have to hold. It must name the settings the server actually
 * reads — a key the server never looks at is a setup that silently does
 * nothing — and every gap it reports must carry a command that closes it.
 */
import { mkdtemp, readFile, rm, stat, writeFile, mkdir, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AGENT_VOICE_CONFIG_KEY, LOCAL_CONFIG_ENV, LOCAL_CONFIG_FILE, PYTHON3_CONFIG_KEY,
  findOnPath as runtimeFindHelperOnPath,
} from '../src/local-helper-config.js';
import { AGENT_VOICE_BIN_ENV, AGENT_VOICE_BIN_NAME } from '../src/oauth-voice-acknowledgement.js';
import { PYTHON3_BIN_ENV } from '../src/oauth-voice-transcription.js';
import { DEFAULT_APPLESPEECH_BINS, DEFAULT_FFMPEG_BINS, DEFAULT_WHISPER_BINS,
  applespeechBinCandidates, ffmpegBinCandidates, whisperBinCandidates, TRANSCRIBER_ENV, transcriberKind } from '../src/push-to-talk-transcribe.js';
import { findAdb as runtimeFindAdb, findExecutable as runtimeFindExecutable } from '../src/headset-view-device.js';
import { OPENSSL_PATHS } from '../src/inspection-lan.js';
import { DEFAULT_FFMPEG_BINS as REPLY_FFMPEG_BINS } from '../src/headset-reply-audio.js';
import { fileURLToPath } from 'node:url';
import * as check from '../skills/stereofold-setup/scripts/setup-check.mjs';
import * as entry from '../scripts/setup-check.js';

const temporaries: string[] = [];
async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaries.push(path);
  return path;
}

afterEach(async () => {
  while (temporaries.length > 0) await rm(temporaries.pop() as string, { force: true, recursive: true });
});

describe('portable setup script entry points', () => {
  it.each(['setup-check.mjs', 'open-check.mjs'])('runs %s through a symlink instead of silently exiting', async name => {
    const directory = await temporaryDirectory('stereofold-entry-alias-');
    const entryPath = join(directory, name);
    await symlink(fileURLToPath(new URL(`../skills/stereofold-setup/scripts/${name}`, import.meta.url)), entryPath);
    const output = execFileSync(process.execPath, [entryPath, '--help'], { encoding: 'utf8', timeout: 10000 });
    expect(output).toMatch(/Usage:/u);
    expect(output).toContain(name);
  });
});

/** A machine with everything, which each case then takes one thing away from. */
function healthyFacts(overrides: Partial<check.Facts> = {}): check.Facts {
  return {
    platform: 'darwin', arch: 'arm64', kernel: '25.5.0',
    node: { version: '22.11.0', path: '/usr/local/bin/node', major: 22 },
    root: '/opt/stereofold', kind: 'release artifact', runtimeMissing: [],
    mcpEntry: 'node ./dist/server.mjs (cwd .)',
    configPath: '/home/someone/.stereofold/config.json', config: {},
    helpers: {
      python3: { name: 'python3', path: '/usr/bin/python3', source: 'PATH', ready: true },
      agentVoice: { name: 'agent-voice', path: '/usr/local/bin/agent-voice', source: 'PATH', ready: true },
    },
    tools: {
      pnpm: '/usr/local/bin/pnpm', npx: '/usr/local/bin/npx', git: '/usr/bin/git',
      openssl: '/usr/bin/openssl', ffmpeg: '/usr/local/bin/ffmpeg',
      cloudflared: '/usr/local/bin/cloudflared', adb: '/usr/local/bin/adb',
      'whisper-cli': '/usr/local/bin/whisper-cli',
      say: '/usr/bin/say', replyFfmpeg: '/usr/local/bin/ffmpeg',
    },
    applespeech: '/opt/stereofold/native/applespeech/bin/applespeech',
    whisperModel: '/opt/models/ggml-base.en.bin',
    transcriberSetting: undefined,
    lan: ['en0 192.168.77.20'],
    hosts: { markers: [], profiles: [] },
    ...overrides,
  };
}

describe('setup check settings', () => {
  it('names the exact keys and variables the server reads', () => {
    // A setup step that invented its own names would write a config file the
    // running server never consults, and the failure would look like a bug in
    // voice rather than a bug here.
    expect(check.PYTHON3_CONFIG_KEY).toBe(PYTHON3_CONFIG_KEY);
    expect(check.AGENT_VOICE_CONFIG_KEY).toBe(AGENT_VOICE_CONFIG_KEY);
    expect(check.PYTHON3_BIN_ENV).toBe(PYTHON3_BIN_ENV);
    expect(check.AGENT_VOICE_BIN_ENV).toBe(AGENT_VOICE_BIN_ENV);
    expect(check.AGENT_VOICE_BIN_NAME).toBe(AGENT_VOICE_BIN_NAME);
    expect(check.LOCAL_CONFIG_ENV).toBe(LOCAL_CONFIG_ENV);
    expect(check.LOCAL_CONFIG_FILE).toBe(LOCAL_CONFIG_FILE);
    expect(check.TRANSCRIBER_ENV).toBe(TRANSCRIBER_ENV);
  });

  it('exposes the same program through scripts/setup-check.ts', () => {
    // One implementation, two entry points: the `.mjs` runs on bare node
    // before any install, and this is the checkout-side name for it.
    expect(entry.run).toBe(check.run);
    expect(entry.discover).toBe(check.discover);
    expect(entry.REQUIRED_NODE_MAJOR).toBe(22);
  });

  it('puts the config beside the home directory, or wherever the variable points', () => {
    expect(check.localConfigPath({}, '/home/someone')).toBe('/home/someone/.stereofold/config.json');
    expect(check.localConfigPath({ STEREOFOLD_CONFIG: '/etc/stereofold.json' }, '/home/someone'))
      .toBe('/etc/stereofold.json');
    expect(() => check.localConfigPath({ STEREOFOLD_CONFIG: 'relative.json' }, '/home/someone'))
      .toThrow(/absolute/u);
  });
});

describe('runtime tool lookup parity', () => {
  const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/u, '');
  it.each(['', '/opt/custom/bin:/usr/local/bin:relative::/opt/custom/bin'])('copies the runtime candidate lists in order (PATH=%s)', PATH => {
    const env = { PATH };
    expect(check.OPENSSL_PATHS).toEqual(OPENSSL_PATHS);
    expect(check.DEFAULT_WHISPER_BINS).toEqual(DEFAULT_WHISPER_BINS);
    expect(check.DEFAULT_FFMPEG_BINS).toEqual(DEFAULT_FFMPEG_BINS);
    expect(check.DEFAULT_FFMPEG_BINS).toEqual(REPLY_FFMPEG_BINS);
    expect(check.defaultApplespeechBins(root)).toEqual(DEFAULT_APPLESPEECH_BINS);
    expect(check.applespeechBinCandidates(root, env)).toEqual(applespeechBinCandidates(env));
    expect(check.ffmpegBinCandidates(env)).toEqual(ffmpegBinCandidates(env));
    expect(check.whisperBinCandidates(env)).toEqual(whisperBinCandidates(env));
  });

  function discover(env: NodeJS.ProcessEnv, available: string[]) {
    return check.discover({ env: { PATH: '', STEREOFOLD_ROOT: root, ...env },
      platform: 'darwin', home: '/opt/home', exists: path => available.includes(path),
      hasFile: () => false, hasDirectory: () => false, readable: () => false,
      readConfig: () => ({}), interfaces: () => ({}),
    });
  }

  it('keeps OpenSSL and reply ffmpeg off PATH while transcription can use it', () => {
    const available = ['openssl', 'ffmpeg', 'whisper-cli', 'applespeech'].map(name => `/opt/custom/bin/${name}`);
    const facts = discover({ PATH: '/opt/custom/bin' }, available);
    expect(facts.tools.openssl).toBeUndefined();
    expect(facts.tools.replyFfmpeg).toBeUndefined();
    expect(facts.tools.ffmpeg).toBe('/opt/custom/bin/ffmpeg');
    expect(facts.tools['whisper-cli']).toBe('/opt/custom/bin/whisper-cli');
    expect(facts.applespeech).toBe('/opt/custom/bin/applespeech');
    expect(check.formatReport(facts)).not.toMatch(/system replies\s+READY/u);
    expect(check.gaps(facts).find(gap => gap.subject === 'system replies')?.fix).toContain('STEREOFOLD_FFMPEG_BIN');
  });

  it('does not hide a broken relay override behind a different PATH executable', () => {
    const available = ['/opt/custom/bin/cloudflared', '/opt/custom/bin/relay'];
    expect(discover({ PATH: '/opt/custom/bin', STEREOFOLD_CLOUDFLARED: '/missing/relay' }, available)
      .tools.cloudflared).toBeUndefined();
    expect(discover({ PATH: '/opt/custom/bin', STEREOFOLD_CLOUDFLARED: 'relay' }, available)
      .tools.cloudflared).toBe('/opt/custom/bin/relay');
  });

  it.each(['STEREOFOLD_ADB_BIN', 'STEREOFOLD_ADB', 'ADB'])('recognizes the device runtime override %s', async key => {
    const env = { PATH: '/opt/custom/bin', [key]: '/opt/custom/adb' };
    const available = ['/opt/custom/adb', '/opt/custom/bin/adb'];
    expect(discover(env, available).tools.adb).toBe(await runtimeFindAdb({
      env, exists: async path => available.includes(path),
    }));
  });

  it.each([
    { directories: ['', 'relative/bin', '/opt/custom/bin'], expected: 'relative/bin' },
    { directories: ['/opt/custom/bin', 'relative/bin'], expected: '/opt/custom/bin' },
    { directories: ['', ''], expected: undefined },
    { directories: [' relative/bin '], expected: ' relative/bin ' },
  ])('matches device PATH lookup for $directories', async ({ directories, expected }) => {
    const env = { PATH: directories.join(delimiter) };
    const available = ['adb', 'cloudflared', 'relay', 'python3', 'agent-voice'].flatMap(name =>
      ['', 'relative/bin', '/opt/custom/bin', ' relative/bin '].map(directory => join(directory, name)));
    const exists = (path: string) => available.includes(path);
    const facts = discover(env, available);
    expect(facts.tools.adb).toBe(await runtimeFindAdb({ env, exists: async path => exists(path) }));
    for (const name of ['adb', 'cloudflared']) {
      expect(facts.tools[name]).toBe(expected === undefined ? undefined : join(expected, name));
      expect(facts.tools[name]).toBe(await runtimeFindExecutable(name, [], { env, exists: async path => exists(path) }));
    }
    expect(discover({ ...env, STEREOFOLD_CLOUDFLARED: 'relay' }, available).tools.cloudflared)
      .toBe(expected === undefined ? undefined : join(expected, 'relay'));
    // The voice runtime deliberately has a stricter PATH contract.
    expect(facts.helpers.python3.path).toBe(runtimeFindHelperOnPath('python3', env, exists));
    expect(facts.helpers.agentVoice.path).toBe(runtimeFindHelperOnPath('agent-voice', env, exists));
  });

  it('prefers every fixed candidate over later fixed candidates and PATH', () => {
    for (const [key, candidates] of Object.entries({ openssl: OPENSSL_PATHS,
      ffmpeg: DEFAULT_FFMPEG_BINS, 'whisper-cli': DEFAULT_WHISPER_BINS,
      applespeech: DEFAULT_APPLESPEECH_BINS })) {
      for (let index = 0; index < candidates.length; index++) {
        const facts = discover({ PATH: '/opt/custom/bin' }, [...candidates.slice(index), `/opt/custom/bin/${key}`]);
        expect(key === 'applespeech' ? facts.applespeech : facts.tools[key]).toBe(candidates[index]);
      }
    }
  });

  it.each(['STEREOFOLD_FFMPEG_BIN', 'STEREOFOLD_WHISPER_BIN', 'STEREOFOLD_APPLESPEECH_BIN'])('honours %s verbatim without falling back from a bad override', variable => {
    const available = [...DEFAULT_FFMPEG_BINS, ...DEFAULT_WHISPER_BINS, ...DEFAULT_APPLESPEECH_BINS, '/opt/custom/tool'];
    const value = (facts: check.Facts) => variable === 'STEREOFOLD_APPLESPEECH_BIN' ? facts.applespeech
      : facts.tools[variable === 'STEREOFOLD_FFMPEG_BIN' ? 'ffmpeg' : 'whisper-cli'];
    expect(value(discover({ [variable]: '/opt/custom/tool' }, available))).toBe('/opt/custom/tool');
    for (const bad of ['/missing/tool', 'relative', ' /opt/custom/tool ', ' ']) {
      expect(value(discover({ [variable]: bad }, available)), bad).toBeUndefined();
    }
    expect(value(discover({ [variable]: '' }, available))).toBeDefined();
  });
});

describe('setup check discovery', () => {
  it.each([
    { selector: 'whisper', apple: true, whisper: false, route: 'whisper', ready: false },
    { selector: 'whisper', apple: true, whisper: true, route: 'whisper', ready: true },
    { selector: 'apple', apple: true, whisper: false, route: 'apple', ready: true },
    { selector: 'apple', apple: true, whisper: true, route: 'apple', ready: true },
    { selector: 'apple', apple: false, whisper: true, route: 'apple', ready: true },
    { selector: 'apple', apple: false, whisper: false, route: 'apple', ready: false },
    { selector: undefined, apple: true, whisper: true, route: 'apple', ready: true },
    { selector: undefined, apple: false, whisper: true, route: 'whisper', ready: true },
    { selector: undefined, apple: false, whisper: false, route: 'whisper', ready: false },
    { selector: ' WhIsPeR ', apple: true, whisper: false, route: 'whisper', ready: false },
    { selector: ' APPLE ', apple: true, whisper: false, route: 'apple', ready: true },
    { selector: 'typo', apple: true, whisper: false, route: 'whisper', ready: false },
    { selector: '  ', apple: true, whisper: false, route: 'apple', ready: true },
  ])('honours selector=$selector with Apple=$apple and Whisper=$whisper', ({ selector, apple, whisper, route, ready }) => {
    const env = { PATH: '', [TRANSCRIBER_ENV]: selector, STEREOFOLD_ROOT: '/opt/stereofold',
      STEREOFOLD_WHISPER_MODEL: '/opt/models/ggml-base.en.bin', STEREOFOLD_REPLY_VOICE_PROVIDER: 'system' };
    const executables = new Set(['/usr/bin/say', '/opt/homebrew/bin/ffmpeg',
      ...(apple ? ['/opt/homebrew/bin/applespeech'] : []),
      ...(whisper ? ['/opt/homebrew/bin/whisper-cli'] : [])]);
    const exists = (path: string) => executables.has(path);
    const facts = check.discover({
      env, platform: 'darwin', home: '/opt/home', exists,
      readable: path => whisper && path === env.STEREOFOLD_WHISPER_MODEL,
      hasFile: () => false, hasDirectory: () => false, readConfig: () => ({}), interfaces: () => ({}),
    });
    const report = check.formatReport(facts);
    expect(transcriberKind(env, { platform: 'darwin', exists })).toBe(route);
    expect(report).toMatch(new RegExp(`transcriber\\s+${route}\\b`, 'u'));
    expect(/transcription\s+READY/u.test(report)).toBe(ready);
    expect(/voice\s+READY/u.test(report)).toBe(ready);
    const gap = check.gaps(facts).find(item => item.subject === 'transcription');
    if (ready) {
      expect(gap).toBeUndefined();
      expect(report).toMatch(route === 'apple' && apple
        ? /transcription\s+READY \(Apple with ffmpeg/u : /transcription\s+READY \(Whisper/u);
      if (route === 'apple' && !apple) expect(report).toContain('Whisper fallback; Apple unavailable');
    } else {
      expect(gap?.fix).toContain('STEREOFOLD_WHISPER_MODEL');
      expect(report).toContain(`fix: ${gap?.fix}`);
      if (route === 'whisper') {
        expect(gap?.effect).toContain('selected Whisper route');
        expect(gap?.fix).toContain('install whisper.cpp and ffmpeg');
        expect(gap?.fix).not.toMatch(/applespeech|Speech Recognition/u);
      } else {
        expect(gap?.fix).toContain('native/applespeech/build.sh');
      }
    }
  });

  it.each(['Apple', 'Whisper'])('discovers %s and system voice prerequisites with no Python, OAuth or PATH', (route) => {
    const model = '/opt/models/ggml-base.en.bin';
    const executables = new Set(['/usr/bin/say', '/opt/homebrew/bin/ffmpeg',
      route === 'Apple' ? '/opt/tools/applespeech' : '/opt/homebrew/bin/whisper-cli']);
    const options: check.DiscoverOptions = {
      platform: 'darwin', home: '/opt/home', start: '/opt/stereofold',
      env: { PATH: '', STEREOFOLD_APPLESPEECH_BIN: route === 'Apple' ? '/opt/tools/applespeech' : '',
        STEREOFOLD_WHISPER_MODEL: model, STEREOFOLD_REPLY_VOICE_PROVIDER: 'system' },
      exists: (path) => executables.has(path), readable: (path) => route === 'Whisper' && path === model,
      hasFile: () => false, hasDirectory: () => false, readConfig: () => ({}), interfaces: () => ({}),
    };
    const facts = check.discover(options);
    expect(facts.helpers.python3.ready).toBe(false);
    expect(facts.helpers.agentVoice.ready).toBe(false);
    expect(check.formatReport(facts)).toMatch(/voice\s+READY/u);
    if (route === 'Whisper') {
      expect(check.formatReport(check.discover({ ...options, readable: () => false })))
        .toMatch(/transcription\s+unavailable: no local transcriber/u);
    }
  });

  it('finds the plugin root of a release artifact and of a checkout', async () => {
    const artifact = await temporaryDirectory('stereofold-root-artifact-');
    await mkdir(resolve(artifact, '.codex-plugin'), { recursive: true });
    await writeFile(resolve(artifact, '.codex-plugin/plugin.json'), '{"name":"stereofold"}');
    await mkdir(resolve(artifact, 'skills/stereofold-setup/scripts'), { recursive: true });
    expect(check.findRoot({ env: {}, start: resolve(artifact, 'skills/stereofold-setup/scripts') })).toBe(artifact);

    const checkout = await temporaryDirectory('stereofold-root-checkout-');
    await mkdir(resolve(checkout, 'plugin/.codex-plugin'), { recursive: true });
    await writeFile(resolve(checkout, 'plugin/.codex-plugin/plugin.json'), '{"name":"stereofold"}');
    expect(check.findRoot({ env: {}, start: checkout })).toBe(resolve(checkout, 'plugin'));
  });

  it('finds Claude-only artifact and checkout roots without Codex metadata', async () => {
    const artifact = await temporaryDirectory('stereofold-claude-root-artifact-');
    await mkdir(resolve(artifact, '.claude-plugin'), { recursive: true });
    await writeFile(resolve(artifact, '.claude-plugin/plugin.json'), '{"name":"stereofold"}');
    expect(check.findRoot({ env: {}, start: resolve(artifact, 'skills/stereofold-setup/scripts') })).toBe(artifact);

    const checkout = await temporaryDirectory('stereofold-claude-root-checkout-');
    await mkdir(resolve(checkout, 'plugin/.claude-plugin'), { recursive: true });
    await writeFile(resolve(checkout, 'plugin/.claude-plugin/plugin.json'), '{"name":"stereofold"}');
    expect(check.findRoot({ env: {}, start: checkout })).toBe(resolve(checkout, 'plugin'));
  });

  it('blocks a release missing only inspector-host.js', async () => {
    const artifact = await temporaryDirectory('stereofold-missing-host-');
    await mkdir(resolve(artifact, '.codex-plugin'));
    await writeFile(resolve(artifact, '.codex-plugin/plugin.json'), '{"name":"stereofold"}');
    await mkdir(resolve(artifact, 'dist'));
    for (const file of ['server.mjs', 'viewer.html', 'inspector.html', 'inspector.css']) {
      await writeFile(resolve(artifact, 'dist', file), 'built');
    }
    await writeFile(resolve(artifact, '.mcp.json'), JSON.stringify({
      mcpServers: { stereo_structure: { command: 'node', args: ['./dist/server.mjs'], cwd: '.' } },
    }));
    const env = { PATH: '', STEREOFOLD_CONFIG: resolve(artifact, 'config.json') };
    const result = check.run(['--root', artifact, '--no-write'], env);
    expect(result.code, 'missing inspector host blocks setup').toBe(1);
    expect(result.text).toContain('missing dist/inspector-host.js');
    expect(result.text).toContain('SETUP BLOCKED');
    await writeFile(resolve(artifact, 'dist/inspector-host.js'), 'built');
    expect(check.run(['--root', artifact, '--no-write'], env).code).toBe(0);
  });

  it('requires both script companions only for a split inspector', async () => {
    const artifact = await temporaryDirectory('stereofold-missing-script-');
    await mkdir(resolve(artifact, '.codex-plugin'));
    await writeFile(resolve(artifact, '.codex-plugin/plugin.json'), '{"name":"stereofold"}');
    await mkdir(resolve(artifact, 'dist'));
    for (const file of ['server.mjs', 'viewer.html', 'inspector.html', 'inspector.css', 'inspector-host.js'])
      await writeFile(resolve(artifact, 'dist', file), 'built');
    await writeFile(resolve(artifact, '.mcp.json'), JSON.stringify({ mcpServers: { stereo_structure: { command: 'node', args: ['./dist/server.mjs'], cwd: '.' } } }));
    const env = { PATH: '', STEREOFOLD_CONFIG: resolve(artifact, 'config.json') };
    expect(check.run(['--root', artifact, '--no-write'], env).code).toBe(0);
    await writeFile(resolve(artifact, 'dist/inspector.html'), '<script>/* STEREOFOLD_INSPECTOR_SCRIPT_1 *//* STEREOFOLD_INSPECTOR_SCRIPT_2 */</script>');
    const missing = check.run(['--root', artifact, '--no-write'], env);
    expect(missing.code).toBe(1);
    expect(missing.text).toContain('dist/inspector-script-1.js');
    expect(missing.text).toContain('dist/inspector-script-2.js');
    for (const file of ['inspector-script-1.js', 'inspector-script-2.js'])
      await writeFile(resolve(artifact, 'dist', file), 'script');
    expect(check.run(['--root', artifact, '--no-write'], env).code).toBe(0);
  });

  it('prefers the variable, then the config file, then PATH, and reports which one answered', () => {
    const exists = (path: string) => path.startsWith('/usr');
    expect(check.findHelper({
      name: 'python3', envName: PYTHON3_BIN_ENV, configKey: PYTHON3_CONFIG_KEY,
      env: { [PYTHON3_BIN_ENV]: '/usr/bin/python3', PATH: '/usr/bin' }, config: { [PYTHON3_CONFIG_KEY]: '/opt/py' }, exists,
    })).toEqual({ name: 'python3', path: '/usr/bin/python3', source: PYTHON3_BIN_ENV, ready: true });

    // A path the user named and this machine cannot run is reported, not
    // hidden: "not executable at <path>" is what shows them their own typo.
    expect(check.findHelper({
      name: 'python3', envName: PYTHON3_BIN_ENV, configKey: PYTHON3_CONFIG_KEY,
      env: { PATH: '/usr/bin' }, config: { [PYTHON3_CONFIG_KEY]: '/opt/missing/python3' }, exists,
    })).toEqual({ name: 'python3', path: '/opt/missing/python3', source: PYTHON3_CONFIG_KEY, ready: false });

    expect(check.findHelper({
      name: 'python3', envName: PYTHON3_BIN_ENV, configKey: PYTHON3_CONFIG_KEY,
      env: { PATH: '/usr/bin' }, config: {}, exists,
    })).toEqual({ name: 'python3', path: '/usr/bin/python3', source: 'PATH', ready: true });

    expect(check.findHelper({
      name: 'python3', envName: PYTHON3_BIN_ENV, configKey: PYTHON3_CONFIG_KEY,
      env: { PATH: '/empty' }, config: {}, exists,
    })).toMatchObject({ path: undefined, ready: false });
  });

  it('counts only assigned private IPv4 addresses as a Quest route', () => {
    expect(check.isPrivateIpv4('192.168.77.20')).toBe(true);
    expect(check.isPrivateIpv4('172.20.0.4')).toBe(true);
    expect(check.isPrivateIpv4('8.8.8.8')).toBe(false);
    expect(check.privateLanAddresses(() => ({
      lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      en0: [{ address: '192.168.77.20', family: 'IPv4', internal: false },
        { address: '93.184.216.34', family: 'IPv4', internal: false }],
    }))).toEqual(['en0 192.168.77.20']);
  });
});

describe('setup check gaps', () => {
  it('blocks old Node and missing runtime files with release recovery', () => {
    const blocked = check.gaps(healthyFacts({
      node: { version: '20.11.0', path: '/usr/bin/node', major: 20 },
      kind: 'release artifact', runtimeMissing: ['dist/server.mjs'],
    }));
    const required = blocked.filter((gap) => gap.required);
    expect(required.map((gap) => gap.subject)).toEqual(['node', 'runtime']);
    expect(required[0]?.fix).toContain('Node 22 or newer');
    expect(required[1]?.fix).toContain('re-extract stereofold-marketplace.tar.gz');
    expect(required[1]?.fix).toContain('SHA256SUMS');
    // Every gap carries a command, which is the whole contract of this block.
    for (const gap of blocked) expect(gap.fix.length).toBeGreaterThan(0);
  });

  it('leaves voice and Quest optional, and names the variable that turns each on', () => {
    const missing = check.gaps(healthyFacts({
      helpers: {
        python3: { name: 'python3', path: undefined, source: undefined, ready: false },
        agentVoice: { name: 'agent-voice', path: undefined, source: undefined, ready: false },
      },
      tools: { ...healthyFacts().tools, openssl: undefined, ffmpeg: undefined },
      lan: [],
    }));
    expect(missing.every((gap) => !gap.required)).toBe(true);
    expect(missing.map((gap) => gap.subject).sort())
      .toEqual(['agent-voice', 'ffmpeg', 'openssl', 'private LAN address', 'python3', 'transcription']);
    expect(missing.find((gap) => gap.subject === 'python3')?.fix).toContain(PYTHON3_BIN_ENV);
    expect(missing.find((gap) => gap.subject === 'agent-voice')?.fix).toContain(AGENT_VOICE_BIN_ENV);
  });

  it('reports a healthy machine as ready with nothing missing', () => {
    expect(check.gaps(healthyFacts())).toEqual([]);
    const report = check.formatReport(healthyFacts());
    expect(report).toContain('Missing prerequisites: none.');
    expect(report.trimEnd().endsWith('SETUP READY')).toBe(true);
  });
});

describe('setup check report', () => {
  it.each([false, true])('requires ffmpeg for Apple transcription (ffmpeg present: %s)', (hasFfmpeg) => {
    const facts = healthyFacts({
      whisperModel: undefined,
      tools: { ...healthyFacts().tools, 'whisper-cli': undefined,
        ffmpeg: hasFfmpeg ? healthyFacts().tools.ffmpeg : undefined },
    });
    const report = check.formatReport(facts);
    if (hasFfmpeg) {
      expect(report).toMatch(/transcription\s+READY \(Apple\b/u);
      expect(report).toMatch(/voice\s+READY/u);
      expect(check.gaps(facts)).toEqual([]);
    } else {
      expect(report).not.toMatch(/transcription\s+READY|voice\s+READY/u);
      expect(report).toMatch(/transcription\s+unavailable/u);
      expect(check.gaps(facts).find(gap => gap.subject === 'transcription')?.fix)
        .toContain('brew install ffmpeg');
      expect(report).toContain('fix: brew install ffmpeg');
    }
  });

  it.each(['Apple', 'Whisper'])('reports voice READY with %s and system replies without Python or OAuth', (route) => {
    const facts = healthyFacts({
      replyProviderSetting: 'system',
      helpers: {
        python3: { name: 'python3', path: undefined, source: undefined, ready: false },
        agentVoice: { name: 'agent-voice', path: undefined, source: undefined, ready: false },
      },
      applespeech: route === 'Apple' ? healthyFacts().applespeech : undefined,
      tools: { ...healthyFacts().tools, 'whisper-cli': route === 'Whisper' ? '/usr/local/bin/whisper-cli' : undefined },
      whisperModel: route === 'Whisper' ? healthyFacts().whisperModel : undefined,
    });
    const report = check.formatReport(facts);
    expect(report, 'local transcription and system replies do not require Python or OAuth')
      .toMatch(/voice\s+READY/u);
    expect(report).toContain('system (configured; preserve this choice)');
    expect(report).not.toMatch(/transcription.*stay off|spoken replies.*stay off/u);
    expect(check.gaps(facts).every((gap) => !gap.required && /optional OAuth/u.test(gap.effect))).toBe(true);
  });

  it('keeps detected OAuth narration as the default without suggesting a system switch', () => {
    const report = check.formatReport(healthyFacts());
    expect(report).toContain('oauth (runtime default)');
    expect(report).toContain('READY (local prerequisites for oauth)');
    expect(report).toContain('OAuth login and synthesis not checked');
    expect(report).toContain('Preserve the agent-voice route');
    expect(report).not.toContain('STEREOFOLD_REPLY_VOICE_PROVIDER=system');
    expect(report).not.toContain('select the local routes');
  });

  it('preserves configured OAuth even when its helper needs repair', () => {
    const facts = healthyFacts({ config: { replyVoiceProvider: 'oauth' },
      helpers: { ...healthyFacts().helpers, agentVoice: { name: 'agent-voice', path: undefined, source: undefined, ready: false } } });
    const report = check.formatReport(facts);
    expect(report).toContain('oauth (configured; preserve this choice)');
    expect(report).not.toMatch(/voice\s+READY/u);
    expect(report).not.toContain('STEREOFOLD_REPLY_VOICE_PROVIDER=system');
    expect(report).toContain('repair OAuth failures without switching providers');
    expect(check.configUpdate(facts).replyVoiceProvider).toBe('oauth');
  });

  it('offers system replies conditionally to a new setup with no OAuth helper', () => {
    const facts = healthyFacts({ helpers: { ...healthyFacts().helpers,
      agentVoice: { name: 'agent-voice', path: undefined, source: undefined, ready: false } } });
    const report = check.formatReport(facts);
    expect(report).toContain('For a new setup without an OAuth narration helper, explicitly choose STEREOFOLD_REPLY_VOICE_PROVIDER=system');
    expect(report).not.toMatch(/voice\s+READY/u);
    expect(check.configUpdate(facts)).not.toHaveProperty('replyVoiceProvider');
  });

  it('discovers the environment provider override without overwriting local config', () => {
    const facts = check.discover({ env: { STEREOFOLD_REPLY_VOICE_PROVIDER: ' System ' },
      readConfig: () => ({ replyVoiceProvider: 'oauth' }), hasFile: () => false, hasDirectory: () => false,
      exists: () => false, readable: () => false, interfaces: () => ({}) });
    expect(facts.replyProviderSetting).toBe('System');
    expect(check.formatReport(facts)).toContain('system (configured; preserve this choice)');
    expect(check.configUpdate(facts).replyVoiceProvider).toBe('oauth');
  });

  it('reports the missing local transcriber while system replies remain READY', () => {
    const facts = healthyFacts({
      applespeech: undefined, whisperModel: undefined,
      tools: { ...healthyFacts().tools, 'whisper-cli': undefined },
    });
    const report = check.formatReport(facts);
    expect(report).toMatch(/transcription\s+unavailable: no local transcriber/u);
    expect(report).toMatch(/system replies\s+READY/u);
    expect(report).not.toMatch(/voice\s+READY/u);
    expect(check.gaps(facts).find((gap) => gap.subject === 'transcription')?.fix)
      .toContain('STEREOFOLD_WHISPER_MODEL');
  });

  it('does not count Whisper without its model or system replies without say', () => {
    const facts = healthyFacts({
      applespeech: undefined, whisperModel: undefined,
      tools: { ...healthyFacts().tools, say: undefined },
    });
    const report = check.formatReport(facts);
    expect(report).not.toMatch(/voice\s+READY|system replies\s+READY/u);
    expect(check.gaps(facts).map((gap) => gap.subject)).toEqual(['transcription', 'system replies']);
  });

  it('prints one fix line per gap and ends in a verdict that names the next command', () => {
    const facts = healthyFacts({ node: { version: '20.11.0', path: '/usr/bin/node', major: 20 } });
    const report = check.formatReport(facts);
    const fixes = report.split('\n').filter((line) => line.trimStart().startsWith('fix: '));
    expect(fixes).toHaveLength(check.gaps(facts).length);
    expect(report).toContain('SETUP BLOCKED: 1 required prerequisite missing');
    expect(report).toContain('repeat this command');
    // The facts are in the same block, above the gaps.
    expect(report.indexOf('node')).toBeLessThan(report.indexOf('Missing prerequisites'));
  });

  it('marks a line as a problem only when a fix line exists for it', () => {
    // A `--` with no `fix:` under it is the one failure this block cannot
    // survive: the reader sees a problem and is told nothing about it.
    const problemLines = (facts: check.Facts) => {
      const missing = check.gaps(facts);
      const report = check.formatReport(facts, missing);
      const problems = report.split('\n').filter((line) => line.startsWith('  --'));
      const fixes = report.split('\n').filter((line) => line.trimStart().startsWith('fix: '));
      expect(fixes).toHaveLength(missing.length);
      // A marked line exists exactly when something is missing. Several lines
      // may share one fix — a missing install breaks the runtime and the MCP
      // entry with it — but no line is marked without one.
      expect(problems.length === 0).toBe(missing.length === 0);
      return problems;
    };

    expect(problemLines(healthyFacts())).toEqual([]);
    // No install at all: the runtime and MCP lines report the same one gap
    // rather than inventing two fixes for a directory that is not there.
    expect(problemLines(healthyFacts({
      root: undefined, kind: 'none', runtimeMissing: ['dist/server.mjs'], mcpEntry: undefined,
    })).length).toBe(3);
    expect(problemLines(healthyFacts({ kind: 'release artifact', runtimeMissing: ['dist/viewer.html'] })).length).toBe(1);
    // A Linux machine with nothing installed: every absent program is named,
    // and the macOS-only recognizer is not held against it.
    const linux = problemLines(healthyFacts({
      platform: 'linux', applespeech: undefined, lan: [],
      tools: { pnpm: undefined, npx: undefined, git: undefined, openssl: undefined },
    }));
    expect(linux.some((line) => line.includes('applespeech'))).toBe(false);
    expect(linux.some((line) => line.includes('git'))).toBe(false);
    // npx has no feature behind it, so its absence is stated, not blamed.
    expect(linux.some((line) => line.includes('npx'))).toBe(false);
  });

  it('says whether the config file changed', () => {
    expect(check.formatReport(healthyFacts(), undefined, true)).toContain('config.json (written)');
    expect(check.formatReport(healthyFacts(), undefined, false)).toContain('config.json (unchanged)');
  });
});

describe('setup check config file', () => {
  it('preserves every JSON value type through discovery and an authorized setup write without printing private values', async () => {
    const directory = await temporaryDirectory('stereofold-config-values-');
    const path = join(directory, 'config.json');
    const existing = {
      python3Bin: '/opt/mine/python3', replyVoiceProvider: 'oauth',
      enabled: false, count: 7, nullable: null,
      nested: { label: 'private-regression-value', flags: [true, null, 3] },
      list: ['a', { b: 2 }],
    };
    await writeFile(path, JSON.stringify(existing));
    expect(check.readLocalConfig(path)).toEqual(existing);
    const root = fileURLToPath(new URL('..', import.meta.url));
    const result = check.run(['--root', root, '--json'], { PATH: '', STEREOFOLD_CONFIG: path });
    const saved = JSON.parse(await readFile(path, 'utf8'));
    expect(saved).toMatchObject(existing);
    expect(saved.stereofoldRoot).toBe(resolve(root));
    expect(saved.serverEntry).toBe(join(resolve(root), 'dist/server.mjs'));
    const report = JSON.parse(result.text);
    expect(report.configWritten).toBe(true);
    expect(report.facts.config).toBeUndefined();
    expect(result.text).not.toContain('private-regression-value');
    expect(check.writeConfig(path, { additional: [1, 2] })).toBe(true);
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ ...existing, additional: [1, 2] });
  });

  it('ignores non-string helper settings during diagnostics while preserving their values', () => {
    const config = { python3Bin: false, agentVoiceBin: null, replyVoiceProvider: { private: true } };
    const facts = check.discover({ env: { PATH: '' }, readConfig: () => config, interfaces: () => ({}) });
    expect(facts.config).toEqual(config);
    expect(facts.helpers.python3.ready).toBe(false);
    expect(() => check.formatReport(facts)).not.toThrow();
    expect(check.configUpdate(facts)).toMatchObject(config);
    expect(check.configUpdate(healthyFacts({ config }))).toMatchObject(config);
  });

  it.each([
    ['malformed', '{"private":"never-print-this-regression-value"', 'not valid JSON'],
    ['array', '[1, 2]', 'JSON object'],
    ['null', 'null', 'JSON object'],
    ['oversized', JSON.stringify({ private: 'x'.repeat(64 * 1024) }), '64 KiB'],
  ])('keeps an existing %s configuration untouched and reports a safe recovery', async (_kind, contents, message) => {
    const directory = await temporaryDirectory('stereofold-config-invalid-');
    const path = join(directory, 'config.json');
    await writeFile(path, contents);
    const root = fileURLToPath(new URL('..', import.meta.url));
    const env = { PATH: '', STEREOFOLD_CONFIG: path };
    const readOnly = check.run(['--root', root, '--no-write', '--json'], env);
    expect(JSON.parse(readOnly.text).facts.configError).toContain(message);
    expect(readOnly.text).toContain('back up and repair');
    expect(readOnly.text).not.toContain('never-print-this-regression-value');
    const attemptedWrite = check.run(['--root', root], env);
    expect(attemptedWrite.code).toBe(1);
    expect(attemptedWrite.text).toContain('SETUP BLOCKED');
    expect(attemptedWrite.text).toContain('Existing contents will be preserved');
    expect(() => check.writeConfig(path, { stereofoldRoot: root })).toThrow(message);
    expect(await readFile(path, 'utf8')).toBe(contents);
  });

  it('refuses an unreadable destination instead of treating it as missing', async () => {
    const directory = await temporaryDirectory('stereofold-config-unreadable-');
    const parentFile = join(directory, 'parent');
    await writeFile(parentFile, 'preserve this existing file');
    const path = join(parentFile, 'config.json');
    expect(() => check.readLocalConfig(path)).toThrow('ENOTDIR');
    expect(() => check.writeConfig(path, { stereofoldRoot: '/opt/stereofold' })).toThrow('ENOTDIR');
    expect(await readFile(parentFile, 'utf8')).toBe('preserve this existing file');
    const facts = check.discover({ env: { PATH: '' }, interfaces: () => ({}),
      readConfig: () => { throw Error('Existing configuration cannot be read (EACCES).'); },
    });
    expect(check.formatReport(facts)).toContain('EACCES');
    expect(check.gaps(facts)).toContainEqual(expect.objectContaining({ subject: 'config file', required: false }));
  });

  it('does not overwrite a file through a preexisting temporary-file symlink', async () => {
    const directory = await temporaryDirectory('stereofold-config-temp-');
    const path = join(directory, 'config.json');
    const victim = join(directory, 'other.json');
    await writeFile(path, '{"keep":true}');
    await writeFile(victim, 'unrelated private data');
    await symlink(victim, `${path}.setup-check-${process.pid}`);
    expect(() => check.writeConfig(path, { stereofoldRoot: '/opt/stereofold' })).toThrow();
    expect(await readFile(victim, 'utf8')).toBe('unrelated private data');
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ keep: true });
  });

  it('preserves a compact valid config when the merged formatted output would exceed the read limit', async () => {
    const directory = await temporaryDirectory('stereofold-config-boundary-');
    const path = join(directory, 'config.json');
    const contents = JSON.stringify({ values: Array.from({ length: 32000 }, () => 0) });
    expect(Buffer.byteLength(contents)).toBeLessThan(64 * 1024);
    await writeFile(path, contents);
    expect(check.readLocalConfig(path)).toEqual(JSON.parse(contents));
    expect(() => check.writeConfig(path, { stereofoldRoot: '/opt/stereofold' })).toThrow('Updated configuration exceeds the 64 KiB limit');
    expect(await readFile(path, 'utf8')).toBe(contents);
    await expect(stat(`${path}.setup-check-${process.pid}`)).rejects.toThrow();
  });

  it('records this install and fills only the helper keys the user left unset', () => {
    const next = check.configUpdate(healthyFacts({ config: { [PYTHON3_CONFIG_KEY]: '/opt/mine/python3' } }));
    expect(next).toEqual({
      [PYTHON3_CONFIG_KEY]: '/opt/mine/python3',
      [AGENT_VOICE_CONFIG_KEY]: '/usr/local/bin/agent-voice',
      stereofoldRoot: '/opt/stereofold',
      serverEntry: '/opt/stereofold/dist/server.mjs',
    });
  });

  it('writes nothing for a helper this machine cannot run', () => {
    const next = check.configUpdate(healthyFacts({
      helpers: {
        python3: { name: 'python3', path: '/opt/broken/python3', source: PYTHON3_CONFIG_KEY, ready: false },
        agentVoice: { name: 'agent-voice', path: undefined, source: undefined, ready: false },
      },
    }));
    expect(next[PYTHON3_CONFIG_KEY]).toBeUndefined();
    expect(next[AGENT_VOICE_CONFIG_KEY]).toBeUndefined();
  });

  it('creates the file only the owner can read, and rewrites it only when it changed', async () => {
    const home = await temporaryDirectory('stereofold-config-');
    const path = resolve(home, '.stereofold/config.json');
    expect(check.writeConfig(path, { stereofoldRoot: '/opt/stereofold' })).toBe(true);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ stereofoldRoot: '/opt/stereofold' });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(check.writeConfig(path, { stereofoldRoot: '/opt/stereofold' })).toBe(false);
    expect(check.writeConfig(path, { stereofoldRoot: '/opt/other' })).toBe(true);
  });
});

describe('setup check command line', () => {
  it('refuses an unknown argument and a relative root by naming the usage', () => {
    expect(() => check.parseArgs(['--nope'])).toThrow(/Unknown argument/u);
    expect(() => check.parseArgs(['--root', 'plugin'])).toThrow(/absolute/u);
    expect(check.parseArgs(['--json', '--no-write'])).toMatchObject({ json: true, write: false });
  });

  it('reads a named root without writing anything when told not to', async () => {
    const artifact = await temporaryDirectory('stereofold-run-');
    await mkdir(resolve(artifact, '.codex-plugin'), { recursive: true });
    await writeFile(resolve(artifact, '.codex-plugin/plugin.json'), '{"name":"stereofold"}');
    const home = await temporaryDirectory('stereofold-run-home-');
    const result = check.run(['--root', artifact, '--no-write'], {
      PATH: '/nowhere', HOME: home, STEREOFOLD_CONFIG: resolve(home, 'config.json'),
    });
    expect(result.text).toContain(artifact);
    // A root with no dist/ is the one gap that stops a host from launching.
    expect(result.text).toContain('SETUP BLOCKED');
    expect(result.code).toBe(1);
    await expect(stat(resolve(home, 'config.json'))).rejects.toThrow();
  });
});
