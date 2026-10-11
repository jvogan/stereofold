import { describe, expect, it } from 'vitest';
import {
  abortableSwapPhase, createSourceSwapTrace, describeSwapTimeline, SWAP_PHASES, withSwapDeadline,
  type SwapPhase, type SwapPhaseRecord,
} from '../src/source-swap-trace.js';

/** Let every already-resolved await in the swap under test run to its next one. */
const flush = async (turns = 30) => { for (let turn = 0; turn < turns; turn += 1) await Promise.resolve(); };

it('aborts only the timed-out phase before recovery, leaving the next phase usable', async () => {
  const timers = fakeTimers();
  const trace = createSourceSwapTrace({ ...timers, presenting: () => true, phaseTimeoutMs: 45, record: () => {} });
  let failedSignal: AbortSignal | undefined;
  let cancelled = false;
  const pending = abortableSwapPhase(trace, 'placed', signal => {
    failedSignal = signal;
    return new Promise((_, reject) => signal.addEventListener('abort', () => {
      cancelled = true; reject(signal.reason);
    }, { once: true }));
  });
  const failure = expect(pending).rejects.toThrow('did not finish within');
  await timers.fire();
  await failure;
  expect(cancelled).toBe(true);
  expect(failedSignal?.aborted).toBe(true);
  await expect(abortableSwapPhase(trace, 'built', async signal => {
    expect(signal.aborted).toBe(false);
    expect(signal).not.toBe(failedSignal);
    return 'restored';
  })).resolves.toBe('restored');
});

/**
 * A clock and a timer queue a test can drive, so a deadline can fire against a
 * promise that genuinely never settles without waiting for one.
 */
function fakeTimers() {
  let clock = 0;
  const queue: Array<{ at: number; run: () => void }> = [];
  return {
    now: () => clock,
    defer: (run: () => void, ms: number) => { queue.push({ at: clock + ms, run }); },
    /** Advance to the next deadline and fire it, once one has been armed. */
    async fire() {
      await flush();
      const next = queue.shift();
      if (!next) throw Error('nothing was deferred');
      clock = Math.max(clock, next.at);
      next.run();
      await Promise.resolve();
    },
    advance(ms: number) { clock += ms; },
    pending: () => queue.length,
  };
}

/** The diagnostics ring, as a list. */
function recorder() {
  const entries: Array<{ kind: string; detail: Record<string, unknown> }> = [];
  return { entries, record: (kind: string, detail: Record<string, unknown>) => { entries.push({ kind, detail }); } };
}

/**
 * The hardware fact this whole module exists for.
 *
 * Quest Browser stops servicing the window's `requestAnimationFrame` for the
 * whole length of an immersive session; only `XRSession.requestAnimationFrame`
 * runs. The emulator (IWER) keeps window rAF alive, which is exactly why it
 * does the same swap in three seconds and cannot reproduce the stall.
 */
function questFrameClocks() {
  const sessionFrames: Array<() => void> = [];
  return {
    /** Never fires while presenting, like the real headset. */
    windowFrame: (_callback: () => void) => { /* dropped on the floor */ },
    sessionFrame: (callback: () => void) => { sessionFrames.push(callback); },
    /** One XR frame. */
    tick() { const next = sessionFrames.shift(); next?.(); },
  };
}

const forever = () => new Promise<never>(() => { /* an await behind a frame that never comes */ });

describe('withSwapDeadline', () => {
  it('passes a non-promise straight through', async () => {
    await expect(withSwapDeadline('built', 7, 1_000)).resolves.toBe(7);
  });

  it('names the phase and the budget when the work never settles', async () => {
    const timers = fakeTimers();
    const bounded = withSwapDeadline('built', forever(), 45_000, timers.defer);
    const assertion = expect(bounded).rejects.toThrow(/its built step did not finish within 45 seconds in the headset/);
    await timers.fire();
    await assertion;
  });

  it('lets a deadline that never arrives leave a settled promise alone', async () => {
    const timers = fakeTimers();
    await expect(withSwapDeadline('saved', Promise.resolve('ok'), 45_000, timers.defer)).resolves.toBe('ok');
    expect(timers.pending()).toBe(1); // Armed, never fired: the work won first.
  });
});

