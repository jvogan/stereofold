import { CIF } from './compatible-cif.js';
import { trajectoryFromMmCIF } from 'molstar/lib/commonjs/mol-model-formats/structure/mmcif.js';
import { Structure, StructureSymmetry } from 'molstar/lib/commonjs/mol-model/structure.js';
import { Task } from 'molstar/lib/commonjs/mol-task/task.js';

/** Use the same model/assembly boundary as the renderer, including assembly copies. */
export async function comparisonRadius(text:string, modelNumber:number, assemblyId:string):Promise<number> {
  const parsed=await CIF.parse(text).run();
  if(parsed.isError) throw Error('Comparison coordinates could not be parsed.');
  const trajectory=await trajectoryFromMmCIF(parsed.result.blocks[0]).run();
  for(let i=0;i<trajectory.frameCount;i++) {
    const model=await Task.resolveInContext(trajectory.getFrameAtIndex(i));
    if(model.modelNum!==modelNumber) continue;
    const base=Structure.ofModel(model);
    const structure=assemblyId==='asymmetric_unit'?base:await StructureSymmetry.buildAssembly(base,assemblyId).run();
    return Math.max(structure.boundary.sphere.radius,0.001);
  }
  throw Error('Comparison model is unavailable.');
}
