import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { PluginContext } from 'molstar/lib/mol-plugin/context.js';
import { DefaultPluginSpec } from 'molstar/lib/mol-plugin/spec.js';
import { StateTransforms } from 'molstar/lib/mol-plugin-state/transforms.js';
import { createStructureRepresentationParams } from 'molstar/lib/mol-plugin-state/helpers/structure-representation-params.js';
import { setCanvasModule } from 'molstar/lib/mol-geo/geometry/text/font-atlas.js';
import { Mat4 } from 'molstar/lib/mol-math/linear-algebra.js';
import { createInspectionState } from '../inspection-state.mjs';
import { createLessonFigure } from '../lesson-figure.mjs';
import { checkDrawnRecord, drawnRecordIsVisible } from '../drawn-record.mjs';
import { runTransitionTask } from '../scene-transition.mjs';
import { pageFunction } from './label-action-harness.mjs';
const viewer = readFileSync(process.env.APPEARANCE_VIEWER_SOURCE ?? new URL('../viewer.mjs', import.meta.url), 'utf8');
const noop = () => {};
export async function fixture(run, { coordinates, assemblyId } = {}) {
  const document = globalThis.document;
  globalThis.document = { addEventListener: noop, removeEventListener: noop, createElement: () => ({ setAttribute: noop }), head: { appendChild: noop, removeChild: noop } };
  setCanvasModule({ createCanvas: () => ({ getContext: () => ({ measureText: () => ({ width: 4 }), clearRect: noop, fillText: noop, getImageData: (_x, _y, w, h) => ({ data: new Uint8ClampedArray(w*h*4).fill(255) }) }) }) });
  const plugin = new PluginContext(DefaultPluginSpec());
  await plugin.init();
  const raw = await plugin.builders.data.rawData({data:coordinates ?? readFileSync(new URL('../../../fixtures/1CRN.cif',import.meta.url),'utf8')});
  const trajectory = await plugin.build().to(raw).apply(StateTransforms.Data.ParseCif).apply(StateTransforms.Model.TrajectoryFromMmCif).commit();
  const model = await plugin.build().to(trajectory).apply(StateTransforms.Model.ModelFromTrajectory,{modelIndex:0}).commit();
  const structure = await plugin.build().to(model).apply(StateTransforms.Model.StructureFromModel,{type:assemblyId ? {name:'assembly',params:{id:assemblyId}} : {name:'model',params:{}}}).commit();
  const representation = await plugin.build().to(structure).apply(StateTransforms.Representation.StructureRepresentation3D,createStructureRepresentationParams(plugin,structure.obj.data,{type:'spacefill',color:'uniform',typeParams:{quality:'low'}})).commit();
  const drawn = new Set([representation.obj.data.repr]), subscribers = new Set();
  let pending = false;
  const canvas = { xr:{isPresenting:{value:true}}, webgl:{isContextLost:false,extensions:{}}, camera:{getSnapshot:()=>({}),setState:noop},
    add:r=>drawn.add(r),remove:r=>drawn.delete(r),update:noop,mark:noop,syncVisibility:noop,commit:noop,setProps:noop,
    getRenderObjects:()=>[...drawn].flatMap(r=>r.renderObjects), reprCount:{get value(){return drawn.size;}},commitQueueSize:{value:0},
    didDraw:{subscribe(fn){subscribers.add(fn);return {unsubscribe:()=>subscribers.delete(fn)};}},
    requestDraw(){if(pending)return;pending=true;setImmediate(()=>{pending=false;c.state.drawCount++;for(const fn of [...subscribers])fn();});},
  };
  plugin.canvas3d=canvas;
  const inspectionState=createInspectionState(); inspectionState.configure({representation:'cartoon',color:'uniform',opacity:.02},'fixture');
  const lessonFigure=createLessonFigure({plugin,getStructure:()=>structure,getTransform:()=>Mat4.identity()});
  const c=vm.createContext({console,crypto,Error,setTimeout,clearTimeout,plugin,canvas,structure,representation,inspectionState,lessonFigure,
    GRABBABLE_STATUS:new Set(['ready','mutating']),StateTransforms,createStructureRepresentationParams,volume:undefined,busy:false,appearanceWork:undefined,activeWork:undefined,pendingContextLoss:undefined,retainedPoseHidden:false,builtRepresentation:'spacefill',appliedGeometryBudget:undefined,
    companionRecoveryActive:false,companionRecoveryPendingXr:false,companionRecord:undefined,ligandOverlay:undefined,stylesState:[],visibilityState:{},styleLayers:[],retainedRepresentationCount:0,
    state:{status:'ready',drawCount:0,revision:0,selectionKeys:[],mutationCounts:{inspection:0}},frameWaiters:new Set(),XR_FRAME_TIMEOUT_MS:1000,FRAME_TIMEOUT_MS:1000,
    immersiveSession:{syncBounds:noop},xrPresentationRepresentationCount:0,checkDrawnRecord,drawnRecordIsVisible,
    failure:(code,message)=>Object.assign(Error(message),{code}), assertContext:noop,
    inspectionSnapshot:()=>inspectionState.snapshot(),inspectionRepresentationName:noop,INSPECTION_COLORS:new Set(['uniform']),
    representationForBudget:r=>r,sessionDeviceClass:()=> 'quest2',currentXrSession:()=>({}), structureAtomSites:()=>structure.obj.data.elementCount,
    xrRepresentationQuality:()=> 'low',xrRepresentationMaterial:noop,xrColorParams:noop,xrBallAndStickParams:()=>({}),
    geometryFor:()=>({typeParams:{}}),geometryBudgetReceipt:()=>({}),Color:x=>x,colorNumber:v=>Number.parseInt(v.replace('#',''),16),now:()=>performance.now(),
    beginSceneTransition:()=>({firstFrame:noop,oldRemoved:noop,finish:noop}),VISIBILITY_LAYER_REF:{},prepareUploads:async()=>{},
    commitRepresentationUpdate:builder=>runTransitionTask(plugin.state.data.updateTree(builder,{revertOnError:true})),
    paintCompanion:async()=>{},rebuildLigandOverlay:async()=>{},ligandOverlayForBudget:noop,ligandAtomSites:()=>0,rebuildStyleLayers:async()=>{},
    currentEmphasisPlan:noop,currentSelectionPlan:noop,paintVisibilityLayers:async()=>{},markSelection:noop,applyInspectionTransform:noop,
    rebuildInspectionLabels:async()=>{},rebuildComponentLabels:async()=>{},recordCost:noop,refreshStructureSubject:noop,snapshot:()=>({}),
    scientificRepresentationCount:()=>1+c.retainedRepresentationCount+lessonFigure.count(),retainCurrent:()=>({structure,representation:c.representation}),
  });
  for(const name of ['beginWork','assertReady','canManipulateNow','applyInspectionAppearance','waitForFrame','canRebuildForXr','onXrPresented']) vm.runInContext(pageFunction(viewer,name),c);
  try { await run(c); } finally { await lessonFigure.forget();plugin.canvas3d=undefined;plugin.dispose();if(document===undefined)delete globalThis.document;else globalThis.document=document; }
}
