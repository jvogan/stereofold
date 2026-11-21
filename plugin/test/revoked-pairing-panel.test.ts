/**
 * A headset page whose private Wi-Fi pairing has ended.
 *
 * Revoking a paired client, or stopping the share, takes the page's bearer
 * away: it can no longer check in. Its panel used to stay registered until the
 * heartbeat grace ran out, three minutes for a page whose last beat was busy,
 * and for all that time the host went on answering for it. A grow sent from the
 * Mac was held to the Quest 2 class that page had reported, with the claim that
 * "this session's headset page reports" it, and the page was listed as the
 * wearer's own. These cases drive the real server, its real LAN listener and a
 * real pairing.
 */
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStereoStructureServer } from '../src/server.js';
import { listLanAddresses } from '../src/inspection-lan.js';
import { PRIVATE_INSPECTION_META_KEY as KEY } from '../src/inspection-contract.js';
import { decodeInspectionCatalog } from '../src/inspection-catalog-codec.js';
import { createReplyAudioSynthesizer } from '../src/headset-reply-audio.js';
import { PANEL_BUSY_MESSAGE } from '../src/command-in-flight.js';
import { VIEWER_BUILD_PLACEHOLDER } from '../src/viewer-build.js';

const cache=vi.hoisted(()=>({root:'',index:undefined as any,lesson:undefined as any}));
/**
 * The options the server hands its LAN listener, so a test can deliver an
 * answer the listener heard, and a gate between the listener dropping a
 * revoked client and the host acting on it, where other requests can run.
 */
const lanHooks=vi.hoisted(()=>({options:undefined as any,afterRevoke:undefined as undefined|(()=>Promise<void>)}));
vi.mock('../src/inspection-lan.js',async original=>{
  const real=await original<any>();
  class HeardLan extends real.LanCompanion {
    constructor(options:any) { super(options); lanHooks.options=options; }
    async revoke(clientId:string) {
      const revoked=await super.revoke(clientId), gate=lanHooks.afterRevoke;
      lanHooks.afterRevoke=undefined; await gate?.();
      return revoked;
    }
  }
  return {...real,LanCompanion:HeardLan};
});
vi.mock('../src/molecular-growth.js',async original=>({...await original<any>(),
  demoCoordinatePath:(file:string)=>join(cache.root,file),
  readGrowthIndex:async()=>cache.index??(await original<any>()).readGrowthIndex(),
}));
vi.mock('../src/inspection-scene-file.js',async original=>({...await original<any>(),
  readBoundedJsonFile:async(path:string)=>cache.lesson??(await original<any>()).readBoundedJsonFile(path),
}));
afterEach(()=>vi.unstubAllGlobals());

const cif=await readFile(new URL('../../fixtures/1CRN.cif',import.meta.url),'utf8');
const sha256=createHash('sha256').update(cif).digest('hex');
const REFUSED='Too big for this headset. Staying here.';

/** Two tiers of one fixture: `small` for every class, `large` for quest3 only. */
function stagedDemo() {
  cache.lesson={version:1,id:'grown-demo-small',title:'Grown demo',mode:'explore',
    provenance:{sourceSha256:sha256,sourceRefs:[{kind:'public',ref:'https://www.rcsb.org/structure/1CRN'}]},
    chapters:[{id:'opening',title:'Opening',caption:'Inspect the fixture.',durationSeconds:10,
      changes:[{kind:'scene',durationSeconds:10,scene:{background:'#071015'}}],immersive:{motion:'hold'}}]};
  const coordinates={file:'fixture.cif',sha256,bytes:Buffer.byteLength(cif),atomSites:327,download:'https://files.rcsb.org/download/1CRN.cif'};
  const stage=(id:string,order:string,tiers:string[])=>({id,order,title:`${id} tier`,pdbId:'1CRN',tiers,
    lesson:'daraxonrasib.json',coordinates,sources:[]});
  cache.index={version:1,cacheDirectory:'demos',demos:[{name:'grown-demo',title:'Grown demo',pdbId:'1CRN',
    lesson:'daraxonrasib.json',coordinates,sources:[],defaultStage:'small',
    stages:[stage('small','1',['quest2','quest3']),stage('large','2',['quest3'])]}]};
}

