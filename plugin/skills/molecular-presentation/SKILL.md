---
name: molecular-presentation
description: Create source-backed molecular lessons and cinematic presentations in the standard Molecular Structure Viewer, with optional Stereofold WebXR headset playback and reusable lesson JSON.
---

# Molecular presentations

Create and compile lesson files with the bundled planner and Node.js 22 or newer.
File-only planning requires no viewer, MCP server, credentials, or paid service.
For live desktop presentation, use the separately installed Molecular Structure
Viewer, its structure-viewer skill, and its native `structure.*` tools. For
immersive playback, use the Stereofold runtime and stereo-structure skill.

## Start with the user's molecule

For a requested live presentation, open the chosen file through
`structure.open_from_chat`, retaining the returned
session and opening intent. Inspect the live state before making presentation
changes. An issued card or `sessionReady` alone does not establish a rendered
viewer. On a mounting timeout, recover the same intent/session; do not create
duplicate viewers or silently switch products. Continue preparing the lesson
files while live presentation is unavailable.

Identify the actual object, model, assembly, polymers and ligands. An arbitrary
molecule can support a visualization lesson; a functional explanation needs
source-backed identities and supporting sources. Never carry chain letters, residue
numbers or object IDs from an example onto a different file. For unpublished
files, keep coordinates local; ordinary desktop lessons need no tunnel.

Create an editable starter with the bundled planner, resolving the skill folder
from this installed file. Run the commands inside that skill folder:

```sh
node scripts/lesson.mjs create --source <molecule-file-or-reference> --out <new-lesson.json>
node scripts/lesson.mjs compile --input <lesson.json> --out <new-plan.json>
```

Both commands refuse to replace an existing output. The plan is explicitly
`plan-only`; it has no authority to claim viewer execution or source identity.
Examples are in `assets/`. Read their provenance before choosing one.

The planner applies these authoring limits: 24 chapters, 16 authored changes
per chapter, 128 compiled timeline steps, 60 seconds per chapter, and 600
seconds total per lesson. An individual change may last 0.1–20 seconds. A
single movie plan is limited to 20 seconds total; compiling a longer lesson
does not silently shorten it, and the result has no `renderMoviePlan` for the
whole lesson. These are planner and movie-export policies, not measured limits
of a desktop viewer or headset. Keep the requested scientific content and
fidelity; when it does not fit one plan or movie, prepare clearly bounded
parts or ask what the user wants prioritized instead of dropping material.

## Explore or teach in the standard viewer

For exploration, leave the normal manipulation controls available. For a guided
lesson, call `structure.save_scene` with the live `sessionId`, a unique `name`
and the current `expectedRevision`. Record the returned name and source binding
so the user can restore it later with `structure.load_scene`.

Compile the lesson, bind its targets to the actual live object, then apply each
chapter's `guidedApplyScenePlans` with `structure.apply_scene`. Use a fresh
`expectedRevision` and validate the patch with `dryRun` before the first use of
a target or representation. Confirm the applied result before describing the
scene. Preserve existing annotations/layers unless the requested presentation
explicitly replaces them; the compiler replaces only its own stable caption.

A lesson can present itself without tour chrome. Set the optional lesson-level
field `presentation: { "captionCard": "hidden" }` in the lesson JSON. The
headset then draws no caption card and no scene counter; the on-canvas caption
is left out of both rendered movies and guided `apply_scene` plans. The desktop
sidebar caption is unaffected, and narration still speaks. Omit the field, or
set `"shown"`, for the default behaviour.

Drive Next/Back by reapplying the chosen chapter, not by assuming Undo belongs
to the lesson. Save a named scene after a chapter when a precise rejoin point is
useful. When the user takes over, stop agent-driven changes; resume or restore
the saved chapter when requested. The standard viewer does **not** gain new
in-panel Play/Next buttons from installing this skill: these are agent-directed
chapters using its existing controls. Do not claim an unattended live player.

`inspect_lesson` is not part of this desktop path. Compile locally and use the
standard viewer's own `structure.apply_scene` for desktop chapters; call
`inspect_lesson` only for the optional Stereofold headset player.

## Cinematic output

Use the compiled movie timeline with `structure.validate_render`, then
`structure.render_movie` at the requested workspace destination. Check the
current live target identities, duration/frame bounds, and render completion.
Use the compiled `renderMoviePlan` when present; it exists only when the full
timeline is at most 20 seconds. For longer lessons, author movie-sized parts
that preserve the requested content rather than assuming chapter boundaries
alone meet that duration. A plan records intended
changes; `structure.validate_render` checks movie readiness against the live
viewer before `structure.render_movie` executes it.
Captions and changing scenes belong in the rendered timeline; accompanying
text alone is not an embedded caption. Keep native MP4 provenance with output.

In desktop films, slow rotation and deliberate cuts can illustrate depth.
In an immersive lesson, keep the wearer's viewpoint under their control;
change molecular appearance/placement instead of animating their head camera.

## Optional immersive headset handoff

Use the user's available headset browser. The Stereofold companion negotiates
WebXR capabilities rather than requiring a previously verified headset model. Meta Quest and
Apple Vision Pro have named link handoffs; other browsers use the generic
private HTTPS connection in the installed stereo-structure skill. Missing passthrough or
a convenience launcher calls for another supported mode or an authored scene or native
adaptation, not a declaration that the headset cannot show the scene. A scene
can have separate native and immersive intentions with the same checked source.

