import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Every bond of the modelled kinesin residues (linkers and stalk), against
// Engh-Huber ideal lengths. CA spacing alone hides a broken peptide.
const IDEAL = {'N-CA':1.458, 'CA-C':1.525, 'C=O':1.231, 'C-N':1.329};
function residues(file) {
  const lines = readFileSync(new URL(`../../plugin/demos/kinesin-walk/${file}`,import.meta.url),'utf8').split('\n');
  const headers = lines.filter(l => l.startsWith('_atom_site.')).map(l => l.trim().slice(11)), col = n => headers.indexOf(n);
  const out = new Map();
  for (const line of lines.filter(l => /^ATOM\s/.test(l))) {
    const r = line.trim().split(/\s+/), key = `${r[col('auth_asym_id')]}:${r[col('auth_seq_id')]}`;
    if (!out.has(key)) out.set(key, {});
    out.get(key)[r[col('auth_atom_id')]] = ['x','y','z'].map(a => +r[col('Cartn_' + a)]);
  }
  return out;
}
const distance = (a, b) => Math.hypot(a[0]-b[0], a[1]-b[1], a[2]-b[2]);

for (const file of ['cycle-model.cif', 'motion-model.cif']) test(`${file} keeps ideal backbone bonds`, () => {
  const res = residues(file), bad = [];
  let count = 0;
  for (const [key, a] of res) {
    const [chain, seq] = key.split(':'), next = res.get(`${chain}:${+seq + 1}`);
    const bonds = [['N-CA',a.N,a.CA], ['CA-C',a.CA,a.C], ['C=O',a.C,a.O], ['C-N',a.C,next?.N]];
    for (const [name, p, q] of bonds) if (p && q) {
      count++;
      const d = distance(p, q);
      if (Math.abs(d - IDEAL[name]) > .05) bad.push(`${key} ${name} ${d.toFixed(3)}`);
    }
    if (next?.CA) assert.ok(Math.abs(distance(a.CA, next.CA) - 3.8) < .1, `${key} CA-CA`);
  }
  assert.ok(count > 300);
  assert.deepEqual(bad, []);
});
