import { mkdir, symlink, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CIF, type CifBlock } from 'molstar/lib/commonjs/mol-io/reader/cif.js';
import { trajectoryFromMmCIF } from 'molstar/lib/commonjs/mol-model-formats/structure/mmcif.js';
import { ModelSecondaryStructure } from 'molstar/lib/commonjs/mol-model-formats/structure/property/secondary-structure.js';
import { Structure } from 'molstar/lib/commonjs/mol-model/structure.js';
import { compositeSourceProvenance, buildRigidComposite, compositeSha256, parseRigidCompositeRecipe, type CompositeMatrix, type RigidCompositeRecipe } from '../src/demo-rigid-composite.js';
import { compositeRecipePath, resolveCompositeText } from '../src/demo-composite-cache.js';
import { addressedDemoFile } from '../src/addressed-demo-cache.js';
import { ensureGrowthCoordinates, applyGrowthDerivation } from '../src/growth-coordinates.js';
import { resolveCoordinates, type DemoEntry } from '../scripts/quest-demo.js';
import { main as prepare, parsePrepareCompositeArgs } from '../scripts/prepare-composite.js';
// @ts-ignore Exercise the page's actual label-chain visibility resolver.
import { availableChains, resolveVisibility, visibleRowKeys } from '../../lab/browser-roundtrip/inspection-visibility.mjs';

const fixtures = resolve(import.meta.dirname, '../../fixtures');
const texts: Record<string, string> = Object.fromEntries(await Promise.all(['4HHB', '1CRN'].map(async id => [id, await readFile(resolve(fixtures, `${id}.cif`), 'utf8')])));
const identity = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]] as CompositeMatrix;
const body = (chain = 'X', source = '1CRN'): RigidCompositeRecipe['bodies'][number] & { matrix: CompositeMatrix } => ({ source, authChains: ['A'], atoms: 'all', chain, matrix: structuredClone(identity) });
const recipe = (bodies = [body()]): RigidCompositeRecipe => ({
  version: 1, id: 'fixture-composite', title: 'Rigid fixture copies',
  sources: [...new Set(bodies.map(b => b.source))].map(id => ({ id, url: `https://files.rcsb.org/download/${id}.cif`, sha256: compositeSha256(texts[id]) })), bodies,
});
async function parse(text: string): Promise<CifBlock> {
  const parsed = await CIF.parse(text).run();
  if (parsed.isError) throw Error(parsed.message);
  return parsed.result.blocks[0];
}
const originals = Object.fromEntries(await Promise.all(Object.entries(texts).map(async ([id, text]) => [id, await parse(text)])));
function column(frame: CifBlock, name: string, category = 'atom_site'): string[] {
  return [...frame.categories[category].getField(name)!.toStringArray()];
}
const build = (r = recipe()) => buildRigidComposite(r, texts);

