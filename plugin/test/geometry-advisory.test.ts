import { describe, expect, it } from 'vitest';
// @ts-ignore Shared browser geometry policy.
import { geometryBudgetReceipt, requireGeometryBudget, requireComparisonGeometryBudget, requireSceneGeometryBudget } from '../../lab/browser-roundtrip/representation-budget.mjs';
import { geometryBudgetReceiptSchema } from '../src/inspection-contract.js';

const options = { presenting: true, deviceClass: 'quest2', quality: 'highest', standalone: false };
const entry = (representation: string) => ({ representation, atoms: 1_000_001, bonds: 1_100_000, residues: 160_000 });

describe('geometry advisories crossing the host receipt boundary', () => {
  it('accepts finite million-atom advisories for every selected representation without reducing quality', () => {
    for (const representation of ['cartoon', 'spacefill', 'ball-and-stick', 'molecular-surface']) {
      const decision = requireGeometryBudget({ ...options, ...entry(representation) });
      expect(decision).toMatchObject({ representation, status: 'advisory', level: 'highest', requestedLevel: 'highest', typeParams: {} });
      expect(decision.message).toContain('may run slowly');
      expect(decision.message).not.toMatch(/FPS|safe|reduced|lowest/);
      const receipt = geometryBudgetReceipt(decision);
      expect(geometryBudgetReceiptSchema.parse(JSON.parse(JSON.stringify(receipt)))).toEqual(receipt);
      expect(receipt.estimatedVertices).toBeGreaterThan(receipt.budget);
    }
  });

  it('accepts combined primary, comparison and styled-layer advisories with each requested detail intact', () => {
    const primary = { ...entry('spacefill'), quality: 'highest' };
    const companion = { ...entry('ball-and-stick'), quality: 'high' };
    for (const decisions of [requireComparisonGeometryBudget(primary, companion, options),
      requireSceneGeometryBudget([primary, companion, { ...entry('molecular-surface'), quality: 'medium' }], options)]) {
      expect(decisions.map((d: any) => d.level)).toEqual(decisions.length === 2 ? ['highest', 'high'] : ['highest', 'high', 'medium']);
      for (const decision of decisions) {
        expect(decision.status).toBe('advisory'); expect(decision.typeParams).toEqual({});
        const receipt = geometryBudgetReceipt(decision);
        expect(geometryBudgetReceiptSchema.parse(JSON.parse(JSON.stringify(receipt)))).toEqual(receipt);
      }
    }
  });

  it('keeps unbounded Vision Pro decisions unchanged and never serializes invalid cost numbers', () => {
    const decisions = requireSceneGeometryBudget([entry('spacefill'), entry('molecular-surface')], { ...options, deviceClass: 'vision-pro' });
    for (const decision of decisions) {
      expect(decision.status).toBe('unchanged'); expect(decision.typeParams).toEqual({});
      expect(geometryBudgetReceipt(decision)).toBeUndefined();
    }
    const valid = requireGeometryBudget({ ...options, ...entry('spacefill') });
    for (const bad of [{ budget: Infinity }, { budget: 0 }, { atoms: NaN }, { atoms: -1 },
      { atoms: Number.MAX_SAFE_INTEGER + 1 }, { estimatedVertices: Infinity }, { estimatedVertices: 1.5 }]) {
      expect(geometryBudgetReceipt({ ...valid, ...bad })).toBeUndefined();
    }
  });
});
