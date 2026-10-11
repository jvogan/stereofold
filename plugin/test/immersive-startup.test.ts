import {afterEach,expect,it,vi} from 'vitest';

import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';

// Bundle the production orchestration with GPU-only helpers replaced. This
// runs the real session lifecycle without importing a browser renderer in Node.
async function startupRuntime(){
  const built=await build({stdin:{contents:`export {createImmersiveSession} from './immersive-session.mjs';
    export {primePushToTalkMicrophone,pushToTalkMicrophoneState} from './push-to-talk-audio.mjs';`,
    resolveDir:fileURLToPath(new URL('../../lab/browser-roundtrip/',import.meta.url))},
    bundle:true,write:false,format:'esm',platform:'node',plugins:[{name:'headset-frame-fixture',setup(api){
      api.onResolve({filter:/^molstar\//},args=>({path:args.path,namespace:'gpu-stub'}));
      api.onLoad({filter:/.*/,namespace:'gpu-stub'},()=>({contents:'export const TextBuilder={},Text={},MeshBuilder={},Mesh={},getFontAtlas=()=>({}),Shape={},ShapeRepresentation=()=>{},Sphere3D={},Color=()=>{};'}));
      api.onResolve({filter:/spatial-toolbar\.mjs$/},()=>({path:'toolbar',namespace:'frame-fixture'}));
      api.onResolve({filter:/presentation-scene\.mjs$/},()=>({path:'scene',namespace:'frame-fixture'}));
      // Pointer geometry is another GPU-only helper. Startup lifecycle tests
      // own no Mol* helper/GL scene; browser acceptance verifies the real one.
      api.onResolve({filter:/xr-pointer\.mjs$/},()=>({path:'pointer',namespace:'frame-fixture'}));
      api.onLoad({filter:/.*/,namespace:'frame-fixture'},args=>({contents:args.path==='scene'
        ? 'export const createPresentationScene=()=>({dispose(){},add(){},remove(){}});'
        : args.path==='pointer' ? 'export const installXrPointer=()=>({applied:false,restore(){}});'
        : `export const createSpatialToolbar=({canvas})=>({async update(){
            if(!canvas.drawing)throw Error('No immersive frames available for the menu');
          },async dispose(){},depthRange(){},syncPose(){},
          blur(){globalThis.__toolbarBlurs=(globalThis.__toolbarBlurs??0)+1;}});`}));
    }}]});
  return import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
}

afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});

it('shares support queries and does not repeat them while entry is pending',async()=>{
  const {createImmersiveSession}=await startupRuntime();
  vi.useFakeTimers();
  const runtime=Object.assign(new EventTarget(),{isSessionSupported:vi.fn(async()=>true),requestSession:vi.fn(()=>new Promise(()=>{}))});
  vi.stubGlobal('isSecureContext',true);vi.stubGlobal('navigator',{xr:runtime});
  const viewer=createImmersiveSession({plugin:{},canvas:{},Mat4:{},isReady:()=>true});
  await Promise.all([viewer.capabilities(),viewer.capabilities(),viewer.capabilities()]);
  expect(runtime.isSessionSupported).toHaveBeenCalledTimes(2);
  const entry=viewer.enter('ar');const rejected=expect(entry).rejects.toThrow('did not finish');
  runtime.dispatchEvent(new Event('devicechange'));
  await viewer.capabilities();expect(runtime.isSessionSupported).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(20_000);await rejected;
  await viewer.dispose();
});

it('settles hung entry and refuses a second native request until reload',async()=>{
  const {createImmersiveSession}=await startupRuntime();
  vi.useFakeTimers();
  const requestSession=vi.fn(()=>new Promise(()=>{}));
  vi.stubGlobal('isSecureContext',true);
  vi.stubGlobal('navigator',{xr:{requestSession},userActivation:{isActive:true}});
  const viewer=createImmersiveSession({plugin:{},canvas:{},Mat4:{},isReady:()=>true});
  const entry=viewer.enter('immersive-ar');
  const rejected=expect(entry).rejects.toMatchObject({code:'xr_request_timeout'});
  await vi.advanceTimersByTimeAsync(20_000);await rejected;
  expect(viewer.startup()).toMatchObject({phase:'requesting-headset',pending:false,reloadRequired:true,gestureActive:true});
  await expect(viewer.enter('immersive-vr')).rejects.toThrow('Reload');
  expect(requestSession).toHaveBeenCalledOnce();
  await viewer.end();
});

it('bounds a post-grant tracking-space stall and closes the accepted session',async()=>{
  const {createImmersiveSession}=await startupRuntime();
  vi.useFakeTimers();
  const session=Object.assign(new EventTarget(),{
    environmentBlendMode:'opaque',
    requestReferenceSpace:vi.fn(()=>new Promise(()=>{})),
    end:vi.fn(async()=>{}),
  });
  const requestSession=vi.fn(async()=>session);
  vi.stubGlobal('isSecureContext',true);
  vi.stubGlobal('navigator',{xr:{requestSession},userActivation:{isActive:true}});
  const viewer=createImmersiveSession({plugin:{},canvas:{},Mat4:{},isReady:()=>true});
  const entry=viewer.enter('immersive-ar');
  const rejected=expect(entry).rejects.toMatchObject({code:'xr_startup_timeout'});
  await vi.advanceTimersByTimeAsync(10_000);
  await rejected;
  expect(session.end).toHaveBeenCalledOnce();
  expect(viewer.startup()).toMatchObject({phase:'locating-headset',pending:false,reloadRequired:true});
  await viewer.dispose();
});

