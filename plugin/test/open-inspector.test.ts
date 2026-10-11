/**
 * The inspector panel a terminal host gets from the server
 * itself. Terminal Claude Code mounts no MCP App, so until this existed no
 * scene could be saved from it and `open_companion` refused every session.
 * These cases are the contract: loopback only, an ephemeral port, the same
 * inspector document the MCP App resource serves, the panel's own
 * `sync_inspection` path, the launcher's three outcomes in the result, a
 * listener that dies with the server, and a page key that dies with its
 * session.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStereoStructureServer } from '../src/server.js';
import { INSPECTOR_PANEL_COMPANION_ACTIONS, INSPECTOR_PANEL_TOOLS, InspectorPanelHost, LOOPBACK_ADDRESS } from '../src/inspector-panel-host.js';
import { PRIVATE_INSPECTION_META_KEY as KEY } from '../src/inspection-contract.js';
import { createReplyAudioSynthesizer } from '../src/headset-reply-audio.js';
import { markHostOpenedUrl } from '../src/renderer-tab.js';
import { LanCompanion } from '../src/inspection-lan.js';
import { InspectionCompanionHttp } from '../src/inspection-companion-http.js';
import { LocalSceneService } from '../src/scene-service.js';

const cif = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');
const INSPECTOR_HTML = '<!doctype html><html><head><meta charset="utf-8"><title>Stereofold Inspector</title></head><body><div id="app"></div><script>void 0;</script></body></html>';
const HOST_JS = '(()=>{window.__host={mount(){}};})();';
const silentReplyAudio = createReplyAudioSynthesizer({ enabled: false });

type Launch = { command: string; args: string[] };

async function reachable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host: LOOPBACK_ADDRESS, port });
    const settle = (value: boolean) => { socket.destroy(); resolve(value); };
    socket.setTimeout(2_000, () => settle(false));
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
  });
}

/** One request with a Host header fetch would refuse to set. */
function rawGet(port: number, path: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: LOOPBACK_ADDRESS, port, path, method: 'GET', headers: { Host: host } }, response => {
      response.resume(); response.once('end', () => resolve(response.statusCode ?? 0));
    });
    request.once('error', reject);
    request.end();
  });
}

/** One request as raw bytes, for what fetch and http.request refuse to send: no Host header at all. */
function rawRequest(port: number, message: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: LOOPBACK_ADDRESS, port }, () => socket.end(message));
    let received = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => { received += chunk; });
    socket.once('error', reject);
    socket.once('close', () => resolve(received));
    socket.setTimeout(3_000, () => socket.destroy());
  });
}
const statusOf = (raw: string) => Number(/^HTTP\/1\.[01] (\d{3})/u.exec(raw)?.[1] ?? 0);

/** True once `check` holds, polled for at most `timeoutMs`. */
async function until(check: () => Promise<boolean> | boolean, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return true;
}

async function setup(options: Record<string, unknown> = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'stereofold-panel-host-'));
  await writeFile(join(folder, 'viewer.html'), '<html><script>void 0;</script></html>');
  await writeFile(join(folder, 'inspector.html'), INSPECTOR_HTML);
  await writeFile(join(folder, 'inspector-host.js'), HOST_JS);
  const launched: Launch[] = [];
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createStereoStructureServer(join(folder, 'viewer.html'), {
    replyAudio: silentReplyAudio,
    questLaunch: { platform: 'darwin', opener: '/bin/echo',
      launch: (command: string, args: readonly string[]) => { launched.push({ command, args: [...args] }); return { reason: 'started' as const }; } },
    ...options,
  });
  const client = new Client({ name: 'open_inspector contract test', version: '1' });
  await server.connect(b); await client.connect(a);
  const call = async (name: string, args: Record<string, unknown>) => await client.callTool({ name: `stereo_structure.${name}`, arguments: args }) as any;
  const opened = await call('inspect', { structureText: cif });
  expect(opened.isError).not.toBe(true);
  const sessionId = opened.structuredContent.sessionId as string;
  const data = (await call('get_inspection', { sessionId }))._meta[KEY];
  const scene = { sourceSha256: data.catalog.source.sha256, modelNumber: data.catalog.modelNumbers[0], assemblyId: data.catalog.assemblyId,
    selectionKeys: [data.catalog.rows[0].key],
    camera: { mode: 'perspective', fov: Math.PI / 4, position: [0, 0, 80], up: [0, 1, 0], target: [0, 0, 0], radius: 20, radiusMax: 20, fog: 50, clipFar: true, minNear: 5, minFar: 0 },
    inspection: { appearance: { representation: 'molecular-surface', color: 'uniform', uniformColor: '#44aaff', background: '#192734', opacity: .4, labels: true, highlightColor: '#ffccee', clipping: 20, fog: 30 },
      placement: { translation: [.5, 0, 0], rotation: [0, 30, 0], scale: 1.2 } } };
  const binding = { serverEpoch: data.serverEpoch, sourceToken: data.sourceToken, baseStateRevision: data.stateRevision, baseInspectionRevision: data.inspectionRevision };
  return { server, client, call, opened, sessionId, scene, binding, launched, folder,
    close: async () => { await client.close(); await server.close(); await rm(folder, { recursive: true, force: true }); } };
}

const keyOf = (url: string) => new URL(url).hash.slice(1);
const originOf = (url: string) => new URL(url).origin;
const portOf = (url: string) => Number(new URL(url).port);
/** What the boot script sends: the page key as a bearer, the page's own origin, JSON. */
function rpc(url: string, name: string, args: Record<string, unknown>, headers: Record<string, string> = {}) {
  return fetch(`${originOf(url)}/rpc`, { method: 'POST', body: JSON.stringify({ name, arguments: args }),
    headers: { Authorization: `Bearer ${keyOf(url)}`, Origin: originOf(url), 'Content-Type': 'application/json', ...headers } });
}

