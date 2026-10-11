/** Bounded browser decoder for complete, source-scoped inspection catalogs. */
export const INSPECTION_CATALOG_ENCODING = 'gzip+base64' as const;
export const INSPECTION_CATALOG_FACTORED_ENCODING = 'gzip+base64+factored-v1' as const;
/**
 * The 4 MiB compressed-catalog cap and the 200,000
 * factored-atom-site cap that used to sit here were invented to keep one JSON
 * tool result small. They refused 1XCK and 1S5L outright. The catalog now
 * travels in 96 KiB chunks to a desktop panel, so neither protects a transport
 * any more and both are gone. The residue-position
 * and atom-site budgets that `inspection-server.ts` used to hold an inspection
 * to are gone too, for the same reason. Nothing counts residues or atoms to
 * refuse a structure now.
 *
 * What remains is MEMORY POLICY for the machine doing the decoding, and it
 * bounds an allocation rather than refusing a structure anybody measured:
 * 64 MiB of decoded catalog JSON, and 256 MiB of reconstructed canonical JSON
 * for a factored assembly, which expands from the same 64 MiB.
 */
export const MAX_INSPECTION_CATALOG_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
/**
 * The compressed bound, DERIVED from the decoded bound rather than chosen.
 *
 * The comment that used to sit here capped the compressed payload at the
 * decoded bound and reasoned that gzip output past it could not decode inside
 * it. That has the implication backwards. Gzip output is LARGER than its input
 * when the input does not compress: DEFLATE stores an incompressible block as
 * at most 65,535 bytes behind a 5-byte header (RFC 1951), inside gzip's own
 * 10-byte header and 8-byte trailer (RFC 1952). So the encoder in
 * `inspection-catalog-codec-server.ts` can take a catalog that is within the
 * 64 MiB decode policy and still emit a wire a few kilobytes past it, which the
 * old bound made this decoder refuse. This is that worst case, so the encoder
 * and the decoder agree on one number and neither refuses what the other emits.
 */
export const MAX_INSPECTION_CATALOG_COMPRESSED_BYTES = MAX_INSPECTION_CATALOG_UNCOMPRESSED_BYTES
  + Math.ceil(MAX_INSPECTION_CATALOG_UNCOMPRESSED_BYTES / 65_535) * 5 + 18;
