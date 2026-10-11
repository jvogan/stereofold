import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  compileMolecularLesson,
  createGenericMolecularLesson,
  MOLECULAR_LESSON_LIMITS,
  parseMolecularLesson,
  type MolecularLessonManifest,
} from '../src/molecular-lesson.js';

function lesson(overrides: Partial<MolecularLessonManifest> = {}): MolecularLessonManifest {
  return {
    version: 1,
    id: 'own-molecule-tour',
    title: 'A short molecular lesson',
    mode: 'guided',
    provenance: { sourceRefs: [{ kind: 'local', ref: 'opened-source.cif' }] },
    chapters: [
      {
        id: 'orient',
        title: 'Orient the molecule',
        caption: 'Start with the complete molecule in view.',
        durationSeconds: 1.5,
        changes: [
          { kind: 'rotate', axis: 'vertical', degrees: 18, durationSeconds: 1.5, easing: 'ease_in_out' },
        ],
      },
      {
        id: 'focus',
        title: 'Pause on the selected view',
        caption: 'The next scene is ready for exploration.',
        durationSeconds: 1.5,
        changes: [
          { kind: 'zoom', magnification: 1.05, durationSeconds: 1.5, easing: 'ease_in_out' },
        ],
      },
    ],
    ...overrides,
  };
}

