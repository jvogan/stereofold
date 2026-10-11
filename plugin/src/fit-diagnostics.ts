/**
 * The numbers a live panel sends back, and the arithmetic that makes them
 * answerable.
 *
 * Two fits were shipped against photographs of a real Codex
 * side panel. The first corrected a genuine Mol* defect. The second
 * corrected a genuine ordering defect and made every fit scenario in the
 * host-emulation harness pass, 120 measurements. The same bytes then clipped
 * *worse* in the real panel than before. Nobody can attach a debugger to a
 * Codex webview, and a screenshot misleads: it shows
 * a ratio, and a ratio is consistent with several different wrong numbers.
 *
 * So this module exists to make the next live check return numbers instead of
 * a picture. The panel assembles the object below from the live objects at
 * send time, ships it through an app-only tool, and
 * `stereo_structure.get_state` hands it back to the conversation verbatim.
 *
 * Everything here is pure and reads nothing itself: the DOM, Mol* and the
 * viewer's module state all arrive through {@link DiagnosticsSources}. That is
 * what makes "did the fill come out at 0.86" a unit test rather than a browser
 * run, and it is also what keeps a diagnostic from being able to lie: an
 * assembler that cannot cache cannot report a stale number.
 *
 * The one derived quantity is `fill`, and it is the whole point of the object.
 * `fitDistanceForEyeViewport` solves for the distance at which the visible
 * bounding sphere subtends `STAGE_FILL_FRACTION` of the eye viewport's shorter
 * side (`./eye-window.ts`), so a camera that is framed correctly *for the
 * viewport it renders into* reports `fill = 0.86` exactly, whatever the panel
 * geometry, structure or pose. A fill of 3 says the camera is 3.5x too close
 * for the window it is drawing in, and the rest of the object says which
 * measurement it was framed against instead.
 */

import type { FallbackRetryState } from './fallback-retry.js';
import type { FitGeometry, RefitDecision } from './fit-decision.js';

/* ------------------------------------------------------------- geometry */

/** A rectangle, in whatever units the field that carries it declares. */
export interface DiagnosticRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A size, in whatever units the field that carries it declares. */
export interface DiagnosticSize {
  width: number;
  height: number;
}

/* ----------------------------------------------------------------- host */

/**
 * What the host says this panel is, and what the frame says it got.
 *
 * The two disagreeing is hypothesis 1: `eyeViewportPx()` measures the stage's
 * layout box, and if Codex's side panel gives the iframe a box the stage does
 * not fill — a scrollbar, a transform, a container the CSS does not reach —
 * then every fit is solved for a rectangle the render never uses.
 */
export interface HostDiagnostics {
  /** `inline`, `fullscreen` or `pip`, as this panel currently believes. */
  displayMode: string;
  /** `containerDimensions` from the last host context, exactly as sent. */
  containerDimensions?: {
    width?: number;
    height?: number;
    maxWidth?: number;
    maxHeight?: number;
  };
  /** `width ?? maxWidth` from that payload, CSS px. */
  hostViewportWidthPx?: number;
  /** `height ?? maxHeight` from that payload, CSS px. */
  hostViewportHeightPx?: number;
  /** ISO time the last `hostcontextchanged` arrived. */
  hostContextAt?: string;
  /** How many have arrived since this panel mounted. */
  hostContextCount: number;
  innerWidthPx: number;
  innerHeightPx: number;
  devicePixelRatio: number;
  /** `visualViewport.scale`, omitted where the API is absent. */
  visualViewportScale?: number;
  visibilityState: string;
}

/* ------------------------------------------------------------- geometry */

/**
 * Every rectangle the fit and the render each believe in, side by side.
 *
 * `eyeViewportCssPx` is what `fitCameraToStage` solved against.
 * `canvasBackingPx` and `stereoEyeViewports` are what the GPU was actually
 * given. They are reported separately, in their own units, because
 * hypothesis 2 is precisely that they stop agreeing at devicePixelRatio 2.
 */
