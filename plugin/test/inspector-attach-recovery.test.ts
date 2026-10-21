import { z } from 'zod';
import { inspectionBindingSchema } from '../src/inspection-contract.js';
// @ts-ignore Shared receipt validation.
import { sourceGeometryBudget } from '../../lab/browser-roundtrip/geometry-advisory.mjs';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {expect,it} from 'vitest';
import {InspectionCommands} from '../src/inspection-commands.js';
import {canRefreshInspectionAttach,isStaleInspectionAttach,MAX_ATTACH_REFRESHES,STALE_ATTACH_MESSAGE} from '../src/inspection-attach-recovery.js';

const source=readFileSync(new URL('../src/inspector.ts',import.meta.url),'utf8');
const ast=ts.createSourceFile('inspector.ts',source,ts.ScriptTarget.Latest,true);
const attach=ast.statements.find(node=>ts.isFunctionDeclaration(node) && node.name?.text==='attach')!.getText(ast);
const script=ts.transpileModule(attach,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,alwaysStrict:true}}).outputText;
const stale=()=>Object.assign(Error(STALE_ATTACH_MESSAGE),{code:'companion_request',status:409});
const scene=(sha='a')=>({sourceSha256:sha.repeat(64),selectionKeys:['custom-residue'],
  inspection:{placement:{translation:[.5,-.2,-1.4],rotation:[0,.3,0],scale:3.5},labels:[{text:'Custom ligand'}],figure:{id:'custom-scientific-figure'}},
  camera:{position:[0,0,10],target:[0,0,0]}});

function fixture(options:{changedSource?:boolean;onRead?:(page:any)=>void;error?:Error;alwaysStale?:boolean;lostResponse?:boolean;sourceGeometryBudgetSupported?:boolean;geometryBudget?:any;renderedSourceIdentitySupported?:boolean}={}) {
  let now=1000;
  const host=new InspectionCommands(()=>now);
  const original={sessionId:'11111111-1111-4111-8111-111111111111',serverEpoch:'22222222-2222-4222-8222-222222222222',sourceToken:'33333333-3333-4333-8333-333333333333',stateRevision:1,inspectionRevision:1};
  let authoritative={...original,inspectionRevision:2,...(options.changedSource?{sourceToken:'44444444-4444-4444-8444-444444444444',stateRevision:2}:{})};
  let authoritativeScene=scene(options.changedSource?'b':'a');
  const attachPayloads:any[]=[],notices:any[]=[];
  const calls:string[]=[],restores:any[]=[],events:any[]=[];
  const element=()=>({textContent:'',dataset:{},setAttribute(){},prepend(){}});
  const h:any=vm.createContext({closed:false,generation:1,edits:0,localInteractionSerial:0,dirty:false,blocked:false,loading:false,remote:false,
    sourceGeometryBudgetSupported:options.sourceGeometryBudgetSupported===true,sourceGeometryBudget,
    renderedSourceIdentitySupported:options.renderedSourceIdentitySupported===true,
    announceSourceGeometryBudget:(receipt:any)=>notices.push(receipt),
    panelId:undefined,attaching:undefined,attachRetryAt:0,pendingReceipt:undefined,binding:original,
    savedScene:scene(),drawn:scene(),isCompanion:true,experiencePreparing:false,experiencePlayer:undefined,
    canRefreshInspectionAttach,isStaleInspectionAttach,MAX_ATTACH_REFRESHES,PRIVATE_KEY:'private',HYDRATION_TRANSPORT:{},
    document:{body:{dataset:{}},querySelector:()=>element(),createElement:()=>element()},
    outcome:element(),Date:{now:()=>now},interactionActive:false,
    workspace:{capture:()=>structuredClone(h.drawn),snapshot:()=>({sourceSha256:h.drawn.sourceSha256,applied:{geometryBudget:options.geometryBudget},ready:true,interactionActive:h.interactionActive,xrPresenting:true})},
    expected:()=>({sessionId:h.binding.sessionId,serverEpoch:h.binding.serverEpoch,sourceToken:h.binding.sourceToken,
      baseStateRevision:h.binding.stateRevision,baseInspectionRevision:h.binding.inspectionRevision}),
    recordHeadsetEvent:(kind:string,detail:any)=>events.push({kind,detail}),
    showConnectionProblem:(error:any)=>['companion_connection','companion_expired'].includes(error.code),
    reconcileExperience:async()=>{},
  });
  h.call=async(name:string,args:any)=>{
    calls.push(name);
    if(name==='attach_inspection') {
      attachPayloads.push(args);
      inspectionBindingSchema.extend({surface:z.enum(['desktop','companion']).optional(),replacesPanelId:z.string().uuid().optional(),
        ...(options.sourceGeometryBudgetSupported?{geometryBudget:z.unknown().optional()}:{}),
        ...(options.renderedSourceIdentitySupported?{renderedSourceSha256:z.string().regex(/^[a-f0-9]{64}$/).optional()}:{}),
      }).parse(args);
      if(options.error)throw options.error;
      if(options.alwaysStale) {authoritative={...authoritative,inspectionRevision:authoritative.inspectionRevision+1};throw stale();}
      if(options.lostResponse) {
        host.attach(args,authoritative);
        throw Object.assign(Error('The issued panel response was lost.'),{code:'companion_connection'});
      }
      try {return {structuredContent:{panelId:host.attach(args,authoritative)}};}
      catch(error) {expect((error as Error).message).toBe(STALE_ATTACH_MESSAGE);throw stale();}
    }
    if(name==='get_inspection') {
      options.onRead?.(h);
      return {_meta:{private:{...authoritative,scene:structuredClone(authoritativeScene)}}};
    }
    throw Error(`Unexpected ${name}`);
  };
  // GPU/platform adapter only: real attach admission and registry execute.
  h.hydrate=async(id:string,response:any,_journey:undefined,restoreOptions:any)=>{
    const generation=++h.generation;
    h.loading=true;
    restoreOptions.checkpointRestore(generation);
    await Promise.resolve();
    restoreOptions.admitRestore(generation);
    const data=response._meta.private;
    restores.push({id,scene:structuredClone(data.scene),options:restoreOptions});
    h.drawn=structuredClone(data.scene);h.savedScene=structuredClone(data.scene);h.binding={...data};
    h.loading=false;
    await h.attach(undefined,undefined,true,restoreOptions.attachRecoveryAttempt);
  };
  vm.runInContext(script,h);
  return {h,host,calls,restores,events,attachPayloads,notices,authoritative:()=>authoritative,advance:(at:number)=>{now=at;}};
}

