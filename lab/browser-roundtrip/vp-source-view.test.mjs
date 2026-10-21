import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { createLessonMotionHold } from './lesson-motion.mjs';
import { BoundaryHelper } from 'molstar/lib/mol-math/geometry/boundary-helper.js';
import { Camera } from 'molstar/lib/mol-canvas3d/camera.js';

const workspace=readFileSync(new URL('../inspection/workspace.mjs',import.meta.url),'utf8');
const viewer=readFileSync(new URL('./viewer.mjs',import.meta.url),'utf8');
function fn(source,name,indent='  ') {
  const start=source.search(new RegExp(`${indent}(?:async )?function ${name}\\(`));
  assert.ok(start>=0);return source.slice(start,source.indexOf(`\n${indent}}`,start)+indent.length+2);
}

for(const enableXr of [false,true]) test(`source-bound saved view on ${enableXr?'headset':'desktop'} page`,async()=>{
  const elements=new Map();const $=selector=>{
    if(!elements.has(selector))elements.set(selector,{replaceChildren(){},append(){}});
    return elements.get(selector);
  };
  const restores=[],loads=[];
  const context=vm.createContext({$,options:{enableXr},demoSourceIdentity:()=>undefined,
    document:{body:{dataset:{}},createTextNode:()=>({}),createElement:()=>({})},
    viewer:{snapshot:()=>({ready:true,xrPresenting:false}),load:async(source,settings)=>{loads.push(settings);},
      inspection:{restore:async(scene)=>restores.push(scene),capture:()=>({})}},
    run:async(_line,operation)=>operation(),currentRows:()=>[],renderSequence(){},
    fixture:null,searchValue:'',chainValue:'',anchor:null,loadedView:null,walkthrough:null});
  vm.runInContext(fn(workspace,'loadSource',''),context);
  const next={id:'session',sha256:'new',catalog:{modelNumbers:[1],assemblyId:'1'}};
  const saved={sourceSha256:'old',modelNumber:1,assemblyId:'1',camera:{target:[1000,0,0]}};
  await context.loadSource(next,{scene:saved});assert.equal(restores.length,0);
  await context.loadSource(next,{scene:{...saved,sourceSha256:'new',modelNumber:2}});assert.equal(restores.length,0);
  await context.loadSource(next,{scene:{...saved,sourceSha256:'new',assemblyId:'2'}});assert.equal(restores.length,0);
  const matching={...saved,sourceSha256:'new'};
  await context.loadSource(next,{scene:matching});assert.equal(restores[0],matching);
  assert.ok(loads.every(settings=>!settings.camera));
});

test('fresh source fits only candidate geometry, while preserving explicit and immersive cameras',async()=>{
  for(const settings of [{},{camera:{target:[7,8,9]}},{preserveRoomPlacement:true}]) {
    const old={center:[10000,0,0],radius:10},next={center:[0,0,0],radius:5};
    const scene=new Set([old,next]), camera=new Camera(), resets=[], written=[];
    const canvas={xr:{isPresenting:{value:Boolean(settings.preserveRoomPlacement)}},commit(){},remove:ref=>scene.delete(ref),
      requestCameraReset(options){resets.push(options);if(options.snapshot&&typeof options.snapshot!=='function')camera.setState(options.snapshot,options.durationMs??0);},
      camera:{getFocus:(...args)=>camera.getFocus(...args),getInvariantFocus:(...args)=>camera.getInvariantFocus(...args),
        setState(value,durationMs){written.push(value);camera.setState(value,durationMs??0);}}};
    const cameraManager={focusSphere(sphere,options){
      const radius=Math.max(sphere.radius+(options.extraRadius??0),options.minRadius??0);
      this.focusSnapshot(canvas.camera.getFocus(sphere.center,radius),options);
    },focusSnapshot(snapshot,options){canvas.requestCameraReset({snapshot,durationMs:options.durationMs??0});}};
    const context=vm.createContext({now:()=>0,recordCost(){},state:{},retainedRepresentationCount:0,styleLayers:[],BoundaryHelper,
      assertLoad(){},markRecord(){},recordBoundingSphere:record=>record.structure.obj.data.boundary.sphere,
      plugin:{state:{data:{updateCellState(){}}},managers:{camera:cameraManager}},
      canvas,waitForFrame:async()=>{},checkpoint:async()=>{}});
    vm.runInContext(fn(viewer,'showCandidate'),context);
    const candidate={representation:{ref:'new',obj:{data:{repr:{renderObjects:[]}}}},structure:{obj:{data:{boundary:{sphere:next}}}},selectionKeys:[]};
    await context.showCandidate(candidate,{representation:{obj:{data:{repr:old}}},structure:{obj:{data:{boundary:{sphere:old}}}}},settings,{});
    if(settings.preserveRoomPlacement){assert.equal(resets.length,0);assert.equal(written.length,0);}
    else if(settings.camera){assert.equal(written.length,1);assert.equal(written[0],settings.camera);assert.equal(resets.length,0);}
    else {
      assert.equal(resets.length,1);
      assert.deepEqual(Array.from(resets[0].snapshot.target),next.center,'camera target comes from the candidate bounds');
      assert.equal(resets[0].snapshot.radius,next.radius,'camera distance uses the candidate radius');
      const expected=new Camera().getFocus(next.center,next.radius);
      assert.deepEqual(Array.from(resets[0].snapshot.position),Array.from(expected.position));
    }
  }
});

test('capture scopes its pinned presentation camera to the exact source and can return to it after rollback',()=>{
  const expression=viewer.match(/camera: (cameraSnapshot\(lessonMotionHold\.presented[^\n]+)?,/)[1];
  assert.ok(expression);
  const hold=createLessonMotionHold();
  const old={sourceSha256:'old',modelNumber:1,assemblyId:'1'},saved={target:[10000,0,0]},fitted={target:[0,0,0]};
  hold.hold(saved,old);
  for(const source of [{...old,sourceSha256:'new'},{...old,modelNumber:2},{...old,assemblyId:'2'},old]) {
    const context=vm.createContext({lessonMotionHold:hold,cameraSnapshot:value=>value,desktopPreviewCamera:undefined,scene:{...source,camera:fitted}});
    assert.equal(vm.runInContext(expression,context),source===old?saved:fitted);
  }
  const next={...old,sourceSha256:'new'};
  hold.hold(fitted,next);assert.equal(hold.presented(saved,next),fitted);
});
