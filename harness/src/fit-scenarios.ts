/**
 * Sequences that reach the viewer's fit through a path the mode-switch loop
 * never takes.
 *
 * The existing per-profile run mounts once, is handed a tool result, and then
 * clicks the four mode buttons. That is one ordering out of many, and it is
 * the only one the plugin was ever measured on. A Codex side panel on
 * an earlier build came up through a different one and framed the structure for a
 * viewport more than twice the size of the one it rendered into: the molecule
 * was cut by hard vertical edges at all four eye-window edges.
 *
 * Each scenario here drives one such ordering and measures, per eye, where the
 * lit pixels landed inside that eye's window. They are part of the harness
 * rather than a one-off script because the contract they check — after any
 * load, mode change, host resize, dock or undock, both eye images are framed
 * inside the capped eye window — has to survive the next change to the fit.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Frame, Page } from 'playwright';
import { decodePng } from './png.js';
import { disparityRangeCssPx, judgeEyeFit, judgeMonoFit, silhouetteRatio, type EyeBoxReport, type EyeFitVerdict } from './eye-box.js';
import type { HostProfileId } from './profiles.js';

export type PanelBox = { width: number; height: number };

/**
 * What the live panel said about itself, read back through the server.
 *
 * The viewer reports through the app-only `stereo_structure.report_diagnostics`
 * tool and `stereo_structure.get_state` hands the last report back, which is
 * the same path a real Codex conversation uses. The harness reads it the same
 * way on purpose: a channel that only works when a test reaches into the frame
 * is not the channel that has to work in a host nobody can reach.
 *
 * Only the fields the fit argument turns on are kept. The whole object is on
 * the server and in the report; this is what belongs beside a measurement.
 */
export type FitDiagnosticsReading = {
  at: string;
  sequence: number;
  /** Random per mounted viewer. Sequences are only comparable within one. */
  panelId?: string;
  /** sha-256 of the shipped viewer.html: which bytes are mounted. */
  viewerBuild: string;
  trigger: string;
  /** The number the whole harness is about. 0.86 when the fit is right. */
  fill?: number;
  /**
   * The same number measured against the eye viewport the draw pass used,
   * null when no stereo frame has been drawn in the last second.
   *
   * This is the one the FILL check compares in a stereo mode. `fill` divides
   * by the viewer's own layout box, so the two agree exactly when that box is
   * right, and only this one moves when it is not.
   */
  fillFromDrawPass?: number | null;
  projectedSphereDiameterPx?: number;
  eyeViewportCssPx: { width: number; height: number };
  eyeCapApplied: boolean;
  halfCapPx: number | null;
  fittedGeometry?: { eyeWidthPx: number; eyeHeightPx: number; radius: number };
  lastDecision?: string;
  stageRectCssPx: { x: number; y: number; width: number; height: number };
  canvasCssPx: { width: number; height: number };
  canvasBackingPx: { width: number; height: number };
  stereoEyeViewports?: { left: { width: number }; right: { width: number }; ageMs: number };
  distanceToTargetAng: number;
  visibleSphereRadiusAng: number;
  /** True while Mol* is interpolating a camera transition. */
  inTransition: boolean;
  /** True while a load owns the camera. The settle waits for this to fall. */
  loadInFlight: boolean;
  motionRunning: boolean;
  motionBaselineDistanceAng?: number;
  wheelEventsSinceFit: number;
  structureSource: string;
  fitEventTriggers: string[];
  /** The newest fit event, whole, so two readings can be compared. */
  lastFitEvent?: { at: string; trigger: string; distance: number; fill?: number };
  /** The retry state of the fresh-panel get_structure fallback. */
  fallback?: { tries: number; lastError?: string; done: boolean; at?: string };
};

