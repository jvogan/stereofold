import { digest, fields, identifier, requireValue, revision, same, snapshotInput, validateTarget, validateView } from './contracts.mjs';

export function validateReturn(value) {
  const input = snapshotInput(value);
  fields(input, ['version', 'snapshotId', 'target', 'sourceSceneId', 'sourceSha256', 'baseDesktopRevision',
    'selectionKeys', 'view']);
  requireValue(input.version === 1 && identifier(input.snapshotId) && identifier(input.sourceSceneId), 'invalid_return');
  validateTarget(input.target);
  requireValue(digest(input.sourceSha256) && revision(input.baseDesktopRevision), 'invalid_return_source');
  requireValue(Array.isArray(input.selectionKeys) && input.selectionKeys.length <= 128
    && Array.from(input.selectionKeys).every(identifier)
    && new Set(input.selectionKeys).size === input.selectionKeys.length, 'invalid_return_selection');
  validateView(input.view);
  return input;
}

// A decision describes state delivery. Only the real host can confirm a visible panel render.
export function decideReturn(input, panel) {
  const snapshot = validateReturn(input);
  const result = (status, reason) => ({ status, reason, snapshot, visibleRenderConfirmed: false });
  if (panel == null) return result('recoverable', 'original_panel_unavailable');
  validateTarget(panel.target);
  requireValue(typeof panel.mounted === 'boolean' && ['visible', 'hidden'].includes(panel.visibility)
    && identifier(panel.sceneId) && digest(panel.sourceSha256) && revision(panel.revision), 'invalid_panel');
  if (!same(panel.target, snapshot.target)) return result('recoverable', 'original_binding_unavailable');
  if (!panel.mounted) return result('recoverable', 'original_panel_unmounted');
  if (panel.sceneId !== snapshot.sourceSceneId || panel.sourceSha256 !== snapshot.sourceSha256) {
    return result('save_snapshot', 'desktop_source_replaced');
  }
  if (panel.revision !== snapshot.baseDesktopRevision) return result('save_snapshot', 'desktop_revision_changed');
  return result('apply_to_original', panel.visibility === 'hidden' ? 'original_panel_hidden' : 'original_panel_ready');
}
