/**
 * The molecule's own WebXR projection layer, behind `?xrLayers=1`.
 *
 * Mol* 5.11 builds an `XRWebGLLayer` inside `webgl.xr.set`, hands it to the
 * session as `baseLayer`, then on every frame reads
 * `session.renderState.baseLayer`, sizes its draw from `framebufferWidth` and
 * `framebufferHeight`, asks `getViewport(view)` for each eye and binds
 * `framebuffer`. Nothing else about the layer matters to it.
 *
 * So the seam is runtime-only and session-local, the same kind as the MSAA
 * constructor swap in `xr-session-request.mjs`:
 *
 * - While one session attaches, `XRWebGLLayer` is wrapped. Mol*'s
 *   construction for that session builds an `XRWebGLBinding` and an
 *   `XRProjectionLayer` (`textureType: 'texture'`, so both eyes share one
 *   side-by-side texture like the base layer) and returns a facade with the
 *   four members Mol* reads.
 * - That one session's `updateRenderState({ baseLayer: facade })` becomes
 *   `updateRenderState({ layers: [projectionLayer, ...overlays] })`, and its
 *   `renderState.baseLayer` reads the facade once those layers are live. Every
 *   other reader of the base layer (fixed foveation, the render budget, the
 *   frame governor, captures, the sphere occlusion pass) therefore keeps
 *   working on the facade without a change.
 * - The facade's framebuffer is ours. Each callback that draws attaches the
 *   colour texture `getViewSubImage` returns for that frame, since the browser
 *   may hand out a different texture every frame and detaches it when the
 *   callback ends.
 *
 * Mol*'s pointer pass attaches its own depth texture to whatever framebuffer
 * is bound when it draws to the drawing buffer, then detaches it. A browser's
 * base layer framebuffer is opaque and refuses both calls; the page's
 * presentation depth adapter (`immersive-session.mjs`) turns them into no-ops
 * for every session, and the projection layer needs it to: the facade's
 * framebuffer is an ordinary one, and without the adapter the detach leaves
 * it with no depth, so back faces cover front faces. Depth is attached again
 * with the colour on every frame, so a stray change lasts one frame at most.
 *
 * Depth is a private renderbuffer, never the layer's depth texture. The layer
 * is created with `depthFormat: 0`, so the compositor is told to ignore depth
 * and has none to read. On a tiled GPU the renderbuffer is invalidated as soon
 * as the molecule has drawn, so its tile memory is discarded rather than
 * stored. Adreno's foveation extension (`QCOM_texture_foveated`, issue 5) says
 * a depth attachment inherits foveation from the foveated colour attachment it
 * shares a framebuffer with, and that it should be discarded after rendering
 * for exactly this reason.
 *
 * With the switch absent nothing here runs. With the switch on but no
 * `layers` grant, no `XRWebGLBinding`, or a layer the browser will not build,
 * Mol* gets the stock layer and the `xr-layers` diagnostic says why.
 *
 * A projection layer that stops giving the molecule somewhere to draw would
 * leave the wearer in an empty view with no menu, since Mol* keeps the facade
 * for the life of the session. So the facade can change what is behind it:
 * after `MOLECULE_FAULT_FRAMES` frames in a row without a texture to draw
 * into, or one frame whose two eyes arrive on separate textures, the session
 * is handed a stock `XRWebGLLayer` as its base layer, the facade answers from
 * that layer from then on, and every overlay is told so it can give the
 * controls back to the molecule's pass. If the browser will not take the
 * stock layer either, the session is ended and the page is told why in words
 * (`XR_PROBLEM_EVENT`).
 */

/** The page query that turns the projection layer on, with the value `1`. */
export const XR_LAYERS_PARAM = 'xrLayers';
/** The diagnostics kind every record from this module uses. */
export const XR_LAYERS_DIAGNOSTIC = 'xr-layers';
/** The session feature the layer stack needs. */
export const XR_LAYERS_FEATURE = 'layers';
/** Frames in a row the molecule's layer may fail to give a texture before a stock layer takes over. */
export const MOLECULE_FAULT_FRAMES = 3;
/** Frames a stock layer may take to become the session's base layer before the session is ended. */
export const STOCK_LAYER_FRAMES = 30;
/**
 * Frames the requested projection layer may take to appear in
 * `renderState.layers` before a stock layer takes over. Until it appears
 * Mol* has no base layer and draws nothing.
 */
