import { describe, expect, it, vi } from 'vitest';
import { fitDistanceForEyeViewport } from '../src/eye-window.js';
import {
  FIT_EVENT_RING_CAPACITY,
  assembleDiagnostics,
  createDiagnosticsScheduler,
  createFitEventRing,
  drawPassEyeCssPx,
  eyeCapApplied,
  fillForReading,
  fillFraction,
  finiteOr,
  projectedSphereDiameterPx,
  type CameraReading,
  type DiagnosticsSources,
  type DiagnosticsTimers,
  type FitDiagnostics,
  type GeometryDiagnostics,
  type HostDiagnostics,
  type ReportTrigger,
  type StateDiagnostics,
  type UserDiagnostics,
  higherPriorityTrigger,
  REPORT_TRIGGER_PRIORITY,
} from '../src/fit-diagnostics.js';

/** The fill the viewer's fit solves for. Mirrors `STAGE_FILL_FRACTION`. */
const STAGE_FILL_FRACTION = 0.86;
/** Mol*'s default vertical field of view. */
const FOV = Math.PI / 4;

/**
 * The eye windows that matter, in CSS px.
 *
 * `side-panel parallel` is a side panel with the 63 mm interocular cap in
 * force: one eye 238 wide against a 799 tall stage. `side-panel mono` is the
 * same panel with no split, which is the viewport the camera had been framed
 * against while it rendered into the first.
 */
const EYE_WINDOWS = [
  { name: 'side-panel parallel', width: 238, height: 799 },
  { name: 'side-panel mono', width: 1010, height: 799 },
  { name: 'inline card parallel', width: 238, height: 470 },
  { name: 'inline card mono', width: 1420, height: 470 },
  { name: 'narrow card parallel', width: 214, height: 720 },
  { name: 'square', width: 400, height: 400 },
];

const RADII = [8.5, 17.782, 52.9, 240];

