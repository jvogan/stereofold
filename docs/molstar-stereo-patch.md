# Mol* 5.11.0 stereo patch plan

This note is pinned to the installed package `molstar@5.11.0`. All source
citations in this note are relative to
`packages/geometry/node_modules/molstar/lib/`; line numbers were read from
that installed copy. The snippets are source-level integration sketches for
an embedding app. They are not a visual verification of a viewer. The
node-level oracle in `packages/geometry/test/geometry.test.ts` measures both
the stock camera and the build-local correction through Mol*'s real matrices.

## What Mol* constructs and updates

`Canvas3DParams.camera.stereo` is a mapped parameter: `off` has an empty
group, and `on` contains `StereoCameraParams`
(`mol-canvas3d/canvas3d.js:52-62`). During Canvas3D creation, Mol* creates the
ordinary camera at `canvas3d.js:320-327`, then creates one stereo wrapper with
`new StereoCamera(camera, p.camera.stereo.params)` at `canvas3d.js:328`.

The actual constructor and per-frame update are in
`mol-canvas3d/camera/stereo.js`:

```js
// stereo.js:26-43, abridged only for comments
constructor(parent, props = {}) {
    this.parent = parent;
    this.left = new EyeCamera();
    this.right = new EyeCamera();
    this.props = { ...DefaultStereoCameraProps, ...props };
}
setProps(props) { Object.assign(this.props, props); }
update(xr) {
    this.parent.update();
    if (xr) xrUpdate(this.parent, this.left, this.right, xr);
    else update(this.parent, this.props, this.left, this.right);
}
```

The non-XR `update` first copies the parent view/projection state to both
eyes (`stereo.js:98-102`). It uses `w = floor(parent.viewport.width / 2)` and
the left-eye aspect `w / parent.viewport.height`; then left gets width `w`,
while right starts at `x += w` and receives the remaining width
(`stereo.js:103-107`). The eye math is:

```js
const eyeSepHalf = props.eyeSeparation / 2;
const eyeSepOnProjection = eyeSepHalf * camera.near / props.focus;
const ymax = camera.near * Math.tan(camera.state.fov * 0.5);

tmpEyeLeft[12] = -eyeSepHalf;
tmpEyeRight[12] = eyeSepHalf;

// left:  xmin = -ymax*aspect + eyeSepOnProjection
//        xmax =  ymax*aspect + eyeSepOnProjection
Mat4.mul(left.view, left.view, tmpEyeLeft);

// right: xmin = -ymax*aspect - eyeSepOnProjection
//        xmax =  ymax*aspect - eyeSepOnProjection
Mat4.mul(right.view, right.view, tmpEyeRight);
```

Those expressions and the projection-matrix writes are verbatim in
`stereo.js:109-131`. Thus stock Mol* translates the left view matrix by `-B/2`
and the right by `+B/2` in world units; the left frustum center is shifted by
`+B·near/(2F)` and the right by `-B·near/(2F)`. `F` is the `focus` prop. This
stock pair does not converge: the real-camera oracle measured local
left-minus-right disparities `-69.2871 px` at `Z=45 Å`, `-56.6895 px` at
`Z=65 Å`, and `-50.0201 px` at `Z=85 Å` for `B=1.907876 Å`, `F=65 Å`,
`H=800 px`, and `fov=45°`. The corresponding stock entries were
`view[12] = -0.953938/+0.953938` and `projection[8] = +0.07086185/-0.07086185`.

The plugin therefore owns the convergence override in the in-memory build
patch (`plugin/scripts/build.ts`): it retains Mol*'s native projection skew
and changes the local eye translations to `+B/2` for left and `-B/2` for
right. The corrected real matrices then measure `+12.5977 px`, `0.0000 px`,
and `-6.6694 px` at the same three depths, matching
`@stereo/geometry`'s sign convention: positive left-minus-right is crossed /
front, negative is uncrossed / rear. No `node_modules` source is edited.

Canvas3D calls the stereo update immediately before drawing when stereo is
on (`mol-canvas3d/canvas3d.js:533-552`):

```js
let cam = camera;
if (p.camera.stereo.name === 'on' || xrChanged) {
    if (!xrChanged) stereoCamera.update();
    cam = stereoCamera;
}
passes.draw.render({ renderer, camera: cam, scene, helper }, p, true);
```

Because of this order, set a live camera-derived `focus` and `eyeSeparation`
before the next frame's `stereoCamera.update()`.

## Parameter ranges and the UI clamp

The bounds are declared in `mol-canvas3d/camera/stereo.js:13-16`:

