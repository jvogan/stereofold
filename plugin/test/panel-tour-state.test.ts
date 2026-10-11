import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { mountExperiencePlayer, type ExperiencePlayer } from '../src/experience-player.js';
import { mountTourPlayer } from '../src/tour-player.js';
import { TOURS } from '../src/tour-catalog.js';
import { MOLECULAR_EXPERIENCES, stageForStep } from '../src/molecular-experience.js';
import { applyTourCommand, createPanelTourController, tourHeartbeat } from '../src/inspection-tour-client.js';
import { createPanelNarrator, narrationLines } from '../src/panel-narration.js';
import { registerInspectionVoiceTools } from '../src/inspection-voice.js';
// @ts-ignore Real workspace and Done closures, with DOM/draw adapters.
import { tourEndHarness } from '../../lab/browser-roundtrip/fixtures/tour-end-harness.mjs';

it('a rendered authored lesson exposes its controls, and a plain source returns to experiences',async()=>{
  const h=tourEndHarness();
  const create=document.createElement.bind(document);
  document.createElement=((...args:any[])=>Object.assign(create(args[0]),{querySelectorAll:()=>[],remove(){}})) as any;
  document.removeEventListener=()=>{};
  const lesson=mountTourPlayer({...h,tours:TOURS});
  const experience=mountExperiencePlayer({after:h.after,explore(){},finish:async()=>({status:'rendered'}),navigate:async()=>{}});
  const panel=createPanelTourController(lesson,experience);
  // Run the actual hydration's final player reconciliation with both mounted
  // renderers. The previous code chose the owner while rendering=true, so the
  // controller refused that switch and hid this lesson's manual controls.
  const source=readFileSync(new URL('../src/inspector.ts',import.meta.url),'utf8');
  const start=source.indexOf('  experiencePlayer?.update(experienceView);\n',source.indexOf('async function hydrate('));
  const finalPlayers=source.slice(start,source.indexOf('  if(mapDrawFailure)',start));
  const settle=(custom:boolean)=>vm.runInNewContext(ts.transpileModule(finalPlayers,{
    compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,
    {experiencePlayer:experience,experienceView:undefined,panelTour:panel,defaultToLesson:custom});
  try {
    experience.setRendering(true);
    await lesson.select(TOURS[0]!.id);
    panel.setDefault(true);
    expect(panel.current()).toBe(experience);
    experience.setRendering(false);settle(true);
    expect(panel.current()).toBe(lesson);
    expect(panel.getState().selectedId).toBe(TOURS[0]!.id);
    await panel.start(false);
    expect(tourHeartbeat(panel)).toMatchObject({active:true,step:0});
    await panel.next();expect(tourHeartbeat(panel)?.step).toBe(1);
    await panel.back();expect(tourHeartbeat(panel)?.step).toBe(0);
    await lesson.replaceTours(TOURS);settle(false);
    expect(panel.current()).toBe(experience);
  } finally {panel.pause();panel.dispose();experience.dispose();h.cleanup();}
});

for(const modelStart of [false,true,'play'])it(`one controller reports and transports a rendered journey (model start ${modelStart})`,async()=>{
  const h=tourEndHarness();
  const create=document.createElement.bind(document);
  document.createElement=((...args:any[])=>Object.assign(create(args[0]),{querySelectorAll:()=>[],remove(){}})) as any;
  document.removeEventListener=()=>{};
  let experience:ExperiencePlayer;
  const definition=MOLECULAR_EXPERIENCES.find(item=>item.id==='hemoglobin-quaternary-structure')!;
  const narrate=vi.fn();
  const finish=vi.fn(async()=>({status:'rendered' as const}));
  const lesson=mountTourPlayer({...h,tours:TOURS});
  experience=mountExperiencePlayer({after:h.after,explore(){},finish,narrate,navigate:async(id,stepIndex)=>{
    expect(id).toBe(definition.id);
    experience.update({definition,stepIndex,revision:stepIndex+1,stageId:stageForStep(definition,stepIndex).id,sourceKey:'rendered'});
  }});
  experience.setCatalog([{id:definition.id,title:definition.title,steps:20,sources:[{pdbId:'4HHB',assemblyId:'asymmetric_unit',stepIndex:0}]}]);
  experience.setSubject({pdbId:'4HHB',assembly:'asymmetric_unit'});
  const panel=createPanelTourController(lesson,experience);
  try{
    if(modelStart==='play')await applyTourCommand(panel,{action:'play'});
    else if(modelStart)await applyTourCommand(panel,{action:'start',tourId:definition.id});
    else await panel.togglePlay();
    expect(tourHeartbeat(panel)).toMatchObject({selectedId:definition.id,active:true,autoplay:true,step:0,total:20,navigating:false});
    expect(narrate).toHaveBeenCalledWith(definition.steps[0]!.body);
    await applyTourCommand(panel,{action:'pause'});
    await applyTourCommand(panel,{action:'next'});expect(tourHeartbeat(panel)?.step).toBe(1);
    await panel.back();expect(tourHeartbeat(panel)?.step).toBe(0);
    let release!:(value:{status:'rendered'})=>void;
    finish.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
    const done=applyTourCommand(panel,{action:'done'});
    expect(tourHeartbeat(panel)).toMatchObject({active:true,autoplay:false,navigating:true});
    release({status:'rendered'});await done;
    expect(tourHeartbeat(panel)).toMatchObject({active:false,autoplay:false,step:-1,total:0});
  }finally{panel.pause();panel.dispose();experience.dispose();h.cleanup();}
});

it('autoplay narration posts only valid bounded lines to the unchanged host voice handler',async()=>{
  const handlers=new Map<string,(input:any)=>Promise<any>>();
  const requests:any[]=[];
  const binding={sessionId:crypto.randomUUID(),serverEpoch:crypto.randomUUID(),sourceToken:crypto.randomUUID(),
    baseStateRevision:1,baseInspectionRevision:1,panelId:crypto.randomUUID()};
  registerInspectionVoiceTools(((name:any,_config:any,handle:any)=>handlers.set(name,handle)) as any,{
    validate:async()=>{},validateNarration:async()=>{},acknowledge:async()=>({wavBase64:'AAAA'}),
  });
  const speak=createPanelNarrator({speak:async message=>{
    const input={...binding,message};requests.push(input);
    await handlers.get('stereo_structure.voice_acknowledgement')!(input);
  }});
  // A raw chapter exceeds the endpoint's explicit 180-character / one-line limit.
  const chapter=TOURS[0]!.steps[0]!.body!;
  await expect(handlers.get('stereo_structure.voice_acknowledgement')!({...binding,message:chapter})).rejects.toThrow();
  for(const step of TOURS[0]!.steps)await speak(step.body!);
  expect(requests.length).toBeGreaterThan(20);
  expect(requests.every(request=>request.message.length<=180 && !/[\0\r\n]/.test(request.message))).toBe(true);
  expect(requests.map(request=>request.message).join(' ')).toBe(TOURS[0]!.steps.map(step=>step.body!.replace(/\s+/g,' ').trim()).join(' '));
  // Burst requests still respect the host's concurrent-speech refusal.
  await Promise.all(Array.from({length:10},()=>speak('Next chapter.')));
});

it('drops a superseded chapter before its next HTTP request and preserves refusal sentences',async()=>{
  let release!:()=>void,stale=false;
  const sent:string[]=[];
  const speak=createPanelNarrator({speak:async line=>{sent.push(line);await new Promise<void>(resolve=>{release=resolve;});}});
  const pending=speak('chapter '.repeat(70),{stale:()=>stale});
  await Promise.resolve();await Promise.resolve();stale=true;release();await pending;
  expect(sent).toHaveLength(1);
  const reason='The spoken line belongs to a replaced source. Read get_inspection_state.';
  const refused=createPanelNarrator({speak:async()=>{throw Object.assign(Error(reason),{status:409});}});
  await expect(refused('Chapter')).rejects.toMatchObject({message:reason,status:409});
  expect(narrationLines('word '.repeat(50)).join(' ')).toBe('word '.repeat(50).trim());
});

it('prepares a new chapter without waiting for the previous audio to finish',async()=>{
  let release!:()=>void,started!:()=>void;
  const playing=new Promise<void>(resolve=>{started=resolve;});
  const prepared:string[]=[];
  const narrator=createPanelNarrator({prepare:async line=>{
    prepared.push(line);
    return async()=>{if(line==='Old chapter'){started();await new Promise<void>(resolve=>{release=resolve;});}};
  }});
  const old=narrator('Old chapter');await playing;
  await narrator('New chapter');
  expect(prepared).toEqual(['Old chapter','New chapter']);
  release();await old;
});
