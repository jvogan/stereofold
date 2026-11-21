/**
 * One still of what the wearer is actually looking at, on request.
 *
 * The agent on the Mac is blind: it can read the headset log and hear the
 * wearer, but it cannot see the scene. Meta casting needs a person to start it
 * and a cable route needs developer mode, so this is the in-page answer: the
 * Mac asks on the heartbeat it already runs, the page reads one left-eye frame
 * out of the live XR presentation buffer, and posts a small JPEG back over the
 * authenticated companion route.
 *
 * The whole design is built around one number. Quest 2 presents at 72 Hz, so a
 * frame costs 13.9 ms, and a synchronous `readPixels` of a 0.7-scale stereo
 * buffer is roughly 9 MiB of GPU-to-CPU traffic: several frames of stall, felt
 * by the wearer as judder. So the only work inside the XR callback is a
 * downscaling blit into a small single-sample framebuffer, an asynchronous
 * read into a pixel-pack buffer and a fence. Nothing waits there. A window
 * timer outside the frame loop polls the fence, pulls the bytes, and hands
 * them to a worker to flip and encode.
 *
 * Mol* keeps drawing straight into `XRWebGLLayer.framebuffer` on every other
 * frame, so fixed foveated rendering is never disturbed: there is no permanent
 * intermediate render target, and a capture happens only when one was asked
 * for. One request produces one image.
 *
 * Nothing here reads or changes molecular state, and the image never leaves
 * the authenticated route the page already holds.
 */

import { getXrLayerStack } from './xr-layers.mjs';

/** Width the eye is downscaled to before it is read back. */
export const HEADSET_VIEW_DEFAULT_WIDTH = 480;
export const HEADSET_VIEW_MIN_WIDTH = 160;
export const HEADSET_VIEW_MAX_WIDTH = 640;
/** JPEG quality. 0.6 keeps a 480-wide frame in the tens of kilobytes. */
export const HEADSET_VIEW_DEFAULT_QUALITY = 0.6;
export const HEADSET_VIEW_MIME = 'image/jpeg';
/** How often the fence is polled, outside the XR frame loop. */
export const HEADSET_VIEW_POLL_MS = 16;
/** A capture that has not resolved by here is abandoned, so a request cannot pile up. */
export const HEADSET_VIEW_TIMEOUT_MS = 6_000;
/** The upload rides the 2 MiB tool body; a 480-wide JPEG is far below this. */
export const HEADSET_VIEW_MAX_BYTES = 1_000_000;

const SYNC_FLUSH_COMMANDS_BIT = 0x00000001;

let registeredSender;
let pending;
// Heartbeats reoffer unacknowledged IDs. Retain a bounded set across capture
// completion and XR teardown so a delayed response cannot restart a readback
// or resurrect a cancelled request in a later session.
const acceptedRequests = new Set();
// Exactly one terminal payload is retained until acceptance or the original
// host deadline. Reoffers retry these bytes, never the GPU/encoder work.
let terminalCapture;
let terminalUploadInFlight = false;
const REQUEST_TTL_MS = 15_000;
let resources;
let probe = null;
/** The live session and context, so a capture can be paid for before its frame. */
let liveContext;
/** Whether this session has already paid for its capture buffers. */
let warmed = false;

/** Never let an observational capture cost the wearer a frame or a press. */
function record(kind, detail) {
  try { globalThis.__stereofoldDiagnostics?.record?.(kind, detail); }
  catch { /* A diagnostics sink that throws must not cost the capture. */ }
}

/**
 * The companion page registers its authenticated tool caller once. With no
 * sender the page never captures: a snapshot has nowhere to go.
 */
export function setHeadsetViewSender(send) {
  if (registeredSender !== send) discardTerminalCapture();
  registeredSender = typeof send === 'function' ? send : undefined;
  if (!registeredSender) acceptedRequests.clear();
}
export function headsetViewSender() { return registeredSender; }

/** Test and diagnostics window on the single in-flight capture. */
export function headsetViewState() {
  return { pending: pending ? { id: pending.id, phase: pending.phase, path: pending.path } : null, probe };
}

/** Drop everything a session owned. Called when presentation ends. */
export function releaseHeadsetView(gl) {
  discardTerminalCapture();
  if (pending?.timer !== undefined) { clearTimeout(pending.timer); pending.timer = undefined; }
  pending?.encodingAbort?.abort();
  pending = undefined;
  const held = resources;
  resources = undefined;
  probe = null;
  liveContext = undefined;
  warmed = false;
  if (!held || !gl) return;
  try {
    if (held.sync) gl.deleteSync(held.sync);
    if (held.pack) gl.deleteBuffer(held.pack);
    if (held.probePack) gl.deleteBuffer(held.probePack);
    if (held.framebuffer) gl.deleteFramebuffer(held.framebuffer);
    if (held.colour) gl.deleteRenderbuffer(held.colour);
    if (held.resolve) { gl.deleteFramebuffer(held.resolve.framebuffer); gl.deleteRenderbuffer(held.resolve.colour); }
  } catch { /* A lost context has already released these. */ }
}

function clampWidth(value) {
  const width = Math.round(Number(value));
  if (!Number.isFinite(width)) return HEADSET_VIEW_DEFAULT_WIDTH;
  return Math.min(HEADSET_VIEW_MAX_WIDTH, Math.max(HEADSET_VIEW_MIN_WIDTH, width));
}