export type FitMeasurement = {
  scenario: string;
  step: string;
  profile: HostProfileId;
  deviceScaleFactor: number;
  mode: string;
  /** Modelled host card at the moment of the measurement, CSS px. */
  panelCssPx: PanelBox;
  /** The Mol* canvas, which in a side-by-side mode is the capped stage. */
  canvasCssPx: PanelBox;
  /** One eye's window, CSS px. Equal to the canvas in mono. */
  eyeWindowCssPx: PanelBox;
  /** `B … Å · F … Å` as the drawer reports it, so the fit distance is on record. */
  cameraStatus: string;
  /** The mode this step required the panel to be in, when it required one. */
  expectedMode?: string;
  left: EyeBoxReport;
  right: EyeBoxReport;
  sizeDeltaCssPx: { width: number; height: number };
  pairOffsetDeltaCssPx: { x: number; y: number };
  /** What the panel reported for this frame, read back through get_state. */
  diagnostics?: FitDiagnosticsReading;
  /** The lit box's largest extent over the eye window's shorter side. */
  silhouetteRatioMeasured: number | null;
  /** The fill actually compared against the pixels: see `fillForCheck`. */
  fillChecked?: number;
  /** Which reading that was, `fill` or `fillFromDrawPass`. */
  fillSource: string;
  /** Why the reported fill and the pixels disagree, when they do. */
  fillFailures: string[];
  /**
   * Why the reports either side of the screenshot do not describe the same
   * frame, when they do not. Empty on an accepted measurement.
   */
  reportPairing: string[];
  /** How many times the photograph had to be retaken to bracket it. */
  measureAttempts: number;
  /**
   * Why the settle before this measurement could not prove what it waited for.
   *
   * Empty on an accepted measurement. `load-never-observed` means a delivery
   * was made and the panel never reported a load in flight nor a fit event
   * newer than the mark taken before it. `mark-missing` means a delivery was
   * made and no mark was taken before it, so the frame was not photographed.
   * `identity-unavailable` means `__stereoStructureProbe.identity()` returned
   * null, so no panel could be named.
   */
  settleFailures: string[];
  pass: boolean;
  failures: string[];
  screenshot: string;
  panelScreenshot: string;
};

export type FitScenarioContext = {
  page: Page;
  frame: Frame;
  profileId: HostProfileId;
  deviceScaleFactor: number;
  inline: PanelBox;
  fullscreen: PanelBox;
  /** Call an MCP tool on the Node side, without delivering the result. */
  callTool: (name: string, args?: Record<string, unknown>) => Promise<CallToolResult>;
  /** A fresh `stereo_structure.open` result for the structure under test. */
  openStructure: () => Promise<CallToolResult>;
  /** Deliver a tool result to the panel as the host would. */
  deliverResult: (result: CallToolResult, args?: Record<string, unknown>) => Promise<void>;
  /** Click a mode button and wait for it to take. */
  clickMode: (mode: 'off' | 'parallel' | 'cross' | 'anaglyph') => Promise<void>;
  /** Host-driven resize plus a host-context change carrying the display mode. */
  setDisplayMode: (mode: 'inline' | 'fullscreen') => Promise<void>;
  /** Host-driven resize with no display-mode change. */
  setPanelSize: (box: PanelBox) => Promise<void>;
  /** Click the app's own dock toggle, which goes through requestDisplayMode. */
  clickDisplayModeToggle: () => Promise<void>;
  /** Wait for a structure to be on the stage. */
  waitForStructure: () => Promise<void>;
  /** Wait for the fit to stop moving. */
  settle: () => Promise<void>;
  /**
   * Measure the frame, optionally asserting which mode the panel must be in.
   *
   * The mode is part of the contract for a fresh panel: a panel that comes up
   * in mono when the session is in parallel is framed correctly for mono and
   * would otherwise pass, while the person is looking at the wrong picture.
   */
  measure: (step: string, expectedMode?: string) => Promise<FitMeasurement>;
  /** Put the server's own view state where a later mount will read it. */
  setServerMode: (mode: 'off' | 'parallel' | 'cross' | 'anaglyph') => Promise<void>;
  /**
   * Press the toolbar's Fit button and check what the panel says happened.
   *
   * Kept out of {@link FitScenarioContext.measure} so the fifteen fit
   * measurements stay the same fifteen they were before this check, and
   * reported on its own line. The button exists to separate "the fit
   * computation is wrong in this host" from "the fit never ran for this
   * geometry", so the thing to check is that a press produces a `button` fit
   * event and a fill back at 0.86.
   */
  checkFitButton: (step: string) => Promise<FitButtonCheck>;
};

/** What one press of the toolbar Fit button did, as the panel reports it. */
export type FitButtonCheck = {
  scenario: string;
  step: string;
  profile: HostProfileId;
  deviceScaleFactor: number;
  visible: boolean;
  /** The reported fill before and after the press. */
  fillBefore?: number;
  fillAfter?: number;
  /** The newest entry in the panel's fit-event ring after the press. */
  lastTrigger?: string;
  pass: boolean;
  failures: string[];
};

