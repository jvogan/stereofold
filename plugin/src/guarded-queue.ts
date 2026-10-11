/** Predicate supplied to serialized work so it can stop after each await. */
export type WorkCurrentGuard = () => boolean;

/**
 * Serialize scene-adjacent work and let each job observe whether it still owns
 * the mounted session when it actually runs.
 *
 * A queue cannot cancel a Mol* update already in flight, but it guarantees a
 * newer job runs after it. Passing the same guard into the job lets callers
 * suppress post-await commits, notifications, and bookkeeping from a stale
 * generation before that newer job takes over.
 */
export interface GuardedSerialQueue {
  enqueue(
    run: (isCurrent: WorkCurrentGuard) => Promise<void>,
    shouldRun?: WorkCurrentGuard,
  ): Promise<void>;
}

export function createGuardedSerialQueue(): GuardedSerialQueue {
  let tail: Promise<void> = Promise.resolve();

  return {
    enqueue(
      run: (isCurrent: WorkCurrentGuard) => Promise<void>,
      shouldRun: WorkCurrentGuard = () => true,
    ): Promise<void> {
      const guardedRun = (): Promise<void> => shouldRun() ? run(shouldRun) : Promise.resolve();
      const next = tail.then(guardedRun, guardedRun);
      // A failed job must not wedge everything submitted after it.
      tail = next.catch(() => undefined);
      return next;
    },
  };
}
