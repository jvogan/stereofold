import { describe, expect, it, vi } from 'vitest';
import { readHeadsetDebugging } from '../src/headset-readiness.js';
import { findAdb } from '../src/quest-launch.js';

const identity = (serial: string) => `[ro.product.model]: [Quest 2]\n[ro.serialno]: [${serial}]\n`;

describe('passive headset debugging readiness', () => {
  it('uses the same explicit adb executable as launch when a different one is on PATH', async () => {
    const env={STEREOFOLD_ADB_BIN:'/custom/adb',PATH:'/tools'};
    const run=vi.fn(async (_command:string,args:readonly string[])=>({stdout:args[0]==='devices'
      ?'QUEST1 device\n':identity('QUEST1'),stderr:''}));
    expect(findAdb({environment:env,executable:()=>true})).toBe('/custom/adb');
    expect(await readHeadsetDebugging({env,config:{},exists:async()=>true,run})).toMatchObject({ok:true,serial:'QUEST1'});
    expect(run.mock.calls.every(([binary])=>binary==='/custom/adb')).toBe(true);
  });
  it('finds PATH adb without an explicit executable setting', async () => {
    const run = vi.fn(async (_command: string, args: readonly string[]) => ({ stdout: args[0] === 'devices'
      ? 'List of devices attached\nQUEST1 device\n' : identity('QUEST1'), stderr: '' }));
    expect(await readHeadsetDebugging({ env: { PATH: '/tools' }, config: {},
      exists: async path => path === '/tools/adb', run })).toEqual({ checked: true, ok: true, serial: 'QUEST1' });
    expect(run.mock.calls.every(([binary]) => binary === '/tools/adb')).toBe(true);
  });

  it('uses launch fallback locations on a stripped PATH and preserves local device selection', async () => {
    const run = vi.fn(async (_command: string, args: readonly string[]) => ({ stdout: args[0] === 'devices'
      ? 'List of devices attached\nQUEST1 device\nQUEST2 device\n' : identity(String(args[1])), stderr: '' }));
    expect(await readHeadsetDebugging({ env: {}, config: { questSerial: 'QUEST2' },
      exists: async path => path === '/opt/homebrew/bin/adb', run })).toEqual({ checked: true, ok: true, serial: 'QUEST2' });
    expect(run.mock.calls[1][1]).toEqual(['-s', 'QUEST2', 'shell', 'getprop']);
  });

  it('does not reconnect or change device settings during readiness', async () => {
    const run = vi.fn(async (_command: string, _args: readonly string[]) => ({ stdout: 'List of devices attached\n', stderr: '' }));
    const result = await readHeadsetDebugging({ env: { PATH: '/tools' },
      config: { verifiedQuestAddress: '192.168.1.90:5555', verifiedQuestSerial: 'QUEST1' },
      exists: async path => path === '/tools/adb', run });
    expect(result).toMatchObject({ checked: true, ok: false });
    expect(run.mock.calls).toHaveLength(1);
    expect(run.mock.calls[0][1]).toEqual(['devices']);
  });

  it.each<{ env: NodeJS.ProcessEnv; config: Record<string, string> }>([
    { env: { ANDROID_SERIAL: 'OTHER' }, config: { questSerial: 'QUEST2' } },
    { env: { STEREOFOLD_QUEST_SERIAL: 'QUEST2', STEREOFOLD_ADB_SERIAL: 'OTHER', ANDROID_SERIAL: 'OTHER' }, config: {} },
  ])('uses the shared launch selector precedence: %j', async ({ env, config }) => {
    const run = vi.fn(async (_command: string, args: readonly string[]) => ({ stdout: args[0] === 'devices'
      ? 'List of devices attached\nQUEST2 device\nOTHER device\n' : identity(String(args[1])), stderr: '' }));
    expect(await readHeadsetDebugging({ env: { PATH: '/tools', ...env }, config,
      exists: async path => path === '/tools/adb', run })).toEqual({ checked: true, ok: true, serial: 'QUEST2' });
    expect(run.mock.calls[1][1]).toEqual(['-s', 'QUEST2', 'shell', 'getprop']);
  });

  it('refuses different Quest identities instead of selecting the first device', async () => {
    const run = vi.fn(async (_command: string, args: readonly string[]) => ({ stdout: args[0] === 'devices'
      ? 'List of devices attached\nQUEST1 device\nQUEST2 device\n' : identity(String(args[1])), stderr: '' }));
    expect(await readHeadsetDebugging({ env: { PATH: '/tools' }, config: {},
      exists: async path => path === '/tools/adb', run })).toMatchObject({ checked: true, ok: false, reason: expect.stringContaining('More than one Quest identity') });
  });

  it('reports a missing executable without claiming the headset is unreachable', async () => {
    const run = vi.fn();
    expect(await readHeadsetDebugging({ env: {}, config: {}, exists: async () => false, run }))
      .toEqual({ checked: false, reason: 'No adb executable was found; optional debugging was not checked.' });
    expect(run).not.toHaveBeenCalled();
  });
});
