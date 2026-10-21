import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { patchMolstarMotionCanvasSource } from '../src/molstar-motion-patch.js';
// @ts-ignore real Mol* CPU fixture shared with node tests.
import { motionFixture } from '../../lab/browser-roundtrip/motion-benchmark-fixture.mjs';
it('batches registered real Mol* objects once and does not upload an empty/unknown batch',async()=>{
  const require=createRequire(import.meta.url),h=await motionFixture();
  try{
    const source=patchMolstarMotionCanvasSource(readFileSync(require.resolve('molstar/lib/mol-canvas3d/canvas3d.js'),'utf8'));
    const start=source.indexOf('            updateRepresentations:');
    const registered=new Map(h.registry.representations().map((r:any)=>[r,new Set(r.renderObjects)])),calls:any[]=[];
    const context=vm.createContext({reprRenderObjects:registered,scene:{update(objects:any[],keep:boolean){calls.push({objects:[...objects],keep});}},forceDrawAfterAllCommited:false});
    const update=vm.runInContext('({'+source.slice(start,source.indexOf('            update:',start))+'}).updateRepresentations',context);
    const visible=h.registry.representations().filter((r:any)=>r.state.visible);
    update(visible,false);expect(calls).toHaveLength(1);expect(calls[0].objects).toEqual(visible.flatMap((r:any)=>r.renderObjects));
    expect(context.forceDrawAfterAllCommited).toBe(true);context.forceDrawAfterAllCommited=false;
    update([],false);update([{renderObjects:[]}],false);expect(calls).toHaveLength(1);expect(context.forceDrawAfterAllCommited).toBe(false);
    expect(()=>patchMolstarMotionCanvasSource('changed')).toThrow('changed');
  }finally{await h.dispose();}
});

it('runs annotation layout after the current camera update and before deciding whether to draw',()=>{
  const require=createRequire(import.meta.url);
  const source=patchMolstarMotionCanvasSource(readFileSync(require.resolve('molstar/lib/mol-canvas3d/canvas3d.js'),'utf8'));
  const start=source.indexOf('        function render(force, xrFrame) {');
  const end=source.indexOf('            forceNextRender = false;',start);
  const events:string[]=[];
  const context=vm.createContext({
    webgl:{isContextLost:false,xr:{},getDrawingBufferSize:()=>({width:1000,height:700})},
    resizeRequested:false,x:0,y:0,width:1000,height:700,currentTime:10,
    resolveMarking:()=>false,renderer:{props:{enableAnimation:false}},scene:{hasAnimation:false},
    controls:{update:()=>events.push('controls')},camera:{update:()=>{events.push('camera');return false;}},
    xrManager:{update:()=>false},forceNextRender:false,
    beforeRender:{next:()=>{events.push('layout');context.forceNextRender=true;}},
  });
  vm.runInContext(source.slice(start,end)+'return shouldRender; }',context);
  expect(context.render(false)).toBe(true);
  expect(events).toEqual(['controls','camera','layout']);
  const stereoCamera={left:{view:'tracked-left'},right:{view:'tracked-right'}};
  Object.assign(context,{stereoCamera,xrManager:{update:()=>true}});
  let received;
  context.beforeRender.next=(value:any)=>{received=value;};
  context.render(false);
  expect(received).toBe(stereoCamera);
  expect(source.indexOf('beforeRender.next(xrChanged ? stereoCamera : camera);')).toBeLessThan(source.indexOf('passes.illumination.render(ctx'));
  expect(()=>patchMolstarMotionCanvasSource(source.replace('const activeAnimation =','const changedAnimation ='))).toThrow('render order changed');
});
