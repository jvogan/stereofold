// @ts-ignore Shared page receipt producer.
import { recordTalkReplySeat } from '../../lab/browser-roundtrip/talk-reply-diagnostics.mjs';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createServer, connect } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, it, expect, vi } from 'vitest';
import { createStereoStructureServer } from '../src/server.js';
import { ALLOWED_TOOLS as LAN_TOOLS, listLanAddresses } from '../src/inspection-lan.js';
import { fakeQuestAdb, GUARDIAN_DUMP } from './helpers/fake-quest-adb.js';
import { TOOLS as COMPANION_TOOLS } from '../src/inspection-companion-http.js';
import { PRIVATE_INSPECTION_META_KEY as KEY } from '../src/inspection-contract.js';
import { createReplyAudioSynthesizer } from '../src/headset-reply-audio.js';
import { TOURS } from '../src/tour-catalog.js';
import { PANEL_SAVE_WAIT } from '../scripts/panel-wait.js';
import { VIEWER_BUILD_PLACEHOLDER } from '../src/viewer-build.js';
import { decodeInspectionCatalog } from '../src/inspection-catalog-codec.js';

// Reply audio shells out to macOS `say` and ffmpeg. These contract tests are
// about the caption, so the synthesiser is turned off unless a case asks for
// one; the rendering itself is covered in headset-reply-audio.test.ts.
const silentReplyAudio = createReplyAudioSynthesizer({ enabled: false });

function replyBindingTranscriber() {
  const entries:{utteranceId:string;text:string;receivedAt:string;durationMs:number;cursor:number}[]=[];
  return {
    enabled:true,ready:true,route:'whisper' as const,describe:()=>'test transcriber',missing:()=>[],startupLine:()=>'',dispose:async()=>{},
    async accept(input:{utteranceId:string;seq:number;final:boolean}) {
      if(!input.final) return {utteranceId:input.utteranceId,seq:input.seq,final:false,accepted:true,reason:'chunk',message:'Chunk received.'};
      entries.push({utteranceId:input.utteranceId,text:'question',receivedAt:new Date().toISOString(),durationMs:100,cursor:entries.length+1});
      return {utteranceId:input.utteranceId,seq:input.seq,final:true,accepted:true,reason:'transcribed',message:'Heard: question'};
    },
    transcripts:{get cursor(){return entries.length;},async since(after:number){return {cursor:entries.length,entries:entries.filter(entry=>entry.cursor>after)};}},
  } as any;
}

function referentTranscriber() {
  const entries:any[]=[];
  let captureReferent:((sessionId:string)=>unknown)|undefined;
  return {
    enabled:true,ready:true,route:'whisper' as const,describe:()=>'test transcriber',missing:()=>[],startupLine:()=>'',dispose:async()=>{},
    useReferents(read:(sessionId:string)=>unknown) { captureReferent=read; },
    async accept(input:{sessionId:string;utteranceId:string;seq:number;final:boolean}) {
      if(!input.final) return {utteranceId:input.utteranceId,seq:input.seq,final:false,accepted:true,reason:'chunk',message:'Chunk received.'};
      entries.push({utteranceId:input.utteranceId,text:'Move to the structure I pointed at.',receivedAt:new Date().toISOString(),
        durationMs:100,cursor:entries.length+1,referent:captureReferent?.(input.sessionId)});
      return {utteranceId:input.utteranceId,seq:input.seq,final:true,accepted:true,reason:'transcribed',message:'Heard the source request'};
    },
    transcripts:{get cursor(){return entries.length;},async since(after:number){return {cursor:entries.length,entries:entries.filter(entry=>entry.cursor>after)};}}
  } as any;
}

async function unusedPort(host:string) {
  const probe=createServer();
  await new Promise<void>((resolve,reject)=>{probe.once('error',reject);probe.listen(0,host,()=>resolve());});
  const address=probe.address(); if(!address||typeof address==='string') throw Error('LAN fixture did not bind');
  await new Promise<void>(resolve=>probe.close(()=>resolve()));
  return address.port;
}