The standard viewer's browser tab is not itself an immersive renderer. Open its
checked coordinates and scene intentions in an immersive renderer. Use the optional
Stereofold tools only for the requested headset experience. A coordinate handoff
reopens the molecule; it does not preserve the entire scientific workspace.
The snapshot importer accepts one supported object, including the default
polymer-cartoon and ligand-sticks layer pair, with explicit paired provenance.
Ligands draw as ball-and-stick in Stereofold. Native matching requires an empty
selection and does not carry captions, annotations, measurements, maps,
additional representation layers, or a live link. Even a default viewer camera
can fail the parsed-coordinate clipping check. Preserve the refusal reason;
explicitly prepare an unclipped upstream view and re-export when that is desired.
Run the stereo-structure
skill's `inspect_scene` compatibility check before choosing a handoff; never
discard those features automatically.

For custom lessons, every chapter needs an explicit supported `immersive`
intent. Do not silently translate a rich desktop scene into a different XR
scene. Use `inspect_lesson` when available, then wait for a ready saved panel,
open its companion, and target `control_tour` using its exact live binding.
For spoken guidance with pauses for questions, start with `autoplay: false`
and advance chapters explicitly after confirming each render. Add
`narration: false` when host live voice supplies the explanation. Omit these
options for timed playback with scripted chapter speech.
The same chapter captions and timings can accompany separately authored
desktop and immersive scene intentions. Rejoin and Restore start are rendered
operations, and must be acknowledged before claiming success.

For a layered illustration, use the explicit `immersive.figure` intentions in
`assets/9ax6-daraxonrasib.json`. Its overview and interface chapters use cartoon
and translucent Gaussian-surface layers, named 3D labels, contact dots and
measured dashed 3D contacts. Targets use author chain and residue identifiers plus
optional component and atom names. Distance endpoints must resolve to one atom;
an authored `expectedAngstrom` is checked against the coordinates. Limits are
16 layers, 16 labels, 8 distances and 20,000 represented atom sites per chapter.
The example requires the exact PDB 9AX6 mmCIF digest and biological assembly 1.
The complete plugin also lists it as the named `daraxonrasib` demo in
`demos/index.json`, with its matching `demos/daraxonrasib.json` lesson. When a
user requests that demo, verify the recorded download digest and open the named
lesson with `inspect_lesson` and `assemblyId: "1"`; a plain PDB inspection only
offers the generic tours. Pause and use Next/Back for a conversational pace.
Use `context: true` for faint reference layers that should remain visible
without defining the closeup's menu-clearance silhouette. Keep the wearer's viewpoint intact; Next/Back changes the molecular scene.

Figure layers belong to the lesson. Moving, rotating or scaling carries the complete
illustration, and background edits remain live. Change the lesson definition to
edit individual figure layers or labels. Named inspection views preserve and
restore the lesson figure with the saved scene. The native workspace snapshot
importer does not import this additional lesson graph.

Bind structure-specific lessons to `provenance.sourceSha256`. The optional
headset loader rejects a different coordinate digest. For desktop, verify that
digest against the opened source before applying the lesson; local compilation
alone does not establish that the live native viewer has the same molecule.

For staged assembly within one coordinate source, use `immersive.visibility`
with `op: "only"`, a cumulative `chains` list, and `classes: ["polymer"]`.
Visibility uses deposited **label** chain IDs; emphasis uses **author** chain
IDs. Resolve both from the actual catalog. A repeated label chain in an
assembly needs an explicit `{ "labelChain": "A", "copyId": "..." }` target.
`hide`, `show`, and `reset` use the same visibility patch semantics as the
inspection controls. Hidden chains stay hidden through emphasis changes.
Keep the color key consistent; omit `focus` and set `contextOpacity: 1` for
opaque revealed units. Omit chapter placement, view and emphasis framing to
retain the wearer's placement. Use `motion: "hold"` to stop continuous spin.
The bundled `microtubule-arrival` demo shows this pattern with real deposited
tubulin copies, followed by a separate density stage. Visibility changes reveal
existing coordinates; they do not simulate assembly trajectories or kinetics.

Read the Stereofold stereo-structure skill for current pairing and headset
controls. LAN sharing keeps this route local; use public HTTPS transport only
when the user's task authorizes it. Emulator tests cannot establish physical
Quest passthrough, trigger behavior, comfort or perceived scale.

## Share or install the standalone skill

Copy this entire skill folder, including `scripts/` and `assets/`, into the host's skill directory. Claude Code reads project
`.claude/skills/` and personal `~/.claude/skills/`; Codex commonly reads
`~/.codex/skills/`. Use the host's configured location when
it differs. Claude Science supports skill upload and GitHub import through
**Settings** > **Skills** > **Add skill**.

The bundled planner needs no dependency installation. Share the intended
source files or public references with the lesson. Install the standard viewer
for live desktop chapters. For optional XR, register the full Stereofold runtime
directly or install its plugin package, and load stereo-structure.
Lesson JSON contains source references and scene
intent, not coordinate data or an authenticated live connection. Keep private
paths out of publicly shared examples and never package session/pairing tokens.
