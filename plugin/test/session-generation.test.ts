import { describe, expect, it } from 'vitest';
import {
  createSessionGenerationGuard,
  decideToolResultSession,
  hydrationLoadCompletion,
  sessionRequestIsCurrent,
} from '../src/session-generation.js';

const EPOCH_A = '11111111-1111-4111-8111-111111111111';
const EPOCH_B = '22222222-2222-4222-8222-222222222222';

describe('viewer session request generations', () => {
  it('discards late A after a different session B takes ownership', async () => {
    const guard = createSessionGenerationGuard();
    const openA = guard.begin('session-a');
    let resolveA!: (value: string) => void;
    const responseA = new Promise<string>((resolve) => { resolveA = resolve; });
    const applied: string[] = [];
    const hydrateA = responseA.then((value) => {
      if (guard.isCurrent(openA)) applied.push(value);
    });

    const openB = guard.begin('session-b');
    applied.push('B');
    resolveA('A');
    await hydrateA;

    expect(guard.isCurrent(openA)).toBe(false);
    expect(guard.isCurrent(openB)).toBe(true);
    expect(guard.sessionId).toBe('session-b');
    expect(applied).toEqual(['B']);
  });

  it('invalidates an older request when the same session is opened again', () => {
    const guard = createSessionGenerationGuard();
    const firstSource = guard.begin('same-session');
    const secondSource = guard.begin('same-session');

    expect(secondSource.generation).toBe(firstSource.generation + 1);
    expect(guard.isCurrent(firstSource)).toBe(false);
    expect(guard.isCurrent(secondSource)).toBe(true);
  });

  it('invalidates timers captured before the first open', () => {
    const guard = createSessionGenerationGuard();
    const mountTimer = guard.capture();
    guard.begin('session-a');
    expect(guard.isCurrent(mountTimer)).toBe(false);
  });

  it('treats unscoped local work as current while rejecting a superseded session request', () => {
    const guard = createSessionGenerationGuard();
    const requestA = guard.begin('session-a');
    guard.begin('session-b');

    expect(sessionRequestIsCurrent(guard)).toBe(true);
    expect(sessionRequestIsCurrent(guard, requestA)).toBe(false);
  });

  it('blocks post-await load mutations after ownership changes', async () => {
    const guard = createSessionGenerationGuard();
    const requestA = guard.begin('session-a');
    let continueLoad!: () => void;
    const boundary = new Promise<void>((resolve) => { continueLoad = resolve; });
    const mutations: string[] = [];
    const loadA = (async () => {
      mutations.push('A:started');
      await boundary;
      if (!guard.isCurrent(requestA)) return;
      mutations.push('A:toast-and-final-state');
    })();

    guard.begin('session-b');
    continueLoad();
    await loadA;

    expect(mutations).toEqual(['A:started']);
  });

  it('reports a hydration as stale when ownership changes during its load', async () => {
    const guard = createSessionGenerationGuard();
    const requestA = guard.begin('session-a');
    let finishLoad!: () => void;
    const loadFinished = new Promise<void>((resolve) => { finishLoad = resolve; });

    const completion = (async () => {
      await loadFinished;
      return hydrationLoadCompletion(guard, requestA);
    })();

    guard.begin('session-b');
    finishLoad();
    await expect(completion).resolves.toBe('stale');
  });

  it('does not call a caught parser failure hydrated while ownership is still current', () => {
    const guard = createSessionGenerationGuard();
    const request = guard.begin('session-a');

    expect(hydrationLoadCompletion(guard, request, false)).toBe('failed');
  });

  it('does not let a stale replayed reset fit/pin or restore A motion after B claims the frame', async () => {
    const guard = createSessionGenerationGuard();
    const requestA = guard.begin('session-a');
    let releaseSettle!: () => void;
    const settling = new Promise<void>((resolve) => { releaseSettle = resolve; });
    const events: string[] = [];

    const replayedResetA = (async () => {
      const isCurrent = (): boolean => guard.isCurrent(requestA);
      events.push('A:park-motion');
      try {
        await settling;
        if (!isCurrent()) return;
        events.push('A:fit-or-pin');
      } finally {
        if (isCurrent()) events.push('A:restore-motion');
      }
    })();

    guard.begin('session-b');
    releaseSettle();
    await replayedResetA;

    expect(events).toEqual(['A:park-motion']);
  });

  it('does not let a local toolbar reset fit/pin or restore after B opens', async () => {
    const guard = createSessionGenerationGuard();
    guard.begin('session-a');
    // This is the click-time capture passed by the local Reset toolbar action,
    // rather than a request created by a server replay.
    const localResetA = guard.capture();
    let releaseSettle!: () => void;
    const settling = new Promise<void>((resolve) => { releaseSettle = resolve; });
    const events: string[] = [];

    const resetA = (async () => {
      const isCurrent = (): boolean => guard.isCurrent(localResetA);
      events.push('A:park-motion');
      try {
        await settling;
        if (!isCurrent()) return;
        events.push('A:fit-or-pin');
      } finally {
        if (isCurrent()) events.push('A:restore-motion');
      }
    })();

    guard.begin('session-b');
    releaseSettle();
    await resetA;

    expect(events).toEqual(['A:park-motion']);
  });

  it('keeps newer same-session state when delayed A arrives after B', () => {
    const guard = createSessionGenerationGuard();
    expect(guard.acceptRenderToken(1, EPOCH_A)).toBe(true);
    guard.begin('same-session', 1);

    // B's off snapshot is delivered first. A's earlier parallel snapshot has
    // the same opaque session capability but must not repaint the controls.
    expect(guard.acceptStateRevision(2, EPOCH_A)).toBe(true);
    expect(guard.acceptStateRevision(1, EPOCH_A)).toBe(false);
    expect(guard.stateRevision).toBe(2);
  });

  it('lets an older-state open hydrate coordinates without rolling its session state back', () => {
    const guard = createSessionGenerationGuard();
    expect(guard.acceptRenderToken(1, EPOCH_A)).toBe(true);
    const first = guard.begin('same-session', 1);
    expect(guard.acceptStateRevision(1, EPOCH_A)).toBe(true);
    // A later mode/control snapshot committed state revision 2.
    expect(guard.acceptStateRevision(2, EPOCH_A)).toBe(true);

    // A delayed source-bearing open has a newer render token, so it can own
    // coordinates, but begin preserves the same session’s state revision.
    expect(guard.acceptRenderToken(3, EPOCH_A)).toBe(true);
    const source = guard.begin('same-session', 3);
    expect(guard.isCurrent(first)).toBe(false);
    expect(guard.isCurrent(source)).toBe(true);
    expect(guard.acceptStateRevision(1, EPOCH_A)).toBe(false);
    expect(guard.stateRevision).toBe(2);
  });
});

