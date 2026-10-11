import type { SessionGeneration, SessionGenerationGuard } from './session-generation.js';

/** Opaque handle for one camera operation that temporarily owns refitting. */
export type FitSuspensionLease = { readonly id: number };

/**
 * Track refit suspension by operation rather than one process-wide boolean.
 *
 * A stale open may finish after a newer frame has claimed the viewer. Its lease
 * is pruned whenever suspension is queried, and releasing that stale lease can
 * never clear a newer load/reset's lease. Unscoped local actions retain their
 * lease until they finish, preserving a person's explicit camera operation.
 */
export interface FitSuspensionRegistry {
  acquire(request?: SessionGeneration): FitSuspensionLease;
  release(lease: FitSuspensionLease): void;
  isSuspended(): boolean;
}

export function createFitSuspensionRegistry(
  sessions: Pick<SessionGenerationGuard, 'isCurrent'>,
): FitSuspensionRegistry {
  let nextId = 0;
  const active = new Map<number, SessionGeneration | undefined>();

  function pruneStale(): void {
    for (const [id, request] of active) {
      if (request != null && !sessions.isCurrent(request)) active.delete(id);
    }
  }

  return {
    acquire(request?: SessionGeneration): FitSuspensionLease {
      pruneStale();
      nextId += 1;
      active.set(nextId, request);
      return { id: nextId };
    },
    release(lease: FitSuspensionLease): void {
      active.delete(lease.id);
    },
    isSuspended(): boolean {
      pruneStale();
      return active.size > 0;
    },
  };
}
