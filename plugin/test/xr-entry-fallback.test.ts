import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';

import * as entryFallback from '../src/xr-entry-fallback.js';
import { enterImmersiveWithFallback, XR_AR_FALLBACK_MODE } from '../src/xr-entry-fallback.js';

// Read off the namespace so this file still loads where the wait is absent.
const readyWaitMs = (entryFallback as Record<string, unknown>).XR_READY_WAIT_MS as number | undefined;
// The refusal the viewer makes before any session request while its scene is
// changing (`immersive-session.mjs`).
const notReady = () => Object.assign(Error('Load a ready structure before entering immersion.'), { code: 'xr_unavailable', notReady: true });
// A scripted clock whose frames come every 16 ms.
function scene(readyAtMs: number, activationUntilMs?: number) {
  let now = 0;
  return {
    ready: () => now >= readyAtMs,
    now: () => now,
    nextFrame: (callback: () => void) => { now += 16; void Promise.resolve().then(callback); },
    activationActive: () => (activationUntilMs === undefined ? undefined : now < activationUntilMs),
    get time() { return now; },
  };
}
// The viewer's entry: refused while the scene is changing, else one session request.
function viewer(clock: { ready: () => boolean }, answer: (mode: string) => Promise<unknown> = () => Promise.resolve('session')) {
  const attempts: string[] = [], requests: string[] = [];
  const enter = (mode: string) => {
    attempts.push(mode);
    if (!clock.ready()) return Promise.reject(notReady());
    requests.push(mode);
    return answer(mode);
  };
  return { enter, attempts, requests };
}

describe('an Enter VR press that lands while the scene is changing', () => {
  afterEach(() => { vi.useRealTimers(); });
  it('never spends the plain VR retry on a scene that was still changing', async () => {
    const notes: string[] = [];
    const entry = viewer({ ready: () => false });
    await expect(enterImmersiveWithFallback(entry.enter, 'immersive-ar', error => notes.push(error.message))).rejects.toMatchObject({ notReady: true });
    expect(entry.attempts).toEqual(['immersive-ar']);
    expect(notes).toEqual([]);
  });

  it('waits for the scene, then makes one session request from the same press', async () => {
    const clock = scene(1000), notes: string[] = [];
    const entry = viewer(clock);
    const session = await (enterImmersiveWithFallback as (...args: unknown[]) => Promise<unknown>)(entry.enter, 'immersive-ar', (error: Error) => notes.push(error.message), clock);
    expect(session).toBe('session');
    expect(entry.requests).toEqual(['immersive-ar']);
    expect(notes).toEqual([]);
    expect(clock.time).toBeGreaterThanOrEqual(1000);
    expect(clock.time).toBeLessThan(1000 + 16 * 2);
  });

  it('gives up at the bound, inside the activation window, without asking', async () => {
    expect(readyWaitMs).toBeGreaterThan(0);
    expect(readyWaitMs).toBeLessThan(5000);
    const clock = scene(60_000), entry = viewer(clock);
    await expect((enterImmersiveWithFallback as (...args: unknown[]) => Promise<unknown>)(entry.enter, 'immersive-ar', () => {}, clock)).rejects.toMatchObject({ notReady: true });
    expect(entry.requests).toEqual([]);
    expect(entry.attempts).toEqual(['immersive-ar']);
    expect(clock.time).toBeGreaterThanOrEqual(readyWaitMs!);
    expect(clock.time).toBeLessThan(readyWaitMs! + 16 * 2);
  });

  it('stops waiting once the browser says the press no longer counts', async () => {
    const clock = scene(3000, 2000), entry = viewer(clock);
    await expect((enterImmersiveWithFallback as (...args: unknown[]) => Promise<unknown>)(entry.enter, 'immersive-ar', () => {}, clock)).rejects.toMatchObject({ notReady: true });
    expect(entry.requests).toEqual([]);
    expect(clock.time).toBeLessThan(2000 + 16 * 2);
  });

  it('gives up at the bound even when no frame comes, as in a hidden page', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let now = 0, settled: unknown;
    const frames: Array<() => void> = [];
    const stalled = { ready: () => false, now: () => now, nextFrame: (callback: () => void) => { frames.push(callback); }, activationActive: () => undefined };
    const entry = viewer(stalled);
    void (enterImmersiveWithFallback as (...args: unknown[]) => Promise<unknown>)(entry.enter, 'immersive-ar', () => {}, stalled)
      .then(() => { settled = 'entered'; }, error => { settled = error; });
    await vi.advanceTimersByTimeAsync(0);
    now = 5000; await vi.advanceTimersByTimeAsync(5000);
    expect(settled).toMatchObject({ notReady: true });
    expect(entry.requests).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the plain VR retry for a real refusal after the wait', async () => {
    const clock = scene(500), notes: string[] = [];
    const entry = viewer(clock, mode => (mode === 'immersive-ar' ? Promise.reject(Error('AR refused')) : Promise.resolve('session')));
    const session = await (enterImmersiveWithFallback as (...args: unknown[]) => Promise<unknown>)(entry.enter, 'immersive-ar', (error: Error) => notes.push(error.message), clock);
    expect(session).toBe('session');
    expect(entry.requests).toEqual(['immersive-ar', 'immersive-vr']);
    expect(notes).toEqual(['AR refused']);
  });
});

