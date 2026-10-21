import test from 'node:test';
import assert from 'node:assert/strict';
import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { capFigureAnnotations, figureLabelObstacles, updateExteriorLabelBounds, EXTERIOR_LABEL_MAX_OFFSET_EM } from './figure-label-placement.mjs';
import { registerImmersiveAnnotation, annotationOutsideFigure, copyImmersiveAnnotation, sizeImmersiveAnnotation } from './immersive-annotations.mjs';
import { capPlateInEyes, plateCharacterDegrees, plateObstaclesInEyes, releasePlateInEyes } from './plate-eye-cap.mjs';
import { renderedLabelQuads, projectPlateQuad } from './component-label-measurement.mjs';
import { syntheticViews } from './fixtures/component-label-diagnostics.mjs';
const cell=value=>({ref:{value,version:0}}),scale=.01,views=syntheticViews();
function plate(){
 const matrix=Mat4.fromTranslation(Mat4(),[0,0,-200]);
 const values={aPosition:new Float32Array(12),aTransform:new Float32Array(matrix),matrix:new Float32Array(matrix),
  aMapping:new Float32Array([-3,-.5,3,-.5,3,.5,-3,.5]),aTexCoord:new Float32Array(8).fill(10),aDepth:new Float32Array(4),elements:new Uint32Array([0,1,2,0,2,3]),
  boundingSphere:{center:[0,0,-200],radius:1},invariantBoundingSphere:{center:[0,0,0],radius:1},
  drawCount:6,instanceCount:1,dSizeType:'uniform',uSize:1,alpha:1,uSizeFactor:4,uOffsetX:0,uOffsetY:0,uOffsetZ:0,uPlateBillboard:0};
 return {type:'text',state:{visible:true},values:Object.fromEntries(Object.entries(values).map(([key,value])=>[key,cell(value)]))};
}
function body(x,y,z,radius,matrix){
 const transform=matrix??Mat4.fromTranslation(Mat4(),[x,y,z]);
 return {type:'mesh',state:{visible:true},values:Object.fromEntries(Object.entries({
  aTransform:new Float32Array(transform),matrix:new Float32Array(transform),invariantBoundingSphere:{center:[0,0,0],radius},
  drawCount:3,instanceCount:1,alpha:1,
 }).map(([key,value])=>[key,cell(value)]))};
}
function representation(object,placement){
 return registerImmersiveAnnotation({renderObjects:[object],state:{visible:true},props:{},updated:{subscribe(){}}},{placement});
}
const rectangle=(object,view)=>{
 const result=projectPlateQuad(renderedLabelQuads(object,view,scale)[0].corners,view);
 assert.ok(result.inside>.99999,'backing remains within both lenses');
 const r=result.rect,p=view.projectionMatrix;
 return {left:(r.x-r.hw)*p[0]-p[8],right:(r.x+r.hw)*p[0]-p[8],bottom:(r.y-r.hh)*p[5]-p[9],top:(r.y+r.hh)*p[5]-p[9]};
};
const overlap=(a,b)=>a.left<b.right&&b.left<a.right&&a.bottom<b.top&&b.bottom<a.top;

test('opt-in initially clears opposite-eye obstacles and preserves molecular transforms and glyph buffers',()=>{
 const object=plate(),repr=representation(object,'outside-figure');
 const molecular=[{state:{visible:true},renderObjects:[body(-2.6,0,-40,.8),body(2.6,0,-40,.8)]}];
 const obstacles=figureLabelObstacles(molecular,views,scale);
 assert.equal(overlap(rectangle(object,views[0]),obstacles[0][0][0]),true);
 assert.equal(overlap(rectangle(object,views[1]),obstacles[0][1][0]),false);
 assert.equal(overlap(rectangle(object,views[0]),obstacles[1][0][0]),false);
 assert.equal(overlap(rectangle(object,views[1]),obstacles[1][1][0]),true);
 const buffers=['aMapping','aTransform'].map(key=>[key,object.values[key].ref.value,Array.from(object.values[key].ref.value)]);
 capFigureAnnotations({figure:{annotations:()=>[repr],molecular:()=>molecular},views,cameraScale:scale,memory:new WeakMap(),placed:[]});
 assert.equal(object.state.visible,true);
 for(let eye=0;eye<2;eye++)for(const obstacle of obstacles)for(const b of obstacle[eye])assert.equal(overlap(rectangle(object,views[eye]),b),false);
 assert.equal(object.values.uSizeFactor.ref.value,4,'clearance never shrinks readable text');
 const em=.8*object.values.uSizeFactor.ref.value;
 assert.ok(Math.abs(object.values.uOffsetX.ref.value)<=EXTERIOR_LABEL_MAX_OFFSET_EM*em);
 assert.ok(Math.abs(object.values.uOffsetY.ref.value)<=EXTERIOR_LABEL_MAX_OFFSET_EM*em);
 for(const[key,buffer,values]of buffers){assert.equal(object.values[key].ref.value,buffer);assert.deepEqual(Array.from(buffer),values);}
});

