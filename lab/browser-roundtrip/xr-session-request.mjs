import { deviceClass, describeInputSources } from './input-capabilities.mjs';

/**
 * Features the session asks for but never requires.
 *
 * WebXR guarantees an unsupported entry here is dropped rather than failing
 * the request, so a headset without hand tracking or a floor space still
 * enters immersion. Nothing downstream may assume one was granted; read
 * `session.enabledFeatures` instead.
 *
 * `hand-tracking` gives hand-only wearers a real input source. The two floor
 * spaces are requested so a later room-scale layout can ask for one, and
 * plane detection, anchors and hit-test so room-anchor.mjs can lock the
 * scene to the real floor when the browser offers them; the
 * viewer still opens on `local`, which every immersive session enables.
 *
 * `high-fixed-foveation-level` is Meta's opt-in for the strongest fixed
 * foveation levels. Without it a Quest browser may quantise the level 1 this
 * module writes for a Quest 2 down to its default cap, which is the
 * difference between shading the periphery at full rate and shading it at a
 * quarter. `applyFoveation` reads the level back, so a runtime that ignores
 * the request is visible in the log rather than assumed.
 */
export const HEADSET_OPTIONAL_FEATURES = Object.freeze(['hand-tracking', 'local-floor', 'bounded-floor', 'plane-detection', 'anchors', 'hit-test', 'high-fixed-foveation-level']);

/**
 * Whether this page runs on Apple's Safari WebXR, which today means Apple
 * Vision Pro.
 *
 * This names the browser engine, not the device. visionOS Safari sends the
 * desktop Mac user agent (`… AppleWebKit/605.1.15 … Version/27.0
 * Safari/605.1.15`, read in the visionOS 27.0 Simulator), so no
 * device can be read from it. Every other WebXR browser names another engine
 * in its agent: Quest Browser and headless Chromium say `Chrome/` (the latter
 * as `HeadlessChrome/`, hence no word boundary), Firefox-based ones say
 * `Firefox/`. Keying on the engine keeps the Safari policy in force if Apple
 * changes the device-looking parts of its agent.
 *
 * @param {{userAgent?:string,xr?:unknown}|null|undefined} navigatorLike
 */
export function isAppleSafariXr(navigatorLike) {
  let agent = '', xr = false;
  try {
    agent = typeof navigatorLike?.userAgent === 'string' ? navigatorLike.userAgent : '';
    xr = Boolean(navigatorLike?.xr);
  } catch { return false; }
  return xr && /\bAppleWebKit\//u.test(agent) && /\bSafari\//u.test(agent)
    && !/(?:Chrome|Chromium|CriOS|FxiOS|EdgiOS|Edg|OPR|OculusBrowser|Firefox|Wolvic|PicoBrowser)\//u.test(agent);
}

/**
 * The optional features to ask this browser for.
 *
 * Safari is not asked for `hand-tracking`. Vision Pro's look-and-pinch input
 * arrives as transient pointers whether or not hands are tracked
 * (`natural-input.mjs`), so the grant adds nothing Stereofold reads, and it
 * costs the wearer two things: a second permission prompt, and their own
 * hands. Safari shows the real hands only while the page does not track
 * them. A page that tracks them is expected to draw them itself (WWDC24
 * session 10066), and Stereofold draws none.
 *
 * @param {Parameters<typeof isAppleSafariXr>[0]} navigatorLike
 * @returns {string[]}
 */
export function headsetOptionalFeatures(navigatorLike) {
  return isAppleSafariXr(navigatorLike)
    ? HEADSET_OPTIONAL_FEATURES.filter(feature => feature !== 'hand-tracking')
    : [...HEADSET_OPTIONAL_FEATURES];
}

/** How long an entry request may stay unanswered before the page gives up. */
export const HEADSET_ENTRY_DEADLINE_MS = 20_000;
/**
 * The same, for Safari, which answers every immersive request with its own
 * "Would Like to Launch an Immersive Experience" prompt and holds the request
 * until the wearer chooses. In the visionOS 27.0 Simulator the prompt came
 * back on each entry, and the 20-second deadline closed a session the wearer
 * had just allowed. Five minutes still releases a request nobody answers.
 */
export const APPLE_PROMPT_DEADLINE_MS = 300_000;

/** @param {Parameters<typeof isAppleSafariXr>[0]} navigatorLike */
export function headsetEntryDeadlineMs(navigatorLike) {
  return isAppleSafariXr(navigatorLike) ? APPLE_PROMPT_DEADLINE_MS : HEADSET_ENTRY_DEADLINE_MS;
}