export const MAX_FACTORED_CATALOG_CANONICAL_BYTES = 256 * 1024 * 1024;
export type InspectionCatalogWire = {
  encoding: typeof INSPECTION_CATALOG_ENCODING | typeof INSPECTION_CATALOG_FACTORED_ENCODING; data: string; compressedBytes: number;
  uncompressedBytes: number; sourceSha256: string; catalogSha256: string; canonicalBytes?: number; atomSites?: number;
};
const SHA256 = /^[a-f0-9]{64}$/u;
function invalidCatalog(): Error { return new Error('The inspector returned an invalid sequence catalog. Reconnect before continuing.'); }
function base64Bytes(data:string, expectedBytes:number):Uint8Array { if(data.length!==4*Math.ceil(expectedBytes/3)||!/^[A-Za-z0-9+/]*={0,2}$/u.test(data)) throw invalidCatalog(); let decoded:string;try{decoded=atob(data);}catch{throw invalidCatalog();}const bytes=new Uint8Array(decoded.length);for(let i=0;i<decoded.length;i++)bytes[i]=decoded.charCodeAt(i);return bytes; }
async function gunzip(bytes:Uint8Array, expectedBytes:number, limit:number):Promise<Uint8Array>{
  if(typeof DecompressionStream!=='function') throw new Error('This browser cannot decode the inspection catalog.');
  const reader=new Blob([bytes.slice().buffer as ArrayBuffer]).stream().pipeThrough(new DecompressionStream('gzip')).getReader(); const chunks:Uint8Array[]=[];let total=0;
  try{for(;;){const next=await reader.read();if(next.done)break;total+=next.value.byteLength;if(total>limit||total>expectedBytes){await reader.cancel();throw new Error('The inspection catalog exceeds the browser decode limit.');}chunks.push(next.value);}}catch(error){try{await reader.cancel();}catch{}if(error instanceof Error&&/browser decode limit/u.test(error.message))throw error;throw invalidCatalog();}
  if(total!==expectedBytes)throw invalidCatalog();const output=new Uint8Array(total);let offset=0;for(const chunk of chunks){output.set(chunk,offset);offset+=chunk.byteLength;}return output;
}
function validateCatalog(value:unknown, sourceSha256:string):any {if(!value||typeof value!=='object'||Array.isArray(value))throw invalidCatalog();const catalog=value as {source?:{sha256?:unknown}};if(catalog.source?.sha256!==sourceSha256||!SHA256.test(sourceSha256))throw invalidCatalog();return catalog;}
function residueKey(i:any){return JSON.stringify(['residue-v1',i.sourceHash,i.modelNumber,i.copyId,i.entityId,i.labelChain,i.authorChain,i.labelSequenceId,i.authorResidue,i.insertionCode,i.componentId]);}
function atomKey(i:any){return JSON.stringify(['atom-v1',residueKey(i),i.atomName,i.authorAtomName,i.alternateSite,i.sourceAtomId]);}
function applyOperator(point:any,matrix:any){if(!Array.isArray(point)||point.length!==3||!Array.isArray(matrix)||matrix.length!==16)throw invalidCatalog();const [x,y,z]=point;if(![x,y,z,...matrix].every(Number.isFinite)||[matrix[3],matrix[7],matrix[11],matrix[15]-1].some(v=>Math.abs(v)>1e-9))throw invalidCatalog();return [matrix[0]*x+matrix[4]*y+matrix[8]*z+matrix[12],matrix[1]*x+matrix[5]*y+matrix[9]*z+matrix[13],matrix[2]*x+matrix[6]*y+matrix[10]*z+matrix[14]];}
/**
 * The canonical JSON `reconstructFactored` emits for ONE atom site with every
 * value at its smallest: an empty key, an empty identity, a null element and
 * two [0,0,0] triples, plus the comma that separates it from the next site.
 * Computed from that record rather than written down, so it cannot drift from
 * the emitter below.
 */
const MIN_CANONICAL_BYTES_PER_ATOM_SITE = JSON.stringify({ key: '', identity: {}, element: null,
  sourceCoordinatesAngstrom: [0, 0, 0], assemblyCoordinatesAngstrom: [0, 0, 0] }).length + 1;
/**
 * The most atom sites a wire declaring `canonicalBytes` of canonical JSON could
 * reconstruct to. Each site occupies its own non-overlapping span of that JSON,
 * and `canonicalBytes` is already held to MAX_FACTORED_CATALOG_CANONICAL_BYTES,
 * so this is derived from a named policy and invents no count of its own.
 *
 * It is here so a wire that declares an impossible number of atom sites is
 * refused BEFORE `reconstructFactored` expands every ref, rather than only by
 * the equality check afterwards. The `+ 1` is the last site's absent separator.
 */
const maxFactoredAtomSites = (canonicalBytes:number) =>
  Math.floor(canonicalBytes / MIN_CANONICAL_BYTES_PER_ATOM_SITE) + 1;
