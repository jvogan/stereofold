/**
 * The debugger forward an adb launch opens is the launch's own, and it is
 * gone when the step that needed it is done.
 *
 * A forward to Quest Browser's debugger is a raw TCP port on loopback with no
 * authentication of its own, so any process on this Mac can drive the
 * headset browser through it for as long as it stands. Everything here is a
 * fake: the share has no listener, adb is a recording function and the
 * debugger is an in-memory transport, so no cable, headset or port is touched.
 */

import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, expect, it, vi } from 'vitest';
import { createStereoStructureServer } from '../src/server.js';
import { InspectionCompanionHttp } from '../src/inspection-companion-http.js';
import { LanCompanion } from '../src/inspection-lan.js';
import { PRIVATE_INSPECTION_META_KEY as KEY } from '../src/inspection-contract.js';
import type { DevtoolsTransport } from '../src/headset-devtools.js';

const cif = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');
const closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks(); });

const SHARE = 'https://192.168.77.24:8443';

async function launchWith({ devtools, forwardCode = 0, removeCode = 0 }: { devtools: DevtoolsTransport; forwardCode?: number; removeCode?: number }) {
  const adb: string[][] = [];
  const status = { url: `${SHARE}/`, host: '192.168.77.24', port: 8443, fingerprint: 'test', launchId: randomUUID(),
    sessionExpiresAt: '2099-01-01T00:00:00.000Z', sessionMaxExpiresAt: '2099-01-01T00:00:00.000Z',
    pairingExpiresAt: '2099-01-01T00:00:00.000Z', clients: [] };
  vi.spyOn(InspectionCompanionHttp.prototype, 'open').mockResolvedValue({ url: 'http://127.0.0.1:1234/#test', port: 1234 });
  vi.spyOn(LanCompanion.prototype, 'open').mockResolvedValue({ ...status, pairingCode: '12345678' } as any);
  vi.spyOn(LanCompanion.prototype, 'status').mockReturnValue(status as any);
  vi.spyOn(LanCompanion.prototype, 'matchesPairing').mockReturnValue(true);
  const server = createStereoStructureServer(undefined, {
    headsetDevtools: devtools,
    headsetDevice: { env: { PATH: '' }, exists: async () => false,
      run: async () => { throw Error('This fixture must not reach a physical headset'); } },
    questLaunch: { platform: 'darwin', opener: '/fixture/opener', launch: () => ({ reason: 'started' }),
      find: () => '/fixture/adb', recheckMs: 0, settleMs: 0, wakeMs: 0, environment: { PATH: '' },
      run: async (_command: string, args: readonly string[]) => {
        adb.push([...args]);
        if (args.includes('devices')) return { code: 0, stdout: 'List of devices attached\nQUEST2\tdevice\n', stderr: '' };
        if (args.includes('getprop')) return { code: 0, stdout: '[ro.product.model]: [Quest 2]\n', stderr: '' };
        if (args.includes('forward') && !args.includes('--remove')) return { code: forwardCode, stdout: '', stderr: '' };
        if (args.includes('forward') && args.includes('--remove')) return { code: removeCode, stdout: '', stderr: 'error: listener not found' };
        return { code: 0, stdout: 'Starting: Intent', stderr: '' };
      } },
  } as any);
  const client = new Client({ name: 'launch forward harness', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  closes.push(async () => { await client.close(); await server.close(); });
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name: `stereo_structure.${name}`, arguments: args }) as any;
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    return result;
  };
  const sessionId = (await call('inspect', { structureText: cif })).structuredContent.sessionId;
  const data = (await call('get_inspection', { sessionId }))._meta[KEY];
  await call('sync_inspection', { sessionId, serverEpoch: data.serverEpoch, sourceToken: data.sourceToken,
    baseStateRevision: data.stateRevision, baseInspectionRevision: data.inspectionRevision,
    scene: { sourceSha256: data.catalog.source.sha256, modelNumber: data.catalog.modelNumbers[0],
      assemblyId: data.catalog.assemblyId, selectionKeys: [],
      camera: { mode: 'perspective', fov: Math.PI / 4, position: [0, 0, 80], target: [0, 0, 0], up: [0, 1, 0], radius: 20, radiusMax: 20, fog: 50, clipFar: true, minNear: 5, minFar: 0 },
      inspection: { appearance: { representation: 'cartoon', color: 'chain-id', uniformColor: '#58dcc9', background: '#071015', opacity: 1, labels: false, highlightColor: '#f2c47c', clipping: 0, fog: 0 },
        placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } } } });
  const opened = await call('open_companion', { sessionId, connection: 'lan', launch: 'adb', headset: 'meta', waitForHeadsetMs: 0 });
  return { adb, opened, call };
}

/** Every forward to the debugger socket, and every removal, by port. */
function forwards(adb: readonly string[][]) {
  const opened = adb.filter(args => args.includes('forward') && args.includes('localabstract:chrome_devtools_remote'))
    .map(args => args.find(arg => arg.startsWith('tcp:'))!);
  const removed = adb.filter(args => args.includes('forward') && args.includes('--remove'))
    .map(args => args.find(arg => arg.startsWith('tcp:'))!);
  return { opened, removed };
}

const emptyBrowser: DevtoolsTransport = {
  fetch: async (_port, path) => path === '/json' ? '[]' : '{}',
  open: async () => { throw Error('no page'); },
};