export interface GeometryDiagnostics {
  /** `#molstar-stage`'s `getBoundingClientRect()`, CSS px. */
  stageRectCssPx: DiagnosticRect;
  /** `#letterbox`'s `getBoundingClientRect()`, CSS px. */
  letterboxRectCssPx: DiagnosticRect;
  /** What `eyeViewportPx()` returns right now, CSS px. */
  eyeViewportCssPx: DiagnosticSize;
  /** True when the 63 mm interocular cap, not the letterbox, bounds the pair. */
  eyeCapApplied: boolean;
  /** The cap in force, CSS px of one eye, or null in a mono mode. */
  halfCapPx: number | null;
  /** The Mol* canvas element's CSS box. */
  canvasCssPx: DiagnosticSize;
  /** Its `width` / `height` attributes: the drawing buffer, device px. */
  canvasBackingPx: DiagnosticSize;
  /** `canvas3d.camera.viewport`, as Mol* holds it. Device px. */
  cameraViewport: DiagnosticRect;
  /**
   * The eye viewports Mol*'s patched `StereoCamera.update` last produced, in
   * the device pixels the draw pass uses them in.
   *
   * Recorded by `./molstar-stereo-patch.ts` at the end of the update that
   * computes them, so this is the split the next draw will use rather than a
   * reconstruction of it. Absent until a stereo mode has drawn at least once;
   * `ageMs` says how long ago, because a mono panel keeps the last stereo
   * frame's values.
   */
  stereoEyeViewports?: {
    left: DiagnosticRect;
    right: DiagnosticRect;
    parent: DiagnosticRect;
    ageMs: number;
  };
}

/* --------------------------------------------------------------- camera */

/** The camera numbers, read raw. `fill` is derived from these, not reported by them. */
export interface CameraReading {
  /** |position - target|, Å. */
  distanceToTargetAng: number;
  /** `camera.state.radius`, Å. */
  radiusAng: number;
  /** Vertical field of view, radians. */
  fovRad: number;
  /** `visibleSphere(canvas).radius`, the radius the fit solves for. Å. */
  visibleSphereRadiusAng: number;
  /** `canvas3d.boundingSphereVisible.radius` unconditionally. Å. */
  boundingSphereVisibleRadiusAng: number;
  inTransition: boolean;
}

export interface CameraDiagnostics extends CameraReading {
  /**
   * Diameter the visible bounding sphere projects to inside one eye window,
   * CSS px. Omitted when the camera is inside the sphere, where there is no
   * silhouette to measure.
   */
  projectedSphereDiameterPx?: number;
  /**
   * `projectedSphereDiameterPx / min(eyeWidth, eyeHeight)`.
   *
   * The single number that says whether the fit is right. A correctly framed
   * camera reports `STAGE_FILL_FRACTION`, 0.86, in every host and at every
   * pose. Anything above roughly 0.9 is clipping.
   */
  fill?: number;
  /**
   * The same projection measured against the eye viewport the *draw pass*
   * actually used, CSS px, or null when no stereo frame has been drawn in the
   * last {@link DRAW_PASS_FRESH_MS}.
   *
   * `fill` divides by `geometry.eyeViewportCssPx`, the viewer's own layout
   * measurement, which is also the number the fit was solved against. If that
   * measurement is right the two agree. If it is wrong only this one moves,
   * and this worked case is exactly that: a panel reporting a
   * 240 CSS px eye while Mol* splits a 160 device px canvas at
   * devicePixelRatio 2 reports `fill` 0.86 while rendering at 2.58, three
   * times oversized. One number could never have decided it.
   *
   * `geometry.stereoEyeViewports` is in drawing-buffer pixels, so it is
   * divided by `host.devicePixelRatio` to reach the CSS px `fill` uses.
   */
  fillFromDrawPass?: number | null;
}

