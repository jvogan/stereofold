/**
 * A real host session shared with a headset page, and that page's panel.
 *
 * `open_companion` over loopback is what marks a session shared, and a shared
 * session is the one where `sync_inspection` answers `busy` while a command
 * waits. That refusal is the half of the placement-save bug a plain session
 * cannot show. The companion panel's own calls go straight through MCP here,
 * the way the inspection talk-to-act tests drive one; only the loopback
 * listener is real, on an ephemeral port, and the scene-service record lives
 * in a temporary folder rather than the one on this Mac.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect } from 'vitest';
import { createStereoStructureServer } from '../../src/server.js';
import { createReplyAudioSynthesizer } from '../../src/headset-reply-audio.js';
import { PRIVATE_INSPECTION_META_KEY as PRIVATE_KEY, type InspectionScene } from '../../src/inspection-contract.js';

const cif = await readFile(new URL('../../../fixtures/1CRN.cif', import.meta.url), 'utf8');

export type Binding = { serverEpoch: string; sourceToken: string; baseStateRevision: number; baseInspectionRevision: number };

export async function sharedPanelSession() {
  const folder = await mkdtemp(join(tmpdir(), 'stereofold-placement-save-'));
  await writeFile(join(folder, 'inspector.html'), '<html><script>void 0;</script></html>');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createStereoStructureServer(join(folder, 'viewer.html'), {
    replyAudio: createReplyAudioSynthesizer({ enabled: false }),
    headsetDevice: { exists: async () => false, run: async () => { throw Error('No headset in this test.'); } },
    sceneServiceFile: join(folder, 'scene-service.json'),
  } as Parameters<typeof createStereoStructureServer>[1]);
  const client = new Client({ name: 'Stereofold placement save test', version: '1' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name: `stereo_structure.${name}`, arguments: args }) as Promise<any>;
  const sessionId = (await call('inspect', { structureText: cif })).structuredContent.sessionId as string;
  const priv = (await call('get_inspection', { sessionId }))._meta[PRIVATE_KEY];
  const scene: InspectionScene = {
    sourceSha256: priv.catalog.source.sha256, modelNumber: priv.catalog.modelNumbers[0], assemblyId: priv.catalog.assemblyId,
    selectionKeys: [priv.catalog.rows[0].key],
    camera: { mode: 'perspective', fov: Math.PI / 4, position: [0, 0, 80], target: [0, 0, 0], up: [0, 1, 0],
      radius: 20, radiusMax: 20, fog: 50, clipFar: true, minNear: 5, minFar: 0 },
    inspection: {
      appearance: { representation: 'cartoon', color: 'chain-id', uniformColor: '#58dcc9', background: '#071015',
        opacity: 1, labels: false, highlightColor: '#f2c47c', clipping: 0, fog: 0 },
      placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 },
    },
  } as InspectionScene;
  const opened = { serverEpoch: priv.serverEpoch, sourceToken: priv.sourceToken,
    baseStateRevision: priv.stateRevision, baseInspectionRevision: priv.inspectionRevision };
  const first = (await call('sync_inspection', { sessionId, ...opened, scene })).structuredContent;
  const live: Binding = { ...opened, baseStateRevision: first.stateRevision, baseInspectionRevision: first.inspectionRevision };
  const panelId = (await call('attach_inspection', { sessionId, ...live, surface: 'companion' })).structuredContent.panelId as string;
  const companion = await call('open_companion', { sessionId, ...live });
  expect(companion.isError, JSON.stringify(companion.content)).not.toBe(true);
  expect(companion.structuredContent.shared).toBe(true);
  let saved: InspectionScene = structuredClone(scene);
  /** One heartbeat from the headset page, on the binding it holds. */
  const beat = async (availability: 'ready' | 'busy' | 'unsaved', from: Binding = live) =>
    (await call('poll_inspection', { sessionId, ...from, panelId, availability }))._meta?.[PRIVATE_KEY]?.delivery;
  /** The page's own save, the way `save()` in inspector.ts posts it. */
  const save = async (next: InspectionScene) => {
    const answer = (await call('sync_inspection', { sessionId, ...live, panelId, scene: next })).structuredContent;
    if (answer.saved) {
      if (typeof answer.inspectionRevision === 'number') live.baseInspectionRevision = answer.inspectionRevision;
      if (typeof answer.stateRevision === 'number') live.baseStateRevision = answer.stateRevision;
      saved = structuredClone(next);
    }
    return answer;
  };
  const state = async (commandId?: string) =>
    (await call('get_inspection_state', { sessionId, ...(commandId ? { commandId } : {}) })).structuredContent;
  /** Draw a delivered command over `scene` and send its receipt. */
  const complete = async (delivery: any, drawn: InspectionScene) => {
    const answer = (await call('complete_inspection', { sessionId, ...live, panelId, commandId: delivery.commandId,
      claimToken: delivery.claimToken, scene: drawn })).structuredContent;
    if (answer.command?.status === 'rendered') {
      live.baseInspectionRevision = answer.command.renderedRevision;
      saved = structuredClone(drawn);
    }
    return answer;
  };
  return { call, sessionId, panelId, beat, save, state, complete,
    get binding() { return { ...live }; }, get saved() { return structuredClone(saved); },
    close: async () => { await client.close(); await server.close(); await rm(folder, { recursive: true, force: true }); } };
}

/** The saved scene with the structure moved and scaled, as a grab or the entry seat leaves it. */
export function movedBy(scene: InspectionScene, translation: [number, number, number] = [0.4, -0.2, -1.6], scale = 1.6): InspectionScene {
  const next = structuredClone(scene);
  next.inspection.placement = { ...next.inspection.placement, translation, scale };
  next.camera = { ...next.camera, position: [0.2, 1.6, 0.3] };
  return next;
}