function clampQuality(value) {
  const quality = Number(value);
  if (!Number.isFinite(quality)) return HEADSET_VIEW_DEFAULT_QUALITY;
  return Math.min(0.95, Math.max(0.3, quality));
}

/**
 * Arm one capture. The next XR frame after Mol* has drawn takes it.
 *
 * A request that arrives while another is still in flight replaces it: the
 * agent asked for what the wearer is looking at now, and the older read is
 * already stale.
 */
export function requestHeadsetViewCapture(request) {
  const id = typeof request?.id === 'string' && request.id ? request.id : undefined;
  if (!id || !registeredSender) return false;
  if (acceptedRequests.has(id)) {
    if (terminalCapture?.id === id) retryTerminalCapture();
    return true;
  }
  if (Number.isFinite(request.expiresAt) && request.expiresAt <= Date.now()) return false;
  acceptedRequests.add(id);
  while (acceptedRequests.size > 64) acceptedRequests.delete(acceptedRequests.values().next().value);
  discardTerminalCapture();
  if (pending?.timer !== undefined) clearTimeout(pending.timer);
  pending?.encodingAbort?.abort();
  pending = {
    id, phase: 'armed', path: 'none',
    width: clampWidth(request.maxWidth ?? HEADSET_VIEW_DEFAULT_WIDTH),
    quality: clampQuality(request.quality ?? HEADSET_VIEW_DEFAULT_QUALITY),
    requestedAt: now(), frameMs: 0, timer: undefined, send: registeredSender,
    expiresAt: Math.min(Number.isFinite(request.expiresAt) ? request.expiresAt : Infinity, Date.now() + REQUEST_TTL_MS),
  };
  pending.timer = setTimeout(() => {
    if (pending?.id !== id) return;
    const reason = pending.phase === 'armed' ? 'no immersive frame' : `stalled in ${pending.phase}`;
    fail(id, reason);
  }, Math.min(HEADSET_VIEW_TIMEOUT_MS, pending.expiresAt - Date.now()));
  pending.timer?.unref?.();
  // Probe again for this capture, so the `probeLit` the Mac reads
  // describes the frame the image comes from, not the session's first one.
  probe = null;
  // The session usually warmed itself when it started; this covers a request
  // that arrives in the first moments of immersion.
  scheduleWarm();
  return true;
}

/**
 * Pay for the capture before the frame that takes it.
 *
 * Allocating the two framebuffers and the pack buffer, and touching the blit
 * and fence entry points for the first time, cost 67 ms in the emulator. That
 * is five Quest frames, and none of it has to happen on the XR clock: the
 * eye's size is already known from the layer, so everything but the read of
 * the live buffer is done here, on a window timer, while the wearer's frame
 * loop runs untouched.
 */
function scheduleWarm() {
  if (warmed) return;
  const timer = setTimeout(prewarm, 0);
  timer?.unref?.();
}

function prewarm() {
  const gl = liveContext?.gl, session = liveContext?.session;
  if (warmed || !gl || !session) return;
  if (typeof gl.fenceSync !== 'function' || typeof gl.blitFramebuffer !== 'function') return;
  let previous;
  try {
    const layer = session.renderState?.baseLayer;
    const eyeWidth = Math.max(1, Math.floor((layer?.framebufferWidth ?? 0) / 2));
    const eyeHeight = Math.max(1, layer?.framebufferHeight ?? 0);
    if (eyeWidth < 2 || eyeHeight < 2) return;
    const width = Math.min(pending?.width ?? HEADSET_VIEW_DEFAULT_WIDTH, eyeWidth);
    const height = Math.max(1, Math.round(width * (eyeHeight / eyeWidth)));
    const started = now();
    previous = {
      read: gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),
      draw: gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING),
      pack: gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING),
      alignment: gl.getParameter(gl.PACK_ALIGNMENT),
      rowLength: gl.getParameter(gl.PACK_ROW_LENGTH),
      skipRows: gl.getParameter(gl.PACK_SKIP_ROWS),
      skipPixels: gl.getParameter(gl.PACK_SKIP_PIXELS),
      scissor: gl.isEnabled(gl.SCISSOR_TEST),
      colorMask: gl.getParameter(gl.COLOR_WRITEMASK),
    };
    if (previous.scissor) gl.disable(gl.SCISSOR_TEST);
    gl.colorMask(true, true, true, true);
    const target = ensureTarget(gl, width, height);
    const resolved = ensureResolve(gl, eyeWidth, eyeHeight);
    // A blit and a packed read between this module's own buffers. The opaque
    // XR framebuffer is deliberately never touched here: outside its animation
    // frame it is incomplete, and reading it would be an error.
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, resolved.framebuffer);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, target.framebuffer);
    gl.blitFramebuffer(0, 0, eyeWidth, eyeHeight, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.LINEAR);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, target.framebuffer);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, target.pack);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    const warmSync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    if (warmSync) {
      gl.clientWaitSync(warmSync, SYNC_FLUSH_COMMANDS_BIT, 0);
      gl.deleteSync(warmSync);
    }
    while (gl.getError() !== gl.NO_ERROR) { /* A warm-up never reports; the capture does. */ }
    warmed = true;
    record('xr-snapshot-warm', { ms: Math.round((now() - started) * 100) / 100, width, height, eyeWidth, eyeHeight });
  } catch (error) { record('xr-snapshot-warm', { failed: String(error?.message ?? error).slice(0, 120) }); }
  finally { if (previous) restore(gl, previous); }
}

