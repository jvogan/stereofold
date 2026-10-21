/**
 * Two hosts, one Mac, one scene.
 *
 * A fixture opened in server A and reopened there was reported missing when
 * the same session ID was offered to server B. These tests are that case with the shared scene in place: the same session
 * ID, opened by one host, answered by the other, with the selection, the
 * emphasis, the lesson and the placement intact because there is only one copy
 * of them. They also hold the edges honest — a recorded owner that stopped
 * answering, a token that is not this scene's, and a Mac with nothing open.
 */
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it, vi } from 'vitest';
import { createStereoStructureServer, DEFAULT_SESSION_TTL_MS } from '../src/server.js';
import { PRIVATE_INSPECTION_META_KEY as PRIVATE_KEY } from '../src/inspection-contract.js';
import { listLanAddresses } from '../src/inspection-lan.js';
import { LocalSceneService, parseSceneOwnerRecord, sceneServicePath, sceneCallTimeoutMs, SCENE_CALL_TIMEOUT_MS, SCENE_MAX_CALL_TIMEOUT_MS, SCENE_SERVICE_CONFIG_KEY, SCENE_SERVICE_ENV,
  SCENE_SERVICE_FILE, SCENE_SERVICE_VERSION, SCENE_SOCKET_ENV, SCENE_SWEEP_MS, SCENE_GROWTH_PREPARATION_TIMEOUT_MS } from '../src/scene-service.js';

const cif = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');

it('allows source preparation before the declared render wait starts',()=>{
  // A 31 s read and verification followed by a 130 s draw outlasted the old 160 s proxy deadline.
  expect(sceneCallTimeoutMs('replace_inspection_source',{waitForRenderMs:130_000})).toBe(250_000);
  expect(sceneCallTimeoutMs('replace_inspection_source',{waitForRenderMs:130_000})).toBeGreaterThan(31_000+130_000);
  expect(sceneCallTimeoutMs('replace_inspection_source',{waitForRenderMs:300_000})).toBe(SCENE_MAX_CALL_TIMEOUT_MS);
  expect(sceneCallTimeoutMs('replace_inspection_source',{waitForRenderMs:0})).toBe(120_000);
  for(const name of ['inspect','inspect_file','inspect_scene','inspect_lesson','inspect_experience','navigate_experience']) {
    expect(sceneCallTimeoutMs(name,{})).toBe(120_000);
    expect(sceneCallTimeoutMs(name,{waitForRenderMs:Infinity})).toBe(120_000);
  }
  expect(sceneCallTimeoutMs('replace_inspection_source',{mode:'compare'})).toBe(120_000);
  expect(sceneCallTimeoutMs('replace_inspection_source',{waitForRenderMs:1e10})).toBe(SCENE_MAX_CALL_TIMEOUT_MS);
  expect(sceneCallTimeoutMs('update_inspection',{waitForRenderMs:120_000})).toBe(SCENE_CALL_TIMEOUT_MS);
});

it('matches cold growth preparation without extending reads or undeclared render waits',()=>{
  expect(SCENE_GROWTH_PREPARATION_TIMEOUT_MS).toBe(240_000);
  expect(sceneCallTimeoutMs('grow_structure',{})).toBe(SCENE_GROWTH_PREPARATION_TIMEOUT_MS);
  expect(sceneCallTimeoutMs('grow_structure',{waitForRenderMs:1e10})).toBe(SCENE_GROWTH_PREPARATION_TIMEOUT_MS);
  for(const args of [{pdbId:'1CRN'},{structureText:cif},{fixture:'depth-fixture'},{source:{kind:'file',path:'/private/structure.cif'}}])
    expect(sceneCallTimeoutMs('open',args)).toBe(120_000);
  expect(sceneCallTimeoutMs('control',{action:'load_pdb',waitForRenderMs:1e10})).toBe(120_000);
  for(const [name,args] of [['open',{sessionId:'existing'}],['control',{action:'fit'}],['get_inspection_state',{}]] as const)
    expect(sceneCallTimeoutMs(name,args)).toBe(SCENE_CALL_TIMEOUT_MS);
});

/** One host: its own MCP server, its own session store, its own everything. */
async function host(name: string, sceneServiceFile: string, environment?: NodeJS.ProcessEnv, viewerPath?: string, now?: () => number) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createStereoStructureServer(viewerPath, { sceneServiceFile, loopbackListenDenied: async () => false,
    ...(environment ? { environment } : {}), ...(now ? { now } : {}) });
  const client = new Client({ name, version: '1' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = (tool: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name: `stereo_structure.${tool}`, arguments: args }) as Promise<any>;
  return { call, close: async () => { await client.close(); await server.close(); } };
}

