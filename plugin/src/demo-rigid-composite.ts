/** Deterministic, offline preparation of deposited atoms at rigid-body poses. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { type CifCategory, type CifBlock } from 'molstar/lib/commonjs/mol-io/reader/cif.js';
import { CIF } from './compatible-cif.js';
import { superposeAtoms, type SuperpositionStats } from './structure-superposition.js';
import { CifWriter } from 'molstar/lib/commonjs/mol-io/writer/cif.js';

const name = z.string().min(1).refine(s => s === s.trim() && !/[\s\x00-\x1f]/.test(s) && s !== '.' && s !== '?', 'Expected a nonempty identifier without whitespace');
const uniqueNames = z.array(name).refine(v => v.length > 0, 'Expected at least one identifier').refine(a => new Set(a).size === a.length, 'Identifiers must be unique');
const finite = z.number().finite();
const row = z.array(finite).refine(v => v.length === 4, 'Expected four matrix columns').transform(v => v as [number, number, number, number]);
export const rigidCompositeMatrixSchema = z.array(row).refine(v => v.length === 3, 'Expected three matrix rows').transform(v => v as [z.infer<typeof row>, z.infer<typeof row>, z.infer<typeof row>]).superRefine((m, ctx) => {
  if (m.length !== 3 || m.some(r => r.length !== 4)) return;
  for (let i = 0; i < 3; i++) for (let j = i; j < 3; j++) {
    const dot = m[i][0] * m[j][0] + m[i][1] * m[j][1] + m[i][2] * m[j][2];
    if (Math.abs(dot - (i === j ? 1 : 0)) > 1e-4) {
      ctx.addIssue({ code: 'custom', message: 'Rotation must be orthonormal within 1e-4' });
    }
  }
  const d = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
    - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
    + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  if (Math.abs(d - 1) > 1e-4) ctx.addIssue({ code: 'custom', message: 'Rotation determinant must be +1 within 1e-4' });
});
export const compositeResidueRangeSchema = z.object({ from: z.number().safe().int(), to: z.number().safe().int() }).strict()
  .refine(r => r.from <= r.to, 'Residue range must have from <= to');
export const compositePlacementSchema = z.object({
  superpose: z.object({
    onto: z.union([name, z.number().safe().int().nonnegative()]).describe('Fixed body id (defaults to its output chain) or zero-based body index; forward references are allowed, cycles are refused.'),
    chains: z.object({ mobile: uniqueNames, fixed: uniqueNames }).strict().optional()
      .describe('Author chains paired in array order, with equal lengths. Omitted: use each body authChains in order. Must be retained by the bodies.'),
    residues: z.object({ mobile: compositeResidueRangeSchema, fixed: compositeResidueRangeSchema }).strict().optional()
      .describe('Inclusive author-number ranges within the retained bodies; alignment pairs by sequence, not residue number.'),
    atoms: z.enum(['CA', 'backbone']).optional().describe('Default CA; backbone pairs N, CA, C, O by name (no CB). One alternate conformer per residue.'),
    allowLowCoverage: z.boolean().optional().describe('Allow coverage below 0.30; never bypass the minimum of three paired atoms. Coverage is paired coordinate-bearing residues / selected observed protein residues, separately for mobile and fixed.'),
  }).strict(),
  then: z.object({ translate: z.array(finite).refine(v => v.length === 3, 'Expected three translation coordinates') }).strict().optional()
    .describe('Optional angstrom offset along the final fixed/composite frame axes, after fitting. RMSD describes the fit before this offset.'),
}).strict();

const sourceId = z.string().regex(/^[A-Za-z0-9_-]+$/);
const sourceSha256 = z.string().regex(/^[0-9a-f]{64}$/i).transform(s => s.toLowerCase());
export const depositedCompositeSourceSchema = z.object({
  id: sourceId,
  url: z.string().regex(/^https:\/\/files\.rcsb\.org\/download\/[A-Za-z0-9_-]+\.cif$/),
  sha256: sourceSha256,
}).strict();
// Residues no entry resolves (a neck linker between two deposited ends, an
// idealised stalk) come from a small mmCIF built by a documented script and
// shipped beside the recipe. It is never fetched, and `modelled` says what it is.
export const modelledCompositeSourceSchema = z.object({
  id: sourceId,
  file: z.string().regex(/^[A-Za-z0-9_-]+\.cif$/).describe('mmCIF file name in the recipe\'s own directory.'),
  sha256: sourceSha256,
  label: z.string().trim().min(1).max(40).optional().describe('Short name for the modelled parts in the readout.'),
  modelled: z.string().trim().min(1).max(600).describe('What the file models and how it was built.'),
}).strict();
export type ModelledCompositeSource = z.infer<typeof modelledCompositeSourceSchema>;
export const isModelledCompositeSource = (source: object): source is ModelledCompositeSource => 'file' in source;

export const rigidCompositeRecipeSchema = z.object({
  version: z.literal(1), id: name, title: z.string().trim().min(1),
  sources: z.array(z.union([depositedCompositeSourceSchema, modelledCompositeSourceSchema]))
    .refine(v => v.length > 0, 'Expected at least one item'),
  bodies: z.array(z.object({
    id: name.optional().describe('Unique body id; defaults to chain.'), source: name, authChains: uniqueNames,
    residues: z.object({ from: z.number().safe().int(), to: z.number().safe().int() }).strict()
      .refine(r => r.from <= r.to, 'Residue range must have from <= to').optional(),
    atoms: z.enum(['all', 'backbone']),
    ligands: z.array(z.string().regex(/^[A-Z0-9]+$/, 'Ligands must be component ids')).refine(a => new Set(a).size === a.length, 'Ligands must be unique').optional(),
    chain: name, matrix: rigidCompositeMatrixSchema.optional().describe('Row-major 3x4 rigid transform: orthonormal rotation with determinant +1, then translation in angstroms. Supply exactly one of matrix or place.'),
    place: compositePlacementSchema.optional(),
  }).strict()).refine(v => v.length > 0, 'Expected at least one item'),
}).strict().superRefine((r, ctx) => {
  if (new Set(r.sources.map(s => s.id)).size !== r.sources.length) ctx.addIssue({ code: 'custom', path: ['sources'], message: 'Source ids must be unique' });
  if (new Set(r.bodies.map(b => b.chain)).size !== r.bodies.length) ctx.addIssue({ code: 'custom', path: ['bodies'], message: 'Output chains must be unique' });
  validateCompositePlacements(r.bodies, ctx);
  for (const [i, b] of r.bodies.entries()) if (!r.sources.some(s => s.id === b.source)) ctx.addIssue({ code: 'custom', path: ['bodies', i, 'source'], message: `Unknown source ${b.source}` });
});

export type RigidCompositeRecipe = z.infer<typeof rigidCompositeRecipeSchema>;
/** Validate dependencies before source downloads, also shared by the public schema. */
export function validateCompositePlacements(bodies: RigidCompositeRecipe['bodies'], ctx: z.RefinementCtx) {
  const ids = bodies.map(b => b.id ?? b.chain);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', path: ['bodies'], message: 'Body ids must be unique' });
  const parents = bodies.map((b, i) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', path: ['bodies', i, 'place'], message });
    if (!!b.matrix === !!b.place) fail('Supply exactly one of matrix or place');
    if (!b.place) return -1;
    const spec = b.place.superpose;
    const parent = typeof spec.onto === 'number' ? spec.onto : ids.indexOf(spec.onto);
    if (parent < 0 || parent >= bodies.length) { fail(`Unknown superposition body ${spec.onto}`); return -1; }
    const mobile = spec.chains?.mobile ?? b.authChains, fixed = spec.chains?.fixed ?? bodies[parent].authChains;
    if (mobile.length !== fixed.length) fail('Superposition mobile and fixed chains must have equal lengths (paired in order)');
    if (mobile.some(c => !b.authChains.includes(c)) || fixed.some(c => !bodies[parent].authChains.includes(c)))
      fail('Superposition chains must be retained in their respective bodies');
    return parent;
  });
  const done = new Set<number>();
  for (let i = 0; i < bodies.length; i++) {
    const visiting = new Set<number>();
    let j = i;
    while (j >= 0 && !done.has(j)) {
      if (visiting.has(j)) { ctx.addIssue({ code: 'custom', path: ['bodies', i, 'place'], message: 'Superposition dependency cycle' }); break; }
      visiting.add(j); j = parents[j];
    }
    for (const v of visiting) done.add(v);
  }
}
export function parseRigidCompositeRecipe(input: unknown): RigidCompositeRecipe {
  return rigidCompositeRecipeSchema.parse(typeof input === 'string' ? JSON.parse(input) : input);
}
export const compositeSha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

