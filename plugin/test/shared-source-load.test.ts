import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, connect } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, it, expect } from 'vitest';
import { createStereoStructureServer } from '../src/server.js';
import { listLanAddresses } from '../src/inspection-lan.js';
import { PRIVATE_INSPECTION_META_KEY as KEY } from '../src/inspection-contract.js';
import { createReplyAudioSynthesizer } from '../src/headset-reply-audio.js';

/**
 * A LEGACY STRUCTURE LOAD MUST NOT END THE SHARE.
 *
 * A Claude Code surface was asked for crambin while a Quest 2 was
 * presenting 4HHB over the LAN share. It called `control` with `load_pdb`, and
 * eleven seconds later the headset plate read "Link to the Mac lost." The
 * commit of a new structure cache builds a new inspection attachment with a new
 * sourceToken, and the inspection server reads an unannounced token change on
 * the LAN owner's session as an unauthorized retarget of a scoped capability:
 * it retires the listener on purpose. The tool answer said `hasStructure: true`
 * and nothing about the share, so the assistant reported success while the
 * wearer sat in front of an unchanged molecule with no link.
 *
 * These tests drive the packaged MCP server, own a real LAN listener on a
 * private interface, and assert the two halves of the fix: the share survives a
 * legacy source load, and no answer about a shared session is silent about it.
 */

const silentReplyAudio = createReplyAudioSynthesizer({ enabled: false });
const crambin = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');
const other = await readFile(new URL('../../fixtures/voice-ligand.cif', import.meta.url), 'utf8');

async function unusedPort(host: string) {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(0, host, () => resolve()); });
  const address = probe.address(); if (!address || typeof address === 'string') throw Error('LAN fixture did not bind');
  await new Promise<void>(resolve => probe.close(() => resolve()));
  return address.port;
}

/** Whether the private HTTPS listener is still accepting connections. */
async function reachable(host: string, port: number) {
  return new Promise<boolean>(resolve => {
    const socket = connect({ host, port });
    const settle = (value: boolean) => { socket.destroy(); resolve(value); };
    socket.setTimeout(2_000, () => settle(false));
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
  });
}

async function setup(options = {}, viewerPath?: string) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createStereoStructureServer(viewerPath, { replyAudio: silentReplyAudio, ...options });
  const client = new Client({ name: 'Shared source load test', version: '1' });
  await server.connect(b); await client.connect(a);
  const call = async (name: string, args: Record<string, unknown>) =>
    await client.callTool({ name: `stereo_structure.${name}`, arguments: args }) as any;
  const opened = await call('inspect', { structureText: crambin });
  expect(opened.isError).not.toBe(true);
  const sessionId = opened.structuredContent.sessionId;
  const data = (await call('get_inspection', { sessionId }))._meta[KEY];
  const scene = {
    sourceSha256: data.catalog.source.sha256, modelNumber: data.catalog.modelNumbers[0], assemblyId: data.catalog.assemblyId,
    selectionKeys: [data.catalog.rows[0].key],
    camera: { mode: 'perspective', fov: Math.PI / 4, position: [0, 0, 80], up: [0, 1, 0], target: [0, 0, 0], radius: 20, radiusMax: 20, fog: 50, clipFar: true, minNear: 5, minFar: 0 },
    inspection: {
      appearance: { representation: 'cartoon', color: 'uniform', uniformColor: '#44aaff', background: '#192734', opacity: 1, labels: false, highlightColor: '#ffccee', clipping: 0, fog: 0 },
      placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 },
    },
  };
  const args = {
    sessionId, serverEpoch: data.serverEpoch, sourceToken: data.sourceToken,
    baseStateRevision: data.stateRevision, baseInspectionRevision: data.inspectionRevision, scene,
  };
  return { call, sessionId, args, close: async () => { await client.close(); await server.close(); } };
}

