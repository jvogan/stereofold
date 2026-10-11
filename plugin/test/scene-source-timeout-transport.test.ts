import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { LocalSceneService } from '../src/scene-service.js';
import { GROWTH_FETCH_TIMEOUT_MS, STRUCTURE_SOURCE_DOWNLOAD_TIMEOUT_MS } from '../src/inspection-limits.js';

// Real owner discovery and attachment, then a delayed transport response to
// exercise the actual #post deadline without network or wall-clock waits.
for (const scenario of [
  { name:'grow_structure', args:{}, duration:GROWTH_FETCH_TIMEOUT_MS+20_000, deadline:240_000 },
  { name:'open', args:{pdbId:'1CRN'}, duration:STRUCTURE_SOURCE_DOWNLOAD_TIMEOUT_MS+20_000, deadline:120_000 },
  { name:'control', args:{action:'load_pdb'}, duration:STRUCTURE_SOURCE_DOWNLOAD_TIMEOUT_MS+20_000, deadline:120_000 },
  { name:'grow_structure', args:{}, duration:241_000, deadline:240_000, expires:true },
  { name:'control', args:{action:'fit'}, duration:71_000, deadline:70_000, expires:true },
]) it(`shared scene ${scenario.name} ${JSON.stringify(scenario.args)} ${scenario.expires?'expires':'completes'} within its own budget`,async()=>{
  const directory=await mkdtemp(join(tmpdir(),'stereofold-source-deadline-'));
  const file=join(directory,'scene.json');
  const owner=new LocalSceneService({file,env:{},live:id=>id==='session'});
  let measuring=false, posted=0;
  const joiner=new LocalSceneService({file,env:{},live:()=>false,fetch:async(url,init)=>{
    if(!measuring) return await fetch(url,init);
    posted++;
    return await new Promise<Response>((resolve,reject)=>{
      const signal=init!.signal!;
      const timer=setTimeout(()=>{
        signal.removeEventListener('abort',aborted);
        resolve(new Response(JSON.stringify({result:{source:'requested',receipt:'pending'}})));
      },scenario.duration);
      function aborted(){clearTimeout(timer);reject(signal.reason);}
      signal.addEventListener('abort',aborted,{once:true});
    });
  }});
  try {
    owner.noteSession('session');
    expect(await owner.offer()).toBe(true);
    expect(await joiner.share()).toMatchObject({role:'attached',sessionId:'session'});
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout','Date']});
    const deadlines:number[]=[];
    const timers:ReturnType<typeof setTimeout>[]=[];
    vi.spyOn(AbortSignal,'timeout').mockImplementation(ms=>{
      deadlines.push(ms);
      const controller=new AbortController();
      timers.push(setTimeout(()=>controller.abort(new DOMException('Source deadline','TimeoutError')),ms));
      return controller.signal;
    });
    measuring=true;
    let settled=false;
    const pending=joiner.call(scenario.name,scenario.args).then(value=>({value}),error=>({error})).finally(()=>{settled=true;});
    await vi.advanceTimersByTimeAsync(scenario.expires?scenario.deadline-1:scenario.duration-1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result=await pending;
    expect(deadlines).toEqual([scenario.deadline]);
    expect(posted,'mutations are never retried after a transport timeout').toBe(1);
    if(scenario.expires){
      expect('error' in result && result.error.message).toMatch(/lost its connection.*Source deadline/);
      expect(joiner.role).toBe('none');
    } else {
      expect(result).toEqual({value:{source:'requested',receipt:'pending'}});
      expect(joiner.role).toBe('attached');
    }
    timers.forEach(clearTimeout);
  } finally {
    vi.restoreAllMocks();vi.useRealTimers();
    await joiner.close();await owner.close();await rm(directory,{recursive:true,force:true});
  }
});
