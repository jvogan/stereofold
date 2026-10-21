# Immersive render budget

The immersive render budget keeps a headset's frame work within a useful range
while preserving the desktop scene. Its implementation is in
[`xr-render-budget.mjs`](../lab/browser-roundtrip/xr-render-budget.mjs), with
session-layer setup in
[`xr-session-request.mjs`](../lab/browser-roundtrip/xr-session-request.mjs).
The budget is applied while an immersive session presents; saved desktop
settings are restored when that session ends.

## Default policy

The `balanced` render-quality preset is the default. Quest 2 receives the only
scene-sized framebuffer tiers. Atom sites and static-mesh triangles are counted
separately, and the smaller scale selected by either count is used.

| Quest 2 scene size | Layer scale | Relative fragment count |
| --- | ---: | ---: |
| Fewer than 8,000 atom sites and 25,000 triangles | 0.8 | 64% of native scale |
| 8,000–25,000 atom sites or 25,000–150,000 triangles | 0.6 | 36% |
| More than 25,000 atom sites or 150,000 triangles | 0.5 | 25% |

When both counts are present, the deeper tier wins. The scale is chosen when
the XR layer is created. It stays fixed for that session; the optional frame
governor can change each eye's viewport size later without rebuilding the
layer.

| Setting | Quest 2 | Quest 3 and Quest Pro | Other device classes |
| --- | --- | --- | --- |
| Requested frame rate | 72 Hz, reduced to a supported rate when needed | Runtime default | Runtime default |
| Fixed foveation | 1 | 0.5 | Runtime default |
| Representation quality request | `low` | `medium` | Mol* `auto` |
| Pick buffer scale | 0.125 | 0.125 | 0.125 |
| Selection outline and immersive postprocessing | Off in `balanced` | Off in `balanced` | Off in `balanced` |

Fixed foveation is a WebXR layer property, so the session code applies it and
reads the value back. A browser can clamp or ignore the request. The values are
fractions exposed by the WebXR layer; they do not name Meta's native foveation
levels.

Mol* lowers explicit representation quality on standalone headsets. The preset
accounts for that when choosing the surface tier. The `fast` preset uses a
coarser surface and matte material. `best` raises the Quest 2 framebuffer tier,
uses a higher surface tier, and enables extra visual passes. That can reduce
frame rate; these choices are visual controls rather than a performance
guarantee.

The selection color remains visible when the outline pass is off. Mol*'s own
controller-ray mesh may still appear: the viewer disables it, but Mol* resets
the setting in its XR frame loop. The pick buffer is smaller because immersive
picking casts one ray against the scene. Automatic hover picking is off to
avoid rendering the full scene into that buffer every frame; menu hit testing
and explicit trigger picks continue to work.

## Lesson figure plates

Molecular animation partitions residue selections only when installing a chapter
or changing its appearance. Each selector track may add at most one active
molecular representation; a selection that would split multiple overlapping
display layers beyond this limit is refused before installation. Whole-body
layers can reuse their existing representations. Hidden original templates are
retained for chapter exit, so allocated representations differ from active draws.
The saved animation sample and `animation-representations` diagnostic report
`representationCounts`: `molecular` (active molecular partitions), `moving`
(moving partitions), `added` (net increase over their templates), `annotations`
(attached or partitioned labels/measurements), and `tethers`
(line/text representations, counted separately). These are representation counts,
not GL draw counts: one Mol* representation can submit multiple render objects.
`animation-cost.geometryRebuilds` stays zero during uninterrupted playback;
appearance changes may rebuild at their transaction boundary. Pivot rotation,
attached labels and tethers reuse the same per-frame transform path. Software
tests do not establish a Quest frame rate.

Lesson figure labels, moving tether labels and figure distance readouts use a
label-only draw after molecular color/marking and before the headset menu and
other Mol* helpers. Their existing positions, glyph sizes, offsets and per-eye
projection remain unchanged. Exposed fragments draw normally; fragments behind
opaque molecular depth draw at 65% of their authored opacity, including both
glyphs and backing. This is a see-through annotation, so a rear plate does not
claim to be an opaque foreground surface. Transparent molecular layers do not
supply opaque depth for the fade.

