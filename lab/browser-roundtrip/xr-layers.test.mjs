import assert from 'node:assert/strict';
import test from 'node:test';
import { getXrLayerStack, installXrLayers, LAYER_APPLY_FRAMES, MOLECULE_FAULT_FRAMES, STOCK_LAYER_FRAMES, withXrLayersFeature, xrLayersRequested,
  XR_LAYERS_DIAGNOSTIC, XR_LAYERS_ENDED_MESSAGE, XR_PROBLEM_EVENT } from './xr-layers.mjs';
import { applyFoveation, describeXrLayer, disableXrLayerMsaa, HEADSET_OPTIONAL_FEATURES, keepsXrLayerMsaa, trackFoveation } from './xr-session-request.mjs';

const EYE_WIDTH = 800, EYE_HEIGHT = 600;

function fakeGl({ gl2 = true } = {}) {
  const calls = [];
  let nextId = 1;
  const bound = { draw: null, read: null, renderbuffer: null };
  const flags = { lost: false };
  const canvas = new EventTarget();
  const gl = {
    canvas, calls, bound, flags,
    FRAMEBUFFER: 0x8D40, FRAMEBUFFER_BINDING: 0x8CA6, RENDERBUFFER: 0x8D41, RENDERBUFFER_BINDING: 0x8CA7,
    COLOR_ATTACHMENT0: 0x8CE0, DEPTH_ATTACHMENT: 0x8D00, TEXTURE_2D: 0x0DE1, DEPTH_COMPONENT16: 0x81A5,
    isContextLost: () => flags.lost,
    createFramebuffer() { const fb = { kind: 'framebuffer', id: nextId++, color: null, depth: null }; calls.push(['createFramebuffer', fb.id]); return fb; },
    deleteFramebuffer(fb) { calls.push(['deleteFramebuffer', fb.id]); },
    createRenderbuffer() { const rb = { kind: 'renderbuffer', id: nextId++, storage: null }; calls.push(['createRenderbuffer', rb.id]); return rb; },
    deleteRenderbuffer(rb) { calls.push(['deleteRenderbuffer', rb.id]); },
    bindFramebuffer(target, fb) {
      if (target === gl.FRAMEBUFFER) bound.draw = bound.read = fb;
      else if (target === gl.DRAW_FRAMEBUFFER) bound.draw = fb;
      else bound.read = fb;
      calls.push(['bindFramebuffer', target, fb?.id ?? null]);
    },
    getParameter(name) {
      if (name === gl.FRAMEBUFFER_BINDING) return bound.draw;
      if (name === gl.READ_FRAMEBUFFER_BINDING) return bound.read;
      if (name === gl.RENDERBUFFER_BINDING) return bound.renderbuffer;
      return null;
    },
    bindRenderbuffer(_target, rb) { bound.renderbuffer = rb; },
    renderbufferStorage(_target, format, width, height) { bound.renderbuffer.storage = { format, width, height }; },
    framebufferTexture2D(target, attachment, _textarget, texture) {
      assert.equal(attachment, gl.COLOR_ATTACHMENT0);
      const fb = target === gl.READ_FRAMEBUFFER ? bound.read : bound.draw;
      fb.color = texture;
      calls.push(['attachColor', fb.id, texture.id]);
    },
    framebufferRenderbuffer(target, attachment, _rbTarget, rb) {
      assert.equal(attachment, gl.DEPTH_ATTACHMENT);
      const fb = target === gl.READ_FRAMEBUFFER ? bound.read : bound.draw;
      fb.depth = rb;
      calls.push(['attachDepth', fb.id, rb.id]);
    },
    drawArrays(viewport) { calls.push(['draw', bound.draw?.id ?? null, bound.draw?.color?.id ?? null, viewport]); },
  };
  if (gl2) Object.assign(gl, {
    DRAW_FRAMEBUFFER: 0x8CA9, READ_FRAMEBUFFER: 0x8CA8, DRAW_FRAMEBUFFER_BINDING: 0x8CA6, READ_FRAMEBUFFER_BINDING: 0x8CAA,
    DEPTH_COMPONENT24: 0x81A6,
    invalidateFramebuffer(target, attachments) { calls.push(['invalidate', bound.draw.id, [...attachments]]); assert.equal(target, gl.DRAW_FRAMEBUFFER); },
  });
  return gl;
}

class FakeFrame {
  constructor(session, number) { this.session = session; this.number = number; this.active = true; this.texture = { kind: 'texture', id: 1000 + number }; }
  getViewerPose(space) {
    if (!space) throw new TypeError('space required');
    return { space, views: ['left', 'right'].map(eye => ({ eye, frame: this })) };
  }
}

class FakeSession extends EventTarget {
  constructor({ features = ['viewer', 'local', 'layers'], maxRenderLayers = 4, reuseFrame = false } = {}) {
    super();
    this.reuseFrame = reuseFrame; this.reused = null;
    this.enabledFeatures = features;
    this.maxRenderLayers = maxRenderLayers;
    this.state = { baseLayer: null, layers: [], depthNear: 0.1, depthFar: 1000 };
    this.pending = null; this.callbacks = []; this.updates = []; this.frameNumber = 0;
  }
  get renderState() { return this.state; }
  updateRenderState(init) {
    if (init.baseLayer && init.layers) throw new DOMException('both', 'NotSupportedError');
    if (init.layers && !this.enabledFeatures.includes('layers') && init.layers.length > 1) throw new DOMException('layers', 'NotSupportedError');
    this.updates.push(init);
    // A browser that takes a base layer after layers without complaint, and never shows it.
    if (init.baseLayer && this.dropBaseLayer) return;
    // A browser that takes a layers request without complaint, and never lists the layers.
    if (init.layers && this.dropLayers) return;
    this.pending = { ...(this.pending ?? this.state), ...init,
      ...(init.layers ? { baseLayer: null } : {}), ...(init.baseLayer ? { layers: [] } : {}) };
  }
  requestAnimationFrame(callback) { this.callbacks.push(callback); return this.callbacks.length; }
  tick() {
    if (this.pending) { this.state = this.pending; this.pending = null; }
    let frame;
    if (this.reuseFrame) {
      // Quest Browser hands every animation frame the same XRFrame object.
      frame = this.reused ??= new FakeFrame(this, 0);
      frame.number = ++this.frameNumber; frame.active = true;
      frame.texture = { kind: 'texture', id: 1000 + frame.number };
    } else frame = new FakeFrame(this, ++this.frameNumber);
    const callbacks = this.callbacks;
    this.callbacks = [];
    for (const callback of callbacks) callback(this.frameNumber * 11, frame);
    frame.active = false;
    return frame;
  }
  end() { this.ended = (this.ended ?? 0) + 1; this.dispatchEvent(new Event('end')); }
}

