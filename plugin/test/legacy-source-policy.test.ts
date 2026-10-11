import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createStereoStructureServer } from '../src/server.js';
import { MAX_STRUCTURE_SOURCE_BYTES } from '../src/inspection-limits.js';
import { PRIVATE_STRUCTURE_META_KEY } from '../src/structure-result.js';
import { PRIVATE_INSPECTION_META_KEY } from '../src/inspection-contract.js';
import { decodeInspectionCatalog } from '../src/inspection-catalog-codec.js';

const oldCap=16*1024*1024;
const header='data_boundary\n_atom_site.id 1\n_atom_site.type_symbol C\n#';
const simple=header+'x'.repeat(oldCap+1-header.length);
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
async function setup(fetchPdbText:()=>Promise<string>) {
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  const server=createStereoStructureServer(undefined,{fetchPdbText,sceneServiceFile:join(tmpdir(),`stereofold-legacy-cap-${randomUUID()}.json`)});
  const client=new Client({name:'legacy source policy regression',version:'1'});
  await server.connect(serverTransport);await client.connect(clientTransport);
  return {call:(name:string,args:Record<string,unknown>)=>client.callTool({name:`stereo_structure.${name}`,arguments:args}) as Promise<any>,
    close:async()=>{await client.close();await server.close();}};
}
describe('legacy wire aliases share decoded source byte policy',()=>{
  it('accepts old cap+1 through flat pasted open, legacy PDB open and PDB control without changing retained bytes',async()=>{
    const t=await setup(async()=>simple);
    try {
      for(const input of [{structureText:simple,format:'mmcif'},{pdbId:'1CRN'}]) {
        const opened=await t.call('open',input);expect(opened.isError).not.toBe(true);
        const sessionId=opened.structuredContent.sessionId;
        const hydrated=await t.call('get_structure',{sessionId});
        expect(hash(hydrated._meta[PRIVATE_STRUCTURE_META_KEY].structureText)).toBe(hash(simple));
        const loaded=await t.call('control',{sessionId,action:'load_pdb',pdbId:'4HHB'});expect(loaded.isError).not.toBe(true);
        const after=await t.call('get_structure',{sessionId});
        expect(hash(after._meta[PRIVATE_STRUCTURE_META_KEY].structureText)).toBe(hash(simple));
      }
    } finally {await t.close();}
  });
  it('accepts old cap+1 through flat inspection, preserving complete CIF source identity',async()=>{
    const cif=await readFile(new URL('../../fixtures/4HHB.cif',import.meta.url),'utf8');
    const tail='\n# final sentinel é\n';
    const text=cif+'\n#'+'x'.repeat(oldCap+1-Buffer.byteLength(cif)-2-Buffer.byteLength(tail))+tail;
    expect(Buffer.byteLength(text)).toBe(oldCap+1);
    const t=await setup(async()=>text);
    try {
      const inspected=await t.call('inspect',{structureText:text});expect(inspected.isError).not.toBe(true);
      const hydration=await t.call('get_inspection',{sessionId:inspected.structuredContent.sessionId});
      const data=hydration._meta[PRIVATE_INSPECTION_META_KEY];
      const catalog=data.catalog??await decodeInspectionCatalog(data.catalogWire);
      expect(catalog.source.sha256).toBe(hash(text));
    } finally {await t.close();}
  },30000);
  it('rejects multibyte byte-over-cap text on flat APIs and injected PDB control, retaining the previous source',async()=>{
    const over=header+'é'.repeat(MAX_STRUCTURE_SOURCE_BYTES/2);
    expect(over.length).toBeLessThan(MAX_STRUCTURE_SOURCE_BYTES);
    expect(Buffer.byteLength(over)).toBeGreaterThan(MAX_STRUCTURE_SOURCE_BYTES);
    let fetched=header;
    const t=await setup(async()=>fetched);
    try {
      const opened=await t.call('open',{pdbId:'1CRN'});expect(opened.isError).not.toBe(true);
      const sessionId=opened.structuredContent.sessionId;
      for(const tool of ['open','inspect']) {
        const rejected=await t.call(tool,{structureText:over});expect(rejected.isError).toBe(true);
        expect(rejected.content[0].text).toContain('64 MiB source policy');
      }
      fetched=over;
      const rejected=await t.call('control',{sessionId,action:'load_pdb',pdbId:'4HHB'});expect(rejected.isError).toBe(true);
      expect(rejected.content[0].text).toContain('64 MiB source policy');
      const after=await t.call('get_structure',{sessionId});
      expect(after._meta[PRIVATE_STRUCTURE_META_KEY].structureText).toBe(header);
      expect(after._meta[PRIVATE_STRUCTURE_META_KEY].pdbId).toBe('1CRN');
    } finally {await t.close();}
  });
});
