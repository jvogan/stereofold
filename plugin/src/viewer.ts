import { App, PostMessageTransport } from '@modelcontextprotocol/ext-apps';
import { PluginContext } from 'molstar/lib/mol-plugin/context.js';
import { DefaultPluginSpec } from 'molstar/lib/mol-plugin/spec.js';
import type { Canvas3D } from 'molstar/lib/mol-canvas3d/canvas3d.js';
import { Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { type GlassesKind, type Variant } from '@stereo/anaglyph';
import type { StereoMode, StereoParams, StereoSettings } from '@stereo/geometry';
import { parallelHalfWidthCapPx } from '@stereo/geometry';
import { AnaglyphLuminanceColorThemeProvider, setAnaglyphThemeGlasses } from './anaglyph-theme.js';
import {
  DEPTH_FIXTURE_CAMERA_Z,
  DEPTH_FIXTURE_ID,
  DEPTH_FIXTURE_OBSERVER_SIZE_FACTOR,
  DEPTH_FIXTURE_PDB,
  DEPTH_FIXTURE_SIZE_FACTOR,
} from './depth-fixture.js';
import {
  MouseParallaxSource,
  MotionController,
  type MotionSettings,
} from './motion-controller.js';
import { PLDDTConfidenceColorThemeProvider } from 'molstar/lib/extensions/model-archive/quality-assessment/color/plddt.js';
import { eyeViewportFromStage, fitDistanceForEyeViewport, sideBySideCanvasWidthPx } from './eye-window.js';
import { decideRefit, type FitGeometry } from './fit-decision.js';
import {
  FIT_EVENT_RING_CAPACITY,
  assembleDiagnostics,
  createDiagnosticsScheduler,
  createFitEventRing,
  eyeCapApplied,
  fillForReading,
  finiteOr,
  type CameraReading,
  type DiagnosticRect,
  type DiagnosticsSources,
  type FitDiagnostics,
  type FitTrigger,
  type GeometryDiagnostics,
  type HostDiagnostics,
  type RefitDecisionRecord,
  type ReportTrigger,
  type StateDiagnostics,
  type StructureSource,
  type UserDiagnostics,
} from './fit-diagnostics.js';
import { VIEWER_BUILD_PLACEHOLDER } from './viewer-build.js';
import { isEmptyStereoState, pickStereoState } from './stereo-state.js';
import {
  DEFAULT_LOOK_COLOR,
  DEFAULT_LOOK_STYLE,
  LOOK_COLOR_OPTIONS,
  LOOK_STYLE_OPTIONS,
  colorThemeForRepresentation,
  lookColorLabel,
  lookColorOrDefault,
  lookStyleLabel,
  lookStyleOrDefault,
  resolveColorTheme,
  type LookColor,
  type LookStyle,
} from './look.js';
import { desiredPanelHeight, panelFixedHeight } from './panel-size.js';
import { StereoController } from './stereo-controller.js';
import { createDebouncedSender } from './view-sync.js';
import { type CachedStructure, decideStructureFallback } from './structure-fallback.js';
import {
  FALLBACK_UNAVAILABLE_MESSAGE,
  classifyFallbackAttempt,
  createFallbackRetry,
  type FallbackAttemptInput,
  type FallbackRetryState,
} from './fallback-retry.js';
import { cssPxToMillimetres, measureCssDensity, snapshotFromMolstar } from './viewer-adapter.js';
import { createGuardedSerialQueue, type WorkCurrentGuard } from './guarded-queue.js';
import { createFitSuspensionRegistry } from './fit-suspension.js';
import {
  createSessionGenerationGuard,
  decideToolResultSession,
  hydrationLoadCompletion,
  isRenderToken,
  isServerEpoch,
  isStateRevision,
  sessionRequestIsCurrent,
  type SessionGeneration,
} from './session-generation.js';
import { sessionToolArguments } from './session-tool.js';
import { privateStructurePayload, structuredToolContent, thrownErrorMessage, toolResultError } from './tool-result.js';
import './viewer.css';

declare global {
  // Set by our isolated esbuild transform of Mol* StereoCamera. It swaps only
  // the two eye viewports; the same transform also corrects Mol*'s stock
  // translation/skew convergence defect.
  var __stereoStructureViewportXSwap: boolean | undefined;
  /** Build-local Mol* DrawPass fork reads this before its stereo branch. */
  var __stereoStructureAnaglyph: {
    enabled: boolean;
    swapEyes: boolean;
    glasses: GlassesKind;
    variant: Variant;
  } | undefined;
  var __stereoStructureAcceptanceMode: boolean | undefined;
  /**
   * The eye viewports Mol*'s patched `StereoCamera.update` last produced, in
   * Mol*'s own viewport units (drawing-buffer pixels). Written by the build's
   * transform of `mol-canvas3d/camera/stereo.js`, read only by the fit
   * diagnostics. See `./molstar-stereo-patch.ts`.
   */
  var __stereoStructureEyeViewports: {
    left: { x: number; y: number; width: number; height: number };
    right: { x: number; y: number; width: number; height: number };
    parent: { x: number; y: number; width: number; height: number };
    at: number;
  } | undefined;
  interface Window {
    /**
     * Pull the diagnostics channel from outside the frame.
     *
     * The host-emulation harness photographs a frame and then asks the server
     * what that frame was; on the idle heartbeat the answer could be ten
     * seconds old, and waiting for the beat would add minutes to a run. This
     * draws the same frame again so the stereo draw pass republishes the eye
     * split it used, then sends the report at once. Neither step touches the
     * camera, the scene, the mode or any setting: it is the report the panel
     * would have sent anyway, sent now.
     */
    __stereoStructureProbe?: {
      refresh(): Promise<void>;
      /**
       * Who this panel is and how far its own report counter has got.
       *
       * The harness photographs a frame and then asks the *server* what that
       * frame was, and the server holds reports from every panel the run has
       * mounted. Reading the counter from the panel itself is what lets the
       * harness say "a report this panel produced after this instant" rather
       * than "a report that reached the server after this instant" — the two
       * differ by exactly the send that was already in flight. Reads module
       * state and nothing else.
       */
      identity(): { panelId: string; sequence: number; fitEventCount: number; lastFitAt?: string };
    };
    /** Test-only control plane, installed only when the page init script opts in. */
    __stereoStructureAcceptance?: {
      load(text: string): Promise<void>;
      /**
       * Load through the shipped path with the shipped presentation, for the
       * centring probe. `load` re-shades the scene for the marker classifier,
       * which is wrong for a real structure.
       */
      loadShipped(text: string, format?: 'pdb' | 'mmcif'): Promise<void>;
      /** Re-run the automatic fit the host resize path uses. */
      refit(): boolean;
      /** Resolve after the queued palette/theme update for this mode finishes. */
      setMode(next: StereoMode, depthBudgetArcmin?: number, swapEyes?: boolean): Promise<void>;
      setGlasses(next: GlassesKind): void;
      /** Apply a colour and/or a style through the shipped path and settle. */
      setLook(next: { color?: LookColor; style?: LookStyle }): Promise<void>;
      setVariant(next: Variant): void;
      /**
       * Acceptance-only: swap between the flat unlit swatches the marker
       * classifier needs and the shipped shading the luma criterion is
       * measured on. See `setAcceptanceMarkerPresentation`.
       */
      setMarkerShading(shading: 'flat' | 'shipped'): Promise<void>;
      /** Acceptance-only: put Mol*'s own screen-space passes back. */
      setPasses(passes: { antialiasing: boolean; multiSample: boolean }): void;
      setCamera(position: readonly [number, number, number], target: readonly [number, number, number]): Promise<void>;
      setDensity(cssPxPerInch: number, devicePixelRatio: number): void;
      state(): { mode: StereoMode; params: StereoParams | undefined; camera: ReturnType<typeof readCamera>; stageWidth: number; webgl2: boolean; variant: Variant; glasses: GlassesKind; passes: { antialiasing: string; multiSample: string }; pose: CameraPose; look: { color: LookColor; style: LookStyle; appliedColorTheme: string; plddtApplicable: boolean; disabled: boolean; representations: Array<{ type: string; colorTheme: string; ignoreLight?: boolean; tags: readonly string[] }> } };
    };
  }
}

type ViewerMessage = {
  kind?: 'open' | 'control' | 'state' | 'mode' | 'motion' | 'view' | 'action_claim' | 'action_complete';
  /** Opaque server-issued key for every app-only cache/state call. */
  sessionId?: string;
  /** Random lifecycle UUID that scopes render/state counters to one server. */
  serverEpoch?: string;
  /** Monotonic server ordering marker on structure-bearing results only. */
  renderToken?: number;
  /** Monotonic per-session safe-state freshness marker. */
  stateRevision?: number;
  /** A stale app-only full-state write was rejected; snapshot is current. */
  conflict?: boolean;
  action?: string;
  actionId?: string;
  claimed?: boolean;
  completed?: boolean;
  motion?: MotionSettings;
  mode?: StereoMode;
  depthBudgetArcmin?: number;
  swapEyes?: boolean;
  variant?: Variant;
  color?: LookColor;
  style?: LookStyle;
};

/**
 * `autoResize: false` is load-bearing, not a tidy-up.
 *
 * The default measures `document.documentElement` at `height: max-content` on
 * every `ResizeObserver` tick and reports it to the host, which applies it to
 * the iframe. This shell is `height: 100%` around a flex stage with no
 * intrinsic height, so the reported height is whatever the canvas already was
 * and the loop converges on a thin card. See `./panel-size.ts`, which owns the
 * height this app asks for instead.
 */
const app = new App(
  { name: 'Stereofold', version: '0.1.21' },
  { tools: { listChanged: false } },
  { autoResize: false },
);
/**
 * The drawer's two Look selects are built from `./look.ts`, so the option
 * list, the tool schema and the Mol* call all read the same array and a new
 * theme cannot appear in one of them alone.
 */
function lookOptionsHtml(options: ReadonlyArray<{ value: string; label: string }>): string {
  return options.map((option) => `<option value="${option.value}">${option.label}</option>`).join('');
}

const initialRoot = document.querySelector<HTMLElement>('#stereo-app');
if (initialRoot == null) throw new Error('Stereofold root is unavailable.');
const root: HTMLElement = initialRoot;

root.innerHTML = `
  <main class="shell" aria-label="Stereofold viewer">
    <header class="toolbar">
      <div class="toolbar-row">
        <div class="brand" title="Stereofold — see proteins in real depth">Stereo<b>fold</b></div>
        <div class="modes" role="group" aria-label="Stereo mode">
          <button class="mode-button" data-mode="off" aria-pressed="true">Mono</button>
          <button class="mode-button" data-mode="parallel" aria-pressed="false">Parallel</button>
          <button class="mode-button" data-mode="cross" aria-pressed="false">Cross</button>
          <button class="mode-button" data-mode="anaglyph" aria-pressed="false">Anaglyph</button>
        </div>
        <div class="spacer"></div>
        <button id="settings-toggle" class="ghost" aria-expanded="false" aria-controls="drawer" title="Structure, motion, anaglyph and observer settings">Settings</button>
        <button id="display-mode-toggle" class="ghost" aria-pressed="false" title="Move the viewer to Codex&#39;s side panel" hidden>Open in side panel</button>
        <div id="connection" class="status-dot" data-state="connecting" title="Connecting to the host…">CONNECTING</div>
      </div>
      <div class="toolbar-row toolbar-row-stereo" id="stereo-row" hidden>
        <div class="depth-control">
          <label for="depth-strength">Depth</label>
          <input id="depth-strength" type="range" min="0" max="40" step="1" value="20" aria-label="Depth strength in arcminutes">
        </div>
        <label class="toolbar-toggle" id="swap-field" title="Exchange the left and right eye images"><input id="swap-eyes" type="checkbox"> Swap</label>
        <button id="fit-view" class="toolbar-button" title="Frame the structure in the current eye window">Fit</button>
        <div class="toolbar-field" id="glasses-field" hidden><label for="anaglyph-glasses">Glasses</label><select id="anaglyph-glasses" aria-label="Anaglyph glasses"><option value="red-cyan">Red / cyan</option><option value="green-magenta">Green / magenta</option><option value="amber-blue">Amber / blue</option></select></div>
      </div>
    </header>
    <div class="stage-area">
      <section class="viewer-bay">
        <div id="letterbox" class="letterbox"><div id="molstar-stage" class="molstar-stage"><div id="overlay-readout" class="overlay-readout"><span class="caption-mode">Mono</span> · stereo off</div><div id="empty-state" class="empty-state" hidden><p id="empty-state-lead" class="empty-state-lead">Nothing loaded yet.</p><p id="empty-state-hint" class="empty-state-hint">Ask for a PDB ID, for example: Open 1CRN in Stereofold.</p></div></div></div>
      </section>
      <div id="notice" class="toast" role="status"></div>
      <aside id="drawer" class="drawer" aria-label="Stereofold settings" hidden>
        <div class="drawer-head">
          <h2>Settings</h2>
          <p>See proteins in real depth</p>
        </div>
        <div class="group">
          <h3>Structure</h3>
          <div class="row">
            <label for="pdb-id">PDB</label>
            <input id="pdb-id" class="grow" type="text" maxlength="4" placeholder="1EMA" aria-label="PDB ID">
            <button id="load-pdb" class="primary">Load</button>
          </div>
          <textarea id="structure-text" aria-label="Pasted PDB or mmCIF coordinates" placeholder="…or paste PDB / mmCIF coordinates"></textarea>
          <div class="row"><button id="load-text">Load pasted coordinates</button></div>
          <p class="hint">A PDB id is fetched from files.rcsb.org through the assistant. Pasted coordinates never leave this panel.</p>
        </div>
        <div class="group" id="look-group">
          <h3>Look</h3>
          <div class="row">
            <div class="field"><label for="look-color">Colour</label><select id="look-color" aria-label="Colour theme">${lookOptionsHtml(LOOK_COLOR_OPTIONS)}</select></div>
            <div class="field"><label for="look-style">Style</label><select id="look-style" aria-label="Representation style">${lookOptionsHtml(LOOK_STYLE_OPTIONS)}</select></div>
          </div>
          <p class="hint">Anaglyph shows brightness only; colour comes back when you leave it.</p>
        </div>
        <div class="group">
          <h3>Depth test</h3>
          <div class="row"><button id="load-fixture" class="grow">Load depth test</button></div>
          <p class="hint">Three marker spheres at 45, 65 and 85 Å camera depth, enlarged so depth order is judgeable by eye.</p>
        </div>
        <div class="group">
          <h3>Motion</h3>
          <div class="row">
            <select id="motion" class="grow" aria-label="Camera motion"><option value="none">No motion</option><option value="rock">Rock (default)</option><option value="spin">Spin</option><option value="parallax">Mouse parallax</option></select>
            <button id="reset-camera">Refit view</button>
          </div>
          <div class="row">
            <label for="motion-amplitude">Amplitude</label>
            <input id="motion-amplitude" class="grow" type="number" min="0" max="30" step="0.1" placeholder="deg" aria-label="Rock amplitude in degrees">
            <label for="motion-period">Period</label>
            <input id="motion-period" class="grow" type="number" min="0.1" max="600" step="0.1" placeholder="s" aria-label="Motion period in seconds">
            <label for="motion-axis">Axis</label>
            <select id="motion-axis" aria-label="Motion axis"><option value="y">Y</option><option value="x">X</option></select>
          </div>
          <p id="motion-hint" class="hint" aria-live="polite">Slow rock is the default depth cue.</p>
        </div>
        <div class="group">
          <h3>Anaglyph</h3>
          <div class="row">
            <label for="anaglyph-variant">Variant</label>
            <select id="anaglyph-variant" class="grow" aria-label="Anaglyph compositor variant"><option value="balanced">Balanced (matched eye brightness)</option><option value="dubois">Dubois colour (unequal eye brightness)</option></select>
          </div>
          <label class="check" title="Mol*'s camera gizmo draws at zero disparity in both eyes, so it is a screen-plane anchor. It is hidden while the depth fixture is loaded and left on for real structures."><input id="camera-axes" type="checkbox" checked> Show camera axes</label>
        </div>
        <div class="group">
          <h3>Observer</h3>
          <div class="row">
            <label for="css-ppi">CSS px/in</label>
            <input id="css-ppi" class="grow" type="number" min="30" max="600" step="0.5" aria-label="CSS pixels per inch of your screen" title="A browser reports 96 CSS px per inch whatever the screen really is, so this cannot be measured from inside the page. Divide your screen's pixel width by its width in inches and enter that.">
            <span id="density-note" class="note warning">assumed · enter yours</span>
          </div>
          <div class="row">
            <label for="viewing-distance">Distance</label>
            <input id="viewing-distance" class="grow" type="number" min="150" max="2000" step="10" value="500" aria-label="Viewing distance in millimetres">
            <span class="note">mm</span>
          </div>
          <div id="camera-status" class="readout-panel" aria-live="polite">Awaiting Mol* camera.</div>
          <p class="hint">Predicted disparities are physical, so they are only as good as these two numbers.</p>
        </div>
      </aside>
    </div>
  </main>`;

const element = <T extends HTMLElement>(selector: string) => {
  const found = root.querySelector<T>(selector);
  if (found == null) throw new Error(`Stereofold control ${selector} is unavailable.`);
  return found;
};

const stage = element<HTMLDivElement>('#molstar-stage');
const letterbox = element<HTMLDivElement>('#letterbox');
const overlay = element<HTMLDivElement>('#overlay-readout');
const cameraStatus = element<HTMLDivElement>('#camera-status');
const connection = element<HTMLDivElement>('#connection');
const depthInput = element<HTMLInputElement>('#depth-strength');
const swapInput = element<HTMLInputElement>('#swap-eyes');
const fitButton = element<HTMLButtonElement>('#fit-view');
const motionSelect = element<HTMLSelectElement>('#motion');
const motionAmplitude = element<HTMLInputElement>('#motion-amplitude');
const motionPeriod = element<HTMLInputElement>('#motion-period');
const motionAxis = element<HTMLSelectElement>('#motion-axis');
const motionHint = element<HTMLElement>('#motion-hint');
const glassesSelect = element<HTMLSelectElement>('#anaglyph-glasses');
const variantSelect = element<HTMLSelectElement>('#anaglyph-variant');
const lookGroup = element<HTMLDivElement>('#look-group');
const colorSelect = element<HTMLSelectElement>('#look-color');
const styleSelect = element<HTMLSelectElement>('#look-style');
const cameraAxesInput = element<HTMLInputElement>('#camera-axes');
const densityInput = element<HTMLInputElement>('#css-ppi');
const densityNote = element<HTMLSpanElement>('#density-note');
const distanceInput = element<HTMLInputElement>('#viewing-distance');
const notice = element<HTMLDivElement>('#notice');
const drawer = element<HTMLElement>('#drawer');
const settingsToggle = element<HTMLButtonElement>('#settings-toggle');
const displayModeToggle = element<HTMLButtonElement>('#display-mode-toggle');
const emptyState = element<HTMLDivElement>('#empty-state');
const emptyStateLead = element<HTMLParagraphElement>('#empty-state-lead');
const emptyStateHint = element<HTMLParagraphElement>('#empty-state-hint');
const stereoRow = element<HTMLDivElement>('#stereo-row');
const glassesField = element<HTMLDivElement>('#glasses-field');

/**
 * Load results and errors are events, so they are a toast that clears itself.
 *
 * They used to be a permanent header line, where the one sentence a load
 * produces was truncated to "Loaded pasted structure. Cartoon polymer + ball-
 * and-stick ligand prese…" and then sat there for the rest of the session
 * reading like a title. The stage caption cannot hold them either:
 * `updateReadout` rewrites it on every animation frame. The toast floats over
 * the stage, so its length never moves a control, and the full text stays
 * available as the element's tooltip.
 */
const NOTICE_MS = 6_000;
const NOTICE_ERROR_MS = 12_000;
let noticeTimer: number | undefined;

function notify(message: string, kind: 'info' | 'error' = 'info'): void {
  notice.textContent = message;
  notice.title = message;
  notice.classList.toggle('is-error', kind === 'error');
  notice.classList.add('is-visible');
  if (noticeTimer !== undefined) window.clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => {
    notice.classList.remove('is-visible');
  }, kind === 'error' ? NOTICE_ERROR_MS : NOTICE_MS);
}