function fakeBindingClass(log, { layout = 'stereo-left-right', foveation = true, createError = null, splitTextures = false,
  sourceAlpha = true } = {}) {
  return class FakeXRWebGLBinding {
    constructor(session, gl) { this.session = session; this.gl = gl; log.bindings.push(this); }
    createProjectionLayer(init) {
      if (createError) throw createError;
      log.inits.push(init);
      const layer = { kind: 'projection', layout, textureWidth: Math.round(2 * EYE_WIDTH * init.scaleFactor),
        textureHeight: Math.round(EYE_HEIGHT * init.scaleFactor), ignoreDepthValues: init.depthFormat === 0,
        destroyed: false, destroy() { this.destroyed = true; } };
      if (foveation) layer.fixedFoveation = 0;
      if (!sourceAlpha) Object.defineProperty(layer, 'blendTextureSourceAlpha', { get: () => false, set() {} });
      log.layers.push(layer);
      return layer;
    }
    getViewSubImage(layer, view) {
      if (log.failViews) throw new DOMException('no sub-image', 'InvalidStateError');
      if (log.splitNow && view.eye === 'right') return { colorTexture: { kind: 'texture', id: -view.frame.texture.id }, depthStencilTexture: null,
        colorTextureWidth: layer.textureWidth, colorTextureHeight: layer.textureHeight,
        viewport: { x: layer.textureWidth / 2, y: 0, width: layer.textureWidth / 2, height: layer.textureHeight } };
      if (!this.session.state.layers?.includes(layer)) throw new TypeError('layer is not in the session layers');
      if (!view.frame.active) throw new DOMException('inactive frame', 'InvalidStateError');
      const width = layer.textureWidth / 2;
      const colorTexture = splitTextures && view.eye === 'right' ? { kind: 'texture', id: -view.frame.texture.id } : view.frame.texture;
      return { colorTexture, depthStencilTexture: null, colorTextureWidth: layer.textureWidth, colorTextureHeight: layer.textureHeight,
        viewport: { x: view.eye === 'left' ? 0 : width, y: 0, width, height: layer.textureHeight } };
    }
  };
}

class StockLayer {
  constructor(session, gl, options) { this.session = session; this.options = options; this.framebuffer = { id: 'stock' }; this.framebufferWidth = 1600; this.framebufferHeight = 600; }
  getViewport(view) { return { x: view.eye === 'left' ? 0 : 800, y: 0, width: 800, height: 600 }; }
  static getNativeFramebufferScaleFactor() { return 1.5; }
}

/** The four steps Mol* 5.11 takes: build the layer, set it, then per frame read, size, viewport, bind and draw. */
function fakeMolstar({ scope, session, gl, space, scale = 1 }) {
  const mol = { layer: undefined, draws: 0, viewports: null, paused: false };
  mol.attach = async () => {
    mol.layer = new scope.XRWebGLLayer(session, gl, { antialias: true, alpha: true, depth: true, framebufferScaleFactor: scale });
    await session.updateRenderState({ baseLayer: mol.layer });
  };
  mol.start = () => session.requestAnimationFrame(function animate(_time, frame) {
    const { baseLayer } = mol.paused ? {} : session.renderState;
    if (baseLayer) {
      session.updateRenderState({ depthNear: 0.1, depthFar: 100 });
      const pose = frame.getViewerPose(space);
      mol.viewports = pose.views.map(view => baseLayer.getViewport(view));
      mol.size = [baseLayer.framebufferWidth, baseLayer.framebufferHeight];
      gl.bindFramebuffer(gl.FRAMEBUFFER, baseLayer.framebuffer);
      for (const viewport of mol.viewports) gl.drawArrays(viewport);
      mol.draws++;
    }
    session.requestAnimationFrame(animate);
  });
  return mol;
}

function setup({ search = '?xrLayers=1', binding = {}, session: sessionOptions = {}, gl2 = true, scope: extra = {}, drawCount = true } = {}) {
  const diagnostics = [];
  const log = { bindings: [], inits: [], layers: [] };
  const scope = { XRWebGLLayer: StockLayer, XRWebGLBinding: fakeBindingClass(log, binding), location: { search },
    __stereofoldDiagnostics: { record: (kind, detail) => diagnostics.push({ kind, ...detail }) }, ...extra };
  const session = new FakeSession(sessionOptions);
  const gl = fakeGl({ gl2 });
  const space = { kind: 'local' };
  const mol = fakeMolstar({ scope, session, gl, space, scale: 0.75 });
  const installed = installXrLayers({ session, space, scope, drawCount: drawCount ? () => mol.draws : undefined });
  return { scope, session, gl, space, mol, installed, diagnostics, log };
}

const records = (diagnostics, phase) => diagnostics.filter(row => row.kind === XR_LAYERS_DIAGNOSTIC && (phase === undefined || row.phase === phase));

test('the switch is on only for xrLayers=1, and adds the layers feature only then', () => {
  assert.equal(xrLayersRequested({ location: { search: '?xrLayers=1' } }), true);
  assert.equal(xrLayersRequested({ location: { search: '?xrRenderBudget=scale:0.5&xrLayers=1' } }), true);
  for (const search of ['', '?xrLayers=0', '?xrLayers=true', '?xrLayers', '?XRLAYERS=1']) {
    assert.equal(xrLayersRequested({ location: { search } }), false, search);
  }
  assert.equal(xrLayersRequested({}), false);
  assert.equal(xrLayersRequested({ get location() { throw new Error('detached'); } }), false);
  assert.deepEqual(withXrLayersFeature(HEADSET_OPTIONAL_FEATURES, { location: { search: '' } }), [...HEADSET_OPTIONAL_FEATURES]);
  assert.deepEqual(withXrLayersFeature(HEADSET_OPTIONAL_FEATURES, { location: { search: '?xrLayers=1' } }), [...HEADSET_OPTIONAL_FEATURES, 'layers']);
  assert.deepEqual(withXrLayersFeature(['layers'], { location: { search: '?xrLayers=1' } }), ['layers']);
});

