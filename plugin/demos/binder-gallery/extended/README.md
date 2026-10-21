# Extended published-design gallery

The optional `binder-gallery-extended` tour begins with the same 17 designs
that met the study's binding criteria, then shows one intended-target pairing
for each of the other 194 tested designs. The default `binder-gallery` tour
remains the short 17-slide version.

```sh
pnpm --dir plugin run demo binder-gallery-extended --device quest2
```

Play advances after a three-second hold once each slide renders. Rendering
adds time between slides. Pause stops playback. Small batches keep at most
30,000 atom sites and 24 chapters loaded; the current assets use 10 additional
batches. Moving the molecule preserves its placement and does not stop slides
within a batch. An active grab delays a batch change until release; playback
then resumes automatically. The headset stays in the same immersive session.

Use **Room off** for the opaque white figure background when recording.

## What the labels mean

The first 17 are all study-qualified binders, not a ranked top 17. Their labels
show the published target-specific **Adaptyv KD in nM**. Lower KD means tighter
binding. `≤` denotes an upper bound and `≈` an approximate fit. The summary
table combines reported fitted replicates; it is not uniformly a single SPR
measurement. Measured binding does not establish toxin neutralization.

The other designs use stable `Design 018`–`Design 211` identifiers. They did
not meet the full published binder-selection criteria. For each, the display
chooses the smallest positive reported Adaptyv KD among intended targets with
an Adaptyv `hit`. If none qualifies, it uses the highest published
intended-target `final_score`, a computational score from 0 to 1. Labels mark
predicted scores and show the actual Adaptyv assay result; a score is not a
binding measurement. Ties retain the source's intended-target order. The
selection rule does not make uncertain or bounded KD estimates exact.

The remaining designs are grouped by displayed toxin for a steadier visual
comparison, so their stable numbers are not consecutive in playback and are
not rankings. All 211 UUIDs appear exactly once.

## Coordinates and provenance

All structures are published ESMFold2 predictions from the pinned dataset
revision `0bac3d0286f7f83b5339f5b4f1e67fbe47a6e7c1`. No new predictions,
sequence changes, relaxation or structural optimization are performed.

Each toxin uses one common reference target across batches. Cn2, AaH II,
AaH I and LqhIII use the original short gallery's references; Ts1 uses its
first selected representative. A rigid target alignment places each binder
in that frame. This steady-target view is a comparison overlay, not the
original predicted pair. Original pair geometry and both sets of proximity
calculations remain in the manifests. The thin side-chain sticks illustrate
geometric proximity, not experimentally established key contacts.

- `../catalog.json`: all 211 identities, target-selection reasons, both labs'
  results, qualifiers and alternative targets.
- `source-lock.json`: retained upstream files and their hashes.
- `manifest.json`: ordering, batch sizes and artifact hashes.
- `batch-*/`: bounded mmCIF composites, authored lessons and per-entry
  provenance, transforms and contacts.
- `selected17/lesson.json`: the initial short gallery with automatic
  continuation enabled; its coordinates are the existing `../gallery.cif`.

The dataset is CC BY 4.0. See the parent gallery's `CREDITS.md` and retained
upstream license for attribution and third-party notices.

## Reproduce

```sh
python3 plugin/scripts/prepare-binder-catalog.py --check
python3 plugin/scripts/prepare-binder-catalog.test.py
python3 plugin/scripts/prepare-binder-extended.py --help
```

Preparation uses retained local inputs by default. Fetching requires the
script's explicit fetch option and uses the pinned public revision. Rebuilding
assets does not establish device performance; headset evidence is recorded
separately from source and data-validation tests.
