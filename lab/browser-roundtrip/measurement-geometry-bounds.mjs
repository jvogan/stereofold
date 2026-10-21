import { Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { getMaxSize } from 'molstar/lib/mol-geo/geometry/size-data.js';

const fields=['aPosition','centerBuffer','aStart','aEnd','aScale','aTransform','tSize','uSize','uSizeFactor','dSizeType',
  'instanceCount','uVertexCount','drawCount','boundingSphere','uWiggleAmplitude','uTumbleAmplitude','dWiggle','lodLevels'];
export const MEASUREMENT_GEOMETRY_LIMIT=300000;

/** A bounded, lazily built refinement for a desktop seat that coarse bounds
 * refused. Twenty-seven cells cover vertices and impostor endpoint balls.
 * The caller uses ONE aggregate projected rectangle, not the union of cells:
 * with every cell in front of the eye, that rectangle also encloses the
 * projected convex interiors of triangles and cylinder capsules between them.
 * stationary frames inspect only ValueCell versions, never vertex arrays.
 * Unsupported, animated or over-budget geometry retains its coarse bound.
 */
export function createMeasurementGeometryBounds() {
  const versions=[],values=[],boxes=new Float64Array(27*6),point=Vec3();
  let initialized=false,type,count=0,available=false;
  const stats={builds:0,points:0};
  function matches(object) {
    if(!initialized || object.type!==type) return false;
    for(let i=0;i<fields.length;i++) {
      const ref=object.values?.[fields[i]]?.ref;
      if(ref?.version!==versions[i] || ref?.value!==values[i]) return false;
    }
    return true;
  }
  function get(object,budget) {
    if(matches(object)) return available?boxes.subarray(0,count*6):undefined;
    type=object.type;initialized=true;available=false;count=0;
    const v=object.values;
    for(let i=0;i<fields.length;i++) {const ref=v?.[fields[i]]?.ref;versions[i]=ref?.version;values[i]=ref?.value;}
    if(!v) return;
    if(!['mesh','spheres','cylinders'].includes(type) || v.dWiggle?.ref.value
      || v.uWiggleAmplitude?.ref.value || v.uTumbleAmplitude?.ref.value || v.lodLevels?.ref.value?.length) return;
    const transforms=v.aTransform?.ref.value,instances=v.instanceCount?.ref.value,vertices=v.uVertexCount?.ref.value;
    const positions=(type==='mesh'?v.aPosition:type==='spheres'?v.centerBuffer:v.aStart)?.ref.value;
    const ends=v.aEnd?.ref.value,scales=v.aScale?.ref.value;
    const primitiveCount=type==='mesh'?vertices:vertices/6;
    const work=primitiveCount*instances*(type==='cylinders'?2:1);
    if(!Number.isInteger(instances) || instances<1 || !Number.isInteger(primitiveCount) || primitiveCount<1
      || !Number.isFinite(work) || work>MEASUREMENT_GEOMETRY_LIMIT || !positions || !transforms || transforms.length<instances*16
      || positions.length<primitiveCount*(type==='cylinders'?18:3)
      || (type==='cylinders' && (!ends || !scales || ends.length<primitiveCount*18 || scales.length<primitiveCount*6))) return;
    // Theme lookup is itself bounded; an oversized texture cannot hide work
    // behind a tiny primitive count. Radius is a conservative maximum.
    if(type!=='mesh' && (!v.dSizeType || (v.tSize?.ref.value.array?.length ?? 0)>MEASUREMENT_GEOMETRY_LIMIT*3)) return;
    const themeWork=type!=='mesh' && v.dSizeType.ref.value!=='uniform'?(v.tSize?.ref.value.array?.length ?? Infinity)/3:0;
    const cost=work+themeWork;
    if(!Number.isFinite(cost) || cost>MEASUREMENT_GEOMETRY_LIMIT) return;
    if(budget && cost>budget.remaining) {initialized=false;return;}
    if(budget) budget.remaining-=cost;
    const radius=type==='mesh'?0:getMaxSize(v)*v.uSizeFactor?.ref.value;
    const sphere=v.boundingSphere?.ref.value;
    if(!Number.isFinite(radius) || radius<0 || !sphere || !(sphere.radius>0) || !sphere.center?.every(Number.isFinite)) return;
    for(let i=0;i<27;i++) {boxes.fill(Infinity,i*6,i*6+3);boxes.fill(-Infinity,i*6+3,i*6+6);}
    const step=2*sphere.radius/3;
    function include(offset,source,padding,instance) {
      Vec3.set(point,source[offset],source[offset+1],source[offset+2]);
      Vec3.transformMat4Offset(point,point,transforms,0,0,instance*16);
      if(!point.every(Number.isFinite) || !Number.isFinite(padding)) return false;
      const ix=Math.max(0,Math.min(2,Math.floor((point[0]-sphere.center[0]+sphere.radius)/step)));
      const iy=Math.max(0,Math.min(2,Math.floor((point[1]-sphere.center[1]+sphere.radius)/step)));
      const iz=Math.max(0,Math.min(2,Math.floor((point[2]-sphere.center[2]+sphere.radius)/step)));
      const cell=(ix+iy*3+iz*9)*6;
      for(let k=0;k<3;k++) {boxes[cell+k]=Math.min(boxes[cell+k],point[k]-padding);boxes[cell+k+3]=Math.max(boxes[cell+k+3],point[k]+padding);}
      stats.points++;return true;
    }
    stats.builds++;
    for(let instance=0;instance<instances;instance++) {
      const offset=instance*16;
      // A Frobenius bound covers nonuniform/sheared transforms as well as the
      // shader's unscaled impostor radius. Affine matrices only.
      if(transforms[offset+3]!==0 || transforms[offset+7]!==0 || transforms[offset+11]!==0 || transforms[offset+15]!==1) return;
      let frobenius=0;for(const k of [0,1,2,4,5,6,8,9,10]) frobenius+=transforms[offset+k]**2;
      const pad=radius*Math.max(1,Math.sqrt(frobenius));
      for(let i=0;i<primitiveCount;i++) {
        const start=i*(type==='cylinders'?18:3),padding=type==='cylinders'?pad*Math.abs(scales[i*6]):pad;
        if(!include(start,positions,padding,instance) || (type==='cylinders' && !include(start,ends,padding,instance))) return;
      }
    }
    for(let i=0;i<27;i++) if(Number.isFinite(boxes[i*6])) {
      if(count!==i) boxes.copyWithin(count*6,i*6,i*6+6);count++;
    }
    available=true;return boxes.subarray(0,count*6);
  }
  return {get,matches,hasSignature:()=>initialized,stats};
}
