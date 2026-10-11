/**
 * A check/refusal is an app-tool result, but never a molecular session.
 *
 * The card shows a title, one sentence saying what happened and one with the
 * next step. The checker's own reasons name scene fields and tool names, so
 * they go in `details`, which the panel keeps collapsed.
 */
export function sceneImportPreflightView(data: unknown): { title: string; text: string; next: string; details: string; supported: boolean } | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const result = data as Record<string, any>;
  if (result.kind !== 'scene-preflight' || typeof result.preflight?.supported !== 'boolean'
    || typeof result.preflight.message !== 'string') return undefined;
  const supported = result.preflight.supported;
  return {
    supported,
    title: supported ? 'Scene compatibility checked' : 'Matching scene unavailable',
    text: supported ? ['This snapshot can open as a matching scene, pending a final check when its structure loads.', result.preflight.renderingDifference].filter(Boolean).join(' ')
      : 'This snapshot uses features Stereofold can’t reproduce, so nothing was opened.',
    next: supported ? 'Ask your assistant to open the matching scene or the structure only.'
      : 'To view the coordinates without the scene, ask your assistant for a structure-only view.',
    details: [result.preflight.message, typeof result.disclosure === 'string' ? result.disclosure : ''].filter(Boolean).join('\n\n'),
  };
}
