import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createStereoStructureServer } from '../src/server.js';
import { PRIVATE_INSPECTION_META_KEY as PRIVATE_KEY } from '../src/inspection-contract.js';
import { choosePanel, COMPANION_LOADING_MESSAGE } from '../scripts/agent-arguments.js';

const cif = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');

type Binding = {
  sessionId: string;
  serverEpoch: string;
  sourceToken: string;
  baseStateRevision: number;
  baseInspectionRevision: number;
};

async function setup(options:any={}) {
  const clock = { now: 0 };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createStereoStructureServer(undefined, { now: () => clock.now,...options });
  const client = new Client({ name: 'Stereofold inspection command test', version: '1' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown>) => client.callTool({
    name: `stereo_structure.${name}`,
    arguments: args,
  }) as Promise<any>;
  const opened = await call('inspect', { structureText: cif });
  expect(opened.isError).not.toBe(true);
  const sessionId = opened.structuredContent.sessionId as string;
  const hydrated = await call('get_inspection', { sessionId });
  const privateData = hydrated._meta[PRIVATE_KEY];
  const scene = {
    sourceSha256: privateData.catalog.source.sha256,
    modelNumber: privateData.catalog.modelNumbers[0],
    assemblyId: privateData.catalog.assemblyId,
    selectionKeys: [privateData.catalog.rows[0].key],
    camera: {
      mode: 'perspective', fov: Math.PI / 4, position: [0, 0, 80], target: [0, 0, 0], up: [0, 1, 0],
      radius: 20, radiusMax: 20, fog: 50, clipFar: true, minNear: 5, minFar: 0,
    },
    inspection: {
      appearance: { representation: 'cartoon', color: 'chain-id', uniformColor: '#58dcc9', background: '#071015', opacity: 1, labels: false, highlightColor: '#f2c47c', clipping: 0, fog: 0 },
      placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 },
    },
  };
  const initial: Binding = {
    sessionId,
    serverEpoch: privateData.serverEpoch,
    sourceToken: privateData.sourceToken,
    baseStateRevision: privateData.stateRevision,
    baseInspectionRevision: privateData.inspectionRevision,
  };
  const saved = await call('sync_inspection', { ...initial, scene });
  expect(saved.structuredContent.saved).toBe(true);
  const binding: Binding = {
    ...initial,
    baseStateRevision: saved.structuredContent.stateRevision,
    baseInspectionRevision: saved.structuredContent.inspectionRevision,
  };
  const attached = await call('attach_inspection', binding);
  const panelId = attached.structuredContent.panelId as string;
  const current = async (commandId?: string) => call('get_inspection_state', {
    sessionId,
    ...(commandId == null ? {} : { commandId }),
  });
  const poll = async (availability: 'ready' | 'busy' | 'unsaved' = 'ready', expected = binding, panel = panelId) => {
    const result = await call('poll_inspection', { ...expected, panelId: panel, availability });
    return { result, delivery: result._meta?.[PRIVATE_KEY]?.delivery };
  };
  const close = async () => { await client.close(); await server.close(); };
  return { clock, client, server, call, sessionId, scene, binding, panelId, current, poll, close };
}

function update(binding: Binding, panelId: string, commandId: string, change: Record<string, unknown>) {
  return { ...binding, panelId, commandId, change };
}


