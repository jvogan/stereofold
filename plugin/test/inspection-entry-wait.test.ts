import { expect, it, vi } from 'vitest';
import { waitForPanelRender } from '../src/inspection-render-settle.js';
it('entry keeps its own timeout; a cancelled request still requires a fresh 2D draw', async () => {
  let now = 0;
  const state = { phase: 'requesting-headset', pending:true, presenting: false, drawCount: 4 };
  await expect(waitForPanelRender({ ready: () => true, current: () => true, presentation: () => ({ ...state }),
    waitMs: 40000, now: () => now, sleep: async ms => {
      now += ms;
      if(now === 19000) { state.pending=false;state.phase='idle'; } // Entry's own timeout.
    } })).rejects.toThrow(/stayed busy/);
  expect(now).toBe(34000); // The 15-second render cap starts after entry.
});
it('a 19-second entry leaves the full settle budget for a subsequent molecular draw', async () => {
  let now = 0, entryMs = 0;
  await waitForPanelRender({ready:()=>now>=21000,current:()=>true,
    presentation:()=>({phase:now<19000?'preparing-menu':'active',pending:now<19000,presenting:true}),
    now:()=>now,sleep:async ms=>{now+=ms;},onEntryWait:ms=>{entryMs+=ms;}});
  expect(now).toBe(21000);expect(entryMs).toBe(19000);
});
it('ordinary busy rendering is still capped at 15 seconds', async () => {
  let now=0;
  await expect(waitForPanelRender({ready:()=>false,current:()=>true,waitMs:40000,
    now:()=>now,sleep:async ms=>{now+=ms;}})).rejects.toThrow(/stayed busy/);
  expect(now).toBe(15000);
});
it('entry wait refuses source/session cancellation even if the page becomes ready simultaneously', async () => {
  let current = true, presenting = false;
  await expect(waitForPanelRender({ ready: () => true, current: () => current,
    presentation: () => ({ phase: 'requesting-headset', presenting }),
    sleep: async () => { current = false; presenting = true; } })).rejects.toMatchObject({ code: 'local_changed' });
});

it('a dismissed VR request still waits for its first 2D draw', async () => {
  let now = 0;
  const state = { phase: 'requesting-headset', presenting: false, drawCount: 1 };
  await waitForPanelRender({ ready: () => true, current: () => true, presentation: () => ({ ...state }),
    now: () => now, sleep: async ms => { now += ms; if (now === 100) state.phase = 'idle'; if (now === 250) state.drawCount++; } });
  expect(now).toBe(250);
});

it('captures the ready scene in the admission turn before another microtask can start rendering', async () => {
  let ready = true, captures = 0;
  const captured = waitForPanelRender({ ready: () => ready, current: () => true,
    onReady: () => { expect(ready).toBe(true); captures++; return 'drawn scene'; } });
  ready = false;
  expect(await captured).toBe('drawn scene'); expect(captures).toBe(1);
});

it('the agent start waits out the player’s own bound for a large tier instead of 60 s', async () => {
  const { applyTourCommand, firstSceneTimeoutMs } = await import('../src/inspection-tour-client.js');
  const { tourSceneTimeoutMs } = await import('../src/tour-player.js');
  vi.useFakeTimers();
  try {
    const state: any = { tours: [{ id: 'walk' }], selectedId: 'walk', step: -1, active: false, navigating: false };
    const listeners = new Set<() => void>();
    const player: any = { getState: () => ({ ...state }), subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); },
      select: async () => {}, start: () => new Promise<void>(resolve => setTimeout(() => {
        Object.assign(state, { step: 0, active: true }); listeners.forEach(fn => fn()); resolve(); }, 100_000)) };
    expect(firstSceneTimeoutMs(32_916)).toBeGreaterThan(tourSceneTimeoutMs(32_916));
    let settled: unknown;
    void applyTourCommand(player, { action: 'start', tourId: 'walk' }, { atomCount: 32_916 }).then(() => { settled = 'rendered'; }, error => { settled = error; });
    await vi.advanceTimersByTimeAsync(60_001); expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(40_000); expect(settled).toBe('rendered');
  } finally { vi.useRealTimers(); }
});
