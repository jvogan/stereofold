/** Inline rigid recipes and durable, coordinate-free source capabilities. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { buildRigidComposite, compositeSha256, rigidCompositeRecipeSchema, validateCompositePlacements } from './demo-rigid-composite.js';
import { resolveCompositeSource } from './demo-composite-cache.js';
import { demoCoordinatePath } from './molecular-growth.js';
import { readInspectionFile } from './inspection-file.js';
import { readBoundedJsonFile } from './inspection-scene-file.js';
import { MAX_STRUCTURE_SOURCE_BYTES } from './inspection-limits.js';
import { resolveStructureSource, sniffStructureFormat } from './structure-sources.js';
import { writeVerifiedCacheFile } from './verified-cache-write.js';

const sha256 = z.string().regex(/^[0-9a-f]{64}$/i).transform(s => s.toLowerCase());
export const compositeHandleSchema = z.string().uuid().describe('Opaque handle returned by prepare_composite; valid while its files remain in this runtime host\'s cache, including after restart.');
export const inlineCompositeRecipeSchema = z.object({
  ...rigidCompositeRecipeSchema.shape,
  sources: z.array(z.object({
    id: z.string().regex(/^[A-Za-z0-9]{4}$/).transform(s => s.toUpperCase()).describe('Four-character RCSB entry ID. Bodies refer to this ID, case-insensitively.'),
    sha256: sha256.optional().describe('Optional exact source digest. Omitted: reuse the verified cached RCSB revision, or download and record one.'),
  }).strict()).refine(v => v.length > 0, 'Expected at least one source'),
  bodies: z.array(rigidCompositeRecipeSchema.shape.bodies.element.extend({
    source: z.string().regex(/^[A-Za-z0-9]{4}$/).transform(s => s.toUpperCase()),
    authChains: rigidCompositeRecipeSchema.shape.bodies.element.shape.authChains.describe('Author chains in the first deposited model. Each must retain atoms.'),
    residues: rigidCompositeRecipeSchema.shape.bodies.element.shape.residues.describe('Inclusive author residue numbers; trims polymers only.'),
    ligands: rigidCompositeRecipeSchema.shape.bodies.element.shape.ligands.describe('Explicit component IDs retained whole on these author chains; water is excluded.'),
    atoms: rigidCompositeRecipeSchema.shape.bodies.element.shape.atoms.describe('all, or backbone (N, CA, C, O, CB); ligand atoms remain whole.'),
    chain: rigidCompositeRecipeSchema.shape.bodies.element.shape.chain.describe('Unique output author chain/body ID. Extra label chains are returned in the mapping.'),
  })).refine(v => v.length > 0, 'Expected at least one body'),
}).strict().superRefine((recipe, ctx) => {
  validateCompositePlacements(recipe.bodies, ctx);
  const ids = new Set<string>(), chains = new Set<string>();
  recipe.sources.forEach((s, i) => {
    if (ids.has(s.id)) ctx.addIssue({ code: 'custom', path: ['sources', i, 'id'], message: 'Source ids must be unique' });
    ids.add(s.id);
  });
  recipe.bodies.forEach((b, i) => {
    if (!ids.has(b.source)) ctx.addIssue({ code: 'custom', path: ['bodies', i, 'source'], message: `Unknown source ${b.source}` });
    if (chains.has(b.chain)) ctx.addIssue({ code: 'custom', path: ['bodies', i, 'chain'], message: 'Output chains must be unique' });
    chains.add(b.chain);
  });
});
export const prepareCompositeSchema = z.object({
  recipe: inlineCompositeRecipeSchema,
  maximumAtomSites: z.number().safe().int().positive().optional().describe('Optional caller budget for the total output atom sites, checked during construction. Ordinary inspection has no universal atom-site cap; the 64 MiB source policy always applies.'),
}).strict();
export type PrepareCompositeInput = z.infer<typeof prepareCompositeSchema>;
const artifactSchema = z.object({ sha256, bytes: z.number().int().positive(), atomSites: z.number().int().positive() });

export function createPreparedCompositeStore(options: {
  cachePath?: (file: string) => string;
  fetchPdbText?: (id: string) => Promise<string>;
  fetch?: typeof fetch;
} = {}) {
  const cachePath = options.cachePath ?? demoCoordinatePath;
  const fetchText = async (id: string) => (await resolveStructureSource({ kind: 'pdb', id }, {
    fetchPdbText: options.fetchPdbText, fetch: options.fetch, cacheRoot: false,
  })).structureText;
  return {
    async prepare(raw: PrepareCompositeInput) {
      const { recipe, maximumAtomSites } = prepareCompositeSchema.parse(raw);
      const texts: Record<string, string> = Object.create(null);
      const sources = [];
      for (const [i, source] of recipe.sources.entries()) {
        try {
          const pointer = cachePath(`composite-sources/${source.id}.json`);
          let digest = source.sha256;
          if (!digest) {
            const cached = await readBoundedJsonFile(pointer).catch(() => undefined);
            const parsed = sha256.safeParse(cached);
            if (parsed.success) digest = parsed.data;
          }
          let downloaded: string | undefined;
          if (!digest) { downloaded = await fetchText(source.id); digest = compositeSha256(downloaded); }
          const verified = { ...source, sha256: digest, url: `https://files.rcsb.org/download/${source.id}.cif` };
          texts[source.id] = await resolveCompositeSource(verified, { cachePath,
            fetchText: async () => downloaded ?? fetchText(source.id) });
          // A pinned request must not change the default cached RCSB revision.
          if (!source.sha256) {
            const json = JSON.stringify(digest);
            await writeVerifiedCacheFile(pointer, json, compositeSha256(json));
          }
          sources.push(verified);
        } catch (error) { throw Error(`recipe.sources[${i}]: ${error instanceof Error ? error.message : String(error)}`); }
      }
      const built = await buildRigidComposite({ ...recipe, sources }, texts, { maximumAtomSites });
      if (built.bytes > MAX_STRUCTURE_SOURCE_BYTES) throw Error('Composite exceeds the 64 MiB source policy. Reduce its bodies, residue ranges or atom detail.');
      sniffStructureFormat(built.text);
      const { text, ...artifact } = built;
      const handle = randomUUID();
      const identity = { source: { kind: 'composite' as const, handle }, ...artifact,
        sources: sources.map(({ id, sha256 }) => ({ id, sha256 })) };
      // Already content-addressed. Re-preparing reuses the bytes and keeps all
      // prior handle manifests valid; it never retargets an existing handle.
      await writeVerifiedCacheFile(cachePath(`composites/${built.sha256}.cif`), text, built.sha256);
      const manifest = JSON.stringify({ sha256: built.sha256, bytes: built.bytes, atomSites: built.atomSites });
      await writeVerifiedCacheFile(cachePath(`composites/${handle}.json`), manifest, compositeSha256(manifest));
      return identity;
    },
    async resolve(handle: string): Promise<string> {
      compositeHandleSchema.parse(handle);
      let artifact;
      try { artifact = artifactSchema.parse(await readBoundedJsonFile(cachePath(`composites/${handle}.json`))); }
      catch { throw Error('Unknown or expired composite handle. Call prepare_composite again on this runtime host.'); }
      const { structureText } = await readInspectionFile(cachePath(`composites/${artifact.sha256}.cif`));
      if (Buffer.byteLength(structureText, 'utf8') !== artifact.bytes || compositeSha256(structureText) !== artifact.sha256)
        throw Error('Composite artifact failed digest verification. Call prepare_composite again.');
      return structureText;
    },
  };
}
