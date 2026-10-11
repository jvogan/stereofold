import { describe, expect, it } from 'vitest';
import {
  FALLBACK_BACKOFF_MS,
  FALLBACK_MAX_TRIES,
  FALLBACK_UNAVAILABLE_MESSAGE,
  classifyFallbackAttempt,
  createFallbackRetry,
  type FallbackStep,
} from '../src/fallback-retry.js';
import { decideStructureFallback } from '../src/structure-fallback.js';

const CRAMBIN = 'ATOM      1  N   THR A   1      17.047  14.099   3.625  1.00 13.79           N';
const HIT = { kind: 'structure', empty: false, structureText: CRAMBIN, format: 'pdb' } as const;
const at = (seconds: number): string => `2026-09-02T10:00:0${seconds}.000Z`;

describe('classifyFallbackAttempt', () => {
  it('takes an empty cache and a loadable cache as answers', () => {
    expect(classifyFallbackAttempt({ cached: { kind: 'structure', empty: true } }))
      .toEqual({ kind: 'definitive', cached: { kind: 'structure', empty: true } });
    expect(classifyFallbackAttempt({ cached: HIT })).toEqual({ kind: 'definitive', cached: HIT });
    expect(classifyFallbackAttempt({ cached: { kind: 'structure', fixture: 'three-depth-markers' } }))
      .toEqual({ kind: 'definitive', cached: { kind: 'structure', fixture: 'three-depth-markers' } });
  });

  it('takes a throw, a missing result and an unusable one as no answer at all', () => {
    expect(classifyFallbackAttempt({ threw: true, cached: undefined })).toEqual({ kind: 'indefinite', error: 'threw' });
    expect(classifyFallbackAttempt({ cached: undefined })).toEqual({ kind: 'indefinite', error: 'no-result' });
    // An object that says neither "empty" nor "here are the coordinates".
    expect(classifyFallbackAttempt({ cached: { kind: 'structure' } })).toEqual({ kind: 'indefinite', error: 'incomplete' });
    expect(classifyFallbackAttempt({ cached: { kind: 'structure', structureText: '', format: 'pdb' } }))
      .toEqual({ kind: 'indefinite', error: 'malformed' });
    expect(classifyFallbackAttempt({ cached: { kind: 'structure', structureText: CRAMBIN, format: 'xyz' as 'pdb' } }))
      .toEqual({ kind: 'indefinite', error: 'malformed' });
  });

  /**
   * The two modules have to agree, or the panel would loop: an answer this one
   * calls definitive but `decideStructureFallback` cannot act on would end the
   * fallback with nothing drawn and no message.
   */
  it('calls definitive only what decideStructureFallback can act on', () => {
    for (const cached of [
      { kind: 'structure', empty: true },
      HIT,
      { kind: 'structure', fixture: 'three-depth-markers' } as const,
    ]) {
      const attempt = classifyFallbackAttempt({ cached });
      expect(attempt.kind).toBe('definitive');
      const decision = decideStructureFallback({ hasStructure: false, cached });
      expect(['empty', 'fixture', 'load']).toContain(decision.action);
    }
  });
});