function now() { return globalThis.performance?.now?.() ?? Date.now(); }

function fail(id, reason) {
  if (pending?.id !== id) return;
  const held = pending;
  if (held.timer !== undefined) clearTimeout(held.timer);
  pending = undefined;
  held.encodingAbort?.abort();
  record('xr-snapshot', { requestId: id, ok: false, path: held.path, reason: String(reason).slice(0, 120) });
  retainTerminalCapture(held, { requestId: id, status: 'failed', reason: String(reason).slice(0, 120) });
}

function discardTerminalCapture() {
  if (terminalCapture?.timer !== undefined) clearTimeout(terminalCapture.timer);
  terminalCapture = undefined;
}

function retainTerminalCapture(capture, message) {
  discardTerminalCapture();
  if (!registeredSender || capture.send !== registeredSender || capture.expiresAt <= Date.now()) return;
  const entry = { id: capture.id, message, send: registeredSender, expiresAt: capture.expiresAt, retryRequested: false };
  terminalCapture = entry;
  entry.timer = setTimeout(() => { if (terminalCapture === entry) discardTerminalCapture(); }, entry.expiresAt - Date.now());
  entry.timer?.unref?.();
  retryTerminalCapture();
}

function retryTerminalCapture() {
  const entry = terminalCapture;
  if (!entry) return;
  const current = () => terminalCapture === entry && registeredSender === entry.send && Date.now() < entry.expiresAt;
  if (!current()) { discardTerminalCapture(); return; }
  if (terminalUploadInFlight) { entry.retryRequested = true; return; }
  terminalUploadInFlight = true;
  entry.retryRequested = false;
  void uploadHeadsetView(entry.send, entry.message, { reportFailure: false, isCurrent: current }).then(accepted => {
    if (accepted && terminalCapture === entry) discardTerminalCapture();
  }).finally(() => {
    terminalUploadInFlight = false;
    // A new request can finish while the previous network call is retiring.
    // Keep even those uploads serial and never revive the replaced payload.
    if (terminalCapture?.retryRequested) retryTerminalCapture();
  });
}

/** The left eye, or the only view a monoscopic runtime offers. */
function leftViewport(layer, pose) {
  const views = pose?.views ?? [];
  const view = views.find(candidate => candidate.eye === 'left') ?? views[0];
  if (!view) return undefined;
  const viewport = layer.getViewport(view);
  if (!viewport || !(viewport.width > 0) || !(viewport.height > 0)) return undefined;
  return { eye: view.eye ?? 'none', x: viewport.x, y: viewport.y, width: viewport.width, height: viewport.height, view };
}

/**
 * Add the controls to a still, when they are on XR layers of their own.
 *
 * With a layer stack (`xr-layers.mjs`, behind `?xrLayers=1`) the base layer
 * holds the molecule alone: the menu and captions are drawn into layers the
 * compositor puts above it, so a still read from the base layer shows a scene
 * with no menu. The stack's painters draw those layers over the still, which
 * is the small target, not the wearer's frame. They draw with the renderer,
 * whose state cache has to agree with GL, so the scissor test and colour mask
 * this capture borrowed are handed back for the call and taken again after.
 *
 * `undefined` without a stack or with nothing on a layer of its own, and then
 * no GL call is made here at all. Otherwise whether the controls are in the
 * still.
 */
function paintLayers(gl, session, previous, still) {
  let stack;
  try { stack = getXrLayerStack(session); } catch { stack = null; }
  if (typeof stack?.paintCapture !== 'function') return undefined;
  const mask = previous.colorMask ?? [true, true, true, true];
  if (previous.scissor) gl.enable(gl.SCISSOR_TEST);
  gl.colorMask(mask[0], mask[1], mask[2], mask[3]);
  let painted, raised = false;
  try { painted = stack.paintCapture(still); }
  finally {
    if (previous.scissor) gl.disable(gl.SCISSOR_TEST);
    gl.colorMask(true, true, true, true);
    // An error a painter raised is its own, not the read that follows.
    while (gl.getError() !== gl.NO_ERROR) raised = true;
  }
  return painted === undefined ? undefined : painted && !raised;
}

function ensureTarget(gl, width, height) {
  if (resources && resources.width === width && resources.height === height) return resources;
  releaseTargetOnly(gl);
  const framebuffer = gl.createFramebuffer(), colour = gl.createRenderbuffer();
  const previousRenderbuffer = gl.getParameter(gl.RENDERBUFFER_BINDING);
  gl.bindRenderbuffer(gl.RENDERBUFFER, colour);
  gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, width, height);
  gl.bindRenderbuffer(gl.RENDERBUFFER, previousRenderbuffer);
  const previousDraw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, framebuffer);
  gl.framebufferRenderbuffer(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, colour);
  const complete = gl.checkFramebufferStatus(gl.DRAW_FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, previousDraw);
  if (!complete) {
    gl.deleteFramebuffer(framebuffer); gl.deleteRenderbuffer(colour);
    throw Error('The snapshot framebuffer is incomplete.');
  }
  const pack = gl.createBuffer(), probePack = gl.createBuffer();
  const previousPack = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING);
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pack);
  gl.bufferData(gl.PIXEL_PACK_BUFFER, width * height * 4, gl.STREAM_READ);
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, probePack);
  gl.bufferData(gl.PIXEL_PACK_BUFFER, 4, gl.STREAM_READ);
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, previousPack);
  resources = { width, height, framebuffer, colour, pack, probePack, sync: undefined, resolve: undefined };
  return resources;
}

