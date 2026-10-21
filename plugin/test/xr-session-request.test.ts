import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {afterEach,expect,it,vi} from 'vitest';
// @ts-ignore Shared browser helper is exercised without a headset runtime.
import {applyFoveation,trackFoveation,entryFallbackCopy,entryRefusalReason,foveationLevelFor,APPLE_PROMPT_DEADLINE_MS,HEADSET_ENTRY_DEADLINE_MS,HEADSET_OPTIONAL_FEATURES,headsetEntryDeadlineMs,headsetOptionalFeatures,isAppleSafariXr,passthroughPlan,restorePassthroughOnEntry,readPassthroughPreference,storePassthroughPreference,requestHeadsetSession} from '../../lab/browser-roundtrip/xr-session-request.mjs';

// Run the shipped controller action, including its post-switch logic. The
// helper alone cannot prove that pending user intent survives another entry.
async function passthroughActionHarness() {
  const source=await readFile(new URL('../../lab/browser-roundtrip/viewer.mjs',import.meta.url),'utf8');
  const start=source.indexOf('  async function setPassthrough(on) {');
  expect(start).toBeGreaterThan(0);
  const toggle=vi.fn(()=>true), switchMode=vi.fn(async()=>({switched:false}));
  const context=vm.createContext({passthroughPlan,preferredPassthrough:false,passthroughOn:false,
    blendMode:'opaque',canvas:{xr:{isPresenting:{value:true}},requestDraw:vi.fn()},
    storePassthroughPreference:vi.fn(),firePassthroughToggle:toggle,recordManipulation:vi.fn(),talkCaption:undefined,
    switchImmersiveMode:switchMode});
  context.immersiveSession={environmentBlendMode:()=>context.blendMode,refreshToolbar:async()=>{}};
  vm.runInContext(source.slice(start,source.indexOf('\n  }',start)+4),context);
  return {context,toggle,switchMode};
}

it('keeps a pending Room-on request through the physical press that finishes AR entry',async()=>{
  const {context,toggle,switchMode}=await passthroughActionHarness();
  switchMode.mockResolvedValue({switched:false,pending:'immersive-ar'} as any);
  expect(await context.setPassthrough(true)).toMatchObject({pending:'immersive-ar'});
  expect(context.preferredPassthrough).toBe(true);
  expect(restorePassthroughOnEntry({blendMode:'alpha-blend',preferred:context.preferredPassthrough,toggle}))
    .toEqual({on:true,restored:false});
  expect(toggle).not.toHaveBeenCalled();
  expect(switchMode).toHaveBeenCalledTimes(1);
});

it.each(['opaque','additive',null])('stops after one accepted AR switch with %s blend and reports the room unavailable',async blend=>{
  const {context,toggle,switchMode}=await passthroughActionHarness();
  switchMode.mockImplementation(async()=>{
    // Bound the old recursion so a regression fails rather than hanging.
    if(switchMode.mock.calls.length>1)throw Error('repeated switch');
    context.blendMode=blend;
    return {switched:true};
  });
  expect(await context.setPassthrough(true)).toMatchObject({switched:true,passthrough:false,mode:blend,unsupported:true});
  expect(switchMode).toHaveBeenCalledTimes(1);
  expect(toggle).not.toHaveBeenCalled();
  expect(context.preferredPassthrough).toBe(false);
});

it('applies Room on once after a successful alpha-blend switch restored an older off choice',async()=>{
  const {context,toggle,switchMode}=await passthroughActionHarness();
  switchMode.mockImplementation(async()=>{context.blendMode='alpha-blend';return {switched:true};});
  expect(await context.setPassthrough(true)).toMatchObject({switched:true,passthrough:true,mode:'alpha-blend'});
  expect(switchMode).toHaveBeenCalledTimes(1);
  expect(toggle).toHaveBeenCalledTimes(1);
  expect(context.preferredPassthrough).toBe(true);
  expect(context.passthroughOn).toBe(true);
});

it('keeps the prior Room choice when an unsupported switch retains the original session',async()=>{
  const {context,toggle,switchMode}=await passthroughActionHarness();
  switchMode.mockResolvedValue({switched:false,retained:true,unsupported:true,passthrough:false} as any);
  expect(await context.setPassthrough(true)).toMatchObject({retained:true,unsupported:true,passthrough:false});
  expect(context.preferredPassthrough).toBe(false);
  expect(toggle).not.toHaveBeenCalled();
});

