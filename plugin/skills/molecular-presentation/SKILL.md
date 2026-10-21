---
name: molecular-presentation
description: Author and edit molecular lessons live in Stereofold's desktop panel or headset, including composite structures, labels, measurements and molecular animation. Also create reusable lesson files and offline presentation plans.
---

# Molecular presentations

Use the installed Stereofold runtime to build and teach scenes on desktop or in
a headset. Tool names below use `stereo_structure.`; resolve the host's prefix
from its tool list. Compare the first result with `toolSetVersion: "2026-10-14.demo.1"`;
if it differs, or a tool rejects or ignores a documented field, re-list that
tool's schema before working around it. No separate viewer or local authoring
script is needed for live lessons. Read [the complete worked example](references/live-authoring.md)
for a two-body scene, animated lesson and same-session edit.

For “show me the ATP synthase demo on my headset”, keep the session returned
by `continue_session` and make one call:
`replace_inspection_source({sessionId,demo:"atp-synthase-rotor",stage:"motion",waitForRenderMs:40000})`.
`demo` names an entry in the bundled `demos/index.json`; omit `stage` for its
default or name a listed stage. This verifies cached coordinates, fetches missing
coordinates under the existing policy, installs the complete bundled lesson and
starts its opening chapter with `autoplay:false,narration:false`. Motion within
a chapter still plays. The joined headset page and wearer placement rules stay
in effect; no new session or launch is needed. Use the same route for
`kinesin-walk`, `hemoglobin-switch`, single-source demos, or
`demo:"microtubule-growth",stage:"monomer"` followed by `grow_structure`.
Prepared density maps must already be cached; follow the returned preparation
command on a cache miss. Confirm `sourceRenderStatus.rendered:true`, or poll
`sourceRenderReceipt` for the current source and ready panel before reporting
it shown. Later lesson edits can use
`install_lesson({sessionId,lessonPath})` with the resolved absolute path of
`demos/atp-synthase-rotor/motion.json` instead of inlining JSON. `lessonPath` is restricted to the plugin's bundled demos;
supply exactly one of `lesson` or `lessonPath`, and omit `start` to retain intent.
Routine `get_inspection_state` summarises styles, selection ownership and
animation definitions; use `includeViewDetails:true` only for the exact saved
view, and `includeLesson:true` only for the editable lesson manifest.

For the 17-example **binder gallery**, continue the current session, then use
`replace_inspection_source({sessionId,demo:"binder-gallery",waitForRenderMs:40000})`.
This one call loads the prebundled source and complete `steady-target` lesson;
no prediction, composite preparation or manual lesson installation is needed.
After its rendered receipt, use
`control_tour({sessionId,action:"play",waitForRenderMs:10000})` for the authored
three-second dwell after each ready slide; `pause`, `next` and `back` use the
same control. Loading initially holds the first slide with narration off.
The same target coordinates stay fixed within each target group while aligned
binders change. This is an aligned comparison overlay. For each original
published predicted complex, load the same demo with `stage:"original-pairs"`.
Desktop **Source & details** discloses original names, records, target reference
and pinned sources. The few displayed stick residues are geometric examples,
not key sites or proven interactions. See [binder gallery and display fields](references/binder-gallery.md)
for the exact route and editable fields.

The labels include the published toxin names and Adaptyv KD values, preserving
upper-bound and approximate markers. For the 17 study-qualified binders
followed by one representative pairing per other design evaluated in the study, select
`demo:"binder-gallery-extended"`. It streams bounded local batches and marks
predicted scores separately from measured binding; see the same guide for
selection rules and batch-boundary controls.

Bundled demos default to a bounded 40-second render wait; use
`waitForRenderMs:0` to return immediately. If that wait ends first, the result
says "still drawing" with `sourceRenderStatus.status:"rendering"` and a pollable
`commandId`. This is pending work: poll
`get_inspection_state({sessionId,commandId})` for the current source receipt; do
not report failure or resend the load. Only a current ready rendered receipt
establishes that it is shown.

## Open or edit live

1. Call `continue_session` with the calling assistant's name (`Claude` or
   `Codex`) and keep its `sessionId`; for an existing lesson, read
   `get_inspection_state({sessionId,includeLesson:true})` and edit through step 5.
   For any new scene or lesson in a joined headset session, use
   `prepare_composite` (or a source) → `replace_inspection_source({sessionId,source,
   waitForRenderMs:10000})` in that joined session → `install_lesson({sessionId,
   lesson,start:{chapterId,autoplay:false,narration:false},waitForRenderMs:10000})`,
   without a new session or connection question.
   Only when nothing is joined or the user asks for a separate scene, use
   `inspect({source})` or
   `inspect_lesson({source,lesson})`; preparation returns the reusable `source`
   handle and `sha256`.
