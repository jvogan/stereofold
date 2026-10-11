import assert from 'node:assert/strict';
import {test} from 'node:test';
import {captureXrNamedViewIntent,captureDesktopNamedViewIntent,desktopCameraForNamedView,validateNamedViewIntent} from './named-view-intent.mjs';
const I=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
const source={sourceSha256:'a'.repeat(64),modelNumber:1,assemblyId:'1'};
const camera={mode:'perspective',fov:Math.PI/2,position:[0,0,10],target:[0,0,0],up:[0,1,0],radius:2,radiusMax:2,fog:0,clipFar:true,minNear:0,minFar:0};
const close=(a,b)=>{assert.equal(a.length,b.length);a.forEach((v,i)=>assert.ok(Math.abs(v-b[i])<1e-8,`${a} != ${b}`));};
const head=[...I];head[14]=10;
const args={source,center:[0,0,0],radius:2,headInRoom:head,renderFromRoom:I,cameraScale:1,moleculeTransform:I,projectionMatrices:[I,I]};
test('explicit XR capture emits only bounded scientific framing, with no eye or room matrices',()=>{
  const intent=captureXrNamedViewIntent(args);
  close(intent.direction,[0,0,-1]);close(intent.up,[0,1,0]);close(intent.targetOffsetRadii,[0,0,0]);assert.equal(intent.distanceInRadii,5);assert.equal(intent.verticalSpanRadii,10);
  assert.deepEqual(Object.keys(intent).sort(),['version','sourceSha256','modelNumber','assemblyId','targetOffsetRadii','direction','up','distanceInRadii','verticalSpanRadii'].sort());
  assert.throws(()=>validateNamedViewIntent({...intent,headInRoom:head},source));
});
test('object-relative angle cancels molecular rotation, scale and translated room origin',()=>{
  // Molecular +90 degree Y rotation, scale 2, translation [4,0,0].
  const molecule=[0,0,-2,0,0,2,0,0,2,0,0,0,4,0,0,1];
  const shiftedHead=[...head];shiftedHead[12]=4;
  const intent=captureXrNamedViewIntent({...args,moleculeTransform:molecule,headInRoom:shiftedHead});
  close(intent.direction,[1,0,0]);close(intent.up,[0,1,0]);assert.equal(intent.distanceInRadii,2.5);
  const restored=desktopCameraForNamedView({intent,source,center:[0,0,0],radius:2,moleculeTransform:molecule,camera,aspect:2});
  close(restored.position,[4,0,10]);close(restored.target,[4,0,0]);close(restored.up,[0,1,0]);
  const roomHead=[...shiftedHead];roomHead[12]+=100;
  const inverseRoom=[...I];inverseRoom[12]=-100;
  assert.deepEqual(captureXrNamedViewIntent({...args,moleculeTransform:molecule,headInRoom:roomHead,renderFromRoom:inverseRoom}),intent);
});
test('return uses target FOV/aspect with preserved orientation and no portrait crop',()=>{
  const intent=captureXrNamedViewIntent(args);
  const target={...camera,fov:Math.PI/3};
  const wide=desktopCameraForNamedView({intent,source,center:[0,0,0],radius:2,moleculeTransform:I,camera:target,aspect:2});
  const tall=desktopCameraForNamedView({intent,source,center:[0,0,0],radius:2,moleculeTransform:I,camera:target,aspect:.5});
  assert.ok(Math.abs(wide.position[2]-10/Math.tan(Math.PI/6))<1e-8);assert.equal(tall.position[2],wide.position[2]*2);
  assert.equal(wide.fov,target.fov);close(tall.target,wide.target);close(tall.up,wide.up);
});
test('rolled head preserves up and gaze offset instead of forcing a world-up camera',()=>{
  const rolled=[0,1,0,0,-1,0,0,0,0,0,1,0,2,0,10,1];
  const intent=captureXrNamedViewIntent({...args,headInRoom:rolled});close(intent.up,[-1,0,0]);close(intent.targetOffsetRadii,[1,0,0]);
  const result=desktopCameraForNamedView({intent,source,center:[0,0,0],radius:2,moleculeTransform:I,camera,aspect:1});close(result.position,[2,0,10]);
});
test('invalid source, stale/invalid geometry, reflected handedness and behind-view targets refuse',()=>{
  const reflected=[...I];reflected[0]=-1;
  assert.throws(()=>captureXrNamedViewIntent({...args,moleculeTransform:reflected}),/reflected/);
  const singular=[...I];singular[0]=0;assert.throws(()=>captureXrNamedViewIntent({...args,moleculeTransform:singular}));
  const behind=[...head];behind[14]=-10;assert.throws(()=>captureXrNamedViewIntent({...args,headInRoom:behind}),/Look toward/);
  assert.throws(()=>captureXrNamedViewIntent({...args,projectionMatrices:[]}));
  const intent=captureXrNamedViewIntent(args);assert.throws(()=>validateNamedViewIntent(intent,{...source,modelNumber:2}));
  assert.throws(()=>validateNamedViewIntent({...intent,up:intent.direction},source));
});
test('desktop and orthographic capture preserve scientific direction through the same adapter',()=>{
  for(const mode of ['perspective','orthographic']) {
    const input={...camera,mode};const intent=captureDesktopNamedViewIntent({source,center:[0,0,0],radius:2,camera:input,moleculeTransform:I});
    const result=desktopCameraForNamedView({intent,source,center:[0,0,0],radius:2,moleculeTransform:I,camera:input,aspect:1});
    close(result.position,input.position);close(result.target,input.target);assert.equal(result.mode,mode);
  }
});

