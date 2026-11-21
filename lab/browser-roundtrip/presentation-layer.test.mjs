import test from 'node:test';
import assert from 'node:assert/strict';
import {
  attachPresentationLayers, captureMolecularDraw, controlInFrontOfMenu, controlsEyeCamera, CONTROLS_FAR_METERS, CONTROLS_LAYER_SAMPLES, CURSOR_METERS, lightsSeenFrom,
  MENU_RELIGHT_DEGREES, QUAD_TEXTURE_SLACK, quadTextureSize, menuPanelCamera, menuQuadInView, menuQuadLayout, multiplyMatrix4, viewTurnDegrees, presentationUiTarget, projectionTargets, QUAD_MARGIN_METERS, QUAD_MAX_PIXELS,
} from './presentation-layer.mjs';

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const records = [];
globalThis.__stereofoldDiagnostics = { record: (kind, detail) => records.push({ kind, ...detail }) };
const phases = () => records.filter(r => r.kind === 'presentation-layer').map(r => r.phase);

/**
 * A WebGL2 stand-in that logs every call and keeps the bindings it is asked
 * about. Every texture it sees is a 2D texture, so, as in GL, attaching one as
 * an array layer raises INVALID_OPERATION and leaves the colour attachment
 * empty. `log.pixels` is what a read-back finds (any alpha by default).
 * `log.msrtt` gives the context `WEBGL_multisampled_render_to_texture`; set to
 * 'refused', a texture attached through it leaves the framebuffer incomplete.
 */
function fakeGl(log) {
  let next = 0, error = 'NO_ERROR';
  const bindings = { DRAW_FRAMEBUFFER_BINDING: 'molecule-fb', READ_FRAMEBUFFER_BINDING: 'molecule-fb',
    CURRENT_PROGRAM: 'mol-program', VERTEX_ARRAY_BINDING: 'mol-vao', ARRAY_BUFFER_BINDING: 'mol-buffer',
    DEPTH_FUNC: 'LESS', DEPTH_WRITEMASK: true, COLOR_WRITEMASK: [true, true, true, true], SCISSOR_BOX: [0, 0, 10, 10],
    PIXEL_PACK_BUFFER_BINDING: null, RENDERBUFFER_BINDING: null };
  const colour = new Map();
  const special = {
    getParameter: name => bindings[name],
    bindFramebuffer(target, framebuffer) {
      log.push(['gl.bindFramebuffer', target, framebuffer]);
      if (target === 'FRAMEBUFFER' || target === 'DRAW_FRAMEBUFFER') bindings.DRAW_FRAMEBUFFER_BINDING = framebuffer;
      if (target === 'FRAMEBUFFER' || target === 'READ_FRAMEBUFFER') bindings.READ_FRAMEBUFFER_BINDING = framebuffer;
    },
    framebufferTexture2D(target, attachment, textarget, texture, level) {
      log.push(['gl.framebufferTexture2D', target, attachment, textarget, texture, level]);
      if (target === 'FRAMEBUFFER') log.msrttAttached = false;
      if (attachment === 'COLOR_ATTACHMENT0') colour.set(bindings.DRAW_FRAMEBUFFER_BINDING, texture ? 'TEXTURE' : 'NONE');
    },
    framebufferTextureLayer(target, attachment, texture, level, layer) {
      log.push(['gl.framebufferTextureLayer', target, attachment, texture, level, layer]);
      if (texture) error = 'INVALID_OPERATION';
      else colour.set(bindings.DRAW_FRAMEBUFFER_BINDING, 'NONE');
    },
    checkFramebufferStatus: () => log.framebufferStatus
      ?? (colour.get(bindings.DRAW_FRAMEBUFFER_BINDING) === 'REFUSED' ? 'FRAMEBUFFER_INCOMPLETE_MULTISAMPLE' : 'FRAMEBUFFER_COMPLETE'),
    getExtension(name) {
      if (name !== 'WEBGL_multisampled_render_to_texture' || !log.msrtt) return null;
      return {
        framebufferTexture2DMultisampleEXT(target, attachment, textarget, texture, level, samples) {
          log.push(['ext.framebufferTexture2DMultisampleEXT', target, attachment, textarget, texture, level, samples]);
          log.msrttAttached = true;
          colour.set(bindings.DRAW_FRAMEBUFFER_BINDING, log.msrtt === 'refused' ? 'REFUSED' : 'TEXTURE');
          if (log.msrtt === 'refused') error = 'INVALID_OPERATION';
        },
        renderbufferStorageMultisampleEXT: (...args) => { log.push(['ext.renderbufferStorageMultisampleEXT', ...args]); },
      };
    },
    getFramebufferAttachmentParameter: (target, attachment) =>
      attachment === 'COLOR_ATTACHMENT0' ? colour.get(bindings.DRAW_FRAMEBUFFER_BINDING) ?? 'NONE' : 'RENDERBUFFER',
    getError() { const raised = error; error = 'NO_ERROR'; log.push(['gl.getError', raised]); return raised; },
    // `log.drawFails`: a multisampled target that completes and then refuses to be drawn into.
    clear(...args) {
      log.push(['gl.clear', ...args]);
      if (log.drawFails && log.msrttAttached) error = 'INVALID_FRAMEBUFFER_OPERATION';
    },
    getBufferSubData(target, offset, pixels) {
      log.push(['gl.getBufferSubData']);
      for (let i = 3; i < pixels.length; i += 4) pixels[i] = log.pixels === 'empty' ? 0 : (i % 64 === 3 ? 200 : 0);
    },
    isContextLost: () => log.lost === true,
    isEnabled: () => false,
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getUniformLocation: () => 'uMvp',
    getAttribLocation: () => 0,
  };
  return new Proxy({}, { get(_, name) {
    if (typeof name !== 'string') return undefined;
    if (/^[A-Z0-9_]+$/.test(name)) return name;
    if (name in special) return special[name];
    return (...args) => {
      log.push([`gl.${name}`, ...args]);
      if (name.startsWith('create')) return `${name.slice(6).toLowerCase()}-${++next}`;
      return undefined;
    };
  } });
}

function fakeState(log) {
  return new Proxy({ currentProgramId: 7, currentRenderItemId: 7, currentMaterialId: 7 }, { get(target, name) {
    if (name in target) return target[name];
    return (...args) => log.push([`state.${String(name)}`, ...args]);
  }, set(target, name, value) { target[name] = value; return true; } });
}

function eyeCamera(name, x) {
  return { name, disabled: false, viewport: { x, y: 0, width: 100, height: 50 }, view: IDENTITY, projectionView: IDENTITY };
}

/**
 * `quest` makes the binding answer as Quest Browser does for a side-by-side
 * 'texture' layer: one texture, an image index per eye, and the texture's size
 * as `colorTextureWidth`/`colorTextureHeight` with none on the sub-image itself.
 */