/**
 * How recently the stereo draw pass must have run for its eye viewport to
 * describe the frame on screen, ms.
 *
 * A mono panel keeps the last stereo frame's split indefinitely, and Mol*
 * stops drawing a scene nothing is changing, so an unbounded read of
 * `stereoEyeViewports` would silently mix a live layout with an old render.
 */
export const DRAW_PASS_FRESH_MS = 1_000;

/* ------------------------------------------------------------------ fit */

/** Why a fit ran. */
export type FitTrigger =
  /** A structure load's own fit. */
  | 'load'
  /** A mode change halved or doubled the eye window. */
  | 'mode'
  /** `maybeRefitCamera` found the camera framed for another geometry. */
  | 'refit'
  /** A host context change moved the panel. */
  | 'hostcontext'
  /** A dock or undock through `requestDisplayMode`. */
  | 'displaymode'
  /** The toolbar's Fit button, or `stereo_structure.control` action `fit`. */
  | 'button'
  /** The fresh-panel `get_structure` fallback's load. */
  | 'fallback'
  /** The drawer's Refit view button, which resets the pose as well. */
  | 'reset';

/** One fit that actually moved the camera. */
export interface FitEvent {
  at: string;
  trigger: FitTrigger;
  /** The eye viewport the fit solved against, CSS px. */
  eyeWidthPx: number;
  eyeHeightPx: number;
  /** The visible bounding sphere radius it framed, Å. */
  radius: number;
  /** The distance it wrote, Å. */
  distance: number;
  /** The fill that distance produces in that eye window. 0.86 when correct. */
  fill?: number;
}

/** The last `decideRefit` call, inputs included, so a `keep` can be argued with. */
export interface RefitDecisionRecord {
  at: string;
  decision: RefitDecision;
  current: FitGeometry;
  fitted?: FitGeometry;
  suspended: boolean;
  pinned: boolean;
  inTransition: boolean;
}

export interface FitDiagnostics {
  /** What the last successful fit framed for. Absent when none has run. */
  fittedGeometry?: FitGeometry;
  fitSuspended: boolean;
  fixturePinned: boolean;
  loadInFlight: boolean;
  lastDecision?: RefitDecisionRecord;
  /** Newest last. At most {@link FIT_EVENT_RING_CAPACITY}. */
  events: FitEvent[];
}

/** How many fit events travel with each report. */
export const FIT_EVENT_RING_CAPACITY = 12;

/* ---------------------------------------------------------------- state */

/** How the structure on this stage got here. */
export type StructureSource =
  /** Nothing has been loaded. */
  | 'none'
  /** An open render result made this panel hydrate its app-only session cache. */
  | 'open'
  /** This panel retried `stereo_structure.get_structure` after hydration failed. */
  | 'fallback'
  /** The drawer's own PDB / paste / depth-test buttons. */
  | 'local';

export interface StateDiagnostics {
  mode: string;
  depthBudgetArcmin: number;
  swapEyes: boolean;
  variant: string;
  color: string;
  style: string;
  motionMode: string;
  /** True while the MotionController would write the camera on the next tick. */
  motionRunning: boolean;
  /** |baseline.position - baseline.target|, Å. Absent before the first capture. */
  motionBaselineDistanceAng?: number;
  structureLoaded: boolean;
  pdbId?: string;
  /** Tool results delivered to this panel since it mounted, by kind. */
  messageCounts: { open: number; state: number; mode: number };
  structureSource: StructureSource;
  /**
   * The fresh-panel `get_structure` fallback's retry state.
   *
   * `tries` above one means the server did not answer the first time, and
   * `done: false` with a `lastError` means a retry is still pending — which is
   * the difference between a panel that is empty and a panel that has not been
   * told yet. See `./fallback-retry.ts`.
   */
  fallback?: FallbackRetryState;
}

/* ----------------------------------------------------------------- user */

