import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { updateInspectionSchema, inspectionChangeSchema, animationStateSchema } from '../src/inspection-contract.js';
const binding={sessionId:randomUUID(),serverEpoch:randomUUID(),sourceToken:randomUUID(),baseStateRevision:0,baseInspectionRevision:0,panelId:randomUUID(),commandId:'animation'};
it('parses chapter animation controls, retaining false and zero',()=>{
  for(const patch of [{state:'pause'},{state:'play'},{speed:0.1},{speed:4},{seekSeconds:0},{loop:false},{restart:true},{restart:true,state:'play',loop:true,speed:0.5}]) {
    const change={kind:'animation',patch};
    expect(updateInspectionSchema.parse({...binding,change}).change).toEqual(change);
    expect(inspectionChangeSchema.parse(change)).toEqual(change);
  }
});
it('rejects empty, unknown, non-finite and out-of-range controls',()=>{
  for(const patch of [{},{state:'playing'},{speed:0},{speed:0.09},{speed:4.01},{speed:Infinity},{seekSeconds:-1},{seekSeconds:NaN},{loop:1},{restart:false},{durationSeconds:2}])
    expect(updateInspectionSchema.safeParse({...binding,change:{kind:'animation',patch}}).success).toBe(false);
  expect(updateInspectionSchema.safeParse({...binding,change:{kind:'animation',patch:{state:'pause'},target:{id:'forged',chapterId:'chapter'}}}).success).toBe(false);
});
it('validates playback samples',()=>{
  const state={id:'clip',chapterId:'walk',state:'paused',timeSeconds:0,durationSeconds:2,loop:false,speed:1};
  expect(animationStateSchema.parse(state)).toEqual(state);
  const counted={...state,representationCounts:{molecular:2,moving:1,added:1,annotations:2,tethers:1}};
  expect(animationStateSchema.parse(counted)).toEqual(counted);
  expect(animationStateSchema.safeParse({...counted,representationCounts:{...counted.representationCounts,added:-1}}).success).toBe(false);
  expect(animationStateSchema.safeParse({...state,timeSeconds:3}).success).toBe(false);
});

import { animationReceiptMatches } from '../src/animation-receipt.js';
it('accepts elapsed rendered seek/restart samples, loop wrap and a terminal play frame',()=>{
  const state={id:'clip',chapterId:'walk',state:'playing' as const,timeSeconds:1.1,durationSeconds:2,loop:false,speed:1};
  expect(animationReceiptMatches({state:'play',seekSeconds:1},state,.2)).toBe(true);
  expect(animationReceiptMatches({state:'play',restart:true},{...state,timeSeconds:.1},.2)).toBe(true);
  expect(animationReceiptMatches({state:'play',seekSeconds:1.9},{...state,loop:true,timeSeconds:.1},.3)).toBe(true);
  expect(animationReceiptMatches({state:'play',seekSeconds:2},{...state,state:'paused',timeSeconds:2},.02)).toBe(true);
  expect(animationReceiptMatches({state:'pause',seekSeconds:1}, {...state,state:'paused'},.2)).toBe(false);
  expect(animationReceiptMatches({state:'play',seekSeconds:1}, {...state,timeSeconds:1.8},.2)).toBe(false);
  expect(animationReceiptMatches({state:'play'}, {...state,state:'paused'},.2)).toBe(false);
});

import { expectedInspection, matchesInspectionChange, sceneSchema } from '../src/inspection-contract.js';
it('a playing emphasis receipt permits clock advance but refuses an unrelated pause or scene edit',()=>{
  const scene=sceneSchema.parse({sourceSha256:'a'.repeat(64),modelNumber:1,assemblyId:'1',selectionKeys:[],
    camera:{mode:'perspective',fov:Math.PI/4,position:[0,0,80],target:[0,0,0],up:[0,1,0],radius:20,radiusMax:20,fog:0,clipFar:true,minNear:1,minFar:0},
    inspection:{appearance:{representation:'cartoon',color:'chain-id',uniformColor:'#58dcc9',background:'#071015',
      opacity:1,labels:false,highlightColor:'#f2c47c',clipping:0,fog:0},placement:{translation:[0,0,0],rotation:[0,0,0],scale:1},
      animation:{definition:{version:1,durationSeconds:10,playback:{autoplay:true,loop:true},tracks:[{id:'motor',chains:['A'],
        keyframes:[{t:0,translation:[0,0,0],rotation:[0,0,0,1]}]}]},playback:{id:'clip',chapterId:'walk',state:'playing',timeSeconds:1,durationSeconds:10,loop:true,speed:1}}}});
  const change=inspectionChangeSchema.parse({kind:'emphasis',patch:{parts:[{id:'atp',label:'ATP analogue',chain:'A',color:'#ff00ff'}],focus:['atp'],contextOpacity:.25}});
  const expected=expectedInspection(scene,change),drawn=structuredClone(expected);
  drawn.inspection.animation!.playback.timeSeconds=2;
  drawn.inspection.animation!.playback.representationCounts={molecular:4,moving:2,added:2,annotations:0,tethers:0};
  expect(matchesInspectionChange(drawn,expected,change)).toBe(true);
  drawn.inspection.animation!.playback.state='paused';
  expect(matchesInspectionChange(drawn,expected,change)).toBe(false);
  drawn.inspection.animation!.playback.state='playing';drawn.inspection.placement.scale=1.2;
  expect(matchesInspectionChange(drawn,expected,change)).toBe(false);
});
