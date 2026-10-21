import {describe,it,expect,vi} from 'vitest';
import {applyTourCommand,tourHeartbeat} from '../src/inspection-tour-client.js';
import {tourActionSchema,tourStateSchema,inspectionChangeSchema,matchesInspectionChange} from '../src/inspection-contract.js';
import {TOURS} from '../src/tour-catalog.js';
function player(){
  const listeners=new Set<()=>void>();
  const state:any={tours:[{id:TOURS[0].id}],step:-1,total:20,active:false,autoplay:false,navigating:false,canNext:true,canBack:false,canPlay:true};
  const p:any={getState:()=>({...state}),select:async(id:string)=>{state.selectedId=id;},
    start:async()=>{setTimeout(()=>{state.step=0;state.active=true;for(const l of listeners)l();},10);},
    next:async()=>{state.step++;},back:async()=>{state.step--;},
    togglePlay:async()=>{state.autoplay=!state.autoplay;},pause:()=>{state.autoplay=false;},openMenu:async()=>{state.active=false;},
    subscribe:(fn:()=>void)=>{listeners.add(fn);return()=>listeners.delete(fn);}};
  return {p,state};
}
describe('agent tour commands',()=>{
  it('starts an untouched selected lesson without an intermediate reset, but resets a restart',async()=>{
    const {p,state}=player(); state.selectedId=TOURS[0].id;
    p.select=vi.fn(p.select);
    await applyTourCommand(p,{action:'start',tourId:TOURS[0].id,narration:false});
    expect(p.select).not.toHaveBeenCalled();
    await applyTourCommand(p,{action:'start',tourId:TOURS[0].id,narration:false});
    expect(p.select).toHaveBeenCalledOnce();
  });
  it('admits bounded lesson IDs and action-specific arguments',()=>{
    expect(tourActionSchema.safeParse({action:'start',tourId:TOURS[0].id}).success).toBe(true);
    expect(tourActionSchema.parse({action:'start',tourId:TOURS[0].id,autoplay:false}).autoplay).toBe(false);
    expect(tourActionSchema.parse({action:'start',tourId:TOURS[0].id,narration:false}).narration).toBe(false);
    for(const invalid of [{action:'start'},{action:'start',tourId:'../invalid'},{action:'next',tourId:TOURS[0].id},{action:'next',autoplay:false},{action:'start',tourId:TOURS[0].id,autoplay:'false'},{action:'next',narration:false},{action:'start',tourId:TOURS[0].id,narration:'false'}])expect(tourActionSchema.safeParse(invalid).success).toBe(false);
    expect(inspectionChangeSchema.safeParse({kind:'tour',patch:{action:'pause'}}).success).toBe(true);
  });
  it('rejects a valid but unavailable lesson ID before starting',async()=>{
    const {p}=player();
    await expect(applyTourCommand(p,{action:'start',tourId:'not-loaded'})).rejects.toThrow('not available');
  });
  it('awaits restoration and rejoin draw promises',async()=>{
    const {p}=player();let finish!:()=>void;
    p.rejoin=()=>new Promise<void>(resolve=>{finish=resolve;});
    let settled=false;const pending=applyTourCommand(p,{action:'rejoin'}).then(()=>{settled=true;});
    await Promise.resolve();expect(settled).toBe(false);finish();await pending;expect(settled).toBe(true);
    p.restoreStart=vi.fn(async()=>{throw Error('source changed');});
    await expect(applyTourCommand(p,{action:'restore-start'})).rejects.toThrow('source changed');
  });
  it('waits for the first real scene after baseline capture',async()=>{
    const {p,state}=player();let settled=false;
    const command=applyTourCommand(p,{action:'start',tourId:TOURS[0].id}).then(()=>settled=true);
    await Promise.resolve();expect(settled).toBe(false);await command;expect(state.step).toBe(0);
  });
  for(const autoplay of [undefined,false,true]) it(`starts a named lesson with autoplay=${autoplay}`,async()=>{
    const {p,state}=player();
    const start=p.start;
    p.start=vi.fn(async(value:boolean)=>{state.autoplay=value;await start();});
    await applyTourCommand(p,{action:'start',tourId:TOURS[0].id,...(autoplay===undefined?{}:{autoplay})});
    expect(p.start).toHaveBeenCalledWith(autoplay??true,undefined,{narration:undefined});
    expect(state).toMatchObject({selectedId:TOURS[0].id,active:true,step:0,autoplay:autoplay??true});
  });
  it.each([undefined,false,true])('passes narration=%s only on a fresh named start',async narration=>{
    const {p,state}=player();state.narration=false;
    const start=p.start;p.start=vi.fn(start);
    await applyTourCommand(p,{action:'start',tourId:TOURS[0].id,narration});
    expect(p.start).toHaveBeenCalledWith(true,undefined,{narration});
  });
  it('accepts a headset start that skipped a silent opening scene',async()=>{
    // In XR the player plays through an opening scene that would change nothing
    // a wearer can see, so the first rendered scene is step 1, not step 0.
    const {p,state}=player();
    const listeners=new Set<()=>void>();
    p.subscribe=(fn:()=>void)=>{listeners.add(fn);return()=>listeners.delete(fn);};
    p.start=async()=>{setTimeout(()=>{state.step=1;state.active=true;for(const l of listeners)l();},10);};
    await applyTourCommand(p,{action:'start',tourId:TOURS[0].id});
    expect(state.step).toBe(1);
  });
  it('rejects interrupted navigation instead of confirming an unchanged scene',async()=>{
    const {p,state}=player();Object.assign(state,{active:true,step:2});p.next=vi.fn(async()=>{});
    await expect(applyTourCommand(p,{action:'next'})).rejects.toThrow('interrupted');
  });
  it('makes play idempotent and reports only bounded tour state',async()=>{
    const {p,state}=player();Object.assign(state,{active:true,step:0});
    await applyTourCommand(p,{action:'play'});await applyTourCommand(p,{action:'play'});expect(state.autoplay).toBe(true);
    await applyTourCommand(p,{action:'pause'});expect(tourHeartbeat(p)?.autoplay).toBe(false);
    expect(tourHeartbeat(p)).not.toHaveProperty('tours');
  });
  it('reports the narration choice without exposing the saved baseline and accepts older heartbeats',()=>{
    const {p,state}=player();Object.assign(state,{active:true,step:0,narration:false,startingScene:{private:'baseline'}});
    const heartbeat=tourHeartbeat(p);
    expect(tourStateSchema.parse(heartbeat).narration).toBe(false);
    expect(heartbeat).not.toHaveProperty('startingScene');
    delete state.narration;
    expect(tourStateSchema.parse(tourHeartbeat(p))).not.toHaveProperty('narration');
  });
  it('starts the lesson when next arrives with no tour running, instead of refusing it',async()=>{
    // `control_tour back` and `next` used to answer "queued" and move nothing
    // while no lesson was active, so hitting tour looked like it did nothing.
    // Next with nothing playing is a request for the lesson.
    const {p,state}=player();
    const applied=await applyTourCommand(p,{action:'next'});
    expect(state.active).toBe(true);
    expect(state.step).toBe(0);
    expect(applied).toMatchObject({started:true});
  });
  it('starts a lesson at its last chapter when back arrives with no tour running',async()=>{
    const {p,state}=player();
    const listeners=new Set<()=>void>();
    p.subscribe=(fn:()=>void)=>{listeners.add(fn);return()=>listeners.delete(fn);};
    const started=vi.fn(async(_autoStart?:boolean,startAt?:number|'last')=>{
      setTimeout(()=>{state.step=startAt==='last'?5:0;state.active=true;for(const l of listeners)l();},10);
    });
    p.start=started;
    const applied=await applyTourCommand(p,{action:'back'});
    expect(started.mock.calls[0]?.[1]).toBe('last');
    expect(state.step).toBe(5);
    expect(applied).toMatchObject({started:true});
  });
  it('rejoins a stopped chapter and then steps, rather than replaying the lesson',async()=>{
    const {p,state}=player();
    Object.assign(state,{selectedId:TOURS[0].id,step:4,active:false,stopped:true,canNext:false,canBack:false});
    p.start=vi.fn(async()=>{});
    p.rejoin=vi.fn(async()=>{Object.assign(state,{active:true,stopped:false,canNext:true,canBack:true});});
    const applied=await applyTourCommand(p,{action:'next'});
    expect(p.rejoin).toHaveBeenCalledTimes(1);
    expect(p.start).not.toHaveBeenCalled();
    expect(state.step).toBe(5);
    expect(applied).toMatchObject({started:true});
  });
  it('reports a move as a move, so only a start is confirmed as one',async()=>{
    const {p,state}=player();Object.assign(state,{active:true,step:2,canNext:true});
    expect(await applyTourCommand(p,{action:'next'})).toMatchObject({started:false});
  });
  it('rejoins the chapter a workspace takeover stopped instead of replaying the lesson',async()=>{
    // On Quest 2 the wearer moved the structure, `notifyMutation`
    // recorded `interrupted / workspace-takeover`, and every later
    // `control_tour play` was refused. Play must answer that state — but with
    // the chapter the wearer stopped in, not scene one of the lesson.
    const {p,state}=player();
    Object.assign(state,{selectedId:TOURS[0].id,step:4,active:false,stopped:true,canPlay:false});
    const restarted=vi.fn(async()=>{});
    p.togglePlay=restarted;p.start=restarted;
    p.rejoin=vi.fn(async()=>{Object.assign(state,{active:true,stopped:false});});
    await applyTourCommand(p,{action:'play'});
    expect(p.rejoin).toHaveBeenCalledTimes(1);
    expect(restarted).not.toHaveBeenCalled();
    expect(state.step).toBe(4);
    expect(state.active).toBe(true);
  });
  it('restarts a stopped lesson that never reached a scene',async()=>{
    // `Starting view restored` stops the tour with no chapter behind it, and
    // there is nothing to rejoin. That is the one stopped state play restarts.
    const {p,state}=player();
    Object.assign(state,{selectedId:TOURS[0].id,step:-1,active:false,stopped:true,canPlay:true});
    const listeners=new Set<()=>void>();
    p.subscribe=(fn:()=>void)=>{listeners.add(fn);return()=>listeners.delete(fn);};
    p.rejoin=vi.fn(async()=>{});
    p.togglePlay=async()=>{Object.assign(state,{step:0,active:true,stopped:false,autoplay:true});for(const l of listeners)l();};
    await applyTourCommand(p,{action:'play'});
    expect(p.rejoin).not.toHaveBeenCalled();
    expect(state.active).toBe(true);
    expect(state.autoplay).toBe(true);
  });
  it('restarts a finished lesson rather than refusing play on its closing scene',async()=>{
    // Pause on the last scene, then play: the tour is still active and
    // `canPlay` is false, and the agent's play came back "no scene left" with
    // no way to run the lesson again without the wearer's own rows.
    const {p,state}=player();
    Object.assign(state,{selectedId:TOURS[0].id,step:19,total:20,active:true,autoplay:false,narration:false,canPlay:false});
    const listeners=new Set<()=>void>();
    p.subscribe=(fn:()=>void)=>{listeners.add(fn);return()=>listeners.delete(fn);};
    p.start=vi.fn(async()=>{Object.assign(state,{step:0,active:true});for(const l of listeners)l();});
    await applyTourCommand(p,{action:'play'});
    expect(p.start).toHaveBeenCalledTimes(1);
    expect(p.start).toHaveBeenCalledWith(true,undefined,{narration:false});
    expect(state.step).toBe(0);
  });
  it('drops its scene listener when the player answers inside subscribe',async()=>{
    // A player that calls the listener before `subscribe` returns settled the
    // promise against the placeholder unsubscribe, and the real one, assigned
    // afterwards, never ran: one dead listener per agent tour command.
    const {p,state}=player();
    const listeners=new Set<()=>void>();
    p.subscribe=(fn:()=>void)=>{listeners.add(fn);fn();return()=>listeners.delete(fn);};
    Object.assign(state,{step:0,active:true});
    p.start=async()=>{};
    await applyTourCommand(p,{action:'start',tourId:TOURS[0].id});
    expect(listeners.size).toBe(0);
  });
  it('selects the first lesson when play arrives with none chosen',async()=>{
    const {p,state}=player();
    Object.assign(state,{selectedId:undefined,step:-1,active:false,canPlay:false});
    const listeners=new Set<()=>void>();
    p.subscribe=(fn:()=>void)=>{listeners.add(fn);return()=>listeners.delete(fn);};
    p.togglePlay=async()=>{Object.assign(state,{step:0,active:true,autoplay:true});for(const l of listeners)l();};
    await applyTourCommand(p,{action:'play'});
    expect(state.selectedId).toBe(TOURS[0].id);
    expect(state.active).toBe(true);
  });
  it('names why play cannot run instead of failing to render',async()=>{
    const {p,state}=player();
    Object.assign(state,{tours:[],selectedId:undefined,active:false,canPlay:false});
    await expect(applyTourCommand(p,{action:'play'})).rejects.toThrow('No lesson is loaded');
    Object.assign(state,{tours:[{id:TOURS[0].id}],selectedId:TOURS[0].id,active:false,navigating:true});
    await expect(applyTourCommand(p,{action:'play'})).rejects.toThrow('still rendering');
  });
  it('never permits a tour receipt to substitute a source, model or assembly',()=>{
    const s:any={sourceSha256:'a',modelNumber:1,assemblyId:'1'};const change:any={kind:'tour',patch:{action:'next'}};
    expect(matchesInspectionChange(s,s,change)).toBe(true);
    for(const patch of [{sourceSha256:'b'},{modelNumber:2},{assemblyId:'2'}])expect(matchesInspectionChange({...s,...patch},s,change)).toBe(false);
  });
});
