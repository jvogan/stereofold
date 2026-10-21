# Stereofold

![Stereofold molecular depth icon](assets/icon-256.png)

Stereofold packages two focused Mol* views in one stdio MCP plugin. Use the
molecular inspector for sequence selection, colors, labels, transparency, depth
cutaways, slow object rotation, and independent molecule and viewpoint movement.
Use the stereo viewer for parallel, cross, anaglyph, and automatic motion.
`open_detailed_view` serves the complete Mol* viewer from the host computer for
measurements and other full-viewer work. Codex may also offer a separate plugin,
the Molecular Structure Viewer, for measurements, multiple structures, density,
trajectories, and exports; Stereofold does not require it.

The immersive companion uses HTTPS and negotiated WebXR capabilities. Meta
Quest and Apple Vision Pro have named link handoffs; another headset browser
can pair the same private address through `open_companion` with
`connection: "lan"`, `headset: "auto"`, `launch: "none"`. The agent checks the
browser's session modes, inputs, and permissions, then uses the available
features. The microtubule demo applies its measured size limit to Quest 2;
other headset classes can try larger stages.

The headset route has been exercised on a Quest 2 and in the visionOS 27
simulator. Physical Vision Pro and other headsets remain available to test
through their browser's WebXR capabilities. Native scene import accepts a
checked snapshot of one structure; see [supported transfers](INSPECTOR.md).
For the microtubule demo, use the coordinate stages during a live session.
Its prepared density-map transition is experimental and can stall scene updates.

For presentations in the **standard Molecular Structure Viewer**, use the
bundled [molecular-presentation skill](skills/molecular-presentation/SKILL.md).

The [PDB 9AX6 illustration lesson](skills/molecular-presentation/assets/9ax6-daraxonrasib.json)
has two authored immersive scenes: a daraxonrasib complex overview and an
atom-contact closeup. It adds protein cartoons, translucent envelopes, ligand
sticks, anchored labels, contact dots and measured dashed 3D contacts. Use
biological assembly 1 and the exact deposited mmCIF file named by its digest.
It is listed as the named `daraxonrasib` demo in `demos/index.json`; ask to open
that bundled demo, or use `demos/daraxonrasib.json` with `inspect_lesson` and
`assemblyId: "1"`. Plain PDB inspection offers generic tours instead.
Next/Back switches scenes; moving the molecule carries the complete illustration.
These layers belong to the lesson and are preserved in named inspection views.
The native workspace snapshot importer does not import this lesson graph.
Edit the lesson to change individual figure layers
or labels. Its separately authored native desktop intentions require binding
the logical object and atom IDs to the opened source, then validating them in
the native Molecular Structure Viewer.
That entire skill folder is independently portable: it includes a local lesson
planner and examples, and does not require the Stereofold server for desktop
scene lessons or native movie plans. Headset playback uses this plugin's
immersive companion. The planner validates the lesson; the destination viewer
reports which scenes it rendered.

Start at [QUICKSTART.md](QUICKSTART.md): open a structure, put it on a
headset, change its appearance and selection, and switch structures in the same
session. Voice and guided lessons are optional. On a machine
where Stereofold has never run, an agent follows the bundled
[stereofold-setup skill](skills/stereofold-setup/SKILL.md) instead, from
discovery through registering this host to an opened structure. Installation
detail is in [codex/INSTALL.md](codex/INSTALL.md). The
`skills/stereo-structure/SKILL.md` file is bundled host guidance; it is not a
standalone server or Quest viewer.

In a Codex profile with Stereofold installed, ask: **“Inspect PDB 1CRN in
Stereofold.”** The agent calls `stereo_structure.inspect`; the workspace opens
inside the host as an MCP Apps `ui://` resource. The plugin descriptor,
`.codex-plugin/plugin.json`, names Codex and compatible MCP Apps hosts and no
minimum Codex version. The inspector panel is an MCP Apps `ui://` resource, so
it needs a host that renders one: the Codex desktop app is the intended host,
with a browser fallback when the embedded card is unavailable. The
CLI commands below install the plugin. The desktop inspector needs no headset or
separate web server. Reopening the returned session restores the saved current
view. See [inspection use and limits](INSPECTOR.md).

