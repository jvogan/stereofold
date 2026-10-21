import { describe, expect, it } from 'vitest';
import { createGenericMolecularLesson } from '../src/molecular-lesson.js';
import { molecularLessonToTour } from '../src/molecular-lesson-tour.js';
import { emphasisPartSchema } from '../src/inspection-contract.js';

describe('portable lesson immersive adapter', () => {
  it('discloses modelled local references and notes without manufacturing links', () => {
    const lesson = createGenericMolecularLesson({ sourceRef: 'own.cif' });
    lesson.provenance.sourceRefs = [
      { kind: 'modelled', ref: 'linkers.cif', note: 'Idealised linkers' },
      { kind: 'public', ref: 'https://www.rcsb.org/structure/5SYF' },
    ];
    expect(molecularLessonToTour(lesson).steps[0].sources).toEqual([
      { title: 'Local modelled source: linkers.cif — Idealised linkers' },
      { title: 'Structure source', url: 'https://www.rcsb.org/structure/5SYF' },
    ]);
  });

  it('carries bounded visibility operations without adding placement or camera moves', () => {
    const lesson: any = createGenericMolecularLesson({ sourceRef: 'own.cif' });
    lesson.chapters[0].immersive = { visibility: { op: 'only', chains: ['A-2'], classes: ['polymer'] } };
    const step = molecularLessonToTour(lesson).steps[0];
    expect(step.visibility).toEqual({ op: 'only', chains: ['A-2'], classes: ['polymer'] });
    expect(step.placement).toBeUndefined();
    expect(step.view).toBeUndefined();
  });

  it('rejects malformed, unbounded, or empty authored visibility requests', () => {
    const lesson: any = createGenericMolecularLesson({ sourceRef: 'own.cif' });
    for (const visibility of [
      { op: 'only' }, { op: 'reset', chains: ['A'] }, { op: 'hide', classes: ['protein'] },
      { op: 'only', chains: [{ labelChain: 'A', copyId: '1', extra: true }] },
      { op: 'only', chains: Array(129).fill('A') }, { op: 'only', chains: ['A'], selection: true },
    ]) {
      lesson.chapters[0].immersive = { visibility };
      expect(() => molecularLessonToTour(lesson)).toThrow();
    }
    lesson.chapters[0].immersive = { visibility: { op: 'show', chains: [{ labelChain: 'A', copyId: '1' }] } };
    expect(molecularLessonToTour(lesson).steps[0].visibility?.chains).toEqual([{ labelChain: 'A', copyId: '1' }]);
  });

  it('accepts desktop holds with explicit immersive scene controls, and rejects empty hold intentions', () => {
    const lesson: any = createGenericMolecularLesson({ sourceRef: 'own.cif' });
    lesson.chapters[0].changes = [{ kind: 'hold', durationSeconds: lesson.chapters[0].durationSeconds }];
    for (const immersive of [
      { visibility: { op: 'only', chains: ['A-2'], classes: ['polymer'] } },
      { appearance: { representation: 'cartoon' } },
    ]) {
      lesson.chapters[0].immersive = immersive;
      expect(molecularLessonToTour(lesson).steps[0]).toMatchObject(immersive);
    }
    for (const immersive of [{ narration: 'Look at this.' }, { motion: 'hold', narration: 'Look at this.' }]) {
      lesson.chapters[0].immersive = immersive;
      expect(() => molecularLessonToTour(lesson)).toThrow('deliberate scene change');
    }
  });
  it('preserves chapter order, captions, dwell times and explicit immersive intentions', () => {
    const lesson = createGenericMolecularLesson({ sourceRef: '/private/user-molecule.cif' });
    const tour = molecularLessonToTour(lesson);
    expect(tour.id).toBe(`lesson-${lesson.id}`);
    expect(tour.steps).toHaveLength(lesson.chapters.length);
    for (let i = 0; i < tour.steps.length; i++) {
      expect(tour.steps[i]).toMatchObject({
        id: lesson.chapters[i].id, body: lesson.chapters[i].caption,
        durationMs: lesson.chapters[i].durationSeconds * 1000,
        ...lesson.chapters[i].immersive,
      });
      expect(tour.steps[i].sources).toEqual([{ title: 'Local source: /private/user-molecule.cif' }]);
      expect(tour.steps[i]).not.toHaveProperty('camera');
    }
  });
  it('refuses to silently drop a desktop-only chapter on headset handoff', () => {
    const lesson = createGenericMolecularLesson({ sourceRef: 'own.cif' });
    delete lesson.chapters[0].immersive;
    expect(() => molecularLessonToTour(lesson)).toThrow('no immersive intent');
  });
  it('rejects unsupported immersive camera motion and extreme scale before loading', () => {
    const lesson: any = createGenericMolecularLesson({ sourceRef: 'own.cif' });
    lesson.chapters[0].immersive = { camera: { orbit: 360 } };
    expect(() => molecularLessonToTour(lesson)).toThrow();
    lesson.chapters[0].immersive = { placement: { scale: 1000001 } };
    expect(() => molecularLessonToTour(lesson)).toThrow();
  });
});