async function reachable(host:string,port:number) {
  return new Promise<boolean>(resolve => {
    const socket=connect({host,port});
    const settle=(value:boolean)=>{socket.destroy();resolve(value);};
    socket.setTimeout(2_000,()=>settle(false));
    socket.once('connect',()=>settle(true));
    socket.once('error',()=>settle(false));
  });
}
const trash=promisify(execFile);
async function lanRequest(host:string,port:number,path:string,body:unknown,token?:string,userAgent?:string) {
  const payload=JSON.stringify(body),origin=`https://${host}:${port}`;
  return new Promise<{status:number;body:any}>((resolve,reject)=>{
    const request=httpsRequest({host,port,path,method:'POST',rejectUnauthorized:false,headers:{origin,'content-type':'application/json',
      'content-length':String(Buffer.byteLength(payload)),...(token?{authorization:`Bearer ${token}`}:{}),
      ...(userAgent?{'user-agent':userAgent}:{})}},response=>{
      const chunks:Buffer[]=[];response.on('data',chunk=>chunks.push(Buffer.from(chunk)));
      response.once('error',reject);response.once('end',()=>{
        const raw=Buffer.concat(chunks).toString('utf8');
        resolve({status:response.statusCode??0,body:raw?JSON.parse(raw):null});
      });
    });
    request.once('error',reject);request.end(payload);
  });
}
const cif=await readFile(new URL('../../fixtures/1CRN.cif',import.meta.url),'utf8');
async function setup(options={}, viewerPath?:string) {
  const [a,b]=InMemoryTransport.createLinkedPair(), server=createStereoStructureServer(viewerPath,{
    replyAudio:silentReplyAudio,
    headsetDevice:{exists:async()=>false,run:async()=>{throw Error('Provide a device fixture before running device checks');}},...options});
  const client=new Client({name:'Inspector contract test',version:'1'});
  await server.connect(b); await client.connect(a);
  const call=async(name:string,args:Record<string,unknown>)=>await client.callTool({name:`stereo_structure.${name}`,arguments:args}) as any;
  const opened=await call('inspect',{structureText:cif}); expect(opened.isError).not.toBe(true);
  const sessionId=opened.structuredContent.sessionId;
  const hydrate=()=>call('get_inspection',{sessionId});
  const data=(await hydrate())._meta[KEY];
  const scene={sourceSha256:data.catalog.source.sha256,modelNumber:data.catalog.modelNumbers[0],assemblyId:data.catalog.assemblyId,
    selectionKeys:[data.catalog.rows[0].key],camera:{mode:'perspective',fov:Math.PI/4,position:[0,0,80],up:[0,1,0],target:[0,0,0],radius:20,radiusMax:20,fog:50,clipFar:true,minNear:5,minFar:0},
    inspection:{appearance:{representation:'molecular-surface',color:'uniform',uniformColor:'#44aaff',background:'#192734',opacity:.4,labels:true,highlightColor:'#ffccee',clipping:20,fog:30},placement:{translation:[.5,0,0],rotation:[0,30,0],scale:1.2}}};
  const args={sessionId,serverEpoch:data.serverEpoch,sourceToken:data.sourceToken,baseStateRevision:data.stateRevision,baseInspectionRevision:data.inspectionRevision,scene};
  return {server,client,call,opened,sessionId,data,scene,args,hydrate,close:async()=>{await client.close();await server.close();}};
}
async function claimHeadsetUtterance(t:any, panelId:string, utteranceId:string, cursor?:number) {
  const base={sessionId:t.sessionId,panelId,utteranceId,mime:'audio/webm;codecs=opus'};
  expect((await t.call('push_to_talk_audio',{...base,seq:0,data:'AAAA',final:false})).isError).not.toBe(true);
  expect((await t.call('push_to_talk_audio',{...base,seq:1,final:true})).isError).not.toBe(true);
  const heard=await t.call('listen_voice',{timeoutSeconds:1,...(cursor===undefined?{}:{cursor})});
  expect(heard.structuredContent.transcripts).toHaveLength(1);
  return heard.structuredContent.cursor as number;
}
describe('packaged molecular inspection sessions',()=>{
  it('reads companion status without consulting an unconfigured reply voice',async()=>{
    const previousRemember=process.env.STEREOFOLD_LAN_REMEMBER;
    process.env.STEREOFOLD_LAN_REMEMBER='0';
    const t=await setup({replyAudio:{synthesize:async()=>undefined}});
    try {
      const status=await t.call('manage_companion',{sessionId:t.sessionId,action:'status'});
      expect(status.isError).not.toBe(true);
      expect(status.structuredContent.lan).toBeNull();
    } finally {
      await t.close();
      if(previousRemember===undefined)delete process.env.STEREOFOLD_LAN_REMEMBER;else process.env.STEREOFOLD_LAN_REMEMBER=previousRemember;
    }
  });

  async function visionStatusFixture() {
    const address=listLanAddresses()[0]; if(!address) return;
    const port=await unusedPort(address.address);
    const folder=await mkdtemp(join(tmpdir(),'stereofold-vision-status-'));
    await writeFile(join(folder,'inspector.html'),'<html><script>void 0;</script></html>');
    const previousHome=process.env.HOME;process.env.HOME=folder;
    let t:Awaited<ReturnType<typeof setup>>|undefined;
    const close=async()=>{
      await t?.close();
      if(previousHome===undefined)delete process.env.HOME;else process.env.HOME=previousHome;
      await trash('/usr/bin/trash',[folder]).catch(()=>{});
    };
    try {
    let now=Date.now();
    const deviceCalls:string[][]=[];
    const active=await setup({sceneServiceFile:join(folder,'scene-service.json'),now:()=>now,
      environment:{...process.env,STEREOFOLD_ADB_BIN:'/opt/tools/adb'},
      headsetDevice:{env:{...process.env,STEREOFOLD_ADB_BIN:'/opt/tools/adb'},exists:async()=>true,
        run:async(file:string,args:readonly string[])=>{deviceCalls.push([file,...args]);return {stdout:args.includes('getprop')
          ?'[ro.product.model]: [Quest 2]\n[ro.serialno]: [QUEST2]\n':'List of devices attached\nQUEST2\tdevice\n',stderr:''};}},
      questLaunch:{platform:'darwin',opener:'/bin/echo',launch:()=>({reason:'started' as const}),find:()=>'/opt/tools/adb',
        run:async()=>({code:0,stdout:'',stderr:''})}},join(folder,'inspector.html'));
    t=active;
    const saved=(await active.call('sync_inspection',active.args)).structuredContent;
    const binding={sessionId:active.sessionId,serverEpoch:saved.serverEpoch,sourceToken:saved.sourceToken,
      baseStateRevision:saved.stateRevision,baseInspectionRevision:saved.inspectionRevision};
    const opened=await active.call('open_companion',{...binding,connection:'lan',lanHost:address.address,lanPort:port});
    expect(opened.isError).not.toBe(true);
    const status=()=>active.call('manage_companion',{sessionId:active.sessionId,action:'status'});
    const readiness=()=>active.call('get_readiness',{sessionId:active.sessionId});
    const targetApple=async()=>{
      const result=await active.call('manage_companion',{sessionId:active.sessionId,action:'launch',launch:'web',headset:'apple'});
      expect(result.isError).not.toBe(true);
    };
    const pair=async(userAgent='Mozilla/5.0 (Macintosh) Safari/605.1.15',headset:'apple'|'meta'='apple')=>{
      const launch=await active.call('manage_companion',{sessionId:active.sessionId,action:'launch',launch:'web',headset});
      expect(launch.isError).not.toBe(true);
      const result=await lanRequest(address.address,port,'/pair',{code:launch.structuredContent.pairingCode},undefined,userAgent);
      expect(result.status).toBe(200);
      return result.body.token as string;
    };
    const panel=async(token:string)=>{
      const attached=(await active.call('attach_inspection',{...binding,surface:'companion'})).structuredContent;
      const send=async(entries?:Array<{seq:number;at:number;kind:string;detail:Record<string,unknown>}>)=>{
        const answer=await lanRequest(address.address,port,'/tool',{name:'poll_inspection',args:{...binding,panelId:attached.panelId,
          availability:'ready',...(entries?{diagnostics:{entries}}:{})}},token);
        expect(answer.status).toBe(200);
      };
      return {id:attached.panelId,send};
    };
    return {t:active,status,readiness,targetApple,pair,panel,deviceCalls,advance:(ms:number)=>{now+=ms;},close};
    } catch(error) {await close();throw error;}
  }

  it('skips the Quest browser probe for a current Vision Pro page',async()=>{
    const f=await visionStatusFixture();if(!f)return;
    try {
      await f.targetApple();
      const page=await f.panel(await f.pair());
      await page.send([{seq:1,at:1,kind:'session-start',detail:{deviceClass:'vision-pro'}}]);
      const before=f.deviceCalls.length,status=await f.status();
      expect(status.isError).not.toBe(true);
      expect(status.content[0].text).toContain('Apple Vision Pro page is connected');
      expect(status.structuredContent.browser).toBeUndefined();
      expect(f.deviceCalls).toHaveLength(before);
    } finally {await f.close();}
  },30_000);

  it('does not use an old Apple launch to classify an unknown Quest peer',async()=>{
    const f=await visionStatusFixture();if(!f)return;
    try {
      await f.targetApple();await f.pair('unclassified Quest test browser');
      const before=f.deviceCalls.length,status=await f.status();
      expect(status.isError).not.toBe(true);
      expect(status.content[0].text).not.toContain('Apple Vision Pro');
      expect(f.deviceCalls.length).toBeGreaterThan(before);
      expect((await f.readiness()).structuredContent.readiness.items.find((item:any)=>item.capability==='headset').detail)
        .not.toContain('Apple Vision Pro');
    } finally {await f.close();}
  },30_000);

  it('ignores an ended Quest report from another panel after Vision Pro pairs',async()=>{
    const f=await visionStatusFixture();if(!f)return;
    try {
      await f.targetApple();
      const quest=await f.panel(await f.pair());
      await quest.send([{seq:1,at:1,kind:'session-start',detail:{deviceClass:'quest2'}},
        {seq:2,at:2,kind:'session-end',detail:{}}]);
      f.advance(1);
      const vision=await f.panel(await f.pair());
      await vision.send([{seq:1,at:2,kind:'session-start',detail:{deviceClass:'vision-pro'}}]);
      await quest.send([{seq:3,at:4,kind:'session-start',detail:{deviceClass:'quest2'}},
        {seq:4,at:5,kind:'session-end',detail:{}}]);
      const before=f.deviceCalls.length,status=await f.status();
      expect(status.content[0].text).toContain('Apple Vision Pro page is connected');
      expect(f.deviceCalls).toHaveLength(before);
      await vision.send([{seq:2,at:6,kind:'session-end',detail:{}}]);
      expect((await f.status()).content[0].text).not.toContain('Apple Vision Pro');
    } finally {await f.close();}
  },30_000);

  for(const order of ['quest-then-vision','vision-then-quest'] as const) {
    it(`uses the recently active Quest after the Vision Pro goes quiet (${order})`,async()=>{
      const f=await visionStatusFixture();if(!f)return;
      try {
        const addQuest=async()=>{
          const page=await f.panel(await f.pair('Quest test browser','meta'));
          await page.send([{seq:1,at:1,kind:'session-start',detail:{deviceClass:'quest2'}}]);
          return page;
        };
        const addVision=async()=>{
          const page=await f.panel(await f.pair());
          await page.send([{seq:1,at:2,kind:'session-start',detail:{deviceClass:'vision-pro'}}]);
          return page;
        };
        let quest;
        if(order==='quest-then-vision') {quest=await addQuest();f.advance(1);await addVision();}
        else {await addVision();f.advance(1);quest=await addQuest();}
        f.advance(61_000);
        await quest.send();
        const before=f.deviceCalls.length,status=await f.status();
        // The Quest path ran: its browser probe was asked, and no Apple wording.
        expect(status.content[0].text).not.toMatch(/Vision Pro|Quest-only/);
        expect(status.structuredContent.browser).toBeDefined();
        expect(f.deviceCalls.length).toBeGreaterThan(before);
        expect((await f.readiness()).structuredContent.readiness.items.find((item:any)=>item.capability==='headset').detail)
          .toBe('adb sees QUEST2');
      } finally {await f.close();}
    },30_000);
  }

  it('uses the newest lifecycle report across current panels of one pairing',async()=>{
    const f=await visionStatusFixture();if(!f)return;
    try {
      const token=await f.pair();
      const first=await f.panel(token),second=await f.panel(token);
      const panels=(await f.t.call('get_inspection_state',{sessionId:f.t.sessionId})).structuredContent.panels;
      expect([first.id,second.id].map(id=>panels.find((entry:any)=>entry.panelId===id)?.current)).toEqual([true,true]);
      await first.send([{seq:1,at:1,kind:'session-start',detail:{deviceClass:'vision-pro'}},
        {seq:2,at:2,kind:'session-end',detail:{}}]);
      await second.send([{seq:1,at:3,kind:'session-start',detail:{deviceClass:'vision-pro'}}]);
      const before=f.deviceCalls.length,status=await f.status();
      expect(status.content[0].text).toContain('Apple Vision Pro page is connected over Wi-Fi; USB device state is Quest-only.');
      expect(status.content[0].text).toContain('wearer.state page-open');
      expect(f.deviceCalls).toHaveLength(before);
    } finally {await f.close();}
  },30_000);

  it.each(['quest','vision'] as const)('keeps share blocking unchanged for a quiet %s pairing',async(kind)=>{
    const f=await visionStatusFixture();if(!f)return;
    try {
      const page=await f.panel(await f.pair(kind==='quest'?'Quest test browser':'Mozilla/5.0 (Macintosh) Safari/605.1.15',
        kind==='quest'?'meta':'apple'));
      await page.send([{seq:1,at:1,kind:'session-start',detail:{deviceClass:kind==='quest'?'quest2':'vision-pro'}}]);
      const before=(await f.readiness()).structuredContent.readiness;
      f.advance(61_000);
      const after=(await f.readiness()).structuredContent.readiness;
      // Advancing the clock also ages the panel heartbeat, so compare only the
      // share row: quiet pairings must not newly block on it.
      expect(after.items.find((item:any)=>item.capability==='share').state).toBe('ok');
      expect(after.blocking.includes('share')).toBe(before.blocking.includes('share'));
      if(kind==='vision') expect(after.items.find((item:any)=>item.capability==='headset').detail)
        .toContain('paired over Wi-Fi; waiting for its page to reconnect');
    } finally {await f.close();}
  },30_000);

  it('keeps status text for a Quest-only pairing with no Apple evidence',async()=>{
    const f=await visionStatusFixture();if(!f)return;
    try {
      const page=await f.panel(await f.pair('Quest test browser','meta'));
      await page.send([{seq:1,at:1,kind:'session-start',detail:{deviceClass:'quest2'}}]);
      // With no Apple evidence, status keeps the Quest path: the browser
      // probe runs and the text says nothing about Apple or USB scope.
      const before=f.deviceCalls.length,status=await f.status();
      expect(status.content[0].text).not.toMatch(/Vision Pro|Quest-only/);
      expect(status.structuredContent.browser).toBeDefined();
      expect(f.deviceCalls.length).toBeGreaterThan(before);
    } finally {await f.close();}
  },30_000);

  it('keeps a closed Vision Pro page paired but no longer connected',async()=>{
    const f=await visionStatusFixture();if(!f)return;
    try {
      await f.targetApple();
      const page=await f.panel(await f.pair());
      await page.send([{seq:1,at:1,kind:'session-start',detail:{deviceClass:'vision-pro'}}]);
      f.advance(61_000);
      const status=await f.status(),reading=(await f.readiness()).structuredContent.readiness;
      expect(status.structuredContent.lan.clients).toHaveLength(1);
      expect(status.content[0].text).toContain('waiting for its page to reconnect');
      expect(reading.items.find((item:any)=>item.capability==='share').state).toBe('ok');
      expect(reading.items.find((item:any)=>item.capability==='headset').state).toBe('not-checked');
      expect(reading.items.find((item:any)=>item.capability==='headset').detail).toContain('paired over Wi-Fi');
    } finally {await f.close();}
  },30_000);
  it('adds authoritative readiness to attach and heartbeat responses',async()=>{
    const t=await setup();try {
      const saved=(await t.call('sync_inspection',t.args)).structuredContent;
      const binding={sessionId:t.sessionId,serverEpoch:saved.serverEpoch,sourceToken:saved.sourceToken,
        baseStateRevision:saved.stateRevision,baseInspectionRevision:saved.inspectionRevision};
      const attached=(await t.call('attach_inspection',binding)).structuredContent;
      expect(attached.readiness.items.map((item:any)=>item.capability)).toEqual([
        'structure','share','agent','transcription','replies','headset',
      ]);
      expect(attached.readiness.items.find((item:any)=>item.capability==='structure').state).toBe('ok');
      const heartbeat=(await t.call('poll_inspection',{...binding,panelId:attached.panelId,availability:'ready'})).structuredContent;
      expect(heartbeat.readiness.checkedAt).toEqual(expect.any(String));
      expect(heartbeat.readiness.items).toHaveLength(6);
    } finally {await t.close();}
  });
  it('keeps compact readiness aligned with full checks after polling alone and observed capture',async()=>{
    let observed=false;
    const transcriber={...replyBindingTranscriber(),captureObserved:()=>observed};
    const t=await setup({transcriber});
    try {
      const saved=(await t.call('sync_inspection',t.args)).structuredContent;
      const binding={sessionId:t.sessionId,serverEpoch:saved.serverEpoch,sourceToken:saved.sourceToken,
        baseStateRevision:saved.stateRevision,baseInspectionRevision:saved.inspectionRevision};
      const panelId=(await t.call('attach_inspection',binding)).structuredContent.panelId;
      await t.call('poll_voice_transcripts',{sessionId:t.sessionId,waitMs:0});
      for(const captureObserved of [false,true]) {
        observed=captureObserved;
        const diagnostic=(await t.call('get_readiness',{sessionId:t.sessionId})).structuredContent;
        const full=diagnostic.readiness;
        const state=(await t.call('get_inspection_state',{sessionId:t.sessionId})).structuredContent;
        const heartbeat=(await t.call('poll_inspection',{...binding,panelId,availability:'ready'})).structuredContent;
        const expected={ready:full.ready,blocking:full.blocking,scope:'headset-microphone-session'};
        expect(diagnostic.modelContext.readiness).toEqual(expected);
        expect(state.modelContext.readiness).toEqual(expected);
        expect(heartbeat.modelContext.readiness).toEqual(expected);
        expect(state.modelContext.readiness.blocking).toContain('agent');
        expect(state.modelContext.readiness.blocking.includes('transcription')).toBe(!captureObserved);
      }
    } finally {await t.close();}
  });
  it('keeps failed optional debugging out of the heartbeat blocking list',async()=>{
    const t=await setup({
      environment:{STEREOFOLD_ADB_BIN:'/opt/tools/adb'},
      headsetDevice:{exists:async()=>true,run:async()=>({stdout:'List of devices attached\n',stderr:''})},
    });
    try {
      const saved=(await t.call('sync_inspection',t.args)).structuredContent;
      const binding={sessionId:t.sessionId,serverEpoch:saved.serverEpoch,sourceToken:saved.sourceToken,
        baseStateRevision:saved.stateRevision,baseInspectionRevision:saved.inspectionRevision};
      const panelId=(await t.call('attach_inspection',binding)).structuredContent.panelId;
      const readiness=(await t.call('get_readiness',{sessionId:t.sessionId})).structuredContent.readiness;
      expect(readiness.items.find((item:any)=>item.capability==='headset').state).toBe('not-checked');
      const heartbeat=(await t.call('poll_inspection',{...binding,panelId,availability:'ready'})).structuredContent;
      expect(heartbeat.modelContext.readiness.blocking).not.toContain('headset');
      expect(heartbeat.modelContext.readiness.ready).toBe(false);
    } finally {await t.close();}
  });
  it('keeps a heartbeat alive when its optional model context is invalid',async()=>{
    const t=await setup();
    const step=TOURS[0].steps[0] as any;
    const originalId=step.id;
    try {
      const saved=(await t.call('sync_inspection',t.args)).structuredContent;
      const binding={sessionId:t.sessionId,serverEpoch:saved.serverEpoch,sourceToken:saved.sourceToken,
        baseStateRevision:saved.stateRevision,baseInspectionRevision:saved.inspectionRevision};
      const panelId=(await t.call('attach_inspection',binding)).structuredContent.panelId;
      step.id='chapter-'.repeat(20);
      const heartbeat=await t.call('poll_inspection',{...binding,panelId,availability:'ready',
        tourState:{selectedId:TOURS[0].id,step:0,total:TOURS[0].steps.length,active:true,autoplay:false,navigating:false}});
      expect(heartbeat.isError).not.toBe(true);
      expect(heartbeat.structuredContent.modelContext).toBeUndefined();
      expect(heartbeat.structuredContent.readiness.items).toHaveLength(6);
    } finally {step.id=originalId;await t.close();}
  });
  it('keeps routine state and rendered receipts compact while making the full catalog opt-in',async()=>{
    const t=await setup();try {
      const saved=(await t.call('sync_inspection',t.args)).structuredContent;
      const binding={sessionId:t.sessionId,serverEpoch:saved.serverEpoch,sourceToken:saved.sourceToken,
        baseStateRevision:saved.stateRevision,baseInspectionRevision:saved.inspectionRevision};
      const panelId=(await t.call('attach_inspection',binding)).structuredContent.panelId;
      const commandId='compact-state-selection';
      const change={kind:'selection',patch:{selectionKeys:[]}};
      expect((await t.call('update_inspection',{...binding,panelId,commandId,change})).structuredContent.command.status).toBe('queued');
      const delivery=(await t.call('poll_inspection',{...binding,panelId,availability:'ready'}))._meta[KEY].delivery;
      const rendered=await t.call('complete_inspection',{...binding,panelId,commandId,claimToken:delivery.claimToken,
        scene:{...t.scene,selectionKeys:[]}});
      expect(rendered.structuredContent.command.status).toBe('rendered');
      const compact=await t.call('get_inspection_state',{sessionId:t.sessionId,commandId});
      const state=compact.structuredContent;
      expect(compact.isError).not.toBe(true);
      expect(state).not.toHaveProperty('experienceCatalog');
      expect(state).toMatchObject({hasScene:true,sourceToken:saved.sourceToken,inspectionRevision:2,
        view:{selectedResidueCount:0,appearance:t.scene.inspection.appearance},
        command:{commandId,status:'rendered',renderedRevision:2,panelId}});
      expect(state.panels).toEqual(expect.arrayContaining([expect.objectContaining({panelId,current:true})]));
      expect(state.tours).toEqual(expect.arrayContaining([expect.objectContaining({id:'tubulin-eb3-lattice',scenes:20})]));
      // Bound the entire MCP result, not just one field: routine polls must not
      // silently reintroduce tens of kilobytes of chapter forecasts elsewhere.
      const compactBytes=Buffer.byteLength(JSON.stringify(compact));
      expect(compactBytes).toBeLessThan(12_000);
      const expanded=await t.call('get_inspection_state',{sessionId:t.sessionId,commandId,includeExperienceCatalog:true});
      expect(expanded.isError).not.toBe(true);
      const catalog=expanded.structuredContent.experienceCatalog;
      expect(catalog).toHaveLength(10);
      expect(catalog.every((entry:any)=>entry.deviceBudget.chapters.length===20)).toBe(true);
      expect((await t.hydrate())._meta[KEY].experienceCatalog).toEqual(catalog);
      expect(Buffer.byteLength(JSON.stringify(expanded))-compactBytes).toBeGreaterThan(15_000);
      expect(expanded.structuredContent.command).toEqual(state.command);
      expect(expanded.structuredContent.tours).toEqual(state.tours);
      const disabled=await t.call('get_inspection_state',{sessionId:t.sessionId,includeExperienceCatalog:false});
      expect(disabled.structuredContent).not.toHaveProperty('experienceCatalog');
      expect((await t.call('get_inspection_state',{sessionId:t.sessionId,includeExperienceCatalog:'true'})).isError).toBe(true);
    } finally {await t.close();}
  });
  it('lists ten concrete source-bound experiences with twenty declared steps',async()=>{
    const t=await setup();try {
      const listed=await t.call('list_experiences',{});
      expect(listed.isError).not.toBe(true);
      expect(listed.structuredContent.experiences).toHaveLength(10);
      expect(listed.structuredContent.experiences.every((value:any)=>value.steps===20 && value.stages.length>=1)).toBe(true);
      expect(listed.structuredContent.experiences.find((value:any)=>value.id==='tubulin-eb3-lattice').stages.map((stage:any)=>stage.id))
        .toEqual(['tubulin-dimer','protofilament-slice','microtubule-lattice','eb3-decorated-lattice']);
    } finally {await t.close();}
  });
  it('confirms an exact selection set across catalog ordering and label bounds without accepting other scene changes',async()=>{
    const t=await setup();try {
      expect((await t.call('get_inspection_state',{sessionId:t.sessionId,residues:{limit:3}})).isError).toBe(true);
      const saved=(await t.call('sync_inspection',t.args)).structuredContent;
      const binding={sessionId:t.sessionId,serverEpoch:saved.serverEpoch,sourceToken:saved.sourceToken,
        baseStateRevision:saved.stateRevision,baseInspectionRevision:saved.inspectionRevision};
      const panelId=(await t.call('attach_inspection',binding)).structuredContent.panelId;
      const lookup=await t.call('get_inspection_state',{sessionId:t.sessionId,residues:{labelChain:'A',labelSequenceRange:[3,5]}});
      expect(lookup.isError).not.toBe(true);
      expect(lookup.structuredContent.residues.total).toBe(3);
      const rows=lookup.structuredContent.residues.rows;
      expect(rows.map((row:any)=>row.identity.labelSequenceId)).toEqual([3,4,5]);
      expect(rows.every((row:any)=>row.coordinateState==='resolved')).toBe(true);
      expect(JSON.stringify(lookup)).not.toMatch(/atomSites|sourceCoordinates|structureText/);
      const keys=rows.map((row:any)=>row.key),requestedKeys=[...keys].reverse();
      const change={kind:'selection',patch:{selectionKeys:requestedKeys}};
      for(const bad of [['invented'],[keys[0],keys[0]]]) {
        expect((await t.call('update_inspection',{...binding,panelId,commandId:'invalid-selection',
          change:{kind:'selection',patch:{selectionKeys:bad}}})).isError).toBe(true);
      }
      const request={...binding,panelId,commandId:'select-region',change};
      expect((await t.call('update_inspection',request)).structuredContent.command.status).toBe('queued');
      const delivery=(await t.call('poll_inspection',{...binding,panelId,availability:'ready'}))._meta[KEY].delivery;
      expect(delivery.change).toEqual(change);
      expect((await t.hydrate())._meta[KEY].scene).toEqual(t.scene);
      // The viewer stores the same selected set in catalog order. With labels
      // enabled, rebuilding their geometry may also update Mol*'s radiusMax.
      expect(t.scene.inspection.appearance.labels).toBe(true);
      const rendered=structuredClone(t.scene);
      rendered.selectionKeys=keys;
      rendered.camera.radiusMax=23.5;
      const receipt=await t.call('complete_inspection',{...binding,panelId,commandId:request.commandId,
        claimToken:delivery.claimToken,scene:rendered});
      expect(receipt.structuredContent.command).toMatchObject({status:'rendered',renderedRevision:2});
      expect((await t.hydrate())._meta[KEY].scene).toEqual(rendered);
      const selected=(await t.call('get_inspection_state',{sessionId:t.sessionId,residues:{selectedOnly:true}})).structuredContent.residues;
      expect(selected.rows.map((row:any)=>row.key)).toEqual(keys);
      expect(selected.rows.every((row:any)=>row.selected)).toBe(true);
      const current={...binding,baseInspectionRevision:2};

      await t.call('poll_inspection',{...current,panelId,availability:'ready'});
      const wrongSetChange={kind:'selection',patch:{selectionKeys:[keys[0],keys[1]]}};
      await t.call('update_inspection',{...current,panelId,commandId:'wrong-selection-set',change:wrongSetChange});
      const wrongSetClaim=(await t.call('poll_inspection',{...current,panelId,availability:'ready'}))._meta[KEY].delivery;
      const wrongSet=structuredClone(rendered);
      wrongSet.selectionKeys=[keys[0],keys[2]];
      expect((await t.call('complete_inspection',{...current,panelId,commandId:'wrong-selection-set',
        claimToken:wrongSetClaim.claimToken,scene:wrongSet})).structuredContent.command.status).toBe('unconfirmed');
      expect((await t.hydrate())._meta[KEY].scene).toEqual(rendered);

      const cameraChanges={
        'selection-camera-position':{position:[1,2,3]},
        'selection-camera-radius':{radius:21},
        'selection-camera-fog':{fog:51},
        'selection-camera-clip':{clipFar:false},
      };
      for(const [commandId,cameraPatch] of Object.entries(cameraChanges)) {
        await t.call('poll_inspection',{...current,panelId,availability:'ready'});
        await t.call('update_inspection',{...current,panelId,commandId,change:{kind:'selection',patch:{selectionKeys:[]}}});
        const claim=(await t.call('poll_inspection',{...current,panelId,availability:'ready'}))._meta[KEY].delivery;
        const altered=structuredClone(rendered);
        altered.selectionKeys=[];
        Object.assign(altered.camera,cameraPatch,{radiusMax:99});
        expect((await t.call('complete_inspection',{...current,panelId,commandId,claimToken:claim.claimToken,
          scene:altered})).structuredContent.command.status).toBe('unconfirmed');
        expect((await t.hydrate())._meta[KEY].scene).toEqual(rendered);
      }
    } finally {await t.close();}
  });
  it('separates the render resource and keeps coordinates/catalog/scene private',async()=>{
    const t=await setup();try {
      const tools=(await t.client.listTools()).tools;
      for(const tool of tools) {
        for(const field of ['readOnlyHint','openWorldHint','destructiveHint'] as const)
          expect(typeof tool.annotations?.[field],`${tool.name} ${field}`).toBe('boolean');
      }
      expect(tools.find(x=>x.name==='stereo_structure.poll_voice_transcripts')?.annotations)
        .toMatchObject({readOnlyHint:true,openWorldHint:false,destructiveHint:false});
      for(const suffix of ['voice_command','voice_acknowledgement','speak_to_headset','say_to_headset','get_readiness','manage_companion']) {
        expect(tools.find(x=>x.name===`stereo_structure.${suffix}`)?.annotations,
          `${suffix} can invoke the configured OAuth voice provider`).toMatchObject({openWorldHint:true});
      }
      expect(tools.find(x=>x.name==='stereo_structure.manage_inspection_view')?.annotations)
        .toMatchObject({readOnlyHint:false,openWorldHint:false,destructiveHint:true});
      expect(tools.find(x=>x.name==='stereo_structure.inspect')?._meta?.['ui/resourceUri']).toBe('ui://stereo-structure/inspector');
      for(const suffix of ['get_inspection','sync_inspection']) {
        const meta=tools.find(x=>x.name===`stereo_structure.${suffix}`)?._meta as any;
        expect(meta.ui.visibility).toEqual(['app']);expect(meta.ui.resourceUri).toBeUndefined();
      }
      for(const response of [t.opened,await t.hydrate(),await t.call('sync_inspection',t.args)]) {
        const publicText=JSON.stringify({content:response.content,state:response.structuredContent});
        expect(publicText).not.toContain('_atom_site');expect(publicText).not.toContain(t.data.catalog.rows[0].key);
        expect(publicText).not.toContain('structureText');expect(publicText).not.toContain('catalog');
      }
    } finally {await t.close();}
  });
  it.each([false,true])('reports preflight without claiming a handoff and resolves transfers (truncated selection: %s)',async(truncated)=>{
    const t=await setup();
    const folder=await mkdtemp(join(tmpdir(),'stereofold-preflight-'));
    const paths={scenePath:join(folder,'scene.json'),coordinatePath:join(folder,'source.mmcif'),provenancePath:join(folder,'provenance.json')};
    const scene:any={version:2,revision:0,
      objects:[{id:'primary',primary:true,visible:true,derived:false,frameCount:1,
        matrix:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],construction:{kind:'model',modelIndex:0},
        constructionOptions:{models:[{index:0,modelNumber:1}],assemblies:[]}}],
      selection:{atomIds:['atom-1'],atomIdsTruncated:false},focus:{atomIds:[],expression:null,summary:null},
      camera:{mode:'perspective',fovDegrees:45,position:[0,0,30],target:[0,0,0],up:[0,1,0]},
      layers:[{id:'protein',visible:true,target:{kind:'all'},labels:false,opacity:1,representation:'cartoon',color:{kind:'chain'}}],
      background:'#192734',lighting:'studio',trajectory:null,namedSelections:{}};
    const writePair=async()=>{
      const json=JSON.stringify(scene);
      await writeFile(paths.scenePath,json);await writeFile(paths.coordinatePath,cif);
      await writeFile(paths.provenancePath,JSON.stringify({version:1,kind:'structure-viewer-local-snapshot',
        sceneSha256:createHash('sha256').update(json).digest('hex'),expectedRevision:0,sourceObjectId:'primary',
        coordinate:{format:'selection-mmcif',sha256:createHash('sha256').update(cif).digest('hex'),
          coordinateProvenance:{identityPreserving:true,generatedAtomIdentifierCount:0,generatedModelCount:0,namespacedAtomIdentifierCount:0,remappedModelCount:0}}}));
    };
    try {
      scene.layers.push({...scene.layers[0],id:'ligand',representation:'ball_and_stick',labels:true,representationOptions:{sizeFactor:2}});
      await writePair();
      const rejected=await t.call('inspect_scene',paths);
      expect(rejected.isError).not.toBe(true);
      expect(rejected.structuredContent).toMatchObject({kind:'scene-preflight',imported:false,preflight:{supported:false}});
      expect(rejected.structuredContent.sessionId).toBeUndefined();
      expect(rejected.structuredContent.renderToken).toBeUndefined();
      expect(rejected.content[0].text).toContain('Layer "ligand" (ball_and_stick)');
      expect(rejected.content[0].text).toContain('labels');
      expect(rejected.content[0].text).toContain('representationOptions');
      expect(rejected.content[0].text).toContain('Structure-only alternative');
      expect(rejected.content[0].text).toContain('open the coordinate file with stereo_structure.inspect_file.');
      expect(rejected.content[0].text).toContain('No inspection session was opened.');
      expect(rejected.content[0].text).not.toContain('existing source-only');
      expect(rejected.content[0].text).not.toContain('Molecular Structure Viewer handoff');
      expect(rejected._meta).toBeUndefined();
      expect(JSON.stringify(rejected)).not.toContain(folder);
      expect((await t.hydrate())._meta[KEY].scene).toBeNull();
      scene.layers.pop();
      if(truncated) scene.selection={atomIds:[],atomIdsTruncated:true,atomCount:1};
      await writePair();
      const opened=await t.call('inspect_scene',paths);
      expect(opened.isError).not.toBe(true);
      expect(opened.structuredContent.preflight).toMatchObject({supported:true,scope:'scene',disclosure:{selectionGranularity:'residues'}});
      expect(opened.content[0].text).toContain('Open matching scene');
      expect(opened.content[0].text).toContain('Admission is provisional');
      if(truncated) expect(opened.structuredContent.preflight.pendingChecks).toContain('selection.atomIds is truncated; verify complete unique revision-bound query IDs matching selection.atomCount.');
      expect(JSON.stringify(opened)).not.toContain(folder);
      const sessionId=opened.structuredContent.sessionId;
      const data=(await t.call('get_inspection',{sessionId}))._meta[KEY];
      const binding={sessionId,serverEpoch:data.serverEpoch,sourceToken:data.sourceToken,baseStateRevision:data.stateRevision,baseInspectionRevision:data.inspectionRevision};
      const target={sourceSha256:data.catalog.source.sha256,modelNumber:1,assemblyId:data.catalog.assemblyId,
        molecularCenterAngstrom:[0,0,0],molecularRadiusAngstrom:10,cameraBaseline:t.scene.camera,atomIdToSelectionKey:{}};
      const unresolved=await t.call('resolve_scene_import',{...binding,target});
      expect(unresolved.structuredContent).toMatchObject({imported:false,preflight:{supported:false,scope:'complete-input'}});
      expect(unresolved.content[0].text).toContain(truncated?'truncated selection.atomIds requires complete unique revision-bound atom query results':'every selected source atom ID');
      expect(unresolved.content[0].text).toContain('Structure-only alternative');
      target.atomIdToSelectionKey={'atom-1':data.catalog.rows[0].key};
      if(truncated) Object.assign(target,{queriedSelectionAtomIds:['atom-1']});
      const resolved=await t.call('resolve_scene_import',{...binding,target});
      expect(resolved.isError).not.toBe(true);
      expect(resolved.structuredContent).toMatchObject({imported:true,preflight:{supported:true,scope:'complete-input',pendingChecks:[]},scene:{selectionKeys:[data.catalog.rows[0].key]}});
      expect(resolved.content[0].text).toContain('Open matching scene');
      expect(resolved.content[0].text).toContain('retain the local camera baseline');
      const retried=await t.call('resolve_scene_import',{...binding,target:{...target,atomIdToSelectionKey:{}}});
      expect(retried.structuredContent.preflight).toEqual(resolved.structuredContent.preflight);
      expect(retried.structuredContent.scene).toEqual(resolved.structuredContent.scene);
    } finally {await t.close();await rm(folder,{recursive:true,force:true});}
  });

  it('offers only private public-PDB or exact local-file handoff identity, and clears it on source replacement',async()=>{
    const folder=await mkdtemp(join(tmpdir(),'stereofold-native-handoff-'));
    const filePath=join(folder,'exact-source.cif');
    await writeFile(filePath,cif,'utf8');
    const local=await setup();
    try {
      const opened=await local.call('inspect_file',{filePath});
      const sessionId=opened.structuredContent.sessionId;
      expect(JSON.stringify({content:opened.content,structuredContent:opened.structuredContent})).not.toContain(filePath);
      const handoffResult=await local.call('get_inspection',{sessionId});
      expect(handoffResult.content[0].text).toContain('Open structure only');
      expect(handoffResult.content[0].text).toContain('Does not carry selection, camera or appearance.');
      const hydrated=handoffResult._meta[KEY];
      expect(hydrated.nativeStructureViewerHandoff).toEqual({
        kind:'local-file',filePath,sourceSha256:hydrated.catalog.source.sha256,
      });
      await local.call('open',{sessionId,structureText:cif});
      expect((await local.call('get_inspection',{sessionId}))._meta[KEY].nativeStructureViewerHandoff).toBeUndefined();
    } finally {await local.close();await rm(folder,{recursive:true,force:true});}

    const publicPdb=await setup({fetchPdbText:async()=>cif});
    try {
      const opened=await publicPdb.call('inspect',{pdbId:'1crn'});
      const hydrated=(await publicPdb.call('get_inspection',{sessionId:opened.structuredContent.sessionId}))._meta[KEY];
      expect(hydrated.nativeStructureViewerHandoff).toEqual({
        kind:'public-pdb',pdbId:'1CRN',sourceSha256:hydrated.catalog.source.sha256,
      });
      expect((await publicPdb.hydrate())._meta[KEY].nativeStructureViewerHandoff).toBeUndefined();
    } finally {await publicPdb.close();}
  });
  it('restores the complete current view on source-free reopening and deduplicates a lost save receipt',async()=>{
    const t=await setup();try {
      expect((await t.call('sync_inspection',t.args)).structuredContent).toMatchObject({saved:true,inspectionRevision:1});
      expect((await t.call('sync_inspection',t.args)).structuredContent).toMatchObject({saved:true,inspectionRevision:1});
      await t.call('inspect',{sessionId:t.sessionId});expect((await t.hydrate())._meta[KEY].scene).toEqual(t.scene);
    } finally {await t.close();}
  });
  it('rejects stale panel saves and old source capabilities without overwriting newer work',async()=>{
    const t=await setup();try {
      await t.call('sync_inspection',t.args);
      const stale=structuredClone(t.args);stale.scene.inspection.appearance.background='#eeeeee';
      expect((await t.call('sync_inspection',stale)).structuredContent.conflict).toBe(true);
      expect((await t.hydrate())._meta[KEY].scene).toEqual(t.scene);
      await t.call('open',{sessionId:t.sessionId,structureText:cif});
      const replaced=(await t.hydrate())._meta[KEY];expect(replaced.scene).toBeNull();expect(replaced.sourceToken).not.toBe(t.data.sourceToken);
      expect((await t.call('sync_inspection',t.args)).structuredContent.conflict).toBe(true);
    } finally {await t.close();}
  });
  it('detects intervening legacy state writes and mismatched server epochs',async()=>{
    const t=await setup();try {
      expect((await t.call('sync_inspection',{...t.args,serverEpoch:randomUUID()})).structuredContent.conflict).toBe(true);
      await t.call('set_mode',{sessionId:t.sessionId,mode:'cross'});
      expect((await t.call('sync_inspection',t.args)).structuredContent.conflict).toBe(true);
      expect((await t.hydrate())._meta[KEY].scene).toBeNull();
    } finally {await t.close();}
  });
  it('validates complete camera, scientific identity, selection, appearance and placement before saving',async()=>{
    const t=await setup();try {
      const corruptions=[(s:any)=>s.camera.up=[0,0,0],(s:any)=>s.camera.radius=-1,(s:any)=>s.sourceSha256='0'.repeat(64),
        (s:any)=>s.modelNumber=999,(s:any)=>s.assemblyId='missing',(s:any)=>s.selectionKeys=['invented'],
        (s:any)=>s.selectionKeys.push(s.selectionKeys[0]),(s:any)=>s.inspection.appearance.opacity=2,
        (s:any)=>s.inspection.appearance.clipping=81,(s:any)=>s.inspection.placement.translation=[1000001,0,0],
        (s:any)=>s.inspection.placement.scale=1000001,(s:any)=>s.inspection.history={undoCount:2}];
      for(const corrupt of corruptions) {const args=structuredClone(t.args);corrupt(args.scene);expect((await t.call('sync_inspection',args)).isError).toBe(true);}
      expect((await t.hydrate())._meta[KEY].scene).toBeNull();
    } finally {await t.close();}
  });
  it('retains inspection on failed source fetch and rejects unsupported pasted PDB explicitly',async()=>{
    const t=await setup({fetchPdbText:async()=>{throw Error('offline');}});try {
      await t.call('sync_inspection',t.args);
      expect((await t.call('open',{sessionId:t.sessionId,pdbId:'4HHB'})).isError).toBe(true);
      expect((await t.hydrate())._meta[KEY].scene).toEqual(t.scene);
      const old=await t.call('open',{fixture:'three-depth-markers'});
      const rejected=await t.call('inspect',{sessionId:old.structuredContent.sessionId});
      expect(rejected.isError).toBe(true);expect(JSON.stringify(rejected)).toContain('requires mmCIF');
      expect((await t.call('inspect',{sessionId:t.sessionId,structureText:cif})).isError).toBe(true);
      expect((await t.call('inspect',{structureText:'ATOM      1  N   GLY A   1       1.000   2.000   3.000  1.00 10.00           N\nEND\n'})).isError).toBe(true);
      expect((await t.hydrate())._meta[KEY].scene).toEqual(t.scene);
    } finally {await t.close();}
  });
  it('uses the existing expiry boundary for private inspection reads and writes',async()=>{
    let now=0;const t=await setup({now:()=>now,sessionTtlMs:1000});try {
      now=1001;expect((await t.hydrate()).isError).toBe(true);expect((await t.call('sync_inspection',t.args)).isError).toBe(true);
    } finally {await t.close();}
  });
  it('publishes only a bounded, transient object-relative immersive context without changing the saved scene',async()=>{
    let now=0;const t=await setup({now:()=>now});try {
      const saved=await t.call('sync_inspection',t.args);
      const binding={sessionId:t.sessionId,serverEpoch:saved.structuredContent.serverEpoch,sourceToken:saved.structuredContent.sourceToken,
        baseStateRevision:saved.structuredContent.stateRevision,baseInspectionRevision:saved.structuredContent.inspectionRevision};
      const panel=(await t.call('attach_inspection',binding)).structuredContent.panelId;
      const sceneBefore=structuredClone((await t.hydrate())._meta[KEY].scene);
      const spatialContext={mode:'immersive-vr',headPosition:[3,4,0],viewDirection:[0,0,-1],distance:5};
      expect((await t.call('poll_inspection',{...binding,panelId:panel,availability:'ready',spatialContext})).isError).not.toBe(true);
      let state=(await t.call('get_inspection_state',{sessionId:t.sessionId})).structuredContent;
      expect(state).toMatchObject({stateRevision:binding.baseStateRevision,inspectionRevision:binding.baseInspectionRevision});
      expect(state.panels.find((entry:any)=>entry.panelId===panel).spatialContext).toEqual({
        ...spatialContext,reference:'molecule-center',axes:'molecule-local',units:'molecular-radius',ageMs:0,stale:false,
      });
      expect((await t.hydrate())._meta[KEY].scene).toEqual(sceneBefore);

      now=3_001;
      state=(await t.call('get_inspection_state',{sessionId:t.sessionId})).structuredContent;
      expect(state.panels.find((entry:any)=>entry.panelId===panel).spatialContext).toMatchObject({ageMs:3_001,stale:true});
      for(const badContext of [
        {...spatialContext,viewDirection:[0,0,0]},
        {...spatialContext,headPosition:[101,0,0],distance:101},
        {...spatialContext,sampledAt:0},
      ]) expect((await t.call('poll_inspection',{...binding,panelId:panel,availability:'ready',spatialContext:badContext})).isError).toBe(true);
      expect((await t.call('detach_inspection',{...binding,panelId:panel,spatialContext})).isError).toBe(true);

      expect((await t.call('poll_inspection',{...binding,panelId:panel,availability:'ready',spatialContext:null})).isError).not.toBe(true);
      state=(await t.call('get_inspection_state',{sessionId:t.sessionId})).structuredContent;
      expect(state.panels.find((entry:any)=>entry.panelId===panel).spatialContext).toBeNull();
      expect((await t.hydrate())._meta[KEY].scene).toEqual(sceneBefore);
    } finally {await t.close();}
  });
  it('carries a spoken answer to the companion page on its own heartbeat, and to no other surface',async()=>{
    const t=await setup();try {
      const saved=(await t.call('sync_inspection',t.args)).structuredContent;
      const binding={sessionId:t.sessionId,serverEpoch:saved.serverEpoch,sourceToken:saved.sourceToken,
        baseStateRevision:saved.stateRevision,baseInspectionRevision:saved.inspectionRevision};
      const companion=(await t.call('attach_inspection',{...binding,surface:'companion'})).structuredContent.panelId;
      const desktop=(await t.call('attach_inspection',{...binding,surface:'desktop'})).structuredContent.panelId;
      const poll=async(panelId:string)=>await t.call('poll_inspection',{...binding,panelId,availability:'ready'});
      // Both pages are already polling, the way a live companion is when an
      // agent answers. Neither is owed anything yet.
      expect((await poll(companion))._meta[KEY].headsetCaption).toBeUndefined();
      expect((await poll(desktop))._meta[KEY].headsetCaption).toBeUndefined();

      // The agent answers while the pages keep beating, which is when the
      // companion takes the caption and the tool learns it was delivered.
      const saying=t.call('say_to_headset',{text:'Thirteen protofilaments, and EB3 marks the seam.',holdSeconds:9});
      await new Promise(resolve=>setTimeout(resolve,25));
      expect((await poll(desktop))._meta[KEY].headsetCaption).toBeUndefined();
      const heard=(await poll(companion))._meta[KEY].headsetCaption;
      const said=await saying;
      expect(said.isError).not.toBe(true);
      expect(said.structuredContent).toMatchObject({queued:true,delivered:true,spoken:true,holdSeconds:9,
        utteranceBinding:'unbound',unbound:true,
        text:'Thirteen protofilaments, and EB3 marks the seam.'});
      expect(said.content[0].text).toContain('This reply was unbound to an utterance.');
      expect(heard).toMatchObject({text:'Thirteen protofilaments, and EB3 marks the seam.',speak:true,holdSeconds:9});
      expect(heard.id).toBe(said.structuredContent.captionId);
      // One page, one copy: the same heartbeat never shows it twice.
      expect((await poll(companion))._meta[KEY].headsetCaption).toBeUndefined();

      const quiet=t.call('say_to_headset',{text:'Rendered.',speak:false});
      await new Promise(resolve=>setTimeout(resolve,25));
      expect((await poll(companion))._meta[KEY].headsetCaption).toMatchObject({text:'Rendered.',speak:false,holdSeconds:6});
      expect((await quiet).structuredContent.delivered).toBe(true);
    } finally {await t.close();}
  });
  it('sends the clip this Mac rendered with the caption, and renders nothing for a silent reply',async()=>{
    const rendered:string[]=[];
    const clip={base64:'T2dnUyBzcG9rZW4=',mimeType:'audio/ogg; codecs=opus',format:'ogg-opus',bytes:11,voice:'Samantha'};
    const replyAudio={ready:true,enabled:true,describe:()=>'test synthesiser',
      synthesize:async(text:string)=>{rendered.push(text);return clip;}};
    const t=await setup({replyAudio});try {
      const saved=(await t.call('sync_inspection',t.args)).structuredContent;
      const binding={sessionId:t.sessionId,serverEpoch:saved.serverEpoch,sourceToken:saved.sourceToken,
        baseStateRevision:saved.stateRevision,baseInspectionRevision:saved.inspectionRevision};
      const companion=(await t.call('attach_inspection',{...binding,surface:'companion'})).structuredContent.panelId;
      const poll=async()=>await t.call('poll_inspection',{...binding,panelId:companion,availability:'ready'});
      expect((await poll())._meta[KEY].headsetCaption).toBeUndefined();

      const saying=t.call('say_to_headset',{text:'The seam runs the length of the lattice.'});
      await new Promise(resolve=>setTimeout(resolve,25));
      const heard=(await poll())._meta[KEY].headsetCaption;
      const said=await saying;
      // The clip is rendered before the caption is queued, so the wearer reads
      // and hears the same answer on one heartbeat.
      expect(rendered).toEqual(['The seam runs the length of the lattice.']);
      expect(heard.audio).toEqual(clip);
      expect(said.structuredContent).toMatchObject({delivered:true,audible:true,audioBytes:11,audioFormat:'ogg-opus'});

      const quiet=t.call('say_to_headset',{text:'Rendered.',speak:false});
      await new Promise(resolve=>setTimeout(resolve,25));
      expect((await poll())._meta[KEY].headsetCaption.audio).toBeUndefined();
      expect((await quiet).structuredContent.audible).toBe(false);
      // A caption-only reply never spends a process on speech.
      expect(rendered).toHaveLength(1);
    } finally {await t.close();}
  });
  it('speaks all forty words as two segments rather than stopping at thirty-six',async()=>{
    const rendered:string[]=[];
    const clip={base64:'T2dnUw==',mimeType:'audio/ogg',format:'ogg',bytes:4};
    const replyAudio={ready:true,enabled:true,describe:()=>'test synthesiser',
      synthesize:async(text:string)=>{rendered.push(text);return clip;}};
    const full=Array.from({length:40},()=> 'word').join(' ');
    const first=Array.from({length:36},()=> 'word').join(' ');
    const rest=Array.from({length:4},()=> 'word').join(' ');
    const t=await setup({replyAudio});try {
      const saved=(await t.call('sync_inspection',t.args)).structuredContent;
      const binding={sessionId:t.sessionId,serverEpoch:saved.serverEpoch,sourceToken:saved.sourceToken,
        baseStateRevision:saved.stateRevision,baseInspectionRevision:saved.inspectionRevision};
      const panelId=(await t.call('attach_inspection',{...binding,surface:'companion'})).structuredContent.panelId;
      const poll=async()=>await t.call('poll_inspection',{...binding,panelId,availability:'ready'});
      await poll();
      const saying=t.call('say_to_headset',{text:full});
      await new Promise(resolve=>setTimeout(resolve,25));
      const caption=(await poll())._meta[KEY].headsetCaption;
      const receipt=await saying;
      // Once per segment, each inside the per-segment ceiling, and nothing dropped.
      expect(rendered).toEqual([first,rest]);
      expect(caption).toMatchObject({text:full,speechText:full,truncated:false,segmentCount:2});
      expect(caption.segments.map((segment:any)=>segment.text)).toEqual([first,rest]);
      // The clip a page that predates segments looks for is the opening one.
      expect(caption.audio).toEqual(clip);
      expect(receipt.structuredContent).toMatchObject({text:full,spokenText:full,truncated:false,stale:false,
        segmentCount:2,audibleSegments:2,speechLimit:{maxChars:240,maxWords:36,maxSeconds:15,replyMaxChars:1200,replyMaxWords:200}});
      expect(receipt.structuredContent.text.split(' ')).toHaveLength(40);
      expect(receipt.content[0].text).toContain('Spoken as 2 segments back to back');
    } finally {await t.close();}
  });
  it('reports a later prepared segment when the opening segment has no clip',async()=>{
    const rendered:string[]=[];
    const clip={base64:'T2dnUw==',mimeType:'audio/ogg',format:'ogg',bytes:4};
    const replyAudio={ready:true,enabled:true,describe:()=>'test synthesiser',
      synthesize:async(text:string)=>{rendered.push(text);return rendered.length===1?undefined:clip;}};
    const full=Array.from({length:40},()=> 'word').join(' ');
    const first=Array.from({length:36},()=> 'word').join(' ');
    const rest=Array.from({length:4},()=> 'word').join(' ');
    const t=await setup({replyAudio});try {
      const saved=(await t.call('sync_inspection',t.args)).structuredContent;
      const binding={sessionId:t.sessionId,serverEpoch:saved.serverEpoch,sourceToken:saved.sourceToken,
        baseStateRevision:saved.stateRevision,baseInspectionRevision:saved.inspectionRevision};
      const panelId=(await t.call('attach_inspection',{...binding,surface:'companion'})).structuredContent.panelId;
      const poll=async()=>await t.call('poll_inspection',{...binding,panelId,availability:'ready'});
      await poll();
      const saying=t.call('say_to_headset',{text:full});
      await new Promise(resolve=>setTimeout(resolve,25));
      const caption=(await poll())._meta[KEY].headsetCaption;
      const receipt=await saying;
      expect(rendered).toEqual([first,rest]);
      expect(caption.audio).toBeUndefined();
      expect(caption.segments.map((segment:any)=>segment.audio)).toEqual([undefined,clip]);
      // Aggregate receipt state follows every prepared segment, including one
      // that a legacy page cannot expose through caption.audio.
      expect(receipt.structuredContent).toMatchObject({delivered:true,audible:true,
        segmentCount:2,audibleSegments:1,audioBytes:4,audioFormat:'ogg'});
      expect(receipt.structuredContent.segments.map((segment:any)=>segment.audible)).toEqual([false,true]);
    } finally {await t.close();}
  });
  it('splits a paragraph at its sentence boundaries and speaks every segment',async()=>{
    const rendered:string[]=[];
    const clip=(seconds:number)=>({base64:'T2dnUw==',mimeType:'audio/ogg; codecs=opus',format:'ogg-opus',bytes:4,seconds});
    const replyAudio={ready:true,enabled:true,describe:()=>'test synthesiser',
      synthesize:async(text:string)=>{rendered.push(text);return clip(4);}};
    // Four full sentences, well past one segment and well inside the reply bound.
    const sentence=(word:string)=>`${Array.from({length:12},()=> word).join(' ')}.`;
    const full=['alpha','beta','gamma','delta'].map(sentence).join(' ');
    const t=await setup({replyAudio});try {
      const saved=(await t.call('sync_inspection',t.args)).structuredContent;
      const binding={sessionId:t.sessionId,serverEpoch:saved.serverEpoch,sourceToken:saved.sourceToken,
        baseStateRevision:saved.stateRevision,baseInspectionRevision:saved.inspectionRevision};
      const panelId=(await t.call('attach_inspection',{...binding,surface:'companion'})).structuredContent.panelId;
      const poll=async()=>await t.call('poll_inspection',{...binding,panelId,availability:'ready'});
      await poll();
      const saying=t.call('say_to_headset',{text:full});
      await new Promise(resolve=>setTimeout(resolve,25));
      const caption=(await poll())._meta[KEY].headsetCaption;
      const receipt=await saying;
      expect(rendered.length).toBeGreaterThan(1);
      for (const line of rendered) {
        expect(line.length).toBeLessThanOrEqual(240);
        expect(line.split(' ').length).toBeLessThanOrEqual(36);
        expect(line.endsWith('.')).toBe(true);
      }
      // Every word the agent submitted is spoken, in order.
      expect(rendered.join(' ')).toBe(full);
      expect(caption.segments.map((segment:any)=>segment.text)).toEqual(rendered);
      expect(caption.segments.map((segment:any)=>segment.index)).toEqual(rendered.map((_,index)=>index));
      // Each clip reported its own length, so the total is measured, not guessed.
      expect(receipt.structuredContent).toMatchObject({segmentCount:rendered.length,audibleSegments:rendered.length,
        durations:'measured',totalSeconds:4*rendered.length,truncated:false,queued:true});
      expect(receipt.structuredContent.segments.every((segment:any)=>segment.duration==='measured')).toBe(true);
      expect(receipt.content[0].text).toContain(`Spoken as ${rendered.length} segments back to back`);
    } finally {await t.close();}
  });
  it('names the tail a newer reply cuts off',async()=>{
    const clip={base64:'T2dnUw==',mimeType:'audio/ogg; codecs=opus',format:'ogg-opus',bytes:4,seconds:5};
    const replyAudio={ready:true,enabled:true,describe:()=>'test synthesiser',synthesize:async()=>clip};
    const sentence=(word:string)=>`${Array.from({length:12},()=> word).join(' ')}.`;
    const full=['alpha','beta','gamma','delta'].map(sentence).join(' ');
    const t=await setup({replyAudio});try {
      const saved=(await t.call('sync_inspection',t.args)).structuredContent;
      const binding={sessionId:t.sessionId,serverEpoch:saved.serverEpoch,sourceToken:saved.sourceToken,
        baseStateRevision:saved.stateRevision,baseInspectionRevision:saved.inspectionRevision};
      const panelId=(await t.call('attach_inspection',{...binding,surface:'companion'})).structuredContent.panelId;
      const poll=async()=>await t.call('poll_inspection',{...binding,panelId,availability:'ready'});
      await poll();
      const saying=t.call('say_to_headset',{text:full});
      await new Promise(resolve=>setTimeout(resolve,25));
      const long=(await poll())._meta[KEY].headsetCaption;
      const first=await saying;
      expect(first.structuredContent.segmentCount).toBeGreaterThan(1);
      expect(first.structuredContent).not.toHaveProperty('supersedes');

      // The correction lands while the long answer is still being spoken.
      const correcting=t.call('say_to_headset',{text:'No, the other copy.'});
      await new Promise(resolve=>setTimeout(resolve,25));
      await poll();
      const second=await correcting;
      expect(second.structuredContent.supersedes).toMatchObject({captionId:long.id,
        segments:first.structuredContent.segmentCount,playedSegments:1,
        droppedSegments:first.structuredContent.segmentCount-1});
      expect(second.content[0].text).toContain(`supersedes ${long.id}`);
    } finally {await t.close();}
  },20_000);
  it('drops a delayed older reply after a newer turn starts',async()=>{
    let releaseOlder!:()=>void;
    let olderStarted!:()=>void;
    const gate=new Promise<void>(resolve=>{releaseOlder=resolve;});
    const started=new Promise<void>(resolve=>{olderStarted=resolve;});
    const clip={base64:'T2dnUw==',mimeType:'audio/ogg',format:'ogg',bytes:4};
    const replyAudio={ready:true,enabled:true,describe:()=>'test synthesiser',synthesize:async(text:string)=>{
      if(text==='Older answer.') {olderStarted();await gate;}
      return clip;
    }};
    const t=await setup({replyAudio});try {
      const saved=(await t.call('sync_inspection',t.args)).structuredContent;
      const binding={sessionId:t.sessionId,serverEpoch:saved.serverEpoch,sourceToken:saved.sourceToken,
        baseStateRevision:saved.stateRevision,baseInspectionRevision:saved.inspectionRevision};
      const panelId=(await t.call('attach_inspection',{...binding,surface:'companion'})).structuredContent.panelId;
      const poll=async()=>await t.call('poll_inspection',{...binding,panelId,availability:'ready'});
      await poll();
      const older=t.call('say_to_headset',{text:'Older answer.'});
      await started;
      const newer=t.call('say_to_headset',{text:'Newer answer.'});
      await new Promise(resolve=>setTimeout(resolve,25));
      expect((await poll())._meta[KEY].headsetCaption).toMatchObject({text:'Newer answer.'});
      expect((await newer).structuredContent).toMatchObject({queued:true,delivered:true,stale:false,
        utteranceBinding:'unbound',unbound:true});
      releaseOlder();
      expect((await older).structuredContent).toMatchObject({queued:false,delivered:false,stale:true,
        text:'Older answer.',spoken:false,audible:false});
      expect((await poll())._meta[KEY].headsetCaption).toBeUndefined();
    } finally {releaseOlder();await t.close();}
  });
  it('refuses a stale utterance ID after a newer utterance is claimed',async()=>{
    const rendered:string[]=[];
    const replyAudio={ready:true,enabled:true,describe:()=>'test synthesiser',synthesize:async(text:string)=>{rendered.push(text);return undefined;}};
    const t=await setup({transcriber:replyBindingTranscriber(),replyAudio});try {
      const saved=(await t.call('sync_inspection',t.args)).structuredContent;
      const binding={sessionId:t.sessionId,serverEpoch:saved.serverEpoch,sourceToken:saved.sourceToken,
        baseStateRevision:saved.stateRevision,baseInspectionRevision:saved.inspectionRevision};
      const panelId=(await t.call('attach_inspection',{...binding,surface:'companion'})).structuredContent.panelId;
      await t.call('poll_inspection',{...binding,panelId,availability:'ready'});
      const oldId='11111111-1111-4111-8111-111111111111';
      const newId='22222222-2222-4222-8222-222222222222';
      const cursor=await claimHeadsetUtterance(t,panelId,oldId);
      await claimHeadsetUtterance(t,panelId,newId,cursor);

      const refused=await t.call('say_to_headset',{text:'Old answer.',utteranceId:oldId});
      expect(refused.structuredContent).toMatchObject({queued:false,delivered:false,spoken:false,stale:true,
        utteranceBinding:'stale',utteranceId:oldId,activeUtteranceId:newId});
      expect(refused.content[0].text).toContain(`${oldId}: active utterance ${newId}`);
      expect(rendered).toEqual([]);
      expect((await t.call('poll_inspection',{...binding,panelId,availability:'ready'}))._meta[KEY].headsetCaption).toBeUndefined();
    } finally {await t.close();}
  });
  it('refuses an admitted reply when a newer utterance wins before the caption claim', async () => {
    const t = await setup({ transcriber: replyBindingTranscriber() });
    try {
      const saved = (await t.call('sync_inspection', t.args)).structuredContent;
      const binding = { sessionId: t.sessionId, serverEpoch: saved.serverEpoch, sourceToken: saved.sourceToken,
        baseStateRevision: saved.stateRevision, baseInspectionRevision: saved.inspectionRevision };
      const panelId = (await t.call('attach_inspection', { ...binding, surface: 'companion' })).structuredContent.panelId;
      await t.call('poll_inspection', { ...binding, panelId, availability: 'ready' });
      const oldId = '66666666-6666-4666-8666-666666666666';
      const newId = '77777777-7777-4777-8777-777777777777';
      const cursor = await claimHeadsetUtterance(t, panelId, oldId);
      const saying = t.call('say_to_headset', { text: 'Answer A.', utteranceId: oldId, speak: false });
      await new Promise(resolve => setTimeout(resolve, 25));
      await claimHeadsetUtterance(t, panelId, newId, cursor);
      const polled = (await t.call('poll_inspection', { ...binding, panelId, availability: 'ready' }))._meta[KEY];
      const receipt = await saying;
      expect(polled.headsetCaption).toBeUndefined();
      expect(polled.headsetCaptionRejections).toEqual([expect.objectContaining({ utteranceId: oldId, activeUtteranceId: newId, stale: true })]);
      expect(receipt.structuredContent).toMatchObject({ queued: false, delivered: false, stale: true,
        utteranceId: oldId, activeUtteranceId: newId });
    } finally { await t.close(); }
  });

  it('accepts a reply naming the active utterance ID',async()=>{
    const rendered:string[]=[];
    const replyAudio={ready:true,enabled:true,describe:()=>'test synthesiser',synthesize:async(text:string)=>{rendered.push(text);return undefined;}};
    const t=await setup({transcriber:replyBindingTranscriber(),replyAudio});try {
      const saved=(await t.call('sync_inspection',t.args)).structuredContent;
      const binding={sessionId:t.sessionId,serverEpoch:saved.serverEpoch,sourceToken:saved.sourceToken,
        baseStateRevision:saved.stateRevision,baseInspectionRevision:saved.inspectionRevision};
      const panelId=(await t.call('attach_inspection',{...binding,surface:'companion'})).structuredContent.panelId;
      await t.call('poll_inspection',{...binding,panelId,availability:'ready'});
      const utteranceId='33333333-3333-4333-8333-333333333333';
      await claimHeadsetUtterance(t,panelId,utteranceId);
      const saying=t.call('say_to_headset',{text:'Current answer.',utteranceId});
      await new Promise(resolve=>setTimeout(resolve,25));
      const caption=(await t.call('poll_inspection',{...binding,panelId,availability:'ready'}))._meta[KEY].headsetCaption;
      const said=await saying;
      expect(said.structuredContent).toMatchObject({queued:true,delivered:true,stale:false,
        utteranceBinding:'active',utteranceId,activeUtteranceId:utteranceId});
      expect(caption).toMatchObject({text:'Current answer.',utteranceId});
      expect(rendered).toEqual(['Current answer.']);
    } finally {await t.close();}
  });
  // A cancel supersedes its own utterance, because it
  // drops the pending work that utterance started. That made the
  // reply telling the wearer their cancellation had landed come back
  // stale:true while activeUtteranceId was the very same id, and the model
  // resent it unbound 11 s later. Supersession by a NEWER utterance still
  // refuses; this is only the utterance's own outcome.
  it('delivers a reply bound to the utterance whose cancel it acknowledges',async()=>{
    const rendered:string[]=[];
    const replyAudio={ready:true,enabled:true,describe:()=>'test synthesiser',synthesize:async(text:string)=>{rendered.push(text);return undefined;}};
    const t=await setup({transcriber:replyBindingTranscriber(),replyAudio});try {
      const saved=(await t.call('sync_inspection',t.args)).structuredContent;
      const binding={sessionId:t.sessionId,serverEpoch:saved.serverEpoch,sourceToken:saved.sourceToken,
        baseStateRevision:saved.stateRevision,baseInspectionRevision:saved.inspectionRevision};
      const panelId=(await t.call('attach_inspection',{...binding,surface:'companion'})).structuredContent.panelId;
      await t.call('poll_inspection',{...binding,panelId,availability:'ready'});
      const utteranceId='44444444-4444-4444-8444-444444444444';
      await claimHeadsetUtterance(t,panelId,utteranceId);
      const cancelled=await t.call('update_inspection',{...binding,panelId,utteranceId,commandId:'cancel-that',
        change:{kind:'utterance',patch:{action:'cancel'}}});
      expect(cancelled.isError).not.toBe(true);
      expect(cancelled.structuredContent.lifecycle.utterance.supersededBy).toBe(utteranceId);
      const saying=t.call('say_to_headset',{text:'Cancelled.',utteranceId});
      await new Promise(resolve=>setTimeout(resolve,25));
      const caption=(await t.call('poll_inspection',{...binding,panelId,availability:'ready'}))._meta[KEY].headsetCaption;
      expect((await saying).structuredContent).toMatchObject({queued:true,delivered:true,stale:false,
        utteranceBinding:'active',utteranceId,activeUtteranceId:utteranceId});
      expect(caption).toMatchObject({text:'Cancelled.',utteranceId});
      expect(rendered).toEqual(['Cancelled.']);
    } finally {await t.close();}
  });
  it('still refuses a reply bound to an utterance a newer correction superseded',async()=>{
    const t=await setup({transcriber:replyBindingTranscriber()});try {
      const saved=(await t.call('sync_inspection',t.args)).structuredContent;
      const binding={sessionId:t.sessionId,serverEpoch:saved.serverEpoch,sourceToken:saved.sourceToken,
        baseStateRevision:saved.stateRevision,baseInspectionRevision:saved.inspectionRevision};
      const panelId=(await t.call('attach_inspection',{...binding,surface:'companion'})).structuredContent.panelId;
      await t.call('poll_inspection',{...binding,panelId,availability:'ready'});
      const oldId='55555555-5555-4555-8555-555555555555',newId='58585858-5858-4858-8858-585858585858';
      const cursor=await claimHeadsetUtterance(t,panelId,oldId);
      await claimHeadsetUtterance(t,panelId,newId,cursor);
      expect((await t.call('update_inspection',{...binding,panelId,utteranceId:newId,commandId:'cancel-newer',
        change:{kind:'utterance',patch:{action:'cancel'}}})).isError).not.toBe(true);
      expect((await t.call('say_to_headset',{text:'Old answer.',utteranceId:oldId})).structuredContent).toMatchObject({
        queued:false,delivered:false,stale:true,utteranceBinding:'stale',utteranceId:oldId,activeUtteranceId:newId});
    } finally {await t.close();}
  });
  it('refuses an old answer submitted after the new answer',async()=>{
    const rendered:string[]=[];
    const replyAudio={ready:true,enabled:true,describe:()=>'test synthesiser',synthesize:async(text:string)=>{rendered.push(text);return undefined;}};
    const t=await setup({transcriber:replyBindingTranscriber(),replyAudio});try {
      const saved=(await t.call('sync_inspection',t.args)).structuredContent;
      const binding={sessionId:t.sessionId,serverEpoch:saved.serverEpoch,sourceToken:saved.sourceToken,
        baseStateRevision:saved.stateRevision,baseInspectionRevision:saved.inspectionRevision};
      const panelId=(await t.call('attach_inspection',{...binding,surface:'companion'})).structuredContent.panelId;
      await t.call('poll_inspection',{...binding,panelId,availability:'ready'});
      const oldId='44444444-4444-4444-8444-444444444444';
      const newId='55555555-5555-4555-8555-555555555555';
      const cursor=await claimHeadsetUtterance(t,panelId,oldId);
      await claimHeadsetUtterance(t,panelId,newId,cursor);
      const newer=t.call('say_to_headset',{text:'New answer.',utteranceId:newId});
      await new Promise(resolve=>setTimeout(resolve,25));
      expect((await t.call('poll_inspection',{...binding,panelId,availability:'ready'}))._meta[KEY].headsetCaption.text).toBe('New answer.');
      expect((await newer).structuredContent.delivered).toBe(true);

      const older=await t.call('say_to_headset',{text:'Old answer.',utteranceId:oldId});
      expect(older.structuredContent).toMatchObject({queued:false,stale:true,utteranceId:oldId,activeUtteranceId:newId});
      expect((await t.call('poll_inspection',{...binding,panelId,availability:'ready'}))._meta[KEY].headsetCaption).toBeUndefined();
      expect(rendered).toEqual(['New answer.']);
    } finally {await t.close();}
  });
  it('answers with the caption alone when this host cannot render speech',async()=>{
    const t=await setup();try {
      const said=await t.call('say_to_headset',{text:'Still readable.'});
      expect(said.isError).not.toBe(true);
      expect(said.structuredContent).toMatchObject({queued:true,audible:false});
      expect(said.structuredContent).not.toHaveProperty('audioBytes');
    } finally {await t.close();}
  },20_000);
  it('reports an answer nobody took as queued rather than delivered, and refuses an empty one',async()=>{
    const t=await setup();try {
      const said=await t.call('say_to_headset',{text:'Nobody is wearing the headset.'});
      expect(said.isError).not.toBe(true);
      expect(said.structuredContent).toMatchObject({queued:true,delivered:false});
      // With no share and no page, "queued" on its own reads as
      // success. The receipt says whether anyone was on the other end.
      expect(said.structuredContent.wearer).toMatchObject({linked:false,share:false});
      expect(said.structuredContent.wearer.note).toContain('No wearer is linked');
      expect(said.content[0].text).toContain('Queued, but nothing took it');
      expect(said.content[0].text).toContain('No wearer is linked');
      expect((await t.call('say_to_headset',{text:'   '})).isError).toBe(true);
      // 280 characters is no longer the bound; a paragraph is accepted.
      expect((await t.call('say_to_headset',{text:'a'.repeat(281)})).isError).not.toBe(true);
      // Past the whole-reply bound the refusal names the limit rather than
      // quietly shortening the answer.
      const long=await t.call('say_to_headset',{text:'a'.repeat(1201)});
      expect(long.isError).toBe(true);
      expect(JSON.stringify(long.content)).toContain('1200');
      const wordy=await t.call('say_to_headset',{text:Array.from({length:201},()=> 'word').join(' ')});
      expect(wordy.isError).toBe(true);
      expect(JSON.stringify(wordy.content)).toContain('200 words');
      expect((await t.call('say_to_headset',{text:'ok',holdSeconds:99})).isError).toBe(true);
    } finally {await t.close();}
  },20_000);
  it('round-trips a source-bound desktop voice claim and acknowledgement',async()=>{
    const t=await setup({voice:{transcribe:async()=> 'What does this structure do?'}});try {
      const saved=(await t.call('sync_inspection',t.args)).structuredContent;
      const binding={sessionId:t.sessionId,serverEpoch:saved.serverEpoch,sourceToken:saved.sourceToken,
        baseStateRevision:saved.stateRevision,baseInspectionRevision:saved.inspectionRevision};
      const companionPanel=(await t.call('attach_inspection',{...binding,surface:'companion'})).structuredContent.panelId;
      const desktopPanel=(await t.call('attach_inspection',{...binding,surface:'desktop'})).structuredContent.panelId;
      const audio={pcm16leBase64:Buffer.alloc(8_640).toString('base64'),sampleRate:24_000,durationMs:180};
      const request=await t.call('voice_command',{...binding,panelId:companionPanel,audio});
      expect(request.isError).not.toBe(true);
      expect(request.structuredContent.intentId).toEqual(expect.any(String));

      const claimed=await t.call('claim_voice_intent',{...binding,panelId:desktopPanel});
      expect(claimed.isError).not.toBe(true);
      const voiceIntent=claimed._meta[KEY].voiceIntent;
      expect(voiceIntent.intent.transcript).toBe('What does this structure do?');
      expect(voiceIntent.intent.sessionId).toBe(t.sessionId);
      expect(voiceIntent.intent.sourceToken).toBe(binding.sourceToken);

      const acknowledged=await t.call('acknowledge_voice_intent',{...binding,panelId:desktopPanel,
        intentId:voiceIntent.intent.id,claimToken:voiceIntent.claimToken});
      expect(acknowledged.isError).not.toBe(true);
      expect(acknowledged.structuredContent).toEqual({acknowledged:true});
      // The flat receipt is one-shot: a retry cannot acknowledge a different
      // intent or silently pass after the original claim was consumed.
      expect((await t.call('acknowledge_voice_intent',{...binding,panelId:desktopPanel,
        intentId:voiceIntent.intent.id,claimToken:voiceIntent.claimToken})).isError).toBe(true);
    } finally {await t.close();}
  });
  it('speaks a tour line while the scene that prompted it is still being applied',async()=>{
    const spoken:string[]=[];
    const t=await setup({voice:{acknowledge:async(message:string)=>{
      spoken.push(message);return {wavBase64:Buffer.from(`RIFF${message}`).toString('base64')};}}});
    try {
      const saved=(await t.call('sync_inspection',t.args)).structuredContent;
      const binding={sessionId:t.sessionId,serverEpoch:saved.serverEpoch,sourceToken:saved.sourceToken,
        baseStateRevision:saved.stateRevision,baseInspectionRevision:saved.inspectionRevision};
      const companion=(await t.call('attach_inspection',{...binding,surface:'companion'})).structuredContent.panelId;
      // The agent's tour step is pending: the page is drawing the scene the
      // narration describes. This is exactly when a tour asks to speak, and
      // the capture gate used to refuse it as a 409.
      const queued=await t.call('update_inspection',{...binding,panelId:companion,commandId:'tour-next',
        change:{kind:'tour',patch:{action:'next'}}});
      expect(queued.structuredContent.command.status).toBe('queued');
      const narration=await t.call('voice_acknowledgement',{...binding,panelId:companion,message:'Next step.'});
      expect(narration.isError).not.toBe(true);
      expect(narration.structuredContent.wavBase64).toEqual(expect.any(String));
      // One scene change produces a confirmation and a narration in the same
      // tick. Neither may be refused because the other went first.
      const second=await t.call('voice_acknowledgement',{...binding,panelId:companion,message:'The lattice widens.'});
      expect(second.isError).not.toBe(true);
      expect(spoken).toEqual(['Next step.','The lattice widens.']);
      // A panel holding a stale revision is still the wearer's headset.
      const stale=await t.call('voice_acknowledgement',{...binding,baseInspectionRevision:binding.baseInspectionRevision-1,
        panelId:companion,message:'Still current.'});
      expect(stale.isError).not.toBe(true);
      // Identity is unchanged: a replaced source and a desktop panel are refused.
      expect((await t.call('voice_acknowledgement',{...binding,sourceToken:randomUUID(),panelId:companion,message:'Stale.'})).isError).toBe(true);
      const desktop=(await t.call('attach_inspection',{...binding,surface:'desktop'})).structuredContent.panelId;
      expect((await t.call('voice_acknowledgement',{...binding,panelId:desktop,message:'Wrong surface.'})).isError).toBe(true);
      // Capture still holds the exclusive, current-view gate it always had.
      const audio={pcm16leBase64:Buffer.alloc(8_640).toString('base64'),sampleRate:24_000,durationMs:180};
      expect((await t.call('voice_command',{...binding,baseInspectionRevision:binding.baseInspectionRevision-1,
        panelId:companion,audio})).isError).toBe(true);
    } finally {await t.close();}
  });
  it('leases a source transition to its target panel before a saved scene lets followers hydrate',async()=>{
    let now=0;
    const t=await setup({fetchPdbText:async()=>cif,now:()=>now});try {
      const saved=(await t.call('sync_inspection',t.args)).structuredContent;
      const binding={sessionId:t.sessionId,serverEpoch:saved.serverEpoch,sourceToken:saved.sourceToken,
        baseStateRevision:saved.stateRevision,baseInspectionRevision:saved.inspectionRevision};
      const desktop=(await t.call('attach_inspection',{...binding,surface:'desktop'})).structuredContent.panelId;
      const companion=(await t.call('attach_inspection',{...binding,surface:'companion'})).structuredContent.panelId;
      const replaced=await t.call('replace_inspection_source',{...binding,panelId:desktop,pdbId:'4HHB'});
      expect(replaced.isError).not.toBe(true);
      const next=replaced.structuredContent;
      const nextBinding={sessionId:t.sessionId,serverEpoch:next.serverEpoch,sourceToken:next.sourceToken,
        baseStateRevision:next.stateRevision,baseInspectionRevision:next.inspectionRevision};
      // The named renderer receives the private lease even while it still
      // holds its old source binding. A follower does not receive it.
      const target=await t.call('poll_inspection',{...binding,panelId:desktop,availability:'ready'});
      expect(target._meta[KEY].transitionTarget).toBe(true);
      const beforeSave=await t.call('poll_inspection',{...binding,panelId:companion,availability:'ready'});
      expect(beforeSave.isError).not.toBe(true);
      expect(beforeSave.structuredContent.hasScene).toBe(false);
      expect(beforeSave._meta[KEY].transitionTarget).toBe(false);
      // If the target disappears, one later polling panel deterministically
      // acquires the bounded lease instead of all followers remaining stuck.
      now=120_001;
      const fallback=await t.call('poll_inspection',{...nextBinding,panelId:companion,availability:'ready'});
      expect(fallback._meta[KEY].transitionTarget).toBe(true);

      const hydrated=(await t.hydrate())._meta[KEY];
      const nextScene=structuredClone(t.scene);nextScene.sourceSha256=hydrated.catalog.source.sha256;
      const savedNext=await t.call('sync_inspection',{...nextBinding,scene:nextScene});
      expect(savedNext.structuredContent.saved).toBe(true);
      const savedBinding={sessionId:t.sessionId,serverEpoch:savedNext.structuredContent.serverEpoch,sourceToken:savedNext.structuredContent.sourceToken,
        baseStateRevision:savedNext.structuredContent.stateRevision,baseInspectionRevision:savedNext.structuredContent.inspectionRevision};
      // A newly hydrated panel can register normally; a retired transition
      // target does not reserve a panel ID or block the replacement source.
      expect((await t.call('attach_inspection',{...savedBinding,surface:'companion'})).isError).not.toBe(true);
      const afterSave=await t.call('poll_inspection',{...savedBinding,panelId:companion,availability:'ready'});
      expect(afterSave.isError).not.toBe(true);
      expect(afterSave.structuredContent.hasScene).toBe(true);
    } finally {await t.close();}
  });
  it('renders shared undo and redo through the authenticated HTTP companion dispatch',async()=>{
    const folder=await mkdtemp(join(tmpdir(),'stereofold-http-history-'));
    await writeFile(join(folder,'inspector.html'),'<html><script>void 0;</script></html>');
    const t=await setup({},join(folder,'viewer.html'));
    try {
      const bindingFor=(state:any)=>({sessionId:t.sessionId,serverEpoch:state.serverEpoch,sourceToken:state.sourceToken,
        baseStateRevision:state.stateRevision,baseInspectionRevision:state.inspectionRevision});
      const initial=(await t.call('sync_inspection',t.args)).structuredContent;
      const opened=await t.call('open_companion',bindingFor(initial));
      const url=new URL(opened.structuredContent.companion.url);
      const httpCall=async(name:string,args:any)=>{
        const response=await fetch(`${url.origin}/tool`,{method:'POST',headers:{authorization:`Bearer ${url.hash.slice(1)}`,origin:url.origin,'content-type':'application/json'},body:JSON.stringify({name,args})});
        const body=await response.json() as any;
        expect(response.status,`${name}: ${JSON.stringify(body)}`).toBe(200);
        expect(body.isError).not.toBe(true);
        return body;
      };
      const panelId=(await httpCall('attach_inspection',bindingFor(initial))).structuredContent.panelId;
      const edited=structuredClone(t.scene);edited.inspection.appearance.representation='ball-and-stick';
      let current=(await httpCall('sync_inspection',{...bindingFor(initial),scene:edited})).structuredContent;
      expect(current.history).toEqual({undoCount:1,redoCount:0,canUndo:true,canRedo:false});
      for(const [kind,target,counts] of [
        ['undo',t.scene,{undoCount:0,redoCount:1,canUndo:false,canRedo:true}],
        ['redo',edited,{undoCount:1,redoCount:0,canUndo:true,canRedo:false}],
      ] as const) {
        const binding=bindingFor(current),commandId=`http-history-${kind}`;
        await httpCall('poll_inspection',{...binding,panelId,availability:'ready'});
        const requested=await httpCall(`${kind}_last_change`,{...binding,panelId,commandId});
        expect(requested.structuredContent[kind==='undo'?'undone':'redone']).toBe(true);
        expect(requested.structuredContent.command.status).toBe('queued');
        expect(requested.structuredContent.history).toMatchObject({canUndo:false,canRedo:false});
        const delivery=(await httpCall('poll_inspection',{...binding,panelId,availability:'ready'}))._meta[KEY].delivery;
        expect(delivery.historyAction).toBe(kind);
        expect(delivery.change).toMatchObject({kind:'appearance',patch:{representation:target.inspection.appearance.representation}});
        const completed=await httpCall('complete_inspection',{...binding,panelId,commandId,claimToken:delivery.claimToken,scene:target});
        expect(completed.structuredContent.command).toMatchObject({status:'rendered',renderedRevision:current.inspectionRevision+1});
        current=completed.structuredContent;
        expect(current.history).toEqual(counts);
        expect((await t.hydrate())._meta[KEY].scene).toEqual(target);
      }
    } finally {await t.close();await rm(folder,{recursive:true,force:true});}
  });
  it('retargets an existing HTTP companion link after a desktop-origin source transition',async()=>{
    const folder=await mkdtemp(join(tmpdir(),'stereofold-http-retarget-'));
    await writeFile(join(folder,'viewer.html'),'<html><script>void 0;</script></html>');
    await writeFile(join(folder,'inspector.html'),'<html><script>void 0;</script></html>');
    const t=await setup({fetchPdbText:async()=>cif},join(folder,'viewer.html'));let companionUrl:string|undefined;try {
      const saved=(await t.call('sync_inspection',t.args)).structuredContent;
      const binding={sessionId:t.sessionId,serverEpoch:saved.serverEpoch,sourceToken:saved.sourceToken,
        baseStateRevision:saved.stateRevision,baseInspectionRevision:saved.inspectionRevision};
      const desktop=(await t.call('attach_inspection',{...binding,surface:'desktop'})).structuredContent.panelId;
      const opened=await t.call('open_companion',binding);
      companionUrl=opened.structuredContent.companion.url;
      const url=new URL(companionUrl as string);
      const httpCall=async(name:string,args:any)=>{
        const response=await fetch(`${url.origin}/tool`,{method:'POST',headers:{authorization:`Bearer ${url.hash.slice(1)}`,origin:url.origin,'content-type':'application/json'},body:JSON.stringify({name,args})});
        expect(response.status).toBe(200);return response.json() as Promise<any>;
      };
      const attached=await httpCall('attach_inspection',binding);const companion=attached.structuredContent.panelId;
      const replaced=await t.call('replace_inspection_source',{...binding,panelId:desktop,pdbId:'4HHB'});
      expect(replaced.isError).not.toBe(true);
      const next=replaced.structuredContent;
      const stalePoll=await httpCall('poll_inspection',{...binding,panelId:companion,availability:'ready'});
      expect(stalePoll.structuredContent).toMatchObject({sourceToken:next.sourceToken,hasScene:false});
      expect(stalePoll._meta[KEY].delivery).toBeUndefined();
      // A browser may retry the same heartbeat while the bearer retarget is
      // already complete. The request's old binding remains a read-only
      // transition signal and must not be mistaken for a mutation.
      const retryPoll=await httpCall('poll_inspection',{...binding,panelId:companion,availability:'ready'});
      expect(retryPoll.structuredContent).toMatchObject({sourceToken:next.sourceToken,hasScene:false});
      const hydrated=await httpCall('get_inspection',{});
      expect(hydrated._meta[KEY].source.sha256).toBe((await t.hydrate())._meta[KEY].catalog.source.sha256);
    } finally {await t.close();await rm(folder,{recursive:true,force:true});}
    if(companionUrl) await expect(fetch(new URL(companionUrl).origin)).rejects.toThrow();
  });
  it('connects the exact source to HTTP, shares canonical changes, and reserves command rendering before commit',async()=>{
    const folder=await mkdtemp(join(tmpdir(),'stereofold-shared-'));
    await writeFile(join(folder,'inspector.html'),'<html><script>void 0;</script></html>');
    const t=await setup({fetchPdbText:async()=>cif},join(folder,'viewer.html'));
    let companionUrl:string|undefined;
    try {
      expect((await t.call('open_companion',{...t.args,waitForSceneMs:200})).isError).toBe(true); // scene is not part of this input
      const {scene,...initial}=t.args;
      // A short call wait ends while the draw keeps its render budget.
      expect((await t.call('open_companion',{...initial,waitForSceneMs:200})).structuredContent.sharePending.status).toBe('rendering');
      await t.call('sync_inspection',t.args);
      const current={...initial,baseInspectionRevision:1};
      const desktop=(await t.call('attach_inspection',current)).structuredContent.panelId;
      const opened=await t.call('open_companion',current);
      expect(opened.structuredContent.shared).toBe(true);
      companionUrl=opened.structuredContent.companion.url;
      const url=new URL(companionUrl!);
      const httpCall=async(name:string,args:any)=>{
        const response=await fetch(`${url.origin}/tool`,{method:'POST',headers:{authorization:`Bearer ${url.hash.slice(1)}`,origin:url.origin,'content-type':'application/json'},body:JSON.stringify({name,args})});
        expect(response.status).toBe(200);return response.json() as Promise<any>;
      };
      const hydration=await httpCall('get_inspection',{});
      expect(hydration._meta[KEY].structureText).toBeUndefined();
      expect(hydration._meta[KEY].source.sha256).toBe(t.scene.sourceSha256);
      const attached=await httpCall('attach_inspection',current),companion=attached.structuredContent.panelId;
      const state=(await t.call('get_inspection_state',{sessionId:t.sessionId})).structuredContent;
      expect(state.panels.find((p:any)=>p.panelId===companion).surface).toBe('companion');
      const change={kind:'appearance',patch:{uniformColor:'#dd55aa'}};
      await t.call('update_inspection',{...current,panelId:companion,commandId:'shared-pink',change});
      const manual=structuredClone(t.scene);manual.selectionKeys=[];
      expect((await t.call('sync_inspection',{...current,scene:manual})).structuredContent.busy).toBe(true);
      const claim=(await httpCall('poll_inspection',{...current,panelId:companion,availability:'ready'}))._meta[KEY].delivery;
      expect((await t.hydrate())._meta[KEY].scene).toEqual(t.scene); // queued/drawing is not a commit
      const rendered=structuredClone(t.scene);rendered.inspection.appearance.uniformColor='#dd55aa';
      const confirmed=await httpCall('complete_inspection',{...current,panelId:companion,commandId:'shared-pink',claimToken:claim.claimToken,scene:rendered});
      expect(confirmed.structuredContent.command).toMatchObject({status:'rendered',renderedRevision:2});
      const desktopPoll=await t.call('poll_inspection',{...current,panelId:desktop,availability:'ready'});
      expect(desktopPoll._meta[KEY].scene).toEqual(rendered);
      expect(desktopPoll.structuredContent.outcome).toMatchObject({status:'rendered',fields:['uniformColor']});
      expect((await t.call('sync_inspection',{...current,scene:manual})).structuredContent.conflict).toBe(true);
      expect((await t.hydrate())._meta[KEY].scene).toEqual(rendered);
      const latest=(await t.call('get_inspection_state',{sessionId:t.sessionId})).structuredContent;
      const replacementBinding={sessionId:t.sessionId,serverEpoch:latest.serverEpoch,sourceToken:latest.sourceToken,
        baseStateRevision:latest.stateRevision,baseInspectionRevision:latest.inspectionRevision};
      await httpCall('poll_inspection',{...replacementBinding,panelId:companion,availability:'ready'});
      const switched=await httpCall('replace_inspection_source',{...replacementBinding,panelId:companion,pdbId:'4HHB'});
      expect(switched.structuredContent.sourceTransition).toEqual({sourceChanged:true,pdbId:'4HHB'});
      expect(switched.structuredContent.sourceToken).not.toBe(replacementBinding.sourceToken);
      // The original bookmarked loopback URL remains usable only because this
      // was an authenticated same-session source transition.
      expect((await httpCall('get_inspection',{}))._meta[KEY].source.sha256).toBe(t.scene.sourceSha256);
      await t.call('open',{sessionId:t.sessionId,structureText:cif});
      const stale=await fetch(`${url.origin}/source`,{headers:{authorization:`Bearer ${url.hash.slice(1)}`}});
      expect(stale.status).toBe(409);
    } finally {await t.close();await rm(folder,{recursive:true,force:true});}
    if(companionUrl) await expect(fetch(new URL(companionUrl).origin)).rejects.toThrow();
  });
  // An MCP Apps host gates widget-initiated calls on `_meta.ui.visibility`:
  // absent leaves the tool unrestricted, while a declared list must name 'app'
  // or the host refuses the call as model-only. The panel's own tool names are
  // read out of its source so this cannot drift as the panel gains calls.
  it('keeps every tool the panel calls reachable from the widget',async()=>{
    const source=await readFile(new URL('../src/inspector.ts',import.meta.url),'utf8');
    const called=[...new Set([...source.matchAll(/\bcall\('([a-z_]+)'/g)].map((match)=>match[1]))];
    expect(called).toContain('open_companion');
    expect(called).toContain('manage_companion');
    expect(called.length).toBeGreaterThan(5);
    const t=await setup();try {
      const {tools}=await t.client.listTools();
      for(const name of called) {
        const tool=tools.find((entry)=>entry.name===`stereo_structure.${name}`);
        expect(tool,name).toBeDefined();
        const visibility=(tool?._meta as any)?.ui?.visibility;
        if(visibility===undefined) continue;
        expect(Array.isArray(visibility),name).toBe(true);
        expect(visibility,name).toContain('app');
      }
    } finally {await t.close();}
  });

  // The LAN listener is one host-wide resource, so ownership decides who may
  // start, stop and revoke it. Without a private interface there is nothing to
  // bind and the host cannot exercise this path at all.
  it('refuses a second session the live LAN companion and retires its own on a transport switch',async()=>{
    const lanAddress=listLanAddresses()[0]; if(!lanAddress) return;
    const folder=await mkdtemp(join(tmpdir(),'stereofold-lan-owner-'));
    await writeFile(join(folder,'inspector.html'),'<html><script>void 0;</script></html>');
    // The server builds its own LanCompanion, whose certificate store follows
    // the home directory. Redirect it so the test never writes a real one.
    const home=process.env.HOME;
    process.env.HOME=folder;
    const t=await setup({sceneServiceFile:join(folder,'scene-service.json')},join(folder,'viewer.html'));
    const lanPort=await unusedPort(lanAddress.address);
    try {
      await t.call('sync_inspection',t.args);
      const {scene,...initial}=t.args;
      const first={...initial,baseInspectionRevision:1};
      const lanArgs={connection:'lan',lanHost:lanAddress.address,lanPort};
      const owned=await t.call('open_companion',{...first,...lanArgs});
      expect(owned.isError).not.toBe(true);
      expect(owned.structuredContent.companion.connection).toBe('lan');
      expect(await reachable(lanAddress.address,lanPort)).toBe(true);

      // A second session on the same server must not seize the listener, which
      // would clear the first session's paired clients and then lock it out of
      // manage_companion entirely.
      const other=await t.call('inspect',{structureText:cif});
      const otherId=other.structuredContent.sessionId;
      const otherData=(await t.call('get_inspection',{sessionId:otherId}))._meta[KEY];
      const otherBinding={sessionId:otherId,serverEpoch:otherData.serverEpoch,sourceToken:otherData.sourceToken,
        baseStateRevision:otherData.stateRevision,baseInspectionRevision:otherData.inspectionRevision};
      await t.call('sync_inspection',{...otherBinding,scene});
      const seized=await t.call('open_companion',{...otherBinding,baseInspectionRevision:1,...lanArgs});
      expect(seized.isError).toBe(true);
      expect(JSON.stringify(seized)).toContain('different inspection session');
      // The refusal left the original owner's listener untouched and usable.
      expect(await reachable(lanAddress.address,lanPort)).toBe(true);
      expect((await t.call('manage_companion',{sessionId:t.sessionId,serverEpoch:first.serverEpoch,sourceToken:first.sourceToken,action:'status'})).structuredContent.lan).not.toBeNull();

      // Switching the owner to loopback must close the private HTTPS listener
      // instead of leaving it running under an owner no longer sharing on it.
      const local=await t.call('open_companion',{...first,connection:'loopback'});
      expect(local.structuredContent.companion.connection).toBe('loopback');
      expect(await reachable(lanAddress.address,lanPort)).toBe(false);
      expect((await t.call('manage_companion',{sessionId:t.sessionId,serverEpoch:first.serverEpoch,sourceToken:first.sourceToken,action:'status'})).structuredContent.lan).toBeNull();

      // Ownership is released with the listener, so the other session can take it.
      const taken=await t.call('open_companion',{...otherBinding,baseInspectionRevision:1,...lanArgs});
      expect(taken.isError).not.toBe(true);
      expect(taken.structuredContent.companion.connection).toBe('lan');
    } finally {
      await t.close();
      if(home===undefined) delete process.env.HOME; else process.env.HOME=home;
      await rm(folder,{recursive:true,force:true});
    }
  },30_000);

  // One tool call from any host has to put the page on the headset, so the
  // launch is exercised through the server rather than only through the CLI.
  it('refuses a launch on a transport that no headset can reach',async()=>{
    const t=await setup();try {
      await t.call('sync_inspection',t.args);
      const {scene,...initial}=t.args;
      const current={...initial,baseInspectionRevision:1};
      for(const connection of ['loopback','https']) {
        const refused=await t.call('open_companion',{...current,connection,launch:'web'});
        expect(refused.isError,connection).toBe(true);
        expect(refused.content[0].text,connection).toContain('only available with connection');
      }
    } finally {await t.close();}
  });

  async function companionReuseFixture(initialLaunch:'none'|'web'='none',userAgent='Quest 2 test browser') {
    const address=listLanAddresses()[0]; if(!address) return;
    const folder=await mkdtemp(join(tmpdir(),'stereofold-companion-reuse-'));
    const html=`<html><script>const build='${VIEWER_BUILD_PLACEHOLDER}';</script></html>`;
    const pageBuild=createHash('sha256').update(html,'utf8').digest('hex');
    await writeFile(join(folder,'inspector.html'),html.replace(VIEWER_BUILD_PLACEHOLDER,pageBuild));
    const home=process.env.HOME;process.env.HOME=folder;
    let now=Date.now(), launches=0;
    const t=await setup({sceneServiceFile:join(folder,'scene-service.json'),now:()=>now,
      questLaunch:{platform:'darwin',opener:'/bin/echo',launch:()=>{launches++;return {reason:'started' as const};}}},join(folder,'viewer.html'));
    const options={sessionId:t.sessionId,connection:'lan',lanHost:address.address,lanPort:await unusedPort(address.address)};
    try {
      const saved=(await t.call('sync_inspection',t.args)).structuredContent;
      const bound={sessionId:t.sessionId,serverEpoch:saved.serverEpoch,sourceToken:saved.sourceToken,
        baseStateRevision:saved.stateRevision,baseInspectionRevision:saved.inspectionRevision};
      const opened=await t.call('open_companion',{...options,launch:initialLaunch,headset:initialLaunch==='web'?'meta':'auto'});
      expect(opened.isError).not.toBe(true);
      const paired=await lanRequest(address.address,options.lanPort,'/pair',{code:opened.structuredContent.companion.pairingCode},undefined,userAgent);
      expect(paired.status).toBe(200);
      const panelId=(await t.call('attach_inspection',{...bound,surface:'companion'})).structuredContent.panelId;
      const beat=async(extra={})=>{
        const response=await lanRequest(address.address,options.lanPort,'/tool',{name:'poll_inspection',
          args:{...bound,panelId,availability:'ready',pageBuild,...extra}},paired.body.token);
        expect(response.status).toBe(200);
      };
      const close=async()=>{await t.close();if(home===undefined)delete process.env.HOME;else process.env.HOME=home;
        await rm(folder,{recursive:true,force:true});};
      return {t,options,bound,panelId,beat,close,launches:()=>launches,advance:(ms:number)=>{now+=ms;},
        opened,paired};
    } catch(error) {await t.close();if(home===undefined)delete process.env.HOME;else process.env.HOME=home;
      await rm(folder,{recursive:true,force:true});throw error;}
  }

  for(const paused of [false,true]) it(`reuses an authenticated current ${paused?'paused':'ready'} headset page without another launch`,async()=>{
    const f=await companionReuseFixture();if(!f)return;
    try {
      await f.beat(paused?{availability:'busy',xrStartup:{phase:'idle',pending:false,reloadRequired:false,mode:null,gestureActive:null,presenting:false,visible:false}}:{});
      const reused=await f.t.call('open_companion',{...f.options,launch:'web',headset:'meta',waitForHeadsetMs:20_000});
      expect(reused.isError).not.toBe(true);
      expect(reused.structuredContent.headsetPage).toMatchObject({reused:true,drew:!paused,waitedMs:0,
        state:paused?'paused':'page-open',panelId:f.panelId});
      expect(reused.structuredContent.launch).toMatchObject({opened:false,reused:true});
      expect(f.launches()).toBe(0);
      expect(reused.content[0].text).toContain('no launch was sent');
      // An explicit request still launches, while retaining the listener and clients.
      const forced=await f.t.call('manage_companion',{sessionId:f.t.sessionId,action:'launch',launch:'web',headset:'meta'});
      expect(forced.isError).not.toBe(true);
      expect(f.launches()).toBe(1);
    } finally {await f.close();}
  },30_000);

  it('reuses the current page on a repeated open after its first launch',async()=>{
    const f=await companionReuseFixture('web');if(!f)return;
    try {
      await f.beat();
      const reused=await f.t.call('open_companion',{...f.options,launch:'web',headset:'meta'});
      expect(reused.isError).not.toBe(true);
      expect(reused.structuredContent.headsetPage).toMatchObject({reused:true,state:'page-open'});
      expect(f.launches()).toBe(1);
    } finally {await f.close();}
  },30_000);

  it('honors a different named headset handoff instead of reusing the first target',async()=>{
    const f=await companionReuseFixture('web');if(!f)return;
    try {
      await f.beat();
      const handed=await f.t.call('open_companion',{...f.options,launch:'web',headset:'apple'});
      expect(handed.isError).not.toBe(true);
      expect(handed.structuredContent.headsetPage?.reused).not.toBe(true);
      expect(handed.structuredContent.launch).toMatchObject({target:'apple',handoff:'manual'});
      expect(f.launches()).toBe(1);
    } finally {await f.close();}
  },30_000);

  for(const target of ['meta','apple'] as const) it(`reuses an auto share with positive ${target} page evidence`,async()=>{
    const f=await companionReuseFixture('none',target==='meta'?'Quest 2 test browser':'Safari test browser');if(!f)return;
    try {
      await f.beat(target==='apple'?{diagnostics:{entries:[{seq:1,at:1,kind:'session-start',detail:{deviceClass:'vision-pro'}}]}}:{});
      const reused=await f.t.call('open_companion',{...f.options,launch:'web',headset:target});
      expect(reused.isError).not.toBe(true);
      expect(reused.structuredContent.headsetPage).toMatchObject({reused:true,state:'page-open',panelId:f.panelId});
      expect(f.launches()).toBe(0);
    } finally {await f.close();}
  },30_000);

  for(const [device,target] of [['quest','apple'],['apple','meta'],['unknown','meta'],['unknown','apple']] as const)
    it(`launches an auto share rather than reusing a ${device} page for ${target}`,async()=>{
      const f=await companionReuseFixture('none',device==='quest'?'Quest 2 test browser':'Safari test browser');if(!f)return;
      try {
        await f.beat(device==='apple'?{diagnostics:{entries:[{seq:1,at:1,kind:'session-start',detail:{deviceClass:'vision-pro'}}]}}:{});
        // The first attempt sets the target metadata. That cannot turn an
        // unknown or opposite-family page into proof of a later successful launch.
        for(let attempt=0;attempt<2;attempt++) {
          const launched=await f.t.call('open_companion',{...f.options,launch:'web',headset:target});
          expect(launched.isError).not.toBe(true);
          expect(launched.structuredContent.headsetPage?.reused).not.toBe(true);
          if(target==='apple')expect(launched.structuredContent.launch).toMatchObject({target:'apple',handoff:'manual'});
        }
        expect(f.launches()).toBe(target==='meta'?1:0);
      } finally {await f.close();}
    },30_000);

  it('rejects conflicting browser and exact-page device evidence even after a named launch',async()=>{
    const f=await companionReuseFixture('web');if(!f)return;
    try {
      await f.beat({diagnostics:{entries:[{seq:1,at:1,kind:'session-start',detail:{deviceClass:'vision-pro'}}]}});
      const launched=await f.t.call('open_companion',{...f.options,launch:'web',headset:'meta'});
      expect(launched.isError).not.toBe(true);
      expect(launched.structuredContent.headsetPage?.reused).not.toBe(true);
    } finally {await f.close();}
  },30_000);

  it('does not use another panel’s device evidence to reuse an unknown named page',async()=>{
    const f=await companionReuseFixture('none','Safari test browser');if(!f)return;
    try {
      const other=(await f.t.call('attach_inspection',{...f.bound,surface:'companion'})).structuredContent.panelId;
      await f.t.call('poll_inspection',{...f.bound,panelId:other,availability:'ready',
        diagnostics:{entries:[{seq:1,at:1,kind:'session-start',detail:{deviceClass:'vision-pro'}}]}});
      await f.beat();
      const launched=await f.t.call('open_companion',{...f.options,launch:'web',headset:'apple'});
      expect(launched.isError).not.toBe(true);
      expect(launched.structuredContent.headsetPage?.reused).not.toBe(true);
      expect(launched.structuredContent.launch).toMatchObject({target:'apple',handoff:'manual'});
    } finally {await f.close();}
  },30_000);

  for(const failure of ['unpaired-panel','silent','revoked','source-changed','stale-revision','outdated-build']) {
    it(`launches rather than reusing a ${failure} headset page`,async()=>{
      const f=await companionReuseFixture();if(!f)return;
      try {
        if(failure!=='unpaired-panel')await f.beat(failure==='outdated-build'?{pageBuild:'0'.repeat(64)}:{});
        if(failure==='silent')f.advance(61_001);
        if(failure==='revoked') {
          const status=await f.t.call('manage_companion',{sessionId:f.t.sessionId,action:'status'});
          await f.t.call('manage_companion',{sessionId:f.t.sessionId,action:'revoke',clientId:status.structuredContent.lan.clients[0].id});
        }
        if(failure==='source-changed') {
          await f.t.call('open',{sessionId:f.t.sessionId,structureText:cif});
          const current=(await f.t.hydrate())._meta[KEY];
          await f.t.call('sync_inspection',{sessionId:f.t.sessionId,serverEpoch:current.serverEpoch,sourceToken:current.sourceToken,
            baseStateRevision:current.stateRevision,baseInspectionRevision:current.inspectionRevision,scene:f.t.scene});
        }
        if(failure==='stale-revision') {
          const edited=structuredClone(f.t.scene);edited.inspection.appearance.uniformColor='#00ff00';
          await f.t.call('sync_inspection',{...f.bound,scene:edited});
        }
        const launched=await f.t.call('open_companion',{...f.options,launch:'web',headset:'meta'});
        expect(launched.isError).not.toBe(true);
        expect(launched.structuredContent.headsetPage?.reused).not.toBe(true);
        expect(f.launches()).toBe(1);
      } finally {await f.close();}
    },30_000);
  }

  it('opens the Web Launch link for a LAN companion, then launches it again without a second listener',async()=>{
    const lanAddress=listLanAddresses()[0]; if(!lanAddress) return;
    const folder=await mkdtemp(join(tmpdir(),'stereofold-lan-launch-'));
    await writeFile(join(folder,'inspector.html'),'<html><script>void 0;</script></html>');
    const home=process.env.HOME;
    process.env.HOME=folder;
    const launched:Array<{command:string;args:string[]}>=[];
    // Web Launch is rate limited, so this test owns the clock.
    let clock=Date.now();
    const t=await setup({sceneServiceFile:join(folder,'scene-service.json'),now:()=>clock,questLaunch:{platform:'darwin',opener:'/bin/echo',launch:(command:string,args:readonly string[])=>{launched.push({command,args:[...args]});return {reason:'started' as const};}}},join(folder,'viewer.html'));
    const lanPort=await unusedPort(lanAddress.address);
    try {
      await t.call('sync_inspection',t.args);
      const {scene,...initial}=t.args;
      const current={...initial,baseInspectionRevision:1};
      const opened=await t.call('open_companion',{...current,connection:'lan',lanHost:lanAddress.address,lanPort,launch:'web'});
      expect(opened.isError).not.toBe(true);
      const code=opened.structuredContent.companion.pairingCode;
      expect(code).toMatch(/^\d{8}$/);
      expect(opened.structuredContent.launch).toMatchObject({mode:'web',opened:true});
      expect(opened.content[0].text).toContain('click Open');
      // After the steps, the agent waits on the wearer's state.
      expect(opened.content[0].text).toContain('Relay these steps once, then read get_inspection_state until wearer.state is "in-vr"');
      // The link actually opened carries the code; the link returned does not,
      // so the code appears exactly once in the whole result.
      expect(launched).toHaveLength(1);
      expect(launched[0].command).toBe('/bin/echo');
      expect(decodeURIComponent(launched[0].args[0].split('url=')[1])).toBe(`https://${lanAddress.address}:${lanPort}/#pair=${code}`);
      expect(JSON.stringify(opened).split(code)).toHaveLength(2);

      // A second send right away wedges Quest Browser, so this Mac refuses
      // to make it and says why. The
      // connection itself is untouched: the listener stays up and the address
      // in the result still works.
      const tooSoon=await t.call('manage_companion',{sessionId:t.sessionId,serverEpoch:current.serverEpoch,sourceToken:current.sourceToken,action:'launch',launch:'web'});
      expect(tooSoon.isError).not.toBe(true);
      expect(tooSoon.structuredContent.launch).toMatchObject({mode:'web',opened:false});
      expect(tooSoon.content[0].text).toMatch(/Web Launch was sent 0 s ago/);
      expect(tooSoon.content[0].text).toMatch(/Press Open on the page already in your browser/);
      expect(launched).toHaveLength(1);

      // Relaunching reuses the listener that is already up rather than binding
      // a second one, and states its own outcome in the same plain sentence.
      clock+=61_000;
      const relaunched=await t.call('manage_companion',{sessionId:t.sessionId,serverEpoch:current.serverEpoch,sourceToken:current.sourceToken,action:'launch',launch:'web'});
      expect(relaunched.isError).not.toBe(true);
      expect(relaunched.structuredContent.launch).toMatchObject({mode:'web',opened:true});
      expect(relaunched.structuredContent.lan.port).toBe(lanPort);
      expect(relaunched.content[0].text).toContain('click Open');
      // A relaunch tells the agent to relay the steps and wait, like open_companion.
      expect(relaunched.content[0].text).toContain('Relay these steps once, then read get_inspection_state until wearer.state is "in-vr"');
      expect(launched).toHaveLength(2);
      expect(decodeURIComponent(launched[1].args[0].split('url=')[1]))
        .toBe(`https://${lanAddress.address}:${lanPort}/#pair=${relaunched.structuredContent.pairingCode}`);
      expect(JSON.stringify(relaunched).split(relaunched.structuredContent.pairingCode)).toHaveLength(2);
      expect(await reachable(lanAddress.address,lanPort)).toBe(true);

      // Naming no route is a question, not a silent default to one of them.
      const unchosen=await t.call('manage_companion',{sessionId:t.sessionId,serverEpoch:current.serverEpoch,sourceToken:current.sourceToken,action:'launch'});
      expect(unchosen.isError).toBe(true);
      expect(launched).toHaveLength(2);

      // With sharing stopped there is no address to put on a headset, and this
      // must say so rather than starting a listener of its own.
      await t.call('manage_companion',{sessionId:t.sessionId,serverEpoch:current.serverEpoch,sourceToken:current.sourceToken,action:'close'});
      const nothing=await t.call('manage_companion',{sessionId:t.sessionId,serverEpoch:current.serverEpoch,sourceToken:current.sourceToken,action:'launch',launch:'web'});
      expect(nothing.isError).toBe(true);
      expect(JSON.stringify(nothing)).toContain('open_companion');
      expect(launched).toHaveLength(2);
      expect(await reachable(lanAddress.address,lanPort)).toBe(false);
    } finally {
      await t.close();
      if(home===undefined) delete process.env.HOME; else process.env.HOME=home;
      await rm(folder,{recursive:true,force:true});
    }
  },30_000);

  it('retries a failed Quest dispatch immediately and preserves the selected headset',async()=>{
    const lanAddress=listLanAddresses()[0];if(!lanAddress)return;
    const folder=await mkdtemp(join(tmpdir(),'stereofold-quest-retry-'));
    await writeFile(join(folder,'inspector.html'),'<html><script>void 0;</script></html>');
    const previousHome=process.env.HOME;process.env.HOME=folder;
    let launches=0;
    const t=await setup({sceneServiceFile:join(folder,'scene-service.json'),questLaunch:{
      platform:'darwin',environment:{STEREOFOLD_CONFIG:join(folder,'config.json')},find:()=>undefined,
      launch:()=>++launches===1?{reason:'failed' as const,code:'EXIT_3',detail:'Browser unavailable'}:{reason:'started' as const},
    }},join(folder,'viewer.html'));
    try {
      await t.call('sync_inspection',t.args);
      const {scene,...initial}=t.args;
      const failed=await t.call('open_companion',{...initial,baseInspectionRevision:1,connection:'lan',
        lanHost:lanAddress.address,lanPort:await unusedPort(lanAddress.address),headset:'meta',launch:'auto'});
      expect(failed.isError).not.toBe(true);
      expect(failed.structuredContent.launch).toMatchObject({route:'meta-web',opened:false,reason:'failed'});
      // No headset is supplied on the retry: it must retain Quest, not infer Apple from missing adb.
      const retried=await t.call('manage_companion',{sessionId:t.sessionId,action:'launch',launch:'auto'});
      expect(retried.structuredContent.launch).toMatchObject({route:'meta-web',opened:true,reason:'started'});
      expect(retried.content[0].text).not.toContain('Safari');
      expect(launches).toBe(2);
      expect(retried.structuredContent.lan.url).toBe(failed.structuredContent.companion.url);
      const duplicate=await t.call('manage_companion',{sessionId:t.sessionId,action:'launch',launch:'auto'});
      expect(duplicate.structuredContent.launch.opened).toBe(false);
      expect(duplicate.content[0].text).toContain('Web Launch was sent');
      expect(launches).toBe(2);
    } finally {
      await t.close();
      if(previousHome===undefined)delete process.env.HOME;else process.env.HOME=previousHome;
      await rm(folder,{recursive:true,force:true});
    }
  },30_000);

  // The Vision Pro result is relayed once, like the Web Launch
  // steps, so it runs to Safari's Allow prompt and then says to wait.
  it('gives the Vision Pro steps through Enter VR and Allow, then says to wait on the wearer state',async()=>{
    const lanAddress=listLanAddresses()[0]; if(!lanAddress) return;
    const folder=await mkdtemp(join(tmpdir(),'stereofold-apple-launch-'));
    await writeFile(join(folder,'inspector.html'),'<html><script>void 0;</script></html>');
    const home=process.env.HOME;
    process.env.HOME=folder;
    const t=await setup({sceneServiceFile:join(folder,'scene-service.json'),questLaunch:{platform:'darwin',appleHandoff:'manual'}},join(folder,'viewer.html'));
    try {
      await t.call('sync_inspection',t.args);
      const {scene,...initial}=t.args;
      const opened=await t.call('open_companion',{...initial,baseInspectionRevision:1,connection:'lan',lanHost:lanAddress.address,
        lanPort:await unusedPort(lanAddress.address),launch:'auto',headset:'apple'});
      expect(opened.isError).not.toBe(true);
      expect(opened.structuredContent.launch).toMatchObject({target:'apple',handoff:'manual'});
      expect(opened.content[0].text).toContain('Then tap Enter VR, and choose Allow when Safari asks whether the page may launch an immersive experience. '
        +'Relay these steps once, then read get_inspection_state until wearer.state is "in-vr"');
      expect(JSON.stringify(opened).split(opened.structuredContent.companion.pairingCode)).toHaveLength(2);
      const again=await t.call('manage_companion',{sessionId:t.sessionId,action:'launch',launch:'auto'});
      expect(again.structuredContent.launch).toMatchObject({target:'apple',route:'safari',handoff:'manual'});
    } finally {
      await t.close();
      if(home===undefined) delete process.env.HOME; else process.env.HOME=home;
      await rm(folder,{recursive:true,force:true});
    }
  },30_000);

  /**
   * Clearing the not-responding dialog that a wedged Quest Browser raises.
   *
   * Android showed "com.oculus.browser isn't responding" over the wearer every
   * ten seconds for a minute and a half, and the only thing that ended it was
   * the wearer finding and pressing "Close app" inside the headset. Everything
   * below runs against seams: no adb, no headset, no browser.
   */
  it('names a wedged Quest Browser in status, then stops and reopens it over the cable',async()=>{
    const lanAddress=listLanAddresses()[0]; if(!lanAddress) return;
    const folder=await mkdtemp(join(tmpdir(),'stereofold-anr-'));
    await writeFile(join(folder,'inspector.html'),'<html><script>void 0;</script></html>');
    const home=process.env.HOME;
    process.env.HOME=folder;
    // The probe's three sections, verbatim shapes from that night's logcat.
    const anrAnswer=['09-10 22:39:35\n','  Window #16 Window{8a99117 u0 Application Not Responding: com.oculus.browser}:\n',
      '09-10 22:39:21.239  1535  7590 E ActivityManager: ANR in com.oculus.browser (com.oculus.browser/.BrowserActivity)\n'].join('--stereofold--');
    const healthyAnswer=['09-10 22:41:35\n','\n','\n'].join('--stereofold--');
    let wedged=true;
    const device:string[][]=[];
    const headsetDevice={
      run:async(file:string,args:readonly string[])=>{
        device.push([file,...args]);
        if(args[0]==='devices') return {stdout:'List of devices attached\nQUEST2\tdevice\n',stderr:''};
        if(args.includes('force-stop')) {wedged=false;return {stdout:'',stderr:''};}
        return {stdout:wedged?anrAnswer:healthyAnswer,stderr:''};
      },
      exists:async(path:string)=>path==='/opt/tools/adb',
      env:{PATH:'/opt/tools'},
    };
    // The adb launch the recovery uses, kept entirely away from a real cable.
    const adbCalls:string[][]=[];
    // What the wearer hears. The recovery takes the world away, so it says so
    // first and says it is back afterwards, through the ordinary reply path.
    const spoken:string[]=[];
    // The tab sweep's debugger, so nothing here opens a socket to a real headset.
    const headsetDevtools={fetch:async(_port:number,path:string)=>path==='/json'?'[]':'{}',open:async()=>{throw Error('no page');}};
    const t=await setup({sceneServiceFile:join(folder,'scene-service.json'),headsetDevice,headsetDevtools,replyAudio:{synthesize:async(text:string)=>{spoken.push(text);return undefined;}},
      questLaunch:{platform:'darwin',opener:'/bin/echo',launch:()=>{},
      find:()=>'/opt/tools/adb',recheckMs:0,
      run:async(command:string,args:readonly string[])=>{adbCalls.push([command,...args]);
        if(args.includes('getprop'))return {code:0,stdout:'[ro.product.model]: [Quest 2]\n[ro.serialno]: [QUEST2]\n',stderr:''};
        return args[0]==='devices'?{code:0,stdout:'List of devices attached\nQUEST2\tdevice\n',stderr:''}:{code:0,stdout:'Starting: Intent',stderr:''};},
    }},join(folder,'viewer.html'));
    const lanPort=await unusedPort(lanAddress.address);
    try {
      await t.call('sync_inspection',t.args);
      const {scene,...initial}=t.args;
      const current={...initial,baseInspectionRevision:1};
      const state={sessionId:t.sessionId,serverEpoch:current.serverEpoch,sourceToken:current.sourceToken};
      await t.call('open_companion',{...current,connection:'lan',lanHost:lanAddress.address,lanPort});

      // Status stops the agent guessing from blurred frames: the dialog has a
      // name, a time and the headset's own words for it.
      const status=await t.call('manage_companion',{...state,action:'status'});
      expect(status.isError).not.toBe(true);
      expect(status.structuredContent.browser).toMatchObject({browser:'anr',since:'09-10 22:39:21'});
      expect(status.content[0].text).toContain('Quest Browser is showing an ANR dialog');

      const recovered=await t.call('manage_companion',{...state,action:'recover-browser'});
      expect(recovered.isError).not.toBe(true);
      expect(recovered.structuredContent.recovery).toMatchObject({stopped:true,relaunched:true});
      expect(recovered.structuredContent.recovery.before.browser).toBe('anr');
      expect(recovered.structuredContent.recovery.after.browser).toBe('ok');
      expect(recovered.content[0].text).toContain('cleared its ANR dialog');
      expect(device.some(call=>call.includes('force-stop'))).toBe(true);
      // It reopens over the cable. A second Meta Web Launch send is the cause
      // this is recovering from, so the recovery must never make one.
      expect(adbCalls.some(call=>call.includes('am'))).toBe(true);
      // The tab sweep forwards its debugger through the same adb and serial.
      expect(adbCalls.some(call=>call.includes('forward')&&call.includes('QUEST2'))).toBe(true);
      expect(JSON.stringify(adbCalls)).not.toContain('oculus.com/open_url');
      expect(spoken).toEqual(['Restarting the headset browser.','Back. Tap Enter VR.']);
      for(const line of spoken) expect(line.split(' ').length).toBeLessThan(12);
      // Absence of an Android ANR is separate from a Stereofold page checking in.
      const settled=await t.call('manage_companion',{...state,action:'status'});
      expect(settled.structuredContent.browser).toMatchObject({check:'android-anr',browser:'ok'});
      expect(settled.structuredContent.wearer).toMatchObject({state:'no-page',linked:false});
      expect(settled.content[0].text).toContain('wearer.state no-page');
      expect(settled.content[0].text).toContain('Android reports no Quest Browser ANR dialog');
      expect(settled.content[0].text).not.toContain('The headset browser is responding');

      // A browser that is answering is left alone: a restart costs the wearer
      // the session they are in.
      const healthy=await t.call('manage_companion',{...state,action:'recover-browser'});
      expect(healthy.isError).toBe(true);
      expect(JSON.stringify(healthy)).toContain('force');
      expect(device.filter(call=>call.includes('force-stop'))).toHaveLength(1);
    } finally {
      await t.close();
      if(home===undefined) delete process.env.HOME; else process.env.HOME=home;
      await rm(folder,{recursive:true,force:true});
    }
  },30_000);

  /**
   * A restart drops the person's Proceed, so the reopened
   * page stops at the certificate warning, where "Back. Tap Enter VR." names
   * a button that has not loaded.
   */
  it('names the certificate warning after a browser restart instead of saying tap Enter VR',async()=>{
    const lanAddress=listLanAddresses()[0]; if(!lanAddress) return;
    const folder=await mkdtemp(join(tmpdir(),'stereofold-restart-certificate-'));
    await writeFile(join(folder,'inspector.html'),'<html><script>void 0;</script></html>');
    const home=process.env.HOME;
    process.env.HOME=folder;
    const healthyAnswer=['09-10 22:41:35\n','\n','\n'].join('--stereofold--');
    const headsetDevice={run:async(_file:string,args:readonly string[])=>args[0]==='devices'
      ?{stdout:'List of devices attached\nQUEST2\tdevice\n',stderr:''}:{stdout:args.includes('force-stop')?'':healthyAnswer,stderr:''},
      exists:async(path:string)=>path==='/opt/tools/adb',env:{PATH:'/opt/tools'}};
    const lanPort=await unusedPort(lanAddress.address);
    const spoken:string[]=[];
    // The reopened tab, frozen behind the warning: only its listing answers.
    const headsetDevtools={fetch:async(_port:number,path:string)=>path==='/json'?JSON.stringify([{id:'71',type:'page',title:'Privacy error',
      url:`https://${lanAddress.address}:${lanPort}/#pair=12345678`,webSocketDebuggerUrl:'ws://127.0.0.1:9333/devtools/page/71'}]):'{}',
    open:async()=>{throw Error('no page');}};
    const t=await setup({sceneServiceFile:join(folder,'scene-service.json'),headsetDevice,headsetDevtools,
      replyAudio:{synthesize:async(text:string)=>{spoken.push(text);return undefined;}},
      questLaunch:{platform:'darwin',opener:'/bin/echo',launch:()=>{},find:()=>'/opt/tools/adb',recheckMs:0,run:fakeQuestAdb().run}},join(folder,'viewer.html'));
    try {
      await t.call('sync_inspection',t.args);
      const {scene,...initial}=t.args;
      const current={...initial,baseInspectionRevision:1};
      await t.call('open_companion',{...current,connection:'lan',lanHost:lanAddress.address,lanPort});
      const recovered=await t.call('manage_companion',{sessionId:t.sessionId,serverEpoch:current.serverEpoch,sourceToken:current.sourceToken,
        action:'recover-browser',force:true});
      expect(recovered.isError).not.toBe(true);
      expect(recovered.structuredContent.certificateWarning).toMatchObject({tab:'71',host:lanAddress.address,evidence:['title']});
      const text:string=recovered.content[0].text;
      expect(text.startsWith('Quest Browser is showing a certificate warning')).toBe(true);
      expect(text).toContain(`Choose Advanced, then "Proceed to ${lanAddress.address} (unsafe)". Then tap Enter VR.`);
      expect(text).not.toContain('The wearer taps Enter VR once.');
      expect(text).not.toContain('put the headset on, then tap Enter VR');
      expect(spoken).toEqual(['Restarting the headset browser.']);
    } finally {
      await t.close();
      if(home===undefined) delete process.env.HOME; else process.env.HOME=home;
      await rm(folder,{recursive:true,force:true});
    }
  },30_000);

  /**
   * In one headset run an adb launch went out behind Meta's "Finding position in
   * room" screen, reported "launch attempted", and no page opened.
   */
  it('stops an adb launch at Meta\'s boundary screen and touches no tab behind it',async()=>{
    const lanAddress=listLanAddresses()[0]; if(!lanAddress) return;
    const folder=await mkdtemp(join(tmpdir(),'stereofold-guardian-'));
    await writeFile(join(folder,'inspector.html'),'<html><script>void 0;</script></html>');
    const home=process.env.HOME;
    process.env.HOME=folder;
    const adb=fakeQuestAdb({activities:GUARDIAN_DUMP});
    const headsetDevtools={fetch:vi.fn(async()=>'[]'),open:vi.fn(async()=>{throw Error('no page');})};
    const t=await setup({headsetDevtools,questLaunch:{platform:'darwin',opener:'/bin/echo',launch:()=>{},
      find:()=>'/opt/tools/adb',run:adb.run,recheckMs:0}},join(folder,'viewer.html'));
    const lanPort=await unusedPort(lanAddress.address);
    try {
      await t.call('sync_inspection',t.args);
      const {scene,...initial}=t.args;
      const current={...initial,baseInspectionRevision:1};
      const opened=await t.call('open_companion',{...current,connection:'lan',lanHost:lanAddress.address,lanPort,launch:'adb'});
      expect(opened.isError).not.toBe(true);
      expect(opened.structuredContent.launch).toMatchObject({mode:'adb',opened:false,reason:'failed',blocked:'guardian-dialog'});
      expect(opened.content[0].text).toContain('"Finding position in room"');
      expect(opened.content[0].text).toContain('launch again');
      expect(adb.asked().some(said=>said.startsWith('shell am start')||said.startsWith('forward'))).toBe(false);
      expect(headsetDevtools.fetch).not.toHaveBeenCalled();
      // The share stays up, so the same launch works once a person clears the screen.
      expect(await reachable(lanAddress.address,lanPort)).toBe(true);
    } finally {
      await t.close();
      if(home===undefined) delete process.env.HOME; else process.env.HOME=home;
      await rm(folder,{recursive:true,force:true});
    }
  },30_000);

  /**
   * A cable launch used to return at once, and the agent then polled state
   * for the headset page. With waitForHeadsetMs the same answer says whether
   * the page attached and drew.
   */
  for(const attaches of [true,false]) it(attaches
    ? 'waits for the launched headset page to attach and draw, and says so in the same answer'
    : 'says what to check when no headset page attaches within the wait',async()=>{
    const lanAddress=listLanAddresses()[0]; if(!lanAddress) return;
    const folder=await mkdtemp(join(tmpdir(),'stereofold-headset-wait-'));
    await writeFile(join(folder,'inspector.html'),'<html><script>void 0;</script></html>');
    const home=process.env.HOME;
    process.env.HOME=folder;
    const adb=fakeQuestAdb();
    const headsetDevtools={fetch:async()=>'[]',open:async()=>{throw Error('no page');}};
    const t=await setup({headsetDevtools,questLaunch:{platform:'darwin',opener:'/bin/echo',launch:()=>{},
      find:()=>'/opt/tools/adb',run:adb.run,recheckMs:0}},join(folder,'viewer.html'));
    try {
      const saved=(await t.call('sync_inspection',t.args)).structuredContent;
      const bound={sessionId:t.sessionId,serverEpoch:saved.serverEpoch,sourceToken:saved.sourceToken,
        baseStateRevision:saved.stateRevision,baseInspectionRevision:saved.inspectionRevision};
      // A page attached before the launch says nothing about the launch.
      const earlier=(await t.call('attach_inspection',{...bound,surface:'companion'})).structuredContent.panelId;
      await t.call('poll_inspection',{...bound,panelId:earlier,availability:'ready'});
      const answer=t.call('open_companion',{sessionId:t.sessionId,connection:'lan',lanHost:lanAddress.address,
        lanPort:await unusedPort(lanAddress.address),launch:'adb',waitForHeadsetMs:attaches?10_000:600});
      if(attaches) {
        // What the launched page does once it has paired: attach as the companion and report ready.
        const deadline=Date.now()+5_000;
        while(!adb.asked().some(said=>said.startsWith('shell am start')) && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,20));
        const panelId=(await t.call('attach_inspection',{...bound,surface:'companion'})).structuredContent.panelId;
        await t.call('poll_inspection',{...bound,panelId,availability:'ready'});
      }
      const shared=await answer;
      expect(shared.isError).not.toBe(true);
      expect(adb.asked().some(said=>said.startsWith('shell am start'))).toBe(true);
      expect(shared.structuredContent.headsetPage).toMatchObject({drew:attaches,waitedMs:expect.any(Number)});
      // Attaching is all the page did; entering VR is read from wearer.state.
      if(attaches) expect(shared.content[0].text).toMatch(/The headset page attached \d+\.\d s after the launch\. It is waiting for Enter VR\./u);
      else {
        expect(shared.content[0].text).toMatch(/The headset page did not attach and draw within \d+\.\d s\. Check that the headset is awake/u);
        expect(shared.structuredContent.headsetPage.waitedMs).toBeGreaterThanOrEqual(600);
      }
    } finally {
      await t.close();
      if(home===undefined) delete process.env.HOME; else process.env.HOME=home;
      await rm(folder,{recursive:true,force:true});
    }
  },30_000);

  /**
   * In one headset run on the Quest 2, the launch stopped at Quest
   * Browser's "Your connection is not private" page. The wait said only that
   * nothing drew, and the agent told the user to tap Enter VR on a page that
   * had not loaded. Only the person can choose Advanced, then Proceed.
   */
  it('names the certificate warning when the headset page stops at it, and puts its steps first',async()=>{
    const lanAddress=listLanAddresses()[0]; if(!lanAddress) return;
    const folder=await mkdtemp(join(tmpdir(),'stereofold-headset-certificate-'));
    await writeFile(join(folder,'inspector.html'),'<html><script>void 0;</script></html>');
    const home=process.env.HOME;
    process.env.HOME=folder;
    const adb=fakeQuestAdb();
    const lanPort=await unusedPort(lanAddress.address);
    const origin=`https://${lanAddress.address}:${lanPort}`;
    // Chromium lists the address that failed, titled "Privacy error", and the
    // page itself reports its error address and the code.
    const evaluated:string[]=[];
    const headsetDevtools={
      fetch:async(_port:number,path:string)=>path==='/json'?JSON.stringify([{id:'71',type:'page',title:'Privacy error',
        url:`${origin}/#pair=12345678`,webSocketDebuggerUrl:'ws://127.0.0.1:9333/devtools/page/71'}]):'{}',
      open:async()=>({send:async(method:string,parameters:{expression?:string})=>{
        if(method!=='Runtime.evaluate') return {};
        evaluated.push(String(parameters.expression));
        return {result:{value:{href:'chrome-error://chromewebdata/',title:'Privacy error',code:'NET::ERR_CERT_AUTHORITY_INVALID'}}};
      },close:()=>{}}),
    };
    const t=await setup({headsetDevtools,questLaunch:{platform:'darwin',opener:'/bin/echo',launch:()=>{},
      find:()=>'/opt/tools/adb',run:adb.run,recheckMs:0}},join(folder,'viewer.html'));
    try {
      await t.call('sync_inspection',t.args);
      const shared=await t.call('open_companion',{sessionId:t.sessionId,connection:'lan',lanHost:lanAddress.address,
        lanPort,launch:'adb',waitForHeadsetMs:600});
      expect(shared.isError).not.toBe(true);
      const warning=shared.structuredContent.headsetPage.certificateWarning;
      expect(shared.structuredContent.headsetPage).toMatchObject({drew:false});
      expect(warning).toMatchObject({address:origin,host:lanAddress.address,code:'NET::ERR_CERT_AUTHORITY_INVALID',tab:'71',
        fingerprint:shared.structuredContent.companion.fingerprint});
      // The headset is awake and not worn, so putting it on is the first step.
      expect(warning.instruction).toBe(`Put the headset on. Quest Browser in the headset shows "Your connection is not private". `
        +`Choose Advanced, then "Proceed to ${lanAddress.address} (unsafe)". Then tap Enter VR. The warning returns each time Quest Browser restarts.`);
      const text:string=shared.content[0].text;
      expect(text.startsWith(`Quest Browser is showing a certificate warning for ${origin} (NET::ERR_CERT_AUTHORITY_INVALID)`)).toBe(true);
      expect(text).toContain(`Tell the user: ${warning.instruction}`);
      // The launch sentence keeps the serial and loses its Enter VR step.
      expect(text).toContain('launch attempted on QUEST2.');
      expect(text).not.toContain('put the headset on, then tap Enter VR');
      expect(text).toMatch(/The headset page did not attach and draw within \d+\.\d s\./u);
      expect(JSON.stringify(warning)).not.toContain('12345678');
      // Read-only: nothing but the page expression was sent to the tab.
      expect(evaluated.every(expression=>!/click|proceed/iu.test(expression))).toBe(true);
    } finally {
      await t.close();
      if(home===undefined) delete process.env.HOME; else process.env.HOME=home;
      await rm(folder,{recursive:true,force:true});
    }
  },30_000);

  it('refuses to restart a browser it cannot reach, and says what is missing',async()=>{
    const folder=await mkdtemp(join(tmpdir(),'stereofold-anr-noadb-'));
    await writeFile(join(folder,'inspector.html'),'<html><script>void 0;</script></html>');
    const t=await setup({headsetDevice:{run:async()=>({stdout:'',stderr:''}),exists:async()=>false,env:{PATH:'/opt/tools'}}},join(folder,'viewer.html'));
    try {
      await t.call('sync_inspection',t.args);
      const {scene,...initial}=t.args;
      const current={...initial,baseInspectionRevision:1};
      const refused=await t.call('manage_companion',{sessionId:t.sessionId,serverEpoch:current.serverEpoch,sourceToken:current.sourceToken,action:'recover-browser'});
      expect(refused.isError).toBe(true);
      // The wearer still has a way out, and the sentence says what it is.
      expect(JSON.stringify(refused)).toContain('Close app');
      expect(JSON.stringify(refused)).toContain('No adb was found');
      // A Mac with no cable is never told its browser might be broken.
      const status=await t.call('manage_companion',{sessionId:t.sessionId,serverEpoch:current.serverEpoch,sourceToken:current.sourceToken,action:'status'});
      expect(status.structuredContent.browser).toMatchObject({browser:'unknown'});
      expect(status.content[0].text).not.toContain('ANR');
    } finally {await t.close();await rm(folder,{recursive:true,force:true});}
  },20_000);

  // A launch runs a program on the Mac. The headset is the least trusted
  // party on this connection, so the tools that carry it must not be in the
  // companion dispatch table at all.
  it('keeps both companion tools unreachable from the headset tool route',async()=>{
    expect(LAN_TOOLS.has('open_companion')).toBe(false);
    expect(LAN_TOOLS.has('manage_companion')).toBe(false);
    const folder=await mkdtemp(join(tmpdir(),'stereofold-launch-reach-'));
    await writeFile(join(folder,'inspector.html'),'<html><script>void 0;</script></html>');
    const t=await setup({},join(folder,'viewer.html'));
    try {
      await t.call('sync_inspection',t.args);
      const {scene,...initial}=t.args;
      const current={...initial,baseInspectionRevision:1};
      const url=new URL((await t.call('open_companion',current)).structuredContent.companion.url);
      for(const name of ['open_companion','manage_companion']) {
        const response=await fetch(`${url.origin}/tool`,{method:'POST',headers:{authorization:`Bearer ${url.hash.slice(1)}`,origin:url.origin,'content-type':'application/json'},
          body:JSON.stringify({name,args:{...current,connection:'lan',launch:'web'}})});
        const body=await response.json() as any;
        // The route refuses the name outright, before any argument is read.
        expect(response.ok,name).toBe(false);
        expect(body.error,name).toBe('invalid_request');
        expect(JSON.stringify(body),name).not.toContain('pairingCode');
      }
    } finally {await t.close();await rm(folder,{recursive:true,force:true});}
  });

  it('accepts grow_structure on the headset /tool route instead of answering 400 invalid_request',async()=>{
    expect(COMPANION_TOOLS.has('grow_structure')).toBe(true);
    expect(LAN_TOOLS.has('grow_structure')).toBe(true);
    const folder=await mkdtemp(join(tmpdir(),'stereofold-grow-tool-'));
    await writeFile(join(folder,'inspector.html'),'<html><script>void 0;</script></html>');
    const t=await setup({},join(folder,'viewer.html'));
    try {
      await t.call('sync_inspection',t.args);
      const {scene,...initial}=t.args;
      const current={...initial,baseInspectionRevision:1};
      const url=new URL((await t.call('open_companion',current)).structuredContent.companion.url);
      const attached=await fetch(`${url.origin}/tool`,{method:'POST',headers:{authorization:`Bearer ${url.hash.slice(1)}`,origin:url.origin,'content-type':'application/json'},
        body:JSON.stringify({name:'attach_inspection',args:current})});
      expect(attached.status).toBe(200);
      const panelId=(await attached.json() as any).structuredContent.panelId;
      await fetch(`${url.origin}/tool`,{method:'POST',headers:{authorization:`Bearer ${url.hash.slice(1)}`,origin:url.origin,'content-type':'application/json'},
        body:JSON.stringify({name:'poll_inspection',args:{...current,panelId,availability:'ready'}})});
      const response=await fetch(`${url.origin}/tool`,{method:'POST',headers:{authorization:`Bearer ${url.hash.slice(1)}`,origin:url.origin,'content-type':'application/json'},
        body:JSON.stringify({name:'grow_structure',args:{...current,panelId,stage:'next',device:'quest2'}})});
      const body=await response.json() as any;
      // The name used to be missing from TOOLS, which was HTTP 400 invalid_request
      // before any schema or session check. A session that is not a staged lesson
      // still refuses, but as a tool result, not as an unknown route.
      expect(body.error,'grow_structure must not be an unknown companion tool').not.toBe('invalid_request');
      expect(response.status).not.toBe(400);
    } finally {await t.close();await rm(folder,{recursive:true,force:true});}
  });
});

