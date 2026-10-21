import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createStereoStructureServer } from '../src/server.js';
import { createInspectionBytesHydrator, hydrateComparisonSource, hydrateInspectionBytes } from '../src/inspection-chunk-client.js';
import { decodeInspectionCatalog, verifyInspectionCatalogSource, MAX_INSPECTION_CATALOG_COMPRESSED_BYTES } from '../src/inspection-catalog-codec.js';
import { MAX_STRUCTURE_SOURCE_BYTES } from '../src/inspection-limits.js';

const KEY='stereo_structure/inspection';
const cif=await readFile(new URL('../../fixtures/1CRN.cif',import.meta.url),'utf8');
const sha=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
let descriptor:any, completed:any, parts:Record<string,Buffer>;
beforeAll(async()=>{
  const [a,b]=InMemoryTransport.createLinkedPair(),server=createStereoStructureServer(),client=new Client({name:'primary byte reuse',version:'1'});
  await server.connect(b);await client.connect(a);
  const call=async(name:string,args:any)=>{const result:any=await client.callTool({name:`stereo_structure.${name}`,arguments:args});if(result.isError)throw Error(result.content[0].text);return result;};
  try {
    const {sessionId}=(await call('inspect',{structureText:cif})).structuredContent;
    descriptor=(await call('get_inspection',{sessionId,transport:'chunked'}))._meta[KEY];
    completed=structuredClone(descriptor);await hydrateInspectionBytes(completed,call);
    parts={source:Buffer.from(cif),catalog:Buffer.from(completed.catalogWire.data,'base64')};
  } finally {await client.close();await server.close();}
});
function transport() {
  const calls:any[]=[];
  const call=async(name:string,args:any)=>{
    expect(name).toBe('get_inspection_bytes');calls.push(structuredClone(args));
    const bytes=parts[args.part],slice=bytes.subarray(args.offset,args.offset+args.byteCount);
    return {_meta:{[KEY]:{part:args.part,offset:args.offset,byteCount:slice.length,totalBytes:bytes.length,
      sha256:sha(bytes),hasMore:args.offset+slice.length<bytes.length,data:slice.toString('base64'),...(args.comparison?{comparison:args.comparison}:{})}}};
  };
  return {call,calls};
}
const fresh=()=>structuredClone(descriptor);

