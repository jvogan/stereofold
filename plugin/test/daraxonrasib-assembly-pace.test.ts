import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { molecularLessonToTour } from '../src/molecular-lesson-tour.js';
import { tourStepDwellMs } from '../src/tour-player.js';

// The assembly lesson's first chapter plays its clip once and then hands over
// to the residue contacts, so a wearer who presses Play reaches them in about
// ten seconds. The chapter must still outlast the clip's motion at the
// quickest autoplay pace, which shortens the chapter but not the clip.
const lesson = JSON.parse(readFileSync(new URL('../demos/daraxonrasib-assembly/motion.json', import.meta.url), 'utf8'));
const tour = molecularLessonToTour(lesson);
const paceValues = [...readFileSync(new URL('../src/tour-player.ts', import.meta.url), 'utf8')
  .match(/data-tour-pace[^>]*>([\s\S]*?)<\/select>/u)![1].matchAll(/value="([\d.]+)"/gu)].map(match => Number(match[1]));

const lastMotionSeconds = (animation: NonNullable<typeof tour.steps[number]['animation']>) => Math.max(...animation.tracks.map(track => {
  let last = 0;
  track.keyframes.forEach((frame, i) => {
    const previous = track.keyframes[i - 1];
    if (previous && [...frame.rotation, ...frame.translation].some((value, k) => value !== [...previous.rotation, ...previous.translation][k])) last = frame.t;
  });
  return last;
}));

it('plays the assembly clip once and reaches the contacts within ten seconds at the comfortable pace', () => {
  const [assemble, contacts] = tour.steps;
  expect(assemble!.id).toBe('assemble');
  expect(contacts!.id).toBe('interface');
  expect(assemble!.animation!.playback).toEqual({ autoplay: true, loop: false, speed: 1 });
  expect(tourStepDwellMs(assemble, 0, true)).toBeLessThanOrEqual(10_000);
  expect(tourStepDwellMs(assemble, 0, false)).toBeLessThanOrEqual(10_000);
});

it('keeps the first chapter on screen until the pair has docked, at every autoplay pace', () => {
  const assemble = tour.steps[0]!;
  const motion = lastMotionSeconds(assemble.animation!) * 1_000;
  expect(paceValues.length).toBeGreaterThanOrEqual(3);
  for (const pace of paceValues) for (const narration of [true, false])
    expect(Math.ceil(tourStepDwellMs(assemble, 0, narration) / pace), `pace ${pace}`).toBeGreaterThanOrEqual(motion);
});
