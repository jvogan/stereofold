# Published binder gallery data

Seventeen published ESMFold2 predicted binder–target complexes from the pinned
Anthropic scorpion-toxin binder dataset, normalized for a preloaded Stereofold
presentation. `gallery.cif` contains every atom from the 17 selected PDB files;
each slide reveals one binder and one target. The default **Steady target**
slideshow keeps the first target in each group fixed while switching aligned
binders. This is a comparison overlay, not each original predicted complex.
**Original pairs** shows each binder with its own published target; one rigid
transform applied to both chains preserves that pair's relative geometry.

`manifest.json` is the source and slide mapping contract. Display labels are
Binder 01–Binder 17, with published toxin names beside stable target numbers:
Target 1 · Cn2, Target 2 · AaH II, Target 3 · AaH I, and Target 4 · LqhIII. Both author and label chain IDs are
`B01/T01` through `B17/T17`; the target ID repeats as a display label, while its
coordinates remain a separate copy per pair. The manifest maps these labels to
original dataset UUIDs, names, sequences and source files. Original PDB chain A
is always binder; original PDB chain B is always target.

The source order is Cn2 (7), AaH II (4), AaH I (4), LqhIII (2), preserving the
original `design.csv` row order within each target group. Only rows with
nonempty `binder_against` are selected. Each must match exactly one
`structures/INDEX.csv` row with the same UUID, `kind=predicted complex`,
`predictor=ESMFold2`, and `toxin=binder_against`. Ts1 has no selected binder.

## Published binding metric

Each binder label shows its published **Adaptyv KD in nM**, for example
`Binder 01 · Adaptyv KD 112 nM`. Values join `manifest.entries[].uuid` as text
to `upstream/design.csv.uuid`, then use the entry's qualified `target`:
`Cn2_Adaptyv_KD_nM`, `AaHII_Adaptyv_KD_nM`, `AaHI_Adaptyv_KD_nM`, or
`LqhIII_Adaptyv_KD_nM`. The dataset defines these as the arithmetic mean of
Adaptyv's fitted 1:1 replicates (SPR and BLI alike). This measures binding,
not toxin neutralization or experimental efficacy of the predicted model.

Binder 02 uses **≤3.1 nM**, an upper bound. Binders 12–15 use **≈** for the
approximate AaH I fits. Qualifiers come from target-specific `KD_note` entries;
Binder 08's note concerns Ts1, so its AaH II value is unqualified. Source and
column are retained in each chapter's details. No missing value is zero.

These are all **17 designs meeting the authors' published binder criteria**,
not a ranked top 17. The criteria require hits at both labs in every replicate,
all main-screen KD values at 1 µM or tighter, a Twist fitted/theoretical Rmax
ratio at most one, and no CLEC12A signal; LqhIII was measured only at Adaptyv
and follows the published exception. The 194 other tested designs are not
included in this slideshow. See the pinned upstream `README.md` and
`COLUMNS.md` for definitions, assay qualifications and the original tables.

## Open and control

From the repository root:

```sh
pnpm --dir plugin run demo binder-gallery --device quest2
# Preserve each original predicted pair instead:
pnpm --dir plugin run demo binder-gallery --stage original-pairs --device quest2
```

Press Play to advance through all 17 examples, with a three-second dwell after
each model is ready. Add `--play-tour` to start when the headset pairs. Back,
Next and Pause remain available. Dragging, rotating or resizing the model does
not stop playback; later slides inherit the current placement. Within each
target group the steady-target view uses exactly the same target coordinates.

The white figure style uses a gray target surface, blue binder ribbon and a
translucent binder envelope. Four nearby residue pairs are shown as thin sticks
at each interface. These are illustrative side-chain proximity examples within
4.5 Å, not experimentally established key contacts. The fixed-reference and
original-pair views calculate their examples from their own displayed geometry.

Quest's default entry shows the room behind the model. Turn **Room off** in the
headset menu (or say “VR mode”) to hide the room and see the light background;
this keeps the current immersive session and model placement. Surface preparation
adds a brief transition after each three-second dwell.

An agent in a joined scene can use
`replace_inspection_source({sessionId, demo: "binder-gallery", stage: "steady-target"})`, or
use `inspect_lesson` with absolute paths to `gallery.cif` and `lesson.json`,
then use the normal `control_tour` controls. Source & details gives the original
name, record, reference target and pinned source for each example. Identifiers
are stable aliases, not rankings or evidence of experimental efficacy.

## Contents

- `gallery.cif`: single composite, all 34 chains, one model.
- `structures/BinderNN.cif`: individual aligned pair with declared sequences.
- `manifest.json`: per-file SHA-256, upstream revision, exact rigid matrices,
  alignment statistics, original identities and complete sequences; separate
  original-pair and fixed-reference-overlay 4.5 Angstrom proximity residue lists.
- `upstream/`: six original source metadata/license files and seventeen selected
  PDB files, all unmodified. The extended gallery also retains the seventh
  metadata file, `in_silico_scores.csv`, here; its additional 194 source PDBs
  live under `extended/upstream/structures/`. No whole-dataset snapshot is required.
- `PROVENANCE.md`: sequence verification, alignment and fidelity details.
- `CREDITS.md`: dataset citation, CC BY 4.0 attribution and third-party notices.

## Reproduce and verify

From the repository root, with Python 3 and NumPy available:

```sh
python3 plugin/scripts/prepare-binder-gallery.py
python3 plugin/scripts/prepare-binder-gallery.test.py
pnpm --dir plugin exec vitest run test/binder-gallery.test.ts
```

Preparation is offline by default. `--fetch` explicitly permits fetching
missing files at the pinned revision, requesting only the six metadata files
and 17 matching complexes. `--out /absolute/output/directory` prepares another
copy. Existing upstream files are verified against pinned byte digests; the preparation does not overwrite them. Generated mmCIF and manifest
outputs are deterministic for the current numeric environment.

The Python checks verify both proximity modes against their own coordinates,
reject changed upstream bytes and independently verify all original atom identities,
occupancy/B-factor values, sequence mapping, proper rigid transformations,
cross-chain CA distance preservation, alignment statistics and reproducibility.
The focused Mol* check parses the actual composite into one model with 34
polymer chains and all source atoms. These establish data fidelity and parsing;
they do not establish desktop/headset rendering performance.
