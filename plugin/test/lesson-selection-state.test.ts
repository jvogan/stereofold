import {expect,it} from 'vitest';
import {expectedInspection,sceneSchema,validateScene} from '../src/inspection-contract.js';
import {withWearerEdits} from '../src/inspection-render-settle.js';
// @ts-ignore Shared viewer defaults.
import {createInspectionState} from '../../lab/browser-roundtrip/inspection-state.mjs';
const scene=()=>({sourceSha256:'a'.repeat(64),modelNumber:1,assemblyId:'1',selectionKeys:['B1','B2'],
  camera:{mode:'perspective',fov:Math.PI/4,position:[0,0,80],target:[0,0,0],up:[0,1,0],radius:20,radiusMax:20,fog:0,clipFar:true,minNear:1,minFar:0},
  inspection:{appearance:createInspectionState().snapshot().appearance,placement:createInspectionState().snapshot().placement,lessonSelection:'B1\nB2'}});
it('the scene transport preserves chapter selection ownership',()=>{
  expect(sceneSchema.parse(scene()).inspection.lessonSelection).toBe('B1\nB2');
});
it('old scenes keep wearer ownership, and a mismatched owner is refused before restore',()=>{
  const old: any=scene(); delete old.inspection.lessonSelection;
  expect(sceneSchema.parse(old).inspection).not.toHaveProperty('lessonSelection');
  const bad=scene(); bad.selectionKeys=['A1'];
  expect(()=>validateScene(bad,{})).toThrow('Lesson selection ownership must match the saved selection keys.');
});
it('a wearer selection releases lesson ownership, including the same keys',()=>{
  const saved=sceneSchema.parse(scene());
  for(const keys of [['B1','B2'],['A1'],[]])
    expect(expectedInspection(saved,{kind:'selection',patch:{selectionKeys:keys}}).inspection).not.toHaveProperty('lessonSelection');
});
it('rollback keeps selection ownership paired with a later wearer selection',()=>{
  const checkpoint={selectionKeys:['B1'],inspection:{lessonSelection:'B1'}};
  const drawn={selectionKeys:['D5'],inspection:{lessonSelection:'D5'}};
  const wearer={selectionKeys:['B1'],inspection:{}};
  expect(withWearerEdits(checkpoint,drawn,wearer)).toEqual(wearer);
  const selectedSameKeys={...drawn,inspection:{}};
  expect(withWearerEdits(checkpoint,drawn,selectedSameKeys)).toEqual(selectedSameKeys);
});
