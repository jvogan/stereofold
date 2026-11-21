import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseMolecularLesson } from '../src/molecular-lesson.js';

// The telomerase lesson names each chapter's own parts with figure labels, the
// same anchored labels the other shipped lessons use, instead of a plate for
// every part laid out as a legend. Each label is anchored in the part it
// names, so it sits on that part and is not laid out again as the wearer moves.
const raw = JSON.parse(readFileSync(new URL('../demos/telomerase-haca.json', import.meta.url), 'utf8'));
const lesson = parseMolecularLesson(raw);

describe('telomerase name labels', () => {
  it('asks for no legend plates in any chapter', () => {
    for (const chapter of lesson.chapters) expect(chapter.immersive?.appearance?.componentLabels, chapter.id).toBe(false);
  });

  it('labels a few parts per chapter, each anchored in the part it names', () => {
    for (const chapter of lesson.chapters) {
      const labels = chapter.immersive?.figure?.labels ?? [];
      expect(labels.length, chapter.id).toBeGreaterThanOrEqual(2);
      expect(labels.length, chapter.id).toBeLessThanOrEqual(6);
      const parts = chapter.immersive?.emphasis?.parts ?? [];
      for (const label of labels) {
        const part = parts.find(p => `${p.id}-name` === label.id);
        expect(part, `${chapter.id} ${label.id}`).toBeDefined();
        // The label selects its part, or a stretch of it that faces the
        // wearer in this chapter, so the headset rests it on that part's
        // surface facing the wearer, and nowhere else.
        const { chain, residues, ...rest } = label.target;
        expect(rest).toEqual({});
        expect(chain).toBe(part!.chain);
        expect(residues!.from).toBeGreaterThanOrEqual(part!.residues!.from);
        expect(residues!.to).toBeLessThanOrEqual(part!.residues!.to);
        expect(residues!.to - residues!.from).toBeGreaterThanOrEqual(15);
        expect(label.color).toBe(part!.color);
        expect(label.placement ?? 'attached').toBe('attached');
        expect(Math.abs(label.offsetX) + Math.abs(label.offsetY)).toBe(0);
        // The plate reads as the part's own name.
        const name = label.text.split(' ')[0]!.toLowerCase();
        expect(part!.label.toLowerCase()).toContain(name === 'telomerase' ? 'telomerase rna' : name);
      }
      const texts = labels.map(label => label.text);
      expect(new Set(texts).size, chapter.id).toBe(texts.length);
    }
  });

  it('frames the dyskerin close-up to fill the view with its focus when the figure adds the labels', async () => {
    // Plates used to imply context framing for every labelled chapter. With
    // labels from a figure, the close-up says so itself, or the figure would
    // frame the whole complex instead of the two dyskerin copies. Context
    // framing left room for a legend of ten plates and drew the close-up at a
    // third of the view; the close-up fills it, as the other demos' do, and
    // fades the rest no further than the shipped default.
    const site = lesson.chapters.find(chapter => chapter.id === 'site')!;
    expect(site.immersive?.emphasis?.focus).toEqual(['dyskerin-c', 'dyskerin-g']);
    expect(site.immersive?.emphasis?.framing).toBe('fill');
    expect(site.immersive?.emphasis?.contextOpacity).toBeGreaterThanOrEqual(0.18);
    const { molecularLessonToTour } = await import('../src/molecular-lesson-tour.js');
    const step = molecularLessonToTour(raw).steps.find(s => s.emphasis?.focus?.length)!;
    expect(step.emphasis).toMatchObject({ framing: 'fill', focus: ['dyskerin-c', 'dyskerin-g'] });
  });

  it('ends on its starting view with no names left on it', () => {
    // The starting view draws the whole particle small beside the menu, and
    // names kept from the closing chapter piled up on it. Done leaves none.
    expect(lesson.presentation?.endFigure).toBeUndefined();
    expect(lesson.chapters.at(-1)?.immersive?.figure?.labels?.length).toBeGreaterThan(0);
    // The lesson can still ask for them, and then needs a closing figure.
    const named = structuredClone(raw);
    named.presentation.endFigure = 'last';
    expect(parseMolecularLesson(named).presentation?.endFigure).toBe('last');
    delete named.chapters.at(-1).immersive.figure;
    expect(() => parseMolecularLesson(named)).toThrow(/endFigure "last" needs a figure on the last chapter/);
  });

  it('shows its chapter card like the other captioned tours', () => {
    // The card was hidden while ten name plates were laid out as a legend
    // round the molecule. The names now rest on their parts.
    expect(lesson.presentation?.captionCard).toBe('shown');
  });
});