for (const [name, options, reason] of [
  ['no XRWebGLBinding', { scope: { XRWebGLBinding: undefined } }, 'no-binding'],
  ['a session granted without layers', { session: { features: ['local'] } }, 'layers-not-granted'],
]) {
  test(`${name} leaves the stock path untouched and says why`, async () => {
    const { scope, session, gl, mol, installed, diagnostics } = setup(options);
    assert.equal(installed.installed, false);
    assert.equal(installed.reason, reason);
    assert.equal(scope.XRWebGLLayer, StockLayer);
    await mol.attach();
    assert.ok(mol.layer instanceof StockLayer);
    assert.deepEqual(session.updates, [{ baseLayer: mol.layer }]);
    assert.equal(Object.getOwnPropertyDescriptor(session, 'renderState'), undefined);
    assert.equal(getXrLayerStack(session), null);
    assert.deepEqual(records(diagnostics), [{ kind: XR_LAYERS_DIAGNOSTIC, path: 'stock', reason }]);
    assert.equal(gl.calls.length, 0);
    installed.restore();
  });
}

for (const [name, binding, reason] of [
  ['a projection layer the browser refuses', { createError: new DOMException('refused', 'NotSupportedError') }, 'projection-layer-failed'],
  ['a layer split into one texture per view', { layout: 'default' }, 'unsupported-layout'],
  ['a texture-array layer', { layout: 'stereo' }, 'unsupported-layout'],
]) {
  test(`${name} hands Mol* the stock layer and leaves the session unwrapped`, async () => {
    const { session, mol, installed, diagnostics, log } = setup({ binding });
    assert.equal(installed.installed, true);
    await mol.attach();
    assert.ok(mol.layer instanceof StockLayer);
    assert.equal(mol.layer.options.antialias, true, 'the stock options pass through unchanged');
    assert.deepEqual(session.updates, [{ baseLayer: mol.layer }]);
    for (const key of ['renderState', 'updateRenderState', 'requestAnimationFrame']) {
      assert.equal(Object.getOwnPropertyDescriptor(session, key), undefined, key);
    }
    assert.equal(getXrLayerStack(session), null);
    const [row] = records(diagnostics);
    assert.equal(row.path, 'stock');
    assert.equal(row.reason, reason);
    assert.match(row.error, /\w/);
    assert.ok(log.layers.every(layer => layer.destroyed), 'a refused layer is destroyed');
    installed.restore();
  });
}

test('Mol* draws both eyes into the projection layer texture of each frame, with no base layer', async () => {
  const { session, gl, mol, installed, diagnostics, log } = setup();
  await mol.attach();
  const [projection] = log.layers;
  assert.deepEqual(log.inits, [{ textureType: 'texture', colorFormat: 0x1908, depthFormat: 0, scaleFactor: 0.75 }]);
  assert.deepEqual(session.updates, [{ layers: [projection] }], 'the base layer request became a layers request');
  assert.equal(session.renderState.baseLayer, null, 'like a stock layer, nothing presents before the state applies');
  const stack = getXrLayerStack(session);
  assert.equal(stack.projectionLayer, projection);
  assert.equal(stack.session, session);
  assert.equal(stack.gl, gl);
  assert.equal(stack.binding, log.bindings[0]);
  mol.start();

  const frames = [session.tick(), session.tick(), session.tick()];
  assert.equal(mol.draws, 3);
  assert.equal(session.renderState.baseLayer, mol.layer);
  assert.equal(session.renderState.layers[0], projection);
  assert.equal(session.renderState.depthFar, 100, 'other render state reads through');
  assert.deepEqual(mol.size, [1200, 450]);
  assert.deepEqual(mol.viewports, [{ x: 0, y: 0, width: 600, height: 450 }, { x: 600, y: 0, width: 600, height: 450 }]);
  const draws = gl.calls.filter(call => call[0] === 'draw');
  assert.deepEqual(draws.map(call => call[2]), frames.flatMap(frame => [frame.texture.id, frame.texture.id]),
    'each eye lands in the colour texture of its own frame');
  const framebufferId = draws[0][1];
  assert.ok(draws.every(call => call[1] === framebufferId), 'one framebuffer serves every frame');
  assert.deepEqual(gl.calls.filter(call => call[0] === 'attachColor').map(call => call[2]), frames.map(frame => frame.texture.id),
    'one attachment per frame, before the draw');
  const [depth] = gl.calls.filter(call => call[0] === 'createRenderbuffer');
  assert.equal(gl.calls.filter(call => call[0] === 'createRenderbuffer').length, 1);
  assert.equal(gl.calls.filter(call => call[0] === 'attachDepth').length, 3, 'depth is attached with the colour, once per frame');
  assert.deepEqual(gl.bound.renderbuffer, null, 'the renderbuffer binding is put back');
  const framebuffer = gl.bound.draw;
  assert.equal(framebuffer.depth.id, depth[1]);
  assert.deepEqual(framebuffer.depth.storage, { format: gl.DEPTH_COMPONENT24, width: 1200, height: 450 });
  // The depth discard follows each frame's draws.
  const order = gl.calls.filter(call => call[0] === 'draw' || call[0] === 'invalidate').map(call => call[0]);
  assert.deepEqual(order, ['draw', 'draw', 'invalidate', 'draw', 'draw', 'invalidate', 'draw', 'draw', 'invalidate']);
  assert.ok(gl.calls.filter(call => call[0] === 'invalidate').every(call => call[1] === framebufferId
    && call[2].length === 1 && call[2][0] === gl.DEPTH_ATTACHMENT));
  assert.equal(mol.layer.antialias, false);
  assert.equal(mol.layer.ignoreDepthValues, true);
  assert.deepEqual(records(diagnostics).map(row => row.phase), ['created', 'first-frame']);
  assert.equal(records(diagnostics, 'created')[0].depth, 'private');
  installed.restore();
});