function setConnection(state: 'connecting' | 'connected' | 'offline'): void {
  const label = state.toUpperCase();
  connection.textContent = label;
  connection.dataset.state = state;
  connection.title = state === 'connected'
    ? 'Connected to the host.'
    : state === 'offline'
      ? 'Not connected to the host. The viewer still runs locally.'
      : 'Connecting to the host…';
}

function setDrawerOpen(open: boolean): void {
  drawer.hidden = !open;
  settingsToggle.setAttribute('aria-expanded', String(open));
}

/**
 * Stop Mol* probing WebXR in a document that is not allowed to use it.
 *
 * Canvas3D always constructs an `XRManager`, whose `checkSupported` calls
 * `navigator.xr.isSessionSupported()` unconditionally
 * (`mol-canvas3d/helper/xr-manager.js:263-279`). Hosts embed this app in a
 * frame without `allow="xr-spatial-tracking"`, so the call is denied and the
 * browser logs a permissions-policy violation on every load. `checkSupported`
 * already treats a missing `navigator.xr` as unsupported, which is the same
 * conclusion the denied probe reaches, and this viewer exposes no WebXR entry
 * point. Only suppress where the document can be asked and says no, so a host
 * that does grant the permission keeps the capability.
 */
function suppressDeniedWebXrProbe(): void {
  type PolicyQuery = { allowsFeature(feature: string): boolean };
  const owner = document as Document & { featurePolicy?: PolicyQuery; permissionsPolicy?: PolicyQuery };
  const policy = owner.featurePolicy ?? owner.permissionsPolicy;
  if (policy == null || typeof policy.allowsFeature !== 'function') return;
  if (!('xr' in navigator)) return;
  try {
    if (policy.allowsFeature('xr-spatial-tracking')) return;
    Object.defineProperty(navigator, 'xr', { value: undefined, configurable: true });
  } catch {
    // A host that freezes navigator keeps the console line. Nothing breaks.
  }
}

suppressDeniedWebXrProbe();

const plugin = new PluginContext(DefaultPluginSpec());
let controller: StereoController | undefined;
let motionController: MotionController | undefined;
/**
 * The server never infers a conversation from process-global state. The sole
 * render result hands this panel an opaque session key, and every later app
 * call echoes it back. A generation also identifies which open owns an async
 * hydration response. Neither value is persisted outside this frame.
 */
const sessionGuard = createSessionGenerationGuard();
type SessionWorkGuard = WorkCurrentGuard;

/** Keep session-originated asynchronous work from outliving its render. */
function isCurrentSessionWork(request?: SessionGeneration): boolean {
  return sessionRequestIsCurrent(sessionGuard, request);
}

const mouseParallax = new MouseParallaxSource();
let mode: StereoMode = 'off';
let glasses: GlassesKind = 'red-cyan';
/**
 * Balanced is the shipped compositor. Each filter receives only Rec.709 luma,
 * scaled so both eyes emit the same luma on a zero-disparity field. Dubois is
 * the colour projector and leaves the two eyes measurably unequal, so it is an
 * explicit choice rather than a default.
 */
let variant: Variant = 'balanced';
/**
 * The look: which Mol* colour theme and which representation preset.
 *
 * Both are the choice, not the resolved Mol* name. `plddt-confidence` is a
 * request that `resolveColorTheme` turns into `uncertainty` on a structure
 * that carries no pLDDT, and that decision is remade on every apply because
 * it depends on the structure currently loaded, not on the choice.
 */
let lookColor: LookColor = DEFAULT_LOOK_COLOR;
let lookStyle: LookStyle = DEFAULT_LOOK_STYLE;
/** The Mol* theme name the last apply actually used, for the readout and tests. */
let appliedColorTheme: string = DEFAULT_LOOK_COLOR;
/** True while the depth fixture owns the stage and its own marker presentation. */
let depthFixtureLoaded = false;
let dragging = false;
let densityEstimated = true;

/**
 * The density note, which has to say that nothing was measured.
 *
 * CSS defines one inch as exactly 96 CSS px, so a `width: 1in` probe returns
 * 96 in every browser on every screen: it is a unit conversion, not a
 * measurement. Until the observer types their screen's real density, every
 * millimetre this viewer prints — the 63 mm eye window, the depth budget in
 * arcminutes, the disparity readout — is scaled by an assumption. The note
 * says so rather than saying "estimated", which reads like a measurement that
 * was merely imprecise.
 */
function updateDensityNote(): void {
  densityNote.textContent = densityEstimated ? 'assumed · enter yours' : 'yours';
  densityNote.classList.toggle('warning', densityEstimated);
}

function viewportPxPerInch(): number {
  const reading = measureCssDensity(document);
  densityEstimated = reading.estimated;
  return reading.cssPxPerInch;
}

function readCamera() {
  const canvas = plugin.canvas3d;
  if (canvas == null) throw new Error('Stereofold Mol* canvas is not initialized.');
  const snapshot = canvas.camera.state;
  const box = stage.getBoundingClientRect();
  const visibleSphere = canvas.boundingSphereVisible.radius > 0
    ? canvas.boundingSphereVisible
    : { ...canvas.boundingSphere, radius: canvas.boundingSphere.radius || 20 };
  return snapshotFromMolstar(canvas.camera, visibleSphere, box.width, box.height);
}

/**
 * Everything the centring probe needs that `readCamera` does not carry.
 *
 * `worldXInCameraFrame` is the first column of Mol*'s view matrix, which is
 * the world x axis expressed in camera coordinates. Its x component is the
 * only thing that decides whether an eye baseline applied along world x lands
 * on the camera's own x axis; `scripts/stereo-centring-probe.ts` reads it to
 * show that a real structure's camera is nowhere near axis aligned.
 */
type CameraPose = {
  position: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  worldXInCameraFrame: [number, number, number];
  stereo: { eyeSeparation: number; focus: number } | undefined;
  eyeViewport: { width: number; height: number };
  stageWidth: number;
  stageHeight: number;
  letterboxWidth: number;
};

function readCameraPose(): CameraPose {
  const canvas = plugin.canvas3d;
  if (canvas == null) throw new Error('Stereofold Mol* canvas is not initialized.');
  const view = canvas.camera.view;
  const stereo = canvas.props.camera.stereo;
  const box = stage.getBoundingClientRect();
  const tuple = (value: ArrayLike<number>): [number, number, number] => [value[0] ?? 0, value[1] ?? 0, value[2] ?? 0];
  return {
    position: tuple(canvas.camera.state.position),
    target: tuple(canvas.camera.state.target),
    up: tuple(canvas.camera.state.up),
    worldXInCameraFrame: [view[0], view[1], view[2]],
    stereo: stereo.name === 'on'
      ? { eyeSeparation: stereo.params.eyeSeparation, focus: stereo.params.focus }
      : undefined,
    eyeViewport: eyeViewportPx(),
    stageWidth: box.width,
    stageHeight: box.height,
    letterboxWidth: letterbox.clientWidth,
  };
}

/**
 * Letterbox a side-by-side stage to an even CSS width.
 *
 * Mol* splits the stereo viewport with `Math.floor(width / 2)` and hands the
 * leftover column to the right eye (`mol-canvas3d/camera/stereo.js:103-107`).
 * An odd stage width therefore rasterises the two eyes at different horizontal
 * scales, and the cross-eyed viewport exchange in
 * `molstar-stereo-patch.ts:22-31` swaps two unequal slots. Forcing an even
 * width keeps both eyes on the same pixel grid.
 */
function applySideBySideWidth(halfCapPx: number | null): void {
  // A fractional CSS box makes the browser rescale Mol*'s whole-pixel drawing
  // buffer, so every measured pixel is resampled. The letterbox reports whole
  // CSS pixels, so pin the stage height to it.
  const heightPx = `${Math.max(1, letterbox.clientHeight)}px`;
  if (stage.style.height !== heightPx) stage.style.height = heightPx;
  if (halfCapPx == null) {
    if (stage.style.maxWidth !== '') stage.style.maxWidth = '';
    return;
  }
  const wanted = `${sideBySideCanvasWidthPx(halfCapPx, letterbox.clientWidth)}px`;
  if (stage.style.maxWidth !== wanted) stage.style.maxWidth = wanted;
}

/**
 * One-eye width cap for the active mode.
 *
 * `StereoParams.halfWidthCapPx` is parallel-only by contract. A
 * cross-eyed pair is the same side-by-side geometry with the eye order
 * exchanged, so it reuses the geometry package's physical cap directly. 63 mm
 * is conservative for cross-eyed fusion, which converges inside the pair and
 * therefore tolerates at least the parallel separation.
 */
function halfWidthCapForMode(params: StereoParams, settings: StereoSettings): number | null {
  if (settings.mode === 'parallel') return params.halfWidthCapPx;
  if (settings.mode === 'cross') {
    return parallelHalfWidthCapPx(settings.cssPxPerInch, settings.devicePixelRatio);
  }
  return null;
}

/**
 * How much of one eye's viewport a freshly opened structure fills.
 *
 * Mol*'s own reset solves `distance = radius / sin(fov / 2)`
 * (`mol-canvas3d/camera.js:268-278`), which puts the bounding sphere's
 * silhouette exactly on the frustum edge: 2 * cos(fov / 2) = 92.4 % of the
 * viewport's shorter side, with no margin at all. It also measures that
 * against the *parent* camera viewport, and a side-by-side pair gives each eye
 * only half the stage width, so the same distance that frames a mono stage
 * clips both eyes of a parallel or cross pair on a tall panel. This fit is
 * derived from the eye viewport and leaves a deliberate margin.
 */
const STAGE_FILL_FRACTION = 0.86;

/** Active loads/resets that currently own the camera and block interleaved fits. */
const fitSuspensions = createFitSuspensionRegistry(sessionGuard);
/** True while the depth fixture's pinned pose (0, 0, 65) must be preserved. */
let fixturePinned = false;
/**
 * The eye viewport and scene radius the camera is *actually* framed for.
 *
 * Written by `fitCameraToStage` and by nothing else, so it can never claim a
 * framing that did not happen. It deliberately survives a load, a reset and a
 * dock: the fit those paths perform records itself here, and any change that
 * arrives afterwards is then a genuine mismatch the next frame corrects. See
 * `./fit-decision.ts` for what went wrong when this was "the geometry the last
 * frame saw" instead.
 */
let fittedGeometry: FitGeometry | undefined;
/**
 * True once this panel has a structure on the stage.
 *
 * It gates two things a viewer with nothing in it must not do: ask the server
 * for the last opened structure (see `runStructureFallback`), and draw Mol*'s
 * camera-axes gizmo, which on an empty stage is the only thing visible and
 * reads as a broken render rather than an empty one.
 */
let structureLoaded = false;
/**
 * The request that committed the structure now on stage, when it was loaded
 * through a session-owned hydration path. `structureLoaded` alone is not
 * proof that *this* open succeeded: an older scene can exist while a malformed
 * replacement is being rejected.
 */
let loadedStructureRequest: SessionGeneration | undefined;
/** True while a load is between `plugin.clear()` and its final fit. */
let loadInFlight = false;

function structureIsLoadedFor(request: SessionGeneration): boolean {
  return structureLoaded
    && loadedStructureRequest?.generation === request.generation
    && loadedStructureRequest.sessionId === request.sessionId;
}

/* ------------------------------------------------------- fit diagnostics */

/**
 * The bookkeeping the live-panel report is assembled from.
 *
 * None of it changes what the viewer draws. It exists because two fits were
 * shipped against photographs of a real Codex side panel and neither changed
 * what was on screen, and because no debugger can be attached to that
 * webview: the only way to find out which rectangle the camera was framed
 * against is to have the panel say so. See `./fit-diagnostics.ts`.
 */
let diagnosticsSequence = 0;
/**
 * Which panel this is.
 *
 * Codex mounts an app instance for every tool card that carries UI metadata,
 * and every one of them keeps reporting for as long as the conversation is
 * open. `viewerBuild` says which bytes are running and `sequence` orders one
 * panel's own reports; neither tells two panels of the same build apart, so
 * the server could not know that the report it just stored came from a hidden
 * card six messages up. This is the key it keeps them under.
 */
