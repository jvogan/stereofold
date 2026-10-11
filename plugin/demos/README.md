# Cinematic demos

Ten authored lessons plus two staged demos for WebXR headset browsers.
Ask your assistant to open a lesson by name, such as “Teach me hemoglobin
using the bundled lesson and matching coordinates.” Follow
[QUICKSTART.md](../QUICKSTART.md) for the download and opening steps. Lesson
paths and coordinate URLs with their expected SHA-256 digests are in
`index.json`. Coordinates are downloaded separately; growth caches them locally.

| Demo | Entry | Shows |
| --- | --- | --- |
| `daraxonrasib` | 9AX6 assembly 1 | White overview and ligand interface: coloured proteins, labels, contact dots and measured 3D dashed lines |
| `telomerase-haca` | 8OUE | Human telomerase H/ACA RNP lobe, two dyskerin copies on one RNA — the default go-to demo |
| `crispr-cas9` | 9KJ6 | Cas9 with its guide RNA and both target DNA strands |
| `microtubule-lattice` | 5SYF | Three protofilaments of a Taxol-stabilized microtubule |
| `hemoglobin` | 4HHB | Four subunits, four hemes, the deoxy state |
| `nucleosome` | 1KX5 | 147 base pairs of DNA on a histone octamer |
| `spike` | 6VXX | The SARS-CoV-2 spike ectodomain trimer, closed |
| `atp-synthase` | 8H9V | Human ATP synthase: catalytic head, stalk, c-ring |
| `tubulin-dimer` | 5SYF | One alpha-beta dimer, the microtubule building block |
| `glucose-transporter` | 4PYP | Human GLUT1, a membrane transporter with its cavity |
| `microtubule-growth` | 5SYF, 3JAK, EMD-6347 | Seven tiers, monomer to complete tube to EB3 on the lattice |
| `microtubule-arrival` | 5SYF, EMD-6347 | Tubulin copies appear in place, followed by a large density tube overhead |

Every lesson carries its own entry URL and primary
citation DOI in `provenance.sourceRefs`, and `index.json` repeats them.

## The illustrated demo and live exploration

Ask “Open the bundled daraxonrasib demo on my headset.” The assistant reads its
entry from `index.json`, verifies the downloaded coordinate digest and opens
`daraxonrasib.json` with `inspect_lesson` and `assemblyId: "1"`. Its two scenes
hold for 60 seconds each and keep the last scene; pause and use Next/Back for
your own pace. This opens the named lesson rather than the generic Tours on a
plain PDB inspection.

While connected to an assistant, request background, appearance, selection,
focus, placement or chapter changes conversationally. A request may interrupt
autoplay; Rejoin or select the chapter to recover its framing. The assistant
waits for a rendered receipt before saying a change is visible. Headset Talk
needs the host's speech recognizer and an active agent conversation; direct
dictation to the assistant can use the same scene controls. Actual headset
microphone input still needs wearer qualification.

The other single-source cinematic lessons usually contain five or six scenes;
`hemoglobin` has six and the taught `crispr-cas9` has nine. The illustrated
`daraxonrasib` has two held scenes. Those labels and molecular layers are an
authored figure; editing each label or layer currently requires changing the lesson
definition. Users can open their own coordinates and separately authored
immersive intentions; an image mockup alone supplies neither coordinates nor
confirmed interaction chemistry.

## The staged demo

`microtubule-growth` shows seven stages of tubulin assembly and EB3 binding.
Each tier is a whole lesson with its own coordinates. Ask the assistant to open
the desired tier by name.
The `filament` tier needs a separately prepared density asset; a live session
does not prepare it. If the map is absent, skip that tier by naming `tip` from
`wall`. The `tube` tier exceeds the Quest 2 size budget.

| Stage | Coordinates | Atom sites | Catalog rows | Source bytes | Tier |
| --- | --- | ---: | ---: | ---: | --- |
| `monomer` | 5SYF entity 1, chain A | 3,343 | 437 | 423,766 | any |
| `dimer` | 5SYF asymmetric unit | 6,818 | 867 | 775,288 | any |
| `protofilament` | 5SYF assembly 1, operators 1 and 14 | 13,636 | 1,734 | 1,650,023 | any |
| `wall` | 5SYF assembly 1, operators 2-7 | 40,908 | 5,202 | 4,885,890 | any |
| `filament` | EMD-6347 density, downsampled 4x, beside 3JAK | 0 | — | 178,236 triangles | any |
| `tube` | 5SYF assembly 1, all 26 operators | 177,268 | 22,542 | 775,288 | classes other than Quest 2 |
| `tip` | 3JAK | 43,066 | 5,800 | 4,533,400 | any |

