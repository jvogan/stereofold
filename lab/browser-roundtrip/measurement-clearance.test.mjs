import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { BoundaryHelper } from 'molstar/lib/mol-math/geometry/boundary-helper.js';
import { measurementClearance } from './measurement-clearance.mjs';
import { measurementPosition } from './measurement-math.mjs';
import { coordinates } from './fixtures/kinesin-layout.mjs';
import { demoSeats, prepareLabelScene, labelFrame, sampleTimes } from './fixtures/motion-label-layout.mjs';
import { drawnPlateRects, platesOverlap } from './label-layout.mjs';
import { immersivePlateOffset, immersivePlateStandoff, facingAnchorIndex } from './immersive-annotations.mjs';
import { poseMatrix } from './molecular-animation.mjs';
const object=(center,radius,visible=true)=>({type:'mesh',state:{visible},values:{boundingSphere:{ref:{value:{center,radius}}}}});

test('perpendicular escape chooses the empty side and handles end-on/coincident lines',()=>{
  const camera={scale:1,view:Mat4.identity()};
  for(const [a,b] of [[[-20,0,0],[20,0,0]],[[0,0,-10],[0,0,10]],[[0,0,0],[0,0,0]]]) {
    const p=measurementClearance(a,b,camera,[object([0,15,0],20),object([0,-100,0],500,false)],8,3);
    assert.ok(p.point[1]<0,'prefer less occupied side, ignoring hidden bodies');
    assert.ok(Vec3.distance(p.point,p.midpoint)>=12);
    assert.ok(p.point.every(Number.isFinite));
  }
});
test('clearance rotates with the view and respects presentation scale',()=>{
  const a=[-20,0,0],b=[20,0,0],body=object([0,0,0],24);
  for(const angle of [0,.6,Math.PI/2]) {
    const view=Mat4.fromRotation(Mat4(),angle,[0,1,0]);
    const p=measurementClearance(a,b,{view,scale:.02421},[body],12,4);
    assert.ok(Math.abs(Vec3.dot(Vec3.sub(Vec3(),p.point,p.midpoint),Vec3.sub(Vec3(),b,a)))<1e-8);
    assert.ok(Math.abs(p.point[1])>28);
  }
});
const cache=process.env.STEREOFOLD_DEMO_CACHE;
test('K1T:82–K2T:82 live plate clears posed heads, junction, linkers, track and lesson names through the walk in both eyes',{skip:!cache},()=>{
  const lesson=JSON.parse(readFileSync(new URL('../../plugin/demos/kinesin-walk/motion.json',import.meta.url)));
  const seat=demoSeats['kinesin-walk'],atoms=coordinates(`${cache}/${seat.file}`,lesson.provenance.sourceSha256),chapter=lesson.chapters[0];
  const scene=prepareLabelScene(chapter,atoms);
  const endpoints=['K1T','K2T'].map(chain=>({authorChain:chain,position:atoms.find(a=>a.chain===chain&&a.residue===82&&a.atom==='CA').position}));
  const spheres=[...scene.chains].map(([chain,points])=>{const h=new BoundaryHelper('98');for(const p of points)h.includePosition(p);h.finishedIncludeStep();for(const p of points)h.radiusPosition(p);return {chain,...h.getSphere()};});
  let maxOffset=0,minOffset=Infinity;
  for(const placement of [1,seat.placement]) {
    const metres=seat.scale*placement,gain=.02421/metres;
    let side=0;const solver=createMeasurementClearance();
    for(const t of sampleTimes(chapter)) {
      const poses=chapter.animation;
      const objects=spheres.map(s=>{const track=poses.tracks.find(p=>p.chains.includes(s.chain));
        const visible=track?evaluateTrack(track,t).visible:true;
        const o=object(measurementPosition({authorChain:s.chain,position:s.center},poses,t),s.radius+2,visible);
        o.values.boundingSphere.ref.value.extrema=s.extrema?.map(position=>measurementPosition({authorChain:s.chain,position},poses,t));return o;});
      for(const l of scene.labels) {
        const track=poses.tracks.find(p=>p.chains.includes(l.chain));
        if(track && !evaluateTrack(track,t).visible) continue;
        // The label-engine merge moved wide labels to facing surface atoms
        // and capped their offsets and stand-off. Feed those actual drawn
        // bounds to clearance; the old centroid/uncapped model blocked empty
        // space and missed the plate tested by labelFrame below.
        let position=l.center;
        if(l.anchors) {
          const inverse=track?Mat4.invert(Mat4(),poseMatrix(evaluateTrack(track,t))):Mat4.identity();
          const direction=Vec3.sub(Vec3(),Vec3.transformMat4(Vec3(),[0,45,6.5/metres],inverse),l.anchors.center);
          const index=facingAnchorIndex(l.anchors,Vec3.normalize(direction,direction))*3;
          position=Array.from(l.anchors.points.subarray(index,index+3));
        }
        const anchor=measurementPosition({authorChain:l.chain,position},poses,t);
        const plate=object(anchor,1);plate.type='text';plate.state.stereofoldLessonLabel=true;
        const v=plate.values, width=l.text.length*.55*.8/2+.2;
        v.aPosition=ValueCell.create(new Float32Array(anchor));v.aTransform=ValueCell.create(Mat4.identity());
        v.aMapping=ValueCell.create(new Float32Array([-width,-.6,width,.6]));
        const size=6*l.sizeFactor*gain,em=.8*size;
        for(const [key,value] of Object.entries({uSizeFactor:size,
          uOffsetX:immersivePlateOffset(l.offsetX,gain,em),uOffsetY:immersivePlateOffset(l.offsetY,gain,em),
          uOffsetZ:immersivePlateStandoff(l.radius,1,gain)})) v[key]=ValueCell.create(value);
        objects.push(plate);
      }
      const [a,b]=endpoints.map(e=>measurementPosition(e,poses,t));
      const text=`${Vec3.distance(a,b).toFixed(1)} Å`,hw=(text.length*.55*.8/2+.2)*6*gain,hh=3.6*gain;
      const p=solver.solve(a,b,{scale:metres,state:{mode:'perspective'},views:[-.032,.032].map(eye=>({view:Mat4.lookAt(Mat4(),[eye,45*metres,6.5],[eye,45*metres,0],[0,1,0])}))},objects,hw,hh,side);side=p.side;
      minOffset=Math.min(minOffset,p.offset);maxOffset=Math.max(maxOffset,p.offset);
      for(const eye of [-.032,.032]) {
        const label=drawnPlateRects({plates:[{id:'distance',text,anchor:p.point}],placements:[{id:'distance'}],
          eye:[eye/metres,45,6.5/metres],target:[eye/metres,45,0],up:[0,1,0],characterUnits:.8*6*gain,backgroundMargin:.25,maxWidthEm:Infinity,standoff:3*gain})[0];
        const frame=labelFrame(scene,seat,t,placement,eye);
        for(const body of [...frame.bodies,...frame.labels]) assert.ok(!platesOverlap(label,body),`distance covers ${body.id} at ${t}`);
      }
    }
  }
  console.log(`Kinesin measurement clearance ${minOffset.toFixed(1)}–${maxOffset.toFixed(1)} Å`);
});
import { evaluateTrack } from '../../packages/motion/src/keyframes.mjs';

