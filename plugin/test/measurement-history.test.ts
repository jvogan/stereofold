import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect,it } from 'vitest';
import { createStereoStructureServer } from '../src/server.js';
import { PRIVATE_INSPECTION_META_KEY as PRIVATE_KEY,expectedInspection,validateScene } from '../src/inspection-contract.js';
import { extractInspectionCatalogBytes } from '../src/inspection-catalog.js';
import { measureAtoms,measurementTargetSchema } from '../src/inspection-measure.js';

const cif=await readFile(new URL('../../fixtures/1CRN.cif',import.meta.url),'utf8');
const catalog:any=await extractInspectionCatalogBytes(cif);
const scene:any={
  sourceSha256:catalog.source.sha256,modelNumber:catalog.modelNumbers[0],assemblyId:catalog.assemblyId,selectionKeys:[],
  camera:{mode:'perspective',fov:Math.PI/4,position:[0,0,80],target:[0,0,0],up:[0,1,0],radius:20,radiusMax:20,fog:50,clipFar:true,minNear:5,minFar:0},
  inspection:{appearance:{representation:'cartoon',color:'chain-id',uniformColor:'#58dcc9',background:'#071015',opacity:1,labels:false,highlightColor:'#f2c47c',clipping:0,fog:0},
    placement:{translation:[0,0,0],rotation:[0,0,0],scale:1}},
};
const targets=[1,2,3,4].map(authorResidue=>({authorChain:'A',authorResidue,atomName:'CA'}));
async function setup(initial=scene,source=cif) {
  const [ct,st]=InMemoryTransport.createLinkedPair();
  const server=createStereoStructureServer(undefined,{sceneServiceFile:join(tmpdir(),'measure-'+randomUUID()+'.json')});
  const client=new Client({name:'measurement test',version:'1'});
  await server.connect(st);await client.connect(ct);
  const call=(name:string,args:Record<string,unknown>)=>client.callTool({name:'stereo_structure.'+name,arguments:args}) as Promise<any>;
  const sessionId=(await call('inspect',{structureText:source})).structuredContent.sessionId;
  const hydrated=(await call('get_inspection',{sessionId}))._meta[PRIVATE_KEY];
  const live:any={sessionId,serverEpoch:hydrated.serverEpoch,sourceToken:hydrated.sourceToken,
    baseStateRevision:hydrated.stateRevision,baseInspectionRevision:hydrated.inspectionRevision};
  const saved=(await call('sync_inspection',{...live,scene:initial})).structuredContent;
  expect(saved.saved).toBe(true);
  live.baseStateRevision=saved.stateRevision;live.baseInspectionRevision=saved.inspectionRevision;
  const panelId=(await call('attach_inspection',{...live,surface:'desktop'})).structuredContent.panelId;
  const poll=(extra={})=>call('poll_inspection',{...live,panelId,availability:'ready',...extra});
  let shown=structuredClone(initial);
  await poll();
  const render=async()=>{
    let delivery:any;
    for(let i=0;i<50&&!delivery;i++) {
      delivery=(await poll())._meta[PRIVATE_KEY].delivery;
      if(!delivery) await new Promise(resolve=>setTimeout(resolve,10));
    }
    expect(delivery).toBeTruthy();
    shown=expectedInspection(shown,delivery.change);
    const receipt=(await call('complete_inspection',{...live,panelId,commandId:delivery.commandId,claimToken:delivery.claimToken,scene:shown})).structuredContent;
    live.baseStateRevision=receipt.stateRevision;live.baseInspectionRevision=receipt.inspectionRevision;
    await poll();
    return receipt;
  };
  return {call,sessionId,panelId,live,poll,render,get shown(){return structuredClone(shown);},close:async()=>{await client.close();await server.close();}};
}

import { movedFields, SceneHistory, undoChangeFor, redoChangeFor } from '../src/inspection-operation.js';
import { inspectionChangeSchema, updateInspectionSchema } from '../src/inspection-contract.js';

const measured:any=measureAtoms(catalog,scene,targets.slice(0,2),null);
const line={id:'gap',a:measured.endpoints[0],b:measured.endpoints[1],color:'#f2c47c'};
const annotated={...scene,inspection:{...scene.inspection,measurementLines:[line]}};
const figure={layers:[{id:'local-layer',target:{chain:'A',residues:{from:1,to:4}},representation:'ball-and-stick',color:'#123456',opacity:1,context:false}],labels:[],distances:[]};

it('measurement-only edits join shared history and empty/absent lines are the same state',()=>{
  expect(movedFields(scene,annotated)).toEqual(['measurement']);
  expect(movedFields(scene,{...scene,inspection:{...scene.inspection,measurementLines:[]}})).toEqual([]);
  const history=new SceneHistory();
  const entry=history.record({origin:'command',surface:'desktop',label:'measurement',before:scene,after:annotated})!;
  expect(history.size()).toBe(1);
  expect(undoChangeFor(entry)).toEqual({kind:'measurement',patch:{lines:[]}});
  expect(redoChangeFor(entry)).toEqual({kind:'measurement',patch:{lines:[line]}});
  const otherView=structuredClone(annotated);otherView.camera.position=[3,4,90];otherView.inspection.lessonFigure=figure;
  const restored=expectedInspection(otherView,undoChangeFor(entry));
  expect(restored.inspection.measurementLines).toBeUndefined();
  expect(restored.camera).toEqual(otherView.camera);expect(restored.inspection.lessonFigure).toEqual(figure);
  const copy=redoChangeFor(entry);(copy as any).patch.lines[0].a.position[0]+=1;
  expect(history.entries()[0].after.inspection.measurementLines).toEqual([line]);
});

