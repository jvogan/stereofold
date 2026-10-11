import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { splitValues, getValueVersions, UniformSpec, TextureSpec, DefineSpec } from 'molstar/lib/mol-gl/renderable/schema.js';
import { patchMolstarOpaqueRendererSource, patchMolstarOpaqueRenderItemSource } from '../src/molstar-opaque-depth-patch.js';
const read=(p:string)=>readFileSync(new URL('../node_modules/molstar/lib/'+p,import.meta.url),'utf8');
const renderer=read('mol-gl/renderer.js'),itemSource=read('mol-gl/webgl/render-item.js');
const cell=(value:any)=>({ref:{value,version:0}});
const between=(s:string,a:string,b:string)=>s.slice(s.indexOf(a),s.indexOf(b,s.indexOf(a)));

/** Actual vendor renderer renderObject, pass loops, createGraphicsRenderItem and
 * render() execute together. Only GL/resources are simulated: each cached program
 * retains its uploaded uniforms, as a linked WebGLProgram does across use(). */
function harness(mode:'stock'|'patched'|'unfixed',nav:any={userAgent:'OculusBrowser/40.0',xr:{}}) {
  const textureUploads:any[]=[],snapshots:any[]=[],programs=new Map<string,any>();let current:any;
  const state:any={currentProgramId:-1,currentMaterialId:-1,currentRenderItemId:-1,
    enable(){},disable(){},depthMask(){},frontFace(){},cullFace(){},blendFunc(){},blendFuncSeparate(){}};
  const ctx:any={state,stats:{drawCount:0,instanceCount:0,instancedDrawCount:0},gl:{TRIANGLES:4},
    extensions:{instancedArrays:{drawArraysInstanced(){snapshots.push({...current.uniforms});}}},
    resources:{program(defines:any){
      const key=defines.dRenderVariant.ref.value+':'+!!defines.dStereofoldOpaqueNoDiscard?.ref.value;
      if(programs.has(key))return programs.get(key);
      const p:any={id:programs.size+1,uniforms:{},use(){current=p;state.currentProgramId=p.id;},
        setUniforms(entries:any[]){for(const [k,c] of entries)p.uniforms[k]=c.ref.value;},
        bindTextures(entries:any[]){for(const [name,texture] of entries)textureUploads.push({program:p.id,name,texture});},bindAttributes(){},destroy(){}};programs.set(key,p);return p;
    }}};
  const context:any=vm.createContext({navigator:nav,isDebugMode:false,isTimingMode:false,
    idFactory:()=>{let id=0;return()=>id++;},ValueCell:{create:cell},DefineSpec,splitValues,getValueVersions,
    createAttributeBuffers:()=>[],createTextures:(_ctx:any,_schema:any,values:any)=>Object.entries(values).map(([k,c]:any)=>[k,c.ref.value]),cloneUniformValues:()=>({}),
    ctx,state,gl:ctx.gl,modelScale:1,boundingSphere:{},frustum:{},cameraPlane:{},isOccluded:null,
    Sphere3D:{scaleNX(){}},Frustum3D:{intersectsSphere3D:()=>true},
    globalUniformsNeedUpdate:true,globalUniformList:[],sharedTexturesList:[],globalUniforms:{uMarkerAverage:cell(0)},
    transparentBackground:false,Flag:{None:0,BlendedBack:1,BlendedFront:2},Mask:{Opaque:0,Transparent:1},
    clamp:(v:number,a:number,b:number)=>Math.min(b,Math.max(a,v)),
    updateInternal(){state.currentRenderItemId=-1;}});
  vm.runInContext(patchMolstarOpaqueRenderItemSource(itemSource).replace(/^import .*;\r?\n/gm,'').replace(/export /g,'')+'\nglobalThis.create=createGraphicsRenderItem;',context);
  let source=mode==='stock'?renderer:patchMolstarOpaqueRendererSource(renderer);
  // Keep a negative-control reproduction after the production fix lands.
  if(mode==='unfixed')source=source.replace(/state\.currentMaterialId = -1;/g,'').replace(/state\.currentRenderItemId = -1;/g,'');
  const start=mode==='stock'?'        const renderOpaque =':'        const stereofoldQuestOpaque';
  vm.runInContext(between(source,'        const renderObject =','        const update =')
    +between(source,'        const checkOpaque =','        const checkEmissive =')
    +between(source,start,'        const renderVolume =')
    +'\nglobalThis.opaque=renderOpaque;globalThis.transparent=renderBlendedTransparent;',context);
  function object(materialId:number,color:string,alpha:number,reflection=false) {
    const values:any=Object.fromEntries(Object.entries({alpha,uAlpha:alpha,uColor:color,uRoughness:materialId/10,tColor:'texture-'+color,
      drawCount:3,instanceCount:1,dGeometryType:'mesh',dXrayShaded:'off',transparencyAverage:0,dTransparency:false,
      dClipObjectCount:0,uDoubleSided:false,hasReflection:reflection,dFlipSided:false,dTransparentBackfaces:'off',
      uLod:[0,0,0,0],boundingSphere:{},instanceGrid:{cellSize:0},uInstanceCount:1}).map(([k,v])=>[k,cell(v)]));
    const item=context.create(ctx,'triangles',{name:'mesh'},{uAlpha:UniformSpec('f','material'),uColor:UniformSpec('v3','material'),uRoughness:UniformSpec('f','material'),tColor:TextureSpec('texture','rgba','ubyte','nearest','material')},values,materialId,'blended');
    return {values,state:{alphaFactor:1,visible:true,pickable:true},getProgram:item.getProgram,render:item.render,uncull(){}};
  }
  return {snapshots,textureUploads,state,object,draw:(pass:'opaque'|'transparent',items:any[])=>context[pass]({renderables:items},{},true)};
}