function harness({ target = 'projection', plate, aim, axes, pointer, failOn, blank = {}, quest = false, others = () => [], eye, splits = true, lights, msrtt } = {}) {
  const log = [];
  if (msrtt) log.msrtt = msrtt;
  const gl = fakeGl(log);
  const state = fakeState(log);
  const renderer = {
    setDrawingBufferSize: (w, h) => log.push(['renderer.setDrawingBufferSize', w, h]),
    setViewport: (x, y, w, h) => log.push(['renderer.setViewport', x, y, w, h]),
    update: (camera, scene) => {
      if (failOn === 'update') throw Error('boom');
      log.push(['renderer.update', camera.name ?? 'panel', scene.name]);
    },
    renderBlended: (scene, camera) => log.push(['renderer.renderBlended', scene.name, camera.name ?? 'panel',
      ...(lights ? [renderer.props.light] : [])]),
    // The renderer's lights, as Mol* exposes and sets them.
    ...(lights ? { props: { light: lights }, setProps(props) { log.push(['renderer.setProps', props.light]); renderer.props.light = props.light; } } : {}),
  };
  class DrawPass {
    constructor() { this.colorTarget = { getWidth: () => 300, getHeight: () => 60 }; }
    render(ctx) { log.push(['molecule', ctx.camera.left.name]); log.push(['molecule', ctx.camera.right.name]); }
  }
  const drawPass = new DrawPass();
  const molecular = { name: 'molecule-scene' };
  const stereo = { left: eyeCamera('left', 0), right: eyeCamera('right', 100) };
  const presentationScene = { name: 'presentation-scene', view: IDENTITY };
  let version = 1;
  const handles = [];
  // The scene's two parts, as the presentation hands them to a drawer that
  // asked for the menu column apart. `others` are the controls that are not
  // part of the column, as Mol* renderables with a bounding sphere.
  const column = { name: 'menu-column', renderables: [] }, rest = { name: 'other-controls', renderables: [] };
  const presentation = {
    useExternalDraw({ separateMenuColumn = false } = {}) {
      const handle = { scene: presentationScene, released: false, separateMenuColumn,
        prepare() { log.push(['presentation.prepare']); return true; },
        ...(separateMenuColumn && splits ? { split() {
          rest.renderables = others().map(sphere => ({ state: { visible: true },
            values: { drawCount: { ref: { value: 6 } }, boundingSphere: { ref: { value: sphere } } } }));
          return { column, rest };
        } } : {}),
        release() { handle.released = true; log.push(['presentation.release']); } };
      handles.push(handle);
      return handle;
    },
    contentVersion: () => version,
  };
  const layers = [];
  // Overlays set during a frame reach the render state at the start of the
  // next one, as `updateRenderState` does.
  let activeOverlays = [], pendingOverlays;
  let hook, painter, retire, unsubscribed = 0;
  const listeners = new Map();
  const session = {
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type) { listeners.delete(type); },
    end() { listeners.get('end')?.(); },
  };
  const stack = {
    session, gl,
    binding: {
      createProjectionLayer(init) {
        const layer = { kind: 'projection', init, fixedFoveation: 1, blendTextureSourceAlpha: false,
          destroy() { layer.destroyed = true; } };
        layers.push(layer); return layer;
      },
      getViewSubImage(layer, view) {
        log.push(['binding.getViewSubImage', layer.kind, view.eye]);
        if (blank.projection) return { viewport: { x: 0, y: 0, width: 100, height: 50 } };
        const viewport = view.eye === 'left' ? { x: 0, y: 0, width: 100, height: 50 } : { x: 100, y: 0, width: 100, height: 50 };
        if (quest) return { colorTexture: 'ui-texture', imageIndex: view.eye === 'left' ? 0 : 1,
          colorTextureWidth: 200, colorTextureHeight: 50, viewport };
        return { colorTexture: 'ui-texture', imageIndex: null, textureWidth: 200, textureHeight: 50, viewport };
      },
      createQuadLayer(init) {
        const layer = { kind: init.isStatic ? 'cursor' : 'quad', init, transform: init.transform, width: init.width,
          height: init.height, needsRedraw: true, destroy() { layer.destroyed = true; } };
        layers.push(layer); return layer;
      },
      getSubImage(layer) {
        log.push(['binding.getSubImage', layer.kind, ...(activeOverlays.includes(layer) ? [] : ['outside-render-state'])]);
        layer.needsRedraw = false;
        if (blank[layer.kind]) return { viewport: { x: 0, y: 0, width: 16, height: 16 } };
        return { colorTexture: `${layer.kind}-texture`, textureWidth: layer.init.viewPixelWidth, textureHeight: layer.init.viewPixelHeight,
          viewport: { x: 0, y: 0, width: layer.init.viewPixelWidth, height: layer.init.viewPixelHeight } };
      },
    },
    setOverlayLayers(next) { log.push(['stack.setOverlayLayers', next.map(layer => layer.kind)]); pendingOverlays = [...next]; },
    onAfterMolecularFrame(cb) { hook = cb; return () => { unsubscribed++; }; },
    onCapture(cb) { painter = cb; return () => { painter = undefined; }; },
    onRetire(cb) { retire = cb; return () => { retire = undefined; }; },
  };
  const canvas = { webgl: { gl, state, isContextLost: false },
    camera: { view: IDENTITY, scale: 0.5, state: { mode: 'perspective', target: [0, 0, 0], fog: 0 } } };
  class RigidTransform { constructor(position, orientation) { this.position = position; this.orientation = orientation; } }
  const attached = attachPresentationLayers({ stack, presentation, canvas, drawPass, space: 'local', target,
    getMenuPlate: () => plate?.(), getAimPoint: () => aim?.(), getAimAxes: () => axes?.(), getPointer: () => pointer?.(),
    scope: { XRRigidTransform: RigidTransform } });
  const pose = { views: [{ eye: 'left', ...(eye ? { transform: { position: { x: eye[0], y: eye[1], z: eye[2] } } } : {}) }, { eye: 'right' }] };
  return {
    log, attached, layers, handles, drawPass, session, stack, gl, stereo, renderer,
    get unsubscribed() { return unsubscribed; },
    /** What the stack would run for a still of one eye, while the layers are attached. */
    get painter() { return painter; },
    /** What the stack calls when it gives the molecule's layer up for a stock base layer. */
    get retire() { return retire; },
    bump() { version++; },
    /** One XR frame: Mol* draws the molecule, then the stack's after-frame hook runs. */
    frame({ molecule = true } = {}) {
      if (pendingOverlays) { activeOverlays = pendingOverlays; pendingOverlays = undefined; }
      if (molecule) drawPass.render({ renderer, scene: molecular, camera: stereo }, {}, true);
      hook?.({ frame: true }, pose);
    },
  };
}

const PLATE = () => ({ point: [0.1, 1.2, -0.8], right: [1, 0, 0], up: [0, 1, 0], normal: [0, 0, -1],
  halfWidth: 0.12, halfHeight: 0.2, front: 0.02, back: 0.01, seat: [0, 1.4, 0.3] });
/** The same glass inside the test eyes' view, whose projection-view is the identity. */
const PLATE_IN_VIEW = () => ({ ...PLATE(), point: [0.1, 0.2, -0.8] });

const names = log => log.map(entry => entry[0]);

test('the UI target is a projection layer unless the page asks for the quad', () => {
  assert.equal(presentationUiTarget({ location: { search: '?xrLayers=1' } }), 'projection');
  assert.equal(presentationUiTarget({ location: { search: '?xrLayers=1&xrUi=quad' } }), 'quad');
  assert.equal(presentationUiTarget({ location: { search: '?xrUi=bogus' } }), 'projection');
  assert.equal(presentationUiTarget({}), 'projection');
});

test('the controls draw after both molecular eyes, into one cleared target, left then right', () => {
  const h = harness();
  assert.deepEqual(h.log.filter(e => e[0] === 'stack.setOverlayLayers'), [['stack.setOverlayLayers', ['projection']]]);
  const layer = h.layers[0];
  assert.equal(layer.init.textureType, 'texture');
  assert.equal(layer.init.depthFormat, 0);
  assert.equal(layer.fixedFoveation, 0);
  assert.equal(layer.blendTextureSourceAlpha, true);
  h.log.length = 0;
  h.frame();
  const order = h.log.filter(([name]) => ['molecule', 'gl.clear', 'renderer.renderBlended', 'gl.bindFramebuffer'].includes(name))
    .map(([name, a, b]) => name === 'molecule' ? `molecule ${a}` : name === 'renderer.renderBlended' ? `ui ${b}`
      : name === 'gl.clear' ? 'clear' : `bind ${a} ${b}`);
  assert.deepEqual(order, ['molecule left', 'molecule right', 'bind FRAMEBUFFER framebuffer-1', 'clear', 'ui left', 'ui right',
    'bind DRAW_FRAMEBUFFER molecule-fb', 'bind READ_FRAMEBUFFER molecule-fb']);
  // Each eye is drawn in its own viewport of the side-by-side texture, with
  // the renderer updated for that eye against the molecular scene, as stock.
  assert.deepEqual(h.log.filter(e => e[0] === 'renderer.setViewport').map(e => e.slice(1)), [[0, 0, 100, 50], [100, 0, 100, 50]]);
  assert.deepEqual(h.log.filter(e => e[0] === 'renderer.update').map(e => e.slice(1)), [['left', 'molecule-scene'], ['right', 'molecule-scene']]);
  assert.deepEqual(h.log.find(e => e[0] === 'gl.framebufferTexture2D').slice(1), ['FRAMEBUFFER', 'COLOR_ATTACHMENT0', 'TEXTURE_2D', 'ui-texture', 0]);
  assert.ok(names(h.log).includes('gl.invalidateFramebuffer'), 'the private depth is never stored');
  // The renderer's drawing-buffer size goes back to the molecular target's.
  assert.deepEqual(h.log.filter(e => e[0] === 'renderer.setDrawingBufferSize').map(e => e.slice(1)), [[200, 50], [300, 60]]);
  // The clear is whole, through the state cache.
  const clearAt = names(h.log).indexOf('gl.clear');
  assert.deepEqual(h.log.slice(clearAt - 4, clearAt).map(e => e[0]),
    ['state.disable', 'state.colorMask', 'state.depthMask', 'state.clearColor']);
  assert.deepEqual(h.log[clearAt - 1].slice(1), [0, 0, 0, 0]);
});

test('a frame Mol* did not draw leaves the controls alone', () => {
  const h = harness();
  h.frame();
  h.log.length = 0;
  h.frame({ molecule: false });
  assert.equal(h.log.filter(e => e[0] === 'renderer.renderBlended').length, 0);
});

test('the draw-pass capture hands out each stereo draw once and restores the prototype method', () => {
  const calls = [];
  class Pass { render(ctx, props, toDrawingBuffer) { calls.push(toDrawingBuffer); } }
  const pass = new Pass();
  const capture = captureMolecularDraw(pass);
  pass.render({ renderer: 'r', scene: 's', camera: { view: IDENTITY } }, {}, true);
  assert.equal(capture.take(), undefined, 'a mono draw is not an XR frame');
  pass.render({ renderer: 'r', scene: 's', camera: { left: 1, right: 2 } }, {}, false);
  assert.equal(capture.take(), undefined, 'an offscreen draw is not the frame either');
  pass.render({ renderer: 'r', scene: 's', camera: { left: 1, right: 2 } }, {}, true);
  assert.equal(capture.take().renderer, 'r');
  assert.equal(capture.take(), undefined);
  capture.restore();
  assert.equal(Object.prototype.hasOwnProperty.call(pass, 'render'), false);
  assert.deepEqual(calls, [true, false, true]);
});

test('projection targets group eyes by texture and keep their viewports', () => {
  const binding = { getViewSubImage: (layer, view) => ({ colorTexture: view.texture, imageIndex: view.index ?? null,
    textureWidth: 400, textureHeight: 200, viewport: view.viewport }) };
  const left = { name: 'L' }, right = { name: 'R' };
  const shared = projectionTargets(binding, {}, [
    { texture: 't', viewport: { x: 0, y: 0, width: 200, height: 200 } },
    { texture: 't', viewport: { x: 200, y: 0, width: 200, height: 200 } }], [left, right]);
  assert.equal(shared.length, 1);
  assert.deepEqual(shared[0].eyes.map(e => [e.camera.name, e.viewport.x]), [['L', 0], ['R', 200]]);
  const array = projectionTargets(binding, {}, [
    { texture: 't', index: 0, viewport: { x: 0, y: 0, width: 200, height: 200 } },
    { texture: 't', index: 1, viewport: { x: 0, y: 0, width: 200, height: 200 } }], [left, right], { textureType: 'texture-array' });
  assert.deepEqual(array.map(t => [t.imageIndex, t.eyes.length]), [[0, 1], [1, 1]]);
  const mono = projectionTargets(binding, {}, [{ texture: 't', viewport: { x: 0, y: 0, width: 200, height: 200 } }],
    [left, { name: 'R', disabled: true }]);
  assert.equal(mono[0].eyes.length, 1);
});

