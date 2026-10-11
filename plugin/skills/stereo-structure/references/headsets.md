# Headset operation

Use the user's available browser and its observed capabilities. Meta and Apple
names choose launch conveniences for the same companion page. A generic browser
uses `open_companion` with `connection: "lan"`, `headset: "auto"`, and
`launch: "none"`, then opens the private address from the connection dialog.

## Pair and enter immersion

Private HTTPS sharing needs a reachable private IPv4 address and OpenSSL on the
host. The host and headset must reach each other on the network; client-isolated
Wi-Fi can prevent this. `loopback` reaches only the host. `connection: "https"`
uses a Cloudflare relay and sends coordinates through it; choose that route only
when the task authorizes public transport. Launch conveniences require `lan`.

Relay the returned instructions for the exact connection. Keep page keys,
complete credential-bearing links, and one-time pairing codes in the tool result
or local connection dialog rather than copying them into messages or artifacts.
Codes expire after ten minutes and work once. Remembered headsets can re-pair
without a code. Shares expire after thirty minutes without a headset request and
at their configured maximum duration, eight hours by default. Restarting a share
issues another code; changing the structure behind an address can revoke clients.

For Meta Quest, use `headset: "meta", launch: "auto"`. The host first checks
for one authorized Quest, reconnecting a previously verified private Wi-Fi
endpoint when available. It remembers a verified wireless address locally;
no network scan or developer-mode change is made. If none is reachable, Meta
Web Launch remains available without developer setup. A launched desktop
browser is only a dispatch acknowledgement: wait for the headset page receipt.
If Meta opens sign-in or account setup, the local connection dialog also offers
Manual pairing; do not report that the scene reached the headset.

For Meta Web Launch, the host browser must be signed in to the headset's Meta
account. `STEREOFOLD_BROWSER` can name another installed browser application.
Press **Open** once, allow incoming host connections if macOS asks, select the
headset notification, accept the development certificate for that exact address
through **Advanced** and **Proceed**, then tap **Enter VR**. Duplicate Web Launch
is refused for a minute because repeated sends have hung Quest Browser. Use the
already opened launch page when that refusal appears.

For Vision Pro, `headset: "apple"`, `launch: "auto"` prepares the Safari handoff.
Universal Clipboard is optional; the wearer can use the address and code from
the dialog. Safari's certificate steps are **Show Details** and **visit this
website**. Tap **Enter VR**, then **Allow** for the immersive experience.
The visionOS 27 simulator exercised an opaque `immersive-vr` session with
look-and-pinch controls. Treat physical Vision Pro behavior as a separate check.
Probe the current browser for modes, passthrough, input, and rendered receipts.

Vision Pro input uses transient sources: a source appears for each pinch and
disappears after release. Use `targetRaySpace` to target buttons or residues;
use `gripSpace`, when supplied, for physical pinch translation, rotation and
two-pinch spacing. Do not require a gamepad, handedness or full hand tracking.

Keep ownership keyed by source identity. A new pinch needs a new motion
baseline, even if release and re-pinch fall between animation frames. Missing
or emulated positions must not create translation or spacing changes. Resume
measured movement from a fresh baseline after a tracking gap.

Input-event frames allow `getPose`; reserve `getViewerPose` for animation
frames. Shared manipulation consumes poses in render coordinates; menu and
picking use room rays. Synthetic WebXR checks cover this contract. Physical
Vision Pro tracking quality and comfort remain unverified.

The primary **Enter VR** control requests passthrough (`immersive-ar`) when
available and falls back to opaque `immersive-vr`. **Enter plain VR** under
**More options** requests the opaque mode. The room menu reports `Room`,
`Room on`, or `Room off`; disabled `No room` means unavailable in this browser
session, and `Room?` means unknown. Room switching is a wearer menu/voice action,
rather than a model-side inspection command.

Microphone permission is optional for scene entry and manual controls. The
entry gesture may request it ahead of headset voice; grant it for that route.
For a dark-room session, use **Continue without tracking** if the headset
offers it, then verify the actual input sources and stick controls below.
Orientation-only input does not establish tracked hand translation or room
tracking. Restore tracking only when the requested interaction needs it.

## Spatial menu