it('removes the debugger forward an adb launch opened for its tab sweep', async () => {
  const { adb, opened } = await launchWith({ devtools: emptyBrowser });
  expect(opened.structuredContent.launch).toMatchObject({ opened: true });
  const { opened: forwarded, removed } = forwards(adb);
  expect(forwarded.length).toBeGreaterThan(0);
  expect([...removed].sort()).toEqual([...forwarded].sort());
  // Only the launch's own port is ever removed, never a forward someone else left.
  expect(adb.some(args => args.includes('--remove-all'))).toBe(false);
});

it('removes the forward when the sweep that used it fails', async () => {
  const broken: DevtoolsTransport = {
    fetch: async () => { throw Error('connection reset'); },
    open: async () => { throw Error('connection reset'); },
  };
  const { adb, opened } = await launchWith({ devtools: broken });
  expect(opened.structuredContent.launch).toMatchObject({ opened: true });
  const { opened: forwarded, removed } = forwards(adb);
  expect(forwarded.length).toBeGreaterThan(0);
  expect([...removed].sort()).toEqual([...forwarded].sort());
});

it('removes nothing when adb refused to open the forward', async () => {
  const { adb, opened } = await launchWith({ devtools: emptyBrowser, forwardCode: 1 });
  expect(opened.structuredContent.launch).toMatchObject({ opened: true });
  expect(forwards(adb).removed).toEqual([]);
});

it('lets a later browser read forward for itself and remove it, since the launch left none', async () => {
  const ports: number[] = [];
  const viewer = { id: '10', type: 'page', title: 'Stereofold', url: `${SHARE}/viewer`, webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/page/10' };
  const devtools: DevtoolsTransport = {
    fetch: async (port, path) => { ports.push(port); return path === '/json' ? JSON.stringify([viewer]) : '{}'; },
    open: async () => { throw Error('asleep'); },
  };
  const { adb, call } = await launchWith({ devtools });
  const launched = forwards(adb).opened.length;
  const read = await call('read_headset_browser', {});
  const { opened: forwarded, removed } = forwards(adb);
  expect(forwarded.length).toBe(launched + 1);
  expect([...removed].sort()).toEqual([...forwarded].sort());
  expect(read.structuredContent.port).toBe(Number(forwarded.at(-1)!.slice('tcp:'.length)));
  expect(ports.at(-1)).toBe(read.structuredContent.port);
});

/**
 * A removal adb refused leaves the debugger reachable from this Mac, so the
 * person and the agent are told which port is still open and how to close it.
 */
it('says which forward is left and how to remove it when the launch sweep cannot remove its own', async () => {
  const { adb, opened } = await launchWith({ devtools: emptyBrowser, removeCode: 1 });
  expect(opened.structuredContent.launch).toMatchObject({ opened: true });
  const port = forwards(adb).opened[0]!;
  expect(port).toMatch(/^tcp:\d+$/u);
  expect(opened.structuredContent.launch.tabHygiene.note).toContain(`adb forward --remove ${port}`);
  expect(opened.content[0].text).toContain(`adb forward --remove ${port}`);
});

it('says which forward is left and how to remove it when a browser read cannot remove its own', async () => {
  const viewer = { id: '10', type: 'page', title: 'Stereofold', url: `${SHARE}/viewer`, webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/page/10' };
  const devtools: DevtoolsTransport = {
    fetch: async (_port, path) => path === '/json' ? JSON.stringify([viewer]) : '{}',
    open: async () => { throw Error('asleep'); },
  };
  const { adb, call } = await launchWith({ devtools, removeCode: 1 });
  const read = await call('read_headset_browser', {});
  const port = forwards(adb).opened.at(-1)!;
  expect(read.structuredContent.port).toBe(Number(port.slice('tcp:'.length)));
  expect(read.structuredContent.cleanupWarning).toContain(`adb forward --remove ${port}`);
  expect(read.content[0].text).toContain(`adb forward --remove ${port}`);
});

/**
 * Everything a page reports about itself is the page's to choose, so a value
 * of the wrong type is read as missing rather than failing the read, and a
 * read that fails still says which forward it left open.
 */
it('still names the forward it left when the page reports a value of the wrong type', async () => {
  const viewer = { id: '10', type: 'page', title: 'Stereofold', url: `${SHARE}/viewer`, webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/page/10' };
  const state = { pathname: { toString: null }, documentVisibility: { toString: null },
    xr: { presenting: true, mode: { toString: null }, passthrough: true } };
  const session = {
    on: () => () => {},
    close: () => {},
    send: async (method: string) => method === 'Runtime.evaluate' ? { result: { value: state } } : {},
  };
  const devtools: DevtoolsTransport = {
    fetch: async (_port, path) => path === '/json' ? JSON.stringify([viewer]) : '{}',
    open: async () => session as any,
  };
  const { adb, call } = await launchWith({ devtools, removeCode: 1 });
  const read = await call('read_headset_browser', { consoleMs: 200 });
  const port = forwards(adb).opened.at(-1)!;
  expect(read.structuredContent.read).toBe(true);
  expect(read.content[0].text).toContain('presenting an XR session with passthrough');
  expect(read.structuredContent.cleanupWarning).toContain(`adb forward --remove ${port}`);
  expect(read.content[0].text).toContain(`adb forward --remove ${port}`);
});
