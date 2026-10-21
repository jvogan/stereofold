/** The launcher and live growth rebuild the same recipe from verified sources. */
import { dirname } from 'node:path';
import { buildRigidComposite, compositeSha256, isModelledCompositeSource } from './demo-rigid-composite.js';
import { readCompositeRecipe, readModelledCompositeSource } from './demo-composite-files.js';
import { readInspectionFile } from './inspection-file.js';
import { MAX_STRUCTURE_SOURCE_BYTES } from './inspection-limits.js';
import { writeVerifiedCacheFile } from './verified-cache-write.js';
export { compositeRecipePath, readModelledCompositeSource } from './demo-composite-files.js';

export type CompositeCacheHooks = {
  demosRoot?: string;
  cachePath: (file: string) => string;
  fetchText: (url: string) => Promise<string>;
  log?: (message: string) => void;
};

/** Both indexed recipes and inline recipes use these full-digest source paths.
 * Prepared outputs use addressed-demo-cache (indexed) or composites/<digest>.cif
 * (handles); no recipe publishes to an unversioned coordinate name. */
export async function resolveCompositeSource(source: { id: string; url: string; sha256: string }, hooks: CompositeCacheHooks): Promise<string> {
  const path = hooks.cachePath(`composite-sources/${source.sha256}-${source.id}.cif`);
  let text = await readInspectionFile(path).then(value => value.structureText, () => undefined);
  if (text === undefined || compositeSha256(text) !== source.sha256) {
    hooks.log?.(`  fetching ${source.url}`);
    text = await hooks.fetchText(source.url);
    if (Buffer.byteLength(text, 'utf8') > MAX_STRUCTURE_SOURCE_BYTES) throw Error('Source exceeds the 64 MiB source policy.');
    if (compositeSha256(text) !== source.sha256) throw Error(`Source ${source.id} sha256 mismatch`);
    await writeVerifiedCacheFile(path, text, source.sha256);
  }
  return text;
}

export async function resolveCompositeText(recipePath: string, hooks: CompositeCacheHooks): Promise<string> {
  const recipe = await readCompositeRecipe(recipePath, hooks.demosRoot);
  const sources: Record<string, string> = Object.create(null);
  for (const source of recipe.sources) sources[source.id] = isModelledCompositeSource(source)
    ? await readModelledCompositeSource(dirname(recipePath), source, hooks.demosRoot)
    : await resolveCompositeSource(source, hooks);
  hooks.log?.(`  building rigid composite ${recipe.id}`);
  return (await buildRigidComposite(recipe, sources)).text;
}