test('the molecule layer composites with its texture alpha, and the read-back is recorded', async () => {
  const { mol, installed, diagnostics, log } = setup();
  await mol.attach();
  assert.equal(log.layers[0].blendTextureSourceAlpha, true);
  assert.equal(records(diagnostics, 'created')[0].sourceAlpha, true);
  installed.restore();
});

test('a molecule layer that ignores source alpha still presents, and says so', async () => {
  const { session, mol, installed, diagnostics, log } = setup({ binding: { sourceAlpha: false } });
  await mol.attach();
  mol.start();
  session.tick();
  assert.equal(mol.draws, 1);
  assert.equal(session.renderState.layers[0], log.layers[0]);
  assert.equal(records(diagnostics, 'created')[0].sourceAlpha, false);
  installed.restore();
});

test('attaching for a frame puts back the framebuffer the caller had bound', async () => {
  const { session, gl, mol, installed } = setup();
  await mol.attach();
  session.tick();
  const callerFramebuffer = gl.createFramebuffer();
  session.requestAnimationFrame((_time, frame) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, callerFramebuffer);
    session.renderState.baseLayer.getViewport(frame.getViewerPose({}).views[0]);
    assert.equal(gl.bound.draw, callerFramebuffer);
    assert.equal(gl.bound.read, callerFramebuffer);
  });
  session.tick();
  installed.restore();
});

test('a framebuffer bound before any viewport is asked for still targets this frame', async () => {
  const { session, gl, mol, installed } = setup();
  await mol.attach();
  session.tick();
  let frameTexture;
  session.requestAnimationFrame((_time, frame) => {
    frameTexture = frame.texture;
    gl.bindFramebuffer(gl.FRAMEBUFFER, session.renderState.baseLayer.framebuffer);
    gl.drawArrays('early');
  });
  session.tick();
  assert.deepEqual(gl.calls.filter(call => call[0] === 'draw').at(-1).slice(2), [frameTexture.id, 'early']);
  installed.restore();
});

test('a depth attachment taken off the layer during one frame is back for the next', async () => {
  const { session, gl, mol, installed } = setup();
  await mol.attach();
  mol.start();
  session.tick();
  const framebuffer = gl.bound.draw;
  const depth = framebuffer.depth;
  assert.ok(depth);
  // What Mol*'s pointer pass does to the bound drawing buffer when nothing
  // refuses it: its own depth texture in, then nothing.
  session.requestAnimationFrame(() => { framebuffer.depth = null; });
  session.tick();
  assert.equal(framebuffer.depth, null);
  session.tick();
  assert.equal(framebuffer.depth, depth, 'the same renderbuffer, attached again');
  assert.equal(gl.calls.filter(call => call[0] === 'createRenderbuffer').length, 1, 'not reallocated');
  installed.restore();
});

test('fixed foveation is written to and read back from the projection layer', async () => {
  const { session, mol, installed, log, diagnostics } = setup();
  await mol.attach();
  const timers = [];
  const scope = { setInterval: fn => { timers.push(fn); return timers.length; }, clearInterval() {} };
  const tracker = trackFoveation(session, { level: 1, scope });
  assert.equal(tracker.state().reason, 'no-layer', 'the tracker waits for the layer to present');
  session.tick();
  timers[0]();
  assert.deepEqual(tracker.state(), { applied: true, requested: 1, level: 1, reason: 'set' });
  assert.equal(log.layers[0].fixedFoveation, 1);
  assert.deepEqual(describeXrLayer(session), { present: true, antialias: false, fixedFoveation: 1 });
  assert.equal(applyFoveation(session, undefined, 0.5).level, 0.5);
  assert.equal(log.layers[0].fixedFoveation, 0.5);
  tracker.stop();
  assert.ok(diagnostics.length);
  installed.restore();
});

test('a projection layer without foveation is reported unsupported, not applied', async () => {
  const { session, mol, installed } = setup({ binding: { foveation: false } });
  await mol.attach();
  session.tick();
  assert.equal(applyFoveation(session, undefined, 1).reason, 'unsupported');
  assert.equal(describeXrLayer(session).fixedFoveation, null);
  installed.restore();
});

test('after-frame callbacks run once per frame, after both eyes, with the viewer pose, and can unsubscribe', async () => {
  const { session, gl, space, mol, installed, diagnostics } = setup();
  await mol.attach();
  const stack = getXrLayerStack(session);
  const seen = [];
  const unsubscribe = stack.onAfterMolecularFrame((frame, pose) => {
    const calls = gl.calls.filter(call => call[0] === 'draw' || call[0] === 'invalidate');
    seen.push({ frame: frame.number, space: pose.space, last: calls.slice(-3).map(call => call[0]) });
  });
  stack.onAfterMolecularFrame(() => { throw new Error('overlay failed'); });
  // A callback that never touches the molecule's layer is not the molecular frame.
  session.requestAnimationFrame(function idle() { session.requestAnimationFrame(idle); });
  session.tick(); // State applies; Mol* has not started its loop yet.
  mol.start();
  session.tick(); session.tick();
  assert.deepEqual(seen, [
    { frame: 2, space, last: ['draw', 'draw', 'invalidate'] },
    { frame: 3, space, last: ['draw', 'draw', 'invalidate'] },
  ]);
  unsubscribe();
  session.tick();
  assert.equal(seen.length, 2);
  assert.equal(records(diagnostics, 'error').filter(row => row.where === 'after-frame').length, 1, 'a failing callback is reported once');
  assert.equal(mol.draws, 3, 'a failing callback does not stop the molecule');
  installed.restore();
});

test('after-frame callbacks run on every frame when the browser reuses one frame object', async () => {
  const { session, mol, installed } = setup({ session: { reuseFrame: true } });
  await mol.attach();
  const stack = getXrLayerStack(session);
  const seen = [];
  stack.onAfterMolecularFrame(frame => { seen.push(frame.number); });
  // A second callback in each frame must not make the frame count twice.
  session.requestAnimationFrame(function idle() { session.requestAnimationFrame(idle); });
  session.tick();
  mol.start();
  session.tick(); session.tick(); session.tick();
  assert.deepEqual(seen, [2, 3, 4]);
  assert.equal(mol.draws, 3);
  installed.restore();
});

