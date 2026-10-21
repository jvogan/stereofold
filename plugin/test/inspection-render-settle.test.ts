import { expect, it } from 'vitest';
import { withWearerEdits } from '../src/inspection-render-settle.js';

const emphasis = (id: string) => ({ parts: [{ id, label: id, color: '#ffffff', chain: 'A' }],
  focus: [id], contextOpacity: .3, origin: 'command' });

it('rolls back unchanged lesson emphasis while preserving a wearer focus delta', () => {
  const checkpoint = { inspection: { emphasis: emphasis('baseline') } };
  const drawn = { inspection: { emphasis: { ...emphasis('lesson'), origin: 'lesson' } } };
  expect(withWearerEdits(checkpoint, drawn, structuredClone(drawn))).toEqual(checkpoint);
  const wearer = structuredClone(drawn); wearer.inspection.emphasis.focus = [];
  expect(withWearerEdits(checkpoint, drawn, wearer).inspection.emphasis).toEqual(wearer.inspection.emphasis);
  expect(checkpoint.inspection.emphasis.focus).toEqual(['baseline']);
});

it('preserves a wearer clearing emphasis after the lesson draw', () => {
  const checkpoint = { inspection: { emphasis: emphasis('baseline') } };
  const drawn = { inspection: { emphasis: emphasis('lesson') } };
  expect(withWearerEdits(checkpoint, drawn, { inspection: {} }).inspection).not.toHaveProperty('emphasis');
});
