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
  return {call,sessionId,panelId,live,poll,render,close:async()=>{await client.close();await server.close();}};
}
it('matches direct fixture coordinates and update_inspection residue naming',()=>{
  const result:any=measureAtoms(catalog,scene,targets.slice(0,2),null);
  expect(result.ok).toBe(true);
  const p=targets.slice(0,2).map(t=>catalog.rows.find((r:any)=>r.identity.authorResidue===t.authorResidue).atomSites.find((a:any)=>a.identity.atomName==='CA').assemblyCoordinatesAngstrom);
  expect(result.distanceAngstrom).toBeCloseTo(Math.sqrt(p[0].reduce((sum:number,v:number,i:number)=>sum+(v-p[1][i])**2,0)),12);
  expect(result.atoms[0]).toMatchObject({authorChain:'A',authorResidue:1,atomName:'CA',componentId:'THR'});
  expect(result.atoms[0].label).toContain('THR A:1 CA');
  const ranged:any=measureAtoms(catalog,scene,[{labelChain:'A',authorResidueRange:[1,1],componentId:'THR',atomName:'CA'},targets[1]],null);
  expect(ranged.distanceAngstrom).toBe(result.distanceAngstrom);
  expect(measurementTargetSchema.safeParse({authorResidueRange:[4,1]}).success).toBe(false);
});
it('returns known angle and signed dihedral and rejects degenerate geometry',()=>{
  const atoms=[[1,0,0],[0,0,0],[0,1,0],[0,1,1]].map((position,i)=>({key:'atom'+i,identity:{modelNumber:1,labelChain:'A',authorChain:'A',authorResidue:i+1,atomName:'CA',componentId:'GLY'},assemblyCoordinatesAngstrom:position}));
  const fake={rows:atoms.map(atom=>({identity:atom.identity,atomSites:[atom]}))};
  expect(measureAtoms(fake,{...scene,modelNumber:1},targets,null)).toMatchObject({ok:true,distanceAngstrom:1,angleDegrees:90,dihedralDegrees:-90});
  atoms[0].assemblyCoordinatesAngstrom=[0,0,0];
  expect(measureAtoms(fake,{...scene,modelNumber:1},targets,null)).toMatchObject({ok:false,errors:[{field:'targets',code:'degenerate'}]});
});
it('measures partial-chain motion and binds annotation selectors to source atom identities',()=>{
  const track={id:'domain',chains:['A'],selector:{residues:[{from:1,to:1}]},pivot:[3,2,1],
    keyframes:[{t:0,rotation:[0,0,1,0],translation:[0,0,0]}]};
  const animation={definition:{version:1,durationSeconds:1,tracks:[track]},
    playback:{id:'clip',chapterId:'motion',state:'paused',timeSeconds:0,durationSeconds:1,loop:false,speed:1}};
  const moving={...scene,inspection:{...scene.inspection,animation}};
  const result:any=measureAtoms(catalog,moving,targets.slice(0,2),null);
  expect(result.atoms.map((atom:any)=>atom.movingBodyId)).toEqual(['domain',null]);
  expect(result.animation.changesWithAnimation).toBe(true);
  const annotated={...scene,inspection:{...scene.inspection,measurementLines:[{
    id:'gap',a:result.endpoints[0],b:result.endpoints[1],color:'#123456',
  }]}};
  expect(()=>validateScene(annotated,catalog)).not.toThrow();
  annotated.inspection.measurementLines[0].a.authorResidue=2;
  expect(()=>validateScene(annotated,catalog)).toThrow('Measurement endpoints must match');
});
it('lists ambiguous atoms, alternate sites, copies, and field-level missing candidates',()=>{
  const ambiguous:any=measureAtoms(catalog,scene,[{authorResidue:1},targets[1]],null);
  expect(ambiguous.errors[0]).toMatchObject({field:'targets.0',code:'ambiguous'});
  expect(ambiguous.errors[0].candidates.length).toBeGreaterThan(1);
  const missing:any=measureAtoms(catalog,scene,[{...targets[0],atomName:'NOPE'},targets[1]],null);
  expect(missing.errors[0]).toMatchObject({field:'targets.0.atomName',code:'missing'});
  expect(missing.errors[0].candidates.some((c:any)=>c.atomName==='CA')).toBe(true);
  const atom=catalog.rows[0].atomSites.find((a:any)=>a.identity.atomName==='CA');
  const fake={rows:[{identity:atom.identity,atomSites:[atom,{...atom,key:'copy-atom',identity:{...atom.identity,copyId:'second-copy',alternateSite:'B'}}]},catalog.rows[1]]};
  expect((measureAtoms(fake,scene,targets.slice(0,2),null) as any).errors[0].candidates[1]).toMatchObject({copyId:'second-copy',alternateSite:'B'});
  expect(measureAtoms(fake,scene,[{...targets[0],copyId:'second-copy',alternateSite:'B'},targets[1]],null))
    .toMatchObject({ok:true,atoms:[{key:'copy-atom'},{authorResidue:2}]});
});
it('text-only MCP read returns numbers, atoms and errors without changing scene or revisions',async()=>{
  const h=await setup();
  try {
    await h.call('detach_inspection',{...h.live,panelId:h.panelId});
    const before=(await h.call('get_inspection_state',{sessionId:h.sessionId})).structuredContent;
    const response=await h.call('measure',{sessionId:h.sessionId,targets:targets.slice(0,4)});
    const text=JSON.parse(response.content.at(-1).text.slice(8,-4));
    expect(text.measurement.distanceAngstrom).toBe(response.structuredContent.measurement.distanceAngstrom);
    expect(text.measurement.atoms).toHaveLength(4);
    expect(Number.isFinite(text.measurement.angleDegrees)).toBe(true);
    expect(Number.isFinite(text.measurement.dihedralDegrees)).toBe(true);
    const error=await h.call('measure',{sessionId:h.sessionId,targets:[{authorResidue:1},targets[1]]});
    expect(error.isError).toBe(true);
    expect(JSON.parse(error.content.at(-1).text.slice(8,-4)).measurement.errors[0].candidates.length).toBeGreaterThan(1);
    const after=(await h.call('get_inspection_state',{sessionId:h.sessionId})).structuredContent;
    expect(after.stateRevision).toBe(before.stateRevision);expect(after.inspectionRevision).toBe(before.inspectionRevision);
    expect((await h.call('get_inspection',{sessionId:h.sessionId}))._meta[PRIVATE_KEY].scene).toEqual(scene);
  } finally {await h.close();}
});
it('annotation/removal settle only on panel completion receipts and preserve chapter figures',async()=>{
  const figure={layers:[{id:'local-layer',target:{chain:'A',residues:{from:1,to:4}},representation:'ball-and-stick',color:'#123456',opacity:1,context:false}],labels:[],distances:[]};
  const h=await setup({...scene,inspection:{...scene.inspection,lessonFigure:figure}});
  try {
    const pending=h.call('measure',{sessionId:h.sessionId,targets:targets.slice(0,2),annotate:true,measurementId:'gap',commandId:'draw-gap',waitForRenderMs:2000});
    // Synthetic panel draw/save completion is protocol evidence, not a GPU draw.
    await h.render();
    const measured=await pending;
    expect(measured.structuredContent.command).toMatchObject({commandId:'draw-gap',status:'rendered'});
    expect(measured.structuredContent.measurementId).toBe('gap');
    expect(measured.content[0].text).toContain('"status":"rendered"');
    const replay=await h.call('measure',{sessionId:h.sessionId,targets:targets.slice(0,2),annotate:true,measurementId:'gap',commandId:'draw-gap',waitForRenderMs:2000});
    expect(replay.structuredContent.command.commandId).toBe('draw-gap');
    expect(replay.structuredContent.command.status).toBe('rendered');
    expect((await h.call('get_inspection',{sessionId:h.sessionId}))._meta[PRIVATE_KEY].scene.inspection.measurementLines[0].id).toBe('gap');
    const removal=h.call('remove_measurement',{sessionId:h.sessionId,measurementId:'gap',commandId:'erase-gap',waitForRenderMs:2000});
    await h.render();
    expect((await removal).structuredContent.command).toMatchObject({commandId:'erase-gap',status:'rendered'});
    const remaining=(await h.call('get_inspection',{sessionId:h.sessionId}))._meta[PRIVATE_KEY].scene.inspection;
    expect(remaining.measurementLines).toBeUndefined();
    expect(remaining.lessonFigure).toEqual(figure);
  } finally {await h.close();}
});
it('MCP returns different cross-body distances at two panel times without advancing revisions',async()=>{
  const source=await readFile(new URL('../../fixtures/4HHB.cif',import.meta.url),'utf8');
  const cat:any=await extractInspectionCatalogBytes(source);
  const playback={id:'clip',chapterId:'motion',state:'paused',timeSeconds:0,durationSeconds:2,loop:false,speed:1};
  const definition={version:1,durationSeconds:2,tracks:[
    {id:'first',chains:['A'],keyframes:[{t:0,rotation:[0,0,0,1],translation:[0,0,0]},{t:2,rotation:[0,0,0,1],translation:[10,0,0]}]},
    {id:'other',chains:['B'],keyframes:[{t:0,rotation:[0,0,0,1],translation:[0,0,0]},{t:2,rotation:[0,0,0,1],translation:[0,10,0]}]},
  ]};
  const initial={...scene,sourceSha256:cat.source.sha256,inspection:{...scene.inspection,animation:{definition,playback}}};
  const h=await setup(initial,source);
  try {
    const pair=[targets[0],{authorChain:'B',authorResidue:1,atomName:'CA'}];
    await h.poll({animation:playback});
    const first=(await h.call('measure',{sessionId:h.sessionId,targets:pair})).structuredContent;
    await h.poll({animation:{...playback,timeSeconds:2}});
    const second=(await h.call('measure',{sessionId:h.sessionId,targets:pair})).structuredContent;
    expect(second.measurement.animation).toMatchObject({moving:true,changesWithAnimation:true,timeSeconds:2});
    expect(first.measurement.atoms.map((a:any)=>a.movingBodyId)).toEqual(['first','other']);
    expect(second.measurement.distanceAngstrom).not.toBeCloseTo(first.measurement.distanceAngstrom);
    expect(second.inspectionRevision).toBe(first.inspectionRevision);
    expect(second.stateRevision).toBe(first.stateRevision);
  } finally {await h.close();}
});