test('a frame in which Mol* does not draw runs no after-frame callback', async () => {
  const { session, mol, installed } = setup();
  await mol.attach();
  mol.start();
  const stack = getXrLayerStack(session);
  let calls = 0;
  stack.onAfterMolecularFrame(() => { calls++; });
  session.tick();
  // Reading a viewport without drawing (as label placement does) is not a draw.
  session.requestAnimationFrame((_time, frame) => { session.renderState.baseLayer.getViewport(frame.getViewerPose({}).views[0]); });
  const before = mol.draws;
  mol.paused = true;
  session.tick();
  assert.equal(mol.draws, before);
  assert.equal(calls, 1);
  installed.restore();
});

test('overlays are composited above the molecule in order, and bad lists are refused', async () => {
  const { session, mol, installed, log } = setup({ session: { maxRenderLayers: 3 } });
  await mol.attach();
  const stack = getXrLayerStack(session);
  const [projection] = log.layers;
  const ui = { kind: 'projection-ui' }, quad = { kind: 'quad' };
  assert.equal(stack.setOverlayLayers([ui, quad]), true);
  assert.deepEqual(session.updates.at(-1), { layers: [projection, ui, quad] });
  assert.deepEqual(stack.overlayLayers(), [ui, quad]);
  assert.throws(() => stack.setOverlayLayers([projection]), TypeError);
  assert.throws(() => stack.setOverlayLayers([ui, ui]), TypeError);
  assert.throws(() => stack.setOverlayLayers([ui, quad, { kind: 'third' }]), RangeError);
  stack.setOverlayLayers([]);
  assert.deepEqual(session.updates.at(-1), { layers: [projection] });
  session.tick();
  assert.equal(session.renderState.baseLayer, mol.layer, 'the molecule stays the presented layer');
  installed.restore();
});

test('overlays set before Mol* asks for its layer go out with that first request', async () => {
  const { scope, session, gl, installed, log } = setup();
  const layer = new scope.XRWebGLLayer(session, gl, { framebufferScaleFactor: 1 });
  const ui = { kind: 'ui' };
  getXrLayerStack(session).setOverlayLayers([ui]);
  assert.deepEqual(session.updates, [], 'nothing is presented before Mol* asks');
  await session.updateRenderState({ baseLayer: layer });
  assert.deepEqual(session.updates, [{ layers: [log.layers[0], ui] }]);
  installed.restore();
});

test('session end removes every wrapper, property and GL object, and re-entry starts clean', async () => {
  const { scope, session, gl, space, mol, installed, diagnostics, log } = setup();
  await mol.attach();
  mol.start();
  session.tick(); session.tick();
  const facade = mol.layer;
  const framebuffer = gl.bound.draw;
  session.end();
  for (const key of ['renderState', 'updateRenderState', 'requestAnimationFrame']) {
    assert.equal(Object.getOwnPropertyDescriptor(session, key), undefined, key);
  }
  assert.equal(scope.XRWebGLLayer, StockLayer);
  assert.equal(getXrLayerStack(session), null);
  assert.equal(log.layers[0].destroyed, true);
  assert.deepEqual(gl.calls.filter(call => call[0].startsWith('delete')).map(call => call[0]), ['deleteFramebuffer', 'deleteRenderbuffer']);
  assert.equal(gl.calls.find(call => call[0] === 'deleteFramebuffer')[1], framebuffer.id);
  assert.equal(facade.framebuffer, null, 'a facade Mol* still holds binds nothing');
  const ended = records(diagnostics, 'ended')[0];
  assert.equal(ended.molecularFrames, 2);
  assert.equal(ended.live, true);
  installed.restore(); // Idempotent.
  assert.equal(gl.calls.filter(call => call[0].startsWith('delete')).length, 2);

  const next = new FakeSession();
  const again = installXrLayers({ session: next, space, scope });
  const mol2 = fakeMolstar({ scope, session: next, gl, space });
  await mol2.attach();
  mol2.start();
  next.tick(); next.tick();
  assert.notEqual(mol2.layer, facade);
  assert.notEqual(getXrLayerStack(next), null);
  assert.notEqual(gl.bound.draw, framebuffer, 'the new session draws into a new framebuffer');
  assert.equal(gl.calls.filter(call => call[0] === 'draw').at(-1)[2], next.frameNumber + 1000);
  again.restore();
  assert.equal(getXrLayerStack(next), null);
  assert.equal(scope.XRWebGLLayer, StockLayer);
});

test('the page restore before Mol* ever builds its layer leaves nothing behind', () => {
  const { scope, session, installed, gl } = setup();
  installed.restore();
  assert.equal(scope.XRWebGLLayer, StockLayer);
  assert.equal(Object.getOwnPropertyDescriptor(session, 'renderState'), undefined);
  assert.equal(gl.calls.length, 0);
});

test('a lost context drops its GL objects without touching them, and a restored one gets new objects', async () => {
  const { session, gl, mol, installed, diagnostics } = setup();
  await mol.attach();
  mol.start();
  session.tick(); session.tick();
  const before = gl.calls.length;
  gl.flags.lost = true;
  gl.canvas.dispatchEvent(new Event('webglcontextlost'));
  assert.equal(records(diagnostics, 'context-lost').length, 1);
  session.tick();
  const glWork = gl.calls.slice(before).filter(call => call[0] !== 'draw' && call[0] !== 'bindFramebuffer');
  assert.deepEqual(glWork, [], 'no attach, allocation or discard on a lost context');
  gl.flags.lost = false;
  gl.canvas.dispatchEvent(new Event('webglcontextrestored'));
  session.tick();
  assert.equal(gl.calls.filter(call => call[0] === 'createFramebuffer').length, 2);
  assert.equal(gl.calls.filter(call => call[0] === 'createRenderbuffer').length, 2);
  installed.restore();
  // Only the objects from the restored context are deleted.
  const created = gl.calls.filter(call => call[0] === 'createFramebuffer').map(call => call[1]);
  assert.deepEqual(gl.calls.filter(call => call[0] === 'deleteFramebuffer').map(call => call[1]), [created[1]]);
});