```js
eyeSeparation: PD.Numeric(0.062, { min: 0.02, max: 0.1, step: 0.001 }, ...),
focus: PD.Numeric(10, { min: 1, max: 20, step: 0.1 }, ...),
```

`ParamDefinition.Numeric` stores those
`min`/`max` fields (`mol-util/param-definition.js:135-140`), but
`normalizeParam` does not clamp a numeric value; its fallback returns the
value unchanged (`param-definition.js:522-583`). The visible controls pass the
metadata to the slider (`mol-plugin-ui/controls/parameters.js:158-166,
336`), and slider input clamps to `min`/`max`
(`mol-plugin-ui/controls/slider.js:31-37,80-99`). The restriction is therefore
a UI range, not a matrix-level limit.

The public `Canvas3D.setProps` path copies the stereo map and calls
`stereoCamera.setProps` directly (`mol-canvas3d/canvas3d.js:1042-1045,
1085-1088`). It does not call `PD.normalizeParams` there. An embedding app can
therefore pass values such as `eyeSeparation: 2.0` and `focus: 65` through the
runtime path, while the stock slider stays limited to the ranges declared in
`stereo.js:13-16`.
Snapshot restore is a separate path and does normalize parameters
(`mol-plugin/state.js:61-71`); do not use a snapshot as the per-frame control
channel.

## Smallest embedding override for live parameters

Live parameters need no `StereoCamera` subclass. Use the existing public
`canvas3d.setProps` and compute from the live camera. The camera exposes
`position`, `target`, `near`, `state.fov`, and `viewport`; the visible scene
radius is available from `canvas3d.boundingSphereVisible`. The following uses
the geometry package's `CameraSnapshot` contract:

```ts
import { Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { deriveStereoParams } from '@stereo/geometry';

const canvas3d = plugin.canvas3d!;
const updateStereoForFrame = () => {
    const camera = canvas3d.camera;
    const snapshot = {
        fovRad: camera.state.fov,
        near: camera.near,
        distanceToTarget: Vec3.distance(camera.position, camera.target),
        boundingRadius: canvas3d.boundingSphereVisible.radius,
        viewportHeightPx: camera.viewport.height,
        viewportWidthPx: camera.viewport.width,
    };
    const params = deriveStereoParams(snapshot, {
        mode: 'parallel', swapEyes: false, depthBudgetArcmin: 20,
        viewingDistanceMm: 500, cssPxPerInch: 110, devicePixelRatio: 1,
    });
    canvas3d.setProps({
        camera: {
            stereo: { name: 'on', params: {
                eyeSeparation: params.eyeSeparation,
                focus: params.focus,
            } },
        },
    });
};

// Camera.changed is emitted after Camera.update computes a new view/projection
// (mol-canvas3d/camera.js:30-67). Also call this after a resize/scene commit.
const subscription = canvas3d.camera.changed.subscribe(updateStereoForFrame);
```

The embedding app owns the subscription and must dispose it with the viewer.
The numeric values in the snippet are example inputs, not a claim about a
particular host's physical pixel density. The host's density and viewport
must be measured at runtime.

## Smallest cross-eyed viewport swap

Mol*'s `DrawPass` renders left and right into their already assigned
viewports; `StereoCamera` has no `swapEyes` field. A small, reversible
wrapper around the installed DrawPass can swap the full viewport records only
for the draw call:

```ts
import { StereoCamera } from 'molstar/lib/mol-canvas3d/camera/stereo.js';

const draw = plugin.canvas3dContext!.passes.draw;
const originalRender = draw.render.bind(draw);
(draw as typeof draw & { render: typeof draw.render }).render =
    (ctx, props, toDrawingBuffer) => {
        if (!swapEyes || !StereoCamera.is(ctx.camera)) {
            return originalRender(ctx, props, toDrawingBuffer);
        }
        const left = ctx.camera.left;
        const right = ctx.camera.right;
        const leftViewport = { ...left.viewport };
        const rightViewport = { ...right.viewport };
        Object.assign(left.viewport, rightViewport);
        Object.assign(right.viewport, leftViewport);
        try {
            return originalRender(ctx, props, toDrawingBuffer);
        } finally {
            Object.assign(left.viewport, leftViewport);
            Object.assign(right.viewport, rightViewport);
        }
    };
```

The wrapper swaps which eye image is drawn in the left/right display rectangles
while leaving the view and projection matrices unchanged. It is intentionally a
viewport operation, not a negation of `eyeSeparation`. The plugin's build also
patches `mol-canvas3d/helper/pick-helper.js`: pick rendering and the
`cameraUnproject` eye selection use the same
`__stereoStructureViewportXSwap` flag. This source-level mapping is covered
by `plugin/test/draw-pass-fork.test.ts`; a host/GPU atom click remains
**UNVERIFIED**.

