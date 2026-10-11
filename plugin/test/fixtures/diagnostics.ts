import type { Diagnostics } from '../../src/fit-diagnostics.js';

/**
 * The smallest fit-diagnostics object a real panel can produce.
 *
 * Shared by the schema test and the packaging test, because the two ask
 * different questions of the same object: whether the wire schema accepts what
 * the viewer's types produce, and whether `stereo_structure.get_state` hands it
 * back byte for byte. A second copy would let those two drift apart, which is
 * the failure the strict schema exists to prevent.
 */
export const MINIMAL_DIAGNOSTICS: Diagnostics = {
  at: '2026-09-02T10:00:00.000Z',
  viewerBuild: 'test',
  sequence: 1,
  trigger: 'mount',
  host: {
    displayMode: 'inline',
    hostContextCount: 0,
    innerWidthPx: 1026,
    innerHeightPx: 878,
    devicePixelRatio: 2,
    visibilityState: 'visible',
  },
  geometry: {
    stageRectCssPx: { x: 0, y: 0, width: 0, height: 0 },
    letterboxRectCssPx: { x: 0, y: 0, width: 0, height: 0 },
    eyeViewportCssPx: { width: 1, height: 1 },
    eyeCapApplied: false,
    halfCapPx: null,
    canvasCssPx: { width: 0, height: 0 },
    canvasBackingPx: { width: 0, height: 0 },
    cameraViewport: { x: 0, y: 0, width: 0, height: 0 },
  },
  camera: {
    distanceToTargetAng: 0,
    radiusAng: 0,
    fovRad: 0,
    visibleSphereRadiusAng: 0,
    boundingSphereVisibleRadiusAng: 0,
    inTransition: false,
  },
  fit: { fitSuspended: false, fixturePinned: false, loadInFlight: false, events: [] },
  state: {
    mode: 'off',
    depthBudgetArcmin: 20,
    swapEyes: false,
    variant: 'balanced',
    color: 'chain-id',
    style: 'polymer-and-ligand',
    motionMode: 'rock',
    motionRunning: false,
    structureLoaded: false,
    messageCounts: { open: 0, state: 0, mode: 0 },
    structureSource: 'none',
  },
  user: { wheelEventsSinceFit: 0, wheelEventsTotal: 0 },
};