describe('deposited atoms at rigid-body poses', () => {
  it('keeps identity coordinates, renames both chain columns and renumbers ids', async () => {
    const result = await build();
    const frame = await parse(result.text);
    expect(result.atomSites).toBe(327);
    for (const coord of ['Cartn_x', 'Cartn_y', 'Cartn_z']) {
      expect(column(frame, coord).map(Number)).toEqual(column(originals['1CRN'], coord).map(Number));
      expect(column(frame, coord).every(v => /^-?\d+\.\d{3}$/.test(v))).toBe(true);
    }
    expect(new Set(column(frame, 'auth_asym_id'))).toEqual(new Set(['X']));
    expect(column(frame, 'label_asym_id')).toEqual(column(frame, 'auth_asym_id'));
    expect(column(frame, 'id')).toEqual(Array.from({ length: 327 }, (_, i) => String(i + 1)));
    expect(result.bytes).toBe(Buffer.byteLength(result.text));
    expect(result.sha256).toBe(compositeSha256(result.text));
  });

  it('applies a rotation followed by translation, about the model origin', async () => {
    const b = body(); b.matrix = [[0, -1, 0, 10], [1, 0, 0, -20], [0, 0, 1, 30]];
    const frame = await parse((await build(recipe([b]))).text);
    const source = originals['1CRN'];
    for (let i = 0; i < 327; i++) {
      expect(Number(column(frame, 'Cartn_x')[i])).toBeCloseTo(-Number(column(source, 'Cartn_y')[i]) + 10, 3);
      expect(Number(column(frame, 'Cartn_y')[i])).toBeCloseTo(Number(column(source, 'Cartn_x')[i]) - 20, 3);
      expect(Number(column(frame, 'Cartn_z')[i])).toBeCloseTo(Number(column(source, 'Cartn_z')[i]) + 30, 3);
    }
  });

  it('keeps two copies of one chain and multiple sources without entity collisions', async () => {
    const frame = await parse((await build(recipe([body('X'), body('Y'), body('Z', '4HHB')]))).text);
    expect(new Set(column(frame, 'auth_asym_id'))).toEqual(new Set(['X', 'Y', 'Z']));
    expect(column(frame, 'id').at(-1)).toBe(String(frame.categories.atom_site.rowCount));
    const entities = column(frame, 'id', 'entity');
    expect(new Set(entities).size).toBe(entities.length);
    expect(column(frame, 'label_entity_id').every(id => entities.includes(id))).toBe(true);
    expect(column(frame, 'pdbx_strand_id', 'entity_poly')).toEqual(['X', 'Y', 'Z']);
    expect(column(frame, 'id', 'struct_asym')).toEqual(['X', 'Y', 'Z']);
  });

  it('combines author chains without merging residues or overlapping secondary structure', async () => {
    const b = body('H', '4HHB'); b.authChains = ['A', 'B'];
    const result = await build(recipe([b]));
    const frame = await parse(result.text);
    const output = (await trajectoryFromMmCIF(frame).run()).representative;
    const source = (await trajectoryFromMmCIF(originals['4HHB']).run()).representative;
    expect(output.atomicHierarchy.chains._rowCount).toBe(2);
    expect(output.atomicHierarchy.residues._rowCount).toBe(141 + 146);
    expect(new Set(column(frame, 'auth_asym_id'))).toEqual(new Set(['H']));
    expect(column(frame, 'id', 'struct_asym')).toEqual(['H', 'H_1']);
    expect(Math.max(...column(frame, 'label_seq_id').map(Number))).toBe(146);
    expect(column(frame, 'num', 'entity_poly_seq').map(Number)).toEqual([
      ...Array.from({ length: 141 }, (_, i) => i + 1), ...Array.from({ length: 146 }, (_, i) => i + 1),
    ]);
    const srcSS = ModelSecondaryStructure.Provider.get(source)!, outSS = ModelSecondaryStructure.Provider.get(output)!;
    for (const [i, authChain] of ['A', 'B'].entries()) {
      const chainIndex = Array.from(source.atomicHierarchy.chains.auth_asym_id.toArray()).indexOf(authChain);
      const srcStart = source.atomicHierarchy.residueAtomSegments.index[source.atomicHierarchy.chainAtomSegments.offsets[chainIndex]];
      const count = i === 0 ? 141 : 146;
      expect(Array.from(outSS.type).slice(i === 0 ? 0 : 141, i === 0 ? 141 : 287)).toEqual(Array.from(srcSS.type).slice(srcStart, srcStart + count));
    }
  });

  it('writes finite large translations without exponent notation', async () => {
    const b = body(); b.matrix[0][3] = -1e21;
    const frame = await parse((await build(recipe([b]))).text);
    expect(column(frame, 'Cartn_x').every(v => /^-?\d+\.\d{3}$/.test(v))).toBe(true);
  });

  it('keeps whole listed HEM ligands, excludes unlisted ligands and always drops waters', async () => {
    const b = body('H', '4HHB'); b.ligands = ['HEM', 'HOH'];
    const withHeme = await build(recipe([b]));
    const frame = await parse(withHeme.text);
    expect(column(frame, 'label_comp_id').filter(v => v === 'HEM')).toHaveLength(43);
    expect(column(frame, 'label_comp_id')).not.toContain('HOH');
    const plain = await build(recipe([body('H', '4HHB')]));
    expect(withHeme.atomSites - plain.atomSites).toBe(43);
    expect(column(await parse(plain.text), 'label_comp_id')).not.toContain('HEM');
    expect(column(frame, 'id', 'chem_comp')).toContain('HEM');
    const entityTypes = column(frame, 'type', 'entity');
    expect(entityTypes).toEqual(['polymer', 'non-polymer']);
  });

  it('trims backbone and inclusive author ranges while keeping ligands whole', async () => {
    const b = body('H', '4HHB'); b.atoms = 'backbone'; b.residues = { from: 10, to: 20 }; b.ligands = ['HEM'];
    const frame = await parse((await build(recipe([b]))).text);
    const comp = column(frame, 'label_comp_id'), names = column(frame, 'label_atom_id'), seq = column(frame, 'auth_seq_id').map(Number);
    expect(comp.filter(v => v === 'HEM')).toHaveLength(43);
    for (let i = 0; i < comp.length; i++) if (comp[i] !== 'HEM') {
      expect(['N', 'CA', 'C', 'O', 'CB']).toContain(names[i]);
      expect(seq[i]).toBeGreaterThanOrEqual(10); expect(seq[i]).toBeLessThanOrEqual(20);
    }
    expect(new Set(seq.filter((_, i) => comp[i] !== 'HEM'))).toEqual(new Set(Array.from({ length: 11 }, (_, i) => i + 10)));
  });

  it('selects only the first model even when its number is not one', async () => {
    const original = texts['1CRN'];
    const tag = '_atom_site.pdbx_PDB_model_num';
    const start = original.indexOf('\n', original.indexOf(tag)) + 1;
    const end = original.indexOf('\n#', start);
    const atomLines = original.slice(start, end).trim().split('\n');
    const synthetic = original.slice(0, start) + atomLines.map(l => l.replace(/1\s*$/, '7')).join('\n') + '\n'
      + atomLines.map(l => l.replace(/1\s*$/, '8')).join('\n') + original.slice(end);
    const r = recipe(); r.sources[0].sha256 = compositeSha256(synthetic);
    const result = await buildRigidComposite(r, { '1CRN': synthetic });
    expect(result.atomSites).toBe(327);
    expect(new Set(column(await parse(result.text), 'pdbx_PDB_model_num'))).toEqual(new Set(['1']));
  });

  it('clips helix and sheet endpoints to selected residues and remaps their ids', async () => {
    const b = body(); b.residues = { from: 8, to: 12 };
    const frame = await parse((await build(recipe([b]))).text);
    expect(column(frame, 'beg_auth_seq_id', 'struct_conf')).toEqual(['8']);
    expect(column(frame, 'end_auth_seq_id', 'struct_conf')).toEqual(['12']);
    expect(column(frame, 'beg_label_asym_id', 'struct_conf')).toEqual(['X']);
    expect(frame.categories.struct_sheet_range).toBeUndefined();
    const copies = await parse((await build(recipe([body('X'), body('Y')]))).text);
    for (const category of ['struct_conf', 'struct_sheet_range']) {
      expect(new Set(column(copies, 'beg_auth_asym_id', category))).toEqual(new Set(['X', 'Y']));
      expect(new Set(column(copies, 'id', category)).size).toBe(copies.categories[category].rowCount);
    }
    expect(new Set(column(copies, 'sheet_id', 'struct_sheet_range')).size).toBe(2);
  });

  it('produces byte-identical output regardless of source-text object ordering', async () => {
    const r = recipe([body('X'), body('Y', '4HHB')]);
    const a = await build(r), b = await buildRigidComposite(JSON.stringify(r), { '1CRN': texts['1CRN'], '4HHB': texts['4HHB'] });
    expect(a).toEqual(b);
  });

  it('loads real Mol* trajectories with atom counts, chains, helices and sheets', async () => {
    const result = await build(recipe([body('X'), body('Y')]));
    const trajectory = await trajectoryFromMmCIF(await parse(result.text)).run();
    expect(trajectory.frameCount).toBe(1);
    const model = trajectory.representative;
    expect(model.atomicHierarchy.atoms._rowCount).toBe(654);
    expect(model.atomicHierarchy.chains._rowCount).toBe(2);
    expect(Array.from(model.atomicHierarchy.chains.auth_asym_id.toArray())).toEqual(['X', 'Y']);
    const ss = ModelSecondaryStructure.Provider.get(model)!;
    expect(ss.elements.some(e => e.kind === 'helix')).toBe(true);
    expect(ss.elements.some(e => e.kind === 'sheet')).toBe(true);
    expect(Array.from(ss.type).filter(v => v !== 0).length).toBeGreaterThan(0);
    // Annotation assignment must reach both copies, not just parse the rows.
    expect(Array.from(ss.type).slice(0, 46)).toEqual(Array.from(ss.type).slice(46));
  });

  it('loads a polymer plus heme as Mol* polymer and non-polymer entity chains', async () => {
    const b = body('H', '4HHB'); b.ligands = ['HEM'];
    const result = await build(recipe([b]));
    const model = (await trajectoryFromMmCIF(await parse(result.text)).run()).representative;
    expect(model.atomicHierarchy.atoms._rowCount).toBe(result.atomSites);
    expect(model.atomicHierarchy.chains._rowCount).toBe(2);
    expect(Array.from(model.atomicHierarchy.chains.auth_asym_id.toArray())).toEqual(['H', 'H']);
    expect(Array.from(model.atomicHierarchy.chains.label_asym_id.toArray())).toEqual(['H', 'H_1']);
    expect(ModelSecondaryStructure.Provider.get(model)!.elements.some(e => e.kind === 'helix')).toBe(true);
  });

  it('maps every retained asym to its own label chain and correct entity in Mol*', async () => {
    const b = body('H', '4HHB'); b.authChains = ['A', 'B']; b.ligands = ['HEM'];
    const result = await build(recipe([b, body('H_1')]));
    const frame = await parse(result.text);
    const model = (await trajectoryFromMmCIF(frame).run()).representative;
    const labels = column(frame, 'id', 'struct_asym');
    expect(labels).toEqual(['H', 'H_2', 'H_3', 'H_4', 'H_1']);
    expect(new Set(labels).size).toBe(labels.length);
    const ids = column(frame, 'label_entity_id'), atomLabels = column(frame, 'label_asym_id');
    const asymEntities = column(frame, 'entity_id', 'struct_asym');
    for (const [i, label] of labels.entries()) {
      expect(new Set(ids.filter((_, j) => atomLabels[j] === label))).toEqual(new Set([asymEntities[i]]));
      expect(model.properties.structAsymMap.get(label)!.entity_id).toBe(asymEntities[i]);
      expect(model.entities.data.id.value(model.atomicHierarchy.index.findEntity(label))).toBe(asymEntities[i]);
    }
    expect(column(frame, 'type', 'entity')).toEqual(['polymer', 'polymer', 'non-polymer', 'non-polymer', 'polymer']);
  });

  it('preserves the deposited HIS92 NE2–HEM FE bond as a Mol* inter-unit bond', async () => {
    const b = body('H', '4HHB'); b.authChains = ['B']; b.ligands = ['HEM'];
    const frame = await parse((await build(recipe([b]))).text);
    expect(column(frame, 'id', 'struct_conn')).toEqual(['conn1']);
    expect(column(frame, 'ptnr1_label_asym_id', 'struct_conn')).toEqual(['H']);
    expect(column(frame, 'ptnr2_label_asym_id', 'struct_conn')).toEqual(['H_1']);
    expect(column(frame, 'ptnr1_auth_asym_id', 'struct_conn')).toEqual(['H']);
    expect(column(frame, 'ptnr2_auth_asym_id', 'struct_conn')).toEqual(['H']);
    expect(column(frame, 'ptnr1_label_seq_id', 'struct_conn')).toEqual(['92']);
    expect(column(frame, 'ptnr2_auth_seq_id', 'struct_conn')).toEqual(['148']);
    const model = (await trajectoryFromMmCIF(frame).run()).representative;
    const structure = Structure.ofModel(model);
    expect(structure.interUnitBonds.edgeCount).toBeGreaterThan(0);
    const pairs = structure.interUnitBonds.edges.map(e => {
      const a = structure.unitMap.get(e.unitA)!.elements[e.indexA], c = structure.unitMap.get(e.unitB)!.elements[e.indexB];
      return [model.atomicHierarchy.atoms.label_atom_id.value(a), model.atomicHierarchy.atoms.label_atom_id.value(c)].sort();
    });
    expect(pairs).toContainEqual(['FE', 'NE2']);
  });

  it('requires all body label chains in lesson visibility to retain the heme', async () => {
    const b = body('H', '4HHB'); b.ligands = ['HEM'];
    const frame = await parse((await build(recipe([b, body('J')]))).text);
    const labels = column(frame, 'label_asym_id'), comps = column(frame, 'label_comp_id');
    const auth = column(frame, 'auth_asym_id');
    const rows = labels.map((labelChain, i) => ({ key: String(i), entityType: comps[i] === 'HEM' ? 'non-polymer' : 'polymer',
      identity: { labelChain, authChain: auth[i], copyId: 'one', modelNumber: 1, componentId: comps[i] } }));
    const available = availableChains(rows, 1);
    const visible = (chains: string[], classes?: string[]) => visibleRowKeys(rows,
      resolveVisibility(undefined, { op: 'only', chains, ...(classes ? { classes } : {}) }, available));
    expect(visible(['H'])).toEqual(rows.filter(r => r.identity.labelChain === 'H').map(r => r.key));
    expect(visible(['H', 'H_1'])).toEqual(rows.filter(r => r.identity.authChain === 'H').map(r => r.key));
    expect(visible(['H', 'H_1'], ['polymer'])).toEqual(visible(['H']));
    expect(visible(['H', 'H_1'], ['polymer', 'ligand'])).toEqual(visible(['H', 'H_1']));
  });

  it('matches and preserves connection alternate locations and insertion codes', async () => {
    const text = texts['4HHB'].replace(/^(?:ATOM|HETATM|metalc2)\s+.*$/gm, line => {
      const connection = line.startsWith('metalc2');
      const fields = originals['4HHB'].categories[connection ? 'struct_conn' : 'atom_site'].fieldNames;
      const tokens = line.trim().split(/\s+/);
      const get = (key: string) => tokens[fields.indexOf(key)];
      const set = (key: string, value: string) => { tokens[fields.indexOf(key)] = value; };
      if (connection) {
        set('pdbx_ptnr1_label_alt_id', 'A'); set('pdbx_ptnr1_PDB_ins_code', 'I');
      } else if (get('auth_asym_id') === 'B' && get('auth_seq_id') === '92') {
        set('pdbx_PDB_ins_code', 'I');
        if (get('label_atom_id') === 'NE2') set('label_alt_id', 'A');
      }
      return tokens.join(' ');
    });
    const b = body('H', '4HHB'); b.authChains = ['B']; b.ligands = ['HEM'];
    const r = recipe([b]); r.sources[0].sha256 = compositeSha256(text);
    const frame = await parse((await buildRigidComposite(r, { '4HHB': text })).text);
    expect(column(frame, 'pdbx_ptnr1_label_alt_id', 'struct_conn')).toEqual(['A']);
    expect(column(frame, 'pdbx_ptnr1_PDB_ins_code', 'struct_conn')).toEqual(['I']);
    const model = (await trajectoryFromMmCIF(frame).run()).representative;
    expect(Structure.ofModel(model).interUnitBonds.edgeCount).toBeGreaterThan(0);
    const mismatch = text.replace('B HIS 92 NE2 A I', 'B HIS 92 NE2 B I');
    expect(mismatch).not.toBe(text);
    r.sources[0].sha256 = compositeSha256(mismatch);
    expect((await parse((await buildRigidComposite(r, { '4HHB': mismatch })).text)).categories.struct_conn).toBeUndefined();
  });

  it('drops connections with trimmed endpoints and crystal mates; renumbers copies deterministically', async () => {
    const b = body('H', '4HHB'); b.authChains = ['B']; b.ligands = ['HEM'];
    const copy = { ...b, chain: 'J' };
    const frame = await parse((await build(recipe([b, copy]))).text);
    expect(column(frame, 'id', 'struct_conn')).toEqual(['conn1', 'conn2']);
    for (const trimmed of [{ ...b, atoms: 'backbone' as const }, { ...b, residues: { from: 1, to: 91 } }, { ...b, ligands: [] }]) {
      expect((await parse((await build(recipe([trimmed]))).text)).categories.struct_conn).toBeUndefined();
    }
    for (const [from, to] of [['B HEM 148 1_555', 'B HEM 148 2_555'], ['1_555 G HEM', '2_555 G HEM']]) {
      const text = texts['4HHB'].replace(from, to);
      expect(text).not.toBe(texts['4HHB']);
      const r = recipe([b]); r.sources[0].sha256 = compositeSha256(text);
      expect((await parse((await buildRigidComposite(r, { '4HHB': text })).text)).categories.struct_conn).toBeUndefined();
    }
    // Crambin's deposited disulfides exercise covalent links as well as metal coordination.
    const crambin = await parse((await build()).text);
    expect(column(crambin, 'conn_type_id', 'struct_conn')).toEqual(['disulf', 'disulf', 'disulf']);
  });
});

