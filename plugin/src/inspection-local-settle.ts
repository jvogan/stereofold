import { inspectionJson, type InspectionScene, type InspectionChange } from './inspection-contract.js';
import { sameEntryScene } from './inspection-render-settle.js';

/** A queued unbound edit can follow a save only if its inputs did not change. */
export function compatibleLocalSave(before:InspectionScene, after:InspectionScene, change:InspectionChange):boolean {
  if(before.sourceSha256!==after.sourceSha256 || before.modelNumber!==after.modelNumber || before.assemblyId!==after.assemblyId)return false;
  // A running clip advances between captures, including across loop wraps.
  // Keep its definition, identity and controls in every comparison below;
  // only elapsed time is incidental to these queued lesson commands.
  if(change.kind==='tour' && ['start','pause','done','restore-start'].includes(change.patch.action)
    && before.inspection.animation?.playback.state==='playing' && after.inspection.animation?.playback.state==='playing') {
    const withoutElapsedTime=(scene:InspectionScene):InspectionScene=>({...scene,inspection:{...scene.inspection,
      animation:{...scene.inspection.animation!,playback:{...scene.inspection.animation!.playback,timeSeconds:0}}}});
    before=withoutElapsedTime(before);after=withoutElapsedTime(after);
  }
  const same=(a:unknown,b:unknown)=>inspectionJson(a)===inspectionJson(b);
  if(change.kind==='compound')return change.patch.ops.every(op=>compatibleLocalSave(before,after,op));
  if(change.kind==='appearance')return Object.keys(change.patch).every(key=>same((before.inspection.appearance as any)[key],(after.inspection.appearance as any)[key]));
  if(change.kind==='selection')return same(before.selectionKeys,after.selectionKeys);
  // A placement change follows a wearer's move only when the move left the
  // fields it sets alone: Claude's scale may land on a molecule the wearer
  // carried, but not over the wearer's own rescale. Reset sets none of them.
  if(change.kind==='placement')return Object.keys(change.patch).filter(key=>key!=='recenter')
    .every(key=>same((before.inspection.placement as any)[key],(after.inspection.placement as any)[key]));
  if(change.kind==='tour' && change.patch.action==='menu')return true;
  // Finishing a chapter turn saves its camera and motion cursor. Navigation
  // still means one chapter from that same cursor; carry the queued command
  // across this save, but never across a chapter, source or scientific edit.
  if(change.kind==='tour' && ['next','back'].includes(change.patch.action) && sameEntryScene(before,after))return true;
  // A start, a pause or a Done acts on whatever the playing lesson drew while
  // it waited: a restart goes back to the lesson's own starting scene, and
  // Done leaves it. Only an autoplay advance may change more than placement:
  // the same lesson, still playing, on a new chapter whose clock is its own.
  // The wearer taking the structure stops the lesson, so a scientific edit
  // never rides along with one.
  if(change.kind==='tour' && ['start','pause','done','restore-start'].includes(change.patch.action)
    && autoplayAdvanced(before,after))return true;
  if(change.kind==='tour' && (change.patch.action==='pause' || change.patch.action==='play'))
    return same(before.inspection.animation,after.inspection.animation);
  // A focus frames its region by moving the structure, so it may not follow
  // a wearer who just placed it; its whole input has to hold.
  if(change.kind==='focus')return same(before.inspection,after.inspection)&&same(before.selectionKeys,after.selectionKeys);
  // A wake/VR-entry seat, a grab or a camera adjustment is compatible with
  // everything else, a tour start and a lesson install included: the
  // wearer's placement is theirs, an unframed install keeps it, and the
  // camera is a sample. Other operations may resolve implicit selections or
  // lesson parts, so scientific edits, selection and authored playback
  // changes are not.
  const {placement:_before,...a}=before.inspection,{placement:_after,...b}=after.inspection;
  return same(a,b)&&same(before.selectionKeys,after.selectionKeys);
}
/** Whether the only lesson change between two saves is the playing lesson's own next chapter. */
function autoplayAdvanced(before:InspectionScene, after:InspectionScene):boolean {
  const playing=(before.inspection as any).lessonPlayback, now=(after.inspection as any).lessonPlayback;
  const clock=(after.inspection as any).animation?.playback;
  return Boolean(playing && now && playing.stopped===false && now.stopped===false
    && now.tourId===playing.tourId && now.chapterId!==playing.chapterId
    && inspectionJson(playing.startingScene)===inspectionJson(now.startingScene)
    && (!clock || clock.chapterId===now.chapterId));
}
/** Why a waiting command could not follow a local save, in words the wearer's plate can show. */
export function localSaveConflictReason(placementOnly:boolean):string {
  return placementOnly
    ? 'The wearer moved the structure while this command waited, and the command would have changed that placement. Send it again from the new placement.'
    : 'A local edit in the panel changed this command’s inputs while it waited. Read get_inspection_state, then send it again.';
}
