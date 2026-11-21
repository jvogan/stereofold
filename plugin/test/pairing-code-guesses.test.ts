import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { LanCompanion, listLanAddresses } from '../src/inspection-lan.js';
import { createStereoStructureServer } from '../src/server.js';
import { PRIVATE_INSPECTION_META_KEY as KEY } from '../src/inspection-contract.js';
import { createReplyAudioSynthesizer } from '../src/headset-reply-audio.js';

/**
 * One pairing code takes at most 30 wrong guesses in total, whichever
 * addresses they come from. After that the code is spent: it is refused the
 * way an expired code is, and pairing needs a newly issued code. The
 * per-address limit of six tries a minute still applies, and a remembered
 * headset's key neither counts against the code nor is blocked by it.
 *
 * The clock is injected and moved ten seconds before every request, so no
 * request here meets the per-address limit unless a test asks for it.
 */

const lanAddress = listLanAddresses()[0];

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

function httpsCall(host: string, port: number, path: string, { method = 'GET', headers = {}, body, ca }: { method?: string; headers?: Record<string, string>; body?: string; ca: Buffer }) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = httpsRequest({ host, port, path, method, headers, ca, rejectUnauthorized: true }, response => {
      const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(Buffer.from(chunk))); response.once('error', reject);
      response.once('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.once('error', reject); if (body) request.write(body); request.end();
  });
}

const certificatePath = (directory: string, host: string) => join(directory, `${createHash('sha256').update(host).digest('hex')}.crt`);
const wrong = (code: string) => code === '10000000' ? '10000001' : '10000000';
const STEP_MS = 10_001;
const REFUSED = { status: 401, body: JSON.stringify({ error: 'invalid_code' }) };

describe.skipIf(!lanAddress)('a pairing code under repeated wrong guesses', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

  async function share(options: { pairingLifetimeMs?: number } = {}) {
    const target = await listen((_request, response) => response.end('ok'));
    cleanups.push(() => new Promise<void>(resolve => target.server.close(() => resolve())));
    const directory = await mkdtemp(join(tmpdir(), 'stereofold-pairing-guesses-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const clock = { value: 1_000_000 };
    const lan = new LanCompanion({ certificateStore: directory, now: () => clock.value, remember: true,
      sessionLifetimeMs: 4 * 60 * 60 * 1000, sessionMaxLifetimeMs: 8 * 60 * 60 * 1000, ...options });
    cleanups.push(() => lan.close());
    const opened = await lan.open({ url: `http://127.0.0.1:${target.port}/#${'a'.repeat(64)}`, host: lanAddress!.address, port: await unusedPort(lanAddress!.address) });
    const ca = await readFile(certificatePath(directory, opened.host));
    const origin = `https://${opened.host}:${opened.port}`;
    const post = (body: unknown, step = STEP_MS) => {
      clock.value += step;
      return httpsCall(opened.host, opened.port, '/pair', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body), ca });
    };
    return { lan, clock, opened, post };
  }

  it('spends a code after 30 wrong guesses across rate-limit windows and refuses it as an expired code', async () => {
    const { lan, clock, opened, post } = await share();
    const code = opened.pairingCode;
    for (let guess = 1; guess <= 30; guess++) expect(await post({ code: wrong(code) })).toEqual(REFUSED);
    // The right code now gets the expired-code answer, and the share reports
    // the code as past its deadline, which is how the desktop learns of it.
    expect(await post({ code, remember: true })).toEqual(REFUSED);
    expect(Date.parse(lan.status()!.pairingExpiresAt)).toBeLessThanOrEqual(clock.value);
    expect(lan.status()!.clients).toEqual([]);

    // A newly issued code pairs, with its own allowance.
    const fresh = await lan.pairingCode();
    expect(fresh).toMatch(/^\d{8}$/);
    for (let guess = 1; guess <= 29; guess++) expect(await post({ code: wrong(fresh!) })).toEqual(REFUSED);
    expect((await post({ code: fresh })).status).toBe(200);
  }, 60_000);

  it('still pairs a correct code after 29 wrong guesses, and keeps the per-address limit', async () => {
    const { opened, post } = await share();
    const code = opened.pairingCode;
    for (let guess = 1; guess <= 29; guess++) expect(await post({ code: wrong(code) })).toEqual(REFUSED);
    // Six tries a minute from one address: the seventh inside a minute is
    // refused before its code is read, so it is not a guess against the code.
    for (let attempt = 1; attempt <= 6; attempt++) expect((await post({ unrelated: true }, attempt === 1 ? 61_000 : 0)).status).toBe(400);
    expect((await post({ code }, 0)).status).toBe(429);
    expect((await post({ code }, 61_000)).status).toBe(200);
  }, 60_000);

  it('neither counts a remembered headset’s key against the code nor blocks it once the code is spent', async () => {
    const { lan, opened, post } = await share({ pairingLifetimeMs: 60 * 60 * 1000 });
    const device = JSON.parse((await post({ code: opened.pairingCode, remember: true })).body);
    expect(device.deviceKey).toMatch(/^[a-f0-9]{64}$/);

    const code = (await lan.pairingCode())!;
    for (let attempt = 1; attempt <= 30; attempt++)
      expect((await post({ deviceId: device.deviceId, deviceKey: 'f'.repeat(64) })).status).toBe(401);
    for (let attempt = 1; attempt <= 5; attempt++)
      expect((await post({ deviceId: device.deviceId, deviceKey: device.deviceKey })).status).toBe(200);
    for (let guess = 1; guess <= 29; guess++) expect(await post({ code: wrong(code) })).toEqual(REFUSED);
    expect((await post({ code })).status).toBe(200);

    const spent = (await lan.pairingCode())!;
    for (let guess = 1; guess <= 30; guess++) expect(await post({ code: wrong(spent) })).toEqual(REFUSED);
    expect(await post({ code: spent })).toEqual(REFUSED);
    expect((await post({ deviceId: device.deviceId, deviceKey: device.deviceKey })).status).toBe(200);
  }, 60_000);
});

