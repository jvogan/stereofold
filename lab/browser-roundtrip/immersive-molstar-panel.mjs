/**
 * The full Mol* viewer as a panel in the room.
 *
 * Phase 1 made leaving immersion for Mol* graceful. This is the attempt not to
 * leave at all: a quad in the XR scene, textured from a second Mol* canvas
 * living in the same document, with the controller ray driving that canvas so a
 * pick works. Everything here is the arithmetic of that panel — where it sits,
 * how large its texture may be, when the texture is allowed to be re-uploaded,
 * and where on the foreign canvas a controller ray lands. It imports nothing,
 * so `node --test` verifies all of it without a renderer or a headset.
 *
 * Read the in-scene Mol* notes before wiring any of this
 * to a live page. The short version, because it decides how this module is
 * shaped:
 *
 * - The INPUT half is not a blocker. Mol* has a first-class tracked-pointer
 *   input API (`mol-util/input/input-observer.js`, `updateTrackedPointers`,
 *   `TrackedPointerInput = {handedness, buttons, x, y, dx, dy, ray}`), and the
 *   immersive page already drives it from `xr-manager.js`. A second Mol*
 *   instance is fed the same way, with `x`/`y` in ITS canvas pixels. Synthetic
 *   DOM pointer events are the fallback, and they work too: `eventOffset` reads
 *   `(ev.clientX || 0) - rect.left` against `element.getBoundingClientRect()`
 *   (input-observer.js:875-878), so a made-up `clientX`/`clientY` lands exactly
 *   where this module puts it. Both routes are built below.
 *
 * - The TEXTURE half is the blocker. Mol*'s own `Image` geometry takes a
 *   CPU-side `TextureImage<Uint8Array>` (`mol-geo/geometry/image/image.d.ts`),
 *   so going through a Mol* representation costs a GPU-to-CPU readback of the
 *   whole panel every update, on a tiled mobile GPU, inside the XR frame. The
 *   numbers are in the notes; they are what `MOLSTAR_PANEL_MAX_TEXELS` and the
 *   upload gate below exist to bound.
 *
 * - The CONTROLS do not come. The full viewer's value is its React panels —
 *   Quick Styles, Components, Measurements — and DOM cannot be textured into
 *   WebGL in Quest Browser. A quad can carry Mol*'s viewport and nothing else.
 *
 * Off by default. `immersiveMolstarPanelEnabled` reads one render-budget knob,
 * `molstarPanel:on`, and everything here stays unbuilt without it.
 */

/** The knob that turns the prototype on. Off is the shipped answer. */
export const MOLSTAR_PANEL_KNOB = 'molstarPanel';

/**
 * Whether the in-scene Mol* panel is on for this page.
 *
 * Read from the same `?xrRenderBudget=` list every other immersive A/B uses, so
 * the prototype needs no second flag mechanism and no build. Absent, malformed
 * and unknown all mean off: this is an experiment with a measured cost, and a
 * wearer must never meet it by accident.
 */
export function immersiveMolstarPanelEnabled(overrides) {
  return overrides?.molstarPanel === true;
}

/**
 * The most texels one panel may hold on a Quest 2.
 *
 * 512 x 512 is 262,144 texels and exactly 1 MiB at RGBA8. That is the size at
 * which one readback plus one upload stays inside a tenth of a 72 Hz frame on
 * the bandwidth a Quest 2 actually has. A
 * Quest 3 has room for the next step up, which is why the cap is a parameter
 * rather than a constant folded into the sizing.
 */
export const MOLSTAR_PANEL_MAX_TEXELS = Object.freeze({ quest2: 512 * 512, quest3: 1024 * 1024, unknown: 512 * 512 });

/** Bytes per texel at RGBA8, which is the only format a canvas upload gives. */
export const MOLSTAR_PANEL_BYTES_PER_TEXEL = 4;

/**
 * How much of the panel's angular size is worth resolving.
 *
 * A Quest 2 lens is about 20.4 rendered pixels per degree at the eye buffer
 * this build asks for — measured, in `spatial-toolbar-geometry.mjs`, off the
 * wearer captures. A panel 0.6 m wide at the 0.95 m menu seat
 * subtends 2 * atan(0.3 / 0.95) = 34.6 degrees, so 706 eye pixels across it.
 * Resolving past that buys nothing a wearer can see, and the cap below usually
 * bites first anyway.
 */
