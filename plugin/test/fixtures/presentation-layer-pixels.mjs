import { Renderer } from 'molstar/lib/mol-gl/renderer.js';
import { Scene } from 'molstar/lib/mol-gl/scene.js';
import { createContext } from 'molstar/lib/mol-gl/webgl/context.js';
import { createRenderObject } from 'molstar/lib/mol-gl/render-object.js';
import { DrawPass } from 'molstar/lib/mol-canvas3d/passes/draw.js';
import { Camera } from 'molstar/lib/mol-canvas3d/camera.js';
import { StereoCamera } from 'molstar/lib/mol-canvas3d/camera/stereo.js';
import { DebugRegistry } from 'molstar/lib/mol-canvas3d/helper/debug-registry.js';
import { PostprocessingParams } from 'molstar/lib/mol-canvas3d/passes/postprocessing.js';
import { MarkingParams } from 'molstar/lib/mol-canvas3d/passes/marking.js';
import { Text } from 'molstar/lib/mol-geo/geometry/text/text.js';
import { TextBuilder } from 'molstar/lib/mol-geo/geometry/text/text-builder.js';
import { Mesh } from 'molstar/lib/mol-geo/geometry/mesh/mesh.js';
import { MeshBuilder } from 'molstar/lib/mol-geo/geometry/mesh/mesh-builder.js';
import { Box } from 'molstar/lib/mol-geo/primitive/box.js';
import { Sphere } from 'molstar/lib/mol-geo/primitive/sphere.js';
import { Mat4 } from 'molstar/lib/mol-math/linear-algebra.js';
import { ParamDefinition as PD } from 'molstar/lib/mol-util/param-definition.js';
import { AssetManager } from 'molstar/lib/mol-util/assets.js';
import { createPresentationScene } from '../../../lab/browser-roundtrip/presentation-scene.mjs';
import { attachPresentationLayers, menuQuadLayout, menuPanelCamera } from '../../../lab/browser-roundtrip/presentation-layer.mjs';
import { PointerHelper } from 'molstar/lib/mol-canvas3d/helper/pointer-helper.js';
import { attachXrPointerHelper } from '../../../lab/browser-roundtrip/xr-pointer.mjs';

// The headset's control layer, drawn two ways with the same stereo camera:
// the stock way, inside the molecule's pass with the mid-pass depth clear,
// and through the layer drawer into a texture of its own, which is then
// composited over the molecule-only frame the way an XR compositor blends a
// premultiplied layer. No downloads, no device.
const W = 480, H = 240;
/** Channel levels two 8-bit blends of the same pixel may differ by. */
const ROUNDING = 3;

function box(center, size, color, alpha, ignoreLight = false) {
  const state = MeshBuilder.createState(); state.currentGroup = 0;
  const transform = Mat4.fromScaling(Mat4(), size);
  transform[12] = center[0]; transform[13] = center[1]; transform[14] = center[2];
  MeshBuilder.addPrimitive(state, transform, Box());
  const props = { ...PD.getDefaultValues(Mesh.Params), alpha, doubleSided: true, ignoreLight };
  return createRenderObject('mesh', Mesh.Utils.createValuesSimple(MeshBuilder.getMesh(state), props, color, 1),
    Mesh.Utils.createRenderableState(props), -1);
}

function ball(center, radius, color) {
  const state = MeshBuilder.createState(); state.currentGroup = 0;
  const transform = Mat4.fromUniformScaling(Mat4(), radius);
  transform[12] = center[0]; transform[13] = center[1]; transform[14] = center[2];
  MeshBuilder.addPrimitive(state, transform, Sphere(3));
  const props = { ...PD.getDefaultValues(Mesh.Params) };
  return createRenderObject('mesh', Mesh.Utils.createValuesSimple(MeshBuilder.getMesh(state), props, color, 1),
    Mesh.Utils.createRenderableState(props), -1);
}

function label(text, at, size, color) {
  const props = { ...PD.getDefaultValues(Text.Params), sizeFactor: 1, background: false, fontQuality: 3, attachment: 'middle-center' };
  const builder = TextBuilder.create(props);
  builder.add(text, at[0], at[1], at[2], 0, size, 0);
  return createRenderObject('text', Text.Utils.createValuesSimple(builder.getText(), props, color, 1),
    Text.Utils.createRenderableState(props), -1);
}

function readTexture(gl, texture, width, height) {
  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  const pixels = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(framebuffer);
  return pixels;
}

const textureSizes = new WeakMap();
function makeTexture(gl, width, height) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
  gl.bindTexture(gl.TEXTURE_2D, null);
  textureSizes.set(texture, [width, height]);
  return texture;
}

/**
 * Give a desktop context `WEBGL_multisampled_render_to_texture`, which only a
 * headset browser has, so the drawer's multisampled path rasterises here too.
 *
 * A texture attached through it is backed by a multisampled colour buffer for
 * as long as it is attached, and the samples are resolved into the texture
 * when it is detached, which is when a tiled GPU stores them. This stands in
 * for the extension's effect on pixels. It says nothing about its cost, or
 * about whether a headset browser takes a layer's texture this way.
 */
