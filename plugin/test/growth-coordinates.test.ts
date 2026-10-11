/**
 * Growing on a machine that has downloaded nothing.
 *
 * Every tier of a staged demo is its own coordinate file, and those files are
 * downloads. A fresh Mac has none of them, so "grow it" used to fail with
 * "run the demo once on this Mac". These tests are that machine: the cache is
 * an empty temporary directory and the network is a stub.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GROWTH_FETCH_SPOKEN, ensureGrowthCoordinates, growthRecoveryCommand,
} from '../src/growth-coordinates.js';
import { readGrowthIndex, growthStages } from '../src/molecular-growth.js';

/** Three chains, one per assembly operator, as the subset tests use. */
const ASSEMBLY = [
  'data_TEST', '#', 'loop_', '_struct_asym.id', '_struct_asym.entity_id', 'A 1', 'A-2 1', 'A-3 1', '#',
  'loop_', '_atom_site.group_PDB', '_atom_site.id', '_atom_site.label_asym_id', '_atom_site.auth_asym_id',
  'ATOM 1 A A', 'ATOM 2 A-2 A-2', 'ATOM 3 A-3 A-3', '#',
].join('\n');
const PLAIN = 'data_PLAIN\n#\nloop_\n_atom_site.group_PDB\nATOM\n#\n';
const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

let cache = '';
const cachePath = (file: string) => resolve(cache, file);

beforeEach(async () => { cache = await mkdtemp(resolve(tmpdir(), 'stereofold-growth-')); });
afterEach(async () => { await rm(cache, { force: true, recursive: true }); });

describe('growing a tier this Mac has never downloaded', () => {
  it('fetches it once, says so out loud, and checks the recorded digest', async () => {
    const asked: string[] = [];
    const spoken: string[] = [];
    const printed: string[] = [];
    const result = await ensureGrowthCoordinates({
      demo: 'microtubule-growth', stageId: 'tip', file: '3JAK.cif',
      sha256: digest(PLAIN), download: 'https://files.rcsb.org/download/3JAK.cif',
    }, {
      cachePath,
      fetchText: async (url) => { asked.push(url); return PLAIN; },
      announce: (notice) => { spoken.push(notice.spoken); printed.push(notice.printed); },
    });

    expect(asked).toEqual(['https://files.rcsb.org/download/3JAK.cif']);
    expect(result.fetched).toBe(true);
    expect(result.fetchedAt).toEqual(expect.any(Number));
    expect(result.text).toBe(PLAIN);
    expect(await readFile(result.path, 'utf8')).toBe(PLAIN);

    // The wearer hears one short line while it downloads, and the terminal
    // gets the address so a stalled fetch is not a mystery.
    expect(spoken).toEqual([GROWTH_FETCH_SPOKEN]);
    expect(GROWTH_FETCH_SPOKEN.trim().split(/\s+/).length).toBeLessThan(12);
    expect(printed[0]).toContain('https://files.rcsb.org/download/3JAK.cif');
  });

  it('cuts the download down to the chains the tier shows', async () => {
    const operatorTwo = [
      'data_TEST', '#', 'loop_', '_struct_asym.id', '_struct_asym.entity_id', 'A-2 1', '#',
      'loop_', '_atom_site.group_PDB', '_atom_site.id', '_atom_site.label_asym_id', '_atom_site.auth_asym_id',
      'ATOM 2 A-2 A-2', '#',
    ].join('\n');
    const result = await ensureGrowthCoordinates({
      demo: 'microtubule-growth', stageId: 'wall', file: '5SYF-lattice-op2.cif',
      sha256: digest(operatorTwo), download: 'https://files.rcsb.org/download/5SYF-assembly1.cif',
      derivation: { kind: 'assembly-operator-subset', operators: ['2'], ofOperators: 26 },
    }, { cachePath, fetchText: async () => ASSEMBLY, announce: () => undefined });

    expect(result.fetched).toBe(true);
    expect(result.fetchedAt).toEqual(expect.any(Number));
    expect(result.text).toContain('ATOM 2 A-2 A-2');
    expect(result.text).not.toContain('ATOM 3 A-3 A-3');
  });

  it('uses the cached file on the next grow, and never asks the network twice', async () => {
    await writeFile(cachePath('3JAK.cif'), PLAIN);
    let calls = 0;
    const announced: string[] = [];
    const result = await ensureGrowthCoordinates({
      demo: 'microtubule-growth', stageId: 'tip', file: '3JAK.cif',
      sha256: digest(PLAIN), download: 'https://files.rcsb.org/download/3JAK.cif',
    }, { cachePath, fetchText: async () => { calls += 1; return PLAIN; }, announce: (n) => announced.push(n.spoken) });

    expect(calls).toBe(0);
    expect(announced).toEqual([]);
    expect(result.fetched).toBe(false);
    expect(result.fetchedAt).toBeNull();
  });

  it('refuses a download that no longer matches the digest the index records', async () => {
    await expect(ensureGrowthCoordinates({
      demo: 'microtubule-growth', stageId: 'tip', file: '3JAK.cif',
      sha256: digest('something else'), download: 'https://files.rcsb.org/download/3JAK.cif',
    }, { cachePath, fetchText: async () => PLAIN, announce: () => undefined }))
      .rejects.toThrow('no longer serves the tip coordinates');
    // Nothing that failed its digest is left in the cache.
    await expect(readFile(cachePath('3JAK.cif'), 'utf8')).rejects.toThrow();
  });

  it('gives one sentence and one command when the network is down', async () => {
    const failure = await ensureGrowthCoordinates({
      demo: 'microtubule-growth', stageId: 'wall', file: '5SYF-lattice.cif',
      sha256: digest(PLAIN), download: 'https://files.rcsb.org/download/5SYF-assembly1.cif',
    }, { cachePath, fetchText: async () => { throw Error('it returned HTTP 503.'); }, announce: () => undefined })
      .catch((error: Error) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('could not be fetched');
    expect((failure as Error).message).toContain('HTTP 503');
    expect((failure as Error).message).toContain(growthRecoveryCommand('microtubule-growth', 'wall'));
  });

  it('refuses to prepare a density map in a live session, and names the command that does', async () => {
    const failure = await ensureGrowthCoordinates({
      demo: 'microtubule-growth', stageId: 'filament', file: 'emd_6347-4x.map',
      sha256: digest(PLAIN), download: 'https://ftp.ebi.ac.uk/pub/databases/emdb/structures/EMD-6347/map/emd_6347.map.gz',
      prepared: true,
    }, { cachePath, fetchText: async () => { throw Error('the network must not be touched'); }, announce: () => undefined })
      .catch((error: Error) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('too big a job for a live session');
    expect((failure as Error).message).toContain('pnpm --dir plugin run demo microtubule-growth --stage filament');
  });
});

describe('every staged tier the index records', () => {
  it('carries a public https download, so a fresh Mac can grow into it', async () => {
    const stages = growthStages(await readGrowthIndex());
    expect(stages.length).toBeGreaterThan(0);
    for (const entry of stages) {
      const volume = entry.stage.coordinates.volume;
      const download = volume ? volume.structure.download : entry.stage.coordinates.download;
      expect(download, `${entry.lessonId} download`).toMatch(/^https:\/\//);
      expect(volume ? volume.structure.sha256 : entry.stage.coordinates.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
