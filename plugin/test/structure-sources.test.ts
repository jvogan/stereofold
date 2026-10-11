import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveStructureSource, inspectionSource, MAX_STRUCTURE_SOURCE_BYTES, ALPHAFOLD_MODEL_VERSION } from '../src/structure-sources.js';
// @ts-ignore Shared identity extraction used by production.
import { extractBytes } from '../../lab/identity/extract.cjs';
const cif=await readFile(new URL('../../fixtures/1CRN.cif',import.meta.url),'utf8');
const pdb='ATOM      1  CA  ALA A   1      11.104  13.207  10.000  1.00 20.00           C  \nEND\n';
const url={kind:'url',url:'https://example.test/download'};
function mock(body:string,status=200,headers:Record<string,string>={}) {return vi.fn<typeof fetch>().mockImplementation(async()=>new Response(body,{status,headers}));}
const resolve=(request:unknown,fetch:typeof globalThis.fetch)=>resolveStructureSource(request,{fetch,cacheRoot:false});
describe('structure source resolver',()=>{
  it.each(['http://example.test/a','file:///tmp/a.cif','data:text/plain,data_a','ftp://example.test/a','https://user:password@example.test/a','not a URL'])('refuses unsafe URL %s before fetching',async value=>{
    const fetch=mock(cif);await expect(resolve({...url,url:value},fetch)).rejects.toThrow('Only https URLs');expect(fetch).not.toHaveBeenCalled();
  });
  it.each([{kind:'pdb',id:'../a'},{kind:'alphafold',accession:'../P69905'},{kind:'url',url:''},{kind:'file',path:'relative.cif'},{kind:'unknown'}])('refuses invalid requests with limits: %j',async request=>{
    const fetch=mock(cif);await expect(resolve(request,fetch)).rejects.toThrow('Only https URLs');expect(fetch).not.toHaveBeenCalled();
  });
  it('resolves normalized RCSB and fixed-version AlphaFold identities',async()=>{
    const fetch=mock(cif);
    expect(await resolve({kind:'pdb',id:'1crn'},fetch)).toMatchObject({kind:'pdb',pdbId:'1CRN',format:'mmcif'});
    expect(fetch.mock.calls[0][0]).toBe('https://files.rcsb.org/download/1CRN.cif');
    expect(await resolve({kind:'alphafold',accession:'p69905'},fetch)).toMatchObject({kind:'alphafold',accession:'P69905',version:ALPHAFOLD_MODEL_VERSION});
    expect(fetch.mock.calls[1][0]).toBe('https://alphafold.ebi.ac.uk/files/AF-P69905-F1-model_v6.cif');
  });
  it('names the missing AlphaFold version without trying another version',async()=>{
    const fetch=mock('',404);await expect(resolve({kind:'alphafold',accession:'P69905'},fetch)).rejects.toThrow('AlphaFold P69905 v6:');expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([[cif,'mmcif'],[pdb,'pdb']])('sniffs extensionless content',async(text,format)=>{
    expect(await resolve(url,mock(text))).toMatchObject({kind:'url',format});
  });
  it('refuses HTML even with a cif extension',async()=>{
    await expect(resolve({...url,url:'https://example.test/a.cif'},mock('<html>Login</html>'))).rejects.toThrow('not recognizable');
  });
  it('follows HTTPS redirects manually',async()=>{
    const fetch=mock(cif);fetch.mockResolvedValueOnce(new Response(null,{status:302,headers:{location:'/other'}}));
    await resolve(url,fetch);expect(fetch.mock.calls.map(v=>v[0])).toEqual([url.url,'https://example.test/other']);
    expect(fetch.mock.calls.every(v=>v[1]?.redirect==='manual')).toBe(true);
  });
  it.each(['http://example.test/a','file:///a','data:text/plain,a'])('refuses redirect to %s before contacting it',async location=>{
    const fetch=vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null,{status:302,headers:{location}}));
    await expect(resolve(url,fetch)).rejects.toThrow('Only https URLs');expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('bounds redirect loops',async()=>{
    const fetch=vi.fn<typeof globalThis.fetch>().mockImplementation(async()=>new Response(null,{status:307,headers:{location:'/again'}}));
    await expect(resolve(url,fetch)).rejects.toThrow('five-redirect');expect(fetch).toHaveBeenCalledTimes(6);
  });
  it('refuses a declared oversized response before reading',async()=>{
    await expect(resolve(url,mock(cif,200,{'content-length':String(MAX_STRUCTURE_SOURCE_BYTES+1)}))).rejects.toThrow('larger than the 64 MiB source policy');
  });
  it('caps streamed bytes even with a false Content-Length and cancels the stream',async()=>{
    const cancel=vi.fn();const body=new ReadableStream({start(controller){controller.enqueue(new Uint8Array(MAX_STRUCTURE_SOURCE_BYTES));controller.enqueue(new Uint8Array(1));},cancel});
    const fetch=vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(body,{headers:{'content-length':'1'}}));
    await expect(resolve(url,fetch)).rejects.toThrow('larger than the 64 MiB source policy');expect(cancel).toHaveBeenCalledOnce();
  });
  it('refuses binary or invalid UTF-8 bodies',async()=>{
    const fetch=vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(new Uint8Array([0xff,0xfe])));
    await expect(resolve(url,fetch)).rejects.toThrow('not UTF-8');
  });
  it('reads an absolute fixture file and pasted coordinates locally',async()=>{
    const fetch=mock(cif);
    expect(await resolve({kind:'file',path:new URL('../../fixtures/1CRN.cif',import.meta.url).pathname},fetch)).toMatchObject({kind:'file',structureText:cif,format:'mmcif'});
    expect(await resolve({kind:'pasted',text:pdb},fetch)).toMatchObject({kind:'pasted',format:'pdb'});expect(fetch).not.toHaveBeenCalled();
    expect(await resolve({kind:'pasted',text:pdb,format:'mmcif'},fetch)).toMatchObject({format:'mmcif'});
  });
  it('normalizes PDB into cataloguable mmCIF and retains model numbers',async()=>{
    const models=`SEQRES   1 A    1  ALA\nMODEL        2\n${pdb.replace('END\n','ENDMDL\n')}MODEL        4\n${pdb.replace('END\n','ENDMDL\n')}END\n`;
    const source=await inspectionSource(await resolve({kind:'pasted',text:models},mock(cif)));
    expect(source.format).toBe('mmcif');
    const catalog=await extractBytes(source.structureText);expect(catalog.modelNumbers).toEqual([2,4]);
  });
  it('preserves deposited PDB assembly operators during normalization',async()=>{
    const text='SEQRES   1 A    1  ALA\n'+[
      'REMARK 350 BIOMOLECULE: 1',
      'REMARK 350 APPLY THE FOLLOWING TO CHAINS: A',
      'REMARK 350   BIOMT1   1  1.000000  0.000000  0.000000        0.00000',
      'REMARK 350   BIOMT2   1  0.000000  1.000000  0.000000        0.00000',
      'REMARK 350   BIOMT3   1  0.000000  0.000000  1.000000        0.00000',
      'REMARK 350   BIOMT1   2  1.000000  0.000000  0.000000       10.00000',
      'REMARK 350   BIOMT2   2  0.000000  1.000000  0.000000        0.00000',
      'REMARK 350   BIOMT3   2  0.000000  0.000000  1.000000        0.00000',
    ].join('\n')+'\n'+pdb;
    const source=await inspectionSource(await resolve({kind:'pasted',text},mock(cif)));
    const catalog=await extractBytes(source.structureText,{assemblyId:'1'});
    expect(catalog.assemblyId).toBe('1');expect(catalog.rows).toHaveLength(2);
    expect(new Set(catalog.rows.map((row:any)=>row.key)).size).toBe(2);
  });
  it('refuses PDB polymers without a declared sequence rather than inventing one',async()=>{
    await expect(inspectionSource(await resolve({kind:'pasted',text:pdb},mock(cif)))).rejects.toThrow('PDB inspection requires SEQRES');
  });
  it('uses the documented public cache keys, refreshes entries and never persists URL content',async()=>{
    const cacheRoot=await mkdtemp(join(tmpdir(),'stereofold-sources-'));
    try {
      const fetch=mock(cif);
      await resolveStructureSource({kind:'alphafold',accession:'P69905'},{fetch,cacheRoot});
      expect(await readFile(join(cacheRoot,'alphafold-P69905-v6.cif'),'utf8')).toBe(cif);
      await resolveStructureSource(url,{fetch:mock(pdb),cacheRoot});
      expect(await readdir(cacheRoot)).toEqual(['alphafold-P69905-v6.cif']);
      await expect(resolveStructureSource({kind:'alphafold',accession:'P69905'},{fetch:mock('',404),cacheRoot})).rejects.toThrow('HTTP 404');
    } finally {await rm(cacheRoot,{recursive:true,force:true});}
  });
});