// Execute the actual viewer capture/adapter closures with local pose stubs.
// This checks lifecycle and XR no-camera-write routing, not just pure math.
const {readFileSync}=await import('node:fs');
const viewerSource=readFileSync(new URL('./viewer.mjs',import.meta.url),'utf8');
const captureClosure=viewerSource.slice(viewerSource.indexOf('  function captureNamedViewIntent()'),viewerSource.indexOf('  function completeInspectionCapture()'));
function production(presenting) {
  const stored={...source,selectionKeys:[],camera,inspection:{appearance:{},placement:{}}};
  const pose={headInRoom:head,renderFromRoom:I,labelViews:[{projectionMatrix:I}]};
  const canvas={xr:{isPresenting:{value:presenting}},camera:{scale:1,viewport:{width:800,height:600},getSnapshot:()=>camera}};
  return new Function('captureXrNamedViewIntent','captureDesktopNamedViewIntent','desktopCameraForNamedView','validateNamedViewIntent','cameraSnapshot','stored','pose','canvas',`
    let latestRoomPlacementPose=pose,latestHeadSample=100,held=false;
    const performance={now:()=>100},volume=null,assertReady=()=>{},interactionActive=()=>held,
      completeInspectionCapture=()=>structuredClone(stored),loadedSphere=()=>({center:[0,0,0],radius:2}),
      presentationTransform=()=>${JSON.stringify(I)},placementTransform=()=>${JSON.stringify(I)},detached=structuredClone;
    ${captureClosure}
    return {captureNamedViewIntent,sceneForNamedView,stale:()=>{latestHeadSample=-2000;},hold:()=>{held=true;}};
  `)(captureXrNamedViewIntent,captureDesktopNamedViewIntent,desktopCameraForNamedView,validateNamedViewIntent,c=>structuredClone(c),stored,pose,canvas);
}
test('production deliberate capture rejects stale tracking and held gestures; XR adaptation never changes camera',()=>{
  const viewer=production(true);const intent=viewer.captureNamedViewIntent();
  const scene={...source,camera,inspection:{placement:{}}};
  assert.deepEqual(viewer.sceneForNamedView(scene,intent),scene);
  viewer.stale();assert.throws(()=>viewer.captureNamedViewIntent(),/Hold still and release the grip, then save again/);
  const held=production(true);held.hold();assert.throws(()=>held.captureNamedViewIntent(),/Hold still and release the grip, then save again/);
  // The command path maps this code to a refusal receipt, not render_failed.
  for(const run of [()=>viewer.captureNamedViewIntent(),()=>held.captureNamedViewIntent()]) {
    try { run(); assert.fail('expected a capture refusal'); }
    catch(error) { assert.equal(error.code,'capture_refused'); }
  }
});
test('production desktop adapter keeps target source checked and does not mutate the stored scene',()=>{
  const viewer=production(false);const intent=viewer.captureNamedViewIntent();
  const scene={...source,camera,inspection:{placement:{}}};const before=structuredClone(scene);
  const result=viewer.sceneForNamedView(scene,intent);assert.deepEqual(scene,before);close(result.camera.position,camera.position);
  assert.throws(()=>viewer.sceneForNamedView({...scene,assemblyId:'2'},intent),/another scientific source/);
});