export const MOLSTAR_PANEL_EYE_PIXELS_PER_DEGREE = 20.4;

/** Texture sizes are kept to multiples of this, so uploads stay row-aligned. */
export const MOLSTAR_PANEL_SIZE_STEP = 32;

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const finite = value => typeof value === 'number' && Number.isFinite(value);
const finite3 = value => Array.isArray(value) && value.length === 3 && value.every(finite);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scaled = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const EPSILON = 1e-6;

function unit(value) {
  if (!finite3(value)) return undefined;
  const length = Math.hypot(...value);
  return length > EPSILON ? scaled(value, 1 / length) : undefined;
}

/** Round down to the size step, never below one step. */
function stepped(value) {
  return Math.max(MOLSTAR_PANEL_SIZE_STEP, Math.floor(value / MOLSTAR_PANEL_SIZE_STEP) * MOLSTAR_PANEL_SIZE_STEP);
}

/**
 * The texture size for one panel: what the eye can resolve, capped by what the
 * device can move.
 *
 * The aspect ratio of the panel in metres is kept, because the foreign canvas
 * is sized to this and a canvas whose aspect does not match its quad shows a
 * stretched molecule. Both dimensions are stepped down rather than up: a
 * texture slightly smaller than the ideal is a slightly soft panel, and a
 * texture over the cap is a dropped frame.
 *
 * @param {object} options
 * @param {number} options.widthMeters panel width in the room
 * @param {number} options.heightMeters panel height in the room
 * @param {number} [options.rangeMeters] how far the panel sits from the eye
 * @param {string} [options.deviceClass] 'quest2', 'quest3', …
 * @param {number} [options.maxTexels] overrides the device cap
 * @returns {{width: number, height: number, texels: number, bytes: number, limited: 'device'|'eye'}}
 */
export function molstarPanelResolution({ widthMeters, heightMeters, rangeMeters = 0.95,
  deviceClass = 'unknown', maxTexels } = {}) {
  const width = finite(widthMeters) && widthMeters > 0 ? widthMeters : 0.6;
  const height = finite(heightMeters) && heightMeters > 0 ? heightMeters : 0.45;
  const range = finite(rangeMeters) && rangeMeters > 0 ? rangeMeters : 0.95;
  const cap = finite(maxTexels) && maxTexels > 0
    ? maxTexels
    : MOLSTAR_PANEL_MAX_TEXELS[deviceClass] ?? MOLSTAR_PANEL_MAX_TEXELS.unknown;
  // What the lens resolves across the panel, from the angle it subtends.
  const degreesAcross = 2 * Math.atan(width / 2 / range) * 180 / Math.PI;
  const eyeWide = degreesAcross * MOLSTAR_PANEL_EYE_PIXELS_PER_DEGREE;
  const aspect = height / width;
  // Two candidates, both at the panel's aspect: what the eye wants, and the
  // largest that fits the texel cap. The smaller wins, and says which it was.
  const capWide = Math.sqrt(cap / aspect);
  const limited = capWide < eyeWide ? 'device' : 'eye';
  const chosenWide = Math.min(eyeWide, capWide);
  let textureWidth = stepped(chosenWide);
  let textureHeight = stepped(chosenWide * aspect);
  // Stepping is a floor on each axis independently, so the product can still
  // creep over the cap on a wide panel. Shrink the long axis until it does not.
  while (textureWidth * textureHeight > cap && textureWidth > MOLSTAR_PANEL_SIZE_STEP) {
    if (textureWidth >= textureHeight) textureWidth -= MOLSTAR_PANEL_SIZE_STEP;
    else textureHeight -= MOLSTAR_PANEL_SIZE_STEP;
  }
  const texels = textureWidth * textureHeight;
  return { width: textureWidth, height: textureHeight, texels,
    bytes: texels * MOLSTAR_PANEL_BYTES_PER_TEXEL, limited };
}

/** The upload ceiling, as a rate rather than a per-frame budget. */
export const MOLSTAR_PANEL_MAX_UPLOAD_HZ = 12;

