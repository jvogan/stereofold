/** Confined recipe and ingredient reads shared by runtime, CLI and packaging. */
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compositeSha256, parseRigidCompositeRecipe, type ModelledCompositeSource } from './demo-rigid-composite.js';
import { readStableFile } from './inspection-file.js';
import { MAX_STRUCTURE_SOURCE_BYTES } from './inspection-limits.js';

export const demosRoot = fileURLToPath(new URL('../demos/', import.meta.url));

export function compositeRecipePath(recipe: string, root = demosRoot): string {
  if (!recipe || isAbsolute(recipe) || recipe.includes('\\') || recipe.split('/').some(s => s === '..' || s === '.' || !s)) {
    throw Error('Composite recipe must be a path relative to demos/');
  }
  return resolve(root, recipe);
}

export async function readConfinedCompositeFile(path: string, root = demosRoot): Promise<string> {
  const [canonicalRoot, canonicalPath] = await Promise.all([realpath(root), realpath(path)]);
  const child = relative(canonicalRoot, canonicalPath);
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw Error('Composite file must remain inside demos/');
  }
  const bytes = await readStableFile(canonicalPath, MAX_STRUCTURE_SOURCE_BYTES, () => Error('Composite file must be a regular file within the source size limit.'));
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}

export async function readCompositeRecipe(path: string, root = demosRoot) {
  return parseRigidCompositeRecipe(await readConfinedCompositeFile(path, root));
}

export async function readModelledCompositeSource(recipeDirectory: string, source: ModelledCompositeSource, root = demosRoot): Promise<string> {
  const text = await readConfinedCompositeFile(resolve(recipeDirectory, source.file), root);
  if (compositeSha256(text) !== source.sha256) throw Error(`Source ${source.id} sha256 mismatch`);
  return text;
}
