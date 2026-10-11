/**
 * How many times a fresh panel asks the server for the structure, and when it
 * stops asking.
 *
 * `./structure-fallback.ts` decides what to do with an *answer*. This module
 * decides whether an answer was given at all, because the two are not the same
 * question and conflating them was a shipped defect: `runStructureFallback`
 * marked itself done before the `get_structure` call, wrapped the call in a
 * try/catch that turned any failure into `cached = undefined`, and
 * `decideStructureFallback` reads `undefined` as "the server has never opened
 * anything". So one rejected call — the host still wiring the app up, a
 * timeout, a rate limit — left a panel showing "Nothing loaded yet." for the
 * rest of its life, in a conversation that had a structure on the server the
 * whole time. In the real host `get_structure` is the only way a fresh panel
 * gets its structure *and* its stereo mode, so that defect reads as "the
 * viewer is blank" and nothing in the panel says why.
 *
 * The rule here is that only a *definitive* answer ends the fallback:
 *
 * - a cache that says `empty: true` — the server really has nothing;
 * - a cache carrying the depth fixture, or coordinates in a format this viewer
 *   parses — there is something to load.
 *
 * Everything else is indefinite: the panel does not know, and a panel that
 * does not know must not claim the session is empty. It retries on a bounded
 * backoff and, only after the last try, says what actually happened.
 *
 * Pure: no timers, no tool calls, no DOM. The viewer supplies the clock and
 * runs the delay, which is what makes every branch below a unit test.
 */

import type { CachedStructure } from './structure-fallback.js';

/** Attempts, including the first. Four gaps, so five calls at most. */
export const FALLBACK_MAX_TRIES = 5;

/**
 * The gaps between tries, ms.
 *
 * Doubling from half a second: short enough that a host that is merely slow to
 * wire the app up is caught inside the first second, long enough that five
 * tries span 7.5 s rather than hammering a rate-limited channel. The last gap
 * is the one before the fifth and final try.
 */
export const FALLBACK_BACKOFF_MS: readonly number[] = [500, 1_000, 2_000, 4_000];

/**
 * What the stage says when every try failed.
 *
 * Deliberately not the empty state. "Nothing loaded yet" is a claim about the
 * session and would be a lie here; this says what the panel actually knows,
 * and names the one action that fixes it.
 */
export const FALLBACK_UNAVAILABLE_MESSAGE = 'Could not fetch the structure from the server. Ask for it again.';

/** Why an attempt did not answer the question. */
export type FallbackErrorKind =
  /** The tool call rejected. */
  | 'threw'
  /** It resolved without a `structuredContent` object. */
  | 'no-result'
  /** An object carrying neither `empty` nor a `structureText`. */
  | 'incomplete'
  /** A structure that this viewer cannot parse: empty text, or an unknown format. */
  | 'malformed';

/** One `stereo_structure.get_structure` call, as the caller saw it. */
export interface FallbackAttemptInput {
  /** True when the call rejected. `cached` is then ignored. */
  threw?: boolean;
  /**
   * The cache looked syntactically loadable but Mol* rejected it while
   * hydrating. Treat that exactly like malformed coordinate text rather than
   * declaring the panel hydrated from a resolved loader promise.
   */
  loadFailed?: boolean;
  /** `structuredContent` of the result, or undefined when there was none. */
  cached: CachedStructure | undefined;
}

/** Whether an attempt answered the question, and why not when it did not. */
export type FallbackAttempt =
  | { kind: 'definitive'; cached: CachedStructure }
  | { kind: 'indefinite'; error: FallbackErrorKind };

/**
 * Read one attempt.
 *
 * The definitive cases are exactly the ones `decideStructureFallback` can act
 * on without guessing, so the two agree by construction: every `definitive`
 * result below produces `empty`, `fixture` or `load` there, and nothing else
 * ever reaches it.
 */
