/**
 * The debounce in front of `stereo_structure.sync_view`.
 *
 * The Depth slider fires an `input` event for every pixel of a drag, and the
 * server only needs the value the drag lands on. This collapses a burst into
 * one call carrying the state read at the moment the burst stopped, which
 * matters twice over: it keeps a drag from becoming dozens of tool calls, and
 * it means the payload is never a stale snapshot taken when the burst started.
 *
 * Timers are injected so the behaviour can be tested without a browser or a
 * clock; the viewer passes `window.setTimeout` / `window.clearTimeout`.
 */
export interface DebouncedSenderTimers {
  set(callback: () => void, delayMs: number): number;
  clear(handle: number): void;
}

export interface DebouncedSender {
  /** Ask for a send. The payload is read when the quiet period elapses. */
  request(): void;
  /** Send now, if one is pending. Used when something must not be lost. */
  flush(): void;
  /** Drop a pending send without making it. */
  cancel(): void;
  /** True while a send is waiting for the quiet period to elapse. */
  readonly pending: boolean;
  /** For assertions: how many sends have actually been made. */
  readonly sentCount: number;
}

export function createDebouncedSender<T>(options: {
  /** Read the state to send. Called once per send, when the timer fires. */
  read(): T;
  send(payload: T): void;
  delayMs: number;
  timers: DebouncedSenderTimers;
}): DebouncedSender {
  let handle: number | undefined;
  let sentCount = 0;

  const fire = (): void => {
    handle = undefined;
    sentCount += 1;
    options.send(options.read());
  };

  return {
    request(): void {
      if (handle !== undefined) options.timers.clear(handle);
      handle = options.timers.set(fire, options.delayMs);
    },
    flush(): void {
      if (handle === undefined) return;
      options.timers.clear(handle);
      fire();
    },
    cancel(): void {
      if (handle === undefined) return;
      options.timers.clear(handle);
      handle = undefined;
    },
    get pending(): boolean {
      return handle !== undefined;
    },
    get sentCount(): number {
      return sentCount;
    },
  };
}