it('pages at eight candidates, rejects stale cursors and offers representative lesson parts',()=>{
  const parts=[{id:'head-1',label:'Head 1',chain:'A',residues:{from:1,to:20}},
    {id:'head-2',label:'Head 2',chain:'A',residues:{from:21,to:46}}];
  const query={authorChain:'A',atomName:'CA'};
  const first:any=measureAtoms(catalog,scene,[query,query],null,parts);
  expect(first.errors).toHaveLength(2);
  expect(first.errors[0].candidates).toHaveLength(8);
  expect(first.errors[0].candidates[0].label).toContain('Head 1');
  expect(first.errors[0].representativeOptions[0].target).toEqual({part:'head-1'});
  const second:any=measureAtoms(catalog,scene,[{...query,cursor:first.errors[0].cursor},targets[1]],null,parts);
  expect(second.errors[0].candidates[0]).not.toEqual(first.errors[0].candidates[0]);
  expect(measureAtoms(catalog,scene,[{...targets[0],atomName:'N',cursor:first.errors[0].cursor},query],null,parts)).toBeDefined();
  const stale:any=measureAtoms(catalog,scene,[{...query,atomName:'N',cursor:first.errors[0].cursor},query],null,parts);
  expect(stale.errors[0].code).toBe('stale_cursor');
  const result:any=measureAtoms(catalog,scene,[{part:'head-1'},{part:'head-2'}],null,parts);
  expect(result.ok).toBe(true);
  expect(result.atoms.map((a:any)=>a.part)).toEqual(['head-1','head-2']);
  expect(result.atoms.every((a:any)=>a.atomName==='CA')).toBe(true);
  expect(result.distanceAngstrom).toBeGreaterThan(0);
  expect(JSON.stringify(first).length).toBeLessThan(5000);
});