export const LAYER_APPLY_FRAMES = 30;
/**
 * The window event that carries the reason a session was ended here, as
 * `detail.message`, for the flat page the wearer is dropped back to.
 */
export const XR_PROBLEM_EVENT = 'stereofold-xr-problem';
/** What that page shows when the layers failed and no stock layer could replace them. */
export const XR_LAYERS_ENDED_MESSAGE = 'The headset view closed because its display layers stopped drawing. '
  + 'Enter again, or remove xrLayers=1 from the page address if it happens again.';

const GL_RGBA = 0x1908;
const SUPPORTED_LAYOUTS = new Set(['stereo-left-right', 'stereo-top-bottom', 'mono']);
const stacks = new WeakMap();

/**
 * Whether the page asked for the projection layer: true only for
 * `?xrLayers=1`. Never throws.
 *
 * @param {{location?:{search?:string}}} [scope]
 */
export function xrLayersRequested(scope = globalThis) {
  try { return new URLSearchParams(String(scope?.location?.search ?? '')).get(XR_LAYERS_PARAM) === '1'; }
  catch { return false; }
}

/**
 * The optional features to request, with `layers` added only when the switch
 * is on. With the switch off the list is returned unchanged in content and
 * order.
 *
 * @param {Iterable<string>} features
 * @param {object} [scope]
 * @returns {string[]}
 */
export function withXrLayersFeature(features, scope = globalThis) {
  const list = [...features];
  if (xrLayersRequested(scope) && !list.includes(XR_LAYERS_FEATURE)) list.push(XR_LAYERS_FEATURE);
  return list;
}

/**
 * The live layer stack for a session, or `null` on the stock path.
 *
 * The stack exists from the moment Mol* builds its layer inside
 * `webgl.xr.set` until the session ends or the page restores it.
 *
 * @param {XRSession} session
 */
export function getXrLayerStack(session) {
  if (!session || (typeof session !== 'object' && typeof session !== 'function')) return null;
  return stacks.get(session) ?? null;
}

function recorder(scope) {
  return detail => {
    try { (scope?.__stereofoldDiagnostics ?? globalThis.__stereofoldDiagnostics)?.record?.(XR_LAYERS_DIAGNOSTIC, detail); }
    catch { /* A diagnostics sink that throws must not cost the session. */ }
  };
}

function errorText(error) {
  try { return `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`.slice(0, 200); }
  catch { return 'Error'; }
}

function read(get, fallback = undefined) {
  try { return get(); } catch { return fallback; }
}

/**
 * Prepare one session for the projection layer. Call it after the session is
 * granted and before `canvas.webgl.xr.set(session)`, and only when
 * `xrLayersRequested()` is true.
 *
 * Never throws. Returns `restore()`, which is idempotent and removes every
 * wrapper, session property and GL object this module made; it also runs by
 * itself when the session ends.
 *
 * @param {object} options
 * @param {XRSession} options.session the session Mol* is about to attach
 * @param {XRSpace} [options.space] reference space for the viewer pose passed
 *   to after-frame callbacks
 * @param {() => number|undefined} [options.drawCount] Canvas3D's draw counter,
 *   used to find the callback in which Mol* drew; without it, the callback
 *   that touched the layer is taken to be that one
 * @param {boolean} [options.keepsMsaa] the stock layer keeps MSAA on this
 *   device (`keepsXrLayerMsaa`): the stock path is kept
 * @param {object} [options.scope] global carrying `XRWebGLLayer`,
 *   `XRWebGLBinding` and the diagnostics sink
 * @returns {{installed:boolean, reason:string, restore:()=>void}}
 */