describe('open_inspector, the panel a host with no panel gets from the server', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); });

  it('serves the inspector on 127.0.0.1 at an ephemeral port and hands the Mac browser the marked address', async () => {
    const t = await setup(); cleanups.push(t.close);
    const answer = await t.call('open_inspector', { sessionId: t.sessionId });
    expect(answer.isError).not.toBe(true);
    const inspector = answer.structuredContent.inspector;
    expect(inspector.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#[a-f0-9]{64}$/u);
    expect(portOf(inspector.url)).toBeGreaterThan(0);
    expect(inspector.port).toBe(portOf(inspector.url));
    expect(inspector.opened).toBe(true);
    expect(inspector.openReason).toBe('started');
    // Exactly one address reaches the desktop: the one returned, stamped so
    // the tab can close itself when this server is gone.
    expect(t.launched).toEqual([{ command: '/bin/echo', args: [markHostOpenedUrl(inspector.url)] }]);
    expect(answer.content[0].text).toContain('Browser started on your Mac');
    expect(answer.content[0].text.split(inspector.url)).toHaveLength(2);

    const origin = originOf(inspector.url);
    const page = await fetch(`${origin}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    const pageText = await page.text();
    expect(pageText).toContain('<script src="/host.js">');
    expect(pageText).toContain('<script src="/boot.js">');
    expect(await (await fetch(`${origin}/host.js`)).text()).toBe(HOST_JS);
    expect((await fetch(`${origin}/alive`)).status).toBe(204);
    expect((await fetch(`${origin}/boot.js`)).headers.get('content-type')).toContain('javascript');

    // The bootstrap is the inspector document itself and an inspect-kind
    // result for this session, which is what the MCP App would mount with.
    expect((await fetch(`${origin}/bootstrap`)).status).toBe(401);
    const bootstrap = await fetch(`${origin}/bootstrap`, { headers: { Authorization: `Bearer ${keyOf(inspector.url)}` } });
    expect(bootstrap.status).toBe(200);
    const mount = await bootstrap.json();
    expect(mount.html).toBe(INSPECTOR_HTML);
    expect(mount.opened.structuredContent).toMatchObject({ kind: 'inspect', sessionId: t.sessionId, hasStructure: true,
      renderToken: t.opened.structuredContent.renderToken });

    // A second call for the same session is the same address, not a second key.
    const again = await t.call('open_inspector', { sessionId: t.sessionId, open: false });
    expect(again.structuredContent.inspector.url).toBe(inspector.url);
    expect(t.launched).toHaveLength(1);
  });

  it('saves the scene through the served sync route, after which open_companion admits the session', async () => {
    const t = await setup(); cleanups.push(t.close);
    // setup() fetched the coordinates the way a mounting panel does, so
    // open_companion waits for that panel and opens no tab of its own.
    const pending = await t.call('open_companion', { sessionId: t.sessionId, ...t.binding, waitForSceneMs: 200 });
    expect(pending.isError).not.toBe(true);
    expect(pending.structuredContent.sharePending.status).toBe('rendering');
    expect(t.launched).toHaveLength(0);

    const { url } = (await t.call('open_inspector', { sessionId: t.sessionId, open: false })).structuredContent.inspector;
    // The mounted inspector names tools with the server prefix; the route
    // strips it and stamps the session the link was opened for.
    const saved = await rpc(url, 'stereo_structure.sync_inspection', { ...t.binding, scene: t.scene });
    expect(saved.status).toBe(200);
    const savedResult = await saved.json();
    expect(savedResult.isError).not.toBe(true);
    expect(savedResult.structuredContent).toMatchObject({ saved: true, sessionId: t.sessionId, hasScene: true });

    const state = (await t.call('get_inspection_state', { sessionId: t.sessionId })).structuredContent;
    expect(state.hasScene).toBe(true);
    const admitted = await t.call('open_companion', { sessionId: t.sessionId, serverEpoch: state.serverEpoch, sourceToken: state.sourceToken,
      baseStateRevision: state.stateRevision, baseInspectionRevision: state.inspectionRevision });
    expect(admitted.isError).not.toBe(true);
    expect(admitted.structuredContent.companion.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//u);
    // A saved scene is shared as before: nothing is drawn or opened first.
    expect(admitted.content[0].text).not.toContain('drew and saved');
    expect(t.launched).toHaveLength(0);
  });

  it('refuses a call without the page key, from another origin, for another session, or to a tool the panel never calls', async () => {
    const t = await setup(); cleanups.push(t.close);
    const { url } = (await t.call('open_inspector', { sessionId: t.sessionId, open: false })).structuredContent.inspector;
    const origin = originOf(url);
    const body = JSON.stringify({ name: 'get_inspection_state', arguments: {} });
    expect((await fetch(`${origin}/rpc`, { method: 'POST', body, headers: { Origin: origin, 'Content-Type': 'application/json' } })).status).toBe(401);
    expect((await fetch(`${origin}/rpc`, { method: 'POST', body,
      headers: { Authorization: `Bearer ${'0'.repeat(64)}`, Origin: origin, 'Content-Type': 'application/json' } })).status).toBe(401);
    expect((await rpc(url, 'get_inspection_state', {}, { Origin: 'http://127.0.0.1:1' })).status).toBe(403);
    expect((await rpc(url, 'get_inspection_state', {}, { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect(await rawGet(portOf(url), '/', `localhost:${portOf(url)}`)).toBe(403);

    const wrongSession = await (await rpc(url, 'get_inspection_state', { sessionId: '00000000-0000-4000-8000-000000000000' })).json();
    expect(wrongSession).toMatchObject({ isError: true, content: [{ type: 'text', text: 'Wrong session' }] });
    const unavailable = await (await rpc(url, 'inspect', { structureText: cif })).json();
    expect(unavailable).toMatchObject({ isError: true, content: [{ type: 'text', text: 'Tool unavailable' }] });
    const allowed = await (await rpc(url, 'get_inspection_state', {})).json();
    expect(allowed.isError).not.toBe(true);
    expect(allowed.structuredContent.sessionId).toBe(t.sessionId);

    expect(INSPECTOR_PANEL_TOOLS.has('sync_inspection')).toBe(true);
    expect(INSPECTOR_PANEL_TOOLS.has('get_inspection')).toBe(true);
    expect(INSPECTOR_PANEL_TOOLS.has('attach_inspection')).toBe(true);
    for (const agentOnly of ['inspect', 'inspect_file', 'listen_voice', 'say_to_headset', 'read_headset_log', 'capture_headset_view', 'continue_session']) {
      expect(INSPECTOR_PANEL_TOOLS.has(agentOnly), agentOnly).toBe(false);
    }
  });

  it('reports a launch that failed or was not attempted in the result without failing the call', async () => {
    const failing = await setup({ questLaunch: { platform: 'darwin', opener: '/bin/echo', launch: () => { throw Error('spawn ENOENT'); } } });
    cleanups.push(failing.close);
    const failed = await failing.call('open_inspector', { sessionId: failing.sessionId });
    expect(failed.isError).not.toBe(true);
    expect(failed.structuredContent.inspector).toMatchObject({ opened: false, openReason: 'failed', openDetail: 'spawn ENOENT' });
    expect(failed.content[0].text).toContain('spawn ENOENT');
    expect(failed.content[0].text).toContain(failed.structuredContent.inspector.url);

    const elsewhere = await setup({ questLaunch: { platform: 'linux', launch: () => { throw Error('unreachable'); } } });
    cleanups.push(elsewhere.close);
    const notMac = await elsewhere.call('open_inspector', { sessionId: elsewhere.sessionId });
    expect(notMac.structuredContent.inspector).toMatchObject({ opened: false, openReason: 'not-macos' });
    expect(notMac.content[0].text).toContain('works only on macOS');

    const quiet = await setup(); cleanups.push(quiet.close);
    const printed = await quiet.call('open_inspector', { sessionId: quiet.sessionId, open: false });
    expect(printed.structuredContent.inspector.opened).toBe(false);
    expect(printed.structuredContent.inspector.openReason).toBeUndefined();
    expect(quiet.launched).toHaveLength(0);
    expect(printed.content[0].text).toContain('Open the whole address in a browser on this Mac');
  });

  it('needs an opened session, and stops listening when the server closes', async () => {
    const t = await setup();
    const missing = await t.call('open_inspector', { sessionId: '00000000-0000-4000-8000-000000000000', open: false });
    expect(missing.isError).toBe(true);
    const { url } = (await t.call('open_inspector', { sessionId: t.sessionId, open: false })).structuredContent.inspector;
    const port = portOf(url);
    expect(await reachable(port)).toBe(true);
    await t.close();
    expect(await reachable(port)).toBe(false);
  });

  it('binds loopback only, whatever it is asked', () => {
    const options = { htmlPath: '/x/inspector.html', hostScriptPath: '/x/inspector-host.js', opened: async () => ({}), dispatch: async () => ({}) };
    expect(() => new InspectorPanelHost({ ...options, bind: '0.0.0.0' })).toThrow('binds 127.0.0.1 only');
    expect(() => new InspectorPanelHost({ ...options, bind: 'localhost' })).toThrow('binds 127.0.0.1 only');
    expect(new InspectorPanelHost(options).port).toBeUndefined();
  });

  it('refuses a request with no Host header, an IPv6 host or origin, and a null origin', async () => {
    const t = await setup(); cleanups.push(t.close);
    const { url } = (await t.call('open_inspector', { sessionId: t.sessionId, open: false })).structuredContent.inspector;
    const port = portOf(url);
    // An HTTP/1.0 message may omit Host and reaches the handler, which refuses
    // it; Node itself answers 400 to an HTTP/1.1 message without one.
    expect(statusOf(await rawRequest(port, 'GET / HTTP/1.0\r\n\r\n'))).toBe(403);
    expect(statusOf(await rawRequest(port, 'GET /alive HTTP/1.1\r\n\r\n'))).toBe(400);
    expect(await rawGet(port, '/', `[::1]:${port}`)).toBe(403);
    expect(await rawGet(port, '/alive', `127.0.0.1:${port + 1}`)).toBe(403);
    for (const origin of [`http://[::1]:${port}`, 'null', `http://localhost:${port}`, `https://127.0.0.1:${port}`]) {
      expect((await rpc(url, 'get_inspection_state', {}, { Origin: origin })).status, origin).toBe(403);
      expect((await fetch(`${originOf(url)}/`, { headers: { Origin: origin } })).status, origin).toBe(403);
    }
    expect((await rpc(url, 'get_inspection_state', {})).status).toBe(200);
  });

  it('lets the panel read, close and revoke its share, and refuses the companion actions it never sends', async () => {
    const t = await setup(); cleanups.push(t.close);
    const { url } = (await t.call('open_inspector', { sessionId: t.sessionId, open: false })).structuredContent.inspector;
    const binding = { serverEpoch: t.binding.serverEpoch, sourceToken: t.binding.sourceToken };
    const status = await (await rpc(url, 'manage_companion', { ...binding, action: 'status' })).json();
    expect(status.isError).not.toBe(true);
    expect(status.structuredContent.lan).toBeNull();
    const closed = await (await rpc(url, 'manage_companion', { ...binding, action: 'close' })).json();
    expect(closed.isError).not.toBe(true);
    for (const action of ['forget', 'launch', 'recover-browser', 'recover-pairing']) {
      const refused = await (await rpc(url, 'manage_companion', { ...binding, action })).json();
      expect(refused, action).toMatchObject({ isError: true, content: [{ type: 'text',
        text: `The panel may call manage_companion with action status, close or revoke; "${action}" belongs to the agent.` }] });
    }
    // Leaving the action out is not a way around the list: the schema refuses it.
    expect((await (await rpc(url, 'manage_companion', binding)).json()).isError).toBe(true);
    // The three actions are exactly what the inspector's sharing dialog sends,
    // read from its source rather than remembered here.
    const source = await readFile(new URL('../src/inspector.ts', import.meta.url), 'utf8');
    const union = /const management=async\(action:((?:'[a-z-]+'\|?)+)/u.exec(source)?.[1];
    expect(union).toBeDefined();
    expect(new Set(union!.split('|').map(name => name.replace(/'/gu, '')))).toEqual(INSPECTOR_PANEL_COMPANION_ACTIONS);
    expect(source.match(/'manage_companion'/gu)).toHaveLength(1);
  });

  it('forgets the page key and stops listening when the session expires, then serves the next session', async () => {
    let clock = 1_700_000_000_000;
    const t = await setup({ now: () => clock, sessionTtlMs: 60_000 }); cleanups.push(t.close);
    const { url } = (await t.call('open_inspector', { sessionId: t.sessionId, open: false })).structuredContent.inspector;
    const port = portOf(url);
    expect(await reachable(port)).toBe(true);
    clock += 60_000;
    // The store notices the expiry on its next use, and tells the host then.
    const gone = await t.call('get_inspection_state', { sessionId: t.sessionId });
    expect(gone.isError).toBe(true);
    expect(gone.content[0].text).toContain('expired');
    expect(await until(async () => !(await reachable(port)))).toBe(true);
    const next = await t.call('inspect', { structureText: cif });
    const reopened = (await t.call('open_inspector', { sessionId: next.structuredContent.sessionId, open: false })).structuredContent.inspector;
    expect(keyOf(reopened.url)).not.toBe(keyOf(url));
    expect(await reachable(portOf(reopened.url))).toBe(true);
    expect((await fetch(`${originOf(reopened.url)}/bootstrap`, { headers: { Authorization: `Bearer ${keyOf(url)}` } })).status).toBe(401);
    expect((await fetch(`${originOf(reopened.url)}/bootstrap`, { headers: { Authorization: `Bearer ${keyOf(reopened.url)}` } })).status).toBe(200);
  });

  it('sweeps keys whose session is gone and stops listening until the next open', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'stereofold-panel-sweep-'));
    await writeFile(join(folder, 'inspector.html'), INSPECTOR_HTML);
    await writeFile(join(folder, 'inspector-host.js'), HOST_JS);
    const held = new Set(['one', 'two']);
    const host = new InspectorPanelHost({ htmlPath: join(folder, 'inspector.html'), hostScriptPath: join(folder, 'inspector-host.js'),
      opened: async sessionId => ({ sessionId }), dispatch: async () => ({}), live: sessionId => held.has(sessionId), sweepMs: 20 });
    cleanups.push(async () => { await host.close(); await rm(folder, { recursive: true, force: true }); });
    const bootstrap = async (link: { origin: string; url: string }) =>
      (await fetch(`${link.origin}/bootstrap`, { headers: { Authorization: `Bearer ${keyOf(link.url)}` } })).status;
    const first = await host.open('one');
    const second = await host.open('two');
    expect(second.port).toBe(first.port);
    expect(host.links).toBe(2);

    held.delete('one');
    expect(await until(() => host.links === 1)).toBe(true);
    expect(host.port).toBe(first.port);
    expect(await bootstrap(first)).toBe(401);
    expect(await bootstrap(second)).toBe(200);

    held.delete('two');
    expect(await until(() => host.port === undefined)).toBe(true);
    expect(host.links).toBe(0);
    expect(await reachable(first.port)).toBe(false);

    held.add('three');
    const third = await host.open('three');
    expect(await reachable(third.port)).toBe(true);
    expect(await bootstrap(third)).toBe(200);
    await host.forget('three');
    expect(host.port).toBeUndefined();
    expect(await reachable(third.port)).toBe(false);
    await expect(host.forget('never-opened')).resolves.toBeUndefined();
  });
});

describe('open_inspector waits for the saved scene when asked', () => {
  // One live headset run spent six model calls polling state between
  // open_inspector and open_companion. With a wait, opening is one call.
  it('answers once a page has saved the scene and a desktop panel is ready', async () => {
    const t = await setup();
    try {
      const answer = t.call('open_inspector', { sessionId: t.sessionId, open: false, waitForSceneMs: 5_000 });
      await new Promise(resolve => setTimeout(resolve, 100));
      const saved = (await t.call('sync_inspection', { sessionId: t.sessionId, ...t.binding, scene: t.scene })).structuredContent;
      const bound = { ...t.binding, baseStateRevision: saved.stateRevision, baseInspectionRevision: saved.inspectionRevision };
      const panelId = (await t.call('attach_inspection', { sessionId: t.sessionId, ...bound, surface: 'desktop' })).structuredContent.panelId;
      await t.call('poll_inspection', { sessionId: t.sessionId, ...bound, panelId, availability: 'ready' });
      const done = await answer;
      expect(done.content[0].text).toMatch(/drew and saved the scene/);
      // The structured result is read after the wait, so it agrees with the sentence.
      expect(done.structuredContent).toMatchObject({ hasScene: true, stateRevision: saved.stateRevision,
        inspectionRevision: saved.inspectionRevision, inspector: { sceneSaved: true,
          readiness: { status: 'ready', ready: true, sceneSaved: true, viewerObserved: true, waitMs: 5_000, timedOut: false } } });
    } finally { await t.close(); }
  });
  it('says so when no page saves in time', async () => {
    const t = await setup();
    try {
      const answer = await t.call('open_inspector', { sessionId: t.sessionId, open: false, waitForSceneMs: 300 });
      expect(answer.content[0].text).toContain('No connected desktop viewer was observed within 0.3 s; the scene is not saved.');
      expect(answer.structuredContent).toMatchObject({ hasScene: false, inspector: { sceneSaved: false } });
    } finally { await t.close(); }
  });

  async function unhydratedSession(t: Awaited<ReturnType<typeof setup>>) {
    const sessionId=(await t.call('inspect',{structureText:cif})).structuredContent.sessionId as string;
    const state=(await t.call('get_inspection_state',{sessionId})).structuredContent;
    return {sessionId,binding:{serverEpoch:state.serverEpoch,sourceToken:state.sourceToken,
      baseStateRevision:state.stateRevision,baseInspectionRevision:state.inspectionRevision}};
  }

  it('caps a requested long wait at exactly forty seconds and retains the same URL and session', async () => {
    const t=await setup();
    const fresh=await unhydratedSession(t);
    const opened=vi.spyOn(InspectorPanelHost.prototype,'open').mockResolvedValue({url:'http://127.0.0.1:12345/#test-page',port:12345} as any);
    vi.useFakeTimers();
    try {
      let settled=false;
      const pending=t.call('open_inspector',{sessionId:fresh.sessionId,open:false,waitForSceneMs:130_000})
        .then(answer=>{settled=true;return answer;});
      await vi.advanceTimersByTimeAsync(39_999);
      expect(opened).toHaveBeenCalledWith(fresh.sessionId);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const answer=await pending;
      expect(answer.isError).not.toBe(true);
      expect(answer.structuredContent).toMatchObject({sessionId:fresh.sessionId,hasScene:false,
        inspector:{sceneSaved:false,readiness:{status:'no_viewer_observed',ready:false,sceneSaved:false,
          viewerObserved:false,hydrationObserved:false,waitMs:40_000,timedOut:true}}});
      expect(answer.content[0].text).toContain('within 40 s');
      expect(answer.content[0].text).not.toContain('130 s');
      const again=await t.call('open_inspector',{sessionId:fresh.sessionId,open:false});
      expect(again.structuredContent.sessionId).toBe(fresh.sessionId);
      expect(again.structuredContent.sourceToken).toBe(answer.structuredContent.sourceToken);
      expect(again.structuredContent.inspector.url).toBe(answer.structuredContent.inspector.url);
      expect(again.structuredContent.inspector.sceneSaved).toBeUndefined();
      expect(again.structuredContent.inspector.readiness.waitMs).toBe(0);
    } finally {vi.useRealTimers();vi.restoreAllMocks();await t.close();}
  });

  it('does not classify an OS browser launch as an observed viewer', async () => {
    const t=await setup();
    try {
      const fresh=await unhydratedSession(t);
      const answer=await t.call('open_inspector',{sessionId:fresh.sessionId});
      expect(t.launched).toHaveLength(1);
      expect(answer.structuredContent.inspector).toMatchObject({opened:true,openReason:'started',
        readiness:{status:'no_viewer_observed',ready:false,sceneSaved:false,viewerObserved:false,hydrationObserved:false,waitMs:0,timedOut:false}});
      expect(answer.structuredContent.inspector.sceneSaved).toBeUndefined();
    } finally {await t.close();}
  });

  it('reports a failed launch separately from renderer readiness without failing the call', async () => {
    const t=await setup({questLaunch:{platform:'darwin',opener:'/bin/echo',launch:()=>{throw Error('spawn ENOENT');}}});
    try {
      const fresh=await unhydratedSession(t);
      const started=Date.now();
      const answer=await t.call('open_inspector',{sessionId:fresh.sessionId,waitForSceneMs:60_000});
      expect(answer.isError).not.toBe(true);
      expect(Date.now()-started).toBeLessThan(3_000);
      expect(answer.structuredContent.inspector).toMatchObject({opened:false,openReason:'failed',openDetail:'spawn ENOENT',
        readiness:{status:'launch_failed',ready:false,sceneSaved:false,viewerObserved:false,waitMs:0,timedOut:false}});
    } finally {await t.close();}
  });

  it('distinguishes a session hydration request from an observed desktop renderer', async () => {
    const t=await setup();
    try {
      const answer=await t.call('open_inspector',{sessionId:t.sessionId,open:false,waitForSceneMs:1});
      expect(answer.structuredContent).toMatchObject({hasScene:false,inspector:{sceneSaved:false,
        readiness:{status:'no_viewer_observed',ready:false,sceneSaved:false,viewerObserved:false,hydrationObserved:true,timedOut:true}}});
      const state=(await t.call('get_inspection_state',{sessionId:t.sessionId})).structuredContent;
      expect(state.panels).toEqual([]);
      expect(answer.content[0].text).toContain('does not confirm a desktop viewer');
    } finally {await t.close();}
  });

  it('reports a saved scene with an unowned busy desktop panel as unready, not unsaved', async () => {
    const t=await setup();
    try {
      const saved=(await t.call('sync_inspection',{sessionId:t.sessionId,...t.binding,scene:t.scene})).structuredContent;
      const bound={...t.binding,baseStateRevision:saved.stateRevision,baseInspectionRevision:saved.inspectionRevision};
      const panelId=(await t.call('attach_inspection',{sessionId:t.sessionId,...bound,surface:'desktop'})).structuredContent.panelId;
      await t.call('poll_inspection',{sessionId:t.sessionId,...bound,panelId,availability:'busy'});
      const answer=await t.call('open_inspector',{sessionId:t.sessionId,open:false,waitForSceneMs:1});
      expect(answer.structuredContent).toMatchObject({hasScene:true,inspector:{sceneSaved:true,
        readiness:{status:'viewer_not_ready',ready:false,sceneSaved:true,viewerObserved:true,renderingObserved:false,timedOut:true}}});
      expect(answer.content[0].text).toContain('The scene is saved, but no current ready desktop panel');
      expect(answer.content[0].text).not.toContain('scene was not saved');
    } finally {await t.close();}
  });

  for(const condition of ['rendering','stale','failed'] as const)
  it(`classifies an attached desktop renderer with ${condition} evidence`,async()=>{
    const t=await setup();
    try {
      const saved=(await t.call('sync_inspection',{sessionId:t.sessionId,...t.binding,scene:t.scene})).structuredContent;
      const bound={sessionId:t.sessionId,...t.binding,baseStateRevision:saved.stateRevision,baseInspectionRevision:saved.inspectionRevision};
      const panelId=(await t.call('attach_inspection',{...bound,surface:'desktop'})).structuredContent.panelId;
      const queued=await t.call('update_inspection',{...bound,panelId,commandId:`readiness-${condition}`,
        change:{kind:'appearance',patch:{color:'chain-id'}}});
      expect(queued.isError).not.toBe(true);
      expect(queued.structuredContent.command.status).toBe('queued');
      const claimed=await t.call('poll_inspection',{...bound,panelId,availability:'ready'});
      expect(claimed._meta[KEY].delivery.commandId).toBe(`readiness-${condition}`);
      await t.call('poll_inspection',{...bound,panelId,availability:'busy',...(condition==='failed'?{
        xrStartup:{phase:'idle',pending:false,reloadRequired:true,mode:null,gestureActive:null,presenting:false,errorName:'Error'}}:{})});
      if(condition==='stale') {
        const next=structuredClone(t.scene);
        next.inspection.appearance.background='#121212';
        const changed=await t.call('sync_inspection',{...bound,scene:next});
        expect(changed.isError).not.toBe(true);
      }
      const answer=await t.call('open_inspector',{sessionId:t.sessionId,open:false});
      expect(answer.structuredContent.inspector.readiness).toMatchObject({ready:false,sceneSaved:true,viewerObserved:true,
        hydrationObserved:true,renderingObserved:condition==='rendering',status:condition==='rendering'?'loading':'viewer_not_ready'});
    }finally {await t.close();}
  });

  it('reports a saved scene without a connected ready panel truthfully', async () => {
    const t=await setup();
    try {
      const fresh=await unhydratedSession(t);
      const saved=(await t.call('sync_inspection',{sessionId:fresh.sessionId,...fresh.binding,scene:t.scene})).structuredContent;
      expect(saved.hasScene).toBe(true);
      const answer=await t.call('open_inspector',{sessionId:fresh.sessionId,open:false,waitForSceneMs:1});
      expect(answer.structuredContent).toMatchObject({hasScene:true,inspector:{sceneSaved:true,
        readiness:{status:'no_viewer_observed',ready:false,sceneSaved:true,viewerObserved:false,timedOut:true}}});
      expect(answer.content[0].text).toContain('The scene is saved, but no current ready desktop panel');
      expect(answer.content[0].text).not.toContain('scene was not saved');
    } finally {await t.close();}
  });
});

describe('open_companion draws a session nothing has drawn yet', () => {
  // A terminal host used to need open_inspector, a state poll and a second
  // open_companion before the headset could load anything. Now inspect and
  // one open_companion carry a fresh session to the share.
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); });

  /** A second session on the same coordinates that no panel has fetched. */
  async function freshSession(t: Awaited<ReturnType<typeof setup>>) {
    const sessionId = (await t.call('inspect', { structureText: cif })).structuredContent.sessionId as string;
    const state = (await t.call('get_inspection_state', { sessionId })).structuredContent;
    return { sessionId, binding: { serverEpoch: state.serverEpoch, sourceToken: state.sourceToken,
      baseStateRevision: state.stateRevision, baseInspectionRevision: state.inspectionRevision } };
  }

  it('advertises fresh inspect as non-destructive while source replacement stays destructive', async () => {
    const t = await setup(); cleanups.push(t.close);
    const tools = (await t.client.listTools()).tools;
    expect(tools.find(tool => tool.name === 'stereo_structure.inspect')?.annotations)
      .toMatchObject({ destructiveHint: false, openWorldHint: true });
    expect(tools.find(tool => tool.name === 'stereo_structure.replace_inspection_source')?.annotations)
      .toMatchObject({ destructiveHint: true });
  });

  it('opens the inspector in this Mac\'s browser, waits for its saved scene, then shares', async () => {
    const t = await setup(); cleanups.push(t.close);
    const fresh = await freshSession(t);
    const answer = t.call('open_companion', { sessionId: fresh.sessionId });
    expect(await until(() => t.launched.length === 1)).toBe(true);
    const { url } = (await t.call('open_inspector', { sessionId: fresh.sessionId, open: false })).structuredContent.inspector;
    // The same stamped address open_inspector launches, so the tab closes with this server.
    expect(t.launched).toEqual([{ command: '/bin/echo', args: [markHostOpenedUrl(url)] }]);
    // What the page does: save through its key, attach, report ready.
    const saved = (await (await rpc(url, 'stereo_structure.sync_inspection', { ...fresh.binding, scene: t.scene })).json()).structuredContent;
    const bound = { ...fresh.binding, baseStateRevision: saved.stateRevision, baseInspectionRevision: saved.inspectionRevision };
    const panelId = (await (await rpc(url, 'stereo_structure.attach_inspection', { ...bound, surface: 'desktop' })).json()).structuredContent.panelId;
    expect((await rpc(url, 'stereo_structure.poll_inspection', { ...bound, panelId, availability: 'ready' })).status).toBe(200);
    const shared = await answer;
    expect(shared.isError).not.toBe(true);
    expect(shared.content[0].text).toMatch(/^No scene was saved, so the inspector opened in this Mac's browser \(http:\/\/127\.0\.0\.1:\d+\/#[a-f0-9]{64}\) and drew and saved it in \d+\.\d s; leave that tab open\./u);
    expect(shared.structuredContent).toMatchObject({ sessionId: fresh.sessionId, hasScene: true, stateRevision: saved.stateRevision,
      companion: { connection: 'loopback' } });
    expect(t.launched).toHaveLength(1);
  });

  it('returns a pending draw before the tool deadline and resumes it with the same binding', async () => {
    const t = await setup(); cleanups.push(t.close);
    const fresh = await freshSession(t);
    vi.useFakeTimers();
    try {
      const args = { sessionId: fresh.sessionId, ...fresh.binding, waitForSceneMs: 130_000 };
      const first = t.call('open_companion', args);
      // The inspector's loopback listener opens on real I/O, which a fake
      // clock jump would skip past, so let it launch before the deadline runs.
      await vi.waitFor(() => expect(t.launched).toHaveLength(1), { timeout: 5_000, interval: 20 });
      await vi.advanceTimersByTimeAsync(40_100);
      const pending = await first;
      expect(pending.isError).not.toBe(true);
      expect(pending.structuredContent).toMatchObject({ sharePending: { status: 'rendering', nextCall: 'open_companion' } });
      expect(pending.structuredContent.companion).toBeUndefined();
      expect(t.launched).toHaveLength(1);
      const saved = (await t.call('sync_inspection', { ...fresh.binding, sessionId: fresh.sessionId, scene: t.scene })).structuredContent;
      const bound = { ...fresh.binding, baseStateRevision: saved.stateRevision, baseInspectionRevision: saved.inspectionRevision };
      const panelId = (await t.call('attach_inspection', { ...bound, sessionId: fresh.sessionId, surface: 'desktop' })).structuredContent.panelId;
      await t.call('poll_inspection', { ...bound, sessionId: fresh.sessionId, panelId, availability: 'ready' });
      const resumed = t.call('open_companion', args);
      await vi.advanceTimersByTimeAsync(500);
      const shared = await resumed;
      expect(shared.isError).not.toBe(true);
      expect(shared.structuredContent.companion).toMatchObject({ connection: 'loopback' });
      expect(t.launched).toHaveLength(1);
    } finally { vi.useRealTimers(); vi.restoreAllMocks(); }
  });

  it('keeps one draw alive past a shorter waitForSceneMs override', async () => {
    const t = await setup(); cleanups.push(t.close);
    const fresh = await freshSession(t);
    vi.spyOn(InspectorPanelHost.prototype, 'open').mockResolvedValue({ url: 'http://127.0.0.1:12345/#test-page', port: 12345 } as any);
    vi.spyOn(InspectionCompanionHttp.prototype, 'open').mockResolvedValue({ url: 'http://127.0.0.1:12346/#test-link', port: 12346 });
    vi.useFakeTimers();
    try {
      const args = { sessionId: fresh.sessionId, ...fresh.binding, waitForSceneMs: 60_000 };
      const first = t.call('open_companion', args);
      await vi.advanceTimersByTimeAsync(40_100);
      expect((await first).structuredContent.sharePending.status).toBe('rendering');
      const second = t.call('open_companion', args);
      await vi.advanceTimersByTimeAsync(40_100);
      expect((await second).structuredContent.sharePending.status).toBe('rendering');
      expect(t.launched).toHaveLength(1);
      await t.call('sync_inspection', { ...fresh.binding, sessionId: fresh.sessionId, scene: t.scene });
      const resumed = t.call('open_companion', args);
      await vi.advanceTimersByTimeAsync(500);
      const shared = await resumed;
      expect(shared.isError).not.toBe(true);
      expect(shared.structuredContent.companion.connection).toBe('loopback');
      expect(t.launched).toHaveLength(1);
    } finally { vi.useRealTimers(); vi.restoreAllMocks(); }
  });

  it('returns pending during LAN setup and resumes without opening a second listener', async () => {
    const t = await setup(); cleanups.push(t.close);
    const fresh = await freshSession(t);
    const saved = (await t.call('sync_inspection', { ...fresh.binding, sessionId: fresh.sessionId, scene: t.scene })).structuredContent;
    const args = { sessionId: fresh.sessionId, ...fresh.binding, baseStateRevision: saved.stateRevision,
      baseInspectionRevision: saved.inspectionRevision, connection: 'lan', launch: 'none' };
    vi.spyOn(InspectionCompanionHttp.prototype, 'open').mockResolvedValue({ url: 'http://127.0.0.1:12346/#test-link', port: 12346 });
    let finish!: (value: any) => void;
    const opening = new Promise<any>(resolve => { finish = resolve; });
    const lanOpen = vi.spyOn(LanCompanion.prototype, 'open').mockImplementation(async () => await opening);
    const timer = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: any, delay?: number, ...rest: any[]) =>
      timer(callback, delay === 45_000 ? 250 : delay, ...rest)) as typeof setTimeout);
    try {
      const first = t.call('open_companion', args);
      expect(await until(() => lanOpen.mock.calls.length === 1)).toBe(true);
      const pending = await first;
      expect(pending.isError).not.toBe(true);
      expect(pending.structuredContent).toMatchObject({ sharePending: { status: 'connecting', nextCall: 'open_companion' } });
      expect(pending.structuredContent.companion).toBeUndefined();
      const changed = await t.call('open_companion', { ...args, connection: 'loopback' });
      expect(changed.isError).toBe(true);
      expect(changed.content[0].text).toContain('earlier open_companion request is still finishing with different connection options');
      const second = t.call('open_companion', args);
      const again = await second;
      expect(again.structuredContent.sharePending.status).toBe('connecting');
      expect(lanOpen).toHaveBeenCalledTimes(1);
      finish({ url: 'https://127.0.0.1:8443/', host: '127.0.0.1', port: 8443, pairingCode: 'test-only' });
      const shared = await t.call('open_companion', args);
      expect(shared.isError).not.toBe(true);
      expect(shared.structuredContent.companion.connection).toBe('lan');
      expect(lanOpen).toHaveBeenCalledTimes(1);
    } finally { vi.restoreAllMocks(); }
  });

  it('cancels an unfinished LAN open when sharing closes', async () => {
    const t = await setup(); cleanups.push(t.close);
    const fresh = await freshSession(t);
    const saved = (await t.call('sync_inspection', { ...fresh.binding, sessionId: fresh.sessionId, scene: t.scene })).structuredContent;
    const args = { sessionId: fresh.sessionId, ...fresh.binding, baseStateRevision: saved.stateRevision,
      baseInspectionRevision: saved.inspectionRevision, connection: 'lan', launch: 'none' };
    vi.spyOn(InspectionCompanionHttp.prototype, 'open').mockResolvedValue({ url: 'http://127.0.0.1:12346/#test-link', port: 12346 });
    let finish!: (value: any) => void;
    const opening = new Promise<any>(resolve => { finish = resolve; });
    const lanOpen = vi.spyOn(LanCompanion.prototype, 'open').mockImplementation(async () => await opening);
    const lanClose = vi.spyOn(LanCompanion.prototype, 'close');
    const timer = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: any, delay?: number, ...rest: any[]) =>
      timer(callback, delay === 45_000 ? 250 : delay, ...rest)) as typeof setTimeout);
    try {
      const first = t.call('open_companion', args);
      expect(await until(() => lanOpen.mock.calls.length === 1)).toBe(true);
      expect((await first).structuredContent.sharePending.status).toBe('connecting');
      const management = { sessionId: fresh.sessionId, serverEpoch: fresh.binding.serverEpoch, sourceToken: fresh.binding.sourceToken };
      const closed = await t.call('manage_companion', { ...management, action: 'close' });
      expect(closed.isError, closed.content[0]?.text).not.toBe(true);
      finish({ url: 'https://127.0.0.1:8443/', host: '127.0.0.1', port: 8443, pairingCode: 'test-only' });
      expect(lanClose).toHaveBeenCalledTimes(1);
      expect((await t.call('manage_companion', { ...management, action: 'status' })).structuredContent.lan).toBeNull();
      const restarted = await t.call('open_companion', args);
      expect(restarted.isError).not.toBe(true);
      expect(restarted.structuredContent.companion.connection).toBe('lan');
      expect(lanOpen).toHaveBeenCalledTimes(2);
    } finally { vi.restoreAllMocks(); }
  });

  it('expires a completed connection that no retry collected', async () => {
    const t = await setup(); cleanups.push(t.close);
    const fresh = await freshSession(t);
    const saved = (await t.call('sync_inspection', { ...fresh.binding, sessionId: fresh.sessionId, scene: t.scene })).structuredContent;
    const args = { sessionId: fresh.sessionId, ...fresh.binding, baseStateRevision: saved.stateRevision,
      baseInspectionRevision: saved.inspectionRevision, connection: 'lan', launch: 'none' };
    vi.spyOn(InspectionCompanionHttp.prototype, 'open').mockResolvedValue({ url: 'http://127.0.0.1:12346/#test-link', port: 12346 });
    vi.spyOn(LocalSceneService.prototype, 'offer').mockResolvedValue(false);
    let finish!: (value: any) => void;
    const opening = new Promise<any>(resolve => { finish = resolve; });
    const lanOpen = vi.spyOn(LanCompanion.prototype, 'open').mockImplementation(async () => await opening);
    let announceExpiry!: (expire:()=>void) => void;
    const expiry = new Promise<()=>void>(resolve => { announceExpiry = resolve; });
    const timer = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: any, delay?: number, ...rest: any[]) => {
      if(delay===120_000) {announceExpiry(()=>callback());return timer(()=>{},0);}
      return timer(callback,delay===45_000?20:delay,...rest);
    }) as typeof setTimeout);
    try {
      const first = t.call('open_companion', args);
      expect(await until(() => lanOpen.mock.calls.length === 1)).toBe(true);
      expect((await first).structuredContent.sharePending.status).toBe('connecting');
      finish({ url: 'https://127.0.0.1:8443/', host: '127.0.0.1', port: 8443, pairingCode: 'test-only' });
      (await expiry)();
      const reopened = await t.call('open_companion', args);
      expect(reopened.isError).not.toBe(true);
      expect(lanOpen).toHaveBeenCalledTimes(2);
    } finally { vi.restoreAllMocks(); }
  });

  it('returns pending with the next step when a short call wait ends before the draw', async () => {
    const t = await setup(); cleanups.push(t.close);
    const fresh = await freshSession(t);
    vi.spyOn(InspectorPanelHost.prototype, 'open').mockResolvedValue({ url: 'http://127.0.0.1:12345/#test-page', port: 12345 } as any);
    try {
      const pending = await t.call('open_companion', { sessionId: fresh.sessionId, waitForSceneMs: 300 });
      expect(pending.isError).not.toBe(true);
      expect(pending.structuredContent.sharePending.status).toBe('rendering');
      expect(pending.content[0].text).toContain('Call open_companion again with the same arguments');
      expect(t.launched).toHaveLength(1);
    } finally { vi.restoreAllMocks(); }
  });

  it('refuses at once when this Mac cannot open a browser', async () => {
    const t = await setup({ questLaunch: { platform: 'linux', launch: () => { throw Error('unreachable'); } } }); cleanups.push(t.close);
    const fresh = await freshSession(t);
    const started = Date.now();
    const refused = await t.call('open_companion', { sessionId: fresh.sessionId });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toMatch(/^No scene is saved yet, and this Mac's browser could not open the inspector to draw one\. Nothing was shared\. To connect, open http:\/\/127\.0\.0\.1:\d+\/#[a-f0-9]{64} in a browser on this Mac/u);
  });

  it('waits for a panel that is already loading the session instead of opening a second tab', async () => {
    const t = await setup(); cleanups.push(t.close);
    const answer = t.call('open_companion', { sessionId: t.sessionId, waitForSceneMs: 5_000 });
    await new Promise(resolve => setTimeout(resolve, 100));
    const saved = (await t.call('sync_inspection', { sessionId: t.sessionId, ...t.binding, scene: t.scene })).structuredContent;
    const bound = { ...t.binding, baseStateRevision: saved.stateRevision, baseInspectionRevision: saved.inspectionRevision };
    const panelId = (await t.call('attach_inspection', { sessionId: t.sessionId, ...bound, surface: 'desktop' })).structuredContent.panelId;
    await t.call('poll_inspection', { sessionId: t.sessionId, ...bound, panelId, availability: 'ready' });
    const shared = await answer;
    expect(shared.isError).not.toBe(true);
    expect(shared.content[0].text).toMatch(/^The panel already loading this session drew and saved the scene in \d+\.\d s\./u);
    expect(t.launched).toHaveLength(0);
  });

  it('still refuses a stale binding before drawing anything', async () => {
    const t = await setup(); cleanups.push(t.close);
    const fresh = await freshSession(t);
    const refused = await t.call('open_companion', { sessionId: fresh.sessionId, ...fresh.binding, baseStateRevision: fresh.binding.baseStateRevision + 1 });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('Load and save the intended panel');
    expect(t.launched).toHaveLength(0);
  });
});
