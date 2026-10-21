import test from 'node:test';
import assert from 'node:assert/strict';
import { Mat4,Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { setCanvasModule } from 'molstar/lib/mol-geo/geometry/text/font-atlas.js';
import { getMaxSize } from 'molstar/lib/mol-geo/geometry/size-data.js';
import { createMeasurementLines } from './measurement-lines.mjs';
import { createMeasurementClearance } from './measurement-clearance.mjs';
import { createToolbarPanel,toolbarGlassPlates,SPATIAL_TOOLBAR_LAYOUT } from './spatial-toolbar-geometry.mjs';
import { roomToSceneMatrix } from './room-lock.mjs';

function rasterizer(){setCanvasModule({createCanvas:()=>({getContext:()=>({
  measureText(char){return {width:parseFloat(this.font.match(/([\d.]+)px/)[1])*(char===' '?.3:.55)};},
  clearRect(){},fillText(){},getImageData:(_x,_y,w,h)=>({data:new Uint8ClampedArray(w*h*4).fill(255)}),
})})});}
const line={id:'native-distance',a:{position:[-6.3,0,-80]},b:{position:[6.3,0,-80]},color:'#f2c47c'};
const views=[-.032,.032].map(x=>({view:Mat4.fromTranslation(Mat4(),[-x,0,0]),projection:Mat4.perspective(Mat4(),-.01,.01,.01,-.01,.01,20)}));
const stereo={left:views[0],right:views[1]};
const head={transform:{matrix:Mat4.identity(),position:{x:0,y:0,z:0}}};
function menuAt(x,y,z){
  const panel=createToolbarPanel({head,constants:{...SPATIAL_TOOLBAR_LAYOUT,peripheralSeat:false},
    rows:['Talk','Tour','Reset','Pg 1/6','Room on','Ribbons','Mol*','Menu'].map(label=>({label}))});
  const points=toolbarGlassPlates(panel)[0],centre=[0,1,2].map(k=>(Math.min(...points.map(p=>p[k]))+Math.max(...points.map(p=>p[k])))/2);
  return [points.map(p=>p.map((v,k)=>v-centre[k]+[x,y,z][k]))];
}
const rectangle=points=>({left:Math.min(...points.map(p=>p[0]/-p[2])),right:Math.max(...points.map(p=>p[0]/-p[2])),
  bottom:Math.min(...points.map(p=>p[1]/-p[2])),top:Math.max(...points.map(p=>p[1]/-p[2]))});
const overlap=(a,b)=>a.left<=b.right&&a.right>=b.left&&a.bottom<=b.top&&a.top>=b.bottom;
function labelRect(label,view,scale){
  const v=label.renderObjects[0].values,anchor=Vec3.transformMat4(Vec3(),v.aPosition.ref.value.subarray(0,3),v.aTransform.ref.value);
  const p=Vec3.transformMat4(Vec3(),Vec3.scale(Vec3(),anchor,scale),view);
  Vec3.scaleAndAdd(p,p,Vec3.normalize(Vec3(),p),-v.uOffsetZ.ref.value*scale);
  const size=getMaxSize(v)*v.uSizeFactor.ref.value*scale,mapping=v.aMapping.ref.value,points=[];
  for(let i=0;i<mapping.length;i+=2)points.push([p[0]+mapping[i]*size,p[1]+mapping[i+1]*size,p[2]]);
  return rectangle(points);
}
function glassRects(glass,view,scale){return glass.plates.map(plate=>rectangle(plate.map(p=>
  Vec3.transformMat4(Vec3(),Vec3.scale(Vec3(),Vec3.transformMat4(Vec3(),p,glass.roomToScene),scale),view))));}

test('real numeric plate clears production menu geometry in both eyes after menu relocation/re-entry, without changing science',async()=>{
  rasterizer();const live=new Set(),camera={scale:.02421,view:Mat4.identity(),state:{mode:'perspective'}};
  const canvas={camera,xr:{isPresenting:{value:true}},getRenderObjects:()=>[],add:r=>live.add(r),remove:r=>live.delete(r),update(){},requestDraw(){}};
  let glass={plates:[],roomToScene:roomToSceneMatrix(camera.view,camera.scale)};
  let reads=0;
  const lines=createMeasurementLines({canvas,getTransform:()=>Mat4.identity(),getAnimation:()=>null,getGlass:()=>{reads++;return glass;}});
  try{
    await lines.install([line]);lines.tick(stereo);
    const label=[...live][1],baseline=labelRect(label,views[0].view,camera.scale),versions=[...live].map(r=>r.geometryVersion);
    // Move the actual menu from the opposite side onto the previously clear
    // numeric plate, matching the re-entry failure. The old solver's seat is
    // independently proven to overlap the drawn menu before the update.
    glass.plates=menuAt(0,(baseline.bottom+baseline.top)/2*.8,.0-.8);
    assert.ok(glassRects(glass,views[0].view,camera.scale).some(r=>overlap(baseline,r)),'old menu-unaware seat visibly collides');
    lines.tick(stereo);
    const clear=()=>{assert.equal(label.state.visible,true);for(const eye of views)for(const rect of glassRects(glass,eye.view,camera.scale))
      assert.ok(!overlap(labelRect(label,eye.view,camera.scale),rect),'full mapped glyph/background at real standoff clears either eye');};
    clear();const first=[...label.state.transform];
    // New arrays with the same coordinates are a stationary frame, not a move.
    glass=structuredClone(glass);lines.tick(stereo);assert.deepEqual([...label.state.transform],first);
    const current=labelRect(label,views[0].view,camera.scale);
    glass.plates=menuAt(0,(current.bottom+current.top)/2*.8,-.8);lines.tick(stereo);clear();
    assert.notDeepEqual([...label.state.transform],first,'menu movement invalidates a stationary distance');
    glass.plates=[];lines.tick(stereo);assert.equal(label.state.visible,true,'folded menu releases its occupied space');
    const beforeReads=reads;canvas.xr.isPresenting.value=false;lines.tick();assert.equal(reads,beforeReads,'flat mode never reads room UI');
    canvas.xr.isPresenting.value=true;glass.plates=menuAt(0,.2,-.8);lines.tick(stereo);clear();
    assert.equal(label.getAllLoci()[0].shape.sourceData.text,'12.6 Å');assert.deepEqual(lines.definition(),[line]);
    assert.deepEqual([...live].map(r=>r.geometryVersion),versions,'moving menus never rebuild scientific or annotation geometry');
    assert.deepEqual(camera,{scale:.02421,view:Mat4.identity(),state:{mode:'perspective'}});
  }finally{await lines.install([]);}
});

test('room rotation/translation/scale use the production room matrix exactly once; stationary glass projections are cached',()=>{
  for(const scale of [.007,.02421,.08]){
    const cameraView=Mat4.fromRotation(Mat4(),.4,[0,1,0]);cameraView[12]=.3;cameraView[13]=-.2;cameraView[14]=.1;
    const roomToScene=roomToSceneMatrix(cameraView,scale);
    const eyes=views.map(v=>({view:Mat4.mul(Mat4(),v.view,cameraView),projection:v.projection}));
    const a=Vec3.transformMat4(Vec3(),[-.15,0,-2],roomToScene),b=Vec3.transformMat4(Vec3(),[.15,0,-2],roomToScene);
    const glass={plates:menuAt(0,.2,-.8),roomToScene},solver=createMeasurementClearance();
    const camera={scale,state:{mode:'perspective'},views:eyes};
    const placed=solver.solve(a,b,camera,[],.07/scale,.025/scale,0,undefined,.05/scale,false,glass);
    assert.equal(placed.valid,true);
    // Project independently through the room-space eye: the double scaling
    // bug would put the solver's menu hundreds of scene units from this one.
    const roomPoint=Vec3.transformMat4(Vec3(),Vec3.scale(Vec3(),placed.point,scale),cameraView);
    for(const eye of views){const p=Vec3.transformMat4(Vec3(),roomPoint,eye.view);Vec3.scaleAndAdd(p,p,Vec3.normalize(Vec3(),p),-.05);
      const label=rectangle([[p[0]-.07,p[1]-.025,p[2]],[p[0]+.07,p[1]+.025,p[2]]]);
      for(const plate of glass.plates)assert.ok(!overlap(label,rectangle(plate.map(q=>Vec3.transformMat4(Vec3(),q,eye.view)))));}
    const counts={...solver.stats};for(let i=0;i<20;i++)solver.solve(a,b,camera,[],.07/scale,.025/scale,0,undefined,.05/scale,false,structuredClone(glass));
    assert.deepEqual(solver.stats,counts,'no stationary projection or solve despite fresh provider arrays');
    glass.roomToScene[12]+=4;solver.solve(a,b,camera,[],.07/scale,.025/scale,0,undefined,.05/scale,false,glass);
    assert.equal(solver.stats.solves,counts.solves+1,'changed room transform invalidates even when molecular endpoints do not move');
  }
});

test('a menu cannot push the preferred plate beyond either lens when the opposite escape is visible',()=>{
  const solver=createMeasurementClearance(),camera={scale:.01,state:{mode:'perspective'},views},a=[-10,0,-100],b=[10,0,-100];
  const glass={plates:[[[-.4,.05,-.5],[.4,.05,-.5],[.4,2,-.5],[-.4,2,-.5]]],roomToScene:roomToSceneMatrix(Mat4.identity(),.01)};
  const withoutProjection={...camera,views:views.map(v=>({view:v.view}))};
  assert.equal(createMeasurementClearance().solve(a,b,withoutProjection,[],3,3,1,undefined,5,false,glass).side,1,'geometry-only preferred escape runs past the top of the lens');
  const placed=solver.solve(a,b,camera,[],3,3,1,undefined,5,false,glass);
  assert.equal(placed.valid,true);assert.equal(placed.side,-1,'finite opposite escape stays visible');
  const narrow={...camera,views:views.map(v=>({...v,projection:Mat4.perspective(Mat4(),-.0001,.0001,.0001,-.0001,.01,20)}))};
  assert.equal(solver.solve(a,b,narrow,[],3,3,placed.side,undefined,5,false,glass).valid,false);
  assert.equal(solver.solve(a,b,camera,[],3,3,placed.side,undefined,5,false,glass).valid,true,'projection change alone recovers a cached no-seat result');
});

test('bounded alternate rays keep a visible full numeric plate clear of molecular bounds and the side menu in both eyes',async()=>{
  rasterizer();const live=new Set(),scale=.01,camera={scale,view:Mat4.identity(),state:{mode:'perspective'}};
  const extrema=[[-55,-90,-100],[55,-90,-100],[-55,20,-100],[55,20,-100]];
  const body={type:'mesh',state:{visible:true},values:{boundingSphere:{ref:{version:0,value:{center:[0,-35,-100],radius:80,extrema}}}}};
  const canvas={camera,xr:{isPresenting:{value:true}},getRenderObjects:()=>[body],add:r=>live.add(r),remove:r=>live.delete(r),update(){},requestDraw(){}};
  const glass={plates:menuAt(0,.5,-.8),roomToScene:roomToSceneMatrix(camera.view,scale)};
  const measured={...line,a:{position:[-6.3,0,-100]},b:{position:[6.3,0,-100]}};
  const lines=createMeasurementLines({canvas,getTransform:()=>Mat4.identity(),getAnimation:()=>null,getGlass:()=>glass});
  try{
    await lines.install([measured]);lines.tick(stereo);const label=[...live][1];
    assert.equal(label.state.visible,true,'not merely a finite hidden/no-seat result');
    assert.ok(Math.abs(label.state.transform[12])>1,'the original vertical pair was blocked; an alternate direction seats the plate');
    for(const eye of views){
      const rect=labelRect(label,eye.view,scale);
      assert.ok(rect.left>-.99&&rect.right<.99&&rect.bottom>-.99&&rect.top<.99,'full actual glyph/background remains in each lens');
      for(const menu of glassRects(glass,eye.view,scale))assert.ok(!overlap(rect,menu),'menu stays clear at actual text standoff');
      const molecular=rectangle(extrema.map(p=>Vec3.transformMat4(Vec3(),Vec3.scale(Vec3(),p,scale),eye.view)));
      assert.ok(!overlap(rect,molecular),'the fallback also proves molecular separation');
    }
    assert.equal(label.getAllLoci()[0].shape.sourceData.text,'12.6 Å');assert.deepEqual(lines.definition(),[measured]);
    const versions=[...live].map(r=>r.geometryVersion),pose=[...label.state.transform];lines.tick(stereo);
    assert.deepEqual([...label.state.transform],pose);assert.deepEqual([...live].map(r=>r.geometryVersion),versions);
    const solver=createMeasurementClearance(),model={...camera,views};
    const solved=solver.solve(measured.a.position,measured.b.position,model,[body],8,3,0,undefined,5,false,glass);
    assert.equal(solved.valid,true);assert.equal(solver.stats.alternateSearches,1);
    const counts={...solver.stats};for(let i=0;i<20;i++)solver.solve(measured.a.position,measured.b.position,model,[body],8,3,0,undefined,5,false,structuredClone(glass));
    assert.deepEqual(solver.stats,counts,'stationary fallback does not search/project again');
    body.values.boundingSphere.ref.value={center:[0,0,-100],radius:500};body.values.boundingSphere.ref.version++;
    assert.equal(solver.solve(measured.a.position,measured.b.position,model,[body],8,3,0,undefined,5,false,glass).valid,false,'no fallback can bypass a fully obstructing molecule');
  }finally{await lines.install([]);}
});

test('invalid and eye-crossing menu glass hides only the plate seat and recovers when valid geometry returns',()=>{
  const solver=createMeasurementClearance(),camera={scale:.01,state:{mode:'perspective'},views},a=[-1,0,-100],b=[1,0,-100];
  const glass={plates:[[[-1,-1,-1],[1,-1,-1],[1,1,1],[-1,1,1]]],roomToScene:Mat4.identity()};
  assert.equal(solver.solve(a,b,camera,[],.1,.1,0,undefined,0,false,glass).valid,false);
  const solves=solver.stats.solves;solver.solve(a,b,camera,[],.1,.1,0,undefined,0,false,glass);assert.equal(solver.stats.solves,solves);
  glass.plates=menuAt(0,.2,-.8);glass.roomToScene[0]=NaN;
  assert.equal(solver.solve(a,b,camera,[],.1,.1,0,undefined,0,false,glass).valid,false);
  glass.roomToScene=Mat4.identity();assert.equal(solver.solve(a,b,camera,[],.1,.1,0,undefined,0,false,glass).valid,true);
  glass.plates=[];assert.equal(solver.solve(a,b,camera,[],.1,.1,0,undefined,0,false,glass).valid,true);
});
