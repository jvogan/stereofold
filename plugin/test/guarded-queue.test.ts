import { describe, expect, it } from 'vitest';
import { createGuardedSerialQueue } from '../src/guarded-queue.js';
import { createSessionGenerationGuard, sessionRequestIsCurrent } from '../src/session-generation.js';

describe('guarded serial appearance work', () => {
  it('suppresses A post-await theme or clear bookkeeping after B takes ownership, then runs B in order', async () => {
    const queue = createGuardedSerialQueue();
    const sessions = createSessionGenerationGuard();
    const requestA = sessions.begin('session-a');
    let markAStarted!: () => void;
    const aStarted = new Promise<void>((resolve) => { markAStarted = resolve; });
    let releaseA!: () => void;
    const aWaiting = new Promise<void>((resolve) => { releaseA = resolve; });
    const events: string[] = [];

    const appearanceA = queue.enqueue(async (isCurrent) => {
      events.push('A:started');
      markAStarted();
      await aWaiting;
      // This mirrors theme/look and hydration-failure clearing: the underlying
      // await cannot be cancelled, but stale A must not make any post-await
      // presentation, UI, or stage-bookkeeping commit.
      if (isCurrent()) events.push('A:committed');
    }, () => sessionRequestIsCurrent(sessions, requestA));

    await aStarted;
    const requestB = sessions.begin('session-b');
    const appearanceB = queue.enqueue(async (isCurrent) => {
      if (isCurrent()) events.push('B:committed');
    }, () => sessionRequestIsCurrent(sessions, requestB));

    releaseA();
    await Promise.all([appearanceA, appearanceB]);

    expect(events).toEqual(['A:started', 'B:committed']);
  });

  it('keeps unscoped local appearance work available', () => {
    const sessions = createSessionGenerationGuard();
    const request = sessions.begin('session-a');
    sessions.begin('session-b');

    expect(sessionRequestIsCurrent(sessions)).toBe(true);
    expect(sessionRequestIsCurrent(sessions, request)).toBe(false);
  });
});