it('restores Room off on each new alpha-blend entry without changing sessions',()=>{
  let room = true;
  const toggle = vi.fn(() => { room = !room; return true; });
  for (let entry=0;entry<3;entry++) {
    room = true; // Mol* seeds its private clear again on every session.
    expect(restorePassthroughOnEntry({blendMode:'alpha-blend',preferred:false,toggle}))
      .toEqual({on:false,restored:true});
    expect(room).toBe(false);
  }
  expect(toggle).toHaveBeenCalledTimes(3);
  for (const preferred of [undefined,true]) {
    expect(restorePassthroughOnEntry({blendMode:'alpha-blend',preferred,toggle}))
      .toEqual({on:true,restored:false});
  }
  for (const blendMode of ['opaque',null]) {
    expect(restorePassthroughOnEntry({blendMode,preferred:true,toggle}))
      .toEqual({on:false,restored:false});
  }
  expect(toggle).toHaveBeenCalledTimes(3);
});

it('reports the actual room state when restoring the clear fails',()=>{
  for (const toggle of [()=>false,()=>{throw Error('input gone');}]) {
    expect(restorePassthroughOnEntry({blendMode:'alpha-blend',preferred:false,toggle}))
      .toEqual({on:true,restored:false,failed:true});
  }
});

it('turns the room off inside the passthrough session instead of ending it',()=>{
  // Hiding the room used to mean a whole new session and a drop to the 2D
  // page; on Quest the compositor reads the frame's alpha,
  // so an opaque clear hides it without leaving immersion.
  expect(passthroughPlan({blendMode:'alpha-blend',passthroughOn:true,on:false}))
    .toEqual({action:'toggle',mode:null});
  // And back again, by the same clear.
  expect(passthroughPlan({blendMode:'alpha-blend',passthroughOn:false,on:true}))
    .toEqual({action:'toggle',mode:null});
  // Already where the wearer asked to be. A session is expensive and a clear
  // that is already right is not worth a flip either.
  expect(passthroughPlan({blendMode:'alpha-blend',passthroughOn:true,on:true}))
    .toEqual({action:'unchanged',mode:null});
  expect(passthroughPlan({blendMode:'alpha-blend',passthroughOn:false,on:false}))
    .toEqual({action:'unchanged',mode:null});
});

it('still crosses sessions for the one ask an opaque session cannot answer',()=>{
  // No camera feed in immersive-vr, so the room can only come from immersive-ar.
  expect(passthroughPlan({blendMode:'opaque',passthroughOn:false,on:true}))
    .toEqual({action:'switch',mode:'immersive-ar'});
  // An opaque session asked to stay dark is asked for nothing, stale mirror or not.
  expect(passthroughPlan({blendMode:'opaque',passthroughOn:false,on:false}))
    .toEqual({action:'unchanged',mode:null});
  expect(passthroughPlan({blendMode:'opaque',passthroughOn:true,on:false}))
    .toEqual({action:'unchanged',mode:null});
  // A runtime that named no blend mode is treated as the opaque one: it is not
  // one to gamble an alpha clear on.
  expect(passthroughPlan({blendMode:null,passthroughOn:false,on:true}))
    .toEqual({action:'switch',mode:'immersive-ar'});
  expect(passthroughPlan({blendMode:null,passthroughOn:true,on:false}))
    .toEqual({action:'unchanged',mode:null});
});

it('names the refusal that only a press on the page can answer',()=>{
  // Chromium rejects an immersive request made without transient activation
  // with SecurityError; other user agents use NotAllowedError for the same.
  expect(entryRefusalReason(Object.assign(Error('The requested session requires user activation.'),{name:'SecurityError'}))).toBe('activation');
  expect(entryRefusalReason(Object.assign(Error('refused'),{name:'NotAllowedError'}))).toBe('activation');
  expect(entryRefusalReason(Object.assign(Error('still open'),{name:'InvalidStateError'}))).toBe('busy');
  expect(entryRefusalReason(Object.assign(Error('no such mode'),{name:'NotSupportedError'}))).toBe('unsupported');
  // The viewer's own coded stalls outrank the DOM name they arrive with.
  expect(entryRefusalReason(Object.assign(Error('stalled'),{name:'Error',code:'xr_startup_timeout'}))).toBe('timeout');
  expect(entryRefusalReason(Error('something else'))).toBe('failed');
  expect(entryRefusalReason(undefined)).toBe('failed');
});

