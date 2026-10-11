import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { readInspectionFile } from './inspection-file.js';
import { INSPECTION_SIZE_GUIDE, MAX_STRUCTURE_SOURCE_BYTES, STRUCTURE_SOURCE_SIZE_LABEL, STRUCTURE_SOURCE_DOWNLOAD_TIMEOUT_MS } from './inspection-limits.js';

export const ALPHAFOLD_MODEL_VERSION = 'v6';
export { MAX_STRUCTURE_SOURCE_BYTES };
/**
 * One bound, and it is this plugin's own download and
 * local-read policy rather than anything a viewer was measured at.
 */
export const SOURCE_LIMIT = `Only https URLs to UTF-8 mmCIF or PDB files are supported, and local files must be absolute regular .cif or .mmcif files; either way this plugin fetches or reads at most ${MAX_STRUCTURE_SOURCE_BYTES.toLocaleString('en-US')} bytes (${STRUCTURE_SOURCE_SIZE_LABEL}), which is its own policy and not a viewer limit.`;
/**
 * What a model needs before it spends a load finding out, rewritten
 * for measured-only caps.
 *
 * The earlier text named a 6 MB source bound and a 4 MiB compressed-catalog
 * bound and reported 1AON, 1XCK and 1S5L as refused. Those two bounds were
 * invented to keep one JSON tool result small, were never measured against a
 * viewer or a host, and are gone: the panel pulls coordinates and catalog in
 * 96 KiB chunks.
 *
 * The 20,000-residue-position and 200,000-atom-site
 * budgets this sentence also quoted are gone for the same reason. They were
 * never measured either, and they spoke for the desktop. What is left is the
 * source fetch policy and a separately tested Quest 2 growth tier. Neither
 * establishes a universal device capacity.
 */
export const SOURCE_DESCRIPTION = 'Supply source with kind pdb (four-character id), alphafold (UniProt accession, model_v6), url (https mmCIF or PDB, content-sniffed), file (absolute local .cif/.mmcif path), or pasted (coordinates). '
  + `This plugin fetches or reads at most ${MAX_STRUCTURE_SOURCE_BYTES.toLocaleString('en-US')} bytes (${STRUCTURE_SOURCE_SIZE_LABEL}) of structure text, which is its own download policy rather than a viewer ceiling, and no residue-position or atom-site count refuses an inspection. `
  + `${INSPECTION_SIZE_GUIDE} `
  + 'So do not tell a person that a GroEL-sized assembly is too large for the desktop viewer: 1AON and other entries that earlier builds refused now open, but admission alone does not establish rendering speed or memory use on a headset. Missing AlphaFold v6 files are refused without a version fallback. PDB inspection requires declared polymer SEQRES; coordinate-only PDB remains available through open.';
