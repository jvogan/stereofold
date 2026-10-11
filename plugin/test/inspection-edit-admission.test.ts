import vm from 'node:vm';
import { transformSync } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe,it,expect } from 'vitest';
import { createStereoStructureServer } from '../src/server.js';
import { PRIVATE_INSPECTION_META_KEY as KEY, expectedInspection } from '../src/inspection-contract.js';
import { InspectionEditAdmission } from '../src/inspection-edit-admission.js';
const cif=await readFile(new URL('../../fixtures/1CRN.cif',import.meta.url),'utf8');
async function setup() {
  const server=createStereoStructureServer(undefined,{replyAudio:{synthesize:async()=>undefined} as any});
  const client=new Client({name:'Queued edit regression',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
  await server.connect(b);await client.connect(a);
  const call=(name:string,args:any,options?:{signal?:AbortSignal})=>client.callTool({name:'stereo_structure.'+name,arguments:args},undefined,options) as Promise<any>;
  const sessionId=(await call('inspect',{structureText:cif})).structuredContent.sessionId;
  const data=(await call('get_inspection',{sessionId}))._meta[KEY];
  let scene:any={sourceSha256:data.catalog.source.sha256,modelNumber:data.catalog.modelNumbers[0],assemblyId:data.catalog.assemblyId,
    selectionKeys:[],camera:{mode:'perspective',fov:Math.PI/4,position:[0,0,80],target:[0,0,0],up:[0,1,0],radius:20,radiusMax:20,fog:50,clipFar:true,minNear:5,minFar:0},
    inspection:{appearance:{representation:'cartoon',color:'chain-id',uniformColor:'#58dcc9',background:'#071015',opacity:1,labels:false,highlightColor:'#f2c47c',clipping:0,fog:0},placement:{translation:[0,0,0],rotation:[0,0,0],scale:1}}};
  let binding={sessionId,serverEpoch:data.serverEpoch,sourceToken:data.sourceToken,baseStateRevision:data.stateRevision,baseInspectionRevision:data.inspectionRevision};
  const saved=(await call('sync_inspection',{...binding,scene})).structuredContent;
  binding={...binding,baseInspectionRevision:saved.inspectionRevision};
  const panelId=(await call('attach_inspection',{...binding,surface:'desktop'})).structuredContent.panelId;
  const rebind=async()=>{
    const state=(await call('get_inspection_state',{sessionId})).structuredContent;
    binding={...binding,sourceToken:state.sourceToken,baseStateRevision:state.stateRevision,baseInspectionRevision:state.inspectionRevision};
  };
  const claim=async()=>{
    for(let i=0;i<200;i++) {
      await rebind();
      const result=await call('poll_inspection',{...binding,panelId,availability:'ready'});
      const delivery=result._meta?.[KEY]?.delivery;if(delivery)return delivery;
      await new Promise(resolve=>setTimeout(resolve,5));
    }
    throw Error('No queued edit reached the panel');
  };
  const finish=async(delivery:any,failure?:string)=>{
    const painted=expectedInspection(scene,delivery.change);
    const answer=await call('complete_inspection',{...binding,panelId,commandId:delivery.commandId,claimToken:delivery.claimToken,...(failure?{failure}:{scene:painted})});
    if(!failure && answer.structuredContent?.command.status==='rendered')scene=painted;
    await rebind();return answer;
  };
  return {call,sessionId,panelId,claim,finish,rebind,binding:()=>({...binding}),scene:()=>scene,
    edit:(commandId:string,patch:any,extra:any={})=>call('update_inspection',{sessionId,commandId,change:{kind:'appearance',patch},...extra}),
    close:async()=>{await client.close();await server.close();}};
}

describe('ordinary agent edit admission',()=>{
  it('serializes three omitted-binding edits and preserves all changes, including immediate receipts',async()=>{
    const t=await setup();try {
      const initial=t.binding().baseInspectionRevision;
      const answers=[t.edit('q-color',{color:'uniform',uniformColor:'#ff1122'}),t.edit('q-opacity',{opacity:.6}),t.edit('q-labels',{labels:true})];
      for(const id of ['q-color','q-opacity','q-labels']) {
        const delivery=await t.claim();expect(delivery.commandId).toBe(id);
        expect((await t.finish(delivery)).structuredContent.command.status).toBe('rendered');
      }
      for(const answer of await Promise.all(answers))expect(answer.isError,JSON.stringify(answer.content)).not.toBe(true);
      expect(t.scene().inspection.appearance).toMatchObject({uniformColor:'#ff1122',opacity:.6,labels:true});
      expect(t.binding().baseInspectionRevision).toBe(initial+3);
      const retry=await t.edit('q-opacity',{opacity:.6});expect(retry.structuredContent.commandReplay).toBeDefined();
      expect(t.binding().baseInspectionRevision).toBe(initial+3);
    } finally {await t.close();}
  });
  it('releases a renderer failure so the following edit draws',async()=>{
    const t=await setup();try {
      const first=t.edit('q-fail',{opacity:.3}),next=t.edit('q-after',{labels:true});
      const d=await t.claim();expect(d.commandId).toBe('q-fail');
      expect((await t.finish(d,'render_failed')).structuredContent.command.status).toBe('rejected');
      const after=await t.claim();expect(after.commandId).toBe('q-after');await t.finish(after);
      expect((await first).isError).not.toBe(true);expect((await next).isError).not.toBe(true);
      expect(t.scene().inspection.appearance).toMatchObject({opacity:1,labels:true});
    } finally {await t.close();}
  });
  it('recovers after a pre-admission validation failure',async()=>{
    const t=await setup();try {
      const invalid=t.call('focus_selection',{sessionId:t.sessionId,commandId:'empty-focus'});
      const valid=t.edit('after-empty-focus',{opacity:.7});
      expect((await invalid).isError).toBe(true);
      const d=await t.claim();expect(d.commandId).toBe('after-empty-focus');await t.finish(d);
      expect((await valid).isError).not.toBe(true);
    } finally {await t.close();}
  });
  it('drops an MCP-cancelled waiting edit without disrupting its successor',async()=>{
    const t=await setup();try {
      await t.edit('before-cancel',{opacity:.4});
      const controller=new AbortController();
      const cancelled=t.call('update_inspection',{sessionId:t.sessionId,commandId:'cancelled-edit',change:{kind:'appearance',patch:{labels:true}}},{signal:controller.signal});
      // Let the request reach the server while the first command owns the lane.
      await new Promise(resolve=>setTimeout(resolve,5));
      controller.abort(Error('cancel requested'));
      await expect(cancelled).rejects.toThrow('cancel requested');
      const after=t.edit('after-cancel',{uniformColor:'#aabbcc'});
      const first=await t.claim();expect(first.commandId).toBe('before-cancel');await t.finish(first);
      const next=await t.claim();expect(next.commandId).toBe('after-cancel');await t.finish(next);
      expect((await after).isError).not.toBe(true);
      expect(t.scene().inspection.appearance).toMatchObject({opacity:.4,labels:false,uniformColor:'#aabbcc'});
    } finally {await t.close();}
  });
  it('does not rebind an explicitly stale revision',async()=>{
    const t=await setup();try {
      const stale=t.binding();await t.edit('q-first',{opacity:.4});await t.finish(await t.claim());
      const answer=await t.edit('q-stale',{labels:true},{...stale,panelId:t.panelId});
      expect(answer.isError).toBe(true);expect(t.scene().inspection.appearance.labels).toBe(false);
    } finally {await t.close();}
  });
  it('refuses waiting edits after manual work supersedes the predecessor',async()=>{
    const t=await setup();try {
      const first=t.edit('q-before-manual',{opacity:.3}),next=t.edit('q-after-manual',{labels:true});
      await t.claim();
      const manual=structuredClone(t.scene());manual.inspection.appearance.uniformColor='#abcdef';
      expect((await t.call('sync_inspection',{...t.binding(),scene:manual})).structuredContent.saved).toBe(true);
      const answer=await next;expect(answer.isError).toBe(true);expect(answer.content[0].text).toContain('outside the queued edits');
      await first;
      const state=(await t.call('get_inspection_state',{sessionId:t.sessionId})).structuredContent;
      expect(state.inspectionRevision).toBe(t.binding().baseInspectionRevision+1);
    } finally {await t.close();}
  });
});

describe('bounded admission lifecycle',()=>{
  const fence={serverEpoch:'epoch',sourceToken:'source',stateRevision:1,inspectionRevision:1};
  it('bounds a stalled predecessor, cancels waiters on close and releases capacity',async()=>{
    const queue=new InspectionEditAdmission(20,2);
    const first=queue.enqueue('a',async(_p,publish)=>{publish('queued');return new Promise(()=>{});});
    expect(await first).toBe('queued');
    const second=queue.enqueue('a',async()=>{throw Error('must not run');});
    const refused=queue.enqueue('a',async()=>fence);await expect(refused).rejects.toThrow('Too many');
    await expect(second).rejects.toThrow('did not settle');
    expect(await queue.enqueue('a',async(_p,publish)=>{publish('recovered');return fence;})).toBe('recovered');
    queue.close();await expect(queue.enqueue('b',async()=>fence)).rejects.toThrow('closed');
  });
  it('keeps a cancelled middle slot linked to its live predecessor',async()=>{
    const queue=new InspectionEditAdmission(1000),controller=new AbortController();let finish!:(v:typeof fence)=>void,ran=false;
    await queue.enqueue('a',async(_p,publish)=>{publish('queued');return new Promise(resolve=>{finish=resolve;});});
    const cancelled=queue.enqueue('a',async()=>{throw Error('cancelled edit ran');},controller.signal);
    controller.abort(Error('cancelled'));await expect(cancelled).rejects.toThrow('cancelled');
    const next=queue.enqueue('a',async(previous,publish)=>{ran=true;expect(previous).toEqual(fence);publish('next');return fence;});
    await new Promise(resolve=>setTimeout(resolve,5));expect(ran).toBe(false);
    finish(fence);expect(await next).toBe('next');queue.close();
  });
  it('rejects an already-aborted request without starting it',async()=>{
    const queue=new InspectionEditAdmission(),controller=new AbortController();controller.abort(Error('already cancelled'));let ran=false;
    await expect(queue.enqueue('a',async()=>{ran=true;return fence;},controller.signal)).rejects.toThrow('already cancelled');
    expect(ran).toBe(false);queue.close();
  });
  it('a cancelled waiting request never executes and close wakes other waiters',async()=>{
    const queue=new InspectionEditAdmission(1000),controller=new AbortController();let ran=false;
    await queue.enqueue('a',async(_p,publish)=>{publish('queued');return new Promise(()=>{});});
    const cancelled=queue.enqueue('a',async()=>{ran=true;return fence;},controller.signal);
    controller.abort(Error('cancelled'));await expect(cancelled).rejects.toThrow('cancelled');expect(ran).toBe(false);
    const closed=queue.enqueue('other',async()=>new Promise(()=>{}));queue.close();await expect(closed).rejects.toThrow('closed');
  });
});

// Execute the actual async history helpers across their current() await. This
// catches losing the private cancellation symbol while constructing a request.
describe('history admission cancellation after async binding reads',()=>{
  it.each(['Undo','Redo'])('stops queue%s before any history claim or admission',async(action)=>{
    const source=await readFile(new URL('../src/inspection-server.ts',import.meta.url),'utf8');
    const from=source.indexOf('  async function queue'+action+'(');
    const to=source.indexOf('\n  }',from)+4;
    const compiled=transformSync(source.slice(from,to),{loader:'ts',target:'es2022'}).code;
    let resolveCurrent!:(v:any)=>void;const touched:string[]=[],editAdmissionSignal=Symbol(),controller=new AbortController();
    const data={attachment:{scene:{},commands:{hasPending:()=>false,enqueue:()=>{touched.push('enqueue');return {}; }},
      history:{last:()=>({}),lastRedo:()=>({}),claimUndo:()=>touched.push('claim'),claimRedo:()=>touched.push('claim'),settleUndo(){},settleRedo(){}}}};
    const context=vm.createContext({editAdmissionSignal,current:()=>new Promise(resolve=>{resolveCurrent=resolve;}),binding:()=>({}),
      releaseFinishedHistoryClaims:()=>touched.push('release'),undoChangeFor:()=>({}),redoChangeFor:()=>({}),
      expectedInspection:()=>({}),validateScene(){},keepLive:()=>undefined,NOTHING_TO_UNDO:'nothing',UNDO_CONFIRMATION:'undo'});
    const run=vm.runInContext(compiled+';queue'+action,context);
    const pending=run({sessionId:'s',commandId:'c',[editAdmissionSignal]:controller.signal});
    controller.abort(Error('cancelled during current'));resolveCurrent(data);
    await expect(pending).rejects.toThrow('cancelled during current');expect(touched).toEqual([]);
    // The same real helper still admits normally when its caller remains live.
    const normal=run({sessionId:'s',commandId:'d'});resolveCurrent(data);await normal;
    expect(touched).toContain('enqueue');expect(touched).toContain('claim');
  });
});