describe('page-owned primary byte reuse',()=>{
  it('reuses exact verified bytes across a scene revision without another chunk RPC, then still verifies the catalog and source',async()=>{
    const hydrate=createInspectionBytesHydrator(),t=transport(),first=fresh();
    await hydrate(first,t.call);expect(t.calls.length).toBeGreaterThan(0);t.calls.length=0;
    const next=fresh();next.inspectionRevision++;next.scene={sourceSha256:'a'.repeat(64)};
    await hydrate(next,t.call);expect(t.calls).toEqual([]);expect(next.structureText).toBe(cif);expect(next.catalogWire).toEqual(completed.catalogWire);
    const catalog=await decodeInspectionCatalog(next.catalogWire);await verifyInspectionCatalogSource(next.structureText,catalog);
    expect(catalog.rows.length).toBe(46);expect(catalog.rows.reduce((n:number,row:any)=>n+row.atomSites.length,0)).toBe(327);
  });
  it('retains immutable strings, not a mutable prior response or decoded catalog',async()=>{
    const hydrate=createInspectionBytesHydrator(),t=transport(),first=fresh();await hydrate(first,t.call);
    first.structureText='changed';first.catalogWire.data='changed';first.catalogWire.sourceSha256='b'.repeat(64);t.calls.length=0;
    const next=fresh();await hydrate(next,t.call);expect(t.calls).toEqual([]);expect(next.structureText).toBe(cif);expect(next.catalogWire).toEqual(completed.catalogWire);
    next.catalogWire.data='also changed';const third=fresh();await hydrate(third,t.call);expect(third.catalogWire).toEqual(completed.catalogWire);
  });
  it.each(['sessionId','serverEpoch','sourceToken','modelNumber','assemblyId','catalogMetadata'] as const)('refetches after %s changes',async field=>{
    const hydrate=createInspectionBytesHydrator(),t=transport();await hydrate(fresh(),t.call);t.calls.length=0;const next=fresh();
    if(field==='modelNumber')next.sourceSelection.modelNumber++;
    else if(field==='assemblyId')next.sourceSelection.assemblyId='different';
    else if(field==='catalogMetadata')next.catalogWire.catalogSha256='b'.repeat(64);
    else next[field]+='-changed';
    await hydrate(next,t.call);expect(t.calls.length).toBeGreaterThan(0);
    if(field==='catalogMetadata')await expect(decodeInspectionCatalog(next.catalogWire)).rejects.toThrow();
  });
  it.each(['source-digest','source-length','catalog-digest','catalog-length'] as const)('does not reuse changed %s descriptors',async field=>{
    const hydrate=createInspectionBytesHydrator(),t=transport();await hydrate(fresh(),t.call);t.calls.length=0;const next=fresh();
    const key=field.startsWith('source')?'sourceBytes':'catalogBytes';
    if(field.endsWith('digest')){next[key].sha256='c'.repeat(64);if(key==='sourceBytes')next.catalogWire.sourceSha256=next[key].sha256;}
    else {next[key].bytes++;if(key==='catalogBytes')next.catalogWire.compressedBytes=next[key].bytes;}
    await expect(hydrate(next,t.call)).rejects.toThrow();expect(t.calls.length).toBeGreaterThan(0);
  });
  it.each(['source-bound','catalog-bound','mismatch','source-nan','catalog-negative','mixed-source','mixed-catalog'] as const)('refuses malformed %s even after a valid cache entry',async field=>{
    const hydrate=createInspectionBytesHydrator(),t=transport();await hydrate(fresh(),t.call);t.calls.length=0;const next=fresh();
    if(field==='source-bound')next.sourceBytes.bytes=MAX_STRUCTURE_SOURCE_BYTES+1;
    if(field==='catalog-bound')next.catalogBytes.bytes=MAX_INSPECTION_CATALOG_COMPRESSED_BYTES+1;
    if(field==='mismatch')next.catalogWire.sourceSha256='e'.repeat(64);
    if(field==='source-nan')next.sourceBytes.bytes=NaN;
    if(field==='catalog-negative')next.catalogBytes.bytes=-1;
    if(field==='mixed-source')next.structureText=cif;
    if(field==='mixed-catalog')next.catalogWire.data=completed.catalogWire.data;
    await expect(hydrate(next,t.call)).rejects.toThrow();expect(t.calls).toEqual([]);
    const good=fresh();await hydrate(good,t.call);expect(t.calls.length).toBeGreaterThan(0);
  });
  it.each(['inline','source-only','catalog-only'] as const)('preserves legacy %s hydration and invalidates the previous pair',async mode=>{
    const hydrate=createInspectionBytesHydrator(),t=transport();await hydrate(fresh(),t.call);
    const legacy=mode==='inline'?structuredClone(completed):fresh();
    if(mode==='source-only'){delete legacy.catalogBytes;legacy.catalogWire={...completed.catalogWire};}
    if(mode==='catalog-only'){delete legacy.sourceBytes;legacy.structureText=cif;}
    const expected=structuredClone(legacy);await hydrateInspectionBytes(expected,t.call);await hydrate(legacy,t.call);
    expect(legacy).toEqual(expected);t.calls.length=0;
    await hydrate(fresh(),t.call);expect(t.calls.length).toBeGreaterThan(0);
  });
  it('never caches a corrupt or partially failed transfer',async()=>{
    const hydrate=createInspectionBytesHydrator(),t=transport();let fail=true;
    const flaky=async(name:string,args:any)=>{if(fail&&args.part==='catalog')throw Error('catalog transfer failed');return t.call(name,args);};
    await expect(hydrate(fresh(),flaky)).rejects.toThrow('catalog transfer failed');fail=false;t.calls.length=0;
    await hydrate(fresh(),flaky);expect(t.calls.map(x=>x.part)).toContain('source');
    const different=fresh();different.sourceToken+='new';const corrupt=async(name:string,args:any)=>{const answer=await t.call(name,args);if(args.part==='source'){const bytes=Buffer.from(answer._meta[KEY].data,'base64');bytes[0]^=1;answer._meta[KEY].data=bytes.toString('base64');}return answer;};
    await expect(hydrate(different,corrupt)).rejects.toThrow();t.calls.length=0;await hydrate(fresh(),t.call);expect(t.calls.length).toBeGreaterThan(0);
  });
  it('evicts the old entry on A→B→A and owns no cross-page cache',async()=>{
    const hydrate=createInspectionBytesHydrator(),t=transport();await hydrate(fresh(),t.call);const b=fresh();b.sourceToken+='B';await hydrate(b,t.call);t.calls.length=0;
    await hydrate(fresh(),t.call);expect(t.calls.length).toBeGreaterThan(0);t.calls.length=0;
    await createInspectionBytesHydrator()(fresh(),t.call);expect(t.calls.length).toBeGreaterThan(0);
  });
  it('does not let an obsolete in-flight assembly replace the newer completed entry',async()=>{
    const hydrate=createInspectionBytesHydrator(),t=transport();let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let started!:()=>void;const sent=new Promise<void>(resolve=>{started=resolve;});
    const older=hydrate(fresh(),async(name,args)=>{if(args.part==='source'&&args.offset===0){started();await gate;}return t.call(name,args);});await sent;
    const b=fresh();b.sourceToken+='B';await hydrate(b,t.call);release();await older;t.calls.length=0;
    const sameB=fresh();sameB.sourceToken+='B';await hydrate(sameB,t.call);expect(t.calls).toEqual([]);
  });
  it('leaves comparison hydration independent, including identical source/catalog bytes',async()=>{
    const hydrate=createInspectionBytesHydrator(),t=transport();await hydrate(fresh(),t.call);t.calls.length=0;
    const source={sha256:descriptor.sourceBytes.sha256,assemblyId:descriptor.sourceSelection.assemblyId,sourceBytes:{...descriptor.sourceBytes},catalogBytes:{...descriptor.catalogBytes},catalogWire:{...descriptor.catalogWire}};
    await hydrateComparisonSource(source,t.call,descriptor.sessionId);expect(t.calls.length).toBeGreaterThan(0);expect(t.calls.every(x=>x.comparison?.sourceSha256===descriptor.sourceBytes.sha256)).toBe(true);expect((source as any).cif).toBe(cif);
  });
});