describe('molecular lesson compiler', () => {
  it('compiles exact ordered movie steps and guided caption patches', () => {
    const compiled = compileMolecularLesson(lesson({
      chapters: [
        {
          id: 'orient',
          title: 'Orient the molecule',
          caption: 'Start with the complete molecule in view.',
          durationSeconds: 1.5,
          changes: [
            {
              kind: 'scene',
              transition: 'smooth',
              durationSeconds: 1.5,
              easing: 'ease_in_out',
              scene: { background: '#071015', lighting: 'studio' },
            },
          ],
        },
        {
          id: 'surface',
          title: 'Reveal the surface',
          caption: 'The surface is an exploration aid.',
          durationSeconds: 1.5,
          changes: [
            {
              kind: 'scene',
              transition: 'smooth',
              durationSeconds: 1.5,
              easing: 'ease_in_out',
              scene: { background: '#071015', lighting: 'studio' },
            },
          ],
        },
      ],
    }));

    expect(compiled.timeline.map((step) => step.kind)).toEqual(['scene', 'scene']);
    expect(compiled.timeline.every((step) => step.kind !== 'scene' || (step.scene.annotations?.some((annotation) => typeof (annotation as { text?: string }).text === 'string') ?? false))).toBe(true);
    expect(compiled.totalDurationSeconds).toBe(3);
    expect(compiled.chapters).toEqual([
      { id: 'orient', title: 'Orient the molecule', caption: 'Start with the complete molecule in view.', startSeconds: 0, endSeconds: 1.5 },
      { id: 'surface', title: 'Reveal the surface', caption: 'The surface is an exploration aid.', startSeconds: 1.5, endSeconds: 3 },
    ]);
    expect(compiled.guidedApplyScenePlans[0]).toMatchObject({
      chapterId: 'orient',
      applyScene: { replaceAnnotations: false },
    });
    expect(compiled.guidedApplyScenePlans[0]?.applyScene.annotations[0]).toMatchObject({
      kind: 'screen',
      id: 'lesson-caption',
      text: 'Start with the complete molecule in view.',
      visible: true,
    });
  });

  it('keeps explore mode portable without emitting live apply_scene actions', () => {
    const compiled = compileMolecularLesson(lesson({ mode: 'explore' }));
    expect(compiled.guidedApplyScenePlans).toEqual([]);
    expect(compiled.timeline).toHaveLength(4);
  });

  it('preserves exact public render targets without guessing SelectionExpr fields', () => {
    const target = { kind: 'expression', expression: { version: 1, allOf: [{ kind: 'object', objectId: 'primary' }] } };
    const compiled = compileMolecularLesson(lesson({
      chapters: [{
        id: 'focus',
        title: 'Focus',
        caption: 'Focus the caller-selected region.',
        durationSeconds: 1,
        changes: [{ kind: 'focus', target, durationSeconds: 1, easing: 'ease_in_out' }],
      }],
    }));
    expect(compiled.timeline[1]).toMatchObject({ kind: 'focus', target });
  });

  it('rejects an expression target without its exact expression object', () => {
    expect(() => parseMolecularLesson(lesson({
      chapters: [{
        id: 'focus',
        title: 'Focus',
        caption: 'A caption.',
        durationSeconds: 1,
        changes: [{ kind: 'focus', target: { kind: 'expression' }, durationSeconds: 1, easing: 'ease_in_out' }],
      }],
    }))).toThrow(/SelectionExpr/);
  });

  it('rejects captions, duplicate chapter IDs, and hold-only chapters', () => {
    expect(() => parseMolecularLesson(lesson({
      chapters: [{
        id: 'focus',
        title: 'Focus',
        caption: 'x'.repeat(2_001),
        durationSeconds: 1,
        changes: [{ kind: 'rotate', axis: 'vertical', degrees: 10, durationSeconds: 1, easing: 'ease_in_out' }],
      }],
    }))).toThrow(/caption/);

    expect(() => compileMolecularLesson(lesson({
      chapters: [lesson().chapters[0]!, { ...lesson().chapters[0]!, title: 'Duplicate' }],
    }))).toThrow(/duplicate chapter id/);

    expect(() => compileMolecularLesson(lesson({
      chapters: [{
        id: 'hold',
        title: 'Hold',
        caption: 'A hold alone is not a deliberate scene change.',
        durationSeconds: 1,
        changes: [{ kind: 'hold', durationSeconds: 1 }],
      }],
    }))).toThrow(/deliberate scene change/);
  });

  it('rejects chapter duration drift and a movie beyond the viewer limit', () => {
    expect(() => compileMolecularLesson(lesson({
      chapters: [{
        id: 'drift',
        title: 'Drift',
        caption: 'Duration mismatch.',
        durationSeconds: 1.2,
        changes: [{ kind: 'rotate', axis: 'vertical', degrees: 10, durationSeconds: 1, easing: 'ease_in_out' }],
      }],
    }))).toThrow(/sum of change durations/);

    const longChapters = Array.from({ length: 12 }, (_, index) => ({
      id: `chapter-${index}`,
      title: `Chapter ${index}`,
      caption: 'A bounded chapter.',
      durationSeconds: 2,
      changes: [{ kind: 'rotate' as const, axis: 'vertical' as const, degrees: 5, durationSeconds: 2, easing: 'ease_in_out' as const }],
    }));
    expect(() => compileMolecularLesson(lesson({ mode: 'explore', chapters: longChapters }), { target: 'movie' })).toThrow(/render_movie/);
    expect(compileMolecularLesson(lesson({ mode: 'explore', chapters: longChapters })).renderMoviePlan).toBeUndefined();
  });

  it('accepts a lesson at each raised count limit and refuses one past it', () => {
    const rotate = (durationSeconds: number) => ({ kind: 'rotate' as const, axis: 'vertical' as const, degrees: 5, durationSeconds, easing: 'ease_in_out' as const });
    const chapter = (id: string, changes: ReturnType<typeof rotate>[]) => ({
      id, title: id, caption: 'A bounded chapter.',
      durationSeconds: changes.reduce((sum, change) => sum + change.durationSeconds, 0),
      changes,
    });
    const { maxChapters, maxTotalSteps, maxLessonDurationSeconds } = MOLECULAR_LESSON_LIMITS;

    const chapters = Array.from({ length: maxChapters }, (_, index) => chapter(`c-${index}`, [rotate(1)]));
    expect(compileMolecularLesson(lesson({ mode: 'explore', chapters })).chapters).toHaveLength(maxChapters);
    expect(() => compileMolecularLesson(lesson({ mode: 'explore', chapters: [...chapters, chapter('extra', [rotate(1)])] }))).toThrow();

    // Eight chapters of sixteen changes fill the step limit exactly. A hidden
    // caption card adds no movie caption step, so each change is one step.
    const hiddenCaptions = { presentation: { captionCard: 'hidden' as const } };
    const steps = Array.from({ length: maxTotalSteps / MOLECULAR_LESSON_LIMITS.maxChapterSteps }, (_, index) =>
      chapter(`s-${index}`, Array.from({ length: MOLECULAR_LESSON_LIMITS.maxChapterSteps }, () => rotate(0.2))));
    expect(compileMolecularLesson(lesson({ mode: 'explore', ...hiddenCaptions, chapters: steps })).timeline).toHaveLength(maxTotalSteps);
    expect(() => compileMolecularLesson(lesson({ mode: 'explore', ...hiddenCaptions, chapters: [...steps, chapter('one-more', [rotate(0.2)])] })))
      .toThrow(/timeline exceeds 128 steps/);

    // Sixteen source refs are the most a lesson can cite; seventeen is refused.
    const sourceRefs = (count: number) => Array.from({ length: count }, (_, index) => ({ kind: 'local' as const, ref: `source-${index}.cif` }));
    expect(compileMolecularLesson(lesson({ mode: 'explore', provenance: { sourceRefs: sourceRefs(MOLECULAR_LESSON_LIMITS.maxSourceRefs) } })).manifest.provenance.sourceRefs).toHaveLength(16);
    expect(() => compileMolecularLesson(lesson({ mode: 'explore', provenance: { sourceRefs: sourceRefs(MOLECULAR_LESSON_LIMITS.maxSourceRefs + 1) } })))
      .toThrow(/Invalid molecular lesson/);

    // Ten chapters of three 20 s changes fill the lesson duration exactly.
    const full = Array.from({ length: 10 }, (_, index) => chapter(`d-${index}`, [rotate(20), rotate(20), rotate(20)]));
    expect(compileMolecularLesson(lesson({ mode: 'explore', chapters: full })).totalDurationSeconds).toBe(maxLessonDurationSeconds);
    expect(() => compileMolecularLesson(lesson({ mode: 'explore', chapters: [...full, chapter('over', [rotate(1)])] })))
      .toThrow(/total duration must be between/);
  });

  it('rejects cinematic-only guided changes instead of silently dropping them', () => {
    expect(() => compileMolecularLesson(lesson({
      chapters: [{
        id: 'cinematic',
        title: 'Cinematic',
        caption: 'Guided scenes must be apply_scene-compatible.',
        durationSeconds: 1,
        changes: [{ kind: 'rotate', axis: 'vertical', degrees: 10, durationSeconds: 1, easing: 'ease_in_out' }],
      }],
    }))).toThrow(/cinematic-only/);
  });

  it('rejects unsupported timeline operations before any viewer call', () => {
    expect(() => parseMolecularLesson(lesson({
      chapters: [{
        id: 'bad',
        title: 'Bad operation',
        caption: 'This must fail closed.',
        durationSeconds: 1,
        changes: [{ kind: 'teleport', durationSeconds: 1 } as never],
      }],
    }))).toThrow(/Invalid molecular lesson/);
  });

  it('loads the generic and public starter manifests through the same validator', () => {
    const generic = createGenericMolecularLesson({ sourceRef: 'opened-source.cif' });
    expect(generic.chapters.every((chapter) => chapter.immersive != null)).toBe(true);
    const genericCompiled = compileMolecularLesson(generic);
    expect(genericCompiled.guidedApplyScenePlans.length).toBeGreaterThan(0);
    expect(genericCompiled.guidedApplyScenePlans[0]?.applyScene.layers?.[0]).toMatchObject({ representation: 'ball_and_stick' });

    for (const name of ['own-molecule-guided.json', '9qb3-guided.json', '9kj6-guided.json']) {
      const input = JSON.parse(readFileSync(resolve(import.meta.dirname, '../examples/lessons', name), 'utf8')) as unknown;
      const compiled = compileMolecularLesson(input);
      expect(compiled.manifest.chapters.every((chapter) => chapter.immersive != null)).toBe(true);
      expect(compiled.renderMoviePlan).toBeDefined();
    }
  });

  it('accepts per-chapter component labels on the immersive appearance', () => {
    const base = lesson().chapters[0]!;
    const parsed = parseMolecularLesson(lesson({
      chapters: [{
        ...base,
        immersive: {
          appearance: { representation: 'cartoon', color: 'element-symbol', componentLabels: true },
          view: 'fit',
        },
      }],
    }));
    expect(parsed.chapters[0]?.immersive?.appearance?.componentLabels).toBe(true);
    // Absent stays absent: existing lessons draw exactly what they drew before.
    const plain = parseMolecularLesson(lesson({
      chapters: [{ ...base, immersive: { appearance: { representation: 'cartoon' }, view: 'fit' } }],
    }));
    expect(plain.chapters[0]?.immersive?.appearance?.componentLabels).toBeUndefined();
    expect(() => parseMolecularLesson(lesson({
      chapters: [{
        ...base,
        immersive: {
          appearance: { representation: 'cartoon', componentLabels: 'yes' as unknown as boolean },
          view: 'fit',
        },
      }],
    }))).toThrow(/Invalid molecular lesson/);
  });

  it('rejects guided fields and transforms that apply_scene cannot represent', () => {
    expect(() => compileMolecularLesson(lesson({
      chapters: [{
        id: 'unsupported',
        title: 'Unsupported',
        caption: 'The guided compiler must fail closed.',
        durationSeconds: 1,
        changes: [{ kind: 'scene', durationSeconds: 1, easing: 'ease_in_out', transition: 'smooth', scene: { antialiasing: 'quality' } }],
      }],
    }))).toThrow(/unsupported apply_scene fields/);
    expect(() => compileMolecularLesson(lesson({
      chapters: [{
        id: 'relative',
        title: 'Relative transform',
        caption: 'A live baseline is required for relative transforms.',
        durationSeconds: 1,
        changes: [{ kind: 'transform', objectId: 'primary', mode: 'relative', durationSeconds: 1, easing: 'ease_in_out', transform: { kind: 'components', translation: [1, 0, 0] } }],
      }],
    }))).toThrow(/component transforms are movie-only/);
  });
});

