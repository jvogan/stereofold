import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forgetLocalConfig, readLocalConfig, type LocalConfig } from '../src/local-helper-config.js';
import { privateQuestEndpoint, resolveQuestConnection, type QuestConnectionRunner } from '../src/quest-connection.js';

const directories: string[] = [];
function temporaryHome() { const home = mkdtempSync(join(tmpdir(), 'quest-connection-')); directories.push(home); return home; }
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const failure = { code: 1, stdout: '', stderr: 'unavailable' };
const properties = (model: string, serial = '') => `[ro.product.model]: [${model}]\n[ro.serialno]: [${serial}]\n`;
function fake({ initial = '', after = '', models = {}, connect = ok(), failedProbes = [] }: {
  initial?: string; after?: string; models?: Record<string, string>; connect?: ReturnType<typeof ok>; failedProbes?: string[];
} = {}) {
  let connected = false;
  const calls: string[][] = [];
  const run: QuestConnectionRunner = async (_command, args) => {
    calls.push([...args]);
    if (args[0] === 'devices') return ok(`List of devices attached\n${connected ? after : initial}`);
    if (args[0] === 'connect') { connected = true; return connect; }
    if (args[0] === '-s' && args.slice(2).join(' ') === 'shell getprop')
      return failedProbes.includes(args[1]) ? failure : ok(models[args[1]] ?? properties('Pixel 9'));
    throw Error(`Unexpected command: ${args.join(' ')}`);
  };
  return { calls, run };
}
afterEach(() => { vi.useRealTimers(); forgetLocalConfig(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const opts = { adb: '/test/adb', environment: {}, config: {} };

describe('bounded authorized Quest discovery', () => {
  it('chooses the verified Quest among unrelated ready Android devices', async () => {
    const device = fake({ initial: 'phone device\nheadset device\n', models: { headset: properties('Quest 2') } });
    expect(await resolveQuestConnection({ ...opts, run: device.run })).toEqual({ serial: 'headset', reason: 'ready' });
    expect(device.calls).toEqual([['devices'], ['-s', 'phone', 'shell', 'getprop'], ['-s', 'headset', 'shell', 'getprop']]);
  });
  it.each(['Quest', 'Quest 2', 'Quest 3', 'Quest 3S', 'Quest Pro', 'Meta Quest 3', 'Oculus Quest 2'])('recognizes %s', async model => {
    const device = fake({ initial: 'headset device\n', models: { headset: properties(model) } });
    expect(await resolveQuestConnection({ ...opts, run: device.run })).toMatchObject({ serial: 'headset', reason: 'ready' });
  });
  it('refuses multiple verified Quests, and does not reconnect a remembered address to resolve ambiguity', async () => {
    const device = fake({ initial: 'one device\ntwo device\n', models: { one: properties('Quest 2'), two: properties('Quest 3') } });
    expect(await resolveQuestConnection({ ...opts, config: { verifiedQuestAddress: '192.168.2.10:5555' }, run: device.run })).toEqual({ reason: 'ambiguous' });
    expect(device.calls.some(call => call[0] === 'connect')).toBe(false);
  });
  it('deduplicates USB and Wi-Fi transports only with the same verified hardware identity', async () => {
    const endpoint = '10.1.1.2:5555';
    for (const hardwareSerial of ['USB123', '', 'DIFFERENT']) {
      const device = fake({ initial: `USB123 device\n${endpoint} device\n`, models: {
        USB123: properties('Quest 2', 'USB123'), [endpoint]: properties('Quest 2', hardwareSerial),
      } });
      expect(await resolveQuestConnection({ ...opts, run: device.run })).toEqual(hardwareSerial === 'USB123'
        ? { serial: 'USB123', reason: 'ready' } : { reason: 'ambiguous' });
    }
  });
  it('remembers a verified Wi-Fi alias while choosing the same headset over USB', async () => {
    const home = temporaryHome(), endpoint = '10.1.1.2:5555';
    const device = fake({ initial: `USB123 device\n${endpoint} device\n`, models: {
      USB123: properties('Quest 2', 'USB123'), [endpoint]: properties('Quest 2', 'USB123'),
    } });
    expect(await resolveQuestConnection({ ...opts, home, run: device.run }))
      .toEqual({ serial: 'USB123', reason: 'ready', remembered: true });
    expect(readLocalConfig({ env: {}, home }).verifiedQuestAddress).toBe(endpoint);
  });
  it('remembers a matching attached Wi-Fi alias for an explicitly selected USB Quest', async () => {
    const home = temporaryHome(), endpoint = '10.1.1.2:5555';
    const device = fake({ initial: `USB123 device\n${endpoint} device\n`, models: {
      USB123: properties('Quest 2', 'USB123'), [endpoint]: properties('Quest 2', 'USB123'),
    } });
    expect(await resolveQuestConnection({ ...opts, config: { questSerial: 'USB123' }, home, run: device.run }))
      .toEqual({ serial: 'USB123', reason: 'ready', remembered: true });
    expect(readLocalConfig({ env: {}, home }).verifiedQuestAddress).toBe(endpoint);
    expect(device.calls).toEqual([['devices'], ['-s', 'USB123', 'shell', 'getprop'], ['-s', endpoint, 'shell', 'getprop']]);
  });
  it('keeps the explicit USB choice usable when a listed alias is unrelated or its identity probe fails', async () => {
    const endpoint = '10.1.1.2:5555';
    for (const alias of ['different', 'failed', 'unknown']) {
      const home = temporaryHome();
      const device = fake({ initial: `USB123 device\n${endpoint} device\n`, models: {
        USB123: properties('Quest 2', 'USB123'), [endpoint]: properties('Quest 2', alias === 'different' ? 'OTHER' : 'unknown'),
      }, failedProbes: alias === 'failed' ? [endpoint] : [] });
      expect(await resolveQuestConnection({ ...opts, config: { questSerial: 'USB123' }, home, run: device.run }))
        .toEqual({ serial: 'USB123', reason: 'ready' });
      expect(existsSync(join(home, '.stereofold'))).toBe(false);
      expect(device.calls.some(call => call[0] === 'connect')).toBe(false);
    }
  });
  it('keeps the explicit USB choice usable when an optional wireless probe times out', async () => {
    vi.useFakeTimers();
    const home = temporaryHome(), endpoint = '10.1.1.2:5555';
    const calls: string[][] = [];
    const run: QuestConnectionRunner = async (_command, args) => {
      calls.push([...args]);
      if (args[0] === 'devices') return ok(`USB123 device\n${endpoint} device\n`);
      if (args[1] === 'USB123') return ok(properties('Quest 2', 'USB123'));
      return new Promise(() => {});
    };
    const pending = resolveQuestConnection({ ...opts, config: { questSerial: 'USB123' }, home, run, timeoutMs: 30 });
    await vi.advanceTimersByTimeAsync(30);
    expect(await pending).toEqual({ serial: 'USB123', reason: 'ready' });
    expect(calls).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not merge hardware serials reported as unknown', async () => {
    const device = fake({ initial: 'one device\ntwo device\n', models: {
      one: properties('Quest 2', 'unknown'), two: properties('Quest 2', 'unknown'),
    } });
    expect(await resolveQuestConnection({ ...opts, run: device.run })).toEqual({ reason: 'ambiguous' });
  });
  it('honors environment, config and Android serial choices without falling through to another Quest', async () => {
    for (const setting of [{ environment: { STEREOFOLD_QUEST_SERIAL: 'two' }, config: { questSerial: 'one' } },
      { environment: {}, config: { questSerial: 'two' } }, { environment: { ANDROID_SERIAL: 'two' }, config: {} }] as Array<{ environment: NodeJS.ProcessEnv; config: LocalConfig }>) {
      const device = fake({ initial: 'one device\ntwo device\n', models: { one: properties('Quest 2'), two: properties('Quest 3') } });
      expect(await resolveQuestConnection({ ...opts, ...setting, run: device.run })).toEqual({ serial: 'two', reason: 'ready' });
      expect(device.calls).toHaveLength(2);
    }
    const device = fake({ initial: 'headset device\n', models: { headset: properties('Quest 2') } });
    expect(await resolveQuestConnection({ ...opts, config: { questSerial: 'absent' }, run: device.run })).toEqual({ reason: 'configured-unavailable' });
    expect(device.calls).toEqual([['devices']]);
  });
  it('distinguishes unauthorized, offline, unrelated, and failed identity queries without enabling debugging', async () => {
    for (const [initial, reason] of [['headset unauthorized\n', 'unauthorized'], ['headset offline\n', 'unavailable'], ['phone device\n', 'not-quest']] as const) {
      const device = fake({ initial });
      expect(await resolveQuestConnection({ ...opts, run: device.run })).toMatchObject({ reason });
      expect(device.calls.every(call => call[0] === 'devices' || call[0] === '-s')).toBe(true);
    }
    const device = fake({ initial: 'phone device\nheadset device\n', models: { headset: properties('Quest 2') }, failedProbes: ['phone'] });
    expect(await resolveQuestConnection({ ...opts, run: device.run })).toMatchObject({ reason: 'failed', diagnostic: { stage: 'identity', detail: 'unavailable' } });
  });
  it('caps both device count and elapsed time, with no next command after a timeout', async () => {
    const excess = fake({ initial: Array.from({ length: 9 }, (_, index) => `${index} device\n`).join('') });
    expect(await resolveQuestConnection({ ...opts, run: excess.run })).toEqual({ reason: 'ambiguous' });
    expect(excess.calls).toEqual([['devices']]);
    vi.useFakeTimers();
    const run = vi.fn<QuestConnectionRunner>().mockImplementation(async () => new Promise(() => {}));
    const pending = resolveQuestConnection({ ...opts, run, timeoutMs: 30 });
    await vi.advanceTimersByTimeAsync(30);
    expect(await pending).toMatchObject({ reason: 'failed', diagnostic: { stage: 'devices', kind: 'timeout', detail: 'adb devices did not answer within 30 ms.' } });
    expect(run).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('caps the entire sequence when successful commands consume the budget', async () => {
    vi.useFakeTimers();
    const calls: string[][] = [];
    const run: QuestConnectionRunner = async (_command, args) => {
      calls.push([...args]);
      return new Promise(resolve => setTimeout(() => resolve(ok(args[0] === 'devices' ? 'one device\ntwo device\n' : properties('Pixel'))), 20));
    };
    const pending = resolveQuestConnection({ ...opts, run, timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(50);
    expect(await pending).toMatchObject({ reason: 'failed', diagnostic: { stage: 'identity', kind: 'timeout' } });
    expect(calls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(20);
    expect(calls).toHaveLength(3);
  });
});

describe('named private Wi-Fi reconnection', () => {
  it('keeps passive status checks from reconnecting a remembered endpoint', async () => {
    const endpoint='192.168.5.20:5555';
    const device=fake({after:`${endpoint} device\n`,models:{[endpoint]:properties('Quest 2','USB123')}});
    expect(await resolveQuestConnection({...opts,run:device.run,config:{verifiedQuestAddress:endpoint},reconnect:false,remember:false}))
      .toEqual({reason:'unavailable'});
    expect(device.calls).toEqual([['devices']]);
  });

  it('can verify an attached wireless transport during a passive status check', async () => {
    const endpoint='192.168.5.20:5555';
    const device=fake({initial:`${endpoint} device\n`,models:{[endpoint]:properties('Quest 2','USB123')}});
    expect(await resolveQuestConnection({...opts,run:device.run,config:{verifiedQuestAddress:endpoint},reconnect:false,remember:false}))
      .toEqual({serial:endpoint,reason:'ready'});
    expect(device.calls).toEqual([['devices'],['-s',endpoint,'shell','getprop']]);
  });
  it.each(['10.0.0.1:5555', '172.16.0.1:1', '172.31.255.254:65535', '192.168.1.2:5555'])('accepts private endpoint %s', endpoint => {
    expect(privateQuestEndpoint(endpoint)).toBe(endpoint);
  });
  it.each(['localhost:5555', 'quest.local:5555', '127.0.0.1:5555', '8.8.8.8:5555', '172.32.0.1:5555', '192.168.1.256:5555', '192.168.1.2:0', '192.168.1.2:65536', '192.168.1.2', '192.168.01.2:5555', '[fd00::1]:5555', '192.168.1.2:5555;reboot'])('refuses endpoint %s', endpoint => {
    expect(privateQuestEndpoint(endpoint)).toBeUndefined();
  });
  it('reconnects one remembered endpoint then relists and verifies identity', async () => {
    const endpoint = '192.168.5.20:5555';
    const device = fake({ after: `${endpoint} device\n`, models: { [endpoint]: properties('Quest 2', 'USB123') } });
    expect(await resolveQuestConnection({ ...opts, run: device.run, config: { verifiedQuestAddress: endpoint } }))
      .toEqual({ serial: endpoint, reason: 'ready', reconnected: true });
    expect(device.calls).toEqual([['devices'], ['connect', endpoint], ['devices'], ['-s', endpoint, 'shell', 'getprop']]);
  });
  it('uses an explicitly configured endpoint ahead of another ready Quest', async () => {
    const endpoint = '10.1.1.2:5555';
    const device = fake({ initial: 'other device\n', after: `${endpoint} device\nother device\n`, models: { [endpoint]: properties('Quest 3'), other: properties('Quest 2') } });
    expect(await resolveQuestConnection({ ...opts, environment: { STEREOFOLD_QUEST_ADDRESS: endpoint }, run: device.run }))
      .toMatchObject({ serial: endpoint, reason: 'ready', reconnected: true });
    expect(device.calls.some(call => call[1] === 'other')).toBe(false);
  });
  it('never uses arbitrary neighbors, public remembered endpoints, or invalid explicit addresses', async () => {
    for (const config of [{}, { verifiedQuestAddress: '8.8.8.8:5555' }, { questAddress: 'quest.local:5555' }] as LocalConfig[]) {
      const device = fake();
      expect(await resolveQuestConnection({ ...opts, config, run: device.run })).toEqual({ reason: 'questAddress' in config ? 'invalid-endpoint' : 'unavailable' });
      expect(device.calls.some(call => call[0] === 'connect')).toBe(false);
    }
  });
  it('treats successful adb connect output as insufficient without authorized device state and Quest identity', async () => {
    const endpoint = '10.1.1.2:5555';
    for (const [after, model, reason] of [[`${endpoint} unauthorized\n`, 'Quest 2', 'unauthorized'], ['', 'Quest 2', 'unavailable'], [`${endpoint} device\n`, 'Pixel', 'not-quest']] as const) {
      const device = fake({ after, models: { [endpoint]: properties(model) } });
      expect(await resolveQuestConnection({ ...opts, config: { verifiedQuestAddress: endpoint }, run: device.run })).toEqual({ reason });
    }
  });
  it('does not connect an already unauthorized remembered endpoint', async () => {
    const endpoint = '10.1.1.2:5555';
    const device = fake({ initial: `${endpoint} unauthorized\n` });
    expect(await resolveQuestConnection({ ...opts, config: { verifiedQuestAddress: endpoint }, run: device.run })).toEqual({ reason: 'unauthorized' });
    expect(device.calls).toEqual([['devices']]);
  });
  it('refuses a remembered address reassigned to a different Quest, both attached and reconnected', async () => {
    const endpoint = '10.1.1.2:5555';
    for (const alreadyAttached of [true, false]) {
      for (const actualSerial of ['DIFFERENT', '', 'ORIGINAL']) {
        const device = fake({ initial: alreadyAttached ? `${endpoint} device\n` : '',
          after: `${endpoint} device\n`, models: { [endpoint]: properties('Quest 2', actualSerial) } });
        const result = await resolveQuestConnection({ ...opts,
          config: { verifiedQuestAddress: endpoint, verifiedQuestSerial: 'ORIGINAL' }, run: device.run });
        expect(result.reason).toBe(actualSerial === 'ORIGINAL' ? 'ready' : 'configured-unavailable');
      }
    }
  });
  it('requires a matching hardware serial for a disconnected explicit USB choice', async () => {
    const endpoint = '10.1.1.2:5555';
    for (const actual of ['USB123', 'DIFFERENT']) {
      const device = fake({ after: `${endpoint} device\n`, models: { [endpoint]: properties('Quest 2', actual) } });
      const result = await resolveQuestConnection({ ...opts, config: { questSerial: 'USB123', verifiedQuestAddress: endpoint, verifiedQuestSerial: 'USB123' }, run: device.run });
      expect(result.reason).toBe(actual === 'USB123' ? 'ready' : 'configured-unavailable');
    }
    const untrusted = fake();
    expect(await resolveQuestConnection({ ...opts, config: { questSerial: 'USB123', verifiedQuestAddress: endpoint }, run: untrusted.run })).toEqual({ reason: 'configured-unavailable' });
    expect(untrusted.calls).toEqual([['devices']]);
  });
});

describe('preserving debugging failure evidence', () => {
  const endpoint = '192.168.1.90:5555';
  const config = { verifiedQuestAddress: endpoint, verifiedQuestSerial: 'QUEST2' };

  it.each([0, 1])('preserves No route to host when adb exits %s without scanning or restarting', async code => {
    const text = `failed to connect to '${endpoint}': No route to host`;
    const device = fake({ connect: { code, stdout: code === 0 ? text : '', stderr: code === 1 ? text : '' } });
    const result = await resolveQuestConnection({ ...opts, config, run: device.run });
    expect(result).toMatchObject({ reason: 'unavailable', diagnostic: { stage: 'connect', kind: 'no-route', detail: text } });
    expect(result.diagnostic?.hint).toContain('If the known endpoint answers ping or TCP, retain its address');
    expect(result.diagnostic?.hint).toContain('coordinate before restarting adb');
    expect(result.diagnostic?.hint).toContain('does not establish the cause');
    expect(device.calls).toEqual([['devices'], ['connect', endpoint]]);
    expect(config).toEqual({ verifiedQuestAddress: endpoint, verifiedQuestSerial: 'QUEST2' });
  });

  it('preserves explicit timeout output without asserting sleep', async () => {
    const text = `failed to connect to '${endpoint}': Operation timed out`;
    const device = fake({ connect: { code: 0, stdout: text, stderr: '' } });
    const result = await resolveQuestConnection({ ...opts, config, run: device.run });
    expect(result).toMatchObject({ reason: 'unavailable', diagnostic: { stage: 'connect', kind: 'timeout', detail: text } });
    expect(result.diagnostic?.hint).toContain('may be asleep or unresponsive; this does not prove either');
    expect(device.calls).toEqual([['devices'], ['connect', endpoint]]);
  });

  it('reports an actual bounded connect deadline separately from device state', async () => {
    vi.useFakeTimers();
    const calls: string[][] = [];
    const run: QuestConnectionRunner = async (_command, args) => {
      calls.push([...args]);
      return args[0] === 'devices' ? ok('List of devices attached\n') : new Promise(() => {});
    };
    const pending = resolveQuestConnection({ ...opts, config, run, timeoutMs: 25 });
    await vi.advanceTimersByTimeAsync(25);
    expect(await pending).toMatchObject({ reason: 'failed', diagnostic: { stage: 'connect', kind: 'timeout', detail: 'adb connect did not answer within 25 ms.' } });
    expect(calls).toEqual([['devices'], ['connect', endpoint]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains listed offline state on a passive check without connecting', async () => {
    const device = fake({ initial: `${endpoint} offline\n` });
    const result = await resolveQuestConnection({ ...opts, config, run: device.run, reconnect: false, remember: false });
    expect(result).toMatchObject({ reason: 'unavailable', diagnostic: { stage: 'devices', kind: 'offline', detail: `adb lists ${endpoint} as offline.` } });
    expect(device.calls).toEqual([['devices']]);
    expect(result.diagnostic?.hint).toContain('If the known IP answers ping or TCP, retain it');
  });

  it('distinguishes a relisted offline transport after accepted connect', async () => {
    const device = fake({ after: `${endpoint} offline\n`, connect: ok(`connected to ${endpoint}`) });
    expect(await resolveQuestConnection({ ...opts, config, run: device.run })).toMatchObject({
      reason: 'unavailable', diagnostic: { stage: 'relist', kind: 'offline' },
    });
    expect(device.calls).toEqual([['devices'], ['connect', endpoint], ['devices']]);
  });

  it('preserves a runner Error message and both adb output streams', async () => {
    const run: QuestConnectionRunner = async (_command, args) => {
      if (args[0] === 'devices') return ok('List of devices attached\n');
      throw Error('connect failed: No route to host');
    };
    expect(await resolveQuestConnection({ ...opts, config, run })).toMatchObject({
      reason: 'unavailable', diagnostic: { stage: 'connect', kind: 'no-route', detail: 'connect failed: No route to host' },
    });
    const device = fake({ connect: { code: 1, stderr: 'adb: connection refused', stdout: 'transport was not connected' } });
    expect((await resolveQuestConnection({ ...opts, config, run: device.run })).diagnostic?.detail)
      .toBe('adb: connection refused\ntransport was not connected');
  });

  it('bounds and sanitizes diagnostic text while retaining the original reason', async () => {
    const device = fake({ connect: { code: 1, stdout: '', stderr: '\u001b[31mNo route to host\u001b[0m\u0000\nAuthorization: Bearer secret\nhttps://user:password@example.test\n' + 'x'.repeat(2000) } });
    const result = await resolveQuestConnection({ ...opts, config: { questAddress: endpoint }, run: device.run });
    expect(result.reason).toBe('configured-unavailable');
    expect(result.diagnostic?.detail.length).toBeLessThanOrEqual(1024);
    expect(result.diagnostic?.detail).toContain('No route to host');
    expect(result.diagnostic?.detail).not.toMatch(/\u001b|\u0000|secret|password/);
    expect(result.diagnostic?.detail).toContain('[truncated]');
    expect(device.calls).toEqual([['devices'], ['connect', endpoint]]);
  });
});

describe('remembering only verified wireless connections', () => {
  it('preserves all existing config keys, writes privately, and invalidates cached config', async () => {
    const home = temporaryHome(), directory = join(home, '.stereofold'), path = join(directory, 'config.json');
    mkdirSync(directory, { mode: 0o700 });
    const before = { agentVoiceBin: '/voice', unrelated: { enabled: true }, count: 3, questSerial: 'USB123' };
    writeFileSync(path, JSON.stringify(before));
    expect(readLocalConfig({ env: {}, home }).verifiedQuestAddress).toBeUndefined();
    const endpoint = '192.168.5.20:5555';
    const device = fake({ initial: `${endpoint} device\n`, models: { [endpoint]: properties('Quest 2', 'USB123') } });
    const result = await resolveQuestConnection({ ...opts, config: {}, home, run: device.run });
    expect(result).toMatchObject({ reason: 'ready', remembered: true });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ ...before, verifiedQuestAddress: endpoint, verifiedQuestSerial: 'USB123' });
    expect(readLocalConfig({ env: {}, home }).verifiedQuestAddress).toBe(endpoint);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(directory)).toEqual(['config.json']);
  });
  it('creates a private settings directory for the first verified connection', async () => {
    const home = temporaryHome(), endpoint = '10.1.1.2:5555';
    const device = fake({ initial: `${endpoint} device\n`, models: { [endpoint]: properties('Quest 3') } });
    expect(await resolveQuestConnection({ ...opts, home, run: device.run })).toMatchObject({ remembered: true });
    expect(statSync(join(home, '.stereofold')).mode & 0o777).toBe(0o700);
  });
  it('leaves malformed and symlinked config intact, while retaining a usable verified connection', async () => {
    for (const source of ['malformed', 'symlink']) {
      const home = temporaryHome(), directory = join(home, '.stereofold'), path = join(directory, 'config.json');
      mkdirSync(directory);
      if (source === 'malformed') writeFileSync(path, '{oops');
      else { writeFileSync(join(home, 'other.json'), '{}'); symlinkSync(join(home, 'other.json'), path); }
      const before = readFileSync(path, 'utf8'), endpoint = '10.1.1.2:5555';
      const device = fake({ initial: `${endpoint} device\n`, models: { [endpoint]: properties('Quest 2') } });
      expect(await resolveQuestConnection({ ...opts, home, run: device.run })).toEqual({ serial: endpoint, reason: 'ready' });
      expect(readFileSync(path, 'utf8')).toBe(before);
    }
  });
  it('does not write unverified endpoints or USB serials', async () => {
    const home = temporaryHome();
    for (const [serial, model] of [['headset', 'Quest 2'], ['10.1.1.2:5555', 'Pixel']]) {
      const device = fake({ initial: `${serial} device\n`, models: { [serial]: properties(model) } });
      await resolveQuestConnection({ ...opts, home, run: device.run });
      expect(existsSync(join(home, '.stereofold'))).toBe(false);
    }
  });
  it('honors an explicit config path and supports disabling persistence', async () => {
    const home = temporaryHome(), path = join(home, 'settings.json'), endpoint = '10.1.1.2:5555';
    const device = fake({ initial: `${endpoint} device\n`, models: { [endpoint]: properties('Quest Pro') } });
    await resolveQuestConnection({ ...opts, environment: { STEREOFOLD_CONFIG: path }, remember: false, run: device.run });
    expect(existsSync(path)).toBe(false);
    expect(await resolveQuestConnection({ ...opts, environment: { STEREOFOLD_CONFIG: path }, run: device.run })).toMatchObject({ remembered: true });
    expect(JSON.parse(readFileSync(path, 'utf8')).verifiedQuestAddress).toBe(endpoint);
  });
});
