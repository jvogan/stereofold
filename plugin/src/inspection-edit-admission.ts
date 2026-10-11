import type { InspectionBinding } from './inspection-commands.js';

/** Serialize only admission of ordinary, implicitly bound agent edits. The
 * answer may return immediately, but its lane stays held through the receipt.
 * null is a broken ownership fence: queued successors must not guess a base. */
export class InspectionEditAdmission {
  private lanes=new Map<string,{tail:Promise<InspectionBinding|null>;count:number}>();
  private shutdown=new AbortController();
  constructor(private waitMs=40_000,private capacity=32) {}
  close() { this.shutdown.abort(new Error('Inspection edit admission closed.')); }
  enqueue<T>(sessionId:string,run:(previous:InspectionBinding|null|undefined,publish:(answer:T)=>void,signal:AbortSignal,reject:(error:unknown)=>void)=>Promise<InspectionBinding|null>,signal?:AbortSignal):Promise<T> {
    if(this.shutdown.signal.aborted) return Promise.reject(this.shutdown.signal.reason);
    let lane=this.lanes.get(sessionId);
    if(lane && lane.count>=this.capacity) return Promise.reject(Error('Too many inspection edits are waiting. Read get_inspection_state.'));
    const predecessor=lane?.tail;
    let finish!:(binding:InspectionBinding|null)=>void;
    const tail=new Promise<InspectionBinding|null>(resolve=>{finish=resolve;});
    if(!lane) {lane={tail,count:0};this.lanes.set(sessionId,lane);}
    lane.tail=tail;lane.count++;
    const owner=lane;
    const deadline=new AbortController();
    const timer=setTimeout(()=>deadline.abort(Error('The inspection edit waited too long. Read get_inspection_state.')),this.waitMs);
    const active=AbortSignal.any([this.shutdown.signal,deadline.signal,...(signal?[signal]:[])]);
    return new Promise<T>((resolve,reject)=>{
      let settled=false;
      const publish=(answer:T)=>{if(!settled){settled=true;resolve(answer);}};
      const fail=(error:unknown)=>{if(!settled){settled=true;reject(error);}};
      const abort=()=>fail(active.reason);
      active.addEventListener('abort',abort,{once:true});
      const cleanup=new AbortController();
      const stopped=new Promise<never>((_resolve,fail)=>{
        if(active.aborted)fail(active.reason);
        else active.addEventListener('abort',()=>fail(active.reason),{once:true,signal:cleanup.signal});
      });
      void (async()=>{
        let fence:InspectionBinding|null=null,started=false;
        try {
          const previous=await Promise.race([predecessor??Promise.resolve(undefined),stopped]);
          active.throwIfAborted();
          if(previous===null)throw Error('The previous inspection edit did not settle. Read get_inspection_state.');
          started=true;
          fence=await Promise.race([run(previous,publish,active,fail),stopped]);
        } catch(error) {if(!settled){settled=true;reject(error);}}
        finally {
          cleanup.abort();active.removeEventListener('abort',abort);clearTimeout(timer);
          // An unstarted cancelled waiter still links successors to the live
          // predecessor; it cannot open a second lane or poison its result.
          if(!started && predecessor)fence=await predecessor;
          finish(fence);owner.count--;
          if(owner.count===0 && this.lanes.get(sessionId)===owner)this.lanes.delete(sessionId);
        }
      })();
    });
  }
}
