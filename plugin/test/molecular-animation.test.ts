import { expect, it, vi } from 'vitest';
import { molecularAnimationSchema, ANIMATION_LIMITS } from '../src/molecular-animation.js';
import { compileMolecularLesson, parseMolecularLesson } from '../src/molecular-lesson.js';
import { molecularLessonToTour } from '../src/molecular-lesson-tour.js';
import { mountTourPlayer } from '../src/tour-player.js';
import { readFileSync } from 'node:fs';
// @ts-ignore Test DOM boundary.
import { tourEndHarness } from '../../lab/browser-roundtrip/fixtures/tour-end-harness.mjs';
const animation = {version:1,durationSeconds:2,playback:{autoplay:true,loop:true,speed:1},tracks:[{id:'cd',chains:['C','D'],keyframes:[
  {t:0,rotation:[0,0,0,1],translation:[0,0,0]}, {t:2,rotation:[0,0,1,0],translation:[10,0,0]},
]}]};
it('validates bounded, unique bodies and ordered absolute events',()=>{
  expect(molecularAnimationSchema.parse(animation)).toEqual(animation);
  for(const tracks of [
    [animation.tracks[0], {...animation.tracks[0],id:'other'}],
    [{...animation.tracks[0],chains:['C','C']}],
    [{...animation.tracks[0],keyframes:[animation.tracks[0].keyframes[1],animation.tracks[0].keyframes[0]]}],
    [{...animation.tracks[0],keyframes:[{t:3,rotation:[0,0,0,1],translation:[0,0,0]}]}],
    [{...animation.tracks[0],keyframes:[{t:0,rotation:[0,0,0,0],translation:[0,0,0]}]}],
    [{...animation.tracks[0],visibility:[{t:1,visible:true},{t:.5,visible:false}]}],
    [{...animation.tracks[0],visibility:Array(ANIMATION_LIMITS.eventsPerTrack+1).fill({t:0,visible:true})}],
    [{...animation.tracks[0],keyframes:Array(ANIMATION_LIMITS.keyframesPerTrack+1).fill(animation.tracks[0].keyframes[0])}],
    Array(ANIMATION_LIMITS.tracks+1).fill(animation.tracks[0]),
  ]) expect(()=>molecularAnimationSchema.parse({...animation,tracks})).toThrow();
  expect(()=>molecularAnimationSchema.parse({...animation,pivot:[0,0,0]})).toThrow();
  expect(()=>molecularAnimationSchema.parse({...animation,playback:{speed:Infinity}})).toThrow();
});
const lesson = () => JSON.parse(readFileSync(new URL('../../fixtures/4HHB-motion-test.lesson.json',import.meta.url),'utf8'));
it('validates tether identities, limits, endpoints and different body ownership', () => {
  const tether = {id:'dimer', from:{chain:'C',residue:1,atom:'CA'}, to:{chain:'A',residue:1,atom:'CA'}, color:'#ffcc00', label:'Dimer'};
  expect(molecularAnimationSchema.parse({...animation,tethers:[tether]}).tethers).toEqual([tether]);
  const tracks = [...animation.tracks, {...animation.tracks[0],id:'ab',chains:['A','B']}];
  expect(() => molecularAnimationSchema.parse({...animation,tracks,tethers:[tether]})).not.toThrow();
  for (const tethers of [
    [tether,tether],
    Array.from({length:17}, (_,i) => ({...tether,id:`t${i}`})),
    [{...tether,to:{...tether.to,chain:'D'}}],
    [{...tether,from:{...tether.from,chain:'B'}}],
    [{...tether,from:{...tether.from,residue:1.5}}],
    [{...tether,from:{...tether.from,atom:''}}],
    [{...tether,color:'red'}], [{...tether,label:'x'.repeat(81)}],
  ]) expect(() => molecularAnimationSchema.parse({...animation,tethers})).toThrow();
  const input = lesson(); input.chapters[0].animation.tethers = [tether];
  expect(molecularLessonToTour(input).steps[0].animation?.tethers).toEqual([tether]);
  delete input.chapters[0].animation; input.chapters[0].tethers = [tether];
  expect(() => compileMolecularLesson(input)).toThrow();
});
it('validates and preserves optional caption offsets through lesson parsing and compilation', () => {
  const tether = {id:'dimer', from:{chain:'C',residue:1,atom:'CA'}, to:{chain:'A',residue:1,atom:'CA'}, label:'Dimer'};
  for (const offsets of [{}, {offsetX:0}, {offsetY:0}, {offsetX:-100,offsetY:100}, {offsetX:12.5,offsetY:-8.25}]) {
    const input = lesson(); input.chapters[0].animation.tethers = [{...tether,...offsets}];
    const expected = input.chapters[0].animation.tethers;
    expect(parseMolecularLesson(input).chapters[0].animation?.tethers).toEqual(expected);
    expect(compileMolecularLesson(input).manifest.chapters[0].animation?.tethers).toEqual(expected);
    expect(molecularLessonToTour(input).steps[0].animation?.tethers).toEqual(expected);
  }
  for (const field of ['offsetX','offsetY']) for (const value of [-100.01,100.01,NaN,Infinity,-Infinity,'12',null,[]]) {
    const input = lesson(); input.chapters[0].animation.tethers = [{...tether,[field]:value}];
    expect(() => parseMolecularLesson(input)).toThrow();
    expect(() => compileMolecularLesson(input)).toThrow();
  }
});
it('carries canonical animation to the tour and refuses unsupported movie exports',()=>{
  const input=lesson(), compiled=compileMolecularLesson(input);
  expect(molecularLessonToTour(input).steps[0].animation).toEqual(compiled.manifest.chapters[0].animation);
  expect(compiled.renderMoviePlan).toBeUndefined();
  expect(()=>compileMolecularLesson(input,{target:'movie'})).toThrow(/chain-track/);
});
it('rejects measurements between moving bodies and between moving and static atoms',()=>{
  const input=lesson(), c=input.chapters[0];
  const distance={id:'distance',color:'#ffffff',a:{chain:'C',residues:{from:1,to:1},atomName:'CA'},b:{chain:'D',residues:{from:1,to:1},atomName:'CA'}};
  c.immersive.figure={layers:[{id:'layer',target:{chain:'C'},representation:'cartoon',color:'#ffffff'}],labels:[],distances:[distance]};
  expect(()=>compileMolecularLesson(input)).not.toThrow();
  distance.b.chain='A';expect(()=>compileMolecularLesson(input)).toThrow(/same moving body/);
  c.animation.tracks.push({...c.animation.tracks[0],id:'ab',chains:['A','B']});
  expect(()=>compileMolecularLesson(input)).toThrow(/same moving body/);
});
it('installs after scene work, pauses/resumes transport and resets on Next, Back and Done',async()=>{
  const h=tourEndHarness({xr:true});
  const calls:string[]=[];
  h.workspace.viewer.inspection.setVisibility=vi.fn(async()=>{});
  h.workspace.viewer.inspection.setMolecularAnimation=vi.fn(async(value:unknown)=>{calls.push(value?'install':'clear');});
  h.workspace.viewer.inspection.controlMolecularAnimation=vi.fn((value:{state:string})=>calls.push(value.state));
  const tour=molecularLessonToTour(lesson());
  const player=mountTourPlayer({...h,tours:[tour]});
  try {
    await player.select(tour.id);await player.start(false,0); expect(calls.at(-1)).toBe('install');
    player.pause();expect(calls.at(-1)).toBe('pause');
    await player.togglePlay();expect(calls.at(-1)).toBe('play');player.pause();
    await player.next();expect(calls.at(-1)).toBe('clear');
    await player.back();expect(calls.at(-1)).toBe('install');
    await player.finish();expect(calls).toContain('clear');
    expect(calls.slice(calls.lastIndexOf('install')+1)).toContain('clear');
  } finally {player.pause();h.cleanup();}
});

