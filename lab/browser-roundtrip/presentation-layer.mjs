import { invertMatrix4 } from './room-lock.mjs';

/**
 * The headset controls drawn into their own WebXR composition layers.
 *
 * Today the presentation scene (menu, status, captions, replies, chapter
 * cards) is drawn inside the molecule's render pass, after the molecule, with
 * a depth clear between the two (`presentation-scene.mjs`). On a Quest that
 * mid-pass clear switches fixed foveation off for the whole eye buffer. Here
 * the same scene is drawn after the molecular frame, by the same Mol*
 * renderer, into a layer of its own that the compositor places above the
 * molecule. The molecule's pass no longer carries any control, so it can be
 * foveated, and the controls' layer is not.
 *
 * Two targets:
 *
 * - `projection`: a second full-scale projection layer with foveation off.
 *   Both eyes are drawn with the eye cameras Mol* drew the molecule with, on
 *   a cleared transparent target, so layout, poses, hit testing and look are
 *   today's. The molecule's layer is finished (left eye, right eye) before
 *   this layer is bound, and this layer is cleared once and drawn left then
 *   right, so no framebuffer switches between the eyes of either layer.
 * - `quad`: the menu column on a quad layer whose pose and size match the
 *   column's glass, redrawn only when the presentation content changes or the
 *   compositor asks. It is drawn from the seat the column was placed for,
 *   through the glass as a window, so labels stay over their plates. The
 *   controls are divided by object: the column's own glass, plates and labels
 *   are drawn only into the quad, and every other control only into the
 *   projection layer, whole, wherever it stands. The compositor cannot
 *   depth-test one layer against another, so the two are ordered instead: the
 *   projection layer goes above the quad while a control nearer the eye than
 *   the glass overlaps the column, and below it otherwise.
 *
 * In both, a small cursor quad marks where a controller ray meets the menu,
 * because the ray itself is drawn in the molecule's pass, under these layers.
 *
 * The layer stack (session, binding, the molecule's projection layer, the
 * overlay list and the after-frame hook) is supplied by `xr-layers.mjs`.
 */

export const PRESENTATION_LAYER_DIAGNOSTIC = 'presentation-layer';

/** Where the menu column's quad sits in front of and behind its glass. */
const SLAB_PAD_METERS = 0.004;
/** The quad's texture density and its largest side. */
export const QUAD_PIXELS_PER_METER = 1600;
export const QUAD_MAX_PIXELS = 2048;
/** Extra glass around the column's own outline, so no bevel is cropped. */
export const QUAD_MARGIN_METERS = 0.006;
/** Where the window camera stands when the column has no usable seat. */
const FALLBACK_SEAT_METERS = 0.6;
/** How many first draws of the projection layer read their framebuffer back. */
const INSPECTED_DRAWS = 3;
/** Read-backs that may come back empty, with the menu in view, before the controls go back to the molecule pass. */
const EMPTY_READBACKS = 2;
/** Frames between two read-backs, so a fade-in or a first glyph upload has settled. */
const READBACK_SPACING_FRAMES = 36;
/** The cursor mark's side, and its texture. */
export const CURSOR_METERS = 0.014;
/**
 * Frames in a row a layer may have nothing to draw into (no colour texture,
 * no viewport, no camera for the quad) before the controls go back to the
 * molecule's pass. Such a frame draws no controls and raises no error.
 */
export const BLANK_LAYER_FRAMES = 3;
/**
 * A quad layer's `width` and `height` are measured from its centre to its
 * edge, so a quad that is to span `meters` is asked for half of that.
 */
export const quadExtent = meters => meters / 2;
const CURSOR_PIXELS = 32;
/** Samples per pixel the controls' projection layer is drawn with, where the browser can resolve them for free. */
export const CONTROLS_LAYER_SAMPLES = 4;
/**
 * How far the head may turn, in degrees, before the menu quad is drawn again
 * so its plates take the light as they would in the eye (`lightsSeenFrom`).
 */
export const MENU_RELIGHT_DEGREES = 3;

function record(detail) {
  try { globalThis.__stereofoldDiagnostics?.record?.(PRESENTATION_LAYER_DIAGNOSTIC, detail); }
  catch { /* A diagnostics sink must never cost the frame. */ }
}

/**
 * Which target the headset UI is drawn into when XR layers are on:
 * `?xrUi=quad` puts the menu column on a quad layer; anything else, or
 * nothing, keeps every control on one projection layer.
 */
export function presentationUiTarget(scope = globalThis) {
  let search = '';
  try { search = String(scope?.location?.search ?? ''); } catch { return 'projection'; }
  let value = null;
  try { value = new URLSearchParams(search).get('xrUi'); } catch { value = null; }
  return value === 'quad' ? 'quad' : 'projection';
}

// Column-major 4x4 helpers, in the layout Mol* `Mat4` uses.
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, n) => [a[0] * n, a[1] * n, a[2] * n];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const finite3 = v => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
function normalize(v) {
  const length = Math.hypot(v[0], v[1], v[2]);
  return Number.isFinite(length) && length > 1e-9 ? [v[0] / length, v[1] / length, v[2] / length] : undefined;
}

export function multiplyMatrix4(a, b) {
  const out = new Array(16);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      out[column * 4 + row] = a[row] * b[column * 4] + a[4 + row] * b[column * 4 + 1]
        + a[8 + row] * b[column * 4 + 2] + a[12 + row] * b[column * 4 + 3];
    }
  }
  return out;
}

function frustumMatrix(left, right, bottom, top, near, far) {
  const width = right - left, height = top - bottom, depth = far - near;
  return [2 * near / width, 0, 0, 0, 0, 2 * near / height, 0, 0,
    (right + left) / width, (top + bottom) / height, -(far + near) / depth, -1,
    0, 0, -2 * far * near / depth, 0];
}

/** A view matrix for a camera at `eye` whose x, y and z axes are given. */
function basisView(right, up, outward, eye) {
  return [right[0], up[0], outward[0], 0, right[1], up[1], outward[1], 0, right[2], up[2], outward[2], 0,
    -dot(right, eye), -dot(up, eye), -dot(outward, eye), 1];
}

function quaternionFromBasis(x, y, z) {
  const trace = x[0] + y[1] + z[2];
  let qx, qy, qz, qw;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    qw = 0.25 / s; qx = (y[2] - z[1]) * s; qy = (z[0] - x[2]) * s; qz = (x[1] - y[0]) * s;
  } else if (x[0] > y[1] && x[0] > z[2]) {
    const s = 2 * Math.sqrt(1 + x[0] - y[1] - z[2]);
    qw = (y[2] - z[1]) / s; qx = 0.25 * s; qy = (y[0] + x[1]) / s; qz = (z[0] + x[2]) / s;
  } else if (y[1] > z[2]) {
    const s = 2 * Math.sqrt(1 + y[1] - x[0] - z[2]);
    qw = (z[0] - x[2]) / s; qx = (y[0] + x[1]) / s; qy = 0.25 * s; qz = (z[1] + y[2]) / s;
  } else {
    const s = 2 * Math.sqrt(1 + z[2] - x[0] - y[1]);
    qw = (x[1] - y[0]) / s; qx = (z[0] + x[2]) / s; qy = (z[1] + y[2]) / s; qz = 0.25 * s;
  }
  const length = Math.hypot(qx, qy, qz, qw);
  return { x: qx / length, y: qy / length, z: qz / length, w: qw / length };
}

const roundUp = (value, step) => Math.ceil(value / step) * step;

/**
 * The quad layer that carries the menu column, from the column's glass.
 *
 * `plate` is `toolbar.menuPlate()`: the column's centre, axes and half extents
 * in XR room metres, and how far its content stands in front of (`front`)
 * and behind (`back`) that plane. A WebXR quad faces +z, so the quad's z axis
 * is the glass's outward normal (toward the wearer), its y axis the glass's
 * up, and its x axis their right-handed completion, which must agree with the
 * glass's own right or the plate is refused as mirrored.
 *
 * The texture is sized for `pixelsPerMeter`, rounded up to 16 pixels and
 * capped at `maxPixels` on its longer side without changing its aspect.
 *
 * @returns {undefined | {position:{x:number,y:number,z:number}, orientation:{x:number,y:number,z:number,w:number},
 *   width:number, height:number, viewPixelWidth:number, viewPixelHeight:number,
 *   centre:number[], right:number[], up:number[], outward:number[], halfWidth:number, halfHeight:number,
 *   front:number, back:number, seat?:number[]}}
 */
export function menuQuadLayout(plate, { pixelsPerMeter = QUAD_PIXELS_PER_METER, maxPixels = QUAD_MAX_PIXELS,
  marginMeters = QUAD_MARGIN_METERS } = {}) {
  if (!plate || !finite3(plate.point) || !finite3(plate.right) || !finite3(plate.up) || !finite3(plate.normal)) return undefined;
  if (!(plate.halfWidth > 0) || !(plate.halfHeight > 0)) return undefined;
  const outward = normalize(scale(plate.normal, -1));
  if (!outward) return undefined;
  const up = normalize(sub(plate.up, scale(outward, dot(plate.up, outward))));
  if (!up) return undefined;
  const right = cross(up, outward);
  if (dot(right, plate.right) <= 0) return undefined;
  const halfWidth = plate.halfWidth + marginMeters, halfHeight = plate.halfHeight + marginMeters;
  const width = 2 * halfWidth, height = 2 * halfHeight;
  let pixelWidth = roundUp(width * pixelsPerMeter, 16), pixelHeight = roundUp(height * pixelsPerMeter, 16);
  const longest = Math.max(pixelWidth, pixelHeight);
  if (longest > maxPixels) {
    const factor = maxPixels / longest;
    pixelWidth = Math.max(16, Math.floor(pixelWidth * factor / 16) * 16);
    pixelHeight = Math.max(16, Math.floor(pixelHeight * factor / 16) * 16);
  }
  const front = (Number.isFinite(plate.front) ? Math.max(0, plate.front) : 0) + SLAB_PAD_METERS;
  const back = (Number.isFinite(plate.back) ? Math.max(0, plate.back) : 0) + SLAB_PAD_METERS;
  const centre = [...plate.point];
  return { position: { x: centre[0], y: centre[1], z: centre[2] }, orientation: quaternionFromBasis(right, up, outward),
    width, height, viewPixelWidth: pixelWidth, viewPixelHeight: pixelHeight,
    centre, right, up, outward, halfWidth, halfHeight, front, back,
    ...(finite3(plate.seat) ? { seat: [...plate.seat] } : {}) };
}