const QUEST2_AGENT = 'Mozilla/5.0 (X11; Linux x86_64; Quest 2) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/41.0 Chrome/138.0 Mobile VR Safari/537.36';

test('only the measured Quest classes give up the stock layer MSAA', () => {
  assert.equal(keepsXrLayerMsaa({ navigator: { userAgent: QUEST2_AGENT } }, new FakeSession()), false);
  assert.equal(keepsXrLayerMsaa({ navigator: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0 Safari/537.36' } }, new FakeSession()), true);
  assert.equal(keepsXrLayerMsaa({}, new FakeSession()), true, 'an unknown device keeps MSAA');
});

test('a device whose stock layer keeps MSAA keeps the stock layer with the switch on', async () => {
  const diagnostics = [], log = { bindings: [], inits: [], layers: [] };
  const scope = { XRWebGLLayer: StockLayer, XRWebGLBinding: fakeBindingClass(log), location: { search: '?xrLayers=1' },
    __stereofoldDiagnostics: { record: (kind, detail) => diagnostics.push({ kind, ...detail }) } };
  const session = new FakeSession(), gl = fakeGl();
  const installed = installXrLayers({ session, space: {}, scope, keepsMsaa: true });
  assert.equal(installed.installed, false);
  assert.equal(installed.reason, 'device-keeps-msaa');
  assert.equal(scope.XRWebGLLayer, StockLayer, 'nothing is wrapped');
  const mol = fakeMolstar({ scope, session, gl, space: {} });
  await mol.attach();
  assert.ok(mol.layer instanceof StockLayer);
  assert.equal(mol.layer.options.antialias, true, 'the MSAA Mol* asks for passes through');
  assert.deepEqual(session.updates, [{ baseLayer: mol.layer }]);
  assert.equal(log.bindings.length, 0);
  assert.equal(getXrLayerStack(session), null);
  assert.equal(gl.calls.length, 0);
  assert.deepEqual(records(diagnostics).at(-1), { kind: XR_LAYERS_DIAGNOSTIC, path: 'stock', reason: 'device-keeps-msaa' });
  installed.restore();
});

test('the stock MSAA wrapper still serves the fallback, and both restore to the original constructor', async () => {
  const diagnostics = [];
  const scope = { XRWebGLLayer: StockLayer, XRWebGLBinding: undefined, location: { search: '?xrLayers=1' },
    navigator: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64; Quest 2) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/41.0 Chrome/138.0 Mobile VR Safari/537.36' },
    __stereofoldDiagnostics: { record: (kind, detail) => diagnostics.push({ kind, ...detail }) } };
  const session = new FakeSession();
  const restoreMsaa = disableXrLayerMsaa(scope, session);
  assert.notEqual(scope.XRWebGLLayer, StockLayer, 'the Quest 2 wrapper is installed');
  const layers = installXrLayers({ session, space: {}, scope });
  const mol = fakeMolstar({ scope, session, gl: fakeGl(), space: {} });
  await mol.attach();
  assert.equal(mol.layer.options.antialias, false, 'the fallback keeps the stock Quest layer options');
  layers.restore(); restoreMsaa();
  assert.equal(scope.XRWebGLLayer, StockLayer);

  const log = { bindings: [], inits: [], layers: [] };
  scope.XRWebGLBinding = fakeBindingClass(log);
  const second = new FakeSession();
  const restoreSecond = disableXrLayerMsaa(scope, second);
  const wrapped = scope.XRWebGLLayer;
  const layersSecond = installXrLayers({ session: second, space: {}, scope });
  assert.equal(scope.XRWebGLLayer.getNativeFramebufferScaleFactor(), 1.5, 'statics still answer');
  const mol2 = fakeMolstar({ scope, session: second, gl: fakeGl(), space: {} });
  await mol2.attach();
  assert.equal(mol2.layer.projectionLayer, log.layers[0]);
  layersSecond.restore();
  assert.equal(scope.XRWebGLLayer, wrapped);
  restoreSecond();
  assert.equal(scope.XRWebGLLayer, StockLayer);
});

test('wrappers installed before and after compose, and restore leaves later ones in place', async () => {
  const { session, mol, installed } = setup();
  // Installed before: a page wrapper on the instance, as the scene depth adapter does.
  await mol.attach();
  const ours = session.requestAnimationFrame;
  const wrapped = [];
  session.requestAnimationFrame = function (callback) {
    return ours.call(this, (time, frame) => { wrapped.push(frame.number); return callback(time, frame); });
  };
  mol.start();
  session.tick(); session.tick();
  assert.deepEqual(wrapped, [1, 2]);
  assert.equal(mol.draws, 2);
  installed.restore();
  const later = session.requestAnimationFrame;
  assert.equal(Object.getOwnPropertyDescriptor(session, 'requestAnimationFrame').value, later, 'the later wrapper stays');
  session.tick();
  assert.equal(mol.draws, 2, 'the disposed stack presents nothing');
  assert.equal(session.renderState.baseLayer, null);
});

test('the frame governor can wrap and unwrap the facade viewport in place', async () => {
  const { session, mol, installed } = setup();
  await mol.attach();
  session.tick();
  const facade = session.renderState.baseLayer;
  const original = facade.getViewport;
  let wrappedCalls = 0;
  facade.getViewport = function (view) { wrappedCalls++; return original.call(this, view); };
  mol.start();
  session.tick();
  assert.equal(wrappedCalls, 2);
  facade.getViewport = original;
  session.tick();
  assert.equal(wrappedCalls, 2);
  installed.restore();
});

test('two views on two textures are reported and do not move the attachment mid-frame', async () => {
  const { session, gl, mol, installed, diagnostics } = setup({ binding: { splitTextures: true } });
  await mol.attach();
  mol.start();
  const frame = session.tick();
  session.tick();
  assert.equal(records(diagnostics, 'error').filter(row => row.where === 'split-textures').length, 1);
  assert.ok(gl.calls.filter(call => call[0] === 'attachColor').every(call => call[2] > 1000));
  assert.ok(frame);
  installed.restore();
});

/** What the page hears when a session is ended here. */
function pageEvents() {
  const events = [];
  return { events, scope: { dispatchEvent: event => { events.push(event); return true; },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } } } };
}

