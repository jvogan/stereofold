import { mkdtemp, mkdir, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readInspectionDensityFile, readInspectionFile } from '../src/inspection-file.js';
import { MAX_INSPECTION_DENSITY_BYTES, MAX_STRUCTURE_SOURCE_BYTES } from '../src/inspection-limits.js';
import { syntheticMap } from './synthetic-map.js';

const roots: string[] = [];
async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'stereofold-inspection-file-'));
  roots.push(root);
  return root;
}
function mmcif(padding = ''): string {
  return `data_example\n#\n_atom_site.id 1\n_atom_site.type_symbol C\n#\n${padding}`;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('readInspectionFile', () => {
  it('returns byte-exact UTF-8 mmCIF text and its basename from an explicit absolute file', async () => {
    const root = await temporaryRoot();
    const path = resolve(root, 'large-example.mmcif');
    const text = mmcif('é'.repeat(36_000));
    await writeFile(path, text, 'utf8');

    await expect(readInspectionFile(path)).resolves.toEqual({ structureText: text, filename: 'large-example.mmcif' });
  });

  it('rejects non-mmCIF extensions and relative paths before opening a source', async () => {
    const root = await temporaryRoot();
    const pdb = resolve(root, 'protein.pdb');
    await writeFile(pdb, 'ATOM      1  N   GLY A   1\n');

    await expect(readInspectionFile(pdb)).rejects.toThrow(/absolute regular UTF-8 mmCIF/i);
    await expect(readInspectionFile('protein.cif')).rejects.toThrow(/absolute regular UTF-8 mmCIF/i);
  });

  it('rejects invalid UTF-8 and incomplete mmCIF payloads without exposing their contents', async () => {
    const root = await temporaryRoot();
    const invalidUtf8 = resolve(root, 'invalid.cif');
    const truncated = resolve(root, 'truncated.mmcif');
    await writeFile(invalidUtf8, Buffer.from([0x64, 0x61, 0x74, 0x61, 0x5f, 0xff]));
    await writeFile(truncated, 'data_cutoff\n#\n');

    await expect(readInspectionFile(invalidUtf8)).rejects.toThrow(/absolute regular UTF-8 mmCIF/i);
    await expect(readInspectionFile(truncated)).rejects.toThrow(/not supported mmCIF/i);
  });

  it('rejects symlinked targets and directories while allowing no source dereference', async () => {
    const root = await temporaryRoot();
    const target = resolve(root, 'target.mmcif');
    const linked = resolve(root, 'linked.mmcif');
    const directory = resolve(root, 'directory.cif');
    await writeFile(target, mmcif());
    await symlink(target, linked);
    await mkdir(directory);

    await expect(readInspectionFile(linked)).rejects.toThrow(/absolute regular UTF-8 mmCIF/i);
    await expect(readInspectionFile(directory)).rejects.toThrow(/absolute regular UTF-8 mmCIF/i);
  });

  it('rejects sources over the admission cap and leaves them removable after failure', async () => {
    const root = await temporaryRoot();
    const path = resolve(root, 'oversized.mmcif');
    await writeFile(path, Buffer.alloc(MAX_STRUCTURE_SOURCE_BYTES + 1, 0x61));

    await expect(readInspectionFile(path)).rejects.toThrow(/size limit/i);
    await truncate(path, 0);
    await writeFile(path, mmcif());
    await expect(readInspectionFile(path)).resolves.toMatchObject({ filename: 'oversized.mmcif' });
  });
});

describe('readInspectionDensityFile', () => {
  // Every case below is built in the test: no map is downloaded, and the
  // 8.39 MB cached asset is never opened.
  const map = syntheticMap;

  it('returns the bytes untouched, and never a string', async () => {
    const root = await temporaryRoot();
    const path = resolve(root, 'emd-fixture.map');
    const bytes = map();
    await writeFile(path, bytes);

    const read = await readInspectionDensityFile(path);
    expect(read.filename).toBe('emd-fixture.map');
    expect(Buffer.isBuffer(read.bytes)).toBe(true);
    // Byte-identical. A map that went through a UTF-8 decode would still have a
    // plausible length and an unusable payload.
    expect(read.bytes.equals(bytes)).toBe(true);
    for (const extension of ['.ccp4', '.mrc']) {
      const other = resolve(root, `emd-fixture${extension}`);
      await writeFile(other, bytes);
      await expect(readInspectionDensityFile(other)).resolves.toMatchObject({ filename: `emd-fixture${extension}` });
    }
  });

  it('refuses coordinates, however well formed, and anything that is not an absolute path', async () => {
    const root = await temporaryRoot();
    const coordinates = resolve(root, 'structure.cif');
    await writeFile(coordinates, 'data_example\n_atom_site.id 1\n');
    await expect(readInspectionDensityFile(coordinates)).rejects.toThrow(/density limit/i);
    // Even the right bytes under the wrong extension: the two routes are not
    // interchangeable and the extension is the first thing that says which.
    const disguised = resolve(root, 'actually-a-map.cif');
    await writeFile(disguised, map());
    await expect(readInspectionDensityFile(disguised)).rejects.toThrow(/density limit/i);
    await expect(readInspectionDensityFile('relative.map')).rejects.toThrow(/density limit/i);
    await expect(readInspectionDensityFile(`${root}/nul\0.map`)).rejects.toThrow(/density limit/i);
    await expect(readInspectionDensityFile(resolve(root, 'absent.map'))).rejects.toThrow(/density limit/i);
  });

  it('catches a truncated download on the header\'s own length identity', async () => {
    const root = await temporaryRoot();
    const path = resolve(root, 'truncated.map');
    const bytes = map();
    await writeFile(path, bytes);
    // One float32 short of what the header promises, which is exactly what a
    // download cut off at the end looks like — and what the digest would also
    // catch, but only after 8 MB had already been read and handed on.
    await truncate(path, bytes.byteLength - 4);
    await expect(readInspectionDensityFile(path)).rejects.toThrow(/not a supported CCP4\/MRC density map/i);
  });

  it('refuses a header that is not the one this product writes', async () => {
    const root = await temporaryRoot();
    const cases: Array<[string, (bytes: Buffer) => void]> = [
      // No `MAP ` magic at 208: not a CCP4/MRC file at all.
      ['no-magic.map', bytes => bytes.write('....', 208, 'latin1')],
      // Mode 0 is int8. Mol*'s ParseCcp4 reads it; nothing here prepares it,
      // and the length identity below is written for float32.
      ['mode-zero.map', bytes => bytes.writeInt32LE(0, 12)],
      // An extended symmetry header, which would shift every voxel.
      ['symmetry.map', bytes => bytes.writeInt32LE(80, 92)],
      // A grid that does not describe the bytes present.
      ['wrong-grid.map', bytes => bytes.writeInt32LE(9, 0)],
      ['zero-grid.map', bytes => bytes.writeInt32LE(0, 0)],
      ['absurd-grid.map', bytes => bytes.writeInt32LE(5_000, 0)],
    ];
    for (const [name, edit] of cases) {
      const path = resolve(await temporaryRoot(), name);
      await writeFile(path, map(8, edit));
      await expect(readInspectionDensityFile(path), name).rejects.toThrow(/not a supported CCP4\/MRC density map/i);
    }
  });

  it('stops at the density cap rather than reading whatever is on disk', async () => {
    const root = await temporaryRoot();
    const path = resolve(root, 'oversized.map');
    // One byte past the cap. The cap is the density one, not the source one:
    // the filament's real map is 8.39 MB and would not survive the 4 MB
    // coordinate limit.
    await writeFile(path, Buffer.alloc(MAX_INSPECTION_DENSITY_BYTES + 1));
    await expect(readInspectionDensityFile(path)).rejects.toThrow(/density limit/i);
    expect(MAX_INSPECTION_DENSITY_BYTES).toBeGreaterThan(8_389_632);
  });

  it('never follows a symlink at the final component', async () => {
    const root = await temporaryRoot();
    const real = resolve(root, 'real.map');
    const link = resolve(root, 'link.map');
    await writeFile(real, map());
    await symlink(real, link);
    await expect(readInspectionDensityFile(link)).rejects.toThrow(/density limit/i);
    await expect(readInspectionDensityFile(real)).resolves.toMatchObject({ filename: 'real.map' });
  });

  it('refuses a directory that happens to be named like a map', async () => {
    const root = await temporaryRoot();
    const path = resolve(root, 'directory.map');
    await mkdir(path);
    await expect(readInspectionDensityFile(path)).rejects.toThrow(/density limit/i);
  });
});