The pass uses the existing depth attachment, with GREATER then LEQUAL and depth
writes disabled. It neither clears molecular depth nor redraws the molecule.
Each active plate has two submissions per eye, matching the ordinary opaque
glyph/transparent-backing path for full-opacity labels. Ordinary renderer passes
request `color`, which is excluded for tagged plates before the render item
selects its blended shader. The explicit `colorLabelExposed` submission belongs only
to the label pass, so exposed pixels are not blended twice. Blended, WBOIT and
DPOIT scenes use explicit blended label shaders; offscreen antialiasing uses
the same color target as the final composition. Mol*'s menu/UI rendering and
the menu's subsequent depth reset are unchanged. Untagged text and tether or
measurement strokes retain their ordinary depth behavior.

The label pass traverses the existing scene array twice: all hidden fragments
first, then all exposed fragments. Scene order is retained within each phase;
where plates overlap, exposed ink composites over hidden ink. Compatible text
shaders now need two program switches per eye instead of two per plate. Different
shader definitions can still require additional switches. Distinct authored
materials retain their normal uploads, with the optional uniform cache skipping
equal values; geometry and pick identities are not merged.

Material identity is invalidated once at each phase boundary because it is not
keyed by program. The existing internal update invalidates render-item identity
once per eye when installing group/eye globals and the shared depth texture.
Item and program identity checks handle subsequent object uniforms and VAOs,
including the single-plate case. Successful exit retains valid cache identities
and restores LEQUAL. On a failed submission, program, material and item identities
are invalidated because GL setup may be incomplete; LEQUAL is still restored.

A counting-GL comparison executes installed Mol* renderer, program and render-item
code with 11 synthetic plates, distinct material IDs, two eyes, moving uniforms,
changed colors, reversed scene order and an intervening pick pass. Label-only
calls per stereo frame are:

| Calls | Per-plate pass | Grouped phases |
| --- | ---: | ---: |
| Program switches | 44 | 4 |
| Uniform uploads, cache off | 2,728 | 568 |
| Uniform uploads, cache on, frames 1 / 2 / 3 | 1,014 / 938 / 932 | 214 / 138 / 132 |
| Draws | 44 | 44 |
| Forced material / item invalidations | 46 / 48 | 4 / 2 |

Draw-state snapshots agree after matching eye, plate and phase, with caching
both on and off; picking is unchanged. These counts use a synthetic uniform
schema and are submission evidence, not Quest 2 CPU timing or GPU measurements.
The grouped pass still needs the opt-in pixel probe and physical requalification.

The added frame traversal uses existing renderable arrays and scratch matrices;
renderer-private uniform boxes are updated in place with version increments.
Node tests execute the installed Mol* renderer and real text representations,
check buried-label submission and per-eye pass ordering, and prohibit new
ValueCells through 1,000 repeated frames. They do not measure GPU time or worn
comfort. Translucency reduces conflicting occlusion cues but cannot guarantee
comfortable stereo for labels far behind foreground geometry, or resolve
label-to-label crowding. Physical Quest 2 requalification remains necessary.

An opt-in Chromium/WebGL2 pixel probe is available from `plugin/`:

```sh
STEREOFOLD_LABEL_PIXELS=1 node node_modules/vitest/vitest.mjs run test/molstar-lesson-label-pixels.test.ts
```

The Chromium WebGL2 probe covers blended, WBOIT and DPOIT with and without
SSAO/FXAA. It checks buried visibility, duplicate-blend sensitivity and unchanged
exposed interiors away from glyph edges. A separate black-on-white probe checks
fractional edge coverage at three text sizes without postprocessing. These
updated pixel checks require an unrestricted browser run; they have not been
executed for the sharpness change. Earlier pixel counts predate SDF coverage
and must not be treated as measurements of this version.

### Label sharpness and cost