const panelId = ((): string => {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (typeof uuid === 'string' && uuid.length > 0) return uuid;
  // A webview without randomUUID still has to be distinguishable. This is an
  // identifier, not a secret.
  return `panel-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
})();
const fitEvents = createFitEventRing(FIT_EVENT_RING_CAPACITY);
let lastRefitDecision: RefitDecisionRecord | undefined;
/** How many `hostcontextchanged` notifications have arrived, and when the last did. */
let hostContextCount = 0;
let hostContextAt: string | undefined;
/** Tool results delivered to this panel since it mounted, by kind. */
const messageCounts = { open: 0, state: 0, mode: 0 };
let structureSource: StructureSource = 'none';
/** The PDB id of the structure on the stage, when it came from one. */
let lastLoadedPdbId: string | undefined;
/** Wheel and pinch events on the stage; the first resets on every fit. */
let wheelEventsSinceFit = 0;
let wheelEventsTotal = 0;
/** Set while a known cause owns the next fit; see `withFitTrigger`. */
let nextFitTrigger: FitTrigger | undefined;
let fitTriggerTimer: number | undefined;

/**
 * How long an asynchronous cause may claim the next fit, ms.
 *
 * A host context change resizes the frame and the refit lands on a later
 * animation frame, so the cause cannot be scoped to a call the way a mode
 * switch can. Anything within this window of the host context is attributed to
 * it; anything later is an ordinary geometry refit. Short enough that it
 * cannot claim a fit some other cause produced.
 */
const FIT_TRIGGER_WINDOW_MS = 250;

/**
 * Name the next fit, for a cause that reaches it synchronously.
 *
 * `setMode` never calls the fit: it calls `StereoController.setSettings`,
 * which runs a readout and `maybeRefitCamera` inside the caller's own turn. So
 * the trigger is scoped to that call and restored afterwards, and a fit inside
 * it is a mode change while a fit after it is not.
 */
function withFitTrigger<T>(trigger: FitTrigger, run: () => T): T {
  const previous = nextFitTrigger;
  nextFitTrigger = trigger;
  try {
    return run();
  } finally {
    nextFitTrigger = previous;
  }
}

/** Name the next fit for {@link FIT_TRIGGER_WINDOW_MS}, for an asynchronous cause. */
function armFitTrigger(trigger: FitTrigger): void {
  nextFitTrigger = trigger;
  if (fitTriggerTimer !== undefined) window.clearTimeout(fitTriggerTimer);
  fitTriggerTimer = window.setTimeout(() => {
    fitTriggerTimer = undefined;
    if (nextFitTrigger === trigger) nextFitTrigger = undefined;
  }, FIT_TRIGGER_WINDOW_MS);
}

/**
 * The one-eye width cap in force, CSS px, or null in a mono mode.
 *
 * Read from the live settings rather than from the measured stage box, because
 * `applySideBySideWidth` writes the cap to `stage.style.maxWidth` from the
 * readout pass and every direct caller of `fitCameraToStage` — a load, a mode
 * switch, a host resize, a dock or undock — can reach the fit before that
 * style has landed. The fit and the diagnostics call this same function, so a
 * reported cap can never be a different number from the one that was used.
 */
function currentHalfCapPx(): number | null {
  if (mode !== 'parallel' && mode !== 'cross') return null;
  const settings = controller?.getSettings();
  if (settings == null) return null;
  const params = controller?.getParams();
  return params != null
    ? halfWidthCapForMode(params, settings)
    : parallelHalfWidthCapPx(settings.cssPxPerInch, settings.devicePixelRatio);
}

/**
 * CSS pixels of one eye's viewport: side-by-side modes halve the *capped*
 * stage. See `eyeViewportFromStage`.
 */
function eyeViewportPx(): { width: number; height: number } {
  const box = stage.getBoundingClientRect();
  return eyeViewportFromStage({
    stageWidthPx: box.width,
    stageHeightPx: box.height,
    availableWidthPx: letterbox.clientWidth,
    sideBySide: mode === 'parallel' || mode === 'cross',
    halfCapPx: currentHalfCapPx(),
  });
}

function visibleSphere(canvas: Canvas3D): { center: ArrayLike<number>; radius: number } {
  return canvas.boundingSphereVisible.radius > 0 ? canvas.boundingSphereVisible : canvas.boundingSphere;
}

/**
 * How close two camera poses have to be to count as the same one, Å.
 *
 * The comparison is against a pose this module wrote itself through
 * `camera.setState`, so an untouched camera matches to the last bit and the
 * tolerance only absorbs a float round trip. It is absolute rather than
 * relative because the quantity is a distance in Ångströms and the structures
 * are tens of Ångströms across.
 */
const SAME_CAMERA_EPSILON_ANG = 1e-6;

/** Whether the camera already holds exactly the pose a fit would write. */
function cameraIsAt(
  camera: Canvas3D['camera'],
  target: Vec3,
  position: Vec3,
  radius: number,
): boolean {
  const state = camera.state;
  return Vec3.distance(state.target, target) <= SAME_CAMERA_EPSILON_ANG
    && Vec3.distance(state.position, position) <= SAME_CAMERA_EPSILON_ANG
    && Math.abs(state.radius - radius) <= SAME_CAMERA_EPSILON_ANG;
}

/**
 * Frame the visible bounding sphere in one eye's viewport.
 *
 * Solves for the camera distance at which the sphere's angular radius
 * `asin(radius / distance)` projects to `STAGE_FILL_FRACTION / 2` of the eye
 * viewport's shorter side, measured against the same vertical field of view
 * the projection uses. The camera keeps its current view direction, so this
 * reframes an orbit without rotating it.
 */
function fitCameraToStage(
  trigger: FitTrigger = 'refit',
  options: {
    /**
     * Skip the write, the ring entry and the report when the camera is already
     * exactly where this fit would put it.
     *
     * Only the load's second-chance fit passes this. See `loadStructureNow`.
     */
    onlyWhenMoved?: boolean;
  } = {},
): boolean {
  const canvas = plugin.canvas3d;
  if (canvas == null) return false;
  // The pixel-acceptance render scripts its own camera pose and measures
  // against it. It must never be reframed.
  if (globalThis.__stereoStructureAcceptanceMode === true) return false;
  const sphere = visibleSphere(canvas);
  const radius = sphere.radius;
  if (!(radius > 0)) return false;
  const eye = eyeViewportPx();
  const camera = canvas.camera;
  const distance = fitDistanceForEyeViewport({
    radius,
    eyeWidthPx: eye.width,
    eyeHeightPx: eye.height,
    fovRad: camera.state.fov,
    fillFraction: STAGE_FILL_FRACTION,
  });
  if (distance === undefined) return false;
  const direction = Vec3.sub(Vec3(), camera.state.target, camera.state.position);
  if (Vec3.magnitude(direction) < 1e-6) Vec3.set(direction, 0, 0, -1);
  Vec3.normalize(direction, direction);
  const target = Vec3.create(sphere.center[0] ?? 0, sphere.center[1] ?? 0, sphere.center[2] ?? 0);
  const position = Vec3.scaleAndAdd(Vec3(), target, direction, -distance);
  // Nothing to record when nothing moves. A fit event is a claim that the
  // camera was reframed, and a ring that repeats the same claim twice per load
  // hides the one thing it is read for: which trigger last framed the picture.
  if (options.onlyWhenMoved === true && cameraIsAt(camera, target, position, radius)) return false;
  camera.setState({ target, position, radius }, 0);
  // Record what this fit framed for, at the point the camera is written and
  // not before. Every other caller — the load, the reset, the dock — gets the
  // record for free, so none of them has to remember to keep it in step.
  fittedGeometry = { eyeWidthPx: eye.width, eyeHeightPx: eye.height, radius };
  // And record it for the live report. A fit is the only place the camera is
  // framed, so a ring of the last twelve carries which geometry each one was
  // solved against and what fill it produced. The wheel counter resets here,
  // which is what separates a person's own zoom from a wrong fit.
  recordFitEvent(trigger, { eyeWidthPx: eye.width, eyeHeightPx: eye.height, radius, distance });
  wheelEventsSinceFit = 0;
  reportDiagnostics(trigger);
  return true;
}

/**
 * Refit when the eye viewport's geometry stops matching what the camera is
 * framed for, and only then.
 *
 * The comparison is against `fittedGeometry`, which only a successful fit
 * writes, so a mode switch (which halves the eye width and re-caps the stage),
 * a host panel resize, a dock and a style change that grows the visible sphere
 * all refit, while a user's own orbit or zoom does not: those move the camera
 * without moving the geometry, so their framing is theirs to keep. Called once
 * per animation frame from `updateReadout`, and synchronously from every
 * `StereoController.setSettings`. See `./fit-decision.ts`.
 */
function maybeRefitCamera(): void {
  const canvas = plugin.canvas3d;
  if (canvas == null || globalThis.__stereoStructureAcceptanceMode === true) return;
  const radius = visibleSphere(canvas).radius;
  if (!(radius > 0)) return;
  const eye = eyeViewportPx();
  const current: FitGeometry = { eyeWidthPx: eye.width, eyeHeightPx: eye.height, radius };
  const inTransition = canvas.camera.transition.inTransition;
  const suspended = fitSuspensions.isSuspended();
  const decision = decideRefit({
    current,
    fitted: fittedGeometry,
    suspended,
    pinned: fixturePinned,
    inTransition,
  });
  // The decision and every input to it, kept for the live report. A `keep` on
  // a geometry that is visibly wrong is the exact reading that would settle
  // a side panel, and it is invisible from outside without this.
  lastRefitDecision = {
    at: new Date().toISOString(),
    decision,
    current,
    ...(fittedGeometry == null ? {} : { fitted: { ...fittedGeometry } }),
    suspended,
    pinned: fixturePinned,
    inTransition,
  };
  if (decision !== 'keep') reportDiagnostics('decision');
  if (decision !== 'refit') return;
  if (!fitCameraToStage(nextFitTrigger ?? 'refit')) return;
  motionController?.captureBaseline();
}

/** Frames of an unchanging committed scene that count as settled. */
const SETTLED_FRAMES = 8;

/**
 * Wait for Mol* to finish committing the new scene.
 *
 * `Scene.commit` runs on a 250 ms budget per draw and can take several draws,
 * and `commitScene` queues a fresh camera reset from any commit for which
 * `shouldResetCamera` is true (`mol-canvas3d/canvas3d.js:710-756`). That reset
 * is resolved inside the same draw. Fitting before the scene stops growing
 * therefore frames a partial structure and then has the fit overwritten by a
 * later reset. Waiting for the visible bounding sphere to hold still is the
 * condition that actually matters; a fixed timer either fires into a half-built
 * scene or wastes time on a small one.
 */
async function settleScene(isCurrent: SessionWorkGuard = () => true): Promise<void> {
  if (!isCurrent()) return;
  const canvas = plugin.canvas3d;
  if (canvas == null) return;
  let stableFrames = 0;
  let previousRadius = -1;
  for (let attempt = 0; attempt < 400; attempt++) {
    await nextFrame();
    if (!isCurrent()) return;
    const radius = canvas.boundingSphereVisible.radius;
    const settled = radius > 0 && radius === previousRadius && !canvas.camera.transition.inTransition;
    stableFrames = settled ? stableFrames + 1 : 0;
    previousRadius = radius;
    if (stableFrames >= SETTLED_FRAMES) return;
  }
}

/**
 * Convert a screen disparity back to the angle it subtends at the observer.
 *
 * This is the inverse of `angularDisparityToCssPx` in `@stereo/geometry`, and
 * it is what makes the readout comparable with the depth-strength slider: the
 * slider is a peak crossed-disparity budget in arcminutes, so the front and
 * rear predictions have to be reported in the same unit as well as in pixels.
 */
function cssPxToArcmin(cssPx: number, settings: StereoSettings): number {
  const millimetres = cssPxToMillimetres(Math.abs(cssPx), settings.cssPxPerInch);
  const radians = Math.atan(millimetres / settings.viewingDistanceMm);
  return Math.sign(cssPx) * radians * (180 / Math.PI) * 60;
}

function signed(value: number, digits: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;
}

/**
 * Headline for the stage caption.
 *
 * The mono headline deliberately still contains the literal word "off": it is
 * the state of the stereo pipeline, it is what the host-emulation harness
 * waits for when it confirms a structure has rendered, and "Mono" alone would
 * leave a reader guessing whether stereo was merely unavailable.
 */
function captionHeadline(params: StereoParams, settings: StereoSettings, cap: number | null): string {
  if (cap != null) {
    const effectiveHalfPx = Math.min(stage.getBoundingClientRect().width / 2, cap);
    const separationMm = cssPxToMillimetres(effectiveHalfPx, settings.cssPxPerInch);
    const label = settings.mode === 'cross' ? 'Cross pair' : 'Parallel pair';
    return `<span class="caption-mode">${label}</span> · one eye ${separationMm.toFixed(1)} mm`;
  }
  if (settings.mode === 'anaglyph') {
    return `<span class="caption-mode">Anaglyph</span> · ${glasses} glasses, ${variant}`;
  }
  return '<span class="caption-mode">Mono</span> · stereo off';
}

let lastCaption: string | undefined;

function updateReadout(params: StereoParams, settings: StereoSettings): void {
  const cap = halfWidthCapForMode(params, settings);
  applySideBySideWidth(cap);
  // The caption is the plain-language headline and nothing else. The derived
  // numbers used to sit here too; they are stimulus parameters, not something
  // an observer reads while fusing a pair, and in a side-by-side mode this
  // caption is monocular content inside the left eye's viewport. They live in
  // `#camera-status` in the drawer, in the exact format the evaluation
  // protocol transcribes.
  const caption = captionHeadline(params, settings, cap);
  if (caption !== lastCaption) {
    lastCaption = caption;
    overlay.innerHTML = caption;
  }
  // The human-evaluation protocol asks the observer to record these numbers
  // and compare them against the depth they actually see, so both the pixel
  // and the angular form of each predicted disparity are shown.
  cameraStatus.textContent = `B ${params.eyeSeparation.toFixed(3)} Å · F ${params.focus.toFixed(2)} Å`
    + ` · front ${signed(params.frontDisparityPx, 2)} px / ${signed(cssPxToArcmin(params.frontDisparityPx, settings), 1)}′`
    + ` · rear ${signed(params.rearDisparityPx, 2)} px / ${signed(cssPxToArcmin(params.rearDisparityPx, settings), 1)}′`;
  maybeRefitCamera();
}

/**
 * Suppress the screen-space passes that a given stereo mode cannot survive.
 *
 * Two of Mol*'s default passes are incompatible with stereo, for different
 * reasons, and each is only a problem for one family of modes.
 *
 * Ambient occlusion is not viewport-relative. `mol-gl/shader/ssao.frag.js:
 * 192-205` rotates the occlusion kernel by a procedural noise indexed with the
 * *absolute* framebuffer coordinate divided by the full texture size
 * (`selfCoords = gl_FragCoord.xy * invTexSize`, then `randomVec =
 * getNoiseVec2(selfCoords)`). A side-by-side pair puts the same geometry at
 * viewport x 0 in one eye and x = width / 2 in the other, so the two eyes
 * sample different kernel rotations and their occlusion terms round up to one
 * 8-bit unit apart. That is a monocular difference inside a stereo pair, which
 * is exactly what a fusing visual system must not be given, and it also made
 * the zero-baseline pixel gate non-deterministic. Anaglyph is unaffected: the
 * local DrawPass fork renders both eyes full frame at viewport origin (0, 0),
 * so both eyes get the same noise phase.
 *
 * Antialiasing and temporal multisampling used to overwrite the anaglyph
 * composite, and U1 suppressed both while anaglyph was active. They no longer
 * need suppressing: the DrawPass fork resolves each eye offscreen through the
 * whole pass chain and composites afterwards, so antialiasing runs per eye and
 * `MultiSamplePass` accumulates the composite. See
 * `plugin/src/molstar-draw-pass-fork.ts`.
 */
type PassBaseline = {
  occlusion: Canvas3D['props']['postprocessing']['occlusion'];
};

const PASS_OFF = { name: 'off', params: {} } as PassBaseline['occlusion'];
let passBaseline: PassBaseline | undefined;
let appliedPasses: string | undefined;

/**
 * Forget the recorded baseline. Acceptance mode changes these same props after
 * the first render, and those values, not Mol*'s defaults, are what the mode
 * rules must fall back to there.
 */
function resetPassBaseline(): void {
  passBaseline = undefined;
  appliedPasses = undefined;
}

function applyPassesForMode(canvas: Canvas3D, mode: StereoMode, enabled: boolean): void {
  passBaseline ??= { occlusion: canvas.props.postprocessing.occlusion };
  const splitViewport = enabled && (mode === 'parallel' || mode === 'cross');
  const wanted = `${splitViewport}`;
  if (appliedPasses === wanted) return;
  appliedPasses = wanted;
  canvas.setProps({
    postprocessing: { occlusion: splitViewport ? PASS_OFF : passBaseline.occlusion },
  } as Partial<Canvas3D['props']>);
}

function setMolstarStereo(input: { mode: StereoMode; enabled: boolean; eyeSeparation: number; focus: number; swapViewportX: boolean }): void {
  const canvas = plugin.canvas3d;
  if (canvas == null) return;
  applyPassesForMode(canvas, input.mode, input.enabled);
  globalThis.__stereoStructureViewportXSwap = input.swapViewportX;
  globalThis.__stereoStructureAnaglyph = {
    enabled: input.mode === 'anaglyph' && input.enabled,
    swapEyes: input.mode === 'anaglyph' && swapInput.checked,
    glasses,
    variant,
  };
  setAnaglyphThemeGlasses(glasses, variant);
  canvas.setProps({
    camera: {
      stereo: input.enabled
        ? { name: 'on', params: { eyeSeparation: input.eyeSeparation, focus: input.focus } }
        : { name: 'off', params: {} },
    },
  } as Partial<Canvas3D['props']>);
}

/**
 * Black is the only ground an 8-bit anaglyph composite can emit with matched
 * filter luma.
 *
 * The balanced red-cyan projector emits `[Y, kY, kY]` with `k = 0.27000254`,
 * so a ground of Rec.709 luma `Y` reaches the screen as two sRGB codes that
 * are each rounded independently. Half a code is worth `1.2 / (code + 14.025)`
 * of that channel's linear value, which is about 0.9 % at mid tones and grows
 * without bound as the code falls. The workshop's forced dark ground `#020506`
 * has `Y = 0.0013461`, composites to `[4, 1, 1]`, and measures a 7.693 %
 * literal filter-luma residual on its own. It covered 1258840 of the gate's
 * 1260000 pixels and was the whole of the 5.6536 % rendered residual U1
 * recorded. Exact black composites to `[0, 0, 0]`, which contributes zero luma
 * to both filters and therefore no residual at all. It is also the ground that
 * minimises ghosting through real gel filters.
 */
const ANAGLYPH_GROUND_HEX = 0x000000;

type ColorThemeSnapshot = {
  color: LookColor;
  depthFixture: boolean;
};

function currentColorThemeSnapshot(): ColorThemeSnapshot {
  return { color: lookColor, depthFixture: depthFixtureLoaded };
}

/**
 * Apply an anaglyph ground/theme inside an already-owned queue slot.
 *
 * Callers outside a load use the queued wrapper below. Keeping this unqueued
 * variant is essential: `loadStructureNow` already holds `queueLoad`, so
 * awaiting another queued job from there would wait on itself forever.
 */
async function setAnaglyphPresentationNow(
  enabled: boolean,
  isCurrent: SessionWorkGuard = () => true,
  theme: ColorThemeSnapshot = currentColorThemeSnapshot(),
): Promise<void> {
  if (!isCurrent()) return;
  const canvas = plugin.canvas3d;
  if (canvas == null) return;
  canvas.setProps({ renderer: { backgroundColor: enabled ? ANAGLYPH_GROUND_HEX : 0x071015 } } as Partial<Canvas3D['props']>);
  if (!isCurrent()) return;
  await applyColorTheme(enabled, isCurrent, theme);
}

/** Serialize presentation work with structure loads and discard stale sessions. */
function setAnaglyphPresentation(enabled: boolean, sessionRequest?: SessionGeneration): Promise<void> {
  const isCurrent = (): boolean => isCurrentSessionWork(sessionRequest);
  const theme = currentColorThemeSnapshot();
  return queueLoad(
    (queuedCurrent) => setAnaglyphPresentationNow(enabled, queuedCurrent, theme),
    isCurrent,
  );
}

/**
 * Does this structure carry a pLDDT score Mol* can colour by?
 *
 * The provider answers for itself: a quality-assessment score, or a B-factor
 * column on a model that is not experimental. An experimental crystal
 * structure has B-factors but no confidence, so it says no and the choice
 * resolves to `uncertainty` instead. Asked per apply, because the answer is a
 * property of the loaded structure and not of the choice.
 */
function plddtApplicable(): boolean {
  for (const structure of plugin.managers.structure.hierarchy.current.structures) {
    const data = structure.cell.obj?.data;
    if (data == null) continue;
    if (PLDDTConfidenceColorThemeProvider.isApplicable({ structure: data })) return true;
  }
  return false;
}

/**
 * Put one colour theme on every representation of every loaded structure.
 *
 * In anaglyph the luminance-led theme overrides the person's choice, because
 * the two filters can only carry brightness; leaving anaglyph restores the
 * choice rather than Mol*'s per-representation default, which is what the
 * drawer's hint promises.
 */
/**
 * The depth fixture's own colour theme, which the Look control cannot change.
 *
 * The three markers are a fluorine, an oxygen and a nitrogen precisely so that
 * they are told apart by hue — by the observer running the evaluation protocol
 * and by the pixel gate's marker classifier alike. Colouring them by chain
 * would make all three the same colour and take the stimulus away. This is the
 * theme the polymer-and-ligand preset already gave them, made explicit rather
 * than inherited from a per-representation default.
 */
const DEPTH_FIXTURE_COLOR_THEME = 'element-symbol';

async function applyColorTheme(
  anaglyph: boolean,
  isCurrent: SessionWorkGuard = () => true,
  snapshot: ColorThemeSnapshot = currentColorThemeSnapshot(),
): Promise<void> {
  if (!isCurrent()) return;
  const structures = plugin.managers.structure.hierarchy.current.structures;
  const components = structures.flatMap((structure) => structure.components);
  const color = anaglyph
    ? AnaglyphLuminanceColorThemeProvider.name
    : snapshot.depthFixture
      ? DEPTH_FIXTURE_COLOR_THEME
      : resolveColorTheme(snapshot.color, { plddtApplicable: plddtApplicable() });
  if (!isCurrent()) return;
  if (components.length === 0) {
    appliedColorTheme = color;
    return;
  }
  // Anaglyph and the depth fixture are whole-scene decisions: the luminance
  // theme has to reach every pixel the two filters will see, and the fixture's
  // three markers are one component. Only a person's colour choice is
  // per-representation, and only Chain is selective within that.
  const perRepresentation = !anaglyph && !snapshot.depthFixture;
  // Mol*'s manager generic only enumerates its built-in theme literals even
  // after a runtime provider has been registered. The runtime registry is the
  // authority here, so keep this cast local to that closed type boundary.
  // Bind before casting: the method reads `this.dataState`, so calling the
  // extracted function value threw on every mode change and the luminance-led
  // palette was never actually applied. The provider overload is the one that
  // lets Chain answer differently for the polymer and for its ligands.
  const manager = plugin.managers.structure.component;
  const updateTheme = manager.updateRepresentationsTheme.bind(manager) as unknown as (
    refs: typeof components,
    input: { color: string } | ((component: unknown, representation: { cell: { transform: { tags?: string | string[] } } }) => { color: string }),
  ) => Promise<unknown> | undefined;
  if (!perRepresentation) {
    await updateTheme(components, { color });
    if (!isCurrent()) return;
    appliedColorTheme = color;
    return;
  }
  await updateTheme(components, (_component, representation) => ({
    color: colorThemeForRepresentation({
      color: snapshot.color,
      resolvedTheme: color,
      tags: representationTags(representation),
    }),
  }));
  if (!isCurrent()) return;
  appliedColorTheme = color;
}

/**
 * The tags Mol* gave a representation when its preset built it — `polymer`,
 * `ligand`, `water` and so on. `StateTransform.tags` is a string or an array
 * of them depending on how the transform was applied, and untagged
 * representations exist, so this normalises all three to an array.
 */
function representationTags(representation: { cell: { transform: { tags?: string | string[] } } }): readonly string[] {
  const tags = representation.cell.transform.tags;
  if (tags == null) return [];
  return typeof tags === 'string' ? [tags] : tags;
}

/**
 * Rebuild the representations from a different preset, on the structure that
 * is already loaded.
 *
 * `StructureComponentManager.applyPreset` is the path Mol*'s own UI uses: it
 * applies the preset and then deletes every component and representation the
 * new preset did not produce. Applying the preset through the representation
 * builder alone would leave the old ones behind — cartoon polymer plus an
 * atomic-detail copy of the same atoms — because the two presets build
 * different components (`polymer`/`ligand`/… against a single `all`). Nothing
 * here refetches or reparses: the trajectory, the model and the structure cell
 * are untouched.
 *
 * A style change does move the visible bounding sphere (a molecular surface is
 * larger than the cartoon through it), and that is deliberately left to
 * `maybeRefitCamera`, whose fit key already carries the scene radius.
 */
async function applyStylePreset(
  style: LookStyle = lookStyle,
  isCurrent: SessionWorkGuard = () => true,
): Promise<void> {
  if (!isCurrent()) return;
  const structures = plugin.managers.structure.hierarchy.current.structures;
  if (structures.length === 0) return;
  const provider = plugin.builders.structure.representation.resolveProvider(style);
  if (provider == null) throw new Error(`Stereofold does not know the ${style} style.`);
  await plugin.managers.structure.component.applyPreset(structures, provider);
  if (!isCurrent()) return;
}

/**
 * The toolbar shows only the controls the active mode can act on: the depth
 * slider and Swap eyes do nothing without a stereo pair, and the glasses
 * filter does nothing outside anaglyph. All of them keep their ids and stay in
 * the DOM, hidden, so the tool payload can still write to them in any mode.
 */
function updateModeButtons(): void {
  root.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
  });
  // The second toolbar row carries the controls only a stereo pair can act
  // on, so it exists only in a stereo mode and the mono toolbar stays one row.
  stereoRow.hidden = mode === 'off';
  glassesField.hidden = mode !== 'anaglyph';
}

