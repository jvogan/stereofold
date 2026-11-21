/**
 * The pins that keep a downloaded demo honest, checked without a network.
 *
 * A demo's coordinates are downloads, and each one is held to a digest and a
 * byte count. When an archive revises an entry the pin goes stale, and that
 * can only be seen against the live file. What can be seen offline is the pin
 * disagreeing with itself: the index, the lessons, the recipes and the lab
 * fixtures all restate the same digests, so a repair that reaches one copy and
 * misses another, or a digest that no longer fits its size, its file name or
 * its address, shows up here before a new user meets it.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readDemoIndex, type DemoCoordinates, type DemoEntry } from '../scripts/quest-demo.js';

const pluginRoot = resolve(new URL('..', import.meta.url).pathname);
const repoRoot = resolve(pluginRoot, '..');
const demosRoot = resolve(pluginRoot, 'demos');
const index = await readDemoIndex(demosRoot);
const sha256Of = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const readJson = async (path: string): Promise<any> => JSON.parse(await readFile(path, 'utf8'));

/** One restatement of a pin, wherever it lives. `bytes` is absent where a copy does not record a size. */
type PinRecord = { where: string; file: string; sha256: string; bytes?: number; download?: string; cut?: string };

/**
 * The only addresses a fetch can use: both loaders read the response as text,
 * so a compressed archive address would hand them gzip bytes as a string.
 */
const RCSB_DOWNLOAD = /^https:\/\/files\.rcsb\.org\/download\/([0-9A-Z]{4})(?:-assembly(\d+))?\.cif$/;
const EMDB_MAP = /^https:\/\/ftp\.ebi\.ac\.uk\/pub\/databases\/emdb\/structures\/(EMD-\d+)\/map\/(emd_\d+)\.map\.gz$/;

/** What an address says the file is called, before any cut. */
function addressedName(download: string): { name: string; id: string } | undefined {
  const rcsb = RCSB_DOWNLOAD.exec(download);
  if (rcsb) return { name: basename(download), id: rcsb[1] };
  const emdb = EMDB_MAP.exec(download);
  return emdb ? { name: basename(download), id: emdb[2] } : undefined;
}

/** Every disagreement inside a set of pin records; empty when they all tell one story. */
function pinProblems(records: readonly PinRecord[]): string[] {
  const problems: string[] = [];
  const bucket = (key: (record: PinRecord) => string | undefined, say: (key: string, pins: string[]) => string,
    pin: (record: PinRecord) => string) => {
    const groups = new Map<string, PinRecord[]>();
    for (const record of records) {
      const k = key(record);
      if (k !== undefined) groups.set(k, [...(groups.get(k) ?? []), record]);
    }
    for (const [k, group] of groups) {
      const pins = [...new Set(group.map(pin))];
      if (pins.length > 1) problems.push(say(k, group.map(record => `${record.where} says ${pin(record)}`)));
    }
  };
  for (const record of records) {
    if (!/^[0-9a-f]{64}$/.test(record.sha256)) problems.push(`${record.where}: ${record.sha256} is not a full lowercase SHA-256.`);
    if (record.bytes !== undefined && !(Number.isSafeInteger(record.bytes) && record.bytes > 0))
      problems.push(`${record.where}: ${record.bytes} is not a whole, positive byte count.`);
    if (record.download === undefined) continue;
    const address = addressedName(record.download);
    if (!address) { problems.push(`${record.where}: ${record.download} is not an uncompressed RCSB entry or EMDB map address.`); continue; }
    if (record.cut === undefined || record.cut === 'whole') {
      if (record.file !== address.name) problems.push(`${record.where}: file ${record.file} is not what ${record.download} serves (${address.name}).`);
    } else if (!record.file.toLowerCase().startsWith(address.id.toLowerCase())) {
      problems.push(`${record.where}: file ${record.file} is not cut from ${record.download}.`);
    }
  }
  // One file name is one digest and one size, wherever the index repeats it.
  bucket(record => record.file, key => `${key} carries more than one pin`, record => record.sha256);
  bucket(record => record.bytes === undefined ? undefined : record.file,
    key => `${key} is given more than one size`, record => String(record.bytes));
  // One address, cut one way, is one file with one digest and one size.
  const addressCut = (record: PinRecord) => record.download === undefined ? undefined : `${record.download} ${record.cut ?? 'whole'}`;
  bucket(addressCut, key => `${key} is pinned more than one way`, record => `${record.file} ${record.sha256}`);
  bucket(record => record.bytes === undefined ? undefined : addressCut(record),
    key => `${key} is given more than one size`, record => String(record.bytes));
  // A digest names one size.
  bucket(record => record.bytes === undefined ? undefined : record.sha256,
    key => `digest ${key} is given more than one size`, record => String(record.bytes));
  return problems;
}