it('a pause during an asynchronous installation cannot start molecular time afterwards',async()=>{
  const h=tourEndHarness({xr:true}), calls:string[]=[];
  let installed!:()=>void, release!:()=>void;
  const reached=new Promise<void>(resolve=>{installed=resolve;});
  const pending=new Promise<void>(resolve=>{release=resolve;});
  h.workspace.viewer.inspection.setMolecularAnimation=async(value:unknown)=>{
    calls.push(value?'install':'clear'); if(value){installed();await pending;}
  };
  h.workspace.viewer.inspection.controlMolecularAnimation=(patch:{state:string})=>calls.push(patch.state);
  const tour=molecularLessonToTour(lesson()), player=mountTourPlayer({...h,tours:[tour]});
  try {
    await player.select(tour.id);const starting=player.start(false,0);
    const rejected=expect(starting).rejects.toThrow(/interrupted/);
    await reached;player.pause();release();await rejected;
    expect(calls.at(-1)).toBe('clear');
  } finally {release();player.pause();h.cleanup();}
});

it('chapter-owned receipts and same-source XR edits keep the installed clock and lesson playing', async () => {
  const h = tourEndHarness({xr:true});
  let state = 'paused';
  const tour = molecularLessonToTour(lesson());
  const player = mountTourPlayer({...h,tours:[tour]});
  h.workspace.viewer.inspection.setVisibility = async () => { player.notifyMutation(h.workspace.snapshot()); };
  h.workspace.viewer.inspection.setMolecularAnimation = async (value: unknown) => {
    state = value ? 'playing' : 'cleared';
    // Production inspectionMutation notifies observers before resolving.
    player.notifyMutation(h.workspace.snapshot());
  };
  h.workspace.viewer.inspection.controlMolecularAnimation = (patch: {state:string}) => { state = patch.state; };
  try {
    await player.select(tour.id); await player.start(false,0);
    expect(state).toBe('playing');
    expect(player.getState()).toMatchObject({active:true,stopped:false});
    player.notifyMutation(h.workspace.snapshot());
    expect(state).toBe('playing');
    expect(player.getState()).toMatchObject({active:true,stopped:false});
    player.notifyMutation({...h.workspace.snapshot(), sourceSha256:'replaced-source'});
    expect(state).toBe('pause');
    expect(player.getState()).toMatchObject({active:false,stopped:true});
  } finally { player.pause(); h.cleanup(); }
});

