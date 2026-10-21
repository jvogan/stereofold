import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, it } from 'vitest';
import { createStereoStructureServer } from '../src/server.js';
import { decodeInspectionCatalog } from '../src/inspection-catalog-codec.js';
import { expectedInspection } from '../src/inspection-contract.js';

const KEY='stereo_structure/inspection';
const crn=await readFile(new URL('../../fixtures/1CRN.cif',import.meta.url),'utf8');
const hhb=await readFile(new URL('../../fixtures/4HHB.cif',import.meta.url),'utf8');
const playback={id:'custom-motion',chapterId:'move',state:'paused',timeSeconds:0,durationSeconds:2,loop:false,speed:1};
const appearance={representation:'cartoon',color:'chain-id',uniformColor:'#58dcc9',background:'#071015',opacity:1,labels:false,highlightColor:'#f2c47c',clipping:0,fog:0};
const targets=[{authorChain:'A',authorResidue:1,atomName:'CA'},{authorChain:'B',authorResidue:1,atomName:'CA'}];
async function setup() {
  const [a,b]=InMemoryTransport.createLinkedPair();
  const server=createStereoStructureServer(),client=new Client({name:'measurement source identity',version:'1'});
  await server.connect(b);await client.connect(a);
  const call=(name:string,args:any)=>client.callTool({name:`stereo_structure.${name}`,arguments:args}) as Promise<any>;
  const ok=(answer:any)=>{expect(answer.isError,JSON.stringify(answer.content)).not.toBe(true);return answer;};
  const sessionId=ok(await call('inspect',{structureText:crn})).structuredContent.sessionId;
  const read=async()=>{
    const data=ok(await call('get_inspection',{sessionId}))._meta[KEY];
    const catalog=data.catalog??await decodeInspectionCatalog(data.catalogWire);
    return {data,catalog};
  };
  const makeScene=(catalog:any)=>({sourceSha256:catalog.source.sha256,modelNumber:catalog.modelNumbers[0],assemblyId:catalog.assemblyId,selectionKeys:[],
    camera:{mode:'perspective',fov:Math.PI/4,position:[0,0,80],target:[0,0,0],up:[0,1,0],radius:20,radiusMax:20,fog:50,clipFar:true,minNear:5,minFar:0},
    inspection:{appearance,placement:{translation:[0,0,0],rotation:[0,0,0],scale:1},animation:{playback,definition:{version:1,durationSeconds:2,tracks:[
      {id:'moving-A',chains:['A'],keyframes:[{t:0,rotation:[0,0,0,1],translation:[0,0,0]},{t:2,rotation:[0,0,0,1],translation:[10,0,0]}]},
    ]}}}});
  const opened=await read();
  const live:any={sessionId,serverEpoch:opened.data.serverEpoch,sourceToken:opened.data.sourceToken,baseStateRevision:opened.data.stateRevision,baseInspectionRevision:opened.data.inspectionRevision};
  const save=async(catalog:any)=>{
    const saved=ok(await call('sync_inspection',{...live,scene:makeScene(catalog)})).structuredContent;
    live.baseStateRevision=saved.stateRevision;live.baseInspectionRevision=saved.inspectionRevision;
  };
  await save(opened.catalog);
  const staleBinding={...live};
  const desktop=ok(await call('attach_inspection',{...live,surface:'desktop'})).structuredContent.panelId;
  const companion=ok(await call('attach_inspection',{...live,surface:'companion'})).structuredContent.panelId;
  await call('poll_inspection',{...live,panelId:desktop,availability:'ready',animation:{...playback,timeSeconds:2}});
  await call('poll_inspection',{...live,panelId:companion,availability:'ready',animation:playback});
  ok(await call('replace_inspection_source',{...live,panelId:companion,commandId:'local-replace',source:{kind:'pasted',text:hhb,format:'mmcif'}}));
  const next=await read();
  Object.assign(live,{sourceToken:next.data.sourceToken,baseStateRevision:next.data.stateRevision,baseInspectionRevision:next.data.inspectionRevision});
  expect(live.sourceToken).not.toBe(staleBinding.sourceToken);
  expect(next.catalog.source.sha256).not.toBe(opened.catalog.source.sha256);
  await save(next.catalog);
  const current=ok(await call('attach_inspection',{...live,surface:'companion',replacesPanelId:companion})).structuredContent.panelId;
  await call('poll_inspection',{...live,panelId:current,availability:'ready',animation:playback});
  return {call,ok,sessionId,live,staleBinding,desktop,current,close:async()=>{await client.close();await server.close();}};
}
it('does not silently measure a replaced source when the caller supplies its old source binding',async()=>{
  const t=await setup();try {
    t.ok(await t.call('measure',{sessionId:t.sessionId,targets}));
    const stale=await t.call('measure',{...t.staleBinding,targets});
    expect(stale.isError,'Explicit old-source binding must not be ignored by a scientific read').toBe(true);
  }finally{await t.close();}
});
it('does not apply an old-source panel clock to the new source with reused custom chapter IDs',async()=>{
  const t=await setup();try {
    const state=t.ok(await t.call('get_inspection_state',{sessionId:t.sessionId})).structuredContent;
    expect(state.panels.find((panel:any)=>panel.panelId===t.desktop)).toMatchObject({current:false});
    const current=t.ok(await t.call('measure',{sessionId:t.sessionId,panelId:t.current,targets})).structuredContent.measurement;
    expect(current.animation.timeSeconds).toBe(0);
    const stale=await t.call('measure',{sessionId:t.sessionId,panelId:t.desktop,targets});
    expect(stale.isError,JSON.stringify({currentDistance:current.distanceAngstrom,staleDistance:stale.structuredContent?.measurement?.distanceAngstrom,staleTime:stale.structuredContent?.measurement?.animation?.timeSeconds})).toBe(true);
  }finally{await t.close();}
});