export interface UserDiagnostics {
  /**
   * Wheel and pinch events on the stage since the last successful fit.
   *
   * A person's own scroll-zoom is not a defect, and the refit rule
   * deliberately leaves their framing alone. Without this count a zoomed-in
   * panel and a mis-fitted one are the same screenshot.
   */
  wheelEventsSinceFit: number;
  /** The same count since the panel mounted. */
  wheelEventsTotal: number;
}

/* ------------------------------------------------------------ the object */

/** Why this report was sent. A superset of {@link FitTrigger}. */
export type ReportTrigger =
  | FitTrigger
  | 'mount'
  | 'loadstart'
  | 'loadend'
  | 'decision'
  | 'heartbeat';

/**
 * The report triggers in descending order of how much a reader needs the name.
 *
 * Two things can be pending when a report is finally sent: a burst of ordinary
 * `report` calls, and a `flush` deferred by the quarter-second flush floor. The
 * send carries one name, so the name has to be chosen rather than overwritten.
 * Before this, `flush` assigned unconditionally, so a probe refresh landing
 * inside the floor after a Fit press turned a `button` report into a
 * `heartbeat` one and the report-level answer to "did the press reach the app"
 * was lost. (The ring entry was never lost: `runFit` records it before
 * flushing.)
 *
 * The order set here is `button` > `decision` > `mode` > `heartbeat`. The
 * rest sit around it on the same principle — a name a person's action produced
 * outranks one the viewer produced for itself, and anything outranks the beat
 * that means "nothing happened". `mode` sits low deliberately: the mode is
 * already in `state.mode` of every report, while `decision` is the only place a
 * refit judgement is named.
 */
export const REPORT_TRIGGER_PRIORITY: readonly ReportTrigger[] = [
  'button',
  'reset',
  'mount',
  'loadstart',
  'fallback',
  'load',
  'loadend',
  'displaymode',
  'hostcontext',
  'refit',
  'decision',
  'mode',
  'heartbeat',
];

const TRIGGER_RANK = new Map<ReportTrigger, number>(
  REPORT_TRIGGER_PRIORITY.map((trigger, index) => [trigger, index]),
);

/** Rank of a trigger; an unknown one sorts below every known one. */
function triggerRank(trigger: ReportTrigger): number {
  return TRIGGER_RANK.get(trigger) ?? REPORT_TRIGGER_PRIORITY.length;
}

/**
 * The name a coalesced report should carry, given what is already pending.
 *
 * `undefined` means nothing is pending yet, so the incoming trigger wins by
 * default.
 */
export function higherPriorityTrigger(
  pending: ReportTrigger | undefined,
  incoming: ReportTrigger,
): ReportTrigger {
  if (pending === undefined) return incoming;
  return triggerRank(incoming) < triggerRank(pending) ? incoming : pending;
}

export interface Diagnostics {
  at: string;
  /**
   * The sha-256 of the shipped `viewer.html`, with the stamp itself replaced
   * by the placeholder it overwrote. See `./viewer-build.ts`.
   */
  viewerBuild: string;
  /**
   * Random, generated once per mounted viewer.
   *
   * `viewerBuild` says which bytes are running and `sequence` orders one
   * panel's own reports; neither tells two panels of the same build apart, and
   * a Codex conversation accumulates them. The server keeps reports per panel
   * on this key. Optional so an older viewer build still validates.
   */
  panelId?: string;
  /** Monotonic per panel, from 1. A gap means a send was dropped. */
  sequence: number;
  trigger: ReportTrigger;
  host: HostDiagnostics;
  geometry: GeometryDiagnostics;
  camera: CameraDiagnostics;
  fit: FitDiagnostics;
  state: StateDiagnostics;
  user: UserDiagnostics;
}

/* ------------------------------------------------------------ arithmetic */

