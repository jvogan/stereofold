import { expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import { readDensityGeometryObjects } from '../scripts/density-geometry-probe.js';
import { molecularGeometryProbeBundle } from '../scripts/molecular-geometry-probe.js';

const value=(value:any)=>({ref:{value}});
function fixture(error=0) {
  const keys=['READ_FRAMEBUFFER_BINDING','DRAW_FRAMEBUFFER_BINDING','FRAMEBUFFER_BINDING','PACK_ALIGNMENT','PACK_ROW_LENGTH',
    'PACK_SKIP_ROWS','PACK_SKIP_PIXELS','PIXEL_PACK_BUFFER_BINDING','FRAMEBUFFER','READ_FRAMEBUFFER','DRAW_FRAMEBUFFER',
    'PIXEL_PACK_BUFFER','FRAMEBUFFER_COMPLETE','RGBA','FLOAT','NO_ERROR'];
  const gl:any=Object.fromEntries(keys.map((key,index)=>[key,index+1]));gl.NO_ERROR=0;
  const initial=new Map<number,any>([[gl.READ_FRAMEBUFFER_BINDING,'prior-read'],[gl.DRAW_FRAMEBUFFER_BINDING,'prior-draw'],
    [gl.PACK_ALIGNMENT,8],[gl.PACK_ROW_LENGTH,17],[gl.PACK_SKIP_ROWS,3],[gl.PACK_SKIP_PIXELS,2],[gl.PIXEL_PACK_BUFFER_BINDING,'prior-pack']]);
  const state=new Map(initial),deleted:any[]=[];
  const bind=(target:number,framebuffer:any)=>{
    if (target===gl.FRAMEBUFFER || target===gl.READ_FRAMEBUFFER) state.set(gl.READ_FRAMEBUFFER_BINDING,framebuffer);
    if (target===gl.FRAMEBUFFER || target===gl.DRAW_FRAMEBUFFER) state.set(gl.DRAW_FRAMEBUFFER_BINDING,framebuffer);
  };
  Object.assign(gl,{readBuffer:()=>{},getParameter:(key:number)=>state.get(key),createFramebuffer:()=>({probe:true}),
    deleteFramebuffer:(framebuffer:any)=>deleted.push(framebuffer),checkFramebufferStatus:()=>gl.FRAMEBUFFER_COMPLETE,
    bindBuffer:(_target:number,buffer:any)=>state.set(gl.PIXEL_PACK_BUFFER_BINDING,buffer),
    pixelStorei:(key:number,v:any)=>state.set(key,v),getError:()=>error,
    readPixels:(_x:number,_y:number,_w:number,_h:number,_format:number,_type:number,array:Float32Array)=>{
      expect(state.get(gl.PIXEL_PACK_BUFFER_BINDING)).toBe(null);
      expect(state.get(gl.PACK_ROW_LENGTH)).toBe(0);
      array.set([0,0,0,1,1,0,0,1,0,1,0,1,999,999,999,1]);
    }});
  const matrix=[1,0,0,0,0,1,0,0,0,0,1,0,.25,0,-4,1];
  const object={type:'texture-mesh',state:{visible:true,alphaFactor:1},values:{dGeometryType:value('textureMesh'),
    drawCount:value(3),uVertexCount:value(3),instanceCount:value(1),uGeoTexDim:value([2,2]),aTransform:value(matrix),
    tPosition:value({attachFramebuffer:(framebuffer:any)=>framebuffer.bind()})}};
  return {gl,bind,object,state,initial,deleted,matrix};
}

it('reads only committed live vertices and preserves transforms and every changed GL binding/pack setting',()=>{
  const f=fixture(),[object]=readDensityGeometryObjects([f.object],f.gl,f.bind);
  expect(Array.from(object.values.aPosition.ref.value)).toEqual([0,0,0,1,0,0,0,1,0]);
  expect(object.values.aTransform.ref.value).toBe(f.matrix);
  expect(f.state).toEqual(f.initial);expect(f.deleted).toHaveLength(1);
});

it('restores GL state and releases its framebuffer when float readback fails',()=>{
  const f=fixture(1282);
  expect(()=>readDensityGeometryObjects([f.object],f.gl,f.bind)).toThrow('readback failed');
  expect(f.state).toEqual(f.initial);expect(f.deleted).toHaveLength(1);
});

it('refuses hidden, malformed or masked geometry rather than inventing lit density bounds',()=>{
  const f=fixture();f.object.state.visible=false;
  expect(()=>readDensityGeometryObjects([f.object],f.gl,f.bind)).toThrow('No visible');
  f.object.state.visible=true;f.object.values.uVertexCount=value(4);
  expect(()=>readDensityGeometryObjects([f.object],f.gl,f.bind)).toThrow('Invalid live');
  f.object.values.uVertexCount=value(3);(f.object.values as any).dTransparency=value(true);
  expect(()=>readDensityGeometryObjects([f.object],f.gl,f.bind)).toThrow('transparency mask');
  expect(f.deleted).toHaveLength(0);
});

it.each(['observed-bind','default-layer'])('the served probe projects texture vertices via %s without changing the atomic reader',async mode=>{
  const f=fixture(),identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
  const projection=[1,0,0,0,0,1,0,0,0,0,-1.002,-1,0,0,-.2002,0];
  f.gl.bindFramebuffer=function(target:number,framebuffer:any) {expect(this).toBe(f.gl);f.bind(target,framebuffer);};
  // IWER's default framebuffer is null, so the observer never records gl.
  const active=mode==='default-layer'?{session:{renderState:{baseLayer:{framebuffer:null,context:f.gl}}}}
    :{gl:f.gl,nativeBindFramebuffer:f.bind};
  const context:any={__stereofoldReadGeometry:()=>({objects:[f.object],cameraScale:.5,
    views:['left','right'].map(eye=>({eye,projectionMatrix:projection,transform:{inverse:{matrix:identity},matrix:identity}}))}),
    __companionXrTest:{active}};
  runInNewContext(await molecularGeometryProbeBundle(),context);
  const measured=context.__stereofoldMeasureDensity();
  expect(measured.vertexCount).toBe(3);expect(measured.triangleCount).toBe(1);
  expect(measured.renderCoordinateBoundsMeters).toEqual({min:[.125,0,-2],max:[.625,.5,-2],extent:[.5,.5,0]});
  expect(measured.eyes.map((eye:any)=>eye.eye)).toEqual(['left','right']);
  for (const eye of measured.eyes) expect(eye.angularDegrees.width).toBeGreaterThan(0);
  expect(()=>context.__stereofoldMeasureMolecule()).toThrow('No live lit molecular vertices');
  expect(f.state).toEqual(f.initial);
  if (mode==='default-layer') expect(active).not.toHaveProperty('gl');
});
