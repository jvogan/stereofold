/** Attach the server-issued capability to an app-originated tool call. */
export function sessionToolArguments(
  sessionId: string | undefined,
  arguments_: Readonly<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  if (typeof sessionId !== 'string' || sessionId.trim().length === 0) return undefined;
  // The retained server capability always wins over an accidental caller key.
  return { ...arguments_, sessionId };
}