async function unusedPort(host:string) {
  const probe=createServer();
  await new Promise<void>((resolve,reject)=>{probe.once('error',reject);probe.listen(0,host,()=>resolve());});
  const address=probe.address(); if(!address||typeof address==='string') throw Error('LAN fixture did not bind');
  await new Promise<void>(resolve=>probe.close(()=>resolve()));
  return address.port;
}
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

/**
 * A session on the small tier, shared over private Wi-Fi, with one Quest 2
 * page paired over it. The page attached over that pairing, as a headset
 * page on Wi-Fi does, has entered XR (its session-start report names quest2)
 * and its last beat said busy, which is what earns a headset panel the
 * longest grace. With `rememberHeadset` the pairing remembers the headset, so
 * it can pair again without a code.
 */
async function pairedQuest2({rememberHeadset=false}={}) {
  const address=listLanAddresses()[0]; if(!address) return;
  const folder=await mkdtemp(join(tmpdir(),'revoked-pairing-'));
  const html=`<html><script>const build='${VIEWER_BUILD_PLACEHOLDER}';</script></html>`;
  const pageBuild=createHash('sha256').update(html,'utf8').digest('hex');
  await writeFile(join(folder,'inspector.html'),html.replace(VIEWER_BUILD_PLACEHOLDER,pageBuild));
  const home=process.env.HOME, remember=process.env.STEREOFOLD_LAN_REMEMBER;
  process.env.HOME=folder; process.env.STEREOFOLD_LAN_REMEMBER=rememberHeadset?'1':'0';
  cache.root=join(folder,'cache'); stagedDemo();
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(cif)));
  let clock=Date.now();
  const server=createStereoStructureServer(join(folder,'viewer.html'),{sceneServiceFile:join(folder,'scene.json'),now:()=>clock,
    replyAudio:createReplyAudioSynthesizer({enabled:false}),
    headsetDevice:{exists:async()=>false,run:async()=>{throw Error('No headset device in this test.');}}});
  const client=new Client({name:'revoked pairing',version:'1'});
  const [a,b]=InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  const close=async()=>{await client.close();await server.close();
    if(home===undefined)delete process.env.HOME;else process.env.HOME=home;
    if(remember===undefined)delete process.env.STEREOFOLD_LAN_REMEMBER;else process.env.STEREOFOLD_LAN_REMEMBER=remember;
    await rm(folder,{recursive:true,force:true});};
  try {
    const raw=(name:string,args:any)=>client.callTool({name:`stereo_structure.${name}`,arguments:args}) as Promise<any>;
    const call=async(name:string,args:any)=>{const r=await raw(name,args);expect(r.isError,JSON.stringify(r.content)).not.toBe(true);return r;};
    const sessionId=(await call('inspect',{structureText:cif})).structuredContent.sessionId;
    const hydrate=async()=>{const d=(await call('get_inspection',{sessionId}))._meta[KEY];
      return {...d,catalog:d.catalog??await decodeInspectionCatalog(d.catalogWire)};};
    const bind=(d:any)=>({sessionId,serverEpoch:d.serverEpoch,sourceToken:d.sourceToken,
      baseStateRevision:d.stateRevision,baseInspectionRevision:d.inspectionRevision});
    const initial=await hydrate();
    const scene:any={sourceSha256:initial.catalog.source.sha256,modelNumber:1,assemblyId:'asymmetric_unit',selectionKeys:[],
      camera:{mode:'perspective',fov:Math.PI/4,position:[0,0,80],up:[0,1,0],target:[0,0,0],radius:20,radiusMax:20,fog:50,clipFar:true,minNear:5,minFar:0},
      inspection:{appearance:{representation:'cartoon',color:'chain-id',uniformColor:'#44aaff',background:'#192734',opacity:1,labels:false,highlightColor:'#ffccee',clipping:0,fog:30},
        placement:{translation:[0,0,0],rotation:[0,0,0],scale:1}}};
    const first=(await call('sync_inspection',{...bind(initial),scene})).structuredContent;
    const desktop=(await call('attach_inspection',{...bind(first),surface:'desktop'})).structuredContent.panelId as string;
    await call('replace_inspection_source',{sessionId,waitForRenderMs:0,demo:'grown-demo',stage:'small'});
    const loaded=await hydrate();
    expect(loaded.customTour.id).toBe('lesson-grown-demo-small');
    const drawn={...scene,sourceSha256:loaded.catalog.source.sha256,modelNumber:loaded.catalog.modelNumbers[0],assemblyId:loaded.catalog.assemblyId};
    await call('sync_inspection',{...bind(loaded),scene:drawn});
    const options={sessionId,connection:'lan',lanHost:address.address,lanPort:await unusedPort(address.address)};
    const opened=await call('open_companion',{...options,launch:'none',headset:'auto'});
    const QUEST2='Mozilla/5.0 (X11; Linux x86_64; Quest 2) OculusBrowser/35.0 Chrome/126.0 VR Safari/537.36';
    const paired=await lanRequest(address.address,options.lanPort,'/pair',{code:opened.structuredContent.companion.pairingCode,
      ...(rememberHeadset?{remember:true}:{})},undefined,QUEST2);
    expect(paired.status).toBe(200);
    /** A page attaching over a pairing, as a headset page on Wi-Fi does: the Mac issues it a panel. */
    const lanAttach=async(token:string)=>{
      const attached=await lanRequest(address.address,options.lanPort,'/tool',
        {name:'attach_inspection',args:{...bind(await hydrate()),surface:'companion',pageBuild}},token);
      expect(attached.status,JSON.stringify(attached.body)).toBe(200);
      return attached.body.structuredContent.panelId as string;
    };
    const headset=await lanAttach(paired.body.token);
    /** One heartbeat over a pairing, naming the page's panel unless `extra` names another. */
    const beatOver=async(token:string,extra:Record<string,unknown>={})=>lanRequest(address.address,options.lanPort,'/tool',{name:'poll_inspection',
      args:{...bind(await hydrate()),panelId:headset,availability:'busy',pageBuild,...extra}},token);
    /** One heartbeat from the paired page, over its own pairing. */
    const lanBeat=async(extra:Record<string,unknown>={})=>beatOver(paired.body.token,extra);
    expect((await lanBeat({diagnostics:{entries:[{seq:1,at:1,kind:'session-start',detail:{deviceClass:'quest2'}}]}})).status).toBe(200);
    await call('poll_inspection',{...bind(await hydrate()),panelId:desktop,availability:'busy'});
    /** A grow from the Mac to the quest3-only tier, aimed at a panel that is not ready. */
    const grow=async()=>raw('grow_structure',{...bind(await hydrate()),panelId:desktop,stage:'large'});
    const state=async()=>(await call('get_inspection_state',{sessionId})).structuredContent;
    const clientId=paired.body.clientId as string;
    /** A second page pairs as another headset and beats with whatever panel id it names. */
    const pairAnother=async()=>{
      const again=await call('open_companion',{...options,launch:'none',headset:'auto'});
      const other=await lanRequest(address.address,options.lanPort,'/pair',{code:again.structuredContent.companion.pairingCode},
        undefined,'Mozilla/5.0 (X11; Linux x86_64; Quest 3) OculusBrowser/35.0 Chrome/126.0 VR Safari/537.36');
      expect(other.status).toBe(200);
      return {clientId:other.body.clientId as string,token:other.body.token as string,
        beat:async(panelId:string)=>beatOver(other.body.token,{panelId})};
    };
    /** The remembered headset pairs again with its device key, as a second tab on it does. */
    const pairAgain=async()=>{
      const again=await lanRequest(address.address,options.lanPort,'/pair',{deviceId:paired.body.deviceId,deviceKey:paired.body.deviceKey},undefined,QUEST2);
      expect(again.status).toBe(200);
      expect(again.body.deviceId).toBe(paired.body.deviceId);
      return {clientId:again.body.clientId as string,token:again.body.token as string};
    };
    /** The share opened again on another port: a new listener, so every pairing on the old one ends. */
    const reopenElsewhere=async()=>call('open_companion',{...options,lanPort:await unusedPort(address.address),launch:'none',headset:'auto'});
    /** The ids of the headset pages the Mac lists. */
    const companions=async()=>(await state()).panels.filter((panel:any)=>panel.surface==='companion').map((panel:any)=>panel.panelId);
    return {call,raw,bind,hydrate,grow,state,companions,lanBeat,beatOver,lanAttach,headset,desktop,sessionId,clientId,token:paired.body.token as string,
      deviceId:paired.body.deviceId as string|undefined,
      close,pairAnother,pairAgain,reopenElsewhere,advance:(ms:number)=>{clock+=ms;}};
  } catch(error) { await close(); throw error; }
}

