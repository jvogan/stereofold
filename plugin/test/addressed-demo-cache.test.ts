import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addressedDemoFile, addressedDemoPath, pruneAddressedDemoFiles, readAddressedDemoFile } from '../src/addressed-demo-cache.js';
import { compositeSha256, buildRigidComposite, type RigidCompositeRecipe } from '../src/demo-rigid-composite.js';
import { resolveCoordinates, resolveVolumeStructure, type DemoEntry } from '../scripts/quest-demo.js';
import { ensureGrowthCoordinates } from '../src/growth-coordinates.js';
import { readGrowthIndex } from '../src/molecular-growth.js';

const fixture = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');
const dirs: string[] = [];
async function workspace() { const dir = await mkdtemp(resolve(tmpdir(), 'stereofold-addressed-')); dirs.push(dir); return dir; }
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const entry = (text: string): DemoEntry => ({ name: 'fixture', title: 'Fixture', pdbId: '1CRN', lesson: 'fixture.json', sources: [],
  coordinates: { file: 'motion.cif', sha256: compositeSha256(text), bytes: Buffer.byteLength(text), atomSites: 327, download: 'https://example.test/fixture.cif' } });
const recipe = (chain: string): RigidCompositeRecipe => ({ version: 1, id: 'motion', title: 'Motion',
  sources: [{ id: '1CRN', url: 'https://files.rcsb.org/download/1CRN.cif', sha256: compositeSha256(fixture) }],
  bodies: [{ source: '1CRN', chain, authChains: ['A'], atoms: 'all', matrix: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]] }] });

describe('build-specific demo cache identities', () => {
  it('two separate hosts and indexes share one cache without replacing either composite', async () => {
    const dir = await workspace(), cachePath = (file: string) => resolve(dir, file);
    const variants = await Promise.all(['X', 'Y'].map(async (chain, i) => {
      const r = recipe(chain), built = await buildRigidComposite(r, { '1CRN': fixture });
      await writeFile(cachePath(`recipe-${i}.json`), JSON.stringify(r));
      const demo = entry(built.text);
      demo.coordinates.derivation = { kind: 'prepared-rigid-composite', recipe: `recipe-${i}.json` };
      await writeFile(cachePath(`index-${i}.json`), JSON.stringify({ version: 1, cacheDirectory: dir, demos: [demo] }));
      return { built, demo };
    }));
    const worker = `
      import { readFile } from 'node:fs/promises';
      import { readGrowthIndex } from './src/molecular-growth.ts';
      import { resolveCoordinates } from './scripts/quest-demo.ts';
      const index = await readGrowthIndex(process.argv[1]);
      for (let i=0; i<3; i++) {
        const path = await resolveCoordinates(index.demos[0], process.argv[2], () => {}, {
          demosRoot: process.argv[2], fetchText: () => readFile(process.argv[3], 'utf8') });
        process.stdout.write(path+'\\n');
      }`;
    const run = (i: number) => new Promise<string>((done, fail) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', worker,
        cachePath(`index-${i}.json`), dir, resolve(import.meta.dirname, '../../fixtures/1CRN.cif')], {
        cwd: resolve(import.meta.dirname, '..'), env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '', errors = '';
      child.stdout.on('data', data => output += data); child.stderr.on('data', data => errors += data);
      child.on('error', fail); child.on('close', code => code === 0 ? done(output) : fail(Error(errors)));
    });
    const output = await Promise.all([run(0), run(1)]);
    for (const [i, { built, demo }] of variants.entries()) {
      const path = cachePath(addressedDemoFile('motion.cif', built.sha256));
      expect(output[i].trim().split('\n')).toEqual([path, path, path]);
      expect(await readFile(path, 'utf8')).toBe(built.text);
      const index = await readGrowthIndex(cachePath(`index-${i}.json`));
      expect(index.demos[0].coordinates.sha256).toBe(built.sha256);
      const growth = await ensureGrowthCoordinates({ demo: demo.name, stageId: 'motion', ...demo.coordinates }, {
        cachePath, demosRoot: dir, fetchText: async () => { throw Error('must reuse'); }, announce: () => {} });
      expect(growth).toMatchObject({ path, text: built.text, fetched: false });
    }
    await expect(readFile(cachePath('motion.cif'))).rejects.toThrow();
    expect((await readdir(dir)).filter(file => file.endsWith('.partial'))).toEqual([]);
  }, 30_000);

  it.each(['launcher', 'growth'])('%s migrates only a matching legacy snapshot and leaves it usable', async route => {
    const dir = await workspace(), cachePath = (file: string) => resolve(dir, file), demo = entry(fixture);
    await writeFile(cachePath('motion.cif'), fixture);
    const hooks = { fetchText: async () => { throw Error('must not fetch'); }, cachePath, announce: () => {} };
    const path = route === 'launcher' ? await resolveCoordinates(demo, dir, () => {}, hooks)
      : (await ensureGrowthCoordinates({ demo: demo.name, stageId: 'motion', ...demo.coordinates }, hooks)).path;
    expect(path).toBe(cachePath(addressedDemoFile('motion.cif', demo.coordinates.sha256)));
    expect(await readFile(cachePath('motion.cif'), 'utf8')).toBe(fixture);
    const before = await stat(path);
    // An older host may still rewrite its legacy name after migration.
    await writeFile(cachePath('motion.cif'), 'another build');
    expect((await readAddressedDemoFile(cachePath, 'motion.cif', demo.coordinates.sha256))?.bytes.toString()).toBe(fixture);
    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
  });

  it('ignores the wrong legacy digest without overwriting it', async () => {
    const dir = await workspace(), demo = entry(fixture);
    await writeFile(resolve(dir, 'motion.cif'), 'older composite');
    const path = await resolveCoordinates(demo, dir, () => {}, { fetchText: async () => fixture });
    expect(await readFile(path, 'utf8')).toBe(fixture);
    expect(await readFile(resolve(dir, 'motion.cif'), 'utf8')).toBe('older composite');
  });

  it('density structure readers migrate to the same addressed identity', async () => {
    const dir = await workspace(), demo = entry(fixture);
    demo.coordinates.volume = { structure: { ...demo.coordinates } } as any;
    await writeFile(resolve(dir, 'motion.cif'), fixture);
    expect(await resolveVolumeStructure(demo, dir, () => {})).toBe(resolve(dir, addressedDemoFile('motion.cif', demo.coordinates.sha256)));
  });
});

