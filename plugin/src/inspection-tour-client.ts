import { tourTransportIntent, type TourPlayer } from './tour-player.js';
export type PanelTourPlayer = Pick<TourPlayer, 'getState'|'subscribe'|'select'|'start'|'next'|'back'|'pause'|'togglePlay'|'openMenu'|'rejoin'|'restoreStart'|'finish'|'cycleTour'|'nextReadoutPage'> & {matchesLoadedSource?:boolean;closeMenu?:()=>void};
export function tourHeartbeat(player?:Pick<PanelTourPlayer,'getState'>) {
  if(!player) return undefined;
  const {selectedId,step,total,active,autoplay,narration,navigating}=player.getState();
  if (!active && step < 0 && !navigating) return {step:-1,total:0,active:false,autoplay:false,navigating:false};
  return {selectedId,step,total,active,autoplay,...(narration===undefined?{}:{narration}),navigating};
}
/**
 * Run one player action and resolve when its first scene is on screen.
 *
 * start() and togglePlay() may schedule that scene after the baseline
 * transaction. Subscribe before running so the receipt cannot precede the real
 * scene.
 */
function awaitFirstScene(player:PanelTourPlayer, tourId:string|undefined, run:()=>Promise<void>) {
  return new Promise<void>((resolve,reject)=>{
    let timer:ReturnType<typeof setTimeout>,unsubscribe=()=>{},settled=false,ran=false;
    const finish=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);unsubscribe();error?reject(error):resolve();};
    // Not `step===0`: in a headset the player plays through an opening scene
    // that would render nothing a wearer can see and starts the lesson on the
    // scene after it, so the first rendered scene is step 1. Waiting for step
    // zero there hangs for the full timeout and reports render_failed.
    const check=()=>{const s=player.getState();if(ran&&(!tourId||s.selectedId===tourId)&&s.active&&s.step>=0&&!s.navigating)finish();};
    timer=setTimeout(()=>finish(Error('The tour did not render its first scene.')),60000);
    // A player may call the listener before `subscribe` returns. `check` would
    // then settle this promise against the placeholder unsubscribe, and the
    // real one, assigned a moment later, would never run: the listener stayed
    // on the player for the rest of the session and every later scene ran a
    // dead check. Keep whichever order the player uses.
    const stop=player.subscribe(check);
    if(settled)stop();else unsubscribe=stop;
    void run().then(()=>{ran=true;check();},error=>finish(error));
  });
}
/**
 * What one applied command did, for the two words the wearer hears.
 *
 * `started` separates a transport press that opened a lesson from one that
 * stepped inside a running one: the first is confirmed as "Tour started.", the
 * same two words the wearer's own "start tour" answers with.
 */
