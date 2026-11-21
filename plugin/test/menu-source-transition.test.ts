import { expect, it } from 'vitest';
import { createPanelTourController } from '../src/inspection-tour-client.js';

function player(id: string) {
  let state: any = { tours: [{ id, title: id, steps: 3 }], selectedId: id,
    title: 'First chapter', bodyPage: 'Watch the molecule.', step: 0, total: 3,
    active: true, navigating: false, canNext: true, menuOpen: false };
  const listeners = new Set<() => void>();
  return { getState: () => state, subscribe(fn: () => void) { listeners.add(fn); return () => listeners.delete(fn); },
    change(next: any) { state = { ...state, ...next }; for (const fn of listeners) fn(); }, pause() {} };
}

it('source replacement holds lesson chrome through stop, catalog reset and first-chapter installation', () => {
  const lesson = player('lesson'), experience = player('experience');
  const panel = createPanelTourController(lesson as any, experience as any) as any;
  const release = panel.beginSourceTransition();
  experience.change({ active: false, navigating: false, step: -1, title: 'Tours', bodyPage: 'Choose a lesson.' });
  expect(panel.getState().active).toBe(false);
  expect(panel.getPresentationState()).toMatchObject({ active: true, navigating: true, title: 'First chapter', step: 0 });
  experience.change({ active: true, navigating: true, title: 'New chapter', step: 0 });
  expect(panel.getPresentationState().title).toBe('First chapter');
  experience.change({ navigating: false }); release();
  expect(panel.getPresentationState()).toMatchObject({ active: true, navigating: false, title: 'New chapter' });
  panel.dispose();
});

it('a superseded source load cannot release the next load’s presentation hold', () => {
  const panel = createPanelTourController(player('lesson') as any, player('experience') as any) as any;
  const first = panel.beginSourceTransition(), second = panel.beginSourceTransition(); first();
  expect(panel.getPresentationState().navigating).toBe(true); second();
  expect(panel.getPresentationState().navigating).toBe(false); panel.dispose();
});

it('a different lesson opened over the one on screen holds the loading state a first opening holds, marked as an opening', () => {
  const lesson = player('lesson'), experience = player('experience');
  experience.change({ selectedTitle: 'Lesson', captionCard: 'shown', progress: 'Scene 2 / 3', step: 1, canBack: true,
    autoplay: true, feedback: 'Playing.', bodyPageCount: 2, bodyPageIndex: 1 });
  const panel = createPanelTourController(lesson as any, experience as any) as any;
  const first = panel.beginSourceTransition(true);
  const held = panel.getPresentationState();
  expect(held).toMatchObject({ title: 'Loading structure', bodyPage: 'The next structure is being prepared.', step: 0, total: 1,
    active: true, navigating: true, sourceTransition: true, progress: 'Tours', feedback: '', canBack: false, canNext: false,
    autoplay: false, bodyPageCount: 1, bodyPageIndex: 0 });
  expect(held.opening).toBe(true);
  for (const key of ['selectedId', 'selectedTitle', 'captionCard']) expect(held).not.toHaveProperty(key);
  first();
  // The same lesson loading its next source still holds its chapter.
  const release = panel.beginSourceTransition();
  expect(panel.getPresentationState()).toMatchObject({ title: 'First chapter', selectedId: 'experience', step: 1 });
  expect(panel.getPresentationState()).not.toHaveProperty('opening');
  release(); panel.dispose();
});

it('a lesson that hides its caption card keeps it hidden while a different lesson opened over it loads', () => {
  const lesson = player('lesson'), experience = player('experience');
  experience.change({ captionCard: 'hidden' });
  const panel = createPanelTourController(lesson as any, experience as any) as any;
  const release = panel.beginSourceTransition(true);
  expect(panel.getPresentationState()).toMatchObject({ opening: true, captionCard: 'hidden', title: 'Loading structure' });
  release(); panel.dispose();
});