The installed Mol* text fragment shader used a binary SDF threshold, not a
screen-space smoothing width. Native eye crops show stepped strokes, disappearing
small characters and lower contrast where plates cross molecular geometry.
Lesson glyphs already use quality 3: a 256 px font, 32 px buffer on each side,
85.3 px SDF radius and 405 px line height. The alpha atlas uses linear filtering
without mipmaps. More atlas detail would not recover missing framebuffer pixels;
a quality-3 atlas already allocates about 43 MB per text render item. Atlas size,
padding, filtering and the existing shared CPU cache/upload optimizations stay
unchanged. Padding reserves distance-field and border space rather than shrinking
the smoothing width. Immersive component labels use quality 1 (128 px).

Both explicit lesson variants now define `dStereofoldLabelSdf` and map to blended
rendering. Coverage uses `smoothstep` across `fwidth(SDF)`, approximately one
framebuffer pixel, with a one-byte minimum width for quantized/flat samples.
Derivatives run before any discard. Borders use the same transition; backgrounds
retain their own opacity. Ordinary text, picking and depth retain the original
threshold. Expected effect: more stable thin strokes and diagonals without a
fixed blur radius. Cost: derivative/smoothstep arithmetic and one atlas sample
per fragment (including backing fragments); no extra draws, geometry, CPU frame
allocations or atlas storage. The two label phases and program-switch counts
are unchanged. The exposed SDF program is compiled at setup, alongside the
hidden variant. This is an expected small GPU cost, not measured Quest timing.

Figure and moving-tether white backings now use opacity 1 instead of 0.9.
Bright ink is scaled to a maximum sRGB channel of 112, preserving its channel
ratios; dark ink remains exact. Exposed ink has at least 4.5:1 contrast on white.
Color mapping happens only at creation/update; it adds no rendering work. Hidden
ink and backing still fade together to 65%, so that contrast guarantee does not
apply behind geometry or to additional authored alpha. The fade remains a depth
cue, and overlapping labels can still interfere.

Balanced Quest 2 resolution remains 0.8/0.6/0.5 and requested fixed foveation 1.
Foveation read-back and effective peripheral quality must be captured: the
optional menu-depth-reset candidate can change effective foveation. SDF coverage
cannot restore subpixel letters or peripheral shading samples. The existing
scale-compensated world size remains unchanged (the annotation regression's
0.6-size plate spans about 1.7 degrees at 2.35 m); distance and authored size still
control the number of eye pixels per glyph. Increasing all plates risks crowding.

Full-resolution plates cannot be drawn into the current smaller XR layer.
They would require a full-size layer plus separate molecular color/depth targets
and compositing, or a separate XR layer with different occlusion handling. That
would change passes and bandwidth. This change therefore keeps the existing
framebuffer, foveation and draw budget. No device sharpness or frame-time claim
follows from the CPU checks.

For the device comparison, use the same lesson, pose, chapter time and balanced
settings before and after. Save unresized native left/right eye PNGs at 2.35 m
and 4 m, centered and with a 25-degree head turn. Include hemoglobin R-state
(exposed Beta 2 and hidden Alpha 2), kinesin ATP-docks (head/ADP plates), an ATP
rotor moving tether, overlapping plates and the smallest distance readout. Take
paused captures and a 10-second slow head-turn video during playback to expose
stroke shimmer and disappearing letters. Record the build hash, framebuffer and
eye viewport dimensions, render-budget/governor state, requested/read-back
foveation, menu-depth-reset setting, and reported refresh rate. Collect matched
30-second frame-cost logs and draw/program-switch counts; compare callback p50/
p95, missed frames and GPU time if available. Repeat the edge/contrast and buried
plate pixel probes on an unrestricted host. Keep device performance and visual
acceptance pending until these comparisons are complete.

## Frame diagnostics and adaptive resolution

`read_headset_log` can return three useful diagnostic records:

- `render-budget` reports the selected device and scene tier, layer scale,
  requested and accepted frame rate, foveation read-back, representation
  quality, pass settings and parsed overrides.
- `frame-cost` samples once a second. It reports XR callback timing, frame
  gaps, overlay work and browser long tasks. It does **not** measure GPU time.
  `reportedFrameRate` is the session's rate ceiling, not measured throughput.
- `frame-governor` records the adaptive-resolution mode, missed-frame windows,
  rung changes and summaries.

