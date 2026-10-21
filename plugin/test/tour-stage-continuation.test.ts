import {expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {mountTourPlayer,grownTierIntent,type Tour,type StageContinuationIntent} from '../src/tour-player.js';
// @ts-ignore DOM/drawing adapters around the production player.
import {tourEndHarness} from '../../lab/browser-roundtrip/fixtures/tour-end-harness.mjs';

const batch=(id:string,next?:string):Tour=>({id,title:id,summary:'',
  presentation:{captionCard:'hidden',end:'hold',coordinateFrame:'shared-v1',...(next?{continueToStage:next}:{})},
  steps:[0,1].map(i=>({id:`${id}-${i}`,title:`${id} ${i}`,body:'',durationMs:1000,motion:'hold',appearance:{opacity:0}}))});
function setup(continuation:(stage:string,intent:StageContinuationIntent)=>Promise<unknown>) {
  vi.useFakeTimers();const h=tourEndHarness({xr:true});let held=false,source='same';
  const snapshot=h.workspace.snapshot;h.workspace.snapshot=()=>({...snapshot(),sourceSha256:source,interactionActive:held});
  h.workspace.viewer.inspection.supportsConcurrentPlayback=true;
  const player=mountTourPlayer({...h,tours:[batch('first','batch-01')],continueStage:continuation});
  return {h,player,hold:(v:boolean)=>{held=v;},source:(v:string)=>{source=v;},
    start:()=>player.installLesson(batch('first','batch-01'),{chapterId:'first-1',autoplay:true,narration:false}),
    close(){player.pause();h.cleanup();vi.useRealTimers();}};
}

it('continues once after the last dwell and carries the requested autoplay into the next batch',async()=>{
  const source=readFileSync(new URL('../src/inspector.ts',import.meta.url),'utf8');
  const begin=source.indexOf('async function openGrownTier('),end=source.indexOf('\n}',begin)+2;
  let s:ReturnType<typeof setup>;const continuation=vi.fn(async(stage,intent:StageContinuationIntent)=>{
    expect(stage).toBe('batch-01');expect(intent.isCurrent()).toBe(true);intent.beginTransition();
    s.player.stop('Hydrating',{restoreResting:false,preserveContinuation:true});
    const next=batch('second');
    await s.player.replaceTours([next],{preserveContinuation:true});
    await s.player.select(next.id,{preserveContinuation:true});
    const context=vm.createContext({workspace:s.h.workspace,tourPlayer:s.player,grownTierIntent,recordHeadsetEvent(){},thrownErrorMessage:String});
    vm.runInContext(ts.transpileModule(source.slice(begin,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
    await context.openGrownTier(next,true,intent.shouldAutoplay(),false,false);
  });s=setup(continuation);
  try{await s.start();await vi.advanceTimersByTimeAsync(999);expect(continuation).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);expect(continuation).toHaveBeenCalledTimes(1);
    expect(s.player.getState()).toMatchObject({selectedId:'second',step:0,autoplay:true});
    expect(s.player.getState().narration).toBe(false);
    await vi.advanceTimersByTimeAsync(999);expect(s.player.getState().step).toBe(0);
    await vi.advanceTimersByTimeAsync(1);expect(s.player.getState().step).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);expect(s.player.getState().autoplay).toBe(false);
    expect(continuation).toHaveBeenCalledTimes(1);
  }finally{s.close();}
});

it('waits across a held batch boundary and automatically continues on release; Pause cancels the wait',async()=>{
  const continuation=vi.fn(async()=>{throw Error('fixture finished');});const s=setup(continuation);
  try{await s.start();s.hold(true);await vi.advanceTimersByTimeAsync(3000);
    expect(s.player.getState()).toMatchObject({step:1,autoplay:true});expect(continuation).not.toHaveBeenCalled();
    s.player.pause();s.hold(false);await vi.advanceTimersByTimeAsync(3000);expect(continuation).not.toHaveBeenCalled();
    await s.player.togglePlay();s.hold(true);await vi.advanceTimersByTimeAsync(1000);
    s.hold(false);await vi.advanceTimersByTimeAsync(250);expect(continuation).toHaveBeenCalledTimes(1);
  }finally{s.close();}
});

it('does not re-arm a failed continuation until explicit Play',async()=>{
  const continuation=vi.fn(async()=>{throw Error('next coordinates unavailable');});const s=setup(continuation);
  try{await s.start();await vi.advanceTimersByTimeAsync(1000);
    expect(s.player.getState()).toMatchObject({step:1,autoplay:false});expect(s.player.getState().feedback).toContain('Press Play to retry');
    await vi.advanceTimersByTimeAsync(60000);expect(continuation).toHaveBeenCalledTimes(1);
    await s.player.togglePlay();await vi.advanceTimersByTimeAsync(1000);expect(continuation).toHaveBeenCalledTimes(2);
  }finally{s.close();}
});

it('keeps Pause authoritative while an admitted batch transition loads',async()=>{
  let intent:StageContinuationIntent|undefined,done!:()=>void;
  const s=setup(async(_stage,next)=>{intent=next;next.beginTransition();await new Promise<void>(resolve=>{done=resolve;});});
  try{await s.start();await vi.advanceTimersByTimeAsync(1000);expect(intent!.shouldAutoplay()).toBe(true);
    s.player.stop('Hydrating',{preserveContinuation:true});expect(intent!.shouldAutoplay()).toBe(true);
    s.player.pause();expect(intent!.shouldAutoplay()).toBe(false);done();await vi.advanceTimersByTimeAsync(0);
    expect(s.player.getState().autoplay).toBe(false);
  }finally{s.close();}
});

it.each(['source','chapter'] as const)('invalidates an unadmitted continuation after %s replacement',async(kind)=>{
  let intent:StageContinuationIntent|undefined,done!:()=>void;
  const s=setup(async(_stage,next)=>{intent=next;await new Promise<void>(resolve=>{done=resolve;});});
  try{await s.start();await vi.advanceTimersByTimeAsync(1000);expect(intent!.isCurrent()).toBe(true);
    if(kind==='source')s.source('other');else await s.player.back();
    expect(intent!.isCurrent()).toBe(false);done();await vi.advanceTimersByTimeAsync(0);
  }finally{s.close();}
});

it.each(['source','selection','chapter'] as const)('an admitted continuation cannot resume after unrelated %s replacement',async(kind)=>{
  let intent:StageContinuationIntent|undefined,done!:()=>void;
  const s=setup(async(_stage,next)=>{intent=next;next.beginTransition();await new Promise<void>(resolve=>{done=resolve;});});
  try{await s.start();await vi.advanceTimersByTimeAsync(1000);expect(intent!.shouldAutoplay()).toBe(true);
    if(kind==='source'){s.source('other');s.player.notifyMutation({...s.h.workspace.snapshot(),sourceSha256:'other'});}
    else if(kind==='selection')await s.player.select('first');else await s.player.back();
    expect(intent!.shouldAutoplay()).toBe(false);done();await vi.advanceTimersByTimeAsync(0);
  }finally{s.close();}
});

it('retries only the specific race where a grip starts before queued grow admission',async()=>{
  const continuation=vi.fn(async()=>{if(continuation.mock.calls.length===1)throw Object.assign(Error('held'),{code:'continuation_deferred'});
    throw Error('fixture finished');});const s=setup(continuation);
  try{await s.start();await vi.advanceTimersByTimeAsync(1000);expect(s.player.getState().autoplay).toBe(true);
    await vi.advanceTimersByTimeAsync(250);expect(continuation).toHaveBeenCalledTimes(2);expect(s.player.getState().autoplay).toBe(false);
  }finally{s.close();}
});

it('re-arms Play while a cancelled continuation is still settling',async()=>{
  let release!:()=>void;
  const continuation=vi.fn(async()=>{
    if(continuation.mock.calls.length===1)await new Promise<void>(resolve=>{release=resolve;});
    else throw Error('fixture finished');
  });const s=setup(continuation);
  try{await s.start();await vi.advanceTimersByTimeAsync(1000);expect(continuation).toHaveBeenCalledTimes(1);
    s.player.pause();await s.player.togglePlay();await vi.advanceTimersByTimeAsync(1500);
    expect(s.player.getState().autoplay).toBe(true);expect(continuation).toHaveBeenCalledTimes(1);
    release();await vi.advanceTimersByTimeAsync(250);expect(continuation).toHaveBeenCalledTimes(2);
    expect(s.player.getState().autoplay).toBe(false);
  }finally{s.close();}
});

it('binds a same-source installed lesson frame before its rendered acknowledgement',async()=>{
  const s=setup(async()=>{});const bind=vi.fn();
  s.h.workspace.viewer.inspection.setSourceCoordinateFrame=bind;
  try{await s.player.installLesson(batch('extended','batch-01'),{autoplay:false,narration:false},async()=>{
    expect(bind).toHaveBeenLastCalledWith('shared-v1','same');
  });
    await s.player.installLesson({...batch('plain'),presentation:{captionCard:'hidden'}},{autoplay:false,narration:false});
    expect(bind).toHaveBeenLastCalledWith(undefined,'same');
  }finally{s.close();}
});