Claude Code shows no panel of its own. There, ask: **“Inspect PDB 1CRN in
Stereofold and open its inspector in my Mac browser.”** The agent calls
`inspect`, then `open_inspector` with the returned `sessionId`, and the
inspector opens in this Mac's default browser.

The inspector also bundles ten tours of twenty scenes each. Open **Tours** for
manual Next/Back navigation or Autoplay/Pause. Lessons use
the current molecule, including Claude Science binder-workflow topics, and
ship inside the inspector bundle for both desktop and browser companion use.
See [guided tours](INSPECTOR.md#guided-tours).

The forty-one model-visible tools are listed in full under **Install and
check the tools** below, all under `stereo_structure`. `inspect`,
`inspect_file`, `inspect_scene`, `inspect_lesson`, and `inspect_experience` use `ui://stereo-structure/inspector`; `open` uses
`ui://stereo-structure/viewer`. `inspect_file` accepts an explicitly chosen
absolute local mmCIF file and does not copy coordinates into the conversation.
`inspect_scene` accepts bounded absolute local paths for a Structure Viewer
`scene-json` and `selection-mmcif`, automatically checking their native export
sidecars. Supply `nativeExports` with the upstream revision and explicit
all-object export selection; no authored pairing file is required. It defaults
to a non-opening compatibility check. Choose `mode: "matching-scene"` for
the supported one-object snapshot subset, or explicitly choose
`mode: "structure-only"` to open coordinates without the scene. Follow the
export sequence in the [structure skill](skills/stereo-structure/SKILL.md).
It labels provenance
`declared-local`; it is not live synchronization or an authenticated export
receipt. A scene outside that subset is refused and nothing of it is applied.
A fault the scene JSON shows on its own is refused by the tool call before a
session opens: the result begins "Matching scene is unsupported:", lists the
unsupported features, names `inspect_file` as the structure-only alternative
and ends "No inspection session was opened." A fault that needs the parsed
structure is refused after the panel has loaded the coordinates: the panel
shows the parsed compatibility refusal reason with
a **Retry loading** button, and the coordinates stay on screen without the
scene. `inspect_file` is the coordinate-only
alternative for the same file. `inspect_lesson` accepts a local mmCIF and bounded lesson JSON, with an
optional exact `provenance.sourceSha256`.
Read inspection state and send an appearance, placement, or exact selection
patch to change an already-open rich panel. A bounded `residues` query returns
canonical identities for the saved model; use only those keys for selection.
Its command receipt confirms the rendered revision.
`open_detailed_view` serves the complete Mol* viewer application from this Mac
on loopback with the panel's structure and saved scene already applied, and
returns the address as text. It carries the coordinates, model, assembly,
representation, color theme, opacity, background, camera, the residue selection
and its labels; placement, tour and immersive state stay in the panel. The
page opens with the camera fitted to the structure rather than on the panel's
pose, and draws a `molecular-surface` or `spacefill` scene as `cartoon`; the
full control tree builds either in one click. The
detailed page's own **Apply changes, then back to headset** press posts its
appearance, residue selection and camera straight back over the page key, so
no file is needed. `import_detailed_view` is the file route for a page whose
press did not finish: this Mac unreachable or refusing the post, or a panel
still rendering, still waiting to apply another part of the returned changes,
or holding unsaved local work when the page's loop of 18 posts ran out. It
reads a `.molj` state file saved there with **Download State** and queues what
the panel can render. A panel renders one
command at a time, so the appearance comes back first and the camera pose on a
second call with the same file; the result says when the framing is still to
come. Neither tool needs the separate Molecular Structure Viewer plugin, a
public tunnel, or molstar.org.

The remaining controls affect the stereo view. The identifiers of the original
stereo route remain unchanged.

For the round trip from any host onto a Quest and back, with no typing on
the headset, voice, and the jump to the full Mol* viewer, see
[QUICKSTART.md](QUICKSTART.md). Stereofold has been run on a Quest 2 in Quest
Browser. Quest 3, Quest 3S and Quest Pro run the same page from the same
**Enter VR** button, but this release has not been run on them.

Use **Open on Quest** (under **More** in the inspector header) after saving the
intended view. Choose
**Connect over Wi-Fi** for private LAN HTTPS, or choose **Send using Meta** only
when an explicit public relay is acceptable. For Wi-Fi, open the shown address
in Quest Browser, accept its development certificate for that exact address,
and enter the one-time pairing code. Then tap the primary **Enter VR** control:
it requests `immersive-ar` wherever the headset browser reports it, so the room
stays behind the molecule, and falls back to `immersive-vr` where it does not.
The first tap also asks for the microphone, because Quest cannot show that
prompt inside VR. **Enter plain VR**, under **More options**, opens the opaque
room. Keep Codex running. No headset developer registration, USB debugging,
tunnel, or certificate-authority installation is required for the private
route. If the headset shows Meta's "Finding position in room" screen, a person
must clear it first: Quest Browser does not open a page behind it.

For agents, `open_companion` with `connection: "lan"` returns the private URL,
pairing code, certificate fingerprint and expiry. Add `launch: "web"` and the
server also opens Meta's Web Launch page in the Mac's default browser, so the
wearer clicks **Open** once and types nothing; the tool result states in words
whether a browser opened. `launch: "adb"` fires a `VIEW` intent over a connected
authorized debugging cable, and `launch` is refused unless `connection` is
`lan`. `manage_companion` with `action: "launch"` repeats the launch for a
companion that is already open. `STEREOFOLD_OPENER` replaces the absolute
`/usr/bin/open` this uses. `manage_companion` lists and
revokes paired devices or stops sharing.

A Wi-Fi pairing code expires after ten minutes. Sharing expires thirty minutes after the last authorized request, and
no later than eight hours after it opened; `STEREOFOLD_SHARE_MAX_HOURS` sets a
different ceiling, from 0.5 through 24. Calling `open_companion` again while the
share is open keeps its paired devices and its ceiling, unless the call puts a
different structure capability behind the address, which revokes them. The
address stays stable while the Mac's LAN IP and chosen port stay the same.

A Mac Chrome renderer tab the host opened closes with its host: it closes
itself after three missed heartbeats, the host closes matching tabs on
shutdown, and a new start sweeps the dead ones. Companion pages never close.
Default `loopback` stays on the desktop host. `connection: "https"` is the
explicit Meta/Cloudflare relay route and is never an automatic fallback. Both
transport choices connect the same saved Stereofold inspection. Target the
registered companion panel for commands and wait for its `rendered` receipt. A
clean shared panel follows saved changes, while a panel with unsaved local work
preserves it. The compare-and-save reservation permits one pending render only
after a companion is opened. Each hidden panel pauses its own polling and
catches up when visible. Confirm XR entry and controls on the intended
headset before describing the connection as ready.

An immersive panel can expose a transient `spatialContext` for the
agent: centered `molecule-local` axes, molecular-radius units, server-receipt
age, and staleness. Use it only from a current, ready panel with `stale: false`
and read state again before a contextual command. It has no anatomical
front/back or continuous gaze meaning, contains no room/world coordinates, is
cleared explicitly after XR ends, and never changes the shared camera or saved
scene.

Host dictation and native-app voice both result in the same agent tool commands.
In a paired HTTPS companion, a wearer holds **A** or **X** for controller
push-to-talk; the grips grab and scale the molecule. That capture is transcribed
on this Mac by Apple Speech or Whisper and is not saved in Stereofold. The
in-headset **Talk** row uses a separate transcription route: its helper, which
this plugin does not ship, sends the captured audio to OpenAI Realtime, and a
ready local transcriber does not make that route ready. Check `websockets` in
the exact selected Python interpreter as described in
[voice setup](skills/stereofold-setup/references/voice.md). Speech from **A** or
**X** reaches the assistant while it waits in `listen_voice`. Known commands
remain source- and panel-bound; broader
spoken requests go once to the current desktop host as user text. Short
configured voice replies are played only in the intended current headset panel.
The default `oauth` reply provider passes the reply text to the external OAuth
narration helper; `system` speaks it on this Mac with macOS `say`. An exact
live-scene export bridge
from the full Molecular Structure Viewer remains unavailable; the narrow local
snapshot path is documented in the
[inspector's current controls and limits](INSPECTOR.md).

## Voice on a Mac

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
See [QUICKSTART.md](QUICKSTART.md) for setup and the required readiness and consent checks.

Push-to-talk audio is transcribed on this Mac. On macOS the recognizer is
Apple's on-device Speech framework, reached through a small Swift command
built from `native/applespeech/transcribe.swift`. Run the build in
the installed plugin directory, on macOS only:

```sh
sh native/applespeech/build.sh
```

It needs the Xcode command line tools and produces
`native/applespeech/bin/applespeech`, the first path the host looks for. On
any other operating system the script prints "applespeech builds only on
macOS. Use whisper on this host; see README.md in the plugin directory." to
stderr and exits with status 1, and that host transcribes with whisper. On a
Mac without `xcrun` it prints "xcrun was not found. Install the Xcode command
line tools with: xcode-select --install" and exits with status 1. No
whisper model is downloaded. The step is deliberately outside the package
build, because Swift compiles only on macOS, and a share never carries the
binary: a Mach-O built on one Mac is the wrong file for another. ffmpeg is still required either
way: Quest Browser records WebM/Opus, which AVFoundation does not open, so
every clip is decoded to 16 kHz PCM first.

Apple's recognizer asks for consent once, through a macOS Speech Recognition
dialog raised against the application that started the host. The grant belongs
to that app, so granting one app grants nothing to another. A host under
launchd has no window to show it in, which is why a press the recognizer
refuses is transcribed by whisper instead, with the reason recorded on the
transcript. A Mac with no whisper install loses that press instead, so click
the dialog before the headset goes on.

Whisper is the route everywhere else: `whisper-cli` and a `ggml-base.en.bin`
model, or a readable model selected by `STEREOFOLD_WHISPER_MODEL`. The startup line names the route in use. These variables configure
transcription and transcript delivery:

| Variable | What it sets |
| --- | --- |
| `STEREOFOLD_PTT_TRANSCRIBE` | Setting `STEREOFOLD_PTT_TRANSCRIBE=1` is recommended to make transcription explicit. Unset, the runtime auto-detects a local transcriber: an Apple helper with `ffmpeg` or a complete Whisper route enables transcription, and readiness reports the local recognizer resolved (Apple still needs Speech Recognition consent). `0` explicitly turns transcription off. |
| `STEREOFOLD_PTT_TRANSCRIBER` | `apple` or `whisper`. Unset picks Apple on a Mac that has the tool built, whisper otherwise. |
| `STEREOFOLD_APPLESPEECH_BIN` | An absolute path to `applespeech`, for a binary kept outside the package. |
| `STEREOFOLD_WHISPER_BIN` | An absolute path to `whisper-cli`, including as the fallback for Apple. |
| `STEREOFOLD_WHISPER_MODEL` | An absolute path to the whisper model, including as the fallback for Apple. |
| `STEREOFOLD_WHISPER_GPU` | `1` runs whisper on the GPU. Unset, it runs on the CPU: a little slower, and it keeps transcription out of the GPU driver, which crashed under heavy Metal load. |
| `STEREOFOLD_FFMPEG_BIN` | An absolute path to `ffmpeg`, which decodes audio before either recognizer runs. |
| `STEREOFOLD_PTT_SILENCE_RMS` | The loudest-100 ms threshold below which a press counts as silence and no recognizer runs. Default `0.012`; `0` disables it. |
| `STEREOFOLD_PTT_TRANSCRIPTS` | An absolute file path to append transcript records as JSON lines. |
| `STEREOFOLD_PTT_TEXT_COMMAND` | A shell command run once per transcript, with the text on standard input. |
| `STEREOFOLD_BRIDGE_DIR` | An absolute directory path for transcript delivery to a running headset bridge. |

Spoken replies have their own provider setting. `replyVoiceProvider` in
`~/.stereofold/config.json` is `oauth` or `system`; the variable
`STEREOFOLD_REPLY_VOICE_PROVIDER` takes the same two values and overrides the
key for one process, and with neither set the provider is `oauth`. Preserve an
existing OAuth setup; use `system` for a recipient without the narration helper.
OAuth is optional and needs a narration helper that Stereofold does not
ship; without it OAuth replies stay silent. Every other setting is a key in `~/.stereofold/config.json` with a
variable that overrides it.
[skills/stereofold-setup/SKILL.md](skills/stereofold-setup/SKILL.md) carries
that table and the one that says which variable turns on which feature.

## Verify and open bundled lessons

From the installed plugin directory, run the shipped check on Node.js 22 or newer:

```sh
node skills/stereofold-setup/scripts/open-check.mjs
```

It starts `dist/server.mjs`, lists the tools, and opens the built-in depth
fixture without a network request. `OPEN PASS` verifies the server; it does
not establish that your host mounted a panel or that a headset rendered it.
The runtime also includes `dist/inspector-host.js`, `dist/viewer.html`,
`dist/inspector.html` and the stock full viewer assets in `dist/molstar/`.
Keep those files from the same share together.

Bundled lessons are listed in [demos/README.md](demos/README.md). Ask the
assistant to open one by name with its matching coordinates, following
[QUICKSTART.md](QUICKSTART.md). The staged `microtubule-growth` lesson changes
tiers through `stereo_structure.grow_structure`: `stage` takes `next`, `back`,
`first`, `last`, or a tier id, and `device` takes the paired headset class.
The `filament` density asset is not shipped and cannot be prepared in a live
session. Skip it by naming `tip` from `wall`. The `tube` tier exceeds the
Quest 2 size budget and is refused without changing the current structure.

## Network use

Public PDB loading makes an external Internet request: `stereo_structure.inspect` or `stereo_structure.open` with a `pdbId`, and `stereo_structure.control` with `action: "load_pdb"`, fetch `https://files.rcsb.org/download/<ID>.cif` from the server process. That reveals this machine's IP address and the requested public PDB ID to RCSB. An AlphaFold source fetches from `alphafold.ebi.ac.uk`, and a `url` source fetches from the HTTPS address you give. These tools therefore carry `openWorldHint: true` and say so in their descriptions. Direct file loading reads coordinates locally; sharing sends the selected scene to paired devices and uses a public relay only when requested. Coordinates pasted into chat or tool inputs follow your agent host’s data policies, as do screenshots or exports you provide to that host. Voice is separate: see the push-to-talk and reply routes above.

Under Claude Science, the model's own sandbox has no network access, separate from the outbound RCSB fetch the server process itself makes. `inspect_file`, `inspect_scene`, and `inspect_lesson` read local files directly through the MCP server process instead, which is why they take file paths rather than requiring coordinate text to be pasted into the conversation.

Opening a companion starts an authenticated HTTP listener on `127.0.0.1`.
**Open on Quest** adds HTTPS on one explicitly selected, assigned private IPv4
address (port 8443 by default). It serves bundled viewer assets; authenticated
source and tool requests reach only that saved inspection. Pairing requires a
short-lived, single-use code, and client credentials stay in the viewer URL
fragment. Codex's MCP and agent-control endpoints remain on the Mac. No
external CDN is needed for the viewer. The legacy Cloudflare route requires
explicit `connection: "https"`; it sends the chosen coordinates through that
relay and exposes them to holders of the complete capability URL.

## Stereo runtime contract

`stereo_structure.open` with a structure source creates an isolated session and
returns its opaque `sessionId`. Every later model or app tool call for that
viewer must include the same ID. To render or remount an existing session, call
`stereo_structure.open` with only `{ "sessionId": "…" }`; `open` carries the stereo viewer resource metadata. Full coordinate text is returned
for this view by the app-only `stereo_structure.get_structure` tool, inside its
component-private result `_meta['stereo_structure/structure']`; that tool's
public `structuredContent` remains concise. Model-visible tool results contain
concise state and the opaque session capability, never the coordinates.

Model-side `reset_camera` and `fit` controls are retained as one-shot session
actions. Subsequent `open` results advertise the same action identity until a
current panel hydrates the matching coordinates, leases the action with its
render token, applies it, and acknowledges completion. Only that matching
completion clears the action: a failed or stale panel leaves it available for
a newer render, while a completed action does not repeat. The viewer's own
Reset and Fit buttons act directly on the mounted panel.

## Viewer behavior

Mol* loads PDB IDs or pasted PDB/mmCIF text with the explicit polymer-cartoon and ligand-ball-and-stick preset. Orbit, pan, zoom, and picking remain Mol* canvas interactions.

Motion defaults to a slow rock, which is the one depth cue that works before an observer has fused anything. When the system requests reduced motion the viewer starts with no motion instead, says why in the motion hint, and reports that choice back to the server so `stereo_structure.get_state` matches what is on screen. `stereo_structure.set_motion` selects none, rock, spin, or mouse parallax. Rock and spin use the `@stereo/motion` defaults when their optional amplitude/period fields are omitted (±4° at 0.3 Hz; spin 6°/s); an explicit axis may be `y` or `x`.

Motion is applied to the parent Mol* camera immediately before the existing `StereoController` derives the live stereo values. Rock and spin alter only the parent pose; the controller continues to own `eyeSeparation` and `focus`, so both stereo eyes receive the same motion. Mouse parallax is source-agnostic behind a normalized-offset interface; this build provides only the zero-permission mouse source and uses an asymmetric parent frustum. The build-local StereoCamera patch retains that shared frustum skew before adding each eye's convergence skew. No webcam or `getUserMedia` code is included.

## Observer calibration

The 63 mm parallel cap and both predicted disparities are physical quantities, so the viewer exposes the two measurements they depend on. A CSS px/inch field takes a ruler measurement; leaving it empty falls back to a runtime probe, which reads 96 on a display that reports no real density, and the field is then labelled estimated. A viewing-distance field in millimetres defaults to 500 mm. The derived-numbers line under them shows the live baseline in Angstrom, the focus distance, and the predicted front and rear disparity in both CSS pixels and arcminutes.

A Load Depth Fixture button loads the bundled three-marker structure at 45, 65, and 85 Angstrom camera depth with the markers enlarged enough to judge by eye. `stereo_structure.open` accepts the same structure as `fixture: "three-depth-markers"`. The enlargement applies to that fixture only; real structures keep their normal representation. The fixture keeps normal lighting, sphere impostors, antialiasing, and fog.

Stereo is opt-in. `StereoController` samples the live Mol* target distance, field of view, visible bounding radius, and CSS viewport every animation frame. It derives a world-unit baseline and focus through the `@stereo/geometry` workspace package, using depth strength in arcminutes rather than a user-visible Ångström baseline. Parallel mode letterboxes the pair so one eye is no more than 63 mm wide at the runtime CSS-density measurement, and shows that one-eye width in millimetres. Cross mode swaps Mol*'s left/right viewport X slots.

Screen-space ambient occlusion is suppressed while parallel or cross mode is active. Mol* rotates the occlusion kernel by a noise indexed with the absolute framebuffer coordinate, so in a split-viewport pair the two eyes receive different occlusion for the same geometry. Mono and anaglyph keep it: the anaglyph fork renders both eyes full frame at the same viewport origin, so both eyes get the same noise phase.

Anaglyph mode uses the Mol* DrawPass fork included in this build. It renders each eye at full frame size through the complete Mol* rendering pipeline into an offscreen target. The `@stereo/anaglyph` renderer copies those images into its input textures, then composites them. This preserves antialiasing and temporal multisampling.

Two compositor variants are selectable, next to the glasses control and through `stereo_structure.set_mode`:

| `variant` | Label |
| --- | --- |
| `balanced` (default) | Balanced (matched eye brightness) |
| `dubois` | Dubois colour (unequal eye brightness) |

Balanced sends each filter only Rec.709 luma, scaled so both eyes emit the same luma. Dubois is the least-squares color projector: it keeps more hue and gives the two eyes measurably unequal brightness, so choose it when retaining colour matters more than matching brightness. The glasses control also selects green-magenta and amber-blue matrices for either variant, and `swapEyes` changes the compositor eye order.

While anaglyph is active, structure representations use the luminance-led element palette and the ground is exactly black. Black keeps the background equally dark through both filters. Normal colour themes and ground return when leaving the mode.

Mol*'s camera-axes gizmo draws at zero disparity in both eyes, so it is a fixed screen-plane reference. The depth fixture loads with it hidden and a Camera axes checkbox restores it; real structures keep it on.

Stereo appearance depends on your glasses, display, and ability to fuse the views.

## Install and check the tools

Stereofold installs from a marketplace in one of two layouts, and either one
needs only Node.js 22 or newer: the runtime bundles in `dist/` ship with the
plugin, so there is no build step. The GitHub repository is the marketplace
`stereofold`, and its plugin directory is `plugin`:

```sh
codex plugin marketplace add https://github.com/jvogan/stereofold
codex plugin add stereofold@stereofold
```

```sh
claude plugin marketplace add jvogan/stereofold
claude plugin install stereofold@stereofold
```

A share generated for another machine is the marketplace `stereofold-local`.
Its root holds `plugins/stereofold/`, a Codex descriptor at
`.agents/plugins/marketplace.json`, and a Claude Code descriptor at
`.claude-plugin/marketplace.json`. Replace `/absolute/path/to/stereofold-share`
with the share's actual location:

```sh
codex plugin marketplace add /absolute/path/to/stereofold-share
codex plugin add stereofold@stereofold-local
```

```sh
claude plugin marketplace add /absolute/path/to/stereofold-share
claude plugin install stereofold@stereofold-local
```

Claude Code mounts no inspector panel of its own. For a headset session, call
`inspect`, then `open_companion` with the returned `sessionId`,
`connection: "lan"`, `headset: "meta"` and `launch: "web"`. When no scene is
saved yet, `open_companion` renders the inspector in this Mac's browser, waits
for the scene to save, shares it and launches the headset, so no separate
`open_inspector` call is needed. To view the structure on the Mac only, call
`inspect`, then `open_inspector`. `continue_session` joins a scene another host
on this Mac already saved.

Codex-specific install notes are in [codex/INSTALL.md](codex/INSTALL.md).

For an isolation check, run the shipped check from the installed plugin root:

```sh
node skills/stereofold-setup/scripts/open-check.mjs
```

It starts the shipped server on bare `node`, prints the advertised tool count,
confirms `stereo_structure.open`, and opens the built-in fixture. Then open a
fresh host conversation and confirm the tools below are available under the
Stereofold server. These are the names the server registers, and every host
renames them, so read the paragraph below the list before matching what a host
shows you against it. The model can call forty-one of the sixty-eight
registered tools; the other twenty-seven are app-only:

```text
stereo_structure.capture_headset_view
stereo_structure.continue_session
stereo_structure.control
stereo_structure.control_tour
stereo_structure.emphasize
stereo_structure.focus_selection
stereo_structure.get_inspection_state
stereo_structure.get_readiness
stereo_structure.get_state
stereo_structure.grow_structure
stereo_structure.import_detailed_view
stereo_structure.inspect
stereo_structure.inspect_experience
stereo_structure.inspect_file
stereo_structure.inspect_lesson
stereo_structure.inspect_scene
stereo_structure.install_lesson
stereo_structure.list_experiences
stereo_structure.listen_voice
stereo_structure.manage_companion
stereo_structure.manage_inspection_view
stereo_structure.measure
stereo_structure.navigate_experience
stereo_structure.open
stereo_structure.open_companion
stereo_structure.open_detailed_view
stereo_structure.open_inspector
stereo_structure.prepare_composite
stereo_structure.read_headset_browser
stereo_structure.read_headset_log
stereo_structure.recall_headset
stereo_structure.redo_last_change
stereo_structure.remove_measurement
stereo_structure.replace_inspection_source
stereo_structure.say_to_headset
stereo_structure.set_mode
stereo_structure.set_motion
stereo_structure.speak_to_headset
stereo_structure.switch_assistant
stereo_structure.undo_last_change
stereo_structure.update_inspection
```

Codex and Claude Code 2.1.280 both read the `_meta.ui.visibility` hint and keep
the 27 app-only tools off the model's list. Both rename the tools. Codex
session logs record `mcp__stereo_structure__stereo_structure_<verb>`, so
`stereo_structure.open` is `mcp__stereo_structure__stereo_structure_open`
there. A Claude Code plugin install adds the plugin name:
`mcp__plugin_stereofold_stereo_structure__stereo_structure_open`. No host
prints the bare `mcp__stereo_structure__<verb>` form.

Use `say_to_headset` for conversational replies on every host.
`speak_to_headset` queues one short line for a specific bound headset panel and
needs a working reply provider, `oauth` or `system`; no host restriction
applies to it.

If another structure viewer is installed, use the Stereofold tool namespace
and its returned session ID to target this plugin. Use the other viewer's tools
for that viewer's scene.
