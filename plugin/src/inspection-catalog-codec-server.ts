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
  const plain = plainWire(json, catalog);
  const factored = factoredWire(catalog, json);
  // Prefer the smaller complete representation. Factoring is now a transfer
  // saving rather than the difference between opening and being refused: a
  // desktop panel pulls whichever wire this returns in 96 KiB chunks.
  if (plain && factored) return factored.catalogWire.compressedBytes < plain.catalogWire.compressedBytes ? factored : plain;
  // The only way to reach this is a catalog past this Mac's 64 MiB decode
  // policy, which is a memory bound on the machine rather than a viewer limit.
  return plain ?? factored
    ?? (() => { throw new Error('Structure and sequence catalog exceeds the 64 MiB this plugin decodes in one browser.'
      + ` It is ${megabytes(json.byteLength)} uncompressed. ${INSPECTION_SIZE_GUIDE}`); })();
}
export function inspectionCatalogTransport(catalog: any): InspectionCatalogTransport {
  const json = Buffer.from(JSON.stringify(catalog), 'utf8');
  if (json.byteLength <= INSPECTION_CATALOG_COMPACT_THRESHOLD) return { catalog };
  // The same buffer the threshold was measured on, so a large catalog is
  // stringified once rather than once here and again inside the wire builder.
  return inspectionCatalogWire(catalog, json);
}
