import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createStereoStructureServer } from '../src/server.js';
import { listLanAddresses } from '../src/inspection-lan.js';
import { PRIVATE_INSPECTION_META_KEY as KEY } from '../src/inspection-contract.js';
import { createReplyAudioSynthesizer } from '../src/headset-reply-audio.js';

/**
 * A wearer who takes the headset off for longer than the session lifetime
 * stops every heartbeat. The agent still sits in `listen_voice`, and the
 * session it will act on next must still be there when the wearer is back.
 */

const cif = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');
const TTL_MS = 60_000;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** Hears nothing, and spends each wait on the test clock rather than in real time. */
function quietTranscriber(clock: { ms: number }) {
  return {
    enabled: true, ready: true, route: 'whisper' as const, describe: () => 'quiet test transcriber', missing: () => [],
    startupLine: () => '', dispose: async () => {},
    accept: async () => { throw Error('This test records no audio.'); },
    transcripts: {
      get cursor() { return 0; },
      async since(_after: number, { waitMs = 0 }: { waitMs?: number } = {}) { clock.ms += waitMs; return { cursor: 0, entries: [] }; },
    },
  } as any;
}

async function unusedPort(host: string) {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(0, host, () => resolve()); });
  const address = probe.address(); if (!address || typeof address === 'string') throw Error('LAN fixture did not bind');
  await new Promise<void>(resolve => probe.close(() => resolve()));
  return address.port;
}

async function host(sessionTtlMs = TTL_MS) {
  const dist = await mkdtemp(join(tmpdir(), 'stereofold-keepalive-'));
  cleanups.push(() => rm(dist, { recursive: true, force: true }));
  await writeFile(join(dist, 'viewer.html'), '<html><script>void 0;</script></html>');
  await writeFile(join(dist, 'inspector.html'), '<html><script>void 0;</script></html>');
  await mkdir(join(dist, 'molstar'), { recursive: true });
  const clock = { ms: Date.now() };
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createStereoStructureServer(join(dist, 'viewer.html'), { now: () => clock.ms, sessionTtlMs,
    sceneServiceFile: join(dist, 'scene-service.json'),
    transcriber: quietTranscriber(clock), replyAudio: createReplyAudioSynthesizer({ enabled: false }) });
  const client = new Client({ name: 'Session keep-alive test', version: '1' });
  await server.connect(b); await client.connect(a);
  cleanups.push(async () => { await client.close(); await server.close(); });
  const call = async (name: string, args: Record<string, unknown>) =>
    await client.callTool({ name: `stereo_structure.${name}`, arguments: args }) as any;
  /** A saved inspection, as a headset page would find it. */
  async function open() {
    const sessionId = (await call('inspect', { structureText: cif })).structuredContent.sessionId as string;
    const data = (await call('get_inspection', { sessionId }))._meta[KEY];
    const scene = { sourceSha256: data.catalog.source.sha256, modelNumber: data.catalog.modelNumbers[0], assemblyId: data.catalog.assemblyId,
      selectionKeys: [] as string[],
      camera: { mode: 'perspective', fov: Math.PI / 4, position: [0, 0, 80], up: [0, 1, 0], target: [0, 0, 0], radius: 20, radiusMax: 20, fog: 50, clipFar: true, minNear: 5, minFar: 0 },
      inspection: {
        appearance: { representation: 'cartoon', color: 'uniform', uniformColor: '#44aaff', background: '#192734', opacity: 1, labels: false, highlightColor: '#ffccee', clipping: 0, fog: 0 },
        placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 },
      } };
    const saved = (await call('sync_inspection', { sessionId, serverEpoch: data.serverEpoch, sourceToken: data.sourceToken,
      baseStateRevision: data.stateRevision, baseInspectionRevision: data.inspectionRevision, scene })).structuredContent;
    const binding = { sessionId, serverEpoch: saved.serverEpoch, sourceToken: saved.sourceToken,
      baseStateRevision: saved.stateRevision, baseInspectionRevision: saved.inspectionRevision };
    const alive = async () => (await call('get_inspection_state', { sessionId })).isError !== true;
    return { sessionId, binding, alive };
  }
  return { clock, call, open };
}

