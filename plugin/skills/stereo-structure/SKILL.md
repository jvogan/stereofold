---
name: stereo-structure
description: Inspect molecular structures, control Stereofold scenes in WebXR headset browsers, and use side-by-side or anaglyph stereo viewing. Use for linked sequence selection, appearance, placement, tours, headset handoff, or continuing a shared Stereofold session.
---

# Stereofold

Use Stereofold for focused molecular inspection, stereo viewing, and immersive
scenes, composites, live lessons and atom measurements. Keep the user's chosen
scientific workbench for maps, trajectories and other analysis. The separate Molecular
Structure Viewer has its own `structure.*` tools; Stereofold's bundled full
Mol* viewer is another route. Choose the route the user requested.

Tool names use the `stereo_structure.` namespace. Resolve their host-specific
names from the available tool list. For installation or missing runtime files,
read the installed `stereofold-setup` skill.

Compare the first result with `toolSetVersion: "2026-10-14.demo.1"`; if it
differs, a tool seems missing, or a tool rejects or ignores a documented field,
re-list that tool's schema before working around it.
Text results contain prose and fenced JSON: parse each block separately;
requested fields precede catalogs and history in the bounded state block.
Read those blocks when the host exposes only `content[].text`; fields mirror the structured result, with
`targetPanel` and `placement` provided as convenient scene summaries. `get_inspection_state` includes `tours`,
`lesson.parts` (IDs and labels), `targetPanel.tour`, `animation`, `placement`,
and `panels`. With `commandId`, read `command` for that receipt, including its
status, rendered revision, timestamps and failure detail. Mutation results
include `commandId` and `command`, or source replacement's `sourceRenderStatus`
and `sourceRenderReceipt`. `continue_session` includes `role`, `sessionId` and
`scene`; `list_experiences` includes `experiences`; `get_state` includes viewer
state; `get_readiness` includes `readiness`.

The state block is capped at 6,000 characters including its fences. It has
`textStateVersion: 1`, `maxChars: 6000`, `truncated`, and the deterministic
`truncationMarker: "[truncated]"`. When `truncated` is true, trailing values were
omitted; missing fields do not mean an empty catalog or a completed operation.
Request `get_inspection_state({sessionId,includeLesson:true})` for the complete
`lessonManifest` in its own fenced JSON block, edit that object, and reinstall
it as `install_lesson`'s `lesson`, omitting `start` for later edits.
The bounded state block never holds a partial manifest; request a specific
receipt or smaller residue page for omitted summary fields.
Molecular coordinates, pairing codes, connection credentials and private keys
are excluded from this projection. Connection links remain in their original
result or local dialog. Structured results are unchanged.
Advisory sentences are omitted from the JSON; readiness flags and reason codes
remain. Failed receipts retain their status, reason and detail. Tool errors
retain the original prose and append JSON with `isError: true` and `error.message`.

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

Bundled demos default to a bounded 40-second render wait; use
`waitForRenderMs:0` to return immediately. If that wait ends first, the result
says "still drawing" with `sourceRenderStatus.status:"rendering"` and a pollable
`commandId`. This is pending work: poll
`get_inspection_state({sessionId,commandId})` for the current source receipt; do
not report failure or resend the load. Only a current ready rendered receipt
establishes that it is shown.

## Open or continue a scene

1. Unless the user requests a new or separate session, call `continue_session`
   with `assistant: "Codex"` in Codex or
   `assistant: "Claude"` in Claude Code or Claude Science. Keep the returned
   `sessionId` when `role` is `owner` or `attached`. Reuse an existing headset
   connection and use `replace_inspection_source` for a requested public source
   change. Joining a session alone does not establish a saved scene.