test('one shared plate avoids a near blocker visible only along the right-eye ray',()=>{
  const scale=.001, left={view:Mat4.fromTranslation(Mat4(),[.032,0,0])},
    right={view:Mat4.fromTranslation(Mat4(),[-.032,0,0])};
  const a=[-10,0,-1000],b=[10,0,-1000],objects=[object([28.8,2,-100],1)];
  const camera={scale,state:{mode:'perspective'}};
  const first=measurementClearance(a,b,{...camera,views:[left]},objects,2,2);
  const both=measurementClearance(a,b,{...camera,views:[left,right]},objects,2,2);
  assert.equal(first.side,1,'left eye alone misses the near right-eye blocker');
  assert.equal(both.side,-1,'union of eye constraints chooses the clear side for both');
  assert.equal(both.offset,12,'parent camera scale converts millimetres correctly');
});

import { createMeasurementClearance } from './measurement-clearance.mjs';
import { ValueCell } from 'molstar/lib/mol-util/value-cell.js';

test('lesson name plate blocks the distance in either eye; hidden text and owned overlays do not',()=>{
  const plate=object([0,12,-100],1);plate.type='text';plate.state.stereofoldLessonLabel=true;
  const v=plate.values;
  v.aPosition=ValueCell.create(new Float32Array([0,12,-100]));
  v.aTransform=ValueCell.create(Mat4.identity());v.instanceCount=ValueCell.create(1);
  v.aMapping=ValueCell.create(new Float32Array([-9,-3,9,3]));
  for(const [key,value] of Object.entries({uSizeFactor:1,uOffsetX:0,uOffsetY:0,uOffsetZ:0})) v[key]=ValueCell.create(value);
  const camera={scale:1,view:Mat4.identity()},a=[-20,0,-100],b=[20,0,-100];
  const solver=createMeasurementClearance();
  assert.equal(solver.solve(a,b,camera,[plate],8,3).side,-1);
  assert.equal(solver.solve(a,b,camera,[plate],8,3).side,-1);
  assert.equal(solver.stats.solves,1,'stationary frame reuses the seat');
  // A plate moving into the retained side must force a fresh solve even with
  // stationary endpoints. Preserve the side, pushing the seat past the plate.
  v.uOffsetY.ref.value=-24;
  const moved=solver.solve(a,b,camera,[plate],8,3);
  assert.equal(moved.side,-1);assert.ok(moved.offset>18);
  assert.equal(solver.stats.solves,2);
  assert.equal(createMeasurementClearance().solve(a,b,camera,[plate],8,3,0,new WeakSet([plate])).offset,12);
  plate.state.visible=false;
  assert.equal(measurementClearance(a,b,camera,[plate],8,3).side,1);
});

