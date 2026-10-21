import { readFile, mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createStereoStructureServer } from '../src/server.js';
import { PRIVATE_INSPECTION_META_KEY as KEY, expectedInspection } from '../src/inspection-contract.js';
// @ts-ignore Shared canonical selection signature.
import { selectionSignature } from '../../lab/browser-roundtrip/selection-paint.mjs';
import { addressedDemoFile } from '../src/addressed-demo-cache.js';
import * as catalogExtractor from '../src/inspection-catalog.js';
import { SourceRenderWait } from '../src/source-render-wait.js';
import { decodeInspectionCatalog } from '../src/inspection-catalog-codec.js';

const cache=vi.hoisted(()=>({root:'',index:undefined as any,lesson:undefined as any}));
vi.mock('../src/molecular-growth.js',async original=>({...await original<any>(),
  demoCoordinatePath:(file:string)=>join(cache.root,file),
  readGrowthIndex:async()=>cache.index??(await original<any>()).readGrowthIndex(),
}));
vi.mock('../src/inspection-scene-file.js',async original=>({...await original<any>(),
  readBoundedJsonFile:async(path:string)=>cache.lesson??(await original<any>()).readBoundedJsonFile(path),
}));
beforeEach(()=>{cache.index=undefined;cache.lesson=undefined;});
afterEach(()=>vi.unstubAllGlobals());
const demosRoot=new URL('../demos/',import.meta.url).pathname;
const index=JSON.parse(await readFile(join(demosRoot,'index.json'),'utf8'));
const cif=await readFile(new URL('../../fixtures/1CRN.cif',import.meta.url),'utf8');
const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
function syntheticDemo() {
  const sha256=digest(cif);
  cache.lesson={version:1,id:'synthetic-demo',title:'Synthetic demo',mode:'explore',
    provenance:{sourceSha256:sha256,sourceRefs:[{kind:'public',ref:'https://www.rcsb.org/structure/1CRN'}]},
    chapters:[{id:'opening',title:'Opening',caption:'Inspect the fixture.',durationSeconds:10,
      changes:[{kind:'scene',durationSeconds:10,scene:{background:'#071015'}}],immersive:{motion:'hold'}}]};
  const demo={name:'synthetic-demo',lesson:'daraxonrasib.json',pdbId:'1CRN',
    coordinates:{file:'fixture.cif',sha256,bytes:Buffer.byteLength(cif),atomSites:327,download:'https://files.rcsb.org/download/1CRN.cif'}};
  cache.index={version:1,demos:[demo]};return demo;
}


async function setup() {
  const root=await mkdtemp(join(tmpdir(),'demo-session-')); cache.root=join(root,'cache');
  const server=createStereoStructureServer(undefined,{sceneServiceFile:join(root,'scene.json')});
  const client=new Client({name:'demo session regression',version:'1'});
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
      placement:{translation:[.5,0,0],rotation:[0,30,0],scale:1.2}}};
  const saved=(await call('sync_inspection',{...bind(initial),scene})).structuredContent;
  const panelId=(await call('attach_inspection',{...bind(saved),surface:'companion'})).structuredContent.panelId;
  const warm=async(coordinates:any)=>{
    const file=addressedDemoFile(coordinates.file,coordinates.sha256);
    const bytes=await readFile(join(homedir(),'Library/Caches/Stereofold/demos',file));
    await mkdir(cache.root,{recursive:true});await writeFile(join(cache.root,file),bytes);
  };
  return {raw,call,tools:()=>client.listTools(),sessionId,hydrate,bind,scene,panelId,warm,root,close:async()=>{await client.close();await server.close();}};
}

