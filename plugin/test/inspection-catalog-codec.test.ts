import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { gzipSync } from 'node:zlib';
vi.mock('node:zlib',async original=>{const actual=await original<typeof import('node:zlib')>();return {...actual,gzipSync:vi.fn(actual.gzipSync)};});
import { decodeInspectionCatalog, verifyInspectionCatalogSource } from '../src/inspection-catalog-codec.js';
import { inspectionCatalogTransport } from '../src/inspection-catalog-codec-server.js';

function catalog() {
  const sourceSha256 = 'a'.repeat(64);
  return {
    source: { sha256: sourceSha256 }, modelNumbers: [1], assemblyId: 'asym',
    rows: Array.from({ length: 2_000 }, (_, index) => ({
      key: `a${index}`, identity: { modelNumber: 1, labelChain: 'A', labelSequenceId: index + 1, componentId: 'ALA' },
      coordinateState: 'resolved', atomSites: Array.from({ length: 4 }, (_, atom) => ({ id: atom + 1, atomName: 'CA', element: 'C' })),
    })),
  };
}

describe('bounded inspection catalog transport', () => {
  it('round-trips complete canonical identities through gzip wire form', async () => {
    const value = catalog();
    const transport = inspectionCatalogTransport(value);
    expect('catalogWire' in transport).toBe(true);
    if (!('catalogWire' in transport)) throw new Error('expected compact transport');
    const decoded = await decodeInspectionCatalog(transport.catalogWire);
    expect(decoded).toEqual(value);
  });

  it('retains the legacy object form for small catalogs', async () => {
    const value = { source: { sha256: 'b'.repeat(64) }, rows: [] };
    const transport = inspectionCatalogTransport(value);
    expect(transport).toEqual({ catalog: value });
    if (!('catalog' in transport)) throw new Error('expected legacy transport');
    await expect(decodeInspectionCatalog(transport.catalog)).resolves.toBe(value);
  });

  it('rejects malformed, truncated, and over-budget wire data', async () => {
    const transport = inspectionCatalogTransport(catalog());
    if (!('catalogWire' in transport)) throw new Error('expected compact transport');
    const wire = transport.catalogWire;
    await expect(decodeInspectionCatalog({ ...wire, compressedBytes: wire.compressedBytes + 1 })).rejects.toThrow(/invalid sequence catalog/i);
    await expect(decodeInspectionCatalog({ ...wire, catalogSha256: 'c'.repeat(64) })).rejects.toThrow(/invalid sequence catalog/i);
    await expect(decodeInspectionCatalog({ ...wire, data: wire.data.slice(0, -4) })).rejects.toThrow(/invalid sequence catalog/i);
    await expect(decodeInspectionCatalog({ ...wire, uncompressedBytes: 64 * 1024 * 1024 + 1 })).rejects.toThrow(/invalid sequence catalog/i);
    await expect(decodeInspectionCatalog({ ...wire, data: `${wire.data.slice(0, -2)}!!` })).rejects.toThrow(/invalid sequence catalog/i);
  });

  it('verifies coordinate bytes against the catalog source digest', async () => {
    const text = 'data_demo\n_atom_site.id 1\n#\n';
    const sourceSha256 = createHash('sha256').update(text).digest('hex');
    const value = { source: { sha256: sourceSha256 }, rows: [] };
    await expect(verifyInspectionCatalogSource(text, value)).resolves.toBeUndefined();
    await expect(verifyInspectionCatalogSource(`${text}#`, value)).rejects.toThrow(/coordinates changed/i);
  });
});

function factoredAssemblyCatalog() {
  const sourceHash = 'd'.repeat(64), copies:any[] = [], rows:any[] = [];
  const residueKey = (i:any) => JSON.stringify(['residue-v1',i.sourceHash,i.modelNumber,i.copyId,i.entityId,i.labelChain,i.authorChain,i.labelSequenceId,i.authorResidue,i.insertionCode,i.componentId]);
  const atomKey = (i:any) => JSON.stringify(['atom-v1',residueKey(i),i.atomName,i.authorAtomName,i.alternateSite,i.sourceAtomId]);
  for(let copy=0;copy<1_500;copy++) {
    const copyId=JSON.stringify(['copy','1',copy,[String(copy + 1)]]) , matrix=[1,0,0,0,0,1,0,0,0,0,1,0,copy,0,0,1];
    copies.push({assemblyId:'1',generatorIndex:copy,operatorIds:[String(copy+1)],labelChains:['A'],matrix,copyId,modelNumber:1});
    const identity={sourceHash,modelNumber:1,assemblyId:'1',generatorIndex:copy,operatorIds:[String(copy+1)],copyId,entityId:'1',labelChain:'A',authorChain:'A',labelSequenceId:1,authorResidue:1,insertionCode:'',componentId:'GLY'};
    const sites=Array.from({length:12},(_,index)=>{const sourceCoordinatesAngstrom=[index,1,2], atomIdentity={...identity,atomName:`C${index}`,authorAtomName:`C${index}`,alternateSite:'',sourceAtomId:String(index+1)};return {key:atomKey(atomIdentity),identity:atomIdentity,element:'C',sourceCoordinatesAngstrom,assemblyCoordinatesAngstrom:[copy+index,1,2]};});
    rows.push({key:residueKey(identity),identity,entityType:'polymer',sequenceDeclared:true,mappingOrigin:'atom_site',coordinateState:'resolved',atomSites:sites});
  }
  return {schemaVersion:'draft-identity-1',source:{sha256:sourceHash},molstarVersion:'test',assemblyId:'1',modelNumbers:[1],copies,rows};
}