test('a side-by-side texture is one target sized from the texture even when each eye reports an image index', () => {
  const seen = [];
  const binding = { getViewSubImage: (layer, view) => ({ colorTexture: 't', imageIndex: view.index,
    colorTextureWidth: 2880, colorTextureHeight: 1584, viewport: view.viewport }) };
  const targets = projectionTargets(binding, { textureWidth: 2880, textureHeight: 1584 }, [
    { index: 0, viewport: { x: 0, y: 0, width: 1440, height: 1584 } },
    { index: 1, viewport: { x: 1440, y: 0, width: 1440, height: 1584 } }], [{ name: 'L' }, { name: 'R' }], { seen });
  assert.deepEqual(targets.map(t => [t.imageIndex, t.width, t.height, t.eyes.length]), [[null, 2880, 1584, 2]]);
  assert.deepEqual(seen.map(s => [s.imageIndex, s.sameTexture]), [[0, false], [1, true]]);
  // Without a size on the sub-image the layer's own texture size is used.
  const bare = projectionTargets({ getViewSubImage: (layer, view) => ({ colorTexture: 't', viewport: view.viewport }) },
    { textureWidth: 2880, textureHeight: 1584 }, [{ viewport: { x: 0, y: 0, width: 1440, height: 1584 } }], [{ name: 'L' }]);
  assert.deepEqual([bare[0].width, bare[0].height], [2880, 1584]);
});

test('Quest image indexes on the controls layer still draw both eyes into its one texture', () => {
  records.length = 0;
  const h = harness({ quest: true });
  h.log.length = 0;
  h.frame();
  // One 2D attachment, one clear, both eyes drawn: never an array-layer
  // attachment, which GL refuses on a 2D texture and leaves the layer empty.
  assert.equal(h.log.filter(e => e[0] === 'gl.framebufferTextureLayer').length, 0);
  assert.deepEqual(h.log.find(e => e[0] === 'gl.framebufferTexture2D').slice(1), ['FRAMEBUFFER', 'COLOR_ATTACHMENT0', 'TEXTURE_2D', 'ui-texture', 0]);
  assert.equal(h.log.filter(e => e[0] === 'gl.clear').length, 1);
  assert.deepEqual(h.log.filter(e => e[0] === 'renderer.renderBlended').map(e => e[2]), ['left', 'right']);
  assert.equal(h.attached.facts().state, 'layered');
  const first = records.find(r => r.phase === 'first-frame');
  assert.equal(first.targets, 1);
  assert.deepEqual(first.size, [[200, 50]]);
  assert.deepEqual(first.subImages.map(s => s.imageIndex), [0, 1]);
  assert.deepEqual(first.framebuffer, { layer: 'projection', status: 'FRAMEBUFFER_COMPLETE', colorAttachment: 'TEXTURE',
    attachError: 'NO_ERROR', drawError: 'NO_ERROR' });
});

test('a controls framebuffer that cannot be drawn hands the controls back on its first frame', () => {
  records.length = 0;
  const h = harness();
  h.log.framebufferStatus = 'FRAMEBUFFER_INCOMPLETE_ATTACHMENT';
  h.frame();
  assert.equal(h.attached.facts().state, 'stock');
  assert.equal(h.handles[0].released, true);
  assert.match(h.attached.facts().error, /framebuffer FRAMEBUFFER_INCOMPLETE_ATTACHMENT/);
  assert.deepEqual(phases(), ['attached', 'failed', 'detached']);
});

test('only the first draws pay for the framebuffer check', () => {
  const h = harness();
  for (let i = 0; i < 3; i++) h.frame();
  assert.ok(h.log.filter(e => e[0] === 'gl.getError').length > 0);
  h.log.length = 0;
  for (let i = 0; i < 3; i++) h.frame();
  assert.equal(h.log.filter(e => e[0] === 'gl.getError').length, 0);
});

test('the controls layer is read back once with the menu in view, and pixels settle it', () => {
  records.length = 0;
  const h = harness({ plate: PLATE_IN_VIEW });
  h.frame();
  // Scaled down into a small buffer and read into a pixel buffer: the frame
  // does not wait for it.
  assert.ok(names(h.log).includes('gl.blitFramebuffer') && names(h.log).includes('gl.readPixels'));
  assert.equal(names(h.log).includes('gl.getBufferSubData'), false);
  h.frame();
  assert.equal(names(h.log).includes('gl.getBufferSubData'), false, 'not read on the next frame either');
  h.log.length = 0;
  h.frame();
  assert.ok(names(h.log).includes('gl.getBufferSubData'));
  assert.deepEqual(records.filter(r => r.phase === 'verified').map(r => [r.layer, r.lit > 0]), [['projection', true]]);
  h.log.length = 0;
  for (let i = 0; i < 50; i++) h.frame();
  assert.equal(names(h.log).includes('gl.blitFramebuffer'), false, 'never read again');
  assert.equal(h.attached.facts().state, 'layered');
});

test('a controls layer that reads back empty with the menu in view hands the controls back', () => {
  records.length = 0;
  const h = harness({ plate: PLATE_IN_VIEW });
  h.log.pixels = 'empty';
  for (let i = 0; i < 2; i++) h.frame();
  assert.equal(h.attached.facts().state, 'layered', 'one empty read-back is not yet a verdict');
  for (let i = 0; i < 40 && h.attached.facts().state === 'layered'; i++) h.frame();
  assert.equal(h.attached.facts().state, 'stock');
  assert.equal(h.handles[0].released, true);
  assert.match(h.attached.facts().error, /projection layer read back empty 2 times/);
  assert.deepEqual(phases().filter(p => p !== 'first-frame'), ['attached', 'empty-readback', 'empty-readback', 'failed', 'detached']);
});

test('with the menu out of view nothing is read back', () => {
  const h = harness({ plate: PLATE });
  for (let i = 0; i < 5; i++) h.frame();
  assert.equal(names(h.log).includes('gl.blitFramebuffer'), false);
});

test('in quad mode the read-back follows the column onto its quad', () => {
  records.length = 0;
  const h = harness({ target: 'quad', plate: PLATE_IN_VIEW });
  for (let i = 0; i < 6; i++) h.frame();
  // First the projection layer, which carries the column until its quad is
  // composited, then the quad itself, redrawn for the read-back.
  assert.deepEqual(records.filter(r => r.phase === 'verified').map(r => r.layer), ['projection', 'quad']);
  assert.deepEqual(records.filter(r => r.phase === 'framebuffer').map(r => [r.layer, r.status, r.colorAttachment]),
    [['quad', 'FRAMEBUFFER_COMPLETE', 'TEXTURE']]);
  assert.equal(h.attached.facts().state, 'layered');
});

test('the controls are drawn with a far plane past the menu, on the molecule eye\'s own frustum', () => {
  // An off-axis eye frustum with near 0.01 m and far 0.73 m, as a WebXR view reports it.
  const near = 0.01, far = 0.73, l = -0.012, r = 0.009, b = -0.01, t = 0.011;
  const projection = [2 * near / (r - l), 0, 0, 0, 0, 2 * near / (t - b), 0, 0,
    (r + l) / (r - l), (t + b) / (t - b), -(far + near) / (far - near), -1, 0, 0, -2 * far * near / (far - near), 0];
  const view = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.03, -1.6, 0.2, 1];
  const eye = { name: 'left', projection: [...projection], view, projectionView: multiplyMatrix4(projection, view), near: 7, far: 9 };
  const camera = controlsEyeCamera(eye);
  assert.notEqual(camera, eye);
  assert.deepEqual(eye.projection, projection, 'the molecule eye is not touched');
  const p = camera.projection;
  for (const i of [0, 5, 8, 9, 11]) assert.equal(p[i], projection[i], `entry ${i} keeps the frustum`);
  assert.ok(Math.abs(p[14] / (p[10] - 1) - near) < 1e-9, 'same near plane');
  assert.ok(Math.abs(p[14] / (p[10] + 1) - CONTROLS_FAR_METERS) < 1e-6, 'far plane moved out');
  assert.deepEqual(camera.projectionView, multiplyMatrix4(p, view));
  assert.equal(camera.name, 'left');
  // A menu point 1.3 m in front of the eye lands inside the new depth range.
  const clip = multiplyMatrix4(camera.projectionView, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -0.03, 1.6, -1.5, 1]);
  assert.ok(Math.abs(clip[14] / clip[15]) < 1);
  // A far plane already past it, or a projection it cannot read, is left alone.
  const deep = [...projection]; deep[10] = -(40 + near) / (40 - near); deep[14] = -2 * 40 * near / (40 - near);
  assert.equal(controlsEyeCamera({ ...eye, projection: deep }).projection, deep);
  assert.equal(controlsEyeCamera({ ...eye, projection: IDENTITY }).projection, IDENTITY);
});