describe('projectedSphereDiameterPx', () => {
  /**
   * The round trip that makes `fill` mean something.
   *
   * `fitDistanceForEyeViewport` solves for the distance at which the sphere
   * fills `STAGE_FILL_FRACTION` of the eye window's shorter side, and this
   * function projects a sphere at a distance back to pixels. Composing them
   * has to return exactly the fraction that was asked for, in every geometry
   * and at every radius, or `fill = 0.86` is not the test of a correct fit.
   */
  it('inverts the viewer fit: a correctly framed camera reports exactly 0.86', () => {
    for (const eye of EYE_WINDOWS) {
      for (const radius of RADII) {
        const distance = fitDistanceForEyeViewport({
          radius,
          eyeWidthPx: eye.width,
          eyeHeightPx: eye.height,
          fovRad: FOV,
          fillFraction: STAGE_FILL_FRACTION,
        });
        expect(distance, `${eye.name} r=${radius}`).toBeDefined();
        const { fill } = fillForReading(
          { visibleSphereRadiusAng: radius, distanceToTargetAng: distance as number, fovRad: FOV },
          { width: eye.width, height: eye.height },
        );
        expect(fill, `${eye.name} r=${radius}`).toBeCloseTo(STAGE_FILL_FRACTION, 12);
      }
    }
  });

  /**
   * The capped-eye defect, expressed as the number this object would report.
   *
   * The side panel's mono eye window is the whole 1010 x 799 CSS px stage, so
   * the fit solves against its shorter side, 799. One capped eye of the same
   * panel is 238 x 799, so the render measures against 238. The camera does
   * not move between the two, and the sphere subtends the same pixels, so the
   * fill goes straight from 0.86 to 0.86 x 799 / 238 = 2.887: nearly three
   * times the eye window, clipped at every edge. One number, and it says both
   * that the fit is wrong and by exactly which ratio.
   */
  it('reports the capped-eye mismatch as a fill of 2.89 rather than 0.86', () => {
    const radius = 17.782;
    const fittedForTheMonoStage = fitDistanceForEyeViewport({
      radius,
      eyeWidthPx: 1010,
      eyeHeightPx: 799,
      fovRad: FOV,
      fillFraction: STAGE_FILL_FRACTION,
    }) as number;
    const reading = { visibleSphereRadiusAng: radius, distanceToTargetAng: fittedForTheMonoStage, fovRad: FOV };
    expect(fillForReading(reading, { width: 1010, height: 799 }).fill).toBeCloseTo(STAGE_FILL_FRACTION, 12);
    const rendered = fillForReading(reading, { width: 238, height: 799 });
    expect(rendered.fill).toBeCloseTo(STAGE_FILL_FRACTION * 799 / 238, 12);
    expect(rendered.fill).toBeCloseTo(2.887, 3);
    // The projected silhouette does not move: only the window it is measured
    // against does, which is why the diameter is the honest thing to report
    // beside the fill.
    expect(rendered.projectedSphereDiameterPx).toBeCloseTo(STAGE_FILL_FRACTION * 799, 9);
  });

  it('returns undefined rather than a NaN for a camera inside the sphere', () => {
    expect(projectedSphereDiameterPx({ radius: 20, distanceToTargetAng: 20, fovRad: FOV, eyeHeightPx: 400 })).toBeUndefined();
    expect(projectedSphereDiameterPx({ radius: 20, distanceToTargetAng: 5, fovRad: FOV, eyeHeightPx: 400 })).toBeUndefined();
  });

  it('returns undefined for a degenerate radius, viewport or field of view', () => {
    const base = { radius: 10, distanceToTargetAng: 100, fovRad: FOV, eyeHeightPx: 400 };
    expect(projectedSphereDiameterPx({ ...base, radius: 0 })).toBeUndefined();
    expect(projectedSphereDiameterPx({ ...base, eyeHeightPx: 0 })).toBeUndefined();
    expect(projectedSphereDiameterPx({ ...base, fovRad: 0 })).toBeUndefined();
    expect(projectedSphereDiameterPx({ ...base, fovRad: Math.PI })).toBeUndefined();
    expect(projectedSphereDiameterPx({ ...base, distanceToTargetAng: Number.NaN })).toBeUndefined();
  });

  it('measures the fill against the shorter side of the eye window', () => {
    const diameter = 200;
    expect(fillFraction({ projectedSphereDiameterPx: diameter, eyeWidthPx: 238, eyeHeightPx: 799 })).toBeCloseTo(200 / 238, 12);
    expect(fillFraction({ projectedSphereDiameterPx: diameter, eyeWidthPx: 799, eyeHeightPx: 238 })).toBeCloseTo(200 / 238, 12);
    expect(fillFraction({ projectedSphereDiameterPx: diameter, eyeWidthPx: 0, eyeHeightPx: 238 })).toBeUndefined();
    expect(fillFraction({ projectedSphereDiameterPx: undefined, eyeWidthPx: 238, eyeHeightPx: 799 })).toBeUndefined();
  });
});

describe('eyeCapApplied', () => {
  it('is true only when the interocular cap is narrower than the container', () => {
    expect(eyeCapApplied({ sideBySide: true, halfCapPx: 238, availableWidthPx: 1010 })).toBe(true);
    expect(eyeCapApplied({ sideBySide: true, halfCapPx: 238, availableWidthPx: 400 })).toBe(false);
    // Exactly equal is the container binding, not the cap.
    expect(eyeCapApplied({ sideBySide: true, halfCapPx: 238, availableWidthPx: 476 })).toBe(false);
    expect(eyeCapApplied({ sideBySide: false, halfCapPx: 238, availableWidthPx: 1010 })).toBe(false);
    expect(eyeCapApplied({ sideBySide: true, halfCapPx: null, availableWidthPx: 1010 })).toBe(false);
  });
});

describe('finiteOr', () => {
  it('replaces anything JSON cannot carry', () => {
    expect(finiteOr(12.5)).toBe(12.5);
    expect(finiteOr(Number.NaN)).toBe(0);
    expect(finiteOr(Number.POSITIVE_INFINITY)).toBe(0);
    expect(finiteOr(undefined)).toBe(0);
    expect(finiteOr(undefined, 1)).toBe(1);
    expect(finiteOr('238')).toBe(0);
  });
});