describe('a session outlives its idle lifetime while something still uses it', () => {
  it('stays open for a companion that keeps polling', async () => {
    const h = await host(), s = await h.open();
    const panelId = (await h.call('attach_inspection', { ...s.binding, surface: 'companion' })).structuredContent.panelId;
    for (let beat = 0; beat < 6; beat++) {
      h.clock.ms += TTL_MS / 3;
      expect((await h.call('poll_inspection', { ...s.binding, panelId, availability: 'ready' })).isError).not.toBe(true);
    }
    expect(await s.alive()).toBe(true);
  });

  it('stays open for the full Mol* viewer page that keeps polling', async () => {
    const h = await host(), s = await h.open();
    for (let beat = 0; beat < 6; beat++) {
      h.clock.ms += TTL_MS / 3;
      expect((await h.call('poll_detailed_view', { sessionId: s.sessionId })).isError).not.toBe(true);
    }
    expect(await s.alive()).toBe(true);
  });

  it('stays open for an agent in listen_voice while the headset is off, and only for a shared session', async () => {
    const h = await host(), shared = await h.open(), unshared = await h.open();
    expect((await h.call('open_companion', { ...shared.binding, connection: 'loopback' })).isError).not.toBe(true);
    // No heartbeat at all: the wearer has the headset off. Each wait also
    // spends one second of the test clock.
    for (let wait = 0; wait < 6; wait++) {
      h.clock.ms += TTL_MS / 3;
      const heard = await h.call('listen_voice', { timeoutSeconds: 1 });
      expect(heard.isError).not.toBe(true);
      expect(heard.structuredContent.share).toBeUndefined();
    }
    expect(await shared.alive()).toBe(true);
    expect(await unshared.alive()).toBe(false);
  });

  it('expires a shared session nobody polls or listens for', async () => {
    const h = await host(), s = await h.open();
    expect((await h.call('open_companion', { ...s.binding, connection: 'loopback' })).isError).not.toBe(true);
    for (let wait = 0; wait < 6; wait++) h.clock.ms += TTL_MS / 3 + 1_000;
    expect(await s.alive()).toBe(false);
  });
});

describe('the Wi-Fi share, as a listening agent hears about it', () => {
  it('warns fifteen minutes before a silent headset ends the share, then says how to reopen it', async () => {
    const lanAddress = listLanAddresses()[0];
    if (!lanAddress) return; // No private interface: this host cannot run a LAN listener.
    const folder = await mkdtemp(join(tmpdir(), 'stereofold-keepalive-lan-'));
    const saved = { store: process.env.STEREOFOLD_LAN_CERTIFICATE_STORE, hours: process.env.STEREOFOLD_SHARE_MAX_HOURS };
    process.env.STEREOFOLD_LAN_CERTIFICATE_STORE = folder;
    delete process.env.STEREOFOLD_SHARE_MAX_HOURS;
    cleanups.push(async () => {
      for (const [name, value] of [['STEREOFOLD_LAN_CERTIFICATE_STORE', saved.store], ['STEREOFOLD_SHARE_MAX_HOURS', saved.hours]] as const)
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      await rm(folder, { recursive: true, force: true });
    });
    const h = await host(24 * 60 * 60_000), s = await h.open();
    const opened = await h.call('open_companion', { ...s.binding, connection: 'lan', lanHost: lanAddress.address,
      lanPort: await unusedPort(lanAddress.address) });
    expect(opened.isError).not.toBe(true);
    const closesAt = Date.parse(opened.structuredContent.companion.sessionExpiresAt);
    expect(Date.parse(opened.structuredContent.companion.sessionMaxExpiresAt) - h.clock.ms).toBe(8 * 60 * 60_000);

    h.clock.ms = closesAt - 16 * 60_000;
    expect((await h.call('listen_voice', { timeoutSeconds: 1 })).structuredContent.share).toBeUndefined();

    h.clock.ms = closesAt - 15 * 60_000;
    const closing = await h.call('listen_voice', { timeoutSeconds: 1 });
    expect(closing.structuredContent.share).toEqual({ state: 'closing', reason: 'idle', at: new Date(closesAt).toISOString() });
    const time = new Date(closesAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    expect(closing.content[0].text).toContain(`the private Wi-Fi share closes at ${time} unless it calls again`);

    h.clock.ms = closesAt + 60_000;
    const closed = await h.call('listen_voice', { timeoutSeconds: 1 });
    expect(closed.structuredContent.share).toEqual({ state: 'closed', reason: 'idle', at: new Date(closesAt).toISOString() });
    expect(closed.content[0].text).toBe('The wearer said nothing in that window.\n'
      +`The private Wi-Fi share closed at ${time} after the headset stopped calling this Mac. `
      +'Call open_companion with connection="lan" for a new share and follow its returned pairing instructions.');
  });
});
