import { describe, expect, it } from 'vitest';
import {
  fillForCheck,
  IdentityUnavailableError,
  isFresherReport,
  markFromIdentity,
  observedLoadSince,
  pairedReportFailures,
  resolveSettleMark,
  type FitDiagnosticsReading,
} from './fit-scenarios.js';

function reading(overrides: Partial<FitDiagnosticsReading> = {}): FitDiagnosticsReading {
  return {
    at: '2026-09-02T10:00:02.000Z',
    sequence: 12,
    panelId: 'panel-a',
    viewerBuild: 'abcd1234',
    trigger: 'heartbeat',
    fill: 0.86,
    fillFromDrawPass: 0.86,
    eyeViewportCssPx: { width: 238, height: 799 },
    eyeCapApplied: true,
    halfCapPx: 238,
    stageRectCssPx: { x: 8, y: 71, width: 476, height: 799 },
    canvasCssPx: { width: 476, height: 799 },
    canvasBackingPx: { width: 952, height: 1598 },
    distanceToTargetAng: 62.891769,
    visibleSphereRadiusAng: 6.636139,
    inTransition: false,
    loadInFlight: false,
    motionRunning: false,
    wheelEventsSinceFit: 0,
    structureSource: 'open',
    fitEventTriggers: ['fallback', 'fallback', 'load', 'load'],
    lastFitEvent: { at: '2026-09-02T10:00:01.000Z', trigger: 'load', distance: 62.891769, fill: 0.86 },
    ...overrides,
  };
}

describe('isFresherReport', () => {
  it('orders by sequence inside one panel', () => {
    const mark = { at: '2026-09-02T10:00:05.000Z', sequence: 12, panelId: 'panel-a' };
    expect(isFresherReport(reading({ sequence: 13 }), mark)).toBe(true);
    expect(isFresherReport(reading({ sequence: 12 }), mark)).toBe(false);
    // The clock does not override the sequence: a panel's own counter is the
    // authority, and a report can carry a later `at` with the same sequence
    // only if it is the same report read twice.
    expect(isFresherReport(reading({ sequence: 12, at: '2026-09-02T10:00:09.000Z' }), mark)).toBe(false);
  });

  /**
   * A run mounts a fresh page per scenario and every earlier panel's last
   * report stays on the server, so `get_state` can legitimately answer with a
   * panel nobody photographed. An earlier clock check let that answer through.
   */
  it('waits rather than accepting another panel, however new its clock', () => {
    const mark = { at: '2026-09-02T10:00:05.000Z', sequence: 400, panelId: 'panel-mounted' };
    expect(isFresherReport(reading({ panelId: 'panel-other', sequence: 900, at: '2026-09-02T10:00:59.000Z' }), mark)).toBe(false);
    expect(isFresherReport(reading({ panelId: undefined, at: '2026-09-02T10:00:59.000Z', sequence: 1 }), mark)).toBe(false);
    expect(isFresherReport(reading({ panelId: 'panel-mounted', sequence: 401 }), mark)).toBe(true);
  });

  it('returns false when either mark or reading has no panelId', () => {
    const unmarked = { at: '2026-09-02T10:00:05.000Z', sequence: -1 };
    const marked = { at: '2026-09-02T10:00:05.000Z', sequence: 12, panelId: 'panel-a' };
    // A later clock on another panel is not freshness: that was the wall-clock
    // fallback, and it let a hidden card's heartbeat close the settle.
    expect(isFresherReport(reading({ at: '2026-09-02T10:00:06.000Z' }), unmarked)).toBe(false);
    expect(isFresherReport(reading({ panelId: undefined, at: '2026-09-02T10:00:06.000Z' }), marked)).toBe(false);
    expect(isFresherReport(reading({ panelId: 'panel-a', sequence: 13 }), marked)).toBe(true);
  });
});

describe('resolveSettleMark', () => {
  const marked = {
    at: '2026-09-02T10:00:05.000Z',
    sequence: 12,
    panelId: 'panel-a',
    fitEventCount: 4,
  };

  it('records mark-missing when a delivery left no mark', () => {
    expect(resolveSettleMark({ pendingMark: undefined, deliveredStructure: true })).toEqual({ kind: 'mark-missing' });
  });

  it('proceeds when a non-delivery carries a mark with a panelId', () => {
    expect(resolveSettleMark({ pendingMark: marked, deliveredStructure: false })).toEqual({
      kind: 'use',
      mark: marked,
      awaitingLoad: false,
    });
  });

  it('takes a fresh mark only for a non-delivery that left none', () => {
    expect(resolveSettleMark({ pendingMark: undefined, deliveredStructure: false })).toEqual({ kind: 'fresh' });
  });

  it('refuses a pending mark that names no panel', () => {
    expect(resolveSettleMark({
      pendingMark: { at: '2026-09-02T10:00:05.000Z', sequence: -1 },
      deliveredStructure: false,
    })).toEqual({ kind: 'identity-unavailable' });
  });
});

describe('markFromIdentity', () => {
  it('throws identity-unavailable when the probe returns null', () => {
    expect(() => markFromIdentity(null, '2026-09-02T10:00:00.000Z')).toThrow(IdentityUnavailableError);
    expect(() => markFromIdentity(null, '2026-09-02T10:00:00.000Z')).toThrow(/identity-unavailable/u);
  });

  it('records the panel the probe named', () => {
    expect(markFromIdentity(
      { panelId: 'panel-a', sequence: 7, fitEventCount: 2, lastFitAt: '2026-09-02T10:00:00.000Z' },
      '2026-09-02T10:00:01.000Z',
    )).toEqual({
      at: '2026-09-02T10:00:01.000Z',
      sequence: 7,
      panelId: 'panel-a',
      fitEventCount: 2,
      lastFitAt: '2026-09-02T10:00:00.000Z',
    });
  });
});

