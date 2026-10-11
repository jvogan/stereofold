import { describe, expect, it } from 'vitest';
import { decideRefit } from '../src/fit-decision.js';
import { createFitSuspensionRegistry } from '../src/fit-suspension.js';
import { createSessionGenerationGuard } from '../src/session-generation.js';

describe('generation-owned fit suspension', () => {
  it('re-enables refitting after A reset goes stale and B hydration fails without starting a load', () => {
    const sessions = createSessionGenerationGuard();
    const suspensions = createFitSuspensionRegistry(sessions);
    const requestA = sessions.begin('session-a');
    const resetA = suspensions.acquire(requestA);
    expect(suspensions.isSuspended()).toBe(true);

    // B claims the reused panel while A is awaiting scene settling. If B then
    // exhausts hydration/fallback without a load, no B lease exists to clear
    // A's old boolean for it. Querying suspension must prune A by generation
    // so the next display/geometry refit is allowed.
    sessions.begin('session-b');
    expect(suspensions.isSuspended()).toBe(false);
    expect(decideRefit({
      current: { eyeWidthPx: 300, eyeHeightPx: 400, radius: 20 },
      fitted: undefined,
      suspended: suspensions.isSuspended(),
      pinned: false,
      inTransition: false,
    })).toBe('refit');
    suspensions.release(resetA);
    expect(suspensions.isSuspended()).toBe(false);
  });

  it('keeps concurrent current camera operations suspended until each releases its own lease', () => {
    const sessions = createSessionGenerationGuard();
    const suspensions = createFitSuspensionRegistry(sessions);
    const request = sessions.begin('session-a');
    const reset = suspensions.acquire(request);
    const load = suspensions.acquire(request);

    suspensions.release(reset);
    expect(suspensions.isSuspended()).toBe(true);
    suspensions.release(load);
    expect(suspensions.isSuspended()).toBe(false);
  });
});
