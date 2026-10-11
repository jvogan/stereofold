import {expect,it} from 'vitest';

import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';

const HIGHLIGHT='Stereofold toolbar highlight';

// Mol* is replaced with a recording stand-in, so the hover plate's lifecycle
// can be counted in Node without a GPU. The stand-in keeps the parts of the
// contract this behaviour depends on: `getShape` is handed the previous shape,
// `MeshBuilder.createState` is handed the mesh to rebuild into, and a
// representation exposes one render object that survives an update.
const MOLSTAR_STUB=`
const counters=()=>globalThis.__toolbarStub;
export const MeshBuilder={
  createState:(_initial,_chunk,mesh)=>({currentGroup:-1,triangles:0,mesh}),
  addTriangleWithNormal:state=>{state.triangles+=1;},
  getMesh:state=>{
    if(state.mesh){counters().meshRebuilds+=1;state.mesh.triangleCount=state.triangles;return state.mesh;}
    counters().meshAllocations+=1;
    return {kind:'mesh',id:counters().meshAllocations,triangleCount:state.triangles};
  },
};
export const Mesh={Utils:{kind:'mesh'}};
// Mol*'s TextBuilder.add is (text, x, y, z, depth, scale, group).
export const TextBuilder={create:()=>({entries:[],add(text,x,y,z,_depth,size,group){this.entries.push({text,point:[x,y,z],size,group});},getText(){return {kind:'text',entries:this.entries};}})};
export const Text={Utils:{kind:'text'}};
export const Shape={create:(name,sourceData,geometry,getColor,getSize,getLabel)=>({name,geometry,getColor,getSize,getLabel})};
export const ShapeRepresentation=getShape=>{
  let shape;
  counters().constructed.push(getShape);
  const representation={
    renderObjects:[{id:counters().constructed.length}],
    visible:true,destroyed:false,
    get shape(){return shape;},
    createOrUpdate:(props,data)=>({async run(){
      shape=await getShape({},data,props,shape);
      counters().record(representation,shape);
    }}),
    setState(state){if(state.visible!==undefined)representation.visible=state.visible;},
    destroy(){representation.destroyed=true;},
  };
  return representation;
};
export const Color=value=>value;
// spatial-toolbar.mjs addGlyphs reads advances from the atlas Mol* lays out with;
// a fixed-advance stub keeps the highlight tests independent of the real font.
export const getFontAtlas=()=>({buffer:0,lineHeight:1,get:()=>({nw:0.6})});
`;

