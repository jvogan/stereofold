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
// @ts-ignore Shared production geometry accounting, exercised by the renderer lab as well.
import { requireSceneGeometryBudget, geometryBudgetReceipt } from '../../lab/browser-roundtrip/representation-budget.mjs';
import { movedFields, undoChangeFor } from '../src/inspection-operation.js';
// @ts-ignore The page's own hidden-set builder, so the shape the panel saves and
// the schema that has to accept it are checked against each other.
import { normalizeVisibility } from '../../lab/browser-roundtrip/inspection-visibility.mjs';

const cif = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'stereofold-combined-'));
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
  const render = async (delivery: any, rendered: any, geometryBudget?:any) => {
    const receipt = advance((await call('complete_inspection', { ...live, panelId, commandId: delivery.commandId,
      claimToken: delivery.claimToken, scene: rendered, ...(geometryBudget?{geometryBudget}:{}) })).structuredContent);
    await call('poll_inspection', { ...live, panelId, availability: 'ready' });
    return receipt;
  };
  return { call, catalog, rows, scene, panelId, claim, render, state, sessionId,
    get sources() {return sources;},
    get binding() { return { ...live }; },
    close: async () => { await client.close(); await server.close(); await rm(root, { recursive: true, force: true }); } };
}

const queue = (t:any, commandId:string, change:any, extra={}) => t.call('update_inspection',
  {...t.binding,panelId:t.panelId,commandId,change,...extra});