type Row = Record<string, string>;
function rows(category?: CifCategory): Row[] {
  if (!category) return [];
  return Array.from({ length: category.rowCount }, (_, i) => Object.fromEntries(category.fieldNames.map(key => {
    const field = category.getField(key)!;
    const kind = field.valueKind(i);
    return [key, kind === 1 ? '.' : kind === 2 ? '?' : field.str(i)];
  })));
}
const present = (s?: string): s is string => s !== undefined && s !== '.' && s !== '?';
const backbone = new Set(['N', 'CA', 'C', 'O', 'CB']);
const waters = new Set(['HOH', 'DOD', 'WAT', 'H2O']);

function fixedCoordinate(value: number): string {
  const fixed = (Math.abs(value) < 0.0005 ? 0 : value).toFixed(3);
  if (!fixed.includes('e')) return fixed;
  // toFixed uses exponent notation above 1e21; keep the format fixed even for
  // finite translations of that size, without imposing an unstated pose cap.
  const [mantissa, exponent] = fixed.split('e');
  const digits = mantissa.replace('.', '');
  const fractional = mantissa.includes('.') ? mantissa.length - mantissa.indexOf('.') - 1 : 0;
  return digits + '0'.repeat(Number(exponent) - fractional) + '.000';
}

function encode(id: string, categories: Map<string, Row[]>): string {
  const encoder = CifWriter.createEncoder({ binary: false });
  encoder.startDataBlock(id);
  for (const [name, data] of categories) {
    if (!data.length) continue;
    const fields = [...new Set(data.flatMap(r => Object.keys(r)))];
    encoder.writeCategory({ name, instance: () => ({
      fields: fields.map(key => CifWriter.Field.str<number>(key, i => data[i][key] ?? '?', {
        valueKind: i => data[i][key] === '.' ? 1 : !present(data[i][key]) ? 2 : 0,
      })), source: [{ rowCount: data.length }],
    }) });
  }
  return encoder.getData() as string;
}