const accession = /^[OPQ][0-9][A-Z0-9]{3}[0-9]$|^[A-NR-Z][0-9](?:[A-Z][A-Z0-9]{2}[0-9]){1,2}$/;
export const structureSourceSchema = z.discriminatedUnion('kind', [
  z.object({kind:z.literal('pdb'),id:z.string().regex(/^[A-Za-z0-9]{4}$/)}).strict(),
  z.object({kind:z.literal('alphafold'),accession:z.string().transform(v=>v.toUpperCase()).pipe(z.string().regex(accession))}).strict(),
  z.object({kind:z.literal('url'),url:z.string().min(1).max(8192)}).strict(),
  z.object({kind:z.literal('file'),path:z.string().min(1).max(4096)}).strict(),
  z.object({kind:z.literal('pasted'),text:z.string().min(20).max(MAX_STRUCTURE_SOURCE_BYTES),format:z.enum(['pdb','mmcif']).optional()}).strict(),
]);
export type StructureSourceRequest = z.output<typeof structureSourceSchema>;
export type ResolvedStructureSource = {kind:StructureSourceRequest['kind'];structureText:string;format:'mmcif'|'pdb';pdbId?:string;accession?:string;version?:string;cacheKey?:string};
export type StructureSelection = {modelNumber?:number;assemblyId?:string};
export const structureSelectionShape = {modelNumber:z.number().int().positive().optional(),assemblyId:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional()};
const refuse = (reason:string) => Error(reason.endsWith(SOURCE_LIMIT)?reason:`${reason} ${SOURCE_LIMIT}`);
export function sniffStructureFormat(text:string):'mmcif'|'pdb' {
  if (Buffer.byteLength(text,'utf8') > MAX_STRUCTURE_SOURCE_BYTES) throw refuse(`The structure is larger than the ${STRUCTURE_SOURCE_SIZE_LABEL} source policy.`);
  if (/^data_\S*/i.test(text.trimStart()) && /(?:^|\n)_atom_site\./i.test(text)) return 'mmcif';
  if (text.split(/\r?\n/).some(line=>/^(ATOM  |HETATM)/.test(line) && line.length>=54 &&
    [line.slice(30,38),line.slice(38,46),line.slice(46,54)].every(v=>v.trim()!=='' && Number.isFinite(Number(v))))) return 'pdb';
  throw refuse('The content is not recognizable mmCIF or PDB coordinates.');
}
function httpsUrl(value:string):URL {
  let url:URL; try {url=new URL(value);} catch {throw refuse('The source URL is invalid.');}
  if(url.protocol!=='https:' || url.username || url.password) throw refuse('Insecure URLs and embedded credentials are refused.');
  url.hash=''; return url;
}
async function download(url:URL, fetcher:typeof fetch, cancellation?:AbortSignal):Promise<string> {
  const timeout=AbortSignal.timeout(STRUCTURE_SOURCE_DOWNLOAD_TIMEOUT_MS);
  const signal=cancellation?AbortSignal.any([cancellation,timeout]):timeout;
  for(let redirects=0;;redirects++) {
    const response=await fetcher(url.href,{redirect:'manual',signal,headers:{Accept:'chemical/x-cif, chemical/x-pdb, text/plain;q=0.9'}});
    if(response.url) httpsUrl(response.url);
    if([301,302,303,307,308].includes(response.status)) {
      await response.body?.cancel();
      if(redirects>=5) throw refuse('The source exceeds the five-redirect limit.');
      const location=response.headers.get('location');
      if(!location) throw refuse('The redirect has no location.');
      url=httpsUrl(new URL(location,url).href); continue;
    }
    if(!response.ok) {await response.body?.cancel();throw refuse(`The source file is missing or unavailable (HTTP ${response.status}).`);}
    if(Number(response.headers.get('content-length'))>MAX_STRUCTURE_SOURCE_BYTES) {await response.body?.cancel();throw refuse(`The structure is larger than the ${STRUCTURE_SOURCE_SIZE_LABEL} source policy.`);}
    if(!response.body) throw refuse('The source has no coordinate body.');
    const reader=response.body.getReader(), chunks:Uint8Array[]=[]; let size=0;
    try {
      for(;;) {const {done,value}=await reader.read();if(done) break;size+=value.byteLength;
        if(size>MAX_STRUCTURE_SOURCE_BYTES) {await reader.cancel();throw refuse(`The structure is larger than the ${STRUCTURE_SOURCE_SIZE_LABEL} source policy.`);} chunks.push(value);}
      try {return new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));} catch {throw refuse('The source is not UTF-8 text.');}
    } finally {reader.releaseLock();}
  }
}
/**
 * Everything about a requested source that can be refused without touching the
 * network, the disk or the panel.
 *
 * This exists so a refusal can name its real limit. On the Quest 2 on
 * a wearer asked for an `http://` URL while the headset panel was
 * unsaved, and heard "No panel is ready for a command right now (companion
 * unsaved, desktop ready)" — the scheme was never looked at
 * A caller can now settle what
 * was asked for before it reports on who could draw it, and a request that is
 * refused outright is refused the same way whatever the panel is doing.
 *
 * It decides exactly what `resolveStructureSource` decides before its first
 * await, and nothing else: the shape of the request, the URL scheme and any
 * embedded credentials, and a pasted payload's size and format. Whether the
 * file exists, whether the download is really mmCIF, and whether the selection
 * is in the entry are all still answered by the resolver.
 */