describe('same-session public source replacement',()=>{
  it('requires a current ready panel, then retargets the session and clears an active experience',async()=>{
    const t=await setup({fetchPdbText:async()=>cif});
    try {
      const saved=(await t.call('sync_inspection',t.args)).structuredContent;
      const binding={sessionId:t.sessionId,serverEpoch:saved.serverEpoch,sourceToken:saved.sourceToken,baseStateRevision:saved.stateRevision,baseInspectionRevision:saved.inspectionRevision};
      const panelId=(await t.call('attach_inspection',binding)).structuredContent.panelId;
      await t.call('poll_inspection',{...binding,panelId,availability:'ready'});
      const replaced=await t.call('replace_inspection_source',{...binding,panelId,pdbId:'4hhb'});
      expect(replaced.isError).not.toBe(true);
      expect(replaced.structuredContent.sourceTransition).toEqual({sourceChanged:true,pdbId:'4HHB'});
      expect(replaced.structuredContent.sourceToken).not.toBe(binding.sourceToken);
      const hydrated=(await t.hydrate())._meta[KEY];
      expect(hydrated.scene).toBeNull();
      expect(replaced.structuredContent.appearanceReset).toBe(true);
      expect(replaced.content[0].text).toContain('still needs to load and render');
      // A replacement nobody asked to wait for still files a receipt,
      // and that receipt says plainly that nothing proved the wearer saw it.
      expect(replaced.structuredContent.sourceRenderReceipt).toBeNull();
      expect(replaced.structuredContent.sourceRenderStatus).toMatchObject({rendered:false,status:'unwaited',askedMs:0,waitedForMs:0});
      expect(replaced.structuredContent.sourceRenderStatus.renderBudgetMs).toBe(replaced.structuredContent.renderBudgetMs);
      expect(replaced.structuredContent.sourceRenderStatus.reason).toContain('No render wait was asked for');
      expect(hydrated.experience).toBeUndefined();
      expect(hydrated.experienceCatalog).toHaveLength(10);
    } finally {await t.close();}
  });
});

