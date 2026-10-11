# Inspect a structure in Stereofold

Stereofold’s inspector is a focused Mol* workspace for appearance, placement,
and linked sequence selection. For measurements and other full-viewer work,
`open_detailed_view` serves the complete Mol* viewer from this Mac. Codex may
also offer a separate plugin, the Molecular Structure Viewer, for measurements,
multiple structures, density, trajectories, and exports. That plugin is
optional, and both can stay installed.

Ask Codex: “Inspect PDB 1CRN in Stereofold.” The installed plugin opens a
molecular workspace with a linked sequence. Select a residue, change its
appearance, or move the molecule and viewpoint with separate controls. Claude
Code shows no panel of its own, so there ask: “Inspect PDB 1CRN in Stereofold
and open its inspector in my Mac browser.” It calls `inspect`, then
`open_inspector`.

`stereo_structure.inspect` creates a new session from a structured `source`: a
PDB ID, an AlphaFold accession, an HTTPS coordinate URL, an absolute local
mmCIF path, or pasted coordinates. It also accepts the older `pdbId` and mmCIF
`structureText` fields, and `modelNumber` and `assemblyId` select a model and
an assembly explicitly. PDB-format input must declare each polymer sequence in
`SEQRES`; coordinate-only PDB text opens in the separate stereo viewer through
`stereo_structure.open`. `stereo_structure.inspect_file` opens an explicitly
chosen local absolute `.cif` or `.mmcif` file through the same inspector
resource, without copying its coordinates through the conversation. Supply only
the returned `sessionId` to reopen that session.
Without `modelNumber` or `assemblyId`, the inspector starts with the first
source model in the asymmetric unit.
Its scientific identities retain author/label numbering and missing positions.

Stereofold exposes thirty-seven model-visible tools, among them `inspect`,
`inspect_file`, `inspect_scene`, `inspect_lesson`, `inspect_experience`,
`list_experiences`, `navigate_experience`, `grow_structure`, `manage_companion`,
`open_companion`, `open_inspector`, `control_tour`, `get_inspection_state`, `get_readiness`,
`update_inspection`, `emphasize`, `focus_selection`, `replace_inspection_source`,
`open_detailed_view`, `import_detailed_view`, `recall_headset`, `say_to_headset`,
`speak_to_headset`, `listen_voice`, `open`, `control`, `get_state`, `set_mode`,
and `set_motion`. See [README.md](README.md) for the canonical list, and
[QUICKSTART.md](QUICKSTART.md) for the shortest route through them.

The Appearance tab controls representation, color, opacity, selected-residue
labels, and background. View controls orbit, zoom, cutaway, and fog. Move
controls molecular position, rotation, and scale without changing source
coordinates. Search accepts names, numbers, or ranges such as `8–16`; Enter
selects the matching sequence positions.

For a short desktop clip, choose **More → Capture preview · 10 s**. Start after
the view has finished loading or changing; a scene change that makes it unready
ends the preview. The download is a silent WebM of the molecular canvas only,
not the headset, room or conversation. Check playback before sharing.

## Guided tours

Open **Tours** in the inspector sidebar, then use **Choose a lesson**. The ten tours each
contain twenty scenes. Choose **Start lesson**, then use **Next** and **Back** at
your own pace, or choose **Play** for automatic progression and **Pause** to
linger. **Lesson options → Choose lesson** returns to the lesson choices. The
same controls are included in the desktop inspector and its browser companion.

While a tour is selected, the sidebar holds its lesson and playback controls.
**Explore controls** brings back the normal Appearance, View, and Move tools. The
molecule and linked sequence remain available during the tour.