/** How much larger than the column needs a new menu quad texture is made, so the column can grow a little into it. */
export const QUAD_TEXTURE_HEADROOM = 1.125;
/** How many times what the column needs a kept texture may be, on either side, before a smaller one is made. */
export const QUAD_TEXTURE_SLACK = 1.25;

/**
 * The texture a menu quad draws the column into. The quad layer maps its
 * whole texture onto the quad, and the column's camera frames the column's
 * own rectangle, so a texture of another size draws the same column, only
 * at another density. The current texture is kept while it holds the column
 * at no less than the density asked for and at most `QUAD_TEXTURE_SLACK`
 * times it on each side; otherwise a new one is sized with
 * `QUAD_TEXTURE_HEADROOM`. Without this a centimetre of change in the
 * column's size (a status row coming or going) destroyed and remade the layer.
 *
 * @param {{viewPixelWidth:number, viewPixelHeight:number}} layout `menuQuadLayout`
 * @param {{viewPixelWidth:number, viewPixelHeight:number}|undefined} current the texture the layer has
 * @param {number} [maxPixels]
 * @returns the current texture, the same object, or a new size
 */
export function quadTextureSize(layout, current, maxPixels = QUAD_MAX_PIXELS) {
  const fits = (have, need) => have >= need && have <= need * QUAD_TEXTURE_SLACK;
  if (current && fits(current.viewPixelWidth, layout.viewPixelWidth) && fits(current.viewPixelHeight, layout.viewPixelHeight)) return current;
  const grown = need => Math.max(need, Math.min(maxPixels, roundUp(need * QUAD_TEXTURE_HEADROOM, 16)));
  return { viewPixelWidth: grown(layout.viewPixelWidth), viewPixelHeight: grown(layout.viewPixelHeight) };
}

/** Two layouts that would draw the same quad with the same texture. */
export function sameQuadTexture(a, b) {
  return Boolean(a && b) && a.viewPixelWidth === b.viewPixelWidth && a.viewPixelHeight === b.viewPixelHeight;
}

function samePose(a, b) {
  if (!a || !b) return false;
  return ['x', 'y', 'z'].every(k => a.position[k] === b.position[k])
    && ['x', 'y', 'z', 'w'].every(k => a.orientation[k] === b.orientation[k])
    && a.width === b.width && a.height === b.height;
}

/**
 * The camera that draws the menu column onto its quad.
 *
 * It stands at the seat the column was placed for and looks through the
 * glass as a window: an off-axis frustum whose near rectangle is the quad,
 * scaled to the near plane. From that seat the quad then shows exactly what
 * the eye saw, which matters because each label is pushed along the seat's
 * sight line to stay over its plate (`toolbarTextPoint`); a camera square to
 * the glass would slide every label off its plate by up to a centimetre. A
 * column without a usable seat is drawn from straight in front.
 *
 * Mol* draws the presentation scene in scene units placed by the room lock,
 * `p_world = inverse(V) · p_room` for the canvas camera view `V` the lock was
 * applied with, so a camera whose room view is `W` has `view = W · V`. Its
 * scale is the canvas camera's, which is what keeps glyphs at their physical
 * size. Head rotation and the eye camera are zero, as on the stock eye path
 * with the rotation hold.
 *
 * @param layout `menuQuadLayout`
 * @param {{view:ArrayLike<number>, scale:number, state?:object}} canvasCamera
 * @param {{x:number,y:number,width:number,height:number}} viewport
 */
export function menuPanelCamera(layout, canvasCamera, viewport) {
  if (!layout || !canvasCamera?.view || !(Number.isFinite(canvasCamera.scale) && canvasCamera.scale > 0)) return undefined;
  const { centre, right, up, outward, halfWidth, halfHeight, front, back } = layout;
  let eye = layout.seat;
  if (!finite3(eye) || dot(sub(eye, centre), outward) < front + 0.05) eye = add(centre, scale(outward, FALLBACK_SEAT_METERS));
  const distance = dot(sub(eye, centre), outward);
  const near = Math.max(0.01, distance - front), far = distance + back;
  const offsetX = dot(sub(centre, eye), right), offsetY = dot(sub(centre, eye), up);
  const ratio = near / distance;
  const projection = frustumMatrix((offsetX - halfWidth) * ratio, (offsetX + halfWidth) * ratio,
    (offsetY - halfHeight) * ratio, (offsetY + halfHeight) * ratio, near, far);
  const roomView = basisView(right, up, outward, eye);
  const view = multiplyMatrix4(roomView, Array.from(canvasCamera.view));
  const projectionView = multiplyMatrix4(projection, view);
  const inverseView = invertMatrix4(view);
  if (!inverseView) return undefined;
  const cameraScale = canvasCamera.scale;
  const position = [inverseView[12], inverseView[13], inverseView[14]];
  const forward = [-inverseView[8], -inverseView[9], -inverseView[10]];
  const zero = new Array(16).fill(0);
  return {
    view, projection, projectionView, inverseProjectionView: invertMatrix4(projectionView) ?? zero,
    headRotation: zero, viewEye: zero, isAsymmetricProjection: true,
    state: { ...(canvasCamera.state ?? {}), mode: 'perspective', fog: 0,
      target: scale(add(position, forward), 1 / cameraScale) },
    viewOffset: { enabled: false, fullWidth: 1, fullHeight: 1, offsetX: 0, offsetY: 0, width: 1, height: 1 },
    viewport: { ...viewport }, near: near * cameraScale, far: far * cameraScale,
    fogNear: far * cameraScale, fogFar: far * cameraScale, forceFull: false, scale: cameraScale,
    minTargetDistance: 0, disabled: false,
  };
}

/**
 * The renderer's lights, turned so they fall on a surface drawn by the menu's
 * window camera as they fall on it in the wearer's eye.
 *
 * Mol* lights a surface in the frame of the camera that draws it: each light
 * has a fixed direction there, so the light rig rides on the wearer's head and
 * a plate's shade depends on how it is turned to the head. The window camera
 * looks square at the glass whatever the head is doing, so with the lights
 * left alone every plate is lit as if the wearer faced the column head on. A
 * column seated 29 degrees to the side came out a third brighter on its quad
 * than in the eye (the Talk row's green 103 against 76 on a Quest 2).
 *
 * Each direction is carried from the head's frame to the world and into the
 * window camera's frame, then written back as the inclination and azimuth the
 * renderer takes. Colours and intensities are untouched.
 *
 * @param {Array<{inclination:number, azimuth:number}>} lights `renderer.props.light`
 * @param {ArrayLike<number>} cameraView the drawing camera's view matrix
 * @param {ArrayLike<number>} headView the eye camera's view matrix
 */
export function lightsSeenFrom(lights, cameraView, headView) {
  const radians = Math.PI / 180;
  return lights.map(light => {
    const inclination = light.inclination * radians, azimuth = light.azimuth * radians;
    const inHead = [Math.cos(azimuth) * Math.sin(inclination), Math.sin(azimuth) * Math.sin(inclination), Math.cos(inclination)];
    // A view matrix turns world into camera, so its transpose turns camera into world.
    const world = [0, 1, 2].map(row => headView[row * 4] * inHead[0] + headView[row * 4 + 1] * inHead[1] + headView[row * 4 + 2] * inHead[2]);
    const seen = normalize([0, 1, 2].map(row => cameraView[row] * world[0] + cameraView[4 + row] * world[1] + cameraView[8 + row] * world[2]));
    if (!seen) return light;
    const turned = Math.atan2(seen[1], seen[0]) / radians;
    return { ...light, inclination: Math.acos(Math.max(-1, Math.min(1, seen[2]))) / radians, azimuth: turned < 0 ? turned + 360 : turned };
  });
}

/** The angle between two view matrices' orientations, in degrees. */
export function viewTurnDegrees(a, b) {
  if (!a || !b) return Infinity;
  let trace = 0;
  for (const index of [0, 1, 2, 4, 5, 6, 8, 9, 10]) trace += a[index] * b[index];
  return Math.acos(Math.max(-1, Math.min(1, (trace - 1) / 2))) * 180 / Math.PI;
}

/**
 * Whether a control stands in front of the menu column from where the wearer
 * looks: nearer the eye than the glass, and over its outline.
 *
 * `spheres` are the bounding spheres, in XR room metres, of the controls that
 * are not part of the column. Each is carried along its sight line onto the
 * plane of the glass and compared with the glass rectangle, its radius grown
 * as the sight line spreads. A sphere is a loose fit around a flat card, so
 * this answers yes for some cards that only come close; that costs nothing
 * unless another control behind the column overlaps it at the same moment.
 *
 * @param layout `menuQuadLayout`
 * @param {number[]} eye the eye, in room metres
 * @param {Iterable<{center:ArrayLike<number>, radius:number}>} spheres
 */