describe('createFitEventRing', () => {
  const event = (index: number) => ({
    at: `2026-09-02T10:00:${String(index).padStart(2, '0')}.000Z`,
    trigger: 'refit' as const,
    eyeWidthPx: 238,
    eyeHeightPx: 799,
    radius: 17.782,
    distance: 52.99,
    fill: 0.86,
  });

  it('keeps the newest events, oldest first', () => {
    const ring = createFitEventRing(3);
    for (let index = 0; index < 5; index += 1) ring.record(event(index));
    expect(ring.entries().map((entry) => entry.at)).toEqual([
      '2026-09-02T10:00:02.000Z',
      '2026-09-02T10:00:03.000Z',
      '2026-09-02T10:00:04.000Z',
    ]);
  });

  it('defaults to twelve and hands out copies, not the stored objects', () => {
    const ring = createFitEventRing();
    for (let index = 0; index < FIT_EVENT_RING_CAPACITY + 4; index += 1) ring.record(event(index));
    expect(ring.entries()).toHaveLength(FIT_EVENT_RING_CAPACITY);
    const first = ring.entries()[0];
    if (first == null) throw new Error('ring is empty');
    first.radius = -1;
    expect(ring.entries()[0]?.radius).toBe(17.782);
  });
});

/* ------------------------------------------------------------- assembly */

/** A measured side-panel geometry at devicePixelRatio 2. */
function baseGeometry(): GeometryDiagnostics {
  return {
    stageRectCssPx: { x: 8, y: 71, width: 476, height: 799 },
    letterboxRectCssPx: { x: 8, y: 71, width: 1010, height: 799 },
    eyeViewportCssPx: { width: 238, height: 799 },
    eyeCapApplied: true,
    halfCapPx: 238,
    canvasCssPx: { width: 476, height: 799 },
    canvasBackingPx: { width: 952, height: 1598 },
    cameraViewport: { x: 0, y: 0, width: 952, height: 1598 },
  };
}

function sources(overrides: Partial<DiagnosticsSources> = {}): DiagnosticsSources {
  const host: HostDiagnostics = {
    displayMode: 'fullscreen',
    hostContextCount: 1,
    innerWidthPx: 1026,
    innerHeightPx: 878,
    devicePixelRatio: 2,
    visibilityState: 'visible',
  };
  const geometry: GeometryDiagnostics = baseGeometry();
  const camera: CameraReading = {
    distanceToTargetAng: fitDistanceForEyeViewport({
      radius: 17.782,
      eyeWidthPx: 238,
      eyeHeightPx: 799,
      fovRad: FOV,
      fillFraction: STAGE_FILL_FRACTION,
    }) as number,
    radiusAng: 17.782,
    fovRad: FOV,
    visibleSphereRadiusAng: 17.782,
    boundingSphereVisibleRadiusAng: 17.782,
    inTransition: false,
  };
  const fit: FitDiagnostics = { fitSuspended: false, fixturePinned: false, loadInFlight: false, events: [] };
  const state: StateDiagnostics = {
    mode: 'parallel',
    depthBudgetArcmin: 20,
    swapEyes: false,
    variant: 'balanced',
    color: 'chain-id',
    style: 'polymer-and-ligand',
    motionMode: 'rock',
    motionRunning: true,
    structureLoaded: true,
    messageCounts: { open: 1, state: 0, mode: 0 },
    structureSource: 'open',
  };
  const user: UserDiagnostics = { wheelEventsSinceFit: 0, wheelEventsTotal: 0 };
  return {
    nowIso: () => '2026-09-02T10:00:00.000Z',
    viewerBuild: () => 'build-under-test',
    panelId: () => 'panel-under-test',
    nextSequence: () => 1,
    host: () => host,
    geometry: () => geometry,
    camera: () => camera,
    fit: () => fit,
    state: () => state,
    user: () => user,
    ...overrides,
  };
}