The swap requires an even stage width. `stereo.js:103-107` splits with
`w = Math.floor(camera.viewport.width / 2)`, sets `left.viewport.width = w`
and `right.viewport.width -= w`, so an odd width leaves the right eye one
column wider than the left while both eyes keep the left eye's aspect. The two
eyes then rasterize at different horizontal scales, and exchanging the two
viewport records exchanges two rectangles of different width. The viewer
therefore letterboxes any side-by-side stage to an even CSS width
(`plugin/src/viewer.ts`, `applySideBySideWidth`). At 110 CSS px/in the parallel
pair measures 544 CSS px, 272 per eye, against the 272.83 px cap for 63 mm.
With the even width, the cross-eyed render matches the parallel render with its
halves exchanged to 0 channel units over 0 differing pixels, measured on a
real WebGL2 render.

## Two-pass anaglyph hook

The stock DrawPass is not an anaglyph compositor. Its `_render` method sets
the viewport and renders scene/postprocessing work
(`mol-canvas3d/passes/draw.js:344-452`). Its public `render` method then calls
that method once for `camera.left` and once for `camera.right`
(`draw.js:454-482`). Both calls use the same pass-owned targets, so the stock
path produces two viewports, not two eye textures for a Dubois composite.

The smallest reliable anaglyph change is a local DrawPass source fork/adapter at
the two-eye branch, with one eye target per pass and a final fullscreen
composite. The hook point is the branch at `draw.js:469`:

```js
// Source-level shape for a local DrawPass fork, inserted at draw.js:469.
if (StereoCamera.is(camera) && anaglyphEnabled) {
    // Each eye is rendered full-frame. Stock StereoCamera has half-width
    // viewports/aspect, so the fork temporarily sets (0, 0, W, H) and scales
    // projection[0] and projection[8] by 0.5 for the full-frame aspect. The
    // corrected view translations and native frustum signs are preserved.
    // drawEye must run the existing _render pipeline with the selected eye
    // and an eye-specific color target; keep postprocessing policy explicit.
    drawEye(camera.left, leftEyeTarget, renderer, scene, helper,
        toDrawingBuffer, transparentBackground, props);
    drawEye(camera.right, rightEyeTarget, renderer, scene, helper,
        toDrawingBuffer, transparentBackground, props);

    // Bind the final drawing-buffer target and run a WebGL2 fullscreen pass.
    anaglyphComposite.render(leftEyeTarget.texture, rightEyeTarget.texture,
        camera.viewport, /* Dubois matrices in linear light */);
    return;
}
```

`drawEye` should be a small refactor of the existing `_render` body so its
selected color/depth/postprocessing targets are bound consistently; merely
binding an external framebuffer before calling the stock `render` is
insufficient because `_render` selects and binds its own targets at
`draw.js:372-391`. A plugin-spec-only change cannot install this pass:
`PluginSpec` does have an optional `canvas3d` field for initial Canvas3D
properties (`mol-plugin/spec.d.ts:14-23`), and `PluginContext` applies that
field after creating Canvas3D (`mol-plugin/context.js:137-153`). It does not
provide a pass replacement or an anaglyph callback: Canvas3D consumes the
context's existing passes (`mol-canvas3d/canvas3d.js:291-295`). Use
`spec.canvas3d` for initial stereo props, but use custom
`Canvas3DContext`/passes construction or maintain this small DrawPass fork for
the anaglyph mode.

Mol* 5.11.0's `Mat4` is a plain
number array, not a `Float32Array`, so the eye matrices a fork saves before it
rewrites them must be restored with `Mat4.copy` and not with a typed-array
`.set`. Calling `.set` throws `v.projection.set is not a function` out of the
draw loop on every frame, and because the throw happens inside the stereo
branch the anaglyph frame comes back containing only the background. The
symptom looks like a dead compositor rather than a type error, because Mol*
catches the exception at the animation-frame boundary.

The Dubois shader itself is owned by `@stereo/anaglyph` and its color
accuracy is **UNVERIFIED** here. What the pixel gate does verify on a real
WebGL2 render is that the full-frame eye FBO fork carries the geometry: with
both eyes rendered full frame and composited, each marker's per-eye centroid
reproduces the same disparity the split-viewport modes produce, to within
0.11 px of the `@stereo/geometry` prediction. The geometry package and this
note contain no visual claim.

## Measured on real renders