export function controlInFrontOfMenu(layout, eye, spheres) {
  if (!layout || !finite3(eye)) return false;
  const { centre, right, up, outward, halfWidth, halfHeight, front } = layout;
  const eyeAhead = dot(sub(eye, centre), outward);
  if (!(eyeAhead > front)) return false;
  for (const sphere of spheres ?? []) {
    const center = sphere?.center, radius = sphere?.radius;
    if (!center || !(radius >= 0)) continue;
    const at = [center[0], center[1], center[2]];
    if (!at.every(Number.isFinite)) continue;
    const ahead = dot(sub(at, centre), outward);
    // On the glass or behind it, or behind the eye.
    if (!(ahead > front) || ahead >= eyeAhead) continue;
    const spread = eyeAhead / (eyeAhead - ahead);
    const onGlass = sub(add(eye, scale(sub(at, eye), spread)), centre);
    const reach = radius * spread;
    if (Math.abs(dot(onGlass, right)) <= halfWidth + reach && Math.abs(dot(onGlass, up)) <= halfHeight + reach) return true;
  }
  return false;
}

/**
 * Remember the renderer, scene and eye cameras Mol* drew the molecular frame
 * with, by wrapping the draw pass's `render` on this one instance.
 *
 * Only a stereo draw to the drawing buffer is remembered, which on the
 * headset is the XR frame, and each draw is handed out once: a frame in which
 * Mol* drew nothing yields nothing, so the controls are never drawn against a
 * stale camera.
 */
export function captureMolecularDraw(drawPass) {
  if (!drawPass || typeof drawPass.render !== 'function') return undefined;
  const hadOwn = Object.prototype.hasOwnProperty.call(drawPass, 'render');
  const original = drawPass.render;
  let latest;
  function render(ctx, props, toDrawingBuffer, ...rest) {
    const result = original.call(this, ctx, props, toDrawingBuffer, ...rest);
    const camera = ctx?.camera;
    if (toDrawingBuffer && camera && 'left' in camera && 'right' in camera && ctx.renderer) {
      latest = { renderer: ctx.renderer, scene: ctx.scene, camera, colorTarget: this?.colorTarget };
    }
    return result;
  }
  drawPass.render = render;
  return {
    take() { const drawn = latest; latest = undefined; return drawn; },
    restore() {
      latest = undefined;
      if (drawPass.render !== render) return;
      if (hadOwn) drawPass.render = original;
      else delete drawPass.render;
    },
  };
}

/**
 * Draw the presentation scene into layer textures with Mol*'s own renderer.
 *
 * Each target is one texture (or one array layer) with the eyes drawn into
 * it. It is cleared once, whole, to transparent black, then each eye is drawn
 * in its own viewport. The result is premultiplied: Mol*'s blending of a
 * plate over a transparent clear leaves colour times alpha, which is what the
 * compositor blends with, and which equals drawing the plate over the
 * molecule directly.
 *
 * GL state goes through Mol*'s state cache wherever the cache tracks it, so
 * the cache stays true. What it does not track is restored here: the
 * framebuffer bindings, and the renderer's drawing-buffer size.
 *
 * `samples` above one asks for the edges of plates and glyphs to be
 * anti-aliased. A layer texture is single-sampled and a stock base layer on a
 * Quest asks for no multisampling either, so plate outlines come out
 * stair-stepped. Where the browser has `WEBGL_multisampled_render_to_texture`
 * the texture is attached through it instead: the GPU rasterises that many
 * samples per pixel and resolves them into the texture as it stores each tile,
 * with no second buffer and no blit. Without the extension, or if the browser
 * will not complete a framebuffer attached that way, the layer is drawn
 * single-sampled as before. A second, explicitly resolved buffer the size of
 * the eyes is never made: on a headset that costs more than the edges are worth.
 *
 * @param webgl Mol*'s WebGL context
 * @param {{samples?: number}} [options]
 */
export function createLayerDrawer(webgl, { samples = 0 } = {}) {
  const gl = webgl.gl, state = webgl.state;
  let framebuffer = null, depth = null, depthSize = [0, 0], depthAttached = false;
  let multisample = samples > 1 ? multisampledRenderToTexture(gl, samples) : null, multisampleSettled = false;
  function release() {
    try { if (framebuffer) gl.deleteFramebuffer(framebuffer); } catch { /* Lost with the context. */ }
    try { if (depth) gl.deleteRenderbuffer(depth); } catch { /* Lost with the context. */ }
    framebuffer = depth = null; depthSize = [0, 0]; depthAttached = false;
  }
  /** One private depth buffer, sized to the target and attached once. */
  function ensureDepth(width, height) {
    if (!depth || depthSize[0] !== width || depthSize[1] !== height) {
      if (!depth) depth = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
      // Depth has to carry as many samples as the colour it is drawn with.
      if (multisample) multisample.extension.renderbufferStorageMultisampleEXT(gl.RENDERBUFFER, multisample.samples, gl.DEPTH_COMPONENT24, width, height);
      else gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, width, height);
      gl.bindRenderbuffer(gl.RENDERBUFFER, null);
      depthSize = [width, height];
      depthAttached = false;
    }
    if (!depthAttached) {
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
      depthAttached = true;
    }
  }
  function attachColor(target) {
    if (Number.isInteger(target.imageIndex)) {
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, target.texture, 0, target.imageIndex);
    } else if (multisample) {
      multisample.extension.framebufferTexture2DMultisampleEXT(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target.texture, 0, multisample.samples);
    } else gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target.texture, 0);
  }
  /**
   * The first multisampled attachment is checked once. A framebuffer the
   * browser will not complete that way is attached again single-sampled, so
   * the layer is drawn as it was before rather than not at all.
   */
  function settleMultisample(target) {
    if (multisampleSettled || !multisample || Number.isInteger(target.imageIndex)) return;
    multisampleSettled = true;
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status === gl.FRAMEBUFFER_COMPLETE) { record({ phase: 'antialias', samples: multisample.samples }); return; }
    record({ phase: 'antialias', samples: 0, refused: status });
    multisample = null;
    detachColor(target);
    depthSize = [0, 0];
    ensureDepth(target.width, target.height);
    attachColor(target);
    // The refused attachment's errors are not the draw's.
    for (let i = 0; i < 8 && gl.getError(); i++);
  }
  function detachColor(target) {
    if (Number.isInteger(target.imageIndex)) gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, null, 0, 0);
    else gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0);
  }

  /**
   * @param {{renderer:any, group:any, uniformScene?:any, targets:Array<{texture:any, imageIndex?:number|null,
   *   width:number, height:number, eyes:Array<{camera:any, viewport:{x:number,y:number,width:number,height:number}}>}>,
   *   restoreSize?:[number,number], inspect?:boolean, readback?:ReturnType<typeof createReadback>,
   *   after?:(camera:any) => void}} job
   *   `group` is what the renderer draws: the presentation scene, or one of
   *   the two parts it is split into. `inspect` reads the first target's framebuffer status, its colour
   *   attachment and the GL errors around its draw, and returns them; each is a
   *   round trip to the GPU, so only the first frames ask. `readback` starts
   *   a read-back of the first target once it is drawn. `after` draws more
   *   into each eye once `group` is in it, depth-tested against it.
   * @returns {undefined | {status:any, colorAttachment:any, attachError:any, drawError:any, readback:boolean}}
   */
  function draw({ renderer, group, uniformScene, targets, restoreSize, inspect = false, readback, after }) {
    const drawBinding = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
    const readBinding = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
    let inspection;
    try {
      if (!framebuffer) framebuffer = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      for (const target of targets) {
        const first = target === targets[0];
        // Errors already raised by the molecule's pass are not this layer's.
        // WebGL keeps one flag per kind of error, so read until none is left.
        if (inspect && first) for (let i = 0; i < 8 && gl.getError(); i++);
        ensureDepth(target.width, target.height);
        attachColor(target);
        settleMultisample(target);
        if (inspect && first) {
          inspection = { status: gl.checkFramebufferStatus(gl.FRAMEBUFFER),
            colorAttachment: gl.getFramebufferAttachmentParameter(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
              gl.FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE),
            attachError: gl.getError(), drawError: null, readback: false };
        }
        // One whole clear: a full-surface clear lets a tiled GPU start the
        // pass without loading anything.
        state.disable(gl.SCISSOR_TEST);
        state.colorMask(true, true, true, true);
        state.depthMask(true);
        state.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        renderer.setDrawingBufferSize(target.width, target.height);
        for (const { camera, viewport } of target.eyes) {
          renderer.setViewport(viewport.x, viewport.y, viewport.width, viewport.height);
          // Stock Canvas3D updates the renderer with the molecular scene and
          // then draws the controls with the same uniforms; do the same.
          renderer.update(camera, uniformScene ?? group);
          renderer.renderBlended(group, camera);
          after?.(camera);
        }
        if (inspection && first) inspection.drawError = gl.getError();
        // The depth buffer is scratch for this layer: never store it.
        gl.invalidateFramebuffer?.(gl.FRAMEBUFFER, [gl.DEPTH_ATTACHMENT]);
        detachColor(target);
        // Read back once the texture is let go, which is when multisampled
        // colour has been resolved into it.
        if (readback && first) {
          const started = readback.start(target, target.width, target.height);
          if (inspection) inspection.readback = started;
          gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        }
      }
    } finally {
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, drawBinding);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, readBinding);
      if (restoreSize) renderer.setDrawingBufferSize(restoreSize[0], restoreSize[1]);
    }
    return inspection;
  }
  return { draw, release,
    /** Samples per pixel in use: none once the browser refused them or they were given up. */
    get samples() { return multisample ? multisample.samples : 0; },
    /** Draw single-sampled from the next draw on. */
    giveUpMultisample() {
      if (!multisample) return false;
      multisample = null; multisampleSettled = true;
      depthSize = [0, 0];
      return true;
    } };
}