2. Author the lesson against that source's actual chains, residues, model and
   assembly. Bind `provenance.sourceSha256` to its digest. Every chapter needs
   `immersive` intent; Stereofold uses it on both desktop and headset.
   A functional explanation needs supporting sources. An illustrative motion
   establishes neither a measured trajectory nor molecular kinetics.
3. For a new desktop scene, let an MCP Apps host mount the panel; in a
   text-only host, call
   `open_inspector({sessionId,waitForSceneMs:40000})`. Confirm `hasScene:true`
   and a current panel with `availability:"ready"` through
   `get_inspection_state`; `get_readiness` lists capabilities in `readiness.items`.
   Keep the same tab and session while it loads. For a requested headset with
   no shared session, use stereo-structure's `open_companion` route.
4. A new `inspect_lesson` opens its first chapter itself, without autoplay or
   narration, before its scene is saved. Do not send `control_tour` start
   afterwards: that restarts the chapter and its motion. The chapter is held
   for conversation and speech is left to the host. Read current state before
   `next`/`back`; use `play` for requested timed chapters, or explicitly
   restart with narration (`customTourId` is the `tourId`) for requested
   scripted speech.
5. Change the complete manifest and call `install_lesson({sessionId,lesson,
   waitForRenderMs:10000})`. It preserves source, selection, placement and viewer
   hold; stable chapter IDs retain the active chapter, falling back to the
   first if removed. Later edits omit `start` to preserve the current chapter
   and playback intent; the first install uses the explicit start in step 1.
   Optional `sourceToken`, `serverEpoch`, `baseStateRevision` and
   `baseInspectionRevision` reject stale edits. Re-read state on conflict before applying the requested change.