test('the quad takes the glass pose and size: centre, axes, margin and texture density', () => {
  const layout = menuQuadLayout(PLATE());
  assert.deepEqual(layout.position, { x: 0.1, y: 1.2, z: -0.8 });
  // Facing the wearer (glass normal -z), the quad needs no rotation.
  for (const [k, v] of Object.entries({ x: 0, y: 0, z: 0, w: 1 })) assert.ok(Math.abs(layout.orientation[k] - v) < 1e-12, k);
  assert.ok(Math.abs(layout.width - 2 * (0.12 + QUAD_MARGIN_METERS)) < 1e-12);
  assert.ok(Math.abs(layout.height - 2 * (0.2 + QUAD_MARGIN_METERS)) < 1e-12);
  assert.equal(layout.viewPixelWidth % 16, 0);
  assert.ok(layout.viewPixelWidth >= layout.width * 1600);
  // A glass turned 90 degrees to face +x: the quad's +z is the outward normal.
  const turned = menuQuadLayout({ ...PLATE(), right: [0, 0, -1], normal: [-1, 0, 0] });
  const { x, y, z, w } = turned.orientation;
  const rotate = v => { // q v q*
    const [vx, vy, vz] = v;
    const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
    return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
  };
  const close = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-9);
  assert.ok(close(rotate([0, 0, 1]), [1, 0, 0]), 'quad +z faces out of the glass');
  assert.ok(close(rotate([1, 0, 0]), [0, 0, -1]), 'quad +x is the glass right');
  assert.ok(close(rotate([0, 1, 0]), [0, 1, 0]), 'quad +y is the glass up');
  // Huge glass keeps its aspect within the texture cap.
  const big = menuQuadLayout({ ...PLATE(), halfWidth: 2, halfHeight: 1 });
  assert.equal(big.viewPixelWidth, QUAD_MAX_PIXELS);
  assert.ok(Math.abs(big.viewPixelWidth / big.viewPixelHeight - big.width / big.height) < 0.02);
  // A mirrored basis or a missing extent is refused.
  assert.equal(menuQuadLayout({ ...PLATE(), right: [-1, 0, 0] }), undefined);
  assert.equal(menuQuadLayout({ ...PLATE(), halfWidth: 0 }), undefined);
  assert.equal(menuQuadLayout(undefined), undefined);
});

test('the window camera maps the quad corners onto the whole texture from the seat', () => {
  const layout = menuQuadLayout(PLATE());
  const canvasView = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.3, -0.2, -1, 1];
  const camera = menuPanelCamera(layout, { view: canvasView, scale: 0.25, state: {} }, { x: 0, y: 0, width: 64, height: 96 });
  // Room metres reach the camera's view through the inverse canvas view.
  const toWorld = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -0.3, 0.2, 1, 1];
  const mvp = multiplyMatrix4(camera.projectionView, toWorld);
  const project = p => {
    const clip = [0, 1, 2, 3].map(r => mvp[r] * p[0] + mvp[4 + r] * p[1] + mvp[8 + r] * p[2] + mvp[12 + r]);
    return clip.slice(0, 3).map(v => v / clip[3]);
  };
  const { centre, right, up, halfWidth, halfHeight } = layout;
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const corner = centre.map((v, i) => v + right[i] * sx * halfWidth + up[i] * sy * halfHeight);
    const ndc = project(corner);
    assert.ok(Math.abs(ndc[0] - sx) < 1e-9 && Math.abs(ndc[1] - sy) < 1e-9, `corner ${sx},${sy} -> ${ndc}`);
    assert.ok(ndc[2] > -1 && ndc[2] < 1, 'the glass plane lies inside the depth range');
  }
  assert.equal(camera.scale, 0.25);
  assert.equal(camera.state.fog, 0);
  assert.ok(camera.headRotation.every(v => v === 0) && camera.viewEye.every(v => v === 0));
  // No seat: the camera stands straight in front and still frames the quad.
  const { seat, ...unseated } = layout;
  assert.ok(seat);
  const straight = menuPanelCamera(unseated, { view: IDENTITY, scale: 1 }, { x: 0, y: 0, width: 1, height: 1 });
  assert.ok(straight);
});

test('the menu quad is redrawn only when the controls change or the compositor asks', () => {
  let plate = PLATE();
  const h = harness({ target: 'quad', plate: () => plate });
  h.frame();
  assert.deepEqual(h.log.filter(e => e[0] === 'stack.setOverlayLayers').map(e => e[1]), [['projection'], ['projection', 'quad']]);
  const quad = h.layers.find(l => l.kind === 'quad');
  assert.equal(quad.init.space, 'local');
  assert.equal(quad.init.layout, 'mono');
  assert.deepEqual(quad.transform.position, { x: 0.1, y: 1.2, z: -0.8 });
  // The browser measures a quad from its centre to its edge.
  const span = menuQuadLayout(PLATE());
  assert.deepEqual([quad.init.width, quad.init.height], [span.width / 2, span.height / 2]);
  const quadDraws = () => h.log.filter(e => e[0] === 'binding.getSubImage' && e[1] === 'quad').length;
  assert.equal(quadDraws(), 0, 'a quad made this frame waits for the next');
  h.frame();
  assert.equal(quadDraws(), 1);
  h.frame(); h.frame();
  assert.equal(quadDraws(), 1, 'unchanged content is not redrawn');
  h.bump(); h.frame();
  assert.equal(quadDraws(), 2, 'a content change redraws');
  quad.needsRedraw = true; h.frame();
  assert.equal(quadDraws(), 3, 'the compositor asking redraws');
  plate = { ...PLATE(), point: [0.2, 1.2, -0.8] }; h.frame();
  assert.equal(h.layers.filter(l => l.kind === 'quad').length, 1, 'a move keeps the same texture');
  assert.deepEqual(quad.transform.position, { x: 0.2, y: 1.2, z: -0.8 });
  assert.equal(quadDraws(), 4);
  // Hidden and shown again at the same size: the same quad, redrawn.
  plate = undefined; h.frame();
  assert.deepEqual(h.log.filter(e => e[0] === 'stack.setOverlayLayers').at(-1)[1], ['projection']);
  plate = { ...PLATE(), point: [0.2, 1.2, -0.8] }; h.frame();
  assert.equal(h.layers.filter(l => l.kind === 'quad').length, 1);
  assert.equal(quadDraws(), 4, 'a quad shown again waits for the next frame, as a new one does');
  h.frame();
  assert.equal(quadDraws(), 5);
  plate = { ...PLATE(), halfHeight: 0.21 }; h.frame();
  assert.equal(h.layers.filter(l => l.kind === 'quad').length, 1, 'a centimetre taller fits the same texture');
  assert.equal(quad.height, menuQuadLayout(plate).height / 2, 'the quad itself takes the new size');
  assert.equal(quadDraws(), 6, 'and the column is drawn again at it');
  plate = { ...PLATE(), halfHeight: 0.4 }; h.frame();
  assert.equal(h.layers.filter(l => l.kind === 'quad').length, 2, 'a new size makes a new texture');
  assert.equal(quad.destroyed, true);
  // The panel camera draws only into the quad, one eye.
  const lastQuad = h.log.filter(e => e[0] === 'renderer.renderBlended' && e[2] === 'panel');
  assert.ok(lastQuad.length >= 4);
});

test('a menu quad texture is kept through small changes in the column and remade for large ones', () => {
  const need = (w, h) => ({ viewPixelWidth: w, viewPixelHeight: h });
  const first = quadTextureSize(need(400, 640));
  assert.deepEqual(first, need(464, 720), 'made with headroom, in steps of 16');
  assert.equal(quadTextureSize(need(416, 672), first), first, 'growing into the headroom keeps it');
  assert.equal(quadTextureSize(need(400, 600), first), first, 'shrinking a little keeps it');
  assert.notEqual(quadTextureSize(need(400, 736), first), first, 'growing past it makes a new one');
  assert.notEqual(quadTextureSize(need(400, 560), first), first, 'a texture far larger than needed is remade smaller');
  // Never more than the cap, and never less than the column needs.
  assert.deepEqual(quadTextureSize(need(2048, 1024)), need(2048, 1152));
  assert.deepEqual(quadTextureSize(need(512, 256), undefined, 256), need(512, 256));
  // Any kept texture holds the column at the density asked for or above.
  for (let height = 400; height < 1200; height += 16) {
    const texture = quadTextureSize(need(400, height), first);
    assert.ok(texture.viewPixelHeight >= height && texture.viewPixelHeight <= height * QUAD_TEXTURE_SLACK);
  }
});

/** What the renderer was asked to draw, as `group camera`. */
const drawn = log => log.filter(e => e[0] === 'renderer.renderBlended').map(e => `${e[1]} ${e[2]}`);

test('in quad mode the column is drawn only into its quad and every other control only into the projection layer', () => {
  const h = harness({ target: 'quad', plate: PLATE });
  assert.equal(h.handles[0].separateMenuColumn, true, 'the presentation is asked for the column apart');
  h.frame();
  // The quad is not drawn on the frame it is made, so the whole scene stays
  // on the projection layer for that frame instead of the column vanishing.
  assert.deepEqual(drawn(h.log), ['presentation-scene left', 'presentation-scene right']);
  h.log.length = 0;
  h.frame();
  assert.deepEqual(drawn(h.log), ['other-controls left', 'other-controls right', 'menu-column panel']);
  // Nothing is masked out of either layer by where it falls on screen: no
  // raw draw call, no program of this module's own.
  assert.equal(h.log.filter(e => e[0] === 'gl.drawArrays' || e[0] === 'gl.useProgram' || e[0] === 'gl.createProgram').length, 0);
});

test('the projection target does not ask for the column apart', () => {
  const h = harness({ plate: PLATE });
  assert.equal(h.handles[0].separateMenuColumn, false);
  h.frame(); h.frame();
  assert.deepEqual(drawn(h.log), Array(2).fill(['presentation-scene left', 'presentation-scene right']).flat());
});

test('a presentation that cannot hand the column over apart keeps every control on the projection layer', () => {
  const h = harness({ target: 'quad', plate: PLATE, splits: false });
  h.frame(); h.frame();
  assert.equal(h.attached.facts().state, 'layered');
  assert.equal(h.layers.filter(l => l.kind === 'quad').length, 0, 'no quad is made for a column that cannot be drawn alone');
  assert.deepEqual(drawn(h.log), Array(2).fill(['presentation-scene left', 'presentation-scene right']).flat());
});

