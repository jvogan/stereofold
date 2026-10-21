import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Camera } from 'molstar/lib/mol-canvas3d/camera.js';
import { setCanvasModule } from 'molstar/lib/mol-geo/geometry/text/font-atlas.js';
import { getMaxSize } from 'molstar/lib/mol-geo/geometry/size-data.js';
import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { createMeasurementLines } from './measurement-lines.mjs';

const native=JSON.parse(readFileSync(new URL('./fixtures/measurement-native-1crn.json',import.meta.url),'utf8'));
const line={id:'native-gap',a:{position:[16.967,12.784,4.338]},b:{position:[8.496,4.609,8.837]},color:'#f2c47c'};
function rasterizer() {
  // Real Mol* text geometry and transforms; only DOM font rasterization/GPU omitted.
  setCanvasModule({createCanvas:()=>({getContext:()=>({
    measureText(char){return {width:parseFloat(this.font.match(/([\d.]+)px/)[1])*(char===' '?.3:.55)};},
    clearRect(){},fillText(){},getImageData:(_x,_y,w,h)=>({data:new Uint8ClampedArray(w*h*4).fill(255)}),
  })})});
}
function projected(canvas,label) {
  const v=label.renderObjects[0].values,c=canvas.camera,ratio=canvas.webgl.pixelRatio;
  const anchor=Vec3.transformMat4(Vec3(),v.aPosition.ref.value.subarray(0,3),v.aTransform.ref.value);
  const eye=Vec3.transformMat4(Vec3(),Vec3.scale(Vec3(),anchor,c.scale),c.view);
  const z=v.uOffsetZ.ref.value*c.scale;
  if(c.state.mode==='orthographic')eye[2]+=z;
  else Vec3.scaleAndAdd(eye,eye,Vec3.normalize(Vec3(),eye),-z);
  const gain=c.projection[5]*c.viewport.height/(2*ratio*(c.state.mode==='orthographic'?1:-eye[2]));
  const size=getMaxSize(v)*v.uSizeFactor.ref.value*c.scale;
  const ndc=Vec3.transformMat4(Vec3(),eye,c.projection),mapping=v.aMapping.ref.value;
  const xs=[],ys=[];
  for(let i=0;i<mapping.length;i+=2){
    xs.push((ndc[0]+1)*c.viewport.width/(2*ratio)+mapping[i]*size*gain);
    ys.push((ndc[1]+1)*c.viewport.height/(2*ratio)+mapping[i+1]*size*gain);
  }
  return {emPixels:.8*size*gain,left:Math.min(...xs),right:Math.max(...xs),bottom:Math.min(...ys),top:Math.max(...ys)};
}
function nativeObjects(){return native.objects.map(saved=>{
  const o=structuredClone(saved);
  if(o.expandSixVertexAttributes){for(const k of ['aStart','aEnd'])o.values[k].value=o.values[k].value.flatMap((_,i,a)=>i%3?[]:Array.from({length:6},()=>a.slice(i,i+3)).flat());o.values.aScale.value=o.values.aScale.value.flatMap(n=>Array(6).fill(n));}
  for(const [k,v]of Object.entries(o.values))o.values[k]={ref:v};return o;
});}
async function fixture(run,objects=[]){rasterizer();const live=new Set(),camera=new Camera(native.camera.state,{...native.camera.viewport});camera.update();
  const canvas={camera,webgl:{pixelRatio:1},xr:{isPresenting:{value:false}},getRenderObjects:()=>objects,add:r=>live.add(r),remove:r=>live.delete(r),update(){},requestDraw(){}};
  const lines=createMeasurementLines({canvas,getTransform:()=>Mat4.identity(),getAnimation:()=>null});
  try{await lines.install([line]);await run({canvas,lines,label:[...live][1],live});}finally{await lines.install([]);}
}

test('desktop numeric plate remains readable at real comparison Fit and resized/perspective/orthographic views',async()=>fixture(async({canvas,lines,label,live})=>{
  const versions=[...live].map(r=>r.geometryVersion),camera=canvas.camera;
  for(const [width,height,ratio,mode,distance] of [[784,324,1,'perspective',145],[414,564,1,'perspective',145],[1568,648,2,'perspective',350],[784,324,1,'orthographic',145],[414,564,1,'perspective',40]]){
    Object.assign(camera.viewport,{width,height});canvas.webgl.pixelRatio=ratio;
    camera.setState({mode,position:[10,10,7+distance],target:[10,10,7],radius:distance*.4,radiusMax:500});camera.update();lines.tick();
    assert.equal(label.state.visible,true,'valid desktop view retains the numeric plate');
    const rect=projected(canvas,label);assert.ok(Math.abs(rect.emPixels-16)<1e-5,`character height ${rect.emPixels}`);
    assert.ok(rect.left>=0&&rect.right<=width/ratio&&rect.bottom>=0&&rect.top<=height/ratio,JSON.stringify(rect));
    assert.equal(label.getAllLoci()[0].shape.sourceData.text,'12.6 Å');assert.deepEqual(lines.definition(),[line]);
  }
  assert.deepEqual([...live].map(r=>r.geometryVersion),versions,'zoom never rebuilds annotation geometry');
  const v=label.renderObjects[0].values,before=[v.uSizeFactor.ref.version,v.boundingSphere.ref.version];lines.tick();
  assert.deepEqual([v.uSizeFactor.ref.version,v.boundingSphere.ref.version],before,'stationary frames retain settled uniforms/bounds');
}));

test('readable sizing still fits the exact native tall narrow molecular bounds and preserves XR sizing across handoff',async()=>fixture(async({canvas,lines,label,live})=>{
  const beforeCamera=canvas.camera.getSnapshot(),versions=[...live].map(r=>r.geometryVersion);lines.tick();
  assert.equal(label.state.visible,true);const rect=projected(canvas,label);
  assert.ok(Math.abs(rect.emPixels-16)<1e-5);assert.ok(rect.left>=0&&rect.right<=414&&rect.bottom>=0&&rect.top<=564,JSON.stringify(rect));
  assert.deepEqual(canvas.camera.getSnapshot(),beforeCamera);
  canvas.camera.scale=.02421;canvas.xr.isPresenting.value=true;lines.tick();assert.equal(label.renderObjects[0].values.uSizeFactor.ref.value,6);
  canvas.xr.isPresenting.value=false;canvas.camera.scale=1;lines.tick();assert.ok(Math.abs(projected(canvas,label).emPixels-16)<1e-5);
  canvas.camera.scale=.02421;canvas.xr.isPresenting.value=true;lines.tick();assert.equal(label.renderObjects[0].values.uSizeFactor.ref.value,6,'same-scale XR reentry restores its own policy');
  assert.deepEqual(lines.definition(),[line]);assert.deepEqual([...live].map(r=>r.geometryVersion),versions);
},nativeObjects()));
