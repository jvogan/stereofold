import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { extractInspectionCatalogBytes } from '../src/inspection-catalog.js';
import { MAX_INSPECTION_CATALOG_ROWS, MIN_CATALOG_BYTES_PER_ROW } from '../src/inspection-catalog-codec-server.js';

// Counts the trajectories Mol* is asked to build, so a test can show a source
// was refused before Mol* built any model.
const molstar = vi.hoisted(() => ({ trajectories: 0 }));
vi.mock('molstar/lib/commonjs/mol-model-formats/structure/mmcif.js', async importOriginal => {
  const actual: any = await importOriginal();
  return { ...actual, trajectoryFromMmCIF: (...args: unknown[]) => { molstar.trajectories += 1; return actual.trajectoryFromMmCIF(...args); } };
});

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

const ATOM_FIELDS = ['group_PDB', 'id', 'type_symbol', 'label_atom_id', 'label_alt_id', 'label_comp_id', 'label_asym_id',
  'label_entity_id', 'label_seq_id', 'pdbx_PDB_ins_code', 'Cartn_x', 'Cartn_y', 'Cartn_z', 'occupancy', 'B_iso_or_equiv',
  'auth_seq_id', 'auth_comp_id', 'auth_asym_id', 'auth_atom_id', 'pdbx_PDB_model_num'].map(field => `_atom_site.${field}`);
/** One atom, and chains that each declare the same entity's whole sequence. */
function declaredRows(chains: number, positions: number) {
  return ['data_declared_rows', 'loop_', '_entity.id', '_entity.type', '1 polymer', '#',
    'loop_', '_entity_poly_seq.entity_id', '_entity_poly_seq.num', '_entity_poly_seq.mon_id',
    ...Array.from({ length: positions }, (_, p) => `1 ${p + 1} ALA`), '#',
    'loop_', '_struct_asym.id', '_struct_asym.entity_id', ...Array.from({ length: chains }, (_, c) => `C${c} 1`), '#',
    'loop_', ...ATOM_FIELDS, 'ATOM 1 C CA . ALA C0 1 1 ? 0 0 0 1 10 1 ALA C0 CA 1', '#', ''].join('\n');
}

const OPERATOR_FIELDS = ['id', 'type', 'matrix[1][1]', 'matrix[1][2]', 'matrix[1][3]', 'vector[1]', 'matrix[2][1]', 'matrix[2][2]',
  'matrix[2][3]', 'vector[2]', 'matrix[3][1]', 'matrix[3][2]', 'matrix[3][3]', 'vector[3]'].map(field => `_pdbx_struct_oper_list.${field}`);
/** `declaredRows` with assembly 1 built from `expression` over `operators` translations of `asymIds`. */
function withAssembly(text: string, { operators, expression, asymIds }: { operators: number; expression: string; asymIds: string }) {
  return text.replace('loop_\n_atom_site.', ['loop_', '_pdbx_struct_assembly.id', '_pdbx_struct_assembly.details', "1 'copies'", '#',
    'loop_', '_pdbx_struct_assembly_gen.assembly_id', '_pdbx_struct_assembly_gen.oper_expression', '_pdbx_struct_assembly_gen.asym_id_list',
    `1 '${expression}' ${asymIds}`, '#', 'loop_', ...OPERATOR_FIELDS,
    ...Array.from({ length: operators }, (_, o) => `${o + 1} 'translation' 1 0 0 ${o} 0 1 0 0 0 0 1 0`), '#', 'loop_', '_atom_site.'].join('\n'));
}