describe('createSourceSwapTrace', () => {
  it('records every phase of a swap that lands, with timestamps', async () => {
    const timers = fakeTimers();
    const log = recorder();
    const trace = createSourceSwapTrace({ record: log.record, now: timers.now, presenting: () => true,
      defer: timers.defer, context: { tier: 'dimer', atomSites: 6_818 } });
    for (const phase of SWAP_PHASES) {
      timers.advance(1_000);
      await trace.phase(phase);
    }
    expect(log.entries.map(entry => entry.kind)).toEqual(SWAP_PHASES.map(() => 'grow'));
    expect(log.entries.map(entry => entry.detail.phase)).toEqual([...SWAP_PHASES]);
    expect(log.entries.at(-1)!.detail).toMatchObject({ phase: 'attached', atMs: 7_000, tier: 'dimer', atomSites: 6_818 });
    expect(trace.pending()).toBeUndefined();
    expect(describeSwapTimeline(trace.timeline())).toContain('built +4.0s');
  });

  it('leaves a desktop panel unbounded', async () => {
    const timers = fakeTimers();
    const log = recorder();
    const trace = createSourceSwapTrace({ record: log.record, now: timers.now, presenting: () => false, defer: timers.defer });
    let release: (value: string) => void = () => {};
    const work = new Promise<string>(resolve => { release = resolve; });
    const phase = trace.phase('built', work);
    expect(timers.pending()).toBe(0); // No deadline was armed at all.
    release('built eventually');
    await expect(phase).resolves.toBe('built eventually');
  });

  it('spends the whole-swap budget rather than a full budget per phase', async () => {
    const timers = fakeTimers();
    const log = recorder();
    const trace = createSourceSwapTrace({ record: log.record, now: timers.now, presenting: () => true,
      defer: timers.defer, phaseTimeoutMs: 45_000, totalTimeoutMs: 50_000 });
    timers.advance(40_000);
    const phase = trace.phase('built', forever());
    const assertion = expect(phase).rejects.toThrow(/did not finish within 10 seconds/);
    await timers.fire();
    await assertion;
    expect(log.entries.at(-1)!.detail).toMatchObject({ phase: 'built', timedOut: true });
  });

  it('records the phase a swap died in, then re-throws', async () => {
    const log = recorder();
    const trace = createSourceSwapTrace({ record: log.record, presenting: () => true, now: () => 0 });
    await expect(trace.phase('parsed', Promise.reject(Error('Inspection hydration did not match the opened session.'))))
      .rejects.toThrow(/did not match/);
    expect(log.entries.at(-1)!.detail).toMatchObject({ phase: 'parsed', failed: 'Inspection hydration did not match the opened session.' });
    expect(log.entries.at(-1)!.detail.timedOut).toBeUndefined();
  });

  it('survives a recorder that throws', async () => {
    const trace = createSourceSwapTrace({ record: () => { throw Error('ring buffer is gone'); }, presenting: () => true });
    await expect(trace.phase('saved')).rejects.toThrow(/ring buffer is gone/);
  });
});

/**
 * The stall itself, simulated.
 *
 * `runSwap` is the shape of the real path: `hydrate` builds the new tier and,
 * somewhere inside that build, awaits a frame. The only difference between the
 * two runs below is which clock that await is scheduled on — the window's,
 * which a presenting Quest Browser never services, or the XR session's, which
 * is the one Mol*'s Canvas3D uses once `webgl.xr.set` has attached. The
 * emulator cannot show this because IWER keeps window rAF alive.
 */
async function runSwap({ frame, timers, log }: {
  frame: (callback: () => void) => void;
  timers: ReturnType<typeof fakeTimers>;
  log: ReturnType<typeof recorder>;
}): Promise<{ landed: boolean; timeline: readonly SwapPhaseRecord[]; error?: string }> {
  const trace = createSourceSwapTrace({ record: log.record, now: timers.now, presenting: () => true,
    defer: timers.defer, phaseTimeoutMs: 45_000, context: { tier: 'dimer', atomSites: 6_818 } });
  const step = async (phase: SwapPhase, work?: Promise<unknown>) => {
    timers.advance(500);
    await trace.phase(phase, work);
  };
  try {
    await step('requested');
    await step('source-fetched');
    await step('parsed');
    // The build ends in a frame wait, which is where the swap actually lives.
    await step('built', new Promise<void>(resolve => { frame(resolve); }));
    await step('placed');
    await step('saved');
    await step('attached');
    return { landed: true, timeline: trace.timeline() };
  } catch (error) {
    trace.fail(error);
    return { landed: false, timeline: trace.timeline(), error: (error as Error).message };
  }
}

describe('a source swap while the window frame clock is dead', () => {
  it('used to hang forever, and is now reported against the phase it stalled in', async () => {
    const timers = fakeTimers();
    const log = recorder();
    const clocks = questFrameClocks();
    const swap = runSwap({ frame: clocks.windowFrame, timers, log });
    // Nothing will ever resolve that frame. Fire the phase deadline instead.
    await timers.fire();
    const result = await swap;
    expect(result.landed).toBe(false);
    expect(result.error).toMatch(/its built step did not finish within 45 seconds in the headset/);
    expect(result.timeline.map(entry => entry.phase)).toEqual(['requested', 'source-fetched', 'parsed', 'built', 'built']);
    expect(result.timeline.find(entry => entry.timedOut)?.phase).toBe('built');
    // And the wearer's Mac can read where it went, to the tenth of a second.
    expect(describeSwapTimeline(result.timeline)).toContain('built +47.0s (45.0s) TIMED OUT');
  });

  it('completes when the same wait is scheduled on the presenting session instead', async () => {
    const timers = fakeTimers();
    const log = recorder();
    const clocks = questFrameClocks();
    const swap = runSwap({ frame: clocks.sessionFrame, timers, log });
    await flush();
    clocks.tick(); // One XR frame: the clock Mol* actually runs on in immersion.
    const result = await swap;
    expect(result.landed).toBe(true);
    expect(result.timeline.map(entry => entry.phase)).toEqual([...SWAP_PHASES]);
    expect(result.timeline.some(entry => entry.timedOut)).toBe(false);
    expect(result.timeline.at(-1)!.atMs).toBe(3_500);
    expect(log.entries.every(entry => entry.detail.tier === 'dimer')).toBe(true);
  });
});