it.each(['serverEpoch','sourceToken','baseStateRevision','baseInspectionRevision'] as const)('honors an explicit %s while permitting omitted binding fields',async field=>{
  const t=await setup();try {
    const valid=t.ok(await t.call('measure',{...t.live,panelId:t.current,targets})).structuredContent;
    expect(valid.measurement.ok).toBe(true);
    const wrong=typeof t.live[field]==='string'?t.live[field]+'-stale':t.live[field]+1;
    expect((await t.call('measure',{sessionId:t.sessionId,[field]:wrong,targets})).isError).toBe(true);
    const after=t.ok(await t.call('measure',{sessionId:t.sessionId,targets})).structuredContent;
    expect(after.measurement.distanceAngstrom).toBe(valid.measurement.distanceAngstrom);
    expect(after.inspectionRevision).toBe(valid.inspectionRevision);
    expect(after.stateRevision).toBe(valid.stateRevision);
  }finally{await t.close();}
});
it('retains saved-scene measurements after all panels detach and refuses an explicitly missing panel',async()=>{
  const t=await setup();try {
    t.ok(await t.call('detach_inspection',{...t.live,panelId:t.current}));
    const staleOnly=t.ok(await t.call('measure',{sessionId:t.sessionId,targets})).structuredContent.measurement;
    expect(staleOnly.animation).toMatchObject({timeSeconds:0,sample:'saved animation time; no host extrapolation'});
    t.ok(await t.call('detach_inspection',{...t.staleBinding,panelId:t.desktop}));
    const saved=t.ok(await t.call('measure',{sessionId:t.sessionId,targets})).structuredContent.measurement;
    expect(saved.animation).toMatchObject({timeSeconds:0,sample:'saved animation time; no host extrapolation'});
    expect((await t.call('measure',{sessionId:t.sessionId,panelId:t.current,targets})).isError).toBe(true);
  }finally{await t.close();}
});

it('replays an exact annotation receipt after its own revision changes without doing a new measurement',async()=>{
  const t=await setup();try {
    const request={...t.live,panelId:t.current,targets,annotate:true,measurementId:'custom-pair',commandId:'repeat-annotation'};
    const queued=t.ok(await t.call('measure',request)).structuredContent;
    expect(queued.command.status).toBe('queued');
    const saved=t.ok(await t.call('get_inspection',{sessionId:t.sessionId}))._meta[KEY].scene;
    const delivery=t.ok(await t.call('poll_inspection',{...t.live,panelId:t.current,availability:'ready'}))._meta[KEY].delivery;
    expect(delivery.commandId).toBe(request.commandId);
    const receipt=t.ok(await t.call('complete_inspection',{...t.live,panelId:t.current,commandId:delivery.commandId,claimToken:delivery.claimToken,
      scene:expectedInspection(saved,delivery.change)})).structuredContent;
    t.live.baseStateRevision=receipt.stateRevision;t.live.baseInspectionRevision=receipt.inspectionRevision;
    expect(t.live.baseInspectionRevision).toBeGreaterThan(request.baseInspectionRevision);
    t.ok(await t.call('detach_inspection',{...t.live,panelId:t.current}));
    const repeated=t.ok(await t.call('measure',request)).structuredContent;
    expect(repeated).toMatchObject({measurementId:'custom-pair',commandId:'repeat-annotation',command:{status:'rendered'}});
    expect(repeated.measurement).toBeUndefined();
    expect(repeated.inspectionRevision).toBe(receipt.inspectionRevision);
    expect((await t.call('measure',{...request,targets:[targets[1],targets[0]]})).isError).toBe(true);
  }finally{await t.close();}
});