function emulateMultisampledRenderToTexture(gl) {
  const held = new Map();
  const plainAttach = gl.framebufferTexture2D.bind(gl), getExtension = gl.getExtension.bind(gl);
  const calls = { attaches: 0, resolves: 0 };
  const extension = {
    renderbufferStorageMultisampleEXT: (target, samples, format, width, height) =>
      gl.renderbufferStorageMultisample(target, samples, format, width, height),
    framebufferTexture2DMultisampleEXT(target, attachment, textarget, texture, level, samples) {
      const framebuffer = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING), [width, height] = textureSizes.get(texture);
      const colour = gl.createRenderbuffer(), bound = gl.getParameter(gl.RENDERBUFFER_BINDING);
      gl.bindRenderbuffer(gl.RENDERBUFFER, colour);
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA8, width, height);
      gl.bindRenderbuffer(gl.RENDERBUFFER, bound);
      gl.framebufferRenderbuffer(target, attachment, gl.RENDERBUFFER, colour);
      held.set(framebuffer, { texture, colour, width, height });
      calls.attaches++;
    },
  };
  gl.framebufferTexture2D = (target, attachment, textarget, texture, level) => {
    const framebuffer = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
    const backing = target === gl.FRAMEBUFFER && attachment === gl.COLOR_ATTACHMENT0 && texture === null ? held.get(framebuffer) : undefined;
    if (!backing) return plainAttach(target, attachment, textarget, texture, level);
    held.delete(framebuffer);
    const resolve = gl.createFramebuffer(), read = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING), scissor = gl.isEnabled(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, framebuffer);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, resolve);
    plainAttach(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, backing.texture, 0);
    if (scissor) gl.disable(gl.SCISSOR_TEST);
    gl.blitFramebuffer(0, 0, backing.width, backing.height, 0, 0, backing.width, backing.height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    if (scissor) gl.enable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, framebuffer);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, read);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, null);
    gl.deleteFramebuffer(resolve); gl.deleteRenderbuffer(backing.colour);
    calls.resolves++;
  };
  // To GL the attachment is still the texture, as it is with the real extension.
  const attachmentParameter = gl.getFramebufferAttachmentParameter.bind(gl);
  gl.getFramebufferAttachmentParameter = (target, attachment, name) =>
    (attachment === gl.COLOR_ATTACHMENT0 && name === gl.FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE && held.has(gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING))
      ? gl.TEXTURE : attachmentParameter(target, attachment, name));
  gl.getExtension = name => (name === 'WEBGL_multisampled_render_to_texture' ? extension : getExtension(name));
  return calls;
}

/** Rows of RGBA pixels (bottom-up, as GL reads them) side by side as one PNG data URL. */
function sheet(panels) {
  const width = panels.reduce((sum, p) => sum + p.width + 8, 0), height = Math.max(...panels.map(p => p.height));
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d');
  context.fillStyle = '#777'; context.fillRect(0, 0, width, height);
  let x = 0;
  for (const { pixels, width: w, height: h, checker } of panels) {
    const image = context.createImageData(w, h);
    for (let y = 0; y < h; y++) for (let i = 0; i < w; i++) {
      const from = ((h - 1 - y) * w + i) * 4, to = (y * w + i) * 4;
      // Premultiplied layer pixels are shown over a checkerboard.
      const a = pixels[from + 3] / 255, back = checker ? (((i >> 3) + (y >> 3)) % 2 ? 200 : 120) : 0;
      for (let c = 0; c < 3; c++) image.data[to + c] = checker ? pixels[from + c] + (1 - a) * back : pixels[from + c];
      image.data[to + 3] = 255;
    }
    context.putImageData(image, x, 0);
    x += w + 8;
  }
  return canvas.toDataURL('image/png');
}

