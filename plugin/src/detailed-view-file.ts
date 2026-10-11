import { constants, open } from 'node:fs/promises';
import { extname, isAbsolute } from 'node:path';
import { MAX_DETAILED_VIEW_SNAPSHOT_BYTES } from './detailed-view-import.js';

/**
 * Reads one Mol* state file the user saved from the full viewer.
 *
 * The file arrives from a browser download directory, so it gets the same
 * treatment as every other local artifact this server reads: an absolute path
 * with a known extension, no symlink on the final component, a size bound
 * checked before the read, and a stat comparison that refuses a file rewritten
 * underneath it.
 */
const EXTENSIONS = ['.molj', '.json'] as const;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

function reject(message: string): never { throw Error(`Detailed view import rejected: ${message}`); }

export async function readDetailedViewSnapshotFile(filePath: unknown, limit = MAX_DETAILED_VIEW_SNAPSHOT_BYTES): Promise<string> {
  if (typeof filePath !== 'string' || filePath.includes('\0') || !isAbsolute(filePath) || !EXTENSIONS.includes(extname(filePath).toLowerCase() as typeof EXTENSIONS[number])) {
    reject('supply the absolute path of a .molj or .json state file saved from the full Mol* viewer.');
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile() || before.size > limit) reject(`${filePath} exceeds its bounded artifact size.`);
    const bytes = Buffer.allocUnsafe(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > limit) reject(`${filePath} exceeds its bounded artifact size.`);
    const after = await handle.stat();
    if (!after.isFile() || after.size !== before.size || length !== before.size
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      reject(`${filePath} changed while it was being read.`);
    }
    try { return decoder.decode(bytes.subarray(0, length)); }
    catch { return reject(`${filePath} is not valid UTF-8 text.`); }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Detailed view import rejected:')) throw error;
    return reject(`cannot read ${typeof filePath === 'string' ? filePath : 'that path'} as a stable regular file.`);
  } finally {
    await handle?.close();
  }
}
