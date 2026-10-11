import { compileMolecularLesson, type MolecularLessonChapter } from './molecular-lesson.js';
import type { Tour, TourEmphasis, TourEmphasisPart } from './tour-player.js';

type LessonEmphasis = NonNullable<NonNullable<MolecularLessonChapter['immersive']>['emphasis']>;

/**
 * The colour key travels in the saved scene, and the wire
 * contract (`emphasisPartSchema`) is strict. A lesson part may also carry an
 * author's `note` and spoken `aliases`; neither is scene state, and a part
 * that arrived with them was refused by every `sync_inspection` from the first
 * lit chapter on, with the refusal text drawn as a plate in the wearer's view
 * (hemoglobin). Only the fields the scene names travel.
 */
function wireEmphasis(emphasis: LessonEmphasis): TourEmphasis {
  const parts: TourEmphasisPart[] = emphasis.parts.map(part => ({
    id: part.id, label: part.label, color: part.color,
    ...(part.chain !== undefined ? { chain: part.chain } : {}),
    ...(part.residues !== undefined ? { residues: { from: part.residues.from, to: part.residues.to } } : {}),
  }));
  return {
    parts,
    ...(emphasis.focus !== undefined ? { focus: emphasis.focus } : {}),
    contextOpacity: emphasis.contextOpacity,
    ...(emphasis.framing !== undefined ? { framing: emphasis.framing } : {}),
    ...(emphasis.strandShades !== undefined ? { strandShades: emphasis.strandShades } : {}),
  };
}

/** Desktop cinematic motion and layer graphs are not an XR camera contract.
 * Each chapter must supply its own deliberate, validated immersive intent. */
export function molecularLessonToTour(input: unknown): Tour {
  const { manifest } = compileMolecularLesson(input);
  const sources = manifest.provenance.sourceRefs
    .filter(source => /^https:\/\//i.test(source.ref))
    .map(source => ({ title: source.kind === 'publication' ? 'Lesson source' : 'Structure source', url: source.ref }));
  return {
    id: `lesson-${manifest.id}`,
    title: manifest.title,
    summary: manifest.provenance.note || 'A custom molecular lesson. Pause to explore; rejoin to return to the chapter.',
    // The lesson's presentation choice rides the tour whole, so the headset
    // readout can honour it. Absent for a lesson that never set it, which the
    // readout reads as `shown`.
    ...(manifest.presentation ? { presentation: manifest.presentation } : {}),
    steps: manifest.chapters.map(chapter => {
      if (!chapter.immersive) throw Error(`Chapter ${chapter.id} has no immersive intent. Author it before opening this lesson on Quest.`);
      const { emphasis, ...immersive } = chapter.immersive;
      // The authored visibility operation travels unchanged; the player resolves
      // its chain referents against the actual loaded source before applying it.
      return {
        id: chapter.id, title: chapter.title, body: chapter.caption,
        durationMs: chapter.durationSeconds * 1000,
        ...immersive, ...(emphasis ? { emphasis: wireEmphasis(emphasis) } : {}), sources,
      };
    }),
  };
}
