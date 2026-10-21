import test from 'node:test';
import assert from 'node:assert/strict';
import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { Visual } from 'molstar/lib/mol-repr/visual.js';
import { createTransform } from 'molstar/lib/mol-geo/geometry/transform-data.js';
import { ValueCell } from 'molstar/lib/mol-util/value-cell.js';
import { Sphere3D } from 'molstar/lib/mol-math/geometry/primitives/sphere3d.js';
import { motionFixture, sixBodyAnimation } from './motion-benchmark-fixture.mjs';
import { setMotionTransform } from './motion-transform.mjs';
import { evaluateTrack } from '../../packages/motion/src/keyframes.mjs';
import { poseMatrix } from './molecular-animation.mjs';

test('visible solid tethers retain zero rebuilds and pose update p95 below 2 ms', async t => {
  const h=await motionFixture();
  try {
    const reprs=[...h.registry.representations(),...h.registry.tetherRepresentations()];
    const geometry=reprs.map(r=>r.geometryVersion);
    h.registry.tick(0);
    for(let i=1;i<=300;i++)h.registry.tick(i*1000/72);
    const samples=[];
    for(let i=301;i<=2300;i++) {
      const start=performance.now(); h.registry.tick(i*1000/72);
      samples.push(performance.now()-start);
    }
    samples.sort((a,b)=>a-b);
    const p95=samples[Math.floor(samples.length*.95)];
    t.diagnostic(`pose update p95 ${p95.toFixed(3)} ms; geometryRebuilds 0`);
    assert.ok(p95<2,`pose update p95 ${p95} ms`);
    assert.deepEqual(reprs.map(r=>r.geometryVersion),geometry);
    assert.ok(h.costs.every(cost=>(cost.geometryRebuilds??0)===0));
  } finally { await h.dispose(); }
});

test('six real Mol* bodies, labels and tethers skip hidden/settled work and batch every changed tick',async()=>{
  const h=await motionFixture();
  try {
    const reprs=[...h.registry.representations(),...h.figure.annotations()];
    const calls=new Map(), geometry=reprs.map(r=>r.geometryVersion), buffers=new Map();
    for(const r of reprs){const fn=r.setState;calls.set(r,0);r.setState=p=>{calls.set(r,calls.get(r)+1);return fn(p);};
      for(const o of r.renderObjects) buffers.set(o,{grid:o.values.instanceGrid.ref.value,transform:o.values.aTransform.ref.value, transformVersion:o.values.aTransform.ref.version, boundsVersion:o.values.boundingSphere.ref.version});}
    const before={...h.counts};h.registry.apply();
    assert.equal(h.counts.uploads,before.uploads);assert.ok([...calls.values()].every(n=>n===0));
    h.registry.tick(0);h.registry.tick(100);
    assert.equal(h.counts.uploads,before.uploads+1,'one changed-object upload batch');
    const hidden=reprs.filter(r=>!r.state.visible);
    assert.equal(hidden.length,16,'four bodies, four labels, four tether lines and four midpoint labels');
    for(const r of hidden){assert.equal(calls.get(r),0,'no hidden setState');for(const o of r.renderObjects){
      assert.equal(o.values.aTransform.ref.version,buffers.get(o).transformVersion);
      assert.equal(o.values.boundingSphere.ref.version,buffers.get(o).boundsVersion,'no hidden bounds repair');
    }}
    for(const r of hidden)for(const o of r.renderObjects){assert.equal(o.values.instanceGrid.ref.value,buffers.get(o).grid);assert.equal(o.values.aTransform.ref.value,buffers.get(o).transform);}
    h.registry.control({state:'pause',seekSeconds:2.5});
    const bodies=h.registry.representations().filter(r=>r.renderObjects.some(o=>o.type==='mesh'));
    assert.equal(bodies.filter(r=>r.state.visible).length,2);
    for(const i of [2,3]){
      const expected=poseMatrix(evaluateTrack(sixBodyAnimation.tracks[i],2.5));
      assert.deepEqual([...bodies[i].state.transform],[...expected]);
      for(const o of bodies[i].renderObjects)assert.ok(Vec3.distance(o.values.boundingSphere.ref.value.center,
        Vec3.transformMat4(Vec3(),o.values.invariantBoundingSphere.ref.value.center,expected))<1e-4);
    }
    h.registry.control({seekSeconds:.5});
    assert.equal(bodies[0].state.visible,true);assert.equal(bodies[2].state.visible,false);
    const settled={...h.counts};h.registry.apply();assert.deepEqual(h.counts,settled);
    assert.deepEqual(reprs.map(r=>r.geometryVersion),geometry);
    for(const r of reprs)for(const o of r.renderObjects){assert.equal(o.values.instanceGrid.ref.value,buffers.get(o).grid);assert.equal(o.values.aTransform.ref.value,buffers.get(o).transform);}
  }finally{await h.dispose();}
});

