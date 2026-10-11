import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LanCompanion, listLanAddresses } from '../src/inspection-lan.js';

/**
 * A paired headset must keep its bearer for the whole
 * share.
 *
 * A healthy Quest re-paired 276 times in 49 minutes against a
 * share whose own hard stop was four hours away, and told its wearer "Share
 * ended" the whole time. The listener was answering 401 or 410 to a page it had
 * just paired, `inspector.ts` turned that into `repairNeeded`, and its repair
 * runs at most once every fifteen seconds — which is exactly the period in the
 * host log. Every repair minted a new bearer and a new panel, orphaning the
 * commands and replies bound to the old one.
 *
 * These tests drive the real `LanCompanion` over a real HTTPS socket with the
 * clock injected, a fake wearer that beats once a virtual second, and the page's
 * own repair rule copied from `inspector.ts:1693`. A share that stays open must
 * cost that wearer no repairs at all.
 */

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

function httpsCall(host: string, port: number, path: string,
  { method = 'GET', headers = {}, body, ca }: { method?: string; headers?: Record<string, string>; body?: string; ca: Buffer }) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = httpsRequest({ host, port, path, method, headers, ca, rejectUnauthorized: true }, response => {
      const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(Buffer.from(chunk))); response.once('error', reject);
      response.once('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.once('error', reject); if (body) request.write(body); request.end();
  });
}

const certificatePath = (directory: string, host: string) => join(directory, `${createHash('sha256').update(host).digest('hex')}.crt`);

/** The wearer's share, as the run had it: 30 min idle, 4 h ceiling. */
const IDLE_MS = 30 * 60 * 1000;
const CEILING_MS = 4 * 60 * 60 * 1000;
/** `inspector.ts:1694` — a page repairs at most this often. */
const REPAIR_THROTTLE_MS = 15_000;

