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