it('reports hidden animation endpoints and pages visible part alternatives at the sampled time', () => {
  const parts = Array.from({length:20}, (_,i)=>({id:`part-${i}`,label:`Part ${i}`,chain:'A',residues:{from:i+1,to:i+1}}));
  const tracks = [1,2].map((residue,i)=>({id:`body-${i}`,chains:['A'],selector:{residues:[{from:residue,to:residue}]},
    keyframes:[{t:0,rotation:[0,0,0,1],translation:[0,0,0]}],
    visibility:[{t:0,visible:i===0},{t:1,visible:i===1}]}));
  const playback={id:'clip',chapterId:'motion',timeSeconds:0,state:'paused'};
  const moving={...scene,inspection:{...scene.inspection,animation:{definition:{tracks},playback}}};
  const first:any=measureAtoms(catalog,moving,[{part:'part-0'},{part:'part-1'}],null,parts);
  expect(first.atoms.map((a:any)=>a.visible)).toEqual([true,false]);
  expect(first.atoms[1].visiblePartIds).toContain('part-0');
  expect(first.atoms[1].visiblePartIds).not.toContain('part-1');
  expect(first.atoms[1].visiblePartIds).toHaveLength(8);
  expect(first.atoms[1].visibleParts).toEqual({offset:0,total:19,nextOffset:8});
  const next:any=measureAtoms(catalog,moving,[{part:'part-0',visiblePartsOffset:8},{part:'part-1'}],null,parts);
  expect(next.atoms[0].visiblePartIds).not.toContain(first.atoms[0].visiblePartIds[0]);
  const later:any=measureAtoms(catalog,moving,[{part:'part-0'},{part:'part-1'}],{...playback,timeSeconds:1},parts);
  expect(later.atoms.map((a:any)=>a.visible)).toEqual([false,true]);
  expect(later.atoms[0].visiblePartIds).toContain('part-1');
  const hidden={...moving,inspection:{...moving.inspection,visibility:{hiddenChains:[{labelChain:'A',copyId:catalog.rows[0].identity.copyId}],hiddenClasses:[],showOnlySelection:false}}};
  expect((measureAtoms(catalog,hidden,targets.slice(0,2),null,parts) as any).atoms[0].visible).toBe(false);
});
