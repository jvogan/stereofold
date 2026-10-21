/** Sequence-guided rigid fitting, independent of composite serialization/rendering. */
import { JacobiSVDImpl } from 'molstar/lib/commonjs/mol-math/linear-algebra/matrix/svd.js';
import { getProteinOneLetterCode } from 'molstar/lib/commonjs/mol-model/sequence/constants.js';
import { SubstitutionMatrices } from 'molstar/lib/commonjs/mol-model/sequence/alignment/substitution-matrix.js';

type Atom = Record<string, string>;
type Range = { from: number; to: number };
type Point = number[];
export type SuperpositionStats = {
  rmsd: number; pairedAtomCount: number; pairedResidueCount: number;
  sequenceIdentity: number; coverage: { mobile: number; fixed: number };
};
type Residue = { letter: string; atoms: Map<string, Point> };
const present = (v?: string) => v !== undefined && v !== '.' && v !== '?';
const score = (a: string, b: string) => SubstitutionMatrices.blosum62[a]?.[b] ?? (a === b && a !== 'X' ? 1 : -1);
const gap = -5;

/** Last Needleman-Wunsch row. Hirschberg traceback keeps memory linear. */
function scoreRow(a: string[], b: string[]): Float64Array {
  let previous = Float64Array.from({ length: b.length + 1 }, (_, j) => j * gap);
  let current = new Float64Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    current[0] = i * gap;
    for (let j = 1; j <= b.length; j++) current[j] = Math.max(
      previous[j - 1] + score(a[i - 1], b[j - 1]), previous[j] + gap, current[j - 1] + gap);
    [previous, current] = [current, previous];
  }
  return previous;
}

/** Global alignment, including mismatches; gaps never produce atom pairs. */
export function alignProteinSequences(a: string[], b: string[]): [number, number][] {
  const pairs: [number, number][] = [];
  function align(x: string[], y: string[], ox: number, oy: number) {
    if (!x.length || !y.length) return;
    if (x.length === 1) {
      // A single diagonal plus gaps, or all gaps if every substitution is worse.
      let best = (y.length + 1) * gap, index = -1;
      for (let j = 0; j < y.length; j++) {
        const value = score(x[0], y[j]) + (y.length - 1) * gap;
        if (value > best) { best = value; index = j; }
      }
      if (index >= 0) pairs.push([ox, oy + index]);
      return;
    }
    const middle = Math.floor(x.length / 2);
    // Keep score arrays out of recursive stack frames.
    const split = (() => {
      const left = scoreRow(x.slice(0, middle), y);
      const right = scoreRow(x.slice(middle).reverse(), [...y].reverse());
      let best = -Infinity, at = 0;
      for (let j = 0; j <= y.length; j++) {
        const value = left[j] + right[y.length - j];
        if (value > best) { best = value; at = j; }
      }
      return at;
    })();
    align(x.slice(0, middle), y.slice(0, split), ox, oy);
    align(x.slice(middle), y.slice(split), ox + middle, oy + split);
  }
  align(a, b, 0, 0);
  return pairs;
}

function residues(rows: Atom[], chain: string, range?: Range): Residue[] {
  const groups = new Map<string, Atom[]>();
  for (const a of rows) {
    if (a.auth_asym_id !== chain || (range && (!present(a.auth_seq_id)
      || Number(a.auth_seq_id) < range.from || Number(a.auth_seq_id) > range.to))) continue;
    // Label numbers define order and insertion identity, never cross-source pairing.
    const key = `${a.label_asym_id}\0${present(a.label_seq_id) ? a.label_seq_id : a.auth_seq_id}\0${present(a.pdbx_PDB_ins_code) ? a.pdbx_PDB_ins_code : ''}`;
    const group = groups.get(key) ?? [];
    group.push(a); groups.set(key, group);
  }
  const ordered = [...groups.values()].sort((a, b) => a[0].label_asym_id.localeCompare(b[0].label_asym_id)
    || Number(present(a[0].label_seq_id) ? a[0].label_seq_id : a[0].auth_seq_id) - Number(present(b[0].label_seq_id) ? b[0].label_seq_id : b[0].auth_seq_id)
    || (a[0].pdbx_PDB_ins_code ?? '').localeCompare(b[0].pdbx_PDB_ins_code ?? ''));
  return ordered.filter(group => group.some(a => a.label_atom_id === 'CA' || getProteinOneLetterCode(a.label_comp_id) !== 'X')).map(group => {
    // Select one alternate for the entire residue; never overweight alternates.
    const alternates = new Map<string, number[]>();
    for (const a of group) if (present(a.label_alt_id)) {
      const values = alternates.get(a.label_alt_id) ?? [];
      values.push(present(a.occupancy) && Number.isFinite(Number(a.occupancy)) ? Number(a.occupancy) : 0);
      alternates.set(a.label_alt_id, values);
    }
    const average = (v: number[]) => v.reduce((s, n) => s + n, 0) / v.length;
    const alternate = [...alternates].sort((a, b) => average(b[1]) - average(a[1]) || a[0].localeCompare(b[0]))[0]?.[0];
    const selected = group.filter(a => !present(a.label_alt_id) || a.label_alt_id === alternate);
    const atoms = new Map<string, Point>();
    for (const a of selected) {
      if (!['N', 'CA', 'C', 'O'].includes(a.label_atom_id) || atoms.has(a.label_atom_id)) continue;
      const xyz = [a.Cartn_x, a.Cartn_y, a.Cartn_z].map(v => present(v) ? Number(v) : NaN);
      if (!xyz.every(Number.isFinite)) throw Error('Superposition coordinates must be finite');
      atoms.set(a.label_atom_id, xyz);
    }
    return { letter: getProteinOneLetterCode((selected.find(a => a.label_atom_id === 'CA') ?? selected[0]).label_comp_id), atoms };
  });
}
const transform = (matrix: number[][], xyz: Point) => matrix.map(row => row[0] * xyz[0] + row[1] * xyz[1] + row[2] * xyz[2] + row[3]);
const determinant = (m: number[][]) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
  - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);

