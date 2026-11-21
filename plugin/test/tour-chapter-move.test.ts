import { readFileSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { mountTourPlayer } from '../src/tour-player.js';
import { molecularLessonToTour } from '../src/molecular-lesson-tour.js';
// @ts-ignore Production player DOM boundary.
import { tourEndHarness } from '../../lab/browser-roundtrip/fixtures/tour-end-harness.mjs';
// @ts-ignore Production placement ownership.
import { createPlacementHold } from '../../lab/browser-roundtrip/wearer-placement.mjs';

// Telomerase in the headset: chapter 4 is a close-up, chapter 5 steps back.
// A move made during a chapter lasts for that chapter. Next opens the next
// chapter at its own authored view, and Done returns the starting view.
const lesson = molecularLessonToTour(JSON.parse(readFileSync(new URL('../demos/telomerase-haca.json', import.meta.url), 'utf8')));
const start = { translation: [0.1, -0.2, -0.3], rotation: [0, 0, 0], scale: 0.328 };

let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; });

function headset() {
  const h = tourEndHarness({ xr: true }), hold = createPlacementHold();
  // How many of the next scene restores and chapter placements fail.
  const failures = { restore: 0, place: 0 };
  let placement: any = structuredClone(start);
  const inspection = h.workspace.viewer.inspection;
  // The page's placement rules as `placeInspection` and `restoreInspection`
  // apply them: an authored chapter placement yields to a held one, and a
  // restore keeps a held placement where it is.
  // A captured scene carries its placement where the page's does, under `inspection`, too.
  h.workspace.capture = () => ({ placement: structuredClone(placement), inspection: { placement: structuredClone(placement) }, painted: { parts: [], origin: 'resting' }, appearance: {} });
  h.workspace.snapshot = () => ({ ready: true, sourceSha256: 'same', xrPresenting: true, inspection: { placement } });
  Object.assign(inspection, {
    holdsWearerPlacement: () => hold.holdsPlacement(),
    beginChapterFraming: (change?: any) => {
      hold.release('authored-chapter');
      return change && { found: change.found, ended: hold.ownership() };
    },
    // As the page's `endChapterPlacement` and `resumeChapterPlacement` do.
    endChapterPlacement: () => {
      const found = hold.ownership(); hold.endChapter?.('chapter-ended');
      return { found, ended: hold.ownership() };
    },
    resumeChapterPlacement: (change: any) => hold.resumeChapter(change.found, change.ended),
    place: async (patch: any, action?: string) => {
      if (action === 'tour-placement' && failures.place && failures.place-- > 0) throw Error('The chapter placement failed.');
      if (action === 'tour-placement' && hold.holdsPlacement()) return;
      placement = { ...placement, ...structuredClone(patch) };
    },
    restore: async (saved: any, options: any = {}) => {
      if (failures.restore && failures.restore-- > 0) throw Error('The scene restore failed.');
      if (!options.preservePlacement && !hold.holdsPlacement()) placement = structuredClone(saved.placement);
    },
    setVisibility: async () => {},
  });
  const player = mountTourPlayer({ ...h, tours: [lesson] });
  cleanup = () => { player.pause(); h.cleanup(); };
  const authored = (index: number) => Object.assign({ translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 },
    ...lesson.steps.slice(0, index + 1).map(step => step.placement ?? {}));
  return { player, hold, authored, failures,
    placement: () => structuredClone(placement),
    /** The agent shifts the molecule 0.3 m left (`update_inspection` placement). */
    agentShift: () => {
      placement = { ...placement, translation: [placement.translation[0] - 0.3, ...placement.translation.slice(1)] };
      hold.takeover('agent-placement');
    },
    grab: () => { placement = { ...placement, translation: [placement.translation[0] + 0.2, ...placement.translation.slice(1)] }; hold.takeover('grab'); },
    toCloseUp: async () => {
      await player.select(lesson.id); await player.start(false, 0);
      for (let i = 0; i < 3; i++) await player.next();
      expect(player.getState()).toMatchObject({ step: 3, active: true });
      expect(placement).toEqual(authored(3));
    },
  };
}

it('the telomerase steps used here are a close-up followed by a wider chapter', () => {
  expect(lesson.steps.map(step => step.id)).toEqual(['reveal', 'orbit', 'highlight', 'site', 'wide']);
  expect(Number(lesson.steps[3].placement?.scale)).toBeGreaterThan(Number(lesson.steps[4].placement?.scale));
});

it('after an agent move in a chapter, Next opens the next chapter at its own placement and turn', async () => {
  const h = headset();
  await h.toCloseUp();
  h.agentShift();
  expect(h.placement()).not.toEqual(h.authored(3));
  await h.player.next();
  expect(h.player.getState()).toMatchObject({ step: 4 });
  expect(h.placement()).toEqual(h.authored(4));
  expect(h.hold.holdsPlacement()).toBe(false);
});