it('renders immersive frames before waiting for the spatial menu',async()=>{
  const {createImmersiveSession}=await startupRuntime();
  const session=Object.assign(new EventTarget(),{
    requestReferenceSpace:async()=>({}),requestAnimationFrame:vi.fn(),updateRenderState:vi.fn(),
    end:vi.fn(async()=>{}),
  });
  const presenting={value:false,subscribe:vi.fn()};
  const xr:any={session:undefined,
    async set(value:any){this.session=value;presenting.value=true;},
    async end(){await this.session?.end();this.session=undefined;presenting.value=false;},
  };
  const canvas={drawing:false,webgl:{xr},xr:{isPresenting:presenting},
    animate:vi.fn(()=>{canvas.drawing=true;}),pause:vi.fn(),requestDraw:vi.fn(),requestResize:vi.fn()};
  const plugin={canvas3d:canvas,animationLoop:{stop:vi.fn(),start:vi.fn()},
    canvas3dContext:{passes:{draw:{drawTarget:{framebuffer:{}},
      depthTextureOpaque:{attachFramebuffer:vi.fn(),detachFramebuffer:vi.fn()}}}}};
  const requestSession=vi.fn(async()=>session);
  vi.stubGlobal('isSecureContext',true);vi.stubGlobal('navigator',{xr:{requestSession}});
  const viewer=createImmersiveSession({plugin,canvas,Mat4:{},isReady:()=>true});
  const entering=viewer.enter('immersive-ar');
  // The browser request must still happen inside the original click stack.
  expect(requestSession).toHaveBeenCalledWith('immersive-ar',expect.objectContaining({optionalFeatures:expect.any(Array)}));
  await entering;
  expect(canvas.animate).toHaveBeenCalledOnce();
  expect(viewer.startup()).toMatchObject({phase:'active',pending:false,reloadRequired:false,mode:'immersive-ar'});
  await viewer.end();
});

it('tells the menu to forget its held press when the session goes blind',async()=>{
  // A system dialog takes focus and the session reads
  // `visible-blurred`; WebXR stops delivering input, so a trigger held at that
  // moment never reaches the menu's release handler. The blind edge is the only
  // place that can drop the lit row and the action it captured.
  const {createImmersiveSession}=await startupRuntime();
  delete (globalThis as any).__toolbarBlurs;
  const session=Object.assign(new EventTarget(),{visibilityState:'visible',
    requestReferenceSpace:async()=>({}),requestAnimationFrame:vi.fn(),updateRenderState:vi.fn(),
    end:vi.fn(async()=>{}),
  });
  const presenting={value:false,subscribe:vi.fn()};
  const xr:any={session:undefined,
    async set(value:any){this.session=value;presenting.value=true;},
    async end(){await this.session?.end();this.session=undefined;presenting.value=false;},
  };
  const canvas={drawing:false,webgl:{xr},xr:{isPresenting:presenting},
    animate:vi.fn(()=>{canvas.drawing=true;}),pause:vi.fn(),requestDraw:vi.fn(),requestResize:vi.fn()};
  const plugin={canvas3d:canvas,animationLoop:{stop:vi.fn(),start:vi.fn()},
    canvas3dContext:{passes:{draw:{drawTarget:{framebuffer:{}},
      depthTextureOpaque:{attachFramebuffer:vi.fn(),detachFramebuffer:vi.fn()}}}}};
  vi.stubGlobal('isSecureContext',true);vi.stubGlobal('navigator',{xr:{requestSession:vi.fn(async()=>session)}});
  const viewer=createImmersiveSession({plugin,canvas,Mat4:{},isReady:()=>true});
  await viewer.enter('immersive-ar');
  expect((globalThis as any).__toolbarBlurs).toBeUndefined();

  const become=(state:string)=>{(session as any).visibilityState=state;session.dispatchEvent(new Event('visibilitychange'));};
  become('visible-blurred');
  expect((globalThis as any).__toolbarBlurs).toBe(1);
  // Coming back is not a blind edge: the menu keeps whatever the wearer is on.
  become('visible');
  expect((globalThis as any).__toolbarBlurs).toBe(1);
  // The headset coming off is blind too.
  become('hidden');
  expect((globalThis as any).__toolbarBlurs).toBe(2);
  await viewer.end();
  delete (globalThis as any).__toolbarBlurs;
});

it('bounds a renderer teardown race without restarting the desktop loop',async()=>{
  const {createImmersiveSession}=await startupRuntime();
  vi.useFakeTimers();
  const session=Object.assign(new EventTarget(),{
    requestReferenceSpace:async()=>({}),requestAnimationFrame:vi.fn(),updateRenderState:vi.fn(),
    end:vi.fn(()=>new Promise(()=>{})),
  });
  const presenting={value:false,subscribe:vi.fn()};
  const xr:any={session:undefined,
    async set(value:any){this.session=value;presenting.value=true;},
    end:vi.fn(()=>new Promise(()=>{})),
  };
  const canvas={drawing:false,webgl:{xr},xr:{isPresenting:presenting},
    animate:vi.fn(()=>{canvas.drawing=true;}),pause:vi.fn(),requestDraw:vi.fn(),requestResize:vi.fn()};
  const animationLoop={stop:vi.fn(),start:vi.fn()};
  const plugin={canvas3d:canvas,animationLoop,
    canvas3dContext:{passes:{draw:{drawTarget:{framebuffer:{}},
      depthTextureOpaque:{attachFramebuffer:vi.fn(),detachFramebuffer:vi.fn()}}}}};
  vi.stubGlobal('isSecureContext',true);vi.stubGlobal('navigator',{xr:{requestSession:vi.fn(async()=>session)}});
  const viewer=createImmersiveSession({plugin,canvas,Mat4:{},isReady:()=>true});
  await viewer.enter('immersive-ar');
  const closing=viewer.end();
  const rejected=expect(closing).rejects.toMatchObject({code:'xr_teardown_timeout'});
  await vi.advanceTimersByTimeAsync(5_000);
  await rejected;
  expect(animationLoop.start).not.toHaveBeenCalled();
  expect(viewer.startup()).toMatchObject({reloadRequired:true});
});