export type AppliedTourCommand = { started:boolean };
export async function applyTourCommand(player:PanelTourPlayer|undefined, patch:{action:string;tourId?:string;autoplay?:boolean;narration?:boolean}):Promise<AppliedTourCommand|undefined> {
  if(!player) throw Error('The tour player is unavailable.');
  const before=player.getState();
  if(player.matchesLoadedSource && !before.active && !before.selectedId && ['play','next','back'].includes(patch.action)) {
    await awaitFirstScene(player,undefined,()=>player.start(patch.action==='play',patch.action==='back'?'last':undefined,{narration:before.narration}));
    return {started:true};
  }
  if(patch.action==='start') {
    if(!before.tours.some(t=>t.id===patch.tourId)) throw Error('This lesson is not available in the current panel.');
    await player.select(patch.tourId!);
    await awaitFirstScene(player,patch.tourId,()=>player.start(patch.autoplay??true,undefined,{narration:patch.narration}));
    return {started:true};
  } else if(patch.action==='next'||patch.action==='back') {
    // Next and back on an inactive tour used to be refused here
    // and answered "queued" at the agent, so two presses from an
    // unattended driver moved nothing and explained nothing. The player's own
    // rows now start the lesson in that state, and this takes the same
    // decision from the same function so the two routes cannot diverge.
    const intent=tourTransportIntent({action:patch.action,active:before.active,stopped:before.stopped,
      hasLesson:Boolean(before.selectedId??before.tours[0]?.id),step:before.step,
      canNext:before.canNext,canBack:before.canBack,navigating:before.navigating});
    if(intent.do==='none') throw Error(intent.reason??'This tour has no scene in that direction.');
    if(intent.do==='start') {
      const tourId=before.selectedId??before.tours[0]!.id;
      if(!before.selectedId) await player.select(tourId);
      await awaitFirstScene(player,tourId,()=>player.start(false,intent.startAt==='last'?'last':undefined,{narration:before.narration}));
      return {started:true};
    }
    if(intent.do==='rejoin') {
      await player.rejoin();
      const resumed=player.getState();
      if(patch.action==='next'?resumed.canNext:resumed.canBack) await player[patch.action]();
      return {started:true};
    }
    await player[patch.action]();
    const after=player.getState(),expected=before.step+(patch.action==='next'?1:-1);
    if(after.selectedId!==before.selectedId||after.step!==expected||after.navigating)throw Error('The tour action was interrupted before rendering.');
    return {started:false};
  } else if(patch.action==='play') {
    // A stopped lesson still answers play. `notifyMutation` stops a tour the
    // moment the wearer moves the structure (tour-player.ts:832), and that
    // left every later agent play refused as render_failed
    // while the wearer's own Start tour row would have restarted it
    // (tour-player.ts:699). Do what that row does.
    if(!before.active) {
      const tourId=before.selectedId??before.tours[0]?.id;
      if(!tourId) throw Error('No lesson is loaded in this panel.');
      if(before.navigating) throw Error('This tour is still rendering a scene.');
      // A lesson the wearer stopped by taking the structure still has its
      // chapter. Play there is "carry on", not "start again": rejoin puts that
      // chapter back on screen, where a restart would replay the lesson from
      // scene one and throw away everything they had already watched.
      if(before.stopped&&before.selectedId&&before.step>=0) { await player.rejoin(true); return; }
      if(!before.selectedId) await player.select(tourId);
      await awaitFirstScene(player,tourId,()=>player.togglePlay());
      return;
    }
    // Pausing on the closing scene leaves an active tour with no scene left,
    // and play was refused there outright: the lesson could only be restarted
    // from the wearer's own rows. Play on a finished lesson is a request to
    // run it again, so run it again.
    if(!before.canPlay) {
      if(before.navigating) throw Error('This tour is still rendering a scene.');
      if(!before.selectedId) throw Error('This tour has no scene left to play.');
      await awaitFirstScene(player,before.selectedId,()=>player.start(true,undefined,{narration:before.narration}));
      return;
    }
    if(!before.autoplay) await player.togglePlay();
  } else if(patch.action==='pause') player.pause('Paused by the desktop agent.');
  else if(patch.action==='menu')await player.openMenu();
  else if(patch.action==='rejoin')await player.rejoin();
  else if(patch.action==='restore-start')await player.restoreStart();
  else if(patch.action==='done')await player.finish();
  else throw Error('Unsupported tour action.');
}

/** The menu, remote controls and heartbeat retain one active controller. */
export function createPanelTourController(lesson:PanelTourPlayer, experience:PanelTourPlayer) {
  let owner=experience;
  const listeners=new Set<()=>void>();
  const emit=()=>{for(const listener of listeners)listener();};
  const stops=[lesson,experience].map(player=>player.subscribe(()=>{
    // Also follow starts from either desktop player's own buttons.
    if(player!==owner && player.getState().active && !owner.getState().active) owner=player;
    if(player===owner)emit();
  }));
  const controller:PanelTourPlayer={
    get matchesLoadedSource(){return owner===experience;},
    getState:()=>({...owner.getState(),tours:[...lesson.getState().tours,...experience.getState().tours]}),
    subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);},
    async select(id){
      const target=experience.getState().tours.some(t=>t.id===id)?experience:lesson;
      if(!target.getState().tours.some(t=>t.id===id))throw Error('This lesson is not available in the current panel.');
      if(target!==owner && owner.getState().active)throw Error('Use Done to restore your view before choosing another kind of tour.');
      owner.pause();owner=target;await owner.select(id);emit();
    },
    start:(...args)=>owner.start(...args),next:()=>owner.next(),back:()=>owner.back(),pause:reason=>owner.pause(reason),
    togglePlay:()=>owner.togglePlay(),openMenu:()=>owner.openMenu(),closeMenu:()=>owner.closeMenu?.(),rejoin:(...args)=>owner.rejoin(...args),
    restoreStart:()=>owner.restoreStart(),finish:(...args)=>owner.finish(...args),
    cycleTour:(...args)=>owner.cycleTour(...args),nextReadoutPage:()=>owner.nextReadoutPage(),
  };
  return Object.assign(controller,{
    current:()=>owner,
    setDefault(custom:boolean){if(!owner.getState().active && !owner.getState().navigating && !owner.getState().menuOpen){owner=custom?lesson:experience;emit();}},
    dispose(){stops.forEach(stop=>stop());listeners.clear();},
  });
}