test('a control in front of the column puts the projection layer above the quad, and back below when it leaves', () => {
  // The glass faces +z at z -0.8; the eye looks at it from the origin side.
  let others = [];
  records.length = 0;
  const h = harness({ target: 'quad', plate: PLATE, others: () => others, eye: [0.1, 1.2, 0.3] });
  const order = () => h.log.filter(e => e[0] === 'stack.setOverlayLayers').at(-1)[1];
  h.frame(); h.frame();
  assert.deepEqual(order(), ['projection', 'quad'], 'the column is above the other controls by default');
  // A caption 0.3 m in front of the glass, over its outline. The canvas
  // camera here has scale 0.5 and an identity view, so scene units are
  // twice the room's.
  others = [{ center: [0.2, 2.4, -1.0], radius: 0.2 }];
  h.frame();
  assert.deepEqual(order(), ['quad', 'projection'], 'the caption is composited over the column it stands in front of');
  // The same caption behind the glass is covered by the column, as a nearer plate covers a farther one.
  others = [{ center: [0.2, 2.4, -2.4], radius: 0.2 }];
  h.frame();
  assert.deepEqual(order(), ['projection', 'quad']);
  // In front, but off to the side of the column's outline.
  others = [{ center: [2.2, 2.4, -1.0], radius: 0.2 }];
  h.frame();
  assert.deepEqual(order(), ['projection', 'quad']);
  // Both layers are still drawn in full, whichever is on top.
  h.log.length = 0; others = [{ center: [0.2, 2.4, -1.0], radius: 0.2 }]; h.bump(); h.frame();
  assert.deepEqual(drawn(h.log), ['other-controls left', 'other-controls right', 'menu-column panel']);
  // Each change of order is recorded once, so a headset log shows the rule at work.
  const orders = records.filter(r => r.kind === 'presentation-layer' && r.phase === 'layer-order').slice(-4).map(r => r.top);
  assert.deepEqual(orders, ['menu', 'controls', 'menu', 'controls']);
});

test('a control is in front of the menu only when it is nearer than the glass and over its outline', () => {
  const layout = menuQuadLayout(PLATE());
  const eye = [0.1, 1.2, 0.4];
  const hit = sphere => controlInFrontOfMenu(layout, eye, [sphere]);
  assert.equal(hit({ center: [0.1, 1.2, -0.5], radius: 0.05 }), true, 'straight in front of the centre');
  assert.equal(hit({ center: [0.1, 1.2, -0.79], radius: 0.05 }), false, 'within the column\'s own depth');
  assert.equal(hit({ center: [0.1, 1.2, -1.2], radius: 0.05 }), false, 'behind the glass');
  assert.equal(hit({ center: [0.1, 1.2, 0.6], radius: 0.05 }), false, 'behind the eye');
  assert.equal(hit({ center: [0.6, 1.2, -0.5], radius: 0.05 }), false, 'beside the outline');
  assert.equal(hit({ center: [0.3, 1.2, -0.5], radius: 0.15 }), true, 'its edge reaches the outline');
  // Halfway to the eye a control covers twice its own size of the glass.
  assert.equal(hit({ center: [0.1, 1.2 + 0.13, -0.2], radius: 0.01 }), false);
  assert.equal(hit({ center: [0.1, 1.2 + 0.10, -0.2], radius: 0.01 }), true);
  assert.equal(controlInFrontOfMenu(layout, undefined, [{ center: [0.1, 1.2, -0.5], radius: 0.05 }]), false, 'no eye, no answer');
  assert.equal(controlInFrontOfMenu(layout, [0.1, 1.2, -1.5], [{ center: [0.1, 1.2, -1.0], radius: 0.05 }]), false, 'an eye behind the glass');
});

test('a menu shown again stays on the projection layer until its quad is composited', () => {
  let plate = PLATE();
  const h = harness({ target: 'quad', plate: () => plate });
  const quadDraws = () => h.log.filter(e => e[0] === 'binding.getSubImage' && e[1] === 'quad').length;
  h.frame(); h.frame();
  assert.equal(quadDraws(), 1);
  // The toolbar hides itself: the quad leaves the overlays but is kept.
  plate = undefined; h.frame();
  assert.deepEqual(h.log.filter(e => e[0] === 'stack.setOverlayLayers').at(-1)[1], ['projection']);
  // Shown again: the quad is listed this frame and composited from the next,
  // so this frame the column is still drawn on the projection layer.
  plate = PLATE(); h.log.length = 0; h.frame();
  assert.deepEqual(h.log.filter(e => e[0] === 'stack.setOverlayLayers').map(e => e[1]), [['projection', 'quad']]);
  assert.deepEqual(drawn(h.log), ['presentation-scene left', 'presentation-scene right'], 'the column is not taken off the projection layer yet');
  assert.equal(quadDraws(), 0, 'the quad is not drawn before it is in the render state');
  h.log.length = 0; h.frame();
  assert.deepEqual(drawn(h.log), ['other-controls left', 'other-controls right', 'menu-column panel']);
  assert.equal(quadDraws(), 1);
  assert.deepEqual(h.log.filter(e => e[2] === 'outside-render-state'), []);
});

test('the projection layer and the menu quad each keep one depth buffer across redraws', () => {
  const h = harness({ target: 'quad', plate: PLATE });
  for (let i = 0; i < 6; i++) { h.bump(); h.frame(); }
  const quad = h.layers.find(l => l.kind === 'quad');
  assert.equal(h.log.filter(e => e[0] === 'binding.getSubImage' && e[1] === 'quad').length, 5, 'the quad is redrawn every frame after its first');
  const storage = h.log.filter(e => e[0] === 'gl.renderbufferStorage').map(e => [e[3], e[4]]);
  assert.deepEqual(storage, [[200, 50], [quad.init.viewPixelWidth, quad.init.viewPixelHeight]], 'one allocation per target size');
  const created = h.log.filter(e => e[0] === 'gl.createRenderbuffer').length;
  assert.equal(created, 2);
  h.log.length = 0;
  h.session.end();
  const deleted = h.log.filter(e => e[0] === 'gl.deleteRenderbuffer').map(e => e[1]);
  assert.equal(new Set(deleted).size, 2, 'both depth buffers deleted');
});

test('a cursor shown again is not painted before it is in the render state', () => {
  let aim = [0.05, 1.25, -0.794];
  const h = harness({ plate: PLATE, aim: () => aim });
  h.frame(); h.frame();
  const cursor = h.layers.find(l => l.kind === 'cursor');
  aim = undefined; h.frame();
  cursor.needsRedraw = true;
  aim = [0.05, 1.25, -0.794]; h.log.length = 0; h.frame();
  assert.equal(h.log.filter(e => e[0] === 'binding.getSubImage').length, 0);
  h.frame();
  assert.deepEqual(h.log.filter(e => e[0] === 'binding.getSubImage'), [['binding.getSubImage', 'cursor']]);
});

test('the cursor mark follows the aim point on its own static quad and leaves with it', () => {
  let aim = [0.05, 1.25, -0.794];
  const h = harness({ plate: PLATE, aim: () => aim });
  h.frame(); h.frame();
  const cursor = h.layers.find(l => l.kind === 'cursor');
  assert.equal(cursor.init.isStatic, true);
  assert.deepEqual([cursor.init.width, cursor.init.height], [CURSOR_METERS / 2, CURSOR_METERS / 2]);
  assert.deepEqual(cursor.transform.position, { x: 0.05, y: 1.25, z: -0.794 });
  assert.equal(h.log.filter(e => e[0] === 'binding.getSubImage' && e[1] === 'cursor').length, 1);
  aim = [0.06, 1.25, -0.794]; h.frame();
  assert.deepEqual(cursor.transform.position, { x: 0.06, y: 1.25, z: -0.794 });
  assert.equal(h.log.filter(e => e[0] === 'binding.getSubImage' && e[1] === 'cursor').length, 1, 'painted once');
  aim = undefined; h.frame();
  assert.deepEqual(h.log.filter(e => e[0] === 'stack.setOverlayLayers').at(-1)[1], ['projection']);
});

test('a menu folded to one control, with no glass, still gets a cursor facing as the panel does', () => {
  const aim = () => [0.05, 1.25, -0.794];
  const folded = harness({ aim, axes: () => ({ right: [1, 0, 0], up: [0, 1, 0], normal: [0, 0, -1] }) });
  folded.frame(); folded.frame();
  const cursor = folded.layers.find(l => l.kind === 'cursor');
  assert.ok(cursor, 'a cursor quad is made without menu glass');
  const full = harness({ plate: PLATE, aim });
  full.frame(); full.frame();
  assert.deepEqual(cursor.transform.orientation, full.layers.find(l => l.kind === 'cursor').transform.orientation);
  assert.deepEqual(cursor.transform.position, { x: 0.05, y: 1.25, z: -0.794 });
  assert.deepEqual(folded.log.filter(e => e[0] === 'stack.setOverlayLayers').at(-1)[1], ['projection', 'cursor']);
  assert.equal(folded.log.filter(e => e[0] === 'binding.getSubImage' && e[1] === 'cursor').length, 1, 'painted');
  // A turned panel turns the cursor with it.
  const turned = harness({ aim, axes: () => ({ right: [0, 0, 1], up: [0, 1, 0], normal: [1, 0, 0] }) });
  turned.frame();
  const { orientation } = turned.layers.find(l => l.kind === 'cursor').transform;
  assert.ok(Math.abs(Math.abs(orientation.y) - Math.SQRT1_2) < 1e-9 && Math.abs(Math.abs(orientation.w) - Math.SQRT1_2) < 1e-9);
});

test('with neither glass nor panel axes there is still no cursor, as before', () => {
  const h = harness({ aim: () => [0.05, 1.25, -0.794] });
  h.frame(); h.frame();
  assert.equal(h.layers.find(l => l.kind === 'cursor'), undefined);
});

function fakePointer(log) {
  return { external: false,
    setExternal(on) { this.external = on; log.push(['pointer.setExternal', on]); },
    drawExternal(renderer, camera) { log.push(['pointer.draw', camera.name ?? 'panel']); return true; } };
}