test('fast transform preserves nonserial instance ordering, extra transforms and enclosing grid bounds',()=>{
  const base=new Float32Array(16*8),extra=new Float32Array(16*8),m=Mat4.identity();
  for(let i=0;i<8;i++){
    Mat4.fromTranslation(m,[(i%2)*80,Math.floor(i/2)*20,0]);Mat4.toArray(m,base,i*16);
    Mat4.fromTranslation(m,[0,0,i]);Mat4.toArray(m,extra,i*16);
  }
  const invariant=Sphere3D.create(Vec3(),3),v=createTransform(base,8,invariant,20,50);
  v.extraTransform.ref.value.set(extra);ValueCell.update(v.hasExtraTransform,true);
  v.invariantBoundingSphere=ValueCell.create(invariant);v.boundingSphere=ValueCell.create(Sphere3D());
  const object={values:v},repr={renderObjects:[object],setState:p=>Visual.setTransform(object,p.transform)};
  const grid=v.instanceGrid.ref.value,order=[...v.aInstance.ref.value],output=v.aTransform.ref.value;
  const transform=Mat4.fromRotation(Mat4(),.6,[0,1,0]);Mat4.scale(transform,transform,[2,1,3]);
  setMotionTransform(repr,{transform});
  assert.equal(v.aTransform.ref.value,output);assert.equal(v.instanceGrid.ref.value,grid);assert.deepEqual([...v.aInstance.ref.value],order);
  for(let i=0;i<8;i++){
    const id=order[i],a=Mat4.fromArray(Mat4(),base,id*16),e=Mat4.fromArray(Mat4(),extra,id*16);
    const expected=Mat4.mul3(Mat4(),transform,e,a);
    expected.forEach((x,j)=>assert.ok(Math.abs(x-output[i*16+j])<1e-4));
    const center=Vec3.transformMat4(Vec3(),invariant.center,expected),sphere=v.boundingSphere.ref.value;
    assert.ok(Vec3.distance(center,sphere.center)+9<=sphere.radius+1e-4);
  }
  const saved=Visual.setTransform;
  assert.throws(()=>setMotionTransform({setState(){throw Error('injected');}},{transform}),/injected/);
  assert.equal(Visual.setTransform,saved,'scoped fast path always restores the upstream setter');
});

test('production placement cache avoids rebuilding presentation matrices between edits',async()=>{
  const {createMolecularAnimation}=await import('./molecular-animation.mjs');let reads=0;
  const h=await motionFixture({createAnimation:options=>createMolecularAnimation({...options,cachePresentation:true,
    getTransform(){reads++;return options.getTransform();}})});
  try{
    const initial=reads;h.registry.tick(0);h.registry.tick(100);h.registry.tick(200);assert.equal(reads,initial);
    Mat4.setTranslation(h.presentation,[20,4,1]);h.registry.apply({presentation:h.presentation});
    h.registry.tick(300);assert.equal(reads,initial);
    const expected=Mat4.mul(Mat4(),h.presentation,poseMatrix(evaluateTrack(sixBodyAnimation.tracks[0],.3)));
    assert.ok(Mat4.areEqual(h.registry.representations()[0].state.transform,expected,1e-12));
  }finally{await h.dispose();}
});

