import { emptyLessonFigureBinding } from './fixtures/empty-lesson-figure.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { pageFunction } from './fixtures/label-action-harness.mjs';
import { styleHarness } from './fixtures/style-layer-harness.mjs';
import { checkDrawnRecord, drawnRecordIsVisible } from './drawn-record.mjs';
import { createInspectionState } from './inspection-state.mjs';
import { createGesturePivot } from './gesture-pivot.mjs';
import * as visibility from './inspection-visibility.mjs';
import * as budgets from './representation-budget.mjs';
import { representationQualityFor } from './xr-render-budget.mjs';
import { normalizeStyles } from './inspection-styles.mjs';
const source=readFileSync(process.env.COMBINED_VIEWER_SOURCE ?? new URL('./viewer.mjs',import.meta.url),'utf8');
const plain=value=>JSON.parse(JSON.stringify(value));
const companion={source:{kind:'pdb',id:'2HHB'},sourceSha256:'a'.repeat(64),modelNumber:1,assemblyId:'asymmetric_unit',
  appearance:{representation:'cartoon',color:'uniform',uniformColor:'#e6a04b',opacity:1},
  placement:{translation:[2,0,0],rotation:[0,0,0],scale:1}};
function install(context,names) {for(const name of names) vm.runInContext(pageFunction(source,name),context);}
function record(ref) {
  const object={values:{drawCount:{ref:{value:3}},instanceCount:{ref:{value:1}}}};
  return {structure:{checkValid(){}},representation:{ref,checkValid(){},obj:{data:{repr:{state:{visible:true},renderObjects:[object]}}}}};
}

test('a receipt waits for both structures and every style layer, including visible nonempty geometry',async()=>{
  const primary=record('primary'), pair=record('pair'), layers=[record('style-1'),record('style-2')];
  const all=[primary,pair,...layers], objects=all.map(r=>r.representation.obj.data.repr.renderObjects[0]);
  let drawn=[],listener;
  const cells=new Map(all.map(r=>[r.representation.ref,{}]));
  const context=vm.createContext({ ...emptyLessonFigureBinding(),
    // This fixture does not paint, so drawing the selection costs it
    // nothing. `render-dedupe-harness.mjs` is the one that counts paints, and
    // its stub runs the real emphasis pass.
    currentSelectionPlan: () => undefined,
    async paintSelectionOverlay() {},
    composeOverpaintLayers, selectionOverpaintLayer,
    ...primary,companionRecord:pair,styleLayers:layers,inspectionState:{},inspectionLabel:undefined,ligandOverlay:undefined,
    plugin:{state:{data:{cells}}},componentLabelRepresentations:()=>[],checkDrawnRecord,drawnRecordIsVisible,
    state:{drawCount:0},frameWaiters:new Set(),immersiveSession:undefined,xrPresentationRepresentationCount:0,retainedRepresentationCount:0,
    FRAME_TIMEOUT_MS:1000,XR_FRAME_TIMEOUT_MS:1000,now:()=>performance.now(),setTimeout,clearTimeout,assertContext(){},failure:(_code,text)=>Error(text),
    canvas:{xr:{isPresenting:{value:false}},getRenderObjects:()=>drawn,reprCount:{value:4},commitQueueSize:{value:0},
      didDraw:{subscribe(fn){listener=fn;return {unsubscribe(){listener=undefined;}};}},requestDraw(){}},
  });
  install(context,['scientificRepresentationCount','waitForFrame']);
  assert.equal(context.scientificRepresentationCount(),4);
  let settled=false;
  const waiting=context.waitForFrame(primary).then(()=>{settled=true;});
  const frame=async()=>{context.state.drawCount++;listener?.();await Promise.resolve();};
  for(const missing of objects) {
    drawn=objects.filter(o=>o!==missing);await frame();assert.equal(settled,false);
  }
  drawn=objects;
  pair.representation.obj.data.repr.state.visible=false;await frame();assert.equal(settled,false);
  pair.representation.obj.data.repr.state.visible=true;
  layers[1].representation.obj.data.repr.renderObjects=[];await frame();assert.equal(settled,false);
  layers[1].representation.obj.data.repr.renderObjects=[objects[3]];
  objects[3].values.drawCount.ref.value=0;await frame();assert.equal(settled,false);
  objects[3].values.drawCount.ref.value=3;await frame();await waiting;
  assert.equal(settled,true);assert.equal(context.frameWaiters.size,0);
});

