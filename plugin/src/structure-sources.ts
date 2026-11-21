import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { readInspectionFile } from './inspection-file.js';
import { fetchFollowingHttpsRedirects, httpsDownloadUrl } from './bounded-download.js';
import { INSPECTION_SIZE_GUIDE, MAX_STRUCTURE_SOURCE_BYTES, STRUCTURE_SOURCE_SIZE_LABEL, STRUCTURE_SOURCE_DOWNLOAD_TIMEOUT_MS } from './inspection-limits.js';
import { MAX_INSPECTION_DECLARED_ROWS, inspectionCatalogRowsRefusal } from './inspection-catalog-codec-server.js';

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
export const SOURCE_DESCRIPTION = 'Supply source with kind pdb (four-character id), alphafold (UniProt accession, model_v6), url (https mmCIF or PDB, content-sniffed), file (absolute local .cif/.mmcif path), pasted (coordinates), or composite (handle from prepare_composite). '
  + `This plugin fetches or reads at most ${MAX_STRUCTURE_SOURCE_BYTES.toLocaleString('en-US')} bytes (${STRUCTURE_SOURCE_SIZE_LABEL}) of structure text, which is its own download policy rather than a viewer ceiling, and no residue-position or atom-site count refuses an inspection. `
  + `${INSPECTION_SIZE_GUIDE} `
  + 'So do not tell a person that a GroEL-sized assembly is too large for the desktop viewer: 1AON and other entries that earlier builds refused now open, but admission alone does not establish rendering speed or memory use on a headset. Missing AlphaFold v6 files are refused without a version fallback. PDB inspection requires declared polymer SEQRES; coordinate-only PDB remains available through open.';
