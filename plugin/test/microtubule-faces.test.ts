import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CIF } from 'molstar/lib/commonjs/mol-io/reader/cif.js';
import { parseMolecularLesson } from '../src/molecular-lesson.js';

const fixture = JSON.parse(await readFile(new URL('./fixtures/microtubule-contact-faces.json', import.meta.url), 'utf8'));
const lesson = async (stage: string) => JSON.parse(await readFile(new URL(`../demos/microtubule-growth/${stage}.json`, import.meta.url), 'utf8'));
const expand = (parts: any[]) => [...new Set(parts.flatMap(p => Array.from({ length: p.residues.to - p.residues.from + 1 }, (_, i) => p.residues.from + i)))].sort((a: any, b: any) => a - b);

describe('measured microtubule contact faces', () => {
  for (const [stage, faces, color] of [
    ['monomer', ['monomer'], '#4a90e2'],
    ['dimer', ['end', 'side-alpha', 'side-beta'], '#f5a623'],
  ] as const) {
    it(`${stage} paints exactly the measured contact residues on a solid neutral surface`, async () => {
      const manifest = await lesson(stage);
      const chapter = manifest.chapters.find((c: any) => c.id === 'highlight');
      const emphasis = chapter.immersive.emphasis;
      for (const face of faces) {
        const expected = fixture.faces[face];
        const parts = emphasis.parts.filter((p: any) => p.id.startsWith(`${face}-contact-`));
        expect(expand(parts), face).toEqual(expected.residues);
        expect(parts.every((p: any) => p.chain === expected.chain && p.color === color)).toBe(true);
      }
      expect(emphasis.parts.every((p: any) => faces.some(face => p.id.startsWith(`${face}-contact-`)))).toBe(true);
      expect(emphasis.contextOpacity).toBe(1);
      expect(emphasis.framing).toBe('context');
      expect(chapter.immersive.appearance).toMatchObject({ representation: 'molecular-surface', uniformColor: '#9aa5b0', opacity: 1 });
      expect(chapter.immersive.motion).toBe('hold');
      expect(chapter.immersive.placement.rotation).toEqual(stage === 'monomer' ? [0, 205, 0] : [0, -20, 0]);
      expect(() => parseMolecularLesson(manifest)).not.toThrow();
    });
  }

  it('accepts 23 disjoint contact ranges without filling sequence gaps', async () => {
    const manifest = await lesson('dimer');
    manifest.chapters[2].immersive.emphasis.parts = ['end', 'side-alpha', 'side-beta'].flatMap(face => fixture.faces[face].ranges.map(([from, to]: number[], i: number) => ({
      id: `${face}-${i}`, label: face, chain: fixture.faces[face].chain, residues: { from, to }, color: '#f5a623',
    })));
    expect(manifest.chapters[2].immersive.emphasis.parts).toHaveLength(23);
    expect(() => parseMolecularLesson(manifest)).not.toThrow();
  });

  it('keeps the expanded contact key bounded by the 32-part scene contract', async () => {
    const manifest = await lesson('monomer');
    const part = manifest.chapters[2].immersive.emphasis.parts[0];
    manifest.chapters[2].immersive.emphasis.parts = Array.from({ length: 32 }, (_, i) => ({ ...part, id: `contact-${i}` }));
    expect(() => parseMolecularLesson(manifest)).not.toThrow();
    manifest.chapters[2].immersive.emphasis.parts.push({ ...part, id: 'contact-32' });
    expect(() => parseMolecularLesson(manifest)).toThrow(/32/);
  });

  // Opt-in source check uses the same public cache as the layout tests. It
  // computes all distances independently of the authored ranges and witnesses.
  it.skipIf(!process.env.STEREOFOLD_DEMO_CACHE)('recomputes every face from the pinned deposited heavy atoms and assembly operators', async () => {
    const text = await readFile(resolve(process.env.STEREOFOLD_DEMO_CACHE!, '5SYF.cif'), 'utf8');
    expect(createHash('sha256').update(text).digest('hex')).toBe(fixture.sourceSha256);
    const parsed = await CIF.parse(text).run();
    if (parsed.isError) throw Error(parsed.message);
    const table = (prefix: string): Record<string, string>[] => {
      const category = parsed.result.blocks[0].categories[prefix.slice(1)];
      return Array.from({ length: category.rowCount }, (_, i) => Object.fromEntries(
        category.fieldNames.map(field => [field, category.getField(field)!.str(i)])));
    };
    const atoms = table('_atom_site').filter(a => a.group_PDB === 'ATOM' && a.pdbx_PDB_model_num === '1' && !['H', 'D'].includes(a.type_symbol));
    const ops = table('_pdbx_struct_oper_list');
    for (const face of Object.values(fixture.faces) as any[]) {
      const op = ops.find(o => o.id === face.operator)!;
      const coords = (a: Record<string, string>) => ['x', 'y', 'z'].map(axis => Number(a[`Cartn_${axis}`]));
      const partners = atoms.filter(a => a.auth_asym_id === face.partnerChain).map(a => {
        const v = coords(a);
        return [1, 2, 3].map(i => Number(op[`vector[${i}]`]) + v.reduce((sum, x, j) => sum + x * Number(op[`matrix[${i}][${j + 1}]`]), 0));
      });
      const residues = new Set<number>();
      for (const a of atoms.filter(a => a.auth_asym_id === face.chain)) {
        const p = coords(a);
        if (partners.some(q => p.reduce((sum, x, i) => sum + (x - q[i]) ** 2, 0) <= fixture.cutoffAngstrom ** 2)) residues.add(Number(a.auth_seq_id));
      }
      expect([...residues].sort((a, b) => a - b)).toEqual(face.residues);
    }
  });
});
