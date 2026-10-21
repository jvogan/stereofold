import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import { createStereoStructureServer } from '../src/server.js';
import { PRIVATE_INSPECTION_META_KEY as PRIVATE_KEY, expectedInspection } from '../src/inspection-contract.js';
import { decodeInspectionCatalog } from '../src/inspection-catalog-codec.js';
import { waitForPanelRender } from '../src/inspection-render-settle.js';

// A dictated edit has to be one call: no state read first, no binding to copy,
// no residue keys to page through, and the receipt in the same answer. 4HHB is
// the structure one headset run spent four minutes coloring.
const cif = await readFile(new URL('../../fixtures/4HHB.cif', import.meta.url), 'utf8');

async function setup(options: Parameters<typeof createStereoStructureServer>[1] = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  // A running wearer session on this Mac must not change a test's expiry
  // result or receive any synthetic shared-scene work.
  const server = createStereoStructureServer(undefined, { ...options,
    sceneServiceFile: options.sceneServiceFile ?? join(tmpdir(), `stereofold-talk-act-${randomUUID()}.json`) });
  const client = new Client({ name: 'Stereofold fast edits test', version: '1' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name: `stereo_structure.${name}`, arguments: args }) as Promise<any>;
  const sessionId = (await call('inspect', { structureText: cif })).structuredContent.sessionId as string;
  const privateData = (await call('get_inspection', { sessionId }))._meta[PRIVATE_KEY];
  // Past the inline bound the catalog rides as a compressed wire.
  const catalog = privateData.catalog ?? await decodeInspectionCatalog(privateData.catalogWire);
  const rows = catalog.rows as any[];
  const scene = {
    sourceSha256: catalog.source.sha256,
    modelNumber: catalog.modelNumbers[0],
    assemblyId: catalog.assemblyId,
    selectionKeys: [] as string[],
    camera: { mode: 'perspective', fov: Math.PI / 4, position: [0, 0, 80], target: [0, 0, 0], up: [0, 1, 0],
      radius: 20, radiusMax: 20, fog: 50, clipFar: true, minNear: 5, minFar: 0 },
    inspection: {
      appearance: { representation: 'cartoon', color: 'chain-id', uniformColor: '#58dcc9', background: '#071015',
        opacity: 1, labels: false, highlightColor: '#f2c47c', clipping: 0, fog: 0 },
      placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 },
    },
  };
  const opened = { sessionId, serverEpoch: privateData.serverEpoch, sourceToken: privateData.sourceToken,
    baseStateRevision: privateData.stateRevision, baseInspectionRevision: privateData.inspectionRevision };
  const saved = (await call('sync_inspection', { ...opened, scene })).structuredContent;
  const live = { ...opened, baseStateRevision: saved.stateRevision, baseInspectionRevision: saved.inspectionRevision };
  const panelId = (await call('attach_inspection', { ...live, surface: 'companion' })).structuredContent.panelId as string;
  const advance = (value: any) => {
    if (typeof value?.stateRevision === 'number') live.baseStateRevision = value.stateRevision;
    if (typeof value?.inspectionRevision === 'number') live.baseInspectionRevision = value.inspectionRevision;
    return value;
  };
  let shown: any = scene;
  const heartbeat = () => call('poll_inspection', { ...live, panelId, availability: 'ready' });
  /** Claim the queued command the way the headset page does, waiting for it to be queued. */
  const claim = async () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const delivery = (await heartbeat())._meta?.[PRIVATE_KEY]?.delivery;
      if (delivery) return delivery;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw Error('No command reached the panel.');
  };
  /** Draw exactly what the command asked for, then say ready again. */
  const render = async (delivery: any) => {
    shown = expectedInspection(shown, delivery.change);
    const receipt = advance((await call('complete_inspection', { ...live, panelId, commandId: delivery.commandId,
      claimToken: delivery.claimToken, scene: shown })).structuredContent);
    await heartbeat();
    return receipt;
  };
  /** Refuse the command the way the panel does, with its own sentence. */
  const fail = async (delivery: any, failureReason: string) => {
    await call('complete_inspection', { ...live, panelId, commandId: delivery.commandId,
      claimToken: delivery.claimToken, failure: 'render_failed', failureReason });
    await heartbeat();
  };
  const state = async () => advance((await call('get_inspection_state', { sessionId })).structuredContent);
  const manual = async (change: any) => {
    shown = expectedInspection(shown, change);
    const saved = advance((await call('sync_inspection', { ...live, scene: shown })).structuredContent);
    expect(saved.saved).toBe(true);
    await heartbeat();
  };
  return { call, rows, sessionId, panelId, claim, render, fail, state, manual, heartbeat,
    get binding() { return { ...live }; },
    get scene() { return structuredClone(shown); },
    close: async () => { await client.close(); await server.close(); } };
}

