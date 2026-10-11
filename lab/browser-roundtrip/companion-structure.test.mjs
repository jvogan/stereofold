import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { pageFunction } from './fixtures/label-action-harness.mjs';
import { companionTransform, foldCompanion } from './companion-structure.mjs';
import { requireComparisonGeometryBudget, requireGeometryBudget, structureGeometryCounts } from './representation-budget.mjs';
import { createInspectionState } from './inspection-state.mjs';
const require = createRequire(new URL('../../plugin/package.json', import.meta.url));
const { Mat4, Vec3 } = require('molstar/lib/commonjs/mol-math/linear-algebra.js');
const source = readFileSync(new URL('./viewer.mjs',import.meta.url),'utf8');
const value = {source:{kind:'pdb',id:'2HHB'},sourceSha256:'a'.repeat(64),modelNumber:1,assemblyId:'asymmetric_unit',
  placement:{translation:[3,0,0],rotation:[0,0,0],scale:1},
  appearance:{representation:'cartoon',color:'uniform',uniformColor:'#e6a04b',opacity:1}};

test('companion is centered beside primary then follows its rotation, scale and translation',()=>{
  const primary={center:[10,20,30],radius:5},companion={center:[-100,4,8],radius:10};
  const local=companionTransform(Mat4,Vec3,Mat4.identity(),primary,companion,value.placement);
  const center=Vec3.transformMat4(Vec3(),companion.center,local);
  assert.deepEqual(Array.from(center),[25,20,30]);
  assert.equal(Vec3.distance(primary.center,center),primary.radius+companion.radius);
  const primaryTransform=Mat4.fromTranslation(Mat4(),[7,8,9]);
  const rotate=Mat4.fromRotation(Mat4(),Math.PI/2,[0,0,1]);
  Mat4.mul(primaryTransform,primaryTransform,rotate);
  const world=companionTransform(Mat4,Vec3,primaryTransform,primary,companion,{...value.placement,scale:2,rotation:[0,90,0]});
  const got=Vec3.transformMat4(Vec3(),companion.center,world);
  const expected=Vec3.transformMat4(Vec3(),center,primaryTransform);
  assert.ok(Vec3.distance(got,expected)<1e-9);
});

test('both structures share the existing device budget, including mixed representations',()=>{
  const primary={representation:'spacefill',atoms:8000,bonds:0,residues:1000};
  const companion={...primary};const options={presenting:true,deviceClass:'quest2',quality:'lowest'};
  assert.equal(requireGeometryBudget({...primary,...options}).status,'unchanged');
  const combined=requireComparisonGeometryBudget(primary,companion,options);
  assert.ok(combined.every(d=>d.status==='advisory' && d.level==='lowest' && d.estimatedVertices>d.budget));
  const decisions=requireComparisonGeometryBudget({...primary,atoms:1000},{...companion,representation:'cartoon',atoms:3000,residues:800},
    {...options,quality:'high'});
  assert.equal(decisions[0].atoms,4000);assert.equal(decisions[1].atoms,4000);
  assert.equal(decisions[0].level,decisions[1].level);
  assert.ok(decisions.every(d=>d.level==='high' && d.status==='advisory'));
  assert.ok(decisions.every(d=>Object.keys(d.typeParams).length===0));
});

test('saved inspection history and named views retain the complete companion state',()=>{
  const state=createInspectionState();state.setCompanion(value);
  const named=state.save('Pair');state.setCompanion(foldCompanion(value,{placement:{scale:2}}));
  assert.equal(state.undo().companionStructure.placement.scale,1);
  assert.equal(state.undo().companionStructure,undefined);
  assert.deepEqual(state.redo().companionStructure,value);
  state.setCompanion(undefined);state.restoreSaved(named.savedView.id);
  assert.deepEqual(state.snapshot().companionStructure,value);
  state.reset();assert.equal(state.snapshot().companionStructure,undefined);
});