/**
 * The one-eye resolve target, allocated only when a scaling blit was refused.
 * It costs eye-sized video memory, so it is never created speculatively.
 */
function ensureResolve(gl, width, height) {
  const held = resources;
  if (held.resolve && held.resolve.width === width && held.resolve.height === height) return held.resolve;
  if (held.resolve) {
    try { gl.deleteFramebuffer(held.resolve.framebuffer); gl.deleteRenderbuffer(held.resolve.colour); }
    catch { /* Already released. */ }
  }
  const framebuffer = gl.createFramebuffer(), colour = gl.createRenderbuffer();
  const previousRenderbuffer = gl.getParameter(gl.RENDERBUFFER_BINDING);
  gl.bindRenderbuffer(gl.RENDERBUFFER, colour);
  gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, width, height);
  gl.bindRenderbuffer(gl.RENDERBUFFER, previousRenderbuffer);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, framebuffer);
  gl.framebufferRenderbuffer(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, colour);
  if (gl.checkFramebufferStatus(gl.DRAW_FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    gl.deleteFramebuffer(framebuffer); gl.deleteRenderbuffer(colour);
    throw Error('The resolve framebuffer is incomplete.');
  }
  held.resolve = { width, height, framebuffer, colour };
  return held.resolve;
}

function releaseTargetOnly(gl) {
  if (!resources) return;
  const held = resources; resources = undefined;
  try {
    if (held.sync) gl.deleteSync(held.sync);
    if (held.pack) gl.deleteBuffer(held.pack);
    if (held.probePack) gl.deleteBuffer(held.probePack);
    if (held.framebuffer) gl.deleteFramebuffer(held.framebuffer);
    if (held.colour) gl.deleteRenderbuffer(held.colour);
    if (held.resolve) { gl.deleteFramebuffer(held.resolve.framebuffer); gl.deleteRenderbuffer(held.resolve.colour); }
  } catch { /* Already released with the context. */ }
}

/**
 * The one-pixel question the two published research reports disagree about.
 *
 * The WebXR opaque framebuffer is readable inside an XR animation frame and
 * unreadable outside one, but a multisampled layer refuses a read outright and
 * some runtimes allocate the swapchain image without a CPU transfer bit. Ask
 * the device on every capture instead of trusting either report, and carry the
 * answer into the log and the upload so a hardware run explains itself. The
 * pixel is the eye's centre: `[0,0,0,0]` there is what a black still reads,
 * and also what a passthrough eye with the
 * structure off to one side reads, so the Mac reports it and decides nothing by it.
 *
 * The read goes into a four-byte pack buffer, not a typed array. A synchronous
 * one-pixel read costs a full pipeline flush: 46 ms measured in the emulator,
 * three dropped Quest frames for one bit of information. Whether the read was
 * *permitted* is known immediately from `getError`; the pixel itself is pulled
 * later, on the same timer that pulls the image.
 */
function probeDirectRead(gl, target, viewport) {
  const x = Math.min(viewport.x + (viewport.width >> 1), viewport.x + viewport.width - 1);
  const y = Math.min(viewport.y + (viewport.height >> 1), viewport.y + viewport.height - 1);
  while (gl.getError() !== gl.NO_ERROR) { /* Start from a clean error state. */ }
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, target.probePack);
  gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, 0);
  const error = gl.getError();
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
  return { readable: error === gl.NO_ERROR, error, lit: null, pixel: null, deferred: error === gl.NO_ERROR };
}

/** Finish the probe from the pack buffer, once its fence has signalled. */
function settleProbe(gl) {
  if (!probe?.deferred || !resources?.probePack) return;
  probe.deferred = false;
  try {
    const pixel = new Uint8Array(4);
    const previousPack = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, resources.probePack);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, pixel);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, previousPack);
    probe.pixel = Array.from(pixel);
    probe.lit = pixel[0] !== 0 || pixel[1] !== 0 || pixel[2] !== 0 || pixel[3] !== 0;
  } catch { probe.lit = null; }
  record('xr-snapshot-probe', { readable: probe.readable, lit: probe.lit, error: probe.error,
    pixel: probe.pixel, framebufferWidth: probe.framebufferWidth, framebufferHeight: probe.framebufferHeight,
    opaque: probe.opaque });
}

/**
 * Take the frame. Called from `viewer.mjs` inside the XR animation frame,
 * after each XR callback, and acts only when a capture is armed and the
 * callback it follows drew this frame.
 *
 * `drawn` prevents black stills: a byte-identical black 640x704 eye while
 * `adb screencap` shows the structure. The viewer's observer follows every XR
 * callback, and the frame-rate watcher's runs before Mol*'s in each frame, so
 * a capture taken there reads an opaque framebuffer the runtime has cleared
 * and Mol* has not drawn into yet.
 * `undefined` means the caller cannot tell, and keeps the older behaviour.
 */
