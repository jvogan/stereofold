import { describe, expect, it } from 'vitest';
import {
  decideRefit,
  fitGeometryLabel,
  sameFitGeometry,
  type FitGeometry,
} from '../src/fit-decision.js';

/** The Codex side panel, in the numbers the viewer works in. */
const MONO_SIDE_PANEL: FitGeometry = { eyeWidthPx: 1026, eyeHeightPx: 878, radius: 17.782 };
const PARALLEL_SIDE_PANEL: FitGeometry = { eyeWidthPx: 238, eyeHeightPx: 878, radius: 17.782 };
const PARALLEL_INLINE_CARD: FitGeometry = { eyeWidthPx: 238, eyeHeightPx: 437, radius: 17.782 };

const settled = { suspended: false, pinned: false, inTransition: false };

describe('sameFitGeometry', () => {
  it('ignores sub-pixel layout jitter and sub-milli-angstrom sphere jitter', () => {
    expect(sameFitGeometry(
      { eyeWidthPx: 238.4, eyeHeightPx: 877.6, radius: 17.78201 },
      { eyeWidthPx: 237.9, eyeHeightPx: 878.2, radius: 17.78204 },
    )).toBe(true);
  });

  it('separates the mono stage from one capped eye of the same stage', () => {
    expect(sameFitGeometry(MONO_SIDE_PANEL, PARALLEL_SIDE_PANEL)).toBe(false);
  });

  it('treats an unfitted camera as matching nothing, including itself', () => {
    expect(sameFitGeometry(undefined, PARALLEL_SIDE_PANEL)).toBe(false);
    expect(sameFitGeometry(PARALLEL_SIDE_PANEL, undefined)).toBe(false);
    expect(sameFitGeometry(undefined, undefined)).toBe(false);
  });

  it('separates two panels that differ only in height', () => {
    expect(sameFitGeometry(PARALLEL_INLINE_CARD, PARALLEL_SIDE_PANEL)).toBe(false);
  });

  it('separates a style change that grew the visible sphere', () => {
    expect(sameFitGeometry(
      PARALLEL_SIDE_PANEL,
      { ...PARALLEL_SIDE_PANEL, radius: 18.175 },
    )).toBe(false);
  });
});

describe('decideRefit', () => {
  it('reframes when the camera is framed for a geometry that is not the current one', () => {
    expect(decideRefit({ ...settled, current: PARALLEL_SIDE_PANEL, fitted: MONO_SIDE_PANEL })).toBe('refit');
  });

  /*
   * This is the defect, stated as a test. The load fitted in mono against the
   * full stage; a mode arrived in the frame after that fit; the render is now
   * a parallel pair in a 238 CSS px eye. Before this module the viewer
   * recorded the parallel geometry without fitting for it and never refit
   * again, and the structure stayed 3.7x too close for the rest of the
   * session.
   */
  it('reframes a parallel pair still framed for the mono stage it loaded in', () => {
    const decision = decideRefit({ ...settled, current: PARALLEL_SIDE_PANEL, fitted: MONO_SIDE_PANEL });
    expect(decision).toBe('refit');
    // And it keeps saying so until a fit actually happens: a frame that
    // declines must not leave a record behind.
    expect(decideRefit({ ...settled, suspended: true, current: PARALLEL_SIDE_PANEL, fitted: MONO_SIDE_PANEL })).toBe('wait');
    expect(decideRefit({ ...settled, inTransition: true, current: PARALLEL_SIDE_PANEL, fitted: MONO_SIDE_PANEL })).toBe('wait');
    expect(decideRefit({ ...settled, current: PARALLEL_SIDE_PANEL, fitted: MONO_SIDE_PANEL })).toBe('refit');
  });

  it('leaves a framing alone once the fit has been done for it', () => {
    expect(decideRefit({ ...settled, current: PARALLEL_SIDE_PANEL, fitted: PARALLEL_SIDE_PANEL })).toBe('keep');
  });

  /*
   * A wheel zoom or an orbit moves the camera without moving the eye viewport
   * or the scene radius, so the geometry still matches and the person's
   * framing survives. That is the property the old fit key also had and the
   * one this rewrite must not lose.
   */
  it('does not take a person’s own zoom or orbit away from them', () => {
    const afterZoom = { ...PARALLEL_SIDE_PANEL };
    expect(decideRefit({ ...settled, current: afterZoom, fitted: PARALLEL_SIDE_PANEL })).toBe('keep');
  });

  it('fits a scene that has never been fitted', () => {
    expect(decideRefit({ ...settled, current: PARALLEL_SIDE_PANEL, fitted: undefined })).toBe('refit');
  });

  it('waits rather than fitting while a load or a reset owns the camera', () => {
    expect(decideRefit({ ...settled, suspended: true, current: PARALLEL_SIDE_PANEL, fitted: MONO_SIDE_PANEL })).toBe('wait');
  });

  it('waits while Mol* is interpolating a camera transition', () => {
    expect(decideRefit({ ...settled, inTransition: true, current: PARALLEL_SIDE_PANEL, fitted: MONO_SIDE_PANEL })).toBe('wait');
  });

  it('never reframes the depth fixture, whose pose is the stimulus', () => {
    expect(decideRefit({ ...settled, pinned: true, current: PARALLEL_SIDE_PANEL, fitted: MONO_SIDE_PANEL })).toBe('wait');
    expect(decideRefit({ ...settled, pinned: true, current: PARALLEL_SIDE_PANEL, fitted: undefined })).toBe('wait');
  });

  /*
   * The sequences the harness drives, as decisions. Each row is "the camera is
   * framed for A, the panel is now showing B", and every one of them has to
   * reframe: a mode click, a host resize into the side panel, a dock, an
   * undock, and a structure whose sphere changed.
   */
  it.each([
    ['a Parallel click on the inline card', { eyeWidthPx: 720, eyeHeightPx: 437, radius: 17.782 }, PARALLEL_INLINE_CARD],
    ['a host resize from the card into the side panel', PARALLEL_INLINE_CARD, PARALLEL_SIDE_PANEL],
    ['an undock back to the card', PARALLEL_SIDE_PANEL, PARALLEL_INLINE_CARD],
    ['a fresh panel that loaded in mono and is now a pair', MONO_SIDE_PANEL, PARALLEL_SIDE_PANEL],
    ['a surface style that grew the sphere', PARALLEL_SIDE_PANEL, { ...PARALLEL_SIDE_PANEL, radius: 18.175 }],
  ])('reframes after %s', (_label, fitted, current) => {
    expect(decideRefit({ ...settled, current, fitted })).toBe('refit');
  });
});

describe('fitGeometryLabel', () => {
  it('names the two geometries the defect confused', () => {
    expect(fitGeometryLabel(MONO_SIDE_PANEL)).toBe('1026x878|17.782');
    expect(fitGeometryLabel(PARALLEL_SIDE_PANEL)).toBe('238x878|17.782');
    expect(fitGeometryLabel(undefined)).toBe('unfitted');
  });
});