test('cached stereo clearance stays below 0.5 ms with 120 render blockers and moving endpoints',()=>{
  const objects=Array.from({length:120},(_,i)=>{
    const o=object([(i%12)*8-44,Math.floor(i/12)*6-25,-100],3);
    o.values.boundingSphere.ref.version=0;
    o.values.boundingSphere.ref.value.extrema=Array.from({length:98},(_,j)=>[
      o.values.boundingSphere.ref.value.center[0]+3*Math.cos(j),
      o.values.boundingSphere.ref.value.center[1]+3*Math.sin(j),-100]);return o;
  });
  const camera={scale:.01,state:{mode:'perspective'},views:[
    {view:Mat4.fromTranslation(Mat4(),[.032,0,0])},{view:Mat4.fromTranslation(Mat4(),[-.032,0,0])}]};
  const a=[-20,0,-100],b=[20,0,-100],solver=createMeasurementClearance(),times=[];
  for(let i=0;i<2500;i++) {
    a[1]=Math.sin(i/72)*10;b[1]=-a[1];
    // One animated body among static scene objects, updated in-place by Mol*.
    const cell=objects[0].values.boundingSphere;cell.ref.value.center[0]=a[1];cell.ref.version++;
    const start=performance.now();solver.solve(a,b,camera,objects,8,3);
    if(i>=500) times.push(performance.now()-start);
  }
  times.sort((a,b)=>a-b);const p95=times[Math.floor(times.length*.95)];
  console.log(`Stereo measurement clearance p95 ${p95.toFixed(3)} ms; ${solver.stats.solves}/2500 solves, ${solver.stats.boxUpdates} box updates`);
  assert.ok(p95<.5,`clearance p95 ${p95} ms exceeds 0.5 ms`);
  assert.ok(solver.stats.solves<2000,'sub-threshold motion reuses the seat');
  assert.ok(solver.stats.boxUpdates<solver.stats.solves+120,'unchanged boxes are reused across eyes and solves');
});

test('sub-threshold motion is cached; endpoint order reversal does not flip the seat',()=>{
  const solver=createMeasurementClearance(),camera={scale:1,view:Mat4.identity()},a=[-20,0,-100],b=[20,0,-100];
  const first=solver.solve(a,b,camera,[],8,3),point=[...first.point];
  a[0]+=.1;solver.solve(a,b,camera,[],8,3);
  assert.equal(solver.stats.solves,1);assert.deepEqual(first.point,point);
  const reversed=solver.solve(b,a,camera,[],8,3);
  assert.equal(solver.stats.solves,2);assert.ok(reversed.point[1]>0,'same physical side after the head order swaps');
  camera.view[12]+=.001;solver.solve(b,a,camera,[],8,3);
  assert.equal(solver.stats.solves,3,'eye travel invalidates the seat');
});


test('a near-eye blocker invalidates the retained side and chooses a finite opposite escape', () => {
  const solver = createMeasurementClearance();
  const camera = { scale: 1, state: { mode: 'perspective' }, views: [-.13,-.15].map(angle =>
    ({ view: Mat4.fromRotation(Mat4(),angle,[1,0,0]) })) };
  const a = [-20,0,-100], b = [20,0,-100];
  assert.equal(solver.solve(a,b,camera,[],8,3).side,1);
  const placed = solver.solve(a,b,camera,[object([-7.4,9.6,-1],11.2)],8,3);
  assert.equal(placed.side,-1);
  assert.equal(placed.valid,true);
  assert.ok(Number.isFinite(placed.offset));
  assert.ok(placed.point.every(Number.isFinite));
});


test('an unrepresentable escape is invalid and returns finite scratch coordinates', () => {
  const placed = measurementClearance([-20,0,-100],[20,0,-100],{scale:.001,view:Mat4.identity()},
    [object([0,0,-100],20)],Number.MAX_VALUE,Number.MAX_VALUE,1);
  assert.equal(placed.valid,false);
  assert.equal(placed.side,0);
  assert.ok(Number.isFinite(placed.offset));
  assert.ok(placed.point.every(Number.isFinite));
});
