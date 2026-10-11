---
name: stereo-structure
description: Inspect molecular structures, control Stereofold scenes in WebXR headset browsers, and use side-by-side or anaglyph stereo viewing. Use for linked sequence selection, appearance, placement, tours, headset handoff, or continuing a shared Stereofold session.
---

# Stereofold

Use Stereofold for focused molecular inspection, stereo viewing, and immersive
scenes. Keep the user's chosen scientific workbench for measurements, maps,
trajectories, multiple structures, and other analysis. The separate Molecular
Structure Viewer has its own `structure.*` tools; Stereofold's bundled full
Mol* viewer is another route. Choose the route the user requested.

Tool names use the `stereo_structure.` namespace. Resolve their host-specific
names from the available tool list. For installation or missing runtime files,
read the installed `stereofold-setup` skill.

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
4. For a headset request, call `open_companion` directly after opening the
   source. It opens a browser renderer when needed and waits for a saved scene.
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
that revision with the current scene before describing it. If the result is
`queued` or `rendering`, read `get_inspection_state` with its `commandId` until
the receipt settles. `saved` retains an edit for a
paused page to draw later. `unconfirmed`, `conflict`, `rejected`, `unknown`,
and expired receipts do not establish a completed render.

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

| Request | Tool and action-specific arguments |
| --- | --- |
| Color chain A orange | `update_inspection`: `{"change":{"kind":"appearance","residues":{"labelChain":"A"},"patch":{"color":"uniform","uniformColor":"#ff8800"}}}` |
| Show hemes as sticks | `update_inspection`: `{"change":{"kind":"appearance","residues":{"componentId":"HEM"},"patch":{"representation":"ball-and-stick"}}}` |
| Hide water | `update_inspection`: `{"change":{"kind":"visibility","patch":{"op":"hide","classes":["water"]}}}` |
| Spin / stop spinning | `update_inspection`: `{"change":{"kind":"motion","patch":{"state":"spin"}}}` / `state: "stop"` |
| Bring an out-of-view molecule back | `update_inspection`: `{"change":{"kind":"placement","patch":{"recenter":true}}}` |
| Frame the selection | `focus_selection`: `{"framing":"context"}` |
| Replace with 1CRN in the same connection | `replace_inspection_source`: `{"mode":"replace","pdbId":"1CRN","waitForRenderMs":40000}` |
| Compare 2HHB beside the current structure | `replace_inspection_source`: `{"mode":"compare","source":{"kind":"pdb","id":"2HHB"},"commandId":"compare-2hhb"}` |
| Next / back / pause a requested tour | `control_tour`: `{"action":"next"}` / `back` / `pause` |
| Undo the last shared operation | `undo_last_change`: `{}` |
| Reapply the last undone operation | `redo_last_change`: `{}` |

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

## Voice and shared assistants

Typed, host-dictated, and host live-voice requests use this conversation's
ordinary tools. If live voice already reaches this task, use its speech and
turn-taking; do not start a second headset listener or duplicate spoken replies.
Headset microphone requests need a configured recognizer, microphone consent,
and an active conversation consumer. A plugin installation alone keeps no
assistant listening.
Read [Voice and assistant handover](references/voice.md) before starting that
route. Preserve the user's configured voice provider and verify playback
acknowledgements before claiming a spoken reply played.

`continue_session` shares selection, placement, lesson, chapter, and emphasis
across hosts. Its assistant label identifies the caller for voice ownership.
Only the active assistant receives wearer requests; `switch_assistant` or the
wearer's handover phrase changes ownership. Quiet time does not change it.