describe('strict recipe validation', () => {
  const cases: [string, (r: any) => void, RegExp][] = [
    ['version', r => r.version = 2, /version/],
    ['empty id', r => r.id = '', /id/], ['empty title', r => r.title = ' ', /title/],
    ['unknown root field', r => r.extra = 1, /extra/],
    ['no sources', r => r.sources = [], /sources/], ['no bodies', r => r.bodies = [], /bodies/],
    ['duplicate sources', r => r.sources.push(r.sources[0]), /Source ids must be unique/],
    ['source path traversal', r => r.sources[0].id = '../1CRN', /id/],
    ['source URL', r => r.sources[0].url = 'https://example.invalid/1CRN.cif', /url/],
    ['source hash', r => r.sources[0].sha256 = 'bad', /sha256/],
    ['unknown source field', r => r.sources[0].extra = 1, /extra/],
    ['modelled source outside its recipe directory', r => r.sources[0] = { id: '1CRN', file: '../1CRN.cif', sha256: r.sources[0].sha256, modelled: 'x' }, /file/],
    ['absolute modelled source', r => r.sources[0] = { id: '1CRN', file: '/tmp/1CRN.cif', sha256: r.sources[0].sha256, modelled: 'x' }, /file/],
    ['modelled source without a note', r => r.sources[0] = { id: '1CRN', file: '1CRN.cif', sha256: r.sources[0].sha256 }, /modelled/],
    ['source with both a URL and a file', r => r.sources[0].file = '1CRN.cif', /file|url/],
    ['unknown body field', r => r.bodies[0].extra = 1, /extra/],
    ['missing atoms', r => delete r.bodies[0].atoms, /atoms/],
    ['unknown source', r => r.bodies[0].source = 'MISSING', /Unknown source/],
    ['duplicate chains', r => r.bodies.push(r.bodies[0]), /Output chains must be unique/],
    ['empty chain', r => r.bodies[0].chain = '', /chain/], ['placeholder chain', r => r.bodies[0].chain = '?', /identifier/],
    ['null chain', r => r.bodies[0].chain = '.', /identifier/],
    ['whitespace chain', r => r.bodies[0].chain = 'A B', /identifier/],
    ['no author chains', r => r.bodies[0].authChains = [], /authChains/],
    ['duplicate author chains', r => r.bodies[0].authChains = ['A', 'A'], /unique/],
    ['empty author chain', r => r.bodies[0].authChains = [''], /authChains/],
    ['backbone enum', r => r.bodies[0].atoms = 'ca', /atoms/],
    ['ligand selector', r => r.bodies[0].ligands = ['resname HEM'], /component ids/],
    ['duplicate ligands', r => r.bodies[0].ligands = ['HEM', 'HEM'], /unique/],
    ['range order', r => r.bodies[0].residues = { from: 20, to: 1 }, /from <= to/],
    ['range integer', r => r.bodies[0].residues = { from: 1.5, to: 20 }, /expected int/],
    ['unsafe range integer', r => r.bodies[0].residues = { from: 1, to: Number.MAX_SAFE_INTEGER + 1 }, /residues/],
    ['range infinite', r => r.bodies[0].residues = { from: 1, to: Infinity }, /residues/],
    ['unknown range field', r => r.bodies[0].residues = { from: 1, to: 20, extra: 1 }, /extra/],
    ['matrix shape', r => r.bodies[0].matrix = [[1, 0, 0], [0, 1, 0], [0, 0, 1]], /matrix/],
    ['matrix rows', r => r.bodies[0].matrix.pop(), /matrix/],
    ['matrix infinite', r => r.bodies[0].matrix[0][3] = Infinity, /matrix/],
    ['matrix NaN', r => r.bodies[0].matrix[0][0] = NaN, /matrix/],
    ['matrix type', r => r.bodies[0].matrix[0][0] = '1', /matrix/],
    ['scaling', r => r.bodies[0].matrix[0][0] = 2, /orthonormal/],
    ['shear', r => r.bodies[0].matrix[0][1] = 0.1, /orthonormal/],
    ['reflection', r => r.bodies[0].matrix[0][0] = -1, /determinant/],
  ];
  it.each(cases)('rejects %s', (_, edit, message) => {
    const r = recipe(); edit(r); expect(() => parseRigidCompositeRecipe(r)).toThrow(message);
  });
  it('rejects malformed JSON', () => expect(() => parseRigidCompositeRecipe('{')).toThrow());
  it('accepts rigid rotations within tolerance and normalizes hex hashes', () => {
    const r = recipe(); r.sources[0].sha256 = r.sources[0].sha256.toUpperCase(); r.bodies[0].matrix![0][0] += 1e-6;
    expect(parseRigidCompositeRecipe(r).sources[0].sha256).toBe(compositeSha256(texts['1CRN']));
  });
  it.each([
    ['missing chain', (b: ReturnType<typeof body>) => b.authChains = ['MISSING'], /matches no atoms/],
    ['one missing chain', (b: ReturnType<typeof body>) => b.authChains = ['A', 'MISSING'], /matches no atoms/],
    ['empty residue range', (b: ReturnType<typeof body>) => b.residues = { from: 1000, to: 2000 }, /matches no atoms/],
  ])('rejects %s against source atoms', async (_, edit, error) => {
    const b = body(); edit(b); await expect(build(recipe([b]))).rejects.toThrow(error);
  });
  it('rejects missing text, incorrect source digests, malformed CIF and absent atom-site data', async () => {
    await expect(buildRigidComposite(recipe(), {})).rejects.toThrow(/Missing source/);
    await expect(buildRigidComposite(recipe(), { '1CRN': 'wrong' })).rejects.toThrow(/sha256 mismatch/);
    for (const text of ['data_X\nloop_\n_atom_site.id\n1 2\n_bad.tag\n', 'data_X\n_entry.id X\n', 'data_X\n_entry.id X\ndata_Y\n_entry.id Y\n']) {
      const r = recipe(); r.sources[0].sha256 = compositeSha256(text);
      await expect(buildRigidComposite(r, { '1CRN': text })).rejects.toThrow();
    }
    const text = 'data_X\n_atom_site.id 1\n'; const r = recipe(); r.sources[0].sha256 = compositeSha256(text);
    await expect(buildRigidComposite(r, { '1CRN': text })).rejects.toThrow(/column .* required/);
  });
  it('rejects non-finite deposited coordinates', async () => {
    const text = texts['1CRN'].replace('17.047', 'NaN');
    expect(text).not.toBe(texts['1CRN']);
    const r = recipe(); r.sources[0].sha256 = compositeSha256(text);
    await expect(buildRigidComposite(r, { '1CRN': text })).rejects.toThrow(/coordinates must be finite/);
  });
  it('rejects overflow in transformed coordinates', async () => {
    const text = texts['1CRN'].replace('17.047', '1.7e308');
    const r = recipe(); r.sources[0].sha256 = compositeSha256(text); r.bodies[0].matrix![0][3] = 1.7e308;
    await expect(buildRigidComposite(r, { '1CRN': text })).rejects.toThrow(/transformed coordinates must be finite/);
  });
  it.each(['../recipe.json', '/recipe.json', 'a/../recipe.json', 'a\\recipe.json', '', 'a//recipe.json', './recipe.json'])('rejects recipe path %s', path => {
    expect(() => compositeRecipePath(path)).toThrow(/relative to demos/);
  });
  it('refuses to treat composite derivation as a one-source subset', () => {
    expect(() => applyGrowthDerivation('', { kind: 'prepared-rigid-composite', recipe: 'recipe.json' })).toThrow(/requires its recipe/);
  });
});

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function workspace() { const dir = await mkdtemp(resolve(tmpdir(), 'stereofold-composite-')); dirs.push(dir); return dir; }

