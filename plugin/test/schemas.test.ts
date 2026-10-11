import { describe, expect, it } from 'vitest';
import { anaglyphVariantSchema, claimActionInputSchema, completeActionInputSchema, controlInputSchema, diagnosticsSchema, lookColorSchema, lookStyleSchema, openInputSchema, reportDiagnosticsInputSchema, setMotionInputSchema, setModeInputSchema, syncViewInputSchema, type DiagnosticsPayload } from '../src/schemas.js';
import type { Diagnostics } from '../src/fit-diagnostics.js';
import { MINIMAL_DIAGNOSTICS } from './fixtures/diagnostics.js';

const SESSION_ID = '54d4de0f-e188-42a8-9921-0c51ea458c44';

describe('Stereofold tool schemas', () => {
  it('accepts one PDB accession or one pasted coordinate payload, never both', () => {
    expect(openInputSchema.parse({ pdbId: '1ema' })).toMatchObject({ pdbId: '1EMA' });
    expect(openInputSchema.parse({ structureText: 'data_demo\n_atom_site.id 1\n#\n', format: 'mmcif' })).toMatchObject({ format: 'mmcif' });
    expect(openInputSchema.safeParse({}).success).toBe(false);
    expect(openInputSchema.safeParse({ pdbId: '1EMA', structureText: 'ATOM      1  N   GLY A   1      0.0 0.0 0.0' }).success).toBe(false);
    expect(openInputSchema.safeParse({ pdbId: 'bad' }).success).toBe(false);
    expect(openInputSchema.safeParse({ pdbId: ' 1EMA ' }).success).toBe(false);
    // Source-free open is the sole re-render branch and therefore requires a
    // server-issued session capability.
    expect(openInputSchema.parse({ sessionId: SESSION_ID })).toEqual({ sessionId: SESSION_ID });
    expect(openInputSchema.safeParse({ sessionId: 'not-a-server-session' }).success).toBe(false);
  });

  it('keeps legacy controls while the richer motion tool has its own schema', () => {
    expect(controlInputSchema.parse({ sessionId: SESSION_ID, action: 'load_pdb', pdbId: '1ema' })).toMatchObject({ pdbId: '1EMA' });
    expect(controlInputSchema.parse({ sessionId: SESSION_ID, action: 'reset_camera' })).toMatchObject({ action: 'reset_camera' });
    expect(controlInputSchema.parse({ sessionId: SESSION_ID, action: 'fit' })).toMatchObject({ action: 'fit' });
    expect(controlInputSchema.safeParse({ sessionId: SESSION_ID, action: 'fit', pdbId: '1EMA' }).success).toBe(false);
    expect(controlInputSchema.parse({ sessionId: SESSION_ID, action: 'set_motion', motion: 'rock' })).toMatchObject({ motion: 'rock' });
    expect(controlInputSchema.safeParse({ sessionId: SESSION_ID, action: 'set_motion', motion: 'parallax' }).success).toBe(false);
    expect(controlInputSchema.safeParse({ sessionId: SESSION_ID, action: 'delete_structure' }).success).toBe(false);
    expect(controlInputSchema.safeParse({ action: 'fit' }).success).toBe(false);
    expect(controlInputSchema.safeParse({ sessionId: SESSION_ID, action: 'load_pdb', pdbId: ' 1EMA ' }).success).toBe(false);
  });

  it('uses named stereo modes and an angular strength rather than an Ångström input', () => {
    expect(setModeInputSchema.parse({ sessionId: SESSION_ID, mode: 'parallel', depthBudgetArcmin: 20, swapEyes: true })).toMatchObject({ mode: 'parallel' });
    expect(setModeInputSchema.safeParse({ sessionId: SESSION_ID, mode: 'parallel', eyeSeparation: 2.6 }).success).toBe(false);
  });

  it('names the two anaglyph compositors and leaves the variant optional', () => {
    expect(setModeInputSchema.parse({ sessionId: SESSION_ID, mode: 'anaglyph', variant: 'balanced' })).toMatchObject({ variant: 'balanced' });
    expect(setModeInputSchema.parse({ sessionId: SESSION_ID, mode: 'anaglyph', variant: 'dubois' })).toMatchObject({ variant: 'dubois' });
    // Omitting it leaves the viewer and the server on their own default,
    // which is balanced.
    expect(setModeInputSchema.parse({ sessionId: SESSION_ID, mode: 'anaglyph' }).variant).toBeUndefined();
    expect(anaglyphVariantSchema.safeParse('optimised').success).toBe(false);
    expect(setModeInputSchema.safeParse({ sessionId: SESSION_ID, mode: 'anaglyph', variant: 'dubious' }).success).toBe(false);
  });

  it('lets the model choose a colour and a style when it opens a structure', () => {
    const opened = openInputSchema.parse({ pdbId: '1crn', color: 'secondary-structure', style: 'molecular-surface' });
    expect(opened).toMatchObject({ pdbId: '1CRN', color: 'secondary-structure', style: 'molecular-surface' });
    // Both stay optional: an open call that says nothing about the look keeps
    // whatever is in force.
    expect(openInputSchema.parse({ pdbId: '1crn' })).not.toHaveProperty('color');
    expect(openInputSchema.safeParse({ pdbId: '1crn', color: 'uncertainty' }).success).toBe(false);
    expect(openInputSchema.safeParse({ pdbId: '1crn', style: 'illustrative' }).success).toBe(false);
  });

  it('recolours and restyles a loaded structure through control.set_look', () => {
    expect(controlInputSchema.parse({ sessionId: SESSION_ID, action: 'set_look', color: 'element-symbol' }))
      .toEqual({ sessionId: SESSION_ID, action: 'set_look', color: 'element-symbol' });
    expect(controlInputSchema.parse({ sessionId: SESSION_ID, action: 'set_look', style: 'atomic-detail' }))
      .toEqual({ sessionId: SESSION_ID, action: 'set_look', style: 'atomic-detail' });
    expect(controlInputSchema.parse({ sessionId: SESSION_ID, action: 'set_look', color: 'chain-id', style: 'molecular-surface' }))
      .toMatchObject({ color: 'chain-id', style: 'molecular-surface' });
    // A set_look that names neither would be a silent no-op, so it is refused.
    expect(controlInputSchema.safeParse({ sessionId: SESSION_ID, action: 'set_look' }).success).toBe(false);
    expect(controlInputSchema.safeParse({ sessionId: SESSION_ID, action: 'set_look', color: 'rainbow' }).success).toBe(false);
    // The union is still strict: an unknown field is not quietly dropped.
    expect(controlInputSchema.safeParse({ sessionId: SESSION_ID, action: 'set_look', color: 'chain-id', theme: 'x' }).success).toBe(false);
    expect(controlInputSchema.safeParse({ sessionId: SESSION_ID, action: 'reset_camera', color: 'chain-id' }).success).toBe(false);
  });

  it('carries the whole view state on the app-only sync tool, every field optional', () => {
    const full = { sessionId: SESSION_ID, baseStateRevision: 4, mode: 'cross', depthBudgetArcmin: 33, swapEyes: true, variant: 'dubois', color: 'sequence-id', style: 'atomic-detail' };
    expect(syncViewInputSchema.parse(full)).toEqual(full);
    // Optional so the server can merge: a field the panel omits keeps the
    // value the model last set through set_mode.
    expect(syncViewInputSchema.parse({ sessionId: SESSION_ID })).toEqual({ sessionId: SESSION_ID });
    expect(syncViewInputSchema.parse({ sessionId: SESSION_ID, depthBudgetArcmin: 0 })).toEqual({ sessionId: SESSION_ID, depthBudgetArcmin: 0 });
    expect(syncViewInputSchema.parse({ sessionId: SESSION_ID, motion: { mode: 'parallax', axis: 'x' } })).toEqual({ sessionId: SESSION_ID, motion: { mode: 'parallax', axis: 'x' } });
    expect(syncViewInputSchema.safeParse({ sessionId: SESSION_ID, depthBudgetArcmin: 61 }).success).toBe(false);
    expect(syncViewInputSchema.safeParse({ sessionId: SESSION_ID, depthBudgetArcmin: Number.NaN }).success).toBe(false);
    expect(syncViewInputSchema.safeParse({ sessionId: SESSION_ID, mode: 'wall-eyed' }).success).toBe(false);
    expect(syncViewInputSchema.safeParse({ sessionId: SESSION_ID, color: 'uncertainty' }).success).toBe(false);
    expect(syncViewInputSchema.safeParse({ sessionId: SESSION_ID, motion: 'rock' }).success).toBe(false);
    expect(syncViewInputSchema.safeParse({ sessionId: SESSION_ID, baseStateRevision: -1 }).success).toBe(false);
    expect(syncViewInputSchema.safeParse({ sessionId: SESSION_ID, baseStateRevision: 1.5 }).success).toBe(false);
  });

  it('requires a server-issued action identity and render lease on app-only action calls', () => {
    const actionId = '1c5b48fa-6fda-49be-9a68-d6a1fe7c3882';
    const lease = { sessionId: SESSION_ID, actionId, renderToken: 7 };
    expect(claimActionInputSchema.parse(lease)).toEqual(lease);
    expect(completeActionInputSchema.parse(lease)).toEqual(lease);
    expect(claimActionInputSchema.safeParse({ sessionId: SESSION_ID }).success).toBe(false);
    expect(claimActionInputSchema.safeParse({ sessionId: SESSION_ID, actionId }).success).toBe(false);
    expect(claimActionInputSchema.safeParse({ ...lease, renderToken: 0 }).success).toBe(false);
    expect(claimActionInputSchema.safeParse({ ...lease, renderToken: 1.5 }).success).toBe(false);
    expect(claimActionInputSchema.safeParse({ ...lease, extra: true }).success).toBe(false);
    expect(claimActionInputSchema.safeParse({ sessionId: SESSION_ID, actionId: 'not-a-server-action' }).success).toBe(false);
    expect(completeActionInputSchema.safeParse({ sessionId: SESSION_ID, actionId }).success).toBe(false);
    expect(completeActionInputSchema.safeParse({ ...lease, extra: true }).success).toBe(false);
  });

  it('names the five colour themes and three presets and nothing else', () => {
    expect(lookColorSchema.options).toEqual(['chain-id', 'sequence-id', 'secondary-structure', 'element-symbol', 'plddt-confidence']);
    expect(lookStyleSchema.options).toEqual(['polymer-and-ligand', 'atomic-detail', 'molecular-surface']);
  });

  it('accepts motion defaults but rejects invalid modes, periods, axes, and amplitudes', () => {
    expect(setMotionInputSchema.parse({ sessionId: SESSION_ID, mode: 'rock' })).toEqual({ sessionId: SESSION_ID, mode: 'rock' });
    expect(setMotionInputSchema.parse({ sessionId: SESSION_ID, mode: 'spin', periodS: 60, axis: 'y' })).toMatchObject({ mode: 'spin', periodS: 60, axis: 'y' });
    expect(setMotionInputSchema.safeParse({ sessionId: SESSION_ID, mode: 'wiggle' }).success).toBe(false);
    expect(setMotionInputSchema.safeParse({ sessionId: SESSION_ID, mode: 'rock', amplitudeDeg: -1 }).success).toBe(false);
    expect(setMotionInputSchema.safeParse({ sessionId: SESSION_ID, mode: 'rock', amplitudeDeg: Number.NaN }).success).toBe(false);
    expect(setMotionInputSchema.safeParse({ sessionId: SESSION_ID, mode: 'spin', periodS: 0 }).success).toBe(false);
    expect(setMotionInputSchema.safeParse({ sessionId: SESSION_ID, mode: 'rock', axis: 'z' }).success).toBe(false);
    expect(setMotionInputSchema.safeParse({ sessionId: SESSION_ID, mode: 'none', unknown: true }).success).toBe(false);
  });
});

