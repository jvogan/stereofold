# Motion label and CPU regression notes

CPU validation on 2026-10-11, against baseline `3fc2143` (desktop annotation sizing).
No new headset or GPU measurements are claimed.

## Label diagnosis and policy

The recorded XR session already held head rotation at zero. Mol* expands the
text/background quad in each eye's screen plane, independently of body rotation;
the plate geometry is not intrinsically edge-on. Figure labels instead used
`scaleByRadius:false` (zero `aDepth`) and only a 3 Å stand-off, leaving the plate
inside the fold where depth testing cuts it into strips. Fixed molecular-unit
text also shrank with the source-derived XR scale: hemoglobin .02421, ATP
.00777, kinesin .00504 metres per scene unit in the supplied device evidence.

Immersive figure and tether text now uses
`sizeFactor = authoredSize * 6 * .02421 / camera.scale`; text offsets use the
same scale ratio, labels clear their transformed target sphere by an additional
`3 * .02421 / camera.scale` scene units, and tether/measurement strokes have a
minimum 4 mm diameter. Thus hemoglobin's physical glyph size is preserved and
ATP/kinesin receive the same angular size at the same default viewing distance.
A size-.6 character is approximately 1.70° at 2.35 m. Culling spheres include
the enlarged billboard and stand-off. Body pose and source coordinates remain
unchanged. Desktop sizing keeps its separate existing policy.

The cylinder compensation matches the shipped shader: similarities scale its
radius, while a longitudinally stretched tether uses Mol*'s upstream radius.
Both cases are covered by CPU geometry tests.

## Motion benchmark

`node lab/browser-roundtrip/motion-benchmark.mjs --baseline 3fc2143`

The portable fixture has six deposited dimer copies (13,152 atoms, twelve
cartoon chain visuals), six labels and six labeled tethers. Two bodies and two
tethers are visible at once; visible pairs swap every two seconds. It warms
300 ticks, then measures 2,000 at 72 Hz. Both versions use identical real Mol*
state trees, geometry and transform code; canvas uploads are counted, not sent
to a GPU. Font rasterization is stubbed.

| Per tick | Before | After |
| --- | ---: | ---: |
| Mean CPU ms | .1013 | .0240 |
| p50 CPU ms | .0853 | .0221 |
| p95 CPU ms | .1695 | .0297 |
| Canvas upload calls | 16 | 1 batch |
| Changed render objects | 22 | 10 |

Hidden bodies need only visibility sampling; interpolation, transforms, label
placement and bounds repair stop until they reappear. Unchanged visible poses
also skip uploads. Rigid motion retains instance-grid membership/order and
buffer storage, repairs the transformed cell/batch spheres, and uses the
normal representation state setter within a synchronous transform-only scope.
Appearance and instance-transform edits keep the upstream path. Presentation
matrices and object lists are cached between scene edits.

These numbers support a substantial pose-CPU reduction; they do not establish
68–72 unique Quest frames per second or device p95 below 1.5 ms.

## Figure-install profile

From `plugin/`, run:

```sh
node --import tsx ../lab/browser-roundtrip/figure-install-benchmark.mjs \
  --baseline 3fc2143 --source /path/composite.cif --lesson /path/flipbook.json
```

The profile uses the actual ATP and kinesin flipbook composites and chapter
figures. Values below average two warm complete chapter traversals after one
first traversal. The harness also reports first-visit transition timings;
those include different JIT/font-cache warm-up and should not be extrapolated
to headset seconds.

| Full chapter traversal | ATP before / after | Kinesin before / after |
| --- | ---: | ---: |
| Figure install CPU ms | 216.1 / 62.6 | 247.2 / 48.8 |
| Target resolution ms | 150.7 / .27 | 172.0 / .28 |
| Molecular layers built | 11 / 11 | 13 / 9 |
| Annotation representations built | 44 / 38 | 68 / 47 |

Target selections are cached by source identity and selector. Consecutive
chapters retain matching opaque layers even when an earlier layer changes,
IDs/order change, or unrelated external geometry appears. Translucent layers
retain the conservative prefix/order rule. Unchanged label cells, glyph
buffers and render objects survive chapter changes; changed selection data,
params, source, and failed/rolled-back state transactions are checked.
Distance annotations are still rebuilt.

Expected savings concentrate on repeated selections and unchanged annotations:
71% ATP / 80% kinesin warm figure CPU locally. Newly introduced molecular
geometry still costs preparation time. The device's 1.7–2.3-second transitions
need remeasurement; no proportional device-time guarantee is implied.

## Validation

107 targeted tests passed, including actual composite label sizes for all
three demos, desktop regression checks, visibility/seek swaps, hidden bounds
versions, buffer identities, extra transforms/nonserial instance order,
batched uploads, staging cleanup, transparent ordering, label reuse, source
invalidation and rollback. Plugin `tsc --noEmit` and bundle rebuild passed.
The build emits the existing appearance-worker `import.meta`/IIFE warning.
