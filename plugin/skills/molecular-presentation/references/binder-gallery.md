# Binder gallery: load, compare and play

Use the actual host-prefixed `stereo_structure` tools. For an existing scene,
call `continue_session` with the caller's name (`Claude` or `Codex`) and retain
its `sessionId`. Then load the source and complete lesson in one call:

```javascript
replace_inspection_source({sessionId,demo:"binder-gallery",waitForRenderMs:40000})
```

The default stage is `steady-target`. It uses the bundled composite and opens
the first of 17 slides held, with narration off. Preserve the joined desktop or
headset session. Confirm `sourceRenderStatus.rendered:true`; if pending, poll
`get_inspection_state({sessionId,commandId})` for its current rendered receipt.
For a requested headset with no shared connection, use stereo-structure's
normal `open_companion` route after the scene is ready.

For a genuinely new session in a host that can render/listen, resolve these
paths from the active plugin root and open the complete local lesson directly:

```javascript
inspect_lesson({
  filePath:"/absolute/plugin-root/demos/binder-gallery/gallery.cif",
  lessonPath:"/absolute/plugin-root/demos/binder-gallery/lesson.json"
})
```

Keep its returned `sessionId` and use the normal companion route. The gallery
needs no placeholder 1CRN session or RCSB download. Do not use this new-session
route when `continue_session` reports `external-owner-unavailable` or a live
owner is still recovering.

For Claude Science with a confirmed listener denial, launch the bundled host
in an authorized Mac terminal outside the connector sandbox. Replace the
absolute paths with the active installation:

```sh
/absolute/path/to/node /absolute/plugin-root/dist/headset-host.mjs \
  /absolute/plugin-root/demos/binder-gallery/gallery.cif \
  --lesson /absolute/plugin-root/demos/binder-gallery/lesson.json \
  --atom-sites 22272
```

Keep that host running, join it with `continue_session({assistant:"Claude"})`,
and reuse its loaded gallery and connection. Add `--play-tour` only when
autoplay is requested; otherwise use Play after joining. For an already
authorized ADB-connected Quest, `--no-web-launch --open-on-quest` selects that
launch route. See the [Claude Science recovery sequence](../../stereofold-setup/references/hosts.md#claude-science-recovery-sequence)
for the distinct file, listener and Unix-socket permission checks.

To advance automatically, use:

```javascript
control_tour({sessionId,action:"play",waitForRenderMs:10000})
```

Each chapter has a three-second authored dwell after the model is ready at the
default pace. Use `action:"pause"`, `"next"` or `"back"` for the corresponding
controls. Do not send `start` after loading merely to begin playback: it
restarts the first chapter. The gallery retains placement through slide changes;
within a target group the steady view uses exactly the same target coordinates.

## Which geometry is displayed

- `steady-target`: an aligned 3D comparison. Each binder comes from its own
  published ESMFold2 model and is aligned to its group's fixed reference target.
  The displayed combination is a comparison overlay.
- `original-pairs`: each original predicted 3D model. Both chains receive the
  same rigid transform, preserving the published pair's relative geometry.

Switch to the original-pair lesson with:

```javascript
replace_inspection_source({sessionId,demo:"binder-gallery",stage:"original-pairs",waitForRenderMs:40000})
```

Desktop **Source & details** retains each original name, UUID, predictor,
pinned coordinate source, license credit and reference-target distinction.
Display labels Binder 01–17 and Target 1–4 are stable aliases. The data manifest
retains every original pair, transformations and full proximity lists. Each view
computes its proximity examples from its own displayed geometry.

## Small contact display and optional authoring fields

The gallery shows four illustrative close residue pairs as thin sticks. They
are selected by side-chain heavy-atom distance at or below 4.5 Å without reusing
a residue; they are not key sites, proven interactions or an affinity ranking.
The full contact lists remain in `demos/binder-gallery/manifest.json`.

This valid chapter fragment illustrates the optional fields using slide 1's
reference-overlay residue lists. Retain the rest of the complete chapter and
source-bound manifest when editing a live lesson:

```json
{
  "details":"Four geometric proximity examples are shown; full lists and original identities remain in the data manifest.",
  "immersive":{
    "figure":{
      "layers":[
        {"id":"binder-examples","target":{"chain":"B01","residueNumbers":[1,47,75,102]},"representation":"sticks","sizeFactor":0.14,"color":"#247fa2"},
        {"id":"target-examples","target":{"chain":"T01","residueNumbers":[13,15,21,24]},"representation":"sticks","sizeFactor":0.14,"color":"#929ba1"}
      ],
      "labels":[
        {"id":"binder-name","target":{"chain":"B01"},"text":"Binder 01","color":"#247fa2","desktopSizePx":32}
      ]
    }
  }
}
```

`details` is an optional string of at most 2,000 characters, shown only in the
desktop disclosure. `residueNumbers` selects 1–256 unique author residue numbers
and intersects range, component and atom filters. `sticks` draws bond cylinders
without atom spheres; it still includes backbone bonds of selected whole
residues. `sizeFactor` accepts 0.1–2. Optional label `desktopSizePx` accepts
14–48 and leaves headset sizing governed by `sizeFactor` and `maxOffsetEm`.

For source-checkout commands and offline verification, read
[`demos/binder-gallery/README.md`](../../../demos/binder-gallery/README.md).
Use `replace_inspection_source` for the bundled-demo tool route.

## Published measurements and the extended gallery

The normal 17-slide gallery shows the target's published toxin name and
**Adaptyv KD in nM** beside each binder alias. Lower KD means tighter measured
binding. Preserve `≤` (upper bound) and `≈` (approximate fit). These are the 17
designs meeting the authors' binding criteria out of 211 evaluated designs, not a ranked
top 17. Binding does not establish toxin neutralization.

For the 17 followed by one representative pairing per remaining design, use:

```javascript
replace_inspection_source({sessionId,demo:"binder-gallery-extended",waitForRenderMs:40000})
```

Then use the normal Play/Pause controls. This is an optional longer tour;
`binder-gallery` retains the short 17-slide tour. The extended tour loads
small local batches with three-second holds after rendering. Within each
batch, moving the molecule does not pause the slides. A batch change waits
for an active grab to be released, then continues automatically. Pause cancels
that pending advance. Shared target coordinates and the scene's current
physical placement are preserved across batches.

The remaining designs use stable `Design 018`–`Design 211` aliases, grouped by
the displayed toxin. Each uses its smallest positive reported Adaptyv KD among
intended targets labelled `hit`; if none qualifies, it uses the highest
published intended-target computational score. This is a display selection
rule, not a new experimental conclusion or an exact affinity ranking. Their
visible labels distinguish `not selected`, predicted score, and the actual
Adaptyv assay result. Original identities, both labs' results, qualifiers,
alternative targets and selection reasons remain in `catalog.json` and the
extended manifests.

For a new terminal host, use the same `gallery.cif` with
`binder-gallery/extended/selected17/lesson.json`. Reuse an existing host through
`continue_session` whenever one is already running. See
[`extended/README.md`](../../../demos/binder-gallery/extended/README.md) for
preparation and provenance.