describe('initial source geometry advisory receipt',()=>{
  const advisory={representation:'cartoon',deviceClass:'quest2',atoms:237685,budget:300000,
    requestedLevel:'high',level:'high',estimatedVertices:1500000,message:'Showing cartoon at requested detail; it may run slowly.'};
  async function saveInitial(t:Awaited<ReturnType<typeof setup>>) {
    const value=(await t.call('sync_inspection',t.args)).structuredContent;
    return {sessionId:t.sessionId,serverEpoch:value.serverEpoch,sourceToken:value.sourceToken,
      baseStateRevision:value.stateRevision,baseInspectionRevision:value.inspectionRevision};
  }
  it('reports the validated first attachment without inventing a source transition',async()=>{
    const t=await setup();
    try {
      const state=()=>t.call('get_inspection_state',{sessionId:t.sessionId});
      const binding=await saveInitial(t);
      expect((await state()).structuredContent.sourceRenderReceipt).toBeUndefined();
      const stale=await t.call('attach_inspection',{...binding,baseInspectionRevision:0,surface:'companion',geometryBudget:advisory});
      expect(stale.isError).toBe(true);
      expect((await state()).structuredContent.sourceRenderReceipt).toBeUndefined();
      const attached=await t.call('attach_inspection',{...binding,surface:'companion',geometryBudget:advisory});
      expect(attached.isError).not.toBe(true);
      const current=await state();
      expect(current.structuredContent.sourceRenderReceipt).toMatchObject({status:'rendered',rendered:true,
        panelId:attached.structuredContent.panelId,sourceToken:binding.sourceToken,
        renderedRevision:binding.baseInspectionRevision,geometryBudget:advisory});
      expect(current.content[0].text).toContain(advisory.message);
      expect(current.structuredContent.sourceOperation).toBeNull();
      expect(current.structuredContent.sourceRecovery).toBeUndefined();
    } finally {await t.close();}
  });
  it('selects the current headset proof and does not let desktop followers or stale attachments overwrite it',async()=>{
    const t=await setup();
    try {
      const state=()=>t.call('get_inspection_state',{sessionId:t.sessionId});
      const binding=await saveInitial(t);
      await t.call('attach_inspection',{...binding,surface:'desktop'});
      const headset=await t.call('attach_inspection',{...binding,surface:'companion',geometryBudget:advisory});
      const expected=(await state()).structuredContent.sourceRenderReceipt;
      expect(expected.panelId).toBe(headset.structuredContent.panelId);
      await t.call('attach_inspection',{...binding,surface:'desktop',geometryBudget:{...advisory,atoms:42}});
      expect((await state()).structuredContent.sourceRenderReceipt).toEqual(expected);
      const stale=await t.call('attach_inspection',{...binding,sourceToken:randomUUID(),surface:'companion',geometryBudget:{...advisory,atoms:43}});
      expect(stale.isError).toBe(true);
      expect((await state()).structuredContent.sourceRenderReceipt).toEqual(expected);
      // A new current headset without a warning must not inherit another panel's.
      await t.call('attach_inspection',{...binding,surface:'companion',replacesPanelId:headset.structuredContent.panelId});
      expect((await state()).structuredContent.sourceRenderReceipt).toBeUndefined();
    } finally {await t.close();}
  });
  it('does not reuse initial proof while a new source waits or after an under-threshold replacement',async()=>{
    const t=await setup({fetchPdbText:async()=>cif});
    try {
      const state=()=>t.call('get_inspection_state',{sessionId:t.sessionId});
      const binding=await saveInitial(t);
      const panelId=(await t.call('attach_inspection',{...binding,surface:'companion',geometryBudget:advisory})).structuredContent.panelId;
      const replacing=await t.call('replace_inspection_source',{...binding,panelId,pdbId:'4HHB'});
      expect(replacing.isError).not.toBe(true);
      expect((await state()).structuredContent.sourceRenderReceipt).toBeUndefined();
      const data=(await t.hydrate())._meta[KEY];
      const next={sessionId:t.sessionId,serverEpoch:data.serverEpoch,sourceToken:data.sourceToken,
        baseStateRevision:data.stateRevision,baseInspectionRevision:data.inspectionRevision};
      expect(next.sourceToken).not.toBe(binding.sourceToken);
      const saved=await t.call('sync_inspection',{...next,scene:{...t.scene,sourceSha256:data.catalog.source.sha256}});
      expect(saved.isError,saved.content?.[0]?.text).not.toBe(true);
      const attached=await t.call('attach_inspection',{...next,baseInspectionRevision:saved.structuredContent.inspectionRevision,
        surface:'companion',replacesPanelId:panelId});
      expect(attached.isError).not.toBe(true);
      const receipt=(await state()).structuredContent.sourceRenderReceipt;
      expect(receipt).toMatchObject({status:'rendered',sourceToken:next.sourceToken});
      expect(receipt.geometryBudget).toBeUndefined();
    } finally {await t.close();}
  });
});