/**
 * When the panel's texture may be re-uploaded.
 *
 * Two rules. First: only when Mol* has drawn.
 * The second instance is idle most of the time — nobody is spinning it, its
 * camera does not move with the head — so a per-frame upload would spend a
 * Quest 2's bandwidth copying a picture that did not change. Mol* says when it
 * drew, through `canvas3d.didDraw` (`mol-canvas3d/canvas3d.d.ts:731`), and this
 * gate takes that as the only reason to upload at all.
 *
 * Second: never faster than `maxHz`. A wearer dragging the structure makes Mol*
 * draw on every one of ITS frames, which on a desktop-shaped canvas is as fast
 * as it can go, and the XR loop cannot afford one upload per XR frame. Twelve a
 * second is a panel that tracks a drag visibly while leaving the frame budget
 * to the scene the wearer is standing in.
 *
 * The gate is a decision, not a side effect, so the whole policy is testable
 * against a fake clock.
 */
export function createMolstarPanelUploadGate({ maxHz = MOLSTAR_PANEL_MAX_UPLOAD_HZ, now = Date.now } = {}) {
  const minimumGapMs = maxHz > 0 ? 1000 / maxHz : Infinity;
  let drawnAt, uploadedAt, drawnSinceUpload = false;
  let uploads = 0, draws = 0, skippedClean = 0, skippedFast = 0;
  return {
    /** Mol* finished a frame on the panel's own canvas. */
    markDrawn(at = now()) {
      draws += 1;
      drawnAt = at;
      drawnSinceUpload = true;
    },
    /** Whether this XR frame should copy the canvas into the panel texture. */
    shouldUpload(at = now()) {
      if (!drawnSinceUpload) { skippedClean += 1; return false; }
      if (uploadedAt !== undefined && at - uploadedAt < minimumGapMs) { skippedFast += 1; return false; }
      return true;
    },
    /** Record one upload. Called only after the copy actually happened. */
    noteUploaded(at = now()) {
      uploads += 1;
      uploadedAt = at;
      drawnSinceUpload = false;
    },
    /**
     * What the headset log reads back afterwards. `skippedClean` is the gate
     * earning its place: a large number there is a panel that was idle and
     * cost nothing.
     */
    stats: () => ({ draws, uploads, skippedClean, skippedFast,
      ...(drawnAt === undefined ? {} : { drawnAt }), ...(uploadedAt === undefined ? {} : { uploadedAt }) }),
  };
}

/**
 * The quad itself, in XR local metres.
 *
 * Built on the same basis a toolbar panel is — anchor, right, up, normal — so a
 * ray that can hit the menu can hit this with the same arithmetic, and the two
 * can be seated from one head pose. `createToolbarPanel` in
 * `spatial-toolbar-geometry.mjs` is where that basis comes from on a live page;
 * this takes it as an argument rather than importing it, because the panel may
 * also be seated beside the menu rather than on it.
 *
 * @returns {{anchor: number[], right: number[], up: number[], normal: number[],
 *   halfWidth: number, halfHeight: number, corners: number[][]}|undefined}
 */
export function molstarPanelQuad({ anchor, right, up, widthMeters = 0.6, heightMeters = 0.45 } = {}) {
  const r = unit(right), u = unit(up);
  if (!finite3(anchor) || !r || !u) return undefined;
  if (!(widthMeters > 0) || !(heightMeters > 0)) return undefined;
  // A basis handed in from a head pose is square to within rounding, but not
  // exactly, and a skewed quad puts the pick a few pixels off the pointer.
  // Re-square `up` against `right` and take the normal from the pair.
  const upSquared = unit(sub(u, scaled(r, dot(u, r))));
  if (!upSquared) return undefined;
  const normal = unit([
    r[1] * upSquared[2] - r[2] * upSquared[1],
    r[2] * upSquared[0] - r[0] * upSquared[2],
    r[0] * upSquared[1] - r[1] * upSquared[0],
  ]);
  if (!normal) return undefined;
  const halfWidth = widthMeters / 2, halfHeight = heightMeters / 2;
  const across = scaled(r, halfWidth), down = scaled(upSquared, halfHeight);
  return {
    anchor: [...anchor], right: r, up: upSquared, normal, halfWidth, halfHeight,
    // Counter-clockwise from the bottom-left, which is the winding Mol*'s
    // `Image` corner buffer and a plain two-triangle mesh both expect.
    corners: [
      sub(sub(anchor, across), down), add(sub(anchor, down), across),
      add(add(anchor, across), down), add(sub(anchor, across), down),
    ],
  };
}