2. If `role` is `none` with `retry: true`, the existing scene's host is still
   running. Retry `continue_session` after 5 seconds; preserve that scene.
   After 60 seconds without recovery, inspect `recordPath` and its recorded
   process; preserve a live Stereofold host. Only create a new scene if its owner
   is confirmed closed or the record stale, or the user requests one.
   For `kind: "external-owner-unavailable"`, follow the returned
   host recovery instructions. Only when no scene or host recovery is pending,
   or the user requests a new session, call `inspect` with
   exactly one of `pdbId`, `structureText`, or `source`, or use `inspect_file`
   with an absolute `.cif` or `.mmcif` `filePath`. `structureText` is raw
   mmCIF only; for PDB text, set `source.kind` to `pasted` and `source.format`
   to `pdb`. `source` also accepts a PDB ID, an AlphaFold accession, an HTTPS
   coordinate URL, a local file, or pasted coordinates. Keep the returned
   `sessionId`. Use 1CRN for an unspecified small test. For a native viewer
   snapshot or a lesson, read [Handoffs and lessons](references/handoffs.md).
3. For desktop inspection, use the host's MCP Apps panel when available. If
   the host has no panel, call `open_inspector` with the same `sessionId` and
   `waitForSceneMs: 40000`. Its scene-readiness wait is capped at 40 seconds;
   if the scene is still loading, keep the tab open and poll `get_inspection_state` until
   it reports a saved scene and a current ready panel. Keep the rendered tab
   open. Before reporting a visible structure, confirm `hasScene: true` and
   the intended panel's `current: true` and `availability: "ready"`.
4. For a headset request with no shared headset session, call
   `open_companion` directly after opening the source. It opens a browser renderer when needed and waits for a saved scene.
   Choose the launch route in the next section. If it returns `sharePending`,
   repeat the same arguments to continue that operation.

The inspection workspace accepts these source shapes inside `source`:

| Source | `source` value |
| --- | --- |
| Public PDB entry (fetched as mmCIF) | `{"kind":"pdb","id":"1CRN"}` |
| AlphaFold DB model v6 | `{"kind":"alphafold","accession":"P69905"}` |
| Public coordinate URL | `{"kind":"url","url":"https://files.rcsb.org/download/1CRN.cif"}` |
| Local file | `{"kind":"file","path":"<ABSOLUTE_STRUCTURE_FILE_PATH>"}` |
| Pasted mmCIF | `{"kind":"pasted","text":"<insert full mmCIF text>","format":"mmcif"}` |
| Pasted PDB | `{"kind":"pasted","text":"<insert full PDB text>","format":"pdb"}` |

In the pasted examples, replace the angle-bracket placeholder with the complete
coordinate text. Replace `<ABSOLUTE_STRUCTURE_FILE_PATH>` with an existing
absolute path to a `.cif` or `.mmcif` file. URLs must use HTTPS and resolve to
UTF-8 mmCIF or PDB coordinates;
content is checked rather than trusted from its filename, and embedded URL
credentials are refused. Set pasted `format` to `"pdb"` for PDB text (or omit
it for content sniffing). The legacy `structureText` argument is mmCIF only.
PDB-ID lookups are fetched as mmCIF. Raw PDB text and HTTPS URLs that resolve
to PDB are normalized through Mol*; inspection of polymer chains from raw PDB
requires declared `SEQRES`, so coordinate-only PDB files should use the
separate [Stereo viewer](references/stereo-viewer.md) `stereo_structure.open`
route. Missing AlphaFold v6 files are refused without a model-version fallback.
The `source` object, local file reads, and pasted
payloads accept up to 64 MiB of UTF-8 source text; HTTPS downloads have a
60-second total deadline, including redirects and body transfer. These are
plugin admission policies, not measured limits for desktop parsing, rendering,
memory use, or headset capacity. Local file inspection keeps coordinates out
of the conversation. On `inspect` and `replace_inspection_source`, add
top-level `modelNumber` or `assemblyId` when the user requests a particular
deposited model or biological assembly; otherwise the first model and
asymmetric unit are selected.

## Build a scene or install a lesson