export function installXrLayers({ session, space, drawCount = () => undefined, keepsMsaa = false, scope = globalThis } = {}) {
  const record = recorder(scope);
  const stock = reason => {
    record({ path: 'stock', reason });
    return { installed: false, reason, restore() {} };
  };
  // The projection layer has no MSAA. Only the measured Quest classes give it
  // up on the stock path too; anywhere else the molecule would lose it.
  if (keepsMsaa) return stock('device-keeps-msaa');
  const Binding = read(() => scope?.XRWebGLBinding);
  const Prior = read(() => scope?.XRWebGLLayer);
  if (!session) return stock('no-session');
  if (typeof Binding !== 'function') return stock('no-binding');
  if (typeof Prior !== 'function') return stock('no-webgl-layer');
  const enabled = read(() => session.enabledFeatures);
  // A browser that reports its grants and left `layers` out has said no. One
  // that does not report them is asked; a refusal surfaces from the binding.
  if (Array.isArray(enabled) && !enabled.includes(XR_LAYERS_FEATURE)) return stock('layers-not-granted');

  let restored = false, built = null, building = false;
  function XRWebGLLayerForProjection(layerSession, context, options) {
    // A binding implemented in script (a WebXR Layers polyfill) builds its
    // own base layer through this same global, during or after this call.
    if (restored || built || building || layerSession !== session) return new Prior(layerSession, context, options);
    building = true;
    try {
      built = buildProjectionStack({ session, gl: context, options, Binding, Stock: Prior, space, drawCount, record, scope });
    } catch (error) {
      record({ path: 'stock', reason: error?.stereofoldReason ?? 'projection-layer-failed', error: errorText(error) });
      return new Prior(layerSession, context, options);
    } finally { building = false; }
    try { session.addEventListener?.('end', restore, { once: true }); } catch { /* The page's restore still runs. */ }
    return built.facade;
  }
  XRWebGLLayerForProjection.__stereofoldProjectionLayer = true;
  // Inherit the statics (`getNativeFramebufferScaleFactor`) and the prototype
  // so `instanceof XRWebGLLayer` still answers for stock layers made through it.
  Object.setPrototypeOf(XRWebGLLayerForProjection, Prior);
  XRWebGLLayerForProjection.prototype = Prior.prototype;
  try { scope.XRWebGLLayer = XRWebGLLayerForProjection; }
  catch { return stock('constructor-locked'); }
  if (scope.XRWebGLLayer !== XRWebGLLayerForProjection) return stock('constructor-locked');

  function restore() {
    if (restored) return;
    restored = true;
    try { session.removeEventListener?.('end', restore); } catch { /* Already detached. */ }
    // A wrapper installed after this one owns the slot; leave it in place.
    try { if (scope.XRWebGLLayer === XRWebGLLayerForProjection) scope.XRWebGLLayer = Prior; }
    catch { /* A frozen global keeps the wrapper, which now always builds stock layers. */ }
    if (built) {
      const stack = built;
      built = null;
      stack.dispose();
    }
  }
  return { installed: true, reason: 'waiting-for-layer', restore };
}

