import { recordTalkReplySeat } from './talk-reply-diagnostics.mjs';
import { TextBuilder } from 'molstar/lib/mol-geo/geometry/text/text-builder.js';
import { Text } from 'molstar/lib/mol-geo/geometry/text/text.js';
import { Shape } from 'molstar/lib/mol-model/shape.js';
import { ShapeRepresentation } from 'molstar/lib/mol-repr/shape/representation.js';
import { Sphere3D } from 'molstar/lib/mol-math/geometry.js';
import { Color } from 'molstar/lib/mol-util/color/index.js';
import { createSpatialToolbar } from './spatial-toolbar.mjs';
import { createMenuResolve } from './menu-resolve.mjs'; // One plate re-solve per settled menu motion.
import { outcomeCopy } from './outcome-copy.mjs';
import { holdOutcomeLine, outcomeLineDecision, shouldClearOutcomeRow } from './outcome-line.mjs'; // Which receipts the wearer sees, and for how long.
import { createPresentationScene } from './presentation-scene.mjs';
import { holdHeadRotationZero } from './head-rotation-lock.mjs'; // Every glyph in the session, unmirrored.
import { trackFoveation, disableXrLayerMsaa, entryRefusalReason, requestHeadsetSession, headsetOptionalFeatures, headsetEntryDeadlineMs } from './xr-session-request.mjs'; // The blend-mode switch reads the refusal.
import { beginXrRenderBudget, renderBudgetOverrides, watchFrameCost, xrResolutionScale } from './xr-render-budget.mjs';
import { installFrameGovernor } from './xr-frame-governor.mjs'; // Observe by default; resolution changes require opt-in.
import { immersiveDepthPlanes, panelDepthBand } from './xr-depth-band.mjs'; // The projection planes, as pure arithmetic.
import { attachGripPushToTalk, voiceCommandSender } from './push-to-talk-grip.mjs';
import { attachVoiceCommandRunner } from './voice-command-runner.mjs';
import { showTalkOutcome } from './talk-caption.mjs'; // The head-seated caption line.
// A long reply arrives as ordered segments; the row shows the one
// that is sounding, not the whole paragraph.
import { replyCaptionHoldMs, replySegmentsOf, REPLY_SEGMENT_EVENT } from './reply-segments.mjs';
import { voiceCommandSpeaker } from './voice-command-speaker.mjs';
import { agentAttached, listeningStatusLine } from './agent-presence.mjs'; // Is Claude listening?
import { createVoiceCapture } from './voice-capture.mjs';
import { blindVisibility, createTourResumeIntent, watchSessionVisibility, XR_VISIBILITY_DIAGNOSTIC } from './xr-visibility.mjs'; // The headset stopped showing the session.
import { trackXrFrames } from './xr-frame-lifetime.mjs';
import { installXrPointer } from './xr-pointer.mjs';
import { attachXrConsumedTriggerClickGuard } from './xr-click-pick-guard.mjs';
import { releasePushToTalkMicrophone } from './push-to-talk-audio.mjs';

/**
 * The reply caption the companion panel republishes for the headset. It must
 * stay the string `reply-audio.mjs` and `talk-reply-diagnostics.mjs` use, and
 * the one `inspector.ts` dispatches.
 */
const REPLY_CAPTION_EVENT = 'stereofold-headset-reply';

/**
 * The Mac-presence line and the rule that gates it now live in
 * `agent-presence.mjs`, beside the reading they depend on. Re-exported here
 * because that is where callers have always found the line.
 */
export { AGENT_LISTENING_LINE, listeningStatusLine } from './agent-presence.mjs';

const MODES = new Map([['vr', 'immersive-vr'], ['ar', 'immersive-ar'], ['immersive-vr', 'immersive-vr'], ['immersive-ar', 'immersive-ar']]);
const PRESENTATION_TIMEOUT_MS = 10_000;
const STARTUP_TIMEOUT_MS = 10_000;
const SESSION_END_TIMEOUT_MS = 5_000;
const FINALIZER_TIMEOUT_MS = 300;
// Acceptance 6: the first desktop geometry rebuild completes in 671–774 ms.
// Audio release keeps its short deadline; geometry has the startup budget.
const APPEARANCE_TIMEOUT_MS = 10_000;

function xrError(message) {
  return Object.assign(new Error(message), { code: 'xr_unavailable' });
}

function xrTimeout(message, code = 'xr_startup_timeout') {
  return Object.assign(new Error(message), { code });
}

function withTimeout(value, timeoutMs, message, code = 'xr_startup_timeout') {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(xrTimeout(message, code)), timeoutMs);
  });
  return Promise.race([Promise.resolve(value), deadline]).finally(() => clearTimeout(timer));
}

async function closeNativeSession(session) {
  if (!session) return true;
  try {
    await withTimeout(session.end(), SESSION_END_TIMEOUT_MS,
      'Timed out closing the headset session.', 'xr_teardown_timeout');
    return true;
  } catch (error) {
    // XRSession's ended state is not a public IDL attribute. Active records
    // use their end event as the authoritative terminal signal; for sessions
    // without a record, InvalidStateError is the standard already-ended case.
    return error?.name === 'InvalidStateError';
  }
}

function supportedRuntime() {
  // An XR session is deliberately available only in a secure browser context.
  // This also keeps a companion opened over an unsafe origin from exposing a
  // misleading control that can never enter immersion.
  return globalThis.isSecureContext === true && typeof navigator !== 'undefined' && navigator.xr;
}

// These are the two production-only parts of the preview adapter. Keeping
// them here avoids bundling the preview's IWER reference-space probe into the
// companion runtime. Both patches are restored with the exact XR session.
function installPresentationDepthAdapter(plugin) {
  const draw = plugin.canvas3dContext?.passes?.draw;
  const texture = draw?.depthTextureOpaque;
  if (!texture || !draw.drawTarget?.framebuffer) throw Error('Pinned Mol* draw-pass contract unavailable');
  const originals = {};
  for (const method of ['attachFramebuffer', 'detachFramebuffer']) {
    const original = originals[method] = texture[method];
    if (typeof original !== 'function') throw Error(`Missing texture method: ${method}`);
    texture[method] = function (framebuffer, attachment, ...rest) {
      const webgl = plugin.canvas3d.webgl, session = webgl.xr.session;
      if (session && framebuffer === draw.drawTarget.framebuffer && attachment === 'depth') {
        const layer = session.renderState.baseLayer;
        if (!layer || webgl.gl.getParameter(webgl.gl.FRAMEBUFFER_BINDING) !== layer.framebuffer) {
          throw Error('Presentation depth request used an unexpected framebuffer');
        }
        return;
      }
      return original.call(this, framebuffer, attachment, ...rest);
    };
  }
  return { restore() {
    for (const [method, original] of Object.entries(originals)) texture[method] = original;
  } };
}

function installSceneDepthAdapter({ session, space, canvas, Mat4, deliberateClipping, presentationDepth = () => undefined, onMolecularDepth = () => {} }) {
  const requestFrame = session.requestAnimationFrame;
  const updateState = session.updateRenderState;
  let currentFrame = null;
  session.requestAnimationFrame = function (callback) {
    return requestFrame.call(this, (time, frame) => {
      currentFrame = frame;
      try { return callback(time, frame); }
      finally { currentFrame = null; }
    });
  };
  session.updateRenderState = function (options) {
    if (!currentFrame || !Number.isFinite(options.depthFar)) return updateState.call(this, options);
    let depthFar = options.depthFar, depthNear = options.depthNear;
    const clipped = deliberateClipping();
    // Retain the exact stock molecular depth band. Presentation layout may
    // choose an interior physical plane, but never changes a cutaway plane.
    //
    // The near plane is reported to the panel ONLY when the
    // wearer asked for a cutaway, which is the same gate the far plane has
    // always had. Mol* picks its own near plane from the structure's bounding
    // sphere, so on a large scene at a small camera scale it walks out past
    // the menu's seat and nobody asked it to: a Quest 2 wall chapter logged
    // `depthNearMeters` 1.677 at `cameraScale` 0.00713.
    // `toolbarLayoutForDepthRange`
    // then relocated the whole panel to 1.727 m and scaled every length by
    // 2.67 to hold its angular size, the structure stand-off pushed that seat
    // out again by the 1.5x cap, and the panel's plates ended up at 3.40-4.45 m
    // from the eye. The framing solver reads those plates, and a plate at
    // 3.40 m asks for a structure past 10 m: it hit `STANDOFF_REACH_METRES`,
    // parked the wall at 3.5 m at the 40 per cent subject floor, and STILL
    // reported `pierced` 100 of 107. An automatic near plane is a depth-
    // precision device, not an instruction; only a cutaway is an instruction.
    // The arithmetic itself lives in `xr-depth-band.mjs`, where `node --test`
    // can read it without a browser.
    onMolecularDepth(panelDepthBand({ clipped, depthNear: options.depthNear, depthFar: options.depthFar }));
    if (!clipped) {
      const camera = canvas.camera, sphere = canvas.boundingSphereVisible;
      const { position, quaternion } = Mat4.getDecomposition(camera.view);
      const offset = space.getOffsetReferenceSpace(new XRRigidTransform(
        { x: position[0], y: position[1], z: position[2] },
        { x: quaternion[0], y: quaternion[1], z: quaternion[2], w: quaternion[3] }));
      const pose = currentFrame.getViewerPose(offset);
      // Tracking can be unavailable in the first XR frames. WebXR permits a
      // null viewer pose while the device establishes tracking; keep Mol*'s
      // requested depth for that frame and let a later frame refine it.
      if (!pose?.views?.length) return updateState.call(this, { ...options, depthFar });
      const center = Array.from(sphere.center, value => value * camera.scale);
      const radius = sphere.radius * camera.scale;
      const farByEye = pose?.views.map(view => {
        const m = view.transform.inverse.matrix;
        return -(m[2] * center[0] + m[6] * center[1] + m[10] * center[2] + m[14]) + radius;
      });
      if (!Number.isFinite(radius) || radius <= 0 || !farByEye?.length || !farByEye.every(Number.isFinite)) {
        // A malformed or temporarily unavailable render sphere should not
        // tear down the native session. Preserve the stock depth request and
        // continue with the next frame, where the bounds can be recomputed.
        return updateState.call(this, { ...options, depthFar });
      }
      depthFar = Math.max(depthFar, ...farByEye.map(value => value + 0.001));
    }
    const presentation = presentationDepth(currentFrame);
    // The auxiliary UI can extend the unrestricted scene's far projection.
    // Under deliberate clipping this must remain untouched, exactly as asked.
    //
    // And the same symmetry on the near side. A cutaway is
    // still untouchable -- lowering the near plane under `clipped` would undo
    // exactly what the wearer asked for -- but an unrestricted scene's near
    // plane is Mol*'s own arithmetic over the structure's bounding sphere, and
    // exiling the menu behind it costs twice: the panel walks to three or four
    // metres and drags the framing solver out with it, AND the front of the
    // structure is sliced off invisibly (the wall pass clipped everything
    // nearer than 1.677 m off a structure whose nearest point was 0.069 m
    // behind the eye). So the near plane opens to admit the panel at its own
    // seat, the way the far plane has always opened to admit it.
    const planes = immersiveDepthPlanes({ clipped, depthNear, depthFar,
      presentationNear: presentation?.near, presentationFar: presentation?.far });
    return updateState.call(this, { ...options,
      ...(Number.isFinite(planes.depthNear) ? { depthNear: planes.depthNear } : {}),
      ...(Number.isFinite(planes.depthFar) ? { depthFar: planes.depthFar } : {}) });
  };
  return { restore() {
    session.requestAnimationFrame = requestFrame;
    session.updateRenderState = updateState;
    currentFrame = null;
  } };
}

