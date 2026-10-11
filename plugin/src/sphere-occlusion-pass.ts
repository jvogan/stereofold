/** Optional Quest-only exact-sphere proxy pass; no authored scene mutations. */
import { ValueCell } from 'molstar/lib/mol-util/value-cell.js';
import { ShaderCode } from 'molstar/lib/mol-gl/shader-code.js';
import { AttributeSpec, UniformSpec, DefineSpec } from 'molstar/lib/mol-gl/renderable/schema.js';
import type { WebGLContext } from 'molstar/lib/mol-gl/webgl/context.js';
import type { Texture } from 'molstar/lib/mol-gl/webgl/texture.js';
import type { Framebuffer } from 'molstar/lib/mol-gl/webgl/framebuffer.js';
import type { AttributeBuffer } from 'molstar/lib/mol-gl/webgl/buffer.js';
import type { VertexArray } from 'molstar/lib/mol-gl/webgl/vertex-array.js';
import type { Program } from 'molstar/lib/mol-gl/webgl/program.js';
import { Mat4 } from 'molstar/lib/mol-math/linear-algebra.js';
export const sphereOcclusionVertex = `precision highp float;
attribute vec3 aUnit;
attribute vec4 aCenterSize;
attribute mat4 aTransform;
uniform mat4 uModelView,uProjection;
uniform float uModelScale,uSizeFactor,uNear,uFootprintFactor;
uniform vec2 uViewportSize;
float privateScale(mat4 t){ vec3 x=t[0].xyz,y=t[1].xyz,z=t[2].xyz; float xx=dot(x,x),e=xx*0.001; if(xx>0.0&&abs(dot(y,y)-xx)<=e&&abs(dot(z,z)-xx)<=e&&abs(dot(x,y))<=e&&abs(dot(x,z))<=e&&abs(dot(y,z))<=e)return sqrt(xx); return 1.0; }
void main(){
 vec4 center=uModelView*aTransform*vec4(aCenterSize.xyz,1.0);
 float radius=(aCenterSize.w*uSizeFactor)*uModelScale*privateScale(aTransform);
 // Near-crossing proxy instances cannot occlude: stock interior behavior differs.
 // Stock sphere quads retain the center's clip Z/W on every corner. A
 // center beyond the far plane clips the entire stock quad even when this
 // sphere's front cap is in range; that cap must never become an occluder.
 vec4 centerClip=uProjection*vec4(center.xyz,1.0);
 if(centerClip.z>centerClip.w){gl_Position=vec4(2.0,2.0,2.0,1.0);return;}
 float centerZ=center.z/center.w;
 float nearMargin=max(0.0000001,max(uNear,radius)*0.00001);
 if(centerZ+radius>=-uNear-nearMargin){gl_Position=vec4(2.0,2.0,2.0,1.0);return;}
 // Shrink for every possible sample within the destination pixel. At fixed
 // view Z, a half-pixel ray shift is |Z|/(viewport * projection diagonal).
 // |Z| <= |centerZ| + radius throughout the original sphere.
 vec2 footprint=1.0/(uViewportSize*abs(vec2(uProjection[0][0],uProjection[1][1])));
 float margin=uFootprintFactor*(abs(centerZ)+radius)*length(footprint);
 if(margin>=radius){gl_Position=vec4(2.0,2.0,2.0,1.0);return;}
 // Additional inward contraction absorbs finite precision at proxy vertices.
 float proxyRadius=(radius-margin)*0.999;
 gl_Position=uProjection*vec4(center.xyz/center.w+aUnit*proxyRadius,1.0);
}`;
const code=ShaderCode('stereofold-sphere-proxy',sphereOcclusionVertex,'precision highp float; void main() {}');
const schema={dRenderVariant:DefineSpec('string',['depth']),aUnit:AttributeSpec('float32',3,0),aCenterSize:AttributeSpec('float32',4,1),aTransform:AttributeSpec('float32',16,1),uModelView:UniformSpec('m4'),uProjection:UniformSpec('m4'),uModelScale:UniformSpec('f'),uSizeFactor:UniformSpec('f'),uNear:UniformSpec('f'),uViewportSize:UniformSpec('v2'),uFootprintFactor:UniformSpec('f')};
// Performance heuristic only. Shader visibility tests do not use these thresholds.
export const sphereOcclusionCoverage={enter:0.50,exit:0.40} as const;
// Matched Quest2 4V6X evidence: ~237k expanded atoms at1440×792
// did not amortize the60-vertex proxy per atom/eye. This is provisional
// optimization qualification, not a render budget, crash bound or optimal
// crossover claim. Exceeding it always renders the requested stock geometry.
export const sphereOcclusionMaxProxyVertexDensity=1;
export type SphereOcclusionContext={camera:any;scene:any};
export type SphereOcclusionDestination={layer:unknown;depthBits:number;samples:number;framebufferMatches:boolean};
type Context=SphereOcclusionContext;
type Layer={framebufferWidth:number;framebufferHeight:number;fixedFoveation?:number;antialias?:boolean};
type Entry={renderable:any;signature:unknown[];count:number;factor:number;center:AttributeBuffer;transform:AttributeBuffer;vao:VertexArray};
const keys=['aTransform','aInstance','tPositionGroup','tSize','uSize','uSizeFactor','drawCount','instanceCount','uGroupCount','uVertexCount','dSizeType'];
const val=(r:any,k:string):any=>r.values[k]?.ref?.value;
const signature=(r:any):unknown[]=>keys.flatMap(k=>[r.values[k],r.values[k]?.ref?.version]);
function sameSignature(e:Pick<Entry,'signature'>,r:any):boolean{for(let i=0;i<keys.length;i++){const c=r.values[keys[i]];if(e.signature[i*2]!==c||e.signature[i*2+1]!==c?.ref?.version)return false;}return true;}
export function sphereProxyScale(m:ArrayLike<number>):number {
 if(m.length!==16||!Array.from(m).every(Number.isFinite)||m[3]!==0||m[7]!==0||m[11]!==0||m[15]!==1)throw Error('Finite affine transform required.');
 const x=[m[0],m[1],m[2]],y=[m[4],m[5],m[6]],z=[m[8],m[9],m[10]],dot=(a:number[],b:number[])=>a.reduce((s,v,i)=>s+v*b[i],0),xx=dot(x,x),e=xx*.001;
 if(!(xx>0)||Math.abs(dot(y,y)-xx)>e||Math.abs(dot(z,z)-xx)>e||Math.abs(dot(x,y))>e||Math.abs(dot(x,z))>e||Math.abs(dot(y,z))>e||dot(x,[y[1]*z[2]-y[2]*z[1],y[2]*z[0]-y[0]*z[2],y[0]*z[1]-y[1]*z[0]])<=0)throw Error('Unsupported nonuniform/sheared/reflected transform.');
 return Math.sqrt(xx);
}
export function sphereProxyProjection(p:ArrayLike<number>):boolean {return p?.length===16&&Array.from(p).every(Number.isFinite)&&p[1]===0&&p[4]===0&&p[2]===0&&p[6]===0&&p[3]===0&&p[7]===0&&p[11]===-1&&p[15]===0&&p[12]===0&&p[13]===0&&p[10]<=-1&&p[14]<0&&p[0]!==0&&p[5]!==0;}
function eligible(r:any):boolean {
 const g=(k:string)=>val(r,k),lod=g('uLod');return g('dGeometryType')==='spheres'&&g('dHasMaterialOpacity')!==true&&g('dClipPrimitive')!==true&&g('dApproximate')===false&&g('dClipObjectCount')===0&&g('dClipping')===false&&g('dTransparency')===false&&g('transparencyAverage')===0&&g('uAlpha')===1&&g('alpha')===1&&r.state.alphaFactor===1&&g('dXrayShaded')==='off'&&lod?.[0]===0&&lod?.[1]===0&&!g('lodLevels')?.length&&g('dWiggle')===false&&g('uWiggleAmplitude')===0&&g('uTumbleAmplitude')===0&&!r.state.disposed;
}
function ico():Float32Array {
 const t=(1+Math.sqrt(5))/2,n=Math.hypot(1,t),v=[-1,t,0,1,t,0,-1,-t,0,1,-t,0,0,-1,t,0,1,t,0,-1,-t,0,1,-t,t,0,-1,t,0,1,-t,0,-1,-t,0,1].map(x=>x/n),f=[0,11,5,0,5,1,0,1,7,0,7,10,0,10,11,1,5,9,5,11,4,11,10,2,10,7,6,7,1,8,3,9,4,3,4,2,3,2,6,3,6,8,3,8,9,4,9,5,2,4,11,6,2,10,8,6,7,9,8,1];return new Float32Array(f.flatMap(i=>v.slice(i*3,i*3+3)));
}
function extract(r:any){
 const g=(k:string)=>val(r,k),n=g('drawCount')/6,instances=g('instanceCount'),pos=g('tPositionGroup')?.array,trans=g('aTransform'),ids=g('aInstance'),factor=g('uSizeFactor'),type=g('dSizeType'),sizes=g('tSize')?.array;
 if(!Number.isSafeInteger(n)||n<=0||!Number.isSafeInteger(instances)||instances<=0||pos?.length<n*4||trans?.length<instances*16||ids?.length<instances||!(factor>0)||!Number.isFinite(factor)||!['uniform','group','instance','groupInstance','vertex','vertexInstance'].includes(type))throw Error('Actual sphere buffers/sizes unavailable.');
 const count=n*instances;if(!Number.isSafeInteger(count))throw Error('Instance count overflow.');const centers=new Float32Array(count*4),transforms=new Float32Array(count*16);
 for(let i=0;i<instances;i++){const m=trans.slice(i*16,i*16+16);sphereProxyScale(m);for(let j=0;j<n;j++){
  const group=pos[j*4+3],instance=ids[i];let size;if(type==='uniform')size=g('uSize');else{const at=type==='group'?group:type==='instance'?instance:type==='groupInstance'?instance*g('uGroupCount')+group:type==='vertex'?j:instance*g('uVertexCount')+j;
   if(!Number.isSafeInteger(at)||at<0||!sizes||at*3+2>=sizes.length)throw Error('Packed size index outside actual buffer.');size=Math.fround((sizes[at*3]*65536+sizes[at*3+1]*256+sizes[at*3+2]-1)/100);}
  if(!(size>0)||!Number.isFinite(size)||![pos[j*4],pos[j*4+1],pos[j*4+2]].every(Number.isFinite))throw Error('Invalid sphere radius/center.');centers.set([pos[j*4],pos[j*4+1],pos[j*4+2],size],(i*n+j)*4);transforms.set(m,(i*n+j)*16);
 }}return {centers,transforms,count,factor};
}
function coverageOf(ctx:Context):number {
 const b=ctx.scene.boundingSphereVisible;if(!b||!(b.radius>0)||!Number.isFinite(b.radius)||!b.center?.every(Number.isFinite))return 0;
 return Math.min(...[ctx.camera.left,ctx.camera.right].map(e=>{const model=Mat4.clone(ctx.scene.primitives.view);for(let c=0;c<3;c++)for(let r=0;r<4;r++)model[c*4+r]*=e.scale;
  const mv=Mat4.mul(Mat4(),e.view,model),p=b.center,z=mv[2]*p[0]+mv[6]*p[1]+mv[10]*p[2]+mv[14],radius=b.radius*e.scale;if(!Number.isFinite(z)||!Number.isFinite(radius))return 0;if(z>=-e.near)return 0;return Math.min(1,Math.abs(e.projection[0]*e.projection[5])*radius*radius/(z*z));
 }));
}
export function createSphereOcclusionPass(webgl:WebGLContext){
 const gl=webgl.gl as WebGL2RenderingContext,s=webgl.state,R=webgl.resources;
 let texture:Texture|null=null,fbo:Framebuffer|null=null,program:Program|null=null,unit:AttributeBuffer|null=null,entries:Entry[]=[],session:any=null,layerIdentity:Layer|null=null,width=0,height=0,active=false,disposed=false;
 let pending:Pick<Entry,'renderable'|'signature'>[]=[];
 let expandedSphereCount:number|null=null,proxyVertexDensity:number|null=null;
 let reason='not prepared',frames=0,rebuilds=0,coverage=0,error:string|null=null;
 function invalidate(){s.currentProgramId=s.currentRenderItemId=s.currentMaterialId=-1;}
 function destroyEntries(){for(const e of entries){e.vao.destroy();e.center.destroy();e.transform.destroy();}entries=[];}
 function drop(){active=false;pending=[];destroyEntries();unit?.destroy();unit=null;program?.destroy();program=null;fbo?.destroy();fbo=null;texture?.destroy();texture=null;width=height=0;}
 const onEnd=()=>{drop();session?.removeEventListener?.('end',onEnd);session=null;layerIdentity=null;reason='session ended';};
 function off(why:string){active=false;pending=[];reason=why;return null;}
 function init(w:number,h:number){texture=R.texture('image-depth','depth','float','nearest');texture.define(w,h);fbo=R.framebuffer();texture.attachFramebuffer(fbo,'depth');fbo.bind();gl.drawBuffers([gl.NONE]);gl.readBuffer(gl.NONE);if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw Error('Proxy framebuffer incomplete.');program=R.program({dRenderVariant:ValueCell.create('depth')},code,schema);program.link();if(!program.finalize(true)||!program.isReady())throw Error('Proxy program pending.');unit=R.attribute(ico(),3,0);width=w;height=h;if(gl.getError()!==gl.NO_ERROR)throw Error('Proxy resource creation failed.');}
 function rebuild(rs:any[]){destroyEntries();for(const renderable of rs){const d=extract(renderable);let center:AttributeBuffer|undefined,transform:AttributeBuffer|undefined,vao:VertexArray|undefined;try{center=R.attribute(d.centers,4,1);transform=R.attribute(d.transforms,16,1);vao=R.vertexArray(program!,[['aUnit',unit!],['aCenterSize',center],['aTransform',transform]]);entries.push({renderable,signature:signature(renderable),count:d.count,factor:d.factor,center,transform,vao});}catch(e){vao?.destroy();center?.destroy();transform?.destroy();throw e;}}rebuilds++;}
 function prepare(ctx:Context,layer:Layer,destination?:SphereOcclusionDestination):Texture|null{
  if(disposed)return null;
  expandedSphereCount=proxyVertexDensity=null;
  try{
   if(typeof navigator==='undefined'||!('xr'in navigator)||!/\bOculusBrowser\//.test(navigator.userAgent)||!/\bQuest 2\b/.test(navigator.userAgent)||typeof gl.drawArraysInstanced!=='function')return off('unsupported browser/context');
   const current=webgl.xr?.session;if(!current||current.renderState.baseLayer!==layer||webgl.isContextLost||gl.isContextLost()){onEnd();return off('inactive/lost XR');}
   if(!destination||destination.framebufferMatches!==true||destination.layer!==layer||!Number.isSafeInteger(destination.depthBits)||destination.depthBits<24||!Number.isSafeInteger(destination.samples)||![0,1,2,4].includes(destination.samples))return off('unqualified native destination');
   const w=layer.framebufferWidth,h=layer.framebufferHeight;if(layer.antialias!==false||![0,1].includes(layer.fixedFoveation??-1)||!Number.isSafeInteger(w)||!Number.isSafeInteger(h)||w<=0||h<=0||w>webgl.maxTextureSize||h>webgl.maxTextureSize)return off('unsupported layer');
   if(session!==current||layerIdentity!==layer||(width&&width!==w)||(height&&height!==h)){session?.removeEventListener?.('end',onEnd);drop();session=current;layerIdentity=layer;session.addEventListener?.('end',onEnd);}
   const scene=ctx.scene,eyes=[ctx.camera?.left,ctx.camera?.right];
   // A new source can be mixed/unsupported and return before eligibility.
   // Release only retired/disposed owners; temporary alpha/clipping changes
   // on the same live scene must not cause needless proxy reallocation.
   const members=scene.primitives.renderables;
   if(entries.some(e=>e.renderable.state.disposed||!members.includes(e.renderable))){
    const retained:Entry[]=[];for(const e of entries){if(e.renderable.state.disposed||!members.includes(e.renderable)){e.vao.destroy();e.center.destroy();e.transform.destroy();}else retained.push(e);}entries=retained;pending=[];
   }
   if(eyes.some(e=>!e||e.disabled||!sphereProxyProjection(e.projection)||!Number.isFinite(e.near)||e.near<=0||!Number.isFinite(e.scale)||e.scale<=0)||scene.volumes.renderables.length||scene.opacityAverage!==1||scene.markerAverage!==0)return off('unsupported scene/eyes');
   if(eyes.some(e=>Math.abs(sphereProxyScale(e.view)-1)>1e-6))return off('unsupported eye view');
   const vs=eyes.map(e=>e.viewport);if(vs.some(v=>![v.x,v.y,v.width,v.height].every(Number.isSafeInteger)||v.x<0||v.y<0||v.width<=0||v.height<=0||v.x+v.width>w||v.y+v.height>h)||!(vs[0].x+vs[0].width<=vs[1].x||vs[1].x+vs[1].width<=vs[0].x||vs[0].y+vs[0].height<=vs[1].y||vs[1].y+vs[1].height<=vs[0].y))return off('invalid viewports');
   if(Math.abs(sphereProxyScale(scene.primitives.view)-1)>1e-6)return off('unsupported scene transform');
   const rs=scene.primitives.renderables.filter((r:any)=>r.state.visible);if(!rs.length||rs.some((r:any)=>!eligible(r)))return off('mixed/unsupported visible geometry');
   const changed=entries.length!==rs.length||entries.some((e,i)=>e.renderable!==rs[i]||!sameSignature(e,rs[i]));
   if(changed&&entries.length)destroyEntries(); // Release retired source geometry even while its replacement is small.
   let total=0;for(const r of rs){const count=val(r,'drawCount')/6,instances=val(r,'instanceCount'),expanded=count*instances;
    if(!Number.isSafeInteger(count)||count<=0||!Number.isSafeInteger(instances)||instances<=0||!Number.isSafeInteger(expanded)||!Number.isSafeInteger(total+expanded))return off('unsupported expanded sphere count');total+=expanded;
   }
   expandedSphereCount=total;proxyVertexDensity=2*60*total/(w*h);
   if(!Number.isFinite(proxyVertexDensity)||proxyVertexDensity>sphereOcclusionMaxProxyVertexDensity)return off('proxy geometry cost exceeds qualified density');
   coverage=coverageOf(ctx);active=active?coverage>=sphereOcclusionCoverage.exit:coverage>=sphereOcclusionCoverage.enter;if(!active)return off('small projected view');
   // Transform versions change every controller/presentation-rotation frame.
   // Require the same identities/versions on two consecutive eligible frames
   // before extracting or uploading a proxy. Always use stock while changing.
   if(changed){
    const stable=pending.length===rs.length&&pending.every((e,i)=>e.renderable===rs[i]&&sameSignature(e,rs[i]));
    if(!stable){pending=rs.map((renderable:any)=>({renderable,signature:signature(renderable)}));reason='geometry changing; stock this frame';return null;}
   }
   // No GL state reads, allocation, extraction, or draws occur for small views.
   const flags=[gl.SCISSOR_TEST,gl.BLEND,gl.CULL_FACE,gl.DEPTH_TEST,gl.STENCIL_TEST,gl.SAMPLE_ALPHA_TO_COVERAGE,gl.SAMPLE_COVERAGE,gl.POLYGON_OFFSET_FILL,gl.RASTERIZER_DISCARD];
   const old={range:Array.from(gl.getParameter(gl.DEPTH_RANGE)) as number[],read:gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),draw:gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING),program:gl.getParameter(gl.CURRENT_PROGRAM),vao:gl.getParameter(gl.VERTEX_ARRAY_BINDING),array:gl.getParameter(gl.ARRAY_BUFFER_BINDING),texture:gl.getParameter(gl.TEXTURE_BINDING_2D),mask:Array.from(gl.getParameter(gl.COLOR_WRITEMASK)) as boolean[],viewport:Array.from(gl.getParameter(gl.VIEWPORT)) as number[],scissor:Array.from(gl.getParameter(gl.SCISSOR_BOX)) as number[],depthFunc:gl.getParameter(gl.DEPTH_FUNC),depthMask:gl.getParameter(gl.DEPTH_WRITEMASK),clearDepth:gl.getParameter(gl.DEPTH_CLEAR_VALUE),frontFace:gl.getParameter(gl.FRONT_FACE),cullFace:gl.getParameter(gl.CULL_FACE_MODE),enabled:flags.map(f=>gl.isEnabled(f))};
   try{
    if(old.range[0]!==0||old.range[1]!==1)return off('unsupported depth range');if(!texture)init(w,h);if(changed){rebuild(rs);pending=[];reason='geometry refreshed; stock this frame';return null;}if(!program!.isReady())return off('proxy program pending');
    fbo!.bind();gl.drawBuffers([gl.NONE]);s.disable(gl.SCISSOR_TEST);s.disable(gl.BLEND);s.disable(gl.STENCIL_TEST);s.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);s.disable(gl.SAMPLE_COVERAGE);s.disable(gl.POLYGON_OFFSET_FILL);s.disable(gl.RASTERIZER_DISCARD);s.enable(gl.CULL_FACE);s.frontFace(gl.CCW);s.cullFace(gl.BACK);s.enable(gl.DEPTH_TEST);s.depthFunc(gl.LESS);s.depthMask(true);s.colorMask(false,false,false,false);s.clearDepth(1);gl.clear(gl.DEPTH_BUFFER_BIT);program!.use();
    for(const eye of eyes){const v=eye.viewport,model=Mat4.clone(scene.primitives.view);for(let c=0;c<3;c++)for(let r=0;r<4;r++)model[c*4+r]*=eye.scale;s.viewport(v.x,v.y,v.width,v.height);program!.uniform('uModelView',Mat4.mul(Mat4(),eye.view,model));program!.uniform('uProjection',eye.projection);program!.uniform('uModelScale',eye.scale);program!.uniform('uNear',eye.near);program!.uniform('uViewportSize',[v.width,v.height]);program!.uniform('uFootprintFactor',layer.fixedFoveation===1?4:1);for(const e of entries){program!.uniform('uSizeFactor',e.factor);e.vao.bind();gl.drawArraysInstanced(gl.TRIANGLES,0,60,e.count);}}
    if(gl.getError()!==gl.NO_ERROR)throw Error('Sphere proxy draw failed.');frames++;reason='prepared';error=null;return texture;
   }finally{
    for(let i=0;i<flags.length;i++)if(old.enabled[i])s.enable(flags[i]);else s.disable(flags[i]);s.colorMask(old.mask[0],old.mask[1],old.mask[2],old.mask[3]);s.depthFunc(old.depthFunc);s.depthMask(old.depthMask);s.clearDepth(old.clearDepth);s.frontFace(old.frontFace);s.cullFace(old.cullFace);s.viewport(old.viewport[0],old.viewport[1],old.viewport[2],old.viewport[3]);s.scissor(old.scissor[0],old.scissor[1],old.scissor[2],old.scissor[3]);gl.bindVertexArray(old.vao);gl.bindBuffer(gl.ARRAY_BUFFER,old.array);gl.useProgram(old.program);gl.bindTexture(gl.TEXTURE_2D,old.texture);gl.bindFramebuffer(gl.READ_FRAMEBUFFER,old.read);gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,old.draw);invalidate();
   }
  }catch(e){error=String(e);drop();reason='proxy failed; stock fallback';return null;}
 }
 function reset(){session?.removeEventListener?.('end',onEnd);drop();session=null;layerIdentity=null;error=null;reason='reset';}
 return {prepare,deactivate(){active=false;pending=[];reason='inactive draw route';},reset,dispose(){if(disposed)return;reset();disposed=true;reason='disposed';},facts(){return {active:active&&reason==='prepared',armed:active,frames,rebuilds,coverage,expandedSphereCount,proxyVertexDensity,reason,error,width,height,proxyObjects:entries.length,pendingGeometry:pending.length,disposed,footprintFactor:layerIdentity?.fixedFoveation===1?4:1};}};
}