`filament` is a density map rather than atoms, so its size is a triangle count
and it is measured against a separate ceiling (`QUEST2_TRIANGLE_CEILING`,
500,000). The two units are never compared to each other.

`wall` is a suitable starting tier for Quest 2. Use the paired headset's
reported class for growth. Only an identified Quest 2 has the measured size
ceiling; other and unknown classes are not assigned an invented Quest 2 budget.
Inspect actual rendering and frame times as the user explores larger tiers.

## Growing without leaving the headset

`stereo_structure.grow_structure` changes
which tier is running, in the session the wearer is already inside:

```
grow_structure {"stage":"next"}    # one tier up  — "grow it", "add tubulin"
grow_structure {"stage":"back"}    # one tier down — "shrink it"
grow_structure {"stage":"tip"}     # a named tier  — "cap it"
```

The page replaces the coordinates and authored lesson together, keeping the
immersive session connected. Each transition reveals a complete tier; individual
tubulin copies do not animate into place. The source transition preserves the
displayed centre and diameter, rather than a fixed number of Angstroms per metre.
If a lesson chapter is on screen, the incoming lesson opens its first chapter
and applies that chapter's framing. An inactive lesson keeps the room placement
and applies the incoming colour key without chapter framing.

`device` decides what is allowed. A `quest2`-class headset is refused anything
over 43,066 atom sites, which is the `tip` tier exactly, so on a Quest 2 the one
refused tier is `tube`. The refusal comes back with a line short enough to speak
instead of an attempt that would drop the session with the headset on. The tiers
are ordinary demo stages, so growing only ever opens a coordinate file the index
already records with its digest; nothing is generated.

## The colour key

**One colour rule runs through all seven growth tiers, and it is this:**

| Colour | Means | Always |
| --- | --- | --- |
| `#4a90e2` blue | alpha tubulin, and whatever alpha holds | every tier, every chapter |
| `#f5a623` amber | beta tubulin, and whatever beta holds | every tier, every chapter |
| `#35c46a` green | EB3 | the `tip` tier, which is the only entry that deposits it |
| `#9aa5b0` grey | not the subject of this chapter | faded to `contextOpacity` 0.18 |

A wearer learns that mapping once in the `monomer` tier and it never changes
again, so blue never becomes a different chain and a chapter never repaints the
molecule. Three things enforce it:

- Every chapter's `immersive.appearance.color` is `uniform` at `#9aa5b0`. It is
  never `chain-id` and never `element-symbol`, so the same subunit keeps its
  colour across chapters and representations.
- Every chapter of a tier repeats that tier's whole `emphasis.parts` verbatim,
  the way `crispr-cas9.json` does, so the key is the same object in all five
  chapters and a wearer who jumps chapters lands inside the same mapping.
- A part is painted in the colour of the subunit it belongs to, ligands
  included: the GTP and magnesium on the alpha chain are blue, the GDP and the
  Taxol on the beta chain are amber. No part introduces a fourth colour.

A part names one deposited **author** chain, and a subset file's author chains
carry the operator suffix, so the key names them exactly: `A` and `B` in
`monomer`, `dimer` and `tube`; `A`, `B`, `A-14`, `B-14` in `protofilament`;
`A-2` to `B-7` in `wall`; and `A` to `L` plus EB3 on `M` and `N` in `tip`. The
`tube` tier is the one exception to per-copy naming: Mol\* instances the 26
operators from the asymmetric unit, so its author chains stay `A` and `B` and
one part covers all 26 copies at once. The `filament` tier names no parts at
all: its subject is one density surface, not chains, so the colour key and the
part phrases below do not reach it.

`stereo_structure.emphasize` and the wearer's own voice both reach these parts
by id or by label, so "show me the beta tubulin" binds in every tier that
contains beta tubulin — that is every tier but `monomer`, which is entity 1 of
5SYF and holds the alpha chain alone. "Show me EB3" binds in `tip`. "Show me
the Taxol" and "show me the GTP" bind wherever the entry deposits them. The tip
protein is EB3 from 3JAK and is never called EB1; the voice grammar refuses
"add EB1" in those words.

## Growth continuity

The atomic tiers keep alpha tubulin blue and beta tubulin amber across source
changes. The opening `dimer` and `protofilament` chapters light every tubulin
subunit, and the opening `wall` and `tube` chapters show the whole colour key.
The wall also shades its three strands so their lateral arrangement is visible.