test('attached labels retain the original solver result and never read molecular geometry',()=>{
 const a=plate(),b=plate(),repr=representation(a);
 assert.equal(annotationOutsideFigure(repr),false);
 capFigureAnnotations({figure:{annotations:()=>[repr],molecular(){throw Error('unrequested molecular read');}},views,cameraScale:scale,memory:new WeakMap(),placed:[]});
 capPlateInEyes({objects:[b],views,cameraScale:scale,memory:new WeakMap(),placed:[],maxOffsetEm:2});
 for(const key of ['uOffsetX','uOffsetY','uSizeFactor'])assert.equal(a.values[key].ref.value,b.values[key].ref.value);
 const copy={renderObjects:[plate()],state:{visible:true},updated:{subscribe(){}}};copyImmersiveAnnotation(representation(plate(),'outside-figure'),copy);
 assert.equal(annotationOutsideFigure(copy),true);
});

test('rotated and scaled molecular bounds remain clear in both eyes and label culling encloses drawn corners',()=>{
 // A long metric/status label retains its authored font and full width.
 for(const size of [.5,1,1.8])for(const yaw of [-1.1,0,.8]){
  const object=plate(),repr=representation(object,'outside-figure'),memory=new WeakMap();
  for(let i=0;i<object.values.aMapping.ref.value.length;i+=2)object.values.aMapping.ref.value[i]*=4;
  const buffers=['aMapping','aTransform'].map(key=>object.values[key].ref.value);
  const matrix=Mat4.fromRotation(Mat4(),yaw,[0,1,0]);Mat4.scale(matrix,matrix,[size,size,size]);matrix[14]=-200;
  const molecular=[{state:{visible:true},renderObjects:[body(0,0,0,12,matrix)]}],obstacles=figureLabelObstacles(molecular,views,scale);
  const menu=plateObstaclesInEyes([[[-.2,-.6,-2],[.2,-.3,-2]]],views);
  capFigureAnnotations({figure:{annotations:()=>[repr],molecular:()=>molecular},views,cameraScale:scale,memory,placed:menu});
  assert.equal(object.state.visible,true);
  for(let eye=0;eye<2;eye++){
   for(const other of [...obstacles,menu[0]])for(const b of other[eye])assert.equal(overlap(rectangle(object,views[eye]),b),false);
   assert.ok(plateCharacterDegrees(object,views[eye],scale)<=2.00001);
   const sphere=object.values.boundingSphere.ref.value;
   for(const quad of renderedLabelQuads(object,views[eye],scale))for(const corner of quad.corners)
    assert.ok(Math.hypot(...corner.map((value,axis)=>value-sphere.center[axis]*scale))<=sphere.radius*scale+1e-7,'live culling bound encloses relocated backing');
  }
  const radius=object.values.boundingSphere.ref.value.radius;updateExteriorLabelBounds(repr);
  assert.equal(object.values.boundingSphere.ref.value.radius,radius,'bounds never accumulate across frames');
  for(let index=0;index<buffers.length;index++)assert.equal(object.values[['aMapping','aTransform'][index]].ref.value,buffers[index]);
 }
});

test('an oversized or eye-crossing molecular silhouette falls back to the readable attached policy',()=>{
 for(const molecularBody of [body(0,0,-200,90),body(0,0,-1,4)]){
  const object=plate(),attached=plate(),repr=representation(object,'outside-figure');
  const molecular=[{state:{visible:true},renderObjects:[molecularBody]}];
  const obstacles=figureLabelObstacles(molecular,views,scale);
  const exteriorOnly=plate();
  assert.equal(capPlateInEyes({objects:[exteriorOnly],views,cameraScale:scale,memory:new WeakMap(),placed:[],maxOffsetEm:12,obstacles}).clipped,true);
  capFigureAnnotations({figure:{annotations:()=>[repr],molecular:()=>molecular},views,cameraScale:scale,memory:new WeakMap(),placed:[]});
  capPlateInEyes({objects:[attached],views,cameraScale:scale,memory:new WeakMap(),placed:[],maxOffsetEm:2});
  assert.equal(object.state.visible,true,'retain name/metric when exterior clearance cannot fit');
  for(const view of views){
   const actual=rectangle(object,view),expected=rectangle(attached,view);
   for(const edge of ['left','right','top','bottom'])assert.ok(Math.abs(actual[edge]-expected[edge])<1e-6);
  }
 }
});