test('the pointer leaves the molecule pass and is drawn after the controls in each eye of their layer', () => {
  let p;
  const h = harness({ pointer: () => p });
  p = fakePointer(h.log);
  h.log.length = 0;
  h.frame();
  assert.equal(p.external, true);
  const order = h.log.filter(e => ['renderer.renderBlended', 'pointer.draw', 'pointer.setExternal', 'molecule'].includes(e[0]));
  assert.deepEqual(order, [['molecule', 'left'], ['molecule', 'right'], ['pointer.setExternal', true],
    ['renderer.renderBlended', 'presentation-scene', 'left'], ['pointer.draw', 'left'],
    ['renderer.renderBlended', 'presentation-scene', 'right'], ['pointer.draw', 'right']]);
  h.log.length = 0; h.frame();
  assert.equal(h.log.filter(e => e[0] === 'pointer.setExternal').length, 0, 'taken once');
  h.session.end();
  assert.equal(p.external, false, 'given back to the molecule pass when the layers go');
});

test('a controls layer that fails gives the pointer back to the molecule pass', () => {
  let p;
  const h = harness({ pointer: () => p, failOn: 'update' });
  p = fakePointer(h.log);
  h.frame();
  assert.equal(h.attached.facts().state, 'stock');
  assert.equal(p.external, false);
  assert.deepEqual(h.log.filter(e => e[0] === 'pointer.setExternal').map(e => e[1]), [true, false]);
});

test('the quad target draws the pointer with the other controls, never on the menu quad', () => {
  let p;
  const h = harness({ target: 'quad', plate: PLATE, pointer: () => p });
  p = fakePointer(h.log);
  h.frame(); h.log.length = 0; h.frame();
  const order = h.log.filter(e => e[0] === 'renderer.renderBlended' || e[0] === 'pointer.draw').map(e => `${e[0] === 'pointer.draw' ? 'pointer' : e[1]}:${e[0] === 'pointer.draw' ? e[1] : e[2]}`);
  assert.deepEqual(order, ['other-controls:left', 'pointer:left', 'other-controls:right', 'pointer:right', 'menu-column:panel']);
});

test('without a layer stack the pointer is never asked for, so it stays in the molecule pass', () => {
  let asked = 0;
  const result = attachPresentationLayers({ stack: null, getPointer: () => { asked++; return {}; } });
  assert.equal(result.facts().state, 'stock');
  assert.equal(asked, 0);
});

test('a projection layer with no texture for three frames in a row hands the controls back', () => {
  const blank = {};
  records.length = 0;
  const h = harness({ blank });
  h.frame();
  blank.projection = true;
  h.frame(); h.frame();
  assert.equal(h.attached.facts().state, 'layered', 'two blank frames are a glitch');
  blank.projection = false; h.frame();
  blank.projection = true; h.frame(); h.frame();
  assert.equal(h.attached.facts().state, 'layered', 'a drawn frame starts the count again');
  h.frame();
  assert.equal(h.attached.facts().state, 'stock');
  assert.match(h.attached.facts().error, /projection layer had nothing to draw into for 3 frames/);
  assert.ok(h.handles[0].released, 'the controls are back in the molecule pass');
  assert.deepEqual(records.filter(r => r.phase === 'blank').map(r => [r.layer, r.why]), [['projection', 'no-texture'], ['projection', 'no-texture']],
    'recorded once per run of blank frames');
});

test('a menu quad with no texture to draw the column into for three frames in a row hands the controls back', () => {
  const blank = {};
  const h = harness({ target: 'quad', plate: PLATE, blank });
  h.frame();
  blank.quad = true;
  h.frame(); h.frame();
  assert.equal(h.attached.facts().state, 'layered');
  h.frame();
  assert.equal(h.attached.facts().state, 'stock');
  assert.match(h.attached.facts().error, /quad layer had nothing to draw into for 3 frames in a row \(no-texture\)/);
  assert.ok(h.layers.filter(l => l.kind === 'quad').every(l => l.destroyed));
});

test('a menu quad that needs no redraw is not counted as blank', () => {
  const blank = {};
  const h = harness({ target: 'quad', plate: PLATE, blank });
  h.frame(); h.frame();
  blank.quad = true;
  for (let i = 0; i < 6; i++) h.frame();
  assert.equal(h.attached.facts().state, 'layered', 'nothing asked the quad for a texture');
});

test('session end puts everything back: overlays, layers, GL objects, draw pass and the menu', () => {
  const h = harness({ target: 'quad', plate: PLATE, aim: () => [0, 1.2, -0.79] });
  h.frame(); h.frame();
  assert.ok(Object.prototype.hasOwnProperty.call(h.drawPass, 'render'));
  h.log.length = 0;
  h.session.end();
  assert.equal(h.unsubscribed, 1);
  assert.deepEqual(h.log.filter(e => e[0] === 'stack.setOverlayLayers').map(e => e[1]), [[]]);
  assert.ok(h.layers.every(layer => layer.destroyed), 'every layer destroyed');
  assert.ok(names(h.log).includes('gl.deleteFramebuffer') && names(h.log).includes('gl.deleteRenderbuffer'));
  assert.equal(Object.prototype.hasOwnProperty.call(h.drawPass, 'render'), false, 'draw pass restored');
  assert.equal(h.handles[0].released, true, 'controls handed back');
  assert.equal(h.attached.facts().state, 'ended');
  h.log.length = 0;
  h.attached.dispose();
  h.frame();
  assert.equal(h.log.filter(e => e[0].startsWith('renderer.renderBlended')).length, 0, 'nothing after the end');
});

test('a frame that fails hands the controls back to the molecule pass', () => {
  const h = harness({ failOn: 'update' });
  h.frame();
  assert.equal(h.handles[0].released, true);
  assert.equal(h.attached.facts().state, 'stock');
  assert.match(h.attached.facts().error, /boom/);
  // The molecule's framebuffer is bound again after the failed draw.
  assert.equal(h.gl.getParameter('DRAW_FRAMEBUFFER_BINDING'), 'molecule-fb');
});

test('without a layer stack nothing is taken from the molecule pass', () => {
  let asked = false;
  const result = attachPresentationLayers({ stack: null, presentation: { useExternalDraw() { asked = true; } } });
  assert.equal(asked, false);
  assert.equal(result.facts().state, 'stock');
  assert.equal(result.facts().reason, 'no-layer-stack');
  result.dispose();
});

test('a refused projection layer leaves the stock path in place', () => {
  const log = [];
  const gl = fakeGl(log);
  let asked = false;
  const result = attachPresentationLayers({
    stack: { gl, session: {}, binding: { createProjectionLayer() { throw Error('no layers'); }, getViewSubImage() {} },
      setOverlayLayers() {}, onAfterMolecularFrame() {} },
    presentation: { useExternalDraw() { asked = true; } }, canvas: { webgl: { gl, state: {} } }, drawPass: { render() {} } });
  assert.equal(asked, false);
  assert.match(result.facts().reason, /projection-layer-refused/);
});

test('a lost context hands the controls back without touching dead GL objects', () => {
  const h = harness();
  h.frame();
  h.log.length = 0;
  h.log.lost = true;
  h.frame();
  assert.equal(h.attached.facts().state, 'stock');
  assert.equal(h.handles[0].released, true);
  assert.equal(h.log.filter(e => e[0].startsWith('gl.delete')).length, 0);
  assert.equal(h.log.filter(e => e[0] === 'renderer.renderBlended').length, 0);
});

/** A still of the left eye, 48 by 24, in a framebuffer of the capture's own. */
const STILL = () => ({ view: { eye: 'left', projectionMatrix: IDENTITY, transform: { inverse: { matrix: IDENTITY } } },
  framebuffer: 'still-fb', width: 48, height: 24 });
/** The framebuffer each raw draw of the log went into. */
function rawDraws(log) {
  let bound = 'molecule-fb';
  const draws = [];
  for (const entry of log) {
    if (entry[0] === 'gl.bindFramebuffer' && (entry[1] === 'DRAW_FRAMEBUFFER' || entry[1] === 'FRAMEBUFFER')) bound = entry[2];
    if (entry[0] === 'gl.drawArrays') draws.push(bound);
  }
  return draws;
}

test('a still of the wearer\'s view gets the controls layer blended over it', () => {
  const h = harness({ plate: PLATE });
  assert.equal(typeof h.painter, 'function', 'the layers offer themselves to a capture');
  assert.equal(h.painter(STILL()), false, 'nothing is drawn before the layer has a frame');
  h.frame();
  h.log.length = 0;
  assert.equal(h.painter(STILL()), true);
  // The left eye's rectangle of the layer texture is scaled to the still,
  // through a blit: the browser's texture is attached, never sampled.
  const attached = h.log.filter(e => e[0] === 'gl.framebufferTexture2D' && e[4] === 'ui-texture');
  assert.equal(attached.length, 1);
  assert.equal(attached[0][1], 'READ_FRAMEBUFFER');
  assert.deepEqual(h.log.find(e => e[0] === 'gl.blitFramebuffer').slice(1, 9), [0, 0, 100, 50, 0, 0, 48, 24]);
  assert.equal(h.log.filter(e => e[0] === 'gl.bindTexture' && e[2] === 'ui-texture').length, 0);
  // One premultiplied blend into the still, over its whole area.
  assert.deepEqual(rawDraws(h.log), ['still-fb']);
  assert.ok(h.log.some(e => e[0] === 'state.blendFunc' && e[1] === 'ONE' && e[2] === 'ONE_MINUS_SRC_ALPHA'));
  assert.ok(h.log.some(e => e[0] === 'state.viewport' && e[1] === 0 && e[2] === 0 && e[3] === 48 && e[4] === 24));
  // The right eye is taken when the still shows that eye.
  h.log.length = 0;
  assert.equal(h.painter({ ...STILL(), view: { ...STILL().view, eye: 'right' } }), true);
  assert.deepEqual(h.log.find(e => e[0] === 'gl.blitFramebuffer').slice(1, 5), [100, 0, 200, 50]);
  // GL is handed back as it was found, and Mol*'s program cache is told.
  assert.deepEqual(h.log.filter(e => e[0] === 'gl.useProgram').at(-1), ['gl.useProgram', 'mol-program']);
  assert.deepEqual(h.log.filter(e => e[0] === 'gl.bindVertexArray').at(-1), ['gl.bindVertexArray', 'mol-vao']);
  assert.deepEqual(h.log.filter(e => e[0] === 'gl.bindFramebuffer').slice(-2).map(e => e[2]), ['molecule-fb', 'molecule-fb']);
  assert.equal(h.stack.gl && h.attached.facts().state, 'layered');
  // The molecule's frame is untouched: nothing was drawn by the renderer for a projection still.
  assert.equal(h.log.filter(e => e[0] === 'renderer.renderBlended').length, 0);
});

