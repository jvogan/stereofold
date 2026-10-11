import { expect, it, vi } from 'vitest';
import { mountTourPlayer, type Tour } from '../src/tour-player.js';
import { applyTourCommand } from '../src/inspection-tour-client.js';
// @ts-ignore Production player DOM boundary; no browser/GPU work.
import { tourEndHarness } from '../../lab/browser-roundtrip/fixtures/tour-end-harness.mjs';

const tour: Tour = { id: 'motion-pause', title: 'Motion pause', summary: '', presentation: { captionCard: 'shown', end: 'hold' },
  steps: [
    { id: 'orbit', title: 'Orbit', durationMs: 20_000, motion: { kind: 'orbit', axis: 'y', degrees: 100, seconds: 2 } },
    { id: 'dolly', title: 'Dolly', durationMs: 20_000, motion: { kind: 'dolly', metres: 1, seconds: 2 } },
  ] };
function harness() {
  const h = tourEndHarness({ xr: true });
  let angle = 0, zoom = 1, source = 'same';
  const originalSnapshot = h.workspace.snapshot;
  h.workspace.snapshot = () => ({ ...originalSnapshot(), sourceSha256: source });
  const move = vi.fn(async (value: any) => { if (value.kind === 'orbit') angle += value.degrees; else zoom *= value.factor; });
  h.workspace.viewer.inspection.applyLessonMotion = move;
  h.workspace.viewer.inspection.bakeLessonMotion = vi.fn();
  const events = new Map<string, () => void>();
  document.addEventListener = ((name: string, listener: () => void) => { events.set(name, listener); }) as any;
  const player = mountTourPlayer({ ...h, tours: [tour] });
  return { ...h, player, move, angle: () => angle, zoom: () => zoom, source: (value: string) => { source = value; },
    visibility: (hidden: boolean) => { Object.assign(document, { hidden }); events.get('visibilitychange')!(); },
  };
}