it('shares one teardown when leave is requested twice before the renderer closes',async()=>{
  const {createImmersiveSession}=await startupRuntime();
  let resolveRendererEnd!:()=>void;
  const rendererEnd=new Promise<void>(resolve=>{resolveRendererEnd=resolve;});
  const session=Object.assign(new EventTarget(),{
    requestReferenceSpace:async()=>({}),requestAnimationFrame:vi.fn(),updateRenderState:vi.fn(),
    end:vi.fn(async()=>{}),
  });
  const presenting={value:false,subscribe:vi.fn()};
  const xr:any={session:undefined,
    async set(value:any){this.session=value;presenting.value=true;},
    end:vi.fn(),
  };
  xr.end.mockImplementation(async()=>{await rendererEnd;await session.end();xr.session=undefined;presenting.value=false;});
  const canvas={drawing:false,webgl:{xr},xr:{isPresenting:presenting},
    animate:vi.fn(()=>{canvas.drawing=true;}),pause:vi.fn(),requestDraw:vi.fn(),requestResize:vi.fn()};
  const animationLoop={stop:vi.fn(),start:vi.fn()};
  const plugin={canvas3d:canvas,animationLoop,
    canvas3dContext:{passes:{draw:{drawTarget:{framebuffer:{}},
      depthTextureOpaque:{attachFramebuffer:vi.fn(),detachFramebuffer:vi.fn()}}}}};
  vi.stubGlobal('isSecureContext',true);vi.stubGlobal('navigator',{xr:{requestSession:vi.fn(async()=>session)}});
  const viewer=createImmersiveSession({plugin,canvas,Mat4:{},isReady:()=>true});
  await viewer.enter('immersive-ar');
  const first=viewer.end();
  const second=viewer.end();
  // The session owner wraps the renderer boundary; the native call is shared.
  await Promise.resolve();
  resolveRendererEnd();
  await Promise.all([first,second]);
  expect(session.end).toHaveBeenCalledOnce();
});

it('does not resume desktop rendering when XR attachment resolves after its deadline',async()=>{
  const {createImmersiveSession}=await startupRuntime();
  vi.useFakeTimers();
  let resolveAttach!:()=>void;
  const attach=new Promise<void>(resolve=>{resolveAttach=resolve;});
  const session=Object.assign(new EventTarget(),{
    requestReferenceSpace:async()=>({}),requestAnimationFrame:vi.fn(),updateRenderState:vi.fn(),
    end:vi.fn(async()=>{}),
  });
  const presenting={value:false,subscribe:vi.fn()};
  const xr:any={session:undefined,
    async set(value:any){this.session=value;presenting.value=true;await attach;},
    async end(){await this.session?.end();this.session=undefined;presenting.value=false;},
  };
  const canvas={drawing:false,webgl:{xr},xr:{isPresenting:presenting},
    animate:vi.fn(()=>{canvas.drawing=true;}),pause:vi.fn(),requestDraw:vi.fn(),requestResize:vi.fn()};
  const animationLoop={stop:vi.fn(),start:vi.fn()};
  const plugin={canvas3d:canvas,animationLoop,
    canvas3dContext:{passes:{draw:{drawTarget:{framebuffer:{}},
      depthTextureOpaque:{attachFramebuffer:vi.fn(),detachFramebuffer:vi.fn()}}}}};
  vi.stubGlobal('isSecureContext',true);vi.stubGlobal('navigator',{xr:{requestSession:vi.fn(async()=>session)}});
  const viewer=createImmersiveSession({plugin,canvas,Mat4:{},isReady:()=>true});
  const entry=viewer.enter('immersive-ar');
  const rejected=expect(entry).rejects.toMatchObject({code:'xr_startup_timeout'});
  await vi.advanceTimersByTimeAsync(10_000);
  await rejected;
  expect(animationLoop.start).not.toHaveBeenCalled();
  resolveAttach();
  await Promise.resolve();
  expect(animationLoop.start).not.toHaveBeenCalled();
});

it('keeps the first depth update alive when viewer tracking is temporarily null',async()=>{
  const {createImmersiveSession}=await startupRuntime();
  const callbacks:any[]=[];
  const updateRenderState=vi.fn();
  const session=Object.assign(new EventTarget(),{
    requestReferenceSpace:async()=>({getOffsetReferenceSpace:vi.fn(()=>({}))}),
    requestAnimationFrame:vi.fn(callback=>{callbacks.push(callback);return callbacks.length;}),
    updateRenderState,
    end:vi.fn(async()=>{}),
  });
  const presenting={value:false,subscribe:vi.fn()};
  const xr:any={session:undefined,
    async set(value:any){this.session=value;presenting.value=true;},
    async end(){await this.session?.end();this.session=undefined;presenting.value=false;},
  };
  const canvas={drawing:false,webgl:{xr},xr:{isPresenting:presenting},
    camera:{view:new Float32Array(16),scale:1},boundingSphereVisible:{center:[0,0,0],radius:1},
    animate:vi.fn(()=>{canvas.drawing=true;}),pause:vi.fn(),requestDraw:vi.fn(),requestResize:vi.fn()};
  const plugin={canvas3d:canvas,animationLoop:{stop:vi.fn(),start:vi.fn()},
    canvas3dContext:{passes:{draw:{drawTarget:{framebuffer:{}},
      depthTextureOpaque:{attachFramebuffer:vi.fn(),detachFramebuffer:vi.fn()}}}}};
  const requestSession=vi.fn(async()=>session);
  vi.stubGlobal('isSecureContext',true);vi.stubGlobal('navigator',{xr:{requestSession}});
  vi.stubGlobal('XRRigidTransform',class XRRigidTransform{constructor(public position:any,public orientation:any){}});
  const viewer=createImmersiveSession({plugin,canvas,Mat4:{getDecomposition:()=>({position:[0,0,0],quaternion:[0,0,0,1]}),invert:()=>new Float32Array(16)},isReady:()=>true});
  await viewer.enter('immersive-ar');
  const frame={getViewerPose:vi.fn(()=>null)};
  session.requestAnimationFrame(()=>session.updateRenderState({depthNear:0.1,depthFar:4}));
  callbacks.at(-1)!(0,frame);
  expect(updateRenderState).toHaveBeenCalledWith({depthNear:0.1,depthFar:4});
  await viewer.end();
});