Either controller supports the same stick controls, including a controller
reporting orientation alone. The bare stick slides the molecule sideways and
up or down. Trigger plus stick up/down pushes it farther or pulls it closer;
trigger plus stick left/right turns it, over the molecule or empty space.
Grip plus stick up/down resizes it, including beyond 4×. A quick trigger tap
selects; a trigger hold and aim carries the molecule along the controller ray.
With tracked hand position, inward hand movement pulls distant targets closer
and shortens the ray. Grip uses wrist rotation and tracked translation; two
tracked grips scale by hand spacing. Emulated positions do not translate or
scale by hand spacing. A press retains its initial menu or molecule target
until release. Preserve the wearer's saved placement when applying appearance
or lesson edits. Head tracking owns the viewpoint.

The compact menu rows are `Talk`, `Tour`, `Reset`,
`Room`/`Room on`/`Room off`/`No room`/`Room?`,
`Atoms`/`Ribbons`/`Spacefill`/`Surface`/`Density`,
`Mol*` and `Menu`. The style row and `Mol*` move under **Menu**
when tour navigation fills the compact column.
Compact controls start 47° left at 1.35 m: a glance left clears the molecular
view. Aim at menu glass and hold either grip to move it. Measured grip
push/pull changes distance and apparent size; it does not resize the glyphs.
Trigger dragging still works. B/Y recalls the panel; **Re-seat** remains in
the full grid. Grabbing the molecule keeps the menu visible.
An authored lesson shows `Figure` until a global style is chosen. That choice
updates visible parts while preserving colors and annotations. Ordinary
geometry estimates are advisory: a costly style may warn that it runs slowly
while retaining the requested detail, including Atoms. This differs from the
separate measured Quest 2 refusal for oversized staged-growth tiers.
Use **Reset** to return the molecule to its entry size in front of you.
**Menu** opens the full grid, with the style row, **Undo** and **Redo** just
below **Close**. Tap the style row to cycle **Atoms** → **Ribbons** →
**Spacefill** → **Surface** → **Atoms**, skipping coordinate styles unavailable
for the source. The cycle preserves molecular position, rotation and scale.
Density sources show a disabled **Density** row; their rendering is separate
from coordinate styles.

Shared **Undo** and **Redo** cover scene edits from the agent, desktop and
headset. The current source attachment retains up to 32 steps; replacing its
source starts a new history. Grey history rows cannot be clicked when no step
is available or the scene cannot accept another edit.

Tap **Move menu** to seat it beside the current
gaze. Trigger-drag anywhere on the visible panel, including buttons, disabled
rows and caption glass; release commits the menu seat without activating a row
or moving the molecule. A stationary click retains the button action. Either
controller works; only one held menu press owns the panel at a time. With
emulated position, wrist aim supplies movement; inferred hand travel is ignored.
On Vision Pro, look at the panel, pinch and hold, then move the hand to drag it.
A brief pinch presses the targeted row. Pinch and move the molecule to carry
it; two held pinches resize it by measured hand spacing. A brief empty-space
pinch summons the menu when the molecule and visible controls were not hit.
Manual parking may leave the forward field of view. **B** or **Y** summons it.
The default menu sits 1.35 m away with text sized for that distance. Dragging
keeps its nearest glass at least 0.85 m from either eye, including on release.
It stays in the room, so walking toward it can reduce that distance; summon it
again to restore the reading position.
The compact layout is the default. On a lesson placement conflict, the renderer
checks alternate seats using the full menu and caption in both eyes, including
side seats viewed by turning toward them. If none clears the scene, it hides
the controls until summoned. It preserves the requested molecular pose.
Confirm the rendered acknowledgement;
do not ask the wearer to rearrange the controls as the first recovery step.
**Mol*** opens the full viewer in the headset and ends immersion. Read the
handoff reference for applying changes and returning to the headset scene.

**Tour** starts the journey for the loaded structure; PDB 4HHB starts the
hemoglobin journey. If none matches, the scene stays open and the page names
the missing journey. **Tours** opens the explicit chooser, and **Next one**
cycles its entries. Starting a chosen journey can load another structure.
A failed stage reports its reason and restores the previous source and saved
view unless a newer correction supersedes that recovery.

At rest, the caption plate shows the loaded structure's title, ID, chains,
assembly, appearance, and selection count. During a journey, the plate shows
its current chapter. Confirm the panel's rendered, saved acknowledgement before
reporting a stage visible.

## Read wearer state

