/** Runs inside the workspace queue; scene payloads never become model text. */
export function captureNamedScene(viewer) {
  const scene = viewer.inspection.capture();
  delete scene.inspection.history;
  delete scene.inspection.savedViews;
  return scene;
}
const ordered = value => Array.isArray(value) ? value.map(ordered)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
export function sameNamedScience(actual, expected) {
  const science = scene => ({sourceSha256:scene.sourceSha256,modelNumber:scene.modelNumber,assemblyId:scene.assemblyId,
    selectionKeys:[...scene.selectionKeys].sort(),inspection:scene.inspection});
  return JSON.stringify(ordered(science(actual))) === JSON.stringify(ordered(science(expected)));
}
export async function captureNamedView(viewer, admit, confirm) {
  await admit();
  const scene=captureNamedScene(viewer);
  const namedViewIntent=viewer.inspection.captureNamedViewIntent?.();
  return confirm(scene, {captured:true,...(namedViewIntent?{namedViewIntent}:{})});
}
export async function restoreNamedView(viewer, scene, admit, confirm, namedViewIntent) {
  await admit();
  const before=captureNamedScene(viewer);
  if(namedViewIntent) {
    if(typeof viewer.inspection.sceneForNamedView!=='function') throw Error('This viewer cannot restore the saved inspection angle.');
    scene=viewer.inspection.sceneForNamedView(scene,namedViewIntent);
  }
  const options={preserveCamera:viewer.snapshot().xrPresenting===true,restorePlacement:true,preservePreviewCamera:true};
  const checkpoint=viewer.inspection.beginOperation('restore-view');
  try {
    await viewer.inspection.restore(scene,options);
    const actual=captureNamedScene(viewer);
    if(!sameNamedScience(actual,scene)) throw Error('The rendered saved view does not match its requested scientific state.');
    const result=await confirm(actual,{restored:true});
    viewer.inspection.endOperation();
    return result;
  } catch(error) {
    // Context loss may prevent renderer recovery. Never claim rollback in that
    // case, and never confirm the original restore after a failed comparison.
    try { await viewer.inspection.restore(before,options); }
    catch(recovery) { throw new Error('Saved view failed and the previous scene could not be restored.',{cause:new AggregateError([error,recovery])}); }
    finally { await viewer.inspection.rollbackOperation(checkpoint); }
    throw error;
  }
}
