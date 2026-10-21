import { readFileSync } from 'node:fs';
import { PluginContext } from 'molstar/lib/mol-plugin/context.js';
import { DefaultPluginSpec } from 'molstar/lib/mol-plugin/spec.js';
import { StateTransforms } from 'molstar/lib/mol-plugin-state/transforms.js';
import { createStructureRepresentationParams } from 'molstar/lib/mol-plugin-state/helpers/structure-representation-params.js';
import { Mat4 } from 'molstar/lib/mol-math/linear-algebra.js';
import { createMolecularAnimation } from '../molecular-animation.mjs';
export async function molecularAnimationHarness(t, options = {}) {
  const { structureText, representation = 'cartoon', ...animationOptions } = options;
  const document = globalThis.document;
  globalThis.document = {addEventListener(){},removeEventListener(){},createElement(){return {setAttribute(){}};},head:{appendChild(){},removeChild(){}}};
  const plugin = new PluginContext(DefaultPluginSpec()); await plugin.init();
  t.after(() => {plugin.dispose(); if(document===undefined) delete globalThis.document; else globalThis.document=document;});
  const data = await plugin.builders.data.rawData({data:structureText ?? readFileSync(new URL('../../../fixtures/4HHB.cif',import.meta.url),'utf8')});
  const trajectory = await plugin.build().to(data).apply(StateTransforms.Data.ParseCif).apply(StateTransforms.Model.TrajectoryFromMmCif).commit();
  const model = await plugin.build().to(trajectory).apply(StateTransforms.Model.ModelFromTrajectory,{modelIndex:0}).commit();
  const structure = await plugin.build().to(model).apply(StateTransforms.Model.StructureFromModel,{type:{name:'model',params:{}}}).commit();
  const params = createStructureRepresentationParams(plugin,structure.obj.data,{type:representation,color:'chain-id',typeParams:{quality:'low'}});
  const cell = await plugin.build().to(structure).apply(StateTransforms.Representation.StructureRepresentation3D,params).commit();
  const repr = cell.obj.data.repr, costs=[], annotations=[], representations=[repr], manual=new Set(); let visibilitySyncs=0, updates=0;
  const presentation = Mat4.fromScaling(Mat4(),[2,2,2]); Mat4.setTranslation(presentation,[3,4,5]);
  const registry = createMolecularAnimation({plugin,canvas:{add(repr){manual.add(repr);},remove(repr){manual.delete(repr);},update(){updates++;},syncVisibility(){visibilitySyncs++;}},
    getStructure:()=>structure,getRepresentations:()=>representations,getAnnotations:()=>annotations,getTransform:()=>presentation, record:(kind,data)=>costs.push({kind,...data}), ...animationOptions});
  t.after(()=>registry.forget());
  return {plugin,structure,repr,cell,registry,costs,presentation,annotations,representations,manual,stats:()=>({visibilitySyncs,updates})};
}