/**
 * A number the wire can carry, or the fallback.
 *
 * JSON has no NaN and no Infinity: `JSON.stringify` turns both into `null`,
 * and the strict schema on the far side then rejects the whole report. One
 * field that could not be read must not cost the other sixty, so every reader
 * that touches a value Mol* or the DOM could leave undefined goes through
 * this.
 */
export function finiteOr(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Diameter, in eye-window pixels, of a sphere of `radius` seen from
 * `distance`.
 *
 * The vertical half-extent of the frustum at the target plane maps to half the
 * eye viewport's height, so a silhouette of angular radius
 * `alpha = asin(radius / distance)` has a projected radius of
 * `eyeHeightPx / 2 * tan(alpha) / tan(fov / 2)`.
 *
 * Substituting the distance `fitDistanceForEyeViewport` returns collapses this
 * to `fillFraction * min(eyeWidth, eyeHeight)` exactly, which is what makes
 * `fill` comparable against `STAGE_FILL_FRACTION` with no fudge factor.
 *
 * Returns undefined for a camera at or inside the sphere's surface, and for
 * any non-finite input, so a diagnostic never carries a NaN.
 */
export function projectedSphereDiameterPx(input: {
  radius: number;
  distanceToTargetAng: number;
  fovRad: number;
  eyeHeightPx: number;
}): number | undefined {
  const { radius, distanceToTargetAng: distance, fovRad, eyeHeightPx } = input;
  if (!(radius > 0) || !(distance > 0) || !(eyeHeightPx > 0)) return undefined;
  if (!(fovRad > 0) || !(fovRad < Math.PI)) return undefined;
  const sinAlpha = radius / distance;
  if (!(sinAlpha < 1)) return undefined;
  const diameter = eyeHeightPx * Math.tan(Math.asin(sinAlpha)) / Math.tan(fovRad / 2);
  return Number.isFinite(diameter) ? diameter : undefined;
}

/**
 * The fill fraction: how much of the eye window's shorter side the sphere
 * takes up.
 */
export function fillFraction(input: {
  projectedSphereDiameterPx: number | undefined;
  eyeWidthPx: number;
  eyeHeightPx: number;
}): number | undefined {
  const diameter = input.projectedSphereDiameterPx;
  if (diameter === undefined) return undefined;
  const shorter = Math.min(input.eyeWidthPx, input.eyeHeightPx);
  if (!(shorter > 0)) return undefined;
  const fill = diameter / shorter;
  return Number.isFinite(fill) ? fill : undefined;
}

/** Both steps at once, for a caller that holds a camera reading and an eye window. */
export function fillForReading(
  camera: Pick<CameraReading, 'visibleSphereRadiusAng' | 'distanceToTargetAng' | 'fovRad'>,
  eye: DiagnosticSize,
): { projectedSphereDiameterPx?: number; fill?: number } {
  const diameter = projectedSphereDiameterPx({
    radius: camera.visibleSphereRadiusAng,
    distanceToTargetAng: camera.distanceToTargetAng,
    fovRad: camera.fovRad,
    eyeHeightPx: eye.height,
  });
  const fill = fillFraction({
    projectedSphereDiameterPx: diameter,
    eyeWidthPx: eye.width,
    eyeHeightPx: eye.height,
  });
  return {
    ...(diameter === undefined ? {} : { projectedSphereDiameterPx: diameter }),
    ...(fill === undefined ? {} : { fill }),
  };
}

/**
 * Whether the 63 mm interocular cap, rather than the container, is what bounds
 * the pair.
 *
 * `sideBySideCanvasWidthPx` takes the smaller of twice the cap and the
 * letterbox, so the cap is in force exactly when it is the smaller of the two.
 * It matters to a reader of these numbers because a capped stage means the eye
 * window is 238 CSS px whatever the panel is, and an uncapped one means the
 * eye window tracks the panel width.
 */
export function eyeCapApplied(input: {
  sideBySide: boolean;
  halfCapPx: number | null;
  availableWidthPx: number;
}): boolean {
  if (!input.sideBySide || input.halfCapPx == null) return false;
  return Math.floor(input.halfCapPx) * 2 < Math.floor(Math.max(0, input.availableWidthPx));
}

/* ----------------------------------------------------------- event ring */

export interface FitEventRing {
  record(event: FitEvent): void;
  /** Oldest first, newest last. A fresh array each call. */
  entries(): FitEvent[];
}

/**
 * The last N fits, oldest first.
 *
 * A ring rather than a full log because this object is sent through a tool
 * result once a second: the twelve most recent fits are enough to show a
 * fit-then-refit oscillation or a fit that never ran, and an unbounded list
 * would grow without limit in a long-lived panel.
 */
export function createFitEventRing(capacity: number = FIT_EVENT_RING_CAPACITY): FitEventRing {
  const events: FitEvent[] = [];
  return {
    record(event: FitEvent): void {
      events.push(event);
      while (events.length > Math.max(0, capacity)) events.shift();
    },
    entries(): FitEvent[] {
      return events.map((event) => ({ ...event }));
    },
  };
}

/* -------------------------------------------------------------- assembly */

/**
 * The live objects, injected.
 *
 * Every one is a function, called once per assembly at send time. Nothing here
 * may hold a snapshot: the defect this whole object exists to find is a fit
 * computed against a rectangle that was already stale.
 */
export interface DiagnosticsSources {
  nowIso(): string;
  viewerBuild(): string;
  /** Constant for the life of one mounted viewer. */
  panelId(): string;
  nextSequence(): number;
  host(): HostDiagnostics;
  geometry(): GeometryDiagnostics;
  camera(): CameraReading;
  fit(): FitDiagnostics;
  state(): StateDiagnostics;
  user(): UserDiagnostics;
}

/**
 * The eye viewport the draw pass last used, in CSS px, or undefined when the
 * pass has not run recently enough for it to describe the frame on screen.
 *
 * Exported because the oversized-panel case turns on this arithmetic, and it
 * should be checkable without assembling a whole report.
 */
export function drawPassEyeCssPx(input: {
  stereoEyeViewports?: { left: DiagnosticRect; ageMs: number };
  devicePixelRatio: number;
  freshMs?: number;
}): DiagnosticSize | undefined {
  const eyes = input.stereoEyeViewports;
  const dpr = input.devicePixelRatio;
  if (eyes == null) return undefined;
  if (!(eyes.ageMs >= 0) || eyes.ageMs > (input.freshMs ?? DRAW_PASS_FRESH_MS)) return undefined;
  if (!(dpr > 0)) return undefined;
  const width = eyes.left.width / dpr;
  const height = eyes.left.height / dpr;
  if (!(width > 0) || !(height > 0)) return undefined;
  return { width, height };
}

/** Read every source once and derive `projectedSphereDiameterPx` and `fill`. */
export function assembleDiagnostics(sources: DiagnosticsSources, trigger: ReportTrigger): Diagnostics {
  const geometry = sources.geometry();
  const camera = sources.camera();
  const host = sources.host();
  const drawPassEye = drawPassEyeCssPx({
    ...(geometry.stereoEyeViewports == null ? {} : { stereoEyeViewports: geometry.stereoEyeViewports }),
    devicePixelRatio: host.devicePixelRatio,
  });
  // Null rather than absent: "the draw pass has not run" is a reading, and a
  // missing field would be indistinguishable from an old viewer that never
  // computed one.
  const fillFromDrawPass = drawPassEye === undefined
    ? null
    : fillForReading(camera, drawPassEye).fill ?? null;
  return {
    at: sources.nowIso(),
    viewerBuild: sources.viewerBuild(),
    panelId: sources.panelId(),
    sequence: sources.nextSequence(),
    trigger,
    host,
    geometry,
    camera: { ...camera, ...fillForReading(camera, geometry.eyeViewportCssPx), fillFromDrawPass },
    fit: sources.fit(),
    state: sources.state(),
    user: sources.user(),
  };
}

/* ------------------------------------------------------------ scheduling */

export interface DiagnosticsTimers {
  set(callback: () => void, delayMs: number): number;
  clear(handle: number): void;
}

export interface DiagnosticsScheduler {
  /** Ask for a report. The payload is read when the send actually happens. */
  report(trigger: ReportTrigger): void;
  /**
   * Send now, ignoring the debounce and the minimum gap.
   *
   * For a deliberate user action only — the toolbar's Fit button. The reading
   * that matters is the one the press produced, and a press is rare enough
   * that it cannot saturate the host channel.
   */
  flush(trigger: ReportTrigger): void;
  /** Begin the heartbeat. */
  start(): void;
  /** Stop everything, dropping any pending send. */
  stop(): void;
  readonly sentCount: number;
  readonly pending: boolean;
}

/**
 * The rate limiter in front of the tool call.
 *
 * Three behaviours, each for a separate reason:
 *
 * - **Debounce.** A load fires `loadstart`, several fits and `loadend` inside
 *   a few frames, and `maybeRefitCamera` can return a non-`keep` decision on
 *   every animation frame while a load holds the camera. One report after the
 *   burst is the useful one, and it is read after the burst rather than when
 *   it started.
 * - **A minimum gap.** No more than one tool call per second, whatever
 *   happens. A diagnostic that can saturate the host channel would be its own
 *   defect.
 * - **A heartbeat, at two rates.** A conversation calls `get_state` at a
 *   moment nobody chose. Without a periodic send, the answer would be the
 *   state at the last thing that moved, which could be minutes old and would
 *   look exactly like a fresh reading. But a fixed 1 Hz beat costs 60 app tool
 *   calls a minute *per mounted panel*, and Codex mounts one per tool card
 *   that carries UI metadata, so a long conversation pays that several times
 *   over for panels nobody is looking at. The beat is therefore fast only
 *   while something is actually happening — {@link activeMs} after the last
 *   change — and slow afterwards. A panel that is merely rocking makes no
 *   changes: the rock moves the camera without moving the eye viewport or the
 *   scene radius, so `decideRefit` returns `keep` and nothing reports.
 *
 * - **A floor under `flush`.** A flush keeps its immediacy, because a person
 *   pressed a button and is waiting for the answer, but two flushes inside
 *   {@link flushMinGapMs} collapse into one send at the end of that window.
 *   Without it, a held-down button or a repeated delivered `action: 'fit'` has
 *   no rate bound at all.
 *
 * `send` is called inside a try/catch and its result is never awaited, so this
 * cannot throw into the animation frame that reported and cannot delay a fit.
 */
export function createDiagnosticsScheduler(options: {
  send(trigger: ReportTrigger): void;
  now(): number;
  timers: DiagnosticsTimers;
  /** Quiet period that collapses a burst. */
  debounceMs: number;
  /** Floor on the gap between two sends. */
  minGapMs: number;
  /** Gap after which a panel that changed recently reports anyway. */
  heartbeatMs: number;
  /** Gap after which a panel that has not changed recently reports anyway. */
  idleHeartbeatMs?: number;
  /** How long after a change the fast heartbeat lasts. */
  activeMs?: number;
  /** Floor on the gap between two flushes. */
  flushMinGapMs?: number;
}): DiagnosticsScheduler {
  const idleHeartbeatMs = options.idleHeartbeatMs ?? options.heartbeatMs;
  const activeMs = options.activeMs ?? Number.POSITIVE_INFINITY;
  const flushMinGapMs = options.flushMinGapMs ?? 0;
  let handle: number | undefined;
  let pendingTrigger: ReportTrigger | undefined;
  let pendingSince = 0;
  let lastSentAt: number | undefined;
  let lastChangeAt: number | undefined;
  let lastFlushAt: number | undefined;
  /** When a coalesced flush is already armed to fire. */
  let flushDeadline: number | undefined;
  let sentCount = 0;
  let running = false;

  const clear = (): void => {
    if (handle === undefined) return;
    options.timers.clear(handle);
    handle = undefined;
  };

  const arm = (delayMs: number): void => {
    clear();
    handle = options.timers.set(fire, Math.max(0, delayMs));
  };

  function fire(): void {
    handle = undefined;
    const trigger = pendingTrigger ?? 'heartbeat';
    pendingTrigger = undefined;
    pendingSince = 0;
    const now = options.now();
    lastSentAt = now;
    if (flushDeadline !== undefined) {
      lastFlushAt = now;
      flushDeadline = undefined;
    }
    sentCount += 1;
    try {
      options.send(trigger);
    } catch {
      // A diagnostic that can break the panel it is diagnosing is worthless.
    }
    // The next beat is fast only while the panel is still inside the window
    // that follows a change.
    if (running) {
      const active = lastChangeAt !== undefined && now - lastChangeAt < activeMs;
      arm(active ? options.heartbeatMs : idleHeartbeatMs);
    }
  }

  return {
    report(trigger: ReportTrigger): void {
      const now = options.now();
      if (trigger !== 'heartbeat') lastChangeAt = now;
      // A flush is already armed within a quarter second; letting the ordinary
      // path re-arm the timer could only push it out.
      if (flushDeadline !== undefined) {
        pendingTrigger = higherPriorityTrigger(pendingTrigger, trigger);
        return;
      }
      // The name is the highest-priority trigger of the burst, not the last
      // one to arrive: a coalesced send answers for everything that happened
      // inside it, and the reader needs the one that mattered. `pendingSince`
      // still dates the burst from its first trigger, because that is what the
      // starvation deadline below is measured from.
      if (pendingTrigger === undefined) pendingSince = now;
      pendingTrigger = higherPriorityTrigger(pendingTrigger, trigger);
      // A plain debounce starves under a continuous stream, and this one gets
      // exactly that: `maybeRefitCamera` can return a non-`keep` decision on
      // every animation frame for the whole duration of a load. The pending
      // report therefore carries a deadline of its own, so a burst that never
      // stops still reports on the minimum gap.
      const earliest = lastSentAt === undefined ? now : lastSentAt + options.minGapMs;
      const deadline = pendingSince + options.minGapMs;
      const fireAt = Math.min(Math.max(now + options.debounceMs, earliest), Math.max(deadline, earliest));
      arm(fireAt - now);
    },
    flush(trigger: ReportTrigger): void {
      const now = options.now();
      if (trigger !== 'heartbeat') lastChangeAt = now;
      // Merged, never assigned: a flush deferred by the floor below has to
      // survive a later low-priority one folding into it. A `button` press
      // followed inside a quarter second by the harness probe's heartbeat
      // flush is the case that lost the press's name.
      pendingTrigger = higherPriorityTrigger(pendingTrigger, trigger);
      pendingSince = now;
      const earliest = lastFlushAt === undefined ? now : lastFlushAt + flushMinGapMs;
      if (now >= earliest) {
        lastFlushAt = now;
        flushDeadline = undefined;
        clear();
        fire();
        return;
      }
      // Inside the window: the first deferred flush arms the boundary and
      // every later one folds into it, so a burst of presses costs one send.
      if (flushDeadline !== undefined) return;
      flushDeadline = earliest;
      arm(earliest - now);
    },
    start(): void {
      if (running) return;
      running = true;
      // Mounting is the most interesting moment a panel has, so the first
      // window after `start` is an active one.
      lastChangeAt = options.now();
      arm(options.heartbeatMs);
    },
    stop(): void {
      running = false;
      pendingTrigger = undefined;
      flushDeadline = undefined;
      clear();
    },
    get sentCount(): number {
      return sentCount;
    },
    get pending(): boolean {
      return handle !== undefined;
    },
  };
}