/**
 * Source texts are keyed by recipe source id, and verified before parsing.
 * Ranges trim polymers; explicitly listed ligands on those author chains stay
 * whole, including their side atoms when a polymer is trimmed to backbone.
 */
export type CompositeMatrix = z.infer<typeof rigidCompositeMatrixSchema>;
export type CompositeBodyIdentity = { id: string; matrix: CompositeMatrix; superposition?: SuperpositionStats & { onto: string; ontoBodyIndex: number }; bodyIndex: number; chain: string; source: string; atomSites: number; labelChains: string[]; labelChainMapping: { sourceLabelChain: string; labelChain: string }[] };

export async function buildRigidComposite(
  input: unknown, sourceTexts: Readonly<Record<string, string>>,
  options: { maximumAtomSites?: number } = {},
): Promise<{ text: string; sha256: string; bytes: number; atomSites: number; bodies: CompositeBodyIdentity[] }> {
  const recipe = parseRigidCompositeRecipe(input);
  const categoryRows = new Map<CifCategory, Row[]>();
  const readRows = (category?: CifCategory): Row[] => {
    if (!category) return [];
    let data = categoryRows.get(category);
    if (!data) { data = rows(category); categoryRows.set(category, data); }
    return data;
  };
  const sources = new Map<string, CifBlock>();
  for (const source of recipe.sources) {
    if (!Object.hasOwn(sourceTexts, source.id)) throw Error(`Missing source text ${source.id}`);
    const text = sourceTexts[source.id];
    if (compositeSha256(text) !== source.sha256) throw Error(`Source ${source.id} sha256 mismatch`);
    const parsed = await CIF.parse(text).run();
    if (parsed.isError) throw Error(`Source ${source.id}: invalid mmCIF: ${parsed.message}`);
    if (parsed.result.blocks.length !== 1 || !parsed.result.blocks[0].categories.atom_site) throw Error(`Source ${source.id} must contain one atom-site data block`);
    sources.set(source.id, parsed.result.blocks[0]);
  }
  const categories = new Map<string, Row[]>();
  const add = (name: string, data: Row[]) => categories.set(name, [...(categories.get(name) ?? []), ...data]);
  const usedComponents = new Map<string, { frame: CifBlock }>();
  const usedElements = new Map<string, CifBlock>();
  const confTypes = new Map<string, Row>();
  const bodies: CompositeBodyIdentity[] = [];
  let atomId = 0, entityId = 0, connectionId = 0;
  const usedLabelChains = new Set(recipe.bodies.map(b => b.chain));
  const connectionTypes = new Map<string, Row>();
  const selections = recipe.bodies.map((body, bodyIndex) => {
    const frame = sources.get(body.source)!;
    const all = readRows(frame.categories.atom_site);
    const required = ['auth_asym_id', 'label_asym_id', 'label_entity_id', 'label_comp_id', 'label_atom_id', 'auth_seq_id', 'Cartn_x', 'Cartn_y', 'Cartn_z'];
    for (const field of required) if (!frame.categories.atom_site.getField(field)) throw Error(`Source ${body.source} atom-site column ${field} is required`);
    const entities = new Map(readRows(frame.categories.entity).map(r => [r.id, r]));
    const isPolymer = (a: Row) => entities.get(a.label_entity_id)?.type === 'polymer'
      || (!entities.has(a.label_entity_id) && (present(a.label_seq_id) || a.group_PDB === 'ATOM'));
    const firstModel = all[0]?.pdbx_PDB_model_num;
    const inChains = all.filter(a => a.pdbx_PDB_model_num === firstModel && body.authChains.includes(a.auth_asym_id));
    for (const chain of body.authChains) if (!inChains.some(a => a.auth_asym_id === chain)) throw Error(`recipe.bodies[${bodyIndex}] (${body.chain}): author chain ${chain} matches no atoms in the first model`);
    const selected = inChains.filter(a => {
      if (waters.has(a.label_comp_id) || entities.get(a.label_entity_id)?.type === 'water') return false;
      if (!isPolymer(a)) return body.ligands?.includes(a.label_comp_id) ?? false;
      if (body.residues && (!present(a.auth_seq_id) || !Number.isFinite(Number(a.auth_seq_id))
        || Number(a.auth_seq_id) < body.residues.from || Number(a.auth_seq_id) > body.residues.to)) return false;
      return body.atoms === 'all' || backbone.has(a.label_atom_id);
    });
    if (!selected.length) throw Error(`recipe.bodies[${bodyIndex}] (${body.chain}): selection matches no atoms`);
    for (const chain of body.authChains) if (!selected.some(a => a.auth_asym_id === chain)) throw Error(`recipe.bodies[${bodyIndex}] (${body.chain}): selection of ${chain} matches no atoms`);
    return { frame, entities, isPolymer, selected };
  });
  const poses = new Map<number, { matrix: CompositeMatrix; superposition?: CompositeBodyIdentity['superposition'] }>();
  // Resolve roots before children without depending on recipe order or rounding
  // deposited coordinates through an intermediate mmCIF serialization.
  for (let start = 0; start < recipe.bodies.length; start++) {
    const pending: number[] = [];
    let index = start;
    while (!poses.has(index)) {
      const body = recipe.bodies[index];
      if (body.matrix) { poses.set(index, { matrix: body.matrix }); break; }
      pending.push(index);
      const onto = body.place!.superpose.onto;
      index = typeof onto === 'number' ? onto : recipe.bodies.findIndex(b => (b.id ?? b.chain) === onto);
    }
    for (const i of pending.reverse()) {
      const body = recipe.bodies[i], spec = body.place!.superpose;
      const fixedIndex = typeof spec.onto === 'number' ? spec.onto : recipe.bodies.findIndex(b => (b.id ?? b.chain) === spec.onto);
      const fixed = recipe.bodies[fixedIndex];
      try {
        const fit = superposeAtoms(selections[i].selected.filter(selections[i].isPolymer),
          selections[fixedIndex].selected.filter(selections[fixedIndex].isPolymer), {
            ...spec, chains: spec.chains ?? { mobile: body.authChains, fixed: fixed.authChains },
          }, poses.get(fixedIndex)!.matrix);
        const matrix = rigidCompositeMatrixSchema.parse(fit.matrix);
        if (body.place!.then) for (let k = 0; k < 3; k++) matrix[k][3] += body.place!.then.translate[k];
        poses.set(i, { matrix, superposition: { ...fit.stats, onto: fixed.id ?? fixed.chain, ontoBodyIndex: fixedIndex } });
      } catch (error) { throw Error(`recipe.bodies[${i}].place: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }
  for (const [bodyIndex, body] of recipe.bodies.entries()) {
    const { frame, entities, isPolymer, selected } = selections[bodyIndex];
    const pose = poses.get(bodyIndex)!;
    if (options.maximumAtomSites !== undefined && atomId + selected.length > options.maximumAtomSites)
      throw Error(`recipe.bodies[${bodyIndex}]: composite exceeds maximumAtomSites budget ${options.maximumAtomSites}`);
    // One label chain per retained source asym; author chain addresses the body.
    // Reserve every body's primary id so suffixes cannot collide across bodies.
    const entityMap = new Map<string, string>();
    const labelMap = new Map<string, string>();
    const keyOf = (a: Row) => `${a.label_asym_id}\0${a.label_entity_id}`;
    const primary = selected.find(isPolymer) ?? selected[0];
    labelMap.set(primary.label_asym_id, body.chain);
    let suffix = 0;
    for (const a of selected) {
      if (!labelMap.has(a.label_asym_id)) {
        let label: string;
        do { label = `${body.chain}_${++suffix}`; } while (usedLabelChains.has(label));
        usedLabelChains.add(label);
        labelMap.set(a.label_asym_id, label);
      }
      if (entityMap.has(keyOf(a))) continue;
      const id = String(++entityId);
      entityMap.set(keyOf(a), id);
      add('entity', [{ ...(entities.get(a.label_entity_id) ?? { type: isPolymer(a) ? 'polymer' : 'non-polymer' }), id }]);
      add('entity_poly', readRows(frame.categories.entity_poly).filter(r => r.entity_id === a.label_entity_id).map(r => ({ ...r, entity_id: id, pdbx_strand_id: body.chain })));
      const seq = readRows(frame.categories.entity_poly_seq).filter(r => r.entity_id === a.label_entity_id);
      // Label sequence numbers remain local to the deposited entity.
      add('entity_poly_seq', seq.map(r => ({ ...r, entity_id: id })));
      for (const r of seq) if (!usedComponents.has(r.mon_id)) usedComponents.set(r.mon_id, { frame });
      add('pdbx_entity_nonpoly', readRows(frame.categories.pdbx_entity_nonpoly).filter(r => r.entity_id === a.label_entity_id).map(r => ({ ...r, entity_id: id })));
      const asym = readRows(frame.categories.struct_asym).find(r => r.id === a.label_asym_id);
      add('struct_asym', [{ ...asym, id: labelMap.get(a.label_asym_id)!, entity_id: id }]);
    }
    bodies.push({ id: body.id ?? body.chain, ...pose, bodyIndex, chain: body.chain, source: body.source, atomSites: selected.length,
      labelChains: [...labelMap.values()], labelChainMapping: [...labelMap].map(([sourceLabelChain, labelChain]) => ({ sourceLabelChain, labelChain })) });
    const transformed = selected.map(a => {
      const xyz = [a.Cartn_x, a.Cartn_y, a.Cartn_z].map(v => present(v) ? Number(v) : NaN);
      if (!xyz.every(Number.isFinite)) throw Error(`Source ${body.source} atom ${a.id}: coordinates must be finite`);
      const moved = pose.matrix.map(r => r[0] * xyz[0] + r[1] * xyz[1] + r[2] * xyz[2] + r[3]);
      if (!moved.every(Number.isFinite)) throw Error(`recipe.bodies[${bodyIndex}] (${body.chain}): transformed coordinates must be finite`);
      if (!usedComponents.has(a.label_comp_id)) usedComponents.set(a.label_comp_id, { frame });
      if (present(a.type_symbol) && !usedElements.has(a.type_symbol)) usedElements.set(a.type_symbol, frame);
      const fixed = moved.map(fixedCoordinate);
      return { ...a, id: String(++atomId), label_asym_id: labelMap.get(a.label_asym_id)!, auth_asym_id: body.chain,
        label_entity_id: entityMap.get(keyOf(a))!, pdbx_PDB_model_num: '1',
        Cartn_x: fixed[0], Cartn_y: fixed[1], Cartn_z: fixed[2] };
    });
    add('atom_site', transformed);
    // Connections only survive when both deposited endpoint atoms survive in
    // this body. Crystal mates are not present in these rigid coordinate copies.
    const endpoint = (r: Row, side: 'ptnr1' | 'ptnr2') => selected.find(a => {
      for (const ns of ['label', 'auth']) for (const field of ['asym_id', 'comp_id', 'seq_id', 'atom_id']) {
        const value = r[`${side}_${ns}_${field}`];
        if (present(value) && a[`${ns}_${field}`] !== value) return false;
      }
      for (const [conn, atom] of [[`pdbx_${side}_label_alt_id`, 'label_alt_id'], [`pdbx_${side}_PDB_ins_code`, 'pdbx_PDB_ins_code']]) {
        // Missing alt/insert codes mean the unqualified atom, not any conformer.
        const normalize = (v?: string) => present(v) ? v : '';
        if (normalize(r[conn]) !== normalize(a[atom])) return false;
      }
      return true;
    });
    for (const original of readRows(frame.categories.struct_conn)) {
      if (original.ptnr1_symmetry !== '1_555' || original.ptnr2_symmetry !== '1_555') continue;
      const first = endpoint(original, 'ptnr1'), second = endpoint(original, 'ptnr2');
      if (!first || !second) continue;
      const r: Row = { ...original, id: `conn${++connectionId}` };
      for (const [side, atom] of [['ptnr1', first], ['ptnr2', second]] as const) {
        for (const ns of ['label', 'auth']) {
          r[`${side}_${ns}_asym_id`] = ns === 'auth' ? body.chain : labelMap.get(atom.label_asym_id)!;
          for (const field of ['comp_id', 'seq_id']) r[`${side}_${ns}_${field}`] = atom[`${ns}_${field}`] ?? '?';
          if (present(original[`${side}_${ns}_atom_id`])) r[`${side}_${ns}_atom_id`] = atom[`${ns}_atom_id`];
        }
        r[`pdbx_${side}_label_alt_id`] = atom.label_alt_id ?? '?';
        r[`pdbx_${side}_PDB_ins_code`] = atom.pdbx_PDB_ins_code ?? '?';
      }
      add('struct_conn', [r]);
      const type = readRows(frame.categories.struct_conn_type).find(t => t.id === r.conn_type_id);
      if (type && !connectionTypes.has(type.id)) connectionTypes.set(type.id, type);
    }
    const prefix = `B${bodyIndex + 1}_`;
    const sheets = new Set<string>();
    for (const category of ['struct_conf', 'struct_sheet_range']) for (const original of readRows(frame.categories[category])) {
      // Intersect annotations with retained residues and clip their endpoints
      // to real selected atoms, preserving insertion codes and both numberings.
      const useLabel = present(original.beg_label_seq_id) && present(original.end_label_seq_id);
      const seqKey = useLabel ? 'label_seq_id' : 'auth_seq_id';
      const start = Number(original[`beg_${seqKey}`]), end = Number(original[`end_${seqKey}`]);
      const insertion = (v: string | undefined) => present(v) ? v : '';
      const candidates = selected.filter(a => isPolymer(a) && a.label_asym_id === original.beg_label_asym_id
        && a.label_asym_id === original.end_label_asym_id && Number(a[seqKey]) >= start && Number(a[seqKey]) <= end
        && (useLabel || ((Number(a[seqKey]) !== start || insertion(a.pdbx_PDB_ins_code) >= insertion(original.pdbx_beg_PDB_ins_code))
          && (Number(a[seqKey]) !== end || insertion(a.pdbx_PDB_ins_code) <= insertion(original.pdbx_end_PDB_ins_code)))));
      if (!candidates.length) continue;
      const r: Row = { ...original, id: prefix + original.id };
      for (const [side, atom] of [['beg', candidates[0]], ['end', candidates.at(-1)!]] as const) {
        for (const ns of ['label', 'auth']) {
          r[`${side}_${ns}_asym_id`] = ns === 'auth' ? body.chain : labelMap.get(atom.label_asym_id)!;
          r[`${side}_${ns}_seq_id`] = atom[`${ns}_seq_id`] ?? '?';
          r[`${side}_${ns}_comp_id`] = atom[`${ns}_comp_id`] ?? atom.label_comp_id;
        }
        r[`pdbx_${side}_PDB_ins_code`] = atom.pdbx_PDB_ins_code ?? '?';
      }
      if (category === 'struct_conf') {
        if (present(r.pdbx_PDB_helix_id)) r.pdbx_PDB_helix_id = prefix + r.pdbx_PDB_helix_id;
        if (present(r.pdbx_PDB_helix_length)) r.pdbx_PDB_helix_length = String(new Set(candidates.map(a => `${a.label_seq_id}\0${a.auth_seq_id}\0${a.pdbx_PDB_ins_code}`)).size);
        const type = readRows(frame.categories.struct_conf_type).find(t => t.id === r.conf_type_id);
        if (type && !confTypes.has(type.id)) confTypes.set(type.id, type);
      } else { sheets.add(original.sheet_id); r.sheet_id = prefix + original.sheet_id; }
      add(category, [r]);
    }
    add('struct_sheet', readRows(frame.categories.struct_sheet).filter(r => sheets.has(r.id)).map(r => ({ ...r, id: prefix + r.id,
      number_strands: String((categories.get('struct_sheet_range') ?? []).filter(s => s.sheet_id === prefix + r.id).length) })));
    add('struct_sheet_order', readRows(frame.categories.struct_sheet_order).filter(r => sheets.has(r.sheet_id)
      && ['range_id_1', 'range_id_2'].every(k => (categories.get('struct_sheet_range') ?? []).some(s => s.id === prefix + r[k])))
      .map(r => ({ ...r, sheet_id: prefix + r.sheet_id, range_id_1: prefix + r.range_id_1, range_id_2: prefix + r.range_id_2 })));
  }
  add('struct_conf_type', [...confTypes.values()]);
  add('struct_conn_type', [...connectionTypes.values()]);
  for (const [id, { frame }] of usedComponents) {
    const comp = readRows(frame.categories.chem_comp).find(r => r.id === id);
    add('chem_comp', [comp ?? { id, type: 'non-polymer', name: id }]);
    add('chem_comp_bond', readRows(frame.categories.chem_comp_bond).filter(r => r.comp_id === id));
  }
  for (const [symbol, frame] of usedElements) add('atom_type', [readRows(frame.categories.atom_type).find(r => r.symbol === symbol) ?? { symbol }]);
  const text = encode(recipe.id, categories);
  return { text, sha256: compositeSha256(text), bytes: Buffer.byteLength(text, 'utf8'), atomSites: atomId, bodies };
}

/** Display provenance keeps local models distinct from deposited entries. */
export function compositeSourceProvenance(recipe: RigidCompositeRecipe) {
  return recipe.sources.map(source => isModelledCompositeSource(source)
    ? { kind: 'modelled' as const, id: source.id, file: source.file, note: source.modelled,
      ...(source.label ? { label: source.label } : {}) }
    : { kind: 'deposited' as const, id: source.id, url: source.url });
}
