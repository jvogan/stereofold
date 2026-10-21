import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PluginContext } from 'molstar/lib/mol-plugin/context.js';
import { DefaultPluginSpec } from 'molstar/lib/mol-plugin/spec.js';
import { StateTransforms } from 'molstar/lib/mol-plugin-state/transforms.js';
import { setCanvasModule } from 'molstar/lib/mol-geo/geometry/text/font-atlas.js';
import { Camera } from 'molstar/lib/mol-canvas3d/camera.js';
import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { getMaxSize } from 'molstar/lib/mol-geo/geometry/size-data.js';
import { createMeasurementLines } from './measurement-lines.mjs';
import { createMeasurementClearance } from './measurement-clearance.mjs';

// Captured from the local 1CRN custom-input browser failure. CPU geometry and
// camera/projection are real Mol*; only font rasterization and GPU are stubbed.
const capturedCamera = { mode:'perspective', fov:Math.PI / 4,
  position:[10.276450220510753,9.69579378495034,53.24713672820157],
  target:[10.276450220510753,9.69579378495034,6.78114241415431], up:[0,1,0], radius:17.78176619235635, radiusMax:17.78176619235635 };
const measured = {id:'local-distance',a:{key:'A:1',authorChain:'A',position:[16.967,12.784,4.338]},
  b:{key:'A:10',authorChain:'A',position:[8.496,4.609,8.837]},color:'#f2c47c'};

// Independent projection of the actual live glyph/background quad uniforms,
// including Mol*'s perspective billboard standoff (text.vert).
function plateRect(camera, object) {
  const v=object.values, center=Vec3.transformMat4(Vec3(),v.aPosition.ref.value.subarray(0,3),v.aTransform.ref.value);
  Vec3.scale(center,center,camera.scale);
  const eye=Vec3.transformMat4(Vec3(),center,camera.view);
  const z=(v.uOffsetZ.ref.value+Math.max(...v.aDepth.ref.value)*.95)*camera.scale;
  if(camera.state.mode==='orthographic') eye[2]+=z;
  else Vec3.scaleAndAdd(eye,eye,Vec3.normalize(Vec3(),eye),-z);
  const size=getMaxSize(v)*v.uSizeFactor.ref.value*camera.scale, mapping=v.aMapping.ref.value;
  const points=[];
  for(let i=0;i<mapping.length;i+=2) points.push(Vec3.transformMat4(Vec3(),
    [eye[0]+mapping[i]*size,eye[1]+mapping[i+1]*size,eye[2]],camera.projection));
  return {left:Math.min(...points.map(p=>p[0])),right:Math.max(...points.map(p=>p[0])),
    bottom:Math.min(...points.map(p=>p[1])),top:Math.max(...points.map(p=>p[1]))};
}
function bodyRect(camera, representation) {
  const out={left:Infinity,right:-Infinity,bottom:Infinity,top:-Infinity},point=Vec3(),matrix=Mat4();
  const model=Mat4.fromUniformScaling(Mat4(),camera.scale);
  for(const object of representation.renderObjects) {
    const v=object.values,positions=v.aPosition.ref.value,transforms=v.aTransform.ref.value;
    for(let i=0;i<v.instanceCount.ref.value;i++) {
      Mat4.fromArray(matrix,transforms,i*16);Mat4.mul(matrix,model,matrix);Mat4.mul(matrix,camera.projectionView,matrix);
      for(let j=0;j<positions.length;j+=3) {
        Vec3.set(point,positions[j],positions[j+1],positions[j+2]);Vec3.transformMat4(point,point,matrix);
        out.left=Math.min(out.left,point[0]);out.right=Math.max(out.right,point[0]);
        out.bottom=Math.min(out.bottom,point[1]);out.top=Math.max(out.top,point[1]);
      }
    }
  }
  return out;
}
const separate=(a,b)=>a.left>b.right || a.right<b.left || a.bottom>b.top || a.top<b.bottom;