test('combined style painting preserves hidden keys and never paints or selects the comparison',async()=>{
  const h=styleHarness();const c=h.context;
  c.companionRecord=record('pair');h.cells.set('pair',{});
  c.sceneGeometry=plans=>[{}, {}, ...plans.map(p=>c.geometryFor(p.look.representation,p.data))];
  c.visibilityState={hiddenChains:[{labelChain:'A',copyId:'1'}],hiddenClasses:[],showOnlySelection:true};
  await h.set([{selectionKeys:['k0','k20','k21'],representation:'ball-and-stick',color:'uniform',uniformColor:'#ff8800'},
    {selectionKeys:['k22'],representation:'spacefill'}]);
  const paints=h.paints.filter(p=>p.target==='stereofold-scoped-style-0-repr');
  assert.deepEqual(paints.at(-1).params.layers.at(-1).bundle.keys,['k0','k21']);
  assert.ok(!h.paints.some(p=>p.target==='pair'));
  assert.ok(!h.marks.some(m=>m.action==='select' && m.keys.some(k=>['k0','k21','k22'].includes(k))));
  // Execute primary emphasis painting with a real key too, not just transparency.
  Object.assign(c,{now:()=>0,recordCost(){},mergeEmphasisColourLayers:v=>v,EMPHASIS_LAYER_REF:'emphasis'});
  c.StateTransforms.Representation.OverpaintStructureRepresentation3DFromBundle='overpaint';
  install(c,['paintEmphasisLayers','scientificRepresentations']);
  c.inspectionLabel=undefined;
  await c.paintEmphasisLayers({colours:[{keys:['k0','k20'],color:'#112233'}],faded:[],lit:[],transparency:0.5});
  assert.ok(h.paints.some(p=>p.type==='overpaint' && p.target==='base'));
  assert.ok(!h.paints.some(p=>p.target==='pair'));
  assert.ok(!c.scientificRepresentations().includes(c.companionRecord.representation.obj.data.repr));
});