test('failed tether staging releases every newly created line and label',async()=>{
  const h=await motionFixture();
  try{
    const pending=[];let calls=0;
    h.canvas.add=repr=>{pending.push(repr);if(++calls===3)throw Error('canvas staging failed');};
    await assert.rejects(h.registry.install(sixBodyAnimation),/canvas staging failed/);
    assert.equal(h.registry.snapshot(),null);assert.deepEqual(h.registry.tetherRepresentations(),[]);
    assert.ok(pending.every(repr=>repr.renderObjects.length===0));
    h.canvas.add=()=>{};await h.registry.install(sixBodyAnimation);
    assert.equal(h.registry.tetherRepresentations().length,12);
  }finally{await h.dispose();}
});


test('live measurement adds under 0.5 ms with zero rebuilds and total pose below 2 ms',async t=>{
  const {createMeasurementLines}=await import('./measurement-lines.mjs');
  const h=await motionFixture();
  try {
    const live=new Set();h.canvas.add=r=>live.add(r);h.canvas.remove=r=>live.delete(r);h.canvas.requestDraw=()=>{};
    h.canvas.getRenderObjects=()=>[...h.registry.representations(),...live].flatMap(r=>r.renderObjects);
    const lines=createMeasurementLines({canvas:h.canvas,getTransform:()=>h.presentation,getAnimation:()=>h.registry.poseSample()});
    await lines.install([{id:'heads',color:'#f2c47c',a:{authorChain:'H0',position:[0,0,0]},b:{authorChain:'H2',position:[40,0,0]}}]);
    const reprs=[...h.registry.representations(),...live],versions=reprs.map(r=>r.geometryVersion);
    const buffers=[...live].flatMap(r=>r.renderObjects).map(o=>[o,o.values.aTransform.ref.value,o.values.aMapping?.ref.value,o.values.aTexCoord?.ref.value]);
    const stereo={left:{view:Mat4.lookAt(Mat4(),[-.032,3,0],[-.032,0,0],[0,0,-1])},
      right:{view:Mat4.lookAt(Mat4(),[.032,3,0],[.032,0,0],[0,0,-1])}};
    h.canvas.xr.isPresenting.value=true;
    h.registry.tick(0);const times=[],measurementTimes=[];
    for(let i=1;i<=2300;i++) {
      const began=performance.now();h.registry.tick(i*1000/72);
      const measurementStart=performance.now();lines.tick(stereo);const ended=performance.now();
      if(i>300) {times.push(ended-began);measurementTimes.push(ended-measurementStart);}
    }
    times.sort((a,b)=>a-b);const p95=times[Math.floor(times.length*.95)];
    measurementTimes.sort((a,b)=>a-b);const measurementP95=measurementTimes[Math.floor(measurementTimes.length*.95)];
    t.diagnostic(`measurement only p95 ${measurementP95.toFixed(3)} ms`);
    assert.ok(measurementP95<.5,`measurement adds ${measurementP95} ms, expected <0.5 ms`);
    t.diagnostic(`measurement + six bodies pose p95 ${p95.toFixed(3)} ms; geometryRebuilds 0`);
    assert.ok(p95<2);assert.deepEqual(reprs.map(r=>r.geometryVersion),versions);
    for(const [o,transform,mapping,uv] of buffers) {
      assert.equal(o.values.aTransform.ref.value,transform);assert.equal(o.values.aMapping?.ref.value,mapping);assert.equal(o.values.aTexCoord?.ref.value,uv);
    }
    await lines.install([]);assert.equal(live.size,0);
  } finally {await h.dispose();}
});