const accession = /^[OPQ][0-9][A-Z0-9]{3}[0-9]$|^[A-NR-Z][0-9](?:[A-Z][A-Z0-9]{2}[0-9]){1,2}$/;
export const structureSourceSchema = z.discriminatedUnion('kind', [
  z.object({kind:z.literal('composite'),handle:z.string().uuid().describe('Opaque handle returned by prepare_composite on this runtime host.')}).strict(),
  z.object({kind:z.literal('pdb'),id:z.string().regex(/^[A-Za-z0-9]{4}$/)}).strict(),
  z.object({kind:z.literal('alphafold'),accession:z.string().transform(v=>v.toUpperCase()).pipe(z.string().regex(accession))}).strict(),
  z.object({kind:z.literal('url'),url:z.string().min(1).max(8192)}).strict(),
  z.object({kind:z.literal('file'),path:z.string().min(1).max(4096)}).strict(),
  z.object({kind:z.literal('pasted'),text:z.string().min(20).max(MAX_STRUCTURE_SOURCE_BYTES),format:z.enum(['pdb','mmcif']).optional()}).strict(),
]);
export type StructureSourceRequest = z.output<typeof structureSourceSchema>;
export type ResolvedStructureSource = {kind:StructureSourceRequest['kind'];structureText:string;format:'mmcif'|'pdb';pdbId?:string;accession?:string;version?:string;cacheKey?:string;sourceFilename?:string};
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
  try {return httpsDownloadUrl(value);} catch(error) {throw refuse((error as Error).message);}
}
async function download(url:URL, fetcher:typeof fetch, cancellation?:AbortSignal):Promise<string> {
  const timeout=AbortSignal.timeout(STRUCTURE_SOURCE_DOWNLOAD_TIMEOUT_MS);
  const signal=cancellation?AbortSignal.any([cancellation,timeout]):timeout;
  const response=await fetchFollowingHttpsRedirects(url.href,{signal,headers:{Accept:'chemical/x-cif, chemical/x-pdb, text/plain;q=0.9'}},fetcher);
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
export async function resolveStructureSource(raw:unknown, options:{fetch?:typeof fetch;fetchPdbText?:(id:string,signal?:AbortSignal)=>Promise<string>;cacheRoot?:string|false;signal?:AbortSignal;resolveComposite?:(handle:string)=>Promise<string>}={}):Promise<ResolvedStructureSource> {
  const startedAt=Date.now();
  options.signal?.throwIfAborted();
  const request=assertStructureSourceRequest(raw);
  if(request.kind==='composite') {
    if(!options.resolveComposite) throw Error('Composite handles require the runtime that prepared them.');
    const structureText=await options.resolveComposite(request.handle);
    sniffStructureFormat(structureText);
    return {kind:'composite',structureText,format:'mmcif'};
  }
  if(request.kind==='file') {
    try {const {structureText,filename}=await readInspectionFile(request.path);
      // Display provenance only: never retain a directory or infer a public
      // entry identity from the user's filename. The digest identifies bytes.
      const sourceFilename=filename.replace(/[\p{Cc}\p{Cf}]/gu,' ').slice(0,160);
      console.debug('[stereofold:timing] source-fetched', {at:Date.now(),elapsedMs:Date.now()-startedAt,kind:request.kind,bytes:Buffer.byteLength(structureText)});
      return {kind:'file',format:'mmcif',structureText,sourceFilename};}
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

/** The most sequence-alignment cells Mol* may fill for one PDB file: a 5,000-residue chain against 5,000 SEQRES names. */
export const MAX_PDB_ALIGNMENT_CELLS=25_000_000;
/** The most steps Mol* may spend classifying a PDB file's residue names. */
export const MAX_PDB_NAME_SCAN_STEPS=25_000_000;
/**
 * The work Mol* does converting PDB text to mmCIF that is not linear in the
 * file's size, counted from the text in one pass, the way Mol* reads it, never
 * below what Mol* does. A line ends at \n, \r or \r\n.
 *
 * `rows`: it lists the unobserved residues of every model by visiting every
 * SEQRES residue of every chain once per model. A line that starts with SEQRES
 * declares the whitespace-separated names from column 20 on, however many and
 * whatever count it states, and at least one; each line that starts with
 * "MODEL " opens a model, with or without atoms, an atom before the first of
 * them opens one more, and there is at least one.
 *
 * `alignmentCells`: it aligns each chain's observed residues in the first model
 * against that chain's SEQRES names, filling three matrices of observed x names
 * cells. A residue is observed each time an ATOM or HETATM record's chain
 * (column 22), residue number (columns 23-26, read as Mol* reads an integer) or
 * insertion code (column 27) differs from the previous record's, until a record
 * falls in another model. Like Mol*, those columns are read at their offsets
 * from the start of the record even when the record is shorter.
 *
 * `nameScanSteps`: the first time a residue name appears, it scans forward over
 * every following record with the same residue number, whatever the chain or
 * model. Every name is counted as new, although Mol* skips the scan for names
 * it knows.
 */
export function pdbConversionWork(text:string):{rows:number;alignmentCells:number;nameScanSteps:number} {
  const code=(i:number)=>text.charCodeAt(i);
  // Mol*'s Tokenizer.trim: spaces and tabs off both ends of [from, to).
  const trimmed=(from:number,to:number):[number,number]=>{
    let s=from, e=to-1, c=code(s);
    while((c===9||c===32) && s<=e) c=code(++s);
    c=code(e);
    while((c===9||c===32) && e>=s) c=code(--e);
    return [s,e+1];
  };
  // Mol*'s integer parse of a token, with its `|| 0`.
  const integer=([from,to]:[number,number]):number=>{
    let i=from, value=0, sign=1;
    if(code(i)===45) { sign=-1; ++i; } else if(code(i)===43) ++i;
    for(;i<to;i++) {
      const digit=code(i)-48;
      if(digit>9||digit<0) return ((sign*value)|0)||0;
      value=(10*value+digit)|0;
    }
    return (sign*value)||0;
  };
  // Mol* reads '.' and '?' in a one-character column as empty.
  const column=(i:number)=>{ const c=text.charAt(i); return c==='.'||c==='?'?'':c; };
  let residues=0, models=0, atomBeforeModel=false;
  const seqres=new Map<string,number>(), observed=new Map<string,number>();
  let firstModel:string|undefined, observing=true, previousChain='', previousNumber=-99999, previousCode='___';
  const names=new Set<string>();
  let nameScanSteps=0, runNumber:number|undefined, newNamesInRun=0;
  const ends=/\r\n|\r|\n/g, tokens=/\S+/g;
  for(let start=0;start<text.length;) {
    const end=ends.exec(text), stop=end?end.index:text.length;
    if(text.startsWith('SEQRES',start)) {
      // Counted without keeping them: one line may hold millions. A name never
      // spans the line end, which is whitespace.
      let count=0;
      tokens.lastIndex=start+19;
      for(let token=tokens.exec(text);token && token.index<stop;token=tokens.exec(text)) count++;
      const chain=start+11<stop?text.charAt(start+11):'';
      residues+=Math.max(1,count);
      seqres.set(chain,(seqres.get(chain)??0)+Math.max(1,count));
    } else if(text.startsWith('MODEL ',start)) models++;
    else if(text.startsWith('ATOM  ',start)||text.startsWith('HETATM',start)) {
      if(!models) { atomBeforeModel=true; }
      const model=String(Math.max(1,models+(atomBeforeModel?1:0)));
      const number=integer(trimmed(start+22,start+26));
      if(observing) {
        firstModel??=model;
        if(model!==firstModel) observing=false;
        else {
          const chain=column(start+21), insertion=code(start+26)===32?'':column(start+26);
          if(chain!==previousChain || number!==previousNumber || insertion!==previousCode) {
            observed.set(chain,(observed.get(chain)??0)+1);
            previousChain=chain; previousNumber=number; previousCode=insertion;
          }
        }
      }
      if(number!==runNumber) { runNumber=number; newNamesInRun=0; }
      const [from,to]=trimmed(start+17,start+21), name=text.substring(from,to);
      if(!names.has(name)) { names.add(name); newNamesInRun++; }
      nameScanSteps+=newNamesInRun;
    }
    start=end?ends.lastIndex:text.length;
  }
  let alignmentCells=0;
  for(const [chain,count] of observed) alignmentCells+=count*(seqres.get(chain)??0);
  return {rows:residues*Math.max(1,models+(atomBeforeModel?1:0)),alignmentCells,nameScanSteps};
}
/** `pdbConversionWork(text).rows`. */
export function pdbDeclaredRowCount(text:string):number { return pdbConversionWork(text).rows; }
/**
 * Refuse PDB text whose conversion by Mol* would not be linear in its size,
 * before Mol* parses or converts it: SEQRES residues times models past the
 * bound the mmCIF paths hold declared rows to, or an alignment or residue-name
 * scan past its own bound.
 */
export function admitPdbConversion(text:string):void {
  const work=pdbConversionWork(text);
  if(!(work.rows<=MAX_INSPECTION_DECLARED_ROWS)) throw inspectionCatalogRowsRefusal(work.rows,MAX_INSPECTION_DECLARED_ROWS);
  if(!(work.alignmentCells<=MAX_PDB_ALIGNMENT_CELLS)) throw Error(`This PDB file's SEQRES records would take ${work.alignmentCells.toLocaleString('en-US')}`
    +` sequence-alignment steps to match to its residues; at most ${MAX_PDB_ALIGNMENT_CELLS.toLocaleString('en-US')} are allowed.`
    +' Use the structure\'s mmCIF file, or remove its SEQRES records.');
  if(!(work.nameScanSteps<=MAX_PDB_NAME_SCAN_STEPS)) throw Error(`This PDB file's residue names would take ${work.nameScanSteps.toLocaleString('en-US')}`
    +` steps to classify, because records with new residue names share residue numbers; at most ${MAX_PDB_NAME_SCAN_STEPS.toLocaleString('en-US')} are allowed.`
    +' Use the structure\'s mmCIF file, or give each residue its own number.');
}

/** Normalize all PDB categories, including models and deposited assembly operators, using bundled Mol*. */
export async function inspectionSource(source:ResolvedStructureSource):Promise<ResolvedStructureSource> {
  if(source.format==='mmcif') return source;
  admitPdbConversion(source.structureText);
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