async function begin(t:Awaited<ReturnType<typeof setup>>,id:string,action='begin',utteranceId?:string) {
  const r=await t.call('update_inspection',{...t.binding,panelId:t.panelId,commandId:id,
    ...(utteranceId?{utteranceId}:{}),change:{kind:'utterance',patch:{action}}});
  expect(r.isError).not.toBe(true);
  return r.structuredContent.lifecycle;
}
async function edit(t:Awaited<ReturnType<typeof setup>>,id:string,u:string,change:any={kind:'appearance',patch:{opacity:0.5}}) {
  return t.call('update_inspection',{...t.binding,panelId:t.panelId,commandId:id,utteranceId:u,change});
}
async function finish(t:Awaited<ReturnType<typeof setup>>,delivery:any,scene=t.scene,phase?:string) {
  return t.call('complete_inspection',{...t.binding,panelId:t.panelId,commandId:delivery.commandId,claimToken:delivery.claimToken,
    ...(phase?{phase}:{scene})});
}
it('V21: interrupting a later request preserves an already rendered change (native audio unverified)',async()=>{
  const t=await setup();try {
    const u=(await begin(t,'begin-1')).utterance;
    await edit(t,'change-1',u.utteranceId);
    const d=(await t.poll()).delivery;
    const changed=structuredClone(t.scene);changed.inspection.appearance.opacity=0.5;
    const done=await finish(t,d,changed);t.binding.baseInspectionRevision=done.structuredContent.inspectionRevision;await t.poll();
    const cancelled=await begin(t,'cancel-1','cancel');
    expect(cancelled.commands).toEqual([]);
    expect((await t.current('change-1')).structuredContent.command.status).toBe('rendered');
  }finally{await t.close();}
});
it('V22: correction supersedes the queued old selection and only the replacement renders',async()=>{
  const t=await setup();try {
    const a=(await begin(t,'begin-a')).utterance;
    await edit(t,'select-a',a.utteranceId,{kind:'selection',patch:{selectionKeys:[]}});
    const b=await begin(t,'correct-b','correct');
    expect(b.utterance.sequence).toBeGreaterThan(a.sequence);
    expect(b.commands[0]).toMatchObject({commandId:'select-a',status:'superseded',supersededBy:b.utterance.utteranceId,fenceReleased:'pending'});
    const replay=await edit(t,'late-a',a.utteranceId);
    expect(replay.isError).toBe(true);expect(replay.content[0].text).toContain('superseded');
    await edit(t,'select-b',b.utterance.utteranceId,{kind:'selection',patch:{selectionKeys:t.scene.selectionKeys}});
    const d=(await t.poll()).delivery;expect(d.commandId).toBe('select-b');
    expect((await finish(t,d)).structuredContent.command.status).toBe('rendered');
  }finally{await t.close();}
});
it('V23: cancelling a pending scene command leaves the last good scene intact (transfer staging out of scope)',async()=>{
  const t=await setup();try {
    const a=(await begin(t,'begin-a')).utterance;
    await edit(t,'pending',a.utteranceId);
    const cancelled=await begin(t,'cancel','cancel');
    expect(cancelled.commands[0].status).toBe('cancelled');
    expect((await t.poll()).delivery).toBeUndefined();
    expect((await t.current()).structuredContent.inspectionRevision).toBe(t.binding.baseInspectionRevision);
    expect(await begin(t,'cancel','cancel')).toEqual(cancelled);
  }finally{await t.close();}
});
it('V25: distinct utterances repeat an absolute 125 percent scale without compounding',async()=>{
  const t=await setup();try {
    for(const id of ['one','two']) {
      const u=(await begin(t,'begin-'+id)).utterance;
      const change={kind:'placement',patch:{scale:1.25}};
      expect((await edit(t,id,u.utteranceId,change)).structuredContent.command.status).toBe('queued');
      const changed=structuredClone(t.scene);changed.inspection.placement.scale=1.25;
      const done=await finish(t,(await t.poll()).delivery,changed);
      expect(done.structuredContent.command.status).toBe('rendered');
      t.binding.baseInspectionRevision=done.structuredContent.inspectionRevision;
      await t.poll();
    }
    const saved=await t.call('get_inspection',{sessionId:t.sessionId});
    expect(saved._meta[PRIVATE_KEY].scene.inspection.placement.scale).toBe(1.25);
  }finally{await t.close();}
});
it('V26: duplicate rotation delivery returns the same receipt and cannot admit twice',async()=>{
  const t=await setup();try {
    const u=(await begin(t,'begin')).utterance;
    const change={kind:'placement',patch:{rotation:[0,15,0]}};
    const queued=await edit(t,'rotate',u.utteranceId,change);
    expect((await edit(t,'rotate',u.utteranceId,change)).structuredContent.command).toEqual(queued.structuredContent.command);
    const d=(await t.poll()).delivery;
    expect((await finish(t,d,t.scene,'admit')).structuredContent.admitted).toBe(true);
    expect((await finish(t,d,t.scene,'admit')).structuredContent.admitted).toBe(false);
    const changed=structuredClone(t.scene);changed.inspection.placement.rotation=[0,15,0];
    const done=await finish(t,d,changed);
    expect((await finish(t,d,changed)).structuredContent.command).toEqual(done.structuredContent.command);
    expect((await edit(t,'rotate',u.utteranceId,change)).structuredContent.command).toEqual(done.structuredContent.command);
    expect((await edit(t,'rotate',u.utteranceId)).isError).toBe(true);
  }finally{await t.close();}
});
it('V27: withheld receipt stays rendering, then reconciles without a second delivery',async()=>{
  const t=await setup();try {
    const u=(await begin(t,'begin')).utterance;await edit(t,'held',u.utteranceId);
    const d=(await t.poll()).delivery;
    expect((await t.current('held')).structuredContent.command.status).toBe('rendering');
    expect((await t.poll()).delivery).toBeUndefined();
    const changed=structuredClone(t.scene);changed.inspection.appearance.opacity=0.5;
    expect((await finish(t,d,changed)).structuredContent.command.status).toBe('rendered');
  }finally{await t.close();}
});
it('V28: an utterance from another task/session cannot retarget this inspection',async()=>{
  const t=await setup(),other=await setup();try {
    const u=(await begin(t,'begin')).utterance;
    const wrong=await edit(other,'wrong',u.utteranceId);
    expect(wrong.isError).toBe(true);expect(wrong.content[0].text).toContain('does not belong');
    expect((await t.poll()).delivery).toBeUndefined();expect((await other.poll()).delivery).toBeUndefined();
  }finally{await t.close();await other.close();}
});
it('V29: saved revision changes reject an old utterance even with refreshed command revisions',async()=>{
  const t=await setup();try {
    const u=(await begin(t,'begin')).utterance;await edit(t,'old',u.utteranceId);
    const d=(await t.poll()).delivery;
    const changed=structuredClone(t.scene);changed.inspection.appearance.opacity=0.7;
    const saved=await t.call('sync_inspection',{...t.binding,scene:changed});
    t.binding.baseInspectionRevision=saved.structuredContent.inspectionRevision;
    const late=await edit(t,'late',u.utteranceId);
    expect(late.isError).toBe(true);expect(late.content[0].text).toContain('changed since this utterance');
    // The original delivery retains its original revision, not the refreshed one.
    const admitted=await t.call('complete_inspection',{...t.binding,baseInspectionRevision:t.binding.baseInspectionRevision-1,
      panelId:t.panelId,commandId:d.commandId,claimToken:d.claimToken,phase:'admit'});
    expect(admitted.structuredContent.admitted).toBe(false);
  }finally{await t.close();}
});
it('race: utterances 100 ms apart accept the correction before the old result completes; render fence prevents overwrite',async()=>{
  const t=await setup();try {
    const a=(await begin(t,'a')).utterance;await edit(t,'old',a.utteranceId);
    const old=(await t.poll()).delivery;expect((await finish(t,old,t.scene,'admit')).structuredContent.admitted).toBe(true);
    t.clock.now+=100;
    const b=(await begin(t,'b','correct')).utterance;
    expect((await edit(t,'new',b.utteranceId,{kind:'appearance',patch:{opacity:0.8}})).structuredContent.command.status).toBe('queued');
    expect((await t.poll()).delivery).toBeUndefined();
    const stale=structuredClone(t.scene);stale.inspection.appearance.opacity=0.5;
    expect((await finish(t,old,stale)).structuredContent).toMatchObject({accepted:false,command:{status:'superseded'}});
    expect((await t.poll()).delivery).toBeUndefined();
    expect((await t.current()).structuredContent.pendingCommand[0]).toMatchObject({utteranceId:a.utteranceId,renderFence:true,status:'superseded'});
    await finish(t,old,t.scene,'settled');
    const next=(await t.poll()).delivery;expect(next.commandId).toBe('new');
    const corrected=structuredClone(t.scene);corrected.inspection.appearance.opacity=0.8;
    expect((await finish(t,next,corrected)).structuredContent.command.status).toBe('rendered');
    expect((await finish(t,old,stale)).structuredContent.command.status).toBe('superseded');
    expect((await t.current()).structuredContent.inspectionRevision).toBe(t.binding.baseInspectionRevision+1);
  }finally{await t.close();}
});
it('a delivered cancellation refuses admission and rejects a forged settlement claim',async()=>{
  const t=await setup();try {
    const u=(await begin(t,'begin')).utterance;await edit(t,'old',u.utteranceId);
    const d=(await t.poll()).delivery;
    await begin(t,'cancel','cancel');
    expect((await finish(t,d,t.scene,'admit')).structuredContent).toMatchObject({admitted:false,command:{status:'superseded'}});
    const forged=await finish(t,{...d,claimToken:randomUUID()},t.scene,'settled');expect(forged.isError).toBe(true);
    expect((await t.current()).structuredContent.pendingCommand[0].renderFence).toBe(true);
    await finish(t,d,t.scene,'settled');
    expect((await t.current()).structuredContent.pendingCommand).toEqual([]);
  }finally{await t.close();}
});
it('a correction action cannot change its payload under the same command ID',async()=>{
  const t=await setup();try {
    await begin(t,'control','begin');
    const changed=await t.call('update_inspection',{...t.binding,panelId:t.panelId,commandId:'control',change:{kind:'utterance',patch:{action:'cancel'}}});
    expect(changed.isError).toBe(true);expect(changed.content[0].text).toContain('different request');
  }finally{await t.close();}
});
it('host sequences follow recording start, not transcript completion; stale replies cannot reclaim the turn',async()=>{
  const entries:any[]=[];
  const transcriber={enabled:true,ready:true,route:'whisper',describe:()=>'fixture',missing:()=>[],startupLine:()=>'',dispose:async()=>{},
    accept:async(input:any)=>{if(input.final) entries.push({utteranceId:input.utteranceId,text:'question',receivedAt:new Date().toISOString(),durationMs:100,cursor:entries.length+1});
      return {accepted:true,utteranceId:input.utteranceId,seq:input.seq,final:input.final,reason:'chunk',message:'Fixture'};},
    transcripts:{get cursor(){return entries.length;},since:async(after:number)=>({cursor:entries.length,entries:entries.filter(e=>e.cursor>after)})}};
  const t=await setup({transcriber});try {
    const panelId=(await t.call('attach_inspection',{...t.binding,surface:'companion'})).structuredContent.panelId;
    const a=randomUUID(),b=randomUUID();
    const chunk=(utteranceId:string,seq:number,final:boolean)=>t.call('push_to_talk_audio',{sessionId:t.sessionId,panelId,utteranceId,seq,final,mime:'audio/webm',...(seq===0?{data:'AAAA'}:{})});
    await chunk(a,0,false);await chunk(a,0,false);t.clock.now+=100;await chunk(b,0,false);
    await chunk(b,1,true);
    const second=await t.call('listen_voice',{timeoutSeconds:1});
    expect(second.structuredContent.transcripts[0]).toMatchObject({utteranceId:b,utteranceSequence:2});
    await chunk(a,1,true);
    const first=await t.call('listen_voice',{timeoutSeconds:1,cursor:second.structuredContent.cursor});
    expect(first.structuredContent.transcripts[0]).toMatchObject({utteranceId:a,utteranceSequence:1});
    const reply=await t.call('say_to_headset',{text:'Old answer.',utteranceId:a,speak:false});
    expect(reply.structuredContent).toMatchObject({stale:true,queued:false,activeUtteranceId:b});
    await t.call('update_inspection',{...t.binding,panelId,commandId:'correction',utteranceId:b,change:{kind:'utterance',patch:{action:'correct'}}});
    const refused=await t.call('update_inspection',{...t.binding,panelId,commandId:'late',utteranceId:a,change:{kind:'appearance',patch:{opacity:0.5}}});
    expect(refused.isError).toBe(true);expect(refused.content[0].text).toContain('superseded');
  }finally{await t.close();}
});

