import {expect,it} from 'vitest';

import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';

// Mol* is replaced by the smallest stand-in the room lock actually touches:
// a scene that counts `update` calls, and value cells that record writes.
const MOLSTAR_STUB=`
export const Scene={create:()=>{
  const scene={count:0,updates:0,objects:[],
    add(object){scene.objects.push(object);scene.count=scene.objects.length;},
    remove(){},clear(){scene.objects=[];scene.count=0;},commit(){},syncVisibility(){},
    update(objects){scene.updates+=1;globalThis.__roomLockUpdates.push(objects?.length??0);}};
  return scene;
}};
export const ValueCell={create:value=>({ref:{value}}),update:(cell,value)=>{cell.ref.value=value;return cell;}};
export const updateTransformData=()=>{};
export const calculateTransformBoundingSphere=()=>({center:[0,0,0],radius:1});
`;

async function sceneRuntime(){
  const built=await build({entryPoints:[fileURLToPath(new URL('../../lab/browser-roundtrip/presentation-scene.mjs',import.meta.url))],
    bundle:true,write:false,format:'esm',platform:'node',plugins:[{name:'molstar-stub',setup(api){
      api.onResolve({filter:/^molstar\//},args=>({path:args.path,namespace:'molstar-stub'}));
      api.onLoad({filter:/.*/,namespace:'molstar-stub'},()=>({contents:MOLSTAR_STUB}));
    }}]});
  return import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
}

const IDENTITY=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];

function renderObject(){
  return {values:{matrix:{ref:{value:new Float32Array(16)}},aTransform:{ref:{value:new Float32Array(16)}},
    transform:{ref:{value:new Float32Array(16)}},uModelScale:{ref:{value:1}},
    boundingSphere:{ref:{value:{center:[0,0,0],radius:1}}},
    invariantBoundingSphere:{ref:{value:{center:[0,0,0],radius:1}}},
    aInstance:{ref:{value:new Float32Array(1)}},instanceCount:{ref:{value:1}},
    instanceGrid:{ref:{value:{}}}}};
}

function harness(){
  (globalThis as any).__roomLockUpdates=[];
  const camera={view:[...IDENTITY],scale:0.01};
  const draws={count:0};
  // Canvas3D drives the layer through the registry entry, not through the
  // handle the caller keeps: `syncVisibility` is the per-frame call.
  const entries=new Map<string,any>();
  const canvas={camera,webgl:{},requestDraw(){draws.count+=1;},
    debugRegistry:{register(name:string,entry:any){entries.set(name,entry);},unregister(){}}};
  return {canvas,camera,draws,frame:()=>entries.get('stereofold-presentation').syncVisibility()};
}

const roomLockUpdates=()=>(globalThis as any).__roomLockUpdates as number[];

it('opts room UI text into SDF smoothing before adding it, without flagging molecular text or plates',async()=>{
  const {createPresentationScene}=await sceneRuntime();
  const {canvas}=harness();
  const layer=createPresentationScene(canvas);
  const ui:any={...renderObject(),type:'text'}, molecule:any={...renderObject(),type:'text'}, plate:any={...renderObject(),type:'mesh'};
  layer.add({renderObjects:[ui,plate]},{roomLocked:true});
  layer.add({renderObjects:[molecule]});
  expect(ui.values.dStereofoldUiSdf.ref.value).toBe(true);
  expect(plate.values.dStereofoldUiSdf).toBeUndefined();
  expect(molecule.values.dStereofoldUiSdf).toBeUndefined();
  layer.dispose();
});

it('re-places room-locked objects only when the view actually moved',async()=>{
  const {createPresentationScene}=await sceneRuntime();
  const {canvas,camera,frame}=harness();
  const layer=createPresentationScene(canvas);
  const representation={renderObjects:[renderObject(),renderObject()]};
  layer.add(representation,{roomLocked:true});
  roomLockUpdates().length=0;

  // The first sync after an add always places the objects: `add` clears the
  // key so a fresh object is never drawn for one frame at the identity.
  frame();
  expect(roomLockUpdates()).toEqual([2]);

  // Head tracking that produced the same view matrix costs nothing. This is
  // the case that runs on almost every immersive frame.
  for(let tick=0;tick<72;tick++)frame();
  expect(roomLockUpdates()).toEqual([2]);

  // One changed element of the view matrix is enough to re-place.
  camera.view[13]=0.001;
  frame();
  expect(roomLockUpdates()).toEqual([2,2]);
  frame();
  expect(roomLockUpdates()).toEqual([2,2]);

  // So is a camera scale change at an unchanged view.
  camera.scale=0.02;
  frame();
  expect(roomLockUpdates()).toEqual([2,2,2]);
});

it('does not hold a reference to the caller\'s matrix', async()=>{
  const {createPresentationScene}=await sceneRuntime();
  const {canvas,camera,frame}=harness();
  const layer=createPresentationScene(canvas);
  layer.add({renderObjects:[renderObject()]},{roomLocked:true});
  roomLockUpdates().length=0;
  frame();
  expect(roomLockUpdates()).toEqual([1]);
  // Mutating the camera's own view array in place is what a tracked head
  // does. A comparison that aliased the derived matrix would miss it.
  camera.view[12]=0.5;
  frame();
  expect(roomLockUpdates()).toEqual([1,1]);
});


it('moves only room-locked menu uniforms and restores their original transform', async()=>{
  const {createPresentationScene}=await sceneRuntime();
  const {canvas,frame}=harness();
  const layer=createPresentationScene(canvas);
  const object=renderObject(), molecule=renderObject();
  const menu={renderObjects:[object]}, source={renderObjects:[molecule]};
  layer.add(menu,{roomLocked:true}); layer.add(source);
  frame();
  const before=Array.from(object.values.matrix.ref.value);
  const scientific=Array.from(molecule.values.matrix.ref.value);
  expect(layer.setRoomOffset(source,[1,0,0])).toBe(false);
  expect(layer.setRoomOffset(menu,[NaN,0,0])).toBe(false);
  const offset=[.2,.1,-.3];
  expect(layer.setRoomOffset(menu,offset)).toBe(true); offset[0]=9;
  frame();
  expect(object.values.matrix.ref.value[12]-before[12]).toBeCloseTo(20);
  expect(object.values.matrix.ref.value[13]-before[13]).toBeCloseTo(10);
  expect(object.values.matrix.ref.value[14]-before[14]).toBeCloseTo(-30);
  expect(Array.from(molecule.values.matrix.ref.value)).toEqual(scientific);
  expect(layer.setRoomOffset(menu,[0,0,0])).toBe(true); frame();
  expect(Array.from(object.values.matrix.ref.value)).toEqual(before);
});

it('caches DOF across dirty presentation draws and follows both public Canvas3D setter forms',async()=>{
  const {createPresentationScene}=await sceneRuntime();
  const h=harness();
  let props:any={postprocessing:{dof:{name:'off'}}},reads=0,clears=0;
  const calls:any[]=[];
  Object.defineProperty(h.canvas,'props',{get(){reads++;return structuredClone(props);}});
  const canvas:any=h.canvas;
  canvas.webgl={gl:{DEPTH_BUFFER_BIT:256,clear(mask:number){expect(mask).toBe(256);clears++;}},state:{depthMask(value:boolean){expect(value).toBe(true);}}};
  const setter=function(this:any,patch:any,noDraw:any){
    expect(this).toBe(canvas);calls.push([patch,noDraw]);
    if(typeof patch==='function'){const draft=structuredClone(props);props=patch(draft)??draft;}
    else if(patch.postprocessing)Object.assign(props.postprocessing,patch.postprocessing);
    return 37;
  };
  canvas.setProps=setter;
  const layer=createPresentationScene(canvas);
  layer.add({renderObjects:[renderObject()]},{roomLocked:true});
  expect(reads).toBe(1);
  // Dirty transforms still update room uniforms; neither eye's guard may
  // request Canvas3D's derived full-scene camera-radius snapshot.
  for(let frame=0;frame<216;frame++){h.camera.view[12]=frame*.001;h.frame();h.frame();}
  expect(reads).toBe(1);expect(clears).toBe(432);
  expect(roomLockUpdates().length).toBe(216);
  expect(canvas.setProps({renderer:{backgroundColor:0}},true)).toBe(37);
  expect(reads).toBe(1);expect(calls.at(-1)[1]).toBe(true);
  const on={postprocessing:{dof:{name:'on'}}};
  expect(canvas.setProps(on,true)).toBe(37);expect(calls.at(-1)[0]).toBe(on);
  h.frame();expect(clears).toBe(432);expect(reads).toBe(2);
  const updater=(draft:any)=>{draft.postprocessing.dof={name:'off'};};
  expect(canvas.setProps(updater,false)).toBe(37);
  h.frame();expect(clears).toBe(433);expect(reads).toBe(3);
  layer.dispose();expect(canvas.setProps).toBe(setter);
});

it('observes partial setter failure and removes only its own active DOF observer',async()=>{
  const {createPresentationScene}=await sceneRuntime();const h=harness(),canvas:any=h.canvas;
  let dof='off',reads=0,clears=0;
  Object.defineProperty(canvas,'props',{get(){reads++;return {postprocessing:{dof:{name:dof}}};}});
  canvas.webgl={gl:{DEPTH_BUFFER_BIT:1,clear(){clears++;}},state:{depthMask(){}}};
  const failure=Error('shader update failed');
  canvas.setProps=function(patch:any){dof=patch.postprocessing.dof.name;throw failure;};
  const layer=createPresentationScene(canvas);layer.add({renderObjects:[renderObject()]});
  h.frame();expect(clears).toBe(1);
  expect(()=>canvas.setProps({postprocessing:{dof:{name:'on'}}})).toThrow(failure);
  h.frame();expect(clears).toBe(1);
  const observed=canvas.setProps;
  const later=function(this:any,...args:any[]){return observed.apply(this,args);};
  canvas.setProps=later;layer.dispose();expect(canvas.setProps).toBe(later);
  const before=reads;
  expect(()=>canvas.setProps({postprocessing:{dof:{name:'off'}}})).toThrow(failure);
  expect(reads).toBe(before);
});