async function fixture(run) {
  const previous=globalThis.document;
  globalThis.document={addEventListener(){},removeEventListener(){},createElement:()=>({setAttribute(){}}),head:{appendChild(){},removeChild(){}}};
  setCanvasModule({createCanvas:()=>({getContext:()=>({
    measureText(char){return {width:parseFloat(this.font.match(/([\d.]+)px/)[1])*(char===' '?.3:.55)};},
    clearRect(){},fillText(){},getImageData:(_x,_y,w,h)=>({data:new Uint8ClampedArray(w*h*4).fill(255)}),
  })})});
  const plugin=new PluginContext(DefaultPluginSpec());
  let lines;
  try {
    await plugin.init();
    const raw=await plugin.builders.data.rawData({data:readFileSync(new URL('../../fixtures/1CRN.cif',import.meta.url),'utf8')});
    const trajectory=await plugin.build().to(raw).apply(StateTransforms.Data.ParseCif).apply(StateTransforms.Model.TrajectoryFromMmCif).commit();
    const model=await plugin.build().to(trajectory).apply(StateTransforms.Model.ModelFromTrajectory,{modelIndex:0}).commit();
    const structure=await plugin.build().to(model).apply(StateTransforms.Model.StructureFromModel,{type:{name:'model',params:{}}}).commit();
    const body=await plugin.builders.structure.representation.addRepresentation(structure,{type:'ball-and-stick',typeParams:{tryUseImpostor:false}});
    const camera=new Camera(capturedCamera,{x:0,y:0,width:784,height:324});camera.update();
    const live=new Set(),extra=[],presentation=Mat4.identity(),canvas={camera,webgl:{pixelRatio:1},xr:{isPresenting:{value:false}},
      add:r=>live.add(r),remove:r=>live.delete(r),update(){},requestDraw(){},
      getRenderObjects:()=>[...body.obj.data.repr.renderObjects,...extra,...[...live].flatMap(r=>r.renderObjects)]};
    lines=createMeasurementLines({canvas,getTransform:()=>presentation,getAnimation:()=>null});
    await lines.install([measured]);
    await run({lines,camera,canvas,live,body:body.obj.data.repr,extra,presentation});
  } finally {await lines?.install([]);plugin.dispose();globalThis.document=previous;}
}

test('real 1CRN measurement stays onscreen at the captured short desktop viewport and narrow resize',async()=>fixture(async({lines,camera,live,body})=>{
  const [distance,label]=[...live], scientific=lines.definition(), segment=[...distance.state.transform];
  for(const mode of ['perspective','orthographic']) {
    camera.state.mode=mode;camera.update();const cameraState=camera.getSnapshot();
    for(const [width,height] of [[784,324],[408,324],[408,530],[414,564],[408,280],[784,324]]) {
    camera.viewport.width=width;camera.viewport.height=height;camera.update();lines.tick();
    const rect=plateRect(camera,label.renderObjects[0]);
    assert.equal(label.state.visible,true,`${width}x${height}: this fitted molecule has room for the numeric label`);
    assert.ok(rect.left>=-1 && rect.right<=1 && rect.bottom>=-1 && rect.top<=1,`${width}x${height}: ${JSON.stringify(rect)}`);
    assert.ok(separate(rect,bodyRect(camera,body)),'the visible plate clears the projected real mesh vertices');
    assert.equal(label.getAllLoci()[0].shape.sourceData.text,'12.6 Å');
    assert.deepEqual([...distance.state.transform],segment,'measurement endpoints are unchanged');
    assert.deepEqual(lines.definition(),scientific);
    assert.deepEqual(camera.getSnapshot(),cameraState,'annotation seating cannot move the camera');
    }
  }
}));

test('desktop clearance uses committed transformed bounds and camera scale without moving scientific endpoints',async()=>fixture(async({lines,camera,live,body,presentation})=>{
  Mat4.fromRotation(presentation,.3,[0,0,1]);Mat4.scaleUniformly(presentation,presentation,1.1);
  presentation[12]=4;body.setState({transform:presentation});
  const [distance,label]=[...live],before=lines.definition();
  for(const scale of [1,.02421]) {
    camera.scale=scale;camera.update();const snapshot=camera.getSnapshot();lines.tick();
    const rect=plateRect(camera,label.renderObjects[0]);
    assert.equal(label.state.visible,true);
    assert.ok(rect.left>=-1 && rect.right<=1 && rect.bottom>=-1 && rect.top<=1);
    assert.ok(separate(rect,bodyRect(camera,body)));
    for(const [t,endpoint] of [[0,measured.a.position],[1,measured.b.position]]) {
      const expected=Vec3.transformMat4(Vec3(),endpoint,presentation),actual=Vec3.transformMat4(Vec3(),[0,0,t],distance.state.transform);
      assert.ok(Vec3.distance(actual,expected)<1e-9);
    }
    assert.deepEqual(lines.definition(),before);assert.deepEqual(camera.getSnapshot(),snapshot);
  }
}));

