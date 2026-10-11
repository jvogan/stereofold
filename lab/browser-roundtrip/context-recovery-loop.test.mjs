import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { cameraSnapshot } from './camera-snapshot.mjs';
const require = createRequire(import.meta.url);
const { Camera } = require('molstar/lib/commonjs/mol-canvas3d/camera.js');
const { Vec3 } = require('molstar/lib/commonjs/mol-math/linear-algebra.js');
import {readFileSync} from 'node:fs';
import {pageFunction} from './fixtures/label-action-harness.mjs';
const source=readFileSync(process.env.CONTEXT_RECOVERY_VIEWER_SOURCE??new URL('./viewer.mjs',import.meta.url),'utf8');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject};};
const tick=()=>new Promise(r=>setImmediate(r));
function fixture({running=false}={}){
 const order=[],subscribers=new Set(),teardown=deferred(),record={source:{sha256:'retained'},inspection:{placement:{scale:4},selection:['A'],history:['prior']},representation:{ref:'repr',obj:{data:{repr:{state:{visible:true},renderObjects:[]}}}}};
 let started=0,draws=0;const session={};
 const loop={isAnimating:running,start(){assert.equal(canvas.webgl.xr.session,undefined);order.push('loop-start');started++;this.isAnimating=true;}};
 const canvas={xr:{isPresenting:{value:true}},webgl:{isContextLost:true,xr:{session}},reprCount:{value:1},commitQueueSize:{value:0},
  requestResize(){order.push('resize')},commit(){},getRenderObjects:()=>[],
  didDraw:{subscribe(f){subscribers.add(f);return {unsubscribe(){subscribers.delete(f)}}}},
  requestDraw(){if(!loop.isAnimating)return;setImmediate(()=>{if(!loop.isAnimating||canvas.webgl.isContextLost)return;c.state.drawCount++;draws++;order.push('frame');for(const f of [...subscribers])f();});}};
 const c=vm.createContext({console,Error,Promise,setTimeout,clearTimeout,canvas,plugin:{animationLoop:loop},state:{status:'ready',contextLossCount:0,contextRestorationCount:0,generation:1,drawCount:0},
  failure:(code,message)=>Object.assign(Error(message),{code}),now:()=>performance.now(),activeWork:undefined,activeLoad:undefined,pendingContextLoss:undefined,busy:false,
  spatialInputOwners:new Set(),spatialOwnedHands:new Set(),manualXrInputHeld:false,spatialReleaseUntil:0,latestHeadContext:{},pendingPresentationPick:undefined,
  motionContextPaused:false,syncPresentationMotion(){},cancelXrPlacementFollowup(){},invalidateGesturePivot(){},retainCurrent:()=>record,recoveryRecord:undefined,recoveryPromise:undefined,
  immersiveSession:{end(){order.push('join-end');return teardown.promise},syncBounds(){}},
  frameWaiters:new Set(),candidateRecords:new Set(),inspectionState:{},removeInspectionLabels:async()=>{},removeLigandOverlay:async()=>{},removeComponentLabels:async()=>{},
  deleteRecord:async()=>{},representation:record.representation,styleLayers:[],companionRecord:undefined,lessonFigure:{drawn:()=>true},
  scientificRepresentationCount:()=>1,xrPresentationRepresentationCount:0,checkDrawnRecord(){},drawnRecordIsVisible:()=>true,
  XR_FRAME_TIMEOUT_MS:30,FRAME_TIMEOUT_MS:30,applyInspectionAppearance:async()=>{order.push('appearance')},removeFrameCover(){},emit(){order.push('ready')},onMutation(){},snapshot:()=>({}),
 });
 for(const name of ['assertContext','contextLost','waitForFrame','contextRestored'])vm.runInContext(pageFunction(source,name),c);
 c.restoreRecord=async previous=>{assert.equal(previous,record);order.push('rebuild');await c.waitForFrame(previous,{recovering:true});return previous;};
 return {c,canvas,loop,order,record,teardown,end(){canvas.xr.isPresenting.value=false;canvas.webgl.xr.session=undefined;teardown.resolve()},get starts(){return started},get draws(){return draws}};
}
test('actual lost/restored handlers restart the desktop clock only after delayed XR teardown, then pass real frame gates',async()=>{
 const h=fixture();const before=JSON.stringify(h.record);h.c.contextLost();h.canvas.webgl.isContextLost=false;h.c.contextRestored();await tick();
 assert.equal(h.c.state.status,'recovering');assert.equal(h.starts,0);assert(!h.order.includes('rebuild'));
 h.end();await h.c.recoveryPromise;
 assert.equal(h.c.state.status,'ready');assert.equal(h.starts,1);assert.equal(h.draws,2);assert(h.order.indexOf('loop-start')<h.order.indexOf('rebuild'));assert(h.order.indexOf('rebuild')<h.order.indexOf('frame'));
 assert.equal(JSON.stringify(h.record),before);assert.equal(h.c.frameWaiters.size,0);assert.equal(h.c.motionContextPaused,false);
});
for(const interruption of ['disposed','second-loss','live-session','presenting','end-failure'])test(`does not restart recovery clock after ${interruption}`,async()=>{
 const h=fixture();h.c.contextLost();h.canvas.webgl.isContextLost=false;h.c.contextRestored();await tick();
 if(interruption==='disposed'){h.c.state.status='disposed';h.end();await h.c.recoveryPromise;}
 else if(interruption==='second-loss'){h.canvas.webgl.isContextLost=true;h.c.contextLost();h.end();await h.c.recoveryPromise;assert.equal(h.c.state.status,'context_lost');}
 else {if(interruption==='live-session'){h.canvas.xr.isPresenting.value=false;h.teardown.resolve();}else if(interruption==='presenting'){h.canvas.webgl.xr.session=undefined;h.teardown.resolve();}else h.teardown.reject(Error('native end failed'));
  await assert.rejects(h.c.recoveryPromise,/finished closing|native end failed/);assert.equal(h.c.state.status,'error');}
 assert.equal(h.starts,0);assert(!h.order.includes('rebuild'));assert.equal(h.c.frameWaiters.size,0);
});
test('already running desktop loop is not started twice',async()=>{
 const h=fixture({running:true});h.c.contextLost();h.end();h.canvas.webgl.isContextLost=false;h.c.contextRestored();await h.c.recoveryPromise;assert.equal(h.starts,0);assert.equal(h.c.state.status,'ready');assert.equal(h.draws,2);
});

