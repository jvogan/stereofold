import { describe, expect, it } from 'vitest';
import { createInspectionModelContext, optionalInspectionModelContext } from '../src/inspection-server.js';
import { inspectionModelContextSchema } from '../src/inspection-contract.js';

describe('inspection model context', () => {
  it('keeps headset microphone blockers scoped without claiming host voice readiness', () => {
    const readiness={ready:false,blocking:['agent','transcription'] as const,scope:'headset-microphone-session' as const};
    const context=createInspectionModelContext({selectionKeys:[],catalog:{rows:[]},
      readiness:{...readiness,blocking:[...readiness.blocking]}});
    expect(context.readiness).toEqual(readiness);
    expect(inspectionModelContextSchema.parse(context).readiness).toEqual(readiness);
  });

  it('exports a small, shaped projection of selection, lesson, emphasis and readiness', () => {
    const context=createInspectionModelContext({
      selectionKeys:['selected-42','selected-43'],
      catalog:{rows:[
        {key:'selected-42',identity:{labelChain:'A',labelSequenceId:42,insertionCode:'A',componentId:'GLY'}},
        {key:'selected-43',identity:{labelChain:'A',labelSequenceId:43,componentId:'ALA'}},
      ]},
      lesson:{id:'crispr-cas9',title:'CRISPR-Cas9'},
      chapter:{id:'guide-rna',title:'Guide RNA',index:2,total:6},
      emphasis:{parts:[{id:'guide-rna',label:'guide RNA'},{id:'pam',label:'PAM'}],focus:['guide-rna']},
      readiness:{ready:false,blocking:['share']},
    });

    expect(context).toEqual({
      selection:{count:2,residues:['A:42A:GLY','A:43:ALA'],truncated:false},
      lesson:{id:'crispr-cas9',title:'CRISPR-Cas9'},
      chapter:{id:'guide-rna',title:'Guide RNA',index:2,total:6},
      emphasis:{lit:['guide RNA']},
      readiness:{ready:false,blocking:['share']},
    });
    expect(inspectionModelContextSchema.parse(context)).toEqual(context);
    expect(JSON.stringify(context)).not.toContain('selected-42');
    expect(JSON.stringify(context).length).toBeLessThan(700);
  });

  it('names every residue up to the context limit without truncation', () => {
    const context=createInspectionModelContext({
      selectionKeys:Array.from({length:32},(_,index)=>`key-${index}`),catalog:{rows:[]},
      readiness:{ready:true,blocking:[]},
    });
    expect(context.selection).toMatchObject({count:32,truncated:false});
    expect(context.selection.residues).toHaveLength(32);
  });

  it('marks a capped selection as truncated and reports all lit parts for an unfocused key', () => {
    const context=createInspectionModelContext({
      selectionKeys:Array.from({length:33},(_,index)=>`key-${index}`),catalog:{rows:[]},
      emphasis:{parts:[{id:'a',label:'protein'},{id:'b',label:'DNA'}],focus:[]},
      readiness:{ready:true,blocking:[]},
    });
    expect(context.selection).toMatchObject({count:33,truncated:true});
    expect(context.selection.residues).toHaveLength(32);
    expect(context.emphasis).toEqual({lit:['protein','DNA']});
  });

  it('clamps schema limits and drops a context that cannot be built', () => {
    const context=createInspectionModelContext({
      selectionKeys:Array.from({length:20_001},(_,index)=>`key-${index}`),catalog:{rows:[]},
      lesson:{id:'lesson',title:'L'.repeat(200)},
      chapter:{id:'chapter',title:'C'.repeat(200),index:1,total:1},
      readiness:{ready:true,blocking:[]},
    });
    expect(context.selection).toMatchObject({count:20_000,truncated:true});
    expect(context.lesson?.title).toHaveLength(160);
    expect(context.chapter?.title).toHaveLength(160);
    expect(optionalInspectionModelContext(()=>{throw Error('binding changed');})).toBeUndefined();
  });
});
