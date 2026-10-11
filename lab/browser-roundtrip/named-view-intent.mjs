import { cameraSnapshot } from './camera-snapshot.mjs';

const finite3 = v => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
const add=(a,b)=>a.map((v,i)=>v+b[i]);
const sub=(a,b)=>a.map((v,i)=>v-b[i]);
const scale=(a,s)=>a.map(v=>v*s);
const dot=(a,b)=>a.reduce((v,x,i)=>v+x*b[i],0);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const unit=v=>{const length=Math.hypot(...v);if(!Number.isFinite(length)||length<1e-10)throw Error('Named view needs a nondegenerate direction.');return scale(v,1/length);};
const identity=s=>({sourceSha256:s.sourceSha256,modelNumber:s.modelNumber,assemblyId:s.assemblyId});
const basis=(direction,up)=>{const forward=unit(direction);return {direction:forward,up:unit(sub(up,scale(forward,dot(up,forward))))};};

/** Positive similarity transforms only: no reflected handedness or shear. */
function transform(matrix) {
  if(!matrix || matrix.length!==16 || !Array.from(matrix).every(Number.isFinite)
    || Math.abs(matrix[3])+Math.abs(matrix[7])+Math.abs(matrix[11])+Math.abs(matrix[15]-1)>1e-6)
    throw Error('Named view requires a finite affine transform.');
  const columns=[0,4,8].map(i=>Array.from(matrix).slice(i,i+3));
  const sizes=columns.map(v=>Math.hypot(...v)),size=sizes[0];
  if(size<=1e-10 || sizes.some(v=>Math.abs(v/size-1)>1e-5)) throw Error('Named view requires uniform positive scale.');
  const axes=columns.map(v=>scale(v,1/size));
  if(Math.abs(dot(axes[0],axes[1]))>1e-5 || Math.abs(dot(axes[1],axes[2]))>1e-5 || Math.abs(dot(axes[0],axes[2]))>1e-5 || dot(cross(axes[0],axes[1]),axes[2])<1-1e-5)
    throw Error('Named view cannot capture a reflected or sheared transform.');
  const translation=Array.from(matrix).slice(12,15);
  const vector=v=>[0,1,2].map(i=>columns[0][i]*v[0]+columns[1][i]*v[1]+columns[2][i]*v[2]);
  return {size,point:v=>add(vector(v),translation),vector,
    inversePoint:v=>axes.map(axis=>dot(sub(v,translation),axis)/size),
    inverseVector:v=>axes.map(axis=>dot(v,axis)/size)};
}
function sphere(center,radius) {if(!finite3(center)||!Number.isFinite(radius)||radius<=0)throw Error('Named view needs molecular bounds.');}
export function validateNamedViewIntent(value,source) {
  const fields=['version','sourceSha256','modelNumber','assemblyId','targetOffsetRadii','direction','up','distanceInRadii','verticalSpanRadii'];
  if(!value || Object.keys(value).length!==fields.length || Object.keys(value).some(key=>!fields.includes(key)) || value.version!==1 || !/^[a-f0-9]{64}$/.test(value.sourceSha256)
    || !Number.isSafeInteger(value.modelNumber)||value.modelNumber<1 || typeof value.assemblyId!=='string'||!value.assemblyId.length
    || Object.entries(identity(source)).some(([key,v])=>value[key]!==v)) throw Error('Named view belongs to another scientific source.');
  if(!finite3(value.targetOffsetRadii)||value.targetOffsetRadii.some(v=>Math.abs(v)>1000)
    || !finite3(value.direction)||!finite3(value.up)
    || Math.abs(Math.hypot(...value.direction)-1)>1e-5 || Math.abs(Math.hypot(...value.up)-1)>1e-5 || Math.abs(dot(value.direction,value.up))>1e-5
    || ![value.distanceInRadii,value.verticalSpanRadii].every(v=>Number.isFinite(v)&&v>0&&v<=100000)) throw Error('Named view framing or axes are invalid.');
  return structuredClone(value);
}
function record({source,center,radius,eye,target,up,verticalSpan}) {
  sphere(center,radius);
  const axes=basis(sub(target,eye),up);
  const value={version:1,...identity(source),targetOffsetRadii:scale(sub(target,center),1/radius),...axes,
    distanceInRadii:Math.hypot(...sub(target,eye))/radius,verticalSpanRadii:verticalSpan/radius};
  return validateNamedViewIntent(value,source);
}
/** Deliberate capture only. All room/eye matrices terminate in this call. */
export function captureXrNamedViewIntent({source,center,radius,headInRoom,renderFromRoom,cameraScale,moleculeTransform,projectionMatrices}) {
  sphere(center,radius);
  if(!Number.isFinite(cameraScale)||cameraScale<=0)throw Error('Named view needs current XR scale.');
  const head=transform(headInRoom),render=transform(renderFromRoom),molecule=transform(moleculeTransform);
  const point=p=>molecule.inversePoint(scale(render.point(p),1/cameraScale));
  const eye=point(head.point([0,0,0]));
  const axes=basis(sub(point(head.point([0,0,-1])),eye),sub(point(head.point([0,1,0])),eye));
  const distance=dot(sub(center,eye),axes.direction);
  if(!Number.isFinite(distance)||distance<=0)throw Error('Look toward the molecule before saving its view.');
  const gains=(projectionMatrices??[]).map(p=>p?.length===16?Math.abs(p[5]):NaN);
  if(!gains.length || gains.some(v=>!Number.isFinite(v)||v<=0))throw Error('Named view needs the current XR projection.');
  // The overlap shared by both eyes is the conservative vertical framing.
  const verticalSpan=2*distance/Math.max(...gains);
  return record({source,center,radius,eye,target:add(eye,scale(axes.direction,distance)),up:axes.up,verticalSpan});
}
export function captureDesktopNamedViewIntent({source,center,radius,camera,moleculeTransform}) {
  const checked=cameraSnapshot(camera),molecule=transform(moleculeTransform);
  const eye=molecule.inversePoint(checked.position),target=molecule.inversePoint(checked.target);
  return record({source,center,radius,eye,target,up:molecule.inverseVector(checked.up),
    verticalSpan:2*Math.hypot(...sub(target,eye))*Math.tan(checked.fov/2)});
}
/** Reframe at the recipient's FOV/aspect, retaining molecular target and angle. */
export function desktopCameraForNamedView({intent,source,center,radius,moleculeTransform,camera,aspect}) {
  const view=validateNamedViewIntent(intent,source),base=cameraSnapshot(camera),molecule=transform(moleculeTransform);
  sphere(center,radius);
  if(!Number.isFinite(aspect)||aspect<=0)throw Error('Named view needs a visible desktop viewport.');
  const target=molecule.point(add(center,scale(view.targetOffsetRadii,radius)));
  const axes=basis(molecule.vector(view.direction),molecule.vector(view.up));
  // Portrait panels gain vertical room rather than clipping the named framing
  // horizontally. Perspective and orthographic Mol* use this fov/distance span.
  const span=view.verticalSpanRadii*radius*molecule.size/Math.min(1,aspect);
  const distance=span/(2*Math.tan(base.fov/2));
  const clipRadius=radius*molecule.size+Math.hypot(...scale(view.targetOffsetRadii,radius*molecule.size));
  return cameraSnapshot({...base,position:sub(target,scale(axes.direction,distance)),target,up:axes.up,
    radius:clipRadius,radiusMax:Math.max(base.radiusMax,clipRadius)});
}
