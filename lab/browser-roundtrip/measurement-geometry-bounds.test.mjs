import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Camera } from 'molstar/lib/mol-canvas3d/camera.js';
import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { ValueCell } from 'molstar/lib/mol-util/value-cell.js';
import { getMaxSize } from 'molstar/lib/mol-geo/geometry/size-data.js';
import { createMeasurementClearance } from './measurement-clearance.mjs';
import { createMeasurementGeometryBounds, MEASUREMENT_GEOMETRY_LIMIT } from './measurement-geometry-bounds.mjs';

const native=JSON.parse(readFileSync(new URL('./fixtures/measurement-native-1crn.json',import.meta.url),'utf8'));
const a=[16.967,12.784,4.338],b=[8.496,4.609,8.837];
function objects() {
  return native.objects.map(saved=>{
    const object=structuredClone(saved);
    if(object.expandSixVertexAttributes) {
      for(const key of ['aStart','aEnd']) {
        const original=object.values[key].value,expanded=[];
        for(let i=0;i<original.length;i+=3) for(let j=0;j<6;j++) expanded.push(...original.slice(i,i+3));
        object.values[key].value=expanded;
      }
      object.values.aScale.value=object.values.aScale.value.flatMap(n=>Array(6).fill(n));
    }
    for(const [key,cell] of Object.entries(object.values)) object.values[key]={ref:cell};
    return object;
  });
}
function plate(camera,point) {
  const eye=Vec3.transformMat4(Vec3(),Vec3.scale(Vec3(),point,camera.scale),camera.view);
  const offset=native.plate.offsetZ*camera.scale;
  if(camera.state.mode==='perspective') Vec3.scaleAndAdd(eye,eye,Vec3.normalize(Vec3(),eye),-offset);
  else eye[2]+=offset;
  const projected=[];
  for(const x of [-1,1])for(const y of [-1,1])projected.push(Vec3.transformMat4(Vec3(),[
    eye[0]+x*native.plate.halfWidth*camera.scale,eye[1]+y*native.plate.halfHeight*camera.scale,eye[2]],camera.projection));
  return {left:Math.min(...projected.map(p=>p[0])),right:Math.max(...projected.map(p=>p[0])),
    bottom:Math.min(...projected.map(p=>p[1])),top:Math.max(...projected.map(p=>p[1]))};
}
function aggregate(camera,boxes) {
  const result={left:Infinity,right:-Infinity,bottom:Infinity,top:-Infinity};
  for(let i=0;i<boxes.length;i+=6)for(let c=0;c<8;c++) {
    const p=Vec3.transformMat4(Vec3(),[0,1,2].map(k=>boxes[i+k+((c>>k)&1)*3]),camera.projectionView);
    result.left=Math.min(result.left,p[0]);result.right=Math.max(result.right,p[0]);
    result.bottom=Math.min(result.bottom,p[1]);result.top=Math.max(result.top,p[1]);
  }
  return result;
}

test('exact native 414×564 1CRN impostors retain a visible full measurement plate without camera/source changes',()=>{
  assert.equal(createHash('sha256').update(readFileSync(new URL('../../fixtures/1CRN.cif',import.meta.url))).digest('hex'),native.sourceSha256);
  const source=objects(),before=structuredClone(source),camera=new Camera(native.camera.state,{...native.camera.viewport});camera.scale=native.camera.scale;camera.update();
  assert.deepEqual(camera.projection,native.camera.projection);assert.deepEqual(camera.view,native.camera.view);
  const snapshot=camera.getSnapshot(),solver=createMeasurementClearance();
  const solve=()=>solver.solve(a,b,camera,source,native.plate.halfWidth,native.plate.halfHeight,0,undefined,native.plate.offsetZ);
  const placed=solve();assert.equal(placed.valid,true,'the actual tall native canvas must positively show the number');
  const rect=plate(camera,placed.point);assert.ok(rect.left>=-1&&rect.right<=1&&rect.bottom>=-1&&rect.top<=1,JSON.stringify(rect));
  for(const object of source) {
    // Independent per-primitive bounding boxes, without spatial cell grouping.
    const v=object.values,positions=(object.type==='spheres'?v.centerBuffer:v.aStart).ref.value;
    const radius=getMaxSize(v)*v.uSizeFactor.ref.value,boxes=[];
    for(let i=0;i<positions.length;i+=object.type==='spheres'?3:18) {
      const r=radius*(object.type==='spheres'?1:Math.abs(v.aScale.ref.value[i/3]));
      for(const data of object.type==='spheres'?[positions]:[positions,v.aEnd.ref.value]) boxes.push(...data.slice(i,i+3).map(n=>n-r),...data.slice(i,i+3).map(n=>n+r));
    }
    const drawn=aggregate(camera,boxes);
    assert.ok(rect.left>drawn.right||rect.right<drawn.left||rect.bottom>drawn.top||rect.top<drawn.bottom,'numeric plate clears every actual native primitive');
  }
  assert.ok(solver.stats.refinementBuilds>0,'this capture needs the bounded refinement');
  const scans=solver.stats.refinementPoints,builds=solver.stats.refinementBuilds;
  for(let i=0;i<120;i++)solve();
  assert.equal(solver.stats.solves,1);assert.equal(solver.stats.refinementPoints,scans);assert.equal(solver.stats.refinementBuilds,builds);
  camera.state.fov+=.01;camera.update();solve();assert.equal(solver.stats.refinementPoints,scans,'projection changes reuse cached geometry cells');
  assert.deepEqual(source,before,'render geometry is read-only');camera.state.fov=snapshot.fov;camera.update();
  assert.deepEqual(camera.getSnapshot(),snapshot);assert.equal(Vec3.distance(a,b).toFixed(1),'12.6');
});