export function xrSnapshotFrame({ frame, space, session, gl, drawn }) {
  if (session && gl) {
    const fresh = liveContext?.session !== session;
    liveContext = { session, gl };
    // Allocate and touch the capture path once, on a window timer, so the
    // first request does not pay for it inside the wearer's frame.
    if (fresh) { warmed = false; scheduleWarm(); }
  }
  if (!pending || pending.phase !== 'armed' || !frame || !session || !gl || drawn === false) return;
  if (typeof gl.fenceSync !== 'function' || typeof gl.blitFramebuffer !== 'function') {
    fail(pending.id, 'This browser has no WebGL2 blit or fence.'); return;
  }
  const started = now();
  const id = pending.id;
  let previous;
  try {
    const layer = session.renderState?.baseLayer;
    if (!layer) throw Error('The immersive session has no base layer.');
    const pose = frame.getViewerPose(space);
    const viewport = pose ? leftViewport(layer, pose) : undefined;
    if (!viewport) throw Error('No current eye viewport.');
    const width = Math.min(pending.width, viewport.width);
    const height = Math.max(1, Math.round(width * (viewport.height / viewport.width)));
    previous = {
      read: gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),
      draw: gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING),
      pack: gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING),
      alignment: gl.getParameter(gl.PACK_ALIGNMENT),
      rowLength: gl.getParameter(gl.PACK_ROW_LENGTH),
      skipRows: gl.getParameter(gl.PACK_SKIP_ROWS),
      skipPixels: gl.getParameter(gl.PACK_SKIP_PIXELS),
      scissor: gl.isEnabled(gl.SCISSOR_TEST),
      colorMask: gl.getParameter(gl.COLOR_WRITEMASK),
    };
    // A blit is masked by the scissor box and the colour mask like any other
    // write. Mol* leaves the scissor set to the eye it drew last, which does
    // not overlap this small target, so without this the capture is black.
    if (previous.scissor) gl.disable(gl.SCISSOR_TEST);
    gl.colorMask(true, true, true, true);
    const target = ensureTarget(gl, width, height);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, layer.framebuffer);
    if (!probe) {
      probe = probeDirectRead(gl, target, viewport);
      probe.framebufferWidth = layer.framebufferWidth ?? null;
      probe.framebufferHeight = layer.framebufferHeight ?? null;
      probe.opaque = layer.framebuffer !== null;
      if (!probe.deferred) record('xr-snapshot-probe', { readable: probe.readable, lit: null, error: probe.error,
        framebufferWidth: probe.framebufferWidth, framebufferHeight: probe.framebufferHeight, opaque: probe.opaque });
    }
    while (gl.getError() !== gl.NO_ERROR) { /* Attribute only this capture's errors. */ }
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, target.framebuffer);
    gl.blitFramebuffer(viewport.x, viewport.y, viewport.x + viewport.width, viewport.y + viewport.height,
      0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.LINEAR);
    let path = 'blit-pack-fence';
    if (gl.getError() !== gl.NO_ERROR) {
      // A multisampled presentation buffer refuses a scaling blit outright.
      // Resolve the eye at its own size first, then scale off that copy.
      const resolved = ensureResolve(gl, viewport.width, viewport.height);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, resolved.framebuffer);
      gl.blitFramebuffer(viewport.x, viewport.y, viewport.x + viewport.width, viewport.y + viewport.height,
        0, 0, viewport.width, viewport.height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, resolved.framebuffer);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, target.framebuffer);
      gl.blitFramebuffer(0, 0, viewport.width, viewport.height, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.LINEAR);
      const resolveError = gl.getError();
      if (resolveError !== gl.NO_ERROR) throw Error(`The eye blit failed with WebGL error ${resolveError}.`);
      path = 'resolve-blit-pack-fence';
    }
    // The path says whether controls on layers of their own made it into the
    // still, so a still without them is never taken for a scene without a menu.
    const controls = paintLayers(gl, session, previous, { view: viewport.view, framebuffer: target.framebuffer, width, height });
    if (controls !== undefined) path += controls ? '+controls' : '+no-controls';
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, target.framebuffer);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, target.pack);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.PACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl.PACK_SKIP_ROWS, 0);
    gl.pixelStorei(gl.PACK_SKIP_PIXELS, 0);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    const readError = gl.getError();
    if (readError !== gl.NO_ERROR) throw Error(`The packed read failed with WebGL error ${readError}.`);
    if (target.sync) { try { gl.deleteSync(target.sync); } catch { /* Superseded. */ } }
    target.sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    pending.phase = 'fenced';
    pending.path = path;
    pending.width = width;
    pending.height = height;
    pending.eye = viewport.eye;
    pending.framebuffer = { width: layer.framebufferWidth ?? 0, height: layer.framebufferHeight ?? 0 };
    pending.viewport = [viewport.x, viewport.y, viewport.width, viewport.height];
    pending.frameMs = Math.round((now() - started) * 100) / 100;
    pending.capturedAt = Date.now();
    schedulePackPoll(gl);
  } catch (error) {
    fail(id, error?.message ?? 'The capture failed.');
  } finally {
    if (previous) restore(gl, previous);
  }
}