/**
 * Where a controller ray lands on the panel, as texture coordinates.
 *
 * `v` runs DOWN from the top edge, because everything downstream — canvas
 * pixels, `clientY`, Mol*'s `eventOffset` — counts rows from the top, and one
 * flip in one place is cheaper than a flip at every call site.
 *
 * A ray that misses the quad answers undefined rather than a clamped edge hit:
 * a pointer parked on the rim would keep Mol* highlighting whatever is under
 * the corner while the wearer looks somewhere else entirely.
 *
 * @returns {{u: number, v: number, distance: number, point: number[]}|undefined}
 */
export function hitMolstarPanel(quad, ray) {
  if (!quad || !finite3(ray?.origin)) return undefined;
  const direction = unit(ray?.direction);
  if (!direction) return undefined;
  const divisor = dot(direction, quad.normal);
  if (Math.abs(divisor) <= EPSILON) return undefined;
  const distance = dot(sub(quad.anchor, ray.origin), quad.normal) / divisor;
  if (!Number.isFinite(distance) || distance < 0) return undefined;
  const point = add(ray.origin, scaled(direction, distance));
  const offset = sub(point, quad.anchor);
  const across = dot(offset, quad.right) / quad.halfWidth;
  const upwards = dot(offset, quad.up) / quad.halfHeight;
  if (Math.abs(across) > 1 || Math.abs(upwards) > 1) return undefined;
  return { u: (across + 1) / 2, v: (1 - upwards) / 2, distance, point };
}

/**
 * One tracked-pointer update for the panel's own Mol*, from a controller ray.
 *
 * This is the route to prefer. Mol* accepts XR controllers natively through
 * `InputObserver.updateTrackedPointers`, which is how the immersive page's own
 * instance is already driven, so the panel's instance is told about the
 * controller in the same words rather than through invented DOM events. `x` and
 * `y` are in the panel canvas's CSS pixels, which is what `eventOffset` would
 * have produced from a real pointer over that canvas.
 *
 * `previous` is the last update for the same hand, so `dx`/`dy` are a real
 * delta; Mol*'s trackball reads those for a drag and a first frame with a huge
 * delta would fling the camera.
 *
 * @param {object} options
 * @param {{width: number, height: number}} options.canvas CSS size of the panel canvas
 * @param {{u: number, v: number}} options.hit from `hitMolstarPanel`
 * @param {'left'|'right'} [options.handedness]
 * @param {number} [options.buttons] Mol* ButtonsType bitfield; 1 is primary
 * @param {{x: number, y: number}} [options.previous]
 * @param {{origin: number[], direction: number[]}} [options.ray] passed through
 */
export function molstarPanelTrackedPointer({ canvas, hit, handedness = 'right', buttons = 0, previous, ray } = {}) {
  if (!hit || !finite(canvas?.width) || !finite(canvas?.height)) return undefined;
  const x = clamp(hit.u, 0, 1) * canvas.width;
  const y = clamp(hit.v, 0, 1) * canvas.height;
  return {
    handedness, buttons, x, y,
    dx: previous ? x - previous.x : 0,
    dy: previous ? y - previous.y : 0,
    ...(ray ? { ray } : {}),
  };
}

/**
 * The same landing as a synthetic DOM pointer event, for the fallback route.
 *
 * `eventOffset` (input-observer.js:866-879) reads `(ev.clientX || 0) -
 * rect.left` and `(ev.clientY || 0) - rect.top` from the canvas's own
 * `getBoundingClientRect()`, so the client coordinates are the rect's origin
 * plus the fraction across it. `|| 0` is why a computed 0 is left alone rather
 * than nudged: it is already the value that reads back as 0.
 *
 * `isTrusted` cannot be set, and nothing here needs it: Mol* listens with plain
 * `addEventListener`, which an untrusted event reaches. (WebXR entry is the one
 * thing on this page that does require a trusted click, which is why the way
 * back from the flat page still needs the wearer's own tap.)
 *
 * @param {object} options
 * @param {{left: number, top: number, width: number, height: number}} options.rect
 * @param {{u: number, v: number}} options.hit
 * @param {'pointerdown'|'pointermove'|'pointerup'} [options.type]
 */