describe('observedLoadSince', () => {
  const mark = { fitEventCount: 4, lastFitAt: '2026-09-02T10:00:01.000Z' };

  it('accepts a load that is still running', () => {
    expect(observedLoadSince(reading({ loadInFlight: true }), mark)).toBe(true);
  });

  it('accepts a load that is already over, by the fit it left behind', () => {
    expect(observedLoadSince(reading({
      fitEventTriggers: ['fallback', 'load', 'load', 'load', 'load'],
      lastFitEvent: { at: '2026-09-02T10:00:04.000Z', trigger: 'load', distance: 62.891769, fill: 0.86 },
    }), mark)).toBe(true);
    // A full ring stops growing, so only the timestamp separates the events.
    expect(observedLoadSince(reading({
      lastFitEvent: { at: '2026-09-02T10:00:04.000Z', trigger: 'load', distance: 62.891769, fill: 0.86 },
    }), mark)).toBe(true);
  });

  /**
   * The race this closes: the settle's own probe flush is assembled before
   * `loadStructure` sets `loadInFlight`, so the report carries a newer
   * sequence, no load and no transition while describing the pre-delivery
   * camera.
   */
  it('rejects a heartbeat that beat the load to the server', () => {
    expect(observedLoadSince(reading(), mark)).toBe(false);
    expect(observedLoadSince(reading({ fitEventTriggers: [], lastFitEvent: undefined }), mark)).toBe(false);
  });

  it('accepts the first fit of a panel that had never fitted at the mark', () => {
    expect(observedLoadSince(reading(), { fitEventCount: 0 })).toBe(true);
  });
});

describe('pairedReportFailures', () => {
  it('accepts a bracket in which nothing happened', () => {
    expect(pairedReportFailures(reading(), reading({ sequence: 13, at: '2026-09-02T10:00:03.000Z' }))).toEqual([]);
  });

  it('rejects a fit that ran across the shutter', () => {
    const after = reading({
      sequence: 13,
      fitEventTriggers: ['fallback', 'fallback', 'load', 'load', 'refit'],
      lastFitEvent: { at: '2026-09-02T10:00:02.500Z', trigger: 'refit', distance: 19.775, fill: 0.86 },
    });
    const failures = pairedReportFailures(reading(), after);
    expect(failures).toHaveLength(2);
    expect(failures[0]).toMatch(/a fit ran across the screenshot/u);
    expect(failures[1]).toMatch(/newest fit event changed/u);
  });

  /**
   * A false defect, in miniature: the photograph caught Mol*'s own
   * post-load camera and the report was taken after `fitCameraToStage` moved
   * it. Same fit-event count is possible here, so the distance is what shows
   * it.
   */
  it('rejects a camera that moved between the shutter and the report', () => {
    const failures = pairedReportFailures(reading(), reading({ sequence: 13, distanceToTargetAng: 19.7758 }));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/the camera moved across the screenshot/u);
  });

  it('rejects a bracket taken while the camera was interpolating', () => {
    expect(pairedReportFailures(reading({ inTransition: true }), reading({ sequence: 13 })))
      .toEqual(['the camera was interpolating when the report before the screenshot was taken']);
    expect(pairedReportFailures(reading(), reading({ sequence: 13, inTransition: true })))
      .toEqual(['the camera was interpolating when the report after the screenshot was taken']);
  });

  it('rejects a bracket that is missing a side', () => {
    expect(pairedReportFailures(undefined, reading())).toEqual(['the panel did not report on both sides of the screenshot']);
    expect(pairedReportFailures(reading(), undefined)).toEqual(['the panel did not report on both sides of the screenshot']);
  });

  it('allows a float that survived a JSON round trip', () => {
    expect(pairedReportFailures(reading(), reading({ sequence: 13, distanceToTargetAng: 62.891769 + 5e-7 }))).toEqual([]);
    expect(pairedReportFailures(reading(), reading({ sequence: 13, distanceToTargetAng: 62.891769 + 2e-6 }))).toHaveLength(1);
  });
});

describe('fillForCheck', () => {
  it('checks the draw pass number in a side-by-side mode', () => {
    expect(fillForCheck('parallel', reading({ fill: 0.86, fillFromDrawPass: 2.58 })))
      .toEqual({ fill: 2.58, source: 'fillFromDrawPass' });
    expect(fillForCheck('cross', reading({ fill: 0.86, fillFromDrawPass: 0.86 })))
      .toEqual({ fill: 0.86, source: 'fillFromDrawPass' });
  });

  /**
   * Anaglyph runs Mol*'s StereoCamera too, and the anaglyph DrawPass
   * fork publishes the full-frame viewport it actually renders each eye into,
   * so the draw pass's own number is checkable there as well.
   */
  it('checks the draw pass number in anaglyph', () => {
    expect(fillForCheck('anaglyph', reading({ fill: 0.86, fillFromDrawPass: 0.8592 })))
      .toEqual({ fill: 0.8592, source: 'fillFromDrawPass' });
  });

  /** Mono has no stereo pass at all, so the layout box is the only eye window. */
  it('checks the layout number in mono', () => {
    expect(fillForCheck('off', reading())).toEqual({ fill: 0.86, source: 'fill' });
    expect(fillForCheck('off', reading({ fillFromDrawPass: null }))).toEqual({ fill: 0.86, source: 'fill' });
  });

  it('reports nothing rather than falling back when the draw pass has not run', () => {
    expect(fillForCheck('parallel', reading({ fillFromDrawPass: null })))
      .toEqual({ fill: undefined, source: 'fillFromDrawPass' });
    expect(fillForCheck('parallel', undefined)).toEqual({ fill: undefined, source: 'fillFromDrawPass' });
  });
});
