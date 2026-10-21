# Exterior figure labels in XR

A figure label can opt into `placement: "outside-figure"`. Omit it (or use
`"attached"`) to retain the existing attached-label behavior. This option affects
XR placement only; desktop placement keeps its existing policy.

```json
{
  "id": "binder-label",
  "target": { "chain": "B01" },
  "text": "Binder 01 · Adaptyv KD 112 nM",
  "color": "#17343e",
  "placement": "outside-figure",
  "offsetY": 25,
  "maxOffsetEm": 5,
  "sizeFactor": 1.7
}
```

The existing glyph geometry, font, atomic coordinates and authored lesson are
preserved. On the first tracked, render-ready draw, the two-eye solver considers
conservative projected bounds of committed visible molecular instances, UI glass
and preceding labels. Exterior labels can repair their preferred position by up
to **12 em per axis**, while staying inside both lens margins. This is an explicit
exception to `maxOffsetEm`: that property still caps the preferred authored XR
position and all ordinary attached-label repair; desktop continues to use it.
The existing two-degree character ceiling remains in force. Clearance does not
shrink text or enlarge the opaque plate. Bounds are refreshed after relocation
so culling contains the drawn backing. When no readable exterior position fits,
the label falls back to the ordinary attached policy and may overlap the molecule;
its name and metric remain available. Both-eye lens margins and UI/label collisions
apply to that first placement. If that fallback cannot fit safely either, the
existing clipping policy hides the label until an initial position fits.

That initial placement is baked into the derived label anchor in molecule
coordinates. It follows subsequent molecular translation, rotation and scaling.
The text still faces the viewer, but head turns never re-pick its source anchor,
move it to a different gap or lens edge, or switch it between exterior and
attached placement. Looking away naturally takes it out of view. A later
molecular rotation or head movement may put the molecular surface behind the
label; preserving its attachment takes priority over continuous clearance.
Chapter replacement labels reuse the first source-relative offset for their
authored label `id` (for example `binder-label`), even when the label text or metric
changes. Their own selected molecular anchor still changes with the chapter.
A genuinely new source identity gets new initial placements. Sources explicitly
declaring the same presentation `coordinateFrame` reuse role offsets across stage
boundaries; another frame or an unframed source remains isolated. Shared-frame
tokens belong to the current viewer registry; ordinary source ownership is weak.
Exiting XR restores each original authored label anchor for the
desktop. No atomic coordinates are changed.

The bounds are deliberately conservative, so labels clear the complete projected
instance rather than attempting to fit between helices. Near-eye geometry that
crosses the eye plane cannot prove an empty exterior region.

## Activate for the binder galleries after a live run

Do not change stage lesson files during an active gallery run. After it finishes,
set `placement: "outside-figure"` on both named figure labels in every chapter of
`plugin/demos/binder-gallery/lesson.json` and `original-pairs.json`, preserving all
other fields. The extended generator applies the opt-in to its copied selected17
stage and every new batch automatically. Regenerate offline:

```sh
python3 plugin/scripts/prepare-binder-extended.py --update-index
python3 plugin/scripts/prepare-binder-extended.test.py
pnpm --dir plugin exec vitest run test/binder-extended.test.ts test/binder-gallery.test.ts test/lesson-figure.test.ts
STEREOFOLD_DEMO_CACHE="$HOME/Library/Caches/Stereofold/demos" node --test --test-concurrency=1 lab/browser-roundtrip/figure-label-placement.test.mjs lab/browser-roundtrip/figure-eye-plates.test.mjs lab/browser-roundtrip/immersive-annotations.test.mjs lab/browser-roundtrip/plate-eye-cap.test.mjs
```

This regenerates lesson metadata and hashes; molecular coordinates and their
coordinate hashes remain unchanged. A runtime build containing the opt-in is
required before checking it in the headset. Inspect rotations and both eyes;
CPU geometry checks do not establish physical readability.
