/** Admission happens before capturing or serializing an unsaved scene. */
export type SaveRetryBinding = { sessionId?: string; serverEpoch?: string; sourceToken?: string };

export function createSaveRetryAdmission(now: () => number = Date.now) {
  let scope: SaveRetryBinding | undefined, generation: number | undefined, retryAt = 0;
  function current(binding: SaveRetryBinding | undefined, nextGeneration: number) {
    if (generation !== nextGeneration || scope?.sessionId !== binding?.sessionId
      || scope?.serverEpoch !== binding?.serverEpoch || scope?.sourceToken !== binding?.sourceToken) {
      scope = binding ? { sessionId: binding.sessionId, serverEpoch: binding.serverEpoch, sourceToken: binding.sourceToken } : undefined;
      generation = nextGeneration; retryAt = 0;
    }
  }
  return {
    delay(binding: SaveRetryBinding | undefined, nextGeneration: number) {
      current(binding, nextGeneration);
      return Math.max(0, retryAt - now());
    },
    defer(binding: SaveRetryBinding | undefined, nextGeneration: number, delayMs: number) {
      current(binding, nextGeneration); retryAt = now() + delayMs;
    },
    reset(binding: SaveRetryBinding | undefined, nextGeneration: number) {
      current(binding, nextGeneration); retryAt = 0;
    },
  };
}
