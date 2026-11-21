import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { molecularLessonToTour } from '../src/molecular-lesson-tour.js';
import { tourStepDwellMs } from '../src/tour-player.js';

// A still chapter that follows a clip shows one view, its names and its line,
// and nothing else changes in it. These two held that view for 16 seconds
// while their line takes about six to say and one card page to show, so the
// wearer waited ten seconds with nothing new. They now last as long as a card
// page and the line need, with a few seconds to look.
const tourOf = (rel: string) => molecularLessonToTour(JSON.parse(readFileSync(new URL(`../demos/${rel}`, import.meta.url), 'utf8')));
const CARD_PAGE_MS = 7_000;
const STILL_LIMIT_MS = 10_000;

for (const [rel, id] of [['kinesin-walk/motion.json', 'both-bound'], ['atp-synthase-rotor/motion.json', 'protons']] as const) {
  it(`holds the still ${id} chapter of ${rel} no longer than ten seconds`, () => {
    const step = tourOf(rel).steps.find(entry => entry.id === id)!;
    expect(step.animation).toBeUndefined();
    expect(tourStepDwellMs(step, 0, true)).toBeLessThanOrEqual(STILL_LIMIT_MS);
    expect(tourStepDwellMs(step, 0, false)).toBeLessThanOrEqual(STILL_LIMIT_MS);
    // Neither the line nor one page of the chapter card is cut short.
    const words = step.narration!.trim().split(/\s+/u).length;
    expect(tourStepDwellMs(step, 0, false)).toBeGreaterThanOrEqual(Math.max(CARD_PAGE_MS, Math.ceil(words / 3 * 1_000)));
  });
}