test('a frame Mol* did not draw leaves nothing for a still to show', () => {
  const h = harness({ plate: PLATE });
  h.frame();
  h.frame({ molecule: false });
  h.log.length = 0;
  assert.equal(h.painter(STILL()), false);
  assert.equal(h.log.filter(e => e[0].startsWith('gl.')).length, 0, 'no GL call at all');
});

test('in quad mode a still gets the column drawn again and placed as its quad, in the compositor\'s order', () => {
  let others = [];
  const h = harness({ target: 'quad', plate: PLATE, others: () => others, eye: [0.1, 1.2, 0.3] });
  h.frame(); h.frame();
  h.log.length = 0;
  assert.equal(h.painter(STILL()), true);
  // The column is drawn once more, by the renderer, from the menu's own seat
  // into a texture of the capture's own; the quad layer's texture is not read.
  assert.deepEqual(drawn(h.log), ['menu-column panel']);
  assert.equal(h.log.filter(e => e[0] === 'binding.getSubImage').length, 0);
  assert.equal(h.log.filter(e => e.includes('quad-texture')).length, 0);
  const layout = menuQuadLayout(PLATE());
  const storage = h.log.find(e => e[0] === 'gl.texStorage2D' && e[4] === layout.viewPixelWidth);
  assert.ok(storage && storage[5] === layout.viewPixelHeight && storage[2] > 1, 'a mipmapped texture the size of the quad\'s');
  // Both layers go into the still: the other controls first, the column over them.
  assert.deepEqual(rawDraws(h.log), ['still-fb', 'still-fb']);
  const placed = h.log.filter(e => e[0] === 'gl.uniformMatrix4fv').map(e => Array.from(e[3]));
  assert.deepEqual(placed[0], IDENTITY, 'the projection layer covers the still');
  const expected = menuQuadInView(layout, STILL().view);
  assert.ok(placed[1].every((v, i) => Math.abs(v - expected[i]) < 1e-6), 'the column sits where its quad does');
  assert.ok(h.log.some(e => e[0] === 'gl.generateMipmap'));
  // With a caption in front of the column the compositor puts the projection
  // layer on top, and so does the still.
  others = [{ center: [0.2, 2.4, -1.0], radius: 0.2 }];
  h.frame(); h.log.length = 0;
  assert.equal(h.painter(STILL()), true);
  const order = h.log.filter(e => e[0] === 'gl.uniformMatrix4fv').map(e => Array.from(e[3]).every((v, i) => v === IDENTITY[i]) ? 'controls' : 'column');
  assert.deepEqual(order, ['column', 'controls']);
  // A view that cannot place the quad says the still is incomplete.
  assert.equal(h.painter({ ...STILL(), view: { eye: 'left' } }), false);
});

test('the menu quad is placed in a view by its glass, and never cut by the view\'s depth planes', () => {
  const layout = menuQuadLayout(PLATE());
  // A view at the origin looking down -z, with a far plane nearer than the menu.
  const near = 0.1, far = 0.5;
  const projection = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -(far + near) / (far - near), -1, 0, 0, -2 * far * near / (far - near), 0];
  const mvp = menuQuadInView(layout, { projectionMatrix: projection, transform: { inverse: { matrix: IDENTITY } } });
  const corner = (x, y) => [0, 1, 2, 3].map(r => mvp[r] * x + mvp[4 + r] * y + mvp[12 + r]);
  const [cx, cy, cz, cw] = corner(1, 1);
  // The top-right corner of the glass, 0.8 m in front of the eye.
  assert.ok(Math.abs(cw - 0.8) < 1e-9);
  assert.ok(Math.abs(cx / cw - (0.1 + layout.halfWidth) / 0.8) < 1e-9 && Math.abs(cy / cw - (1.2 + layout.halfHeight) / 0.8) < 1e-9);
  assert.equal(cz, 0, 'depth is flattened, so the far plane cannot clip it');
  assert.equal(menuQuadInView(layout, { eye: 'left' }), undefined);
});

test('session end stops offering the layers to a capture and frees what a still used', () => {
  const h = harness({ target: 'quad', plate: PLATE });
  h.frame(); h.frame();
  h.painter(STILL());
  const painter = h.painter;
  h.log.length = 0;
  h.session.end();
  assert.equal(h.painter, undefined);
  assert.equal(painter(STILL()), false);
  assert.ok(names(h.log).includes('gl.deleteProgram') && names(h.log).includes('gl.deleteTexture'));
});

test('when the molecule\'s layer is given up the controls go back into the molecule\'s pass', () => {
  const h = harness({ target: 'quad', plate: PLATE, aim: () => [0, 1.2, -0.79] });
  h.frame(); h.frame();
  assert.equal(typeof h.retire, 'function', 'the layers listen for the hand-back');
  h.log.length = 0;
  h.retire('no-texture');
  // The stock base layer shows only what the molecule's pass draws, so the
  // controls are handed back to it and every layer of their own is let go.
  assert.equal(h.handles[0].released, true);
  assert.ok(h.layers.every(layer => layer.destroyed));
  assert.equal(Object.prototype.hasOwnProperty.call(h.drawPass, 'render'), false, 'draw pass restored');
  assert.equal(h.attached.facts().state, 'stock');
  assert.deepEqual(records.filter(r => r.kind === 'presentation-layer' && r.phase === 'detached').at(-1).reason, 'molecule-layer-retired');
  assert.equal(h.retire, undefined);
  assert.equal(h.painter, undefined, 'a capture reads the stock layer, which holds the controls again');
  h.log.length = 0;
  h.frame();
  assert.equal(h.log.filter(e => e[0] === 'renderer.renderBlended').length, 0, 'nothing more is drawn into a layer');
});

/** A view matrix for a head turned `degrees` about the vertical, at the origin. */
function yawView(degrees) {
  const a = degrees * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  // The transpose of the head's rotation: world into head.
  return [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, 0, 0, 0, 1];
}
const direction = light => {
  const i = light.inclination * Math.PI / 180, a = light.azimuth * Math.PI / 180;
  return [Math.cos(a) * Math.sin(i), Math.sin(a) * Math.sin(i), Math.cos(i)];
};
const KEY = { inclination: 150, azimuth: 320, color: 0xfff6ea, intensity: 0.95 };

test('lights are turned from the head\'s frame into the drawing camera\'s, and nothing else about them changes', () => {
  // The same camera: nothing to turn.
  const [same] = lightsSeenFrom([KEY], yawView(20), yawView(20));
  assert.ok(Math.abs(same.inclination - 150) < 1e-9 && Math.abs(same.azimuth - 320) < 1e-9);
  assert.equal(same.color, KEY.color); assert.equal(same.intensity, KEY.intensity);
  // A drawing camera turned 29 degrees from the head sees every light turned
  // back by as much: the light keeps its direction in the world.
  const [turned] = lightsSeenFrom([KEY], yawView(29), yawView(0));
  const before = direction(KEY), after = direction(turned);
  const view = yawView(29);
  const expected = [0, 1, 2].map(row => view[row] * before[0] + view[4 + row] * before[1] + view[8 + row] * before[2]);
  assert.ok(after.every((v, i) => Math.abs(v - expected[i]) < 1e-9));
  // A surface square to the drawing camera then takes the light it takes in
  // the head's frame, where it is turned 29 degrees: the dot products agree.
  // (The camera's own z axis, written in the head's frame, is the third row of its view.)
  const normalInCamera = [0, 0, 1], normalInHead = [view[2], view[6], view[10]];
  const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  assert.ok(Math.abs(dot3(normalInCamera, after) - dot3(normalInHead, before)) < 1e-9);
  assert.ok(Math.abs(dot3(normalInCamera, after) - dot3(normalInCamera, before)) > 0.1, 'and not the light it would take head on');
  assert.ok(turned.azimuth >= 0 && turned.azimuth < 360);
  // Several lights, each turned.
  assert.equal(lightsSeenFrom([KEY, { ...KEY, inclination: 36, azimuth: 290 }], yawView(10), yawView(0)).length, 2);
});

test('the angle between two views is the turn between their orientations', () => {
  assert.ok(Math.abs(viewTurnDegrees(yawView(12), yawView(5)) - 7) < 1e-6);
  assert.equal(viewTurnDegrees(IDENTITY, IDENTITY), 0);
  assert.equal(viewTurnDegrees(IDENTITY, undefined), Infinity);
});

test('the menu quad is drawn with the lights turned for its window camera, and they are put back', () => {
  const rig = [KEY];
  const h = harness({ target: 'quad', plate: PLATE, lights: rig });
  h.frame(); h.frame();
  const blends = h.log.filter(e => e[0] === 'renderer.renderBlended');
  // The projection layer is drawn by the eye cameras with the renderer's own lights.
  for (const eye of blends.filter(e => e[2] !== 'panel')) assert.equal(eye[3], rig);
  // The column is drawn with lights turned for the window camera.
  const panel = blends.find(e => e[2] === 'panel');
  assert.notEqual(panel[3], rig);
  const camera = menuPanelCamera(menuQuadLayout(PLATE()), { view: IDENTITY, scale: 0.5, state: {} }, { x: 0, y: 0, width: 1, height: 1 });
  assert.deepEqual(panel[3], lightsSeenFrom(rig, camera.view, IDENTITY));
  assert.equal(h.renderer.props.light, rig, 'the renderer has its own lights back');
  assert.deepEqual(h.log.filter(e => e[0] === 'renderer.setProps').map(e => e[1] === rig), [false, true]);
  // A still of the column is lit the same way.
  h.log.length = 0;
  h.painter(STILL());
  assert.deepEqual(h.log.filter(e => e[0] === 'renderer.setProps').map(e => e[1] === rig), [false, true]);
});

