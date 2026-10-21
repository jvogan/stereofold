import { createHash } from 'node:crypto';
import { CIF } from './compatible-cif.js';
import { trajectoryFromMmCIF } from 'molstar/lib/commonjs/mol-model-formats/structure/mmcif.js';
import { Symmetry } from 'molstar/lib/commonjs/mol-model/structure/model.js';
import { createCatalogExtractor } from '../../lab/identity/extract-core.cjs';

// Keep this paired with the pinned `molstar` dependency in plugin/package.json.
// The lab wrapper reads the installed manifest at runtime; the plugin bundle
// cannot do that after installation, so it records the same pinned version.
const MOLSTAR_VERSION = '5.11.0';

/**
 * Extract the canonical sequence/assembly catalog for arbitrary mmCIF bytes.
 *
 * This is the very same dependency-injected implementation used by the lab.
 * Every dependency is statically imported, so esbuild includes the extractor
 * and Mol* in `dist/server.mjs`; the installed plugin never resolves the
 * repository's `lab/` tree or calls `createRequire`.
 */
/**
 * Lets the host's other requests run during an extraction.
 *
 * Extraction is CPU work on the thread that also answers panel and headset
 * heartbeats. Run without a break, a 24 MB structure left every request unread
 * for the whole extraction, longer than the desktop panel's 10 s heartbeat
 * grace and than a LAN socket's idle limit. The extractor calls this between
 * residues; it hands the thread back once per 20 ms slice.
 */
const EXTRACTION_SLICE_MS = 20;
let sliceStartedAt = performance.now();
function yieldToHost(): Promise<void> | undefined {
  if (performance.now() - sliceStartedAt < EXTRACTION_SLICE_MS) return undefined;
  return new Promise<void>(resolve => setImmediate(() => { sliceStartedAt = performance.now(); resolve(); }));
}

const extractor = createCatalogExtractor({
  CIF,
  trajectoryFromMmCIF,
  Symmetry,
  molstarVersion: MOLSTAR_VERSION,
  sha256: (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex'),
  yieldToHost,
});

export const extractInspectionCatalogBytes: (
  input: Uint8Array | string,
  options?: { sourceLabel?: string | null; expectedHash?: string; assemblyId?: string },
) => Promise<unknown> = extractor.extractBytes;

/** Read the deposited identity, including local mmCIF sessions without a PDB request. */
export async function inspectionSourcePdbId(text: string): Promise<string | undefined> {
  const parsed = await CIF.parse(text).run();
  if (parsed.isError) return undefined;
  const id = parsed.result.blocks[0]?.categories.entry?.getField('id')?.str(0);
  return id && /^[a-z0-9]{4}$/iu.test(id) ? id.toUpperCase() : undefined;
}
