import { randomBytes, timingSafeEqual } from 'node:crypto';
import { lstat, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export function hasLocalControlToken(header: string | undefined, token: string): boolean {
  if (header?.length !== 71 || token.length !== 64) return false;
  const match = /^Bearer ([a-f0-9]{64})$/.exec(header ?? '');
  return Boolean(match && /^[a-f0-9]{64}$/.test(token) && timingSafeEqual(Buffer.from(match[1]), Buffer.from(token)));
}

/** Replace a control file atomically; never follow its final symlink or retain loose modes. */
export async function writeLocalControlState(path: string, value: unknown): Promise<void> {
  try {
    const prior = await lstat(path);
    if (!prior.isFile() || prior.isSymbolicLink()) throw Error('Control state must be a regular file, not a symbolic link.');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const temporary = join(dirname(path), `.${basename(path)}.${randomBytes(12).toString('hex')}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
