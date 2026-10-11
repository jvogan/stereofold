/** IDs join stages; audio-start records also carry bounded spoken evidence. */
export function recordLoopStage(stage, ids, scope = globalThis) {
  const detail = { stage };
  for (const key of ['commandId', 'utteranceId']) {
    if (typeof ids?.[key] === 'string' && ids[key]) detail[key] = ids[key];
  }
  const spoken = typeof ids?.speechText === 'string' ? ids.speechText : ids?.text;
  if (stage === 'spoken-confirmation-started' && typeof spoken === 'string') {
    const text = spoken.trim().replace(/\s+/gu, ' ');
    detail.spokenText = text.slice(0, 200);
    detail.spokenWords = text ? text.split(' ').length : 0;
  }
  if (!detail.commandId && !detail.utteranceId && detail.spokenWords === undefined) return;
  try { scope?.__stereofoldDiagnostics?.record?.('voice-loop', detail); } catch {}
}
