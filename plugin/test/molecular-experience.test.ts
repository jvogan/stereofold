import { describe, expect, it } from 'vitest';
import { MOLECULAR_EXPERIENCES, TUBULIN_EB3_EXPERIENCE, stageForStep, validateExperienceAssembly } from '../src/molecular-experience.js';

describe('source-verified molecular experiences',()=>{
  it('ships ten real definitions with twenty source-bound steps each',()=>{
    expect(MOLECULAR_EXPERIENCES).toHaveLength(10);
    expect(new Set(MOLECULAR_EXPERIENCES.map(value=>value.id)).size).toBe(10);
    for(const experience of MOLECULAR_EXPERIENCES) {
      expect(experience.steps).toHaveLength(20);
      expect(experience.steps.every(step=>experience.stages.some(stage=>stage.id===step.stageId))).toBe(true);
      expect(experience.stages.every(stage=>stage.source.kind==='public-pdb' && stage.source.revisionPolicy==='runtime-verified')).toBe(true);
      expect(new Set(experience.steps.map(step=>step.body)).size).toBe(20);
      expect(experience.steps.every(step=>step.selectionEntityIds?.length)).toBe(true);
      for(const step of experience.steps) {
        const stage=experience.stages.find(candidate=>candidate.id===step.stageId)!;
        expect(!stage.assembly.visibleEntityIds.length || step.selectionEntityIds!.every(entity=>stage.assembly.visibleEntityIds.includes(entity))).toBe(true);
      }
      for(const stage of experience.stages) {
        const visible=new Set(stage.assembly.visibleEntityIds);
        expect(!visible.size || stage.assembly.selectedEntityIds.every(entity=>visible.has(entity))).toBe(true);
      }
    }
    const allBodies=MOLECULAR_EXPERIENCES.flatMap(experience=>experience.steps.map(step=>step.body));
    expect(new Set(allBodies).size).toBeGreaterThanOrEqual(190);
    for(const experience of MOLECULAR_EXPERIENCES) expect(new Set(experience.steps.map(step=>`${step.appearance.representation}/${step.appearance.color}/${step.selectionEntityIds?.join(',')}`)).size).toBeGreaterThanOrEqual(6);
    expect(TUBULIN_EB3_EXPERIENCE.stages.find(stage=>stage.id==='protofilament-slice')?.assembly.activeOperatorIds).toEqual(['1','14']);
    expect(TUBULIN_EB3_EXPERIENCE.stages.find(stage=>stage.id==='eb3-decorated-lattice')?.provenance.labels).toContain('EB3');
  });

  it('uses four distinct public structures for the illustrative binder workflow',()=>{
    const binder=MOLECULAR_EXPERIENCES.find(experience=>experience.id==='public-binder-workflow')!;
    expect(binder.stages.map(stage=>stage.source.pdbId)).toEqual(['1YCR','1EMA','4FFB','1CRN']);
    expect(binder.steps.map(step=>step.stageId)).toEqual([
      ...Array(5).fill('peptide-interface'), ...Array(5).fill('folded-target'),
      ...Array(5).fill('protein-module'), ...Array(5).fill('compact-control'),
    ]);
    expect(binder.steps.map(step=>step.body).join(' ')).toMatch(/RFdiffusion/);
    expect(binder.steps.map(step=>step.body).join(' ')).toMatch(/ProteinMPNN/);
    expect(binder.steps.map(step=>step.body).join(' ')).toMatch(/Boltz or OpenFold/);
  });

  it('declares reviewed component selections for Cas9 and telomerase sources',()=>{
    const stages=Object.fromEntries(MOLECULAR_EXPERIENCES.flatMap(experience=>experience.stages.map(stage=>[experience.id,stage])));
    expect(stages['cas9-ternary-complex'].assembly).toMatchObject({visibleEntityIds:['1','2','3','4'],selectedEntityIds:['1','2']});
    expect(stages['telomerase-rnp-lobe'].assembly).toMatchObject({visibleEntityIds:['1','2','3','4','5','6'],selectedEntityIds:['5','6']});
    expect(stages['telomerase-holoenzyme'].assembly).toMatchObject({visibleEntityIds:['1','2','3','4','5','6','7'],selectedEntityIds:['5','6']});
  });

  it('counts only declared visible entities and operators when enforcing a protofilament budget',()=>{
    const stage=stageForStep(TUBULIN_EB3_EXPERIENCE,5);
    const row=(entityId:string,copyId:string,operatorId:string,coordinate:number[])=>({identity:{entityId,copyId,labelChain:`${entityId}-${copyId}`,operatorIds:[operatorId]},atomSites:[{assemblyCoordinatesAngstrom:coordinate}]});
    const catalog={assemblyId:'1',copies:[{operatorIds:['1']},{operatorIds:['14']},{operatorIds:['2']}],rows:[
      row('1','op-1','1',[0,0,0]),row('2','op-1','1',[1,0,0]),row('1','op-14','14',[0,0,81.5]),row('2','op-14','14',[1,0,81.5]),
      // A full-assembly row must not make the filtered protofilament fail.
      row('1','op-2','2',[900,0,0]),row('2','op-2','2',[901,0,0]),
    ]};
    expect(validateExperienceAssembly(stage,catalog)).toMatchObject({atomSites:4,entityInstances:{'1':2,'2':2}});
    expect(()=>validateExperienceAssembly(stage,{...catalog,copies:[{operatorIds:['1']}]})).toThrow('operator 14');
  });
});
