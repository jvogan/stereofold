import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createStereoStructureServer } from '../src/server.js';
import { CdpSession, decodeFrames, type CdpSocketLike, type DevtoolsTransport } from '../src/headset-devtools.js';
import { PRIVATE_INSPECTION_META_KEY as KEY } from '../src/inspection-contract.js';
import { createReplyAudioSynthesizer } from '../src/headset-reply-audio.js';

/**
 * An automatic `read_headset_browser` reads the tab of whichever address this
 * Mac is serving to a headset right now: the public relay's origin, or the
 * loopback companion's origin as the headset opens it through `adb reverse`.
 * A same-titled tab on any other site is never opened, and once the share
 * stops, nothing is read without a named tab.
 */

const cif = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');
const publicOrigin = 'https://quiet-field-123.trycloudflare.com';
const ELSEWHERE = { id: '90', type: 'page', title: 'Stereofold', url: 'https://elsewhere.example/viewer',
  webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/90' };

class FakeCloudflared extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill(signal: NodeJS.Signals) { this.emit('exit', 0, signal); return true; }
}

/** Replies to every CDP command as a visible viewer page would. */
class FakeSocket extends EventEmitter implements CdpSocketLike {
  constructor(private readonly reply: (message: Record<string, unknown>, socket: FakeSocket) => void) { super(); }
  write(chunk: Buffer | string): boolean {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    for (const frame of decodeFrames(bytes).frames) {
      if (frame.opcode === 0x1) this.reply(JSON.parse(frame.payload.toString('utf8')) as Record<string, unknown>, this);
    }
    return true;
  }
  deliver(value: unknown) {
    const payload = Buffer.from(JSON.stringify(value), 'utf8');
    const header = payload.byteLength < 126 ? Buffer.from([0x81, payload.byteLength])
      : Buffer.concat([Buffer.from([0x81, 126]), (() => { const b = Buffer.alloc(2); b.writeUInt16BE(payload.byteLength); return b; })()]);
    this.emit('data', Buffer.concat([header, payload]));
  }
  end() { return this as never; }
  destroy() { return this as never; }
}

function headsetWith(tabs: () => unknown[]) {
  const opened: string[] = [];
  const transport: DevtoolsTransport = {
    fetch: async () => JSON.stringify(tabs()),
    open: async (_port, socketUrl) => {
      opened.push(socketUrl.split('/').at(-1)!);
      return new CdpSession(new FakeSocket((message, socket) => socket.deliver({ id: message.id, result:
        message.method === 'Runtime.evaluate' ? { result: { value: { pathname: '/viewer', documentVisibility: 'visible' } } } : {} })), 200);
    },
  };
  return { opened, transport };
}

async function fixture(transport: DevtoolsTransport) {
  const folder = await mkdtemp(join(tmpdir(), 'stereofold-reader-shares-'));
  const savedStore = process.env.STEREOFOLD_LAN_CERTIFICATE_STORE;
  process.env.STEREOFOLD_LAN_CERTIFICATE_STORE = join(folder, 'lan');
  await writeFile(join(folder, 'inspector.html'), '<html><script>void 0;</script></html>');
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createStereoStructureServer(join(folder, 'viewer.html'), {
    replyAudio: createReplyAudioSynthesizer({ enabled: false }),
    sceneServiceFile: join(folder, 'scene-service.json'),
    environment: {},
    headsetDevtools: transport,
    headsetDevice: { env: { PATH: '' }, exists: async () => false,
      run: async () => { throw Error('This fixture must not contact a physical headset'); } },
    questLink: {
      dnsGraceMs: 0, probe: async () => ({ status: 405 }),
      spawn: (() => {
        const child = new FakeCloudflared();
        queueMicrotask(() => child.stderr.write(`INF tunnel available at ${publicOrigin}\n`));
        return child as any;
      }) as any,
    },
  });
  const client = new Client({ name: 'Headset reader shares', version: '1' });
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
    close,
    open: (connection: 'https' | 'loopback') => call('open_companion', { sessionId, connection, launch: 'none', headset: 'auto' }),
    stop: async () => {
      const current = (await call('get_inspection', { sessionId }))._meta[KEY];
      return call('manage_companion', { sessionId, serverEpoch: current.serverEpoch, sourceToken: current.sourceToken, action: 'close' });
    },
    read: (args: Record<string, unknown> = {}) => call('read_headset_browser', { consoleMs: 200, ...args }),
  };
}

describe('automatic read_headset_browser on relay and loopback shares', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

  it('reads the tab on the public relay origin and never the same-titled tab elsewhere', async () => {
    const own = { id: '10', type: 'page', title: 'Stereofold', url: `${publicOrigin}/viewer`,
      webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/10' };
    const headset = headsetWith(() => [own, ELSEWHERE]);
    const f = await fixture(headset.transport); cleanups.push(f.close);
    expect(new URL((await f.open('https')).structuredContent.companion.url).origin).toBe(publicOrigin);
    const result = await f.read();
    expect(result.structuredContent, result.content[0].text).toMatchObject({ read: true, target: { id: '10' } });
    expect(headset.opened).toEqual(['10']);

    await f.stop();
    const after = await f.read();
    expect(after.structuredContent.read).toBe(false);
    expect(headset.opened).toEqual(['10']);
  });

  it('reads the tab on the loopback companion address the headset opens through adb reverse', async () => {
    let origin = 'http://127.0.0.1:1';
    const own = () => ({ id: '20', type: 'page', title: 'Stereofold', url: `${origin}/viewer`,
      webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/20' });
    // A tab on the same port under another host name is a different origin to
    // the browser and to the companion, which answers only Host 127.0.0.1.
    const otherName = () => ({ id: '21', type: 'page', title: 'Stereofold', url: `${origin.replace('127.0.0.1', 'localhost')}/viewer`,
      webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/21' });
    const headset = headsetWith(() => [own(), otherName(), ELSEWHERE]);
    const f = await fixture(headset.transport); cleanups.push(f.close);
    const shared = await f.open('loopback');
    origin = new URL(shared.structuredContent.companion.url).origin;
    expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    const result = await f.read();
    expect(result.structuredContent, result.content[0].text).toMatchObject({ read: true, target: { id: '20' } });
    expect(headset.opened).toEqual(['20']);

    await f.stop();
    const after = await f.read();
    expect(after.structuredContent.read).toBe(false);
    expect(headset.opened).toEqual(['20']);
  });
});
