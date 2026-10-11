import { emptyLessonFigureBinding } from './empty-lesson-figure.mjs';
import test from 'node:test';
import { xrBallAndStickParams } from '../inspection-appearance.mjs';
import { xrColorParams } from '../xr-render-budget.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { pageFunction } from './label-action-harness.mjs';
import { normalizeAppearance, createInspectionState } from '../inspection-state.mjs';
import { normalizeStyles, applyScopedStyle } from '../inspection-styles.mjs';
import { geometryBudgetReceipt, requireGeometryBudget, structureGeometryCounts } from '../representation-budget.mjs';
import { liveEmphasisTargets, isStereofoldAuxiliaryCell } from '../representation-refs.mjs';
import { emptyVisibility, hiddenRowKeys, normalizeVisibility } from '../inspection-visibility.mjs';
import { composeOverpaintLayers, selectionOverpaintLayer } from '../selection-paint.mjs';
const viewer = readFileSync(new URL('../viewer.mjs', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

export function styleHarness() {
  const cells = new Map([['base', {}]]), built = [], deleted = [], marks = [], paints = [], budgets = [], events = [];
  const rows = Array.from({length:10000},(_,i)=>({key:`k${i}`,entityType:'polymer',coordinateState:'resolved',atomSites:Array(8).fill({}),
    identity:{modelNumber:1,labelChain:i<20?'A':'B',copyId:'1',componentId:'ALA'}}));
  const toData = keys => ({keys:[...keys], elementCount:keys.length*8,bondCount:keys.length*9,atomicResidueCount:keys.length});
  const data = toData(rows.map(row=>row.key));
  const tree = () => {
    let target;
    const ops=[];
    const builder = {
      to(ref) {target=ref;return builder;},
      delete(ref) {ops.push({ref,remove:true});return builder;},
      apply(type,params,{ref}) {ops.push({ref,type,params,target});return builder;},
      async commit() {
        for(const op of ops) {
          if(op.remove) {
            deleted.push(op.ref);
            for(const [ref,entry] of cells) if(ref===op.ref || entry.parent===op.ref) cells.delete(ref);
          } else {cells.set(op.ref,op);paints.push(plain(op));}
        }
      },
    }; return builder;
  };
  const inspectionState=createInspectionState();
  const context=vm.createContext({ ...emptyLessonFigureBinding(),
    // This fixture does not paint, so drawing the selection costs it
    // nothing. `render-dedupe-harness.mjs` is the one that counts paints, and
    // its stub runs the real emphasis pass.
    currentSelectionPlan: () => undefined,
    async paintSelectionOverlay() {},
    composeOverpaintLayers, selectionOverpaintLayer,
    xrBallAndStickParams, xrColorParams, normalizeAppearance,normalizeStyles,inspectionState,geometryBudgetReceipt,liveEmphasisTargets,
    emptyVisibility,hiddenRowKeys,normalizeVisibility,
    companionRecord:undefined,stylesState:[],styleLayers:[],visibilityState:emptyVisibility(),volume:null,
    state:{selectionKeys:['k0','k20']},structure:{ref:'structure',obj:{data}},representation:{ref:'base'},ligandOverlay:null,
    selection:{rows,toLoci:keys=>({keys:[...keys],structure:data})},
    selectedKeys:keys=>{if(keys.some(key=>!data.keys.includes(key))) throw Error('Unknown canonical key'); return [...keys];},
    StructureElement:{Loci:{isEmpty:loci=>!loci.keys.length,toStructure:loci=>toData(loci.keys),
      remap:(loci,target)=>({keys:loci.keys.filter(key=>target.keys.includes(key)),structure:target})},
      Bundle:{fromLoci:loci=>({keys:[...loci.keys]})}},
    StructureSelection:{Singletons:(_root,subset)=>subset},
    plugin:{state:{data:{cells,updateCellState(){}}},build:tree,
      representation:{structure:{registry:{get:()=>({isApplicable:()=>true})}}},
      builders:{structure:{
        async tryCreateComponentFromSelection(_root,query,key,options) {
          const data=await query.getSelection(); const ref=key;
          const component={ref,obj:{data}}; cells.set(ref,{parent:'structure',tags:options.tags});
          built.push({ref,keys:data.keys,tags:options.tags}); events.push('component'); return component;
        },
        representation:{async addRepresentation(component,params) {
          const ref=component.ref+'-repr'; cells.set(ref,{parent:component.ref});
          const repr={ref,obj:{data:{repr:{state:{visible:true},renderObjects:[]}}}};
          built.at(-1).params=plain(params); events.push('representation'); return repr;
        }},
      }}},
    inspectionSnapshot:()=>inspectionState.snapshot(),
    geometryFor:(representation,data)=>{
      const input={representation,...structureGeometryCounts(data),deviceClass:'quest2',presenting:true,quality:'lower'};
      budgets.push(input);return requireGeometryBudget(input);
    },
    xrRepresentationQuality:()=> 'lower', xrRepresentationMaterial:()=>null,
    Color:value=>value,colorNumber:value=>parseInt(value.slice(1),16),
    canvas:{xr:{isPresenting:{value:true}},mark:({loci},action)=>marks.push({keys:[...(loci.keys??[])],action})},
    EveryLoci:{keys:[]},MarkerAction:{Deselect:'clear',Select:'select'},
    SCENE_VISIBILITY_LAYER_REF:'hidden',StateTransforms:{Representation:{TransparencyStructureRepresentation3DFromBundle:'transparency'}},
    appliedGeometryBudget:undefined,assertReady(){},assertContext(){},dropDeadOverlayRefs(){},
    syncInspectionPayload:()=>inspectionState.setPayload({styles:plain(context.stylesState)}),
    inspectionMutation:async operation=>{await operation();events.push('frame');},
    currentEmphasisPlan:()=>({}),paintEmphasisLayers:async()=>events.push('emphasis'),
    markRecord:(_record,keys)=>marks.push({keys:[...keys],action:'base'}),retainCurrent:()=>({}),
    rebuildInspectionLabels:async()=>events.push('labels'),rebuildComponentLabels:async()=>events.push('plates'),
    applyInspectionTransform:()=>events.push('placement'),
  });
  context.sceneGeometry = plans => [{}, ...plans.map(plan => context.geometryFor(plan.look.representation, plan.data))];
  context.applyInspectionAppearance = async () => {
    await context.rebuildStyleLayers(); await context.paintEmphasisLayers(context.currentEmphasisPlan());
    await context.paintVisibilityLayers(); context.markSelection(context.state.selectionKeys);
    await context.rebuildInspectionLabels(); await context.rebuildComponentLabels(); context.applyInspectionTransform();
  };
  for(const name of ['savedStyles','styleLayerTargets','styleLayerDefinitions','styleLayerPlans','rebuildStyleLayers','setSceneStyles',
    'hiddenSceneKeys','hiddenSceneKeySet','paintVisibilityLayers','markSelection']) vm.runInContext(pageFunction(viewer,name),context);
  const set=styles=>{context.requested=styles;return vm.runInContext('setSceneStyles(requested)',context);};
  return {context,cells,built,deleted,marks,paints,budgets,events,set};
}