function reconstructFactored(value:any, declaredAtomSites:number):any {
  if(!value||value.schemaVersion!==1||!Array.isArray(value.copies)||!Array.isArray(value.atoms)||!Array.isArray(value.rows))throw invalidCatalog();
  const matrixByCopy=new Map(value.copies.map((copy:any)=>[copy?.copyId,copy?.matrix])); let atomCount=0;
  const rows=value.rows.map((row:any)=>{if(!row?.identity||!Array.isArray(row.atomRefs))throw invalidCatalog();const matrix=matrixByCopy.get(row.identity.copyId);const key=residueKey(row.identity);const atomSites=row.atomRefs.map((ref:any)=>{if(!Number.isSafeInteger(ref)||ref<0||ref>=value.atoms.length)throw invalidCatalog();if(++atomCount>declaredAtomSites)throw invalidCatalog();const source=value.atoms[ref];if(!source||typeof source.sourceAtomId!=='string')throw invalidCatalog();const identity={...row.identity,atomName:source.atomName,authorAtomName:source.authorAtomName,alternateSite:source.alternateSite,sourceAtomId:source.sourceAtomId};return {key:atomKey(identity),identity,element:source.element,sourceCoordinatesAngstrom:source.sourceCoordinatesAngstrom,assemblyCoordinatesAngstrom:applyOperator(source.sourceCoordinatesAngstrom,matrix)};});return {key,identity:row.identity,entityType:row.entityType,sequenceDeclared:row.sequenceDeclared,mappingOrigin:row.mappingOrigin,coordinateState:row.coordinateState,atomSites};});
  // Not a cap: the wire declares its own atom-site count, and a reconstruction
  // that disagrees with it did not come from the catalog that was encoded. The
  // over-count half is already refused above, one ref at a time, so no wire can
  // expand past its own declaration before this line is reached.
  if(atomCount!==declaredAtomSites)throw invalidCatalog(); return {schemaVersion:'draft-identity-1',source:value.source,molstarVersion:value.molstarVersion,assemblyId:value.assemblyId,modelNumbers:value.modelNumbers,copies:value.copies,rows};
}
async function sha256(bytes:Uint8Array):Promise<string>{return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes.slice().buffer as ArrayBuffer))].map(value=>value.toString(16).padStart(2,'0')).join('');}
export async function decodeInspectionCatalog(value:unknown):Promise<any>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw invalidCatalog();const candidate=value as Partial<InspectionCatalogWire>&{source?:{sha256?:unknown}};
  if(candidate.encoding!==INSPECTION_CATALOG_ENCODING&&candidate.encoding!==INSPECTION_CATALOG_FACTORED_ENCODING){if(candidate.source?.sha256&&SHA256.test(String(candidate.source.sha256)))return value;throw invalidCatalog();}
  const factored=candidate.encoding===INSPECTION_CATALOG_FACTORED_ENCODING, compressedBytes=candidate.compressedBytes,uncompressedBytes=candidate.uncompressedBytes;
  if(typeof candidate.data!=='string'||!Number.isSafeInteger(compressedBytes)||!Number.isSafeInteger(uncompressedBytes)||!SHA256.test(String(candidate.sourceSha256))||!SHA256.test(String(candidate.catalogSha256))||compressedBytes!<1||compressedBytes!>MAX_INSPECTION_CATALOG_COMPRESSED_BYTES||uncompressedBytes!<1||uncompressedBytes!>MAX_INSPECTION_CATALOG_UNCOMPRESSED_BYTES)throw invalidCatalog();
  if(factored&&(!Number.isSafeInteger(candidate.canonicalBytes)||candidate.canonicalBytes!<1||candidate.canonicalBytes!>MAX_FACTORED_CATALOG_CANONICAL_BYTES||!Number.isSafeInteger(candidate.atomSites)||candidate.atomSites!<0||candidate.atomSites!>maxFactoredAtomSites(candidate.canonicalBytes as number)))throw invalidCatalog();
  const compressed=base64Bytes(candidate.data,compressedBytes as number);if(compressed.byteLength!==compressedBytes)throw invalidCatalog();const bytes=await gunzip(compressed,uncompressedBytes as number,MAX_INSPECTION_CATALOG_UNCOMPRESSED_BYTES);let parsed:unknown;try{parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw invalidCatalog();}
  const catalog=factored?reconstructFactored(parsed,candidate.atomSites as number):parsed;const canonical=new TextEncoder().encode(JSON.stringify(catalog));if((factored&&canonical.byteLength!==candidate.canonicalBytes)||await sha256(canonical)!==candidate.catalogSha256)throw invalidCatalog();return validateCatalog(catalog,String(candidate.sourceSha256));
}
export async function verifyInspectionCatalogSource(text:string,catalog:any):Promise<void>{if(typeof text!=='string'||!catalog?.source?.sha256||!SHA256.test(catalog.source.sha256))throw invalidCatalog();if(await sha256(new TextEncoder().encode(text))!==catalog.source.sha256)throw new Error('The coordinates changed during delivery. Reconnect before continuing.');}
