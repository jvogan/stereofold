/**
 * What the packaged runtime was built from, as one hash.
 *
 * `setup-doctor.ts` used to answer "is dist current?" by comparing
 * modification times, and a modification time is a fact about a filesystem
 * rather than about bytes. Checking out this repository a second time — which
 * is what every development worktree is — writes every source file with a fresh
 * mtime and none of the dist files, so a runtime that is byte-for-byte the one
 * those sources build reports itself stale, and the operator either rebuilds
 * for nothing or learns to pass `--allow-stale-build` and stops reading the
 * line at all. Both outcomes cost more than the check is worth.
 *
 * So `scripts/build.ts` records this hash of its inputs beside the bundles it
 * emits, and the doctor recomputes it. Equal means the runtime was built from
 * these exact source bytes, whatever the clock says. Unequal means it was not,
 * and that is a real answer rather than a heuristic. A dist with no stamp — a
 * release artifact, or anything built before this file existed — is reported
 * as unknown, never as fresh.
 *
 * The content and modification-time checks share the input paths below,
 * including bundled hosts, their helpers and workspace dependencies.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

/** The stamp `scripts/build.ts` writes into the dist it just emitted. */
export const BUILD_INPUT_STAMP_FILE = 'build-inputs.json';
/** Bumped when the hashing rule changes, so an old stamp reads unknown rather than stale. */
export const BUILD_INPUT_STAMP_VERSION = 3;

export type BuildInputStamp = { version: number; hash: string; files: number; builtAt?: string };

/**
 * Everything a build reads, named from the plugin root.
 *
 * Generated outputs and disposable caches are skipped by the walk below, so
 * naming a directory here never drags a build output into its own input hash.
 */
export function buildInputPaths(pluginRoot: string): string[] {
  const repositoryRoot = resolve(pluginRoot, '..');
  return [
    resolve(pluginRoot, 'src'),
    // Bundled hosts and their shared helpers live beside the build script.
    // Omitting these lets a changed child host retain a "fresh" source stamp.
    resolve(pluginRoot, 'scripts'),
    resolve(pluginRoot, 'package.json'),
    resolve(repositoryRoot, 'package.json'),
    resolve(repositoryRoot, 'pnpm-lock.yaml'),
    resolve(repositoryRoot, 'pnpm-workspace.yaml'),
    resolve(repositoryRoot, 'lab/browser-roundtrip'),
    resolve(repositoryRoot, 'lab/inspection'),
    resolve(repositoryRoot, 'packages/anaglyph'),
    resolve(repositoryRoot, 'packages/geometry'),
    resolve(repositoryRoot, 'packages/motion'),
  ];
}

/** Shared by the byte digest and legacy modification-time fallback. */
export function isBuildInputEntry(name: string): boolean {
  return name !== 'node_modules' && name !== 'dist' && name !== '__pycache__'
    && !name.startsWith('.') && !/\.py[co]$/u.test(name);
}

async function collectFiles(path: string, into: string[]): Promise<void> {
  let details;
  try { details = await stat(path); } catch { return; }
  if (details.isFile()) { into.push(path); return; }
  if (!details.isDirectory()) return;
  for (const entry of (await readdir(path, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
    if (!isBuildInputEntry(entry.name)) continue;
    await collectFiles(resolve(path, entry.name), into);
  }
}

/**
 * The digest of every build input that exists, or null when none of them do.
 *
 * Null is the honest answer for a release artifact, which ships `dist/`
 * without the sources that made it: there is nothing to compare, and saying
 * "stale" about a tree that was never here would be a lie.
 *
 * Each file contributes its repository-relative path and the digest of its
 * bytes, in sorted path order, so the hash is the same in any checkout of the
 * same content and changes when a file is added, removed, renamed or edited.
 */
export async function hashBuildInputs(pluginRoot: string): Promise<{ hash: string; files: number } | null> {
  const repositoryRoot = resolve(pluginRoot, '..');
  const found: string[] = [];
  for (const path of buildInputPaths(pluginRoot)) await collectFiles(path, found);
  if (!found.length) return null;
  const unique = [...new Set(found)].sort((left, right) => relative(repositoryRoot, left).localeCompare(relative(repositoryRoot, right)));
  const digest = createHash('sha256');
  for (const path of unique) {
    digest.update(relative(repositoryRoot, path));
    digest.update('\0');
    digest.update(createHash('sha256').update(await readFile(path)).digest('hex'));
    digest.update('\n');
  }
  return { hash: digest.digest('hex'), files: unique.length };
}

/** The stamp a dist carries, or null when it has none, is unreadable, or was written by another rule. */
export async function readBuildInputStamp(distRoot: string): Promise<BuildInputStamp | null> {
  const raw = await readFile(resolve(distRoot, BUILD_INPUT_STAMP_FILE), 'utf8').catch(() => undefined);
  if (raw == null) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const stamp = value as Record<string, unknown>;
  if (stamp.version !== BUILD_INPUT_STAMP_VERSION) return null;
  if (typeof stamp.hash !== 'string' || !/^[a-f0-9]{64}$/u.test(stamp.hash)) return null;
  return { version: BUILD_INPUT_STAMP_VERSION, hash: stamp.hash,
    files: typeof stamp.files === 'number' && Number.isInteger(stamp.files) ? stamp.files : 0,
    ...(typeof stamp.builtAt === 'string' ? { builtAt: stamp.builtAt } : {}) };
}