/**
 * Fixed foveation per device class, following the Quest 2 rendering budget in
 * `headset-matrix.md`: the lattice scene is fill-rate bound there, and full
 * foveation costs the wearer nothing at the periphery. A class we cannot name
 * keeps whatever the runtime chose.
 */
export const FOVEATION_BY_DEVICE = Object.freeze({ quest2: 1, quest3: 0.5, 'quest-pro': 0.5 });

/** The foveation level for a device class, or `null` to leave the layer alone. */
export function foveationLevelFor(device) {
  const level = FOVEATION_BY_DEVICE[device];
  return Number.isFinite(level) ? level : null;
}

/**
 * Turn on fixed foveation for one presenting session.
 *
 * Foveation is a property of the XR layer, not of render state, and Mol* owns
 * layer creation inside its own WebGL XR manager. This helper therefore takes
 * the layer the session is already presenting through
 * (`session.renderState.baseLayer`) and is called once, after presentation
 * starts — see the call in `immersive-session.mjs`.
 *
 * It never throws. A runtime that does not expose `fixedFoveation`, or that
 * refuses or quantises the value, is reported rather than raised.
 *
 * @param {XRSession} session presenting session
 * @param {XRWebGLLayer|XRProjectionLayer} [layer] defaults to the session's base layer
 * @param {number} [level] 0 to 1; omitted means the device-class default
 * @returns {{applied:boolean, requested:number|null, level:number|null, reason:string}}
 */
export function applyFoveation(session, layer, level) {
  let target = layer;
  try { target ??= session?.renderState?.baseLayer; } catch { target = undefined; }
  let requested = Number.isFinite(level) ? level : null;
  if (requested === null) {
    try { requested = foveationLevelFor(deviceClass(globalThis.navigator, describeInputSources(session))); }
    catch { requested = null; }
  }
  if (!target) return { applied: false, requested, level: null, reason: 'no-layer' };
  if (requested === null) return { applied: false, requested: null, level: null, reason: 'unknown-device' };
  const clamped = Math.min(1, Math.max(0, requested));
  try {
    if (!('fixedFoveation' in target)) return { applied: false, requested: clamped, level: null, reason: 'unsupported' };
    target.fixedFoveation = clamped;
    // Quest quantises the level it accepts, so the read-back is the truth and
    // a difference from the request is not a failure.
    const readBack = target.fixedFoveation;
    if (!Number.isFinite(readBack)) return { applied: false, requested: clamped, level: null, reason: 'unsupported' };
    return { applied: true, requested: clamped, level: readBack, reason: 'set' };
  } catch { return { applied: false, requested: clamped, level: null, reason: 'refused' }; }
}

/** How often the live base layer is re-checked while a session presents. */
export const FOVEATION_WATCH_MS = 250;

function recordFoveation(detail) {
  try { globalThis.__stereofoldDiagnostics?.record?.('foveation', detail); }
  catch { /* A diagnostics sink that throws must not cost the session. */ }
}

/**
 * Keep fixed foveation on whatever layer the session is presenting through.
 *
 * `applyFoveation` on its own was called once, straight after presentation
 * started, and it always missed. WebXR applies an `updateRenderState()` at the
 * top of the *next* animation frame, and Mol* builds its `XRWebGLLayer` inside
 * `xr.set` during startup, so at the moment presentation is first reported
 * `session.renderState.baseLayer` is still null. A Quest 2 shows exactly that:
 * `render-budget` logs `{"antialias":null,"fixedFoveation":null}`
 * — the no-layer signature, since `antialias` is always a boolean on a real
 * layer — while `foveation:1` said the level had been chosen.
 *
 * So the level is written when the layer actually exists, and again whenever
 * the layer is replaced. The watch is a plain timer rather than an animation
 * frame callback: reading `renderState` and writing `fixedFoveation` are both
 * ordinary attribute access, no frame is needed for either, and an extra
 * per-frame callback would keep the wearer's frame loop alive for no reason.
 * The timer stops when the session ends.
 *
 * @param {XRSession} session presenting session
 * @param {{level?:number, intervalMs?:number, scope?:object}} [options]
 * @returns {{stop:()=>void, state:()=>{applied:boolean, requested:number|null, level:number|null, reason:string}}}
 */
