import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { pageFunction } from './fixtures/label-action-harness.mjs';
import { normalizeAppearance, createInspectionState } from './inspection-state.mjs';
import { normalizeStyles, applyScopedStyle } from './inspection-styles.mjs';
import { geometryBudgetReceipt, requireGeometryBudget, structureGeometryCounts } from './representation-budget.mjs';
import { liveEmphasisTargets, isStereofoldAuxiliaryCell } from './representation-refs.mjs';
import { emptyVisibility, hiddenRowKeys, normalizeVisibility } from './inspection-visibility.mjs';
const viewer = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

import { styleHarness as harness } from './fixtures/style-layer-harness.mjs';

test('one component per entry, exact residue sets, scoped colour and opacity, removed exactly on clear',async()=>{
  const h=harness();
  const styles=[{selectionKeys:['k0','k1'],representation:'ball-and-stick',color:'uniform',uniformColor:'#ff8800',opacity:0.4},
    {selectionKeys:['k20'],representation:'spacefill'}];
  await h.set(styles);
  assert.deepEqual(h.built.map(entry=>entry.keys),[['k0','k1'],['k20']]);
  assert.equal(h.built[0].params.type,'ball-and-stick');
  assert.equal(h.built[0].params.color,'uniform');
  assert.equal(h.built[0].params.colorParams.value,0xff8800);
  assert.equal(h.built[0].params.typeParams.alpha,0.4);
  assert.deepEqual(plain(vm.runInContext('savedStyles()',h.context)),{styles});
  assert.equal(h.events.at(-1),'frame');
  assert.ok(h.events.indexOf('representation')<h.events.indexOf('emphasis'));
  assert.deepEqual(h.events.slice(-5),['emphasis','labels','plates','placement','frame']);
  assert.ok(h.marks.some(mark=>mark.action==='select' && mark.keys.join(',')==='k0'));
  assert.deepEqual(h.marks.find(mark=>mark.action==='base').keys,[],'the masked base has no ghost selection outline');
  assert.ok(h.marks.some(mark=>mark.action==='select' && mark.keys.join(',')==='k20'));
  await h.set([]);
  assert.deepEqual(h.deleted,['stereofold-scoped-style-0','stereofold-scoped-style-1','hidden']);
  assert.deepEqual([...h.cells.keys()],['base']);
  assert.deepEqual(plain(vm.runInContext('savedStyles()',h.context)),{});
});

test('a colour edit over residues its inherited representation cannot draw skips them; a named representation still refuses',async()=>{
  // 4HHB after a tour: chain A's waters were the one part with no earlier
  // style, so "color chain A red" left them a layer of their own under the
  // scene's cartoon, which Mol* does not apply to water.
  const h=harness(), waters=new Set(['k20','k21']);
  h.context.plugin.representation.structure.registry.get=name=>({
    isApplicable:data=>!(name==='cartoon' && data.keys.every(key=>waters.has(key)))});
  const styles=[{selectionKeys:['k0','k1'],representation:'ball-and-stick',color:'uniform',uniformColor:'#cc2222',opacity:1},
    {selectionKeys:['k20','k21'],color:'uniform',uniformColor:'#cc2222',opacity:1}];
  await h.set(styles);
  assert.deepEqual(h.built.map(entry=>entry.keys),[['k0','k1']]);
  assert.deepEqual(plain(vm.runInContext('savedStyles()',h.context)),{styles},'the saved scene keeps what was asked');
  const built=h.built.length;
  await assert.rejects(()=>h.set([{selectionKeys:['k20'],representation:'cartoon'}]),/does not apply to the selected residues/);
  assert.equal(h.built.length,built);
  assert.deepEqual(plain(h.context.stylesState),styles);
});