describe('talk to act through wake and local saves', () => {
  it('holds a tour through render-in-flight and applies once ready', async () => {
    const h=await setup();
    try {
      await h.call('poll_inspection',{...h.binding,panelId:h.panelId,availability:'busy'});
      const tourId=(await h.state()).tours[0].id;
      const answer=await h.call('control_tour',{sessionId:h.sessionId,action:'start',tourId,autoplay:false,narration:false,commandId:'wake-tour'});
      expect(answer.isError).not.toBe(true);
      expect(answer.structuredContent.command).toMatchObject({status:'queued',heldForPanel:true});
      const held=await h.call('poll_inspection',{...h.binding,panelId:h.panelId,availability:'busy'});
      expect(held._meta?.[PRIVATE_KEY]?.delivery).toBeUndefined();
      const receipt=await h.render(await h.claim());
      expect(receipt.command.status).toBe('rendered');
    } finally {await h.close();}
  });
  it.each([false,true])('settles a wake save and preserves real conflict=%s',async conflict=>{
    const h=await setup();
    try {
      const tourId=(await h.state()).tours[0].id;
      const answer=await h.call('control_tour',{sessionId:h.sessionId,action:'start',tourId,autoplay:false,commandId:'save-tour'});
      expect(answer.structuredContent.command.status).toBe('queued');
      const old=h.binding;
      const held=await h.call('poll_inspection',{...old,panelId:h.panelId,availability:'unsaved'});
      expect(held.structuredContent.outcome.status).toBe('queued');
      const saved=h.scene;
      if(conflict)saved.inspection.appearance.opacity=.2;
      else saved.inspection.placement.translation=[1,0,0];
      const sync=await h.call('sync_inspection',{...old,panelId:h.panelId,scene:saved});
      expect(sync.structuredContent.saved).toBe(true);
      await h.state();
      // An old beat in transport must not erase the save's revision proof.
      await h.call('poll_inspection',{...old,panelId:h.panelId,availability:'unsaved'});
      const state=await h.call('get_inspection_state',{sessionId:h.sessionId,commandId:'save-tour'});
      expect(state.structuredContent.command.status).toBe(conflict?'conflict':'queued');
      if(!conflict) {
        const delivery=await h.claim();
        const done=await h.call('complete_inspection',{...h.binding,panelId:h.panelId,commandId:delivery.commandId,claimToken:delivery.claimToken,scene:saved});
        expect(done.structuredContent.command.status).toBe('rendered');
      }
    } finally {await h.close();}
  });
  it('returns a claimed command to its bounded queue when a ready heartbeat races a local save',async()=>{
    const h=await setup();
    try {
      await h.call('control_tour',{sessionId:h.sessionId,action:'pause',commandId:'late-save'});
      const delivery=await h.claim();
      const deferred=await h.call('complete_inspection',{...h.binding,panelId:h.panelId,commandId:delivery.commandId,claimToken:delivery.claimToken,phase:'defer-local-save'});
      expect(deferred.structuredContent.deferred).toBe(true);
      const saved=h.scene;saved.inspection.placement.translation=[1,0,0];
      expect((await h.call('sync_inspection',{...h.binding,panelId:h.panelId,scene:saved})).structuredContent.saved).toBe(true);
      await h.state();
      const next=await h.claim();expect(next.commandId).toBe(delivery.commandId);expect(next.claimToken).not.toBe(delivery.claimToken);
      expect((await h.call('complete_inspection',{...h.binding,panelId:h.panelId,commandId:next.commandId,claimToken:next.claimToken,scene:saved})).structuredContent.command.status).toBe('rendered');
    } finally {await h.close();}
  });
  it('does not extend the original delivery deadline while the panel stays busy',async()=>{
    let clock=1000;const h=await setup({now:()=>clock});
    try {
      await h.call('poll_inspection',{...h.binding,panelId:h.panelId,availability:'busy'});
      await h.call('control_tour',{sessionId:h.sessionId,action:'pause',commandId:'bounded'});
      clock+=14999;
      await h.call('poll_inspection',{...h.binding,panelId:h.panelId,availability:'busy'});
      clock+=1;
      const state=await h.call('get_inspection_state',{sessionId:h.sessionId,commandId:'bounded'});
      expect(state.structuredContent.command.status).toBe('expired');
    } finally {await h.close();}
  });
  it('does not rebase explicitly stale revisions' ,async()=>{
    const h=await setup();
    try {
      const old=h.binding;
      await h.manual({kind:'appearance',patch:{opacity:.5}});
      const answer=await h.call('control_tour',{...old,panelId:h.panelId,action:'pause',commandId:'stale-tour'});
      expect(answer.isError).toBe(true);
      expect(answer.content[0].text).toMatch(/current saved revisions/);
    } finally {await h.close();}
  });
  it('waits through the delivery-time render race with a fixed bound',async()=>{
    let now=0,ready=false;
    await waitForPanelRender({ready:()=>ready,current:()=>true,now:()=>now,sleep:async ms=>{now+=ms;ready=now>=200;}});
    expect(now).toBe(200);
    await expect(waitForPanelRender({ready:()=>false,current:()=>true,waitMs:100,now:()=>now,sleep:async ms=>{now+=ms;}})).rejects.toThrow(/stayed busy/);
    expect(now).toBe(300);
  });
});
