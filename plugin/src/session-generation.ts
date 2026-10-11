/** Identity of one request generation within a mounted viewer frame. */
export interface SessionGeneration {
  sessionId?: string;
  generation: number;
  /** Server lifecycle that issued this render/state request. */
  serverEpoch?: string;
  /** Highest accepted server render ordering token for this mounted frame. */
  renderToken?: number;
}

export interface SessionGenerationGuard {
  /** A new open/load owns every response and fallback started after this call. */
  begin(sessionId: string, renderToken?: number): SessionGeneration;
  /** Capture current ownership for an async operation or timer. */
  capture(): SessionGeneration;
  /** True only while the captured operation still owns the mounted frame. */
  isCurrent(token: SessionGeneration): boolean;
  /**
   * Record a server-issued render token if it is newer than every result this
   * frame has already accepted. Does not advance the request generation: a
   * local control call already owns its generation before its result arrives.
   */
  acceptRenderToken(renderToken: number, serverEpoch: string): boolean;
  /** Accept a strictly newer safe-state snapshot for the current server lifecycle. */
  acceptStateRevision(stateRevision: number, serverEpoch: string): boolean;
  /** Once a server lifecycle was replaced, its delayed results stay retired. */
  isRetiredServerEpoch(serverEpoch: string): boolean;
  readonly sessionId: string | undefined;
  readonly serverEpoch: string | undefined;
  readonly renderToken: number | undefined;
  readonly stateRevision: number | undefined;
}