describe('catalog row limit', () => {
  it('sits at the most rows the 64 MiB decode policy can hold, below the shortest row real catalogs carry', async () => {
    expect(MAX_INSPECTION_CATALOG_ROWS).toBe(Math.floor(64 * 1024 * 1024 / MIN_CATALOG_BYTES_PER_ROW) + 1);
    for (const [file, assemblyId] of [['1CRN.cif', undefined], ['identity-edge.cif', '1'], ['4HHB.cif', undefined]] as const) {
      const catalog: any = await extractInspectionCatalogBytes(await readFile(fileURLToPath(new URL(`../../fixtures/${file}`, import.meta.url))),
        assemblyId ? { assemblyId } : undefined);
      const shortest = Math.min(...catalog.rows.map((row: any) => JSON.stringify({ identity: row.identity, entityType: row.entityType,
        sequenceDeclared: row.sequenceDeclared, mappingOrigin: row.mappingOrigin, coordinateState: row.coordinateState, atomRefs: [] }).length + 1));
      expect(shortest).toBeGreaterThanOrEqual(MIN_CATALOG_BYTES_PER_ROW);
    }
  });
  it('refuses declarations that expand just past the limit with the decode-policy reason', async () => {
    const chains = 431, positions = 400;
    await expect(extractInspectionCatalogBytes(declaredRows(chains, positions)))
      .rejects.toThrow(/^Structure and sequence catalog exceeds the 64 MiB this plugin decodes in one browser\. Its declarations expand to at least 172,400 residue rows/);
    expect(chains * positions).toBeGreaterThan(MAX_INSPECTION_CATALOG_ROWS);
  });
  it('judges an assembly by the rows it selects, not by the chains it leaves out', async () => {
    // 431 chains of 400 positions pass the limit; assembly 1 copies one chain once.
    const text = withAssembly(declaredRows(431, 400), { operators: 1, expression: '1', asymIds: 'C0' });
    const catalog: any = await extractInspectionCatalogBytes(text, { assemblyId: '1' });
    expect(catalog.rows).toHaveLength(400);
    expect(new Set(catalog.rows.map((row: any) => row.identity.labelChain))).toEqual(new Set(['C0']));
    await expect(extractInspectionCatalogBytes(text)).rejects.toThrow(/at least 172,400 residue rows; at most 172,075 fit/);
  });
  it('refuses an assembly of 10,000 chains declaring 10,000 positions from the declarations alone', async () => {
    const text = withAssembly(declaredRows(10_000, 10_000), { operators: 1, expression: '1', asymIds: 'C0' });
    const started = performance.now();
    await expect(extractInspectionCatalogBytes(text, { assemblyId: '1' })).rejects.toThrow(/at least 100,000,000 residue rows; at most 1,000,000 fit/);
    expect(performance.now() - started).toBeLessThan(5_000);
  });
  it('refuses an assembly whose operator product passes the limit before the combinations are built', async () => {
    const text = withAssembly(declaredRows(1, 1), { operators: 100, expression: '(1-100)(1-100)(1-100)(1-100)', asymIds: 'C0' });
    const started = performance.now();
    await expect(extractInspectionCatalogBytes(text, { assemblyId: '1' }))
      .rejects.toThrow(/^Structure and sequence catalog exceeds the 64 MiB this plugin decodes in one browser\. Its declarations expand to at least 100,000,000 residue rows; at most 172,075 fit/);
    expect(performance.now() - started).toBeLessThan(5_000);
  });
  it('refuses 10,000 chains declaring 10,000 positions from the declarations alone', async () => {
    const text = declaredRows(10_000, 10_000);
    expect(Buffer.byteLength(text)).toBeLessThan(300_000);
    const started = performance.now();
    await expect(extractInspectionCatalogBytes(text)).rejects.toThrow(/at least 100,000,000 residue rows; at most 172,075 fit/);
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it('counts every model Mol* builds, and refuses before it builds one', async () => {
    // 400 declared positions in 431 models: 172,400 rows, just past the limit.
    // The integrative shape adds its one atom_site model: 172,800.
    for (const [shape, rows] of [['alternating', '172,400'], ['integrative', '172,800'], ['no-chains', '172,400']] as const) {
      molstar.trajectories = 0;
      await expect(extractInspectionCatalogBytes(modelRows(shape, 400, 431)), shape)
        .rejects.toThrow(`at least ${rows} residue rows; at most 172,075 fit`);
      expect(molstar.trajectories, shape).toBe(0);
    }
    molstar.trajectories = 0;
    const ensemble: any = await extractInspectionCatalogBytes(modelRows('contiguous', 30, 4));
    expect(ensemble.modelNumbers).toEqual([1, 2, 3, 4]);
    expect(ensemble.rows).toHaveLength(120);
    expect(molstar.trajectories).toBe(1);
  });
  it('adds the tables Mol* walks again for every model, against the declared bound, before it builds one', async () => {
    for (const [term, models, rows, counted] of PER_MODEL_CASES) {
      molstar.trajectories = 0;
      await expect(extractInspectionCatalogBytes(perModelTables(term, models, rows)), term)
        .rejects.toThrow(`at least ${counted} residue rows; at most 1,000,000 fit`);
      expect(molstar.trajectories, term).toBe(0);
    }
    // An assembly catalog builds each model's symmetry: 1,000 models, 500 generators, 500 operators.
    molstar.trajectories = 0;
    await expect(extractInspectionCatalogBytes(perModelTables('assembly', 1_000, 500), { assemblyId: '1' }))
      .rejects.toThrow('at least 1,002,000 residue rows; at most 1,000,000 fit');
    expect(molstar.trajectories).toBe(0);
    const ensemble: any = await extractInspectionCatalogBytes(modelRows('contiguous', 30, 4));
    expect(ensemble.rows).toHaveLength(120);
    expect(molstar.trajectories).toBe(1);
  });
});

/**
 * One declared residue on chain A, and a table Mol* walks again for every
 * model it builds: operator-mapping (`models` contiguous models, `rows`
 * molstar_atom_site_operator_mapping rows), integrative-chains (`models`
 * listed integrative models, `rows` more struct_asym rows), molecule
 * (`models` contiguous models, `rows` entities and `rows` pdbx_molecule rows)
 * or repeated-model (`models` listed integrative models all named 1, `rows`
 * atoms in model 1).
 */
function perModelTables(term: 'operator-mapping' | 'integrative-chains' | 'molecule' | 'repeated-model' | 'group-names' | 'assembly', models: number, rows: number) {
  const atom = (id: number, name: string, model: number) => `ATOM ${id} C ${name} . ALA A 1 1 ? 0 0 0 1 10 1 ALA A ${name} ${model}`;
  const entities = term === 'molecule' ? rows : term === 'integrative-chains' ? 2 : 1;
  const lines = ['data_per_model_tables', 'loop_', '_entity.id', '_entity.type',
    ...Array.from({ length: entities }, (_, e) => `${e + 1} ${e ? 'non-polymer' : 'polymer'}`), '#',
    'loop_', '_entity_poly_seq.entity_id', '_entity_poly_seq.num', '_entity_poly_seq.mon_id', '1 1 ALA', '#',
    'loop_', '_struct_asym.id', '_struct_asym.entity_id', 'A 1'];
  if (term === 'integrative-chains') lines.push(...Array.from({ length: rows }, (_, a) => `X${a} 2`));
  lines.push('#');
  if (term === 'operator-mapping') lines.push('loop_', ...['label_asym_id', 'auth_asym_id', 'operator_name', 'suffix', 'assembly_id',
    'assembly_operator_id', 'symmetry_operator_index', 'symmetry_hkl', 'ncs_id'].map(field => `_molstar_atom_site_operator_mapping.${field}`),
  ...Array.from({ length: rows }, (_, r) => `Q${r} Q${r} op${r} s${r} 1 ${r + 1} ? '0 0 0' ?`), '#');
  if (term === 'molecule') lines.push('loop_', '_pdbx_molecule.instance_id', '_pdbx_molecule.prd_id', '_pdbx_molecule.asym_id',
    ...Array.from({ length: rows }, (_, p) => `${p + 1} PRD_${String(p).padStart(6, '0')} A`), '#');
  if (term === 'group-names') lines.push('loop_', '_ihm_model_group.id', '_ihm_model_group.name',
    ...Array.from({ length: rows }, (_, g) => `${g + 1} g${g + 1}`), '#', 'loop_', '_ihm_model_group_link.group_id', '_ihm_model_group_link.model_id',
    ...Array.from({ length: rows }, (_, k) => `${k + 1} ${k + 1}`), '#');
  if (term === 'assembly') lines.push('loop_', '_pdbx_struct_assembly.id', '_pdbx_struct_assembly.details', "1 'copies'", '#',
    'loop_', '_pdbx_struct_assembly_gen.assembly_id', '_pdbx_struct_assembly_gen.oper_expression', '_pdbx_struct_assembly_gen.asym_id_list',
    ...Array.from({ length: rows }, () => "1 '1' A"), '#', 'loop_', ...['id', 'type', 'matrix[1][1]', 'matrix[1][2]', 'matrix[1][3]', 'vector[1]',
      'matrix[2][1]', 'matrix[2][2]', 'matrix[2][3]', 'vector[2]', 'matrix[3][1]', 'matrix[3][2]', 'matrix[3][3]', 'vector[3]'].map(field => `_pdbx_struct_oper_list.${field}`),
    ...Array.from({ length: rows }, (_, o) => `${o + 1} 'translation' 1 0 0 ${o} 0 1 0 0 0 0 1 0`), '#');
  if (term === 'integrative-chains' || term === 'repeated-model' || term === 'group-names') lines.push('loop_', '_ihm_model_list.model_id', '_ihm_model_list.model_name',
    ...Array.from({ length: models }, (_, m) => `${term === 'repeated-model' ? 1 : m + 1} m${m + 1}`), '#');
  const atoms = term === 'repeated-model' ? Array.from({ length: rows }, (_, i) => atom(i + 1, 'CA', 1))
    : term === 'integrative-chains' || term === 'group-names' ? [atom(1, 'CA', 1)] : Array.from({ length: models }, (_, i) => atom(i + 1, i % 2 ? 'CB' : 'CA', i + 1));
  lines.push('loop_', ...ATOM_FIELDS, ...atoms, '#', '');
  return lines.join('\n');
}
// Each just past 1,000,000 rows while its declared sequences stay near 1,000:
// [term, models, rows, the rows counted].
const PER_MODEL_CASES = [['operator-mapping', 1_000, 1_000, '1,001,000'], ['integrative-chains', 1_000, 999, '1,001,001'],
  ['molecule', 1_000, 500, '1,001,000'], ['repeated-model', 1_001, 1_000, '1,002,003'], ['group-names', 1_000, 500, '1,002,001']] as const;

/**
 * One entity of `positions` declared residues and `models` models as Mol*
 * builds them: contiguous model numbers, model numbers that alternate row by
 * row, rows of the integrative model list, or contiguous models with no
 * struct_asym table. Consecutive atoms alternate their name, so no model
 * repeats the hierarchy of the one before it.
 */
function modelRows(shape: 'contiguous' | 'alternating' | 'integrative' | 'no-chains', positions: number, models: number) {
  const atom = (id: number, name: string, model: number) => `ATOM ${id} C ${name} . ALA A 1 1 ? 0 0 0 1 10 1 ALA A ${name} ${model}`;
  const lines = ['data_model_rows', 'loop_', '_entity.id', '_entity.type', '1 polymer', '#',
    'loop_', '_entity_poly_seq.entity_id', '_entity_poly_seq.num', '_entity_poly_seq.mon_id',
    ...Array.from({ length: positions }, (_, p) => `1 ${p + 1} ALA`), '#'];
  if (shape !== 'no-chains') lines.push('loop_', '_struct_asym.id', '_struct_asym.entity_id', 'A 1', '#');
  if (shape === 'integrative') lines.push('loop_', '_ihm_model_list.model_id', '_ihm_model_list.model_name',
    ...Array.from({ length: models }, (_, m) => `${m + 1} m${m + 1}`), '#');
  lines.push('loop_', ...ATOM_FIELDS, ...Array.from({ length: shape === 'integrative' ? 1 : models },
    (_, i) => atom(i + 1, i % 2 ? 'CB' : 'CA', shape === 'alternating' ? i % 2 + 1 : i + 1)), '#', '');
  return lines.join('\n');
}
