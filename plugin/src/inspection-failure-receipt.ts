import { thrownErrorMessage } from './tool-result.js';

/** Bounded diagnostics, separate from the headset's paged display text.
 * 8 Ki UTF-16 units accommodates complete source/geometry refusals, including
 * long selection identifiers, without making an error response unbounded.
 */
export const MAX_INSPECTION_FAILURE_REASON_CHARS = 8 * 1024;
export const INSPECTION_FAILURE_CODES = [
  'local_changed', 'interaction_active', 'render_failed', 'capture_refused', 'representation_budget_exceeded', 'missing_coordinates',
] as const;
export type InspectionFailureCode = typeof INSPECTION_FAILURE_CODES[number];

export function inspectionFailureReceipt(error: unknown): { failure: InspectionFailureCode; failureReason: string } {
  const code = typeof error === 'object' && error !== null ? (error as {code?:unknown}).code : undefined;
  const failure = INSPECTION_FAILURE_CODES.includes(code as InspectionFailureCode) ? code as InspectionFailureCode : 'render_failed';
  const reason = thrownErrorMessage(error);
  if (reason.length <= MAX_INSPECTION_FAILURE_REASON_CHARS) return { failure, failureReason: reason };
  // Arbitrary upstream errors remain bounded. Make shortening explicit and
  // retain both the cause and the final remedy instead of silently dropping
  // the rest of the sentence. Normal actionable refusals pass unchanged.
  const disclosure = `\n[Diagnostic shortened from ${reason.length} characters to fit the receipt.]\n`;
  const available = MAX_INSPECTION_FAILURE_REASON_CHARS - disclosure.length;
  const headLength = Math.ceil(available / 2), tailLength = Math.floor(available / 2);
  const head = reason.slice(0, headLength).replace(/[\uD800-\uDBFF]$/, '');
  const tail = reason.slice(-tailLength).replace(/^[\uDC00-\uDFFF]/, '');
  return { failure, failureReason: head + disclosure + tail };
}

/** Renderer health is diagnostic only: it never grants edit admission or changes a scene. */
export function rendererContextReport(snapshot: {status?:unknown;error?:unknown}|undefined) {
  const status=snapshot?.status;
  if(status!=='context_lost' && status!=='recovering' && status!=='error')return null;
  const detail=status==='context_lost'
    ? 'The browser graphics context was lost. Wait for recovery; if it does not complete, reopen this same inspection before requesting a smaller pose or another representation.'
    :status==='recovering'
      ? 'The browser graphics context is rebuilding the retained scene. Wait until the renderer is ready before sending another visual edit.'
      : 'The molecular renderer failed. Reopen this same inspection before requesting another visual edit; the host saved scene has not been replaced by this failure.';
  return {status,detail,...(typeof snapshot?.error==='string'&&snapshot.error?{error:snapshot.error.slice(0,1024)}:{})};
}
