import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { afterEach, expect, it, vi } from 'vitest';
import { createStereoStructureServer } from '../src/server.js';
import { createPushToTalkTranscriber } from '../src/push-to-talk-transcribe.js';
import { LocalSceneService } from '../src/scene-service.js';
import { InspectionCompanionHttp } from '../src/inspection-companion-http.js';
import { LanCompanion } from '../src/inspection-lan.js';
import { PRIVATE_INSPECTION_META_KEY as KEY } from '../src/inspection-contract.js';
import { HEADSET_CHANNEL_METHOD } from '../src/headset-channel.js';

const cif = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');
const closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks(); });

async function clientFor(scene: LocalSceneService, transcriber = createPushToTalkTranscriber({enabled:false})) {
  const server = createStereoStructureServer(undefined, {sceneService:scene, transcriber});
  // Deliberately no experimental/client channel capabilities: Claude's channel protocol needs none.
  const client = new Client({name:'channel harness',version:'1'});
  const messages: any[] = [];
  client.setNotificationHandler(z.object({method:z.literal(HEADSET_CHANNEL_METHOD),params:z.any()}), n => { messages.push(n.params); });
  const [a,b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  closes.push(async () => { await client.close(); await server.close(); });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({name:`stereo_structure.${name}`,arguments:args}) as any;
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    return result;
  };
  return {server,client,messages,call,transcriber,scene};
}

async function fixture(linked = true) {
  const scene = new LocalSceneService({serverEpoch:randomUUID(),live:()=>true});
  vi.spyOn(scene,'offer').mockResolvedValue(false);
  const t = await clientFor(scene);
  const sessionId = (await t.call('inspect',{structureText:cif})).structuredContent.sessionId;
  vi.spyOn(scene,'share').mockImplementation(async ({assistant} = {}) => {
    if (assistant) scene.label = assistant;
    return {role:'owner',sessionId,sceneId:'test-scene'};
  });
  const privateData = (await t.call('get_inspection',{sessionId}))._meta[KEY];
  const catalog = privateData.catalog;
  const savedScene = {sourceSha256:catalog.source.sha256,modelNumber:catalog.modelNumbers[0],assemblyId:catalog.assemblyId,
    selectionKeys:[], camera:{mode:'perspective',fov:Math.PI/4,position:[0,0,80],target:[0,0,0],up:[0,1,0],radius:20,radiusMax:20,fog:50,clipFar:true,minNear:5,minFar:0},
    inspection:{appearance:{representation:'cartoon',color:'chain-id',uniformColor:'#58dcc9',background:'#071015',opacity:1,labels:false,highlightColor:'#f2c47c',clipping:0,fog:0},placement:{translation:[0,0,0],rotation:[0,0,0],scale:1}}};
  const binding = {sessionId,serverEpoch:privateData.serverEpoch,sourceToken:privateData.sourceToken,
    baseStateRevision:privateData.stateRevision,baseInspectionRevision:privateData.inspectionRevision};
  const saved = (await t.call('sync_inspection',{...binding,scene:savedScene})).structuredContent;
  binding.baseStateRevision = saved.stateRevision; binding.baseInspectionRevision = saved.inspectionRevision;
  const panelId = (await t.call('attach_inspection',{...binding,surface:'companion'})).structuredContent.panelId;
  await t.call('poll_inspection',{...binding,panelId,availability:'ready'});
  let connected = linked;
  // Synthetic paired transport; no listeners, browsers, or physical devices.
  const status = {url:'https://192.168.1.2:8443/',host:'192.168.1.2',port:8443,fingerprint:'test',
    sessionExpiresAt:'2099-01-01T00:00:00.000Z',sessionMaxExpiresAt:'2099-01-01T00:00:00.000Z',pairingExpiresAt:'2099-01-01T00:00:00.000Z',launchId:randomUUID(),
    clients:[{id:'test-client',deviceClass:'quest2',lastUsedAt:new Date().toISOString()}]};
  vi.spyOn(InspectionCompanionHttp.prototype,'open').mockResolvedValue({url:'http://127.0.0.1:1234/#test',port:1234});
  vi.spyOn(LanCompanion.prototype,'open').mockResolvedValue({...status,pairingCode:'test'} as any);
  vi.spyOn(LanCompanion.prototype,'status').mockImplementation(() => connected ? status as any : undefined);
  await t.call('open_companion',{sessionId,connection:'lan',launch:'none'});
  const speak = (text = 'Explain this structure', extras: Record<string,unknown> = {}) => t.transcriber.transcripts.publish({
    utteranceId:randomUUID(),sessionId,panelId,text,durationMs:500,receivedAt:'2026-10-11T12:00:00.000Z',model:'synthetic',...extras});
  return {...t,sessionId,panelId,binding,speak,disconnect:()=>{connected=false;}};
}

