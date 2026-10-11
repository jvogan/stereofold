import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, it, expect } from 'vitest';
import { createStereoStructureServer } from '../src/server.js';
import { PRIVATE_INSPECTION_META_KEY as key, expectedInspection } from '../src/inspection-contract.js';
const cif=await readFile(new URL('../../fixtures/1CRN.cif',import.meta.url),'utf8');
  async function setup(fetchOverride?: (id:string, signal?:AbortSignal)=>Promise<string>) {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const fetching = new Promise<void>(r => { entered = r; });
    const server = createStereoStructureServer(undefined, { fetchPdbText: fetchOverride??(async () => { entered(); await gate; return cif; }) });
    const client = new Client({ name: 'closeout lifecycle review fixture', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b); await client.connect(a);
    const call = async (name: string, args: any) => client.callTool({ name: 'stereo_structure.' + name, arguments: args }) as Promise<any>;
    const ok = (r: any) => { if (r.isError) throw Error(JSON.stringify(r.content)); return r; };
    const sessionId = ok(await call('inspect', { structureText: cif })).structuredContent.sessionId;
    const data = ok(await call('get_inspection', { sessionId }))._meta[key];
    const scene = { sourceSha256: data.catalog.source.sha256, modelNumber: data.catalog.modelNumbers[0],
      assemblyId: data.catalog.assemblyId, selectionKeys: [data.catalog.rows[0].key],
      camera: { mode: 'perspective', fov: Math.PI / 4, position: [0, 0, 80], target: [0, 0, 0], up: [0, 1, 0],
        radius: 20, radiusMax: 20, fog: 50, clipFar: true, minNear: 5, minFar: 0 },
      inspection: { appearance: { representation: 'cartoon', color: 'chain-id', uniformColor: '#58dcc9', background: '#071015',
        opacity: 1, labels: false, highlightColor: '#f2c47c', clipping: 0, fog: 0 },
        placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } } };
    const binding = { sessionId, serverEpoch: data.serverEpoch, sourceToken: data.sourceToken,
      baseStateRevision: data.stateRevision, baseInspectionRevision: data.inspectionRevision };
    const sync = ok(await call('sync_inspection', { ...binding, scene })).structuredContent;
    binding.baseStateRevision = sync.stateRevision; binding.baseInspectionRevision = sync.inspectionRevision;
    const panelId = ok(await call('attach_inspection', { ...binding, surface: 'companion' })).structuredContent.panelId;
    await call('poll_inspection', { ...binding, panelId, availability: 'ready' });
    const lifecycle = async (action: string, commandId: string) => ok(await call('update_inspection', {
      ...binding, panelId, commandId, change: { kind: 'utterance', patch: { action } } }));
    return { call, ok, scene, binding, panelId, fetching, release, lifecycle,
      close: async () => { release(); await client.close(); await server.close(); } };
  }
type Fixture=Awaited<ReturnType<typeof setup>>;
async function begin(t:Fixture,id='begin') {
  return (await t.lifecycle('begin',id)).structuredContent.lifecycle.utterance.utteranceId as string;
}
async function edit(t:Fixture,utteranceId:string,commandId:string,opacity:number) {
  return t.call('update_inspection',{...t.binding,panelId:t.panelId,utteranceId,commandId,
    change:{kind:'appearance',patch:{opacity}}});
}
async function render(t:Fixture,opacity:number) {
  const d=t.ok(await t.call('poll_inspection',{...t.binding,panelId:t.panelId,availability:'ready'}))._meta[key].delivery;
  const scene=structuredClone(t.scene);scene.inspection.appearance.opacity=opacity;
  const result=t.ok(await t.call('complete_inspection',{...t.binding,panelId:t.panelId,commandId:d.commandId,claimToken:d.claimToken,scene})).structuredContent;
  expect(result.command.status).toBe('rendered');
  t.binding.baseStateRevision=result.stateRevision;t.binding.baseInspectionRevision=result.inspectionRevision;
  t.scene=scene;
  return result;
}
async function reattach(t:Fixture,replacesPanelId=t.panelId) {
  const data=t.ok(await t.call('get_inspection',{sessionId:t.binding.sessionId}))._meta[key];
  Object.assign(t.binding,{sourceToken:data.sourceToken,baseStateRevision:data.stateRevision,baseInspectionRevision:data.inspectionRevision});
  const saved=t.ok(await t.call('sync_inspection',{...t.binding,scene:t.scene})).structuredContent;
  t.binding.baseInspectionRevision=saved.inspectionRevision;
  return t.ok(await t.call('attach_inspection',{...t.binding,surface:'companion',replacesPanelId})).structuredContent.panelId as string;
}