test('production geometry advisory accounts for primary, comparison and style meshes without reducing detail',()=>{
  const h=styleHarness();const c=h.context;
  Object.assign(c,{appearanceWork:undefined,busy:true,retainedPoseHidden:false,...budgets,builtRepresentation:'cartoon',currentXrSession:()=>null,sessionDeviceClass:()=> 'quest2',isStandaloneHmdAgent:()=>false});
  c.structure.obj.data.atomicResidueCount=7000;c.structure.obj.data.elementCount=56000;c.structure.obj.data.bondCount=63000;
  c.companionRecord={companionState:companion,structure:{obj:{data:{elementCount:8000,bondCount:9000,atomicResidueCount:1000}}}};
  install(c,['sceneGeometryEntries','sceneGeometry','comparisonGeometry','geometryFor']);
  const style={selectionKeys:Array.from({length:40},(_,i)=>'k'+i),representation:'ball-and-stick'};
  c.stylesState=[style];
  const plans=c.styleLayerPlans();
  assert.equal(plans[0].data.elementCount,320);
  const decisions=c.comparisonGeometry(c.companionRecord);
  assert.equal(decisions.length,3);
  assert.ok(decisions.every(d=>d.atoms===64320));
  assert.ok(decisions.every(d=>d.level===decisions[0].level));
  const entries=[{representation:'cartoon',atoms:56000,bonds:63000,residues:7000},
    {representation:'cartoon',atoms:8000,bonds:9000,residues:1000},
    {representation:'ball-and-stick',atoms:320,bonds:360,residues:40}];
  const fraction=entries.reduce((sum,e)=>sum+budgets.estimateRepresentation({...e,level:decisions[0].level}).vertices/budgets.REPRESENTATION_BUDGETS.quest2[e.representation],0);
  assert.equal(decisions[0].estimatedVertices,Math.ceil(fraction*decisions[0].budget));assert.ok(fraction>1);
  assert.ok(decisions.every(d=>d.status==='advisory' && d.level==='lower' && Object.keys(d.typeParams).length===0));
  // Each input passes alone and the pair passes together, but the full scene
  // exceeds the SAME allowance at lowest detail before any component is built.
  c.stylesState=[{selectionKeys:Array.from({length:400},(_,i)=>'k'+i),representation:'ball-and-stick'}];
  assert.doesNotThrow(()=>budgets.requireComparisonGeometryBudget(entries[0],entries[1],{presenting:true,deviceClass:'quest2',quality:'lower'}));
  assert.doesNotThrow(()=>budgets.requireGeometryBudget({representation:'ball-and-stick',atoms:3200,bonds:3600,residues:400,presenting:true,deviceClass:'quest2',quality:'lower'}));
  assert.doesNotThrow(()=>c.styleLayerPlans());
  assert.ok(c.comparisonGeometry(c.companionRecord).every(d=>d.status==='advisory' && d.level==='lower' && Object.keys(d.typeParams).length===0));
  assert.equal(h.built.length,0);assert.equal(h.deleted.length,0);
});

test('a global lesson figure shares the allowance with even a translucent base and scoped meshes',()=>{
  const h=styleHarness(), c=h.context;
  Object.assign(c,{...budgets,currentXrSession:()=>null,sessionDeviceClass:()=> 'quest2',isStandaloneHmdAgent:()=>false});
  c.structure.obj.data.elementCount=4500;c.structure.obj.data.bondCount=5600;c.structure.obj.data.atomicResidueCount=600;
  c.inspectionState.configure({representation:'ball-and-stick',opacity:.02});
  c.companionRecord=undefined;c.stylesState=[];
  const figureEntry={representation:'ball-and-stick',atoms:320,bonds:360,residues:40};
  c.lessonFigure.geometryEntries=()=>[figureEntry];
  install(c,['sceneGeometryEntries','sceneGeometry','comparisonGeometry','geometryFor']);
  assert.doesNotThrow(()=>budgets.requireGeometryBudget({representation:'ball-and-stick',atoms:4500,bonds:5600,residues:600,presenting:true,deviceClass:'quest2',quality:'lower'}));
  assert.doesNotThrow(()=>budgets.requireGeometryBudget({...figureEntry,presenting:true,deviceClass:'quest2',quality:'lower'}));
  assert.equal(c.geometryFor('ball-and-stick').status,'advisory');
  assert.equal(c.geometryFor('ball-and-stick').level,'lower');
  assert.deepEqual(c.geometryFor('ball-and-stick').typeParams,{});
  c.structure.obj.data.elementCount=2000;c.structure.obj.data.bondCount=2200;
  const decisions=c.sceneGeometry([]);
  assert.equal(decisions.length,2);
  assert.equal(decisions[0].level,decisions[1].level);
  assert.equal(decisions[0].atoms,2320);
  assert.equal(h.built.length,0);assert.equal(h.deleted.length,0);
});

