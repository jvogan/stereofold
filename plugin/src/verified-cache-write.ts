import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

// Same-process writers may share bytes, but must not race different digests
// onto a path that another caller is about to use.
const writing = new Map<string, { sha256: string; count: number }>();

/** Publish verified bytes atomically, then check the actual published file. */
export async function writeVerifiedCacheFile(path: string, data: string | Uint8Array, sha256: string): Promise<void> {
  path = resolve(path);
  const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  if (digest(data) !== sha256) throw Error(`Cache ${path}: sha256 mismatch before write`);
  const active = writing.get(path);
  if (active && active.sha256 !== sha256) throw Error(`Cache ${path}: conflicting concurrent sha256 values`);
  const state = active ?? { sha256, count: 0 };
  state.count++;
  writing.set(path, state);
  const staging = `${path}.${randomUUID()}.partial`;
  try {
    // Durable handles and other builds can reuse these exact immutable bytes.
    if (await readFile(path).then(bytes => digest(bytes) === sha256, () => false)) return;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(staging, data, { mode: 0o600, flag: 'wx' });
    await rename(staging, path);
    if (digest(await readFile(path)) !== sha256) throw Error(`Cache ${path}: published file sha256 mismatch`);
  } finally {
    try { await rm(staging, { force: true }); }
    finally { if (--state.count === 0) writing.delete(path); }
  }
}
