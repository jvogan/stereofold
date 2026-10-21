import { describe, expect, it } from 'vitest';
import { CIF } from 'molstar/lib/commonjs/mol-io/reader/cif.js';
import { buildRigidComposite, compositeSha256, rigidCompositeMatrixSchema } from '../src/demo-rigid-composite.js';
import { alignProteinSequences, kabsch } from '../src/structure-superposition.js';
import { crambin, hemoglobin, identity, inverse, syntheticCrambin } from './fixtures/superposition.js';

const synthetic = await syntheticCrambin();
const sources: Record<string, string> = { '1CRN': crambin, '9CRN': synthetic, '4HHB': hemoglobin };
const fixed = (matrix = identity) => ({ id: 'fixed', source: '1CRN', authChains: ['A'], atoms: 'all', chain: 'F', matrix });
const mobile = (superpose: Record<string, unknown> = { onto: 'fixed' }) => ({ source: '9CRN', authChains: ['A'], atoms: 'all', chain: 'M', place: { superpose } });
const build = (bodies: unknown[] = [fixed(), mobile()], texts = sources) => buildRigidComposite({
  version: 1, id: 'superposed', title: 'Fixture superposition',
  sources: Object.entries(texts).map(([id, text]) => ({ id, sha256: compositeSha256(text), url: `https://files.rcsb.org/download/${id}.cif` })), bodies,
}, texts);
function closeMatrix(actual: number[][], expected: number[][]) {
  actual.forEach((row, i) => row.forEach((value, j) => expect(Math.abs(value - expected[i][j])).toBeLessThan(1e-3)));
}

