import { describe, expect, it } from 'vitest';
import { InspectionCommands } from '../src/inspection-commands.js';
import type { InspectionScene } from '../src/inspection-contract.js';

const binding={serverEpoch:'epoch',sourceToken:'source',stateRevision:4,inspectionRevision:7};
const expected=()=>({serverEpoch:binding.serverEpoch,sourceToken:binding.sourceToken,
  baseStateRevision:binding.stateRevision,baseInspectionRevision:binding.inspectionRevision});
const scene=(selectionKeys=['one']):InspectionScene=>({sourceSha256:'a'.repeat(64),modelNumber:1,assemblyId:'1',selectionKeys,
  camera:{mode:'perspective',fov:45,position:[0,0,10],target:[0,0,0],up:[0,1,0],radius:4,radiusMax:8,fog:50,clipFar:true,minNear:.1,minFar:1},
  inspection:{appearance:{representation:'cartoon',color:'chain-id',uniformColor:'#ffffff',background:'#000000',highlightColor:'#ffff00',opacity:1,labels:true,clipping:0,fog:50},
    placement:{translation:[0,0,0],rotation:[0,0,0],scale:1}}});

function panel() {
  const commands=new InspectionCommands(()=>100);
  const panelId=commands.attach({...expected(),surface:'companion'},binding);
  return {commands,panelId};
}
function claim(commands:InspectionCommands,panelId:string) {
  return commands.poll({...expected(),panelId,availability:'ready'},binding) as any;
}

