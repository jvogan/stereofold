import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import {awaitReceipt,RECEIPT_POLL_MS} from '../scripts/inspection-agent.js';
import {callLocalAgent} from '../scripts/local-agent.js';
vi.mock('../scripts/local-agent.js',async importOriginal=>({...await importOriginal<any>(),callLocalAgent:vi.fn()}));
import { createStereoStructureServer } from '../src/server.js';
import { PRIVATE_INSPECTION_META_KEY as PRIVATE_KEY } from '../src/inspection-contract.js';
import { choosePanel, COMPANION_LOADING_MESSAGE } from '../scripts/agent-arguments.js';

const cif = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');

type Binding = {
  sessionId: string;
  serverEpoch: string;
  sourceToken: string;
  baseStateRevision: number;
  baseInspectionRevision: number;
};

async function setup() {
  const clock = { now: 0 };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createStereoStructureServer(undefined, { now: () => clock.now });
  const client = new Client({ name: 'Stereofold inspection command test', version: '1' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown>) => client.callTool({
    name: `stereo_structure.${name}`,
    arguments: args,
  }) as Promise<any>;
  const opened = await call('inspect', { structureText: cif });
  expect(opened.isError).not.toBe(true);
  const sessionId = opened.structuredContent.sessionId as string;
  const hydrated = await call('get_inspection', { sessionId });
  const privateData = hydrated._meta[PRIVATE_KEY];
  const scene = {
    sourceSha256: privateData.catalog.source.sha256,
    modelNumber: privateData.catalog.modelNumbers[0],
    assemblyId: privateData.catalog.assemblyId,
    selectionKeys: [privateData.catalog.rows[0].key],
    camera: {
      mode: 'perspective', fov: Math.PI / 4, position: [0, 0, 80], target: [0, 0, 0], up: [0, 1, 0],
      radius: 20, radiusMax: 20, fog: 50, clipFar: true, minNear: 5, minFar: 0,
    },
    inspection: {
      appearance: { representation: 'cartoon', color: 'chain-id', uniformColor: '#58dcc9', background: '#071015', opacity: 1, labels: false, highlightColor: '#f2c47c', clipping: 0, fog: 0 },
      placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 },
    },
  };
  const initial: Binding = {
    sessionId,
    serverEpoch: privateData.serverEpoch,
    sourceToken: privateData.sourceToken,
    baseStateRevision: privateData.stateRevision,
    baseInspectionRevision: privateData.inspectionRevision,
  };
  const saved = await call('sync_inspection', { ...initial, scene });
  expect(saved.structuredContent.saved).toBe(true);
  const binding: Binding = {
    ...initial,
    baseStateRevision: saved.structuredContent.stateRevision,
    baseInspectionRevision: saved.structuredContent.inspectionRevision,
  };
  const attached = await call('attach_inspection', binding);
  const panelId = attached.structuredContent.panelId as string;
  const current = async (commandId?: string) => call('get_inspection_state', {
    sessionId,
    ...(commandId == null ? {} : { commandId }),
  });
  const poll = async (availability: 'ready' | 'busy' | 'unsaved' = 'ready', expected = binding, panel = panelId) => {
    const result = await call('poll_inspection', { ...expected, panelId: panel, availability });
    return { result, delivery: result._meta?.[PRIVATE_KEY]?.delivery };
  };
  const close = async () => { await client.close(); await server.close(); };
  return { clock, client, server, call, sessionId, scene, binding, panelId, current, poll, close };
}

// Node-only transport harness: real MCP enqueue, claim, completion and CLI wait.
// Mol*'s warm render and the unchanged companion heartbeat are timed stand-ins.
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
it('measures each warm receipt hop before and after, without polling an XR frame',async()=>{
  const measurements=[];
  for(const pollMs of [750,RECEIPT_POLL_MS]) {
    const t=await setup();
    try {
      await t.poll();
      vi.mocked(callLocalAgent).mockImplementation(async(_state,_tool,args)=>t.current(args?.commandId as string));
      const commandId=`latency-${pollMs}`;
      const start=performance.now();
      const queued=await t.call('update_inspection',{...t.binding,panelId:t.panelId,commandId,
        change:{kind:'appearance',patch:{color:'uniform'}}});
      expect(queued.structuredContent.command.status).toBe('queued');
      const enqueued=performance.now();
      const waiting=awaitReceipt({} as any,commandId,{pollMs,timeoutMs:4000});
      await sleep(1000); // Existing companion heartbeat, not an XR frame callback.
      const delivered=(await t.poll()).delivery;
      const claimed=performance.now();
      expect(delivered.commandId).toBe(commandId);
      const admission=await t.call('complete_inspection',{...t.binding,panelId:t.panelId,commandId,
        claimToken:delivered.claimToken,phase:'admit'});
      expect(admission.structuredContent.admitted).toBe(true);
      const admitted=performance.now();
      await sleep(80); // Explicit warm-render stand-in, not headset evidence.
      const rendered=performance.now();
      const scene=structuredClone(t.scene);scene.inspection.appearance.color='uniform';
      const complete=await t.call('complete_inspection',{...t.binding,panelId:t.panelId,commandId,
        claimToken:delivered.claimToken,scene});
      const completed=performance.now();
      expect(complete.structuredContent.command.status).toBe('rendered');
      const receipt=await waiting;
      const observed=performance.now();
      expect(receipt.timedOut).toBe(false);
      expect(receipt.receipt.status).toBe('rendered');
      expect(observed-rendered).toBeLessThan(1000);
      measurements.push({pollMs,enqueueMs:enqueued-start,heartbeatAndClaimMs:claimed-enqueued,
        hostAdmissionMs:admitted-claimed,renderStandInMs:rendered-admitted,hostSettlementMs:completed-rendered,
        cliObservationMs:observed-completed,renderToReceiptMs:observed-rendered,totalMs:observed-start});
    } finally {await t.close();}
  }
  console.log('LATENCY_TIMINGS '+JSON.stringify(measurements.map(row=>Object.fromEntries(
    Object.entries(row).map(([k,v])=>[k,Math.round(v*100)/100])))));
});