describe('lesson emphasis', () => {
  const withEmphasis = (emphasis: unknown) => {
    const lesson: any = createGenericMolecularLesson({ sourceRef: 'own.cif' });
    lesson.chapters[0].immersive = { ...lesson.chapters[0].immersive, emphasis };
    return lesson;
  };
  const key = [
    { id: 'protein', label: 'Protein', color: '#9aa5b0', chain: 'A' },
    { id: 'site', label: 'Active site', color: '#ff3b30', chain: 'A', residues: { from: 10, to: 12 } },
  ];

  it('carries the colour key and the focused part through to the headset step', () => {
    const tour = molecularLessonToTour(withEmphasis({ parts: key, focus: 'site', framing: 'context' }));
    expect(tour.steps[0].emphasis).toMatchObject({
      focus: 'site', framing: 'context',
      // The default keeps context visible rather than hidden; an emphasis that
      // deleted the surroundings would leave the part nowhere.
      contextOpacity: 0.12,
    });
    expect(tour.steps[0].emphasis?.parts).toHaveLength(2);
  });

  it('accepts several parts as one focus, because RuvC is three stretches of one chain', () => {
    const tour = molecularLessonToTour(withEmphasis({ parts: key, focus: ['protein', 'site'] }));
    expect(tour.steps[0].emphasis?.focus).toEqual(['protein', 'site']);
  });

  it('refuses a focus, a duplicate id or a framing the colour key cannot honour', () => {
    expect(() => molecularLessonToTour(withEmphasis({ parts: key, focus: 'ligand' })))
      .toThrow('not one of the colour-key parts');
    expect(() => molecularLessonToTour(withEmphasis({ parts: [key[0], { ...key[1], id: 'protein' }] })))
      .toThrow('unique');
    // Framing with no focus is legal and means "frame the whole complex".
    // It is how the opening chapter gets a size and a place of
    // its own instead of inheriting wherever the wearer's entry seat left the
    // molecule, and it reaches the viewer as a framing with no lit rows.
    const whole = molecularLessonToTour(withEmphasis({ parts: key, framing: 'fill' }));
    expect(whole.steps[0]?.emphasis).toMatchObject({ framing: 'fill' });
    expect(whole.steps[0]?.emphasis?.focus).toBeUndefined();
  });

  it('carries the parts a chapter lights beside its focus, and only parts of its own key', () => {
    const tour = molecularLessonToTour(withEmphasis({ parts: key, focus: 'site', alsoLit: ['protein'], framing: 'fill' }));
    expect(tour.steps[0].emphasis).toMatchObject({ focus: 'site', alsoLit: ['protein'] });
    expect(() => molecularLessonToTour(withEmphasis({ parts: key, focus: 'site', alsoLit: ['ligand'] })))
      .toThrow('not one of the colour-key parts');
    // Lit beside the focus, not a second focus.
    expect(() => molecularLessonToTour(withEmphasis({ parts: key, focus: 'site', alsoLit: ['site'] })))
      .toThrow('already its focus');
    // With no focus the whole key is lit, so there is nothing to light beside it.
    expect(() => molecularLessonToTour(withEmphasis({ parts: key, alsoLit: ['protein'] })))
      .toThrow('needs a focus');
  });

  it('refuses a part that names nothing, a backwards range or an unknown field', () => {
    expect(() => molecularLessonToTour(withEmphasis({ parts: [{ id: 'x', label: 'X', color: '#ffffff' }] })))
      .toThrow('must name a chain, a residue range, or both');
    expect(() => molecularLessonToTour(withEmphasis({
      parts: [{ id: 'x', label: 'X', color: '#ffffff', chain: 'A', residues: { from: 40, to: 10 } }],
    }))).toThrow('must not run backwards');
    expect(() => molecularLessonToTour(withEmphasis({ parts: key, isolate: true }))).toThrow();
  });

  it('sends only scene fields on a part: an author note and spoken aliases stay in the manifest', () => {
    // The saved-scene contract is strict, and a lesson part
    // that reached it with `aliases` had every sync refused from the first lit
    // chapter on, the refusal drawn as a plate in the wearer's view.
    const tour = molecularLessonToTour(withEmphasis({
      parts: [
        { ...key[0], note: 'Chain A, the whole protein.', aliases: ['the protein', 'chain A'] },
        { ...key[1], note: 'Three residues.' },
      ],
      focus: 'site', framing: 'fill',
    }));
    const parts = tour.steps[0].emphasis?.parts ?? [];
    expect(parts).toEqual([
      { id: 'protein', label: 'Protein', color: '#9aa5b0', chain: 'A' },
      { id: 'site', label: 'Active site', color: '#ff3b30', chain: 'A', residues: { from: 10, to: 12 } },
    ]);
    for (const part of parts) expect(emphasisPartSchema.safeParse(part).success).toBe(true);
    expect(tour.steps[0].emphasis).toEqual({ parts, focus: 'site', framing: 'fill', contextOpacity: 0.12 });
  });

  it('leaves a lesson that emphasises nothing exactly as it was', () => {
    const tour = molecularLessonToTour(createGenericMolecularLesson({ sourceRef: 'own.cif' }));
    expect(tour.steps.every(step => step.emphasis === undefined)).toBe(true);
  });
});