The library includes Fold Detective, The Chemical Color Studio, Surface
Safari, The Structure Evidence Room, Claude Science: The Binder Map, The
Generator Gallery, Sequence Meets Shape, The Prediction Courtroom, The Ranking
Arcade, and Controls to Clear Communication. **Pace** adjusts autoplay reading
time; **Restart** replays the first scene and **Restore start** returns to the view captured when that tour began. Hidden
tabs and incoming shared or agent changes pause playback. Tour controls are
for desktop and browser panels. The immersive toolbar also exposes tour choice,
Play/Pause, Back, Next, and educational scene text. XR scene changes preserve
the viewer’s head pose; desktop fit/focus/orbit/dolly camera recipes are skipped
while immersive, while appearance, selection, and molecule placement still apply.
In VR, **Tours**, under **Menu**, pauses and opens the chooser; **Next one**
cycles lessons, and **Tour** begins the selected one. **More text** pages through full
captions manually. In XR, autoplay advances through every caption page before
continuing to the next molecular scene. After the final dwell it restores the
starting view and resting controls, and speaks one ending line. An authored
`presentation.end: "hold"` keeps the final scene until **Done**; **Done** also
ends a tour early. Each page has at least three seconds of reading time.

Tours illustrate their lessons with the structure currently open. They change
the real molecular view; the rendered view saves through the usual session
mechanism. They do not load a different target, run design tools, or calculate
binding scores. Molecular colors and camera angles are presentation choices,
not evidence of a binding site or prediction confidence.

The Claude Science lessons cover the published Anthropic binder workflow and
the decisions involved in adapting it: backbone generation, sequence design,
prediction arms, filtering, ranking, controls, and the move to laboratory
testing.
Read each lesson's sources for the underlying protocol. A tour through these
concepts does not reproduce the published experimental workflow.

New structures rotate slowly around their own center. **Pause rotation** keeps
the orientation you see; touching the molecule or changing a scene control
also pauses it. Use **Rotate structure** to resume. The camera stays still,
and reduced-motion preferences keep automatic rotation off. Running rotation
does not continuously save changes; pausing retains that orientation once.
Typed changes pause rotation and use the last saved scene as their starting point.

The panel follows Codex’s light or dark theme, including theme changes while
it is open. Without a host preference, it follows the operating system. The
molecule’s background is a separate appearance setting and stays as you chose it.

Opening a session does not confirm that the structure rendered. Codex checks
`get_inspection_state` for a saved scene and a current, ready panel before
reporting the structure as visible. A failed initial load shows the server’s
error and **Retry loading**. Scene controls stay disabled until loading succeeds.
If the host reports “thread not found,” open Stereofold in a new Codex task.
If the session expired, ask Codex to inspect the structure again.

The current rendered view saves to the server session after changes settle.
Reopening restores appearance, placement, selected identities, and the complete
camera. Undo and named saved views belong to the current tab. Sessions expire
after 30 minutes of inactivity, eviction from the bounded cache, or server
restart. A session connected with `open_companion` stays open while an agent
waits in `listen_voice`, so a wearer can take the headset off for longer than
30 minutes. Wait for “Current view saved to this session” before closing a
panel.

When another clean panel changes a shared companion session, it follows the
saved rendered scene. A panel with unsaved work keeps that visible work and
shows its stale-save notice instead. Load saved view explicitly replaces local
work with the retained view. Retry save retries a failed request; it cannot
override newer work. This is optimistic persistence after rendering.

## Ask the host agent to change the open view

With the inspector open, ask for changes such as:

- “Make the molecule pink and 50% transparent on a dark blue background.”
- “Label the selected residues and make their highlights yellow.”
- “Show a surface with a 20% cutaway and some depth fog.”
- “Turn the molecule 45 degrees around Y and move it slightly to the left.”