describe('deferred cache retention', () => {
  it('keeps three newest digests, in-use files, current-run files and every legacy name', async () => {
    const dir = await workspace(), cachePath = (file: string) => resolve(dir, file);
    const paths: string[] = [];
    for (let i = 0; i < 7; i++) {
      const text = `revision-${i}`, path = cachePath(addressedDemoFile('motion.cif', compositeSha256(text)));
      await writeFile(path, text); await utimes(path, i + 1, i + 1); paths.push(path);
    }
    await writeFile(cachePath('motion.cif'), 'legacy');
    await writeFile(cachePath('motion.not-a-digest.cif'), 'unrelated');
    await writeFile(cachePath('motion.cif.partial'), 'other writer');
    const plan = await pruneAddressedDemoFiles(cachePath('motion.cif'));
    expect(plan.candidates).toEqual(paths.slice(0, 4).reverse()); expect(plan.removed).toEqual([]);
    addressedDemoPath(cachePath, 'motion.cif', compositeSha256('revision-1'));
    const result = await pruneAddressedDemoFiles(cachePath('motion.cif'), { isUnused: async path => path !== paths[0] });
    expect(result.removed.sort()).toEqual([paths[2], paths[3]].sort());
    expect(result.retained.sort()).toEqual([paths[0], paths[1], ...paths.slice(4)].sort());
    expect(await readFile(cachePath('motion.cif'), 'utf8')).toBe('legacy');
    expect(await readFile(cachePath('motion.not-a-digest.cif'), 'utf8')).toBe('unrelated');
    expect(await readFile(cachePath('motion.cif.partial'), 'utf8')).toBe('other writer');
    await expect(pruneAddressedDemoFiles(cachePath('motion.cif'), { keep: 2 })).rejects.toThrow('at least three');
  });
});