it('bounds a stalled support query and still permits a synchronous native entry attempt',async()=>{
  const {createImmersiveSession}=await startupRuntime();
  vi.useFakeTimers();
  const requestSession=vi.fn(()=>Promise.reject(Object.assign(new Error('Native denial'),{name:'NotAllowedError'})));
  const runtime={isSessionSupported:vi.fn((mode:string)=>mode==='immersive-vr'?Promise.resolve(false):new Promise(()=>{})),requestSession};
  vi.stubGlobal('isSecureContext',true);vi.stubGlobal('navigator',{xr:runtime,userActivation:{isActive:true}});
  const viewer=createImmersiveSession({plugin:{},canvas:{},Mat4:{},isReady:()=>true});
  const support=viewer.capabilities();
  await vi.advanceTimersByTimeAsync(3000);
  expect(await support).toEqual({vr:false,ar:null});
  const attempt=viewer.enter('immersive-ar');
  expect(requestSession).toHaveBeenCalledWith('immersive-ar',expect.objectContaining({optionalFeatures:expect.any(Array)}));
  await expect(attempt).rejects.toThrow('Native denial');
  expect(viewer.startup()).toMatchObject({pending:false,errorName:'NotAllowedError',gestureActive:true});
  expect(await viewer.capabilities()).toEqual({vr:false,ar:null});
  expect(runtime.isSessionSupported).toHaveBeenCalledTimes(2);
});

it('distinguishes an unavailable capability probe from an explicit unsupported mode',async()=>{
  const {createImmersiveSession}=await startupRuntime();
  const runtime={isSessionSupported:vi.fn(()=>Promise.reject(new Error('Probe unavailable')))};
  vi.stubGlobal('isSecureContext',true);vi.stubGlobal('navigator',{xr:runtime});
  const viewer=createImmersiveSession({plugin:{},canvas:{},Mat4:{},isReady:()=>true});
  expect(await viewer.capabilities()).toEqual({vr:null,ar:null});
});

it.each([
  { name:'Quest Browser', userAgent:'Mozilla/5.0 (X11; Linux x86_64; Quest 2) OculusBrowser/39.2.0.0.56.754450099',
    inputSources:[], antialias:false },
  { name:'Vision Pro Safari', userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15',
    inputSources:[{targetRayMode:'transient-pointer',profiles:['generic-touchscreen']}], antialias:true },
])('applies the XR layer antialias policy for $name and rebuilds at immersive quality',async({userAgent,inputSources,antialias})=>{
  const {createImmersiveSession}=await startupRuntime();
  const built:Array<Record<string,unknown>>=[];
  class NativeLayer{constructor(_s:unknown,_g:unknown,options:Record<string,unknown>){built.push(options);}}
  vi.stubGlobal('XRWebGLLayer',NativeLayer);
  const session=Object.assign(new EventTarget(),{
    inputSources,requestReferenceSpace:async()=>({}),requestAnimationFrame:vi.fn(),updateRenderState:vi.fn(),
    renderState:{baseLayer:{antialias,fixedFoveation:1}},end:vi.fn(async()=>{}),
  });
  const presenting={value:false,subscribe:vi.fn()};
  const xr:any={session:undefined,
    // Stand in for what Mol* does inside `webgl.xr.set`: it asks the global
    // constructor for an antialiased layer and never consults us again.
    async set(value:any){new (globalThis as any).XRWebGLLayer(value,{},{antialias:true,alpha:true});
      this.session=value;presenting.value=true;},
    async end(){await this.session?.end();this.session=undefined;presenting.value=false;},
  };
  const canvas={drawing:false,webgl:{xr},xr:{isPresenting:presenting},
    animate:vi.fn(()=>{canvas.drawing=true;}),pause:vi.fn(),requestDraw:vi.fn(),requestResize:vi.fn()};
  const plugin={canvas3d:canvas,animationLoop:{stop:vi.fn(),start:vi.fn()},
    canvas3dContext:{passes:{draw:{drawTarget:{framebuffer:{}},
      depthTextureOpaque:{attachFramebuffer:vi.fn(),detachFramebuffer:vi.fn()}}}}};
  vi.stubGlobal('isSecureContext',true);vi.stubGlobal('navigator',{userAgent,xr:{requestSession:async()=>session}});
  const calls:string[]=[];
  let presentedOnCall:boolean|undefined;
  const viewer=createImmersiveSession({plugin,canvas,Mat4:{},isReady:()=>true,
    onPresented:async()=>{calls.push('entered');presentedOnCall=presenting.value;},
    onLeavingPresentation:async()=>{calls.push('left');}});
  await viewer.enter('immersive-ar');
  // Only a device class with an established foveation budget trades Mol*'s
  // multisampled layer for that budget. Safari keeps Mol*'s antialias request.
  expect(built).toEqual([{antialias,alpha:true}]);
  // The rebuild is deliberately off the entry path, so it lands a tick later.
  expect(canvas.animate).toHaveBeenCalledOnce();
  await Promise.resolve();await Promise.resolve();
  expect(calls).toEqual(['entered']);
  // It must see the presenting flag, because the quality it picks reads it.
  expect(presentedOnCall).toBe(true);
  await viewer.end();
  expect(calls).toEqual(['entered','left']);
  // The global is the browser's again once the wearer is out.
  expect((globalThis as any).XRWebGLLayer).toBe(NativeLayer);
});

