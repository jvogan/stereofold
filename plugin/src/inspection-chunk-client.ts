/**
 * The panel half of chunked hydration.
 *
 * A desktop panel reaches the server through the host's MCP Apps bridge, which
 * is the one place a documented host ceiling can bite: Claude's MCP Apps
 * troubleshooting page says a tool result over about 150,000 characters is
 * written to the code-execution sandbox rather than delivered inline, and names
 * app-initiated tool calls that fetch data on demand as the remedy. So
 * `get_inspection` hands this module `{sha256,bytes}` descriptors and this
 * module pulls the bytes in `MAX_INSPECTION_CHUNK_BYTES` slices.
 *
 * The checks here are the same ones `inspection-companion-client.ts` runs over
 * the headset's raw `/source` route: the declared length, then the sha256 of
 * everything assembled, then the catalog's own view of which source it belongs
 * to. A source swapped between two chunk calls fails on the digest rather than
 * assembling half of one structure onto half of another.
 *
 * A comparison structure travels the same route for the desktop panel and the
 * headset page. Its hydration entry carries `{sha256,bytes}` descriptors for
 * its coordinates and its compressed catalog, and each chunk call names the
 * structure with `{sourceSha256, assemblyId}`.
 */
import { MAX_INSPECTION_CHUNK_BYTES, MAX_STRUCTURE_SOURCE_BYTES } from './inspection-limits.js';
import { MAX_INSPECTION_CATALOG_COMPRESSED_BYTES } from './inspection-catalog-codec.js';

const PRIVATE_KEY = 'stereo_structure/inspection';
const SHA256 = /^[a-f0-9]{64}$/u;
export type InspectionBytesDescriptor = { sha256: string; bytes: number };
export type InspectionPart = 'source' | 'catalog';
/** Names one comparison structure held by the session, by its source digest and assembly. */
export type InspectionComparisonKey = { sourceSha256: string; assemblyId: string };
type ToolCall = (name: string, args: Record<string, unknown>) => Promise<any>;

const invalidDescriptor = () => new Error('The inspector returned an invalid coordinate descriptor.');
const changedDuringDelivery = () => new Error('The coordinates changed during delivery. Reconnect before continuing.');

function isDescriptor(value: unknown): value is InspectionBytesDescriptor {
  const descriptor = value as Partial<InspectionBytesDescriptor> | undefined;
  return !!descriptor && typeof descriptor === 'object' && SHA256.test(String(descriptor.sha256))
    && Number.isSafeInteger(descriptor.bytes) && (descriptor.bytes as number) >= 0;
}