export function trackFoveation(session, options = {}) {
  const scope = options.scope ?? globalThis;
  const interval = Number.isFinite(options.intervalMs) && options.intervalMs > 0 ? options.intervalMs : FOVEATION_WATCH_MS;
  let seen = null;
  let last = { applied: false, requested: null, level: null, reason: 'no-layer' };
  let timer;
  const stop = () => {
    if (timer === undefined) return;
    try { scope.clearInterval?.(timer); } catch { /* A torn-down scope has already dropped it. */ }
    timer = undefined;
  };
  const visit = () => {
    let layer;
    try { layer = session?.renderState?.baseLayer; } catch { layer = undefined; }
    // Nothing to do until the layer appears, and nothing to redo while it is
    // the same object: `fixedFoveation` is not something the runtime resets.
    if (!layer || layer === seen) return;
    const replaced = seen !== null;
    seen = layer;
    last = applyFoveation(session, layer, options.level);
    recordFoveation({ ...last, replaced });
  };
  visit();
  try {
    timer = scope.setInterval?.(visit, interval);
    timer?.unref?.();
  } catch { timer = undefined; }
  try { session?.addEventListener?.('end', stop, { once: true }); } catch { /* Caller stops it instead. */ }
  return { stop, state: () => last };
}

/**
 * Disable XR-layer MSAA only for a known Quest class that receives a
 * fixed-foveation budget. Meta's rules name multisampling on the eye buffer as
 * a reason fixed foveation is disabled. Quest Browser gives an
 * `antialias: true` layer 4x MSAA, and Mol* hard-codes that flag when its WebGL
 * XR manager builds the layer (`mol-gl/webgl/context.js`, `new XRWebGLLayer(...,
 * { antialias: true })`). The 12:06 Quest headset log read `Fov=0` while this
 * module was writing `fixedFoveation = 1`.
 *
 * Other browsers keep Mol*'s requested antialiasing. In particular, an Apple
 * Safari user agent does not identify a Vision Pro, so this stays conservative
 * until either the UA or session input sources identify one of the Quest
 * classes with a measured foveation policy.
 *
 * The layer is created inside Mol*, so the only seam that does not patch
 * `node_modules` is the constructor itself. This swaps the global for the
 * duration of the attach and returns the undo. `Object.setPrototypeOf` keeps
 * `instanceof XRWebGLLayer` and the static `getNativeFramebufferScaleFactor`
 * working while the swap is installed.
 *
 * @param {object} [scope] object carrying `XRWebGLLayer` and optionally
 *   `navigator`; defaults to the global
 * @param {XRSession} [session] session whose input-source profiles can identify
 *   a Quest when its user agent does not name the model
 * @returns {() => void} restores the original constructor, and is idempotent
 */
export function disableXrLayerMsaa(scope = globalThis, session = undefined) {
  const original = scope?.XRWebGLLayer;
  if (typeof original !== 'function' || original.__stereofoldNoMsaa) return () => {};
  let device = 'unknown';
  try {
    const navigatorLike = scope?.navigator ?? (scope === globalThis ? globalThis.navigator : undefined);
    device = deviceClass(navigatorLike, describeInputSources(session));
  } catch { /* An unreadable browser/device description keeps native MSAA. */ }
  if (foveationLevelFor(device) === null) return () => {};
  function StereofoldXRWebGLLayer(session, gl, options) {
    return new original(session, gl, { ...(options ?? {}), antialias: false });
  }
  StereofoldXRWebGLLayer.__stereofoldNoMsaa = true;
  // Inherit the statics (`getNativeFramebufferScaleFactor`) and keep the
  // prototype identity so `instanceof` still answers for layers we made.
  Object.setPrototypeOf(StereofoldXRWebGLLayer, original);
  StereofoldXRWebGLLayer.prototype = original.prototype;
  try { scope.XRWebGLLayer = StereofoldXRWebGLLayer; }
  catch { return () => {}; }
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    // Another wrapper installed after ours owns the slot; leave it alone
    // rather than reinstating a constructor it is standing in front of.
    if (scope.XRWebGLLayer !== StereofoldXRWebGLLayer) return;
    try { scope.XRWebGLLayer = original; } catch { /* A frozen global keeps the wrapper; it is still correct. */ }
  };
}