/** The tier check passed: the grow went on to ask for a ready panel. */
function notHeld(result:any) {
  expect(result.structuredContent?.grow?.refused,JSON.stringify(result.content)).not.toBe(true);
  expect(JSON.stringify(result.content)).not.toContain(REFUSED);
  expect(result.content[0].text).toContain(PANEL_BUSY_MESSAGE);
}

describe('a headset page whose private Wi-Fi pairing ended',()=>{
  it('no longer holds a grow from the Mac once its pairing is revoked',async()=>{
    const t=await pairedQuest2();if(!t)return;
    try {
      // While paired, the page's reported class holds a grow that names no device.
      expect((await t.grow()).structuredContent.grow).toMatchObject({refused:true,deviceClass:'quest2',deviceFrom:'headset'});
      await t.call('manage_companion',{sessionId:t.sessionId,action:'revoke',clientId:t.clientId});
      // The page cannot check in any more.
      expect((await t.lanBeat()).status).toBe(401);
      notHeld(await t.grow());
      const state=await t.state();
      expect(state.panels.map((panel:any)=>panel.surface)).not.toContain('companion');
      // The agent reads why the page went and what to do, rather than waiting on a paused wearer.
      expect(state.reclaimedPanels).toContainEqual(expect.objectContaining({panelId:t.headset,
        reason:expect.stringContaining('open_companion')}));
      expect(state.wearer.state).not.toBe('paused');
    } finally {await t.close();}
  },30_000);

  it('no longer holds a grow from the Mac once sharing is stopped',async()=>{
    const t=await pairedQuest2();if(!t)return;
    try {
      await t.call('manage_companion',{sessionId:t.sessionId,action:'close'});
      notHeld(await t.grow());
      expect((await t.state()).panels.map((panel:any)=>panel.surface)).not.toContain('companion');
    } finally {await t.close();}
  },30_000);

  it('stops waiting for a page already dropped for silence once its pairing is revoked',async()=>{
    const t=await pairedQuest2();if(!t)return;
    try {
      // Past the busy page's grace the host drops the panel but remembers a silent wearer.
      t.advance(181_000);
      expect((await t.state()).wearer.state).toBe('unknown');
      await t.call('manage_companion',{sessionId:t.sessionId,action:'revoke',clientId:t.clientId});
      expect((await t.state()).wearer.state).toBe('no-page');
    } finally {await t.close();}
  },30_000);

  it('keeps a page whose panel another paired page names, when that other pairing is revoked',async()=>{
    const t=await pairedQuest2();if(!t)return;
    try {
      const other=await t.pairAnother();
      expect((await other.beat(t.headset)).status).toBe(200);
      for(let n=0;n<20;n++) await other.beat(`made-up-${n}`);
      await t.call('manage_companion',{sessionId:t.sessionId,action:'revoke',clientId:other.clientId});
      expect((await t.state()).panels.filter((panel:any)=>panel.surface==='companion').map((panel:any)=>panel.panelId)).toEqual([t.headset]);
      expect((await t.grow()).structuredContent.grow).toMatchObject({refused:true,deviceClass:'quest2',deviceFrom:'headset'});
      // Its own pairing still retires it.
      await t.call('manage_companion',{sessionId:t.sessionId,action:'revoke',clientId:t.clientId});
      expect((await t.state()).panels.map((panel:any)=>panel.surface)).not.toContain('companion');
    } finally {await t.close();}
  },30_000);

  it('keeps a headset page that is not on the revoked pairing',async()=>{
    const t=await pairedQuest2();if(!t)return;
    try {
      // A second Quest 2 page on the cable route has no Wi-Fi pairing to lose.
      const cable=(await t.call('attach_inspection',{...t.bind(await t.hydrate()),surface:'companion'})).structuredContent.panelId as string;
      await t.call('poll_inspection',{...t.bind(await t.hydrate()),panelId:cable,availability:'busy',
        diagnostics:{entries:[{seq:1,at:1,kind:'session-start',detail:{deviceClass:'quest2'}}]}});
      await t.call('manage_companion',{sessionId:t.sessionId,action:'revoke',clientId:t.clientId});
      expect((await t.grow()).structuredContent.grow).toMatchObject({refused:true,deviceClass:'quest2',deviceFrom:'headset'});
      const companions=(await t.state()).panels.filter((panel:any)=>panel.surface==='companion').map((panel:any)=>panel.panelId);
      expect(companions).toEqual([cable]);
    } finally {await t.close();}
  },30_000);

  it('keeps a cable headset page that a paired page names, when that pairing is revoked',async()=>{
    const t=await pairedQuest2();if(!t)return;
    try {
      // A page on the cable route registered over loopback: it has no Wi-Fi pairing to lose.
      const cable=(await t.call('attach_inspection',{...t.bind(await t.hydrate()),surface:'companion'})).structuredContent.panelId as string;
      await t.call('poll_inspection',{...t.bind(await t.hydrate()),panelId:cable,availability:'busy'});
      // The paired page names it on a beat the Mac answers.
      expect((await t.lanBeat({panelId:cable})).status).toBe(200);
      await t.call('manage_companion',{sessionId:t.sessionId,action:'revoke',clientId:t.clientId});
      expect(await t.companions()).toEqual([cable]);
    } finally {await t.close();}
  },30_000);

  it('keeps a new page with the pairing it opened on, when another paired page names it first',async()=>{
    const t=await pairedQuest2();if(!t)return;
    try {
      const other=await t.pairAnother();
      // A second page opens over the first pairing, and the other pairing names
      // its panel before that page has beaten once.
      const fresh=await t.lanAttach(t.token);
      expect((await other.beat(fresh)).status).toBe(200);
      expect((await t.lanBeat({panelId:fresh})).status).toBe(200);
      await t.call('manage_companion',{sessionId:t.sessionId,action:'revoke',clientId:other.clientId});
      expect((await t.companions()).sort()).toEqual([t.headset,fresh].sort());
      // Its own pairing still retires it.
      await t.call('manage_companion',{sessionId:t.sessionId,action:'revoke',clientId:t.clientId});
      expect(await t.companions()).toEqual([]);
    } finally {await t.close();}
  },30_000);

  it('leaves a panel on its pairing when the Mac refuses a beat that names it from another pairing of the same headset',async()=>{
    const t=await pairedQuest2({rememberHeadset:true});if(!t)return;
    try {
      const tab=await t.pairAgain();
      const refused=await t.beatOver(tab.token,{availability:'not-a-state'});
      expect(refused.status).not.toBe(200);
      await t.call('manage_companion',{sessionId:t.sessionId,action:'revoke',clientId:tab.clientId});
      expect(await t.companions()).toEqual([t.headset]);
      await t.call('manage_companion',{sessionId:t.sessionId,action:'revoke',clientId:t.clientId});
      expect(await t.companions()).toEqual([]);
    } finally {await t.close();}
  },30_000);

  it('follows a remembered headset that pairs again to the panel it is still beating',async()=>{
    const t=await pairedQuest2({rememberHeadset:true});if(!t)return;
    try {
      // The first pairing goes idle, so pairing again with the device key replaces it.
      t.advance(61_000);
      const again=await t.pairAgain();
      expect((await t.beatOver(again.token)).status).toBe(200);
      await t.call('manage_companion',{sessionId:t.sessionId,action:'revoke',clientId:again.clientId});
      expect(await t.companions()).toEqual([]);
    } finally {await t.close();}
  },30_000);

  it('retires a page whose pairing ended while the Mac was answering its attach',async()=>{
    const t=await pairedQuest2();if(!t)return;
    try {
      // The Mac issues a panel to the paired page's attach, and the pairing is
      // revoked before the listener hears that answer.
      const late=(await t.call('attach_inspection',{...t.bind(await t.hydrate()),surface:'companion'})).structuredContent.panelId as string;
      await t.call('manage_companion',{sessionId:t.sessionId,action:'revoke',clientId:t.clientId});
      expect(await t.companions()).toEqual([late]);
      // An answer that kept, for some other ended pairing, a panel that pairing never opened retires nothing.
      await lanHooks.options.onPanelOpened({id:'another-pairing'},late,late);
      expect(await t.companions()).toEqual([late]);
      await lanHooks.options.onPanelOpened({id:t.clientId},late);
      expect(await t.companions()).toEqual([]);
      expect((await t.state()).reclaimedPanels).toContainEqual(expect.objectContaining({panelId:late,
        reason:expect.stringContaining('open_companion')}));
    } finally {await t.close();}
  },30_000);

  it('keeps a panel another pairing of the same headset now holds, when a late answer comes for its ended opener',async()=>{
    const t=await pairedQuest2({rememberHeadset:true});if(!t)return;
    try {
      // A second tab on the headset beats the page's panel, so it holds it now.
      const tab=await t.pairAgain();
      expect((await t.beatOver(tab.token)).status).toBe(200);
      await t.call('manage_companion',{sessionId:t.sessionId,action:'revoke',clientId:t.clientId});
      expect(await t.companions()).toEqual([t.headset]);
      // The opener's attach that kept the panel is answered only now.
      await lanHooks.options.onPanelOpened({id:t.clientId,deviceId:t.deviceId},t.headset,t.headset);
      expect(await t.companions()).toEqual([t.headset]);
      await t.call('manage_companion',{sessionId:t.sessionId,action:'revoke',clientId:tab.clientId});
      expect(await t.companions()).toEqual([]);
    } finally {await t.close();}
  },30_000);

  it('no longer lists a page once the share is opened again on another port',async()=>{
    const t=await pairedQuest2();if(!t)return;
    try {
      await t.reopenElsewhere();
      // The old listener is gone, so the page cannot check in.
      await expect(t.lanBeat()).rejects.toThrow();
      expect(await t.companions()).toEqual([]);
    } finally {await t.close();}
  },30_000);

  it('retires a revoked page when another request reads the share while the revoke lands',async()=>{
    const t=await pairedQuest2();if(!t)return;
    try {
      // The listener has dropped the client, and a state read runs before the host retires anything.
      lanHooks.afterRevoke=async()=>{ await t.state(); };
      await t.call('manage_companion',{sessionId:t.sessionId,action:'revoke',clientId:t.clientId});
      expect(await t.companions()).toEqual([]);
    } finally {lanHooks.afterRevoke=undefined;await t.close();}
  },30_000);

  // A beat from another pairing of the same headset moves the panel before
  // the Mac answers it. These hold that answer by calling the server's own
  // beat hook, as the listener does, and settling it later.
  it('retires a panel whose holder was revoked while another pairing of the headset had a beat for it unanswered, once the Mac refuses that beat',async()=>{
    const t=await pairedQuest2({rememberHeadset:true});if(!t)return;
    try {
      const tab=await t.pairAgain();
      const answered=lanHooks.options.onPanelHeartbeat(tab.clientId,t.headset);
      expect(answered).toBeTypeOf('function');
      await t.call('manage_companion',{sessionId:t.sessionId,action:'revoke',clientId:t.clientId});
      await answered(409);
      expect(await t.companions()).toEqual([]);
    } finally {await t.close();}
  },30_000);

  it('leaves a panel with its live holder when another pairing of the headset is revoked with a beat for it unanswered',async()=>{
    const t=await pairedQuest2({rememberHeadset:true});if(!t)return;
    try {
      const tab=await t.pairAgain();
      const answered=lanHooks.options.onPanelHeartbeat(tab.clientId,t.headset);
      await t.call('manage_companion',{sessionId:t.sessionId,action:'revoke',clientId:tab.clientId});
      expect(await t.companions()).toEqual([t.headset]);
      await answered(200);
      // The opener still holds it, so its own revoke retires it.
      await t.call('manage_companion',{sessionId:t.sessionId,action:'revoke',clientId:t.clientId});
      expect(await t.companions()).toEqual([]);
    } finally {await t.close();}
  },30_000);
});