for(const [name,stage] of [['daraxonrasib',undefined],['microtubule-growth','monomer'],
  ['kinesin-walk',undefined],['atp-synthase-rotor','motion'],['hemoglobin-switch','motion']] as const) {
  const demo=index.demos.find((d:any)=>d.name===name),entry=stage?demo.stages.find((s:any)=>s.id===stage):demo;
  const isMotion=(stage??demo.defaultStage)==='motion';
  const available=await readFile(join(homedir(),'Library/Caches/Stereofold/demos',addressedDemoFile(entry.coordinates.file,entry.coordinates.sha256))).then(()=>true,()=>false);
  it.skipIf(!available)(`loads ${name}/${stage??'default'} and its complete lesson in the joined session`,async()=>{
    const t=await setup();try {
      await t.warm(entry.coordinates);
      const r=await t.call('replace_inspection_source',{sessionId:t.sessionId,waitForRenderMs:0,demo:name,...(stage?{stage}:{})});
      expect(r.structuredContent).toMatchObject({sessionId:t.sessionId,sourceTransition:{sourceChanged:true},customTourId:expect.any(String)});
      expect(r.structuredContent.sourceRenderStatus.rendered).toBe(false);
      const d=await t.hydrate(),manifest=JSON.parse(await readFile(join(demosRoot,entry.lesson),'utf8'));
      expect(d.catalog.source.sha256).toBe(entry.coordinates.sha256);
      expect(d.customTour.id).toBe(`lesson-${manifest.id}`);
      expect(d.lessonStart).toEqual({autoplay:false,narration:false});
      expect(d.customTour.steps).toHaveLength(manifest.chapters.length);
      if(isMotion)expect(d.customTour.steps[0].animation).toEqual(manifest.chapters[0].animation);
      const beat=await t.call('poll_inspection',{...t.bind(d),sourceToken:r.structuredContent.sourceToken,panelId:t.panelId,availability:'ready'});
      expect(beat._meta[KEY].transitionTarget).toBe(true);
      const nextScene:any={...t.scene,sourceSha256:d.catalog.source.sha256,modelNumber:d.catalog.modelNumbers[0],assemblyId:d.catalog.assemblyId};
      if(isMotion) {
        const definition=manifest.chapters.find((chapter:any)=>chapter.animation).animation;
        nextScene.inspection={...nextScene.inspection,animation:{definition,playback:{id:'test',chapterId:manifest.chapters[0].id,
          state:'playing',timeSeconds:1,durationSeconds:definition.durationSeconds,loop:true,speed:1}},lessonFigureAnimation:definition};
      }
      if(name==='atp-synthase-rotor') {
        nextScene.selectionKeys=d.catalog.rows.map((row:any)=>row.key);
        nextScene.inspection={...nextScene.inspection,lessonSelection:selectionSignature(nextScene.selectionKeys)};
        expect(nextScene.inspection.lessonSelection.length).toBeGreaterThan(100000);
      }
      const saved=(await t.call('sync_inspection',{...t.bind(d),scene:nextScene})).structuredContent;
      const attached=(await t.call('attach_inspection',{...t.bind(saved),surface:'companion',replacesPanelId:t.panelId})).structuredContent;
      const state=(await t.call('get_inspection_state',{sessionId:t.sessionId})).structuredContent;
      expect(state.sourceRenderReceipt).toMatchObject({rendered:true,panelId:attached.panelId,sourceToken:d.sourceToken});
      expect(JSON.stringify(state.view).length).toBeLessThan(6000);
      if(isMotion) {
        expect(state.view.animation).toMatchObject({trackCount:manifest.chapters.find((chapter:any)=>chapter.animation).animation.tracks.length,playback:{state:'playing'}});
        expect(state.view.animation.definition).toBeUndefined();
        const full=(await t.call('get_inspection_state',{sessionId:t.sessionId,includeViewDetails:true})).structuredContent;
        expect(full.view.animation.definition).toEqual(manifest.chapters.find((chapter:any)=>chapter.animation).animation);
        expect(full.view.lessonFigureAnimation).toEqual(manifest.chapters.find((chapter:any)=>chapter.animation).animation);
      }
      if(name==='atp-synthase-rotor') {
        const chains=[...new Set(d.catalog.rows.map((row:any)=>row.identity.labelChain))].slice(0,2);
        const changed=await t.call('update_inspection',{sessionId:t.sessionId,change:{kind:'compound',patch:{ops:chains.map((chain,i)=>({
          kind:'appearance',residues:{labelChain:chain},patch:{color:'uniform',uniformColor:i?'#0088ff':'#ff8800'},
        }))}}});
        const delivery=(await t.call('poll_inspection',{...t.bind(saved),panelId:attached.panelId,availability:'ready'}))._meta[KEY].delivery;
        const recoloured=expectedInspection(nextScene,delivery.change);
        await t.call('complete_inspection',{...t.bind(saved),panelId:attached.panelId,commandId:changed.structuredContent.command.commandId,
          claimToken:delivery.claimToken,scene:recoloured});
        const poll=await t.call('get_inspection_state',{sessionId:t.sessionId});
        expect(poll.structuredContent.view.styles).toHaveLength(2);
        expect(poll.structuredContent.view.lessonSelection).toEqual({residueCount:nextScene.selectionKeys.length});
        expect(JSON.stringify(poll).length).toBeLessThan(50000);
        console.log(`Recoloured ATP poll: ${JSON.stringify(poll).length} chars; view ${JSON.stringify(poll.structuredContent.view).length} chars.`);
      }
      if(name==='microtubule-growth') {
        const next=demo.stages.find((s:any)=>s.id==='dimer');await t.warm(next.coordinates);
        const grown=await t.call('grow_structure',{...t.bind(saved),panelId:attached.panelId,stage:'next',device:'quest2'});
        expect(grown.structuredContent.grow).toMatchObject({from:'monomer',to:'dimer',refused:false});
      }
    } finally {await t.close();}
  },60000);
}