describe('assembleDiagnostics', () => {
  it('derives the fill from the eye window the geometry reader reported', () => {
    const diagnostics = assembleDiagnostics(sources(), 'button');
    expect(diagnostics.trigger).toBe('button');
    expect(diagnostics.camera.fill).toBeCloseTo(STAGE_FILL_FRACTION, 12);
    expect(diagnostics.camera.projectedSphereDiameterPx).toBeCloseTo(STAGE_FILL_FRACTION * 238, 9);
  });

  it('omits the fill rather than reporting a NaN when there is no silhouette', () => {
    const diagnostics = assembleDiagnostics(
      sources({ camera: () => ({ ...sources().camera(), distanceToTargetAng: 1 }) }),
      'heartbeat',
    );
    expect(diagnostics.camera.fill).toBeUndefined();
    expect(diagnostics.camera.projectedSphereDiameterPx).toBeUndefined();
    expect(diagnostics.camera.distanceToTargetAng).toBe(1);
  });

  /**
   * The property the whole object depends on: it may not cache.
   *
   * The defect this exists to find is a fit computed against a rectangle that
   * was already stale, so an assembler that read a geometry once and reused it
   * would be reporting the same class of mistake it is meant to expose.
   */
  it('calls every source once per assembly and reflects a value that moved', () => {
    let width = 238;
    const base = sources();
    const geometry = vi.fn(() => ({ ...base.geometry(), eyeViewportCssPx: { width, height: 799 } }));
    const host = vi.fn(base.host);
    const injected = sources({ geometry, host, nextSequence: (() => { let n = 0; return () => (n += 1); })() });
    const first = assembleDiagnostics(injected, 'mount');
    width = 1010;
    const second = assembleDiagnostics(injected, 'heartbeat');
    expect(geometry).toHaveBeenCalledTimes(2);
    expect(host).toHaveBeenCalledTimes(2);
    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(first.geometry.eyeViewportCssPx.width).toBe(238);
    expect(second.geometry.eyeViewportCssPx.width).toBe(1010);
    // The same camera, measured against the mono window. The fit framed the
    // sphere at 0.86 of a 238 px shorter side; the mono window's shorter side
    // is its 799 px height, so the identical camera now fills a quarter of it.
    // That ratio, read the other way round, is the defect: a camera fitted for
    // the mono stage and rendered into one capped eye reports a fill of 2.89.
    expect(second.camera.fill).toBeCloseTo(STAGE_FILL_FRACTION * 238 / 799, 12);
  });
});

/* ------------------------------------------------------------ scheduling */

function fakeClock(): {
  now: () => number;
  timers: DiagnosticsTimers;
  advance: (ms: number) => void;
  pending: () => number;
} {
  let now = 0;
  let nextHandle = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    now: () => now,
    timers: {
      set(callback, delayMs) {
        const handle = nextHandle;
        nextHandle += 1;
        timers.set(handle, { at: now + delayMs, callback });
        return handle;
      },
      clear(handle) {
        timers.delete(handle);
      },
    },
    advance(ms) {
      const target = now + ms;
      for (let guard = 0; guard < 10_000; guard += 1) {
        let dueHandle: number | undefined;
        let dueAt = Number.POSITIVE_INFINITY;
        for (const [handle, timer] of timers) {
          if (timer.at <= target && timer.at < dueAt) {
            dueHandle = handle;
            dueAt = timer.at;
          }
        }
        if (dueHandle === undefined) break;
        const timer = timers.get(dueHandle);
        timers.delete(dueHandle);
        now = Math.max(now, dueAt);
        timer?.callback();
      }
      now = target;
    },
    pending: () => timers.size,
  };
}

function scheduler(clock: ReturnType<typeof fakeClock>, send: (trigger: ReportTrigger) => void) {
  return createDiagnosticsScheduler({
    send,
    now: clock.now,
    timers: clock.timers,
    debounceMs: 200,
    minGapMs: 1_000,
    heartbeatMs: 1_000,
  });
}

