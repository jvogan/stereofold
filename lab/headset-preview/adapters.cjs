'use strict';

// Serialized into the isolated preview page. These adapters leave the pinned
// library files unchanged and are restored when that page is disposed.
function installReferenceSpaceAdapter(runtime) {
  const prototype = runtime.XRReferenceSpace.prototype;
  const original = prototype.getOffsetReferenceSpace;
  const state = { name: 'iwer-rigid-transform-argument', calls: 0, checks: [] };
  prototype.getOffsetReferenceSpace = function (transform) {
    if (!(this instanceof runtime.XRReferenceSpace) || !(transform instanceof runtime.XRRigidTransform)
      || transform.matrix.length !== 16 || !Array.from(transform.matrix).every(Number.isFinite)) {
      throw new TypeError('Expected a finite XRRigidTransform');
    }
    state.calls++;
    return original.call(this, transform.matrix);
  };
  return {
    state,
    check(frame, base) {
      // Fixed expected matrices are independent of Mol*'s camera calculations.
      const transform = new runtime.XRRigidTransform({ x: 0.25, y: 0.5, z: -0.75 },
        { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 });
      const offset = base.getOffsetReferenceSpace(transform);
      const nested = offset.getOffsetReferenceSpace(transform.inverse);
      const cases = [
        ['translated-and-rotated', offset, base, [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0.25, 0.5, -0.75, 1]],
        ['inverse', base, offset, [0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, 0, -0.75, -0.5, -0.25, 1]],
        ['nested-inverse', nested, base, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]],
      ];
      for (const [name, space, relativeTo, expected] of cases) {
        const pose = frame.getPose(space, relativeTo);
        const observed = pose ? Array.from(pose.transform.matrix) : [];
        const error = observed.length === 16 ? Math.max(...observed.map((value, index) => Math.abs(value - expected[index]))) : Infinity;
        state.checks.push({ name, expected, observed, maxAbsoluteError: error, tolerance: 1e-5 });
        if (!Number.isFinite(error) || error > 1e-5) throw Error(`Reference-space check failed: ${name}`);
      }
    },
    restore() { prototype.getOffsetReferenceSpace = original; return prototype.getOffsetReferenceSpace === original; },
  };
}

function installPresentationDepthAdapter(plugin) {
  const draw = plugin.canvas3dContext?.passes?.draw;
  const texture = draw?.depthTextureOpaque;
  if (!texture || !draw.drawTarget?.framebuffer) throw Error('Pinned Mol* draw-pass contract unavailable');
  const originals = {}, state = { name: 'presentation-depth-attachment', attachSkipped: 0, detachSkipped: 0 };
  for (const [method, counter] of [['attachFramebuffer', 'attachSkipped'], ['detachFramebuffer', 'detachSkipped']]) {
    const original = originals[method] = texture[method];
    if (typeof original !== 'function') throw Error(`Missing texture method: ${method}`);
    texture[method] = function (framebuffer, attachment, ...rest) {
      const webgl = plugin.canvas3d.webgl, session = webgl.xr.session;
      if (session && framebuffer === draw.drawTarget.framebuffer && attachment === 'depth') {
        const layer = session.renderState.baseLayer;
        if (!layer || webgl.gl.getParameter(webgl.gl.FRAMEBUFFER_BINDING) !== layer.framebuffer) {
          throw Error('Presentation depth request used an unexpected framebuffer');
        }
        // The presentation target already has the depth written by the molecule.
        // Keep pointer drawing; its framebuffer attachments cannot be replaced.
        state[counter]++;
        return;
      }
      return original.call(this, framebuffer, attachment, ...rest);
    };
  }
  return { state, restore() {
    for (const [method, original] of Object.entries(originals)) texture[method] = original;
    return Object.entries(originals).every(([method, original]) => texture[method] === original);
  } };
}

// The receiver preserves the desktop camera snapshot across representation
// changes. Its radiusMax can therefore be smaller than the current render
// sphere. Expand only this session's far plane, using the real per-eye pose;
// the saved camera, object placement and headset frame validation are untouched.
function installSceneDepthAdapter({ session, space, canvas, Mat4, deliberateClipping = () => false }) {
  const requestFrame = session.requestAnimationFrame;
  const updateState = session.updateRenderState;
  const state = { name: 'xr-visible-scene-depth', expansions: 0, last: null, restored: false };
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
    // A user-requested cutaway is allowed to clip the scene. The transport
    // receiver still gets the complete-scene guard by default.
    if (deliberateClipping()) return updateState.call(this, options);
    const camera = canvas.camera, sphere = canvas.boundingSphereVisible;
    const { position: p, quaternion: q } = Mat4.getDecomposition(camera.view);
    const offset = space.getOffsetReferenceSpace(new XRRigidTransform(
      { x: p[0], y: p[1], z: p[2] }, { x: q[0], y: q[1], z: q[2], w: q[3] }));
    const pose = currentFrame.getViewerPose(offset);
    if (!pose) throw Error('No eye pose for XR depth check');
    const center = Array.from(sphere.center, value => value * camera.scale);
    const radius = sphere.radius * camera.scale;
    const farByEye = pose.views.map(view => {
      const m = view.transform.inverse.matrix;
      return -(m[2] * center[0] + m[6] * center[1] + m[10] * center[2] + m[14]) + radius;
    });
    if (!Number.isFinite(radius) || radius <= 0 || farByEye.length !== 2 || !farByEye.every(Number.isFinite)) {
      throw Error('Invalid render sphere or eye depth');
    }
    // A 1 mm presentation margin avoids a tangent far plane. The verifier still
    // retains and checks its original 10 micrometre numerical tolerance.
    const depthFar = Math.max(options.depthFar, ...farByEye.map(value => value + 0.001));
    if (depthFar > options.depthFar) state.expansions++;
    state.last = { requestedFar: options.depthFar, appliedFar: depthFar, farByEye, marginMetres: 0.001 };
    return updateState.call(this, { ...options, depthFar });
  };
  return { state, restore() {
    session.requestAnimationFrame = requestFrame;
    session.updateRenderState = updateState;
    currentFrame = null;
    state.restored = session.requestAnimationFrame === requestFrame && session.updateRenderState === updateState;
    return state.restored;
  } };
}

module.exports = { installReferenceSpaceAdapter, installPresentationDepthAdapter, installSceneDepthAdapter };