it('fetches a missing demo under the existing digest policy and leaves the session intact on mismatch',async()=>{
  const t=await setup();try {
    const fetcher=vi.fn(async()=>({ok:true,text:async()=>cif}));vi.stubGlobal('fetch',fetcher);
    const before=await t.hydrate();
    const failed=await t.raw('replace_inspection_source',{sessionId:t.sessionId,waitForRenderMs:0,demo:'daraxonrasib'});
    expect(fetcher).toHaveBeenCalledOnce();expect(failed.isError).toBe(true);
    expect(failed.content[0].text).toMatch(/no longer serves/);
    expect((await t.hydrate()).sourceToken).toBe(before.sourceToken);
  } finally {await t.close();}
});

it('accepts a bundled lessonPath without inlining and refuses outside, traversal, symlink and ambiguous paths',async()=>{
  const t=await setup();try {
    const demo=syntheticDemo();
    const accepted=await t.call('install_lesson',{sessionId:t.sessionId,lessonPath:join(demosRoot,demo.lesson)});
    expect(accepted.structuredContent.command.status).toBe('queued');
    const outside=join(t.root,'outside.json');await writeFile(outside,JSON.stringify({version:1}));
    const link=join(t.root,'link');await symlink(demosRoot,link);
    for(const lessonPath of [outside,join(demosRoot,'../../package.json'),join(link,demo.lesson)]) {
      const bad=await t.raw('install_lesson',{sessionId:t.sessionId,lessonPath});
      expect(bad.isError).toBe(true);expect(bad.content[0].text).toMatch(/bundled demos/);
    }
    const both=await t.raw('install_lesson',{sessionId:t.sessionId,lessonPath:join(demosRoot,demo.lesson),lesson:cache.lesson});
    expect(both.isError).toBe(true);
  } finally {await t.close();}
},60000);

it('keeps a residue-selection signature out of routine polling and returns exact view details on request',async()=>{
  const t=await setup();try {
    const d=await t.hydrate(),keys=d.catalog.rows.map((r:any)=>r.key).sort();
    const scene={...t.scene,selectionKeys:keys,inspection:{...t.scene.inspection,
      styles:[{selectionKeys:keys,color:'uniform',uniformColor:'#ff8800'}],lessonSelection:selectionSignature(keys)}};
    await t.call('sync_inspection',{...t.bind(d),scene});
    const routine=await t.call('get_inspection_state',{sessionId:t.sessionId});
    expect(routine.structuredContent.view.lessonSelection).toEqual({residueCount:keys.length});
    expect(routine.structuredContent.view.styles[0]).toMatchObject({residueCount:keys.length});
    expect(JSON.stringify(routine)).not.toContain(keys[0]);
    const full=await t.call('get_inspection_state',{sessionId:t.sessionId,includeViewDetails:true});
    expect(full.structuredContent.view.styles).toEqual(scene.inspection.styles);
    expect(full.structuredContent.view.lessonSelection).toBe(scene.inspection.lessonSelection);
    expect((await t.hydrate()).scene).toEqual(scene);
  } finally {await t.close();}
});