function contains(boxes,point,radius=0) {
  for(let i=0;i<boxes.length;i+=6) if([0,1,2].every(k=>point[k]-radius>=boxes[i+k]-1e-9 && point[k]+radius<=boxes[i+k+3]+1e-9))return true;
  return false;
}
test('native sphere/cylinder cells cover primitive endpoints and transformed radius, and track buffer/size/transform versions',()=>{
  for(const object of objects()) {
    const helper=createMeasurementGeometryBounds(),v=object.values;
    const transform=Mat4.fromRotation(Mat4(),.4,[0,0,1]);transform[4]+=.3;transform[12]=7;
    v.aTransform=ValueCell.create(transform);
    let boxes=helper.get(object);assert.ok(boxes&&boxes.length<=27*6);
    const radius=getMaxSize(v)*v.uSizeFactor.ref.value;
    const positions=object.type==='spheres'?v.centerBuffer.ref.value:v.aStart.ref.value;
    const stride=object.type==='spheres'?3:18;
    for(let i=0;i<positions.length;i+=stride) {
      const p=Vec3.transformMat4(Vec3(),positions.slice(i,i+3),transform);
      const r=radius*(object.type==='cylinders'?Math.abs(v.aScale.ref.value[i/3]):1);
      assert.ok(contains(boxes,p,r));
      if(object.type==='cylinders')assert.ok(contains(boxes,Vec3.transformMat4(Vec3(),v.aEnd.ref.value.slice(i,i+3),transform),r));
    }
    const scans=helper.stats.points;helper.get(object);assert.equal(helper.stats.points,scans);
    const key=object.type==='spheres'?'centerBuffer':'aStart';v[key].ref.version++;assert.equal(helper.matches(object),false);helper.get(object);
    v.uSizeFactor.ref.value*=2;assert.equal(helper.matches(object),false);helper.get(object);
    ValueCell.update(v.aTransform,Mat4.identity());assert.equal(helper.matches(object),false);helper.get(object);
    assert.equal(helper.stats.builds,4);
  }
});

test('one aggregate projected rectangle encloses triangle and cylinder interiors spanning different cells',()=>{
  const camera=new Camera({position:[0,0,0],target:[0,0,-30],up:[0,1,0],radius:20,radiusMax:100},{x:0,y:0,width:414,height:564});camera.update();
  const vertices=[[-8,-7,-40],[9,-6,-30],[3,8,-20]];
  const mesh={type:'mesh',values:Object.fromEntries(Object.entries({aPosition:vertices.flat(),aTransform:Mat4.identity(),instanceCount:1,uVertexCount:3,
    boundingSphere:{center:[0,0,-30],radius:25}}).map(([k,v])=>[k,ValueCell.create(v)]))};
  const boxes=createMeasurementGeometryBounds().get(mesh),rect=aggregate(camera,boxes);
  assert.ok(boxes.length>6,'vertices occupy separate cells');
  for(let i=0;i<=10;i++)for(let j=0;j<=10-i;j++) {
    const p=vertices[0].map((v,k)=>v*i/10+vertices[1][k]*j/10+vertices[2][k]*(1-i/10-j/10));
    const clip=Vec3.transformMat4(Vec3(),p,camera.projectionView);
    assert.ok(clip[0]>=rect.left-1e-12&&clip[0]<=rect.right+1e-12&&clip[1]>=rect.bottom-1e-12&&clip[1]<=rect.top+1e-12);
  }
  const cylinder=objects()[1];
  cylinder.values.aStart=ValueCell.create(Array(6).fill(vertices[0]).flat());cylinder.values.aEnd=ValueCell.create(Array(6).fill(vertices[2]).flat());
  cylinder.values.aScale=ValueCell.create(Array(6).fill(1));cylinder.values.uVertexCount.ref.value=6;
  cylinder.values.boundingSphere=ValueCell.create({center:[0,0,-30],radius:25});
  const capsule=aggregate(camera,createMeasurementGeometryBounds().get(cylinder)),r=getMaxSize(cylinder.values)*cylinder.values.uSizeFactor.ref.value;
  for(let i=0;i<=10;i++)for(const x of [-r,r])for(const y of [-r,r])for(const z of [-r,r]) {
    const p=vertices[0].map((v,k)=>v*(1-i/10)+vertices[2][k]*i/10+[x,y,z][k]);const clip=Vec3.transformMat4(Vec3(),p,camera.projectionView);
    assert.ok(clip[0]>=capsule.left&&clip[0]<=capsule.right&&clip[1]>=capsule.bottom&&clip[1]<=capsule.top);
  }
});