describe('target-bound named-view commands',()=>{
  it('captures the targeted panel scene without committing it as a shared mutation',()=>{
    const {commands,panelId}=panel();
    const receipt=commands.enqueueView({...expected(),panelId,commandId:'save-one',change:{kind:'save-view',patch:{name:'Site'}}},binding,scene());
    expect(receipt.status).toBe('queued');
    const delivery=claim(commands,panelId).delivery;
    expect(delivery.change).toEqual({kind:'save-view',patch:{name:'Site'}});
    const captured=scene(['panel-local']);
    const done=commands.complete({...expected(),panelId,commandId:'save-one',claimToken:delivery.claimToken,scene:captured},binding) as any;
    expect(done).toMatchObject({accepted:true,capturedScene:captured});
    expect(done).not.toHaveProperty('scene');
  });

  it('deduplicates a save command and refuses a changed duplicate',()=>{
    const {commands,panelId}=panel();
    const request={...expected(),panelId,commandId:'save-once',change:{kind:'save-view' as const,patch:{name:'Site'}}};
    expect(commands.enqueueView(request,binding,scene())).toMatchObject({status:'queued'});
    expect(commands.enqueueView(request,binding,scene())).toMatchObject({status:'queued'});
    expect(()=>commands.enqueueView({...request,change:{kind:'save-view',patch:{name:'Other'}}},binding,scene())).toThrow(/commandId/);
  });

  it('bounds completed captures at an unchanged revision without losing retry tombstones',()=>{
    const {commands,panelId}=panel();
    for(let i=0;i<32;i++) {
      const request={...expected(),panelId,commandId:`save-${i}`,change:{kind:'save-view' as const,patch:{name:`View ${i}`}}};
      commands.enqueueView(request,binding,scene());
      const delivery=claim(commands,panelId).delivery;
      expect(commands.complete({...expected(),panelId,commandId:`save-${i}`,claimToken:delivery.claimToken,scene:scene()},binding))
        .toMatchObject({accepted:true,command:{status:'rendered'}});
    }
    const first={...expected(),panelId,commandId:'save-0',change:{kind:'save-view' as const,patch:{name:'View 0'}}};
    expect(commands.enqueueView(first,binding,scene())).toMatchObject({status:'rendered'});
    expect(()=>commands.enqueueView({...expected(),panelId,commandId:'save-32',
      change:{kind:'save-view',patch:{name:'View 32'}}},binding,scene())).toThrow(/32 completed named-view commands/);
    expect(()=>commands.enqueueView({...first,change:{kind:'save-view',patch:{name:'Changed'}}},binding,scene())).toThrow(/commandId/);
  });

  it('prunes terminal old-source receipts after revisions restart, preserving tool retry tombstones',()=>{
    const {commands,panelId}=panel();
    for(let i=0;i<32;i++) {
      const request={...expected(),panelId,commandId:`old-${i}`,change:{kind:'save-view' as const,patch:{name:`View ${i}`}}};
      commands.enqueueView(request,binding,scene());
      commands.rememberToolRequest('manage_inspection_view',request,request.commandId);
      const delivery=claim(commands,panelId).delivery;
      commands.complete({...expected(),panelId,commandId:request.commandId,claimToken:delivery.claimToken,scene:scene()},binding);
    }
    const next={...binding,sourceToken:'new-source',stateRevision:5,inspectionRevision:1};
    const bound={serverEpoch:next.serverEpoch,sourceToken:next.sourceToken,baseStateRevision:next.stateRevision,baseInspectionRevision:next.inspectionRevision};
    const nextPanel=commands.attach(bound,next);
    const request={...bound,panelId:nextPanel,commandId:'new-source-edit',change:{kind:'appearance' as const,patch:{color:'chain-id' as const}}};
    expect(commands.enqueue(request,next,scene())).toMatchObject({status:'queued'});
    expect(()=>commands.enqueue({...request,commandId:'old-0'},next,scene())).toThrow(/commandId|receipt/);
    expect(commands.summary(next,'old-1').command?.status).toBe('rendered');
  });

  it('refuses save from unsaved, stale, and wrong panels',()=>{
    const {commands,panelId}=panel();
    commands.poll({...expected(),panelId,availability:'unsaved'},binding);
    const input={...expected(),panelId,commandId:'blocked',change:{kind:'save-view' as const,patch:{name:'Site'}}};
    expect(()=>commands.enqueueView(input,binding,scene())).toThrow(/unsaved work/);
    expect(()=>commands.enqueueView({...input,panelId:'00000000-0000-4000-8000-000000000000'},binding,scene())).toThrow(/target panel/);
    expect(()=>commands.enqueueView({...input,baseInspectionRevision:6},binding,scene())).toThrow(/current saved revisions/);
  });

  it('restores scientific state while allowing the renderer to preserve its local camera',()=>{
    const {commands,panelId}=panel(); const wanted=scene(['saved']);
    commands.enqueueView({...expected(),panelId,commandId:'restore-one',change:{kind:'restore-view',patch:{viewId:'view',scene:wanted}}},binding,scene());
    const delivery=claim(commands,panelId).delivery;
    const actual=structuredClone(wanted);actual.camera.position=[10,0,0];
    const done=commands.complete({...expected(),panelId,commandId:'restore-one',claimToken:delivery.claimToken,scene:actual},binding) as any;
    expect(done).toMatchObject({accepted:true,scene:actual});
  });

  it('reports a transient capture refusal as a clean refusal receipt',()=>{
    const {commands,panelId}=panel();
    commands.enqueueView({...expected(),panelId,commandId:'save-held',change:{kind:'save-view' as const,patch:{name:'Site'}}},binding,scene());
    const delivery=claim(commands,panelId).delivery;
    const done=commands.complete({...expected(),panelId,commandId:'save-held',claimToken:delivery.claimToken,
      failure:'capture_refused',failureReason:'Hold still and release the grip, then save again.'},binding);
    expect(done).toMatchObject({accepted:false,command:{status:'rejected',reason:'capture_refused',
      detail:'Hold still and release the grip, then save again.'}});
  });

  it('leaves a mismatched scientific restore unconfirmed',()=>{
    const {commands,panelId}=panel(); const wanted=scene(['saved']);
    commands.enqueueView({...expected(),panelId,commandId:'restore-bad',change:{kind:'restore-view',patch:{viewId:'view',scene:wanted}}},binding,scene());
    const delivery=claim(commands,panelId).delivery;
    const actual=structuredClone(wanted);actual.inspection.placement.scale=2;
    expect(commands.complete({...expected(),panelId,commandId:'restore-bad',claimToken:delivery.claimToken,scene:actual},binding))
      .toMatchObject({accepted:false,command:{status:'unconfirmed'}});
  });
});