it('advertises the single-call joined demo route in tool descriptions and canonical skills',async()=>{
  const t=await setup();try {
    const {tools}=await t.tools();
    for(const name of ['replace_inspection_source','install_lesson','inspect_lesson','continue_session']) {
      expect(tools.find(tool=>tool.name===`stereo_structure.${name}`)!.description!.includes('demo:"atp-synthase-rotor",stage:"motion"'),name).toBe(true);
      expect(tools.find(tool=>tool.name===`stereo_structure.${name}`)!.description!).toContain('still drawing');
    }
    for(const skill of ['stereo-structure','stereofold-setup','molecular-presentation']) {
      const text=await readFile(new URL(`../skills/${skill}/SKILL.md`,import.meta.url),'utf8');
      expect(text.includes('demo:"atp-synthase-rotor",stage:"motion"'),skill).toBe(true);
      expect(text.includes('includeViewDetails:true'),skill).toBe(true);
      expect(text.includes('waitForRenderMs:40000'),skill).toBe(true);
      expect(text.includes('still drawing'),skill).toBe(true);
    }
  } finally {await t.close();}
});

for(const corrupt of [false,true]) it(`loads a ${corrupt?'corrupt':'missing'} cached demo in one call after a verified fetch`,async()=>{
  const t=await setup();try {
    const demo=syntheticDemo(),file=join(cache.root,addressedDemoFile(demo.coordinates.file,demo.coordinates.sha256));
    if(corrupt){await mkdir(dirname(file),{recursive:true});await writeFile(file,'corrupt cache');}
    const fetcher=vi.fn(async()=>({ok:true,text:async()=>cif}));vi.stubGlobal('fetch',fetcher);
    const before=await t.hydrate();
    const loaded=await t.call('replace_inspection_source',{sessionId:t.sessionId,waitForRenderMs:0,demo:demo.name});
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(demo.coordinates.download,expect.any(Object));
    expect(await readFile(file,'utf8')).toBe(cif);
    const d=await t.hydrate();expect(d.sourceToken).not.toBe(before.sourceToken);
    expect(d.customTour.id).toBe('lesson-synthetic-demo');expect(d.lessonStart).toEqual({autoplay:false,narration:false});
    expect(loaded.structuredContent.sourceRenderStatus.rendered).toBe(false);
    // The first save removes the transient start intent from future hydration.
    await t.call('sync_inspection',{...t.bind(d),scene:t.scene});
    expect((await t.hydrate()).lessonStart).toBeUndefined();
  } finally {await t.close();}
});

it('rejects unknown names/stages and mixed demo sources before changing the session',async()=>{
  const t=await setup();try {
    const before=await t.hydrate();
    for(const args of [{demo:'../outside'},{demo:'daraxonrasib',stage:'absent'},
      {demo:'microtubule-growth',stage:'absent'},{stage:'motion',pdbId:'1CRN'},
      {demo:'daraxonrasib',pdbId:'1CRN'},{demo:'daraxonrasib',mode:'compare'},
      {demo:'daraxonrasib',assemblyId:'2'}]) {
      const r=await t.raw('replace_inspection_source',{sessionId:t.sessionId,...args});
      expect(r.isError,JSON.stringify(args)).toBe(true);
      expect((await t.hydrate()).sourceToken).toBe(before.sourceToken);
    }
  } finally {await t.close();}
});


it('returns a pollable still-drawing receipt when a demo outlasts the requested wait',async()=>{
  const t=await setup();try {
    const demo=syntheticDemo();
    vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,text:async()=>cif})));
    const loaded=await t.call('replace_inspection_source',{sessionId:t.sessionId,demo:demo.name,waitForRenderMs:1});
    const answer=loaded.structuredContent;
    expect(answer.sourceRenderStatus).toMatchObject({status:'rendering',rendered:false,commandId:answer.commandId});
    expect(answer.renderWait).toMatchObject({timedOut:false,pending:true,waitExpired:true});
    expect(loaded.content[0].text).toMatch(/still drawing/i);
    expect(loaded.content[0].text).not.toMatch(/timed out|failed/i);
    expect(answer.sourceRenderStatus.poll).toEqual({tool:'get_inspection_state',arguments:{sessionId:t.sessionId,commandId:answer.commandId}});
    const d=await t.hydrate();
    const saved=(await t.call('sync_inspection',{...t.bind(d),scene:t.scene})).structuredContent;
    await t.call('attach_inspection',{...t.bind(saved),surface:'companion',replacesPanelId:t.panelId});
    const polled=(await t.call('get_inspection_state',{sessionId:t.sessionId,commandId:answer.commandId})).structuredContent;
    expect(polled.sourceRenderReceipt).toMatchObject({status:'rendered',rendered:true,commandId:answer.commandId,sourceToken:answer.sourceToken});
  } finally {await t.close();}
});

