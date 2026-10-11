# Headset walkthrough

This page takes you from your agent's reply to a structure standing in your
room on a Meta Quest, and then to changes you ask the agent for. With Web
Launch you type nothing on the headset. Every address, pairing code and certificate
fingerprint belongs to your own Mac; read them from the tool result or your
terminal, not from this page.

After pairing, check that the intended structure is visible, one requested
scene edit renders, and Reset returns it within reach. The agent should confirm
`wearer.state: "in-vr"` before reporting immersive rendering.

## Which headsets

Stereofold is tested on a Quest 2 in Quest Browser, entering `immersive-ar`
passthrough. Quest 3, Quest 3S and Quest Pro run the same page in Quest
Browser and request the same session from the same button, but this release
has not been run on them. After pairing, the Mac reports a Quest 3S as device
class `quest3`. Apple Vision Pro was exercised in Safari in the visionOS 27
simulator, not yet on a device. Follow the
[Vision Pro steps](../README.md#put-a-structure-on-your-vision-pro) for that
headset. Other WebXR browsers are untested.

## Before you start

You need the following:

- Stereofold installed in your agent host. See [Install Stereofold](install.md).
- The Mac and the headset on the same Wi-Fi network.
- For the no-typing launch, a browser on the Mac signed in to the same Meta
  account as the headset. Meta's Web Launch page reaches the headset only
  from that account. Without it, [pair by hand](#pair-by-hand).
- For talking to the agent from the headset, a speech recognizer on the Mac:
  `ffmpeg` plus Apple's on-device speech helper or `whisper-cli` with a model.
  [Voice on a Mac](install.md#voice-on-a-mac) lists the setup. Everything else
  on this page works without it.

## Put the structure on your Quest

For Claude Science:

1. Ask Claude Science to continue the Stereofold scene on this Mac. If no host is running, start one from the clone root in a Mac terminal with `node plugin/dist/headset-host.mjs 4HHB`.
2. Reuse the paired Quest page, or pair as the terminal directs when there is no current connection. Keep the host terminal and browser tab open.
3. Ask Claude Science: “Join the Stereofold scene on this Mac and color it by chain.” It calls `continue_session` and changes that scene. See [Claude Science setup](../README.md#claude-science).

For Claude Code and Codex:

1. In your agent host, ask:

   > Inspect PDB 1CRN in Stereofold, then open it on my Quest.

   The agent first calls `continue_session` and keeps an existing session.
   For a different requested molecule it changes that session's source; if
   none exists, it calls `inspect`. It then calls `open_companion` with `connection: "lan"`,
   `headset: "meta"` and `launch: "web"`. In Claude Code and the Codex CLI,
   which have no panel of their own, `open_companion` first opens the
   inspector in a browser tab on this Mac and waits for the scene to save.
   Leave that tab open and visible: it is the panel that renders on the Mac.
   The Codex desktop app shows the panel inline instead. The Mac then opens
   Meta's Web Launch page in its default browser when a launch is needed.
   A current paired page is reused without another notification. If it is
   paused, wake it; if it is flat, tap **Enter VR** there. Continue with the
   launch steps below only when the agent reports a new launch.
2. If macOS asks whether `node` may accept incoming network connections, click
   **Allow**. Without it the headset cannot reach this Mac.
3. On the Web Launch page, click **Open** once. A second send inside a minute
   can leave Quest Browser stuck on an unresponsive-app dialog.
4. Put the headset on. If it shows Meta's **Finding position in room** or
   **Confirm boundary** screen, finish that screen first. In a dark room,
   choose **Continue without tracking** when offered; the stick controls
   below work with orientation-only controllers. For tracked hand movement,
   restore the lighting and tracking. Then open the existing notification or
   viewer page; ask for another launch only if neither is available.
5. Select the Web Launch notification. Quest Browser opens this Mac's address.
6. On the first launch, and again after every Quest Browser restart, Quest
   Browser shows "Your connection is not private" instead of the page. Select
   **Advanced**, then **Proceed to** the address. The certificate is a private one this Mac made for its own IPv4
   address, so the browser keeps a warning marker beside the address. Accepting
   it installs no certificate authority.
7. Wait for the page to pair. The link carries the one-time code, so you type
   nothing. A headset that paired before uses its saved key instead. The key
   lasts 30 days, and lapses sooner after 14 days without use.
8. Tap **Enter VR**. The page may ask for microphone permission at this tap
   so a later headset talk press can work. Allow it if you want headset voice;
   microphone access is optional for viewing and manual controls. If Quest asks a
   mixed-reality permission question, answer it: the passthrough request waits
   until you do.

**Enter VR** prefers passthrough, which is grayscale on a Quest 2, and falls
back to opaque VR if passthrough is unavailable or refused. **Enter plain VR**,
under **More options**, requests the opaque room directly.

### Open without the certificate warning

Ask the agent for a trusted HTTPS connection when browser setup should avoid
this warning. `open_companion` with `connection: "https"` uses the existing
Cloudflare relay, so the browser trusts the address. This route sends the scene
coordinates through that service; choose it when that sharing route suits your
work. The private LAN route above keeps coordinates on your network and uses
the Mac’s development certificate. Once paired, reuse the same headset page
and session for subsequent structures and scene edits.

### Pair by hand

Use this route when Web Launch is unavailable or its notification never
arrives.

1. Ask the agent for the address and pairing code. `open_companion` with
   `connection: "lan"` returns both, with the certificate fingerprint and the
   expiry.
2. In Quest Browser, open the address exactly as given and accept the
   certificate warning.
3. Bookmark the address now, without `/viewer` or a `#` fragment. The paired
   viewer address expires; the base address stays the same while this Mac's
   IP address and port stay the same.
4. Enter the eight-digit code and select **Pair**. The code works once and
   expires after ten minutes.
5. Tap **Enter VR**.

## What you see

The molecule is ahead of you. A compact menu sits 47° to your left.
Turn toward it to read the full panel. It keeps its
place in the room while you turn, scale or drag the molecule. When a lesson
needs that space, Stereofold tries another readable menu position while keeping
the molecule where you placed it. Aim at the menu glass and hold either grip
to move the panel. Push/pull moves it farther/closer, changing its apparent
size. Trigger dragging still works on any menu row or glass. If the menu has dimmed, press its plate to wake it.
The menu stays visible during molecule grabs and starts at a 1.35 m reading distance. **B** or **Y** brings it back
beside your current gaze if you have moved away or parked it out of view.

A caption card below your gaze shows short feedback and the agent's replies.
The caption plate describes the rendered scene: title, ID, assembly, the
chains shown, representation, color scheme, selection count and any named
focus. Hiding chain A of 4HHB, for example, changes it to
**3 of 4 chains shown · A hidden**. After a placement renders, one line says
where the structure now is, such as **Above you · look up** or **In front of
you, within reach**.

## The controllers

| Control | What it does |
| --- | --- |
| Hold **A** or **X** | Talk when headset voice is configured and enabled. The microphone opens after the button has been down for 150 ms and closes when you let go. A quick tap only buzzes. |
| Tap **B** or **Y** | Bring the menu beside you and switch between compact and full controls. |
| Hold **B** or **Y**, or click either stick | Put the structure back where it was when you entered, big and slightly above you. The caption reads "Hold to reset…" while the button is down. Let go of the grips and centre the sticks first. |
| Either stick | Slide the structure left and right, and up and down. Up is the room's up, so the structure still rises when you look down at it. |
| Point at the molecule, hold the trigger, and aim | Carry the molecule with your ray. With tracked hand position, a small hand movement gives you a larger reach. |
| Trigger, then that stick | Up/down pushes the molecule farther or pulls it closer; left/right turns it about its own vertical axis. Works over the molecule or empty space. |
| Aim at menu glass, then hold either grip | Move the menu; push/pull changes its distance and apparent size. |
| Grip away from the menu | Turn the structure with your wrist. With tracked hand position, it also follows your hand for precise movement. |
| Grip, then that stick up/down | Make the structure larger or smaller, including beyond 4×. Nudge for fine changes; push farther for faster scaling. |
| Both tracked grips | Pull apart or together to scale. Let go in either order. |
| Quick trigger tap | Pick a residue or press a menu control. |

Either controller works on its own, including one reporting orientation alone.
Emulated hand positions do not translate or scale by hand spacing; use the
stick controls for movement and size. The sticks move the structure; head
tracking sets your viewpoint. A press keeps the target it started on, so
carrying the molecule across the menu does not activate a control. During a
menu press, that controller's stick stays idle. While both tracked grips hold
the molecule, hand spacing controls size and both sticks stay idle.

Release the grip or trigger to stop its stick-controlled size or depth/turn
movement, then centre the stick before starting another push. If you add a
grip or trigger while a stick is already pushed, its current movement stays
the same until you centre it. Release the grips and centre both sticks before
using **Fit** or **Reset**.

## The menu

The collapsed menu is one column: **Talk**, **Tour**, **Reset**, the room
row, the current molecular style, **Mol\*** and **Menu**.
Tour navigation can use the remaining space, so the style row and **Mol\***
move under **Menu** when the compact column is full.

An authored lesson starts with **Figure**, which names its mixture of styles.
Choosing a molecular style updates its visible parts while keeping its colors
and annotations. Historical geometry estimates can warn that a requested style
may run slowly; they do not remove the style or lower its requested detail.
Available styles depend on the loaded source. A completed render does not
guarantee a comfortable frame rate on the headset.

- **Talk** shows the microphone's state; [Talk to the agent](#talk-to-the-agent)
  covers it.
- **Tour** starts the tour for the loaded structure. See [Tours](#tours).
- **Reset** brings back a structure you pushed out of reach.
- The room row switches passthrough on and off and names the current state.
- The style row shows **Atoms**, **Ribbons**, **Spacefill** or **Surface**.
  Tap it to cycle through those styles in that order, wrapping back to
  **Atoms**. It skips styles unavailable for the loaded source and keeps the
  molecule's position, rotation and scale. A density map shows a disabled
  **Density** row; coordinate styles apply to molecular structures.
- **Mol\*** opens the full Mol* viewer. See
  [Jump to the full Mol* viewer](#jump-to-the-full-mol-viewer-and-back).
- **Menu** opens the full grid. The style row, **Undo** and **Redo** sit near
  the top, just below **Close**. The grid also has movement on all three axes,
  scale, Fit, **Above us** and **In reach** placements, spin, chain and element
  colors, opacity, render quality, **Sequence** and **Tours**. **Close**
  collapses it again.
- **Re-seat**, in the full grid, recalls the panel beside your current gaze.

**Undo** restores the previous scene edit; **Redo** reapplies it. In a shared
session, this includes edits from the agent, desktop and headset. The current
source attachment keeps up to 32 steps. Loading another source starts a new
history. **Undo** and **Redo** are grey when unavailable and accept no click.

To move the menu, point anywhere on its visible panel, hold the trigger, and
move your hand. Release to leave it there. Either controller works. You can
start on a button or the caption; dragging does not activate the button. A
quick click still presses it. With position tracking off, turn your wrist to
move the panel with your pointer.

You can leave the menu outside your forward view and turn to use it. Tap **B**
or **Y** to bring it back. If a large scene fills the available space,
Stereofold parks the menu farther aside or hides it until you summon it.

Each control lights up and buzzes when your controller ray is on it, and sinks
while the trigger is down. Dim state rows report status. You can drag from
them, but clicking them runs no action.

## Ask for changes

Use your host's live voice chat while you wear the headset, or type and dictate
in the same conversation. For example:

- "Color the molecule orange."
- "Show chain A as a surface and hide the water."
- "Select chain A residues 10 through 15 and label them."
- "Show PDB 1EMA in this same headset session."

The agent changes the saved scene with `update_inspection`, or swaps the
structure with `replace_inspection_source`, and the headset redraws without
pairing again. The caption shows the change's progress:

| Caption | Meaning |
| --- | --- |
| **Waiting · …** | The change is on its way to the headset. |
| **Applied · … · r12** | The headset drew it and the Mac saved it at that revision. |
| **Could not apply · …** | The change failed. The agent reads the reason and tells you. |

The agent reports a change as visible only after its receipt says `rendered`.
When `get_inspection_state` reports `wearer.linked: false`, no headset page is
attached to the current structure; ask the agent to open it on the Quest again.

## Talk to the agent

### Live voice in your host

Start your host's live voice chat in the conversation that controls Stereofold.
You can ask for scene changes and hear replies without holding a controller
button. The microphone and speakers belong to the device running that voice
chat; Stereofold keeps the headset view connected to the agent on your computer.

In Codex, open the task and select **Start voice chat**. On an iPhone paired
through **Codex / Remote**, select your connected computer and open the same
task. Voice in existing tasks depends on the app version, account, and workspace
rollout.
See the [official voice guide](https://learn.chatgpt.com/docs/features/voice).
Dictation enters a text prompt; live voice also provides spoken replies and
lets you interrupt.

### Voice through the headset

To speak to the agent, hold **A** on the right controller or **X** on the left,
speak, and let go. While you hold the button, the headset shows
**Agent is listening.** when an agent is waiting on the Mac, or
**Listening…** when none is. After you let go it shows **Transcribing…**,
then the outcome. The Mac transcribes the recording itself with Apple's
on-device speech or whisper.

The agent hears you only while it waits in `listen_voice`. Ask it first, for
example: "Listen for me in the headset." Each wait costs a model turn, so tell
the agent when you are done and it stops listening.

The first time Apple's recognizer runs, macOS shows a Speech Recognition
dialog on the Mac for the application that started the server, such as your
terminal. Answer it before you put the headset on. Without that consent, and
with no whisper installed, the press is lost.

Pointing at the **Talk** row and pulling the trigger, or pinching it with hand
tracking, uses a separate route. It sends the recording to OpenAI's Realtime
service through an OAuth helper that this plugin does not ship, so it stays
off until you configure one. The helper also requires compatible `websockets`
in its selected Python interpreter; follow the
[voice setup check](../plugin/skills/stereofold-setup/references/voice.md).
Hold **A** or **X** instead when using the local recognizer.

The **Talk** row names the microphone's state in one word: `Mic on…` while
recording, `Hearing…` while the Mac transcribes, `Reply…` while a reply plays,
`No voice` after a failure, and `No link` when the link to the Mac is lost.

The page itself answers a set of fixed phrases with no agent involved,
including "next", "back", "pause", "bigger", "smaller", "put it above me",
"show my room", "grow it" and "open in Mol\*". Anything else goes to the
agent.

### Replies

After it acts, the agent answers with `say_to_headset`. The reply appears once
on the caption card below your gaze. The Mac renders the reply as audio and
sends the clip with the caption. A headset talk press prepares audio playback;
entering VR alone does not establish that a reply played.

The default reply provider, `oauth`, needs a narration helper that this plugin
does not ship; without it, replies show as captions and play no sound. Keep an
existing configured provider. On a Mac without an OAuth helper, choosing
`STEREOFOLD_REPLY_VOICE_PROVIDER=system` in the server's environment enables
replies with macOS `say`. Both providers need `ffmpeg`.

In the `say_to_headset` result, `delivered: true` means a headset page took
the caption, and `audible: true` means an audio clip went with it. Neither
reports that you heard it.

What the recognizer transcribed is a request, not a confirmed instruction.
Expect the agent to say back what it heard and what it did.

## Jump to the full Mol* viewer and back

The headset view offers four representations and five color themes. The full
Mol* viewer has everything else: measurements, components, image export.
[Cinematic to detailed and back](first-run-and-sharing.md#cinematic-to-detailed-and-back)
describes both routes, every caption and what crosses each way; this section
is the summary.

In the headset, press **Mol\*** on the compact menu, or open **Menu** to find
it when tour navigation fills the column. You can also say "open in Mol\*". The plate
shows, and the Mac speaks, **Opening the full viewer. Say return when done.** The
immersive session ends and the same Quest Browser tab loads the full viewer
with your structure and saved scene. Say "open it on the Mac" instead to open
the viewer on the Mac's monitor and stay in the headset.

To come back with your changes, press **Apply changes, then back to headset**
at the top of the full viewer, or hold **Hold to talk** and say "return". The
page sends appearance, selection and camera to the Mac and returns to the
headset page. For the next 120 seconds, one tap anywhere on that page re-enters
VR. With nothing to carry back, press **← Back to headset view**.

When the return press cannot finish, the page saves a `.molj` file under
`~/Downloads` and prints its path. Give that path to the agent, which imports
it with `import_detailed_view`.

## Demos and staged growth

The catalog in `plugin/demos/index.json` lists the current demos and their
sources, lessons and stages. Ask the agent to open one by name, or list and run
them from a repository checkout:

```sh
pnpm --dir plugin run demo --list
pnpm --dir plugin run demo microtubule-lattice
```

`microtubule-growth` grows a microtubule through seven tiers, from
one tubulin monomer to the complete tube. Say "grow it" or "add tubulin" for
the next tier, "shrink it" for the previous one, "build the wall" for the wall
tier and "cap it" for the tip. The coordinates and the lesson change while the
session, placement and scale stay. A Quest 2 refuses any tier above 43,066
atom sites and says "Too big for this headset. Staying here."; on a Quest 2
that is the full tube. No other headset has a measured limit.
`microtubule-arrival` separately reveals deposited tubulin copies in stages;
those visibility changes illustrate assembly without simulating its kinetics.

## Start from a terminal instead

From a repository checkout with its dependencies installed
(`pnpm install --frozen-lockfile`), one command runs the whole route through a
standalone desktop host:

```sh
pnpm --dir plugin run quest 1CRN
```

The command starts the host, opens the panel in a Mac browser tab (leave that
tab open; it renders the scene), waits for the scene to save, starts private
Wi-Fi sharing and opens Meta's Web Launch page. Click **Open** there, then
continue from step 4 of
[Put the structure on your Quest](#put-the-structure-on-your-quest). The
command records the headset microphone by default and prints which recognizer
it found, or what is missing. It stays in the foreground and prints a line when
the headset pairs; Ctrl-C closes the session and the listener.

| Option | Effect |
| --- | --- |
| `--browser "Google Chrome"` | Opens the links in that browser, for a Meta sign-in that lives outside your default browser. `STEREOFOLD_BROWSER` does the same. |
| `--no-web-launch` | Skips the Web Launch page. |
| `--no-ptt` | Leaves the headset microphone off. |
| `--open-on-quest` | Opens the address over an authorized adb cable instead. |
| `--share-hours <hours>` | Sets the share's hard stop, from 0.5 through 24. The default is 8. |
| `--lan-port <port>` | Serves on another port. The default is 8443. |

To answer the wearer from a second terminal, run
`pnpm --dir plugin run listen ~/.stereofold/quest-share.json`.

## Stop and forget

- Say "Stop sharing." The agent calls `manage_companion` with
  the current `sessionId` and `action: "close"`, then checks `lan: null` and
  `wearer.shareOpen: false` before confirming the listener closed and paired
  headsets disconnected. The desktop session stays open.
- `manage_companion` with `action: "status"` lists paired headsets and their
  device class.
- `manage_companion` with `action: "forget"` and a device's `deviceId`, or
  `"all"`, revokes saved headset keys.
- Ctrl-C in its terminal stops a host started with the `quest` command.

A share ends thirty minutes after the last request from a paired headset, or
eight hours after it opened, whichever comes first.

## When it goes wrong

**Nothing appears in the headset after Open.** Check that the Mac browser
that opened the Web Launch page is signed in to the headset's Meta account.
If it is the wrong browser, set `STEREOFOLD_BROWSER` to the right application
name, such as `Google Chrome`, in the environment your host starts in, and ask
the agent to launch again. Otherwise [pair by hand](#pair-by-hand).

**The headset shows Finding position in room.** Meta's boundary screen is in
front of Quest Browser. Choose **Continue without tracking** if offered for
dark-room use, or restore lighting for tracked movement. Return to the
existing viewer page or notification before requesting another launch.

**Controls do not respond after a system menu or tracking interruption.**
Release the buttons and centre both sticks, then start a fresh gesture.
This prevents the held controls from acting on the scene when input returns.

**The pairing page says the link could not be used.** The code expired or was
already used. Ask the agent to open the structure on the Quest again; each
call issues a new code.

**The page does not load.** Check that both devices are on the same Wi-Fi, and
that macOS allowed `node` to accept incoming connections. After the Mac
changes network or IP address, ask the agent to open the structure on the
Quest again. If the tool result says `openssl` was not found, sharing cannot
create its certificate: Stereofold looks for it only at `/usr/bin/openssl`,
`/opt/homebrew/bin/openssl`, `/usr/local/bin/openssl` and `/bin/openssl`.

**The certificate warning came back.** The certificate names the Mac's exact
IPv4 address, so a new address from the router brings a new warning. Accept it
again, or reserve a fixed address for the Mac on the router.

**The headset refuses the certificate outright.** This repository has no
tested route around the certificate. `adb reverse tcp:<port> tcp:<port>` puts
a Mac port on the headset's own loopback, but the LAN port serves HTTPS with
the same certificate, so reversing it does not give the headset a plain
`http://127.0.0.1` page.

**Enter VR does nothing.** After 15 seconds the page says what it is waiting
for, such as "Quest hasn’t accepted the passthrough request. Reload to try
again." Press **Reload to retry VR**, or open **More options** and tap
**Enter plain VR**. When Quest refuses passthrough outright, the page opens
plain VR by itself and says "Passthrough refused; opening plain VR…".

**A or X records nothing.** If you refused the microphone, Quest Browser does
not ask again: allow the microphone for this address in Quest Browser's site
settings, then reload the page. If the headset shows **Listening…** rather
than **Agent is listening.**, no agent is waiting; ask it to listen. If the
Talk row reads `No voice`, the Mac has no working recognizer; ask the agent
for `get_readiness`, which names what is missing.

**The room dims every ten seconds.** Quest Browser's unresponsive-app dialog
is up. Press **Close app** in the headset, then ask the agent to launch again.

**The headset says Link to the Mac lost.** The plate reads
**Link to the Mac lost. Your view is still here.** The listener behind this
page may be gone because the host restarted or the share ended. Ask the agent
to read `manage_companion` with `action: "status"`. If `lan` is null or
`wearer.shareOpen` is false, it must call `open_companion` for the same session
and chosen connection/launch route to reopen sharing, then follow the returned
address and launch instructions. Once sharing is open, press **Re-pair** on
the menu, which exits VR, or **Pair again** on the flat page, then **Enter VR**.
A valid remembered headset key needs no code; re-pair cannot reopen a closed
listener.

**Sharing stopped mid-session.** A share ends thirty minutes after the last
request from a paired headset, and at eight hours whatever the traffic. An
agent waiting in `listen_voice` is warned fifteen minutes before the share
closes. Ask the agent to open the structure on the
Quest again. For a longer session, start the host with `--share-hours <hours>`
or set `STEREOFOLD_SHARE_MAX_HOURS`, from 0.5 through 24.

**The Mac shows no error but the headset went quiet.** When a share ends, the
listener closes and the host process keeps running. Ask the agent for
`manage_companion` with `action: "status"`, or check the port, 8443 unless
you chose another:

```sh
lsof -nP -iTCP:8443 -sTCP:LISTEN
```

No output means the share is over.

**The reply was silent.** Check `audible` in the `say_to_headset` result.
`false` means the Mac rendered no clip: `ffmpeg` is missing, or the reply
provider has no helper (see [Replies](#replies)). `true` with no sound means
the page never got its first press; enter with the **Enter VR** tap.

**The Mac tab stopped updating.** In Claude Code and the Codex CLI the
desktop panel is an ordinary browser tab, and Meta's Web Launch page opens in
front of it. A browser pauses a tab that another tab or window hides, so the
Mac panel stops drawing until you bring its tab to the front, and then it
catches up. Edits still reach the headset, because the headset page draws
them itself. Before the headset page loads, nothing can draw an edit, and the
agent is told to wait for the headset or to ask you to bring the tab forward.
Leave the tab open: the Mac draws there whenever no headset page is loaded.

## Tours

The **Tour** control starts the journey for the loaded structure (4HHB starts
the hemoglobin journey). If none matches, it keeps the scene and says
“No journey for this structure yet,” naming its ID when available. **Tours**
opens the explicit chooser; **Next one** cycles it and **Tour** starts the
chosen journey, which may load another structure. A failed stage reports its
reason and restores the previous source and saved view; a newer correction
prevents stale recovery from overwriting it. Visibility is confirmed only after
the panel renders, saves and acknowledges the stage. At rest, the caption plate
shows the loaded structure's title, ID, visible chain and assembly summary,
hidden components, current appearance, selection count and named focus.

A journey matches on the PDB entry and assembly, plus the model when the
journey names one. A different assembly is explained, for example: “Journey
needs assembly 1; you have the asymmetric unit. Use Tours to explicitly load
its assembly.” Use the chooser to start a journey that needs another assembly
or model.

**Done**, including before the final chapter, restores the structure,
appearance, selection and placement saved before the journey. The plate reads
“Restoring your view…” until the restored scene renders and saves, then “Back
to your view.”

## Limits of this route

- Nothing is anchored to your real floor or walls. The menu keeps its place
  relative to the pose you entered on, not to a mapped room.
- Adding the page to your Quest library, on Horizon OS v74 or newer, gives a
  home-screen icon that opens the address. Meta does not document that icon as
  skipping the **Enter VR** tap, which WebXR requires.