/** Open a structure and save a scene with a selection, so there is state to keep. */
async function openWithState(call: (tool: string, args?: Record<string, unknown>) => Promise<any>) {
  const opened = await call('inspect', { structureText: cif });
  const sessionId = opened.structuredContent.sessionId as string;
  const priv = (await call('get_inspection', { sessionId }))._meta[PRIVATE_KEY];
  const rows = priv.catalog.rows as any[];
  const scene = {
    sourceSha256: priv.catalog.source.sha256,
    modelNumber: priv.catalog.modelNumbers[0],
    assemblyId: priv.catalog.assemblyId,
    selectionKeys: [rows[0].key, rows[1].key, rows[2].key],
    camera: { mode: 'perspective', fov: Math.PI / 4, position: [0, 0, 80], target: [0, 0, 0], up: [0, 1, 0],
      radius: 20, radiusMax: 20, fog: 50, clipFar: true, minNear: 5, minFar: 0 },
    inspection: {
      appearance: { representation: 'cartoon', color: 'chain-id', uniformColor: '#58dcc9', background: '#071015',
        opacity: 1, labels: false, highlightColor: '#f2c47c', clipping: 0, fog: 0 },
      placement: { translation: [0.5, 0, -1], rotation: [0, 30, 0], scale: 1.5 },
    },
  };
  const binding = { sessionId, serverEpoch: priv.serverEpoch, sourceToken: priv.sourceToken,
    baseStateRevision: priv.stateRevision, baseInspectionRevision: priv.inspectionRevision };
  const saved = (await call('sync_inspection', { ...binding, scene })).structuredContent;
  return { sessionId, scene, binding: { ...binding, baseStateRevision: saved.stateRevision, baseInspectionRevision: saved.inspectionRevision } };
}

async function root() { return await mkdtemp(join(tmpdir(), 'stereofold-scene-')); }

/** A port nothing listens on at this address: listen once on a fresh one, then let it go. */
async function unusedPort(host: string) {
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(0, host, () => resolve()); });
  const { port } = probe.address() as net.AddressInfo;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  return port;
}