/**
 * The browser's multisampled render-to-texture, when it has one: the
 * extension and how many samples to ask of it, `wanted` or the context's
 * limit if that is lower. `null` when the extension or either of its two
 * calls is missing, or one sample is all there is.
 */
function multisampledRenderToTexture(gl, wanted) {
  let extension = null;
  try { extension = gl.getExtension?.('WEBGL_multisampled_render_to_texture') ?? null; } catch { extension = null; }
  if (typeof extension?.framebufferTexture2DMultisampleEXT !== 'function'
    || typeof extension.renderbufferStorageMultisampleEXT !== 'function') return null;
  let limit;
  try { limit = gl.getParameter(gl.MAX_SAMPLES); } catch { limit = undefined; }
  const samples = Math.floor(Math.min(wanted, Number.isFinite(limit) && limit > 0 ? limit : wanted));
  return samples > 1 ? { extension, samples } : null;
}

/** The read-back's width in pixels; its height keeps the target's aspect. */
export const READBACK_WIDTH = 256;

/** Frames between starting a read-back and reading its pixels. */
const READBACK_LAG_FRAMES = 2;

/**
 * Look at what a drawn layer texture holds, without making the frame wait.
 *
 * The target is scaled down into a small buffer of its own (a linear blit, so
 * a plate a few dozen pixels wide still lands on a sample) and read into a
 * pixel buffer. `poll()` on each later frame answers from the
 * `READBACK_LAG_FRAMES`th: how many of the small buffer's pixels have any
 * alpha. By then the GPU finished that copy frames ago, so the read waits for
 * nothing but itself. (A fence would say exactly when, but Chromium did not
 * signal one in a WebXR frame loop within 40 frames.) Only the scissor test
 * touches a blit, and it goes through Mol*'s state cache; the pixel-pack
 * binding, which the cache does not track, is put back.
 *
 * The texture is attached to a framebuffer of this module's own for the copy,
 * single-sampled whatever it was drawn through: a scaling blit out of a
 * multisampled framebuffer is an error.
 */
export function createReadback(webgl, { width: readWidth = READBACK_WIDTH, lagFrames = READBACK_LAG_FRAMES } = {}) {
  const gl = webgl.gl, state = webgl.state;
  let framebuffer = null, color = null, buffer = null, size = null, waited = 0, source = null;
  /** `drawn` is the target that was just drawn: `{ texture, imageIndex }`. */
  function start(drawn, sourceWidth, sourceHeight) {
    if (size || !drawn?.texture || !positiveSize(sourceWidth, sourceHeight)) return false;
    const width = Math.min(readWidth, sourceWidth), height = Math.max(1, Math.round(sourceHeight * width / sourceWidth));
    framebuffer ??= gl.createFramebuffer(); color ??= gl.createRenderbuffer(); buffer ??= gl.createBuffer();
    source ??= gl.createFramebuffer();
    const layered = Number.isInteger(drawn.imageIndex);
    const renderbufferBinding = gl.getParameter(gl.RENDERBUFFER_BINDING);
    gl.bindRenderbuffer(gl.RENDERBUFFER, color);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, width, height);
    gl.bindRenderbuffer(gl.RENDERBUFFER, renderbufferBinding);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, source);
    if (layered) gl.framebufferTextureLayer(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, drawn.texture, 0, drawn.imageIndex);
    else gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, drawn.texture, 0);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, framebuffer);
    gl.framebufferRenderbuffer(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, color);
    state.disable(gl.SCISSOR_TEST);
    gl.blitFramebuffer(0, 0, sourceWidth, sourceHeight, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.LINEAR);
    // The layer's texture is the browser's for this frame only: let go of it.
    if (layered) gl.framebufferTextureLayer(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, null, 0, 0);
    else gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, framebuffer);
    const packBinding = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, width * height * 4, gl.STREAM_READ);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, packBinding);
    size = [width, height];
    waited = 0;
    return true;
  }
  /** `undefined` while nothing is read or it is too soon to look; then `{lit, of}`, once. */
  function poll() {
    if (!size || ++waited < lagFrames) return undefined;
    const [width, height] = size;
    size = null;
    const pixels = new Uint8Array(width * height * 4);
    const packBinding = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, pixels);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, packBinding);
    let lit = 0;
    for (let i = 3; i < pixels.length; i += 4) if (pixels[i] !== 0) lit++;
    return { lit, of: width * height };
  }
  function release() {
    try { if (framebuffer) gl.deleteFramebuffer(framebuffer); } catch { /* Lost with the context. */ }
    try { if (color) gl.deleteRenderbuffer(color); } catch { /* Lost with the context. */ }
    try { if (buffer) gl.deleteBuffer(buffer); } catch { /* Lost with the context. */ }
    try { if (source) gl.deleteFramebuffer(source); } catch { /* Lost with the context. */ }
    framebuffer = color = buffer = size = source = null;
  }
  return { start, poll, release, get pending() { return size !== null; } };
}

/**
 * Draw layer content over a still of one eye, the way the compositor blends
 * a premultiplied layer over what is beneath it.
 *
 * A still of the wearer's view is read from the molecule's layer
 * (`xr-snapshot.mjs`), which holds none of the controls. This puts them back,
 * into the still's small framebuffer and nowhere else:
 *
 * - `copy` scales a rectangle of a layer's texture into a texture of this
 *   module's own, with a blit. The layer's texture is the browser's and is
 *   only ever attached to a framebuffer, never sampled.
 * - `paint` draws one of this module's textures as a rectangle placed by a
 *   matrix, blended as premultiplied colour.
 *
 * Raw GL between `begin` and `end`: every state touched is read first and put
 * back through Mol*'s state cache, with the cache's program ids invalidated,
 * so the next molecular frame finds GL as it left it.
 */
export function createCaptureCompositor(webgl) {
  const gl = webgl.gl, state = webgl.state;
  let program, vao, buffer, uMvp, uLayer, source, canvas, old;
  const textures = new Map();
  const FLAGS = () => [gl.BLEND, gl.CULL_FACE, gl.DEPTH_TEST, gl.SCISSOR_TEST, gl.STENCIL_TEST];
  function compile(type, text) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, text); gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw Error('The capture layer shader did not compile.');
    return shader;
  }
  function initialize() {
    const vertex = compile(gl.VERTEX_SHADER, `#version 300 es
uniform mat4 uMvp;
in vec2 aCorner;
out vec2 vUv;
void main() { vUv = aCorner * 0.5 + 0.5; gl_Position = uMvp * vec4(aCorner, 0.0, 1.0); }`);
    const fragment = compile(gl.FRAGMENT_SHADER, `#version 300 es
precision mediump float;
uniform sampler2D uLayer;
in vec2 vUv;
out vec4 color;
void main() { color = texture(uLayer, vUv); }`);
    program = gl.createProgram();
    gl.attachShader(program, vertex); gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex); gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw Error('The capture layer program did not link.');
    uMvp = gl.getUniformLocation(program, 'uMvp'); uLayer = gl.getUniformLocation(program, 'uLayer');
    vao = gl.createVertexArray(); buffer = gl.createBuffer();
    const corner = gl.getAttribLocation(program, 'aCorner');
    gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(corner); gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);
    source = gl.createFramebuffer(); canvas = gl.createFramebuffer();
  }
  /** Take the still's framebuffer. Everything until `end` draws into it. */
  function begin(framebuffer, width, height) {
    old = { program: gl.getParameter(gl.CURRENT_PROGRAM), vao: gl.getParameter(gl.VERTEX_ARRAY_BINDING),
      array: gl.getParameter(gl.ARRAY_BUFFER_BINDING), unit: gl.getParameter(gl.ACTIVE_TEXTURE),
      draw: gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING), read: gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),
      viewport: Array.from(gl.getParameter(gl.VIEWPORT) ?? [0, 0, width, height]),
      blend: [gl.BLEND_SRC_RGB, gl.BLEND_DST_RGB, gl.BLEND_SRC_ALPHA, gl.BLEND_DST_ALPHA].map(name => gl.getParameter(name)),
      mask: Array.from(gl.getParameter(gl.COLOR_WRITEMASK) ?? [true, true, true, true]),
      depthMask: gl.getParameter(gl.DEPTH_WRITEMASK), enabled: FLAGS().map(flag => gl.isEnabled(flag)),
      framebuffer, width, height };
    gl.activeTexture(gl.TEXTURE0);
    old.texture = gl.getParameter(gl.TEXTURE_BINDING_2D);
    if (!program) initialize();
  }
  /** A texture of this module's own, by name, at this size. */
  function texture(name, width, height, mipmaps = false) {
    let held = textures.get(name);
    if (!held || held.width !== width || held.height !== height) {
      if (held) gl.deleteTexture(held.texture);
      held = { texture: gl.createTexture(), width, height };
      gl.bindTexture(gl.TEXTURE_2D, held.texture);
      gl.texStorage2D(gl.TEXTURE_2D, mipmaps ? 1 + Math.floor(Math.log2(Math.max(width, height))) : 1, gl.RGBA8, width, height);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mipmaps ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      textures.set(name, held);
    }
    return held.texture;
  }
  /** Scale `rect` of a layer texture into the named texture of this module's own, and return it. */
  function copy(name, layerTexture, rect, width, height) {
    const into = texture(name, width, height);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, source);
    gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, layerTexture, 0);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, canvas);
    gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, into, 0);
    state.disable(gl.SCISSOR_TEST);
    state.colorMask(true, true, true, true);
    gl.blitFramebuffer(rect.x, rect.y, rect.x + rect.width, rect.y + rect.height, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.LINEAR);
    // The layer's texture is the browser's for this frame only: let go of it.
    gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0);
    return into;
  }
  /**
   * Blend one of this module's textures over the still. `mvp` carries the
   * square from -1 to 1 into the still's clip space; without it the texture
   * covers the whole still. `mipmaps` rebuilds the chain first, for a texture
   * that is drawn much smaller than it is.
   */
  function paint(own, mvp, { mipmaps = false } = {}) {
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, old.framebuffer);
    for (const flag of [gl.CULL_FACE, gl.DEPTH_TEST, gl.SCISSOR_TEST, gl.STENCIL_TEST]) state.disable(flag);
    state.enable(gl.BLEND);
    state.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    state.colorMask(true, true, true, true);
    state.depthMask(false);
    state.viewport(0, 0, old.width, old.height);
    gl.useProgram(program); gl.bindVertexArray(vao);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, own);
    if (mipmaps) gl.generateMipmap(gl.TEXTURE_2D);
    gl.uniform1i(uLayer, 0);
    gl.uniformMatrix4fv(uMvp, false, new Float32Array(mvp ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  /** Put back everything `begin` found. */
  function end() {
    if (!old) return;
    const found = old; old = undefined;
    const flags = FLAGS();
    for (let i = 0; i < flags.length; i++) if (found.enabled[i]) state.enable(flags[i]); else state.disable(flags[i]);
    state.blendFuncSeparate(found.blend[0], found.blend[1], found.blend[2], found.blend[3]);
    state.colorMask(found.mask[0], found.mask[1], found.mask[2], found.mask[3]);
    state.depthMask(found.depthMask);
    state.viewport(found.viewport[0], found.viewport[1], found.viewport[2], found.viewport[3]);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, found.texture);
    gl.activeTexture(found.unit);
    gl.bindVertexArray(found.vao); gl.bindBuffer(gl.ARRAY_BUFFER, found.array); gl.useProgram(found.program);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, found.draw); gl.bindFramebuffer(gl.READ_FRAMEBUFFER, found.read);
    state.currentProgramId = state.currentRenderItemId = state.currentMaterialId = -1;
  }
  function release() {
    try {
      if (program) gl.deleteProgram(program);
      if (vao) gl.deleteVertexArray(vao);
      if (buffer) gl.deleteBuffer(buffer);
      if (source) gl.deleteFramebuffer(source);
      if (canvas) gl.deleteFramebuffer(canvas);
      for (const held of textures.values()) gl.deleteTexture(held.texture);
    } catch { /* Lost with the context. */ }
    program = vao = buffer = source = canvas = undefined;
    textures.clear();
  }
  return { begin, texture, copy, paint, end, release };
}