/**
 * What the session's base layer actually is, for the headset log.
 *
 * `antialias` and `fixedFoveation` are the two numbers that say whether the
 * change above reached the runtime. Both are read back from the layer rather
 * than from what we asked for, because Quest quantises one and may ignore the
 * other. Never throws: a runtime without a base layer reports nulls.
 *
 * `present` separates the two ways a null can happen, which the log alone
 * could not: a session that has no base layer yet reads null for both,
 * and so does a layer that refuses the two attributes. They call for opposite
 * fixes, so the reader is told which one it is looking at.
 *
 * @param {XRSession} session presenting session
 * @returns {{present:boolean, antialias:boolean|null, fixedFoveation:number|null}}
 */
export function describeXrLayer(session) {
  let layer;
  try { layer = session?.renderState?.baseLayer; } catch { layer = undefined; }
  if (!layer) return { present: false, antialias: null, fixedFoveation: null };
  let antialias = null, fixedFoveation = null;
  try { if (typeof layer.antialias === 'boolean') antialias = layer.antialias; } catch { /* Reported as unknown. */ }
  try { if (Number.isFinite(layer.fixedFoveation)) fixedFoveation = layer.fixedFoveation; } catch { /* Reported as unknown. */ }
  return { present: true, antialias, fixedFoveation };
}

/**
 * What a wearer asking for or against passthrough actually needs.
 *
 * A session's environment blend mode is fixed for its life, but that is not
 * the same as the room being fixed. On Quest the compositor blends the camera
 * behind whatever alpha the frame carries, so an `alpha-blend` session that
 * clears opaque hides the room completely and one that clears transparent
 * shows it again. Meta says exactly this from the other side — "You must draw
 * your content on a transparent background, otherwise the passthrough
 * environment won't be visible" — and Mol* upstream binds a controller button
 * to that flip without ever leaving immersion (molstar.org/xr).
 *
 * So inside an `alpha-blend` session both directions are a clear, never a
 * session. `firePassthroughToggle` flips Mol*'s own `xrPassthrough` flag,
 * which `canvas3d.js` writes over `transparentBackground` on every XR frame;
 * this returns `toggle` for it whenever the wearer's ask differs from the
 * page's mirror of that flag.
 *
 * The one ask that still costs a session is the opposite one: an `opaque`
 * session has no camera feed to reveal, so a wearer who wants their room back
 * has to be taken to `immersive-ar`. A wearer already in the opaque session
 * asking for the room to stay hidden is asking for nothing.
 *
 * An unknown blend mode is treated as opaque: a runtime that would not name
 * its mode is not one to gamble an alpha clear on.
 *
 * @param {{blendMode:string|null, passthroughOn:boolean, on:boolean}} state
 * @returns {{action:'switch'|'toggle'|'unchanged', mode:'immersive-ar'|'immersive-vr'|null}}
 */
export function passthroughPlan({ blendMode, passthroughOn, on }) {
  const wanted = Boolean(on);
  const alphaBlend = blendMode === 'alpha-blend';
  // No camera in this session. Only the room-on ask has anywhere to go.
  if (!alphaBlend) return wanted ? { action: 'switch', mode: 'immersive-ar' } : { action: 'unchanged', mode: null };
  if (Boolean(passthroughOn) !== wanted) return { action: 'toggle', mode: null };
  return { action: 'unchanged', mode: null };
}

// Origin-local browser preference, separate from a scene's scientific state.
// Only explicit wearer choices are stored; first-time entry keeps its default.
const ROOM_PREFERENCE_KEY = 'stereofold.room-visible.v1';
export function readPassthroughPreference(scope = globalThis) {
  try {
    const value = scope.localStorage?.getItem(ROOM_PREFERENCE_KEY);
    return value === 'true' ? true : value === 'false' ? false : undefined;
  } catch { return undefined; }
}
export function storePassthroughPreference(on, scope = globalThis) {
  if (typeof on !== 'boolean') return;
  try { scope.localStorage?.setItem(ROOM_PREFERENCE_KEY, String(on)); }
  catch { /* Private/restricted storage retains the live page's choice. */ }
}

/** Restore a chosen Room off setting after Mol* seeds a fresh XR session. */
export function restorePassthroughOnEntry({ blendMode, preferred, toggle }) {
  const seeded = blendMode === 'alpha-blend';
  // An opaque session cannot show the room; restoration never requests a
  // different session or consumes a new user gesture.
  if (!seeded || preferred !== false) return { on: seeded, restored: false };
  try {
    if (toggle() === true) return { on: false, restored: true };
  } catch { /* Entry remains usable, with an honest mirror of the clear. */ }
  return { on: seeded, restored: false, failed: true };
}