The assistant sends one appearance, visibility, placement, or selection change
with `update_inspection`, and names regions with residue selectors such as a
chain, a component code, a class such as ligand or water, or an author residue
range, rather than with keys. On `update_inspection`, `focus_selection`, `emphasize`,
`undo_last_change` and `replace_inspection_source`, the binding fields
(`serverEpoch`, `sourceToken`, the two base revisions, `panelId` and
`commandId`) are optional: left out, the server fills in the current values and
the attached panel. Supply them when an edit made against a stale view must be
refused. Read `get_inspection_state` when you need facts about the scene; its
bounded `residues` page lists canonical identities. A selection replaces the
previous one, and an empty key list clears it. A selection
command preserves appearance, placement, and viewpoint, while appearance and
placement preserve selection. Each panel shows a short ID in its header. If
several panels are open, identify the intended one. Rows marked `unresolved`
can be selected in sequence but have no 3D highlight; do not infer coordinates
for them.

The command first reports **queued**. Codex checks its receipt before saying
the change is visible. **Rendered** means the targeted panel produced a frame
and the server saved that scene at the receipt's revision. Later manual edits
may advance the saved revision. A closed panel cannot receive a command; a new
panel never replays the old panel's work.

Manual edits can win while a command is in flight. A conflicting command
preserves the newer saved scene. If a change draws but its receipt is lost,
the panel offers **Retry confirmation** without applying the change again.
An **unconfirmed** command may have drawn without saving; it is not evidence
of a completed change. Load saved view explicitly resolves visible unsaved work.

Legacy `control`, `set_mode`, and `set_motion` commands affect the separate
stereo viewer. Native-app voice and host dictation both produce the same agent
tool commands. In a paired HTTPS companion, holding **A** or **X** captures a
short microphone press after browser permission and sends it to local Apple or
Whisper transcription on the Mac; it does not save recordings. The in-headset
**Talk** row uses a separate route whose helper sends the captured audio to
OpenAI Realtime; a ready local transcriber does not make that route ready.
Unknown spoken requests are delivered
once as bounded text to the current desktop host. Reply audio is scoped to the
intended current headset panel.

Setting `STEREOFOLD_PTT_TRANSCRIBE=1` is recommended to make transcription explicit.
Unset, the runtime auto-detects a local transcriber: an Apple helper with `ffmpeg` or a complete Whisper route enables transcription, and readiness reports the
local recognizer resolved (Apple still needs Speech Recognition consent).
With none detected, voice stays off and readiness names the missing prerequisites;
no headset speech is transcribed. With `=1` and no transcriber, readiness
instead reports the missing prerequisites. `0` explicitly turns transcription
off. Recording still requires a held talk control and microphone permission.
Set these values in the MCP server environment and restart the host after changes.
Keep an already configured spoken-reply provider. On a Mac without an OAuth narration helper, set `STEREOFOLD_REPLY_VOICE_PROVIDER=system`; it uses local `say` and
`ffmpeg`. Do not change a working OAuth setup during transcription setup or silently switch providers after a failed reply. The runtime's unset reply provider is OAuth, whose narration
helper Stereofold does not ship; without it, replies are captions with no sound.

`open_companion` opens the same saved inspection in a browser companion.
Choose **More → Open on headset** in the header. **Open on Quest** opens Meta
Web Launch on this Mac; **Show address and code** opens manual pairing. Both use
`connection: "lan"`: private HTTPS on this Mac's Wi-Fi address with a one-time
pairing code. The manual pairing dialog shows the address, certificate
fingerprint, expiry, paired devices and a
**Stop sharing** control. Open that address in Quest Browser, accept the
certificate warning, pair, and tap the primary **Enter VR** control for
passthrough-first entry, or open **More options** for **Enter plain VR**, the
opaque room. The first tap also asks for the microphone. Keep Codex running.
The default `connection: "loopback"` stays on this Mac, and
`connection: "https"` is an explicit Cloudflare relay, never a LAN fallback.
Before describing the connection as ready, confirm that the headset entered XR
and shows the command outcome. Each hidden panel pauses its own polling and
catches up when visible again. Raw room poses stay in the renderer; they are
never written into the shared camera or returned to the desktop scene.