/**
 * The matrix that carries the square from -1 to 1 onto the menu quad as one
 * XR view sees it: the quad's own placement in the room, then the view. The
 * depth row is zeroed, so the rectangle is never cut by the view's near and
 * far planes, which follow the molecule and may stop short of the menu.
 *
 * @param layout `menuQuadLayout`
 * @param {{projectionMatrix:ArrayLike<number>, transform:{inverse:{matrix:ArrayLike<number>}}}} view
 */
export function menuQuadInView(layout, view) {
  const projection = view?.projectionMatrix, roomView = view?.transform?.inverse?.matrix;
  if (!layout || !projection || !roomView) return undefined;
  const { centre, right, up, outward, halfWidth, halfHeight } = layout;
  const model = [...scale(right, halfWidth), 0, ...scale(up, halfHeight), 0, ...outward, 0, ...centre, 1];
  const mvp = multiplyMatrix4(multiplyMatrix4(Array.from(projection), Array.from(roomView)), model);
  for (const index of [2, 6, 10, 14]) mvp[index] = 0;
  return mvp;
}

/**
 * The far plane the controls are drawn with, in metres, when the molecule's
 * is nearer.
 */
export const CONTROLS_FAR_METERS = 20;

/**
 * An eye camera for the controls' own layer: the molecule's eye camera with
 * the far plane of its projection moved out to `farMeters` when it is nearer.
 *
 * The molecule's far plane is the session's depth band, which the page widens
 * to take in the menu, but only from the toolbar's own depth range, and only
 * without a cutaway. On the stock path that is all the menu has. On its own
 * layer the controls share no depth with the molecule, so a far plane cut at
 * the structure (0.73 m in a desktop emulator, against a menu at 1.3 m) would
 * leave the whole layer empty for no gain. Everything else about the eye, its
 * view, frustum edges, near plane and viewport, is the molecule's, so the
 * controls land on the same pixels as before. Returns `eye` itself when its
 * projection is not a perspective one this can read.
 */
export function controlsEyeCamera(eye, { farMeters = CONTROLS_FAR_METERS, into } = {}) {
  const p = eye?.projection;
  if (!p || !eye.view || p[11] !== -1) return eye;
  const near = p[14] / (p[10] - 1), far = p[14] / (p[10] + 1);
  if (!(near > 0) || !Number.isFinite(far) || far >= farMeters || near >= farMeters) return eye;
  const projection = Array.from(p);
  projection[10] = -(farMeters + near) / (farMeters - near);
  projection[14] = -2 * farMeters * near / (farMeters - near);
  const projectionView = multiplyMatrix4(projection, Array.from(eye.view));
  const camera = Object.assign(into ?? {}, eye);
  camera.projection = projection;
  camera.projectionView = projectionView;
  camera.inverseProjectionView = invertMatrix4(projectionView) ?? eye.inverseProjectionView;
  return camera;
}

const positiveSize = (width, height) => Number.isSafeInteger(width) && width > 0 && Number.isSafeInteger(height) && height > 0;

/**
 * The whole texture a sub-image lives in: the sub-image's own
 * `colorTextureWidth`/`colorTextureHeight`, then the layer's
 * `textureWidth`/`textureHeight`, then `fallback`.
 */
function subImageSize(subImage, fallback, layer) {
  for (const [width, height] of [[subImage?.colorTextureWidth, subImage?.colorTextureHeight],
    [subImage?.textureWidth, subImage?.textureHeight], [layer?.textureWidth, layer?.textureHeight]]) {
    if (positiveSize(width, height)) return [width, height];
  }
  return fallback;
}

/**
 * The projection-layer targets for this frame: one per texture (or array
 * layer), each carrying the eyes that draw into it, in eye order.
 *
 * `imageIndex` names an array layer only on a `'texture-array'` layer, and is
 * ignored on any other. On a Quest 2 the controls' side-by-side `'texture'`
 * layer came back as two targets for its two eyes, on one texture: each eye's
 * sub-image carried its own image index. Taken at its word, that attaches a 2D
 * texture as an array layer, which GL refuses without throwing: the colour
 * attachment stays empty, and the layer is composited with nothing in it.
 *
 * @param {{textureType?: 'texture'|'texture-array', seen?: Array<object>}} [options]
 *   `textureType` is the one the layer was created with; `seen` collects what
 *   each view's sub-image reported, for diagnostics.
 */
export function projectionTargets(binding, layer, views, eyes, { textureType = 'texture', seen } = {}) {
  const targets = [];
  for (let index = 0; index < views.length && index < eyes.length; index++) {
    const camera = eyes[index];
    if (!camera || camera.disabled) continue;
    const subImage = binding.getViewSubImage(layer, views[index]);
    const viewport = subImage?.viewport;
    seen?.push({ imageIndex: subImage?.imageIndex ?? null, colorTextureWidth: subImage?.colorTextureWidth ?? null,
      colorTextureHeight: subImage?.colorTextureHeight ?? null,
      sameTexture: index > 0 && targets.some(t => t.texture === subImage?.colorTexture),
      viewport: viewport ? [viewport.x, viewport.y, viewport.width, viewport.height] : null });
    if (!subImage?.colorTexture || !viewport) continue;
    const imageIndex = textureType === 'texture-array' && Number.isInteger(subImage.imageIndex) ? subImage.imageIndex : null;
    let target = targets.find(t => t.texture === subImage.colorTexture && t.imageIndex === imageIndex);
    if (!target) {
      const [width, height] = subImageSize(subImage, [viewport.x + viewport.width, viewport.y + viewport.height], layer);
      target = { texture: subImage.colorTexture, imageIndex, width, height, eyes: [] };
      targets.push(target);
    }
    target.width = Math.max(target.width, viewport.x + viewport.width);
    target.height = Math.max(target.height, viewport.y + viewport.height);
    target.eyes.push({ camera, eye: views[index]?.eye ?? null,
      viewport: { x: viewport.x, y: viewport.y, width: viewport.width, height: viewport.height } });
  }
  return targets;
}

function setLayerProperty(layer, name, value) {
  try { layer[name] = value; return layer[name] === value; } catch { return false; }
}

function destroyLayer(layer) {
  try { layer?.destroy?.(); } catch { /* An ended session already released it. */ }
}