it('does not rebuild for the desktop when immersion never presented',async()=>{
  const {createImmersiveSession}=await startupRuntime();
  const session=Object.assign(new EventTarget(),{
    requestReferenceSpace:async()=>{throw Error('no tracking space');},
    requestAnimationFrame:vi.fn(),updateRenderState:vi.fn(),end:vi.fn(async()=>{}),
  });
  const presenting={value:false,subscribe:vi.fn()};
  const xr:any={session:undefined,async set(){},async end(){}};
  const canvas={drawing:false,webgl:{xr},xr:{isPresenting:presenting},
    animate:vi.fn(),pause:vi.fn(),requestDraw:vi.fn(),requestResize:vi.fn()};
  const plugin={canvas3d:canvas,animationLoop:{stop:vi.fn(),start:vi.fn()},
    canvas3dContext:{passes:{draw:{drawTarget:{framebuffer:{}},
      depthTextureOpaque:{attachFramebuffer:vi.fn(),detachFramebuffer:vi.fn()}}}}};
  vi.stubGlobal('isSecureContext',true);vi.stubGlobal('navigator',{xr:{requestSession:async()=>session}});
  const calls:string[]=[];
  const viewer=createImmersiveSession({plugin,canvas,Mat4:{},isReady:()=>true,
    onPresented:async()=>{calls.push('entered');},onLeavingPresentation:async()=>{calls.push('left');}});
  await expect(viewer.enter('immersive-ar')).rejects.toThrow();
  await viewer.end().catch(()=>{});
  expect(calls).toEqual([]);
});

/**
 * A headset fixture whose sessions carry a real blend mode, so a
 * mode switch can be watched end to end rather than asserted on a flag.
 *
 * `requestSession` answers with the mode it was asked for, which is what makes
 * `startup()` reporting the running session testable at all: a report that only
 * echoed the request would pass every assertion below without switching.
 *
 * It also enforces the one rule that decides whether the optimistic switch can
 * ever land on hardware. Quest Browser is Chromium, and Chromium's
 * `CheckImmersiveSessionRequestAllowed`
 * (`third_party/blink/renderer/modules/xr/xr_system.cc`) rejects an immersive
 * request with a `SecurityError` unless `LocalFrame::HasTransientUserActivation`
 * answers yes. `gesture.active` is that answer, and moving it is how these
 * tests model a wearer who has just pressed a page button and a wearer who has
 * been inside a session long enough for the five-second window to lapse.
 */
function blendModeHeadset(){
  const granted:any[]=[];
  const gesture={active:true};
  const presenting={value:false,subscribe:vi.fn()};
  const xr:any={session:undefined,
    async set(value:any){this.session=value;presenting.value=true;},
    async end(){await this.session?.end();this.session=undefined;presenting.value=false;},
  };
  const canvas={drawing:false,webgl:{xr},xr:{isPresenting:presenting},
    animate:vi.fn(()=>{canvas.drawing=true;}),pause:vi.fn(),requestDraw:vi.fn(),requestResize:vi.fn()};
  const plugin={canvas3d:canvas,animationLoop:{stop:vi.fn(),start:vi.fn()},
    canvas3dContext:{passes:{draw:{drawTarget:{framebuffer:{}},
      depthTextureOpaque:{attachFramebuffer:vi.fn(),detachFramebuffer:vi.fn()}}}}};
  const requestSession=vi.fn(async(mode:string)=>{
    if(!gesture.active) throw Object.assign(Error('The requested session requires user activation.'),{name:'SecurityError'});
    const session=Object.assign(new EventTarget(),{
      environmentBlendMode:mode==='immersive-ar'?'alpha-blend':'opaque',
      requestReferenceSpace:async()=>({}),requestAnimationFrame:vi.fn(),updateRenderState:vi.fn(),
      end:vi.fn(async()=>{}),
    });
    granted.push(session);
    return session;
  });
  const isSessionSupported=vi.fn(async(_mode:string)=>true);
  vi.stubGlobal('isSecureContext',true);
  vi.stubGlobal('navigator',{xr:{requestSession,isSessionSupported},userActivation:{get isActive(){return gesture.active;}}});
  return {plugin,canvas,requestSession,isSessionSupported,granted,gesture};
}

it('crosses blend modes in one step and reports the session that is running',async()=>{
  const {createImmersiveSession}=await startupRuntime();
  const {plugin,canvas,requestSession,granted}=blendModeHeadset();
  // Activation is live throughout, which is the case the optimistic path is
  // written for: a wearer still inside the five seconds after pressing Enter
  // VR, and any runtime that does not enforce activation at all, such as the
  // WebXR emulator.
  const viewer=createImmersiveSession({plugin,canvas,Mat4:{},isReady:()=>true});
  await viewer.enter('immersive-ar');
  expect(viewer.startup()).toMatchObject({mode:'immersive-ar',blendMode:'alpha-blend',pendingEntry:null});
  const switched=await viewer.switchMode('immersive-vr');
  expect(switched).toMatchObject({entered:true,mode:'immersive-vr',blendMode:'opaque',switched:true});
  // The old session was ended before the new one was asked for: WebXR refuses a
  // second immersive session while the first is alive, so this order is the
  // whole reason the switch has to spend the activation window at all.
  expect(granted[0].end).toHaveBeenCalledOnce();
  expect(requestSession.mock.calls.map(([mode])=>mode)).toEqual(['immersive-ar','immersive-vr']);
  // The agent reads this pair to know which session the wearer is in now. It
  // has to name the running session, not the one the last request asked for.
  expect(viewer.startup()).toMatchObject({mode:'immersive-vr',blendMode:'opaque',presenting:true,pendingEntry:null});
  await viewer.switchMode('immersive-ar');
  expect(viewer.startup()).toMatchObject({mode:'immersive-ar',blendMode:'alpha-blend'});
  await viewer.end();
});

