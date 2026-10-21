import { readFile } from 'node:fs/promises';
import { CIF } from 'molstar/lib/commonjs/mol-io/reader/cif.js';
import { CifWriter } from 'molstar/lib/commonjs/mol-io/writer/cif.js';
import { getProteinOneLetterCode } from 'molstar/lib/commonjs/mol-model/sequence/constants.js';

export const crambin = await readFile(new URL('../../../fixtures/1CRN.cif', import.meta.url), 'utf8');
export const hemoglobin = await readFile(new URL('../../../fixtures/4HHB.cif', import.meta.url), 'utf8');
export const identity = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]];
export const forward = [[0, -1, 0, 10], [1, 0, 0, -20], [0, 0, 1, 30]];
export const inverse = [[0, 1, 0, 20], [-1, 0, 0, 10], [0, 0, 1, -30]];
// Synthetic homologue: nine of 46 residues mutated, auth numbers shifted by 100,
// and every atom rigidly moved. Metadata and coordinates remain self-contained.
export async function syntheticCrambin(options: { remove?: number[]; reflect?: boolean } = {}) {
  const parsed = await CIF.parse(crambin).run();
  if (parsed.isError) throw Error(parsed.message);
  const frame = parsed.result.blocks[0];
  const mutated = (n: number, comp: string) => n % 5 === 0 ? comp === 'ALA' ? 'GLY' : 'ALA' : comp;
  const encoder = CifWriter.createEncoder({ binary: false }); encoder.startDataBlock('synthetic_homologue');
  const sequence = Array.from({ length: frame.categories.entity_poly_seq.rowCount }, (_, i) => {
    const seq = frame.categories.entity_poly_seq;
    return getProteinOneLetterCode(mutated(Number(seq.getField('num')!.str(i)), seq.getField('mon_id')!.str(i)));
  }).join('');
  for (const name of frame.categoryNames) {
    const cat = frame.categories[name];
    let rows = Array.from({ length: cat.rowCount }, (_, i) => Object.fromEntries(cat.fieldNames.map(k => [k, cat.getField(k)!.str(i)])));
    if (name === 'atom_site') rows = rows.filter(r => !options.remove?.includes(Number(r.label_seq_id))).map(r => {
      const xyz = ['Cartn_x', 'Cartn_y', 'Cartn_z'].map(k => Number(r[k]));
      const moved = options.reflect ? [-xyz[0], xyz[1], xyz[2]] : forward.map(row => row[0] * xyz[0] + row[1] * xyz[1] + row[2] * xyz[2] + row[3]);
      return { ...r, auth_seq_id: String(Number(r.auth_seq_id) + 100),
        label_comp_id: mutated(Number(r.label_seq_id), r.label_comp_id), auth_comp_id: mutated(Number(r.label_seq_id), r.auth_comp_id),
        Cartn_x: String(moved[0]), Cartn_y: String(moved[1]), Cartn_z: String(moved[2]) };
    });
    if (name === 'entity_poly_seq') rows = rows.map(r => ({ ...r, mon_id: mutated(Number(r.num), r.mon_id) }));
    if (name === 'entity_poly') rows = rows.map(r => ({ ...r, pdbx_seq_one_letter_code: sequence, pdbx_seq_one_letter_code_can: sequence }));
    // Source annotations refer to unmodified chemistry/numbering; exclude them.
    if (['struct_conn', 'struct_conf', 'struct_sheet_range', 'pdbx_poly_seq_scheme'].includes(name)) continue;
    encoder.writeCategory({ name, instance: () => ({ fields: cat.fieldNames.map(k => CifWriter.Field.str<number>(k, i => rows[i][k] || '?')),
      source: [{ rowCount: rows.length }] }) });
  }
  return encoder.getData() as string;
}
