# Quest operator runbook (maintainers)

This page is for a maintainer who drives a headset session from a terminal in
a repository checkout: start the host, pair the headset, send scripted steps,
collect evidence, and stop cleanly. To put the headset on and use it by hand,
read [the headset walkthrough](headset-walkthrough.md) instead.

Every command here runs from the repository root unless it says otherwise. The
headset serial, the LAN address, the pairing code and the certificate
fingerprint are printed by the tools; read them from your own terminal. This
page never repeats one.

## Before the first session

1. Install Node 22.13 or newer, pnpm 11.19.0, `openssl`, `ffmpeg`, and Android
   platform-tools. Then run `pnpm install --frozen-lockfile` from the
   repository root; every `pnpm --dir plugin run` command below needs those
   workspace dependencies.
2. Reuse an authorized USB or Wi-Fi adb connection and run `adb devices`.
   The intended transport must be listed as `device`, not `unauthorized`.
   First wireless setup may require USB authorization and the trust prompt
   inside the headset. See [wireless debugging](../plugin/skills/stereo-structure/references/headsets.md#optional-wireless-debugging)
   for known-endpoint reconnects and target selection when USB and Wi-Fi both appear.
3. Put the Mac and the headset on the same private Wi-Fi network.
4. Open the address once in Quest Browser and accept the certificate warning.
   The certificate names this Mac's IPv4 address, so a new address brings the
   warning back.
5. Optional: to use Apple's on-device recognizer, build its helper with
   `pnpm --dir plugin run build:applespeech`. The binary is not checked in.

Export these in the shell you launch from:

| Variable | What it does |
| --- | --- |
| `STEREOFOLD_ADB_BIN` | Absolute path to `adb`, for captures and browser recovery |
| `STEREOFOLD_ADB_SERIAL` | Which headset, when more than one is attached |
| `STEREOFOLD_QUEST_SERIAL` | Explicit launch target; use the same transport as `STEREOFOLD_ADB_SERIAL` |
| `STEREOFOLD_PTT_TRANSCRIBE` | `1` records and transcribes the wearer; `0` turns it off |
| `STEREOFOLD_WHISPER_BIN`, `STEREOFOLD_WHISPER_MODEL` | whisper-cpp and its model |
| `STEREOFOLD_FFMPEG_BIN` | The ffmpeg that decodes each press |
| `STEREOFOLD_BROWSER` | Which browser opens the panel and the Meta Web Launch page |

## Check the machine

```sh
pnpm --dir plugin run doctor
```

The build line leads with the source hash that `scripts/build.ts` recorded
beside the bundles it emitted, and reports `fresh (<hash>)`, `stale (<hash>)`,
or `unknown (no stamp)`. A modification-time note follows it. A fresh checkout
usually reads fresh while the modification times disagree, because checking out
rewrites every source timestamp and none of the `plugin/dist` ones.
`unknown (no stamp)` means the dist predates the stamp, and the
modification-time note is then the only reading.

Once a host is running, ask it what it can do:

```sh
pnpm --dir plugin run doctor --share ~/.stereofold/quest-share.json --speech-check
```

`--speech-check` renders one short clip, which costs a network round trip on
the OAuth reply route.

## Start the host

First check for the session already serving the wearer. In an agent host,
call `continue_session`, keep its `sessionId`, and read `get_inspection_state`.
Use `open_companion` on that session: a current paired page is reused without
another launch, including a paused page that needs waking. Start the terminal
host below only when no suitable host is running or a separate session is
requested. Keep the existing host and renderer alive during reconnects.

```sh
pnpm --dir plugin run demo telomerase-haca
```

Add `--play-tour` to start the lesson's own tour as soon as the headset pairs.
Other flags: `--no-ptt` leaves the microphone closed, `--no-web-launch` skips
the Meta link, `--open-on-quest` opens the address over authorized USB or Wi-Fi adb, and
`--allow-stale-build` runs a dist the doctor refused.

The host writes `~/.stereofold/quest-share.json` once it has a saved scene.
That file holds the loopback origin, an admin bearer and the session id, and
every other command on this machine reads it. Leave the host running in its own
terminal.

## Pair the headset

The host opens Meta's Web Launch page on the Mac. Click **Open** there once,
then select the notification in the headset. The link carries the one-time
code in its fragment, so the page pairs itself; a headset that paired before
presents its saved key instead. The printed eight-digit code is for typing by
hand when Web Launch is unavailable. The driver's `open` step can also open the
companion over either authorized adb transport.

Entering the session needs a trusted click on **Enter VR**. The driver sends
one through the Chrome DevTools Protocol; a script-synthesized click does not
satisfy WebXR's gesture requirement.

## One viewer tab

An `am start -a VIEW` intent opens a new Quest Browser tab every time and never
focuses the tab already there, so repeated host restarts leave frozen `/viewer`
tabs behind. `manage_companion action="launch" launch="adb"` sweeps before it
launches. It forwards the debugger port over adb, asks every tab on this
share's origin what it is, and then acts on the answers:

| What the tabs answered | What the launch does |
| --- | --- |
| One tab draws the spatial menu or is presenting | Keeps it, closes the duplicates, sends no intent |
| A tab says its share has ended, menu drawn or not | Closes it, opens one fresh tab |
| No tab answers | Closes the frozen ones, opens one fresh tab |
| The debugger does not answer at all | Opens a tab and says older tabs may remain |

Read the tool text. The fourth row covers an unavailable debugger: nothing was
identified, so nothing was closed, and stale tabs may still sit behind the new
one. Close them in the headset if the wearer sees a stale page.

The second row covers a host restart. A share that ends on its timer leaves
the wearer's tab drawing the spatial menu over the "sharing from your Mac has
ended" plate. That tab cannot pair itself to the new share, so the launch
closes it and the fresh tab pairs the headset again.

The sweep touches only this share's own origin. A tab the wearer left open on
another site is never closed.

The driver applies the same rule when it picks a tab to drive. Quest Browser
freezes every tab that is not the visible one, and a frozen tab completes the
debugger handshake and then answers nothing, so silence is the reading. The
step log names the tab it chose and why, and lists every tab it rejected. When
nothing answers, the step fails with that list rather than driving a dead tab.

### Clearing the tab strip

The page list is not the tab strip. Quest Browser discards the renderer of
every tab that is not in front and keeps the strip entry, so a discarded tab
has no page to list, attach to or probe, and one tap on it opens a second
viewer.

The sweep asks the browser endpoint for the strip itself and closes the entries
the page list does not account for. The tool text reports one of four outcomes:

| What the tool text says | What it means |
| --- | --- |
| Closed *n* discarded Stereofold tabs | The strip is clean behind the live tab |
| held no discarded Stereofold tabs | Nothing was stranded |
| *n* would not close | Those are still in the strip; clear them by hand |
| does not let the debugger enumerate its tab strip | This build would not say; assume stale tabs |

To clear them by hand in the headset, open the Quest Browser menu, choose
**Tabs**, then **Close all tabs**, and reopen the viewer from the Mac with
`manage_companion action="launch"`. Do this before an acceptance run, because a
stale tab the wearer taps becomes a second viewer that competes for the
session.

The address bar on the wearer's page follows the page: the detailed page
rewrites it on every load, so the bar in a capture shows whether the wearer is
on `/viewer` or `/detailed`.

## Drive a session

```sh
pnpm --dir plugin exec tsx scripts/headset-drive.ts ~/.stereofold/quest-share.json \
  --out /absolute/evidence/dir --steps open,enter,tour,exit --atom-sites 15357
```

Steps are `open`, `enter`, `return`, `tour`, `grow`, `spin`, `stop`, `quality`,
`voice`, `ask`, `molstar`, `exit`, and two ways to drive a spatial-menu row:
`menu:<id>` and `aim:<id>`. Menu ids include `talk`, `tour`, `reset`, `room`,
`molstar`, `menu`, `move`, `sequence`, `fit`, `quality`, and the appearance
presets `appearance-cartoon`, `appearance-molecular-surface`,
`appearance-ball-and-stick`, `appearance-chain-id` and
`appearance-element-symbol`. For a row in the expanded grid, the driver opens
**Menu** first and the step log says so.

### Getting the headset out of Mol*

After `aim:molstar` or `menu:molstar` the wearer's tab is on `/detailed`, the
stock Mol* viewer, which has no **Enter VR** button. Two routes bring it home,
and both leave evidence.

With authorized USB or Wi-Fi adb, `--steps return` clicks the page's own **← Back to headset
view** link, waits for the tab to reach `/viewer`, waits for **Enter VR**, and
then enters. `--steps enter` takes the same detour on its own when it finds the
tab on `/detailed`; the step's `returnLeg` evidence names where it came from
and whether the one-tap re-entry hint was armed.

Without a debugger connection, call `recall_headset`. It leaves one sentence that the Mol*
page polls for; the page shows it, arms the re-entry hint and navigates home.
Read `detailedRecallReceipt` in `get_inspection_state` rather than guessing:

| `status` | What it means |
| --- | --- |
| `queued` | The sentence is waiting. Nothing has read it |
| `read` | The wearer's Mol* tab took it and left |
| `returned` | Their companion page is attached again, with re-entry armed |
| `expired` | Ten minutes passed and nothing read it |

Only `returned` means the wearer is back and reachable. A companion page that
attaches without reading the sentence leaves the receipt at `queued`: the
wearer came back some other way.

`open_detailed_view` answers with the address the headset can reach. With a
headset paired to the LAN share, `url` is that share's own `/detailed` origin
and `localUrl` is the Mac's loopback copy; `reachableBy` says which is which.
With no headset paired, both are the loopback address. The LAN address carries
no page key, because the wearer's tab already holds one and Quest Browser draws
the whole address inside the wearer's view.

### What the two menu steps prove

`menu:<id>` hands the row's action to the toolbar's action chain. It proves
that the action ran.

`aim:<id>` does not press. It builds a target ray from a simulated controller
pose, aimed at where that row is drawn, and pushes it through the toolbar's own
hit test, hover highlight and select handlers. It proves that a controller
pointed at the row reaches it, which `menu:<id>` cannot: a row can dispatch
correctly and still be unreachable.

`aim:miss` aims at a point on the same panel that the hit test must reject, and
fails if anything fires. Run it once per session. A build whose row rectangles
have drifted off the plates passes every row aim and fails this one.

Every row names the change its press has to produce: a new label, a new drawn
state, or a diagnostic the action writes. The step polls the page for up to 12
seconds until that change arrives. A row whose outcome never arrives FAILS and
prints what was expected beside what the page reported; no flag turns this
off. Pressing **Sequence**, for example, has to report the residue browser
open and its rows in place of the menu's. A row the table does not know is
reported as unverified, not passed.

The step log names the method and the verdict per step:

```
pass  aim:mode        [synthetic-ray verified]  Aimed a simulated controller pose at spatial-menu row Move (mode); ...
FAIL  menu:quality    [hook-press UNVERIFIED]   The spatial-menu row Detail 2 (quality) took the press, but the outcome never arrived: ...
```

and the run ends with the tally:

```
4 driven steps: 3 verified, 0 dispatched-only, 1 failed (hook-press, synthetic-ray).
synthetic input: no wearer. An aimed step simulates a controller pose through the real hit test; it does not test reach, comfort or legibility.
```

`report.json` carries the same tally under `drive`, and each step carries
`method`, `verified`, `expected`, `observed` and `captures`.

Neither step is a wearer. Both print `synthetic input: no wearer`, and so does
the end-of-run summary. A simulated pose cannot tell you:

- whether the row is within comfortable reach, or needs an arm stretched across
  the body;
- whether the label can be read at that distance, at that contrast, on this
  panel;
- whether tracking holds while you point at it;
- whether the row did what the wearer wanted.

The [wearer checklist](#wearer-checklist) covers those. Run the unattended walk
first, so that nobody spends headset time on a row that was never wired up.

### Other driver options

Flags: `--resume-session`, `--wait-for-host`, `--settle`, `--atom-sites`,
`--device`, `--url`, `--query`, `--out`.

`--device` takes a headset class, one of `quest2`, `quest3`, `quest-pro`,
`vision-pro`, `hand-only`, `unknown`. It sets the tier ceiling
`grow_structure` respects; only an identified Quest 2 has a measured ceiling.
Use the observed class from pairing. The serial goes in `STEREOFOLD_ADB_SERIAL`, not
here.

`--wait-for-host` waits up to 20 seconds for a host that is still starting, for
a host and driver launched together. `STEREOFOLD_WAIT_FOR_HOST=1` does the
same. Without either, a missing control file fails at once, because a host
that is not running is the more common cause.

Two steps put speech through the loop. `voice` calls the page hook with four
canned phrases and checks the fixed grammar. `ask` speaks three sentences with
macOS `say`, encodes them the way the headset's recorder does, and posts them
to the push-to-talk route, which exercises assembly, decode, local
transcription, the queue and the spoken reply. Both are tagged
`injected-transcript` in the evidence, because neither is a microphone in a
room.

To send one tool call:

```sh
pnpm --dir plugin run agent ~/.stereofold/quest-share.json get_inspection_state '{}' --wait
```

To read what a real wearer says, and answer as the agent:

```sh
pnpm --dir plugin run listen ~/.stereofold/quest-share.json
```

To follow the headset's own diagnostics:

```sh
pnpm --dir plugin run headset-log ~/.stereofold/quest-share.json --follow
```

## Conversational tool forms

These forms follow the `update_inspection`, `replace_inspection_source` and
`say_to_headset` descriptions in
[`plugin/src/inspection-server.ts`](../plugin/src/inspection-server.ts). The
examples are JSON argument fragments: fill the live binding separately. They
contain no reusable session or panel credentials.

For each scene edit, pass `sessionId`. `update_inspection` and
`replace_inspection_source` fill an omitted `serverEpoch`, `sourceToken`,
`baseStateRevision`, `baseInspectionRevision`, `panelId` and `commandId` from
the current session. To have an edit made against a stale view refused
instead, read `get_inspection_state` first: copy `serverEpoch`, `sourceToken`,
`stateRevision` as `baseStateRevision`, and `inspectionRevision` as
`baseInspectionRevision`, choose the current ready `panelId` for the surface
being inspected, and give the edit a `commandId` (1–80 letters, digits,
underscores or hyphens); exact retries keep the ID and arguments. For a voice
edit, echo the `utteranceId` from `listen_voice` and pass its `referent`
unchanged when present. Check `get_inspection_state` with `commandId` and
require `status:"rendered"` before confirming a visible change. A queued
receipt describes intent.

### Style only the selected residues

Send this `change` to `update_inspection`; it is the scoped appearance form in
the tool description:

```json
{
  "change": {
    "kind": "appearance",
    "scope": "selection",
    "patch": {
      "representation": "ball-and-stick",
      "color": "uniform",
      "uniformColor": "#ff8800",
      "opacity": 1
    }
  }
}
```

Each appearance field is optional. To remove styles on those keys:

```json
{"change":{"kind":"appearance","scope":"selection","patch":{"clear":true}}}
```

Styles are saved, undoable layers, reported in `view.styles` and retained in
named views, with up to eight layers and 20000 keys per layer. With a referent
and no explicit scope, representation, color, uniform color and opacity use
its captured keys. Set top-level `referentScope:"scene"` for a whole-scene
edit. Background, clipping and fog affect the scene.

### Compare a second structure

Add these fields to the live binding for `replace_inspection_source`:

```json
{"mode":"compare","pdbId":"2HHB","align":"side-by-side"}
```

The comparison is saved and undoable. Primary `sourceToken` and `sourceSha256`
are preserved. Selection, labels, emphasis and visibility apply only to the
primary. `align:"superpose"` falls back to side-by-side and reports no
unmeasured RMSD. Default `mode:"replace"` clears the comparison. The argument
fields are defined by `replaceInspectionSourceSchema` in
[`inspection-contract.ts`](../plugin/src/inspection-contract.ts).

Use `update_inspection` to edit the comparison's appearance or placement, or
remove it, with its `kind:"companion-structure"` patch form:

```json
{"change":{"kind":"companion-structure","patch":{"appearance":{"opacity":0.5}}}}
```

```json
{"change":{"kind":"companion-structure","patch":{"remove":true}}}
```

The two structures share a geometry budget, and comparison state supports undo
and named views. `update_inspection` accepts compounds of two to seven edits,
each field at most once; scene appearance and selection appearance are separate
fields.

### Show only what “that” referred to

Send this `change` to `update_inspection`, with the unchanged top-level
`referent` and `utteranceId` returned by `listen_voice`:

```json
{"change":{"kind":"visibility","patch":{"op":"only","selection":true}}}
```

The tool selects `referent.selectionKeys` and applies visibility in one
compound render and one undo entry, even if the live selection moved after
speech began. The referent is validated against source, model, assembly and
canonical keys. With no referent, this form uses the current selection. The
rendered receipt's `appliedTo` identifies the target.

### Speak a whole reply

Use `say_to_headset` once for a reply within 1200 characters and 200 words.
These fields supply a reply longer than one segment; also pass the request's
`utteranceId` when you have one:

```json
{
  "text": "A comparison keeps the primary structure and adds a second structure beside it. Selection, labels, emphasis and visibility still apply to the primary structure. You can change the comparison's appearance or placement, remove it, or restore it with undo. A queued change still needs a rendered receipt before I can confirm that it is visible.",
  "speak": true,
  "holdSeconds": 6
}
```

Long replies are split into ordered segments of at most 240 characters and
36 complete words, with a 15-second audio ceiling per segment. Accepted text
is not truncated. A reply over the whole-reply bound is refused; send the rest
in a second call. One call produces one reply and one receipt. The final
caption stays for `holdSeconds` (2–15, default 6).

Read `segmentCount`, `segments`, `totalSeconds`, `durations`, `audibleSegments`
and `truncated` in the receipt. `durations` distinguishes measured durations
from estimates. `delivered:true` means the companion took the reply;
`audible:true` means audio was prepared. Neither proves the wearer heard it;
check the headset's playback diagnostics. A stale utterance ID is refused, and
omitting the ID produces an unbound reply. An OAuth failure does not switch the
reply provider.

## Collect evidence

The driver writes `report.json` and one capture per step into `--out`.

Frame rate comes off the device log. `FPS` is measured against target and
`Stale` counts dropped frames:

```sh
adb -s "$STEREOFOLD_ADB_SERIAL" logcat -s VrApi:I > fps.log
```

Screenshots come from the host's own `capture_headset_view` tool or from
`adb exec-out screencap -p`. By default the tool first asks the immersive
companion page for an image, which needs no adb connection. When the page
cannot answer, it falls back to the device route, which captures the
composited headset display and needs an authorized adb connection.

### Investigate lag on the headset

Record whether the whole scene stutters during head turns, the molecule trails
the controller, or a particular action causes a pause. Test the same saved
structure, placement, representation, quality setting and XR mode before and
after a change. Record the build actually loaded by the headset; a rebuilt
checkout does not update an existing page.

Collect the companion diagnostics while the scene is active:

```sh
pnpm --dir plugin run headset-log ~/.stereofold/quest-share.json --follow > headset-timing.log
```

Keep the `session-start`, `render-budget`, `render-quality`, `frame-rate`,
`frame-cost`, `transition` and `render-operation-cost` records. `frame-rate`
measures the XR callback cadence. `frame-cost` measures CPU time spent inside
callbacks, including draw submission and overlays; its callback count is not
the headset's frame rate, and it does not measure GPU completion. Empty logs
or a page hidden by a system dialog cannot establish smooth rendering.

After loading settles, record at least 30 seconds for each relevant case:

1. Leave the molecule still and turn the head slowly.
2. Move and resize it with each controller, including repeated growth.
3. Open, move and close the menu.
4. Advance a lesson, then pause and resume it from the other connected host.

Run the user's reported tracking mode first. In a dark room, use **Continue
without tracking** when the headset offers it, and check trigger-stick depth
and grip-stick size. This mode cannot establish measured hand translation or
room tracking. Keep AR and plain VR results separate. If other modes are
available, repeat the same cases and report which ones were actually tested.

A small structure is useful as a comparison after the reported scene has been
measured. Record any reduced detail or resolution as a separate run so it does
not hide a regression. Keep capture and unrelated browser work off during the
baseline, then measure casting or recording separately if the user needs it.
Software XR checks establish behavior; they do not qualify Quest performance.

### Check lesson sharing without a headset

Build the runtime, then run the two-viewer check in an isolated browser:

```sh
pnpm --dir plugin run build
pnpm --dir plugin exec tsx scripts/lesson-sync-browser.ts /absolute/fresh-evidence/lesson-sync
```

It uses local coordinates and a separate scene service. It checks chapter and
pause state, commands from either viewer, a disconnected viewer catching up,
reload, and ending the lesson. Status-only changes must leave the rendered
appearance intact. The report records the tested runtime hashes.

To inspect the tubulin reveal's rendering workload, run:

```sh
pnpm --dir plugin exec tsx scripts/demo-browser.ts microtubule-arrival /absolute/fresh-evidence/tubulin build --render-object-probe
```

This adds a read-only probe to the HTML served by the test. It leaves the
distributed runtime unchanged and records each chapter's render objects,
visibility and placement. The counts describe desktop Chromium; measure
frame rate on the Quest separately.

For immersive chapter playback, use an available IWER runtime and a fresh
evidence directory:

```sh
pnpm --dir plugin exec tsx scripts/companion-browser.ts /absolute/fresh-evidence/tubulin-xr --xr-runtime /absolute/path/to/iwer.min.js --demo microtubule-arrival --stage build --tour chapters --mode vr --head-yaw 35 --head-offset 1.2,0.1,-0.8
```

This checks a viewer turned and standing away from the reference origin. The
report identifies whether a controller press or an agent command started the
lesson. It verifies chapter rendering, narration requests and Done restoring
the entry placement. The local test voice does not qualify the user's voice provider. `--tour full`
also runs the separate parked-RNA emphasis regression and requires a lesson
with that scene arrangement.

## Wearer checklist

Run this with the headset on, after the unattended walk passes. Each line is
pass or fail against the real headset, not the desktop preview.
Record the page's loaded build, device class, XR mode and tracking mode. Mark
optional voice or unsupported hardware checks as not tested, with the reason.

1. From the selected host, ask for the headset. For a new Web Launch, click
   **Open** once on the Mac and accept the certificate warning if shown.
   **Pass:** the page pairs without typing, or an existing current page is
   reused with no new launch. Keep its session and saved placement.
2. Tap **Enter VR** if the page is flat. **Pass:** the requested structure
   renders in the reported XR mode with advancing frames and no startup error.
   The primary button prefers passthrough and falls back to opaque VR.
   Microphone permission is optional; allow it for headset voice tests.
3. Leave the session, open **More options** and tap **Enter plain VR**.
   **Pass:** the headset enters `immersive-vr` and the room goes opaque.
4. With an agent waiting in `listen_voice`, hold **A** and speak, then let go;
   repeat with **X**. **Pass:** the headset shows **Agent is listening.**
   while the button is held, and the transcript reaches the agent.
5. Tap **A** quickly. **Pass:** nothing happens except a buzz.
6. Only with the OAuth transcription helper configured: put the controller
   down and pinch the **Talk** row with a bare hand. **Pass:** the listening
   state starts from the pinch alone.
7. With tracked controllers, hold each grip in turn. **Pass:** the structure
   follows that hand and turns with your wrist. Squeeze both and pull apart.
   **Pass:** it grows, and letting go in either order leaves it where you put it.
   Repeat with each controller alone: grip plus its stick up/down changes size
   smoothly, including beyond 4×.
8. Push either stick. **Pass:** the structure slides sideways, and straight
   up when you push forward, even while you look down at it. Hold the trigger
   off the menu and push the same stick. **Pass:** it moves away and turns.
9. Tap **B**, then tap **Y**. **Pass:** each controller summons the menu beside
   the current gaze and switches compact/full controls. Read the labels and
   caption at the default distance, then press rows with each controller.
   Trigger-drag from a button, caption and panel border with each controller;
   release, turn away and summon it again. Try a quick drag and an ordinary
   click separately. **Pass:** dragging moves only the menu, clicks activate
   buttons, and the panel stays readable and selectable. With tracking off,
   repeat using wrist aim. A second held menu press must activate nothing.
   Hold each of **B** and **Y** with nothing else held, then click each stick.
   **Pass:** each reset returns the structure to its entry placement and size.
10. Load a structure past 30,000 atom sites, such as `microtubule-lattice`.
    **Pass:** head turns, movement, resizing and menu use remain comfortable.
    Record the requested and accepted frame rates and measured cadence. Quest 2
    requests 72 Hz; that request alone does not establish performance.
11. Start a tour or a demo. **Pass:** captions advance, and autoplay pauses
    and resumes correctly.
12. Say "open it on the Mac", or press **Detailed view** above the desktop
    panel. **Pass:** the full viewer opens on the Mac and shows the same
    molecule, background and selection, with its camera fitted to the
    structure; **Apply changes, then back to headset** restores color and
    camera in the panel; a `.molj` saved there and imported back does the
    same.
13. After pairing, ask for `manage_companion` status. **Pass:** the paired
    headset is reported with its device class, `quest2` on a Quest 2.
14. On a Quest 2, ask to grow the `microtubule-growth` demo to its full tube.
    **Pass:** the current measured atom budget refuses the 177,268-site tube,
    preserves the current scene and reports its reason. If the wearer chooses
    the `wall` tier, describe it as a portion of the tube. Do not apply that
    Quest 2 ceiling to another or unidentified headset.
15. Recenter with a long press on the Oculus button, mid-session. **Pass:**
    the scene reappears correctly framed; the session does not end.
16. Exit VR with the headset's own system gesture, not the page. **Pass:**
    the desktop panel's draw loop resumes with no reload needed.
17. Ask for the headset again immediately after step 16. **Pass:**
    `open_companion` reuses the current paired page without a fresh Web Launch;
    **Enter VR** works on that page and retains the saved scene. Repeat after
    sleep/wake, resuming the paused page before claiming a visible change.
18. On Horizon OS v74 or newer, add the page to your library from the
    browser menu. **Pass:** a library icon appears, and opening it still
    reaches the scene; note whether **Enter VR** was still needed.
19. While holding a molecule, open the headset's system menu and return.
    Repeat with each controller. **Pass:** the molecule stays where it was,
    returning does not select a residue or trigger a menu or voice action,
    and releasing the controls allows a fresh grab and resize.
20. In a dark room, use **Continue without tracking** when offered. Repeat
    movement, trigger-stick depth/rotation, grip-stick size and menu selection
    with each controller alone. **Pass:** orientation-only controls remain
    usable. Report unavailable tracked translation and two-hand spacing
    separately from the stick controls.

## Stop

1. Press Ctrl-C in the host terminal.
2. Confirm no `quest-demo` process is left.
3. Confirm the teardown line in the headset log reads `nativeEnded:true` and
   `presenting:false`.
4. Confirm nobody is wearing the headset:
   `adb -s "$STEREOFOLD_ADB_SERIAL" shell dumpsys power | grep mProximityPositive`
   must report false.

To end a session somebody else started, `--steps exit` on its own is enough.
The driver resumes it without `--resume-session`, because a run whose only
step is `exit` cannot walk a tour through anyone's face. Any longer step list
still refuses a presenting session until you pass the flag, and a headset that
reads as worn is refused either way.

## Traps

- Run `tsx` through `pnpm --dir plugin exec tsx`, or call
  `plugin/node_modules/.bin/tsx` directly. `node plugin/node_modules/.bin/tsx`
  fails, because that path is a shell shim rather than a JavaScript entry
  point.
- Start the host before any driver or agent call, or pass `--wait-for-host`.
- A headset that has gone to sleep captures black frames. Wake it before you
  read a capture as a failure.
- A source load has no fixed 30-second limit. The host budgets
  `panelWaitMs(atomSites, PANEL_SAVE_WAIT)` for a panel to load, draw and save
  a structure: 130 s for the 4,779 atom sites of 4HHB, up to 300 s. It states
  that number back as `renderBudgetMs`, and `converse.ts` and the agent CLI
  follow it, printing "still rendering" every five seconds. A timeout before
  the stated budget is spent is a bug in the caller, not a headset fault.
- A `rendered` receipt is not the wearer's view. Read `wearer` in the same
  answer: `wearer.linked` is true only when the share has a paired client and a
  headset page is attached to the current source. When it is false the receipt
  describes this Mac's own headless panel, and `say_to_headset` reaches nobody.
- Loading a structure into a shared scene keeps the share. `control` with
  `load_pdb`, `open` with a source and `replace_inspection_source` all retarget
  the live share to the new source instead of retiring the listener. The first
  two carry a `share` field saying so, and `share.sourceToken` is the token to
  use afterwards; the one read before the call is spent. Prefer
  `replace_inspection_source` when you want a render receipt and a wait budget
  with the swap.
- `pnpm` refuses to run offline on some machines with a signature error. Call
  the installed binaries directly instead of disabling the guard:
  `./plugin/node_modules/.bin/vitest run --root plugin`.