Headless Chromium, ANGLE SwiftShader, WebGL2, DPR 1, page viewport 1400x900,
110 CSS px/in, 20 arcmin depth budget at 500 mm, side-by-side canvas 544 x 627
CSS px. Fixture `plugin/test/fixtures/three-depth-markers.pdb`, camera at
(0, 0, 65) looking at the origin, so the markers sit at camera depths 45, 65
and 85 Å. Derived `B = 2.053198 Å`, `focus = 65 Å`. Disparity is left eye minus
right eye in eye-local CSS px; positive is crossed/in front of the screen.

| Marker | Depth (Å) | Predicted | Parallel | Cross | Anaglyph |
| --- | ---: | ---: | ---: | ---: | ---: |
| front | 45 | +10.63 | +10.62 | -10.62 | +10.62 |
| centre | 65 | 0.00 | 0.00 | 0.00 | 0.00 |
| rear | 85 | -5.63 | -5.51 | +5.51 | -5.51 |

Pixel disparity depends on viewport height only through `B`, which is derived
from that same height, so these numbers do not change when the canvas is
resized: the same table measured on a 544 x 370 canvas gave +10.73, 0.00 and
-6.00.

Vertical disparity is 0.00 px for every marker in every mode. At zero depth
strength the two halves are identical to 0 channel units over 0 differing
pixels, and each marker lands within 0.07 px of its predicted mono projection.
The measured values differ from the prediction by up to 0.12 px because a
rendered centroid is quantized by the marker's pixel coverage; the rear marker
is the smallest at 90 px.

The disparity budget is allocated at the extremes of Mol*'s visible bounding
sphere, not at the markers. That sphere runs from depth 42.57 to 88.15 Å, so
the peak +12.60 px sits 2.43 Å in front of the front marker and the marker
itself receives +10.63 px. A fixture whose markers sit further inside the
bounding sphere would receive proportionally less.

Reproducing the numbers needs a deterministic render. Mol* defaults to
`multiSample.mode = 'temporal'`, which jitters the projection and accumulates
over an unbounded number of frames, and to `postprocessing.antialiasing =
'smaa'`. Both are full-frame screen-space passes that read neighboring texels
at absolute framebuffer coordinates, so the same geometry drawn into the left
and the right half of one frame resolves to different edge pixels. Depth fog
tints each fragment by its window-space interpolated depth and rounds one 8-bit
unit differently at a different framebuffer offset. Sphere impostors shade from
`gl_FragCoord` and have the same problem. The acceptance render disables all
four and draws tessellated spheres instead of impostors; none of them carries
geometry.

## CSS density and display assignment

`cssPxPerInch` is calibrated CSS pixels per physical inch. The viewer probe
measures the width of a CSS `1in` element and does not multiply it by
`devicePixelRatio`; viewport dimensions in the shared contract are CSS
pixels. Consequently `cssPx * 25.4 / cssPxPerInch` is the millimeter
conversion, and the parallel half-width cap is
`63 * cssPxPerInch / 25.4`. A probe that falls back to the standard 96 CSS
px/in value is labeled **estimated** in the readout. DPR changes the backing
store resolution, not either physical conversion. The adapter test covers
DPR 1 and 2 invariance.

For side-by-side display assignment, with `swapEyes=false`:

- `parallel`: the left half shows `camera.left`; the right half shows
  `camera.right`.
- `cross`: the left half shows `camera.right`; the right half shows
  `camera.left`.

The independent `swapEyes` flag XORs that assignment: it swaps the two halves
in parallel mode and cancels the cross assignment in cross mode. Anaglyph
keeps both eye renders full-frame and applies `swapEyes` in the compositor,
not in the side-by-side viewport flag. Positive local left-minus-right
disparity is the crossed/front convention used by the geometry oracle; the
display assignment is a separate image-routing operation.

## Recommended integration order

1. Use direct `Canvas3D.setProps` for live `focus` and `eyeSeparation`.
2. Add the viewport wrapper only for the opt-in cross-eyed mode, and test
   picking coordinates separately.
3. Add a local DrawPass fork for anaglyph FBOs and the compositor. Keep the
   stock side-by-side path for parallel/cross modes.

## Where the anaglyph composite belongs in the pass chain

The following sections are historical engineering notes on the anaglyph fork.

