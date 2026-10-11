import { PRIVATE_STRUCTURE_META_KEY } from './structure-result.js';

/**
 * Small, host-neutral readers for MCP tool results.
 *
 * The viewer receives the same shape from the MCP Apps `toolresult` event and
 * from `App.callServerTool()`. Keeping the readers here makes the important
 * distinction explicit: a fulfilled JavaScript promise can still be an MCP
 * failure when the result carries `isError: true`.
 */

export interface ToolResultLike {
  isError?: unknown;
  content?: unknown;
  structuredContent?: unknown;
  _meta?: unknown;
}

function resultObject(value: unknown): ToolResultLike | undefined {
  return typeof value === 'object' && value != null ? value as ToolResultLike : undefined;
}

/** Read structured content only when it is a non-null object. */
export function structuredToolContent<T extends object>(result: unknown): T | undefined {
  const content = resultObject(result)?.structuredContent;
  return typeof content === 'object' && content != null ? content as T : undefined;
}

/**
 * Read Stereofold's component-only coordinate cache from the full MCP result
 * envelope. Never fall back to `structuredContent`: that field is model
 * visible, including for app-only tools.
 */
export function privateStructurePayload<T extends object>(result: unknown): T | undefined {
  const metadata = resultObject(result)?._meta;
  if (typeof metadata !== 'object' || metadata == null || Array.isArray(metadata)) return undefined;
  const payload = (metadata as Record<string, unknown>)[PRIVATE_STRUCTURE_META_KEY];
  return typeof payload === 'object' && payload != null && !Array.isArray(payload)
    ? payload as T
    : undefined;
}

/**
 * Return the server's explanation for an MCP error result.
 *
 * Text blocks are the portable MCP error channel. Unknown/non-text content is
 * ignored, with a stable fallback so the UI never produces a blank red toast.
 */
export function toolResultError(result: unknown): string | undefined {
  const object = resultObject(result);
  if (object?.isError !== true) return undefined;
  const blocks = Array.isArray(object.content) ? object.content : [];
  const text = blocks
    .filter((block): block is { type: 'text'; text: string } => (
      typeof block === 'object'
      && block != null
      && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string'
    ))
    .map((block) => block.text.trim())
    .filter((part) => part.length > 0)
    .join(' ');
  return text || 'The server returned an error.';
}

/** Turn a thrown bridge value into a useful, non-empty sentence fragment. */
export function thrownErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  if (typeof error === 'string' && error.trim().length > 0) return error.trim();
  return 'The host did not complete the request.';
}
