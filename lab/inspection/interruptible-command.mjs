/** The workspace queue owns this transaction until confirmation or rollback. */
export async function interruptibleCommand(viewer, admit, action, rolledBack) {
  try { await admit(); }
  catch(error) {
    if(error.code==='superseded') await rolledBack?.(); // No mutation was admitted.
    throw error;
  }
  const before=viewer.inspection.capture();
  const animation=viewer.inspection.checkpointMolecularAnimation?.();
  const motion=viewer.inspection.getMotion?.();
  const quality=viewer.inspection.renderQuality?.();
  // Keep the existing operation grouping; this checkpoint is only for recovery.
  const checkpoint=viewer.inspection.beginOperation?.('interruption-checkpoint');
  if(checkpoint!==undefined) viewer.inspection.endOperation();
  try { return await action(() => {
    // The replacement has settled in this queue turn. Retain that appearance
    // and collapse its undo history to the original rollback checkpoint.
    if(checkpoint!==undefined) viewer.inspection.rebaseOperation?.(checkpoint);
  }); }
  catch(error) {
    if(error.code!=='superseded' && !error.rollbackRequired) throw error;
    try {
      await viewer.inspection.restore(before,{preserveCamera:viewer.snapshot().xrPresenting===true,restorePlacement:true,preservePreviewCamera:true});
      // reason/rate are diagnostics; setMotion accepts only the requested pause.
      if(motion && viewer.inspection.getMotion?.()?.paused!==motion.paused) await viewer.inspection.setMotion({paused:motion.paused});
      if(quality && viewer.inspection.renderQuality?.()!==quality) await viewer.inspection.setRenderQuality(quality.level??quality);
      // This restores undo state AND rebuilds geometry. Keep the queue and
      // publication held until that last frame, including its possible failure.
      if(checkpoint!==undefined) await viewer.inspection.rollbackOperation(checkpoint);
      await viewer.inspection.restoreMolecularAnimation?.(animation);
    } catch(recovery) {
      throw Object.assign(new Error('The cancelled command could not restore the previous view. Load the saved view before continuing.',{cause:recovery}),{code:'rollback_failed'});
    }
    await rolledBack?.();
    throw error;
  }
}
