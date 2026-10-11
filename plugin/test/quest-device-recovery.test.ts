import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import https from 'node:https';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LanCompanion, pairingHtml, type PairingFailure } from '../src/inspection-lan.js';
import { RememberedDeviceStore } from '../src/inspection-remembered-devices.js';
import { preferredWebLaunch, recoverableWebLaunch, type LanStatus } from '../scripts/quest-share.js';

// Replace only the TLS socket boundary; all parsing, pairing, recovery and storage are real.
vi.mock('node:https', async importOriginal => {
  const actual = await importOriginal<typeof import('node:https')>();
  return { ...actual, default: { ...actual, createServer: vi.fn((_options, handler) => {
    const server = new EventEmitter() as any;
    server.handler = handler;
    server.setTimeout = () => server;
    server.unref = () => server;
    server.listen = (port: number, host: string, ready: () => void) => {
      server.address = () => ({ address: host, port }); ready();
    };
    server.close = (done: () => void) => done();
    return server;
  }) } };
});

const origin = 'https://192.168.77.24:8443/';
const launchId = 'a'.repeat(32);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); });
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

/** Runs the exact inline script served by the listener, including storage and redirects. */
async function page(target: string, storage: Map<string, string>, fetch: (url: string, options: any) => Promise<any>) {
  const location = new URL(target);
  const redirects: string[] = [];
  const form = { hidden: false, addEventListener: vi.fn() }, status = { textContent: '' };
  const script = /<script>([\s\S]*)<\/script>/.exec(pairingHtml())![1];
  runInNewContext(script, {
    window: { addEventListener: vi.fn() },
    location: { hash: location.hash, pathname: '/', search: '', replace: (url: string) => redirects.push(url) },
    history: { replaceState: vi.fn() }, fetch,
    localStorage: { getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    sessionStorage: { getItem: () => null, setItem: vi.fn() },
    document: { querySelector: (selector: string) => selector === 'form' ? form : status },
  });
  // Pairing awaits disk IO in these tests, so callers explicitly drain pending work below.
  return { redirects, form, status };
}

async function fixture(companionOrigin = origin) {
  const directory = await mkdtemp(join(tmpdir(), 'stereofold-recovery-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const devices = new RememberedDeviceStore({ directory, now: () => 1_000 });
  const first = await devices.issue(), second = await devices.issue();
  const address = new URL(companionOrigin);
  const lan = new LanCompanion({ certificateStore: directory, deviceStore: devices,
    interfaces: () => ({ en0: [{ address: address.hostname, family: 'IPv4' }] }),
    createCertificate: async () => ({ key: Buffer.from('fixture'), cert: Buffer.from('fixture'), fingerprint: 'fixture' }) });
  cleanups.push(() => lan.close());
  const opened = await lan.open({ url: `http://127.0.0.1:5000/#${'d'.repeat(64)}`, host: address.hostname, port: Number(address.port) });
  const server = vi.mocked(https.createServer).mock.results.at(-1)!.value as any;
  const status: LanStatus = { clients: [] };
  const bodies: any[] = [], pending: Promise<unknown>[] = [], pushes: string[] = [], lines: string[] = [];
  const fetch = (url: string, options: any) => {
    const work = new Promise<any>(resolve => {
      bodies.push(JSON.parse(options.body));
      const request = Object.assign(Readable.from([Buffer.from(options.body)]), {
        url, method: 'POST', headers: { host: address.host, origin: address.origin, 'content-type': 'application/json' },
        socket: { remoteAddress: '192.168.77.30' },
      });
      let statusCode = 0;
      const response = { setHeader: vi.fn(), writeHead: (code: number) => { statusCode = code; },
        end: (body: string) => {
          Object.assign(status, lan.status());
          resolve({ ok: statusCode === 200, status: statusCode, json: async () => JSON.parse(body) });
        } };
      server.handler(request, response);
    });
    pending.push(work);
    return work;
  };
  const drain = async () => { for (let i = 0; i < pending.length; i++) { await pending[i]; await flush(); } };
  const freshCode = vi.fn((id: string) => lan.recoverPairing(id));
  const controller = recoverableWebLaunch({ companion: opened,
    mode: preferredWebLaunch('code', false, (await devices.list()).length),
    send: link => { pushes.push(new URL(link).searchParams.get('url')!); return true; }, freshCode,
    recovered: () => lines.push('Sent a new notification.') });
  return { devices, lan, opened, first, second, status, bodies, pushes, lines, fetch, drain, controller, freshCode };
}

describe('Mac-side remembered headset recovery', () => {
  it.each([
    ['replacement headset (no key)', false, origin],
    ['cleared storage (unknown key)', true, origin],
    ['changed origin (no key at the new origin)', false, 'https://192.168.77.25:9443/'],
  ] as const)('%s pairs after one reported failure and a coded notification', async (_name, unknown, pageOrigin) => {
    const f = await fixture(pageOrigin);
    // The old origin/device still has a remembered record on the Mac.
    const oldStorage = new Map([['stereofold.device', JSON.stringify(f.first)]]);
    const storage = unknown ? new Map([['stereofold.device', JSON.stringify({ deviceId: 'f'.repeat(32), deviceKey: 'e'.repeat(64) })]]) : new Map<string, string>();
    f.controller.start();
    expect(f.pushes).toHaveLength(1);
    expect(f.pushes[0]).not.toContain('pair=');
    const firstPage = await page(f.pushes[0], storage, f.fetch);
    await f.drain();
    expect(firstPage.redirects).toEqual([]);
    expect(firstPage.form.hidden).toBe(true);
    expect(f.status.pairingFailure).toEqual({ launchId: f.opened.launchId, failure: unknown ? 'device_not_remembered' : 'device_key_missing' });
    await f.controller.observe(f.status);
    expect(f.pushes).toHaveLength(2);
    expect(f.pushes[1]).toMatch(/#pair=\d{8}$/);
    expect(f.pushes[1]).not.toContain(f.opened.pairingCode);
    expect(f.lines).toHaveLength(1);
    const recoveredPage = await page(f.pushes[1], storage, f.fetch);
    await f.drain();
    expect(recoveredPage.redirects).toEqual(['/viewer']);
    const remembered = JSON.parse(storage.get('stereofold.device')!);
    expect(remembered.deviceId).not.toBe(f.first.deviceId);
    expect((await f.devices.redeem(remembered.deviceId, remembered.deviceKey))?.id).toBe(remembered.deviceId);
    expect(oldStorage.has('stereofold.device')).toBe(true);
    await f.controller.observe(f.status);
    expect(f.pushes).toHaveLength(2);
  });

  it('chooses the second remembered device when only the second answers', async () => {
    const f = await fixture();
    expect((await f.devices.list()).map(device => device.id)).toEqual([f.first.deviceId, f.second.deviceId]);
    f.controller.start();
    const storage = new Map([['stereofold.device', JSON.stringify(f.second)]]);
    const opened = await page(f.pushes[0], storage, f.fetch);
    await f.drain();
    await f.controller.observe(f.status);
    expect(opened.redirects).toEqual(['/viewer']);
    expect(f.status.clients![0].deviceId).toBe(f.second.deviceId);
    expect(f.bodies).toEqual([{ deviceId: f.second.deviceId, deviceKey: f.second.deviceKey }]);
    expect(f.pushes).toHaveLength(1);
  });

  it('keeps a single send through silence, stale failures, repeated starts and concurrent recovery polls', async () => {
    const f = await fixture();
    f.controller.start(); f.controller.start();
    for (let i = 0; i < 100; i++) await f.controller.observe({ clients: [] });
    await f.controller.observe({ pairingFailure: { launchId: 'c'.repeat(32), failure: 'device_key_missing' } });
    expect(f.pushes).toHaveLength(1);
    expect(f.freshCode).not.toHaveBeenCalled();
    await f.fetch('/pair', { body: JSON.stringify({ launchId: f.opened.launchId, failure: 'device_key_missing' }) });
    const failure = f.status;
    await Promise.all([f.controller.observe(failure), f.controller.observe(failure)]);
    await f.controller.observe(failure);
    expect(f.pushes).toHaveLength(2);
    expect(f.freshCode).toHaveBeenCalledTimes(1);
    expect(await f.lan.recoverPairing(f.opened.launchId)).toBeUndefined();
    const repeated = await f.fetch('/pair', { body: JSON.stringify(failure.pairingFailure) });
    expect(repeated.status).toBe(409);
  });

  it('refuses unreported and stale failures and invalidates the old one-time code', async () => {
    const f = await fixture();
    expect(await f.lan.recoverPairing(f.opened.launchId)).toBeUndefined();
    const stale = await f.fetch('/pair', { body: JSON.stringify({ launchId, failure: 'device_key_missing' }) });
    expect(stale.status).toBe(409);
    await f.fetch('/pair', { body: JSON.stringify({ launchId: f.opened.launchId, failure: 'device_key_missing' }) });
    f.controller.start();
    await f.controller.observe(f.status);
    const expired = await f.fetch('/pair', { body: JSON.stringify({ code: f.opened.pairingCode, remember: true }) });
    expect(expired.status).toBe(401);
  });

  it('never relaunches a coded launch or a launch that already paired', async () => {
    const report: LanStatus = { pairingFailure: { launchId, failure: 'device_key_missing' } };
    for (const mode of ['code', 'no-code'] as const) {
      const send = vi.fn(() => true), freshCode = vi.fn(async () => '87654321');
      const controller = recoverableWebLaunch({ companion: { url: origin, launchId, pairingCode: '12345678' },
        mode, send, freshCode, recovered: vi.fn() });
      controller.start();
      if (mode === 'no-code') await controller.observe({ clients: [{ id: 'answered' }] });
      await controller.observe(report);
      expect(send).toHaveBeenCalledTimes(1);
      expect(freshCode).not.toHaveBeenCalled();
    }
  });

  it('does not announce a recovery when the Mac opener fails', async () => {
    const send = vi.fn().mockReturnValueOnce(true).mockReturnValue(false), recovered = vi.fn();
    const controller = recoverableWebLaunch({ companion: { url: origin, launchId }, mode: 'no-code',
      send, freshCode: async () => '87654321', recovered });
    controller.start();
    await controller.observe({ pairingFailure: { launchId, failure: 'device_key_missing' } });
    expect(send).toHaveBeenCalledTimes(2);
    expect(recovered).not.toHaveBeenCalled();
  });

  it('does not report a network error as an unknown key', async () => {
    const storage = new Map([['stereofold.device', JSON.stringify({ deviceId: 'a'.repeat(32), deviceKey: 'b'.repeat(64) })]]);
    const fetch = vi.fn(async () => { throw Error('offline'); });
    const opened = await page(`${origin}#launch=${launchId}`, storage, fetch);
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(opened.redirects).toEqual([]);
    expect(storage.has('stereofold.device')).toBe(true);
  });
});
