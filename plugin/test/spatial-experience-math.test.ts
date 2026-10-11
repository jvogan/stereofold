// @ts-nocheck
import { describe, expect, it } from 'vitest';
import { roomPlacement } from '../../lab/browser-roundtrip/room-placement.mjs';
import { experienceVisibilityExpression, normalizeExperienceVisibility } from '../../lab/browser-roundtrip/experience-visibility.mjs';
const pose=(x,y,z)=>[1,0,0,0,0,1,0,0,0,0,1,0,x,y,z,1], identity=pose(0,0,0);
describe('experience spatial math',()=>{
 it('maps tracked overhead and forward targets into bounded molecular radii',()=>{
  const overhead=roomPlacement({headInRoom:pose(1,2,3),renderFromRoom:identity,cameraScale:.5,center:[0,0,0],radius:2,target:'overhead'});
  expect(overhead.translation.slice(0,2)).toEqual([1,5]);expect(overhead.scale).toBe(2);
  expect(Math.atan2(overhead.translation[1]-2,3-overhead.translation[2])*180/Math.PI).toBeCloseTo(65);
  expect(roomPlacement({headInRoom:pose(1,2,3),renderFromRoom:identity,cameraScale:.5,center:[0,0,0],radius:2,target:'front'})).toEqual({translation:[1,2,1],scale:.8});
  const vertical=[1,0,0,0,0,1,0,0,0,1,0,0,0,0,0,1];
  expect(()=>roomPlacement({headInRoom:vertical,renderFromRoom:identity,cameraScale:1,center:[0,0,0],radius:1,target:'front'})).toThrow(/Look ahead/);
  expect(roomPlacement({headInRoom:pose(100,0,0),renderFromRoom:identity,cameraScale:1,center:[0,0,0],radius:1,target:'overhead'}).translation[0]).toBe(100);
  expect(()=>roomPlacement({headInRoom:pose(1000001,0,0),renderFromRoom:identity,cameraScale:1,center:[0,0,0],radius:1,target:'overhead'})).toThrow(/numerical range/);
 });
 const builder={set:(...items)=>({set:items}),core:{set:{has:args=>({has:args})},logic:{and:args=>({and:args})}},struct:{atomProperty:{macromolecular:{label_entity_id:()=> 'entity',label_asym_id:()=> 'chain'},core:{operatorName:()=> 'operator'}},generator:{atomGroups:value=>({atomGroups:value})}}};
 it('normalizes IDs and intersects entity and exact assembly operators',()=>{
  const visible=normalizeExperienceVisibility({entityIds:['1','1'],operatorIds:['14','1']});expect(visible).toEqual({entityIds:['1'],operatorIds:['14','1']});
  const expression=experienceVisibilityExpression(builder,visible,{units:[{conformation:{operator:{assembly:{operList:['1']},name:'one'}}},{conformation:{operator:{assembly:{operList:['2']},name:'two'}}}]});
  expect(expression.atomGroups['atom-test'].and).toHaveLength(2);
  expect(()=>normalizeExperienceVisibility({entityIds:[]})).toThrow(/bounded/);expect(()=>normalizeExperienceVisibility({unexpected:['1']})).toThrow(/Unknown/);
  expect(()=>experienceVisibilityExpression(builder,{operatorIds:['14']},{units:[{conformation:{operator:{assembly:{operList:['1']},name:'one'}}}]})).toThrow(/No assembly/);
 });
});
