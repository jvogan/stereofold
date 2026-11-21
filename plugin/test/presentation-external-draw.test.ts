import {expect,it} from 'vitest';

import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';

// The same Mol* stand-in as the room-lock test: a scene that counts updates,
// syncs and clears, and value cells that record writes.
const MOLSTAR_STUB=`
export const Scene={create:()=>{
  const scene={count:0,updates:0,syncs:0,clears:0,objects:[],
    add(object){scene.objects.push(object);scene.count=scene.objects.length;},
    remove(object){scene.objects=scene.objects.filter(o=>o!==object);scene.count=scene.objects.length;},
    clear(){scene.clears+=1;scene.objects=[];scene.count=0;},commit(){},syncVisibility(){scene.syncs+=1;},
    update(objects){scene.updates+=1;},
    // As in Mol*, a renderable is its own object sharing the render object's state and values.
    get renderables(){return scene.objects.map(object=>({state:object.state,values:object.values}));},
    view:'scene-view',position:'scene-position',direction:'scene-direction',up:'scene-up'};
  return scene;
}};
export const ValueCell={create:value=>({ref:{value}}),update:(cell,value)=>{cell.ref.value=value;return cell;},updateIfChanged:(cell,value)=>{cell.ref.value=value;return cell;}};
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
  return {type:'mesh',state:{visible:true},values:{matrix:{ref:{value:new Float32Array(16)}},aTransform:{ref:{value:new Float32Array(16)}},
    boundingSphere:{ref:{value:{center:[0,0,0],radius:1}}},invariantBoundingSphere:{ref:{value:{center:[0,0,0],radius:1}}},
    instanceCount:{ref:{value:1}},instanceGrid:{ref:{value:{}}}}};
}

/** A Canvas3D stand-in whose registry behaves like Mol*'s: unregister clears. */
function harness(){
  const camera={view:[...IDENTITY],scale:0.01};
  const cleared:string[]=[], draws={count:0};
  const entries=new Map<string,any>();
  const depthClears={count:0};
  const gl={DEPTH_BUFFER_BIT:256,clear(){depthClears.count+=1;}};
  const canvas={camera,webgl:{gl,state:{depthMask(){}}},requestDraw(){draws.count+=1;},
    debugRegistry:{register(name:string,entry:any){entries.get(name)?.clear();entries.set(name,entry);},
      unregister(name:string){const entry=entries.get(name);if(entry){entry.clear();cleared.push(name);entries.delete(name);}}}};
  return {canvas,camera,entries,cleared,draws,depthClears};
}

it('hands the layer to an external drawer without clearing it, and Canvas3D no longer sees it',async()=>{
  const {createPresentationScene}=await sceneRuntime();
  const h=harness();
  const layer=createPresentationScene(h.canvas);
  const representation={renderObjects:[renderObject(),renderObject()]};
  layer.add(representation,{roomLocked:true});
  const entry=h.entries.get('stereofold-presentation');
  expect(entry.scene.count).toBe(2);
  const handle=layer.useExternalDraw();
  expect(handle).toBeTruthy();
  expect(h.entries.has('stereofold-presentation')).toBe(false);
  expect(entry.scene.count).toBe(2);
  expect(entry.scene.clears).toBe(0);
  expect(layer.useExternalDraw()).toBeUndefined();
  layer.dispose();
});

it('prepares a frame without the mid-pass depth clear',async()=>{
  const {createPresentationScene}=await sceneRuntime();
  const h=harness();
  const layer=createPresentationScene(h.canvas);
  layer.add({renderObjects:[renderObject()]},{roomLocked:true});
  // The stock entry clears depth from inside Canvas3D's pass.
  h.entries.get('stereofold-presentation').syncVisibility();
  expect(h.depthClears.count).toBe(1);
  const handle=layer.useExternalDraw();
  const before=handle.scene.updates, syncs=handle.scene.syncs;
  h.camera.view[12]=0.5; // the wearer moved
  expect(handle.prepare()).toBe(true);
  // The room lock was applied for the current camera and visibility synced.
  expect(handle.scene.updates).toBe(before+1);
  expect(handle.scene.syncs).toBe(syncs+1);
  expect(h.depthClears.count).toBe(1);
  layer.dispose();
});

it('gives the layer back to Canvas3D on release, and a released handle does nothing',async()=>{
  const {createPresentationScene}=await sceneRuntime();
  const h=harness();
  const layer=createPresentationScene(h.canvas);
  layer.add({renderObjects:[renderObject()]});
  const handle=layer.useExternalDraw();
  handle.release();
  const entry=h.entries.get('stereofold-presentation');
  expect(entry).toBeTruthy();
  expect(entry.scene.count).toBe(1);
  expect(handle.prepare()).toBe(false);
  handle.release();
  expect(layer.useExternalDraw()).toBeTruthy();
  layer.dispose();
});

it('disposes a handed-over layer by clearing its own scene',async()=>{
  const {createPresentationScene}=await sceneRuntime();
  const h=harness();
  const layer=createPresentationScene(h.canvas);
  layer.add({renderObjects:[renderObject()]});
  const handle=layer.useExternalDraw();
  layer.dispose();
  expect(handle.scene.clears).toBe(1);
  expect(handle.scene.count).toBe(0);
  expect(h.entries.has('stereofold-presentation')).toBe(false);
  expect(handle.prepare()).toBe(false);
  // The stock path still unregisters, which clears.
  const stock=createPresentationScene(harness().canvas);
  stock.dispose();
});

it('counts every change to what the layer draws',async()=>{
  const {createPresentationScene}=await sceneRuntime();
  const h=harness();
  const layer=createPresentationScene(h.canvas);
  const representation={renderObjects:[renderObject()]};
  const seen=[layer.contentVersion()];
  layer.add(representation,{roomLocked:true}); seen.push(layer.contentVersion());
  layer.update(representation); seen.push(layer.contentVersion());
  layer.setVisible(representation,false); seen.push(layer.contentVersion());
  layer.setRoomOffset(representation,[0,0.1,0]); seen.push(layer.contentVersion());
  layer.remove(representation); seen.push(layer.contentVersion());
  for(let i=1;i<seen.length;i++) expect(seen[i]).toBeGreaterThan(seen[i-1]);
  layer.dispose();
});

it('hands the scene over in two parts, the menu column and everything else, only to a drawer that asks',async()=>{
  const {createPresentationScene}=await sceneRuntime();
  const h=harness();
  const layer=createPresentationScene(h.canvas);
  const glass={renderObjects:[renderObject()]}, labels={renderObjects:[renderObject(),renderObject()]};
  const card={renderObjects:[renderObject()]}, caption={renderObjects:[renderObject()]};
  layer.add(glass,{roomLocked:true,menuColumn:true});
  layer.add(card,{roomLocked:true});
  layer.add(labels,{roomLocked:true,menuColumn:true});
  layer.add(caption);
  // Marking a part of the column changes nothing while Canvas3D draws the layer.
  expect(layer.separatesMenuColumn()).toBe(false);
  expect(h.entries.get('stereofold-presentation').scene.count).toBe(5);
  const handle=layer.useExternalDraw({separateMenuColumn:true});
  expect(layer.separatesMenuColumn()).toBe(true);
  const states=(group:any)=>group.renderables.map((r:any)=>r.state);
  const parts=handle.split();
  expect(states(parts.column)).toEqual([glass.renderObjects[0].state,labels.renderObjects[0].state,labels.renderObjects[1].state]);
  expect(states(parts.rest)).toEqual([card.renderObjects[0].state,caption.renderObjects[0].state]);
  // Each part is a group the renderer can draw, placed as the scene is.
  for(const group of [parts.column,parts.rest]) expect(group).toMatchObject({view:'scene-view',hasOpaque:true,opacityAverage:0});
  // The parts follow the scene: a removed card leaves, a new column part joins, and the lists are reused.
  const highlight={renderObjects:[renderObject()]};
  layer.remove(card); layer.add(highlight,{roomLocked:true,menuColumn:true});
  const again=handle.split();
  expect(again).toBe(parts);
  expect(states(again.column)).toHaveLength(4);
  expect(states(again.rest)).toEqual([caption.renderObjects[0].state]);
  // A removed column part is forgotten, so a later object that reuses nothing of it is not taken for one.
  layer.remove(glass);
  expect(states(handle.split().column)).toHaveLength(3);
  handle.release();
  expect(layer.separatesMenuColumn()).toBe(false);
  expect(handle.split()).toBeUndefined();
  // A drawer that does not ask gets no parts and the column is not kept apart.
  const whole=layer.useExternalDraw();
  expect(layer.separatesMenuColumn()).toBe(false);
  expect(whole.split()).toBeUndefined();
  layer.dispose();
});