const cutOf = (coordinates: DemoCoordinates): string | undefined => coordinates.volume
  ? `prepared map downsampled ${coordinates.volume.downsample}x`
  : coordinates.derivation ? JSON.stringify(coordinates.derivation) : 'whole';

/** The pins the index itself records, including density maps and the structures beside them. */
function indexRecords(): PinRecord[] {
  const records: PinRecord[] = [];
  const add = (where: string, coordinates: DemoCoordinates) => {
    const recipe = coordinates.derivation?.kind === 'prepared-rigid-composite';
    records.push({ where, file: coordinates.file, sha256: coordinates.sha256, bytes: coordinates.bytes,
      ...(coordinates.download ? { download: coordinates.download, cut: cutOf(coordinates) } : {}),
      ...(recipe ? { cut: 'recipe' } : {}) });
    const volume = coordinates.volume;
    if (!volume) return;
    records.push({ where: `${where} map download`, file: basename(coordinates.download), sha256: volume.downloadSha256,
      download: coordinates.download, cut: 'whole' });
    const { structure } = volume;
    records.push({ where: `${where} structure`, file: structure.file, sha256: structure.sha256, bytes: structure.bytes,
      download: structure.download, cut: 'whole' });
  };
  for (const demo of index.demos) {
    add(demo.name, demo.coordinates);
    for (const stage of demo.stages ?? []) add(`${demo.name} ${stage.id}`, stage.coordinates);
  }
  return records;
}

/** The raw archive files the composite recipes build from. */
async function recipePins(): Promise<{ records: PinRecord[]; modelled: Array<{ where: string; path: string; sha256: string }> }> {
  const recipes = new Set<string>();
  for (const demo of index.demos) for (const holder of [demo.coordinates, ...(demo.stages ?? []).map(stage => stage.coordinates)])
    if (holder.derivation?.kind === 'prepared-rigid-composite') recipes.add(holder.derivation.recipe);
  const records: PinRecord[] = [];
  const modelled: Array<{ where: string; path: string; sha256: string }> = [];
  for (const recipe of [...recipes].sort()) {
    const path = resolve(demosRoot, recipe);
    for (const source of (await readJson(path)).sources) {
      const where = `${recipe} source ${source.id}`;
      if (typeof source.url === 'string') records.push({ where, file: basename(source.url), sha256: source.sha256, download: source.url, cut: 'whole' });
      else modelled.push({ where, path: resolve(dirname(path), source.file), sha256: source.sha256 });
    }
  }
  return { records, modelled };
}

describe('the pins the demo index records', () => {
  it('agree with each other and with the address they were downloaded from', () => {
    const records = indexRecords();
    expect(records.length).toBeGreaterThan(index.demos.length);
    expect(pinProblems(records)).toEqual([]);
  });

  it('agree with the digests the composite recipes pin for the same downloads', async () => {
    const { records } = await recipePins();
    expect(records.length).toBeGreaterThan(0);
    expect(pinProblems([...indexRecords(), ...records])).toEqual([]);
  });

  it('match the bytes of every modelled part a recipe ships beside it', async () => {
    const { modelled } = await recipePins();
    expect(modelled.length).toBeGreaterThan(0);
    for (const part of modelled) expect(sha256Of(await readFile(part.path)), part.where).toBe(part.sha256);
  });

  it('are the digests the lessons that restate them carry', async () => {
    const plain = new Map<string, DemoCoordinates>();
    const collect = (entry: Pick<DemoEntry, 'coordinates'>) => {
      const id = RCSB_DOWNLOAD.exec(entry.coordinates.download ?? '')?.[1];
      if (id && !entry.coordinates.derivation) plain.set(id, entry.coordinates);
    };
    for (const demo of index.demos) { collect(demo); for (const stage of demo.stages ?? []) collect(stage); }
    // A lesson named for its entry (`9ax6-…`) restates that entry's pin, and the
    // copy in the examples must agree with the copy the skill ships.
    let compared = 0;
    const copies = new Map<string, Set<string>>();
    for (const directory of [resolve(pluginRoot, 'examples/lessons'), resolve(pluginRoot, 'skills/molecular-presentation/assets')]) {
      for (const name of (await readdir(directory)).filter(file => file.endsWith('.json')).sort()) {
        const digest: string | undefined = (await readJson(resolve(directory, name))).provenance?.sourceSha256;
        if (!digest) continue;
        copies.set(name, (copies.get(name) ?? new Set()).add(digest));
        const pinned = plain.get(name.slice(0, 4).toUpperCase());
        if (!pinned) continue;
        compared++;
        expect(digest, `${directory}/${name}`).toBe(pinned.sha256);
      }
    }
    expect(compared).toBeGreaterThanOrEqual(4);
    for (const [name, digests] of copies) expect([...digests], name).toHaveLength(1);
  });

  it('are the pins the large-complex preview list and the checked-in fixtures restate', async () => {
    const records = indexRecords().filter(record => record.cut === 'whole' && record.download && record.bytes !== undefined);
    const preview = (await readJson(resolve(repoRoot, 'lab/headset-preview/large-complexes.json'))).fixtures as Array<{
      pdb_id: string; mmcif: { filename: string; download_url: string; bytes: number; sha256: string };
    }>;
    const restated: PinRecord[] = preview.map(({ pdb_id, mmcif }) => ({ where: `large-complexes ${pdb_id}`, file: mmcif.filename,
      sha256: mmcif.sha256, bytes: mmcif.bytes, download: mmcif.download_url, cut: 'whole' }));
    // The two fixtures with a coordinate file beside them can be checked against
    // the file itself, which is the one check that needs no archive at all.
    for (const directory of [resolve(repoRoot, 'fixtures'), resolve(repoRoot, 'docs/fixtures')]) {
      for (const name of (await readdir(directory)).filter(file => file.endsWith('.source.json'))) {
        const source = await readJson(resolve(directory, name));
        const bytes = await readFile(resolve(directory, source.file));
        expect(sha256Of(bytes), `${directory}/${name}`).toBe(source.sha256);
        expect(bytes.length, `${directory}/${name}`).toBe(source.bytes);
        restated.push({ where: `${name}`, file: source.file, sha256: source.sha256, bytes: source.bytes, download: source.source, cut: 'whole' });
      }
    }
    expect(restated.some(record => records.some(entry => entry.download === record.download))).toBe(true);
    expect(pinProblems([...records, ...restated])).toEqual([]);
  });
});