it('hands a refused re-entry to the page instead of throwing at the wearer',async()=>{
  const {createImmersiveSession}=await startupRuntime();
  const {plugin,canvas,gesture}=blendModeHeadset();
  const onLeavingPresentation=vi.fn(async()=>{});
  const viewer=createImmersiveSession({plugin,canvas,Mat4:{},isReady:()=>true,onLeavingPresentation});
  await viewer.enter('immersive-ar');
  // The wearer has been in the session long enough for the activation from the
  // Enter VR press to lapse, which is every real case: the window is five
  // seconds and nothing inside an XR session reopens it.
  gesture.active=false;
  const result=await viewer.switchMode('immersive-vr');
  expect(result).toMatchObject({entered:false,mode:'immersive-vr',reason:'activation',activation:false});
  expect(onLeavingPresentation).toHaveBeenCalledOnce();
  expect(canvas.webgl.xr.session).toBeUndefined();
  // The wearer is on the 2D page now, and the mode they asked for is what the
  // page's single button has to enter. Losing it would strand them there.
  expect(viewer.startup()).toMatchObject({presenting:false,pendingEntry:{mode:'immersive-vr',reason:'activation'}});
  // The page's button is a real DOM gesture, so the same request now lands.
  gesture.active=true;
  await viewer.enter('immersive-vr');
  expect(viewer.startup()).toMatchObject({mode:'immersive-vr',blendMode:'opaque',presenting:true,pendingEntry:null});
  await viewer.end();
});

it('keeps one VR session through repeated room asks when immersive AR is unsupported',async()=>{
  const {createImmersiveSession}=await startupRuntime();
  const {plugin,canvas,requestSession,isSessionSupported,granted}=blendModeHeadset();
  isSessionSupported.mockImplementation(async(mode:string)=>mode==='immersive-vr');
  const viewer=createImmersiveSession({plugin,canvas,Mat4:{},isReady:()=>true});
  await viewer.enter('immersive-vr');
  const session=granted[0];
  const first=await viewer.switchMode('immersive-ar');
  const second=await viewer.switchMode('immersive-ar');
  expect(first).toMatchObject({entered:false,mode:'immersive-ar',blendMode:'opaque',reason:'unsupported',retained:true});
  expect(second).toMatchObject({entered:false,mode:'immersive-ar',blendMode:'opaque',reason:'unsupported',retained:true});
  expect(session.end).not.toHaveBeenCalled();
  expect(requestSession.mock.calls.map(([mode])=>mode)).toEqual(['immersive-vr']);
  expect(isSessionSupported.mock.calls.map(([mode])=>mode)).toEqual(['immersive-vr','immersive-ar']);
  expect(viewer.startup()).toMatchObject({mode:'immersive-vr',blendMode:'opaque',presenting:true,pendingEntry:null});
  await viewer.end();
});

it('keeps VR when the immersive AR support request rejects',async()=>{
  const {createImmersiveSession}=await startupRuntime();
  const {plugin,canvas,requestSession,isSessionSupported,granted}=blendModeHeadset();
  isSessionSupported.mockImplementation(async(mode:string)=>{
    if(mode==='immersive-ar') throw Object.assign(Error('Support check rejected.'),{name:'NotSupportedError'});
    return true;
  });
  const viewer=createImmersiveSession({plugin,canvas,Mat4:{},isReady:()=>true});
  await viewer.enter('immersive-vr');
  const result=await viewer.switchMode('immersive-ar');
  expect(result).toMatchObject({entered:false,mode:'immersive-ar',blendMode:'opaque',reason:'unknown',retained:true});
  expect(granted[0].end).not.toHaveBeenCalled();
  expect(requestSession.mock.calls.map(([mode])=>mode)).toEqual(['immersive-vr']);
  expect(isSessionSupported).toHaveBeenCalledTimes(2);
  expect(viewer.startup()).toMatchObject({mode:'immersive-vr',blendMode:'opaque',presenting:true,pendingEntry:null});
  await viewer.end();
});

it('restores VR when a supported immersive AR request is rejected',async()=>{
  const {createImmersiveSession}=await startupRuntime();
  const {plugin,canvas,requestSession,granted}=blendModeHeadset();
  const viewer=createImmersiveSession({plugin,canvas,Mat4:{},isReady:()=>true});
  await viewer.enter('immersive-vr');
  requestSession.mockRejectedValueOnce(Object.assign(Error('AR is unavailable.'),{name:'NotSupportedError'}));
  const result=await viewer.switchMode('immersive-ar');
  expect(result).toMatchObject({entered:false,mode:'immersive-ar',blendMode:'opaque',reason:'unsupported',retained:true,restored:true});
  expect(requestSession.mock.calls.map(([mode])=>mode)).toEqual(['immersive-vr','immersive-ar','immersive-vr']);
  expect(granted[0].end).toHaveBeenCalledOnce();
  expect(granted[1].end).not.toHaveBeenCalled();
  expect(viewer.startup()).toMatchObject({mode:'immersive-vr',blendMode:'opaque',presenting:true,pendingEntry:null});
  // The rejection updates the cached capability. Another ask is a safe no-op.
  expect(await viewer.switchMode('immersive-ar')).toMatchObject({reason:'unsupported',retained:true});
  expect(requestSession).toHaveBeenCalledTimes(3);
  expect(granted[1].end).not.toHaveBeenCalled();
  await viewer.end();
});

it('keeps the immersive geometry across a switch and rebuilds it on a real exit',async()=>{
  const {createImmersiveSession}=await startupRuntime();
  const {plugin,canvas}=blendModeHeadset();
  const calls:string[]=[];
  const viewer=createImmersiveSession({plugin,canvas,Mat4:{},isReady:()=>true,
    onPresented:async()=>{calls.push('entered');},onLeavingPresentation:async()=>{calls.push('left');}});
  await viewer.enter('immersive-ar');
  await viewer.switchMode('immersive-vr');
  // A desktop-quality rebuild on the way out and an immersive one on the way
  // back in are seconds of work the wearer never sees, spent inside the
  // five-second activation window the switch is racing.
  expect(calls).toEqual(['entered','entered']);
  await viewer.end();
  expect(calls).toEqual(['entered','entered','left']);
});