function historyHarness() {
  const state=createInspectionState();
  const camera={position:[0,0,80]};
  const c=vm.createContext({ ...emptyLessonFigureBinding(),
    gesturePivot:createGesturePivot(),focusPivotRequest:undefined,xrPlacementFollowup:undefined,talkCaption:undefined,
    // This fixture does not paint, so drawing the selection costs it
    // nothing. `render-dedupe-harness.mjs` is the one that counts paints, and
    // its stub runs the real emphasis pass.
    currentSelectionPlan: () => undefined,
    async paintSelectionOverlay() {},
    composeOverpaintLayers, selectionOverpaintLayer,...visibility,normalizeStyles,inspectionState:state,stylesState:[],styleLayers:[],visibilityState:visibility.emptyVisibility(),
    state:{selectionKeys:['a']},desktopPreviewCamera:null,volume:null,selection:{rows:[]},
    assertReady(){},cameraSnapshot:v=>structuredClone(v),selectedKeys:v=>[...v],inspectionSnapshot:()=>state.snapshot(),
    canvas:{camera:{getSnapshot:()=>camera,setState(){}}},lessonMotionHold:{release(){}},
    markSelection:keys=>{c.state.selectionKeys=[...keys];},
    inspectionMutation:async fn=>{await fn();c.syncInspectionPayload();},
    mutate:async(_kind,fn)=>{await fn();},paintVisibilityLayers:async()=>{},rebuildInspectionLabels:async()=>{},rebuildComponentLabels:async()=>{},
    applyInspectionAppearance:async()=>{},applyInspectionTransform(){},restoreCompanion:async value=>{c.drawnCompanion=value;},snapshot:()=>state.snapshot(),
  });
  install(c,['cancelXrPlacementFollowup','invalidateGesturePivot'].filter(name=>source.includes(`function ${name}(`)));
  install(c,['inspectionPayload','savedStyles','savedVisibility','restoreInspectionPayload',
    'undoInspection','redoInspection','saveInspectionView','restoreInspectionView','setSceneVisibility','visibilityChains']);
  c.syncInspectionPayload=()=>state.setPayload(c.inspectionPayload());
  return c;
}

test('local undo, redo and named views restore visibility, styles and companion together',async()=>{
  const c=historyHarness(),s=c.inspectionState;
  c.syncInspectionPayload();s.beginGroup('combined');
  s.setCompanion(companion);c.stylesState=[{selectionKeys:['a'],representation:'ball-and-stick'}];
  await c.setSceneVisibility({hiddenChains:[],hiddenClasses:['water'],showOnlySelection:true});
  s.endGroup();
  const combined=plain(c.inspectionPayload());
  assert.equal(s.snapshot().history.undoCount,1);
  const saved=await c.saveInspectionView('Combined');
  await c.undoInspection();assert.deepEqual(plain(c.stylesState),[]);assert.deepEqual(plain(c.visibilityState),visibility.emptyVisibility());assert.equal(c.drawnCompanion,undefined);
  await c.redoInspection();assert.deepEqual(plain(c.inspectionPayload()),combined);assert.deepEqual(plain(c.drawnCompanion),companion);
  await c.setSceneVisibility(visibility.emptyVisibility());
  assert.equal(s.snapshot().history.undoCount,2);
  await c.undoInspection();assert.deepEqual(plain(c.inspectionPayload()),combined);
  await c.undoInspection();await c.restoreInspectionView(saved.id);
  assert.deepEqual(plain(c.inspectionPayload()),combined);assert.deepEqual(plain(c.drawnCompanion),companion);
});

