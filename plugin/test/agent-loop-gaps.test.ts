import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, expect, it, vi } from 'vitest';
import { createStereoStructureServer } from '../src/server.js';
import { LocalSceneService, SCENE_SERVICE_VERSION } from '../src/scene-service.js';
import { InspectionCompanionHttp } from '../src/inspection-companion-http.js';
import { InspectionCommands } from '../src/inspection-commands.js';
import { PRIVATE_INSPECTION_META_KEY as KEY, expectedInspection } from '../src/inspection-contract.js';

const cif = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
async function host(sceneService: LocalSceneService) {
  const server = createStereoStructureServer(undefined, { sceneService, loopbackListenDenied: async () => false });
  const client = new Client({ name: 'Agent loop regression', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  return { call: (name: string, args: Record<string, unknown> = {}) => client.callTool({
    name: 'stereo_structure.' + name, arguments: args,
  }) as Promise<any>, close: async () => { await client.close(); await server.close(); } };
}
async function setup() {
  const directory = await mkdtemp(join(process.cwd(), '.agent-loop-test-'));
  const file = join(directory, 'scene-service.json');
  const owner = new LocalSceneService({ file, live: () => true });
  const a = await host(owner);
  const sessionId = (await a.call('inspect', { structureText: cif })).structuredContent.sessionId;
  const data = (await a.call('get_inspection', { sessionId }))._meta[KEY];
  const scene: any = { sourceSha256: data.catalog.source.sha256, modelNumber: data.catalog.modelNumbers[0], assemblyId: data.catalog.assemblyId,
    selectionKeys: [], camera: { mode: 'perspective', fov: Math.PI / 4, position: [0, 0, 80], target: [0, 0, 0], up: [0, 1, 0],
      radius: 20, radiusMax: 20, fog: 50, clipFar: true, minNear: 5, minFar: 0 },
    inspection: { appearance: { representation: 'cartoon', color: 'chain-id', uniformColor: '#58dcc9', background: '#071015', opacity: 1,
      labels: false, highlightColor: '#f2c47c', clipping: 0, fog: 0 }, placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } } };
  let binding = { sessionId, serverEpoch: data.serverEpoch, sourceToken: data.sourceToken,
    baseStateRevision: data.stateRevision, baseInspectionRevision: data.inspectionRevision };
  const saved = await a.call('sync_inspection', { ...binding, scene });
  binding = { ...binding, baseInspectionRevision: saved.structuredContent.inspectionRevision };
  const panelId = (await a.call('attach_inspection', { ...binding, surface: 'companion' })).structuredContent.panelId;
  return { a, owner, directory, file, sessionId, scene, binding, panelId,
    close: async () => { await a.close(); await rm(directory, { recursive: true, force: true }); } };
}

async function joinOwner(t: Awaited<ReturnType<typeof setup>>) {
  // Exercise real discovery, attachment, forwarding and owner dispatch without
  // opening a listener. Only the HTTP exchange is replaced by in-memory JSON.
  const token = 'a'.repeat(64);
  await writeFile(t.file, JSON.stringify({ version: SCENE_SERVICE_VERSION, origin: 'http://127.0.0.1:12345', token, sceneId: 'test-scene' }), { mode: 0o600 });
  const remote = new LocalSceneService({ file: t.file, fetch: async (_url, init) => {
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${token}`);
    if (init?.method !== 'POST') return new Response(null, { status: 204 });
    const body = JSON.parse(String(init.body));
    const result = await t.owner.dispatch(body.name, body.arguments);
    return new Response(JSON.stringify({ result }), { status: 200 });
  } });
  const b = await host(remote);
  const joined = await b.call('continue_session', { assistant: 'Codex' });
  expect(joined.structuredContent).toMatchObject({ role: 'attached', sessionId: t.sessionId });
  return b;
}

it.each([false, true])('attached edits use receipt notifications, with poll fallback=%s', async fallback => {
  const t = await setup(); const b = await joinOwner(t);
  try {
    if (fallback) vi.spyOn(InspectionCommands.prototype, 'onReceiptChange').mockImplementation(() => () => {});
    vi.useFakeTimers();
    let finished = false;
    const waiting = b.call('update_inspection', { sessionId: t.sessionId, commandId: 'attached-edit',
      change: { kind: 'appearance', patch: { opacity: .6 } }, waitForRenderMs: 5000 }).then(answer => { finished = true; return answer; });
    await vi.advanceTimersByTimeAsync(0);
    const poll = await t.a.call('poll_inspection', { ...t.binding, panelId: t.panelId, availability: 'ready' });
    const delivery = poll._meta[KEY].delivery;
    expect(delivery.commandId).toBe('attached-edit');
    const completed = await t.a.call('complete_inspection', { ...t.binding, panelId: t.panelId,
      commandId: delivery.commandId, claimToken: delivery.claimToken, scene: expectedInspection(t.scene, delivery.change) });
    expect(completed.structuredContent.command.status).toBe('rendered');
    await vi.advanceTimersByTimeAsync(0);
    expect(finished).toBe(!fallback);
    if (fallback) {
      await vi.advanceTimersByTimeAsync(999); expect(finished).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
    }
    expect((await waiting).structuredContent.command.status).toBe('rendered');
    if (!fallback) {
      finished = false;
      const next = b.call('update_inspection', { sessionId: t.sessionId, commandId: 'attached-successor',
        change: { kind: 'appearance', patch: { labels: true } }, waitForRenderMs: 5000 })
        .then(answer => { finished = true; return answer; });
      await vi.advanceTimersByTimeAsync(0);
      const binding = { ...t.binding, baseInspectionRevision: completed.structuredContent.inspectionRevision };
      const following = (await t.a.call('poll_inspection', { ...binding, panelId: t.panelId, availability: 'ready' }))._meta[KEY].delivery;
      expect(following.commandId).toBe('attached-successor');
      await t.a.call('complete_inspection', { ...binding, panelId: t.panelId, commandId: following.commandId,
        claimToken: following.claimToken, scene: expectedInspection(expectedInspection(t.scene, delivery.change), following.change) });
      await vi.advanceTimersByTimeAsync(0);
      expect(finished).toBe(true);
      expect((await next).structuredContent.command.status).toBe('rendered');
    }
  } finally { vi.useRealTimers(); await b.close(); await t.close(); }
});

it('offers a saved loopback companion scene without launching a page', async () => {
  const t = await setup();
  try {
    const opened = vi.spyOn(InspectionCompanionHttp.prototype, 'open').mockResolvedValue({
      url: 'http://127.0.0.1:12345/?key=test', port: 12345,
    } as any);
    const offer = vi.spyOn(t.owner, 'offer').mockResolvedValue(true);
    const answer = await t.a.call('open_companion', { ...t.binding, connection: 'loopback', launch: 'none' });
    expect(answer.isError).not.toBe(true);
    expect(answer.structuredContent.companion.connection).toBe('loopback');
    expect(opened).toHaveBeenCalledOnce(); expect(offer).toHaveBeenCalledOnce();
    expect((await t.owner.dispatch('scene.describe', {})) as any).toMatchObject({ sessionId: t.sessionId });
  } finally { await t.close(); }
});

it('a loopback offer leaves another running owner record intact', async () => {
  const t = await setup();
  try {
    vi.spyOn(InspectionCompanionHttp.prototype, 'open').mockResolvedValue({
      url: 'http://127.0.0.1:12345/?key=test', port: 12345,
    } as any);
    const existing = JSON.stringify({ version: SCENE_SERVICE_VERSION, origin: 'http://127.0.0.1:12346',
      token: 'b'.repeat(64), sceneId: 'existing-scene', pid: process.pid });
    await writeFile(t.file, existing, { mode: 0o600 });
    const offer = vi.spyOn(t.owner, 'offer');
    const answer = await t.a.call('open_companion', { ...t.binding, connection: 'loopback', launch: 'none' });
    expect(answer.isError).not.toBe(true);
    expect(offer).toHaveBeenCalledOnce();
    expect(t.owner.role).toBe('none');
    expect(await readFile(t.file, 'utf8')).toBe(existing);
  } finally { await t.close(); }
});