function restore(gl, previous) {
  try {
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, previous.pack);
    gl.pixelStorei(gl.PACK_ALIGNMENT, previous.alignment);
    gl.pixelStorei(gl.PACK_ROW_LENGTH, previous.rowLength);
    gl.pixelStorei(gl.PACK_SKIP_ROWS, previous.skipRows);
    gl.pixelStorei(gl.PACK_SKIP_PIXELS, previous.skipPixels);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, previous.read);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, previous.draw);
    if (previous.scissor) gl.enable(gl.SCISSOR_TEST);
    const mask = previous.colorMask ?? [true, true, true, true];
    gl.colorMask(mask[0], mask[1], mask[2], mask[3]);
  } catch { /* A context lost mid-capture has already reset every binding. */ }
}

/** How far, per channel out of 255, a pixel may differ and still count as the same colour. */
export const HEADSET_VIEW_FLAT_TOLERANCE = 2;
/**
 * A pixel is lit when its brightest channel, as the JPEG shows it, reaches
 * this out of 255. The Mac judges a device still by the same floor: levels 1
 * to 3 are encoder rounding on an empty frame, and anything from 4 up is drawn,
 * however dark.
 */
export const HEADSET_VIEW_LIT_FLOOR = 4;

/**
 * Every pixel of the eye, read once: how many are lit, and the one colour they
 * all show when they show only one.
 *
 * The Mac judges the count by the rule it applies to a device still. An eye
 * with almost no lit pixel is a framebuffer read before the structure was
 * drawn, or a passthrough layer with nothing in front of the wearer, and is not
 * reported as the wearer's view; one lit over less than one percent is handed
 * over with a note. A single-colour eye that is not black is the scene
 * background alone, with no part of the structure in it, and is refused too.
 * Nothing is sampled: a sample can step over a thin structure, or land on the
 * few lit pixels of an otherwise black frame.
 *
 * Colours are read as the JPEG shows them, over black, so a transparent
 * passthrough pixel is black whatever colour it carries. A run of identical
 * pixels, which is most of any eye, costs one comparison a pixel. It runs on
 * the window timer, never in the XR frame. Measured on a Mac: about 1 ms for
 * the largest eye the page reads (640x704) and 5 ms for a whole native Quest 2
 * eye (1832x1920); the slowest case, a frame within two levels of one colour
 * everywhere but never twice the same, about 3 ms and 22 ms.
 */
export function eyeLight(pixels) {
  const count = pixels ? Math.floor(pixels.length / 4) : 0;
  if (!count) return { pixels: 0, lit: 0 };
  const red = shownChannel(pixels[0], pixels[3]), green = shownChannel(pixels[1], pixels[3]), blue = shownChannel(pixels[2], pixels[3]);
  const { lit, flat } = pixels.byteOffset % 4 === 0 && LITTLE_ENDIAN
    ? countWords(new Uint32Array(pixels.buffer, pixels.byteOffset, count), red, green, blue)
    : countBytes(pixels, count, red, green, blue);
  return { pixels: count, lit,
    ...(flat ? { flatColor: `#${[red, green, blue].map(value => value.toString(16).padStart(2, '0')).join('')}` } : {}) };
}

const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
/** The floor as one mask over a word's three colour bytes: any bit set means a channel reaches it. */
const LIT_MASK = ((0x100 - HEADSET_VIEW_LIT_FLOOR) & 0xff) * 0x01_01_01;
if ((HEADSET_VIEW_LIT_FLOOR & (HEADSET_VIEW_LIT_FLOOR - 1)) !== 0) throw Error('The lit floor has to be a power of two.');

/** One channel as a JPEG shows it over black. */
const shownChannel = (value, alpha) => (alpha === 255 ? value : alpha === 0 ? 0 : Math.round(value * alpha / 255));
const near = (value, reference) => (value > reference ? value - reference : reference - value) <= HEADSET_VIEW_FLAT_TOLERANCE;
/** Lit as shown: the brightest channel, rounded as the flat check rounds it, reaches the floor. */
const litShown = (r, g, b, alpha) => shownChannel(r > g ? (r > b ? r : b) : (g > b ? g : b), alpha) >= HEADSET_VIEW_LIT_FLOOR;

/** Whether one RGBA word is lit as shown. An opaque pixel needs no arithmetic at all. */
const litWord = word => {
  const alpha = word >>> 24;
  if (alpha === 255) return (word & LIT_MASK) !== 0 ? 1 : 0;
  return alpha === 0 ? 0 : litShown(word & 0xff, (word >>> 8) & 0xff, (word >>> 16) & 0xff, alpha) ? 1 : 0;
};

/**
 * RGBA a word at a time on a little-endian host. While every pixel so far is
 * one colour each new one is also compared with the first; from the first that
 * differs, only the count is left to do.
 */
function countWords(words, red, green, blue) {
  let lit = 0, previous = -1, previousLit = 0, index = 0;
  for (; index < words.length; index++) {
    const word = words[index];
    // Most of an eye is runs of one colour: equal words are equal pixels.
    if (word === previous) { lit += previousLit; continue; }
    const alpha = word >>> 24;
    if (!(near(shownChannel(word & 0xff, alpha), red) && near(shownChannel((word >>> 8) & 0xff, alpha), green)
      && near(shownChannel((word >>> 16) & 0xff, alpha), blue))) break;
    previous = word; previousLit = litWord(word); lit += previousLit;
  }
  const flat = index === words.length;
  for (; index < words.length; index++) {
    const word = words[index];
    if (word !== previous) { previous = word; previousLit = litWord(word); }
    lit += previousLit;
  }
  return { lit, flat };
}