/** A public, server-instance monotonic ordering marker for a render result. */
export function isRenderToken(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** A server-generated UUID separates token sequences across process restarts. */
export function isServerEpoch(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

/** A per-session safe-state revision starts at zero and never wraps. */
export function isStateRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** True for local work, or while a captured session generation still owns it. */
export function sessionRequestIsCurrent(
  guard: Pick<SessionGenerationGuard, 'isCurrent'>,
  request?: SessionGeneration,
): boolean {
  return request == null || guard.isCurrent(request);
}

export type ToolResultSessionDecision = 'begin' | 'keep' | 'discard';

/** Result of a structure load after its asynchronous work has completed. */
export type HydrationLoadCompletion = 'hydrated' | 'failed' | 'stale';

/**
 * A load may finish after another open/load has claimed the same mounted
 * frame, or may fail after its parser rejected the coordinate text. Call this
 * immediately after each awaited structure load so callers cannot cancel the
 * newer generation's fallback as if the older one won, nor call a failed load
 * hydrated merely because it returned.
 */
export function hydrationLoadCompletion(
  guard: Pick<SessionGenerationGuard, 'isCurrent'>,
  request: SessionGeneration,
  loaded = true,
): HydrationLoadCompletion {
  if (!guard.isCurrent(request)) return 'stale';
  return loaded ? 'hydrated' : 'failed';
}

/** Decide whether an incoming result may change ownership of a mounted frame. */
export function decideToolResultSession(input: {
  currentSessionId?: string;
  currentServerEpoch?: string;
  currentRenderToken?: number;
  incomingSessionId?: string;
  incomingServerEpoch?: string;
  incomingRenderToken?: number;
  incomingServerEpochRetired?: boolean;
  structureReplacement: boolean;
}): ToolResultSessionDecision {
  if (input.structureReplacement) {
    // Tool-result notifications have no ordering guarantee. A result cannot
    // claim a reused frame unless the server supplied an ordering marker newer
    // than the one the frame has already accepted.
    if (input.incomingSessionId == null
      || !isServerEpoch(input.incomingServerEpoch)
      || !isRenderToken(input.incomingRenderToken)
      || input.incomingServerEpochRetired === true) return 'discard';
    // A new server process starts its own counter at one. Its first valid
    // render begins a new lifecycle; old epochs are retired by the guard when
    // it accepts that result, so they cannot reclaim this frame later.
    if (input.currentServerEpoch === input.incomingServerEpoch
      && isRenderToken(input.currentRenderToken)
      && input.incomingRenderToken <= input.currentRenderToken) return 'discard';
    return 'begin';
  }
  if (input.incomingSessionId != null && input.incomingSessionId !== input.currentSessionId) return 'discard';
  // Only a structure-bearing open is allowed to introduce a new lifecycle.
  // A delayed state/control response from an old server must not reset safe
  // state freshness or make a new unknown server current by itself.
  if (input.incomingServerEpoch != null && input.incomingServerEpoch !== input.currentServerEpoch) return 'discard';
  return 'keep';
}

/**
 * Prevent a late response for open A from mutating a frame already owned by B.
 *
 * The generation increments even when two opens reuse the same session: the
 * second open may select a different cached structure inside that session.
 */
export function createSessionGenerationGuard(): SessionGenerationGuard {
  let sessionId: string | undefined;
  let serverEpoch: string | undefined;
  let generation = 0;
  let renderToken: number | undefined;
  let stateRevision: number | undefined;
  const retiredServerEpochs = new Set<string>();

  const snapshot = (): SessionGeneration => ({
    ...(sessionId == null ? {} : { sessionId }),
    ...(serverEpoch == null ? {} : { serverEpoch }),
    generation,
    ...(renderToken == null ? {} : { renderToken }),
  });

  /** Admit a never-seen server lifecycle and retire the one it replaced. */
  const acceptServerEpoch = (nextServerEpoch: string): boolean => {
    if (!isServerEpoch(nextServerEpoch)) return false;
    if (serverEpoch === nextServerEpoch) return true;
    if (retiredServerEpochs.has(nextServerEpoch)) return false;
    if (serverEpoch != null) retiredServerEpochs.add(serverEpoch);
    serverEpoch = nextServerEpoch;
    // Token and state counters both restart when a process restarts.
    renderToken = undefined;
    stateRevision = undefined;
    return true;
  };

  return {
    begin(nextSessionId: string, nextRenderToken?: number): SessionGeneration {
      const sessionChanged = sessionId !== nextSessionId;
      sessionId = nextSessionId;
      generation += 1;
      if (isRenderToken(nextRenderToken)) renderToken = nextRenderToken;
      // A reused frame keeps the latest state revision for the same session:
      // an older-started open may still own coordinates, but it must not make
      // a newer mode/look/motion snapshot appear fresh again. A genuinely
      // different opaque session starts its independent revision sequence.
      if (sessionChanged) stateRevision = undefined;
      return snapshot();
    },
    capture(): SessionGeneration {
      return snapshot();
    },
    isCurrent(token: SessionGeneration): boolean {
      return token.generation === generation
        && token.sessionId === sessionId
        && token.serverEpoch === serverEpoch;
    },
    acceptRenderToken(nextRenderToken: number, nextServerEpoch: string): boolean {
      if (!isRenderToken(nextRenderToken) || !acceptServerEpoch(nextServerEpoch)) return false;
      if (renderToken != null && nextRenderToken <= renderToken) return false;
      renderToken = nextRenderToken;
      return true;
    },
    acceptStateRevision(nextStateRevision: number, nextServerEpoch: string): boolean {
      if (!isStateRevision(nextStateRevision) || nextServerEpoch !== serverEpoch) return false;
      if (stateRevision != null && nextStateRevision <= stateRevision) return false;
      stateRevision = nextStateRevision;
      return true;
    },
    isRetiredServerEpoch(nextServerEpoch: string): boolean {
      return retiredServerEpochs.has(nextServerEpoch);
    },
    get sessionId(): string | undefined {
      return sessionId;
    },
    get serverEpoch(): string | undefined {
      return serverEpoch;
    },
    get renderToken(): number | undefined {
      return renderToken;
    },
    get stateRevision(): number | undefined {
      return stateRevision;
    },
  };
}