export type FitScenario = {
  id: string;
  title: string;
  /** False mounts a panel that was never handed a tool result. */
  deliverOnMount: boolean;
  /** Display mode carried by the very first host context. */
  initialDisplayMode: 'inline' | 'fullscreen';
  /**
   * The server's stereo mode when this panel mounts.
   *
   * Defaults to the shipped `off`. A scenario that sets it to `parallel` is
   * modelling the ordinary case where the panel on screen is a fresh mount and
   * the session it belongs to is already in a stereo mode.
   */
  serverMode?: 'off' | 'parallel' | 'cross' | 'anaglyph';
  run: (context: FitScenarioContext) => Promise<void>;
};

/**
 * The five sequences, in a fixed order.
 *
 * "Inline" is the profile's own panel and "fullscreen" is the side-panel
 * geometry, so on the `codex-side-panel` profile the two are the same box and
 * the docking scenarios degenerate into a mode change. That is deliberate: the
 * contract has to hold on every profile, and a scenario that cannot move the
 * box still exercises the ordering.
 */
export const FIT_SCENARIOS: FitScenario[] = [
  {
    id: 's1-fresh-mount-then-parallel',
    title: 'Fresh open-rendered mount hydrates its session, then Parallel is clicked',
    deliverOnMount: true,
    initialDisplayMode: 'inline',
    async run(context) {
      // The open result carries the session and the panel hydrates its cache
      // in the initial `off` mode.
      await context.waitForStructure();
      await context.settle();
      await context.measure('mono after the fallback load');
      await context.clickMode('parallel');
      await context.settle();
      await context.measure('after the Parallel click');
      // The Fit button, pressed on a panel that is already correctly framed:
      // a press must still run the fit, record a `button` event and leave the
      // fill where it was. That is what makes a press in a real side panel
      // readable either way — if it fixes the framing a trigger is missing,
      // and if it does not the computation or the eye geometry is wrong.
      await context.checkFitButton('Fit button pressed while already framed');
    },
  },
  {
    id: 's2-parallel-then-host-resize-to-side-panel',
    title: 'Loaded in Parallel at the inline card, then the host resizes to the side panel with displayMode fullscreen',
    deliverOnMount: true,
    initialDisplayMode: 'inline',
    async run(context) {
      await context.waitForStructure();
      await context.clickMode('parallel');
      await context.settle();
      await context.measure('parallel on the inline card');
      await context.setDisplayMode('fullscreen');
      await context.settle();
      await context.measure('after the host resize to the side panel');
    },
  },
  {
    id: 's3-mount-fullscreen-then-load',
    title: 'Mounted by an open render result at side-panel geometry with displayMode fullscreen in the first host context',
    deliverOnMount: true,
    initialDisplayMode: 'fullscreen',
    async run(context) {
      // `open` is now the sole render path, so every legitimate fresh mount is
      // given its session-bearing result. This still models Codex re-mounting
      // the webview at fullscreen geometry instead of moving the old frame.
      await context.waitForStructure();
      await context.settle();
      await context.measure('mono after the fallback load');
      await context.clickMode('parallel');
      await context.settle();
      await context.measure('after the Parallel click');
      // And the other reading of "then load": a tool result arriving into a
      // panel that is already docked and already in Parallel.
      await context.deliverResult(await context.callTool('stereo_structure.get_state'));
      await context.settle();
      await context.measure('after a state result while docked');
    },
  },
  {
    id: 's4-dock-round-trip',
    title: 'Inline to fullscreen to inline through requestDisplayMode, with the frame resized both ways',
    deliverOnMount: true,
    initialDisplayMode: 'inline',
    async run(context) {
      await context.waitForStructure();
      await context.clickMode('parallel');
      await context.settle();
      await context.measure('parallel, inline');
      await context.clickDisplayModeToggle();
      await context.settle();
      await context.measure('parallel, docked');
      await context.clickDisplayModeToggle();
      await context.settle();
      await context.measure('parallel, back inline');
    },
  },
  {
    id: 's5-open-and-state-results',
    title: 'An open result arriving in Parallel, and an open in Mono followed by a state result carrying mode parallel',
    deliverOnMount: true,
    initialDisplayMode: 'inline',
    async run(context) {
      await context.waitForStructure();
      await context.clickMode('parallel');
      await context.settle();
      await context.deliverResult(await context.openStructure());
      await context.settle();
      await context.measure('after an open result while in Parallel');
      await context.clickMode('off');
      await context.settle();
      await context.deliverResult(await context.openStructure());
      await context.settle();
      await context.measure('after an open result while in Mono');
      // The server's own view state now says mono, because the mode buttons
      // report through app-only sync_view. Put it back to parallel on the server without
      // telling the panel, then deliver the state result: the panel has to end
      // up in parallel, framed for a parallel eye window.
      await context.callTool('stereo_structure.set_mode', { mode: 'parallel' });
      await context.deliverResult(await context.callTool('stereo_structure.get_state'));
      await context.settle();
      await context.measure('after a state result carrying mode parallel', 'parallel');
    },
  },
  {
    id: 's6-fresh-mount-into-a-parallel-session',
    title: 'Fresh open-rendered mount while the session is already in Parallel: hydration must come up in Parallel, framed',
    deliverOnMount: true,
    initialDisplayMode: 'fullscreen',
    serverMode: 'parallel',
    async run(context) {
      // Only open carries UI metadata. Its result identifies the already-
      // parallel session; the panel must apply that cached mode before it
      // hydrates, because the load is what fits the camera.
      await context.waitForStructure();
      await context.settle();
      await context.measure('fallback load into a parallel session', 'parallel');
    },
  },
  {
    id: 's7-open-result-into-a-parallel-session',
    title: 'An open result arriving at a fresh panel while the session is already in Parallel',
    deliverOnMount: true,
    initialDisplayMode: 'fullscreen',
    serverMode: 'parallel',
    async run(context) {
      await context.waitForStructure();
      await context.settle();
      await context.measure('open result into a parallel session', 'parallel');
    },
  },
];

