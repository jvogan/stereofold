import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CIF } from 'molstar/lib/mol-io/reader/cif.js';
import { trajectoryFromMmCIF } from 'molstar/lib/mol-model-formats/structure/mmcif.js';
import { Structure, StructureElement } from 'molstar/lib/mol-model/structure.js';
import { figureTargetSchema, lessonFigureSchema } from '../src/lesson-figure.js';
import { validateLessonSource } from '../src/lesson-source-validation.js';
import { animationTargetOwners } from '../src/molecular-animation.js';
// @ts-ignore Shared production renderer selectors.
import { resolveFigureLoci, figureTargetMatchesRow } from '../../lab/browser-roundtrip/lesson-figure.mjs';
// @ts-ignore Shared production global-style target deduplication.
import { figureRepresentationLayers } from '../../lab/browser-roundtrip/lesson-figure-appearance.mjs';

describe('noncontiguous figure residue selections', () => {
  it('bounds the explicit author numbers and preserves them for all figure targets', () => {
    const target = { chain: 'A', residueNumbers: [2, 7, 11] };
    expect(figureTargetSchema.parse(target)).toEqual(target);
    expect(figureTargetSchema.safeParse({ chain: 'A', residueNumbers: Array.from({ length: 256 }, (_, i) => i) }).success).toBe(true);
    for (const residueNumbers of [[], [2, 2], [1.5], [NaN], [Infinity], [-10000], [100000], ['2'], Array.from({ length: 257 }, (_, i) => i)])
      expect(figureTargetSchema.safeParse({ chain: 'A', residueNumbers }).success).toBe(false);
    const figure = lessonFigureSchema.parse({ layers: [{ id: 'contacts', target, representation: 'ball-and-stick', color: '#2288cc' }],
      labels: [{ id: 'label', target, text: 'Contact residues', color: '#333333' }], focus: [target] });
    expect(figure.layers[0].target.residueNumbers).toEqual(target.residueNumbers);
    expect(figure.labels[0].target.residueNumbers).toEqual(target.residueNumbers);
    expect(figure.focus?.[0].residueNumbers).toEqual(target.residueNumbers);
  });

  it('selects only listed atoms and intersects range, component and atom filters in the real Mol* model', async () => {
    const parsed = await CIF.parse(readFileSync(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8')).run();
    if (parsed.isError) throw Error(parsed.message);
    const trajectory = await trajectoryFromMmCIF(parsed.result.blocks[0]).run();
    const data = Structure.ofModel(trajectory.representative);
    const target = { chain: 'A', residueNumbers: [2, 7, 11] };
    const selected = resolveFigureLoci(target, data);
    const single = (n: number) => resolveFigureLoci({ chain: 'A', residues: { from: n, to: n } }, data);
    const expected = StructureElement.Loci.union(StructureElement.Loci.union(single(2), single(7)), single(11));
    expect(StructureElement.Loci.areEqual(selected, expected)).toBe(true);
    expect(StructureElement.Loci.size(resolveFigureLoci({ ...target, atomName: 'CA' }, data))).toBe(3);
    expect(StructureElement.Loci.size(resolveFigureLoci({ ...target, atomName: 'CA', residues: { from: 3, to: 8 } }, data))).toBe(1);
    expect(StructureElement.Loci.size(resolveFigureLoci({ ...target, componentId: 'XXX' }, data))).toBe(0);
    expect(StructureElement.Loci.size(resolveFigureLoci({ chain: 'A', residueNumbers: [999] }, data))).toBe(0);
    for (const n of [2, 3, 7, 8, 11]) {
      const row = { identity: { authorChain: 'A', authorResidue: n, componentId: 'THR' } };
      expect(figureTargetMatchesRow(target, row)).toBe(target.residueNumbers.includes(n));
    }
  });

  it('validates the same explicit residues against the current source catalog', () => {
    const row = (n: number) => ({ identity: { authorChain: 'A', authorResidue: n, modelNumber: 1, componentId: 'THR' },
      atomSites: [{ identity: { atomName: 'CA' }, assemblyCoordinatesAngstrom: [n, 0, 0] }] });
    const catalog = { source: { sha256: 'a'.repeat(64) }, rows: [row(2), row(7), row(11)] };
    const lesson = (residueNumbers: number[]) => ({ provenance: {}, chapters: [{ immersive: { figure: lessonFigureSchema.parse({
      layers: [{ id: 'contacts', target: { chain: 'A', residueNumbers }, representation: 'ball-and-stick', color: '#2288cc' }],
    }) } }] }) as any;
    expect(() => validateLessonSource(lesson([2, 11]), catalog, 1)).not.toThrow();
    expect(() => validateLessonSource(lesson([3, 8]), catalog, 1)).toThrow('target has no atoms');
    expect(() => validateLessonSource(lesson([2, 11]), catalog, 2)).toThrow('target has no atoms');
  });

  it('deduplicates identical sets in a global style without merging different residue selections', () => {
    const layers = [[2, 7], [7, 2], [2, 11]].map((residueNumbers, i) => ({ id: `layer-${i}`,
      target: { chain: 'A', residueNumbers }, representation: i === 1 ? 'gaussian-surface' : 'ball-and-stick',
      color: '#2288cc', opacity: i === 1 ? .14 : 1 }));
    expect(figureRepresentationLayers({ representationOverride: 'spacefill', layers }).map((layer: any) => layer.id))
      .toEqual(['layer-0', 'layer-2']);
  });

  it('requires exact distance atoms and resolves their static animation ownership', () => {
    const figure = { layers: [{ id: 'contacts', target: { chain: 'A', residueNumbers: [2, 7] }, representation: 'ball-and-stick', color: '#2288cc' }],
      distances: [{ id: 'distance', a: { chain: 'A', residueNumbers: [2], atomName: 'CA' },
        b: { chain: 'A', residueNumbers: [7], atomName: 'CA' }, color: '#333333' }] };
    expect(lessonFigureSchema.safeParse(figure).success).toBe(true);
    expect(lessonFigureSchema.safeParse({ ...figure, distances: [{ ...figure.distances[0], a: { chain: 'A', residueNumbers: [2, 7], atomName: 'CA' } }] }).success).toBe(false);
    const tracks = [{ id: 'body', chains: ['A'], selector: { residues: [{ from: 1, to: 3 }, { from: 6, to: 8 }] } }] as any;
    expect([...animationTargetOwners(tracks, { chain: 'A', residueNumbers: [2, 7] })]).toEqual(['body']);
    expect([...animationTargetOwners(tracks, { chain: 'A', residueNumbers: [11] })]).toEqual([undefined]);
    expect([...animationTargetOwners(tracks, { chain: 'A', residueNumbers: [2, 11] })]).toEqual(['body', undefined]);
  });
});