The governor defaults to `observe`: it measures and records the changes it
would make without changing the image. Set `governor:on` only for a device run
that accepts the softness trade-off. It steps down after sustained missed frame
windows, then steps back up after sustained good windows. The available rungs
use per-eye viewport scaling and, where supported, stronger fixed foveation.
They do not reduce molecular detail or change the XR layer. The effective
linear scale has a default floor of 0.4. This behavior has not been qualified
across device classes, so the default remains observational.

The query parameter `xrRenderBudget` accepts focused overrides for controlled
A/B comparisons. Examples:

```text
?xrRenderBudget=scale:0.6
?xrRenderBudget=foveation:0.5,quality:medium
?xrRenderBudget=governor:observe
?xrRenderBudget=off
```

The parser leaves every omitted knob unset (`undefined`). The defaults in the
following table are the module's resulting values with the budget on and the default `balanced`
render-quality preset; a selected preset can supply omitted overrides.
Keys and values are trimmed and case-insensitive. In the Values column,
`on` also accepts `1`, `true`, `yes`, `enabled`; `off` also accepts `0`,
`false`, `no`, `disabled`.

| Knob | Values | Default when omitted | Effect | Key aliases |
| --- | --- | --- | --- | --- |
| `scale` | 0 < number <= 2 | Quest 2: 0.8, 0.6 or 0.5 by scene tier; other devices: 1 | `framebufferScaleFactor`, replacing the scene tier; the browser clamps values above its native scale | `framebufferscale` |
| `foveation` | 0 <= number <= 1 | Quest 2: 1; Quest 3/Pro: 0.5; other devices: left alone | the level `applyFoveation` writes | — |
| `fps` | 0 < number; `off` | Quest 2: 72; other devices: no request | the rate `updateTargetFrameRate` asks for; `off` disables the request | `framerate`, `targetframerate` |
| `quality` | `auto`, `highest`, `higher`, `high`, `medium`, `low`, `lower`, `lowest`, `custom` | Quest 2: `low`; Quest 3/Pro: `medium`; other devices: `auto` | Mol* representation quality; overrides the surface tier; `auto` lets Mol* choose | `representationquality` |
| `surface` | `auto`, `highest`, `higher`, `high`, `medium`, `low`, `lower`, `lowest`, `custom`, `off` | `low` surface tier on devices with a quality tier; other devices: `auto` | surface mesh quality, compensated one tier upward on standalone headsets; `off` uses the device tier | `surfacequality` |
| `gloss` | `on`, `off` | `on` | surface material; `off` restores Mol*'s default material | `surfacematerial` |
| `rough` | 0 <= number <= 1 | 0.28 | surface roughness, from mirror (0) to fully matte (1) | `roughness` |
| `palette` | `on`, `off` | `on` | pastel chain palette; `off` restores Mol*'s saturated palette | `surfacepalette` |
| `light` | `on`, `off` | `on` | three-light rig; `off` uses the legacy key-plus-back pair | `lighting` |
| `marking` | `on`, `off` | `off` | the selection outline pass | — |
| `pick` | 0 < number <= 1 | 0.125 | `pickScale` | `pickscale` |
| `hover` | 0 <= number <= 60; `on`, `off` | 0 | hover poll rate in frames per second; `on` means 30, `off` means 0 | `interaction` |
| `postfx` | `on`, `off` | `off` | `on` enables immersive occlusion and outline; antialiasing, bloom, shadow, depth of field, sharpening and illumination stay off | `postprocessing` |
| `cost` | `on`, `off` | `on` when a diagnostics recorder exists | `frame-cost` sampling | `framecost` |
| `molstarPanel` | `on`, `off` | `off` (unset until requested) | experimental in-scene Mol* panel | `molstar` |
| `governor` | `on`, `off`, `observe` | `observe` on every device | frame-time governor; `observe` measures and records `would-step` without changing the session | — |
| `governorFloor` | 0 < number <= 1 | 0.4 | lowest layer scale times viewport scale the governor may reach | — |
| `msaa` | `on`, `off` | unset: Quest classes with a foveation level build the layer without MSAA | `on` keeps the multisampled XR layer Mol* requests; for measuring the MSAA and foveation trade | — |

