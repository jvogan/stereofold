import { describe, expect, it } from 'vitest';
import { compileMolecularLesson, createGenericMolecularLesson, MOLECULAR_LESSON_LIMITS } from '../src/molecular-lesson.js';
import { molecularLessonToTour } from '../src/molecular-lesson-tour.js';
import { captionLine, wearerPages, tourStepDwellMs } from '../src/tour-player.js';

describe('optional chapter source details', () => {
  it('carries trimmed source details only as the optional tour field', () => {
    const lesson = createGenericMolecularLesson({ sourceRef: 'own.cif' });
    const original = molecularLessonToTour(lesson).steps[0];
    lesson.chapters[0].details = '  Original UUID: 02090d8c\nPublished predicted complex.  ';
    const compiled = compileMolecularLesson(lesson);
    const step = molecularLessonToTour(lesson).steps[0];
    expect(step.details).toBe('Original UUID: 02090d8c\nPublished predicted complex.');
    expect(compiled.manifest.chapters[0].details).toBe(step.details);
    expect(step.body).toBe(original.body);
    expect(step.narration).toBe(original.narration);
    expect(captionLine(step)).toBe(captionLine(original));
    expect(wearerPages(step)).toEqual(wearerPages(original));
    expect(tourStepDwellMs(step)).toBe(tourStepDwellMs(original));
  });

  it('keeps old lessons compatible and accepts absent or blank details', () => {
    const lesson = createGenericMolecularLesson({ sourceRef: 'own.cif' });
    expect(molecularLessonToTour(lesson).steps[0]).not.toHaveProperty('details');
    lesson.chapters[0].details = ' \n ';
    expect(molecularLessonToTour(lesson).steps[0].details).toBe('');
  });

  it('enforces the independent 2000-character details bound', () => {
    const lesson = createGenericMolecularLesson({ sourceRef: 'own.cif' });
    expect(MOLECULAR_LESSON_LIMITS.maxDetailsCharacters).toBe(2000);
    lesson.chapters[0].details = 'x'.repeat(2000);
    expect(molecularLessonToTour(lesson).steps[0].details).toHaveLength(2000);
    lesson.chapters[0].details += 'x';
    expect(() => compileMolecularLesson(lesson)).toThrow();
    (lesson.chapters[0] as any).details = { text: 'Not a string' };
    expect(() => compileMolecularLesson(lesson)).toThrow();
  });
});