import { harness as mutationHarness } from './render-dedupe-harness.mjs';
import { applyCompoundChange } from './compound-change.mjs';
import { geometryBudgetChanged } from './geometry-advisory.mjs';
import { createNamedPublication } from '../inspection/named-publication.mjs';
import { interruptibleCommand } from '../inspection/interruptible-command.mjs';
import { composeOverpaintLayers, selectionOverpaintLayer } from './selection-paint.mjs';
test('production workspace dispatch stages seven fields and returns their geometry only after one rendered frame',async()=>{
  const h=mutationHarness(),c=h.context, key=h.rows[0].key;
  const before=c.inspectionState.checkpoint();
  const payload=c.inspectionPayload;
  c.inspectionPayload=()=>({...payload(),styles:plain(c.stylesState),visibility:plain(c.visibilityState)});
  c.restoreCompanion=async value=>{c.companionRecord=value?{companionState:value}:undefined;};
  c.paintVisibilityLayers=async()=>{};
  const geometry={message:'Combined scene within budget',atoms:64320,estimatedVertices:248000,budget:300000};
  const original=c.applyInspectionAppearance;
  c.applyInspectionAppearance=async options=>{
    assert.equal(c.stylesState.length,1);assert.equal(c.visibilityState.showOnlySelection,true);
    assert.equal(c.inspectionSnapshot().companionStructure.sourceSha256,companion.sourceSha256);
    assert.equal(c.inspectionSnapshot().appearance.opacity,0.6);
    await original(options);
  };
  const ops=[{kind:'appearance',patch:{opacity:0.6}},
    {kind:'styles',patch:{styles:[{selectionKeys:[key],representation:'ball-and-stick',color:'uniform',uniformColor:'#ff8800'}]}},
    {kind:'placement',patch:{scale:1.5}},{kind:'selection',patch:{selectionKeys:[key]}},
    {kind:'emphasis',patch:{parts:[],focus:[],contextOpacity:0.2}},
    {kind:'visibility',patch:{hiddenChains:[],hiddenClasses:['water'],showOnlySelection:true}},
    {kind:'companion-structure',patch:companion}];
  const publications=[];
  const viewer={snapshot:()=>({applied:{geometryBudget:geometry}}),inspection:{capture:()=>({inspection:{...c.inspectionSnapshot(),...c.inspectionPayload()}}),
    beginOperation(action){assert.equal(action,'interruption-checkpoint');return undefined;},compound:h.compound}};
  const workspace=readFileSync(new URL('../inspection/workspace.mjs',import.meta.url),'utf8');
  const body=workspace.slice(workspace.indexOf('  applyRemote:')+'  applyRemote:'.length,workspace.lastIndexOf('\n});')).trim().replace(/,$/,'');
  const remote=new Function('run','namedPublication','interruptibleCommand','viewer','applyCompoundChange','geometryBudgetChanged',`return (${body});`)(
    async(_text,fn)=>fn(),createNamedPublication(value=>publications.push(value)),interruptibleCommand,viewer,applyCompoundChange,geometryBudgetChanged);
  let release,confirmed=0;
  h.gateFrame(new Promise(resolve=>{release=resolve;}));
  const pending=remote({kind:'compound',patch:{ops}},async()=>{},async(scene,applied)=>{
    confirmed++;assert.equal(h.counts.frames,1);assert.deepEqual(applied.geometryBudget,geometry);
    assert.equal(scene.inspection.styles.length,1);assert.equal(scene.inspection.visibility.showOnlySelection,true);
    assert.deepEqual(scene.inspection.companionStructure,companion);
  });
  await new Promise(resolve=>setImmediate(resolve));assert.equal(confirmed,0);release();await pending;
  assert.equal(confirmed,1);assert.equal(h.counts.frames,1);assert.equal(h.counts.commits,1);
  assert.equal(c.inspectionState.snapshot().history.undoCount,before.undo.length+1);
  const previous=c.inspectionState.undo();assert.equal(previous.companionStructure,undefined);assert.equal(previous.appearance.opacity,1);
  assert.deepEqual(c.inspectionState.payload().styles,[]);
});

test('compound placement saves the fitted transform and reports its adjustment after rendering',async()=>{
  const h=mutationHarness(),c=h.context, outcomes=[];
  c.applyInspectionAppearance=async()=>{ c.inspectionState.place({translation:[.6,0,-2],scale:1.5}); };
  c.recordManipulation=(kind,detail)=>outcomes.push({kind,...detail});
  await h.compound({kind:'compound',patch:{ops:[
    {kind:'appearance',patch:{opacity:.6}},
    {kind:'placement',patch:{translation:[-.6,0,-2],scale:2}},
  ]}});
  assert.deepEqual(plain(c.inspectionSnapshot().placement.translation),[.6,0,-2]);
  assert.equal(c.inspectionSnapshot().placement.scale,1.5);
  assert.ok(outcomes.some(entry=>entry.kind==='outcome'&&entry.status==='adjusted'&&entry.action==='compound'));
});

