import { CIF } from 'molstar/lib/commonjs/mol-io/reader/cif.js';
import { trajectoryFromMmCIF } from 'molstar/lib/commonjs/mol-model-formats/structure/mmcif.js';
import { Structure, StructureSelection, StructureSymmetry } from 'molstar/lib/commonjs/mol-model/structure.js';
import { Task } from 'molstar/lib/commonjs/mol-task/task.js';
import { Script } from 'molstar/lib/commonjs/mol-script/script.js';
import { MolScriptBuilder } from 'molstar/lib/commonjs/mol-script/language/builder.js';
import { PLUGIN_VERSION } from 'molstar/lib/commonjs/mol-plugin/version.js';
// @ts-ignore Shared renderer advisory; host and renderer use the same historical estimates.
import { GEOMETRY_LEVELS, REPRESENTATION_BUDGETS, estimateRepresentation, structureGeometryCounts } from '../../lab/browser-roundtrip/representation-budget.mjs';
// @ts-ignore The exact display filter used when the renderer builds a journey source.
import { experienceVisibilityExpression } from '../../lab/browser-roundtrip/experience-visibility.mjs';
import { stageForStep, type MolecularExperience, type MolecularExperienceStage } from './molecular-experience.js';
import { EXPERIENCE_CATALOG_SIZES } from './experience-catalog-sizes.js';

export type ExperienceGeometry = { atoms:number; bonds:number; residues:number };
export type ChapterGeometryEstimate = {
  kind:'mesh-equivalent'; quality:'unknown'; representation:string;
  atoms:number; bonds:number; residues:number;
  vertices:{min:number;max:number};
  /** Absent for devices without a finite historical policy. This is not an FPS bound. */
  policy?:number;
};
export type ChapterBudget = { stepIndex:number; title:string; status:'available'|'refused'|'unchecked'; message?:string;
  geometryEstimate?:ChapterGeometryEstimate };


/** Count real bonds in the declared model/assembly. An atom-only estimate can
 * incorrectly refuse 4HHB sticks even though its real bonds fit the budget. */
export async function experienceGeometry(text:string, stage:MolecularExperienceStage, modelNumber=stage.source.modelNumber):Promise<ExperienceGeometry> {
  const parsed=await CIF.parse(text).run();
  if(parsed.isError) throw Error('Journey coordinates could not be parsed.');
  const trajectory=await trajectoryFromMmCIF(parsed.result.blocks[0]).run();
  for(let i=0;i<trajectory.frameCount;i++) {
    const model=await Task.resolveInContext(trajectory.getFrameAtIndex(i));
    if(modelNumber!==undefined && model.modelNum!==modelNumber) continue;
    const base=Structure.ofModel(model);
    const structure=stage.assembly.assemblyId==='asymmetric_unit'?base:await StructureSymmetry.buildAssembly(base,stage.assembly.assemblyId).run();
    const visible={...(stage.assembly.visibleEntityIds.length?{entityIds:stage.assembly.visibleEntityIds}:{}),
      ...(stage.assembly.activeOperatorIds.length?{operatorIds:stage.assembly.activeOperatorIds}:{} )};
    const expression=experienceVisibilityExpression(MolScriptBuilder,Object.keys(visible).length?visible:undefined,structure);
    const shown=expression?StructureSelection.unionStructure(Script.getStructureSelection(expression,structure)):structure;
    if(!shown.elementCount) throw Error('The requested journey stage contains no atoms.');
    // Chapter configure() budgets the full structure, including hidden atoms;
    // use that same cost until the renderer supports budgeting only this filter.
    return structureGeometryCounts(structure);
  }
  throw Error(`Journey needs model ${modelNumber}; this source does not contain it.`);
}