describe('sequence-guided composite placement', () => {
  it('recovers a known transform across 20% mutation and changed author numbering', async () => {
    const result = await build();
    closeMatrix(result.bodies[1].matrix, inverse);
    expect(result.bodies[1].superposition).toMatchObject({ pairedAtomCount: 46, pairedResidueCount: 46,
      coverage: { mobile: 1, fixed: 1 }, onto: 'fixed', ontoBodyIndex: 0 });
    expect(result.bodies[1].superposition!.sequenceIdentity).toBeCloseTo(37 / 46, 8);
    expect(result.bodies[1].superposition!.rmsd).toBeLessThan(1e-5);
    const parsed = await CIF.parse(result.text).run(); if (parsed.isError) throw Error(parsed.message);
    const sites = parsed.result.blocks[0].categories.atom_site;
    // Check serialized coordinates, not just the reported fit.
    for (const key of ['Cartn_x', 'Cartn_y', 'Cartn_z']) for (let i = 0; i < 327; i++)
      expect(sites.getField(key)!.float(i + 327)).toBeCloseTo(sites.getField(key)!.float(i), 3);
  });

  it('aligns related deposited alpha/beta globin chains from the existing 4HHB fixture', async () => {
    const result = await build([
      { ...fixed(), source: '4HHB' },
      { ...mobile({ onto: 0, chains: { mobile: ['B'], fixed: ['A'] } }), source: '4HHB', authChains: ['B'] },
    ]);
    const stats = result.bodies[1].superposition!;
    expect(stats.pairedAtomCount).toBeGreaterThan(130);
    expect(stats.rmsd).toBeLessThan(3);
    expect(stats.rmsd).toBeGreaterThan(0.1);
    expect(stats.sequenceIdentity).toBeGreaterThan(0.35);
    expect(stats.sequenceIdentity).toBeLessThan(0.6);
    expect(stats.coverage.mobile).toBeGreaterThan(0.9);
  });

  it('aligns gaps by sequence with linear-space global Needleman-Wunsch', async () => {
    expect(alignProteinSequences([...'ACDEFGHIK'], [...'ACDFGHIK'])).toEqual([[0, 0], [1, 1], [2, 2], [4, 3], [5, 4], [6, 5], [7, 6], [8, 7]]);
    const result = await build(undefined, { ...sources, '9CRN': await syntheticCrambin({ remove: [12, 13, 14] }) });
    expect(result.bodies[1].superposition!.pairedAtomCount).toBe(43);
    expect(result.bodies[1].superposition!.rmsd).toBeLessThan(1e-5);
    closeMatrix(result.bodies[1].matrix, inverse);
  });

  it('resolves a forward-referenced three-body tree in a rotated fixed frame with offsets', async () => {
    const result = await build([
      { ...mobile({ onto: 'middle' }), id: 'leaf', chain: 'L', place: { superpose: { onto: 'middle' }, then: { translate: [0, 0, 7] } } },
      { ...fixed([[0, -1, 0, 11], [1, 0, 0, 22], [0, 0, 1, 33]]) },
      { ...mobile({ onto: 1 }), id: 'middle', place: { superpose: { onto: 1 }, then: { translate: [5, 0, 0] } } },
    ]);
    closeMatrix(result.bodies[2].matrix, [[1, 0, 0, 6], [0, 1, 0, 42], [0, 0, 1, 3]]);
    closeMatrix(result.bodies[0].matrix, [[1, 0, 0, 6], [0, 1, 0, 42], [0, 0, 1, 10]]);
    for (const i of [0, 2]) expect(result.bodies[i].superposition!.rmsd).toBeLessThan(1e-5);
  });

  it('supports ranges and backbone atoms without CB, and keeps ligand retention separate', async () => {
    const result = await build([fixed(), mobile({ onto: 0, atoms: 'backbone',
      residues: { mobile: { from: 101, to: 120 }, fixed: { from: 1, to: 20 } } })]);
    expect(result.bodies[1].superposition).toMatchObject({ pairedAtomCount: 80, pairedResidueCount: 20, coverage: { mobile: 1, fixed: 1 } });
    closeMatrix(result.bodies[1].matrix, inverse);
  });

  it('fits multiple selected chains in explicit array order', async () => {
    const result = await build([
      { ...fixed(), source: '4HHB', authChains: ['A', 'B'] },
      { ...mobile({ onto: 0, chains: { mobile: ['C', 'D'], fixed: ['A', 'B'] } }), source: '4HHB', authChains: ['C', 'D'] },
    ]);
    expect(result.bodies[1].superposition!.pairedAtomCount).toBe(287);
    expect(result.bodies[1].superposition!.sequenceIdentity).toBe(1);
  });

  it('never fits a reflection with determinant -1', async () => {
    const result = await build(undefined, { ...sources, '9CRN': await syntheticCrambin({ reflect: true }) });
    expect(rigidCompositeMatrixSchema.safeParse(result.bodies[1].matrix).success).toBe(true);
    expect(result.bodies[1].superposition!.rmsd).toBeGreaterThan(1);
    const planar = kabsch([[0, 0, 0], [1, 0, 0], [0, 1, 0]], [[1, 2, 3], [1, 3, 3], [0, 2, 3]]);
    expect(planar.rmsd).toBeLessThan(1e-5);
  });

  it('refuses too few pairs even with the coverage override', async () => {
    for (const allowLowCoverage of [false, true]) await expect(build([fixed(), mobile({ onto: 0, allowLowCoverage,
      residues: { mobile: { from: 101, to: 102 }, fixed: { from: 1, to: 46 } } })])).rejects.toThrow(/at least 3 paired atoms; found 2/);
  });

  it('refuses coverage below 30%, with an explicit override', async () => {
    const spec = { onto: 0, residues: { mobile: { from: 101, to: 110 }, fixed: { from: 1, to: 46 } } };
    await expect(build([fixed(), mobile(spec)])).rejects.toThrow(/coverage is under 30%.*allowLowCoverage/);
    const result = await build([fixed(), mobile({ ...spec, allowLowCoverage: true })]);
    expect(result.bodies[1].superposition!.coverage).toEqual({ mobile: 1, fixed: 10 / 46 });
    expect(rigidCompositeMatrixSchema.safeParse(result.bodies[1].matrix).success).toBe(true);
    expect(Number.isFinite(result.bodies[1].superposition!.rmsd)).toBe(true);
  });

  it.each([
    ['cycle', () => [{ ...mobile({ onto: 1 }), chain: 'X' }, mobile({ onto: 0 })], /cycle/],
    ['self cycle', () => [fixed(), mobile({ onto: 1 })], /cycle/],
    ['missing reference', () => [fixed(), mobile({ onto: 'absent' })], /Unknown superposition body/],
    ['out of range index', () => [fixed(), mobile({ onto: 2 })], /Unknown superposition body/],
    ['both placements', () => [fixed(), { ...mobile(), matrix: identity }], /exactly one/],
    ['neither placement', () => [{ ...fixed(), matrix: undefined }], /exactly one/],
    ['duplicate id', () => [fixed(), { ...mobile(), id: 'fixed' }], /Body ids must be unique/],
    ['chains outside body', () => [fixed(), mobile({ onto: 0, chains: { mobile: ['B'], fixed: ['A'] } })], /must be retained/],
    ['chain cardinality', () => [{ ...fixed(), authChains: ['A', 'B'] }, mobile()], /equal lengths/],
    ['invalid translation', () => [fixed(), { ...mobile(), place: { superpose: { onto: 0 }, then: { translate: [1, 2] } } }], /three translation/],
    ['empty range', () => [fixed(), mobile({ onto: 0, residues: { mobile: { from: 999, to: 1000 }, fixed: { from: 1, to: 46 } } })], /no observed protein residues/],
  ])('refuses %s', async (_, bodies, message) => {
    await expect(build(bodies())).rejects.toThrow(message);
  });
});
