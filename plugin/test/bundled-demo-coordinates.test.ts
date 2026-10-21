import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readBundledDemoCoordinates } from '../src/bundled-demo-coordinates.js';
import { ensureGrowthCoordinates } from '../src/growth-coordinates.js';
import { addressedDemoFile } from '../src/addressed-demo-cache.js';
import { formatDemoList, resolveCoordinates, type DemoEntry } from '../scripts/quest-demo.js';

const text = 'data_gallery\n#\n_struct.title \'Published model gallery\'\n#\n';
const sha256 = createHash('sha256').update(text).digest('hex');
const entry: DemoEntry = {
  name: 'binder-gallery', title: 'Binder gallery', sourceId: 'Anthropic/scorpion-toxin-binder-design',
  lesson: 'binder-gallery/lesson.json', sources: [{ title: 'Public dataset', url: 'https://huggingface.co/datasets/Anthropic/scorpion-toxin-binder-design' }],
  coordinates: { file: 'binder-gallery.cif', sha256, bytes: Buffer.byteLength(text), atomSites: 1,
    derivation: { kind: 'bundled-file', path: 'binder-gallery/gallery.cif' } },
};
let root: string, demosRoot: string, cache: string;
beforeEach(async () => {
  root = await mkdtemp(resolve(tmpdir(), 'stereofold-bundled-'));
  demosRoot = resolve(root, 'demos'); cache = resolve(root, 'cache');
  await mkdir(resolve(demosRoot, 'binder-gallery'), { recursive: true });
  await writeFile(resolve(demosRoot, 'binder-gallery/gallery.cif'), text);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const noNetwork = async () => { throw Error('Bundled coordinates must never fetch'); };

describe('bundled demo coordinates', () => {
  it('opens offline through runtime and CLI, publishing the same verified immutable cache entry', async () => {
    const notices: unknown[] = [];
    const request = { demo: entry.name, stageId: 'default', ...entry.coordinates };
    const runtime = await ensureGrowthCoordinates(request, {
      demosRoot, cachePath: file => resolve(cache, file), fetchText: noNetwork, announce: value => notices.push(value),
    });
    expect(runtime.fetched).toBe(false);
    expect(runtime.fetchedAt).toBeNull();
    expect(notices).toEqual([]);
    expect(runtime.path).toBe(resolve(cache, addressedDemoFile(entry.coordinates.file, sha256)));
    expect(await readFile(runtime.path, 'utf8')).toBe(text);
    // Prove CLI's cold path, then both routes' warm path without packaged bytes.
    await rm(cache, { recursive: true });
    const cli = await resolveCoordinates(entry, cache, () => {}, { demosRoot, fetchText: noNetwork });
    expect(cli).toBe(runtime.path);
    await rm(resolve(demosRoot, 'binder-gallery/gallery.cif'));
    expect(await resolveCoordinates(entry, cache, () => {}, { demosRoot, fetchText: noNetwork })).toBe(cli);
    expect((await ensureGrowthCoordinates(request, {
      demosRoot, cachePath: file => resolve(cache, file), fetchText: noNetwork,
    })).path).toBe(cli);
  });

  it('rejects changed packaged bytes without caching them', async () => {
    await writeFile(resolve(demosRoot, 'binder-gallery/gallery.cif'), text + '# changed\n');
    await expect(resolveCoordinates(entry, cache, () => {}, { demosRoot, fetchText: noNetwork })).rejects.toThrow('sha256 mismatch');
    await expect(ensureGrowthCoordinates({ demo: entry.name, stageId: 'default', ...entry.coordinates }, {
      demosRoot, cachePath: file => resolve(cache, file), fetchText: noNetwork,
    })).rejects.toThrow('sha256 mismatch');
    await expect(readFile(resolve(cache, addressedDemoFile(entry.coordinates.file, sha256)))).rejects.toThrow();
  });

  it('refuses absolute paths, parent traversal and symlinks outside the shipped demos', async () => {
    const outside = resolve(root, 'outside.cif');
    await writeFile(outside, text);
    await symlink(outside, resolve(demosRoot, 'binder-gallery/escape.cif'));
    for (const path of [outside, '../outside.cif', 'binder-gallery/escape.cif'])
      await expect(readBundledDemoCoordinates(path, sha256, demosRoot)).rejects.toThrow(/relative to demos|inside demos/);
  });

  it('lists the real dataset identity without a fabricated PDB accession', () => {
    const list = formatDemoList({ version: 1, cacheDirectory: cache, demos: [entry] });
    expect(list).toContain(entry.sourceId);
    expect(list).toContain('bundled coordinates');
    expect(list).not.toContain('undefined');
  });
});
