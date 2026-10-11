import { describe, expect, it } from 'vitest';
import { operationContractSchema, inspectionChangeSchema } from '../src/inspection-contract.js';
import { growthOperation, visualEdit, inspectionOperationInventory } from '../src/inspection-operations.js';
import { growthStages, readGrowthIndex } from '../src/molecular-growth.js';
const tiers=growthStages(await readGrowthIndex()).filter(t=>t.demo==='microtubule-growth');

describe('scientific operation contract',()=>{
  it('lists renderer change kinds from the actual schema',()=>{
    expect(inspectionOperationInventory.map(i=>i.kind)).toEqual(inspectionChangeSchema.options.map(s=>s.shape.kind.value));
    for(const effect of ['appearance','camera','emphasis','selection','placement']) {
      expect(visualEdit([effect],'return_detailed_view')).toMatchObject({kind:'visual-edit',coordinatesChanged:false,effects:[effect]});
    }
    expect(()=>operationContractSchema.parse({...visualEdit(['appearance'],'emphasize'),coordinatesChanged:true})).toThrow();
  });
  it('records exact source, subset, digest, fetch time and requesting tool',()=>{
    const tier=tiers.find(t=>t.stage.id==='wall')!;
    const operation=growthOperation(tier,100,110);
    expect(operation).toMatchObject({kind:'coordinate-artifact',artifact:'coordinates',coordinatesChanged:true,chemicallyValidated:false,
      provenance:{sourceAddress:tier.stage.coordinates.download,sha256:tier.stage.coordinates.sha256,fetchedAt:100,verifiedAt:110,
        requestedBy:'grow_structure',derivation:{stage:'wall',subset:tier.stage.coordinates.derivation}}});
    expect(growthOperation(tier,null,120)).toMatchObject({provenance:{fetchedAt:null,verifiedAt:120}});
    expect(()=>operationContractSchema.parse({...operation,provenance:undefined})).toThrow();
  });
  it('names density preparation without claiming new atomic coordinates',()=>{
    const tier=tiers.find(t=>t.stage.id==='filament')!;
    expect(growthOperation(tier,100,110)).toMatchObject({artifact:'density',coordinatesChanged:false,sourceChanged:true,chemicallyValidated:false,
      provenance:{fetchedAt:null,derivation:{preparation:{kind:'mean-downsample',factor:tier.stage.coordinates.volume!.downsample}}}});
  });
});
