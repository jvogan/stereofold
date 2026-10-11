import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { request as httpsRequest } from 'node:https';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createStereoStructureServer } from '../src/server.js';
import { listLanAddresses } from '../src/inspection-lan.js';
import { PRIVATE_INSPECTION_META_KEY as KEY } from '../src/inspection-contract.js';
import { createReplyAudioSynthesizer } from '../src/headset-reply-audio.js';

const host = listLanAddresses()[0]?.address;
const cif = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');

async function fixture(failFirst = false) {
  const folder = await mkdtemp(join(tmpdir(), 'stereofold-onboarding-retry-'));
  const savedStore = process.env.STEREOFOLD_LAN_CERTIFICATE_STORE;
  const savedRemember = process.env.STEREOFOLD_LAN_REMEMBER;
  process.env.STEREOFOLD_LAN_CERTIFICATE_STORE = join(folder, 'lan');
  process.env.STEREOFOLD_LAN_REMEMBER = '0';
  const probe = createServer();
  await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(0, host, resolve); });
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  await writeFile(join(folder, 'inspector.html'), '<html><script>void 0;</script></html>');
  let clock = Date.now(), launches = 0;
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createStereoStructureServer(join(folder, 'viewer.html'), {
    replyAudio: createReplyAudioSynthesizer({ enabled: false }),
    sceneServiceFile: join(folder, 'scene-service.json'), now: () => clock,
    headsetDevice: { env: { PATH: '' }, exists: async () => false,
      run: async () => { throw Error('Onboarding fixture must not contact a physical headset'); } },
    questLaunch: {
      platform: 'darwin', opener: '/fixture/opener', find: () => undefined,
      environment: { STEREOFOLD_CONFIG: join(folder, 'config.json'), PATH: '' },
      launch: () => ++launches === 1 && failFirst
        ? { reason: 'failed', detail: 'Fixture browser unavailable' } : { reason: 'started' },
      clipboardSpawn: () => {
        const stdin = new PassThrough();
        const child = Object.assign(new EventEmitter(), { stdin }) as unknown as ChildProcess;
        stdin.resume();
        stdin.once('finish', () => queueMicrotask(() => child.emit('close', 0)));
        return child;
      },
    },
  });
  const client = new Client({ name: 'Onboarding retry regression', version: '1' });
  const call = async (name: string, args: Record<string, unknown>) => {
    const result: any = await client.callTool({ name: `stereo_structure.${name}`, arguments: args });
    expect(result.isError, result.content?.[0]?.text).not.toBe(true);
    return result;
  };
  const close = async () => {
    await client.close(); await server.close();
    if (savedStore === undefined) delete process.env.STEREOFOLD_LAN_CERTIFICATE_STORE;
    else process.env.STEREOFOLD_LAN_CERTIFICATE_STORE = savedStore;
    if (savedRemember === undefined) delete process.env.STEREOFOLD_LAN_REMEMBER;
    else process.env.STEREOFOLD_LAN_REMEMBER = savedRemember;
    await rm(folder, { recursive: true, force: true });
  };
  try {
    await server.connect(b); await client.connect(a);
    const sessionId = (await call('inspect', { structureText: cif })).structuredContent.sessionId;
    const data = (await call('get_inspection', { sessionId }))._meta[KEY];
    await call('sync_inspection', { sessionId, serverEpoch: data.serverEpoch, sourceToken: data.sourceToken,
      baseStateRevision: data.stateRevision, baseInspectionRevision: data.inspectionRevision,
      scene: { sourceSha256: data.catalog.source.sha256, modelNumber: data.catalog.modelNumbers[0],
        assemblyId: data.catalog.assemblyId, selectionKeys: [data.catalog.rows[0].key],
        camera: { mode: 'perspective', fov: Math.PI / 4, position: [0, 0, 80], up: [0, 1, 0], target: [0, 0, 0], radius: 20, radiusMax: 20, fog: 50, clipFar: true, minNear: 5, minFar: 0 },
        inspection: { appearance: { representation: 'cartoon', color: 'uniform', uniformColor: '#44aaff', background: '#192734', opacity: 1, labels: false, highlightColor: '#ffccee', clipping: 0, fog: 0 },
          placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } } } });
    const open = (launch = 'web', headset = 'meta') => call('open_companion', {
      sessionId, connection: 'lan', lanHost: host, lanPort: port, headset, launch,
      // Meta instructions must return without turning a human handoff into a 20 s timeout.
      waitForHeadsetMs: 20000,
    });
    const pair = (code: string) => new Promise<number>((resolve, reject) => {
      const payload = JSON.stringify({ code });
      // Self-signed certificate on this fixture's disposable listener only.
      const request = httpsRequest({ host, port, path: '/pair', method: 'POST', rejectUnauthorized: false,
        headers: { origin: `https://${host}:${port}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, response => {
        response.resume(); response.once('end', () => resolve(response.statusCode ?? 0)); response.once('error', reject);
      });
      request.once('error', reject); request.end(payload);
    });
    return { open, pair, close, launches: () => launches, advance: (ms: number) => { clock += ms; },
      state: async () => (await call('get_inspection_state', { sessionId })).structuredContent,
      manage: (args: Record<string, unknown>) => call('manage_companion', { sessionId, ...args }) };
  } catch (error) { await close(); throw error; }
}

describe.skipIf(!host)('first-use headset launch recovery', () => {
  it('keeps the dispatched link valid through repeated completed setup calls', async () => {
    const f = await fixture();
    try {
      const first = await f.open();
      expect(first.content[0].text).toContain('Relay these steps once');
      expect(first.content[0].text).not.toContain('did not attach');
      const original = first.structuredContent.companion;
      f.advance(30_000);
      const repeated = await f.open();
      expect(repeated.structuredContent.companion).toMatchObject({ pairingCode: original.pairingCode,
        launchId: original.launchId, pairingExpiresAt: original.pairingExpiresAt });
      expect(repeated.structuredContent.launch.opened).toBe(false);
      expect(repeated.content[0].text).toContain('Press Open on the page already in your browser');
      expect(f.launches()).toBe(1);
      expect((await f.state()).wearer.note).toContain('launch was dispatched, but delivery is unconfirmed');
      expect(await f.pair(original.pairingCode)).toBe(200);
      const loading = await f.open();
      expect(loading.content[0].text).toContain('A headset has already paired');
      expect(loading.content[0].text).not.toContain('Use Manual pairing');
      // A spent code still rotates, while the previously paired client survives.
      const spent = (await f.open('none')).structuredContent.companion;
      expect(spent.pairingCode).not.toBe(original.pairingCode);
      expect(spent.clients).toHaveLength(1);
      expect(await f.pair(original.pairingCode)).toBe(401);
      expect(await f.pair(spent.pairingCode)).toBe(200);
    } finally { await f.close(); }
  }, 15_000);

  it('gives a launch action for a manual-only share instead of waiting for an unsent launch', async () => {
    const f = await fixture();
    try {
      await f.open('none');
      const wearer = (await f.state()).wearer;
      expect(wearer).toMatchObject({ shareOpen: true, linked: false, state: 'no-page' });
      expect(wearer.note).toContain('No current headset launch is pending');
      expect(wearer.note).toContain('manage_companion action="launch"');
      expect(f.launches()).toBe(0);
    } finally { await f.close(); }
  });

  it('allows immediate dispatch recovery and updates the wearer advice after a failed opener', async () => {
    const f = await fixture(true);
    try {
      expect((await f.open()).structuredContent.launch.reason).toBe('failed');
      expect((await f.state()).wearer.note).toContain('No current headset launch is pending');
      const retried = await f.manage({ action: 'launch', launch: 'auto' });
      expect(retried.structuredContent.launch.opened).toBe(true);
      expect(f.launches()).toBe(2);
      expect((await f.state()).wearer.note).toContain('launch was dispatched, but delivery is unconfirmed');
    } finally { await f.close(); }
  });

  it('renews an expired code without treating the expired dispatch as pending', async () => {
    const f = await fixture();
    try {
      const original = (await f.open()).structuredContent.companion;
      f.advance(600_001);
      expect((await f.state()).wearer.note).toContain('No current headset launch is pending');
      expect((await f.state()).wearer.note).toContain('obtain a fresh code');
      const renewed = (await f.open()).structuredContent.companion;
      expect(renewed.launchId).not.toBe(original.launchId);
      expect(await f.pair(original.pairingCode)).toBe(401);
      expect(await f.pair(renewed.pairingCode)).toBe(200);
    } finally { await f.close(); }
  });

  it('keeps a Vision Pro clipboard handoff pending beyond the first minute', async () => {
    const f = await fixture();
    try {
      const opened = await f.open('auto', 'apple');
      expect(opened.structuredContent.launch).toMatchObject({ target: 'apple', handoff: 'clipboard', opened: false });
      f.advance(120_000);
      const note = (await f.state()).wearer.note;
      expect(note).toContain('Vision Pro link is on the clipboard');
      expect(note).toContain('until pairing or pairingExpiresAt');
      expect(note).not.toContain('No current headset launch is pending');
      expect(f.launches()).toBe(0);
      expect(await f.pair(opened.structuredContent.companion.pairingCode)).toBe(200);
    } finally { await f.close(); }
  });

  it('keeps the working Web Launch link when a subsequent adb attempt fails', async () => {
    const f = await fixture();
    try {
      const first = await f.open();
      const failed = await f.manage({ action: 'launch', launch: 'adb' });
      expect(failed.structuredContent.launch.opened).toBe(false);
      expect((await f.state()).wearer.note).toContain('launch was dispatched, but delivery is unconfirmed');
      f.advance(61_000);
      const resent = await f.open();
      expect(resent.structuredContent.companion.pairingCode).toBe(first.structuredContent.companion.pairingCode);
      expect(f.launches()).toBe(2);
      expect(await f.pair(first.structuredContent.companion.pairingCode)).toBe(200);
    } finally { await f.close(); }
  });

  it('does not point at an old browser link after closing and reopening the share', async () => {
    const f = await fixture();
    try {
      await f.open(); await f.manage({ action: 'close' });
      const newShare = await f.open();
      expect(newShare.structuredContent.launch.opened).toBe(false);
      expect(newShare.content[0].text).toContain('previous link does not belong to this pairing attempt');
      expect(newShare.content[0].text).not.toContain('Press Open on the page already');
      expect((await f.state()).wearer.note).toContain('No current headset launch is pending');
      expect(f.launches()).toBe(1);
    } finally { await f.close(); }
  });

  it('confirms stop sharing and reports a closed listener on later status calls', async () => {
    const f = await fixture();
    try {
      const opened = await f.open('none');
      expect(await f.pair(opened.structuredContent.companion.pairingCode)).toBe(200);
      const stopped = await f.manage({ action: 'close' });
      expect(stopped.structuredContent).toMatchObject({ shareClosed: true, lan: null,
        wearer: { shareOpen: false, share: false, linked: false } });
      expect(stopped.content[0].text).toContain('Sharing stopped');
      expect(stopped.content[0].text).toContain('paired devices are disconnected');
      const status = await f.manage({ action: 'status' });
      expect(status.structuredContent.lan).toBeNull();
      expect(status.structuredContent.rememberedDevices).toEqual([]);
      expect(status.content[0].text).toContain('The private Wi-Fi share is closed');
      expect(status.content[0].text).not.toContain('re-pairs without a code');
      await expect(f.pair(opened.structuredContent.companion.pairingCode)).rejects.toThrow();
    } finally { await f.close(); }
  });
});