function harness() {
  const cells=new Map([['primary',{ref:'primary'}]]), shown=new Set(['primary']), deleted=[];
  let serial=0,refuse=false;
  const data={elementCount:100,bondCount:100,atomicResidueCount:20,boundary:{sphere:{center:[0,0,0],radius:5}}};
  const context=vm.createContext({companionRecord:undefined,comparisonSources:new Map([['a'.repeat(64)+':asymmetric_unit',{id:'2HHB'}]]),
    retiredComparisons:new Set(),detached:structuredClone,
    checkedFixture:async (fixture,settings)=>({source:fixture,settings}),
    buildCandidate:async (_source,settings)=>{
      const ref='companion-'+(++serial);const record={rootRef:ref,structure:{ref:ref+'-structure',obj:{data}},
        companionState:settings.companionState,
        representation:{ref,obj:{data:{repr:ref}}}};
      cells.set(ref,record);return record;
    },
    comparisonGeometry:()=>{if(refuse)throw Error('Both structures together exceed the headset geometry budget');return [{},{}];},
    paintCompanion:async()=>{},applyInspectionTransform:()=>{},
    candidateRecords:new Set(),
    plugin:{state:{data:{updateCellState:ref=>shown.add(ref)}}},
    canvas:{remove:ref=>shown.delete(ref),add:ref=>shown.add(ref)},
    deleteRecord:async record=>{cells.delete(record.rootRef);shown.delete(record.rootRef);deleted.push(record.rootRef);},
  });
  vm.runInContext(pageFunction(source,'restoreCompanion'),context);
  return {context,cells,shown,deleted,refuse:()=>{refuse=true;}};
}

test('production companion loader owns a second ref, replaces/removes it, and preserves primary',async()=>{
  const h=harness();await h.context.restoreCompanion(value);
  const first=h.context.companionRecord;
  assert.ok(h.cells.has('primary'));assert.ok(h.cells.has(first.rootRef));
  assert.deepEqual([...h.shown],['primary',first.rootRef]);
  await h.context.restoreCompanion(foldCompanion(value,{appearance:{opacity:0.4}}));
  const second=h.context.companionRecord;
  assert.notEqual(second.structure.ref,first.structure.ref);
  assert.deepEqual([...h.shown],['primary',second.rootRef]);
  assert.ok(h.context.retiredComparisons.has(first),'old root retained through frame receipt');
  await h.context.restoreCompanion(undefined);
  assert.equal(h.context.companionRecord,undefined);assert.deepEqual([...h.shown],['primary']);
});

test('production companion load refusal deletes only candidate and leaves the rendered pair intact',async()=>{
  const h=harness();await h.context.restoreCompanion(value);const before=h.context.companionRecord;
  h.refuse();
  await assert.rejects(h.context.restoreCompanion(foldCompanion(value,{appearance:{representation:'spacefill'}})),/budget/);
  assert.equal(h.context.companionRecord,before);
  assert.deepEqual([...h.shown],['primary',before.rootRef]);
  assert.ok(h.cells.has('primary'));assert.equal(h.deleted.length,1);
});

test('production frame receipt checks companion render objects and source adoption carries its ref',()=>{
  assert.match(pageFunction(source,'waitForFrame'),/checkDrawnRecord\(companionRecord,failure\)/);
  assert.match(pageFunction(source,'waitForFrame'),/renderObjects\.every\(object=>objects\.has\(object\)\)/);
  assert.match(pageFunction(source,'retainCurrent'),/companionRecord/);
  assert.match(pageFunction(source,'adopt'),/companionRecord = record\?\.companionRecord/);
  assert.match(pageFunction(source,'deleteRecord'),/deleteRecord\(record\.companionRecord\)/);
  assert.match(pageFunction(source,'applyInspectionTransform'),/companionTransform/);
  assert.match(pageFunction(source,'buildCandidate'),/settings\.companionState \? comparisonGeometry\(candidate\)\[1\]/);
});


test('a candidate that fails inside parsing or geometry construction leaves no extra root',async()=>{
  const h=harness();await h.context.restoreCompanion(value);const before=h.context.companionRecord;
  h.context.buildCandidate=async()=>{
    const record={rootRef:'failed-before-return'};
    h.cells.set(record.rootRef,record);h.context.candidateRecords.add(record);
    throw Error('geometry build refused');
  };
  await assert.rejects(h.context.restoreCompanion(foldCompanion(value,{appearance:{opacity:0.5}})),/geometry build refused/);
  assert.equal(h.context.companionRecord,before);
  assert.ok(!h.cells.has('failed-before-return'));
  assert.deepEqual([...h.shown],['primary',before.rootRef]);
});
