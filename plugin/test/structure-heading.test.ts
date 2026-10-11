import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { readStructureHeading } from '../src/structure-heading.js';

const fixture = (name: string) => readFile(new URL(`../../fixtures/${name}`, import.meta.url), 'utf8');
const entities = (rows: string[]) => ['data_test', '_entry.id TEST', '#', 'loop_', '_entity.id', '_entity.type', '_entity.pdbx_description', ...rows, '#',
  'loop_', '_atom_site.id', '_atom_site.type_symbol', '1 C', ''].join('\n');

describe('the panel heading for an opened structure', () => {
  it('names 4HHB after the words its two globin chains share', async () => {
    expect(await readStructureHeading(await fixture('4HHB.cif'))).toEqual({ name: 'Hemoglobin', code: '4HHB' });
  });

  it('writes an old capitalised name in sentence case', async () => {
    expect(await readStructureHeading(await fixture('1CRN.cif'))).toEqual({ name: 'Crambin', code: '1CRN' });
  });

  it('keeps acronyms and codes in capitals', async () => {
    expect((await readStructureHeading(entities(["1 polymer 'HIV-1 PROTEASE'"]))).name).toBe('HIV-1 protease');
  });

  it('gives no name when the polymers share no leading word, and ignores water and ligands', async () => {
    expect((await readStructureHeading(entities(["1 polymer 'Histone H3'", "2 polymer 'DNA (145-MER)'", '3 water water']))).name).toBeUndefined();
    expect((await readStructureHeading(entities(["1 polymer 'Insulin A chain'", "2 polymer 'Insulin B chain'", "3 non-polymer 'ZINC ION'"]))).name).toBe('Insulin');
  });

  it('reads only a four-character entry id as a code', async () => {
    expect((await readStructureHeading(entities(["1 polymer 'Lysozyme'"]))).code).toBe('TEST');
    expect(await readStructureHeading('data_x\n_entry.id synthetic_native_handoff\n#\nloop_\n_atom_site.id\n1\n')).toEqual({});
  });

  it('returns nothing for text that is not mmCIF', async () => {
    expect(await readStructureHeading('ATOM      1  N   THR A   1      17.047  14.099   3.625  1.00 13.79           N\n')).toEqual({});
  });
});