/**
 * Draw the presentation scene into its own XR layers for one session.
 *
 * Never throws. When a layer cannot be made, or a frame fails to draw, the
 * controls go back into the molecule's pass (the stock path) and the reason
 * is recorded, so the wearer always has a menu.
 *
 * @param {object} options
 * @param options.stack `getXrLayerStack(session)`
 * @param options.presentation `createPresentationScene(canvas)`
 * @param options.canvas Canvas3D, for its camera
 * @param options.drawPass Canvas3D's draw pass, whose renderer and eye cameras are reused
 * @param options.space the session's `local` reference space, which the room metres are in
 * @param {'projection'|'quad'} [options.target]
 * @param [options.getMenuPlate] `() => toolbar.menuPlate()`
 * @param [options.getAimPoint] `() => toolbar.aimPoint()`
 * @param [options.getAimAxes] `() => toolbar.aimAxes()`: the panel's axes, which
 *   orient the cursor when the menu has no glass to take them from
 * @param [options.getPointer] the controller rays and dots (`installXrPointer`),
 *   drawn after the controls on their layer as the stock pass draws them
 * @param [options.quadDensity] `menuQuadLayout` options: texture density, cap and margin
 * @param [options.scope] where `XRRigidTransform` lives
 */
export function attachPresentationLayers({ stack, presentation, canvas, drawPass, space, target = 'projection',
  getMenuPlate = () => undefined, getAimPoint = () => undefined, getAimAxes = () => undefined, getPointer = () => undefined,
  quadDensity = {}, scope = globalThis } = {}) {
  const facts = { target, state: 'stock', reason: '', frames: 0, quadDraws: 0, error: null };
  const stockResult = reason => {
    facts.reason = reason;
    record({ phase: 'stock', target, reason });
    return { dispose() {}, facts: () => ({ ...facts }) };
  };
  const binding = stack?.binding, gl = stack?.gl, session = stack?.session;
  if (!binding || !gl || typeof stack.setOverlayLayers !== 'function' || typeof stack.onAfterMolecularFrame !== 'function')
    return stockResult('no-layer-stack');
  const webgl = canvas?.webgl;
  if (!webgl?.state || webgl.gl !== gl) return stockResult('no-shared-context');
  if (typeof presentation?.useExternalDraw !== 'function') return stockResult('no-presentation');
  if (typeof binding.createProjectionLayer !== 'function' || typeof binding.getViewSubImage !== 'function')
    return stockResult('no-projection-layers');

  let uiLayer;
  try {
    uiLayer = binding.createProjectionLayer({ textureType: 'texture', depthFormat: 0, scaleFactor: 1 });
  } catch (error) { return stockResult(`projection-layer-refused: ${error?.message ?? error}`); }
  // The controls carry text: never foveate them. Translucent glass needs the
  // texture's alpha, premultiplied, which is what the drawer produces.
  const foveationOff = setLayerProperty(uiLayer, 'fixedFoveation', 0);
  const sourceAlpha = setLayerProperty(uiLayer, 'blendTextureSourceAlpha', true);

  const capture = captureMolecularDraw(drawPass);
  if (!capture) { destroyLayer(uiLayer); return stockResult('no-draw-pass'); }
  // The quad carries the menu column and nothing else, so it needs a
  // presentation that can hand the column over apart from the other controls.
  const quadAsked = target === 'quad' && typeof binding.createQuadLayer === 'function' && typeof binding.getSubImage === 'function';
  const handle = presentation.useExternalDraw({ separateMenuColumn: quadAsked });
  if (!handle) { capture.restore(); destroyLayer(uiLayer); return stockResult('presentation-unavailable'); }

  // The projection layer is where plate outlines showed stair-steps: it is
  // drawn at the eyes' own pixel grid. The quad is resampled by the compositor.
  const drawer = createLayerDrawer(webgl, { samples: CONTROLS_LAYER_SAMPLES });
  // The quad's texture is far smaller than the eye buffer. Sharing one drawer
  // resized its depth buffer to the quad on every menu redraw and back to the
  // eyes on the next frame, so each target keeps its own.
  const menuDrawer = createLayerDrawer(webgl);
  const quad = quadAsked && typeof handle.split === 'function';
  // Whether the controls really reach their layer is checked, not assumed: an
  // attachment GL refused composites as an empty layer with no error thrown.
  // The first draws read the framebuffer back; the first frames with the menu
  // in view read the drawn pixels back, of each layer that carries the column.
  const verify = { inspected: 0, readback: createReadback(webgl), probed: null, empties: { projection: 0, quad: 0 },
    nextAt: 0, verified: new Set() };
  let menuLayer, menuLayout, menuTexture, menuDrawnVersion = -1, menuJoinedAt = 0;
  // Which of the two is composited on top, as last recorded.
  let recordedTop;
  // The head's orientation the menu quad's plates were last lit for.
  let menuLitFor;
  let cursorLayer, cursorPainted = false, cursorJoinedAt = 0, frameIndex = 0;
  // The pointer taken out of the molecule's pass, drawn on the controls layer.
  let pointer;
  // What the latest frame put on each layer, for a still of the wearer's view
  // taken later in the same animation frame, and what draws it into one.
  let shown, compositor, stillDrawer, stopCaptures = () => {}, stopRetireWatch = () => {};
  // Reused each frame for the controls' eye cameras (`controlsEyeCamera`).
  const eyeCameras = [{}, {}];
  // Frames in a row each layer had nothing to draw into.
  const blank = { projection: 0, quad: 0 };
  let overlays = [];
  let disposed = false, unsubscribe = () => {};
  const RigidTransform = scope?.XRRigidTransform;

  function setOverlays(next) {
    if (next.length === overlays.length && next.every((layer, i) => layer === overlays[i])) return;
    stack.setOverlayLayers(next);
    overlays = next;
  }

  /**
   * The frame a layer was last added to the overlays. The list reaches the
   * render state on the next frame, so until then the layer is neither
   * composited nor ready for `getSubImage`. A quad made this frame and a kept
   * quad shown again after being hidden are alike here.
   */
  function joinedAt(layer, previous) {
    return overlays.includes(layer) ? previous : frameIndex;
  }

  function rigid(position, orientation) {
    return new RigidTransform(position, orientation);
  }

  function updateMenuLayer(frame) {
    const layout = menuQuadLayout(getMenuPlate(), quadDensity);
    if (!layout || !RigidTransform) {
      menuLayout = undefined;
      return undefined;
    }
    const texture = quadTextureSize(layout, menuLayer ? menuTexture : undefined, quadDensity.maxPixels ?? QUAD_MAX_PIXELS);
    if (!menuLayer || texture !== menuTexture) {
      destroyLayer(menuLayer);
      menuLayer = binding.createQuadLayer({ space, viewPixelWidth: texture.viewPixelWidth, viewPixelHeight: texture.viewPixelHeight,
        layout: 'mono', transform: rigid(layout.position, layout.orientation),
        width: quadExtent(layout.width), height: quadExtent(layout.height) });
      setLayerProperty(menuLayer, 'blendTextureSourceAlpha', true);
      menuTexture = texture;
      menuDrawnVersion = -1;
    } else if (!samePose(layout, menuLayout)) {
      menuLayer.transform = rigid(layout.position, layout.orientation);
      menuLayer.width = quadExtent(layout.width); menuLayer.height = quadExtent(layout.height);
      menuDrawnVersion = -1;
    }
    menuLayout = layout;
    return menuLayer;
  }

  /**
   * Run `draw` with the renderer's lights turned for `camera`, the menu's
   * window camera, so the column is lit as the wearer's eye sees it lit, and
   * put the lights back. A renderer whose lights cannot be read draws as is.
   */
  function withHeadLights(drawn, camera, draw) {
    const renderer = drawn.renderer, lights = renderer?.props?.light, head = drawn.camera?.left?.view;
    if (!Array.isArray(lights) || !lights.length || !head || typeof renderer.setProps !== 'function') return draw();
    renderer.setProps({ light: lightsSeenFrom(lights, camera.view, head) });
    try { return draw(); }
    finally { renderer.setProps({ light: lights }); }
  }

  /**
   * Draw the column onto its quad when it changed. True when this draw
   * started a read-back. A quad that needs drawing and has no texture,
   * viewport or camera for it shows no column at all, since the column is
   * left off the projection layer: `BLANK_LAYER_FRAMES` such frames in a row
   * hand the controls back to the molecule's pass.
   */
  function drawMenuLayer(frame, drawn, readback, column) {
    const version = presentation.contentVersion?.() ?? 0;
    const head = drawn.camera?.left?.view;
    const turned = Boolean(head) && viewTurnDegrees(head, menuLitFor) > MENU_RELIGHT_DEGREES;
    if (menuDrawnVersion === version && !menuLayer.needsRedraw && !readback && !turned) return false;
    const subImage = binding.getSubImage(menuLayer, frame);
    const viewport = subImage?.viewport;
    const camera = subImage?.colorTexture && viewport ? menuPanelCamera(menuLayout, canvas.camera, viewport) : undefined;
    if (!camera) {
      countBlank('quad', !subImage?.colorTexture ? 'no-texture' : !viewport ? 'no-viewport' : 'no-camera');
      return false;
    }
    blank.quad = 0;
    const [width, height] = subImageSize(subImage, [viewport.x + viewport.width, viewport.y + viewport.height], menuLayer);
    const inspection = withHeadLights(drawn, camera, () => menuDrawer.draw({ renderer: drawn.renderer, group: column,
      uniformScene: drawn.scene,
      targets: [{ texture: subImage.colorTexture, imageIndex: null, width, height, eyes: [{ camera, viewport }] }],
      restoreSize: colorTargetSize(drawn), inspect: facts.quadDraws === 0, readback }));
    menuDrawnVersion = version;
    menuLitFor = head ? Array.from(head) : undefined;
    if (facts.quadDraws++ === 0) checkInspection('quad', inspection);
    // Asked only while no read-back is in flight, so pending means this one.
    return Boolean(readback?.pending);
  }

  function updateCursor(frame) {
    const point = getAimPoint();
    const orientation = finite3(point) ? menuPlateOrientation(point) : undefined;
    if (!orientation || !RigidTransform || typeof binding.createQuadLayer !== 'function') return undefined;
    if (!cursorLayer) {
      cursorLayer = binding.createQuadLayer({ space, viewPixelWidth: CURSOR_PIXELS, viewPixelHeight: CURSOR_PIXELS,
        layout: 'mono', isStatic: true, transform: rigid({ x: point[0], y: point[1], z: point[2] }, orientation),
        width: quadExtent(CURSOR_METERS), height: quadExtent(CURSOR_METERS) });
      setLayerProperty(cursorLayer, 'blendTextureSourceAlpha', true);
      cursorPainted = false;
    } else cursorLayer.transform = rigid({ x: point[0], y: point[1], z: point[2] }, orientation);
    return cursorLayer;
  }

  /** The cursor is static: painted once, and again only if the compositor asks. */
  function paintCursorOnce(frame) {
    if (cursorPainted && !cursorLayer.needsRedraw) return;
    const subImage = binding.getSubImage(cursorLayer, frame);
    if (subImage?.colorTexture && subImage.viewport) { paintCursor(webgl, subImage); cursorPainted = true; }
  }

  /** Where an XR view's eye is, in room metres. */
  function eyePosition(view) {
    const at = view?.transform?.position;
    return at ? [at.x, at.y, at.z] : undefined;
  }

  /**
   * The bounding spheres of a group's visible objects, in room metres. The
   * renderer scales a scene-unit sphere by the camera scale to reach world
   * units, and the canvas camera view carries world units into the room, as
   * the room lock's own matrix does in reverse.
   */
  function roomSpheres(group) {
    const view = canvas.camera?.view, cameraScale = canvas.camera?.scale;
    const spheres = [];
    if (!view || !Number.isFinite(cameraScale)) return spheres;
    for (const renderable of group?.renderables ?? []) {
      if (!renderable.state?.visible || !renderable.values?.drawCount?.ref.value) continue;
      const sphere = renderable.values.boundingSphere?.ref.value;
      if (!sphere?.center || !(sphere.radius > 0)) continue;
      const x = sphere.center[0] * cameraScale, y = sphere.center[1] * cameraScale, z = sphere.center[2] * cameraScale;
      spheres.push({ center: [view[0] * x + view[4] * y + view[8] * z + view[12], view[1] * x + view[5] * y + view[9] * z + view[13],
        view[2] * x + view[6] * y + view[10] * z + view[14]], radius: sphere.radius * cameraScale });
    }
    return spheres;
  }

  /** The quad camera assumes the presentation scene adds no transform of its own. */
  function sceneViewIsIdentity() {
    const view = handle.scene?.view;
    if (!view) return true;
    for (let i = 0; i < 16; i++) if (view[i] !== (i % 5 === 0 ? 1 : 0)) return false;
    return true;
  }

  /**
   * How the cursor quad faces: as the column's glass, or, when the menu is
   * folded to one control and has no glass, as the panel's own axes.
   */
  function menuPlateOrientation(point) {
    if (menuLayout) return menuLayout.orientation;
    const fromPlate = menuQuadLayout(getMenuPlate(), quadDensity)?.orientation;
    if (fromPlate) return fromPlate;
    let axes;
    try { axes = getAimAxes(); } catch { axes = undefined; }
    return axes ? menuQuadLayout({ ...axes, point, halfWidth: CURSOR_METERS, halfHeight: CURSOR_METERS })?.orientation : undefined;
  }

  /**
   * On main the pointer's rays and dots are drawn after the controls, with
   * the molecule's depth cleared: over atoms, and depth-tested against the
   * glass. In the molecule's pass they would sit under atoms and under the
   * controls layer, so they leave it and are drawn on this layer instead.
   */
  function takePointer() {
    let next;
    try { next = getPointer(); } catch { next = undefined; }
    if (next === pointer) return;
    givePointerBack();
    if (typeof next?.setExternal !== 'function' || typeof next.drawExternal !== 'function') return;
    next.setExternal(true);
    pointer = next;
    record({ phase: 'pointer', target, layer: 'projection' });
  }

  function givePointerBack() {
    const taken = pointer;
    pointer = undefined;
    try { taken?.setExternal(false); } catch { /* A restored pointer is already in the molecule's pass. */ }
  }

  function colorTargetSize(drawn) {
    const target = drawn.colorTarget;
    try {
      const width = target?.getWidth?.(), height = target?.getHeight?.();
      return Number.isFinite(width) && Number.isFinite(height) ? [width, height] : undefined;
    } catch { return undefined; }
  }

  function countBlank(layer, why) {
    const frames = ++blank[layer];
    if (frames === 1) record({ phase: 'blank', target, layer, why, frames: facts.frames });
    if (frames >= BLANK_LAYER_FRAMES) throw Error(`The ${layer} layer had nothing to draw into for ${frames} frames in a row (${why}).`);
  }

  function fail(error) {
    facts.error = String(error?.message ?? error);
    record({ phase: 'failed', target, error: facts.error, frames: facts.frames });
    teardown('failed');
  }

  /**
   * A layer whose framebuffer is incomplete, or has no colour texture
   * attached, draws nothing and says nothing: hand the controls back.
   */
  function checkInspection(layer, inspection) {
    if (!inspection) return undefined;
    const found = { layer, status: glName(inspection.status), colorAttachment: glName(inspection.colorAttachment),
      attachError: glName(inspection.attachError), drawError: glName(inspection.drawError) };
    if (inspection.status !== gl.FRAMEBUFFER_COMPLETE || inspection.colorAttachment !== gl.TEXTURE) {
      throw Error(`The ${layer} layer cannot be drawn: framebuffer ${found.status}, colour attachment ${found.colorAttachment}, `
        + `attach error ${found.attachError}.`);
    }
    if (layer === 'quad' || (inspection.attachError !== gl.NO_ERROR || inspection.drawError !== gl.NO_ERROR))
      record({ phase: 'framebuffer', target, ...found });
    return found;
  }

  function glName(value) {
    if (value === null || value === undefined) return null;
    for (const name of ['NO_ERROR', 'INVALID_ENUM', 'INVALID_VALUE', 'INVALID_OPERATION', 'INVALID_FRAMEBUFFER_OPERATION',
      'OUT_OF_MEMORY', 'CONTEXT_LOST_WEBGL', 'FRAMEBUFFER_COMPLETE', 'FRAMEBUFFER_INCOMPLETE_ATTACHMENT',
      'FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT', 'FRAMEBUFFER_INCOMPLETE_DIMENSIONS', 'FRAMEBUFFER_UNSUPPORTED',
      'FRAMEBUFFER_INCOMPLETE_MULTISAMPLE', 'TEXTURE', 'RENDERBUFFER', 'NONE']) if (gl[name] === value) return name;
    return value;
  }

  /** Whether the menu column's centre is inside this eye's view. */
  function menuInView(camera) {
    const plate = getMenuPlate();
    if (!finite3(plate?.point) || !camera?.projectionView) return false;
    const roomToWorld = invertMatrix4(canvas.camera.view);
    if (!roomToWorld) return false;
    const m = multiplyMatrix4(Array.from(camera.projectionView), roomToWorld), [x, y, z] = plate.point;
    const cx = m[0] * x + m[4] * y + m[8] * z + m[12], cy = m[1] * x + m[5] * y + m[9] * z + m[13];
    const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
    return cw > 0 && Math.abs(cx) <= cw && Math.abs(cy) <= cw;
  }

  /**
   * The answer to a read-back started on an earlier frame. Pixels with any
   * alpha settle it; a layer that reads back empty `EMPTY_READBACKS` times
   * with the menu in view is broken, and the controls go back to the
   * molecule's pass.
   */
  function settleReadback() {
    if (!verify.probed) return;
    const result = verify.readback.poll();
    if (!result) return;
    const layer = verify.probed;
    verify.probed = null;
    // A few small GL objects, made again if another layer is to be read.
    verify.readback.release();
    if (result.lit > 0) {
      verify.verified.add(layer);
      record({ phase: 'verified', target, layer, lit: result.lit, of: result.of, frames: facts.frames });
      return;
    }
    // A multisampled draw that never reaches the texture would read back
    // empty too. Try the layer single-sampled before counting it as broken.
    if (layer === 'projection' && drawer.giveUpMultisample()) {
      record({ phase: 'antialias', samples: 0, refused: 'empty-readback' });
      verify.nextAt = frameIndex + 1;
      return;
    }
    const empties = ++verify.empties[layer];
    record({ phase: 'empty-readback', target, layer, of: result.of, frames: facts.frames, empties });
    if (empties >= EMPTY_READBACKS) throw Error(`The ${layer} layer read back empty ${empties} times with the menu in view.`);
    verify.nextAt = frameIndex + READBACK_SPACING_FRAMES;
  }

  function frameHook(frame, viewerPose) {
    if (disposed) return;
    const drawn = capture.take();
    shown = undefined;
    if (!drawn) return;
    try {
      // Every GL object here, and the layers themselves, die with the
      // context. Give the controls back to the molecule pass rather than draw
      // with stale objects after a restore.
      if (gl.isContextLost?.() || webgl.isContextLost) { teardown('context-lost'); return; }
      let views = viewerPose?.views;
      if (!views?.length) { try { views = frame?.getViewerPose?.(space)?.views; } catch { views = undefined; } }
      if (!views?.length) return;
      handle.prepare();
      frameIndex++;
      settleReadback();
      const next = [uiLayer];
      // The scene in its two parts, on a frame the column is drawn on its quad.
      let parts;
      if (quad && sceneViewIsIdentity()) {
        const layer = updateMenuLayer(frame);
        if (layer) {
          menuJoinedAt = joinedAt(layer, menuJoinedAt);
          // A quad that joins the overlays this frame is drawn from the next,
          // so until then the column stays on the projection layer rather
          // than vanish a frame.
          if (menuJoinedAt < frameIndex) parts = handle.split();
          // Above the other controls, unless one of them stands in front.
          const top = parts && controlInFrontOfMenu(menuLayout, eyePosition(views[0]), roomSpheres(parts.rest)) ? 'controls' : 'menu';
          if (top === 'controls') next.unshift(layer); else next.push(layer);
          if (top !== recordedTop) { recordedTop = top; record({ phase: 'layer-order', target, top, frames: facts.frames }); }
        }
      }
      const cursor = updateCursor(frame);
      if (cursor) { next.push(cursor); cursorJoinedAt = joinedAt(cursor, cursorJoinedAt); }
      setOverlays(next);
      const seen = facts.frames === 0 ? [] : undefined;
      const eyes = [controlsEyeCamera(drawn.camera.left, { into: eyeCameras[0] }),
        controlsEyeCamera(drawn.camera.right, { into: eyeCameras[1] })];
      const targets = projectionTargets(binding, uiLayer, views, eyes,
        { textureType: 'texture', seen });
      if (targets.length) blank.projection = 0; else countBlank('projection', 'no-texture');
      // A read-back looks at whichever layer carries the menu column this
      // frame, once the menu is in view.
      const carrier = parts ? 'quad' : 'projection';
      const readback = !verify.verified.has(carrier) && !verify.probed && !verify.readback.pending
        && frameIndex >= verify.nextAt && menuInView(eyes[0]) ? verify.readback : undefined;
      takePointer();
      const after = pointer ? camera => pointer.drawExternal(drawn.renderer, camera) : undefined;
      const inspection = drawer.draw({ renderer: drawn.renderer, group: parts ? parts.rest : handle.scene,
        uniformScene: drawn.scene, targets, restoreSize: colorTargetSize(drawn), inspect: verify.inspected < INSPECTED_DRAWS,
        readback: parts ? undefined : readback, after });
      if (inspection) verify.inspected++;
      // A multisampled draw that raises a GL error drew nothing that can be
      // trusted: from the next frame the layer is drawn single-sampled.
      if (inspection && inspection.drawError !== gl.NO_ERROR && drawer.giveUpMultisample())
        record({ phase: 'antialias', samples: 0, refused: glName(inspection.drawError) });
      if (readback && !parts && readback.pending) verify.probed = 'projection';
      const checked = checkInspection('projection', inspection);
      // A layer that joined the overlays this frame is drawn from the next
      // one, after the render state that lists it has been applied.
      if (parts && drawMenuLayer(frame, drawn, readback, parts.column)) verify.probed = 'quad';
      if (cursor && cursorJoinedAt < frameIndex) paintCursorOnce(frame);
      shown = { targets, drawn, column: parts ? { layout: menuLayout, group: parts.column } : undefined,
        columnBeneath: next[0] !== uiLayer };
      if (facts.frames++ === 0) record({ phase: 'first-frame', target, targets: targets.length,
        eyes: targets.reduce((n, t) => n + t.eyes.length, 0), quad: Boolean(menuLayer),
        size: targets.map(t => [t.width, t.height]), subImages: seen, framebuffer: checked ?? null });
    } catch (error) { fail(error); }
  }

  /**
   * Draw this frame's controls over a still of one eye (`stack.onCapture`).
   *
   * The projection layer's texture already holds that eye's controls at full
   * size, so its rectangle is scaled into the still. The menu quad's texture
   * is only drawn when the menu changes and cannot be read back on a later
   * frame, so the column is drawn again, from the same seat and at the same
   * size, into a texture of this module's own and placed as the quad is. The
   * two go down in the order the compositor stacks them. The cursor mark is
   * left out. Runs only for a capture; true once the controls are in.
   */
  function paintStill({ view, framebuffer, width, height } = {}) {
    if (disposed || !shown || !framebuffer || !positiveSize(width, height)) return false;
    let found;
    for (const layerTarget of shown.targets) for (const eye of layerTarget.eyes) {
      if (!found || (view?.eye && eye.eye === view.eye && found.eye.eye !== view.eye)) found = { layerTarget, eye };
    }
    if (!found) return false;
    const column = shown.column, placed = column ? menuQuadInView(column.layout, view) : undefined;
    compositor ??= createCaptureCompositor(webgl);
    let columnTexture;
    if (column && placed) {
      // Drawn before the still is taken up, since the renderer binds its own target.
      const { viewPixelWidth: w, viewPixelHeight: h } = column.layout, viewport = { x: 0, y: 0, width: w, height: h };
      const camera = menuPanelCamera(column.layout, canvas.camera, viewport);
      if (camera) {
        compositor.begin(framebuffer, width, height);
        try { columnTexture = compositor.texture('column', w, h, true); } finally { compositor.end(); }
        stillDrawer ??= createLayerDrawer(webgl);
        withHeadLights(shown.drawn, camera, () => stillDrawer.draw({ renderer: shown.drawn.renderer, group: column.group,
          uniformScene: shown.drawn.scene,
          targets: [{ texture: columnTexture, imageIndex: null, width: w, height: h, eyes: [{ camera, viewport }] }],
          restoreSize: colorTargetSize(shown.drawn) }));
      }
    }
    compositor.begin(framebuffer, width, height);
    try {
      const paintColumn = () => { if (columnTexture) compositor.paint(columnTexture, placed, { mipmaps: true }); };
      if (shown.columnBeneath) paintColumn();
      compositor.paint(compositor.copy('controls', found.layerTarget.texture, found.eye.viewport, width, height));
      if (!shown.columnBeneath) paintColumn();
    } finally { compositor.end(); }
    return !column || Boolean(columnTexture);
  }

  function teardown(reason) {
    if (disposed) return;
    disposed = true;
    shown = undefined;
    try { stopCaptures(); } catch { /* The stack may already be gone. */ }
    try { stopRetireWatch(); } catch { /* The stack may already be gone. */ }
    try { unsubscribe(); } catch { /* The stack may already be gone. */ }
    givePointerBack();
    capture.restore();
    try { stack.setOverlayLayers([]); } catch { /* An ended session takes no render state. */ }
    overlays = [];
    for (const layer of [uiLayer, menuLayer, cursorLayer]) destroyLayer(layer);
    menuLayer = cursorLayer = undefined;
    if (!(gl.isContextLost?.() ?? false) && !webgl.isContextLost) {
      drawer.release(); menuDrawer.release(); verify.readback.release(); stillDrawer?.release(); compositor?.release();
    }
    handle.release();
    facts.state = reason === 'failed' || reason === 'context-lost' || reason === 'molecule-layer-retired' ? 'stock' : 'ended';
    try { session?.removeEventListener?.('end', onEnd); } catch { /* Already ended. */ }
    record({ phase: 'detached', target, reason, frames: facts.frames, quadDraws: facts.quadDraws });
  }
  const onEnd = () => teardown('session-end');

  try {
    setOverlays([uiLayer]);
    unsubscribe = stack.onAfterMolecularFrame(frameHook) ?? (() => {});
    stopCaptures = stack.onCapture?.(paintStill) ?? (() => {});
    // If the molecule's layer is given up for a stock base layer, nothing
    // composites these layers any more: the controls go back to the
    // molecule's pass, which the stock layer shows.
    stopRetireWatch = stack.onRetire?.(() => teardown('molecule-layer-retired')) ?? (() => {});
    session?.addEventListener?.('end', onEnd, { once: true });
  } catch (error) {
    facts.error = String(error?.message ?? error);
    teardown('failed');
    return stockResult(`attach-failed: ${facts.error}`);
  }
  facts.state = 'layered';
  record({ phase: 'attached', target, quad, foveationOff, sourceAlpha, samples: drawer.samples });
  return { dispose: () => teardown('disposed'), facts: () => ({ ...facts }) };
}