it('keeps rendering under system UI while withholding head context and owns foveation cleanup', async () => {
  const {createImmersiveSession} = await startupRuntime();
  vi.useFakeTimers();
  let callback: ((time:number, frame:any)=>void) | undefined;
  const session = Object.assign(new EventTarget(), {visibilityState:'visible',
    requestReferenceSpace:async()=>({}),
    requestAnimationFrame:vi.fn((next:any)=>{callback=next;return 1;}), updateRenderState:vi.fn(),
    end:vi.fn(async()=>{throw Error('Native end failed');}),
  });
  const presenting={value:false,subscribe:vi.fn()};
  const xr:any={session:undefined,
    async set(value:any){this.session=value;presenting.value=true;},
    async end(){await this.session?.end();this.session=undefined;presenting.value=false;},
  };
  const canvas={drawing:false,webgl:{xr},xr:{isPresenting:presenting},
    animate:vi.fn(()=>{canvas.drawing=true;}),pause:vi.fn(),requestDraw:vi.fn(),requestResize:vi.fn()};
  const plugin={canvas3d:canvas,animationLoop:{stop:vi.fn(),start:vi.fn()},
    canvas3dContext:{passes:{draw:{drawTarget:{framebuffer:{}},
      depthTextureOpaque:{attachFramebuffer:vi.fn(),detachFramebuffer:vi.fn()}}}}};
  vi.stubGlobal('isSecureContext',true);vi.stubGlobal('navigator',{xr:{requestSession:async()=>session}});
  const onHeadFrame=vi.fn();
  const viewer=createImmersiveSession({plugin,canvas,Mat4:{},isReady:()=>true,onHeadFrame});
  await viewer.enter('immersive-ar');
  const draw=vi.fn(), frame={getViewerPose:()=>({views:[{},{}]})};
  for (const visibility of ['visible','visible-blurred','hidden','visible']) {
    session.visibilityState=visibility;
    session.dispatchEvent(new Event('visibilitychange'));
    session.requestAnimationFrame(draw);
    callback!(0,frame);
  }
  expect(draw).toHaveBeenCalledTimes(4);
  expect(onHeadFrame).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBeGreaterThan(0);
  await expect(viewer.end()).rejects.toThrow('Native end failed');
  expect(vi.getTimerCount()).toBe(0);
});

for (const exit of ['page', 'native'] as const) {
  it(`releases all XR frames and session owners after ${exit} exit`, async () => {
    const {createImmersiveSession,primePushToTalkMicrophone,pushToTalkMicrophoneState} = await startupRuntime();
    const track={readyState:'live',enabled:true,stop:vi.fn(()=>{track.readyState='ended';})};
    await primePushToTalkMicrophone({media:{getUserMedia:async()=>({getTracks:()=>[track]})}});
    const pending = new Map<number, (time:number, frame:any)=>void>();
    let next = 0, finishEnd!:()=>void;
    const nativeClosed = new Promise<void>(resolve => { finishEnd = resolve; });
    const session = Object.assign(new EventTarget(), {
      requestReferenceSpace: async()=>({}), updateRenderState: vi.fn(),
      requestAnimationFrame: vi.fn((callback:any) => { pending.set(++next, callback); return next; }),
      cancelAnimationFrame: vi.fn((handle:number) => { pending.delete(handle); }),
      end: vi.fn(async() => { session.dispatchEvent(new Event('end')); await nativeClosed; }),
    });
    const originalRequest = session.requestAnimationFrame;
    const originalCancel = session.cancelAnimationFrame;
    const presenting = {value:false, subscribe:vi.fn()};
    const xr:any = {session:undefined,
      async set(value:any) {
        this.session=value; presenting.value=true;
        value.addEventListener('end', () => { this.session=undefined; presenting.value=false; }, {once:true});
      },
      async end() { await this.session?.end(); },
    };
    let renderHandle = 0;
    const draw = vi.fn();
    const render = () => { draw(); renderHandle = session.requestAnimationFrame(render); };
    const canvas = {drawing:false, webgl:{xr}, xr:{isPresenting:presenting},
      animate:()=>{canvas.drawing=true; render();},
      pause:()=>{if (renderHandle) xr.session?.cancelAnimationFrame(renderHandle); renderHandle=0;},
      requestDraw:vi.fn(), requestResize:vi.fn()};
    const plugin = {canvas3d:canvas, animationLoop:{stop:vi.fn(), start:vi.fn()},
      canvas3dContext:{passes:{draw:{drawTarget:{framebuffer:{}},
        depthTextureOpaque:{attachFramebuffer:vi.fn(), detachFramebuffer:vi.fn()}}}}};
    const releaseVoice = vi.fn(async()=>{}), releaseReply = vi.fn(async()=>{});
    const diagnostic = vi.fn();
    vi.stubGlobal('isSecureContext',true);
    vi.stubGlobal('navigator',{xr:{requestSession:async()=>session}});
    vi.stubGlobal('__stereofoldReplyAudio',{release:releaseReply});
    vi.stubGlobal('__stereofoldDiagnostics',{record:diagnostic});
    const viewer = createImmersiveSession({plugin,canvas,Mat4:{},isReady:()=>true,
      getVoiceInteraction:()=>({release:releaseVoice})});
    await viewer.enter('ar');
    const auxiliary = vi.fn();
    session.requestAnimationFrame(auxiliary);
    const stale = [...pending.values()];
    expect(pending.size).toBe(2);
    if (exit === 'native') session.dispatchEvent(new Event('end'));
    const closing = viewer.end();
    if (exit === 'page') {
      // The event is earlier than the platform-shutdown promise. A repeated
      // exit must still join that promise, without resuming desktop frames.
      let repeatedSettled=false;
      const repeated=viewer.end().then(()=>{repeatedSettled=true;});
      await new Promise(resolve=>setImmediate(resolve));
      const resumedEarly=plugin.animationLoop.start.mock.calls.length;
      const settledEarly=repeatedSettled;
      finishEnd();
      await repeated;
      expect(resumedEarly).toBe(0);
      expect(settledEarly).toBe(false);
    }
    await closing;
    expect(pending.size).toBe(0);
    const count = draw.mock.calls.length;
    for (const callback of stale) callback(0,{getViewerPose:()=>({views:[]})});
    expect(draw).toHaveBeenCalledTimes(count);
    expect(auxiliary).not.toHaveBeenCalled();
    expect(pending.size).toBe(0);
    expect(xr.session).toBeUndefined();
    expect(viewer.startup()).toMatchObject({presenting:false, sessionVisibility:null});
    expect(viewer.environmentBlendMode()).toBeUndefined();
    expect(session.requestAnimationFrame).toBe(originalRequest);
    expect(session.cancelAnimationFrame).toBe(originalCancel);
    expect(plugin.animationLoop.start).toHaveBeenCalledOnce();
    expect(releaseVoice).toHaveBeenCalledOnce();
    expect(releaseReply).toHaveBeenCalledOnce();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(pushToTalkMicrophoneState()).toBe('idle');
    expect(diagnostic).toHaveBeenCalledWith('xr-session-cleanup', {
      source:exit, nativeEnded:true, pendingFrames:0, sessionHeld:false,
      recordSessionHeld:false, rendererSessionHeld:false, presenting:false, audioReleaseFailures:0,
    });
    await viewer.dispose();
  });
}