async function toolbarRuntime(){
  const built=await build({entryPoints:[fileURLToPath(new URL('../../lab/browser-roundtrip/spatial-toolbar.mjs',import.meta.url))],
    bundle:true,write:false,format:'esm',platform:'node',plugins:[{name:'molstar-recorder',setup(api){
      api.onResolve({filter:/^molstar\//},args=>({path:args.path,namespace:'molstar-stub'}));
      api.onLoad({filter:/.*/,namespace:'molstar-stub'},()=>({contents:MOLSTAR_STUB}));
    }}]});
  return import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
}

const IDENTITY=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
const EYE=[0,1.6,0];

/** A controller pose whose target ray runs from the wearer's eye to `point`. */
function pointer(point:number[]|undefined){
  const matrix=[...IDENTITY];
  if(point){const direction=point.map((value,axis)=>value-EYE[axis]);
    matrix[8]=-direction[0];matrix[9]=-direction[1];matrix[10]=-direction[2];}
  const pose=point?{transform:{matrix,position:{x:EYE[0],y:EYE[1],z:EYE[2]}}}:undefined;
  return {targetRaySpace:{pose}};
}

function rowCentres(entries:any[]){
  const byGroup=new Map<number,{sum:number[],count:number}>();
  for(const entry of entries){
    const row=byGroup.get(entry.group)??{sum:[0,0,0],count:0};
    entry.point.forEach((value:number,axis:number)=>{row.sum[axis]+=value;});
    row.count+=1;byGroup.set(entry.group,row);
  }
  return [...byGroup.entries()].sort((a,b)=>a[0]-b[0])
    .map(([group,row])=>({group,point:row.sum.map(value=>value/row.count)}));
}
function harness(){
  const counters={meshAllocations:0,meshRebuilds:0,constructed:[] as unknown[],
    highlights:new Set<any>(),highlightUpdates:0,labels:[] as any[],
    record(representation:any,shape:any){
      if(shape?.name===HIGHLIGHT){counters.highlights.add(representation);counters.highlightUpdates+=1;}
      // The label builder writes one entry per glyph (spatial-toolbar.mjs addGlyphs),
      // so a row's centre is the mean of the glyphs sharing its group.
      if(shape?.name==='Stereofold spatial toolbar')counters.labels=rowCentres(shape.geometry.entries);
    }};
  (globalThis as any).__toolbarStub=counters;
  const presentation={adds:[] as any[],removes:[] as any[],updates:[] as any[],
    add(representation:any,options:any){presentation.adds.push({representation,options});},
    remove(representation:any){presentation.removes.push(representation);},
    update(representation:any){presentation.updates.push(representation);}};
  const frame={getViewerPose:()=>({transform:{position:{x:EYE[0],y:EYE[1],z:EYE[2]},matrix:IDENTITY}}),
    getPose:(space:any)=>space?.pose};
  const session=Object.assign(new EventTarget(),{inputSources:[] as any[],
    requestAnimationFrame(callback:(time:number,frame:unknown)=>void){setTimeout(()=>callback(0,frame),0);return 1;},
    cancelAnimationFrame(){}});
  return {counters,presentation,frame,session};
}

const settle=async()=>{for(let turn=0;turn<6;turn++)await new Promise(resolve=>setTimeout(resolve,0));};

it('keeps passive controller hover silent while preserving explicit press feedback', async () => {
  const {createSpatialToolbar}=await toolbarRuntime();
  const {counters,presentation,frame,session}=harness();
  const pulses: number[][]=[];
  const toolbar=createSpatialToolbar({plugin:{runTask:(task:any)=>task.run()},canvas:{},presentation,session,space:{},Mat4:{},
    getMolecularBounds:()=>({radius:10}),getDepthRange:()=>({})});
  try {
    await toolbar.update();
    const sources=counters.labels.slice(0,2).map((row,index)=>Object.assign(pointer(row.point),{
      handedness:index?'right':'left', gamepad:{hapticActuators:[{pulse:(...args:number[])=>{pulses.push(args);return Promise.resolve(true);}}]},
    }));
    session.inputSources=sources;
    // Submillimetre tracking jitter alternates the most recently moved hand.
    // Both controllers remain aimed at their own row with no button held.
    for(let index=0;index<72;index++){
      sources[index%2].targetRaySpace.pose!.transform.position.x+=(index%4<2?1:-1)*0.0003;
      toolbar.syncInput(frame);
    }
    await settle();
    expect([...counters.highlights].some(plate=>plate.visible)).toBe(true);
    expect(pulses).toEqual([]);
    const press=()=>session.dispatchEvent(Object.assign(new Event('selectstart'),{inputSource:sources[0],frame}));
    press();
    expect(pulses).toEqual([[0.65,45]]);
    Object.assign(session,{visibilityState:'hidden'});
    toolbar.blur();
    toolbar.syncInput(frame);
    press();
    expect(pulses).toHaveLength(1);
    Object.assign(session,{visibilityState:'visible'});
    await toolbar.dispose();
    toolbar.syncInput(frame);
    press();
    expect(pulses).toHaveLength(1);
  } finally { await toolbar.dispose(); }
});

it('builds the hover plate once per layout and updates it in place afterwards',async()=>{
  const {createSpatialToolbar}=await toolbarRuntime();
  const {counters,presentation,frame,session}=harness();
  const toolbar=createSpatialToolbar({plugin:{runTask:(task:any)=>task.run()},canvas:{},presentation,session,space:{},Mat4:{},
    getMolecularBounds:()=>({radius:10}),getDepthRange:()=>({})});
  await toolbar.update();
  // Row centres come back through the label builder, so the rays below aim at
  // the same points the panel was drawn from.
  const rows=counters.labels;
  expect(rows.length).toBeGreaterThan(2);
  expect(counters.highlights.size).toBe(0);

  const aim=async(point?:number[])=>{session.inputSources=[pointer(point)];toolbar.syncInput(frame);await settle();};

  await aim(rows[0].point);
  expect(counters.highlightUpdates).toBe(1);
  expect(counters.highlights.size).toBe(1);
  const plate=[...counters.highlights][0];
  const added=presentation.adds.filter(entry=>entry.representation===plate);
  expect(added).toHaveLength(1);
  expect(added[0].options).toEqual({roomLocked:true});
  expect(plate.visible).toBe(true);

  // Crossing to another row and back reuses the same representation, the same
  // render object and the same mesh: no allocation, nothing destroyed.
  const allocationsAfterFirst=counters.meshAllocations;
  const objectId=plate.renderObjects[0].id;
  await aim(rows[1].point);
  await aim(rows[2].point);
  await aim(rows[0].point);
  expect(counters.highlights.size).toBe(1);
  expect(counters.highlightUpdates).toBe(4);
  expect(counters.meshAllocations).toBe(allocationsAfterFirst);
  expect(counters.meshRebuilds).toBeGreaterThanOrEqual(3);
  expect(plate.renderObjects[0].id).toBe(objectId);
  expect(plate.destroyed).toBe(false);
  expect(presentation.adds.filter(entry=>entry.representation===plate)).toHaveLength(1);
  expect(presentation.removes).not.toContain(plate);

  // Aiming off the panel hides the plate rather than destroying it, and
  // aiming back shows it again without a rebuild.
  await aim(undefined);
  expect(plate.visible).toBe(false);
  expect(plate.destroyed).toBe(false);
  expect(counters.highlights.size).toBe(1);
  await aim(rows[1].point);
  expect(plate.visible).toBe(true);
  expect(counters.highlights.size).toBe(1);
  expect(counters.highlightUpdates).toBe(5);

  await toolbar.dispose();
  expect(plate.destroyed).toBe(true);
  expect(presentation.removes).toContain(plate);
});

it('gives the plate geometry back when the panel is rebuilt',async()=>{
  const {createSpatialToolbar}=await toolbarRuntime();
  const {counters,presentation,frame,session}=harness();
  // The panel rebuilds only when its rows, caption or physical layout change
  // (spatial-toolbar.mjs contentSignature); an idle update() is a no-op by
  // design. A notice with new text is the cheapest genuine content change.
  let state:any={};
  const toolbar=createSpatialToolbar({plugin:{runTask:(task:any)=>task.run()},canvas:{},presentation,session,space:{},Mat4:{},
    getMolecularBounds:()=>({radius:10}),getDepthRange:()=>({}),getState:()=>state});
  await toolbar.update();
  session.inputSources=[pointer(counters.labels[0].point)];
  toolbar.syncInput(frame);
  await settle();
  const first=[...counters.highlights][0];
  await toolbar.update();
  expect(first.destroyed).toBe(false);
  state={voice:{state:'listening'}};
  await toolbar.update();
  expect(first.destroyed).toBe(true);
  expect(presentation.removes).toContain(first);
  session.inputSources=[pointer(counters.labels[1].point)];
  toolbar.syncInput(frame);
  await settle();
  expect(counters.highlights.size).toBe(2);
  await toolbar.dispose();
});

it('does not rebuild the panel when nothing it draws has changed',async()=>{
  const {createSpatialToolbar}=await toolbarRuntime();
  const {counters,presentation,frame,session}=harness();
  // `refreshToolbar` fires on every tour and voice notification whether or not
  // the panel shows anything new. A headset session logged 232 full
  // plate rebuilds with the wearer doing nothing, and the wearer sees each one
  // as a flicker at the edge of vision.
  let state:any={tour:{active:false,step:0,total:5}};
  const toolbar=createSpatialToolbar({plugin:{runTask:(task:any)=>task.run()},canvas:{},presentation,session,space:{},Mat4:{},
    getMolecularBounds:()=>({radius:10}),getDepthRange:()=>({}),getState:()=>state});
  await toolbar.update();
  const built=counters.constructed.length;
  const adds=presentation.adds.length;
  expect(built).toBeGreaterThan(0);
  for(let repeat=0;repeat<20;repeat++)await toolbar.update();
  expect(counters.constructed.length).toBe(built);
  expect(presentation.adds.length).toBe(adds);
  // A caption that genuinely changed still rebuilds.
  state={tour:{active:true,step:1,total:5,caption:'Cas9 holding the target DNA'}};
  await toolbar.update();
  expect(counters.constructed.length).toBeGreaterThan(built);
  await toolbar.dispose();
});

it('reports which hands have a ray on the panel, one hand at a time',async()=>{
  // The trigger modifier used to ask select-ownership whether the ray was on
  // the menu, and ownership is only set once a select has started: on the frame
  // the trigger goes down it is still empty, so a press aimed at a row both
  // chose the row and latched the depth modifier, and the structure slewed away
  // under the wearer while the menu opened.
  const {createSpatialToolbar}=await toolbarRuntime();
  const {counters,presentation,frame,session}=harness();
  const toolbar=createSpatialToolbar({plugin:{runTask:(task:any)=>task.run()},canvas:{},presentation,session,space:{},Mat4:{},
    getMolecularBounds:()=>({radius:10}),getDepthRange:()=>({})});
  await toolbar.update();
  const rows=counters.labels;
  const hand=(handedness:string,point?:number[])=>({...pointer(point),handedness});
  expect(toolbar.isHandOnPanel('right')).toBe(false);

  session.inputSources=[hand('right',rows[0].point),hand('left',undefined)];
  toolbar.syncInput(frame);await settle();
  expect(toolbar.isHandOnPanel('right')).toBe(true);
  expect(toolbar.isHandOnPanel('left')).toBe(false);

  // Both rays on the panel: the highlight keeps one winning row, but each hand
  // has to answer for its own trigger.
  session.inputSources=[hand('right',rows[0].point),hand('left',rows[1].point)];
  toolbar.syncInput(frame);await settle();
  expect(toolbar.isHandOnPanel('right')).toBe(true);
  expect(toolbar.isHandOnPanel('left')).toBe(true);

  // Aiming away answers immediately, before any select has ended.
  session.inputSources=[hand('right',undefined),hand('left',undefined)];
  toolbar.syncInput(frame);await settle();
  expect(toolbar.isHandOnPanel('right')).toBe(false);
  expect(toolbar.isHandOnPanel('left')).toBe(false);

  // A hidden menu is not a menu the ray can be on.
  session.inputSources=[hand('right',rows[0].point)];
  toolbar.syncInput(frame);await settle();
  expect(toolbar.isHandOnPanel('right')).toBe(true);
  toolbar.setHidden(true);
  toolbar.syncInput(frame);await settle();
  expect(toolbar.isHandOnPanel('right')).toBe(false);
  await toolbar.dispose();
});

it('drops a held press and its lit row when the session goes blind',async()=>{
  // A headset session blurs whenever a system dialog takes focus, and it can
  // happen repeatedly. WebXR delivers no input while blurred, so a
  // trigger held at that moment never gets its release inside the session: the
  // row stays glowing and the captured action is still armed when the dialog
  // closes. `blur()` is what immersive-session calls on the blind edge.
  const {createSpatialToolbar}=await toolbarRuntime();
  const {counters,presentation,frame,session}=harness();
  const consumed:any[]=[];
  const actions:any[]=[];
  const previousDiagnostics=(globalThis as any).__stereofoldDiagnostics;
  const ran:any[]=[];
  (globalThis as any).__stereofoldDiagnostics={record:(kind:string,detail:any)=>{if(kind==='toolbar-action')ran.push(detail);}};
  try{
    const toolbar=createSpatialToolbar({plugin:{runTask:(task:any)=>task.run()},canvas:{},presentation,session,space:{},Mat4:{},
      getMolecularBounds:()=>({radius:10}),getDepthRange:()=>({}),
      onAction:async(action:any)=>{actions.push(action);},
      onConsumeSelect:({phase,action}:any)=>{consumed.push({phase,kind:action?.kind});}});
    await toolbar.update();
    const source=pointer(counters.labels[0].point);
    session.inputSources=[source];
    const fire=(type:string)=>session.dispatchEvent(Object.assign(new Event(type),{inputSource:source,frame}));
    toolbar.syncInput(frame);await settle();
    const plate=[...counters.highlights][0];
    expect(plate.visible).toBe(true);

    // A press that runs its course does activate the row: this is the control
    // the blurred case below is measured against.
    fire('selectstart');await settle();
    expect(consumed.map(entry=>entry.phase)).toEqual(['start']);
    fire('select');fire('selectend');await settle();
    expect(consumed.map(entry=>entry.phase)).toEqual(['start','end']);
    expect(ran).toHaveLength(1);

    // Now the same press, interrupted. The trigger goes down, the dialog
    // appears, and the release arrives only after the session is visible again.
    // The activated row redrew the panel, so take whichever plate is live now.
    const live=()=>[...counters.highlights].filter((entry:any)=>!entry.destroyed).pop();
    toolbar.syncInput(frame);await settle();
    const held=live();
    expect(held.visible).toBe(true);
    fire('selectstart');await settle();
    expect(consumed[consumed.length-1].phase).toBe('start');
    toolbar.blur();
    await settle();
    expect(consumed[consumed.length-1].phase).toBe('cancel');
    expect(held.visible).toBe(false);
    const updatesAtBlur=counters.highlightUpdates;
    const actionsAtBlur=actions.length;

    fire('select');fire('selectend');
    // Past TOOLBAR_PRESS_MS, so a press timer left armed would have redrawn.
    await new Promise(resolve=>setTimeout(resolve,220));
    await settle();
    expect(ran).toHaveLength(1);
    expect(actions).toHaveLength(actionsAtBlur);
    expect(counters.highlightUpdates).toBe(updatesAtBlur);
    expect(held.visible).toBe(false);
    expect(held.destroyed).toBe(false);

    // The menu is still usable when the wearer comes back to it.
    toolbar.syncInput(frame);await settle();
    expect(live().visible).toBe(true);
    await toolbar.dispose();
  }finally{
    if(previousDiagnostics===undefined)delete (globalThis as any).__stereofoldDiagnostics;
    else (globalThis as any).__stereofoldDiagnostics=previousDiagnostics;
  }
});

it('leaves the panel alone on a pose sync that does not move it',async()=>{
  const {createSpatialToolbar}=await toolbarRuntime();
  const {counters,presentation,frame,session}=harness();
  // `syncPose` runs on every immersive frame. Only a physical layout change
  // may rebuild from it, so 72 calls a second must cost nothing.
  const toolbar=createSpatialToolbar({plugin:{runTask:(task:any)=>task.run()},canvas:{},presentation,session,space:{},Mat4:{},
    getMolecularBounds:()=>({radius:10}),getDepthRange:()=>({})});
  await toolbar.update();
  const built=counters.constructed.length;
  for(let frameIndex=0;frameIndex<72;frameIndex++)await toolbar.syncPose();
  await settle();
  expect(counters.constructed.length).toBe(built);
  await toolbar.dispose();
});

it('cancels a queued menu action across blur even when focus returns before its frame', async () => {
  const {createSpatialToolbar} = await toolbarRuntime();
  const {presentation, frame, session} = harness();
  const calls: unknown[] = [];
  const toolbar = createSpatialToolbar({plugin:{runTask:(task:any)=>task.run()}, canvas:{}, presentation,
    session, space:{}, Mat4:{}, onAction:(action:any)=>{ calls.push(action); },
    getMolecularBounds:()=>({radius:10}), getDepthRange:()=>({})});
  await toolbar.update();
  const frames: Array<(time:number, frame:unknown)=>void> = [];
  session.requestAnimationFrame = callback => { frames.push(callback); return 1; };
  const action = {kind:'test-action'};
  toolbar.runAction(action);
  await Promise.resolve();
  expect(frames).toHaveLength(1);
  Object.assign(session, {visibilityState:'visible-blurred'});
  toolbar.blur();
  Object.assign(session, {visibilityState:'visible'});
  frames.shift()!(0, frame);
  await settle();
  expect(calls).toEqual([]);
  // A new visible action still works.
  toolbar.runAction(action);
  await Promise.resolve();
  frames.shift()!(0, frame);
  await settle();
  expect(calls).toEqual([action]);
  await toolbar.dispose();
});

it('does not dispatch voice or relight a hand hover under system UI', async () => {
  const {createSpatialToolbar} = await toolbarRuntime();
  const {counters, presentation, frame, session} = harness();
  const calls: unknown[] = [];
  const toolbar = createSpatialToolbar({plugin:{runTask:(task:any)=>task.run()}, canvas:{}, presentation,
    session, space:{}, Mat4:{}, onAction:(action:any)=>{ calls.push(action); },
    getMolecularBounds:()=>({radius:10}), getDepthRange:()=>({})});
  await toolbar.update();
  session.inputSources = [Object.assign(pointer(counters.labels[0].point), {handedness:'left'})];
  toolbar.syncInput(frame);
  await settle();
  expect(toolbar.isHandOnPanel('left')).toBe(true);
  Object.assign(session, {visibilityState:'hidden'});
  toolbar.blur();
  toolbar.syncInput(frame);
  toolbar.runAction({kind:'voice-toggle'});
  await settle();
  expect(calls).toEqual([]);
  expect(toolbar.isHandOnPanel('left')).toBe(false);
  expect([...counters.highlights].every(plate=>!plate.visible)).toBe(true);
  await toolbar.dispose();
});

it('keeps label layouts seated through status, hidden refreshes, and redraw removal', async () => {
  // @ts-ignore The real coalescer, with a hand-driven trailing-edge timer.
  const { createMenuResolve } = await import('../../lab/browser-roundtrip/menu-resolve.mjs');
  const { createSpatialToolbar } = await toolbarRuntime();
  const { counters, presentation, frame, session } = harness();
  const timers = new Map<number, () => void>(); let sequence = 0, rebuilds = 0;
  const layouts: string[] = [];
  const resolver = createMenuResolve({ solve: (reason: string) => { rebuilds++; layouts.push(reason); },
    now: () => 0, schedule: (fn: () => void) => { timers.set(++sequence, fn); return sequence; },
    cancel: (id: number) => timers.delete(id) });
  const flush = () => { const due = [...timers.values()]; timers.clear(); due.forEach(fn => fn()); };
  let ready = false, removedPoints: number[][] = [], state = {};
  const toolbar = createSpatialToolbar({ plugin: { runTask: (task: any) => task.run() }, canvas: {},
    presentation, session, space: {}, Mat4: {}, getState: () => state,
    getMolecularBounds: () => ({ radius: 10 }), getDepthRange: () => ({}),
    onRepresentationChange: (count: number) => {
      if (!ready) return;
      if (count === 0) removedPoints = toolbar.menuPoints();
      else resolver.moved({ points: toolbar.menuPoints(), reason: toolbar.menuMotion() });
    } });
  try {
    expect(toolbar.menuPoints()).toEqual([]);
    await toolbar.update(); ready = true;
    const seated = toolbar.menuPoints(); expect(seated.length).toBeGreaterThan(0);
    const glass = toolbar.platePoints(), initialAdds = presentation.adds.length,
      initialRemoves = presentation.removes.length, initialBuilds = counters.constructed.length;
    resolver.seed(seated);
    for (const line of ['Listening…', 'Smaller.', 'A full twelve word confirmation still leaves all these label plates seated.', '']) {
      await toolbar.setStatus(line); flush();
      expect(toolbar.menuPoints()).toEqual(seated);
      expect(removedPoints).toEqual([]);
      expect(toolbar.platePoints()).toEqual(glass);
      expect(presentation.adds.length).toBe(initialAdds);
      expect(presentation.removes.length).toBe(initialRemoves);
      expect(counters.constructed.length).toBe(initialBuilds);
    }
    expect(rebuilds).toBe(0); expect(layouts).toEqual([]);
    toolbar.setHidden(true);
    state = { subject: { title: 'A changed caption' } };
    await toolbar.update();
    expect(presentation.removes.length).toBeGreaterThan(initialRemoves);
    expect(removedPoints, 'a real geometry swap retains the reserved obstacle during removal').toEqual(seated);
    const hiddenRemoves = presentation.removes.length;
    await toolbar.setStatus('Smaller.'); flush();
    expect(presentation.removes.length, 'status on a hidden panel also avoids geometry churn').toBe(hiddenRemoves);
    expect(toolbar.menuPoints()).toEqual(seated);
    expect(toolbar.drawnMenuPoints()).toEqual([]);
    expect(rebuilds).toBe(0); expect(layouts).toEqual([]);
    toolbar.setHidden(false);
    frame.getViewerPose = () => ({ transform: { position: { x: 0.3, y: EYE[1], z: EYE[2] }, matrix: IDENTITY } });
    toolbar.unlatchSeat('menu'); await toolbar.update({ origin: 'wearer' });
    expect(toolbar.menuPoints()).not.toEqual(seated);
    expect(rebuilds).toBe(0); flush();
    expect(rebuilds).toBe(1); expect(layouts).toEqual(['reseat']);
    const moved = toolbar.menuPoints();
    toolbar.setHidden(true);
    frame.getViewerPose = () => ({ transform: { position: { x: 0.6, y: EYE[1], z: EYE[2] }, matrix: IDENTITY } });
    toolbar.unlatchSeat('menu'); await toolbar.update({ origin: 'wearer' }); flush();
    expect(toolbar.menuPoints()).toEqual(moved); expect(rebuilds).toBe(1);
    toolbar.setHidden(false); flush();
    expect(toolbar.menuPoints()).not.toEqual(moved);
    expect(rebuilds).toBe(2); expect(layouts).toEqual(['reseat', 'reseat']);
  } finally { resolver.dispose(); await toolbar.dispose(); }
  expect(toolbar.menuPoints()).toEqual([]);
});