const SIDE_BY_SIDE = new Set(['parallel', 'cross']);
/** Every mode that runs Mol*'s StereoCamera, and so has a draw-pass eye viewport. */
const STEREO_MODES = new Set(['parallel', 'cross', 'anaglyph']);

/**
 * Read the panel state the measurement has to be interpreted against.
 *
 * Everything here is read out of the live document rather than assumed from
 * the profile, because the point of these scenarios is that the box moved.
 */
export async function readPanelState(frame: Frame): Promise<{
  mode: string;
  cameraStatus: string;
  canvas: { x: number; y: number; width: number; height: number };
  stage: { width: number; height: number };
  hasCanvas: boolean;
}> {
  return frame.evaluate(() => {
    const pressed = Array.from(document.querySelectorAll<HTMLElement>('[data-mode]'))
      .find((button) => button.getAttribute('aria-pressed') === 'true');
    const canvas = document.querySelector<HTMLCanvasElement>('#molstar-stage canvas');
    const stage = document.querySelector<HTMLElement>('#molstar-stage');
    const canvasBox = canvas?.getBoundingClientRect();
    const stageBox = stage?.getBoundingClientRect();
    const status = document.querySelector<HTMLElement>('#camera-status');
    return {
      mode: pressed?.dataset.mode ?? 'unknown',
      cameraStatus: (status?.textContent ?? '').trim(),
      canvas: {
        x: canvasBox?.x ?? 0,
        y: canvasBox?.y ?? 0,
        width: canvasBox?.width ?? 0,
        height: canvasBox?.height ?? 0,
      },
      stage: { width: stageBox?.width ?? 0, height: stageBox?.height ?? 0 },
      hasCanvas: canvas != null,
    };
  });
}

/**
 * Put the stage into a state a bounding box can be read off.
 *
 * Three things are turned off, and none of them is part of the fit:
 *
 * - The caption overlay is a DOM element on top of the canvas, so a page
 *   screenshot of the canvas box would include its lit pixels.
 * - Mol*'s camera-axes gizmo draws inside each eye viewport at a fixed place
 *   near the bottom edge, at zero disparity. It is lit, it is not the
 *   structure, and it sits far outside the structure's box. A load turns it
 *   back on (`loadStructureNow` sets `cameraAxes ?? true`), so this runs
 *   before every measurement rather than once per mount.
 * - Motion rocks the camera by ±4°, which is a moving silhouette. A measurement put
 *   its contribution to the pair separation at 0.11 CSS px, so it is not what
 *   is under test here, and a still frame is what makes the measurement
 *   repeatable.
 */