describe('request ownership across asynchronous sources and rendered edits',()=>{
  it('retains named views and verified comparison assets across source changes within one live session',async()=>{
    const t=await setup(async id=>id==='4HHB'?cif+'\n# A distinct source digest\n':cif);
    const initial=structuredClone(t.scene);
    const finish=async()=>{
      const d=t.ok(await t.call('poll_inspection',{...t.binding,panelId:t.panelId,availability:'ready'}))._meta[key].delivery;
      const scene=d.change.kind==='save-view'?t.scene:d.change.kind==='restore-view'?d.change.patch.scene
        :expectedInspection(t.scene as any,d.change);
      const completed=t.ok(await t.call('complete_inspection',{...t.binding,panelId:t.panelId,
        commandId:d.commandId,claimToken:d.claimToken,scene})).structuredContent;
      expect(completed.command.status).toBe('rendered');
      t.binding.baseStateRevision=completed.stateRevision;t.binding.baseInspectionRevision=completed.inspectionRevision;t.scene=scene;
      return completed;
    };
    const replace=async(pdbId:string)=>{
      const oldPanel=t.panelId;
      t.ok(await t.call('replace_inspection_source',{...t.binding,panelId:oldPanel,pdbId}));
      const fresh=t.ok(await t.call('get_inspection',{sessionId:t.binding.sessionId}))._meta[key];
      t.scene={...structuredClone(initial),sourceSha256:fresh.catalog.source.sha256,selectionKeys:[fresh.catalog.rows[0].key]};
      t.panelId=await reattach(t,oldPanel);
    };
    try {
      t.ok(await t.call('replace_inspection_source',{...t.binding,panelId:t.panelId,mode:'compare',pdbId:'2HHB',commandId:'pair'}));
      await finish();const pair=structuredClone(t.scene);
      t.ok(await t.call('manage_inspection_view',{...t.binding,panelId:t.panelId,action:'save',name:'Remembered pair',commandId:'save-pair'}));
      await finish();
      const listed=()=>t.call('manage_inspection_view',{sessionId:t.binding.sessionId,action:'list'});
      const view=(await listed()).structuredContent.namedViews.entries[0];
      await replace('4HHB');
      expect((await listed()).structuredContent.namedViews.entries).toContainEqual(view);
      const foreign=await t.call('manage_inspection_view',{...t.binding,panelId:t.panelId,action:'restore',viewId:view.id,commandId:'foreign'});
      expect(foreign.isError).toBe(true);
      expect(foreign.content[0].text).toMatch(/source|structure/i);
      await replace('2HHB');
      t.ok(await t.call('manage_inspection_view',{...t.binding,panelId:t.panelId,action:'restore',viewId:view.id,commandId:'return-pair'}));
      await finish();expect(t.scene.inspection).toEqual(pair.inspection);
      const other=t.ok(await t.call('inspect',{structureText:cif})).structuredContent.sessionId;
      expect(t.ok(await t.call('get_inspection_state',{sessionId:other})).structuredContent.namedViews.entries).toEqual([]);
    } finally {await t.close();}
  });
  for(const mode of ['replace','compare']) for(const action of ['cancel','correct','same-id-cancel']) {
    it(`${mode}: ${action} aborts a pending resolver and prevents its late result`,async()=>{
      let release!:()=>void,entered!:()=>void,signal:AbortSignal|undefined;
      const gate=new Promise<void>(r=>{release=r;}),fetching=new Promise<void>(r=>{entered=r;});
      let calls=0;
      const t=await setup(async(_id,s)=>{if(++calls===1){signal=s;entered();await gate;}return cif;});
      try {
        const utteranceId=await begin(t);
        const old=t.call('replace_inspection_source',{...t.binding,panelId:t.panelId,utteranceId,commandId:'old',mode,pdbId:'2HHB'});
        await fetching;
        const control={...t.binding,panelId:t.panelId,commandId:'control',
          ...(action==='same-id-cancel'?{utteranceId}:{}),change:{kind:'utterance',patch:{action:action==='correct'?'correct':'cancel'}}};
        const cancelled=t.ok(await t.call('update_inspection',control));
        expect(cancelled.structuredContent.lifecycle.sourceOperations[0]).toMatchObject({commandId:'old',status:'cancelled'});
        expect(signal?.aborted).toBe(true);
        // Deliberately do not release the custom resolver: cancellation settles promptly even if it ignores abort.
        expect((await old).isError).toBe(true);
        expect(await t.call('update_inspection',control)).toEqual(cancelled);
        const next=await begin(t,'next');
        const replacement=t.ok(await t.call('replace_inspection_source',{...t.binding,panelId:t.panelId,utteranceId:next,commandId:'new',mode,pdbId:'4HHB'}));
        const before=t.ok(await t.call('get_inspection_state',{sessionId:t.binding.sessionId})).structuredContent;
        release();await new Promise(r=>setImmediate(r));
        const after=t.ok(await t.call('get_inspection_state',{sessionId:t.binding.sessionId})).structuredContent;
        expect(after.sourceToken).toBe(before.sourceToken);
        expect(after.pendingCommand).toEqual(before.pendingCommand);
        if(mode==='compare') expect(replacement.structuredContent.command.status).toBe('queued');
        else expect(replacement.structuredContent.sourceTransition.sourceChanged).toBe(true);
      } finally {release();await t.close();}
    });
  }
  for(const mode of ['replace','compare']) it(`${mode}: an unbound fetch is also cancelled`,async()=>{
    const t=await setup();try {
      const old=t.call('replace_inspection_source',{...t.binding,panelId:t.panelId,mode,pdbId:'2HHB'});
      await t.fetching;await t.lifecycle('cancel','stop');
      expect((await old).isError).toBe(true);
      t.release();
      const state=t.ok(await t.call('get_inspection_state',{sessionId:t.binding.sessionId})).structuredContent;
      expect(state.sourceToken).toBe(t.binding.sourceToken);expect(state.pendingCommand).toEqual([]);
    } finally {await t.close();}
  });
  it('continues after its own rendered edits, while a manual save still invalidates that utterance',async()=>{
    const t=await setup();try {
      const u=await begin(t);
      t.ok(await edit(t,u,'one',0.5));await render(t,0.5);
      t.ok(await edit(t,u,'two',0.7));await render(t,0.7);
      const manual=structuredClone(t.scene);manual.inspection.appearance.opacity=0.9;
      const saved=t.ok(await t.call('sync_inspection',{...t.binding,scene:manual})).structuredContent;
      t.binding.baseInspectionRevision=saved.inspectionRevision;
      const late=await edit(t,u,'three',0.2);
      expect(late.isError).toBe(true);expect(late.content[0].text).toContain('changed since this utterance');
    } finally {await t.close();}
  });
  for(const mode of ['replace','compare']) it(`${mode}: manual work during fetching remains authoritative`,async()=>{
    const t=await setup();try {
      const u=await begin(t);
      const pending=t.call('replace_inspection_source',{...t.binding,panelId:t.panelId,utteranceId:u,mode,pdbId:'2HHB'});
      await t.fetching;
      const manual=structuredClone(t.scene);manual.inspection.appearance.opacity=0.8;
      t.ok(await t.call('sync_inspection',{...t.binding,scene:manual}));t.release();
      expect((await pending).isError).toBe(true);
      const state=t.ok(await t.call('get_inspection_state',{sessionId:t.binding.sessionId})).structuredContent;
      expect(state.sourceToken).toBe(t.binding.sourceToken);expect(state.view.appearance.opacity).toBe(0.8);
    } finally {await t.close();}
  });
  for(const mode of ['replace','compare']) it(`${mode}: a failed correction cannot revive cancelled source work`,async()=>{
    let release!:()=>void,entered!:()=>void,calls=0;
    const gate=new Promise<void>(r=>{release=r;}),fetching=new Promise<void>(r=>{entered=r;});
    const t=await setup(async()=>{if(++calls===1){entered();await gate;return cif;}throw Error('New source missing');});
    try {
      const u=await begin(t);
      const old=t.call('replace_inspection_source',{...t.binding,panelId:t.panelId,utteranceId:u,mode,pdbId:'2HHB'});
      await fetching;const control=await t.lifecycle('correct','correction');
      expect((await old).isError).toBe(true);
      const next=control.structuredContent.lifecycle.utterance.utteranceId;
      expect((await t.call('replace_inspection_source',{...t.binding,panelId:t.panelId,utteranceId:next,mode,pdbId:'4HHB'})).isError).toBe(true);
      release();await new Promise(r=>setImmediate(r));
      const state=t.ok(await t.call('get_inspection_state',{sessionId:t.binding.sessionId})).structuredContent;
      expect(state.sourceToken).toBe(t.binding.sourceToken);expect(state.pendingCommand).toEqual([]);
    } finally {release();await t.close();}
  });
  it('continues on the matching replacement panel only after the new source is saved and attached',async()=>{
    const t=await setup(async()=>cif);try {
      const u=await begin(t),oldPanel=t.panelId;
      t.ok(await t.call('replace_inspection_source',{...t.binding,panelId:t.panelId,utteranceId:u,pdbId:'2HHB'}));
      const wrong=await reattach(t,'11111111-1111-4111-8111-111111111111');
      expect((await t.call('update_inspection',{...t.binding,panelId:wrong,utteranceId:u,commandId:'wrong',change:{kind:'appearance',patch:{opacity:0.5}}})).isError).toBe(true);
      t.panelId=await reattach(t,oldPanel);
      t.ok(await edit(t,u,'right',0.5));await render(t,0.5);
      const duplicate=await reattach(t,oldPanel);
      expect((await t.call('update_inspection',{...t.binding,panelId:duplicate,utteranceId:u,commandId:'duplicate',change:{kind:'appearance',patch:{opacity:0.6}}})).isError).toBe(true);
      t.ok(await edit(t,u,'still-right',0.7));
    } finally {await t.close();}
  });
  for(const disturbance of ['manual','cancel']) it(`${disturbance} between source commit and attach prevents continuation`,async()=>{
    const t=await setup(async()=>cif);try {
      const u=await begin(t),oldPanel=t.panelId;
      t.ok(await t.call('replace_inspection_source',{...t.binding,panelId:t.panelId,utteranceId:u,pdbId:'2HHB'}));
      const wrong=await reattach(t,'11111111-1111-4111-8111-111111111111');
      if(disturbance==='manual') {
        const scene=structuredClone(t.scene);scene.inspection.appearance.opacity=0.8;
        const saved=t.ok(await t.call('sync_inspection',{...t.binding,scene})).structuredContent;
        t.binding.baseInspectionRevision=saved.inspectionRevision;t.scene=scene;
      } else {
        t.ok(await t.call('update_inspection',{...t.binding,panelId:wrong,commandId:'stop',change:{kind:'utterance',patch:{action:'cancel'}}}));
      }
      t.panelId=await reattach(t,oldPanel);
      expect((await edit(t,u,'late',0.5)).isError).toBe(true);
    } finally {await t.close();}
  });
  for(const bindingKind of ['captured','current']) for(const action of ['cancel','correct']) {
    it(`${bindingKind} binding: ${action} owns the handoff while its renderer is detached`,async()=>{
      const t=await setup(async()=>cif);try {
        const u=await begin(t),oldPanel=t.panelId;
        t.ok(await t.call('replace_inspection_source',{...t.binding,panelId:oldPanel,utteranceId:u,pdbId:'2HHB'}));
        t.ok(await t.call('detach_inspection',{...t.binding,panelId:oldPanel}));
        const state=t.ok(await t.call('get_inspection_state',{sessionId:t.binding.sessionId})).structuredContent;
        const controlBinding=bindingKind==='captured'?t.binding:{...t.binding,sourceToken:state.sourceToken,
          baseStateRevision:state.stateRevision,baseInspectionRevision:state.inspectionRevision};
        const control={...controlBinding,panelId:oldPanel,commandId:'handoff-control',
          ...(action==='cancel'?{utteranceId:u}:{}),change:{kind:'utterance',patch:{action}}};
        const wrong=await t.call('update_inspection',{...control,panelId:'11111111-1111-4111-8111-111111111111',commandId:'wrong-control'});
        expect(wrong.isError).toBe(true);
        for(const mismatch of [{sourceToken:'11111111-1111-4111-8111-111111111111'},
          {serverEpoch:'11111111-1111-4111-8111-111111111111'},{baseStateRevision:99},{baseInspectionRevision:99}])
          expect((await t.call('update_inspection',{...control,...mismatch,commandId:'stale-control'})).isError).toBe(true);
        expect((await edit(t,u,'stale-edit',0.2)).isError).toBe(true);
        const accepted=t.ok(await t.call('update_inspection',control));
        expect((await t.call('get_inspection_state',{sessionId:t.binding.sessionId})).structuredContent.sourceToken).toBe(state.sourceToken);
        expect(await t.call('update_inspection',control)).toEqual(accepted);
        t.panelId=await reattach(t,oldPanel);
        expect((await edit(t,u,'old-late',0.2)).isError).toBe(true);
        if(action==='correct') {
          const next=accepted.structuredContent.lifecycle.utterance.utteranceId;
          t.ok(await edit(t,next,'corrected-edit',0.7));await render(t,0.7);
        }
      } finally {await t.close();}
    });
  }
  it('an old correction retry cannot replace a newer handoff owner',async()=>{
    const t=await setup(async()=>cif);try {
      const u=await begin(t),oldPanel=t.panelId;
      t.ok(await t.call('replace_inspection_source',{...t.binding,panelId:oldPanel,utteranceId:u,pdbId:'2HHB'}));
      const control={...t.binding,panelId:oldPanel,commandId:'first-correction',change:{kind:'utterance',patch:{action:'correct'}}};
      const first=t.ok(await t.call('update_inspection',control));
      const second=t.ok(await t.call('update_inspection',{...control,commandId:'second-correction'}));
      expect(await t.call('update_inspection',control)).toEqual(first);
      t.panelId=await reattach(t,oldPanel);
      expect((await edit(t,first.structuredContent.lifecycle.utterance.utteranceId,'older-edit',0.2)).isError).toBe(true);
      t.ok(await edit(t,second.structuredContent.lifecycle.utterance.utteranceId,'latest-edit',0.7));
      expect((await t.call('update_inspection',{...control,commandId:'late-stale-control'})).isError).toBe(true);
    } finally {await t.close();}
  });
});
