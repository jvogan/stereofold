import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, extname, isAbsolute } from 'node:path';
import { MAX_INSPECTION_DENSITY_BYTES, MAX_STRUCTURE_SOURCE_BYTES, STRUCTURE_SOURCE_SIZE_LABEL } from './inspection-limits.js';

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM:true });

function unavailable(): Error {
  return Error(`The inspection file must be an absolute regular UTF-8 mmCIF file within the inspector size limit (${STRUCTURE_SOURCE_SIZE_LABEL} source policy, not a measured rendering limit).`);
}

function assertMmCifText(structureText: string): void {
  // Keep the same recognizability boundary as stereo_structure.inspect.
  if (!/^data_\S*/im.test(structureText.trimStart()) || !/_atom_site\./i.test(structureText)) {
    throw Error('The inspection file is not supported mmCIF coordinates.');
  }
}

/**
 * Read at most `limit` bytes of a stable regular file, never following its
 * final path component. The two public readers below differ only in what they
 * accept and what they do with the bytes; the admission, the O_NOFOLLOW open,
 * the one-byte-over-cap read and the stat-read-stat stability check are the
 * same check either way and are written once here.
 */
async function readStableFile(filePath: string, limit: number, missing: () => Error): Promise<Buffer> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    // O_NOFOLLOW protects the final component. Parent aliases are intentionally
    // allowed: the path itself is an explicit, already-authorized local input.
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile() || before.size > limit) throw missing();

    // Allocate for the observed file plus one growth-detection byte, bounded by
    // the admission cap. Small inputs must not allocate the full policy ceiling.
    const bytes = Buffer.allocUnsafe(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > limit) throw missing();

    // A truncation, growth, or replacement observed while reading is not a
    // stable source. Do not parse a partial or mixed file.
    const after = await handle.stat();
    if (!after.isFile() || after.size !== before.size || length !== before.size
      || after.mtimeMs!==before.mtimeMs || after.ctimeMs!==before.ctimeMs) throw missing();
    return bytes.subarray(0, length);
  } finally {
    await handle?.close();
  }
}

/**
 * Read an explicitly supplied local mmCIF file without following its final
 * path component. The caller is responsible for host/user authorization of
 * the absolute path; this helper never resolves workspace roots or URLs.
 */
export async function readInspectionFile(filePath: string): Promise<{ structureText: string; filename: string }> {
  if (typeof filePath !== 'string' || filePath.includes('\0') || !isAbsolute(filePath)) throw unavailable();
  const extension = extname(filePath).toLowerCase();
  if (extension !== '.cif' && extension !== '.mmcif') throw unavailable();
  const filename = basename(filePath);
  if (filename.length === 0) throw unavailable();

  try {
    const bytes = await readStableFile(filePath, MAX_STRUCTURE_SOURCE_BYTES, unavailable);
    let structureText: string;
    try {
      structureText = decoder.decode(bytes);
    } catch {
      throw unavailable();
    }
    assertMmCifText(structureText);
    return { structureText, filename };
  } catch (error) {
    if (error instanceof Error && error.message === 'The inspection file is not supported mmCIF coordinates.') throw error;
    throw unavailable();
  }
}

function densityUnavailable(): Error {
  return Error('The density file must be an absolute regular CCP4/MRC map within the inspector density limit.');
}

const NOT_A_MAP = 'The density file is not a supported CCP4/MRC density map.';

/**
 * What makes these bytes a map rather than an arbitrary 8 MB blob.
 *
 * `readInspectionFile`'s recognizability test is a UTF-8 `data_` block with
 * `_atom_site.` rows in it; none of that survives contact with a binary map, so
 * this is its twin in the map's own header. MRC/CCP4 words 1-3 are the grid
 * extent, word 4 (`mode`) is 2 for the float32 maps Mol*'s `ParseCcp4` reads
 * and `scripts/prepare-map.ts` writes, and the four bytes at offset 208 are the
 * `MAP ` magic. The 1,024-byte header plus one float32 per voxel is then the
 * whole file: a header that disagrees with the file's own length is a truncated
 * download, which is the failure this catches before the digest even runs.
 *
 * Extended headers (`nsymbt`) are deliberately refused rather than skipped:
 * nothing this product prepares writes one, and a map carrying symmetry records
 * would fail the length identity anyway.
 */
function assertCcp4Map(bytes: Buffer): void {
  if (bytes.byteLength < 1024 + 4) throw Error(NOT_A_MAP);
  if (bytes.toString('latin1', 208, 212) !== 'MAP ') throw Error(NOT_A_MAP);
  // MACHST at 212 says which end the words were written from; `MAP ` above has
  // already ruled out a byte-swapped header being read as a plausible grid.
  const columns = bytes.readInt32LE(0), rows = bytes.readInt32LE(4), sections = bytes.readInt32LE(8);
  const mode = bytes.readInt32LE(12), symmetryBytes = bytes.readInt32LE(92);
  if (mode !== 2) throw Error(NOT_A_MAP);
  if (symmetryBytes !== 0) throw Error(NOT_A_MAP);
  if (columns < 1 || rows < 1 || sections < 1 || columns > 4096 || rows > 4096 || sections > 4096) throw Error(NOT_A_MAP);
  if (1024 + columns * rows * sections * 4 !== bytes.byteLength) throw Error(NOT_A_MAP);
}

/**
 * Read an explicitly supplied local density map as BYTES.
 *
 * The map never becomes a string. `readInspectionFile` decodes UTF-8 because an
 * mmCIF source travels as text inside a JSON tool result; a map travels as raw
 * bytes on its own route, and decoding it would corrupt it. Its cap is
 * `MAX_INSPECTION_DENSITY_BYTES` rather than the source cap for the same
 * reason — see `inspection-limits.ts`.
 */
export async function readInspectionDensityFile(filePath: string): Promise<{ bytes: Buffer; filename: string }> {
  if (typeof filePath !== 'string' || filePath.includes('\0') || !isAbsolute(filePath)) throw densityUnavailable();
  const extension = extname(filePath).toLowerCase();
  if (extension !== '.map' && extension !== '.ccp4' && extension !== '.mrc') throw densityUnavailable();
  const filename = basename(filePath);
  if (filename.length === 0) throw densityUnavailable();

  try {
    const bytes = await readStableFile(filePath, MAX_INSPECTION_DENSITY_BYTES, densityUnavailable);
    assertCcp4Map(bytes);
    return { bytes, filename };
  } catch (error) {
    if (error instanceof Error && error.message === NOT_A_MAP) throw error;
    throw densityUnavailable();
  }
}
