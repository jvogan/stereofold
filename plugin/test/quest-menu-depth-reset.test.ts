import { afterEach, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { createQuestMenuDepthReset } from '../src/quest-menu-depth-reset.js';

function fixture() {
  vi.stubGlobal('navigator', { xr: {}, userAgent: 'Mozilla/5.0 (Quest 2) OculusBrowser/42' });
  const names = ['BLEND','DEPTH_TEST','CULL_FACE','STENCIL_TEST','DITHER','RASTERIZER_DISCARD','SAMPLE_ALPHA_TO_COVERAGE','SAMPLE_COVERAGE','POLYGON_OFFSET_FILL','SCISSOR_TEST','DRAW_FRAMEBUFFER_BINDING','DEPTH_WRITEMASK','DEPTH_CLEAR_VALUE','DEPTH_RANGE','SCISSOR_BOX','CURRENT_PROGRAM','VERTEX_ARRAY_BINDING','COLOR_WRITEMASK','DEPTH_FUNC','VIEWPORT','ALWAYS','LESS','TRIANGLES','COMPILE_STATUS','LINK_STATUS','VERTEX_SHADER','FRAGMENT_SHADER','DEPTH_BUFFER_BIT'];
  const gl: any = Object.fromEntries(names.map((n,i)=>[n,i+1]));
  const fbo={},priorProgram={},priorVao={}, params=new Map<number,any>();
  const enabled = new Set([gl.BLEND,gl.CULL_FACE,gl.STENCIL_TEST,gl.DITHER,gl.SAMPLE_ALPHA_TO_COVERAGE,gl.SAMPLE_COVERAGE,gl.POLYGON_OFFSET_FILL,gl.SCISSOR_TEST]);
  params.set(gl.DRAW_FRAMEBUFFER_BINDING,fbo);params.set(gl.DEPTH_WRITEMASK,true);params.set(gl.DEPTH_CLEAR_VALUE,1);params.set(gl.DEPTH_RANGE,[0,1]);params.set(gl.SCISSOR_BOX,[4,0,4,4]);
  params.set(gl.CURRENT_PROGRAM,priorProgram);params.set(gl.VERTEX_ARRAY_BINDING,priorVao);params.set(gl.COLOR_WRITEMASK,[true,false,true,false]);params.set(gl.DEPTH_FUNC,gl.LESS);params.set(gl.VIEWPORT,[5,1,2,2]);
  const depth=Array(8*4*4).fill(.2),color=Array(8*4*4).fill(37),stencil=Array(8*4*4).fill(19),deleted:any[]=[],sources:string[]=[];
  const listeners=new Map<string,Function>(),sessionListeners=new Map<string,Function>();let allocation=0,draws=0,queries=0,lost=false,compile=true,drawThrows=false;
  gl.canvas={addEventListener:(n:string,f:Function)=>listeners.set(n,f),removeEventListener:(n:string)=>listeners.delete(n)};
  gl.getParameter=(n:number)=>{queries++;return params.get(n);};gl.isEnabled=(n:number)=>enabled.has(n);gl.isContextLost=()=>lost;
  gl.enable=(n:number)=>enabled.add(n);gl.disable=(n:number)=>enabled.delete(n);
  gl.colorMask=(...a:boolean[])=>params.set(gl.COLOR_WRITEMASK,a);gl.depthMask=(a:boolean)=>params.set(gl.DEPTH_WRITEMASK,a);gl.depthFunc=(a:number)=>params.set(gl.DEPTH_FUNC,a);gl.viewport=(...a:number[])=>params.set(gl.VIEWPORT,a);
  gl.useProgram=(a:any)=>params.set(gl.CURRENT_PROGRAM,a);gl.bindVertexArray=(a:any)=>params.set(gl.VERTEX_ARRAY_BINDING,a);
  for(const n of ['createProgram','createVertexArray','createShader'])gl[n]=()=>({allocation:++allocation});
  for(const n of ['deleteProgram','deleteVertexArray','deleteShader'])gl[n]=(o:any)=>deleted.push(o);
  gl.shaderSource=(_:any,source:string)=>sources.push(source);gl.compileShader=()=>{};gl.attachShader=()=>{};gl.linkProgram=()=>{};gl.getShaderParameter=()=>compile;gl.getProgramParameter=()=>compile;
  function reset(value:number){const [x,y,w,h]=params.get(gl.SCISSOR_BOX);for(let yy=y;yy<y+h;yy++)for(let xx=x;xx<x+w;xx++)for(let sample=0;sample<4;sample++)depth[(yy*8+xx)*4+sample]=value;}
  gl.clear=()=>{if(params.get(gl.DEPTH_WRITEMASK)&&!enabled.has(gl.RASTERIZER_DISCARD))reset(params.get(gl.DEPTH_CLEAR_VALUE));};
  gl.drawArrays=()=>{
    if(drawThrows)throw Error('injected draw error');draws++;
    expect(params.get(gl.VIEWPORT)).toEqual([0,0,8,4]);expect(params.get(gl.COLOR_WRITEMASK)).toEqual([false,false,false,false]);expect(params.get(gl.DEPTH_FUNC)).toBe(gl.ALWAYS);expect(params.get(gl.DEPTH_WRITEMASK)).toBe(true);expect(enabled.has(gl.DEPTH_TEST)).toBe(true);
    for(const n of ['BLEND','CULL_FACE','STENCIL_TEST','DITHER','RASTERIZER_DISCARD','SAMPLE_ALPHA_TO_COVERAGE','SAMPLE_COVERAGE','POLYGON_OFFSET_FILL'])expect(enabled.has(gl[n])).toBe(false);
    reset(1);
  };
  const layer={framebuffer:fbo,framebufferWidth:8,framebufferHeight:4,fixedFoveation:1};
  const session={renderState:{baseLayer:layer},addEventListener:(n:string,f:Function)=>sessionListeners.set(n,f),removeEventListener:(n:string)=>sessionListeners.delete(n)};
  const webgl:any={gl,xr:{session},state:{currentProgramId:2,currentRenderItemId:3,currentMaterialId:4}};
  const owner=createQuestMenuDepthReset(webgl);
  const state=()=>({params:[...params].map(([k,v])=>[k,Array.isArray(v)?[...v]:v]),enabled:[...enabled].sort()});
  return {gl,webgl,owner,layer,session,params,enabled,depth,color,stencil,deleted,sources,listeners,sessionListeners,state,
    get allocations(){return allocation;},get draws(){return draws;},get queries(){return queries;},set lost(x:boolean){lost=x;},set compile(x:boolean){compile=x;},set drawThrows(x:boolean){drawThrows=x;}};
}
afterEach(()=>vi.unstubAllGlobals());
describe('opt-in native Quest menu depth reset',()=>{
  it('matches clear coverage at all four samples despite a smaller viewport, preserving color/stencil/raw state',()=>{
    const a=fixture(),b=fixture(),before=b.state();a.gl.clear(a.gl.DEPTH_BUFFER_BIT);expect(b.owner.resetDepth()).toBe(true);
    expect(b.depth).toEqual(a.depth);expect(b.color).toEqual(Array(128).fill(37));expect(b.stencil).toEqual(Array(128).fill(19));expect(b.state()).toEqual(before);expect(b.draws).toBe(1);
    expect(b.webgl.state).toEqual({currentProgramId:-1,currentRenderItemId:-1,currentMaterialId:-1});expect(b.sources[1]).toContain('gl_FragDepth=1.0');
    b.owner.dispose();expect(b.deleted).toHaveLength(4);expect(b.listeners.size).toBe(0);expect(b.sessionListeners.size).toBe(0);
  });
  it('keeps the other eye untouched, including a one-pixel scissor',()=>{const f=fixture();f.params.set(f.gl.SCISSOR_BOX,[2,1,1,1]);expect(f.owner.resetDepth()).toBe(true);expect(f.depth.filter(x=>x===1)).toHaveLength(4);expect(f.depth.slice(4*4)).not.toEqual(Array(112).fill(1));});
  it('retains original clear no-ops with rasterizer discard or false mask',()=>{for(const raster of [false,true]){const f=fixture();if(raster)f.enabled.add(f.gl.RASTERIZER_DISCARD);else f.params.set(f.gl.DEPTH_WRITEMASK,false);expect(f.owner.resetDepth()).toBe(false);f.gl.clear(f.gl.DEPTH_BUFFER_BIT);expect(f.depth.every(x=>x===.2)).toBe(true);expect(f.allocations).toBe(0);}});
  it('falls back for offscreen, unknown ranges/scissor/clear value and unsupported foveation',()=>{
    for(const change of [(f:any)=>f.params.set(f.gl.DRAW_FRAMEBUFFER_BINDING,{}),(f:any)=>f.params.set(f.gl.DEPTH_RANGE,[.1,.9]),(f:any)=>f.params.set(f.gl.DEPTH_CLEAR_VALUE,.5),(f:any)=>f.enabled.delete(f.gl.SCISSOR_TEST),(f:any)=>f.params.set(f.gl.SCISSOR_BOX,[0,0,9,4]),(f:any)=>f.layer.fixedFoveation=.5]){const f=fixture();change(f);expect(f.owner.resetDepth()).toBe(false);expect(f.allocations).toBe(0);expect(f.draws).toBe(0);}
  });
  it('leaves desktop, Safari/VisionPro and unqualified Quest devices completely stock before GL queries',()=>{
    for(const change of [(f:any)=>f.webgl.xr.session=undefined,()=>vi.stubGlobal('navigator',{xr:{},userAgent:'Safari Vision Pro'}),()=>vi.stubGlobal('navigator',{xr:{},userAgent:'Quest 3 OculusBrowser'}),()=>vi.stubGlobal('navigator',{userAgent:'Quest 2 OculusBrowser'})]){const f=fixture();change(f);expect(f.owner.resetDepth()).toBe(false);expect(f.queries).toBe(0);expect(f.allocations).toBe(0);}
  });
  it('activates lazily after XR starts, reallocates on layer changes and retires at session end',()=>{
    const f=fixture();f.webgl.xr.session=undefined;expect(f.owner.resetDepth()).toBe(false);f.webgl.xr.session=f.session;expect(f.owner.resetDepth()).toBe(true);const n=f.allocations;
    f.session.renderState.baseLayer={...f.layer};expect(f.owner.resetDepth()).toBe(true);expect(f.allocations).toBe(n+4);expect(f.deleted).toHaveLength(4);f.sessionListeners.get('end')!();expect(f.owner.facts().resources).toBe(false);
  });
  it('retires and rebuilds resources after context reset, and dispose is terminal/idempotent',()=>{
    const f=fixture();expect(f.owner.resetDepth()).toBe(true);f.lost=true;f.listeners.get('webglcontextlost')!();expect(f.owner.resetDepth()).toBe(false);f.lost=false;f.listeners.get('webglcontextrestored')!();expect(f.owner.resetDepth()).toBe(true);expect(f.allocations).toBe(8);f.owner.dispose();f.owner.dispose();expect(f.deleted).toHaveLength(8);expect(f.owner.resetDepth()).toBe(false);
  });
  it('restores state after draw failure, releases resources and returns stock fallback without repeated compilation',()=>{
    const f=fixture(),before=f.state();f.drawThrows=true;expect(f.owner.resetDepth()).toBe(false);expect(f.state()).toEqual(before);expect(f.owner.facts().error).toContain('injected draw error');expect(f.deleted).toHaveLength(4);expect(f.owner.resetDepth()).toBe(false);expect(f.allocations).toBe(4);f.gl.clear(f.gl.DEPTH_BUFFER_BIT);expect(f.depth.filter(x=>x===1)).toHaveLength(64);
  });
  it('compile failure preserves state and latches honest stock fallback',()=>{const f=fixture(),before=f.state();f.compile=false;expect(f.owner.resetDepth()).toBe(false);expect(f.state()).toEqual(before);expect(f.owner.facts().error).toContain('compile failed');expect(f.deleted).toHaveLength(3);expect(f.owner.resetDepth()).toBe(false);expect(f.allocations).toBe(3);});
  it('unavailable native-state queries return stock fallback instead of preventing the presentation clear',()=>{const f=fixture();f.gl.getParameter=()=>{throw Error('query unavailable');};expect(f.owner.resetDepth()).toBe(false);expect(f.owner.facts().error).toContain('query unavailable');expect(f.allocations).toBe(0);f.gl.clear(f.gl.DEPTH_BUFFER_BIT);expect(f.depth.filter(x=>x===1)).toHaveLength(64);});
  it('default inspector composition eliminates the candidate helper and shader entirely',async()=>{
    const entry=fileURLToPath(new URL('../../lab/browser-roundtrip/presentation-scene.mjs',import.meta.url));
    for(const enabled of [false,true]){const result=await build({entryPoints:[entry],bundle:true,write:false,minify:true,platform:'browser',external:['molstar/*'],define:{__STEREOFOLD_QUEST_MENU_DEPTH_RESET__:String(enabled)}});const source=result.outputFiles[0].text;expect(source.includes('Presentation depth-reset shader compile failed.')).toBe(enabled);expect(source.includes('gl_FragDepth=1.0')).toBe(enabled);}
  });
});
