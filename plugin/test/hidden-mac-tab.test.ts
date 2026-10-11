import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createStereoStructureServer } from '../src/server.js';
import { PRIVATE_INSPECTION_META_KEY as KEY, expectedInspection } from '../src/inspection-contract.js';

// In Claude Code and the Codex CLI the Mac panel is an ordinary browser tab,
// and Meta's Web Launch page opens in front of it.
// A hidden tab cannot draw, so it sends no heartbeat. These tests hold what a
// headset session needs from the host while that tab is hidden: the wearer's
// page takes the edits, and the hidden tab is never offered one.
const cif = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');
const orange = { kind: 'appearance', patch: { color: 'uniform', uniformColor: '#ff8800' } };

async function setup({ share }: { share: boolean }) {
  // The loopback companion listener serves the packaged inspector page, so the
  // fixture is a miniature dist/.
  const dist = await mkdtemp(join(tmpdir(), 'stereofold-hidden-tab-'));
  await writeFile(join(dist, 'viewer.html'), '<html><script>void 0;</script></html>');
  await writeFile(join(dist, 'inspector.html'), '<html><script>void 0;</script></html>');
  await mkdir(join(dist, 'molstar'), { recursive: true });
  const [a, b] = InMemoryTransport.createLinkedPair(), server = createStereoStructureServer(join(dist, 'viewer.html'));
  const client = new Client({ name: 'Stereofold hidden Mac tab test', version: '1' });
  await server.connect(b); await client.connect(a);
  const call = async (name: string, args: Record<string, unknown>) =>
    await client.callTool({ name: `stereo_structure.${name}`, arguments: args }) as any;
  const sessionId = (await call('inspect', { structureText: cif })).structuredContent.sessionId as string;
  const data = (await call('get_inspection', { sessionId }))._meta[KEY];
  const scene = { sourceSha256: data.catalog.source.sha256, modelNumber: data.catalog.modelNumbers[0],
    assemblyId: data.catalog.assemblyId, selectionKeys: [] as string[],
    camera: { mode: 'perspective', fov: Math.PI / 4, position: [0, 0, 80], target: [0, 0, 0], up: [0, 1, 0],
      radius: 20, radiusMax: 20, fog: 50, clipFar: true, minNear: 5, minFar: 0 },
    inspection: {
      appearance: { representation: 'cartoon', color: 'chain-id', uniformColor: '#44aaff', background: '#071015',
        highlightColor: '#f2c47c', opacity: 1, labels: false, clipping: 0, fog: 0 },
      placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 },
    } };
  const saved = (await call('sync_inspection', { sessionId, serverEpoch: data.serverEpoch, sourceToken: data.sourceToken,
    baseStateRevision: data.stateRevision, baseInspectionRevision: data.inspectionRevision, scene })).structuredContent;
  const live = { sessionId, serverEpoch: saved.serverEpoch, sourceToken: saved.sourceToken,
    baseStateRevision: saved.stateRevision, baseInspectionRevision: saved.inspectionRevision };
  const attach = async (surface: 'desktop' | 'companion') =>
    (await call('attach_inspection', { ...live, surface })).structuredContent.panelId as string;
  const desktop = await attach('desktop');
  if (share) expect((await call('open_companion', { ...live, connection: 'loopback' })).isError).toBeFalsy();
  const state = async (commandId?: string) =>
    (await call('get_inspection_state', { sessionId, ...(commandId ? { commandId } : {}) })).structuredContent;
  /** What the Mac page sends from `stepAsideWhileHidden`. */
  const hide = async (panelId: string) =>
    (await call('detach_inspection', { ...live, panelId, reason: 'hidden' })).structuredContent.detached;
  return { call, live, scene, sessionId, desktop, attach, state, hide,
    close: async () => { await client.close(); await server.close(); await rm(dist, { force: true, recursive: true }); } };
}

describe('a hidden Mac inspector tab during a headset session', () => {
  it('lets an edit reach the headset page while the Mac panel sends no heartbeat', async () => {
    const t = await setup({ share: true });
    try {
      const headset = await t.attach('companion');
      // From here the desktop panel is silent, as a hidden tab is.
      const queued = (await t.call('update_inspection', { sessionId: t.sessionId, change: orange })).structuredContent.command;
      expect(queued.panelId, 'the edit is addressed to the wearer page, not the Mac tab').toBe(headset);
      const delivery = (await t.call('poll_inspection', { ...t.live, panelId: headset, availability: 'ready' }))._meta[KEY].delivery;
      expect(delivery.commandId).toBe(queued.commandId);
      await t.call('complete_inspection', { ...t.live, panelId: headset, commandId: delivery.commandId,
        claimToken: delivery.claimToken, scene: expectedInspection(t.scene as any, delivery.change) });
      expect((await t.state(queued.commandId)).command.status).toBe('rendered');
    } finally { await t.close(); }
  });

  it('drops a hidden Mac panel from a share at once and fails the command it could not draw', async () => {
    const t = await setup({ share: true });
    try {
      const queued = (await t.call('update_inspection', { ...t.live, panelId: t.desktop, commandId: 'held-for-mac',
        change: orange })).structuredContent.command;
      expect(queued.status).toBe('queued');
      expect(await t.hide(t.desktop)).toBe(true);
      const after = await t.state('held-for-mac');
      expect(after.panels.map((panel: any) => panel.surface)).toEqual([]);
      // Before, this command waited out its fifteen second deadline and expired.
      expect(after.command).toMatchObject({ status: 'conflict', reason: 'The targeted panel detached.' });
    } finally { await t.close(); }
  });

  it('refuses an edit with no headset page and a hidden Mac tab by naming both, without sending the agent to reconnect first', async () => {
    const t = await setup({ share: true });
    try {
      await t.hide(t.desktop);
      const refused = await t.call('update_inspection', { sessionId: t.sessionId, change: orange });
      expect(refused.isError).toBe(true);
      const text = refused.content[0].text as string;
      expect(text).toContain('No headset page is ready, and neither is this Mac\'s inspector tab');
      expect(text).toContain('bring the Stereofold tab on this Mac to the front');
      expect(text).not.toContain('open_inspector');
    } finally { await t.close(); }
  });

  it('keeps a hidden Mac-only panel for its heartbeat grace, as before', async () => {
    const t = await setup({ share: false });
    try {
      expect(await t.hide(t.desktop)).toBe(false);
      expect((await t.state()).panels.map((panel: any) => panel.panelId)).toEqual([t.desktop]);
      const queued = (await t.call('update_inspection', { sessionId: t.sessionId, change: orange })).structuredContent.command;
      expect(queued).toMatchObject({ panelId: t.desktop, status: 'queued' });
      // With no panel at all, a Mac-only session still points at open_inspector.
      await t.call('detach_inspection', { ...t.live, panelId: t.desktop });
      const refused = await t.call('update_inspection', { sessionId: t.sessionId, change: orange });
      expect(refused.content[0].text).toContain('Open the inspector with open_inspector');
    } finally { await t.close(); }
  });

  it('never lets the hidden reason detach a headset page', async () => {
    const t = await setup({ share: true });
    try {
      const headset = await t.attach('companion');
      expect(await t.hide(headset)).toBe(false);
      expect((await t.state()).panels.map((panel: any) => panel.panelId)).toContain(headset);
    } finally { await t.close(); }
  });
});
