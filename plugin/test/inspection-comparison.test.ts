import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createStereoStructureServer } from '../src/server.js';
import { PRIVATE_INSPECTION_META_KEY as PRIVATE_KEY, COMPOUND_MAX_OPS, expectedInspection,
  inspectionChangeSchema, matchesInspectionChange, sceneSchema, updateInspectionSchema,
  validateScene } from '../src/inspection-contract.js';
import { movedFields, undoChangeFor } from '../src/inspection-operation.js';
// @ts-ignore The page's own hidden-set builder, so the shape the panel saves and
// the schema that has to accept it are checked against each other.
import { normalizeVisibility } from '../../lab/browser-roundtrip/inspection-visibility.mjs';

const cif = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'stereofold-compare-'));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createStereoStructureServer(undefined,{fetchPdbText:async id=>{if(id==='9XXX') throw Error('Comparison fetch refused'); return cif;}});
  const client = new Client({ name: 'Stereofold comparison test', version: '1' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name: `stereo_structure.${name}`, arguments: args }) as Promise<any>;
  const filePath = join(root, 'source.mmcif');
  await writeFile(filePath, cif);
  const sessionId = (await call('inspect', { structureText: cif })).structuredContent.sessionId as string;
  const privateData = (await call('get_inspection', { sessionId }))._meta[PRIVATE_KEY];
  const catalog = privateData.catalog;
  const rows = catalog.rows as any[];
  const scene = {
    sourceSha256: catalog.source.sha256,
    modelNumber: catalog.modelNumbers[0],
    assemblyId: catalog.assemblyId,
    selectionKeys: [rows[0].key],
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
  const binding = { ...opened, baseStateRevision: saved.stateRevision, baseInspectionRevision: saved.inspectionRevision };
  const panelId = (await call('attach_inspection', { ...binding, surface: 'companion' })).structuredContent.panelId as string;
  // Every rendered command moves the inspection revision, and a command bound to
  // a stale one is refused. These tests run several changes in a row, so the
  // binding is re-read rather than captured once.
  const live = { ...binding };
  const advance = (value: any) => {
    if (typeof value?.stateRevision === 'number') live.baseStateRevision = value.stateRevision;
    if (typeof value?.inspectionRevision === 'number') live.baseInspectionRevision = value.inspectionRevision;
    return value;
  };
  let sources:any[]=[];
  const claim = async () => { const meta=(await call('poll_inspection', { ...live, panelId, availability: 'ready' }))._meta?.[PRIVATE_KEY]; sources=meta?.comparisonSources??[]; return meta?.delivery; };
  const state = async () => advance((await call('get_inspection_state', { sessionId })).structuredContent);
  /**
   * Answer a queued command with the scene the panel would have rendered, then
   * heartbeat. A panel that has not said `ready` since its last render is busy
   * as far as the host is concerned, and the next command is refused.
   */
  const render = async (delivery: any, rendered: any) => {
    const receipt = advance((await call('complete_inspection', { ...live, panelId, commandId: delivery.commandId,
      claimToken: delivery.claimToken, scene: rendered })).structuredContent);
    await call('poll_inspection', { ...live, panelId, availability: 'ready' });
    return receipt;
  };
  return { call, catalog, rows, scene, panelId, claim, render, state, sessionId,
    get sources() {return sources;},
    get binding() { return { ...live }; },
    close: async () => { await client.close(); await server.close(); await rm(root, { recursive: true, force: true }); } };
}


const compare = (t:Awaited<ReturnType<typeof setup>>, commandId='compare', extra={}) =>
  t.call('replace_inspection_source',{...t.binding,panelId:t.panelId,mode:'compare',pdbId:'2HHB',commandId,...extra});