For Web Launch or a Safari handoff, read `get_inspection_state` every 5–10 seconds
until pairing or `pairingExpiresAt`, allowing time for human prompts. Do not resend
or start a competing Manual pairing while that handoff is pending; recover after
a reported failure or expiry. After pairing, or an adb dispatch, allow up to 60
seconds for page progress, then read `manage_companion` with `action: "status"`
and follow its recovery steps. Stop when `wearer.state` is `in-vr`; do not poll
indefinitely or repeatedly resend a launch.
An open share alone does not mean a launch was dispatched. If the last launch
failed or none was sent, resolve its reported cause and use `manage_companion`
with `action: "launch"`, or use Manual pairing. After `pairingExpiresAt`, obtain
a fresh code through `manage_companion` with `action: "launch"`.
`checkedInAt` is the page's last check-in in epoch milliseconds. These states
report the page, not a physical wearing sensor:

| State | Meaning and action |
| --- | --- |
| `no-page` | No headset page has checked in; use the returned launch or pairing instructions. |
| `page-open` | Flat page is waiting for **Enter VR**. |
| `entering-vr` | Immersion started but no visible frame is confirmed; wait for startup or a headset dialog. |
| `in-vr` | The page reports immersion with advancing frames. |
| `paused` | Page is asleep, off-head, or lacks a recent check-in; read `pausedBecause` and wait for resumption. |
| `unknown` | No check-in for a minute, or three after a busy report; if it persists with the headset awake, reconnect the page. |

`pageOutdated: true` means the headset page has an older viewer build. Reload it
or close and launch it again before relying on updated controls.
Record the build loaded by the page when validating a change; rebuilding the
checkout does not update a page that is already open.

While paused or unknown, appearance, selection, visibility, and emphasis edits,
compounds containing only those kinds, and corresponding undo or redo operations can
return `saved`. The host retains the change for resumption. Focus, placement,
tour, spin, and detail changes require a live page and are refused until it
resumes. Describe the result as saved for later display.

## Diagnose or recover

`manage_companion` accepts `status`, `revoke`, `close`, `forget`, `launch`,
`recover-browser`, `recover-pairing`, and `enter-vr`. Inspect its live schema
for required client/device fields. `status` lists current clients, remembered
headsets, and device classes. For an explicit "Stop sharing" request, use
`close` and confirm `lan: null` and `wearer.shareOpen: false` in its returned
state before reporting sharing ended. `revoke` removes a client;
`forget` removes a remembered device. Preserve the current session when repairing
its connection.

When `open_companion` returns `headsetPage.reused: true`, the same share's paired
page was retained and no notification or browser intent was sent. Its `state`
records the current connection: a paused page still needs to resume, and only
`in-vr` confirms advancing immersive frames. A missing, expired, unpaired or
outdated page follows the normal launch route. `manage_companion` with
`action: "launch"` explicitly sends a launch when one is needed.

Quest browser recovery and automated **Enter VR** need an authorized adb device.
First use of a new address can stop at a VR consent prompt that the wearer must
answer. An already authorized Wi-Fi adb connection supports these same routes;
a cable is not needed for that connection or manual browser entry.
If Quest Browser repeatedly dims with an unresponsive-app dialog, have the wearer
press **Close app**, or use `recover-browser` when adb is available. A boundary
or positioning dialog also requires the wearer to clear it.

A `busy` receipt can reflect a system dialog or another render. Resolve the
reported condition before retrying. A link-lost message offers **Re-pair** in XR
or **Pair again** on the flat page. Read `manage_companion` with `action: "status"`
first. If `lan` is null or `wearer.shareOpen` is false, call `open_companion`
with the same session and chosen connection/launch route to reopen sharing;
follow its returned address and launch instructions. Re-pair cannot reopen a
closed listener. Once sharing is open, use the page's recovery control and
then **Enter VR**; a remembered key can re-pair without a code while valid.
Read the actual address instead of assuming a fixed port. Keep the host and
renderer tab open; host-owned browser renderers
close when their host ends. Companion pages remain on the headset.

## Optional wireless debugging

