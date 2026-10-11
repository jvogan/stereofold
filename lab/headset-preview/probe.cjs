'use strict';

// These two functions run inside the isolated page. Instrumentation observes GL
// calls and stock Mol* events. The XR-only scheduling adapter uses Canvas3D's
// synchronous loop; the molecular renderer and IWER frame guard remain intact.
function installProbe() {
  if (typeof IWER?.XRDevice !== 'function' || IWER.metaQuest2?.name !== 'Meta Quest 2') throw Error('Unexpected IWER exports');
  const device = new IWER.XRDevice(IWER.metaQuest2);
  device.installRuntime({ forceInstall: true }); // Chromium exposes native XR even without a connected headset.
  device.stereoEnabled = true;
  device.primaryInputMode = 'controller';
  for (const controller of Object.values(device.controllers)) controller.connected = false;
  const initialHeadPosition = { x: device.position.x, y: device.position.y, z: device.position.z };
  const probe = window.__xrProbe = { device, initialHeadPosition, contexts: new Set(), active: null,
    tracePhase: null, glErrorCount: 0, glErrors: [] };
  probe.referenceAdapter = window.__previewAdapters.installReferenceSpaceAdapter(IWER);
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
    const gl = getContext.call(this, kind, ...args);
    if (!gl || !['webgl', 'webgl2', 'experimental-webgl'].includes(kind) || probe.contexts.has(gl)) return gl;
    probe.contexts.add(gl);
    const nativeGetError = gl.getError.bind(gl);
    const trace = method => {
      if (!probe.tracePhase) return;
      for (let i = 0; i < 16; i++) {
        const code = nativeGetError(); if (code === gl.NO_ERROR) break;
        probe.glErrorCount++;
        if (probe.glErrors.length < 64) probe.glErrors.push({ method, code, phase: probe.tracePhase,
          time: performance.now(), stack: new Error(`GL error ${code} after ${method}`).stack });
      }
    };
    let viewport = Array.from(gl.getParameter(gl.VIEWPORT)), framebuffer = null;
    const wrap = (object, key, after) => {
      const original = object[key];
      if (typeof original === 'function') object[key] = function (...values) {
        const result = original.apply(this, values); after(values); return result;
      };
    };
    const draw = () => {
      const active = probe.active;
      if (!active || active.gl !== gl || framebuffer !== active.layer?.framebuffer) return;
      active.glDraws++;
      const key = viewport.join(','); active.viewportDraws[key] = (active.viewportDraws[key] || 0) + 1;
    };
    wrap(gl, 'viewport', values => { viewport = values; });
    wrap(gl, 'bindFramebuffer', ([target, value]) => { if (target === gl.FRAMEBUFFER || target === gl.DRAW_FRAMEBUFFER) framebuffer = value; });
    for (const key of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) wrap(gl, key, draw);
    const getExtension = gl.getExtension.bind(gl), extensions = new Set();
    gl.getExtension = name => {
      const extension = getExtension(name);
      if (extension && !extensions.has(extension)) {
        extensions.add(extension);
        for (const key of new Set([...Object.keys(extension), ...Object.getOwnPropertyNames(Object.getPrototypeOf(extension))])) {
          if (/^(?:multiDraw|draw)(?:Arrays|Elements)/.test(key)) wrap(extension, key, draw);
          if (key !== 'constructor' && typeof extension[key] === 'function') wrap(extension, key, () => trace(`${name}.${key}`));
        }
      }
      return extension;
    };
    const methods = new Set();
    for (let prototype = gl; prototype && prototype !== Object.prototype; prototype = Object.getPrototypeOf(prototype)) {
      Object.getOwnPropertyNames(prototype).forEach(key => methods.add(key));
    }
    for (const key of methods) if (!['constructor', 'getError'].includes(key) && typeof gl[key] === 'function') wrap(gl, key, () => trace(key));
    return gl;
  };
}