/** A server whose LAN listener is live and owned by its one inspection. */
async function shared(options = {}) {
  const lanAddress = listLanAddresses()[0];
  if (!lanAddress) return undefined; // No private interface: this host cannot run the fixture at all.
  const folder = await mkdtemp(join(tmpdir(), 'stereofold-d120-'));
  await writeFile(join(folder, 'inspector.html'), '<html><script>void 0;</script></html>');
  // The server builds its own LanCompanion, whose certificate store follows the
  // home directory. Redirect it so the test never writes a real one.
  const home = process.env.HOME;
  process.env.HOME = folder;
  const t = await setup({ sceneServiceFile: join(folder, 'scene-service.json'), ...options }, join(folder, 'viewer.html'));
  const lanPort = await unusedPort(lanAddress.address);
  const restore = async () => {
    await t.close();
    if (home === undefined) delete process.env.HOME; else process.env.HOME = home;
    await rm(folder, { recursive: true, force: true });
  };
  try {
    await t.call('sync_inspection', t.args);
    const { scene, ...initial } = t.args;
    const live = { ...initial, baseInspectionRevision: 1 };
    const opened = await t.call('open_companion', { ...live, connection: 'lan', lanHost: lanAddress.address, lanPort });
    expect(opened.isError).not.toBe(true);
    expect(opened.structuredContent.shared).toBe(true);
    expect(await reachable(lanAddress.address, lanPort)).toBe(true);
    return { ...t, live, companion: opened.structuredContent.companion, host: lanAddress.address, lanPort, restore, reachable: () => reachable(lanAddress.address, lanPort) };
  } catch (error) { await restore(); throw error; }
}

describe('a legacy structure load into a shared scene', () => {
  it('keeps the headset share on control load_pdb and says what it did to it', async () => {
    const s = await shared({ fetchPdbText: async () => other }); if (!s) return;
    try {
      const loaded = await s.call('control', { sessionId: s.sessionId, action: 'load_pdb', pdbId: '1EMA' });
      expect(loaded.isError).not.toBe(true);
      expect(loaded.structuredContent.hasStructure).toBe(true);
      // (2) A shared session never gets a source answer that is silent about
      // the share. This is the field that was missing.
      expect(loaded.structuredContent.share).toMatchObject({ kept: true, previousSourceToken: s.live.sourceToken });
      expect(loaded.structuredContent.share.sourceToken).not.toBe(s.live.sourceToken);
      expect(loaded.content[0].text).toContain('share was kept and retargeted');
      expect(loaded.content[0].text).toContain(loaded.structuredContent.share.sourceToken);

      // (1) The listener is still up, and the retarget is real rather than a
      // stay of execution: `get_inspection_state` calls current() again outside
      // the authorization window, which is where a stale LAN owner token would
      // retire the listener a second time.
      const state = await s.call('get_inspection_state', { sessionId: s.sessionId });
      expect(state.isError).not.toBe(true);
      expect(await s.reachable()).toBe(true);
      expect(state.structuredContent.shared).toBe(true);
      expect(state.structuredContent.sourceToken).toBe(loaded.structuredContent.share.sourceToken);
      // The source really did change under the share.
      expect(state.structuredContent.sourceToken).not.toBe(s.live.sourceToken);
      const status = await s.call('manage_companion',
        { sessionId: s.sessionId, serverEpoch: state.structuredContent.serverEpoch, sourceToken: state.structuredContent.sourceToken, action: 'status' });
      expect(status.isError).not.toBe(true);
      expect(status.structuredContent.lan).not.toBeNull();
    } finally { await s.restore(); }
  }, 30_000);

  it('keeps the headset share on open with a pdbId', async () => {
    const s = await shared({ fetchPdbText: async () => other }); if (!s) return;
    try {
      const loaded = await s.call('open', { sessionId: s.sessionId, pdbId: '1EMA' });
      expect(loaded.isError).not.toBe(true);
      expect(loaded.structuredContent.share).toMatchObject({ kept: true });
      const state = await s.call('get_inspection_state', { sessionId: s.sessionId });
      expect(await s.reachable()).toBe(true);
      expect(state.structuredContent.shared).toBe(true);
      expect(state.structuredContent.sourceToken).toBe(loaded.structuredContent.share.sourceToken);
      expect(state.structuredContent.sourceToken).not.toBe(s.live.sourceToken);
    } finally { await s.restore(); }
  }, 30_000);

  it('keeps the headset share on open with pasted coordinates', async () => {
    const s = await shared(); if (!s) return;
    try {
      const loaded = await s.call('open', { sessionId: s.sessionId, source: { kind: 'pasted', text: other, format: 'mmcif' } });
      expect(loaded.isError).not.toBe(true);
      expect(loaded.structuredContent.share).toMatchObject({ kept: true });
      const state = await s.call('get_inspection_state', { sessionId: s.sessionId });
      expect(await s.reachable()).toBe(true);
      expect(state.structuredContent.shared).toBe(true);
      expect(state.structuredContent.sourceToken).toBe(loaded.structuredContent.share.sourceToken);
    } finally { await s.restore(); }
  }, 30_000);

  it('leaves an unshared session and a source-free render exactly as they were', async () => {
    const t = await setup({ fetchPdbText: async () => other });
    try {
      // Nothing is shared here, so nothing is claimed about a share.
      const loaded = await t.call('control', { sessionId: t.sessionId, action: 'load_pdb', pdbId: '1EMA' });
      expect(loaded.isError).not.toBe(true);
      expect(loaded.structuredContent).not.toHaveProperty('share');
      const rendered = await t.call('open', { sessionId: t.sessionId });
      expect(rendered.isError).not.toBe(true);
      expect(rendered.structuredContent).not.toHaveProperty('share');
    } finally { await t.close(); }
  }, 20_000);

  it('says the share ended when the new coordinates cannot be read', async () => {
    const s = await shared({ fetchPdbText: async () => `data_BROKEN\n_atom_site.id\n${'x'.repeat(64)}\n` }); if (!s) return;
    try {
      const loaded = await s.call('control', { sessionId: s.sessionId, action: 'load_pdb', pdbId: '1EMA' });
      // Whatever became of the structure, the answer states what became of the
      // share rather than leaving the caller to infer it from a render receipt.
      expect(loaded.isError).not.toBe(true);
      expect(loaded.structuredContent.share).toMatchObject({ kept: false });
      expect(loaded.structuredContent.share.note).toContain('share has ended');
      expect(loaded.content[0].text).toContain('Reconnect with open_companion');
      expect(await s.reachable()).toBe(false);
    } finally { await s.restore(); }
  }, 30_000);
});