for (const exitPath of ['menu Exit', 'Mol* navigation', 'page hide', 'driver exit', 'stock Mol* exit']) {
  it(`acceptance 6 ${exitPath} closes native once on each of two visits and completes the cold rebuild`, async () => {
    const {readFileSync} = await import('node:fs');
    const {runInNewContext} = await import('node:vm');
    const {diagnosticEntrySchema, salvageDiagnosticEntries} = await import('../src/headset-diagnostics.js');
    // @ts-ignore Shared production page sanitizer.
    const {sanitizeDetail} = await import('../../lab/browser-roundtrip/headset-diagnostics.mjs');
    const evidence = JSON.parse(readFileSync(new URL('../../lab/browser-roundtrip/fixtures/exit-acceptance-6.json', import.meta.url), 'utf8'));
    const cold = evidence.rebuilds['seq2-reentry/ring-entryB-a.json'][2].detail.totalMs;
    expect(cold).toBe(774);
    const {createImmersiveSession} = await startupRuntime();
    vi.useFakeTimers();
    const listeners = new Set<(value:boolean)=>void>();
    const presenting = {value:false, subscribe(fn:(value:boolean)=>void) {
      listeners.add(fn); fn(this.value); return {unsubscribe:()=>listeners.delete(fn)};
    }};
    const granted:any[] = [];
    const xr:any = {session:undefined, async set(session:any) {
      this.session=session; presenting.value=true; for (const fn of listeners) fn(true);
      session.addEventListener('end', () => {
        this.session=undefined; presenting.value=false; for (const fn of listeners) fn(false);
      }, {once:true});
    }, async end() { await this.session?.end(); }};
    const requestSession = async () => {
      const session = Object.assign(new EventTarget(), {
        requestReferenceSpace:async()=>({}), requestAnimationFrame:vi.fn(), updateRenderState:vi.fn(),
        end:vi.fn(async()=>{ setTimeout(()=>session.dispatchEvent(new Event('end')), 0); }),
      });
      granted.push(session); return session;
    };
    const canvas = {drawing:false, webgl:{xr}, xr:{isPresenting:presenting},
      animate:()=>{canvas.drawing=true;}, pause:vi.fn(), requestDraw:vi.fn(), requestResize:vi.fn()};
    const plugin = {canvas3d:canvas, animationLoop:{stop:vi.fn(), start:vi.fn()},
      canvas3dContext:{passes:{draw:{drawTarget:{framebuffer:{}},
        depthTextureOpaque:{attachFramebuffer:vi.fn(), detachFramebuffer:vi.fn()}}}}};
    const diagnostic = vi.fn();
    vi.stubGlobal('isSecureContext',true); vi.stubGlobal('navigator',{xr:{requestSession}});
    vi.stubGlobal('__stereofoldDiagnostics',{record:diagnostic});
    let rebuilds=0;
    const viewer = createImmersiveSession({plugin,canvas,Mat4:{},isReady:()=>true,
      onLeavingPresentation:()=>new Promise(resolve=>setTimeout(resolve, rebuilds++ === 0 ? cold : 1))});
    for (let visit=0; visit<2; visit++) {
      await viewer.enter('ar');
      if (exitPath === 'page hide') {
        const inspector = readFileSync(new URL('../src/inspector.ts',import.meta.url),'utf8');
        const body = inspector.match(/window.addEventListener\('pagehide',\(\)=>\{closed=true;([\s\S]*?)\},\{once:true\}\);/)![1];
        const end = vi.fn(()=>viewer.end());
        const activePreviewRecording = {abort:vi.fn()};
        runInNewContext(body, {workspace:{viewer:{xr:{end}}}, generation:0, timer:0, pollTimer:0,
          activePreviewRecording, clearTimeout, detach:async()=>{}, app:{close(){}}});
        expect(activePreviewRecording.abort).toHaveBeenCalledOnce();
        expect(end).toHaveBeenCalledOnce();
      } else if (exitPath === 'stock Mol* exit') {
        // A second page request while Mol* is still awaiting native closure.
        void xr.end();
      } else {
        void viewer.end();
      }
      const closing=viewer.end();
      await vi.advanceTimersByTimeAsync(cold + 100);
      await closing;
      expect(granted[visit].end).toHaveBeenCalledOnce();
      const cleanup = diagnostic.mock.calls.filter(([kind])=>kind==='xr-session-cleanup').at(-1)![1];
      expect(cleanup.cleanupNotes ?? []).toEqual([]);
      const entry = {seq:visit + 1, at:Date.now(), kind:'xr-session-cleanup', detail:sanitizeDetail(cleanup)};
      expect(diagnosticEntrySchema.parse(entry)).toEqual(entry);
      expect(salvageDiagnosticEntries([entry])).toEqual([entry]);
      expect(cleanup).toMatchObject({nativeEnded:true,pendingFrames:0,sessionHeld:false,
        recordSessionHeld:false,rendererSessionHeld:false,presenting:false});
    }
    expect(rebuilds).toBe(2);
    await viewer.dispose();
  });
}