/** The same count a byte at a time, for a view that is not word-aligned. */
function countBytes(pixels, count, red, green, blue) {
  let lit = 0, flat = true;
  for (let offset = 0, end = count * 4; offset < end; offset += 4) {
    const r = pixels[offset], g = pixels[offset + 1], b = pixels[offset + 2], alpha = pixels[offset + 3];
    if (litShown(r, g, b, alpha)) lit += 1;
    if (flat && !(near(shownChannel(r, alpha), red) && near(shownChannel(g, alpha), green) && near(shownChannel(b, alpha), blue))) flat = false;
  }
  return { lit, flat };
}

/** The one colour every pixel of the eye shows, or undefined for a real picture. */
export function flatColor(pixels) { return eyeLight(pixels).flatColor; }

/**
 * Everything after the fence runs on a window timer, never on the XR clock. A
 * `clientWaitSync` with a zero timeout only asks; it never blocks the wearer's
 * frame, and the bytes are pulled on the first tick that says the GPU is done.
 */
function schedulePackPoll(gl) {
  const id = pending?.id;
  if (!id) return;
  const tick = () => {
    if (pending?.id !== id || pending.phase !== 'fenced' || !resources?.sync) return;
    let status;
    try { status = gl.clientWaitSync(resources.sync, SYNC_FLUSH_COMMANDS_BIT, 0); }
    catch (error) { fail(id, error?.message ?? 'The fence could not be read.'); return; }
    if (status === gl.TIMEOUT_EXPIRED) { const timer = setTimeout(tick, HEADSET_VIEW_POLL_MS); timer?.unref?.(); return; }
    if (status === gl.WAIT_FAILED) { fail(id, 'The GPU fence failed.'); return; }
    pending.phase = 'reading';
    const { width, height } = pending;
    const pixels = new Uint8Array(width * height * 4);
    try {
      const previousPack = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, resources.pack);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, pixels);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, previousPack);
      gl.deleteSync(resources.sync); resources.sync = undefined;
      settleProbe(gl);
    } catch (error) { fail(id, error?.message ?? 'The packed pixels could not be read.'); return; }
    const checking = now();
    const light = eyeLight(pixels);
    pending.checkMs = Math.round((now() - checking) * 100) / 100;
    pending.litPixels = light.lit;
    pending.flatColor = light.flatColor;
    pending.flatChecked = true;
    pending.phase = 'encoding';
    const capture = pending;
    capture.encodingAbort = new AbortController();
    encode(pixels, width, height, capture.quality, capture.encodingAbort.signal)
      .then(bytes => { if (pending === capture) deliver(id, bytes); })
      .catch(error => { if (pending === capture) fail(id, error?.message ?? 'The snapshot could not be encoded.'); });
  };
  const timer = setTimeout(tick, 0);
  timer?.unref?.();
}

/**
 * `readPixels` hands back rows bottom-up, so the encoder flips them. It runs in
 * a worker where the browser has `OffscreenCanvas`, because a JPEG of a quarter
 * of a million pixels on the main thread is a visible hitch inside a headset.
 */
const WORKER_SOURCE = `
self.onmessage = async event => {
  const { buffer, width, height, quality, mime } = event.data;
  try {
    const source = new Uint8ClampedArray(buffer);
    const flipped = new Uint8ClampedArray(source.length);
    const stride = width * 4;
    for (let row = 0; row < height; row++) {
      flipped.set(source.subarray((height - 1 - row) * stride, (height - row) * stride), row * stride);
    }
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    context.putImageData(new ImageData(flipped, width, height), 0, 0);
    const blob = await canvas.convertToBlob({ type: mime, quality });
    const encoded = await blob.arrayBuffer();
    self.postMessage({ encoded }, [encoded]);
  } catch (error) { self.postMessage({ error: String(error && error.message || error) }); }
};`;

function flipRows(pixels, width, height) {
  const flipped = new Uint8ClampedArray(pixels.length), stride = width * 4;
  for (let row = 0; row < height; row++) {
    flipped.set(pixels.subarray((height - 1 - row) * stride, (height - row) * stride), row * stride);
  }
  return flipped;
}

function encodeOnMainThread(pixels, width, height, quality) {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw Error('No 2D canvas is available to encode the snapshot.');
  context.putImageData(new ImageData(flipRows(pixels, width, height), width, height), 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (!blob) { reject(Error('The snapshot could not be encoded.')); return; }
      blob.arrayBuffer().then(resolve, reject);
    }, HEADSET_VIEW_MIME, quality);
  });
}

