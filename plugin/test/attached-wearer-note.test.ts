import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createStereoStructureServer } from '../src/server.js';
import { PRIVATE_INSPECTION_META_KEY as KEY } from '../src/inspection-contract.js';

// A headset page reached over the USB route checks in without any private
// Wi-Fi share. The wearer note beside its state must not say that no page is
// attached, or tell the agent to reconnect, while that page is in VR.

const cif = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');
const xr = (over: Record<string, unknown> = {}) => ({ phase: 'idle', pending: false, reloadRequired: false, mode: null,
  gestureActive: null, presenting: false, visible: true, ...over });
const inVr = (frameCount: number) =>
  xr({ phase: 'active', mode: 'immersive-ar', presenting: true, sessionVisibility: 'visible', frameCount });
const sceneFor = (sourceSha256: string, modelNumber: number, assemblyId: string, color = 'chain-id') => ({
  sourceSha256, modelNumber, assemblyId, selectionKeys: [] as string[],
  camera: { mode: 'perspective', fov: Math.PI / 4, position: [0, 0, 80], target: [0, 0, 0], up: [0, 1, 0],
    radius: 20, radiusMax: 20, fog: 50, clipFar: true, minNear: 5, minFar: 0 },
  inspection: {
    appearance: { representation: 'cartoon', color, uniformColor: '#44aaff', background: '#071015',
      highlightColor: '#f2c47c', opacity: 1, labels: false, clipping: 0, fog: 0 },
    placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 },
  } });

async function setup() {
  const dist = await mkdtemp(join(tmpdir(), 'stereofold-attached-wearer-'));
  await writeFile(join(dist, 'viewer.html'), '<html><script>void 0;</script></html>');
  await writeFile(join(dist, 'inspector.html'), '<html><script>void 0;</script></html>');
  await mkdir(join(dist, 'molstar'), { recursive: true });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createStereoStructureServer(join(dist, 'viewer.html'), {});
  const client = new Client({ name: 'Stereofold attached wearer test', version: '1' });
  await server.connect(b); await client.connect(a);
  const call = async (name: string, args: Record<string, unknown>) =>
    await client.callTool({ name: `stereo_structure.${name}`, arguments: args }) as any;
  const sessionId = (await call('inspect', { structureText: cif })).structuredContent.sessionId as string;
  const data = (await call('get_inspection', { sessionId }))._meta[KEY];
  const scene = (color?: string) => sceneFor(data.catalog.source.sha256, data.catalog.modelNumbers[0], data.catalog.assemblyId, color);
  const saved = (await call('sync_inspection', { sessionId, serverEpoch: data.serverEpoch, sourceToken: data.sourceToken,
    baseStateRevision: data.stateRevision, baseInspectionRevision: data.inspectionRevision, scene: scene() })).structuredContent;
  const live = { sessionId, serverEpoch: saved.serverEpoch, sourceToken: saved.sourceToken,
    baseStateRevision: saved.stateRevision, baseInspectionRevision: saved.inspectionRevision };
  // The USB route: a loopback companion, no private Wi-Fi share.
  expect((await call('open_companion', { ...live, connection: 'loopback', launch: 'none' })).isError).toBeFalsy();
  const headset = (await call('attach_inspection', { ...live, surface: 'companion' })).structuredContent.panelId as string;
  const beat = async (report: Record<string, unknown>) =>
    await call('poll_inspection', { ...live, panelId: headset, availability: 'ready', xrStartup: report });
  const wearer = async () => (await call('get_inspection_state', { sessionId })).structuredContent.wearer;
  return { call, live, scene, sessionId, headset, beat, wearer,
    close: async () => { await client.close(); await server.close(); await rm(dist, { force: true, recursive: true }); } };
}

describe('the wearer note for a headset page attached without a Wi-Fi share', () => {
  it('says the page is attached and in VR, and does not send the agent to reconnect', async () => {
    const t = await setup();
    try {
      await t.beat(inVr(0));
      await t.beat(inVr(18));
      const wearer = await t.wearer();
      expect(wearer).toMatchObject({ linked: false, shareOpen: false, share: false, panel: true, state: 'in-vr' });
      expect(wearer.note).toContain('A headset page is attached and in VR');
      expect(wearer.note).toContain('A rendered receipt on that headset panel is what its page drew');
      expect(wearer.note).not.toContain('no headset page is attached');
      expect(wearer.note).not.toContain('Reconnect with open_companion');
      expect(wearer.note).not.toContain('say_to_headset cannot reach them');
      expect(wearer.note).not.toContain('Confirm wearer.state is "in-vr"');
    } finally { await t.close(); }
  });

  it('says a page in VR that has not drawn the newest revision is attached and still catching up', async () => {
    const t = await setup();
    try {
      await t.beat(inVr(0));
      await t.beat(inVr(18));
      // This Mac saves a newer revision; the headset page has not drawn it yet.
      const newer = await t.call('sync_inspection', { ...t.live, scene: t.scene('element-symbol') });
      expect(newer.isError, JSON.stringify(newer.content)).toBeFalsy();
      expect(newer.structuredContent.inspectionRevision).toBe(t.live.baseInspectionRevision + 1);
      const wearer = await t.wearer();
      expect(wearer).toMatchObject({ linked: false, panel: false, state: 'in-vr' });
      expect(wearer.note).toContain('A headset page is attached and in VR');
      expect(wearer.note).toContain('has not drawn this structure at the current revision yet');
      expect(wearer.note).toContain('until wearer.panel is true');
      expect(wearer.note).not.toContain('no headset page is attached');
      expect(wearer.note).not.toContain('Reconnect with open_companion');
    } finally { await t.close(); }
  });

  it('does not call the full Mol* viewer a headset page after the headset page has left', async () => {
    const t = await setup();
    try {
      await t.beat(inVr(0));
      await t.beat(inVr(18));
      expect((await t.call('detach_inspection', { ...t.live, panelId: t.headset })).isError).toBeFalsy();
      const detailed = await t.call('attach_inspection', { ...t.live, surface: 'detailed' });
      expect(detailed.isError, JSON.stringify(detailed.content)).toBeFalsy();
      const wearer = await t.wearer();
      expect(wearer).toMatchObject({ linked: false, state: 'page-open' });
      expect(wearer.note).not.toContain('A headset page is attached');
      expect(wearer.note).toContain('No wearer is linked to this inspection');
    } finally { await t.close(); }
  });

  it('asks for in-vr before anything is reported as seen while the page waits for Enter VR', async () => {
    const t = await setup();
    try {
      await t.beat(xr());
      const wearer = await t.wearer();
      expect(wearer).toMatchObject({ linked: false, panel: true, state: 'page-open' });
      expect(wearer.note).toContain('A headset page is attached and open');
      expect(wearer.note).toContain('Confirm wearer.state is "in-vr" before reporting anything as seen.');
      expect(wearer.note).not.toContain('Reconnect with open_companion');
    } finally { await t.close(); }
  });
});