test('no clear desktop seat hides only the plate/leader and recovers when the obstruction leaves',async()=>fixture(async({lines,camera,live,extra})=>{
  const [distance,label,leader]=[...live],segment=[...distance.state.transform],snapshot=camera.getSnapshot(),scientific=lines.definition();
  const blocker={type:'mesh',state:{visible:true},values:{boundingSphere:{ref:{value:{center:[0,0,0],radius:100000}}}}};
  extra.push(blocker);lines.tick();
  assert.equal(label.state.visible,false);assert.equal(leader.state.visible,false);assert.equal(distance.state.visible,true);
  assert.deepEqual([...distance.state.transform],segment);assert.deepEqual(lines.definition(),scientific);assert.deepEqual(camera.getSnapshot(),snapshot);
  extra.length=0;lines.tick();
  assert.equal(label.state.visible,true);assert.equal(leader.state.visible,true);
  const rect=plateRect(camera,label.renderObjects[0]);assert.ok(rect.left>=-1&&rect.right<=1&&rect.bottom>=-1&&rect.top<=1);
  const position=[...label.state.transform];
  extra.push({type:'mesh',state:{visible:true},values:{boundingSphere:{ref:{value:{center:[0,0,200],radius:5}}}}});lines.tick();
  assert.equal(label.state.visible,true);assert.deepEqual([...label.state.transform],position,'a blocker behind the eye does not displace the recovered plate');
}));

test('desktop seats invalidate on projection, viewport, plate extent and standoff changes while stationary passes cache',()=>{
  const camera=new Camera(capturedCamera,{x:0,y:0,width:784,height:324});camera.update();
  const solver=createMeasurementClearance(),a=measured.a.position,b=measured.b.position;
  const solve=(w=2,z=3)=>solver.solve(a,b,camera,[],w,.6,0,undefined,z);
  solve();solve();assert.equal(solver.stats.solves,1);
  camera.state.fov=.9;camera.update();solve();assert.equal(solver.stats.solves,2);
  camera.viewport.width=408;camera.update();solve();assert.equal(solver.stats.solves,3);
  camera.state.mode='orthographic';camera.update();solve();assert.equal(solver.stats.solves,4);
  camera.state.position[2]+=20;camera.update();solve();assert.equal(solver.stats.solves,5);
  solve(2.01);assert.equal(solver.stats.solves,6,'full extent changes smaller than the XR cache tolerance still invalidate');
  solve(2.01,4);assert.equal(solver.stats.solves,7);solve(2.01,4);assert.equal(solver.stats.solves,7);
  assert.equal(solve(10000,4).valid,false,'an oversized plate has no seat');
  assert.equal(solve().valid,true,'a later usable plate recovers');
});

test('presenting before the first tracked stereo callback retains XR clearance, not desktop viewport limits',async()=>fixture(async({lines,camera,canvas,live,body})=>{
  const label=[...live][1],before=lines.definition(),snapshot=camera.getSnapshot();
  camera.viewport.width=16;camera.viewport.height=16;camera.update();
  canvas.xr.isPresenting.value=true;lines.tick();
  const v=label.renderObjects[0].values,mapping=v.aMapping.ref.value,size=getMaxSize(v)*v.uSizeFactor.ref.value;
  let hw=0,hh=0;for(let i=0;i<mapping.length;i+=2){hw=Math.max(hw,Math.abs(mapping[i])*size);hh=Math.max(hh,Math.abs(mapping[i+1])*size);}
  const legacyCamera={scale:camera.scale,state:camera.state,view:camera.view};
  const expected=createMeasurementClearance().solve(measured.a.position,measured.b.position,legacyCamera,body.renderObjects,hw,hh);
  assert.equal(label.state.visible,true,'the first XR frame must not be hidden by a tiny flat viewport');
  assert.ok(Vec3.distance(label.state.transform.slice(12,15),expected.point)<1e-9,'the pre-eye XR path retains its original unbounded clearance');
  assert.deepEqual(lines.definition(),before);assert.deepEqual(camera.getSnapshot(),snapshot);
  canvas.xr.isPresenting.value=false;camera.viewport.width=784;camera.viewport.height=324;camera.update();lines.tick();
  const rect=plateRect(camera,label.renderObjects[0]);assert.equal(label.state.visible,true);
  assert.ok(rect.left>=-1&&rect.right<=1&&rect.bottom>=-1&&rect.top<=1,'desktop resumes finite bounds');
}));