globalThis.probePresentationLayer = async ({ transparentBackground = false, images = false, questSubImages = false } = {}) => {
  const records = [];
  globalThis.__stereofoldDiagnostics = { record: (kind, detail) => { if (kind === 'presentation-layer') records.push(detail); } };
  const canvasElement = document.createElement('canvas'); canvasElement.width = W; canvasElement.height = H;
  document.body.append(canvasElement);
  const gl = canvasElement.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false, alpha: true, premultipliedAlpha: true });
  if (!gl) throw Error('WebGL2 required');
  const webgl = createContext(gl);
  const molecular = Scene.create(webgl, 'blended');
  const renderer = Renderer.create(webgl, { backgroundColor: 0x203040 });
  const camera = new Camera(); camera.viewport.width = W; camera.viewport.height = H;
  camera.setState({ position: [0, 0, 60], target: [0, 0, 0], radius: 35, radiusMax: 100, fog: 0 }); camera.update();
  const stereo = new StereoCamera(camera, { eyeSeparation: 2, focus: 40 });
  stereo.update();

  // The molecule: one ball behind the controls, and one in front of the menu
  // glass that the stock depth clear lets the controls cover.
  molecular.add(ball([0, 0, 0], 14, 0xc04040));
  molecular.add(ball([-6, -1, 28], 3, 0x40c060));
  molecular.add(box([10, 6, -6], [10, 6, 6], 0x4060d0, 1));
  molecular.commit();

  // A stand-in for Canvas3D: the registry, the camera, and a draw request.
  const registry = new DebugRegistry(webgl, molecular);
  const canvas = { webgl, camera, debugRegistry: registry, requestDraw() {}, props: { postprocessing: { dof: { name: 'off' } } }, setProps() {} };
  const presentation = createPresentationScene(canvas);
  // Room metres here are the parent camera's view space (scale 1): the menu
  // column glass and its buttons at z -40, a caption card above-right of it.
  const glass = box([-8, 0, -40.4], [13, 16, 0.4], 0x10141c, 0.82);
  const buttons = [5, 0, -5].map((y, i) => box([-8, y, -40], [11, 3.6, 0.6], [0x33507a, 0x2d6a4f, 0x7a3350][i], 1));
  const labels = ['Play', 'Next', 'Menu'].map((text, i) => label(text, [-8, [5, 0, -5][i], -39.4], 2.2, 0xffffff));
  const card = box([11, 5, -41], [14, 7, 0.4], 0xf0f0f0, 0.55);
  const cardText = label('Gamma shaft', [11, 5, -40.5], 1.6, 0x101010);
  // A translucent card that stands in front of the column and covers its right half.
  const overlap = box([-2, 1, -37], [12, 4, 0.3], 0xffc030, 0.4);
  // The column's own parts are marked, as the toolbar marks them; the mark
  // changes nothing until a drawer asks for the column apart.
  const columnParts = { renderObjects: [glass, ...buttons, ...labels] };
  const otherControls = { renderObjects: [card, overlap, cardText] };
  presentation.add(columnParts, { roomLocked: true, menuColumn: true });
  presentation.add(otherControls, { roomLocked: true });

  const draw = new DrawPass(webgl, new AssetManager(), W, H, 'blended');
  // The headset session makes the drawing buffer's own depth the opaque depth
  // the controls test against (`installPresentationDepthAdapter`).
  const depthTexture = draw.depthTextureOpaque;
  for (const method of ['attachFramebuffer', 'detachFramebuffer']) {
    const original = depthTexture[method];
    depthTexture[method] = function (framebuffer, attachment, ...rest) {
      if (framebuffer === draw.drawTarget.framebuffer && attachment === 'depth') return;
      return original.call(this, framebuffer, attachment, ...rest);
    };
  }
  const pp = structuredClone(PD.getDefaultValues(PostprocessingParams));
  for (const value of Object.values(pp)) if (value && typeof value === 'object' && 'name' in value) value.name = 'off';
  const config = { transparentBackground, postprocessing: pp, marking: { ...PD.getDefaultValues(MarkingParams), enabled: false }, dpoitIterations: 2 };
  const helper = { debug: registry, pointer: { isEnabled: false }, handle: { isEnabled: false }, camera: { isEnabled: false } };
  webgl.resources.linkPrograms();
  webgl.resources.finalizePrograms(undefined, true);
  const frame = () => draw.render({ renderer, camera: stereo, scene: molecular, helper }, config, true);
  const read = () => { const pixels = new Uint8Array(W * H * 4); webgl.readPixels(0, 0, W, H, pixels); return pixels; };

  frame();
  const stock = read();

  // The layered path, through the real drawer, with a stand-in layer stack
  // whose projection layer is a side-by-side texture with the eye viewports.
  const uiTexture = makeTexture(gl, W, H);
  const eyes = { left: stereo.left.viewport, right: stereo.right.viewport };
  let hook, painter, overlays = [];
  const quadTextures = new Map();
  const stack = { session: null, gl,
    binding: {
      createProjectionLayer: () => ({ kind: 'projection' }),
      // `questSubImages`: the answer Quest Browser gives for a side-by-side
      // 'texture' layer, with an image index per eye and the texture's size
      // only as `colorTextureWidth`/`colorTextureHeight`.
      getViewSubImage: (_layer, view) => questSubImages
        ? { colorTexture: uiTexture, imageIndex: view.eye === 'left' ? 0 : 1, colorTextureWidth: W, colorTextureHeight: H,
          viewport: { ...eyes[view.eye] } }
        : { colorTexture: uiTexture, imageIndex: null, textureWidth: W, textureHeight: H, viewport: { ...eyes[view.eye] } },
      createQuadLayer: init => ({ kind: init.isStatic ? 'cursor' : 'quad', init, needsRedraw: true }),
      getSubImage: layer => {
        const { viewPixelWidth: w, viewPixelHeight: h } = layer.init;
        if (!quadTextures.has(layer)) quadTextures.set(layer, makeTexture(gl, w, h));
        layer.needsRedraw = false;
        return { colorTexture: quadTextures.get(layer), textureWidth: w, textureHeight: h, viewport: { x: 0, y: 0, width: w, height: h } };
      },
    },
    setOverlayLayers: layers => { overlays = layers; },
    onAfterMolecularFrame: cb => { hook = cb; return () => { hook = undefined; }; },
    onCapture: cb => { painter = cb; return () => { painter = undefined; }; },
  };
  // A still of the left eye as a capture takes it: the molecule's frame
  // copied out of the presentation buffer into a small framebuffer, with the
  // scissor test off for the copy, then the layers painted over it.
  const leftView = { eye: 'left', projectionMatrix: Array.from(stereo.left.projection),
    transform: { inverse: { matrix: Array.from(Mat4.mul(Mat4(), stereo.left.view, Mat4.invert(Mat4(), camera.view))) } } };
  function takeStill(scale = 1) {
    const v = stereo.left.viewport, width = Math.round(v.width * scale), height = Math.round(v.height * scale);
    const texture = makeTexture(gl, width, height), framebuffer = gl.createFramebuffer();
    const scissor = gl.isEnabled(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.disable(gl.SCISSOR_TEST);
    gl.blitFramebuffer(v.x, v.y, v.x + v.width, v.y + v.height, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.LINEAR);
    if (scissor) gl.enable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const painted = painter?.({ view: leftView, framebuffer, width, height });
    const pixels = readTexture(gl, texture, width, height);
    gl.deleteFramebuffer(framebuffer); gl.deleteTexture(texture);
    return { painted, pixels, width, height };
  }
  /** The left eye of a whole frame, as rows of RGBA. */
  function leftEye(framePixels) {
    const v = stereo.left.viewport, out = new Uint8Array(v.width * v.height * 4);
    for (let y = 0; y < v.height; y++) out.set(framePixels.subarray(((v.y + y) * W + v.x) * 4, ((v.y + y) * W + v.x + v.width) * 4), y * v.width * 4);
    return out;
  }
  /** How far a still is from an eye of the same size: the worst channel, the mean, and pixels off by more than `levels`. */
  function stillDifference(still, eye, levels) {
    let worst = 0, sum = 0, off = 0;
    for (let i = 0; i < eye.length; i += 4) {
      let pixel = 0;
      for (let c = 0; c < 3; c++) pixel = Math.max(pixel, Math.abs(still.pixels[i + c] - eye[i + c]));
      worst = Math.max(worst, pixel); sum += pixel; if (pixel > levels) off++;
    }
    return { worst, mean: sum / (eye.length / 4), off };
  }
  // The eyes in room metres, which here is the parent camera's view space.
  const pose = { views: [{ eye: 'left', transform: { position: { x: -1, y: 0, z: 0 } } },
    { eye: 'right', transform: { position: { x: 1, y: 0, z: 0 } } }] };
  class RigidTransform { constructor(position, orientation) { this.position = position; this.orientation = orientation; } }
  const attach = (target, extra = {}) => attachPresentationLayers({ stack, presentation, canvas, drawPass: draw, space: 'local',
    target, scope: { XRRigidTransform: RigidTransform }, ...extra });

  const layered = attach('projection');
  frame();
  const molecule = read();
  hook({}, pose);
  const ui = readTexture(gl, uiTexture, W, H);
  // A still taken now shows the stock frame: the molecule with its controls.
  const bare = leftEye(read());
  const still = takeStill(), stockEye = leftEye(stock);
  const stillFacts = { painted: still.painted ?? null, ...stillDifference(still, stockEye, ROUNDING),
    // Without the layers the still is only the molecule, which is far from the stock frame.
    bare: stillDifference({ pixels: bare }, stockEye, ROUNDING).off };
  const errorAfterLayer = gl.getError();
  const facts = layered.facts();
  layered.dispose();

  // Composite: a premultiplied layer over the molecule, as the compositor
  // blends it. With an opaque background the molecule's alpha is one.
  const channels = transparentBackground ? 4 : 3;
  let maxDifference = 0, over = 0, uiPixels = 0, wrongOver = 0;
  for (let i = 0; i < W * H * 4; i += 4) {
    const a = ui[i + 3] / 255;
    if (ui[i + 3] > 0) uiPixels++;
    let pixelOver = false, pixelWrong = false;
    for (let c = 0; c < channels; c++) {
      const composite = ui[i + c] + (1 - a) * molecule[i + c];
      const difference = Math.abs(composite - stock[i + c]);
      maxDifference = Math.max(maxDifference, difference);
      if (difference > 3) pixelOver = true;
      // Sensitivity control: straight-alpha blending of the same layer.
      if (c < 3 && Math.abs(ui[i + c] * a + (1 - a) * molecule[i + c] - stock[i + c]) > 3) pixelWrong = true;
    }
    if (pixelOver) over++;
    if (pixelWrong) wrongOver++;
  }
  // The stock frame really did put controls over the near ball: the layered
  // molecule frame differs from the stock frame where the controls are.
  let controlsChanged = 0;
  for (let i = 0; i < W * H * 4; i += 4) if (Math.abs(stock[i] - molecule[i]) > 8 || Math.abs(stock[i + 1] - molecule[i + 1]) > 8) controlsChanged++;

  // The quad target: the menu column's own parts on its quad and nowhere
  // else, every other control whole on the projection layer.
  const plate = { point: [-8, 0, -40], right: [1, 0, 0], up: [0, 1, 0], normal: [0, 0, -1],
    halfWidth: 6.5, halfHeight: 8, front: 1.0, back: 0.8, seat: [0, 0, 0] };
  const quadDensity = { pixelsPerMeter: 16, maxPixels: 512, marginMeters: 0.1 };
  const quadMode = attach('quad', { getMenuPlate: () => plate, quadDensity });
  frame(); hook({}, pose);
  frame(); hook({}, pose);
  const uiQuad = readTexture(gl, uiTexture, W, H);
  const quadLayer = overlays.find(layer => layer.kind === 'quad');
  const quadFacts = quadMode.facts();
  const quadOverlays = overlays.map(l => l.kind);
  const layout = menuQuadLayout(plate, quadDensity);
  // In quad mode the still gets the column too, drawn from the menu's seat and
  // placed as the quad is, so it is the stock eye give or take the seat's parallax.
  const quadStill = takeStill(), smallStill = takeStill(0.5);
  const quadStillFacts = { painted: quadStill.painted ?? null, ...stillDifference(quadStill, stockEye, 40) };
  const readQuad = () => quadLayer && quadTextures.has(quadLayer)
    ? readTexture(gl, quadTextures.get(quadLayer), quadLayer.init.viewPixelWidth, quadLayer.init.viewPixelHeight) : null;
  const quadPixels = readQuad();
  // With the other controls hidden the quad is redrawn and must not change,
  // and the projection layer must hold nothing: the column is on the quad alone.
  presentation.setVisible(otherControls, false);
  frame(); hook({}, pose);
  const quadAlone = readQuad(), uiColumnOnly = readTexture(gl, uiTexture, W, H);
  presentation.setVisible(otherControls, true);
  quadMode.dispose();
  // What the other controls look like on a projection layer with no column in the scene.
  presentation.setVisible(columnParts, false);
  const restOnly = attach('projection');
  frame(); hook({}, pose);
  const uiRest = readTexture(gl, uiTexture, W, H);
  restOnly.dispose();
  presentation.setVisible(columnParts, true);
  // Back on the stock path after raw GL beside Mol* (clears, framebuffer
  // switches, the footprint program): the frame is the first stock frame.
  frame();
  const stockAgain = read();
  let stockDrift = 0;
  for (let i = 0; i < stockAgain.length; i++) stockDrift = Math.max(stockDrift, Math.abs(stockAgain[i] - stock[i]));
  // Project the glass rectangle into each eye to find its footprint.
  const footprint = new Uint8Array(W * H);
  for (const eye of [stereo.left, stereo.right]) {
    const m = eye.projectionView; // room = view space of the parent, world = inverse(view) of it
    const toWorld = Mat4.invert(Mat4(), camera.view);
    const mvp = Mat4.mul(Mat4(), m, toWorld);
    const corners = [];
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      const p = [plate.point[0] + sx * layout.halfWidth, plate.point[1] + sy * layout.halfHeight, plate.point[2] + (sz > 0 ? layout.front : -layout.back)];
      const clip = [0, 1, 2, 3].map(r => mvp[r] * p[0] + mvp[4 + r] * p[1] + mvp[8 + r] * p[2] + mvp[12 + r]);
      const v = eye.viewport;
      corners.push([v.x + (clip[0] / clip[3] * 0.5 + 0.5) * v.width, v.y + (clip[1] / clip[3] * 0.5 + 0.5) * v.height]);
    }
    const xs = corners.map(c => c[0]), ys = corners.map(c => c[1]);
    for (let y = Math.floor(Math.min(...ys)); y <= Math.ceil(Math.max(...ys)); y++) for (let x = Math.floor(Math.min(...xs)); x <= Math.ceil(Math.max(...xs)); x++)
      if (x >= 0 && y >= 0 && x < W && y < H) footprint[y * W + x] = 1;
  }
  let overlapInside = 0, outsideChanged = 0, insideBefore = 0, restDifference = 0, columnOnProjection = 0;
  for (let p = 0; p < W * H; p++) {
    const i = p * 4;
    const strictlyInside = footprint[p] && (p % W > 0 && footprint[p - 1]) && (p % W < W - 1 && footprint[p + 1]) && footprint[p - W] && footprint[p + W];
    if (strictlyInside && ui[i + 3] > 0) insideBefore++;
    // A control that is not part of the column, drawn where the column is on screen.
    if (strictlyInside && uiQuad[i + 3] > 0) overlapInside++;
    if (!footprint[p] && [0, 1, 2, 3].some(c => Math.abs(uiQuad[i + c] - ui[i + c]) > 1)) outsideChanged++;
    for (let c = 0; c < 4; c++) restDifference = Math.max(restDifference, Math.abs(uiQuad[i + c] - uiRest[i + c]));
    if (uiColumnOnly[i + 3] > 0) columnOnProjection++;
  }
  let quadInk = 0, quadGlass = 0, quadForeign = 0;
  if (quadPixels) for (let i = 0; i < quadPixels.length; i += 4) {
    if (quadPixels[i + 3] > 200 && quadPixels[i] > 200) quadInk++;
    if (quadPixels[i + 3] > 0) quadGlass++;
    if ([0, 1, 2, 3].some(c => quadPixels[i + c] !== quadAlone[i + c])) quadForeign++;
  }
  const camera0 = menuPanelCamera(layout, camera, { x: 0, y: 0, width: 1, height: 1 });
  let pictures;
  if (images) {
    const composite = new Uint8Array(W * H * 4);
    for (let i = 0; i < composite.length; i += 4) for (let c = 0; c < 4; c++)
      composite[i + c] = Math.round(ui[i + c] + (1 - ui[i + 3] / 255) * molecule[i + c]);
    pictures = { frames: sheet([{ pixels: stock, width: W, height: H }, { pixels: composite, width: W, height: H },
      { pixels: ui, width: W, height: H, checker: true }, { pixels: uiQuad, width: W, height: H, checker: true }]),
      quad: quadPixels ? sheet([{ pixels: quadPixels, width: quadLayer.init.viewPixelWidth, height: quadLayer.init.viewPixelHeight, checker: true }]) : null,
      // The stock left eye, then stills of it: projection target, quad target, quad target at half size.
      stills: sheet([{ pixels: stockEye, width: still.width, height: still.height }, still, quadStill, smallStill]) };
  }
  return { records, pictures, transparentBackground, still: stillFacts, quadStill: quadStillFacts, corner: Array.from(stock.slice(0, 4)), moleculeCorner: Array.from(molecule.slice(0, 4)), maxDifference, over, uiPixels, wrongOver, controlsChanged, facts, error: errorAfterLayer, finalError: gl.getError(),
    quad: { state: quadFacts.state, draws: quadFacts.quadDraws, overlays: quadOverlays, insideBefore, overlapInside, outsideChanged,
      restDifference, columnOnProjection, quadForeign,
      texture: quadLayer ? [quadLayer.init.viewPixelWidth, quadLayer.init.viewPixelHeight] : null, quadInk, quadGlass,
      quadTotal: quadPixels ? quadPixels.length / 4 : 0, cameraOk: Boolean(camera0) },
    registered: registry.entries.has('stereofold-presentation'), stockDrift };
};