it('after an agent move in a chapter, Done returns the starting view', async () => {
  const h = headset();
  await h.toCloseUp();
  h.agentShift();
  await h.player.finish();
  expect(h.placement()).toEqual(start);
  expect(h.hold.holdsPlacement()).toBe(false);
});

it('after an agent move, Next and then Done return the starting view', async () => {
  const h = headset();
  await h.toCloseUp();
  h.agentShift();
  await h.player.next();
  await h.player.finish();
  expect(h.placement()).toEqual(start);
});

it('after an agent move, Back opens the earlier chapter at its own view', async () => {
  const h = headset();
  await h.toCloseUp();
  h.agentShift();
  await h.player.back();
  expect(h.player.getState()).toMatchObject({ step: 2 });
  expect(h.placement().rotation).toEqual(h.authored(2).rotation);
  expect(h.placement().translation).toEqual(h.authored(2).translation);
});

it('the wearer\'s own move still carries across an ordinary chapter, as documented', async () => {
  const h = headset();
  await h.player.select(lesson.id); await h.player.start(false, 0); await h.player.next();
  h.grab(); const held = h.placement();
  // Orbit to highlight is a turn at the same size: an ordinary chapter.
  await h.player.next();
  expect(h.player.getState()).toMatchObject({ step: 2 });
  expect(h.hold.holdsPlacement()).toBe(true);
  expect(h.hold.state().reason).toBe('grab');
  expect(h.placement()).toEqual(held);
});

it('after an agent move, a peer\'s Done ends the move and returns this panel\'s starting view', async () => {
  const h = headset();
  await h.toCloseUp();
  h.agentShift();
  // What the page does for a shared scene with no lesson in it: the restore
  // keeps this panel's placement, then the player adopts the ended lesson.
  const resting: any = { sourceSha256: 'same', placement: h.placement(), painted: { parts: [], origin: 'resting' }, appearance: {} };
  await h.player.restorePlayback(resting, { frame: true });
  expect(h.player.getState()).toMatchObject({ step: -1 });
  expect(h.hold.holdsPlacement()).toBe(false);
  expect(h.placement()).toEqual(start);
});

it('a peer\'s Done leaves the wearer\'s own move where they put it', async () => {
  const h = headset();
  await h.toCloseUp();
  h.grab(); const held = h.placement();
  await h.player.restorePlayback({ sourceSha256: 'same', placement: held, painted: { parts: [], origin: 'resting' }, appearance: {} } as any, { frame: true });
  expect(h.player.getState()).toMatchObject({ step: -1 });
  expect(h.hold.holdsPlacement()).toBe(true);
  expect(h.placement()).toEqual(held);
});

it('a Done that fails and puts the chapter back gives the agent its move back for that chapter', async () => {
  const h = headset();
  await h.toCloseUp();
  h.agentShift(); const moved = h.placement();
  h.failures.restore = 1;
  await expect(h.player.finish()).rejects.toThrow();
  expect(h.player.getState()).toMatchObject({ step: 3 });
  expect(h.placement()).toEqual(moved);
  expect(h.hold.holdsPlacement()).toBe(true);
  expect(h.hold.state().reason).toBe('agent-placement');
  // Still that chapter's move alone: Next opens the next chapter at its own view.
  await h.player.next();
  expect(h.placement()).toEqual(h.authored(4));
  expect(h.hold.holdsPlacement()).toBe(false);
});

it('a Next that fails and puts the chapter back gives the agent its move back for that chapter', async () => {
  const h = headset();
  await h.toCloseUp();
  h.agentShift(); const moved = h.placement();
  h.failures.place = 1;
  await expect(h.player.next()).rejects.toThrow();
  expect(h.player.getState()).toMatchObject({ step: 3 });
  expect(h.placement()).toEqual(moved);
  expect(h.hold.holdsPlacement()).toBe(true);
  expect(h.hold.state().reason).toBe('agent-placement');
});

it('a close-up that fails after taking the wearer\'s hold over gives that hold back with the pose', async () => {
  const h = headset();
  await h.player.select(lesson.id); await h.player.start(false, 0);
  await h.player.next(); await h.player.next();
  expect(h.player.getState()).toMatchObject({ step: 2 });
  h.grab(); const held = h.placement();
  h.failures.place = 1;
  await expect(h.player.next()).rejects.toThrow();
  expect(h.player.getState()).toMatchObject({ step: 2 });
  expect(h.placement()).toEqual(held);
  expect(h.hold.holdsPlacement()).toBe(true);
  expect(h.hold.state().reason).toBe('grab');
});