it('selects the smaller lossless factored wire for a repeated assembly and reconstructs canonical atom coordinates', async()=> {
  const value=factoredAssemblyCatalog(), transport=inspectionCatalogTransport(value);
  expect('catalogWire' in transport).toBe(true);
  if(!('catalogWire' in transport)) throw Error('expected wire');
  expect(transport.catalogWire.encoding).toBe('gzip+base64+factored-v1');
  expect(await decodeInspectionCatalog(transport.catalogWire)).toEqual(value);
});

it('refuses a factored wire whose declared atom-site count cannot fit its canonical bytes', async()=> {
  const transport=inspectionCatalogTransport(factoredAssemblyCatalog());
  if(!('catalogWire' in transport)) throw Error('expected wire');
  const wire=transport.catalogWire;
  // One atom site costs 114 bytes of canonical JSON at its absolute smallest,
  // so a count equal to the canonical byte length is impossible. It is refused
  // before reconstruction expands a single ref, rather than by the equality
  // check that used to be the only bound on this number.
  await expect(decodeInspectionCatalog({ ...wire, atomSites: wire.canonicalBytes }))
    .rejects.toThrow(/invalid sequence catalog/i);
  await expect(decodeInspectionCatalog({ ...wire, atomSites: Number.MAX_SAFE_INTEGER }))
    .rejects.toThrow(/invalid sequence catalog/i);
  // A count that is merely wrong still fails, now during the expansion rather
  // than after it.
  await expect(decodeInspectionCatalog({ ...wire, atomSites: wire.atomSites! - 1 }))
    .rejects.toThrow(/invalid sequence catalog/i);
  await expect(decodeInspectionCatalog({ ...wire, atomSites: wire.atomSites! + 1 }))
    .rejects.toThrow(/invalid sequence catalog/i);
});


it('compresses one lossless catalog instead of also compressing a discarded alternative',async()=>{
  vi.mocked(gzipSync).mockClear();
  const value=factoredAssemblyCatalog(), transport=inspectionCatalogTransport(value);
  expect(gzipSync).toHaveBeenCalledTimes(1);
  if(!('catalogWire' in transport))throw Error('expected wire');
  expect(transport.catalogWire.encoding).toBe('gzip+base64+factored-v1');
  expect(await decodeInspectionCatalog(transport.catalogWire)).toEqual(value);
  vi.mocked(gzipSync).mockClear();
  const legacy=inspectionCatalogTransport(catalog());
  expect(gzipSync).toHaveBeenCalledTimes(1);
  if(!('catalogWire' in legacy))throw Error('expected wire');
  expect(legacy.catalogWire.encoding).toBe('gzip+base64');
  expect(await decodeInspectionCatalog(legacy.catalogWire)).toEqual(catalog());
});

it('yields while reconstructing and sealing exact canonical identities, then reuses their immutable snapshot',async()=>{
  const value=factoredAssemblyCatalog(),transport=inspectionCatalogTransport(value);
  if(!('catalogWire' in transport))throw Error('expected wire');
  let yields=0;
  const decoded=await decodeInspectionCatalog(transport.catalogWire,{budgetMs:0,yieldTask:async()=>{yields++;}});
  expect(yields).toBeGreaterThan(10);expect(decoded).toEqual(value);
  // @ts-ignore Shared import-free browser ownership helper.
  const {snapshotSelectionCatalog}=await import('../../lab/browser-roundtrip/catalog-snapshot.mjs');
  expect(snapshotSelectionCatalog(decoded)).toBe(decoded);
  expect(Object.isFrozen(decoded.rows[0].atomSites[0].identity)).toBe(true);
  expect(()=>{decoded.rows[0].atomSites[0].identity.atomName='tampered';}).toThrow();
});

it.each(['abort','superseded'] as const)('cancels cooperative catalog decode after %s without publishing a partial catalog',async kind=>{
  const transport=inspectionCatalogTransport(factoredAssemblyCatalog());
  if(!('catalogWire' in transport))throw Error('expected wire');
  const controller=new AbortController();let current=true,yields=0;
  await expect(decodeInspectionCatalog(transport.catalogWire,{signal:controller.signal,isCurrent:()=>current,budgetMs:0,
    yieldTask:async()=>{yields++;if(kind==='abort')controller.abort();else current=false;}})).rejects.toMatchObject({name:'AbortError',code:'catalog_decode_cancelled'});
  expect(yields).toBe(1);
});

it('batches legacy canonical encoding into reusable byte chunks without per-field encoded allocations',async()=>{
  const value=catalog();value.rows[0].identity.componentId='Café 🧬 \\ "';
  const transport=inspectionCatalogTransport(value);if(!('catalogWire' in transport))throw Error('expected wire');
  expect(transport.catalogWire.encoding).toBe('gzip+base64');
  const encode=vi.spyOn(TextEncoder.prototype,'encode');
  try{expect(await decodeInspectionCatalog(transport.catalogWire,{budgetMs:0,yieldTask:async()=>{}})).toEqual(value);
    expect(encode).not.toHaveBeenCalled();
  }finally{encode.mockRestore();}
});