describe('the Enter VR button on a Quest that reports passthrough it will not give', () => {
  it('asks for plain VR once when the passthrough request is refused', async () => {
    // isSessionSupported('immersive-ar') answering true is not a promise that
    // the request will be granted. Before this the wearer was dropped back on
    // the 2D page with an error and had to press Enter again themselves.
    const asked: string[] = [];
    const notes: string[] = [];
    const session = await enterImmersiveWithFallback(mode => {
      asked.push(mode);
      return mode === 'immersive-ar' ? Promise.reject(Error('AR refused')) : Promise.resolve('session');
    }, 'immersive-ar', error => notes.push(error.message));
    expect(asked).toEqual(['immersive-ar', XR_AR_FALLBACK_MODE]);
    expect(session).toBe('session');
    expect(notes).toEqual(['AR refused']);
  });

  it('surfaces the second failure rather than asking a third time', async () => {
    const asked: string[] = [];
    await expect(enterImmersiveWithFallback(mode => {
      asked.push(mode);
      return Promise.reject(Error(`${mode} refused`));
    }, 'immersive-ar')).rejects.toThrow('immersive-vr refused');
    expect(asked).toEqual(['immersive-ar', 'immersive-vr']);
  });

  it('leaves a plain VR request alone and never retries a request that worked', async () => {
    const asked: string[] = [];
    const enter = (mode: string) => { asked.push(mode); return Promise.reject(Error('no headset')); };
    await expect(enterImmersiveWithFallback(enter, 'immersive-vr')).rejects.toThrow('no headset');
    expect(asked).toEqual(['immersive-vr']);
    asked.length = 0;
    await enterImmersiveWithFallback(mode => { asked.push(mode); return Promise.resolve(); }, 'immersive-ar');
    expect(asked).toEqual(['immersive-ar']);
  });

  it('is the path the Enter button takes, inside the click handler', async () => {
    // The retry only works from the gesture that opened it: requestSession
    // needs a transient user activation, and the button press is the only one
    // there is. A retry moved out of this handler would be refused.
    const source = await readFile(new URL('../src/inspector.ts', import.meta.url), 'utf8');
    const handler = source.slice(source.indexOf("button.addEventListener('click'"), source.indexOf('enterButtons.push(button)'));
    expect(handler).toMatch(/enterImmersiveWithFallback\(/u);
    expect(handler).not.toMatch(/workspace\.viewer\.xr\.enter\(requested\)/u);
  });
});