6. Poll `get_inspection_state({sessionId,commandId})` until `command.terminal`
   is true (the text block's `terminalStatuses` lists every final status);
   only `rendered` confirms drawing and saving for the current source and revision.
   Read its reason once, stop polling, and never infer render failure from
   unrelated log words such as a HUD `asleep` reason.

Text-only hosts read JSON in `content[].text`. Preparation emits a complete
JSON result before the bounded summary: retain its `source` including `handle`,
`sha256`, `bodies` and `labelChainMapping`. The summary omits the handle; do not
overwrite the complete source with its shortened `source`. Read `sessionId`,
`sourceToken`, `customTourId` and `hasScene` from opening; `targetPanel`,
`animation`, `placement` and `command` from state; and `readiness` from readiness.
Request `get_inspection_state({sessionId,includeLesson:true})`, parse the
complete `lessonManifest` in its own fenced JSON block, edit that object, and
reinstall it as `install_lesson`'s `lesson` with `start` omitted for later edits.
The bounded state block never holds a partial manifest; its 6,000-character
cap and `truncated:true` describe omitted summary fields, not absent lesson data.

## Author figures and motion

Optional chapter `details` (at most 2,000 characters) appears in the desktop
**Source & details** disclosure. It never becomes caption text, narration or a
headset HUD line; the disclosure retains its open or closed state between chapters.
Use it for source identity and presentation-method qualifications while keeping
the visible caption concise.

`immersive.figure` holds layers, labels and distances. Targets use author
`chain`, inclusive `residues:{from,to}`, optional `componentId` and `atomName`.
For noncontiguous selections, use `residueNumbers:[7,12,20]` (1–256 unique author
numbers); it intersects any other target filters. A figure layer may use
`representation:"sticks"` for bond cylinders without atom spheres, with optional
`sizeFactor` (0.1–2; 0.14 is a thin-stick starting point). It draws the selected
whole residues unless the target further filters atoms. A label's optional
`desktopSizePx` (14–48) sets desktop text size without changing headset sizing;
`sizeFactor` and `maxOffsetEm` retain their existing roles.
Distance endpoints must resolve to one atom; `expectedAngstrom`, if supplied,
is checked against coordinates. Figure distances must stay within one rigid
body during animation. For “the distance between the two heads”, read
`lesson.parts` and the current chapter from state, then call
`measure({sessionId,targets:[{part:"head-1"},{part:"head-2"}]})` with the actual
part IDs; verify both parts are visible in the current chapter at the sampled time before
naming them to the user, since animated variants may never appear together.
Part endpoints select representative atoms, not centers; add `annotate:true`
for live lines that follow them, or supply exact atoms for distance, angle and
dihedral answers; `remove_measurement` removes those annotations. Tethers are
illustrative links without a distance readout.

An animation track owns `chains` by author ID. Omit `selector` for whole chains;
use `selector.residues:[{from,to}]` for inclusive author ranges, or
`componentIds` within that selector to add components. Ranges include insertion
codes and alternate atoms. Selected atoms must be nonempty and disjoint across
tracks. `pivot:[x,y,z]` is a source-coordinate point in Å. Each keyframe has
`t` in seconds, a normalized `[x,y,z,w]` quaternion in `rotation`, and Å
`translation` applied after rotation about the pivot. Omit `pivot` for rotation
about the model origin. Keyframe times strictly increase within the animation
duration; visibility events reveal or hide existing coordinates.

Labels wholly anchored in a moving selection and exact-atom tether endpoints
follow it. Start `offsetX`/`offsetY` near the anchor (5–16 Å, as in the
demos’ small offsets), then check both eyes once with
`capture_headset_view({source:"device",maxWidth:1600})` after rendering.
Each tether has a unique `id`, `from` and `to` atom
`{chain,residue,atom}` on different bodies, with at least one moving body;
optional `color` is hex and `label` is fixed text. Chapter exit restores the
original representations. Playback changes transforms without rebuilding
geometry; read `animation.representationCounts` when diagnosing complexity.
Overlapping display layers that exceed one added representation per selected
track are refused.

Use deposited label chain IDs for `immersive.visibility`, author IDs for
emphasis and figures. Repeated assembly copies need explicit `copyId` targets.
For cumulative reveals use `op:"only"` with cumulative `chains` and
`classes:["polymer"]`. Resolve IDs from the source catalog. Use `motion:"hold"`
to stop spin; omit placement, view and framing to retain the user's placement.
`context:true` figure layers stay faint (opacity at most 0.2) without defining
closeup framing. `presentation:{"captionCard":"hidden"}` hides the scene card
and counter; narration and the desktop sidebar caption remain available.

For spoken emphasis targets beyond a full colour key, add up to 16
`immersive.parts` entries without adding figure labels. For example,
`{"id":"atp-analogue","label":"ATP analogue (AMP-PNP)","aliases":["ATP","the ATP","nucleotide","AMP-PNP"],"color":"#fff1c9","chain":"K1T","residues":{"from":1001,"to":1001}}`
lets `emphasize({sessionId,parts:["ATP"]})` light the deposited analogue.
A shared name lights all matching targets; exact part IDs select one. The
chapter colour key remains limited to 32 and paints only its own parts.

Limits remain: 256 KiB UTF-8 inline manifests; 24 chapters; 16 changes per chapter;
60 seconds per chapter and 600 seconds per lesson; 0.1–20 seconds per change;
32 animation tracks, 64 chains per track, 512 keyframes and 512 visibility events
per track; 16 tethers with labels up to 80 characters. Figures allow 16 layers,
16 labels (60 characters each), 8 distances and 20,000 represented atom sites
per chapter. Live animation speed controls accept 0.1–4. These are authoring
policies, not measured device capacities. Preserve requested content in bounded
parts when it exceeds a limit.

## Offline planning and optional movie export

With Node.js 22 or newer, run from this installed skill folder:

```sh
node scripts/lesson.mjs create --source <molecule-file-or-reference> --out <new-lesson.json>
node scripts/lesson.mjs compile --input <lesson.json> --out <new-plan.json>
```

Both refuse existing output files. The result is `plan-only`; compilation
proves neither live source identity nor rendering. Examples in `assets/` carry
their source provenance. File-based live loading remains available through
`inspect_lesson({filePath,lessonPath})`; both paths must be absolute and readable
by the runtime host, which may differ from the conversation's file workspace.

The planner caps compiled timelines at 128 steps. A whole `renderMoviePlan`
exists only for lessons at most 20 seconds long; longer lessons retain their
content and need separately authored movie-sized parts. External movie export
has no molecular animation-track adapter. Stereofold live playback supports
these tracks. If the user already chose the separate Molecular Structure
Viewer, use its own skill and `structure.*` tools for guided plans or validated
movie export; keep that workbench and its native provenance.

Copy this whole skill folder, including references, scripts and assets, for
standalone offline planning. Live Stereofold work needs its registered runtime;
copying a skill alone does not register it. Share lesson JSON with its source
references or intended coordinate files, excluding private paths and session
or pairing credentials. Read stereo-structure for source handoffs and rendering
receipts, and stereofold-setup for registration or missing runtime files.