test('scoped geometry counts only requested atoms and oversized styles remain advisory without dropping atoms',async()=>{
  const h=harness();
  const large=requireGeometryBudget({representation:'ball-and-stick',atoms:80000,residues:10000,presenting:true,deviceClass:'quest2',quality:'lower'});
  assert.equal(large.status,'advisory');
  assert.match(large.message,/may run slowly/);
  assert.deepEqual(large.typeParams,{},'An advisory does not lower requested quality');
  await h.set([{selectionKeys:Array.from({length:40},(_,i)=>'k'+i),representation:'ball-and-stick'}]);
  assert.equal(h.budgets[0].atoms,320);
  assert.equal(h.budgets[0].residues,40);
  assert.equal(h.budgets[0].bonds,360);
  const keys=Array.from({length:10000},(_,i)=>'k'+i);
  await h.set([{selectionKeys:keys,representation:'ball-and-stick'}]);
  assert.equal(h.budgets.at(-1).atoms,80000);
  assert.deepEqual([...h.built.at(-1).keys].sort(),[...keys].sort(),'The whole requested structure is represented');
  assert.equal(h.context.stylesState[0].selectionKeys.length,10000);
  const built=h.built.length,deleted=h.deleted.length;
  await assert.rejects(()=>h.set([{selectionKeys:['not-a-source-residue'],representation:'ball-and-stick'}]),/Unknown canonical key/);
  assert.equal(h.built.length,built); assert.equal(h.deleted.length,deleted);
  assert.equal(h.context.stylesState[0].selectionKeys.length,10000);
});

test('hidden residues remain hidden in every scoped representation and in the highlight; show reveals the same layer',async()=>{
  const h=harness();
  h.context.visibilityState={hiddenChains:[{labelChain:'A',copyId:'1'}],hiddenClasses:[],showOnlySelection:false};
  await h.set([{selectionKeys:['k0','k20'],representation:'ball-and-stick'}]);
  const paint=h.paints.find(paint=>paint.target==='stereofold-scoped-style-0-repr');
  assert.deepEqual(paint.params.layers,[{bundle:{keys:['k0']},value:1}]);
  assert.ok(h.marks.some(mark=>mark.action==='select' && mark.keys.join(',')==='k20'));
  assert.ok(!h.marks.some(mark=>mark.action==='select' && mark.keys.includes('k0')));
  h.context.visibilityState=emptyVisibility();
  await vm.runInContext('paintVisibilityLayers();',h.context);
  assert.ok(h.deleted.includes('hidden-style-0'));
  assert.equal(h.built.length,1,'show does not rebuild or discard the style');
});

test('scoped opacity masks the base and combines emphasis fading with hidden-key precedence',async()=>{
  const h=harness();
  h.context.currentEmphasisPlan=()=>({faded:['k0','k20'],transparency:0.8});
  h.context.visibilityState={hiddenChains:[{labelChain:'A',copyId:'1'}],hiddenClasses:[],showOnlySelection:false};
  await h.set([{selectionKeys:['k0','k20'],opacity:0.3}]);
  const base=h.paints.find(paint=>paint.target==='base');
  assert.deepEqual(base.params.layers[0],{bundle:{keys:['k0','k20']},value:0.8});
  assert.ok(base.params.layers[1].bundle.keys.includes('k20'),'the opaque base under a visible translucent style is masked');
  const scoped=h.paints.find(paint=>paint.target==='stereofold-scoped-style-0-repr');
  assert.deepEqual(scoped.params.layers,[{bundle:{keys:['k0','k20']},value:0.8},{bundle:{keys:['k0']},value:1}]);
  assert.equal(h.built[0].params.typeParams.alpha,0.3);
  h.context.visibilityState=emptyVisibility();
  h.paints.length=0;
  await h.set([]);
  assert.deepEqual(h.paints.at(-1).params.layers,[{bundle:{keys:['k0','k20']},value:0.8}], 'clearing styles keeps the existing emphasis fade');
});