it('advertises only the channel capability and short response instructions; a client without capabilities can poll',async()=>{
  const t = await fixture();
  expect(t.client.getServerCapabilities()?.experimental).toEqual({'claude/channel':{}});
  expect(t.client.getInstructions()).toContain('say_to_headset {text, utteranceId}');
  expect(t.client.getInstructions()).toContain('act, confirm, stop');
  expect(t.client.getInstructions()).toContain('leave out sessionId, panelId and referent');
  expect(t.client.getInstructions()).toContain('Only update_inspection, control_tour, focus_selection and emphasize');
  expect(t.client.getInstructions()).toContain('Other scene tools still require sessionId');
  expect(t.client.getInstructions()).toContain('end the turn with no summary');
  expect(t.client.getInstructions()).not.toContain('echo referent');
  const entry = t.speak();
  const heard = (await t.call('listen_voice',{timeoutSeconds:1})).structuredContent;
  expect(heard.transcripts[0].utteranceId).toBe(entry.utteranceId);
  expect(t.messages).toEqual([]);
  expect((await t.call('get_readiness',{sessionId:t.sessionId})).structuredContent.readiness.voiceDelivery)
    .toMatchObject({mode:'polling',channelActive:false});
});

it('pushes exactly one final transcript with underscore meta and recovers it once with an explicit marker',async()=>{
  const t = await fixture();
  await t.call('continue_session',{assistant:'Claude'});
  const referent = {sourceToken:t.binding.sourceToken,capturedAt:1,selectionKeys:[]};
  const entry = t.speak('Explain the fold',{referent});
  await vi.waitFor(()=>expect(t.messages).toHaveLength(1));
  expect(t.messages[0]).toEqual({content:'Explain the fold',meta:{source_kind:'stereofold-headset',utterance_id:entry.utteranceId,
    session_id:t.sessionId,panel_id:t.panelId,received_at:entry.receivedAt,referent:JSON.stringify(referent)}});
  t.transcriber.transcripts.publish(entry);
  await new Promise(resolve=>setTimeout(resolve,300));
  expect(t.messages).toHaveLength(1);
  const heard = (await t.call('listen_voice',{timeoutSeconds:1})).structuredContent;
  expect(heard.transcripts).toHaveLength(1);
  expect(heard.transcripts[0]).toMatchObject({utteranceId:entry.utteranceId,alreadyDelivered:true,
    channelDelivery:{state:'pushed',assistant:'Claude',acknowledgement:'unavailable'}});
  expect((await t.call('poll_voice_transcripts',{sessionId:t.sessionId,after:0,waitMs:0})).structuredContent.transcripts).toEqual([]);
  const ready = await t.call('get_readiness',{sessionId:t.sessionId});
  expect(ready.structuredContent.readiness.voiceDelivery).toMatchObject({mode:'channel',channelActive:true});
  expect(ready.content.map((c:any)=>c.text).join('\n')).toContain('"channelActive":true');
});

it('does not push without a linked headset, blank speech, or a matching panel/source',async()=>{
  const t = await fixture(false);
  await t.call('continue_session',{assistant:'Claude'});
  t.speak();
  await new Promise(resolve=>setTimeout(resolve,300));
  expect(t.messages).toEqual([]);
  expect((await t.call('get_readiness',{sessionId:t.sessionId})).structuredContent.readiness.voiceDelivery)
    .toMatchObject({mode:'none',channelActive:false});
});

it('checks panel, source and nonempty text even on a linked headset',async()=>{
  const t = await fixture();
  await t.call('continue_session',{assistant:'Claude'});
  t.speak(''); t.speak('wrong panel',{panelId:randomUUID()});
  t.speak('old source',{referent:{sourceToken:randomUUID(),capturedAt:1,selectionKeys:[]}});
  await new Promise(resolve=>setTimeout(resolve,300));
  expect(t.messages).toEqual([]);
  t.disconnect(); t.speak('disconnected');
  await new Promise(resolve=>setTimeout(resolve,300));
  expect(t.messages).toEqual([]);
});

