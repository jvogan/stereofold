import { describe, expect, it } from 'vitest';
import { TOURS } from '../src/tour-catalog.js';
import { resolveTourSelection } from '../src/tour-player.js';
import { sceneSchema } from '../src/inspection-contract.js';

describe('bundled educational tours',()=>{
  it('ships ten complete, uniquely authored twenty-scene lessons',()=>{
    expect(TOURS).toHaveLength(10);
    expect(new Set(TOURS.map(t=>t.id)).size).toBe(10);
    const scenes=TOURS.flatMap(t=>t.steps);
    expect(scenes).toHaveLength(200);
    expect(new Set(scenes.map(s=>s.id)).size).toBe(200);
    expect(new Set(scenes.map(s=>s.body)).size).toBe(200);
    for(const tour of TOURS) {
      expect(tour.steps.length).toBeGreaterThanOrEqual(20);
      for(const step of tour.steps) {
        expect(step.body!.length).toBeGreaterThan(100);
        expect(step.sources!.every(s=>s.url !== undefined && new URL(s.url).protocol==='https:')).toBe(true);
        if(step.appearance) expect(sceneSchema.shape.inspection.shape.appearance.partial().safeParse(step.appearance).success).toBe(true);
        if(step.placement) expect(sceneSchema.shape.inspection.shape.placement.partial().safeParse(step.placement).success).toBe(true);
      }
    }
  });
  it('resolves chemistry selections from the actual loaded catalog',()=>{
    const rows=[{key:'x',identity:{authorChain:'Q',componentId:'TYR'}},{key:'y',identity:{authorChain:'R',componentId:'GLY'}}];
    expect(resolveTourSelection(rows,{componentIds:['PHE','TYR','TRP']})).toEqual(['x']);
    expect(resolveTourSelection(rows,{componentIds:['ASP','GLU']})).toEqual([]);
    expect(resolveTourSelection(rows,{firstChain:true})).toEqual(['x']);
  });
});