describe('higherPriorityTrigger', () => {
  it('keeps the order the report trigger is chosen by', () => {
    expect(REPORT_TRIGGER_PRIORITY.indexOf('button'))
      .toBeLessThan(REPORT_TRIGGER_PRIORITY.indexOf('decision'));
    expect(REPORT_TRIGGER_PRIORITY.indexOf('decision'))
      .toBeLessThan(REPORT_TRIGGER_PRIORITY.indexOf('mode'));
    expect(REPORT_TRIGGER_PRIORITY.indexOf('mode'))
      .toBeLessThan(REPORT_TRIGGER_PRIORITY.indexOf('heartbeat'));
  });

  it('takes the incoming trigger only when it outranks what is pending', () => {
    expect(higherPriorityTrigger(undefined, 'heartbeat')).toBe('heartbeat');
    expect(higherPriorityTrigger('heartbeat', 'button')).toBe('button');
    expect(higherPriorityTrigger('button', 'heartbeat')).toBe('button');
    expect(higherPriorityTrigger('mode', 'decision')).toBe('decision');
    expect(higherPriorityTrigger('decision', 'mode')).toBe('decision');
  });
});

describe('createDiagnosticsScheduler', () => {
  it('collapses a burst into one send, named for what started it', () => {
    const clock = fakeClock();
    const sent: ReportTrigger[] = [];
    const scheduled = scheduler(clock, (trigger) => sent.push(trigger));
    scheduled.report('loadstart');
    scheduled.report('load');
    scheduled.report('decision');
    scheduled.report('loadend');
    clock.advance(199);
    expect(sent).toEqual([]);
    clock.advance(2);
    expect(sent).toEqual(['loadstart']);
  });

  it('never sends twice inside the minimum gap', () => {
    const clock = fakeClock();
    const sent: ReportTrigger[] = [];
    const scheduled = scheduler(clock, (trigger) => sent.push(trigger));
    scheduled.report('mode');
    clock.advance(200);
    expect(sent).toEqual(['mode']);
    scheduled.report('button');
    clock.advance(300);
    expect(sent).toEqual(['mode']);
    clock.advance(699);
    expect(sent).toEqual(['mode']);
    clock.advance(2);
    expect(sent).toEqual(['mode', 'button']);
  });

  /**
   * The starvation case, which is not hypothetical: `maybeRefitCamera` returns
   * a non-`keep` decision on every animation frame for the whole duration of a
   * load, so a plain debounce would never fire during the one interval anyone
   * wants to see.
   */
  it('still reports under a stream of triggers that never stops', () => {
    const clock = fakeClock();
    const sent: ReportTrigger[] = [];
    const scheduled = scheduler(clock, (trigger) => sent.push(trigger));
    for (let frame = 0; frame < 300; frame += 1) {
      scheduled.report('decision');
      clock.advance(16);
    }
    // 4.8 s of continuous reporting, capped at one send per second.
    expect(sent.length).toBeGreaterThanOrEqual(4);
    expect(sent.length).toBeLessThanOrEqual(5);
    expect(new Set(sent)).toEqual(new Set(['decision']));
  });

  it('reports once a second while nothing changes, once started', () => {
    const clock = fakeClock();
    const sent: ReportTrigger[] = [];
    const scheduled = scheduler(clock, (trigger) => sent.push(trigger));
    scheduled.start();
    clock.advance(3_500);
    expect(sent).toEqual(['heartbeat', 'heartbeat', 'heartbeat']);
    scheduled.stop();
    clock.advance(5_000);
    expect(sent).toHaveLength(3);
    expect(clock.pending()).toBe(0);
  });

  it('flushes a user action immediately, ignoring the gap', () => {
    const clock = fakeClock();
    const sent: ReportTrigger[] = [];
    const scheduled = scheduler(clock, (trigger) => sent.push(trigger));
    scheduled.report('mode');
    clock.advance(200);
    scheduled.flush('button');
    expect(sent).toEqual(['mode', 'button']);
    expect(scheduled.sentCount).toBe(2);
  });

  it('swallows a throwing send rather than letting it reach the render loop', () => {
    const clock = fakeClock();
    let calls = 0;
    const scheduled = scheduler(clock, () => {
      calls += 1;
      throw new Error('the host went away');
    });
    scheduled.start();
    expect(() => clock.advance(3_000)).not.toThrow();
    expect(calls).toBe(3);
  });

  /**
   * `runFit` records the ring entry before it flushes, so `fit.events` never
   * lost the press; the report's own `trigger` did, because the deferred flush
   * assigned rather than merged. A reader
   * asking "did my press reach the app" would then be told `heartbeat`.
   */
  it('keeps a button press\'s name when a heartbeat flush folds into it', () => {
    const clock = fakeClock();
    const sent: ReportTrigger[] = [];
    const scheduled = createDiagnosticsScheduler({
      send: (trigger) => sent.push(trigger),
      now: clock.now,
      timers: clock.timers,
      debounceMs: 200,
      minGapMs: 1_000,
      heartbeatMs: 1_000,
      flushMinGapMs: 250,
    });
    scheduled.flush('button');
    expect(sent).toEqual(['button']);
    // A second press inside the floor, then the harness probe's own flush.
    scheduled.flush('button');
    clock.advance(50);
    scheduled.flush('heartbeat');
    clock.advance(500);
    expect(sent).toEqual(['button', 'button']);
  });

  it('names a coalesced burst for its highest-priority trigger', () => {
    const clock = fakeClock();
    const sent: ReportTrigger[] = [];
    const scheduled = scheduler(clock, (trigger) => sent.push(trigger));
    scheduled.report('heartbeat');
    scheduled.report('mode');
    scheduled.report('decision');
    clock.advance(250);
    expect(sent).toEqual(['decision']);
  });

  it('drops a pending send on stop', () => {
    const clock = fakeClock();
    const sent: ReportTrigger[] = [];
    const scheduled = scheduler(clock, (trigger) => sent.push(trigger));
    scheduled.report('hostcontext');
    expect(scheduled.pending).toBe(true);
    scheduled.stop();
    clock.advance(5_000);
    expect(sent).toEqual([]);
    expect(scheduled.pending).toBe(false);
  });
});