it('names the press after what the wearer asked for, not after the mechanism',()=>{
  expect(entryFallbackCopy('immersive-vr')).toMatchObject({label:'Enter VR',caption:'Press Enter VR on the page.'});
  expect(entryFallbackCopy('immersive-ar')).toMatchObject({label:'Enter passthrough',caption:'Press Enter passthrough on the page.'});
  // The note says what the press buys, and never repeats the button's own words.
  for(const mode of ['immersive-ar','immersive-vr'] as const) {
    const copy=entryFallbackCopy(mode);
    expect(copy.note.length).toBeGreaterThan(20);
    expect(copy.note).not.toContain(copy.label);
  }
});

afterEach(()=>vi.useRealTimers());

it('requires nothing and offers hand tracking and floor spaces within the click',async()=>{
  const session={end:vi.fn()},runtime={requestSession:vi.fn(()=>Promise.resolve(session))};
  const result=requestHeadsetSession(runtime,'immersive-ar');
  expect(runtime.requestSession).toHaveBeenCalledWith('immersive-ar',
    {optionalFeatures:['hand-tracking','local-floor','bounded-floor','plane-detection','anchors','hit-test','high-fixed-foveation-level']});
  const [,init]=runtime.requestSession.mock.calls[0] as any[];
  // Nothing may be required: a headset without these features still enters.
  expect(init).not.toHaveProperty('requiredFeatures');
  expect(init.optionalFeatures).not.toBe(HEADSET_OPTIONAL_FEATURES);
  expect(await result).toBe(session);
  expect(session.end).not.toHaveBeenCalled();
});