test('the menu quad is drawn again when the head has turned, so its shade follows the head as it does in the eye', () => {
  const h = harness({ target: 'quad', plate: PLATE, lights: [KEY] });
  const quadDraws = () => h.log.filter(e => e[0] === 'binding.getSubImage' && e[1] === 'quad').length;
  h.frame(); h.frame();
  assert.equal(quadDraws(), 1);
  h.stereo.left.view = yawView(MENU_RELIGHT_DEGREES - 1); h.frame();
  assert.equal(quadDraws(), 1, 'a small turn leaves the quad as drawn');
  h.stereo.left.view = yawView(MENU_RELIGHT_DEGREES + 1); h.frame();
  assert.equal(quadDraws(), 2, 'a turn past the threshold relights it');
  const relit = h.log.filter(e => e[0] === 'renderer.renderBlended' && e[2] === 'panel').at(-1);
  const camera = menuPanelCamera(menuQuadLayout(PLATE()), { view: IDENTITY, scale: 0.5, state: {} }, { x: 0, y: 0, width: 1, height: 1 });
  assert.deepEqual(relit[3], lightsSeenFrom([KEY], camera.view, yawView(MENU_RELIGHT_DEGREES + 1)));
  h.frame(); h.frame();
  assert.equal(quadDraws(), 2, 'and a head that stays there costs nothing more');
});

test('the controls\' projection layer is drawn multisampled into its own texture where the browser can resolve it', () => {
  const h = harness({ target: 'quad', plate: PLATE_IN_VIEW, msrtt: true });
  h.frame(); h.frame(); h.frame();
  // The layer's texture is attached through the extension on every frame,
  // with depth carrying the same samples. No second colour buffer, no blit.
  const attaches = h.log.filter(e => e[0] === 'ext.framebufferTexture2DMultisampleEXT');
  assert.equal(attaches.length, 3);
  assert.deepEqual(attaches[0].slice(1), ['FRAMEBUFFER', 'COLOR_ATTACHMENT0', 'TEXTURE_2D', 'ui-texture', 0, CONTROLS_LAYER_SAMPLES]);
  assert.deepEqual(h.log.filter(e => e[0] === 'ext.renderbufferStorageMultisampleEXT').map(e => e.slice(1)),
    [['RENDERBUFFER', CONTROLS_LAYER_SAMPLES, 'DEPTH_COMPONENT24', 200, 50]], 'one multisampled depth buffer, sized once');
  assert.equal(h.log.filter(e => e[0] === 'gl.framebufferTexture2D' && e[1] === 'FRAMEBUFFER' && e[4] === 'ui-texture').length, 0,
    'the texture is never also attached single-sampled for drawing');
  assert.equal(h.log.filter(e => e[0] === 'gl.renderbufferStorageMultisample').length, 0);
  assert.deepEqual(records.filter(r => r.kind === 'presentation-layer' && r.phase === 'antialias').at(-1).samples, CONTROLS_LAYER_SAMPLES);
  assert.equal(records.filter(r => r.kind === 'presentation-layer' && r.phase === 'attached').at(-1).samples, CONTROLS_LAYER_SAMPLES);
  // The framebuffer is checked once, not every frame.
  assert.equal(h.log.filter(e => e[0] === 'gl.checkFramebufferStatus').length, 0, 'the stand-in logs no status call');
  // The menu quad is resampled by the compositor and stays single-sampled.
  const quadAttach = h.log.filter(e => e[0] === 'gl.framebufferTexture2D' && e[4] === 'quad-texture');
  assert.ok(quadAttach.length >= 1);
  assert.equal(h.attached.facts().state, 'layered');
});

test('the read-back copies the layer texture out of a single-sampled framebuffer of its own, after the draw let go of it', () => {
  const h = harness({ plate: PLATE_IN_VIEW, msrtt: true });
  h.frame();
  const index = name => h.log.findIndex(e => e[0] === name);
  const detach = h.log.findIndex(e => e[0] === 'gl.framebufferTexture2D' && e[1] === 'FRAMEBUFFER' && e[4] === null);
  const plain = h.log.findIndex(e => e[0] === 'gl.framebufferTexture2D' && e[1] === 'READ_FRAMEBUFFER' && e[4] === 'ui-texture');
  assert.ok(detach >= 0 && plain > detach, 'the multisampled attachment is let go before the copy attaches the texture');
  assert.ok(index('gl.blitFramebuffer') > plain);
  const released = h.log.findIndex((e, i) => i > plain && e[0] === 'gl.framebufferTexture2D' && e[1] === 'READ_FRAMEBUFFER' && e[4] === null);
  assert.ok(released > index('gl.blitFramebuffer'), 'and the copy lets go of it too');
  h.frame(); h.frame();
  assert.ok(phases().includes('verified'));
});

test('a browser that offers multisampled render-to-texture and will not complete the framebuffer gets the layer single-sampled', () => {
  const before = records.length;
  const h = harness({ plate: PLATE_IN_VIEW, msrtt: 'refused' });
  h.frame(); h.frame();
  const own = records.slice(before).filter(r => r.kind === 'presentation-layer');
  assert.deepEqual(own.filter(r => r.phase === 'antialias').map(r => [r.samples, r.refused]), [[0, 'FRAMEBUFFER_INCOMPLETE_MULTISAMPLE']]);
  assert.equal(h.log.filter(e => e[0] === 'ext.framebufferTexture2DMultisampleEXT').length, 1, 'tried once');
  // From then on the texture is attached the plain way, with a plain depth buffer.
  assert.equal(h.log.filter(e => e[0] === 'gl.framebufferTexture2D' && e[1] === 'FRAMEBUFFER' && e[4] === 'ui-texture').length, 2);
  assert.deepEqual(h.log.filter(e => e[0] === 'gl.renderbufferStorage' && e[2] === 'DEPTH_COMPONENT24').map(e => [e[3], e[4]]), [[200, 50]]);
  // The controls stay on their layer: nothing failed, and both frames drew.
  assert.equal(h.attached.facts().state, 'layered');
  assert.equal(own.filter(r => r.phase === 'failed').length, 0);
  assert.equal(h.log.filter(e => e[0] === 'renderer.renderBlended').length, 4);
  assert.deepEqual(own.find(r => r.phase === 'first-frame').framebuffer, { layer: 'projection', status: 'FRAMEBUFFER_COMPLETE',
    colorAttachment: 'TEXTURE', attachError: 'NO_ERROR', drawError: 'NO_ERROR' }, 'the first frame\'s check is clean: the refusal\'s error is not the draw\'s');
});

test('without the extension the layer is drawn exactly as before', () => {
  const h = harness({ plate: PLATE_IN_VIEW });
  h.frame();
  assert.equal(h.log.filter(e => e[0].startsWith('ext.')).length, 0);
  assert.equal(h.log.filter(e => e[0] === 'gl.framebufferTexture2D' && e[1] === 'FRAMEBUFFER' && e[4] === 'ui-texture').length, 1);
  assert.equal(records.filter(r => r.kind === 'presentation-layer' && r.phase === 'attached').at(-1).samples, 0);
});

test('a multisampled layer that reads back empty is tried single-sampled before the controls are handed back', () => {
  const before = records.length;
  const h = harness({ plate: PLATE_IN_VIEW, msrtt: true });
  h.log.pixels = 'empty';
  for (let i = 0; i < 4; i++) h.frame();
  const own = () => records.slice(before).filter(r => r.kind === 'presentation-layer');
  // The first empty read-back gives the samples up and costs the layer nothing.
  assert.deepEqual(own().filter(r => r.phase === 'antialias').map(r => [r.samples, r.refused ?? null]), [[4, null], [0, 'empty-readback']]);
  assert.equal(own().filter(r => r.phase === 'empty-readback').length, 0);
  assert.equal(h.attached.facts().state, 'layered');
  // Drawn single-sampled, the layer has pixels: it is verified and stays.
  h.log.pixels = undefined;
  h.log.length = 0;
  for (let i = 0; i < 4; i++) h.frame();
  assert.equal(h.log.filter(e => e[0] === 'ext.framebufferTexture2DMultisampleEXT').length, 0);
  assert.equal(h.log.filter(e => e[0] === 'gl.framebufferTexture2D' && e[1] === 'FRAMEBUFFER' && e[4] === 'ui-texture').length, 4);
  assert.ok(own().some(r => r.phase === 'verified'));
  assert.equal(h.attached.facts().state, 'layered');
});

test('a multisampled draw that raises a GL error is drawn single-sampled from the next frame', () => {
  const before = records.length;
  const h = harness({ target: 'quad', plate: PLATE, msrtt: true });
  h.log.drawFails = true;
  h.frame(); h.frame(); h.frame();
  const own = records.slice(before).filter(r => r.kind === 'presentation-layer');
  assert.deepEqual(own.filter(r => r.phase === 'antialias').map(r => [r.samples, r.refused ?? null]),
    [[4, null], [0, 'INVALID_FRAMEBUFFER_OPERATION']]);
  assert.equal(h.log.filter(e => e[0] === 'ext.framebufferTexture2DMultisampleEXT').length, 1, 'one multisampled frame, then none');
  assert.equal(h.log.filter(e => e[0] === 'gl.framebufferTexture2D' && e[1] === 'FRAMEBUFFER' && e[4] === 'ui-texture').length, 2);
  assert.equal(h.attached.facts().state, 'layered', 'the controls keep their layer');
});