function buildProjectionStack({ session, gl, options, Binding, Stock, space, drawCount, record, scope }) {
  const fail = (reason, message) => Object.assign(new Error(message), { stereofoldReason: reason });
  if (!gl || typeof gl.createFramebuffer !== 'function') throw fail('no-context', 'The layer has no WebGL context.');
  const gl2 = typeof gl.invalidateFramebuffer === 'function' && Number.isFinite(gl.DRAW_FRAMEBUFFER);
  const binding = new Binding(session, gl);
  if (typeof binding?.createProjectionLayer !== 'function' || typeof binding?.getViewSubImage !== 'function') {
    throw fail('no-projection-layer', 'The binding cannot build a projection layer.');
  }
  const scale = Number(options?.framebufferScaleFactor);
  const projectionLayer = binding.createProjectionLayer({ textureType: 'texture', colorFormat: GL_RGBA, depthFormat: 0,
    scaleFactor: Number.isFinite(scale) && scale > 0 ? scale : 1 });
  const layout = read(() => projectionLayer.layout);
  // One framebuffer draws both eyes, so both views must live in one texture.
  if (layout !== undefined && !SUPPORTED_LAYOUTS.has(layout)) {
    try { projectionLayer.destroy?.(); } catch { /* Discarded either way. */ }
    throw fail('unsupported-layout', `The projection layer layout is ${String(layout)}.`);
  }
  const textureWidth = read(() => projectionLayer.textureWidth), textureHeight = read(() => projectionLayer.textureHeight);
  // Where Mol* leaves the background transparent (passthrough), the room
  // shows only if the compositor reads the texture's alpha. The browser's
  // default is not relied on: a false one composites that background black.
  const sourceAlpha = (() => {
    try { projectionLayer.blendTextureSourceAlpha = true; return projectionLayer.blendTextureSourceAlpha === true; } catch { return false; }
  })();
  if (!Number.isSafeInteger(textureWidth) || !Number.isSafeInteger(textureHeight) || textureWidth <= 0 || textureHeight <= 0) {
    try { projectionLayer.destroy?.(); } catch { /* Discarded either way. */ }
    throw fail('unsupported-size', 'The projection layer reports no texture size.');
  }

  const subscribers = new Set();
  const retireListeners = new Set();
  const capturePainters = new Set();
  const subscriberErrors = new WeakSet();
  const reported = new Set();
  const facts = { frames: 0, molecularFrames: 0, attaches: 0, invalidations: 0, errors: 0, overlays: 0 };
  let overlays = [];
  let disposed = false, contextLost = false, live = false, firstFrameRecorded = false;
  // The stock layer the facade answers from once the projection layer has
  // been given up, and what led there.
  let stockLayer = null, retired = false, ended = false, projectionDestroyed = false;
  let faultedInCallback = false, splitInCallback = false, faultFrames = 0;
  let framebuffer = null, depthBuffer = null, depthWidth = 0, depthHeight = 0;
  let currentFrame = null, inCallback = false, attachedInCallback = false, attachedColor = null;
  // Which animation frame a callback belongs to. A headset browser may hand
  // every frame the same XRFrame object, so the callback time tells frames
  // apart; the object is used only when no time is given.
  const NO_FRAME = Symbol('no frame');
  const frameKey = (time, frame) => (Number.isFinite(time) ? time : frame);
  let lastMolecularFrame = NO_FRAME;

  // The faults that leave the molecule with no texture to draw into.
  const TEXTURE_FAULTS = new Set(['view-sub-image', 'no-color-texture', 'attach', 'viewer-pose']);
  const fault = (where, error) => {
    facts.errors++;
    if (inCallback && TEXTURE_FAULTS.has(where)) faultedInCallback = true;
    if (reported.has(where)) return;
    reported.add(where);
    record({ path: 'layers', phase: 'error', where, error: errorText(error) });
  };
  const lost = () => contextLost || read(() => gl.isContextLost?.(), false) === true;
  const fbTarget = gl2 ? gl.DRAW_FRAMEBUFFER : gl.FRAMEBUFFER;
  const fbBinding = gl2 ? gl.DRAW_FRAMEBUFFER_BINDING : gl.FRAMEBUFFER_BINDING;

  function ensureFramebuffer() {
    if (!framebuffer && !disposed && !lost()) framebuffer = gl.createFramebuffer();
    return framebuffer;
  }

  /** Bind ours on the draw target, run `fn`, and put the caller's binding back. */
  function withFramebuffer(fn) {
    const previous = gl.getParameter(fbBinding);
    if (previous !== framebuffer) gl.bindFramebuffer(fbTarget, framebuffer);
    try { fn(); }
    finally { if (previous !== framebuffer) gl.bindFramebuffer(fbTarget, previous); }
  }

  /** Size the private depth buffer if needed, and attach it to the bound framebuffer. */
  function attachDepth(width, height) {
    if (!depthBuffer || depthWidth !== width || depthHeight !== height) {
      const previous = gl.getParameter(gl.RENDERBUFFER_BINDING);
      if (!depthBuffer) depthBuffer = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, depthBuffer);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl2 ? gl.DEPTH_COMPONENT24 : gl.DEPTH_COMPONENT16, width, height);
      gl.bindRenderbuffer(gl.RENDERBUFFER, previous);
      depthWidth = width; depthHeight = height;
    }
    gl.framebufferRenderbuffer(fbTarget, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthBuffer);
  }

  function attach(subImage) {
    const color = subImage?.colorTexture;
    if (!color) { fault('no-color-texture', new Error('The sub-image has no colour texture.')); return; }
    if (attachedInCallback) {
      if (color === attachedColor) return;
      // Both eyes are drawn into one framebuffer between two clears, so a
      // second texture in the same callback cannot be honoured.
      fault('split-textures', new Error('The two views returned different colour textures.'));
      splitInCallback = true;
      return;
    }
    if (disposed || lost() || !ensureFramebuffer()) return;
    const width = read(() => subImage.colorTextureWidth) || textureWidth;
    const height = read(() => subImage.colorTextureHeight) || textureHeight;
    try {
      withFramebuffer(() => {
        gl.framebufferTexture2D(fbTarget, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, color, 0);
        attachDepth(width, height);
      });
    } catch (error) { fault('attach', error); return; }
    attachedColor = color;
    attachedInCallback = inCallback;
    facts.attaches++;
    if (!firstFrameRecorded) {
      firstFrameRecorded = true;
      record({ path: 'layers', phase: 'first-frame', colorTextureWidth: width, colorTextureHeight: height,
        depth: 'private', depthBits: gl2 ? 24 : 16, fixedFoveation: read(() => projectionLayer.fixedFoveation, null) ?? null });
    }
  }

  function viewport(view) {
    if (stockLayer) return stockLayer.getViewport(view);
    let subImage;
    try { subImage = binding.getViewSubImage(projectionLayer, view); }
    catch (error) { fault('view-sub-image', error); return { x: 0, y: 0, width: 0, height: 0 }; }
    attach(subImage);
    return subImage.viewport;
  }

  /** Attach for a callback that binds the framebuffer before asking for a viewport. */
  function attachFromFrame() {
    if (!currentFrame || !space) return;
    let pose;
    try { pose = currentFrame.getViewerPose(space); } catch (error) { fault('viewer-pose', error); return; }
    const view = pose?.views?.[0];
    if (view) viewport(view);
  }

  function boundFramebuffer() {
    if (stockLayer) return stockLayer.framebuffer;
    if (disposed) return null;
    if (inCallback && !attachedInCallback && live) attachFromFrame();
    return ensureFramebuffer();
  }

  // Mol* reads `framebuffer`, the two sizes and `getViewport`. `antialias` is
  // false because a projection layer has no multisampling, which is also what
  // the stock Quest layer asks for; `ignoreDepthValues` follows
  // `depthFormat: 0`. `fixedFoveation` exists only when the projection layer
  // has it, so `applyFoveation` still reports an unsupported runtime.
  // `getViewport` stays writable: the frame governor wraps it in place.
  const layerFacade = Object.defineProperties({}, {
    framebuffer: { get: boundFramebuffer, enumerable: true },
    framebufferWidth: { get: () => (stockLayer ? stockLayer.framebufferWidth : textureWidth), enumerable: true },
    framebufferHeight: { get: () => (stockLayer ? stockLayer.framebufferHeight : textureHeight), enumerable: true },
    antialias: { get: () => (stockLayer ? stockLayer.antialias === true : false), enumerable: true },
    ignoreDepthValues: { get: () => read(() => (stockLayer ?? projectionLayer).ignoreDepthValues, true), enumerable: true },
    projectionLayer: { value: projectionLayer, enumerable: true },
    getViewport: { value: viewport, writable: true, configurable: true },
  });
  if (read(() => 'fixedFoveation' in projectionLayer, false)) {
    Object.defineProperty(layerFacade, 'fixedFoveation', { enumerable: true,
      get: () => read(() => (stockLayer ?? projectionLayer).fixedFoveation, null),
      set: value => { (stockLayer ?? projectionLayer).fixedFoveation = value; } });
  }

  function invalidateDepth() {
    if (!gl2 || !depthBuffer || !framebuffer || lost()) return;
    try {
      withFramebuffer(() => gl.invalidateFramebuffer(fbTarget, [gl.DEPTH_ATTACHMENT]));
      facts.invalidations++;
    } catch (error) { fault('invalidate-depth', error); }
  }

  function afterCallback(frame, key, drawsBefore) {
    if (!attachedInCallback || key === lastMolecularFrame) return;
    const drawsAfter = read(drawCount);
    if (Number.isFinite(drawsBefore) && Number.isFinite(drawsAfter) && drawsAfter === drawsBefore) return;
    lastMolecularFrame = key;
    facts.molecularFrames++;
    // Before anything else binds a framebuffer, so the tiler drops the
    // molecule's depth instead of storing it when its pass closes.
    invalidateDepth();
    if (!subscribers.size) return;
    let pose = null;
    try { pose = space ? frame?.getViewerPose?.(space) ?? null : null; } catch (error) { fault('viewer-pose', error); }
    for (const callback of [...subscribers]) {
      try { callback(frame, pose); }
      catch (error) {
        facts.errors++;
        if (subscriberErrors.has(callback)) continue;
        subscriberErrors.add(callback);
        record({ path: 'layers', phase: 'error', where: 'after-frame', error: errorText(error) });
      }
    }
  }

  // Session-local overrides. Each remembers what it replaced so it can be
  // put back exactly, and each turns into a pass-through once disposed in
  // case another wrapper has been installed on top of it.
  const ownState = Object.getOwnPropertyDescriptor(session, 'renderState');
  const readState = () => ownState
    ? (ownState.get ? ownState.get.call(session) : ownState.value)
    : Reflect.get(Object.getPrototypeOf(session), 'renderState', session);
  let viewedState = null, stateView = null;
  const isLive = state => {
    const layers = read(() => state?.layers);
    if (Array.isArray(layers)) return layers.includes(projectionLayer);
    // A browser that does not expose `renderState.layers` applies the request
    // at the top of the next frame, as for any render state.
    return requestedAtFrame !== null && facts.frames > requestedAtFrame;
  };
  const viewOf = state => {
    if (!state || (typeof state !== 'object' && typeof state !== 'function')) return state;
    if (state !== viewedState) {
      viewedState = state;
      stateView = new Proxy(state, { get(target, key) {
        if (key === 'baseLayer' && !disposed) {
          // Like a stock base layer, the facade appears once the browser has
          // applied the render state, at the top of a later frame.
          if (isLive(target)) { live = true; return layerFacade; }
        }
        return Reflect.get(target, key, target);
      } });
    }
    return stateView;
  };
  const ownUpdate = Object.prototype.hasOwnProperty.call(session, 'updateRenderState');
  const priorUpdate = session.updateRenderState;
  const ownFrame = Object.prototype.hasOwnProperty.call(session, 'requestAnimationFrame');
  const priorFrame = session.requestAnimationFrame;
  const layerList = () => [projectionLayer, ...overlays];
  let requestedAtFrame = null, lastSeenFrame = NO_FRAME;

  function updateRenderState(init) {
    if (!disposed && init && init.baseLayer === layerFacade) {
      const { baseLayer: _replaced, ...rest } = init;
      const result = priorUpdate.call(this, { ...rest, layers: layerList() });
      requestedAtFrame ??= facts.frames;
      return result;
    }
    return priorUpdate.call(this, init);
  }
  function requestAnimationFrame(callback) {
    if (disposed || typeof callback !== 'function') return priorFrame.call(this, callback);
    return priorFrame.call(this, (time, frame) => {
      if (disposed) return callback(time, frame);
      currentFrame = frame; inCallback = true; attachedInCallback = false;
      faultedInCallback = false; splitInCallback = false;
      const key = frameKey(time, frame);
      if (key !== lastSeenFrame) { lastSeenFrame = key; facts.frames++; }
      const drawsBefore = read(drawCount);
      try { return callback(time, frame); }
      finally {
        try { afterCallback(frame, key, drawsBefore); } catch (error) { fault('after-callback', error); }
        const attached = attachedInCallback;
        currentFrame = null; inCallback = false; attachedInCallback = false;
        // After the callback, never inside Mol*'s draw: a frame that found no
        // texture counts toward giving the layer up, one that drew clears the count.
        if (splitInCallback) retire('split-textures');
        else if (attached) faultFrames = 0;
        else if (faultedInCallback && ++faultFrames >= MOLECULE_FAULT_FRAMES) retire('no-texture');
        else if (!live && requestedAtFrame !== null && facts.frames - requestedAtFrame > LAYER_APPLY_FRAMES
          && !isLive(read(readState))) retire('layer-not-applied');
      }
    });
  }
  try {
    Object.defineProperty(session, 'renderState', { configurable: true, enumerable: ownState?.enumerable ?? false,
      get() { return viewOf(readState()); } });
    session.updateRenderState = updateRenderState;
    session.requestAnimationFrame = requestAnimationFrame;
  } catch (error) {
    unwindSession();
    try { projectionLayer.destroy?.(); } catch { /* Discarded either way. */ }
    throw fail('session-locked', errorText(error));
  }

  function unwindSession() {
    try {
      if (ownState) Object.defineProperty(session, 'renderState', ownState);
      else delete session.renderState;
    } catch { /* The pass-through view stays, and shows no facade once disposed. */ }
    try {
      if (session.updateRenderState === updateRenderState) {
        if (ownUpdate) session.updateRenderState = priorUpdate; else delete session.updateRenderState;
      }
    } catch { /* Disposed wrappers pass through. */ }
    try {
      if (session.requestAnimationFrame === requestAnimationFrame) {
        if (ownFrame) session.requestAnimationFrame = priorFrame; else delete session.requestAnimationFrame;
      }
    } catch { /* Disposed wrappers pass through. */ }
  }

  function onContextLost() {
    // Objects from a lost context are dead; never touch them again. A restored
    // context gets new ones on the next draw.
    contextLost = true;
    framebuffer = null; depthBuffer = null; depthWidth = depthHeight = 0;
    attachedColor = null; attachedInCallback = false;
    record({ path: 'layers', phase: 'context-lost' });
  }
  function onContextRestored() { contextLost = false; }
  const canvas = read(() => gl.canvas);
  try {
    canvas?.addEventListener?.('webglcontextlost', onContextLost);
    canvas?.addEventListener?.('webglcontextrestored', onContextRestored);
  } catch { /* `isContextLost()` still guards every GL call. */ }

  function destroyProjection() {
    if (projectionDestroyed) return;
    projectionDestroyed = true;
    try { projectionLayer.destroy?.(); } catch { /* The ended session has already released it. */ }
  }

  /** Close the session, and tell the page the wearer lands on why. */
  function endSession(reason) {
    record({ path: 'layers', phase: 'session-ended', reason });
    try {
      const Event = scope?.CustomEvent ?? globalThis.CustomEvent;
      (scope?.dispatchEvent ? scope : globalThis).dispatchEvent?.(new Event(XR_PROBLEM_EVENT,
        { detail: { message: XR_LAYERS_ENDED_MESSAGE, reason } }));
    } catch { /* No page to tell; the session still ends. */ }
    try { Promise.resolve(session.end?.()).catch(() => {}); } catch { /* Already ending. */ }
  }

  /**
   * A stock layer the browser accepted synchronously may still never become
   * the base layer. Mol* draws nothing until it does, so if it has not after
   * `STOCK_LAYER_FRAMES` the session is ended rather than left empty. The
   * projection layer is kept until then: destroying a layer the compositor
   * still shows is not known to be safe.
   */
  function watchStockLayer() {
    let frames = 0;
    const check = () => {
      if (ended) return;
      if (read(() => readState()?.baseLayer) === stockLayer) {
        record({ path: 'stock', phase: 'stock-layer-live', frames });
        destroyProjection();
        return;
      }
      if (++frames >= STOCK_LAYER_FRAMES) { endSession('stock-layer-not-applied'); return; }
      try { priorFrame.call(session, check); } catch { endSession('stock-layer-not-applied'); }
    };
    try { priorFrame.call(session, check); } catch { endSession('stock-layer-not-applied'); }
  }

  /**
   * Give the projection layer up for the rest of the session: hand the
   * session a stock base layer, tell the overlays, and let go of everything
   * but the facade, which answers from the stock layer from here on.
   */
  function retire(reason) {
    if (disposed || retired) return;
    retired = true;
    let stock = null, refused;
    try {
      stock = new Stock(session, gl, options);
      priorUpdate.call(session, { baseLayer: stock });
    } catch (error) { stock = null; refused = error; }
    // Overlays first, so the controls are back in the molecule's pass before
    // the stock layer's first frame.
    for (const callback of [...retireListeners]) {
      try { callback(reason); } catch { /* One overlay's teardown must not stop the hand-back. */ }
    }
    if (!stock) {
      record({ path: 'layers', phase: 'hand-back-refused', reason, error: errorText(refused) });
      release();
      endSession(reason);
      return;
    }
    stockLayer = stock;
    record({ path: 'stock', phase: 'handed-back', reason, faultFrames,
      framebufferWidth: read(() => stock.framebufferWidth, null) ?? null, framebufferHeight: read(() => stock.framebufferHeight, null) ?? null });
    release();
    watchStockLayer();
  }

  const stack = Object.freeze({
    session, gl, binding, projectionLayer, space,
    /**
     * Layers composited above the molecule, in order. Replaces the previous
     * list; an empty list leaves the molecule alone. Applied by the browser at
     * the top of a later frame.
     */
    setOverlayLayers(layers) {
      if (disposed || retired) return false;
      const list = Array.from(layers ?? []);
      if (list.some(layer => !layer || layer === projectionLayer)) throw new TypeError('Overlay layers must be layers other than the molecule layer.');
      if (new Set(list).size !== list.length) throw new TypeError('Overlay layers must not repeat.');
      const limit = read(() => session.maxRenderLayers);
      if (Number.isSafeInteger(limit) && limit > 0 && list.length + 1 > limit) throw new RangeError(`This session composites at most ${limit} layers.`);
      overlays = list;
      facts.overlays = list.length;
      if (requestedAtFrame !== null) priorUpdate.call(session, { layers: layerList() });
      return true;
    },
    /** The overlays most recently set. */
    overlayLayers: () => [...overlays],
    /**
     * `callback(frame, viewerPose)` once per XR frame, after Mol* drew both
     * eyes, inside the same animation-frame callback. `viewerPose` is read in
     * `space`. The molecule's depth is already discarded by then: draw into
     * an overlay's own target. Returns the unsubscribe.
     */
    onAfterMolecularFrame(callback) {
      if (typeof callback !== 'function' || disposed) return () => {};
      subscribers.add(callback);
      return () => { subscribers.delete(callback); };
    },
    /**
     * `callback(reason)` once, if the molecule's layer is given up and the
     * session goes back to a stock base layer. From then on the stack takes
     * no overlays and runs no after-frame callback: an overlay releases its
     * layers and puts what it drew back where the stock path draws it.
     * Returns the unsubscribe.
     */
    onRetire(callback) {
      if (typeof callback !== 'function' || disposed || retired) return () => {};
      retireListeners.add(callback);
      return () => { retireListeners.delete(callback); };
    },
    /**
     * `painter(still)` for an overlay that a still of the wearer's view has
     * to include. A still is read from the molecule's layer, which holds none
     * of the overlays, so each painter draws what its layers show over it.
     * `still` is what `paintCapture` was given. A painter returns true once
     * its layers are in the still. Returns the unsubscribe.
     */
    onCapture(painter) {
      if (typeof painter !== 'function' || disposed) return () => {};
      capturePainters.add(painter);
      return () => { capturePainters.delete(painter); };
    },
    /**
     * Draw every overlay into a still of one eye, for whoever read that eye
     * out of the molecule's layer in this animation frame: `{ view,
     * framebuffer, width, height }`, the XR view the still shows and the
     * framebuffer that holds it. `undefined` when no overlay has anything to
     * add, so the still is already whole; otherwise whether every painter
     * drew. Never throws.
     */
    paintCapture(still) {
      if (disposed || !capturePainters.size) return undefined;
      let painted = true;
      for (const painter of [...capturePainters]) {
        try { if (painter(still) !== true) painted = false; }
        catch (error) { painted = false; fault('capture', error); }
      }
      return painted;
    },
    facts: () => ({ ...facts, live, retired, layout: layout ?? null, textureWidth, textureHeight }),
    dispose,
  });

  /** Everything but the projection layer itself: session overrides, listeners and GL objects. */
  function release() {
    if (disposed) return;
    disposed = true;
    stacks.delete(session);
    subscribers.clear();
    retireListeners.clear();
    capturePainters.clear();
    unwindSession();
    try {
      canvas?.removeEventListener?.('webglcontextlost', onContextLost);
      canvas?.removeEventListener?.('webglcontextrestored', onContextRestored);
    } catch { /* The canvas is going away with its page. */ }
    if (!lost()) {
      try { if (framebuffer) gl.deleteFramebuffer(framebuffer); } catch { /* Released with the context. */ }
      try { if (depthBuffer) gl.deleteRenderbuffer(depthBuffer); } catch { /* Released with the context. */ }
    }
    framebuffer = null; depthBuffer = null; attachedColor = null;
    currentFrame = null; lastSeenFrame = lastMolecularFrame = NO_FRAME; viewedState = null; stateView = null; overlays = [];
  }

  function dispose() {
    if (ended) return;
    ended = true;
    release();
    destroyProjection();
    // The facade outlives the session in Mol*'s hands; it holds no layer then.
    stockLayer = null;
    record({ path: 'layers', phase: 'ended', ...facts, live, retired });
  }

  stacks.set(session, stack);
  record({ path: 'layers', phase: 'created', layout: layout ?? null, textureWidth, textureHeight,
    scaleFactor: Number.isFinite(scale) && scale > 0 ? scale : 1, depth: 'private', sourceAlpha,
    ignoreDepthValues: read(() => projectionLayer.ignoreDepthValues, null) ?? null,
    maxRenderLayers: read(() => session.maxRenderLayers, null) ?? null });
  return { facade: layerFacade, stack, dispose };
}