function optionalNumber(input: HTMLInputElement): number | undefined {
  if (input.value.trim() === '') return undefined;
  const value = Number(input.value);
  return Number.isFinite(value) ? value : undefined;
}

function motionFromControls(): MotionSettings {
  return {
    mode: motionSelect.value as MotionSettings['mode'],
    amplitudeDeg: optionalNumber(motionAmplitude),
    periodS: optionalNumber(motionPeriod),
    axis: motionAxis.value as MotionSettings['axis'],
  };
}

function hasReducedMotionPreference(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

function updateMotionHint(settings: MotionSettings): void {
  if (settings.mode === 'none' && hasReducedMotionPreference()) {
    motionHint.textContent = 'Rock is the default, but motion is off because this system requests reduced motion.';
  } else if (settings.mode === 'none') {
    motionHint.textContent = 'Motion is off. Slow rock is the default depth cue.';
  } else if (settings.mode === 'parallax') {
    motionHint.textContent = 'Mouse parallax uses pointer position only; it never requests camera access.';
  } else if (settings.mode === 'rock') {
    motionHint.textContent = 'Slow rock is the default. It moves the parent camera only; baseline and focus stay live.';
  } else {
    motionHint.textContent = 'Motion changes the parent camera only; stereo baseline and focus stay live.';
  }
}

/**
 * The shipped default is a slow rock, downgraded to no motion whenever the
 * system asks for reduced motion. The acceptance render starts still so a
 * screenshot is reproducible.
 */
function defaultMotion(): MotionSettings {
  if (globalThis.__stereoStructureAcceptanceMode === true) return { mode: 'none' };
  return hasReducedMotionPreference() ? { mode: 'none' } : { mode: 'rock' };
}

function setMotion(settings: MotionSettings): void {
  const next: MotionSettings = {
    mode: settings.mode,
    ...(settings.amplitudeDeg != null ? { amplitudeDeg: settings.amplitudeDeg } : {}),
    ...(settings.periodS != null ? { periodS: settings.periodS } : {}),
    axis: settings.axis ?? 'y',
  };
  motionSelect.value = next.mode;
  motionAmplitude.value = next.amplitudeDeg == null ? '' : String(next.amplitudeDeg);
  motionPeriod.value = next.periodS == null ? '' : String(next.periodS);
  motionAxis.value = next.axis ?? 'y';
  updateMotionHint(next);
  motionController?.setSettings(next, performance.now());
}

/** Apply server motion without overriding the observer's reduced-motion OS setting. */
function adoptMotion(
  settings: MotionSettings,
  options: { persistReducedOverride?: boolean } = {},
): void {
  if (hasReducedMotionPreference() && settings.mode !== 'none') {
    setMotion({ mode: 'none' });
    // This is a real viewer-state override, so persist it through the app-only
    // path once the session/result has been adopted. Recovery after a failed
    // sync suppresses this write: immediately retrying the failed write would
    // loop forever while the bridge/server remains unavailable.
    if (options.persistReducedOverride !== false) syncViewState();
    return;
  }
  setMotion(settings);
}

/**
 * Mol*'s camera-axes gizmo draws at zero disparity in both eyes, which makes
 * it a screen-plane anchor.
 *
 * `mol-canvas3d/helper/camera-helper.js:26-56` paints the X/Y/Z bars in the
 * bottom-left of every eye viewport, and the helper is not part of the scene,
 * so it carries no disparity at all. An observer judging which marker is
 * nearest then has a fixed reference at the screen plane in both eyes, which
 * is a confound for the depth-order task. The depth fixture therefore loads
 * with the gizmo off, and real structures keep it.
 */
let cameraAxesBaseline: Canvas3D['props']['camera']['helper']['axes'] | undefined;

function applyCameraAxes(): void {
  const canvas = plugin.canvas3d;
  if (canvas == null) return;
  // The acceptance render turns the gizmo off for the whole run, because the
  // marker classifier cannot tell its red, green and blue bars from the three
  // markers. Never switch it back on there.
  if (globalThis.__stereoStructureAcceptanceMode === true) return;
  cameraAxesBaseline ??= canvas.props.camera.helper.axes;
  // An empty stage never shows the gizmo. A fresh Codex panel drew
  // nothing but these three bars floating in each eye, which is the single
  // most misleading thing an empty viewer can put on screen.
  const on = cameraAxesInput.checked && structureLoaded;
  canvas.setProps({
    camera: { helper: { axes: on ? cameraAxesBaseline : { name: 'off', params: {} } } },
  } as Partial<Canvas3D['props']>);
}

/**
 * Reframe the current structure, then hand the camera back to motion.
 *
 * Motion is parked for the whole reset. Rock writes the parent camera on every
 * animation frame from its stored baseline, so a reset that runs alongside it
 * is a tug of war the reset loses; that is exactly how a freshly opened
 * structure used to end up at Mol*'s default 100 Å instead of its fit
 * distance. The depth fixture is re-pinned rather than reframed, because its
 * pose is what the human-evaluation protocol quotes its marker depths from.
 */
async function resetCamera(sessionRequest?: SessionGeneration): Promise<void> {
  const isCurrent = (): boolean => isCurrentSessionWork(sessionRequest);
  if (!isCurrent()) return;
  const previousMotion = motionController?.getSettings();
  const fitSuspension = fitSuspensions.acquire(sessionRequest);
  try {
    if (!isCurrent()) return;
    motionController?.setSettings({ mode: 'none' }, performance.now());
    if (!isCurrent()) return;
    mouseParallax.clear();
    plugin.canvas3d?.requestCameraReset({ durationMs: 0 });
    if (!isCurrent()) return;
    await settleScene(isCurrent);
    if (!isCurrent()) return;
    if (fixturePinned) {
      await pinFixtureCamera(sessionRequest);
      if (!isCurrent()) return;
    } else {
      fitCameraToStage('reset');
      if (!isCurrent()) return;
    }
    motionController?.captureBaseline();
  } finally {
    fitSuspensions.release(fitSuspension);
    // B owns both its fit-suspension state and motion settings. A must not
    // restore an old motion preset after B has taken the frame mid-reset.
    if (isCurrent()) {
      if (previousMotion != null) motionController?.setSettings(previousMotion, performance.now());
    }
  }
}

/**
 * Acceptance-only: make the three element tags flat, unique RGB swatches that
 * are large enough to centroid.
 *
 * Ball-and-stick draws the fixture markers at Mol*'s default `sizeFactor` of
 * 0.15 x van der Waals radius, about 1.5 CSS px across at 65 Å. That is too
 * few pixels for a sub-pixel centroid, so the balls are grown without changing
 * the representation type. The factor is deliberately modest: the ball radius
 * enters Mol*'s visible bounding sphere, which sets the disparity budget.
 *
 * `shading` selects what the markers are made of. `flat` sets `ignoreLight`,
 * which is what the colour classifier needs: each marker becomes one exact RGB
 * swatch with no shading gradient, so `isMarker` can separate three markers by
 * hue alone. `shipped` leaves lighting on, which is what the viewer draws for
 * a real structure and therefore what the anaglyph luma criterion has to be
 * measured on: a flat swatch is a single Rec.709 luma level, and one level
 * cannot average out the 8-bit rounding the composite is quantised to.
 */
async function setAcceptanceMarkerPresentation(shading: 'flat' | 'shipped' = 'flat'): Promise<void> {
  const update = plugin.state.data.build();
  let changed = false;
  for (const structure of plugin.managers.structure.hierarchy.current.structures) {
    for (const component of structure.components) {
      for (const representation of component.representations) {
        update.to(representation.cell).update((params) => {
          const typed = params as { type: { params: Record<string, unknown> } };
          const next: Record<string, unknown> = { ...typed.type.params, ignoreLight: shading === 'flat' };
          if ('sizeFactor' in next) next.sizeFactor = DEPTH_FIXTURE_SIZE_FACTOR;
          if ('sizeAspectRatio' in next) next.sizeAspectRatio = 1;
          // Mol* draws spheres as ray-cast impostors that shade from
          // `gl_FragCoord`, so the same sphere at two different absolute
          // framebuffer offsets rounds differently and its anti-aliased edge
          // lands on a slightly different set of pixels in each eye viewport.
          // Tessellated meshes share one set of normalised device coordinates
          // and rasterise identically at any integer viewport origin, which is
          // what makes a zero-baseline pair pixel-identical.
          if ('tryUseImpostor' in next) next.tryUseImpostor = false;
          if ('detail' in next) next.detail = 3;
          typed.type.params = next;
        });
        changed = true;
      }
    }
  }
  if (changed) await update.commit({ canUndo: false });
}

/**
 * Enlarge the depth-fixture markers for a human observer, and nothing else.
 *
 * This is deliberately a much smaller change than the pixel gate's acceptance
 * presentation: lighting, sphere impostors, antialiasing, fog and the camera
 * helper all stay at their normal settings, because the observer is judging
 * the shipped rendering. Only the marker radius changes, and only for this
 * fixture. Real structures keep their normal representation.
 */
async function setDepthFixturePresentation(
  sessionRequest?: SessionGeneration,
  isCurrent: SessionWorkGuard = () => isCurrentSessionWork(sessionRequest),
): Promise<void> {
  if (!isCurrent()) return;
  const update = plugin.state.data.build();
  let changed = false;
  for (const structure of plugin.managers.structure.hierarchy.current.structures) {
    for (const component of structure.components) {
      for (const representation of component.representations) {
        update.to(representation.cell).update((params) => {
          const typed = params as { type: { params: Record<string, unknown> } };
          const next: Record<string, unknown> = { ...typed.type.params };
          if ('sizeFactor' in next) next.sizeFactor = DEPTH_FIXTURE_OBSERVER_SIZE_FACTOR;
          if ('sizeAspectRatio' in next) next.sizeAspectRatio = 1;
          typed.type.params = next;
        });
        changed = true;
      }
    }
  }
  if (changed && isCurrent()) {
    await update.commit({ canUndo: false });
    if (!isCurrent()) return;
  }
}

/**
 * Put the camera on the pose the human-evaluation protocol specifies.
 *
 * The fixture's quoted marker depths of 45, 65 and 85 Å are only true from
 * (0, 0, 65) looking at the origin, and the predicted disparities in the
 * readout are derived from that distance. Mol* resolves the load's camera
 * reset inside its draw loop, so the pose has to be reapplied until that reset
 * has run.
 */
async function pinFixtureCamera(sessionRequest?: SessionGeneration): Promise<void> {
  const camera = plugin.canvas3d?.camera;
  if (camera == null) return;
  const position = Vec3.create(0, 0, DEPTH_FIXTURE_CAMERA_Z);
  const target = Vec3.create(0, 0, 0);
  for (let attempt = 0; attempt < 120; attempt++) {
    if (sessionRequest != null && !sessionGuard.isCurrent(sessionRequest)) return;
    camera.setState({ position, target }, 0);
    await nextFrame();
    if (sessionRequest != null && !sessionGuard.isCurrent(sessionRequest)) return;
    if (!camera.transition.inTransition
      && Vec3.exactEquals(camera.state.position, position)
      && Vec3.exactEquals(camera.state.target, target)) break;
  }
}


/**
 * Load the fixture on the pose the human-evaluation protocol specifies.
 *
 * Rock writes the parent camera on every animation frame from a stored
 * baseline pose, so pinning the camera while it runs is a tug of war the pin
 * cannot win: holding the oscillator freezes its phase but not its writes.
 * Motion is therefore switched off around the pin and restored afterwards.
 * `MotionController.setSettings` restores its baseline pose before changing
 * mode, so this order leaves the restored rock centred on the pinned pose.
 */
async function loadDepthFixtureNow(
  source: StructureSource = 'local',
  sessionRequest?: SessionGeneration,
): Promise<StructureLoadResult> {
  const isCurrent = (): boolean => sessionRequest == null || sessionGuard.isCurrent(sessionRequest);
  if (!isCurrent()) return 'stale';
  const previousMotion = motionController?.getSettings();
  motionController?.setSettings({ mode: 'none' }, performance.now());
  try {
    const load = await loadStructureNow(DEPTH_FIXTURE_PDB, 'pdb', `${DEPTH_FIXTURE_ID} fixture`, {
      cameraAxes: false,
      fit: false,
      pinnedCamera: true,
      restoreMotion: false,
      depthFixture: true,
      source,
      sessionRequest,
    });
    if (load !== 'loaded') return load;
    if (!isCurrent()) return 'stale';
    await setDepthFixturePresentation(sessionRequest);
    if (!isCurrent()) return 'stale';
    await pinFixtureCamera(sessionRequest);
    if (!isCurrent()) return 'stale';
    motionController?.captureBaseline();
    notify('Depth fixture loaded: camera pinned at (0, 0, 65); markers at 45, 65 and 85 Å depth. Camera axes hidden so the fixture has no screen-plane anchor.');
    return 'loaded';
  } catch (error) {
    if (!isCurrent()) return 'stale';
    notify(`Depth fixture load failed: ${error instanceof Error ? error.message : 'unknown error'}`, 'error');
    showStructureDisplayFailure();
    return 'failed';
  } finally {
    if (isCurrent() && previousMotion != null && previousMotion.mode !== 'none') {
      motionController?.setSettings(previousMotion, performance.now());
    }
  }
}

function nextFrame(): Promise<void> {
  return new Promise<void>((resolveFrame) => requestAnimationFrame(() => resolveFrame()));
}

/**
 * Mol*'s own antialiasing setting, captured before the acceptance render turns
 * it off, so the luma capture can put the shipped pass back with its real
 * parameters rather than a guessed parameter object.
 */
let shippedAntialiasing: Canvas3D['props']['postprocessing']['antialiasing']['params'] = {};

function installAcceptanceHook(): void {
  if (globalThis.__stereoStructureAcceptanceMode !== true) return;
  const antialiasing = plugin.canvas3d?.props.postprocessing.antialiasing;
  if (antialiasing?.name === 'smaa') shippedAntialiasing = antialiasing.params;
  // A canvas screenshot must contain rendered scene pixels only.
  // `CameraHelperParams.axes` defaults to 'on' and paints red, green and blue
  // bars in the bottom-left of every eye viewport
  // (`mol-canvas3d/helper/camera-helper.js:26-56`); the marker classifier
  // cannot tell those apart from the fixture markers. The DOM readout is
  // absolutely positioned over the stage and covers one half only, so it also
  // breaks any left-half against right-half comparison.
  // Mol* defaults to `multiSample.mode = 'temporal'` and
  // `postprocessing.antialiasing = 'smaa'`. Both are full-frame screen-space
  // passes: temporal multisampling jitters the projection and accumulates over
  // an unbounded number of frames, so a screenshot is not reproducible, and
  // both read neighbouring texels at absolute framebuffer coordinates, so the
  // same geometry rendered into the left and the right half of one frame
  // resolves to different edge pixels. Neither pass carries geometry, so the
  // acceptance render turns them off.
  // Depth fog tints every fragment by its interpolated depth. That depth is
  // interpolated in window space, so the same marker rasterised at two
  // different framebuffer offsets rounds to colours one 8-bit unit apart, and
  // the cross-eyed viewport exchange is no longer pixel-exact. Fog is a depth
  // cue, not geometry, so the acceptance render drops it too.
  plugin.canvas3d?.setProps({
    camera: { helper: { axes: { name: 'off', params: {} } } },
    multiSample: { mode: 'off' },
    postprocessing: { antialiasing: { name: 'off', params: {} } },
    cameraFog: { name: 'off', params: {} },
  } as Partial<Canvas3D['props']>);
  // These are now the baseline the per-mode rules restore to.
  resetPassBaseline();
  overlay.style.display = 'none';
  // Give the acceptance render a stage whose page offset and size are whole
  // numbers and do not depend on the control layout.
  //
  // Playwright clips an element screenshot at integer page coordinates. The
  // header and the control deck have fractional rem heights, so the canvas
  // used to start at a fractional y; the clip then began one row early and the
  // captured image was the drawing buffer resampled half a pixel down. That is
  // invisible until a marker centroid is compared against a projected centre,
  // at which point every measurement is off by about one pixel and the gate
  // fails for a reason that has nothing to do with stereo geometry. It also
  // made the gate hostage to any future change in the control deck's height.
  // The chrome carries no scene pixels, so the acceptance render drops it.
  element<HTMLElement>('.toolbar').style.display = 'none';
  element<HTMLElement>('.viewer-bay').style.padding = '0';
  setDrawerOpen(false);
  notice.style.display = 'none';
  letterbox.style.border = '0';
  letterbox.style.borderRadius = '0';
  window.__stereoStructureAcceptance = {
    load: async (text) => {
      // The acceptance render's stimulus is the same three markers, so it takes
      // the same fixture colour theme; only the geometry presentation differs.
      await loadStructure(text, 'pdb', 'three-depth-marker fixture', { depthFixture: true });
      await setAcceptanceMarkerPresentation();
    },
    loadShipped: async (text, format = 'pdb') => {
      await loadStructure(text, format, 'probe structure');
    },
    refit: () => fitCameraToStage('button'),
    setMode: (next, depthBudgetArcmin = 20, swapEyes = false) => setMode(next, { depthBudgetArcmin, swapEyes }),
    setGlasses: (next) => {
      glasses = next;
      glassesSelect.value = next;
      setAnaglyphThemeGlasses(next, variant);
      controller?.update();
      if (mode === 'anaglyph') void setAnaglyphPresentation(true);
    },
    setLook: async (next) => {
      await setLook(next);
      await nextFrame();
    },
    setVariant: (next) => {
      variant = next;
      variantSelect.value = next;
      setAnaglyphThemeGlasses(glasses, next);
      controller?.update();
      if (mode === 'anaglyph') void setAnaglyphPresentation(true);
    },
    setMarkerShading: async (shading) => {
      await setAcceptanceMarkerPresentation(shading);
    },
    setPasses: (passes) => {
      // The luma criterion is a statement about what the two filters receive
      // from the shipped render, so it is measured with Mol*'s own passes on.
      // The geometry assertions need the opposite: no screen-space pass that
      // reads neighbouring texels at an absolute framebuffer coordinate, and
      // no accumulation over an unbounded number of frames.
      plugin.canvas3d?.setProps({
        multiSample: { mode: passes.multiSample ? 'temporal' : 'off' },
        postprocessing: {
          antialiasing: passes.antialiasing ? { name: 'smaa', params: shippedAntialiasing } : { name: 'off', params: {} },
        },
      } as Partial<Canvas3D['props']>);
    },
    setCamera: async (position, target) => {
      const camera = plugin.canvas3d?.camera;
      if (camera == null) throw new Error('Mol* camera unavailable to acceptance hook.');
      setMotion({ mode: 'none' });
      const wantedPosition = Vec3.create(...position);
      const wantedTarget = Vec3.create(...target);
      // Mol* routes every camera write through CameraTransitionManager, and a
      // camera reset queued by the structure load is only resolved inside the
      // draw loop (`mol-canvas3d/canvas3d.js:681-707`). A single setState is
      // therefore either overwritten by that reset or blended into a running
      // transition, which silently moves the acceptance camera off the pose
      // the test asked for. Reapply until the transition settles on it.
      for (let attempt = 0; attempt < 600; attempt++) {
        camera.setState({ position: wantedPosition, target: wantedTarget }, 0);
        await nextFrame();
        if (!camera.transition.inTransition
          && Vec3.exactEquals(camera.state.position, wantedPosition)
          && Vec3.exactEquals(camera.state.target, wantedTarget)) break;
      }
      controller?.update();
    },
    setDensity: (cssPxPerInch, devicePixelRatio) => {
      densityEstimated = cssPxPerInch === 96;
      densityInput.value = cssPxPerInch.toFixed(1);
      updateDensityNote();
      controller?.setSettings({ cssPxPerInch, devicePixelRatio });
    },
    state: () => ({
      mode,
      params: controller?.getParams(),
      camera: readCamera(),
      stageWidth: stage.getBoundingClientRect().width,
      webgl2: plugin.canvas3d?.webgl.isWebGL2 === true,
      variant,
      glasses,
      passes: {
        antialiasing: plugin.canvas3d?.props.postprocessing.antialiasing.name ?? 'unknown',
        multiSample: plugin.canvas3d?.props.multiSample.mode ?? 'unknown',
      },
      pose: readCameraPose(),
      look: {
        color: lookColor,
        style: lookStyle,
        appliedColorTheme,
        plddtApplicable: plddtApplicable(),
        disabled: colorSelect.disabled && styleSelect.disabled,
        // Read back out of Mol*'s own state tree, so a measurement can tell an
        // applied theme from an intended one.
        representations: plugin.managers.structure.hierarchy.current.structures
          .flatMap((structure) => structure.components)
          .flatMap((component) => component.representations)
          .map((representation) => {
            const params = representation.cell.transform.params as {
              type?: { name?: string; params?: { ignoreLight?: boolean } };
              colorTheme?: { name?: string };
            } | undefined;
            return {
              type: params?.type?.name ?? 'unknown',
              colorTheme: params?.colorTheme?.name ?? 'unknown',
              ...(params?.type?.params?.ignoreLight == null ? {} : { ignoreLight: params.type.params.ignoreLight }),
              tags: representationTags(representation),
            };
          }),
      },
    }),
  };
}

/**
 * Load coordinates, then take the camera to a framing a person can read.
 *
 * Motion is parked across the whole load. `MotionController.tick` writes the
 * parent camera position on every animation frame, rotating its stored
 * baseline pose about the stored baseline target, so while rock is running it
 * is the last writer of the camera in every frame and Mol*'s camera reset
 * never survives. Parking motion, waiting for the scene commit, fitting, and
 * only then capturing the baseline is what makes the reset stick.
 */
/**
 * Loads run one at a time, in the order they were asked for.
 *
 * Two loads can now be asked for at once: the fresh-panel fallback and a tool
 * result that arrives while it is running. `loadStructureNow` starts with
 * `plugin.clear()` and then builds a trajectory across many awaits, so two of
 * them interleaved would have one clearing the scene the other is building.
 * Every caller goes through the queue; only the fixture's own internals call
 * the unqueued form, from inside a slot the queue already holds.
 */
const loadQueue = createGuardedSerialQueue();

/** The outcome a caller needs before it may treat hydration as complete. */
type StructureLoadResult = 'loaded' | 'failed' | 'stale';

function queueLoad(
  run: (isCurrent: SessionWorkGuard) => Promise<void>,
  shouldRun: SessionWorkGuard = () => true,
): Promise<void> {
  return loadQueue.enqueue(run, shouldRun);
}

function loadStructure(
  text: string,
  format: 'pdb' | 'mmcif',
  label: string,
  options: Parameters<typeof loadStructureNow>[3] = {},
): Promise<StructureLoadResult> {
  const request = options.sessionRequest;
  let result: StructureLoadResult = 'stale';
  return queueLoad(
    async () => { result = await loadStructureNow(text, format, label, options); },
    () => request == null || sessionGuard.isCurrent(request),
  ).then(() => result, () => 'failed');
}

function loadDepthFixture(
  source: StructureSource = 'local',
  sessionRequest?: SessionGeneration,
): Promise<StructureLoadResult> {
  let result: StructureLoadResult = 'stale';
  return queueLoad(
    async () => { result = await loadDepthFixtureNow(source, sessionRequest); },
    () => sessionRequest == null || sessionGuard.isCurrent(sessionRequest),
  ).then(() => result, () => 'failed');
}

async function loadStructureNow(
  text: string,
  format: 'pdb' | 'mmcif',
  label: string,
  options: {
    cameraAxes?: boolean;
    /** False when the caller pins its own camera pose after the load. */
    fit?: boolean;
    /** True when that pinned pose must survive later mode and size changes. */
    pinnedCamera?: boolean;
    /** False when the caller restores motion itself, after its own pin. */
    restoreMotion?: boolean;
    /**
     * True for the three-marker depth fixture, whose element colours are its
     * stimulus. It keeps its own colour theme and turns the Look group off.
     */
    depthFixture?: boolean;
    /** What the fit this load performs is called in the diagnostics ring. */
    fitTrigger?: FitTrigger;
    /** How this structure reached the panel, for `diagnostics.state`. */
    source?: StructureSource;
    /** The RCSB id, when the coordinates came from one. */
    pdbId?: string;
    /** Async open/load ownership; stale queued loads are discarded. */
    sessionRequest?: SessionGeneration;
  } = {},
): Promise<StructureLoadResult> {
  const isCurrent = (): boolean => options.sessionRequest == null || sessionGuard.isCurrent(options.sessionRequest);
  if (!isCurrent()) return 'stale';
  const previousMotion = motionController?.getSettings();
  reportDiagnostics('loadstart');
  const fitSuspension = fitSuspensions.acquire(options.sessionRequest);
  loadInFlight = true;
  fixturePinned = options.pinnedCamera === true;
  depthFixtureLoaded = options.depthFixture === true;
  updateLookControls();
  try {
    motionController?.setSettings({ mode: 'none' }, performance.now());
    // A stage that belonged to an older request must not satisfy this load's
    // success check if clear/parse subsequently fails.
    loadedStructureRequest = undefined;
    await plugin.clear();
    if (!isCurrent()) return 'stale';
    // `plugin.clear()` has removed the previous scene. Drop its bookkeeping at
    // the same boundary so a parse failure cannot leave diagnostics/fallbacks
    // claiming that the old structure is still what this panel displays.
    structureLoaded = false;
    structureSource = 'none';
    lastLoadedPdbId = undefined;
    cameraAxesInput.checked = options.cameraAxes ?? true;
    applyCameraAxes();
    const data = await plugin.builders.data.rawData({ data: text, label });
    if (!isCurrent()) return 'stale';
    const trajectory = await plugin.builders.structure.parseTrajectory(data, format);
    if (!isCurrent()) return 'stale';
    await plugin.builders.structure.hierarchy.applyPreset(trajectory, 'default', { representationPreset: lookStyle });
    if (!isCurrent()) return 'stale';
    // This load is already executing inside `queueLoad`; use the unqueued
    // implementation so presentation cannot wait behind its own queue slot.
    await setAnaglyphPresentationNow(mode === 'anaglyph', isCurrent);
    if (!isCurrent()) return 'stale';
    // The reset is instant because it is only a starting point: this viewer
    // reframes the result itself, the acceptance run and the depth fixture pin
    // their own pose, and an animated reset would still be interpolating while
    // any of those runs. Resetting instantly also leaves a non-zero
    // `radiusMax`, so `shouldResetCamera` does not queue a second reset behind
    // the pin.
    plugin.canvas3d?.requestCameraReset({ durationMs: 0 });
    if (options.fit !== false) {
      await settleScene(isCurrent);
      if (!isCurrent()) return 'stale';
      fitCameraToStage(options.fitTrigger ?? 'load');
      // Second chance: if a late commit still queued a reset of its own, it has
      // resolved by now and this puts the framing back.
      //
      // It is a guard, not a second framing. `settleScene` waits for the
      // visible sphere to hold still for eight frames with no camera
      // transition, so in every measured run the camera is still exactly where
      // the first fit put it and this call has nothing to do. It therefore
      // writes nothing and records nothing unless the camera actually moved,
      // which is what makes the fit ring read one event per load instead of
      // two identical ones. When Mol* really does reset late, the second event
      // appears — and that is then a fact worth seeing.
      await nextFrame();
      if (!isCurrent()) return 'stale';
      await nextFrame();
      if (!isCurrent()) return 'stale';
      fitCameraToStage(options.fitTrigger ?? 'load', { onlyWhenMoved: true });
    }
    if (!isCurrent()) return 'stale';
    motionController?.captureBaseline();
    // The stage now has something in it: the empty state comes down and the
    // camera-axes gizmo is allowed back under the drawer's own checkbox.
    structureLoaded = true;
    loadedStructureRequest = options.sessionRequest;
    structureSource = options.source ?? 'local';
    lastLoadedPdbId = options.pdbId;
    setEmptyStateVisible(false);
    applyCameraAxes();
    notify(`Loaded ${label}. ${lookStyleLabel(lookStyle)}, coloured by ${lookColorLabel(lookColor).toLowerCase()}.`);
    return 'loaded';
  } catch (error) {
    if (!isCurrent()) return 'stale';
    notify(`Structure load failed: ${error instanceof Error ? error.message : 'unknown error'}`, 'error');
    showStructureDisplayFailure();
    return 'failed';
  } finally {
    loadInFlight = false;
    fitSuspensions.release(fitSuspension);
    if (isCurrent() && options.restoreMotion !== false && previousMotion != null) {
      motionController?.setSettings(previousMotion, performance.now());
    }
    if (isCurrent()) reportDiagnostics('loadend');
  }
}

/**
 * Adopt a colour and a style and redraw what is already on the stage.
 *
 * A colour change never touches the camera: `updateRepresentationsTheme`
 * rewrites the representation params and nothing else, and the refit key
 * (eye viewport size and scene radius) does not move. A style change may move
 * the radius, and the existing refit picks that up on the next frame.
 *
 * The work is queued behind any load in flight, because `loadStructureNow`
 * clears the plugin and rebuilds the hierarchy across many awaits, and a
 * preset applied into the middle of that would address cells that are being
 * replaced.
 */
async function setLookNow(
  input: {
    styleChanged: boolean;
    style: LookStyle;
    anaglyph: boolean;
    theme: ColorThemeSnapshot;
    sessionRequest?: SessionGeneration;
  },
  isCurrent: SessionWorkGuard,
): Promise<void> {
  if (!isCurrent()) return;
  try {
    if (input.styleChanged) {
      await applyStylePreset(input.style, isCurrent);
      if (!isCurrent()) return;
    }
    await applyColorTheme(input.anaglyph, isCurrent, input.theme);
    if (!isCurrent()) return;
    // A new preset draws new geometry, so the fixture's enlarged markers and
    // the load-time pin have to be reasserted. The fixture disables this
    // control, so this only guards a tool call that arrives while it is up.
    if (input.theme.depthFixture && input.styleChanged) {
      await setDepthFixturePresentation(input.sessionRequest, isCurrent);
      if (!isCurrent()) return;
    }
  } catch (error) {
    // A rejected/failed A update must not toast over a panel that B now owns.
    if (!isCurrent()) return;
    notify(`Look change failed: ${error instanceof Error ? error.message : 'unknown error'}`, 'error');
  }
}

function setLook(
  next: { color?: LookColor; style?: LookStyle },
  sessionRequest?: SessionGeneration,
): Promise<void> {
  if (!isCurrentSessionWork(sessionRequest)) return Promise.resolve();
  const styleChanged = next.style != null && next.style !== lookStyle;
  if (next.color != null) lookColor = next.color;
  if (next.style != null) lookStyle = next.style;
  colorSelect.value = lookColor;
  styleSelect.value = lookStyle;
  const input = {
    styleChanged,
    style: lookStyle,
    anaglyph: mode === 'anaglyph',
    theme: currentColorThemeSnapshot(),
    ...(sessionRequest == null ? {} : { sessionRequest }),
  };
  return queueLoad(
    (isCurrent) => setLookNow(input, isCurrent),
    () => isCurrentSessionWork(sessionRequest),
  );
}

/**
 * Take the stereo view state out of a tool payload and put it in force now.
 *
 * Called *before* a load, never after, and that ordering is the whole point.
 * `fitCameraToStage` measures one eye's viewport, which is half of a capped
 * stage in a pair and the whole stage in mono, so a load that fits before the
 * mode has arrived frames the structure for the wrong viewport. On Codex's
 * side panel that is a 878 CSS px viewport standing in for a 238 CSS px one:
 * 3.7x too close, clipped at every eye-window edge, which is what the
 * photographs showed. Applying it afterwards would be worse than useless, because
 * `setMode` runs its refit synchronously through `StereoController.setSettings`
 * and would land inside the load's own suspension.
 */
function adoptStereoState(payload: unknown, sessionRequest?: SessionGeneration): void {
  if (!isCurrentSessionWork(sessionRequest)) return;
  const patch = pickStereoState(payload);
  if (isEmptyStereoState(patch)) return;
  setMode(patch.mode ?? mode, patch, sessionRequest);
}

/**
 * Take the colour and style out of a tool payload, if it carries either.
 *
 * `apply: false` is for the load path, where the choice must be in place
 * before the preset is applied and applying it a second time to the structure
 * being replaced would be wasted work.
 */
function adoptLook(
  message: ViewerMessage,
  options: { apply: boolean; sessionRequest?: SessionGeneration },
): void {
  if (!isCurrentSessionWork(options.sessionRequest)) return;
  if (message.color == null && message.style == null) return;
  if (options.apply) {
    void setLook({ color: message.color, style: message.style }, options.sessionRequest);
    return;
  }
  if (message.color != null) lookColor = message.color;
  if (message.style != null) lookStyle = message.style;
  colorSelect.value = lookColor;
  styleSelect.value = lookStyle;
}

/**
 * The Look group is off while the depth fixture is loaded.
 *
 * The fixture's marker colours and enlarged radii are the stimulus the human
 * evaluation measures, so a recolour or a restyle there would invalidate a
 * trial without saying so.
 */
function updateLookControls(): void {
  const disabled = depthFixtureLoaded;
  const reason = 'Depth test uses its own marker colours';
  colorSelect.disabled = disabled;
  styleSelect.disabled = disabled;
  if (disabled) {
    lookGroup.setAttribute('aria-disabled', 'true');
    lookGroup.title = reason;
    colorSelect.title = reason;
    styleSelect.title = reason;
  } else {
    lookGroup.removeAttribute('aria-disabled');
    lookGroup.removeAttribute('title');
    colorSelect.removeAttribute('title');
    styleSelect.removeAttribute('title');
  }
}

function setMode(
  next: StereoMode,
  options: Partial<Pick<ViewerMessage, 'depthBudgetArcmin' | 'swapEyes' | 'variant'>> = {},
  sessionRequest?: SessionGeneration,
): Promise<void> {
  if (!isCurrentSessionWork(sessionRequest)) return Promise.resolve();
  mode = next;
  if (options.depthBudgetArcmin != null) depthInput.value = String(options.depthBudgetArcmin);
  if (options.swapEyes != null) swapInput.checked = options.swapEyes;
  if (options.variant != null) {
    variant = options.variant;
    variantSelect.value = options.variant;
    setAnaglyphThemeGlasses(glasses, variant);
  }
  // `setSettings` runs the readout and the refit decision synchronously, so a
  // fit inside this call is this mode change and a fit after it is not.
  withFitTrigger('mode', () => {
    controller?.setSettings({
      mode,
      depthBudgetArcmin: Number(depthInput.value),
      swapEyes: swapInput.checked,
    });
  });
  const presentation = setAnaglyphPresentation(mode === 'anaglyph', sessionRequest).catch((error: unknown) => {
    if (!isCurrentSessionWork(sessionRequest)) return;
    notify(`Anaglyph palette update failed: ${error instanceof Error ? error.message : 'unknown error'}`, 'error');
  });
  updateModeButtons();
  reportDiagnostics('mode');
  return presentation;
}

function structured(result: unknown): ViewerMessage | undefined {
  return structuredToolContent<ViewerMessage>(result);
}

function messageSessionId(message: ViewerMessage | undefined): string | undefined {
  if (typeof message?.sessionId !== 'string' || message.sessionId.trim().length === 0) return undefined;
  return message.sessionId;
}

function messageRenderToken(message: ViewerMessage | undefined): number | undefined {
  return isRenderToken(message?.renderToken) ? message.renderToken : undefined;
}

function messageServerEpoch(message: { serverEpoch?: unknown } | undefined): string | undefined {
  return isServerEpoch(message?.serverEpoch) ? message.serverEpoch : undefined;
}

function messageStateRevision(message: { stateRevision?: unknown } | undefined): number | undefined {
  return isStateRevision(message?.stateRevision) ? message.stateRevision : undefined;
}

/**
 * Admit a server snapshot only when it advances this session’s safe state.
 * Equal revisions are duplicate deliveries and deliberately do nothing: that
 * is what keeps an older delayed sync_view notification from repainting the
 * local controls after its direct response has already been acknowledged.
 */
function acceptStateSnapshot(
  message: { stateRevision?: unknown; serverEpoch?: unknown } | undefined,
  sessionRequest?: SessionGeneration,
  options: { allowEqual?: boolean } = {},
): boolean {
  if (!isCurrentSessionWork(sessionRequest)) return false;
  const revision = messageStateRevision(message);
  const serverEpoch = messageServerEpoch(message);
  if (revision == null || serverEpoch == null) return false;
  if (sessionGuard.acceptStateRevision(revision, serverEpoch)) return true;
  return options.allowEqual === true
    && sessionGuard.serverEpoch === serverEpoch
    && sessionGuard.stateRevision === revision;
}

/** Apply app-only cached view state only if its revision is safe for this frame. */
function adoptCachedState(
  cached: CachedStructure,
  request: SessionGeneration,
  options: { allowEqual?: boolean; persistReducedOverride?: boolean } = {},
): boolean {
  if (!acceptStateSnapshot(cached, request, { allowEqual: options.allowEqual })) return false;
  adoptStereoState(cached, request);
  adoptLook({ color: cached.color, style: cached.style }, { apply: false, sessionRequest: request });
  if (cached.motion != null) adoptMotion(cached.motion, { persistReducedOverride: options.persistReducedOverride });
  return true;
}

/**
 * Call a tool against the session that mounted this frame.
 *
 * A resolved `callServerTool` promise is not necessarily a success: MCP tool
 * errors are regular results carrying `isError: true`. Both that case and a
 * rejected bridge request are normalized here so user actions cannot silently
 * leave the local controls ahead of the server.
 */
async function callSessionTool(
  name: string,
  arguments_: Record<string, unknown>,
  options: { failureLabel: string; quiet?: boolean; request?: SessionGeneration },
): Promise<unknown | undefined> {
  if (options.request != null && !sessionGuard.isCurrent(options.request)) return undefined;
  const scopedArguments = sessionToolArguments(sessionGuard.sessionId, arguments_);
  if (scopedArguments == null) {
    if (options.quiet !== true) notify(`${options.failureLabel} failed: this viewer is not attached to a session yet.`, 'error');
    return undefined;
  }
  try {
    const result = await app.callServerTool({
      name,
      arguments: scopedArguments,
    });
    if (options.request != null && !sessionGuard.isCurrent(options.request)) return undefined;
    const failure = toolResultError(result);
    if (failure != null) {
      if (options.quiet !== true) notify(`${options.failureLabel} failed: ${failure}`, 'error');
      else console.warn(`[Stereofold] ${options.failureLabel} failed: ${failure}`);
      return undefined;
    }
    return result;
  } catch (error) {
    if (options.request != null && !sessionGuard.isCurrent(options.request)) return undefined;
    if (options.quiet !== true) notify(`${options.failureLabel} failed: ${thrownErrorMessage(error)}`, 'error');
    else console.warn(`[Stereofold] ${options.failureLabel} failed: ${thrownErrorMessage(error)}`);
    return undefined;
  }
}

async function applyMessage(
  message: ViewerMessage,
  sessionRequest?: SessionGeneration,
  options: { allowEqualStateRevision?: boolean; applyView?: boolean } = {},
): Promise<void> {
  if (sessionRequest != null && !sessionGuard.isCurrent(sessionRequest)) return;
  // Counted before anything is applied, so the count is of what arrived rather
  // than of what this panel managed to act on.
  if (message.kind === 'open') messageCounts.open += 1;
  if (message.kind === 'state') messageCounts.state += 1;
  if (message.kind === 'mode') messageCounts.mode += 1;
  // Every result that can affect rendering carries the session’s freshness
  // revision. Keep coordinate ownership (renderToken) separate: a delayed
  // open may still hydrate the current cache, but its old mode/look/motion
  // snapshot must not roll back a newer same-session result.
  if (!acceptStateSnapshot(message, sessionRequest, { allowEqual: options.allowEqualStateRevision })) return;
  if (message.kind === 'open' || (message.kind === 'control' && message.action === 'load_pdb')) {
    // The stereo state and the look are both adopted before the load: the
    // state so the very first fit measures the eye viewport the render will
    // actually use, the look so the structure is built from the right preset
    // on its first commit rather than being restyled after it is on screen.
    adoptStereoState(message, sessionRequest);
    adoptLook(message, { apply: false, sessionRequest });
    if (message.motion != null) adoptMotion(message.motion);
    // Coordinates are never accepted from a model-visible result. The
    // matching app-only get_structure result carries them only in private
    // metadata, which hydrateLatestStructure reads below.
  }
  if (message.kind === 'control') {
    // reset_camera/fit are one-shot model actions. The server queues them on
    // the next `open` result, where `replayOpenAction` runs only after matching
    // coordinates are ready; acting on a reused control result here would make
    // the same action run twice.
    if ((message.action === 'set_motion' || message.action === 'pause_motion') && message.motion != null) adoptMotion(message.motion);
    if (message.action === 'set_look') adoptLook(message, { apply: true, sessionRequest });
  }
  if (message.kind === 'mode' && message.mode != null) setMode(message.mode, message, sessionRequest);
  if (message.kind === 'motion' && message.motion != null) adoptMotion(message.motion);
  if (message.kind === 'view' && options.applyView === true) {
    if (message.mode != null) setMode(message.mode, message, sessionRequest);
    if (message.motion != null) adoptMotion(message.motion);
    adoptLook(message, { apply: true, sessionRequest });
  }
  if (message.kind === 'state') {
    if (message.mode != null) setMode(message.mode, message, sessionRequest);
    if (message.motion != null) adoptMotion(message.motion);
    adoptLook(message, { apply: true, sessionRequest });
    const settings = controller?.getSettings();
    if (settings != null) notify(`State: ${settings.mode}, depth ${settings.depthBudgetArcmin}′, swap ${settings.swapEyes ? 'on' : 'off'}, motion ${message.motion?.mode ?? 'none'}.`);
  }
}

/* --------------------------------------------------------- view-state sync */

/**
 * How long the panel waits for the person to stop moving a control.
 *
 * The Depth slider fires an `input` event per pixel of drag, and the state
 * write is only interesting once the drag stops. 250 ms is short enough that a
 * `get_state` right after a release reports the new value and long enough that
 * a full-width drag sends once.
 */
const SYNC_VIEW_DEBOUNCE_MS = 250;

function currentViewState(): Record<string, unknown> {
  const motion = motionController?.getSettings();
  return {
    mode,
    depthBudgetArcmin: Number(depthInput.value),
    swapEyes: swapInput.checked,
    variant,
    color: lookColor,
    style: lookStyle,
    ...(motion == null ? {} : { motion }),
  };
}

const syncRecoveryInFlight = new Set<number>();

async function restoreViewStateFromSession(request: SessionGeneration): Promise<void> {
  if (!sessionGuard.isCurrent(request) || request.sessionId == null) return;
  if (syncRecoveryInFlight.has(request.generation)) return;
  syncRecoveryInFlight.add(request.generation);
  try {
    const response = await callSessionTool(
      'stereo_structure.get_structure',
      {},
      { failureLabel: 'View-state recovery', quiet: true, request },
    );
    if (!sessionGuard.isCurrent(request)) return;
    const cached = cachedStructure(response);
    if (cached == null) {
      notify('View settings were not saved, and the server state could not be restored.', 'error');
      return;
    }
    if (!adoptCachedState(cached, request, { allowEqual: true, persistReducedOverride: false })) return;
    if (cached.color != null || cached.style != null) {
      await setLook({ color: cached.color, style: cached.style }, request);
    }
    if (sessionGuard.isCurrent(request)) {
      notify('View settings were not saved; restored the server settings.', 'error');
    }
  } finally {
    syncRecoveryInFlight.delete(request.generation);
  }
}

async function persistViewState(payload: Record<string, unknown>): Promise<void> {
  const request = sessionGuard.capture();
  const baseStateRevision = sessionGuard.stateRevision;
  const result = await callSessionTool(
    'stereo_structure.sync_view',
    {
      ...payload,
      ...(baseStateRevision == null ? {} : { baseStateRevision }),
    },
    { failureLabel: 'Saving view settings', request },
  );
  if (!sessionGuard.isCurrent(request)) return;
  if (result == null) {
    await restoreViewStateFromSession(request);
    return;
  }
  const message = structured(result);
  if (message?.kind !== 'view') {
    await restoreViewStateFromSession(request);
    return;
  }
  if (message.conflict === true) {
    // The server rejected a delayed full-state payload rather than letting it
    // overwrite a newer model/panel update. Its concise response is the
    // authoritative current snapshot; equal revisions are valid here because
    // recovery deliberately replaces unsaved local control values.
    await applyMessage(message, request, { allowEqualStateRevision: true, applyView: true });
    return;
  }
  // This is our own acknowledged write. Advance freshness, but do not replay
  // its snapshot into the controls: another local gesture may already have
  // happened while this debounced request was on the wire.
  acceptStateSnapshot(message, request);
}

/**
 * Tell the server what this panel is showing, debounced.
 *
 * `stereo_structure.sync_view` names no UI resource, so unlike `set_mode` it
 * cannot mount a fresh Codex panel and is safe to call from a control that
 * fires while it is being dragged. It carries the whole view state on every
 * send, and the state is read when the burst stops rather than when it
 * started, so one call after any control settles leaves the server in step.
 */
const viewSync = createDebouncedSender({
  read: currentViewState,
  send: (payload) => {
    void persistViewState(payload);
  },
  delayMs: SYNC_VIEW_DEBOUNCE_MS,
  timers: {
    set: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clear: (handle) => { window.clearTimeout(handle); },
  },
});

function syncViewState(): void {
  viewSync.request();
}

/* ------------------------------------------------------------- panel size */

/**
 * The last height this app asked the host for, and the width that produced it.
 *
 * Both are the whole anti-thrash mechanism. A size-changed notification is
 * sent only when the *width* has moved, and then only when the height that
 * width implies differs from the one already sent. Applying a height cannot
 * change the width that produced it, so the host's response can never trigger
 * another notification: the loop has no cycle to run round.
 */
let lastSentHeightPx: number | undefined;
let lastMeasuredWidthPx: number | undefined;
let resizeTimer: number | undefined;

/** Debounce for the window resize path, in ms. */
const PANEL_RESIZE_DEBOUNCE_MS = 150;

function panelSizeNow(): { width: number; height: number } {
  const width = Math.round(window.innerWidth);
  const fixedHeight = panelFixedHeight(app.getHostContext()?.containerDimensions);
  return { width, height: desiredPanelHeight({ width, fixedHeight }) };
}

/**
 * Tell the host how tall this card should be.
 *
 * `force` is used exactly once, straight after `connect()`, where there is no
 * previous height to differ from. Every later caller passes false, so a
 * notification is only ever sent when the computed height actually changed:
 * an internal layout change, a drawer open or close, or a mode switch never
 * reaches the host.
 */
function sendPanelSize(force: boolean): void {
  const { width, height } = panelSizeNow();
  lastMeasuredWidthPx = width;
  if (!force && height === lastSentHeightPx) return;
  lastSentHeightPx = height;
  void app.sendSizeChanged({ width, height }).catch((error: unknown) => {
    console.warn(`[Stereofold] Panel resize notification failed: ${thrownErrorMessage(error)}`);
  });
}

function onWindowResize(): void {
  if (resizeTimer !== undefined) window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    resizeTimer = undefined;
    // Height-only changes are the host applying what we asked for, and the
    // iframe's own height moving is not a reason to ask for a new one.
    if (Math.round(window.innerWidth) === lastMeasuredWidthPx) return;
    sendPanelSize(false);
  }, PANEL_RESIZE_DEBOUNCE_MS);
}

