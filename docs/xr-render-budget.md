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