Later chapters focus individual contacts. The wall's surface chapter highlights
the added lateral strand, operators 6 and 7, and fades the other strands to
context opacity. The `tip` tier focuses its two EB3 chains and fades the tubulin
context. These highlights explain the deposited structures; the tier transitions
are staged source changes, not a recording of polymerisation.
The room anchor uses each tier's bounds; it does not align corresponding tubulin
subunits between coordinate files.

## Walk-around build

For an assistant-controlled build that keeps the molecule at your chosen room
centre, use named tiers with the lesson inactive:

1. Open `monomer` and wait for its saved, rendered scene.
2. In the full headset menu, choose **Tours** to end the active lesson while
   keeping the scene. The assistant can use `control_tour` with
   `action: "menu"` for the same action. **Menu** alone only expands the controls.
3. In the expanded headset controls, choose **Close** or tap B/Y to return to
   compact controls without restarting the lesson.
4. Stop any spin with the assistant's motion control before walking around.
   Use `update_inspection` with `change: {kind: "motion", patch: {state: "stop"}}`
   and wait for its rendered receipt.
5. Place the molecule where you want to inspect it, then release the grab.
6. Ask the assistant to grow to `dimer`, then `protofilament`, then `wall`.
   After each `grow_structure` call, wait for `get_inspection_state` to report
   `sourceRenderReceipt.rendered: true` for the incoming source before continuing.
   Walk around each settled tier; the transition preserves its displayed centre
   and diameter.
7. Optional: Ask for a larger molecule after a tier renders. Adjust its placement
   scale, confirm the rendered change, then continue the build.
8. Optional: With the density asset prepared, request `filament` by name and
   inspect its hollow tube. Dynamic density transitions remain experimental;
   check the actual headset rendering. Request `tip` by name to compare the
   deposited EB3-bound lattice. On Quest 2, `next` from `filament` requests the
   unsupported `tube` and is refused.

Starting a lesson again restores chapter framing and motion. To show the wall's
added strand, start its lesson and advance to the surface chapter; return to the
inactive route before placing the molecule for another walk around it.

## Build a tube overhead

Ask **“Open the build stage of microtubule-arrival on my headset.”** Its `build` stage loads the
six-dimer wall once and reveals the deposited subunits in seven chapters,
followed by a held view of the completed wall:
alpha tubulin, its beta partner, a second dimer along the strand, then two
neighboring strands. Earlier subunits keep their coordinates and size. Blue
marks alpha tubulin; amber marks beta tubulin.

Prepared maps are not included in installed plugins or shares. The source
checkout's demo launcher prepares both stages in the local cache on the
computer hosting the session. Check its
prefetch result for the density map; a failed optional download leaves the
build stage usable. The first preparation downloads the original map and
reduces it on the computer. Later runs reuse the verified cache.

Pause the lesson for a narrated demonstration and use **Next** to add each
piece. The opening chapter sets one viewing angle so the dimer is easy to see.
Later reveals hold the molecule still without changing placement or the camera.
Place the structure where you want it, release the grip, and advance
the reveal while walking around it. **Back** restores an earlier saved chapter,
including its placement; use forward reveals to keep a newly chosen placement.

For the final reveal:

1. Prepare the `density` stage's map before the session and verify its digest
   against `index.json`. It reuses the `microtubule-growth` filament asset.
2. After the complete wall is visible, request the `density` stage.
   The agent calls `grow_structure` with `stage: "density"` and uses the
   `deviceClass` from `manage_companion` status as its `device`. Wait for the
   incoming source's rendered receipt and a current, ready companion panel.
   Its opening chapter can fit the map when you have not chosen a room
   placement; a placement held after your grab is retained.
3. Choose **Above us** in the headset. This requests an overhead object about
   four metres across, subject to the renderer's placement limits. Rotate it
   so the tube runs across your view and you can see its open end.
4. Hold the tube still for the final walk around it. Scaling changes the
   displayed size without adding geometry.

