import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { InspectionCommands } from '../src/inspection-commands.js';

function fixture(){
  let time=0;
  const commands=new InspectionCommands(()=>time);
  const binding={serverEpoch:randomUUID(),sourceToken:randomUUID(),stateRevision:0,inspectionRevision:1};
  const expected=(value=binding)=>({serverEpoch:value.serverEpoch,sourceToken:value.sourceToken,
    baseStateRevision:value.stateRevision,baseInspectionRevision:value.inspectionRevision});
  const panelId=commands.attach({...expected(),surface:'companion'},binding);
  const input={...expected(),panelId,commandId:'journey',change:{kind:'tour' as const,patch:{action:'start' as const,tourId:'hemoglobin-quaternary-structure'}}};
  const scene:any={sourceSha256:'a',modelNumber:1,assemblyId:'asymmetric_unit',selectionKeys:[],inspection:{appearance:{},placement:{}}};
  commands.enqueue(input,binding,scene);
  const delivery=commands.poll({...expected(),panelId,availability:'ready'},binding).delivery!;
  const claim={...expected(),panelId,commandId:'journey',claimToken:delivery.claimToken};
  commands.admit(claim,binding);
  return {commands,binding,expected,panelId,input,scene,claim,setTime:(value:number)=>{time=value;}};
}

it('retains one immutable claim and deadline through a host-verified tour source transition',()=>{
  const f=fixture();f.commands.beginTourTransition(f.claim,f.binding);
  expect(()=>f.commands.beginTourTransition(f.claim,f.binding)).toThrow('Only one');
  for(const altered of [{panelId:randomUUID()},{claimToken:randomUUID()},{sourceToken:randomUUID()}]){
    expect(()=>f.commands.assertTourTransition({...f.claim,...altered},f.binding)).toThrow('does not belong');
  }
  const next={...f.binding,sourceToken:randomUUID(),stateRevision:1,inspectionRevision:0};
  f.commands.advanceTourTransition(f.claim,f.binding,next);
  expect(()=>f.commands.complete({...f.claim,scene:f.scene},next)).toThrow('experience acknowledgement');
  f.setTime(120000);
  expect(()=>f.commands.assertTourTransition(f.claim,next)).toThrow('expired or was superseded');
  expect(f.commands.summary(next,'journey').command).toMatchObject({status:'unconfirmed',reason:'The panel did not confirm this command before its deadline.'});
});

it('a correction can cancel a tour while its original panel is hydrating a new source',()=>{
  const f=fixture();f.commands.beginTourTransition(f.claim,f.binding);
  const next={...f.binding,sourceToken:randomUUID(),stateRevision:1,inspectionRevision:0};
  f.commands.advanceTourTransition(f.claim,f.binding,next);
  f.commands.detach({...f.expected(),panelId:f.panelId,reason:'loading'},next);
  const correction=f.commands.controlUtterance({...f.expected(),panelId:f.panelId,commandId:'correction',
    change:{kind:'utterance',patch:{action:'correct'}}},next);
  expect(correction.commands).toContainEqual(expect.objectContaining({commandId:'journey',status:'superseded'}));
  expect(()=>f.commands.advanceTourTransition(f.claim,next,{...next,inspectionRevision:1})).toThrow('superseded');
  expect(f.commands.failTourTransition(f.claim,next,'render_failed').command.status).toBe('superseded');
  expect(f.commands.settled(f.claim).settled).toBe(true);
});

it('a failed journey restore cannot issue a rendered tour receipt',()=>{
  const f=fixture();f.commands.beginTourTransition(f.claim,f.binding);
  f.commands.restoringTourTransition(f.claim,f.binding);
  expect(()=>f.commands.completeTourTransition(f.claim,f.panelId,f.binding)).toThrow('not a rendered tour command');
  expect(f.commands.failTourTransition(f.claim,f.binding,'render_failed','Chapter draw failed; previous view restored.'))
    .toMatchObject({accepted:false,command:{status:'rejected',detail:'Chapter draw failed; previous view restored.'}});
  expect(f.commands.enqueue(f.input,f.binding,f.scene).status).toBe('rejected');
  expect(()=>f.commands.enqueue({...f.input,change:{kind:'tour',patch:{action:'next'}}},f.binding,f.scene)).toThrow('different request');
});