function sequence(mode:'stock'|'patched'|'unfixed',pass:'opaque'|'transparent',nav?:any) {
  const h=harness(mode,nav);
  const n=h.object(1,'N',pass==='opaque'?1:.2),z=h.object(2,'M',1,pass==='opaque'),x=h.object(2,'M',1);
  // Per-group transparency takes X through the stock transparent loop while
  // keeping M's material uniforms identical to opaque Z's. N has a distinct
  // opacity so a stale stock program also exposes an alpha upload failure.
  if(pass==='transparent') {
    x.values.dTransparency.ref.value=true;
    x.values.transparencyAverage.ref.value=.5;
  }
  h.draw(pass,[x]); // X remembers its program from the previous frame.
  h.draw(pass,[n]); // The same program now holds another material N.
  h.draw('opaque',[z]); // Z switches to the other program with material M.
  h.draw(pass,[x]); // X must upload M again when returning to its program.
  return h.snapshots.map(v=>({color:v.uColor,alpha:v.uAlpha,roughness:v.uRoughness}));
}

describe('material uploads follow actual renderer program changes',()=>{
  it.each(['opaque','transparent'] as const)('reproduces the unfixed %s mixed-program cache failure',pass=>{
    const stock=sequence('stock',pass),unfixed=sequence('unfixed',pass);
    expect(stock.at(-1)).toEqual({color:'M',alpha:1,roughness:.2});
    expect(unfixed.at(-1)).toEqual({color:'N',alpha:pass==='opaque'?1:.2,roughness:.1});
  });
  it.each(['opaque','transparent'] as const)('preserves material uniforms in the patched %s loop',pass=>{
    expect(sequence('patched',pass)).toEqual(sequence('stock',pass));
  });
  it('rebinds material textures when returning to a shared fast program',()=>{
    const h=harness('patched'),n=h.object(1,'N',1),z=h.object(2,'M',1,true),x=h.object(2,'M',1);
    h.draw('opaque',[x]);h.draw('opaque',[n]);h.draw('opaque',[z,x]);
    const fastProgram=x.getProgram('colorOpaqueNoDiscard').id;
    expect(h.textureUploads.filter(v=>v.program===fastProgram).map(v=>v.texture)).toEqual(['texture-M','texture-N','texture-M']);
  });
  it.each(['opaque','transparent'] as const)('leaves non-Quest %s material uploads correct',pass=>{
    expect(sequence('patched',pass,{userAgent:'Safari',xr:{}})).toEqual(sequence('stock',pass));
  });
});