describe('the shared local scene service', () => {
  it('lets a second host continue the first host’s session with its state intact', async () => {
    const directory = await root();
    const file = join(directory, 'scene-service.json');
    const a = await host('Stereofold host A', file);
    const b = await host('Stereofold host B', file);
    try {
      const first = await openWithState(a.call);

      // Before anything is shared, B is an isolated server: the same session ID
      // is simply not there.
      const stranger = await b.call('get_inspection_state', { sessionId: first.sessionId });
      expect(stranger.isError).toBe(true);
      expect(JSON.stringify(stranger.content)).toMatch(/was not found or has expired/);

      const shared = await a.call('continue_session', { assistant: 'Claude' });
      expect(shared.isError).not.toBe(true);
      expect(shared.structuredContent).toMatchObject({ role: 'owner', sessionId: first.sessionId });
      expect(shared.structuredContent.assistants.active).toBe('Claude');

      const joined = await b.call('continue_session', { assistant: 'Codex' });
      expect(joined.isError).not.toBe(true);
      expect(joined.structuredContent.role).toBe('attached');
      // The same session, not a copy of it.
      expect(joined.structuredContent.sessionId).toBe(first.sessionId);
      expect(joined.structuredContent.scene).toMatchObject({
        hasScene: true, selectedResidueCount: 3, sourceToken: first.binding.sourceToken,
        placement: { translation: [0.5, 0, -1], rotation: [0, 30, 0], scale: 1.5 },
      });
      // The floor stayed with the host that already had it.
      expect(joined.structuredContent.assistants.active).toBe('Claude');
      expect(joined.structuredContent.assistants.attached.map((entry: any) => entry.label)).toEqual(['Claude', 'Codex']);

      // B can now read the scene through its own tools, and reads A's state.
      const readBack = await b.call('get_inspection_state', { sessionId: first.sessionId });
      expect(readBack.isError).not.toBe(true);
      expect(readBack.structuredContent.view.selectedResidueCount).toBe(3);
      expect(readBack.structuredContent.sourceToken).toBe(first.binding.sourceToken);

      // And a change B makes is a change A sees, because it is one scene.
      const panelId = (await b.call('attach_inspection', { ...first.binding, surface: 'companion' })).structuredContent.panelId;
      const changed = await b.call('update_inspection', { ...first.binding, panelId, commandId: 'from-codex-1',
        change: { kind: 'appearance', patch: { uniformColor: '#ff8800' } } });
      expect(changed.isError).not.toBe(true);
      const seenByA = await a.call('get_inspection_state', { sessionId: first.sessionId, commandId: 'from-codex-1' });
      expect(seenByA.structuredContent.command.commandId).toBe('from-codex-1');
      expect(seenByA.structuredContent.panels.map((panel: any) => panel.panelId)).toContain(panelId);
    } finally { await b.close(); await a.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('hands the scene to a successor when the owner exits, and says so when it is gone', async () => {
    const directory = await root();
    const file = join(directory, 'scene-service.json');
    const a = await host('Stereofold host A', file);
    const b = await host('Stereofold host B', file);
    try {
      const first = await openWithState(a.call);
      await a.call('continue_session', { assistant: 'Claude' });
      const joined = await b.call('continue_session', { assistant: 'Codex' });
      expect(joined.structuredContent.role).toBe('attached');

      // The owner leaves. Its record goes with it rather than pointing at a
      // port nobody is answering on.
      await a.close();
      await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });

      // B is still pointed at the scene it joined, and says plainly that it
      // lost it rather than inventing an empty one. Its next call finds no
      // scene to rejoin and says the same; only continue_session says there
      // is nothing left to continue.
      const orphaned = await b.call('get_inspection_state', { sessionId: first.sessionId });
      expect(orphaned.isError).toBe(true);
      expect(JSON.stringify(orphaned.content)).toMatch(/lost its connection to the shared scene on this Mac/);
      const again = await b.call('get_inspection_state', { sessionId: first.sessionId });
      expect(again.isError).toBe(true);
      expect(JSON.stringify(again.content)).toMatch(/lost its connection[^"]*no scene service is recorded[^"]*Call continue_session/);
      expect(JSON.stringify(again.content)).not.toMatch(/Open a structure/);
      expect((await b.call('continue_session', { assistant: 'Codex' })).structuredContent.role).toBe('none');

      // B opens its own structure and becomes the next owner cleanly.
      const second = await openWithState(b.call);
      const successor = await b.call('continue_session', { assistant: 'Codex' });
      expect(successor.structuredContent).toMatchObject({ role: 'owner', sessionId: second.sessionId });
      expect(successor.structuredContent.assistants.active).toBe('Codex');
      const record = parseSceneOwnerRecord(JSON.parse(await readFile(file, 'utf8')), undefined).record;
      expect(record?.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    } finally { await b.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('takes over a recorded owner that has stopped answering', async () => {
    const directory = await root();
    const file = join(directory, 'scene-service.json');
    const b = await host('Stereofold host B', file);
    try {
      // A record left behind by a host that was killed: the file survives, the
      // port does not. Nothing may attach to it.
      await writeFile(file, JSON.stringify({ version: SCENE_SERVICE_VERSION, origin: 'http://127.0.0.1:1', sceneId: 'ghost',
        token: 'a'.repeat(64), pid: 999999, uid: process.getuid?.(), startedAt: new Date(0).toISOString() }), { mode: 0o600 });

      const nothing = await b.call('continue_session', { assistant: 'Codex' });
      expect(nothing.structuredContent.role).toBe('none');
      expect(nothing.structuredContent.reason).toMatch(/not answering/);

      const mine = await openWithState(b.call);
      const takenOver = await b.call('continue_session', { assistant: 'Codex' });
      expect(takenOver.structuredContent).toMatchObject({ role: 'owner', sessionId: mine.sessionId, tookOver: true });
      const record = parseSceneOwnerRecord(JSON.parse(await readFile(file, 'utf8')), undefined).record;
      expect(record?.token).not.toBe('a'.repeat(64));
      expect((await stat(file)).mode & 0o077).toBe(0);
    } finally { await b.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('refuses a foreign token and a record written by another user', async () => {
    const directory = await root();
    const file = join(directory, 'scene-service.json');
    const a = await host('Stereofold host A', file);
    const b = await host('Stereofold host B', file);
    try {
      await openWithState(a.call);
      const shared = await a.call('continue_session', { assistant: 'Claude' });
      const origin = parseSceneOwnerRecord(JSON.parse(await readFile(file, 'utf8')), undefined).record!.origin;

      // A token that is not this scene's opens nothing, on either route.
      const foreign = { Authorization: `Bearer ${'b'.repeat(64)}` };
      expect((await fetch(`${origin}/scene/alive`, { headers: foreign })).status).toBe(403);
      expect((await fetch(`${origin}/scene`, { method: 'POST', headers: { ...foreign, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'get_inspection_state', arguments: { sessionId: shared.structuredContent.sessionId } }) })).status).toBe(403);

      // A record carrying that token is refused before anything is proxied.
      await writeFile(file, JSON.stringify({ version: SCENE_SERVICE_VERSION, origin, sceneId: 'not-ours',
        token: 'b'.repeat(64), uid: process.getuid?.() }), { mode: 0o600 });
      const refused = await b.call('continue_session', { assistant: 'Codex' });
      expect(refused.structuredContent.role).toBe('none');
      expect(refused.structuredContent.reason).toMatch(/not answering/);

      // A record owned by somebody else is refused by the file itself.
      const elsewhere = parseSceneOwnerRecord({ version: SCENE_SERVICE_VERSION, origin, token: 'c'.repeat(64), sceneId: 's', uid: 1 }, 501);
      expect(elsewhere.record).toBeUndefined();
      expect(elsewhere.reason).toMatch(/another user/);
    } finally { await b.close(); await a.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('says there is nothing to continue rather than opening an empty scene', async () => {
    const directory = await root();
    const a = await host('Stereofold host A', join(directory, 'scene-service.json'));
    try {
      const answer = await a.call('continue_session', { assistant: 'Claude' });
      expect(answer.isError).not.toBe(true);
      expect(answer.structuredContent.role).toBe('none');
      expect(JSON.stringify(answer.content)).toMatch(/Open a structure here first/);
    } finally { await a.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('reads the runtime file from the environment, the local config, then the home default', () => {
    expect(sceneServicePath({ env: { [SCENE_SERVICE_ENV]: '/tmp/named.json' }, home: '/home/me', config: {} })).toBe('/tmp/named.json');
    expect(sceneServicePath({ env: {}, home: '/home/me', config: { [SCENE_SERVICE_CONFIG_KEY]: '/opt/scene.json' } })).toBe('/opt/scene.json');
    expect(sceneServicePath({ env: {}, home: '/home/me', config: {} })).toBe(`/home/me/${SCENE_SERVICE_FILE}`);
    expect(() => sceneServicePath({ env: { [SCENE_SERVICE_ENV]: 'relative.json' }, home: '/home/me', config: {} })).toThrow(/absolute/);
    expect(() => sceneServicePath({ env: {}, home: '/home/me', config: { [SCENE_SERVICE_CONFIG_KEY]: 'relative.json' } })).toThrow(/absolute/);
  });

  it('reaches the owner over a Unix socket when the environment names one', async () => {
    // A sandboxed host (Claude Science's MCP sandbox) cannot open loopback TCP,
    // but may connect to a socket path its policy allows. A relay on that path
    // pipes to the owner; the joiner must send everything through it.
    const directory = await root();
    const file = join(directory, 'scene-service.json');
    const socket = join(directory, 'scene.sock');
    const a = await host('Stereofold host A', file);
    const b = await host('Sandboxed host B', file, { [SCENE_SOCKET_ENV]: socket });
    let relayed = 0;
    const relay = net.createServer(client => {
      relayed += 1;
      const upstream = net.connect(Number(new URL(owner.origin).port), '127.0.0.1');
      client.pipe(upstream); upstream.pipe(client);
      client.on('error', () => upstream.destroy()); upstream.on('error', () => client.destroy());
    });
    let owner = { origin: '' };
    try {
      const first = await openWithState(a.call);
      const shared = await a.call('continue_session', { assistant: 'Claude' });
      owner = { origin: shared.structuredContent.origin ?? parseSceneOwnerRecord(JSON.parse(await readFile(file, 'utf8')), process.getuid?.()).record!.origin };
      await new Promise<void>(done => relay.listen(socket, done));

      const joined = await b.call('continue_session', { assistant: 'Codex' });
      expect(joined.isError).not.toBe(true);
      expect(joined.structuredContent).toMatchObject({ role: 'attached', sessionId: first.sessionId });
      const readBack = await b.call('get_inspection_state', { sessionId: first.sessionId });
      expect(readBack.isError).not.toBe(true);
      expect(readBack.structuredContent.view.selectedResidueCount).toBe(3);
      // Everything went through the socket (one keep-alive connection carries several requests).
      expect(relayed).toBeGreaterThanOrEqual(1);
    } finally {
      await new Promise<void>(done => relay.close(() => done()));
      await b.close(); await a.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('refuses a relative socket path', async () => {
    const directory = await root();
    const file = join(directory, 'scene-service.json');
    const a = await host('Stereofold host A', file);
    const b = await host('Sandboxed host B', file, { [SCENE_SOCKET_ENV]: 'relative.sock' });
    try {
      await openWithState(a.call);
      await a.call('continue_session', { assistant: 'Claude' });
      const joined = await b.call('continue_session', { assistant: 'Codex' });
      expect(joined.isError).toBe(true);
      expect(JSON.stringify(joined.content)).toMatch(/STEREOFOLD_SCENE_SOCKET must be an absolute path/);
    } finally {
      await b.close(); await a.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('refuses a record it cannot trust, by reason', () => {
    const uid = 501;
    const good = { version: SCENE_SERVICE_VERSION, origin: 'http://127.0.0.1:9', token: 'd'.repeat(64), sceneId: 'one', uid };
    expect(parseSceneOwnerRecord(good, uid).record?.sceneId).toBe('one');
    expect(parseSceneOwnerRecord({ ...good, version: 2 }, uid).reason).toMatch(/different version/);
    expect(parseSceneOwnerRecord({ ...good, origin: 'http://10.0.0.4:9' }, uid).reason).toMatch(/loopback/);
    expect(parseSceneOwnerRecord({ ...good, token: 'short' }, uid).reason).toMatch(/no usable token/);
    expect(parseSceneOwnerRecord({ ...good, sceneId: '' }, uid).reason).toMatch(/names no scene/);
    expect(parseSceneOwnerRecord('not an object', uid).reason).toMatch(/settings object/);
  });
});

describe('a host that lost its attachment to the shared scene', () => {
  /** An owner holding the named sessions, sharing `first`, whose state tool records each call that reaches it. */
  async function owning(file: string, sessions: Set<string>) {
    const reached: string[] = [];
    const owner = new LocalSceneService({ file, env: {}, live: id => sessions.has(id) });
    owner.register('get_inspection_state', async (args: any) => { reached.push(args.sessionId); return { sessionId: args.sessionId }; });
    owner.noteSession('first');
    expect(await owner.offer()).toBe(true);
    return { owner, reached };
  }
  /** A way to the owner whose next POST fails after the owner has taken it, as a timeout or a reset does. */
  function flaky() {
    const route = { failNext: false, posted: [] as string[] };
    const fetching: typeof fetch = async (url, init) => {
      const response = await fetch(url, init);
      if (init?.method !== 'POST') return response;
      route.posted.push(JSON.parse(String(init.body)).name);
      if (!route.failNext) return response;
      route.failNext = false;
      await response.body?.cancel();
      throw TypeError('fetch failed');
    };
    return { route, fetching };
  }
  const failure = async (pending: Promise<unknown>) => (await pending.then(() => undefined, error => error as Error))?.message ?? '';

  it('rejoins after its server restarts, on the first call it makes', async () => {
    // Claude Science's first style edit after a quiet spell came back "session
    // was not found or has expired" while the owner still held the scene. A
    // restarted server is the plainest way to lose the attachment: it holds
    // nothing, and has only the session ID its assistant kept.
    const directory = await root(), file = join(directory, 'scene-service.json');
    const a = await host('Stereofold host A', file);
    const b = await host('Stereofold host B, restarted', file);
    try {
      const first = await openWithState(a.call);
      await a.call('continue_session', { assistant: 'Claude' });

      const panel = await b.call('attach_inspection', { ...first.binding, surface: 'companion' });
      expect(panel.isError).not.toBe(true);
      const changed = await b.call('update_inspection', { ...first.binding, panelId: panel.structuredContent.panelId,
        commandId: 'after-restart-1', change: { kind: 'appearance', patch: { uniformColor: '#ff8800' } } });
      expect(changed.isError).not.toBe(true);
      const seenByA = await a.call('get_inspection_state', { sessionId: first.sessionId, commandId: 'after-restart-1' });
      expect(seenByA.structuredContent.command.commandId).toBe('after-restart-1');
      expect((await b.call('continue_session', { assistant: 'Codex' })).structuredContent)
        .toMatchObject({ role: 'attached', sessionId: first.sessionId });
    } finally { await b.close(); await a.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('sends a voice edit that names only its utteranceId to the owner, which holds that utterance', async () => {
    const directory = await root(), file = join(directory, 'scene-service.json');
    const { owner } = await owning(file, new Set(['first']));
    const seen: any[] = [];
    owner.register('update_inspection', async (args: any) => { seen.push(args); return { ok: true }; });
    const joiner = new LocalSceneService({ file, env: {}, live: () => false });
    try {
      expect(await joiner.share({ assistant: 'Claude' })).toMatchObject({ role: 'attached', sessionId: 'first' });
      const change = { kind: 'placement', patch: { scale: 1.25 } };
      expect(await joiner.forward('update_inspection', { utteranceId: 'u-1', change })).toEqual({ value: { ok: true } });
      expect(seen).toEqual([{ utteranceId: 'u-1', change, assistant: 'Claude' }]);
      // Without a session or an utterance there is nothing to name the owner's scene by.
      expect(await joiner.forward('update_inspection', { change })).toBeUndefined();
    } finally { await owner.close?.(); await rm(directory, { recursive: true, force: true }); }
  });

  it('sends a failed call once, then rejoins before the next one', async () => {
    const directory = await root(), file = join(directory, 'scene-service.json');
    const { owner, reached } = await owning(file, new Set(['first']));
    const { route, fetching } = flaky();
    const joiner = new LocalSceneService({ file, env: {}, live: () => false, fetch: fetching });
    try {
      expect(await joiner.share()).toMatchObject({ role: 'attached', sessionId: 'first' });
      route.failNext = true;
      const lost = await failure(joiner.forward('get_inspection_state', { sessionId: 'first' }));
      expect(lost).toMatch(/lost its connection to the shared scene on this Mac[\s\S]*Call continue_session/);
      expect(lost).not.toMatch(/Open a structure/);
      expect(joiner.role).toBe('none');
      // The owner ran the call once, and nothing sent it again.
      expect(reached).toEqual(['first']);
      expect(route.posted).toEqual(['scene.describe', 'get_inspection_state']);

      expect(await joiner.forward('get_inspection_state', { sessionId: 'first' })).toEqual({ value: { sessionId: 'first' } });
      expect(joiner.role).toBe('attached');
      expect(reached).toEqual(['first', 'first']);
      expect(route.posted).toEqual(['scene.describe', 'get_inspection_state', 'scene.describe', 'get_inspection_state']);
    } finally { await joiner.close(); await owner.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('names continue_session when the owner now holds a different session', async () => {
    const directory = await root(), file = join(directory, 'scene-service.json');
    const sessions = new Set(['first']);
    const { owner, reached } = await owning(file, sessions);
    const { route, fetching } = flaky();
    const joiner = new LocalSceneService({ file, env: {}, live: () => false, fetch: fetching });
    const restarted = new LocalSceneService({ file, env: {}, live: () => false });
    try {
      await joiner.share();
      route.failNext = true;
      await failure(joiner.forward('get_inspection_state', { sessionId: 'first' }));
      // The owner opens another structure while the joiner is away.
      sessions.add('second');
      owner.noteSession('second');

      // The joiner proxied `first`, so it says it lost the shared scene.
      const lost = await failure(joiner.forward('get_inspection_state', { sessionId: 'first' }));
      expect(lost).toMatch(/lost its connection to the shared scene that held session first[\s\S]*different session[\s\S]*Call continue_session/);
      expect(lost).not.toMatch(/Open a structure/);
      // A restarted host never proxied it, and is sent the same way.
      const stranger = await failure(restarted.forward('get_inspection_state', { sessionId: 'first' }));
      expect(stranger).toMatch(/not found in this host or in the shared scene[\s\S]*different session[\s\S]*Call continue_session/);
      expect(stranger).not.toMatch(/Open a structure/);
      expect([joiner.role, restarted.role, reached.length]).toEqual(['none', 'none', 1]);

      // continue_session joins the scene open now; the old session still refers the assistant there.
      expect(await joiner.share()).toMatchObject({ role: 'attached', sessionId: 'second' });
      expect(await failure(joiner.forward('get_inspection_state', { sessionId: 'first' })))
        .toMatch(/held session first[\s\S]*moved to another session[\s\S]*Call continue_session/);
    } finally {
      await restarted.close(); await joiner.close(); await owner.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('answers a proxied session the owner no longer holds with continue_session', async () => {
    const directory = await root(), file = join(directory, 'scene-service.json');
    const sessions = new Set(['first']);
    const { owner, reached } = await owning(file, sessions);
    const joiner = new LocalSceneService({ file, env: {}, live: () => false });
    try {
      await joiner.share();
      // The owner's session expires before the joiner's next call reaches it.
      sessions.delete('first');
      const ended = await failure(joiner.forward('get_inspection_state', { sessionId: 'first' }));
      expect(ended).toMatch(/no longer open in the shared scene on this Mac[\s\S]*Call continue_session/);
      expect(ended).not.toMatch(/Open a structure/);
      expect(reached).toEqual([]);
    } finally { await joiner.close(); await owner.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('sends a restarted host to continue_session while a silent owner still runs', async () => {
    const directory = await root();
    // Nothing answers on port 1. Only the first record names a process that still runs.
    const silent = { version: SCENE_SERVICE_VERSION, origin: 'http://127.0.0.1:1', sceneId: 'silent', token: 'a'.repeat(64), uid: process.getuid?.() };
    const running = join(directory, 'running.json'), exited = join(directory, 'exited.json'), missing = join(directory, 'missing.json');
    await writeFile(running, JSON.stringify({ ...silent, pid: process.pid }), { mode: 0o600 });
    await writeFile(exited, JSON.stringify({ ...silent, pid: 999999 }), { mode: 0o600 });
    const hosts = [running, exited, missing].map(file => new LocalSceneService({ file, env: {}, live: () => false }));
    const b = await host('Stereofold host B', running);
    try {
      const refused = await failure(hosts[0].forward('get_inspection_state', { sessionId: 'first' }));
      expect(refused).toMatch(/not found in this host or in the shared scene[\s\S]*not answering[\s\S]*Call continue_session/);
      // With no owner left to split from, the local handler answers as it always did.
      expect(await hosts[1].forward('get_inspection_state', { sessionId: 'first' })).toBeUndefined();
      expect(await hosts[2].forward('get_inspection_state', { sessionId: 'first' })).toBeUndefined();
      expect(hosts.map(scene => scene.role)).toEqual(['none', 'none', 'none']);

      // continue_session says to try again, not to open a second scene.
      const answer = await b.call('continue_session', { assistant: 'Codex' });
      expect(answer.structuredContent).toMatchObject({ role: 'none', retry: true, recordPath: running });
      expect(JSON.stringify(answer.content)).toMatch(/call continue_session again/);
      expect(JSON.stringify(answer.content)).not.toMatch(/Open a structure here first/);
    } finally {
      await b.close(); await Promise.all(hosts.map(scene => scene.close()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('reads no owner file for the calls a host answers itself', async () => {
    const directory = await root(), file = join(directory, 'scene-service.json');
    const { owner } = await owning(file, new Set(['first']));
    let asked = 0, fetched = 0;
    const alone = new LocalSceneService({ get file() { asked += 1; return file; }, env: {}, live: id => id === 'mine',
      fetch: async (url, init) => { fetched += 1; return await fetch(url, init); } });
    try {
      // A session held here, a call that opens one, and a sessionless call.
      expect(await alone.forward('get_inspection_state', { sessionId: 'mine' })).toBeUndefined();
      expect(await alone.forward('inspect', { structureText: cif })).toBeUndefined();
      expect(await alone.forward('say_to_headset', { text: 'Hello.' })).toBeUndefined();
      expect([asked, fetched, alone.role]).toEqual([0, 0, 'none']);
      // A session held nowhere here is the one kind of call that reads it.
      expect(await alone.forward('get_inspection_state', { sessionId: 'first' })).toEqual({ value: { sessionId: 'first' } });
      expect(asked).toBe(1);
    } finally { await alone.close(); await owner.close(); await rm(directory, { recursive: true, force: true }); }
  });
});

describe('a scene offered by a Wi-Fi share', () => {
  /** A host that has just shared a structure: one live local session and nothing else. */
  function sharing(file: string, sessionId = 'shared-here') {
    const scene = new LocalSceneService({ file, env: {}, live: () => true });
    scene.noteSession(sessionId);
    return scene;
  }
  const recorded = async (file: string) => parseSceneOwnerRecord(JSON.parse(await readFile(file, 'utf8')), process.getuid?.()).record;

  it('publishes when no scene is recorded, and only once', async () => {
    const directory = await root(), file = join(directory, 'scene-service.json');
    const closed = new LocalSceneService({ file, env: {}, live: () => false }), a = sharing(file);
    try {
      // A host whose structure has closed has nothing to offer.
      closed.noteSession('gone');
      expect(await closed.offer()).toBe(false);
      await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });

      expect(await a.offer()).toBe(true);
      expect(a.role).toBe('owner');
      const record = await recorded(file);
      expect(record?.origin).toBe(a.origin);
      expect((await stat(file)).mode & 0o077).toBe(0);
      // Already the owner: nothing is published a second time.
      expect(await a.offer()).toBe(false);
      expect((await recorded(file))?.token).toBe(record?.token);
    } finally { await closed.close(); await a.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('leaves a live owner in place and never attaches to it', async () => {
    const directory = await root(), file = join(directory, 'scene-service.json');
    const a = sharing(file, 'first'), b = sharing(file, 'second');
    try {
      await a.offer();
      const live = await recorded(file);
      expect(await b.offer()).toBe(false);
      // Under a process ID that no longer runs, an owner that answers still keeps its record.
      await writeFile(file, JSON.stringify({ ...live, pid: 999999 }), { mode: 0o600 });
      expect(await b.offer()).toBe(false);
      expect(b.role).toBe('none');
      expect((await recorded(file))?.token).toBe(live?.token);
    } finally { await b.close(); await a.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('does nothing for a host already attached to another scene', async () => {
    const directory = await root(), file = join(directory, 'scene-service.json');
    const a = sharing(file, 'first'), b = sharing(file, 'second');
    try {
      await a.offer();
      expect(await b.share()).toMatchObject({ role: 'attached', sessionId: 'first' });
      const token = (await recorded(file))?.token;
      expect(await b.offer()).toBe(false);
      expect(b.role).toBe('attached');
      expect((await recorded(file))?.token).toBe(token);
    } finally { await b.close(); await a.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('replaces only a record whose owner neither answers nor runs', async () => {
    const directory = await root();
    const ghost = { version: SCENE_SERVICE_VERSION, origin: 'http://127.0.0.1:1', sceneId: 'ghost', token: 'a'.repeat(64), uid: process.getuid?.() };
    const exited = join(directory, 'exited.json'), running = join(directory, 'running.json'), unreadable = join(directory, 'unreadable.json');
    await writeFile(exited, JSON.stringify({ ...ghost, pid: 999999 }), { mode: 0o600 });
    // A host sandboxed away from loopback cannot reach a live owner, so an
    // owner whose process still runs keeps its record though nothing answered.
    await writeFile(running, JSON.stringify({ ...ghost, pid: process.pid }), { mode: 0o600 });
    await writeFile(unreadable, 'not a record', { mode: 0o600 });
    const hosts = [sharing(exited), sharing(running), sharing(unreadable)];
    try {
      expect(await Promise.all(hosts.map(scene => scene.offer()))).toEqual([true, false, false]);
      expect((await recorded(exited))?.token).not.toBe(ghost.token);
      expect((await recorded(running))?.token).toBe(ghost.token);
      expect(await readFile(unreadable, 'utf8')).toBe('not a record');
    } finally { await Promise.all(hosts.map(scene => scene.close())); await rm(directory, { recursive: true, force: true }); }
  });

  it('lets a second host join the scene of a Wi-Fi share opened before anyone asked', async () => {
    const lanAddress = listLanAddresses()[0];
    if (!lanAddress) return; // No private interface: this host cannot run a LAN listener.
    const directory = await root(), file = join(directory, 'scene-service.json');
    await writeFile(join(directory, 'inspector.html'), '<html><script>void 0;</script></html>');
    // The server's LAN companion reads its certificate store when it is built.
    const store = process.env.STEREOFOLD_LAN_CERTIFICATE_STORE;
    process.env.STEREOFOLD_LAN_CERTIFICATE_STORE = join(directory, 'lan');
    const a = await host('Stereofold host A', file, undefined, join(directory, 'viewer.html'));
    const b = await host('Stereofold host B', file);
    try {
      // The skills ask before anything is open, so A shared nothing then.
      expect((await a.call('continue_session', { assistant: 'Claude' })).structuredContent.role).toBe('none');
      const first = await openWithState(a.call);
      const opened = await a.call('open_companion', { ...first.binding, connection: 'lan', lanHost: lanAddress.address,
        lanPort: await unusedPort(lanAddress.address) });
      expect(opened.isError).not.toBe(true);

      // B joins A's session rather than opening a share of its own on A's port.
      const joined = await b.call('continue_session', { assistant: 'Codex' });
      expect(joined.structuredContent).toMatchObject({ role: 'attached', sessionId: first.sessionId });
      expect(joined.structuredContent.scene).toMatchObject({ hasScene: true, selectedResidueCount: 3 });
    } finally {
      await b.close(); await a.close();
      if (store === undefined) delete process.env.STEREOFOLD_LAN_CERTIFICATE_STORE; else process.env.STEREOFOLD_LAN_CERTIFICATE_STORE = store;
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('an owner whose shared session has ended', () => {
  const recorded = async (file: string) => parseSceneOwnerRecord(JSON.parse(await readFile(file, 'utf8')), process.getuid?.()).record;

  it('removes its own record, so the next host to share becomes the owner', async () => {
    const directory = await root(), file = join(directory, 'scene-service.json');
    let open = true;
    const a = new LocalSceneService({ file, env: {}, live: () => open }), b = new LocalSceneService({ file, env: {}, live: () => true });
    a.noteSession('first');
    b.noteSession('second');
    try {
      expect(await a.offer()).toBe(true);
      // A session this host does not share ends: the scene stays where it is.
      await a.sessionEnded('elsewhere');
      expect(a.role).toBe('owner');
      expect(await b.offer()).toBe(false);

      open = false;
      await a.sessionEnded('first');
      expect(a.role).toBe('none');
      await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await b.offer()).toBe(true);
      expect(b.role).toBe('owner');
    } finally { await b.close(); await a.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('leaves a record that a successor has already written', async () => {
    const directory = await root(), file = join(directory, 'scene-service.json');
    const a = new LocalSceneService({ file, env: {}, live: () => true });
    a.noteSession('first');
    try {
      await a.offer();
      const successor = { ...(await recorded(file)), token: 'b'.repeat(64), sceneId: 'successor' };
      await writeFile(file, JSON.stringify(successor), { mode: 0o600 });
      await a.sessionEnded('first');
      expect(a.role).toBe('none');
      expect((await recorded(file))?.token).toBe(successor.token);
    } finally { await a.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('gives the scene up when its session expires with nobody calling, and another host takes it', async () => {
    // Only the owner's sweep runs on the fake clock; loopback and MCP keep real timers.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let clock = Date.now();
    const directory = await root(), file = join(directory, 'scene-service.json');
    const a = await host('Stereofold host A', file, undefined, undefined, () => clock);
    const b = await host('Stereofold host B', file);
    try {
      await openWithState(a.call);
      expect((await a.call('continue_session', { assistant: 'Claude' })).structuredContent.role).toBe('owner');
      clock += DEFAULT_SESSION_TTL_MS - 1;
      vi.advanceTimersByTime(SCENE_SWEEP_MS);
      expect((await recorded(file))?.pid).toBe(process.pid);

      // A's process keeps running after its session has gone idle.
      clock += 1;
      vi.advanceTimersByTime(SCENE_SWEEP_MS);
      await vi.waitFor(async () => { await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' }); });

      const second = await openWithState(b.call);
      const continued = await b.call('continue_session', { assistant: 'Codex' });
      expect(continued.structuredContent).toMatchObject({ role: 'owner', sessionId: second.sessionId });
      expect(continued.structuredContent.tookOver).toBeUndefined();
    } finally {
      vi.useRealTimers();
      await b.close(); await a.close(); await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('an owner stopped by a signal', () => {
  const recorded = async (file: string) => parseSceneOwnerRecord(JSON.parse(await readFile(file, 'utf8')), process.getuid?.()).record;
  // The quest launcher stops its host with SIGTERM to the whole process group,
  // and Ctrl-C sends SIGINT. Either one used to kill the stdio server before it
  // closed, so the record named a dead owner and a relay forwarded to it.
  it.each(['SIGTERM', 'SIGINT'] as const)('removes its record when %s ends the process', async signal => {
    const directory = await root(), file = join(directory, 'scene-service.json');
    const transport = new StdioClientTransport({ command: process.execPath,
      args: ['--import', 'tsx', fileURLToPath(new URL('../src/server.ts', import.meta.url))],
      cwd: fileURLToPath(new URL('..', import.meta.url)), stderr: 'pipe',
      env: { ...getDefaultEnvironment(), HOME: directory, [SCENE_SERVICE_ENV]: file } });
    const client = new Client({ name: 'signal check', version: '1' });
    try {
      await client.connect(transport);
      const call = async (name: string, args: Record<string, unknown>) =>
        await client.callTool({ name: `stereo_structure.${name}`, arguments: args }) as any;
      await call('inspect', { structureText: cif });
      expect((await call('continue_session', { assistant: 'Claude' })).structuredContent.role).toBe('owner');
      const pid = transport.pid!;
      expect((await recorded(file))?.pid).toBe(pid);
      const closed = new Promise<void>(done => { transport.onclose = () => done(); });
      process.kill(pid, signal);
      await closed;
      expect(() => process.kill(pid, 0)).toThrow();
      await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await client.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