describe('a receipt with no wearer on the other end', () => {
  it('reports an open private share awaiting pairing without requesting another launch', async () => {
    const s = await shared(); if (!s) return;
    try {
      const state = await s.call('get_inspection_state', { sessionId: s.sessionId });
      expect(await s.reachable()).toBe(true);
      expect(state.structuredContent.wearer).toMatchObject({ shareOpen: true, share: false, linked: false, panel: false, state: 'no-page' });
      expect(state.structuredContent.wearer.note).toContain('share is open, but no headset has paired yet');
      expect(state.structuredContent.wearer.note).toContain('No current headset launch is pending');
      expect(state.structuredContent.wearer.note).toContain('manage_companion action="launch"');
      expect(state.structuredContent.wearer.note).not.toContain('not open');
      expect(state.structuredContent.wearer.note).not.toContain('Reconnect with open_companion');
      expect(state.content[0].text).toContain('share is open; no headset has paired yet');
    } finally { await s.restore(); }
  }, 30_000);

  it('distinguishes a paired headset awaiting its page from an unopened share', async () => {
    const s = await shared(); if (!s) return;
    try {
      // Pair with this test listener, without mounting any headset page.
      const body = JSON.stringify({ code: s.companion.pairingCode });
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const request = httpsRequest({ hostname: s.host, port: s.lanPort, path: '/pair', method: 'POST', rejectUnauthorized: false,
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), origin: s.companion.url.replace(/\/$/, '') } }, response => {
          response.resume(); response.on('end', () => resolve(response.statusCode));
        });
        request.on('error', reject);
        request.setTimeout(2_000, () => request.destroy(Error('Test pairing timed out')));
        request.end(body);
      });
      expect(status).toBe(200);
      const state = await s.call('get_inspection_state', { sessionId: s.sessionId });
      expect(state.structuredContent.wearer).toMatchObject({ shareOpen: true, share: true, linked: false, panel: false, state: 'no-page' });
      expect(state.structuredContent.wearer.note).toContain('share is open, but no headset page is attached');
      expect(state.structuredContent.wearer.note).not.toContain('no headset has paired');
      expect(state.structuredContent.wearer.note).not.toContain('Reconnect with open_companion');
    } finally { await s.restore(); }
  }, 30_000);

  it('does not label a loopback-only companion as an open private Wi-Fi share', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'stereofold-loopback-status-'));
    await writeFile(join(folder, 'inspector.html'), '<html><script>void 0;</script></html>');
    const t = await setup({ sceneServiceFile: join(folder, 'scene-service.json') }, join(folder, 'viewer.html'));
    try {
      await t.call('sync_inspection', t.args);
      const { scene, ...initial } = t.args;
      const opened = await t.call('open_companion', { ...initial, baseInspectionRevision: 1, connection: 'loopback', launch: 'none' });
      expect(opened.isError, JSON.stringify(opened.content)).not.toBe(true);
      const state = await t.call('get_inspection_state', { sessionId: t.sessionId });
      expect(state.structuredContent.shared).toBe(true);
      expect(state.structuredContent.wearer).toMatchObject({ shareOpen: false, share: false, linked: false });
      expect(state.structuredContent.wearer.note).toContain('private Wi-Fi share is not open');
    } finally { await t.close(); await rm(folder, { recursive: true, force: true }); }
  }, 20_000);

  it('says so in every inspection answer rather than only in readiness', async () => {
    const t = await setup();
    try {
      const state = await t.call('get_inspection_state', { sessionId: t.sessionId });
      expect(state.isError).not.toBe(true);
      // (3) The field a model cannot miss, beside the receipts it would
      // otherwise read as the wearer's view.
      expect(state.structuredContent.wearer).toMatchObject({ linked: false, share: false, panel: false });
      expect(state.structuredContent.wearer.note).toContain('No wearer is linked');
      expect(state.structuredContent.wearer.note).toContain('not the wearer');
      // The same signal rides on the command receipts themselves.
      const saved = await t.call('sync_inspection', t.args);
      expect(saved.structuredContent.wearer).toMatchObject({ linked: false });
    } finally { await t.close(); }
  }, 20_000);

  it('still says so on a session whose share has ended', async () => {
    const s = await shared(); if (!s) return;
    try {
      const state = await s.call('get_inspection_state', { sessionId: s.sessionId });
      // The share is open but no headset page ever attached, so there is still
      // no wearer: `shared: true` on its own never means one is watching.
      expect(state.structuredContent.shared).toBe(true);
      expect(state.structuredContent.wearer).toMatchObject({ linked: false, panel: false });

      const closed = await s.call('manage_companion',
        { sessionId: s.sessionId, serverEpoch: state.structuredContent.serverEpoch, sourceToken: state.structuredContent.sourceToken, action: 'close' });
      expect(closed.isError).not.toBe(true);
      expect(closed.structuredContent.shared).toBe(false);
      expect(closed.structuredContent.wearer).toMatchObject({ linked: false, share: false, shareOpen: false });
      expect(closed.structuredContent.wearer.note).toContain('private Wi-Fi share is not open');
      expect(closed.structuredContent.wearer.note).toContain('Reconnect with open_companion');

      // And a reply sent into that silence is not reported as delivery.
      const said = await s.call('say_to_headset', { text: 'Crambin is up as a molecular surface.' });
      expect(said.isError).not.toBe(true);
      expect(said.structuredContent).toMatchObject({ queued: true, delivered: false });
      expect(said.structuredContent.wearer).toMatchObject({ linked: false, share: false });
      expect(said.content[0].text).toContain('No wearer is linked');
    } finally { await s.restore(); }
  }, 30_000);
});
