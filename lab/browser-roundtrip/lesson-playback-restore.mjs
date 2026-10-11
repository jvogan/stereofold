// Peer lesson status is persisted with the scene, but stopped/narration flags
// do not change its molecule, plates or placement. Keep every visual field and
// the lesson's chapter/baseline strict before skipping a render transaction.
function sameValue(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((value, index) => sameValue(value, b[index]));
  // JSON transport omits undefined properties and schemas can reorder keys.
  const keys = Object.keys(a).filter(key => a[key] !== undefined);
  const other = Object.keys(b).filter(key => b[key] !== undefined);
  return keys.length === other.length && keys.every(key => Object.hasOwn(b, key) && sameValue(a[key], b[key]));
}

export function canRestoreLessonPlaybackMetadata(current, incoming, options = {}) {
  if (options.restorePlacement || options.preservePlacement || options.preservePreviewCamera || options.xrRecoveryFrame) return false;
  const before = current?.inspection?.lessonPlayback, after = incoming?.inspection?.lessonPlayback;
  const valid = value => value && typeof value.tourId === 'string' && value.tourId.length > 0
    && typeof value.chapterId === 'string' && value.chapterId.length > 0
    && typeof value.stopped === 'boolean' && (value.narration === undefined || typeof value.narration === 'boolean')
    && value.startingScene?.inspection;
  if (!valid(before) || !valid(after) || sameValue(before, after)) return false;
  const statusless = value => {
    const { stopped, narration, ...identity } = value;
    return identity;
  };
  if (!sameValue(statusless(before), statusless(after))) return false;
  const visual = scene => {
    // Workspace transport captures omit these two local history fields.
    const { lessonPlayback, history, savedViews, ...inspection } = scene.inspection;
    return { ...scene, inspection };
  };
  return sameValue(visual(current), visual(incoming));
}