test('frames in a row without a texture hand the session a stock layer, and the facade answers from it', async () => {
  const page = pageEvents();
  const { session, gl, mol, installed, diagnostics, log, space } = setup({ scope: page.scope });
  await mol.attach(); mol.start();
  session.tick(); session.tick();
  assert.equal(mol.draws, 2);
  const stack = getXrLayerStack(session);
  const retired = [];
  stack.onRetire(reason => retired.push(reason));
  let afterFrames = 0;
  stack.onAfterMolecularFrame(() => { afterFrames++; });
  // The browser stops giving the layer a texture. The molecule has nowhere
  // to draw, and nothing is given up on the first such frames.
  log.failViews = true;
  for (let i = 1; i < MOLECULE_FAULT_FRAMES; i++) session.tick();
  assert.deepEqual(retired, []);
  assert.deepEqual(mol.viewports.map(v => [v.width, v.height]), [[0, 0], [0, 0]]);
  assert.equal(getXrLayerStack(session), stack);
  session.tick();
  assert.deepEqual(retired, ['no-texture'], 'overlays are told once');
  // The session is asked for a stock base layer, built as Mol* asked for its own.
  const handed = session.updates.at(-1);
  assert.deepEqual(Object.keys(handed), ['baseLayer']);
  assert.ok(handed.baseLayer instanceof StockLayer);
  assert.equal(handed.baseLayer.options.framebufferScaleFactor, 0.75);
  assert.deepEqual(records(diagnostics, 'handed-back').map(row => [row.path, row.reason, row.framebufferWidth]), [['stock', 'no-texture', 1600]]);
  // The stack is gone: no overlays, no after-frame work, and the session's own methods are back.
  assert.equal(getXrLayerStack(session), null);
  assert.equal(stack.setOverlayLayers([]), false);
  assert.equal(Object.prototype.hasOwnProperty.call(session, 'updateRenderState'), false);
  assert.equal(Object.getOwnPropertyDescriptor(session, 'renderState'), undefined);
  // Mol* still holds the facade it was given, and it now answers from the stock layer.
  assert.equal(mol.layer.framebuffer, handed.baseLayer.framebuffer);
  assert.deepEqual([mol.layer.framebufferWidth, mol.layer.framebufferHeight], [1600, 600]);
  assert.deepEqual(mol.layer.getViewport({ eye: 'right' }), { x: 800, y: 0, width: 800, height: 600 });
  // The projection layer is kept until the stock layer is what the session shows.
  assert.equal(log.layers[0].destroyed, false);
  const drawsBefore = mol.draws, hooksBefore = afterFrames;
  session.tick(); session.tick();
  assert.equal(session.renderState.baseLayer, handed.baseLayer);
  assert.equal(mol.draws, drawsBefore + 2, 'the molecule is drawn again, into the stock layer');
  assert.deepEqual(gl.calls.filter(call => call[0] === 'draw').at(-1).slice(1, 3), ['stock', null]);
  assert.equal(afterFrames, hooksBefore);
  assert.equal(log.layers[0].destroyed, true);
  assert.equal(records(diagnostics, 'stock-layer-live').length, 1);
  assert.equal(session.ended, undefined, 'the session goes on');
  assert.deepEqual(page.events, []);
  // Ending the session afterwards is the ordinary end.
  session.end(); installed.restore();
  assert.equal(records(diagnostics, 'ended').length, 1);
  assert.equal(mol.layer.framebuffer, null);
});

test('a frame that draws clears the count of frames without a texture', async () => {
  const { session, mol, installed, log, diagnostics } = setup();
  await mol.attach(); mol.start();
  session.tick(); session.tick();
  for (let round = 0; round < 3; round++) {
    log.failViews = true;
    for (let i = 1; i < MOLECULE_FAULT_FRAMES; i++) session.tick();
    log.failViews = false;
    session.tick();
  }
  assert.ok(getXrLayerStack(session), 'still on the projection layer');
  assert.equal(records(diagnostics, 'handed-back').length, 0);
  assert.equal(session.updates.filter(update => update.baseLayer).length, 0);
  installed.restore();
});

test('two eyes on separate textures hand the session a stock layer on that frame', async () => {
  const { session, mol, installed, diagnostics, log } = setup();
  await mol.attach(); mol.start();
  session.tick(); session.tick();
  log.splitNow = true;
  session.tick();
  assert.deepEqual(records(diagnostics, 'handed-back').map(row => row.reason), ['split-textures']);
  assert.ok(session.updates.at(-1).baseLayer instanceof StockLayer);
  assert.equal(getXrLayerStack(session), null);
  installed.restore();
});

test('a browser that refuses the stock layer ends the session and tells the page why', async () => {
  const page = pageEvents();
  class RefusedLayer extends StockLayer { constructor(...args) { super(...args); if (RefusedLayer.refuse) throw new DOMException('no base layer with layers', 'NotSupportedError'); } }
  const { session, mol, installed, diagnostics, log } = setup({ scope: { XRWebGLLayer: RefusedLayer, ...page.scope } });
  await mol.attach(); mol.start();
  session.tick(); session.tick();
  const retired = [];
  getXrLayerStack(session).onRetire(reason => retired.push(reason));
  RefusedLayer.refuse = true; log.failViews = true;
  for (let i = 0; i < MOLECULE_FAULT_FRAMES; i++) session.tick();
  assert.deepEqual(retired, ['no-texture'], 'the overlays still let go');
  assert.equal(records(diagnostics, 'hand-back-refused').length, 1);
  assert.equal(records(diagnostics, 'session-ended').length, 1);
  assert.equal(session.ended, 1);
  assert.deepEqual(page.events.map(event => [event.type, event.detail.message, event.detail.reason]), [[XR_PROBLEM_EVENT, XR_LAYERS_ENDED_MESSAGE, 'no-texture']]);
  assert.match(XR_LAYERS_ENDED_MESSAGE, /^The headset view closed because/);
  assert.equal(mol.layer.framebuffer, null);
  installed.restore();
});

