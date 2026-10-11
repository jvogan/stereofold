import { describe, expect, it } from 'vitest';
import { createDebouncedSender, type DebouncedSenderTimers } from '../src/view-sync.js';

/** A clock that runs only when a test advances it. */
function fakeTimers(): DebouncedSenderTimers & { advance(ms: number): void; nowMs: number } {
  let now = 0;
  let nextHandle = 1;
  const scheduled = new Map<number, { at: number; callback: () => void }>();
  return {
    set(callback, delayMs) {
      const handle = nextHandle++;
      scheduled.set(handle, { at: now + delayMs, callback });
      return handle;
    },
    clear(handle) {
      scheduled.delete(handle);
    },
    advance(ms) {
      now += ms;
      for (const [handle, entry] of [...scheduled]) {
        if (entry.at <= now) {
          scheduled.delete(handle);
          entry.callback();
        }
      }
    },
    get nowMs() {
      return now;
    },
  };
}

describe('the debounce in front of stereo_structure.sync_view', () => {
  it('collapses a slider drag into one call', () => {
    const timers = fakeTimers();
    const sent: number[] = [];
    let depth = 20;
    const sender = createDebouncedSender({
      read: () => depth,
      send: (payload) => sent.push(payload),
      delayMs: 250,
      timers,
    });

    // Forty input events over 200 ms, which is what dragging Depth across the
    // slider produces. This once reached the server not at
    // all; it must now reach it exactly once.
    for (let step = 0; step < 40; step++) {
      depth = 20 + step;
      sender.request();
      timers.advance(5);
    }
    expect(sent).toEqual([]);
    expect(sender.pending).toBe(true);

    timers.advance(250);
    expect(sent).toEqual([59]);
    expect(sender.pending).toBe(false);
  });

  it('sends the value the drag landed on, not the one it started from', () => {
    const timers = fakeTimers();
    const sent: number[] = [];
    let depth = 0;
    const sender = createDebouncedSender({ read: () => depth, send: (v) => sent.push(v), delayMs: 250, timers });

    depth = 5;
    sender.request();
    timers.advance(100);
    depth = 40;
    sender.request();
    timers.advance(250);

    expect(sent).toEqual([40]);
  });

  it('sends again once the quiet period has actually elapsed', () => {
    const timers = fakeTimers();
    const sent: string[] = [];
    let value = 'first';
    const sender = createDebouncedSender({ read: () => value, send: (v) => sent.push(v), delayMs: 250, timers });

    sender.request();
    timers.advance(250);
    value = 'second';
    sender.request();
    timers.advance(249);
    expect(sent).toEqual(['first']);
    timers.advance(1);
    expect(sent).toEqual(['first', 'second']);
    expect(sender.sentCount).toBe(2);
  });

  it('flushes a pending send, and does nothing when none is pending', () => {
    const timers = fakeTimers();
    const sent: string[] = [];
    const sender = createDebouncedSender({ read: () => 'state', send: (v) => sent.push(v), delayMs: 250, timers });

    // The panel going away must not throw the last adjustment away.
    sender.request();
    sender.flush();
    expect(sent).toEqual(['state']);
    expect(sender.pending).toBe(false);

    sender.flush();
    expect(sent).toEqual(['state']);
    timers.advance(1000);
    expect(sent).toEqual(['state']);
  });

  it('cancels a pending send without making it', () => {
    const timers = fakeTimers();
    const sent: string[] = [];
    const sender = createDebouncedSender({ read: () => 'state', send: (v) => sent.push(v), delayMs: 250, timers });

    sender.request();
    sender.cancel();
    timers.advance(1000);
    expect(sent).toEqual([]);
    expect(sender.sentCount).toBe(0);
  });

  it('never reads the state for a send it does not make', () => {
    const timers = fakeTimers();
    let reads = 0;
    const sender = createDebouncedSender({
      read: () => { reads += 1; return reads; },
      send: () => undefined,
      delayMs: 250,
      timers,
    });

    for (let step = 0; step < 10; step++) sender.request();
    expect(reads).toBe(0);
    timers.advance(250);
    expect(reads).toBe(1);
  });
});