describe('tool-result ownership decisions', () => {
  it('rejects delayed older structure results before they reclaim a reused frame', () => {
    const guard = createSessionGenerationGuard();

    // The server received A first (token 1), B second (token 2), but a host
    // delivered B to this reused frame first. B must claim ownership, and the
    // later delivery of A must be discarded before `begin` can run for it.
    expect(decideToolResultSession({
      currentSessionId: guard.sessionId,
      currentServerEpoch: guard.serverEpoch,
      currentRenderToken: guard.renderToken,
      incomingSessionId: 'session-b',
      incomingServerEpoch: EPOCH_A,
      incomingRenderToken: 2,
      structureReplacement: true,
    })).toBe('begin');
    expect(guard.acceptRenderToken(2, EPOCH_A)).toBe(true);
    const openB = guard.begin('session-b', 2);

    expect(decideToolResultSession({
      currentSessionId: guard.sessionId,
      currentServerEpoch: guard.serverEpoch,
      currentRenderToken: guard.renderToken,
      incomingSessionId: 'session-a',
      incomingServerEpoch: EPOCH_A,
      incomingRenderToken: 1,
      structureReplacement: true,
    })).toBe('discard');
    expect(guard.acceptRenderToken(1, EPOCH_A)).toBe(false);
    expect(guard.isCurrent(openB)).toBe(true);
    expect(guard.sessionId).toBe('session-b');
    expect(guard.renderToken).toBe(2);

    // A structure-bearing legacy/malformed result without a token is not a
    // safe fallback: accepting it would reintroduce the ordering race.
    expect(decideToolResultSession({
      currentSessionId: guard.sessionId,
      currentRenderToken: guard.renderToken,
      incomingSessionId: 'session-a',
      structureReplacement: true,
    })).toBe('discard');

    expect(decideToolResultSession({
      currentSessionId: 'session-b',
      incomingSessionId: 'session-a',
      structureReplacement: false,
    })).toBe('discard');
  });

  it('keeps current-session non-structure results without advancing generation', () => {
    expect(decideToolResultSession({
      currentSessionId: 'session-b',
      incomingSessionId: 'session-b',
      structureReplacement: false,
    })).toBe('keep');
  });

  it('accepts a lower token from a new server epoch, then rejects the retired epoch', () => {
    const guard = createSessionGenerationGuard();

    expect(guard.acceptRenderToken(20, EPOCH_A)).toBe(true);
    const old = guard.begin('same-session', 20);
    expect(guard.acceptStateRevision(8, EPOCH_A)).toBe(true);

    // A process restart starts at render token 1. The never-seen epoch is a
    // new lifecycle, so the low counter is valid and old state freshness is
    // reset with it.
    expect(decideToolResultSession({
      currentSessionId: guard.sessionId,
      currentServerEpoch: guard.serverEpoch,
      currentRenderToken: guard.renderToken,
      incomingSessionId: 'same-session',
      incomingServerEpoch: EPOCH_B,
      incomingRenderToken: 1,
      incomingServerEpochRetired: guard.isRetiredServerEpoch(EPOCH_B),
      structureReplacement: true,
    })).toBe('begin');
    expect(guard.acceptRenderToken(1, EPOCH_B)).toBe(true);
    const restarted = guard.begin('same-session', 1);
    expect(guard.isCurrent(old)).toBe(false);
    expect(guard.isCurrent(restarted)).toBe(true);
    expect(guard.serverEpoch).toBe(EPOCH_B);
    expect(guard.renderToken).toBe(1);
    expect(guard.stateRevision).toBeUndefined();
    expect(guard.isRetiredServerEpoch(EPOCH_A)).toBe(true);

    // A delayed old-server result can have a higher number than the new
    // process's counter, but its retired lifecycle can never reclaim a frame.
    expect(decideToolResultSession({
      currentSessionId: guard.sessionId,
      currentServerEpoch: guard.serverEpoch,
      currentRenderToken: guard.renderToken,
      incomingSessionId: 'same-session',
      incomingServerEpoch: EPOCH_A,
      incomingRenderToken: 21,
      incomingServerEpochRetired: guard.isRetiredServerEpoch(EPOCH_A),
      structureReplacement: true,
    })).toBe('discard');
    expect(guard.acceptRenderToken(21, EPOCH_A)).toBe(false);
    expect(guard.isCurrent(restarted)).toBe(true);
  });
});