/* ------------------------------------------------- display mode / docking */

type DisplayMode = 'inline' | 'fullscreen' | 'pip';

let displayMode: DisplayMode = 'inline';

function hostDisplayModes(): DisplayMode[] {
  const listed = app.getHostContext()?.availableDisplayModes;
  return Array.isArray(listed) ? listed as DisplayMode[] : [];
}

/**
 * The button exists only where the host says fullscreen exists.
 *
 * A host that does not list it — the emulation harness is one — gets no
 * button at all rather than a button whose click does nothing.
 *
 * The label says what the button does rather than what the protocol calls it.
 * In Codex, `fullscreen` is not a full-window overlay: the request moves this
 * webview into a right-hand side-panel tab (`McpAppThreadSidePanelTab`), the
 * inline card collapses to zero height, and the person exits by closing that
 * tab or by this button asking for `inline` again. Docking the viewer
 * beside the conversation is the feature; "Fullscreen" would name the wrong
 * one.
 */
function updateDisplayModeButton(): void {
  const supported = hostDisplayModes().includes('fullscreen');
  displayModeToggle.hidden = !supported;
  if (!supported) return;
  const docked = displayMode === 'fullscreen';
  displayModeToggle.textContent = docked ? 'Back to chat' : 'Open in side panel';
  displayModeToggle.setAttribute('aria-pressed', String(docked));
  displayModeToggle.title = docked
    ? 'Return the viewer to the conversation'
    : "Move the viewer to Codex's side panel";
}