export function assertStructureSourceRequest(raw:unknown):StructureSourceRequest {
  const parsed=structureSourceSchema.safeParse(raw);
  if(!parsed.success) throw refuse('Choose one valid pdb ID, AlphaFold UniProt accession, URL, absolute file path, or pasted source.');
  const request=parsed.data;
  if(request.kind==='url') httpsUrl(request.url);
  if(request.kind==='pasted') {
    if(Buffer.byteLength(request.text,'utf8')>MAX_STRUCTURE_SOURCE_BYTES) throw refuse(`The structure is larger than the ${STRUCTURE_SOURCE_SIZE_LABEL} source policy.`);
    // Sniffed here and kept, so a large paste is read once rather than again
    // in the resolver.
    return {...request,format:request.format??sniffStructureFormat(request.text)};
  }
  return request;
}
/** Public databases only: sources/<kind>-<id>[-v6].cif. URLs and private inputs never persist. */
export async function resolveStructureSource(raw:unknown, options:{fetch?:typeof fetch;fetchPdbText?:(id:string,signal?:AbortSignal)=>Promise<string>;cacheRoot?:string|false;signal?:AbortSignal}={}):Promise<ResolvedStructureSource> {
  const startedAt=Date.now();
  options.signal?.throwIfAborted();
  const request=assertStructureSourceRequest(raw);
  if(request.kind==='file') {
    try {const structureText=(await readInspectionFile(request.path)).structureText;
      console.debug('[stereofold:timing] source-fetched', {at:Date.now(),elapsedMs:Date.now()-startedAt,kind:request.kind,bytes:Buffer.byteLength(structureText)});
      return {kind:'file',format:'mmcif',structureText};}
    catch(error) {throw refuse(error instanceof Error?error.message:'The local file is unavailable.');}
  }
  if(request.kind==='pasted') {
    // Explicit pasted formats retain the legacy open contract; the inspector
    // subsequently parses and catalogues the complete payload before committing.
    // Size and format were both settled above, before any I/O.
    return {kind:'pasted',structureText:request.text,format:request.format!};
  }
  const id=request.kind==='pdb'?request.id.toUpperCase():request.kind==='alphafold'?request.accession:undefined;
  const url=httpsUrl(request.kind==='url'?request.url:request.kind==='pdb'?`https://files.rcsb.org/download/${id}.cif`:`https://alphafold.ebi.ac.uk/files/AF-${id}-F1-model_${ALPHAFOLD_MODEL_VERSION}.cif`);
  let structureText:string;
  try {structureText=request.kind==='pdb' && options.fetchPdbText?await options.fetchPdbText(id!,options.signal):await download(url,options.fetch??fetch,options.signal);}
  catch(error) {throw refuse(`${request.kind==='alphafold'?`AlphaFold ${id} ${ALPHAFOLD_MODEL_VERSION}: `:''}${error instanceof Error?error.message:'The source could not be fetched.'}`);}
  options.signal?.throwIfAborted();
  console.debug('[stereofold:timing] source-fetched', {at:Date.now(),elapsedMs:Date.now()-startedAt,kind:request.kind,bytes:Buffer.byteLength(structureText)});
  const format=sniffStructureFormat(structureText);
  if(request.kind!=='url' && format!=='mmcif') throw refuse('The database did not return mmCIF coordinates.');
  // Public entries are refreshed on each explicit request, preserving RCSB load behavior.
  // Cache writes are atomic and best effort; never consult a stale file after a missing response.
  const cacheKey=request.kind==='url'?undefined:`${request.kind}-${id}${request.kind==='alphafold'?`-${ALPHAFOLD_MODEL_VERSION}`:''}.cif`;
  if(cacheKey && options.cacheRoot!==false && !(request.kind==='pdb' && options.fetchPdbText)) {
    const directory=options.cacheRoot??join(homedir(),'Library/Caches/Stereofold/sources');
    const temporary=join(directory,`.${randomUUID()}.tmp`);
    try {await mkdir(directory,{recursive:true});await writeFile(temporary,structureText,{mode:0o600,flag:'wx'});await rename(temporary,join(directory,cacheKey));}
    catch { /* An unavailable disk cache must not prevent a validated load. */ }
    finally {await rm(temporary,{force:true}).catch(()=>{});}
  }
  return {kind:request.kind,structureText,format,...(request.kind==='pdb'?{pdbId:id}:{}),...(request.kind==='alphafold'?{accession:id,version:ALPHAFOLD_MODEL_VERSION}:{}),...(cacheKey?{cacheKey}:{})};
}