test('appearance restore, recovery and source replacement carry only their own styles before painting',()=>{
  const restore=pageFunction(viewer,'restoreInspection');
  assert.ok(restore.indexOf('stylesState = normalizeStyles(next.inspection.styles)')<restore.indexOf('await applyInspectionAppearance()'));
  const rebuild=pageFunction(viewer,'applyInspectionAppearance');
  assert.ok(rebuild.indexOf('await rebuildStyleLayers()')<rebuild.indexOf('await paintEmphasisLayers'));
  assert.ok(rebuild.indexOf('await paintEmphasisLayers')<rebuild.indexOf('await paintVisibilityLayers'));
  assert.match(pageFunction(viewer,'adopt'),/stylesState = normalizeStyles\(record\?\.styles\)/);
  assert.match(pageFunction(viewer,'retainCurrent'),/styles: normalizeStyles\(stylesState\)/);
  assert.match(pageFunction(viewer,'restoreInspectionPayload'),/stylesState = normalizeStyles\(payload.styles\)/);
  assert.match(pageFunction(viewer,'scientificRepresentations'),/styleLayers.map/);
  assert.match(pageFunction(viewer,'scientificRepresentationCount'),/styleLayers.filter/);
  assert.match(pageFunction(viewer,'waitForFrame'),/styleLayers.some/);
  assert.equal(isStereofoldAuxiliaryCell({transform:{tags:['stereofold-scoped-style']}}),true);
});

test('style state has the same partial merge and clear semantics in the page and host',()=>{
  const first=applyScopedStyle([],['b','a'],{representation:'ball-and-stick'});
  assert.deepEqual(first,[{selectionKeys:['a','b'],representation:'ball-and-stick'}]);
  assert.deepEqual(applyScopedStyle(first,['a'],{clear:true}),[{selectionKeys:['b'],representation:'ball-and-stick'}]);
});

test('installed Mol* builds the scoped residue structure with exactly its canonical atoms and bonds',async()=>{
  const { createRequire } = await import('node:module');
  const require = createRequire(new URL('../../plugin/package.json',import.meta.url));
  const { CIF }=require('molstar/lib/commonjs/mol-io/reader/cif.js');
  const { trajectoryFromMmCIF }=require('molstar/lib/commonjs/mol-model-formats/structure/mmcif.js');
  const { Structure }=require('molstar/lib/commonjs/mol-model/structure/structure/structure.js');
  const { StructureSymmetry }=require('molstar/lib/commonjs/mol-model/structure/structure/symmetry.js');
  const { StructureElement }=require('molstar/lib/commonjs/mol-model/structure/structure/element.js');
  const { StructureSelection }=require('molstar/lib/commonjs/mol-model/structure/query/selection.js');
  const { createSelectionAdapter }=await import('./selection.mjs');
  const {default:extraction}=await import('../identity/extract.cjs');
  const bytes=readFileSync(new URL('../../fixtures/1CRN.cif',import.meta.url));
  const parsed=await CIF.parse(bytes.toString('utf8')).run();
  const trajectory=await trajectoryFromMmCIF(parsed.result.blocks[0]).run();
  const frame=trajectory.getFrameAtIndex(0), model=typeof frame.run==='function'?await frame.run():frame;
  const structure=await StructureSymmetry.buildAssembly(Structure.ofModel(model),'1').run();
  const catalog=await extraction.extractBytes(bytes,{sourceLabel:'1CRN',assemblyId:'1'});
  const adapter=createSelectionAdapter(structure,catalog);
  const rows=adapter.rows.slice(0,12), keys=rows.map(row=>row.key);
  const loci=adapter.toLoci(keys), scoped=StructureElement.Loci.toStructure(loci);
  const counts=structureGeometryCounts(scoped);
  assert.equal(counts.atoms,rows.reduce((sum,row)=>sum+row.atomSites.length,0));
  assert.equal(counts.residues,12);
  assert.ok(counts.bonds>0 && counts.bonds<structure.bondCount);
  assert.ok(counts.atoms<structure.elementCount);
  const selected=StructureSelection.Singletons(loci.structure,scoped);
  const component=StructureElement.Bundle.toStructure(StructureElement.Bundle.fromSelection(selected),structure);
  assert.deepEqual(structureGeometryCounts(component),counts);
  assert.deepEqual(adapter.fromLoci(StructureElement.Loci.remap(loci,component)),keys);
});
