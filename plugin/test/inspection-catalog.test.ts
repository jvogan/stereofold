import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractInspectionCatalogBytes } from '../src/inspection-catalog.js';

const require = createRequire(import.meta.url);
const { extractBytes: extractLabBytes } = require('../../lab/identity/extract.cjs') as {
  extractBytes(input: Uint8Array | string, options?: { sourceLabel?: string | null; expectedHash?: string; assemblyId?: string }): Promise<unknown>;
};
const publicFixture = fileURLToPath(new URL('../../fixtures/1CRN.cif', import.meta.url));

describe('bundled inspection catalog extraction', () => {
  it('matches the canonical lab catalog for arbitrary mmCIF source bytes', async () => {
    const bytes = await readFile(publicFixture);
    const options = { sourceLabel: '1CRN.cif', assemblyId: '1' };

    await expect(extractInspectionCatalogBytes(bytes, options)).resolves.toEqual(await extractLabBytes(bytes, options));
  });
  it('retains only observed residues for atom_site-only exports without rewriting their identity or bytes', async () => {
    const source = await readFile(publicFixture, 'utf8');
    const loop = source.match(/loop_\s*\n(?:_atom_site\.[^\n]+\n)+[\s\S]*?(?=\n#)/)?.[0];
    expect(loop).toBeTruthy();
    const lines = loop!.split('\n'), firstAtom = lines.findIndex(line => /^(ATOM|HETATM)\s/.test(line));
    expect(firstAtom).toBeGreaterThan(0);
    const text = ['data_observed_only', '#', ...lines.slice(0, firstAtom + 14), '#', ''].join('\n');
    const catalog: any = await extractInspectionCatalogBytes(text);
    expect(catalog.source).toMatchObject({ sha256: createHash('sha256').update(text).digest('hex'), byteLength: Buffer.byteLength(text) });
    expect(catalog.rows).toHaveLength(2);
    expect(catalog.rows.every((row: any) => row.coordinateState === 'resolved' && row.sequenceDeclared === false && row.mappingOrigin === 'atom_site')).toBe(true);
    expect(catalog.rows.map((row: any) => row.identity.labelSequenceId)).toEqual([1, 2]);
    expect(catalog.rows.flatMap((row: any) => row.atomSites.map((atom: any) => atom.identity.sourceAtomId))).toEqual(Array.from({ length: 14 }, (_, index) => String(index + 1)));
    await expect(extractInspectionCatalogBytes(text, { assemblyId: '1' })).rejects.toThrow(/Assembly 1 is not defined/);
  });
  it('accepts a native observed-only export that also carries an entity table', async () => {
    const source = await readFile(publicFixture, 'utf8');
    const loop = source.match(/loop_\s*\n(?:_atom_site\.[^\n]+\n)+[\s\S]*?(?=\n#)/)?.[0];
    expect(loop).toBeTruthy();
    const lines = loop!.split('\n'), firstAtom = lines.findIndex(line => /^(ATOM|HETATM)\s/.test(line));
    const text = ['data_native_selection', '#', 'loop_', '_entity.id', '_entity.type', '1 polymer', '#',
      ...lines.slice(0, firstAtom + 14), '#', ''].join('\n');
    const catalog: any = await extractInspectionCatalogBytes(text);
    expect(catalog.rows).toHaveLength(2);
    expect(catalog.rows.every((row: any) => row.coordinateState === 'resolved' && row.sequenceDeclared === false)).toBe(true);
    expect(catalog.source.sha256).toBe(createHash('sha256').update(text).digest('hex'));
  });
  it('preserves all identities in the actual Structure Viewer GFP export with three entities sharing chain A', async () => {
    const text = await readFile(fileURLToPath(new URL('../../fixtures/structure-viewer-gfp-observed.cif', import.meta.url)), 'utf8');
    const catalog: any = await extractInspectionCatalogBytes(text);
    const atoms = catalog.rows.flatMap((row: any) => row.atomSites);
    expect(catalog.source.sha256).toBe('fe3e56d0f4860dfc64957fa0fe707538bee65cf25f7b289f4d39937d0c824679');
    expect(atoms).toHaveLength(1866);
    expect(new Set(atoms.map((atom: any) => atom.identity.sourceAtomId)).size).toBe(1866);
    expect(catalog.copies).toHaveLength(1);
    expect(catalog.copies[0].labelChains).toEqual(['A']);
    expect(new Set(catalog.rows.map((row: any) => row.identity.entityId))).toEqual(new Set(['1', '2', '3']));
    expect(catalog.rows.every((row: any) => row.identity.labelChain === 'A' && !row.sequenceDeclared && row.coordinateState === 'resolved')).toBe(true);
    const chromophore = catalog.rows.find((row: any) => row.identity.componentId === 'CRO');
    expect(chromophore.identity).toMatchObject({ entityId: '2', authorChain: 'A', authorResidue: 66 });
    expect(chromophore.atomSites).toHaveLength(22);
    expect(catalog.rows.filter((row: any) => row.identity.componentId === 'HOH')).toHaveLength(95);
  });
  it('keeps deposited sequence declarations and rejects partial topology instead of guessing missing source tables', async () => {
    const source = await readFile(publicFixture, 'utf8');
    const catalog: any = await extractInspectionCatalogBytes(source);
    expect(catalog.rows).toHaveLength(46);
    expect(catalog.rows.every((row: any) => row.sequenceDeclared === true)).toBe(true);
    const partial = source.replace(/^_struct_asym\.[^\n]*\n/gm, '');
    expect(partial).not.toBe(source);
    await expect(extractInspectionCatalogBytes(partial)).rejects.toThrow(/explicit struct_asym/);
  });

  it('scopes observed-only chains and entities to each source model', async () => {
    const text = `data_models
loop_
_atom_site.group_PDB
_atom_site.id
_atom_site.type_symbol
_atom_site.label_atom_id
_atom_site.label_alt_id
_atom_site.label_comp_id
_atom_site.label_asym_id
_atom_site.label_entity_id
_atom_site.label_seq_id
_atom_site.pdbx_PDB_ins_code
_atom_site.Cartn_x
_atom_site.Cartn_y
_atom_site.Cartn_z
_atom_site.occupancy
_atom_site.B_iso_or_equiv
_atom_site.auth_seq_id
_atom_site.auth_comp_id
_atom_site.auth_asym_id
_atom_site.auth_atom_id
_atom_site.pdbx_PDB_model_num
ATOM 1 C CA . ALA A 1 1 ? 0 0 0 1 10 1 ALA A CA 1
ATOM 1 C CA . GLY B 2 4 ? 1 1 1 1 10 9 GLY B CA 2
#
`;
    const catalog: any = await extractInspectionCatalogBytes(text);
    expect(catalog.modelNumbers).toEqual([1, 2]);
    expect(catalog.rows.map((row: any) => [row.identity.modelNumber, row.identity.labelChain, row.identity.entityId, row.identity.labelSequenceId])).toEqual([[1, 'A', '1', 1], [2, 'B', '2', 4]]);
    expect(catalog.rows.every((row: any) => !row.sequenceDeclared && row.coordinateState === 'resolved')).toBe(true);
    expect(catalog.copies.map((copy: any) => copy.labelChains)).toEqual([['A'], ['B']]);
  });

});
