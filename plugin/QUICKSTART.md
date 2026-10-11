# Stereofold quickstart

Install Stereofold, open a molecular structure, and change its scene through
your assistant or a WebXR headset browser. Meta Quest and Vision Pro have named
launch routes; other browsers use manual pairing. Voice and lessons are optional.
An installed plugin needs no build.

## Your first session

In a new conversation, type or dictate each request:

| Say this | What happens |
| --- | --- |
| "Inspect PDB 4HHB in Stereofold, then open it on my Quest." | Renders hemoglobin on the Mac, shares it over private Wi-Fi, and opens Meta's Web Launch page on the Mac. Follow section 3 on the headset. |
| "Color chain A red." | Changes the headset scene with one tool call. The assistant checks the rendered receipt before it says the change is visible. |
| "Show the hemes as sticks." | Draws the heme groups as ball-and-stick. |
| "Select chain A residues 10 through 15 and explain them." | Resolves the actual residues, highlights them, and answers about that region. |
| "Load 1CRN instead." | Replaces the coordinates through the existing connection, without opening a second session or asking you to pair again. |
| "Stop sharing." | Closes the share and disconnects its paired devices. |

Where the structure renders on the Mac depends on the host. An MCP Apps host can show an inspection card or panel when its connection
supports the resource. Verify that panel in your actual Codex or Claude Science
connection; browser and emulator checks do not establish an embedded card. Claude Code and the Codex CLI have no panel,
so the server opens the inspector in a browser tab on this Mac. Leave that tab
open, because it does the rendering.