/**
 * The wire form of `../src/fit-diagnostics.ts`.
 *
 * Two schemas describe one object — TypeScript types in the module the viewer
 * assembles from, zod in the module the server validates with — so the pair
 * has to be pinned against each other. The two assignments below are the pin:
 * a field added on one side and not the other stops `tsc`, which is the gate
 * this repo already runs, rather than silently dropping a number someone is
 * reading in a live host.
 */
const _payloadIsDiagnostics: DiagnosticsPayload = {} as Diagnostics;
const _diagnosticsIsPayload: Diagnostics = {} as DiagnosticsPayload;
void _payloadIsDiagnostics;
void _diagnosticsIsPayload;

describe('fit diagnostics schema', () => {
  it('accepts a panel that has drawn nothing, with every optional field absent', () => {
    expect(diagnosticsSchema.parse(MINIMAL_DIAGNOSTICS)).toEqual(MINIMAL_DIAGNOSTICS);
    expect(reportDiagnosticsInputSchema.parse({ sessionId: SESSION_ID, diagnostics: MINIMAL_DIAGNOSTICS }).diagnostics.camera.fill).toBeUndefined();
  });

  it('accepts the optional fields a drawing panel adds', () => {
    const full: Diagnostics = {
      ...MINIMAL_DIAGNOSTICS,
      host: {
        ...MINIMAL_DIAGNOSTICS.host,
        containerDimensions: { width: 1026, maxHeight: 878 },
        hostViewportWidthPx: 1026,
        hostViewportHeightPx: 878,
        hostContextAt: '2026-09-02T09:59:59.000Z',
        visualViewportScale: 1,
      },
      geometry: {
        ...MINIMAL_DIAGNOSTICS.geometry,
        halfCapPx: 238,
        stereoEyeViewports: {
          left: { x: 0, y: 0, width: 476, height: 1598 },
          right: { x: 476, y: 0, width: 476, height: 1598 },
          parent: { x: 0, y: 0, width: 952, height: 1598 },
          ageMs: 16,
        },
      },
      panelId: '2f3a6f1e-0d2b-4a1c-9f5e-6b0a7c8d9e10',
      camera: { ...MINIMAL_DIAGNOSTICS.camera, projectedSphereDiameterPx: 204.68, fill: 0.86, fillFromDrawPass: 0.86 },
      fit: {
        ...MINIMAL_DIAGNOSTICS.fit,
        fittedGeometry: { eyeWidthPx: 238, eyeHeightPx: 799, radius: 17.782 },
        lastDecision: {
          at: '2026-09-02T10:00:00.000Z',
          decision: 'keep',
          current: { eyeWidthPx: 238, eyeHeightPx: 799, radius: 17.782 },
          fitted: { eyeWidthPx: 238, eyeHeightPx: 799, radius: 17.782 },
          suspended: false,
          pinned: false,
          inTransition: false,
        },
        events: [{ at: '2026-09-02T10:00:00.000Z', trigger: 'button', eyeWidthPx: 238, eyeHeightPx: 799, radius: 17.782, distance: 52.99, fill: 0.86 }],
      },
      state: {
        ...MINIMAL_DIAGNOSTICS.state,
        pdbId: '1CRN',
        motionBaselineDistanceAng: 52.99,
        structureSource: 'fallback',
        fallback: { tries: 2, lastError: 'threw', done: true, at: '2026-09-02T10:00:00.000Z' },
      },
    };
    expect(diagnosticsSchema.parse(full)).toEqual(full);
  });

  it('is strict at every level, so a field the server does not know about is refused', () => {
    expect(diagnosticsSchema.safeParse({ ...MINIMAL_DIAGNOSTICS, unexpected: 1 }).success).toBe(false);
    expect(diagnosticsSchema.safeParse({ ...MINIMAL_DIAGNOSTICS, camera: { ...MINIMAL_DIAGNOSTICS.camera, unexpected: 1 } }).success).toBe(false);
    expect(diagnosticsSchema.safeParse({ ...MINIMAL_DIAGNOSTICS, host: { ...MINIMAL_DIAGNOSTICS.host, containerDimensions: { depth: 3 } } }).success).toBe(false);
    expect(reportDiagnosticsInputSchema.safeParse({ sessionId: SESSION_ID, diagnostics: MINIMAL_DIAGNOSTICS, extra: true }).success).toBe(false);
  });

  it('refuses a value JSON turned into null, and a trigger it does not name', () => {
    expect(diagnosticsSchema.safeParse({ ...MINIMAL_DIAGNOSTICS, camera: { ...MINIMAL_DIAGNOSTICS.camera, fovRad: null } }).success).toBe(false);
    expect(diagnosticsSchema.safeParse({ ...MINIMAL_DIAGNOSTICS, trigger: 'whenever' }).success).toBe(false);
    expect(diagnosticsSchema.safeParse({ ...MINIMAL_DIAGNOSTICS, fit: { ...MINIMAL_DIAGNOSTICS.fit, events: [{ at: 'x', trigger: 'gremlin', eyeWidthPx: 1, eyeHeightPx: 1, radius: 1, distance: 1 }] } }).success).toBe(false);
    expect(diagnosticsSchema.safeParse({ ...MINIMAL_DIAGNOSTICS, state: { ...MINIMAL_DIAGNOSTICS.state, structureSource: 'magic' } }).success).toBe(false);
  });

  it('keeps halfCapPx nullable, because a mono panel has no cap rather than a cap of zero', () => {
    expect(diagnosticsSchema.parse(MINIMAL_DIAGNOSTICS).geometry.halfCapPx).toBeNull();
    expect(diagnosticsSchema.safeParse({ ...MINIMAL_DIAGNOSTICS, geometry: { ...MINIMAL_DIAGNOSTICS.geometry, halfCapPx: undefined } }).success).toBe(false);
  });

  /**
   * An older viewer build sends no `panelId`, no `fillFromDrawPass` and no
   * `state.fallback`, and its reports still have to validate: a restage that
   * left one old panel mounted must not turn into a stream of rejected
   * reports and a `get_state` with nothing in it.
   */
  it('accepts a report from a viewer built before the panel id and the retry state', () => {
    expect(diagnosticsSchema.safeParse(MINIMAL_DIAGNOSTICS).success).toBe(true);
    expect(diagnosticsSchema.parse(MINIMAL_DIAGNOSTICS).panelId).toBeUndefined();
    expect(diagnosticsSchema.parse(MINIMAL_DIAGNOSTICS).camera.fillFromDrawPass).toBeUndefined();
    expect(diagnosticsSchema.parse(MINIMAL_DIAGNOSTICS).state.fallback).toBeUndefined();
  });

  it('keeps fillFromDrawPass nullable: no stereo frame drawn is a reading, not a gap', () => {
    const drawn = { ...MINIMAL_DIAGNOSTICS, camera: { ...MINIMAL_DIAGNOSTICS.camera, fillFromDrawPass: null } };
    expect(diagnosticsSchema.parse(drawn).camera.fillFromDrawPass).toBeNull();
    expect(diagnosticsSchema.safeParse({ ...MINIMAL_DIAGNOSTICS, camera: { ...MINIMAL_DIAGNOSTICS.camera, fillFromDrawPass: 'none' } }).success).toBe(false);
  });

  it('names the four kinds of unanswered get_structure and refuses a fifth', () => {
    for (const lastError of ['threw', 'no-result', 'incomplete', 'malformed']) {
      const withError = { ...MINIMAL_DIAGNOSTICS, state: { ...MINIMAL_DIAGNOSTICS.state, fallback: { tries: 1, lastError, done: false } } };
      expect(diagnosticsSchema.safeParse(withError).success).toBe(true);
    }
    const bogus = { ...MINIMAL_DIAGNOSTICS, state: { ...MINIMAL_DIAGNOSTICS.state, fallback: { tries: 1, lastError: 'gremlin', done: false } } };
    expect(diagnosticsSchema.safeParse(bogus).success).toBe(false);
  });

  it('keeps diagnostics strings bounded so app reports cannot smuggle coordinates into get_state', () => {
    const coordinates = 'ATOM      1  N   GLY A   1       1.000   2.000   3.000\nEND\n';
    expect(diagnosticsSchema.safeParse({ ...MINIMAL_DIAGNOSTICS, at: 'not-a-date' }).success).toBe(false);
    expect(diagnosticsSchema.safeParse({ ...MINIMAL_DIAGNOSTICS, viewerBuild: coordinates }).success).toBe(false);
    expect(diagnosticsSchema.safeParse({ ...MINIMAL_DIAGNOSTICS, host: { ...MINIMAL_DIAGNOSTICS.host, displayMode: coordinates } }).success).toBe(false);
    expect(diagnosticsSchema.safeParse({ ...MINIMAL_DIAGNOSTICS, host: { ...MINIMAL_DIAGNOSTICS.host, visibilityState: 'prerender' } }).success).toBe(false);
    expect(diagnosticsSchema.safeParse({ ...MINIMAL_DIAGNOSTICS, state: { ...MINIMAL_DIAGNOSTICS.state, pdbId: coordinates } }).success).toBe(false);
    expect(diagnosticsSchema.safeParse({ ...MINIMAL_DIAGNOSTICS, state: { ...MINIMAL_DIAGNOSTICS.state, mode: 'wall-eyed' } }).success).toBe(false);
    expect(diagnosticsSchema.safeParse({ ...MINIMAL_DIAGNOSTICS, state: { ...MINIMAL_DIAGNOSTICS.state, variant: 'unknown' } }).success).toBe(false);
    expect(diagnosticsSchema.safeParse({ ...MINIMAL_DIAGNOSTICS, state: { ...MINIMAL_DIAGNOSTICS.state, color: 'rainbow' } }).success).toBe(false);
    expect(diagnosticsSchema.safeParse({ ...MINIMAL_DIAGNOSTICS, state: { ...MINIMAL_DIAGNOSTICS.state, style: 'wireframe' } }).success).toBe(false);
    expect(diagnosticsSchema.safeParse({ ...MINIMAL_DIAGNOSTICS, state: { ...MINIMAL_DIAGNOSTICS.state, motionMode: 'wiggle' } }).success).toBe(false);
  });
});
