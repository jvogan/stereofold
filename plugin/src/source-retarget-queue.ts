type RetargetLane = {
  tail: Promise<void>;
  pending: Map<string, Promise<void>>;
  completed?: string;
};

/** A share generation is its owner object, not its unchanged bearer URL.
 * Retargeting cuts coordinate streams, so repeat reads must share that effect.
 * Only the latest successful pair is reusable: older pairs still reach the
 * transport's source-capability check after a subsequent source transition.
 */
export class SourceRetargetQueue {
  #lanes = new WeakMap<object, RetargetLane>();

  run(owner: object, previous: string, next: string, retarget: () => Promise<void>): Promise<void> {
    let lane = this.#lanes.get(owner);
    if (!lane) {
      lane = { tail: Promise.resolve(), pending: new Map() };
      this.#lanes.set(owner, lane);
    }
    const key = JSON.stringify([previous, next]);
    const existing = lane.pending.get(key);
    if (existing) return existing;
    const current = lane;
    const operation = current.tail.then(async () => {
      if (current.completed === key) return;
      // A different handoff can advance loopback before LAN fails. The old
      // success no longer proves the source capability, even on rejection.
      current.completed = undefined;
      await retarget();
      current.completed = key;
    });
    current.pending.set(key, operation);
    // Failure releases the lane but never records a successful handoff. A
    // retry can safely finish the idempotent loopback step and repeat LAN.
    current.tail = operation.then(() => { current.pending.delete(key); }, () => { current.pending.delete(key); });
    return operation;
  }
}
