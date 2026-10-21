/** Prepare a recipe offline from <source id>.cif files already on disk. */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRigidComposite, isModelledCompositeSource } from '../src/demo-rigid-composite.js';
import { writeVerifiedCacheFile } from '../src/verified-cache-write.js';
import { demosRoot, readCompositeRecipe, readConfinedCompositeFile, readModelledCompositeSource } from '../src/demo-composite-files.js';
import { addressedDemoPath } from '../src/addressed-demo-cache.js';

export const usage = 'Usage: pnpm --dir plugin exec tsx scripts/prepare-composite.ts <recipe.json> --sources <dir> --out <file> (recipe and ingredients must be inside demos/; deposited sources are <dir>/<id>.cif, modelled ones sit beside the recipe; writes <stem>.<sha256>.<ext>; reports path)';
export function parsePrepareCompositeArgs(argv: readonly string[]): { recipe: string; sources: string; out: string } {
  const recipe = argv[0];
  if (!recipe || recipe.startsWith('--')) throw Error(usage);
  const options: Record<string, string> = {};
  for (let i = 1; i < argv.length; i += 2) {
    const key = argv[i], value = argv[i + 1];
    if (!['--sources', '--out'].includes(key) || !value || value.startsWith('--') || options[key]) throw Error(usage);
    options[key] = value;
  }
  if (!options['--sources'] || !options['--out']) throw Error(usage);
  return { recipe, sources: options['--sources'], out: options['--out'] };
}

export async function main(argv: readonly string[], log = console.log, root = demosRoot): Promise<number> {
  if (argv.length === 0 || argv[0] === '--help') { log(usage); return 0; }
  const args = parsePrepareCompositeArgs(argv);
  const recipe = await readCompositeRecipe(resolve(args.recipe), root);
  const sources: Record<string, string> = Object.create(null);
  // Deposited sources come from --sources; a modelled source ships beside the recipe.
  for (const source of recipe.sources) sources[source.id] = isModelledCompositeSource(source)
    ? await readModelledCompositeSource(dirname(resolve(args.recipe)), source, root)
    // Deposited sources live in the download cache, so confine each one to --sources, not demos/.
    : await readConfinedCompositeFile(resolve(args.sources, `${source.id}.cif`), resolve(args.sources));
  const { text, ...counts } = await buildRigidComposite(recipe, sources);
  const path = addressedDemoPath(file => resolve(file), args.out, counts.sha256);
  await writeVerifiedCacheFile(path, text, counts.sha256);
  log(JSON.stringify({ path, ...counts }));
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${(error as Error).message}\n`); process.exitCode = 1; }
}
