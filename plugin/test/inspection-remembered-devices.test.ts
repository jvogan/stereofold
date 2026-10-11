import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LanCompanion, listLanAddresses } from '../src/inspection-lan.js';
import { deviceLabel, rememberingEnabled, RememberedDeviceStore } from '../src/inspection-remembered-devices.js';

const KEY = /^[a-f0-9]{64}$/, ID = /^[a-f0-9]{32}$/;

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
  const address = server.address(); if (!address || typeof address === 'string') throw Error('loopback fixture did not bind');
  return { server, port: address.port };
}

async function unusedPort(host: string) {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(0, host, () => resolve()); });
  const address = probe.address(); if (!address || typeof address === 'string') throw Error('LAN fixture did not bind');
  await new Promise<void>(resolve => probe.close(() => resolve()));
  return address.port;
}

async function httpsCall(host: string, port: number, path: string, { method = 'GET', headers = {}, body, ca }: { method?: string; headers?: Record<string, string>; body?: string; ca: Buffer }) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = httpsRequest({ host, port, path, method, headers, ca, rejectUnauthorized: true }, response => {
      const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(Buffer.from(chunk))); response.once('error', reject);
      response.once('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.once('error', reject); if (body) request.write(body); request.end();
  });
}

function certificatePath(directory: string, host: string) { return join(directory, `${createHash('sha256').update(host).digest('hex')}.crt`); }

describe('remembered device store', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); });

  async function store(options: Partial<ConstructorParameters<typeof RememberedDeviceStore>[0]> = {}) {
    const directory = await mkdtemp(join(tmpdir(), 'stereofold-devices-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    return { directory, devices: new RememberedDeviceStore({ directory, ...options }) };
  }

  it('issues a key, redeems it once remembered, and refuses an unknown device', async () => {
    const { devices } = await store();
    const issued = await devices.issue('Mozilla/5.0 (X11; Linux x86_64; Quest 3) OculusBrowser/34.1 Chrome/126');
    expect(issued.deviceId).toMatch(ID);
    expect(issued.deviceKey).toMatch(KEY);
    expect(issued.label).toBe('Meta Quest Browser 34');
    const redeemed = await devices.redeem(issued.deviceId, issued.deviceKey);
    expect(redeemed?.id).toBe(issued.deviceId);
    expect(await devices.list()).toEqual([expect.objectContaining({ id: issued.deviceId, label: 'Meta Quest Browser 34' })]);
    expect(await devices.redeem('f'.repeat(32), issued.deviceKey)).toBeUndefined();
    expect(await devices.redeem(issued.deviceId, 'x'.repeat(64))).toBeUndefined();
    expect(await devices.redeem(issued.deviceId, 'not a key')).toBeUndefined();
  });

  it('refuses a tampered key and one issued to a different device', async () => {
    const { devices } = await store();
    const first = await devices.issue('OculusBrowser/34.1');
    const second = await devices.issue('OculusBrowser/34.1');
    // The right key against the wrong id, and one flipped character of the
    // right key, both fail: the digest comparison is per record and exact.
    expect(await devices.redeem(first.deviceId, second.deviceKey)).toBeUndefined();
    const tampered = `${first.deviceKey.slice(0, 63)}${first.deviceKey.endsWith('a') ? 'b' : 'a'}`;
    expect(await devices.redeem(first.deviceId, tampered)).toBeUndefined();
    expect((await devices.redeem(first.deviceId, first.deviceKey))?.id).toBe(first.deviceId);
  });

  it('stores only a digest, in a 0600 file, and never the key itself', async () => {
    const { directory, devices } = await store();
    const issued = await devices.issue('OculusBrowser/34.1');
    const path = join(directory, 'remembered-devices.json');
    expect(devices.path).toBe(path);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const text = await readFile(path, 'utf8');
    expect(text).not.toContain(issued.deviceKey);
    expect(JSON.parse(text).devices[0].keyHash).toBe(createHash('sha256').update(issued.deviceKey, 'utf8').digest('hex'));
  });

  it('stops redeeming a key past its expiry and drops it from the list', async () => {
    const clock = { value: 1_000 };
    const { devices } = await store({ now: () => clock.value, lifetimeMs: 30 * 24 * 60 * 60 * 1000 });
    const issued = await devices.issue('OculusBrowser/34.1');
    // Keep this device active while testing the separate absolute lifetime.
    for (const day of [13, 26]) {
      clock.value = 1_000 + day * 86_400_000;
      expect(await devices.redeem(issued.deviceId, issued.deviceKey)).toBeDefined();
    }
    clock.value = issued.expiresAt - 1;
    expect(await devices.redeem(issued.deviceId, issued.deviceKey)).toBeDefined();
    clock.value = issued.expiresAt + 1;
    expect(await devices.redeem(issued.deviceId, issued.deviceKey)).toBeUndefined();
    expect(await devices.list()).toEqual([]);
  });

  it('expires unseen keys after fourteen days and accepts the second device that answers', async () => {
    let now = 1_000;
    const { devices } = await store({ now: () => now });
    const first = await devices.issue(), second = await devices.issue();
    expect((await devices.list()).map(device => device.id)).toEqual([first.deviceId, second.deviceId]);
    now += 13 * 86_400_000;
    expect((await devices.redeem(second.deviceId, second.deviceKey))?.id).toBe(second.deviceId);
    now += 86_400_000;
    expect(await devices.redeem(first.deviceId, first.deviceKey)).toBeUndefined();
    expect((await devices.list()).map(device => device.id)).toEqual([second.deviceId]);
  });

  it('applies a configured idle timeout across store reloads', async () => {
    let now = 1_000;
    const { devices, directory } = await store({ now: () => now, idleTimeoutMs: 2_000 });
    const issued = await devices.issue();
    now += 2_000;
    const reopened = new RememberedDeviceStore({ directory, now: () => now, idleTimeoutMs: 2_000 });
    expect(await reopened.list()).toEqual([]);
    expect(await reopened.redeem(issued.deviceId, issued.deviceKey)).toBeUndefined();
  });

  it('forgets one device and every device, leaving the others usable', async () => {
    const { devices } = await store();
    const kept = await devices.issue('OculusBrowser/34.1'), removed = await devices.issue('OculusBrowser/34.1');
    expect(await devices.forget(removed.deviceId)).toEqual([removed.deviceId]);
    expect(await devices.redeem(removed.deviceId, removed.deviceKey)).toBeUndefined();
    expect((await devices.redeem(kept.deviceId, kept.deviceKey))?.id).toBe(kept.deviceId);
    expect(await devices.forget('all')).toEqual([kept.deviceId]);
    expect(await devices.list()).toEqual([]);
    expect(await devices.forget('all')).toEqual([]);
  });

  it('treats a missing, oversized, unparsable or symlinked file as no remembered devices', async () => {
    const { directory, devices } = await store();
    expect(await devices.list()).toEqual([]);
    await writeFile(devices.path, 'not json', { mode: 0o600 });
    expect(await devices.list()).toEqual([]);
    await rm(devices.path, { force: true });
    const victim = join(directory, 'victim');
    await writeFile(victim, JSON.stringify({ devices: [] }), { mode: 0o600 });
    await symlink(victim, devices.path);
    expect(await devices.list()).toEqual([]);
  });

  it('reads the remembering switch and labels unknown browsers without echoing control characters', () => {
    expect(rememberingEnabled({} as NodeJS.ProcessEnv)).toBe(true);
    expect(rememberingEnabled({ STEREOFOLD_LAN_REMEMBER: '0' } as NodeJS.ProcessEnv)).toBe(false);
    expect(deviceLabel(undefined)).toBe('Unrecognized browser');
    expect(deviceLabel('evil\nagent')).toBe('evil agent');
    expect(deviceLabel('x'.repeat(400)).length).toBe(60);
  });
});

