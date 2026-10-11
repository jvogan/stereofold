/** This exact validation runs before InspectionCommands.attach issues a panel.
 * Never infer it from a timeout, a lost response, or a generic HTTP conflict. */
export const STALE_ATTACH_MESSAGE='The panel must save or load the current inspection before attaching.';
export const MAX_ATTACH_REFRESHES=2;

export function isStaleInspectionAttach(error:unknown):boolean {
  const refusal=error as {code?:unknown;status?:unknown;message?:unknown}|null;
  return refusal?.message===STALE_ATTACH_MESSAGE
    && (refusal.code==='inspection_attach_stale'
      || (refusal.code==='companion_request' && refusal.status===409));
}

/** Test every time before restoring, including after the authoritative read.
 * A clean boolean alone misses edits made before their save timer fires. */
export function canRefreshInspectionAttach(state:{
  closed:boolean; generation:number; expectedGeneration:number;
  edits:number; expectedEdits:number; ready:boolean; dirty:boolean; blocked:boolean;
  loading:boolean; remote:boolean; interactionActive:boolean; pendingReceipt:boolean;
  sceneUnchanged:boolean;
}):boolean {
  return !state.closed && state.generation===state.expectedGeneration
    && state.edits===state.expectedEdits && state.ready && !state.dirty && !state.blocked
    && !state.loading && !state.remote && !state.interactionActive && !state.pendingReceipt
    && state.sceneUnchanged;
}
