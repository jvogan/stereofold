/**
 * Where an in-session source swap spends its time, and a bound on
 * every part of it.
 *
 * A real Quest 2 was asked to grow the microtubule lesson from
 * the monomer to the dimer — 6,818 atom sites, a tier the same headset renders
 * at 72 fps once it is up. The emulator does the same swap in 3.05 s. The
 * headset took somewhere between 44 s and three minutes, and the only thing
 * anyone could say about the gap afterwards was that it existed: `hydrate()`
 * sets `loading`, `loading` silences `poll()`, and the page had already
 * detached its panel with reason `loading`, so for the whole of the stall the
 * Mac held a panel snapshot 44.6 s old and the headset log carried nothing at
 * all. The capture taken at the driver's timeout shows the old monomer.
 *
 * Two things follow from that, and this module is both of them.
 *
 * **Say where the time went.** A swap is a fixed sequence of phases —
 * `requested`, `source-fetched`, `parsed`, `built`, `placed`, `saved`,
 * `attached` — and each one is recorded with a timestamp on the headset
 * diagnostics ring the moment it ends. The next hardware run prints the
 * timeline instead of guessing at it, and a swap that never reaches `attached`
 * says which phase it died in.
 *
 * **Never wait forever inside immersion.** This is the `withTourDeadline` rule
 * from the tour-player hang, applied to the other long path a wearer can be
 * standing inside. A phase that outlives its budget rejects with a sentence
 * naming it, so `growStructure` reports a failure the agent can speak and the
 * page returns to a beating heart, rather than leaving a wearer in front of the
 * tier they already had with nothing on their face saying so.
 *
 * The deadline applies **only while the page is presenting**. A desktop panel
 * has a person watching it who can see a slow load and wait; a wearer cannot,
 * and a Quest 2 is where the unbounded await actually costs minutes. Off a
 * headset every phase passes through untouched and costs one recorded entry.
 */

/** The phases of one in-session source swap, in the order they happen. */
export const SWAP_PHASES = [
  'requested', 'source-fetched', 'parsed', 'built', 'placed', 'saved', 'attached',
] as const;

export type SwapPhase = (typeof SWAP_PHASES)[number];

/**
 * One phase's budget while presenting.
 *
 * Generous on purpose. The dimer tier that provoked this is 6,818 atom sites,
 * and a Quest 2 builds cartoon geometry over that in single-digit seconds; the
 * microtubule wall, the largest tier the device tier allows, is the one that
 * costs tens. Forty-five seconds is past anything a healthy phase can reach and
 * well short of the three minutes the driver waited.
 */
export const SWAP_PHASE_TIMEOUT_MS = 45_000;

/**
 * The whole swap's budget, as the outer net under the per-phase bounds.
 *
 * A swap that has not put the new tier in front of the wearer inside ninety
 * seconds has failed at something, whatever the individual phases say.
 */
export const SWAP_TOTAL_TIMEOUT_MS = 90_000;

/** The diagnostics kind every entry below is filed under. */
export const SWAP_TRACE_KIND = 'grow';

export type SwapPhaseRecord = {
  /** Which phase. */
  phase: SwapPhase;
  /** Milliseconds from the start of the swap to the end of this phase. */
  atMs: number;
  /** Milliseconds this phase itself took. */
  phaseMs: number;
  /** Whether the page was presenting when the phase ended. */
  presenting: boolean;
  /** Set only when the phase ran out of budget. */
  timedOut?: true;
  /** Set only when the phase threw. First line, clamped. */
  failed?: string;
  /**
   * Set only when the phase DID NOT RUN, and why.
   *
   * `attached` used to be recorded on both arms of `if(!dirty && !blocked)`, so
   * a hydration whose save had been refused wrote the same `attached` entry as
   * one that paired. Two hardware runs were read wrongly off that entry before
   * anyone checked whether a panelId had come back. A phase that was skipped
   * now says so on the ring, in the words of the condition that skipped it.
   */
  skipped?: string;
};

export type SwapTraceOptions = {
  /** Where entries go. Defaults to the page's headset diagnostics ring. */
  record?: (kind: string, detail: Record<string, unknown>) => unknown;
  /** Clock, in milliseconds. */
  now?: () => number;
  /** Whether the page is presenting right now. Bounds apply only when it is. */
  presenting?: () => boolean;
  /** One phase's budget while presenting. */
  phaseTimeoutMs?: number;
  /** The whole swap's budget while presenting. */
  totalTimeoutMs?: number;
  /** Timer, so a test can fire a deadline without a real wait. */
  defer?: (callback: () => void, ms: number) => unknown;
  /** Extra fields recorded on every entry of this swap: tier, lesson, sites. */
  context?: Record<string, unknown>;
};

export type SwapTrace = {
  /** Records a phase boundary, bounding `work` when the page is presenting. */
  phase<T>(phase: SwapPhase, work?: Promise<T> | T): Promise<T | undefined>;
  /** Records a phase that was deliberately not run, and the reason. */
  skip(phase: SwapPhase, why: string): void;
  /** Records a swap that ended badly, naming the phase it was in. */
  fail(error: unknown): void;
  /** What has been recorded so far, oldest first. */
  timeline(): readonly SwapPhaseRecord[];
  /** The phase the swap is waiting on, or undefined once `attached` is past. */
  pending(): SwapPhase | undefined;
};