/**
 * Adopt a display mode the host has confirmed, and reframe for the new box.
 *
 * A dock or undock is a resize: Codex fits this webview to the side panel's
 * bounding rectangle, which is a different shape from the inline card. The
 * camera is refit explicitly rather than left to `maybeRefitCamera()`, which
 * runs off the eye viewport's size, because a host is free to change the
 * display mode without changing the panel's pixel size. When the size does
 * also change, both paths run and the fit is idempotent.
 */
function setDisplayMode(next: DisplayMode | undefined): void {
  if (next == null || next === displayMode) {
    updateDisplayModeButton();
    return;
  }
  displayMode = next;
  updateDisplayModeButton();
  reportDiagnostics('displaymode');
  void refitForDisplayMode();
}

async function refitForDisplayMode(): Promise<void> {
  // The host resizes the container on its own schedule, so fitting on the next
  // frame can frame the box the panel is leaving. Wait for the stage to stop
  // moving, with a bounded number of frames so a host that never resizes at
  // all still gets its refit.
  let previous = '';
  let stableFrames = 0;
  for (let frame = 0; frame < 40 && stableFrames < 3; frame++) {
    await nextFrame();
    const box = stage.getBoundingClientRect();
    const key = `${Math.round(box.width)}x${Math.round(box.height)}`;
    stableFrames = key === previous ? stableFrames + 1 : 0;
    previous = key;
  }
  // A load owns the camera while it runs and fits the new box itself.
  if (fitSuspensions.isSuspended()) return;
  if (fixturePinned) {
    await pinFixtureCamera();
    return;
  }
  if (fitCameraToStage('displaymode')) motionController?.captureBaseline();
}

displayModeToggle.addEventListener('click', () => {
  const next: DisplayMode = displayMode === 'fullscreen' ? 'inline' : 'fullscreen';
  void app.requestDisplayMode({ mode: next })
    .then((response) => { setDisplayMode(response.mode); })
    .catch((error: unknown) => {
      notify(`Display-mode change failed: ${thrownErrorMessage(error)}`, 'error');
    });
});

/* ------------------------------------------------- fresh-panel structure */

/** How long a fresh panel waits for a tool result before asking the server. */
const STRUCTURE_FALLBACK_MS = 1_500;
/** Retry gap while a load started elsewhere is still in flight. */
const STRUCTURE_FALLBACK_RETRY_MS = 500;
/** The empty state's own words, restored after an unavailable message. */
const EMPTY_STATE_LEAD = 'Nothing loaded yet.';

let fallbackTimer: number | undefined;
/** True once the fallback has reached a definitive answer, or been cancelled. */
let fallbackDone = false;
/** Request generations with an app-only `get_structure` call in flight. */
const fallbackInFlight = new Set<number>();
/** True while the armed timer is a backoff rather than the first-result wait. */
let fallbackBackoffArmed = false;
/** The retry policy. Pure; this file supplies the clock and runs the delay. */
let fallbackRetry = createFallbackRetry();
let pendingOpenAction: {
  generation: number;
  action: 'reset_camera' | 'fit';
  actionId: string;
} | undefined;

function rememberOpenAction(message: ViewerMessage | undefined, request: SessionGeneration): void {
  if (message?.kind !== 'open') return;
  pendingOpenAction = (message.action === 'reset_camera' || message.action === 'fit')
    && typeof message.actionId === 'string'
    && message.actionId.length > 0
    ? { generation: request.generation, action: message.action, actionId: message.actionId }
    : undefined;
}

/** Claim then replay a model-origin transient only after this open’s structure is ready. */
async function replayOpenAction(request: SessionGeneration): Promise<void> {
  // A loader catches parse failures to keep the Mol* queue live. Do not let
  // that resolved-but-failed promise consume reset/fit: only the request that
  // actually committed the current stage may replay its one-shot action.
  if (!sessionGuard.isCurrent(request)
    || !structureIsLoadedFor(request)
    || pendingOpenAction?.generation !== request.generation) return;
  const pending = pendingOpenAction;
  if (!isRenderToken(request.renderToken)) return;
  const claim = await callSessionTool(
    'stereo_structure.claim_action',
    { actionId: pending.actionId, renderToken: request.renderToken },
    { failureLabel: 'Camera action claim', quiet: true, request },
  );
  if (!sessionGuard.isCurrent(request) || !structureIsLoadedFor(request)) return;
  if (claim == null) return;
  const response = structured(claim);
  const granted = response?.kind === 'action_claim'
    && response.claimed === true
    && response.action === pending.action
    && response.actionId === pending.actionId;
  if (!granted) {
    // Another successfully hydrated panel won the atomic claim, or a newer
    // reset/fit replaced this identity. Do not retry a command the server no
    // longer holds, but leave a transport failure above eligible for a retry.
    if (pendingOpenAction?.generation === pending.generation && pendingOpenAction.actionId === pending.actionId) {
      pendingOpenAction = undefined;
    }
    return;
  }
  const action = pending.action;
  if (action === 'reset_camera') await resetCamera(request);
  else runFit(request);
  // Reset can yield through scene settling and a newer open can take the
  // frame while it runs. Do not clear the server action unless this exact
  // render token still owns a successfully hydrated stage after execution.
  if (!sessionGuard.isCurrent(request) || !structureIsLoadedFor(request)) return;
  const completed = await callSessionTool(
    'stereo_structure.complete_action',
    { actionId: pending.actionId, renderToken: request.renderToken },
    { failureLabel: 'Camera action completion', quiet: true, request },
  );
  if (!sessionGuard.isCurrent(request)) return;
  if (completed == null) return;
  const completion = structured(completed);
  const acknowledged = completion?.kind === 'action_complete'
    && completion.completed === true
    && completion.action === pending.action
    && completion.actionId === pending.actionId;
  if (pendingOpenAction?.generation === pending.generation && pendingOpenAction.actionId === pending.actionId) {
    // A negative acknowledgement means a newer render lease already owns the
    // server action. Its own open will advertise the same/new identity.
    if (acknowledged || completion?.kind === 'action_complete') pendingOpenAction = undefined;
  }
}

function setEmptyStateVisible(visible: boolean): void {
  emptyState.hidden = !visible;
}

/**
 * Say what is on the stage, and never claim more than the panel knows.
 *
 * `empty` is a statement about the session: the server answered and it has
 * never opened anything. `unavailable` is a statement about this panel: it
 * asked five times and never got an answer, which is a different thing and
 * has a different remedy. Conflating the two is a defect,
 * so they are two messages rather than one.
 */
function showEmptyState(kind: 'empty' | 'unavailable'): void {
  const unavailable = kind === 'unavailable';
  emptyStateLead.textContent = unavailable ? FALLBACK_UNAVAILABLE_MESSAGE : EMPTY_STATE_LEAD;
  emptyStateHint.hidden = unavailable;
  setEmptyStateVisible(true);
}

function showStructureDisplayFailure(): void {
  emptyStateLead.textContent = 'The requested structure could not be displayed.';
  emptyStateHint.hidden = true;
  setEmptyStateVisible(true);
}

async function clearStageAfterHydrationFailure(request: SessionGeneration): Promise<void> {
  if (!sessionGuard.isCurrent(request)) return;
  try {
    await queueLoad(async (isCurrent) => {
      if (!isCurrent()) return;
      await plugin.clear();
      // A newer render may have claimed this reused frame while Mol* cleared.
      // Do not let A's failure bookkeeping reset B's stage state afterward.
      if (!isCurrent()) return;
      structureLoaded = false;
      loadedStructureRequest = undefined;
      structureSource = 'none';
      lastLoadedPdbId = undefined;
      fixturePinned = false;
      depthFixtureLoaded = false;
      updateLookControls();
      applyCameraAxes();
    }, () => sessionGuard.isCurrent(request));
  } catch (error) {
    if (sessionGuard.isCurrent(request)) {
      console.warn(`[Stereofold] Could not clear the stale stage: ${thrownErrorMessage(error)}`);
    }
  }
  if (sessionGuard.isCurrent(request)) showStructureDisplayFailure();
}

function clearFallbackTimer(): void {
  if (fallbackTimer !== undefined) window.clearTimeout(fallbackTimer);
  fallbackTimer = undefined;
  fallbackBackoffArmed = false;
}

/** Stop asking, whatever the reason, and report the state that stopped it. */
function finishStructureFallback(): void {
  fallbackDone = true;
  clearFallbackTimer();
  reportDiagnostics('fallback');
}

/** Start a fresh hydration cycle when this mounted frame receives a new open. */
function resetStructureFallback(): void {
  clearFallbackTimer();
  fallbackRetry = createFallbackRetry();
  fallbackDone = false;
  pendingOpenAction = undefined;
}

