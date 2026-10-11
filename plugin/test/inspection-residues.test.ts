import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { inspectionResiduePage, inspectionResidueQuerySchema } from '../src/inspection-residues.js';
import { extractInspectionCatalogBytes } from '../src/inspection-catalog.js';

const row=(key:string, identity:Partial<any>={}, coordinateState='resolved')=>({key,coordinateState,atomSites:[{private:'never returned'}],identity:{
  modelNumber:1,assemblyId:'asymmetric_unit',copyId:'copy-0',entityId:'1',labelChain:'A',authorChain:'A',labelSequenceId:1,authorResidue:1,insertionCode:'',componentId:'GLY',...identity,
}});
const catalog={rows:[
  row('a1'),
  row('a2',{labelSequenceId:2,authorResidue:2,componentId:'ALA'}),
  row('a2i',{labelSequenceId:3,authorResidue:2,insertionCode:'A',componentId:'SER'},'unresolved'),
  row('b1',{labelChain:'B',authorChain:'X',labelSequenceId:1,authorResidue:-1,componentId:'HOH'}),
  row('model2',{modelNumber:2,labelChain:'A',labelSequenceId:1,authorResidue:1}),
]};
const scene={sourceSha256:'0'.repeat(64),modelNumber:1,assemblyId:'asymmetric_unit',selectionKeys:['a2','b1'],camera:{},inspection:{}} as any;
const query=(value:unknown={})=>inspectionResidueQuerySchema.parse(value);

describe('inspection residue pages',()=>{
  it('returns an active-model, bounded identity page without atom sites or coordinates',()=>{
    const result=inspectionResiduePage(catalog,scene,query({offset:1,limit:2}));
    expect(result).toMatchObject({total:4,offset:1,limit:2,rows:[
      {key:'a2',coordinateState:'resolved',selected:true,identity:{modelNumber:1,assemblyId:'asymmetric_unit',copyId:'copy-0',labelChain:'A',authorChain:'A',labelSequenceId:2,authorResidue:2,insertionCode:'',componentId:'ALA'}},
      {key:'a2i',coordinateState:'unresolved',selected:false,identity:{authorResidue:2,insertionCode:'A',componentId:'SER'}},
    ]});
    expect(JSON.stringify(result)).not.toContain('atomSites');
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('pages the actual extracted catalog without leaking atom-site detail',async()=>{
    const cif=await readFile(new URL('../../fixtures/1CRN.cif',import.meta.url));
    const extracted:any=await extractInspectionCatalogBytes(cif);
    const active=extracted.rows.find((entry:any)=>entry.identity.modelNumber===extracted.modelNumbers[0]);
    const result=inspectionResiduePage(extracted,{modelNumber:extracted.modelNumbers[0],selectionKeys:[active.key]} as any,query({selectedOnly:true}));
    expect(result).toMatchObject({total:1,rows:[{key:active.key,selected:true,coordinateState:active.coordinateState,identity:{
      modelNumber:active.identity.modelNumber,copyId:active.identity.copyId,insertionCode:active.identity.insertionCode,
    }}]});
    expect(JSON.stringify(result)).not.toContain('assemblyCoordinatesAngstrom');
  });

  it('filters canonical labels, author identities, residue ranges and saved selection',()=>{
    expect(inspectionResiduePage(catalog,scene,query({labelChain:'A',authorResidueRange:[2,2]})).rows.map(row=>row.key)).toEqual(['a2','a2i']);
    expect(inspectionResiduePage(catalog,scene,query({labelSequenceRange:[3,3],componentId:'SER'})).rows.map(row=>row.key)).toEqual(['a2i']);
    expect(inspectionResiduePage(catalog,scene,query({authorChain:'X',selectedOnly:true})).rows.map(row=>row.key)).toEqual(['b1']);
    expect(inspectionResiduePage(catalog,scene,query({selectedOnly:true})).rows.map(row=>row.key)).toEqual(['a2','b1']);
  });

  it('rejects unbounded, malformed and unsaved lookups instead of selecting a guessed model',()=>{
    for (const bad of [
      {limit:129},{offset:-1},{labelSequenceRange:[4,3]},{authorResidueRange:[2,-1]},
      {labelChain:''},{selectedOnly:'yes'},{unknown:true},
    ]) expect(()=>query(bad)).toThrow();
    expect(()=>inspectionResiduePage(catalog,null,query())).toThrow(/save the inspection/i);
  });
});
