# First run and Quest sharing

This page follows a new install from the first structure on the Mac to a
shared scene on a Meta Quest. It then covers how long a share lasts, the jump
to the full Mol* viewer and back, and how to package a build for another
machine. For the step-by-step headset procedure and its troubleshooting, read
the [headset walkthrough](headset-walkthrough.md). Its
[Which headsets](headset-walkthrough.md#which-headsets) section states which
devices this release runs on.

## Install from GitHub

This repository is a plugin marketplace named `stereofold`:
`.agents/plugins/marketplace.json` serves Codex and
`.claude-plugin/marketplace.json` serves Claude Code, and both install the
plugin directory `plugin/`. The runtime bundles in `plugin/dist/` are
committed, so installing needs only Node.js 22 or newer: no pnpm, no Python and
no build.

For Codex:

```sh
codex plugin marketplace add https://github.com/jvogan/stereofold
codex plugin add stereofold@stereofold
```

`codex plugin add` writes `config.toml` in `CODEX_HOME` (default `~/.codex`)
and copies the plugin into that profile's plugin cache. To install into another
profile, set `CODEX_HOME` before you run it. Start a new conversation after
enabling the plugin.

For Claude Code:

```sh
claude plugin marketplace add jvogan/stereofold
claude plugin install stereofold@stereofold
```

Claude Science reads no marketplace; register the server from a clone as
[Claude Science local MCP server](install.md#claude-science-local-mcp-server)
describes. A generated share installs as `stereofold@stereofold-local`; see
[Make and install a local share](install.md#make-and-install-a-local-share).

Claude Code mounts no inspector panel of its own. For a headset session, the
assistant calls `inspect`, then `open_companion` with `connection: "lan"`,
`headset: "meta"` and `launch: "web"`. When no scene is saved yet,
`open_companion` renders the inspector in this Mac's browser, waits for the
scene to save, shares it and launches the headset, so no separate
`open_inspector` call is needed. To view the structure on the Mac only, the
assistant calls `inspect`, then `open_inspector`. `continue_session` joins a
scene another host on this Mac already saved.

### Confirm the tools

In a new conversation, confirm that the following namespaced tools are
present:

```text
stereo_structure.inspect
stereo_structure.inspect_file
stereo_structure.inspect_scene
stereo_structure.inspect_lesson
stereo_structure.open_companion
stereo_structure.open_inspector
stereo_structure.continue_session
stereo_structure.manage_companion
stereo_structure.control_tour
stereo_structure.get_inspection_state
stereo_structure.update_inspection
stereo_structure.open
stereo_structure.control
stereo_structure.get_state
stereo_structure.set_mode
stereo_structure.set_motion
```

These are some of the plugin's 37 model-visible tools. There are 64 registered tools in total, including 27 app-only tools; see [plugin/README.md](../plugin/README.md) for the complete list. `pnpm --filter stereo-structure smoke` asserts both lists by name and is what to check when a count here looks wrong.

Codex hides the 27 app-only tools from the model, and so does Claude Code
2.1.280, which reads the same visibility hint. Each host renames the tools:
Codex session logs record `mcp__stereo_structure__stereo_structure_<name>`,
and a Claude Code plugin install names each one
`mcp__plugin_stereofold_stereo_structure__stereo_structure_<name>`.

### Use Claude Code without installing

To reach the same server without writing a Claude Code profile, name it in a
config file of your own and pass that file to one interactive session. Use
absolute paths; the plugin's own `.mcp.json` names `./dist/server.mjs` against
`cwd: "."` and resolves only for a host that launches from the plugin
directory:

```json
{ "mcpServers": { "stereo_structure": {
  "command": "/absolute/path/to/node",
  "args": ["/absolute/path/to/stereofold/plugin/dist/server.mjs"] } } }
```

```sh
claude --strict-mcp-config --mcp-config /absolute/path/to/stereofold-mcp.json
```

Then ask: “Inspect PDB 1CRN in Stereofold and open its inspector in my Mac
browser.” Keep Claude Code running while you use the inspector: its server,
and the loopback page it serves, stop with the session. If you pass a prompt
on the command line, put it before `--mcp-config`; that flag takes several
paths, so a prompt written after it is read as one more config file. Claude
Code names each tool from the `stereo_structure` key in that file
`mcp__stereo_structure__stereo_structure_<verb>`, so the inspect call is
`mcp__stereo_structure__stereo_structure_inspect`.

## Open the first structure

In the Codex desktop app, ask:

> Inspect PDB 1CRN in Stereofold.

In Claude Code, ask:

> Inspect PDB 1CRN in Stereofold and open its inspector in my Mac browser.

For that Mac-only route, the assistant calls `inspect`, then `open_inspector`
with the returned `sessionId`. For a headset, skip `open_inspector`: the next
section's `open_companion` renders the inspector itself.

Before describing the structure as visible, the assistant reads
`stereo_structure.get_inspection_state` and confirms `hasScene: true` and an
intended panel with `current: true` and `availability: "ready"`. The inspector
saves appearance, selection, placement and camera to its session; keep the
returned `sessionId` for later commands. `inspect_file` accepts an explicitly
chosen local `.cif` or `.mmcif` path, which keeps the coordinates out of the
conversation.

## Share the saved inspection with Quest

A saved inspection reaches the Quest over one of two transports:

- **Connect over Wi-Fi** keeps the inspection on the Mac and your private
  network. Use it for private data.
- **Send using Meta** opens Meta's chooser and an expiring public HTTPS relay.
  The chosen coordinates travel through that relay, and you choose the target
  device on Meta's page. It needs `cloudflared` on the host `PATH` or at the
  absolute path in `STEREOFOLD_CLOUDFLARED`; Stereofold never downloads it. It
  is never an automatic fallback.

Loopback is local to the Mac and cannot be opened from the Quest. Do not paste
a capability URL, pairing code or token into a public issue or chat.

### Ask the assistant

If a Claude Science connector sandbox blocks local listening, start
`node plugin/dist/headset-host.mjs 4HHB` in a Mac terminal first, then ask
Claude Science to join the Stereofold scene on this Mac. The
[README](../README.md#claude-science) has the steps.

In Claude Code or Codex, say “Open this structure on my Meta Quest over private Wi-Fi.” The assistant
calls `open_companion` with the session's `sessionId`, `connection: "lan"`,
`headset: "meta"` and `launch: "web"`, and this Mac opens Meta's Web Launch
page, where you click **Open** once. In Claude Code, `inspect` then
`open_companion` is the whole path: with no saved scene, `open_companion`
renders the inspector in this Mac's browser and waits for the scene to save
before it shares. The [headset walkthrough](headset-walkthrough.md#put-the-structure-on-your-quest)
lists what happens in the headset from there.

From a repository checkout, `pnpm --dir plugin run quest <PDB ID>` runs the same
route in one command; the walkthrough's
[Start from a terminal instead](headset-walkthrough.md#start-from-a-terminal-instead)
lists its options.

### Connect over Wi-Fi from the inspector

In the desktop inspector, save the scene, then open **More** in the header and
choose **Open on Quest**, then **Connect over Wi-Fi**. The dialog shows the
address, the pairing code, the certificate fingerprint and the expiry.

1. Keep the Mac and the Quest on the same Wi-Fi network.
2. If the dialog offers a choice, pick the Mac's private IPv4 interface and a
   port. The default port is 8443.
3. In Quest Browser, open the exact address the dialog shows.
4. Accept the development certificate for that address. Quest Browser shows
   "Your connection is not private" first: select **Advanced**, then
   **Proceed to** the address. The certificate is a private one this Mac made for its own IPv4
   address, so the browser keeps a warning marker beside the address. The
   plugin installs no certificate authority and changes no system trust store.
   The warning returns whenever the Mac's address changes and after every
   Quest Browser restart.
5. Bookmark the base address while the pairing page is open, without `/viewer`
   or a `#` fragment; the paired viewer address expires. Then enter the code
   the dialog shows.
6. Tap **Enter VR**. The first time, Quest Browser asks for the microphone at
   this tap; allow it. **Enter VR** opens `immersive-ar`, so the structure
   stands in your own room wherever the browser reports passthrough, and falls
   back to `immersive-vr` where it does not. **Enter plain VR**, under
   **More options**, forces the opaque session.
7. Keep the Mac and its Stereofold process running while the Quest is
   connected.

Wi-Fi sharing needs `openssl` at `/usr/bin/openssl`, `/opt/homebrew/bin/openssl`,
`/usr/local/bin/openssl` or `/bin/openssl` to create the certificate, and an
assigned private (RFC1918) IPv4 address on the chosen interface. Stereofold
searches only those four paths; it reads neither `PATH` nor an environment
override for `openssl`.

### Target the headset panel

The browser companion is another panel of the same saved inspection. The
assistant targets the companion panel, shown as `surface: "companion"`, uses
its current binding, and waits for a `rendered` receipt before reporting a
command as visible. One pending render is admitted at a time. Unsaved local
work stays in its own panel, and a separate Molecular Structure Viewer scene is
not mirrored into Stereofold.

The [headset walkthrough](headset-walkthrough.md) describes what the wearer
sees, the controller map and the menu. The tour controls behave the same in
the headset and on the desktop:

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

### Voice transcripts

Holding **A** or **X** records the wearer, and this Mac transcribes the clip
with Apple's on-device recognizer or whisper. Both recognizers are primed with
molecular commands, representation and color-scheme names, chain letters, and
the loaded scene's own chain identifiers, entity names, ligand codes, residue
numbers and PDB ID.

`listen_voice` returns the raw `text`, a `normalizedText` proposal and the
`normalizationRules` behind any correction. “Hi Jane” becomes “hide chain A”
only when A identifies one chain copy and no scene name contains “Jane”; “one
CERN” becomes “1CRN” only when that PDB ID is loaded. Ambiguous wording stays
raw. These are proposals: the assistant still checks the current scene and
waits for a rendered receipt before confirming a change.

## How long a share lasts

| Limit | Length |
| --- | --- |
| Pairing code | Ten minutes, and it works once |
| Share, while idle | Thirty minutes after the last request from a paired headset |
| Share, whatever the traffic | Eight hours after it opened, by default |

Every request from a paired headset pushes the thirty-minute window out again,
up to the ceiling. A `listen_voice` call keeps this Mac's inspection sessions
open while the headset is off, but only headset requests extend the share. Renewal
never reopens the pairing window, so a headset that has not paired within ten
minutes needs a new code. `manage_companion` with `action: "status"` reports
the current expiry as `sessionExpiresAt` and the ceiling as
`sessionMaxExpiresAt`.

To raise the ceiling, start the host with `--share-hours <hours>` on the
`quest` command, or set `STEREOFOLD_SHARE_MAX_HOURS` in the server's
environment, from 0.5 through 24. A value outside that range is refused at
startup. Set it before the host starts: a session that runs past its ceiling
loses the headset however busy the wearer was. Pass `--share-hours 12` for a
working day that runs into the evening.

An assistant waiting in `listen_voice` is warned first. From fifteen minutes
before the share closes, each answer carries `share` with `state: "closing"`,
a `reason` (`ceiling`, or `idle` when no paired headset has called for fifteen
minutes) and the closing time `at`, plus one sentence that says what to do.
Calling `open_companion` again before the ceiling keeps the same ceiling. Once
the share has closed, `state` is `closed`, and `open_companion` with
`connection: "lan"` opens a new share with a new ceiling and a new code. A
headset that paired before pairs again without the code.

Calling `open_companion` again always creates a new code. With the same
structure behind the address, every paired headset stays paired and the
ceiling keeps counting from the first open. A different structure capability
revokes the paired headsets and starts a new ceiling. `manage_companion`
inspects status, revokes one client or stops sharing.

When a share ends, the listener closes and the host process keeps running, so
the Mac prints no error. The headset page shows **Link to the Mac lost. Your
view is still here.** Check the share rather than the process:
`manage_companion` with `action: "status"`, or the listener on the selected
port, which is 8443 unless `STEREOFOLD_LAN_PORT` or the dialog chose another:

```sh
lsof -nP -iTCP:8443 -sTCP:LISTEN
```

No output means the share is over even though the host is alive.

## Cinematic to detailed and back

The inspector panel is a cinematic view: four representations, five color
themes, one selection, one placement. Mol* itself has far more.
`open_detailed_view` serves the complete Mol* viewer application from this Mac,
with the structure and saved scene already applied, so you can measure a
distance, build a component or export an image and then carry the result back.

The control that starts the full viewer decides where it opens. This section is
the one description of both routes; the other pages point here.

| Route | What starts it | Where the viewer opens | The immersive session |
| --- | --- | --- | --- |
| Mac monitor | `open_detailed_view` with `open: true`, the **Detailed view** button above the desktop panel, or the spoken "open it on the Mac" from inside the headset | This Mac's default browser, on loopback | Keeps running |
| Same headset | The `Mol*` row on the collapsed menu, or the spoken "open in Mol*" | The same Quest Browser tab, on the origin that serves the companion page | Ends, then the tab navigates |

Both routes carry the same scene out, and both bring work back through the
page's own **Apply changes, then back to headset** press, with no file and no
agent in between. When that press cannot finish, the page falls back to a
`.molj` file by itself: the Mac is unreachable or refuses the post, or a panel
is still rendering, is still waiting to apply another part of the returned
changes, or holds unsaved local work when the page's bounded loop of 18 posts
runs out.

### The Mac-monitor route

1. Save the view you want in the panel, then ask the assistant to open the
   detailed view. On the standalone desktop host, press **Detailed view** in
   the bar above the panel instead.
2. With `open: true` the Mac opens the address in its default browser, and the
   result says whether a browser opened. If nothing opened, open the whole
   address that comes back, including the part after the `#`. That fragment is
   the page key, and the browser never sends it anywhere. In Claude Science the
   panel cannot open links, so copy the address out of the tool result and
   paste it into a browser on this Mac.
3. Work in the full viewer. It runs on loopback and reaches no network, so its
   own PDB and density downloads stay blocked.
4. Press **Apply changes, then back to headset**. The page posts its pruned
   Mol* state and the residues selected there to the Mac. Its caption then
   reads "Sent … back to Stereofold." naming the parts that changed
   (appearance, selection, camera), or "Stereofold already matches this
   view." Anything the panel cannot render is listed after "Stayed in Mol*:".
   The Mac's loopback copy has no Back link, so the page stays open after the
   press.
5. If the press fails, the page saves the state as a `.molj` file instead,
   prints the path under `~/Downloads/`, and says why. Give the assistant that
   absolute path for `import_detailed_view`. Appearance returns first; call it
   again with a new `commandId` until the result says nothing was queued.

A wearer who asks for the Mac by name from inside the headset ("open it on
the Mac", "show it on the Mac") gets this route with the session left
running. The caption reads **Mol\* is open on the Mac. Lift the headset.**
when the window is up, and the viewer finishes drawing a few seconds later.
When the Mac cannot open it, the caption says **Share expired. Ask Claude to
re-open it.** after the LAN share ran out, **This host cannot open a Mac
browser** on a host without macOS, and **The Mac browser did not open** or
**Could not open Mol\* on the Mac** otherwise. A density tier with no atom
coordinates is refused with the tier's name and "tier has no atoms. Switch to
an atomic tier."

### The same-headset route

The wearer never types, never leaves VR to start it, and comes back to VR
without taking the headset off.

1. Ask the assistant to inspect a structure: a four-character PDB ID, or an
   absolute `.cif` path for `inspect_file`. The panel mounts on the Mac.
2. Set the view and selection in the panel and press **Save**. Sharing refuses
   an unsaved scene.
3. Ask for the headset: `open_companion` with `connection="lan"` and
   `launch="web"`. The Mac prints the address, an eight-digit code and the
   certificate fingerprint, and opens Meta's Web Launch page. Click **Open**
   there once.
4. Put the headset on. Accept the certificate warning for that exact address.
   The code travels in the link's fragment, so nothing is typed. Tap
   **Enter VR**.
5. Arrange the molecule in the room by grabbing it with a grip, or press
   **Menu** for **Above us** and **In reach**. Every change saves itself.
   A placement you choose here survives the headset coming off and going
   back on: the floor settle runs on first entry only, never over your choice.
   Tap the current style to cycle **Atoms**, **Ribbons**, **Spacefill** and
   **Surface**, then back to **Atoms**, keeping the molecule's placement.
   Unavailable coordinate styles are skipped; density maps show a disabled
   **Density** control. **Undo** and **Redo** sit just below **Close** in the
   full menu and are grey when unavailable. Shared history includes up to
   32 agent, desktop and headset scene edits for the current source attachment;
   changing the source starts a new history.
6. Press the `Mol*` row on the compact menu, below the current style and
   above **Menu**. When tour navigation fills the column, open **Menu** to
   find it. Saying
   "open in Mol*", "open molstar" or "open the workbench" presses the same
   control. The panel saves first, then asks the Mac, so no separate save is
   needed in VR. The room row reads **Room**, **Room on** or **Room off**.
   With passthrough off, it reports **No room** when
   passthrough is unsupported or **Room?** while support is unknown; both
   are disabled status readings.
7. Read the caption and listen. **Opening the full viewer. Say return when
   done.** is drawn on the plate and spoken through the Mac's voice. The page
   holds that line for 1.5 seconds, ends the immersive session, confirms from
   the renderer that the session is gone, and only then sends the same tab to
   the viewer. Two captions mean the tab stayed. **Mol\* page unreachable.
   Trying again.** means the page could not ask its own origin whether it
   serves the viewer; press the control again. **The headset view would not
   close. Staying here.** means the session refused to end, and the scene is
   still in front of you.
8. The full viewer loads in Quest Browser as a flat page with a bar at the
   top: **← Back to headset view**, **Apply changes, then back to headset**
   and **Hold to talk**. Once the page has joined the session it prints "Hold
   to talk and say “return”, or press Return, to go back to the headset."
9. To come back with your work, press **Apply changes, then back to headset**,
   or hold **Hold to talk** and say "return". "Go back", "done", "take me
   home" and their variants work too, matched as whole phrases; a longer
   sentence goes to the assistant instead. The Mac transcribes the recording
   and the page runs the same press. The page sends appearance, selection and
   camera, says which of them changed, then follows the Back link by itself.
   With nothing to carry, press **← Back to headset view**, the browser's
   Back arrow, or the controller's B button.
10. The companion page comes back in 2D and shows **Tap Enter VR, or anywhere
    on this page — the headset needs one real tap to go back in.** for up to
    120 seconds. One tap re-enters VR on the same session and scene. A return
    made while no headset panel was attached is saved on the session, so the
    scene you re-enter is the one you sent.
11. An assistant on the Mac can bring you back too. `recall_headset` shows one
    sentence on the page, and the page navigates home within a few seconds.
    `get_inspection_state` reports `companionInDetailedView` while the tab is
    away.
12. If the caption says **Share expired. Ask Claude to re-open it.**, ask for
    `open_companion` again. A headset that paired before pairs again without
    a code. `manage_companion` with `action="status"` reports when the share
    ran out.

The detailed page renews the share every five minutes while it is visible, so
a wearer who studies the structure past thirty minutes still has a live
listener behind the Back link. The eight-hour ceiling still applies.

What crosses each way:

| Direction | Carried | Left behind |
| --- | --- | --- |
| Panel to detailed | Coordinates, model, assembly, representation, color theme, opacity, background, camera, residue selection, selection labels, lesson emphasis colors | Placement, tour, immersive state |
| Detailed to panel, the Return press | Representation, color theme, uniform color, opacity, background, the residue selection, camera pose | Extra representations, measurements, volumes, extensions; a component built in Mol* comes back as its selected residues, not as a component. The page names what stayed |
| Detailed to panel, a `.molj` file | Representation, color theme, uniform color, opacity, background, camera pose | Selection, extra representations, components, measurements, volumes, extensions |

The detailed page opens with the camera fitted to the structure, not on the
panel's pose, because that pose frames a molecule seated in the wearer's room
and leaves it a speck in a browser window. It also draws a
`molecular-surface` or `spacefill` scene as `cartoon`, because a surface takes
seconds to build on load. The full control tree builds either in one click.

On the file route the framing comes back on a second call. A panel renders one
command at a time, so `import_detailed_view` queues the appearance first and
the camera after it. When the result says the detailed framing is still to
come, wait for that command's receipt and call the tool again with the same
file and a new `commandId`; repeat until the result says nothing was queued.
Only the pose crosses. Scene radius, depth fog and the near and far bounds stay
with the panel's own depth controls, so a returning snapshot cannot change them.

A headset already connected to this inspection follows without another call.
Opening a detailed view marks the session shared, so every panel with no
unsaved work picks up the newly saved scene on its next heartbeat and redraws.
Appearance and placement cross that way. The framing does not cross while the
headset is presenting, because head tracking controls the view there; the
desktop panel still takes it.

A detailed view is a copy taken at one moment, not a live link. Later panel
changes do not follow it, and it expires with the companion link that carries
it. A `.molx` archive is a zip rather than JSON and is refused by name; save
`.molj` instead.

This route needs no other plugin. It is not the Codex Molecular Structure
Viewer, and it opens nothing on molstar.org.

## If entry does not complete

The [headset walkthrough](headset-walkthrough.md#when-it-goes-wrong) covers
failures a wearer sees. From the Mac side:

- If the link, pairing code or relay session expired, check that the desktop
  inspection is saved and ready, and share it again. An old browser tab cannot
  renew its capability.
- If the address fails to load, check that the Quest can reach the selected
  private IPv4 address and that the Mac's firewall allows the chosen port.
  After a network change, share again.
- If the page loads but the entry controls are missing, press
  **Reload viewer**. A current companion panel stays visible while a
  temporary heartbeat connection recovers; failed scene writes need explicit
  confirmation or a saved-view reload.
- If a mounted desktop viewer may be stale, run `pnpm --filter
  stereo-structure smoke` and compare its printed viewer hash with the mounted
  viewer's `viewerBuild` diagnostic before drawing conclusions.

## Distribute a build as a share (maintainers)

Most people install from GitHub. Read this section only to hand a fixed build
to another machine as a local marketplace. A share's marketplace is
`stereofold-local`, its plugin directory is `plugins/stereofold/`, and it
installs as `stereofold@stereofold-local`.

The distributable unit is the complete staged plugin at
`plugin/release/stereofold/`: the MCP server, inspector and viewer bundles,
manifest, icons, license, third-party notices and the bundled skills. A skill
file alone contains no server, UI bundle, pairing listener or Quest entry
code, so copying `plugin/skills/stereo-structure/SKILL.md` elsewhere cannot
install Stereofold. Do not hand over a single `dist` file, and do not copy
files into a host-managed plugin cache.

### Build and verify a release

The build machine needs Node.js 22.13 or newer, pnpm 11.19.0, and Python 3. The
staged runtime itself needs only Node.js 22 or newer. Release staging runs on
macOS and Linux, because its guarded directory swap uses the native exclusive
rename on those systems.

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm --filter stereo-structure test
pnpm --filter stereo-structure release
```

`release` rebuilds the bundles, stages the self-contained artifact, copies it
to a temporary directory, and launches the copied server without
`node_modules`. It also reconstructs a prospective Git checkout and launches
that copy. The release gate proves packaging and MCP startup. It does not
prove installation in a host, host iframe behavior, WebGL2 on a target machine,
or entry on a physical Quest.

To package the staged directory into a share and install it,
follow [Make and install a local share](install.md#make-and-install-a-local-share).
The helper writes `SHA256SUMS` and an archive checksum beside the share; check
both before you transfer it:

```sh
cd /absolute/path/to/stereofold-share
shasum -a 256 -c SHA256SUMS
shasum -a 256 -c stereofold-marketplace.tar.gz.sha256
```

On Linux, use `sha256sum -c` with the same files.

Install through the marketplace commands. The optional source installers in
`harness/kits/` derive their paths from the checkout and provide previews or
configuration backups.

## Checks without a headset

From a source checkout, you can run the unit suite and the release gate
without a host account or headset:

```sh
pnpm --filter stereo-structure test
pnpm --filter stereo-structure release
pnpm --filter stereo-structure release:verify
```

The LAN browser check, [`plugin/scripts/lan-browser.ts`](../plugin/scripts/lan-browser.ts),
covers pairing, source integrity, the rendered companion, tour navigation,
shared commands, revocation and listener shutdown in an isolated browser. The
XR lifecycle checks use emulation. [Testing without a headset](testing-without-headset.md)
lists every check. None of them covers:

- mounting and native-file dispatch in Claude Science;
- menu comfort and binocular room-scale depth in a worn headset, or entry on
  any headset other than a Quest 2;
- host-specific registration and sandbox permissions.

Treat the [release gate](release.md) and the
[host verification procedure](host-verification.md) as evidence within those
limits, not as a report from a worn headset.
