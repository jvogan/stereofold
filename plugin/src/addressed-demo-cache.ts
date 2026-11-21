/** Immutable coordinate identities shared by launchers, scenes and growth. */
import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { writeVerifiedCacheFile } from './verified-cache-write.js';

export const DEMO_CACHE_DIGESTS_TO_KEEP = 3;
const usedThisRun = new Set<string>();
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Full SHA-256, before the extension; no truncation collisions. */
export function addressedDemoFile(file: string, sha256: string): string {
  if (!/^[0-9a-f]{64}$/i.test(sha256)) throw Error('Expected a full SHA-256 cache identity');
  sha256 = sha256.toLowerCase();
  const ext = extname(file), stem = file.slice(0, file.length - ext.length);
  return stem.endsWith(`.${sha256}`) ? file : `${stem}.${sha256}${ext}`;
}

/** Resolve existing ancestors without creating missing cache directories. */
function canonicalCachePath(path: string): string {
  try { return realpathSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  try { lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return resolve(canonicalCachePath(dirname(path)), basename(path));
  }
  throw Error('Demo cache path contains a dangling symlink');
}

/** Validate names before resolution, and confine both new and existing files. */
export function confinedDemoPath(cachePath: (file: string) => string, file: string): string {
  if (!file || isAbsolute(file) || win32.isAbsolute(file)
    || file.split(/[/\\]/u).some(segment => !segment || segment === '..')) {
    throw Error('Demo cache file must be a relative name without empty or parent segments');
  }
  const root = canonicalCachePath(resolve(cachePath('.'))), path = cachePath(file);
  const child = relative(root, canonicalCachePath(resolve(path)));
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw Error('Demo cache file must remain inside the canonical cache root');
  }
  return path;
}

export function addressedDemoPath(cachePath: (file: string) => string, file: string, sha256: string): string {
  // Validate the original name before adding a digest can hide empty segments.
  confinedDemoPath(cachePath, file);
  const path = confinedDemoPath(cachePath, addressedDemoFile(file, sha256));
  usedThisRun.add(resolve(path));
  return path;
}

/** Read a verified snapshot. Copy matching legacy bytes, never move/delete them. */
export async function readAddressedDemoFile(cachePath: (file: string) => string, file: string, sha256: string): Promise<{
  path: string; bytes: Buffer;
} | undefined> {
  const path = addressedDemoPath(cachePath, file, sha256);
  for (const candidate of [path, confinedDemoPath(cachePath, file)]) {
    const bytes = await readFile(candidate).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!bytes || digest(bytes) !== sha256.toLowerCase()) continue;
    if (candidate !== path) await writeVerifiedCacheFile(path, bytes, sha256.toLowerCase());
    return { path, bytes };
  }
  return undefined;
}

/**
 * Deferred maintenance only, never called by a launcher or live scene. Keep at
 * least the three most recently modified digests. Files used in this process
 * cannot be pruned, and an older file needs a positive host-idleness check.
 * Omit isUnused to plan cleanup without deleting anything. The maintenance
 * caller must exclude hosts that may reopen paths, not just open descriptors.
 */
export async function pruneAddressedDemoFiles(legacyPath: string, options: {
  keep?: number;
  isUnused?: (path: string) => Promise<boolean>;
} = {}): Promise<{ retained: string[]; candidates: string[]; removed: string[] }> {
  const keep = options.keep ?? DEMO_CACHE_DIGESTS_TO_KEEP;
  if (!Number.isSafeInteger(keep) || keep < DEMO_CACHE_DIGESTS_TO_KEEP) throw Error('Keep at least three digests');
  const directory = dirname(legacyPath), ext = extname(legacyPath);
  const prefix = `${basename(legacyPath, ext)}.`;
  const files = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const revisions = await Promise.all(files.filter(file => file.startsWith(prefix) && file.endsWith(ext)
    && /^[0-9a-f]{64}$/.test(file.slice(prefix.length, ext ? -ext.length : undefined)))
    .map(async file => {
      const path = resolve(join(directory, file)), info = await stat(path);
      return { path, info };
    }));
  revisions.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs || a.path.localeCompare(b.path));
  const retained = revisions.slice(0, keep).map(r => r.path);
  const candidates: string[] = [], removed: string[] = [];
  for (const { path, info } of revisions.slice(keep)) {
    if (!info.isFile() || usedThisRun.has(path)) { retained.push(path); continue; }
    candidates.push(path);
    if (options.isUnused && await options.isUnused(path)) {
      // An asynchronous host check may have allowed this process to use it.
      if (usedThisRun.has(path)) { retained.push(path); continue; }
      await rm(path, { force: true });
      removed.push(path);
    } else retained.push(path);
  }
  return { retained, candidates, removed };
}
