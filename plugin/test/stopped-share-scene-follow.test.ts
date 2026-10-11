import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, it, vi } from 'vitest';
import { createStereoStructureServer } from '../src/server.js';
import { expectedInspection, PRIVATE_INSPECTION_META_KEY as KEY } from '../src/inspection-contract.js';
import { createReplyAudioSynthesizer } from '../src/headset-reply-audio.js';
import { inMemoryCompanionNetwork } from './fixtures/in-memory-companion-network.js';

// Keep real listener/management handlers and scene commits. Only socket and
// certificate boundaries are replaced; no device store or host settings change.
vi.mock('../src/inspection-lan.js',async original=>{
  const module=await original<any>();
  return {...module,LanCompanion:class extends module.LanCompanion {
    constructor(options:any) {super({...options,remember:false,
      interfaces:()=>({en0:[{address:'10.0.0.1',family:'IPv4',internal:false}]}),
      createCertificate:async()=>({key:Buffer.alloc(0),cert:Buffer.alloc(0),fingerprint:'fixture'})});}
  }};
});
vi.mock('../src/inspection-companion-http.js',async original=>{
  const module=await original<any>();
  return {...module,InspectionCompanionHttp:class extends module.InspectionCompanionHttp {
    constructor(options:any) {super({...options,htmlPath:new URL('./fixtures/companion-shell.html',import.meta.url).pathname});}
  }};
});
const cif=await readFile(new URL('../../fixtures/1CRN.cif',import.meta.url),'utf8');

async function stoppedShare() {
  const network=inMemoryCompanionNetwork(),folder=await mkdtemp(join(tmpdir(),'stereofold-stopped-share-'));
  const server=createStereoStructureServer(undefined,{sceneServiceFile:join(folder,'scene.json'),
    replyAudio:createReplyAudioSynthesizer({enabled:false})});
  const client=new Client({name:'Stopped share scene follow',version:'1'});
  const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);
  const call=async(name:string,args:any)=>{
    const answer=await client.callTool({name:`stereo_structure.${name}`,arguments:args}) as any;
    expect(answer.isError,JSON.stringify(answer.content)).not.toBe(true);return answer;
  };
  const sessionId=(await call('inspect',{structureText:cif})).structuredContent.sessionId;
  const initial=(await call('get_inspection',{sessionId}))._meta[KEY];
  const scene={sourceSha256:initial.catalog.source.sha256,modelNumber:initial.catalog.modelNumbers[0],assemblyId:initial.catalog.assemblyId,
    selectionKeys:[],camera:{mode:'perspective',fov:Math.PI/4,position:[0,0,80],target:[0,0,0],up:[0,1,0],
      radius:20,radiusMax:20,fog:50,clipFar:true,minNear:5,minFar:0},
    inspection:{appearance:{representation:'cartoon',color:'chain-id',uniformColor:'#58dcc9',background:'#071015',opacity:1,
      labels:false,highlightColor:'#f2c47c',clipping:0,fog:0},placement:{translation:[0,0,0],rotation:[0,0,0],scale:1}}};
  const base={sessionId,serverEpoch:initial.serverEpoch,sourceToken:initial.sourceToken,baseStateRevision:initial.stateRevision,
    baseInspectionRevision:initial.inspectionRevision};
  const saved=(await call('sync_inspection',{...base,scene})).structuredContent;base.baseInspectionRevision=saved.inspectionRevision;
  const desktop=(await call('attach_inspection',{...base,surface:'desktop'})).structuredContent.panelId;
  await call('open_companion',{...base,connection:'lan',lanHost:'10.0.0.1',launch:'none'});
  const headset=(await call('attach_inspection',{...base,surface:'companion'})).structuredContent.panelId;
  await call('update_inspection',{...base,panelId:headset,commandId:'last-headset-edit',change:{kind:'appearance',patch:{opacity:.6}}});
  const delivery=(await call('poll_inspection',{...base,panelId:headset,availability:'ready'}))._meta[KEY].delivery;
  const latest=expectedInspection(scene as any,delivery.change);
  const completed=await call('complete_inspection',{...base,panelId:headset,commandId:delivery.commandId,claimToken:delivery.claimToken,scene:latest});
  expect(completed.structuredContent.command.status).toBe('rendered');
  const closed=await call('manage_companion',{sessionId,serverEpoch:base.serverEpoch,sourceToken:base.sourceToken,action:'close'});
  expect(closed.structuredContent.shared).toBe(false);
  return {call,base,desktop,headset,latest,revision:completed.structuredContent.inspectionRevision,
    close:async()=>{await client.close();await server.close();network.close();await rm(folder,{recursive:true,force:true});}};
}

it('offers the last headset save to a stale desktop that returns after Stop',async()=>{
  const t=await stoppedShare();
  try {
    const answer=await t.call('poll_inspection',{...t.base,panelId:t.desktop,availability:'ready'});
    expect(answer.structuredContent).toMatchObject({shared:false,attached:true,inspectionRevision:t.revision});
    expect(answer._meta[KEY].scene).toEqual(t.latest);
    const registered=await t.call('poll_inspection',{...t.base,baseInspectionRevision:t.revision,panelId:t.desktop,availability:'ready'});
    expect((await t.call('get_inspection_state',{sessionId:t.base.sessionId})).structuredContent.panels)
      .toContainEqual(expect.objectContaining({panelId:t.desktop,current:true}));
    expect(registered._meta[KEY].scene).toBeUndefined();
  }finally{await t.close();}
});

it.each(['unsaved','busy','detached','companion','epoch','source','state revision'])('post-Stop follow preserves the %s guard',async guard=>{
  const t=await stoppedShare();
  try {
    const input={...t.base,panelId:t.desktop,availability:'ready'};
    if(guard==='unsaved' || guard==='busy')input.availability=guard;
    if(guard==='companion')input.panelId=t.headset;
    if(guard==='epoch')input.serverEpoch=randomUUID();
    if(guard==='source')input.sourceToken=randomUUID();
    if(guard==='state revision')input.baseStateRevision++;
    if(guard==='detached')await t.call('detach_inspection',{...t.base,panelId:t.desktop});
    const answer=await t.call('poll_inspection',input);
    expect(answer._meta[KEY].scene).toBeUndefined();
    expect(answer.structuredContent.inspectionRevision).toBe(t.revision);
    expect((await t.call('get_inspection',{sessionId:t.base.sessionId}))._meta[KEY].scene).toEqual(t.latest);
  }finally{await t.close();}
});