/* ------------------------------------------------- fill from the draw pass */

/**
 * The shipped rates, restated. The constants live beside the scheduler's
 * caller in `plugin/src/viewer.ts`, which cannot be imported here: it reaches
 * for the DOM and for Mol* at module scope. A test that imported the viewer's
 * opinion could not disagree with it either.
 */
const HEARTBEAT_MS = 1_000;
const IDLE_HEARTBEAT_MS = 10_000;
const ACTIVE_MS = 5_000;
const FLUSH_MIN_GAP_MS = 250;

describe('drawPassEyeCssPx', () => {
  it('divides the draw pass viewport by the device pixel ratio', () => {
    expect(drawPassEyeCssPx({
      stereoEyeViewports: { left: { x: 0, y: 0, width: 476, height: 1598 }, ageMs: 16 },
      devicePixelRatio: 2,
    })).toEqual({ width: 238, height: 799 });
  });

  it('reports nothing when the pass has not run recently, or has not run at all', () => {
    expect(drawPassEyeCssPx({ devicePixelRatio: 2 })).toBeUndefined();
    expect(drawPassEyeCssPx({
      stereoEyeViewports: { left: { x: 0, y: 0, width: 476, height: 1598 }, ageMs: 1_001 },
      devicePixelRatio: 2,
    })).toBeUndefined();
    // A mono panel keeps the last stereo frame's split for as long as it lives.
    expect(drawPassEyeCssPx({
      stereoEyeViewports: { left: { x: 0, y: 0, width: 476, height: 1598 }, ageMs: 81_443 },
      devicePixelRatio: 2,
    })).toBeUndefined();
    expect(drawPassEyeCssPx({
      stereoEyeViewports: { left: { x: 0, y: 0, width: 0, height: 1598 }, ageMs: 16 },
      devicePixelRatio: 2,
    })).toBeUndefined();
  });
});

