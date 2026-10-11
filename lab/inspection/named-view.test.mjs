import assert from 'node:assert/strict';
import {test} from 'node:test';
import {captureNamedView,restoreNamedView} from './named-view.mjs';
function fixture() {
  const initial={sourceSha256:'public',modelNumber:1,assemblyId:'1',selectionKeys:['a'],camera:{position:[0,0,1]},inspection:{appearance:{color:'blue'},placement:{scale:1},emphasis:{parts:[]}}};
  let current=structuredClone(initial);const calls=[];
  const viewer={snapshot:()=>({xrPresenting:true}),inspection:{
    capture:()=>({...structuredClone(current),inspection:{...structuredClone(current.inspection),history:{},savedViews:[]}}),
    beginOperation:()=>{calls.push('begin');return 'checkpoint';},endOperation:()=>calls.push('end'),rollbackOperation:c=>calls.push(c),
    restore:async(scene,options)=>{calls.push(options);current=structuredClone(scene);},
  }};
  return {initial,viewer,calls};
}
test('named capture is admitted before capture and confirms no tab history without a mutation',async()=>{
  const {viewer,calls}=fixture();let admitted=false;
  const result=await captureNamedView(viewer,()=>{admitted=true;},(scene,receipt)=>{assert.ok(admitted);assert.equal(scene.inspection.history,undefined);assert.equal(scene.inspection.savedViews,undefined);return receipt;});
  assert.deepEqual(result,{captured:true});assert.deepEqual(calls,[]);
});
test('named restore is one admitted operation preserving XR camera with explicit placement intent',async()=>{
  const {initial,viewer,calls}=fixture();const next=structuredClone(initial);next.selectionKeys=['b'];
  const result=await restoreNamedView(viewer,next,()=>calls.push('admit'),(scene,receipt)=>{assert.deepEqual(scene,next);return receipt;});
  assert.deepEqual(result,{restored:true});assert.deepEqual(calls,['admit','begin',{preserveCamera:true,restorePlacement:true,preservePreviewCamera:true},'end']);
});
test('a held-placement mismatch is never confirmed and restores previous scene/history',async()=>{
  const {initial,viewer,calls}=fixture();const restore=viewer.inspection.restore;
  viewer.inspection.restore=(scene,options)=>restore({...scene,inspection:{...scene.inspection,placement:initial.inspection.placement}},options);
  const next=structuredClone(initial);next.inspection.placement.scale=2;
  let confirmed=false;await assert.rejects(restoreNamedView(viewer,next,()=>{},()=>{confirmed=true;}),/does not match/);
  assert.equal(confirmed,false);assert.deepEqual(viewer.inspection.capture().inspection.placement,initial.inspection.placement);assert.equal(calls.at(-1),'checkpoint');
});
test('admission rejection causes no render and renderer recovery failure stays explicit',async()=>{
  const {initial,viewer,calls}=fixture();await assert.rejects(restoreNamedView(viewer,initial,()=>{throw Error('stale');},()=>{}),/stale/);assert.deepEqual(calls,[]);
  viewer.inspection.restore=async()=>{throw Error('context lost');};
  await assert.rejects(restoreNamedView(viewer,initial,()=>{},()=>{}),/could not be restored/);assert.equal(calls.at(-1),'checkpoint');
});

test('a transient capture refusal keeps its code and actionable sentence for the receipt',async()=>{
  const {viewer}=fixture();
  const refusal=Object.assign(new Error('Hold still and release the grip, then save again.'),{code:'capture_refused'});
  viewer.inspection.captureNamedViewIntent=()=>{throw refusal;};
  let confirmed=false;
  await assert.rejects(captureNamedView(viewer,()=>{},()=>{confirmed=true;}),/Hold still and release the grip, then save again/);
  assert.equal(confirmed,false);
  try { await captureNamedView(viewer,()=>{},()=>{}); assert.fail('expected refusal'); }
  catch(error) { assert.equal(error.code,'capture_refused'); }
});

test('named capture sends intent only through private completion; restoration adapts before rendering',async()=>{
  const {initial,viewer,calls}=fixture();const intent={version:1};
  viewer.inspection.captureNamedViewIntent=()=>intent;
  await captureNamedView(viewer,()=>{},(scene,applied)=>{assert.equal(applied.namedViewIntent,intent);assert.equal(scene.namedViewIntent,undefined);});
  let adapted=false;
  viewer.inspection.sceneForNamedView=(scene,received)=>{assert.equal(received,intent);adapted=true;return {...scene,camera:{position:[0,0,2]}};};
  await restoreNamedView(viewer,initial,()=>{},(scene)=>{assert.ok(adapted);assert.deepEqual(scene.camera,{position:[0,0,2]});},intent);
  assert.equal(calls.at(-1),'end');
});

test('a superseded named restore waits for its rollback frame before releasing the queue',async()=>{
  const {initial,viewer}=fixture();
  let start,finish;
  const started=new Promise(resolve=>{start=resolve;});
  const frame=new Promise(resolve=>{finish=resolve;});
  let released=false;
  viewer.inspection.rollbackOperation=async()=>{start();await frame;};
  const cancelled=Object.assign(Error('Superseded named restore.'),{code:'superseded'});
  const restoring=restoreNamedView(viewer,initial,()=>{},()=>{throw cancelled;});
  const rejected=assert.rejects(restoring,/Superseded named restore/);
  const next=restoring.catch(()=>{}).then(()=>{released=true;});
  await started;assert.equal(released,false);
  finish();await rejected;await next;assert.equal(released,true);
});

test('a failed named rollback frame cannot masquerade as a settled supersession',async()=>{
  const {initial,viewer}=fixture();
  viewer.inspection.rollbackOperation=async()=>{throw Error('Named rollback frame failed.');};
  await assert.rejects(restoreNamedView(viewer,initial,()=>{},()=>{
    throw Object.assign(Error('Superseded named restore.'),{code:'superseded'});
  }),error=>error.message==='Named rollback frame failed.' && error.code!=='superseded');
});