Inside XR, the spatial toolbar's compact rows are `Talk`, `Tour`, `Reset`, the
room row (`Room`, `Room on`, `Room off`, `No room` or `Room?`), `Mol*`, `Menu`
and `Move`. The `Talk` row also reports voice state: `Mic on…` while
recording, `Hearing…` while transcribing, `Reply…` while a reply plays,
`No voice` after a failure, and `No link` when the link to the Mac is lost.
**Menu** opens the full grid:
molecule movement and rotation on all three axes, scale, Fit, reset,
rotation/pause, cartoon, surface and atom styles, chain/element colors, opacity,
render quality and **Tours**. **Close** collapses it again, and **Move** re-seats the menu.
The toolbar stays anchored beside the entry viewpoint, independently of the
molecule. Walk or turn your head to change your viewpoint; use the toolbar to
change the molecule. Host commands can also change labels, background, surface,
highlight colors and cutaways. The command outcome appears in the 3D scene.
Controller, hand, or transient-pointer target rays use the same interaction
contract; device-specific usability varies by hardware.

Command feedback is a separate, noninteractive line above the controls and
does not shift their hit targets. With a depth cutaway, the toolbar fits within
the molecular clipping band while retaining its angular size. The scientific
near and far planes are preserved. Extreme cutaways combined with walking away
from the entry viewpoint can still clip this fixed spatial panel; this case
needs a separate presentation layer before claiming unrestricted controls.

When an immersive panel reports `spatialContext`, it is a transient snapshot in
centered `molecule-local` axes and molecular-radius units. It includes head
position, viewing direction, server-receipt age, and staleness. Agents use it
only for a `current`, ready panel with `stale: false`, then read current state
again before a contextual command. It does not identify anatomical front/back,
provide continuous gaze or eye tracking, expose room/world coordinates, or
change the saved scene or shared camera. The companion clears it explicitly
with `null` after XR ends.

## Packaging and data

The inspector uses stock Mol* to display structures with linked sequence
selection, appearance controls, and saved camera views. Its fonts, styles, and
viewer scripts are included in the share.

`inspect` returns session identity and revision counters. App-only
`get_inspection` returns coordinates, catalog, and retained scene exclusively in
`_meta['stereo_structure/inspection']`. With `transport: "chunked"` it returns
`{sha256, bytes}` descriptors for the coordinates and the compressed catalog
instead, and the panel assembles them through app-only
`get_inspection_bytes`, at most 96 KiB a call, verifying the declared length and
digest. That is how a desktop panel avoids depending on what a host bridge
carries in one tool result; the headset keeps its raw LAN source route. App-only `sync_inspection` validates a
complete scene and compares server epoch, source token, legacy state revision,
and inspection revision before saving. A successful source replacement gets a
fresh source token; a failed fetch retains the inspection. Undo history and
named bookmarks are excluded from the retained snapshot.

Compact public inspection state includes appearance, placement,
selected-residue count, live panel IDs, bounded command receipts, and any
transient per-panel spatial snapshot described above. It includes the saved
camera pose as `view.cameraPose` and excludes coordinates and canonical
selection keys. An explicit bounded `residues` query
adds only canonical identity rows for the saved model; it still excludes atom
sites and coordinate values. App-only `attach_inspection`, `poll_inspection`,
`complete_inspection`, and `detach_inspection` bind delivery and completion to
one server-issued panel capability. Completion validates the requested patch,
unchanged identity/selection/viewpoint pose, source token, server epoch, and both
revision counters. Mol* computes camera bounds for changed geometry and depth.