describe('assembleDiagnostics fillFromDrawPass', () => {
  const eyes = (width: number, ageMs = 16) => ({
    left: { x: 0, y: 0, width, height: 1598 },
    right: { x: width, y: 0, width, height: 1598 },
    parent: { x: 0, y: 0, width: width * 2, height: 1598 },
    ageMs,
  });

  it('agrees with fill when the layout box and the draw pass agree', () => {
    const built = assembleDiagnostics(sources({
      geometry: () => ({ ...baseGeometry(), stereoEyeViewports: eyes(476) }),
    }), 'refit');
    expect(built.camera.fill).toBeCloseTo(STAGE_FILL_FRACTION, 12);
    expect(built.camera.fillFromDrawPass).toBeCloseTo(STAGE_FILL_FRACTION, 12);
  });

  /**
   * The arithmetic case: the panel reports a 238 CSS px eye while
   * Mol* splits a canvas a third the size, so `fill` says the fit is right and
   * the render is three times oversized. One number could not have caught it.
   */
  it('moves when the draw pass disagrees with the layout box, while fill does not', () => {
    const built = assembleDiagnostics(sources({
      geometry: () => ({ ...baseGeometry(), stereoEyeViewports: eyes(476 / 3) }),
    }), 'refit');
    expect(built.camera.fill).toBeCloseTo(STAGE_FILL_FRACTION, 12);
    expect(built.camera.fillFromDrawPass).toBeCloseTo(STAGE_FILL_FRACTION * 3, 6);
  });

  it('is null, not absent, when no stereo frame has been drawn recently', () => {
    const built = assembleDiagnostics(sources(), 'refit');
    expect(built.camera.fillFromDrawPass).toBeNull();
    expect('fillFromDrawPass' in built.camera).toBe(true);
    const stale = assembleDiagnostics(sources({
      geometry: () => ({ ...baseGeometry(), stereoEyeViewports: eyes(476, 4_000) }),
    }), 'refit');
    expect(stale.camera.fillFromDrawPass).toBeNull();
  });

  it('carries the panel id the source supplies', () => {
    expect(assembleDiagnostics(sources(), 'mount').panelId).toBe('panel-under-test');
  });
});

describe('createDiagnosticsScheduler rates', () => {
  function rated(clock: ReturnType<typeof fakeClock>, send: (trigger: ReportTrigger) => void) {
    return createDiagnosticsScheduler({
      send,
      now: clock.now,
      timers: clock.timers,
      debounceMs: 200,
      minGapMs: 1_000,
      heartbeatMs: HEARTBEAT_MS,
      idleHeartbeatMs: IDLE_HEARTBEAT_MS,
      activeMs: ACTIVE_MS,
      flushMinGapMs: FLUSH_MIN_GAP_MS,
    });
  }

  it('beats at 1 Hz for five seconds after a change, then every ten', () => {
    const clock = fakeClock();
    const sent: ReportTrigger[] = [];
    const scheduled = rated(clock, (trigger) => sent.push(trigger));
    scheduled.start();
    clock.advance(5_000);
    // Mounting counts as the change that opens the first active window.
    expect(sent).toHaveLength(5);
    clock.advance(9_999);
    expect(sent).toHaveLength(5);
    clock.advance(2);
    expect(sent).toHaveLength(6);
    // One minute of an untouched panel: six calls, not sixty.
    clock.advance(45_000);
    expect(sent.length).toBeLessThanOrEqual(10);
  });

  it('goes back to 1 Hz the moment something changes', () => {
    const clock = fakeClock();
    const sent: ReportTrigger[] = [];
    const scheduled = rated(clock, (trigger) => sent.push(trigger));
    scheduled.start();
    clock.advance(20_000);
    const idle = sent.length;
    scheduled.report('mode');
    clock.advance(1_000);
    expect(sent.length).toBe(idle + 1);
    clock.advance(1_000);
    expect(sent.length).toBe(idle + 2);
  });

  it('collapses flushes inside the quarter-second floor into one send', () => {
    const clock = fakeClock();
    const sent: ReportTrigger[] = [];
    const scheduled = rated(clock, (trigger) => sent.push(trigger));
    scheduled.flush('button');
    expect(sent).toEqual(['button']);
    scheduled.flush('button');
    scheduled.flush('button');
    scheduled.flush('button');
    expect(sent).toEqual(['button']);
    clock.advance(250);
    expect(sent).toEqual(['button', 'button']);
    // Ten presses a second is bounded at four sends a second, not ten.
    for (let press = 0; press < 10; press += 1) {
      scheduled.flush('button');
      clock.advance(100);
    }
    expect(sent.length).toBeLessThanOrEqual(2 + 5);
  });
});