test('source replacement retains comparison and styles through the first candidate frame, then removes them before completion',async()=>{
  const previous={...record('old'),companionRecord:record('pair'),styleLayers:[record('style-1'),record('style-2')]};
  const candidate={...record('new'),selectionKeys:[]};
  const removed=[],shown=[];let frames=0;
  const c=vm.createContext({ ...emptyLessonFigureBinding(),
    // This fixture does not paint, so drawing the selection costs it
    // nothing. `render-dedupe-harness.mjs` is the one that counts paints, and
    // its stub runs the real emphasis pass.
    currentSelectionPlan: () => undefined,
    async paintSelectionOverlay() {},
    now:()=>0,recordCost(){},
    composeOverpaintLayers, selectionOverpaintLayer,state:{},retainedRepresentationCount:0,styleLayers:previous.styleLayers,assertLoad(){},markRecord(){},checkpoint:async()=>{},
    plugin:{state:{data:{updateCellState:ref=>shown.push(ref)}}},
    canvas:{xr:{isPresenting:{value:true}},remove:repr=>removed.push(repr),commit(){}},
    waitForFrame:async received=>{
      assert.equal(received,candidate);assert.deepEqual(plain(c.styleLayers),[]);
      if (++frames === 1) { assert.deepEqual(removed,[]);assert.equal(c.retainedRepresentationCount,4); }
      else {
        assert.deepEqual(new Set(removed),new Set([previous,previous.companionRecord,...previous.styleLayers].map(r=>r.representation.obj.data.repr)));
        assert.equal(c.retainedRepresentationCount,0);
      }
    }});
  install(c,['showCandidate']);
  await c.showCandidate(candidate,previous,{preserveRoomPlacement:true},{});
  assert.equal(frames,2);
  assert.deepEqual(shown,['new']);assert.equal(previous.styleLayers.length,2,'rollback retains the original refs');
});


test('show-only selection moves its visible highlight to the new keys while a comparison stays untouched',async()=>{
  const h=styleHarness(),c=h.context;
  c.companionRecord=record('pair');c.sceneGeometry=plans=>[{}, {}, ...plans.map(p=>c.geometryFor(p.look.representation,p.data))];
  c.visibilityState={hiddenChains:[],hiddenClasses:[],showOnlySelection:true};
  await h.set([{selectionKeys:['k0','k20','k21'],representation:'ball-and-stick'}]);
  h.marks.length=0;c.markSelection(['k21']);await c.paintVisibilityLayers();
  assert.ok(h.marks.some(m=>m.action==='select' && m.keys.join(',')==='k21'));
  assert.deepEqual(h.paints.filter(p=>p.target==='stereofold-scoped-style-0-repr').at(-1).params.layers.at(-1).bundle.keys,['k0','k20']);
});