it('pins the recipient, consumes spoken handovers and never pushes Codex utterances to Claude',async()=>{
  const t = await fixture();
  await t.call('continue_session',{assistant:'Claude'});
  await t.scene.dispatch('scene.attach_assistant',{label:'Codex'});
  t.speak('switch to Codex');
  await vi.waitFor(async()=>expect((await t.call('switch_assistant',{sessionId:t.sessionId})).structuredContent.active).toBe('Codex'));
  t.speak('Codex request');
  await t.call('switch_assistant',{sessionId:t.sessionId,to:'Claude'});
  const ours = t.speak('Claude request');
  await vi.waitFor(()=>expect(t.messages).toHaveLength(1));
  expect(t.messages[0].meta.utterance_id).toBe(ours.utteranceId);
  await t.call('listen_voice',{timeoutSeconds:1,cursor:ours.cursor-1});
  await t.call('switch_assistant',{sessionId:t.sessionId,to:'Codex'});
  expect((await t.call('get_readiness',{sessionId:t.sessionId})).structuredContent.readiness.voiceDelivery.mode).toBe('none');
  const other = await t.scene.dispatch('scene.poll_voice_transcripts',{sessionId:t.sessionId,assistant:'Codex',waitMs:0}) as any;
  expect(other.structuredContent.transcripts.map((e:any)=>e.text)).toEqual(['Codex request']);
});

it('pushes from an attached Claude server over the private scene transport, then recovers through the same owner',async()=>{
  const owner = await fixture();
  const scene = new LocalSceneService({serverEpoch:randomUUID(),live:()=>false});
  vi.spyOn(scene,'role','get').mockReturnValue('attached');
  vi.spyOn(scene,'proxies').mockImplementation(id=>id===owner.sessionId);
  vi.spyOn(scene,'share').mockImplementation(async ({assistant}={})=>{
    scene.label=assistant; return {role:'attached',sessionId:owner.sessionId,sceneId:'test-scene'};
  });
  vi.spyOn(scene,'call').mockImplementation((name,args)=>owner.scene.dispatch(name,args ?? {}));
  vi.spyOn(scene,'forward').mockImplementation(async (name,args:any)=>({value:await owner.scene.dispatch(
    name==='listen_voice'?'scene.listen_voice':name,{...args,assistant:scene.label})}));
  const follower=await clientFor(scene);
  await follower.call('continue_session',{assistant:'Claude'});
  const entry=owner.speak();
  await vi.waitFor(()=>expect(follower.messages).toHaveLength(1));
  expect(owner.messages).toEqual([]);
  expect(follower.messages[0].meta.utterance_id).toBe(entry.utteranceId);
  expect((await follower.call('listen_voice',{timeoutSeconds:1})).structuredContent.transcripts[0].alreadyDelivered).toBe(true);
});

it('keeps a sentence the headset grammar acts on from Claude, and hands Claude the next one',async()=>{
  const t = await fixture();
  await t.call('continue_session',{assistant:'Claude'});
  t.speak('Make it bigger.',{headsetAction:true});
  const ours = t.speak('Pause the animation.');
  await vi.waitFor(()=>expect(t.messages).toHaveLength(1));
  await new Promise(resolve=>setTimeout(resolve,300));
  expect(t.messages.map(m=>m.content)).toEqual(['Pause the animation.']);
  expect(t.messages[0].meta.utterance_id).toBe(ours.utteranceId);
  const heard = (await t.call('listen_voice',{timeoutSeconds:1,cursor:0})).structuredContent;
  expect(heard.transcripts.map((e:any)=>e.text)).toEqual(['Pause the animation.']);
});

it('retains a failed notification for polling recovery without sending it twice',async()=>{
  const t=await fixture();
  await t.call('continue_session',{assistant:'Claude'});
  const send=vi.spyOn(t.server.server,'notification').mockRejectedValue(Error('transport closed'));
  const entry=t.speak();
  await vi.waitFor(()=>expect(send).toHaveBeenCalledTimes(1));
  await new Promise(resolve=>setTimeout(resolve,300));
  expect(send).toHaveBeenCalledTimes(1);
  const heard=(await t.call('listen_voice',{timeoutSeconds:1})).structuredContent;
  expect(heard.transcripts[0]).toMatchObject({utteranceId:entry.utteranceId,alreadyDelivered:true});
  expect(t.transcriber.transcripts.all()).toHaveLength(1);
});