test('eye-crossing refined cells retain the coarse refusal and stationary geometry mutations invalidate used refinement',()=>{
  const camera=new Camera(native.camera.state,{...native.camera.viewport});camera.update();
  const source=objects(),solver=createMeasurementClearance(),solve=()=>solver.solve(a,b,camera,source,native.plate.halfWidth,native.plate.halfHeight,0,undefined,native.plate.offsetZ);
  assert.equal(solve().valid,true);const builds=solver.stats.refinementBuilds;
  source[0].values.centerBuffer.ref.value[0]+=.05;source[0].values.centerBuffer.ref.version++;
  solve();assert.equal(solver.stats.solves,2);assert.equal(solver.stats.refinementBuilds,builds+1);
  const crossing={type:'mesh',state:{visible:true},values:Object.fromEntries(Object.entries({
    aPosition:[-100,-100,0,100,100,100],aTransform:Mat4.identity(),instanceCount:1,uVertexCount:2,
    boundingSphere:{center:[0,0,50],radius:1000},
  }).map(([k,v])=>[k,ValueCell.create(v)]))};
  const refused=createMeasurementClearance().solve(a,b,camera,[crossing],native.plate.halfWidth,native.plate.halfHeight,0,undefined,native.plate.offsetZ);
  assert.equal(refused.valid,false);assert.ok(refused.point.every(Number.isFinite));
});

test('unsupported, animated, malformed and over-budget primitives retain coarse bounds without unbounded scans',()=>{
  for(const change of [o=>{o.type='texture-mesh';},o=>{o.values.uWiggleAmplitude.ref.value=.1;},o=>{o.values.uTumbleAmplitude.ref.value=.1;},
    o=>{o.values.uVertexCount.ref.value=(MEASUREMENT_GEOMETRY_LIMIT+1)*6;},o=>{delete o.values.aTransform;},
    o=>{o.values.aTransform.ref.value[3]=.2;}]) {
    const object=objects()[0];change(object);const helper=createMeasurementGeometryBounds();
    assert.equal(helper.get(object),undefined);assert.equal(helper.stats.points,0);
  }
  const helper=createMeasurementGeometryBounds(),object=objects()[0];
  assert.equal(helper.get(object,{remaining:1}),undefined);assert.equal(helper.stats.points,0);
  assert.equal(helper.hasSignature(),false,'an unattempted budget refusal must not invalidate stationary frames');
  assert.ok(helper.get(object,{remaining:MEASUREMENT_GEOMETRY_LIMIT}),'a later sufficient budget can build');
});

test('a stable animation refusal is rechecked when those exact primitives become eligible',()=>{
  const source=objects(),camera=new Camera(native.camera.state,{...native.camera.viewport});camera.update();
  for(const object of source)object.values.uWiggleAmplitude.ref.value=.1;
  const solver=createMeasurementClearance(),solve=()=>solver.solve(a,b,camera,source,native.plate.halfWidth,native.plate.halfHeight,0,undefined,native.plate.offsetZ);
  assert.equal(solve().valid,false);solve();assert.equal(solver.stats.solves,1,'unchanged refusal stays cached');
  for(const object of source){object.values.uWiggleAmplitude.ref.value=0;object.values.uWiggleAmplitude.ref.version++;}
  assert.equal(solve().valid,true,'removing shader motion must recover without an unrelated camera edit');
  assert.equal(solver.stats.solves,2);solve();assert.equal(solver.stats.solves,2);
});
