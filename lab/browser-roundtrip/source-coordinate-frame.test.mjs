import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {preserveSourceTransitionAnchor} from './source-transition-anchor.mjs';

const oldBase={center:[11,-7,4],radius:55},newBase={center:[-15,8,3],radius:30};
const placement={translation:[.5,.3,-2.8],rotation:[17,-35,12],scale:2.1};
function transformed(point,base,pose){
  const [x,y,z]=pose.rotation.map(d=>d*Math.PI/180),v=point.map((a,i)=>(a-base.center[i])*pose.scale);
  const a=[v[0],Math.cos(x)*v[1]-Math.sin(x)*v[2],Math.sin(x)*v[1]+Math.cos(x)*v[2]];
  const b=[Math.cos(y)*a[0]+Math.sin(y)*a[2],a[1],-Math.sin(y)*a[0]+Math.cos(y)*a[2]];
  const c=[Math.cos(z)*b[0]-Math.sin(z)*b[1],Math.sin(z)*b[0]+Math.cos(z)*b[1],b[2]];
  return c.map((v,i)=>v+base.center[i]+pose.translation[i]*base.radius);
}
test('shared source frame preserves every common target point at exact Å scale across different batch bounds',()=>{
  const result=preserveSourceTransitionAnchor({priorBase:oldBase,nextBase:newBase,priorPlacement:placement,
    priorCameraScale:.02,priorCoordinateFrame:'gallery-v1',nextCoordinateFrame:'gallery-v1'});
  assert.equal(result.placement.scale,placement.scale);assert.equal(result.cameraScale,.02);
  assert.deepEqual(result.placement.rotation,placement.rotation);
  for(const point of [[0,0,0],[3,7,-2],[-11,14,20]]){
    const before=transformed(point,oldBase,placement),after=transformed(point,newBase,result.placement);
    for(let i=0;i<3;i++)assert.ok(Math.abs(before[i]-after[i])<1e-10);
  }
});
for(const pair of [[undefined,undefined],['gallery-v1','gallery-v2'],['gallery-v1',undefined]])
test(`unrelated frames retain ordinary diameter-preserving source transition: ${pair}`,()=>{
  const plain={priorBase:oldBase,nextBase:newBase,priorPlacement:placement,priorCameraScale:.02};
  const result=preserveSourceTransitionAnchor({...plain,priorCoordinateFrame:pair[0],nextCoordinateFrame:pair[1]});
  assert.deepEqual(result,preserveSourceTransitionAnchor(plain));
});
test('the production viewer propagates shared framing and suppresses only the next initial figure refit',()=>{
  const source=readFileSync(new URL('./viewer.mjs',import.meta.url),'utf8');
  const start=source.indexOf('  function transitionRoomAnchor('),end=source.indexOf('\n  }',start)+4;
  const context=vm.createContext({inspectionState:{},transitionBounds:r=>({base:r.bounds,visible:r.bounds}),
    inspectionSnapshot:()=>({placement}),canvas:{camera:{scale:.02}},preserveSourceTransitionAnchor});
  vm.runInContext(source.slice(start,end),context);
  for(const same of [true,false]){
    const previous={bounds:oldBase,coordinateFrame:'gallery-v1'},candidate={bounds:newBase,
      coordinateFrame:same?'gallery-v1':'other',initialFigureFrame:{fitted:{xr:false}}};
    const anchor=context.transitionRoomAnchor(previous,candidate,{preserveRoomPlacement:true});
    assert.equal(candidate.initialFigureFrame.fitted.xr,same);
    assert.equal(anchor.placement.scale,same?2.1:55*2.1/30);
  }
  assert.equal(context.transitionRoomAnchor({bounds:oldBase},{bounds:newBase},{preserveRoomPlacement:false}),undefined);
});

test('same-source lesson metadata binds only to its verified loaded digest and can clear the frame',()=>{
  const source=readFileSync(new URL('./viewer.mjs',import.meta.url),'utf8');
  const start=source.indexOf('  function setSourceCoordinateFrame('),end=source.indexOf('\n  }',start)+4;
  const context=vm.createContext({assertReady(){},liveScene:()=>({sourceSha256:'loaded'}),sourceCoordinateFrame:undefined,
    failure:(_code,message)=>Error(message)});
  vm.runInContext(source.slice(start,end),context);
  context.setSourceCoordinateFrame('gallery-v1','loaded');assert.equal(context.sourceCoordinateFrame,'gallery-v1');
  assert.throws(()=>context.setSourceCoordinateFrame('another-v1','stale'),/different source/);
  assert.equal(context.sourceCoordinateFrame,'gallery-v1');
  context.setSourceCoordinateFrame(undefined,'loaded');assert.equal(context.sourceCoordinateFrame,undefined);
});

test('a common coordinate frame retains the exact pose and ownership even through a source-replacement entry handoff',async()=>{
  const shared=preserveSourceTransitionAnchor({priorBase:oldBase,nextBase:newBase,priorPlacement:placement,
    priorCameraScale:.02,priorCoordinateFrame:'gallery-v1',nextCoordinateFrame:'gallery-v1'});
  assert.equal(shared.preservesCoordinateFrame,true);
  const source=readFileSync(new URL('./viewer.mjs',import.meta.url),'utf8');
  const policy=source.slice(source.indexOf('      if (inspectionState) {\n        inspectionLabel = undefined;'),source.indexOf("      recordRenderCost('load'",source.indexOf('const sourceAnchor = transitionRoomAnchor(previous, candidate, settings);')));
  for(const seatForEntry of [false,true]) for(const [anchor,preserve] of [[shared,true],[{...shared,preservesCoordinateFrame:undefined},false]]){
    let releases=0,seats=0;const placements=[];
    const context=vm.createContext({inspectionState:{reset(){},place(pose){placements.push(pose);}},inspectionLabel:null,ligandOverlay:null,
      settings:{seatForEntry},sourceAnchor:anchor,setXrCameraScale(){},operation:{},checkpoint:async()=>{},applyInspectionAppearance:async()=>{},
      now:()=>0,canvas:{commit(){},xr:{isPresenting:{value:true}},camera:{getSnapshot:()=>({})}},waitForFrame:async()=>{},
      cameraSnapshot:v=>v,state:{revision:0,loadCount:0,mutationCounts:{load:0}},deleteRecord:async()=>{},previous:{},assertLoad(){},
      inspectionSnapshot:()=>({placement:{rotation:[0,0,0]}}),seatSwappedSource(){seats++;return {};},
      releaseWearerPlacement(){releases++;},pendingGrowthTurn:false});
    // Run the extracted production load policy through its awaited cleanup.
    const pending=await vm.runInContext(`(async()=>{${policy};return pendingGrowthTurn})()`,context);
    assert.equal(releases,preserve?0:1);
    assert.equal(seats,seatForEntry&&!preserve?1:0);
    if(preserve){
      assert.equal(pending,false);assert.equal(placements.length,1);
      assert.equal(placements[0],anchor.placement);
      assert.deepEqual(placements[0].rotation,placement.rotation);
      assert.equal(placements[0].scale,placement.scale);
    }else assert.equal(pending,!seatForEntry);
  }
});