function scheduleStructureFallback(
  delayMs: number,
  backoff = false,
  request: SessionGeneration = sessionGuard.capture(),
): void {
  if (fallbackDone || !sessionGuard.isCurrent(request)) return;
  if (fallbackTimer !== undefined) window.clearTimeout(fallbackTimer);
  fallbackBackoffArmed = backoff;
  const handle = window.setTimeout(() => {
    // A stale timer must not clear the handle/backoff flag of the generation
    // that replaced it, even if the browser had already queued its callback
    // when `clearTimeout` ran.
    if (fallbackTimer === handle) {
      fallbackTimer = undefined;
      fallbackBackoffArmed = false;
    }
    if (!sessionGuard.isCurrent(request)) return;
    void runStructureFallback(request);
  }, delayMs);
  fallbackTimer = handle;
}

/**
 * Fold one unsuccessful cache/hydration attempt into the bounded retry policy.
 * Returns a cache only when the attempt is definitive; callers deliberately
 * defer recording a loadable cache until Mol* has actually accepted it.
 */
function recordFallbackAttempt(
  input: FallbackAttemptInput,
  request: SessionGeneration,
): CachedStructure | undefined {
  const step = fallbackRetry.record(input, new Date().toISOString());
  if (step.action === 'answer') return step.cached;
  if (step.action === 'retry') {
    // Still asking, so still saying nothing: an empty state shown here would
    // be a claim about the session that this panel cannot make yet.
    setEmptyStateVisible(false);
    scheduleStructureFallback(step.delayMs, true, request);
    reportDiagnostics('fallback');
    return undefined;
  }
  if (step.action === 'exhausted') {
    finishStructureFallback();
    showEmptyState('unavailable');
    return undefined;
  }
  // `cancelled` can only occur when a newer owner/load finished the retry.
  finishStructureFallback();
  return undefined;
}

function cachedStructure(response: unknown): CachedStructure | undefined {
  return privateStructurePayload<CachedStructure>(response);
}

/**
 * Replace the stage from the app-only coordinate cache after a successful
 * server-side load. Model-facing open/control results intentionally carry only
 * concise state, so this is the sole coordinate hydration path for new hosts.
 */
async function hydrateLatestStructure(
  failureLabel: string,
  request: SessionGeneration,
  options: { quiet?: boolean } = {},
): Promise<'hydrated' | 'failed' | 'stale'> {
  if (!sessionGuard.isCurrent(request)) return 'stale';
  const response = await callSessionTool(
    'stereo_structure.get_structure',
    {},
    { failureLabel, quiet: options.quiet, request },
  );
  // The most important check in the whole hydration path: open B may have
  // arrived while A's app-only read was in flight. A no longer owns any state,
  // load, notification or clear operation in that case.
  if (!sessionGuard.isCurrent(request)) return 'stale';
  if (response == null) {
    await clearStageAfterHydrationFailure(request);
    return 'failed';
  }
  const cached = cachedStructure(response);
  if (cached == null) {
    if (options.quiet !== true) notify(`${failureLabel} failed: the server returned no structure data.`, 'error');
    await clearStageAfterHydrationFailure(request);
    return 'failed';
  }
  if (!sessionGuard.isCurrent(request)) return 'stale';
  adoptCachedState(cached, request);
  const decision = decideStructureFallback({ hasStructure: false, cached });
  if (decision.action === 'fixture') {
    const load = await loadDepthFixture('open', request);
    const completion = hydrationLoadCompletion(sessionGuard, request, load === 'loaded' && structureIsLoadedFor(request));
    if (completion === 'failed') await clearStageAfterHydrationFailure(request);
    return completion;
  }
  if (decision.action === 'load') {
    const load = await loadStructure(decision.structureText, decision.format, decision.label, {
      source: 'open',
      sessionRequest: request,
      ...(cached.pdbId == null ? {} : { pdbId: cached.pdbId }),
    });
    const completion = hydrationLoadCompletion(sessionGuard, request, load === 'loaded' && structureIsLoadedFor(request));
    if (completion === 'failed') await clearStageAfterHydrationFailure(request);
    return completion;
  }
  if (options.quiet !== true) {
    notify(
      cached.empty === true
        ? `${failureLabel} failed: the session has no structure to display.`
        : `${failureLabel} failed: the server returned incomplete structure data.`,
      'error',
    );
  }
  await clearStageAfterHydrationFailure(request);
  return 'failed';
}

/**
 * Recover honestly when direct session-cache hydration did not finish.
 *
 * An open-rendered panel asks the server for its session's last structure.
 * When the first app-only read is transiently unavailable this bounded retry
 * asks again; when the session is genuinely empty, the stage says so in words
 * instead of showing a black rectangle with Mol*'s axes gizmo floating in it.
 *
 * The asking is the part that has to survive a bad day. This call is the only
 * way a fresh panel in the real host gets *either* its structure or its stereo
 * mode, and it can fail for reasons that have nothing to do with the session:
 * the host still wiring the app up, a timeout, a rate limit. The previous
 * version marked itself done before the call and turned every failure into
 * "the server has never opened anything", so one bad call left a permanently
 * empty panel in a conversation that had a structure loaded the whole time.
 * Now only a definitive answer ends it, and the empty state stays down until
 * there is one. See `./fallback-retry.ts`.
 */
async function runStructureFallback(request: SessionGeneration = sessionGuard.capture()): Promise<void> {
  if (!sessionGuard.isCurrent(request)) return;
  if (fallbackDone || fallbackInFlight.has(request.generation)) return;
  // A backoff that is already armed is the schedule; a tool result arriving
  // inside it must not spend a try early.
  if (fallbackBackoffArmed) return;
  // A load that is already running owns the stage. Come back once it is done,
  // so a slow structure is never raced by a second load of the same one. This
  // costs no try: nothing was asked.
  if (loadInFlight) {
    scheduleStructureFallback(STRUCTURE_FALLBACK_RETRY_MS, false, request);
    return;
  }
  if (structureIsLoadedFor(request)) {
    fallbackRetry.cancel(new Date().toISOString());
    finishStructureFallback();
    return;
  }
  clearFallbackTimer();
  fallbackInFlight.add(request.generation);
  try {
    let threw = false;
    let cached: CachedStructure | undefined;
    const response = await callSessionTool(
      'stereo_structure.get_structure',
      {},
      { failureLabel: 'Structure hydration', quiet: true, request },
    );
    if (!sessionGuard.isCurrent(request)) return;
    if (response == null) threw = true;
    else cached = cachedStructure(response);
    // An `open` result can arrive while the call is out. That load already
    // owns the stage, and its coordinates are the ones the cache would have
    // returned, so this stops rather than loading the same thing twice.
    if (structureIsLoadedFor(request) || loadInFlight) {
      fallbackRetry.cancel(new Date().toISOString());
      finishStructureFallback();
      return;
    }
    const attempt: FallbackAttemptInput = { threw, cached };
    const classified = classifyFallbackAttempt(attempt);
    // An unavailable/incomplete cache consumes one retry attempt immediately.
    // A seemingly loadable cache does not: it only becomes definitive after
    // Mol* has parsed and committed it below.
    if (classified.kind === 'indefinite') {
      recordFallbackAttempt(attempt, request);
      return;
    }
    const answer = classified.cached;
    // The cache carries the whole view state, not only the coordinates, so a
    // panel recovering from an initial cache miss comes up in the mode, colour
    // and style already in force rather than in this document's defaults. Both
    // are applied before the load: the look so the preset is right on the first
    // commit, the stereo state so the first fit measures the eye viewport the
    // render will use. See `adoptStereoState`.
    adoptCachedState(answer, request);
    const decision = decideStructureFallback({ hasStructure: structureLoaded, cached: answer });
    if (decision.action === 'keep') {
      if (recordFallbackAttempt(attempt, request) != null) finishStructureFallback();
      return;
    }
    if (decision.action === 'empty') {
      if (recordFallbackAttempt(attempt, request) != null) {
        finishStructureFallback();
        showEmptyState('empty');
      }
      return;
    }
    const load = decision.action === 'fixture'
      ? await loadDepthFixture('fallback', request)
      : await loadStructure(decision.structureText, decision.format, decision.label, {
        fitTrigger: 'fallback',
        source: 'fallback',
        sessionRequest: request,
        ...(answer.pdbId == null ? {} : { pdbId: answer.pdbId }),
      });
    if (!sessionGuard.isCurrent(request)) return;
    if (load !== 'loaded' || !structureIsLoadedFor(request)) {
      // The response had coordinates, but a resolved loader can still mean a
      // parser/fixture failure. Leave the pending reset/fit untouched and
      // retry the app-only cache rather than falsely declaring hydration done.
      await clearStageAfterHydrationFailure(request);
      recordFallbackAttempt({ cached: answer, loadFailed: true }, request);
      return;
    }
    if (recordFallbackAttempt(attempt, request) == null) return;
    finishStructureFallback();
    await replayOpenAction(request);
  } finally {
    fallbackInFlight.delete(request.generation);
  }
}

/* ----------------------------------------------- fit diagnostics readers */

/**
 * Everything below reads the live objects and reports what it found. Nothing
 * here may change what the viewer draws, and nothing may throw: a diagnostic
 * that can break the panel it is diagnosing is worthless, so every reader
 * clamps rather than fails and `reportDiagnostics` swallows.
 */

function rectOf(box: { x?: number; y?: number; width?: number; height?: number } | undefined): DiagnosticRect {
  return {
    x: finiteOr(box?.x),
    y: finiteOr(box?.y),
    width: finiteOr(box?.width),
    height: finiteOr(box?.height),
  };
}

function readHostDiagnostics(): HostDiagnostics {
  // Read from the SDK's live host context, not from a copy taken when the
  // notification arrived: a cached rectangle is exactly the class of defect
  // this object exists to find.
  const raw = app.getHostContext()?.containerDimensions as Record<string, unknown> | undefined;
  const container: { width?: number; height?: number; maxWidth?: number; maxHeight?: number } = {};
  let hasContainer = false;
  for (const key of ['width', 'height', 'maxWidth', 'maxHeight'] as const) {
    const value = raw?.[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      container[key] = value;
      hasContainer = true;
    }
  }
  const hostWidth = container.width ?? container.maxWidth;
  const hostHeight = container.height ?? container.maxHeight;
  const scale = window.visualViewport?.scale;
  return {
    displayMode,
    ...(hasContainer ? { containerDimensions: container } : {}),
    ...(hostWidth == null ? {} : { hostViewportWidthPx: hostWidth }),
    ...(hostHeight == null ? {} : { hostViewportHeightPx: hostHeight }),
    ...(hostContextAt == null ? {} : { hostContextAt }),
    hostContextCount,
    innerWidthPx: finiteOr(window.innerWidth),
    innerHeightPx: finiteOr(window.innerHeight),
    devicePixelRatio: finiteOr(window.devicePixelRatio, 1),
    ...(typeof scale === 'number' && Number.isFinite(scale) ? { visualViewportScale: scale } : {}),
    visibilityState: document.visibilityState,
  };
}

function readGeometryDiagnostics(): GeometryDiagnostics {
  const canvas = plugin.canvas3d;
  const canvasElement = stage.querySelector<HTMLCanvasElement>('canvas');
  const canvasBox = canvasElement?.getBoundingClientRect();
  const eye = eyeViewportPx();
  const halfCapPx = currentHalfCapPx();
  const eyes = globalThis.__stereoStructureEyeViewports;
  return {
    stageRectCssPx: rectOf(stage.getBoundingClientRect()),
    letterboxRectCssPx: rectOf(letterbox.getBoundingClientRect()),
    eyeViewportCssPx: { width: finiteOr(eye.width), height: finiteOr(eye.height) },
    eyeCapApplied: eyeCapApplied({
      sideBySide: mode === 'parallel' || mode === 'cross',
      halfCapPx,
      availableWidthPx: letterbox.clientWidth,
    }),
    halfCapPx: halfCapPx == null ? null : finiteOr(halfCapPx),
    canvasCssPx: { width: finiteOr(canvasBox?.width), height: finiteOr(canvasBox?.height) },
    // The drawing buffer, device px. Against `canvasCssPx` this is the
    // devicePixelRatio the GPU was actually handed, which is the number
    // hypothesis 2 turns on.
    canvasBackingPx: { width: finiteOr(canvasElement?.width), height: finiteOr(canvasElement?.height) },
    cameraViewport: rectOf(canvas?.camera.viewport),
    ...(eyes == null ? {} : {
      stereoEyeViewports: {
        left: rectOf(eyes.left),
        right: rectOf(eyes.right),
        parent: rectOf(eyes.parent),
        // A mono panel keeps the last stereo frame's split, so the age is what
        // says whether these numbers describe the frame on screen.
        ageMs: Math.max(0, Date.now() - finiteOr(eyes.at)),
      },
    }),
  };
}

function readCameraReading(): CameraReading {
  const canvas = plugin.canvas3d;
  if (canvas == null) {
    return {
      distanceToTargetAng: 0,
      radiusAng: 0,
      fovRad: 0,
      visibleSphereRadiusAng: 0,
      boundingSphereVisibleRadiusAng: 0,
      inTransition: false,
    };
  }
  const state = canvas.camera.state;
  return {
    distanceToTargetAng: finiteOr(Vec3.distance(state.position, state.target)),
    radiusAng: finiteOr(state.radius),
    fovRad: finiteOr(state.fov),
    // The radius the fit solves for, and the raw one beside it: they differ
    // exactly when the visible sphere has collapsed and the fit fell back.
    visibleSphereRadiusAng: finiteOr(visibleSphere(canvas).radius),
    boundingSphereVisibleRadiusAng: finiteOr(canvas.boundingSphereVisible.radius),
    inTransition: canvas.camera.transition.inTransition === true,
  };
}

function readFitDiagnostics(): FitDiagnostics {
  return {
    ...(fittedGeometry == null ? {} : { fittedGeometry: { ...fittedGeometry } }),
    fitSuspended: fitSuspensions.isSuspended(),
    fixturePinned,
    loadInFlight,
    ...(lastRefitDecision == null ? {} : { lastDecision: lastRefitDecision }),
    events: fitEvents.entries(),
  };
}

function readStateDiagnostics(): StateDiagnostics {
  const motion = motionController?.getSettings();
  const baselineDistance = motionController?.getBaselineDistance();
  return {
    mode,
    depthBudgetArcmin: finiteOr(Number(depthInput.value)),
    swapEyes: swapInput.checked,
    variant,
    color: lookColor,
    style: lookStyle,
    motionMode: motion?.mode ?? 'none',
    motionRunning: motionController?.isRunning() === true,
    ...(baselineDistance == null ? {} : { motionBaselineDistanceAng: finiteOr(baselineDistance) }),
    structureLoaded,
    ...(lastLoadedPdbId == null ? {} : { pdbId: lastLoadedPdbId }),
    messageCounts: { ...messageCounts },
    structureSource,
    fallback: fallbackRetry.snapshot(),
  };
}

function readUserDiagnostics(): UserDiagnostics {
  return { wheelEventsSinceFit, wheelEventsTotal };
}

function recordFitEvent(
  trigger: FitTrigger,
  fit: { eyeWidthPx: number; eyeHeightPx: number; radius: number; distance: number },
): void {
  const { fill } = fillForReading(
    {
      visibleSphereRadiusAng: fit.radius,
      distanceToTargetAng: fit.distance,
      fovRad: finiteOr(plugin.canvas3d?.camera.state.fov),
    },
    { width: fit.eyeWidthPx, height: fit.eyeHeightPx },
  );
  fitEvents.record({
    at: new Date().toISOString(),
    trigger,
    eyeWidthPx: finiteOr(fit.eyeWidthPx),
    eyeHeightPx: finiteOr(fit.eyeHeightPx),
    radius: finiteOr(fit.radius),
    distance: finiteOr(fit.distance),
    ...(fill === undefined ? {} : { fill }),
  });
}

const diagnosticsSources: DiagnosticsSources = {
  nowIso: () => new Date().toISOString(),
  viewerBuild: () => VIEWER_BUILD_PLACEHOLDER,
  panelId: () => panelId,
  nextSequence: () => (diagnosticsSequence += 1),
  host: readHostDiagnostics,
  geometry: readGeometryDiagnostics,
  camera: readCameraReading,
  fit: readFitDiagnostics,
  state: readStateDiagnostics,
  user: readUserDiagnostics,
};

/** Quiet period that collapses a load's burst of fits into one report, ms. */
const DIAGNOSTICS_DEBOUNCE_MS = 200;
/** Floor on the gap between two reports, ms. One tool call per second, at most. */
const DIAGNOSTICS_MIN_GAP_MS = 1_000;
/**
 * Gap after which a panel that changed recently reports anyway, ms.
 *
 * A conversation calls `stereo_structure.get_state` at a moment nobody
 * chose. Without this the answer would be the state at the last thing that
 * moved, which could be minutes old and would look exactly like a live one.
 */
const DIAGNOSTICS_HEARTBEAT_MS = 1_000;
/**
 * How long after a change the fast heartbeat lasts, ms.
 *
 * Long enough to cover a load, a mode switch and the refit that follows either
 * — the fit event ring shows both settling inside two seconds even on a loaded
 * machine — and short enough that a panel nobody is touching drops to the slow
 * rate while the conversation is still on the same message.
 */
const DIAGNOSTICS_ACTIVE_MS = 5_000;
/**
 * Gap after which a panel that has not changed recently reports anyway, ms.
 *
 * A 1 Hz beat is 60 app tool calls a minute per mounted panel, and Codex
 * mounts one per tool card, so a long conversation pays it several times over
 * for panels nobody is looking at. At 10 s an idle panel costs six calls a
 * minute and `get_state` still answers with numbers no older than the beat.
 */
const DIAGNOSTICS_IDLE_HEARTBEAT_MS = 10_000;
/**
 * Floor on the gap between two flushes, ms.
 *
 * A flush is immediate because a person pressed a button and is waiting for
 * the answer, but repeated presses, or a repeatedly delivered
 * `action: 'fit'`, had no rate bound at all. Presses inside this window
 * collapse into one send.
 */
const DIAGNOSTICS_FLUSH_MIN_GAP_MS = 250;

const diagnostics = createDiagnosticsScheduler({
  send: (trigger) => {
    if (sessionGuard.sessionId == null) return;
    const payload = assembleDiagnostics(diagnosticsSources, trigger);
    void callSessionTool(
      'stereo_structure.report_diagnostics',
      { diagnostics: payload },
      { failureLabel: 'Diagnostics report', quiet: true },
    );
  },
  now: () => performance.now(),
  timers: {
    set: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clear: (handle) => { window.clearTimeout(handle); },
  },
  debounceMs: DIAGNOSTICS_DEBOUNCE_MS,
  minGapMs: DIAGNOSTICS_MIN_GAP_MS,
  heartbeatMs: DIAGNOSTICS_HEARTBEAT_MS,
  idleHeartbeatMs: DIAGNOSTICS_IDLE_HEARTBEAT_MS,
  activeMs: DIAGNOSTICS_ACTIVE_MS,
  flushMinGapMs: DIAGNOSTICS_FLUSH_MIN_GAP_MS,
});

