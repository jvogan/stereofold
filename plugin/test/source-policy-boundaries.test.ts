import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { resolveStructureSource } from '../src/structure-sources.js';
import { readInspectionFile } from '../src/inspection-file.js';
import { MAX_STRUCTURE_SOURCE_BYTES, STRUCTURE_SOURCE_DOWNLOAD_TIMEOUT_MS } from '../src/inspection-limits.js';
const header='data_boundary\n_atom_site.id 1\n_atom_site.type_symbol C\n#';
const tail='\n# preserved final sentinel é\n';
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
function textOfBytes(size:number) {return header+' '.repeat(size-Buffer.byteLength(header+tail))+tail;}
const source={kind:'url',url:'https://example.test/structure.cif'};
describe('64 MiB source policy without scientific truncation',()=>{
  it.each([16*1024*1024+1,MAX_STRUCTURE_SOURCE_BYTES-1,MAX_STRUCTURE_SOURCE_BYTES])('admits and preserves %i UTF-8 bytes from a streamed source',async bytes=>{
    const text=textOfBytes(bytes), encoded=Buffer.from(text);
    let offset=0;
    const stream=new ReadableStream<Uint8Array>({pull(controller){
      if(offset===encoded.length){controller.close();return;}
      const end=Math.min(offset+96*1024,encoded.length);controller.enqueue(encoded.subarray(offset,end));offset=end;
    }});
    const fetch=vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(stream));
    const result=await resolveStructureSource(source,{fetch,cacheRoot:false});
    expect(Buffer.byteLength(result.structureText)).toBe(bytes);
    expect(digest(result.structureText)).toBe(digest(text));
    expect(result.structureText.endsWith(tail)).toBe(true);
  });
  it('accepts the exact cap locally without changing UTF-8 bytes',async()=>{
    const root=await mkdtemp(join(tmpdir(),'stereofold-source-cap-'));
    try {
      const text=textOfBytes(MAX_STRUCTURE_SOURCE_BYTES),file=join(root,'cap.cif');
      await writeFile(file,text);
      const result=await readInspectionFile(file);
      expect(Buffer.byteLength(result.structureText)).toBe(MAX_STRUCTURE_SOURCE_BYTES);
      expect(digest(result.structureText)).toBe(digest(text));
    } finally {await rm(root,{recursive:true,force:true});}
  });
  it('applies the byte bound to multibyte pastes and leaves no silent prefix',async()=>{
    const text=textOfBytes(MAX_STRUCTURE_SOURCE_BYTES)+'é';
    expect(text.length).toBeLessThanOrEqual(MAX_STRUCTURE_SOURCE_BYTES);
    await expect(resolveStructureSource({kind:'pasted',text},{cacheRoot:false})).rejects.toThrow('64 MiB source policy');
  });
  it('uses a 60-second total download signal and preserves caller cancellation',async()=>{
    const timeout=vi.spyOn(AbortSignal,'timeout');
    const cancelled=new AbortController();
    const fetch=vi.fn<typeof globalThis.fetch>().mockImplementation(async(_url,init)=>{
      expect(init?.signal?.aborted).toBe(false);
      cancelled.abort(Error('caller cancelled'));
      expect(init?.signal?.aborted).toBe(true);
      init?.signal?.throwIfAborted();throw Error('unreachable');
    });
    try {
      expect(STRUCTURE_SOURCE_DOWNLOAD_TIMEOUT_MS).toBe(60_000);
      await expect(resolveStructureSource(source,{fetch,cacheRoot:false,signal:cancelled.signal})).rejects.toThrow('caller cancelled');
      expect(timeout).toHaveBeenCalledWith(60_000);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {timeout.mockRestore();}
  });
});