describe('a paired headset keeps its bearer for the whole share', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); });

  async function share({ sessionLifetimeMs = IDLE_MS, sessionMaxLifetimeMs = CEILING_MS } = {}) {
    const lanAddress = listLanAddresses()[0];
    if (!lanAddress) return undefined; // A host with no private interface cannot run this integration fixture.
    const upstream = { status: 200 };
    const target = await listen((_request, response) => {
      response.writeHead(upstream.status, { 'content-type': 'application/json' });
      response.end(upstream.status === 200 ? '{"ok":true}' : JSON.stringify({ error: 'unauthorized' }));
    });
    cleanups.push(() => new Promise<void>(resolve => target.server.close(() => resolve())));
    const directory = await mkdtemp(join(tmpdir(), 'stereofold-share-bearer-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const now = { value: 0 };
    const port = await unusedPort(lanAddress.address);
    const lan = new LanCompanion({ certificateStore: directory, now: () => now.value, sessionLifetimeMs, sessionMaxLifetimeMs });
    cleanups.push(() => lan.close());
    const capability = (token: string) => `http://127.0.0.1:${target.port}/#${token}`;
    const opened = await lan.open({ url: capability('a'.repeat(64)), host: lanAddress.address, port });
    const ca = await readFile(certificatePath(directory, opened.host));
    const origin = `https://${opened.host}:${opened.port}`;
    const pair = (body: unknown) => httpsCall(opened.host, opened.port, '/pair',
      { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body), ca });
    const beat = (token: string) => httpsCall(opened.host, opened.port, '/tool',
      { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: 'poll_inspection', args: {} }), ca });
    return { lan, now, opened, ca, origin, pair, beat, upstream, capability, port, host: lanAddress.address };
  }

  /**
   * One document, exactly as `inspector.ts` runs it: beat every second, and on a
   * 401 or 410 set `repairNeeded` and redeem the remembered device key no more
   * than once every fifteen seconds.
   */
  function wearer(device: { deviceId: string; deviceKey: string }, token: string,
    io: { pair: (body: unknown) => Promise<{ status: number; body: string }>; beat: (token: string) => Promise<{ status: number; body: string }> }) {
    const seen: Array<{ at: number; status: number }> = [];
    let repairNeeded = false, nextRepairAt = 0, repairs = 0;
    return {
      get repairs() { return repairs; },
      get seen() { return seen; },
      get repairNeeded() { return repairNeeded; },
      get token() { return token; },
      async tick(at: number) {
        if (repairNeeded && at >= nextRepairAt) {
          nextRepairAt = at + REPAIR_THROTTLE_MS; repairs++;
          const again = await io.pair({ deviceId: device.deviceId, deviceKey: device.deviceKey });
          if (again.status === 200) { token = JSON.parse(again.body).token; repairNeeded = false; }
        }
        const answer = await io.beat(token);
        if (answer.status !== 200) seen.push({ at, status: answer.status });
        if (answer.status === 401 || answer.status === 410) repairNeeded = true;
        return answer;
      },
    };
  }

  it('costs a beating wearer no repairs across a share the desktop keeps re-opening and retargeting', async () => {
    const fixture = await share(); if (!fixture) return;
    const { lan, now, opened, pair, beat, capability, host, port } = fixture;
    const device = JSON.parse((await pair({ code: opened.pairingCode, remember: true })).body);
    expect(/^[a-f0-9]{64}$/.test(device.deviceKey)).toBe(true);
    const page = wearer(device, device.token, { pair, beat });

    // Ten virtual minutes. The host polls `manage_companion status` every three
    // seconds, and the agent side re-reads and re-opens the same capability the
    // way `quest-share.ts` and the converse loop do while a wearer is talking.
    for (let second = 1; second <= 10 * 60; second++) {
      now.value = second * 1000;
      await page.tick(now.value);
      if (second % 3 === 0) lan.status();
      if (second % 60 === 0) await lan.open({ url: capability('a'.repeat(64)), host, port });
      if (second % 90 === 0) await lan.retarget(capability('a'.repeat(64)));
    }
    expect(page.seen).toEqual([]);
    expect(page.repairs).toBe(0);
    expect(lan.status()?.clients).toHaveLength(1);
    // The share is still the one it opened on, and still renewing.
    expect(lan.status()?.sessionMaxExpiresAt).toBe(new Date(CEILING_MS).toISOString());
  }, 120_000);

  it('lets two pages on one remembered headset hold their own bearers instead of evicting each other', async () => {
    const fixture = await share(); if (!fixture) return;
    const { lan, now, opened, pair, beat } = fixture;
    const device = JSON.parse((await pair({ code: opened.pairingCode, remember: true })).body);
    const first = wearer(device, device.token, { pair, beat });
    const second = wearer(device, JSON.parse((await pair({ deviceId: device.deviceId, deviceKey: device.deviceKey })).body).token, { pair, beat });

    for (let tick = 1; tick <= 120; tick++) {
      now.value = tick * 1000;
      await first.tick(now.value);
      await second.tick(now.value);
    }
    expect(first.seen).toEqual([]);
    expect(second.seen).toEqual([]);
    expect(first.repairs + second.repairs).toBe(0);
    expect(lan.status()?.clients).toHaveLength(2);
  }, 60_000);

  it('names a stale loopback capability as a host fault, so the page reports it without re-pairing', async () => {
    const fixture = await share(); if (!fixture) return;
    const { now, opened, pair, beat, upstream } = fixture;
    const device = JSON.parse((await pair({ code: opened.pairingCode, remember: true })).body);
    const page = wearer(device, device.token, { pair, beat });
    now.value = 1_000;
    expect((await page.tick(now.value)).status).toBe(200);

    // The Mac's own source capability goes stale under a share that is still
    // open and still pairing. Before this fix the listener relayed the
    // loopback's 401 verbatim, the page read `companion_expired`, and it
    // re-paired every fifteen seconds for as long as the fault lasted.
    upstream.status = 401;
    for (let second = 2; second <= 90; second++) { now.value = second * 1000; await page.tick(now.value); }
    expect(page.repairNeeded).toBe(false);
    expect(page.repairs).toBe(0);
    expect(new Set(page.seen.map(entry => entry.status))).toEqual(new Set([409]));
    const refusal = await beat(page.token);
    expect(JSON.parse(refusal.body).error).toBe('source_unavailable');
    expect(JSON.parse(refusal.body).message).toMatch(/still open/);
    expect(JSON.parse(refusal.body).message).toMatch(/stays paired/);

    // And it is a fault, not a wall: the same bearer serves again the moment
    // the desktop's link is current.
    upstream.status = 200;
    now.value = 91_000;
    expect((await page.tick(now.value)).status).toBe(200);
    expect(page.repairs).toBe(0);
  }, 60_000);

  it('still retires pairings for a replaced capability, a closed share and an elapsed ceiling', async () => {
    const fixture = await share({ sessionLifetimeMs: 60_000, sessionMaxLifetimeMs: 100_000 }); if (!fixture) return;
    const { lan, now, opened, pair, beat, capability, host, port } = fixture;
    const device = JSON.parse((await pair({ code: opened.pairingCode, remember: true })).body);
    expect((await beat(device.token)).status).toBe(200);

    // A genuinely new loopback capability must not stay reachable through an
    // old pairing. This is the refusal `open_companion` depends on.
    now.value = 1_000;
    await lan.open({ url: capability('b'.repeat(64)), host, port });
    expect((await beat(device.token)).status).toBe(401);
    expect(lan.status()?.clients).toEqual([]);

    // The ceiling still ends a share that is being used every second.
    const again = JSON.parse((await pair({ deviceId: device.deviceId, deviceKey: device.deviceKey })).body);
    for (let second = 2; second <= 100; second++) { now.value = second * 1000; expect((await beat(again.token)).status).toBe(200); }
    // The re-open at 1 s was a new capability, so its ceiling runs from there.
    now.value = 101_001;
    expect(lan.status()).toBeUndefined();
    expect((await beat(again.token)).status).toBe(410);
  }, 60_000);

  it('still replaces a remembered headset’s idle capabilities, and bounds how many it can hold', async () => {
    const fixture = await share(); if (!fixture) return;
    const { lan, now, opened, pair, beat } = fixture;
    const device = JSON.parse((await pair({ code: opened.pairingCode, remember: true })).body);
    const redeem = async () => JSON.parse((await pair({ deviceId: device.deviceId, deviceKey: device.deviceKey })).body).token as string;

    // A page that reloads leaves its capability behind. Once it stops beating
    // for longer than the heartbeat grace, redemption takes it back.
    now.value = 61_000;
    const reloaded = await redeem();
    expect(lan.status()?.clients).toHaveLength(1);
    expect((await beat(device.token)).status).toBe(401);
    expect((await beat(reloaded)).status).toBe(200);

    // Live pages accumulate only up to the cap, dropping the least recently
    // used. Redemptions are spaced past the pairing-attempt window, which
    // admits six tries a minute from one address and is not what is under test.
    const held = [reloaded];
    for (let extra = 1; extra <= 4; extra++) {
      now.value = 61_000 + extra * 61_000;
      for (const token of held) expect((await beat(token)).status).toBe(200);
      held.push(await redeem());
    }
    expect(lan.status()!.clients).toHaveLength(4);
    expect((await beat(held[held.length - 1])).status).toBe(200);
    expect((await beat(held[0])).status).toBe(401);
  }, 60_000);
});