describe('offline CLI and shared launcher/growth cache preparation', () => {
  it('writes CLI output and reports the exact index counts', async () => {
    const dir = await workspace(), r = recipe();
    await writeFile(resolve(dir, 'recipe.json'), JSON.stringify(r));
    await writeFile(resolve(dir, '1CRN.cif'), texts['1CRN']);
    const logged: string[] = [];
    const out = resolve(dir, 'out.cif');
    expect(await prepare([resolve(dir, 'recipe.json'), '--sources', dir, '--out', out], message => logged.push(message), dir)).toBe(0);
    const result = await build(r);
    const path = addressedDemoFile(out, result.sha256);
    expect(await readFile(path, 'utf8')).toBe(result.text);
    expect(JSON.parse(logged[0])).toEqual({ path, sha256: result.sha256, bytes: result.bytes, atomSites: result.atomSites, bodies: result.bodies });
    await expect(readFile(out)).rejects.toThrow();
    expect(await readdir(dir)).not.toContain('out.cif.partial');
  });
  it('reads deposited sources from a --sources folder outside the demos tree', async () => {
    const demos = await workspace(), cache = await workspace(), r = recipe();
    await writeFile(resolve(demos, 'recipe.json'), JSON.stringify(r));
    await writeFile(resolve(cache, '1CRN.cif'), texts['1CRN']);
    const out = resolve(cache, 'out.cif');
    expect(await prepare([resolve(demos, 'recipe.json'), '--sources', cache, '--out', out], () => {}, demos)).toBe(0);
    expect(await readFile(addressedDemoFile(out, (await build(r)).sha256), 'utf8')).toBe((await build(r)).text);
  });
  it.each([[], ['recipe.json'], ['recipe.json', '--sources'], ['recipe.json', '--wrong', 'a'], ['recipe.json', '--sources', 'a', '--sources', 'b', '--out', 'x']].map(args => [args] as const))('rejects invalid CLI arguments %j', args => {
    expect(() => parsePrepareCompositeArgs(args)).toThrow(/Usage/);
  });
  it('shares verified source caches, reuses output and rebuilds after a corrupt cache', async () => {
    const dir = await workspace(), r = recipe([body('X'), body('Y', '4HHB')]), result = await build(r);
    await writeFile(resolve(dir, 'recipe.json'), JSON.stringify(r));
    const asked: string[] = [];
    const fetchText = async (url: string) => { asked.push(url); return texts[r.sources.find(s => 'url' in s && s.url === url)!.id]; };
    const cachePath = (file: string) => resolve(dir, file);
    const request = { demo: 'fixture', stageId: 'copies', file: 'composite.cif', sha256: result.sha256,
      derivation: { kind: 'prepared-rigid-composite' as const, recipe: 'recipe.json' } };
    const hooks = { cachePath, fetchText, demosRoot: dir, announce: () => undefined };
    const first = await ensureGrowthCoordinates(request, hooks);
    expect(first.text).toBe(result.text); expect(first.fetched).toBe(true);
    expect(asked).toEqual(r.sources.map(s => 'url' in s ? s.url : ''));
    const entry: DemoEntry = { name: 'fixture', title: r.title, pdbId: '1CRN', lesson: 'fixture.json', sources: [],
      coordinates: { file: request.file, sha256: result.sha256, bytes: result.bytes, atomSites: result.atomSites, derivation: request.derivation } };
    expect(await resolveCoordinates(entry, dir, () => undefined, { demosRoot: dir, fetchText })).toBe(first.path);
    expect((await ensureGrowthCoordinates(request, hooks)).fetched).toBe(false);
    expect(asked).toHaveLength(2);
    await writeFile(first.path, 'corrupt');
    expect(await resolveCoordinates(entry, dir, () => undefined, { demosRoot: dir, fetchText })).toBe(first.path);
    expect(asked).toHaveLength(2); // Rebuilt from verified source cache.
    await writeFile(cachePath(`composite-sources/${r.sources[0].sha256}-${r.sources[0].id}.cif`), 'corrupt');
    await rm(first.path);
    await resolveCoordinates(entry, dir, () => undefined, { demosRoot: dir, fetchText });
    expect(asked).toHaveLength(3);
    expect(await readFile(first.path, 'utf8')).toBe(result.text);
    expect((await readdir(dir)).some(name => name.endsWith('.partial'))).toBe(false);
  });
  it.each(['launcher', 'growth'])('%s reads a modelled source beside its recipe, never fetches it, and refuses a changed one', async route => {
    const dir = await workspace(), deposited = recipe([body('X'), body('Y', '4HHB')]);
    const r: RigidCompositeRecipe = { ...deposited, sources: [deposited.sources[0],
      { id: '4HHB', file: 'model.cif', sha256: compositeSha256(texts['4HHB']), modelled: 'Fixture standing in for modelled residues.' }] };
    const result = await build(r);
    await writeFile(resolve(dir, 'recipe.json'), JSON.stringify(r));
    await writeFile(resolve(dir, 'model.cif'), texts['4HHB']);
    const asked: string[] = [];
    const fetchText = async (url: string) => { asked.push(url); return texts['1CRN']; };
    const derivation = { kind: 'prepared-rigid-composite' as const, recipe: 'recipe.json' };
    const run = (file: string) => route === 'growth'
      ? ensureGrowthCoordinates({ demo: 'fixture', stageId: 'copies', file, sha256: result.sha256, derivation }, {
        cachePath: name => resolve(dir, name), demosRoot: dir, fetchText, announce: () => undefined,
      }).then(value => value.path)
      : resolveCoordinates({ name: 'fixture', title: r.title, pdbId: '1CRN', lesson: 'fixture.json', sources: [],
        coordinates: { file, sha256: result.sha256, bytes: result.bytes, atomSites: result.atomSites, derivation } }, dir, () => undefined,
      { demosRoot: dir, fetchText });
    expect(await readFile(await run('first.cif'), 'utf8')).toBe(result.text);
    expect(asked).toEqual(['https://files.rcsb.org/download/1CRN.cif']);
    await writeFile(resolve(dir, 'model.cif'), texts['4HHB'].replace('4HHB', '4HHC'));
    await expect(run('second.cif')).rejects.toThrow(/Source 4HHB sha256 mismatch/);
    await writeFile(resolve(dir, '1CRN.cif'), texts['1CRN']);
    const logged: string[] = [];
    await writeFile(resolve(dir, 'model.cif'), texts['4HHB']);
    expect(await prepare([resolve(dir, 'recipe.json'), '--sources', dir, '--out', resolve(dir, 'cli.cif')], m => logged.push(m), dir)).toBe(0);
    expect(JSON.parse(logged[0]).sha256).toBe(result.sha256);
  });
  it.each(['launcher', 'growth'])('%s refuses source and final hash mismatches before writing output', async route => {
    const dir = await workspace(), r = recipe(), result = await build(r);
    await writeFile(resolve(dir, 'recipe.json'), JSON.stringify(r));
    const derivation = { kind: 'prepared-rigid-composite' as const, recipe: 'recipe.json' };
    const run = (sha256: string, text: string) => route === 'growth'
      ? ensureGrowthCoordinates({ demo: 'fixture', stageId: 'copies', file: 'out.cif', sha256, derivation }, {
        cachePath: file => resolve(dir, file), demosRoot: dir, fetchText: async () => text, announce: () => undefined,
      })
      : resolveCoordinates({ name: 'fixture', title: r.title, pdbId: '1CRN', lesson: 'fixture.json', sources: [],
        coordinates: { file: 'out.cif', sha256, bytes: result.bytes, atomSites: result.atomSites, derivation } }, dir, () => undefined,
      { demosRoot: dir, fetchText: async () => text });
    await expect(run(result.sha256, 'corrupt')).rejects.toThrow(/Source 1CRN sha256 mismatch/);
    await expect(readFile(resolve(dir, 'out.cif'))).rejects.toThrow();
    await expect(run('0'.repeat(64), texts['1CRN'])).rejects.toThrow(/no longer (?:serves|produces)/);
    await expect(readFile(resolve(dir, 'out.cif'))).rejects.toThrow();
    expect((await readdir(dir)).some(name => name.endsWith('.partial'))).toBe(false);
  });
});