function decodeBase64(data: string): Uint8Array {
  if (typeof data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/u.test(data)) throw changedDuringDelivery();
  let binary: string;
  try { binary = atob(data); } catch { throw changedDuringDelivery(); }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Chunked so that a multi-megabyte catalog does not blow the argument stack,
 * and joined once so the pieces are not re-copied into a growing string on
 * every step. A 16 MiB part is 2,048 pieces, and `+=` leaves that quadratic on
 * any engine without a rope optimisation.
 */
export function encodeBase64(bytes: Uint8Array): string {
  const pieces: string[] = [];
  for (let i = 0; i < bytes.length; i += 8192) pieces.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
  return btoa(pieces.join(''));
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

/**
 * The largest a descriptor for each part may declare, so that a bad descriptor
 * is refused rather than reaching `new Uint8Array(total)`.
 *
 * Neither is a new number. A source part is the source itself, held to this
 * plugin's own MAX_STRUCTURE_SOURCE_BYTES download policy everywhere else. A
 * catalog part is the gzip wire, held to what the decoder in
 * `inspection-catalog-codec.ts` will accept for the same 64 MiB decode policy.
 */
const MAX_PART_BYTES: Record<InspectionPart, number> = {
  source: MAX_STRUCTURE_SOURCE_BYTES,
  catalog: MAX_INSPECTION_CATALOG_COMPRESSED_BYTES,
};

/** Assemble one whole part, verifying the declared length and digest. */
export async function assembleInspectionPart(call: ToolCall, sessionId: string, part: InspectionPart,
  descriptor: unknown, comparison?: InspectionComparisonKey): Promise<Uint8Array> {
  const limit: number | undefined = MAX_PART_BYTES[part];
  if (!isDescriptor(descriptor) || typeof sessionId !== 'string' || limit === undefined
    || descriptor.bytes > limit) throw invalidDescriptor();
  const total = descriptor.bytes;
  const assembled = new Uint8Array(total);
  let offset = 0;
  while (offset < total) {
    const byteCount = Math.min(MAX_INSPECTION_CHUNK_BYTES, total - offset);
    const answer = await call('get_inspection_bytes', { sessionId, part, offset, byteCount, ...(comparison ? { comparison } : {}) });
    const chunk = answer?._meta?.[PRIVATE_KEY];
    if (!chunk || chunk.part !== part || chunk.offset !== offset || chunk.totalBytes !== total
      || chunk.sha256 !== descriptor.sha256 || typeof chunk.data !== 'string'
      || (comparison !== undefined && (chunk.comparison?.sourceSha256 !== comparison.sourceSha256
        || chunk.comparison?.assemblyId !== comparison.assemblyId))) throw changedDuringDelivery();
    const bytes = decodeBase64(chunk.data);
    if (bytes.byteLength < 1 || bytes.byteLength !== chunk.byteCount || offset + bytes.byteLength > total)
      throw changedDuringDelivery();
    assembled.set(bytes, offset);
    offset += bytes.byteLength;
    if (chunk.hasMore !== (offset < total)) throw changedDuringDelivery();
  }
  if (await sha256Hex(assembled) !== descriptor.sha256) throw changedDuringDelivery();
  return assembled;
}

/**
 * Fill a chunked hydration in place, so everything downstream reads the same
 * `structureText` and `catalogWire` shape the headset's inline hydration has.
 */
export async function hydrateInspectionBytes(data: any, call: ToolCall): Promise<void> {
  if (!data || typeof data !== 'object') return;
  const sessionId = String(data.sessionId ?? '');
  if (data.sourceBytes !== undefined) {
    if (typeof data.structureText === 'string') throw invalidDescriptor();
    const catalogSourceSha256 = data.catalogWire?.sourceSha256 ?? data.catalog?.source?.sha256;
    if (!isDescriptor(data.sourceBytes)) throw invalidDescriptor();
    if (catalogSourceSha256 !== data.sourceBytes.sha256) throw changedDuringDelivery();
    const bytes = await assembleInspectionPart(call, sessionId, 'source', data.sourceBytes);
    try { data.structureText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw changedDuringDelivery(); }
    delete data.sourceBytes;
  }
  if (data.catalogBytes !== undefined) {
    if (!data.catalogWire || typeof data.catalogWire.data === 'string') throw invalidDescriptor();
    const bytes = await assembleInspectionPart(call, sessionId, 'catalog', data.catalogBytes);
    // The wire's own `compressedBytes` is what the decoder re-checks the base64
    // against, so a short assembly is refused twice over.
    data.catalogWire = { ...data.catalogWire, data: encodeBase64(bytes) };
    delete data.catalogBytes;
  }
}

/**
 * Fill one comparison structure's descriptors in place, so the entry takes the
 * `{id, cif, sha256, catalogWire}` shape the viewer registers.
 *
 * The same cross-checks as the primary: the catalog wire and the coordinates
 * descriptor must name one source digest, that digest is the entry's own
 * `sha256`, and the assembled parts are held to their digests chunk by chunk
 * and again whole. Nothing is registered by this function, so a failure leaves
 * whatever the viewer already holds untouched.
 */
export async function hydrateComparisonSource(source: any, call: ToolCall, sessionId: string): Promise<void> {
  if (!source || typeof source !== 'object' || typeof source.cif === 'string') throw invalidDescriptor();
  const { sourceBytes, catalogBytes, catalogWire } = source;
  if (!isDescriptor(sourceBytes) || !isDescriptor(catalogBytes) || !catalogWire || typeof catalogWire !== 'object'
    || typeof catalogWire.data === 'string' || typeof source.assemblyId !== 'string' || source.assemblyId.length < 1 || source.assemblyId.length > 128) throw invalidDescriptor();
  if (catalogWire.sourceSha256 !== sourceBytes.sha256 || source.sha256 !== sourceBytes.sha256) throw changedDuringDelivery();
  const comparison: InspectionComparisonKey = { sourceSha256: sourceBytes.sha256, assemblyId: source.assemblyId };
  const coordinates = await assembleInspectionPart(call, sessionId, 'source', sourceBytes, comparison);
  let cif: string;
  try { cif = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(coordinates); }
  catch { throw changedDuringDelivery(); }
  const catalog = await assembleInspectionPart(call, sessionId, 'catalog', catalogBytes, comparison);
  source.cif = cif;
  source.catalogWire = { ...catalogWire, data: encodeBase64(catalog) };
  delete source.sourceBytes;
  delete source.catalogBytes;
}