export function classifyFallbackAttempt(input: FallbackAttemptInput): FallbackAttempt {
  if (input.threw === true) return { kind: 'indefinite', error: 'threw' };
  if (input.loadFailed === true) return { kind: 'indefinite', error: 'malformed' };
  const cached = input.cached;
  if (cached == null || typeof cached !== 'object') return { kind: 'indefinite', error: 'no-result' };
  if (cached.empty === true) return { kind: 'definitive', cached };
  if (cached.fixture === 'three-depth-markers') return { kind: 'definitive', cached };
  const text = cached.structureText;
  const format = cached.format;
  if (text === undefined && format === undefined) return { kind: 'indefinite', error: 'incomplete' };
  if (typeof text !== 'string' || text.length === 0) return { kind: 'indefinite', error: 'malformed' };
  if (format !== 'pdb' && format !== 'mmcif') return { kind: 'indefinite', error: 'malformed' };
  return { kind: 'definitive', cached };
}

/** What the caller does next. */
export type FallbackStep =
  /** The server answered. Hand this to `decideStructureFallback`. */
  | { action: 'answer'; cached: CachedStructure }
  /** Ask again after `delayMs`. The empty state stays hidden. */
  | { action: 'retry'; delayMs: number; tries: number }
  /** Every try failed. Say so on the stage. */
  | { action: 'exhausted'; lastError: FallbackErrorKind }
  /** A load owns the stage, or the fallback already finished. Do nothing. */
  | { action: 'cancelled' };

/** The retry state, as `diagnostics.state.fallback` carries it. */
export interface FallbackRetryState {
  /** Attempts made so far, including the one in flight when it has returned. */
  tries: number;
  /** Why the last indefinite attempt was indefinite. */
  lastError?: FallbackErrorKind;
  /** True once the fallback has stopped, however it stopped. */
  done: boolean;
  /** ISO time of the last transition. */
  at?: string;
}

export interface FallbackRetry {
  /** Fold one attempt in and say what to do next. */
  record(input: FallbackAttemptInput, at: string): FallbackStep;
  /**
   * Stop: something else owns the stage.
   *
   * An `open` result that arrives during a backoff has already loaded, or is
   * loading, the structure this fallback was going to ask for. Retrying into
   * that would be a second load of the same coordinates.
   */
  cancel(at: string): FallbackStep;
  /** A copy, safe to put in a diagnostics object. */
  snapshot(): FallbackRetryState;
}

export function createFallbackRetry(options: {
  maxTries?: number;
  backoffMs?: readonly number[];
} = {}): FallbackRetry {
  const maxTries = Math.max(1, options.maxTries ?? FALLBACK_MAX_TRIES);
  const backoff = options.backoffMs ?? FALLBACK_BACKOFF_MS;
  let tries = 0;
  let lastError: FallbackErrorKind | undefined;
  let done = false;
  let at: string | undefined;

  const finish = (when: string): void => {
    done = true;
    at = when;
  };

  return {
    record(input: FallbackAttemptInput, when: string): FallbackStep {
      if (done) return { action: 'cancelled' };
      tries += 1;
      at = when;
      const attempt = classifyFallbackAttempt(input);
      if (attempt.kind === 'definitive') {
        finish(when);
        return { action: 'answer', cached: attempt.cached };
      }
      lastError = attempt.error;
      if (tries >= maxTries) {
        finish(when);
        return { action: 'exhausted', lastError: attempt.error };
      }
      // The gap after try n is the nth entry; the table is shorter than the
      // try count by one, and a short table repeats its last gap rather than
      // retrying instantly.
      const delayMs = backoff[Math.min(tries - 1, backoff.length - 1)] ?? 0;
      return { action: 'retry', delayMs, tries };
    },
    cancel(when: string): FallbackStep {
      if (!done) finish(when);
      return { action: 'cancelled' };
    },
    snapshot(): FallbackRetryState {
      return {
        tries,
        ...(lastError === undefined ? {} : { lastError }),
        done,
        ...(at === undefined ? {} : { at }),
      };
    },
  };
}