describe('combined comparison, scoped styles, visibility and saved history',()=>{
  it('confirms all seven fields together, restores a named scene and undoes each rendered operation exactly once',async()=>{
    const t=await setup();
    try {
      let current:any=structuredClone(t.scene);
      const history:any[]=[];
      const settle=async(record=true)=>{
        const delivery=await t.claim(); expect(delivery).toBeTruthy();
        const expected=delivery.change.kind==='restore-view' ? delivery.change.patch.scene : expectedInspection(current,delivery.change);
        expect(matchesInspectionChange(expected,expected,delivery.change)).toBe(true);
        let geometry;
        if(expected.inspection.styles?.length && expected.inspection.companionStructure) {
          const atoms=t.rows.reduce((n:number,row:any)=>n+row.atomSites.length,0);
          const counts=(atoms:number,residues:number)=>({atoms,residues,bonds:Math.ceil(atoms*1.2)});
          const entries=[{representation:expected.inspection.appearance.representation,...counts(atoms,t.rows.length)},
            {representation:expected.inspection.companionStructure.appearance.representation,...counts(atoms,t.rows.length)},
            ...expected.inspection.styles.map((style:any)=>({representation:style.representation??expected.inspection.appearance.representation,
              ...counts(t.rows.filter((row:any)=>style.selectionKeys.includes(row.key)).reduce((n:number,row:any)=>n+row.atomSites.length,0),style.selectionKeys.length)}))];
          const decisions=requireSceneGeometryBudget(entries,{presenting:true,deviceClass:'quest2',quality:'highest'});
          expect(decisions.every((d:any)=>d.atoms===entries.reduce((n:number,e:any)=>n+e.atoms,0))).toBe(true);
          expect(decisions.every((d:any)=>d.level==='highest' && Object.keys(d.typeParams).length===0)).toBe(true);
          for(const decision of decisions) {
            expect(decision.status).toBe(decision.estimatedVertices>decision.budget?'advisory':'unchanged');
            if(decision.status==='advisory')expect(decision.message).toContain('may run slowly');
          }
          geometry=geometryBudgetReceipt(decisions[0]);
        }
        const receipt=await t.render(delivery,expected,geometry);
        expect(receipt.command.status,delivery.commandId).toBe('rendered');
        if(geometry) expect(receipt.command.geometryBudget).toEqual(geometry);
        if(record) history.push(structuredClone(current));
        current=expected;
        const meta=(await t.call('get_inspection',{sessionId:t.sessionId}))._meta[PRIVATE_KEY];
        expect(meta.scene).toEqual(current);
        return receipt;
      };
      expect((await t.call('replace_inspection_source',{...t.binding,panelId:t.panelId,
        mode:'compare',pdbId:'2HHB',commandId:'pair'})).isError).not.toBe(true);
      await settle();
      await queue(t,'sticks',{kind:'appearance',scope:'selection',patch:{representation:'ball-and-stick',color:'uniform',uniformColor:'#ff8800'}});
      await settle();
      const chain={labelChain:t.rows[0].identity.labelChain,copyId:t.rows[0].identity.copyId};
      await queue(t,'hide-chain',{kind:'visibility',patch:{op:'hide',chains:[chain]}});
      await settle();
      const keys=[t.rows[2].key,t.rows[3].key];
      const referent={sourceToken:t.binding.sourceToken,capturedAt:1,modelNumber:t.scene.modelNumber,assemblyId:t.scene.assemblyId,selectionKeys:keys};
      await queue(t,'only-captured',{kind:'visibility',patch:{op:'only',selection:true}},{referent});
      await settle(); expect(current.selectionKeys).toEqual(keys);
      const compound={kind:'compound',patch:{ops:[
        {kind:'appearance',patch:{opacity:0.7,background:'#ffffff'}},
        {kind:'selection',patch:{selectionKeys:[t.rows[4].key]}},
        {kind:'appearance',scope:'selection',patch:{representation:'ball-and-stick',color:'uniform',uniformColor:'#3377ee'}},
        {kind:'placement',patch:{scale:1.5}},
        {kind:'emphasis',parts:[],context:0.2},
        // Crambin is a polymer and has no water, and a hide naming a
        // class the structure has none of is now refused rather than confirmed.
        {kind:'visibility',patch:{op:'hide',classes:['polymer']}},
        {kind:'companion-structure',patch:{appearance:{opacity:0.4},placement:{scale:1.25}}},
      ]}};
      const queued=await queue(t,'seven',compound);
      expect(queued.isError,JSON.stringify(queued)).not.toBe(true);
      expect(queued.structuredContent.compound.ops).toHaveLength(COMPOUND_MAX_OPS);
      await settle();
      const named=structuredClone(current);
      await t.call('manage_inspection_view',{...t.binding,panelId:t.panelId,commandId:'save',action:'save',name:'Combined scene'});
      const save=await settle(false);
      const ops:any[]=[
        {kind:'appearance',patch:t.scene.inspection.appearance},
        {kind:'selection',patch:{selectionKeys:[]}},
        {kind:'styles',patch:{styles:[]}},
        {kind:'placement',patch:t.scene.inspection.placement},
        {kind:'emphasis',parts:[],context:0.9},
        {kind:'visibility',patch:{op:'reset'}},
        {kind:'companion-structure',patch:{remove:true}},
      ];
      // Public style clearing targets the styled residues, then the rest of the
      // seven-field change is still one compound and one history entry.
      ops[2]={kind:'appearance',scope:'selection',patch:{clear:true}} as any;
      ops[1]={kind:'selection',patch:{selectionKeys:current.inspection.styles.flatMap((s:any)=>s.selectionKeys)}};
      expect((await queue(t,'change-everything',{kind:'compound',patch:{ops}})).isError).not.toBe(true);
      await settle();
      for(const field of ['styles','companionStructure','visibility']) {
        await t.call('manage_inspection_view',{...t.binding,panelId:t.panelId,commandId:'missing-'+field,action:'restore',viewId:save.savedView.id});
        const delivery=await t.claim();
        const expected=delivery.change.kind==='restore-view' ? delivery.change.patch.scene : expectedInspection(current,delivery.change);
        const missing=structuredClone(expected);delete missing.inspection[field];
        expect(matchesInspectionChange(missing,expected,delivery.change)).toBe(false);
        expect((await t.render(delivery,missing)).command.status).toBe('unconfirmed');
      }
      await t.call('manage_inspection_view',{...t.binding,panelId:t.panelId,commandId:'restore',action:'restore',viewId:save.savedView.id});
      await settle(); expect(current).toEqual(named);
      let count=0;
      while(history.length) {
        const before=history.pop();
        const queued=await t.call('undo_last_change',{...t.binding,panelId:t.panelId,commandId:'undo-'+count++});
        expect(queued.structuredContent.undone).toBe(true);
        await settle(false);
        // Absent emphasis and its canonical empty spelling describe the same scene.
        expect(current.inspection.appearance).toEqual(before.inspection.appearance);
        expect(movedFields(before,current)).toEqual([]);
      }
      expect(count).toBe(7);
      expect((await t.call('undo_last_change',{...t.binding,panelId:t.panelId,commandId:'empty'})).structuredContent.undone).toBe(false);
      expect(current.inspection.styles).toBeUndefined();
      expect(current.inspection.companionStructure).toBeUndefined();
      expect(current.inspection.visibility).toBeUndefined();
      expect(current.selectionKeys).toEqual(t.scene.selectionKeys);
    } finally {await t.close();}
  });
});