it('waits for a bundled demo by default within the host call and source budgets',async()=>{
  const t=await setup();const wait=vi.spyOn(SourceRenderWait.prototype,'wait').mockResolvedValue(undefined);
  try {
    const demo=syntheticDemo();
    vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,text:async()=>cif})));
    const loaded=await t.call('replace_inspection_source',{sessionId:t.sessionId,demo:demo.name});
    const answer=loaded.structuredContent;
    expect(answer.renderWait.askedMs).toBe(40000);
    expect(wait).toHaveBeenCalledWith(Math.min(40000,answer.renderWait.budgetMs));
    expect(answer.sourceRenderStatus.status).toBe('rendering');
    expect(answer.sourceRenderStatus.rendered).toBe(false);
  } finally {wait.mockRestore();await t.close();}
});


it('reuses the exact verified source catalog when committing a demo',async()=>{
  const t=await setup();const extract=vi.spyOn(catalogExtractor,'extractInspectionCatalogBytes');
  try {
    const demo=syntheticDemo();
    vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,text:async()=>cif})));
    const loaded=await t.call('replace_inspection_source',{sessionId:t.sessionId,demo:demo.name,waitForRenderMs:0});
    const d=await t.hydrate();
    expect(extract).toHaveBeenCalledTimes(1);
    expect(d.catalog.source.sha256).toBe(demo.coordinates.sha256);
    expect(d.sourceToken).toBe(loaded.structuredContent.sourceToken);
  } finally {extract.mockRestore();await t.close();}
});


it('retains an actual renderer failure instead of calling it still drawing',async()=>{
  const t=await setup();try {
    const demo=syntheticDemo(),before=await t.hydrate();
    vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,text:async()=>cif})));
    const pending=t.call('replace_inspection_source',{sessionId:t.sessionId,demo:demo.name,waitForRenderMs:2000});
    let d=before;
    for(let i=0;i<100 && d.sourceToken===before.sourceToken;i++) {await new Promise(r=>setTimeout(r,5));d=await t.hydrate();}
    await t.call('report_source_failure',{...t.bind(d),panelId:t.panelId,previousSourceToken:before.sourceToken,
      failure:'render_failed',failureReason:'Representation build failed.'});
    const loaded=await pending;
    expect(loaded.structuredContent.sourceRenderStatus).toMatchObject({status:'failed',rendered:false,failure:'render_failed'});
    expect(loaded.structuredContent.renderWait).toMatchObject({pending:false,timedOut:false,waitExpired:false});
    expect(loaded.content[0].text).toContain('Representation build failed.');
    expect(loaded.content[0].text).not.toMatch(/still drawing/i);
  } finally {await t.close();}
});

it('reports host preparation phases for a plain source without requiring a demo',async()=>{
  const t=await setup();try {
    const loaded=await t.call('replace_inspection_source',{sessionId:t.sessionId,
      source:{kind:'pasted',text:cif+'\n# distinct source revision\n',format:'mmcif'},waitForRenderMs:0});
    expect(loaded.structuredContent.sourceLoadTimings).toMatchObject({
      catalogVerificationMs:expect.any(Number),attachmentMs:expect.any(Number),preparationMs:expect.any(Number)});
    for(const ms of Object.values(loaded.structuredContent.sourceLoadTimings)) expect(ms).toBeGreaterThanOrEqual(0);
    expect(loaded.structuredContent.sourceRenderStatus.rendered).toBe(false);
  } finally {await t.close();}
});