async function launchViewer(provided = null) {
  const probe = window.__xrProbe, device = probe.device;
  const state = { status: 'loading', loop: 'stock-plugin-desktop', sessions: [], draws: 0, errors: [] };
  const fail = error => { state.errors.push(String(error?.stack || error)); state.status = 'error'; };
  window.__preview = { snapshot: () => ({ ...state, contextCount: probe.contexts.size }) };
  try {
    const version = provided?.version ?? molstar.version;
    if (version !== '5.11.0') throw Error('Unexpected Mol* version');
    const viewer = provided ? { plugin: provided.plugin, dispose() {} } : await molstar.Viewer.create('viewer', { extensions: [], customFormats: [], layoutIsExpanded: false,
      layoutShowControls: false, layoutShowSequence: false, layoutShowLog: false, layoutShowLeftPanel: false,
      layoutShowRemoteState: false, volumeStreamingDisabled: true, viewportShowControls: false, viewportShowExpand: false,
      viewportShowAnimation: false, viewportShowSettings: false, viewportShowSelectionMode: false,
      viewportShowScreenshotControls: false, viewportShowToggleFullscreen: false, viewportShowTrajectoryControls: false,
      viewportBackgroundColor: '#17242d', pixelScale: 1, pickScale: 1, illumination: false });
    const plugin = viewer.plugin, canvas = plugin.canvas3d, gl = canvas.webgl.gl;
    const depthAdapter = window.__previewAdapters.installPresentationDepthAdapter(plugin);
    const debugRenderer = gl.getExtension('WEBGL_debug_renderer_info');
    const graphics = { version: gl.getParameter(gl.VERSION), shadingLanguageVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
      renderer: gl.getParameter(gl.RENDERER), unmaskedRenderer: debugRenderer ? gl.getParameter(debugRenderer.UNMASKED_RENDERER_WEBGL) : null };
    canvas.setProps({ multiSample: { mode: 'off' }, camera: { helper: { axes: { name: 'off', params: {} } } },
      trackball: { animate: { name: 'off', params: {} } }, xr: { resolutionScale: 1 } });
    let structure, model;
    if (!provided) {
      const source = await fetch('/fixture.cif').then(response => { if (!response.ok) throw Error('Fixture unavailable'); return response.text(); });
      const data = await plugin.builders.data.rawData({ data: source, label: 'Public 1CRN' });
      const trajectory = await plugin.builders.structure.parseTrajectory(data, 'mmcif');
      model = await plugin.builders.structure.createModel(trajectory, { modelIndex: 0 });
      structure = await plugin.builders.structure.createStructure(model, { name: 'assembly', params: { id: '1' } });
      await plugin.builders.structure.representation.addRepresentation(structure, { type: 'cartoon', color: 'secondary-structure' });
    }
    const stats = () => {
      if (provided) {
        const current = provided.snapshot();
        return { atoms: current.atomCount, residues: current.residueCount, modelNumber: current.modelNumber,
          renderObjects: current.renderObjectCount, representations: current.representationCount };
      }
      return { atoms: structure.obj.data.elementCount, residues: structure.obj.data.atomicResidueCount,
        modelNumber: model.obj.data.modelNum, renderObjects: canvas.getRenderObjects().length, representations: canvas.reprCount.value };
    };
    const cameraInfo = () => ({ state: canvas.camera.getSnapshot(), view: Array.from(canvas.camera.view), scale: canvas.camera.scale,
      bounds: { center: Array.from(canvas.boundingSphereVisible.center), radius: canvas.boundingSphereVisible.radius } });
    const glTrace = () => ({ errorCount: probe.glErrorCount, firstErrors: [...probe.glErrors], maxRetainedErrors: 64 });
    canvas.notifyDidDraw = true;
    const subscriptions = [canvas.didDraw.subscribe(() => {
      state.draws++; if (probe.active && canvas.xr.isPresenting.value) probe.active.molstarDraws++;
    }), canvas.input.trackedPointers.subscribe(pointers => {
      if (probe.active) for (const pointer of pointers) {
        const key = `${pointer.handedness}:${pointer.buttons}`;
        probe.active.pointerStates[key] = (probe.active.pointerStates[key] || 0) + 1;
      }
    }), plugin.events.log.subscribe(entry => { if (entry.type === 'error') state.errors.push(entry.message); })];
    const frames = async (count = 4) => {
      for (let i = 0; i < count; i++) await new Promise((resolve, reject) => {
        const active = probe.active;
        if (!active) return reject(Error('No active XR session'));
        active.session.requestAnimationFrame((time, frame) => {
          try {
            const pose = frame.getViewerPose(active.space), layer = active.session.renderState.baseLayer;
            if (!pose || !layer) throw Error('XR frame lacks a viewer pose or base layer');
            active.layer = layer; active.frames++;
            if (!active.referenceSpaceChecked) { probe.referenceAdapter.check(frame, active.space); active.referenceSpaceChecked = true; }
            const Mat4 = provided?.Mat4 ?? molstar.lib.math.LinearAlgebra.Mat4;
            const describeViews = pose => pose.views.map(view => {
              const projection = Array.from(view.projectionMatrix), viewMatrix = Array.from(view.transform.inverse.matrix);
              const v = layer.getViewport(view), projectionView = Array.from(Mat4.mul(Mat4(), projection, viewMatrix));
              return { eye: view.eye, projection, view: viewMatrix, projectionView, viewport: [v.x, v.y, v.width, v.height] };
            });
            const decomposition = Mat4.getDecomposition(canvas.camera.view), p = decomposition.position, q = decomposition.quaternion;
            const cameraSpace = active.space.getOffsetReferenceSpace(new XRRigidTransform(
              { x: p[0], y: p[1], z: p[2] }, { x: q[0], y: q[1], z: q[2], w: q[3] }));
            const scenePose = frame.getViewerPose(cameraSpace);
            if (!scenePose) throw Error('XR frame lacks a camera-offset pose');
            active.lastFrame = { time, framebuffer: [layer.framebufferWidth, layer.framebufferHeight], pose: Array.from(pose.transform.matrix),
              views: describeViews(pose), sceneViews: describeViews(scenePose), camera: cameraInfo() };
            resolve();
          } catch (error) { reject(error); }
        });
      });
    };
    const sessionInfo = active => ({ mode: active.mode, blendMode: active.session.environmentBlendMode, frames: active.frames,
      sceneDepthAdapter: active.sceneDepthAdapter?.state ?? null,
      molstarDraws: active.molstarDraws, glDraws: active.glDraws, viewportDraws: { ...active.viewportDraws },
      lastFrame: active.lastFrame, pointerStates: { ...active.pointerStates }, events: [...active.events], ended: active.ended,
      inputs: Array.from(active.session.inputSources, input => ({ handedness: input.handedness, profiles: [...input.profiles],
        targetRayMode: input.targetRayMode, buttons: Array.from(input.gamepad?.buttons || [], button => ({ pressed: button.pressed, value: button.value })) })) });
    const waitPresentation = expected => new Promise(resolve => {
      if (canvas.xr.isPresenting.value === expected) { resolve(); return; }
      const sub = canvas.xr.isPresenting.subscribe(value => { if (value === expected) { sub.unsubscribe(); resolve(); } });
    });
    const drainGlErrors = () => {
      const errors = [];
      for (let i = 0; i < 16; i++) {
        const code = gl.getError(); if (code === gl.NO_ERROR) return { errors, complete: true };
        const name = ['INVALID_ENUM', 'INVALID_VALUE', 'INVALID_OPERATION', 'INVALID_FRAMEBUFFER_OPERATION', 'OUT_OF_MEMORY', 'CONTEXT_LOST_WEBGL'].find(name => gl[name] === code);
        errors.push({ code, name: name || 'unknown' });
      }
      return { errors, complete: false };
    };
    let startupErrorsDrained = false, disposal;
    const api = window.__preview = {
      snapshot: () => ({ ...state, stats: stats(), contextCount: probe.contexts.size, presenting: canvas.xr.isPresenting.value,
        camera: cameraInfo(), glTrace: glTrace(),
        adapters: { referenceSpace: probe.referenceAdapter.state, presentationDepth: depthAdapter.state },
        stockPluginLoopAnimating: plugin.animationLoop.isAnimating,
        active: probe.active ? sessionInfo(probe.active) : null, version, graphics,
        runtime: { stereoEnabled: device.stereoEnabled, profile: IWER.metaQuest2.name, ipd: device.ipd, fovy: device.fovy,
          initialHeadPosition: probe.initialHeadPosition, headPosition: { x: device.position.x, y: device.position.y, z: device.position.z },
          label: device.canvasContainer.dataset.webxr_runtime, nativeRuntimeOverriddenInIsolatedPage: true }, contextLost: gl.isContextLost() }),
      frames,
      drainStartupGlErrors: () => {
        if (startupErrorsDrained || probe.active) throw Error('Startup GL diagnostics may run once before XR');
        startupErrorsDrained = true; return drainGlErrors();
      },
      enter: async mode => {
        if (!['immersive-ar', 'immersive-vr'].includes(mode) || probe.active) throw Error('Invalid explicit session request');
        state.requestedMode = mode;
        if (!await navigator.xr.isSessionSupported(mode)) throw Error(`${mode} unsupported by runtime`);
        const session = await navigator.xr.requestSession(mode, { requiredFeatures: ['local'] });
        const active = probe.active = { mode, session, gl, frames: 0, molstarDraws: 0, glDraws: 0, viewportDraws: {}, pointerStates: {}, events: [], ended: false };
        session.addEventListener('end', () => { active.ended = true; });
        for (const type of ['selectstart', 'select', 'selectend', 'squeezestart', 'squeeze', 'squeezeend']) {
          session.addEventListener(type, event => active.events.push({ type, hand: event.inputSource.handedness, profiles: [...event.inputSource.profiles] }));
        }
        active.space = await session.requestReferenceSpace('local');
        if (provided) active.sceneDepthAdapter = window.__previewAdapters.installSceneDepthAdapter({
          session, space: active.space, canvas, Mat4: provided.Mat4,
          deliberateClipping: () => (provided.snapshot().inspection?.appearance.clipping ?? 0) > 0,
        });
        probe.tracePhase = 'xr-setup';
        plugin.animationLoop.stop({ noDraw: true });
        state.loop = 'switching-to-synchronous-xr';
        await canvas.webgl.xr.set(session, { resolutionScale: 1 });
        await waitPresentation(true); // Let the stock session-change handler finish before starting one pump.
        probe.tracePhase = 'xr-render';
        canvas.animate();
        state.loop = 'stock-canvas3d-synchronous-xr';
        await frames(6);
        return api.snapshot();
      },
      pixels: () => new Promise((resolve, reject) => {
        let initial = true;
        const sub = canvas.didDraw.subscribe(() => {
          if (initial) { initial = false; return; } sub.unsubscribe();
          try {
            const width = gl.drawingBufferWidth, height = gl.drawingBufferHeight, rgba = new Uint8Array(width * height * 4);
            const png = gl.canvas.toDataURL('image/png'), before = drainGlErrors();
            const layer = probe.active?.layer, webgl2 = typeof gl.readBuffer === 'function';
            const bindings = { framebufferIsPresentation: gl.getParameter(gl.FRAMEBUFFER_BINDING) === layer?.framebuffer,
              readFramebufferIsPresentation: webgl2 ? gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) === layer?.framebuffer : null,
              pixelPackBufferBound: webgl2 ? gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING) !== null : null,
              packAlignment: gl.getParameter(gl.PACK_ALIGNMENT), readBuffer: webgl2 ? gl.getParameter(gl.READ_BUFFER) : null,
              packRowLength: webgl2 ? gl.getParameter(gl.PACK_ROW_LENGTH) : null,
              packSkipRows: webgl2 ? gl.getParameter(gl.PACK_SKIP_ROWS) : null, packSkipPixels: webgl2 ? gl.getParameter(gl.PACK_SKIP_PIXELS) : null };
            gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
            const after = drainGlErrors();
            const colors = new Set();
            for (let i = 0; i < rgba.length && colors.size < 256; i += 4) colors.add(`${rgba[i]},${rgba[i + 1]},${rgba[i + 2]},${rgba[i + 3]}`);
            const eyeHashes = [];
            const eyePixels = probe.active.lastFrame.views.map(({ eye, viewport: [x, y, w, h] }) => {
              const corner = (y * width + x) * 4, background = rgba.slice(corner, corner + 4), unique = new Set();
              const eyeRgba = new Uint8Array(w * h * 4);
              for (let row = 0; row < h; row++) {
                const offset = ((y + row) * width + x) * 4;
                eyeRgba.set(rgba.subarray(offset, offset + w * 4), row * w * 4);
              }
              eyeHashes.push(crypto.subtle.digest('SHA-256', eyeRgba));
              let foregroundPixels = 0, minX = w, minY = h, maxX = -1, maxY = -1;
              for (let iy = 0; iy < h; iy++) for (let ix = 0; ix < w; ix++) {
                const offset = ((y + iy) * width + x + ix) * 4;
                if (unique.size < 256) unique.add(`${rgba[offset]},${rgba[offset + 1]},${rgba[offset + 2]},${rgba[offset + 3]}`);
                if (rgba[offset] !== background[0] || rgba[offset + 1] !== background[1] || rgba[offset + 2] !== background[2] || rgba[offset + 3] !== background[3]) {
                  foregroundPixels++; minX = Math.min(minX, ix); minY = Math.min(minY, iy); maxX = Math.max(maxX, ix); maxY = Math.max(maxY, iy);
                }
              }
              return { eye, colorsObservedUpTo256: unique.size, foregroundPixels, backgroundSample: Array.from(background),
                foregroundBounds: foregroundPixels ? [minX, minY, maxX, maxY] : null };
            });
            Promise.all([crypto.subtle.digest('SHA-256', rgba), ...eyeHashes]).then(([hash, ...hashes]) => resolve({ width, height, png, glErrorsBefore: before, glErrorsAfter: after, bindings,
              glTrace: glTrace(), sceneFrame: probe.active.lastFrame, eyePixels, colorsObservedUpTo256: colors.size,
              eyeHashes: eyePixels.map((value, index) => ({ eye: value.eye,
                sha256: [...new Uint8Array(hashes[index])].map(byte => byte.toString(16).padStart(2, '0')).join('') })),
              sha256: [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('') }), reject);
          } catch (error) { reject(error); }
        });
        canvas.requestDraw();
      }),
      moveHead: async () => {
        const initial = probe.initialHeadPosition; device.position.set(initial.x + 0.12, initial.y + 0.04, initial.z);
        await frames(5); return api.snapshot();
      },
      controllers: async () => {
        const initial = probe.initialHeadPosition;
        for (const [hand, controller] of Object.entries(device.controllers)) {
          controller.connected = true; controller.position.set(initial.x + (hand === 'left' ? -0.2 : 0.2), initial.y - 0.15, initial.z - 0.3);
          controller.quaternion.set(0, 0, 0, 1);
        }
        await frames();
        for (const hand of ['left', 'right']) for (const button of ['trigger', 'squeeze']) {
          device.controllers[hand].updateButtonValue(button, 1); await frames(3);
          device.controllers[hand].updateButtonValue(button, 0); await frames(3);
        }
        return api.snapshot();
      },
      end: async () => {
        const active = probe.active; if (!active) throw Error('No session to end');
        probe.tracePhase = 'xr-end';
        canvas.pause(true); state.loop = 'switching-to-stock-desktop';
        if (canvas.webgl.xr.session === active.session) await canvas.xr.end();
        else if (!active.ended) await active.session.end();
        await waitPresentation(false);
        active.sceneDepthAdapter?.restore();
        probe.tracePhase = null;
        state.sessions.push(sessionInfo(active)); probe.active = null;
        plugin.animationLoop.start(); state.loop = 'stock-plugin-desktop';
        canvas.requestResize(); canvas.requestDraw(); return api.snapshot();
      },
      dispose: async () => {
        if (disposal) return disposal;
        if (probe.active) await api.end();
        subscriptions.forEach(subscription => subscription.unsubscribe());
        const depthRestored = depthAdapter.restore(), referenceRestored = probe.referenceAdapter.restore();
        const adaptersRestored = depthRestored && referenceRestored
          && state.sessions.every(session => !session.sceneDepthAdapter || session.sceneDepthAdapter.restored);
        viewer.dispose(); device.uninstallRuntime();
        state.status = 'disposed';
        return disposal = { attachmentDetached: true, ownsViewer: !provided, adaptersRestored, glTrace: glTrace(), viewerDisposed: plugin.disposed === true, activeSession: Boolean(canvas.webgl.xr.session), runtimeRemoved: !(navigator.xr instanceof IWER.XRSystem) };
      },
    };
    for (const button of document.querySelectorAll('[data-mode]')) button.onclick = () => api.enter(button.dataset.mode).catch(fail);
    if (!provided) canvas.requestCameraReset({ durationMs: 0 });
    canvas.requestDraw(); state.status = 'ready';
    return api;
  } catch (error) { fail(error); if (provided) throw error; }
}


module.exports = { installProbe, launchViewer };
