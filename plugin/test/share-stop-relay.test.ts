import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, type Socket } from 'node:net';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import http, { createServer } from 'node:http';
import { createStereoStructureServer } from '../src/server.js';
import { listLanAddresses } from '../src/inspection-lan.js';
import { PRIVATE_INSPECTION_META_KEY as KEY } from '../src/inspection-contract.js';
import { createReplyAudioSynthesizer } from '../src/headset-reply-audio.js';
import { QuestLink } from '../src/inspection-quest-link.js';

/**
 * Stopping a share, or moving it to loopback, must end the public relay that
 * share opened: the old link's `/source` and `/tool` stop answering and its
 * open connections drop before the tool reports success. The relay is one
 * per Mac, so a session that does not own it must leave it alone.
 */

const cif = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');
const publicOrigin = 'https://quiet-field-123.trycloudflare.com';
const lanHost = listLanAddresses()[0]?.address;

class FakeCloudflared extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed: NodeJS.Signals[] = [];
  kill(signal: NodeJS.Signals) { this.killed.push(signal); this.emit('exit', 0, signal); return true; }
}

async function fixture(options: { maxSessions?: number } = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'stereofold-share-stop-relay-'));
  const savedStore = process.env.STEREOFOLD_LAN_CERTIFICATE_STORE;
  process.env.STEREOFOLD_LAN_CERTIFICATE_STORE = join(folder, 'lan');
  await writeFile(join(folder, 'inspector.html'), '<html><script>void 0;</script></html>');
  const tunnels: Array<{ child: FakeCloudflared; port: number }> = [];
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createStereoStructureServer(join(folder, 'viewer.html'), {
    ...options,
    replyAudio: createReplyAudioSynthesizer({ enabled: false }),
    sceneServiceFile: join(folder, 'scene-service.json'),
    headsetDevice: { env: { PATH: '' }, exists: async () => false,
      run: async () => { throw Error('Relay fixture must not contact a physical headset'); } },
    questLink: {
      dnsGraceMs: 0, probe: async () => ({ status: 405 }),
      spawn: ((_command: string, args: readonly string[]) => {
        const child = new FakeCloudflared();
        tunnels.push({ child, port: Number(new URL(args[args.indexOf('--url') + 1]).port) });
        queueMicrotask(() => child.stderr.write(`INF tunnel available at ${publicOrigin}\n`));
        return child as any;
      }) as any,
    },
  });
  const client = new Client({ name: 'Relay stop regression', version: '1' });
  const call = async (name: string, args: Record<string, unknown>) => {
    const result: any = await client.callTool({ name: `stereo_structure.${name}`, arguments: args });
    expect(result.isError, result.content?.[0]?.text).not.toBe(true);
    return result;
  };
  const close = async () => {
    await client.close(); await server.close();
    if (savedStore === undefined) delete process.env.STEREOFOLD_LAN_CERTIFICATE_STORE;
    else process.env.STEREOFOLD_LAN_CERTIFICATE_STORE = savedStore;
    await rm(folder, { recursive: true, force: true });
  };
  await server.connect(b); await client.connect(a);
  const session = async () => {
    const sessionId = (await call('inspect', { structureText: cif })).structuredContent.sessionId as string;
    const data = (await call('get_inspection', { sessionId }))._meta[KEY];
    await call('sync_inspection', { sessionId, serverEpoch: data.serverEpoch, sourceToken: data.sourceToken,
      baseStateRevision: data.stateRevision, baseInspectionRevision: data.inspectionRevision,
      scene: { sourceSha256: data.catalog.source.sha256, modelNumber: data.catalog.modelNumbers[0],
        assemblyId: data.catalog.assemblyId, selectionKeys: [data.catalog.rows[0].key],
        camera: { mode: 'perspective', fov: Math.PI / 4, position: [0, 0, 80], up: [0, 1, 0], target: [0, 0, 0], radius: 20, radiusMax: 20, fog: 50, clipFar: true, minNear: 5, minFar: 0 },
        inspection: { appearance: { representation: 'cartoon', color: 'uniform', uniformColor: '#44aaff', background: '#192734', opacity: 1, labels: false, highlightColor: '#ffccee', clipping: 0, fog: 0 },
          placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } } } });
    return {
      sessionId,
      open: (connection: 'https' | 'loopback') => call('open_companion', { sessionId, connection, launch: 'none', headset: 'auto' }),
      openRaw: async (connection: 'https' | 'loopback') =>
        await client.callTool({ name: 'stereo_structure.open_companion', arguments: { sessionId, connection, launch: 'none', headset: 'auto' } }) as any,
      openLan: (lanPort: number) => call('open_companion', { sessionId, connection: 'lan', lanHost, lanPort, launch: 'none', headset: 'auto' }),
      manage: (args: Record<string, unknown>) => call('manage_companion', { sessionId, ...args }),
      manageRaw: async (args: Record<string, unknown>) =>
        await client.callTool({ name: 'stereo_structure.manage_companion', arguments: { sessionId, ...args } }) as any,
    };
  };
  return { session, close, tunnels };
}