/** A box whose faces follow three given axes: `right`, `up` and `outward` are unit vectors, `size` its extent along each. */
function turnedBox(centre, right, up, outward, size, color, alpha) {
  const state = MeshBuilder.createState(); state.currentGroup = 0;
  const transform = Mat4();
  [right, up, outward, centre].forEach((axis, column) => {
    for (let row = 0; row < 3; row++) transform[column * 4 + row] = axis[row] * (column < 3 ? size[column] : 1);
  });
  transform[15] = 1;
  MeshBuilder.addPrimitive(state, transform, Box());
  const props = { ...PD.getDefaultValues(Mesh.Params), alpha, doubleSided: true, ignoreLight: false };
  return createRenderObject('mesh', Mesh.Utils.createValuesSimple(MeshBuilder.getMesh(state), props, color, 1),
    Mesh.Utils.createRenderableState(props), -1);
}

// How a row plate is shaded in the wearer's eye and on the menu quad, for a
// column whose glass is turned from the way the head faces, under the headset
// light rig: a strong key light and little ambient, so the shade follows the
// plate's turn to the head. Opaque plates, so each reading is the plate's own
// colour and nothing behind it.
//
// `target: 'projection'` keeps the column on the projection layer and reads
// its edges there instead: `multisample` gives the context a stand-in for the
// headset's multisampled render-to-texture, so the layer's anti-aliasing is
// rasterised for real.
globalThis.probeQuadShade = async ({ turnDegrees = 29, lights, target = 'quad', multisample = false } = {}) => {
  const records = [];
  globalThis.__stereofoldDiagnostics = { record: (kind, detail) => { if (kind === 'presentation-layer') records.push(detail); } };
  const canvasElement = document.createElement('canvas'); canvasElement.width = W; canvasElement.height = H;
  document.body.append(canvasElement);
  const gl = canvasElement.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false, alpha: true, premultipliedAlpha: true });
  const multisampling = multisample ? emulateMultisampledRenderToTexture(gl) : null;
  const webgl = createContext(gl);
  const molecular = Scene.create(webgl, 'blended', { dColorMarker: true, dLightCount: lights.light.length });
  const renderer = Renderer.create(webgl, { backgroundColor: 0x203040, ambientColor: lights.ambientColor,
    ambientIntensity: lights.ambientIntensity, light: lights.light });
  const camera = new Camera(); camera.viewport.width = W; camera.viewport.height = H;
  camera.setState({ position: [0, 0, 60], target: [0, 0, 0], radius: 35, radiusMax: 100, fog: 0 }); camera.update();
  const stereo = new StereoCamera(camera, { eyeSeparation: 2, focus: 40 });
  stereo.update();
  molecular.add(ball([30, 0, 0], 4, 0xc04040));
  molecular.commit();
  const registry = new DebugRegistry(webgl, molecular);
  const canvas = { webgl, camera, debugRegistry: registry, requestDraw() {}, props: { postprocessing: { dof: { name: 'off' } } }, setProps() {} };
  const presentation = createPresentationScene(canvas);
  // Room metres are the parent camera's view space, and the head looks down
  // -z. The column stands in view, 40 away, with its glass turned
  // `turnDegrees` about the vertical from facing the head, toward a seat off
  // to the right: the turn a column seated to the wearer's side has to a head
  // that faces forward.
  const turn = turnDegrees * Math.PI / 180;
  const centre = [-4, -2.4, -40];
  const outward = [Math.sin(turn), 0, Math.cos(turn)], right = [Math.cos(turn), 0, -Math.sin(turn)], up = [0, 1, 0];
  const seat = centre.map((v, i) => v + outward[i] * 40);
  const along = (axis, n) => axis.map(v => v * n);
  const at = (...parts) => parts.reduce((sum, part) => sum.map((v, i) => v + part[i]), centre);
  const glass = turnedBox(at(along(outward, -0.4)), right, up, outward, [13, 16, 0.4], 0x081218, 1);
  const row = turnedBox(at(), right, up, outward, [11, 3.6, 0.6], 0x1f8189, 1);
  const columnParts = { renderObjects: [glass, row] };
  presentation.add(columnParts, { roomLocked: true, menuColumn: true });

  const draw = new DrawPass(webgl, new AssetManager(), W, H, 'blended');
  const depthTexture = draw.depthTextureOpaque;
  for (const method of ['attachFramebuffer', 'detachFramebuffer']) {
    const original = depthTexture[method];
    depthTexture[method] = function (framebuffer, attachment, ...rest) {
      if (framebuffer === draw.drawTarget.framebuffer && attachment === 'depth') return;
      return original.call(this, framebuffer, attachment, ...rest);
    };
  }
  const pp = structuredClone(PD.getDefaultValues(PostprocessingParams));
  for (const value of Object.values(pp)) if (value && typeof value === 'object' && 'name' in value) value.name = 'off';
  const config = { transparentBackground: false, postprocessing: pp, marking: { ...PD.getDefaultValues(MarkingParams), enabled: false }, dpoitIterations: 2 };
  const helper = { debug: registry, pointer: { isEnabled: false }, handle: { isEnabled: false }, camera: { isEnabled: false } };
  webgl.resources.linkPrograms();
  webgl.resources.finalizePrograms(undefined, true);
  const frame = () => draw.render({ renderer, camera: stereo, scene: molecular, helper }, config, true);
  const read = () => { const pixels = new Uint8Array(W * H * 4); webgl.readPixels(0, 0, W, H, pixels); return pixels; };
  /** The mean colour of a 5 by 5 patch. */
  const patch = (pixels, width, x, y) => {
    const sum = [0, 0, 0];
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++)
      for (let c = 0; c < 3; c++) sum[c] += pixels[((y + dy) * width + x + dx) * 4 + c];
    return sum.map(v => Math.round(v / 25));
  };

  // In the eye: the stock frame, read where the row's face centre lands in the left eye.
  frame();
  const stock = read();
  const face = at(along(outward, 0.3));
  const toWorld = Mat4.invert(Mat4(), camera.view);
  const mvp = Mat4.mul(Mat4(), stereo.left.projectionView, toWorld);
  const clip = [0, 1, 2, 3].map(r => mvp[r] * face[0] + mvp[4 + r] * face[1] + mvp[8 + r] * face[2] + mvp[12 + r]);
  const v = stereo.left.viewport;
  const eyeX = Math.round(v.x + (clip[0] / clip[3] * 0.5 + 0.5) * v.width), eyeY = Math.round(v.y + (clip[1] / clip[3] * 0.5 + 0.5) * v.height);
  const inEye = patch(stock, W, eyeX, eyeY);

  // On the quad: the column drawn through the layer drawer into the quad's texture.
  const uiTexture = makeTexture(gl, W, H);
  const eyes = { left: stereo.left.viewport, right: stereo.right.viewport };
  let hook, overlays = [];
  const quadTextures = new Map();
  const stack = { session: null, gl,
    binding: {
      createProjectionLayer: () => ({ kind: 'projection' }),
      getViewSubImage: (_layer, view) => ({ colorTexture: uiTexture, imageIndex: null, textureWidth: W, textureHeight: H, viewport: { ...eyes[view.eye] } }),
      createQuadLayer: init => ({ kind: 'quad', init, needsRedraw: true }),
      getSubImage: layer => {
        const { viewPixelWidth: w, viewPixelHeight: h } = layer.init;
        if (!quadTextures.has(layer)) quadTextures.set(layer, makeTexture(gl, w, h));
        layer.needsRedraw = false;
        return { colorTexture: quadTextures.get(layer), textureWidth: w, textureHeight: h, viewport: { x: 0, y: 0, width: w, height: h } };
      },
    },
    setOverlayLayers: layers => { overlays = layers; },
    onAfterMolecularFrame: cb => { hook = cb; return () => { hook = undefined; }; },
  };
  const pose = { views: [{ eye: 'left' }, { eye: 'right' }] };
  class RigidTransform { constructor(position, orientation) { this.position = position; this.orientation = orientation; } }
  const plate = { point: centre, right, up, normal: outward.map(n => -n), halfWidth: 6.5, halfHeight: 8, front: 1.0, back: 0.8, seat };
  const quadDensity = { pixelsPerMeter: 16, maxPixels: 512, marginMeters: 0.1 };
  const layers = attachPresentationLayers({ stack, presentation, canvas, drawPass: draw, space: 'local', target,
    scope: { XRRigidTransform: RigidTransform }, getMenuPlate: () => plate, quadDensity });
  frame(); hook({}, pose);
  frame(); hook({}, pose);
  const quadLayer = overlays.find(layer => layer.kind === 'quad');
  const { viewPixelWidth: qw, viewPixelHeight: qh } = quadLayer?.init ?? { viewPixelWidth: 0, viewPixelHeight: 0 };
  const onQuad = quadLayer ? patch(readTexture(gl, quadTextures.get(quadLayer), qw, qh), qw, Math.round(qw / 2), Math.round(qh / 2)) : null;
  // The projection layer's own pixels. Every plate here is opaque, so a pixel
  // with alpha strictly between none and full is an edge covered in part.
  const ui = readTexture(gl, uiTexture, W, H);
  const onLayer = patch(ui, W, eyeX, eyeY);
  const edges = { lit: 0, partial: 0, brighterThanCovered: 0 };
  for (let i = 0; i < ui.length; i += 4) {
    const alpha = ui[i + 3];
    if (alpha > 0) edges.lit++;
    if (alpha > 0 && alpha < 255) {
      edges.partial++;
      // Premultiplied: no channel may exceed the pixel's own coverage.
      if (Math.max(ui[i], ui[i + 1], ui[i + 2]) > alpha + 1) edges.brighterThanCovered++;
    }
  }
  const lightAfter = renderer.props.light.map(one => [one.inclination, one.azimuth]);
  layers.dispose();
  // The lights are the renderer's own again: a stock frame afterwards is the first one.
  frame();
  const stockAgain = read();
  let stockDrift = 0;
  for (let i = 0; i < stockAgain.length; i++) stockDrift = Math.max(stockDrift, Math.abs(stockAgain[i] - stock[i]));
  let picture;
  if (target === 'projection') {
    // The top edge of the glass in the left eye, four times its size.
    const crop = { x: Math.max(0, eyeX - 30), y: Math.min(H - 40, eyeY + 40), width: 60, height: 40 }, zoom = 4;
    const out = document.createElement('canvas'); out.width = crop.width * zoom; out.height = crop.height * zoom;
    const context = out.getContext('2d'), image = context.createImageData(out.width, out.height);
    for (let y = 0; y < out.height; y++) for (let x = 0; x < out.width; x++) {
      const from = ((crop.y + crop.height - 1 - Math.floor(y / zoom)) * W + crop.x + Math.floor(x / zoom)) * 4, to = (y * out.width + x) * 4;
      const a = ui[from + 3] / 255;
      for (let c = 0; c < 3; c++) image.data[to + c] = ui[from + c] + (1 - a) * 235;
      image.data[to + 3] = 255;
    }
    context.putImageData(image, 0, 0);
    picture = out.toDataURL('image/png');
  }
  return { turnDegrees, inEye, onQuad, onLayer, edges, eyeAt: [eyeX, eyeY], quad: [qw, qh], lightAfter, stockDrift, error: gl.getError(),
    multisampling, antialias: records.filter(r => r.phase === 'antialias').map(r => r.samples), picture };
};