test('production appearance rebuild keeps the comparison look and applies the shared geometry tier to every mesh',async()=>{
  const h=styleHarness(),c=h.context,updates=[];
  c.inspectionState.configure({color:'uniform',uniformColor:'#112233',opacity:0.7});
  c.structure.obj.data.atomicResidueCount=7000;
  c.stylesState=[{selectionKeys:Array.from({length:40},(_,i)=>'k'+i),representation:'ball-and-stick',color:'uniform',uniformColor:'#ff8800'}];
  c.visibilityState={hiddenChains:[{labelChain:'A',copyId:'1'}],hiddenClasses:[],showOnlySelection:false};
  const updater=target=>params=>({commit:async()=>{updates.push({target,params:plain(params)});}});
  c.representation.update=updater('primary');
  c.representation.cell={params:{values:{type:'cartoon'}}};
  c.companionRecord={companionState:{...companion,appearance:{...companion.appearance,opacity:0.4}},
    structure:{obj:{data:{elementCount:8000,bondCount:9000,atomicResidueCount:1000}}},
    representation:{update:updater('companion')}};
  Object.assign(c,{appearanceWork:undefined,busy:true,retainedPoseHidden:false,...budgets,builtRepresentation:'cartoon',currentXrSession:()=>null,sessionDeviceClass:()=> 'quest2',isStandaloneHmdAgent:()=>false,
    inspectionRepresentationName(){},INSPECTION_COLORS:new Set(['uniform']),representationForBudget:name=>name,
    structureAtomSites:()=>80000,xrColorParams:()=>null,createStructureRepresentationParams:(_p,_d,params)=>params,
    now:()=>0,recordCost(){},commitRepresentationUpdate:builder=>builder.commit({revertOnError:true}),
    rebuildLigandOverlay:async()=>{},ligandOverlayForBudget:()=>undefined,ligandAtomSites:()=>0});
  c.canvas.camera={getSnapshot:()=>({position:[0,0,80]}),setState(){}};c.canvas.setProps=()=>{};
  install(c,['geometryFor','comparisonGeometry','sceneGeometryEntries','sceneGeometry','paintCompanion','applyInspectionAppearance']);
  await c.applyInspectionAppearance();
  assert.deepEqual(updates.map(u=>[u.target,u.params.type,u.params.typeParams.alpha,u.params.colorParams.value]),
    [['primary','cartoon',0.7,0x112233],['companion','cartoon',0.4,0xe6a04b]]);
  const expected=c.comparisonGeometry(c.companionRecord);
  assert.deepEqual(updates[0].params.typeParams,{alpha:0.7,quality:'lower',...expected[0].typeParams});
  assert.deepEqual(updates[1].params.typeParams,{alpha:0.4,quality:'lower',...expected[1].typeParams});
  assert.deepEqual(h.built[0].params.typeParams,{alpha:0.7,quality:'lower',...expected[2].typeParams,sizeFactor:0.26,sizeAspectRatio:0.75});
  assert.equal(h.built[0].params.colorParams.value,0xff8800);
  assert.equal(c.appliedGeometryBudget.atoms,88320);
  assert.ok(h.paints.some(p=>p.target==='stereofold-scoped-style-0-repr' && p.params.layers.at(-1).bundle.keys.includes('k0')));
});

test('an unbounded headset rebuilds the comparison at its own quality tier, with no budget receipt',async()=>{
  // Quest 3 has a `medium` tier and no measured geometry ceiling. The scene
  // budget leaves detail alone there and returns no typeParams, so the
  // companion has to carry the tier itself or Mol* rebuilds it at `auto`.
  const h=styleHarness(),c=h.context,updates=[];
  c.inspectionState.configure({color:'uniform',uniformColor:'#112233'});
  c.stylesState=[{selectionKeys:['k0','k1'],representation:'ball-and-stick',color:'uniform',uniformColor:'#ff8800'}];
  const updater=target=>params=>({commit:async()=>{updates.push({target,params:plain(params)});}});
  c.representation.update=updater('primary');
  c.representation.cell={params:{values:{type:'cartoon'}}};
  c.companionRecord={companionState:companion,structure:{obj:{data:{elementCount:8000,bondCount:9000,atomicResidueCount:1000}}},
    representation:{update:updater('companion')}};
  Object.assign(c,{appearanceWork:undefined,busy:true,retainedPoseHidden:false,...budgets,builtRepresentation:'cartoon',currentXrSession:()=>null,sessionDeviceClass:()=>'quest3',isStandaloneHmdAgent:()=>true,
    xrRepresentationQuality:({presenting})=>presenting?representationQualityFor(c.sessionDeviceClass()):null,
    inspectionRepresentationName(){},INSPECTION_COLORS:new Set(['uniform']),representationForBudget:name=>name,
    structureAtomSites:()=>80000,xrColorParams:()=>null,createStructureRepresentationParams:(_p,_d,params)=>params,
    now:()=>0,recordCost(){},commitRepresentationUpdate:builder=>builder.commit({revertOnError:true}),
    rebuildLigandOverlay:async()=>{},ligandOverlayForBudget:()=>undefined,ligandAtomSites:()=>0});
  c.canvas.camera={getSnapshot:()=>({position:[0,0,80]}),setState(){}};c.canvas.setProps=()=>{};
  install(c,['geometryFor','comparisonGeometry','sceneGeometryEntries','sceneGeometry','paintCompanion','applyInspectionAppearance']);
  await c.applyInspectionAppearance();
  assert.deepEqual(updates.map(u=>u.target),['primary','companion']);
  for(const update of updates) {
    assert.equal(update.params.typeParams.quality,'medium',update.target);
    assert.equal(update.params.typeParams.tryUseImpostor,undefined,update.target);
  }
  assert.equal(c.appliedGeometryBudget,undefined);
});

