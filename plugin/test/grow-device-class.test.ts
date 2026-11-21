/**
 * Which device class holds a grow that names none.
 *
 * The headset page sends its own class with a grow the wearer asks for. A
 * grow the agent sends from the Mac carries no `device`, and the host used to
 * read that as `unknown`, which is not held to the Quest 2 ceiling: a tier
 * refused to a Quest 2 that asked for it opened on the same Quest 2 when the
 * Mac asked. These cases drive the real server with a two-tier synthetic demo
 * whose larger tier, like `tube`, lists only `quest3`.
 */
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStereoStructureServer } from '../src/server.js';
import { PRIVATE_INSPECTION_META_KEY as KEY } from '../src/inspection-contract.js';
import { decodeInspectionCatalog } from '../src/inspection-catalog-codec.js';
import { PANEL_BUSY_MESSAGE } from '../src/command-in-flight.js';

const cache=vi.hoisted(()=>({root:'',index:undefined as any,lesson:undefined as any}));
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

async function setup() {
  const root=await mkdtemp(join(tmpdir(),'grow-device-')); cache.root=join(root,'cache');
  stagedDemo();
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(cif)));
  const server=createStereoStructureServer(undefined,{sceneServiceFile:join(root,'scene.json')});
  const client=new Client({name:'grow device class',version:'1'});
  const [a,b]=InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
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
  const saved=(await call('sync_inspection',{...bind(initial),scene})).structuredContent;
  const desktop=(await call('attach_inspection',{...bind(saved),surface:'desktop'})).structuredContent.panelId;
  const headset=(await call('attach_inspection',{...bind(saved),surface:'companion'})).structuredContent.panelId;
  await call('replace_inspection_source',{sessionId,waitForRenderMs:0,demo:'grown-demo',stage:'small'});
  const loaded=await hydrate();
  expect(loaded.customTour.id).toBe('lesson-grown-demo-small');
  /** One heartbeat from a panel, carrying the XR session-start report a headset page sends. */
  const beat=async(panelId:string,deviceClass?:string)=>call('poll_inspection',{...bind(await hydrate()),panelId,availability:'busy',
    ...(deviceClass?{diagnostics:{entries:[{seq:1,at:1,kind:'session-start',detail:{deviceClass}}]}}:{})});
  /** One heartbeat carrying a page's own log entries. */
  const log=async(panelId:string,entries:any[])=>call('poll_inspection',{...bind(await hydrate()),panelId,availability:'busy',diagnostics:{entries}});
  /** The page closes and its panel goes. */
  const detach=async(panelId:string)=>call('detach_inspection',{...bind(await hydrate()),panelId});
  /** The page saves the new source and re-attaches under a new panel id, as it does after every grow. */
  const reattach=async(panelId:string)=>{
    const drawn={...scene,sourceSha256:loaded.catalog.source.sha256,modelNumber:loaded.catalog.modelNumbers[0],assemblyId:loaded.catalog.assemblyId};
    const synced=(await call('sync_inspection',{...bind(await hydrate()),scene:drawn})).structuredContent;
    return (await call('attach_inspection',{...bind(synced),surface:'companion',replacesPanelId:panelId})).structuredContent.panelId as string;
  };
  /** A grow from the Mac to the quest3-only tier, aimed at a panel that is not ready. */
  const grow=async(device?:string)=>raw('grow_structure',{...bind(await hydrate()),panelId:desktop,stage:'large',...(device?{device}:{})});
  return {beat,log,detach,reattach,grow,desktop,headset,close:async()=>{await client.close();await server.close();}};
}

/** The tier check passed: the grow went on to ask for a ready panel. */
function allowed(result:any) {
  expect(result.structuredContent?.grow?.refused).not.toBe(true);
  expect(JSON.stringify(result.content)).not.toContain(REFUSED);
  expect(result.content[0].text).toContain(PANEL_BUSY_MESSAGE);
}

describe('grow_structure without a device',()=>{
  it('is held to the Quest 2 tier a headset page in the session reports',async()=>{
    const t=await setup();
    try {
      await t.beat(t.desktop);
      await t.beat(t.headset,'quest2');
      const refused=await t.grow();
      expect(refused.isError).not.toBe(true);
      expect(refused.structuredContent.grow).toMatchObject({refused:true,from:'small',spoken:REFUSED,
        deviceTier:'quest2',deviceClass:'quest2',deviceFrom:'headset'});
      expect(refused.content[0].text).toContain('headset page reports');
    } finally {await t.close();}
  },30_000);

  it('keeps the reported Quest 2 after XR ends and across a re-attach, and drops it when the page goes',async()=>{
    const t=await setup();
    try {
      await t.log(t.headset,[{seq:1,at:1,kind:'session-start',detail:{deviceClass:'quest2'}},{seq:2,at:2,kind:'session-end',detail:{}}]);
      expect((await t.grow()).structuredContent.grow).toMatchObject({refused:true,deviceClass:'quest2',deviceFrom:'headset'});
      // The first re-attach after a source save keeps the id; the next issues a new one.
      let replacement=await t.reattach(t.headset);
      if(replacement===t.headset) replacement=await t.reattach(replacement);
      expect(replacement).not.toBe(t.headset);
      expect((await t.grow()).structuredContent.grow).toMatchObject({refused:true,deviceClass:'quest2',deviceFrom:'headset'});
      // A page that closed no longer holds the session once its panels go.
      await t.detach(replacement);
      await t.detach(t.headset);
      allowed(await t.grow());
    } finally {await t.close();}
  },30_000);

  it('keeps only known device classes from a page',async()=>{
    const t=await setup();
    try {
      for(let batch=0;batch<4;batch++)
        await t.log(t.headset,Array.from({length:24},(_,i)=>({seq:batch*24+i+1,at:1,kind:'session-start',
          detail:{deviceClass:i%2?`quest2-${batch}-${i}`:'x'.repeat(150)}})));
      const unheld=await t.grow();
      allowed(unheld);
      expect(unheld.content[0].text).not.toContain('quest2-');
      await t.log(t.headset,[{seq:200,at:2,kind:'session-start',detail:{deviceClass:'quest2'}}]);
      expect((await t.grow()).structuredContent.grow).toMatchObject({refused:true,deviceClass:'quest2',deviceFrom:'headset'});
    } finally {await t.close();}
  },30_000);

  it('is not held to it in a session with no headset page reporting a class',async()=>{
    const t=await setup();
    try {
      await t.beat(t.desktop);
      await t.beat(t.headset);
      allowed(await t.grow());
    } finally {await t.close();}
  },30_000);

  it('is not held to it when the headset page reports another class',async()=>{
    const t=await setup();
    try {
      await t.beat(t.headset,'quest3');
      allowed(await t.grow());
    } finally {await t.close();}
  },30_000);
});

describe('grow_structure with a device',()=>{
  it('keeps the class the caller names over the one the page reports',async()=>{
    const t=await setup();
    try {
      await t.beat(t.headset,'quest2');
      allowed(await t.grow('quest3'));
      const refused=await t.grow('quest2');
      expect(refused.structuredContent.grow).toMatchObject({refused:true,deviceTier:'quest2',deviceFrom:'caller'});
      expect(refused.content[0].text).not.toContain('headset page reports');
    } finally {await t.close();}
  },30_000);
});