test('the attached fallback still hides labels that cannot clear both-eye UI or the eye plane',()=>{
 for(const unsafe of ['UI','eye']){
 const object=plate(),repr=representation(object,'outside-figure');
  if(unsafe==='eye')object.values.aTransform.ref.value[14]=-1;
  const placed=unsafe==='UI'?views.map(()=>[{left:-1,right:1,bottom:-1,top:1}]):undefined;
  capFigureAnnotations({figure:{annotations:()=>[repr],molecular:()=>[{state:{visible:true},renderObjects:[body(0,0,-1,4)]}]},views,cameraScale:scale,memory:new WeakMap(),placed:placed?[placed]:[]});
  assert.equal(object.state.visible,false,'fallback retains binocular clipping/UI safety');
 }
});

test('molecular bounds wholly behind the eyes do not hide a clear front label',()=>{
 for(const front of [[],[body(0,0,-200,12)]]){
  const object=plate(),repr=representation(object,'outside-figure');
  const molecular=[{state:{visible:true},renderObjects:[...front,body(0,0,200,12)]}];
  const obstacles=figureLabelObstacles(molecular,views,scale);
  assert.deepEqual(obstacles.at(-1),[[],[]],'entirely behind is distinct from an eye-plane crossing');
  capFigureAnnotations({figure:{annotations:()=>[repr],molecular:()=>molecular},views,cameraScale:scale,memory:new WeakMap(),placed:[]});
  assert.equal(object.state.visible,true);
  for(let eye=0;eye<2;eye++)for(const obstacle of obstacles)for(const b of obstacle[eye])
   assert.equal(overlap(rectangle(object,views[eye]),b),false);
 }
});

test('the real figure renderer updates metadata on a placement-only edit without changing label anchors',async()=>{
 const {motionFixture}=await import('./motion-benchmark-fixture.mjs');
 const {createLessonFigure}=await import('./lesson-figure.mjs');
 let coordinateFrame;
 const h=await motionFixture({animation:null,createFigure:options=>createLessonFigure({...options,getCoordinateFrame:()=>coordinateFrame})});
 try{
  const label={id:'name',target:{chain:'H0'},text:'Binder 01 · Adaptyv KD 112 nM',color:'#17343e',offsetX:0,offsetY:25,maxOffsetEm:5,sizeFactor:1.7};
  await h.figure.install({layers:[],labels:[label],distances:[]});
  const rawSource=h.figure.annotationSourceIdentity();
  coordinateFrame='gallery-aligned-v1';const shared=h.figure.annotationSourceIdentity();
  assert.notEqual(shared,rawSource);
  coordinateFrame='another-frame';assert.notEqual(h.figure.annotationSourceIdentity(),shared);
  coordinateFrame='gallery-aligned-v1';assert.equal(h.figure.annotationSourceIdentity(),shared);
  coordinateFrame=undefined;assert.equal(h.figure.annotationSourceIdentity(),rawSource);
  let repr=h.figure.annotations()[0];assert.equal(annotationOutsideFigure(repr),false);
  const positions=Array.from(repr.renderObjects[0].values.aPosition.ref.value);
  await h.figure.install({layers:[],labels:[{...label,placement:'outside-figure'}],distances:[]});
  repr=h.figure.annotations()[0];assert.equal(annotationOutsideFigure(repr),true);
  assert.deepEqual(Array.from(repr.renderObjects[0].values.aPosition.ref.value),positions);
  h.presentation[14]=-250;repr.setState({transform:h.presentation});
  const memory=new WeakMap(),cameraScale=h.canvas.camera.scale;
  sizeImmersiveAnnotation(repr,h.canvas,[0,0,0]);
  capFigureAnnotations({figure:h.figure,views,cameraScale,memory,placed:[]});
  const object=repr.renderObjects[0],fixed=Array.from(object.values.aPosition.ref.value);
  assert.ok(memory.get(object)?.figureAnchor,'real render-ready figure receives one derived anchor');
  for(const eye of [[100,0,0],[-100,100,0],[0,-100,0]]){
   sizeImmersiveAnnotation(repr,h.canvas,eye);
   capFigureAnnotations({figure:h.figure,views:headViews(.2,.15),cameraScale,memory,placed:[]});
   assert.deepEqual(Array.from(object.values.aPosition.ref.value),fixed,'real faceAnchor must not re-pick after head turn');
  }
  releasePlateInEyes(object,memory);
  assert.deepEqual(Array.from(object.values.aPosition.ref.value),positions);
  await h.figure.install({layers:[],labels:[{...label,placement:'attached'}],distances:[]});
  assert.equal(annotationOutsideFigure(h.figure.annotations()[0]),false);
 }finally{await h.dispose();}
});