describe('verified companion structures',()=>{
  it('retains an undone companion for shared redo',async()=>{
    const t=await setup();try {
      await compare(t);
      const add=await t.claim(),pair=expectedInspection(t.scene as any,add.change);
      await t.render(add,pair);
      await t.call('undo_last_change',{...t.binding,panelId:t.panelId,commandId:'undo-add'});
      const undo=await t.claim(),single=expectedInspection(pair,undo.change);
      await t.render(undo,single);
      expect((await t.state()).history).toMatchObject({redoCount:1,canRedo:true});
      const redo=await t.call('redo_last_change',{...t.binding,panelId:t.panelId,commandId:'redo-add'});
      expect(redo.isError,JSON.stringify(redo.content)).not.toBe(true);
      expect(redo.structuredContent.restores).toEqual(['companion-structure']);
      const restore=await t.claim();
      expect(t.sources).toHaveLength(1);
      expect(t.sources[0].sha256).toBe(pair.inspection.companionStructure!.sourceSha256);
      await t.render(restore,expectedInspection(single,restore.change));
      expect((await t.state()).view.companionStructure).toMatchObject(pair.inspection.companionStructure!);
    }finally{await t.close();}
  });
  it('queues without changing the primary, transports verified bytes privately and confirms only the rendered pair',async()=>{
    const t=await setup(); try {
      const queued=await compare(t,'compare',{align:'superpose'});
      expect(queued.isError,JSON.stringify(queued.content)).not.toBe(true);
      expect(queued.structuredContent.command.status).toBe('queued');
      expect(queued.structuredContent.comparison).toMatchObject({alignment:'side-by-side'});
      expect((await t.state()).view.companionStructure).toBeUndefined();
      const delivery=await t.claim();
      expect(delivery.change.kind).toBe('companion-structure');
      expect(t.sources).toHaveLength(1);
      // The heartbeat names the structure and describes its bytes; the bytes
      // themselves come through the chunk route.
      expect(t.sources[0].cif).toBeUndefined();
      expect(t.sources[0].sourceBytes.bytes).toBe(Buffer.byteLength(cif,'utf8'));
      expect(t.sources[0].sha256).toBe(t.scene.sourceSha256);
      expect(delivery.change.patch.placement.translation).toEqual([2,0,0]);
      const pair=expectedInspection(t.scene as any,delivery.change);
      expect(pair.sourceSha256).toBe(t.scene.sourceSha256);
      const missing=structuredClone(pair);delete missing.inspection.companionStructure;
      expect(matchesInspectionChange(missing,pair,delivery.change)).toBe(false);
      const wrong=structuredClone(pair);wrong.inspection.companionStructure!.sourceSha256='f'.repeat(64);
      const refused=await t.call('complete_inspection',{...t.binding,panelId:t.panelId,commandId:delivery.commandId,claimToken:delivery.claimToken,scene:wrong});
      expect(refused.isError).toBe(true);
      expect((await t.state()).view.companionStructure).toBeUndefined();
      const receipt=await t.render(delivery,pair);
      expect(receipt.command.status).toBe('rendered');
      expect(receipt.command.comparison.alignment).toBe('side-by-side');
      const state=await t.state();
      expect(state.sourceToken).toBe(t.binding.sourceToken);
      expect(state.view.companionStructure).toMatchObject({modelNumber:1,assemblyId:'asymmetric_unit',residueCount:46,alignment:'side-by-side',selectionScope:'primary-only'});
    }finally{await t.close();}
  });
  it('resolve refusal and invalid model leave both source and scene intact',async()=>{
    const t=await setup();try {
      const before=await t.state();
      const refused=await compare(t,'refused',{pdbId:'9XXX'});
      expect(refused.isError).toBe(true);
      expect(refused.content[0].text).toContain('Comparison fetch refused');
      expect((await compare(t,'missing-model',{modelNumber:99})).isError).toBe(true);
      const after=await t.state();
      expect(after.sourceToken).toBe(before.sourceToken);
      expect(after.inspectionRevision).toBe(before.inspectionRevision);
      expect(after.view).toEqual(before.view);
      expect(await t.claim()).toBeFalsy();
    }finally{await t.close();}
  });
  it('edits, removes, undoes and restores a named pair, then clears it on primary replacement',async()=>{
    const t=await setup();try {
      expect((await compare(t)).isError).not.toBe(true);
      const added=await t.claim();let pair=expectedInspection(t.scene as any,added.change);
      await t.render(added,pair);
      await t.call('update_inspection',{...t.binding,panelId:t.panelId,commandId:'style',change:{kind:'companion-structure',patch:{appearance:{opacity:0.4},placement:{scale:1.5}}}});
      const style=await t.claim();pair=expectedInspection(pair,style.change);await t.render(style,pair);
      expect(pair.inspection.companionStructure!.appearance.opacity).toBe(0.4);
      expect(pair.inspection.placement).toEqual(t.scene.inspection.placement);
      await t.call('manage_inspection_view',{...t.binding,panelId:t.panelId,commandId:'save',action:'save',name:'Comparison'});
      const save=await t.claim();const saved=await t.render(save,pair);
      expect(saved.savedView.viewIntent.companionStructure.sourceSha256).toBe(pair.inspection.companionStructure!.sourceSha256);
      await t.call('update_inspection',{...t.binding,panelId:t.panelId,commandId:'remove',change:{kind:'companion-structure',patch:{remove:true}}});
      const remove=await t.claim();await t.render(remove,expectedInspection(pair,remove.change));
      expect((await t.state()).view.companionStructure).toBeUndefined();
      const undo=await t.call('undo_last_change',{...t.binding,panelId:t.panelId,commandId:'undo'});
      expect(undo.structuredContent.restores).toEqual(['companion-structure']);
      const restore=await t.claim();await t.render(restore,expectedInspection(t.scene as any,restore.change));
      expect((await t.state()).view.companionStructure.appearance.opacity).toBe(0.4);
      await t.call('manage_inspection_view',{...t.binding,panelId:t.panelId,commandId:'restore-view',action:'restore',viewId:saved.savedView.id});
      const view=await t.claim();expect(t.sources).toHaveLength(1);
      expect(view.change.patch.scene.inspection.companionStructure).toEqual(pair.inspection.companionStructure);
      await t.render(view,view.change.patch.scene);
      const replacement=await t.call('replace_inspection_source',{...t.binding,panelId:t.panelId,pdbId:'1CRN'});
      expect(replacement.isError).not.toBe(true);
      const after=await t.state();expect(after.sourceToken).not.toBe(t.binding.sourceToken);
      expect(after.hasScene).toBe(false);
      expect(after.history).toEqual({undoCount:0,redoCount:0,canUndo:false,canRedo:false});
      const hydration=(await t.call('get_inspection',{sessionId:t.sessionId}))._meta[PRIVATE_KEY];
      expect(hydration.comparisonSources).toEqual([]);
    }finally{await t.close();}
  });
  it('validates companion style, pose, digest and request-only edits; undoing an add removes it',async()=>{
    const t=await setup();try {
      await compare(t);const delivery=await t.claim();const pair=expectedInspection(t.scene as any,delivery.change);
      expect(sceneSchema.safeParse(pair).success).toBe(true);
      for(const opacity of [-0.1,1.1,NaN]) {
        const bad=structuredClone(pair);bad.inspection.companionStructure!.appearance.opacity=opacity;
        expect(sceneSchema.safeParse(bad).success).toBe(false);
      }
      expect(updateInspectionSchema.shape.change.safeParse(delivery.change).success).toBe(false);
      expect(inspectionChangeSchema.safeParse(delivery.change).success).toBe(true);
      expect(movedFields(t.scene as any,pair)).toEqual(['companion-structure']);
      const undo=undoChangeFor({before:t.scene,after:pair} as any);
      expect(undo).toEqual({kind:'companion-structure',patch:{remove:true}});
      expect(expectedInspection(pair,undo)).toEqual(t.scene);
      const malicious=structuredClone(pair);malicious.sourceSha256='e'.repeat(64);
      expect(()=>validateScene(malicious,t.catalog)).toThrow();
    }finally{await t.close();}
  });
});
