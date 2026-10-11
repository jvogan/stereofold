import { expect, it, vi } from 'vitest';
import { createSceneHistoryClient } from '../src/scene-history-client.js';

function fixture() {
  const binding={sessionId:'s',serverEpoch:'e',sourceToken:'a',stateRevision:2,inspectionRevision:3};
  const context={binding,panelId:'panel',generation:1,ready:true,loading:false,dirty:false,blocked:false,
    closed:false,remote:false,interactionActive:false,pending:false};
  const call=vi.fn(async(_name:string,_args:Record<string,unknown>)=>({structuredContent:{command:{status:'queued'}}}));
  const flush=vi.fn(async()=>{}), changed=vi.fn();
  const client=createSceneHistoryClient({context:()=>context,call,flush,changed,commandId:()=> 'fresh-id'});
  const note=(history={undoCount:2,redoCount:1,canUndo:true,canRedo:true},order=client.requestStarted())=>
    client.note({...context.binding,history},order);
  note();
  return {client,context,call,flush,changed,note};
}
it('flushes first and binds the history request to the saved revision without holding a render wait',async()=>{
  const h=fixture(); h.context.dirty=true;
  h.flush.mockImplementation(async()=>{h.context.binding.inspectionRevision=4;h.context.dirty=false;});
  await h.client.act('undo');
  expect(h.flush).toHaveBeenCalledOnce();
  expect(h.call).toHaveBeenCalledWith('undo_last_change',{sessionId:'s',serverEpoch:'e',sourceToken:'a',
    baseStateRevision:2,baseInspectionRevision:4,panelId:'panel',commandId:'fresh-id'});
  await h.client.act('redo'); expect(h.call.mock.calls.at(-1)?.[0]).toBe('redo_last_change');
});
it.each(['loading','blocked','closed','remote','interactionActive','pending'] as const)('disables history and refuses commands while %s',async flag=>{
  const h=fixture();h.context[flag]=true;
  expect(h.client.get()).toMatchObject({canUndo:false,canRedo:false});
  await expect(h.client.act('undo')).rejects.toThrow();expect(h.call).not.toHaveBeenCalled();
});
it('disables dirty history, rejects failed saves, and cannot cross a source or panel change during flush',async()=>{
  const h=fixture();h.context.dirty=true;expect(h.client.get().canUndo).toBe(false);
  await expect(h.client.act('undo')).rejects.toThrow('could not save');expect(h.call).not.toHaveBeenCalled();
  h.context.dirty=false;
  h.flush.mockImplementation(async()=>{h.context.binding={...h.context.binding,sourceToken:'b'};});
  await expect(h.client.act('undo')).rejects.toThrow('scene changed');expect(h.call).not.toHaveBeenCalled();
  h.flush.mockImplementation(async()=>{h.context.panelId='other';});
  await expect(h.client.act('redo')).rejects.toThrow('scene changed');expect(h.call).not.toHaveBeenCalled();
});
it('prevents duplicate presses while saving or awaiting host admission and unlocks after a failed request',async()=>{
  const h=fixture();let release!:()=>void;
  h.flush.mockImplementation(()=>new Promise<void>(resolve=>{release=resolve;}));
  const first=h.client.act('redo'); expect(h.client.get().canRedo).toBe(false);
  await expect(h.client.act('redo')).rejects.toThrow();
  h.call.mockRejectedValueOnce(Error('offline'));release();await expect(first).rejects.toThrow('offline');
  expect(h.client.get().canRedo).toBe(true);
});
it('poll updates replace counts, older same-revision replies cannot re-enable pending commands, and source changes disable stale history',()=>{
  const h=fixture(), old=h.client.requestStarted(), fresh=h.client.requestStarted();
  h.note({undoCount:2,redoCount:1,canUndo:false,canRedo:false},fresh);
  h.note(undefined,old);expect(h.client.get().canUndo).toBe(false);
  h.context.binding={...h.context.binding,inspectionRevision:4};expect(h.client.get().canUndo).toBe(false);
  h.note({undoCount:1,redoCount:2,canUndo:true,canRedo:true});expect(h.client.get().redoCount).toBe(2);
  h.context.binding={...h.context.binding,sourceToken:'other'};expect(h.client.get()).toEqual({undoCount:0,redoCount:0,canUndo:false,canRedo:false});
});
it('does not substitute local history when the host has no history support',()=>{
  const h=fixture();h.context.binding={...h.context.binding,sourceToken:'new'};
  h.client.note({...h.context.binding},h.client.requestStarted());expect(h.client.get().canUndo).toBe(false);
});
