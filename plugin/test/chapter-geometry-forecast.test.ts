import { expect, it } from 'vitest';
import { chapterBudget, chapterBudgetNotice } from '../src/experience-budget.js';
import { experienceById } from '../src/molecular-experience.js';
const experience=experienceById('hemoglobin-quaternary-structure')!;
const counts={atoms:1000,bonds:1200,residues:100};
function chapter(representation:any,geometry=counts,device='quest2') {
  const lesson=structuredClone(experience);lesson.steps[0].appearance.representation=representation;
  return chapterBudget(lesson,0,geometry,device);
}
it.each([
  ['spacefill',12000,642000],
  ['ball-and-stick',12000+1200*2*18,642000+1200*2*220],
  ['cartoon',100*24,100*2010],
])('reports an unknown-quality mesh proxy range for %s instead of a fixed lowest tier', (representation,min,max)=>{
  const result=chapter(representation);
  expect(result).toMatchObject({status:'available',geometryEstimate:{kind:'mesh-equivalent',quality:'unknown',representation,
    ...counts,vertices:{min,max}}});
  expect(result.geometryEstimate).not.toHaveProperty('level');
});
it('surface range records both supported grid extremes without claiming exact triangulation',()=>{
  expect(chapter('molecular-surface').geometryEstimate?.vertices).toEqual({
    min:Math.ceil(1000*4*Math.PI*3.2**2/8**2),max:Math.ceil(1000*4*Math.PI*3.2**2/.1**2)});
});
it('distinguishes quality-dependent cost from an advisory over the entire range without refusing',()=>{
  const dependent=chapter('spacefill',{...counts,atoms:9999});
  const all=chapter('spacefill',{...counts,atoms:10001});
  expect(dependent.status).toBe('available');expect(dependent.message).toContain('quality-dependent');
  expect(dependent.message).toContain('settings are unknown');
  expect(all.status).toBe('available');expect(all.message).toContain('may run slowly across the estimated quality range');
  expect(all.geometryEstimate?.vertices.min).toBeGreaterThan(all.geometryEstimate!.policy!);
  expect(chapterBudgetNotice([dependent,all])).toContain('current renderer quality and custom geometry settings are unavailable');
});
it('unbounded devices retain finite serializable counts and ranges without an Infinity policy or advisory',()=>{
  const result=chapter('spacefill',counts,'vision-pro');
  expect(result.status).toBe('available');expect(result.message).toBeUndefined();
  expect(result.geometryEstimate).not.toHaveProperty('policy');
  expect(JSON.parse(JSON.stringify(result))).toEqual(result);
});
it('does not rewrite authored appearance or call an overflowed proxy exact',()=>{
  const before=structuredClone(experience);
  chapterBudget(experience,0,counts);expect(experience).toEqual(before);
  const overflow=chapter('spacefill',{atoms:Number.MAX_SAFE_INTEGER,bonds:0,residues:0});
  expect(overflow).toMatchObject({status:'unchecked',message:expect.stringContaining('finite vertex estimate')});
  expect(overflow.geometryEstimate).toBeUndefined();
  expect(chapterBudget(experience,0,undefined).geometryEstimate).toBeUndefined();
});