test('two consecutive XR losses preserve the scientific camera despite zero-buffer exit previews', async () => {
 const h=fixture(), camera=new Camera(undefined,{x:0,y:0,width:1280,height:493});
 camera.setState({position:[10,14,140],target:[10,14,40],radius:38,radiusMax:38},0);
 const scientific=cameraSnapshot(camera.getSnapshot());
 Object.assign(h.canvas,{camera,handleResize(){if(h.canvas.webgl.isContextLost){camera.viewport.width=0;camera.viewport.height=0;}}});
 Object.assign(h.c,{Vec3,cameraSnapshot,enableXr:true,desktopPreviewCamera:undefined,desktopPreviewMaxDistance:undefined,
   molecularBounds:()=>({center:[11,32,-25],radius:76}),roomSeatMemory:{take:()=>undefined},
   liveScene:()=>({}),inspectionSnapshot:()=>({placement:{scale:2}}),roomCameraInitialized:true});
 for(const name of ['fitDesktopPreview','releaseDesktopPreviewLimit','restoreImmersiveCamera'])vm.runInContext(pageFunction(source,name),h.c);
 // Use the actual leave callback and actual camera math. On the second loss,
 // teardown can enter before the viewer's contextLost listener retains state.
 h.c.canRebuildForXr=()=>false;
 const leave=vm.runInContext('('+source.match(/onLeavingPresentation: (async \(\) => \{[^\n]+\})/)[1]+')',h.c);
 h.c.retainCurrent=()=>({...h.record,inspection:{...h.record.inspection,camera:camera.getSnapshot()}});
 h.c.restoreRecord=async previous=>{camera.setState(cameraSnapshot(previous.inspection.camera),0);await h.c.waitForFrame(previous,{recovering:true});return previous;};
 h.c.immersiveSession.end=()=>{h.canvas.xr.isPresenting.value=false;h.canvas.webgl.xr.session=undefined;return leave();};
 for(let cycle=0;cycle<2;cycle++){
   h.canvas.xr.isPresenting.value=false;h.canvas.webgl.isContextLost=false;camera.viewport.width=1280;camera.viewport.height=493;
   h.c.fitDesktopPreview();assert.deepEqual(h.c.desktopPreviewCamera,scientific);
   assert.notDeepEqual(camera.getSnapshot().position,scientific.position);
   h.canvas.xr.isPresenting.value=true;h.canvas.webgl.xr.session={};h.c.restoreImmersiveCamera();
   assert.deepEqual(camera.getSnapshot(),scientific);
   h.loop.isAnimating=false;h.canvas.webgl.isContextLost=true;
   if(cycle===1)await h.c.immersiveSession.end();
   h.c.contextLost();
   assert.deepEqual(h.c.recoveryRecord.inspection.camera,scientific);
   h.canvas.webgl.isContextLost=false;camera.viewport.width=1280;camera.viewport.height=493;
   h.c.contextRestored();await h.c.recoveryPromise;
   assert.equal(h.c.state.status,'ready');assert.deepEqual(camera.getSnapshot(),scientific);
   assert.equal(h.c.state.contextRestorationCount,cycle+1);
 }
 assert.equal(h.starts,2);assert.equal(h.c.frameWaiters.size,0);
});