describe('remembered headsets on the LAN listener', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); });

  async function fixture(remember: boolean) {
    const lanAddress = listLanAddresses()[0];
    if (!lanAddress) return undefined; // A host with no private interface cannot run this listener fixture.
    const target = await listen((_request, response) => response.end('data_local'));
    cleanups.push(() => new Promise(resolve => target.server.close(() => resolve())));
    const directory = await mkdtemp(join(tmpdir(), 'stereofold-remember-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    // Redemption now depends on how recently a capability was
    // used, so this fixture carries a clock a test can move.
    const clock = { value: Date.now() };
    const lan = new LanCompanion({ certificateStore: directory, remember, now: () => clock.value });
    cleanups.push(() => lan.close());
    const opened = await lan.open({ url: `http://127.0.0.1:${target.port}/#${'a'.repeat(64)}`, host: lanAddress.address, port: await unusedPort(lanAddress.address) });
    const ca = await readFile(certificatePath(directory, opened.host));
    const origin = `https://${opened.host}:${opened.port}`;
    const post = (body: unknown) => httpsCall(opened.host, opened.port, '/pair', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'User-Agent': 'OculusBrowser/34.1' }, body: JSON.stringify(body), ca });
    const source = (token: string) => httpsCall(opened.host, opened.port, '/source', { headers: { Authorization: `Bearer ${token}` }, ca });
    return { lan, directory, opened, ca, post, source, clock };
  }

  it('consumes a matching failure once and pairs the replacement with a fresh code', async () => {
    const context = await fixture(true); if (!context) return;
    const { lan, opened, post } = context;
    expect(await lan.recoverPairing(opened.launchId)).toBeUndefined();
    expect((await post({ launchId: '0'.repeat(32), failure: 'device_key_missing' })).status).toBe(409);
    const report = { launchId: opened.launchId, failure: 'device_key_missing' };
    expect((await post(report)).status).toBe(200);
    expect(lan.status()?.pairingFailure).toEqual(report);
    const code = await lan.recoverPairing(opened.launchId);
    expect(code).toMatch(/^\d{8}$/);
    expect(code).not.toBe(opened.pairingCode);
    expect(await lan.recoverPairing(opened.launchId)).toBeUndefined();
    expect((await post(report)).status).toBe(409);
    expect((await post({ code: opened.pairingCode, remember: true })).status).toBe(401);
    const paired = JSON.parse((await post({ code, remember: true })).body);
    expect(paired.deviceKey).toMatch(KEY);
    expect((await lan.rememberedDevices()).map(device => device.id)).toContain(paired.deviceId);
  });

  it('hands a paired headset a device key it can redeem later without a code', async () => {
    const context = await fixture(true); if (!context) return;
    const paired = JSON.parse((await context.post({ code: context.opened.pairingCode, remember: true })).body);
    expect(paired.deviceId).toMatch(ID);
    expect(paired.deviceKey).toMatch(KEY);
    expect((await context.source(paired.token)).body).toBe('data_local');

    // The code is spent, and the remembered key still opens a fresh session.
    expect((await context.post({ code: context.opened.pairingCode })).status).toBe(401);
    const returning = JSON.parse((await context.post({ deviceId: paired.deviceId, deviceKey: paired.deviceKey })).body);
    expect(returning.token).toMatch(KEY);
    expect(returning.token).not.toBe(paired.token);
    expect(returning.deviceKey).toBeUndefined();
    expect((await context.source(returning.token)).body).toBe('data_local');

    // This used to revoke the earlier capability outright, on
    // the reading that one headset is one page. It is not: the wearer's Quest
    // ran a page that was still beating, and evicting it here made that page
    // re-pair, which evicted this one, four times a minute for forty-nine
    // minutes under a share with hours left on it. A capability
    // used inside the heartbeat grace is a page that is still there and keeps
    // working; one that has gone quiet past it is still replaced.
    expect((await context.source(paired.token)).body).toBe('data_local');
    expect(context.lan.status()?.clients).toHaveLength(2);
    context.clock.value += 60_001;
    const later = JSON.parse((await context.post({ deviceId: paired.deviceId, deviceKey: paired.deviceKey })).body);
    expect((await context.source(later.token)).body).toBe('data_local');
    expect((await context.source(paired.token)).status).toBe(401);
    expect((await context.source(returning.token)).status).toBe(401);
    expect(context.lan.status()?.clients).toEqual([expect.objectContaining({ id: later.clientId, deviceId: paired.deviceId })]);
    expect(await context.lan.rememberedDevices()).toEqual([expect.objectContaining({ id: paired.deviceId, label: 'Meta Quest Browser 34' })]);
  });

  it('refuses a wrong key, an unknown device and a forgotten one, and ends the forgotten session', async () => {
    const context = await fixture(true); if (!context) return;
    const paired = JSON.parse((await context.post({ code: context.opened.pairingCode, remember: true })).body);
    expect((await context.post({ deviceId: paired.deviceId, deviceKey: 'b'.repeat(64) })).status).toBe(401);
    expect((await context.post({ deviceId: 'c'.repeat(32), deviceKey: paired.deviceKey })).status).toBe(401);
    expect((await context.post({ deviceId: paired.deviceId })).status).toBe(400);

    expect(await context.lan.forgetDevices(paired.deviceId)).toEqual([paired.deviceId]);
    expect(await context.lan.rememberedDevices()).toEqual([]);
    expect(context.lan.status()?.clients).toEqual([]);
    expect((await context.source(paired.token)).status).toBe(401);
    expect((await context.post({ deviceId: paired.deviceId, deviceKey: paired.deviceKey })).status).toBe(401);
  });

  it('issues no key when remembering is off, and still pairs with the code', async () => {
    const context = await fixture(false); if (!context) return;
    expect(context.lan.remembering).toBe(false);
    const paired = JSON.parse((await context.post({ code: context.opened.pairingCode, remember: true })).body);
    expect(paired.token).toMatch(KEY);
    expect(paired.deviceKey).toBeUndefined();
    expect(await context.lan.rememberedDevices()).toEqual([]);
    expect((await context.post({ deviceId: 'd'.repeat(32), deviceKey: 'e'.repeat(64) })).status).toBe(401);
    await expect(context.lan.forgetDevices('all')).resolves.toEqual([]);
  });

  it('drops a remembered session when the listener is reused, so a device key never revives an old capability', async () => {
    const context = await fixture(true); if (!context) return;
    const paired = JSON.parse((await context.post({ code: context.opened.pairingCode, remember: true })).body);
    const target = await listen((_request, response) => response.end('second'));
    cleanups.push(() => new Promise(resolve => target.server.close(() => resolve())));
    const reopened = await context.lan.open({ url: `http://127.0.0.1:${target.port}/#${'b'.repeat(64)}`, host: context.opened.host, port: context.opened.port });
    expect(context.lan.status()?.clients).toEqual([]);
    expect((await context.source(paired.token)).status).toBe(401);
    // The remembered key opens a session on the listener that is live now, and
    // only that one; it never starts or reclaims a listener of its own.
    const returning = JSON.parse((await context.post({ deviceId: paired.deviceId, deviceKey: paired.deviceKey })).body);
    expect((await context.source(returning.token)).body).toBe('second');
    expect(reopened.pairingCode).not.toBe(context.opened.pairingCode);
  });
});