// See the declaration in the global block at the top of this file. The
// host-emulation harness photographs a frame and then asks the server what
// that frame was; on the idle heartbeat that answer could be ten seconds old.
// Redrawing the same frame republishes the stereo draw pass's eye split
// without moving the camera, the scene or any setting.
window.__stereoStructureProbe = {
  identity(): { panelId: string; sequence: number; fitEventCount: number; lastFitAt?: string } {
    const events = fitEvents.entries();
    const last = events.at(-1);
    return {
      panelId,
      // The sequence the *next* report will exceed: `nextSequence` pre-
      // increments, so this is the last one assembled.
      sequence: diagnosticsSequence,
      fitEventCount: events.length,
      ...(last === undefined ? {} : { lastFitAt: last.at }),
    };
  },
  async refresh(): Promise<void> {
    try {
      // The draw runs on Mol*'s own animation frame, and the eye split it
      // publishes is what the report is being asked for, so the report waits
      // for it rather than describing the frame before it.
      plugin.canvas3d?.requestDraw();
      await nextFrame();
      await nextFrame();
      diagnostics.flush('heartbeat');
    } catch {
      // A probe that can break the panel it is probing is worthless.
    }
  },
};

/**
 * Ask for a report.
 *
 * Called from the fit, from the refit decision on every animation frame that
 * does not say `keep`, from every load boundary, mode change, host context and
 * display-mode change. It is a timer arm and nothing else — no reading, no
 * tool call — so it cannot delay a fit, and it is wrapped because it is called
 * from inside the render loop.
 */
function reportDiagnostics(trigger: ReportTrigger): void {
  try {
    diagnostics.report(trigger);
  } catch {
    // Never into the render loop.
  }
}

/**
 * Reframe the structure in the eye window this panel is rendering into, and
 * report the result at once.
 *
 * The button exists to split one question in two. If it fixes the side
 * panel, the fit computation is right in that host and some trigger never
 * fired; if it does not, the computation or the eye geometry is wrong there,
 * and the report says which number. The report bypasses the one-second floor
 * because a person pressed the button and is waiting for the answer.
 */
function runFit(sessionRequest?: SessionGeneration): void {
  if (!isCurrentSessionWork(sessionRequest)) return;
  const fitted = withFitTrigger('button', () => fitCameraToStage('button'));
  if (!isCurrentSessionWork(sessionRequest)) return;
  if (fitted) {
    motionController?.captureBaseline();
    notify('Fit: framed the structure in the current eye window.');
  } else {
    notify('Nothing to fit yet.', 'error');
  }
  try {
    diagnostics.flush('button');
  } catch {
    // Never into the click handler.
  }
}

fitButton.addEventListener('click', () => runFit());

// Wheel and pinch on the stage. A person's own zoom is not a defect and the
// refit rule leaves their framing alone, so without a count a zoomed panel and
// a mis-fitted one are the same picture.
const countPointerZoom = (): void => {
  wheelEventsSinceFit += 1;
  wheelEventsTotal += 1;
};
stage.addEventListener('wheel', countPointerZoom, { passive: true });
stage.addEventListener('touchmove', (event) => {
  if (event.touches.length >= 2) countPointerZoom();
}, { passive: true });

app.addEventListener('toolresult', (event) => {
  void (async () => {
    const failure = toolResultError(event);
    if (failure != null) {
      notify(`Tool request failed: ${failure}`, 'error');
      return;
    }
    const message = structured(event);
    const structureReplacement = message?.kind === 'open'
      || (message?.kind === 'control' && message.action === 'load_pdb');
    const conciseStructureResult = structureReplacement;
    const incomingSessionId = messageSessionId(message);
    const incomingRenderToken = messageRenderToken(message);
    const incomingServerEpoch = messageServerEpoch(message);
    if (conciseStructureResult && (incomingSessionId == null || incomingRenderToken == null || incomingServerEpoch == null)) {
      notify('Structure hydration failed: the result did not include a session, server lifecycle, and render ordering token.', 'error');
      return;
    }
    let request = sessionGuard.capture();
    const sessionDecision = decideToolResultSession({
      currentSessionId: request.sessionId,
      currentServerEpoch: sessionGuard.serverEpoch,
      currentRenderToken: sessionGuard.renderToken,
      incomingSessionId,
      incomingServerEpoch,
      incomingRenderToken,
      incomingServerEpochRetired: incomingServerEpoch != null && sessionGuard.isRetiredServerEpoch(incomingServerEpoch),
      structureReplacement,
    });
    if (sessionDecision === 'discard') {
      // A delayed state/mode/motion result from session A must never make A
      // current again after a structure replacement switched this frame to B.
      return;
    }
    if (sessionDecision === 'begin' && incomingSessionId != null && incomingRenderToken != null && incomingServerEpoch != null) {
      // Begin before the first await. This synchronously invalidates every
      // response/timer owned by an older open, including another open for the
      // same session but a different cached source. Claim the server's token
      // first: notifications are not guaranteed to arrive in call order, so a
      // late A must not reclaim a frame that already accepted newer B.
      if (!sessionGuard.acceptRenderToken(incomingRenderToken, incomingServerEpoch)) return;
      request = sessionGuard.begin(incomingSessionId, incomingRenderToken);
      resetStructureFallback();
    }
    rememberOpenAction(message, request);
    if (message != null) await applyMessage(message, request);
    if (conciseStructureResult) {
      if (request.sessionId == null) {
        notify('Structure hydration failed: the open result did not include a session.', 'error');
        return;
      }
      // Hosts may reuse a mounted frame. A delivered open/load is therefore a
      // replacement even when this stage already contains a structure; the
      // mount fallback intentionally keeps an existing stage and cannot serve
      // this case.
      const hydrated = await hydrateLatestStructure('Structure hydration', request, { quiet: true });
      if (hydrated === 'stale') return;
      if (hydrated === 'hydrated') {
        await replayOpenAction(request);
        if (!sessionGuard.isCurrent(request)) return;
        fallbackRetry.cancel(new Date().toISOString());
        finishStructureFallback();
      } else {
        // A transient host/bridge miss gets the same bounded retry policy as a
        // fresh mount. The failed replacement cleared the stale scene first,
        // so the retry is not blocked by `structureLoaded`.
        await runStructureFallback(request);
      }
      return;
    }
    // Non-rendering results still get the mount fallback when they arrive
    // before the first structure. Coordinates are never read from their
    // structured content; only app-only result metadata can hydrate a panel.
    if (structureReplacement) await replayOpenAction(request);
    if (!sessionGuard.isCurrent(request)) return;
    await runStructureFallback(request);
  })().catch((error: unknown) => {
    notify(`Could not apply the tool result: ${thrownErrorMessage(error)}`, 'error');
  });
});
app.addEventListener('hostcontextchanged', () => {
  setConnection('connected');
  hostContextCount += 1;
  hostContextAt = new Date().toISOString();
  // A host resize refits on a later animation frame, so the cause is claimed
  // for a bounded window rather than scoped to this call.
  armFitTrigger('hostcontext');
  reportDiagnostics('hostcontext');
  setDisplayMode(app.getHostContext()?.displayMode as DisplayMode | undefined);
  // Codex republishes host context from a ResizeObserver, so this fires on
  // every layout change. `sendPanelSize` guards itself: nothing is sent unless
  // the height the current width implies differs from the last one sent.
  sendPanelSize(false);
});

root.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((button) => {
  button.addEventListener('click', () => {
    const next = button.dataset.mode as StereoMode;
    setMode(next);
    syncViewState();
  });
});
// The slider once reached the server only on a mode-button click, so
// dragging Depth to 40 and asking for `get_state` returned the value from the
// last click. It now writes through the app-only sync tool, which mounts no
// panel, on every input event and at most once per 250 ms.
depthInput.addEventListener('input', () => { setMode(mode); syncViewState(); });
swapInput.addEventListener('change', () => { setMode(mode); syncViewState(); });
colorSelect.addEventListener('change', () => {
  void setLook({ color: lookColorOrDefault(colorSelect.value) });
  syncViewState();
});
styleSelect.addEventListener('change', () => {
  void setLook({ style: lookStyleOrDefault(styleSelect.value) });
  syncViewState();
});
glassesSelect.addEventListener('change', () => {
  glasses = glassesSelect.value as GlassesKind;
  setAnaglyphThemeGlasses(glasses, variant);
  controller?.update();
  if (mode === 'anaglyph') void setAnaglyphPresentation(true);
});
variantSelect.addEventListener('change', () => {
  variant = variantSelect.value as Variant;
  setAnaglyphThemeGlasses(glasses, variant);
  controller?.update();
  if (mode === 'anaglyph') void setAnaglyphPresentation(true);
  syncViewState();
});
cameraAxesInput.addEventListener('change', applyCameraAxes);
settingsToggle.addEventListener('click', () => setDrawerOpen(drawer.hidden));
// The drawer floats over the stage, so it needs the same dismissal a person
// expects from anything that covers what they came to look at.
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !drawer.hidden) {
    setDrawerOpen(false);
    settingsToggle.focus();
  }
});
function sendMotionFromControls(): void {
  const settings = motionFromControls();
  setMotion(settings);
  syncViewState();
}

motionSelect.addEventListener('change', sendMotionFromControls);
motionAmplitude.addEventListener('change', sendMotionFromControls);
motionPeriod.addEventListener('change', sendMotionFromControls);
motionAxis.addEventListener('change', sendMotionFromControls);
element<HTMLButtonElement>('#reset-camera').addEventListener('click', () => {
  // Camera pose is panel-local, not durable session state. Sending the model's
  // transient reset action here would queue it for replay on the next open and
  // reset twice; the click has already acted on this mounted camera. Capture
  // ownership before the first await so a subsequently delivered open cannot
  // let this older reset fit, pin, or restore motion over its new structure.
  // The initial no-session generation is valid too, so a standalone local
  // viewer retains its Reset button until a real open claims the frame.
  void resetCamera(sessionGuard.capture());
});
const loadPdbButton = element<HTMLButtonElement>('#load-pdb');
loadPdbButton.addEventListener('click', async () => {
  const pdbId = element<HTMLInputElement>('#pdb-id').value.trim();
  if (!/^[0-9a-z]{4}$/i.test(pdbId)) { notify('Enter a four-character PDB ID.', 'error'); return; }
  const activeSessionId = sessionGuard.sessionId;
  if (activeSessionId == null) {
    notify(`Loading ${pdbId.toUpperCase()} failed: this viewer is not attached to a session yet.`, 'error');
    return;
  }
  const request = sessionGuard.begin(activeSessionId);
  resetStructureFallback();
  notify(`Requesting ${pdbId.toUpperCase()} from files.rcsb.org…`);
  loadPdbButton.disabled = true;
  try {
    const response = await callSessionTool(
      'stereo_structure.control',
      { action: 'load_pdb', pdbId },
      { failureLabel: `Loading ${pdbId.toUpperCase()}`, request },
    );
    if (!sessionGuard.isCurrent(request)) return;
    if (response == null) {
      fallbackRetry.cancel(new Date().toISOString());
      finishStructureFallback();
      return;
    }
    const message = structured(response);
    if (message?.kind === 'control' && message.action === 'load_pdb') {
      const renderToken = messageRenderToken(message);
      const serverEpoch = messageServerEpoch(message);
      // This direct app call owns `request` already, unlike a host-delivered
      // tool result. Still record its server ordering token so a duplicate or
      // delayed older notification cannot reclaim the frame afterward.
      if (renderToken == null || serverEpoch == null || !sessionGuard.acceptRenderToken(renderToken, serverEpoch)) return;
    }
    if (message != null) await applyMessage(message, request);
    if (!sessionGuard.isCurrent(request)) return;
    const hydrated = await hydrateLatestStructure(`Loading ${pdbId.toUpperCase()}`, request);
    if (hydrated === 'stale') return;
    if (hydrated === 'hydrated') {
      fallbackRetry.cancel(new Date().toISOString());
      finishStructureFallback();
    } else {
      await runStructureFallback(request);
    }
  } finally {
    loadPdbButton.disabled = false;
  }
});
element<HTMLButtonElement>('#load-text').addEventListener('click', async () => {
  const structureText = element<HTMLTextAreaElement>('#structure-text').value;
  if (structureText.trim().length < 20) { notify('Paste PDB or mmCIF coordinates first.', 'error'); return; }
  // A pasted structure is also an asynchronous stage replacement. Capture
  // rather than leaving it unscoped so a newer host open wins while parsing.
  await loadStructure(structureText, structureText.includes('_atom_site.') ? 'mmcif' : 'pdb', 'pasted structure', {
    sessionRequest: sessionGuard.capture(),
  });
});
// The fixture is bundled, so it loads locally and never reaches the network.
element<HTMLButtonElement>('#load-fixture').addEventListener('click', () => {
  void loadDepthFixture('local', sessionGuard.capture());
});

/**
 * The 63 mm parallel cap and both predicted disparities are physical
 * quantities, so they are only as good as the observer's screen density and
 * viewing distance. An empty density field falls back to the runtime
 * measurement, which reads 96 CSS px/in on a display that does not report a
 * real one; the field is then labelled estimated.
 */
function applyDensityFromControls(): void {
  const entered = optionalNumber(densityInput);
  if (entered != null && entered > 0) {
    densityEstimated = false;
    controller?.setSettings({ cssPxPerInch: entered });
  } else {
    const reading = measureCssDensity(document);
    densityEstimated = reading.estimated;
    densityInput.value = reading.cssPxPerInch.toFixed(1);
    controller?.setSettings({ cssPxPerInch: reading.cssPxPerInch });
  }
  updateDensityNote();
}

function applyDistanceFromControls(): void {
  const entered = optionalNumber(distanceInput);
  const viewingDistanceMm = entered != null && entered > 0 ? entered : 500;
  distanceInput.value = String(viewingDistanceMm);
  controller?.setSettings({ viewingDistanceMm });
}

densityInput.addEventListener('change', applyDensityFromControls);
distanceInput.addEventListener('change', applyDistanceFromControls);

stage.addEventListener('pointermove', (event) => {
  if (!dragging) mouseParallax.setClientPosition(event.clientX, event.clientY, stage.getBoundingClientRect());
});
stage.addEventListener('pointerleave', () => mouseParallax.clear());
stage.addEventListener('pointerdown', () => {
  dragging = true;
  mouseParallax.clear();
  motionController?.hold(performance.now());
});
function endStageDrag(): void {
  // Window releases also arrive from unrelated controls. Only the stage's
  // active drag may resume motion or capture a new camera baseline.
  mouseParallax.clear();
  if (!dragging) return;
  dragging = false;
  motionController?.release(performance.now());
}
stage.addEventListener('pointerup', endStageDrag);
stage.addEventListener('pointercancel', endStageDrag);
// A mouse drag can end outside the canvas without pointer capture. A lost
// focus or hidden page may never deliver that release at all.
window.addEventListener('pointerup', endStageDrag);
window.addEventListener('pointercancel', endStageDrag);
window.addEventListener('blur', endStageDrag);

document.addEventListener('visibilitychange', () => {
  if (document.hidden) endStageDrag();
  motionController?.setHidden(document.hidden, performance.now());
});

async function boot(): Promise<void> {
  await plugin.init();
  await plugin.mountAsync(stage);
  plugin.representation.structure.themes.colorThemeRegistry.add(AnaglyphLuminanceColorThemeProvider);
  // Not in `ColorTheme.BuiltIn`: pLDDT confidence ships as a Mol* extension
  // and has to be registered before the Colour choice can select it. It
  // attaches the quality-assessment model property itself through the
  // provider's `ensureCustomProperties`, which the representation transform
  // calls for us.
  plugin.representation.structure.themes.colorThemeRegistry.add(PLDDTConfidenceColorThemeProvider);
  // An empty stage is a stage, not a blank page. Mol*'s renderer defaults to a
  // white ground and its camera-axes gizmo defaults to on, so a panel with
  // nothing in it used to be a white rectangle carrying three coloured bars
  // and nothing else. Both are settled here, before anything is loaded:
  // `setAnaglyphPresentation` paints the same ground the letterbox uses and
  // `applyCameraAxes` keeps the gizmo off until `structureLoaded` is true.
  await setAnaglyphPresentation(mode === 'anaglyph');
  applyCameraAxes();
  motionController = new MotionController({
    readCamera: () => {
      const camera = plugin.canvas3d?.camera;
      if (camera == null) throw new Error('Stereofold Mol* camera is not initialized.');
      return {
        position: camera.state.position,
        target: camera.state.target,
        up: camera.state.up,
        fovRad: camera.state.fov,
        near: camera.near,
        aspect: Math.max(1e-6, camera.viewport.width / Math.max(1, camera.viewport.height)),
      };
    },
    setPosition: (position) => {
      plugin.canvas3d?.camera.setState({ position: Vec3.create(...position) }, 0);
    },
    setViewOffset: (viewOffset) => {
      const camera = plugin.canvas3d?.camera;
      if (camera == null) return;
      if (viewOffset == null) {
        camera.viewOffset.enabled = false;
      } else {
        camera.viewOffset.enabled = true;
        camera.viewOffset.fullWidth = viewOffset.fullWidth;
        camera.viewOffset.fullHeight = viewOffset.fullHeight;
        camera.viewOffset.offsetX = viewOffset.offsetX;
        camera.viewOffset.offsetY = viewOffset.offsetY;
        camera.viewOffset.width = viewOffset.width;
        camera.viewOffset.height = viewOffset.height;
      }
      camera.update();
    },
  }, mouseParallax);
  motionController.captureBaseline();
  const startMotion = defaultMotion();
  setMotion(startMotion);
  controller = new StereoController({
    readCamera,
    camera: { setStereo: setMolstarStereo },
    onParams: updateReadout,
    onDiagnostic: (message) => { cameraStatus.textContent = message; },
    onFrame: (nowMs) => { motionController?.tick(nowMs); },
  });
  colorSelect.value = lookColor;
  styleSelect.value = lookStyle;
  updateLookControls();
  const cssPxPerInch = viewportPxPerInch();
  densityInput.value = cssPxPerInch.toFixed(1);
  updateDensityNote();
  controller.setSettings({ cssPxPerInch, devicePixelRatio: window.devicePixelRatio });
  controller.start();
  installAcceptanceHook();
  await app.connect(new PostMessageTransport(window.parent, window.parent));
  setConnection('connected');
  // One size-changed for the mount, then only on a width change. Everything
  // this app can do to its own layout leaves the width alone, so this is the
  // only notification a card that is never resized ever receives.
  const context = app.getHostContext();
  sendPanelSize(true);
  displayMode = (context?.displayMode as DisplayMode | undefined) ?? 'inline';
  updateDisplayModeButton();
  window.addEventListener('resize', onWindowResize);
  // The open result normally triggers hydration immediately. Keep a delayed
  // fallback for hosts whose tool-result notification arrives late or whose
  // first app-only cache request fails while the bridge is still wiring up.
  scheduleStructureFallback(STRUCTURE_FALLBACK_MS);
  // Everything the report reads is now in place: which bytes are mounted, what
  // rectangle the host gave this frame, and what the camera is framed for.
  // `stereo_structure.get_state` returns the last report verbatim, which is
  // the only route out of a host no debugger can reach.
  diagnostics.start();
  reportDiagnostics('mount');
  // The session result arrives through the tool-result listener. Its motion is
  // adopted there, and `adoptMotion` writes a reduced-motion override back
  // through the app-only sync path when this observer needs one.
}

void boot().catch((error: unknown) => {
  setConnection('offline');
  notify(`Stereofold startup failed: ${error instanceof Error ? error.message : 'unknown error'}`, 'error');
});

window.addEventListener('pagehide', () => {
  // A pending sync would otherwise be thrown away with the panel, leaving the
  // server reporting the state before the person's last adjustment.
  viewSync.flush();
  diagnostics.stop();
  controller?.stop();
  motionController?.stop();
  plugin.dispose();
}, { once: true });