for (const route of ['toggle', 'command', 'visibility'] as const) it(`${route}: suspends authored motion and resumes only its remaining time`, async () => {
  vi.useFakeTimers();
  const h = harness();
  try {
    await h.player.select(tour.id); await h.player.start(true, 0);
    await vi.advanceTimersByTimeAsync(500);
    const held = h.angle(); expect(held).toBeGreaterThan(0); expect(held).toBeLessThan(100);
    if (route === 'toggle') await h.player.togglePlay();
    else if (route === 'command') await applyTourCommand(h.player, { action: 'pause' });
    else h.visibility(true);
    expect(h.player.getState()).toMatchObject({ autoplay: false, motionRunning: false, step: 0 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.angle()).toBe(held);
    if (route === 'toggle') await h.player.togglePlay();
    else if (route === 'command') await applyTourCommand(h.player, { action: 'play' });
    else h.visibility(false);
    expect(h.player.getState()).toMatchObject({ autoplay: true, motionRunning: true, step: 0 });
    await vi.advanceTimersByTimeAsync(1450);
    expect(h.angle()).toBeGreaterThan(held); expect(h.angle()).toBeLessThan(100);
    await vi.advanceTimersByTimeAsync(50);
    expect(h.angle()).toBeCloseTo(100, 8);
    expect(h.player.getState().motionRunning).toBe(false);
  } finally { h.player.pause(); h.cleanup(); vi.useRealTimers(); }
});

it('retains dolly progress through repeated pauses without reapplying the completed factor', async () => {
  vi.useFakeTimers(); const h = harness();
  try {
    await h.player.select(tour.id); await h.player.start(true, 1);
    for (let cycle = 0; cycle < 3; cycle++) {
      await vi.advanceTimersByTimeAsync(400);
      h.player.pause(); const held = h.zoom();
      await vi.advanceTimersByTimeAsync(5000); expect(h.zoom()).toBe(held);
      await h.player.togglePlay();
    }
    await vi.advanceTimersByTimeAsync(800);
    expect(h.zoom()).toBeCloseTo(0.8, 8); expect(h.player.getState().motionRunning).toBe(false);
  } finally { h.player.pause(); h.cleanup(); vi.useRealTimers(); }
});

for (const action of ['next', 'done', 'select', 'replace', 'source'] as const) it(`${action} discards suspended motion before later Play`, async () => {
  vi.useFakeTimers(); const h = harness();
  try {
    await h.player.select(tour.id); await h.player.start(true, 0);
    await vi.advanceTimersByTimeAsync(500); h.player.pause();
    const held = h.angle();
    if (action === 'next') await h.player.next();
    else if (action === 'done') await h.player.finish();
    else if (action === 'select') await h.player.select(tour.id);
    else if (action === 'replace') await h.player.replaceTours([tour]);
    else h.source('other');
    await vi.advanceTimersByTimeAsync(1000); expect(h.angle()).toBe(held);
    if (action === 'next' || action === 'source') {
      await h.player.togglePlay(); await vi.advanceTimersByTimeAsync(1000); expect(h.angle()).toBe(held);
    } else expect(h.player.getState()).toMatchObject({ active: false, motionRunning: false });
  } finally { h.player.pause(); h.cleanup(); vi.useRealTimers(); }
});

it('manual takeover clears suspended motion and keeps its placement until an explicit rejoin', async () => {
  vi.useFakeTimers(); const h = harness();
  try {
    await h.player.select(tour.id); await h.player.start(true, 0);
    await vi.advanceTimersByTimeAsync(500); h.player.pause();
    await h.workspace.viewer.inspection.place({ scale: 3 }); h.player.notifyMutation(h.workspace.snapshot());
    const held = h.angle(), before = h.capture();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.angle()).toBe(held); expect(h.capture()).toEqual(before);
    expect(h.player.getState()).toMatchObject({ stopped: true, active: false, motionRunning: false });
    // Rejoin is the explicit request to restore the chapter. Its animation
    // starts a fresh visit instead of reviving the old visit's remainder.
    await h.player.rejoin(false); await vi.advanceTimersByTimeAsync(500);
    expect(h.angle() - held).toBeCloseTo(6.25, 8);
  } finally { h.player.pause(); h.cleanup(); vi.useRealTimers(); }
});

it('suspends a held chapter while hidden without enabling autoplay, and honors a manual pause', async () => {
  vi.useFakeTimers(); const h = harness();
  try {
    await h.player.select(tour.id); await h.player.start(false, 0);
    await vi.advanceTimersByTimeAsync(500); h.visibility(true);
    const held = h.angle(); await vi.advanceTimersByTimeAsync(5000); expect(h.angle()).toBe(held);
    h.visibility(false);
    expect(h.player.getState()).toMatchObject({ autoplay: false, motionRunning: true });
    await vi.advanceTimersByTimeAsync(500); h.player.pause(); h.player.pause();
    h.visibility(true); await vi.advanceTimersByTimeAsync(5000); h.visibility(false);
    expect(h.player.getState()).toMatchObject({ autoplay: false, motionRunning: false });
    await h.player.togglePlay(); await vi.advanceTimersByTimeAsync(1000);
    expect(h.angle()).toBeCloseTo(100, 8);
  } finally { h.player.pause(); h.cleanup(); vi.useRealTimers(); }
});

it('a manual pause while hidden cancels the automatic motion resume', async () => {
  vi.useFakeTimers(); const h = harness();
  try {
    await h.player.select(tour.id); await h.player.start(true, 0);
    await vi.advanceTimersByTimeAsync(500); h.visibility(true); h.player.pause();
    const held = h.angle(); h.visibility(false); await vi.advanceTimersByTimeAsync(5000);
    expect(h.angle()).toBe(held);
    expect(h.player.getState()).toMatchObject({ autoplay: false, motionRunning: false });
  } finally { h.player.pause(); h.cleanup(); vi.useRealTimers(); }
});