test('a shared named-scene restore records the outgoing styles and visibility for local undo',async()=>{
  const c=historyHarness(),s=c.inspectionState,empty=s.snapshot();
  c.syncInspectionPayload();s.setCompanion(companion);c.stylesState=[{selectionKeys:['a'],representation:'ball-and-stick'}];
  await c.setSceneVisibility({hiddenChains:[],hiddenClasses:['water'],showOnlySelection:true});
  const before=plain(c.inspectionPayload());
  Object.assign(c,{validInspectionCapture:value=>({...value,keys:value.selectionKeys}),
    wearerPlacement:{holdsPlacement:()=>false},fitDesktopPreview(){}});
  install(c,['restoreInspection']);
  await c.restoreInspection({selectionKeys:[],camera:{position:[0,0,80]},inspection:{appearance:empty.appearance,placement:empty.placement}});
  assert.equal(c.drawnCompanion,undefined);assert.deepEqual(plain(c.stylesState),[]);
  await c.undoInspection();assert.deepEqual(plain(c.inspectionPayload()),before);assert.deepEqual(plain(c.drawnCompanion),companion);
});

test('source rollback restores the old appearance before admitting the retained comparison and styles',async()=>{
  const inspectionState=createInspectionState();inspectionState.configure({opacity:0.3});
  const checkpoint=inspectionState.checkpoint();inspectionState.configure({opacity:0.9});
  const previous={styles:[{selectionKeys:['a'],representation:'ball-and-stick'}],visibility:{hiddenChains:[],hiddenClasses:['water'],showOnlySelection:false}};
  const c=vm.createContext({ ...emptyLessonFigureBinding(),
    // This fixture does not paint, so drawing the selection costs it
    // nothing. `render-dedupe-harness.mjs` is the one that counts paints, and
    // its stub runs the real emphasis pass.
    currentSelectionPlan: () => undefined,
    async paintSelectionOverlay() {},
    composeOverpaintLayers, selectionOverpaintLayer,inspectionState,normalizeStyles,...visibility,retainedRepresentationCount:0,state:{status:'loading',contextLossCount:0},
    representation:undefined,canvas:{webgl:{isContextLost:false},camera:{scale:1},commit(){}},deleteRecord:async()=>{},adopt(record){c.representation=record.representation;},
    restoreRecord:async()=>assert.equal(inspectionState.snapshot().appearance.opacity,0.3),
    applyInspectionAppearance:async()=>{},waitForFrame:async()=>{},removeFrameCover(){},stylesState:[],visibilityState:visibility.emptyVisibility()});
  install(c,['rollbackLoad']);
  await c.rollbackLoad({previous,inspectionCheckpoint:checkpoint,contextLossCount:0,cameraScale:1},Error('candidate failed'));
  assert.deepEqual(plain(c.stylesState),previous.styles);assert.deepEqual(plain(c.visibilityState),previous.visibility);
  assert.equal(c.state.status,'ready');assert.equal(c.state.lastLoadFailure.recovered,true);
});