/** Equal-weight Kabsch: H=X'Y, R=V diag(1,1,det(VU')) U'. */
export function kabsch(mobile: Point[], fixed: Point[]): { matrix: number[][]; rmsd: number } {
  if (mobile.length !== fixed.length || mobile.length < 3) throw Error('Superposition requires at least 3 paired atoms');
  const center = (points: Point[]) => [0, 1, 2].map(k => points.reduce((sum, p) => sum + p[k], 0) / points.length);
  const cm = center(mobile), cf = center(fixed);
  const ut = new Float64Array(9), vt = new Float64Array(9), singular = new Float64Array(3);
  // JacobiSVDImpl takes H transposed in row-major storage and returns U' / V'.
  for (let n = 0; n < mobile.length; n++) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++)
    ut[j * 3 + i] += (mobile[n][i] - cm[i]) * (fixed[n][j] - cf[j]);
  JacobiSVDImpl(ut, 3, singular, vt, 3, 3, 3, 3);
  const rotation = (sign: number) => [0, 1, 2].map(i => [0, 1, 2].map(j =>
    [0, 1, 2].reduce((sum, k) => sum + vt[k * 3 + i] * (k === 2 ? sign : 1) * ut[k * 3 + j], 0)));
  const r = rotation(determinant(rotation(1)) < 0 ? -1 : 1);
  const matrix = r.map((row, i) => [...row, cf[i] - row.reduce((sum, value, j) => sum + value * cm[j], 0)]);
  const rmsd = Math.sqrt(mobile.reduce((sum, p, n) => sum + transform(matrix, p).reduce((s, c, k) => s + (c - fixed[n][k]) ** 2, 0), 0) / mobile.length);
  return { matrix, rmsd };
}

export function superposeAtoms(mobileRows: Atom[], fixedRows: Atom[], spec: {
  chains: { mobile: string[]; fixed: string[] }; residues?: { mobile: Range; fixed: Range };
  atoms?: 'CA' | 'backbone'; allowLowCoverage?: boolean;
}, fixedMatrix: number[][]): { matrix: number[][]; stats: SuperpositionStats } {
  const mobile: Point[] = [], fixed: Point[] = [];
  let mobileCount = 0, fixedCount = 0, pairedResidueCount = 0, alignedCount = 0, identical = 0;
  const names = spec.atoms === 'backbone' ? ['N', 'CA', 'C', 'O'] : ['CA'];
  for (let c = 0; c < spec.chains.mobile.length; c++) {
    const m = residues(mobileRows, spec.chains.mobile[c], spec.residues?.mobile);
    const f = residues(fixedRows, spec.chains.fixed[c], spec.residues?.fixed);
    if (!m.length || !f.length) throw Error(`Superposition chains ${spec.chains.mobile[c]} / ${spec.chains.fixed[c]}: selection contains no observed protein residues`);
    mobileCount += m.length; fixedCount += f.length;
    for (const [i, j] of alignProteinSequences(m.map(r => r.letter), f.map(r => r.letter))) {
      alignedCount++;
      if (m[i].letter === f[j].letter && m[i].letter !== 'X') identical++;
      let paired = false;
      for (const name of names) {
        const a = m[i].atoms.get(name), b = f[j].atoms.get(name);
        if (!a || !b) continue;
        mobile.push(a); fixed.push(transform(fixedMatrix, b)); paired = true;
      }
      if (paired) pairedResidueCount++;
    }
  }
  if (mobile.length < 3) throw Error(`Superposition requires at least 3 paired atoms; found ${mobile.length}`);
  const coverage = { mobile: pairedResidueCount / mobileCount, fixed: pairedResidueCount / fixedCount };
  if (Math.min(coverage.mobile, coverage.fixed) < 0.30 && !spec.allowLowCoverage)
    throw Error(`Superposition coverage is under 30% (mobile ${(100 * coverage.mobile).toFixed(1)}%, fixed ${(100 * coverage.fixed).toFixed(1)}%). Narrow the selections or set place.superpose.allowLowCoverage: true.`);
  const fit = kabsch(mobile, fixed);
  return { matrix: fit.matrix, stats: { rmsd: fit.rmsd, pairedAtomCount: mobile.length, pairedResidueCount,
    sequenceIdentity: identical / alignedCount, coverage } };
}