describe('createFallbackRetry', () => {
  it('retries a transient failure and takes the answer that follows', () => {
    const retry = createFallbackRetry();
    const first = retry.record({ threw: true, cached: undefined }, at(1));
    expect(first).toEqual({ action: 'retry', delayMs: FALLBACK_BACKOFF_MS[0], tries: 1 });
    expect(retry.snapshot()).toEqual({ tries: 1, lastError: 'threw', done: false, at: at(1) });

    const second = retry.record({ cached: HIT }, at(2));
    expect(second).toEqual({ action: 'answer', cached: HIT });
    expect(retry.snapshot()).toEqual({ tries: 2, lastError: 'threw', done: true, at: at(2) });
    // Done means done: a later result cannot restart it.
    expect(retry.record({ cached: HIT }, at(3))).toEqual({ action: 'cancelled' });
    expect(retry.snapshot().tries).toBe(2);
  });

  it('retries a cache whose coordinates looked loadable but Mol* rejected during hydration', () => {
    const retry = createFallbackRetry();
    // A pasted payload can pass the server’s broad length/schema boundary yet
    // still fail Mol* parsing. It is not a hydrated answer just because the
    // loader promise resolved after catching that error.
    expect(retry.record({ cached: HIT, loadFailed: true }, at(1)))
      .toEqual({ action: 'retry', delayMs: FALLBACK_BACKOFF_MS[0], tries: 1 });
    expect(retry.snapshot()).toEqual({ tries: 1, lastError: 'malformed', done: false, at: at(1) });

    expect(retry.record({ cached: HIT, loadFailed: true }, at(2)))
      .toEqual({ action: 'retry', delayMs: FALLBACK_BACKOFF_MS[1], tries: 2 });
  });

  it('walks the backoff and gives up after the fifth try', () => {
    const retry = createFallbackRetry();
    const steps: FallbackStep[] = [];
    for (let attempt = 0; attempt < FALLBACK_MAX_TRIES; attempt += 1) {
      steps.push(retry.record({ threw: true, cached: undefined }, at(attempt)));
    }
    expect(steps.slice(0, 4)).toEqual([
      { action: 'retry', delayMs: 500, tries: 1 },
      { action: 'retry', delayMs: 1_000, tries: 2 },
      { action: 'retry', delayMs: 2_000, tries: 3 },
      { action: 'retry', delayMs: 4_000, tries: 4 },
    ]);
    expect(steps[4]).toEqual({ action: 'exhausted', lastError: 'threw' });
    expect(retry.snapshot()).toEqual({ tries: 5, lastError: 'threw', done: true, at: at(4) });
    // 7.5 s of asking before the panel says anything.
    expect(FALLBACK_BACKOFF_MS.reduce((total, gap) => total + gap, 0)).toBe(7_500);
    expect(FALLBACK_UNAVAILABLE_MESSAGE).toMatch(/Ask for it again/u);
  });

  it('carries the last error kind, whichever kind it was', () => {
    const retry = createFallbackRetry();
    retry.record({ threw: true, cached: undefined }, at(1));
    expect(retry.snapshot().lastError).toBe('threw');
    retry.record({ cached: { kind: 'structure' } }, at(2));
    expect(retry.snapshot().lastError).toBe('incomplete');
    retry.record({ cached: { kind: 'structure', structureText: CRAMBIN, format: 'cif' as 'pdb' } }, at(3));
    expect(retry.snapshot().lastError).toBe('malformed');
  });

  /**
   * The `open`-during-the-backoff case. That result has already loaded, or is
   * loading, the coordinates this fallback was going to ask for, so retrying
   * into it would load the same structure a second time.
   */
  it('stops for good when a load takes the stage during a backoff', () => {
    const retry = createFallbackRetry();
    expect(retry.record({ threw: true, cached: undefined }, at(1)).action).toBe('retry');
    expect(retry.cancel(at(2))).toEqual({ action: 'cancelled' });
    expect(retry.snapshot()).toEqual({ tries: 1, lastError: 'threw', done: true, at: at(2) });
    expect(retry.record({ threw: true, cached: undefined }, at(3))).toEqual({ action: 'cancelled' });
    expect(retry.snapshot().tries).toBe(1);
  });

  it('ends on the first try when the server says it has nothing', () => {
    const retry = createFallbackRetry();
    const empty = { kind: 'structure', empty: true } as const;
    expect(retry.record({ cached: empty }, at(1))).toEqual({ action: 'answer', cached: empty });
    expect(retry.snapshot()).toEqual({ tries: 1, done: true, at: at(1) });
    expect(decideStructureFallback({ hasStructure: false, cached: empty })).toEqual({ action: 'empty' });
  });

  it('never retries instantly when the backoff table runs short of the try count', () => {
    const retry = createFallbackRetry({ maxTries: 4, backoffMs: [250] });
    const delays = [0, 1, 2].map((n) => retry.record({ threw: true, cached: undefined }, at(n)));
    expect(delays).toEqual([
      { action: 'retry', delayMs: 250, tries: 1 },
      { action: 'retry', delayMs: 250, tries: 2 },
      { action: 'retry', delayMs: 250, tries: 3 },
    ]);
    expect(retry.record({ threw: true, cached: undefined }, at(4)).action).toBe('exhausted');
  });
});