/**
 * Paint the cursor mark once into its static quad: a white square inside a
 * dark rim, premultiplied. Two scissored clears, so no program is needed.
 */
function paintCursor(webgl, subImage) {
  const gl = webgl.gl, state = webgl.state;
  const { x, y, width, height } = subImage.viewport;
  const drawBinding = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING), readBinding = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
  const framebuffer = gl.createFramebuffer();
  const scissorOn = gl.isEnabled(gl.SCISSOR_TEST), scissor = Array.from(gl.getParameter(gl.SCISSOR_BOX));
  try {
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, subImage.colorTexture, 0);
    state.colorMask(true, true, true, true);
    state.enable(gl.SCISSOR_TEST);
    const square = (inset, r, g, b, a) => {
      const pixels = Math.round(width * inset);
      state.scissor(x + pixels, y + pixels, Math.max(1, width - 2 * pixels), Math.max(1, height - 2 * pixels));
      state.clearColor(r * a, g * a, b * a, a);
      gl.clear(gl.COLOR_BUFFER_BIT);
    };
    square(0, 0, 0, 0, 0);
    square(0.125, 0.05, 0.08, 0.12, 0.85);
    square(0.3125, 1, 1, 1, 1);
  } finally {
    if (scissorOn) state.enable(gl.SCISSOR_TEST); else state.disable(gl.SCISSOR_TEST);
    state.scissor(scissor[0], scissor[1], scissor[2], scissor[3]);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, drawBinding);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, readBinding);
    gl.deleteFramebuffer(framebuffer);
  }
}
