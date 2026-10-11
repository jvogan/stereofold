export type SceneHistory = { undoCount:number; redoCount:number; canUndo:boolean; canRedo:boolean };
type Binding = { sessionId:string; serverEpoch:string; sourceToken:string; stateRevision:number; inspectionRevision:number };
type ViewState = {ready:boolean;interactionActive?:boolean};
type Context = { binding?:Binding; panelId?:string; generation:number; ready:boolean; loading:boolean; dirty:boolean;
  blocked:boolean; closed:boolean; remote:boolean; interactionActive:boolean; pending:boolean };
const empty:SceneHistory = {undoCount:0,redoCount:0,canUndo:false,canRedo:false};
const sameSource = (a:Binding|undefined,b:Binding|undefined) => !!a && !!b && a.sessionId===b.sessionId
  && a.serverEpoch===b.serverEpoch && a.sourceToken===b.sourceToken;

/** Shared history is a host command. Its drawing remains on normal polling. */
export function createSceneHistoryClient(options:{context:(view?:ViewState)=>Context; flush:()=>Promise<unknown>;
  call:(name:string,args:Record<string,unknown>)=>Promise<any>; changed:()=>void; commandId:()=>string}) {
  let current: {binding:Binding; history:SceneHistory; order:number}|undefined, order=0, pending=false;
  const blocked = (c:Context) => !c.binding || !c.panelId || !c.ready || c.loading || c.blocked || c.closed
    || c.remote || c.interactionActive || c.pending;
  return {
    requestStarted:()=>++order,
    note(data:any, requestOrder:number) {
      const h=data?.history;
      if(!h || !Number.isSafeInteger(h.undoCount) || h.undoCount<0 || !Number.isSafeInteger(h.redoCount) || h.redoCount<0
        || typeof h.canUndo!=='boolean' || typeof h.canRedo!=='boolean') return;
      const c=options.context();
      if(c.binding && !sameSource(c.binding,data)) return;
      if(current && sameSource(current.binding,data)) {
        if(data.stateRevision<current.binding.stateRevision || data.inspectionRevision<current.binding.inspectionRevision) return;
        if(data.stateRevision===current.binding.stateRevision && data.inspectionRevision===current.binding.inspectionRevision
          && requestOrder<current.order) return;
      }
      current={binding:{sessionId:data.sessionId,serverEpoch:data.serverEpoch,sourceToken:data.sourceToken,
        stateRevision:data.stateRevision,inspectionRevision:data.inspectionRevision},history:{...h},order:requestOrder};
      options.changed();
    },
    get(view?:ViewState):SceneHistory {
      const c=options.context(view);
      const matches=current && sameSource(current.binding,c.binding)
        && current.binding.stateRevision===c.binding!.stateRevision && current.binding.inspectionRevision===c.binding!.inspectionRevision;
      const h=matches?current!.history:empty;
      const unavailable=blocked(c)||c.dirty||pending;
      return {...h,canUndo:!unavailable&&h.canUndo,canRedo:!unavailable&&h.canRedo};
    },
    async act(kind:'undo'|'redo') {
      if(kind!=='undo'&&kind!=='redo') throw Error('Unknown scene history action.');
      const observed=options.context();
      const before={...observed,binding:observed.binding?{...observed.binding}:undefined};
      if(pending || blocked(before)) throw Error('Finish the current scene change before using Undo or Redo.');
      pending=true; options.changed();
      try {
        await options.flush();
        const c=options.context();
        if(blocked(c)||c.dirty || c.generation!==before.generation || c.panelId!==before.panelId || !sameSource(c.binding,before.binding))
          throw Error('The scene changed or could not save. Try Undo or Redo when it is ready.');
        const b=c.binding!;
        // No render wait: this page must stay available to poll and draw it.
        const response=await options.call(kind==='undo'?'undo_last_change':'redo_last_change',{
          sessionId:b.sessionId,serverEpoch:b.serverEpoch,sourceToken:b.sourceToken,
          baseStateRevision:b.stateRevision,baseInspectionRevision:b.inspectionRevision,panelId:c.panelId,commandId:options.commandId()});
        return response.structuredContent;
      } finally { pending=false;options.changed(); }
    },
  };
}