/** Cancel only this phase's cooperative renderer work before recovery queues. */
export async function abortableSwapPhase<T>(trace: SwapTrace, phase: SwapPhase,
  work: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
  const controller = new AbortController();
  try { return await trace.phase(phase, work(controller.signal)); }
  catch (error) { controller.abort(error); throw error; }
}

const firstLine = (error: unknown): string => {
  const text = error instanceof Error ? error.message : String(error);
  return text.split('\n', 1)[0]!.slice(0, 160);
};

const pageRecorder = (kind: string, detail: Record<string, unknown>): unknown => {
  try {
    return (globalThis as { __stereofoldDiagnostics?: { record?: (kind: string, detail: unknown) => unknown } })
      .__stereofoldDiagnostics?.record?.(kind, detail);
  } catch { return undefined; /* Diagnostics are advisory; a swap never fails because of them. */ }
};

/**
 * Await `work`, but never past `timeoutMs`.
 *
 * Deliberately the same shape as `withTourDeadline`: anything that is not a
 * promise passes straight through, and the timer is injectable so a test can
 * fire the deadline against a promise that genuinely never settles — which is
 * exactly what an await scheduled on the window frame clock is inside a live
 * immersive session on Quest Browser.
 */
export function withSwapDeadline<T>(phase: SwapPhase, work: Promise<T> | T | undefined,
  timeoutMs: number,
  defer: (callback: () => void, ms: number) => unknown = (callback, ms) => setTimeout(callback, ms),
): Promise<T | undefined> {
  const pending = work as Promise<T> | undefined;
  if (!pending || typeof pending.then !== 'function') return Promise.resolve(work as T | undefined);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(Error(`Growing the structure ran out of time before its ${phase} step could start.`));
  }
  return new Promise<T | undefined>((resolve, reject) => {
    let settled = false;
    defer(() => {
      if (settled) return;
      settled = true;
      reject(Error(`Growing the structure stalled: its ${phase} step did not finish within `
        + `${Math.round(timeoutMs / 1_000)} seconds in the headset.`));
    }, timeoutMs);
    pending.then(
      value => { if (!settled) { settled = true; resolve(value); } },
      error => { if (!settled) { settled = true; reject(error as Error); } });
  });
}

/**
 * Begin one traced source swap.
 *
 * The returned `phase` is wrapped around each step of the swap in order. It
 * records the boundary either way — a phase that throws is recorded with its
 * message before the error is re-thrown — so the timeline is complete whether
 * the tier landed or not.
 */
export function createSourceSwapTrace(options: SwapTraceOptions = {}): SwapTrace {
  const record = options.record ?? pageRecorder;
  const now = options.now ?? (() => Date.now());
  const presenting = options.presenting ?? (() => false);
  const phaseTimeoutMs = options.phaseTimeoutMs ?? SWAP_PHASE_TIMEOUT_MS;
  const totalTimeoutMs = options.totalTimeoutMs ?? SWAP_TOTAL_TIMEOUT_MS;
  const defer = options.defer;
  const context = options.context ?? {};
  const startedAt = now();
  const entries: SwapPhaseRecord[] = [];
  let lastAt = startedAt;
  let waiting: SwapPhase | undefined;

  const write = (entry: SwapPhaseRecord) => {
    entries.push(entry);
    record(SWAP_TRACE_KIND, { ...context, ...entry });
  };

  return {
    pending: () => waiting,
    timeline: () => entries.slice(),
    skip(phase: SwapPhase, why: string) {
      const at = now();
      write({ phase, atMs: at - startedAt, phaseMs: at - lastAt, presenting: presenting() === true, skipped: firstLine(why) });
      lastAt = at;
      if (phase === 'attached') waiting = undefined;
    },
    fail(error: unknown) {
      write({ phase: waiting ?? 'requested', atMs: now() - startedAt, phaseMs: now() - lastAt,
        presenting: presenting() === true, failed: firstLine(error) });
      waiting = undefined;
    },
    async phase<T>(phase: SwapPhase, work?: Promise<T> | T): Promise<T | undefined> {
      waiting = phase;
      const began = now();
      const live = presenting() === true;
      // The outer net: a late phase inherits whatever is left of the swap's
      // whole budget, so seven phases cannot each spend their own maximum.
      const budget = Math.min(phaseTimeoutMs, totalTimeoutMs - (began - startedAt));
      try {
        const value = live
          ? await withSwapDeadline(phase, work, budget, defer)
          : await (work as Promise<T> | undefined);
        const at = now();
        write({ phase, atMs: at - startedAt, phaseMs: at - began, presenting: live });
        lastAt = at;
        if (phase === 'attached') waiting = undefined;
        return value as T | undefined;
      } catch (error) {
        const at = now();
        const message = firstLine(error);
        write({ phase, atMs: at - startedAt, phaseMs: at - began, presenting: live,
          ...(message.includes('did not finish within') || message.includes('ran out of time') ? { timedOut: true as const } : {}),
          failed: message });
        lastAt = at;
        throw error;
      }
    },
  };
}

/** One line per phase, for a driver log or a report. */
export function describeSwapTimeline(entries: readonly SwapPhaseRecord[]): string {
  if (!entries.length) return 'no swap phases were recorded';
  return entries.map(entry => {
    const suffix = entry.timedOut ? ' TIMED OUT' : entry.failed ? ` FAILED: ${entry.failed}`
      : entry.skipped ? ` SKIPPED: ${entry.skipped}` : '';
    return `${entry.phase} +${(entry.atMs / 1_000).toFixed(1)}s (${(entry.phaseMs / 1_000).toFixed(1)}s)${suffix}`;
  }).join(' · ');
}