describe.skipIf(!lanAddress)('what the desktop is told about a spent pairing code', () => {
  it('gives a spent code the expired-code note and a fresh code on the next open, as for an expired one', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'stereofold-pairing-guesses-host-'));
    const savedStore = process.env.STEREOFOLD_LAN_CERTIFICATE_STORE;
    process.env.STEREOFOLD_LAN_CERTIFICATE_STORE = join(folder, 'lan');
    await writeFile(join(folder, 'inspector.html'), '<html><script>void 0;</script></html>');
    const host = lanAddress!.address, port = await unusedPort(host);
    let clock = Date.now();
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = createStereoStructureServer(join(folder, 'viewer.html'), {
      replyAudio: createReplyAudioSynthesizer({ enabled: false }),
      sceneServiceFile: join(folder, 'scene-service.json'), now: () => clock,
      headsetDevice: { env: { PATH: '' }, exists: async () => false,
        run: async () => { throw Error('Pairing fixture must not contact a physical headset'); } },
    });
    const client = new Client({ name: 'Spent pairing code regression', version: '1' });
    try {
      await server.connect(b); await client.connect(a);
      const call = async (name: string, args: Record<string, unknown>) => {
        const result: any = await client.callTool({ name: `stereo_structure.${name}`, arguments: args });
        expect(result.isError, result.content?.[0]?.text).not.toBe(true);
        return result;
      };
      const cif = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');
      const sessionId = (await call('inspect', { structureText: cif })).structuredContent.sessionId;
      const data = (await call('get_inspection', { sessionId }))._meta[KEY];
      await call('sync_inspection', { sessionId, serverEpoch: data.serverEpoch, sourceToken: data.sourceToken,
        baseStateRevision: data.stateRevision, baseInspectionRevision: data.inspectionRevision,
        scene: { sourceSha256: data.catalog.source.sha256, modelNumber: data.catalog.modelNumbers[0],
          assemblyId: data.catalog.assemblyId, selectionKeys: [data.catalog.rows[0].key],
          camera: { mode: 'perspective', fov: Math.PI / 4, position: [0, 0, 80], up: [0, 1, 0], target: [0, 0, 0], radius: 20, radiusMax: 20, fog: 50, clipFar: true, minNear: 5, minFar: 0 },
          inspection: { appearance: { representation: 'cartoon', color: 'uniform', uniformColor: '#44aaff', background: '#192734', opacity: 1, labels: false, highlightColor: '#ffccee', clipping: 0, fog: 0 },
            placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } } } });
      const open = async () => (await call('open_companion', { sessionId, connection: 'lan', lanHost: host, lanPort: port, launch: 'none', headset: 'auto' })).structuredContent.companion;
      const note = async () => (await call('get_inspection_state', { sessionId })).structuredContent.wearer.note as string;
      let ca = Buffer.alloc(0);
      const pair = (code: string) => {
        clock += STEP_MS;
        return httpsCall(host, port, '/pair', { method: 'POST', headers: { Origin: `https://${host}:${port}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ code }), ca });
      };

      // The note an expired code produces today.
      const expiring = await open();
      ca = await readFile(certificatePath(join(folder, 'lan'), host));
      clock += 600_001;
      const expiredNote = await note();
      expect(expiredNote).toContain('The pairing code has expired');
      const renewed = await open();
      expect(renewed.pairingCode).not.toBe(expiring.pairingCode);

      // A spent code produces the same note and is replaced the same way.
      for (let guess = 1; guess <= 30; guess++) expect(await pair(wrong(renewed.pairingCode))).toEqual(REFUSED);
      expect(await pair(renewed.pairingCode)).toEqual(REFUSED);
      expect(await note()).toBe(expiredNote);
      const fresh = await open();
      expect(fresh.pairingCode).not.toBe(renewed.pairingCode);
      expect((await pair(fresh.pairingCode)).status).toBe(200);
    } finally {
      await client.close(); await server.close();
      if (savedStore === undefined) delete process.env.STEREOFOLD_LAN_CERTIFICATE_STORE;
      else process.env.STEREOFOLD_LAN_CERTIFICATE_STORE = savedStore;
      await rm(folder, { recursive: true, force: true });
    }
  }, 60_000);
});
