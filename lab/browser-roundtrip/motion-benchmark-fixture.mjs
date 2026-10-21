import { readFileSync } from 'node:fs';
import { PluginContext } from 'molstar/lib/mol-plugin/context.js';
import { DefaultPluginSpec } from 'molstar/lib/mol-plugin/spec.js';
import { StateTransforms } from 'molstar/lib/mol-plugin-state/transforms.js';
import { setCanvasModule } from 'molstar/lib/mol-geo/geometry/text/font-atlas.js';
import { Mat4 } from 'molstar/lib/mol-math/linear-algebra.js';
import { createLessonFigure } from './lesson-figure.mjs';
import { createMolecularAnimation } from './molecular-animation.mjs';

// Six copies of the deposited hemoglobin A/B dimer: ~13k atoms and twelve
// cartoon chain visuals, similar to six motor domains. No network dependency.
export function sixBodySource() {
  const source = readFileSync(new URL('../../fixtures/4HHB.cif', import.meta.url), 'utf8');
  const start = source.search(/loop_\s*\n_atom_site.group_PDB/), end = source.indexOf('\n#', start);
  const block = source.slice(start, end).split('\n'), headers = block.filter(l => l.startsWith('_atom_site.')).map(l=>l.trim());
  const index = name => headers.indexOf('_atom_site.' + name);
  const rows = block.filter(l => /^(ATOM|HETATM)\s/.test(l)).map(l => l.trim().split(/\s+/))
    .filter(row => ['A','B'].includes(row[index('auth_asym_id')]) && row[index('group_PDB')] === 'ATOM');
  const out = ['loop_', ...headers]; let serial = 0;
  for (let body = 0; body < 6; body++) for (const row of rows) {
    const copy = [...row]; copy[index('id')] = String(++serial);
    if (row[index('auth_asym_id')] === 'B') copy[index('auth_seq_id')] = String(Number(copy[index('auth_seq_id')]) + 200);
    copy[index('auth_asym_id')] = 'H' + body;
    copy[index('label_asym_id')] += body;
    copy[index('Cartn_x')] = String(Number(copy[index('Cartn_x')]) + body * 50);
    out.push(copy.join(' '));
  }
  return source.slice(0,start) + out.join('\n') + source.slice(end);
}
export const sixBodyAnimation = {
  version:1, durationSeconds:6, playback:{autoplay:true,loop:true},
  tracks:Array.from({length:6},(_,i)=>({id:'head'+i,chains:['H'+i],keyframes:[
    {t:0,translation:[0,0,0],rotation:[0,0,0,1]}, {t:6,translation:[0,30,0],rotation:[0,0,.7071067811865476,.7071067811865476]},
  ],visibility:[{t:0,visible:i<2},{t:2,visible:i>=2&&i<4},{t:4,visible:i>=4}]})),
  tethers:Array.from({length:6},(_,i)=>({id:'link'+i,label:'Neck linker',color:'#246080',
    from:{chain:'H'+i,residue:1,atom:'CA'},to:{chain:'H'+(i%2?i-1:i+1),residue:2,atom:'CA'}})),
};
export async function motionFixture({createAnimation=createMolecularAnimation, createFigure=createLessonFigure, source=sixBodySource(), animation=sixBodyAnimation}={}) {
  const document = globalThis.document;
  globalThis.document={addEventListener(){},removeEventListener(){},createElement:()=>({setAttribute(){}}),head:{appendChild(){},removeChild(){}}};
  setCanvasModule({createCanvas:()=>({getContext:()=>({measureText(){return {width:40};},clearRect(){},fillText(){},
    getImageData:(_x,_y,w,h)=>({data:new Uint8ClampedArray(w*h*4).fill(255)})})})});
  const plugin=new PluginContext(DefaultPluginSpec()); await plugin.init();
  const raw=await plugin.builders.data.rawData({data:source});
  const trajectory=await plugin.build().to(raw).apply(StateTransforms.Data.ParseCif).apply(StateTransforms.Model.TrajectoryFromMmCif).commit();
  const model=await plugin.build().to(trajectory).apply(StateTransforms.Model.ModelFromTrajectory,{modelIndex:0}).commit();
  const structure=await plugin.build().to(model).apply(StateTransforms.Model.StructureFromModel,{type:{name:'model',params:{}}}).commit();
  const cell=await plugin.builders.structure.representation.addRepresentation(structure,{type:'cartoon',typeParams:{quality:'low'},color:'chain-id'});
  const presentation=Mat4.identity(), costs=[];
  const counts={uploads:0,objects:0,syncs:0};
  const canvas={camera:{scale:.00504},xr:{isPresenting:{value:true}},add(){},remove(){},mark(){},getRenderObjects:()=>[],
    update(repr){counts.uploads++;counts.objects+=repr?.renderObjects.length??0;},
    updateRepresentations(reprs){counts.uploads++;for(const r of reprs)counts.objects+=r.renderObjects.length;},syncVisibility(){counts.syncs++;}};
  plugin.canvas3d=canvas;
  const figure=createFigure({plugin,getStructure:()=>structure,getTransform:()=>presentation});
  await figure.install({layers:[],distances:[],labels:(animation?.tracks ?? []).map(t=>({id:t.id,text:t.id,target:{chain:t.chains[0]},sizeFactor:.6,offsetX:0,offsetY:8,color:'#246080'}))});
  const registry=createAnimation({plugin,canvas,getStructure:()=>structure,getTransform:()=>presentation,
    getRepresentations:()=>[cell.obj.data.repr],getAnnotations:()=>figure.annotations().map((repr,i)=>({repr,chains:animation.tracks[i].chains})),
    record:(_kind,detail)=>costs.push({...detail})});
  if (animation) await registry.install(animation);
  return {plugin,canvas,structure,figure,registry,presentation,counts,costs,
    async dispose(){await registry.forget();await figure.forget();plugin.canvas3d=undefined;plugin.dispose();globalThis.document=document;}};
}