for(const changedSource of [false,true])it(`refreshes a definitively refused attach in place (${changedSource?'changed':'same'} source) with custom scene intact`,async()=>{
  const f=fixture({changedSource});
  await f.h.attach();
  expect(f.calls).toEqual(['attach_inspection','get_inspection','attach_inspection']);
  expect(f.restores).toHaveLength(1);
  expect(f.restores[0]).toMatchObject({id:'11111111-1111-4111-8111-111111111111',scene:scene(changedSource?'b':'a'),options:{restoreExactScene:true}});
  expect(f.h.binding).toMatchObject(f.authoritative());
  expect(f.h.drawn).toEqual(f.restores[0].scene);
  expect(f.host.summary(f.authoritative()).panels).toHaveLength(1);
});

it.each(['dirty','blocked','interactionActive','pendingReceipt'])('keeps %s local work before recovery without reading or restoring',async flag=>{
  const f=fixture();f.h[flag]=true;
  await expect(f.h.attach()).rejects.toMatchObject({message:STALE_ATTACH_MESSAGE});
  expect(f.calls).toEqual(['attach_inspection']);expect(f.restores).toHaveLength(0);
  expect(f.h.drawn).toEqual(scene());
});
it('protects an unflagged local scene edit before its save timer fires',async()=>{
  const f=fixture();f.h.drawn.inspection.placement.scale=4.7;
  await expect(f.h.attach()).rejects.toMatchObject({message:STALE_ATTACH_MESSAGE});
  expect(f.calls).toEqual(['attach_inspection']);expect(f.h.drawn.inspection.placement.scale).toBe(4.7);
});
it.each(['edit','interaction','completed-interaction','receipt','new-binding','new-generation'])('protects %s that arrives during the authoritative read',async kind=>{
  const f=fixture({onRead:h=>{
    if(kind==='edit')h.drawn.selectionKeys=['new-local-selection'];
    if(kind==='interaction')h.interactionActive=true;
    if(kind==='completed-interaction')h.localInteractionSerial++;
    if(kind==='receipt')h.pendingReceipt={commandId:'pending'};
    if(kind==='new-binding')h.binding={...h.binding,inspectionRevision:99};
    if(kind==='new-generation')h.generation++;
  }});
  if(kind==='new-generation')await f.h.attach();
  else await expect(f.h.attach()).rejects.toThrow('Local work changed');
  expect(f.calls).toEqual(['attach_inspection','get_inspection']);expect(f.restores).toHaveLength(0);
});
it('bounds repeated desktop revision races instead of looping hydration',async()=>{
  const f=fixture({alwaysStale:true});
  await expect(f.h.attach()).rejects.toMatchObject({message:STALE_ATTACH_MESSAGE});
  expect(f.calls.filter(name=>name==='get_inspection')).toHaveLength(MAX_ATTACH_REFRESHES);
  expect(f.calls.filter(name=>name==='attach_inspection')).toHaveLength(MAX_ATTACH_REFRESHES+1);
  expect(f.host.summary(f.authoritative()).panels).toHaveLength(0);
});
it('never retries an uncertain attach or allocates a second panel on a lost response',async()=>{
  const f=fixture({lostResponse:true});f.h.binding=f.authoritative();
  await f.h.attach();await f.h.attach();
  expect(f.calls).toEqual(['attach_inspection']);expect(f.restores).toHaveLength(0);
  expect(f.h.attachRetryAt).toBe(62000);
  f.advance(12000);await f.h.attach();
  expect(f.calls).toEqual(['attach_inspection']);
  expect(f.host.summary(f.authoritative()).panels).toHaveLength(1);
  f.advance(62000);await f.h.attach();
  expect(f.calls).toEqual(['attach_inspection','attach_inspection']);
  expect(f.host.summary(f.authoritative()).panels).toHaveLength(1);
});
it('keeps expired capabilities on the existing recovery route',async()=>{
  const f=fixture({error:Object.assign(Error('Share ended'),{code:'companion_expired',status:401})});
  await f.h.attach();
  expect(f.calls).toEqual(['attach_inspection']);expect(f.restores).toHaveLength(0);
});
it('requires the exact validation result, never just a 409 or matching network sentence',()=>{
  expect(isStaleInspectionAttach(stale())).toBe(true);
  expect(isStaleInspectionAttach(Object.assign(Error(STALE_ATTACH_MESSAGE),{code:'inspection_attach_stale'}))).toBe(true);
  for(const error of [Error(STALE_ATTACH_MESSAGE),Object.assign(Error(STALE_ATTACH_MESSAGE),{code:'companion_connection',status:409}),
    Object.assign(Error('The panel is unavailable.'),{code:'companion_request',status:409}),
    Object.assign(Error(STALE_ATTACH_MESSAGE),{code:'companion_request',status:503})])expect(isStaleInspectionAttach(error)).toBe(false);
});