/** Requests the relay's public routes on its loopback side, as cloudflared forwards them. */
async function relay(port: number, token: string) {
  const headers = { Authorization: `Bearer ${token}`, Origin: publicOrigin };
  const outcome = async (request: Promise<Response>) => {
    try { return (await request).status; } catch { return 'refused'; }
  };
  return {
    source: await outcome(fetch(`http://127.0.0.1:${port}/source`, { headers })),
    tool: await outcome(fetch(`http://127.0.0.1:${port}/tool`, { method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'get_inspection', args: {} }) })),
  };
}

async function unusedPort(host: string) {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(0, host, () => resolve()); });
  const address = probe.address(); if (!address || typeof address === 'string') throw Error('LAN fixture did not bind');
  await new Promise<void>(resolve => probe.close(() => resolve()));
  return address.port;
}

async function heldConnection(port: number) {
  const socket: Socket = connect(port, '127.0.0.1');
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  const closed = new Promise<boolean>(resolve => socket.once('close', () => resolve(true)));
  socket.on('error', () => {});
  return { closed: () => Promise.race([closed, new Promise<boolean>(resolve => setTimeout(() => resolve(false), 1_000))]),
    end: () => { socket.destroy(); } };
}

/**
 * Holds the next relay's loopback proxy before it binds, so a stop can arrive
 * while the relay is still starting, and records what is still running each
 * time QuestLink.close() returns.
 */
function holdRelayStartup(tunnels: Array<{ child: FakeCloudflared }>) {
  const original = { open: QuestLink.prototype.open, close: QuestLink.prototype.close, createServer: http.createServer };
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let armed = false, proxy: http.Server | undefined;
  const afterClose: Array<{ listening: boolean; running: number }> = [];
  const spies = [
    vi.spyOn(QuestLink.prototype, 'open').mockImplementation(function (this: QuestLink, ...args) {
      armed = true; return original.open.apply(this, args);
    }),
    vi.spyOn(QuestLink.prototype, 'close').mockImplementation(async function (this: QuestLink) {
      await original.close.call(this);
      afterClose.push({ listening: proxy?.listening ?? false, running: tunnels.filter(tunnel => tunnel.child.killed.length === 0).length });
    }),
    vi.spyOn(http, 'createServer').mockImplementation(((...args: any[]) => {
      const server = (original.createServer as any).apply(http, args);
      if (armed && !proxy) {
        armed = false; proxy = server;
        const listen = server.listen;
        server.listen = (...listenArgs: any[]) => { void gate.then(() => listen.apply(server, listenArgs)); return server; };
      }
      return server;
    }) as any),
  ];
  const until = async (ready: () => boolean) => { while (!ready()) await new Promise(resolve => setTimeout(resolve, 10)); };
  return {
    afterClose,
    held: () => until(() => proxy !== undefined),
    closing: () => until(() => spies[1].mock.calls.length > 0),
    release: () => release(),
    restore: async () => { release(); for (const spy of spies) spy.mockRestore(); },
  };
}

function linkOf(result: any) {
  const url = new URL(result.structuredContent.companion.url);
  expect(url.origin).toBe(publicOrigin);
  return url.hash.slice(1);
}

