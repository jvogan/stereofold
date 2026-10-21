import { inspectionChangeSchema, operationContractSchema, type InspectionChange, type OperationContract } from './inspection-contract.js';
import type { GrowthStage } from './molecular-growth.js';

export function visualOperation(change: InspectionChange, tool = 'update_inspection'): OperationContract {
  return visualEdit([change.kind],tool);
}

export function visualEdit(effects: string[], tool: string): OperationContract {
  return operationContractSchema.parse({version:1,kind:'visual-edit',coordinatesChanged:false,tool,effects});
}

/** Inventory follows the renderer schema. This does not grant new tools. */
export const inspectionOperationInventory = inspectionChangeSchema.options.map(schema => ({
  kind:schema.shape.kind.value,operation:'visual-edit',coordinatesChanged:false,
}));

/** A growth tier loads checked bytes. It does not run a chemistry model. */
export function growthOperation(target: GrowthStage, fetchedAt: number | null, verifiedAt: number): OperationContract {
  const c=target.stage.coordinates;
  // Bundled artifacts and prepared composites have verified local origins,
  // rather than a deposited-coordinate download URL. Keep that actual origin
  // and the public dataset identity instead of inventing a PDB address.
  const sourceAddress=c.derivation?.kind==='bundled-file' ? c.derivation.path
    : c.derivation?.kind==='prepared-rigid-composite' ? c.derivation.recipe : c.download;
  return operationContractSchema.parse({version:1,kind:'coordinate-artifact',coordinatesChanged:!c.volume,sourceChanged:true,
    tool:'grow_structure',artifact:c.volume?'density':'coordinates',chemicallyValidated:false,
    provenance:{sourceAddress,sha256:c.sha256,fetchedAt:c.volume?null:fetchedAt,verifiedAt,
      requestedBy:'grow_structure',derivation:{kind:'growth-tier',demo:target.demo,stage:target.stage.id,
        ...(target.stage.sourceId?{sourceId:target.stage.sourceId}:{}),
        assemblyId:c.assemblyId??'deposited',subset:c.derivation??null,
        ...(c.volume?{preparation:{kind:'mean-downsample',factor:c.volume.downsample,
          sourceSha256:c.volume.downloadSha256}}:{})}}});
}
