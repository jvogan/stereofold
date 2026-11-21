import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  INSPECTION_CATALOG_ENCODING,
  INSPECTION_CATALOG_FACTORED_ENCODING,
  MAX_FACTORED_CATALOG_CANONICAL_BYTES,
  MAX_INSPECTION_CATALOG_UNCOMPRESSED_BYTES,
  type InspectionCatalogWire,
} from './inspection-catalog-codec.js';
import { INSPECTION_SIZE_GUIDE } from './inspection-limits.js';

/** Threshold preserves the existing object contract for small catalogs. */
export const INSPECTION_CATALOG_COMPACT_THRESHOLD = 512 * 1024;
export type InspectionCatalogTransport = { catalog: any } | { catalogWire: InspectionCatalogWire };

function digest(bytes: Buffer) { return createHash('sha256').update(bytes).digest('hex'); }
function sourceDigest(catalog: any) {
  const value = catalog?.source?.sha256;
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) throw new Error('The extracted catalog has no valid source digest.');
  return value;
}
function plainWire(json: Buffer, catalog: any): { catalogWire: InspectionCatalogWire } | undefined {
  if (json.byteLength > MAX_INSPECTION_CATALOG_UNCOMPRESSED_BYTES) return undefined;
  const compressed = gzipSync(json, { level: 9 });
  return { catalogWire: { encoding: INSPECTION_CATALOG_ENCODING, data: compressed.toString('base64'), compressedBytes: compressed.byteLength,
    uncompressedBytes: json.byteLength, sourceSha256: sourceDigest(catalog), catalogSha256: digest(json) } };
}

/**
 * Losslessly factor repeated source atoms from assembly copies. The decoder
 * derives canonical identity keys and assembly coordinates from the row's
 * identity and the catalog copy matrix, then verifies canonical JSON bytes.
 */
function factoredWire(catalog: any, canonical: Buffer): { catalogWire: InspectionCatalogWire } | undefined {
  if (canonical.byteLength > MAX_FACTORED_CATALOG_CANONICAL_BYTES || !Array.isArray(catalog?.rows)) return undefined;
  for (const row of catalog.rows) {
    if (!row?.identity || !Array.isArray(row.atomSites) || !Number.isSafeInteger(row.identity.modelNumber)
      || row.atomSites.some((site: any) => typeof site?.identity?.sourceAtomId !== 'string')) return undefined;
  }
  let atomCount = 0;
  const atomIndexes = new Map<string, number>();
  const atoms: any[] = [];
  const rows = catalog.rows.map((row: any) => {
    if (!row || !row.identity || !Array.isArray(row.atomSites)) throw new Error('The extracted catalog is malformed.');
    const refs = row.atomSites.map((site: any) => {
      atomCount++;
      const model = row.identity.modelNumber;
      const atomId = site?.identity?.sourceAtomId;
      if (!Number.isSafeInteger(model) || typeof atomId !== 'string') return -1;
      const dictionaryKey = `${model}:${atomId}`;
      let index = atomIndexes.get(dictionaryKey);
      if (index === undefined) {
        index = atoms.length; atomIndexes.set(dictionaryKey, index);
        atoms.push({ atomName: site.identity.atomName, authorAtomName: site.identity.authorAtomName,
          alternateSite: site.identity.alternateSite, sourceAtomId: atomId, element: site.element,
          sourceCoordinatesAngstrom: site.sourceCoordinatesAngstrom });
      }
      return index;
    });
    return { identity: row.identity, entityType: row.entityType, sequenceDeclared: row.sequenceDeclared,
      mappingOrigin: row.mappingOrigin, coordinateState: row.coordinateState, atomRefs: refs };
  });
  const compact = Buffer.from(JSON.stringify({ schemaVersion: 1, source: catalog.source, molstarVersion: catalog.molstarVersion,
    assemblyId: catalog.assemblyId, modelNumbers: catalog.modelNumbers, copies: catalog.copies, atoms, rows }), 'utf8');
  if (compact.byteLength > MAX_INSPECTION_CATALOG_UNCOMPRESSED_BYTES) return undefined;
  const compressed = gzipSync(compact, { level: 9 });
  return { catalogWire: { encoding: INSPECTION_CATALOG_FACTORED_ENCODING, data: compressed.toString('base64'), compressedBytes: compressed.byteLength,
    uncompressedBytes: compact.byteLength, canonicalBytes: canonical.byteLength, atomSites: atomCount,
    sourceSha256: sourceDigest(catalog), catalogSha256: digest(canonical) } };
}

const megabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;
const CATALOG_OVER_DECODE_LIMIT = 'Structure and sequence catalog exceeds the 64 MiB this plugin decodes in one browser.';
/**
 * The fewest bytes one residue row can occupy in either transport, with the
 * comma that follows it. A factored row carries the row's identity with every
 * value at its smallest except the source digest, which every row repeats in
 * full, empty metadata and no atom references. A canonical row holds the same
 * identity and metadata plus its key and atom sites, so it is never shorter.
 * Computed from that record so it cannot drift from the encoder above.
 */
export const MIN_CATALOG_BYTES_PER_ROW = JSON.stringify({
  identity: { sourceHash: '0'.repeat(64), modelNumber: 0, assemblyId: '', generatorIndex: 0, operatorIds: [], copyId: '',
    entityId: '', labelChain: '', authorChain: '', labelSequenceId: 0, authorResidue: 0, insertionCode: '', componentId: '' },
  entityType: '', sequenceDeclared: true, mappingOrigin: '', coordinateState: '', atomRefs: [],
}).length + 1;
/**
 * The most residue rows a catalog can hold and still fit the 64 MiB decode
 * policy in either transport. A catalog with more rows is refused by
 * `inspectionCatalogWire` whatever its contents, so the extractor refuses it
 * before building the rows. This derives from the byte policy and adds no
 * limit of its own. The `+ 1` is the last row's absent separator.
 */
export const MAX_INSPECTION_CATALOG_ROWS = Math.floor(MAX_INSPECTION_CATALOG_UNCOMPRESSED_BYTES / MIN_CATALOG_BYTES_PER_ROW) + 1;
/**
 * The most residue rows a source may declare, across all its chains and
 * models, when an assembly is requested. The assembly's own rows are still
 * held to `MAX_INSPECTION_CATALOG_ROWS`; this bounds the rows Mol* and the
 * extractor walk before the assembly selects its chains, so a small assembly
 * of a large entry is not refused for chains it leaves out. It is about six
 * times the catalog limit, and a source past it is refused from its
 * declarations before Mol* builds a model.
 */
export const MAX_INSPECTION_DECLARED_ROWS = 1_000_000;
/** The refusal for a source whose declarations expand past `maximum` rows. */
export function inspectionCatalogRowsRefusal(rows: number, maximum = MAX_INSPECTION_CATALOG_ROWS): Error {
  return new Error(`${CATALOG_OVER_DECODE_LIMIT} Its declarations expand to at least ${rows.toLocaleString('en-US')} residue rows;`
    + ` at most ${maximum.toLocaleString('en-US')} fit. ${INSPECTION_SIZE_GUIDE}`);
}
/**
 * The compressed wire, whatever the catalog's size.
 *
 * `inspectionCatalogTransport` below keeps small catalogs as plain objects for
 * the inline hydration the headset reads. A chunked hydration has no inline
 * shape to preserve and one code path to keep: it always takes a wire, so that
 * a panel's delivery does not change behaviour at a size threshold.
 */
export function inspectionCatalogWire(catalog: any,
  json = Buffer.from(JSON.stringify(catalog), 'utf8')): { catalogWire: InspectionCatalogWire } {
  // Canonical catalogs factor repeated identity/coordinate fields losslessly.
  // Compress that transport once. Building a second full canonical gzip only
  // to discard it blocked source delivery; legacy catalogs keep the plain path.
  const factored = factoredWire(catalog, json);
  return factored ?? plainWire(json, catalog)
    ?? (() => { throw new Error(`${CATALOG_OVER_DECODE_LIMIT} It is ${megabytes(json.byteLength)} uncompressed. ${INSPECTION_SIZE_GUIDE}`); })();
}
export function inspectionCatalogTransport(catalog: any): InspectionCatalogTransport {
  const json = Buffer.from(JSON.stringify(catalog), 'utf8');
  if (json.byteLength <= INSPECTION_CATALOG_COMPACT_THRESHOLD) return { catalog };
  // The same buffer the threshold was measured on, so a large catalog is
  // stringified once rather than once here and again inside the wire builder.
  return inspectionCatalogWire(catalog, json);
}