An open request that succeeds does not mean the headset has drawn anything:
the assistant checks the saved scene, the paired headset and the render
receipt. For the first test, type in the host and use the headset controls.
Voice from the controller needs the setup in [Optional: voice](#optional-voice).

If you already have a molecule in Codex's standard **Molecular Structure
Viewer**, say **"Send this structure to my headset; check what can transfer
first."** The assistant exports the current object and checks its scene. A
compatible native snapshot preserves supported camera and appearance. It can
have one display layer, or the standard protein cartoon with a ligand layer,
and it carries hidden water, ligand and ion classes; Stereofold draws the
ligand sticks as ball and stick. Matching also requires an empty selection, no
object transform, no clipping that cuts the molecule, and no colors applied to
a selection. Otherwise the assistant explains the missing features and offers
**structure only**, which carries coordinates without the original camera,
styles or selection. This is a snapshot, so later changes in the standard
viewer require another transfer.

## 1. Install

Replace every `/absolute/path/to/...` example with the actual path on your
machine. The plugin directory is `plugin/` in a copy of the repository, or
`plugins/stereofold/` in an extracted share. Commands with plugin-relative
paths run inside that directory. In Claude Code, `claude mcp list` reports the
server path, and the plugin directory is the parent of `dist/`.

On a machine where Stereofold has never run, ask the agent to set it up. The
bundled [stereofold-setup skill](skills/stereofold-setup/SKILL.md) works
through discovery, installation, this host's registration, and an opened
structure. The rest of this section is the same work by hand.

### Use a source checkout

The repository's agent instructions point to the full setup, scene-control
and presentation skills. Register the committed server with your host's
additive MCP command or connector UI, using absolute Node and server paths.
Codex uses `codex mcp add stereo_structure -- <node> <server>`; Claude Code
uses `claude mcp add stereo_structure --scope user -- <node> <server>`.
Keep existing entries and avoid registering the same runtime through both MCP
and a plugin. Reload the host's connection or start a new conversation.

For another project, copy the needed complete skill folders into
`.agents/skills/` for Codex or `.claude/skills/` for Claude Code, or use your
configured personal skill directory. A copied setup check needs `--root`
pointing to the checkout's plugin directory. The source checkout contains the
full runtime; the portable lesson package contains only the lesson planner
and presentation skill.

### Claude Code

From GitHub:

```sh
claude plugin marketplace add jvogan/stereofold
claude plugin install stereofold@stereofold
```

From an extracted share, whose marketplace is named `stereofold-local`:

```sh
claude plugin marketplace add /absolute/path/to/stereofold-share
claude plugin install stereofold@stereofold-local
```

Start a new `claude` session afterwards. The plugin registers the shipped
`stereo_structure` server, loads the skills in `skills/`, and adds the
`stereofold-quest` skill for the headset.

### Codex CLI and the Codex app

The Codex CLI and app can use the same profile. Install with the profile the
app uses; an explicit `CODEX_HOME` selects another profile. From GitHub:

```sh
codex plugin marketplace add https://github.com/jvogan/stereofold
codex plugin add stereofold@stereofold
```

From an extracted share, check its checksums, then add the share folder as the
marketplace. Its marketplace is named `stereofold-local`:

```sh
cd /absolute/path/to/stereofold-share
shasum -a 256 -c SHA256SUMS
codex plugin marketplace add /absolute/path/to/stereofold-share
codex plugin add stereofold@stereofold-local
```

Start a new conversation afterwards. If the app still advertises old tools,
reload its plugin connection or reopen the app. Follow your host's configured
permissions for network access, browser opening, and sharing.

### Claude Science

Use **Settings** > **Connectors** > **Add connector** > **Local command**.
Choose the absolute Node executable and add the absolute `dist/server.mjs` path
as an argument. Use the advanced settings for the scene-service environment
variables. The server can run from a clone's `plugin/` directory or an extracted
share; its built files need no build step.

For versions using local connector files, add one object to the `servers` array
in `~/.claude-science/mcp/local-mcp.json`, preserving existing entries:

```json
{
  "name": "stereofold",
  "command": "/absolute/path/to/node",
  "args": ["/absolute/path/to/stereofold/plugin/dist/server.mjs"],
  "env": {
    "STEREOFOLD_SCENE_SERVICE": "/absolute/path/to/home/.stereofold/scene-service.json",
    "STEREOFOLD_SCENE_SOCKET": "/absolute/path/to/home/.stereofold/scene-service.sock"
  }
}
```

From an extracted share, the server is `plugins/stereofold/dist/server.mjs`.

Use the actual absolute path to your home folder in both scene settings. The
daemon runs with a stripped PATH and its own home folder, so `~` cannot name
the Mac user's `.stereofold` folder here. For the same reason, name every
optional helper it should reach — `cloudflared`, `adb`,
`ffmpeg` — by absolute path in `env`; the setup skill's table says which
variable turns on which feature. Grant connector read access to the plugin directory using your app's permission
controls. In `~/.claude-science/config.toml`, add
the actual `.stereofold` folder path to `[sandbox] user_read_paths` and
`[sandbox.network] allow_unix_sockets`. Keep existing paths in both lists.
For example, with those lists otherwise empty:

```toml
[sandbox]
user_read_paths = ["/absolute/path/to/home/.stereofold"]

[sandbox.network]
allow_unix_sockets = ["/absolute/path/to/home/.stereofold"]
```

Restart Claude Science and reconnect the connector after changing those files.
Install skills through **Settings** > **Skills** > **Add skill** using upload
or GitHub import. Keep each skill's scripts, references, and assets together.

For a headset session, run `node plugin/dist/headset-host.mjs 4HHB` from the
clone root in a Mac terminal before asking Claude Science to call
`continue_session`. Add `--vision-pro` for Apple Vision Pro. Keep the terminal
and browser tab open while Claude Science changes the scene.

### Standalone lesson planning

For lesson files alone, copy `skills/molecular-presentation/` with its scripts
and assets into your host's skill directory. Claude Code reads
`.claude/skills/` in a project or `~/.claude/skills/` for personal skills;
Codex commonly reads `~/.codex/skills/`. Claude Science
supports upload and GitHub import through **Settings** > **Skills** > **Add skill**.
Use the host's configured location when it differs.

The planner runs on Node 22 without the Stereofold server or a viewer. For live
desktop chapters, install the standard Molecular Structure Viewer separately.
For headset playback, register the full Stereofold runtime from a checkout or
install its plugin package, and load the stereo-structure skill. Read the
[molecular-presentation skill](skills/molecular-presentation/SKILL.md).

### What the host needs

Node.js 22 or newer runs the server. Private Wi-Fi sharing also needs `openssl`
at one of the locations listed in the
[setup helper reference](skills/stereofold-setup/references/voice.md) and
an assigned private IPv4 address.

## 2. Open a structure

To see a structure on the Mac alone, ask **"Inspect PDB 1CRN in
Stereofold."** If your host shows an inspection card, expand it or use **Open in side pane**
when available. If the panel is absent, ask to open the same session in a browser. In Claude Code or the Codex CLI, add "and
open it in my browser": the assistant calls `inspect`, then `open_inspector`.
For the headset, `open_companion` opens that browser tab itself when no scene
is saved yet, so `inspect`, then `open_companion`, is the whole path.

The assistant waits for a saved scene and a current ready panel before
connecting the headset. If the Codex card never appears, report that as a
desktop mounting problem; a server's successful open does not prove a visible
panel. `open_inspector` can open the same session in a local browser for
diagnosis, but that does not qualify the Codex embedded panel.

For a local structure, give the assistant its exact file. For a structure
already open in Molecular Structure Viewer, request the handoff described
above. Measurements, maps, multiple objects and other extra style layers do not
transfer as a matching scene. The standard protein cartoon and ligand layer can
transfer; Stereofold draws its ligand sticks as ball and stick. The assistant
must report these limits before you choose the coordinate-only alternative.

### Optional: open a lesson

Lessons ship in `demos/`; coordinates are downloads. Fetch the entry this one
names, then ask the assistant to open the bundled CRISPR-Cas9 lesson with
those downloaded coordinates. Create your Downloads folder if needed:

```sh
mkdir -p ~/Downloads
```

```sh
curl -fsSL https://files.rcsb.org/download/9KJ6.cif -o ~/Downloads/9KJ6.cif
```

The digest in the lesson must match the downloaded bytes, so a truncated file is
refused rather than drawn. `demos/README.md` lists the other lessons. To
skip the download, name a PDB entry — "Inspect PDB 9KJ6 in Stereofold" — and use
**Tours**, which holds ten bundled tours.

For the illustrated white scenes, ask **“Open the bundled daraxonrasib demo
on Quest.”** Its `demos/index.json` entry names the checked 9AX6 download and
`demos/daraxonrasib.json` lesson. Open it with `inspect_lesson` and
`assemblyId: "1"`; Next/Back switches between the overview and interface.
A plain “Inspect PDB 9AX6” opens the structure with generic tours, rather than
this named illustration. Background, focus, selection, placement and chapter
changes are conversational controls; new individual figure labels and layers need
lesson authoring. Headset microphone dictation also needs an active speech
recognizer and agent connection, and remains to be qualified by a wearer.

## 3. Put it on the Quest

In Claude Science, start the headset host in a terminal first and ask it to
join the scene, as [Claude Science](#claude-science) describes. The steps
below are for the other hosts.

Stereofold has been run on a Quest 2; Quest 3, Quest 3S and Quest Pro are
untested. The
[headset walkthrough](https://github.com/jvogan/stereofold/blob/main/docs/headset-walkthrough.md)
shows every screen the wearer meets, and
[First run and Quest sharing](https://github.com/jvogan/stereofold/blob/main/docs/first-run-and-sharing.md)
covers the inspector's share controls and how long a share lasts.

Before the first run, join the Mac and the headset to the same Wi-Fi network,
and sign in to the headset's Meta account in a browser on the Mac. No developer
mode, USB cable, or public tunnel is involved.

Say "Open this structure on my Quest." ("Open this lesson on my Quest" works
too.) The assistant calls `open_companion` with `connection: "lan"` and
`launch: "web"`, and this Mac opens Meta's Web Launch page in its default
browser. Web Launch reaches the headset only from a browser signed in to the
headset's Meta account. When the wrong browser opens, set `STEREOFOLD_BROWSER`
to the right application name, such as `Google Chrome`, in the environment the
host starts in, and launch again.

If macOS asks whether `node` may accept incoming network connections, click
**Allow**; otherwise the headset cannot reach this Mac.

Meta Web Launch is the ordinary route: press
**Open** once and let that one send put the page and one-time pairing
credential on the headset. Repeated sends have left Quest Browser
stuck in an unresponsive-app dialog; the server refuses duplicate launches
within a minute. A remembered headset reconnects without a
code on later runs. Put the headset on, then:

1. Select the Web Launch notification. If Meta's **Finding position in room**
   screen appears first, finish it: turn on a light and look around until it
   clears.
2. Accept the development certificate for that exact address. Quest Browser
   shows "Your connection is not private" on first launch and again after
   every browser restart; select **Advanced**, then **Proceed**. No certificate
   authority is installed, and the browser keeps a warning marker beside the
   address.
3. Wait for the page to pair itself. If Web Launch did not deliver it, open the
   address in the original tool result or connection dialog in Quest Browser,
   and type its eight-digit pairing code; the code expires in ten minutes and works once.
4. Tap **Enter VR**, and allow the microphone if Quest Browser asks. The page requests
   passthrough when supported and falls back to opaque VR. **Enter plain
   VR**, under **More options**, is the opaque room.

### On Apple Vision Pro

Safari in the visionOS 27 simulator exercised the opaque immersive view and
look-and-pinch controls. Use the same route on a physical Vision Pro and verify
the current session's rendered receipts. The tested Safari WebXR route exposes
opaque VR; the companion probes the browser's current session modes. Use the
Safari handoff in place of Meta Web Launch. Say "Open this structure on my Vision Pro." The assistant calls
`open_companion` with `connection: "lan"`, `headset: "apple"` and
`launch: "auto"`, and this Mac copies the one-time link, the address with its
pairing code, to its clipboard. The assistant does not repeat it.

1. On Vision Pro, paste the link into Safari's address bar and open it.
   Universal Clipboard carries it there when both devices use the same Apple
   Account with Handoff on. Otherwise open the address from the connection dialog
   and type its eight-digit pairing code.
2. Safari shows "This Connection Is Not Private" for the development
   certificate. Tap **Show Details**, then **visit this website**, and
   confirm.
3. Tap **Enter VR**, then **Allow** when Safari asks whether the page may
   start an immersive experience.
4. Look at a menu row and pinch to press it. Pinch the molecule to move it.
   Look at empty space and pinch to bring the menu back in front of you.

### On another headset browser

Ask your agent to use your available browser and inspect its capabilities.
Call `open_companion` with the current `sessionId`, `connection: "lan"`,
`headset: "auto"` and `launch: "none"`. Open the private HTTPS address in the
headset browser, pair it using the connection dialog and enter immersion. The
companion probes session modes and offers optional features without requiring
them. It prefers passthrough when available and falls back to opaque VR;
input handling follows the reported controllers, hands or transient pointers.

A missing device-specific launcher, USB cable or test record is not a platform
refusal. If a requested API is absent, try an available browser or runtime or
another supported mode, or prepare an explicitly authored native integration.
Keep coordinate identity and rendered acknowledgements across these paths.
Start with an appropriate scene and inspect real frame times as you increase
detail. Only an identified Quest 2 has the measured geometry and growth ceilings;
other and unknown classes are not given speculative hardware limits.

## 4. In the headset

Ask for changes in the host conversation, as in the first-session table. Each
request is one tool call on the same session, and the assistant reports
whether the headset drew it.

For hands-free conversation, start live voice in that same host chat. You can
speak, hear replies, and interrupt while the headset stays connected. This uses
the microphone on the device running the chat; no headset listener is needed.

Either controller can move and resize the molecule on its own. Point at it,
hold the trigger, and move your hand. Trigger plus stick up or down moves it
farther or closer; left or right turns it. Hold the grip and push that stick
up or down to change its size. A quick trigger tap selects a residue. The grip
also provides precise movement and wrist rotation. See the
[controller guide](https://github.com/jvogan/stereofold/blob/main/docs/headset-walkthrough.md#the-controllers) for all controls.

Hold **A** on the right controller or **X** on the left and speak; this Mac
transcribes it locally once [voice](#optional-voice) is set up. Hand tracking
has no buttons, so press the **Talk** row instead: point and pull the trigger,
or pinch while looking at it. That press uses a separate route that sends the
recording to OpenAI's Realtime API and stays off until you configure an OAuth
helper and compatible `websockets` in its selected Python interpreter. Follow
the [voice setup check](skills/stereofold-setup/references/voice.md) for that
route. The menu rows are `Talk`, `Tour`, `Reset`,
`Room`/`Room on`/`Room off`/`No room`/`Room?`,
`Atoms`/`Ribbons`/`Spacefill`/`Surface`/`Density`, `Mol*` and `Menu`. `Tour` starts the
lesson and reads `Play`, `Pause` or `Loading…` while one runs. `Reset` brings
back a structure you pushed out of reach; the room row reads `Room` before the
session has reported passthrough, then `Room on` or `Room off` names the state
you are in, and the press switches it. With passthrough off, `No room` means
passthrough is unsupported and `Room?` means support is still unknown; both
are disabled status readings. `Menu` opens the full grid. Aim at any menu glass
and hold either grip to move it; pushing or pulling changes its distance and apparent
size. Trigger dragging still works. The compact panel starts 47° left at a
1.35 m reading distance; turn toward it to read. **B** or **Y** brings it back
if you leave it out of sight. **Re-seat** is also available in the full grid. Lessons move
or hide the controls when they overlap the molecule, preserving its placement.

Authored lessons initially show `Figure` for their mixture of styles. A global
style choice updates the visible parts and preserves their colors and
annotations. Historical geometry estimates can warn that a requested style may
run slowly; they do not remove the style or lower its requested detail. Available
styles depend on the source, and successful rendering does not guarantee a
comfortable headset frame rate.

Tap the current style to cycle **Atoms** → **Ribbons** → **Spacefill** →
**Surface** → **Atoms**, skipping styles unavailable for the source. The
molecule keeps its position, rotation and scale. Density maps retain their
separate rendering and show a disabled **Density** control. When tour navigation
fills the compact column, find the style control and **Mol*** under **Menu**.
The full menu places the style control, **Undo** and **Redo** just below
**Close**. Shared history keeps up to 32 scene edits from the agent, desktop
and headset for the current source attachment. Changing the source starts a
new history. Grey **Undo** and **Redo** controls accept no click. Dragging from
a menu button moves the panel without activating that button.

Phrases answered without the assistant include "start the tour", "next", "back",
"pause", "bigger", "smaller", "put it above me", "show my room", "spin it",
"stop spinning", "grow it", "shrink it", "cap it" and "retry". Naming a part of
the loaded lesson works too: "show me the guide RNA". Anything else goes to the
attached assistant while it is listening; the assistant reads the current
state, acts, and answers out loud. A plugin installation alone does not keep an assistant
listening: its conversation consumer must remain active, and readiness reports
when none is attached. Text commands and manual controls remain available.

Replies appear once, in the card below your gaze. This includes growth
confirmations, refusals and assistant answers. The structure caption plate is
reserved for tour chapters; replies never replace its text or headings.
Without a running tour, there is no chapter caption chrome. Lessons that hide
chapter captions keep them hidden during replies. The reply card clears
after feedback ends.

## 5. Grow, then Mol\*, then stop

"grow it" steps a staged lesson to its next tier without leaving the session:
the coordinates and the lesson are replaced together, and the room anchor,
placement and scale survive. `microtubule-growth` is the staged lesson, in seven
tiers from one tubulin monomer to the complete thirteen-protofilament tube.
Coordinates are downloads, so they live in `~/Library/Caches/Stereofold/demos`
rather than in this directory. A tier that is not cached is fetched during the
grow, from the address `demos/index.json` records and against the digest it
records; the wearer hears "Fetching those coordinates now. Give me a moment."
and the grow finishes when they land.

The `filament` tier needs a prepared EMD-6347 density map. Prepared maps are
not included in installed plugins or shares. The source demo launcher downloads
and prepares the map on the computer hosting the session; later runs reuse its
verified cache. Check the launcher's prefetch result before putting on the
headset. A live session does not prepare a missing map. If it is absent, ask
for `tip` directly from `wall` to skip it. A tier a Quest 2 cannot hold is refused out loud —
"Too big for this headset. Staying here." — and nothing changes. On a Quest 2
that size refusal applies to the `tube` tier.

Treat live density transitions as experimental. Verify a current, ready
companion and its rendered receipt before continuing.

For tubulin copies that appear at fixed positions, use the separate
[`microtubule-arrival` demo](demos/README.md#build-a-tube-overhead), starting at
`build`. Its chapters reveal a single loaded wall; its `density` stage provides
the final tube for an overhead view. The demonstration uses two different
experimental structures and keeps their identities in the lesson captions.

Say "open in Mol\*" or press the `Mol*` row: the plate reads and the Mac speaks
"Opening the full viewer. Say return when done.", the session ends and the full
Mol\* viewer loads in the headset with the structure, the lesson's colors and
the saved scene already applied. To come back with your changes, press **Apply
changes, then back to headset** there, or hold **Hold to talk** and say
"return". The page sends appearance, selection and camera to the Mac and
follows its own **Back to headset view** link, and for the next 120 seconds a
tap anywhere on the companion page re-enters VR. When that press does not
finish, the page saves a `.molj` state file instead and prints its path under
`~/Downloads`: the Mac is unreachable or refuses the post, or the panel is
still rendering, still owes a change, or holds unsaved work of its own when
the page's loop of 18 posts runs out. Then ask the assistant to import that
file. To put the viewer on the Mac's monitor and stay in the headset, ask the
assistant "Open it on the Mac". For "Stop sharing", the agent calls
`manage_companion` with the current `sessionId` and `action: "close"`, then
checks `lan: null` and `wearer.shareOpen: false` before confirming that the
listener closed and paired devices disconnected. The desktop session stays
open; quitting the host ends both.

## Optional: voice

Controller push-to-talk transcribes on this Mac, with Apple's on-device
recognizer or with whisper. Running `sh native/applespeech/build.sh` builds the
Apple transcription binary on macOS only; on any other operating system the
script prints "applespeech builds only on macOS. Use whisper on this host; see
README.md in the plugin directory." to stderr and exits with status 1. On a Mac
without `xcrun` it prints "xcrun was not found. Install the Xcode command line
tools with: xcode-select --install" and exits with status 1. The binary alone
does not make voice ready.

Voice needs `ffmpeg` plus either that Apple binary or `whisper-cli` with a
readable model, at `~/.cache/whisper-cpp/ggml-base.en.bin` or named by
`STEREOFOLD_WHISPER_MODEL`. The Apple route also needs
Speech Recognition consent from the app that started the host. Spoken answers
use the configured reply provider. Both transcription and
reply audio need `ffmpeg`.

Setting `STEREOFOLD_PTT_TRANSCRIBE=1` is recommended to make transcription explicit.
Unset, the runtime auto-detects a local transcriber: an Apple helper with
`ffmpeg` or a complete Whisper route enables transcription, and readiness reports the
local recognizer resolved (Apple still needs Speech Recognition consent).
With none detected, voice stays off and readiness names the missing prerequisites;
no headset speech is transcribed. With `=1` and no transcriber, readiness
instead reports the missing prerequisites. `0` explicitly turns transcription
off. Recording still requires a held talk control and microphone permission.
Put the value in the MCP server environment, then restart the host. A terminal
export applies only to a host launched from that terminal:

```sh
export STEREOFOLD_PTT_TRANSCRIBE=1
```

Keep an already configured spoken-reply provider. On a Mac without an OAuth
narration helper, `STEREOFOLD_REPLY_VOICE_PROVIDER=system` explicitly selects
macOS `say` for local replies. Do not change a working OAuth setup during
transcription setup or silently switch providers after a failed reply.

After saving a scene, call `stereo_structure.get_readiness` with its `sessionId` and
`speechCheck: true`; require resolved `transcription`, a passed one-word
`replies` check, and one test press returned by `listen_voice` before calling
voice ready.

Recover a missing Apple binary with `sh native/applespeech/build.sh`. Open a
refused consent setting with:

```sh
open "x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition"
```

Recover the Whisper route with `brew install whisper-cpp ffmpeg`, then set
`STEREOFOLD_WHISPER_MODEL=/absolute/path/to/readable/ggml-model.bin`.
For persistent system replies, set
`replyVoiceProvider` to `system` in `~/.stereofold/config.json`, preserving
other keys. Leave an existing `oauth` choice in place. OAuth replies are
optional and need a narration helper that Stereofold does not ship. Leave that
route unused unless you have such a helper; then `STEREOFOLD_AGENT_VOICE_BIN`
names its absolute executable path.
An unset reply provider still selects OAuth in the runtime, so keep `system`
explicitly configured. Repeat `stereo_structure.get_readiness` after recovery.

## Two hosts on one scene

`continue_session` joins a scene that another host on this Mac has saved, such
as the Codex app's, so both hosts read the same selection, lesson and
placement. A host that sandboxes its MCP servers may hide that scene. When Claude Science isolates its connector home and local networking, the
scene-service bridge lets it join an externally rendered scene.

The headset host opens the share instead. In a Mac terminal outside Claude
Science, from the plugin directory (`plugin/` in a clone,
`plugins/stereofold/` in a share), run:

```sh
node dist/headset-host.mjs 4HHB
```

It needs no dependency install. It draws the structure in a browser tab on
this Mac, opens private Wi-Fi sharing, opens Meta Web Launch for a Quest, and
serves the scene on a Unix socket, `~/.stereofold/scene-service.sock`. For
Apple Vision Pro, add `--vision-pro`: Web Launch stays off and the one-time
link goes to this Mac's clipboard for Safari. Keep the terminal and the tab
open; Ctrl-C ends the share. `--help` lists the other options.

Two environment variables on Claude Science's server entry let it join:
`STEREOFOLD_SCENE_SERVICE` names the owner record,
`~/.stereofold/scene-service.json`, and `STEREOFOLD_SCENE_SOCKET` the socket,
`~/.stereofold/scene-service.sock`. Write both with `~` replaced by your home
folder's full path, because the sandbox has a home folder of its own. Let
the sandbox read the folder and connect to the socket; in Claude Science's
`config.toml` that is `[sandbox] user_read_paths` plus `[sandbox.network]
allow_unix_sockets`, both naming `~/.stereofold`, followed by a daemon restart
and a reconnect of the connector. Then ask Claude Science to join the
Stereofold scene on this Mac and show a structure. When no headset host is
running, its `continue_session` answer gives the exact command for your
installation.

`node dist/scene-socket-relay.mjs` still serves the socket on its own, for an
owner started some other way, and follows that owner's restarts.

## When it does not work

| What you see | What it means |
| --- | --- |
| The panel is empty after opening a lesson | Check the session message. If loading failed, choose **Retry loading** and expand **Error details**. Ask for the inspection state to distinguish a pending load from a failed one. |
| The room dims every ten seconds | Quest Browser's unresponsive-app dialog. Press **Close app** in the headset. |
| Commands come back as busy | A system dialog is over the session, or a render is running. Let the refusal stand. |
| Captions appear, nothing is spoken | This Mac rendered no clip. It needs `ffmpeg` and a reply-voice helper. |
| The headset shows "Finding position in room" | Meta's boundary dialog, raised after a reboot in a dark room. Quest Browser never receives the page behind it. Only a person clears it: put the headset on with a light on and dismiss the dialog. |
| A bar says the immersive web experience is still running in the background | Quest Browser's own chrome after any immersive session, including a plain exit. It is harmless; leave it. Only force-stopping the browser removes it. |
| macOS asks whether `node` may accept incoming network connections | The LAN host is listening for the first time. Click **Allow**, or the headset cannot reach this Mac. |
| The plate reads **Link to the Mac lost. Your view is still here.** | Ask the agent to read `manage_companion` with `action: "status"`. If `lan` is null or `wearer.shareOpen` is false, it must reopen sharing with `open_companion` for the same session and chosen route, then follow the returned address and launch instructions. Once the listener is open, press **Re-pair** to exit XR, or **Pair again** on the flat page, then **Enter VR**. A valid remembered headset key needs no code. |
| The headset goes quiet and the Mac shows no error | The share ended. It expires thirty minutes after the last request and eight hours after it opened. The host process can stay alive after its listener ends; inspect `manage_companion` status and restart sharing if needed. Start a longer session with `--share-hours <hours>`, from 0.5 through 24. |

The **Tour** control starts the journey for the loaded structure (4HHB starts
the hemoglobin journey). If none matches, it keeps the scene and says
“No journey for this structure yet,” naming its ID when available. **Tours**
opens the explicit chooser; **Next one** cycles it and **Tour** starts the
chosen journey, which may load another structure. A failed stage reports its
reason and restores the previous source and saved view; a newer correction
prevents stale recovery from overwriting it. Visibility is confirmed only after
the panel renders, saves and acknowledges the stage. At rest, the caption plate
shows the loaded structure's title, ID, chain and assembly summary and current
appearance and selection count.