/** Normalize all PDB categories, including models and deposited assembly operators, using bundled Mol*. */
export async function inspectionSource(source:ResolvedStructureSource):Promise<ResolvedStructureSource> {
  if(source.format==='mmcif') return source;
  const [{parsePDB},{pdbToMmCif},{CifWriter}]=await Promise.all([
    import('molstar/lib/commonjs/mol-io/reader/pdb/parser.js'),
    import('molstar/lib/commonjs/mol-model-formats/structure/pdb/to-cif.js'),
    import('molstar/lib/commonjs/mol-io/writer/cif.js'),
  ]);
  const parsed=await parsePDB(source.structureText).run();
  if(parsed.isError) throw refuse('The PDB coordinates could not be parsed.');
  const frame=await pdbToMmCif(parsed.result), encoder=CifWriter.createEncoder({binary:false});
  const depositedModels=source.structureText.split(/\r?\n/).filter(line=>line.startsWith('MODEL ')).map(line=>Number(line.slice(10,14).trim()));
  if(depositedModels.some(n=>!Number.isSafeInteger(n)||n<1) || new Set(depositedModels).size!==depositedModels.length)
    throw refuse('PDB MODEL records must have unique positive model numbers.');
  const atoms=frame.categories.atom_site;
  const entities=frame.categories.entity, sequence=frame.categories.entity_poly_seq;
  const sequenceEntities=new Set(sequence?Array.from({length:sequence.rowCount},(_,i)=>sequence.getField('entity_id')!.str(i)):[]);
  for(let row=0;row<entities.rowCount;row++) {
    if(entities.getField('type')!.str(row)!=='polymer') continue;
    const id=entities.getField('id')!.str(row);
    if(!sequenceEntities.has(id))
      throw refuse('PDB inspection requires SEQRES declaring each polymer sequence; use mmCIF with declared sequences, or stereo_structure.open for the PDB coordinate-only viewer.');
  }
  const chains=new Map<string,string>();
  for(let row=0;row<atoms.rowCount;row++) {
    const chain=atoms.getField('label_asym_id')!.str(row), entity=atoms.getField('label_entity_id')!.str(row);
    if(chains.has(chain) && chains.get(chain)!==entity) throw refuse('A PDB chain maps to conflicting entities across models.');
    chains.set(chain,entity);
  }
  encoder.startDataBlock('source');
  for(const name of frame.categoryNames) {
    const category=frame.categories[name];
    encoder.writeCategory({name,instance:()=>({fields:category.fieldNames.map(fieldName=>{
      const field=category.getField(fieldName)!;
      return CifWriter.Field.str(fieldName,(row:number)=>depositedModels.length && /^(pdbx_)?PDB_model_num$/.test(fieldName) ? String(depositedModels[field.int(row)-1]??field.int(row)) : field.str(row),{valueKind:(row:number)=>field.valueKind(row)});
    }),source:[{rowCount:category.rowCount}]})});
  }
  const chainRows=[...chains];
  encoder.writeCategory({name:'struct_asym',instance:()=>({fields:[
    CifWriter.Field.str('id',(row:number)=>chainRows[row][0]),
    CifWriter.Field.str('entity_id',(row:number)=>chainRows[row][1]),
  ],source:[{rowCount:chainRows.length}]})});
  const structureText=encoder.getData() as string;
  sniffStructureFormat(structureText);
  return {...source,structureText,format:'mmcif'};
}
