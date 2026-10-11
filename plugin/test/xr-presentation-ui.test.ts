import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { xrReentryEntryView } from '../src/xr-reentry-hint.js';
// @ts-ignore browser module is exercised directly by the viewer fixture.
import { entryFallbackCopy } from '../../lab/browser-roundtrip/xr-session-request.mjs';

const viewer=readFileSync(new URL('../../lab/browser-roundtrip/viewer.mjs',import.meta.url),'utf8');
const inspector=readFileSync(new URL('../src/inspector.ts',import.meta.url),'utf8');
const extract=(source:string,name:string,indent:string)=>{
  const start=source.search(new RegExp(`${indent}(?:async )?function ${name}\\(`));
  expect(start).toBeGreaterThanOrEqual(0);
  return source.slice(start,source.indexOf(`\n${indent}}`,start)+indent.length+2);
};
// The presentation observer has a typed, multi-line callback. Extract its
// complete statement rather than treating its first line as executable JS.
const inspectorAst=ts.createSourceFile('inspector.ts',inspector,ts.ScriptTarget.ES2022,true,ts.ScriptKind.TS);
function extractVariable(name:string){
  let statement:ts.VariableStatement|undefined;
  const visit=(node:ts.Node)=>{
    if(ts.isVariableStatement(node)&&node.declarationList.declarations.some(declaration=>ts.isIdentifier(declaration.name)&&declaration.name.text===name))statement=node;
    ts.forEachChild(node,visit);
  };
  visit(inspectorAst);
  expect(statement,`inspector declaration ${name}`).toBeDefined();
  return statement!.getText(inspectorAst);
}
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
function harness(){
  const listeners=new Set<(value:boolean)=>void>();
  const native={value:false,subscribe(fn:(value:boolean)=>void){listeners.add(fn);fn(this.value);return{unsubscribe(){listeners.delete(fn);}};},
    emit(value:boolean){this.value=value;for(const fn of [...listeners])fn(value);}};
  const ar={disabled:false,hidden:false,dataset:{enterXr:'immersive-ar',primary:'true'}};
  const vr={disabled:false,hidden:false,dataset:{enterXr:'immersive-vr'}};
  const hides:Array<()=>void>=[],timers:Array<()=>void>=[],cleared:any[]=[];
  const h:any=vm.createContext({console,state:{status:'ready'},canvas:{xr:{isPresenting:native}},interactionSubscriptions:[],
    closed:false,generation:1,xrSyncSequence:0,arSupported:false,xrPending:false,xrProblem:'',reentryArmed:false,disarmReentry:undefined,
    hudSignature:'',hudWaitingSince:0,resumeMode:null,resume:{hidden:true},resumeButton:{disabled:false},resumeNote:{},
    entryActions:{},options:{},enterButtons:[ar,vr],leave:{},note:{dataset:{}},recording:{},updateVoiceUi(){},
    xrReentryEntryView,entryFallbackCopy,entryWatchdog:undefined,activePreviewRecording:undefined,
    startupState:{reloadRequired:false},capabilities:async()=>({ar:true,vr:true}),
    window:{addEventListener(name:string,callback:()=>void){expect(name).toBe('pagehide');hides.push(callback);}},
    setInterval(callback:()=>void,ms:number){expect(ms).toBe(2000);timers.push(callback);return timers.length;},
    clearInterval:(id:any)=>cleared.push(id),clearTimeout(){} });
  vm.runInContext(extract(viewer,'onPresentationChange','  '),h);
  h.workspace={viewer:{xr:{onPresentationChange:h.onPresentationChange,capabilities:()=>h.capabilities(),startup:()=>h.startupState}},
    snapshot:()=>({xrPresenting:native.value})};
  vm.runInContext(ts.transpileModule(extract(inspector,'syncXr','    '),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,h);
  vm.runInContext(ts.transpileModule(extractVariable('unwatchPresentation'),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,h);
  const timer=inspector.match(/    const xrTimer=setInterval.*\n/)?.[0];expect(timer).toBeTruthy();vm.runInContext(timer!,h);
  const teardown=inspector.match(/    window.addEventListener\('pagehide',\(\)=>\{unwatchPresentation\(\);.*\n/)?.[0];
  expect(teardown).toBeTruthy();vm.runInContext(teardown!,h);
  return{h,native,ar,vr,listeners,hides,timers,cleared};
}

describe('native XR presentation edge refreshes the actual entry UI',()=>{
  it('native entry/exit updates controls without waiting for the two-second fallback',async()=>{
    const t=harness();await t.h.syncXr();expect(t.ar.disabled).toBe(false);
    t.native.emit(true);await flush();expect(t.ar.disabled).toBe(true);expect(t.h.leave.hidden).toBe(false);
    t.native.emit(false);await flush();expect(t.ar.disabled).toBe(false);expect(t.h.leave.hidden).toBe(true);
    expect(t.h.note.dataset.state).toBe('connected');expect(t.timers).toHaveLength(1);
    expect(viewer).toMatch(/xr: Object\.freeze\(\{[^\n]*onPresentationChange/);
  });
  it('native XR entry aborts an active flat preview recording, while exit does not',async()=>{
    const t=harness();let aborts=0;t.h.activePreviewRecording={abort(){aborts++;}};
    t.native.emit(true);await flush();expect(aborts).toBe(1);
    t.native.emit(false);await flush();expect(aborts).toBe(1);
  });
  it('exit preserves pending, reload-required and unsupported-browser admission guards',async()=>{
    const t=harness();
    for(const reason of ['pending','reload','unsupported']){
      t.native.emit(true);await flush();
      t.h.xrPending=reason==='pending';t.h.startupState={reloadRequired:reason==='reload'};
      t.h.capabilities=async()=>reason==='unsupported'?{ar:false,vr:false}:{ar:true,vr:true};
      t.native.emit(false);await flush();expect(t.ar.disabled,reason).toBe(true);
    }
  });
  it('a stale asynchronous capability answer cannot overwrite the newest exit state',async()=>{
    const t=harness(),pending:Array<(value:any)=>void>=[];
    t.h.capabilities=()=>new Promise(resolve=>pending.push(resolve));
    t.native.emit(true);t.native.emit(false);expect(pending).toHaveLength(2);
    pending[1]({ar:true,vr:true});await flush();expect(t.ar.disabled).toBe(false);
    pending[0]({ar:false,vr:false});await flush();expect(t.ar.disabled).toBe(false);
  });
  it('pagehide unsubscribes and clears the fallback; duplicate native values do not refresh',async()=>{
    const t=harness();let reads=0;t.h.capabilities=async()=>{reads++;return{ar:true,vr:true};};
    t.native.emit(false);expect(reads).toBe(0);
    t.native.emit(true);t.native.emit(true);await flush();expect(reads).toBe(1);
    t.hides[0]();expect(t.listeners.size).toBe(0);expect(t.h.interactionSubscriptions).toHaveLength(0);expect(t.cleared).toEqual([1]);
    t.native.emit(false);await flush();expect(reads).toBe(1);
  });
  it('viewer disposal owns cleanup even if pagehide never ran',()=>{
    const t=harness();expect(t.listeners.size).toBe(1);
    t.h.state.status='disposed';
    const cleanup=viewer.match(/    for \(const subscription of interactionSubscriptions\) subscription.unsubscribe\(\);/)?.[0];
    expect(cleanup).toBeTruthy();vm.runInContext(cleanup!,t.h);expect(t.listeners.size).toBe(0);
    const stop=t.h.onPresentationChange(()=>{throw Error('disposed observer called');});stop();expect(t.listeners.size).toBe(0);
  });
});