describe('lesson presentation', () => {
  const sceneChapters = (caption: string) => [{
    id: 'orient',
    title: 'Orient the molecule',
    caption,
    durationSeconds: 1.5,
    changes: [{
      kind: 'scene' as const,
      transition: 'smooth' as const,
      durationSeconds: 1.5,
      easing: 'ease_in_out' as const,
      scene: { background: '#071015', lighting: 'studio' },
    }],
  }];
  const captionAnnotationIds = (compiled: ReturnType<typeof compileMolecularLesson>): string[] =>
    compiled.timeline.flatMap((step) => step.kind === 'scene'
      ? (step.scene.annotations ?? []).map((annotation) => String((annotation as { id?: unknown }).id))
      : []);

  it('leaves a lesson without presentation exactly as it compiled before', () => {
    const manifest = parseMolecularLesson(lesson());
    // Absent stays absent: the schema does not invent the field.
    expect(manifest.presentation).toBeUndefined();
    // Movie timeline: the carved caption steps are still there.
    expect(captionAnnotationIds(compileMolecularLesson({ ...lesson(), mode: 'explore' }))).toContain('lesson-caption');
    expect(compileMolecularLesson({ ...lesson(), mode: 'explore' }).timeline.map((step) => step.kind))
      .toEqual(['scene', 'rotate', 'scene', 'zoom']);
    // Guided: every plan still carries the lesson-caption annotation.
    const guided = compileMolecularLesson({ ...lesson(), chapters: sceneChapters('Start with the complete molecule in view.') });
    expect(guided.guidedApplyScenePlans.length).toBeGreaterThan(0);
    expect(guided.guidedApplyScenePlans.every((plan) =>
      plan.applyScene.annotations.some((annotation) => (annotation as { id?: unknown }).id === 'lesson-caption'))).toBe(true);
  });

  it('accepts presentation.captionCard hidden and omits every caption annotation', () => {
    const manifest = parseMolecularLesson({ ...lesson(), presentation: { captionCard: 'hidden' } });
    expect(manifest.presentation).toEqual({ captionCard: 'hidden' });
    const compiled = compileMolecularLesson({ ...lesson(), mode: 'explore', presentation: { captionCard: 'hidden' } });
    // No `lesson-caption` annotation anywhere in the movie timeline, and the
    // authored steps survive un-carved: no caption scene step, no 0.1s trim.
    expect(captionAnnotationIds(compiled)).not.toContain('lesson-caption');
    expect(compiled.timeline.map((step) => step.kind)).toEqual(['rotate', 'zoom']);
    expect(compiled.timeline.map((step) => step.durationSeconds)).toEqual([1.5, 1.5]);
    expect(compiled.totalDurationSeconds).toBe(3);
    // Guided plans keep their scene work but gain none of ours.
    const guided = compileMolecularLesson({
      ...lesson(),
      chapters: sceneChapters('Start with the complete molecule in view.'),
      presentation: { captionCard: 'hidden' },
    });
    expect(guided.guidedApplyScenePlans.length).toBeGreaterThan(0);
    for (const plan of guided.guidedApplyScenePlans) {
      expect(plan.applyScene.annotations.some((annotation) => (annotation as { id?: unknown }).id === 'lesson-caption')).toBe(false);
      expect(plan.applyScene.replaceAnnotations).toBe(false);
    }
  });

  it('defaults captionCard to shown when presentation is set without the field', () => {
    const manifest = parseMolecularLesson({ ...lesson(), presentation: {} });
    expect(manifest.presentation).toEqual({ captionCard: 'shown' });
    expect(captionAnnotationIds(compileMolecularLesson({ ...lesson(), mode: 'explore', presentation: {} })))
      .toContain('lesson-caption');
  });

  it('rejects a presentation value outside the shown/hidden vocabulary', () => {
    expect(() => parseMolecularLesson({ ...lesson(), presentation: { captionCard: 'always' } }))
      .toThrow(/Invalid molecular lesson/);
    expect(() => parseMolecularLesson({ ...lesson(), presentation: { captionCard: 'HIDDEN' } }))
      .toThrow(/Invalid molecular lesson/);
    expect(() => parseMolecularLesson({ ...lesson(), presentation: { captionCard: 'hidden', extra: true } }))
      .toThrow(/Invalid molecular lesson/);
  });
});

it('accepts bounded authored part aliases and rejects malformed aliases', () => {
  const manifest = lesson();
  manifest.chapters[0].immersive = { emphasis: {
    parts: [{ id: 'p', label: 'Named protein', color: '#123456', chain: 'A', aliases: ['spoken name', 'ABC'] }],
    contextOpacity: 0.18,
  } };
  expect(parseMolecularLesson(manifest).chapters[0].immersive?.emphasis?.parts[0].aliases)
    .toEqual(['spoken name', 'ABC']);
  for (const aliases of [[''], [42], Array(17).fill('name'), ['x'.repeat(61)]]) {
    const invalid = structuredClone(manifest) as any;
    invalid.chapters[0].immersive.emphasis.parts[0].aliases = aliases;
    expect(() => parseMolecularLesson(invalid)).toThrow();
  }
});

it.each([.01,8,100])('accepts an authored immersive placement at explored scale %s', scale => {
  const value=lesson();
  value.chapters[0].immersive={placement:{scale,translation:[12,-20,30]}};
  expect(parseMolecularLesson(value).chapters[0].immersive?.placement).toEqual({scale,translation:[12,-20,30]});
});