test('a stock layer the session never shows ends the session instead of leaving an empty view', async () => {
  const page = pageEvents();
  const { session, mol, installed, diagnostics, log } = setup({ scope: page.scope });
  await mol.attach(); mol.start();
  session.tick(); session.tick();
  session.dropBaseLayer = true; log.failViews = true;
  for (let i = 0; i < MOLECULE_FAULT_FRAMES; i++) session.tick();
  assert.equal(records(diagnostics, 'handed-back').length, 1);
  for (let i = 1; i < STOCK_LAYER_FRAMES; i++) session.tick();
  assert.equal(session.ended, undefined, 'it is given time to arrive');
  assert.equal(log.layers[0].destroyed, false);
  session.tick();
  assert.equal(session.ended, 1);
  assert.deepEqual(page.events.map(event => event.detail.reason), ['stock-layer-not-applied']);
  assert.equal(records(diagnostics, 'stock-layer-live').length, 0);
  installed.restore();
  assert.equal(log.layers[0].destroyed, true);
});

test('a projection layer the browser never lists hands the session a stock layer instead of an empty view', async () => {
  const { session, mol, installed, diagnostics } = setup();
  session.dropLayers = true;
  await mol.attach(); mol.start();
  const retired = [];
  getXrLayerStack(session).onRetire(reason => retired.push(reason));
  for (let i = 0; i < LAYER_APPLY_FRAMES; i++) session.tick();
  assert.equal(mol.draws, 0, 'Mol* has no base layer to draw into');
  assert.equal(records(diagnostics, 'handed-back').length, 0, 'the browser is given its frames to apply the layer');
  session.tick();
  assert.deepEqual(retired, ['layer-not-applied']);
  assert.deepEqual(records(diagnostics, 'handed-back').map(row => row.reason), ['layer-not-applied']);
  assert.ok(session.updates.at(-1).baseLayer instanceof StockLayer);
  session.tick(); session.tick();
  assert.equal(records(diagnostics, 'stock-layer-live').length, 1);
  assert.ok(mol.draws > 0, 'Mol* draws into the stock layer');
  installed.restore();
});

test('a projection layer the browser lists late, within its frames, is kept', async () => {
  const { session, mol, installed, diagnostics, log } = setup();
  session.dropLayers = true;
  await mol.attach(); mol.start();
  for (let i = 0; i < LAYER_APPLY_FRAMES - 2; i++) session.tick();
  session.dropLayers = false;
  session.updateRenderState({ layers: [log.layers[0]] });
  for (let i = 0; i < 6; i++) session.tick();
  assert.equal(records(diagnostics, 'handed-back').length, 0);
  assert.ok(getXrLayerStack(session));
  assert.ok(mol.draws > 0);
  installed.restore();
});

test('a WebGL 1 context gets a 16-bit private depth buffer and no discard call', async () => {
  const { session, gl, mol, installed } = setup({ gl2: false });
  await mol.attach();
  mol.start();
  session.tick(); session.tick();
  assert.equal(gl.bound.draw.depth.storage.format, gl.DEPTH_COMPONENT16);
  assert.equal(gl.calls.filter(call => call[0] === 'invalidate').length, 0);
  assert.equal(mol.draws, 2);
  installed.restore();
});

test('without a draw counter the callback that drew into the layer is the molecular frame', async () => {
  const { session, mol, installed } = setup({ drawCount: false });
  await mol.attach();
  mol.start();
  let calls = 0;
  getXrLayerStack(session).onAfterMolecularFrame(() => { calls++; });
  session.tick(); session.tick();
  assert.equal(calls, 2);
  installed.restore();
});

test('a binding that builds its own base layer through the global gets a stock layer, not a loop', async () => {
  const diagnostics = [];
  const log = { bindings: [], inits: [], layers: [] };
  const Fake = fakeBindingClass(log);
  const scope = { XRWebGLLayer: StockLayer, location: { search: '?xrLayers=1' },
    __stereofoldDiagnostics: { record: (kind, detail) => diagnostics.push({ kind, ...detail }) } };
  const inner = [];
  scope.XRWebGLBinding = class extends Fake {
    createProjectionLayer(init) { inner.push(new scope.XRWebGLLayer(this.session, this.gl, {})); return super.createProjectionLayer(init); }
  };
  const session = new FakeSession();
  const installed = installXrLayers({ session, space: {}, scope });
  const mol = fakeMolstar({ scope, session, gl: fakeGl(), space: {} });
  await mol.attach();
  assert.ok(inner[0] instanceof StockLayer);
  assert.equal(mol.layer.projectionLayer, log.layers[0]);
  assert.ok(new scope.XRWebGLLayer(session, {}, {}) instanceof StockLayer, 'later constructions are stock too');
  assert.equal(records(diagnostics, 'created').length, 1);
  installed.restore();
});

test('a still asks every overlay to paint itself, and says whether all of them did', async () => {
  const { session, mol, diagnostics } = setup();
  await mol.attach(); mol.start();
  session.tick(); session.tick();
  const stack = getXrLayerStack(session);
  const still = { view: { eye: 'left' }, framebuffer: { id: 'still' }, width: 480, height: 360 };
  // With no overlay there is nothing to add, and the still is whole as read.
  assert.equal(stack.paintCapture(still), undefined);
  const seen = [];
  const stop = stack.onCapture(target => { seen.push(target); return true; });
  assert.equal(stack.paintCapture(still), true);
  assert.deepEqual(seen, [still], 'the painter is handed the still');
  // One overlay that could not draw makes the still incomplete, and one that
  // throws costs neither the others nor the capture.
  const stopDeclining = stack.onCapture(() => false);
  assert.equal(stack.paintCapture(still), false);
  stopDeclining();
  const stopThrowing = stack.onCapture(() => { throw new Error('painter failed'); });
  assert.equal(stack.paintCapture(still), false);
  assert.equal(seen.length, 3, 'the first painter still ran each time');
  assert.equal(records(diagnostics, 'error').filter(row => row.where === 'capture').length, 1);
  stopThrowing(); stop();
  assert.equal(stack.paintCapture(still), undefined);
  // A disposed stack takes no painter and paints nothing.
  stack.onCapture(() => { seen.push('late'); return true; });
  session.end();
  assert.equal(stack.paintCapture(still), undefined);
  assert.equal(stack.onCapture(() => true)(), undefined);
  assert.equal(seen.includes('late'), false);
});