Numeric values use `Number.parseFloat`, including numeric prefixes, and the
intervals include only the boundaries marked `<=`. FPS has no upper bound in
the parser, even for numeric overflow (`1e309`); the budget uses its device
default for non-finite rates. Aliases are checked before numbers for `fps` and
`hover`: `fps:0` means `off`, while `fps:0.0` is dropped; `hover:1` means 30 FPS,
while `hover:1.0` means 1 FPS.

An unreadable knob is dropped without an error, so a typo in a URL typed on a
headset does not stop the session from entering immersion. The `render-budget`
entry names the knobs that were read in its `overrides` field.


`STEREOFOLD_XR_RENDER_BUDGET` supplies the same overrides for a Node-hosted
harness and takes precedence over the query parameter. With the budget off,
the layer uses scale 1, no frame rate is requested, and no rendering pass is
changed.

## Scene changes and measurement limits

For a scene replacement, the viewer builds the new geometry separately and
keeps the old scene until the new one has produced a committed visible frame.
Uploads are submitted in batches and yield between render objects. This can
increase temporary memory use because both versions remain alive during the
handoff. Mol* does not expose a way to split every individual buffer upload;
large geometry rebuilds can still stall the main thread or miss the render
deadline.

The frame-cost sampler observes callback and wall-clock gaps, not GPU execution.
A long callback alone cannot distinguish CPU work from a driver blocked on GPU
work. Scene-transition measurements also cannot establish that a headset kept
every display frame. Use platform profiling to identify GPU cost, and report
application submissions separately from compositor refresh and wearer
perception.

## Existing Quest 2 measurements

The figures below come from earlier physical Quest 2 runs. This documentation
cleanup added no hardware testing. They describe the named structures,
representations, browser and capture settings only; they do not establish
performance on other devices or every scene.

In a Quest 2 Oculus Browser/WebGL 2 run, an optional depth-proxy path for large
opaque sphere impostors was compared with the stock shader. The run used 9AX6,
3,052 atoms, spacefill, fixed foveation 1, a 2304 × 1267 framebuffer and four
samples. The candidates were bracketed by stock controls.

| View | Stock GPU time | Proxy GPU time | Stock submissions/s | Proxy submissions/s |
| --- | ---: | ---: | ---: | ---: |
| 30×, about 83% coverage | 66.5–72.5 ms | 32.2–33.6 ms | 12.2–12.5 | 24.8–24.9 |
| 10×, about 28% coverage | 19.0–19.7 ms | 17.2 ms | 42.5–42.9 | 47.8 |
| 8×, about 18% coverage | 15.2–15.4 ms | 15.1 ms | 53.1–53.5 | 53.3 |
| 6×, about 11% coverage | 11.6–11.8 ms | 12.7 ms | 65.0 | 60.4 |
| 0.5×, about 0.1% coverage | 6.9–7.6 ms | 6.8 ms, stock path | 71.8–72.2 | 72.0 |

The 6× regression and neutral 8× result keep those views on the stock path.
The proxy is limited to compatible Quest 2 draws and falls back during motion,
unsupported transforms and transparent or marked scenes. Its projected-size
and cost gates avoid allocating proxies for small views or expensive proxy
workloads. The size score is the smaller eye's projected bounding-sphere score,
`abs(P00 * P11) * R² / Z²`, clamped to 1; the proxy enters at 0.50 and leaves
below 0.40. A separate provisional cost limit allows at most one proxy vertex
per native framebuffer pixel across both eyes and all sphere instances. These
are performance gates, not visibility or atom-count limits. In a separate
4V6X comparison the candidate did not improve the measured rate, so the proxy
stays off for that workload; a browser GPU-process crash at a larger layer has
no established cause. The large-view gains in the 9AX6 run remain below 72
fresh submissions per second, and the smallest view uses the original shader.

A separate Quest 2 test measured a direct single-pass stereo path with 9AX6
assembly 1 in spacefill, mesh sphere detail 2, at 20× and 0.5× scale. Two
five-second Perfetto windows per case yielded these application frame rates:

| Mode | 20× view | 0.5× view |
| --- | ---: | ---: |
| Stock, first control | 18.0–18.3 | 43.3–43.4 |
| Single pass only | 24.6–24.8 | 51.9–52.0 |
| Stock, final control | 17.9–18.0 | 43.2 |

