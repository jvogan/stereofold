import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { xrReentryEntryView } from '../src/xr-reentry-hint.js';
import { enterImmersiveWithFallback } from '../src/xr-entry-fallback.js';
import * as entryFallback from '../src/xr-entry-fallback.js';
import * as entryMicrophone from '../src/xr-entry-microphone.js';
import { MICROPHONE_PROMPT_REFUSED_COPY, MICROPHONE_PROMPT_WAITING_COPY, microphonePromptHoldsEntry, watchMicrophonePermission } from '../src/xr-entry-microphone.js';
// Read off the namespace so this file still loads where the helper is absent.
const microphoneNoticeCopy=(entryMicrophone as Record<string,unknown>).microphoneNoticeCopy;
// @ts-ignore browser module is exercised directly by the viewer fixture.
import { entryFallbackCopy, isAppleSafariXr } from '../../lab/browser-roundtrip/xr-session-request.mjs';
// @ts-ignore browser module is exercised directly by the entry fixture.
import { primePushToTalkMicrophone, pushToTalkMicrophoneState, releasePushToTalkMicrophone } from '../../lab/browser-roundtrip/push-to-talk-audio.mjs';
// @ts-ignore browser module; the viewer's own request deadline.
import { APPLE_PROMPT_DEADLINE_MS, headsetEntryDeadlineMs, requestHeadsetSession } from '../../lab/browser-roundtrip/xr-session-request.mjs';

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
// Runs one of the page's own declarations as a context global.
const runDeclaration=(name:string,context:vm.Context)=>vm.runInContext(ts.transpileModule(extractVariable(name).replace(/^const /,'var '),
  {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
function harness(){
  const listeners=new Set<(value:boolean)=>void>();
  const native={value:false,subscribe(fn:(value:boolean)=>void){listeners.add(fn);fn(this.value);return{unsubscribe(){listeners.delete(fn);}};},
    emit(value:boolean){this.value=value;for(const fn of [...listeners])fn(value);}};
  const ar={disabled:false,hidden:false,dataset:{enterXr:'immersive-ar',primary:'true'}};
  const vr={disabled:false,hidden:false,dataset:{enterXr:'immersive-vr'}};
  const hides:Array<()=>void>=[],timers:Array<()=>void>=[],cleared:any[]=[];
  const h:any=vm.createContext({console,state:{status:'ready'},canvas:{xr:{isPresenting:native}},interactionSubscriptions:[],
    closed:false,generation:1,xrSyncSequence:0,arSupported:false,xrPending:false,xrProblem:'',xrNotice:'',xrEntryAttempt:undefined,reentryArmed:false,disarmReentry:undefined,
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

function entryHarness(resume=false){
  const t=harness(),requests:Array<{mode:string;resolve:(value?:unknown)=>void;reject:(error:Error)=>void}>=[],errors:any[]=[];
  let callback:ts.Expression|undefined,primaryCallback:ts.Expression|undefined;
  const visit=(node:ts.Node)=>{
    if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&node.expression.name.text==='addEventListener'
      &&node.arguments[0]?.getText(inspectorAst)==="'click'"&&node.arguments[1]){
      const body=node.arguments[1].getText(inspectorAst);
      if(body.includes('const enterPromise='))primaryCallback=node.arguments[1];
      if(resume?body.includes("operation:'resume-headset'"):body.includes('const enterPromise='))callback=node.arguments[1];
    }
    ts.forEachChild(node,visit);
  };visit(inspectorAst);expect(callback).toBeDefined();
  Object.assign(t.h,{entryClicks:0,trustedClick:false,mode:'immersive-ar',resumeMode:'immersive-ar',arSupported:true,
    isCompanion:false,navigator:{},refresh:{hidden:true},enterImmersiveWithFallback,
    isAppleSafariXr,watchMicrophonePermission,microphonePromptHoldsEntry,microphoneNoticeCopy,pushToTalkMicrophoneState,MICROPHONE_PROMPT_REFUSED_COPY,MICROPHONE_PROMPT_WAITING_COPY,
    recordHeadsetEvent:(kind:string,detail:any)=>errors.push({kind,detail}),thrownErrorMessage:String,
    setTimeout:()=>1});
  t.h.workspace.viewer.xr.enter=(mode:string)=>{
    t.h.startupState={phase:'requesting-headset',pending:true};
    return new Promise((resolve,reject)=>requests.push({mode,resolve,reject}));
  };
  for(const name of ['microphonePermission','microphonePromptHolds'])runDeclaration(name,t.h);
  vm.runInContext(ts.transpileModule(`var clickEntry=${callback!.getText(inspectorAst)};`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,t.h);
  vm.runInContext(ts.transpileModule(`var clickPrimaryEntry=${primaryCallback!.getText(inspectorAst)};`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,t.h);
  return{...t,requests,errors,click:()=>t.h.clickEntry({isTrusted:true}),primaryClick:()=>t.h.clickPrimaryEntry({isTrusted:true})};
}

describe('native XR presentation edge refreshes the actual entry UI',()=>{
  it('keeps native cleanup pending in the actual startup API after phase becomes idle',()=>{
    const source=readFileSync(new URL('../../lab/browser-roundtrip/immersive-session.mjs',import.meta.url),'utf8');
    const start=source.indexOf('startup: () => {'),end=source.indexOf('\n    } });',start);
    expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start);
    const c:any=vm.createContext({active:undefined,entering:undefined,ending:Promise.resolve(),startupPhase:'idle',reloadRequired:false,
      requestedMode:null,gestureActive:null,frameCount:0,viewCount:0,liveBlendMode:()=>null,errorName:null,
      canvas:{xr:{isPresenting:{value:false}}},sessionVisibility:'visible',pendingEntry:null});
    vm.runInContext(`var api=({${source.slice(start,end+6)}});`,c);
    expect(c.api.startup()).toMatchObject({phase:'idle',presenting:false,pending:true});
    c.ending=undefined;expect(c.api.startup().pending).toBe(false);
  });
  it('a late entry finalizer cannot enable a new request before native cleanup ends',async()=>{
    const t=entryHarness();t.click();t.h.startupState={phase:'preparing-menu',pending:true};t.native.emit(true);await flush();
    t.h.startupState={phase:'idle',pending:true};t.native.emit(false);await flush();
    t.requests[0].reject(Error('The XR session or source changed during replacement.'));await flush();await flush();
    expect(t.h.xrPending).toBe(false);expect(t.ar.disabled).toBe(true);expect(t.vr.disabled).toBe(true);
    expect(t.h.note.textContent).toBe('Closing headset view…');t.primaryClick();expect(t.requests).toHaveLength(1);
    t.h.startupState={phase:'idle',pending:false};await t.h.syncXr();expect(t.ar.disabled).toBe(false);
    t.primaryClick();expect(t.requests).toHaveLength(2);expect(t.h.xrPending).toBe(true);
    t.h.startupState={phase:'active',pending:false};t.requests[1].resolve();await flush();await flush();
  });
  it.each([false,true])('a native exit during %s menu startup never launches AR fallback before its request settles',async resume=>{
    const t=entryHarness(resume);t.click();expect(t.requests).toHaveLength(1);
    t.h.startupState={phase:'preparing-menu',pending:true};t.native.emit(true);await flush();
    t.native.emit(false);await flush();expect(t.h.xrPending).toBe(true);
    // The native AR session was already granted. Entry can reject when the
    // now-ended session's appearance/menu work notices the changed session.
    // That is not an AR permission refusal and must never issue a VR retry.
    t.h.startupState={phase:'idle',pending:false};t.requests[0].reject(Error('The XR session or source changed during replacement.'));
    await flush();await flush();
    expect(t.requests).toHaveLength(1);expect(t.h.xrPending).toBe(false);
    expect(t.ar.disabled).toBe(false);expect(t.vr.disabled).toBe(false);expect(t.errors).toEqual([]);
    expect(t.h.note.dataset.state).toBe('connected');expect(t.h.refresh.hidden).toBe(true);
  });
  it.each([false,true])('recovers an early native exit from a still-unsettled %s entry promise without a stale retry',async resume=>{
    const t=entryHarness(resume);t.click();expect(t.requests).toHaveLength(1);
    t.h.startupState={phase:'preparing-menu',pending:true};t.native.emit(true);await flush();
    t.native.emit(false);await flush();expect(t.h.xrPending).toBe(true);
    t.h.startupState={phase:'idle',pending:true};await t.h.syncXr();expect(t.h.xrPending).toBe(true);
    t.h.startupState={phase:'idle',pending:false};await t.h.syncXr();
    expect(t.h.xrPending).toBe(false);expect(t.ar.disabled).toBe(false);expect(t.h.note.dataset.state).toBe('connected');
    // The first promise has not answered. A new trusted entry is nevertheless
    // safe once native cleanup says idle, and owns its own pending flag.
    t.primaryClick();expect(t.requests).toHaveLength(2);expect(t.h.xrPending).toBe(true);
    t.requests[0].reject(Error('old entry ended during menu setup'));await flush();await flush();
    expect(t.requests).toHaveLength(2);expect(t.h.xrPending).toBe(true);expect(t.errors).toEqual([]);
    t.requests[1].resolve();await flush();await flush();expect(t.h.xrPending).toBe(false);
  });
  it('keeps a genuine request or consent prompt pending and blocks duplicate clicks',async()=>{
    const t=entryHarness();t.click();t.click();expect(t.requests).toHaveLength(1);
    await t.h.syncXr();expect(t.h.xrPending).toBe(true);expect(t.ar.disabled).toBe(true);
    // An initial idle snapshot does not prove an exit: this attempt has never
    // presented a native session, so it still awaits its actual request.
    t.h.startupState={phase:'idle',pending:false};await t.h.syncXr();
    expect(t.h.xrPending).toBe(true);expect(t.ar.disabled).toBe(true);t.click();expect(t.requests).toHaveLength(1);
    t.requests[0].resolve();await flush();await flush();expect(t.h.xrPending).toBe(false);
  });
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

const QUEST_BROWSER='Mozilla/5.0 (X11; Linux x86_64; Quest 2) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/41.0 Chrome/138.0 Mobile VR Safari/537.36';
const SAFARI='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/26.0 Safari/605.1.15';
type Permission='granted'|'denied'|'prompt'|'unqueryable';
// The real Enter VR press on the companion page, with the browser's
// microphone, permission status and session request replaced by stubs that
// record each call in order. `voice` is what the host's heartbeat last said
// about voice capture (undefined: nothing yet); `resume` presses the resume
// button instead of Enter VR.
async function microphoneEntryHarness(permission:Permission,userAgent=QUEST_BROWSER,options:{voice?:boolean;resume?:boolean}={}){
  const voice='voice' in options?options.voice:true,resume=options.resume===true;
  const t=entryHarness(resume),calls:string[]=[],watchdogs:Array<()=>void>=[];
  const prompts:Array<{resolve:(stream:unknown)=>void;reject:(error:Error)=>void}>=[];
  const track={kind:'audio',readyState:'live',enabled:true,stop(){track.readyState='ended';}};
  const stream={getTracks:()=>[track]};
  const status={state:(permission==='unqueryable'?undefined:permission) as Permission|undefined,listeners:new Set<()=>void>(),
    addEventListener(type:string,listener:()=>void){expect(type).toBe('change');status.listeners.add(listener);},
    removeEventListener(_type:string,listener:()=>void){status.listeners.delete(listener);},
    set(state:Permission){status.state=state;for(const listener of status.listeners)listener();}};
  const media={getUserMedia(){
    calls.push('getUserMedia');
    if(status.state==='granted')return Promise.resolve(stream);
    if(status.state==='denied')return Promise.reject(Object.assign(Error('Permission denied'),{name:'NotAllowedError'}));
    return new Promise((resolve,reject)=>prompts.push({resolve,reject}));
  }};
  const navigator={userAgent,xr:{},...(permission==='unqueryable'?{}:{permissions:{query:async()=>status}})};
  Object.assign(t.h,{isCompanion:true,navigator,hostVoiceCapture:voice,
    primePushToTalkMicrophone:()=>{calls.push('prime');return primePushToTalkMicrophone({media});},
    setTimeout:(callback:()=>void,ms:number)=>{calls.push(`timer ${ms}`);watchdogs.push(callback);return watchdogs.length;}});
  // The page's own permission reader, made for this browser.
  runDeclaration('microphonePermission',t.h);
  t.h.workspace.viewer.xr.enter=(mode:string)=>{
    calls.push(`requestSession ${mode}`);
    t.h.startupState={phase:'requesting-headset',pending:true,reloadRequired:false};
    return new Promise((resolve,reject)=>t.requests.push({mode,resolve,reject}));
  };
  await flush();
  // The viewer's own startup report once a request settles.
  const refuse=async(reloadRequired=false)=>{
    // The passthrough refusal is followed by the plain VR retry, refused too.
    while(t.requests.length) {
      const request=t.requests.shift()!;
      t.h.startupState={phase:'idle',pending:false,reloadRequired};
      request.reject(Object.assign(Error('The request was refused.'),{name:'NotAllowedError'}));
      await flush();await flush();
    }
    await flush();
  };
  const accept=async()=>{
    t.h.startupState={phase:'active',pending:false,reloadRequired:false};
    const request=t.requests.splice(0)[0]!;t.native.emit(true);request.resolve();await flush();await flush();
  };
  const press=()=>{const from=calls.length;if(resume)t.click();else t.primaryClick();return calls.slice(from);};
  return{...t,calls,watchdogs,prompts,status,stream,refuse,accept,press};
}

describe('Enter VR asks for the microphone only when a voice route will use it',()=>{
  afterEach(()=>releasePushToTalkMicrophone());
  const FAILURE='Could not open the headset view. Try again.';
  for(const resume of [false,true]) {
    const button=resume?'the resume button':'Enter VR',watchdog=resume?[]:['timer 15000'];
    for(const [voice,said] of [[true,'on'],[undefined,'not reported yet']] as const) {
      it(`${button} with voice ${said} makes today’s calls, in order, inside the gesture`,async()=>{
        const t=await microphoneEntryHarness('prompt',QUEST_BROWSER,{voice,resume});
        expect(t.press()).toEqual([...watchdog,'prime','getUserMedia','requestSession immersive-ar']);
        expect(t.prompts).toHaveLength(1);
      });
    }
    it(`${button} with voice off asks for no microphone and still requests the session`,async()=>{
      const t=await microphoneEntryHarness('prompt',QUEST_BROWSER,{voice:false,resume});
      expect(t.press()).toEqual([...watchdog,'requestSession immersive-ar']);
      expect(t.prompts).toHaveLength(0);expect(pushToTalkMicrophoneState()).toBe('idle');
      await t.accept();
      expect(t.h.note.textContent).toBe('Headset view open. Use the floating menu to control the tour.');
    });
    it(`${button} with voice off reports a refused request as the failure it is, since no prompt was opened`,async()=>{
      const t=await microphoneEntryHarness('prompt',QUEST_BROWSER,{voice:false,resume});
      t.press();await t.refuse();
      expect(t.h.note.textContent).toBe(FAILURE);expect(t.h.refresh.hidden).toBe(false);
      expect(t.calls).not.toContain('getUserMedia');
    });
  }
  it('follows the latest heartbeat: a host that turns voice on gets the ask on the next press',async()=>{
    const t=await microphoneEntryHarness('prompt',QUEST_BROWSER,{voice:false});
    expect(t.press()).toEqual(['timer 15000','requestSession immersive-ar']);
    await t.refuse();
    t.h.hostVoiceCapture=true;
    expect(t.press()).toEqual(['timer 15000','prime','getUserMedia','requestSession immersive-ar']);
    // The sentence for a press held up by its own prompt is unchanged with voice on.
    await t.refuse();
    expect(t.h.note.textContent).toBe(MICROPHONE_PROMPT_REFUSED_COPY);expect(t.h.refresh.hidden).toBe(true);
  });
  it('Safari is still never asked, whatever the host says',async()=>{
    for(const voice of [true,false,undefined]) {
      const t=await microphoneEntryHarness('prompt',SAFARI,{voice});
      expect(t.press()).toEqual(['timer 15000','requestSession immersive-ar']);
    }
  });
});

describe('Enter VR while the microphone permission is still undecided',()=>{
  afterEach(()=>releasePushToTalkMicrophone());
  const FAILURE='Could not open the headset view. Try again.';

  it.each(['granted','denied','prompt','unqueryable'] as const)('a press with the permission %s makes today’s calls, in order, inside the gesture',async permission=>{
    const t=await microphoneEntryHarness(permission);
    // Everything below is recorded synchronously by the click itself, so no
    // call waits on a promise and the session request keeps the activation.
    expect(t.press()).toEqual(['timer 15000','prime','getUserMedia','requestSession immersive-ar']);
    t.requests[0]!.reject(Error('Passthrough refused.'));await flush();
    expect(t.calls.slice(4)).toEqual(['requestSession immersive-vr']);
  });

  it.each(['granted','denied','unqueryable'] as const)('a refused request with the permission %s still shows the failure and the reload button',async permission=>{
    const t=await microphoneEntryHarness(permission);
    t.press();await t.refuse();
    expect(t.h.note.textContent).toBe(FAILURE);expect(t.h.note.dataset.state).toBe('error');expect(t.h.refresh.hidden).toBe(false);
  });

  it('a refused request on Safari still shows the failure and asks for no microphone',async()=>{
    const t=await microphoneEntryHarness('prompt',SAFARI);
    expect(t.press()).toEqual(['timer 15000','requestSession immersive-ar']);
    await t.refuse();
    expect(t.h.note.textContent).toBe(FAILURE);expect(t.h.refresh.hidden).toBe(false);
  });

  it('a request refused while the prompt it opened is up asks the wearer to answer it and press again, and the next press enters',async()=>{
    const t=await microphoneEntryHarness('prompt');
    t.press();expect(t.prompts).toHaveLength(1);
    await t.refuse();
    expect(t.h.note.textContent).toBe('Answer the microphone prompt, then press Enter VR again.');
    expect(t.h.note.dataset.state).not.toBe('error');expect(t.h.refresh.hidden).toBe(true);expect(t.ar.disabled).toBe(false);
    // The two-second refresh keeps the sentence rather than restoring the idle line.
    await t.h.syncXr();expect(t.h.note.textContent).toBe(MICROPHONE_PROMPT_REFUSED_COPY);expect(t.h.refresh.hidden).toBe(true);
    // The diagnostic still records the refusal, marked as the prompt's.
    expect(t.errors).toEqual([{kind:'page-error',detail:{operation:'enter-headset',message:'NotAllowedError: The request was refused.',microphonePrompt:true}}]);
    // The wearer answers Allow and presses again: the held grant is reused, so
    // no second prompt opens, and the session starts.
    t.status.set('granted');t.prompts[0]!.resolve(t.stream);await flush();
    expect(t.press()).toEqual(['timer 15000','prime','requestSession immersive-ar']);
    expect(t.h.note.textContent).toBe('Entering headset view…');
    await t.accept();
    expect(t.h.note.textContent).toBe('Headset view open. Use the floating menu to control the tour.');expect(t.h.refresh.hidden).toBe(true);
  });

  it('a second press with the prompt still unanswered makes today’s calls and enters',async()=>{
    const t=await microphoneEntryHarness('prompt');
    t.press();await t.refuse();
    // The first request is still waiting on the prompt, so the priming shares it.
    expect(t.press()).toEqual(['timer 15000','prime','requestSession immersive-ar']);
    await t.accept();
    expect(t.h.note.textContent).toBe('Headset view open. Use the floating menu to control the tour.');
  });

  it('a request that stalls behind the prompt asks for the prompt at the watchdog, and a reload only once the page needs one',async()=>{
    const t=await microphoneEntryHarness('prompt');
    t.press();expect(t.watchdogs).toHaveLength(1);
    t.watchdogs[0]!();
    expect(t.h.note.textContent).toBe('Answer the microphone prompt to continue.');
    expect(t.h.note.dataset.state).not.toBe('error');expect(t.h.refresh.hidden).toBe(true);
    await t.h.syncXr();expect(t.h.note.textContent).toBe(MICROPHONE_PROMPT_WAITING_COPY);expect(t.ar.disabled).toBe(true);
    // The request deadline leaves the page needing a reload, which the next
    // press cannot serve, so that is a real failure.
    await t.refuse(true);
    expect(t.h.note.textContent).toBe(FAILURE);expect(t.h.refresh.hidden).toBe(false);
  });

  it('a stalled request without an open prompt keeps the watchdog’s reload text',async()=>{
    const t=await microphoneEntryHarness('granted');
    t.press();await flush();t.watchdogs[0]!();
    expect(t.h.note.textContent).toBe('The headset hasn’t accepted the passthrough request. Reload to try again.');
    expect(t.h.refresh.hidden).toBe(false);
  });

  it('a wearer who dismisses the prompt can press again, and is told the same thing if the new prompt blocks entry',async()=>{
    const t=await microphoneEntryHarness('prompt');
    t.press();await t.refuse();
    expect(t.h.note.textContent).toBe(MICROPHONE_PROMPT_REFUSED_COPY);
    // Dismissing leaves the permission undecided and rejects the request,
    // so the prompt the sentence asked about has closed.
    t.prompts[0]!.reject(Object.assign(Error('Permission dismissed'),{name:'NotAllowedError'}));await flush();await flush();
    expect(t.h.note.textContent).toBe('Press Enter VR again.');
    // The next press asks again, so a new prompt opens.
    expect(t.press()).toEqual(['timer 15000','prime','getUserMedia','requestSession immersive-ar']);
    await t.refuse();
    expect(t.h.note.textContent).toBe(MICROPHONE_PROMPT_REFUSED_COPY);expect(t.h.refresh.hidden).toBe(true);expect(t.ar.disabled).toBe(false);
    // Dismissed again, then a press whose request is accepted enters.
    t.prompts[1]!.reject(Object.assign(Error('Permission dismissed'),{name:'NotAllowedError'}));await flush();await flush();
    expect(t.press()).toEqual(['timer 15000','prime','getUserMedia','requestSession immersive-ar']);
    await t.accept();
    expect(t.h.note.textContent).toBe('Headset view open. Use the floating menu to control the tour.');
  });

  it.each(['granted','denied'] as const)('a refused press’s sentence follows the prompt answered %s, with no second press',async answer=>{
    const t=await microphoneEntryHarness('prompt');
    t.press();await t.refuse();
    expect(t.h.note.textContent).toBe(MICROPHONE_PROMPT_REFUSED_COPY);
    const callsBefore=t.calls.length;
    // The wearer answers and does not press. The permission change itself
    // redraws the line, with no wait for the two-second refresh.
    t.status.set(answer);
    if(answer==='granted')t.prompts[0]!.resolve(t.stream);
    else t.prompts[0]!.reject(Object.assign(Error('Permission denied'),{name:'NotAllowedError'}));
    await flush();await flush();
    expect(t.h.note.textContent).toBe('Press Enter VR again.');
    await t.h.syncXr();
    expect(t.h.note.textContent).toBe('Press Enter VR again.');
    expect(t.h.note.dataset.state).not.toBe('error');expect(t.h.refresh.hidden).toBe(true);expect(t.ar.disabled).toBe(false);
    // Redrawing the line asks for nothing: no microphone, no session.
    expect(t.calls.slice(callsBefore)).toEqual([]);
  });

  it('a refused press’s sentence stops asking about a dismissed prompt, though the permission stays undecided',async()=>{
    const t=await microphoneEntryHarness('prompt');
    t.press();await t.refuse();
    t.prompts[0]!.reject(Object.assign(Error('Permission dismissed'),{name:'NotAllowedError'}));await flush();await flush();
    expect(t.status.state).toBe('prompt');
    await t.h.syncXr();
    expect(t.h.note.textContent).toBe('Press Enter VR again.');expect(t.h.refresh.hidden).toBe(true);
    expect(t.h.note.dataset.state).not.toBe('error');expect(t.ar.disabled).toBe(false);
  });

  it('a dismissed prompt redraws the refused press’s sentence at once, with no second press and no call',async()=>{
    const t=await microphoneEntryHarness('prompt');
    t.press();await t.refuse();
    expect(t.h.note.textContent).toBe(MICROPHONE_PROMPT_REFUSED_COPY);
    const callsBefore=t.calls.length;
    // No permission change fires: the settled microphone request redraws the
    // line, with no wait for the two-second refresh.
    t.prompts[0]!.reject(Object.assign(Error('Permission dismissed'),{name:'NotAllowedError'}));await flush();await flush();await flush();
    expect(t.h.note.textContent).toBe('Press Enter VR again.');
    expect(t.calls.slice(callsBefore)).toEqual([]);
  });

  it('the waiting sentence goes once the prompt is dismissed while the request is still pending',async()=>{
    const t=await microphoneEntryHarness('prompt');
    t.press();t.watchdogs[0]!();
    expect(t.h.note.textContent).toBe(MICROPHONE_PROMPT_WAITING_COPY);
    t.prompts[0]!.reject(Object.assign(Error('Permission dismissed'),{name:'NotAllowedError'}));await flush();await flush();await flush();
    expect(t.status.state).toBe('prompt');
    expect(t.h.note.textContent).toBe('Opening headset view — check for a permission prompt.');
    await t.h.syncXr();
    expect(t.h.note.textContent).toBe('Opening headset view — check for a permission prompt.');
  });

  it('the waiting sentence goes once the prompt is answered while the request is still pending',async()=>{
    const t=await microphoneEntryHarness('prompt');
    t.press();t.watchdogs[0]!();
    expect(t.h.note.textContent).toBe(MICROPHONE_PROMPT_WAITING_COPY);
    t.status.set('granted');t.prompts[0]!.resolve(t.stream);await flush();await flush();
    expect(t.h.note.textContent).toBe('Opening headset view — check for a permission prompt.');
    await t.h.syncXr();
    expect(t.h.note.textContent).toBe('Opening headset view — check for a permission prompt.');
    expect(t.h.refresh.hidden).toBe(true);
    // The request it was waiting on still decides the entry.
    await t.accept();
    expect(t.h.note.textContent).toBe('Headset view open. Use the floating menu to control the tour.');
  });

  it('a refusal after the wearer dismissed the prompt is a real failure',async()=>{
    const t=await microphoneEntryHarness('prompt');
    t.press();
    t.prompts[0]!.reject(Object.assign(Error('Permission dismissed'),{name:'NotAllowedError'}));await flush();await flush();
    await t.refuse();
    expect(t.h.note.textContent).toBe(FAILURE);expect(t.h.refresh.hidden).toBe(false);
  });
});

describe('an Enter VR press that lands while the scene is changing',()=>{
  afterEach(()=>{releasePushToTalkMicrophone();vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();});
  const SCENE_CHANGING='The scene is still changing. Press again.';
  const OPEN='Headset view open. Use the floating menu to control the tour.';
  const FAILURE_COPY='Could not open the headset view. Try again.';
  // The refusal the viewer makes before any session request while a load, a
  // replacement or a chapter turn is in flight (`immersive-session.mjs`).
  const notReadyRefusal=()=>Object.assign(Error('Load a ready structure before entering immersion.'),{code:'xr_unavailable',notReady:true});
  // The real press on a viewer whose scene is ready or not. Frames come one
  // every 16 ms of a scripted clock; `wait` runs them.
  async function sceneHarness(readyAtPress:boolean,options:{resume?:boolean;permission?:Permission}={}){
    const t=await microphoneEntryHarness(options.permission??'granted',QUEST_BROWSER,{resume:options.resume});
    const scene={ready:readyAtPress,reads:0,attempts:[] as string[]};
    let clock=1000;const frames:Array<()=>void>=[];
    vi.stubGlobal('requestAnimationFrame',(callback:()=>void)=>frames.push(callback));
    vi.spyOn(performance,'now').mockImplementation(()=>clock);
    t.h.workspace.viewer.readiness=()=>{scene.reads++;return{ready:scene.ready,interactionActive:false};};
    t.h.XR_SCENE_CHANGING_COPY=(entryFallback as Record<string,unknown>).XR_SCENE_CHANGING_COPY;
    // A resume button is up only while the viewer owes the wearer that press.
    if(options.resume)t.h.startupState={...t.h.startupState,pendingEntry:{mode:'immersive-ar',reason:'refused'}};
    const request=t.h.workspace.viewer.xr.enter;
    t.h.workspace.viewer.xr.enter=(mode:string)=>{scene.attempts.push(mode);return scene.ready?request(mode):Promise.reject(notReadyRefusal());};
    // Every line the status note shows, in order.
    const shown:string[]=[];let text='';
    Object.defineProperty(t.h.note,'textContent',{get:()=>text,set:(value:string)=>{text=value;shown.push(value);},configurable:true});
    const wait=async(ms:number)=>{const end=clock+ms;await flush();while(clock<end){clock+=16;for(const frame of frames.splice(0))frame();await flush();}};
    // Time passes with no frame delivered, as in a hidden page. Needs fake timers.
    const stall=async(ms:number)=>{await flush();clock+=ms;vi.advanceTimersByTime(ms);await flush();await flush();};
    const sessions=()=>t.calls.filter(call=>call.startsWith('requestSession'));
    return{...t,scene,wait,stall,sessions,shown};
  }
  for(const resume of [false,true]) {
    const button=resume?'the resume button':'Enter VR',watchdog=resume?[]:['timer 15000'];
    it(`${button}: a scene ready at the press makes today’s calls, in order, inside the gesture, and reads no readiness`,async()=>{
      const t=await sceneHarness(true,{resume,permission:'prompt'});
      expect(t.press()).toEqual([...watchdog,'prime','getUserMedia','requestSession immersive-ar']);
      expect(t.scene.reads).toBe(0);expect(t.scene.attempts).toEqual(['immersive-ar']);
    });
    it(`${button}: a scene ready a second after the press enters on that press, with one session request`,async()=>{
      const t=await sceneHarness(false,{resume,permission:'prompt'});
      // The microphone is still asked inside the press, before any wait.
      expect(t.press()).toEqual([...watchdog,'prime','getUserMedia']);
      await t.wait(500);
      expect(t.sessions()).toEqual([]);expect(t.h.note.textContent).toBe('Entering headset view…');
      expect(t.h.xrPending).toBe(true);expect(t.h.refresh.hidden).toBe(true);
      // Nothing else may start a request meanwhile.
      t.press();expect(t.scene.attempts).toEqual(['immersive-ar']);
      t.scene.ready=true;await t.wait(500);
      expect(t.sessions()).toEqual(['requestSession immersive-ar']);
      await t.accept();
      expect(t.sessions()).toEqual(['requestSession immersive-ar']);
      expect(t.h.note.textContent).toBe(OPEN);expect(t.h.refresh.hidden).toBe(true);
      expect(t.shown).not.toContain(FAILURE_COPY);expect(t.errors).toEqual([]);
    });
    it(`${button}: a scene still changing after the wait asks for nothing, says so without a reload, and the next press enters`,async()=>{
      const t=await sceneHarness(false,{resume});
      t.press();await t.wait(5000);
      expect(t.sessions()).toEqual([]);expect(t.h.xrPending).toBe(false);
      expect(t.h.note.textContent).toBe(SCENE_CHANGING);
      expect(t.h.note.dataset.state).not.toBe('error');expect(t.h.refresh.hidden).toBe(true);
      // The two-second refresh keeps the sentence.
      await t.h.syncXr();
      expect(t.h.note.textContent).toBe(SCENE_CHANGING);expect(t.h.refresh.hidden).toBe(true);
      t.scene.ready=true;
      expect(t.press().at(-1)).toBe('requestSession immersive-ar');
      expect(t.h.note.textContent).toBe('Entering headset view…');
      await t.accept();
      expect(t.h.note.textContent).toBe(OPEN);expect(t.sessions()).toEqual(['requestSession immersive-ar']);
    });
    it(`${button}: a page that gets no frame during the wait still gives up at the bound, without a reload`,async()=>{
      const t=await sceneHarness(false,{resume});
      vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
      t.press();await t.stall(1000);
      // The Enter VR watchdog may fire while the page is hidden and the wait stalls.
      if(!resume){expect(t.watchdogs).toHaveLength(1);t.watchdogs[0]!();expect(t.h.refresh.hidden).toBe(false);}
      await t.stall(4000);
      expect(t.sessions()).toEqual([]);expect(t.h.xrPending).toBe(false);
      expect(t.ar.disabled).toBe(false);expect(t.h.resumeButton.disabled).toBe(false);
      expect(t.h.note.textContent).toBe(SCENE_CHANGING);
      expect(t.h.note.dataset.state).not.toBe('error');expect(t.h.refresh.hidden).toBe(true);
      await t.h.syncXr();expect(t.h.note.textContent).toBe(SCENE_CHANGING);
    });
    it(`${button}: a press refused only because the scene was changing never opens plain VR`,async()=>{
      const t=await sceneHarness(false,{resume});
      t.press();await t.wait(5000);
      expect(t.scene.attempts).toEqual(['immersive-ar']);
      expect(t.shown).not.toContain('Passthrough refused; opening plain VR…');
      expect(t.shown).not.toContain(FAILURE_COPY);
    });
  }
});

describe('Enter VR while a browser prompt holds the session request',()=>{
  afterEach(()=>{releasePushToTalkMicrophone();vi.useRealTimers();});
  const FAILURE='Could not open the headset view. Try again.';
  const OPEN='Headset view open. Use the floating menu to control the tour.';
  const BUSY='Opening headset view — check for a permission prompt.';
  const HEADSET_PROMPT_WAITING_COPY=(entryMicrophone as Record<string,unknown>).HEADSET_PROMPT_WAITING_COPY;
  // The real press, with the viewer's session request bounded by the real
  // deadline the way `immersive-session.mjs` bounds it. `headset` is what the
  // browser answers for the headset-access permission.
  async function promptHarness({microphone,headset,voice=true}:{microphone:Permission;headset:Permission;voice?:boolean}){
    const t=await microphoneEntryHarness(microphone,QUEST_BROWSER,{voice});
    const headsetStatus={state:(headset==='unqueryable'?undefined:headset) as Permission|undefined,listeners:new Set<()=>void>(),
      addEventListener(type:string,listener:()=>void){expect(type).toBe('change');headsetStatus.listeners.add(listener);},
      removeEventListener(_type:string,listener:()=>void){headsetStatus.listeners.delete(listener);},
      set(state:Permission){headsetStatus.state=state;for(const listener of headsetStatus.listeners)listener();}};
    // Desktop Chromium refuses every XR permission name with a TypeError.
    const query=async({name}:{name:string})=>{
      if(name==='microphone')return t.status;
      if(headset==='unqueryable')throw TypeError(`The provided value '${name}' is not a valid enum value of type PermissionName.`);
      return headsetStatus;
    };
    t.h.navigator={...t.h.navigator,permissions:{query}};
    t.h.HEADSET_PROMPT_WAITING_COPY=HEADSET_PROMPT_WAITING_COPY;
    runDeclaration('microphonePermission',t.h);
    await flush();
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
    const grants:Array<{mode:string;resolve:(session:unknown)=>void}>=[],asked:unknown[][]=[];
    let reloadRequired=false;
    const session={end:vi.fn(async()=>{})};
    const runtime={requestSession:(mode:string)=>new Promise(resolve=>grants.push({mode,resolve}))};
    t.h.workspace.viewer.xr.enter=(mode:string,...options:unknown[])=>{
      if(reloadRequired)return Promise.reject(Error('Reload this page to clear the previous headset request.'));
      t.calls.push(`requestSession ${mode}`);asked.push(options);
      t.h.startupState={phase:'requesting-headset',pending:true,reloadRequired:false};
      const awaitsPrompt=(options[0] as {awaitsPrompt?:unknown}|undefined)?.awaitsPrompt===true;
      return requestHeadsetSession(runtime,mode,{timeoutMs:headsetEntryDeadlineMs(t.h.navigator),awaitsPrompt,onTimeout:()=>{reloadRequired=true;}})
        .then((granted:unknown)=>{t.h.startupState={phase:'active',pending:false,reloadRequired:false};t.native.emit(true);return granted;},
          (error:Error)=>{t.h.startupState={phase:'idle',pending:false,reloadRequired};throw error;});
    };
    const shown:string[]=[];let text='';
    Object.defineProperty(t.h.note,'textContent',{get:()=>text,set:(value:string)=>{text=value;shown.push(value);},configurable:true});
    const elapse=async(ms:number)=>{await vi.advanceTimersByTimeAsync(ms);await flush();await flush();};
    return{...t,grants,asked,session,headsetStatus,elapse,shown,reloadRequired:()=>reloadRequired};
  }

  it('a microphone prompt answered after 30 s still enters from the one press, with no reload',async()=>{
    const t=await promptHarness({microphone:'prompt',headset:'unqueryable'});
    expect(t.press()).toEqual(['timer 15000','prime','getUserMedia','requestSession immersive-ar']);
    expect(t.asked).toEqual([[{awaitsPrompt:true}]]);
    await t.elapse(15_000);t.watchdogs[0]!();
    expect(t.h.note.textContent).toBe(MICROPHONE_PROMPT_WAITING_COPY);
    await t.elapse(15_000);await t.h.syncXr();
    expect(t.reloadRequired()).toBe(false);
    expect(t.h.note.textContent).toBe(MICROPHONE_PROMPT_WAITING_COPY);
    expect(t.h.refresh.hidden).toBe(true);expect(t.h.note.dataset.state).not.toBe('error');
    // The wearer allows the microphone, then the headset-access prompt behind it.
    t.status.set('granted');t.prompts[0]!.resolve(t.stream);await t.elapse(0);
    expect(t.h.note.textContent).toBe(BUSY);
    t.grants[0]!.resolve(t.session);await t.elapse(0);
    expect(t.h.note.textContent).toBe(OPEN);expect(t.session.end).not.toHaveBeenCalled();
    expect(t.reloadRequired()).toBe(false);expect(t.h.refresh.hidden).toBe(true);
    expect(t.shown).not.toContain(FAILURE);
    expect(t.calls.filter(call=>call.startsWith('requestSession'))).toEqual(['requestSession immersive-ar']);
  });

  it('a headset-access permission that reads prompt at the press waits for the wearer, with or without a microphone ask',async()=>{
    for(const voice of [false,true]) {
      const t=await promptHarness({microphone:'granted',headset:'prompt',voice});
      expect(t.press()).toEqual(['timer 15000',...(voice?['prime','getUserMedia']:[]),'requestSession immersive-ar']);
      expect(t.asked).toEqual([[{awaitsPrompt:true}]]);
      await t.elapse(15_000);t.watchdogs[0]!();
      expect(t.h.note.textContent).toBe('Answer the prompt in the headset to continue.');
      expect(t.h.refresh.hidden).toBe(true);expect(t.h.note.dataset.state).not.toBe('error');
      await t.elapse(15_000);await t.h.syncXr();
      expect(t.h.note.textContent).toBe(HEADSET_PROMPT_WAITING_COPY);expect(t.reloadRequired()).toBe(false);
      t.headsetStatus.set('granted');t.grants[0]!.resolve(t.session);await t.elapse(0);
      expect(t.h.note.textContent).toBe(OPEN);expect(t.session.end).not.toHaveBeenCalled();
      expect(t.shown).not.toContain(FAILURE);
      releasePushToTalkMicrophone();vi.useRealTimers();
    }
  });

  it.each([
    ['granted','unqueryable',true],['granted','granted',true],['prompt','unqueryable',false],['prompt','granted',false],
  ] as const)('a press that expects no prompt (microphone %s, headset access %s, voice %s) keeps today’s 20 s deadline and reload',async(microphone,headset,voice)=>{
    const t=await promptHarness({microphone,headset,voice});
    expect(t.press()).toEqual(['timer 15000',...(voice?['prime','getUserMedia']:[]),'requestSession immersive-ar']);
    // The viewer is asked exactly as before: the mode and nothing else.
    expect(t.asked).toEqual([[]]);
    await t.elapse(15_000);t.watchdogs[0]!();
    expect(t.h.note.textContent).toBe('The headset hasn’t accepted the passthrough request. Reload to try again.');
    await t.elapse(4_999);expect(t.reloadRequired()).toBe(false);
    await t.elapse(1);
    expect(t.reloadRequired()).toBe(true);
    expect(t.h.note.textContent).toBe(FAILURE);expect(t.h.refresh.hidden).toBe(false);
    expect(t.grants).toHaveLength(1);
  });

  it('a prompt nobody answers still ends at the long bound, needing a reload as today',async()=>{
    const t=await promptHarness({microphone:'prompt',headset:'unqueryable'});
    t.press();await t.elapse(15_000);t.watchdogs[0]!();
    await t.elapse(APPLE_PROMPT_DEADLINE_MS-15_001);
    expect(t.reloadRequired()).toBe(false);expect(t.h.note.textContent).toBe(MICROPHONE_PROMPT_WAITING_COPY);
    await t.elapse(1);
    expect(t.reloadRequired()).toBe(true);
    expect(t.h.note.textContent).toBe(FAILURE);expect(t.h.refresh.hidden).toBe(false);
    // A grant after the bound is closed, and nothing asks again.
    t.grants[0]!.resolve(t.session);await t.elapse(0);
    expect(t.session.end).toHaveBeenCalledOnce();expect(t.grants).toHaveLength(1);
  });

  it.each(['dismissed','denied'] as const)('a microphone prompt %s while the request waits still lets the headset-access prompt enter',async answer=>{
    const t=await promptHarness({microphone:'prompt',headset:'unqueryable'});
    t.press();await t.elapse(15_000);t.watchdogs[0]!();
    expect(t.h.note.textContent).toBe(MICROPHONE_PROMPT_WAITING_COPY);
    await t.elapse(10_000);
    if(answer==='denied')t.status.set('denied');
    t.prompts[0]!.reject(Object.assign(Error(`Permission ${answer}`),{name:'NotAllowedError'}));await t.elapse(0);
    // The priming gave up waiting at 10 s, so the two-second refresh redraws the line.
    await t.h.syncXr();
    expect(t.h.note.textContent).toBe(BUSY);
    await t.elapse(10_000);
    expect(t.reloadRequired()).toBe(false);
    t.grants[0]!.resolve(t.session);await t.elapse(0);
    expect(t.h.note.textContent).toBe(OPEN);expect(t.session.end).not.toHaveBeenCalled();
    expect(t.shown).not.toContain(FAILURE);expect(t.grants).toHaveLength(1);
  });
});