Each source attachment accepts one outstanding command, eight live panels, and
32 retained receipts. The one-pending-render reservation and clean-panel
auto-follow apply only after a companion is opened. A command waits up to 15
seconds for its panel, then up to 120 seconds for rendering and confirmation.
Missing heartbeats retire an idle panel after ten seconds. Its exact active
rendering claim preserves that panel only within the 120-second deadline;
successful completion grants one normal heartbeat interval to resume polling.
Expired claims are never replayed. Same-revision failed
receipts are retained to prevent reuse; after 32 failures at one revision, make
a deliberate manual edit or open a new session before issuing another command.
Source replacement resets panel capabilities and receipts, even for identical
coordinate bytes. A missing/evicted receipt reports unknown, never rendered.
Only one expected scene is retained for an outstanding command; terminal
receipts discard it. This mailbox does not implement the distributed Quest lease.
Target the intended panel surface (`desktop` or `companion`) and wait for a
`rendered` receipt before describing a tool change as visible.

One source download or local file read is capped at 64 MiB. Coordinates and
the compressed catalog travel on their own transports: a desktop panel reads
them in chunks of at most 96 KiB, and the headset reads its primary coordinates
from its LAN source route. A comparison structure takes the chunk route on both
surfaces: the hydration and each heartbeat carry only its `{sha256,bytes}`
descriptors. What one hydration response carries inline (the saved scene, a
scene import, a custom tour and those descriptors) is capped at 8 MiB, and one
saved scene at 2 MiB. The headset waits for its coordinate fetch 30 seconds plus
one second per MiB declared, up to 94 seconds. No count of
residue positions or atom sites refuses a catalog. The only measured ceiling
in this repo is the paired Quest 2 at 43,066 atom sites; everything else above
is this plugin's own policy, not a promise that every maximum-sized structure renders comfortably
on every device.

The integration follows the [MCP server and resource contract](https://developers.openai.com/apps-sdk/build/mcp-server)
and [MCP Apps UI bridge](https://developers.openai.com/apps-sdk/build/chatgpt-ui).
Five tools carry the inspector resource URI: `inspect`, `inspect_file`,
`inspect_scene`, `inspect_lesson`, and `inspect_experience`. State, commands, hydration,
and saves are data calls, so changing the current scene does not open another card.

## Verify the package

From the installed plugin directory, check the shipped server:

```sh
node skills/stereofold-setup/scripts/open-check.mjs
```

`OPEN PASS` confirms that the server starts and opens its built-in stereo
fixture. To check the inspector in your host, ask to inspect a public PDB
entry or a local mmCIF, then wait for a ready panel and a saved scene in
`get_inspection_state`. In Claude Code, call `open_inspector` to render the
panel in the local browser first; for a headset, `open_companion` renders it
itself when no scene is saved. The command-line check alone does not prove
that the host or headset rendered the inspector.

Follow [the Codex installation instructions](codex/INSTALL.md) to install.
A fresh Codex task may be needed to discover an installed plugin's new tools.


## Native Structure Viewer snapshots

`inspect_scene` reads native scene JSON and mmCIF artifacts with their export sidecars
without an authored pairing file. Native input defaults to a non-opening
compatibility check; the app displays that report even when the host mounts
the inspector resource. Choose matching scene only when compatible, or
explicitly choose structure-only.

Native matching currently requires an **empty selection**. Structure Viewer's
canonical selection IDs encode an object, instance and element, rather than exported atom-site IDs,
and the public export does not accept a proven mapping. Nonempty and truncated
selections refuse matching before opening; they are never silently dropped.
The separate legacy declared-source adapter can still resolve raw source atom
IDs to whole residues. Native matching also requires identity object
matrices: upstream exports already bake transforms into coordinates. A
structure-only view retains those coordinates; it does not apply placement
twice. Legacy raw-coordinate matrix conversion remains supported.

Atom-site-only coordinates retain observed residues and exact source bytes;
they do not fabricate missing sequence residues or assembly definitions.
Native atom IDs must have canonical signed 32-bit integer spelling and model
numbers must fit positive signed 32-bit integers. Unsupported identities fail
before either opening choice. Local sidecar consistency remains declared-local
metadata, not authenticated live synchronization.