it('accepts disjoint residue selectors, component unions and hinge pivots and preserves them through compilation',()=>{
  const domain={...animation.tracks[0],chains:['C'],selector:{residues:[{from:1,to:60},{from:80,to:90}],componentIds:['HEM']},pivot:[10,-5,3]};
  const input=lesson();input.chapters[0].animation={...animation,tracks:[domain]};
  expect(compileMolecularLesson(input).manifest.chapters[0].animation?.tracks[0]).toEqual(domain);
  expect(molecularLessonToTour(input).steps[0].animation?.tracks[0]).toEqual(domain);
  const second={...domain,id:'second',selector:{residues:[{from:61,to:79}]}};
  expect(()=>molecularAnimationSchema.parse({...animation,tracks:[domain,second]})).not.toThrow();
  for(const selector of [{residues:[{from:60,to:79}]},{componentIds:['HEM']},undefined])
    expect(()=>molecularAnimationSchema.parse({...animation,tracks:[domain,{...second,selector}]})).toThrow(/Overlapping/);
  for(const selector of [{},{residues:[]},{residues:[{from:60,to:1}]},{residues:[{from:1.2,to:60}]},{componentIds:[]}])
    expect(()=>molecularAnimationSchema.parse({...animation,tracks:[{...domain,selector}]})).toThrow();
  for(const pivot of [[0,0],[0,0,Infinity]])expect(()=>molecularAnimationSchema.parse({...animation,tracks:[{...domain,pivot}]})).toThrow();
});

it('uses residue ownership for same-chain tethers and measurements',()=>{
  const track={...animation.tracks[0],chains:['C'],selector:{residues:[{from:1,to:60}]}};
  const tether={id:'hinge',from:{chain:'C',residue:30,atom:'CA'},to:{chain:'C',residue:61,atom:'CA'}};
  expect(()=>molecularAnimationSchema.parse({...animation,tracks:[track],tethers:[tether]})).not.toThrow();
  expect(()=>molecularAnimationSchema.parse({...animation,tracks:[track],tethers:[{...tether,to:{...tether.to,residue:60}}]})).toThrow(/different bodies/);
  const input=lesson();input.chapters[0].animation={...animation,tracks:[track]};
  const target=(residue:number)=>({chain:'C',residues:{from:residue,to:residue},atomName:'CA'});
  input.chapters[0].immersive.figure={layers:[{id:'layer',target:{chain:'C'},representation:'cartoon',color:'#ffffff'}],
    distances:[{id:'distance',a:target(30),b:target(61),color:'#ffffff'}]};
  expect(()=>compileMolecularLesson(input)).toThrow(/same moving body/);
  input.chapters[0].immersive.figure.distances[0].b=target(60);
  expect(()=>compileMolecularLesson(input)).not.toThrow();
});