export function chapterBudget(experience:MolecularExperience, stepIndex:number, counts:ExperienceGeometry|undefined, deviceClass='quest2'):ChapterBudget {
  const step=experience.steps[stepIndex];
  if(!step) throw Error('That journey chapter is unavailable.');
  if(!counts) return {stepIndex,title:step.title,status:'unchecked',message:'This chapter has no geometry estimate yet; its build may run slowly.'};
  // Neither authored chapters nor host hydration carry the current renderer's
  // quality, custom typeParams, or URL overrides. Do not invent a requested tier.
  // These are historical mesh-equivalent proxies over the supported tier range,
  // not exact triangulation, fragment cost, custom geometry, or FPS predictions.
  const representation=step.appearance.representation;
  const vertices=GEOMETRY_LEVELS.map((level:string)=>estimateRepresentation({...counts,representation,level}).vertices);
  if(vertices.some((value:number)=>!Number.isSafeInteger(value) || value<0))
    return {stepIndex,title:step.title,status:'unchecked',message:'This chapter has no finite vertex estimate; renderer settings must be checked before sizing it.'};
  const min=Math.min(...vertices),max=Math.max(...vertices);
  const policy=(REPRESENTATION_BUDGETS[deviceClass]??REPRESENTATION_BUDGETS.unknown)[representation];
  const bounded=Number.isFinite(policy) && policy>0;
  const geometryEstimate:ChapterGeometryEstimate={kind:'mesh-equivalent',quality:'unknown',representation,...counts,
    vertices:{min,max},...(bounded?{policy}:{})};
  return {stepIndex,title:step.title,status:'available',geometryEstimate,
    ...(bounded && min>policy
      ?{message:`Chapter ${stepIndex+1} may run slowly across the estimated quality range (${counts.atoms} atoms); current settings are unknown.`}
      :bounded && max>policy
      ?{message:`Chapter ${stepIndex+1} has quality-dependent estimated cost (${counts.atoms} atoms); current settings are unknown.`}:{})};
}

/** Cold catalog forecasts use offline public-source counts. Loaded coordinates
 * always take precedence; navigation still reports actual build failures independently.
 * The renderer budgets the full assembly, so entity/operator visibility cannot
 * discount these counts. A different model or assembly needs its own cache row.
 */
export function catalogChapterBudget(experience:MolecularExperience, stepIndex:number, counts?:ExperienceGeometry, deviceClass='quest2'):ChapterBudget {
  if(counts)return chapterBudget(experience,stepIndex,counts,deviceClass);
  const stage=stageForStep(experience,stepIndex),modelNumber=stage.source.modelNumber??1;
  const cached=EXPERIENCE_CATALOG_SIZES.entries[`${stage.source.pdbId}:${stage.assembly.assemblyId}:${modelNumber}`];
  const compatible=EXPERIENCE_CATALOG_SIZES.molstarVersion===PLUGIN_VERSION;
  if(compatible && cached?.counts)return chapterBudget(experience,stepIndex,cached.counts,deviceClass);
  const reason=!compatible?'The cached geometry was sized with a different Mol* version. Load the source on the host to recount its atoms, bonds, and residues.'
    :cached?.reason??`${stage.source.pdbId} model ${modelNumber}, assembly ${stage.assembly.assemblyId} has no cached atom, bond, or residue counts. Its coordinates must load on the host before this chapter can be sized.`;
  return {...chapterBudget(experience,stepIndex,undefined,deviceClass),message:reason};
}

export function chapterBudgetNotice(chapters:ChapterBudget[]):string {
  const refused=chapters.filter(chapter=>chapter.status==='refused').map(chapter=>chapter.stepIndex+1);
  const unchecked=chapters.some(chapter=>chapter.status==='unchecked');
  const unknownQuality=chapters.some(chapter=>chapter.geometryEstimate?.quality==='unknown');
  const advisory=chapters.filter(chapter=>chapter.status==='available'&&chapter.message?.includes('may run slowly')).map(chapter=>chapter.stepIndex+1);
  return [advisory.length?`Chapters ${advisory.join(', ')} may run slowly across the estimated quality range.`:'',
    refused.length?`Chapters ${refused.join(', ')} are unavailable.`:'',
    unchecked?'Unverified chapters will be checked before loading.':'',
    unknownQuality?'Vertex ranges are estimates; current renderer quality and custom geometry settings are unavailable.':''].filter(Boolean).join(' ');
}
