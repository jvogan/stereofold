import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, it, vi } from 'vitest';
import { createStereoStructureServer } from '../src/server.js';
import { PRIVATE_INSPECTION_META_KEY as KEY } from '../src/inspection-contract.js';
import { createReplyAudioSynthesizer } from '../src/headset-reply-audio.js';

// Only the demo's cache/index boundary is substituted. Source verification,
// lesson compilation, source swaps, saves and panel ownership use the server.
const fixture=vi.hoisted(()=>({index:{} as any,targetPath:''}));
vi.mock('../src/molecular-growth.js',async importOriginal=>({
  ...await importOriginal<typeof import('../src/molecular-growth.js')>(),
  readGrowthIndex:async()=>fixture.index,
}));
vi.mock('../src/growth-coordinates.js',async importOriginal=>({
  ...await importOriginal<typeof import('../src/growth-coordinates.js')>(),
  ensureGrowthCoordinates:async()=>({path:fixture.targetPath,fetched:false,fetchedAt:null}),
}));

it('growth is pending until the current source is saved and its selected renderer reattaches',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'stereofold-growth-receipt-'));
  const cif=await readFile(new URL('../../fixtures/1CRN.cif',import.meta.url),'utf8');
  const nextCif=cif+'\n# Verified growth receipt fixture\n';
  const digest=(text:string)=>createHash('sha256').update(text,'utf8').digest('hex');
  const firstPath=join(directory,'first.cif'); fixture.targetPath=join(directory,'second.cif');
  const lesson=(id:string,sourceSha256:string)=>({version:1,id:`receipt-growth-${id}`,title:`Receipt ${id}`,mode:'explore',
    provenance:{sourceSha256,sourceRefs:[{kind:'public',ref:'https://www.rcsb.org/structure/1CRN'}],note:'Verified source fixture for growth renderer ownership.'},
    chapters:[{id:'reveal',title:'Reveal',caption:'Inspect the verified source.',durationSeconds:10,
      changes:[{kind:'scene',durationSeconds:10,easing:'ease_in_out',transition:'smooth',scene:{background:'#071015'}}],
      immersive:{appearance:{representation:'cartoon',color:'chain-id'},motion:{kind:'hold'}}}]});
  const firstLesson=join(directory,'first.json'),secondLesson=join(directory,'second.json');
  await Promise.all([writeFile(firstPath,cif),writeFile(fixture.targetPath,nextCif),
    writeFile(firstLesson,JSON.stringify(lesson('first',digest(cif)))),writeFile(secondLesson,JSON.stringify(lesson('second',digest(nextCif))))]);
  const [a,b]=InMemoryTransport.createLinkedPair();
  const server=createStereoStructureServer(undefined,{replyAudio:createReplyAudioSynthesizer({enabled:false})});
  const client=new Client({name:'Growth receipt contract',version:'1'});
  await server.connect(b);await client.connect(a);
  const call=async(name:string,args:Record<string,unknown>)=>await client.callTool({name:`stereo_structure.${name}`,arguments:args}) as any;
  try {
    const opened=await call('inspect_lesson',{filePath:firstPath,lessonPath:firstLesson});
    expect(opened.isError).not.toBe(true);
    const sessionId=opened.structuredContent.sessionId;
    const hydrate=async()=>(await call('get_inspection',{sessionId}))._meta[KEY];
    const state=async()=>(await call('get_inspection_state',{sessionId})).structuredContent;
    const data=await hydrate();
    const atomSites=data.catalog.rows.reduce((n:number,row:any)=>n+row.atomSites.length,0);
    fixture.index={demos:[{name:'receipt-growth',stages:[
      {id:'first',title:'First',lesson:firstLesson,tiers:['quest2','quest3'],coordinates:{download:'https://files.rcsb.org/download/1CRN.cif',file:'first.cif',sha256:digest(cif),bytes:Buffer.byteLength(cif),atomSites}},
      {id:'second',title:'Second',lesson:secondLesson,tiers:['quest2','quest3'],coordinates:{download:'https://files.rcsb.org/download/1CRN.cif',file:'second.cif',sha256:digest(nextCif),bytes:Buffer.byteLength(nextCif),atomSites}},
    ]}]};
    const bind=(d:any)=>({sessionId,serverEpoch:d.serverEpoch,sourceToken:d.sourceToken,
      baseStateRevision:d.stateRevision,baseInspectionRevision:d.inspectionRevision});
    const scene={sourceSha256:data.catalog.source.sha256,modelNumber:data.catalog.modelNumbers[0],assemblyId:data.catalog.assemblyId,
      selectionKeys:[data.catalog.rows[0].key],camera:{mode:'perspective',fov:Math.PI/4,position:[0,0,80],up:[0,1,0],target:[0,0,0],radius:20,radiusMax:20,fog:50,clipFar:true,minNear:5,minFar:0},
      inspection:{appearance:{representation:'cartoon',color:'chain-id',uniformColor:'#44aaff',background:'#192734',opacity:1,labels:false,highlightColor:'#ffccee',clipping:0,fog:30},
        placement:{translation:[.5,0,0],rotation:[0,30,0],scale:1.2}}};
    const saving=await call('sync_inspection',{...bind(data),scene});
    expect(saving.isError,JSON.stringify(saving.content)).not.toBe(true);
    const saved=saving.structuredContent;
    const before=bind(saved);
    const oldPanel=(await call('attach_inspection',{...before,surface:'companion'})).structuredContent.panelId;
    const growth=await call('grow_structure',{...before,panelId:oldPanel,stage:'next',device:'quest2'});
    expect(growth.isError,JSON.stringify(growth.content)).not.toBe(true);
    expect(growth.structuredContent.grow).toMatchObject({refused:false,from:'first',to:'second'});
    expect(growth.content[0].text).toContain('Rendering is pending');
    const nextData=await hydrate();
    expect(nextData.sourceToken).not.toBe(before.sourceToken);
    expect(nextData.catalog.source.sha256).toBe(digest(nextCif));
    expect((await state()).sourceRenderReceipt).toBeUndefined();
    // An attach is not proof of a draw: the new source must first be saved.
    expect((await call('attach_inspection',{...bind(nextData),surface:'companion',replacesPanelId:oldPanel})).isError).toBe(true);
    expect((await state()).sourceRenderReceipt).toBeUndefined();
    const nextSaved=await call('sync_inspection',{...bind(nextData),scene:{...scene,sourceSha256:digest(nextCif),selectionKeys:[nextData.catalog.rows[0].key]}});
    expect(nextSaved.isError,JSON.stringify(nextSaved.content)).not.toBe(true);
    const next=bind(nextSaved.structuredContent);
    expect((await state()).sourceRenderReceipt).toBeUndefined();
    // Neither an unrelated renderer nor an old source binding can settle it.
    await call('attach_inspection',{...next,surface:'companion',replacesPanelId:randomUUID()});
    expect((await state()).sourceRenderReceipt).toBeUndefined();
    expect((await call('attach_inspection',{...before,surface:'companion',replacesPanelId:oldPanel})).isError).toBe(true);
    expect((await state()).sourceRenderReceipt).toBeUndefined();
    const attached=await call('attach_inspection',{...next,surface:'companion',replacesPanelId:oldPanel});
    expect(attached.isError).not.toBe(true);
    const receipt=(await state()).sourceRenderReceipt;
    expect(receipt).toMatchObject({status:'rendered',rendered:true,panelId:attached.structuredContent.panelId,
      sourceToken:next.sourceToken,inspectionRevision:next.baseInspectionRevision,
      renderedRevision:next.baseInspectionRevision,renderedAt:expect.any(Number)});
  } finally {await client.close();await server.close();await rm(directory,{recursive:true,force:true});}
});