describe('confined composite ingredients', () => {
  it('emits typed deposited and modelled provenance, retaining the modelling note', () => {
    const r = recipe([body(), body('L', '1CRN')]);
    r.sources.push({ id: 'linkers', file: 'linkers.cif', sha256: compositeSha256(texts['1CRN']), label: 'linkers', modelled: 'Idealised linkers' });
    expect(compositeSourceProvenance(r)).toEqual([
      { kind: 'deposited', id: '1CRN', url: 'https://files.rcsb.org/download/1CRN.cif' },
      { kind: 'modelled', id: 'linkers', file: 'linkers.cif', label: 'linkers', note: 'Idealised linkers' },
    ]);
  });

  it.each(['runtime', 'CLI'])('%s rejects escaped recipes, escaped ingredients and missing modelled files', async route => {
    const dir = await workspace(), root = resolve(dir, 'demos'), outside = resolve(dir, 'outside');
    await mkdir(root); await mkdir(outside);
    const r = recipe();
    r.sources = [{ id: '1CRN', file: 'model.cif', sha256: compositeSha256(texts['1CRN']), modelled: 'Synthetic test model' }];
    const recipePath = resolve(root, 'recipe.json');
    await writeFile(recipePath, JSON.stringify(r));
    await writeFile(resolve(outside, 'recipe.json'), JSON.stringify(r));
    await writeFile(resolve(outside, 'model.cif'), texts['1CRN']);
    await symlink(outside, resolve(root, 'alias'));
    const run = (path: string) => route === 'runtime'
      ? resolveCompositeText(path, { demosRoot: root, cachePath: file => resolve(dir, file), fetchText: async () => { throw Error('Unexpected fetch'); } })
      : prepare([path, '--sources', root, '--out', resolve(dir, 'out.cif')], () => {}, root);
    await expect(run(resolve(root, 'alias/recipe.json'))).rejects.toThrow('inside demos/');
    await expect(run(resolve(outside, 'recipe.json'))).rejects.toThrow('inside demos/');
    await expect(run(recipePath)).rejects.toThrow(/ENOENT/);
    await symlink(resolve(outside, 'model.cif'), resolve(root, 'model.cif'));
    await expect(run(recipePath)).rejects.toThrow('inside demos/');
    await rm(resolve(root, 'model.cif'));
    await writeFile(resolve(root, 'model.cif'), texts['1CRN']);
    await expect(run(recipePath)).resolves.toBeDefined();
  });
});