function recordXrFrameError(phase, error) {
  try {
    globalThis.__stereofoldDiagnostics?.record?.('xr-frame-error', {
      phase, name: error?.name ?? 'Error', error: error?.message ?? String(error),
    });
  } catch { /* Diagnostics must never become the frame failure. */ }
}

function installHeadFrameObserver({ session, space, mode, onInputFrame, onHeadFrame, isVisible = () => true, drawCount = () => undefined }) {
  if (typeof onHeadFrame !== 'function' && typeof onInputFrame !== 'function') return { restore() {} };
  const requestFrame = session.requestAnimationFrame;
  let inputTime, inputFrame;
  session.requestAnimationFrame = function (callback) {
    return requestFrame.call(this, (time, frame) => {
      let result;
      // The diagnostics watcher and renderer can subscribe to the same native
      // frame. Process its input once, before either eye draws, while retaining
      // the drawn-image observer below for captures and presentation evidence.
      const freshInput = Number.isFinite(time) ? time !== inputTime : frame !== inputFrame;
      if (freshInput && isVisible() && typeof onInputFrame === 'function') {
        inputTime = time; inputFrame = frame;
        try { onInputFrame({ frame, space, mode, time }); }
        catch (error) { recordXrFrameError('input-frame', error); }
      }
      let drawsBefore;
      try { drawsBefore = drawCount(); } catch { drawsBefore = undefined; }
      try {
        result = callback(time, frame);
        if (result && typeof result.catch === 'function') result.catch(error => recordXrFrameError('renderer-promise', error));
      } catch (error) {
        // XR requestAnimationFrame is a one-shot subscription. If Mol* throws
        // before it asks for the next frame, renew the subscription here so a
        // single renderer failure cannot leave the headset's App time at zero.
        recordXrFrameError('renderer', error);
        try { this.requestAnimationFrame(callback); }
        catch (rescheduleError) { recordXrFrameError('reschedule', rescheduleError); }
        return undefined;
      }
      // This outer wrapper runs after the callback it wraps, and it wraps every
      // XR callback the page registers, not only Mol*'s. The frame-rate
      // watcher's callback runs first in every frame, before Mol* has drawn,
      // so `drawn` says whether THIS callback drew into the opaque framebuffer.
      // The callback receives only transient WebXR objects; it cannot mutate a
      // camera, scene, capture, or shared inspection state from this module.
      try {
        // Keep submitting the scene under system UI, but do not rebuild the
        // menu, process input or publish head context while focus is elsewhere.
        if (!isVisible()) return result;
        let drawsAfter;
        try { drawsAfter = drawCount(); } catch { drawsAfter = undefined; }
        const drawn = Number.isFinite(drawsBefore) && Number.isFinite(drawsAfter) ? drawsAfter !== drawsBefore : undefined;
        // Timing, transition waits and receipts can subscribe to the same XR
        // frame. Only a rendered callback publishes seating/capture evidence;
        // the separately deduplicated input hook has already run above.
        if (drawn === false) return result;
        const reported = onHeadFrame?.({ frame, space, mode, drawn });
        if (reported && typeof reported.catch === 'function') reported.catch(error => recordXrFrameError('head-frame-promise', error));
      } catch (error) { recordXrFrameError('head-frame', error); }
      return result;
    });
  };
  return { restore() { session.requestAnimationFrame = requestFrame; } };
}

/**
 * The production XR boundary for the shared Mol* viewer. It owns only the
 * presentation session and its two narrowly-scoped depth workarounds; all
 * camera, structure, selection and inspection state remains in viewer.mjs.
 */