describe('the pin checker', () => {
  const entry: PinRecord = { where: 'index', file: '9AX6.cif', sha256: 'a'.repeat(64), bytes: 1_281_457, download: 'https://files.rcsb.org/download/9AX6.cif', cut: 'whole' };

  it('passes a pin that every copy repeats', () => {
    expect(pinProblems([entry, { ...entry, where: 'lesson', bytes: undefined, download: undefined }])).toEqual([]);
  });

  it('reports a repair that reached the index but not the copy', () => {
    const problems = pinProblems([entry, { ...entry, where: 'lab fixture', sha256: 'b'.repeat(64) }]);
    expect(problems.join('\n')).toContain('9AX6.cif carries more than one pin');
    expect(problems.join('\n')).toContain('pinned more than one way');
  });

  it('reports a digest repaired without its size', () => {
    const problems = pinProblems([entry, { ...entry, where: 'stage', bytes: 1_281_002 }]);
    expect(problems.join('\n')).toContain('9AX6.cif is given more than one size');
    expect(problems.join('\n')).toContain(`digest ${entry.sha256} is given more than one size`);
  });

  it('reports a digest that is not a full lowercase SHA-256 and a size that is not a byte count', () => {
    expect(pinProblems([{ ...entry, sha256: 'a'.repeat(63) }]).join('\n')).toContain('not a full lowercase SHA-256');
    expect(pinProblems([{ ...entry, sha256: 'A'.repeat(64) }]).join('\n')).toContain('not a full lowercase SHA-256');
    for (const bytes of [0, -1, 1.5, Number.NaN]) expect(pinProblems([{ ...entry, bytes }]).join('\n'), String(bytes)).toContain('not a whole, positive byte count');
  });

  it('reports an address no loader can read, and a file name that is not what the address serves', () => {
    const archive = 'https://files-versioned.wwpdb.org/pdb_versioned/data/entries/ax/pdb_00009ax6/pdb_00009ax6_xyz_v1-2.cif.gz';
    expect(pinProblems([{ ...entry, download: archive, file: 'pdb_00009ax6_xyz_v1-2.cif.gz' }]).join('\n')).toContain('not an uncompressed');
    expect(pinProblems([{ ...entry, download: 'http://files.rcsb.org/download/9AX6.cif' }]).join('\n')).toContain('not an uncompressed');
    expect(pinProblems([{ ...entry, file: '9AX7.cif' }]).join('\n')).toContain('is not what');
    expect(pinProblems([{ ...entry, file: '9AX7-lattice.cif', cut: '{"kind":"assembly-operator-subset"}' }]).join('\n')).toContain('is not cut from');
    expect(pinProblems([{ ...entry, file: '9AX6-lattice.cif', cut: '{"kind":"assembly-operator-subset"}' }])).toEqual([]);
  });
});