The build uses real coordinates from the Taxol-stabilized microtubule
[5SYF](https://www.rcsb.org/structure/5SYF). The finale switches to
[EMD-6347](https://www.ebi.ac.uk/emdb/EMD-6347), a separate cryo-EM reconstruction
of an EB3-bound GTPγS microtubule. This is an authored assembly reveal followed
by a change of specimen; its timing does not model polymerization kinetics.
The map's teal and amber colors distinguish inner and outer density by radius.

The full wall has 40,908 atom sites. The prepared density draws 178,236
triangles, within the repository's Quest 2 budget. The map was downsampled to
128³ voxels; the display does not retain the deposit's 3.4 Å resolution.
Rehearse the source transition and overhead placement on your headset
before recording. Measure frame times on that device.

## The five scenes

The cinematic lessons run the same beats in the same order: a wide reveal, a slow orbit,
a surface that shows the outward shape, a close-up with a cutaway, and a final
wide view. Scenes last 8 to 12 seconds. After the final dwell, playback
restores the starting view and resting controls, then says one ending line.
`presentation.end: "hold"` explicitly keeps the final scene until Done;
omitted or `"rest"` ends automatically. `motion: "hold"` only stops rotation.
Done also ends early, from the final compact row or expanded tour controls. A
lesson may add chapters of its own when it has something that entry alone can
say; `crispr-cas9.json` adds four, `recap-guide` through `recap-nucleases`, which
name each part again after the tour has shown it.

A chapter's `changes` are the desktop cinematic timeline, and its `immersive`
block is what the headset plays. The wearer keeps their own camera; molecular
appearance, placement and focus change around that viewpoint. Authored lessons
can also provide named emphasis parts and explicit figure layers, labels and
measurements, as the illustrated demo does. These are separate from the
cinematic desktop intentions.

Two immersive fields are about what the wearer notices in the first second.

`motion` is `spin` or `hold`, the continuous presentation turn. The player
applies placement and motion before it touches a representation, because a
transform lands in the next frame while a rebuild costs seconds on a Quest 2. An
opening chapter that asks for `spin` is turning before it has finished becoming
whatever it is turning into. Without it, a chapter whose only instruction is a
new absolute rotation lands as one jump and then sits still.

`narration` is one spoken line, rendered by the Mac and played in the headset as
the scene starts. A Quest 2 reports no speech voices, so a page cannot say this
for itself, and a lesson without narration simply runs on its captions. Keep a
line under eighteen words: a caption page holds fifteen characters on three
lines and dwells three seconds, so a long line is what makes a chapter drag.

`crispr-cas9.json` and all seven `microtubule-growth` tiers carry narration and
motion. The growth tiers keep the cinematic 8-to-15-second chapter, so their
lines are shorter still: under twelve words, which is about four seconds spoken
and leaves the rest of the chapter for looking.

## Captions and sources

Every factual claim in a caption comes from the RCSB entry data for that exact
entry: its method, resolution, entities, chains and bound molecules. Each lesson
carries the entry URL and the primary citation DOI in `provenance.sourceRefs`,
and `index.json` repeats them in a `sources` array with the citation title.

## Two ways to reach the complete tube

RCSB biological assembly 1 of 5SYF expands one tubulin dimer through 26 helical
operators into a closed 13-protofilament tube of 177,268 atom sites. The
expanded file is 21,070,967 bytes and this plugin fetches at most 16,777,216
bytes as its own download policy, so that file is not fetched.

**A deposited chain subset** keeps only the chains of the named entities of the
deposited entry. The `monomer` tier is entity 1 of 5SYF, the alpha-tubulin
chain alone, 3,343 atom sites in 423,766 bytes. Like the operator subset it
keeps whole deposited chains and alters no coordinate.

**Operator subsets** keep part of the expanded file. Each keeps whole deposited chains and the header rows that
describe them, and alters no coordinate. `microtubule-lattice` and the `wall`
stage use operators 2-7: three neighbouring protofilaments two dimers deep,
4,885,890 bytes. `index.json` records the operators kept and the digest of the
result.

**A named assembly** ships nothing expanded at all. A `coordinates.assemblyId`
in `index.json` reaches `inspect_lesson` as an `assemblyId` argument, and Mol\*
builds the assembly from the operator list the entry itself deposits. The
`tube` stage therefore opens all 26 operators and 177,268 atom sites from the
775,288-byte asymmetric unit. Nothing counts those repeated residue positions
against a ceiling any more. The 30,000-row bound a named assembly used to get
and the 200,000-atom-site cap beside it were never measured against a viewer,
so both are gone; the source-byte download policy is unchanged. What a headset
will actually hold is the measured ceiling above: `tube` is the one tier a
quest2-class device is refused.

## Verifying

After opening the lesson, read `get_inspection_state` and require a ready panel
and saved scene. Start its tour and wait for each command's `rendered` receipt
before reporting a visible chapter. The command-line server check and host
setup are documented in [QUICKSTART.md](../QUICKSTART.md).