export function createImmersiveSession({ plugin, canvas, Mat4, isReady, deliberateClipping = () => false, consumesTriggerClick = () => false,
  onPresentationRepresentationChange = () => {}, canResumeDesktop = () => !canvas.webgl.isContextLost, onVoiceCommand = undefined,
  getVoiceInteraction = () => undefined, onSpatialAction = async () => {}, onSpatialActionIntent = () => {}, onOpenWorkbench = undefined,
  // The parts of the colour key the structure is wearing, so
  // "show me the guide RNA" is a command in this lesson and nowhere else.
  getLessonParts = () => [],
  getSpatialState = () => ({}), getEntryGeometry = () => ({}), getMolecularBounds = () => canvas.boundingSphereVisible, onConsumeSpatialSelect = () => {}, onInputFrame = () => {}, onHeadFrame = () => {}, onInputVisibility = () => {},
  // Canvas3D's draw counter, so the head observer can tell the
  // callback that drew this frame from the ones that ran before it.
  getDrawCount = () => undefined,
  // The live tour controller, so a session that stops being
  // visible can pause autoplay instead of advancing scenes into an empty
  // headset. Reading it lazily keeps this module ignorant of when the page
  // hands its tour player over, which happens long after the session starts.
  getSpatialTour = () => undefined,
  onPresented = async () => {}, onLeavingPresentation = async () => {},
  // The menu column is now on the glass.
  //
  // `canvas.xr.isPresenting` flips before the toolbar is built, and the
  // viewer's plate layout runs off that flag, so every entry
  // solved its name plates seconds before the panel existed and asked a
  // toolbar with no drawn geometry for its rectangle. `menuPoints()` answered
  // with an empty list, the solver was handed no obstacle at all, and "GAR1,
  // first copy" came to rest under the Pg 1/8 row on both entries. This fires
  // once the panel has drawn, which is the first moment the rectangle exists.
  onMenuPlaced = () => {} }) {
  let active;
  let entering;
  let ending;
  let disposed = false;
  let outcomeRepresentation;
  let outcomeOwner;
  let outcomeSequence = 0;
  let outcomeRepresentationCount = 0;
  // The receipt currently on the status row, exactly as it
  // was written, and the frame hold that will retire it. The text is kept so a
  // voice line or an agent reply that has since overwritten the row is never
  // wiped by this module's expiry: it only ever takes down its own sentence.
  let outcomeLineText = '';
  let cancelOutcomeHold = () => {};
  let toolbarRepresentationCount = 0;
  let startupPhase = 'idle';
  let reloadRequired = false, requestedMode = null, gestureActive = null;
  let capabilityRequest, capabilitySnapshot, frameCount = 0, viewCount = 0, blendMode = null, errorName = null;
  // The mode a refused blend-mode switch left for the 2D page to
  // press. It is the whole of the fallback's memory: the wearer asked for one
  // thing, the switch could not have it without a page gesture, and the page
  // now owes them exactly one button that finishes what they asked for.
  let pendingEntry = null;
  // The live `XRSession.visibilityState`. It is module state
  // rather than record state because the inspector's heartbeat asks for it
  // through the frozen API and must get an answer between sessions too.
  let sessionVisibility = 'visible';
  const runtimeEvents = supportedRuntime();
  const invalidateCapabilities = () => {
    if (!entering && !active) { capabilityRequest = undefined; capabilitySnapshot = undefined; }
  };
  runtimeEvents?.addEventListener?.('devicechange', invalidateCapabilities);

  function reportPresentationRepresentationCount() {
    // Presentation helpers live outside Canvas3D's primary representation
    // scene, so they intentionally contribute zero to frame repr admission.
    onPresentationRepresentationChange(0);
  }



  function presentationDepthRange(record, frame) {
    const ranges = [record?.toolbar?.depthRange(frame)];
    if (outcomeRepresentation && outcomeOwner === record) {
      for (const object of outcomeRepresentation.renderObjects) {
        const sphere = object.values.boundingSphere?.ref.value;
        if (!sphere?.radius) continue;
        const view = canvas.camera.view, center = sphere.center, scale = canvas.camera.scale;
        const point = [
          scale * (view[0] * center[0] + view[4] * center[1] + view[8] * center[2] + view[12]),
          scale * (view[1] * center[0] + view[5] * center[1] + view[9] * center[2] + view[13]),
          scale * (view[2] * center[0] + view[6] * center[1] + view[10] * center[2] + view[14]),
        ];
        const pose = frame.getViewerPose(record.space);
        let near = Infinity, far = -Infinity;
        for (const xrView of pose?.views ?? []) {
          const m = xrView.transform.inverse.matrix;
          const depth = -(m[2] * point[0] + m[6] * point[1] + m[10] * point[2] + m[14]);
          const radius = sphere.radius * Math.abs(scale);
          if (Number.isFinite(depth) && depth + radius > 0) { near = Math.min(near, Math.max(0.01, depth - radius)); far = Math.max(far, depth + radius); }
        }
        if (Number.isFinite(near) && Number.isFinite(far)) ranges.push({ near, far });
      }
    }
    let near = Infinity, far = -Infinity;
    for (const range of ranges) if (range && Number.isFinite(range.near) && Number.isFinite(range.far)) { near = Math.min(near, range.near); far = Math.max(far, range.far); }
    return Number.isFinite(near) && Number.isFinite(far) ? { near, far } : undefined;
  }

  async function removeOutcome(owner = outcomeOwner) {
    const representation = outcomeRepresentation;
    outcomeRepresentation = undefined;
    outcomeOwner = undefined;
    if (!representation) return;
    owner?.presentation?.remove(representation);
    representation.destroy();
    outcomeRepresentationCount = 0;
    reportPresentationRepresentationCount();
    canvas.requestDraw();
  }

  /**
   * Take the receipt down, if this module still owns the row.
   *
   * The status row has four writers -- the receipt, `Listening…`, a voice error
   * and the agent's spoken reply -- and only one of them is a command log. An
   * expiry that cleared the row unconditionally would swallow a reply the
   * wearer is reading, so the row is cleared only while it still holds the
   * exact sentence this module wrote.
   */
  async function retireOutcomeLine(record) {
    cancelOutcomeHold();
    cancelOutcomeHold = () => {};
    const drawn = outcomeLineText;
    outcomeLineText = '';
    await removeOutcome(record);
    if (disposed || active !== record || !record.toolbar) return;
    if (!shouldClearOutcomeRow({ drawn, current: record.toolbar.statusText?.() })) return;
    await record.toolbar.setStatus('');
  }

  /**
   * The page's command receipt, as much of it as the wearer should ever see.
   *
   * `outcome-line.mjs` holds the three rules and why they exist: a lesson step
   * draws nothing, a menu standing back for a lesson draws nothing, and
   * anything else is held for a few seconds of presented frames and retired.
   * `options.kind` is the change kind when a caller has one; the page sends
   * only the finished sentence today, which the rule reads instead.
   */
  async function outcome(text, status, options) {
    const record = active;
    if (!record || disposed) return;
    // Dimmed is the menu standing back for a playing chapter;
    // hidden is a grab. Neither is a wearer reading the menu.
    const asleep = () => record.toolbar?.isDimmed?.() === true || record.toolbar?.isHidden?.() === true;
    // An empty sentence retires the plate instead of drawing
    // one. The page sends it when a `Waiting` has outlived the command it was
    // drawn for, so a wearer is never left reading a state nobody holds.
    const decision = outcomeLineDecision({ text, status, kind: options?.kind, asleep: asleep() });
    const message = decision.draw ? outcomeCopy(text, status) : { text: '', color: 0 };
    const sequence = ++outcomeSequence;
    globalThis.__stereofoldDiagnostics?.record?.('outcome',
      { status: typeof status === 'string' ? status : null, text: message.text, toolbar: Boolean(record.toolbar),
        // A receipt the wearer was deliberately not shown and
        // a receipt nobody sent read the same in a headset log without this.
        drawn: decision.draw, reason: decision.reason });
    if (!decision.draw) {
      await retireOutcomeLine(record);
      return;
    }
    cancelOutcomeHold();
    cancelOutcomeHold = () => {};
    // The presenting session's own frame clock, never the
    // window's -- Quest Browser stops servicing that for the whole session, so
    // a timer-based expiry is the hang this avoids.
    const startHold = () => {
      const scheduleFrame = typeof record.session?.requestAnimationFrame === 'function'
        ? callback => record.session.requestAnimationFrame(callback) : undefined;
      cancelOutcomeHold = holdOutcomeLine({ scheduleFrame, holdMs: decision.holdMs, asleep,
        onExpire: () => {
          if (disposed || active !== record || sequence !== outcomeSequence) return;
          void retireOutcomeLine(record).catch(() => { /* A row that will not clear is still a row. */ });
        } });
    };
    // While controls exist, the status is a highlighted in-panel line. It is
    // head-anchored with the controls, so a remote placement or extreme scale
    // cannot leave feedback behind the viewer or beyond the cutaway.
    if (record.toolbar) {
      await removeOutcome(record);
      if (disposed || active !== record || sequence !== outcomeSequence) return;
      await record.toolbar.setStatus(message.text, message.color);
      if (disposed || active !== record || sequence !== outcomeSequence) return;
      outcomeLineText = message.text;
      startHold();
      return;
    }
    const sphere = Sphere3D.clone(getMolecularBounds());
    if (!Number.isFinite(sphere.radius) || sphere.radius <= 0) return;
    // This brief pre-toolbar fallback is molecular-relative. Its independent
    // presentation scene never changes Fit or scientific capture boundaries.
    // Known limit: 0.72 of the radius stays inside the bounding sphere, so
    // dense geometry can occlude this text. Moving it clear of the sphere
    // risks pushing it out of view or past a cutaway plane, and the
    // head-anchored toolbar status supersedes it within a frame or two.
    const y = sphere.center[1] - sphere.radius * 0.72;
    const builder = TextBuilder.create({ attachment: 'middle-center', background: true,
      backgroundMargin: 0.28, fontFamily: 'sans-serif', fontQuality: 2 }, 1, 1);
    builder.add(message.text, sphere.center[0], y, sphere.center[2], 0, Math.max(sphere.radius * 0.075, 0.25), 0);
    const geometry = builder.getText();
    const shape = Shape.create('Companion outcome', {}, geometry, () => Color(message.color), () => 1, () => message.text);
    const representation = ShapeRepresentation(async () => shape, Text.Utils, {
      modifyState: state => ({ ...state, pickable: false }),
    });
    await plugin.runTask(representation.createOrUpdate({ sizeFactor: 1, background: true,
      backgroundColor: Color(0x071015), backgroundOpacity: 0.94, borderColor: Color(message.color), borderWidth: 0.08,
      attachment: 'middle-center', offsetZ: 1 }, {}));
    if (disposed || active !== record || sequence !== outcomeSequence) {
      representation.destroy();
      return;
    }
    await removeOutcome(record);
    outcomeRepresentation = representation;
    outcomeOwner = record;
    record.presentation.add(representation);
    outcomeRepresentationCount = 1;
    reportPresentationRepresentationCount();
    canvas.requestDraw();
    // The molecular fallback expires on the same clock. It is
    // usually superseded by the toolbar within a frame or two, but a session
    // whose menu never builds must not be left with a receipt in front of the
    // structure for the rest of the lesson.
    startHold();
  }

  async function capabilities() {
    const runtime = supportedRuntime();
    if (!runtime) return { vr: false, ar: false };
    const check = async mode => {
      let timer;
      // Capability probing is advisory. A stalled probe must not indefinitely
      // disable a native user-initiated request or block companion heartbeats.
      // Unknown is distinct from an explicit unsupported result.
      try {
        return await Promise.race([
          Promise.resolve().then(() => runtime.isSessionSupported(mode)).then(Boolean),
          new Promise(resolve => { timer = setTimeout(() => resolve(null), 3000); }),
        ]);
      } catch { return null; }
      finally { clearTimeout(timer); }
    };
    // Query once per device state, never continuously during a native prompt.
    return capabilityRequest ??= Promise.all([check('immersive-vr'), check('immersive-ar')])
      .then(([vr, ar]) => (capabilitySnapshot = { vr, ar }));
  }

  function waitForPresentation(expected, session) {
    if (canvas.xr.isPresenting.value === expected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let subscription, settled = false;
      const settle = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { subscription?.unsubscribe(); } catch { /* The observable may already be closed. */ }
        try { session.removeEventListener('end', onEnd); } catch { /* The session may already be detached. */ }
        if (error) reject(error); else resolve();
      };
      const onEnd = () => expected ? settle(xrError('The immersive session ended before presentation started.')) : settle();
      const timer = setTimeout(() => settle(xrError(`Timed out waiting for immersive presentation to ${expected ? 'start' : 'end'}.`)), PRESENTATION_TIMEOUT_MS);
      session.addEventListener('end', onEnd, { once: true });
      subscription = canvas.xr.isPresenting.subscribe(value => { if (value === expected) settle(); });
      // BehaviorSubject subscribers can receive the current value before the
      // subscription assignment above returns.
      if (settled) {
        try { subscription.unsubscribe(); } catch { /* The callback already closed it. */ }
      }
    });
  }

  async function restore(record) {
    if (!record) return;
    if (record.restorePromise) return record.restorePromise;
    record.restorePromise = (async () => {
      record.frames?.stop();
      try { record.session.removeEventListener('end', record.onEnd); } catch { /* The UA may have detached the session already. */ }
      // An ended session is not a blind one. Clear the reading
      // before the page can poll again, or a panel that left immersion while
      // the headset was off would answer `busy` for the rest of its life.
      try { record.visibility?.stop(); } catch { /* Already detached. */ }
      try { record.foveation?.stop(); } catch { /* Also stop after a failed native end. */ }
      try { record.governor?.stop(); } catch { /* It only unwraps the ending layer. */ }
      sessionVisibility = 'visible';
      // The owed resume and its subscription die with the
      // session, or a tour started on the desktop afterwards would be resumed
      // by a record nobody is wearing.
      try { record.tourResume?.dispose(); } catch { /* The player may already be gone. */ }
      // A plate re-solve owed to a menu that no longer exists.
      // Its timer would fire into a torn-down session and ask the viewer to
      // rebuild labels for a column that is gone.
      try { record.menuResolve?.dispose(); } catch { /* The timer is already clear. */ }
      try { record.replyCaption?.(); } catch { /* The window listener may already be detached. */ }
      try { record.voiceCommands?.dispose(); } catch { /* The emitter may already be gone. */ }
      const cleanupNotes = [];
      const finalize = (resource, release, timeoutMs = FINALIZER_TIMEOUT_MS) => withTimeout(Promise.resolve().then(release), timeoutMs,
        `Timed out releasing ${resource}.`, 'xr_finalizer_timeout').catch(error => {
        cleanupNotes.push({ resource, code: error?.code ?? 'xr_finalizer_error',
          error: error?.message ?? String(error) });
        throw error;
      });
      try { await finalize('capture', () => record.pushToTalk?.dispose()); } catch { /* Continue after a failed or stalled capture release. */ }
      releasePushToTalkMicrophone(); // Also release a grant no Talk press adopted.
      // Keep the page's voice controller reusable, but release its native audio.
      const audioCleanup = await Promise.allSettled([
        finalize('voice', () => getVoiceInteraction()?.release?.()),
        finalize('reply', () => globalThis.__stereofoldReplyAudio?.release?.()),
      ]);
      // The session may have ended from the headset rather than viewer.xr.end.
      // Stop its draw loop before returning the desktop loop to Mol*.
      try { canvas.pause(true); } catch { /* The context can already be lost. */ }
      try {
        if (record.toolbar) await withTimeout(record.toolbar.dispose(), STARTUP_TIMEOUT_MS,
          'Timed out closing the immersive controls.', 'xr_teardown_timeout');
      } catch {
        // The toolbar owns pending XR input work. Do not let a late cleanup
        // race make a subsequent native request against an uncertain scene.
        reloadRequired = true;
      }
      // A native end clears `active` before disposal, so do not rely on the
      // toolbar callback to publish its zero count.
      toolbarRepresentationCount = 0;
      reportPresentationRepresentationCount();
      // The frame hold dies with the session that was
      // clocking it, before the row it would have cleared is gone.
      cancelOutcomeHold(); cancelOutcomeHold = () => {}; outcomeLineText = '';
      try { await removeOutcome(record); } catch { outcomeRepresentationCount = 0; reportPresentationRepresentationCount(); }
      try { record.presentation?.dispose(); } catch { /* Context loss can own the GL teardown. */ }
      // The desktop canvas has no head to rotate against, so the hold is
      // released with the session that took it. Released after the
      // presentation layer, which is the only other thing that reads it.
      try { record.releaseHeadRotation?.(); } catch { /* A replaced camera owns its own property. */ }
      // Restore wrappers in reverse installation order before returning to
      // desktop draws. Each is session-local and owns no scientific state.
      try { record.restoreLayer?.(); } catch { /* The wrapper only removes MSAA. */ }
      try { record.pointer?.restore(); } catch { /* The stock helper can recover on the desktop. */ }
      try { record.renderBudget?.restore(); } catch { /* The desktop loop restarts regardless. */ }
      try { record.headObserver?.restore(); }
      finally {
        try { record.frameCost?.stop(); } catch { /* Sampling must not prevent cleanup. */ }
        try { record.sceneDepth?.restore(); }
        finally {
          try { record.presentationDepth?.restore(); }
        finally {
          record.frames?.restore();
          record.restoreRendererEnd?.();
          if (record.loopStopped && record.sessionClosed !== false && !disposed && canResumeDesktop()) {
            plugin.animationLoop.start();
            canvas.requestResize();
            canvas.requestDraw();
          }
        }
      }
      }
      // The immersive quality is coarser than any desktop panel should show.
      // Rebuilding on the way out is the mirror of the entry rebuild and runs
      // after the desktop loop is back, so a failure costs detail, not a draw.
      // A wearer who leaves within a second of entering can be here while the
      // entry rebuild is still committing. Both rebuilds drive the same Mol*
      // representation, so give entry the finalizer deadline to land first.
      // A stalled commit must not prevent the desktop restoration attempt.
      // A blend-mode switch is not a departure. Rebuilding the
      // structure at desktop quality on the way out and at immersive quality
      // again on the way back in costs the wearer seconds of a rebuild they
      // never see, on the one path whose whole budget is the five-second
      // transient-activation window. The wearer is going straight back into a
      // headset, so leave the immersive geometry exactly where it is.
      // A refused replacement returns to the page after teardown has settled.
      // Keep this bounded tail callable without repeating renderer/audio exit.
      record.restoreAppearance = async () => {
        const rebuildAppearance = record.presentedRebuild && !record.switching;
        try {
          if (rebuildAppearance) await finalize('presented-rebuild', () => record.presentedRebuild);
        } catch { /* Continue after a failed or stalled entry rebuild. */ }
        finally {
          try {
            if (rebuildAppearance) await finalize('leaving-presentation', () => onLeavingPresentation(), APPEARANCE_TIMEOUT_MS);
          } catch { /* The desktop loop remains usable without the quality rebuild. */ }
          finally {
            // Pending attachment cleanup still needs its native session. Settled
            // exits release the record even when either appearance rebuild fails.
            if (!entering) {
              record.session = undefined;
              record.space = undefined;
            }
            try { globalThis.__stereofoldDiagnostics?.record?.('xr-session-cleanup', {
              source: record.ending ? 'page' : 'native', nativeEnded: record.sessionClosed,
              ...record.frames?.snapshot(), recordSessionHeld: Boolean(record.session),
              rendererSessionHeld: Boolean(canvas.webgl.xr.session),
              presenting: Boolean(canvas.xr.isPresenting.value),
              audioReleaseFailures: audioCleanup.filter(result => result.status === 'rejected').length,
              ...(cleanupNotes.length ? { cleanupNotes } : {}),
            }); } catch { /* Cleanup never depends on diagnostics. */ }
          }
        }
      };
      await record.restoreAppearance();
    })();
    return record.restorePromise;
  }

  /**
   * The three live readings a visibility decision needs.
   *
   * All three are read at the moment the transition arrives rather than held,
   * because a press can open and a tour can start at any point between two
   * visibility events.
   */
  function tourState() {
    try { return getSpatialTour()?.getState?.(); }
    catch { return undefined; /* A tour controller mid-teardown answers nothing; that is not blind. */ }
  }

  function visibilityContext(record) {
    const tour = tourState();
    return {
      talking: record.pushToTalk?.listening?.() === true,
      autoplay: tour?.autoplay === true,
      tourActive: tour?.active === true,
      resumeOnVisible: record.tourResume?.owed() === true,
    };
  }

  /**
   * Act on one `XRSession` visibility transition.
   *
   * Cancel input ownership and retain the tour's resume intent, then close
   * the microphone before acting on the tour and menu. Every step is wrapped,
   * because a session going blind is exactly
   * when the page can least afford a thrown handler.
   */
  function applyVisibilityTransition(record, transition) {
    if (active !== record) return;
    sessionVisibility = transition.to;
    try { onInputVisibility(transition.blind, record.session?.inputSources); }
    catch (error) { recordXrFrameError('input-visibility', error); }
    // A transition that says `resume` has already taken the
    // intent off the transition, so fold it back on. A tour still rendering a
    // scene keeps the intent too: mid-visit it can read as not yet active, and
    // the transition would otherwise spend the resume on a tour that is about
    // to be on a scene. `record.tourResume.attempt` is the only thing allowed
    // to clear it.
    record.tourResume?.set(transition.resumeOnVisible || transition.tourAction === 'resume'
      || (record.tourResume.owed() && record.tourResume.navigating()));
    if (transition.cancelTalk) {
      try { void record.pushToTalk?.cancel?.(`xr-${transition.to}`); }
      catch { /* A binding mid-teardown has nothing left to cancel. */ }
    }
    if (transition.tourAction === 'pause') {
      try { getSpatialTour()?.pause?.('The headset stopped showing this session.'); }
      catch { /* The tour controller is optional; visibility handling is not. */ }
    }
    // A blind session receives no input, so a trigger held when
    // the system dialog took focus never gets its release. Let the menu forget
    // the lit row and the action it captured, or the wearer comes back to a
    // glowing row and the next select runs a control they let go of.
    if (transition.blind) {
      try { record.toolbar?.blur?.(); }
      catch { /* The menu is optional; visibility handling is not. */ }
    }
    try { globalThis.__stereofoldDiagnostics?.record?.(transition.diagnostic.kind, transition.diagnostic.detail); }
    catch { /* The page may have no diagnostics hook installed. */ }
    // The owed resume is attempted here rather than consumed
    // by the transition, because the player refuses one while a scene visit is
    // still settling (`togglePlay` returns early on `navigating`). The intent
    // survives that case and the tour's own subscription spends it when the
    // visit lands.
    if (!transition.blind) record.tourResume?.attempt('visible-edge');
    // The menu's Play label follows the tour player's own subscription, which
    // `setSpatialTour` already wires to `refreshToolbar`. Nothing to redraw here.
  }

  function installRendererEndOwner(record) {
    const xr = canvas.webgl.xr, original = xr.end;
    // Stock Mol* controls and page controls share the same native close even
    // when a DOM/pagehide exit arrives before the platform queues its end event.
    const endOnce = function () {
      return record.rendererEndPromise ??= Promise.resolve().then(() => original.call(xr));
    };
    xr.end = endOnce;
    record.restoreRendererEnd = () => { if (xr.end === endOnce) xr.end = original; };
  }

  function observeSessionEnd(record) {
    if (active !== record) return;
    active = undefined;
    record.sessionClosed = true;
    record.frames?.stop();
    startupPhase = 'idle';
    // An end event can precede end()'s platform-shutdown promise. The explicit
    // exit must own restoration until that promise settles.
    if (record.ending) return;
    // The WebGL end listener emits Canvas3D's false presentation state before
    // the desktop loop is allowed to resume. A native headset end can arrive
    // outside viewer.xr.end(), so retain the same ordering here.
    let closePromise;
    closePromise = withTimeout(record.rendererEndPromise, SESSION_END_TIMEOUT_MS,
      'Timed out closing the headset display.', 'xr_teardown_timeout')
      .catch(() => { reloadRequired = true; record.sessionClosed = false; })
      .then(() => waitForPresentation(false, record.session)).catch(() => {}).then(() => restore(record))
      .finally(() => { if (ending === closePromise) ending = undefined; });
    ending = closePromise;
  }

  async function detachEndedRecord(record) {
    // Canvas3D observes a WebGL XR session change and resets its private
    // manager itself. The public API intentionally has no setSession/session.
    if (canvas.webgl.xr.session !== record.session) return;
    try {
      await withTimeout(canvas.webgl.xr.end(), SESSION_END_TIMEOUT_MS,
        'Timed out closing the renderer XR session.', 'xr_teardown_timeout');
      record.sessionClosed = true;
    } catch {
      reloadRequired = true;
    }
  }

  async function enter(mode) {
    const xrMode = MODES.get(mode);
    if (!xrMode) throw new TypeError('XR mode must be vr or ar.');
    if (disposed) throw xrError('The viewer has been disposed.');
    if (reloadRequired) throw xrError('Reload this page to clear the previous headset request.');
    if (active) {
      if (active.mode === xrMode) return;
      throw xrError('End the current immersive session before entering another mode.');
    }
    if (entering) return entering;
    entering = (async () => {
      let session, record;
      try {
        if (ending) throw xrError('The previous headset view is still closing. Try Enter VR again when it finishes.');
        if (disposed) throw xrError('The viewer has been disposed.');
        if (!isReady()) throw xrError('Load a ready structure before entering immersion.');
        const runtime = supportedRuntime();
        if (!runtime) throw xrError('This browser does not support immersive sessions.');
        // Keep initial entry to the local space actually used by this viewer.
        // Controllers need no hand-tracking or floor-space feature grant.
        startupPhase = 'requesting-headset';
        requestedMode = xrMode;
        frameCount = 0; viewCount = 0; blendMode = null; errorName = null;
        gestureActive = navigator.userActivation?.isActive ?? null;
        // Safari is asked for no hand tracking, so it keeps drawing the
        // wearer's real hands, and it gets longer to answer, because its own
        // consent prompt holds the request (`xr-session-request.mjs`).
        session = await requestHeadsetSession(runtime, xrMode, { optionalFeatures: headsetOptionalFeatures(globalThis.navigator),
          timeoutMs: headsetEntryDeadlineMs(globalThis.navigator), onTimeout: () => { reloadRequired = true; } });
        blendMode = ['opaque', 'alpha-blend', 'additive'].includes(session.environmentBlendMode) ? session.environmentBlendMode : null;
        if (disposed) {
          if (!await closeNativeSession(session)) reloadRequired = true;
          throw xrError('The viewer has been disposed.');
        }
        startupPhase = 'locating-headset';
        const space = await withTimeout(session.requestReferenceSpace('local'), STARTUP_TIMEOUT_MS,
          'Timed out locating the headset tracking space. Reload this page to try again.');
        if (disposed) {
          if (!await closeNativeSession(session)) reloadRequired = true;
          throw xrError('The viewer has been disposed.');
        }
        const releaseSessionHeadRotation = holdHeadRotationZero(canvas.camera);
        globalThis.__stereofoldDiagnostics?.record?.('label-facing-hold', {
          held: typeof Object.getOwnPropertyDescriptor(canvas.camera ?? {}, 'headRotation')?.get === 'function',
        });
        record = { mode: xrMode, session, space, presentation: createPresentationScene(canvas), loopStopped: false,
          releaseHeadRotation: releaseSessionHeadRotation,
          sessionClosed: false, attachSettled: false, attachTimedOut: false, attachPromise: undefined,
          onEnd: undefined, molecularDepth: { near: 0, far: Infinity } };
        installRendererEndOwner(record);
        record.onEnd = () => observeSessionEnd(record);
        session.addEventListener('end', record.onEnd);
        active = record;
        record.frames = trackXrFrames(session);
        // Installed before anything that can open a microphone or
        // start a tour, so no press and no autoplay can outlive the first
        // transition into blindness.
        // The owed-resume holder, created before the watch so
        // the very first transition already has somewhere to put its intent.
        record.tourResume = createTourResumeIntent({
          getTour: () => getSpatialTour(),
          isVisible: () => !blindVisibility(sessionVisibility),
          isCurrent: () => active === record,
          onDiagnostic: detail => globalThis.__stereofoldDiagnostics?.record?.(XR_VISIBILITY_DIAGNOSTIC,
            { ...detail, visibility: sessionVisibility }),
        });
        record.visibility = watchSessionVisibility(session,
          transition => applyVisibilityTransition(record, transition),
          { context: () => visibilityContext(record) });
        sessionVisibility = record.visibility.state();

        // These adapters are the existing narrow Mol* 5.11 presentation
        // workarounds. They are installed only while this exact session lives.
        record.presentationDepth = installPresentationDepthAdapter(plugin);
        record.sceneDepth = installSceneDepthAdapter({ session, space, canvas, Mat4, deliberateClipping,
          presentationDepth: frame => presentationDepthRange(record, frame),
          onMolecularDepth: depth => { record.molecularDepth = depth; } });
        // Install before the observer so the timer surrounds its callback,
        // including synchronous input and post-render seating work.
        record.frameCost = watchFrameCost({ session });
        record.headObserver = installHeadFrameObserver({ session, space, mode: xrMode, drawCount: getDrawCount,
          isVisible: () => active === record && !blindVisibility(sessionVisibility), onInputFrame: context => {
          // Before the draw, so a rung chosen on this frame sets this frame's
          // eye viewports. Never throws.
          record.governor?.frame(context.time);
          // Menu ownership must be resolved before the same frame's molecular
          // controllers. Both operate before rendering; captures stay below.
          return (record.frameCost?.measure ?? (fn => fn()))(() => {
            try {
              try {
                const pose = record.toolbar?.syncPose?.();
                if (pose && typeof pose.catch === 'function') pose.catch(error => {
                  errorName = 'Error';
                  recordXrFrameError('toolbar-pose-promise', error);
                });
              } catch (error) { recordXrFrameError('toolbar-pose', error); }
              try { record.toolbar?.syncInput?.(context.frame); }
              catch (error) { recordXrFrameError('toolbar-input', error); }
              try { return onInputFrame(context); }
              catch (error) { recordXrFrameError('viewer-input-frame', error); return undefined; }
            } catch (error) {
              recordXrFrameError('frame-overlay', error);
              return undefined;
            }
          });
        }, onHeadFrame: context => {
          frameCount = Math.min(1_000_000_000, frameCount + 1);
          viewCount = Math.min(8, context.frame.getViewerPose(space)?.views.length ?? 0);
          return (record.frameCost?.measure ?? (fn => fn()))(() => onHeadFrame(context));
        } });
        plugin.animationLoop.stop({ noDraw: true });
        record.loopStopped = true;
        // This is the stock public WebGL context boundary. Its change signal
        // drives Canvas3D's private XR manager and public isPresenting state.
        startupPhase = 'connecting-display';
        // Mol* builds the XR layer inside `xr.set` and asks for MSAA, which
        // switches fixed foveation off on Quest. The wrapper is installed for
        // the life of the session and undone in `restore()` below.
        // `?xrRenderBudget=msaa:on` keeps it, to measure that trade on a headset.
        record.restoreLayer = renderBudgetOverrides().msaa === true ? () => {}
          : disableXrLayerMsaa(globalThis, session); // Never throws; only measured Quest classes trade MSAA for foveation.
        const attachPromise = Promise.resolve(canvas.webgl.xr.set(session, { resolutionScale: xrResolutionScale({ session, plugin }) })); // Layer scale is fixed at creation.
        record.attachPromise = attachPromise;
        void attachPromise.then(() => {
          record.attachSettled = true;
          if (record.attachTimedOut) void closeNativeSession(record.session).catch(() => {});
        }, () => { record.attachSettled = true; }).catch(() => {});
        await withTimeout(attachPromise, STARTUP_TIMEOUT_MS,
          'Timed out connecting the headset display. Reload this page to try again.');
        startupPhase = 'starting-presentation';
        await waitForPresentation(true, session);
        // A bare applyFoveation here always missed. WebXR
        // applies the render state at the top of the next animation frame, and
        // none has run yet, so the base layer is still null. The watch writes
        // the level the moment the layer exists and again if it is replaced,
        // and stops itself when the session ends.
        record.foveation = trackFoveation(session); // Session cleanup also owns the timer if native end fails.
        record.renderBudget = beginXrRenderBudget({ plugin, canvas, session }); // Never throws.
        record.governor = installFrameGovernor({ session }); // Never throws; `governor:` in the budget knobs switches it.
        // A headset may end the session while Canvas3D is attaching it. Do
        // not restart that ended XR loop after its end handler restored the
        // desktop loop.
        if (disposed || active !== record || canvas.webgl.xr.session !== session || !canvas.xr.isPresenting.value) {
          await detachEndedRecord(record);
          throw xrError('The immersive session ended before it became active.');
        }
        // Submit the molecular scene immediately. A physical headset can wait
        // for its first submitted frame before completing the transition out
        // of the browser. Toolbar construction itself needs XR frames, so it
        // must never gate starting the render loop.
        record.pointer = installXrPointer({ canvas, menuPoint: () => record.toolbar?.aimPoint?.(),
          onManager: manager => attachXrConsumedTriggerClickGuard({ manager,
            isPresenting: () => canvas.xr.isPresenting.value, consumesClick: consumesTriggerClick }) });
        canvas.animate();
        // The structure on screen was built for the desktop panel, where Mol*
        // sizes cartoon subdivisions from the site count and leaves ribbon
        // tubes double-sided. The wearer pays that vertex and fill count twice
        // per frame. Rebuilding it at the immersive quality is the single
        // largest saving available, and it is deliberately not awaited: the
        // menu must not wait on a representation rebuild, and a rebuild that
        // fails leaves the wearer with the geometry already in front of them.
        record.presentedRebuild = Promise.resolve()
          .then(() => onPresented({ session }))
          .catch(() => {}); // Geometry quality is best-effort.
        startupPhase = 'preparing-menu';
        record.toolbar = createSpatialToolbar({
          plugin, canvas, presentation: record.presentation, session, space, Mat4, onAction: onSpatialAction, onActionIntent: onSpatialActionIntent, getState: getSpatialState,
          getMolecularBounds, getEntryGeometry, getDepthRange: () => record.molecularDepth,
          onActionError: error => {
            globalThis.__stereofoldDiagnostics?.record?.('toolbar-action', { phase: 'failed', error: String(error?.message ?? error) });
          },
          onConsumeSelect: onConsumeSpatialSelect,
          onRepresentationChange: count => {
            if (active !== record) return;
            toolbarRepresentationCount = count;
            reportPresentationRepresentationCount();
            if (count > 0) menuRedrawn(record);
          },
        });
        // Push-to-talk is an accessory to the session, not a startup stage:
        // a failure to bind it must never block entering immersion. Holding A
        // or X reaches this binding through the viewer's button reader, and
        // the toolbar's Talk row reaches the same one; `status` is the menu's
        // own status row, which is the only place the listening state and the
        // spoken reply are shown now that the floating orb is gone.
        //
        // `listeningText` is the one line that names Claude, and
        // this is the only place it is drawn. It is a reader, not a string,
        // because an agent may attach or fall away between presses.
        try {
          const sharedVoice = getVoiceInteraction?.();
          const listeningText = () => listeningStatusLine();
          if (sharedVoice?.start && sharedVoice?.stop) {
            // The inspector's controller already owns capture, OAuth delivery,
            // and playback. Avoid opening a second microphone stream.
            record.pushToTalk = attachGripPushToTalk({ session, interaction: sharedVoice, listeningText,
              status: (text, progress) => record.toolbar?.setStatus(text, undefined, progress) });
          } else {
            const transport = voiceCommandSender?.();
            if (transport?.start && transport?.send) {
              const capture = createVoiceCapture();
              record.pushToTalk = attachGripPushToTalk({ session, capture, sendVoice: transport, onCommand: onVoiceCommand, listeningText,
                status: (text, progress) => record.toolbar?.setStatus(text, undefined, progress) });
            } else {
              // Keep the optional grip signal available, but never open a
              // microphone that has no authenticated delivery path.
              record.pushToTalk = attachGripPushToTalk({ session, listeningText,
                status: (text, progress) => record.toolbar?.setStatus(text, undefined, progress) });
            }
          }
        } catch { /* Microphone capture is unavailable; grip signalling still remains optional. */ }
        // The Mac transcribes the press and returns the text on
        // the streamer's `heard` event; this is what runs it. Without it the
        // wearer's words reach the caption plate and change nothing.
        try {
          record.voiceCommands = attachVoiceCommandRunner({
            events: record.pushToTalk?.audioEvents,
            dispatch: action => onSpatialAction(action),
            // The menu's status row, and the head-seated caption
            // the wearer is actually looking at. The menu is about 47 degrees
            // off to one side of a Quest 2 field of view; a wearer facing the
            // structure reads none of it.
            caption: text => { showTalkOutcome(text); return record.toolbar?.setStatus(text); },
            speak: (text, timing) => voiceCommandSpeaker()?.(text, timing),
            // The two readings the grammar cannot make for
            // itself. Whether the structure is turning decides what a bare
            // "stop" means, and whether an agent is listening decides whether
            // a sentence the page cannot act on died or was handed on.
            spinning: () => getSpatialState()?.motion?.paused === false,
            getGeometryBudget: () => getSpatialState()?.geometryBudget,
            agentAttached: () => agentAttached(),
            // The lesson's own nouns. Without this the
            // wearer's only route back to a part the lesson named was to wait
            // for the chapter that named it to come round again.
            lessonParts: () => getLessonParts(),
            lesson: () => ({ title: getSpatialTour()?.getState?.()?.selectedTitle }),
            // "go to residue 141" means the browser's page while the
            // browser has the menu, and the molecule's framing while it does
            // not. This reading is what decides which, and it is the same
            // `sequence.open` the toolbar publishes and the driver verifies.
            sequenceOpen: () => getSpatialState()?.sequence?.open === true,
          });
        } catch { /* A page with no push-to-talk streamer simply has no local commands. */ }
        // The agent's spoken answer, in writing, on the menu's status row.
        //
        // The Mac puts its reply on the `poll_inspection` heartbeat, and the
        // companion panel republishes it as one `stereofold-headset-reply`
        // event. The floating talk orb used to be the only thing that drew it;
        // the orb was deleted because it sat in front of the structure, so the
        // status row draws it instead. The audible clip is
        // unaffected: `reply-audio.mjs` listens to the same event and plays it.
        try {
          // A reply that was split into segments draws only its opening line
          // here. `reply-segments.mjs` advances the row as each later segment
          // starts, so the wearer reads the sentence being spoken rather than
          // a paragraph that scrolled past in one frame.
          //
          // An answer holds for its own reading window. The
          // Mac names it on the caption (`holdSeconds`, 2-15 s, default 6) and
          // the segment names how long it sounds; the plate keeps whichever is
          // longer. The three-second control-feedback hold took a 117-character
          // reply down at 3.08 s while its clip was still playing at 7.05 s.
          const onReply = event => {
            const caption = event?.detail;
            const segments = replySegmentsOf(caption);
            const segment = segments.length ? segments[0] : undefined;
            const text = segment ? segment.text : caption?.text;
            if (typeof text === 'string' && text.trim())
              record.toolbar?.setStatus(text.trim(), undefined, undefined, replyCaptionHoldMs(segment, caption), Boolean(caption?.refusalScope),
                seat => recordTalkReplySeat(caption, seat));
          };
          const onSegment = event => {
            const text = event?.detail?.text;
            if (typeof text === 'string' && text.trim())
              record.toolbar?.setStatus(text.trim(), undefined, undefined, replyCaptionHoldMs(event?.detail, event?.detail));
          };
          globalThis.addEventListener?.(REPLY_CAPTION_EVENT, onReply);
          globalThis.addEventListener?.(REPLY_SEGMENT_EVENT, onSegment);
          record.replyCaption = () => {
            try { globalThis.removeEventListener?.(REPLY_CAPTION_EVENT, onReply); } catch { /* Already detached. */ }
            try { globalThis.removeEventListener?.(REPLY_SEGMENT_EVENT, onSegment); } catch { /* Already detached. */ }
          };
        } catch { /* A page with no event target simply shows no written reply. */ }
        await withTimeout(record.toolbar.update(), STARTUP_TIMEOUT_MS,
          'Timed out preparing the immersive controls. Reload this page to try again.');
        if (disposed || active !== record || !canvas.xr.isPresenting.value) {
          throw xrError('The immersive session ended while its controls were preparing.');
        }
        startupPhase = 'active';
        // The panel has drawn, so `menuPoints()` finally has a
        // rectangle to give. Anything that seats itself around the menu — the
        // component name plates above all — solved without one until now and
        // has to be asked again. Best-effort and never awaited: a re-solve
        // that fails must not fail an entry the wearer has already made.
        try { onMenuPlaced({ session }); } catch { /* The plates keep the layout they have. */ }
        // That pass solved against the column as it stands now,
        // so this footprint is already accounted for. Seeding it keeps the
        // first redraw after entry — a status line arriving, a tour loading —
        // from asking for the same layout a second time.
        try { menuResolveFor(record).seed(menuPoints()); } catch { /* The first motion seeds it instead. */ }
        // The wearer is in the mode they asked for, so the page
        // owes them no button. Clearing it here covers both routes back in —
        // the optimistic switch and the wearer pressing the button itself.
        pendingEntry = null;
      } catch (error) {
        errorName = ['NotAllowedError','NotSupportedError','InvalidStateError','SecurityError','AbortError','OperationError','TypeError'].includes(error?.name) ? error.name : 'Error';
        // Once the native session has been granted, a stalled tracking,
        // renderer, or teardown stage can leave browser-owned XR state in an
        // unknown condition. Require a fresh page before another request.
        if (error?.code === 'xr_startup_timeout' || error?.code === 'xr_teardown_timeout') reloadRequired = true;
        if (record) {
          if (record.attachPromise && !record.attachSettled) {
            // Mol* may have assigned its private XR session before its
            // compatibility/layer promise settles. A late resolution can
            // otherwise repopulate that private session after this cleanup.
            record.attachTimedOut = true;
            reloadRequired = true;
          }
          if (active === record) active = undefined;
          await detachEndedRecord(record);
          try {
            if (canvas.webgl.xr.session === record.session) {
              await withTimeout(canvas.webgl.xr.end(), SESSION_END_TIMEOUT_MS,
                'Timed out closing the headset display.', 'xr_teardown_timeout');
              // A fulfilled renderer end already closed its native session.
              record.sessionClosed = true;
            }
            if (!record.sessionClosed) record.sessionClosed = await closeNativeSession(record.session);
            if (!record.sessionClosed) reloadRequired = true;
            if (record.attachTimedOut && !record.attachSettled) record.sessionClosed = false;
          } catch { reloadRequired = true; }
          await waitForPresentation(false, record.session).catch(() => {});
          await restore(record);
        } else if (session) {
          if (!await closeNativeSession(session)) reloadRequired = true;
        }
        throw error;
      }
    })();
    try { await entering; }
    finally { entering = undefined; }
  }

  async function endRecord(record) {
    // Pause the XR canvas first: the desktop animation loop does not resume
    // until session end and adapter restoration have completed.
    try {
      record.ending = true;
      record.frames?.stop();
      canvas.pause(true);
      try {
        if (canvas.webgl.xr.session === record.session) {
          await withTimeout(canvas.webgl.xr.end(), SESSION_END_TIMEOUT_MS,
            'Timed out closing the headset display.', 'xr_teardown_timeout');
          // A fulfilled end promise is terminal even before the queued end
          // event reaches observeSessionEnd. Never call native end again.
          record.sessionClosed = true;
        }
      } catch (error) {
        reloadRequired = true;
        throw error;
      }
      if (!record.sessionClosed) record.sessionClosed = await closeNativeSession(record.session);
      if (!record.sessionClosed) {
        reloadRequired = true;
        throw xrTimeout('Timed out closing the headset session.', 'xr_teardown_timeout');
      }
      try { await waitForPresentation(false, record.session); }
      catch (error) {
        reloadRequired = true;
        throw error;
      }
    } finally {
      if (active === record) active = undefined;
      await restore(record);
    }
  }

  async function end() {
    if (entering) await entering.catch(() => {});
    if (ending) return ending;
    const record = active;
    if (!record) return;
    // Publish the shared teardown promise before its first await. A second
    // leave/dispose call must join this operation instead of ending the same
    // XRSession concurrently.
    let closePromise;
    closePromise = endRecord(record).finally(() => { if (ending === closePromise) ending = undefined; });
    ending = closePromise;
    return closePromise;
  }

  /**
   * Go from one blend mode to the other without leaving the wearer
   * on a 2D page wondering what happened.
   *
   * Passthrough is the right default, but plain VR used to be unreachable:
   * asking for the room to go away ended the session and dropped the wearer
   * onto the companion page with nothing marked. A session's environment blend
   * mode is fixed at
   * grant time, so the switch genuinely is end-then-request; what was missing
   * is everything after the end.
   *
   * The request is optimistic. Chromium — which is what Quest Browser is —
   * requires transient activation for an immersive request and grants none for
   * anything that happens inside a session; `entryRefusalReason` carries the
   * source reading. So this tries the re-entry immediately, because a runtime
   * that does allow it costs the wearer nothing at all, and hands a refusal to
   * the page as `pendingEntry` rather than as an error the wearer cannot act
   * on. Either way the caller is told which happened and never has to guess.
   *
   * It never throws for a refusal. A switch that cannot complete is a state the
   * wearer has to be told about, not an exception to be swallowed by a menu row.
   *
   * @param {string} mode `vr`, `ar`, or either full `immersive-` name
   * @returns {Promise<{entered:boolean, mode:string, blendMode:string|null,
   *   switched:boolean, retained?:boolean, reason?:string, activation:boolean|null, error?:Error}>}
   */
  async function switchMode(mode) {
    const xrMode = MODES.get(mode);
    if (!xrMode) throw new TypeError('XR mode must be vr or ar.');
    const record = active;
    // Nothing is presenting, or the wearer is already in the mode they asked
    // for. Both are plain entries and neither needs the teardown below.
    if (!record) {
      await enter(xrMode);
      return { entered: true, mode: xrMode, blendMode: liveBlendMode(), switched: false, activation: activationState() };
    }
    if (record.mode === xrMode) return { entered: true, mode: xrMode, blendMode: liveBlendMode(), switched: false, activation: activationState() };
    // An opaque session is working VR. Prove that the runtime offers AR before
    // ending it. A false answer and a failed capability check are both unsafe
    // to act on. Repeated asks share the same probe and leave the same native
    // session running.
    if (xrMode === 'immersive-ar') {
      const support = await capabilities();
      if (support.ar !== true) return { entered: false, mode: xrMode, blendMode: liveBlendMode(), switched: false,
        retained: true, reason: support.ar === false ? 'unsupported' : 'unknown', activation: activationState() };
    }
    // Read the activation before the teardown, because the teardown is what
    // spends the clock: transient activation expires five seconds after the
    // gesture that granted it, and this is the reading that says whether the
    // attempt below ever had a chance.
    const activation = activationState();
    record.switching = true;
    pendingEntry = null;
    try { await end(); }
    catch (error) {
      // A teardown that failed has already set `reloadRequired`, and the page
      // owns that path. Offering a button that cannot work is worse than none.
      if (!reloadRequired) pendingEntry = { mode: xrMode, reason: 'failed' };
      return { entered: false, mode: xrMode, blendMode: liveBlendMode(), switched: false, reason: 'failed', activation, error };
    }
    try {
      await enter(xrMode);
      return { entered: true, mode: xrMode, blendMode: liveBlendMode(), switched: true, activation };
    } catch (error) {
      const reason = entryRefusalReason(error);
      // A support probe may be stale or optimistic. If the native AR request
      // says the mode is unsupported, mark it unavailable and restore the VR
      // mode that was working before this switch.
      if (xrMode === 'immersive-ar' && reason === 'unsupported' && !reloadRequired) {
        capabilitySnapshot = { ...(capabilitySnapshot ?? { vr: null }), ar: false };
        capabilityRequest = Promise.resolve(capabilitySnapshot);
        try {
          await enter(record.mode);
          return { entered: false, mode: xrMode, blendMode: liveBlendMode(), switched: false,
            retained: true, restored: true, reason, activation, error };
        } catch { /* The page fallback below is still available. */ }
      }
      record.switching = false;
      await record.restoreAppearance();
      if (!reloadRequired) pendingEntry = { mode: xrMode, reason };
      return { entered: false, mode: xrMode, blendMode: null, switched: false, reason, activation, error };
    }
  }

  function activationState() {
    try { return globalThis.navigator?.userActivation?.isActive ?? null; }
    catch { return null; }
  }

  /**
   * The blend mode actually running, not the one that was asked for.
   *
   * The agent reads this to know which session the wearer is in after a switch.
   * A live session is the truth; the last recorded value stands in once one has
   * ended, so leaving immersion does not erase what the wearer was just in.
   */
  function liveBlendMode() {
    let live;
    try { live = active?.session?.environmentBlendMode; } catch { live = undefined; }
    return ['opaque', 'alpha-blend', 'additive'].includes(live) ? live : blendMode;
  }

  function syncBounds() {
    // Helper scenes have independent render bounds and never affect molecular
    // Fit/XR scale. Keep the existing API as a presentation redraw hook.
    active?.presentation?.update(outcomeRepresentation);
    active?.toolbar?.syncBounds();
  }

  /**
   * The drawn plates, in XR room metres, for a framing that has
   * to stay behind them. Empty whenever there is nothing on the glass to lose.
   */
  function platePoints() {
    try { return active?.toolbar?.platePoints?.() ?? []; } catch { return []; }
  }

  /**
   * The caption card alone, for the screen-space seat. The
   * depth rule above keeps the structure behind EVERY plate; this one decides
   * which corner of the lens the subject may not sit in, and only the caption
   * gets to claim one.
   */
  function captionPoints() {
    try { return active?.toolbar?.captionPoints?.() ?? []; } catch { return []; }
  }

  /**
   * The menu column alone, for the screen-space check that
   * runs after the caption seat. The depth rule still uses every plate.
   *
   * The volume screen-space seat clears this same rectangle, so
   * the map never covers the menu.
   */
  function drawnMenuPoints() {
    try { return active?.toolbar?.drawnMenuPoints?.() ?? []; } catch { return []; }
  }

  /** Reserved label obstacle, including the last seat during a grab. */
  function menuPoints() {
    try { return active?.toolbar?.menuPoints?.() ?? []; } catch { return []; }
  }

  /**
   * A committed redraw has moved or reshaped the menu column.
   *
   * The status block is reserved at entry, and the wearer moves the column
   * outright: the Move row re-seats the column, the Menu row folds and opens
   * it, a reset view does both. Anything solved around the column — the
   * component name plates above all — was solved against where it used to be.
   *
   * This is only the notice. `createMenuResolve` decides whether
   * the footprint actually moved, waits for the motion to settle, and asks for
   * one re-solve naming every reason that went into it. A caption-only redraw
   * inside an unchanged glass is not a motion and rebuilds nothing.
   */
  function menuRedrawn(record) {
    if (active !== record || startupPhase !== 'active') return;
    menuResolveFor(record).moved({ points: menuPoints(), reason: menuMotion(record) });
  }

  /** Why the panel just redrew, as the toolbar sees it. Never throws, never empty. */
  function menuMotion(record) {
    let motion;
    try { motion = record.toolbar?.menuMotion?.(); } catch { motion = undefined; }
    return Array.isArray(motion) && motion.length ? motion : 'follow';
  }

  /** The record's own coalescer, built on the first motion and disposed with it. */
  function menuResolveFor(record) {
    record.menuResolve ??= createMenuResolve({
      solve: reason => { try { onMenuPlaced({ session: record.session, reason }); } catch { /* Keep the existing label layout. */ } },
    });
    return record.menuResolve;
  }

  /**
   * One drawn-point set per menu button row, for the pass that
   * keeps the ghost strand off the buttons. Same gate as `menuPoints`.
   */
  function menuRows() {
    try { return active?.toolbar?.menuRows?.() ?? []; } catch { return []; }
  }

  // Tour state arrives after the viewer is constructed and can change from
  // autoplay. Rebuild only the presentation labels; molecular bounds and the
  // XR-local entry-pose anchor remain untouched.
  async function refreshToolbar({ origin = 'host', ...options } = {}) {
    const record = active;
    await record?.toolbar?.update({ ...options, origin });
    if (options?.restoreTourSeat && active === record && record) {
      // The player batches the final seat solve with its snapshot repaint.
      // Retire the old debounce so it cannot request a second layout later.
      const resolve = menuResolveFor(record);
      resolve.dispose(); resolve.seed(menuPoints());
    }
  }

  async function dispose() {
    disposed = true;
    runtimeEvents?.removeEventListener?.('devicechange', invalidateCapabilities);
    await end();
    await removeOutcome();
  }

  return Object.freeze({ capabilities, enter, end, outcome, syncBounds, refreshToolbar, clearStatus: () => active?.toolbar?.setStatus(''), platePoints, captionPoints, drawnMenuPoints, menuPoints, menuRows, dispose,
    beginTransform: () => active?.frameCost?.beginTransform(),
    endTransform: started => active?.frameCost?.endTransform(started),
    switchMode, // Passthrough on and off are two sessions, not one setting.
    passthroughSupported: () => capabilitySnapshot?.ar, // The menu never offers a switch the runtime refused.
    pendingEntry: () => (pendingEntry ? { ...pendingEntry } : null), // The one press the 2D page owes the wearer.
    clearPendingEntry: () => { pendingEntry = null; }, // The wearer changed their mind, or the page took the press.
    toolbarAction: action => active?.toolbar?.runAction(action),
    toolbarRows: options => active?.toolbar?.rows?.(options) ?? [], // Live rows; reset measures the menu it wakes.
    // A simulated controller pose, aimed through the
    // toolbar's own hit test and select handlers. Not a hand, not a wearer.
    toolbarAim: target => active?.toolbar?.aimSynthetic?.(target)
      ?? { method: 'synthetic-ray', fired: false, reason: 'no immersive menu is running' },
    // The state the menu itself draws from, read-only, so an
    // unattended run can check that a press changed what the wearer would see.
    spatialState: () => { try { return getSpatialState(); } catch { return null; } },
    // The plate's own description paging, which lives in the toolbar
    // closure and so is absent from the scene state above. The driver needs it
    // to tell a `description-page` press that turned the page from one that did
    // nothing.
    toolbarReadout: () => { try { return active?.toolbar?.readout?.() ?? null; } catch { return null; } },
    toolbarPlacementPoints: options => active?.toolbar?.placementPoints?.(options) ?? [],
    // The upcoming panel AND the content it was built from, for the
    // `journey-seat` record. One build serves both the placement solve and the
    // record, so a device reading can never pair a solve with a different
    // panel. Read-only, and a session with no menu simply has no preview.
    toolbarPlacementPreview: options => {
      try { return active?.toolbar?.placementPreview?.(options); } catch { return undefined; }
    },
    toolbarRelocationCandidates: options => active?.toolbar?.prepareRelocation?.(options) ?? [],
    relocateToolbar: candidate => active?.toolbar?.commitRelocation?.(candidate),
    // What the committed panel is drawing now — the lines on the
    // glass, the head it was seated on, the layout constants it used — so the
    // record can set the panel Done drew beside the panel Done measured.
    toolbarReadoutText: () => { try { return active?.toolbar?.readoutText?.() ?? []; } catch { return []; } },
    toolbarHead: () => { try { return active?.toolbar?.head?.() ?? null; } catch { return null; } },
    toolbarLayout: () => { try { return active?.toolbar?.layout?.() ?? null; } catch { return null; } },
    unlatchSeat: reason => active?.toolbar?.unlatchSeat?.(reason), // Unlatch menu seat.
    isMenuLatched: () => active?.toolbar?.isLatched?.() ?? false,
    isMenuCollapsed: () => active?.toolbar?.isCollapsed?.() ?? true,
    isMenuHidden: () => active?.toolbar?.isHidden?.() === true, // A reset shows a hidden menu compact, not expanded.
    presentation: () => active?.presentation, // The head-seated talk caption draws in the menu's own layer.
    environmentBlendMode: () => active?.session?.environmentBlendMode, // Whether passthrough has anything to toggle.
    setMenuHidden: hidden => active?.toolbar?.setHidden?.(hidden), // The menu clears the held structure.
    isRayOnMenu: hand => active?.toolbar?.isHandOnPanel?.(hand) === true, // A trigger pulled on a row is a select, never the stick modifier.
    isRayOnPanel: ray => active?.toolbar?.isRayOnPanel?.(ray) === true, // A pinch that starts on the menu belongs to the menu.
    menuWithinView: frame => active?.toolbar?.menuWithinView?.(frame) === true,
    // `mode` and `blendMode` name the session that is running now,
    // not the one the last request asked for. The agent uses this pair to know
    // whether a switch it was told about actually landed, and the pair has to
    // agree with what the wearer is looking at for that to mean anything.
    // What the headset is actually showing the wearer. `blind` is
    // the reading the inspector's heartbeat turns into `busy`, so an agent
    // never drives a panel through a system menu or a headset on a table.
    sessionVisibility: () => sessionVisibility,
    blind: () => Boolean(active) && blindVisibility(sessionVisibility),
    startup: () => {
      let frameRates = { supportedFrameRates: [], reportedFrameRate: null };
      try { frameRates = active?.renderBudget?.frameRateState?.() ?? frameRates; }
      catch { /* The optional session properties may disappear during teardown. */ }
      return { phase: startupPhase, pending: Boolean(entering), reloadRequired,
        mode: active?.mode ?? requestedMode, gestureActive,
        frameCount, viewCount, blendMode: liveBlendMode(), errorName,
        presenting: Boolean(canvas.xr?.isPresenting?.value),
        sessionVisibility: active ? sessionVisibility : null,
        supportedFrameRates: [...frameRates.supportedFrameRates],
        reportedFrameRate: frameRates.reportedFrameRate,
        pendingEntry: pendingEntry ? { ...pendingEntry } : null };
    } });
}
