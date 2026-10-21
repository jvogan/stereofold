import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeVerifiedCacheFile } from '../src/verified-cache-write.js';
import { compositeSha256 } from '../src/demo-rigid-composite.js';
import { resolveCompositeText } from '../src/demo-composite-cache.js';
import { resolveCoordinates, type DemoEntry } from '../scripts/quest-demo.js';
import { ensureGrowthCoordinates } from '../src/growth-coordinates.js';
import { addressedDemoFile } from '../src/addressed-demo-cache.js';

vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, rename: vi.fn(fs.rename) };
});
const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const fixture = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');
const otherFixture = await readFile(new URL('../../fixtures/4HHB.cif', import.meta.url), 'utf8');
const sha256 = compositeSha256(fixture);
const dirs: string[] = [];
async function workspace() {
  const dir = await mkdtemp(resolve(tmpdir(), 'stereofold-cache-write-')); dirs.push(dir); return dir;
}
afterEach(async () => {
  vi.mocked(rename).mockReset().mockImplementation(fs.rename);
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
const entry = (): DemoEntry => ({ name: 'fixture', title: 'Fixture', pdbId: '1CRN', lesson: 'fixture.json', sources: [],
  coordinates: { file: 'out.cif', sha256, bytes: Buffer.byteLength(fixture), atomSites: 327,
    download: 'https://files.rcsb.org/download/1CRN.cif' } });

describe('atomic verified cache publication', () => {
  it('keeps an addressed file invisible until the complete staging file is renamed', async () => {
    const dir = await workspace(), path = resolve(dir, addressedDemoFile('out.cif', sha256));
    await writeFile(resolve(dir, 'out.cif'), otherFixture);
    let staged!: () => void, release!: () => void;
    const ready = new Promise<void>(r => { staged = r; });
    const gate = new Promise<void>(r => { release = r; });
    vi.mocked(rename).mockImplementationOnce(async (from, to) => {
      expect(await readFile(from, 'utf8')).toBe(fixture);
      expect(to).toBe(path);
      staged(); await gate; await fs.rename(from, to);
    });
    const writing = resolveCoordinates(entry(), dir, () => {}, { fetchText: async () => fixture });
    await ready;
    try {
      await expect(readFile(path)).rejects.toThrow();
      expect(await readFile(resolve(dir, 'out.cif'), 'utf8')).toBe(otherFixture);
    } finally { release(); }
    expect(await writing).toBe(path);
    expect(await readFile(path, 'utf8')).toBe(fixture);
    expect((await readdir(dir)).filter(file => file.endsWith('.partial'))).toEqual([]);
  });

  it.each(['launcher', 'growth', 'source'])('%s gives concurrent writers unique staging files', async route => {
    const dir = await workspace();
    const stages: string[] = [];
    let release!: () => void;
    const bothStaged = new Promise<void>(r => { release = r; });
    vi.mocked(rename).mockImplementation(async (from, to) => {
      stages.push(String(from));
      if (stages.length === 2) release();
      await bothStaged;
      await fs.rename(from, to);
    });
    const recipePath = resolve(dir, 'recipe.json');
    await writeFile(recipePath, JSON.stringify({ version: 1, id: 'fixture', title: 'Fixture',
      sources: [{ id: '1CRN', url: entry().coordinates.download, sha256 }],
      bodies: [{ source: '1CRN', authChains: ['A'], atoms: 'all', chain: 'H', matrix: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]] }] }));
    const run = () => route === 'source'
      ? resolveCompositeText(recipePath, { demosRoot: dir, cachePath: () => resolve(dir, 'out.cif'), fetchText: async () => fixture })
      : route === 'launcher' ? resolveCoordinates(entry(), dir, () => {}, { fetchText: async () => fixture })
        : ensureGrowthCoordinates({ demo: 'fixture', stageId: 'copy', ...entry().coordinates }, {
          cachePath: file => resolve(dir, file), fetchText: async () => fixture, announce: () => {},
        });
    await Promise.all([run(), run()]);
    expect(stages).toHaveLength(2);
    expect(new Set(stages).size).toBe(2);
    const target = resolve(dir, route === 'source' ? 'out.cif' : addressedDemoFile('out.cif', sha256));
    expect(stages.every(s => s.startsWith(target + '.') && s.endsWith('.partial'))).toBe(true);
    expect(stages).not.toContain(resolve(dir, 'out.cif.partial'));
    expect(compositeSha256(await readFile(target, 'utf8'))).toBe(sha256);
    expect((await readdir(dir)).filter(s => s.endsWith('.partial'))).toEqual([]);
  });

  it('rejects conflicting concurrent digests for the same filename', async () => {
    const dir = await workspace(), path = resolve(dir, 'out.cif');
    const first = writeVerifiedCacheFile(path, fixture, sha256);
    await expect(writeVerifiedCacheFile(path, otherFixture, compositeSha256(otherFixture))).rejects.toThrow(/conflicting concurrent/);
    await first;
    expect(await readFile(path, 'utf8')).toBe(fixture);
  });

  it.each(['launcher', 'growth', 'source'])('%s rejects bytes replaced after rename before returning', async route => {
    const dir = await workspace();
    vi.mocked(rename).mockImplementationOnce(async (from, to) => {
      await fs.rename(from, to);
      await writeFile(to, otherFixture);
    });
    if (route === 'source') {
      const recipePath = resolve(dir, 'recipe.json');
      await writeFile(recipePath, JSON.stringify({ version: 1, id: 'fixture', title: 'Fixture',
        sources: [{ id: '1CRN', url: entry().coordinates.download, sha256 }],
        bodies: [{ source: '1CRN', authChains: ['A'], atoms: 'all', chain: 'H', matrix: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]] }] }));
      await expect(resolveCompositeText(recipePath, { demosRoot: dir, cachePath: () => resolve(dir, 'out.cif'), fetchText: async () => fixture })).rejects.toThrow(/published file sha256 mismatch/);
    } else {
      const run = route === 'launcher' ? resolveCoordinates(entry(), dir, () => {}, { fetchText: async () => fixture })
        : ensureGrowthCoordinates({ demo: 'fixture', stageId: 'copy', ...entry().coordinates }, {
          cachePath: file => resolve(dir, file), fetchText: async () => fixture, announce: () => {},
        });
      await expect(run).rejects.toThrow(/published file sha256 mismatch/);
    }
    expect((await readdir(dir)).filter(s => s.endsWith('.partial'))).toEqual([]);
    // A failed publication releases its reservation so a later repair can proceed.
    await writeVerifiedCacheFile(resolve(dir, 'out.cif'), fixture, sha256);
    expect(await readFile(resolve(dir, 'out.cif'), 'utf8')).toBe(fixture);
  });

  it('removes only its own staging file when rename fails', async () => {
    const dir = await workspace(), path = resolve(dir, 'out.cif');
    await writeFile(path, fixture);
    vi.mocked(rename).mockRejectedValueOnce(Error('rename failed'));
    await expect(writeVerifiedCacheFile(path, otherFixture, compositeSha256(otherFixture))).rejects.toThrow('rename failed');
    expect(await readdir(dir)).toEqual(['out.cif']);
    expect(await readFile(path, 'utf8')).toBe(fixture);
  });
});