export async function quiesceStage(frame: Frame, options: { stopMotion?: boolean } = {}): Promise<void> {
  await frame.evaluate((stopMotion) => {
    const overlay = document.querySelector<HTMLElement>('#overlay-readout');
    if (overlay != null) overlay.style.visibility = 'hidden';
    const empty = document.querySelector<HTMLElement>('#empty-state');
    if (empty != null) empty.style.visibility = 'hidden';
    // The load toast floats over the stage, and its text is how the harness
    // knows a structure arrived, so it is hidden rather than dismissed.
    const notice = document.querySelector<HTMLElement>('#notice');
    if (notice != null) notice.style.visibility = 'hidden';
    const axes = document.querySelector<HTMLInputElement>('#camera-axes');
    if (axes != null && axes.checked) {
      axes.checked = false;
      axes.dispatchEvent(new Event('change', { bubbles: true }));
    }
    // The letterbox rounds its corners by 8 px and clips the canvas to that
    // radius, so a screenshot of the canvas box picks up the page behind it at
    // the four corners: four bright pixels that bound every box. The radius is
    // cosmetic and has nothing to do with the fit, so it comes off for the
    // measurement, exactly as the pixel-acceptance run already does it
    // (plugin/src/viewer.ts:1248).
    const letterbox = document.querySelector<HTMLElement>('#letterbox');
    if (letterbox != null) letterbox.style.borderRadius = '0';
    const motion = document.querySelector<HTMLSelectElement>('#motion');
    if (stopMotion && motion != null && motion.value !== 'none') {
      motion.value = 'none';
      motion.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, options.stopMotion !== false);
}

export function judgeFrame(input: {
  png: ReturnType<typeof decodePng>;
  scale: number;
  mode: string;
  /** The drawer's camera readout, which carries the predicted disparity. */
  cameraStatus?: string;
}): EyeFitVerdict {
  return SIDE_BY_SIDE.has(input.mode)
    ? judgeEyeFit({
        png: input.png,
        scale: input.scale,
        disparityRangeCssPx: disparityRangeCssPx(input.cameraStatus ?? ''),
      })
    : judgeMonoFit({ png: input.png, scale: input.scale });
}

/**
 * Pull the fields worth keeping out of a `get_state` result.
 *
 * Returns undefined when no panel has reported, which the fill check treats as
 * a failure rather than as an absence: the point of this harness is that the
 * channel out of a live webview works.
 */
export function readDiagnostics(result: unknown): FitDiagnosticsReading | undefined {
  if (typeof result !== 'object' || result == null || !('structuredContent' in result)) return undefined;
  const content = (result as { structuredContent?: unknown }).structuredContent;
  if (typeof content !== 'object' || content == null) return undefined;
  const raw = (content as { diagnostics?: unknown }).diagnostics;
  if (typeof raw !== 'object' || raw == null) return undefined;
  // Read loosely on purpose. The server has already validated the object
  // against a strict schema, and a harness that re-declared every field would
  // be a third copy of the same shape to keep in step.
  type Loose = Record<string, any>;
  const diagnostics = raw as Loose;
  const geometry = (diagnostics.geometry ?? {}) as Loose;
  const camera = (diagnostics.camera ?? {}) as Loose;
  const fit = (diagnostics.fit ?? {}) as Loose;
  const state = (diagnostics.state ?? {}) as Loose;
  const user = (diagnostics.user ?? {}) as Loose;
  const eyes = geometry.stereoEyeViewports as Loose | undefined;
  return {
    at: String(diagnostics.at),
    sequence: Number(diagnostics.sequence),
    viewerBuild: String(diagnostics.viewerBuild),
    trigger: String(diagnostics.trigger),
    ...(typeof diagnostics.panelId === 'string' ? { panelId: diagnostics.panelId } : {}),
    ...(typeof camera.fill === 'number' ? { fill: camera.fill } : {}),
    ...(camera.fillFromDrawPass === undefined ? {} : { fillFromDrawPass: camera.fillFromDrawPass }),
    ...(typeof camera.projectedSphereDiameterPx === 'number' ? { projectedSphereDiameterPx: camera.projectedSphereDiameterPx } : {}),
    eyeViewportCssPx: geometry.eyeViewportCssPx ?? { width: 0, height: 0 },
    eyeCapApplied: geometry.eyeCapApplied === true,
    halfCapPx: geometry.halfCapPx ?? null,
    ...(fit.fittedGeometry == null ? {} : { fittedGeometry: fit.fittedGeometry }),
    ...(fit.lastDecision == null ? {} : { lastDecision: String(fit.lastDecision.decision) }),
    stageRectCssPx: geometry.stageRectCssPx ?? { x: 0, y: 0, width: 0, height: 0 },
    canvasCssPx: geometry.canvasCssPx ?? { width: 0, height: 0 },
    canvasBackingPx: geometry.canvasBackingPx ?? { width: 0, height: 0 },
    ...(eyes == null ? {} : { stereoEyeViewports: { left: { width: eyes.left?.width ?? 0 }, right: { width: eyes.right?.width ?? 0 }, ageMs: eyes.ageMs ?? 0 } }),
    distanceToTargetAng: Number(camera.distanceToTargetAng ?? 0),
    visibleSphereRadiusAng: Number(camera.visibleSphereRadiusAng ?? 0),
    inTransition: camera.inTransition === true,
    loadInFlight: fit.loadInFlight === true,
    motionRunning: state.motionRunning === true,
    ...(typeof state.motionBaselineDistanceAng === 'number' ? { motionBaselineDistanceAng: state.motionBaselineDistanceAng } : {}),
    wheelEventsSinceFit: Number(user.wheelEventsSinceFit ?? 0),
    structureSource: String(state.structureSource ?? 'none'),
    fitEventTriggers: Array.isArray(fit.events) ? fit.events.map((event: { trigger?: unknown }) => String(event.trigger)) : [],
    ...(Array.isArray(fit.events) && fit.events.length > 0
      ? { lastFitEvent: lastFitEvent(fit.events[fit.events.length - 1] as Loose) }
      : {}),
    ...(state.fallback == null ? {} : { fallback: state.fallback as FitDiagnosticsReading['fallback'] }),
  };
}

function lastFitEvent(event: Record<string, any>): { at: string; trigger: string; distance: number; fill?: number } {
  return {
    at: String(event.at),
    trigger: String(event.trigger),
    distance: Number(event.distance ?? 0),
    ...(typeof event.fill === 'number' ? { fill: event.fill } : {}),
  };
}

/**
 * Where a step's reports have to be newer than.
 *
 * Taken from the panel itself through `__stereoStructureProbe.identity()`
 * rather than from the server, because the server holds a report from every
 * panel this run has mounted and the question is always about the one panel
 * the harness put on screen.
 */
export type ReportMark = {
  /** Wall clock at the moment the mark was taken. Not used to prove freshness. */
  at: string;
  /** The panel's own report counter at that moment. */
  sequence: number;
  /** The panel the mark addresses. Absent only when none could be identified. */
  panelId?: string;
  /** Length of that panel's fit ring at that moment. */
  fitEventCount?: number;
  /** Its newest fit event's timestamp, absent when it had never fitted. */
  lastFitAt?: string;
};

/** What `__stereoStructureProbe.identity()` returns, or null when the probe is missing. */
export type PanelIdentity = {
  panelId: string;
  sequence: number;
  fitEventCount: number;
  lastFitAt?: string;
};

/**
 * The probe named no panel. `panelMark` throws this; the scenario runner
 * records it as a FIT DEFECT `identity-unavailable`.
 */
export class IdentityUnavailableError extends Error {
  readonly reason = 'identity-unavailable' as const;
  constructor(detail = '__stereoStructureProbe.identity() returned null') {
    super(`identity-unavailable: ${detail}`);
    this.name = 'IdentityUnavailableError';
  }
}

/**
 * Turn the probe's identity into a mark, or throw if the probe named no panel.
 *
 * A mark with no `panelId` used to fall through to a wall-clock comparison,
 * which any other panel's heartbeat satisfied. Refusing here means that path
 * no longer exists.
 */
export function markFromIdentity(identity: PanelIdentity | null, at: string): ReportMark {
  if (identity == null) throw new IdentityUnavailableError();
  return {
    at,
    sequence: identity.sequence,
    panelId: identity.panelId,
    fitEventCount: identity.fitEventCount,
    ...(identity.lastFitAt == null ? {} : { lastFitAt: identity.lastFitAt }),
  };
}

export type IdentifiedReportMark = ReportMark & { panelId: string };

/**
 * Whether `settle` may proceed, and with which mark.
 *
 * A delivery with no mark is `mark-missing`: the photograph would describe a
 * camera nobody can prove is the delivery's. A non-delivery (mode change,
 * resize) may take a fresh mark, but only one that names a panel. A pending
 * mark that itself has no `panelId` is `identity-unavailable`.
 */
export type SettleMarkDecision =
  | { kind: 'use'; mark: IdentifiedReportMark; awaitingLoad: boolean }
  | { kind: 'fresh' }
  | { kind: 'mark-missing' }
  | { kind: 'identity-unavailable' };

export function resolveSettleMark(input: {
  pendingMark: ReportMark | undefined;
  deliveredStructure: boolean;
}): SettleMarkDecision {
  const mark = input.pendingMark;
  if (mark == null) {
    return input.deliveredStructure ? { kind: 'mark-missing' } : { kind: 'fresh' };
  }
  if (mark.panelId == null) return { kind: 'identity-unavailable' };
  return { kind: 'use', mark: { ...mark, panelId: mark.panelId }, awaitingLoad: input.deliveredStructure };
}

/**
 * Whether one reading is newer than the mark a step took before it acted.
 *
 * The mark names a panel, and a reading from any other panel is not an answer
 * to the question — it is a different viewer's heartbeat. The server can
 * legitimately hand one back: a run mounts a fresh page per scenario and every
 * earlier panel's last report stays on the server. A mismatch, or a missing
 * `panelId` on either side, is not freshness: it is a different viewer, or no
 * viewer, and the deadline is what says the marked panel never answered.
 */
export function isFresherReport(
  reading: Pick<FitDiagnosticsReading, 'at' | 'sequence' | 'panelId'>,
  mark: Pick<ReportMark, 'at' | 'sequence' | 'panelId'>,
): boolean {
  if (mark.panelId == null || reading.panelId == null) return false;
  if (reading.panelId !== mark.panelId) return false;
  return reading.sequence > mark.sequence;
}

/**
 * Whether a reading shows that the load a step started has been observed.
 *
 * Either the load is still running, or it has already left a fit event the
 * mark did not have. Both readings are proof that the panel acted on the
 * delivery; neither can be produced by a heartbeat.
 *
 * This closes the settle's remaining race. `settle` flushes a report through
 * the probe on every poll, and under machine load that flush can be assembled
 * before `loadStructure` sets `loadInFlight`. The result is a report with a
 * newer sequence, no load in flight and no transition — which satisfied every
 * settle condition while describing the camera as it was before the delivery,
 * so the photograph that followed caught Mol*'s own post-load reset.
 */
export function observedLoadSince(
  reading: Pick<FitDiagnosticsReading, 'loadInFlight' | 'fitEventTriggers' | 'lastFitEvent'>,
  mark: Pick<ReportMark, 'fitEventCount' | 'lastFitAt'>,
): boolean {
  if (reading.loadInFlight) return true;
  // The ring is capped, so a full ring stops growing and only the timestamp
  // separates a new event from the one the mark saw.
  if (reading.fitEventTriggers.length > (mark.fitEventCount ?? 0)) return true;
  const readingAt = reading.lastFitEvent?.at;
  if (readingAt == null) return false;
  return readingAt > (mark.lastFitAt ?? '');
}

/**
 * Whether two readings, taken either side of a screenshot, describe the frame
 * that was photographed.
 *
 * A report timestamped after a mark taken before the photograph proves
 * nothing: a heartbeat between the mark and the shutter passes, and so does a
 * fit between the shutter and the report. Bracketing does prove it, provided
 * the bracket is closed — nothing fitted, nothing moved and nothing was
 * interpolating between the two readings — which is what this checks.
 *
 * The distance tolerance is 1e-6 Å: the camera writes a float and the report
 * carries it through JSON, so exact equality is the right test up to that.
 */
export function pairedReportFailures(
  before: FitDiagnosticsReading | undefined,
  after: FitDiagnosticsReading | undefined,
): string[] {
  if (before == null || after == null) return ['the panel did not report on both sides of the screenshot'];
  const failures: string[] = [];
  if (before.fitEventTriggers.length !== after.fitEventTriggers.length) {
    failures.push(`a fit ran across the screenshot: ${before.fitEventTriggers.length} fit events before, ${after.fitEventTriggers.length} after`);
  }
  const beforeLast = JSON.stringify(before.lastFitEvent ?? null);
  const afterLast = JSON.stringify(after.lastFitEvent ?? null);
  if (beforeLast !== afterLast) failures.push(`the newest fit event changed across the screenshot: ${beforeLast} then ${afterLast}`);
  if (before.inTransition) failures.push('the camera was interpolating when the report before the screenshot was taken');
  if (after.inTransition) failures.push('the camera was interpolating when the report after the screenshot was taken');
  const delta = Math.abs(before.distanceToTargetAng - after.distanceToTargetAng);
  if (!(delta <= 1e-6)) {
    failures.push(`the camera moved across the screenshot: distance ${before.distanceToTargetAng.toFixed(6)} then ${after.distanceToTargetAng.toFixed(6)} Å`);
  }
  return failures;
}

/**
 * The fill to compare against the pixels, and its name.
 *
 * In any stereo mode that is the draw pass's own number: the viewer's CSS eye
 * estimate and the viewport Mol* actually renders each eye into can disagree,
 * and when they do only `fillFromDrawPass` moves. That is the whole reason the
 * second number exists, so it is checked wherever it is available.
 *
 * Anaglyph is included. It is a stereo mode, so
 * `StereoCamera.update` runs and publishes the side-by-side halves, but the
 * anaglyph DrawPass fork renders each eye into the *whole* pass and restores
 * the half-width viewport afterwards. Before the fork published its own viewport, the
 * published split was the one rectangle anaglyph never draws into, and checking it would
 * have failed every anaglyph frame at about twice the truth. The fork now
 * publishes what it rendered into, so `fill` and `fillFromDrawPass` describe
 * the same rectangle there and a real divergence is caught in anaglyph too.
 *
 * Mono has no stereo pass at all, so `fillFromDrawPass` goes null within a
 * second (`DRAW_PASS_FRESH_MS`) and the layout box is the only eye window
 * there is.
 */
export function fillForCheck(
  mode: string,
  reading: FitDiagnosticsReading | undefined,
): { fill: number | undefined; source: string } {
  if (!STEREO_MODES.has(mode)) return { fill: reading?.fill, source: 'fill' };
  const drawPass = reading?.fillFromDrawPass;
  return { fill: drawPass == null ? undefined : drawPass, source: 'fillFromDrawPass' };
}

/** The measured counterpart of the reported fill, for one measurement. */
export function measuredSilhouetteRatio(measurement: Pick<FitMeasurement, 'left' | 'right' | 'eyeWindowCssPx'>): number | null {
  return silhouetteRatio(measurement.left, measurement.right, measurement.eyeWindowCssPx);
}

export function eyeWindowFor(mode: string, canvas: PanelBox): PanelBox {
  return SIDE_BY_SIDE.has(mode)
    ? { width: canvas.width / 2, height: canvas.height }
    : { width: canvas.width, height: canvas.height };
}

/** One line per Fit-button press. */
export function fitButtonLine(check: FitButtonCheck): string {
  const before = check.fillBefore == null ? 'none' : check.fillBefore.toFixed(4);
  const after = check.fillAfter == null ? 'none' : check.fillAfter.toFixed(4);
  return `${check.pass ? 'PASS' : 'FAIL'} ${check.scenario} / ${check.step}`
    + ` visible ${check.visible ? 'yes' : 'no'} fill ${before} -> ${after}`
    + ` last fit event ${check.lastTrigger ?? 'none'}`
    + (check.failures.length === 0 ? '' : ` | ${check.failures.join('; ')}`);
}

/** One line per measurement, for the run log and for the report table. */
export function measurementLine(measurement: FitMeasurement): string {
  const eye = measurement.eyeWindowCssPx;
  const left = measurement.left;
  const right = measurement.right;
  const box = (report: EyeBoxReport): string => report.box == null
    ? 'no lit pixel'
    : `${report.widthCssPx.toFixed(1)}x${report.heightCssPx.toFixed(1)} margins L${report.marginLeftCssPx.toFixed(1)} R${report.marginRightCssPx.toFixed(1)} T${report.marginTopCssPx.toFixed(1)} B${report.marginBottomCssPx.toFixed(1)}`;
  const reported = measurement.diagnostics;
  // The panel's own number sits beside the pixels it produced, because the
  // whole point of this harness is that the two can be compared in a host where
  // only one of them is available.
  const checked = fillForCheck(measurement.mode, reported);
  const fill = checked.fill == null
    ? `${checked.source} none`
    : `${checked.source} ${checked.fill.toFixed(4)}`;
  const measured = measurement.silhouetteRatioMeasured == null
    ? 'silhouette none'
    : `silhouette ${measurement.silhouetteRatioMeasured.toFixed(4)}`;
  const build = reported == null ? 'no report' : `build ${reported.viewerBuild.slice(0, 8)} seq ${reported.sequence}`;
  return `${measurement.pass ? 'PASS' : 'FAIL'} ${measurement.scenario} / ${measurement.step}`
    + ` [${measurement.mode}] panel ${measurement.panelCssPx.width}x${measurement.panelCssPx.height}`
    + ` eye ${eye.width.toFixed(0)}x${eye.height.toFixed(0)}`
    + ` | ${fill} · ${measured} · ${build}`
    + ` | left ${box(left)} | right ${box(right)}`;
}