/**
 * Why an immersive request was refused, in one word for the record.
 *
 * Quest Browser is Chromium, and Chromium gates every immersive
 * `requestSession` on `CheckImmersiveSessionRequestAllowed`
 * (`third_party/blink/renderer/modules/xr/xr_system.cc`). The first thing that
 * function asks is `LocalFrame::HasTransientUserActivation`, and it answers a
 * page without one by rejecting with `SecurityError` and the console line
 * "The requested session requires user activation."
 *
 * Nothing that happens inside an immersive session grants that activation.
 * `xr_session.cc` never calls `NotifyUserActivation`, so a controller `select`,
 * a squeeze, and a gamepad face button are all silent as far as the activation
 * state is concerned, and the `end()` promise carries none either — it is a
 * promise, not an input event. The only source is a real DOM activation event
 * on the 2D page, which on Quest means the wearer pointing at the page and
 * pulling the trigger.
 *
 * That is why the switch is written as an optimistic attempt with a page
 * fallback rather than as a guarantee. A runtime that does allow the request —
 * a WebXR emulator, which enforces none of this; a wearer who pressed Enter VR
 * less than the five-second activation lifetime ago; a future browser that
 * treats a primary action as activation — switches with nothing shown. Every
 * other case has to be handed back to a page button, and this is what tells
 * the two apart.
 *
 * @param {any} error the rejection from `requestSession` or from entry
 * @returns {'activation'|'busy'|'unsupported'|'timeout'|'failed'}
 */
export function entryRefusalReason(error) {
  const name = error?.name, code = error?.code;
  if (code === 'xr_request_timeout' || code === 'xr_startup_timeout' || code === 'xr_teardown_timeout') return 'timeout';
  if (name === 'SecurityError' || name === 'NotAllowedError') return 'activation';
  if (name === 'InvalidStateError' || name === 'InvalidAccessError') return 'busy';
  if (name === 'NotSupportedError') return 'unsupported';
  return 'failed';
}

/**
 * The words the page and the headset use for a re-entry the wearer must press.
 *
 * One button, named for the thing the wearer asked for rather than for the
 * mechanism, and one sentence that says where the button is. The wearer has
 * just been dropped out of immersion onto a 2D page holding a controller: the
 * only useful thing to tell them is which press puts them back.
 *
 * @param {'immersive-ar'|'immersive-vr'} mode the mode the switch was going to
 * @returns {{label:string, caption:string, note:string}}
 */
export function entryFallbackCopy(mode) {
  const label = mode === 'immersive-ar' ? 'Enter passthrough' : 'Enter VR';
  return { label, caption: `Press ${label} on the page.`,
    note: mode === 'immersive-ar'
      ? 'One press puts your room back behind the structure.'
      : 'One press opens the opaque room without your surroundings.' };
}

// WebXR has no abort API for requestSession. A deadline can release our UI,
// but must not allow another request while the native request is outstanding.
export function requestHeadsetSession(runtime, mode, { timeoutMs = HEADSET_ENTRY_DEADLINE_MS, onTimeout = () => {},
  optionalFeatures = HEADSET_OPTIONAL_FEATURES } = {}) {
  let expired = false, timer;
  // Keep the trusted entry call to the smallest native request that still
  // offers this device its optional input and space features. Nothing is
  // required: the viewer asks for its local reference space only after the
  // session is accepted, and an unsupported optional feature is dropped by
  // the runtime rather than rejecting the request.
  const native = runtime.requestSession(mode, { optionalFeatures: [...optionalFeatures] });
  const accepted = Promise.resolve(native).then(async session => {
    if (expired) {
      try { await session.end(); } catch { /* The headset may already have ended it. */ }
      throw Object.assign(new Error('The expired headset request was closed.'), { code: 'xr_request_timeout' });
    }
    return session;
  });
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      // A diagnostic hook must never prevent the request promise from
      // settling. The native request still has no cancellation API, so the
      // late-session branch above remains responsible for closing a grant
      // that arrives after this deadline.
      try { onTimeout(); } catch { /* Keep the timeout outcome observable. */ }
      reject(Object.assign(new Error('The headset did not finish opening immersive mode. Reload this page to clear the pending request.'), { code: 'xr_request_timeout' }));
    }, timeoutMs);
  });
  return Promise.race([accepted, deadline]).finally(() => clearTimeout(timer));
}