Reuse an already authorized, connected adb transport before configuring another.
To resume a known wireless connection, use its locally recorded endpoint with
`adb connect <headset-ip>:<port>`, then check `adb devices` for state `device`.
The [Android adb guide](https://developer.android.com/tools/adb#wireless) describes
wireless setup and recovery. Check the actual headset's available setup route;
Android phone pairing menus do not establish that a Quest exposes the same menu.

If the saved address still answers a ping or a TCP connection to its debugging
port, keep that address; do not ask the user for a new IP based only on an adb
failure. Read `launch.debugging.detail` and its recovery hint. A failed debug
transport does not establish that the headset is off or its browser unreachable.
Use Meta Web Launch or manual pairing when debugging cannot be recovered.

- `No route to host` while a separate network check reaches the same endpoint
  can indicate a host adb server or local-network permission problem. Check
  the host's local-network access and coordinate with other device sessions
  before restarting adb: `adb kill-server` drops every adb connection.
- A listed `offline` transport or a connection timeout can occur when an unworn
  headset sleeps, but can also reflect a transport failure. Check another
  authorized route if present and wake the headset through it; otherwise have
  the wearer wake it, then retry the same verified endpoint. Avoid repeated
  reconnect loops or changing a reachable address.

Re-list devices after recovery and verify the intended Quest's identity. A
successful TCP connection alone is not an authenticated debugging session.

If enabling wireless adb reports a closed transport, read the helper's wireless
status and `adb devices` before retrying the enable operation. The transport may
have restarted after the setting changed. When status reports enabled, connect
the already known private endpoint and verify it rather than enabling it again.
Keep that endpoint in the user's local configuration and avoid scanning the LAN.

USB and Wi-Fi can list as two adb transports for one headset. Pin the intended
transport explicitly: `STEREOFOLD_QUEST_SERIAL` (or local `questSerial`) selects
launches; `STEREOFOLD_ADB_SERIAL` (or `ANDROID_SERIAL`) selects captures and the
operator/debugger scripts. For wireless operation, use the same verified
`<headset-ip>:<port>` for both. A name that is no longer listed as ready must be
reconnected or corrected; do not silently choose a different device. The launch
route requires one ready transport when no explicit target is configured.
Each route also accepts the other route's environment selector as a fallback;
its existing selector takes precedence. Local `questSerial` keeps its launch
precedence over the diagnostic fallbacks.

## Capture what rendered

`capture_headset_view` defaults to trying a live page capture, then a Quest adb
device capture. Use `source: "page"` for one downscaled left eye of the immersive
molecular frame; the room, spatial menu, and system UI are absent. Use
`source: "device"` for the headset's composed display, including both eyes,
passthrough, menu, and system UI. Device capture needs developer mode, an
authorized USB or Wi-Fi adb connection, and adb; inspect the reported
prerequisite failures.

Pass the current `sessionId` with page or auto capture to bind the page request
to that inspection and its current source. Check the returned `sessionId`,
`panelId`, and `sourceToken` before attributing the image. Without a session,
the first companion page may answer. A device capture, including auto fallback,
reports `sessionBound: false`: it shows the physical display and does not prove
that a particular inspection rendered.

The result names its source, path, and MIME type. Respect its returned `.jpg`
or `.png` path. Optional `savePath` is absolute; page `maxWidth` ranges from
160 to 640, device width can reach 2048, and `waitMs` ranges from 500 to 10000.
A capture that fails the flat-color check does not establish a visible scene.
Use capture to diagnose a specific problem, rather than polling images.
`read_headset_browser` reads adb browser diagnostics; `read_headset_log` reads
page heartbeat logs. Missing diagnostic access leaves manual controls available.

## Deliver captures and transcripts through local files

When a host needs file access instead of a returned image or a local network
connection, set `STEREOFOLD_BRIDGE_DIR` to an absolute local directory in the
producing host's environment. Give that host write access and the consuming
agent read access using its host's permission controls. This optional route
works alongside ordinary MCP results and `listen_voice`.

`capture_headset_view` writes the latest still as `headset-view.jpg` or
`headset-view.png`, with its timestamp, source, dimensions, and SHA-256 in
`headset-view.json`. Read the capture's structured `bridge` result for the
directory, file, media type, source, and digest. A `bridge.error` means that
copy failed; the original capture can still succeed. Repair the directory
access or consume the original image through another available host route.

The local push-to-talk transcriber also writes the latest utterance to
`voice.json`, including `utteranceId`, text, timing, and recognizer name.
Use the utterance ID to avoid acting twice. These files replace the previous
capture or utterance; use the cursor-based `listen_voice` queue when every
request must be consumed. Keep this directory within the user's intended local
sharing scope; it contains their transcripts and headset images.
