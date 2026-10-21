import test from 'node:test';
import { setCanvasModule } from 'molstar/lib/mol-geo/geometry/text/font-atlas.js';
import assert from 'node:assert/strict';
import { createMeasurementLines } from './measurement-lines.mjs';
import { getMaxSize } from 'molstar/lib/mol-geo/geometry/size-data.js';
import { cylinderRadiusScale } from './immersive-annotations.mjs';
import { measurementPosition,measurementValues } from './measurement-math.mjs';
import { poseMatrix } from './molecular-animation.mjs';
import { evaluateTrack } from '../../packages/motion/src/keyframes.mjs';
import { RxEventHelper } from 'molstar/lib/mol-util/rx-event-helper.js';
import { Mat4,Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';

test('measurement pose matches renderer quaternion and translation at intermediate times',()=>{
  const track={id:'moving',chains:['A'],keyframes:[{t:0,rotation:[0,0,0,1],translation:[0,0,0]},
    {t:2,rotation:[0,0,1,0],translation:[10,0,0]}]};
  for(const seconds of [0,.5,1,2]) {
    const endpoint={authorChain:'A',position:[1,2,3]};
    const actual=measurementPosition(endpoint,{tracks:[track]},seconds);
    const expected=Vec3.transformMat4(Vec3(),endpoint.position,poseMatrix(evaluateTrack(track,seconds)));
    actual.forEach((v,i)=>assert.ok(Math.abs(v-expected[i])<1e-12));
  }
  assert.equal(measurementValues([[0,0,0],[3,4,0]]).distanceAngstrom,5);
});
test('line and numeric label follow independent bodies and remove all representations',async(t)=>{
  // Replace only DOM font rasterization; exercise real Mol* shape transforms.
  setCanvasModule({createCanvas:()=>({getContext:()=>({measureText(){return {width:40};},clearRect(){},fillText(){},
    getImageData:(_x,_y,w,h)=>({data:new Uint8ClampedArray(w*h*4).fill(255)})})})});
  const live=new Set();
  let objectReads=0;
  const blockers=Array.from({length:120},(_,i)=>({type:'mesh',state:{visible:true},values:{boundingSphere:{ref:{version:0,value:{center:[i%12*5-25,Math.floor(i/12)*5-200,-30],radius:2}}}}}));
  const canvas={reprCount:RxEventHelper.create().behavior(0),getRenderObjects(){objectReads++;return blockers;},camera:{scale:.02421},xr:{isPresenting:{value:true}},add:r=>live.add(r),remove:r=>live.delete(r),update(){},requestDraw(){}};
  let timeSeconds=0;
  const definition={tracks:[{id:'moving',chains:['A'],keyframes:[
    {t:0,rotation:[0,0,0,1],translation:[0,0,0]},
    {t:2,rotation:[0,0,0,1],translation:[5,0,0]}]}]};
  const lines=createMeasurementLines({canvas,getTransform:()=>Mat4.identity(),getAnimation:()=>({definition,timeSeconds})});
  const line={id:'gap',a:{key:'a',authorChain:'A',position:[0,0,0]},b:{key:'b',authorChain:'B',position:[0,3,0]},color:'#f2c47c'};
  await lines.install([line]);
  const repr=[...live][0];
  assert.equal(lines.count(),1);assert.equal(live.size,3);
  assert.equal(lines.representationCount(),live.size,'the frame gate counts both the line and label');
  const label=[...live][1];
  assert.equal(label.getAllLoci()[0].shape.sourceData.text,'3.0 Å');
  assert.equal(label.renderObjects[0].values.uSizeFactor.ref.value,6);
  assert.equal(label.renderObjects[0].state.stereofoldLessonLabel,true);
  assert.equal(label.state.transform[13],1.5);
  const geometry=[...live].map(r=>r.geometryVersion);
  const first=Array.from(repr.state.transform);
  timeSeconds=2;lines.tick();
  assert.notDeepEqual(Array.from(repr.state.transform),first);
  assert.equal(repr.state.transform[12],5);
  for(const point of [[5,0,0],[0,3,0]]) {
    const sphere=repr.renderObjects[0].values.boundingSphere.ref.value;
    assert.ok(Vec3.distance(sphere.center,point)<=sphere.radius+1e-6);
  }
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(label.getAllLoci()[0].shape.sourceData.text,'5.8 Å');
  assert.deepEqual([...live].map(r=>r.geometryVersion),geometry);
  const midpoint=[2.5,1.5,0],offset=Vec3.sub(Vec3(),label.state.transform.slice(12,15),midpoint);
  assert.ok(Math.hypot(...offset)>=12);
  assert.ok(Math.abs(Vec3.dot(offset,[-5,3,0]))<1e-8,'offset perpendicular to line');
  const leader=[...live][2];
  assert.deepEqual([...leader.state.transform.slice(12,15)],midpoint);
  label.renderObjects[0].values.drawCount.ref.value=6; // simulated rasterized glyph
  assert.deepEqual(lines.definition(),[line]);
  assert.equal(lines.drawn(new Set()),false);
  assert.equal(lines.drawn(new Set(repr.renderObjects)),false);
  assert.equal(lines.drawn(new Set([...repr.renderObjects,...label.renderObjects])),false);
  assert.equal(lines.drawn(new Set([...live].flatMap(r=>r.renderObjects))),true);
  const leaderObject=leader.renderObjects[0];
  assert.equal(leaderObject.type,'cylinders','solid capped annotation leader');
  assert.ok(getMaxSize(leaderObject.values)*leaderObject.values.uSizeFactor.ref.value*2*canvas.camera.scale>=.016-1e-6);
  const timings=[];
  const reads=objectReads;
  for(let i=0;i<2400;i++) {
    timeSeconds=(i%144)/72;
    const start=performance.now();lines.tick();
    if(i>=400) timings.push(performance.now()-start);
  }
  timings.sort((a,b)=>a-b);const p95=timings[Math.floor(timings.length*.95)];
  console.log(`Complete measurement tick p95 ${p95.toFixed(3)} ms with 120 blockers`);
  assert.ok(p95<.5,`measurement tick p95 ${p95} ms exceeds 0.5 ms`);
  assert.equal(objectReads,reads,'pose ticks reuse scene membership without allocating an object array');
  canvas.reprCount.next(120);lines.tick();assert.equal(objectReads,reads+1,'membership commits refresh blockers');
  assert.deepEqual([...live].map(r=>r.geometryVersion),geometry,'motion never rebuilds measurement geometry');
  await lines.install([]);assert.equal(lines.count(),0);assert.equal(live.size,0);
  assert.equal(lines.representationCount(),0);
  assert.equal(lines.drawn(new Set()),true);
});

test('measurement honors same-chain residue/component ownership and pivot poses',()=>{
  const tracks=[{id:'domain',chains:['A'],selector:{residues:[{from:1,to:5}]},pivot:[3,2,1],keyframes:[
    {t:0,rotation:[0,0,0,1],translation:[0,0,0]}, {t:2,rotation:[0,0,1,0],translation:[10,0,0]}]},
    {id:'ligand',chains:['A'],selector:{componentIds:['ATP']},keyframes:[{t:0,rotation:[0,0,0,1],translation:[0,8,0]}]}];
  const definition={tracks};
  for (const seconds of [0,1,2]) {
    const moving={authorChain:'A',authorResidue:2,componentId:'GLY',position:[5,3,1]};
    const expected=Vec3.transformMat4(Vec3(),moving.position,poseMatrix(evaluateTrack(tracks[0],seconds)));
    measurementPosition(moving,definition,seconds).forEach((v,i)=>assert.ok(Math.abs(v-expected[i])<1e-12));
    const fixed={...moving,authorResidue:10};
    assert.deepEqual(measurementPosition(fixed,definition,seconds),fixed.position);
    assert.deepEqual(measurementPosition({...fixed,componentId:'ATP'},definition,seconds),[5,11,1]);
  }
});

test('tracked XR eyes rotate the live clearance seat by 90 degrees; desktop resumes its camera',async()=>{
  setCanvasModule({createCanvas:()=>({getContext:()=>({measureText:()=>({width:40}),clearRect(){},fillText(){},
    getImageData:(_x,_y,w,h)=>({data:new Uint8ClampedArray(w*h*4).fill(255)})})})});
  const live=new Set(), scale=.02421;
  const body={type:'mesh',state:{visible:true},values:{boundingSphere:{ref:{value:{center:[0,0,-20],radius:8}}}}};
  const canvas={camera:{scale,view:Mat4.lookAt(Mat4(),[0,0,3],[0,0,0],[0,1,0]),state:{mode:'perspective'}},
    xr:{isPresenting:{value:false}},add:r=>live.add(r),remove:r=>live.delete(r),update(){},requestDraw(){},getRenderObjects:()=>[body]};
  const lines=createMeasurementLines({canvas,getTransform:()=>Mat4.identity(),getAnimation:()=>null});
  await lines.install([{id:'gap',a:{position:[-20,0,0]},b:{position:[20,0,0]},color:'#f2c47c'}]);
  const label=[...live][1], versions=[...live].map(r=>r.geometryVersion);
  const stereo={left:{view:Mat4.lookAt(Mat4(),[-.032,3,0],[-.032,0,0],[0,0,-1])},
    right:{view:Mat4.lookAt(Mat4(),[.032,3,0],[.032,0,0],[0,0,-1])}};
  canvas.xr.isPresenting.value=true;
  lines.tick(stereo);
  const point=[...label.state.transform.slice(12,15)];
  assert.ok(point[2]>0,'tracked eyes choose the empty +Z side; stale desktop chooses +Y');
  assert.ok(Math.abs(point[1])<1e-8);
  for(const eye of [stereo.left,stereo.right]) {
    const p=Vec3.transformMat4(Vec3(),Vec3.scale(Vec3(),point,scale),eye.view);
    const c=Vec3.transformMat4(Vec3(),Vec3.scale(Vec3(),body.values.boundingSphere.ref.value.center,scale),eye.view);
    const radius=8*scale;
    // Plate and body are separated vertically in both tracked eye planes.
    assert.ok(p[1]/-p[2]+.1 < (c[1]-radius)/(-c[2]+radius));
  }
  assert.deepEqual([...live].map(r=>r.geometryVersion),versions);
  canvas.xr.isPresenting.value=false;lines.tick();
  assert.equal(label.state.transform[14],0,'desktop placement uses the parent camera again');
  assert.ok(Math.abs(label.state.transform[13])>=12);
  await lines.install([]);
});

test('near-eye obstruction switches a retained live plate without uploading nonfinite label or leader transforms',async()=>{
  setCanvasModule({createCanvas:()=>({getContext:()=>({measureText:()=>({width:40}),clearRect(){},fillText(){},
    getImageData:(_x,_y,w,h)=>({data:new Uint8ClampedArray(w*h*4).fill(255)})})})});
  const live=new Set(), blockers=[];
  const canvas={camera:{scale:1},xr:{isPresenting:{value:true}},add:r=>live.add(r),remove:r=>live.delete(r),
    update(repr){assert.ok([...repr.state.transform].every(Number.isFinite),'all uploaded transforms are finite');},
    requestDraw(){},getRenderObjects:()=>blockers};
  const lines=createMeasurementLines({canvas,getTransform:()=>Mat4.identity(),getAnimation:()=>null});
  const stereo={left:{view:Mat4.fromRotation(Mat4(),-.13,[1,0,0])},right:{view:Mat4.fromRotation(Mat4(),-.15,[1,0,0])}};
  await lines.install([{id:'gap',a:{position:[-20,0,-100]},b:{position:[20,0,-100]},color:'#f2c47c'}]);
  try {
    lines.tick(stereo);
    const label=[...live][1],leader=[...live][2],versions=[...live].map(r=>r.geometryVersion);
    assert.ok(label.state.transform[13]>0,'positive side is initially retained');
    blockers.push({type:'mesh',state:{visible:true},values:{boundingSphere:{ref:{value:{center:[-7.4,9.6,-1],radius:11.2}}}}});
    lines.tick(stereo);
    assert.ok(label.state.transform[13]<0,'near-eye blocker forces the finite opposite escape');
    for(const repr of [label,leader]) {
      assert.ok([...repr.state.transform].every(Number.isFinite));
      for(const object of repr.renderObjects) assert.ok([...object.values.aTransform.ref.value].every(Number.isFinite));
    }
    assert.deepEqual([...live].map(r=>r.geometryVersion),versions);
  } finally {await lines.install([]);}
});


test('distance leader stays a readable annotation stroke on small-molecule XR scales',async()=>{
  setCanvasModule({createCanvas:()=>({getContext:()=>({measureText:()=>({width:40}),clearRect(){},fillText(){},
    getImageData:(_x,_y,w,h)=>({data:new Uint8ClampedArray(w*h*4).fill(255)})})})});
  const live=new Set(),canvas={camera:{scale:.02421},xr:{isPresenting:{value:true}},
    add:r=>live.add(r),remove:r=>live.delete(r),update(){},requestDraw(){},getRenderObjects:()=>[]};
  const lines=createMeasurementLines({canvas,getTransform:()=>Mat4.identity(),getAnimation:()=>null});
  const line={id:'small-fold',a:{position:[16.967,12.784,4.338]},b:{position:[8.496,4.609,8.837]},color:'#f2c47c'};
  try {
    await lines.install([line]);
    const [distance,label,leader]=[...live],versions=[...live].map(r=>r.geometryVersion);
    assert.ok(Math.abs(getMaxSize(leader.renderObjects[0].values)-.07)<1e-6,
      'a measurement leader uses the fine distance-stroke radius, not the thick animation linker');
    const segment=[...distance.state.transform];
    for(const scale of [.005,.02421,.06,.1]) {
      canvas.camera.scale=scale;lines.tick();
      const v=leader.renderObjects[0].values;
      const diameter=2*getMaxSize(v)*v.uSizeFactor.ref.value*scale*cylinderRadiusScale(v.matrix.ref.value);
      assert.ok(diameter>=.016-1e-6 && diameter<=.016+1e-6,`readable 16 mm leader at scale ${scale}, got ${diameter} m, uniform ${v.uSizeFactor.ref.value}, radius ${getMaxSize(v)}, radiusScale ${cylinderRadiusScale(v.matrix.ref.value)}`);
      assert.equal(label.getAllLoci()[0].shape.sourceData.text,'12.6 Å');
      assert.deepEqual([...distance.state.transform],segment,'measured endpoints do not move');
    }
    assert.deepEqual(lines.definition(),[line]);
    assert.deepEqual([...live].map(r=>r.geometryVersion),versions);
  } finally {await lines.install([]);}
});