export function molstarPanelPointerEvent({ rect, hit, type = 'pointermove', buttons = 0, button = -1,
  pointerId = 1, pointerType = 'mouse' } = {}) {
  if (!hit || !finite(rect?.left) || !finite(rect?.top) || !finite(rect?.width) || !finite(rect?.height)) return undefined;
  return {
    type,
    clientX: rect.left + clamp(hit.u, 0, 1) * rect.width,
    clientY: rect.top + clamp(hit.v, 0, 1) * rect.height,
    buttons, button, pointerId, pointerType,
    bubbles: true, cancelable: true, composed: true,
  };
}

/**
 * The three events one trigger pull is, in order.
 *
 * A pick in Mol* is a press and a release at the same place: `input-observer`
 * turns a down followed by an up with no drag between them into `click`, and
 * `Canvas3D` identifies the loci under that. A controller that sent only a down
 * would leave the button held, and the next ray sweep would read as a drag of
 * the camera rather than as a hover.
 *
 * The move first is deliberate. Mol* tracks the pointer's own previous position
 * for its delta, and a down arriving at a position it has never seen produces
 * one enormous delta on the following move.
 */
export function molstarPanelPickSequence({ rect, hit, pointerId = 1 } = {}) {
  const at = extra => molstarPanelPointerEvent({ rect, hit, pointerId, ...extra });
  const move = at({ type: 'pointermove', buttons: 0, button: -1 });
  if (!move) return [];
  return [move, at({ type: 'pointerdown', buttons: 1, button: 0 }), at({ type: 'pointerup', buttons: 0, button: 0 })];
}

/**
 * What one second of this panel costs, so a decision can be made with a number.
 *
 * Both halves are counted, because the readback is the half people forget:
 * Mol*'s `Image` geometry wants a CPU-side `TextureImage<Uint8Array>`, so the
 * pixels come off the GPU before they go back on. A `texImage2D` straight from
 * the foreign canvas skips the readback where the browser can keep the copy on
 * the GPU, which is what `route: 'canvas'` counts.
 *
 * `frameShareAtHz` is the part a reader actually wants: what fraction of a 72 Hz
 * frame this is, if the whole second's traffic had to fit in the frames it
 * happens in. Bandwidth is the argument rather than a constant because nobody
 * should read a number out of this module and believe it was measured on their
 * headset.
 */
export const QUEST2_EFFECTIVE_COPY_BYTES_PER_SECOND = 2.0e9;

export function molstarPanelTrafficPerSecond({ resolution, uploadsPerSecond = MOLSTAR_PANEL_MAX_UPLOAD_HZ,
  route = 'image', bytesPerSecond = QUEST2_EFFECTIVE_COPY_BYTES_PER_SECOND, frameRate = 72 } = {}) {
  const bytes = finite(resolution?.bytes) ? resolution.bytes : 0;
  const copies = route === 'canvas' ? 1 : 2; // readback + upload, or upload alone
  const perSecond = bytes * copies * Math.max(0, uploadsPerSecond);
  const seconds = bytesPerSecond > 0 ? perSecond / bytesPerSecond : Infinity;
  const frameMs = frameRate > 0 ? 1000 / frameRate : Infinity;
  const perUploadMs = bytesPerSecond > 0 ? bytes * copies / bytesPerSecond * 1000 : Infinity;
  return {
    bytesPerUpload: bytes * copies,
    bytesPerSecond: perSecond,
    perUploadMs,
    /** Share of ONE frame that a single upload eats. */
    frameShare: frameMs > 0 ? perUploadMs / frameMs : Infinity,
    /** Share of the whole second's frames, which is the honest running cost. */
    dutyCycle: seconds,
  };
}