describe('stopping a share ends its public relay', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

  for (const stop of ['close', 'loopback'] as const) {
    it(`refuses the old relay link and drops its connections after ${stop === 'close' ? 'stop sharing' : 'a switch to loopback'}`, async () => {
      const f = await fixture(); cleanups.push(f.close);
      const owner = await f.session();
      const token = linkOf(await owner.open('https'));
      const { child, port } = f.tunnels[0];
      expect(await relay(port, token)).toEqual({ source: 200, tool: 200 });
      const held = await heldConnection(port); cleanups.push(async () => held.end());

      if (stop === 'close') expect((await owner.manage({ action: 'close' })).structuredContent.shareClosed).toBe(true);
      else expect((await owner.open('loopback')).structuredContent.companion.connection).toBe('loopback');

      expect(await relay(port, token)).toEqual({ source: 'refused', tool: 'refused' });
      expect(await held.closed()).toBe(true);
      expect(child.killed).toEqual(['SIGTERM']);
    }, 30_000);
  }

  it('ends a relay that is still starting when sharing stops, and the open that was starting fails', async () => {
    const f = await fixture(); cleanups.push(f.close);
    const owner = await f.session();
    const startup = holdRelayStartup(f.tunnels); cleanups.push(startup.restore);
    const opening = owner.openRaw('https');
    await startup.held();

    // The same session cannot switch to loopback while that open is unanswered.
    const moved = await owner.openRaw('loopback');
    expect(moved.isError).toBe(true);
    expect(moved.content[0].text).toContain('still finishing with different connection options');

    const stopping = owner.manage({ action: 'close' });
    await startup.closing();
    startup.release();
    expect((await stopping).structuredContent.shareClosed).toBe(true);
    expect(startup.afterClose[0]).toEqual({ listening: false, running: 0 });
    const opened = await opening;
    expect(opened.isError).toBe(true);
    expect(opened.content[0].text).toContain('closed while');
    expect(f.tunnels.filter(tunnel => tunnel.child.killed.length === 0)).toEqual([]);
  }, 30_000);

  it('leaves another session’s relay open when a session without one stops or moves to loopback', async () => {
    const f = await fixture(); cleanups.push(f.close);
    const owner = await f.session(), other = await f.session();
    const token = linkOf(await owner.open('https'));
    const { child, port } = f.tunnels[0];

    expect((await other.manage({ action: 'close' })).structuredContent.shareClosed).toBe(true);
    await other.open('loopback');
    expect(await relay(port, token)).toEqual({ source: 200, tool: 200 });
    expect(child.killed).toEqual([]);

    await owner.manage({ action: 'close' });
    expect(await relay(port, token)).toEqual({ source: 'refused', tool: 'refused' });
  }, 30_000);

  it('ends a session’s relay when the session ends, and leaves another session’s relay open', async () => {
    // Two retained sessions: each new session evicts the least recently used one.
    const f = await fixture({ maxSessions: 2 }); cleanups.push(f.close);
    const idle = await f.session(), owner = await f.session();
    const token = linkOf(await owner.open('https'));
    const { child, port } = f.tunnels[0];

    await f.session();
    expect((await idle.manageRaw({ action: 'status' })).isError).toBe(true);
    expect(await relay(port, token)).toEqual({ source: 200, tool: 200 });
    expect(child.killed).toEqual([]);

    // The relay reads above used the owner's session, so two more sessions evict it.
    await f.session(); await f.session();
    expect((await owner.manageRaw({ action: 'status' })).isError).toBe(true);
    await vi.waitFor(() => expect(child.killed).toEqual(['SIGTERM']));
    expect(await relay(port, token)).toEqual({ source: 'refused', tool: 'refused' });
  }, 30_000);

  it.skipIf(!lanHost)('ends a session’s relay on stop sharing even while another session holds the LAN listener', async () => {
    const f = await fixture(); cleanups.push(f.close);
    const lanHolder = await f.session(), owner = await f.session();
    await lanHolder.openLan(await unusedPort(lanHost!));
    const token = linkOf(await owner.open('https'));
    const { child, port } = f.tunnels[0];
    expect(await relay(port, token)).toEqual({ source: 200, tool: 200 });

    // The LAN listener is still the other session's to close.
    const refused = await owner.manageRaw({ action: 'close' });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('belongs to a different inspection');
    expect(await relay(port, token)).toEqual({ source: 'refused', tool: 'refused' });
    expect(child.killed).toEqual(['SIGTERM']);
    expect((await lanHolder.manage({ action: 'status' })).structuredContent.lan).not.toBeNull();
  }, 30_000);
});