// The controller pointer with the controls on a layer of their own. A room-
// sized scene, so the pointer's three-millimetre dots cover pixels: a ball of
// 15 cm half a metre from the eyes, menu glass 20 cm in front of it over its
// left half. A controller stands in front of the glass and aims its ray at
// the ball; three dots sit inside the ball, as a hand inside a structure
// does; the menu hit dot sits on the glass. The stock frame draws all of
// them over the molecule (the controls' depth clear runs first) and tests
// them against the glass. `pointer: false` attaches the layers without
// handing them the pointer, which is how the pointer was drawn before.
globalThis.probePointerLayer = async ({ images = false } = {}) => {
  const canvasElement = document.createElement('canvas'); canvasElement.width = W; canvasElement.height = H;
  document.body.append(canvasElement);
  const gl = canvasElement.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false, alpha: true, premultipliedAlpha: true });
  if (!gl) throw Error('WebGL2 required');
  const webgl = createContext(gl);
  const molecular = Scene.create(webgl, 'blended');
  const renderer = Renderer.create(webgl, { backgroundColor: 0x203040 });
  const camera = new Camera(); camera.viewport.width = W; camera.viewport.height = H;
  camera.setState({ position: [0, 0, 0.5], target: [0, 0, 0], radius: 0.45, radiusMax: 1, minNear: 0.01, fog: 0 }); camera.update();
  const stereo = new StereoCamera(camera, { eyeSeparation: 0.02, focus: 0.4 });
  stereo.update();
  molecular.add(ball([0, 0, 0], 0.15, 0xc04040));
  molecular.commit();
  const registry = new DebugRegistry(webgl, molecular);
  const canvas = { webgl, camera, debugRegistry: registry, requestDraw() {}, props: { postprocessing: { dof: { name: 'off' } } }, setProps() {} };
  const presentation = createPresentationScene(canvas);
  // Room metres are the parent camera's view space: the glass at world z 0.3.
  presentation.add({ renderObjects: [box([-0.06, 0, -0.2], [0.1, 0.14, 0.004], 0x10141c, 0.82)] }, { roomLocked: true });
  const draw = new DrawPass(webgl, new AssetManager(), W, H, 'blended');
  const depthTexture = draw.depthTextureOpaque;
  for (const method of ['attachFramebuffer', 'detachFramebuffer']) {
    const original = depthTexture[method];
    depthTexture[method] = function (framebuffer, attachment, ...rest) {
      if (framebuffer === draw.drawTarget.framebuffer && attachment === 'depth') return;
      return original.call(this, framebuffer, attachment, ...rest);
    };
  }
  const pp = structuredClone(PD.getDefaultValues(PostprocessingParams));
  for (const value of Object.values(pp)) if (value && typeof value === 'object' && 'name' in value) value.name = 'off';
  const config = { transparentBackground: false, postprocessing: pp, marking: { ...PD.getDefaultValues(MarkingParams), enabled: false }, dpoitIterations: 2 };

  const pointerHelper = new PointerHelper(webgl, { enabled: 'on' });
  // The hit point the toolbar reports: on the glass, 6 mm toward the wearer.
  const aim = [-0.04, 0.03, -0.198 + 0.006];
  const pointer = attachXrPointerHelper({ canvas, helper: pointerHelper, menuPoint: () => aim });
  const origin = [-0.03, -0.035, 0.36], toward = [0.35, 0.1, -1], length = Math.hypot(...toward);
  pointerHelper.update([{ origin, direction: toward.map(v => v / length) }],
    [[0.04, 0.02, 0.1], [0.06, -0.03, 0.08], [0.03, -0.06, 0.1]], undefined);
  const withPointer = { debug: registry, pointer: pointerHelper, handle: { isEnabled: false }, camera: { isEnabled: false } };
  const withoutPointer = { ...withPointer, pointer: { isEnabled: false } };
  webgl.resources.linkPrograms();
  webgl.resources.finalizePrograms(undefined, true);
  const frame = (helper = withPointer) => draw.render({ renderer, camera: stereo, scene: molecular, helper }, config, true);
  const read = () => { const pixels = new Uint8Array(W * H * 4); webgl.readPixels(0, 0, W, H, pixels); return pixels; };

  frame(withoutPointer);
  const bare = read();
  frame();
  const stock = read();

  const uiTexture = makeTexture(gl, W, H);
  const eyes = { left: stereo.left.viewport, right: stereo.right.viewport };
  let hook;
  const stack = { session: null, gl,
    binding: {
      createProjectionLayer: () => ({ kind: 'projection' }),
      getViewSubImage: (_layer, view) => ({ colorTexture: uiTexture, imageIndex: null, textureWidth: W, textureHeight: H, viewport: { ...eyes[view.eye] } }),
    },
    setOverlayLayers() {},
    onAfterMolecularFrame: cb => { hook = cb; return () => { hook = undefined; }; },
  };
  const pose = { views: [{ eye: 'left', transform: { position: { x: -0.01, y: 0, z: 0 } } },
    { eye: 'right', transform: { position: { x: 0.01, y: 0, z: 0 } } }] };
  class RigidTransform { constructor(position, orientation) { this.position = position; this.orientation = orientation; } }
  function layered(handOver) {
    const attached = attachPresentationLayers({ stack, presentation, canvas, drawPass: draw, space: 'local', target: 'projection',
      scope: { XRRigidTransform: RigidTransform }, ...(handOver ? { getPointer: () => pointer } : {}) });
    // The pointer leaves the molecule's pass on the first frame's hook, so
    // the second frame is the one a wearer sees from then on.
    frame(); hook({}, pose);
    frame();
    const molecule = read();
    hook({}, pose);
    const ui = readTexture(gl, uiTexture, W, H);
    const facts = attached.facts();
    attached.dispose();
    const composite = new Uint8Array(W * H * 4);
    let over = 0, worst = 0;
    for (let i = 0; i < composite.length; i += 4) {
      const a = ui[i + 3] / 255;
      let pixel = 0;
      for (let c = 0; c < 4; c++) composite[i + c] = Math.round(ui[i + c] + (1 - a) * molecule[i + c]);
      for (let c = 0; c < 3; c++) pixel = Math.max(pixel, Math.abs(composite[i + c] - stock[i + c]));
      worst = Math.max(worst, pixel);
      if (pixel > ROUNDING) over++;
    }
    return { facts, over, worst, composite, ui };
  }
  const before = layered(false), after = layered(true);
  // The pointer is back in the molecule's pass once the layers are gone.
  frame();
  const stockAgain = read();
  let pointerPixels = 0, stockDrift = 0;
  for (let i = 0; i < stock.length; i += 4) {
    if ([0, 1, 2].some(c => Math.abs(stock[i + c] - bare[i + c]) > 8)) pointerPixels++;
    for (let c = 0; c < 4; c++) stockDrift = Math.max(stockDrift, Math.abs(stockAgain[i + c] - stock[i + c]));
  }
  pointer.restore();
  const pictures = images ? { pointer: sheet([{ pixels: stock, width: W, height: H }, { pixels: before.composite, width: W, height: H },
    { pixels: after.composite, width: W, height: H }, { pixels: after.ui, width: W, height: H, checker: true }]) } : undefined;
  return { pictures, pointerPixels, stockDrift, error: gl.getError(),
    before: { state: before.facts.state, over: before.over, worst: before.worst },
    after: { state: after.facts.state, over: after.over, worst: after.worst } };
};