const advisory={representation:'spacefill',deviceClass:'quest3',atoms:200000,budget:260000,
  requestedLevel:'high',level:'high',estimatedVertices:10000000,message:'Showing atoms at requested detail; it may run slowly.'};
for(const supported of [false,true])it(`source advisory negotiates attach field with ${supported?'new':'old strict'} host`,async()=>{
  const f=fixture({sourceGeometryBudgetSupported:supported,geometryBudget:advisory});
  // Use the current exact binding so this test covers successful admission.
  f.h.binding=f.authoritative();
  await f.h.attach();
  expect(f.attachPayloads).toHaveLength(1);
  if(supported)expect(f.attachPayloads[0].geometryBudget).toEqual(advisory);
  else expect(f.attachPayloads[0]).not.toHaveProperty('geometryBudget');
  expect(f.notices).toEqual([advisory]);
});
it('does not send malformed non-finite source advisories even to a supporting host',async()=>{
  const f=fixture({sourceGeometryBudgetSupported:true,geometryBudget:{...advisory,budget:Infinity}});
  f.h.binding=f.authoritative();await f.h.attach();
  expect(f.attachPayloads[0]).not.toHaveProperty('geometryBudget');
});
for(const supported of [false,true])it(`rendered source identity negotiates attach field with ${supported?'new':'old strict'} host`,async()=>{
  const f=fixture({renderedSourceIdentitySupported:supported});f.h.binding=f.authoritative();
  await f.h.attach();
  expect(f.attachPayloads).toHaveLength(1);
  if(supported)expect(f.attachPayloads[0].renderedSourceSha256).toBe(f.h.drawn.sourceSha256);
  else expect(f.attachPayloads[0]).not.toHaveProperty('renderedSourceSha256');
  expect(f.host.summary(f.authoritative()).panels).toHaveLength(1);
});