These are application submissions, not compositor refresh. Other experimental
passes in that run stayed disabled. Full-resolution giant sphere-impostor runs
entered a stale-frame regime, so a runtime counter alone did not qualify their
fresh displayed throughput. Large spacefill scenes can still miss the frame
target even when smaller views are smooth.

The implementation also corrects Mol* sphere and cylinder radius scaling for
uniform placement transforms and includes Quest-specific opaque-mesh and
lighting shader paths. Existing shader probes cover selected inputs, not all
materials or GPUs. Physical Vision Pro performance and broad headset
compatibility are not established by these Quest 2 measurements; use
[host verification](host-verification.md) for the scope of software and device
checks.

## CPU submission and snapshot costs

The browser bundles apply a default-on per-program uniform cache at build time.
`STEREOFOLD_UNIFORM_CACHE_PATCH=0` disables it for an A/B rebuild; `1` enables it.
Other values fail the build. Scratch `render-settings.json` records the choice.
Both the desktop viewer and the inspector (desktop panel and headset page) use
it. No GL APIs are monkey-patched. Each program/location retains a copy of its
last uploaded scalar or array; equal values skip uploads even across different
material cells. Array comparisons detect in-place edits without relying on cell
versions. Raw `program.uniform`, batched setters and sampler uploads share the
cache, while texture binding still runs. Finalization after context restoration
creates empty caches. Camera, view and projection uniforms bypass the cache.

The snapshot path reads live trackball/stereo fields through a narrow Canvas3D
accessor. When `camera.forceFull` disables clipping, diagnostics report effective
clipping as zero without asking for aggregate bounds. With clipping active,
the original derived percentage still reads scene bounds; no stale geometry or
camera values are substituted. Other `Canvas3D.props` reads defer the derived
clipping radius until that group is requested, then cache it on that returned
object. Camera values are captured on the property read; scene bounds are
resolved on first clipping access. Rendering, culling and camera fitting retain
Mol*'s existing scene invalidation. Independent stock-Mol* builds retain a public
API fallback and do not receive these optimizations.

The source audit covered `lab/browser-roundtrip` and `plugin/src`. Snapshot
reads are in `viewer.mjs`; `plugin/src/viewer.ts` reads stereo, antialiasing and
multisampling for layout/diagnostics. Remaining reads are appearance/quality
transactions, XR-budget entry/restore, camera helpers and desktop-preview
entry/exit. `presentation-scene.mjs` already caches DOF at setup and setter
changes. These unrelated settings no longer calculate bounds. Public Canvas3D
`boundingSphere`/`boundingSphereVisible` properties hold existing sphere objects;
Mol* Scene getters do the actual dirty-bound calculation. Molecular bounds
queries for placement, source adoption and framing remain necessary. Structure
boundary and render-object ValueCell reads do not rebuild aggregate scene bounds.

A Node counting-GL fixture runs installed Mol* program/render-item code with
40 synthetic objects, two eyes, picking, both lesson-label variants, moving
transforms, mixed materials and reversed draw order. Uniform calls per frame
were 1,760 before and 613, 579, 581, 579, 581 after (65–67% fewer), with all
176 draw-state snapshots per frame equal and all texture bindings retained.
The snapshot-settings micro-benchmark uses 100 spheres, 2,000 dirty frames and
four snapshots/frame: 32,000 full property reads and 2,000 bounds calculations
became zero, and total time was 59.32 ms versus 1.06 ms on the test host. These
are synthetic CPU evidence, not whole-snapshot timing or Quest frame timings.

The cache adds comparisons and one retained copy per cached uniform/location;
scenes whose uniforms always differ can trade fewer GL calls for extra CPU work.
Plate geometry remains separate: merging it could reduce draws but would couple
plate updates, picking and transparency order. The post-geometry label pass
groups variant submissions as described above and retains its pixel assertions.
Its opt-in Chromium probe now
includes the uniform cache, and accepts the same flag for an uncached control.
Recheck both eyes, picking, clipping, source replacement, context recovery and
label depth/opacity on a physical device; no 72 fps claim follows from this test.