describe('source replacement render wait',()=>{
  async function ready(t:any) {
    const saved=(await t.call('sync_inspection',t.args)).structuredContent;
    const binding={sessionId:t.sessionId,serverEpoch:saved.serverEpoch,sourceToken:saved.sourceToken,
      baseStateRevision:saved.stateRevision,baseInspectionRevision:saved.inspectionRevision};
    const panelId=(await t.call('attach_inspection',{...binding,surface:'companion'})).structuredContent.panelId;
    return {...binding,panelId};
  }
  it('retains the active spoken request and its source-bound referent through failed-source recovery',async()=>{
    const t=await setup({fetchPdbText:async()=>cif,transcriber:referentTranscriber()});
    try {
      const before=await ready(t),utteranceId='88888888-8888-4888-8888-888888888888';
      await t.call('poll_inspection',{...before,availability:'ready'});
      const audio={sessionId:t.sessionId,panelId:before.panelId,utteranceId,mime:'audio/webm;codecs=opus'};
      await t.call('push_to_talk_audio',{...audio,seq:0,data:'AAAA',final:false});
      await t.call('push_to_talk_audio',{...audio,seq:1,final:true});
      const spoken=await t.call('listen_voice',{timeoutSeconds:1});
      const transcript=spoken.structuredContent.transcripts[0];
      expect(transcript).toMatchObject({utteranceId,text:'Move to the structure I pointed at.',referent:{sourceToken:before.sourceToken}});

      await t.call('replace_inspection_source',{...before,pdbId:'4HHB',utteranceId});
      const failedData=(await t.hydrate())._meta[KEY];
      const failed={sessionId:t.sessionId,serverEpoch:failedData.serverEpoch,sourceToken:failedData.sourceToken,
        baseStateRevision:failedData.stateRevision,baseInspectionRevision:failedData.inspectionRevision,panelId:before.panelId};
      await t.call('report_source_failure',{...failed,previousSourceToken:before.sourceToken,
        failure:'render_failed',failureReason:'The first structure could not draw.'});
      await t.call('poll_inspection',{...before,availability:'unsaved',sourceFailureToken:failedData.sourceToken});
      expect((await t.call('replace_inspection_source',{...failed,pdbId:'1CRN',
        utteranceId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'})).isError).toBe(true);
      expect((await t.hydrate())._meta[KEY].sourceToken).toBe(failedData.sourceToken);

      // Recovery deliberately omits utteranceId: the host must carry forward
      // only the live continuation it retained for this failed transition.
      const replacing=t.call('replace_inspection_source',{sessionId:t.sessionId,pdbId:'1CRN'});
      let recovered:any;
      for(let i=0;i<100;i++) {
        recovered=(await t.hydrate())._meta[KEY];
        if(recovered.sourceToken!==failed.sourceToken)break;
        await new Promise(resolve=>setTimeout(resolve,5));
      }
      expect(recovered.sourceReplacement).toEqual({panelId:before.panelId,previousSourceToken:before.sourceToken});
      const next={sessionId:t.sessionId,serverEpoch:recovered.serverEpoch,sourceToken:recovered.sourceToken,
        baseStateRevision:recovered.stateRevision,baseInspectionRevision:recovered.inspectionRevision};
      const saved=(await t.call('sync_inspection',{...next,scene:t.scene})).structuredContent;
      const attached=await t.call('attach_inspection',{...next,baseInspectionRevision:saved.inspectionRevision,
        surface:'companion',replacesPanelId:before.panelId});
      expect(attached.isError).not.toBe(true);
      expect((await replacing).isError).not.toBe(true);

      const replayed=await t.call('listen_voice',{timeoutSeconds:1,cursor:0,epoch:spoken.structuredContent.epoch});
      expect(replayed.structuredContent.transcripts[0]).toEqual(transcript);
      const current={...next,baseInspectionRevision:saved.inspectionRevision,panelId:before.panelId};
      const followup=await t.call('update_inspection',{...current,utteranceId,commandId:'continued-voice-request',
        change:{kind:'appearance',patch:{color:'chain-id'}}});
      expect(followup.isError).not.toBe(true);
      expect(followup.structuredContent.command).toMatchObject({utteranceId,status:'queued'});

      const staleReferent=await t.call('update_inspection',{...current,utteranceId,commandId:'old-source-referent',
        referent:transcript.referent,change:{kind:'appearance',patch:{color:'chain-id'}}});
      expect(staleReferent.isError).toBe(true);
      expect(staleReferent.content[0].text).toContain('different structure');
    } finally {await t.close();}
  });

  it('aborts a failed-source recovery fetch when its carried utterance is cancelled',async()=>{
    let holdRecovery=false,releaseRecovery:()=>void=()=>{},startedRecovery:()=>void=()=>{};
    const waiting=new Promise<void>(resolve=>{startedRecovery=resolve;});
    const t=await setup({fetchPdbText:async(id:string)=>{
      if(id==='1CRN' && holdRecovery) {startedRecovery();await new Promise<void>(resolve=>{releaseRecovery=resolve;});}
      return cif;
    },transcriber:referentTranscriber()});
    try {
      const before=await ready(t),utteranceId='99999999-9999-4999-8999-999999999999';
      await t.call('poll_inspection',{...before,availability:'ready'});
      const audio={sessionId:t.sessionId,panelId:before.panelId,utteranceId,mime:'audio/webm;codecs=opus'};
      await t.call('push_to_talk_audio',{...audio,seq:0,data:'AAAA',final:false});
      await t.call('push_to_talk_audio',{...audio,seq:1,final:true});
      await t.call('listen_voice',{timeoutSeconds:1});
      await t.call('replace_inspection_source',{...before,pdbId:'4HHB',utteranceId});
      const failedData=(await t.hydrate())._meta[KEY];
      const failed={sessionId:t.sessionId,serverEpoch:failedData.serverEpoch,sourceToken:failedData.sourceToken,
        baseStateRevision:failedData.stateRevision,baseInspectionRevision:failedData.inspectionRevision,panelId:before.panelId};
      await t.call('report_source_failure',{...failed,previousSourceToken:before.sourceToken,
        failure:'render_failed',failureReason:'The first structure could not draw.'});
      await t.call('poll_inspection',{...before,availability:'unsaved',sourceFailureToken:failedData.sourceToken});
      holdRecovery=true;
      const replacing=t.call('replace_inspection_source',{sessionId:t.sessionId,pdbId:'1CRN',commandId:'recovery-operation-to-cancel'});
      await waiting;
      const cancel=await t.call('update_inspection',{...failed,utteranceId,commandId:'cancel-recovery-request',
        change:{kind:'utterance',patch:{action:'cancel'}}});
      expect(cancel.isError).not.toBe(true);
      expect(cancel.structuredContent.lifecycle.sourceOperations).toContainEqual({
        commandId:'recovery-operation-to-cancel',status:'cancelled',supersededBy:utteranceId});
      releaseRecovery();
      expect((await replacing).isError).toBe(true);
      expect((await t.hydrate())._meta[KEY].sourceToken).toBe(failedData.sourceToken);
      expect((await t.call('get_inspection_state',{sessionId:t.sessionId})).structuredContent.sourceRecovery).toBeUndefined();
    } finally {releaseRecovery();await t.close();}
  });
  it('waits for the selected renderer to save and reattach, then admits the follow-up',async()=>{
    const geometryBudget={representation:'spacefill',deviceClass:'quest3',atoms:200000,budget:260000,requestedLevel:'high',level:'high',estimatedVertices:10000000,message:'Showing atoms at requested detail; it may run slowly.'};
    const t=await setup({fetchPdbText:async()=>cif});
    try {
      const before=await ready(t);let finished=false;
      const replacing=t.call('replace_inspection_source',{...before,pdbId:'4HHB',waitForRenderMs:2000}).then((r:any)=>{finished=true;return r;});
      let data:any;
      for(let i=0;i<100;i++) {data=(await t.hydrate())._meta[KEY];if(data.sourceToken!==before.sourceToken)break;await new Promise(r=>setTimeout(r,5));}
      expect(data.sourceToken).not.toBe(before.sourceToken);
      const next={sessionId:t.sessionId,serverEpoch:data.serverEpoch,sourceToken:data.sourceToken,
        baseStateRevision:data.stateRevision,baseInspectionRevision:data.inspectionRevision};
      expect(finished).toBe(false);
      // Attaching before a rendered save is refused, even with the right old ID.
      expect((await t.call('attach_inspection',{...next,replacesPanelId:before.panelId})).isError).toBe(true);
      const saved=(await t.call('sync_inspection',{...next,scene:t.scene})).structuredContent;
      next.baseInspectionRevision=saved.inspectionRevision;
      expect(finished).toBe(false);
      await t.call('attach_inspection',{...next,surface:'companion',replacesPanelId:randomUUID()});
      expect(finished).toBe(false);
      expect(data.sourceGeometryBudget).toBe(true);
      const panelId=(await t.call('attach_inspection',{...next,surface:'companion',replacesPanelId:before.panelId,geometryBudget})).structuredContent.panelId;
      const result=await replacing;
      expect(result.structuredContent.sourceRenderReceipt).toEqual({status:'rendered',panelId,
        sourceToken:next.sourceToken,inspectionRevision:next.baseInspectionRevision,geometryBudget,
        renderedAt:expect.any(Number),renderedRevision:next.baseInspectionRevision});
      // The field a caller reads as "the wearer saw it" is true only
      // where the sentence beside it says the panel rendered and saved.
      expect(result.structuredContent.sourceRenderStatus).toMatchObject({rendered:true,status:'rendered',
        renderBudgetMs:result.structuredContent.renderBudgetMs});
      expect(result.content[0].text).toContain('The selected panel rendered and saved the new source.');
      expect(result.content[0].text).toContain(geometryBudget.message);
      const state=await t.call('get_inspection_state',{sessionId:t.sessionId});
      expect(state.structuredContent.sourceRenderReceipt.geometryBudget).toEqual(geometryBudget);
      expect(state.content[0].text).toContain(geometryBudget.message);
      // A later follower cannot overwrite the selected renderer's completed receipt.
      await t.call('attach_inspection',{...next,surface:'companion',geometryBudget:{...geometryBudget,atoms:1}});
      expect((await t.call('get_inspection_state',{sessionId:t.sessionId})).structuredContent.sourceRenderReceipt.geometryBudget).toEqual(geometryBudget);
      // The host states the budget it would have waited,
      // so a caller that did time out knows how long to keep following.
      expect(result.structuredContent.renderWait).toEqual({timedOut:false,reason:null,
        budgetMs:result.structuredContent.renderBudgetMs,waitedForMs:2000,askedMs:2000});
      expect(result.structuredContent.renderBudgetMs).toBeGreaterThanOrEqual(PANEL_SAVE_WAIT.baseMs);
      const followup=await t.call('update_inspection',{...next,panelId,commandId:'after-replace',change:{kind:'appearance',patch:{color:'chain-id'}}});
      expect(followup.structuredContent.command.status).toBe('queued');
    } finally {await t.close();}
  });
  it('reports a typed source refusal immediately, rejects foreign claims and lets the owner retry successfully',async()=>{
    const t=await setup({fetchPdbText:async()=>cif});
    try {
      const before=await ready(t);
      const replacing=t.call('replace_inspection_source',{...before,pdbId:'4HHB',commandId:'refused-source',waitForRenderMs:2000});
      let data:any;
      for(let i=0;i<100;i++) {data=(await t.hydrate())._meta[KEY];if(data.sourceToken!==before.sourceToken)break;await new Promise(r=>setTimeout(r,5));}
      const next={sessionId:t.sessionId,serverEpoch:data.serverEpoch,sourceToken:data.sourceToken,
        baseStateRevision:data.stateRevision,baseInspectionRevision:data.inspectionRevision};
      const reason='The requested ball-and-stick geometry needs 269832 vertices, over the 260000 budget. '+ 'Selection detail. '.repeat(35);
      const refusal={...next,panelId:before.panelId,previousSourceToken:before.sourceToken,
        failure:'representation_budget_exceeded',failureReason:reason};
      for(const patch of [{panelId:randomUUID()},{sourceToken:randomUUID()},{previousSourceToken:randomUUID()},
        {serverEpoch:randomUUID()},{baseStateRevision:next.baseStateRevision+1}])
        expect((await t.call('report_source_failure',{...refusal,...patch})).isError).toBe(true);
      const ack=await t.call('report_source_failure',refusal);
      expect(ack.isError).not.toBe(true);
      expect(COMPANION_TOOLS.has('report_source_failure')).toBe(true);
      expect(LAN_TOOLS.has('report_source_failure')).toBe(true);
      const answer=await replacing;
      expect(answer.structuredContent.sourceRenderStatus).toMatchObject({status:'failed',rendered:false,failure:refusal.failure,failureReason:reason});
      expect(answer.structuredContent.renderWait.timedOut).toBe(false);
      expect(answer.content[0].text).toContain(reason);
      expect((await t.call('report_source_failure',refusal)).isError).not.toBe(true);
      expect((await t.call('report_source_failure',{...refusal,failure:'render_failed',failureReason:'Retry failed during context recovery.'})).isError).not.toBe(true);
      const state=await t.call('get_inspection_state',{sessionId:t.sessionId,commandId:'refused-source'});
      expect(state.structuredContent.command).toMatchObject({status:'failed',rendered:false,failureReason:reason});
      expect(state.structuredContent.hasScene).toBe(false);
      const saved=(await t.call('sync_inspection',{...next,scene:t.scene})).structuredContent;
      const attached=await t.call('attach_inspection',{...next,baseInspectionRevision:saved.inspectionRevision,
        surface:'companion',replacesPanelId:before.panelId});
      expect(attached.isError).not.toBe(true);
      expect(attached.structuredContent.sourceRenderReceipt).toMatchObject({status:'rendered',rendered:true});
      expect((await t.call('report_source_failure',refusal)).isError).toBe(true);
    } finally {await t.close();}
  });

  it('keeps a heartbeating failed-source owner recoverable beyond the render budget',async()=>{
    let now=1_000_000;
    const t=await setup({fetchPdbText:async()=>cif,now:()=>now});
    try {
      const before=await ready(t);
      await t.call('replace_inspection_source',{...before,pdbId:'4HHB'});
      const data=(await t.hydrate())._meta[KEY];
      const failed={sessionId:t.sessionId,serverEpoch:data.serverEpoch,sourceToken:data.sourceToken,
        baseStateRevision:data.stateRevision,baseInspectionRevision:data.inspectionRevision,panelId:before.panelId};
      await t.call('report_source_failure',{...failed,previousSourceToken:before.sourceToken,
        failure:'render_failed',failureReason:'First draw failed.'});
      const heartbeat={...before,availability:'unsaved',sourceFailureToken:data.sourceToken};
      // More than the maximum five-minute render budget, with real host refresh
      // on every beat and state read. Recovery is not unsaved manual work.
      for(let elapsed=0;elapsed<=360_000;elapsed+=5000) {
        now=1_000_000+elapsed;
        const beat=await t.call('poll_inspection',heartbeat);
        expect(beat.isError).not.toBe(true);
        expect(beat.structuredContent.attached).toBe(true);
        const read=await t.call('get_inspection_state',{sessionId:t.sessionId});
        expect(read.structuredContent.sourceRecovery).toEqual({panelId:before.panelId,ready:true});
      }
      now+=15_000;
      const quiet=await t.call('get_inspection_state',{sessionId:t.sessionId});
      expect(quiet.structuredContent.sourceRecovery).toBeUndefined();
      expect(quiet.structuredContent.panels.some((panel:any)=>panel.panelId===before.panelId)).toBe(true);
      // The ten-second offer expires before the companion's ordinary silence
      // grace. A model state read must not retire the still-recoverable page.
      await t.call('poll_inspection',heartbeat);
      const retryBeat=await t.call('poll_inspection',{...before,availability:'busy'});
      expect(retryBeat.structuredContent.attached).toBe(true);
      expect(retryBeat.structuredContent.sourceRecovery).toBeUndefined();
      await t.call('poll_inspection',heartbeat);
      const replacing=await t.call('replace_inspection_source',{sessionId:t.sessionId,pdbId:'1CRN'});
      expect(replacing.isError).not.toBe(true);
      expect(replacing.structuredContent.sourceTransition.sourceChanged).toBe(true);
    } finally {await t.close();}
  });

  it.each([false,true])('requires current idle recovery after Retry during preparation (reoffered %s)',async reoffered=>{
    let hold=false,release:()=>void=()=>{},started:()=>void=()=>{};
    const waiting=new Promise<void>(resolve=>{started=resolve;});
    const t=await setup({fetchPdbText:async()=>{if(hold){started();await new Promise<void>(resolve=>{release=resolve;});}return cif;}});
    try {
      const before=await ready(t);
      await t.call('replace_inspection_source',{...before,pdbId:'4HHB'});
      const data=(await t.hydrate())._meta[KEY];
      const failed={sessionId:t.sessionId,serverEpoch:data.serverEpoch,sourceToken:data.sourceToken,
        baseStateRevision:data.stateRevision,baseInspectionRevision:data.inspectionRevision,panelId:before.panelId};
      await t.call('report_source_failure',{...failed,previousSourceToken:before.sourceToken,
        failure:'render_failed',failureReason:'Draw failed.'});
      await t.call('poll_inspection',{...before,availability:'unsaved',sourceFailureToken:data.sourceToken});
      hold=true;
      const replacing=t.call('replace_inspection_source',{...failed,pdbId:'1CRN'});
      await waiting;
      // The client awaits this revocation before Retry reads or draws a source.
      await t.call('poll_inspection',{...before,availability:'busy'});
      if(reoffered) {
        // A failed Retry changed no scientific work; its fresh idle offer can
        // still fulfill the user's already-pending replacement request.
        await t.call('report_source_failure',{...failed,previousSourceToken:before.sourceToken,
          failure:'render_failed',failureReason:'Retry also failed.'});
        await t.call('poll_inspection',{...before,availability:'unsaved',sourceFailureToken:data.sourceToken});
      }
      release();
      const answer=await replacing;
      const after=(await t.hydrate())._meta[KEY].sourceToken;
      if(reoffered) {expect(answer.isError).not.toBe(true);expect(after).not.toBe(data.sourceToken);}
      else {expect(answer.isError).toBe(true);expect(after).toBe(data.sourceToken);}
    }finally{release();await t.close();}
  });

  it('recovers a refused source through an idle owner heartbeat and a different source, without admitting visual edits',async()=>{
    const t=await setup({fetchPdbText:async()=>cif});
    try {
      const before=await ready(t);
      await t.call('replace_inspection_source',{...before,pdbId:'4HHB'});
      const data=(await t.hydrate())._meta[KEY];
      const failed={sessionId:t.sessionId,serverEpoch:data.serverEpoch,sourceToken:data.sourceToken,
        baseStateRevision:data.stateRevision,baseInspectionRevision:data.inspectionRevision,panelId:before.panelId};
      await t.call('report_source_failure',{...failed,previousSourceToken:before.sourceToken,
        failure:'representation_budget_exceeded',failureReason:'Source is over the geometry budget.'});
      expect((await t.call('replace_inspection_source',{...failed,pdbId:'1CRN'})).isError).toBe(true);
      const heartbeat={...before,availability:'unsaved',sourceFailureToken:data.sourceToken};
      expect((await t.call('poll_inspection',heartbeat)).isError).not.toBe(true);
      expect((await t.call('update_inspection',{...failed,commandId:'wrong-coordinates',change:{kind:'appearance',patch:{labels:true}}})).isError).toBe(true);
      expect((await t.call('replace_inspection_source',{...failed,pdbId:'1CRN',mode:'compare'})).isError).toBe(true);
      // Local work or a busy renderer revokes the recovery capability.
      await t.call('poll_inspection',{...before,availability:'unsaved'});
      expect((await t.call('replace_inspection_source',{...failed,pdbId:'1CRN'})).isError).toBe(true);
      await t.call('poll_inspection',heartbeat);
      // Omitted panel/binding selects only this acknowledged recovery owner.
      const replacing=t.call('replace_inspection_source',{sessionId:t.sessionId,pdbId:'1CRN',waitForRenderMs:2000});
      let nextData:any;
      for(let i=0;i<100;i++) {nextData=(await t.hydrate())._meta[KEY];if(nextData.sourceToken!==failed.sourceToken)break;await new Promise(r=>setTimeout(r,5));}
      expect(nextData.sourceToken).not.toBe(failed.sourceToken);
      expect(nextData.sourceReplacement).toEqual({panelId:before.panelId,previousSourceToken:before.sourceToken});
      const next={sessionId:t.sessionId,serverEpoch:nextData.serverEpoch,sourceToken:nextData.sourceToken,
        baseStateRevision:nextData.stateRevision,baseInspectionRevision:nextData.inspectionRevision};
      const saved=(await t.call('sync_inspection',{...next,scene:t.scene})).structuredContent;
      const attached=await t.call('attach_inspection',{...next,baseInspectionRevision:saved.inspectionRevision,
        surface:'companion',replacesPanelId:before.panelId});
      expect(attached.isError).not.toBe(true);
      expect((await replacing).structuredContent.sourceRenderStatus).toMatchObject({status:'rendered',rendered:true});
    } finally {await t.close();}
  });

  it('keeps the authenticated HTTP companion link through a refusal, heartbeat and valid replacement',async()=>{
    const folder=await mkdtemp(join(tmpdir(),'stereofold-http-source-refusal-'));
    await writeFile(join(folder,'inspector.html'),'<html><script>void 0;</script></html>');
    const t=await setup({fetchPdbText:async()=>cif},join(folder,'viewer.html'));
    try {
      const saved=(await t.call('sync_inspection',t.args)).structuredContent;
      const bound=(data:any)=>({sessionId:t.sessionId,serverEpoch:data.serverEpoch,sourceToken:data.sourceToken,
        baseStateRevision:data.stateRevision,baseInspectionRevision:data.inspectionRevision});
      const url=new URL((await t.call('open_companion',bound(saved))).structuredContent.companion.url);
      const httpCall=async(name:string,args:any)=>{
        const response=await fetch(`${url.origin}/tool`,{method:'POST',headers:{authorization:`Bearer ${url.hash.slice(1)}`,
          origin:url.origin,'content-type':'application/json'},body:JSON.stringify({name,args})});
        const body=await response.json() as any;
        expect(response.status,JSON.stringify(body)).toBe(200);expect(body.isError).not.toBe(true);return body;
      };
      const panelId=(await httpCall('attach_inspection',bound(saved))).structuredContent.panelId;
      const before={...bound(saved),panelId};
      await t.call('replace_inspection_source',{...before,pdbId:'4HHB'});
      const failed=(await httpCall('get_inspection',{sessionId:t.sessionId}))._meta[KEY];
      await httpCall('report_source_failure',{...bound(failed),panelId,previousSourceToken:before.sourceToken,
        failure:'representation_budget_exceeded',failureReason:'Geometry is over budget; choose a smaller source.'});
      const beat=await httpCall('poll_inspection',{...before,availability:'unsaved',sourceFailureToken:failed.sourceToken});
      expect(beat.structuredContent.sourceRecovery).toEqual({panelId,ready:true});
      const replacement=await t.call('replace_inspection_source',{sessionId:t.sessionId,pdbId:'1CRN'});
      expect(replacement.isError).not.toBe(true);
      const next=(await httpCall('get_inspection',{sessionId:t.sessionId}))._meta[KEY];
      expect(next.sourceReplacement.previousSourceToken).toBe(before.sourceToken);
      const nextSave=(await httpCall('sync_inspection',{...bound(next),scene:t.scene})).structuredContent;
      const attached=await httpCall('attach_inspection',{...bound(nextSave),replacesPanelId:panelId});
      expect(attached.structuredContent.sourceRenderReceipt).toMatchObject({status:'rendered',rendered:true});
      expect(attached.structuredContent.panelId).toBe(panelId);
    } finally {await t.close();await rm(folder,{recursive:true,force:true});}
  });

  it('never reports an older replacement as rendered after another source wins',async()=>{
    const t=await setup({fetchPdbText:async()=>cif});
    try {
      const before=await ready(t);
      const replacing=t.call('replace_inspection_source',{...before,pdbId:'4HHB',waitForRenderMs:200});
      for(let i=0;i<100;i++) {
        if((await t.hydrate())._meta[KEY].sourceToken!==before.sourceToken)break;
        await new Promise(r=>setTimeout(r,1));
      }
      expect((await t.call('open',{sessionId:t.sessionId,structureText:cif})).isError).not.toBe(true);
      const result=await replacing;
      expect(result.structuredContent.sourceTransition).toEqual({sourceChanged:false,superseded:true});
      expect(result.structuredContent.sourceRenderReceipt).toBeNull();
      expect(result.structuredContent).not.toHaveProperty('renderToken');
      expect(result.content[0].text).toContain('source changed again');
    } finally {await t.close();}
  });
  it('reports an explicit timeout without a render claim and discloses appearance reset',async()=>{
    const t=await setup({fetchPdbText:async()=>cif});
    try {
      const before=await ready(t);
      const result=await t.call('replace_inspection_source',{...before,pdbId:'4HHB',waitForRenderMs:20});
      expect(result.structuredContent).toMatchObject({hasScene:false,appearanceReset:true,sourceRenderReceipt:null,renderWait:{timedOut:true}});
      expect(result.content[0].text).toContain('Timed out after 20 ms');
      expect(result.content[0].text).toContain('Appearance resets to the new source defaults, including representation and colors.');
      expect((await t.hydrate())._meta[KEY].scene).toBeNull();
    } finally {await t.close();}
  });
});

describe('a lesson that names a deposited assembly',()=>{
  const lesson={version:1,id:'assembly-probe',title:'Assembly probe',mode:'explore',
    provenance:{sourceRefs:[{kind:'public',ref:'https://www.rcsb.org/structure/1CRN'}],
      note:'A one-chapter fixture that exists only to check which assembly the inspector builds.'},
    chapters:[{id:'reveal',title:'Reveal',caption:'One chapter, long enough to compile against the lesson contract.',
      durationSeconds:10,changes:[{kind:'scene',durationSeconds:10,easing:'ease_in_out',transition:'smooth',scene:{background:'#071015'}}],
      immersive:{appearance:{representation:'cartoon',color:'chain-id'},view:'fit'}}]};

  async function lessonFixture() {
    const directory=await mkdtemp(join(tmpdir(),'stereofold-assembly-'));
    const structurePath=join(directory,'1CRN.cif'), lessonPath=join(directory,'lesson.json');
    await writeFile(structurePath,cif); await writeFile(lessonPath,JSON.stringify(lesson));
    return {directory,structurePath,lessonPath,cleanup:()=>rm(directory,{recursive:true,force:true})};
  }

  it('an inactive heartbeat clears the loaded custom lesson fallback without deleting its catalog',async()=>{
    const t=await setup(), fixture=await lessonFixture();
    try {
      const opened=await t.call('inspect_lesson',{filePath:fixture.structurePath,lessonPath:fixture.lessonPath});
      const sessionId=opened.structuredContent.sessionId;
      const loaded=(await t.call('get_inspection',{sessionId}))._meta[KEY];
      expect(loaded.customTour.title).toBe(lesson.title);
      const saved=(await t.call('sync_inspection',{sessionId,serverEpoch:loaded.serverEpoch,sourceToken:loaded.sourceToken,
        baseStateRevision:loaded.stateRevision,baseInspectionRevision:loaded.inspectionRevision,
        scene:{...t.scene,sourceSha256:loaded.catalog.source.sha256}})).structuredContent;
      const binding={sessionId,serverEpoch:saved.serverEpoch,sourceToken:saved.sourceToken,
        baseStateRevision:saved.stateRevision,baseInspectionRevision:saved.inspectionRevision};
      const panelId=(await t.call('attach_inspection',{...binding,surface:'companion'})).structuredContent.panelId;
      for(const selectedId of [loaded.customTour.id,undefined]) {
        const heartbeat=await t.call('poll_inspection',{...binding,panelId,availability:'ready',
          tourState:{...(selectedId?{selectedId}:{}),active:false,autoplay:false,navigating:false,step:-1,total:0}});
        expect(heartbeat.isError).not.toBe(true);
        expect(heartbeat.structuredContent.modelContext.lesson).toBeNull();
        expect(heartbeat.structuredContent.modelContext.chapter).toBeNull();
        const state=(await t.call('get_inspection_state',{sessionId})).structuredContent;
        expect(state.lesson).toBeNull();
        expect(state.modelContext.lesson).toBeNull();
        expect(state.tours.some((item:any)=>item.id===loaded.customTour.id)).toBe(true);
      }
    } finally {await fixture.cleanup();await t.close();}
  });

  it('builds the named assembly and reports it, and leaves the asymmetric unit the default',async()=>{
    const t=await setup(); const fixture=await lessonFixture();
    try {
      const plain=await t.call('inspect_lesson',{filePath:fixture.structurePath,lessonPath:fixture.lessonPath});
      expect(plain.isError).not.toBe(true);
      expect(plain.structuredContent.assemblyId).toBe('asymmetric_unit');
      expect(plain.structuredContent.atomSites).toBeGreaterThan(0);
      const assembly=await t.call('inspect_lesson',{filePath:fixture.structurePath,lessonPath:fixture.lessonPath,assemblyId:'1'});
      expect(assembly.isError).not.toBe(true);
      expect(assembly.structuredContent.assemblyId).toBe('1');
      // 1CRN's assembly 1 is the identity operator, so the site count is the
      // same; what changed is which assembly the saved scene must match.
      expect(assembly.structuredContent.atomSites).toBe(plain.structuredContent.atomSites);
      const data=(await t.call('get_inspection',{sessionId:assembly.structuredContent.sessionId}))._meta[KEY];
      expect(data.catalog.assemblyId).toBe('1');
    } finally {await fixture.cleanup();await t.close();}
  });

  it('names the assembly in the refusal when the entry does not declare it',async()=>{
    const t=await setup(); const fixture=await lessonFixture();
    try {
      const missing=await t.call('inspect_lesson',{filePath:fixture.structurePath,lessonPath:fixture.lessonPath,assemblyId:'97'});
      expect(missing.isError).toBe(true);
      expect(JSON.stringify(missing)).toMatch(/Assembly 97/);
      // The refused request must not stick to the session that follows it.
      const after=await t.call('inspect_lesson',{filePath:fixture.structurePath,lessonPath:fixture.lessonPath});
      expect(after.isError).not.toBe(true);
      expect(after.structuredContent.assemblyId).toBe('asymmetric_unit');
    } finally {await fixture.cleanup();await t.close();}
  });

  it('refuses an assembly identifier that is not one path segment',async()=>{
    const t=await setup(); const fixture=await lessonFixture();
    try {
      for (const assemblyId of ['../1','1 2','']) {
        expect((await t.call('inspect_lesson',{filePath:fixture.structurePath,lessonPath:fixture.lessonPath,assemblyId})).isError).toBe(true);
      }
    } finally {await fixture.cleanup();await t.close();}
  });
});

describe('what control_tour tells the agent it just did',()=>{
  // `control_tour back` and `next` on an inactive tour used to answer status
  // "queued" and change nothing. The agent read
  // "queued" and told the wearer the tour was on its way. The result now names
  // the outcome, and next/back with nothing playing starts the lesson.
  async function panelWithTour(tourState?:Record<string,unknown>) {
    const t=await setup();
    const saved=(await t.call('sync_inspection',t.args)).structuredContent;
    const binding={sessionId:t.sessionId,serverEpoch:saved.serverEpoch,sourceToken:saved.sourceToken,
      baseStateRevision:saved.stateRevision,baseInspectionRevision:saved.inspectionRevision};
    const panelId=(await t.call('attach_inspection',{...binding,surface:'companion'})).structuredContent.panelId;
    expect((await t.call('poll_inspection',{...binding,panelId,availability:'ready',...(tourState?{tourState}:{})})).isError).not.toBe(true);
    return {t,binding,panelId};
  }
  it('delivers an explicit paused start without scheduling a separate pause command',async()=>{
    const {t,binding,panelId}=await panelWithTour();
    try {
      const commandId='start-for-spoken-guidance';
      const queued=await t.call('control_tour',{...binding,panelId,commandId,action:'start',tourId:TOURS[0].id,autoplay:false,narration:false});
      expect(queued.isError,JSON.stringify(queued.content)).not.toBe(true);
      const polled=await t.call('poll_inspection',{...binding,panelId,availability:'ready'});
      expect(polled._meta[KEY].delivery.change).toEqual({kind:'tour',patch:{action:'start',tourId:TOURS[0].id,autoplay:false,narration:false}});
    } finally {await t.close();}
  });
  for (const modelStart of [false,true]) it(`Done clears every live lesson projection (model start ${modelStart})`,async()=>{
    const {t,binding,panelId}=await panelWithTour();
    let current={...binding,panelId};
    const lesson=TOURS[0];
    const active={selectedId:lesson.id,step:0,total:lesson.steps.length,active:true,autoplay:false,navigating:false};
    // Older panels retain selectedId after Done. The host must still clear it.
    const ended={...active,step:-1,total:0,active:false};
    const render=async(action:string,tourState:typeof active)=>{
      const commandId=`projection-${action}`;
      expect((await t.call('control_tour',{...current,commandId,action,...(action==='start'?{tourId:lesson.id}:{})})).isError).not.toBe(true);
      const poll=await t.call('poll_inspection',{...current,availability:'ready'});
      const claim={...current,commandId,claimToken:poll._meta[KEY].delivery.claimToken};
      expect((await t.call('complete_inspection',{...claim,phase:'admit'})).structuredContent.admitted).toBe(true);
      const done=await t.call('complete_inspection',{...claim,scene:t.scene,tourState});
      expect(done.isError,JSON.stringify(done.content)).not.toBe(true);
      expect(done.structuredContent.command.status).toBe('rendered');
      current={...current,baseStateRevision:done.structuredContent.stateRevision,baseInspectionRevision:done.structuredContent.inspectionRevision};
    };
    try {
      if(modelStart) await render('start',active);
      else expect((await t.call('poll_inspection',{...current,availability:'ready',tourState:active})).isError).not.toBe(true);
      const started=(await t.call('get_inspection_state',{sessionId:t.sessionId})).structuredContent;
      expect(started.modelContext.lesson).toEqual({id:lesson.id,title:lesson.title});
      expect(started.modelContext.chapter).toMatchObject({id:lesson.steps[0].id,index:1});
      if(modelStart) await render('done',ended);
      else expect((await t.call('poll_inspection',{...current,availability:'ready',tourState:ended})).isError).not.toBe(true);
      for(const name of ['get_inspection_state','get_inspection','poll_inspection']) {
        const result=await t.call(name,name==='poll_inspection'?{...current,availability:'ready',tourState:ended}:{sessionId:t.sessionId});
        expect(result.isError,JSON.stringify(result.content)).not.toBe(true);
        expect(result.structuredContent.modelContext.lesson).toBeNull();
        expect(result.structuredContent.modelContext.chapter).toBeNull();
        expect(result.structuredContent.experience).toBeUndefined();
        if(name==='get_inspection_state') {
          expect(result.structuredContent.lesson).toBeNull();
          expect(result.structuredContent.panels.find((panel:any)=>panel.panelId===panelId).tour).toMatchObject({active:false,step:-1,total:0,autoplay:false});
        }
      }
    } finally {await t.close();}
  });
  it('says a next with no tour running starts the lesson, rather than reporting it as queued',async()=>{
    const {t,binding,panelId}=await panelWithTour({selectedId:'crispr-cas9',step:-1,total:6,active:false,autoplay:false,navigating:false});
    try {
      const answer=await t.call('control_tour',{...binding,panelId,commandId:'tour-next-idle',action:'next'});
      const text=answer.content[0].text as string;
      expect(text).toContain('starts the lesson at scene 1');
      expect(text).toContain('Tour started.');
      expect(text).not.toContain('queued');
      expect(answer.structuredContent.command.status).toBe('queued');
    } finally {await t.close();}
  });
  it('says a back with no tour running starts it at the last scene',async()=>{
    const {t,binding,panelId}=await panelWithTour({selectedId:'crispr-cas9',step:-1,total:6,active:false,autoplay:false,navigating:false});
    try {
      const text=(await t.call('control_tour',{...binding,panelId,commandId:'tour-back-idle',action:'back'})).content[0].text as string;
      expect(text).toContain('starts the lesson at its last scene');
      expect(text).not.toContain('queued');
    } finally {await t.close();}
  });
  it('names the scene a next moves a running tour to',async()=>{
    const {t,binding,panelId}=await panelWithTour({selectedId:'crispr-cas9',step:2,total:6,active:true,autoplay:false,navigating:false});
    try {
      const text=(await t.call('control_tour',{...binding,panelId,commandId:'tour-next-live',action:'next'})).content[0].text as string;
      expect(text).toContain('scene 3');
      expect(text).toContain('scene 4 of 6');
      expect(text).not.toContain('queued');
    } finally {await t.close();}
  });
  it('answers a panel that has reported no tour at all without saying queued',async()=>{
    const {t,binding,panelId}=await panelWithTour();
    try {
      const text=(await t.call('control_tour',{...binding,panelId,commandId:'tour-next-unknown',action:'next'})).content[0].text as string;
      expect(text).toContain('starts the lesson');
      expect(text).not.toContain('queued');
    } finally {await t.close();}
  });
});

describe('verified source resolution and replacement',()=>{
  async function ready(t:Awaited<ReturnType<typeof setup>>) {
    const saved=(await t.call('sync_inspection',t.args)).structuredContent;
    const binding={sessionId:t.sessionId,serverEpoch:saved.serverEpoch,sourceToken:saved.sourceToken,baseStateRevision:saved.stateRevision,baseInspectionRevision:saved.inspectionRevision};
    const panelId=(await t.call('attach_inspection',binding)).structuredContent.panelId;
    await t.call('poll_inspection',{...binding,panelId,availability:'ready'});
    return {...binding,panelId};
  }
  const filePath=new URL('../../fixtures/1CRN.cif',import.meta.url).pathname;
  it('replaces from a local fixture with explicit model and assembly and waits for rendering',async()=>{
    const t=await setup();
    try {
      const binding=await ready(t);
      const replaced=await t.call('replace_inspection_source',{...binding,source:{kind:'file',path:filePath},modelNumber:1,assemblyId:'1'});
      expect(replaced.isError).not.toBe(true);
      expect(replaced.structuredContent).toMatchObject({sourceKind:'file',sourceSelection:{modelNumber:1,assemblyId:'1'},hasScene:false});
      expect(replaced.structuredContent.sourceToken).not.toBe(binding.sourceToken);
      expect(replaced.content[0].text).toContain('still needs to load and render');
      const hydration=(await t.hydrate())._meta[KEY];
      expect(hydration.sourceSelection).toEqual({modelNumber:1,assemblyId:'1'});
      expect(hydration.catalog.assemblyId).toBe('1');
      expect(hydration.scene).toBeNull();
      expect(hydration.structureText).toBe(cif);
    } finally {await t.close();}
  });
  it('holds a companion page to public entries and leaves a local file to the agent',async()=>{
    const folder=await mkdtemp(join(tmpdir(),'stereofold-page-source-'));
    await writeFile(join(folder,'inspector.html'),'<html><script>void 0;</script></html>');
    const t=await setup({fetchPdbText:async()=>cif},join(folder,'viewer.html'));
    try {
      const {panelId,...binding}=await ready(t);
      const url=new URL((await t.call('open_companion',binding)).structuredContent.companion.url);
      // The same route a paired headset reaches through the LAN listener.
      const page=(source:unknown)=>fetch(`${url.origin}/tool`,{method:'POST',
        headers:{authorization:`Bearer ${url.hash.slice(1)}`,origin:url.origin,'content-type':'application/json'},
        body:JSON.stringify({name:'replace_inspection_source',args:{...binding,panelId,source}})});
      for(const source of [{kind:'file',path:filePath},{kind:'url',url:'https://example.test/model.cif'},{kind:'pasted',text:cif}]) {
        const refused=await page(source);
        expect(refused.status).toBe(403);
        expect((await refused.json()).error).toBe('source_not_allowed');
      }
      expect((await t.hydrate())._meta[KEY].sourceToken).toBe(binding.sourceToken);
      // The agent's own MCP call opens the same file.
      const replaced=await t.call('replace_inspection_source',{...binding,panelId,source:{kind:'file',path:filePath}});
      expect(replaced.isError).not.toBe(true);
      expect(replaced.structuredContent.sourceKind).toBe('file');
      expect(replaced.structuredContent.sourceToken).not.toBe(binding.sourceToken);
    } finally {await t.close();await rm(folder,{recursive:true,force:true});}
  });
  it('refuses missing models, missing assemblies and missing files without changing the current source',async()=>{
    const t=await setup();
    try {
      const binding=await ready(t);
      for(const extra of [{modelNumber:999},{assemblyId:'999'},{source:{kind:'file',path:'/nonexistent/structure.cif'}}]) {
        const failed=await t.call('replace_inspection_source',{...binding,source:{kind:'file',path:filePath},...extra});
        expect(failed.isError).toBe(true);
        const data=(await t.hydrate())._meta[KEY];
        expect(data.sourceToken).toBe(binding.sourceToken);expect(data.scene).toEqual(t.scene);
      }
    } finally {await t.close();}
  });
  /**
   * On the Quest 2 the
   * insecure-URL request was answered "No panel is ready for a command right
   * now (companion unsaved, desktop ready)" — the scheme was never examined, so
   * a wearer asking for something this surface cannot do was told about the
   * panel instead of about the limit.
   */
  it('names the real limit of a refused source even while the panel is busy',async()=>{
    const t=await setup();
    try {
      const binding=await ready(t);
      await t.call('poll_inspection',{...binding,panelId:binding.panelId,availability:'unsaved'});
      for(const [source,limit] of [
        [{kind:'url',url:'http://example.com/model.pdb'},'Insecure URLs and embedded credentials are refused.'],
        [{kind:'url',url:'https://user:secret@example.com/model.cif'},'Insecure URLs and embedded credentials are refused.'],
        [{kind:'pasted',text:'not coordinates at all, just prose about a protein'},'The content is not recognizable mmCIF or PDB coordinates.'],
      ] as const) {
        const refused=await t.call('replace_inspection_source',{...binding,source});
        expect(refused.isError).toBe(true);
        expect(refused.content[0].text).toContain(limit);
        expect(refused.content[0].text).not.toContain('ready for a command');
      }
      // A request this surface would have honoured still waits on the panel.
      const busy=await t.call('replace_inspection_source',{...binding,source:{kind:'file',path:filePath}});
      expect(busy.isError).toBe(true);
      expect(busy.content[0].text).toContain('unavailable, dirty, stale, or rendering another command');
      // Nothing was replaced by any of the four.
      expect((await t.hydrate())._meta[KEY].sourceToken).toBe(binding.sourceToken);
    } finally {await t.close();}
  });
  /**
   * The same ordering, for the other refusal a wearer can hit while the panel
   * is busy. `grow_structure` settles which tier was asked for — including the
   * Quest 2 atom-site ceiling — before it reports on the panel.
   */
  it('names why a tier cannot be grown before it names the panel',async()=>{
    const t=await setup();
    try {
      const binding=await ready(t);
      await t.call('poll_inspection',{...binding,panelId:binding.panelId,availability:'unsaved'});
      const refused=await t.call('grow_structure',{...binding,stage:'next',device:'quest2'});
      expect(refused.isError).toBe(true);
      expect(refused.content[0].text).toContain('not playing a staged lesson');
      expect(refused.content[0].text).not.toContain('unavailable, dirty, stale');
    } finally {await t.close();}
  });
  it('inspects file sources and advertises the resolved selection',async()=>{
    const t=await setup();
    try {
      const opened=await t.call('inspect',{source:{kind:'file',path:filePath},modelNumber:1,assemblyId:'1'});
      expect(opened.isError).not.toBe(true);
      expect(opened.structuredContent).toMatchObject({sourceKind:'file',sourceSelection:{modelNumber:1,assemblyId:'1'}});
      const reopened=await t.call('inspect',{sessionId:opened.structuredContent.sessionId});
      expect(reopened.structuredContent.sourceSelection).toEqual({modelNumber:1,assemblyId:'1'});
    } finally {await t.close();}
  });
  it('opens a nested source through the legacy open tool without network',async()=>{
    const t=await setup();
    try {
      const opened=await t.call('open',{source:{kind:'file',path:filePath}});
      expect(opened.isError).not.toBe(true);
      expect(opened.structuredContent.hasStructure).toBe(true);
    } finally {await t.close();}
  });
});

describe('remote sources through verified inspection tools',()=>{
  const pdb='SEQRES   1 A    1  ALA\nMODEL        2\nATOM      1  CA  ALA A   1      11.104  13.207  10.000  1.00 20.00           C  \nENDMDL\nEND\n';
  it('loads AlphaFold and extensionless PDB URL sources with explicit model identity',async()=>{
    const requests:string[]=[];
    const t=await setup({sourceFetch:async(url:string)=>{requests.push(url);return new Response(url.includes('alphafold')?cif:pdb);}});
    try {
      const af=await t.call('inspect',{source:{kind:'alphafold',accession:'P69905'}});
      expect(af.isError).not.toBe(true);
      expect(af.structuredContent).toMatchObject({sourceKind:'alphafold',sourceSelection:{modelNumber:1,assemblyId:'asymmetric_unit'}});
      const remote=await t.call('inspect',{source:{kind:'url',url:'https://example.test/download'},modelNumber:2});
      expect(remote.isError).not.toBe(true);
      expect(remote.structuredContent).toMatchObject({sourceKind:'url',sourceSelection:{modelNumber:2,assemblyId:'asymmetric_unit'}});
      const data=(await t.call('get_inspection',{sessionId:remote.structuredContent.sessionId}))._meta[KEY];
      expect(data.catalog.modelNumbers).toEqual([2]);
      expect(data.sourceSelection.modelNumber).toBe(2);
      expect(data.structureText).toContain('_atom_site.');
      expect(requests).toEqual(['https://alphafold.ebi.ac.uk/files/AF-P69905-F1-model_v6.cif','https://example.test/download']);
    } finally {await t.close();}
  });
  it('rejects a fetched replacement if the inspection changed while it was downloading',async()=>{
    let started!:()=>void,finish!:(response:Response)=>void;
    const pending=new Promise<Response>(resolve=>{finish=resolve;});
    const startedPromise=new Promise<void>(resolve=>{started=resolve;});
    const t=await setup({sourceFetch:async()=>{started();return pending;}});
    try {
      const saved=(await t.call('sync_inspection',t.args)).structuredContent;
      const binding={sessionId:t.sessionId,serverEpoch:saved.serverEpoch,sourceToken:saved.sourceToken,baseStateRevision:saved.stateRevision,baseInspectionRevision:saved.inspectionRevision};
      const panelId=(await t.call('attach_inspection',binding)).structuredContent.panelId;
      await t.call('poll_inspection',{...binding,panelId,availability:'ready'});
      const replacement=t.call('replace_inspection_source',{...binding,panelId,source:{kind:'url',url:'https://example.test/download'}});
      await startedPromise;
      const changed=structuredClone(t.scene);changed.selectionKeys=[];
      const update=await t.call('sync_inspection',{...binding,scene:changed});expect(update.isError).not.toBe(true);
      finish(new Response(cif));
      const refused=await replacement;expect(refused.isError).toBe(true);expect(refused.content[0].text).toContain('changed while preparing');
      const data=(await t.hydrate())._meta[KEY];expect(data.sourceToken).toBe(binding.sourceToken);expect(data.scene.selectionKeys).toEqual([]);
    } finally {finish(new Response(cif));await t.close();}
  });
});

describe('loaded-structure journeys and failed-stage recovery', () => {
  const experienceId = 'hemoglobin-quaternary-structure';
  const hhbPromise = readFile(new URL('../../fixtures/4HHB.cif', import.meta.url), 'utf8');
  const bound = (t: any, data: any) => ({ sessionId: t.sessionId, serverEpoch: data.serverEpoch, sourceToken: data.sourceToken,
    baseStateRevision: data.stateRevision, baseInspectionRevision: data.inspectionRevision });
  async function ready(t: any, renderedScene?: any) {
    const data = (await t.hydrate())._meta[KEY];
    const catalog = await decodeInspectionCatalog(data.catalogWire ?? data.catalog);
    const scene = renderedScene ?? { ...t.scene, sourceSha256: catalog.source.sha256, modelNumber: catalog.modelNumbers[0], assemblyId: catalog.assemblyId, selectionKeys: [] };
    const saved = (await t.call('sync_inspection', { ...bound(t, data), scene })).structuredContent;
    const binding = bound(t, saved);
    const panelId = (await t.call('attach_inspection', { ...binding, surface: 'companion' })).structuredContent.panelId;
    return { ...binding, panelId };
  }
  for (const menuStart of [false,true]) it(`shares tour controls through rendered experience receipts (menu start ${menuStart})`, async()=>{
    const t=await setup({fetchPdbText:()=>hhbPromise});
    try {
      let current=await ready(t);
      const original=(await t.hydrate())._meta[KEY].scene;
      let revision=0;
      const render=async(tourCommand:any,transition:any,stepIndex:number)=>{
        const data=(await t.hydrate())._meta[KEY];
        const catalog=await decodeInspectionCatalog(data.catalogWire??data.catalog);
        const scene=data.experienceCompletion ? data.scene : {...t.scene,sourceSha256:catalog.source.sha256,
          modelNumber:catalog.modelNumbers[0],assemblyId:catalog.assemblyId,selectionKeys:[]};
        const saved=await t.call('sync_inspection',{...bound(t,data),scene,...(tourCommand?{tourCommand}:{})});
        expect(saved.isError,JSON.stringify(saved.content)).not.toBe(true);
        const attached=await t.call('attach_inspection',{...bound(t,saved.structuredContent),surface:'companion',replacesPanelId:current.panelId});
        expect(attached.isError,JSON.stringify(attached.content)).not.toBe(true);
        current={...bound(t,saved.structuredContent),panelId:attached.structuredContent.panelId};
        revision=data.experience?.revision??revision;
        const ack=await t.call('acknowledge_experience_step',{...current,experienceId,stepIndex,experienceRevision:revision,
          tourState:{selectedId:experienceId,step:transition.completionToken?-1:stepIndex,total:transition.completionToken?0:20,active:!transition.completionToken,autoplay:false,navigating:false},
          ...(transition.completionToken?{completionToken:transition.completionToken}:{}),...(tourCommand?{tourCommand}:{})});
        expect(ack.isError,JSON.stringify(ack.content)).not.toBe(true);
        if(tourCommand)expect(ack.structuredContent.command.status).toBe('rendered');
        const state=(await t.call('get_inspection_state',{sessionId:t.sessionId})).structuredContent;
        expect(state.panels.find((panel:any)=>panel.panelId===current.panelId).tour).toMatchObject({step:transition.completionToken?-1:stepIndex,total:transition.completionToken?0:20,active:!transition.completionToken,autoplay:false});
        if(transition.completionToken) {
          expect(state.modelContext.lesson).toBeNull(); expect(state.modelContext.chapter).toBeNull();
          expect(state.lesson).toBeNull(); expect(state.experience).toBeUndefined();
        } else {
          expect(state.modelContext.lesson.id).toBe(experienceId);
          expect(state.modelContext.chapter.index).toBe(stepIndex+1);
        }
      };
      if(menuStart){
        const started=await t.call('navigate_experience',{...current,experienceId,stepIndex:0,baseExperienceRevision:0});
        expect(started.isError).not.toBe(true);
        await render(undefined,started.structuredContent.experienceTransition,0);
      }
      const actions=menuStart?['next','back','done']:['start','next','back','done'];
      for(const action of actions){
        const commandId=`tour-${action}`,stepIndex=action==='next'?1:0;
        const heartbeat={selectedId:experienceId,step:action==='back'?1:0,total:20,active:menuStart||action!=='start',autoplay:false,navigating:false};
        await t.call('poll_inspection',{...current,availability:'ready',tourState:heartbeat});
        const queued=await t.call('control_tour',{...current,commandId,action,...(action==='start'?{tourId:experienceId}:{})});
        expect(queued.isError,JSON.stringify(queued.content)).not.toBe(true);
        expect(queued.structuredContent.tourBefore).toEqual(heartbeat);
        const polled=await t.call('poll_inspection',{...current,availability:'ready',tourState:heartbeat});
        const delivery=polled._meta[KEY].delivery;
        const {sessionId,...claim}=current;
        const tourCommand={...claim,commandId,claimToken:delivery.claimToken};
        expect((await t.call('complete_inspection',{...current,commandId,claimToken:delivery.claimToken,phase:'admit'})).structuredContent.admitted).toBe(true);
        const navigate={...current,experienceId,stepIndex,baseExperienceRevision:revision,...(action==='done'?{finish:true}:{}),tourCommand};
        const prepared=await t.call('navigate_experience',navigate);
        expect(prepared.isError,JSON.stringify(prepared.content)).not.toBe(true);
        const pending=await t.call('get_inspection_state',{sessionId:t.sessionId,commandId});
        expect(pending.structuredContent.command.status).toBe('rendering');
        expect((await t.call('navigate_experience',navigate)).isError).toBe(true);
        await render(tourCommand,prepared.structuredContent.experienceTransition,stepIndex);
        const receipt=await t.call('get_inspection_state',{sessionId:t.sessionId,commandId});
        expect(receipt.structuredContent.command.status).toBe('rendered');
      }
      expect((await t.hydrate())._meta[KEY].scene).toEqual(original);
    } finally {await t.close();}
  });
  for (const sameSource of [false, true]) for (const stepIndex of [0, 19]) it(`Done restores the pre-tour scene across hydration and reload (same source ${sameSource}, scene ${stepIndex + 1})`, async () => {
    const t = await setup({ fetchPdbText: () => hhbPromise });
    try {
      if(sameSource) await t.call('open', {sessionId:t.sessionId,structureText:await hhbPromise});
      await ready(t);
      const initial=(await t.hydrate())._meta[KEY], catalog=await decodeInspectionCatalog(initial.catalogWire ?? initial.catalog);
      const wearer=structuredClone(initial.scene); wearer.selectionKeys=[catalog.rows[0].key];
      wearer.inspection.appearance.representation='cartoon'; wearer.inspection.appearance.color='chain-id';
      wearer.inspection.placement={translation:[2,1,0],rotation:[10,40,0],scale:1.4};
      const before = await ready(t,wearer), original = (await t.hydrate())._meta[KEY];
      const started = await t.call('navigate_experience', { ...before, experienceId, stepIndex: 0, baseExperienceRevision: 0 });
      expect(started.isError).not.toBe(true);
      if(stepIndex) {
        const first=(await t.hydrate())._meta[KEY], shown=await ready(t);
        await t.call('acknowledge_experience_step',{...shown,experienceId,stepIndex:0,experienceRevision:first.experience.revision});
        expect((await t.call('navigate_experience',{...shown,experienceId,stepIndex,baseExperienceRevision:first.experience.revision})).isError).not.toBe(true);
      }
      const chapter = (await t.hydrate())._meta[KEY], drawn = await ready(t);
      expect((await t.call('acknowledge_experience_step', { ...drawn, experienceId, stepIndex, experienceRevision: chapter.experience.revision })).isError).not.toBe(true);
      const done = await t.call('navigate_experience', { ...drawn, experienceId, stepIndex, baseExperienceRevision: chapter.experience.revision, finish: true });
      expect(done.isError).not.toBe(true);
      expect(done.structuredContent.experienceTransition.completionToken).toBeTruthy();
      expect(done.structuredContent.experienceTransition.status).toBe('pending');
      const after = (await t.hydrate())._meta[KEY];
      expect(after.experience).toBeUndefined(); expect(after.scene).toEqual(original.scene);
      expect(after.structureText).toBe(original.structureText);
      const attached=(await t.call('attach_inspection',{...bound(t,after),surface:'companion',replacesPanelId:drawn.panelId})).structuredContent;
      const premature=await t.call('acknowledge_experience_step',{...bound(t,after),panelId:attached.panelId,experienceId,stepIndex,
        experienceRevision:chapter.experience.revision,completionToken:done.structuredContent.experienceTransition.completionToken});
      expect(premature.isError).toBe(true); expect(premature.content[0].text).toContain('rendered and saved pre-tour view');
      const restored = await ready(t,after.scene);
      const acknowledged = await t.call('acknowledge_experience_step', { ...restored, experienceId, stepIndex,
        experienceRevision: chapter.experience.revision, completionToken: done.structuredContent.experienceTransition.completionToken });
      expect(acknowledged.isError).not.toBe(true);
      expect(acknowledged.structuredContent.experienceCompletion.status).toBe('rendered');
      for (let reload = 0; reload < 2; reload++) {
        const hydration = (await t.hydrate())._meta[KEY];
        expect(hydration.experience).toBeUndefined(); expect(hydration.scene).toEqual(original.scene);
        expect(hydration.experienceCompletion.status).toBe('rendered');
      }
      expect((await t.call('navigate_experience', { ...drawn, experienceId, stepIndex: 1, baseExperienceRevision: chapter.experience.revision })).isError).toBe(true);
    } finally { await t.close(); }
  });
  it('starts the 4HHB journey on exact loaded local bytes without fetching or replacing its source', async () => {
    let fetches = 0;
    const t = await setup({ fetchPdbText: async () => { fetches++; return hhbPromise; } });
    try {
      expect((await t.call('open', { sessionId: t.sessionId, structureText: await hhbPromise })).isError).not.toBe(true);
      const before = await ready(t);
      const result = await t.call('navigate_experience', { ...before, experienceId, stepIndex: 0, baseExperienceRevision: 0, loadedSourceOnly: true });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent.sourceToken).toBe(before.sourceToken);
      expect(result.structuredContent.experienceTransition.sourceChanged).toBe(false);
      const data = (await t.hydrate())._meta[KEY];
      expect(data.experience.definition.id).toBe(experienceId); expect(data.experience.applied).toBe(false);
      expect(data.structureText).toBe(await hhbPromise); expect(fetches).toBe(0);
    } finally { await t.close(); }
  });
  it('refuses a different loaded assembly with both assembly names and keeps the exact source', async () => {
    const t = await setup();
    try {
      const opened=await t.call('inspect',{structureText:await hhbPromise,assemblyId:'1'});
      expect(opened.isError).not.toBe(true);
      t.sessionId=opened.structuredContent.sessionId;
      t.hydrate=()=>t.call('get_inspection',{sessionId:t.sessionId});
      const before=await ready(t), original=(await t.hydrate())._meta[KEY];
      const refused=await t.call('navigate_experience',{...before,experienceId,stepIndex:0,baseExperienceRevision:0,loadedSourceOnly:true});
      expect(refused.isError).toBe(true);
      expect(refused.content[0].text).toContain('Journey needs the asymmetric unit; you have assembly 1. Use Tours to explicitly load its assembly.');
      const after=(await t.hydrate())._meta[KEY];
      expect(after.sourceToken).toBe(original.sourceToken); expect(after.scene).toEqual(original.scene);
      expect(after.experience).toBeUndefined();
    } finally {await t.close();}
  });
  it('a failed Done can recover its rendered chapter and retry without losing the pre-tour snapshot', async () => {
    const t=await setup({fetchPdbText:()=>hhbPromise});
    try {
      const before=await ready(t), original=(await t.hydrate())._meta[KEY];
      await t.call('navigate_experience',{...before,experienceId,stepIndex:0,baseExperienceRevision:0});
      const chapter=(await t.hydrate())._meta[KEY], drawn=await ready(t);
      await t.call('acknowledge_experience_step',{...drawn,experienceId,stepIndex:0,experienceRevision:chapter.experience.revision});
      const done=await t.call('navigate_experience',{...drawn,experienceId,stepIndex:0,baseExperienceRevision:chapter.experience.revision,finish:true});
      const prepared=(await t.hydrate())._meta[KEY];
      const rollback=await t.call('navigate_experience',{...bound(t,prepared),panelId:drawn.panelId,experienceId,stepIndex:0,
        baseExperienceRevision:0,rollbackToken:done.structuredContent.experienceTransition.rollbackToken});
      expect(rollback.isError).not.toBe(true);
      const recovered=(await t.hydrate())._meta[KEY];
      expect(recovered.experience.definition.id).toBe(experienceId); expect(recovered.experienceCompletion).toBeUndefined();
      const readyAgain=await ready(t);
      const retry=await t.call('navigate_experience',{...readyAgain,experienceId,stepIndex:0,baseExperienceRevision:recovered.experience.revision,finish:true});
      expect(retry.isError).not.toBe(true);
      const restored=(await t.hydrate())._meta[KEY];
      expect(restored.scene).toEqual(original.scene); expect(restored.structureText).toBe(original.structureText);
      await t.call('open',{sessionId:t.sessionId,structureText:await hhbPromise});
      const corrected=(await t.hydrate())._meta[KEY];
      const stale=await t.call('navigate_experience',{...bound(t,corrected),panelId:readyAgain.panelId,experienceId,stepIndex:0,
        baseExperienceRevision:0,rollbackToken:retry.structuredContent.experienceTransition.rollbackToken});
      expect(stale.isError).toBe(true);
      expect((await t.hydrate())._meta[KEY].sourceToken).toBe(corrected.sourceToken);
    } finally {await t.close();}
  });
  it('refuses a plain Tour for an unrelated structure without changing source, scene, or experience', async () => {
    let fetches = 0;
    const t = await setup({ fetchPdbText: async () => { fetches++; return hhbPromise; } });
    try {
      const before = await ready(t), original = (await t.hydrate())._meta[KEY];
      const result = await t.call('navigate_experience', { ...before, experienceId, stepIndex: 0, baseExperienceRevision: 0, loadedSourceOnly: true });
      expect(result.isError).toBe(true); expect(result.content[0].text).toContain('No journey for 1CRN yet');
      const after = (await t.hydrate())._meta[KEY];
      expect(after.sourceToken).toBe(before.sourceToken); expect(after.scene).toEqual(original.scene);
      expect(after.experience).toBeUndefined(); expect(fetches).toBe(0);
    } finally { await t.close(); }
  });
  it('restores exact prior bytes and saved scene after an explicit chooser stage fails, without a render claim', async () => {
    const t = await setup({ fetchPdbText: () => hhbPromise });
    try {
      const before = await ready(t), original = (await t.hydrate())._meta[KEY];
      const result = await t.call('navigate_experience', { ...before, experienceId, stepIndex: 0, baseExperienceRevision: 0 });
      expect(result.isError).not.toBe(true);
      const prepared = (await t.hydrate())._meta[KEY];
      expect(prepared.pdbId).toBe('4HHB'); expect(prepared.experience.applied).toBe(false);
      // Simulate the bearer rejecting the old detach: the old panel remains registered.
      const rollback = { ...bound(t, prepared), panelId: before.panelId, experienceId, stepIndex: 0, baseExperienceRevision: prepared.experience.revision,
        rollbackToken: result.structuredContent.experienceTransition.rollbackToken };
      const restored = await t.call('navigate_experience', rollback);
      expect(restored.isError).not.toBe(true);
      expect(restored.structuredContent.experienceTransition).toEqual({ sourceChanged: true, restored: true });
      expect(restored.structuredContent).not.toHaveProperty('sourceRenderReceipt');
      const after = (await t.hydrate())._meta[KEY];
      expect(after.structureText).toBe(original.structureText); expect(after.scene).toEqual(original.scene); expect(after.experience).toBeUndefined();
      expect(after.sourceToken).not.toBe(prepared.sourceToken);
      const attached = await t.call('attach_inspection', { ...bound(t, after), surface: 'companion', replacesPanelId: before.panelId });
      expect(attached.isError).not.toBe(true);
      const panels = (await t.call('get_inspection_state', { sessionId: t.sessionId })).structuredContent.panels;
      expect(panels.map((p: any) => p.panelId)).toEqual([attached.structuredContent.panelId]);
      expect((await t.call('navigate_experience', rollback)).isError).toBe(true);
    } finally { await t.close(); }
  });
  it('never restores an old journey source over a newer source correction', async () => {
    const t = await setup({ fetchPdbText: () => hhbPromise });
    try {
      const before = await ready(t);
      const result = await t.call('navigate_experience', { ...before, experienceId, stepIndex: 0, baseExperienceRevision: 0 });
      expect((await t.call('open', { sessionId: t.sessionId, structureText: cif })).isError).not.toBe(true);
      const corrected = (await t.hydrate())._meta[KEY];
      const rollback = await t.call('navigate_experience', { ...bound(t, corrected), panelId: before.panelId, experienceId, stepIndex: 0,
        baseExperienceRevision: 0, rollbackToken: result.structuredContent.experienceTransition.rollbackToken });
      expect(rollback.isError).toBe(true);
      const after = (await t.hydrate())._meta[KEY];
      expect(after.sourceToken).toBe(corrected.sourceToken); expect(after.structureText).toBe(cif);
    } finally { await t.close(); }
  });
  it('a rendered saved acknowledgement consumes recovery so a completed journey cannot be undone by an old failure', async () => {
    const t = await setup({ fetchPdbText: () => hhbPromise });
    try {
      const before = await ready(t);
      const result = await t.call('navigate_experience', { ...before, experienceId, stepIndex: 0, baseExperienceRevision: 0 });
      const prepared = (await t.hydrate())._meta[KEY];
      const drawn = await ready(t);
      const ack = await t.call('acknowledge_experience_step', { ...drawn, experienceId, stepIndex: 0, experienceRevision: prepared.experience.revision });
      expect(ack.structuredContent.experienceAcknowledged).toBe(true);
      const rejected = await t.call('navigate_experience', { ...drawn, panelId: before.panelId, experienceId, stepIndex: 0,
        baseExperienceRevision: prepared.experience.revision, rollbackToken: result.structuredContent.experienceTransition.rollbackToken });
      expect(rejected.isError).toBe(true);
      expect((await t.hydrate())._meta[KEY].experience.applied).toBe(true);
    } finally { await t.close(); }
  });
});

it('a failed journey cannot restore over a newer saved scene on the same source', async () => {
  const hhb = await readFile(new URL('../../fixtures/4HHB.cif', import.meta.url), 'utf8');
  const t = await setup({ fetchPdbText: async () => hhb });
  try {
    const saved = (await t.call('sync_inspection', t.args)).structuredContent;
    const before = { sessionId: t.sessionId, serverEpoch: saved.serverEpoch, sourceToken: saved.sourceToken,
      baseStateRevision: saved.stateRevision, baseInspectionRevision: saved.inspectionRevision };
    const panelId = (await t.call('attach_inspection', { ...before, surface: 'companion' })).structuredContent.panelId;
    const experienceId = 'hemoglobin-quaternary-structure';
    const transition = await t.call('navigate_experience', { ...before, panelId, experienceId, stepIndex: 0, baseExperienceRevision: 0 });
    const data = (await t.hydrate())._meta[KEY];
    const catalog = await decodeInspectionCatalog(data.catalogWire ?? data.catalog);
    const current = { ...before, sourceToken: data.sourceToken, baseStateRevision: data.stateRevision, baseInspectionRevision: data.inspectionRevision };
    const scene = { ...t.scene, sourceSha256: catalog.source.sha256, modelNumber: catalog.modelNumbers[0], assemblyId: catalog.assemblyId, selectionKeys: [] };
    const changed = (await t.call('sync_inspection', { ...current, scene })).structuredContent;
    const refused = await t.call('navigate_experience', { ...current, baseInspectionRevision: changed.inspectionRevision, panelId, experienceId,
      stepIndex: 0, baseExperienceRevision: data.experience.revision, rollbackToken: transition.structuredContent.experienceTransition.rollbackToken });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('newer scene or request superseded');
    const after = (await t.hydrate())._meta[KEY];
    expect(after.scene).toEqual(scene); expect(after.sourceToken).toBe(data.sourceToken);
  } finally { await t.close(); }
});

it('a refused source records its outcome and delivers the complete host refusal to the wearer once', async () => {
  const t=await setup();
  try {
    const saved=(await t.call('sync_inspection',t.args)).structuredContent;
    const binding={sessionId:t.sessionId,serverEpoch:saved.serverEpoch,sourceToken:saved.sourceToken,
      baseStateRevision:saved.stateRevision,baseInspectionRevision:saved.inspectionRevision};
    const panelId=(await t.call('attach_inspection',{...binding,surface:'companion'})).structuredContent.panelId;
    const poll=()=>t.call('poll_inspection',{...binding,panelId,availability:'ready'});
    await poll();
    const commandId=randomUUID();
    const refused=await t.call('replace_inspection_source',{...binding,panelId,commandId,
      source:{kind:'url',url:'http://example.test/model.cif'}});
    expect(refused.isError).toBe(true);
    const response=await poll(), caption=response._meta[KEY].headsetCaption;
    expect(caption).toMatchObject({commandId,speak:false,holdSeconds:6,
      refusal:{tool:'replace_inspection_source',reason:'insecure address'},
      text:`Could not load · insecure address. ${refused.content[0].text}`});
    expect(response.structuredContent.outcome).toBeNull();
    expect((await poll())._meta[KEY].headsetCaption).toBeUndefined();
    expect((await t.hydrate())._meta[KEY].sourceToken).toBe(binding.sourceToken);
    const log=await t.call('read_headset_log',{kind:'outcome'});
    expect(log.structuredContent.entries).toHaveLength(1);
    expect(log.structuredContent.entries[0].detail).toMatchObject({status:'refused',tool:'replace_inspection_source',
      reason:'insecure address',commandId,stale:false,queued:true,drawn:false,seatOutcome:'pending'});
    expect(log.structuredContent.entries[0].detail.captionId).toBe(caption.id);
    const entries:any[]=[];
    const scope={__stereofoldDiagnostics:{record:(kind:string,detail:unknown)=>entries.push({seq:entries.length+1,at:1000,kind,detail})}};
    recordTalkReplySeat(caption,{outcome:'shown',fallback:'structure-overlap'},{scope});
    await t.call('poll_inspection',{...binding,panelId,availability:'ready',diagnostics:{entries}});
    const shown=await t.call('read_headset_log',{kind:'outcome'});
    expect(shown.structuredContent.entries).toHaveLength(2);
    expect(shown.structuredContent.entries.find((entry:any)=>entry.detail.seatOutcome==='shown').detail)
      .toMatchObject({status:'refused',captionId:caption.id,commandId,tool:'replace_inspection_source',
        reason:'insecure address',drawn:true,fallback:'structure-overlap'});
    expect(JSON.stringify(shown)).not.toContain('example.test');
  } finally {await t.close();}
});

it('a refused stale source command is logged without overwriting the current wearer reply', async () => {
  const t=await setup();
  try {
    const saved=(await t.call('sync_inspection',t.args)).structuredContent;
    const binding={sessionId:t.sessionId,serverEpoch:saved.serverEpoch,sourceToken:saved.sourceToken,
      baseStateRevision:saved.stateRevision,baseInspectionRevision:saved.inspectionRevision};
    const panelId=(await t.call('attach_inspection',{...binding,surface:'companion'})).structuredContent.panelId;
    const poll=()=>t.call('poll_inspection',{...binding,panelId,availability:'ready'});
    await poll();
    const refused=await t.call('replace_inspection_source',{...binding,panelId,sourceToken:randomUUID(),
      source:{kind:'url',url:'http://example.test/model.cif'}});
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('Read the current inspection state');
    expect((await poll())._meta[KEY].headsetCaption).toBeUndefined();
    const log=await t.call('read_headset_log',{kind:'outcome'});
    expect(log.structuredContent.entries[0].detail).toMatchObject({status:'refused',stale:true,queued:false});
  } finally {await t.close();}
});

/**
 * A refusal that never became a tool call, drawn and recorded like
 * one that did.
 *
 * The insecure URL the wearer asked the loop for was turned down
 * in `fillAgentArguments`, one hop before dispatch, so the sentence reached the
 * agent terminal and the wearer saw nothing at all — no card, no outcome record
 * — while the same request typed at a menu row drew both
 */
it('a refusal reported before dispatch draws the same card and writes the same record', async () => {
  const t=await setup();
  try {
    const saved=(await t.call('sync_inspection',t.args)).structuredContent;
    const binding={sessionId:t.sessionId,serverEpoch:saved.serverEpoch,sourceToken:saved.sourceToken,
      baseStateRevision:saved.stateRevision,baseInspectionRevision:saved.inspectionRevision};
    const panelId=(await t.call('attach_inspection',{...binding,surface:'companion'})).structuredContent.panelId;
    const poll=()=>t.call('poll_inspection',{...binding,panelId,availability:'ready'});
    await poll();
    const sentence='Only https and file URLs are supported, and insecure URLs are refused.';
    const commandId=randomUUID();
    const reported=await t.call('say_to_headset',{text:sentence,commandId,
      refusal:{tool:'replace_inspection_source',sessionId:t.sessionId}});
    expect(reported.isError).not.toBe(true);
    expect(reported.structuredContent).toMatchObject({queued:true,spoken:false,audible:false,stale:false,
      text:`Could not load · insecure address. ${sentence}`,
      refusal:{tool:'replace_inspection_source',reason:'insecure address',scoped:true}});

    const caption=(await poll())._meta[KEY].headsetCaption;
    expect(caption).toMatchObject({commandId,speak:false,holdSeconds:6,
      refusal:{tool:'replace_inspection_source',reason:'insecure address'},
      text:`Could not load · insecure address. ${sentence}`});
    expect((await poll())._meta[KEY].headsetCaption).toBeUndefined();

    const log=await t.call('read_headset_log',{kind:'outcome'});
    expect(log.structuredContent.entries).toHaveLength(1);
    expect(log.structuredContent.entries[0].detail).toMatchObject({status:'refused',tool:'replace_inspection_source',
      reason:'insecure address',commandId,stale:false,queued:true,drawn:false,seatOutcome:'pending',origin:'pre-dispatch',scoped:true});
    // Nothing was loaded, and the scene is where it was.
    expect((await t.hydrate())._meta[KEY].sourceToken).toBe(binding.sourceToken);
  } finally {await t.close();}
});

it('a reported refusal with no identifiable session is still recorded and still drawn', async () => {
  const t=await setup();
  try {
    const saved=(await t.call('sync_inspection',t.args)).structuredContent;
    const binding={sessionId:t.sessionId,serverEpoch:saved.serverEpoch,sourceToken:saved.sourceToken,
      baseStateRevision:saved.stateRevision,baseInspectionRevision:saved.inspectionRevision};
    const panelId=(await t.call('attach_inspection',{...binding,surface:'companion'})).structuredContent.panelId;
    const poll=()=>t.call('poll_inspection',{...binding,panelId,availability:'ready'});
    await poll();
    const reported=await t.call('say_to_headset',{text:'That paste is larger than this host will parse.',
      refusal:{tool:'inspect_file'}});
    expect(reported.structuredContent).toMatchObject({queued:true,refusal:{scoped:false,reason:'request refused'}});
    expect((await poll())._meta[KEY].headsetCaption).toMatchObject({speak:false,
      text:'Could not load · request refused. That paste is larger than this host will parse.'});
    const log=await t.call('read_headset_log',{kind:'outcome'});
    expect(log.structuredContent.entries[0].detail).toMatchObject({status:'refused',tool:'inspect_file',
      stale:false,queued:true,origin:'pre-dispatch',scoped:false});
  } finally {await t.close();}
});

/**
 * A refusal scoped to the live session, drawn after the source
 * underneath it changed.
 *
 * On the Quest 2 a camera refusal reported with `refusal={tool,sessionId}`
 * came back "Queued refusal" after its full delivery wait and was never drawn:
 * no card, no ring record, nothing at +44 s. The same sentence without a
 * session was drawn in under two seconds. The
 * scope carried the source token live when the refusal was raised, and a
 * source that rotates before the wearer's next heartbeat leaves that token
 * naming a structure the headset has already left. The refusal never was a
 * command and never named a source, so it no longer carries one: the session
 * keeps it off another scene and the refusal serial keeps it off a newer
 * request.
 */
it('draws a session-scoped reported refusal whose source rotated before the next heartbeat', async () => {
  let releaseSource!:()=>void;
  const heldSource=new Promise<void>(resolve => {releaseSource=resolve;});
  const hhb=await readFile(new URL('../../fixtures/4HHB.cif',import.meta.url),'utf8');
  const t=await setup({transcriber:replyBindingTranscriber(),
    fetchPdbText:async()=>{await heldSource;return hhb;}});
  try {
    const saved=(await t.call('sync_inspection',t.args)).structuredContent;
    const binding={sessionId:t.sessionId,serverEpoch:saved.serverEpoch,sourceToken:saved.sourceToken,
      baseStateRevision:saved.stateRevision,baseInspectionRevision:saved.inspectionRevision};
    const panelId=(await t.call('attach_inspection',{...binding,surface:'companion'})).structuredContent.panelId;
    await t.call('poll_inspection',{...binding,panelId,availability:'ready'});
    const utteranceId='11111111-2222-4333-8444-555555555555';
    await claimHeadsetUtterance(t,panelId,utteranceId);
    // The replacement holds its source open, so the refusal is raised against
    // the structure the wearer is still looking at and the rotation lands
    // between the card being queued and the page's next heartbeat.
    const replacing=t.call('replace_inspection_source',{...binding,panelId,pdbId:'4HHB'});
    await new Promise(resolve => setTimeout(resolve,40));
    const reporting=t.call('say_to_headset',{text:'The headset owns its viewpoint, so the camera cannot be turned from here.',
      utteranceId,refusal:{tool:'update_inspection',sessionId:t.sessionId}});
    await new Promise(resolve => setTimeout(resolve,40));
    releaseSource();
    const replaced=await replacing;
    expect(replaced.isError).not.toBe(true);
    expect(replaced.structuredContent.sourceToken).not.toBe(binding.sourceToken);

    const rotated=(await t.hydrate())._meta[KEY].sourceToken;
    const caption=(await t.call('poll_inspection',{...binding,sourceToken:rotated,panelId,availability:'ready'}))._meta[KEY].headsetCaption;
    const reported=await reporting;
    expect(reported.structuredContent).toMatchObject({queued:true,delivered:true,stale:false,
      utteranceBinding:'active',utteranceId,refusal:{tool:'update_inspection',reason:'request refused',scoped:true}});
    expect(reported.content[0].text).toContain('Delivered refusal for update_inspection');
    expect(caption).toMatchObject({speak:false,utteranceId,
      refusal:{tool:'update_inspection',reason:'request refused',origin:'pre-dispatch'},
      text:'Could not apply · request refused. The headset owns its viewpoint, so the camera cannot be turned from here.'});
    // Bound to the session and the refusal serial, never to a structure.
    expect(caption.refusalScope).toMatchObject({sessionId:t.sessionId});
    expect(caption.refusalScope.sourceToken).toBeUndefined();
    const outcomes=(await t.call('read_headset_log',{kind:'outcome'})).structuredContent.entries;
    expect(outcomes.map((entry:any)=>entry.detail.origin)).toContain('pre-dispatch');
  } finally {await t.close();}
});

/**
 * The protection the same change must keep, and the answer the
 * caller was never given.
 *
 * A refusal naming an inspection the headset has left cannot be drawn over the
 * one it is showing. Before this it was reported as "Queued" and simply never
 * appeared, which is what made the device failure unreadable; it now names the
 * limit the way every other refusal does.
 */
it('refuses to draw a reported refusal scoped to a session the headset has left, and says why', async () => {
  const t=await setup({transcriber:replyBindingTranscriber()});
  try {
    const departed=t.sessionId;
    const hhb=await readFile(new URL('../../fixtures/4HHB.cif',import.meta.url),'utf8');
    const current=(await t.call('inspect',{structureText:hhb})).structuredContent.sessionId;
    expect(current).not.toBe(departed);
    const live=(await t.call('get_inspection',{sessionId:current}))._meta[KEY];
    const catalog=await decodeInspectionCatalog(live.catalogWire ?? live.catalog);
    const scene={...t.scene,sourceSha256:catalog.source.sha256,modelNumber:catalog.modelNumbers[0],
      assemblyId:catalog.assemblyId,selectionKeys:[catalog.rows[0].key]};
    const saved=(await t.call('sync_inspection',{sessionId:current,serverEpoch:live.serverEpoch,sourceToken:live.sourceToken,
      baseStateRevision:live.stateRevision,baseInspectionRevision:live.inspectionRevision,scene})).structuredContent;
    const binding={sessionId:current,serverEpoch:saved.serverEpoch,sourceToken:saved.sourceToken,
      baseStateRevision:saved.stateRevision,baseInspectionRevision:saved.inspectionRevision};
    const panelId=(await t.call('attach_inspection',{...binding,surface:'companion'})).structuredContent.panelId;
    await t.call('poll_inspection',{...binding,panelId,availability:'ready'});

    const reporting=t.call('say_to_headset',{text:'Only https and file URLs are supported.',
      refusal:{tool:'replace_inspection_source',sessionId:departed}});
    await new Promise(resolve => setTimeout(resolve,25));
    // The card stays off the scene the wearer is actually looking at.
    expect((await t.call('poll_inspection',{...binding,panelId,availability:'ready'}))._meta[KEY].headsetCaption).toBeUndefined();
    const reported=await reporting;
    expect(reported.structuredContent).toMatchObject({queued:false,delivered:false,stale:false,
      refusal:{tool:'replace_inspection_source',scoped:true},
      undrawnReason:'it named an inspection the headset is no longer showing, so the wearer never saw it.'});
    expect(reported.content[0].text)
      .toBe('Could not draw the refusal for replace_inspection_source: it named an inspection the headset is no longer showing, so the wearer never saw it.');
    const outcomes=(await t.call('read_headset_log',{kind:'outcome'})).structuredContent.entries;
    expect(outcomes.at(-1).detail).toMatchObject({status:'refused',tool:'replace_inspection_source',
      drawn:false,queued:false,seatOutcome:'dropped',origin:'pre-dispatch'});
    expect(outcomes.at(-1).detail.scopeMismatch).toContain('session');
  } finally {await t.close();}
});

/** The unscoped card keeps the behaviour it had, rotation or not. */
it('keeps drawing an unscoped reported refusal across a source rotation', async () => {
  let releaseSource!:()=>void;
  const heldSource=new Promise<void>(resolve => {releaseSource=resolve;});
  const hhb=await readFile(new URL('../../fixtures/4HHB.cif',import.meta.url),'utf8');
  const t=await setup({transcriber:replyBindingTranscriber(),
    fetchPdbText:async()=>{await heldSource;return hhb;}});
  try {
    const saved=(await t.call('sync_inspection',t.args)).structuredContent;
    const binding={sessionId:t.sessionId,serverEpoch:saved.serverEpoch,sourceToken:saved.sourceToken,
      baseStateRevision:saved.stateRevision,baseInspectionRevision:saved.inspectionRevision};
    const panelId=(await t.call('attach_inspection',{...binding,surface:'companion'})).structuredContent.panelId;
    await t.call('poll_inspection',{...binding,panelId,availability:'ready'});
    const replacing=t.call('replace_inspection_source',{...binding,panelId,pdbId:'4HHB'});
    await new Promise(resolve => setTimeout(resolve,40));
    const reporting=t.call('say_to_headset',{text:'That paste is larger than this host will parse.',
      refusal:{tool:'inspect_file'}});
    await new Promise(resolve => setTimeout(resolve,40));
    releaseSource();
    await replacing;
    const rotated=(await t.hydrate())._meta[KEY].sourceToken;
    const caption=(await t.call('poll_inspection',{...binding,sourceToken:rotated,panelId,availability:'ready'}))._meta[KEY].headsetCaption;
    const reported=await reporting;
    expect(reported.structuredContent).toMatchObject({queued:true,delivered:true,
      refusal:{tool:'inspect_file',reason:'request refused',scoped:false}});
    expect(reported.structuredContent.undrawnReason).toBeUndefined();
    expect(caption).toMatchObject({speak:false,
      text:'Could not load · request refused. That paste is larger than this host will parse.'});
    expect(caption.refusalScope).toBeUndefined();
  } finally {await t.close();}
});

it('a reported refusal for an utterance the wearer has moved past is recorded and never drawn', async () => {
  const t=await setup();
  try {
    const saved=(await t.call('sync_inspection',t.args)).structuredContent;
    const binding={sessionId:t.sessionId,serverEpoch:saved.serverEpoch,sourceToken:saved.sourceToken,
      baseStateRevision:saved.stateRevision,baseInspectionRevision:saved.inspectionRevision};
    const panelId=(await t.call('attach_inspection',{...binding,surface:'companion'})).structuredContent.panelId;
    const poll=()=>t.call('poll_inspection',{...binding,panelId,availability:'ready'});
    await poll();
    const stale=await t.call('say_to_headset',{text:'Only https and file URLs are supported.',
      utteranceId:randomUUID(),refusal:{tool:'replace_inspection_source',sessionId:t.sessionId}});
    expect(stale.structuredContent).toMatchObject({queued:false,delivered:false,stale:true,
      utteranceBinding:'stale'});
    expect((await poll())._meta[KEY].headsetCaption).toBeUndefined();
    const log=await t.call('read_headset_log',{kind:'outcome'});
    expect(log.structuredContent.entries[0].detail).toMatchObject({status:'refused',stale:true,queued:false,
      origin:'pre-dispatch'});
  } finally {await t.close();}
});

/**
 * The word the menu row uses, accepted where the wearer's words
 * arrive.
 */
it('accepts the wearer’s word for a representation and refuses an unknown one in one sentence', async () => {
  const t=await setup();
  try {
    const saved=(await t.call('sync_inspection',t.args)).structuredContent;
    const binding={sessionId:t.sessionId,serverEpoch:saved.serverEpoch,sourceToken:saved.sourceToken,
      baseStateRevision:saved.stateRevision,baseInspectionRevision:saved.inspectionRevision};
    const panelId=(await t.call('attach_inspection',{...binding,surface:'companion'})).structuredContent.panelId;
    await t.call('poll_inspection',{...binding,panelId,availability:'ready'});
    const asked=await t.call('update_inspection',{...binding,panelId,commandId:randomUUID(),
      change:{kind:'appearance',patch:{representation:'surface'}}});
    expect(asked.isError).not.toBe(true);
    const delivery=(await t.call('poll_inspection',{...binding,panelId,availability:'ready'}))._meta[KEY].delivery;
    expect(delivery.change).toEqual({kind:'appearance',patch:{representation:'molecular-surface'}});

    const refused=await t.call('update_inspection',{...binding,panelId,commandId:randomUUID(),
      change:{kind:'appearance',patch:{representation:'blobs'}}});
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('A structure is drawn as a cartoon, as ball and stick');
    expect(refused.content[0].text).not.toMatch(/invalid_union|invalid_enum_value|unionErrors/u);
  } finally {await t.close();}
});

/**
 * The plain reply path used to render its speech before it
 * queued its caption. Narration is a round trip, so on a device session the
 * pass the wearer read nothing for 5.6-5.9 s while a scoped refusal, which is
 * never spoken, was on the plate in a tenth of a second. These cases hold the
 * synthesiser open on a controlled clock: the caption has to be claimable
 * before the clip exists, and the clip has to reach the wearer afterwards.
 */
function heldSynthesizer(renderMs:number) {
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const clip={base64:'T2dnUw==',mimeType:'audio/ogg; codecs=opus',format:'ogg-opus',bytes:4,seconds:7.7};
  const clock={ms:1_700_000_000_000};
  return {clip,release,clock,now:()=>clock.ms,
    replyAudio:{ready:true,enabled:true,describe:()=>'held test synthesiser',
      synthesize:async()=>{await gate;clock.ms+=renderMs;return clip;}}};
}
/** Let the pending tool call reach the caption queue before the page beats. */
const settle=()=>new Promise(resolve=>setTimeout(resolve,25));

it('draws a plain reply on the next heartbeat instead of holding it for its speech',async()=>{
  const held=heldSynthesizer(5_900);
  const t=await setup({replyAudio:held.replyAudio,now:held.now});
  try {
    const saved=(await t.call('sync_inspection',t.args)).structuredContent;
    const binding={sessionId:t.sessionId,serverEpoch:saved.serverEpoch,sourceToken:saved.sourceToken,
      baseStateRevision:saved.stateRevision,baseInspectionRevision:saved.inspectionRevision};
    const panelId=(await t.call('attach_inspection',{...binding,surface:'companion'})).structuredContent.panelId;
    const poll=()=>t.call('poll_inspection',{...binding,panelId,availability:'ready'});
    await poll();
    const answer='I cannot rotate the camera: the headset owns its viewpoint.';

    const saying=t.call('say_to_headset',{text:answer});
    await settle();
    // The wearer's page beats 900 ms later, while the narration helper is
    // still working. It must already have the words.
    held.clock.ms+=900;
    const drawn=(await poll())._meta[KEY].headsetCaption;
    expect(drawn).toMatchObject({text:answer,speak:true});
    expect(drawn.audio).toBeUndefined();

    held.release();
    const said=await saying;
    expect(said.isError).not.toBe(true);
    expect(said.structuredContent).toMatchObject({queued:true,delivered:true,stale:false,
      captionId:drawn.id,captionDrawnMs:900,speechReadyMs:6_800,spokenVia:'voice',audible:true});
    expect(said.structuredContent.captionDrawnMs).toBeLessThan(1_000);
    expect(said.content[0].text).toContain('took the caption 900 ms after it was queued');

    // The clip arrived after a page had taken the silent caption, so it rides
    // its own entry, which names the caption it speaks for.
    const spoken=(await poll())._meta[KEY].headsetCaption;
    expect(spoken).toMatchObject({text:answer,voiceFor:drawn.id});
    expect(spoken.audio).toEqual(held.clip);
    expect(spoken.id).toBe(said.structuredContent.voiceCaptionId);
  } finally {held.release();await t.close();}
});

it('retires a refusal card the wearer is still reading and reports what it replaced',async()=>{
  const held=heldSynthesizer(5_600);
  const t=await setup({replyAudio:held.replyAudio,now:held.now});
  try {
    const saved=(await t.call('sync_inspection',t.args)).structuredContent;
    const binding={sessionId:t.sessionId,serverEpoch:saved.serverEpoch,sourceToken:saved.sourceToken,
      baseStateRevision:saved.stateRevision,baseInspectionRevision:saved.inspectionRevision};
    const panelId=(await t.call('attach_inspection',{...binding,surface:'companion'})).structuredContent.panelId;
    const poll=()=>t.call('poll_inspection',{...binding,panelId,availability:'ready'});
    await poll();

    const refused=await t.call('say_to_headset',{text:'Only https and file URLs are supported, and insecure URLs are refused.',
      refusal:{tool:'replace_inspection_source',sessionId:t.sessionId}});
    const card=(await poll())._meta[KEY].headsetCaption;
    expect(card.speak).toBe(false);
    expect(card.id).toBe(refused.structuredContent.captionId);

    // One second into the card's six-second hold, the agent answers.
    held.clock.ms+=1_000;
    const answer='Turn your head, or ask me to move the molecule.';
    const saying=t.call('say_to_headset',{text:answer});
    await settle();
    held.clock.ms+=800;
    const drawn=(await poll())._meta[KEY].headsetCaption;
    expect(drawn).toMatchObject({text:answer,speak:true});

    held.release();
    const said=await saying;
    expect(said.structuredContent).toMatchObject({queued:true,delivered:true,captionDrawnMs:800,
      retired:{captionId:card.id,kind:'refusal',holdMs:6_000,shownMs:1_000}});
    expect(said.content[0].text).toContain(`retires the refusal card ${card.id} 1000 ms into its 6000 ms hold`);
  } finally {held.release();await t.close();}
});

it('reports a superseded reply the page had already taken as drawn but never spoken',async()=>{
  const held=heldSynthesizer(4_000);
  const t=await setup({replyAudio:held.replyAudio,now:held.now});
  try {
    const saved=(await t.call('sync_inspection',t.args)).structuredContent;
    const binding={sessionId:t.sessionId,serverEpoch:saved.serverEpoch,sourceToken:saved.sourceToken,
      baseStateRevision:saved.stateRevision,baseInspectionRevision:saved.inspectionRevision};
    const panelId=(await t.call('attach_inspection',{...binding,surface:'companion'})).structuredContent.panelId;
    const poll=()=>t.call('poll_inspection',{...binding,panelId,availability:'ready'});
    await poll();

    const older=t.call('say_to_headset',{text:'Older answer.'});
    await settle();
    held.clock.ms+=700;
    // The page took the older caption before the correction was issued, so the
    // wearer has read it and no receipt may claim it was never shown.
    expect((await poll())._meta[KEY].headsetCaption).toMatchObject({text:'Older answer.'});
    const newer=t.call('say_to_headset',{text:'Newer answer.'});
    await settle();
    held.release();
    expect((await older).structuredContent).toMatchObject({queued:false,delivered:false,stale:true,
      spoken:false,audible:false,drawn:true,text:'Older answer.'});
    expect((await older).content[0].text).toContain('It had already been drawn');
    expect((await newer).structuredContent).toMatchObject({queued:true,stale:false,text:'Newer answer.'});
    expect((await poll())._meta[KEY].headsetCaption).toMatchObject({text:'Newer answer.'});
  } finally {held.release();await t.close();}
});

/**
 * The segments of one reply used to
 * be rendered one after another, and every one of them paid the narration
 * helper's fixed set-up again. Measured against the shipped helper on this
 * Mac, a call costs about 4.0 s before it produces a sample, so three ordinary
 * sentences took 4.3 s, 4.4 s and 5.2 s end to end and the wearer waited 14.2 s
 * for the first sound. These cases hold each segment open separately, so
 * "they overlapped" and "the opening went out before the rest existed" are
 * both things a test can catch.
 */
function segmentedSynthesizer() {
  const started:string[]=[];
  const gates=new Map<string,(clip:any)=>void>();
  const clock={ms:1_700_000_000_000};
  const clip=(voice:string,seconds:number)=>({base64:'T2dnUw==',mimeType:'audio/ogg; codecs=opus',
    format:'ogg-opus',bytes:4,voice,seconds});
  /**
   * Wait for the helper to actually be asked, rather than for a fixed number
   * of milliseconds. A sleep long enough on an idle machine is not long enough
   * on a loaded one, and the failure it produces reads as a product bug.
   */
  const awaitStarted=async(count:number)=>{
    for(let tick=0;tick<400&&started.length<count;tick++) await new Promise(resolve=>setTimeout(resolve,5));
    if(started.length<count) throw Error(`only ${started.length} of ${count} segments reached the synthesiser`);
  };
  const finish=async(text:string,voice:string,seconds=3,advanceMs=0)=>{
    clock.ms+=advanceMs;
    gates.get(text)!(clip(voice,seconds));
    gates.delete(text);
    await new Promise(resolve=>setTimeout(resolve,25));
  };
  return {started,finish,clock,clip,awaitStarted,now:()=>clock.ms,pending:()=>[...gates.keys()],
    replyAudio:{ready:true,enabled:true,describe:()=>'segmented test synthesiser',
      synthesize:(text:string)=>{started.push(text);
        return new Promise<any>(resolve=>{gates.set(text,resolve);});}}};
}
/**
 * Four sentences that each fill their own segment: twenty words is past the
 * point where two of them would be packed together, and eighty words is well
 * inside the two-hundred-word reply bound.
 */
const FOUR_SENTENCES=['alpha','beta','gamma','delta']
  .map(word=>`${Array.from({length:20},()=>word).join(' ')}.`);

it('renders the segments of one reply together instead of one after another',async()=>{
  const gate=segmentedSynthesizer();
  const t=await setup({replyAudio:gate.replyAudio,now:gate.now});
  try {
    const saved=(await t.call('sync_inspection',t.args)).structuredContent;
    const binding={sessionId:t.sessionId,serverEpoch:saved.serverEpoch,sourceToken:saved.sourceToken,
      baseStateRevision:saved.stateRevision,baseInspectionRevision:saved.inspectionRevision};
    const panelId=(await t.call('attach_inspection',{...binding,surface:'companion'})).structuredContent.panelId;
    const poll=()=>t.call('poll_inspection',{...binding,panelId,availability:'ready'});
    await poll();

    const saying=t.call('say_to_headset',{text:FOUR_SENTENCES.join(' ')});
    await gate.awaitStarted(3);
    // Three helper calls are open at once. Before this change the second could
    // not start until the first came back.
    expect(gate.started).toEqual(FOUR_SENTENCES.slice(0,3));
    expect(gate.pending()).toHaveLength(3);

    await gate.finish(FOUR_SENTENCES[0]!,'a',3,4_600);
    // The fourth starts as soon as a worker is free, not after all three.
    await gate.awaitStarted(4);
    expect(gate.started).toEqual(FOUR_SENTENCES);
    await gate.finish(FOUR_SENTENCES[1]!,'b',3,200);
    await gate.finish(FOUR_SENTENCES[2]!,'c',3,100);
    await gate.finish(FOUR_SENTENCES[3]!,'d',3,400);

    const said=await saying;
    expect(said.isError).not.toBe(true);
    // Four segments in 5.3 s of wall clock, against the 4.6 s the first one
    // cost on its own; one after another they would have cost four set-ups.
    expect(said.structuredContent).toMatchObject({queued:true,stale:false,
      segmentCount:4,audibleSegments:4,firstAudioMs:4_600,speechReadyMs:5_300});
    expect(said.structuredContent.segments.map((segment:any)=>segment.index)).toEqual([0,1,2,3]);
    expect(said.content[0].text).toContain('The first segment was playable at 4600 ms');
  } finally {await t.close();}
});

it('gives the wearer the opening of an answer before the rest of it has rendered',async()=>{
  const gate=segmentedSynthesizer();
  const t=await setup({replyAudio:gate.replyAudio,now:gate.now});
  try {
    const saved=(await t.call('sync_inspection',t.args)).structuredContent;
    const binding={sessionId:t.sessionId,serverEpoch:saved.serverEpoch,sourceToken:saved.sourceToken,
      baseStateRevision:saved.stateRevision,baseInspectionRevision:saved.inspectionRevision};
    const panelId=(await t.call('attach_inspection',{...binding,surface:'companion'})).structuredContent.panelId;
    const poll=()=>t.call('poll_inspection',{...binding,panelId,availability:'ready'});
    await poll();

    const saying=t.call('say_to_headset',{text:FOUR_SENTENCES.join(' ')});
    await gate.awaitStarted(3);
    await gate.finish(FOUR_SENTENCES[0]!,'a',3,4_600);
    // The opening is on the caption while three segments are still rendering,
    // so a page that beats now hears the answer start.
    const opening=(await poll())._meta[KEY].headsetCaption;
    expect(opening.segments.map((segment:any)=>segment.text)).toEqual([FOUR_SENTENCES[0]]);
    expect(opening.segments[0].audio).toEqual(gate.clip('a',3));
    expect(gate.pending()).toHaveLength(3);

    await gate.finish(FOUR_SENTENCES[1]!,'b',3,300);
    await gate.finish(FOUR_SENTENCES[2]!,'c',3,100);
    await gate.finish(FOUR_SENTENCES[3]!,'d',3,200);
    const said=await saying;

    // The page took the caption carrying one segment, so the spoken copy
    // carries the other three and never repeats the one already heard.
    expect(said.structuredContent).toMatchObject({spokenVia:'voice',firstAudioMs:4_600,
      segmentCount:4,audibleSegments:4});
    const rest=(await poll())._meta[KEY].headsetCaption;
    expect(rest.voiceFor).toBe(opening.id);
    expect(rest.id).toBe(said.structuredContent.voiceCaptionId);
    expect(rest.segments.map((segment:any)=>segment.text)).toEqual(FOUR_SENTENCES.slice(1));
    // Renumbered from zero, because a page plays an entry's segments in the
    // order that entry lists them.
    expect(rest.segments.map((segment:any)=>segment.index)).toEqual([0,1,2]);
    // Every word of the reply reached the wearer exactly once, in order.
    expect([...opening.segments,...rest.segments].map((segment:any)=>segment.text))
      .toEqual(FOUR_SENTENCES);
  } finally {await t.close();}
});

it('plays a reply in order and never sends a superseded reply the segments behind its first',async()=>{
  const gate=segmentedSynthesizer();
  const t=await setup({replyAudio:gate.replyAudio,now:gate.now});
  try {
    const saved=(await t.call('sync_inspection',t.args)).structuredContent;
    const binding={sessionId:t.sessionId,serverEpoch:saved.serverEpoch,sourceToken:saved.sourceToken,
      baseStateRevision:saved.stateRevision,baseInspectionRevision:saved.inspectionRevision};
    const panelId=(await t.call('attach_inspection',{...binding,surface:'companion'})).structuredContent.panelId;
    const poll=()=>t.call('poll_inspection',{...binding,panelId,availability:'ready'});
    await poll();

    const older=t.call('say_to_headset',{text:FOUR_SENTENCES.join(' ')});
    await gate.awaitStarted(3);
    expect(gate.started).toEqual(FOUR_SENTENCES.slice(0,3));

    // The wearer says something else. The older answer's fourth segment is
    // never sent to the helper, and none of it is ever spoken.
    const newer=t.call('say_to_headset',{text:'Newer answer.'});
    await gate.awaitStarted(4);
    await gate.finish(FOUR_SENTENCES[0]!,'a',3,4_600);
    await gate.finish(FOUR_SENTENCES[1]!,'b',3,100);
    await gate.finish(FOUR_SENTENCES[2]!,'c',3,100);
    expect(gate.started).not.toContain(FOUR_SENTENCES[3]);
    expect(gate.started).toContain('Newer answer.');

    const dropped=await older;
    expect(dropped.structuredContent).toMatchObject({queued:false,stale:true,spoken:false,
      audible:false,abandonedSegments:1});
    expect(dropped.content[0].text).toContain('A newer reply started before speech was ready');

    await gate.finish('Newer answer.','n',2,200);
    const said=await newer;
    expect(said.structuredContent).toMatchObject({queued:true,stale:false,text:'Newer answer.'});
    // The plate carries the newer answer, and no segment of the older one.
    const shown=(await poll())._meta[KEY].headsetCaption;
    expect(shown.text).toBe('Newer answer.');
    expect(shown.segments.map((segment:any)=>segment.text)).toEqual(['Newer answer.']);
  } finally {await t.close();}
});