it('a mixed manual edit restores measurements atomically but callers cannot submit raw endpoint compounds',()=>{
  const after=structuredClone(annotated);after.inspection.appearance.opacity=.4;
  const history=new SceneHistory();const entry=history.record({origin:'manual',surface:'desktop',label:'manual',before:scene,after})!;
  expect(movedFields(scene,after)).toEqual(['appearance','measurement']);
  const undo=undoChangeFor(entry),redo=redoChangeFor(entry);
  expect(undo.kind).toBe('compound');expect(inspectionChangeSchema.safeParse(undo).success).toBe(true);
  expect(expectedInspection(after,undo)).toEqual(scene);expect(expectedInspection(scene,redo)).toEqual(after);
  const binding={sessionId:'00000000-0000-4000-8000-000000000001',serverEpoch:'00000000-0000-4000-8000-000000000002',sourceToken:'00000000-0000-4000-8000-000000000003',baseStateRevision:0,baseInspectionRevision:0,panelId:'00000000-0000-4000-8000-000000000004',commandId:'raw'};
  expect(updateInspectionSchema.safeParse({...binding,change:{kind:'compound',patch:{ops:[{kind:'appearance',patch:{opacity:.4}},{kind:'selection',patch:{selectionKeys:[]}}]}}}).success).toBe(true);
  expect(updateInspectionSchema.safeParse({...binding,change:redo}).success).toBe(false);
});

it('the internal history envelope admits all eight fields without expanding the public endpoint surface',()=>{
  const ops=[
    {kind:'appearance',patch:{opacity:.4}},
    {kind:'placement',patch:{scale:2}},
    {kind:'selection',patch:{selectionKeys:[]}},
    {kind:'emphasis',patch:{parts:[],focus:[],contextOpacity:.18}},
    {kind:'visibility',patch:{hiddenChains:[],hiddenClasses:[],showOnlySelection:false}},
    {kind:'styles',patch:{styles:[]}},
    {kind:'companion-structure',patch:{remove:true}},
    {kind:'measurement',patch:{lines:[line]}},
  ];
  expect(inspectionChangeSchema.safeParse({kind:'compound',patch:{ops}}).success).toBe(true);
  expect(inspectionChangeSchema.safeParse({kind:'compound',patch:{ops:[...ops,ops[7]]}}).success).toBe(false);
});

it('add/remove Undo and Redo restore exact endpoints once and keep unrelated scientific state',async()=>{
  const initial={...scene,inspection:{...scene.inspection,lessonFigure:figure}};
  const h=await setup(initial);
  try {
    const getState=async()=>(await h.call('get_inspection_state',{sessionId:h.sessionId})).structuredContent;
    const perform=async(name:string,args:any)=>{
      const queued=await h.call(name,{sessionId:h.sessionId,panelId:h.panelId,...args});expect(queued.isError).not.toBe(true);
      const completed=await h.render();expect(completed.command.status).toBe('rendered');return getState();
    };
    await h.call('measure',{sessionId:h.sessionId,targets:targets.slice(0,2)});
    expect((await getState()).history).toMatchObject({undoCount:0,redoCount:0});
    expect((await perform('measure',{targets:targets.slice(0,2),annotate:true,measurementId:'gap',commandId:'add'})).history).toMatchObject({undoCount:1,redoCount:0});
    expect(h.shown.inspection.measurementLines).toEqual([line]);
    expect((await perform('remove_measurement',{measurementId:'gap',commandId:'remove'})).history).toMatchObject({undoCount:2,redoCount:0});
    expect(h.shown.inspection.measurementLines).toBeUndefined();
    expect((await perform('undo_last_change',{commandId:'undo-remove'})).history).toMatchObject({undoCount:1,redoCount:1});
    expect(h.shown.inspection.measurementLines).toEqual([line]);
    expect((await perform('undo_last_change',{commandId:'undo-add'})).history).toMatchObject({undoCount:0,redoCount:2});
    expect(h.shown).toEqual(initial);
    expect((await perform('redo_last_change',{commandId:'redo-add'})).history).toMatchObject({undoCount:1,redoCount:1});
    expect(h.shown.inspection.measurementLines).toEqual([line]);
    expect((await perform('redo_last_change',{commandId:'redo-remove'})).history).toMatchObject({undoCount:2,redoCount:0});
    expect(h.shown).toEqual(initial);
    // An exact retry returns its old rendered receipt without another entry.
    const replay=await h.call('remove_measurement',{sessionId:h.sessionId,panelId:h.panelId,measurementId:'gap',commandId:'remove'});
    expect(replay.structuredContent.command.status).toBe('rendered');expect((await getState()).history.undoCount).toBe(2);
  } finally {await h.close();}
});

it('endpoint identity and source validation remain strict for measurement history',()=>{
  const bad=structuredClone(annotated);bad.inspection.measurementLines[0].a.position[0]+=.1;
  expect(()=>validateScene(bad,catalog)).toThrow(/Measurement endpoints/);
  const foreign=structuredClone(annotated);foreign.sourceSha256='a'.repeat(64);
  expect(()=>validateScene(foreign,catalog)).toThrow();
});