it('asks Safari for no hand tracking, so it keeps drawing the wearer\'s hands',async()=>{
  // Read from Safari in the visionOS 27.0 Simulator: the desktop
  // Mac agent, WebXR present.
  const vision={userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15',xr:{}};
  const quest={userAgent:'Mozilla/5.0 (X11; Linux x86_64; Quest 2) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/41.0.0.0 SamsungBrowser/4.0 Chrome/138.0.0.0 VR Safari/537.36',xr:{}};
  // The IWER harness runs the page in headless Chromium with an emulated navigator.xr.
  const headless={userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/146.0.0.0 Safari/537.36',xr:{}};
  expect(isAppleSafariXr(vision)).toBe(true);
  // It keys on the engine, so a future agent without the Mac parts still counts.
  expect(isAppleSafariXr({...vision,userAgent:'Mozilla/5.0 (Apple Vision; visionOS 28_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/28.0 Safari/605.1.15'})).toBe(true);
  // Safari without WebXR is not a headset browser at all.
  expect(isAppleSafariXr({...vision,xr:undefined})).toBe(false);
  for(const other of [quest,headless,
    {userAgent:'Mozilla/5.0 (Android 12; Mobile VR; rv:128.0) Gecko/128.0 Firefox/128.0 Wolvic/1.8',xr:{}},
    {userAgent:'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0 Mobile/15E148 Safari/604.1',xr:{}}])
    expect(isAppleSafariXr(other)).toBe(false);
  expect(isAppleSafariXr(undefined)).toBe(false);
  expect(isAppleSafariXr({get userAgent():string{throw Error('denied');}})).toBe(false);

  expect(headsetOptionalFeatures(vision)).toEqual(HEADSET_OPTIONAL_FEATURES.filter((feature:string)=>feature!=='hand-tracking'));
  expect(headsetOptionalFeatures(quest)).toEqual([...HEADSET_OPTIONAL_FEATURES]);
  expect(headsetOptionalFeatures(headless)).toEqual([...HEADSET_OPTIONAL_FEATURES]);
  expect(headsetOptionalFeatures(quest)).not.toBe(HEADSET_OPTIONAL_FEATURES);
  const session={end:vi.fn()},runtime={requestSession:vi.fn(()=>Promise.resolve(session))};
  await requestHeadsetSession(runtime,'immersive-vr',{optionalFeatures:headsetOptionalFeatures(vision)});
  expect((runtime.requestSession.mock.calls[0] as any[])[1].optionalFeatures).not.toContain('hand-tracking');
});

it('waits for Safari\'s consent prompt instead of closing the session it grants',async()=>{
  // Safari holds every immersive request behind "Would Like to Launch an
  // Immersive Experience"; 20 s closed a session the wearer then allowed.
  const vision={userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15',xr:{}};
  expect(headsetEntryDeadlineMs(vision)).toBe(APPLE_PROMPT_DEADLINE_MS);
  expect(headsetEntryDeadlineMs({userAgent:'Quest 2 Chrome/138.0 Safari/537.36',xr:{}})).toBe(HEADSET_ENTRY_DEADLINE_MS);
  expect(APPLE_PROMPT_DEADLINE_MS).toBeGreaterThanOrEqual(120_000);
  vi.useFakeTimers();
  let allow:(value:unknown)=>void=()=>{};
  const session={end:vi.fn()};
  const pending=requestHeadsetSession({requestSession:()=>new Promise(resolve=>{allow=resolve;})},'immersive-vr',
    {timeoutMs:headsetEntryDeadlineMs(vision)});
  await vi.advanceTimersByTimeAsync(60_000);
  allow(session);
  expect(await pending).toBe(session);
  expect(session.end).not.toHaveBeenCalled();
});

it('passes the feature list and deadline the immersive entry chose for this browser',async()=>{
  const source=await readFile(new URL('../../lab/browser-roundtrip/immersive-session.mjs',import.meta.url),'utf8');
  expect(source).toMatch(/requestHeadsetSession\(runtime, xrMode, \{ optionalFeatures: headsetOptionalFeatures\(globalThis\.navigator\),\s+timeoutMs: headsetEntryDeadlineMs\(globalThis\.navigator\)/);
});

it('asks for the strongest fixed foveation levels Meta gates behind a feature',()=>{
  // A Quest 2 writes level 1; without this opt-in the browser may cap it.
  expect(HEADSET_OPTIONAL_FEATURES).toContain('high-fixed-foveation-level');
  expect(foveationLevelFor('quest2')).toBe(1);
});

it('enters immersion on a runtime that grants none of the optional features',async()=>{
  const granted:string[]=[];
  const session={end:vi.fn(),enabledFeatures:granted};
  const runtime={requestSession:vi.fn((_mode:string,init:any)=>{
    // A device without these features drops them; it does not reject.
    granted.push('viewer','local',...init.optionalFeatures.filter(()=>false));
    return Promise.resolve(session);
  })};
  expect(await requestHeadsetSession(runtime,'immersive-vr')).toBe(session);
  expect(granted).toEqual(['viewer','local']);
});

it('releases a hung request and closes any session accepted after the deadline',async()=>{
  vi.useFakeTimers();
  let accept!:(session:any)=>void;
  const runtime={requestSession:vi.fn(()=>new Promise(resolve=>{accept=resolve;}))};
  const onTimeout=vi.fn();
  const result=requestHeadsetSession(runtime,'immersive-vr',{timeoutMs:100,onTimeout});
  const rejected=expect(result).rejects.toMatchObject({code:'xr_request_timeout'});
  await vi.advanceTimersByTimeAsync(100);await rejected;
  expect(onTimeout).toHaveBeenCalledOnce();
  const session={end:vi.fn(async()=>{})};accept(session);
  await vi.advanceTimersByTimeAsync(1);
  expect(session.end).toHaveBeenCalledOnce();
  expect(runtime.requestSession).toHaveBeenCalledOnce();
});

it('preserves a native permission denial without treating it as a timeout',async()=>{
  vi.useFakeTimers();
  const denied=new DOMException('Permission denied','NotAllowedError'),onTimeout=vi.fn();
  await expect(requestHeadsetSession({requestSession:()=>Promise.reject(denied)},'immersive-ar',{timeoutMs:100,onTimeout})).rejects.toBe(denied);
  await vi.advanceTimersByTimeAsync(100);
  expect(onTimeout).not.toHaveBeenCalled();
});

it('still rejects when timeout diagnostics throw',async()=>{
  vi.useFakeTimers();
  const result=requestHeadsetSession({requestSession:()=>new Promise(()=>{})},'immersive-ar',{
    timeoutMs:100,
    onTimeout:()=>{throw Error('diagnostic sink failed');},
  });
  const rejected=expect(result).rejects.toMatchObject({code:'xr_request_timeout'});
  await vi.advanceTimersByTimeAsync(100);
  await rejected;
});

it('turns on full fixed foveation for a Quest 2 layer and reports the runtime read-back',()=>{
  const layer={fixedFoveation:0};
  const session={inputSources:[],renderState:{baseLayer:layer}};
  const agent='Mozilla/5.0 (X11; Linux x86_64; Quest 2) AppleWebKit/537.36 OculusBrowser/39.2.0.0 Chrome/146.0.0.0 VR Safari/537.36';
  const previous=Object.getOwnPropertyDescriptor(globalThis,'navigator');
  Object.defineProperty(globalThis,'navigator',{value:{userAgent:agent},configurable:true});
  try{
    expect(applyFoveation(session)).toEqual({applied:true,requested:1,level:1,reason:'set'});
    expect(layer.fixedFoveation).toBe(1);
  }finally{
    if(previous)Object.defineProperty(globalThis,'navigator',previous);
    else delete (globalThis as any).navigator;
  }
});

it('accepts a quantised read-back and leaves an unknown device untouched',()=>{
  let stored=0;
  const layer={get fixedFoveation(){return stored;},set fixedFoveation(value:number){stored=Math.round(value*4)/4;}};
  expect(applyFoveation({renderState:{baseLayer:layer}},undefined,0.6))
    .toEqual({applied:true,requested:0.6,level:0.5,reason:'set'});
  const bare={fixedFoveation:0};
  expect(applyFoveation({inputSources:[],renderState:{baseLayer:bare}},bare))
    .toMatchObject({applied:false,reason:'unknown-device'});
  expect(bare.fixedFoveation).toBe(0);
});

it('never throws when the runtime has no layer or refuses foveation',()=>{
  expect(applyFoveation(undefined)).toMatchObject({applied:false,reason:'no-layer'});
  expect(applyFoveation({renderState:{}},undefined,1)).toMatchObject({applied:false,reason:'no-layer'});
  expect(applyFoveation({},{},1)).toMatchObject({applied:false,reason:'unsupported'});
  const refusing={set fixedFoveation(_value:number){throw Error('read-only layer');},get fixedFoveation(){return 0;}};
  expect(applyFoveation({},refusing,1)).toMatchObject({applied:false,requested:1,reason:'refused'});
});

it('maps only the device classes with a measured foveation budget',()=>{
  expect(foveationLevelFor('quest2')).toBe(1);
  expect(foveationLevelFor('quest3')).toBe(0.5);
  expect(foveationLevelFor('quest-pro')).toBe(0.5);
  expect(foveationLevelFor('vision-pro')).toBeNull();
  expect(foveationLevelFor('unknown')).toBeNull();
});

// On Quest 2 a request for foveation level 1 never reached the layer. Not an
// API problem: `applyFoveation` ran straight after
// presentation was reported and WebXR applies an `updateRenderState()` at the
// top of the *next* animation frame, so the base layer was still null. These
// pin the wait, the re-apply, and the fact that neither costs a frame.
it('writes foveation once the base layer exists, not when presentation is reported',()=>{
  vi.useFakeTimers();
  const first={antialias:false,fixedFoveation:0};
  const session:any={renderState:{},addEventListener(){},};
  const watch=trackFoveation(session,{level:1,intervalMs:10,scope:globalThis});
  // Nothing to write yet, and nothing thrown for the missing layer.
  expect(watch.state()).toMatchObject({applied:false,reason:'no-layer'});
  expect(first.fixedFoveation).toBe(0);
  session.renderState={baseLayer:first};
  vi.advanceTimersByTime(10);
  expect(first.fixedFoveation).toBe(1);
  expect(watch.state()).toMatchObject({applied:true,requested:1,level:1,reason:'set'});
  // A layer the runtime replaced is written again; the same layer is not.
  const second={antialias:false,fixedFoveation:0};
  session.renderState={baseLayer:second};
  vi.advanceTimersByTime(10);
  expect(second.fixedFoveation).toBe(1);
  watch.stop();
  const third={antialias:false,fixedFoveation:0};
  session.renderState={baseLayer:third};
  vi.advanceTimersByTime(100);
  expect(third.fixedFoveation).toBe(0);
  vi.useRealTimers();
});

it('records each foveation write on the headset log and stops when the session ends',()=>{
  vi.useFakeTimers();
  const entries:Array<{kind:string;detail:any}>=[];
  (globalThis as any).__stereofoldDiagnostics={record:(kind:string,detail:any)=>{entries.push({kind,detail});}};
  let ended:(()=>void)|undefined;
  const layer={antialias:false,fixedFoveation:0};
  const session:any={renderState:{},addEventListener:(name:string,handler:()=>void)=>{if(name==='end')ended=handler;}};
  const watch=trackFoveation(session,{level:1,intervalMs:10});
  session.renderState={baseLayer:layer};
  vi.advanceTimersByTime(10);
  expect(entries).toEqual([{kind:'foveation',detail:{applied:true,requested:1,level:1,reason:'set',replaced:false}}]);
  const replacement={antialias:false,fixedFoveation:0};
  session.renderState={baseLayer:replacement};
  vi.advanceTimersByTime(10);
  expect(entries.at(-1)?.detail).toMatchObject({applied:true,replaced:true});
  // The watch must not outlive the session it was written for.
  ended?.();
  const orphan={antialias:false,fixedFoveation:0};
  session.renderState={baseLayer:orphan};
  vi.advanceTimersByTime(100);
  expect(orphan.fixedFoveation).toBe(0);
  watch.stop();
  delete (globalThis as any).__stereofoldDiagnostics;
  vi.useRealTimers();
});

it('never throws when the session, the scope timers or the diagnostics sink are missing',()=>{
  expect(()=>trackFoveation(undefined as any,{scope:{}}).stop()).not.toThrow();
  const thrower={setInterval(){throw Error('no timers');},clearInterval(){}};
  expect(()=>trackFoveation({renderState:{baseLayer:{fixedFoveation:0}}} as any,{level:1,scope:thrower}).stop()).not.toThrow();
});


it('persists only explicit boolean Room choices across new page scopes and leaves fresh/invalid storage unset',()=>{
  const values=new Map<string,string>();
  const storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value)};
  const first={localStorage:storage};
  expect(readPassthroughPreference(first)).toBeUndefined();
  storePassthroughPreference(false,first);
  const reopened={localStorage:storage};
  expect(readPassthroughPreference(reopened)).toBe(false);
  const toggle=vi.fn(()=>true);
  expect(restorePassthroughOnEntry({blendMode:'alpha-blend',preferred:readPassthroughPreference(reopened),toggle}))
    .toEqual({on:false,restored:true});
  expect(toggle).toHaveBeenCalledTimes(1);
  storePassthroughPreference(true,reopened);expect(readPassthroughPreference(first)).toBe(true);
  storePassthroughPreference('false',first);expect(readPassthroughPreference(first)).toBe(true);
  for(const value of ['null','0','FALSE','{}','']){
    expect(readPassthroughPreference({localStorage:{getItem:()=>value}})).toBeUndefined();
  }
});

it('blocked storage never prevents a live Room choice or changes first-time defaults',async()=>{
  const blocked={get localStorage(){throw Error('denied');}};
  expect(readPassthroughPreference(blocked)).toBeUndefined();
  expect(()=>storePassthroughPreference(false,blocked)).not.toThrow();
  const {context}=await passthroughActionHarness();
  context.blendMode='alpha-blend';context.passthroughOn=true;
  context.storePassthroughPreference=(on:boolean)=>storePassthroughPreference(on,blocked);
  await context.setPassthrough(false);
  expect(context.passthroughOn).toBe(false);expect(context.preferredPassthrough).toBe(false);
});

it('persists applied, unchanged and pending choices but never a refused request',async()=>{
  const {context,toggle,switchMode}=await passthroughActionHarness();
  context.blendMode='alpha-blend';context.passthroughOn=true;
  await context.setPassthrough(false);
  expect(context.storePassthroughPreference).toHaveBeenLastCalledWith(false);
  await context.setPassthrough(false);
  expect(context.storePassthroughPreference).toHaveBeenCalledTimes(2);
  toggle.mockReturnValue(false);
  await expect(context.setPassthrough(true)).rejects.toThrow();
  expect(context.storePassthroughPreference).toHaveBeenCalledTimes(2);
  context.blendMode='opaque';switchMode.mockResolvedValue({switched:false,pending:'immersive-ar'} as any);
  await context.setPassthrough(true);
  expect(context.storePassthroughPreference).toHaveBeenLastCalledWith(true);
});