function headViews(yaw,pitch,x=0,z=0){
 const head=Mat4.fromRotation(Mat4(),yaw,[0,1,0]);
 Mat4.rotate(head,head,pitch,[1,0,0]);head[12]=x;head[14]=z;
 return syntheticViews().map(view=>{
  const eye=Mat4.mul(Mat4(),head,view.transform.matrix);
  return {...view,transform:{matrix:eye,inverse:{matrix:Mat4.invert(Mat4(),eye)}}};
 });
}

test('moving real eye poses never relocate a placed molecule anchor or switch exterior/fallback seats',()=>{
 for(const radius of [12,90]){
  const object=plate(),repr=representation(object,'outside-figure'),memory=new WeakMap();
  const molecular=[{state:{visible:true},renderObjects:[body(0,0,-200,radius)]}];
  let uploads=0;
  const figure={annotations:()=>[repr],molecular:()=>molecular,notifyAnnotationMoved(){uploads++;}};
  const original=Array.from(object.values.aPosition.ref.value);
  // Wait for the first render-ready tracked draw, then place exactly once.
  capFigureAnnotations({figure,views:[],cameraScale:scale,memory,placed:[]});
  assert.deepEqual(Array.from(object.values.aPosition.ref.value),original);
  capFigureAnnotations({figure,views,cameraScale:scale,memory,placed:[]});
  const fixed=Array.from(object.values.aPosition.ref.value),version=object.values.aPosition.ref.version;
  assert.equal(uploads,1,'initial source-anchor change uploads exactly once');
  for(let frame=0;frame<120;frame++){
   const phase=2*Math.PI*frame/119;
   const moving=headViews(.65*Math.sin(phase),.4*Math.sin(phase*2),.12*Math.sin(phase),.25*Math.cos(phase));
   // A source update restores authored eye offsets each frame in production.
   for(const name of ['uOffsetX','uOffsetY','uOffsetZ'])object.values[name].ref.value=25;
   capFigureAnnotations({figure,views:moving,cameraScale:scale,memory,placed:[]});
   assert.deepEqual(Array.from(object.values.aPosition.ref.value),fixed,'head motion cannot rewrite anchor');
   assert.equal(object.values.aPosition.ref.version,version,'no per-head-frame anchor uploads');
   assert.equal(object.state.visible,true,'look-away uses normal projection rather than solver hiding');
   for(const name of ['uOffsetX','uOffsetY','uOffsetZ'])assert.equal(object.values[name].ref.value,0);
  }
  // An intentional molecular pose carries the source-relative anchor normally.
  const transform=object.values.aTransform.ref.value;
  const before=Vec3.transformMat4(Vec3(),fixed,transform);transform[12]+=.4;
  capFigureAnnotations({figure,views:headViews(.2,.1),cameraScale:scale,memory,placed:[]});
  const after=Vec3.transformMat4(Vec3(),object.values.aPosition.ref.value,transform);
  assert.ok(Math.abs(after[0]-before[0]-.4)<1e-5);
  assert.deepEqual(Array.from(object.values.aPosition.ref.value),fixed);
  assert.equal(uploads,1,'head and molecule pose changes do not upload the anchor again');
  releasePlateInEyes(object,memory);
  assert.deepEqual(Array.from(object.values.aPosition.ref.value),original,'desktop receives original authored label anchor');
  assert.equal(uploads,2,'desktop restoration uploads the original anchor');
 }
});