it.each(['complete-overwrite','missing-field','different-scene','not-admitted','no-opt-in'] as const)('same-field handoff requires an admitted exact draw and a complete overwrite: %s', async path => {
    const t=await setup();
    try {
      const first=(await begin(t,'d82-first')).utterance.utteranceId;
      await edit(t,'d82-old',first,{kind:'appearance',patch:{representation:'molecular-surface',opacity:.5}});
      const old=(await t.poll()).delivery;
      if(path!=='not-admitted')await finish(t,old,t.scene,'admit');
      const correction=(await begin(t,'d82-new','correct')).utterance.utteranceId;
      await edit(t,'d82-replacement',correction,{kind:'appearance',patch:{representation:'cartoon',...(path==='missing-field'?{}:{opacity:1})}});
      const drawn=structuredClone(t.scene);
      Object.assign(drawn.inspection.appearance,{representation:'molecular-surface',opacity:.5});
      if(path==='different-scene')drawn.selectionKeys=[];
      const response=await t.call('complete_inspection',{...t.binding,panelId:t.panelId,commandId:old.commandId,claimToken:old.claimToken,
        scene:drawn,...(path==='no-opt-in'?{}:{allowReplacement:true})});
      expect(response.isError).not.toBe(true);
      expect(response.structuredContent).toMatchObject({accepted:false,command:{status:'superseded',fenceReleased:'pending'}});
      const replacement=response._meta?.[PRIVATE_KEY]?.replacement;
      if(path==='complete-overwrite') {
        expect(replacement).toMatchObject({commandId:'d82-replacement',panelId:t.panelId,utteranceId:correction});
        expect(response.structuredContent.replacement).toBeUndefined(); // Claim stays app-private.
        // Replaying a lost response returns this claim; it never allocates another.
        const replay=await t.call('complete_inspection',{...t.binding,panelId:t.panelId,commandId:old.commandId,claimToken:old.claimToken,scene:drawn,allowReplacement:true});
        expect(replay._meta[PRIVATE_KEY].replacement).toEqual(replacement);
        expect((await finish(t,replacement,t.scene,'admit')).structuredContent.admitted).toBe(true);
        expect((await finish(t,replacement,t.scene,'admit')).structuredContent.admitted).toBe(false);
        expect((await finish(t,replacement)).structuredContent.command.status).toBe('rendered');
        expect((await t.current('d82-old')).structuredContent.command.fenceReleased).toBe('replacement-rendered');
      } else {
        expect(replacement).toBeUndefined();
        expect((await t.current('d82-replacement')).structuredContent.command.status).toBe('queued');
        expect((await t.poll()).delivery).toBeUndefined();
      }
    } finally { await t.close(); }
  });