function encode(pixels, width, height, quality, signal) {
  const workerAvailable = typeof Worker === 'function' && typeof OffscreenCanvas === 'function'
    && typeof Blob === 'function' && typeof URL?.createObjectURL === 'function';
  if (!workerAvailable) return encodeOnMainThread(pixels, width, height, quality);
  return new Promise((resolve, reject) => {
    let url, worker, settled = false, fallbackStarted = false;
    const releaseWorker = () => {
      try { worker?.terminate(); } catch { /* Already gone. */ }
      worker = undefined;
      if (url) { URL.revokeObjectURL(url); url = undefined; }
    };
    const finish = (ok, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', cancel);
      releaseWorker();
      if (ok) resolve(value); else reject(value);
    };
    const done = value => finish(true, value);
    const failed = error => finish(false, error);
    const cancel = () => failed(Error('The snapshot was cancelled.'));
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) { cancel(); return; }
    const fallback = () => {
      if (settled || fallbackStarted) return;
      fallbackStarted = true;
      releaseWorker();
      try { encodeOnMainThread(pixels, width, height, quality).then(done, failed); }
      catch (error) { failed(error); }
    };
    try {
      url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));
      worker = new Worker(url);
    } catch {
      fallback();
      return;
    }
    worker.onerror = fallback;
    worker.onmessage = message => {
      if (fallbackStarted) return;
      if (message.data?.error) { failed(Error(message.data.error)); return; }
      done(message.data.encoded);
    };
    const copy = pixels.slice().buffer;
    try { worker.postMessage({ buffer: copy, width, height, quality, mime: HEADSET_VIEW_MIME }, [copy]); }
    catch (error) { failed(error); }
  });
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

/**
 * Post the image, and post it again once if the first attempt is refused.
 *
 * A single refusal used to be the end of it: the page recorded
 * "upload rejected: …" on its own diagnostics ring and the agent on the Mac
 * waited out its deadline and reported nothing at all, losing the capture
 * entirely. One short retry covers a transient transport failure. The capture
 * owner retains the terminal payload for later heartbeat reoffers until its
 * original deadline. Standalone callers can still request a failure receipt.
 *
 * A retry can only ever re-send bytes already captured. It never takes another
 * frame, so it cannot cost the wearer anything.
 */
export const HEADSET_VIEW_RETRY_MS = 250;

function uploadFailureReason(error) { return String(error?.message ?? error ?? 'unknown').slice(0, 100); }

/**
 * @param {(message:object)=>unknown} send the registered authenticated sender
 * @param {object} message the `captured` answer, image and all
 * @param {{path?:string, retryMs?:number, reportFailure?:boolean, isCurrent?:()=>boolean}} [options]
 * @returns {Promise<boolean>} whether the image reached the Mac
 */
export function uploadHeadsetView(send, message, options = {}) {
  const id = message?.requestId, path = options.path ?? message?.path;
  const retryMs = Number.isFinite(options.retryMs) ? options.retryMs : HEADSET_VIEW_RETRY_MS;
  const current = options.isCurrent ?? (() => true);
  const attempt = async () => { if (!current()) return false; await send(message); return true; };
  return attempt().then(accepted => accepted, first => {
    if (!current()) return false;
    record('xr-snapshot', { requestId: id, ok: false, path, retrying: true,
      reason: `upload rejected: ${uploadFailureReason(first)}` });
    return new Promise(resume => { const timer = setTimeout(resume, retryMs); timer?.unref?.(); })
      .then(attempt)
      .then(accepted => accepted, second => {
        if (!current()) return false;
        const reason = `upload rejected twice: ${uploadFailureReason(second)}`;
        record('xr-snapshot', { requestId: id, ok: false, path, retrying: false, reason });
        // Say so on the same route rather than letting the agent time out. The
        // notice carries no image, so it is small enough to survive a refusal
        // the pixels themselves provoked.
        if (options.reportFailure !== false) {
          try { Promise.resolve(send({ requestId: id, status: 'failed', reason })).catch(() => {}); }
          catch { /* Nothing further is owed; the next heartbeat carries the next request. */ }
        }
        return false;
      });
  });
}

function deliver(id, encoded) {
  if (pending?.id !== id) return;
  const held = pending;
  if (encoded.byteLength > HEADSET_VIEW_MAX_BYTES) { fail(id, `The snapshot is ${encoded.byteLength} bytes, over the upload limit.`); return; }
  const send = registeredSender;
  if (!send) { fail(id, 'No authenticated sender is registered.'); return; }
  if (held.timer !== undefined) clearTimeout(held.timer);
  pending = undefined;
  // Every frame is uploaded with its lit-pixel count, and a single-colour one
  // says so in `flatColor`, as is one the probe read as unlit, with `probeLit`.
  // The Mac judges the count, and refuses an almost entirely black or flat
  // frame as the wearer's view and takes the device view instead.
  record('xr-snapshot', { requestId: id, ok: true, path: held.path, frameMs: held.frameMs,
    width: held.width, height: held.height, eye: held.eye, bytes: encoded.byteLength,
    probeReadable: probe?.readable ?? null, probeLit: probe?.lit ?? null, flatColor: held.flatColor ?? null,
    litPixels: held.litPixels ?? null, checkMs: held.checkMs ?? null });
  retainTerminalCapture(held, { requestId: id, status: 'captured', eye: held.eye,
    width: held.width, height: held.height, flatChecked: held.flatChecked === true,
    ...(Number.isSafeInteger(held.litPixels) ? { litPixels: held.litPixels } : {}),
    ...(held.flatColor ? { flatColor: held.flatColor } : {}),
    ...(typeof probe?.lit === 'boolean' ? { probeLit: probe.lit } : {}),
    mime: HEADSET_VIEW_MIME, frameMs: held.frameMs, capturedAt: held.capturedAt, path: held.path,
    framebufferWidth: held.framebuffer?.width ?? 0, framebufferHeight: held.framebuffer?.height ?? 0,
    directReadable: probe?.readable ?? false, data: toBase64(encoded) });
}