test('chapter replacement reuses its authored role offset across gaze and metric changes, with source isolation',()=>{
 let source={},current,object;
 const figure={annotations:()=>[current],annotationSourceIdentity:()=>source,
  molecular:()=>[{state:{visible:true},renderObjects:[body(0,0,-200,12)]}]};
 const memory=new WeakMap();
 const install=(at,key='binder-label')=>{
  object=plate();for(let i=0;i<object.values.aPosition.ref.value.length;i+=3)
   for(let axis=0;axis<3;axis++)object.values.aPosition.ref.value[i+axis]=at[axis];
  current=registerImmersiveAnnotation({renderObjects:[object],state:{visible:true},props:{},updated:{subscribe(){}}},
   {placement:'outside-figure',anchorKey:key});
 };
 install([0,0,0]);capFigureAnnotations({figure,views,cameraScale:scale,memory,placed:[]});
 const first=Array.from(object.values.aPosition.ref.value.slice(0,3));
 assert.ok(Math.hypot(...first)>0,'first role has a derived exterior offset');
 for(const at of [[10,5,-2],[-6,-4,3]]){
  install(at);
  // New chapter can change both text width and molecular pose, while wearer
  // looks away. Neither produces a new role offset chosen from current gaze.
  for(let i=0;i<object.values.aMapping.ref.value.length;i+=2)object.values.aMapping.ref.value[i]*=2;
  capFigureAnnotations({figure,views:headViews(.7,-.35,.1),cameraScale:scale,memory,placed:[]});
  const placed=object.values.aPosition.ref.value;
  for(let axis=0;axis<3;axis++)assert.ok(Math.abs(placed[axis]-at[axis]-first[axis])<1e-6);
  releasePlateInEyes(object,memory);
  assert.deepEqual(Array.from(object.values.aPosition.ref.value.slice(0,3)),at);
 }
 // A genuinely different source gets a fresh first placement for that role.
 source={};install([0,0,0]);
 figure.molecular=()=>[{state:{visible:true},renderObjects:[body(0,0,-200,90)]}];
 capFigureAnnotations({figure,views,cameraScale:scale,memory,placed:[]});
 const fresh=Array.from(object.values.aPosition.ref.value.slice(0,3));
 assert.notDeepEqual(fresh,first,'source identity change clears the prior offset contract');
});

test('an explicit shared coordinate frame carries role offsets across raw-source boundaries and different head poses',async()=>{
 const {createLessonFigure}=await import('./lesson-figure.mjs');
 let frame='gallery-aligned-v1',source={},object,repr;
 const registry=createLessonFigure({plugin:{},getStructure:()=>undefined,getTransform:()=>Mat4(),getCoordinateFrame:()=>frame});
 const figure={annotations:()=>[repr],annotationSourceIdentity:()=>frame?registry.annotationSourceIdentity():source,
  molecular:()=>[{state:{visible:true},renderObjects:[body(0,0,-200,12)]}]};
 const memory=new WeakMap();
 const install=at=>{
  object=plate();for(let i=0;i<object.values.aPosition.ref.value.length;i+=3)
   for(let axis=0;axis<3;axis++)object.values.aPosition.ref.value[i+axis]=at[axis];
  repr=registerImmersiveAnnotation({renderObjects:[object],state:{visible:true},props:{},updated:{subscribe(){}}},
   {placement:'outside-figure',anchorKey:'binder-label'});
 };
 install([0,0,0]);capFigureAnnotations({figure,views,cameraScale:scale,memory,placed:[]});
 const offset=Array.from(object.values.aPosition.ref.value.slice(0,3));
 for(const at of [[4,5,-2],[-8,2,1]]){
  source={};install(at);
  capFigureAnnotations({figure,views:headViews(-.6,.55,.1),cameraScale:scale,memory,placed:[]});
  for(let axis=0;axis<3;axis++)assert.ok(Math.abs(object.values.aPosition.ref.value[axis]-at[axis]-offset[axis])<1e-6);
 }
 // An unrelated frame, or a source with no frame declaration, must not share.
 figure.molecular=()=>[{state:{visible:true},renderObjects:[body(0,0,-200,90)]}];
 for(const next of ['unrelated-frame',undefined]){
  frame=next;source={};install([0,0,0]);
  capFigureAnnotations({figure,views,cameraScale:scale,memory,placed:[]});
  assert.notDeepEqual(Array.from(object.values.aPosition.ref.value.slice(0,3)),offset);
 }
});