Use `prepare_composite` to build deposited bodies without local scripts. Sources
are RCSB IDs; optional source `sha256` pins exact bytes. Otherwise the tool reuses
its verified cached revision or downloads one. `authChains` selects the first
model, `residues` is an inclusive author-number range, and `ligands` retains
listed components whole (water is excluded). `atoms:"backbone"` keeps N, CA, C,
O and CB. Each `chain` is a unique output author chain. Matrices are row-major
3×4 rigid transforms with translations in Å. Supply exactly one of `matrix` or
`place` per body. `place.superpose.onto` names a body `id` (default: its output
`chain`) or a zero-based index; references may form a tree, never a cycle.
Optional `chains:{mobile:["B"],fixed:["A"]}` pairs retained author chains in
array order (default: each body's `authChains`). Optional
`residues:{mobile:{from:1,to:146},fixed:{from:1,to:141}}` restricts the fit;
`atoms` defaults to `"CA"`, or `"backbone"` for N, CA, C, O. The fit uses global
sequence alignment and equal-weight Kabsch with determinant +1. At least three
atoms must pair. Coverage below 30% on either side requires
`place.superpose.allowLowCoverage:true`. `place.then.translate` offsets the
fitted body in Å along the final composite frame axes.

For example, align a second deposited alpha-globin structure to the first:

```json
{"recipe":{"version":1,"id":"globin-fit","title":"Alpha globin comparison","sources":[{"id":"4HHB"},{"id":"1HHO"}],"bodies":[{"id":"reference","source":"4HHB","authChains":["A"],"atoms":"all","chain":"F","matrix":[[1,0,0,0],[0,1,0,0],[0,0,1,0]]},{"source":"1HHO","authChains":["A"],"atoms":"all","chain":"M","place":{"superpose":{"onto":"reference"}}}]}}
```

Read `bodies[1].matrix` and `bodies[1].superposition`: `rmsd` is in Å before
any offset; `pairedAtomCount`, `sequenceIdentity` (fraction of aligned residue
pairs identical), and `coverage:{mobile,fixed}` (fractions of selected observed
protein residues contributing atom pairs) describe the fit. Check these values
before using it; copy the returned matrix into another recipe to reuse it.
Copy the returned `source` into `inspect({source})` or
`replace_inspection_source({sessionId,source,waitForRenderMs:10000})` and check
the usual rendering receipt. Matrices and fit statistics also appear in text.

The result's `source` handle goes directly into `inspect`, `inspect_lesson` or
`replace_inspection_source`. Retain `sha256`, per-body `labelChains` and
`labelChainMapping`; visibility uses every returned label chain, including
ligands. Handles survive restarts while the runtime host's cache remains.
The 64 MiB policy applies to each input and output; `maximumAtomSites` adds an
optional caller budget. Preparation alone establishes no rendered scene.

For a new source requested with “put it in my headset” in an already shared
headset session, use
`prepare_composite` → `replace_inspection_source` in the joined session →
`install_lesson({sessionId,lesson,start:{chapterId,autoplay:false,narration:false},
waitForRenderMs:10000})`; the request authorizes delivery without a new session
or connection question. With no headset session, use `inspect_lesson({source,lesson})`
and the connection route below.

The first start after authoring uses `autoplay:false,narration:false`; later
`install_lesson` edits omit `start` and keep stable chapter IDs to retain the
current chapter and intent, preserving source, selection, placement and viewer
hold. Read `get_inspection_state` before navigating, and confirm rendered receipts.

Read [molecular-presentation](../molecular-presentation/SKILL.md) for authoring
limits and [the complete live example](../molecular-presentation/references/live-authoring.md)
for two bodies, a residue-range track about a pivot, labels, a tether, a
measurement and a same-session label and keyframe edit.

## Connect a headset

Pass the current `sessionId` with one of these argument sets:

| Route | `open_companion` arguments |
| --- | --- |
| Meta Quest (automatic) | `{"connection":"lan","headset":"meta","launch":"auto","waitForHeadsetMs":20000}` |
| Meta Web Launch explicitly | `{"connection":"lan","headset":"meta","launch":"web"}` |
| Apple Vision Pro Safari handoff | `{"connection":"lan","headset":"apple","launch":"auto"}` |
| Other headset browser or manual opening | `{"connection":"lan","headset":"auto","launch":"none"}` |
| Authorized Quest debugging over USB or Wi-Fi | `{"connection":"lan","headset":"meta","launch":"adb","waitForHeadsetMs":20000}` |

Keep complete credential-bearing links and pairing codes in the original tool
result or local connection dialog. Tell the wearer to use that result and
relay the returned certificate and XR-entry instructions. Send Meta Web Launch
once; its duplicate-launch refusal prevents a known Quest Browser hang.
For Web Launch or a Safari handoff, check `get_inspection_state` every 5–10
seconds until pairing or `pairingExpiresAt`. Allow time for the person's prompts;
do not resend or start a competing Manual pairing while that handoff is pending.
Recover after a reported failure or expiry. After pairing, or an adb dispatch,
allow up to 60 seconds for page progress, then read `manage_companion` with
`action: "status"` and diagnose the reported problem. An open share is not proof
that a launch was sent: follow `wearer.note` and the launch outcome. Only
`wearer.state: "in-vr"` confirms immersive rendering. `wearer.linked`
confirms attachment; `in-vr` reports advancing immersive frames, rather than
whether a person is wearing the headset.

Keep an already connected page and its session. `open_companion` reuses a
current page that checked in through the same private share, including a paused
page, and returns `headsetPage.reused` with its actual state. Resume a paused
headset page before describing edits as visible. Use `manage_companion` with
`action: "launch"` when a fresh launch is needed; repeated setup or new sessions
add work and can leave competing headset tabs.
Repeat `open_companion` with the same arguments only to resume `sharePending`.
If the pairing code expires (`pairingExpiresAt`), use `manage_companion` with
`action: "launch"` and the chosen route to get a fresh code. Meta and manual
handoffs return their instructions immediately; the 20-second page wait applies
to the authorized Quest debugging route.

For "Stop sharing", call `manage_companion` with the current `sessionId` and
`action: "close"`. Confirm `shareClosed: true`, `lan: null`, and
`wearer.shareOpen: false` before reporting that sharing stopped. The desktop
scene stays available.

Diagnose the route that failed before describing the headset as unreachable.
An ADB check concerns optional debugging; it does not establish whether the
headset is powered on, on Wi-Fi, or running a connected browser page. Read the
current share and page state first. For Meta, `open_companion` or
`manage_companion` with `action: "launch", launch: "auto"` discovers authorized
USB connections and reconnects a known Wi-Fi endpoint. Follow the reported
route and failure reason; check again when the connection changes instead of
relying on an earlier offline result. A paused page may need waking, while a
Meta sign-in page needs its existing account flow; neither means the headset
itself is absent. Preserve the existing scene and a pending human handoff.

Use the user's available headset and browser. Probe its secure context,
WebGL2, WebXR session modes, enabled features, blend mode, and input sources.
The companion prefers `immersive-ar` when available and falls back to
`immersive-vr`; controllers, hands, and transient pointers share its controls.
Named launch routes are conveniences. Optional features and adb debugging are
not general entry requirements.

If a requested feature is missing, name the API or permission involved and
try a supported mode, another available browser or runtime, or an explicitly
authored adaptation. Native integrations may expose hardware features absent
from browser APIs. Current schemas describe this renderer's capabilities.
Keep the checked source and verify rendered results in the chosen route.

Apply measured Quest 2 limits only to an identified Quest 2. For other devices,
measure frame times and adjust detail or the visible region. Physical Quest 2
observations and Vision Pro simulator results have different scopes; simulator
checks cannot establish physical passthrough, comfort, input behavior, or
perceived scale. Read [Headset operation](references/headsets.md) for pairing,
state meanings, recovery, and capture.

## Edit the current scene

Group compatible edits in one command; read state when target resolution or
receipt verification requires it. `update_inspection`,
`focus_selection`, `emphasize`, `undo_last_change`, `redo_last_change`, `control_tour`, and
`replace_inspection_source` fill omitted binding fields from the current
session and target the companion when attached. Pass `panelId` for a different
intended panel. Ordinary `update_inspection` visual edits without an
`utteranceId` are serialized per session when the four source and revision
bindings are omitted. The host fills `serverEpoch`, `sourceToken`,
`baseStateRevision`, and `baseInspectionRevision` from the live scene as each
edit reaches its turn. `panelId` and `commandId` can also be omitted; they
default to the current target and a generated ID. Supplying explicit revisions
keeps stale-revision conflict checks. This per-session serialization applies
only to ordinary `update_inspection` edits; it does not cover source
replacements or every tool, so do not assume other operations can be sent in
parallel safely. If an edit reports a conflict or that the scene
changed outside the queued edits, re-read `get_inspection_state` before
deciding whether to retry.
`open_detailed_view`, `import_detailed_view`, and named views require their
documented explicit bindings; read [Handoffs and lessons](references/handoffs.md).

Pass `waitForRenderMs: 10000` on supported edit calls. The render-receipt wait
is capped at 40 seconds per call even when a larger value is accepted.
A `rendered` receipt confirms a draw and save at its `renderedRevision`; compare
that revision with the current scene before describing it. Poll
`get_inspection_state({sessionId,commandId})` until the receipt's `terminal`
is true; the text block's `terminalStatuses` lists every final status.
Read its reason once and stop polling; unrelated log words such as a HUD
`asleep` reason never establish render failure. `saved` retains an edit for a
paused page to draw later; `unknown` does not confirm a render.

Name parts with residue selectors from the actual source, such as
`{"labelChain":"A"}`, `{"componentId":"HEM"}`, `{"classes":["ligand"]}`,
or an author residue range. Use state to resolve ambiguous targets. Avoid
copying opaque selection keys or example chain IDs onto another structure.
Retry the same request with its exact command ID and arguments; preserve newer
manual work and resolve unsaved-work notices before sending another change.
For a `commandReplay` result, use `originalBinding` and `currentSource` to
identify the original operation, then read current state before describing the
view. If its receipt has expired from history, check the current scene and use
a new command ID only for a new edit.

### Edit what is on screen

These are one-call edits once the session and targets are known. Add `sessionId`
and `waitForRenderMs:10000` to supported mutations. Fetch
`get_inspection_state({sessionId,includeLesson:true})` once if the current
manifest is unknown, then retain it for subsequent edits. Poll pending receipts
by `commandId`; do not resend an edit merely because its render wait ended.

| Request | Fewest calls and fields |
| --- | --- |
| Speed up, pause or seek molecular motion | `update_inspection` with `change:{kind:"animation",patch:{speed:2}}`, `{state:"pause"}` or `{seekSeconds:1}`; tour pause uses `control_tour` with `action:"pause"`. |
| Label residues or a ligand | One `update_inspection` compound with no state read first: a selection of `residues:{authorResidueRange:[248,248]}` or `{componentId:"HEM"}`, then appearance `labels:true`. The selection highlight can replace a color set on selected atoms, so call them highlighted and name no color for them. Read [labels](references/commands.md#label-residues-ligands-and-regions) for separate residues, ligand names and a text label on a region. |
| Relabel | Edit `lesson.chapters[i].immersive.figure.labels[j].text`, then `install_lesson` with the complete lesson. |
| Add a chapter | Append a chapter with a unique ID and explicit `immersive` intent, then `install_lesson`. |
| Recolor | `update_inspection` with `change:{kind:"appearance",residues:{authorChain:"C"},patch:{color:"uniform",uniformColor:"#ff8800"}}`; for a persistent authored figure color, change its layer and `install_lesson`. |
| Measure “the two heads” | Read `lesson.parts`, then `measure({sessionId,targets:[{part:"head-1"},{part:"head-2"}]})` with actual part IDs; verify both are visible in the current chapter at the sampled time before naming them, since animated variants may never appear together. Add `annotate:true` for a line; remove it with `remove_measurement` and its `measurementId`. |
| Swap the source | `replace_inspection_source` with `source`; preserves the connection, resets scientific scene and lesson. Check `sourceRenderReceipt`. |
| Make bigger or closer | `update_inspection` placement `patch:{scale:2}` or `patch:{translation:[x,y,z]}`. These are absolute values; derive them from current `placement`. Translation uses molecular radii, not metres; for “closer” use the current, non-stale `spatialContext` head direction in molecule-local axes. |

For an animated chapter, use `update_inspection` with
`change:{kind:"animation",patch:{state:"pause"}}` or `state:"play"` to pause or
resume molecular motion. Use `speed:0.5` to slow it, `loop:true` to repeat,
`seekSeconds` for an absolute clip time, or `restart:true,state:"play"` to play
from zero. Speed accepts 0.1–4. Read `get_inspection_state.animation` for the
owning panel's latest playback sample (null without animation), and confirm the
rendered command receipt. These controls leave chapter advancement alone;
pausing the tour also holds molecular motion.

Add `sessionId` to each call and use a render wait only where supported. Read
[Scene commands](references/commands.md) for compounds, focus, quality,
spatial context, tours, and growth. Start a tour when requested. Generic tours
illustrate concepts; use checked source identities for structure-specific claims.

`mode: "compare"` adds a second, undoable structure beside an already-saved
primary scene. It places the structures side-by-side; it does not superpose
them. A `mode: "replace"` request fetches and prepares the coordinates before
its optional render wait. After a source is committed, the host gives the panel
a size-aware render budget (up to five minutes); its optional render wait is
capped at 40 seconds per call. Only `sourceRenderStatus.rendered: true` confirms the selected panel
rendered and saved the replacement. If the result is still pending or timed
out, poll `get_inspection_state` until `sourceRenderReceipt` settles; report it
as shown only if it is rendered for the current source and ready panel. A
compare request returns a command receipt and command ID; poll that ID until
it settles, and report visible only for `status: "rendered"`. These receipts
are per operation and do not guarantee that every overlapping request will be
admitted: if the tool says the panel is busy, read current state before deciding
whether to retry.

## Measure atoms in the current scene

Use `measure` with the joined `sessionId` and 2–4 `targets`: `{part:"..."}`
selects the atom nearest a named part's CA or phosphorus centroid (all atoms
if neither exists), not its geometric center. Exact targets name residues as in
`update_inspection` plus `atomName` and must resolve one atom.
Read the full manifest with `get_inspection_state({sessionId,includeLesson:true})`
to check chapter visibility and animation events at the returned measurement
time before interpreting endpoints as visible bodies.
The result includes exact atom identities, distance in Å, an angle for three
targets, and a signed dihedral for four. Resolve field errors using the
returned candidates, including alternate sites, assembly copies and lesson-part
names; ambiguous selectors return at most eight candidates per end and a
`cursor` to repeat on the same target for the next page.
Reads leave the scene and revisions unchanged. Animated results identify
moving bodies and the latest panel time (or saved time without a panel sample);
they do not extrapolate playback.

For example, after `continue_session` returns `sessionId`, call
`measure({sessionId,targets:[{authorChain:"A",authorResidue:56,atomName:"CA"},
{authorChain:"A",authorResidue:169,atomName:"CA"}],annotate:true,
measurementId:"glu56-arg169",waitForRenderMs:10000})` using identities checked
against the actual source. Report `measurement.distanceAngstrom`. Only
`command.status:"rendered"` confirms the distance line was drawn and saved;
poll `get_inspection_state({sessionId,commandId})` for a pending receipt.
Remove it with `remove_measurement({sessionId,measurementId:"glu56-arg169",
waitForRenderMs:10000})` and check that receipt too. Omit `annotate` for a
numeric answer alone. A line follows its two endpoints during motion.

## Voice and shared assistants

Host dictation and live voice uses ordinary tools and that host's speech. For a
requested headset conversation, use Claude Code channels or the `listen_voice`
fallback for other hosts. Read [Voice and assistant handover](references/voice.md)
for launch, readiness and recovery. Both routes use the same loop: carry
`utteranceId` on supported actions, confirm the rendered receipt, then
`say_to_headset` with that ID. Preserve the configured voice provider.

`continue_session` shares selection, placement, lesson, chapter and emphasis.
Use `assistant:"Claude"` or `"Codex"` for the actual caller. Only the active
assistant owns voice; `switch_assistant` or the wearer's handover phrase changes
ownership. Quiet time leaves ownership unchanged. Installation alone starts no
conversation consumer.