The first fork rendered each eye with `toDrawingBuffer` true and rebound
`this.drawTarget` so the eye landed in a package-owned FBO. That is the one
value of the flag antialiasing does not respect. `draw.js:421-425` forwards it
straight to `PostprocessingPass.render`, which turns `true` into an `undefined`
target and binds the default framebuffer (`postprocessing.js:367-375`), so
`AntialiasingPass` wrote its own copy of the scene to the canvas over the
finished composite and `MultiSamplePass` did the same from
`drawPass.getColorTarget(...).texture` (`multi-sample.js:106`). An earlier
workaround switched both passes off whenever anaglyph was active, which cost
anaglyph its antialiasing.

The shipped fork (`plugin/src/molstar-draw-pass-fork.ts`) renders each eye with
`toDrawingBuffer` false, which resolves the
eye through the whole chain into `getColorTarget(props.postprocessing)`, copies
that target into the pass texture with `copyTexSubImage2D` before the second eye
overwrites it, and composites into the drawing buffer or back into
`getColorTarget` according to the flag it was given. Mol*'s `Framebuffer` wrapper
exposes only `bind()`, so the raw `WebGLFramebuffer` the package compositor needs
is recovered with `gl.getParameter(gl.FRAMEBUFFER_BINDING)` after binding.

Measured on the depth fixture at 1400x900, red-cyan balanced, zero disparity,
with Mol* reporting `postprocessing.antialiasing = smaa` and
`multiSample.mode = temporal`: the composited frame has 0 pixels whose green and
blue channels differ, against 1259877 such pixels in the mono frame under the
same passes. Green equals blue in every balanced red-cyan pixel because both
channels come from the same matrix rows, so this is a signature of the composite
rather than a comparison of two captures. Temporal multisampling does not
advance past sample 0 in the acceptance render, so that frame is the
un-jittered one. The measurement verifies that `MultiSamplePass` does not
replace the composite; it does not verify that accumulation preserves it.

### The ground is black, and why 8-bit rounding decides this measurement

The balanced red-cyan projector emits `[Y, kY, kY]` with `k = 0.27000254`. Each
of the two codes is rounded independently, and half a code is worth
`1.2 / (code + 14.025)` of that channel's linear value. That is 0.916 % at code
117 and grows without bound as the code falls, so the criterion of 0.25 % is
below the 8-bit floor for any single flat field: even at code 255 half a code is
0.446 %. The reference inks `(255, 0, 0)` and `(0, 142, 142)`
measure 0.1833 % for exactly this reason, the ideal cyan code being 141.86.

The measured consequences:

| Field | Composited to | Literal filter-luma residual |
| --- | --- | --- |
| Ground `#020506` rendered into both eyes | `[4, 1, 1]` | 7.693 % |
| Same frame, whole image, ground included | 4 distinct colors | 5.6536 % |
| Same frame with an exactly black ground | 4 distinct colors | 0.9863 % |
| Lit, antialiased render, black ground | many levels | 0.0088 % |

The anaglyph ground is therefore exactly black, which composites to `[0, 0, 0]`
and contributes no luma to either filter. The remaining 0.9863 % is the pixel
gate's own flat unlit swatches: `ignoreLight` exists so the marker classifier
can separate three markers by hue, and it leaves each marker at a single
Rec.709 luma level, where rounding cannot average out. The luma criterion is
therefore measured on the shipped shading, which is what an observer's filters
receive, and the flat number is printed beside it.

### The rendered mirror is in x, not in z

`packages/geometry/test/geometry.test.ts:118-158` mirrors the scene in x and
exchanges eye order. The rendered form does the same: the fixture is reloaded
with each marker's x negated, and the render is compared against the original
after each half is flipped horizontally and the halves are exchanged. This holds
because the patched `StereoCamera` is antisymmetric in x, with
`left.view[12] = -right.view[12]` and equal and opposite projection skew.

A z-mirror does not have this property under a perspective camera. The two
outer markers sit 20 A either side of the 65 A focus plane and measure
+10.43 px and -5.62 px, which are not equal and opposite.

Measured: 7 of 489600 pixels differ, worst channel delta 74, all of them on
one marker's silhouette. Mol*'s icosphere vertex set is x-symmetric but its
triangles are not, and the rasterizer's fill rule treats a left edge and a right
edge differently, so a mirrored mesh can gain or lose a boundary pixel. The
assertion is therefore on centroids at the same 1 px floor every other centroid
comparison in the gate uses, and the whole-frame delta is reported beside it.

### Rendered disparity gradient

The shipped fixture puts all three markers on world x = 0, so all three share
one screen midpoint and the gradient `|dd| / |dx|` has a zero denominator. The
mirror fixture spreads them to x = -4, 0 and +4 A, which also makes the mirror
non-trivial. Measured gradient 0.108429 px/px against a limit of 1, with a
smallest midpoint separation of 51.17 px.
